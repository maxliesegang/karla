import assert from "node:assert/strict";
import test from "node:test";
import type { Departure, DepartureBoard, TripCall } from "../src/data/transit-types.ts";
import { isZentrumStop, zentrumStopIds } from "../src/data/zentrum-stops.ts";
import {
  type ZentrumSchematicReading,
  buildZentrumSchematicReading,
  createZentrumSchematicDrawer,
  createZentrumSchematicReader,
  getZentrumSchematicVehicles,
} from "../src/lib/zentrum-schematic.ts";
import {
  ZENTRUM_SCHEMATIC_GRID,
  ZENTRUM_SCHEMATIC_NODES,
  ZENTRUM_SCHEMATIC_VIEWBOX,
  getEdgeKey,
} from "../src/lib/zentrum-schematic-plan.ts";
import {
  getZentrumSchematicVehiclePathPlacement,
  getZentrumSchematicLinePathData,
  getZentrumSchematicVehiclePathData,
  reverseZentrumSchematicCorridorPath,
} from "../src/lib/zentrum-schematic-paths.ts";
import { getZentrumVehicleLinkKey } from "../src/lib/zentrum-plan-canvas.ts";
import { run } from "./support/calls.ts";
import { createRunMotions } from "../src/lib/vehicle-positioning.ts";
import { createDeparture } from "./support/fixtures.ts";

/** One drawing's motion record, shared across this file. */
const motions = createRunMotions();

const call = (localStopId: string, providerStopPointId: string, platformCode = "1"): TripCall => ({
  stopName: localStopId,
  localStopId,
  providerStopPointId,
  platformCode,
});

const departure = (
  lineId: string,
  tripCalls: readonly TripCall[],
  overrides: Partial<Departure> = {},
): Departure =>
  createDeparture({
    id: `${lineId}-departure`,
    lineId,
    transportMode: "tram",
    destination: "Testziel",
    minutesUntilDeparture: 3,
    platformCode: "1",
    boardingLocalStopId: tripCalls[0]?.localStopId ?? "",
    boardingProviderStopPointId: tripCalls[0]?.providerStopPointId ?? "",
    boardingProviderStopPointName: tripCalls[0]?.stopName ?? "",
    status: "realtime",
    scheduledDepartureTime: "2026-09-04T12:00:00+02:00",
    tripCalls,
    ...overrides,
  });

const board = (...departures: readonly Departure[]): DepartureBoard => ({
  stopId: "europaplatz",
  receivedAt: 1,
  dataStatus: "live",
  feedUpdatedAt: "2026-09-04T11:57:00+02:00",
  departures,
});

/** The runs a reading is built from, standing in for what `useLineRunDepartures` hands the view. */
const drawn = (boards: readonly DepartureBoard[]): Departure[] =>
  boards.flatMap(({ departures }) => departures);

test("changes a vehicle animation key when its drawn ride bends differently", () => {
  const straightRide = {
    points: [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    ],
    steps: [0, 1],
  };
  const bentRide = {
    points: [
      { x: 0, y: 0 },
      { x: 50, y: 20 },
      { x: 100, y: 0 },
    ],
    steps: [0, 0.5, 1],
  };

  assert.notEqual(
    getZentrumVehicleLinkKey("from", "to", straightRide),
    getZentrumVehicleLinkKey("from", "to", bentRide),
  );
});

test("reads only adjacent observed calls into schematic edges", () => {
  const reading = buildZentrumSchematicReading(
    drawn([
      board(
        departure("2", [
          call("muehlburger-tor", "7000039", "1a"),
          call("europaplatz", "7000037", "5"),
          call("outside", "7009999"),
          call("karlstor", "7000061", "1"),
        ]),
      ),
    ]),
  );

  // Leaving the plan, the line runs on as a stub, straight on past Europaplatz.
  assert.deepEqual(
    reading.edges.map(({ from, to, lineIds }) => [from.id, to.id, lineIds]),
    [
      ["europaplatz", "exit:europaplatz:396,154", ["2"]],
      ["europaplatz", "muehlburger-tor", ["2"]],
    ],
  );
  assert.equal(reading.lineIdsByNodeId.has("karlstor"), false);
  assert.deepEqual(
    reading.linePaths.map(({ lineId, nodes }) => [lineId, nodes.map(({ id }) => id)]),
    [["2", ["muehlburger-tor", "europaplatz", "exit:europaplatz:396,154"]]],
  );
});

test("crossing between the parts of one complex draws no corridor, and breaks no chain", () => {
  const reading = buildZentrumSchematicReading(
    drawn([
      board(
        departure("S1", [
          call("ettlinger-tor", "7001012"),
          call("marktplatz", "7001011"),
          call("marktplatz", "7001003"),
          call("europaplatz", "7001004"),
        ]),
      ),
    ]),
  );

  assert.deepEqual(
    reading.edges.map(({ from, to }) => [from.id, to.id]),
    [
      ["ettlinger-tor", "marktplatz"],
      ["europaplatz", "marktplatz"],
    ],
  );
});

test("combines directions and repeated trips into one corridor line set", () => {
  const west = call("muehlburger-tor", "7000039", "1a");
  const europa = call("europaplatz", "7000037", "5");
  const reading = buildZentrumSchematicReading(
    drawn([
      board(
        departure("2", [west, europa]),
        departure("2", [europa, west], { id: "second-2" }),
        departure("3", [west, europa]),
        departure("9", [west, europa], { status: "cancelled" }),
        departure("ICE", [west, europa], { transportMode: "other" }),
      ),
    ]),
  );

  assert.deepEqual(reading.edges[0]?.lineIds, ["2", "3"]);
  assert.equal(reading.linePaths.filter(({ lineId }) => lineId === "2").length, 1);
});

test("one trip named twice in the drawn set is one trip, not two", () => {
  // The same trip as a board row and as its retained reading must count once.
  const west = call("muehlburger-tor", "7000039");
  const europa = call("europaplatz", "7000037");
  const market = call("marktplatz", "7001003");
  const reading = buildZentrumSchematicReading([
    departure("S5", [west, europa, market], {
      id: "row",
      tripId: "trip-1",
      tripInstanceId: "trip-1@a",
    }),
    departure("S5", [west, europa, market], {
      id: "reading",
      tripId: "trip-1",
      tripInstanceId: "trip-1@a",
    }),
    departure("S5", [west, europa], { id: "short-1", tripId: "trip-2" }),
    departure("S5", [europa, west], { id: "short-2", tripId: "trip-3" }),
  ]);

  assert.deepEqual(
    reading.linePaths.map(({ lineId, nodes }) => [lineId, nodes.map(({ id }) => id)]),
    [["S5", ["muehlburger-tor", "europaplatz"]]],
  );
});

test("a run the boards have stopped naming still states the corridors its mark rides", () => {
  // A run between posts is on no board, but its line still draws.
  const west = call("muehlburger-tor", "7000039");
  const europa = call("europaplatz", "7000037");
  const reading = buildZentrumSchematicReading([
    departure("2", [west, europa], { id: "between-posts", tripId: "between-posts" }),
  ]);

  assert.deepEqual(
    reading.edges.map(({ from, to, lineIds }) => [from.id, to.id, lineIds]),
    [["europaplatz", "muehlburger-tor", ["2"]]],
  );
});

test("a refresh that draws the same plan is handed the same plan, laid out once", () => {
  // Layout is expensive; runs change every few seconds, corridors a few times a day.
  const west = call("muehlburger-tor", "7000039");
  const europa = call("europaplatz", "7000037");
  const market = call("marktplatz", "7001003");
  const karlstor = call("karlstor", "7000061");
  const read = createZentrumSchematicReader();
  const first = read([
    departure("2", [west, europa, market], { id: "a", tripId: "a" }),
    departure("2", [market, europa, west], { id: "b", tripId: "b" }),
  ]);

  const swapped = read([
    departure("2", [market, europa, west], { id: "c", tripId: "c" }),
    departure("2", [west, europa, market], { id: "d", tripId: "d" }),
  ]);
  assert.equal(swapped, first);

  // A new corridor is a new plan.
  const grown = read([
    departure("2", [west, europa, market], { id: "a", tripId: "a" }),
    departure("S1", [west, europa, karlstor], { id: "e", tripId: "e" }),
  ]);
  assert.notEqual(grown, first);
  assert.notEqual(grown.layoutKey, first.layoutKey);
  assert.deepEqual(grown.lineIds, ["2", "S1"]);
  assert.deepEqual(
    grown.edges.map(({ id }) => id),
    buildZentrumSchematicReading([
      departure("S1", [west, europa, karlstor], { id: "e", tripId: "e" }),
      departure("2", [west, europa, market], { id: "a", tripId: "a" }),
    ]).edges.map(({ id }) => id),
  );
});

