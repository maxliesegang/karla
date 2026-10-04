/**
 * Hash routing, so deep links survive static hosting (`#/experiment`, `#/stop/europaplatz/line/2`).
 *
 * A home page plus one selection chain: stop, optional line, trip. Each level refines the one above
 * and drops back to it on its own, so a departed trip or a stopped line narrows the address
 * instead of breaking it.
 */
import { getLineFamilyId } from "./lib/line-families";
import {
  formatLineSelection,
  isSelectedLine,
  parseLineSelection,
  type LineSelection,
} from "./lib/line-bundles";
import type { Departure } from "./data/transit-types";

export type RouteView =
  | "home"
  | "experiment"
  | "stop"
  | "network"
  | "nearby"
  | "notices"
  | "settings";

/**
 * The panel shown. A stop with a line selected shows the line diagram, which has no address of its
 * own.
 */
export type ActiveView = RouteView | "line";
export type ExperimentMap = "center" | "geo" | "region";
/** The experiment maps with an address of their own; the Zentrum plan has `zentrum`. */
export type OtherExperimentMap = Exclude<ExperimentMap, "center">;
export type TripParent = "stop" | "line";

export const DEFAULT_STOP_ID = "europaplatz";
const DEFAULT_LINE_ID = "2";

/**
 * The line segment: one line or a bundle (`line/2`, `line/S1+S11`). A bundle is a view of several
 * lines, never a line of its own. The legacy `S1-S11` form reads as that bundle.
 */
const parseLineSegment = (segment: string) =>
  parseLineSelection(segment === "S1-S11" ? "S1+S11" : segment);

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
  /** Address of the selected run; undated and dated provider ids still resolve. */
  addressId?: string;
  /** The level a stop-scoped trip was opened from, retained for the step-up control. */
  tripParent?: TripParent;
  /** A ride: the trip read on its own (`#/trip/:tripId`), with no stop or line beside it. */
  isRide: boolean;
  /** The rider's marked Ausstieg on a ride; dropped once the trip no longer calls there. */
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
  lineId: "",
  bundledLineIds: [],
  zentrumLineId: "",
  zentrumStopId: "",
  experimentMap: "center",
  mapStopId: "",
  isMapFullscreen: false,
  isRide: false,
};

/**
 * The line named in EFA's trip id: the third segment of `de:kvv:00S02_:.kvv-21-12-E…`, padded and
 * underscore-terminated. Empty for any other shape; the shell then reads the line off the board.
 */
export function getTripLineId(tripId: string): string {
  // `00S02_` is line S2: zeros pad both around the letter and in front of the number.
  const lineSegment = (tripId.split(":")[2] ?? "").replace(/_+$/, "");
  const padded = /^0*([A-Z]*?)0*(\d{1,3})$/.exec(lineSegment);
  return padded ? getLineFamilyId(`${padded[1]}${padded[2]}`) : "";
}

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

/** Colons are valid in a path segment and keep EFA's namespaced ids readable. */
const encodePathSegment = (segment: string): string =>
  encodeURIComponent(segment).replaceAll("%3A", ":");

/** `/stop/:stopId` and its refinements, including legacy shapes. */
function parseStopRoute(segments: readonly string[]): AppRoute {
  const [rawStopId, qualifier, ...rest] = segments;
  const stopId = rawStopId ?? DEFAULT_STOP_ID;
  if (qualifier === "trip") {
    return {
      ...defaultRoute,
      view: "stop",
      stopId,
      addressId: decodePathSegment(rest[0]),
      tripParent: "stop",
    };
  }
  // The legacy `/lines` qualifier lands on the stop.
  if (qualifier !== "line") return { ...defaultRoute, view: "stop", stopId };

  return {
    ...defaultRoute,
    view: "stop",
    stopId,
    ...parseLineSegment(rest[0] || DEFAULT_LINE_ID),
    addressId: rest[1] === "trip" ? decodePathSegment(rest[2]) : undefined,
    tripParent: rest[1] === "trip" ? "line" : undefined,
  };
}

/**
 * The optional `from`/`to` stops after a trip id, read as named pairs since either may be absent.
 */
