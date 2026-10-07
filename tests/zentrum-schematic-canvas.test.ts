import assert from "node:assert/strict";
import test from "node:test";
import "./support/render-hook.ts";
import "./support/register-tsx.ts";
import { createZentrumLineSignReader } from "../src/components/zentrum/line-sign.ts";
import {
  buildZentrumSchematicReading,
  getZentrumSchematicVehicles,
} from "../src/lib/zentrum-schematic.ts";
import { createRunMotions } from "../src/lib/vehicle-positioning.ts";
import { createDeparture } from "./support/fixtures.ts";

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { ZentrumSchematicCanvas } = await import(
  "../src/components/zentrum/ZentrumSchematicCanvas.tsx"
);

for (const [place, lineId, stops] of [
  ["bend", "2", ["europaplatz", "marktplatz", "ettlinger-tor"]],
  ["Durlacher Tor crossing", "3", ["rueppurrer-tor", "durlacher-tor", "karl-wilhelm-platz"]],
] as const) {
  test(`a foreground ${place}'s lit stretch animates with its route and retires when dimmed`, async (t) => {
    const start = Date.parse("2026-10-06T10:00:00Z");
    const run = createDeparture({
      id: "north-south",
      lineId,
      transportMode: "tram",
      tripCalls: stops.map((localStopId, index) => ({
        localStopId,
        stopName: localStopId,
        scheduledArrivalTime: new Date(start + index * 60_000).toISOString(),
        scheduledDepartureTime: new Date(start + index * 60_000).toISOString(),
      })),
    });
    const crossing = createDeparture({
      id: "east-west",
      lineId: "1",
      transportMode: "tram",
      tripCalls: ["kronenplatz", "durlacher-tor", "gottesauer-platz"].map((localStopId) => ({
        localStopId,
        stopName: localStopId,
      })),
    });
    const schematic = buildZentrumSchematicReading([run, crossing]);
    assert.ok(schematic.drawnPaths.some((path) => path.foregroundRegions.length > 0));
    const [placed] = getZentrumSchematicVehicles(
      schematic,
      [run],
      start + 20_000,
      createRunMotions(),
    );
    assert.ok(placed);
    const vehicle = {
      ...placed,
      motion: "travelled" as const,
      trajectory: {
        startsAt: start,
        arrivesAt: start + 60_000,
        sampledAt: start + 20_000,
        startProgress: 0,
        progresses: Array.from({ length: 61 }, (_, second) => second / 60),
      },
    };
    const animations = new Map<
      string,
      { frames: Keyframe[]; options: KeyframeAnimationOptions; animation: Animation }
    >();
    t.mock.method(
      SVGElement.prototype,
      "animate",
      function (this: SVGElement, frames: Keyframe[], options: KeyframeAnimationOptions) {
        const animation = new Animation();
        animations.set(this.getAttribute("data-marker-key")!, { frames, options, animation });
        return animation;
      },
    );
    const container = document.createElement("div");
    const root = createRoot(container);
    const render = (selectedLineId?: string) =>
      act(async () =>
        root.render(
          createElement(ZentrumSchematicCanvas, {
            schematic,
            getSign: createZentrumLineSignReader([]),
            vehicles: [],
            overlay: { corridorIdsByLineId: new Map(), stretches: [{ vehicle, end: 1 }] },
            selectedLineId,
            zoom: 1,
            planWidth: 1200,
            scrollRef: { current: null },
            onSelectVehicle() {},
            onSelectStop() {},
            onSelectLine() {},
            onHoverLines() {},
          }),
        ),
      );
    try {
      await render();
      const key = `stretch:${vehicle.markerKey ?? vehicle.id}`;
      const base = animations.get(key);
      assert.ok(base);
      const foregrounds = [...animations].filter(([animationKey]) =>
        animationKey.startsWith(`${key}:foreground:`),
      );
      assert.ok(foregrounds.length > 0);
      const cancels = foregrounds.map(([foregroundKey, foreground]) => {
        assert.deepEqual(foreground.frames, base.frames);
        assert.deepEqual(foreground.options, base.options);
        assert.ok(
          container.querySelector(`[data-marker-key="${CSS.escape(foregroundKey)}"] [clip-path]`),
        );
        return t.mock.method(foreground.animation, "cancel");
      });
      await render("1");
      for (const cancel of cancels) assert.equal(cancel.mock.callCount(), 1);
      for (const [foregroundKey] of foregrounds)
        assert.equal(
          container.querySelector(`[data-marker-key="${CSS.escape(foregroundKey)}"]`),
          null,
        );
    } finally {
      await act(async () => root.unmount());
    }
  });
}

for (const atStation of [true, false]) {
  test(`overlapping marks ${atStation ? "at a station open individually" : "between stations open individually"}`, async (t) => {
    t.mock.method(HTMLElement.prototype, "animate", () => new Animation());
    const start = Date.parse("2026-10-07T12:00:00Z");
    const first = createDeparture({
      id: "first",
      tripInstanceId: "first",
      lineId: "S1",
      transportMode: "tram",
      tripCalls: ["kronenplatz", "durlacher-tor"].map((localStopId, index) => ({
        localStopId,
        stopName: localStopId,
        scheduledArrivalTime: new Date(start + index * 60_000).toISOString(),
        scheduledDepartureTime: new Date(start + index * 60_000).toISOString(),
      })),
    });
    const second = {
      ...first,
      id: "second",
      tripInstanceId: "second",
      destination: "Anderes Ziel",
      lineId: "S2",
    };
    const schematic = buildZentrumSchematicReading([first, second]);
    const vehicles = getZentrumSchematicVehicles(
      schematic,
      [first, second],
      start + (atStation ? 0 : 30_000),
      createRunMotions(),
    );
    assert.equal(vehicles.length, 2);
    const coordinates = vehicles.map(({ x, y }) => [x, y]);
    const container = document.createElement("div");
    const root = createRoot(container);
    let chosenVehicle: string | undefined;
    let chosenStop: string | undefined;
    const render = (selectedVehicleId?: string) =>
      act(async () =>
        root.render(
          createElement(ZentrumSchematicCanvas, {
            schematic,
            vehicles,
            selectedVehicleId,
            getSign: createZentrumLineSignReader([]),
            zoom: 1,
            planWidth: 1200,
            scrollRef: { current: null },
            onSelectVehicle(id) {
              chosenVehicle = id;
            },
            onSelectStop(id) {
              chosenStop = id;
            },
            onSelectLine() {},
            onHoverLines() {},
          }),
        ),
      );
    try {
      await render();
      const marks = container.querySelectorAll<HTMLButtonElement>(".zentrum-schematic-vehicle");
      assert.equal(marks.length, 2);
      assert.equal(container.querySelector(".zentrum-schematic-stop-vehicles"), null);
      for (let index = 0; index < marks.length; index += 1) {
        await act(async () => marks[index].click());
        assert.equal(chosenVehicle, vehicles[index].id);
      }
      await render("first");
      assert.equal(container.querySelectorAll(".zentrum-schematic-vehicle").length, 2);
      assert.equal(
        container.querySelector('[data-marker-key="first"]')?.getAttribute("aria-expanded"),
        "true",
      );
      const stop = container.querySelector<HTMLButtonElement>(
        '.zentrum-schematic-stop[aria-label^="Kronenplatz,"]',
      );
      assert.ok(stop);
      await act(async () => stop.click());
      assert.equal(chosenStop, "kronenplatz");
      assert.deepEqual(
        vehicles.map(({ x, y }) => [x, y]),
        coordinates,
      );
    } finally {
      await act(async () => root.unmount());
    }
  });
}