test("draws only the path used by the most timetable trips for each line", () => {
  const west = call("muehlburger-tor", "7000039");
  const europa = call("europaplatz", "7000037");
  const market = call("marktplatz", "7001003");
  const kronen = call("kronenplatz", "7001002");
  const karlstor = call("karlstor", "7000061");
  const reading = buildZentrumSchematicReading(
    drawn([
      board(
        departure("S5", [west, europa, market, kronen], { id: "main-1", tripId: "main-1" }),
        departure("S5", [kronen, market, europa, west], { id: "main-2", tripId: "main-2" }),
        departure("S5", [west, europa, karlstor], { id: "branch", tripId: "branch" }),
      ),
    ]),
  );

  assert.deepEqual(
    reading.linePaths.map(({ lineId, nodes }) => [lineId, nodes.map(({ id }) => id)]),
    [["S5", ["muehlburger-tor", "europaplatz", "marktplatz", "kronenplatz"]]],
  );
  // The less-used service is still observed; only its coloured line is omitted.
  assert.ok(
    reading.edges.some(
      ({ from, to, lineIds }) => [from.id, to.id].includes("karlstor") && lineIds.includes("S5"),
    ),
  );
});

test("breaks equal-usage path ties by coverage, independent of board order", () => {
  const shortPath = [call("europaplatz", "7000037"), call("marktplatz", "7001003")];
  const longPath = [call("muehlburger-tor", "7000039"), ...shortPath];
  const boards = [
    board(departure("S51", shortPath, { id: "short", tripId: "short" })),
    board(departure("S51", longPath, { id: "long", tripId: "long" })),
  ];

  for (const orderedBoards of [boards, [...boards].reverse()]) {
    assert.deepEqual(
      buildZentrumSchematicReading(drawn(orderedBoards)).linePaths[0]?.nodes.map(({ id }) => id),
      ["muehlburger-tor", "europaplatz", "marktplatz"],
    );
  }
});

test("keeps a through line level while the lines around it change", () => {
  const wholeCorridor = [
    call("muehlburger-tor", "7000039"),
    call("europaplatz", "7000037"),
    call("marktplatz", "7001003"),
  ];
  const reading = buildZentrumSchematicReading(
    drawn([
      board(
        departure("2", wholeCorridor),
        departure("1", wholeCorridor.slice(0, 2), { id: "1-trip" }),
        departure("3", wholeCorridor.slice(1), { id: "3-trip" }),
      ),
    ]),
  );
  const linePath = reading.linePaths.find(({ lineId }) => lineId === "2");
  assert.ok(linePath);

  const data = getZentrumSchematicLinePathData(linePath, reading.edges, reading.trackWidth);
  // Line 1 leaves and line 3 joins at Europaplatz; neither reserves a lane where absent, and line 2
  // keeps its lane across the stop.
  assert.match(data, /^M 110\.00 150\.50 /);
  assert.match(data, /L 374\.00 150\.50 L 572\.00 150\.50$/);
  const westCorridor = reading.edges.find(
    ({ from, to }) =>
      [from.id, to.id].includes("muehlburger-tor") && [from.id, to.id].includes("europaplatz"),
  );
  assert.ok(westCorridor);
  assert.equal(westCorridor.trackBandOffset, -1);
  assert.equal(
    reading.edges.find(
      ({ from, to }) =>
        [from.id, to.id].includes("europaplatz") && [from.id, to.id].includes("marktplatz"),
    )?.trackBandOffset,
    0,
  );
});

test("draws a trunk and its branches as one lane on the corridors they share", () => {
  const west = call("muehlburger-tor", "7000039");
  const europa = call("europaplatz", "7000037");
  const market = call("marktplatz", "7001003");
  const karlstor = call("karlstor", "7000061");
  const reading = buildZentrumSchematicReading(
    drawn([
      board(
        departure("2", [west, europa, karlstor]),
        departure("S1", [west, europa, market], { id: "s1", tripId: "s1" }),
        departure("S11", [west, europa, market], { id: "s11", tripId: "s11" }),
        departure("S5", [europa, market], { id: "s5", tripId: "s5" }),
        departure("S51", [europa, market], { id: "s51", tripId: "s51" }),
        departure("S4", [europa, market], { id: "s4", tripId: "s4" }),
        departure("S41", [europa, market], { id: "s41", tripId: "s41" }),
      ),
    ]),
  );
  const sharedEdge = reading.edges.find(
    ({ from, to }) =>
      [from.id, to.id].includes("europaplatz") && [from.id, to.id].includes("marktplatz"),
  );
  assert.ok(sharedEdge);

  // Each line keeps its own pattern; only the lane is shared, and only where signed as one service.
  assert.deepEqual(sharedEdge.lineIds, ["S1", "S4", "S5", "S11", "S41", "S51"]);
  assert.deepEqual([...sharedEdge.trackIds].sort(), ["S1", "S4", "S41", "S5"]);
  assert.equal(sharedEdge.trackIds.includes("2"), false);
  assert.deepEqual(
    reading.linePaths.map(({ lineId, trackId }) => [lineId, trackId]),
    [
      ["2", "2"],
      ["S1", "S1"],
      ["S4", "S4"],
      ["S5", "S5"],
      ["S11", "S1"],
      ["S41", "S41"],
      ["S51", "S5"],
    ],
  );

  const pathData = new Map(
    reading.linePaths.map((linePath) => [
      linePath.lineId,
      getZentrumSchematicLinePathData(linePath, reading.edges, reading.trackWidth),
    ]),
  );
  assert.equal(pathData.get("S1"), pathData.get("S11"));
  assert.equal(pathData.get("S5"), pathData.get("S51"));
  assert.notEqual(pathData.get("S4"), pathData.get("S41"));
  assert.notEqual(pathData.get("S1"), pathData.get("S5"));
});

test("parts a branch from its trunk where their observed patterns part", () => {
  const west = call("muehlburger-tor", "7000039");
  const europa = call("europaplatz", "7000037");
  const market = call("marktplatz", "7001003");
  const karlstor = call("karlstor", "7000061");
  const reading = buildZentrumSchematicReading(
    drawn([
      board(
        departure("S1", [west, europa, market], { id: "s1", tripId: "s1" }),
        departure("S11", [west, europa, karlstor], { id: "s11", tripId: "s11" }),
        departure("2", [west, europa, market], { id: "2-trip", tripId: "2-trip" }),
      ),
    ]),
  );
  const orderOn = (leftStopId: string, rightStopId: string) =>
    reading.edges.find(
      ({ from, to }) =>
        [from.id, to.id].includes(leftStopId) && [from.id, to.id].includes(rightStopId),
    )?.trackIds ?? [];
  const pathData = new Map(
    reading.linePaths.map((linePath) => [
      linePath.lineId,
      getZentrumSchematicLinePathData(linePath, reading.edges, reading.trackWidth),
    ]),
  );

  // West of Europaplatz the pair shares one lane.
  assert.deepEqual([...orderOn("muehlburger-tor", "europaplatz")].sort(), ["2", "S1"]);
  assert.ok(pathData.get("S1")?.startsWith("M 110.00 157.50"));
  assert.ok(pathData.get("S11")?.startsWith("M 110.00 157.50"));
  assert.notEqual(pathData.get("S1"), pathData.get("S11"));
  // South of it only the branch runs.
  assert.deepEqual(orderOn("europaplatz", "karlstor"), ["S1"]);
});

