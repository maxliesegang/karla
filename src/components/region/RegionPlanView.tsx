import { useMemo } from "react";
import { kvvStopCatalog } from "../../data/generated/kvv-stop-catalog";
import { REGION_PLANS } from "../../data/generated/region-plan";
import type { DepartureBoard, DepartureBoardCoverage } from "../../data/transit-types";
import { useStoredPreference } from "../../hooks/stored-preference";
import { useDailyZentrumVehicles } from "../../hooks/zentrum-vehicles";
import { getDirectTravelTimes } from "../../lib/direct-travel-times";
import { getGeoLinkId, getGeoStopId, getPointsBox, type MapDrawing } from "../../lib/geo-map";
import type { ObservedNetwork } from "../../lib/observed-network";
import {
  REGION_HOME_PLACE_NAME,
  type RegionPlan,
  type RegionScaleName,
} from "../../lib/region-plan";
import { createStoredPreference } from "../../lib/stored-preference";
import { ExperimentMapPage } from "../experiment/ExperimentMapPage";
import { ObservationEmptyState } from "../ObservationEmptyState";
import { SegmentedControl } from "../SegmentedControl";
import { createZentrumLineSignReader } from "../zentrum/line-sign";

const regionPageHeading = <h1 className="visually-hidden">Experimente: Regionsplan</h1>;

const regionEmptyLabels = {
  loading: "Haltestellen werden geladen …",
  unavailable: "Plan derzeit nicht abrufbar",
  empty: "Derzeit keine Fahrten beobachtet",
};

const REGION_SCALE_CHOICES = [
  { value: "fisheye", label: "Fischauge" },
  { value: "zones", label: "Zonen" },
  { value: "arms", label: "Äste" },
] as const satisfies readonly { value: RegionScaleName; label: string }[];

const regionScalePreference = createStoredPreference<RegionScaleName>({
  key: "karla:region-scale",
  parse: (stored) => REGION_SCALE_CHOICES.find(({ value }) => value === stored)?.value ?? "fisheye",
});

/**
 * The city's places as the feed names them: Karlsruhe and its districts, which the catalog names
 * with a note such as "Neureut (Karlsruhe)" or "Grötzingen (b KA)".
 */
const CITY_PLACE_NAMES = new Set(
  kvvStopCatalog.map(({ placeName }) => placeName.replace(/\s*\(.*\)$/, "")),
);

/** One solved plan as the map draws it. */
function readRegionPlan(plan: RegionPlan) {
  const nodeIdByStopId = new Map(
    plan.nodes.flatMap((node) => node.stopIds.map((stopId) => [stopId, node.id] as const)),
  );
  const drawing: MapDrawing = {
    stops: new Map(
      plan.nodes.map((node) => [
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
    links: plan.edges.map((edge) => ({
      id: getGeoLinkId(edge.fromId, edge.toId),
      fromId: edge.fromId,
      toId: edge.toId,
      lineIds: edge.lineIds,
      ...(edge.bends ? { bends: edge.bends } : {}),
    })),
  };
  const linkCountByNodeId = new Map<string, number>();
  for (const { fromId, toId } of plan.edges) {
    for (const id of [fromId, toId])
      linkCountByNodeId.set(id, (linkCountByNodeId.get(id) ?? 0) + 1);
  }
  const axis = new Set(plan.axis);
  // Named at rest: Karlsruhe, the axis and the ends. Every other place waits for a pointer.
  const quietNodeIds = new Set(
    plan.nodes
      .filter(
        ({ id, placeName }) =>
          placeName !== undefined &&
          placeName !== REGION_HOME_PLACE_NAME &&
          !axis.has(id) &&
          linkCountByNodeId.get(id) !== 1,
      )
      .map(({ id }) => id),
  );
  // Opens on the city with its districts; zooms until neighbouring nodes stand a thumb apart.
  const scale = {
    opening:
      getPointsBox(
        plan.nodes.filter(({ placeName }) => placeName && CITY_PLACE_NAMES.has(placeName)),
        plan.grid * 2,
      ) ?? plan.viewBox,
    maximumScale: 6,
  };
  return { plan, nodeIdByStopId, drawing, quietNodeIds, scale };
}

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
  // The Zentrum's runs on daily lines: the same readings, drawn another way.
  const { runDepartures, feedNow } = useDailyZentrumVehicles(departureBoards);
  const getSign = useMemo(() => createZentrumLineSignReader(network.lines), [network.lines]);
  const scaleName = useStoredPreference(regionScalePreference);
  const { plan, nodeIdByStopId, drawing, quietNodeIds, scale } = useMemo(
    () => readRegionPlan(REGION_PLANS[scaleName]),
    [scaleName],
  );
  const openedNodeId =
    selectedStopId && drawing.stops.has(selectedStopId) ? selectedStopId : undefined;
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
    [openedNodeId, runDepartures, feedNow, nodeIdByStopId],
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
        key={scaleName}
        drawing={drawing}
        bounds={plan.viewBox}
        scale={scale}
        selectedStopId={selectedStopId}
        times={times}
        feedNow={feedNow}
        getSign={getSign}
        isAnswered
        isFullscreen={isFullscreen}
        quietStopIds={quietNodeIds}
        zones={plan.zones}
        options={
          <SegmentedControl
            className="departure-board-order-control"
            value={scaleName}
            items={REGION_SCALE_CHOICES}
            onValueChange={(next) => regionScalePreference.write(next)}
            ariaLabel="Maßstab"
          />
        }
        overviewCaption={`${drawing.stops.size} Orte und Knoten · antippen`}
      />
    </>
  );
}
