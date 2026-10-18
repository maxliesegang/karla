import assert from "node:assert/strict";
import test from "node:test";
import { KvvFeedSelection, TRIAS_RETRY_AFTER_MS } from "../src/data/kvv-feed-selection.ts";
import type { KvvDepartureBoard, KvvFeed } from "../src/data/kvv-feed.ts";
import { KvvTriasClient } from "../src/data/kvv-trias-client.ts";
import {
  FeedChangedError,
  TriasRateLimitError,
  TriasUnavailableError,
} from "../src/data/kvv-feed-errors.ts";
import { triasStopEvent, triasStopEvents, triasTripInfo } from "./support/trias.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const RESPONDED_AT = "2026-10-17T21:01:46Z";

const stopEventsReply = (ref: string) =>
  triasStopEvents(RESPONDED_AT, [
    triasStopEvent({
      current: {
        ref,
        name: "KA Europaplatz",
        bay: "Gleis 3",
        departure: { scheduled: "2026-10-17T21:05:00Z" },
      },
    }),
  ]);

/** A proxy answering from `reply`, recording every request. */
function createProxy(reply: (url: URL) => Response | Promise<Response>) {
  const requests: URL[] = [];
  const fetchFn = (async (input: URL | RequestInfo) => {
    const url = new URL(String(input));
    requests.push(url);
    return reply(url);
  }) as typeof fetch;
  return { fetchFn, requests };
}

/** EFA as far as the TRIAS client asks it: serving lines from a one-row board. */
function createEfa() {
  const boardRequests: string[] = [];
  const efa = {
    fetchDepartureBoard: async (stopPointId: string): Promise<KvvDepartureBoard> => {
      boardRequests.push(stopPointId);
      return {
        stopPointId,
        stopName: "Europaplatz",
        serverTime: RESPONDED_AT,
        servingLines: [
          { lineId: "S5", directionId: "kvv:22305:E:R:s26", transportMode: "lightRail" },
        ],
        departures: [],
      };
    },
  } as unknown as KvvFeed;
  return { efa, boardRequests };
}

const xml = (body: string, headers: Record<string, string> = {}) =>
  new Response(body, { headers: { "Content-Type": "application/xml", ...headers } });

test("a complex's board joins each of its stops, with serving lines read once from EFA", async () => {
  const proxy = createProxy((url) => {
    const stop = url.searchParams.get("stop");
    return xml(stopEventsReply(stop === "7001004" ? "de:08212:1004:1:1" : "de:08212:37:3:3"));
  });
  const { efa, boardRequests } = createEfa();
  const client = new KvvTriasClient({
    proxyUrl: "https://proxy.test/api/",
    efa,
    fetchFn: proxy.fetchFn,
  });

  const board = await client.fetchDepartureBoard("7000037", { includeTripCalls: true, limit: 40 });
  await client.fetchDepartureBoard("7000037");

  assert.deepEqual(
    proxy.requests
      .slice(0, 2)
      .map((url) => [
        url.pathname,
        url.searchParams.get("stop"),
        url.searchParams.get("calls"),
        url.searchParams.get("rows"),
      ]),
    [
      ["/api/stop-events.php", "7000037", "1", "40"],
      ["/api/stop-events.php", "7001004", "1", "40"],
    ],
  );
  assert.deepEqual(
    board.departures.map(({ stopPointId }) => stopPointId),
    ["7000037", "7001004"],
  );
  assert.deepEqual(
    board.servingLines.map(({ directionId }) => directionId),
    ["kvv:22305:E:R:s26"],
  );
  assert.deepEqual(boardRequests, ["7000037"]);
});

