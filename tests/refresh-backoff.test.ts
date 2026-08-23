import assert from "node:assert/strict";
import test from "node:test";
import {
  extendFailureStreak,
  getBackoffDelayMs,
  isAwayEvidence,
  MAX_TRANSIENT_BACKOFF_MS,
  MAX_UNAVAILABLE_BACKOFF_MS,
} from "../src/hooks/refresh-backoff.ts";

const REFRESH_MS = 30_000;

test("a first failure doubles the cadence, whichever kind it is", () => {
  assert.equal(getBackoffDelayMs(REFRESH_MS, extendFailureStreak(undefined, "transient")), 60_000);
  assert.equal(
    getBackoffDelayMs(REFRESH_MS, extendFailureStreak(undefined, "unavailable")),
    60_000,
  );
});

test("a transient streak caps within a couple of steps and stays there", () => {
  const first = extendFailureStreak(undefined, "transient");
  const second = extendFailureStreak(first, "transient");
  const third = extendFailureStreak(second, "transient");
  assert.equal(getBackoffDelayMs(REFRESH_MS, first), 60_000);
  assert.equal(getBackoffDelayMs(REFRESH_MS, second), MAX_TRANSIENT_BACKOFF_MS);
  assert.equal(getBackoffDelayMs(REFRESH_MS, third), MAX_TRANSIENT_BACKOFF_MS);
  assert.equal(MAX_TRANSIENT_BACKOFF_MS, 90_000);
});

test("an unavailable feed earns the full ceiling", () => {
  let streak = extendFailureStreak(undefined, "unavailable");
  streak = extendFailureStreak(streak, "unavailable");
  assert.equal(getBackoffDelayMs(REFRESH_MS, streak), 120_000);
  streak = extendFailureStreak(streak, "unavailable");
  assert.equal(getBackoffDelayMs(REFRESH_MS, streak), 240_000);
  streak = extendFailureStreak(streak, "unavailable");
  assert.equal(getBackoffDelayMs(REFRESH_MS, streak), MAX_UNAVAILABLE_BACKOFF_MS);
  streak = extendFailureStreak(streak, "unavailable");
  assert.equal(getBackoffDelayMs(REFRESH_MS, streak), MAX_UNAVAILABLE_BACKOFF_MS);
  assert.equal(MAX_UNAVAILABLE_BACKOFF_MS, 5 * 60_000);
});

test("a change of kind starts its own count", () => {
  let streak = extendFailureStreak(undefined, "unavailable");
  streak = extendFailureStreak(streak, "unavailable");
  streak = extendFailureStreak(streak, "unavailable");
  streak = extendFailureStreak(streak, "transient");
  assert.deepEqual(streak, { kind: "transient", count: 1 });
  assert.equal(getBackoffDelayMs(REFRESH_MS, streak), 60_000);
});

test("a page or connection that was away forgives the streak", () => {
  assert.equal(isAwayEvidence("visibilitychange"), true);
  assert.equal(isAwayEvidence("pageshow"), true);
  assert.equal(isAwayEvidence("online"), true);
});

test("a window clicked back into keeps the cadence it earned", () => {
  // The page never stopped polling, so nothing about it says the feed is answering again; a resume
  // that forgave here would re-read every mounted board on every alt-tab.
  assert.equal(isAwayEvidence("focus"), false);
});
