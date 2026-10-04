/**
 * Solves the region plan: the observed network reduced to places and junctions
 * (`src/lib/region-plan.ts`), laid out octilinearly, written to
 * `src/data/generated/region-plan.ts`.
 *
 *     npm run solve:region -- [--from <file>] [--add] [--grid 20] [--spacing 2] [--frame 26x32] [--seed 2] [--steps 400000] [--out <file>]
 *
 * Reads the observation posts once and saves the observed network beside the script, so solves can
 * re-run offline. `--add` merges a new reading into the saved one: lines missing at one hour are
 * caught at another.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { findCatalogStop } from "../src/data/generated/kvv-stop-catalog.ts";
import { KvvEfaClient } from "../src/data/kvv-efa-client.ts";
import { kvvStopMappingByLocalStopId } from "../src/data/kvv-stop-mappings.ts";
import { StopRegistry } from "../src/data/stop-registry.ts";
import type { Departure } from "../src/data/transit-types.ts";
import { createGeoNetworkReader, type GeoNetwork, type GeoStop } from "../src/lib/geo-map.ts";
import {
  REACH_OBSERVATION_POST_STOP_IDS,
  ZENTRUM_OBSERVATION_POST_STOP_IDS,
} from "../src/lib/observed-network.ts";
import {
  extendAxis,
  getZentrumPins,
  projectKm,
  type RegionLayout,
  regionEdgeKey,
  solveRegionLayout,
} from "../src/lib/region-layout.ts";
import { deriveRegionPlan } from "../src/lib/region-plan.ts";
import {
  isRailDeparture,
  ZENTRUM_SCHEMATIC_GRID,
  ZENTRUM_SCHEMATIC_NODES,
} from "../src/lib/zentrum-schematic-plan.ts";
import { chooseLabelSide } from "./octilinear-layout.ts";

const OBSERVATIONS_PATH = "scripts/region-plan-observations.json";
const OUTPUT_PATH = "src/data/generated/region-plan.ts";
const HOME_PLACE_NAME = "Karlsruhe";
/** The axis is the Zentrum row this stop stands on. */
const HOME_STOP_ID = "marktplatz";

type SavedNetwork = {
  capturedAt: string[];
  stops: GeoStop[];
  links: GeoNetwork["links"][number][];
};

const readOption = (flag: string): string | undefined => {
  const index = process.argv.indexOf(flag);
  return index < 0 ? undefined : process.argv[index + 1];
};

/** The posts' boards, read as the app reads them: rail runs with their whole calling sequence. */
async function observe(): Promise<GeoNetwork> {
  const registry = new StopRegistry([]);
  const client = new KvvEfaClient();
  const departures: Departure[] = [];
  for (const stopId of [...ZENTRUM_OBSERVATION_POST_STOP_IDS, ...REACH_OBSERVATION_POST_STOP_IDS]) {
    const mapping = kvvStopMappingByLocalStopId[stopId];
    if (!mapping) continue;
    try {
      const board = await client.fetchDepartureBoard(mapping.providerStopId, {
        limit: 60,
        includeTripCalls: true,
      });
      for (const departure of board.departures) {
        const row: Departure = {
          ...departure,
          id: departure.tripInstanceId ?? departure.tripId ?? departure.lineId,
          boardingLocalStopId: stopId,
          boardingProviderStopPointId: departure.stopPointId,
          boardingProviderStopPointName: departure.stopPointName,
          platformCode: departure.platformCode ?? "",
          tripCalls: registry.toTripCalls(departure.tripCalls ?? []),
        };
        if (isRailDeparture(row)) departures.push(row);
      }
    } catch (error) {
      console.error(`! ${stopId} did not answer: ${(error as Error).message}`);
    }
  }
  const read = createGeoNetworkReader((call) => {
    const stop = call.providerStopPointId ? findCatalogStop(call.providerStopPointId) : undefined;
    return stop && { latitude: stop.latitude, longitude: stop.longitude };
  });
  return read(departures);
}

const toSaved = (network: GeoNetwork, capturedAt: string[]): SavedNetwork => ({
  capturedAt,
  stops: [...network.stops.values()].sort((left, right) => left.id.localeCompare(right.id)),
  links: [...network.links].sort((left, right) => left.id.localeCompare(right.id)),
});

/** Two readings as one: every stop and link of either, with the lines of both. */
function merge(saved: SavedNetwork, network: GeoNetwork): GeoNetwork {
  const stops = new Map(saved.stops.map((stop) => [stop.id, stop]));
  for (const stop of network.stops.values()) {
    const known = stops.get(stop.id);
    stops.set(
      stop.id,
      known ? { ...known, lineIds: [...new Set([...known.lineIds, ...stop.lineIds])] } : stop,
    );
  }
  const links = new Map(saved.links.map((link) => [link.id, link]));
  for (const link of network.links) {
    const known = links.get(link.id);
    links.set(
      link.id,
      known ? { ...known, lineIds: [...new Set([...known.lineIds, ...link.lineIds])] } : link,
    );
  }
  return { stops, links: [...links.values()] };
}

