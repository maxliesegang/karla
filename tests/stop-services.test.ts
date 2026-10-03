import assert from "node:assert/strict";
import test from "node:test";
import { createDeparture, createLine } from "./support/fixtures.ts";
import type { Departure, TripCall } from "../src/data/transit-types.ts";
import {
  getFarthestLineRun,
  getFarthestLineRunTermini,
  getLineTermini,
  findNextCompatibleDeparture,
  findStopByName,
  hasCompatibleStopPattern,
} from "../src/lib/stop-services.ts";
import { transitNetwork } from "../src/data/transit-network.ts";

function departure(
  overrides: Partial<Departure> & Pick<Departure, "id" | "destination">,
): Departure {
  return createDeparture({
    tripId: overrides.id,
    minutesUntilDeparture: 4,
    boardingLocalStopId: "europaplatz",
    scheduledDepartureTime: "2026-08-24T12:04:00+02:00",
    ...overrides,
  });
}

const calls = (...stopNames: string[]): TripCall[] =>
  stopNames.map((stopName, index) => ({
    stopName,
    localStopId: stopName.toLowerCase(),
    isCurrentStop: index === 0,
  }));

test("does not read two lines of one family as the same service", () => {
  const s1 = departure({ id: "s1", lineId: "S1", destination: "Hochstetten" });
  const s11 = departure({ id: "s11", lineId: "S11", destination: "Hochstetten" });

  assert.equal(hasCompatibleStopPattern(s1, s11), false);
});

test("keeps two detailed patterns apart even when their destination is the same", () => {
  const direct = departure({
    id: "direct",
    destination: "Durlach",
    tripCalls: calls("Europaplatz", "Marktplatz", "Durlach"),
  });
  const branch = departure({
    id: "branch",
    destination: "Durlach",
    tripCalls: calls("Europaplatz", "Hauptbahnhof", "Durlach"),
  });

  assert.equal(hasCompatibleStopPattern(direct, branch), false);
});

test("finds the following non-cancelled departure over the same observed route", () => {
  const cancelled = departure({ id: "cancelled", destination: "Durlach", status: "cancelled" });
  const otherDirection = departure({ id: "other", destination: "Knielingen Nord" });
  const cancelledAgain = departure({
    id: "cancelled-again",
    destination: "Durlach",
    status: "cancelled",
  });
  const replacement = departure({
    id: "replacement",
    destination: "Durlach",
    minutesUntilDeparture: 14,
  });

  assert.equal(
    findNextCompatibleDeparture([cancelled, otherDirection, cancelledAgain, replacement], cancelled)
      ?.id,
    "replacement",
  );
});

test("names a whole line by the farthest observed run instead of the drawn short working", () => {
  const short = departure({
    id: "short",
    destination: "D",
    tripCalls: calls("B", "C", "D"),
  });
  const full = departure({
    id: "full",
    destination: "A",
    tripCalls: calls("D", "C", "B", "A"),
  });
  const line = createLine({
    id: "2",
    destinations: ["D", "C"],
  });

  // Displayed destination-first (D, C, B), though the full run was observed the other way.
  assert.deepEqual(getFarthestLineRun(line, [short, full], [...short.tripCalls!].reverse()), {
    firstTerminus: "D",
    lastTerminus: "A",
    calls: full.tripCalls,
  });
});

test("a run observed heading the diagram's own way comes back in the diagram's order", () => {
  const towardDiagram = departure({
    id: "toward",
    destination: "D",
    tripCalls: calls("A", "B", "C", "D"),
  });
  const line = createLine({
    id: "2",
    destinations: ["D", "A"],
  });
  const drawn = calls("D", "C", "B");

  // The farthest run ends at the diagram's top row, so its calls come back reversed.
  assert.deepEqual(getFarthestLineRun(line, [towardDiagram], drawn), {
    firstTerminus: "D",
    lastTerminus: "A",
    calls: [...towardDiagram.tripCalls!].reverse(),
  });
});

