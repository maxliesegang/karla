/**
 * What the shell shows for a resolved selection: which dashboard halves are present, which is wide,
 * and what each shows. Pure, so a view's layout is testable without mounting.
 */
import {
  getParentSelectionPath,
  routePaths,
  type ActiveView,
  type AppRoute,
  type RouteView,
} from "./routing";

/** A station board at one stop needs none of the Zentrum observation. */
export const isStationBoardStopView = (view: RouteView, isStationBoardMode: boolean): boolean =>
  isStationBoardMode && view === "stop";

/**
 * Whether anything in view reads the observation, which sets its cadence. Boards and diagrams only
 * borrow signs, positions and search; home and settings read none of it.
 */
export const readsObservedNetwork = (view: ActiveView): boolean =>
  view === "zentrum" || view === "network" || view === "nearby";

/** The resolved chain the layout is read from, never the raw address. */
export type ResolvedViewSelection = {
  stopId: string;
  /** The line resolving at the stop, which makes a stop view a line view. */
  lineId: string | undefined;
  /** The resolved run's address. */
  addressId: string | undefined;
  hasSelectedDeparture: boolean;
  isRide: boolean;
  originStopId: string | undefined;
};

export type ViewLayoutInput = {
  route: AppRoute;
  selection: ResolvedViewSelection;
  isStationBoardMode: boolean;
  /** The page the nearby list corrects, and returns to. */
  nearbyReturnStopId: string | undefined;
};

export type ViewLayout = {
  activeView: ActiveView;
  /** The home page. */
  isHomeView: boolean;
  isLineInView: boolean;
  /** A ride: the trip alone, the diagram at full width. */
  isRideInView: boolean;
  /** Views with no stop beneath them, so no board beside them. */
  isStandaloneView: boolean;
  /** A stop alone: its board is the whole view. */
  isStopBoardOnly: boolean;
  isStationBoardView: boolean;
  hasPrimaryPanel: boolean;
  hasDepartureBoard: boolean;
  /** Whether the dashboard collapses its second track (the animated width step). */
  isSinglePanel: boolean;
  /** See {@link PanelKeys}. */
  primaryKey: string;
  boardKey: string;
  /** One level up, from what resolved rather than what was asked. */
  backPath: string | undefined;
};

/**
 * Identities of what each dashboard half shows. Each half is mounted under its key, so a half whose
 * key is unchanged stays put and the other enters on its own (another trip beside the same board;
 * another stop beside the same diagram). A key names the thing, not the reading: a trip of the same
 * line keeps the diagram's key so it can glide, while a ride is its own thing.
 */
export type PanelKeys = {
  /** What the primary panel shows, or would where mounted. */
  primaryKey: string;
  /** What the board shows, or would where mounted. */
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
  // Every view but a stop and its line stands alone.
  const isStandaloneView = activeView !== "stop" && !isLineInView;
  const isStationBoardView = isStationBoardStopView(route.view, isStationBoardMode);
  const isStopBoardOnly = activeView === "stop" && !isStationBoardView;
  // A ride hides the board as soon as the address names it, so it never flashes open.
  const hasDepartureBoard =
    !isStandaloneView && !(isLineInView && selection.isRide) && !isStationBoardView;
  // Two panels only for a board beside a diagram.
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
 * One level up the resolved selection, so a dropped level is not stepped back into; never from
 * live data.
 */
function getBackPath(
  route: AppRoute,
  selection: ResolvedViewSelection,
  isRideInView: boolean,
  nearbyReturnStopId: string | undefined,
): string | undefined {
  // The nearby list returns to the page it corrected, or home.
  if (route.view === "nearby") {
    return nearbyReturnStopId ? routePaths.stop(nearbyReturnStopId) : routePaths.home();
  }
  // Dropping the plan's line or stop returns to the plan at the same size.
  if (route.view === "zentrum" && (route.zentrumStopId || route.zentrumLineId)) {
    return routePaths.zentrum({}, route.isZentrumFullscreen);
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
 * Which dashboard half changed; only "both" needs ordering, as each half's key carries its
 * entrance.
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

/** The dashboard's classes, which its motion and widths are styled against. */
export function getDashboardClassNames(layout: ViewLayout): (string | false)[] {
  return [
    "dashboard",
    layout.isSinglePanel && "single-panel",
    layout.isLineInView && "line-view",
    layout.isHomeView && "home-view",
    // The plan gets the panel's whole box, and the whole screen on a phone.
    layout.activeView === "zentrum" && "zentrum-view",
    layout.isStopBoardOnly && "stop-view",
    layout.isStationBoardView && "station-board-only",
  ];
}