test("a filtered board asks for its lines, in groups the proxy accepts, and no serving lines", async () => {
  const proxy = createProxy(() => xml(stopEventsReply("de:08212:39:1:1")));
  const { efa, boardRequests } = createEfa();
  const client = new KvvTriasClient({
    proxyUrl: "https://proxy.test/api/",
    efa,
    fetchFn: proxy.fetchFn,
  });
  const lineIds = Array.from({ length: 17 }, (_, index) => `kvv:2100${index}:E:H:s26`);

  const board = await client.fetchDepartureBoard("7000039", { lineIds, eventKind: "arrival" });

  assert.deepEqual(
    proxy.requests.map((url) => [
      url.searchParams.get("lines")?.split(",").length,
      url.searchParams.get("kind"),
    ]),
    [
      [16, "arrival"],
      [1, "arrival"],
    ],
  );
  assert.deepEqual(board.servingLines, []);
  assert.deepEqual(boardRequests, []);
});

test("a reply held in the proxy's cache advances the feed clock by its age", async () => {
  const proxy = createProxy(() => xml(stopEventsReply("de:08212:39:1:1"), { Age: "12" }));
  const client = new KvvTriasClient({
    proxyUrl: "https://proxy.test/api/",
    efa: createEfa().efa,
    fetchFn: proxy.fetchFn,
  });
  const board = await client.fetchDepartureBoard("7000039", { lineIds: ["kvv:21002:E:H:s26"] });
  assert.equal(board.serverTime, "2026-10-17T21:01:58.000Z");
});

test("a trip is asked for by journey and operating day, or the calendar day without one", async () => {
  const proxy = createProxy(() =>
    xml(
      triasTripInfo(RESPONDED_AT, {
        previous: [
          {
            ref: "de:08212:39:1:1",
            name: "KA Mühlburger Tor",
            departure: { scheduled: "2026-10-17T21:05:00Z" },
          },
        ],
      }),
    ),
  );
  const client = new KvvTriasClient({
    proxyUrl: "https://proxy.test/api/",
    efa: createEfa().efa,
    fetchFn: proxy.fetchFn,
  });
  const locator = {
    line: "kvv:22305:E:R:s26",
    tripCode: "1762",
    stopPointId: "7000039",
    date: "20261018",
    time: "0005",
  };

  await client.fetchTrip({ ...locator, operatingDay: "2026-10-17" });
  await client.fetchTrip(locator);

  assert.deepEqual(
    proxy.requests.map((url) => [
      url.pathname,
      url.searchParams.get("journey"),
      url.searchParams.get("day"),
    ]),
    [
      ["/api/trip-info.php", "kvv:22305:E:R:s26:1762", "2026-10-17"],
      ["/api/trip-info.php", "kvv:22305:E:R:s26:1762", "2026-10-18"],
    ],
  );
});

test("an unreachable or failing proxy is unavailable, not a provider answer", async () => {
  const efa = createEfa().efa;
  const down = new KvvTriasClient({
    proxyUrl: "https://proxy.test/api/",
    efa,
    fetchFn: (async () => {
      throw new TypeError("Failed to fetch");
    }) as typeof fetch,
  });
  const failing = new KvvTriasClient({
    proxyUrl: "https://proxy.test/api/",
    efa,
    fetchFn: createProxy(() => new Response("{}", { status: 502 })).fetchFn,
  });
  await assert.rejects(down.searchStops("Europaplatz"), TriasUnavailableError);
  await assert.rejects(failing.searchStops("Europaplatz"), TriasUnavailableError);
});

/** A feed whose searches answer its name, or fail as told. */
function createFeed(name: string, failure?: () => Error) {
  const calls: string[] = [];
  const feed = {
    searchStops: async (query: string) => {
      calls.push(query);
      if (failure) throw failure();
      return [{ providerId: name, name }];
    },
  } as unknown as KvvFeed;
  return { feed, calls };
}

test("the fallback serves every read for a while once the primary is unavailable", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 0 });
  let primaryDown = true;
  const primaryCalls: string[] = [];
  const primary = {
    searchStops: async (query: string) => {
      primaryCalls.push(query);
      if (primaryDown) throw new TriasUnavailableError("down");
      return [{ providerId: "trias", name: "trias" }];
    },
  } as unknown as KvvFeed;
  const fallback = createFeed("efa");
  const feed = new KvvFeedSelection(fallback.feed, primary);

  await assert.rejects(feed.searchStops("first failure"), TriasUnavailableError);
  assert.equal((await feed.searchStops("a")).value[0].name, "efa");
  primaryDown = false;
  assert.equal((await feed.searchStops("b")).value[0].name, "efa");
  assert.deepEqual(primaryCalls, ["first failure", "a"]);

  t.mock.timers.tick(TRIAS_RETRY_AFTER_MS);
  assert.equal((await feed.searchStops("c")).value[0].name, "trias");
});

