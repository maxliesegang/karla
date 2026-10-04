import assert from "node:assert/strict";
import test from "node:test";
import type { TripCall } from "../src/data/transit-types.ts";
import { getDirectTravelTimes } from "../src/lib/direct-travel-times.ts";
import {
  createGeoNetworkReader,
  getGeoDestinationLabels,
  getGeoPlaces,
  getGeoStopId,
  placeGeoLabels,
  projectGeoPosition,
} from "../src/lib/geo-map.ts";
import { createDeparture } from "./support/fixtures.ts";

const at = (minute: number) => `2026-10-04T12:${String(minute).padStart(2, "0")}:00+02:00`;
const instant = (minute: number) => Date.parse(at(minute));

type CallSpec = {
  id: string;
  minute: number;
  place?: string;
  position?: readonly [number, number];
  isLocal?: boolean;
};

const call = ({
  id,
  minute,
  place = "Karlsruhe",
  position,
  isLocal = true,
}: CallSpec): TripCall => ({
  stopName: `${id} (Gleis 1)`,
  placeName: place,
  ...(isLocal ? { localStopId: id } : {}),
  providerStopPointId: `700${id.length}`,
  ...(position ? { latitude: position[0], longitude: position[1] } : {}),
  scheduledArrivalTime: at(minute),
  scheduledDepartureTime: at(minute),
  delayMinutes: 0,
});

const run = (id: string, lineId: string, calls: readonly CallSpec[]) =>
  createDeparture({ id, tripInstanceId: id, lineId, tripCalls: calls.map(call) });

const MARKTPLATZ: CallSpec = { id: "marktplatz", minute: 1, position: [49.0093, 8.4037] };
const KRONENPLATZ: CallSpec = { id: "kronenplatz", minute: 3, position: [49.0093, 8.411] };
const DURLACH: CallSpec = {
  id: "durlach",
  minute: 12,
  place: "Durlach",
  position: [49.0027, 8.4628],
};
const GROETZINGEN: CallSpec = {
  id: "groetzingen",
  minute: 18,
  place: "Grötzingen (b KA)",
  position: [49.0061, 8.4928],
};

test("draws each stop where the feed locates it, linked to the stops its runs call next", () => {
  const read = createGeoNetworkReader();

  const network = read([
    run("a", "S5", [MARKTPLATZ, KRONENPLATZ, DURLACH]),
    run("b", "1", [MARKTPLATZ, KRONENPLATZ]),
  ]);

  assert.deepEqual([...network.stops.keys()].sort(), ["durlach", "kronenplatz", "marktplatz"]);
  assert.deepEqual(network.stops.get("durlach"), {
    id: "durlach",
    name: "durlach",
    placeName: "Durlach",
    latitude: 49.0027,
    longitude: 8.4628,
    lineIds: ["S5"],
  });
  assert.deepEqual(
    network.links.map(({ fromId, toId, lineIds }) => [fromId, toId, lineIds]),
    [
      ["kronenplatz", "marktplatz", ["S5", "1"]],
      ["durlach", "kronenplatz", ["S5"]],
    ],
  );
});

test("places a stop its runs leave unlocated from elsewhere, or links across it", () => {
  const unlocatedKronenplatz = { ...KRONENPLATZ, position: undefined };
  const read = createGeoNetworkReader((stop) =>
    stop.localStopId === "kronenplatz" ? { latitude: 49.0093, longitude: 8.411 } : undefined,
  );
  const placed = read([run("a", "S5", [MARKTPLATZ, unlocatedKronenplatz, DURLACH])]);
  assert.equal(placed.stops.get("kronenplatz")?.longitude, 8.411);

  const bridged = createGeoNetworkReader(() => undefined)([
    run("a", "S5", [MARKTPLATZ, unlocatedKronenplatz, DURLACH]),
  ]);
  assert.equal(bridged.stops.has("kronenplatz"), false);
  assert.deepEqual(
    bridged.links.map(({ id }) => id),
    ["durlach\u0000marktplatz"],
  );
});

