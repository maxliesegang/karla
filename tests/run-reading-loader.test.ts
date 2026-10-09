import assert from "node:assert/strict";
import test from "node:test";
import { renderHook } from "./support/render-hook.ts";
import { transitSource } from "../src/data/transit-source.ts";
import { useRunReadingsByRowId } from "../src/hooks/run-reading-loader.ts";
import { createDeparture } from "./support/fixtures.ts";

const { act } = await import("react");

test("failed and slow runs cannot delay healthy runs, including after the run set changes", async (t) => {
  let now = 0;
  t.mock.method(Date, "now", () => now);
  let nextId = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  t.mock.method(window, "setTimeout", (callback: TimerHandler, delay = 0) => {
    assert.equal(typeof callback, "function");
    const id = ++nextId;
    timers.set(id, {
      at: now + delay,
      callback: () => {
        if (typeof callback === "function") callback();
      },
    });
    return id;
  });
  t.mock.method(window, "clearTimeout", (id: number) => {
    timers.delete(id);
  });
  const reads: { rowId: string; at: number; age: number | undefined }[] = [];
  t.mock.method(transitSource, "getRun", (rowId: string, age?: number) => {
    reads.push({ rowId, at: now, age });
    if (rowId === "slow") return new Promise<undefined>(() => {});
    return Promise.resolve(rowId === "failed" ? undefined : createDeparture({ id: rowId }));
  });
  const flush = () =>
    act(async () => {
      for (let i = 0; i < 32; i++) await Promise.resolve();
    });
  const advance = async (end: number) => {
    while (true) {
      const pending = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!pending || pending[1].at > end) break;
      now = pending[1].at;
      timers.delete(pending[0]);
      await act(async () => pending[1].callback());
      await flush();
    }
    now = end;
  };
  const hook = await renderHook(
    (ids: readonly string[]) => useRunReadingsByRowId(ids, { selectedRowId: "healthy" }),
    ["healthy", "failed", "slow"],
  );
  try {
    await flush();
    await advance(30_000);
    await hook.rerender(["healthy", "failed", "slow", "new"]);
    await flush();
    await advance(240_000);
    const healthy = reads.filter((r) => r.rowId === "healthy");
    const gaps = healthy.slice(1).map((r, index) => r.at - healthy[index].at);
    // The first refresh is set apart within the second half of a cadence, then every cadence.
    assert.ok(gaps[0] >= 15_000 && gaps[0] < 30_000);
    assert.ok(gaps.slice(1).every((gap) => gap === 30_000));
    assert.equal(healthy.length, 9);
    assert.equal(healthy[1].age, gaps[0]);
    assert.equal(healthy[2].age, 30_000);
    assert.deepEqual(
      reads.filter((r) => r.rowId === "failed").map((r) => r.at),
      [0, 60_000, 150_000, 240_000],
    );
    assert.equal(reads.filter((r) => r.rowId === "slow").length, 1);
    assert.equal(healthy[0].age, 0);
    await act(async () => window.dispatchEvent(new Event("visibilitychange")));
    await advance(240_000);
    assert.equal(reads.filter((r) => r.rowId === "failed").at(-1)?.at, 240_000);
    await hook.unmount();
    await advance(500_000);
    assert.equal(reads.at(-1)?.at, 240_000);
  } finally {
    await hook.unmount();
  }
});

test("hidden views stop reading and resume without waiting for another cadence", async (t) => {
  const original = Object.getOwnPropertyDescriptor(document, "visibilityState");
  const setVisibility = (state: "visible" | "hidden") =>
    Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
  setVisibility("hidden");
  let reads = 0;
  t.mock.method(transitSource, "getRun", async (id: string) => {
    reads += 1;
    return createDeparture({ id });
  });
  const hook = await renderHook(() => useRunReadingsByRowId(["healthy"], { refreshMs: 20 }), {});
  const wait = (ms: number) => act(async () => new Promise((resolve) => setTimeout(resolve, ms)));
  try {
    await wait(30);
    assert.equal(reads, 0);
    setVisibility("visible");
    await act(async () => window.dispatchEvent(new Event("visibilitychange")));
    await wait(10);
    assert.ok(reads > 0);
    setVisibility("hidden");
    await act(async () => window.dispatchEvent(new Event("visibilitychange")));
    const stoppedAt = reads;
    await wait(50);
    assert.equal(reads, stoppedAt);
  } finally {
    await hook.unmount();
    if (original) Object.defineProperty(document, "visibilityState", original);
    else Reflect.deleteProperty(document, "visibilityState");
  }
});

test("a bounded queue continues as soon as one read finishes", async (t) => {
  const reads: string[] = [];
  const finishes: (() => void)[] = [];
  t.mock.method(transitSource, "getRun", (id: string) => {
    reads.push(id);
    return new Promise((resolve) => finishes.push(() => resolve(createDeparture({ id }))));
  });
  const hook = await renderHook(
    (ids: readonly string[]) => useRunReadingsByRowId(ids),
    ["1", "2", "3", "4", "5", "6", "7"],
  );
  try {
    assert.equal(reads.length, 6);
    await act(async () => {
      finishes[0]();
    });
    assert.equal(reads.length, 7);
  } finally {
    await hook.unmount();
  }
});
