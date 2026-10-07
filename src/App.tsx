import { lazy, Suspense, useMemo, useRef, useState } from "react";
import { DataProvenanceFooter } from "./components/DataProvenanceFooter";
import { DepartureBoardPanel } from "./components/DepartureBoardPanel";
import { StationBoardView } from "./components/StationBoardView";
import { AppHeader } from "./components/AppHeader";
import { AppLoadingScreen } from "./components/AppLoadingScreen";
import { StopNotFoundView } from "./components/StopNotFoundView";
import { LineDiagramPanel } from "./components/LineDiagramPanel";
import { NetworkView } from "./components/NetworkView";
import { NearbyStopsView } from "./components/NearbyStopsView";
import { StopBottomMenu } from "./components/StopBottomMenu";
import { RideStatusPanel } from "./components/RideStatusPanel";
import { HomeEntry } from "./components/HomeEntry";
import { ServiceNoticesView } from "./components/ServiceNoticesView";
import { SettingsView } from "./components/SettingsView";
import { useZentrumNetwork } from "./hooks/departure-board-collection";
import { useAppRoute } from "./hooks/route";
import { useFeedNow } from "./hooks/clock";
import { useInitialLanding, useStopRecall } from "./hooks/stop-recall";
import { useIsNarrowViewport } from "./hooks/viewport";
import { useStationBoardReload, usePanelChange, useViewShortcuts } from "./hooks/shell";
import { useLocatableStops, useTransitNetwork } from "./hooks/transit-network";
import { useNearbyStops } from "./hooks/nearby-stops";
import { useRidePosition } from "./hooks/ride-position";
import { useServiceNotices, useStopTopologyBoard } from "./hooks/departure-board";
import { useStopCorridorPatterns } from "./hooks/stop-corridor-patterns";
import { useStopBoardingPlaces } from "./hooks/boarding-places";
import { useSelectionChain } from "./selection";
import { getRideProgress } from "./lib/ride-progress";
import { classNames } from "./lib/class-names";
import { findNoticesForStop } from "./lib/service-notices";
import { getDepartureAddressId, getSelectionPath, routePaths, navigateTo } from "./routing";
import { isStationBoardMode, stationBoardConfig } from "./station-board";
import { findLineBundleOffers } from "./lib/line-bundles";
import {
  getDashboardClassNames,
  getViewLayout,
  readsObservedNetwork,
  isStationBoardStopView,
} from "./view-layout";

const GeoMapView = lazy(() =>
  import("./components/geo/GeoMapView").then((module) => ({ default: module.GeoMapView })),
);
const RegionPlanView = lazy(() =>
  import("./components/region/RegionPlanView").then((module) => ({
    default: module.RegionPlanView,
  })),
);
const ZentrumView = lazy(() =>
  import("./components/zentrum/ZentrumView").then((module) => ({ default: module.ZentrumView })),
);

