import assert from "node:assert/strict";
import test from "node:test";
import type { Departure, DepartureBoard, TripCall } from "../src/data/transit-types.ts";
import { isZentrumStop, zentrumStopIds } from "../src/data/zentrum-stops.ts";
import {
  type ZentrumSchematicReading,
  buildZentrumSchematicReading,
  getZentrumSchematicAheadEdgeIds,
  getZentrumSchematicVehicles,
} from "../src/lib/zentrum-schematic.ts";
import {
  ZENTRUM_SCHEMATIC_GRID,
  ZENTRUM_SCHEMATIC_NODES,
  ZENTRUM_SCHEMATIC_VIEWBOX,
} from "../src/lib/zentrum-schematic-plan.ts";
import {
  getZentrumSchematicLinePathData,
  getZentrumSchematicLinePathSegments,
} from "../src/lib/zentrum-schematic-paths.ts";
import { getZentrumSchematicStopMarks } from "../src/lib/zentrum-schematic-stops.ts";

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
): Departure => ({
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

test("reads only adjacent observed calls into schematic edges", () => {
  const reading = buildZentrumSchematicReading([
    board(
      departure("2", [
        call("muehlburger-tor", "7000039", "1a"),
        call("europaplatz", "7000037", "5"),
        call("outside", "7009999"),
        call("karlstor", "7000061", "1"),
      ]),
    ),
  ]);

  assert.deepEqual(
    reading.edges.map(({ from, to, lineIds }) => [from.id, to.id, lineIds]),
    [["europaplatz", "muehlburger-tor", ["2"]]],
  );
  assert.equal(reading.lineIdsByNodeId.has("karlstor"), false);
  assert.deepEqual(
    reading.linePaths.map(({ lineId, nodes }) => [lineId, nodes.map(({ id }) => id)]),
    [["2", ["muehlburger-tor", "europaplatz"]]],
  );
});

/*
 * The plan draws a stop as the one place a rider stands in, so a trip crossing between the parts of
 * a complex -- one Marktplatz tunnel to the other -- is a trip that has not gone anywhere the plan
 * can draw. It must not become a corridor from a place to itself, and it must not break the chain
 * either: the calls on both sides of it still meet the plan.
 */
test("crossing between the parts of one complex draws no corridor, and breaks no chain", () => {
  const reading = buildZentrumSchematicReading([
    board(
      departure("S1", [
        call("ettlinger-tor", "7001012"),
        call("marktplatz", "7001011"),
        call("marktplatz", "7001003"),
        call("europaplatz", "7001004"),
      ]),
    ),
  ]);

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
  const reading = buildZentrumSchematicReading([
    board(
      departure("2", [west, europa]),
      departure("2", [europa, west], { id: "second-2" }),
      departure("3", [west, europa]),
      departure("9", [west, europa], { status: "cancelled" }),
      departure("ICE", [west, europa], { transportMode: "other" }),
    ),
  ]);

  assert.deepEqual(reading.edges[0]?.lineIds, ["2", "3"]);
  assert.equal(reading.linePaths.filter(({ lineId }) => lineId === "2").length, 1);
});

test("draws only the path used by the most timetable trips for each line", () => {
  const west = call("muehlburger-tor", "7000039");
  const europa = call("europaplatz", "7000037");
  const market = call("marktplatz", "7001003");
  const kronen = call("kronenplatz", "7001002");
  const karlstor = call("karlstor", "7000061");
  const reading = buildZentrumSchematicReading([
    board(
      departure("S5", [west, europa, market, kronen], { id: "main-1", tripId: "main-1" }),
      departure("S5", [kronen, market, europa, west], { id: "main-2", tripId: "main-2" }),
      departure("S5", [west, europa, karlstor], { id: "branch", tripId: "branch" }),
    ),
  ]);

  assert.deepEqual(
    reading.linePaths.map(({ lineId, nodes }) => [lineId, nodes.map(({ id }) => id)]),
    [["S5", ["muehlburger-tor", "europaplatz", "marktplatz", "kronenplatz"]]],
  );
  // The reading remains honest about the less-used observed service; only its coloured line is
  // omitted from the overview.
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
      buildZentrumSchematicReading(orderedBoards).linePaths[0]?.nodes.map(({ id }) => id),
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
  const reading = buildZentrumSchematicReading([
    board(
      departure("2", wholeCorridor),
      departure("1", wholeCorridor.slice(0, 2), { id: "1-trip" }),
      departure("3", wholeCorridor.slice(1), { id: "3-trip" }),
    ),
  ]);
  const linePath = reading.linePaths.find(({ lineId }) => lineId === "2");
  assert.ok(linePath);

  const data = getZentrumSchematicLinePathData(linePath, reading.edges, reading.trackWidth);
  // Line 1 leaves and line 3 joins at Europaplatz. Neither reserves an invisible lane on the edge
  // where it is absent, and the through line holds the one lane it has been running: the narrower
  // corridor hangs its band off the through lane's continuing position, so line 2 is the same line
  // on both sides of the stop, and the companions keep the lanes either side of it.
  assert.match(data, /^M 110\.00 150\.50 /);
  assert.match(data, /L 374\.00 150\.50 L 572\.00 150\.50$/);
  const westCorridor = reading.edges.find(
    ({ from, to }) =>
      [from.id, to.id].includes("muehlburger-tor") && [from.id, to.id].includes("europaplatz"),
  );
  assert.ok(westCorridor);
  assert.equal(westCorridor.trackBandOffset, -reading.trackWidth);
  assert.equal(
    reading.edges.find(
      ({ from, to }) =>
        [from.id, to.id].includes("europaplatz") && [from.id, to.id].includes("marktplatz"),
    )?.trackBandOffset,
    0,
  );
});

/*
 * S1 and S11 are one service to anybody in the Zentrum, and KVV prints them in one colour because
 * what they differ over is an hour out of town. So they are drawn as one -- while S4 and S41, which
 * share a trunk number and nothing else, keep the lanes and the colours the operator gives them.
 */
test("draws a trunk and its branches as one lane on the corridors they share", () => {
  const west = call("muehlburger-tor", "7000039");
  const europa = call("europaplatz", "7000037");
  const market = call("marktplatz", "7001003");
  const karlstor = call("karlstor", "7000061");
  const reading = buildZentrumSchematicReading([
    board(
      departure("2", [west, europa, karlstor]),
      departure("S1", [west, europa, market], { id: "s1", tripId: "s1" }),
      departure("S11", [west, europa, market], { id: "s11", tripId: "s11" }),
      departure("S5", [europa, market], { id: "s5", tripId: "s5" }),
      departure("S51", [europa, market], { id: "s51", tripId: "s51" }),
      departure("S4", [europa, market], { id: "s4", tripId: "s4" }),
      departure("S41", [europa, market], { id: "s41", tripId: "s41" }),
    ),
  ]);
  const sharedEdge = reading.edges.find(
    ({ from, to }) =>
      [from.id, to.id].includes("europaplatz") && [from.id, to.id].includes("marktplatz"),
  );
  assert.ok(sharedEdge);

  // Every line is still observed on the corridor and still has its own drawn pattern: what they
  // share is the lane, and only where the operator signs them as one service.
  assert.deepEqual(sharedEdge.lineIds, ["S1", "S4", "S5", "S11", "S41", "S51"]);
  assert.deepEqual([...sharedEdge.trackLineIds].sort(), ["S1", "S4", "S41", "S5"]);
  assert.equal(sharedEdge.trackLineIds.includes("2"), false);
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

/*
 * Sharing a lane is not being merged into one line. The branch keeps its own observed pattern, so
 * the two run together only as far as they were seen running together and part where they part.
 */
test("parts a branch from its trunk where their observed patterns part", () => {
  const west = call("muehlburger-tor", "7000039");
  const europa = call("europaplatz", "7000037");
  const market = call("marktplatz", "7001003");
  const karlstor = call("karlstor", "7000061");
  const reading = buildZentrumSchematicReading([
    board(
      departure("S1", [west, europa, market], { id: "s1", tripId: "s1" }),
      departure("S11", [west, europa, karlstor], { id: "s11", tripId: "s11" }),
      departure("2", [west, europa, market], { id: "2-trip", tripId: "2-trip" }),
    ),
  ]);
  const orderOn = (leftStopId: string, rightStopId: string) =>
    reading.edges.find(
      ({ from, to }) =>
        [from.id, to.id].includes(leftStopId) && [from.id, to.id].includes(rightStopId),
    )?.trackLineIds ?? [];
  const pathData = new Map(
    reading.linePaths.map((linePath) => [
      linePath.lineId,
      getZentrumSchematicLinePathData(linePath, reading.edges, reading.trackWidth),
    ]),
  );

  // One lane for the pair west of the Europaplatz, and it is the same lane both of them start in.
  assert.deepEqual([...orderOn("muehlburger-tor", "europaplatz")].sort(), ["2", "S1"]);
  assert.ok(pathData.get("S1")?.startsWith("M 110.00 157.50"));
  assert.ok(pathData.get("S11")?.startsWith("M 110.00 157.50"));
  assert.notEqual(pathData.get("S1"), pathData.get("S11"));
  // South of the Europaplatz only the branch runs, and it has that corridor to itself.
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
  const reading = buildZentrumSchematicReading([
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
  ]);
  const orderOn = (leftStopId: string, rightStopId: string) =>
    reading.edges.find(
      ({ from, to }) =>
        [from.id, to.id].includes(leftStopId) && [from.id, to.id].includes(rightStopId),
    )?.trackLineIds ?? [];
  const assertAdjacent = (order: readonly string[], leftLineId: string, rightLineId: string) =>
    assert.equal(Math.abs(order.indexOf(leftLineId) - order.indexOf(rightLineId)), 1);

  // These are route affinities, not named exceptions: the same rule discovers both pairs from the
  // edges their current trips share, even though numerically sorted lines would split 1 from S2.
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
  const reading = buildZentrumSchematicReading([
    board(
      departure("1", [west, europa, market, kronen, durlach, call("gottesauer-platz", "7000041")]),
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
  ]);

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

  // A later branch on the same side nests inside an earlier one: Karl-Wilhelm is above the
  // eastbound line, Augartenstraße leaves below that at Marktplatz, and Karlstor leaves furthest
  // below at Europaplatz. No line has to cross another to reach its branch.
  assert.deepEqual(westCorridor?.trackLineIds, ["3", "1", "4", "2"]);
  assert.match(pathData.get("3") ?? "", /^M 110\.00 143\.50 /);
  assert.match(pathData.get("1") ?? "", /^M 110\.00 150\.50 /);
  assert.match(pathData.get("4") ?? "", /^M 110\.00 157\.50 /);
  assert.match(pathData.get("2") ?? "", /^M 110\.00 164\.50 /);
});

/*
 * Lines sharing a corridor share one pair of rails, and the drawing says so: the lanes are laid
 * exactly as far apart as they are wide, so the colours meet and the corridor reads as one band as
 * wide as the traffic it carries rather than as a set of services running near one another.
 */
test("lays neighbouring lanes exactly one lane width apart", () => {
  const west = call("muehlburger-tor", "7000039");
  const europa = call("europaplatz", "7000037");
  const market = call("marktplatz", "7001003");
  const reading = buildZentrumSchematicReading([
    board(
      departure("1", [west, europa, market]),
      departure("2", [west, europa, call("karlstor", "7000061")], { id: "2-trip" }),
      departure("3", [west, europa, market, call("kronenplatz", "7001002")], { id: "3-trip" }),
      departure("4", [west, europa, market, call("ettlinger-tor", "7001012")], { id: "4-trip" }),
    ),
  ]);
  const corridor = reading.edges.find(
    ({ from, to }) =>
      [from.id, to.id].includes("muehlburger-tor") && [from.id, to.id].includes("europaplatz"),
  );
  assert.ok(corridor);
  assert.equal(corridor.trackLineIds.length, 4);

  // The corridor runs level, so where each lane starts states how far apart the lanes are laid.
  const laneOffsets = corridor.trackLineIds.map((trackId) => {
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
  // And the band stays centred on the corridor the stops name, so a lane's neighbours changing
  // moves it sideways by lanes rather than moving the corridor.
  assert.equal((laneOffsets[0] + laneOffsets.at(-1)) / 2, 154);
});

/*
 * The Kaiserstraße is one corridor to the eye, drawn from corridors that carry different numbers
 * of lines. A corridor that re-centres its band on its own middle re-centres every line in it at
 * every stop, and the lines running along it step aside at each one. So a straight is anchored
 * once, at its busiest corridor, and a narrower straight hangs its lanes off the through lanes'
 * continuing positions: the two lines between the Europaplatz and the Marktplatz run at the top
 * of the band, level with the rest of the straight, instead of stepping down and back up.
 */
test("hangs a narrower straight off the top of the band its through lines run in", () => {
  const calls = (stopIds: readonly string[]) => stopIds.map((stopId) => call(stopId, "7000000"));
  const reading = buildZentrumSchematicReading([
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
        departure(lineId, calls(["durlacher-tor", "kronenplatz", "marktplatz", "ettlinger-tor"]), {
          id: `${lineId}-trip`,
          tripId: `${lineId}-trip`,
        }),
      ),
    ),
  ]);
  const pathData = new Map(
    reading.linePaths.map((linePath) => [
      linePath.lineId,
      getZentrumSchematicLinePathData(linePath, reading.edges, reading.trackWidth),
    ]),
  );

  // The through lines hold one line from the Mühlburger Tor to the Durlacher Tor, across both
  // stops, and the two-lane Europaplatz–Marktplatz corridor carries them where they arrive -- at
  // the top of its neighbours' band -- rather than re-centring them on its own middle.
  assert.equal(
    pathData.get("1"),
    "M 110.00 136.50 L 374.00 136.50 L 572.00 136.50 L 726.00 136.50 L 858.00 136.50",
  );
  assert.equal(
    pathData.get("2"),
    "M 110.00 143.50 L 374.00 143.50 L 572.00 143.50 L 726.00 143.50 L 858.00 143.50",
  );
  // And the lines turning off the straight bend on the side they leave it, into the lanes their
  // branches have to themselves.
  assert.match(pathData.get("3") ?? "", /^M 110\.00 150\.50 L 374\.50 150\.50 A /);
  assert.match(
    pathData.get("7") ?? "",
    /^M 858\.00 150\.50 L 726\.00 150\.50 L 571\.50 150\.50 A /,
  );
});

/*
 * A lane is only as wide as the drawing can afford, and every lane in it is that width: one width
 * for the whole plan is what lets a line be a single stroke, so a corridor busier than the band
 * thins the drawing rather than spilling over the corridors beside it.
 */
test("thins every lane together when a corridor outgrows the band", () => {
  const crowded = [call("muehlburger-tor", "7000039"), call("europaplatz", "7000037")];
  const busy = buildZentrumSchematicReading([
    board(
      ...["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((lineId) =>
        departure(lineId, crowded, { id: `${lineId}-trip` }),
      ),
    ),
  ]);
  const quiet = buildZentrumSchematicReading([
    board(...["1", "2"].map((lineId) => departure(lineId, crowded, { id: `${lineId}-trip` }))),
  ]);

  assert.equal(busy.edges[0]?.trackLineIds.length, 9);
  assert.ok(busy.trackWidth < quiet.trackWidth);
  assert.equal(busy.trackWidth * 9, quiet.trackWidth * 8);
});

test("does not reserve lanes for services that join later on a straight", () => {
  const line6Calls = [
    call("zkm", "7000059"),
    call("welfenstrasse", "7000060"),
    call("barbarossaplatz", "7000057"),
    call("ebertstrasse", "7000088"),
    call("hauptbahnhof", "7000089"),
  ];
  const reading = buildZentrumSchematicReading([
    board(departure("6", line6Calls), departure("3", line6Calls.slice(3), { id: "3-trip" })),
  ]);
  const linePath = reading.linePaths.find(({ lineId }) => lineId === "6");
  assert.ok(linePath);

  const data = getZentrumSchematicLinePathData(linePath, reading.edges, reading.trackWidth);
  // Line 3 joins at Ebertstraße. It cannot add a lane to the line-6-only corridors before it --
  // Welfenstraße–Barbarossaplatz still carries one lane -- but the lane line 6 holds there is the
  // one it runs east of Ebertstraße: a through lane keeps its line across the stop it calls at.
  assert.deepEqual(
    reading.edges.find(
      ({ from, to }) =>
        [from.id, to.id].includes("barbarossaplatz") && [from.id, to.id].includes("ebertstrasse"),
    )?.trackLineIds,
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
      roundedCorner: "L 722.50 602.50 A 10.00 10.00 0 0 1 712.50 612.50",
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
      roundedCorner: "L 374.00 602.50 A 10.00 10.00 0 0 0 384.00 612.50",
    },
  ] as const;

  for (const { line3Calls, companions, roundedCorner } of cases) {
    const reading = buildZentrumSchematicReading([
      board(departure("3", line3Calls), ...companions),
    ]);
    const linePath = reading.linePaths.find(({ lineId }) => lineId === "3");
    assert.ok(linePath);

    assert.ok(
      getZentrumSchematicLinePathData(linePath, reading.edges, reading.trackWidth).includes(
        roundedCorner,
      ),
    );
  }
});

test("does not lend S51's southern branch to the same-coloured S5", () => {
  const reading = buildZentrumSchematicReading([
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
  ]);

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

  const reading = buildZentrumSchematicReading([board(trip)]);
  const [vehicle] = getZentrumSchematicVehicles(
    reading,
    [trip],
    Date.parse("2026-09-04T12:01:00+02:00"),
    reading.trackWidth,
  );

  assert.equal(vehicle?.from.id, "kronenplatz");
  assert.equal(vehicle?.to.id, "marktplatz");
  assert.ok((vehicle?.progress ?? 0) > 0);
  assert.ok((vehicle?.progress ?? 1) < 1);
  // The mark points the way the vehicle is going, whatever the plan's layout has since become.
  assert.equal(
    vehicle?.angle,
    (Math.atan2(vehicle.to.y - vehicle.from.y, vehicle.to.x - vehicle.from.x) * 180) / Math.PI,
  );
});

/*
 * A mark rides the lane its line is drawn in, not a side of the corridor of its own: a vehicle
 * stands where its colour runs. Both of a line's directions hold the one lane, so trams meeting
 * cover one another for the passing moment; what parts the marks is the lane each line holds,
 * not the way it is going.
 */
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

  const reading = buildZentrumSchematicReading([board(westbound, eastbound, tram)]);
  const [west] = getZentrumSchematicVehicles(
    reading,
    [westbound],
    Date.parse("2026-09-04T12:01:00+02:00"),
    reading.trackWidth,
  );
  const [east] = getZentrumSchematicVehicles(
    reading,
    [eastbound],
    Date.parse("2026-09-04T12:03:00+02:00"),
    reading.trackWidth,
  );
  const [tramMark] = getZentrumSchematicVehicles(
    reading,
    [tram],
    Date.parse("2026-09-04T12:01:00+02:00"),
    reading.trackWidth,
  );

  // The same level corridor, walked in opposite directions.
  assert.equal(west?.from.id, "kronenplatz");
  assert.equal(west?.to.id, "marktplatz");
  assert.equal(east?.from.id, "marktplatz");
  assert.equal(east?.to.id, "kronenplatz");

  const corridorY = west.from.y;
  assert.equal(corridorY, west.to.y);
  // One lane, held either way along the corridor: both marks stand the same distance off the
  // middle, on the same side of it, where the line's colour runs.
  assert.equal(west.y, east.y);
  assert.notEqual(west.y, corridorY);
  // And the step is sideways only: along the lane each mark stands exactly where its timing put it.
  assert.equal(west.x, west.from.x + (west.to.x - west.from.x) * west.progress);
  assert.equal(east.x, east.from.x + (east.to.x - east.from.x) * east.progress);
  // A second line on the corridor holds a lane of its own, not the S-Bahn's.
  assert.notEqual(tramMark?.y, west.y);
  assert.equal(
    tramMark?.x,
    tramMark.from.x + (tramMark.to.x - tramMark.from.x) * tramMark.progress,
  );
});

/*
 * What the vehicle map colours is the service still to come: a corridor is lit while a vehicle on
 * the map is still to run it, and goes out behind the vehicles as they pass.
 */
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
  const reading = buildZentrumSchematicReading([board(eastbound)]);

  // Between the Europaplatz and the Marktplatz, both corridors ahead of the vehicle are lit --
  // the one it is on now, and the one its run comes to next.
  const leaving = getZentrumSchematicAheadEdgeIds(
    reading,
    [eastbound],
    Date.parse("2026-09-04T12:01:00+02:00"),
  );
  assert.deepEqual([...(leaving.get("S1") ?? [])].sort(), [
    "europaplatz\u0000marktplatz",
    "kronenplatz\u0000marktplatz",
  ]);
  // Past the Marktplatz, the corridor behind has gone out; the one ahead is still lit.
  const past = getZentrumSchematicAheadEdgeIds(
    reading,
    [eastbound],
    Date.parse("2026-09-04T12:03:00+02:00"),
  );
  assert.deepEqual([...(past.get("S1") ?? [])], ["kronenplatz\u0000marktplatz"]);
});

