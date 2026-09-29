/**
 * What the shell is actually showing, derived once.
 *
 * The address says what was asked for and `selection.ts` says what of it still resolves; this says
 * what that means for the two halves of the dashboard — which of them is present, which is wide,
 * and what each is showing. It used to be a dozen booleans computed inline in `App.tsx`, each
 * spelling out a corner of the same question, which is why a new view had to be threaded through
 * all of them to be laid out correctly.
 *
 * It is pure and holds no React: the layout of a view is a fact about an address, testable without
 * mounting anything.
 */
import {
  getParentSelectionPath,
  routePaths,
  type ActiveView,
  type AppRoute,
  type RouteView,
} from "./routing";

/**
 * A board mounted at one stop needs none of the Zentrum observation, and polling five deep boards for
 * the rest of the day to colour a few badges is the whole of what it would buy.
 */
export const isStationBoardStopView = (view: RouteView, isStationBoardMode: boolean): boolean =>
  isStationBoardMode && view === "stop";

/**
 * Whether anything in view is actually read from the observation cycle, which is what decides the
 * cadence it runs at. Beside a departure board or a line diagram it only lends line signs, stop
 * positions and interchanges, which hold for hours. The home reads none of it: it names the other
 * pages and asks nothing of the network. The settings read none of it either.
 */
export const readsObservedNetwork = (view: ActiveView): boolean =>
  view === "zentrum" || view === "network" || view === "nearby";

/** The levels of the resolved chain the layout is read from — never the raw address. */
export type ResolvedViewSelection = {
  stopId: string;
  /** The line still resolving at the stop, which is what turns a stop view into a line view. */
  lineId: string | undefined;
  /** Address of the resolved run, which is what makes one run a different view to another. */
  addressId: string | undefined;
  hasSelectedDeparture: boolean;
  isRide: boolean;
  originStopId: string | undefined;
};

export type ViewLayoutInput = {
  route: AppRoute;
  selection: ResolvedViewSelection;
  isStationBoardMode: boolean;
  /** The page the nearby list was opened to correct, which is the page it returns to. */
  nearbyReturnStopId: string | undefined;
};

export type ViewLayout = {
  /** The panel the shell shows: a stop with a line resolving at it is the line view. */
  activeView: ActiveView;
  /** The home page in view, the one that names the other pages. */
  isHomeView: boolean;
  isLineInView: boolean;
  /** The ride: a trip read on its own, with the board set aside and the whole width the diagram's. */
  isRideInView: boolean;
  /** Views that stand on their own, with no stop beneath them and so no board beside them. */
  isStandaloneView: boolean;
  /** A stop is one panel: its board, read by time, by platform or by line. */
  isStopBoardOnly: boolean;
  isStationBoardView: boolean;
  hasPrimaryPanel: boolean;
  hasDepartureBoard: boolean;
  /** Whether the dashboard collapses its second track, which is the width step that animates. */
  isSinglePanel: boolean;
  /** See {@link PanelKeys}. */
  primaryKey: string;
  boardKey: string;
  /** One level up the chain and nothing else, computed from what resolved rather than what was asked. */
  backPath: string | undefined;
};

/**
 * What each half of the dashboard is showing, as an identity.
 *
 * The two navigations that leave one half standing are the whole reason these exist. Picking
 * another trip changes the diagram beside a board that has not moved; walking to another stop
 * changes the board beside a diagram that has not. Each half is mounted under its own key, so the
 * half whose key is unchanged is left exactly as it was and the half that changed enters on its
 * own — no part of the app has to work out which of the two moved, and a third such navigation
 * needs no new case anywhere.
 *
 * A key names the *thing* in the panel, never the reading of it, and that is the whole of what
 * decides where the motion lives. A line's diagram already carries its own changes: it glides from
 * the stop it was read at to the next one, and from one of its vehicles to another, which is what
 * says the two readings are of one line. Keying the diagram by trip would replace that glide with
 * an entrance and undo it. So a trip of the same line is the same key, a different line is not, and
 * the ride is a thing of its own because it is the trip rather than the line that is being read.
 *
 * The home is keyed as itself and nothing more: it is one page, and the pages it names are views of
 * their own with keys of their own.
 */
export type PanelKeys = {
  /** What the primary panel is showing, or would be showing where it is mounted at all. */
  primaryKey: string;
  /** What the board is showing, or would be showing where it is mounted at all. */
  boardKey: string;
};