test("keeps lines with a longer shared route adjacent through busy corridors", () => {
  const west = call("muehlburger-tor", "7000039");
  const europa = call("europaplatz", "7000037");
  const market = call("marktplatz", "7001003");
  const kronen = call("kronenplatz", "7001002");
  const durlach = call("durlacher-tor", "7001001");
  const karlstor = call("karlstor", "7000061");
  const ettlinger = call("ettlinger-tor", "7001012");
  const rueppurrer = call("rueppurrer-tor", "7000077");
  const reading = buildZentrumSchematicReading(
    drawn([
      board(
        departure("1", [west, europa, market, kronen, durlach]),
        departure("S2", [west, europa, market, kronen, durlach], {
          id: "s2-trip",
          tripId: "s2-trip",
        }),
        departure("2", [west, europa, market, ettlinger], { id: "2-trip", tripId: "2-trip" }),
        departure("3", [west, europa, karlstor], { id: "3-trip", tripId: "3-trip" }),
        departure("4", [europa, karlstor, ettlinger, rueppurrer]),
        departure("5", [europa, karlstor, ettlinger, rueppurrer], {
          id: "5-trip",
          tripId: "5-trip",
        }),
        departure("6", [europa, karlstor, call("mathystrasse", "7000062")], {
          id: "6-trip",
          tripId: "6-trip",
        }),
      ),
    ]),
  );
  const orderOn = (leftStopId: string, rightStopId: string) =>
    reading.edges.find(
      ({ from, to }) =>
        [from.id, to.id].includes(leftStopId) && [from.id, to.id].includes(rightStopId),
    )?.trackIds ?? [];
  const assertAdjacent = (order: readonly string[], leftLineId: string, rightLineId: string) =>
    assert.equal(Math.abs(order.indexOf(leftLineId) - order.indexOf(rightLineId)), 1);

  // Found from shared edges, not named exceptions.
  assertAdjacent(orderOn("muehlburger-tor", "europaplatz"), "1", "S2");
  assertAdjacent(orderOn("europaplatz", "karlstor"), "4", "5");
  assertAdjacent(orderOn("karlstor", "ettlinger-tor"), "4", "5");
});

test("orders a shared straight by the side on which its lines leave", () => {
  const west = call("muehlburger-tor", "7000039");
  const europa = call("europaplatz", "7000037");
  const market = call("marktplatz", "7001003");
  const kronen = call("kronenplatz", "7001002");
  const durlach = call("durlacher-tor", "7001001");
  const reading = buildZentrumSchematicReading(
    drawn([
      board(
        departure("1", [
          west,
          europa,
          market,
          kronen,
          durlach,
          call("gottesauer-platz", "7000041"),
        ]),
        departure("2", [west, europa, call("karlstor", "7000061")]),
        departure("4", [
          west,
          europa,
          market,
          call("ettlinger-tor", "7001012"),
          call("kongresszentrum", "7001013"),
          call("augartenstrasse", "7000074"),
        ]),
        departure("3", [
          west,
          europa,
          market,
          kronen,
          durlach,
          call("karl-wilhelm-platz", "7000042"),
        ]),
      ),
    ]),
  );

  const pathData = new Map(
    reading.linePaths.map((linePath) => [
      linePath.lineId,
      getZentrumSchematicLinePathData(linePath, reading.edges, reading.trackWidth),
    ]),
  );
  const westCorridor = reading.edges.find(
    ({ from, to }) =>
      [from.id, to.id].includes("muehlburger-tor") && [from.id, to.id].includes("europaplatz"),
  );

  // Later branches nest inside earlier ones, so no line crosses another to reach its branch.
  assert.deepEqual(westCorridor?.trackIds, ["3", "1", "4", "2"]);
  assert.match(pathData.get("3") ?? "", /^M 110\.00 143\.50 /);
  assert.match(pathData.get("1") ?? "", /^M 110\.00 150\.50 /);
  assert.match(pathData.get("4") ?? "", /^M 110\.00 157\.50 /);
  assert.match(pathData.get("2") ?? "", /^M 110\.00 164\.50 /);
});

test("lays neighbouring lanes exactly one lane width apart", () => {
  const west = call("muehlburger-tor", "7000039");
  const europa = call("europaplatz", "7000037");
  const market = call("marktplatz", "7001003");
  const reading = buildZentrumSchematicReading(
    drawn([
      board(
        departure("1", [west, europa, market]),
        departure("2", [west, europa, call("karlstor", "7000061")], { id: "2-trip" }),
        departure("3", [west, europa, market, call("kronenplatz", "7001002")], { id: "3-trip" }),
        departure("4", [west, europa, market, call("ettlinger-tor", "7001012")], { id: "4-trip" }),
      ),
    ]),
  );
  const corridor = reading.edges.find(
    ({ from, to }) =>
      [from.id, to.id].includes("muehlburger-tor") && [from.id, to.id].includes("europaplatz"),
  );
  assert.ok(corridor);
  assert.equal(corridor.trackIds.length, 4);

  // The corridor runs level, so lane start points give the spacing.
  const laneOffsets = corridor.trackIds.map((trackId) => {
    const linePath = reading.linePaths.find((path) => path.trackId === trackId);
    assert.ok(linePath);
    const start = getZentrumSchematicLinePathData(
      linePath,
      reading.edges,
      reading.trackWidth,
    ).match(/^M [\d.]+ ([\d.]+)/);
    assert.ok(start);
    return Number(start[1]);
  });
  for (const [index, offset] of laneOffsets.slice(1).entries()) {
    assert.equal(offset - laneOffsets[index], reading.trackWidth);
  }
  // The band stays centred on the corridor.
  assert.equal((laneOffsets[0] + laneOffsets[laneOffsets.length - 1]) / 2, 154);
});

/*
 * A straight is anchored at its busiest corridor and narrower corridors hang off the through lanes,
 * so lines along the Kaiserstraße do not step aside at each stop.
 */
test("hangs a narrower straight off the top of the band its through lines run in", () => {
  const calls = (stopIds: readonly string[]) => stopIds.map((stopId) => call(stopId, "7000000"));
  const reading = buildZentrumSchematicReading(
    drawn([
      board(
        departure(
          "1",
          calls(["muehlburger-tor", "europaplatz", "marktplatz", "kronenplatz", "durlacher-tor"]),
        ),
        departure(
          "2",
          calls(["muehlburger-tor", "europaplatz", "marktplatz", "kronenplatz", "durlacher-tor"]),
          { id: "2-trip", tripId: "2-trip" },
        ),
        ...["3", "4", "5", "6"].map((lineId) =>
          departure(lineId, calls(["muehlburger-tor", "europaplatz", "karlstor"]), {
            id: `${lineId}-trip`,
            tripId: `${lineId}-trip`,
          }),
        ),
        ...["7", "8", "9", "10"].map((lineId) =>
          departure(
            lineId,
            calls(["durlacher-tor", "kronenplatz", "marktplatz", "ettlinger-tor"]),
            {
              id: `${lineId}-trip`,
              tripId: `${lineId}-trip`,
            },
          ),
        ),
      ),
    ]),
  );
  const pathData = new Map(
    reading.linePaths.map((linePath) => [
      linePath.lineId,
      getZentrumSchematicLinePathData(linePath, reading.edges, reading.trackWidth),
    ]),
  );

  // The through lines run level from Mühlburger Tor to Durlacher Tor, at the top of the narrower
  // band between Europaplatz and Marktplatz.
  assert.equal(
    pathData.get("1"),
    "M 110.00 136.50 L 374.00 136.50 L 572.00 136.50 L 726.00 136.50 L 858.00 136.50",
  );
  assert.equal(
    pathData.get("2"),
    "M 110.00 143.50 L 374.00 143.50 L 572.00 143.50 L 726.00 143.50 L 858.00 143.50",
  );
  // Lines turning off bend on the side they leave.
  assert.match(pathData.get("3") ?? "", /^M 110\.00 150\.50 L 374\.50 150\.50 A /);
  assert.match(
    pathData.get("7") ?? "",
    /^M 858\.00 150\.50 L 726\.00 150\.50 L 571\.50 150\.50 A /,
  );
});

const crowdedCorridor = () => [call("muehlburger-tor", "7000039"), call("europaplatz", "7000037")];
const corridorRuns = (lineCount: number) =>
  drawn([
    board(
      ...Array.from({ length: lineCount }, (_, index) =>
        departure(String(index + 1), crowdedCorridor(), { id: `${index + 1}-trip` }),
      ),
    ),
  ]);

