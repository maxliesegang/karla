import assert from "node:assert/strict";
import test from "node:test";
import { createLineSign } from "../src/data/line-signs.ts";

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

test("keeps KVV's published white text by deepening a mid-tone fill a little", () => {
  for (const [lineId, signColor] of [
    ["S1", "#008851"],
    ["S11", "#008851"],
    ["S31", "#00857f"],
    ["S42", "#0080a9"],
  ]) {
    const sign = createLineSign(lineId, "lightRail");
    assert.equal(sign.signColor, signColor, lineId);
    assert.equal(sign.signInk, "#ffffff", lineId);
  }
  assert.equal(createLineSign("S1", "lightRail").color, "#00975f");
});

test("flips to dark ink where keeping white would change the colour", () => {
  for (const lineId of ["5", "6", "9", "S41"]) {
    const sign = createLineSign(lineId, "lightRail");
    assert.equal(sign.signColor, sign.color, lineId);
    assert.equal(sign.signInk, "#102c2c", lineId);
  }
});

test("keeps the official pair where it already reads", () => {
  for (const [lineId, signInk] of [
    ["2", "#ffffff"],
    ["17", "#ffffff"],
    ["4", "#102c2c"],
    ["S7", "#102c2c"],
  ]) {
    const sign = createLineSign(lineId, "tram");
    assert.equal(sign.signColor, sign.color, lineId);
    assert.equal(sign.signInk, signInk, lineId);
  }
});
