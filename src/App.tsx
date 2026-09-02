import { useMemo, useRef, useState } from "react";
import { ZentrumView } from "./components/ZentrumView";
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
import {
  useZentrumNetwork,
  useAppRoute,
  useFeedNow,
  useInitialLanding,
  useIsNarrowViewport,
  useStationBoardReload,
  useLocatableStops,
  useNearbyStops,
  useRidePosition,
  useServiceNotices,
  useStopRecall,
  usePanelChange,
  useStopCorridorPatterns,
  useStopTopologyBoard,
  useTransitNetwork,
  useViewShortcuts,
} from "./hooks";
import { useSelectionChain } from "./selection";
import { getTripProgress } from "./lib/trip-progress";
import { classNames } from "./lib/class-names";
import { findNoticesForStop } from "./lib/service-notices";
import {
  stationBoardConfig,
  getDepartureRouteId,
  getSelectionPath,
  isStationBoardMode,
  routePaths,
  navigateTo,
} from "./routing";
import { findLineBundleOffers } from "./lib/line-bundles";
import {
  getDashboardClassNames,
  getViewLayout,
  readsObservedNetwork,
  isStationBoardStopView,
} from "./view-layout";

export default function App() {
  const departurePanelRef = useRef<HTMLElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [tripPositionRequest, setTripPositionRequest] = useState(0);
  const [nearbyReturnStopId, setNearbyReturnStopId] = useState<string>();
  const route = useAppRoute();
  const isNarrowViewport = useIsNarrowViewport();
  // Which views are in play at all is `view-layout.ts`'s question; the two answers the data hooks
  // need are asked before the selection resolves, because they decide what is fetched. One
  // observation cycle feeds the running-line list and whichever primary panel is visible, which
  // keeps the shell and the Zentrum view consistent; its cadence is decided by whether anything in
  // view actually reads from it. A diagram's vehicle marks used to, which is what held it at the
  // fast cadence; they are read from the line's own filtered boards now, which see more of the line.
  const isStationBoardView = isStationBoardStopView(route.view, isStationBoardMode);
  const isObservedNetworkInView = readsObservedNetwork(route.view);
  const {
    network: observedNetwork,
    departureBoards: observationBoards,
    coverage: zentrumCoverage,
  } = useZentrumNetwork({ isEnabled: !isStationBoardView, isInView: isObservedNetworkInView });
  const network = useTransitNetwork(observedNetwork);
  // Stop, line and trip are each resolved against live data and the address rewritten to whatever
  // still resolved; the shell only picks a panel for the result.
  const selection = useSelectionChain(route, network, observationBoards);
  const { selectedStop } = selection;
  const stopTopologyBoard = useStopTopologyBoard(
    route.view === "stop" && !route.lineId && !isStationBoardView ? selectedStop?.id : undefined,
  );
  // The line's own boards teach this stop's memory too: their trips carry complete sequences read
  // at this very stop, and they arrive in the one view the topology board is deliberately not asked
  // for. This costs no request — the boards are already in hand — and it is what lets a corridor
  // stay grouped, and a bundled sibling stay offered, while a line is being read.
  const stopTopologyBoards = useMemo(
    () => [...selection.lineDepartureBoards, ...observationBoards],
    [observationBoards, selection.lineDepartureBoards],
  );
  const stopCorridorPatterns = useStopCorridorPatterns(
    route.view === "stop" ? selectedStop?.id : undefined,
    stopTopologyBoard,
    stopTopologyBoards,
  );
  // Which siblings this stop's corridor could be read with. Derived from what the visit has already
  // observed, so the offer appears where the evidence for it does — a rider who came through the
  // stop's own board has it in hand — and never costs a reading of its own.
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
  // Watched only while a ride is being read, which is the only view that has a use for it.
  const ridePosition = useRidePosition(route.isRide && !isStationBoardMode);
  // A board mounted at one stop has no use for what the operator published about the rest of the
  // network, and asking for it every quarter of an hour for the rest of the day would buy nothing.
  const noticeBoard = useServiceNotices(!isStationBoardView);
  // Only a stop the rider actually read is remembered — never one they passed through on a ride.
  const { recentStopId, recentStops } = useStopRecall(
    route.view === "stop" && !route.isRide ? selectedStop : undefined,
  );

  // What the resolved address means for the two halves of the dashboard: which is present, which is
  // wide, and — through the keys — what each is showing. Derived before the loading and dead-end
  // returns below, because which half changed is a fact about every render and not only the ones
  // that reach the dashboard.
  const layout = getViewLayout({
    route,
    selection: {
      stopId: selection.stopId,
      lineId: selection.selectedLine?.id,
      tripId: selection.selectedDeparture && getDepartureRouteId(selection.selectedDeparture),
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
  // The app opens on the stop the rider last read, and on the Zentrum for a rider with no history —
  // never on a permission prompt that can say nothing until it has been answered (A1).
  useInitialLanding(!isStationBoardMode, recentStopId);

  const showNearbyStops = (returnStopId?: string) => {
    setNearbyReturnStopId(returnStopId);
    navigateTo(routePaths.nearby());
  };

  if (!network || selection.isStopLoading || selection.isAwaitingLegacyTrip) {
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

  // Selected for the stop in view and disclosed from the stop's own menu — the same selection that
  // used to be counted in the bar and then opened as an unfiltered network list (F7, W7).
  const stopNotices =
    noticeBoard?.dataStatus === "live" && !isStandaloneView && selectedStop
      ? findNoticesForStop(noticeBoard.notices, selectedStop.id, [
          ...selection.departures.map((departure) => departure.lineId),
          ...(selection.selectedLine ? [selection.selectedLine.id] : []),
        ])
      : [];

  // The shell is KVV red by default; while a line is in view it takes that line's sign colour,
  // so the bar, the panel and the badges read as one surface instead of three.
  const shellThemeStyle =
    isLineInView && selection.selectedLine
      ? ({
          "--shell-accent": selection.selectedLine.color,
          "--shell-ink": selection.selectedLine.textColor,
        } as React.CSSProperties)
      : undefined;

  // On board the device is the better witness of where the vehicle is, so the ride reads its own
  // position where the rider has granted one and falls back to the feed's estimate where it cannot
  // — the whole of that decision is in `lib/ride-location.ts`.
  const tripProgress =
    isRideInView && selection.selectedDeparture
      ? getTripProgress(selection.selectedDeparture.tripCalls ?? [], feedNow, {
          alightingStopId: selection.alightingStopId,
          fix: ridePosition.fix,
        })
      : undefined;

  const toggleAlighting = (stopId: string) => {
    if (!selection.selectedDeparture) return;
    const tripId = getDepartureRouteId(selection.selectedDeparture);
    navigateTo(
      routePaths.ride(
        tripId,
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
      )}
      style={shellThemeStyle}
    >
      <AppHeader
        isStationBoardMode={isStationBoardMode}
        backPath={layout.backPath}
        nearbyStopsController={nearbyStopsController}
        currentPageStopId={activeView === "stop" ? selection.stopId : undefined}
        onShowNearbyStops={() => showNearbyStops(selection.stopId)}
      />
      <div
        className={classNames(...getDashboardClassNames(layout))}
        /* Which half of the dashboard this navigation changed. The half that changed carries its own
           entrance, because it is mounted under a new key; this is read only where both changed at
           once, so the board can follow the panel beside it instead of starting with it. */
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
            {/* The half that stands beside the board wherever two panels fit — the selected line's
                diagram — and the whole width on every view that has no board at all. A stop has no
                panel here: its board is the view, and the three orders of that board are the three
                ways it is read. */}
            {layout.hasPrimaryPanel && (
              /* Keyed by what it is showing rather than by how it is being read: another line
                 re-mounts it beside a board that has not moved, while another trip of the same line
                 and another stop on it leave it standing and let the diagram glide. */
              <section className="primary-panel" key={layout.primaryKey}>
                {layout.homeView && (
                  <HomeEntry
                    activeView={layout.homeView}
                    searchInputRef={searchInputRef}
                    recentStops={recentStops}
                  />
                )}
                {activeView === "nearby" && <NearbyStopsView controller={nearbyStopsController} />}
                {activeView === "zentrum" && (
                  <ZentrumView network={observedNetwork} coverage={zentrumCoverage} />
                )}
                {activeView === "network" && (
                  <NetworkView network={network} scope={route.networkScope} />
                )}
                {activeView === "notices" && (
                  <ServiceNoticesView
                    network={network}
                    noticeBoard={noticeBoard}
                    feedNow={feedNow}
                  />
                )}
                {isLineInView && selection.selectedLine && (
                  <>
                    {/* The ride's one permanent surface: what a rider on board is reading, kept above
                      the diagram and out of its scrollport so it cannot scroll away. */}
                    {tripProgress && selection.selectedDeparture && (
                      <RideStatusPanel
                        line={selection.selectedLine}
                        departure={selection.selectedDeparture}
                        tripProgress={tripProgress}
                        feedNow={feedNow}
                        isRetainedObservation={selection.isSelectedDepartureRetained}
                        observedAt={selection.selectedDepartureObservedAt}
                        ridePosition={ridePosition}
                        onClearAlighting={
                          selection.alightingStopId
                            ? () => toggleAlighting(selection.alightingStopId ?? "")
                            : undefined
                        }
                        onShowPosition={() => setTripPositionRequest((request) => request + 1)}
                        /* Ending a ride leaves it behind at the stop it reached — the Ausstieg the
                         rider marked, or failing that where the trip itself ends. That is a
                         different act from stepping up, which returns to where the ride was begun,
                         and the two are spelled differently because they lead to different places. */
                        onEndRide={() =>
                          navigateTo(
                            routePaths.stop(
                              selection.alightingStopId ??
                                tripProgress.finalCall?.localStopId ??
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
                      /* The address, not the reading: the boards behind a trip are all keyed by the
                         stop, so walking along the line loses the departure for as long as they
                         take to answer for the new one. The trip the rider chose is unchanged
                         throughout, and the diagram holds its drawing and its place by it. */
                      tripId={route.tripId}
                      preferredDestination={selection.preferredDestination}
                      departureBoard={selection.departureBoard}
                      lineDepartureBoards={selection.lineDepartureBoards}
                      observationBoards={observationBoards}
                      isRide={selection.isRide}
                      bundledLines={selection.bundledLines}
                      bundleOffers={lineBundleOffers}
                      /* The bundle is a level of the address, so choosing one is navigating to it:
                         the reading a rider arrives at is the reading they can share. */
                      onChangeBundle={(bundledLineIds) =>
                        navigateTo(
                          getSelectionPath({
                            stopId: selection.stopId,
                            lineId: selection.selectedLine?.id,
                            bundledLineIds,
                            tripId: route.tripId,
                          }),
                        )
                      }
                      alightingStopId={selection.alightingStopId}
                      onToggleAlighting={isRideInView ? toggleAlighting : undefined}
                      isStacked={isNarrowViewport}
                      tripPositionRequest={tripPositionRequest}
                      rideNextCall={tripProgress?.nextCall}
                    />
                  </>
                )}
              </section>
            )}
            {layout.hasDepartureBoard && (
              /* The other half of the same rule: another stop is another board, and a line or a
                 trip chosen from this board leaves it standing. */
              <DepartureBoardPanel
                key={layout.boardKey}
                panelRef={departurePanelRef}
                stop={selectedStop!}
                departures={selection.departures}
                completedLineDepartures={selection.lineTripDepartures}
                departureBoard={selection.departureBoard}
                network={network}
                feedNow={feedNow}
                lineSelection={selection.selectedLine ? selection.lineSelection : undefined}
                selectedDepartureId={selection.selectedDeparture?.id}
                corridorPatterns={stopCorridorPatterns}
                isStacked={isNarrowViewport}
                /* What KVV announced about this stop, at the board's foot. It rides the board
                   because that is the list it answers for, and it stays while one of the stop's
                   lines is in view. Its other half used to be a Linien control that scrolled the
                   page here and navigated there — it is gone with the panel it scrolled to, and the
                   lines are now one of this board's own three orders. */
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
        showsNoticesLink={!isStationBoardMode && activeView !== "notices"}
        {...(activeView === "notices"
          ? { serviceNoticeBoard: noticeBoard }
          : isObservedNetworkInView
            ? { departureBoards: observationBoards, coverage: zentrumCoverage }
            : { departureBoard: selection.departureBoard })}
      />
    </main>
  );
}
