/**
 * Where each stop's name is set: beside its capsule, on the first side the name fits without
 * crossing a band, a capsule or another name, as a printed network plan sets them.
 */
import {
  ZENTRUM_SCHEMATIC_NODES,
  ZENTRUM_SCHEMATIC_VIEWBOX,
  type SchematicPoint,
  type ZentrumSchematicEdge,
} from "./zentrum-schematic-plan";
import {
  ZENTRUM_SCHEMATIC_STOP_CAPSULE_WIDTH,
  ZENTRUM_SCHEMATIC_STOP_LINK_WIDTH,
  type ZentrumSchematicStopMark,
  type ZentrumSchematicStroke,
  getBandOutline,
  getStrokeOutline,
  isOverlapping,
} from "./zentrum-schematic-stops";

/** The sides a name may stand on, as the direction it stands in from its capsule. */
export type ZentrumLabelSide =
  | "right"
  | "left"
  | "above"
  | "below"
  | "above-right"
  | "below-right"
  | "above-left"
  | "below-left";

/** A placed name: the side it stands on, from the point it is set against, in schematic units. */
export type ZentrumSchematicLabel = {
  side: ZentrumLabelSide;
  anchor: SchematicPoint;
  /** Whether the name is clear of the drawing and every other name; else it is printed on demand. */
  fits: boolean;
};

/** Sides across the plan's grain first, so a name reads level beside the stop it names. */
const ZENTRUM_LABEL_SIDES: readonly ZentrumLabelSide[] = [
  "right",
  "left",
  "below",
  "above",
  "above-right",
  "below-right",
  "above-left",
  "below-left",
];

const LABEL_SIDE_DIRECTIONS: Record<ZentrumLabelSide, SchematicPoint> = {
  right: { x: 1, y: 0 },
  left: { x: -1, y: 0 },
  above: { x: 0, y: -1 },
  below: { x: 0, y: 1 },
  "above-right": { x: 1, y: -1 },
  "below-right": { x: 1, y: 1 },
  "above-left": { x: -1, y: -1 },
  "below-left": { x: -1, y: 1 },
};

/** The gap between a capsule and its name, in CSS pixels, whatever size the plan is drawn. */
const ZENTRUM_LABEL_GAP_PIXELS = 3;

/** How many distances, a lane apart, a name is tried at before it settles for a collision. */
const ZENTRUM_LABEL_RINGS = 3;

/** A stop name's type size at a plan width, mirroring `clamp(8px, 0.9cqw, 11.5px)` in the CSS. */
const getZentrumNameSize = (planWidth: number): number =>
  Math.min(11.5, Math.max(8, planWidth * 0.009));

/** The width a name wraps at, as `.zentrum-schematic-stop span` caps it. */
const ZENTRUM_NAME_MEASURE = 92;

/** A generous character width, so a name is never judged to fit too early. */
const ZENTRUM_NAME_CHARACTER_WIDTH = 0.62;

/** The padding `.zentrum-schematic-stop span` sets round a name, either way. */
const ZENTRUM_NAME_PADDING = { x: 3, y: 2 };

/** A name's set size in CSS pixels: it wraps at its spaces, so never narrower than its longest word. */
const getNamePixels = (
  label: string,
  planWidth: number,
  hasTime: boolean,
): { width: number; height: number } => {
  const size = getZentrumNameSize(planWidth);
  const character = size * ZENTRUM_NAME_CHARACTER_WIDTH;
  const longestWord = Math.max(...label.split(/\s+/).map((word) => word.length));
  const setWidth = label.length * character;
  const lines = Math.ceil(setWidth / ZENTRUM_NAME_MEASURE);
  const nameWidth = Math.max(longestWord * character, Math.min(setWidth, ZENTRUM_NAME_MEASURE));
  // The travel time heads the name a size up (`.zentrum-schematic-stop-time`): "S11 22 min".
  const time = hasTime
    ? { width: ZENTRUM_TIME_CHARACTERS * character * 1.15, height: size * 1.3 + 2 }
    : { width: 0, height: 0 };
  return {
    width: Math.max(nameWidth, time.width) + ZENTRUM_NAME_PADDING.x * 2,
    height: lines * size * 1.12 + time.height + ZENTRUM_NAME_PADDING.y * 2,
  };
};

/** The characters a travel time sets in, line badge included. */
const ZENTRUM_TIME_CHARACTERS = 9;

