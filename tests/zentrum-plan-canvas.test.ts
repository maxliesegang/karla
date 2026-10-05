import assert from "node:assert/strict";
import test from "node:test";
import {
  getNeighboringZentrumZoom,
  getZentrumOpeningScroll,
  getZentrumPlanWidth,
  getZentrumPortraitFrameHeight,
  getZentrumRevealScroll,
  getZentrumVehicleTransform,
  toZentrumCanvasLeft,
  toZentrumCanvasTop,
  toZentrumCanvasRun,
  ZENTRUM_MAXIMUM_ZOOM,
  ZENTRUM_MINIMUM_ZOOM,
  ZENTRUM_PORTRAIT_FRAME,
  ZENTRUM_ZOOM_STEPS,
} from "../src/lib/zentrum-plan-canvas.ts";
import {
  ZENTRUM_SCHEMATIC_VIEWBOX,
  zentrumSchematicNodeById,
} from "../src/lib/zentrum-schematic-plan.ts";

test("the plan opens whole, and steps stop at both ends of the range", () => {
  assert.equal(ZENTRUM_ZOOM_STEPS[0], 1);
  assert.equal(getNeighboringZentrumZoom(ZENTRUM_MINIMUM_ZOOM, -1), ZENTRUM_MINIMUM_ZOOM);
  assert.equal(getNeighboringZentrumZoom(ZENTRUM_MAXIMUM_ZOOM, 1), ZENTRUM_MAXIMUM_ZOOM);
  assert.equal(getNeighboringZentrumZoom(ZENTRUM_ZOOM_STEPS[0], 1), ZENTRUM_ZOOM_STEPS[1]);
  assert.equal(getNeighboringZentrumZoom(ZENTRUM_ZOOM_STEPS[2], -1), ZENTRUM_ZOOM_STEPS[1]);
  // A zoom the wheel left between steps goes to the nearest step in that direction.
  assert.equal(getNeighboringZentrumZoom(1.42, 1), ZENTRUM_ZOOM_STEPS[2]);
  assert.equal(getNeighboringZentrumZoom(1.42, -1), ZENTRUM_ZOOM_STEPS[1]);
});

test("the whole plan is drawn inside the box, in whichever dimension runs out first", () => {
  const ratio = ZENTRUM_SCHEMATIC_VIEWBOX.width / ZENTRUM_SCHEMATIC_VIEWBOX.height;
  // A landscape box taller than the plan's ratio is bounded by its width.
  assert.equal(getZentrumPlanWidth({ width: 900, height: 700 }, 1), 900);
  // A box wider than it is bounded by its height, and the drawing keeps its own ratio.
  assert.equal(getZentrumPlanWidth({ width: 4000, height: 800 }, 1), Math.floor(800 * ratio));
  // The zoom grows the fitted plan rather than the box.
  assert.equal(getZentrumPlanWidth({ width: 900, height: 700 }, 1.3), 1170);
  // Before the box has been measured the drawing is given no width, and CSS decides.
  assert.equal(getZentrumPlanWidth(null, 1), undefined);
});

test("a portrait box fits the city-centre frame across its width, however tall it is", () => {
  const ratio = ZENTRUM_SCHEMATIC_VIEWBOX.width / ZENTRUM_PORTRAIT_FRAME.width;
  assert.equal(getZentrumPlanWidth({ width: 372, height: 635 }, 1), Math.floor(372 * ratio));
  assert.equal(getZentrumPlanWidth({ width: 372, height: 4000 }, 1), Math.floor(372 * ratio));
  assert.equal(
    getZentrumPlanWidth({ width: 372, height: 635 }, 1.3),
    Math.floor(1.3 * 372 * ratio),
  );
  // A landscape panel still opens on the whole plan, fitted to whichever dimension runs out first.
  const planRatio = ZENTRUM_SCHEMATIC_VIEWBOX.width / ZENTRUM_SCHEMATIC_VIEWBOX.height;
  assert.equal(getZentrumPlanWidth({ width: 900, height: 300 }, 1), Math.floor(300 * planRatio));
});