test("thins every lane together when a corridor outgrows the band", () => {
  const busy = buildZentrumSchematicReading(corridorRuns(12));
  const busier = buildZentrumSchematicReading(corridorRuns(16));
  const quiet = buildZentrumSchematicReading(corridorRuns(2));

  assert.equal(busy.edges[0]?.trackIds.length, 12);
  assert.ok(busy.trackWidth < quiet.trackWidth);
  // Past the band, the lanes share its width.
  assert.equal(busy.trackWidth * 12, busier.trackWidth * 16);
});

test("draws a lane at one width on screen, whatever size the plan is drawn at", () => {
  const runs = corridorRuns(2);
  const small = buildZentrumSchematicReading(runs, ZENTRUM_SCHEMATIC_VIEWBOX.width / 2);
  const large = buildZentrumSchematicReading(runs, ZENTRUM_SCHEMATIC_VIEWBOX.width * 2);
  const onScreen = (reading: ZentrumSchematicReading, planWidth: number) =>
    (reading.trackWidth * planWidth) / ZENTRUM_SCHEMATIC_VIEWBOX.width;

  assert.equal(small.trackWidth, large.trackWidth * 4);
  assert.equal(
    onScreen(small, ZENTRUM_SCHEMATIC_VIEWBOX.width / 2),
    onScreen(large, ZENTRUM_SCHEMATIC_VIEWBOX.width * 2),
  );
  // Neighbours still stand one lane width apart.
  const [first, second] = small.edges[0].trackIds.map((trackId) => {
    const linePath = small.linePaths.find((path) => path.trackId === trackId);
    assert.ok(linePath);
    return getZentrumSchematicLinePathData(linePath, small.edges, small.trackWidth);
  });
  const y = (data: string) => Number(data.split(" ")[2]);
  assert.equal(Math.abs(y(first) - y(second)), small.trackWidth);
});

test("a small plan widens its lanes only as far as the busiest corridor leaves room", () => {
  const tiny = ZENTRUM_SCHEMATIC_VIEWBOX.width / 10;
  const quiet = buildZentrumSchematicReading(corridorRuns(2), tiny);
  const busy = buildZentrumSchematicReading(corridorRuns(10), tiny);

  assert.ok(busy.trackWidth < quiet.trackWidth);
  assert.equal(
    busy.trackWidth * 10,
    buildZentrumSchematicReading(corridorRuns(20), tiny).trackWidth * 20,
  );
});

test("a resize redraws the lanes without laying them out again", () => {
  const layout = createZentrumSchematicReader()(corridorRuns(3));
  const draw = createZentrumSchematicDrawer();
  const wide = draw(layout, 1200);

  // A resize too small to show keeps the reading.
  assert.equal(draw(layout, 1201), wide);

  const narrow = draw(layout, 600);
  assert.notEqual(narrow, wide);
  assert.ok(narrow.trackWidth > wide.trackWidth);
  assert.equal(narrow.edges, wide.edges);
  assert.equal(narrow.layoutKey, wide.layoutKey);
});

test("does not reserve lanes for services that join later on a straight", () => {
  const line6Calls = [
    call("zkm", "7000059"),
    call("welfenstrasse", "7000060"),
    call("barbarossaplatz", "7000057"),
    call("ebertstrasse", "7000088"),
    call("hauptbahnhof", "7000089"),
  ];
  const reading = buildZentrumSchematicReading(
    drawn([
      board(departure("6", line6Calls), departure("3", line6Calls.slice(3), { id: "3-trip" })),
    ]),
  );
  const linePath = reading.linePaths.find(({ lineId }) => lineId === "6");
  assert.ok(linePath);

  const data = getZentrumSchematicLinePathData(linePath, reading.edges, reading.trackWidth);
  // Line 3 joins at Ebertstraße; line 6 keeps the lane it runs east of it on the one-lane corridors
  // before.
  assert.deepEqual(
    reading.edges.find(
      ({ from, to }) =>
        [from.id, to.id].includes("barbarossaplatz") && [from.id, to.id].includes("ebertstrasse"),
    )?.trackIds,
    ["6"],
  );
  assert.match(data, /A 10\.00 10\.00 0 0 0 208\.00 619\.50/);
  assert.match(data, /L 286\.00 619\.50 L 374\.00 619\.50 L 462\.00 619\.50$/);
});

test("rounds right-angle turns around the intersection of their offset lanes", () => {
  const cases = [
    {
      line3Calls: [
        call("werderstrasse", "7000083"),
        call("tivoli", "7000084"),
        call("poststrasse", "7000098"),
      ],
      companions: [
        departure("E", [call("werderstrasse", "7000083"), call("tivoli", "7000084")]),
        departure("6", [call("tivoli", "7000084"), call("poststrasse", "7000098")]),
      ],
      roundedCorner: "L 729.50 609.50 A 10.00 10.00 0 0 1 719.50 619.50",
    },
    {
      line3Calls: [
        call("kolpingplatz", "7000063"),
        call("ebertstrasse", "7000091"),
        call("hauptbahnhof", "7000089"),
      ],
      companions: [
        departure("6", [call("ebertstrasse", "7000091"), call("hauptbahnhof", "7000089")]),
      ],
      roundedCorner: "L 374.00 609.50 A 10.00 10.00 0 0 0 384.00 619.50",
    },
  ] as const;

  for (const { line3Calls, companions, roundedCorner } of cases) {
    const reading = buildZentrumSchematicReading(
      drawn([board(departure("3", line3Calls), ...companions)]),
    );
    const linePath = reading.linePaths.find(({ lineId }) => lineId === "3");
    assert.ok(linePath);

    assert.ok(
      getZentrumSchematicLinePathData(linePath, reading.edges, reading.trackWidth).includes(
        roundedCorner,
      ),
    );
  }
});

test("reads a right-angle turn as finite points a mark can ride", () => {
  // A mis-sampled bend would put the mark nowhere.
  const reading = buildZentrumSchematicReading(
    drawn([
      board(
        departure("3", [
          call("werderstrasse", "7000083"),
          call("tivoli", "7000084"),
          call("poststrasse", "7000098"),
        ]),
        departure("6", [call("tivoli", "7000084"), call("poststrasse", "7000098")]),
      ),
    ]),
  );
  const linePath = reading.linePaths.find(({ lineId }) => lineId === "3");
  assert.ok(linePath);
  const paths = reading.vehiclePathsByLineId.get("3");
  assert.ok(paths);

  for (const [edgeId, path] of paths) {
    assert.ok(
      path.points.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y)),
      `${edgeId} has a point off the plan`,
    );
    assert.ok(path.steps.every((step) => Number.isFinite(step)));
    assert.equal(path.points.length, path.steps.length);
  }
  // The corner the stroke rounds is on the ride.
  const throughTivoli = paths.get(getEdgeKey("tivoli", "werderstrasse"));
  assert.ok(throughTivoli);
  assert.ok(throughTivoli.points.some((point) => Math.hypot(point.x - 726, point.y - 616) < 20));
  assert.ok(paths.get(getEdgeKey("tivoli", "poststrasse")));
});

test("keeps every straight corridor in a multi-stop ride", () => {
  const reading = buildZentrumSchematicReading(
    drawn([
      board(
        departure("2", [
          call("muehlburger-tor", "7000039"),
          call("europaplatz", "7000037"),
          call("marktplatz", "7001003"),
          call("kronenplatz", "7001002"),
        ]),
      ),
    ]),
  );
  const paths = reading.vehiclePathsByLineId.get("2");
  assert.ok(paths);

  assert.ok(paths.get(getEdgeKey("muehlburger-tor", "europaplatz")));
  assert.ok(paths.get(getEdgeKey("europaplatz", "marktplatz")));
  assert.ok(paths.get(getEdgeKey("marktplatz", "kronenplatz")));
});

