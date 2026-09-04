import assert from "node:assert/strict";
import test from "node:test";
import { findBoardingPlaceIdInView } from "../src/lib/boarding-place-sections.ts";

/**
 * The reading line is where a section's top edge counts as having arrived — the same height the
 * sticky heading takes over at and a walked-to section lands at. These cases read against a line
 * of 0, which is the board's own scrollport at rest.
 */

test("the place in view is the one whose section has arrived last", () => {
  const readings = [
    { id: "pyramide", top: -410 },
    { id: "u", top: -32 },
    { id: "ost", top: 260 },
  ];
  assert.equal(findBoardingPlaceIdInView(readings, 0), "u");
});

test("a section that has reached the line exactly is being read at", () => {
  const readings = [
    { id: "pyramide", top: 0 },
    { id: "u", top: 300 },
  ];
  assert.equal(findBoardingPlaceIdInView(readings, 0), "pyramide");
});

test("a board read above its first place is being read at no place", () => {
  const readings = [
    { id: "pyramide", top: 40 },
    { id: "u", top: 300 },
  ];
  assert.equal(findBoardingPlaceIdInView(readings, 0), undefined);
});

test("a board with no sections at all is being read at no place", () => {
  assert.equal(findBoardingPlaceIdInView([], 0), undefined);
});

test("the reading does not depend on the order the sections are handed over in", () => {
  const readings = [
    { id: "u", top: -32 },
    { id: "ost", top: 260 },
    { id: "pyramide", top: -410 },
  ];
  assert.equal(findBoardingPlaceIdInView(readings, 0), "u");
});

test("sub-pixel rounding of a section one hair below the line still counts as arrived", () => {
  const readings = [
    { id: "pyramide", top: -0.5 },
    { id: "u", top: 300 },
  ];
  assert.equal(findBoardingPlaceIdInView(readings, 0), "pyramide");
});
