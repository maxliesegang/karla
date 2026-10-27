import assert from "node:assert/strict";
import test from "node:test";
import type { StopEvent } from "../src/data/transit-types.ts";
import {
  findActiveRideObservation,
  forgetActiveRideObservation,
  getActiveRideExpiry,
  rememberActiveRideObservation,
} from "../src/lib/active-ride.ts";
import { createStopEvent } from "./support/fixtures.ts";

const observedAt = Date.parse("2026-08-23T16:00:00Z");
const stopEvent: StopEvent = createStopEvent({
  id: "departure",
  journeyRef: "trip",
  lineId: "2",
  ptMode: "tram",
  destinationText: "Durlach",
  minutesUntilDeparture: 1,
  bay: "2",
  boardingStopPlaceId: "europaplatz",
  status: "realtime",
  timetabledDepartureTime: "2026-08-23T16:01:00Z",
  calls: [
    {
      stopName: "Durlach",
      timetabledArrivalTime: "2026-08-23T16:30:00Z",
      delayMinutes: 3,
    },
  ],
});

function installStorage() {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
      },
    },
  });
}

test.beforeEach(installStorage);

test("restores the same active ride until its final call grace period", () => {
  const expiry = getActiveRideExpiry(stopEvent, observedAt);
  assert.equal(expiry, Date.parse("2026-08-23T17:33:00Z"));

  rememberActiveRideObservation("trip", stopEvent, observedAt);
  assert.equal(findActiveRideObservation("trip", observedAt + 1)?.stopEvent.id, stopEvent.id);
  assert.equal(findActiveRideObservation("other", observedAt + 1), null);
});

test("drops expired and explicitly ended rides", () => {
  const expiry = getActiveRideExpiry(stopEvent, observedAt);
  rememberActiveRideObservation("trip", stopEvent, observedAt);
  assert.equal(findActiveRideObservation("trip", expiry + 1), null);

  rememberActiveRideObservation("trip", stopEvent, observedAt);
  forgetActiveRideObservation("trip");
  assert.equal(findActiveRideObservation("trip", observedAt + 1), null);
});
