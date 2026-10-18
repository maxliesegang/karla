import assert from "node:assert/strict";
import test from "node:test";
import {
  getCountdownReading,
  getDepartureAccessibilityLabel,
} from "../src/lib/departure-presentation.ts";
import { createDeparture } from "./support/fixtures.ts";

const SCHEDULED = "2026-10-18T10:00:00.000Z";
const PREDICTED = "2026-10-18T10:01:12.000Z";
const at = (time: string) => Date.parse(`2026-10-18T${time}Z`);
const SECONDS = { isShowingLastMinuteSeconds: true };

const predictedToTheSecond = createDeparture({
  status: "realtime",
  scheduledDepartureTime: SCHEDULED,
  predictedDepartureTime: PREDICTED,
  delayMinutes: 1,
  isPredictedToTheSecond: true,
});

test("the last minute counts down in ten-second steps, rounded down, only when chosen", () => {
  assert.deepEqual(getCountdownReading(predictedToTheSecond, at("10:00:25"), SECONDS), {
    kind: "seconds",
    seconds: 40,
    label: "40 s",
  });
  assert.deepEqual(getCountdownReading(predictedToTheSecond, at("10:01:05"), SECONDS), {
    kind: "due",
    label: "jetzt",
  });
  // Unchosen, the clock minutes as KVV's displays count them.
  assert.equal(getCountdownReading(predictedToTheSecond, at("10:00:25")).label, "1 min");
});

test("before the last minute, and for minute-grained predictions, minutes are kept", () => {
  assert.equal(getCountdownReading(predictedToTheSecond, at("10:00:11"), SECONDS).label, "1 min");
  const efaRow = { ...predictedToTheSecond, isPredictedToTheSecond: undefined };
  assert.equal(getCountdownReading(efaRow, at("10:00:25"), SECONDS).label, "1 min");
  const scheduledRow = { ...predictedToTheSecond, predictedDepartureTime: undefined };
  assert.equal(getCountdownReading(scheduledRow, at("10:00:25"), SECONDS).kind, "minutes");
});

test("the spoken row says the seconds the column shows", () => {
  assert.match(
    getDepartureAccessibilityLabel(predictedToTheSecond, at("10:00:25"), SECONDS),
    /in 40 Sekunden/,
  );
  assert.match(
    getDepartureAccessibilityLabel(predictedToTheSecond, at("10:00:25")),
    /in 1 Minute,/,
  );
});
