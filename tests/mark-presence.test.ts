import assert from "node:assert/strict";
import test from "node:test";
import type { Call, StopEvent } from "../src/data/transit-types.ts";
import { createMarkPresence, type PresentedMark } from "../src/lib/mark-presence.ts";
import { createCall } from "./support/calls.ts";
import { createStopEvent } from "./support/fixtures.ts";

const start = Date.parse("2026-08-23T12:00:00Z");
const call = createCall(start);
const GRACE_MS = 180_000;

const reading = (delayMinutes: number | undefined, overrides: Partial<StopEvent> = {}): StopEvent =>
  createStopEvent({
    id: "a-board-row",
    journeyRef: "j1",
    datedJourneyId: "j1@today",
    calls: [call("a", 0), call("b", 4), call("c", 8)].map(
      (entry): Call => ({ ...entry, delayMinutes }),
    ),
    ...overrides,
  });

const mark = (stopEvent: StopEvent, key = "j1@today"): PresentedMark => ({
  key,
  stopEvent,
  toStopId: "b",
});

test("a journey enters once, and a refresh with the same delay shows nothing", () => {
  const presence = createMarkPresence(GRACE_MS);
  assert.deepEqual([...presence.note([mark(reading(1))], 0)], [["j1@today", "enter"]]);
  assert.equal(presence.note([mark(reading(1))], 30_000).size, 0);
});

test("a delay moved by a minute at the next call cues the mark", () => {
  const presence = createMarkPresence(GRACE_MS);
  presence.note([mark(reading(1))], 0);
  assert.deepEqual([...presence.note([mark(reading(2))], 90_000)], [["j1@today", "update"]]);
  assert.equal(presence.note([mark(reading(2))], 91_000).size, 0);
});

test("live data arriving cues the mark; losing it does not", () => {
  const presence = createMarkPresence(GRACE_MS);
  presence.note([mark(reading(undefined))], 0);
  assert.deepEqual([...presence.note([mark(reading(0))], 90_000)], [["j1@today", "update"]]);
  assert.equal(presence.note([mark(reading(undefined))], 180_000).size, 0);
});

test("a new key for a known journey neither enters nor cues", () => {
  const presence = createMarkPresence(GRACE_MS);
  presence.note([mark(reading(1))], 0);
  const rekeyed = reading(1, { id: "another-board-row", datedJourneyId: undefined });
  assert.equal(presence.note([mark(rekeyed, "j1")], 90_000).size, 0);
});

test("a journey missing for one refresh does not enter again; one gone past the grace does", () => {
  const presence = createMarkPresence(GRACE_MS);
  presence.note([mark(reading(1))], 0);
  presence.note([], 90_000);
  assert.equal(presence.note([mark(reading(1))], 170_000).size, 0);
  presence.note([], 200_000);
  assert.deepEqual([...presence.note([mark(reading(1))], 400_000)], [["j1@today", "enter"]]);
});

test("a turnaround handing its mark to the next journey stays silent", () => {
  const presence = createMarkPresence(GRACE_MS);
  presence.note([mark(reading(0))], 0);
  const turning = reading(3, { id: "out", journeyRef: "j2", datedJourneyId: "j2@today" });
  assert.equal(presence.note([mark(turning)], 30_000).size, 0);
});
