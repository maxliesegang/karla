import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { Departure, TripCall } from "../src/data/transit-types.ts";
import {
  type ZentrumSchematicReading,
  buildZentrumSchematicReading,
} from "../src/lib/zentrum-schematic.ts";
import {
  getZentrumSchematicLabelBox,
  placeZentrumSchematicLabels,
} from "../src/lib/zentrum-schematic-labels.ts";
import {
  ZENTRUM_SCHEMATIC_VIEWBOX,
  type ZentrumSchematicStroke,
  getEdgeKey,
  getZentrumSchematicRoutes,
  zentrumSchematicNodeById,
} from "../src/lib/zentrum-schematic-plan.ts";
import { getZentrumSchematicLaneBends } from "../src/lib/zentrum-schematic-paths.ts";
import {
  ZENTRUM_SCHEMATIC_STOP_CAPSULE_WIDTH,
  getBandOutline,
  getStrokeOutline,
  isOverlapping,
} from "../src/lib/zentrum-schematic-stops.ts";
import { ZENTRUM_PORTRAIT_FRAME } from "../src/lib/zentrum-plan-canvas.ts";
import { createDeparture } from "./support/fixtures.ts";

const call = (
  localStopId: string,
  providerStopPointId: string,
  platformCode = "1",
  place?: { latitude: number; longitude: number },
): TripCall => ({
  stopName: localStopId,
  localStopId,
  providerStopPointId,
  platformCode,
  ...place,
});

let tripNumber = 0;
const departure = (lineId: string, tripCalls: readonly TripCall[]): Departure => {
  tripNumber += 1;
  return createDeparture({
    id: `trip-${tripNumber}`,
    tripId: `trip-${tripNumber}`,
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
  });
};

const markAt = (reading: ZentrumSchematicReading, nodeId: string) => {
  const mark = reading.stopMarks.find((candidate) => candidate.nodeId === nodeId);
  assert.ok(mark, `no mark at ${nodeId}`);
  return mark;
};

const getCentre = ({ from, to }: ZentrumSchematicStroke) => ({
  x: (from.x + to.x) / 2,
  y: (from.y + to.y) / 2,
});

const getPlaceArms = (reading: ZentrumSchematicReading, nodeId: string) =>
  reading.boardingPlacesByNodeId
    .get(nodeId)
    ?.map((place) => [...place.armTripCounts.keys()].sort());

/** A stop on a band gets one capsule across every lane. */
test("marks a through stop with one capsule across every lane", () => {
  const along = [
    call("muehlburger-tor", "7000039"),
    call("europaplatz", "7000037"),
    call("marktplatz", "7000041"),
  ];
  const reading = buildZentrumSchematicReading(
    ["1", "2", "3"].map((lineId) => departure(lineId, along)),
  );
  const mark = markAt(reading, "europaplatz");

  assert.equal(mark.capsules.length, 1);
  assert.equal(mark.links.length, 0);
  assert.equal(mark.main.from.x, mark.main.to.x);
  assert.ok(Math.abs(mark.main.to.y - mark.main.from.y) > 3 * reading.trackWidth);
  assert.deepEqual(getCentre(mark.main), { x: 374, y: 154 });
});

/** A stop on a bend gets one pill across it, as TfL draws a station on a curve. */
test("marks a corner stop with one diagonal pill", () => {
  const turning = [
    call("werderstrasse", "7000083"),
    call("tivoli", "7000084"),
    call("poststrasse", "7000098"),
  ];
  const reading = buildZentrumSchematicReading(
    ["3", "4"].map((lineId) => departure(lineId, turning)),
  );
  const mark = markAt(reading, "tivoli");

  assert.equal(mark.capsules.length, 1);
  const run = { x: mark.main.to.x - mark.main.from.x, y: mark.main.to.y - mark.main.from.y };
  // Along the diagonal between the arm north and the arm west.
  assert.ok(Math.abs(Math.abs(run.x) - Math.abs(run.y)) < 0.01);
  assert.ok(Math.hypot(run.x, run.y) > 2 * reading.trackWidth);
});

