import assert from "node:assert/strict";
import test from "node:test";
import "./support/register-tsx.ts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createLineSign } from "../src/data/line-signs.ts";
import { getZentrumSchematicDrawnPaths } from "../src/lib/zentrum-schematic-paths.ts";
import { type ZentrumSchematicEdge, getEdgeKey } from "../src/lib/zentrum-schematic-plan.ts";

const { ZentrumSchematicDrawing } = await import(
  "../src/components/zentrum/ZentrumSchematicDrawing.tsx"
);

const drawnLinePaths = ["4", "2"].map((lineId) => ({
  id: lineId,
  lineId,
  trackId: lineId,
  lineIds: [lineId],
  nodes: [],
  foregroundRegions: [],
  data: "M 0 0 L 100 0",
  sign: createLineSign(lineId, "tram"),
  segments: [{ corridorId: "corridor", data: "M 0 0 L 100 0" }],
}));

test("base and lit routes keep KVV colors, with fine edges only on pale lines", () => {
  for (const overlay of [
    undefined,
    {
      corridorIdsByLineId: new Map(["4", "2"].map((lineId) => [lineId, new Set(["corridor"])])),
      stretches: [],
    },
  ]) {
    const markup = renderToStaticMarkup(
      createElement(ZentrumSchematicDrawing, {
        drawnLinePaths,
        stopMarks: [],
        trackWidth: 7,
        overlay,
        onSelectLine() {},
        onHoverLines() {},
      }),
    );
    assert.doesNotMatch(markup, /network-track-casing/);
    assert.equal(
      (markup.match(/class="zentrum-schematic-network-track-outline"/g) ?? []).length,
      1,
    );
    assert.match(markup, /network-track-outline[^>]*stroke="#ffcc00"/);
    assert.match(markup, /network-track-color[^>]*data-pale="true"[^>]*stroke="#ffcc00"/);
    assert.match(markup, /network-track-color[^>]*stroke="#0073df"/);
    assert.equal((markup.match(/class="zentrum-schematic-network-track-gap"/g) ?? []).length, 2);
  }
});

