import assert from "node:assert/strict";
import test from "node:test";
import { renderHook } from "./support/render-hook.ts";
import type { Departure } from "../src/data/transit-types.ts";
import { transitSource } from "../src/data/transit-source.ts";
import { useHeldRun } from "../src/hooks/run-reading-store.ts";

const TRIP = "trip-1";
const OTHER_TRIP = "trip-2";
const READING = { id: "row-1", destination: "Wörth Badepark" } as Departure;
const FRESHER = { id: "row-1", destination: "Wörth Badepark", delayMinutes: 2 } as Departure;
/** What the store answers for the held row while no board lists it. */
const STORED = { id: "row-1", destination: "Wörth Badepark", delayMinutes: 3 } as Departure;

transitSource.findRun = (rowId) => (rowId === STORED.id ? STORED : undefined);

type Props = { key: string | undefined; departure: Departure | undefined };
const render = (props: Props) => renderHook((p: Props) => useHeldRun(p.key, p.departure), props);

test("a run is held by id, and read from the store, while nothing lists it", async () => {
  const held = await render({ key: TRIP, departure: READING });
  assert.equal(held.current, READING);
  await held.rerender({ key: TRIP, departure: undefined });
  assert.equal(held.current, STORED);
  await held.unmount();
});

test("a fresher reading of the same run replaces the one held", async () => {
  const held = await render({ key: TRIP, departure: READING });
  await held.rerender({ key: TRIP, departure: FRESHER });
  assert.equal(held.current, FRESHER);
  await held.unmount();
});

test("the hold is dropped with its key", async () => {
  const held = await render({ key: TRIP, departure: READING });
  await held.rerender({ key: undefined, departure: undefined });
  assert.equal(held.current, undefined);
  await held.unmount();
});

test("a hold is never picked up under a different key", async () => {
  const held = await render({ key: TRIP, departure: READING });
  await held.rerender({ key: OTHER_TRIP, departure: undefined });
  assert.equal(held.current, undefined);
  await held.unmount();
});
