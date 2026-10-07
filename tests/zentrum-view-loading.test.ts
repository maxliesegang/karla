import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { ComponentProps } from "react";
import "./support/render-hook.ts";
import "./support/register-tsx.ts";
import { transitSource } from "../src/data/transit-source.ts";
import type { DepartureBoard, RunDiscoveryReading } from "../src/data/transit-types.ts";
import { buildObservedNetworkFromTrips } from "../src/lib/observed-network.ts";
import { createDeparture } from "./support/fixtures.ts";

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { ZentrumView } = await import("../src/components/zentrum/ZentrumView.tsx");

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function setup(t: TestContext, { measureOnRender = true } = {}) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(HTMLElement.prototype, "animate", () => new Animation());
  const now = Date.parse("2026-10-06T10:00:00Z");
  t.mock.method(Date, "now", () => now);
  const resizeObservers: { callback: ResizeObserverCallback; observer: ResizeObserver }[] = [];
  const NativeResizeObserver = ResizeObserver;
  t.mock.method(globalThis, "ResizeObserver", function (callback: ResizeObserverCallback) {
    const observer = new NativeResizeObserver(callback);
    resizeObservers.push({ callback, observer });
    return observer;
  });
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  t.mock.method(window, "requestAnimationFrame", (callback: FrameRequestCallback) => {
    const id = ++frameId;
    frames.set(id, callback);
    return id;
  });
  t.mock.method(window, "cancelAnimationFrame", (id: number) => frames.delete(id));
  const measure = (width = 1_200) =>
    act(async () => {
      const entry: ResizeObserverEntry = {
        contentRect: new DOMRect(0, 0, width, 800),
        target: document.createElement("div"),
        borderBoxSize: [],
        contentBoxSize: [],
        devicePixelContentBoxSize: [],
      };
      for (const { callback, observer } of resizeObservers) callback([entry], observer);
    });
  const paint = () =>
    act(async () => {
      const callbacks = [...frames.values()];
      frames.clear();
      for (const callback of callbacks) callback(now);
    });
  const run = (id: string, lineId: string) =>
    createDeparture({
      id,
      tripId: id,
      lineId,
      scheduledDepartureTime: new Date(now + 60_000).toISOString(),
      readAt: { rowReadAt: now, sequenceReadAt: now },
      tripCalls: [
        {
          stopName: "Europaplatz",
          localStopId: "europaplatz",
          scheduledDepartureTime: new Date(now - 60_000).toISOString(),
        },
        {
          stopName: "Marktplatz",
          localStopId: "marktplatz",
          scheduledArrivalTime: new Date(now + 60_000).toISOString(),
          scheduledDepartureTime: new Date(now + 60_000).toISOString(),
        },
      ],
    });
  const first = run("first", "2");
  const second = run("second", "S1");
  const board: DepartureBoard = {
    stopId: "marktplatz",
    dataStatus: "live",
    receivedAt: now,
    feedUpdatedAt: new Date(now).toISOString(),
    departures: [first],
  };
  const discovery = deferred<RunDiscoveryReading>();
  t.mock.method(transitSource, "getRunDiscoveryReading", () => discovery.promise);
  t.mock.method(transitSource, "findRun", (id: string) =>
    [first, second].find((run) => run.id === id),
  );
  t.mock.method(transitSource, "getRun", async (id: string) =>
    [first, second].find((run) => run.id === id),
  );
  const container = document.createElement("div");
  const root = createRoot(container);
  let props: ComponentProps<typeof ZentrumView> = {
    network: buildObservedNetworkFromTrips([first]),
    coverage: { status: "complete" as const, expectedBoardCount: 1, liveBoardCount: 1 },
    departureBoards: [board],
    isFullscreen: false,
    isStacked: false,
    nearbyStops: { status: "idle" as const, stops: [], locate: () => {} },
  };
  return {
    container,
    discovery,
    first,
    second,
    board,
    render: async (changes: Partial<typeof props> = {}) => {
      props = { ...props, ...changes };
      await act(async () => root.render(createElement(ZentrumView, props)));
      if (measureOnRender) await measure();
    },
    reading: (runDepartures = [first, second]): RunDiscoveryReading => ({
      runDepartures,
      clockBoard: board,
      failedStopIds: [],
    }),
    unmount: () => act(async () => root.unmount()),
    advance: (ms: number) => act(async () => t.mock.timers.tick(ms)),
    measure,
    paint,
  };
}