/** A name's set size in schematic units, on a plan drawn `planWidth` CSS pixels wide. */
const getNameSize = (
  label: string,
  planWidth: number | undefined,
  hasTime = false,
): { width: number; height: number } => {
  const width = planWidth ?? ZENTRUM_SCHEMATIC_VIEWBOX.width;
  const unitsPerPixel = ZENTRUM_SCHEMATIC_VIEWBOX.width / width;
  const pixels = getNamePixels(label, width, hasTime);
  return { width: pixels.width * unitsPerPixel, height: pixels.height * unitsPerPixel };
};

type Box = { left: number; top: number; right: number; bottom: number };

/** The box a placed name covers, in schematic units. */
export const getZentrumSchematicLabelBox = (
  { side, anchor }: ZentrumSchematicLabel,
  name: string,
  planWidth: number | undefined,
  hasTime = false,
): Box => getLabelBox(side, anchor, getNameSize(name, planWidth, hasTime));

/** The box a name of this size covers, set to one side of its anchor. */
const getLabelBox = (
  side: ZentrumLabelSide,
  anchor: SchematicPoint,
  { width, height }: { width: number; height: number },
): Box => {
  const direction = LABEL_SIDE_DIRECTIONS[side];
  // A name beside its anchor hangs off it: centred on the axis it does not move along.
  const left =
    direction.x > 0 ? anchor.x : direction.x < 0 ? anchor.x - width : anchor.x - width / 2;
  const top =
    direction.y > 0 ? anchor.y : direction.y < 0 ? anchor.y - height : anchor.y - height / 2;
  return { left, top, right: left + width, bottom: top + height };
};

const getBoxOutline = ({ left, top, right, bottom }: Box): readonly SchematicPoint[] => [
  { x: left, y: top },
  { x: right, y: top },
  { x: right, y: bottom },
  { x: left, y: bottom },
];

const getStrokeBox = (stroke: ZentrumSchematicStroke, halfWidth: number): Box => {
  const outline = getStrokeOutline(stroke, halfWidth);
  return {
    left: Math.min(...outline.map(({ x }) => x)),
    top: Math.min(...outline.map(({ y }) => y)),
    right: Math.max(...outline.map(({ x }) => x)),
    bottom: Math.max(...outline.map(({ y }) => y)),
  };
};

/** Where a name on one side of a capsule is set against: one gap clear of the capsule's box. */
const getAnchor = (box: Box, side: ZentrumLabelSide, gap: number): SchematicPoint => {
  const direction = LABEL_SIDE_DIRECTIONS[side];
  const pick = (low: number, high: number, sign: number) =>
    sign > 0 ? high + gap : sign < 0 ? low - gap : (low + high) / 2;
  return {
    x: pick(box.left, box.right, direction.x),
    y: pick(box.top, box.bottom, direction.y),
  };
};

/**
 * Every drawn stop's name, placed one at a time: the stops a reader steers by (where corridors
 * meet or end) first, so a through stop's name gives way to theirs. Each takes the first side, the
 * authored one leading, where it is inside the plan and clear of every band, capsule and name
 * already set; where no side is, the one with the fewest collisions.
 *
 * Sized for a plan `planWidth` CSS pixels wide, since names keep their type size as the plan grows,
 * and with room for a travel time over each name where the plan prints them (`hasTimes`).
 */
