import assert from "node:assert/strict";
import test from "node:test";
import { renderHook } from "./support/render-hook.ts";
import type { StopEvent } from "../src/data/transit-types.ts";
import { transitSource } from "../src/data/transit-source.ts";
import { useHeldDatedJourney } from "../src/hooks/dated-journey-reading-store.ts";

const JOURNEY = "trip-1";
const OTHER_JOURNEY = "trip-2";
const READING = { id: "row-1", destinationText: "Wörth Badepark" } as StopEvent;
const FRESHER = { id: "row-1", destinationText: "Wörth Badepark", delayMinutes: 2 } as StopEvent;
/** What the store answers for the held row while no board lists it. */
const STORED = { id: "row-1", destinationText: "Wörth Badepark", delayMinutes: 3 } as StopEvent;

transitSource.findDatedJourney = (rowId) => (rowId === STORED.id ? STORED : undefined);

type Props = { key: string | undefined; stopEvent: StopEvent | undefined };
const render = (props: Props) =>
  renderHook((p: Props) => useHeldDatedJourney(p.key, p.stopEvent), props);

test("a run is held by id, and read from the store, while nothing lists it", async () => {
  const held = await render({ key: JOURNEY, stopEvent: READING });
  assert.equal(held.current, READING);
  await held.rerender({ key: JOURNEY, stopEvent: undefined });
  assert.equal(held.current, STORED);
  await held.unmount();
});

test("a fresher reading of the same run replaces the one held", async () => {
  const held = await render({ key: JOURNEY, stopEvent: READING });
  await held.rerender({ key: JOURNEY, stopEvent: FRESHER });
  assert.equal(held.current, FRESHER);
  await held.unmount();
});

test("the hold is dropped with its key", async () => {
  const held = await render({ key: JOURNEY, stopEvent: READING });
  await held.rerender({ key: undefined, stopEvent: undefined });
  assert.equal(held.current, undefined);
  await held.unmount();
});

test("a hold is never picked up under a different key", async () => {
  const held = await render({ key: JOURNEY, stopEvent: READING });
  await held.rerender({ key: OTHER_JOURNEY, stopEvent: undefined });
  assert.equal(held.current, undefined);
  await held.unmount();
});
