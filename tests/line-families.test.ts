import assert from "node:assert/strict";
import test from "node:test";
import type { TransitLine } from "../src/data/transit-types.ts";
import {
  compareLineIds,
  findLineForRoute,
  getGroupedLines,
  getLineFamilyId,
  isSameLineFamily,
} from "../src/lib/line-families.ts";

const line = (id: string): TransitLine => ({
  id,
  name: id,
  color: "#000",
  textColor: "#fff",
  destinations: [],
  zentrumStopIds: [],
});

test("keeps S1 and S11 as distinct passenger-facing lines", () => {
  assert.equal(getLineFamilyId("S1"), "S1");
  assert.equal(getLineFamilyId("S11"), "S11");
  assert.equal(isSameLineFamily("S1", "S11"), false);

  const lines = [line("S1"), line("S11")];
  assert.deepEqual(
    getGroupedLines(lines).map(({ id }) => id),
    ["S1", "S11"],
  );
  assert.equal(findLineForRoute(lines, "S1")?.id, "S1");
  assert.equal(findLineForRoute(lines, "S11")?.id, "S11");
});

test("sorts S-Bahn branches directly after their trunk line", () => {
  assert.deepEqual(
    ["S52", "S2", "S12", "S31", "S11", "S1", "S51", "S5", "S32"].sort(compareLineIds),
    ["S1", "S11", "S12", "S2", "S31", "S32", "S5", "S51", "S52"],
  );
});

test("continues to sort tram lines numerically before S-Bahn lines", () => {
  assert.deepEqual(["S1", "10", "2", "1"].sort(compareLineIds), ["1", "2", "10", "S1"]);
});
