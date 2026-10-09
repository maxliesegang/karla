import assert from "node:assert/strict";
import test from "node:test";
import "./support/render-hook.ts";
import { CHECKPOINT_LEAD_MS, RunReadingPoller } from "../src/hooks/run-reading-poller.ts";

test("a run is re-read once just before a checkpoint departure, then keeps its cadence", async (t) => {
  let now = 0;
  t.mock.method(Date, "now", () => now);
  let nextId = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  t.mock.method(window, "setTimeout", (callback: () => void, delay = 0) => {
    timers.set(++nextId, { at: now + delay, callback });
    return nextId;
  });
  t.mock.method(window, "clearTimeout", (id: number) => timers.delete(id));
  const flush = async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  };
  const advance = async (end: number) => {
    while (true) {
      const pending = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!pending || pending[1].at > end) break;
      now = pending[1].at;
      timers.delete(pending[0]);
      pending[1].callback();
      await flush();
    }
    now = end;
  };
  const reads: { at: number; maxAgeMs: number }[] = [];
  const poller = new RunReadingPoller(
    async (_rowId, maxAgeMs) => {
      reads.push({ at: now, maxAgeMs });
      return {};
    },
    30_000,
    false,
  );
  try {
    poller.update([{ rowId: "run", maxAgeMs: 30_000 }]);
    await flush();
    // Entry, the staggered refresh, then one cadence read; the clock stops on the last.
    while (reads.length < 3) await advance([...timers.values()][0].at);
    const lastRead = reads.at(-1)!.at;
    assert.equal(now, lastRead);

    // A departure 25 s after the last read: its window opens before the next cadence read.
    const departure = lastRead + 25_000;
    poller.setCheckpoints(new Map([["run", [departure]]]));
    await advance(lastRead + 60_000);
    const after = reads.filter((read) => read.at > lastRead);
    assert.deepEqual(after[0], { at: departure - CHECKPOINT_LEAD_MS, maxAgeMs: 0 });
    assert.equal(after[1].at, departure - CHECKPOINT_LEAD_MS + 30_000);
    assert.equal(after.length, 2);
  } finally {
    poller.stop();
  }
});

test("a read already inside a checkpoint's window answers it", async (t) => {
  let now = 0;
  t.mock.method(Date, "now", () => now);
  const reads: number[] = [];
  t.mock.method(window, "setTimeout", () => 0);
  t.mock.method(window, "clearTimeout", () => {});
  const poller = new RunReadingPoller(
    async () => {
      reads.push(now);
      return {};
    },
    30_000,
    false,
  );
  try {
    poller.update([{ rowId: "run", maxAgeMs: 30_000 }]);
    await Promise.resolve();
    now = 5_000;
    poller.setCheckpoints(new Map([["run", [10_000]]]));
    assert.deepEqual(reads, [0]);
  } finally {
    poller.stop();
  }
});