export const placeZentrumSchematicLabels = (
  edges: readonly ZentrumSchematicEdge[],
  stopMarks: readonly ZentrumSchematicStopMark[],
  trackWidth: number,
  planWidth: number | undefined,
  hasTimes = false,
): ReadonlyMap<string, ZentrumSchematicLabel> => {
  const width = planWidth ?? ZENTRUM_SCHEMATIC_VIEWBOX.width;
  const unitsPerPixel = ZENTRUM_SCHEMATIC_VIEWBOX.width / width;
  const gap = ZENTRUM_LABEL_GAP_PIXELS * unitsPerPixel;
  const capsuleHalfWidth = (trackWidth * ZENTRUM_SCHEMATIC_STOP_CAPSULE_WIDTH) / 2;
  const linkHalfWidth = (trackWidth * ZENTRUM_SCHEMATIC_STOP_LINK_WIDTH) / 2;
  const obstacles: (readonly SchematicPoint[])[] = [
    ...edges.map((edge) => getBandOutline(edge, trackWidth)),
    ...stopMarks.flatMap(({ capsules, links }) => [
      ...capsules.map((capsule) => getStrokeOutline(capsule, capsuleHalfWidth)),
      ...links.map((link) => getStrokeOutline(link, linkHalfWidth)),
    ]),
  ];
  const plan = {
    left: ZENTRUM_SCHEMATIC_VIEWBOX.x,
    top: ZENTRUM_SCHEMATIC_VIEWBOX.y,
    right: ZENTRUM_SCHEMATIC_VIEWBOX.x + ZENTRUM_SCHEMATIC_VIEWBOX.width,
    bottom: ZENTRUM_SCHEMATIC_VIEWBOX.y + ZENTRUM_SCHEMATIC_VIEWBOX.height,
  };

  // Each name's candidates, scored once against the drawing, which does not move as names are set.
  const markByNodeId = new Map(stopMarks.map((mark) => [mark.nodeId, mark]));
  const pending = ZENTRUM_SCHEMATIC_NODES.flatMap((node) => {
    const mark = markByNodeId.get(node.id);
    if (!mark) return [];
    const size = getNameSize(node.label, planWidth, hasTimes);
    const box = getStrokeBox(mark.main, capsuleHalfWidth);
    const sides = node.labelSide
      ? [node.labelSide, ...ZENTRUM_LABEL_SIDES.filter((side) => side !== node.labelSide)]
      : ZENTRUM_LABEL_SIDES;
    // Every side close in first, then every side a lane further out: a name a crossing band
    // keeps from its capsule still stands beside the stop rather than on the band.
    const candidates = Array.from({ length: ZENTRUM_LABEL_RINGS }, (_, ring) =>
      sides.map((side) => {
        const anchor = getAnchor(box, side, gap + ring * trackWidth);
        const labelBox = getLabelBox(side, anchor, size);
        const outline = getBoxOutline(labelBox);
        const isInside =
          labelBox.left >= plan.left &&
          labelBox.top >= plan.top &&
          labelBox.right <= plan.right &&
          labelBox.bottom <= plan.bottom;
        const collisions = obstacles.filter((obstacle) => isOverlapping(outline, obstacle)).length;
        return { side, anchor, labelBox, cost: collisions + (isInside ? 0 : 100) };
      }),
    ).flat();
    return [{ nodeId: node.id, candidates }];
  });

  // The name with the fewest free candidates left is set next, on whichever of its free ones takes
  // the fewest from the names still waiting: a name with room to spare gives way to one squeezed
  // between its neighbours. A name with no free candidate left does not fit. It is set on its least
  // crowded candidate, printed only where it is pointed at, and keeps nothing clear of itself.
  type Candidate = (typeof pending)[number]["candidates"][number];
  const placed: Box[] = [];
  const getCost = (candidate: Candidate) =>
    candidate.cost + placed.filter((box) => isBoxOverlapping(candidate.labelBox, box)).length;
  const labels = new Map<string, ZentrumSchematicLabel>();
  const waiting = [...pending];
  while (waiting.length > 0) {
    const freeCounts = waiting.map(
      ({ candidates }) => candidates.filter((candidate) => getCost(candidate) === 0).length,
    );
    const fewest = Math.min(
      ...freeCounts.map((count) => (count === 0 ? Number.POSITIVE_INFINITY : count)),
    );
    const [{ nodeId, candidates }] = waiting.splice(Math.max(freeCounts.indexOf(fewest), 0), 1);
    const free = waiting.flatMap((other) =>
      other.candidates.filter((candidate) => getCost(candidate) === 0),
    );
    const getBlocking = ({ labelBox }: Candidate) =>
      free.filter((other) => isBoxOverlapping(labelBox, other.labelBox)).length;
    const best = candidates.reduce((chosen, candidate) =>
      getCost(candidate) < getCost(chosen) ||
      (getCost(candidate) === 0 &&
        getCost(chosen) === 0 &&
        getBlocking(candidate) < getBlocking(chosen))
        ? candidate
        : chosen,
    );
    const fits = getCost(best) === 0;
    labels.set(nodeId, { side: best.side, anchor: best.anchor, fits });
    if (fits) placed.push(best.labelBox);
  }
  return labels;
};

const isBoxOverlapping = (left: Box, right: Box): boolean =>
  left.left < right.right &&
  right.left < left.right &&
  left.top < right.bottom &&
  right.top < left.bottom;
