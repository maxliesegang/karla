/**
 * Hash routing. Deep links have to survive static hosting, so every view is addressable through the
 * fragment alone (`#/center`, `#/stop/marktplatz`, `#/stop/europaplatz/line/2`).
 *
 * One home page that names the other pages, and one nested selection chain: a stop, optionally a
 * line calling at it, and one trip. A trip opened from the stop board keeps the stop as its parent;
 * a trip opened from a line keeps the line. Each level refines the one above it and is dropped back
 * to it on its own, so a trip that has departed or a line that has stopped running narrows the
 * address instead of invalidating it.
 */
import { getLineFamilyId } from "./lib/line-families";
import {
  formatLineSelection,
  isSelectedLine,
  parseLineSelection,
  type LineSelection,
} from "./lib/line-bundles";
import type { Departure } from "./data/transit-types";

export type RouteView = "home" | "zentrum" | "stop" | "network" | "nearby" | "notices" | "settings";

/**
 * The panel the shell actually shows. A stop with a line selected refines the stop view into the
 * line diagram, which is a view of its own to render but never an address of its own.
 */
export type ActiveView = RouteView | "line";
export type TripParent = "stop" | "line";

export const DEFAULT_STOP_ID = "europaplatz";
const DEFAULT_LINE_ID = "2";

/**
 * The line segment of an address, which names one line or the lines being read together:
 * `line/2`, `line/S1+S11`. Identity is per line throughout — a bundle is a view of two lines over
 * the stretch they share, never a third line — so the segment is a list and never a name of its
 * own. The former combined `S1-S11` URL is read as exactly that bundle, which is what it always
 * meant and could not yet say.
 */
const parseLineSegment = (segment: string) =>
  parseLineSelection(segment === "S1-S11" ? "S1+S11" : segment);

function getLinePathSegment(lineId: string, bundledLineIds: readonly string[] = []): string {
  const primary = getLineFamilyId(lineId);
  return formatLineSelection({
    lineId: primary,
    // A caller may hand over the whole selection alongside one of its own lines; a line does not
    // appear twice in the address it names.
    bundledLineIds: bundledLineIds.filter((id) => getLineFamilyId(id) !== primary),
  });
}

/**
 * Kept flat rather than a per-view union: the shell needs a stop, board, and network scope in every
 * view, so each field is always resolved instead of narrowed at each use.
 *
 * `lineId` and `addressId` are what the address *asks* for. Whether they still resolve is the shell's
 * question, and an unanswerable one is dropped rather than turned into a dead end.
 */
export type AppRoute = {
  view: RouteView;
  stopId: string;
  /** Line selected at the stop; empty when the stop alone is in view. */
  lineId: string;
  /**
   * Sibling lines read together with it over the stretch they share — `line/S1+S11`. Chosen by the
   * rider and carried in the address like every other level, so a shared link opens the same
   * reading and a sibling that stops running drops out of it on its own.
   */
  bundledLineIds: readonly string[];
  /**
   * The line the Zentrum's plan is following — `#/center/line/2`.
   *
   * A level of its own rather than a reuse of `lineId`, because it refines a different thing: the
   * chain's line is a line *at a stop*, resolved against that stop's board, while this one is a
   * line highlighted on a drawing of the whole Zentrum and is answerable by the drawing alone.
   * It is in the address for the reason every other reading is — the reading a rider arrives at is
   * the reading they can share, and it survives a reload and a step back.
   */
  zentrumLineId: string;
  /**
   * The plan read at the size of the screen — `#/center/full`.
   *
   * A schematic of twenty-five stops wants the viewport, and in the panel it shares with a header,
   * a search field and the tabs it does not get it. Addressed rather than held in the view, because
   * it is the largest state change the page has: the back gesture is what a reader expects to close
   * it, and that only works if entering it was somewhere they went.
   */
  isZentrumFullscreen: boolean;
  /** Address of the selected run; undated and dated provider ids still resolve. */
  addressId?: string;
  /** The level a stop-scoped trip was opened from, retained for the step-up control. */
  tripParent?: TripParent;
  /**
   * The ride: the trip read on its own, addressed as `#/trip/:tripId` with no stop and no line
   * beside it. A rider already on board is reading the trip, not choosing another one, so the
   * board's half of the width goes to the diagram — which is where the changes at each stop become
   * showable.
   */
  isRide: boolean;
  /**
   * The stop the rider marked as their Ausstieg while reading a trip. It refines the trip the way
   * the trip refines the line — chosen, addressable, and dropped on its own once the trip no longer
   * calls there. Only a trip read on its own has one: it is the only view that is about the ride.
   */
  alightingStopId?: string;
  /**
   * The stop the ride was begun at — `/from/:stopId` — which is the address the rider came from and
   * therefore the one step up leads back to. Carried rather than inferred: reading the boarding stop
   * off the trip would pin a level the rider never chose, and guessing from the trip's progress
   * lands them at a stop they have never seen. A ride reached by a shared link names none, and step
   * up says so by leading to the home rather than somewhere invented.
   */
  originStopId?: string;
};

