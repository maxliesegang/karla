import assert from "node:assert/strict";
import test from "node:test";
import { KvvFeedSelection, TRIAS_RETRY_AFTER_MS } from "../src/data/kvv-feed-selection.ts";
import { TriasUnavailableError } from "../src/data/kvv-feed-errors.ts";
import type { KvvDeparture, KvvDepartureBoard, KvvFeed, KvvTrip } from "../src/data/kvv-feed.ts";
import { KvvTransitSource } from "../src/data/transit-source.ts";

const NOW = Date.parse("2026-10-17T21:00:00Z");
const locator = {
  line: "kvv:22305:E:R:s26",
  tripCode: "1762",
  stopPointId: "7000039",
  date: "20261017",
  time: "2305",
};
const row: KvvDeparture = {
  stopPointId: "7000039",
  stopPointName: "Mühlburger Tor",
  tripId: `${locator.line}:${locator.tripCode}`,
  tripLocator: locator,
  lineId: "S5",
  routeDirectionId: locator.line,
  transportMode: "lightRail",
  destination: "Pforzheim",
  minutesUntilDeparture: 5,
  platformCode: "1",
  status: "realtime",
  scheduledDepartureTime: "2026-10-17T21:05:00Z",
};

function board(provider: string, departures: KvvDeparture[] = [row]): KvvDepartureBoard {
  return {
    stopPointId: "7000039",
    stopName: "Mühlburger Tor",
    serverTime: new Date(NOW).toISOString(),
    servingLines: [{ lineId: "S5", directionId: locator.line }],
    departures: departures.map((departure) => ({ ...departure, destination: provider })),
  };
}

function trip(provider: string): KvvTrip {
  return {
    serverTime: new Date(NOW).toISOString(),
    tripCalls: [
      {
        stopName: provider,
        providerId: "7000039",
        scheduledDepartureTime: row.scheduledDepartureTime,
      },
      {
        stopName: `${provider} end`,
        providerId: "7001003",
        scheduledArrivalTime: "2026-10-17T21:20:00Z",
      },
    ],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function feeds() {
  let down = false;
  const primary: KvvFeed = {
    fetchDepartureBoard: async () => {
      if (down) throw new TriasUnavailableError("down");
      return board("trias");
    },
    fetchTrip: async () => trip("trias"),
    searchStops: async () => {
      throw new TriasUnavailableError("down");
    },
    fetchLineRoute: async () => [],
    fetchServiceNotices: async () => [],
  };
  const fallback: KvvFeed = {
    ...primary,
    fetchDepartureBoard: async () => board("efa"),
    fetchTrip: async () => trip("efa"),
    searchStops: async () => [],
  };
  const feed = new KvvFeedSelection(fallback, primary);
  const source = new KvvTransitSource(feed);
  return {
    primary,
    fallback,
    feed,
    source,
    fail: () => {
      down = true;
    },
  };
}

test("a board pending during startup fallback completes from the active feed", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  const { primary, feed, source } = feeds();
  const pending = deferred<KvvDepartureBoard>();
  primary.fetchDepartureBoard = () => pending.promise;
  const loading = source.getDepartureBoard("durlacher-tor");
  await assert.rejects(feed.searchStops("first failed read"));
  await feed.searchStops("second failed read");
  pending.resolve(board("old primary"));
  const result = await loading;
  assert.equal(
    result.dataStatus,
    "live",
    result.dataStatus === "unavailable" ? result.errorMessage : "",
  );
  assert.equal(result.departures[0].destination, "efa");
});

test("a switch replaces cached run sequences without merging providers; retained boards stay dated", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  const { feed, source, fail, primary } = feeds();
  const original = await source.getDepartureBoard("muehlburger-tor");
  const rowId = original.departures[0].id;
  assert.equal((await source.getRun(rowId))?.tripCalls?.[0].stopName, "trias");
  fail();
  t.mock.timers.tick(1_000);
  const retained = await source.getDepartureBoard("muehlburger-tor", { maxAgeMs: 0 });
  assert.equal(retained.dataStatus, "live");
  assert.equal(retained.departures[0].destination, "trias");
  assert.equal(retained.receivedAt, original.receivedAt);
  assert.equal(retained.refreshFailedAt, NOW + 1_000);
  const switched = await source.getDepartureBoard("muehlburger-tor", { maxAgeMs: 0 });
  assert.equal(switched.departures[0].destination, "efa");
  assert.equal(source.findRun(rowId)?.tripCalls, undefined);
  assert.equal((await source.getRun(rowId))?.tripCalls?.[0].stopName, "efa");
  assert.equal(source.resolveBoard(original).departures[0].destination, "trias");
  assert.equal(source.resolveBoard(original).departures[0].tripCalls, undefined);

  t.mock.timers.tick(TRIAS_RETRY_AFTER_MS - 1_000);
  await source.getDepartureBoard("muehlburger-tor", { maxAgeMs: 0 });
  t.mock.timers.tick(1_000);
  primary.searchStops = async () => [];
  primary.fetchDepartureBoard = async () => board("recovered");
  await feed.searchStops("probe");
  const recovered = await source.getDepartureBoard("muehlburger-tor", { maxAgeMs: 600_000 });
  assert.equal(recovered.departures[0].destination, "recovered");
  assert.equal(source.findRun(rowId)?.tripCalls, undefined);
});

