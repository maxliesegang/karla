import assert from "node:assert/strict";
import test from "node:test";
import type { Departure } from "../src/data/transit-types.ts";
import { isDeparturePinned, isDepartureSelected } from "../src/lib/departure-presentation.ts";
import { createLineSelection } from "../src/lib/line-bundles.ts";

/**
 * The pair this exists for is real: Europaplatz publishes one vehicle once per place it calls at,
 * so its 3 to Rintheim stands on the board twice — `Gleis 6` at 13:43 and `Gleis 4` at 13:44 —
 * under one RealtimeTripId and two row identities.
 */
const TRIP_ID = "de:kvv:00003_:.kvv-21-3-E.11.T0.453.s26";

const createDeparture = (overrides: Partial<Departure> = {}): Departure =>
  ({
    id: "",
    tripId: TRIP_ID,
    lineId: "3",
    transportMode: "tram",
    destination: "Rintheim über Hbf",
    minutesUntilDeparture: 5,
    platformCode: "6",
    status: "realtime",
    scheduledDepartureTime: "2026-09-04T11:43:00.000Z",
    boardingLocalStopId: "europaplatz",
    boardingProviderStopPointId: "7000037",
    boardingProviderStopPointName: "Europaplatz",
    ...overrides,
  }) as Departure;

const selected = createDeparture({
  id: `europaplatz-${TRIP_ID}-2026-09-04T11:43:00.000Z`,
});

test("reads both rows of one vehicle at a complex's two places as the selection", () => {
  const sibling = createDeparture({
    id: `europaplatz-${TRIP_ID}-2026-09-04T11:44:00.000Z`,
    platformCode: "4",
    scheduledDepartureTime: "2026-09-04T11:44:00.000Z",
  });

  assert.equal(isDepartureSelected(sibling, selected, undefined), true);
  assert.equal(isDeparturePinned(sibling, selected), true);
});

test("leaves another trip of the same line quiet while one is pinned", () => {
  const other = createDeparture({
    id: `europaplatz-de:kvv:00003_:.kvv-21-3-E.11.T0.460.s26-2026-09-04T11:53:00.000Z`,
    tripId: "de:kvv:00003_:.kvv-21-3-E.11.T0.460.s26",
    scheduledDepartureTime: "2026-09-04T11:53:00.000Z",
  });

  assert.equal(isDepartureSelected(other, selected, undefined), false);
  assert.equal(isDeparturePinned(other, selected), false);
});

test("without a pinned trip the lines being read are the selection", () => {
  assert.equal(isDepartureSelected(selected, undefined, createLineSelection("3")), true);
  assert.equal(isDepartureSelected(selected, undefined, createLineSelection("2")), false);
  assert.equal(isDeparturePinned(selected, undefined), false);
});

test("rows the feed names no trip for still match by their own row id", () => {
  const untripped = createDeparture({
    id: "europaplatz-3-6-Rintheim über Hbf-2026-09-04T11:43:00.000Z",
    tripId: undefined,
  });

  assert.equal(isDepartureSelected(untripped, untripped, undefined), true);
  assert.equal(isDeparturePinned(untripped, untripped), true);
  assert.equal(
    isDepartureSelected(
      createDeparture({
        id: "europaplatz-3-6-Rintheim über Hbf-2026-09-04T11:44:00.000Z",
        tripId: undefined,
      }),
      untripped,
      undefined,
    ),
    false,
  );
});
