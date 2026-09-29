import assert from "node:assert/strict";
import test from "node:test";

// `station-board.ts` reads the address at import time, so it is loaded after a window exists.
Object.defineProperty(globalThis, "window", { value: { location: { search: "" } } });
const { isPlatformMatch, isStationBoardMode, parseStationBoardConfig } = await import(
  "../src/station-board.ts"
);

test("a page without a display parameter is no station board", () => {
  assert.equal(parseStationBoardConfig(""), null);
  assert.equal(parseStationBoardConfig("?rows=5"), null);
  assert.equal(isStationBoardMode, false);
});

test("a whole-stop board takes its defaults, and the former display=1 still opens one", () => {
  const expected = {
    mode: "stop",
    platformCodes: [],
    rowCount: 8,
    grouping: "none",
    detail: "note",
    minimumMinutes: 0,
    reloadMinutes: 1440,
  };
  assert.deepEqual(parseStationBoardConfig("?display=stop"), expected);
  assert.deepEqual(parseStationBoardConfig("?display=1"), expected);
});

test("numbers are held to their range rather than breaking the screen", () => {
  const config = parseStationBoardConfig("?display=stop&rows=50&minMinutes=-3&reloadMinutes=x");
  assert.equal(config?.rowCount, 20);
  assert.equal(config?.minimumMinutes, 0);
  assert.equal(config?.reloadMinutes, 1440);
});

test("platforms are matched however the feed spells them", () => {
  const config = parseStationBoardConfig("?display=platform&platform=Gleis%202,3&group=platform");
  assert.equal(config?.mode, "platform");
  assert.equal(config?.grouping, "platform");
  assert.deepEqual(config?.platformCodes, ["2", "3"]);
  assert.ok(isPlatformMatch("Bstg. 2", config?.platformCodes ?? []));
  assert.ok(!isPlatformMatch("4", config?.platformCodes ?? []));
});