test("keeps what it has drawn after the run that showed it is gone", () => {
  const read = createGeoNetworkReader();
  read([run("a", "S5", [MARKTPLATZ, KRONENPLATZ, DURLACH])]);

  const later = read([run("b", "1", [MARKTPLATZ, KRONENPLATZ])]);

  assert.equal(later.stops.has("durlach"), true);
  assert.equal(later.links.length, 2);
});

test("names a stop the feed resolved to no local stop by its provider id", () => {
  assert.equal(getGeoStopId(call({ ...DURLACH, isLocal: false })), "7007");
  assert.equal(getGeoStopId(call(DURLACH)), "durlach");
});

test("anchors each place at the middle of its stops", () => {
  const network = createGeoNetworkReader()([
    run("a", "S5", [
      MARKTPLATZ,
      DURLACH,
      { id: "untermuehl", minute: 11, place: "Durlach", position: [49.0019, 8.456] },
      GROETZINGEN,
    ]),
  ]);

  const places = getGeoPlaces(network);

  const durlach = places.find(({ name }) => name === "Durlach");
  assert.equal(durlach?.stopCount, 2);
  assert.ok(Math.abs((durlach?.latitude ?? 0) - 49.0023) < 1e-9);
  // The operator's qualifier is dropped.
  assert.ok(places.some(({ name }) => name === "Grötzingen"));
});

test("projects positions to kilometres east and south of Marktplatz", () => {
  const origin = projectGeoPosition({ latitude: 49.0093, longitude: 8.4037 });
  const south = projectGeoPosition({ latitude: 49.0003, longitude: 8.4037 });

  assert.ok(Math.abs(origin.x) < 1e-9 && Math.abs(origin.y) < 1e-9);
  assert.ok(Math.abs(south.y - 1.0) < 0.01);
});

test("reaches stops beyond any plan, on the soonest direct tram", () => {
  const runs = [
    run("slow", "S5", [MARKTPLATZ, KRONENPLATZ, DURLACH, GROETZINGEN]),
    run("fast", "1", [
      { ...MARKTPLATZ, minute: 2 },
      { ...KRONENPLATZ, minute: 4 },
      { ...DURLACH, minute: 10 },
    ]),
  ];

  const times = getDirectTravelTimes(runs, "marktplatz", instant(0), "arrival", getGeoStopId);

  assert.equal(times.get("durlach")?.lineId, "1");
  assert.deepEqual(times.get("groetzingen"), {
    arrivesAt: instant(18),
    lineId: "S5",
    departsAt: instant(1),
    stopIds: ["marktplatz", "kronenplatz", "durlach", "groetzingen"],
  });
});

test("labels the end of each way and the first stop in each place before the rest", () => {
  const runs = [run("a", "S5", [MARKTPLATZ, KRONENPLATZ, DURLACH, GROETZINGEN])];
  const network = createGeoNetworkReader()(runs);
  const times = getDirectTravelTimes(runs, "marktplatz", instant(0), "arrival", getGeoStopId);

  const labels = getGeoDestinationLabels(network, times, instant(0));

  assert.deepEqual(
    labels.map(({ stopId, minutes }) => [stopId, minutes]),
    [
      ["groetzingen", 18],
      ["durlach", 12],
      ["kronenplatz", 3],
    ],
  );
});

test("sets labels by priority, beside their point, and drops those with no room", () => {
  const box = { width: 40, height: 10 };
  const placed = placeGeoLabels([
    { id: "first", x: 0, y: 0, ...box },
    { id: "crowded", x: 2, y: 0, ...box },
    { id: "apart", x: 200, y: 0, ...box },
  ]);

  assert.equal(placed.get("first"), "right");
  assert.equal(placed.has("apart"), true);
  // Beside "first" every side overlaps either it or its label.
  assert.equal(placed.has("crowded"), false);
});
