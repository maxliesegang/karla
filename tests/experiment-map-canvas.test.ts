import assert from "node:assert/strict";
import test from "node:test";
import "./support/render-hook.ts";
import "./support/register-tsx.ts";
import type { DirectTravelTime } from "../src/lib/direct-travel-times.ts";
import { getGeoLinkId, type MapDrawing } from "../src/lib/geo-map.ts";
import { createZentrumLineSignReader } from "../src/components/zentrum/line-sign.ts";

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { ExperimentMapCanvas } = await import(
  "../src/components/experiment/ExperimentMapCanvas.tsx"
);

test("overview clock ticks leave label placement unchanged; selection minutes still advance", async (t) => {
  const drawing: MapDrawing = {
    stops: new Map(
      ["a", "b"].map((id, index) => [
        id,
        { id, name: id.toUpperCase(), x: 100 + index * 100, y: 100, lineIds: ["S1"] },
      ]),
    ),
    links: [{ id: getGeoLinkId("a", "b"), fromId: "a", toId: "b", lineIds: ["S1"] }],
  };
  const reads = t.mock.method(drawing.stops, "get");
  const container = document.createElement("div");
  const root = createRoot(container);
  t.after(() => act(async () => root.unmount()));
  const props = {
    drawing,
    bounds: { x: 0, y: 0, width: 500, height: 300 },
    scale: 1,
    places: [],
    getSign: createZentrumLineSignReader([]),
    onSelectStop() {},
    scrollRef: { current: null },
    onScroll() {},
  };
  const render = (feedNow: number, times?: ReadonlyMap<string, DirectTravelTime>) =>
    act(async () =>
      root.render(
        createElement(ExperimentMapCanvas, {
          ...props,
          feedNow,
          times,
          selectedStopId: times ? "a" : undefined,
        }),
      ),
    );
  await render(0);
  const names = container.textContent;
  reads.mock.resetCalls();
  await render(60_000);
  assert.equal(container.textContent, names);
  assert.equal(reads.mock.callCount(), drawing.links.length * 2, "only SVG endpoints are read");

  const times = new Map<string, DirectTravelTime>([
    ["b", { lineId: "S1", departsAt: 60_000, arrivesAt: 180_000, stopIds: ["a", "b"] }],
  ]);
  await render(60_000, times);
  assert.equal(container.querySelector('[aria-label="B, in 2 Minuten"]')?.textContent, "B2′");
  await render(120_000, times);
  assert.equal(container.querySelector('[aria-label="B, in 1 Minuten"]')?.textContent, "B1′");
  await render(120_000);
  assert.equal(container.textContent, names);
});
