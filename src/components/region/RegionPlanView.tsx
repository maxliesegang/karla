import { useMemo } from "react";
import { REGION_PLAN } from "../../data/generated/region-plan";
import type { DepartureBoard, DepartureBoardCoverage } from "../../data/transit-types";
import { useZentrumVehicles } from "../../hooks/zentrum-vehicles";
import { getDirectTravelTimes } from "../../lib/direct-travel-times";
import { getGeoLinkId, getGeoStopId, type MapDrawing } from "../../lib/geo-map";
import type { ObservedNetwork } from "../../lib/observed-network";
import { zentrumSchematicNodeById } from "../../lib/zentrum-schematic-plan";
import { ExperimentMapPage } from "../experiment/ExperimentMapPage";
import { ObservationEmptyState } from "../ObservationEmptyState";
import { createZentrumLineSignReader } from "../zentrum/line-sign";

const regionPageHeading = <h1 className="visually-hidden">Experimente: Regionsplan</h1>;

const regionEmptyLabels = {
  loading: "Haltestellen werden geladen …",
  unavailable: "Plan derzeit nicht abrufbar",
  empty: "Derzeit keine Fahrten beobachtet",
};

/** Opens on the Zentrum's stops; zooms until neighbouring nodes stand a thumb apart. */
const REGION_PLAN_SCALE = { openingSpan: REGION_PLAN.grid * 36, maximumScale: 6 };

const nodeIdByStopId = new Map(
  REGION_PLAN.nodes.flatMap((node) => node.stopIds.map((stopId) => [stopId, node.id] as const)),
);

const regionDrawing: MapDrawing = {
  stops: new Map(
    REGION_PLAN.nodes.map((node) => [
      node.id,
      {
        id: node.id,
        name: node.label,
        placeName: node.placeName,
        lineIds: node.lineIds,
        x: node.x,
        y: node.y,
      },
    ]),
  ),
  links: REGION_PLAN.edges.map((edge) => ({
    id: getGeoLinkId(edge.fromId, edge.toId),
    fromId: edge.fromId,
    toId: edge.toId,
    lineIds: edge.lineIds,
    ...(edge.via ? { via: edge.via } : {}),
  })),
};

const zentrumNodes = REGION_PLAN.nodes.filter(({ id }) => zentrumSchematicNodeById.has(id));
/** The middle of the Zentrum's stops, which the plan pins as the Zentrum plan draws them. */
const ZENTRUM_MIDDLE =
  zentrumNodes.length > 0
    ? {
        x:
          (Math.min(...zentrumNodes.map(({ x }) => x)) +
            Math.max(...zentrumNodes.map(({ x }) => x))) /
          2,
        y:
          (Math.min(...zentrumNodes.map(({ y }) => y)) +
            Math.max(...zentrumNodes.map(({ y }) => y))) /
          2,
      }
    : { x: REGION_PLAN.viewBox.width / 2, y: REGION_PLAN.viewBox.height / 2 };

/**
 * The region plan: every place the observed lines reach, and the city's junctions, on a solved
 * octilinear drawing. An opened node lights its direct rides; stops the plan leaves out are ridden
 * past.
 */
export function RegionPlanView({
  network,
  coverage,
  departureBoards,
  selectedStopId,
  isFullscreen,
}: {
  network: ObservedNetwork;
  coverage: DepartureBoardCoverage;
  departureBoards: readonly DepartureBoard[];
  /** The opened node, as the address names it. */
  selectedStopId?: string;
  isFullscreen: boolean;
}) {
  // The Zentrum's runs: the same readings, drawn another way.
  const { runDepartures, feedNow } = useZentrumVehicles(departureBoards);
  const getSign = useMemo(() => createZentrumLineSignReader(network.lines), [network.lines]);
  const openedNodeId =
    selectedStopId && regionDrawing.stops.has(selectedStopId) ? selectedStopId : undefined;
  const times = useMemo(
    () =>
      openedNodeId
        ? getDirectTravelTimes(
            runDepartures,
            openedNodeId,
            feedNow,
            "arrival",
            (call) => nodeIdByStopId.get(getGeoStopId(call)),
            true,
          )
        : undefined,
    [openedNodeId, runDepartures, feedNow],
  );

  if (network.stops.length === 0) {
    return (
      <>
        {regionPageHeading}
        <ObservationEmptyState coverage={coverage} labels={regionEmptyLabels} />
      </>
    );
  }
  return (
    <>
      {regionPageHeading}
      <ExperimentMapPage
        map="region"
        label="Regionsplan"
        drawing={regionDrawing}
        bounds={REGION_PLAN.viewBox}
        scale={REGION_PLAN_SCALE}
        homePoint={ZENTRUM_MIDDLE}
        selectedStopId={selectedStopId}
        times={times}
        feedNow={feedNow}
        getSign={getSign}
        isAnswered
        isFullscreen={isFullscreen}
        linesAtRest
        overviewCaption={`${regionDrawing.stops.size} Orte und Knoten · antippen`}
      />
    </>
  );
}
