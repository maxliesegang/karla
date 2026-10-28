import assert from "node:assert/strict";
import test from "node:test";
import { createLineSign, getPlanLineTone, needsLineOutline } from "../src/data/line-signs.ts";

test("uses colors from the KVV GTFS route catalog", () => {
  assert.equal(createLineSign("2", "tram").color, "#0069b9");
  assert.equal(createLineSign("S42", "lightRail").color, "#008cb5");
  assert.equal(createLineSign("244", "bus").color, "#91268f");
  assert.equal(createLineSign("SEV 10", "bus").color, "#91268f");
});

test("disambiguates the two GTFS colors published for line E by mode", () => {
  assert.equal(createLineSign("E", "tram").color, "#e30613");
  assert.equal(createLineSign("E", "lightRail").color, "#00975f");
});

test("keeps an unseen live line neutral", () => {
  assert.equal(createLineSign("NEW", "bus").color, "#6b6257");
});

test("uses readable text on GTFS colors whose published white text has low contrast", () => {
  assert.equal(createLineSign("4", "tram").textColor, "#102c2c");
  assert.equal(createLineSign("S42", "lightRail").textColor, "#000");
  assert.equal(createLineSign("17", "bus").textColor, "#fff");
});

test("outlines only pale line graphics while preserving their official colors", () => {
  for (const lineId of ["S7", "S71", "S41", "4"]) {
    assert.equal(needsLineOutline(createLineSign(lineId, "lightRail").color), true, lineId);
  }
  for (const lineId of ["1", "2", "3", "5", "6", "8", "S1", "S2", "S4", "S5", "S8", "S42"]) {
    assert.equal(needsLineOutline(createLineSign(lineId, "lightRail").color), false, lineId);
  }
  assert.equal(createLineSign("S7", "lightRail").color, "#ffed00");
  assert.equal(createLineSign("S8", "lightRail").color, "#6e682c");
});

test("the plan darkens only pale colours, to about 2:1 on white", () => {
  assert.equal(getPlanLineTone("#0069b9"), undefined);
  for (const color of ["#ffed00", "#ffcc00", "#c7d300"]) {
    const tone = getPlanLineTone(color);
    assert.ok(tone && !needsLineOutline(tone), color);
    assert.notEqual(tone, color);
  }
});
