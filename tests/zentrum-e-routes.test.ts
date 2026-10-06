import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { KvvTripCall } from "../src/data/kvv-efa-parsers.ts";
import { StopRegistry } from "../src/data/stop-registry.ts";
import { transitNetwork } from "../src/data/transit-network.ts";
import type { TransportMode } from "../src/data/transit-types.ts";
import { buildZentrumSchematicReading } from "../src/lib/zentrum-schematic.ts";
import { getEdgeKey, getLineTrackPoint } from "../src/lib/zentrum-schematic-plan.ts";
import { createDeparture } from "./support/fixtures.ts";

const fixture: {
  runs: {
    tripCode: string;
    line: string;
    transportMode: TransportMode;
    destination: string;
    tripCalls: KvvTripCall[];
  }[];
} = JSON.parse(readFileSync(new URL("./support/zentrum-e-runs.json", import.meta.url), "utf8"));

const expectedStopsByTripCode: Record<string, readonly string[]> = {
  "23": [
    "hauptbahnhof",
    "ebertstrasse",
    "kolpingplatz",
    "mathystrasse",
    "konzerthaus",
    "kongresszentrum",
    "philipp-reis-strasse",
    "ostendstrasse",
    "wolfartsweierer-strasse",
    "schloss-gottesaue",
    "tullastrasse",
  ],
  "1233": [
    "tullastrasse",
    "schloss-gottesaue",
    "wolfartsweierer-strasse",
    "ostendstrasse",
    "philipp-reis-strasse",
    "werderstrasse",
    "tivoli",
  ],
};

for (const run of fixture.runs) {
  test(`draws the observed E run ${run.tripCode} continuously through Philipp-Reis-Straße`, () => {
    const stops = new StopRegistry(transitNetwork.stops);
    const tripCalls = stops.toTripCalls(run.tripCalls);
    const reading = buildZentrumSchematicReading([
      createDeparture({
        id: `${run.line}|${run.tripCode}`,
        lineId: "E",
        transportMode: run.transportMode,
        destination: run.destination,
        tripCalls,
      }),
    ]);
    const expectedStops = expectedStopsByTripCode[run.tripCode];

    assert.deepEqual(
      tripCalls.map(({ localStopId }) => localStopId),
      expectedStops,
    );
    assert.equal(reading.linePaths.length, 1);
    assert.deepEqual(
      reading.linePaths[0].nodes.filter(({ isJunction }) => !isJunction).map(({ id }) => id),
      expectedStops,
    );
    assert.deepEqual(
      reading.stopMarks.map(({ nodeId }) => nodeId).sort(),
      [...expectedStops].sort(),
    );
    assert.ok(!reading.linePaths[0].nodes.some(({ id }) => id.startsWith("exit:")));
  });

  test(`draws E run ${run.tripCode} west–east through Philipp-Reis-Straße's platforms`, () => {
    const stops = new StopRegistry(transitNetwork.stops);
    const reading = buildZentrumSchematicReading([
      createDeparture({
        lineId: "E",
        transportMode: run.transportMode,
        tripCalls: stops.toTripCalls(run.tripCalls),
      }),
    ]);
    const stopId = "philipp-reis-strasse";
    const edges = reading.edges.filter(({ from, to }) => from.id === stopId || to.id === stopId);
    assert.equal(edges.length, 2);
    assert.ok(
      edges.every(({ from, to }) => from.y === to.y),
      "corridors follow the west–east platforms",
    );
    const mark = reading.stopMarks.find(({ nodeId }) => nodeId === stopId)!;
    assert.equal(mark.capsules.length, 1);
    assert.ok(
      mark.capsules.every(({ from, to }) => from.x === to.x),
      "capsule crosses the horizontal tracks",
    );
  });
}

test("keeps through lanes aligned where Stadtbahn lines join between Ebertstraße and Hauptbahnhof", () => {
  const routes = {
    "17": ["ebertstrasse", "hauptbahnhof", "poststrasse", "tivoli"],
    E: ["hauptbahnhof", "ebertstrasse"],
    S1: ["albtalbahnhof", "hauptbahnhof", "poststrasse", "augartenstrasse"],
  };
  const reading = buildZentrumSchematicReading(
    Object.entries(routes).map(([lineId, stops]) =>
      createDeparture({
        id: lineId,
        lineId,
        tripCalls: stops.map((localStopId) => ({ stopName: localStopId, localStopId })),
      }),
    ),
  );
  const junctionId = "junction:418,616";
  const west = reading.edges.find(({ id }) => id === getEdgeKey("ebertstrasse", junctionId))!;
  const east = reading.edges.find(({ id }) => id === getEdgeKey("hauptbahnhof", junctionId))!;
  const junction = west.to;

  for (const trackId of ["E", "17"]) {
    assert.deepEqual(
      getLineTrackPoint(west, junction, trackId, west.trackIds, reading.trackWidth),
      getLineTrackPoint(east, junction, trackId, east.trackIds, reading.trackWidth),
      `${trackId} must keep its lane across the junction`,
    );
  }
  const path = reading.vehiclePathsByLineId
    .get("E")!
    .get(getEdgeKey("ebertstrasse", "hauptbahnhof"))!;
  assert.ok(path.points.every(({ y }) => y === path.points[0].y));
});
