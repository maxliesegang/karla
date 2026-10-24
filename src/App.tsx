import { lazy, Suspense, useMemo, useRef, useState } from "react";
import { DataProvenanceFooter } from "./components/DataProvenanceFooter";
import { StopEventBoardPanel } from "./components/StopEventBoardPanel";
import { StationBoardView } from "./components/StationBoardView";
import { AppHeader } from "./components/AppHeader";
import { AppLoadingScreen } from "./components/AppLoadingScreen";
import { StopNotFoundView } from "./components/StopNotFoundView";
import { LineDiagramPanel } from "./components/LineDiagramPanel";
import { NetworkView } from "./components/NetworkView";
import { NearbyStopsView } from "./components/NearbyStopsView";
import { RideStatusPanel } from "./components/RideStatusPanel";
import { HomeEntry } from "./components/HomeEntry";
import { SettingsView } from "./components/SettingsView";
import {
  BOARD_REFRESH_LABEL,
  getLineRefreshLabel,
  NEARBY_REFRESH_LABEL,
  PullToRefreshStrip,
} from "./components/PullToRefreshStrip";
import { useZentrumNetwork } from "./hooks/stop-event-board-collection";
import { useAppRoute } from "./hooks/route";
import { useLatch } from "./hooks/latch";
import { useFeedNow } from "./hooks/clock";
import { useInitialLanding, useStopRecall } from "./hooks/stop-recall";
import { useIsNarrowViewport } from "./hooks/viewport";
import { useStationBoardReload, usePanelChange, useViewShortcuts } from "./hooks/shell";
import { usePullToRefresh } from "./hooks/pull-to-refresh";
import { useLocatableStops, useTransitNetwork } from "./hooks/transit-network";
import { useNearbyStops } from "./hooks/nearby-stops";
import { useRidePosition } from "./hooks/ride-position";
import { useStopTopologyBoard } from "./hooks/stop-event-board";
import { useStopCorridorPatterns } from "./hooks/stop-corridor-patterns";
import { useStopBoardingPlaces } from "./hooks/boarding-places";
import { useSelectionChain } from "./selection";
import { getRideProgress } from "./lib/ride-progress";
import { classNames } from "./lib/class-names";
import { getStopEventAddressId, getSelectionPath, routePaths, navigateTo } from "./routing";
import { isStationBoardMode, stationBoardConfig } from "./station-board";
import { findLineBundleOffers } from "./lib/line-bundles";
import {
  getDashboardClassNames,
  getViewLayout,
  needsObservedNetwork,
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

/** Stacked, the document is the one scrollport, so the page's pull is read on all of it. */
const DOCUMENT_REF = { current: document.documentElement };

/** What a pull on the stacked page reads again, for the views it does anything in. */
type PageRefresh = {
  onRefresh: () => void | Promise<unknown>;
  readingCount?: number;
  label: string;
  isReady: boolean;
};

export default function App() {
  const stopEventPanelRef = useRef<HTMLElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [datedJourneyPositionRequest, setDatedJourneyPositionRequest] = useState(0);
  const [nearbyReturnStopId, setNearbyReturnStopId] = useState<string>();
  const route = useAppRoute();
  const isNarrowViewport = useIsNarrowViewport();
  // Decided before the selection resolves, since they decide what is fetched; the observation's
  // cadence depends on whether anything in view reads it.
  const isStationBoardView = isStationBoardStopView(route.view, isStationBoardMode);
  const isObservedNetworkInView = readsObservedNetwork(route.view);
  // Read from the first view that needs it, then kept for the visit on its idle cadence.
  const isObservedNetworkWanted = useLatch(needsObservedNetwork(route));
  const {
    network: observedNetwork,
    stopEventBoards: observationBoards,
    coverage: zentrumCoverage,
  } = useZentrumNetwork({
    isEnabled: isObservedNetworkWanted && !isStationBoardView,
    isInView: isObservedNetworkInView,
  });
  const network = useTransitNetwork(observedNetwork);
  // Stop, line and journey resolve against live data; the shell picks a panel for the result.
  const selection = useSelectionChain(route, network, observationBoards);
  const { selectedStop } = selection;
  const stopTopologyBoard = useStopTopologyBoard(
    route.view === "stop" && !route.lineId && !isStationBoardView ? selectedStop?.id : undefined,
  );
  // The line's boards also teach this stop's corridors (their journeys carry full sequences read
  // here), at no extra request.
  const stopTopologyBoards = useMemo(
    () => [...selection.lineStopEventBoards, ...observationBoards],
    [observationBoards, selection.lineStopEventBoards],
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
    selection.stopEventBoard,
  );
  // Bundle offers from what the visit observed; no extra request.
  const selectedLineId = selection.lineSelection.lineId;
  const lineBundleOffers = useMemo(
    () =>
      findLineBundleOffers({
        lineId: selectedLineId,
        stopEvents: selection.stopEvents,
        patterns: stopCorridorPatterns,
      }),
    [selectedLineId, selection.stopEvents, stopCorridorPatterns],
  );
  const feedNow = useFeedNow(selection.stopEventBoard);
  const locatableStops = useLocatableStops(network, observationBoards);
  const nearbyStopsController = useNearbyStops(locatableStops, !isStationBoardView);
  // Only a ride uses the position.
  const ridePosition = useRidePosition(route.isRide && !isStationBoardMode);
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
      addressId: selection.selectedStopEvent && getStopEventAddressId(selection.selectedStopEvent),
      hasSelectedStopEvent: Boolean(selection.selectedStopEvent),
      isRide: selection.isRide,
      originStopId: selection.originStopId,
    },
    isStationBoardMode,
    nearbyReturnStopId,
  });
  const panelChange = usePanelChange(layout);

  // Stacked, a pull anywhere on the page refreshes everything it shows; maps keep their drag.
  const pageRefresh: PageRefresh | undefined =
    !isNarrowViewport || isStationBoardMode
      ? undefined
      : layout.isLineInView
        ? {
            onRefresh: selection.refreshLine,
            label: getLineRefreshLabel(layout.isRideInView),
            isReady: selection.stopEventBoard !== null || Boolean(selection.selectedStopEvent),
          }
        : layout.activeView === "stop"
          ? {
              onRefresh: selection.refreshBoard,
              readingCount: selection.boardReadingCount,
              label: BOARD_REFRESH_LABEL,
              isReady: selection.stopEventBoard !== null,
            }
          : layout.activeView === "nearby"
            ? {
                onRefresh: nearbyStopsController.locate,
                label: NEARBY_REFRESH_LABEL,
                isReady: nearbyStopsController.stops.length > 0,
              }
            : undefined;
  const pageStripRef = useRef<HTMLDivElement>(null);
  const pagePull = usePullToRefresh({
    listRef: DOCUMENT_REF,
    indicatorRef: pageStripRef,
    isPageScrollport: true,
    onRefresh: pageRefresh?.onRefresh ?? (() => {}),
    readingCount: pageRefresh?.readingCount,
    isEnabled: Boolean(pageRefresh?.isReady),
  });

  useViewShortcuts({ searchInputRef, isEnabled: !isStationBoardMode });
  useStationBoardReload(stationBoardConfig?.reloadMinutes);
  // Opens on the last-read stop, or home; never on a permission prompt.
  useInitialLanding(!isStationBoardMode, recentStopId);

  const showNearbyStops = (returnStopId?: string) => {
    setNearbyReturnStopId(returnStopId);
    navigateTo(routePaths.nearby());
  };

  if (selection.isStopLoading || selection.isAwaitingStopBoardJourney) {
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
        <DataProvenanceFooter />
      </main>
    );
  }

  const { activeView, isLineInView, isRideInView } = layout;

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
    isRideInView && selection.selectedStopEvent
      ? getRideProgress(selection.selectedStopEvent.calls ?? [], feedNow, {
          alightingStopId: selection.alightingStopId,
          fix: ridePosition.fix,
        })
      : undefined;

  const toggleAlighting = (stopId: string) => {
    if (!selection.selectedStopEvent) return;
    const addressId = getStopEventAddressId(selection.selectedStopEvent);
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
      {pageRefresh && <PullToRefreshStrip stripRef={pageStripRef} busyLabel={pageRefresh.label} />}
      <div
        className={classNames(...getDashboardClassNames(layout))}
        /* Which half changed; only read when both did, so the board can follow the panel. */
        data-panel-change={panelChange}
      >
        {layout.isStationBoardView && stationBoardConfig ? (
          <StationBoardView
            stop={selectedStop!}
            stopEvents={selection.stopEvents}
            stopEventBoard={selection.stopEventBoard}
            network={network}
            stationBoardConfig={stationBoardConfig}
            feedNow={feedNow}
          />
        ) : (
          <>
            {/* The diagram beside the board, or the whole width where there is no board. */}
            {layout.hasPrimaryPanel && (
              /* Keyed by what it shows: another line re-mounts it; another journey or stop of the
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
                {activeView === "nearby" && (
                  <NearbyStopsView
                    controller={nearbyStopsController}
                    isStacked={isNarrowViewport}
                  />
                )}
                <Suspense fallback={<p role="status">Karte wird geladen …</p>}>
                  {activeView === "experiment" && route.experimentMap === "geo" && (
                    <GeoMapView
                      network={observedNetwork}
                      coverage={zentrumCoverage}
                      stopEventBoards={observationBoards}
                      selectedStopId={route.mapStopId || undefined}
                      isFullscreen={route.isMapFullscreen}
                    />
                  )}
                  {activeView === "experiment" && route.experimentMap === "region" && (
                    <RegionPlanView
                      network={observedNetwork}
                      coverage={zentrumCoverage}
                      stopEventBoards={observationBoards}
                      selectedStopId={route.mapStopId || undefined}
                      isFullscreen={route.isMapFullscreen}
                    />
                  )}
                  {activeView === "experiment" && route.experimentMap === "center" && (
                    <ZentrumView
                      network={observedNetwork}
                      coverage={zentrumCoverage}
                      stopEventBoards={observationBoards}
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
                {activeView === "settings" && <SettingsView />}
                {isLineInView && selection.selectedLine && (
                  <>
                    {/* The ride's status card, outside the scrollport so it stays. */}
                    {rideProgress && selection.selectedStopEvent && (
                      <RideStatusPanel
                        line={selection.selectedLine}
                        stopEvent={selection.selectedStopEvent}
                        rideProgress={rideProgress}
                        feedNow={feedNow}
                        isRetainedObservation={selection.isSelectedStopEventRetained}
                        observedAt={selection.selectedStopEventObservedAt}
                        ridePosition={ridePosition}
                        onClearAlighting={
                          selection.alightingStopId
                            ? () => toggleAlighting(selection.alightingStopId ?? "")
                            : undefined
                        }
                        onShowPosition={() =>
                          setDatedJourneyPositionRequest((request) => request + 1)
                        }
                        /* Ending a ride lands at the Ausstieg or the journey's end; stepping up
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
                      stopEvent={selection.selectedStopEvent}
                      /* The address, not the departure, which blinks while boards re-key after a
                         step. */
                      addressId={route.addressId}
                      preferredDestination={selection.preferredDestination}
                      stopEventBoard={selection.stopEventBoard}
                      lineStopEventBoards={selection.lineStopEventBoards}
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
                            journeyParent: route.journeyParent,
                          }),
                        )
                      }
                      alightingStopId={selection.alightingStopId}
                      onToggleAlighting={isRideInView ? toggleAlighting : undefined}
                      datedJourneyPositionRequest={datedJourneyPositionRequest}
                      rideNextCall={rideProgress?.nextCall}
                      isStacked={isNarrowViewport}
                      onRefresh={selection.refreshLine}
                    />
                  </>
                )}
              </section>
            )}
            {layout.hasStopEventBoard && (
              /* Keyed by stop: a line or journey chosen from this board leaves it standing. */
              <StopEventBoardPanel
                key={layout.boardKey}
                panelRef={stopEventPanelRef}
                stop={selectedStop!}
                stopEvents={selection.stopEvents}
                completedLineStopEvents={selection.lineDatedJourneyStopEvents}
                stopEventBoard={selection.stopEventBoard}
                network={network}
                feedNow={feedNow}
                lineSelection={selection.selectedLine ? selection.lineSelection : undefined}
                selectedStopEvent={selection.selectedStopEvent}
                corridorPatterns={stopCorridorPatterns}
                boardingPlaces={stopBoardingPlaces}
                isStacked={isNarrowViewport}
                boardReadingCount={selection.boardReadingCount}
                onRefresh={selection.refreshBoard}
                onPageRefresh={pageRefresh && pagePull.refresh}
              />
            )}
          </>
        )}
      </div>
      <DataProvenanceFooter
        /* Home and settings read nothing, so the footer names the source without a status. */
        {...(activeView === "home" || activeView === "settings"
          ? {}
          : isObservedNetworkInView
            ? { stopEventBoards: observationBoards, coverage: zentrumCoverage }
            : { stopEventBoard: selection.stopEventBoard })}
      />
    </main>
  );
}
