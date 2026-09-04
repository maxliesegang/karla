import assert from "node:assert/strict";
import test from "node:test";
import { parseDepartureBoardResponse } from "../src/data/kvv-efa-parsers.ts";
import type { Departure } from "../src/data/transit-types.ts";
import { groupDeparturesByPlatform } from "../src/lib/departure-order.ts";
import {
  findSharedPlatformKind,
  formatPlatformLabel,
  formatSpokenPlatformHeading,
  formatSpokenPlatformLabel,
  getPlatformHeadingParts,
  getPlatformWord,
} from "../src/lib/platform-naming.ts";

// `routing.ts` reads the address at import time, so it is loaded after a window exists.
Object.defineProperty(globalThis, "window", { value: { location: { search: "" } } });
const { normalizePlatformCode } = await import("../src/routing.ts");

/**
 * The words here are the operator's. `XSLT_DM_REQUEST` states a `pointType` beside every platform
 * code — `Gleis 1(U)` and `Bstg. A` are both reported at Europaplatz, and the buses 50 and 62 are
 * reported at `Gleis 24` at the Hauptbahnhof, which is why the word cannot be read off the mode.
 */

const createDeparture = (overrides: Partial<Departure> = {}): Departure => ({
  id: "trip",
  lineId: "S1",
  transportMode: "lightRail",
  destination: "Bad Herrenalb",
  minutesUntilDeparture: 4,
  platformCode: "1",
  boardingLocalStopId: "europaplatz",
  status: "realtime",
  scheduledDepartureTime: "2026-08-24T14:34:00+02:00",
  ...overrides,
});

const createFeedDeparture = (platform: string, pointType?: string) => ({
  stopID: "7000037",
  nameWO: "Europaplatz",
  countdown: "4",
  dateTime: { year: "2026", month: "8", day: "24", hour: "14", minute: "34" },
  platform,
  ...(pointType ? { pointType } : {}),
  servingLine: { symbol: "S1", number: "S1", direction: "Bad Herrenalb", motType: "1" },
});

test("names a platform with the feed's own word", () => {
  assert.equal(formatPlatformLabel("24", "track"), "Gleis 24");
  assert.equal(formatPlatformLabel("A", "stand"), "Bstg. A");
});

test("falls back to the generic word only where the feed states no kind", () => {
  assert.equal(formatPlatformLabel("7", undefined), "Steig 7");
  assert.equal(formatPlatformLabel("", undefined), "Steig ?");
  // A column that prints the code as its glyph captions it only when there is a word to caption it.
  assert.equal(getPlatformWord("stand"), "Bstg.");
  assert.equal(getPlatformWord(undefined), undefined);
});

test("speaks the abbreviation as a word, and an unnamed platform as unknown", () => {
  assert.equal(formatSpokenPlatformLabel("A", "stand"), "Bussteig A");
  assert.equal(formatSpokenPlatformLabel("1(U)", "track"), "Gleis 1(U)");
  assert.equal(formatSpokenPlatformLabel("", undefined), "Steig unbekannt");
});

test("a heading uses a word only where every departure under it supports one", () => {
  const track = createDeparture({ platformKind: "track" });
  const stand = createDeparture({ id: "bus", platformCode: "A", platformKind: "stand" });

  assert.equal(
    findSharedPlatformKind([track, createDeparture({ id: "second", platformKind: "track" })]),
    "track",
  );
  assert.equal(findSharedPlatformKind([track, stand]), undefined);
  assert.equal(findSharedPlatformKind([track, createDeparture({ id: "unstated" })]), undefined);
  assert.equal(findSharedPlatformKind([]), undefined);
});

test("gives each platform group the word its own departures agree on", () => {
  const groups = groupDeparturesByPlatform([
    createDeparture({ id: "tram", platformCode: "1", platformKind: "track" }),
    createDeparture({ id: "bus", platformCode: "A", platformKind: "stand" }),
  ]);

  assert.deepEqual(
    groups.map((group) => formatPlatformLabel(group.platformCode, group.platformKind)),
    ["Gleis 1", "Bstg. A"],
  );
});

test("uses the generic word when reports disagree about one platform", () => {
  const [group] = groupDeparturesByPlatform([
    createDeparture({ id: "tram", platformCode: "1", platformKind: "track" }),
    createDeparture({ id: "unstated", platformCode: "1" }),
  ]);

  assert.equal(formatPlatformLabel(group.platformCode, group.platformKind), "Steig 1");
});

test("reads the word from the feed and keeps the bare code as the platform's identity", () => {
  const board = parseDepartureBoardResponse(
    {
      departureList: [
        createFeedDeparture("1(U)", "Gleis"),
        createFeedDeparture("A", "Bstg"),
        // The Hauptbahnhof reports entries with a platform and no kind at all; guessing one from the
        // mode would put "Gleis" in front of a bus stand.
        createFeedDeparture("7"),
      ],
    },
    "7000037",
  );

  assert.deepEqual(
    board.departures.map((departure) => [departure.platformCode, departure.platformKind]),
    [
      ["1(U)", "track"],
      ["A", "stand"],
      ["7", undefined],
    ],
  );
  // The word is never folded into the code: `?platform=1u` still matches the underground platform.
  assert.equal(normalizePlatformCode(board.departures[0].platformCode), "1u");
});

test("sets a group heading as a captioned code, and says so where the feed named no platform", () => {
  assert.deepEqual(getPlatformHeadingParts("1(U)", "track"), { word: "Gleis", code: "1(U)" });
  assert.deepEqual(getPlatformHeadingParts("A", "stand"), { word: "Bstg.", code: "A" });
  assert.deepEqual(getPlatformHeadingParts("7", undefined), { word: "Steig", code: "7" });
  // Nothing to caption and nowhere to walk to: the group states its own absence instead.
  assert.deepEqual(getPlatformHeadingParts("", undefined), { code: "Ohne Steigangabe" });
  assert.equal(formatSpokenPlatformHeading("A", "stand"), "Bussteig A");
  assert.equal(formatSpokenPlatformHeading("", undefined), "Ohne Steigangabe");
});
