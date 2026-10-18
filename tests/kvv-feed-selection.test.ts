import assert from "node:assert/strict";
import test from "node:test";
import {
  FeedChangedError,
  TriasRateLimitError,
  TriasUnavailableError,
} from "../src/data/kvv-feed-errors.ts";
import { KvvFeedSelection, TRIAS_RETRY_AFTER_MS } from "../src/data/kvv-feed-selection.ts";
import type { KvvFeed } from "../src/data/kvv-feed.ts";

function feed(): KvvFeed {
  return {
    fetchDepartureBoard: async (stopPointId) => ({
      stopPointId,
      stopName: "Stop",
      serverTime: "2026-10-17T21:00:00Z",
      servingLines: [],
      departures: [],
    }),
    fetchTrip: async () => ({ serverTime: "2026-10-17T21:00:00Z", tripCalls: [] }),
    searchStops: async () => [],
    fetchLineRoute: async () => [],
    fetchServiceNotices: async () => [],
  };
}

test("an EFA-only selection keeps one session without a recovery probe", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 0 });
  const selection = new KvvFeedSelection(feed());
  const original = await selection.searchStops("first");
  t.mock.timers.tick(TRIAS_RETRY_AFTER_MS);
  const next = await selection.searchStops("next");
  assert.equal(next.session, original.session);
  assert.equal(original.session.isCurrent, true);
});

test("reusing a provider payload never makes an old session current again", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 0 });
  const efa = feed();
  const trias = feed();
  const shared = await trias.searchStops("shared");
  trias.searchStops = async () => shared;
  const selection = new KvvFeedSelection(efa, trias);
  const original = await selection.searchStops("original");
  trias.searchStops = async () => {
    throw new TriasUnavailableError("denied", { accessDenied: true });
  };
  const fallback = await selection.searchStops("fallback");
  assert.equal(original.session.isCurrent, false);
  assert.throws(() => original.session.assertCurrent(), FeedChangedError);

  trias.searchStops = async () => shared;
  t.mock.timers.tick(TRIAS_RETRY_AFTER_MS);
  const recovered = await selection.searchStops("recovered");
  assert.equal(recovered.value, original.value);
  assert.equal(original.session.isCurrent, false);
  assert.equal(fallback.session.isCurrent, false);
  assert.equal(recovered.session.isCurrent, true);
});

test("a rate-limited recovery keeps the EFA session until Retry-After", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 0 });
  const trias = feed();
  trias.searchStops = async () => {
    throw new TriasUnavailableError("denied", { accessDenied: true });
  };
  const selection = new KvvFeedSelection(feed(), trias);
  const fallback = await selection.searchStops("fallback");
  t.mock.timers.tick(TRIAS_RETRY_AFTER_MS);
  const retryAt = Date.now() + 2 * TRIAS_RETRY_AFTER_MS;
  trias.searchStops = async () => {
    throw new TriasRateLimitError(retryAt);
  };
  const limited = await selection.searchStops("limited probe");
  assert.equal(limited.session, fallback.session);

  let probes = 0;
  trias.searchStops = async () => {
    probes += 1;
    return [];
  };
  t.mock.timers.tick(TRIAS_RETRY_AFTER_MS);
  const waiting = await selection.searchStops("waiting");
  assert.equal(waiting.session, fallback.session);
  assert.equal(probes, 0);
  t.mock.timers.tick(TRIAS_RETRY_AFTER_MS);
  const recovered = await selection.searchStops("recovered");
  assert.equal(probes, 1);
  assert.equal(fallback.session.isCurrent, false);
  assert.equal(recovered.session.isCurrent, true);
});
