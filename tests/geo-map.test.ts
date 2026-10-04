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
  toRoundedPath,
  toOctagon,
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

test("keeps a name off the drawn lines while one side of its point is clear", () => {
  const placed = placeGeoLabels([{ id: "europaplatz", x: 100, y: 100, width: 60, height: 14 }], {
    lines: [{ from: { x: 0, y: 100 }, to: { x: 300, y: 100 }, halfWidth: 6 }],
  });
  assert.equal(placed.get("europaplatz"), "above");
});

test("sets a name over a line rather than leave it out, when every side crosses one", () => {
  const placed = placeGeoLabels([{ id: "marktplatz", x: 100, y: 100, width: 60, height: 14 }], {
    lines: [
      { from: { x: 0, y: 100 }, to: { x: 300, y: 100 }, halfWidth: 6 },
      { from: { x: 100, y: 0 }, to: { x: 100, y: 300 }, halfWidth: 6 },
    ],
  });
  assert.equal(placed.get("marktplatz"), "right");
});

test("keeps names inside the map", () => {
  const placed = placeGeoLabels([{ id: "heilbronn", x: 290, y: 50, width: 60, height: 14 }], {
    frame: { left: 0, top: 0, right: 300, bottom: 300 },
  });
  assert.equal(placed.get("heilbronn"), "left");
});

test("keeps a name clear of the next dot, so two names never read as one", () => {
  const placed = placeGeoLabels([{ id: "hauptbahnhof", x: 0, y: 0, width: 40, height: 14 }], {
    dots: [
      { x: 0, y: 0 },
      { x: 48, y: 0 },
    ],
  });
  assert.notEqual(placed.get("hauptbahnhof"), "right");
  assert.equal(placed.has("hauptbahnhof"), true);
});

test("sets a name beyond a wide bundle, off the lines it would otherwise cover", () => {
  const placed = placeGeoLabels(
    [{ id: "europaplatz", x: 100, y: 100, width: 60, height: 14, gap: 16 }],
    {
      lines: [
        { from: { x: 0, y: 100 }, to: { x: 300, y: 100 }, halfWidth: 14 },
        { from: { x: 100, y: 100 }, to: { x: 100, y: 300 }, halfWidth: 14 },
      ],
    },
  );
  assert.equal(placed.get("europaplatz"), "above");
});

test("rounds a way's bend by a radius, never past half its shorter leg", () => {
  assert.equal(
    toRoundedPath(
      [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
      ],
      2,
    ),
    "M0 0L8 0Q10 0 10 2L10 10",
  );
  assert.equal(
    toRoundedPath(
      [
        { x: 0, y: 0 },
        { x: 2, y: 0 },
        { x: 2, y: 10 },
      ],
      4,
    ),
    "M0 0L1 0Q2 0 2 1L2 10",
  );
  assert.equal(
    toRoundedPath(
      [
        { x: 0, y: 0 },
        { x: 5, y: 5 },
      ],
      4,
    ),
    "M0 0L5 5",
  );
});

test("outlines a zone as an octagon whose sides stand its radius from the centre", () => {
  const corners = toOctagon({ x: 10, y: 10 }, 4);
  assert.equal(corners.length, 8);
  const xs = corners.map(({ x }) => x);
  const ys = corners.map(({ y }) => y);
  assert.ok(Math.abs(Math.max(...xs) - 14) < 1e-9 && Math.abs(Math.min(...ys) - 6) < 1e-9);
  // Every other side is a diagonal at the same distance.
  const onDiagonal = (point: { x: number; y: number }) =>
    Math.abs(point.x - 10 + (point.y - 10)) / Math.SQRT2;
  assert.ok(Math.abs(onDiagonal(corners[1]) - 4) < 1e-9);
  assert.ok(Math.abs(onDiagonal(corners[2]) - 4) < 1e-9);
});
