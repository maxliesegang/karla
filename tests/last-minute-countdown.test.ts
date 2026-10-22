import assert from "node:assert/strict";
import test from "node:test";
import {
  getCountdownReading,
  getStopEventAccessibilityLabel,
} from "../src/lib/stop-event-presentation.ts";
import { createStopEvent } from "./support/fixtures.ts";

const TIMETABLED = "2026-10-18T10:00:00.000Z";
const ESTIMATED = "2026-10-18T10:01:12.000Z";
const at = (time: string) => Date.parse(`2026-10-18T${time}Z`);
const SECONDS = { isShowingLastMinuteSeconds: true };

const estimatedToTheSecond = createStopEvent({
  status: "realtime",
  timetabledDepartureTime: TIMETABLED,
  estimatedDepartureTime: ESTIMATED,
  delayMinutes: 1,
  isEstimatedToTheSecond: true,
});

test("the last minute counts down in ten-second steps, rounded down, only when chosen", () => {
  assert.deepEqual(getCountdownReading(estimatedToTheSecond, at("10:00:25"), SECONDS), {
    kind: "seconds",
    seconds: 40,
    label: "40 s",
  });
  assert.deepEqual(getCountdownReading(estimatedToTheSecond, at("10:01:05"), SECONDS), {
    kind: "due",
    label: "jetzt",
  });
  // Unchosen, the clock minutes as KVV's displays count them.
  assert.equal(getCountdownReading(estimatedToTheSecond, at("10:00:25")).label, "1 min");
});

test("before the last minute, and for minute-grained predictions, minutes are kept", () => {
  assert.equal(getCountdownReading(estimatedToTheSecond, at("10:00:11"), SECONDS).label, "1 min");
  const efaRow = { ...estimatedToTheSecond, isEstimatedToTheSecond: undefined };
  assert.equal(getCountdownReading(efaRow, at("10:00:25"), SECONDS).label, "1 min");
  const timetabledRow = { ...estimatedToTheSecond, estimatedDepartureTime: undefined };
  assert.equal(getCountdownReading(timetabledRow, at("10:00:25"), SECONDS).kind, "minutes");
});

test("the spoken row says the seconds the column shows", () => {
  assert.match(
    getStopEventAccessibilityLabel(estimatedToTheSecond, at("10:00:25"), SECONDS),
    /in 40 Sekunden/,
  );
  assert.match(
    getStopEventAccessibilityLabel(estimatedToTheSecond, at("10:00:25")),
    /in 1 Minute,/,
  );
});