test("a provider's own failure is reported, not hidden behind the fallback", async () => {
  const primary = createFeed("trias", () => new Error("nicht gefunden"));
  const fallback = createFeed("efa");
  const feed = new KvvFeedSelection(fallback.feed, primary.feed);

  await assert.rejects(feed.searchStops("a"), /nicht gefunden/);
  assert.deepEqual(fallback.calls, []);
});

test("request errors stay local; access denial immediately selects EFA", async () => {
  for (const status of [400, 404, 401, 403]) {
    const client = new KvvTriasClient({
      proxyUrl: "https://proxy.test/api/",
      efa: createEfa().efa,
      fetchFn: createProxy(() => new Response("", { status })).fetchFn,
    });
    const fallback = createFeed("efa");
    const feed = new KvvFeedSelection(fallback.feed, client);
    const initialSession = feed.session;
    if (status === 401 || status === 403) {
      assert.equal((await feed.searchStops("a")).value[0].name, "efa");
      assert.equal(initialSession.isCurrent, false);
    } else {
      await assert.rejects(feed.searchStops("a"));
      await assert.rejects(feed.searchStops("b"));
      assert.equal(feed.session, initialSession);
      assert.deepEqual(fallback.calls, []);
    }
  }
});

test("reading a broken response body counts as an availability failure", async () => {
  const client = new KvvTriasClient({
    proxyUrl: "https://proxy.test/api/",
    efa: createEfa().efa,
    fetchFn: createProxy(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new TypeError("connection closed"));
            },
          }),
        ),
    ).fetchFn,
  });
  await assert.rejects(client.searchStops("a"), TriasUnavailableError);
});

test("TRIAS honors numeric and dated Retry-After without switching feeds", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 0 });
  const retries: Record<string, string>[] = [
    { "Retry-After": "120" },
    { "Retry-After": "Sat, 17 Oct 2026 21:03:46 GMT", Date: "Sat, 17 Oct 2026 21:01:46 GMT" },
  ];
  for (const headers of retries) {
    const proxy = createProxy(() => new Response("", { status: 429, headers }));
    const client = new KvvTriasClient({
      proxyUrl: "https://proxy.test/api/",
      efa: createEfa().efa,
      fetchFn: proxy.fetchFn,
    });
    const fallback = createFeed("efa");
    const feed = new KvvFeedSelection(fallback.feed, client);
    const initialSession = feed.session;
    await assert.rejects(feed.searchStops("a"), TriasRateLimitError);
    await assert.rejects(feed.searchStops("b"), TriasRateLimitError);
    assert.equal(proxy.requests.length, 1);
    assert.equal(feed.session, initialSession);
    assert.deepEqual(fallback.calls, []);
    t.mock.timers.tick(120_000);
    await assert.rejects(feed.searchStops("c"), TriasRateLimitError);
    assert.equal(proxy.requests.length, 2);
  }
});

test("a successful primary read resets consecutive failures", async () => {
  let fail = true;
  const primary = {
    searchStops: async () => {
      if (fail) throw new TriasUnavailableError("down");
      return [];
    },
  } as unknown as KvvFeed;
  const fallback = createFeed("efa");
  const feed = new KvvFeedSelection(fallback.feed, primary);
  await assert.rejects(feed.searchStops("a"), TriasUnavailableError);
  fail = false;
  await feed.searchStops("b");
  fail = true;
  await assert.rejects(feed.searchStops("c"), TriasUnavailableError);
  assert.deepEqual(fallback.calls, []);
});