const defaultRoute: AppRoute = {
  view: "home",
  stopId: DEFAULT_STOP_ID,
  lineId: "",
  bundledLineIds: [],
  zentrumLineId: "",
  isZentrumFullscreen: false,
  isRide: false,
};

/**
 * The line a trip belongs to, read out of EFA's own trip identity: `de:kvv:00S02_:.kvv-21-12-E…`
 * names the line in its third segment, zero-padded and underscore-terminated. That is what lets a
 * trip be addressed alone — `#/trip/:tripId` states the line without repeating it in the URL.
 *
 * An id in any other shape yields nothing, and the shell falls back to reading the line off the
 * trip once a board resolves it, exactly as a legacy `/departure/:tripId` link does.
 */
function getLineIdFromTripId(tripId: string): string {
  // `00S02_` is line S2: zeros pad both around the letter and in front of the number.
  const lineSegment = (tripId.split(":")[2] ?? "").replace(/_+$/, "");
  const padded = /^0*([A-Z]*?)0*(\d{1,3})$/.exec(lineSegment);
  return padded ? getLineFamilyId(`${padded[1]}${padded[2]}`) : "";
}

const getRouteSegments = (hash: string): string[] =>
  hash.replace(/^#\/?/, "").split("/").filter(Boolean);

/** A malformed percent escape in a hand-edited hash should produce a not-found view, not crash. */
function decodePathSegment(segment: string | undefined): string {
  if (!segment) return "";
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Colons are valid in a path segment and make EFA's namespaced trip ids much easier to read. */
const encodePathSegment = (segment: string): string =>
  encodeURIComponent(segment).replaceAll("%3A", ":");

/** `/stop/:stopId` and everything that may refine it, including the shapes earlier versions used. */
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
  // The former `/lines` narrowing is gone — the stop's own address holds board and connections
  // alike — so an old link simply lands on the stop and is rewritten to it.
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
 * The `from`/`to` stops that may follow a trip's own id, read as named pairs rather than by
 * position: they are independent of one another, either may be absent, and a link that carries only
 * an Ausstieg must not be read as naming an origin.
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

export function parseRoute(hash: string): AppRoute {
  const [view, ...rest] = getRouteSegments(hash);

  switch (view) {
    case "line":
      // A line chosen from the index carries no stop yet. The shell resolves the first stop the
      // line is seen calling at and rewrites the address to the canonical nested form.
      return {
        ...defaultRoute,
        view: "stop",
        stopId: "",
        ...parseLineSegment(rest[0] || DEFAULT_LINE_ID),
      };
    case "trip": {
      // The trip read alone. It names no stop of its own, because a rider on board is not standing
      // at one, and no line, because its own identity states which line it is. What may follow are
      // the two stops the rider chose: `/from/:stopId` where they got on, `/to/:stopId` where they
      // mean to get off.
      const addressId = decodePathSegment(rest[0]);
      const { from, to } = parseTripQualifiers(rest.slice(1));
      return {
        ...defaultRoute,
        view: "stop",
        stopId: "",
        lineId: getLineIdFromTripId(addressId),
        addressId,
        isRide: true,
        originStopId: from,
        alightingStopId: to,
      };
    }
    case "ride":
    // The ride's earlier address, which named the line and stop the way `/departure` does rather
    // than standing on the trip's own identity. Falls through.
    case "departure": {
      // Shared links from when a trip was the address. `/departure/:trip/:stop` names no line at
      // all, so the line is recovered from the board and the address rewritten once it resolves;
      // `/departure/:trip/:line/:stop` was the older shape and still carries one.
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
      // The line index is one page of the whole observed network; legacy scoped links
      // (`/network/city`, `/network/region`) open it.
      return { ...defaultRoute, view: "network" };
    case "nearby":
      return { ...defaultRoute, view: "nearby" };
    case "notices":
      return { ...defaultRoute, view: "notices" };
    case "settings":
      return { ...defaultRoute, view: "settings" };
    case "center": {
      // The plan's two sizes. The followed line reads the same after either, because it refines
      // the plan and not its size. The former `/center/stops` stop index is gone — the plan is
      // the Zentrum's page — so an old link simply lands on the plan.
      const [qualifier, ...tail] = rest;
      const isZentrumFullscreen = qualifier === "full";
      const lineSegments = isZentrumFullscreen ? tail : rest;
      return {
        ...defaultRoute,
        view: "zentrum",
        isZentrumFullscreen,
        zentrumLineId: lineSegments[0] === "line" ? decodePathSegment(lineSegments[1]) : "",
      };
    }
    case "stop":
      return parseStopRoute(rest);
    default:
      return defaultRoute;
  }
}

/**
 * The only place route paths are spelled out, so a route change cannot be half-applied.
 *
 * `zentrum` addresses `/center`: the segment is published and shared, so it stays as it was spelled
 * while the code around it calls the place by the one name the rest of the app uses.
 */
export const routePaths = {
  home: () => "/",
  /**
   * The Zentrum's plan: the line it is following where the rider has chosen one, at the size they
   * are reading it at.
   */
  zentrum: (lineId?: string, isFullscreen = false) =>
    `/center${isFullscreen ? "/full" : ""}${lineId ? `/line/${encodePathSegment(lineId)}` : ""}`,
  network: () => "/network",
  nearby: () => "/nearby",
  notices: () => "/notices",
  settings: () => "/settings",
  stop: (stopId: string) => `/stop/${stopId}`,
  line: (lineId: string, stopId?: string, bundledLineIds: readonly string[] = []) => {
    const id = getLinePathSegment(lineId, bundledLineIds);
    // Without a stop there is no board to read the line against; the shell supplies one.
    return stopId ? `/stop/${stopId}/line/${id}` : `/line/${id}`;
  },
  trip: (
    addressId: string,
    lineId: string,
    stopId: string,
    bundledLineIds: readonly string[] = [],
  ) =>
    `/stop/${stopId}/line/${getLinePathSegment(lineId, bundledLineIds)}/trip/${encodePathSegment(addressId)}`,
  /** A trip selected from the plain stop board; its line is inferred from the departure. */
  tripAtStop: (addressId: string, stopId: string) =>
    `/stop/${stopId}/trip/${encodePathSegment(addressId)}`,
  /**
   * The ride: no stop of the chain beside the trip, and the line read out of the trip's own
   * identity. The two stops it may carry are the rider's own — where they got on, where they mean
   * to get off — and the first of them is what makes stepping up out of a ride an address rather
   * than a guess.
   */
  ride: (addressId: string, originStopId?: string, alightingStopId?: string) => {
    const trip = `/trip/${encodePathSegment(addressId)}`;
    const from = originStopId ? `/from/${encodePathSegment(originStopId)}` : "";
    const to = alightingStopId ? `/to/${encodePathSegment(alightingStopId)}` : "";
    return `${trip}${from}${to}`;
  },
};

/**
 * Where the app opens.
 *
 * The stop the rider last read, and the home when there is none — the page that names the other
 * pages and asks nothing of the network. A rider opening KARLA is nearly
 * always standing at one of the two or three stops they use, and that stop is already known without
 * asking anyone anything: it needs no permission, answers offline, and was chosen by the rider
 * rather than inferred. Opening on the nearby view instead would greet every rider with a permission
 * prompt before the app says anything true.
 *
 * The recalled stop is a starting point, not a claim about where the rider is standing — it is the
 * stop they departed *from*, which is one they are not necessarily at. The list under the
 * search is what makes a wrong landing cost one tap.
 */
export function getLandingPath(recentStopId?: string): string {
  return recentStopId ? routePaths.stop(recentStopId) : routePaths.home();
}

/**
 * The levels of the chain an address may name, as the path builders read them.
 *
 * An object rather than a positional list: half the fields are optional strings that read alike —
 * a stop, an Ausstieg, an origin — and two of those swapped in a call would still compile. Each
 * caller states what it has in hand and the builders answer with the one path that says exactly
 * that; passing no line, or a line with no trip, is how a level that stopped resolving leaves the
 * address.
 */
export type SelectionAddress = {
  stopId: string;
  lineId?: string;
  /** The siblings read together with that line, which travel with it through every path builder. */
  bundledLineIds?: readonly string[];
  addressId?: string;
  /** Whether a trip was opened from the stop board or from an explicit line selection. */
  tripParent?: TripParent;
  isRide?: boolean;
  /** The marked Ausstieg, which only a trip read on its own can carry. */
  alightingStopId?: string;
  /** The stop the ride was begun at, carried so stepping up out of it stays an address. */
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
  // Reading a trip alone is a mode of the trip, not of the chain: it lasts exactly as long as the
  // trip does, and a trip that has departed leaves the line in view beside its board like any other.
  if (addressId && isRide) return routePaths.ride(addressId, originStopId, alightingStopId);
  if (!lineId) return routePaths.stop(stopId);
  // A stop-parent trip has no line segment to carry a bundle. Choosing one promotes the line to an
  // explicit parent so the bundle remains part of the shareable address.
  if (addressId && tripParent === "stop" && (bundledLineIds?.length ?? 0) === 0) {
    return routePaths.tripAtStop(addressId, stopId);
  }
  return addressId
    ? routePaths.trip(addressId, lineId, stopId, bundledLineIds)
    : routePaths.line(lineId, stopId, bundledLineIds);
}

/**
 * One level up, and nothing else.
 *
 * Step up drops exactly one thing from the address the rider is at — the trip, then the line, then
 * the stop — so where it leads is readable off the URL before it is pressed, and pressing it twice
 * from a trip always reaches that trip's stop. It never computes a destination from live data: a
 * step up that lands somewhere new because a vehicle moved is not a step up, it is a step forward
 * wearing the same arrow. Leaving a ride behind at the stop it reached is a different act with a
 * different address, and the ride states it in its own words.
 *
 * The ride steps back to where it was begun: the same trip, pinned at the stop the rider boarded at,
 * which is the address they pressed *Fahrt begleiten* on. Without an origin — a ride opened from a
 * shared link — there is no such address, and the home is the honest answer.
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
  // The home page is the top of everything: every page above the chain steps back up to it, and a
  // step up out of one page into its sibling would be a step sideways drawn as an arrow back.
  if (view === "home") return undefined;
  if (view !== "stop") return routePaths.home();
  if (isRide) {
    if (!originStopId) return routePaths.home();
    return addressId && lineId
      ? routePaths.trip(addressId, lineId, originStopId, bundledLineIds)
      : routePaths.stop(originStopId);
  }
  // The bundle is part of the line level, so unpinning a trip comes back to the same reading the
  // rider chose rather than quietly dropping the sibling out from under them.
  if (addressId && tripParent === "stop") return routePaths.stop(stopId);
  if (addressId && lineId) return routePaths.line(lineId, stopId, bundledLineIds);
  if (lineId) return routePaths.stop(stopId);
  return routePaths.home();
}

/** Prefer EFA's own trip identity for concise URLs; retain local identity as a defensive fallback. */
export function getDepartureAddressId(
  departure: Pick<Departure, "id" | "tripId" | "tripInstanceId">,
): string {
  return departure.tripId ?? departure.tripInstanceId ?? departure.id;
}

/**
 * Where tapping a departure goes: the pinned trip steps back up to its line. A row in a plain stop
 * board keeps the stop as the trip's parent, while a row in a selected line keeps that line.
 *
 * The rows of the time and platform orders and the chips of the line order address the same trip —
 * one gesture, one address, whatever the reading — so the target is spelled here once rather than
 * wherever a departure is rendered.
 */
export function getDepartureOpenPath(
  departure: Departure,
  stopId: string,
  isPinned: boolean,
  /**
   * The reading the row was tapped in, where the board is being read as a bundle. A trip of one of
   * its lines is pinned *within* that reading — the corridor is what the rider chose, and the row's
   * own badge already says which line the trip belongs to — so the address keeps the same lines in
   * the same order and only the trip changes. A row of any other line is a different choice, and
   * leads to that line alone.
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
 * Whether a trip the address names could still be found by a reading that has not answered yet.
 *
 * The rider's own board is not that reading. A trip that has already left this stop is on no board
 * here at all — a board lists what has yet to leave — and while it is still running it is on the
 * boards read along its line, which answer seconds after the stop's own. A chain that read the stop
 * board alone and rewrote the address without the trip took it out of a shared link before the
 * reading that had it could answer, and then stopped looking, because the address it would have
 * looked with was the one it had just rewritten. Opening the same link at a stop the trip has not
 * reached yet kept it, which is how the two readings of one trip came to disagree.
 */
export function isAddressOutstanding({
  addressId,
  hasResolvedDeparture,
  isStopBoardRead,
  isReadingLine,
}: {
  addressId: string | undefined;
  /** Whether something in hand has resolved the address. Resolved leaves nothing outstanding. */
  hasResolvedDeparture: boolean;
  isStopBoardRead: boolean;
  /** Whether the boards along the line are still outstanding for the route as it is known. */
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
 * The address as a view to *start at the top of*, or `null` where the view places itself.
 *
 * Opening a hash route is opening a view, not following an in-page anchor, so it begins at its
 * heading. Two things are deliberately not new views. The address is rewritten in place as levels
 * resolve and drop — on every board refresh, in fact — so only what a rider actually moved to
 * counts. And a line's diagram aims itself: at the stop being read, and at the vehicle the rider
 * chose where a trip is pinned. A stop-board trip is also the diagram's reading, even though its
 * line is inferred. A scroll reset out here is the later writer of the two, and taking
 * the top would undo that aim however well it was taken — which is as true of moving along the line
 * from one of its stops to the next as it is of picking a trip. A ride is a view again, because
 * there the status card at the top *is* what was opened.
 */
export function getViewStartKey(route: AppRoute): string | null {
  if ((route.lineId || route.addressId) && !route.isRide) return null;
  return `${route.view}|${route.stopId}|${route.lineId}|${route.isRide}`;
}

/** Whether the address names a view at all, or the app was opened at its bare root. */
export const hasRouteAddress = (): boolean => getRouteSegments(window.location.hash).length > 0;

export const navigateTo = (path: string) => {
  window.location.hash = path;
};

/**
 * Narrowing a selection, or resolving a legacy link, is not somewhere the rider chose to go: the
 * back button must still lead where they came from. Comparing first keeps this safe to call from an
 * effect on every render, and keeps routing the only module that reads the address.
 */
export const replaceCurrentRoute = (path: string) => {
  if (window.location.hash.replace(/^#/, "") === path) return;
  window.location.replace(`#${path}`);
};
