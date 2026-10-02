import {
  ZENTRUM_SCHEMATIC_VIEWBOX,
  type SchematicPoint,
  type ZentrumSchematicNode,
} from "./zentrum-schematic-plan";
import { getZentrumSchematicVehiclePathPlacement } from "./zentrum-schematic-paths";

/** How much room the plan has been given, in CSS pixels. */
export type ZentrumPlanBox = { width: number; height: number };

/**
 * How far the plan may be blown up past the box it is given.
 *
 * `1` is the whole Zentrum at once, and it is where the plan opens: a plan of a place is read
 * whole first and in detail second, and a reader who arrives already scrolled has to find the
 * Zentrum before they can read it. Stops are drawn as rules, so the whole plan is legible in the box
 * the panel gives it.
 */
export const ZENTRUM_ZOOM_STEPS = [1, 1.3, 1.7, 2.2, 2.9] as const;

export const ZENTRUM_MINIMUM_ZOOM = ZENTRUM_ZOOM_STEPS[0];
export const ZENTRUM_MAXIMUM_ZOOM = ZENTRUM_ZOOM_STEPS[ZENTRUM_ZOOM_STEPS.length - 1];

/** The step in or out from the one being read at; the ends of the range answer for themselves. */
export const getNeighboringZentrumZoom = (zoom: number, direction: 1 | -1): number => {
  const index = ZENTRUM_ZOOM_STEPS.indexOf(zoom as (typeof ZENTRUM_ZOOM_STEPS)[number]);
  const next = (index < 0 ? 0 : index) + direction;
  return ZENTRUM_ZOOM_STEPS[Math.min(Math.max(next, 0), ZENTRUM_ZOOM_STEPS.length - 1)];
};

/**
 * The farthest a portrait box may be panned, as a multiple of its own width.
 *
 * A box can be far taller than it is wide, and filling its height with a plan two and a half times
 * as wide as it is tall would ask a reader to pan half the morning to cross the
 * Kaiserstraße. Three screens is a phone held upright showing the plan down its whole height, and
 * is where the panning stops.
 */
const ZENTRUM_PORTRAIT_PLAN_MAXIMUM_PAN = 3;

/**
 * How wide the plan is drawn in the box it was given, at the zoom it is being read at.
 *
 * A box shaped roughly like the plan is given the whole of it, fitted to whichever dimension runs
 * out first, and the zoom grows it from there. A box shaped nothing like it — a phone held
 * upright, a portrait panel — is filled by its height instead and panned sideways, which is how
 * every map on a phone is read. Fitting one of those by the width drew the Zentrum a finger's
 * breadth tall in a box the length of the screen, with two thirds of the box empty and every name
 * withheld for want of room to print it: the whole plan, at a size nothing on it could be read at.
 *
 * Before the first measurement there is no width to state, and the drawing takes the room CSS
 * gives it.
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
  // Floored: a plan fitted to a fractional pixel of its box overflows it by a hair, and a hair of
  // overflow is a scrollbar down the side of a plan that is already whole on screen.
  return Math.floor(zoom * fitted);
};

/** A schematic coordinate as a share of the canvas, which is what stretches with its width. */
export const toZentrumCanvasLeft = (x: number): string =>
  `${((x - ZENTRUM_SCHEMATIC_VIEWBOX.x) / ZENTRUM_SCHEMATIC_VIEWBOX.width) * 100}%`;

export const toZentrumCanvasTop = (y: number): string =>
  `${((y - ZENTRUM_SCHEMATIC_VIEWBOX.y) / ZENTRUM_SCHEMATIC_VIEWBOX.height) * 100}%`;

/**
 * A corridor's run as a share of the canvas' *width*.
 *
 * The canvas keeps the drawing's own ratio, so one unit answers for both axes: a run across the
 * height is the same share of the width, read through the ratio the canvas is laid out at. Stated
 * in container units, the run re-resolves wherever the plan is blown up to — a zoomed plan carries
 * its moving marks with it, and no animation has to be re-measured to follow.
 */
