import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { Departure, TripCall } from "../src/data/transit-types.ts";
import { createSchematicBoardingReading } from "../src/lib/schematic-boarding-places.ts";
import { createDeparture } from "./support/fixtures.ts";
import { buildZentrumSchematicReading } from "../src/lib/zentrum-schematic.ts";
const samples: { lineId: string; tripCalls: TripCall[] }[] = JSON.parse(
  readFileSync(new URL("./support/zentrum-stop-platforms.json", import.meta.url), "utf8"),
);
const runs: Departure[] = samples.map((sample, index) =>
  createDeparture({ id: `platform-${index}`, ...sample }),
);

test("a clipped junction retains its distinct boarding places from full neighboring calls", () => {
  const reading = createSchematicBoardingReading(runs);
  const places = reading.placesByStopId.get("tullastrasse")!;
  assert.deepEqual(places.map((p) => p.platformCodes).sort(), [
    ["1a", "1b", "2a", "2b"],
    ["3", "4"],
  ]);
  const north = reading.resolveNodeId(
    runs
      .flatMap((r) => r.tripCalls ?? [])
      .find((c) => c.localStopId === "tullastrasse" && c.platformCode === "4")!,
  )!;
  const east = reading.resolveNodeId(
    runs
      .flatMap((r) => r.tripCalls ?? [])
      .find((c) => c.localStopId === "tullastrasse" && c.platformCode === "1b")!,
  )!;
  assert.notEqual(north, east);
  assert.ok(reading.nodesById.get(north)!.y < reading.nodesById.get(east)!.y);
  assert.equal(reading.nodesById.get(north)!.stopId, "tullastrasse");
  assert.equal(reading.nodesById.get(north)!.label, "Tullastraße");
  const drawn = buildZentrumSchematicReading(runs);
  assert.ok(drawn.stopMarks.some((mark) => mark.nodeId === north));
});

test("opposing Schloss Gottesaue platforms share one boarding place", () => {
  const places = createSchematicBoardingReading(runs).placesByStopId.get("schloss-gottesaue")!;
  assert.equal(places.length, 1);
  assert.deepEqual(places[0].platformCodes, ["1", "2"]);
});

test("boarding geometry does not depend on line names or arrival frequency", () => {
  const original = createSchematicBoardingReading(runs);
  const changed = createSchematicBoardingReading([
    ...runs.map((r, i) => ({ ...r, lineId: `other-${i}` })),
    ...runs,
  ]);
  assert.deepEqual([...changed.nodesById], [...original.nodesById]);
});

test("the same geographic rule works with unrelated stop and platform names", () => {
  const nodes = new Map([
    [
      "hub",
      {
        id: "hub",
        label: "Hub",
        x: 1100,
        y: 154,
        geographicPosition: { latitude: 49.00625, longitude: 8.431785 },
      },
    ],
    ["west", { id: "west", label: "West", x: 968, y: 154 }],
    ["south", { id: "south", label: "South", x: 990, y: 220 }],
  ]);
  const renamed = runs.map((r) => ({
    ...r,
    tripCalls: r.tripCalls?.map((c) => ({
      ...c,
      localStopId:
        c.localStopId === "tullastrasse"
          ? "hub"
          : c.localStopId === "gottesauer-platz"
            ? "west"
            : c.localStopId === "schloss-gottesaue"
              ? "south"
              : c.localStopId,
      platformCode: c.platformCode ? `track-${c.platformCode}` : undefined,
    })),
  }));
  const reading = createSchematicBoardingReading(renamed, nodes);
  assert.equal(reading.placesByStopId.get("hub")?.length, 2);
  assert.equal([...reading.nodesById.values()].filter((n) => n.stopId === "hub").length, 1);
});

