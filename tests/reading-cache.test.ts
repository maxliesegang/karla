import assert from "node:assert/strict";
import test from "node:test";
import { ReadingCache } from "../src/data/reading-cache.ts";

test("a read keeps an entry recent without extending its lifetime", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 0 });
  const cache = new ReadingCache<string>(2, 100);
  cache.set("a", "first");
  t.mock.timers.tick(20);
  cache.set("b", "second");
  t.mock.timers.tick(20);
  assert.equal(cache.get("a"), "first");
  cache.set("c", "third");
  assert.equal(cache.get("b"), undefined);
  assert.equal(cache.get("a"), "first");
  assert.equal(cache.get("c"), "third");
  t.mock.timers.tick(60);
  assert.equal(cache.get("a"), undefined);
  assert.equal(cache.get("c"), "third");
});

test("expired readings make room before a live reading is evicted", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 0 });
  const cache = new ReadingCache<string>(2, 100);
  cache.set("expired", "old");
  t.mock.timers.tick(50);
  cache.set("live", "recent");
  cache.get("expired");
  t.mock.timers.tick(50);
  cache.set("new", "newest");
  assert.equal(cache.get("expired"), undefined);
  assert.equal(cache.get("live"), "recent");
  assert.equal(cache.get("new"), "newest");
});

test("replacement readings use their own timestamp, including already expired answers", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 0 });
  const cache = new ReadingCache<string>(2, 100);
  cache.set("a", "old");
  t.mock.timers.tick(50);
  cache.set("a", "fresh");
  t.mock.timers.tick(50);
  assert.equal(cache.get("a"), "fresh");
  cache.set("a", "late", 0);
  assert.equal(cache.get("a"), undefined);
});
