import assert from "node:assert/strict";
import test from "node:test";
import type { ComponentProps } from "react";
import "./support/render-hook.ts";
import "./support/register-tsx.ts";
import type { DepartureBoard } from "../src/data/transit-types.ts";
import { createZentrumLineSignReader } from "../src/components/zentrum/line-sign.ts";
import { getZentrumStopView } from "../src/lib/zentrum-stop-view.ts";
import { getZentrumDirectRides } from "../src/lib/zentrum-schematic-overlays.ts";
import { buildZentrumSchematicReading } from "../src/lib/zentrum-schematic.ts";
import { zentrumStopPanelState } from "../src/lib/zentrum-panel.ts";
import { routePaths } from "../src/routing.ts";
import { createDeparture } from "./support/fixtures.ts";

const { act, createElement, useState } = await import("react");
const { createRoot } = await import("react-dom/client");
const { ZentrumStopPanel } = await import("../src/components/zentrum/ZentrumStopPanel.tsx");
const { ZentrumDestinationDetail } = await import(
  "../src/components/zentrum/ZentrumDestinationDetail.tsx"
);
const { ZentrumSchematic } = await import("../src/components/zentrum/ZentrumSchematic.tsx");

const now = Date.parse("2026-10-07T12:00:00+02:00");
const time = (minutes: number) => new Date(now + minutes * 60_000).toISOString();
const run = (id: string, lineId: string, leaves: number, arrives: number, platform: string) =>
  createDeparture({
    id,
    tripId: id,
    lineId,
    destination: `Richtung ${id}`,
    boardingLocalStopId: "europaplatz",
    boardingProviderStopPointId: "origin",
    platformCode: platform,
    platformKind: "track",
    scheduledDepartureTime: time(leaves),
    tripCalls: [
      {
        localStopId: "europaplatz",
        stopName: "Europaplatz",
        providerStopPointId: "origin",
        platformCode: platform,
        platformLabel: `Gleis ${platform}`,
        scheduledDepartureTime: time(leaves),
      },
      {
        localStopId: "marktplatz",
        stopName: "Marktplatz",
        scheduledArrivalTime: time(arrives),
      },
    ],
  });
const departures = [run("first", "2", 4, 10, "1"), run("second", "S1", 6, 9, "3")];
const board: DepartureBoard = {
  stopId: "europaplatz",
  departures,
  dataStatus: "live",
  feedUpdatedAt: time(0),
  receivedAt: now,
};
const getSign = createZentrumLineSignReader([]);

for (const isStacked of [false, true]) {
  test(`a stop keeps its list hidden by default and remembers toggles (${isStacked ? "stacked" : "desktop"})`, async () => {
    const original = zentrumStopPanelState.read();
    zentrumStopPanelState.write(undefined);
    const container = document.createElement("div");
    const root = createRoot(container);
    const layout = buildZentrumSchematicReading(departures);
    function Map() {
      const [selectedStopId, setSelectedStopId] = useState<string>();
      return createElement(ZentrumSchematic, {
        layout,
        getSign,
        selectedStopId,
        runDepartures: departures,
        stopBoard: board,
        feedNow: now,
        isLoading: false,
        isFullscreen: false,
        isStacked,
        onSelectStop: setSelectedStopId,
        onSelectLine() {},
        onChangeFullscreen() {},
      });
    }
    const selectStop = async () => {
      const stop = container.querySelector<HTMLButtonElement>(
        '.zentrum-schematic-stop[aria-label^="Europaplatz,"]',
      );
      assert.ok(stop);
      await act(async () => stop.click());
    };
    try {
      await act(async () => root.render(createElement(Map)));
      await selectStop();
      assert.ok(
        !container.querySelector(".zentrum-panel"),
        "additional stop information should stay hidden by default",
      );
      let toggle = container.querySelector<HTMLButtonElement>(".zentrum-stop-panel-toggle")!;
      assert.equal(toggle.getAttribute("aria-expanded"), "false");
      await act(async () => toggle.click());
      assert.equal(toggle.getAttribute("aria-expanded"), "true");
      assert.equal(zentrumStopPanelState.read(), "expanded");
      assert.ok(container.querySelector(".zentrum-destination-row"));
      await selectStop();
      await selectStop();
      toggle = container.querySelector<HTMLButtonElement>(".zentrum-stop-panel-toggle")!;
      assert.equal(toggle.getAttribute("aria-expanded"), "true");
      await act(async () => toggle.click());
      assert.equal(toggle.getAttribute("aria-expanded"), "false");
      assert.equal(zentrumStopPanelState.read(), "collapsed");
      assert.equal(container.querySelector(".zentrum-panel"), null);
      await selectStop();
      await selectStop();
      toggle = container.querySelector<HTMLButtonElement>(".zentrum-stop-panel-toggle")!;
      assert.equal(toggle.getAttribute("aria-expanded"), "false");
      assert.equal(container.querySelector(".zentrum-panel"), null);
    } finally {
      await act(async () => root.unmount());
      zentrumStopPanelState.write(original);
    }
  });
}

