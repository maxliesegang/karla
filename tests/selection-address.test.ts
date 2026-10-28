import assert from "node:assert/strict";
import test from "node:test";

import { isAddressOutstanding } from "../src/routing.ts";

const JOURNEY = "kvv:22302:E:H:s26:946";

test("a journey that has left the rider's stop is not dropped while its line is still being read", () => {
  // The journey departed this stop half an hour ago, so the stop's own board is read and has no row
  // for it. The boards along the line have it — and have not answered yet.
  assert.equal(
    isAddressOutstanding({
      addressId: JOURNEY,
      hasResolvedStopEvent: false,
      isStopBoardRead: true,
      isReadingLine: true,
    }),
    true,
  );
});

test("a journey nothing has named once every reading answered is dropped", () => {
  assert.equal(
    isAddressOutstanding({
      addressId: JOURNEY,
      hasResolvedStopEvent: false,
      isStopBoardRead: true,
      isReadingLine: false,
    }),
    false,
  );
});

test("nothing is outstanding once the journey itself is in hand", () => {
  // Resolved from the line's boards while they are still being re-read: the answer is already here.
  assert.equal(
    isAddressOutstanding({
      addressId: JOURNEY,
      hasResolvedStopEvent: true,
      isStopBoardRead: true,
      isReadingLine: true,
    }),
    false,
  );
});

test("an address naming no journey waits for nothing", () => {
  assert.equal(
    isAddressOutstanding({
      addressId: undefined,
      hasResolvedStopEvent: false,
      isStopBoardRead: false,
      isReadingLine: true,
    }),
    false,
  );
});

test("a journey is never dropped before this stop's own board has been read", () => {
  assert.equal(
    isAddressOutstanding({
      addressId: JOURNEY,
      hasResolvedStopEvent: false,
      isStopBoardRead: false,
      isReadingLine: false,
    }),
    true,
  );
});
