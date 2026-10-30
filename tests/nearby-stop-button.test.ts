import assert from "node:assert/strict";
import test from "node:test";
import "./support/register-tsx.ts";
import "./support/render-hook.ts";
import type { NearbyStopsController, NearbyStopsState } from "../src/hooks/nearby-stops.ts";

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { NearbyStopButton } = await import("../src/components/NearbyStopButton.tsx");

async function renderButton() {
  const container = document.createElement("div");
  const root = createRoot(container);
  const shown: string[] = [];
  const located: string[] = [];
  const render = (state: NearbyStopsState) =>
    act(async () =>
      root.render(
        createElement(NearbyStopButton, {
          variant: "page",
          controller: {
            ...state,
            locate: async () => void located.push("locate"),
          } as NearbyStopsController,
          onShowAlternatives: () => shown.push("nearby"),
        }),
      ),
    );
  const press = () =>
    act(async () => (container.querySelector("button") as HTMLButtonElement).click());
  return { container, root, shown, render, press, located };
}

test("a press that finds no stop opens the nearby page, which says why", async () => {
  window.location.hash = "#/";
  const { container, root, shown, render, press } = await renderButton();
  await render({ status: "idle", stops: [] });
  await press();
  await render({ status: "locating", stops: [] });
  assert.equal(container.textContent, "Standort wird bestimmt …");

  await render({
    status: "unavailable",
    stops: [],
    message: "Standort zu ungenau: Haltestelle bitte selbst wählen.",
  });
  assert.deepEqual(shown, ["nearby"]);
  assert.equal(window.location.hash, "#/");
  // Only a press is answered: the silent reading on a granted visit stays where it is.
  await render({ status: "ready", stops: [] });
  assert.deepEqual(shown, ["nearby"]);

  await act(async () => root.unmount());
});

test("a press that finds a stop opens it", async () => {
  window.location.hash = "#/";
  const { root, shown, render, press } = await renderButton();
  await render({ status: "idle", stops: [] });
  await press();
  await render({ status: "locating", stops: [] });
  await render({
    status: "ready",
    stops: [{ stop: { id: "marktplatz", name: "Marktplatz" }, distanceMeters: 120 }],
  });

  assert.equal(window.location.hash, "#/stop/marktplatz");
  assert.deepEqual(shown, []);

  await act(async () => root.unmount());
});

test("a press during the silent reading on load is answered by that reading", async () => {
  window.location.hash = "#/";
  const { container, root, render, press, located } = await renderButton();
  await render({ status: "locating", stops: [] });
  assert.equal(container.querySelector("button")?.disabled, false);
  await press();
  assert.deepEqual(located, []);

  await render({
    status: "ready",
    stops: [{ stop: { id: "marktplatz", name: "Marktplatz" }, distanceMeters: 120 }],
  });
  assert.equal(window.location.hash, "#/stop/marktplatz");

  await act(async () => root.unmount());
});