test("a turn is painted above later straight routes only around its bend", () => {
  const west = { id: "west", label: "West", x: 100, y: 200 };
  const corner = { id: "corner", label: "Corner", x: 200, y: 200 };
  const south = { id: "south", label: "South", x: 200, y: 300 };
  const crossingWest = { id: "cross-west", label: "West", x: 100, y: 205 };
  const crossingEast = { id: "cross-east", label: "East", x: 300, y: 205 };
  const paths = [
    { id: "2", lineId: "2", trackId: "2", nodes: [west, corner, south] },
    { id: "1", lineId: "1", trackId: "1", nodes: [crossingWest, crossingEast] },
  ];
  const edges: ZentrumSchematicEdge[] = paths.flatMap((path) =>
    path.nodes.slice(1).map((to, index) => ({
      id: getEdgeKey(path.nodes[index].id, to.id),
      from: path.nodes[index],
      to,
      lineIds: [path.lineId],
      trackIds: [path.trackId],
      trackBandOffset: 0,
    })),
  );
  const drawn = getZentrumSchematicDrawnPaths(paths, edges, 7, new Map(), new Map());
  assert.deepEqual(drawn[0].foregroundRegions, [{ x: 176, y: 186, width: 38, height: 38 }]);
  assert.deepEqual(drawn[1].foregroundRegions, []);
  const render = (lit: boolean, highlightedLineIds?: ReadonlySet<string>) =>
    renderToStaticMarkup(
      createElement(ZentrumSchematicDrawing, {
        drawnLinePaths: drawn.map((path) => ({
          ...path,
          sign: createLineSign(path.lineId, "tram"),
          segments: [{ corridorId: path.id, data: path.data }],
        })),
        stopMarks: [],
        trackWidth: 7,
        highlightedLineIds,
        overlay: lit
          ? {
              corridorIdsByLineId: new Map(paths.map((path) => [path.lineId, new Set([path.id])])),
              stretches: [],
            }
          : undefined,
        onSelectLine() {},
        onHoverLines() {},
      }),
    );
  for (const lit of [false, true]) {
    const markup = render(lit);
    const colors = [
      ...markup.matchAll(/class="zentrum-schematic-network-track-color"[^>]*stroke="([^"]+)"/g),
    ].map((match) => match[1]);
    assert.deepEqual(colors, ["#0073df", "#ff0000", "#0073df"]);
    assert.equal((markup.match(/clip-path="url\(/g) ?? []).length, 1);
    assert.match(markup, /clip-path="url\(#[^)]+\)"><path[^>]*network-track-gap[^>]*mask="url\(/);
    assert.doesNotMatch(render(lit, new Set(["1"])), /clip-path="url\(/);
  }
});

test("following a line dims its companions as a whole and gives them no crossing cutout", () => {
  const markup = renderToStaticMarkup(
    createElement(ZentrumSchematicDrawing, {
      drawnLinePaths,
      stopMarks: [],
      trackWidth: 7,
      highlightedLineIds: new Set(["2"]),
      onSelectLine() {},
      onHoverLines() {},
    }),
  );
  assert.match(markup, /class="zentrum-schematic-network-track" data-dimmed="true"/);
  assert.equal((markup.match(/class="zentrum-schematic-network-track-gap"/g) ?? []).length, 1);
  assert.doesNotMatch(
    markup,
    /class="zentrum-schematic-network-track-(?:color|outline)"[^>]*data-dimmed/,
  );
});

test("north-south routes cross above the east-west band at Durlacher Tor in either direction", () => {
  const tor = { id: "durlacher-tor", label: "Durlacher Tor", x: 858, y: 154 };
  const north = { id: "north", label: "North", x: 946, y: 66 };
  const south = { id: "south", label: "South", x: 726, y: 286 };
  const west = { id: "west", label: "West", x: 726, y: 154 };
  const east = { id: "east", label: "East", x: 968, y: 154 };
  const edge = (from: typeof tor, to: typeof tor, trackIds: string[]): ZentrumSchematicEdge => ({
    id: getEdgeKey(from.id, to.id),
    from,
    to,
    trackIds,
    lineIds: trackIds,
    trackBandOffset: 0,
  });
  const edges = [
    edge(south, tor, ["3", "4"]),
    edge(tor, north, ["3", "4"]),
    edge(west, tor, ["1", "S2", "S5", "S7"]),
    edge(tor, east, ["1", "S2", "S5", "S7"]),
  ];
  for (const trackWidth of [4.75, 9.5]) {
    for (const reversed of [false, true]) {
      const paths = ["3", "4", "1"].map((lineId) => ({
        id: lineId,
        lineId,
        trackId: lineId,
        nodes:
          lineId === "1" ? [west, tor, east] : reversed ? [north, tor, south] : [south, tor, north],
      }));
      const drawn = getZentrumSchematicDrawnPaths(paths, edges, trackWidth, new Map(), new Map());
      const crossing = drawn.filter((path) => path.lineId !== "1");
      assert.ok(crossing.every((path) => path.foregroundRegions.length > 0));
      assert.deepEqual(drawn.find((path) => path.lineId === "1")?.foregroundRegions, []);
      for (const path of crossing) {
        const region = path.foregroundRegions[0];
        assert.ok(region.y < tor.y - trackWidth * 2);
        assert.ok(region.y + region.height > tor.y + trackWidth * 2);
      }
      for (const lit of [false, true]) {
        const markup = renderToStaticMarkup(
          createElement(ZentrumSchematicDrawing, {
            drawnLinePaths: [...crossing, drawn.find((path) => path.lineId === "1")!].map(
              (path) => ({
                ...path,
                sign: createLineSign(path.lineId, "tram"),
                segments: [{ corridorId: path.id, data: path.data }],
              }),
            ),
            stopMarks: [],
            trackWidth,
            overlay: lit
              ? {
                  corridorIdsByLineId: new Map(
                    paths.map((path) => [path.lineId, new Set([path.id])]),
                  ),
                  stretches: [],
                }
              : undefined,
            onSelectLine() {},
            onHoverLines() {},
          }),
        );
        const colors = [
          ...markup.matchAll(/class="zentrum-schematic-network-track-color"[^>]*stroke="([^"]+)"/g),
        ].map((match) => match[1]);
        assert.deepEqual(colors, ["#806600", "#ffcc00", "#ff0000", "#806600", "#ffcc00"]);
      }
    }
  }
});

test("branches sharing a drawn track exclude their combined color from each border", () => {
  const paths = ["S7", "S71"].map((lineId, index) => ({
    ...drawnLinePaths[0],
    id: lineId,
    lineId,
    lineIds: [lineId],
    trackId: "S7",
    sign: createLineSign(lineId, "lightRail"),
    data: index === 0 ? "M 10 50 L 100 50" : "M 55 10 L 55 30 Q 55 50 75 50 L 100 50",
    segments: [
      {
        corridorId: lineId,
        data: index === 0 ? "M 10 50 L 100 50" : "M 55 10 L 55 30 Q 55 50 75 50 L 100 50",
      },
    ],
  }));
  const render = (trackIds = ["S7", "S7"], lit = false) =>
    renderToStaticMarkup(
      createElement(ZentrumSchematicDrawing, {
        drawnLinePaths: paths.map((path, index) => ({ ...path, trackId: trackIds[index] })),
        stopMarks: [],
        trackWidth: 7,
        onSelectLine() {},
        onHoverLines() {},
        overlay: lit
          ? {
              corridorIdsByLineId: new Map(
                paths.map((path) => [path.lineId, new Set([path.lineId])]),
              ),
              stretches: [],
            }
          : undefined,
      }),
    );
  for (const markup of [render(), render(["S7", "S7"], true)]) {
    assert.match(markup, /<mask /);
    assert.match(
      markup,
      /zentrum-schematic-merge-mask[^>]*d="M 10 50 L 100 50 M 55 10 L 55 30 Q 55 50 75 50 L 100 50"/,
    );
    assert.equal(
      (
        markup.match(
          /class="zentrum-schematic-network-track-(?:gap|outline)"[^>]*mask="url\(#[^)]+\)"/g,
        ) ?? []
      ).length,
      4,
    );
  }
  assert.doesNotMatch(render(["S7", "other"]), /<mask /);
});
