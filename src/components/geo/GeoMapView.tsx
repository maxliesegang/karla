import { useMemo, useState } from "react";
import { findCatalogStop } from "../../data/generated/kvv-stop-catalog";
import type { DepartureBoard, DepartureBoardCoverage, TripCall } from "../../data/transit-types";
import { useZentrumVehicles } from "../../hooks/zentrum-vehicles";
import { getDirectTravelTimes } from "../../lib/direct-travel-times";
import {
  createGeoNetworkReader,
  getGeoBounds,
  getGeoPlaces,
  getGeoStopId,
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
const locateCatalogStop = (call: TripCall) => {
  const stop = call.providerStopPointId ? findCatalogStop(call.providerStopPointId) : undefined;
  return stop && { latitude: stop.latitude, longitude: stop.longitude };
};

const MARKTPLATZ_POINT = { x: 0, y: 0 };

/** Opens on Karlsruhe from Knielingen to Durlach; zooms until a city block fills a thumb. */
const GEO_MAP_SCALE = { openingSpan: 9, maximumScale: 900 };

/**
 * The geographic map: the stops the Zentrum's posts see runs call, at their real positions, to the
 * runs' ends. An opened stop lights its direct rides with minutes to arrival.
 */
export function GeoMapView({
  network,
  coverage,
  departureBoards,
  selectedStopId,
  isFullscreen,
}: {
  network: ObservedNetwork;
  coverage: DepartureBoardCoverage;
  departureBoards: readonly DepartureBoard[];
  /** The opened stop, as the address names it. */
  selectedStopId?: string;
  isFullscreen: boolean;
}) {
  // The Zentrum's runs: the same readings, drawn another way.
  const { runDepartures, feedNow } = useZentrumVehicles(departureBoards);
  const [readNetwork] = useState(() => createGeoNetworkReader(locateCatalogStop));
  const geo = useMemo(() => readNetwork(runDepartures), [readNetwork, runDepartures]);
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
        ? getDirectTravelTimes(runDepartures, openedStopId, feedNow, "arrival", getGeoStopId)
        : undefined,
    [openedStopId, runDepartures, feedNow],
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
        homePoint={MARKTPLATZ_POINT}
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
