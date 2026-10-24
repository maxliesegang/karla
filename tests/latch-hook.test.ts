import assert from "node:assert/strict";
import test from "node:test";
import { renderHook } from "./support/render-hook.ts";
import { useLatch } from "../src/hooks/latch.ts";

test("stays false until the condition first holds, then stays true", async () => {
  const hook = await renderHook<{ condition: boolean }, boolean>(
    ({ condition }) => useLatch(condition),
    { condition: false },
  );
  assert.equal(hook.current, false);
  await hook.rerender({ condition: true });
  assert.equal(hook.current, true);
  await hook.rerender({ condition: false });
  assert.equal(hook.current, true);
  await hook.unmount();
});
