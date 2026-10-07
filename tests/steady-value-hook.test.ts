import assert from "node:assert/strict";
import test from "node:test";
import { renderHook } from "./support/render-hook.ts";
import { useSteadyValue } from "../src/hooks/steady-value.ts";

const { act } = await import("react");

type Props = { value: string; key: string };
const pace = { settleMs: 1_000, intervalMs: 10_000 };

test("lands a burst of keys as one change, then changes at most once per interval", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const hook = await renderHook<Props, string>(
    ({ value, key }) => useSteadyValue(value, key, pace),
    { value: "empty", key: "" },
  );
  const advance = (ms: number) => act(async () => t.mock.timers.tick(ms));

  await hook.rerender({ value: "a", key: "a" });
  await advance(600);
  await hook.rerender({ value: "ab", key: "ab" });
  await advance(600);
  assert.equal(hook.current, "empty");
  await advance(400);
  assert.equal(hook.current, "ab");

  // The shown key's own updates pass at once.
  await hook.rerender({ value: "ab again", key: "ab" });
  assert.equal(hook.current, "ab again");

  await hook.rerender({ value: "abc", key: "abc" });
  await advance(5_000);
  assert.equal(hook.current, "ab again");
  await hook.rerender({ value: "abc, latest", key: "abc" });
  await advance(5_000);
  assert.equal(hook.current, "abc, latest");
  await hook.unmount();
});
