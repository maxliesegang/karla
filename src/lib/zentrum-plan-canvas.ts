import {
  ZENTRUM_SCHEMATIC_VIEWBOX,
  type SchematicPoint,
  type ZentrumSchematicNode,
} from "./zentrum-schematic-plan";
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

/** A stop name's type size at a plan width, mirroring `clamp(8px, 0.9cqw, 11.5px)` in the CSS. */
const getZentrumNameSize = (planWidth: number): number =>
  Math.min(11.5, Math.max(8, planWidth * 0.009));

/** The width a name wraps at, as `.zentrum-schematic-stop span` caps it. */
const ZENTRUM_NAME_MEASURE = 92;

/** A generous character width, so a name is never judged to fit too early. */
const ZENTRUM_NAME_CHARACTER_WIDTH = 0.62;

type ZentrumLabelSide = NonNullable<ZentrumSchematicNode["labelSide"]>;

/** The sides tried for a name that does not fit its authored side, across the stop's axis first. */
const ZENTRUM_LABEL_SIDE_FALLBACKS: Record<ZentrumLabelSide, readonly ZentrumLabelSide[]> = {
  below: ["right", "left", "above"],
  above: ["right", "left", "below"],
  left: ["below", "above", "right"],
  right: ["below", "above", "left"],
};

/**
 * The side a stop's name is set on at this plan width.
 *
 * Names stop shrinking long before the plan does, so on a small plan a name can run off its edge.
 * It then moves to the first side it fits on, measured past what the stop draws there
 * (`labelClearance`), and keeps its authored side where none fits.
 */
export const getZentrumLabelSide = (
  node: ZentrumSchematicNode,
  planWidth: number | undefined,
  labelClearance?: Readonly<Record<ZentrumLabelSide, number>>,
): ZentrumLabelSide => {
  const authored = node.labelSide ?? "below";
  if (planWidth === undefined) return authored;
  const unit = planWidth / ZENTRUM_SCHEMATIC_VIEWBOX.width;
  const size = getZentrumNameSize(planWidth);
  const character = size * ZENTRUM_NAME_CHARACTER_WIDTH;
  // A name wraps at its spaces, so it is never narrower than its longest word.
  const longestWord = Math.max(...node.label.split(/\s+/).map((word) => word.length));
  const setWidth = node.label.length * character;
  const width = Math.max(longestWord * character, Math.min(setWidth, ZENTRUM_NAME_MEASURE));
  // Line height and padding as the stylesheet sets them.
  const height = (setWidth > ZENTRUM_NAME_MEASURE ? 2 : 1) * size * 1.12 + 4;
  const { x, y, width: planUnits, height: planHeight } = ZENTRUM_SCHEMATIC_VIEWBOX;
  const edgeDistance: Record<ZentrumLabelSide, number> = {
    left: node.x - x,
    right: x + planUnits - node.x,
    above: node.y - y,
    below: y + planHeight - node.y,
  };
  const fits = (side: ZentrumLabelSide): boolean =>
    (edgeDistance[side] - (labelClearance?.[side] ?? 0)) * unit >=
    (side === "left" || side === "right" ? width : height);
  if (fits(authored)) return authored;
  return ZENTRUM_LABEL_SIDE_FALLBACKS[authored].find(fits) ?? authored;
};