test("late primary responses cannot publish after fallback", async () => {
  const pending = deferred<Awaited<ReturnType<KvvFeed["searchStops"]>>>();
  const primary = {
    searchStops: async (query: string) => {
      if (query === "slow") return pending.promise;
      throw new TriasUnavailableError("down");
    },
  } as unknown as KvvFeed;
  const feed = new KvvFeedSelection(createFeed("efa").feed, primary);
  const slow = feed.searchStops("slow");
  await assert.rejects(feed.searchStops("a"), TriasUnavailableError);
  const reading = await feed.searchStops("b");
  assert.equal(reading.value[0].name, "efa");
  pending.resolve([{ providerId: "trias", name: "trias" }]);
  await assert.rejects(slow, FeedChangedError);
  assert.equal(reading.session.isCurrent, true);
});

test("one recovery probe runs on demand while concurrent reads stay on EFA", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 0 });
  const pending = deferred<Awaited<ReturnType<KvvFeed["searchStops"]>>>();
  let down = true;
  const calls: string[] = [];
  const primary = {
    searchStops: async (query: string) => {
      calls.push(query);
      if (down) throw new TriasUnavailableError("down");
      return pending.promise;
    },
  } as unknown as KvvFeed;
  const fallback = createFeed("efa");
  const feed = new KvvFeedSelection(fallback.feed, primary);
  await assert.rejects(feed.searchStops("a"));
  const old = await feed.searchStops("b");
  down = false;
  t.mock.timers.tick(TRIAS_RETRY_AFTER_MS);
  assert.deepEqual(calls, ["a", "b"]);
  const recovery = feed.searchStops("probe");
  assert.equal((await feed.searchStops("concurrent")).value[0].name, "efa");
  assert.deepEqual(calls, ["a", "b", "probe"]);
  pending.resolve([{ providerId: "trias", name: "trias" }]);
  const fresh = await recovery;
  assert.equal(old.session.isCurrent, false);
  assert.equal(fresh.session.isCurrent, true);
});

test("a complex's parallel failures count as one failed logical read", async () => {
  const proxy = createProxy(() => new Response("", { status: 502 }));
  const client = new KvvTriasClient({
    proxyUrl: "https://proxy.test/api/",
    efa: createEfa().efa,
    fetchFn: proxy.fetchFn,
  });
  const fallback = createEfa();
  const feed = new KvvFeedSelection(fallback.efa, client);
  await assert.rejects(feed.fetchDepartureBoard("7000037"), TriasUnavailableError);
  assert.deepEqual(fallback.boardRequests, []);
  await feed.fetchDepartureBoard("7000037");
  assert.deepEqual(fallback.boardRequests, ["7000037"]);
});

test("EFA-only reads never reset TRIAS health", async () => {
  const primary = createFeed("trias", () => new TriasUnavailableError("down"));
  const fallback = createFeed("efa");
  fallback.feed.fetchServiceNotices = async () => [];
  fallback.feed.fetchLineRoute = async () => [];
  const feed = new KvvFeedSelection(fallback.feed, primary.feed);
  await assert.rejects(feed.searchStops("a"));
  await feed.fetchServiceNotices();
  await feed.fetchLineRoute({
    line: "line",
    tripCode: "trip",
    stopPointId: "stop",
    date: "20261017",
    time: "2300",
  });
  assert.equal((await feed.searchStops("b")).value[0].name, "efa");
});

test("a late EFA response cannot publish after TRIAS recovers", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 0 });
  let down = true;
  const primary = {
    searchStops: async () => {
      if (down) throw new TriasUnavailableError("down");
      return [];
    },
  } as unknown as KvvFeed;
  const fallback = createFeed("efa");
  const feed = new KvvFeedSelection(fallback.feed, primary);
  await assert.rejects(feed.searchStops("a"));
  await feed.searchStops("b");
  const pending = deferred<Awaited<ReturnType<KvvFeed["searchStops"]>>>();
  fallback.feed.searchStops = () => pending.promise;
  const late = feed.searchStops("late");
  down = false;
  t.mock.timers.tick(TRIAS_RETRY_AFTER_MS);
  await feed.searchStops("probe");
  pending.resolve([]);
  await assert.rejects(late, FeedChangedError);
});
