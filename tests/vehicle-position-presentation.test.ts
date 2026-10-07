import assert from "node:assert/strict";
import test from "node:test";
import { createDeparture } from "./support/fixtures";
import { createCall, run } from "./support/calls";
import { getVehiclePositionSourceLabel } from "../src/lib/vehicle-position-presentation";
import { createRunMotions, getRunPlacement } from "../src/lib/vehicle-positioning";

const start = Date.parse("2026-10-07T10:00:00Z");
const call = createCall(start);

test("scheduled calls stay visible and say nach Fahrplan even when the board row has a prediction", () => {
  const run = createDeparture({
    predictedDepartureTime: new Date(start + 60_000).toISOString(),
    status: "realtime",
    tripCalls: [call("a", 0), call("b", 2), call("c", 4)].map((entry) => ({
      ...entry,
      delayMinutes: undefined,
    })),
  });
  assert.equal(getVehiclePositionSourceLabel(run, start + 60_000, "a", "b"), "nach Fahrplan");
  assert.ok(getRunPlacement(createRunMotions(), run, start + 60_000));
});

test("a failed refresh keeps prediction movement and reports the prediction's age, not the row's", () => {
  const run = createDeparture({
    tripCalls: [call("a", 0), call("b", 10)],
    readAt: {
      rowReadAt: start + 179_000,
      sequenceReadAt: start,
      sequenceRefreshFailedAt: start + 120_000,
    },
  });
  assert.equal(
    getVehiclePositionSourceLabel(run, start + 180_000, "a", "b"),
    "nach Echtzeitprognose · 3 min alt · Aktualisierung fehlgeschlagen",
  );
  assert.ok(getRunPlacement(createRunMotions(), run, start + 180_000));
});

test("zero delay is a prediction, and inherited endpoint delays are labeled as inferred", () => {
  const run = createDeparture({
    tripCalls: [
      call("a", 0),
      { ...call("b", 2), delayMinutes: undefined },
      { ...call("c", 4), delayMinutes: undefined },
    ],
  });
  assert.equal(
    getVehiclePositionSourceLabel(run, start, "b", "c"),
    "mit fortgeschriebener Prognose",
  );
  assert.equal(
    getVehiclePositionSourceLabel(
      { ...run, tripCalls: [call("a", 0), call("b", 2)] },
      start,
      "a",
      "b",
    ),
    "nach Echtzeitprognose",
  );
});

test("an existing waiting marker remains visible when a fresh sequence has only scheduled times", () => {
  const motions = createRunMotions();
  const predicted = createDeparture({
    tripId: "waiting-scheduled-recovery",
    tripCalls: run([call("a", 0), call("b", 2), call("c", 4)]),
  });
  assert.equal(getRunPlacement(motions, predicted, start - 240_000)?.phase, "beforeStart");
  const scheduled = {
    ...predicted,
    tripCalls: predicted.tripCalls?.map((entry) => ({ ...entry, delayMinutes: undefined })),
  };
  for (let remaining = 180_000; remaining > 0; remaining -= 60_000) {
    const held = getRunPlacement(motions, scheduled, start - remaining);
    assert.equal(held?.phase, "beforeStart");
    assert.equal(held?.progress, 0);
  }
  assert.equal(getVehiclePositionSourceLabel(scheduled, start), "nach Fahrplan");
  assert.ok(getRunPlacement(motions, scheduled, start + 60_000));
});
