import assert from "node:assert/strict";
import test from "node:test";
import type { StopEvent, StopEventBoard, Call } from "../src/data/transit-types.ts";
import { isZentrumStop, zentrumStopIds } from "../src/data/zentrum-stops.ts";
import {
  type ZentrumSchematicReading,
  buildZentrumSchematicReading,
  createZentrumSchematicDrawer,
  createZentrumSchematicReader,
  getZentrumSchematicBranchIdsOnPlan,
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
import { datedJourney } from "./support/calls.ts";
import { createDatedJourneyMotions } from "../src/lib/vehicle-positioning.ts";
import { createStopEvent } from "./support/fixtures.ts";

/** One drawing's motion record, shared across this file. */
const motions = createDatedJourneyMotions();

const call = (stopPlaceId: string, stopPointId: string, bay = "1"): Call => ({
  stopName: stopPlaceId,
  stopPlaceId,
  stopPointId,
  bay,
});

const stopEvent = (
  lineId: string,
  calls: readonly Call[],
  overrides: Partial<StopEvent> = {},
): StopEvent =>
  createStopEvent({
    id: `${lineId}-departure`,
    lineId,
    ptMode: "tram",
    destinationText: "Testziel",
    minutesUntilDeparture: 3,
    bay: "1",
    boardingStopPlaceId: calls[0]?.stopPlaceId ?? "",
    boardingStopPointId: calls[0]?.stopPointId ?? "",
    boardingStopPointName: calls[0]?.stopName ?? "",
    status: "realtime",
    timetabledDepartureTime: "2026-09-04T12:00:00+02:00",
    calls,
    ...overrides,
  });

const board = (...stopEvents: readonly StopEvent[]): StopEventBoard => ({
  stopId: "europaplatz",
  receivedAt: 1,
  dataStatus: "live",
  feedUpdatedAt: "2026-09-04T11:57:00+02:00",
  stopEvents,
});

/** The journeys a reading is built from, standing in for what `useLineDatedJourneyStopEvents` hands the view. */
const drawn = (boards: readonly StopEventBoard[]): StopEvent[] =>
  boards.flatMap(({ stopEvents }) => stopEvents);

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
        stopEvent("2", [
          call("muehlburger-tor", "de:08212:39", "1a"),
          call("europaplatz", "de:08212:37", "5"),
          call("outside", "de:08212:9999"),
          call("karlstor", "de:08212:61", "1"),
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

test("crossing between the parts of one stop place draws no corridor, and breaks no chain", () => {
  const reading = buildZentrumSchematicReading(
    drawn([
      board(
        stopEvent("S1", [
          call("ettlinger-tor", "de:08212:1012"),
          call("marktplatz", "de:08212:1011"),
          call("marktplatz", "de:08212:1003"),
          call("europaplatz", "de:08212:1004"),
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

test("combines directions and repeated journeys into one corridor line set", () => {
  const west = call("muehlburger-tor", "de:08212:39", "1a");
  const europa = call("europaplatz", "de:08212:37", "5");
  const reading = buildZentrumSchematicReading(
    drawn([
      board(
        stopEvent("2", [west, europa]),
        stopEvent("2", [europa, west], { id: "second-2" }),
        stopEvent("3", [west, europa]),
        stopEvent("9", [west, europa], { status: "cancelled" }),
        stopEvent("ICE", [west, europa], { ptMode: "other" }),
      ),
    ]),
  );

  assert.deepEqual(reading.edges[0]?.lineIds, ["2", "3"]);
  assert.equal(reading.linePaths.filter(({ lineId }) => lineId === "2").length, 1);
});

test("one journey named twice in the drawn set is one journey, not two", () => {
  // The same journey as a board row and as its retained reading must count once.
  const west = call("muehlburger-tor", "de:08212:39");
  const europa = call("europaplatz", "de:08212:37");
  const market = call("marktplatz", "de:08212:1003");
  const reading = buildZentrumSchematicReading([
    stopEvent("S5", [west, europa, market], {
      id: "row",
      journeyRef: "journey-1",
      datedJourneyId: "journey-1@a",
    }),
    stopEvent("S5", [west, europa, market], {
      id: "reading",
      journeyRef: "journey-1",
      datedJourneyId: "journey-1@a",
    }),
    stopEvent("S5", [west, europa], { id: "short-1", journeyRef: "journey-2" }),
    stopEvent("S5", [europa, west], { id: "short-2", journeyRef: "journey-3" }),
  ]);

  assert.deepEqual(
    reading.linePaths.map(({ lineId, nodes }) => [lineId, nodes.map(({ id }) => id)]),
    [["S5", ["muehlburger-tor", "europaplatz"]]],
  );
});

test("a journey the boards have stopped naming still states the corridors its mark rides", () => {
  // A journey between posts is on no board, but its line still draws.
  const west = call("muehlburger-tor", "de:08212:39");
  const europa = call("europaplatz", "de:08212:37");
  const reading = buildZentrumSchematicReading([
    stopEvent("2", [west, europa], { id: "between-posts", journeyRef: "between-posts" }),
  ]);

  assert.deepEqual(
    reading.edges.map(({ from, to, lineIds }) => [from.id, to.id, lineIds]),
    [["europaplatz", "muehlburger-tor", ["2"]]],
  );
});

test("a refresh that draws the same plan is handed the same plan, laid out once", () => {
  // Layout is expensive; journeys change every few seconds, corridors a few times a day.
  const west = call("muehlburger-tor", "de:08212:39");
  const europa = call("europaplatz", "de:08212:37");
  const market = call("marktplatz", "de:08212:1003");
  const karlstor = call("karlstor", "de:08212:61");
  const read = createZentrumSchematicReader();
  const first = read([
    stopEvent("2", [west, europa, market], { id: "a", journeyRef: "a" }),
    stopEvent("2", [market, europa, west], { id: "b", journeyRef: "b" }),
  ]);

  const swapped = read([
    stopEvent("2", [market, europa, west], { id: "c", journeyRef: "c" }),
    stopEvent("2", [west, europa, market], { id: "d", journeyRef: "d" }),
  ]);
  assert.equal(swapped, first);

  // A new corridor is a new plan.
  const grown = read([
    stopEvent("2", [west, europa, market], { id: "a", journeyRef: "a" }),
    stopEvent("S1", [west, europa, karlstor], { id: "e", journeyRef: "e" }),
  ]);
  assert.notEqual(grown, first);
  assert.notEqual(grown.layoutKey, first.layoutKey);
  assert.deepEqual(grown.lineIds, ["2", "S1"]);
  assert.deepEqual(
    grown.edges.map(({ id }) => id),
    buildZentrumSchematicReading([
      stopEvent("S1", [west, europa, karlstor], { id: "e", journeyRef: "e" }),
      stopEvent("2", [west, europa, market], { id: "a", journeyRef: "a" }),
    ]).edges.map(({ id }) => id),
  );
});

test("draws only the path used by the most timetable journeys for each line", () => {
  const west = call("muehlburger-tor", "de:08212:39");
  const europa = call("europaplatz", "de:08212:37");
  const market = call("marktplatz", "de:08212:1003");
  const kronen = call("kronenplatz", "de:08212:1002");
  const karlstor = call("karlstor", "de:08212:61");
  const reading = buildZentrumSchematicReading(
    drawn([
      board(
        stopEvent("S5", [west, europa, market, kronen], { id: "main-1", journeyRef: "main-1" }),
        stopEvent("S5", [kronen, market, europa, west], { id: "main-2", journeyRef: "main-2" }),
        stopEvent("S5", [west, europa, karlstor], { id: "branch", journeyRef: "branch" }),
      ),
    ]),
  );

  assert.deepEqual(
    reading.linePaths.map(({ lineId, nodes }) => [lineId, nodes.map(({ id }) => id)]),
    [["S5", ["muehlburger-tor", "europaplatz", "marktplatz", "kronenplatz"]]],
  );
  // The less-used service is still observed, and drawn as a branch while its journey is on the plan.
  assert.ok(
    reading.edges.some(
      ({ from, to, lineIds }) => [from.id, to.id].includes("karlstor") && lineIds.includes("S5"),
    ),
  );
});

test("draws a line's branch in its lane only while a journey on it is on the plan", () => {
  const timed = (stop: Call, time: string): Call => ({
    ...stop,
    timetabledArrivalTime: time,
    timetabledDepartureTime: time,
  });
  const west = call("muehlburger-tor", "de:08212:39");
  const europa = call("europaplatz", "de:08212:37");
  const market = call("marktplatz", "de:08212:1003");
  const kronen = call("kronenplatz", "de:08212:1002");
  const karlstor = call("karlstor", "de:08212:61");
  const datedJourneys = [
    stopEvent("S5", [west, europa, market, kronen], { id: "main-1", journeyRef: "main-1" }),
    stopEvent("S5", [kronen, market, europa, west], { id: "main-2", journeyRef: "main-2" }),
    stopEvent(
      "S5",
      [
        timed(west, "2026-09-04T12:00:00+02:00"),
        timed(europa, "2026-09-04T12:02:00+02:00"),
        timed(karlstor, "2026-09-04T12:04:00+02:00"),
      ],
      { id: "branch", journeyRef: "branch" },
    ),
    // A short working inside the main path is no branch.
    stopEvent("S5", [europa, market], { id: "short", journeyRef: "short" }),
  ];
  const read = createZentrumSchematicReader();
  const layout = read(datedJourneys);
  assert.deepEqual(
    layout.branchPaths.map(({ datedJourneyKeys, nodes }) => [
      datedJourneyKeys,
      nodes.map(({ id }) => id),
    ]),
    [[["branch"], ["muehlburger-tor", "europaplatz", "karlstor"]]],
  );
  const branchId = layout.branchPaths[0].id;
  const at = (time: string) =>
    getZentrumSchematicBranchIdsOnPlan(layout, datedJourneys, Date.parse(time));
  assert.deepEqual(at("2026-09-04T11:30:00+02:00"), []);
  assert.deepEqual(at("2026-09-04T12:03:00+02:00"), [branchId]);
  assert.deepEqual(at("2026-09-04T12:30:00+02:00"), []);

  // Another journey on the branch keeps the lanes as laid out.
  const again = read([
    ...datedJourneys,
    stopEvent("S5", [karlstor, europa, west], { id: "branch-2", journeyRef: "branch-2" }),
  ]);
  assert.equal(again.layoutKey, layout.layoutKey);
  assert.equal(again.edges, layout.edges);
  assert.deepEqual(again.branchPaths[0]?.datedJourneyKeys, ["branch", "branch-2"]);

  const draw = createZentrumSchematicDrawer();
  const karlstorCorridor = getEdgeKey("europaplatz", "karlstor");
  const without = draw(layout, undefined);
  assert.equal(without.drawnPaths.length, 1);
  assert.equal(without.vehiclePathsByLineId.get("S5")?.has(karlstorCorridor), false);
  const withBranch = draw(layout, undefined, [branchId]);
  assert.equal(withBranch.drawnPaths.length, 2);
  assert.equal(withBranch.vehiclePathsByLineId.get("S5")?.has(karlstorCorridor), true);
  assert.equal(withBranch.edges, without.edges);
});

test("breaks equal-usage path ties by coverage, independent of board order", () => {
  const shortPath = [call("europaplatz", "de:08212:37"), call("marktplatz", "de:08212:1003")];
  const longPath = [call("muehlburger-tor", "de:08212:39"), ...shortPath];
  const boards = [
    board(stopEvent("S51", shortPath, { id: "short", journeyRef: "short" })),
    board(stopEvent("S51", longPath, { id: "long", journeyRef: "long" })),
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
    call("muehlburger-tor", "de:08212:39"),
    call("europaplatz", "de:08212:37"),
    call("marktplatz", "de:08212:1003"),
  ];
  const reading = buildZentrumSchematicReading(
    drawn([
      board(
        stopEvent("2", wholeCorridor),
        stopEvent("1", wholeCorridor.slice(0, 2), { id: "1-journey" }),
        stopEvent("3", wholeCorridor.slice(1), { id: "3-journey" }),
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
  const west = call("muehlburger-tor", "de:08212:39");
  const europa = call("europaplatz", "de:08212:37");
  const market = call("marktplatz", "de:08212:1003");
  const karlstor = call("karlstor", "de:08212:61");
  const reading = buildZentrumSchematicReading(
    drawn([
      board(
        stopEvent("2", [west, europa, karlstor]),
        stopEvent("S1", [west, europa, market], { id: "s1", journeyRef: "s1" }),
        stopEvent("S11", [west, europa, market], { id: "s11", journeyRef: "s11" }),
        stopEvent("S5", [europa, market], { id: "s5", journeyRef: "s5" }),
        stopEvent("S51", [europa, market], { id: "s51", journeyRef: "s51" }),
        stopEvent("S4", [europa, market], { id: "s4", journeyRef: "s4" }),
        stopEvent("S41", [europa, market], { id: "s41", journeyRef: "s41" }),
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
  const west = call("muehlburger-tor", "de:08212:39");
  const europa = call("europaplatz", "de:08212:37");
  const market = call("marktplatz", "de:08212:1003");
  const karlstor = call("karlstor", "de:08212:61");
  const reading = buildZentrumSchematicReading(
    drawn([
      board(
        stopEvent("S1", [west, europa, market], { id: "s1", journeyRef: "s1" }),
        stopEvent("S11", [west, europa, karlstor], { id: "s11", journeyRef: "s11" }),
        stopEvent("2", [west, europa, market], { id: "2-journey", journeyRef: "2-journey" }),
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
  const west = call("muehlburger-tor", "de:08212:39");
  const europa = call("europaplatz", "de:08212:37");
  const market = call("marktplatz", "de:08212:1003");
  const kronen = call("kronenplatz", "de:08212:1002");
  const durlach = call("durlacher-tor", "de:08212:1001");
  const karlstor = call("karlstor", "de:08212:61");
  const ettlinger = call("ettlinger-tor", "de:08212:1012");
  const rueppurrer = call("rueppurrer-tor", "de:08212:77");
  const reading = buildZentrumSchematicReading(
    drawn([
      board(
        stopEvent("1", [west, europa, market, kronen, durlach]),
        stopEvent("S2", [west, europa, market, kronen, durlach], {
          id: "s2-journey",
          journeyRef: "s2-journey",
        }),
        stopEvent("2", [west, europa, market, ettlinger], {
          id: "2-journey",
          journeyRef: "2-journey",
        }),
        stopEvent("3", [west, europa, karlstor], { id: "3-journey", journeyRef: "3-journey" }),
        stopEvent("4", [europa, karlstor, ettlinger, rueppurrer]),
        stopEvent("5", [europa, karlstor, ettlinger, rueppurrer], {
          id: "5-journey",
          journeyRef: "5-journey",
        }),
        stopEvent("6", [europa, karlstor, call("mathystrasse", "de:08212:62")], {
          id: "6-journey",
          journeyRef: "6-journey",
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
  const west = call("muehlburger-tor", "de:08212:39");
  const europa = call("europaplatz", "de:08212:37");
  const market = call("marktplatz", "de:08212:1003");
  const kronen = call("kronenplatz", "de:08212:1002");
  const durlach = call("durlacher-tor", "de:08212:1001");
  const reading = buildZentrumSchematicReading(
    drawn([
      board(
        stopEvent("1", [
          west,
          europa,
          market,
          kronen,
          durlach,
          call("gottesauer-platz", "de:08212:41"),
        ]),
        stopEvent("2", [west, europa, call("karlstor", "de:08212:61")]),
        stopEvent("4", [
          west,
          europa,
          market,
          call("ettlinger-tor", "de:08212:1012"),
          call("kongresszentrum", "de:08212:1013"),
          call("augartenstrasse", "de:08212:74"),
        ]),
        stopEvent("3", [
          west,
          europa,
          market,
          kronen,
          durlach,
          call("karl-wilhelm-platz", "de:08212:42"),
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
  const west = call("muehlburger-tor", "de:08212:39");
  const europa = call("europaplatz", "de:08212:37");
  const market = call("marktplatz", "de:08212:1003");
  const reading = buildZentrumSchematicReading(
    drawn([
      board(
        stopEvent("1", [west, europa, market]),
        stopEvent("2", [west, europa, call("karlstor", "de:08212:61")], { id: "2-journey" }),
        stopEvent("3", [west, europa, market, call("kronenplatz", "de:08212:1002")], {
          id: "3-journey",
        }),
        stopEvent("4", [west, europa, market, call("ettlinger-tor", "de:08212:1012")], {
          id: "4-journey",
        }),
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
  const calls = (stopIds: readonly string[]) => stopIds.map((stopId) => call(stopId, "de:08212:0"));
  const reading = buildZentrumSchematicReading(
    drawn([
      board(
        stopEvent(
          "1",
          calls(["muehlburger-tor", "europaplatz", "marktplatz", "kronenplatz", "durlacher-tor"]),
        ),
        stopEvent(
          "2",
          calls(["muehlburger-tor", "europaplatz", "marktplatz", "kronenplatz", "durlacher-tor"]),
          { id: "2-journey", journeyRef: "2-journey" },
        ),
        ...["3", "4", "5", "6"].map((lineId) =>
          stopEvent(lineId, calls(["muehlburger-tor", "europaplatz", "karlstor"]), {
            id: `${lineId}-journey`,
            journeyRef: `${lineId}-journey`,
          }),
        ),
        ...["7", "8", "9", "10"].map((lineId) =>
          stopEvent(
            lineId,
            calls(["durlacher-tor", "kronenplatz", "marktplatz", "ettlinger-tor"]),
            {
              id: `${lineId}-journey`,
              journeyRef: `${lineId}-journey`,
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
  assert.match(pathData.get("3") ?? "", /^M 110\.00 150\.50 L 353\.50 150\.50 A 31\.00 31\.00 /);
  assert.match(
    pathData.get("7") ?? "",
    /^M 858\.00 150\.50 L 726\.00 150\.50 L 592\.50 150\.50 A 31\.00 31\.00 /,
  );
});

const crowdedCorridor = () => [
  call("muehlburger-tor", "de:08212:39"),
  call("europaplatz", "de:08212:37"),
];
const corridorDatedJourneys = (lineCount: number) =>
  drawn([
    board(
      ...Array.from({ length: lineCount }, (_, index) =>
        stopEvent(String(index + 1), crowdedCorridor(), { id: `${index + 1}-journey` }),
      ),
    ),
  ]);

test("thins every lane together when a corridor outgrows the band", () => {
  const busy = buildZentrumSchematicReading(corridorDatedJourneys(12));
  const busier = buildZentrumSchematicReading(corridorDatedJourneys(16));
  const quiet = buildZentrumSchematicReading(corridorDatedJourneys(2));

  assert.equal(busy.edges[0]?.trackIds.length, 12);
  assert.ok(busy.trackWidth < quiet.trackWidth);
  // Past the band, the lanes share its width.
  assert.equal(busy.trackWidth * 12, busier.trackWidth * 16);
});

test("draws a lane at one width on screen, whatever size the plan is drawn at", () => {
  const datedJourneys = corridorDatedJourneys(2);
  const small = buildZentrumSchematicReading(datedJourneys, ZENTRUM_SCHEMATIC_VIEWBOX.width / 2);
  const large = buildZentrumSchematicReading(datedJourneys, ZENTRUM_SCHEMATIC_VIEWBOX.width * 2);
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
  const quiet = buildZentrumSchematicReading(corridorDatedJourneys(2), tiny);
  const busy = buildZentrumSchematicReading(corridorDatedJourneys(10), tiny);

  assert.ok(busy.trackWidth < quiet.trackWidth);
  assert.equal(
    busy.trackWidth * 10,
    buildZentrumSchematicReading(corridorDatedJourneys(20), tiny).trackWidth * 20,
  );
});

test("a resize redraws the lanes without laying them out again", () => {
  const layout = createZentrumSchematicReader()(corridorDatedJourneys(3));
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
    call("zkm", "de:08212:59"),
    call("welfenstrasse", "de:08212:60"),
    call("barbarossaplatz", "de:08212:57"),
    call("ebertstrasse", "de:08212:88"),
    call("hauptbahnhof", "de:08212:89"),
  ];
  const reading = buildZentrumSchematicReading(
    drawn([
      board(stopEvent("6", line6Calls), stopEvent("3", line6Calls.slice(3), { id: "3-journey" })),
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
        call("werderstrasse", "de:08212:83"),
        call("tivoli", "de:08212:84"),
        call("poststrasse", "de:08212:98"),
      ],
      companions: [
        stopEvent("E", [call("werderstrasse", "de:08212:83"), call("tivoli", "de:08212:84")]),
        stopEvent("6", [call("tivoli", "de:08212:84"), call("poststrasse", "de:08212:98")]),
      ],
      roundedCorner: "L 729.50 609.50 A 10.00 10.00 0 0 1 719.50 619.50",
    },
    {
      line3Calls: [
        call("kolpingplatz", "de:08212:63"),
        call("ebertstrasse", "de:08212:91"),
        call("hauptbahnhof", "de:08212:89"),
      ],
      companions: [
        stopEvent("6", [call("ebertstrasse", "de:08212:91"), call("hauptbahnhof", "de:08212:89")]),
      ],
      roundedCorner: "L 374.00 609.50 A 10.00 10.00 0 0 0 384.00 619.50",
    },
  ] as const;

  for (const { line3Calls, companions, roundedCorner } of cases) {
    const reading = buildZentrumSchematicReading(
      drawn([board(stopEvent("3", line3Calls), ...companions)]),
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
        stopEvent("3", [
          call("werderstrasse", "de:08212:83"),
          call("tivoli", "de:08212:84"),
          call("poststrasse", "de:08212:98"),
        ]),
        stopEvent("6", [call("tivoli", "de:08212:84"), call("poststrasse", "de:08212:98")]),
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
        stopEvent("2", [
          call("muehlburger-tor", "de:08212:39"),
          call("europaplatz", "de:08212:37"),
          call("marktplatz", "de:08212:1003"),
          call("kronenplatz", "de:08212:1002"),
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
        stopEvent("S5", [
          call("muehlburger-tor", "de:08212:39", "1a"),
          call("europaplatz", "de:08212:1004"),
          call("marktplatz", "de:08212:1003"),
          call("kronenplatz", "de:08212:1002"),
          call("durlacher-tor", "de:08212:1001"),
        ]),
        stopEvent("S51", [
          call("muehlburger-tor", "de:08212:39", "1a"),
          call("europaplatz", "de:08212:1004"),
          call("marktplatz", "de:08212:1003"),
          call("marktplatz", "de:08212:1011"),
          call("ettlinger-tor", "de:08212:1012"),
          call("kongresszentrum", "de:08212:1013"),
          call("augartenstrasse", "de:08212:74"),
          call("poststrasse", "de:08212:98"),
          call("hauptbahnhof", "de:08212:89"),
          call("albtalbahnhof", "de:08212:1201"),
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
  const journey = stopEvent(
    "S1",
    [
      {
        ...call("kronenplatz", "de:08212:1002"),
        timetabledArrivalTime: "2026-09-04T12:00:00+02:00",
        timetabledDepartureTime: "2026-09-04T12:00:00+02:00",
        delayMinutes: 0,
      },
      {
        ...call("marktplatz", "de:08212:1003"),
        timetabledArrivalTime: "2026-09-04T12:02:00+02:00",
        timetabledDepartureTime: "2026-09-04T12:02:00+02:00",
        delayMinutes: 0,
      },
      {
        ...call("europaplatz", "de:08212:1004"),
        timetabledArrivalTime: "2026-09-04T12:04:00+02:00",
        timetabledDepartureTime: "2026-09-04T12:04:00+02:00",
        delayMinutes: 0,
      },
    ],
    { id: "portal-journey", datedJourneyId: "portal-journey", delayMinutes: 0 },
  );

  const reading = buildZentrumSchematicReading(drawn([board(journey)]));
  const [vehicle] = getZentrumSchematicVehicles(
    reading,
    [journey],
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
  const timedCall = (stopPlaceId: string, minute: number): Call => ({
    ...call(
      stopPlaceId,
      stopPlaceId === "marktplatz" && minute === 4
        ? "de:08212:1011"
        : ({
            europaplatz: "de:08212:1004",
            kronenplatz: "de:08212:1002",
            marktplatz: "de:08212:1003",
          }[stopPlaceId] ?? `provider-${stopPlaceId}-${minute}`),
    ),
    timetabledArrivalTime: `2026-09-04T12:0${minute}:00+02:00`,
    timetabledDepartureTime: `2026-09-04T12:0${minute}:00+02:00`,
    delayMinutes: 0,
  });
  const journey = stopEvent(
    "S1",
    [
      timedCall("marktplatz", 0),
      timedCall("europaplatz", 2),
      timedCall("marktplatz", 4),
      timedCall("kronenplatz", 6),
    ],
    { id: "zentrum-repeated-stop", datedJourneyId: "zentrum-repeated-stop" },
  );
  const reading = buildZentrumSchematicReading(drawn([board(journey)]));

  const [vehicle] = getZentrumSchematicVehicles(
    reading,
    [journey],
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
  const timedCall = (stopId: string, stopPointId: string, bay: string, minute: number) => ({
    ...call(stopId, stopPointId, bay),
    timetabledArrivalTime: `2026-09-04T12:0${minute}:00+02:00`,
    timetabledDepartureTime: `2026-09-04T12:0${minute}:00+02:00`,
    delayMinutes: 0,
  });
  const journey = stopEvent(
    "5",
    datedJourney([
      timedCall("karlstor", "de:08212:61", "1", 0),
      timedCall("europaplatz", "de:08212:37", "3", 2),
      timedCall("europaplatz", "de:08212:37", "5", 3),
      timedCall("europaplatz-muehlburger-tor-wende--1xjn1ol", "de:08212:38", "3", 4),
    ]),
    { id: "five-arriving", datedJourneyId: "five-arriving" },
  );
  const neighbor = stopEvent("3", [
    call("karlstor", "de:08212:61", "3"),
    call("europaplatz", "de:08212:37", "3"),
    call("europaplatz", "de:08212:37", "5"),
    call("muehlburger-tor", "de:08212:39", "1a"),
  ]);
  const reading = buildZentrumSchematicReading([journey, neighbor]);
  const datedJourneyMotions = createDatedJourneyMotions();
  const [arriving] = getZentrumSchematicVehicles(
    reading,
    [journey],
    Date.parse("2026-09-04T12:01:59+02:00"),
    datedJourneyMotions,
  );
  const [parked] = getZentrumSchematicVehicles(
    reading,
    [journey],
    Date.parse("2026-09-04T12:02:30+02:00"),
    datedJourneyMotions,
  );
  assert.ok(arriving && parked);
  const halt = arriving.path.points.at(-1);
  assert.ok(halt);
  assert.deepEqual({ x: parked.x, y: parked.y }, { x: halt.x, y: halt.y });
  assert.equal(parked.angle, getZentrumSchematicVehiclePathPlacement(arriving.path, 1).angle);
});

test("keeps a vehicle standing before its Zentrum journey starts", () => {
  const calls = datedJourney([
    {
      ...call("kronenplatz", "de:08212:1002"),
      timetabledArrivalTime: "2026-09-04T12:00:00+02:00",
      timetabledDepartureTime: "2026-09-04T12:00:00+02:00",
      delayMinutes: 0,
    },
    {
      ...call("marktplatz", "de:08212:1003"),
      timetabledArrivalTime: "2026-09-04T12:02:00+02:00",
      timetabledDepartureTime: "2026-09-04T12:02:00+02:00",
      delayMinutes: 0,
    },
    {
      ...call("europaplatz", "de:08212:1004"),
      timetabledArrivalTime: "2026-09-04T12:04:00+02:00",
      timetabledDepartureTime: "2026-09-04T12:04:00+02:00",
      delayMinutes: 0,
    },
  ]);
  const journey = stopEvent("zentrum-before-start", calls, {
    id: "zentrum-before-start",
    datedJourneyId: "zentrum-before-start@today",
  });
  const reading = buildZentrumSchematicReading(drawn([board(journey)]));

  const [vehicle] = getZentrumSchematicVehicles(
    reading,
    [journey],
    Date.parse("2026-09-04T11:56:00+02:00"),
    motions,
  );

  assert.equal(vehicle?.phase, "beforeStart");
  assert.equal(vehicle?.from.id, "kronenplatz");
  assert.equal(vehicle?.progress, 0);
  assert.equal(vehicle?.x, vehicle?.from.x);
  assert.equal(vehicle?.y, vehicle?.from.y);
});

test("keeps a vehicle standing after its Zentrum journey ends", () => {
  const calls = datedJourney([
    {
      ...call("kronenplatz", "de:08212:1002"),
      timetabledArrivalTime: "2026-09-04T12:00:00+02:00",
      timetabledDepartureTime: "2026-09-04T12:00:00+02:00",
      delayMinutes: 0,
    },
    {
      ...call("marktplatz", "de:08212:1003"),
      timetabledArrivalTime: "2026-09-04T12:02:00+02:00",
      timetabledDepartureTime: "2026-09-04T12:02:00+02:00",
      delayMinutes: 0,
    },
    {
      ...call("europaplatz", "de:08212:1004"),
      timetabledArrivalTime: "2026-09-04T12:04:00+02:00",
      timetabledDepartureTime: "2026-09-04T12:04:00+02:00",
      delayMinutes: 0,
    },
  ]);
  const journey = stopEvent("zentrum-after-end", calls, {
    id: "zentrum-after-end",
    datedJourneyId: "zentrum-after-end@today",
  });
  const reading = buildZentrumSchematicReading(drawn([board(journey)]));

  const [vehicle] = getZentrumSchematicVehicles(
    reading,
    [journey],
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
  const arriving = stopEvent(
    "2",
    datedJourney([
      {
        ...call("muehlburger-tor", "de:08212:39"),
        timetabledArrivalTime: "2026-09-04T12:00:00+02:00",
        timetabledDepartureTime: "2026-09-04T12:00:00+02:00",
        delayMinutes: 0,
      },
      {
        ...call("europaplatz", "de:08212:37"),
        timetabledArrivalTime: "2026-09-04T12:02:00+02:00",
        timetabledDepartureTime: "2026-09-04T12:02:00+02:00",
        delayMinutes: 0,
      },
      {
        ...call("karlstor", "de:08212:61"),
        timetabledArrivalTime: "2026-09-04T12:04:00+02:00",
        timetabledDepartureTime: "2026-09-04T12:04:00+02:00",
        delayMinutes: 0,
      },
    ]),
    { id: "zentrum-arrival", datedJourneyId: "zentrum-arrival@today" },
  );
  const departing = stopEvent(
    "2",
    datedJourney([
      {
        ...call("karlstor", "de:08212:61"),
        timetabledArrivalTime: "2026-09-04T12:10:00+02:00",
        timetabledDepartureTime: "2026-09-04T12:10:00+02:00",
        delayMinutes: 0,
      },
      {
        ...call("europaplatz", "de:08212:37"),
        timetabledArrivalTime: "2026-09-04T12:12:00+02:00",
        timetabledDepartureTime: "2026-09-04T12:12:00+02:00",
        delayMinutes: 0,
      },
      {
        ...call("muehlburger-tor", "de:08212:39"),
        timetabledArrivalTime: "2026-09-04T12:14:00+02:00",
        timetabledDepartureTime: "2026-09-04T12:14:00+02:00",
        delayMinutes: 0,
      },
    ]),
    { id: "zentrum-departure", datedJourneyId: "zentrum-departure@today" },
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
    createDatedJourneyMotions(),
  );
  assert.deepEqual(
    approaching.map(({ id, markerKey, phase }) => [id, markerKey, phase]),
    [["zentrum-arrival@today", "zentrum-departure@today", "running"]],
  );
});

/* Both directions of a line hold one lane, so meeting trams briefly overlap. */
test("marks ride their line's lane, either way along the corridor", () => {
  const timedCall = (stopPlaceId: string, stopPointId: string, minute: number): Call => ({
    ...call(stopPlaceId, stopPointId),
    timetabledArrivalTime: `2026-09-04T12:0${minute}:00+02:00`,
    timetabledDepartureTime: `2026-09-04T12:0${minute}:00+02:00`,
    delayMinutes: 0,
  });
  const westbound = stopEvent(
    "S1",
    [
      timedCall("kronenplatz", "de:08212:1002", 0),
      timedCall("marktplatz", "de:08212:1003", 2),
      timedCall("europaplatz", "de:08212:1004", 4),
    ],
    { id: "westbound", datedJourneyId: "westbound", delayMinutes: 0 },
  );
  const eastbound = stopEvent(
    "S1",
    [
      timedCall("europaplatz", "de:08212:1004", 0),
      timedCall("marktplatz", "de:08212:1003", 2),
      timedCall("kronenplatz", "de:08212:1002", 4),
    ],
    { id: "eastbound", datedJourneyId: "eastbound", delayMinutes: 0 },
  );
  const tram = stopEvent(
    "2",
    [timedCall("kronenplatz", "de:08212:1002", 0), timedCall("marktplatz", "de:08212:1003", 2)],
    { id: "tram", datedJourneyId: "tram", delayMinutes: 0 },
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
  const timedCall = (stopPlaceId: string, stopPointId: string, minute: number): Call => ({
    ...call(stopPlaceId, stopPointId),
    timetabledArrivalTime: `2026-09-04T12:0${minute}:00+02:00`,
    timetabledDepartureTime: `2026-09-04T12:0${minute}:00+02:00`,
    delayMinutes: 0,
  });
  const through = stopEvent(
    "2",
    [
      timedCall("muehlburger-tor", "de:08212:39", 0),
      timedCall("europaplatz", "de:08212:37", 2),
      timedCall("karlstor", "de:08212:61", 4),
    ],
    { id: "ride-through", datedJourneyId: "ride-through", delayMinutes: 0 },
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

test("parks a mark inside a stop place its reading starts in, pointing the way out", () => {
  // The S1 crossing between Marktplatz's tunnels, with no call before it to say which way it came
  // in: the mark parks where the leaving corridor's lane begins, facing its way out.
  const timedCall = (stopPlaceId: string, stopPointId: string, minute: number): Call => ({
    ...call(stopPlaceId, stopPointId),
    timetabledArrivalTime: `2026-09-04T12:0${minute}:00+02:00`,
    timetabledDepartureTime: `2026-09-04T12:0${minute}:00+02:00`,
    delayMinutes: 0,
  });
  const crossing = stopEvent(
    "S1",
    [
      timedCall("marktplatz", "de:08212:1011", 2),
      timedCall("marktplatz", "de:08212:1003", 4),
      timedCall("europaplatz", "de:08212:1004", 6),
    ],
    { id: "tunnel-crossing", datedJourneyId: "tunnel-crossing", delayMinutes: 0 },
  );
  const through = stopEvent(
    "S1",
    [
      timedCall("ettlinger-tor", "de:08212:1012", 0),
      timedCall("marktplatz", "de:08212:1011", 2),
      timedCall("marktplatz", "de:08212:1003", 4),
      timedCall("europaplatz", "de:08212:1004", 6),
    ],
    { id: "tunnel-through", datedJourneyId: "tunnel-through", delayMinutes: 0 },
  );

  const reading = buildZentrumSchematicReading(drawn([board(crossing, through)]));
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

test("stands at each of a stop place's two capsules in turn and rides between them", () => {
  // The S1 calls at Marktplatz's Kaiserstraße tunnel, then beneath the Pyramide, a minute apart.
  const located = (
    stopPlaceId: string,
    stopPointId: string,
    bay: string,
    [latitude, longitude]: readonly [number, number],
    [arrival, departure]: readonly [string, string],
  ): Call => ({
    ...call(stopPlaceId, stopPointId, bay),
    latitude,
    longitude,
    timetabledArrivalTime: `2026-09-04T12:${arrival}:00+02:00`,
    timetabledDepartureTime: `2026-09-04T12:${departure}:00+02:00`,
    delayMinutes: 0,
  });
  const southbound = stopEvent(
    "S1",
    [
      located("muehlburger-tor", "de:08212:39", "2a", [49.010552, 8.383653], ["00", "01"]),
      located("europaplatz", "de:08212:1004", "2(U)", [49.009998, 8.39464], ["02", "03"]),
      located("marktplatz", "de:08212:1003", "2(U)", [49.009615, 8.402958], ["04", "05"]),
      located("marktplatz", "de:08212:1011", "3(U)", [49.008301, 8.403766], ["07", "08"]),
      located("ettlinger-tor", "de:08212:1012", "3(U)", [49.005078, 8.403434], ["09", "09"]),
      located("kongresszentrum", "de:08212:1013", "3(U)", [49.0023, 8.4035], ["10", "10"]),
    ],
    { id: "s1-south", datedJourneyId: "s1-south", delayMinutes: 0 },
  );
  const northbound = stopEvent(
    "S1",
    [
      located("kongresszentrum", "de:08212:1013", "4(U)", [49.0025, 8.4037], ["00", "00"]),
      located("ettlinger-tor", "de:08212:1012", "4(U)", [49.005773, 8.403569], ["01", "01"]),
      located("marktplatz", "de:08212:1011", "4(U)", [49.009008, 8.403757], ["02", "03"]),
      located("marktplatz", "de:08212:1003", "1(U)", [49.009709, 8.401673], ["04", "05"]),
      located("europaplatz", "de:08212:1004", "1(U)", [49.010069, 8.393714], ["06", "07"]),
      located("muehlburger-tor", "de:08212:39", "1a", [49.010617, 8.382764], ["08", "08"]),
    ],
    { id: "s1-north", datedJourneyId: "s1-north", delayMinutes: 0 },
  );
  const reading = buildZentrumSchematicReading(drawn([board(southbound, northbound)]));
  const capsules = reading.stopMarks.find(({ nodeId }) => nodeId === "marktplatz")?.capsules ?? [];
  assert.equal(capsules.length, 2);
  const nearestCapsule = (point: { x: number; y: number }) => {
    const distances = capsules.map(({ from, to }) => {
      const run = { x: to.x - from.x, y: to.y - from.y };
      const share = Math.max(
        0,
        Math.min(
          1,
          ((point.x - from.x) * run.x + (point.y - from.y) * run.y) /
            (run.x * run.x + run.y * run.y),
        ),
      );
      return Math.hypot(point.x - from.x - share * run.x, point.y - from.y - share * run.y);
    });
    const distance = Math.min(...distances);
    return { index: distances.indexOf(distance), distance };
  };

  const stands = (datedJourney: StopEvent, firstStand: string, secondStand: string) => {
    const drawnAt = new Map<number, { x: number; y: number }>();
    const datedJourneyMotions = createDatedJourneyMotions();
    const start = Date.parse(`2026-09-04T12:${firstStand}:00+02:00`) - 60_000;
    const end = Date.parse(`2026-09-04T12:${secondStand}:00+02:00`) + 60_000;
    for (let at = start; at <= end; at += 1_000) {
      const [vehicle] = getZentrumSchematicVehicles(
        reading,
        [datedJourney],
        at,
        datedJourneyMotions,
      );
      assert.ok(vehicle);
      const previous = drawnAt.get(at - 1_000);
      // Every second's step is travel, never a hop.
      if (previous) assert.ok(Math.hypot(vehicle.x - previous.x, vehicle.y - previous.y) < 6);
      drawnAt.set(at, vehicle);
    }
    const at = (time: string) =>
      nearestCapsule(drawnAt.get(Date.parse(`2026-09-04T12:${time}+02:00`))!);
    // Late in each stand: a minute-grain stand of a minute is drawn from the middle of it.
    return [at(`${firstStand}:45`), at(`${secondStand}:45`)];
  };

  for (const [datedJourney, first, second] of [
    [southbound, "04", "07"],
    [northbound, "02", "04"],
  ] as const) {
    const [atFirst, atSecond] = stands(datedJourney, first, second);
    assert.ok(atFirst.distance < 1, `${datedJourney.id} stands on a capsule at its first call`);
    assert.ok(atSecond.distance < 1, `${datedJourney.id} stands on a capsule at its second call`);
    assert.notEqual(atFirst.index, atSecond.index);
  }
});

test("rides the line's lane through a stop the feed left untimed", () => {
  // An untimed call between two timed ones: the mark follows the lane through the stop, not a
  // chord.
  const timedCall = (
    stopPlaceId: string,
    stopPointId: string,
    minute: number | undefined,
  ): Call => ({
    ...call(stopPlaceId, stopPointId),
    timetabledArrivalTime: minute === undefined ? undefined : `2026-09-04T12:0${minute}:00+02:00`,
    timetabledDepartureTime: minute === undefined ? undefined : `2026-09-04T12:0${minute}:00+02:00`,
    delayMinutes: 0,
  });
  const past = stopEvent(
    "2",
    [
      timedCall("muehlburger-tor", "de:08212:39", 0),
      timedCall("europaplatz", "de:08212:37", undefined),
      timedCall("karlstor", "de:08212:61", 4),
    ],
    { id: "untimed-stop", datedJourneyId: "untimed-stop", delayMinutes: 0 },
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
  const timedCall = (stopPlaceId: string, stopPointId: string, minute: number): Call => ({
    ...call(stopPlaceId, stopPointId),
    timetabledArrivalTime: `2026-09-04T12:0${minute}:00+02:00`,
    timetabledDepartureTime: `2026-09-04T12:0${minute}:00+02:00`,
    delayMinutes: 0,
  });
  const eastbound = stopEvent(
    "S1",
    [
      timedCall("europaplatz", "de:08212:1004", 0),
      timedCall("marktplatz", "de:08212:1003", 2),
      timedCall("kronenplatz", "de:08212:1002", 4),
    ],
    { id: "ahead-eastbound", datedJourneyId: "ahead-eastbound", delayMinutes: 0 },
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
  const east = [call("kronenplatz", "de:08212:2"), call("durlacher-tor", "de:08212:1001")];
  const reading = buildZentrumSchematicReading(
    drawn([
      board(
        stopEvent("S2", [...east, call("gottesauer-platz", "de:08212:4")], {
          id: "s2",
          journeyRef: "s2",
        }),
        stopEvent("S5", [...east, call("gottesauer-platz", "de:08212:4")], {
          id: "s5",
          journeyRef: "s5",
        }),
        stopEvent("1", [...east, call("gottesauer-platz", "de:08212:4")]),
        stopEvent("4", [
          call("rueppurrer-tor", "de:08212:66"),
          call("durlacher-tor", "de:08212:3"),
          call("karl-wilhelm-platz", "de:08212:5"),
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
        stopEvent(
          "S11",
          [
            call("muehlburger-tor", "de:08212:39"),
            call("europaplatz", "de:08212:37"),
            call("karlstor", "de:08212:61"),
          ],
          { id: "s11", journeyRef: "s11" },
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
        stopEvent("6", [call("poststrasse", "de:08212:1017"), call("tivoli", "de:08212:1018")]),
        stopEvent("3", [
          call("poststrasse", "de:08212:1017"),
          call("tivoli", "de:08212:1018"),
          call("werderstrasse", "de:08212:1019"),
        ]),
        stopEvent("E", [call("werderstrasse", "de:08212:1019"), call("tivoli", "de:08212:1020")]),
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
        stopEvent("3", [
          call("muehlburger-tor", "de:08212:39"),
          call("europaplatz", "de:08212:1004"),
          call("karlstor", "de:08212:61"),
          call("mathystrasse", "de:08212:62"),
        ]),
        stopEvent("4", [
          call("muehlburger-tor", "de:08212:39"),
          call("europaplatz", "de:08212:1004"),
          call("karlstor", "de:08212:61"),
          call("ettlinger-tor", "de:08212:1012"),
        ]),
        stopEvent("1", [
          call("muehlburger-tor", "de:08212:39"),
          call("europaplatz", "de:08212:1004"),
          call("marktplatz", "de:08212:1003"),
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
  const marktplatz = call("marktplatz", "de:08212:1003");
  const ettlinger = call("ettlinger-tor", "de:08212:1012");
  const kongress = call("kongresszentrum", "de:08212:1013");
  const fromWest = [call("europaplatz", "de:08212:1004"), marktplatz, ettlinger, kongress];
  const fromEast = [call("kronenplatz", "de:08212:1002"), marktplatz, ettlinger, kongress];
  const reading = buildZentrumSchematicReading(
    drawn([
      board(
        stopEvent("1", [
          call("kronenplatz", "de:08212:1002"),
          marktplatz,
          call("europaplatz", "de:08212:1004"),
        ]),
        stopEvent("S1", fromWest, { id: "s1", journeyRef: "s1" }),
        stopEvent("S2", fromWest, { id: "s2", journeyRef: "s2" }),
        stopEvent("S4", fromEast, { id: "s4", journeyRef: "s4" }),
        stopEvent("S8", fromEast, { id: "s8", journeyRef: "s8" }),
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

test("a stop place has one authored stop name; boarding places come from observed platforms", () => {
  assert.equal(
    ZENTRUM_SCHEMATIC_NODES.filter((node) => (node.stopId ?? node.id) === "tullastrasse").length,
    1,
  );
  assert.ok(!ZENTRUM_SCHEMATIC_NODES.some((node) => node.label === "Tullastraße (Nord)"));
});

test("an unrelated arrival cannot hide a standing departure at its terminus", () => {
  const arriving = stopEvent(
    "S8",
    [
      {
        ...call("gottesauer-platz", "de:08212:6"),
        timetabledDepartureTime: "2026-09-04T12:00:00+02:00",
        delayMinutes: 0,
      },
      {
        ...call("tullastrasse", "de:08212:34"),
        timetabledArrivalTime: "2026-09-04T12:02:00+02:00",
        delayMinutes: 0,
      },
    ],
    { id: "arriving", datedJourneyId: "arriving" },
  );
  const waiting = stopEvent(
    "S12",
    [
      {
        ...call("tullastrasse", "de:08212:34"),
        timetabledDepartureTime: "2026-09-04T12:08:00+02:00",
        delayMinutes: 0,
      },
      {
        ...call("gottesauer-platz", "de:08212:6"),
        timetabledArrivalTime: "2026-09-04T12:10:00+02:00",
        delayMinutes: 0,
      },
    ],
    { id: "waiting", datedJourneyId: "waiting" },
  );
  const schematic = buildZentrumSchematicReading([arriving, waiting]);
  const vehicles = getZentrumSchematicVehicles(
    schematic,
    [arriving, waiting],
    Date.parse("2026-09-04T12:02:30+02:00"),
    createDatedJourneyMotions(),
  );
  assert.equal(vehicles.find((v) => v.id === "waiting")?.phase, "beforeStart");
  assert.equal(vehicles.find((v) => v.id === "arriving")?.phase, "afterEnd");
});