const node = (id: string) => {
  const found = zentrumSchematicNodeById.get(id);
  assert.ok(found, id);
  return found;
};

/** Albtalbahnhof's platforms run north to south: its corridors leave north and turn square. */
test("routes a stop's corridors along its platforms and square through one junction", () => {
  const [albtal, ebert, hbf] = ["albtalbahnhof", "ebertstrasse", "hauptbahnhof"].map(node);
  const routes = getZentrumSchematicRoutes([
    [albtal, ebert],
    [albtal, hbf],
    [ebert, hbf],
  ]);
  const ids = (from: string, to: string) => routes.get(getEdgeKey(from, to))?.map(({ id }) => id);
  const junction = `junction:${albtal.x},${ebert.y}`;

  assert.deepEqual(ids("albtalbahnhof", "ebertstrasse"), [
    "albtalbahnhof",
    junction,
    "ebertstrasse",
  ]);
  assert.deepEqual(ids("albtalbahnhof", "hauptbahnhof"), [
    "albtalbahnhof",
    junction,
    "hauptbahnhof",
  ]);
  // The street the corridors turn into is split there, so all three share it.
  assert.deepEqual(ids("ebertstrasse", "hauptbahnhof"), ["ebertstrasse", junction, "hauptbahnhof"]);
});

test("marks every stop around the junction with one capsule, and the junction with none", () => {
  const reading = buildZentrumSchematicReading([
    departure("E", [call("albtalbahnhof", "7001201"), call("ebertstrasse", "7000091")]),
    ...["S1", "S4", "S7"].map((lineId) =>
      departure(lineId, [
        call("albtalbahnhof", "7001201"),
        call("hauptbahnhof", "7000089"),
        call("poststrasse", "7000098"),
      ]),
    ),
    ...["3", "6"].map((lineId) =>
      departure(lineId, [
        call("ebertstrasse", "7000091"),
        call("hauptbahnhof", "7000089"),
        call("poststrasse", "7000098"),
      ]),
    ),
  ]);

  assert.deepEqual(reading.stopMarks.map(({ nodeId }) => nodeId).sort(), [
    "albtalbahnhof",
    "ebertstrasse",
    "hauptbahnhof",
    "poststrasse",
  ]);
  for (const nodeId of ["albtalbahnhof", "ebertstrasse", "hauptbahnhof"]) {
    const mark = markAt(reading, nodeId);
    assert.equal(mark.capsules.length, 1, nodeId);
    assert.equal(mark.links.length, 0, nodeId);
  }
  const albtal = markAt(reading, "albtalbahnhof").main;
  assert.equal(albtal.from.y, albtal.to.y);

  // E leaves Albtalbahnhof north and reaches Ebertstraße heading west: one corridor, one path.
  const path = reading.vehiclePathsByLineId
    .get("E")
    ?.get(getEdgeKey("albtalbahnhof", "ebertstrasse"));
  assert.ok(path);
  const points = path.fromNodeId === "albtalbahnhof" ? path.points : [...path.points].reverse();
  const [start, second] = points;
  const [before, end] = points.slice(-2);
  assert.ok(Math.abs(second.x - start.x) < 0.01 && second.y < start.y, "leaves north");
  assert.ok(Math.abs(end.y - before.y) < 0.01 && end.x < before.x, "arrives heading west");

  // Lanes turning together keep a lane apart through the curve.
  const junctionBends = getZentrumSchematicLaneBends(
    reading.linePaths,
    reading.edges,
    reading.trackWidth,
  ).filter(({ nodeId }) => nodeId.startsWith("junction:"));
  const middle = (trackId: string) => {
    const bend = junctionBends.find((one) => one.trackId === trackId);
    assert.ok(bend, trackId);
    return bend.points[Math.floor(bend.points.length / 2)];
  };
  const [s1, s4, s7] = ["S1", "S4", "S7"].map(middle);
  for (const [left, right] of [
    [s1, s4],
    [s4, s7],
  ]) {
    const gap = Math.hypot(left.x - right.x, left.y - right.y);
    assert.ok(Math.abs(gap - reading.trackWidth) < 0.05 * reading.trackWidth, `${gap}`);
  }
});

