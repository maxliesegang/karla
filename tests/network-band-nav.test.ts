import assert from "node:assert/strict";
import test from "node:test";
import { findNetworkBandIdInView } from "../src/lib/network-band-nav.ts";

/**
 * The reading line is where a band's top edge counts as having arrived — the same height the sticky
 * heading takes over at and a walked-to band lands at. These cases read against a line of 0, which
 * is the page's scrollport at rest.
 */

test("the band in view is the one whose section has arrived last", () => {
  const readings = [
    { id: "tram", top: -640 },
    { id: "lightRail", top: -80 },
    { id: "bus", top: 300 },
  ];
  assert.equal(findNetworkBandIdInView(readings, 0), "lightRail");
});

test("a band that has reached the line exactly is being read in", () => {
  const readings = [
    { id: "tram", top: 0 },
    { id: "bus", top: 500 },
  ];
  assert.equal(findNetworkBandIdInView(readings, 0), "tram");
});

test("the scroll standing above the first band is still reading in it", () => {
  const readings = [
    { id: "tram", top: 40 },
    { id: "lightRail", top: 900 },
  ];
  assert.equal(findNetworkBandIdInView(readings, 0), "tram");
});

test("the topmost band is read by where it stands, not by the order it is handed over in", () => {
  const readings = [
    { id: "bus", top: 900 },
    { id: "tram", top: 40 },
  ];
  assert.equal(findNetworkBandIdInView(readings, 0), "tram");
});

test("a page with no bands at all is being read in no band", () => {
  assert.equal(findNetworkBandIdInView([], 0), undefined);
});

test("sub-pixel rounding of a band one hair below the line still counts as arrived", () => {
  const readings = [
    { id: "tram", top: -0.5 },
    { id: "bus", top: 500 },
  ];
  assert.equal(findNetworkBandIdInView(readings, 0), "tram");
});