test("a narrow box keeps the city-centre frame when a panel leaves it shorter than wide", () => {
  const ratio = ZENTRUM_SCHEMATIC_VIEWBOX.width / ZENTRUM_PORTRAIT_FRAME.width;
  assert.equal(getZentrumPlanWidth({ width: 359, height: 277 }, 1), Math.floor(359 * ratio));
  // Asked for the whole plan, it still gets it.
  assert.equal(getZentrumPlanWidth({ width: 359, height: 277 }, 1, true), 359);
});

test("the portrait frame holds the city centre from Europaplatz to Werderstraße", () => {
  const { x, y, width, height } = ZENTRUM_PORTRAIT_FRAME;
  for (const id of [
    "europaplatz",
    "marktplatz",
    "kronenplatz",
    "werderstrasse",
    "hauptbahnhof",
    "albtalbahnhof",
    "tivoli",
  ]) {
    const node = zentrumSchematicNodeById.get(id);
    assert.ok(node, id);
    assert.ok(node.x > x && node.x < x + width && node.y > y && node.y < y + height, id);
  }
  // Room for a name, travel time above it, set left of the Europaplatz column or above Kaiserstraße
  // on a phone.
  assert.ok(zentrumSchematicNodeById.get("europaplatz")!.x - x >= 100);
  assert.ok(zentrumSchematicNodeById.get("marktplatz")!.y - y >= 85);
  // A portrait box is as tall as the frame, so no band of it is left empty.
  assert.equal(getZentrumPortraitFrameHeight(width), height);
});

test("a plan opens centred on the city-centre frame", () => {
  const { x, y, width, height } = ZENTRUM_PORTRAIT_FRAME;
  // Drawn at twice the plan's own size.
  const box = { scrollWidth: 2312, scrollHeight: 1276, clientWidth: 200, clientHeight: 100 };
  assert.deepEqual(getZentrumOpeningScroll(box), {
    left: 2 * (x - ZENTRUM_SCHEMATIC_VIEWBOX.x) + width - 100,
    top: 2 * (y - ZENTRUM_SCHEMATIC_VIEWBOX.y) + height - 50,
  });
});

test("an opened stop is scrolled into view only when it lies near or past the edge", () => {
  // In the middle of the view: the plan stays where the reader left it.
  assert.equal(getZentrumRevealScroll(100, 250, 300), 100);
  // Past the far edge: just far enough to clear the margin, not centred.
  assert.equal(getZentrumRevealScroll(100, 450, 300), 450 - 300 + 15);
  // Before the near edge.
  assert.equal(getZentrumRevealScroll(100, 110, 300), 110 - 15);
});

test("a schematic coordinate is read as a share of the canvas it is drawn on", () => {
  const { x, y, width, height } = ZENTRUM_SCHEMATIC_VIEWBOX;
  assert.equal(toZentrumCanvasLeft(x), "0%");
  assert.equal(toZentrumCanvasLeft(x + width), "100%");
  assert.equal(toZentrumCanvasTop(y), "0%");
  assert.equal(toZentrumCanvasTop(y + height / 2), "50%");
});

test("a vehicle transform is anchored to the canvas origin, not the ride's first point", () => {
  const ride = {
    points: [
      { x: 858, y: 154 },
      { x: 726, y: 154 },
    ],
    steps: [0, 1],
  } as const;
  const progress = 0.5;
  const x = 858 + (726 - 858) * progress;
  const y = 154;

  assert.equal(
    getZentrumVehicleTransform(ride, progress),
    `translate3d(${toZentrumCanvasRun(x - ZENTRUM_SCHEMATIC_VIEWBOX.x)}, ${toZentrumCanvasRun(y - ZENTRUM_SCHEMATIC_VIEWBOX.y)}, 0) translate(-50%, -50%)`,
  );
});

test("reset fits the whole Zentrum into a portrait screen", () => {
  const box = { width: 372, height: 635 };
  const wholeWidth = getZentrumPlanWidth(box, 1, true)!;
  assert.ok(wholeWidth <= box.width);
  assert.ok(
    (wholeWidth * ZENTRUM_SCHEMATIC_VIEWBOX.height) / ZENTRUM_SCHEMATIC_VIEWBOX.width <= box.height,
  );
  assert.ok(getZentrumPlanWidth(box, 1)! > wholeWidth);
});
