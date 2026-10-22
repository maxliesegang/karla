import assert from "node:assert/strict";
import test from "node:test";
import type { StopEvent } from "../src/data/transit-types.ts";
import { isStopEventPinned, isStopEventSelected } from "../src/lib/stop-event-presentation.ts";
import { createLineSelection } from "../src/lib/line-bundles.ts";
import { createStopEvent as createFixture } from "./support/fixtures.ts";

/**
 * The pair this exists for is real: Europaplatz publishes one vehicle once per place it calls at,
 * so its 3 to Rintheim stands on the board twice — `Gleis 6` at 13:43 and `Gleis 4` at 13:44 —
 * under one RealtimeTripId and two row identities.
 */
const JOURNEY_REF = "de:kvv:00003_:.kvv-21-3-E.11.T0.453.s26";

const createStopEvent = (overrides: Partial<StopEvent> = {}): StopEvent =>
  createFixture({
    id: "",
    journeyRef: JOURNEY_REF,
    lineId: "3",
    ptMode: "tram",
    destinationText: "Rintheim über Hbf",
    minutesUntilDeparture: 5,
    bay: "6",
    status: "realtime",
    timetabledDepartureTime: "2026-09-04T11:43:00.000Z",
    boardingLocalStopId: "europaplatz",
    boardingProviderStopPointId: "7000037",
    boardingProviderStopPointName: "Europaplatz",
    ...overrides,
  }) as StopEvent;

const selected = createStopEvent({
  id: `europaplatz-${JOURNEY_REF}-2026-09-04T11:43:00.000Z`,
});

test("reads both rows of one vehicle at a complex's two places as the selection", () => {
  const sibling = createStopEvent({
    id: `europaplatz-${JOURNEY_REF}-2026-09-04T11:44:00.000Z`,
    bay: "4",
    timetabledDepartureTime: "2026-09-04T11:44:00.000Z",
  });

  assert.equal(isStopEventSelected(sibling, selected, undefined), true);
  assert.equal(isStopEventPinned(sibling, selected), true);
});

test("leaves another trip of the same line quiet while one is pinned", () => {
  const other = createStopEvent({
    id: `europaplatz-de:kvv:00003_:.kvv-21-3-E.11.T0.460.s26-2026-09-04T11:53:00.000Z`,
    journeyRef: "de:kvv:00003_:.kvv-21-3-E.11.T0.460.s26",
    timetabledDepartureTime: "2026-09-04T11:53:00.000Z",
  });

  assert.equal(isStopEventSelected(other, selected, undefined), false);
  assert.equal(isStopEventPinned(other, selected), false);
});

test("without a pinned trip the lines being read are the selection", () => {
  assert.equal(isStopEventSelected(selected, undefined, createLineSelection("3")), true);
  assert.equal(isStopEventSelected(selected, undefined, createLineSelection("2")), false);
  assert.equal(isStopEventPinned(selected, undefined), false);
});

test("rows the feed names no trip for still match by their own row id", () => {
  const untripped = createStopEvent({
    id: "europaplatz-3-6-Rintheim über Hbf-2026-09-04T11:43:00.000Z",
    journeyRef: undefined,
  });

  assert.equal(isStopEventSelected(untripped, untripped, undefined), true);
  assert.equal(isStopEventPinned(untripped, untripped), true);
  assert.equal(
    isStopEventSelected(
      createStopEvent({
        id: "europaplatz-3-6-Rintheim über Hbf-2026-09-04T11:44:00.000Z",
        journeyRef: undefined,
      }),
      untripped,
      undefined,
    ),
    false,
  );
});