/* Two streets through one place, no capsule crossing both: one capsule each, linked. */
test("marks each street of a crossing with its own capsule, linked", () => {
  const through = (lineId: string, stopIds: readonly string[]) =>
    departure(
      lineId,
      stopIds.map((stopId) => call(stopId, stopId)),
    );
  const reading = buildZentrumSchematicReading([
    through("S2", ["kronenplatz", "durlacher-tor", "gottesauer-platz"]),
    through("4", ["karl-wilhelm-platz", "durlacher-tor", "rueppurrer-tor"]),
    through("S1", ["marktplatz", "ettlinger-tor", "kongresszentrum"]),
    through("5", ["karlstor", "ettlinger-tor", "rueppurrer-tor"]),
  ]);

  for (const nodeId of ["durlacher-tor", "ettlinger-tor"]) {
    const mark = markAt(reading, nodeId);
    assert.equal(mark.capsules.length, 2, nodeId);
    assert.equal(mark.links.length, 1, nodeId);
    assertOctilinear(mark.links[0]);
  }
});

/** Links run one of the eight directions. */
const assertOctilinear = ({ from, to }: ZentrumSchematicStroke) => {
  const angle = (Math.atan2(to.y - from.y, to.x - from.x) * 4) / Math.PI;
  assert.ok(Math.abs(angle - Math.round(angle)) < 1e-6, `a link at ${angle * 45} degrees`);
};

/**
 * Karlstor is two places a street apart: line 3 north–south, lines 4 and 5 towards Ettlinger Tor.
 */
test("draws a stop the platforms say is two places as two capsules, linked", () => {
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
    ...["4", "5"].map((lineId) => departure(lineId, eastward)),
    ...["3", "3", "3"].map((lineId) => departure(lineId, southward)),
  ]);

  assert.deepEqual(getPlaceArms(reading, "karlstor"), [
    ["europaplatz", "mathystrasse"],
    ["ettlinger-tor", "europaplatz"],
  ]);
  const mark = markAt(reading, "karlstor");
  assert.equal(mark.capsules.length, 2);
  assert.equal(mark.links.length, 1);
  // Line 3's capsule south, lines 4/5's east, linked through the empty corner.
  const [south, east] = [...mark.capsules].sort((left, right) => left.from.x - right.from.x);
  assert.equal(south.from.y, south.to.y);
  assert.ok(south.from.y > 286 + reading.trackWidth);
  assert.equal(east.from.x, east.to.x);
  assert.ok(east.from.x > 374 + reading.trackWidth);
  assertOctilinear(mark.links[0]);
});

/**
 * Europaplatz's Kaiserstraße platforms join the tunnel's place; the Karlstraße pair, serving the
 * south branch alone, is another.
 */
test("gathers platforms serving only another's corridors into its place", () => {
  const tunnel = [
    call("muehlburger-tor", "7000039"),
    call("europaplatz", "7001004", "2(U)"),
    call("marktplatz", "7001003", "2(U)"),
  ];
  const street = [
    call("muehlburger-tor", "7000039"),
    call("europaplatz", "7000037", "5"),
    call("europaplatz", "7000037", "3"),
    call("karlstor", "7000061", "3"),
  ];
  const reading = buildZentrumSchematicReading([
    ...["1", "S1", "S2"].map((lineId) => departure(lineId, tunnel)),
    ...["3", "4"].map((lineId) => departure(lineId, street)),
  ]);

  assert.deepEqual(getPlaceArms(reading, "europaplatz"), [
    ["marktplatz", "muehlburger-tor"],
    ["karlstor"],
  ]);
  assert.equal(markAt(reading, "europaplatz").capsules.length, 2);
});

