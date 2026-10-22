import { useMemo, useState } from "react";
import { findCatalogStop, kvvStopCatalog } from "../../data/generated/kvv-stop-catalog";
import type { StopEventBoard, StopEventBoardCoverage, Call } from "../../data/transit-types";
import { useDailyZentrumVehicles } from "../../hooks/zentrum-vehicles";
import { getDirectTravelTimes } from "../../lib/direct-travel-times";
import {
  createGeoNetworkReader,
  getGeoBounds,
  getGeoPlaces,
  getGeoStopId,
  getPointsBox,
  projectGeoPosition,
  toGeoDrawing,
} from "../../lib/geo-map";
import type { ObservedNetwork } from "../../lib/observed-network";
import { ExperimentMapPage } from "../experiment/ExperimentMapPage";
import { ObservationEmptyState } from "../ObservationEmptyState";
import { createZentrumLineSignReader } from "../zentrum/line-sign";

const geoPageHeading = <h1 className="visually-hidden">Experimente: Geografische Karte</h1>;

const geoEmptyLabels = {
  loading: "Haltestellen werden geladen …",
  unavailable: "Karte derzeit nicht abrufbar",
  empty: "Derzeit keine Fahrten beobachtet",
};

/** A board's own call comes unlocated; the operator's catalog knows the city's stops. */
const locateCatalogStop = (call: Call) => {
  const stop = call.providerStopPointId ? findCatalogStop(call.providerStopPointId) : undefined;
  return stop && { latitude: stop.latitude, longitude: stop.longitude };
};

/**
 * Opens on the city, every district a line serves, from Knielingen to Grötzingen and Neureut to
 * Wettersbach; zooms until a city block fills a thumb.
 */
const GEO_MAP_SCALE = {
  opening: getPointsBox(
    kvvStopCatalog.filter(({ lineCount }) => lineCount > 0).map(projectGeoPosition),
    0.5,
  ) ?? { x: -8, y: -6, width: 16, height: 13 },
  maximumScale: 900,
};

/**
 * The geographic map: the stops the Zentrum's posts see dated journeys call, at their real
 * positions, to the dated journeys' ends. An opened stop lights its direct rides with minutes to
 * arrival.
 */
export function GeoMapView({
  network,
  coverage,
  stopEventBoards,
  selectedStopId,
  isFullscreen,
}: {
  network: ObservedNetwork;
  coverage: StopEventBoardCoverage;
  stopEventBoards: readonly StopEventBoard[];
  /** The opened stop, as the address names it. */
  selectedStopId?: string;
  isFullscreen: boolean;
}) {
  // The Zentrum's dated journeys on daily lines: the same readings, drawn another way.
  const { datedJourneyStopEvents, feedNow } = useDailyZentrumVehicles(stopEventBoards);
  const [readNetwork] = useState(() => createGeoNetworkReader(locateCatalogStop));
  const geo = useMemo(
    () => readNetwork(datedJourneyStopEvents),
    [readNetwork, datedJourneyStopEvents],
  );
  const drawing = useMemo(() => toGeoDrawing(geo), [geo]);
  const places = useMemo(
    () => getGeoPlaces(geo).map((place) => ({ name: place.name, ...projectGeoPosition(place) })),
    [geo],
  );
  const bounds = useMemo(() => getGeoBounds(geo), [geo]);
  const getSign = useMemo(() => createZentrumLineSignReader(network.lines), [network.lines]);
  const openedStopId = selectedStopId && geo.stops.has(selectedStopId) ? selectedStopId : undefined;
  const times = useMemo(
    () =>
      openedStopId
        ? getDirectTravelTimes(
            datedJourneyStopEvents,
            openedStopId,
            feedNow,
            "arrival",
            getGeoStopId,
          )
        : undefined,
    [openedStopId, datedJourneyStopEvents, feedNow],
  );

  if (network.stops.length === 0) {
    return (
      <>
        {geoPageHeading}
        <ObservationEmptyState coverage={coverage} labels={geoEmptyLabels} />
      </>
    );
  }
  return (
    <>
      {geoPageHeading}
      <ExperimentMapPage
        map="geo"
        label="Geografische Karte"
        drawing={drawing}
        places={places}
        bounds={bounds}
        scale={GEO_MAP_SCALE}
        selectedStopId={selectedStopId}
        times={times}
        feedNow={feedNow}
        getSign={getSign}
        isAnswered={geo.stops.size > 0}
        isFullscreen={isFullscreen}
        overviewCaption={`${geo.stops.size} Halte an ihrer echten Lage · Haltestelle antippen`}
      />
    </>
  );
}