test("lines appear first, then vehicles after discovery and the layout have settled", async (t) => {
  const view = setup(t);
  const { container, discovery } = view;
  try {
    await view.render();
    assert.ok(container.querySelector(".zentrum-schematic"));
    assert.ok(container.querySelector('[aria-label="Linie 2 verfolgen"]'));
    assert.equal(container.querySelectorAll(".zentrum-schematic-vehicle").length, 0);
    const loadingStatus = container.querySelector('.zentrum-loading[role="status"]');
    assert.ok(loadingStatus?.querySelector(".visually-hidden"));
    assert.ok(!container.querySelector('[role="progressbar"]'));
    assert.equal(
      container.querySelector(".zentrum-schematic-caption")?.textContent,
      "Fahrten werden ergänzt …",
    );
    await act(async () => discovery.resolve(view.reading()));
    await view.advance(1_499);
    assert.equal(container.querySelectorAll(".zentrum-schematic-vehicle").length, 0);
    await view.advance(1);
    assert.equal(container.querySelectorAll(".zentrum-schematic-vehicle").length, 0);
    await view.paint();
    assert.equal(container.querySelectorAll(".zentrum-schematic-vehicle").length, 0);
    await view.paint();
    assert.ok(container.querySelector(".zentrum-schematic"));
    assert.equal(container.querySelectorAll(".zentrum-schematic-vehicle").length, 2);
    assert.ok(container.querySelector('[aria-label="Linie S1 verfolgen"]'));
    assert.ok(container.querySelector('[aria-label="Linie 2 verfolgen"]'));
    assert.ok(!container.querySelector(".zentrum-loading"));
    assert.doesNotMatch(
      container.querySelector(".zentrum-schematic-caption")?.textContent ?? "",
      /werden/,
    );
  } finally {
    await view.unmount();
  }
});

test("discovery answering first still waits for the observation boards", async (t) => {
  const view = setup(t);
  try {
    await view.render({
      coverage: { status: "loading", expectedBoardCount: 1, liveBoardCount: 0 },
      departureBoards: [],
    });
    await act(async () => view.discovery.resolve(view.reading()));
    assert.ok(view.container.querySelector(".zentrum-schematic"));
    assert.equal(view.container.querySelectorAll(".zentrum-schematic-vehicle").length, 0);
    assert.match(view.container.textContent, /werden geladen/);
    await view.render({
      coverage: { status: "complete", expectedBoardCount: 1, liveBoardCount: 1 },
      departureBoards: [view.board],
    });
    await view.advance(1_500);
    await view.paint();
    await view.paint();
    assert.equal(view.container.querySelectorAll(".zentrum-schematic-vehicle").length, 2);
  } finally {
    await view.unmount();
  }
});

test("the initial plan also waits for the supplemental terminus reading", async (t) => {
  const view = setup(t);
  const extra = deferred<RunDiscoveryReading>();
  let readingCount = 0;
  const requests = t.mock.method(transitSource, "getRunDiscoveryReading", () =>
    readingCount++ === 0 ? view.discovery.promise : extra.promise,
  );
  const terminal = {
    ...view.second,
    tripCalls: view.second.tripCalls?.map((call, index) =>
      index === 1 ? { ...call, scheduledDepartureTime: undefined } : call,
    ),
  };
  try {
    await view.render();
    await act(async () => view.discovery.resolve(view.reading([terminal])));
    assert.equal(requests.mock.callCount(), 2);
    assert.equal(view.container.querySelectorAll(".zentrum-schematic-vehicle").length, 0);
    assert.ok(view.container.querySelector(".zentrum-loading"));
    await act(async () => extra.resolve(view.reading([view.first])));
    await view.advance(1_500);
    await view.paint();
    await view.paint();
    assert.equal(view.container.querySelectorAll(".zentrum-schematic-vehicle").length, 2);
  } finally {
    await view.unmount();
  }
});