export const toZentrumCanvasRun = (delta: number): string =>
  `${(delta / ZENTRUM_SCHEMATIC_VIEWBOX.width) * 100}cqw`;

/** The identity used to keep one centre-map mark's animation alive between renders. */
export const getZentrumVehicleLinkKey = (
  fromId: string,
  toId: string,
  path: { points: readonly SchematicPoint[]; steps: readonly number[] },
): string =>
  [fromId, toId, path.points.map(({ x, y }) => `${x},${y}`).join(";"), path.steps.join(",")].join(
    ":",
  );

/**
 * One mark's whole position in one property, at a progress along its vehicle path.
 *
 * The static paint and the animated keyframes are stated by this one reading, so the frame an
 * animation starts in agrees with the mark it replaces. The mark is anchored at the canvas origin
 * and the translate carries it across the plan in live container units; the keyframes are taken
 * at the path's own points, so the compositor's straight interpolation between them follows the
 * bend the stroke draws rather than cutting across it. Because every corridor shares the canvas
 * coordinate system, link handovers and replans share the same origin and transition seamlessly.
 * The centre anchoring follows the vehicle path, because the animation replaces the property wholesale.
 */
export const getZentrumVehicleTransform = (
  path: { points: readonly SchematicPoint[]; steps: readonly number[] },
  progress: number,
): string => {
  const placement = getZentrumSchematicVehiclePathPlacement(path, progress);
  return `translate3d(${toZentrumCanvasRun(placement.x - ZENTRUM_SCHEMATIC_VIEWBOX.x)}, ${toZentrumCanvasRun(placement.y - ZENTRUM_SCHEMATIC_VIEWBOX.y)}, 0) translate(-50%, -50%)`;
};

/**
 * The type size a stop's name is set at on a plan of this width, as the stylesheet sets it:
 * `clamp(8px, 0.9cqw, 11.5px)` on `.zentrum-schematic-stop`, the canvas being the container.
 */
const getZentrumNameSize = (planWidth: number): number =>
  Math.min(11.5, Math.max(8, planWidth * 0.009));

/** How wide a name may be set before it wraps, as `.zentrum-schematic-stop span` caps it. */
const ZENTRUM_NAME_MEASURE = 92;

/** A generous width for one character of the plan's face, so a name is never judged to fit early. */
const ZENTRUM_NAME_CHARACTER_WIDTH = 0.62;

type ZentrumLabelSide = NonNullable<ZentrumSchematicNode["labelSide"]>;

/**
 * The sides tried, in order, for a name that does not fit on the side it was authored for: across
 * the stop's own axis first, where the corridors it was authored clear of are least likely to run.
 */
const ZENTRUM_LABEL_SIDE_FALLBACKS: Record<ZentrumLabelSide, readonly ZentrumLabelSide[]> = {
  below: ["right", "left", "above"],
  above: ["right", "left", "below"],
  left: ["below", "above", "right"],
  right: ["below", "above", "left"],
};

/**
 * The side a stop's name is set on, at the width the plan is drawn.
 *
 * The side is authored for a plan with room around it, and at the smallest size names stop
 * shrinking long before the plan does: on a phone, Mühlburger Tor's name ran off the left edge of a
 * plan that left it a finger's width to stand in, and a desktop plan fitted to its height cut
 * Albtalbahnhof's off at the foot. A name that would reach past the plan's edge on its authored side
 * is set on the first side it fits on, measured past what the stop draws on that side
 * (`labelClearance`, in plan units), and keeps its authored side where none fits.
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
  // A name wraps at its spaces up to its measure, so it is never narrower than its longest word.
  const longestWord = Math.max(...node.label.split(/\s+/).map((word) => word.length));
  const setWidth = node.label.length * character;
  const width = Math.max(longestWord * character, Math.min(setWidth, ZENTRUM_NAME_MEASURE));
  // Two lines where it wraps, at the line height and padding the stylesheet sets it with.
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