test("a late board cannot write rows or teach topology after another read switches providers", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  const { primary, feed, source } = feeds();
  const pending = deferred<KvvDepartureBoard>();
  primary.fetchDepartureBoard = () => pending.promise;
  const late = source.getDepartureBoard("muehlburger-tor");
  await assert.rejects(feed.searchStops("fail once"));
  await feed.searchStops("fail twice");
  const current = await source.getDepartureBoard("muehlburger-tor");
  assert.equal(current.departures[0].destination, "efa");
  pending.resolve(board("late", [{ ...row, tripCalls: trip("late").tripCalls }]));
  const result = await late;
  assert.equal(result.dataStatus, "live");
  assert.equal(result.departures[0].destination, "efa");
  assert.equal(result.refreshFailedAt, undefined);
  assert.equal(source.findRun(current.departures[0].id)?.destination, "efa");
  assert.equal(source.getObservedNetwork().tripCount, 0);
});

test("a trip requested before a switch cannot attach to a replacement run record", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  const { primary, feed, source } = feeds();
  const original = await source.getDepartureBoard("muehlburger-tor");
  const rowId = original.departures[0].id;
  const pending = deferred<KvvTrip>();
  primary.fetchTrip = () => pending.promise;
  const late = source.getRun(rowId);
  await assert.rejects(feed.searchStops("fail once"));
  await feed.searchStops("fail twice");
  await source.getDepartureBoard("muehlburger-tor");
  await source.getRun(rowId);
  pending.resolve(trip("late"));
  assert.equal(await late, undefined);
  assert.equal(source.findRun(rowId)?.tripCalls?.[0].stopName, "efa");
});

test("direction supplements cannot combine a TRIAS base with EFA rows", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  const { primary, fallback, source } = feeds();
  primary.fetchDepartureBoard = async (_stop, options) => {
    if (options?.lineIds?.length) throw new TriasUnavailableError("denied", { accessDenied: true });
    return board("trias", []);
  };
  fallback.fetchDepartureBoard = async () => board("efa");
  const mixed = await source.getDepartureBoard("muehlburger-tor", {
    minimumDeparturesPerDirection: 1,
  });
  assert.equal(mixed.dataStatus, "live");
  assert.equal(mixed.refreshFailedAt, NOW);
  assert.deepEqual(mixed.departures, []);
  assert.equal(source.findRun("unused"), undefined);
  const recovered = await source.getDepartureBoard("muehlburger-tor", {
    minimumDeparturesPerDirection: 1,
  });
  assert.equal(recovered.departures[0].destination, "efa");
});

test("failed fallback retains the dated board without keeping the old run active", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  const { source, fail, fallback } = feeds();
  const original = await source.getDepartureBoard("muehlburger-tor");
  const rowId = original.departures[0].id;
  await source.getRun(rowId);
  fail();
  fallback.fetchDepartureBoard = async () => {
    throw new Error("EFA unavailable");
  };

  t.mock.timers.tick(1_000);
  await source.getDepartureBoard("muehlburger-tor", { maxAgeMs: 0 });
  const retained = await source.getDepartureBoard("muehlburger-tor", { maxAgeMs: 0 });
  assert.equal(retained.dataStatus, "live");
  assert.equal(retained.receivedAt, original.receivedAt);
  assert.equal(retained.refreshFailedAt, NOW + 1_000);
  assert.equal(source.findRun(rowId), undefined);
  assert.equal(source.resolveBoard(retained), retained);

  fallback.fetchDepartureBoard = async () => board("efa");
  const recovered = await source.getDepartureBoard("muehlburger-tor");
  assert.equal(recovered.dataStatus, "live");
  assert.equal(recovered.departures[0].destination, "efa");
  assert.equal(recovered.refreshFailedAt, undefined);
  assert.equal((await source.getRun(rowId))?.tripCalls?.[0].stopName, "efa");
});

test("retention keeps the last complete board when a replacement session fails", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  const { source, fail, fallback } = feeds();
  const original = await source.getDepartureBoard("muehlburger-tor");
  fail();
  fallback.fetchDepartureBoard = async () => {
    throw new Error("EFA unavailable");
  };
  await source.getDepartureBoard("muehlburger-tor", { maxAgeMs: 0 });
  await source.getDepartureBoard("muehlburger-tor", { maxAgeMs: 0 });

  t.mock.timers.tick(10 * 60_000);
  const retained = await source.getDepartureBoard("muehlburger-tor", { maxAgeMs: 0 });
  assert.equal(retained.receivedAt, original.receivedAt);
  t.mock.timers.tick(1);
  const expired = await source.getDepartureBoard("muehlburger-tor", { maxAgeMs: 0 });
  assert.equal(expired.dataStatus, "unavailable");
  assert.deepEqual(expired.departures, []);
});
