/**
 * The app's React hooks, one concern per module.
 *
 * Every hook the views and the shell use is re-exported here, so callers import from `"./hooks"`
 * (or `"../hooks"`) without knowing which module a hook lives in.
 */
export { useAppRoute } from "./route";
export {
  useLocatableStops,
  useTransitNetwork,
  useTransitStop,
} from "./network";
export {
  BOARD_REFRESH_MS,
  useDepartureBoard,
  type DepartureBoardVariant,
  useLineStopBoard,
  useServiceNotices,
  useStopTopologyBoard,
} from "./boards";
export {
  IDLE_OBSERVATION_REFRESH_MS,
  LINE_OBSERVATION_REFRESH_MS,
  REACH_OBSERVATION_REFRESH_MS,
  ZENTRUM_OBSERVATION_REFRESH_MS,
  useZentrumNetwork,
  useDepartureBoardCollection,
  useDepartureBoards,
  type DepartureBoardCollection,
} from "./board-collection";
export {
  useDepartureBoardOrder,
  writeDepartureBoardOrder,
  type DepartureBoardOrder,
} from "./departure-order";
export { useStopCorridorPatterns } from "./corridors";
export {
  useCurrentTime,
  useDeviceNow,
  useFeedNow,
  useIsNarrowViewport,
  useVehicleFeedNow,
} from "./clock";
export { useTransientScrollbar } from "./scrollbar";
export { useLineVehicleDepartures } from "./vehicles";
export { useTripDepartures } from "./trips";
export { useRetainedTrip, type RetainedTrip } from "./retained-trip";
export { useNearbyStops, type NearbyStopsController, type NearbyStopsState } from "./nearby-stops";
export { useRidePosition, type RidePositionController } from "./ride-position";
export { useInitialLanding, useStopRecall } from "./recall";
export { usePanelChange, useStationBoardReload, useViewShortcuts } from "./shell";
export type { NearbyStop } from "../lib/nearby-stops";
