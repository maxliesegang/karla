import assert from "node:assert/strict";
import test from "node:test";
import {
  getNeighbouringZentrumZoom,
  getZentrumPlanWidth,
  toZentrumCanvasLeft,
  toZentrumCanvasTop,
  ZENTRUM_MAXIMUM_ZOOM,
  ZENTRUM_MINIMUM_ZOOM,
  ZENTRUM_ZOOM_STEPS,
} from "../src/lib/zentrum-plan-canvas.ts";
import { ZENTRUM_SCHEMATIC_VIEWBOX } from "../src/lib/zentrum-schematic-plan.ts";

test("the plan opens whole, and steps stop at both ends of the range", () => {
  assert.equal(ZENTRUM_ZOOM_STEPS[0], 1);
  assert.equal(getNeighbouringZentrumZoom(ZENTRUM_MINIMUM_ZOOM, -1), ZENTRUM_MINIMUM_ZOOM);
  assert.equal(getNeighbouringZentrumZoom(ZENTRUM_MAXIMUM_ZOOM, 1), ZENTRUM_MAXIMUM_ZOOM);
  assert.equal(getNeighbouringZentrumZoom(ZENTRUM_ZOOM_STEPS[0], 1), ZENTRUM_ZOOM_STEPS[1]);
  assert.equal(getNeighbouringZentrumZoom(ZENTRUM_ZOOM_STEPS[2], -1), ZENTRUM_ZOOM_STEPS[1]);
  // A step out of a width the steps do not name lands back on the range rather than nowhere.
  assert.equal(getNeighbouringZentrumZoom(1.42, 1), ZENTRUM_ZOOM_STEPS[1]);
});

test("the whole plan is drawn inside the box, in whichever dimension runs out first", () => {
  const ratio = ZENTRUM_SCHEMATIC_VIEWBOX.width / ZENTRUM_SCHEMATIC_VIEWBOX.height;
  // A box taller than the plan's ratio is bounded by its width.
  assert.equal(getZentrumPlanWidth({ width: 600, height: 900 }, 1), 600);
  // A box wider than it is bounded by its height, and the drawing keeps its own ratio.
  assert.equal(getZentrumPlanWidth({ width: 4000, height: 300 }, 1), 300 * ratio);
  // The zoom grows the fitted plan rather than the box.
  assert.equal(getZentrumPlanWidth({ width: 600, height: 900 }, 1.3), 780);
  // Before the box has been measured the drawing is given no width, and CSS decides.
  assert.equal(getZentrumPlanWidth(null, 1), undefined);
});

test("a schematic coordinate is read as a share of the canvas it is drawn on", () => {
  const { x, y, width, height } = ZENTRUM_SCHEMATIC_VIEWBOX;
  assert.equal(toZentrumCanvasLeft(x), "0%");
  assert.equal(toZentrumCanvasLeft(x + width), "100%");
  assert.equal(toZentrumCanvasTop(y), "0%");
  assert.equal(toZentrumCanvasTop(y + height / 2), "50%");
});