test("qualifies a bare terminus name with the district it belongs to", () => {
  const lineTwo = departure({
    id: "line-two",
    destination: "Knielingen Nord",
    tripCalls: [
      { stopName: "Rheinhafen", localStopId: "rheinhafen", placeName: "Karlsruhe" },
      { stopName: "Feierabendweg", localStopId: "feierabendweg", placeName: "Karlsruhe" },
      { stopName: "Nord", localStopId: "knielingen-nord", placeName: "Knielingen" },
    ],
  });
  const line = createLine({
    id: "2",
    destinations: ["Rheinhafen", "Knielingen Nord"],
  });

  assert.deepEqual(getFarthestLineRun(line, [lineTwo], [...lineTwo.tripCalls!].reverse()), {
    firstTerminus: "Knielingen Nord",
    lastTerminus: "Rheinhafen",
    calls: [...lineTwo.tripCalls!].reverse(),
  });
});

test("falls back to the line's observed destinations until a complete run is in hand", () => {
  const line = createLine({
    id: "2",
    destinations: ["Durlach", "Knielingen Nord", "Rheinstetten"],
  });

  assert.deepEqual(getFarthestLineRun(line, [], []), {
    firstTerminus: "Durlach",
    lastTerminus: "Knielingen Nord",
    calls: undefined,
  });
});

test("reads a line's extent off the farthest run observed for it", () => {
  // Destinations follow the signs' short workings, naming less than the one whole run seen.
  const short = departure({
    id: "short",
    destination: "Rheinhafen über Kühler Krug",
    tripCalls: calls("Kühler Krug", "Rheinhafen"),
  });
  const full = departure({
    id: "full",
    destination: "Rheinhafen",
    tripCalls: [
      { stopName: "Nord", localStopId: "knielingen-nord", placeName: "Knielingen" },
      { stopName: "Feierabendweg", localStopId: "feierabendweg", placeName: "Karlsruhe" },
      { stopName: "Rheinhafen", localStopId: "rheinhafen", placeName: "Karlsruhe" },
    ],
  });

  assert.deepEqual(getFarthestLineRunTermini("2", [short, full]), [
    "Knielingen Nord",
    "Rheinhafen",
  ]);
  // The observed ends stand in wherever the line's ends are asked for.
  const observedLine = createLine({
    id: "2",
    destinations: ["Knielingen Nord", "Rheinhafen über Kühler Krug"],
    farthestRunTermini: getFarthestLineRunTermini("2", [short, full]),
  });
  assert.deepEqual(getLineTermini(observedLine), ["Knielingen Nord", "Rheinhafen"]);
});

test("a run that turns on itself names one place and no extent", () => {
  const loop = departure({
    id: "loop",
    destination: "Stupferich",
    tripCalls: calls("Turmberg", "Dürrbachstraße", "Rathaus", "Turmberg"),
  });

  assert.equal(getFarthestLineRunTermini("23", [loop]), undefined);
  // The destinations still say which place the loop serves.
  assert.deepEqual(
    getLineTermini(
      createLine({
        id: "23",
        destinations: ["Stupferich"],
      }),
    ),
    ["Stupferich"],
  );
});

test("no run observed far enough leaves the extent to the destinations", () => {
  assert.equal(getFarthestLineRunTermini("2", []), undefined);
});

/**
 * Fallback when a call's provider id resolves to nothing: the name minus the platform qualifier.
 */
test("a call named for one platform of a place resolves to that place", () => {
  const marktplatz = findStopByName(transitNetwork, "Marktplatz (Kaiserstraße U)");
  assert.equal(marktplatz?.id, "marktplatz");
  assert.equal(findStopByName(transitNetwork, "Marktplatz")?.id, "marktplatz");
  // An authored second name resolves; an unmapped stop does not.
  assert.equal(findStopByName(transitNetwork, "Mendelssohnplatz")?.id, "rueppurrer-tor");
  assert.equal(findStopByName(transitNetwork, "Lameyplatz"), undefined);
});
