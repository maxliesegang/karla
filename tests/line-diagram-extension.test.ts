import assert from "node:assert/strict";
import test from "node:test";
import type { TripCall } from "../src/data/transit-types.ts";
import { extendLineDiagramCalls } from "../src/lib/line-diagram.ts";

/** Chains in the diagram's order, destination first. */
const calls = (...stopIds: string[]): TripCall[] =>
  stopIds.map((localStopId) => ({ stopName: localStopId.toUpperCase(), localStopId }));

test("a short working is drawn out to the run observed farthest, past both of its ends", () => {
  // The drawn trip keeps its rows; the farther run adds what lies beyond.
  assert.deepEqual(extendLineDiagramCalls(calls("c", "b"), calls("d", "c", "b", "a")), [
    ...calls("d", "c", "b", "a"),
  ]);
});

test("stops the drawn trip skipped but the run calls at are read in between", () => {
  // A stop only the farthest run serves belongs on the whole-line view.
  assert.deepEqual(extendLineDiagramCalls(calls("d", "x", "b"), calls("d", "c", "b", "a")), [
    ...calls("d", "c", "x", "b", "a"),
  ]);
});

test("a drawn-only stop keeps its place beside the drawn calls around it", () => {
  // A variant's own stop stays between the calls it was read between.
  assert.deepEqual(extendLineDiagramCalls(calls("d", "c", "x", "b"), calls("d", "c", "b", "a")), [
    ...calls("d", "c", "x", "b", "a"),
  ]);
});

test("a drawn chain the run never reaches is left exactly as it was", () => {
  // Chains sharing nothing are not joined.
  assert.deepEqual(extendLineDiagramCalls(calls("x", "y"), calls("d", "c", "b", "a")), [
    ...calls("x", "y"),
  ]);
});

test("a drawn chain is never narrowed by the run it is extended with", () => {
  // A working passing its own stop twice keeps both passes.
  assert.deepEqual(extendLineDiagramCalls(calls("a", "b", "c", "b", "a"), calls("a", "b", "c")), [
    ...calls("a", "b", "c", "b", "a"),
  ]);
});

test("separate published calls at one stop are merged by occurrence", () => {
  const marktplatz = (stopName: string): TripCall => ({ stopName, localStopId: "marktplatz" });
  const route = [
    ...calls("d"),
    marktplatz("Marktplatz (Kaiserstraße U)"),
    marktplatz("Marktplatz (Pyramide U)"),
    ...calls("b", "a"),
  ];

  assert.deepEqual(extendLineDiagramCalls(route, route), route);
});

test("a repeated call the two chains name identically still lines up with its own occurrence", () => {
  // Europaplatz's street platforms share a stop point and name (`Gleis 3` at 08:58, `Gleis 5` at
  // 08:59 on line 4); calls align by occurrence, not by anything printed.
  const europaplatz = (platformLabel: string): TripCall => ({
    stopName: "Europaplatz",
    placeName: "Karlsruhe",
    localStopId: "europaplatz",
    platformLabel,
  });
  const drawn = [europaplatz("Gleis 5"), ...calls("muehlburger-tor")];
  const farthest = [
    ...calls("karlstor"),
    europaplatz("Gleis 3"),
    europaplatz("Gleis 5"),
    ...calls("muehlburger-tor", "schillerstrasse"),
  ];

  assert.deepEqual(extendLineDiagramCalls(drawn, farthest), farthest);
});

test("without a run observed far enough there is nothing to extend with", () => {
  assert.deepEqual(extendLineDiagramCalls(calls("c", "b"), undefined), [...calls("c", "b")]);
  assert.deepEqual(extendLineDiagramCalls(calls("c", "b"), []), [...calls("c", "b")]);
});

test("an empty drawn chain has nothing for the run to be read around", () => {
  assert.deepEqual(extendLineDiagramCalls([], calls("d", "c", "b", "a")), []);
});
