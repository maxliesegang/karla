import assert from "node:assert/strict";
import test from "node:test";
import "./support/render-hook.ts";
import "./support/register-tsx.ts";
import { createZentrumLineSignReader } from "../src/components/zentrum/line-sign.ts";

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { ZentrumSchematicToolbar } = await import(
  "../src/components/zentrum/ZentrumSchematicToolbar.tsx"
);

test("Alle Linien stays beside the scrolling badges and follows the current selection", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  const selections: (string | undefined)[] = [];
  const render = (selectedLineId?: string, hasStop = false, lineIds = ["S1", "2"]) =>
    act(async () =>
      root.render(
        createElement(ZentrumSchematicToolbar, {
          caption: "Positionen geschätzt",
          lineIds,
          getSign: createZentrumLineSignReader([]),
          selectedLineId,
          hoveredLineIds: [],
          onSelectLine: (lineId) => selections.push(lineId),
          stopBar: hasStop ? createElement("div", {}, "Marktplatz") : undefined,
        }),
      ),
    );
  const allLines = () => {
    const button = container.querySelector<HTMLButtonElement>(".zentrum-schematic-lines-reset");
    assert.ok(button);
    assert.equal(button.textContent, "Alle Linien");
    assert.equal(button.closest(".zentrum-schematic-lines"), null);
    assert.equal(container.querySelector("button"), button);
    return button;
  };

  try {
    await render();
    assert.equal(allLines().getAttribute("aria-pressed"), "true");
    await act(async () => allLines().click());
    assert.deepEqual(selections, [undefined]);

    const line = container.querySelector<HTMLButtonElement>('[aria-label="Linie S1 verfolgen"]');
    assert.ok(line);
    await act(async () => line.click());
    assert.equal(selections.at(-1), "S1");
    await render("S1");
    assert.equal(allLines().getAttribute("aria-pressed"), "false");
    assert.equal(
      container
        .querySelector('[aria-label="Linie S1 nicht mehr verfolgen"]')
        ?.getAttribute("aria-pressed"),
      "true",
    );
    await act(async () => allLines().click());
    assert.equal(selections.at(-1), undefined);
    await render();
    assert.equal(allLines().getAttribute("aria-pressed"), "true");

    await render(undefined, true);
    assert.equal(allLines().getAttribute("aria-pressed"), "false");
    await act(async () => allLines().click());
    assert.equal(selections.at(-1), undefined);

    await render(undefined, false, []);
    assert.equal(allLines().getAttribute("aria-pressed"), "true");
  } finally {
    await act(async () => root.unmount());
  }
});