test("does not lend S51's southern branch to the same-coloured S5", () => {
  const reading = buildZentrumSchematicReading(
    drawn([
      board(
        departure("S5", [
          call("muehlburger-tor", "7000039", "1a"),
          call("europaplatz", "7001004"),
          call("marktplatz", "7001003"),
          call("kronenplatz", "7001002"),
          call("durlacher-tor", "7001001"),
        ]),
        departure("S51", [
          call("muehlburger-tor", "7000039", "1a"),
          call("europaplatz", "7001004"),
          call("marktplatz", "7001003"),
          call("marktplatz", "7001011"),
          call("ettlinger-tor", "7001012"),
          call("kongresszentrum", "7001013"),
          call("augartenstrasse", "7000074"),
          call("poststrasse", "7000098"),
          call("hauptbahnhof", "7000089"),
          call("albtalbahnhof", "7001201"),
        ]),
      ),
    ]),
  );

  const southernEdges = reading.edges.filter(({ from, to }) => from.y > 200 || to.y > 200);
  assert.ok(southernEdges.some(({ lineIds }) => lineIds.includes("S51")));
  assert.equal(
    southernEdges.some(({ lineIds }) => lineIds.includes("S5")),
    false,
  );
});

test("places a vehicle on the link its timings put it on, and keeps its direction", () => {
  const trip = departure(
    "S1",
    [
      {
        ...call("kronenplatz", "7001002"),
        scheduledArrivalTime: "2026-09-04T12:00:00+02:00",
        scheduledDepartureTime: "2026-09-04T12:00:00+02:00",
        delayMinutes: 0,
      },
      {
        ...call("marktplatz", "7001003"),
        scheduledArrivalTime: "2026-09-04T12:02:00+02:00",
        scheduledDepartureTime: "2026-09-04T12:02:00+02:00",
        delayMinutes: 0,
      },
      {
        ...call("europaplatz", "7001004"),
        scheduledArrivalTime: "2026-09-04T12:04:00+02:00",
        scheduledDepartureTime: "2026-09-04T12:04:00+02:00",
        delayMinutes: 0,
      },
    ],
    { id: "portal-trip", tripInstanceId: "portal-trip", delayMinutes: 0 },
  );

  const reading = buildZentrumSchematicReading(drawn([board(trip)]));
  const [vehicle] = getZentrumSchematicVehicles(
    reading,
    [trip],
    Date.parse("2026-09-04T12:01:00+02:00"),
    motions,
  );

  assert.equal(vehicle?.from.id, "kronenplatz");
  assert.equal(vehicle?.to.id, "marktplatz");
  assert.ok((vehicle?.progress ?? 0) > 0);
  assert.ok((vehicle?.progress ?? 1) < 1);
  // The mark points the way the vehicle goes.
  assert.equal(
    vehicle?.angle,
    (Math.atan2(vehicle.to.y - vehicle.from.y, vehicle.to.x - vehicle.from.x) * 180) / Math.PI,
  );
});

test("places a vehicle on the nearest occurrence when a route visits a stop twice", () => {
  const timedCall = (localStopId: string, minute: number): TripCall => ({
    ...call(
      localStopId,
      localStopId === "marktplatz" && minute === 4
        ? "7001011"
        : ({
            europaplatz: "7001004",
            kronenplatz: "7001002",
            marktplatz: "7001003",
          }[localStopId] ?? `provider-${localStopId}-${minute}`),
    ),
    scheduledArrivalTime: `2026-09-04T12:0${minute}:00+02:00`,
    scheduledDepartureTime: `2026-09-04T12:0${minute}:00+02:00`,
    delayMinutes: 0,
  });
  const trip = departure(
    "S1",
    [
      timedCall("marktplatz", 0),
      timedCall("europaplatz", 2),
      timedCall("marktplatz", 4),
      timedCall("kronenplatz", 6),
    ],
    { id: "zentrum-repeated-stop", tripInstanceId: "zentrum-repeated-stop" },
  );
  const reading = buildZentrumSchematicReading(drawn([board(trip)]));

  const [vehicle] = getZentrumSchematicVehicles(
    reading,
    [trip],
    Date.parse("2026-09-04T12:05:00+02:00"),
    motions,
  );

  assert.ok(vehicle);
  assert.equal(vehicle.from.id, "marktplatz");
  assert.equal(vehicle.to.id, "kronenplatz");
  assert.deepEqual(
    vehicle.path.corridorRanges.map(({ corridorId }) => corridorId),
    [getEdgeKey("marktplatz", "kronenplatz")],
  );
});

test("keeps line 5 on its arriving lane between Europaplatz platforms", () => {
  const timedCall = (stopId: string, providerId: string, platform: string, minute: number) => ({
    ...call(stopId, providerId, platform),
    scheduledArrivalTime: `2026-09-04T12:0${minute}:00+02:00`,
    scheduledDepartureTime: `2026-09-04T12:0${minute}:00+02:00`,
    delayMinutes: 0,
  });
  const trip = departure(
    "5",
    run([
      timedCall("karlstor", "7000061", "1", 0),
      timedCall("europaplatz", "7000037", "3", 2),
      timedCall("europaplatz", "7000037", "5", 3),
      timedCall("europaplatz-muehlburger-tor-wende--1xjn1ol", "7000038", "3", 4),
    ]),
    { id: "five-arriving", tripInstanceId: "five-arriving" },
  );
  const neighbor = departure("3", [
    call("karlstor", "7000061", "3"),
    call("europaplatz", "7000037", "3"),
    call("europaplatz", "7000037", "5"),
    call("muehlburger-tor", "7000039", "1a"),
  ]);
  const reading = buildZentrumSchematicReading([trip, neighbor]);
  const runMotions = createRunMotions();
  const [arriving] = getZentrumSchematicVehicles(
    reading,
    [trip],
    Date.parse("2026-09-04T12:01:59+02:00"),
    runMotions,
  );
  const [parked] = getZentrumSchematicVehicles(
    reading,
    [trip],
    Date.parse("2026-09-04T12:02:30+02:00"),
    runMotions,
  );
  assert.ok(arriving && parked);
  const halt = arriving.path.points.at(-1);
  assert.ok(halt);
  assert.deepEqual({ x: parked.x, y: parked.y }, { x: halt.x, y: halt.y });
  assert.equal(parked.angle, getZentrumSchematicVehiclePathPlacement(arriving.path, 1).angle);
});

test("keeps a vehicle standing before its Zentrum run starts", () => {
  const calls = run([
    {
      ...call("kronenplatz", "7001002"),
      scheduledArrivalTime: "2026-09-04T12:00:00+02:00",
      scheduledDepartureTime: "2026-09-04T12:00:00+02:00",
      delayMinutes: 0,
    },
    {
      ...call("marktplatz", "7001003"),
      scheduledArrivalTime: "2026-09-04T12:02:00+02:00",
      scheduledDepartureTime: "2026-09-04T12:02:00+02:00",
      delayMinutes: 0,
    },
    {
      ...call("europaplatz", "7001004"),
      scheduledArrivalTime: "2026-09-04T12:04:00+02:00",
      scheduledDepartureTime: "2026-09-04T12:04:00+02:00",
      delayMinutes: 0,
    },
  ]);
  const trip = departure("zentrum-before-start", calls, {
    id: "zentrum-before-start",
    tripInstanceId: "zentrum-before-start@today",
  });
  const reading = buildZentrumSchematicReading(drawn([board(trip)]));

  const [vehicle] = getZentrumSchematicVehicles(
    reading,
    [trip],
    Date.parse("2026-09-04T11:56:00+02:00"),
    motions,
  );

  assert.equal(vehicle?.phase, "beforeStart");
  assert.equal(vehicle?.from.id, "kronenplatz");
  assert.equal(vehicle?.progress, 0);
  assert.equal(vehicle?.x, vehicle?.from.x);
  assert.equal(vehicle?.y, vehicle?.from.y);
});