test("equal aggregate neighbors do not merge different observed through routes", () => {
  const nodes = new Map([
    ["hub", { id: "hub", label: "Hub", x: 0, y: 0 }],
    ...["a", "b", "c", "d"].map((id) => [id, { id, label: id, x: 22, y: 22 }] as const),
  ]);
  const along = (code: string, from: string, to: string) =>
    createDeparture({
      tripCalls: [
        { stopName: from, localStopId: from },
        { stopName: "Hub", localStopId: "hub", platformCode: code },
        { stopName: to, localStopId: to },
      ],
    });
  const reading = createSchematicBoardingReading(
    [along("1", "a", "b"), along("1", "c", "d"), along("2", "a", "c"), along("2", "b", "d")],
    nodes,
  );
  assert.equal(reading.placesByStopId.get("hub")?.length, 2);
});

test("a rare platform remains named within an established boarding place", () => {
  const frequent = runs.filter((run) => !run.tripCalls?.some((call) => call.platformCode === "1a"));
  const rare = runs.find((run) => run.tripCalls?.some((call) => call.platformCode === "1a"))!;
  const reading = createSchematicBoardingReading([
    ...Array.from({ length: 30 }, () => frequent).flat(),
    rare,
  ]);
  assert.ok(
    reading.placesByStopId
      .get("tullastrasse")
      ?.some((place) => place.platformCodes?.includes("1a")),
  );
});

test("geographic boarding places produce only horizontal, vertical or diagonal segments", () => {
  const reading = buildZentrumSchematicReading(runs);
  for (const edge of reading.edges) {
    const dx = edge.to.x - edge.from.x;
    const dy = edge.to.y - edge.from.y;
    assert.ok(dx === 0 || dy === 0 || Math.abs(dx) === Math.abs(dy), edge.id);
  }
});

test("a boarding place stands a step off its stop, turns square off the bundle and runs on out", () => {
  const call = (stopName: string, latitude: number, longitude: number, localStopId?: string) => ({
    stopName,
    localStopId,
    providerStopPointId: stopName,
    latitude,
    longitude,
  });
  const at = (code: string, latitude: number, longitude: number): TripCall => ({
    ...call("7000039", latitude, longitude, "muehlburger-tor"),
    platformCode: code,
  });
  const europaplatz = call("Europaplatz", 49.0101, 8.3937, "europaplatz");
  const west = call("West", 49.0105, 8.3745);
  const north = call("North", 49.0135, 8.3848);
  const trip = (id: string, lineId: string, tripCalls: TripCall[]) =>
    createDeparture({ id, lineId, tripCalls });
  const reading = buildZentrumSchematicReading([
    trip("west", "S1", [europaplatz, at("1a", 49.010617, 8.382764), west]),
    trip("east", "S1", [west, at("2a", 49.010552, 8.383653), europaplatz]),
    trip("north", "1", [europaplatz, at("4", 49.010911, 8.384534), north]),
    trip("south", "1", [north, at("3", 49.011353, 8.384623), europaplatz]),
  ]);
  const main = reading.nodesById.get("muehlburger-tor")!;
  const place = [...reading.nodesById.values()].find((node) => node.stopId === "muehlburger-tor")!;
  // East of the stop, but the Kaiserstraße corridor runs there: the nearest open direction.
  assert.deepEqual([place.x - main.x, place.y - main.y], [44, -44]);
  assert.equal(place.platformRun, "upright");
  const touching = reading.edges.filter(
    (edge) => edge.from.id === place.id || edge.to.id === place.id,
  );
  for (const edge of touching) assert.equal(edge.from.x, edge.to.x, edge.id);
  assert.deepEqual(
    touching.map((edge) => (edge.from.id === place.id ? edge.to : edge.from).y).sort(),
    [main.y, place.y - 22].sort(),
  );
});