async function main(): Promise<void> {
  const from = readOption("--from");
  const grid = Number(readOption("--grid") ?? 20);
  const seed = Number(readOption("--seed") ?? 2);

  let saved: SavedNetwork;
  if (from) {
    saved = JSON.parse(readFileSync(from, "utf8"));
  } else {
    const observed = await observe();
    const now = new Date().toISOString();
    const previous =
      process.argv.includes("--add") && existsSync(OBSERVATIONS_PATH)
        ? (JSON.parse(readFileSync(OBSERVATIONS_PATH, "utf8")) as SavedNetwork)
        : undefined;
    saved = previous
      ? toSaved(merge(previous, observed), [...previous.capturedAt, now])
      : toSaved(observed, [now]);
    writeFileSync(OBSERVATIONS_PATH, `${JSON.stringify(saved, null, 2)}\n`);
  }
  const network: GeoNetwork = {
    stops: new Map(saved.stops.map((stop) => [stop.id, stop])),
    links: saved.links,
  };
  const plan = deriveRegionPlan(network, HOME_PLACE_NAME);
  console.log(
    `${network.stops.size} stops, ${network.links.length} links -> ${plan.nodes.length} nodes, ${plan.edges.length} edges`,
  );
  for (const node of [...plan.nodes].sort((left, right) => left.label.localeCompare(right.label))) {
    console.log(`  ${node.label.padEnd(34)} ${node.id.padEnd(40)} ${node.stopIds.length} stops`);
  }
  if (process.argv.includes("--nodes-only")) return;

  const layoutNodes = plan.nodes.map((node) => {
    const stop = network.stops.get(node.id);
    return { id: node.id, latitude: stop?.latitude ?? 0, longitude: stop?.longitude ?? 0 };
  });
  const edges = plan.edges.map(({ fromId, toId, lineIds }) => ({
    from: fromId,
    to: toId,
    lineIds,
  }));
  const pins = getZentrumPins(
    plan.nodes.map(({ id }) => id),
    ZENTRUM_SCHEMATIC_NODES,
    ZENTRUM_SCHEMATIC_GRID,
  );
  const home = layoutNodes.find(({ id }) => id === HOME_STOP_ID);
  const homePin = pins.get(HOME_STOP_ID);
  if (!home || !homePin) throw new Error(`${HOME_STOP_ID} is not on both plans`);
  const placeById = new Map(plan.nodes.map((node) => [node.id, node.placeName]));
  const axis = extendAxis(
    [...pins]
      .filter(([, point]) => point.y === homePin.y)
      .sort(([, left], [, right]) => left.x - right.x)
      .map(([id]) => id),
    edges,
    new Map(layoutNodes.map((node) => [node.id, projectKm(node, home)])),
    (id) => (placeById.get(id) ?? HOME_PLACE_NAME) === HOME_PLACE_NAME,
  );
  console.log(`axis: ${axis.join(" – ")}`);
  const [frameX, frameY] = (readOption("--frame") ?? "26x32").split("x").map(Number);
  const layout = solveRegionLayout({
    nodes: layoutNodes,
    edges,
    pins,
    axis,
    homeId: HOME_STOP_ID,
    grid,
    spacing: Number(readOption("--spacing") ?? 2),
    frame: { x: frameX, y: frameY },
    seed,
    ...(readOption("--steps") ? { steps: Number(readOption("--steps")) } : {}),
  });
  console.log(`  ${layout.bends.size} bends, cost ${layout.cost}`);
  if (layout.faults.length > 0) {
    console.error(`  ${layout.faults.length} faults remain:`);
    for (const fault of layout.faults) console.error(`    ${fault}`);
    console.error(
      "No arrangement without faults was found. Try another --seed or a larger --frame.",
    );
    process.exitCode = 1;
    return;
  }
  const outputPath = readOption("--out") ?? OUTPUT_PATH;
  writeFileSync(outputPath, formatPlan(plan, layout, grid, saved.capturedAt));
  console.log(`-> ${outputPath}`);
}

const edgesOf = (plan: ReturnType<typeof deriveRegionPlan>) =>
  plan.edges.map(({ fromId, toId }) => ({ from: fromId, to: toId }));

function formatPlan(
  plan: ReturnType<typeof deriveRegionPlan>,
  layout: RegionLayout,
  grid: number,
  capturedAt: readonly string[],
): string {
  const nodes = plan.nodes
    .map((node) => {
      const point = layout.positions.get(node.id) ?? { x: 0, y: 0 };
      const labelSide = chooseLabelSide(node.id, layout.positions, edgesOf(plan));
      return { ...node, x: point.x, y: point.y, labelSide };
    })
    .sort((left, right) => left.y - right.y || left.x - right.x);
  const edges = [...plan.edges]
    .map((edge) => {
      const via = layout.bends.get(regionEdgeKey({ from: edge.fromId, to: edge.toId }));
      return via ? { ...edge, via } : edge;
    })
    .sort(
      (left, right) =>
        left.fromId.localeCompare(right.fromId) || left.toId.localeCompare(right.toId),
    );
  return `// Generated by scripts/solve-region-plan.ts — do not edit by hand.
//
// Observed ${capturedAt.join(", ")}.
//
// Refresh with: npm run solve:region

import type { RegionPlan } from "../../lib/region-plan";

export const REGION_PLAN: RegionPlan = ${JSON.stringify(
    { grid, viewBox: layout.viewBox, nodes, edges },
    null,
    2,
  )};
`;
}

await main();
