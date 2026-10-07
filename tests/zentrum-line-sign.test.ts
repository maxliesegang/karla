import assert from "node:assert/strict";
import test from "node:test";
import { createZentrumLineSignReader } from "../src/components/zentrum/line-sign.ts";
import type { TransportMode } from "../src/data/transit-types.ts";

test("the center map signs E in dark gray regardless of its observed mode", () => {
  for (const transportMode of ["tram", "lightRail", "bus", "other"] as const) {
    const getSign = createZentrumLineSignReader([{ id: "E", transportMode }]);
    const sign = getSign("E");
    assert.equal(sign.color, "#59635f");
    assert.equal(sign.textColor, "#fff");
    assert.equal(sign.transportMode, transportMode);
  }
  assert.equal(createZentrumLineSignReader([])("E").color, "#59635f");
});

test("the center map keeps the usual signs for other lines", () => {
  const lines: { id: string; transportMode: TransportMode }[] = [
    { id: "1", transportMode: "tram" },
    { id: "S1", transportMode: "lightRail" },
    { id: "NEW", transportMode: "bus" },
  ];
  const getSign = createZentrumLineSignReader(lines);
  assert.equal(getSign("1").color, "#ff0000");
  assert.equal(getSign("S1").color, "#00b875");
  assert.equal(getSign("NEW").color, "#6b6257");
  assert.equal(getSign("UNKNOWN").color, "#59635f");
});
