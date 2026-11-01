import assert from "node:assert/strict";
import test from "node:test";
import { network } from "../src/networks/network.ts";
import "./support/register-tsx.ts";
import "./support/render-hook.ts";

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { SettingsView } = await import("../src/components/SettingsView.tsx");

test("settings state the operator's terms and credit the timetable data", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => root.render(createElement(SettingsView)));

  const about =
    container.querySelector('[aria-labelledby="settings-about-title"]')?.textContent ?? "";
  assert.match(about, /kein offizielles Angebot des Karlsruher Verkehrsverbunds \(KVV\)/);
  assert.match(about, /Der KVV haftet\s+nicht für die Inhalte/);
  assert.match(
    about,
    /Fahrplanauskunft des KVV, seine Linienfarben aus seinen Open Data \(CC0\)\./,
  );
  assert.match(about, /anderer Verkehrsunternehmen: Träwelling line-colors \(CC0 1\.0\)\./);
  assert.match(about, /NVBW, Datenlizenz Deutschland – Namensnennung 2\.0\./);
  const datasetLink = container.querySelector(`a[href="${network.catalogSource.gtfs.url}"]`);
  assert.equal(datasetLink?.textContent, "NVBW");
  assert.equal(container.querySelector("img"), null);

  const privacy =
    container.querySelector('[aria-labelledby="settings-privacy-title"]')?.textContent ?? "";
  assert.match(privacy, /nur die Anzahl der App-Aufrufe pro Tag, keine einzelnen Besuche/);
  assert.match(privacy, /keine Cookies oder Nutzerkennungen/);
  assert.match(
    privacy,
    /Haltestellen, Fahrten, Suchbegriffe und Standort werden nicht mitgesendet/,
  );
  assert.match(privacy, /Do Not Track/);
  assert.match(privacy, /Global Privacy Control/);
  assert.match(privacy, /tägliche Summen von Datenanfragen und technischen Fehlern/);
  assert.match(privacy, /keine Nutzerkennungen oder Inhalte deiner Anfragen/);

  await act(async () => root.unmount());
});
