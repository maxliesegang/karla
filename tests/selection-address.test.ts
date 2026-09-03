import assert from "node:assert/strict";
import test from "node:test";

// The module reads the query once at load; another test file in this process may have stubbed it.
if (!("window" in globalThis)) {
  Object.defineProperty(globalThis, "window", { value: { location: { search: "" } } });
}
const { isAddressedTripOutstanding } = await import("../src/routing.ts");

const TRIP = "de:kvv:00S02_:.kvv-21-12-E.5.T0.946.s26";

test("a trip that has left the rider's stop is not dropped while its line is still being read", () => {
  // The trip departed this stop half an hour ago, so the stop's own board is read and has no row
  // for it. The boards along the line have it — and have not answered yet.
  assert.equal(
    isAddressedTripOutstanding({
      addressedTripId: TRIP,
      hasResolvedTrip: false,
      isStopBoardRead: true,
      isReadingLine: true,
    }),
    true,
  );
});

test("a trip nothing has named once every reading answered is dropped", () => {
  assert.equal(
    isAddressedTripOutstanding({
      addressedTripId: TRIP,
      hasResolvedTrip: false,
      isStopBoardRead: true,
      isReadingLine: false,
    }),
    false,
  );
});

test("nothing is outstanding once the trip itself is in hand", () => {
  // Resolved from the line's boards while they are still being re-read: the answer is already here.
  assert.equal(
    isAddressedTripOutstanding({
      addressedTripId: TRIP,
      hasResolvedTrip: true,
      isStopBoardRead: true,
      isReadingLine: true,
    }),
    false,
  );
});

test("an address naming no trip waits for nothing", () => {
  assert.equal(
    isAddressedTripOutstanding({
      addressedTripId: undefined,
      hasResolvedTrip: false,
      isStopBoardRead: false,
      isReadingLine: true,
    }),
    false,
  );
});

test("a trip is never dropped before this stop's own board has been read", () => {
  assert.equal(
    isAddressedTripOutstanding({
      addressedTripId: TRIP,
      hasResolvedTrip: false,
      isStopBoardRead: false,
      isReadingLine: false,
    }),
    true,
  );
});
