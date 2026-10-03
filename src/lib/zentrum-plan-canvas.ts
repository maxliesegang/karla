import { ZENTRUM_SCHEMATIC_VIEWBOX, type SchematicPoint } from "./zentrum-schematic-plan";
import { getZentrumSchematicVehiclePathPlacement } from "./zentrum-schematic-paths";

/** How much room the plan has been given, in CSS pixels. */
export type ZentrumPlanBox = { width: number; height: number };

/**
 * How far the plan may be blown up past its box. It opens at `1`, the whole Zentrum: a plan of a
 * place is read whole first and in detail second.
 */
export const ZENTRUM_ZOOM_STEPS = [1, 1.3, 1.7, 2.2, 2.9] as const;

export const ZENTRUM_MINIMUM_ZOOM = ZENTRUM_ZOOM_STEPS[0];
export const ZENTRUM_MAXIMUM_ZOOM = ZENTRUM_ZOOM_STEPS[ZENTRUM_ZOOM_STEPS.length - 1];

/** The step in or out from the current one, held at the ends of the range. */
export const getNeighboringZentrumZoom = (zoom: number, direction: 1 | -1): number => {
  const index = ZENTRUM_ZOOM_STEPS.indexOf(zoom as (typeof ZENTRUM_ZOOM_STEPS)[number]);
  const next = (index < 0 ? 0 : index) + direction;
  return ZENTRUM_ZOOM_STEPS[Math.min(Math.max(next, 0), ZENTRUM_ZOOM_STEPS.length - 1)];
};

/** The farthest a portrait box may be panned, in multiples of its own width. */
const ZENTRUM_PORTRAIT_PLAN_MAXIMUM_PAN = 3;

/**
 * How wide the plan is drawn in its box at a zoom.
 *
 * A landscape box fits the whole plan. A portrait box (a phone held upright) is filled by its
 * height and panned sideways, as maps on phones are: fitted to the width, the plan would be a
 * finger's breadth tall with no room for a single name. Undefined before the first measurement.
 */
export const getZentrumPlanWidth = (
  box: ZentrumPlanBox | null,
  zoom: number,
): number | undefined => {
  if (!box) return undefined;
  const heightWidth =
    (box.height * ZENTRUM_SCHEMATIC_VIEWBOX.width) / ZENTRUM_SCHEMATIC_VIEWBOX.height;
  const fitted =
    box.height > box.width
      ? Math.min(heightWidth, box.width * ZENTRUM_PORTRAIT_PLAN_MAXIMUM_PAN)
      : Math.min(box.width, heightWidth);
  // Floored: a fractional pixel of overflow is a scrollbar on a plan that already fits.
  return Math.floor(zoom * fitted);
};

/** A schematic coordinate as a share of the canvas, which is what stretches with its width. */
export const toZentrumCanvasLeft = (x: number): string =>
  `${((x - ZENTRUM_SCHEMATIC_VIEWBOX.x) / ZENTRUM_SCHEMATIC_VIEWBOX.width) * 100}%`;

export const toZentrumCanvasTop = (y: number): string =>
  `${((y - ZENTRUM_SCHEMATIC_VIEWBOX.y) / ZENTRUM_SCHEMATIC_VIEWBOX.height) * 100}%`;

/**
 * A distance on the plan as a share of the canvas width. The canvas keeps the drawing's ratio, so
 * one unit serves both axes, and container units re-resolve on zoom without re-measuring.
 */
export const toZentrumCanvasRun = (delta: number): string =>
  `${(delta / ZENTRUM_SCHEMATIC_VIEWBOX.width) * 100}cqw`;

/** The identity that keeps one mark's animation alive between renders. */
export const getZentrumVehicleLinkKey = (
  fromId: string,
  toId: string,
  path: { points: readonly SchematicPoint[]; steps: readonly number[] },
): string =>
  [fromId, toId, path.points.map(({ x, y }) => `${x},${y}`).join(";"), path.steps.join(",")].join(
    ":",
  );

/**
 * A mark's whole position as one transform, anchored at the canvas origin. The static paint and
 * the animation keyframes both use it, so a handover between them is seamless.
 */
export const getZentrumVehicleTransform = (
  path: { points: readonly SchematicPoint[]; steps: readonly number[] },
  progress: number,
): string => {
  const placement = getZentrumSchematicVehiclePathPlacement(path, progress);
  return `translate3d(${toZentrumCanvasRun(placement.x - ZENTRUM_SCHEMATIC_VIEWBOX.x)}, ${toZentrumCanvasRun(placement.y - ZENTRUM_SCHEMATIC_VIEWBOX.y)}, 0) translate(-50%, -50%)`;
};