/** The Hauptbahnhof's two islands each serve S-Bahn and trams: one place. */
test("gathers platforms standing together into one place, whatever runs through them", () => {
  const near = { latitude: 48.99437, longitude: 8.39967 };
  const beside = { latitude: 48.99441, longitude: 8.39966 };
  const apart = { latitude: 48.99359, longitude: 8.39967 };
  const read = (other: { latitude: number; longitude: number }) =>
    buildZentrumSchematicReading([
      departure("S1", [
        call("albtalbahnhof", "7001201"),
        call("hauptbahnhof", "7000089", "21", near),
        call("poststrasse", "7000098"),
      ]),
      departure("3", [
        call("ebertstrasse", "7000091"),
        call("hauptbahnhof", "7000089", "22", other),
        call("poststrasse", "7000098"),
      ]),
    ]);

  assert.equal(read(beside).boardingPlacesByNodeId.has("hauptbahnhof"), false);
  // Ninety metres apart, they are two places.
  assert.equal(read(apart).boardingPlacesByNodeId.get("hauptbahnhof")?.length, 2);
});

test("a place with a corridor along its platforms crosses at the stop, on its own side", () => {
  const at = (code: string, latitude: number, longitude: number) =>
    call("karlstor", "7000061", code, { latitude, longitude });
  const reading = buildZentrumSchematicReading([
    departure("4", [
      call("europaplatz", "7000037"),
      at("3", 49.005184, 8.394622),
      call("mathystrasse", "7000062"),
    ]),
    departure("4", [
      call("mathystrasse", "7000062"),
      at("4", 49.004423, 8.394514),
      call("europaplatz", "7000037"),
    ]),
    departure("5", [
      call("ettlinger-tor", "7000071"),
      at("1", 49.005502, 8.395421),
      call("europaplatz", "7000037"),
    ]),
    departure("5", [
      call("europaplatz", "7000037"),
      at("2", 49.005467, 8.395951),
      call("ettlinger-tor", "7000071"),
    ]),
  ]);

  assert.ok([...reading.nodesById.values()].every((node) => node.stopId !== "karlstor"));
  const karlstor = reading.nodesById.get("karlstor")!;
  // Platforms 3 and 4 run north–south, south of 1 and 2: across the line to Mathystraße.
  assert.ok(
    markAt(reading, "karlstor").capsules.some(
      (capsule) => capsule.from.y === capsule.to.y && getCentre(capsule).y > karlstor.y,
    ),
  );
});

/** A platform seen a handful of times is a diversion or layover, not a place. */
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
    ...Array.from({ length: 30 }, () => departure("1", along)),
    departure("1", diverted),
  ]);

  assert.equal(reading.boardingPlacesByNodeId.has("karlstor"), false);
  assert.equal(markAt(reading, "karlstor").links.length, 0);
});

/* The Zentrum boards' calling patterns, with trip counts. */
type LiveCall = [string, string, string, number | null, number | null];
const readLiveTrips = (fileName: string) =>
  (
    JSON.parse(readFileSync(new URL(`./support/${fileName}`, import.meta.url), "utf8")) as {
      lineId: string;
      mode: "tram" | "lightRail";
      count: number;
      calls: LiveCall[];
    }[]
  ).flatMap(({ lineId, mode, count, calls }) =>
    Array.from({ length: count }, () => ({
      ...departure(
        lineId,
        calls.map(([localStopId, providerStopPointId, platformCode, latitude, longitude]) =>
          call(
            localStopId,
            providerStopPointId,
            platformCode,
            latitude === null || longitude === null ? undefined : { latitude, longitude },
          ),
        ),
      ),
      transportMode: mode,
    })),
  );
/* 3 October 2026, all day; and the runs drawn early on 5 October 2026. */
const liveTrips = readLiveTrips("zentrum-live-trips.json");
const morningRuns = readLiveTrips("zentrum-live-runs-morning.json");

