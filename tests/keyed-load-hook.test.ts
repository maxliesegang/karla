import assert from "node:assert/strict";
import test from "node:test";
import { renderHook } from "./support/render-hook.ts";
import { useKeyedLoad, type KeyedLoadOptions } from "../src/hooks/keyed-load.ts";

const { act } = await import("react");

/** Real time, because the hook schedules on happy-dom's timers; the cadence is kept short. */
const REFRESH_MS = 20;
const wait = (ms: number) => act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));

const setVisibility = (state: "visible" | "hidden") =>
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true });

type Props = {
  key: string | null;
  load: (key: string, isEntryRead: boolean) => Promise<string>;
  options?: KeyedLoadOptions<string>;
};
const render = (props: Props) =>
  renderHook((p: Props) => useKeyedLoad(p.key, p.load, p.options), props);

/** A load that answers with its key and counts how often it was asked. */
function countingLoad() {
  const calls: string[] = [];
  const load = async (key: string) => {
    calls.push(key);
    return `value:${key}`;
  };
  return { calls, load };
}

test("nothing is loaded without a key", async () => {
  const { calls, load } = countingLoad();
  const loaded = await render({ key: null, load });
  await wait(REFRESH_MS);
  assert.equal(loaded.current, null);
  assert.deepEqual(calls, []);
  await loaded.unmount();
});

test("a key reads null until its load answers, and never shows another key's value", async () => {
  const { load } = countingLoad();
  const loaded = await render({ key: "a", load });
  await wait(0);
  assert.equal(loaded.current, "value:a");

  let answerB!: (value: string) => void;
  const slowB = (key: string) =>
    key === "b" ? new Promise<string>((resolve) => (answerB = resolve)) : load(key);
  await loaded.rerender({ key: "b", load: slowB });
  assert.equal(loaded.current, null);
  await act(async () => answerB("value:b"));
  assert.equal(loaded.current, "value:b");
  await loaded.unmount();
});

test("an answer for a key that is no longer asked for is dropped", async () => {
  let answerA!: (value: string) => void;
  const load = (key: string) =>
    key === "a" ? new Promise<string>((resolve) => (answerA = resolve)) : Promise.resolve("b");
  const loaded = await render({ key: "a", load });
  await loaded.rerender({ key: "b", load });
  await wait(0);
  await act(async () => answerA("a"));
  assert.equal(loaded.current, "b");
  await loaded.unmount();
});

test("refreshes on its cadence, and stops when unmounted", async () => {
  const { calls, load } = countingLoad();
  const loaded = await render({ key: "a", load, options: { refreshMs: REFRESH_MS } });
  await wait(REFRESH_MS * 5);
  const whileMounted = calls.length;
  assert.ok(whileMounted >= 3, `expected several refreshes, got ${whileMounted}`);

  await loaded.unmount();
  await wait(REFRESH_MS * 3);
  assert.equal(calls.length, whileMounted);
});

test("a hidden page stops polling, and coming back reads at once", async () => {
  const { calls, load } = countingLoad();
  setVisibility("hidden");
  const loaded = await render({ key: "a", load, options: { refreshMs: REFRESH_MS } });
  await wait(REFRESH_MS * 4);
  // The entry read still happens; nothing is scheduled after it.
  assert.equal(calls.length, 1);

  setVisibility("visible");
  await act(async () => window.dispatchEvent(new Event("visibilitychange")));
  await wait(5);
  assert.equal(calls.length, 2);
  await loaded.unmount();
});

test("failures back off, and a success restores the cadence", async () => {
  let failing = true;
  const calls: number[] = [];
  const load = async () => {
    calls.push(Date.now());
    if (failing) throw new Error("offline");
    return "ok";
  };
  const loaded = await render({ key: "a", load, options: { refreshMs: REFRESH_MS } });
  // Without backoff this is about ten reads; doubling from 40 ms allows three or four.
  await wait(REFRESH_MS * 10);
  const failed = calls.length;
  assert.ok(failed <= 4, `expected backoff, got ${failed} reads`);
  assert.equal(loaded.current, undefined);

  failing = false;
  await wait(REFRESH_MS * 20);
  assert.equal(loaded.current, "ok");
  const recovered = calls.slice(-3);
  assert.ok(recovered[2] - recovered[1] < REFRESH_MS * 3, "the cadence returns after a success");
  await loaded.unmount();
});

test("a resolved failure counts as a failure", async () => {
  const calls: number[] = [];
  const load = async () => {
    calls.push(Date.now());
    return "unavailable";
  };
  const loaded = await render({
    key: "a",
    load,
    options: { refreshMs: REFRESH_MS, isFailure: (value) => value === "unavailable" },
  });
  await wait(REFRESH_MS * 10);
  // The answer is still shown; only the cadence slows.
  assert.equal(loaded.current, "unavailable");
  assert.ok(calls.length <= 4, `expected backoff, got ${calls.length} reads`);
  await loaded.unmount();
});

test("bumping the reload nonce reads again and keeps the last answer meanwhile", async () => {
  let answer!: (value: string) => void;
  let reads = 0;
  const load = () => {
    reads += 1;
    return reads === 1 ? Promise.resolve("first") : new Promise<string>((r) => (answer = r));
  };
  const loaded = await render({ key: "a", load, options: { reloadNonce: 0 } });
  await wait(0);
  assert.equal(loaded.current, "first");

  await loaded.rerender({ key: "a", load, options: { reloadNonce: 1 } });
  assert.equal(reads, 2);
  assert.equal(loaded.current, "first");
  await act(async () => answer("second"));
  assert.equal(loaded.current, "second");
  await loaded.unmount();
});

test("a new load under the same key is used from the next refresh, without restarting", async () => {
  const first = countingLoad();
  const second = countingLoad();
  const loaded = await render({ key: "a", load: first.load, options: { refreshMs: REFRESH_MS } });
  await wait(0);
  await loaded.rerender({ key: "a", load: second.load, options: { refreshMs: REFRESH_MS } });
  assert.equal(first.calls.length, 1);
  assert.equal(second.calls.length, 0);
  await wait(REFRESH_MS * 2);
  assert.equal(first.calls.length, 1);
  assert.ok(second.calls.length >= 1);
  await loaded.unmount();
});

test("only a mounted caller's first read is its entry read", async () => {
  const entries: boolean[] = [];
  const load = async (key: string, isEntryRead: boolean) => {
    entries.push(isEntryRead);
    return key;
  };
  const loaded = await render({ key: "a", load });
  await loaded.rerender({ key: "b", load });
  await wait(0);
  assert.deepEqual(entries, [true, false]);
  await loaded.unmount();
});