test("later layout changes keep the vehicles visible without reopening the loader", async (t) => {
  const view = setup(t);
  try {
    await view.render();
    await act(async () => view.discovery.resolve(view.reading()));
    await view.advance(1_500);
    await view.paint();
    await view.paint();
    const third = { ...view.first, id: "third", tripId: "third", lineId: "5" };
    await view.render({ departureBoards: [{ ...view.board, departures: [view.first, third] }] });
    assert.ok(view.container.querySelectorAll(".zentrum-schematic-vehicle").length > 0);
    assert.ok(!view.container.querySelector(".zentrum-loading"));
  } finally {
    await view.unmount();
  }
});

test("a failed discovery read settles loading and keeps the available board", async (t) => {
  const view = setup(t);
  try {
    await view.render();
    await act(async () => view.discovery.reject(new Error("offline")));
    await view.paint();
    await view.paint();
    const schematic = view.container.querySelector(".zentrum-schematic");
    assert.ok(schematic);
    assert.equal(view.container.querySelectorAll(".zentrum-schematic-vehicle").length, 1);
    await view.render({
      coverage: { status: "partial", expectedBoardCount: 2, liveBoardCount: 1 },
    });
    assert.ok(view.container.querySelector(".zentrum-schematic") === schematic);
  } finally {
    await view.unmount();
  }
});

test("vehicles wait for the first measurement and a resize restarts the pending paint", async (t) => {
  const view = setup(t, { measureOnRender: false });
  try {
    await view.render();
    await act(async () => view.discovery.resolve(view.reading()));
    await view.advance(1_500);
    await view.paint();
    await view.paint();
    assert.equal(view.container.querySelectorAll(".zentrum-schematic-vehicle").length, 0);
    await view.measure();
    await view.paint();
    await view.measure(700);
    await view.paint();
    assert.equal(view.container.querySelectorAll(".zentrum-schematic-vehicle").length, 0);
    await view.paint();
    assert.equal(view.container.querySelectorAll(".zentrum-schematic-vehicle").length, 2);
    assert.ok(!view.container.querySelector(".zentrum-loading"));
  } finally {
    await view.unmount();
  }
});

test("the map frame stays mounted as the first observation arrives", async (t) => {
  const view = setup(t);
  try {
    await view.render({
      network: buildObservedNetworkFromTrips([]),
      coverage: { status: "loading", expectedBoardCount: 1, liveBoardCount: 0 },
      departureBoards: [],
    });
    const frame = view.container.querySelector(".zentrum-schematic");
    assert.ok(frame);
    assert.ok(frame.querySelector(".zentrum-loading"));
    assert.equal(
      frame.querySelector(".zentrum-schematic-caption")?.textContent,
      "Linien werden aufgebaut …",
    );
    await view.render({
      network: buildObservedNetworkFromTrips([view.first]),
      coverage: { status: "complete", expectedBoardCount: 1, liveBoardCount: 1 },
      departureBoards: [view.board],
    });
    await act(async () => view.discovery.resolve(view.reading()));
    await view.advance(1_500);
    await view.paint();
    await view.paint();
    assert.ok(view.container.querySelector(".zentrum-schematic") === frame);
    assert.equal(frame.querySelectorAll(".zentrum-schematic-vehicle").length, 2);
    assert.equal(frame.getAttribute("aria-busy"), "false");
  } finally {
    await view.unmount();
  }
});
