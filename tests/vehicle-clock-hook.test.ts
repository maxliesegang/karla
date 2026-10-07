import assert from "node:assert/strict";
import test from "node:test";
import { renderHook } from "./support/render-hook.ts";
import { useVehicleFeedNow } from "../src/hooks/clock.ts";

test("static maps tick on the countdown cadence; animated maps keep their finer clock", async (t) => {
  const intervals: number[] = [];
  const cleared: number[] = [];
  t.mock.method(window, "setInterval", (_tick: () => void, interval: number) => {
    intervals.push(interval);
    return intervals.length;
  });
  t.mock.method(window, "clearInterval", (id: number) => cleared.push(id));
  const clock = await renderHook<boolean, number>(
    (isAnimated: boolean) => useVehicleFeedNow(true, null, { isAnimated }),
    false,
  );
  t.after(() => clock.unmount());
  assert.deepEqual(intervals, [5_000]);
  await clock.rerender(true);
  assert.deepEqual(intervals, [5_000, 1_000]);
  assert.ok(cleared.includes(1));
});
