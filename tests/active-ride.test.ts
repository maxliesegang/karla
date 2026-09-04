import assert from "node:assert/strict";
import test from "node:test";
import type { Departure } from "../src/data/transit-types.ts";
import {
  findActiveRideObservation,
  forgetActiveRideObservation,
  getActiveRideExpiry,
  rememberActiveRideObservation,
} from "../src/lib/active-ride.ts";

const observedAt = Date.parse("2026-08-23T16:00:00Z");
const departure: Departure = {
  id: "departure",
  tripId: "trip",
  lineId: "2",
  transportMode: "tram",
  destination: "Durlach",
  minutesUntilDeparture: 1,
  platformCode: "2",
  boardingLocalStopId: "europaplatz",
  status: "realtime",
  scheduledDepartureTime: "2026-08-23T16:01:00Z",
  tripCalls: [
    {
      stopName: "Durlach",
      scheduledArrivalTime: "2026-08-23T16:30:00Z",
      delayMinutes: 3,
    },
  ],
};

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
  const expiry = getActiveRideExpiry(departure, observedAt);
  assert.equal(expiry, Date.parse("2026-08-23T17:33:00Z"));

  rememberActiveRideObservation("trip", departure, observedAt);
  assert.equal(findActiveRideObservation("trip", observedAt + 1)?.departure.id, departure.id);
  assert.equal(findActiveRideObservation("other", observedAt + 1), null);
});

test("drops expired and explicitly ended rides", () => {
  const expiry = getActiveRideExpiry(departure, observedAt);
  rememberActiveRideObservation("trip", departure, observedAt);
  assert.equal(findActiveRideObservation("trip", expiry + 1), null);

  rememberActiveRideObservation("trip", departure, observedAt);
  forgetActiveRideObservation("trip");
  assert.equal(findActiveRideObservation("trip", observedAt + 1), null);
});
