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
} from "./transit-network";
export {
  DEPARTURE_BOARD_REFRESH_MS,
  useDepartureBoard,
  type DepartureBoardVariant,
  useLineStopBoard,
  useServiceNotices,
  useStopTopologyBoard,
} from "./departure-board";
export {
  IDLE_OBSERVATION_REFRESH_MS,
  LINE_OBSERVATION_REFRESH_MS,
  REACH_OBSERVATION_REFRESH_MS,
  ZENTRUM_OBSERVATION_REFRESH_MS,
  useZentrumNetwork,
  useDepartureBoardCollection,
  useDepartureBoards,
  type DepartureBoardCollection,
} from "./departure-board-collection";
export {
  useDepartureBoardOrder,
  writeDepartureBoardOrder,
  type DepartureBoardOrder,
} from "./departure-order";
export { useStopCorridorPatterns } from "./stop-corridor-patterns";
export { useCurrentTime, useDeviceNow, useFeedNow, useVehicleFeedNow } from "./clock";
export { useIsNarrowViewport } from "./viewport";
export { useTransientScrollbar } from "./scrollbar";
export { useLineVehicleDepartures } from "./line-vehicle-departures";
export {
  useLineFilterDirectionIds,
  useLineObservation,
  useLineRoutes,
  type LineObservationReading,
} from "./line-observation";
export { useTripDepartures } from "./trip-departures";
export { useRetainedTrip, type RetainedTrip } from "./retained-trip";
export { useNearbyStops, type NearbyStopsController, type NearbyStopsState } from "./nearby-stops";
export { useRidePosition, type RidePositionController } from "./ride-position";
export { useInitialLanding, useStopRecall } from "./stop-recall";
export { usePanelChange, useStationBoardReload, useViewShortcuts } from "./shell";
export type { NearbyStop } from "../lib/nearby-stops";
