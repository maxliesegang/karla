import assert from "node:assert/strict";
import test from "node:test";
import "./support/register-tsx.ts";
import "./support/render-hook.ts";

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { SettingsView } = await import("../src/components/SettingsView.tsx");

test("settings state the operator's terms and credit the timetable data", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => root.render(createElement(SettingsView)));

  const about = container.querySelector(".settings-about")?.textContent ?? "";
  assert.match(about, /kein offizielles Angebot des Karlsruher Verkehrsverbunds \(KVV\)/);
  assert.match(about, /Der KVV haftet\s+nicht für die Inhalte/);
  assert.match(about, /Fahrplanauskunft des KVV, Linienfarben aus seinen Open Data \(CC0\)\./);
  assert.match(about, /NVBW, Datenlizenz Deutschland – Namensnennung 2\.0\./);
  assert.equal(container.querySelector("img"), null);

  await act(async () => root.unmount());
});