test("reads the places a rider walks between off a day's trips", () => {
  const reading = buildZentrumSchematicReading(liveTrips);

  assert.deepEqual([...reading.boardingPlacesByNodeId.keys()].sort(), [
    "durlacher-tor",
    "ettlinger-tor",
    "europaplatz",
    "karlstor",
    "marktplatz",
    "rueppurrer-tor",
  ]);
  for (const places of reading.boardingPlacesByNodeId.values()) assert.equal(places.length, 2);
  for (const mark of reading.stopMarks) for (const link of mark.links) assertOctilinear(link);
  // A second capsule stays clear of bands it does not mark.
  for (const mark of reading.stopMarks) {
    for (const capsule of mark.capsules.slice(1)) {
      const outline = getStrokeOutline(
        capsule,
        (reading.trackWidth * ZENTRUM_SCHEMATIC_STOP_CAPSULE_WIDTH) / 2,
      );
      const crossed = reading.edges.filter((edge) =>
        isOverlapping(outline, getBandOutline(edge, reading.trackWidth)),
      );
      assert.equal(crossed.length, 1, `${mark.nodeId} crosses ${crossed.length} bands`);
    }
  }
});

test("stands each place on its own arm, linked round the corner where no straight link fits", () => {
  // Karlstor: lines 4, 5, S5 and S12 call east of the junction, 3 and S12 south of it.
  const reading = buildZentrumSchematicReading(morningRuns);
  const node = zentrumSchematicNodeById.get("karlstor");
  const mark = markAt(reading, "karlstor");
  assert.ok(node);
  const [east, south] = mark.capsules;
  assert.ok(east.from.x > node.x && east.to.x > node.x);
  assert.ok(south.from.y > node.y && south.to.y > node.y);
  assert.ok(mark.links.length > 0);
  for (const link of mark.links) assertOctilinear(link);
});

test("keeps lines running on together in order where another joins them for one corridor", () => {
  const reading = buildZentrumSchematicReading(liveTrips);
  const lanes = (edgeId: string) => reading.edges.find(({ id }) => id === edgeId)?.trackIds ?? [];
  const side = (edgeId: string) =>
    Math.sign(lanes(edgeId).indexOf("3") - lanes(edgeId).indexOf("4"));

  // 3 and 4 turn west at Europaplatz together; S1 shares Hauptbahnhof's corridors with 3 elsewhere.
  assert.notEqual(side(getEdgeKey("europaplatz", "karlstor")), 0);
  assert.equal(
    side(getEdgeKey("europaplatz", "muehlburger-tor")),
    side(getEdgeKey("europaplatz", "karlstor")),
  );
});

/** Capsules cross straight lanes and never touch another stop's. */
test("keeps every capsule off the curves, and clear of every other stop", () => {
  const reading = buildZentrumSchematicReading(liveTrips);
  const halfWidth = (reading.trackWidth * ZENTRUM_SCHEMATIC_STOP_CAPSULE_WIDTH) / 2;
  const bends = getZentrumSchematicLaneBends(reading.linePaths, reading.edges, reading.trackWidth);
  for (const mark of reading.stopMarks) {
    if (mark.links.length === 0 && mark.capsules.length === 1 && isDiagonalPill(mark.main))
      continue;
    for (const capsule of mark.capsules) {
      const outline = getStrokeOutline(capsule, halfWidth);
      for (const bend of bends.filter(({ nodeId }) => nodeId === mark.nodeId)) {
        for (const [index, point] of bend.points.slice(1).entries()) {
          const lane = getStrokeOutline({ from: bend.points[index], to: point }, 0.01);
          assert.ok(
            !isOverlapping(outline, lane),
            `${mark.nodeId} sits on line ${bend.trackId}'s curve`,
          );
        }
      }
      for (const other of reading.stopMarks.filter(({ nodeId }) => nodeId !== mark.nodeId)) {
        for (const theirs of other.capsules) {
          assert.ok(
            !isOverlapping(outline, getStrokeOutline(theirs, halfWidth)),
            `${mark.nodeId} touches ${other.nodeId}`,
          );
        }
      }
    }
  }
});

/**
 * Marks halt on their stop's capsule wherever it stands: Europaplatz's tunnel capsule is west of
 * the junction, so a tram from Karlstor halts on the Karlstraße before the corner.
 */