/*
 * The vehicle map colours a line stretch by stretch, so the drawn pattern must come apart the
 * same way it is drawn: one stretch per corridor, the turn colouring with the corridor being
 * entered, and the stretches joining into the one line the whole-path reading lays.
 */
test("splits a drawn line at the stops without losing or repeating any of it", () => {
  const reading = buildZentrumSchematicReading([
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
  ]);
  const [linePath] = reading.linePaths;
  assert.ok(linePath);

  const segments = getZentrumSchematicLinePathSegments(linePath, reading.edges, reading.trackWidth);
  assert.deepEqual(
    segments.map(({ edgeId }) => edgeId),
    ["europaplatz\u0000muehlburger-tor", "europaplatz\u0000karlstor"],
  );
  // The bend into the Karlstor colours with the corridor being entered, not the one left behind.
  assert.equal(segments[0]?.data, "M 110.00 154.00 L 364.00 154.00");
  assert.match(
    segments[1]?.data ?? "",
    /^M 364\.00 154\.00 A 10\.00 10\.00 0 0 1 374\.00 164\.00 /,
  );
  // Joined end to end, the stretches are the one drawn line the whole-path reading lays.
  assert.equal(
    [segments[0]?.data, segments[1]?.data.replace(/^M [\d.]+ [\d.]+ /, "")].join(" "),
    getZentrumSchematicLinePathData(linePath, reading.edges, reading.trackWidth),
  );
});

