import assert from "node:assert/strict";
import test from "node:test";
import "./support/register-tsx.ts";
import { type ComponentProps, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const { DataProvenanceFooter } = await import("../src/components/DataProvenanceFooter.tsx");

const cases: [string, ComponentProps<typeof DataProvenanceFooter>][] = [
  ["home", {}],
  ["departure board loading", { stopEventBoard: null }],
  ["network loading", { stopEventBoards: [] }],
];

for (const [state, props] of cases) {
  test(`provider disclaimer shares the status line on ${state}`, () => {
    const markup = renderToStaticMarkup(createElement(DataProvenanceFooter, props));
    assert.match(markup, /<span>Kein offizielles KVV-Angebot · [^<]+<\/span>/);
    assert.equal((markup.match(/<span>/g) ?? []).length, 1);
    assert.doesNotMatch(markup, /haftet/);
  });
}
