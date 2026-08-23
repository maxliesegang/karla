import assert from "node:assert/strict";
import test from "node:test";
import { createLineSign } from "../src/data/line-signs.ts";

test("uses colors from the KVV GTFS route catalog", () => {
  assert.equal(createLineSign("2", "tram").color, "#0073df");
  assert.equal(createLineSign("S42", "lightRail").color, "#00d9b8");
  assert.equal(createLineSign("244", "bus").color, "#8000ff");
  assert.equal(createLineSign("SEV S7/S8", "bus").color, "#8000ff");
});

test("disambiguates the two GTFS colors published for line E by mode", () => {
  assert.equal(createLineSign("E", "tram").color, "#ff0000");
  assert.equal(createLineSign("E", "lightRail").color, "#00b875");
});

test("keeps an unseen live line neutral", () => {
  assert.equal(createLineSign("NEW", "bus").color, "#6b6257");
});

test("uses readable text on GTFS colors whose published white text has low contrast", () => {
  assert.equal(createLineSign("4", "tram").textColor, "#102c2c");
  assert.equal(createLineSign("1", "tram").textColor, "#000");
  assert.equal(createLineSign("17", "bus").textColor, "#fff");
});