/*
 * The authored drawing surface, checked against itself.
 *
 * Everything else about the Zentrum is observed and fails loudly. This table is authored, and it
 * fails silently: a place drawn off the grid puts a corridor at an angle the plan does not draw,
 * and a place drawn on top of its neighbour hides a name, with nothing in the running app to say
 * so. `npm run solve:zentrum` is the other half of this -- it asks the feed whether the drawing is
 * still the closest octilinear one to the city.
 */
test("a node is a Zentrum stop, and every Zentrum stop has one", () => {
  const nodeIds = ZENTRUM_SCHEMATIC_NODES.map((node) => node.id);

  assert.equal(new Set(nodeIds).size, nodeIds.length);
  assert.deepEqual(
    nodeIds.filter((id) => !isZentrumStop(id)),
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

/*
 * The separation the layout was solved for, held against the table it produced. Two places drawn
 * closer than a step and a half cannot both carry a legible name, and the drawing has no way to
 * report that: the labels simply overlap on someone's screen. So the constraint the annealing ran
 * under is stated here, where editing a node by hand has to pass it.
 */
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
 * A corridor's order is not decided by the corridor. Lines 3 and 4 run the Kaiserstraße together
 * and turn south together at the Europaplatz, so nothing between the Mühlburger Tor and the
 * Karlstor tells them apart; what tells them apart is the Karlstor itself, where 3 carries on south
 * and 4 leaves east. Ordering each corridor by the branches leaving it could not see that far, and
 * left the two to cross somewhere. The order they need at the Karlstor is the order they must
 * already be in two corridors earlier, which is the numeric one turned round.
 */
test("orders a corridor for a parting its lines have not reached yet", () => {
  const reading = buildZentrumSchematicReading([
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
  ]);
  const orderOn = (leftStopId: string, rightStopId: string) =>
    reading.edges.find(
      ({ from, to }) =>
        [from.id, to.id].includes(leftStopId) && [from.id, to.id].includes(rightStopId),
    )?.trackLineIds ?? [];

  // 4 leaves east at the Karlstor, so it holds the eastern lane of the Kriegsstraße; 3 carries on
  // south and holds the western one. The Kaiserstraße is then ordered to arrive that way round,
  // with 1 north of both because it is the one that does not turn at all.
  assert.deepEqual(orderOn("europaplatz", "karlstor"), ["4", "3"]);
  assert.deepEqual(orderOn("muehlburger-tor", "europaplatz"), ["1", "4", "3"]);
});

/*
 * The same fault at the scale a group makes it. The S-Bahnen arriving from the east leave the
 * Kaiserstraße southwards at the Marktplatz, the ones arriving from the west leave it there too,
 * and beyond the Marktplatz the two groups share every corridor. Putting one of them right on the
 * corridor it turns into breaks it again on the next corridor by exactly as much, so no single
 * move improves anything and a drawing ordered corridor by corridor leaves the groups woven
 * together the whole way south.
 */
test("keeps groups joining a corridor from opposite sides from weaving down it", () => {
  const marktplatz = call("marktplatz", "7001003");
  const ettlinger = call("ettlinger-tor", "7001012");
  const kongress = call("kongresszentrum", "7001013");
  const fromWest = [call("europaplatz", "7001004"), marktplatz, ettlinger, kongress];
  const fromEast = [call("kronenplatz", "7001002"), marktplatz, ettlinger, kongress];
  const reading = buildZentrumSchematicReading([
    board(
      departure("1", [call("kronenplatz", "7001002"), marktplatz, call("europaplatz", "7001004")]),
      departure("S1", fromWest, { id: "s1", tripId: "s1" }),
      departure("S2", fromWest, { id: "s2", tripId: "s2" }),
      departure("S4", fromEast, { id: "s4", tripId: "s4" }),
      departure("S8", fromEast, { id: "s8", tripId: "s8" }),
    ),
  ]);
  const orderOn = (leftStopId: string, rightStopId: string) =>
    reading.edges.find(
      ({ from, to }) =>
        [from.id, to.id].includes(leftStopId) && [from.id, to.id].includes(rightStopId),
    )?.trackLineIds ?? [];

  // Lanes on the Ettlinger Tor corridors are numbered west-first, so the pair that came from the
  // east holds the eastern lanes and the pair that came from the west the western ones: neither
  // group crosses the other to reach the corridor, and neither unpicks itself going down it.
  assert.deepEqual(orderOn("marktplatz", "ettlinger-tor"), ["S4", "S8", "S1", "S2"]);
  assert.deepEqual(orderOn("ettlinger-tor", "kongresszentrum"), ["S4", "S8", "S1", "S2"]);
  // And on the Kaiserstraße east of the Marktplatz the turning pair rides south of line 1, which
  // is the side they turn towards.
  assert.deepEqual(orderOn("kronenplatz", "marktplatz").indexOf("1"), 0);
});

/** Every coordinate in a mark's path, which is all a test needs to measure the shape it draws. */
const markExtent = (data: string) => {
  const numbers = [...data.matchAll(/-?\d+(?:\.\d+)?/g)].map((match) => Number(match[0]));
  // Every command in the path ends in a coordinate pair; the arcs' radii come in threes before it.
  const points = data
    .split(/(?=[MLA])/)
    .map((command) =>
      command
        .trim()
        .split(/[\s,]+/)
        .slice(-2)
        .map(Number),
    )
    .filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  assert.ok(numbers.length > 0 && points.length > 0);
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  return {
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
    centre: {
      x: (Math.max(...xs) + Math.min(...xs)) / 2,
      y: (Math.max(...ys) + Math.min(...ys)) / 2,
    },
  };
};

/** The rules one stop is marked with, as the endpoints of each of them. */
const stopBars = (reading: ZentrumSchematicReading, nodeId: string) => {
  const [mark] = getZentrumSchematicStopMarks(
    reading.edges,
    reading.trackWidth,
    reading.boardingPlacesByNodeId,
  ).filter((candidate) => candidate.nodeId === nodeId);
  assert.ok(mark, `no mark at ${nodeId}`);
  return mark.data.split("M ").slice(1).map(markExtent);
};

/**
 * A stop on a band is marked across the whole of it, not on the lane that happens to run through
 * the middle: the rule is what says the lines beside that one call here too.
 */
test("rules across every lane of a corridor at a through stop", () => {
  const along = [
    call("muehlburger-tor", "7000039"),
    call("europaplatz", "7000037"),
    call("marktplatz", "7000041"),
  ];
  const reading = buildZentrumSchematicReading([
    board(...["1", "2", "3"].map((lineId) => departure(lineId, along, { id: `${lineId}-trip` }))),
  ]);
  const bars = stopBars(reading, "europaplatz");

  // One straight through the stop is one rule, square to it and crossing the whole band: the three
  // coloured lanes and the casing they share, so no outer line escapes the stop it calls at.
  assert.equal(bars.length, 1);
  assert.equal(bars[0].width, 0);
  assert.ok(bars[0].height > 3 * reading.trackWidth);
  assert.deepEqual(bars[0].centre, { x: 374, y: 154 });
});

/**
 * The rule is a mark on the band, so it grows with the band and with nothing else: a busy stop is
 * a longer rule, never a deeper one.
 */
test("grows a stop's rule across the band and not along the corridor", () => {
  const along = [
    call("muehlburger-tor", "7000039"),
    call("europaplatz", "7000037"),
    call("marktplatz", "7000041"),
  ];
  const getRule = (lineIds: readonly string[]) => {
    const reading = buildZentrumSchematicReading([
      board(...lineIds.map((lineId) => departure(lineId, along, { id: `${lineId}-trip` }))),
    ]);
    const [bar] = stopBars(reading, "europaplatz");
    return { ...bar, trackWidth: reading.trackWidth };
  };
  const quiet = getRule(["1", "2"]);
  const busy = getRule(["1", "2", "3", "4", "5", "6"]);

  assert.ok(busy.height / busy.trackWidth >= quiet.height / quiet.trackWidth + 3.5);
  assert.equal(busy.width, 0);
});

/**
 * Where the corridors part and the reading cannot say where the platforms are, each straight
 * through the stop is ruled once -- so a line turning through the corner is marked as calling
 * there rather than as passing it.
 */
test("rules each straight through a stop the reading names no places at", () => {
  const reading = buildZentrumSchematicReading([
    board(
      departure("1", [
        call("muehlburger-tor", "7000039"),
        call("europaplatz", "7000037"),
        call("karlstor", "7000061"),
      ]),
      departure("2", [call("muehlburger-tor", "7000039"), call("europaplatz", "7000037")], {
        id: "2-trip",
      }),
      departure("3", [call("muehlburger-tor", "7000039"), call("europaplatz", "7000037")], {
        id: "3-trip",
      }),
    ),
  ]);
  const bars = stopBars(reading, "europaplatz");

  // Every trip here boards at platform 1, so the stop is one place and its two straights -- the
  // corridor west and the branch south -- are ruled at the stop itself.
  assert.equal(reading.boardingPlacesByNodeId.has("europaplatz"), false);
  assert.equal(bars.length, 2);
  for (const bar of bars) assert.deepEqual(bar.centre, { x: 374, y: 154 });
  assert.ok(bars.some((bar) => bar.width === 0 && bar.height > 3 * reading.trackWidth));
  assert.ok(bars.some((bar) => bar.height === 0 && bar.width > reading.trackWidth));
});

/**
 * A stop is marked once whatever calls there. The rule crosses the lanes, so a single line needs
 * no mark of another kind and gets the same one every other stop has.
 */
test("rules a stop served by one line as it rules every other", () => {
  const reading = buildZentrumSchematicReading([
    board(departure("1", [call("muehlburger-tor", "7000039"), call("europaplatz", "7000037")])),
  ]);
  const bars = stopBars(reading, "europaplatz");

  assert.equal(bars.length, 1);
  assert.ok(bars[0].height > reading.trackWidth);
});

/**
 * Karlstor is the case the platform reading exists for: its trams towards Ettlinger Tor board on
 * the eastern arm of the crossing and its trams towards Mathystraße on the southern one, and a
 * rider standing there is looking for one of the two.
 */
test("rules a junction once for each place its platforms say it is", () => {
  const eastward = [
    call("europaplatz", "7000037", "4"),
    call("karlstor", "7000061", "1"),
    call("ettlinger-tor", "7000071", "2"),
  ];
  const southward = [
    call("europaplatz", "7000037", "4"),
    call("karlstor", "7000061", "3"),
    call("mathystrasse", "7000062", "3"),
  ];
  const reading = buildZentrumSchematicReading([
    board(
      ...["1", "2"].map((lineId) => departure(lineId, eastward, { id: `${lineId}-east` })),
      ...["3", "4"].map((lineId) => departure(lineId, southward, { id: `${lineId}-south` })),
    ),
  ]);

  assert.deepEqual(
    reading.boardingPlacesByNodeId.get("karlstor")?.map((place) => [...place.armTripCounts.keys()]),
    [
      ["europaplatz", "ettlinger-tor"],
      ["europaplatz", "mathystrasse"],
    ],
  );
  const bars = stopBars(reading, "karlstor");
  assert.equal(bars.length, 2);
  // The arm each place is drawn on is the one the other place does not use, and the rule stands out
  // along it, clear of the band crossing it: east of the crossing, and south of it.
  const [eastern] = bars.filter((bar) => bar.width === 0);
  const [southern] = bars.filter((bar) => bar.height === 0);
  assert.ok(eastern.centre.x > 374 + reading.trackWidth);
  assert.ok(southern.centre.y > 286 + reading.trackWidth);
  // Each rule stays on the arm it marks: it is offset along the corridor, never across it further
  // than the band it crosses stands off the corridor's own middle.
  assert.ok(Math.abs(eastern.centre.y - 286) <= reading.trackWidth);
  assert.ok(Math.abs(southern.centre.x - 374) <= reading.trackWidth);
});

/**
 * A platform a board window saw a handful of times is a diversion or a layover, not a place a
 * rider waits, and drawing a rule for it would put a stop where there is none.
 */
test("leaves a barely used platform out of a stop's places", () => {
  const along = [
    call("europaplatz", "7000037", "4"),
    call("karlstor", "7000061", "1"),
    call("ettlinger-tor", "7000071", "2"),
  ];
  const diverted = [
    call("europaplatz", "7000037", "4"),
    call("karlstor", "7000061", "9"),
    call("mathystrasse", "7000062", "3"),
  ];
  const reading = buildZentrumSchematicReading([
    board(
      ...Array.from({ length: 30 }, (_, index) =>
        departure("1", along, { id: `regular-${index}`, tripId: `regular-${index}` }),
      ),
      departure("1", diverted, { id: "diverted", tripId: "diverted" }),
    ),
  ]);

  assert.equal(reading.boardingPlacesByNodeId.has("karlstor"), false);
  assert.deepEqual(
    stopBars(reading, "karlstor").map((bar) => bar.centre),
    [
      { x: 374, y: 286 },
      { x: 374, y: 286 },
    ],
  );
});
