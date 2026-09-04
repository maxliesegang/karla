import assert from "node:assert/strict";
import test from "node:test";
import type { KvvDeparture } from "../src/data/kvv-efa-parsers.ts";
import { createDepartureId } from "../src/data/transit-source.ts";

/**
 * The pair this exists for is real: two S8 to Karlsruhe Tullastraße leave Augartenstraße Gleis 2
 * scheduled on the same minute, one running three minutes late and one not monitored at all.
 */
const createDeparture = (overrides: Partial<KvvDeparture> = {}): KvvDeparture =>
  ({
    stopPointId: "7000074",
    stopPointName: "Augartenstraße",
    tripId: "de:kvv:00S08_:.kvv-22-308-E.7.T0.613.s26",
    lineId: "S8",
    transportMode: "tram",
    destination: "Karlsruhe Tullastraße",
    minutesUntilDeparture: 44,
    platformCode: "2",
    status: "realtime",
    scheduledDepartureTime: "2026-08-24T18:50:00.000Z",
    ...overrides,
  }) as KvvDeparture;

test("tells two trips apart when line, Steig, destination and scheduled minute are all the same", () => {
  const delayed = createDeparture({
    delayMinutes: 3,
    predictedDepartureTime: "2026-08-24T18:53:00.000Z",
  });
  const unmonitored = createDeparture({
    tripId: "de:kvv:00S08_:.kvv-22-308-E.7.T0.667.s26",
    minutesUntilDeparture: 41,
  });

  assert.notEqual(
    createDepartureId(delayed, "augartenstrasse"),
    createDepartureId(unmonitored, "augartenstrasse"),
  );
});

test("keeps a trip's id across refreshes, whatever the feed reports about it now", () => {
  const first = createDeparture({ minutesUntilDeparture: 44 });
  const later = createDeparture({ minutesUntilDeparture: 12, delayMinutes: 2, status: "delayed" });

  assert.equal(
    createDepartureId(first, "augartenstrasse"),
    createDepartureId(later, "augartenstrasse"),
  );
});

test("separates the same trip read at two stops, and two runs of a reused trip id", () => {
  const departure = createDeparture();

  assert.notEqual(
    createDepartureId(departure, "augartenstrasse"),
    createDepartureId(departure, "marktplatz"),
  );
  assert.notEqual(
    createDepartureId(departure, "augartenstrasse"),
    createDepartureId(
      createDeparture({ scheduledDepartureTime: "2026-08-24T19:50:00.000Z" }),
      "augartenstrasse",
    ),
  );
});

test("falls back to what the departure looks like where the feed names no trip", () => {
  const untripped = createDeparture({ tripId: undefined });

  assert.equal(
    createDepartureId(untripped, "augartenstrasse"),
    "augartenstrasse-S8-2-Karlsruhe Tullastraße-2026-08-24T18:50:00.000Z",
  );
});
