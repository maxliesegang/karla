import assert from "node:assert/strict";
import test from "node:test";
import type { TripCall } from "../src/data/transit-types.ts";
import { extendLineDiagramCalls } from "../src/lib/line-diagram.ts";

/** Both chains arrive in the diagram's own order — destination end first. */
const calls = (...stopIds: string[]): TripCall[] =>
  stopIds.map((localStopId) => ({ stopName: localStopId.toUpperCase(), localStopId }));

test("a short working is drawn out to the run observed furthest, past both of its ends", () => {
  // The drawn trip reaches C at its furthest; the line has been seen running from D to A. The
  // reading in hand keeps its own rows and their order; the run contributes what lies beyond them.
  assert.deepEqual(extendLineDiagramCalls(calls("c", "b"), calls("d", "c", "b", "a")), [
    ...calls("d", "c", "b", "a"),
  ]);
});

test("stops the drawn trip skipped but the run calls at are read in between", () => {
  // The whole-line view is the line, not one working: where the furthest run serves a stop the
  // drawn trip never called at, that stop belongs on the diagram too.
  assert.deepEqual(extendLineDiagramCalls(calls("d", "x", "b"), calls("d", "c", "b", "a")), [
    ...calls("d", "c", "x", "b", "a"),
  ]);
});

test("a drawn-only stop keeps its place beside the drawn calls around it", () => {
  // A variant calling at a stop the furthest run does not: it is drawn where its own reading put
  // it, between the calls it was read between, not where the run would have it.
  assert.deepEqual(extendLineDiagramCalls(calls("d", "c", "x", "b"), calls("d", "c", "b", "a")), [
    ...calls("d", "c", "x", "b", "a"),
  ]);
});

test("a drawn chain the run never reaches is left exactly as it was", () => {
  // Where the two chains share nothing there is nothing that says how the one continues into the
  // other; drawing them as one corridor would be a claim about rails nobody observed.
  assert.deepEqual(extendLineDiagramCalls(calls("x", "y"), calls("d", "c", "b", "a")), [
    ...calls("x", "y"),
  ]);
});

test("a drawn chain is never narrowed by the run it is extended with", () => {
  // A working that passes one of its own stops twice keeps both passes; the furthest run has only
  // seen the line once through, and that is not evidence the loop does not happen.
  assert.deepEqual(extendLineDiagramCalls(calls("a", "b", "c", "b", "a"), calls("a", "b", "c")), [
    ...calls("a", "b", "c", "b", "a"),
  ]);
});

test("without a run observed far enough there is nothing to extend with", () => {
  assert.deepEqual(extendLineDiagramCalls(calls("c", "b"), undefined), [...calls("c", "b")]);
  assert.deepEqual(extendLineDiagramCalls(calls("c", "b"), []), [...calls("c", "b")]);
});

test("an empty drawn chain has nothing for the run to be read around", () => {
  assert.deepEqual(extendLineDiagramCalls([], calls("d", "c", "b", "a")), []);
});
