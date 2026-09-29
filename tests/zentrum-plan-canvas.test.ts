import assert from "node:assert/strict";
import test from "node:test";
import {
  getNeighboringZentrumZoom,
  getZentrumPlanWidth,
  getZentrumVehicleTransform,
  toZentrumCanvasLeft,
  toZentrumCanvasTop,
  toZentrumCanvasRun,
  ZENTRUM_MAXIMUM_ZOOM,
  ZENTRUM_MINIMUM_ZOOM,
  ZENTRUM_ZOOM_STEPS,
} from "../src/lib/zentrum-plan-canvas.ts";
import { ZENTRUM_SCHEMATIC_VIEWBOX } from "../src/lib/zentrum-schematic-plan.ts";

test("the plan opens whole, and steps stop at both ends of the range", () => {
  assert.equal(ZENTRUM_ZOOM_STEPS[0], 1);
  assert.equal(getNeighboringZentrumZoom(ZENTRUM_MINIMUM_ZOOM, -1), ZENTRUM_MINIMUM_ZOOM);
  assert.equal(getNeighboringZentrumZoom(ZENTRUM_MAXIMUM_ZOOM, 1), ZENTRUM_MAXIMUM_ZOOM);
  assert.equal(getNeighboringZentrumZoom(ZENTRUM_ZOOM_STEPS[0], 1), ZENTRUM_ZOOM_STEPS[1]);
  assert.equal(getNeighboringZentrumZoom(ZENTRUM_ZOOM_STEPS[2], -1), ZENTRUM_ZOOM_STEPS[1]);
  // A step out of a width the steps do not name lands back on the range rather than nowhere.
  assert.equal(getNeighboringZentrumZoom(1.42, 1), ZENTRUM_ZOOM_STEPS[1]);
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

test("a portrait box is filled by its height and panned, not fitted to a stripe", () => {
  const ratio = ZENTRUM_SCHEMATIC_VIEWBOX.width / ZENTRUM_SCHEMATIC_VIEWBOX.height;
  // A phone: the whole plan across the width would be a stripe in a box the length of the screen,
  // so the plan is drawn down the height and the box pans sideways to the rest of it.
  assert.equal(getZentrumPlanWidth({ width: 420, height: 620 }, 1), Math.floor(620 * ratio));
  // However tall the box, the panning stops: a plan is not read three screens at a time.
  assert.equal(getZentrumPlanWidth({ width: 360, height: 4000 }, 1), 1080);
  // A landscape panel still opens on the whole plan, fitted to whichever dimension runs out first.
  assert.equal(getZentrumPlanWidth({ width: 900, height: 300 }, 1), Math.floor(300 * ratio));
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
