import assert from "node:assert/strict";
import test from "node:test";
import "./support/render-hook.ts";
import "./support/register-tsx.ts";
import { createZentrumLineSignReader } from "../src/components/zentrum/line-sign.ts";
import {
  getZentrumPlanOptionsFromStored,
  zentrumPlanOptions,
} from "../src/lib/zentrum-plan-options.ts";
import { buildZentrumSchematicReading } from "../src/lib/zentrum-schematic.ts";
import { createDeparture } from "./support/fixtures.ts";

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { ZentrumSchematic } = await import("../src/components/zentrum/ZentrumSchematic.tsx");

test("stop selection follows the opened stop without offering style choices", async () => {
  const original = zentrumPlanOptions.read();
  zentrumPlanOptions.write({ ...getZentrumPlanOptionsFromStored(null), travelMeasure: "ride" });
  const run = createDeparture({
    lineId: "2",
    tripCalls: ["europaplatz", "marktplatz", "ettlinger-tor"].map((localStopId) => ({
      localStopId,
      stopName: localStopId,
    })),
  });
  const container = document.createElement("div");
  const root = createRoot(container);
  const layout = buildZentrumSchematicReading([run]);
  const selections: (string | undefined)[] = [];
  const button = (label: string) => {
    const found = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.getAttribute("aria-label") === label || button.textContent === label,
    );
    assert.ok(found, label);
    return found;
  };

  const render = (selectedStopId?: string) =>
    act(async () =>
      root.render(
        createElement(ZentrumSchematic, {
          layout,
          getSign: createZentrumLineSignReader([]),
          selectedStopId,
          runDepartures: [],
          stopBoard: null,
          feedNow: 0,
          isLoading: false,
          isFullscreen: false,
          isStacked: false,
          onSelectStop: (stopId) => selections.push(stopId),
          onSelectLine() {},
          onChangeFullscreen() {},
        }),
      ),
    );
  const assertSelected = (name: string) => {
    const selected = container.querySelectorAll('.zentrum-schematic-stop[data-selected="true"]');
    assert.equal(selected.length, 1);
    assert.equal(selected[0].getAttribute("aria-pressed"), "true");
    assert.equal(selected[0].querySelector(".zentrum-schematic-stop-name")?.textContent, name);
    const selectedCapsules = new Set(
      [...container.querySelectorAll('.zentrum-schematic-stop-mark[data-selected="true"]')].map(
        (mark) => mark.getAttribute("d"),
      ),
    );
    const rings = [...container.querySelectorAll(".zentrum-schematic-stop-selection-ring")];
    assert.ok(rings.length > 0);
    assert.deepEqual(new Set(rings.map((ring) => ring.getAttribute("d"))), selectedCapsules);
  };

  try {
    await render("marktplatz");
    assertSelected("Marktplatz");
    await act(async () => button("Planoptionen").click());
    assert.equal(container.querySelector('[aria-label="Haltestellenauswahl"]'), null);
    assert.doesNotMatch(
      container.querySelector(".zentrum-plan-options-panel")!.textContent,
      /Haltestellenauswahl|Ring \+ Name|Helles Schild|Unterstrichen/,
    );
    assert.ok(container.querySelector('[aria-label="Ziele in Minuten"]'));
    await act(async () => button("Europaplatz").click());
    assert.equal(selections.at(-1), "europaplatz");
    await render(selections.at(-1));
    assertSelected("Europaplatz");
    await act(async () => button("Europaplatz").click());
    assert.equal(selections.at(-1), undefined);
    await render(selections.at(-1));
    assert.equal(container.querySelector('.zentrum-schematic-stop[data-selected="true"]'), null);
    assert.equal(container.querySelector(".zentrum-schematic-stop-selection-ring"), null);
  } finally {
    await act(async () => root.unmount());
    zentrumPlanOptions.write(original);
  }
});
