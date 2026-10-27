import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { StopEvent, Call } from "../src/data/transit-types.ts";
import { createSchematicBoardingReading } from "../src/lib/schematic-boarding-places.ts";
import { createStopEvent } from "./support/fixtures.ts";
import { buildZentrumSchematicReading } from "../src/lib/zentrum-schematic.ts";
import { StopRegistry } from "../src/data/stop-registry.ts";
const samples: { lineId: string; calls: Call[] }[] = JSON.parse(
  readFileSync(new URL("./support/zentrum-stop-bays.json", import.meta.url), "utf8"),
);
const datedJourneys: StopEvent[] = samples.map((sample, index) =>
  createStopEvent({ id: `platform-${index}`, ...sample }),
);

test("a clipped junction retains its distinct boarding places from full neighboring calls", () => {
  const reading = createSchematicBoardingReading(datedJourneys);
  const places = reading.placesByStopId.get("tullastrasse")!;
  assert.deepEqual(places.map((p) => p.bays).sort(), [
    ["1a", "1b", "2a", "2b"],
    ["3", "4"],
  ]);
  const north = reading.resolveNodeId(
    datedJourneys
      .flatMap((r) => r.calls ?? [])
      .find((c) => c.stopPlaceId === "tullastrasse" && c.bay === "4")!,
  )!;
  const east = reading.resolveNodeId(
    datedJourneys
      .flatMap((r) => r.calls ?? [])
      .find((c) => c.stopPlaceId === "tullastrasse" && c.bay === "1b")!,
  )!;
  assert.notEqual(north, east);
  assert.ok(reading.nodesById.get(north)!.y < reading.nodesById.get(east)!.y);
  assert.equal(reading.nodesById.get(north)!.stopId, "tullastrasse");
  assert.equal(reading.nodesById.get(north)!.label, "Tullastraße");
  const drawn = buildZentrumSchematicReading(datedJourneys);
  assert.ok(drawn.stopMarks.some((mark) => mark.nodeId === north));
});

test("opposing Schloss Gottesaue platforms share one boarding place", () => {
  const places =
    createSchematicBoardingReading(datedJourneys).placesByStopId.get("schloss-gottesaue")!;
  assert.equal(places.length, 1);
  assert.deepEqual(places[0].bays, ["1", "2"]);
});