export default function App() {
  const departurePanelRef = useRef<HTMLElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [runPositionRequest, setRunPositionRequest] = useState(0);
  const [nearbyReturnStopId, setNearbyReturnStopId] = useState<string>();
  const route = useAppRoute();
  const isNarrowViewport = useIsNarrowViewport();
  // Decided before the selection resolves, since they decide what is fetched; the observation's
  // cadence depends on whether anything in view reads it.
  const isStationBoardView = isStationBoardStopView(route.view, isStationBoardMode);
  const isObservedNetworkInView = readsObservedNetwork(route.view);
  const {
    network: observedNetwork,
    departureBoards: observationBoards,
    coverage: zentrumCoverage,
  } = useZentrumNetwork({ isEnabled: !isStationBoardView, isInView: isObservedNetworkInView });
  const network = useTransitNetwork(observedNetwork);
  // Stop, line and trip resolve against live data; the shell picks a panel for the result.
  const selection = useSelectionChain(route, network, observationBoards);
  const { selectedStop } = selection;
  const stopTopologyBoard = useStopTopologyBoard(
    route.view === "stop" && !route.lineId && !isStationBoardView ? selectedStop?.id : undefined,
  );
  // The line's boards also teach this stop's corridors (their trips carry full sequences read
  // here), at no extra request.
  const stopTopologyBoards = useMemo(
    () => [...selection.lineDepartureBoards, ...observationBoards],
    [observationBoards, selection.lineDepartureBoards],
  );
  const stopCorridorPatterns = useStopCorridorPatterns(
    route.view === "stop" ? selectedStop?.id : undefined,
    stopTopologyBoard,
    stopTopologyBoards,
  );
  // Boarding places come from calling sequences too.
  const stopBoardingPlaces = useStopBoardingPlaces(
    route.view === "stop" ? selectedStop?.id : undefined,
    stopTopologyBoard,
    stopTopologyBoards,
    selection.departureBoard,
  );
  // Bundle offers from what the visit observed; no extra request.
  const selectedLineId = selection.lineSelection.lineId;
  const lineBundleOffers = useMemo(
    () =>
      findLineBundleOffers({
        lineId: selectedLineId,
        departures: selection.departures,
        patterns: stopCorridorPatterns,
      }),
    [selectedLineId, selection.departures, stopCorridorPatterns],
  );
  const feedNow = useFeedNow(selection.departureBoard);
  const locatableStops = useLocatableStops(network, observationBoards);
  const nearbyStopsController = useNearbyStops(locatableStops, !isStationBoardView);
  // Only a ride uses the position.
  const ridePosition = useRidePosition(route.isRide && !isStationBoardMode);
  // A station board skips notices.
  const noticeBoard = useServiceNotices(!isStationBoardView);
  // Only stops actually read are remembered, never ones passed on a ride.
  const { recentStopId, recentStops } = useStopRecall(
    route.view === "stop" && !route.isRide ? selectedStop : undefined,
  );

  // The layout, derived before the early returns so panel changes are tracked every render.
  const layout = getViewLayout({
    route,
    selection: {
      stopId: selection.stopId,
      lineId: selection.selectedLine?.id,
      addressId: selection.selectedDeparture && getDepartureAddressId(selection.selectedDeparture),
      hasSelectedDeparture: Boolean(selection.selectedDeparture),
      isRide: selection.isRide,
      originStopId: selection.originStopId,
    },
    isStationBoardMode,
    nearbyReturnStopId,
  });
  const panelChange = usePanelChange(layout);

  useViewShortcuts({ searchInputRef, isEnabled: !isStationBoardMode });
  useStationBoardReload(stationBoardConfig?.reloadMinutes);
  // Opens on the last-read stop, or home; never on a permission prompt.
  useInitialLanding(!isStationBoardMode, recentStopId);

  const showNearbyStops = (returnStopId?: string) => {
    setNearbyReturnStopId(returnStopId);
    navigateTo(routePaths.nearby());
  };

  if (selection.isStopLoading || selection.isAwaitingStopBoardTrip) {
    return <AppLoadingScreen />;
  }

  if (route.view === "stop" && !selectedStop) {
    return (
      <main className={classNames("app-shell", isStationBoardMode && "station-board-mode")}>
        <AppHeader
          nearbyStopsController={nearbyStopsController}
          onShowNearbyStops={() => showNearbyStops()}
        />
        <StopNotFoundView isFailed={selection.isStopFailed} onRetry={selection.retryStop} />
      </main>
    );
  }

  const { activeView, isLineInView, isRideInView, isStandaloneView } = layout;

  // Notices for the stop in view and its lines.
  const stopNotices =
    noticeBoard?.dataStatus === "live" && !isStandaloneView && selectedStop
      ? findNoticesForStop(noticeBoard.notices, selectedStop.id, [
          ...selection.departures.map((departure) => departure.lineId),
          ...(selection.selectedLine ? [selection.selectedLine.id] : []),
        ])
      : [];

  // KVV red by default; a line in view lends its colour so bar, panel and badges read as one.
  const shellThemeStyle =
    isLineInView && selection.selectedLine
      ? ({
          "--shell-accent": selection.selectedLine.color,
          "--shell-ink": selection.selectedLine.textColor,
        } as React.CSSProperties)
      : undefined;

  // The ride uses the rider's position where granted (`lib/ride-position.ts`).
  const rideProgress =
    isRideInView && selection.selectedDeparture
      ? getRideProgress(selection.selectedDeparture.tripCalls ?? [], feedNow, {
          alightingStopId: selection.alightingStopId,
          fix: ridePosition.fix,
        })
      : undefined;

  const toggleAlighting = (stopId: string) => {
    if (!selection.selectedDeparture) return;
    const addressId = getDepartureAddressId(selection.selectedDeparture);
    navigateTo(
      routePaths.ride(
        addressId,
        selection.originStopId,
        selection.alightingStopId === stopId ? undefined : stopId,
      ),
    );
  };

  return (
    <main
      className={classNames(
        "app-shell",
        isStationBoardMode && "station-board-mode",
        isRideInView && "ride-mode",
        /* Fullscreen plan: the middle row takes the bar's height; nothing overlays the footer. */
        route.view === "experiment" && route.isMapFullscreen && "zentrum-fullscreen",
      )}
      style={shellThemeStyle}
    >
      <AppHeader
        isStationBoardMode={isStationBoardMode}
        backPath={layout.backPath}
        nearbyStopsController={nearbyStopsController}
        currentPageStopId={activeView === "stop" ? selection.stopId : undefined}
        onShowNearbyStops={() => showNearbyStops(selection.stopId)}
        showsNearbyStopButton={activeView !== "home"}
      />
      <div
        className={classNames(...getDashboardClassNames(layout))}
        /* Which half changed; only read when both did, so the board can follow the panel. */
        data-panel-change={panelChange}
      >
        {layout.isStationBoardView && stationBoardConfig ? (
          <StationBoardView
            stop={selectedStop!}
            departures={selection.departures}
            departureBoard={selection.departureBoard}
            network={network}
            stationBoardConfig={stationBoardConfig}
            feedNow={feedNow}
          />
        ) : (
          <>
            {/* The diagram beside the board, or the whole width where there is no board. */}
            {layout.hasPrimaryPanel && (
              /* Keyed by what it shows: another line re-mounts it; another trip or stop of the
                 line glides. */
              <section className="primary-panel" key={layout.primaryKey}>
                {activeView === "home" && (
                  <HomeEntry
                    searchInputRef={searchInputRef}
                    recentStops={recentStops}
                    nearbyStopsController={nearbyStopsController}
                    onShowNearbyStops={() => showNearbyStops()}
                  />
                )}
                {activeView === "nearby" && <NearbyStopsView controller={nearbyStopsController} />}
                <Suspense fallback={<p role="status">Karte wird geladen …</p>}>
                  {activeView === "experiment" && route.experimentMap === "geo" && (
                    <GeoMapView
                      network={observedNetwork}
                      coverage={zentrumCoverage}
                      departureBoards={observationBoards}
                      selectedStopId={route.mapStopId || undefined}
                      isFullscreen={route.isMapFullscreen}
                    />
                  )}
                  {activeView === "experiment" && route.experimentMap === "region" && (
                    <RegionPlanView
                      network={observedNetwork}
                      coverage={zentrumCoverage}
                      departureBoards={observationBoards}
                      selectedStopId={route.mapStopId || undefined}
                      isFullscreen={route.isMapFullscreen}
                    />
                  )}
                  {activeView === "experiment" && route.experimentMap === "center" && (
                    <ZentrumView
                      network={observedNetwork}
                      coverage={zentrumCoverage}
                      departureBoards={observationBoards}
                      selectedLineId={route.zentrumLineId || undefined}
                      selectedStopId={route.zentrumStopId || undefined}
                      isFullscreen={route.isMapFullscreen}
                      isStacked={isNarrowViewport}
                      nearbyStops={nearbyStopsController}
                    />
                  )}
                </Suspense>
                {activeView === "network" && (
                  <NetworkView
                    network={network}
                    coverage={zentrumCoverage}
                    isStacked={isNarrowViewport}
                  />
                )}
                {activeView === "notices" && (
                  <ServiceNoticesView
                    network={network}
                    noticeBoard={noticeBoard}
                    feedNow={feedNow}
                  />
                )}
                {activeView === "settings" && <SettingsView />}
                {isLineInView && selection.selectedLine && (
                  <>
                    {/* The ride's status card, outside the scrollport so it stays. */}
                    {rideProgress && selection.selectedDeparture && (
                      <RideStatusPanel
                        line={selection.selectedLine}
                        departure={selection.selectedDeparture}
                        rideProgress={rideProgress}
                        feedNow={feedNow}
                        isRetainedObservation={selection.isSelectedDepartureRetained}
                        observedAt={selection.selectedDepartureObservedAt}
                        ridePosition={ridePosition}
                        onClearAlighting={
                          selection.alightingStopId
                            ? () => toggleAlighting(selection.alightingStopId ?? "")
                            : undefined
                        }
                        onShowPosition={() => setRunPositionRequest((request) => request + 1)}
                        /* Ending a ride lands at the Ausstieg or the trip's end; stepping up
                           returns to its origin. */
                        onEndRide={() =>
                          navigateTo(
                            routePaths.stop(
                              selection.alightingStopId ??
                                rideProgress.finalCall?.localStopId ??
                                selection.originStopId ??
                                selection.stopId,
                            ),
                          )
                        }
                      />
                    )}
                    <LineDiagramPanel
                      line={selection.selectedLine}
                      network={network}
                      stop={selectedStop!}
                      departure={selection.selectedDeparture}
                      /* The address, not the departure, which blinks while boards re-key after a
                         step. */
                      addressId={route.addressId}
                      preferredDestination={selection.preferredDestination}
                      departureBoard={selection.departureBoard}
                      lineDepartureBoards={selection.lineDepartureBoards}
                      observationBoards={observationBoards}
                      isRide={selection.isRide}
                      bundledLines={selection.bundledLines}
                      bundleOffers={lineBundleOffers}
                      /* The bundle is part of the address, so choosing one navigates. */
                      onChangeBundle={(bundledLineIds) =>
                        navigateTo(
                          getSelectionPath({
                            stopId: selection.stopId,
                            lineId: selection.selectedLine?.id,
                            bundledLineIds,
                            addressId: route.addressId,
                            tripParent: route.tripParent,
                          }),
                        )
                      }
                      alightingStopId={selection.alightingStopId}
                      onToggleAlighting={isRideInView ? toggleAlighting : undefined}
                      runPositionRequest={runPositionRequest}
                      rideNextCall={rideProgress?.nextCall}
                    />
                  </>
                )}
              </section>
            )}
            {layout.hasDepartureBoard && (
              /* Keyed by stop: a line or trip chosen from this board leaves it standing. */
              <DepartureBoardPanel
                key={layout.boardKey}
                panelRef={departurePanelRef}
                stop={selectedStop!}
                departures={selection.departures}
                completedLineDepartures={selection.lineRunDepartures}
                departureBoard={selection.departureBoard}
                network={network}
                feedNow={feedNow}
                lineSelection={selection.selectedLine ? selection.lineSelection : undefined}
                selectedDeparture={selection.selectedDeparture}
                corridorPatterns={stopCorridorPatterns}
                boardingPlaces={stopBoardingPlaces}
                isStacked={isNarrowViewport}
                boardReadingCount={selection.boardReadingCount}
                onRefresh={selection.refreshBoard}
                /* The stop's notices at the board's foot, kept while one of its lines shows. */
                bottomMenu={
                  activeView === "stop" || isLineInView ? (
                    <StopBottomMenu
                      stop={selectedStop!}
                      noticeBoard={noticeBoard}
                      notices={stopNotices}
                      lines={network.lines}
                      feedNow={feedNow}
                    />
                  ) : undefined
                }
              />
            )}
          </>
        )}
      </div>
      <DataProvenanceFooter
        /* Not under a board whose own notice bar already leads there. */
        showsNoticesLink={
          !isStationBoardMode &&
          activeView !== "notices" &&
          !(layout.hasDepartureBoard && stopNotices.length > 0)
        }
        /* Home and settings read nothing, so the footer names the source without a status. */
        {...(activeView === "notices"
          ? { serviceNoticeBoard: noticeBoard }
          : activeView === "home" || activeView === "settings"
            ? {}
            : isObservedNetworkInView
              ? { departureBoards: observationBoards, coverage: zentrumCoverage }
              : { departureBoard: selection.departureBoard })}
      />
    </main>
  );
}
