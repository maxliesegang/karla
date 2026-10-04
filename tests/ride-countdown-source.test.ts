import assert from "node:assert/strict";
import test from "node:test";
import {
  getRideCountdownSourceLabel,
  type TripCallTimeReading,
} from "../src/lib/departure-presentation.ts";

const callTime = (punctuality: TripCallTimeReading["punctuality"]): TripCallTimeReading => ({
  expectedTime: "21:51",
  punctuality,
  accessibilityLabel: "",
  isPast: false,
});

test("a ride without a position names a predicted call as a prediction, not the timetable", () => {
  assert.equal(
    getRideCountdownSourceLabel({ source: "schedule" }, callTime("late")),
    "nach Echtzeitprognose",
  );
  assert.equal(
    getRideCountdownSourceLabel({ source: "schedule" }, callTime("punctual")),
    "nach Echtzeitprognose",
  );
});

test("a ride without a position or prediction says it follows the timetable", () => {
  assert.equal(
    getRideCountdownSourceLabel({ source: "schedule" }, callTime("unmonitored")),
    "nach Fahrplan",
  );
  assert.equal(getRideCountdownSourceLabel({ source: "schedule" }, undefined), "nach Fahrplan");
});

test("a positioned ride states the distance left where it has one", () => {
  assert.equal(
    getRideCountdownSourceLabel({ source: "position", metersToNextCall: 420 }, callTime("late")),
    "nach Standort · noch 420 m",
  );
  assert.equal(getRideCountdownSourceLabel({ source: "position" }, undefined), "nach Standort");
});