function parseTripQualifiers(segments: readonly string[]): { from?: string; to?: string } {
  const qualifiers: { from?: string; to?: string } = {};
  for (let index = 0; index + 1 < segments.length; index += 2) {
    const value = decodePathSegment(segments[index + 1]) || undefined;
    if (segments[index] === "from") qualifiers.from = value;
    if (segments[index] === "to") qualifiers.to = value;
  }
  return qualifiers;
}

/** The Zentrum plan's two sizes, after its map name; the legacy `/center/stops` lands on the plan. */
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
    case "trip": {
      // A ride: the trip alone, optionally with `/from/:stopId` and `/to/:stopId`.
      const addressId = decodePathSegment(rest[0]);
      const { from, to } = parseTripQualifiers(rest.slice(1));
      return {
        ...defaultRoute,
        view: "stop",
        stopId: "",
        lineId: getTripLineId(addressId),
        addressId,
        isRide: true,
        originStopId: from,
        alightingStopId: to,
      };
    }
    case "ride":
    // Legacy ride address; falls through.
    case "departure": {
      // Legacy trip links: `/departure/:trip/:stop` (line recovered from the board) and
      // `/departure/:trip/:line/:stop`.
      const namesLine = rest.length >= 3;
      return {
        ...defaultRoute,
        view: "stop",
        addressId: decodePathSegment(rest[0]),
        lineId: namesLine ? getLineFamilyId(rest[1] || "") : "",
        stopId: (namesLine ? rest[2] : rest[1]) || DEFAULT_STOP_ID,
        tripParent: namesLine ? "line" : "stop",
      };
    }
    case "network":
      // Legacy `/network/city` and `/network/region` open the line index.
      return { ...defaultRoute, view: "network" };
    case "nearby":
      return { ...defaultRoute, view: "nearby" };
    case "notices":
      return { ...defaultRoute, view: "notices" };
    case "settings":
      return { ...defaultRoute, view: "settings" };
    case "experiment":
      // Any other map name opens the Zentrum plan.
      return rest[0] === "geo" || rest[0] === "region"
        ? parseMapRoute(rest[0], rest.slice(1))
        : parseZentrumRoute(rest.slice(1));
    case "center":
      // The Zentrum plan's address before the experiment page.
      return parseZentrumRoute(rest);
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
  notices: () => "/notices",
  settings: () => "/settings",
  stop: (stopId: string) => `/stop/${stopId}`,
  line: (lineId: string, stopId?: string, bundledLineIds: readonly string[] = []) => {
    const id = getLinePathSegment(lineId, bundledLineIds);
    // Without a stop the shell supplies one.
    return stopId ? `/stop/${stopId}/line/${id}` : `/line/${id}`;
  },
  trip: (
    addressId: string,
    lineId: string,
    stopId: string,
    bundledLineIds: readonly string[] = [],
  ) =>
    `/stop/${stopId}/line/${getLinePathSegment(lineId, bundledLineIds)}/trip/${encodePathSegment(addressId)}`,
  /** A trip from the plain stop board; its line is inferred from the departure. */
  tripAtStop: (addressId: string, stopId: string) =>
    `/stop/${stopId}/trip/${encodePathSegment(addressId)}`,
  /** A ride, with the rider's boarding and alighting stops where chosen. */
  ride: (addressId: string, originStopId?: string, alightingStopId?: string) => {
    const trip = `/trip/${encodePathSegment(addressId)}`;
    const from = originStopId ? `/from/${encodePathSegment(originStopId)}` : "";
    const to = alightingStopId ? `/to/${encodePathSegment(alightingStopId)}` : "";
    return `${trip}${from}${to}`;
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
  lineId?: string;
  /** Siblings read with that line. */
  bundledLineIds?: readonly string[];
  addressId?: string;
  /** Whether a trip was opened from the stop board or from a line. */
  tripParent?: TripParent;
  isRide?: boolean;
  /** The marked Ausstieg; only a ride carries one. */
  alightingStopId?: string;
  /** The stop the ride was begun at. */
  originStopId?: string;
};

