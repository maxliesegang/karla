import assert from "node:assert/strict";
import test from "node:test";
import { createZentrumLineSignReader } from "../src/components/zentrum/line-sign.ts";
import type { PtMode } from "../src/data/transit-types.ts";

test("the center map signs E in dark gray regardless of its observed mode", () => {
  for (const ptMode of ["tram", "lightRail", "bus", "other"] as const) {
    const getSign = createZentrumLineSignReader([{ id: "E", ptMode }]);
    const sign = getSign("E");
    assert.equal(sign.color, "#59635f");
    assert.equal(sign.textColor, "#fff");
    assert.equal(sign.ptMode, ptMode);
  }
  assert.equal(createZentrumLineSignReader([])("E").color, "#59635f");
});

test("the center map keeps the usual signs for other lines", () => {
  const lines: { id: string; ptMode: PtMode }[] = [
    { id: "1", ptMode: "tram" },
    { id: "S1", ptMode: "lightRail" },
    { id: "NEW", ptMode: "bus" },
  ];
  const getSign = createZentrumLineSignReader(lines);
  assert.equal(getSign("1").color, "#ff0000");
  assert.equal(getSign("S1").color, "#00b875");
  assert.equal(getSign("NEW").color, "#6b6257");
  assert.equal(getSign("UNKNOWN").color, "#59635f");
});
