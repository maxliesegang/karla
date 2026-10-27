/**
 * Hash routing, so deep links survive static hosting (`#/experiment`, `#/stop/europaplatz/line/2`).
 *
 * A home page plus one selection chain: stop, optional line, journey. Each level refines the one
 * above and drops back to it on its own, so a departed journey or a stopped line narrows the
 * address instead of breaking it.
 */
import { getLineFamilyId } from "./lib/line-families";
import {
  formatLineSelection,
  isSelectedLine,
  parseLineSelection,
  type LineSelection,
} from "./lib/line-bundles";
import type { StopEvent } from "./data/transit-types";

export type RouteView = "home" | "experiment" | "stop" | "network" | "nearby" | "settings";

/**
 * The panel shown. A stop with a line selected shows the line diagram, which has no address of its
 * own.
 */
export type ActiveView = RouteView | "line";
export type ExperimentMap = "center" | "geo" | "region";
/** The experiment maps with an address of their own; the Zentrum plan has `zentrum`. */
export type OtherExperimentMap = Exclude<ExperimentMap, "center">;
/** The geographic map and the region plan are hidden for now: no switch, and their addresses open
    the Zentrum plan. */
export const ARE_OTHER_EXPERIMENT_MAPS_SHOWN = false;
export type JourneyParent = "stop" | "line";

export const DEFAULT_STOP_ID = "europaplatz";
const DEFAULT_LINE_ID = "2";

/**
 * The line segment: one line or a bundle (`line/2`, `line/S1+S11`). A bundle is a view of several
 * lines, never a line of its own.
 */
const parseLineSegment = (segment: string) => parseLineSelection(segment);

function getLinePathSegment(lineId: string, bundledLineIds: readonly string[] = []): string {
  const primary = getLineFamilyId(lineId);
  return formatLineSelection({
    lineId: primary,
    // A line does not appear twice in the address.
    bundledLineIds: bundledLineIds.filter((id) => getLineFamilyId(id) !== primary),
  });
}

/**
 * Flat rather than a per-view union, so the shell can resolve every field in every view.
 * `lineId` and `addressId` are what the address asks for; the shell drops what no longer resolves.
 */
export type AppRoute = {
  view: RouteView;
  stopId: string;
  /** The part of the stop place the board is read at (`/stop/hauptbahnhof/vorplatz`). */
  partId: string;
  /** Line selected at the stop; empty when the stop alone is in view. */
  lineId: string;
  /** Sibling lines the rider chose to read with it (`line/S1+S11`). */
  bundledLineIds: readonly string[];
  /**
   * The line the Zentrum plan follows (`#/experiment/center/line/2`). Separate from `lineId`, which
   * is a line at a stop resolved against its board.
   */
  zentrumLineId: string;
  /** The stop opened on the Zentrum plan (`…/center/stop/marktplatz`). Excludes `zentrumLineId`. */
  zentrumStopId: string;
  /** The experiment page's map: the Zentrum plan (`center`), the region plan or the geographic map. */
  experimentMap: ExperimentMap;
  /** The stop opened on the region plan or the geographic map (`…/geo/stop/durlach-bahnhof`). */
  mapStopId: string;
  /** The map at screen size (`…/center/full`), addressed so the back gesture closes it. */
  isMapFullscreen: boolean;
  /** Address of the selected dated journey: `journeyRef@operatingDayRef`, or a bare row id. */
  addressId?: string;
  /** The level a stop-scoped journey was opened from, retained for the step-up control. */
  journeyParent?: JourneyParent;
  /** A ride: the journey read on its own (`#/journey/:ref/:day`), with no stop or line beside it. */
  isRide: boolean;
  /** The rider's marked Ausstieg on a ride; dropped once the journey no longer calls there. */
  alightingStopId?: string;
  /**
   * The stop the ride was begun at (`/from/:stopId`), where step up leads back to. A ride from a
   * shared link names none, and step up leads home.
   */
  originStopId?: string;
};

const defaultRoute: AppRoute = {
  view: "home",
  stopId: DEFAULT_STOP_ID,
  partId: "",
  lineId: "",
  bundledLineIds: [],
  zentrumLineId: "",
  zentrumStopId: "",
  experimentMap: "center",
  mapStopId: "",
  isMapFullscreen: false,
  isRide: false,
};

