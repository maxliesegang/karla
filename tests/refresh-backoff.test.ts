import assert from "node:assert/strict";
import test from "node:test";
import {
  extendFailureStreak,
  getBackoffDelayMs,
  isAwayEvidence,
  isVisibleResumeEvent,
  FIRST_TRANSIENT_RETRY_MS,
  MAX_TRANSIENT_BACKOFF_MS,
  MAX_UNAVAILABLE_BACKOFF_MS,
} from "../src/hooks/refresh-backoff.ts";

const REFRESH_MS = 30_000;

test("a lost request is retried within seconds, and an unavailable feed after a doubled cadence", () => {
  assert.equal(
    getBackoffDelayMs(REFRESH_MS, extendFailureStreak(undefined, "transient")),
    FIRST_TRANSIENT_RETRY_MS,
  );
  assert.equal(FIRST_TRANSIENT_RETRY_MS, 5_000);
  assert.equal(
    getBackoffDelayMs(REFRESH_MS, extendFailureStreak(undefined, "unavailable")),
    60_000,
  );
});

test("a transient streak triples to its ceiling and stays there", () => {
  let streak = extendFailureStreak(undefined, "transient");
  const delays = [getBackoffDelayMs(REFRESH_MS, streak)];
  for (let step = 0; step < 4; step += 1) {
    streak = extendFailureStreak(streak, "transient");
    delays.push(getBackoffDelayMs(REFRESH_MS, streak));
  }
  assert.deepEqual(delays, [5_000, 15_000, 45_000, 90_000, 90_000]);
  assert.equal(MAX_TRANSIENT_BACKOFF_MS, 90_000);
});

test("a first retry is never slower than the cadence itself", () => {
  assert.equal(getBackoffDelayMs(2_000, extendFailureStreak(undefined, "transient")), 2_000);
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
  assert.equal(getBackoffDelayMs(REFRESH_MS, streak), FIRST_TRANSIENT_RETRY_MS);
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

test("a page shown by iOS resumes while its reported visibility catches up", () => {
  assert.equal(isVisibleResumeEvent("pageshow", "hidden"), true);
  assert.equal(isVisibleResumeEvent("focus", "hidden"), true);
  assert.equal(isVisibleResumeEvent("visibilitychange", "hidden"), false);
  assert.equal(isVisibleResumeEvent("online", "hidden"), false);
  assert.equal(isVisibleResumeEvent("visibilitychange", "visible"), true);
});
