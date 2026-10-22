import assert from "node:assert/strict";
import test from "node:test";
import { createStopEvent, createLine } from "./support/fixtures.ts";
import type { StopEvent, Call } from "../src/data/transit-types.ts";
import {
  getFarthestLineDatedJourney,
  getFarthestLineDatedJourneyTermini,
  getLineTermini,
  findNextCompatibleStopEvent,
  findStopByName,
  hasCompatibleStopPattern,
} from "../src/lib/stop-services.ts";
import { transitNetwork } from "../src/data/transit-network.ts";

function stopEvent(
  overrides: Partial<StopEvent> & Pick<StopEvent, "id" | "destinationText">,
): StopEvent {
  return createStopEvent({
    journeyRef: overrides.id,
    minutesUntilDeparture: 4,
    boardingLocalStopId: "europaplatz",
    timetabledDepartureTime: "2026-08-24T12:04:00+02:00",
    ...overrides,
  });
}

const calls = (...stopNames: string[]): Call[] =>
  stopNames.map((stopName, index) => ({
    stopName,
    localStopId: stopName.toLowerCase(),
    isThisCall: index === 0,
  }));

test("does not read two lines of one family as the same service", () => {
  const s1 = stopEvent({ id: "s1", lineId: "S1", destinationText: "Hochstetten" });
  const s11 = stopEvent({ id: "s11", lineId: "S11", destinationText: "Hochstetten" });

  assert.equal(hasCompatibleStopPattern(s1, s11), false);
});

test("keeps two detailed patterns apart even when their destination is the same", () => {
  const direct = stopEvent({
    id: "direct",
    destinationText: "Durlach",
    calls: calls("Europaplatz", "Marktplatz", "Durlach"),
  });
  const branch = stopEvent({
    id: "branch",
    destinationText: "Durlach",
    calls: calls("Europaplatz", "Hauptbahnhof", "Durlach"),
  });

  assert.equal(hasCompatibleStopPattern(direct, branch), false);
});

test("finds the following non-cancelled departure over the same observed route", () => {
  const cancelled = stopEvent({ id: "cancelled", destinationText: "Durlach", status: "cancelled" });
  const otherDirection = stopEvent({ id: "other", destinationText: "Knielingen Nord" });
  const cancelledAgain = stopEvent({
    id: "cancelled-again",
    destinationText: "Durlach",
    status: "cancelled",
  });
  const replacement = stopEvent({
    id: "replacement",
    destinationText: "Durlach",
    minutesUntilDeparture: 14,
  });

  assert.equal(
    findNextCompatibleStopEvent([cancelled, otherDirection, cancelledAgain, replacement], cancelled)
      ?.id,
    "replacement",
  );
});

test("names a whole line by the farthest observed run instead of the drawn short working", () => {
  const short = stopEvent({
    id: "short",
    destinationText: "D",
    calls: calls("B", "C", "D"),
  });
  const full = stopEvent({
    id: "full",
    destinationText: "A",
    calls: calls("D", "C", "B", "A"),
  });
  const line = createLine({
    id: "2",
    destinations: ["D", "C"],
  });

  // Displayed destination-first (D, C, B), though the full run was observed the other way.
  assert.deepEqual(getFarthestLineDatedJourney(line, [short, full], [...short.calls!].reverse()), {
    firstTerminus: "D",
    lastTerminus: "A",
    calls: full.calls,
  });
});

test("a run observed heading the diagram's own way comes back in the diagram's order", () => {
  const towardDiagram = stopEvent({
    id: "toward",
    destinationText: "D",
    calls: calls("A", "B", "C", "D"),
  });
  const line = createLine({
    id: "2",
    destinations: ["D", "A"],
  });
  const drawn = calls("D", "C", "B");

  // The farthest run ends at the diagram's top row, so its calls come back reversed.
  assert.deepEqual(getFarthestLineDatedJourney(line, [towardDiagram], drawn), {
    firstTerminus: "D",
    lastTerminus: "A",
    calls: [...towardDiagram.calls!].reverse(),
  });
});

test("qualifies a bare terminus name with the district it belongs to", () => {
  const lineTwo = stopEvent({
    id: "line-two",
    destinationText: "Knielingen Nord",
    calls: [
      { stopName: "Rheinhafen", localStopId: "rheinhafen", placeName: "Karlsruhe" },
      { stopName: "Feierabendweg", localStopId: "feierabendweg", placeName: "Karlsruhe" },
      { stopName: "Nord", localStopId: "knielingen-nord", placeName: "Knielingen" },
    ],
  });
  const line = createLine({
    id: "2",
    destinations: ["Rheinhafen", "Knielingen Nord"],
  });

  assert.deepEqual(getFarthestLineDatedJourney(line, [lineTwo], [...lineTwo.calls!].reverse()), {
    firstTerminus: "Knielingen Nord",
    lastTerminus: "Rheinhafen",
    calls: [...lineTwo.calls!].reverse(),
  });
});

test("falls back to the line's observed destinations until a complete run is in hand", () => {
  const line = createLine({
    id: "2",
    destinations: ["Durlach", "Knielingen Nord", "Rheinstetten"],
  });

  assert.deepEqual(getFarthestLineDatedJourney(line, [], []), {
    firstTerminus: "Durlach",
    lastTerminus: "Knielingen Nord",
    calls: undefined,
  });
});

test("reads a line's extent off the farthest run observed for it", () => {
  // Destinations follow the signs' short workings, naming less than the one whole run seen.
  const short = stopEvent({
    id: "short",
    destinationText: "Rheinhafen über Kühler Krug",
    calls: calls("Kühler Krug", "Rheinhafen"),
  });
  const full = stopEvent({
    id: "full",
    destinationText: "Rheinhafen",
    calls: [
      { stopName: "Nord", localStopId: "knielingen-nord", placeName: "Knielingen" },
      { stopName: "Feierabendweg", localStopId: "feierabendweg", placeName: "Karlsruhe" },
      { stopName: "Rheinhafen", localStopId: "rheinhafen", placeName: "Karlsruhe" },
    ],
  });

  assert.deepEqual(getFarthestLineDatedJourneyTermini("2", [short, full]), [
    "Knielingen Nord",
    "Rheinhafen",
  ]);
  // The observed ends stand in wherever the line's ends are asked for.
  const observedLine = createLine({
    id: "2",
    destinations: ["Knielingen Nord", "Rheinhafen über Kühler Krug"],
    farthestDatedJourneyTermini: getFarthestLineDatedJourneyTermini("2", [short, full]),
  });
  assert.deepEqual(getLineTermini(observedLine), ["Knielingen Nord", "Rheinhafen"]);
});

test("a run that turns on itself names one place and no extent", () => {
  const loop = stopEvent({
    id: "loop",
    destinationText: "Stupferich",
    calls: calls("Turmberg", "Dürrbachstraße", "Rathaus", "Turmberg"),
  });

  assert.equal(getFarthestLineDatedJourneyTermini("23", [loop]), undefined);
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
  assert.equal(getFarthestLineDatedJourneyTermini("2", []), undefined);
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