function getPanelKeys(
  activeView: ActiveView,
  selection: ResolvedViewSelection,
  isRideInView: boolean,
): PanelKeys {
  const primaryKey = isRideInView
    ? `ride:${selection.addressId ?? ""}`
    : activeView === "line"
      ? `line:${selection.lineId ?? ""}`
      : activeView;
  return { primaryKey, boardKey: `stop:${selection.stopId}` };
}

export function getViewLayout({
  route,
  selection,
  isStationBoardMode,
  nearbyReturnStopId,
}: ViewLayoutInput): ViewLayout {
  const activeView: ActiveView = route.view === "stop" && selection.lineId ? "line" : route.view;
  const isHomeView = activeView === "home";
  const isLineInView = activeView === "line";
  const isRideInView = isLineInView && selection.isRide && selection.hasSelectedDeparture;
  // Every view but the stop and its line stands on its own: it has no stop beneath it, and so no
  // board beside it.
  const isStandaloneView = activeView !== "stop" && !isLineInView;
  const isStationBoardView = isStationBoardStopView(route.view, isStationBoardMode);
  const isStopBoardOnly = activeView === "stop" && !isStationBoardView;
  // The ride takes the board out of the view as soon as the address names it, so a ride still
  // waiting for its boards to answer never flashes the board open for the moment it would take.
  const hasDepartureBoard =
    !isStandaloneView && !(isLineInView && selection.isRide) && !isStationBoardView;
  // The two-panel layout is the board beside the diagram; every other view fills the width on its
  // own, and the stop is that case too — its board is the whole view.
  const isSinglePanel = !hasDepartureBoard || isStopBoardOnly;

  return {
    activeView,
    isHomeView,
    isLineInView,
    isRideInView,
    isStandaloneView,
    isStopBoardOnly,
    isStationBoardView,
    hasPrimaryPanel: !isStopBoardOnly && !isStationBoardView,
    hasDepartureBoard,
    isSinglePanel,
    ...getPanelKeys(activeView, selection, isRideInView),
    backPath: getBackPath(route, selection, isRideInView, nearbyReturnStopId),
  };
}

/**
 * Step up drops exactly one thing from the address the rider is at, so where it leads is readable
 * off the URL before it is pressed. Computed from the resolved selection rather than from the raw
 * address, so a level that has already dropped is not stepped back into — and never from live data,
 * which is what used to land a rider leaving a ride at a stop the vehicle happened to be running
 * towards and they had never seen.
 */
function getBackPath(
  route: AppRoute,
  selection: ResolvedViewSelection,
  isRideInView: boolean,
  nearbyReturnStopId: string | undefined,
): string | undefined {
  // The nearby list is a correction to one page, so it returns to the page it corrected — and to
  // the home when it was opened from nothing to correct.
  if (route.view === "nearby") {
    return nearbyReturnStopId ? routePaths.stop(nearbyReturnStopId) : routePaths.home();
  }
  return getParentSelectionPath({
    view: route.view,
    stopId: selection.stopId,
    lineId: selection.lineId,
    addressId: selection.addressId,
    tripParent: route.tripParent,
    isRide: isRideInView,
    originStopId: selection.originStopId,
  });
}

/**
 * Which half of the dashboard changed between two layouts.
 *
 * Only the case where both changed at once needs stating anywhere: each half's own entrance is
 * carried by its key, and this is what lets the two be ordered against one another rather than
 * starting together.
 */
export type PanelChange = "none" | "primary" | "board" | "both";

export function describePanelChange(previous: PanelKeys, next: PanelKeys): PanelChange {
  const hasPrimaryChanged = previous.primaryKey !== next.primaryKey;
  const hasBoardChanged = previous.boardKey !== next.boardKey;
  if (hasPrimaryChanged && hasBoardChanged) return "both";
  if (hasPrimaryChanged) return "primary";
  if (hasBoardChanged) return "board";
  return "none";
}

/** The dashboard's own classes, which are what the layout's motion and widths are written against. */
export function getDashboardClassNames(layout: ViewLayout): (string | false)[] {
  return [
    "dashboard",
    layout.isSinglePanel && "single-panel",
    layout.isLineInView && "line-view",
    layout.isHomeView && "home-view",
    // The plan is the one view whose panel is a drawing rather than a column of words: it is
    // handed the panel's whole box, and on a phone the whole screen.
    layout.activeView === "zentrum" && "zentrum-view",
    layout.isStopBoardOnly && "stop-view",
    layout.isStationBoardView && "station-board-only",
  ];
}