test("keeps a vehicle standing after its Zentrum run ends", () => {
  const calls = run([
    {
      ...call("kronenplatz", "7001002"),
      scheduledArrivalTime: "2026-09-04T12:00:00+02:00",
      scheduledDepartureTime: "2026-09-04T12:00:00+02:00",
      delayMinutes: 0,
    },
    {
      ...call("marktplatz", "7001003"),
      scheduledArrivalTime: "2026-09-04T12:02:00+02:00",
      scheduledDepartureTime: "2026-09-04T12:02:00+02:00",
      delayMinutes: 0,
    },
    {
      ...call("europaplatz", "7001004"),
      scheduledArrivalTime: "2026-09-04T12:04:00+02:00",
      scheduledDepartureTime: "2026-09-04T12:04:00+02:00",
      delayMinutes: 0,
    },
  ]);
  const trip = departure("zentrum-after-end", calls, {
    id: "zentrum-after-end",
    tripInstanceId: "zentrum-after-end@today",
  });
  const reading = buildZentrumSchematicReading(drawn([board(trip)]));

  const [vehicle] = getZentrumSchematicVehicles(
    reading,
    [trip],
    Date.parse("2026-09-04T12:04:30+02:00"),
    motions,
  );

  assert.equal(vehicle?.phase, "afterEnd");
  assert.equal(vehicle?.to.id, "europaplatz");
  assert.equal(vehicle?.progress, 1);
  assert.equal(vehicle?.x, vehicle?.to.x);
  assert.equal(vehicle?.y, vehicle?.to.y);
});

test("keeps one stable marker through a Zentrum turnaround", () => {
  const arriving = departure(
    "2",
    run([
      {
        ...call("muehlburger-tor", "7000039"),
        scheduledArrivalTime: "2026-09-04T12:00:00+02:00",
        scheduledDepartureTime: "2026-09-04T12:00:00+02:00",
        delayMinutes: 0,
      },
      {
        ...call("europaplatz", "7000037"),
        scheduledArrivalTime: "2026-09-04T12:02:00+02:00",
        scheduledDepartureTime: "2026-09-04T12:02:00+02:00",
        delayMinutes: 0,
      },
      {
        ...call("karlstor", "7000061"),
        scheduledArrivalTime: "2026-09-04T12:04:00+02:00",
        scheduledDepartureTime: "2026-09-04T12:04:00+02:00",
        delayMinutes: 0,
      },
    ]),
    { id: "zentrum-arrival", tripInstanceId: "zentrum-arrival@today" },
  );
  const departing = departure(
    "2",
    run([
      {
        ...call("karlstor", "7000061"),
        scheduledArrivalTime: "2026-09-04T12:10:00+02:00",
        scheduledDepartureTime: "2026-09-04T12:10:00+02:00",
        delayMinutes: 0,
      },
      {
        ...call("europaplatz", "7000037"),
        scheduledArrivalTime: "2026-09-04T12:12:00+02:00",
        scheduledDepartureTime: "2026-09-04T12:12:00+02:00",
        delayMinutes: 0,
      },
      {
        ...call("muehlburger-tor", "7000039"),
        scheduledArrivalTime: "2026-09-04T12:14:00+02:00",
        scheduledDepartureTime: "2026-09-04T12:14:00+02:00",
        delayMinutes: 0,
      },
    ]),
    { id: "zentrum-departure", tripInstanceId: "zentrum-departure@today" },
  );
  const reading = buildZentrumSchematicReading(drawn([board(arriving, departing)]));

  const vehicles = getZentrumSchematicVehicles(
    reading,
    [arriving, departing],
    Date.parse("2026-09-04T12:06:00+02:00"),
    motions,
  );

  assert.deepEqual(
    vehicles.map(({ id, markerKey, phase, from }) => [id, markerKey, phase, from.id]),
    [["zentrum-departure@today", "zentrum-departure@today", "beforeStart", "karlstor"]],
  );

  // Before the arrival gets in, the arriving tram is the one marker; its stand waits.
  const approaching = getZentrumSchematicVehicles(
    reading,
    [arriving, departing],
    Date.parse("2026-09-04T12:03:00+02:00"),
    createRunMotions(),
  );
  assert.deepEqual(
    approaching.map(({ id, markerKey, phase }) => [id, markerKey, phase]),
    [["zentrum-arrival@today", "zentrum-departure@today", "running"]],
  );
});

/* Both directions of a line hold one lane, so meeting trams briefly overlap. */
test("marks ride their line's lane, either way along the corridor", () => {
  const timedCall = (
    localStopId: string,
    providerStopPointId: string,
    minute: number,
  ): TripCall => ({
    ...call(localStopId, providerStopPointId),
    scheduledArrivalTime: `2026-09-04T12:0${minute}:00+02:00`,
    scheduledDepartureTime: `2026-09-04T12:0${minute}:00+02:00`,
    delayMinutes: 0,
  });
  const westbound = departure(
    "S1",
    [
      timedCall("kronenplatz", "7001002", 0),
      timedCall("marktplatz", "7001003", 2),
      timedCall("europaplatz", "7001004", 4),
    ],
    { id: "westbound", tripInstanceId: "westbound", delayMinutes: 0 },
  );
  const eastbound = departure(
    "S1",
    [
      timedCall("europaplatz", "7001004", 0),
      timedCall("marktplatz", "7001003", 2),
      timedCall("kronenplatz", "7001002", 4),
    ],
    { id: "eastbound", tripInstanceId: "eastbound", delayMinutes: 0 },
  );
  const tram = departure(
    "2",
    [timedCall("kronenplatz", "7001002", 0), timedCall("marktplatz", "7001003", 2)],
    { id: "tram", tripInstanceId: "tram", delayMinutes: 0 },
  );

  const reading = buildZentrumSchematicReading(drawn([board(westbound, eastbound, tram)]));
  const [west] = getZentrumSchematicVehicles(
    reading,
    [westbound],
    Date.parse("2026-09-04T12:01:00+02:00"),
    motions,
  );
  const [east] = getZentrumSchematicVehicles(
    reading,
    [eastbound],
    Date.parse("2026-09-04T12:03:00+02:00"),
    motions,
  );
  const [tramMark] = getZentrumSchematicVehicles(
    reading,
    [tram],
    Date.parse("2026-09-04T12:01:00+02:00"),
    motions,
  );

  // One level corridor, walked both ways.
  assert.equal(west?.from.id, "kronenplatz");
  assert.equal(west?.to.id, "marktplatz");
  assert.equal(east?.from.id, "marktplatz");
  assert.equal(east?.to.id, "kronenplatz");

  const corridorY = west.from.y;
  assert.equal(corridorY, west.to.y);
  // Both marks stand on the line's lane.
  assert.equal(west.y, east.y);
  assert.notEqual(west.y, corridorY);
  // Along the lane, each mark is where its timing puts it.
  assert.equal(west.x, west.from.x + (west.to.x - west.from.x) * west.progress);
  assert.equal(east.x, east.from.x + (east.to.x - east.from.x) * east.progress);
  // Another line holds its own lane.
  assert.notEqual(tramMark?.y, west.y);
  assert.equal(
    tramMark?.x,
    tramMark.from.x + (tramMark.to.x - tramMark.from.x) * tramMark.progress,
  );
});

/* Marks ride the drawn stroke, so rides on two corridors meet on the stop's capsule. */
test("hands a mark over between corridors exactly where its line's stroke turns", () => {
  const timedCall = (
    localStopId: string,
    providerStopPointId: string,
    minute: number,
  ): TripCall => ({
    ...call(localStopId, providerStopPointId),
    scheduledArrivalTime: `2026-09-04T12:0${minute}:00+02:00`,
    scheduledDepartureTime: `2026-09-04T12:0${minute}:00+02:00`,
    delayMinutes: 0,
  });
  const through = departure(
    "2",
    [
      timedCall("muehlburger-tor", "7000039", 0),
      timedCall("europaplatz", "7000037", 2),
      timedCall("karlstor", "7000061", 4),
    ],
    { id: "ride-through", tripInstanceId: "ride-through", delayMinutes: 0 },
  );

  const reading = buildZentrumSchematicReading(drawn([board(through)]));
  // Just before and just after Europaplatz.
  const [arriving] = getZentrumSchematicVehicles(
    reading,
    [through],
    Date.parse("2026-09-04T12:01:59+02:00"),
    motions,
  );
  const [departing] = getZentrumSchematicVehicles(
    reading,
    [through],
    Date.parse("2026-09-04T12:02:01+02:00"),
    motions,
  );
  assert.equal(arriving?.to.id, "europaplatz");
  assert.equal(departing?.from.id, "europaplatz");

  // The arriving ride ends where the departing one begins, on the capsule.
  const last = arriving.path.points.at(-1);
  const first = departing.path.points[0];
  assert.ok(last && first);
  assert.equal(last.x, first.x);
  assert.equal(last.y, first.y);
  // The handover moves nothing.
  assert.ok(Math.hypot(arriving.x - first.x, arriving.y - first.y) < 4);
});

