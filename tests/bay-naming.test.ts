import assert from "node:assert/strict";
import test from "node:test";
import { parseTriasStopEvents } from "../src/data/trias-parsers.ts";
import type { StopEvent } from "../src/data/transit-types.ts";
import { groupStopEventsByBay } from "../src/lib/stop-event-order.ts";
import {
  findSharedBayKind,
  formatBayText,
  formatSpokenBayHeading,
  formatSpokenBayText,
  getBayHeadingParts,
  getBayWord,
} from "../src/lib/bay-naming.ts";
import { createStopEvent as createFixture } from "./support/fixtures.ts";
import { triasStopEvent, triasStopEvents } from "./support/trias.ts";

// `station-board.ts` reads the address at import time, so it is loaded after a window exists.
Object.defineProperty(globalThis, "window", { value: { location: { search: "" } } });
const { normalizeBay } = await import("../src/station-board.ts");

/**
 * The words here are the operator's: `Gleis 1(U)` and `Bstg. A` are both stated at Europaplatz, and
 * buses at `Gleis 24` at the Hauptbahnhof, so the word cannot be read off the mode.
 */

const createStopEvent = (overrides: Partial<StopEvent> = {}): StopEvent =>
  createFixture({
    id: "trip",
    lineId: "S1",
    ptMode: "lightRail",
    destinationText: "Bad Herrenalb",
    minutesUntilDeparture: 4,
    bay: "1",
    boardingLocalStopId: "europaplatz",
    status: "realtime",
    timetabledDepartureTime: "2026-08-24T14:34:00+02:00",
    ...overrides,
  });

const createFeedStopEvent = (bay: string) =>
  triasStopEvent({
    current: {
      ref: "de:08212:37:1:1",
      name: "KA Europaplatz",
      bay,
      departure: { timetabled: "2026-08-24T12:34:00Z" },
    },
  });

test("names a platform with the feed's own word", () => {
  assert.equal(formatBayText("24", "track"), "Gleis 24");
  assert.equal(formatBayText("A", "stand"), "Bstg. A");
});

test("falls back to the generic word only where the feed states no kind", () => {
  assert.equal(formatBayText("7", undefined), "Steig 7");
  assert.equal(formatBayText("", undefined), "Steig ?");
  // A column that prints the code as its glyph captions it only when there is a word to caption it.
  assert.equal(getBayWord("stand"), "Bstg.");
  assert.equal(getBayWord(undefined), undefined);
});

test("speaks the abbreviation as a word, and an unnamed platform as unknown", () => {
  assert.equal(formatSpokenBayText("A", "stand"), "Bussteig A");
  assert.equal(formatSpokenBayText("1(U)", "track"), "Gleis 1(U)");
  assert.equal(formatSpokenBayText("", undefined), "Steig unbekannt");
});

test("a heading uses a word only where every departure under it supports one", () => {
  const track = createStopEvent({ bayKind: "track" });
  const stand = createStopEvent({ id: "bus", bay: "A", bayKind: "stand" });

  assert.equal(
    findSharedBayKind([track, createStopEvent({ id: "second", bayKind: "track" })]),
    "track",
  );
  assert.equal(findSharedBayKind([track, stand]), undefined);
  assert.equal(findSharedBayKind([track, createStopEvent({ id: "unstated" })]), undefined);
  assert.equal(findSharedBayKind([]), undefined);
});

test("gives each platform group the word its own departures agree on", () => {
  const groups = groupStopEventsByBay([
    createStopEvent({ id: "tram", bay: "1", bayKind: "track" }),
    createStopEvent({ id: "bus", bay: "A", bayKind: "stand" }),
  ]);

  assert.deepEqual(
    groups.map((group) => formatBayText(group.bay, group.bayKind)),
    ["Gleis 1", "Bstg. A"],
  );
});

test("uses the generic word when reports disagree about one platform", () => {
  const [group] = groupStopEventsByBay([
    createStopEvent({ id: "tram", bay: "1", bayKind: "track" }),
    createStopEvent({ id: "unstated", bay: "1" }),
  ]);

  assert.equal(formatBayText(group.bay, group.bayKind), "Steig 1");
});

test("reads the word from the feed and keeps the bare code as the platform's identity", () => {
  const board = parseTriasStopEvents(
    triasStopEvents("2026-08-24T12:30:00Z", [
      createFeedStopEvent("Gleis 1(U)"),
      createFeedStopEvent("Bstg. A"),
      // A bay without a kind stays without one; guessing from the mode would put "Gleis" in front
      // of a bus stand.
      createFeedStopEvent("7"),
    ]),
    "de:08212:37",
  );

  assert.deepEqual(
    board.stopEvents.map((stopEvent) => [stopEvent.bay, stopEvent.bayKind]),
    [
      ["1(U)", "track"],
      ["A", "stand"],
      ["7", undefined],
    ],
  );
  // The word is never folded into the code: `?platform=1u` still matches the underground platform.
  assert.equal(normalizeBay(board.stopEvents[0].bay), "1u");
});

test("sets a group heading as a captioned code, and says so where the feed named no platform", () => {
  assert.deepEqual(getBayHeadingParts("1(U)", "track"), { word: "Gleis", code: "1(U)" });
  assert.deepEqual(getBayHeadingParts("A", "stand"), { word: "Bstg.", code: "A" });
  assert.deepEqual(getBayHeadingParts("7", undefined), { word: "Steig", code: "7" });
  // Nothing to caption and nowhere to walk to: the group states its own absence instead.
  assert.deepEqual(getBayHeadingParts("", undefined), { code: "Ohne Steigangabe" });
  assert.equal(formatSpokenBayHeading("A", "stand"), "Bussteig A");
  assert.equal(formatSpokenBayHeading("", undefined), "Ohne Steigangabe");
});