const getRouteSegments = (hash: string): string[] =>
  hash.replace(/^#\/?/, "").split("/").filter(Boolean);

/** A malformed escape in a hand-edited hash gives a not-found view, not a crash. */
function decodePathSegment(segment: string | undefined): string {
  if (!segment) return "";
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Colons are valid in a path segment and keep namespaced ids (`kvv:21005:E:R:s26:302`) readable. */
const encodePathSegment = (segment: string): string =>
  encodeURIComponent(segment).replaceAll("%3A", ":");

const OPERATING_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** `journey/:journeyRef/:operatingDayRef`; a row without a dated journey has its id alone. */
function formatJourneyPath(addressId: string): string {
  const separator = addressId.lastIndexOf("@");
  const day = addressId.slice(separator + 1);
  return separator > 0 && OPERATING_DAY_PATTERN.test(day)
    ? `/journey/${encodePathSegment(addressId.slice(0, separator))}/${day}`
    : `/journey/${encodePathSegment(addressId)}`;
}

/** The address after `journey`, and how many segments it took. */
function parseJourneySegments(segments: readonly string[]): {
  addressId: string;
  length: number;
} {
  const journeyRef = decodePathSegment(segments[0]);
  const day = segments[1];
  return day && OPERATING_DAY_PATTERN.test(day)
    ? { addressId: `${journeyRef}@${day}`, length: 2 }
    : { addressId: journeyRef, length: 1 };
}

const STOP_QUALIFIERS = new Set(["line", "journey"]);

/** `/stop/:stopId`, an optional part, and its refinements. */
function parseStopRoute(segments: readonly string[]): AppRoute {
  const [rawStopId, ...afterStop] = segments;
  const stopId = rawStopId ?? DEFAULT_STOP_ID;
  const partId = afterStop[0] && !STOP_QUALIFIERS.has(afterStop[0]) ? afterStop[0] : "";
  const [qualifier, ...rest] = partId ? afterStop.slice(1) : afterStop;
  if (qualifier === "journey") {
    return {
      ...defaultRoute,
      view: "stop",
      stopId,
      partId,
      addressId: parseJourneySegments(rest).addressId,
      journeyParent: "stop",
    };
  }
  if (qualifier !== "line") return { ...defaultRoute, view: "stop", stopId, partId };

  const isJourney = rest[1] === "journey";
  return {
    ...defaultRoute,
    view: "stop",
    stopId,
    partId,
    ...parseLineSegment(rest[0] || DEFAULT_LINE_ID),
    addressId: isJourney ? parseJourneySegments(rest.slice(2)).addressId : undefined,
    journeyParent: isJourney ? "line" : undefined,
  };
}

/**
 * The optional `from`/`to` stops after a journey, read as named pairs since either may be absent.
 */
function parseJourneyQualifiers(segments: readonly string[]): { from?: string; to?: string } {
  const qualifiers: { from?: string; to?: string } = {};
  for (let index = 0; index + 1 < segments.length; index += 2) {
    const value = decodePathSegment(segments[index + 1]) || undefined;
    if (segments[index] === "from") qualifiers.from = value;
    if (segments[index] === "to") qualifiers.to = value;
  }
  return qualifiers;
}

/** A map's two sizes, after its name. */
function parseMapRoute(map: OtherExperimentMap, segments: readonly string[]): AppRoute {
  const isMapFullscreen = segments[0] === "full";
  const [kind, id] = isMapFullscreen ? segments.slice(1) : segments;
  return {
    ...defaultRoute,
    view: "experiment",
    experimentMap: map,
    isMapFullscreen,
    mapStopId: kind === "stop" ? decodePathSegment(id) : "",
  };
}

function parseZentrumRoute(segments: readonly string[]): AppRoute {
  const [qualifier, ...tail] = segments;
  const isMapFullscreen = qualifier === "full";
  const selectionSegments = isMapFullscreen ? tail : segments;
  return {
    ...defaultRoute,
    view: "experiment",
    isMapFullscreen,
    zentrumLineId: selectionSegments[0] === "line" ? decodePathSegment(selectionSegments[1]) : "",
    zentrumStopId: selectionSegments[0] === "stop" ? decodePathSegment(selectionSegments[1]) : "",
  };
}

export function parseRoute(hash: string): AppRoute {
  const [view, ...rest] = getRouteSegments(hash);

  switch (view) {
    case "line":
      // A line from the index has no stop yet; the shell resolves one and rewrites the address.
      return {
        ...defaultRoute,
        view: "stop",
        stopId: "",
        ...parseLineSegment(rest[0] || DEFAULT_LINE_ID),
      };
    case "journey": {
      // A ride: the journey alone, optionally with `/from/:stopId` and `/to/:stopId`.
      const { addressId, length } = parseJourneySegments(rest);
      const { from, to } = parseJourneyQualifiers(rest.slice(length));
      return {
        ...defaultRoute,
        view: "stop",
        stopId: "",
        addressId,
        isRide: true,
        originStopId: from,
        alightingStopId: to,
      };
    }
    case "network":
      return { ...defaultRoute, view: "network" };
    case "nearby":
      return { ...defaultRoute, view: "nearby" };
    case "settings":
      return { ...defaultRoute, view: "settings" };
    case "experiment":
      // Any other map name, or any map while the others are hidden, opens the Zentrum plan.
      return ARE_OTHER_EXPERIMENT_MAPS_SHOWN && (rest[0] === "geo" || rest[0] === "region")
        ? parseMapRoute(rest[0], rest.slice(1))
        : parseZentrumRoute(rest.slice(1));
    case "stop":
      return parseStopRoute(rest);
    default:
      return defaultRoute;
  }
}

/** What the Zentrum's plan is lit by: a followed line, or an opened stop. Never both. */
export type ZentrumSelection = { lineId?: string; stopId?: string };

/** The only place route paths are spelled out. The Zentrum plan is the experiment page's `center` map. */
export const routePaths = {
  home: () => "/",
  experiment: () => "/experiment",
  /** The Zentrum plan with its followed line or opened stop, at either size. */
  zentrum: (selection: ZentrumSelection = {}, isFullscreen = false) =>
    `/experiment/center${isFullscreen ? "/full" : ""}${
      selection.stopId
        ? `/stop/${encodePathSegment(selection.stopId)}`
        : selection.lineId
          ? `/line/${encodePathSegment(selection.lineId)}`
          : ""
    }`,
  /** The region plan or geographic map with its opened stop, at either size. */
  map: (map: OtherExperimentMap, stopId?: string, isFullscreen = false) =>
    `/experiment/${map}${isFullscreen ? "/full" : ""}${stopId ? `/stop/${encodePathSegment(stopId)}` : ""}`,
  network: () => "/network",
  nearby: () => "/nearby",
  settings: () => "/settings",
  /** A stop, at one of its parts where chosen. */
  stop: (stopId: string, partId?: string) => `/stop/${stopId}${partId ? `/${partId}` : ""}`,
  line: (
    lineId: string,
    stopId?: string,
    bundledLineIds: readonly string[] = [],
    partId?: string,
  ) => {
    const id = getLinePathSegment(lineId, bundledLineIds);
    // Without a stop the shell supplies one.
    return stopId ? `${routePaths.stop(stopId, partId)}/line/${id}` : `/line/${id}`;
  },
  journey: (
    addressId: string,
    lineId: string,
    stopId: string,
    bundledLineIds: readonly string[] = [],
    partId?: string,
  ) =>
    `${routePaths.stop(stopId, partId)}/line/${getLinePathSegment(lineId, bundledLineIds)}${formatJourneyPath(addressId)}`,
  /** A journey from the plain stop board; its line is inferred from the departure. */
  journeyAtStop: (addressId: string, stopId: string, partId?: string) =>
    `${routePaths.stop(stopId, partId)}${formatJourneyPath(addressId)}`,
  /** A ride, with the rider's boarding and alighting stops where chosen. */
  ride: (addressId: string, originStopId?: string, alightingStopId?: string) => {
    const journey = formatJourneyPath(addressId);
    const from = originStopId ? `/from/${encodePathSegment(originStopId)}` : "";
    const to = alightingStopId ? `/to/${encodePathSegment(alightingStopId)}` : "";
    return `${journey}${from}${to}`;
  },
};

/**
 * Where the app opens: the stop last read, else home. A recalled stop needs no location permission
 * and is usually right; a wrong one costs a tap.
 */
export function getLandingPath(recentStopId?: string): string {
  return recentStopId ? routePaths.stop(recentStopId) : routePaths.home();
}

/**
 * The chain levels a path builder takes, as named fields so two optional stop ids cannot be
 * swapped. Leaving out a level is how it leaves the address.
 */
export type SelectionAddress = {
  stopId: string;
  /** The part of the stop the board is read at. */
  partId?: string;
  lineId?: string;
  /** Siblings read with that line. */
  bundledLineIds?: readonly string[];
  addressId?: string;
  /** Whether a journey was opened from the stop board or from a line. */
  journeyParent?: JourneyParent;
  isRide?: boolean;
  /** The marked Ausstieg; only a ride carries one. */
  alightingStopId?: string;
  /** The stop the ride was begun at. */
  originStopId?: string;
};

/** The address for a selection that has been resolved against live data. */
export function getSelectionPath({
  stopId,
  partId,
  lineId,
  bundledLineIds,
  addressId,
  journeyParent,
  isRide = false,
  alightingStopId,
  originStopId,
}: SelectionAddress): string {
  // A ride lasts as long as its journey; then the line takes over like any other journey.
  if (addressId && isRide) return routePaths.ride(addressId, originStopId, alightingStopId);
  if (!lineId) return routePaths.stop(stopId, partId);
  // A stop-parent journey has no line segment for a bundle, so choosing one promotes the line to
  // parent.
  if (addressId && journeyParent === "stop" && (bundledLineIds?.length ?? 0) === 0) {
    return routePaths.journeyAtStop(addressId, stopId, partId);
  }
  return addressId
    ? routePaths.journey(addressId, lineId, stopId, bundledLineIds, partId)
    : routePaths.line(lineId, stopId, bundledLineIds, partId);
}

/**
 * One level up: drops the journey, then the line, then the stop. Never computed from live data, so
 * the target is readable off the URL. A ride steps back to its origin stop, or home without one.
 */
export function getParentSelectionPath({
  view,
  stopId,
  partId,
  lineId,
  bundledLineIds,
  addressId,
  journeyParent,
  isRide = false,
  originStopId,
}: SelectionAddress & { view: RouteView }): string | undefined {
  // Every page above the chain steps up to home.
  if (view === "home") return undefined;
  if (view !== "stop") return routePaths.home();
  if (isRide) {
    if (!originStopId) return routePaths.home();
    return addressId && lineId
      ? routePaths.journey(addressId, lineId, originStopId, bundledLineIds)
      : routePaths.stop(originStopId);
  }
  // The bundle belongs to the line level and survives unpinning a journey.
  if (addressId && journeyParent === "stop") return routePaths.stop(stopId, partId);
  if (addressId && lineId) return routePaths.line(lineId, stopId, bundledLineIds, partId);
  if (lineId) return routePaths.stop(stopId, partId);
  return routePaths.home();
}

/** The dated journey, else the row's own id. */
export function getStopEventAddressId(stopEvent: Pick<StopEvent, "id" | "datedJourneyId">): string {
  return stopEvent.datedJourneyId ?? stopEvent.id;
}

/**
 * Where tapping a departure goes. A row on a plain stop board keeps the stop as parent; a row in a
 * selected line keeps the line. Every board order uses this one target.
 */
export function getStopEventOpenPath(
  stopEvent: StopEvent,
  stopId: string,
  isPinned: boolean,
  /**
   * The bundle the row was tapped in: a journey of one of its lines keeps the bundle; any other
   * line goes alone.
   */
  selection?: LineSelection,
  partId?: string,
): string {
  const { lineId, bundledLineIds } =
    selection && isSelectedLine(selection, stopEvent)
      ? selection
      : { lineId: stopEvent.lineId, bundledLineIds: [] };
  if (isPinned) return routePaths.line(lineId, stopId, bundledLineIds, partId);
  const addressId = getStopEventAddressId(stopEvent);
  return selection
    ? routePaths.journey(addressId, lineId, stopId, bundledLineIds, partId)
    : routePaths.journeyAtStop(addressId, stopId, partId);
}

/**
 * Whether a journey the address names could still turn up in a reading that has not answered. A
 * journey past this stop is on no stop board, only on the line's boards, which answer later;
 * rewriting the address before they do would drop the journey from a shared link.
 */
export function isAddressOutstanding({
  addressId,
  hasResolvedStopEvent,
  isStopBoardRead,
  isReadingLine,
}: {
  addressId: string | undefined;
  /** Whether something in hand has resolved the address. */
  hasResolvedStopEvent: boolean;
  isStopBoardRead: boolean;
  /** Whether the line's boards are still outstanding. */
  isReadingLine: boolean;
}): boolean {
  if (!addressId || hasResolvedStopEvent) return false;
  return !isStopBoardRead || isReadingLine;
}

/** The row an address names on a freshly loaded board. */
export function findStopEventByAddressId(
  stopEvents: readonly StopEvent[],
  addressId: string | undefined,
): StopEvent | undefined {
  if (!addressId) return undefined;
  return stopEvents.find(
    (stopEvent) => stopEvent.datedJourneyId === addressId || stopEvent.id === addressId,
  );
}

/**
 * The key of the view to scroll to the top on, or `null` where the view places itself. Rewrites as
 * levels resolve do not count. A line diagram aims itself at the stop or pinned vehicle; a ride is
 * a view, since its status card is what was opened.
 */
export function getViewStartKey(route: AppRoute): string | null {
  if ((route.lineId || route.addressId) && !route.isRide) return null;
  return `${route.view}|${route.stopId}|${route.lineId}|${route.isRide}`;
}

export const hasRouteAddress = (): boolean => getRouteSegments(window.location.hash).length > 0;

export const navigateTo = (path: string) => {
  window.location.hash = path;
};

/**
 * Replaces the history entry: narrowing a selection is not a navigation, and back must still lead
 * where the rider came from. A no-op when unchanged, so it is safe in an effect.
 */
export const replaceCurrentRoute = (path: string) => {
  if (window.location.hash.replace(/^#/, "") === path) return;
  window.location.replace(`#${path}`);
};