test("parks a mark inside a stop complex, pointing the way out", () => {
  // The S1 crossing between Marktplatz's tunnels has no corridor; the mark parks where the leaving
  // corridor's lane begins, facing its way out.
  const timedCall = (
    localStopId: string,
    providerStopPointId: string,
    minute: number,
  ): TripCall => ({
    ...call(localStopId, providerStopPointId),
    scheduledArrivalTime: `2026-09-04T12:0${minute}:00+02:00`,
    scheduledDepartureTime: `2026-09-04T12:0${minute}:00+02:00`,
    delayMinutes: 0,
  });
  const crossing = departure(
    "S1",
    [
      timedCall("ettlinger-tor", "7001012", 0),
      timedCall("marktplatz", "7001011", 2),
      timedCall("marktplatz", "7001003", 4),
      timedCall("europaplatz", "7001004", 6),
    ],
    { id: "tunnel-crossing", tripInstanceId: "tunnel-crossing", delayMinutes: 0 },
  );

  const reading = buildZentrumSchematicReading(drawn([board(crossing)]));
  const [parked] = getZentrumSchematicVehicles(
    reading,
    [crossing],
    Date.parse("2026-09-04T12:03:00+02:00"),
    motions,
  );

  assert.ok(parked);
  assert.equal(parked.from.id, "marktplatz");
  assert.equal(parked.to.id, "marktplatz");
  assert.equal(parked.path.points.length, 1);
  // Parked where the corridor out begins its lane, not on the stop.
  const leavingPath = reading.vehiclePathsByLineId
    .get("S1")
    ?.get(getEdgeKey("marktplatz", "europaplatz"));
  assert.ok(leavingPath);
  const oriented =
    leavingPath.fromNodeId === "marktplatz"
      ? leavingPath
      : reverseZentrumSchematicCorridorPath(leavingPath);
  assert.equal(parked.path.points[0]?.x, oriented.points[0].x);
  assert.equal(parked.path.points[0]?.y, oriented.points[0].y);
  // Facing the way out.
  assert.ok(parked.angle !== 0);
  const heading = getZentrumSchematicVehiclePathPlacement(oriented, 0).angle;
  assert.equal(parked.angle, heading);
});

test("rides the line's lane through a stop the feed left untimed", () => {
  // An untimed call between two timed ones: the mark follows the lane through the stop, not a
  // chord.
  const timedCall = (
    localStopId: string,
    providerStopPointId: string,
    minute: number | undefined,
  ): TripCall => ({
    ...call(localStopId, providerStopPointId),
    scheduledArrivalTime: minute === undefined ? undefined : `2026-09-04T12:0${minute}:00+02:00`,
    scheduledDepartureTime: minute === undefined ? undefined : `2026-09-04T12:0${minute}:00+02:00`,
    delayMinutes: 0,
  });
  const past = departure(
    "2",
    [
      timedCall("muehlburger-tor", "7000039", 0),
      timedCall("europaplatz", "7000037", undefined),
      timedCall("karlstor", "7000061", 4),
    ],
    { id: "untimed-stop", tripInstanceId: "untimed-stop", delayMinutes: 0 },
  );

  const reading = buildZentrumSchematicReading(drawn([board(past)]));
  const [vehicle] = getZentrumSchematicVehicles(
    reading,
    [past],
    Date.parse("2026-09-04T12:01:00+02:00"),
    motions,
  );

  assert.ok(vehicle);
  assert.equal(vehicle.from.id, "muehlburger-tor");
  assert.equal(vehicle.to.id, "karlstor");
  // The ride passes through Europaplatz.
  const europaplatz = ZENTRUM_SCHEMATIC_NODES.find(({ id }) => id === "europaplatz");
  assert.ok(europaplatz);
  assert.ok(
    vehicle.path.points.some(
      (point) => Math.hypot(point.x - europaplatz.x, point.y - europaplatz.y) < 20,
    ),
  );
});

test("lights the corridors ahead of a placed vehicle, and none behind it", () => {
  const timedCall = (
    localStopId: string,
    providerStopPointId: string,
    minute: number,
  ): TripCall => ({
    ...call(localStopId, providerStopPointId),
    scheduledArrivalTime: `2026-09-04T12:0${minute}:00+02:00`,
    scheduledDepartureTime: `2026-09-04T12:0${minute}:00+02:00`,
    delayMinutes: 0,
  });
  const eastbound = departure(
    "S1",
    [
      timedCall("europaplatz", "7001004", 0),
      timedCall("marktplatz", "7001003", 2),
      timedCall("kronenplatz", "7001002", 4),
    ],
    { id: "ahead-eastbound", tripInstanceId: "ahead-eastbound", delayMinutes: 0 },
  );
  const reading = buildZentrumSchematicReading(drawn([board(eastbound)]));
  const [vehicle] = getZentrumSchematicVehicles(
    reading,
    [eastbound],
    Date.parse("2026-09-04T12:01:00+02:00"),
    motions,
  );
  assert.deepEqual([...(vehicle?.aheadCorridorIds ?? [])].sort(), [
    "europaplatz\u0000marktplatz",
    "kronenplatz\u0000marktplatz",
  ]);

  // Past Marktplatz the corridor behind is out; the one ahead is lit.
  const [past] = getZentrumSchematicVehicles(
    reading,
    [eastbound],
    Date.parse("2026-09-04T12:03:00+02:00"),
    motions,
  );
  assert.deepEqual([...(past?.aheadCorridorIds ?? [])], ["kronenplatz\u0000marktplatz"]);
});

test("paints a line crossing a wider band over it, whatever its number", () => {
  const east = [call("kronenplatz", "7000002"), call("durlacher-tor", "7001001")];
  const reading = buildZentrumSchematicReading(
    drawn([
      board(
        departure("S2", [...east, call("gottesauer-platz", "7000004")], { id: "s2", tripId: "s2" }),
        departure("S5", [...east, call("gottesauer-platz", "7000004")], { id: "s5", tripId: "s5" }),
        departure("1", [...east, call("gottesauer-platz", "7000004")]),
        departure("4", [
          call("rueppurrer-tor", "7000066"),
          call("durlacher-tor", "7000003"),
          call("karl-wilhelm-platz", "7000005"),
        ]),
      ),
    ]),
  );

  // Under the band it would vanish for the band's width; over it, the band is hidden by one lane.
  assert.deepEqual(
    reading.drawnPaths.map(({ lineIds }) => lineIds.join("+")),
    ["1", "S2", "S5", "4"],
  );
});

/* One stretch per corridor, turns going with the corridor entered, joining into the path. */
test("splits a drawn line at the stops without losing or repeating any of it", () => {
  const reading = buildZentrumSchematicReading(
    drawn([
      board(
        departure(
          "S11",
          [
            call("muehlburger-tor", "7000039"),
            call("europaplatz", "7000037"),
            call("karlstor", "7000061"),
          ],
          { id: "s11", tripId: "s11" },
        ),
      ),
    ]),
  );
  const [linePath] = reading.linePaths;
  const drawnPath = reading.drawnPaths.find(({ lineIds }) => lineIds.includes("S11"));
  assert.ok(linePath && drawnPath);

  const { segments } = drawnPath;
  assert.deepEqual(
    segments.map(({ corridorId }) => corridorId),
    ["europaplatz\u0000muehlburger-tor", "europaplatz\u0000karlstor"],
  );
  const pointsOf = (data: string) =>
    [...data.matchAll(/[ML] ([\d.-]+) ([\d.-]+)/g)].map(([, x, y]) => ({
      x: Number(x),
      y: Number(y),
    }));
  const [west, south] = segments.map(({ data }) => pointsOf(data));
  // The stretches meet without gaps or overlap...
  assert.deepEqual(west.at(-1), south[0]);
  const whole = getZentrumSchematicLinePathData(linePath, reading.edges, reading.trackWidth);
  assert.ok(whole.startsWith(`M ${west[0].x.toFixed(2)} ${west[0].y.toFixed(2)} `));
  assert.ok(whole.endsWith(` ${south.at(-1)?.x.toFixed(2)} ${south.at(-1)?.y.toFixed(2)}`));
  // ...on Europaplatz's capsule, where marks halt.
  const [capsule] =
    reading.stopMarks.find(({ nodeId }) => nodeId === "europaplatz")?.capsules ?? [];
  assert.ok(capsule);
  const cut = south[0];
  assert.ok(
    Math.abs(
      (capsule.to.x - capsule.from.x) * (cut.y - capsule.from.y) -
        (capsule.to.y - capsule.from.y) * (cut.x - capsule.from.x),
    ) < 0.1,
  );
});

