import assert from "node:assert/strict";
import test from "node:test";
import "./support/register-tsx.ts";
import "./support/render-hook.ts";

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { SavedStopsView } = await import("../src/components/SavedStopsView.tsx");
const { savedStops } = await import("../src/lib/saved-stops.ts");

const ROW_HEIGHT = 60;

async function renderView(stopIds: readonly string[]) {
  savedStops.write(stopIds.map((stopId) => ({ stopId, stopName: stopId.toUpperCase() })));
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => root.render(createElement(SavedStopsView)));
  const button = (label: string) => {
    const found = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
    assert.ok(found, label);
    return found;
  };
  const names = () =>
    [...container.querySelectorAll(".saved-stop-row strong")].map((name) => name.textContent);
  return { container, root, button, names };
}

const pointer = (type: string, clientY: number) =>
  new PointerEvent(type, { bubbles: true, button: 0, pointerId: 1, clientY });

test("dragging a row past its neighbours reorders the saved stops on release", async (t) => {
  t.mock.method(HTMLElement.prototype, "setPointerCapture", () => {});
  Object.defineProperty(HTMLLIElement.prototype, "offsetHeight", {
    configurable: true,
    get: () => ROW_HEIGHT,
  });
  t.after(() => delete (HTMLLIElement.prototype as { offsetHeight?: number }).offsetHeight);
  const { root, button, names } = await renderView(["a", "b", "c"]);

  const handle = button("A verschieben");
  await act(async () => handle.dispatchEvent(pointer("pointerdown", 0)));
  for (const y of [20, 40, 80, 100, 130]) {
    await act(async () => handle.dispatchEvent(pointer("pointermove", y)));
  }
  assert.deepEqual(names(), ["B", "C", "A"]);
  assert.deepEqual(
    savedStops.read().map((stop) => stop.stopId),
    ["a", "b", "c"],
  );
  await act(async () => handle.dispatchEvent(pointer("pointerup", 130)));
  assert.deepEqual(
    savedStops.read().map((stop) => stop.stopId),
    ["b", "c", "a"],
  );

  await act(async () => root.unmount());
});

test("a cancelled drag leaves the order as it was", async (t) => {
  t.mock.method(HTMLElement.prototype, "setPointerCapture", () => {});
  Object.defineProperty(HTMLLIElement.prototype, "offsetHeight", {
    configurable: true,
    get: () => ROW_HEIGHT,
  });
  t.after(() => delete (HTMLLIElement.prototype as { offsetHeight?: number }).offsetHeight);
  const { root, button, names } = await renderView(["a", "b"]);

  const handle = button("A verschieben");
  await act(async () => handle.dispatchEvent(pointer("pointerdown", 0)));
  await act(async () => handle.dispatchEvent(pointer("pointermove", 50)));
  await act(async () => handle.dispatchEvent(pointer("pointercancel", 50)));
  assert.deepEqual(names(), ["A", "B"]);

  await act(async () => root.unmount());
});

test("the arrow keys move a row by its handle, and a removed stop leaves the list", async () => {
  const { container, root, button, names } = await renderView(["a", "b"]);

  const keyDown = (key: string) =>
    new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  await act(async () => button("B verschieben").dispatchEvent(keyDown("ArrowUp")));
  assert.deepEqual(names(), ["B", "A"]);
  await act(async () => button("B entfernen").click());
  assert.deepEqual(savedStops.read(), [{ stopId: "a", stopName: "A" }]);
  await act(async () => button("A entfernen").click());
  assert.match(container.textContent ?? "", /Noch keine Haltestelle gemerkt/);

  await act(async () => root.unmount());
});