/** The address for a selection that has been resolved against live data. */
export function getSelectionPath({
  stopId,
  lineId,
  bundledLineIds,
  addressId,
  tripParent,
  isRide = false,
  alightingStopId,
  originStopId,
}: SelectionAddress): string {
  // A ride lasts as long as its trip; then the line takes over like any other trip.
  if (addressId && isRide) return routePaths.ride(addressId, originStopId, alightingStopId);
  if (!lineId) return routePaths.stop(stopId);
  // A stop-parent trip has no line segment for a bundle, so choosing one promotes the line to
  // parent.
  if (addressId && tripParent === "stop" && (bundledLineIds?.length ?? 0) === 0) {
    return routePaths.tripAtStop(addressId, stopId);
  }
  return addressId
    ? routePaths.trip(addressId, lineId, stopId, bundledLineIds)
    : routePaths.line(lineId, stopId, bundledLineIds);
}

/**
 * One level up: drops the trip, then the line, then the stop. Never computed from live data, so
 * the target is readable off the URL. A ride steps back to its origin stop, or home without one.
 */
export function getParentSelectionPath({
  view,
  stopId,
  lineId,
  bundledLineIds,
  addressId,
  tripParent,
  isRide = false,
  originStopId,
}: SelectionAddress & { view: RouteView }): string | undefined {
  // Every page above the chain steps up to home.
  if (view === "home") return undefined;
  if (view !== "stop") return routePaths.home();
  if (isRide) {
    if (!originStopId) return routePaths.home();
    return addressId && lineId
      ? routePaths.trip(addressId, lineId, originStopId, bundledLineIds)
      : routePaths.stop(originStopId);
  }
  // The bundle belongs to the line level and survives unpinning a trip.
  if (addressId && tripParent === "stop") return routePaths.stop(stopId);
  if (addressId && lineId) return routePaths.line(lineId, stopId, bundledLineIds);
  if (lineId) return routePaths.stop(stopId);
  return routePaths.home();
}

/** Prefers EFA's trip id for concise URLs, falling back to the local id. */
export function getDepartureAddressId(
  departure: Pick<Departure, "id" | "tripId" | "tripInstanceId">,
): string {
  return departure.tripId ?? departure.tripInstanceId ?? departure.id;
}

/**
 * Where tapping a departure goes. A row on a plain stop board keeps the stop as parent; a row in a
 * selected line keeps the line. Every board order uses this one target.
 */
export function getDepartureOpenPath(
  departure: Departure,
  stopId: string,
  isPinned: boolean,
  /**
   * The bundle the row was tapped in: a trip of one of its lines keeps the bundle; any other line
   * goes alone.
   */
  selection?: LineSelection,
): string {
  const { lineId, bundledLineIds } =
    selection && isSelectedLine(selection, departure.lineId)
      ? selection
      : { lineId: departure.lineId, bundledLineIds: [] };
  if (isPinned) return routePaths.line(lineId, stopId, bundledLineIds);
  const addressId = getDepartureAddressId(departure);
  return selection
    ? routePaths.trip(addressId, lineId, stopId, bundledLineIds)
    : routePaths.tripAtStop(addressId, stopId);
}

/**
 * Whether a trip the address names could still turn up in a reading that has not answered. A trip
 * past this stop is on no stop board, only on the line's boards, which answer later; rewriting the
 * address before they do would drop the trip from a shared link.
 */
export function isAddressOutstanding({
  addressId,
  hasResolvedDeparture,
  isStopBoardRead,
  isReadingLine,
}: {
  addressId: string | undefined;
  /** Whether something in hand has resolved the address. */
  hasResolvedDeparture: boolean;
  isStopBoardRead: boolean;
  /** Whether the line's boards are still outstanding. */
  isReadingLine: boolean;
}): boolean {
  if (!addressId || hasResolvedDeparture) return false;
  return !isStopBoardRead || isReadingLine;
}

/** Resolves current and legacy departure URLs against a freshly loaded board. */
export function findDepartureByAddressId(
  departures: readonly Departure[],
  addressId: string | undefined,
): Departure | undefined {
  if (!addressId) return undefined;
  return departures.find(
    (departure) =>
      departure.tripInstanceId === addressId ||
      departure.tripId === addressId ||
      departure.id === addressId,
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