test("a place seen with one platform still runs the way the timetable's pair does", () => {
  const call = (stopName: string, latitude: number, longitude: number, localStopId?: string) => ({
    stopName,
    localStopId,
    providerStopPointId: stopName,
    latitude,
    longitude,
  });
  const at = (stopId: string, code: string, latitude: number, longitude: number): TripCall => ({
    ...call(stopId === "muehlburger-tor" ? "7000039" : "7000007", latitude, longitude, stopId),
    platformCode: code,
  });
  const trip = (id: string, lineId: string, tripCalls: TripCall[]) =>
    createDeparture({ id, lineId, tripCalls });
  const europaplatz = call("Europaplatz", 49.0101, 8.3937, "europaplatz");
  const west = call("West", 49.0105, 8.3745);
  const gottesauerPlatz = call("Gottesauer Platz", 49.0076, 8.4244, "gottesauer-platz");
  const east = call("East", 49.0045, 8.4409);
  // Their trips run on west-north-west and east-north-east: alone, they would read as level.
  const runOf = (stopId: string, runs: Departure[]) =>
    [...createSchematicBoardingReading(runs).nodesById.values()].find(
      (node) => node.stopId === stopId,
    )?.platformRun;

  assert.equal(
    runOf("muehlburger-tor", [
      trip("w", "S1", [europaplatz, at("muehlburger-tor", "1a", 49.010617, 8.382764), west]),
      trip("e", "S1", [west, at("muehlburger-tor", "2a", 49.010552, 8.383653), europaplatz]),
      trip("n", "1", [
        europaplatz,
        at("muehlburger-tor", "4", 49.010911, 8.384534),
        call("Onward", 49.0135, 8.38),
      ]),
    ]),
    "upright",
  );
  assert.equal(
    runOf("tullastrasse", [
      trip("w", "S5", [gottesauerPlatz, at("tullastrasse", "1b", 49.006121, 8.432539), east]),
      trip("e", "S5", [east, at("tullastrasse", "2b", 49.005908, 8.433528), gottesauerPlatz]),
      trip("n", "S2", [
        gottesauerPlatz,
        at("tullastrasse", "3", 49.006722, 8.431291),
        call("Onward", 49.0085, 8.4419),
      ]),
    ]),
    "upright",
  );
});

test("a line leaving the plan runs on as a stub the way it really goes", () => {
  const karlstor: TripCall = { stopName: "Karlstor", localStopId: "karlstor" };
  const europaplatz: TripCall = {
    stopName: "Europaplatz",
    localStopId: "europaplatz",
    latitude: 49.0101,
    longitude: 8.3937,
  };
  const north: TripCall = { stopName: "North", latitude: 49.0135, longitude: 8.3937 };
  const turning: TripCall = {
    stopName: "Loop",
    latitude: 49.0135,
    longitude: 8.3937,
    scheduledArrivalTime: "2026-09-04T12:05:00+02:00",
  };
  const stubsOf = (tripCalls: TripCall[]) =>
    buildZentrumSchematicReading([createDeparture({ id: "t", lineId: "2", tripCalls })])
      .edges.flatMap(({ from, to }) => [from, to])
      .filter((node) => node.id.startsWith("exit:"))
      .map(({ x, y }) => [x, y]);

  assert.deepEqual(stubsOf([karlstor, europaplatz, north]), [[374, 132]]);
  // A run that only turns or ends just outside goes no further.
  assert.deepEqual(stubsOf([karlstor, europaplatz, turning]), []);
});

test("a stub straight on keeps the lanes of the corridor it continues", () => {
  const trip = (id: string, lineId: string, tripCalls: TripCall[]) =>
    createDeparture({ id, lineId, tripCalls });
  const europaplatz: TripCall = { stopName: "Europaplatz", localStopId: "europaplatz" };
  const karlstor: TripCall = { stopName: "Karlstor", localStopId: "karlstor" };
  const reading = buildZentrumSchematicReading([
    trip("on", "S1", [europaplatz, karlstor, { stopName: "South" }]),
    trip("ends", "3", [europaplatz, karlstor]),
  ]);
  const into = reading.edges.find(
    ({ from, to }) => from.id === "europaplatz" || to.id === "europaplatz",
  )!;
  const stub = reading.edges.find(({ from, to }) =>
    [from, to].some((n) => n.id.startsWith("exit:")),
  )!;
  assert.deepEqual(stub.lineIds, ["S1"]);
  assert.deepEqual(stub.trackIds, into.trackIds);
});
