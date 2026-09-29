/**
 * The app's React hooks, one concern per module.
 *
 * Every hook the views and the shell use is re-exported here, so callers import from `"./hooks"`
 * (or `"../hooks"`) without knowing which module a hook lives in.
 */
export { useAppRoute } from "./route";
export { useAppSettings, writeAppSettings, type AppSettings } from "./app-settings";
export { useStopBoardingPlaces } from "./boarding-places";
export { useBoardingPlaceSections, type BoardingPlaceSections } from "./boarding-place-sections";
export { useNetworkBandNavigation, type NetworkBandNavigation } from "./network-band-navigation";
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
export { useElementBox, type ElementBox } from "./element-box";
export { useTransientScrollbar } from "./scrollbar";
export { usePullToRefresh } from "./pull-to-refresh";
export { useLineRunDepartures } from "./line-run-departures";
export {
  useVehicleTrajectoryAnimations,
  type TrajectoryAnimationFields,
} from "./vehicle-trajectory-animation";
export {
  useLineFilterDirectionIds,
  useLineObservation,
  useLineRoutes,
  type LineObservationReading,
} from "./line-observation";
export {
  LINE_RUN_READING_MAX_AGE_MS,
  useRunReadings,
  useRunReadingsByRowId,
  type RunReadingOptions,
} from "./run-reading-loader";
export { useZentrumPlanCanvas, type ZentrumPlanCanvas } from "./zentrum-plan-canvas";
export { useZentrumVehicles } from "./zentrum-vehicles";
export { useRetainedRun, type RetainedRun } from "./retained-run";
export { useNearbyStops, type NearbyStopsController, type NearbyStopsState } from "./nearby-stops";
export { useRidePosition, type RidePositionController } from "./ride-position";
export { useInitialLanding, useStopRecall } from "./stop-recall";
export { usePanelChange, useStationBoardReload, useViewShortcuts } from "./shell";
export type { NearbyStop } from "../lib/nearby-stops";