test("halts every mark on its stop's capsule", () => {
  const reading = buildZentrumSchematicReading(liveTrips);
  const distanceTo = (point: { x: number; y: number }, { from, to }: ZentrumSchematicStroke) => {
    const run = { x: to.x - from.x, y: to.y - from.y };
    const share = Math.max(
      0,
      Math.min(
        1,
        ((point.x - from.x) * run.x + (point.y - from.y) * run.y) / Math.hypot(run.x, run.y) ** 2,
      ),
    );
    return Math.hypot(point.x - from.x - run.x * share, point.y - from.y - run.y * share);
  };
  for (const [lineId, paths] of reading.vehiclePathsByLineId) {
    for (const { fromNodeId, toNodeId, points } of paths.values()) {
      for (const [nodeId, point] of [
        [fromNodeId, points[0]],
        [toNodeId, points.at(-1)],
      ] as const) {
        assert.ok(point);
        const distance = Math.min(
          ...markAt(reading, nodeId).capsules.map((capsule) => distanceTo(point, capsule)),
        );
        assert.ok(distance < 0.01, `line ${lineId} halts ${distance} off ${nodeId}`);
      }
    }
  }
  const europaplatz = zentrumSchematicNodeById.get("europaplatz");
  const fromMarket = reading.vehiclePathsByLineId
    .get("S1")
    ?.get(getEdgeKey("europaplatz", "marktplatz"));
  assert.ok(europaplatz && fromMarket);
  const halt =
    fromMarket.fromNodeId === "europaplatz" ? fromMarket.points[0] : fromMarket.points.at(-1);
  assert.ok(halt && halt.x < europaplatz.x);
});

/** A corner's pill lies across the curve on purpose. */
const isDiagonalPill = ({ from, to }: ZentrumSchematicStroke) =>
  Math.abs(Math.abs(to.x - from.x) - Math.abs(to.y - from.y)) < 0.01 && to.x !== from.x;

test("on a phone, the frame holds names and travel times, including names shown on focus", () => {
  const frame = ZENTRUM_PORTRAIT_FRAME;
  const planWidth = Math.floor((372 * ZENTRUM_SCHEMATIC_VIEWBOX.width) / frame.width);
  const reading = buildZentrumSchematicReading(liveTrips, planWidth);
  const labels = placeZentrumSchematicLabels(
    reading.edges,
    reading.stopMarks,
    reading.trackWidth,
    planWidth,
    true,
  );
  // The outer columns' names have room only outward at this width, and are read by panning.
  for (const nodeId of ["europaplatz", "karlstor", "ebertstrasse", "kronenplatz", "tivoli"]) {
    const label = labels.get(nodeId);
    const name = zentrumSchematicNodeById.get(nodeId)?.label;
    assert.ok(label && name, nodeId);
    const box = getZentrumSchematicLabelBox(label, name, planWidth, true);
    assert.ok(
      box.left >= frame.x && box.right <= frame.x + frame.width && box.top >= frame.y,
      `${nodeId} is set out of view`,
    );
  }
  for (const nodeId of ["europaplatz", "karlstor", "kronenplatz"]) {
    assert.ok(labels.get(nodeId)?.fits, nodeId);
  }
  assert.equal(labels.get("ebertstrasse")?.fits, false);
  assert.equal(labels.get("tivoli")?.fits, false);
});