const panelProps = (
  travelMeasure: "arrival" | "ride" | "split",
): ComponentProps<typeof ZentrumStopPanel> => ({
  stopId: "europaplatz",
  label: "Europaplatz",
  reading: "destinations",
  board,
  reachableStops: getZentrumStopView(
    "destinations",
    "europaplatz",
    board,
    [],
    departures,
    now,
    travelMeasure,
  ).reachableStops,
  travelMeasure,
  isLoading: false,
  onSelectVehicle() {},
  onSelectDestination() {},
  getSign,
  feedNow: now,
  entranceMotion: "slide",
});

test("destination rows label their measure and show waiting, riding, arrival and source", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  const selected: string[] = [];
  try {
    for (const measure of ["arrival", "ride", "split"] as const) {
      await act(async () =>
        root.render(
          createElement(ZentrumStopPanel, {
            ...panelProps(measure),
            onSelectDestination: (id) => selected.push(id),
          }),
        ),
      );
      const row = container.querySelector<HTMLButtonElement>(".zentrum-destination-row");
      assert.ok(row);
      assert.match(row.textContent, /Abfahrt in 6 min/);
      assert.match(row.textContent, /nach Fahrplan/);
      assert.match(row.textContent, /12:09/);
      assert.equal(
        container.querySelector(".zentrum-destination-time-label")?.textContent,
        measure === "arrival" ? "Ankunft in" : "Fahrt",
      );
      assert.match(row.getAttribute("aria-label")!, /3 min Fahrt, Ankunft 12:09, Gleis 3/);
      await act(async () => row.click());
    }
    assert.deepEqual(selected, ["marktplatz", "marktplatz", "marktplatz"]);
  } finally {
    await act(async () => root.unmount());
  }
});

test("destination loading and failure do not claim there are no direct rides", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    const props = { ...panelProps("arrival"), reachableStops: [] };
    await act(async () =>
      root.render(createElement(ZentrumStopPanel, { ...props, board: null, isLoading: true })),
    );
    assert.match(container.textContent, /Direkte Ziele werden geladen/);
    assert.equal(container.querySelector(".zentrum-panel-list")?.getAttribute("aria-busy"), "true");
    await act(async () =>
      root.render(
        createElement(ZentrumStopPanel, {
          ...props,
          board: { ...board, dataStatus: "unavailable", errorMessage: "Feed nicht verfügbar" },
        }),
      ),
    );
    assert.match(container.textContent, /Feed nicht verfügbar/);
    assert.doesNotMatch(container.textContent, /keine direkte Fahrt/);
    await act(async () =>
      root.render(
        createElement(ZentrumStopPanel, {
          ...props,
          board: { ...board, refreshFailedAt: now },
          feedNow: now + 6 * 60_000,
        }),
      ),
    );
    assert.ok(container.querySelector('[role="status"]'));
    assert.match(container.textContent, /Aktualisierung/);
  } finally {
    await act(async () => root.unmount());
  }
});

test("choosing a ride updates its times, platform, notice and ride link, and follows refreshes", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  const props: ComponentProps<typeof ZentrumDestinationDetail> = {
    originStopId: "europaplatz",
    originStopLabel: "Europaplatz",
    reachableStop: panelProps("arrival").reachableStops[0],
    rides: getZentrumDirectRides(departures, "europaplatz", "marktplatz", now),
    board: {
      ...board,
      departures: [{ ...departures[0], serviceNote: "Einstieg hinten" }, departures[1]],
    },
    feedNow: now,
    getSign,
    onClose() {},
    onSelectStop() {},
  };
  try {
    await act(async () => root.render(createElement(ZentrumDestinationDetail, props)));
    const buttons = [...container.querySelectorAll<HTMLButtonElement>(".zentrum-destination-ride")];
    assert.equal(buttons.length, 2);
    assert.equal(buttons[1].getAttribute("aria-pressed"), "true");
    await act(async () => buttons[0].click());
    assert.equal(buttons[0].getAttribute("aria-pressed"), "true");
    assert.match(
      container.querySelector(".zentrum-destination-summary")!.textContent,
      /6 min FahrtAbfahrt in 4 minAnkunft 12:10/,
    );
    assert.match(container.querySelector(".zentrum-destination-calls")!.textContent, /Gleis 1/);
    assert.match(container.textContent, /Einstieg hinten/);
    assert.equal(
      container.querySelector(".zentrum-panel-link")!.getAttribute("href"),
      `#${routePaths.ride("first", "europaplatz", "marktplatz")}`,
    );
    const updatedRides = props.rides.map((ride) =>
      ride.departure.id === "first"
        ? { ...ride, departsAt: now + 5 * 60_000, arrivesAt: now + 11 * 60_000 }
        : ride,
    );
    await act(async () =>
      root.render(createElement(ZentrumDestinationDetail, { ...props, rides: updatedRides })),
    );
    assert.match(
      container.querySelector(".zentrum-destination-summary")!.textContent,
      /Abfahrt in 5 minAnkunft 12:11/,
    );
    await act(async () =>
      root.render(
        createElement(ZentrumDestinationDetail, { ...props, rides: props.rides.slice(1) }),
      ),
    );
    assert.equal(
      container.querySelector(".zentrum-panel-link")!.getAttribute("href"),
      `#${routePaths.ride("second", "europaplatz", "marktplatz")}`,
    );
  } finally {
    await act(async () => root.unmount());
  }
});
