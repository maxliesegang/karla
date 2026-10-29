import assert from "node:assert/strict";
import test from "node:test";

import {
  createStopMatcher,
  foldSearchText,
  mergeStopMatches,
  STOP_MATCH_RANKS,
  type StopMatchRank,
} from "../src/lib/stop-search.ts";

test("a rider's spelling meets the operator's", () => {
  for (const spelling of ["Mühlburg", "muehlburg", "muhlburg", "MÜHLBURG"]) {
    assert.equal(foldSearchText(spelling), "muhlburg", spelling);
  }
  assert.equal(foldSearchText("Augartenstraße"), foldSearchText("augartenstrasse"));
  assert.equal(foldSearchText("Karlsruhe Hbf"), "karlsruhe hauptbahnhof");
  assert.equal(foldSearchText("Bf Durlach"), "bahnhof durlach");
  assert.equal(foldSearchText("Berliner Str."), "berliner strasse");
  // `str` alone may be a name half typed.
  assert.equal(foldSearchText("str"), "str");
  assert.equal(foldSearchText("Andreas-Hofer-Straße"), "andreas hofer strasse");
});

test("a stop matches by its whole name, its start, its words' starts, or its words", () => {
  const rank = (query: string, stop: Parameters<ReturnType<typeof createStopMatcher>>[0]) =>
    createStopMatcher(query)(stop);
  const durlachBahnhof = { name: "Bahnhof", placeName: "Durlach" };

  assert.equal(rank("hbf", { name: "Hauptbahnhof" }), STOP_MATCH_RANKS.exact);
  assert.equal(
    rank("stuttgart hbf", { name: "Hauptbahnhof", placeName: "Stuttgart" }),
    STOP_MATCH_RANKS.exact,
  );
  assert.equal(rank("durlach bahnhof", durlachBahnhof), STOP_MATCH_RANKS.exact);
  assert.equal(rank("bahnhof durlach", durlachBahnhof), STOP_MATCH_RANKS.wordStarts);
  assert.equal(rank("markt", { name: "Marktplatz" }), STOP_MATCH_RANKS.nameStart);
  assert.equal(rank("hofer", { name: "Andreas-Hofer-Straße" }), STOP_MATCH_RANKS.wordStarts);
  assert.equal(rank("strasse", { name: "Augartenstraße" }), STOP_MATCH_RANKS.contained);
  assert.equal(
    rank("mendelssohn", { name: "Ettlinger Tor", formerName: "Mendelssohnplatz" }),
    STOP_MATCH_RANKS.nameStart,
  );
  assert.equal(rank("europaplatz stuttgart", { name: "Europaplatz" }), undefined);
});

const local = (id: string, rank: StopMatchRank, callCount = 0) => ({
  stop: { id, name: id },
  rank,
  callCount,
});
const provider = (id: string, rank: StopMatchRank | undefined, isNear = false) => ({
  stop: { id, name: id },
  rank,
  isNear,
});
const ids = (stops: readonly { id: string }[]) => stops.map(({ id }) => id);

test("local and provider matches merge best first, local leading on a tie", () => {
  const merged = mergeStopMatches(
    [local("busy", STOP_MATCH_RANKS.nameStart, 9), local("quiet", STOP_MATCH_RANKS.nameStart, 1)],
    [
      provider("fuzzy", undefined),
      provider("far", STOP_MATCH_RANKS.exact),
      provider("near", STOP_MATCH_RANKS.exact, true),
      provider("tied", STOP_MATCH_RANKS.nameStart),
      // An authored stop the provider also found is listed once.
      provider("busy", STOP_MATCH_RANKS.nameStart),
    ],
    8,
  );
  assert.deepEqual(ids(merged), ["near", "far", "busy", "quiet", "tied", "fuzzy"]);
});

test("provider matches keep a few rows however many local ones there are", () => {
  const many = Array.from({ length: 10 }, (_, index) =>
    local(`local-${index}`, STOP_MATCH_RANKS.exact),
  );
  const merged = mergeStopMatches(
    many,
    [provider("a", STOP_MATCH_RANKS.contained), provider("b", undefined), provider("c", undefined)],
    8,
  );
  assert.equal(merged.length, 8);
  assert.deepEqual(ids(merged).slice(5), ["a", "b", "c"]);
  // Without provider matches, local ones fill the list.
  assert.equal(mergeStopMatches(many, [], 8).length, 8);
});