test("sets every name that fits inside the plan, clear of bands, capsules and other names", () => {
  for (const [planWidth, hasTimes] of [
    [1450, false],
    [1100, false],
    [1450, true],
    [1100, true],
  ] as const) {
    const reading = buildZentrumSchematicReading(liveTrips, planWidth);
    const labels = placeZentrumSchematicLabels(
      reading.edges,
      reading.stopMarks,
      reading.trackWidth,
      planWidth,
      hasTimes,
    );
    const halfWidth = (reading.trackWidth * ZENTRUM_SCHEMATIC_STOP_CAPSULE_WIDTH) / 2;
    const obstacles = [
      ...reading.edges.map((edge) => getBandOutline(edge, reading.trackWidth)),
      ...reading.stopMarks.flatMap(({ capsules }) =>
        capsules.map((capsule) => getStrokeOutline(capsule, halfWidth)),
      ),
    ];
    const placed: { nodeId: string; outline: ReturnType<typeof getBandOutline> }[] = [];
    const unfit = [...labels].filter(([, label]) => !label.fits).map(([nodeId]) => nodeId);
    // Unfitted names show on demand: none on a roomy plan.
    if (planWidth === 1450 && !hasTimes) assert.deepEqual(unfit, []);
    assert.ok(unfit.length <= 1, `${unfit.join(", ")} do not fit at ${planWidth}px`);
    for (const [nodeId, label] of labels) {
      if (!label.fits) continue;
      const name = zentrumSchematicNodeById.get(nodeId)?.label ?? nodeId;
      const box = getZentrumSchematicLabelBox(label, name, planWidth, hasTimes);
      assert.ok(
        box.left >= ZENTRUM_SCHEMATIC_VIEWBOX.x &&
          box.right <= ZENTRUM_SCHEMATIC_VIEWBOX.x + ZENTRUM_SCHEMATIC_VIEWBOX.width &&
          box.top >= ZENTRUM_SCHEMATIC_VIEWBOX.y &&
          box.bottom <= ZENTRUM_SCHEMATIC_VIEWBOX.y + ZENTRUM_SCHEMATIC_VIEWBOX.height,
        `${nodeId} leaves the plan at ${planWidth}px`,
      );
      const outline = [
        { x: box.left, y: box.top },
        { x: box.right, y: box.top },
        { x: box.right, y: box.bottom },
        { x: box.left, y: box.bottom },
      ];
      assert.ok(
        obstacles.every((obstacle) => !isOverlapping(outline, obstacle)),
        `${nodeId} is set on the drawing at ${planWidth}px`,
      );
      const clash = placed.find((other) => isOverlapping(outline, other.outline));
      assert.equal(clash, undefined, `${nodeId} is set on ${clash?.nodeId} at ${planWidth}px`);
      placed.push({ nodeId, outline });
    }
  }
});

test("the eastern extension has one name per complex and links its two Tullastraße places", () => {
  const samples: { lineId: string; tripCalls: TripCall[] }[] = JSON.parse(
    readFileSync(new URL("./support/zentrum-stop-platforms.json", import.meta.url), "utf8"),
  );
  const runs = samples.map((sample, index) =>
    createDeparture({ id: `sample-${index}`, ...sample }),
  );
  const reading = buildZentrumSchematicReading([...liveTrips, ...runs], 1450);
  const labels = placeZentrumSchematicLabels(
    reading.edges,
    reading.stopMarks,
    reading.trackWidth,
    1450,
  );
  for (const id of ["tullastrasse", "wolfartsweierer-strasse", "schloss-gottesaue"])
    assert.ok(labels.get(id)?.fits, id);
  const marks = reading.stopMarks.filter((mark) => mark.nodeId.startsWith("tullastrasse"));
  assert.equal(marks.length, 2);
  assert.ok(marks.some((mark) => mark.links.length > 0));
  assert.equal(
    reading.stopMarks.find((mark) => mark.nodeId === "schloss-gottesaue")?.capsules.length,
    1,
  );
});

test("every capsule and link runs one of the plan's eight ways", () => {
  // The eastern samples bend at Wolfartsweierer Straße by 45 degrees.
  const samples: { lineId: string; tripCalls: TripCall[] }[] = JSON.parse(
    readFileSync(new URL("./support/zentrum-stop-platforms.json", import.meta.url), "utf8"),
  );
  const reading = buildZentrumSchematicReading(
    [
      ...liveTrips,
      ...samples.map((sample, index) => createDeparture({ id: `bend-${index}`, ...sample })),
    ],
    1450,
  );
  for (const mark of reading.stopMarks) {
    for (const { from, to } of [...mark.capsules, ...mark.links]) {
      const angle = (Math.atan2(to.y - from.y, to.x - from.x) * 4) / Math.PI;
      assert.ok(Math.abs(angle - Math.round(angle)) < 1e-6, mark.nodeId);
    }
  }
});