test("boarding geometry does not depend on line names or arrival frequency", () => {
  const original = createSchematicBoardingReading(datedJourneys);
  const changed = createSchematicBoardingReading([
    ...datedJourneys.map((r, i) => ({ ...r, lineId: `other-${i}` })),
    ...datedJourneys,
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
  const renamed = datedJourneys.map((r) => ({
    ...r,
    calls: r.calls?.map((c) => ({
      ...c,
      stopPlaceId:
        c.stopPlaceId === "tullastrasse"
          ? "hub"
          : c.stopPlaceId === "gottesauer-platz"
            ? "west"
            : c.stopPlaceId === "schloss-gottesaue"
              ? "south"
              : c.stopPlaceId,
      bay: c.bay ? `track-${c.bay}` : undefined,
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
    createStopEvent({
      calls: [
        { stopName: from, stopPlaceId: from },
        { stopName: "Hub", stopPlaceId: "hub", bay: code },
        { stopName: to, stopPlaceId: to },
      ],
    });
  const reading = createSchematicBoardingReading(
    [along("1", "a", "b"), along("1", "c", "d"), along("2", "a", "c"), along("2", "b", "d")],
    nodes,
  );
  assert.equal(reading.placesByStopId.get("hub")?.length, 2);
});

test("a rare platform remains named within an established boarding place", () => {
  const frequent = datedJourneys.filter(
    (datedJourney) => !datedJourney.calls?.some((call) => call.bay === "1a"),
  );
  const rare = datedJourneys.find((datedJourney) =>
    datedJourney.calls?.some((call) => call.bay === "1a"),
  )!;
  const reading = createSchematicBoardingReading([
    ...Array.from({ length: 30 }, () => frequent).flat(),
    rare,
  ]);
  assert.ok(
    reading.placesByStopId.get("tullastrasse")?.some((place) => place.bays?.includes("1a")),
  );
});

test("geographic boarding places produce only horizontal, vertical or diagonal segments", () => {
  const reading = buildZentrumSchematicReading(datedJourneys);
  for (const edge of reading.edges) {
    const dx = edge.to.x - edge.from.x;
    const dy = edge.to.y - edge.from.y;
    assert.ok(dx === 0 || dy === 0 || Math.abs(dx) === Math.abs(dy), edge.id);
  }
});

test("a boarding place stands a step off its stop, turns square off the bundle and runs on out", () => {
  const call = (stopName: string, latitude: number, longitude: number, stopPlaceId?: string) => ({
    stopName,
    stopPlaceId,
    stopPointId: stopName,
    latitude,
    longitude,
  });
  const at = (code: string, latitude: number, longitude: number): Call => ({
    ...call("de:08212:39", latitude, longitude, "muehlburger-tor"),
    bay: code,
  });
  const europaplatz = call("Europaplatz", 49.0101, 8.3937, "europaplatz");
  const west = call("West", 49.0105, 8.3745);
  const north = call("North", 49.0135, 8.3848);
  const journey = (id: string, lineId: string, calls: Call[]) =>
    createStopEvent({ id, lineId, calls });
  const reading = buildZentrumSchematicReading([
    journey("west", "S1", [europaplatz, at("1a", 49.010617, 8.382764), west]),
    journey("east", "S1", [west, at("2a", 49.010552, 8.383653), europaplatz]),
    journey("north", "1", [europaplatz, at("4", 49.010911, 8.384534), north]),
    journey("south", "1", [north, at("3", 49.011353, 8.384623), europaplatz]),
  ]);
  const main = reading.nodesById.get("muehlburger-tor")!;
  const place = [...reading.nodesById.values()].find((node) => node.stopId === "muehlburger-tor")!;
  // East of the stop, but the Kaiserstraße corridor runs there: the nearest open direction.
  assert.deepEqual([place.x - main.x, place.y - main.y], [44, -44]);
  assert.equal(place.bayRun, "upright");
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
  const call = (stopName: string, latitude: number, longitude: number, stopPlaceId?: string) => ({
    stopName,
    stopPlaceId,
    stopPointId: stopName,
    latitude,
    longitude,
  });
  const at = (stopId: string, code: string, latitude: number, longitude: number): Call => ({
    ...call(
      stopId === "muehlburger-tor" ? "de:08212:39" : "de:08212:7",
      latitude,
      longitude,
      stopId,
    ),
    bay: code,
  });
  const journey = (id: string, lineId: string, calls: Call[]) =>
    createStopEvent({ id, lineId, calls });
  const europaplatz = call("Europaplatz", 49.0101, 8.3937, "europaplatz");
  const west = call("West", 49.0105, 8.3745);
  const gottesauerPlatz = call("Gottesauer Platz", 49.0076, 8.4244, "gottesauer-platz");
  const east = call("East", 49.0045, 8.4409);
  // Their trips run on west-north-west and east-north-east: alone, they would read as level.
  const runOf = (stopId: string, datedJourneys: StopEvent[]) =>
    [...createSchematicBoardingReading(datedJourneys).nodesById.values()].find(
      (node) => node.stopId === stopId,
    )?.bayRun;

  assert.equal(
    runOf("muehlburger-tor", [
      journey("w", "S1", [europaplatz, at("muehlburger-tor", "1a", 49.010617, 8.382764), west]),
      journey("e", "S1", [west, at("muehlburger-tor", "2a", 49.010552, 8.383653), europaplatz]),
      journey("n", "1", [
        europaplatz,
        at("muehlburger-tor", "4", 49.010911, 8.384534),
        call("Onward", 49.0135, 8.38),
      ]),
    ]),
    "upright",
  );
  assert.equal(
    runOf("tullastrasse", [
      journey("w", "S5", [gottesauerPlatz, at("tullastrasse", "1b", 49.006121, 8.432539), east]),
      journey("e", "S5", [east, at("tullastrasse", "2b", 49.005908, 8.433528), gottesauerPlatz]),
      journey("n", "S2", [
        gottesauerPlatz,
        at("tullastrasse", "3", 49.006722, 8.431291),
        call("Onward", 49.0085, 8.4419),
      ]),
    ]),
    "upright",
  );
});

test("a line leaving the plan runs on as a stub the way it really goes", () => {
  const karlstor: Call = { stopName: "Karlstor", stopPlaceId: "karlstor" };
  const europaplatz: Call = {
    stopName: "Europaplatz",
    stopPlaceId: "europaplatz",
    latitude: 49.0101,
    longitude: 8.3937,
  };
  const north: Call = { stopName: "North", latitude: 49.0135, longitude: 8.3937 };
  const turning: Call = {
    stopName: "Loop",
    latitude: 49.0135,
    longitude: 8.3937,
    timetabledArrivalTime: "2026-09-04T12:05:00+02:00",
  };
  const stubsOf = (calls: Call[]) =>
    buildZentrumSchematicReading([createStopEvent({ id: "t", lineId: "2", calls })])
      .edges.flatMap(({ from, to }) => [from, to])
      .filter((node) => node.id.startsWith("exit:"))
      .map(({ x, y }) => [x, y]);

  assert.deepEqual(stubsOf([karlstor, europaplatz, north]), [[374, 132]]);
  // A run that only turns or ends just outside goes no further.
  assert.deepEqual(stubsOf([karlstor, europaplatz, turning]), []);
});

test("a stub straight on keeps the lanes of the corridor it continues", () => {
  const journey = (id: string, lineId: string, calls: Call[]) =>
    createStopEvent({ id, lineId, calls });
  const europaplatz: Call = { stopName: "Europaplatz", stopPlaceId: "europaplatz" };
  const karlstor: Call = { stopName: "Karlstor", stopPlaceId: "karlstor" };
  const reading = buildZentrumSchematicReading([
    journey("on", "S1", [europaplatz, karlstor, { stopName: "South" }]),
    journey("ends", "3", [europaplatz, karlstor]),
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

test("calls without positions still split a stop into the places its platforms stand at", () => {
  // TRIAS's calls state stop and platform only.
  const registry = new StopRegistry([]);
  const trias = (lineId: string, calls: readonly string[]) =>
    createStopEvent({
      id: `${lineId}-${calls.join()}`,
      lineId,
      calls: registry.toCalls(
        calls.map((call) => {
          const [stop, bay] = call.split("|");
          return { stopName: stop, stopPointId: stop, bay };
        }),
      ),
    });
  const reading = createSchematicBoardingReading([
    trias("3", [
      "de:08212:84|2",
      "de:08212:83|2",
      "de:08212:85|4",
      "de:08212:3|4",
      "de:08212:401|2",
    ]),
    trias("3", [
      "de:08212:401|1",
      "de:08212:3|3",
      "de:08212:85|3",
      "de:08212:83|1",
      "de:08212:84|1",
    ]),
    trias("4", [
      "de:08212:401|1",
      "de:08212:3|3",
      "de:08212:85|1",
      "de:08212:71|1",
      "de:08212:61|1",
    ]),
    trias("5", [
      "de:08212:61|2",
      "de:08212:71|2",
      "de:08212:85|2",
      "de:08212:622|2",
      "de:08212:623|2",
    ]),
    trias("3", [
      "de:08212:62|3",
      "de:08212:61|3",
      "de:08212:37|3",
      "de:08212:37|5",
      "de:08212:39|1a",
    ]),
    trias("3", [
      "de:08212:41|2",
      "de:08212:39|2a",
      "de:08212:37|6",
      "de:08212:37|4",
      "de:08212:61|4",
    ]),
    trias("1", [
      "de:08212:1002|1(U)",
      "de:08212:1003|1(U)",
      "de:08212:1004|1(U)",
      "de:08212:39|3",
      "de:08212:7003|1",
    ]),
    trias("S2", [
      "de:08212:41|2",
      "de:08212:39|2a",
      "de:08212:1004|2(U)",
      "de:08212:1003|2(U)",
      "de:08212:1002|2(U)",
    ]),
  ]);
  const placesAt = (stopId: string) =>
    reading.placesByStopId
      .get(stopId)!
      .map((place) => place.bays)
      .sort();
  assert.deepEqual(placesAt("europaplatz"), [
    ["1(U)", "2(U)", "5", "6"],
    ["3", "4"],
  ]);
  assert.deepEqual(placesAt("rueppurrer-tor"), [["1"], ["2"], ["3", "4"]]);
});
