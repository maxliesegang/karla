import assert from "node:assert/strict";
import test from "node:test";
import { KvvTriasClient } from "../src/data/kvv-trias-client.ts";
import { KvvTriasError } from "../src/data/kvv-trias-parsers.ts";
import { triasStopEvent, triasStopEvents, triasTripInfo } from "./support/trias.ts";

const RESPONDED_AT = "2026-10-17T21:01:46Z";

const stopEventsReply = (ref: string) =>
  triasStopEvents(RESPONDED_AT, [
    triasStopEvent({
      current: {
        ref,
        name: "KA Europaplatz",
        bay: "Gleis 3",
        departure: { timetabled: "2026-10-17T21:05:00Z" },
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

const createClient = (fetchFn: typeof fetch) =>
  new KvvTriasClient({ proxyUrl: "https://proxy.test/api/", fetchFn });

const xml = (body: string, headers: Record<string, string> = {}) =>
  new Response(body, { headers: { "Content-Type": "application/xml", ...headers } });

test("a complex's board joins each of its stops and states no serving lines", async () => {
  const proxy = createProxy((url) => {
    const stop = url.searchParams.get("stop");
    return xml(stopEventsReply(stop === "7001004" ? "de:08212:1004:1:1" : "de:08212:37:3:3"));
  });
  const client = createClient(proxy.fetchFn);

  const board = await client.fetchStopEventBoard("7000037", { includeCalls: true, limit: 40 });

  assert.deepEqual(
    proxy.requests.map((url) => [
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
    board.stopEvents.map(({ stopPointId }) => stopPointId),
    ["7000037", "7001004"],
  );
  assert.deepEqual(board.servingLines, []);
});

test("a filtered board asks for its lines, in groups the proxy accepts", async () => {
  const proxy = createProxy(() => xml(stopEventsReply("de:08212:39:1:1")));
  const client = createClient(proxy.fetchFn);
  const lineIds = Array.from({ length: 17 }, (_, index) => `kvv:2100${index}:E:H:s26`);

  await client.fetchStopEventBoard("7000039", { lineIds, eventKind: "arrival" });

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
});

test("a reply held in the proxy's cache advances the feed clock by its age", async () => {
  const proxy = createProxy(() => xml(stopEventsReply("de:08212:39:1:1"), { Age: "12" }));
  const client = createClient(proxy.fetchFn);
  const board = await client.fetchStopEventBoard("7000039", { lineIds: ["kvv:21002:E:H:s26"] });
  assert.equal(board.serverTime, "2026-10-17T21:01:58.000Z");
});

const journeyReply = () =>
  xml(
    triasTripInfo(RESPONDED_AT, {
      previous: [
        {
          ref: "de:08212:39:1:1",
          name: "KA Mühlburger Tor",
          departure: { timetabled: "2026-10-17T21:05:00Z" },
        },
      ],
      onward: [
        {
          ref: "de:08212:37:3:3",
          name: "KA Europaplatz",
          arrival: { timetabled: "2026-10-17T21:07:00Z" },
        },
      ],
    }),
  );

const LOCATOR = {
  lineRef: "kvv:22305:E:R:s26",
  journeyCode: "1762",
  stopPointId: "7000039",
  date: "20261018",
  time: "0005",
};

test("a trip is asked for by journey and operating day, or the calendar day without one", async () => {
  const proxy = createProxy(journeyReply);
  const client = createClient(proxy.fetchFn);

  await client.fetchTripInfo({ ...LOCATOR, operatingDayRef: "2026-10-17" });
  await client.fetchTripInfo(LOCATOR);

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

test("a line route is the calls of the run it is addressed through", async () => {
  const client = createClient(createProxy(journeyReply).fetchFn);
  const route = await client.fetchLineRoute(LOCATOR);
  assert.deepEqual(
    route.map(({ providerId }) => providerId),
    ["7000039", "7000037"],
  );
});

test("an unreachable or failing proxy rejects with a TRIAS error", async () => {
  const down = createClient((async () => {
    throw new TypeError("Failed to fetch");
  }) as typeof fetch);
  await assert.rejects(down.searchStops("Europaplatz"), KvvTriasError);
  for (const status of [400, 403, 502]) {
    const failing = createClient(createProxy(() => new Response("{}", { status })).fetchFn);
    await assert.rejects(failing.searchStops("Europaplatz"), new RegExp(`HTTP ${status}`));
  }
});

test("a broken response body is a failed read", async () => {
  const client = createClient(
    createProxy(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new TypeError("connection closed"));
            },
          }),
        ),
    ).fetchFn,
  );
  await assert.rejects(client.searchStops("a"), KvvTriasError);
});

test("a rate-limited client stops asking until numeric or dated Retry-After", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 0 });
  const retries: Record<string, string>[] = [
    { "Retry-After": "120" },
    { "Retry-After": "Sat, 17 Oct 2026 21:03:46 GMT", Date: "Sat, 17 Oct 2026 21:01:46 GMT" },
  ];
  for (const headers of retries) {
    const proxy = createProxy(() => new Response("", { status: 429, headers }));
    const client = createClient(proxy.fetchFn);
    await assert.rejects(client.searchStops("a"), /Anfragelimit/);
    await assert.rejects(client.searchStops("b"), /Anfragelimit/);
    assert.equal(proxy.requests.length, 1);
    t.mock.timers.tick(120_000);
    await assert.rejects(client.searchStops("c"), /Anfragelimit/);
    assert.equal(proxy.requests.length, 2);
  }
});
