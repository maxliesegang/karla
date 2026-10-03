import { ZENTRUM_SCHEMATIC_VIEWBOX, type SchematicPoint } from "./zentrum-schematic-plan";
import { getZentrumSchematicVehiclePathPlacement } from "./zentrum-schematic-paths";

/** How much room the plan has been given, in CSS pixels. */
export type ZentrumPlanBox = { width: number; height: number };

/** Zoom steps; `1` is the whole Zentrum. */
export const ZENTRUM_ZOOM_STEPS = [1, 1.3, 1.7, 2.2, 2.9] as const;

export const ZENTRUM_MINIMUM_ZOOM = ZENTRUM_ZOOM_STEPS[0];
export const ZENTRUM_MAXIMUM_ZOOM = ZENTRUM_ZOOM_STEPS[ZENTRUM_ZOOM_STEPS.length - 1];

/** The step in or out from the current one, held at the ends of the range. */
export const getNeighboringZentrumZoom = (zoom: number, direction: 1 | -1): number => {
  const index = ZENTRUM_ZOOM_STEPS.indexOf(zoom as (typeof ZENTRUM_ZOOM_STEPS)[number]);
  const next = (index < 0 ? 0 : index) + direction;
  return ZENTRUM_ZOOM_STEPS[Math.min(Math.max(next, 0), ZENTRUM_ZOOM_STEPS.length - 1)];
};

/** How far a portrait box may pan, in multiples of its width. */
const ZENTRUM_PORTRAIT_PLAN_MAXIMUM_PAN = 3;

/**
 * The plan's drawn width at a zoom: landscape fits the whole plan; portrait fills the height and
 * pans sideways, as phone maps do. Undefined before measurement.
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
  // Floored, so a fractional pixel does not cause a scrollbar.
  return Math.floor(zoom * fitted);
};

/** A schematic coordinate as a share of the canvas width. */
export const toZentrumCanvasLeft = (x: number): string =>
  `${((x - ZENTRUM_SCHEMATIC_VIEWBOX.x) / ZENTRUM_SCHEMATIC_VIEWBOX.width) * 100}%`;

export const toZentrumCanvasTop = (y: number): string =>
  `${((y - ZENTRUM_SCHEMATIC_VIEWBOX.y) / ZENTRUM_SCHEMATIC_VIEWBOX.height) * 100}%`;

/** A plan distance as a share of the canvas width; the canvas keeps the drawing's ratio. */
export const toZentrumCanvasRun = (delta: number): string =>
  `${(delta / ZENTRUM_SCHEMATIC_VIEWBOX.width) * 100}cqw`;

/** Keeps one mark's animation alive between renders. */
export const getZentrumVehicleLinkKey = (
  fromId: string,
  toId: string,
  path: { points: readonly SchematicPoint[]; steps: readonly number[] },
): string =>
  [fromId, toId, path.points.map(({ x, y }) => `${x},${y}`).join(";"), path.steps.join(",")].join(
    ":",
  );

/** A mark's position as one transform from the canvas origin, shared by paint and keyframes. */
export const getZentrumVehicleTransform = (
  path: { points: readonly SchematicPoint[]; steps: readonly number[] },
  progress: number,
): string => {
  const placement = getZentrumSchematicVehiclePathPlacement(path, progress);
  return `translate3d(${toZentrumCanvasRun(placement.x - ZENTRUM_SCHEMATIC_VIEWBOX.x)}, ${toZentrumCanvasRun(placement.y - ZENTRUM_SCHEMATIC_VIEWBOX.y)}, 0) translate(-50%, -50%)`;
};