test("ends a line that turns back at a stop on that stop's capsule", () => {
  const reading = buildZentrumSchematicReading(
    drawn([
      board(
        departure("6", [call("poststrasse", "7001017"), call("tivoli", "7001018")]),
        departure("3", [
          call("poststrasse", "7001017"),
          call("tivoli", "7001018"),
          call("werderstrasse", "7001019"),
        ]),
        departure("E", [call("werderstrasse", "7001019"), call("tivoli", "7001020")]),
      ),
    ]),
  );
  const capsules = reading.stopMarks.find(({ nodeId }) => nodeId === "tivoli")?.capsules ?? [];
  for (const lineId of ["6", "E"]) {
    const data = reading.drawnPaths.find(({ lineIds }) => lineIds.includes(lineId))?.data ?? "";
    const [, x, y] = data.match(/([\d.-]+) ([\d.-]+)$/) ?? [];
    const end = { x: Number(x), y: Number(y) };
    assert.ok(
      capsules.some(
        ({ from, to }) =>
          Math.abs((to.x - from.x) * (end.y - from.y) - (to.y - from.y) * (end.x - from.x)) < 0.5 &&
          Math.min(from.x, to.x) - 0.01 <= end.x &&
          end.x <= Math.max(from.x, to.x) + 0.01 &&
          Math.min(from.y, to.y) - 0.01 <= end.y &&
          end.y <= Math.max(from.y, to.y) + 0.01,
      ),
      `${lineId} ends at ${data}`,
    );
  }
});

test("cuts the highlighted path at a vehicle's position inside a corridor", () => {
  const ride = {
    points: [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ],
    steps: [0, 0.5, 1],
  };

  assert.equal(
    getZentrumSchematicVehiclePathData(ride, 0.25),
    "M 5.00 0.00 L 10.00 0.00 L 10.00 10.00",
  );
  assert.equal(getZentrumSchematicVehiclePathData(ride, 1), "");
});

/*
 * The authored layout, checked against itself: an off-grid node or a crowded label fails silently
 * in the app. `npm run solve:zentrum` checks it against the feed.
 */
test("a node is a Zentrum stop, and every Zentrum stop has one", () => {
  const nodeIds = ZENTRUM_SCHEMATIC_NODES.map((node) => node.id);

  assert.equal(new Set(nodeIds).size, nodeIds.length);
  assert.deepEqual(
    ZENTRUM_SCHEMATIC_NODES.filter((node) => !isZentrumStop(node.stopId ?? node.id)),
    [],
  );
  assert.deepEqual(
    zentrumStopIds.filter((stopId) => !nodeIds.includes(stopId)),
    [],
  );
});

test("every node stands on the grid the plan's angles depend on", () => {
  assert.deepEqual(
    ZENTRUM_SCHEMATIC_NODES.filter(
      (node) => node.x % ZENTRUM_SCHEMATIC_GRID !== 0 || node.y % ZENTRUM_SCHEMATIC_GRID !== 0,
    ).map((node) => node.id),
    [],
  );
});

test("every node is drawn inside the window the plan is cropped to", () => {
  const { x, y, width, height } = ZENTRUM_SCHEMATIC_VIEWBOX;
  assert.deepEqual(
    ZENTRUM_SCHEMATIC_NODES.filter(
      (node) => node.x < x || node.y < y || node.x > x + width || node.y > y + height,
    ).map((node) => node.id),
    [],
  );
});

/* The separation the layout was solved for; closer places cannot both carry a legible name. */
test("no two places stand closer than the step and a half the layout keeps", () => {
  const minimum = ZENTRUM_SCHEMATIC_GRID * 1.5;
  const tooClose = ZENTRUM_SCHEMATIC_NODES.flatMap((node, index) =>
    ZENTRUM_SCHEMATIC_NODES.slice(index + 1)
      .filter((other) => Math.hypot(node.x - other.x, node.y - other.y) < minimum)
      .map((other) => `${node.id} · ${other.id}`),
  );
  assert.deepEqual(tooClose, []);
});

/*
 * Lines 3 and 4 run the Kaiserstraße together and part only at Karlstor (3 south, 4 east), so the
 * order they need there must hold two corridors earlier.
 */
test("orders a corridor for a parting its lines have not reached yet", () => {
  const reading = buildZentrumSchematicReading(
    drawn([
      board(
        departure("3", [
          call("muehlburger-tor", "7000039"),
          call("europaplatz", "7001004"),
          call("karlstor", "7000061"),
          call("mathystrasse", "7000062"),
        ]),
        departure("4", [
          call("muehlburger-tor", "7000039"),
          call("europaplatz", "7001004"),
          call("karlstor", "7000061"),
          call("ettlinger-tor", "7001012"),
        ]),
        departure("1", [
          call("muehlburger-tor", "7000039"),
          call("europaplatz", "7001004"),
          call("marktplatz", "7001003"),
        ]),
      ),
    ]),
  );
  const orderOn = (leftStopId: string, rightStopId: string) =>
    reading.edges.find(
      ({ from, to }) =>
        [from.id, to.id].includes(leftStopId) && [from.id, to.id].includes(rightStopId),
    )?.trackIds ?? [];

  // 4 leaves east, so it holds the Kriegsstraße's eastern lane; line 1, which does not turn, is
  // north of both.
  assert.deepEqual(orderOn("europaplatz", "karlstor"), ["4", "3"]);
  assert.deepEqual(orderOn("muehlburger-tor", "europaplatz"), ["1", "4", "3"]);
});

/*
 * S-Bahnen from east and west both turn south at Marktplatz and then share every corridor; fixing
 * one corridor breaks the next, so groups must be carried as blocks.
 */
test("keeps groups joining a corridor from opposite sides from weaving down it", () => {
  const marktplatz = call("marktplatz", "7001003");
  const ettlinger = call("ettlinger-tor", "7001012");
  const kongress = call("kongresszentrum", "7001013");
  const fromWest = [call("europaplatz", "7001004"), marktplatz, ettlinger, kongress];
  const fromEast = [call("kronenplatz", "7001002"), marktplatz, ettlinger, kongress];
  const reading = buildZentrumSchematicReading(
    drawn([
      board(
        departure("1", [
          call("kronenplatz", "7001002"),
          marktplatz,
          call("europaplatz", "7001004"),
        ]),
        departure("S1", fromWest, { id: "s1", tripId: "s1" }),
        departure("S2", fromWest, { id: "s2", tripId: "s2" }),
        departure("S4", fromEast, { id: "s4", tripId: "s4" }),
        departure("S8", fromEast, { id: "s8", tripId: "s8" }),
      ),
    ]),
  );
  const orderOn = (leftStopId: string, rightStopId: string) =>
    reading.edges.find(
      ({ from, to }) =>
        [from.id, to.id].includes(leftStopId) && [from.id, to.id].includes(rightStopId),
    )?.trackIds ?? [];

  // Lanes are numbered west-first: the eastern pair holds the eastern lanes, so neither group
  // crosses.
  assert.deepEqual(orderOn("marktplatz", "ettlinger-tor"), ["S4", "S8", "S1", "S2"]);
  assert.deepEqual(orderOn("ettlinger-tor", "kongresszentrum"), ["S4", "S8", "S1", "S2"]);
  // East of Marktplatz the turning pair rides south of line 1, the side they turn to.
  assert.deepEqual(orderOn("kronenplatz", "marktplatz").indexOf("1"), 0);
});

test("a complex has one authored stop name; boarding places come from observed platforms", () => {
  assert.equal(
    ZENTRUM_SCHEMATIC_NODES.filter((node) => (node.stopId ?? node.id) === "tullastrasse").length,
    1,
  );
  assert.ok(!ZENTRUM_SCHEMATIC_NODES.some((node) => node.label === "Tullastraße (Nord)"));
});
