/** The stop marks, laid out from the same corridors and lane width as the lanes they cross. */
import {
  type ZentrumSchematicBoardingPlace,
  type SchematicPoint,
  crossProduct,
  subtractPoints,
  type ZentrumSchematicEdge,
  type ZentrumSchematicNode,
  dotProduct,
  getTrackOffset,
  getUnitVector,
  orientCorridorRun,
  formatPoint,
  zentrumSchematicNodeById,
} from "./zentrum-schematic-plan";
/**
 * A stop's mark: rules laid square across the bands calling there, stroked as the capsule printed
 * network plans use. A dot would mark only the lane it sits on, and a hull around every lane
 * would cover the junction the lines turn through.
 *
 * A stop with named places to stand (`ZentrumSchematicBoardingPlace`) gets one rule per place, on
 * the corridor most its own (Karlstor: one on its eastern arm, one on its southern). Otherwise it
 * gets one rule per straight through it, crossed at the middle.
 */
export type ZentrumSchematicStopMark = {
  nodeId: string;
  /** The rules as one path of straight strokes, in schematic units. Painted, never filled. */
  data: string;
  /**
   * How far the stop's drawing reaches from its coordinate on each side a name may stand on.
   * Per side, not one radius: a rule pushed east would otherwise push the western name off too.
   */
  labelClearance: ZentrumSchematicLabelClearance;
};

/** How far a station's drawing reaches from its coordinate, per side a name may stand on. */
export type ZentrumSchematicLabelClearance = {
  left: number;
  right: number;
  above: number;
  below: number;
};

/** A capsule's width in lanes: a little wider than a lane, so it reads as across the lines. */
export const ZENTRUM_SCHEMATIC_STOP_CAPSULE_WIDTH = 1.15;

/** How much of the capsule's width is its white body; the rest is the outline either side. */
export const ZENTRUM_SCHEMATIC_STOP_CAPSULE_FILL = 0.62;

/** How far a rule reaches past the band's paint, in lanes, so it reads as crossing it. */
const ZENTRUM_SCHEMATIC_STOP_BAR_OVERHANG = 0.1;

/** How far, in lanes, a rule on one arm stands clear of the band crossing that arm. */
const ZENTRUM_SCHEMATIC_STOP_BAR_CLEARANCE = 1;

/** How far along its corridor a rule may be pushed, so it never lands on the next stop. */
const ZENTRUM_SCHEMATIC_STOP_BAR_MAXIMUM_REACH = 0.4;

/** One corridor as it leaves a stop: the way out, how far it runs, and the lanes it carries. */
type ZentrumSchematicNodeArm = {
  edge: ZentrumSchematicEdge;
  /** The stop at the far end, which is what a boarding place names its corridors by. */
  nodeId: string;
  outward: SchematicPoint;
  length: number;
};

const getNodeArms = (
  node: ZentrumSchematicNode,
  edges: readonly ZentrumSchematicEdge[],
): readonly ZentrumSchematicNodeArm[] =>
  edges.map((edge) => {
    const other = edge.from.id === node.id ? edge.to : edge.from;
    return {
      edge,
      nodeId: other.id,
      outward: getUnitVector(node, other),
      length: Math.hypot(other.x - node.x, other.y - node.y),
    };
  });

/** Whether two ways out of a stop are the two ends of one straight through it. */
const isOppositeArm = (left: ZentrumSchematicNodeArm, right: ZentrumSchematicNodeArm): boolean =>
  dotProduct(left.outward, right.outward) < -0.99;

/** How far the paint on a corridor's band reaches either side of the corridor's own middle. */
const getBandExtent = (
  arms: readonly ZentrumSchematicNodeArm[],
  trackWidth: number,
): { lowest: number; highest: number } => {
  const overhang = trackWidth * (0.5 + ZENTRUM_SCHEMATIC_STOP_BAR_OVERHANG);
  return {
    lowest: Math.min(...arms.map(({ edge }) => getTrackOffset(edge, 0, trackWidth))) - overhang,
    highest:
      Math.max(
        ...arms.map(({ edge }) => getTrackOffset(edge, edge.trackLineIds.length - 1, trackWidth)),
      ) + overhang,
  };
};

/**
 * One rule across the given arms' band, `reach` out along the first, laid on the same normal the
 * lanes are offset along. Two opposite arms are one band, crossed at the stop.
 */
const getStopBar = (
  node: ZentrumSchematicNode,
  arms: readonly ZentrumSchematicNodeArm[],
  reach: number,
  trackWidth: number,
): { from: SchematicPoint; to: SchematicPoint } => {
  const run = orientCorridorRun(arms[0].edge);
  const normal = { x: -run.y, y: run.x };
  const { lowest, highest } = getBandExtent(arms, trackWidth);
  const centre = {
    x: node.x + arms[0].outward.x * reach,
    y: node.y + arms[0].outward.y * reach,
  };
  return {
    from: { x: centre.x + normal.x * lowest, y: centre.y + normal.y * lowest },
    to: { x: centre.x + normal.x * highest, y: centre.y + normal.y * highest },
  };
};

type StopBar = { from: SchematicPoint; to: SchematicPoint };

/** One rule, and the arms whose lanes it is laid across. */
type StopBarEntry = { arms: readonly ZentrumSchematicNodeArm[]; bar: StopBar };

const getBarLength = (bar: StopBar): number =>
  Math.hypot(bar.to.x - bar.from.x, bar.to.y - bar.from.y);

/** Whether two sets of arms run the same way -- one street, or two places on it. */
const isParallelArms = (
  left: readonly ZentrumSchematicNodeArm[],
  right: readonly ZentrumSchematicNodeArm[],
): boolean =>
  left.some((one) =>
    right.some((other) => Math.abs(dotProduct(one.outward, other.outward)) > 0.99),
  );

/**
 * Drops a rule whose street another rule already crosses. A street meeting another at a slant
 * (Durlacher Tor) runs through the other's rule, and a second capsule would tangle with it; a
 * square crossing keeps both, since neither rule crosses the other's lanes.
 */
const dropCoveredBars = (
  node: ZentrumSchematicNode,
  entries: readonly StopBarEntry[],
  trackWidth: number,
): StopBar[] => {
  const laid: StopBarEntry[] = [];
  for (const entry of [...entries].sort(
    (left, right) => getBarLength(right.bar) - getBarLength(left.bar),
  )) {
    const isCovered = laid.some(
      (other) =>
        !isParallelArms(other.arms, entry.arms) &&
        crossesEveryLane(other.bar, node, entry.arms, trackWidth),
    );
    if (!isCovered) laid.push(entry);
  }
  return laid.map(({ bar }) => bar);
};

/** Whether a rule crosses every lane of a street through the stop, within its own length. */
const crossesEveryLane = (
  bar: StopBar,
  node: ZentrumSchematicNode,
  straight: readonly ZentrumSchematicNodeArm[],
  trackWidth: number,
): boolean => {
  const along = subtractPoints(bar.to, bar.from);
  return straight.every(({ edge }) => {
    const run = orientCorridorRun(edge);
    const normal = { x: -run.y, y: run.x };
    const denominator = crossProduct(run, along);
    if (Math.abs(denominator) < 1e-9) return false;
    return edge.trackLineIds.every((_, index) => {
      const offset = getTrackOffset(edge, index, trackWidth);
      const lane = { x: node.x + normal.x * offset, y: node.y + normal.y * offset };
      // Where the lane meets the rule, as a share of the rule's length.
      const share = crossProduct(run, subtractPoints(lane, bar.from)) / denominator;
      return share >= 0 && share <= 1;
    });
  });
};

/**
 * The arms a place is drawn on: those the stop's other places do not use, since every place
 * shares the busy corridor (at Karlstor, both run to Europaplatz). Else its own arms.
 */
const getPlaceArms = (
  place: ZentrumSchematicBoardingPlace,
  places: readonly ZentrumSchematicBoardingPlace[],
  arms: readonly ZentrumSchematicNodeArm[],
): readonly ZentrumSchematicNodeArm[] => {
  const own = arms.filter((arm) => place.armTripCounts.has(arm.nodeId));
  const shares = (arm: ZentrumSchematicNodeArm): number =>
    places.filter((other) => other !== place && other.armTripCounts.has(arm.nodeId)).length;
  const fewest = Math.min(...own.map(shares));
  return own.filter((arm) => shares(arm) === fewest);
};

/**
 * The rules one stop is drawn with. A place on a straight is crossed at the stop; a place on one
 * arm is pushed out along it, clear of the widest band crossing it, as far as the arm allows.
 */
const getNodeStopBars = (
  node: ZentrumSchematicNode,
  arms: readonly ZentrumSchematicNodeArm[],
  places: readonly ZentrumSchematicBoardingPlace[],
  trackWidth: number,
): StopBar[] => {
  const getStraightBar = (chosen: readonly ZentrumSchematicNodeArm[]): StopBarEntry | undefined => {
    const opposites = chosen.flatMap((arm, index) =>
      chosen.slice(index + 1).some((other) => isOppositeArm(arm, other)) ? [arm] : [],
    );
    const straight = opposites[0];
    if (!straight) return undefined;
    const straightArms = [straight, ...chosen.filter((arm) => isOppositeArm(straight, arm))];
    return { arms: straightArms, bar: getStopBar(node, straightArms, 0, trackWidth) };
  };
  const getArmBar = (arm: ZentrumSchematicNodeArm) => {
    // Outside the widest band crossing this arm, or it reads as a rule over the crossing.
    const crossing = arms.filter(
      (other) => other !== arm && !isOppositeArm(arm, other) && other.nodeId !== arm.nodeId,
    );
    const clearance = Math.max(
      ...crossing.map((other) => {
        const { lowest, highest } = getBandExtent([other], trackWidth);
        return Math.max(Math.abs(lowest), Math.abs(highest));
      }),
      0,
    );
    const reach = Math.min(
      clearance + trackWidth * ZENTRUM_SCHEMATIC_STOP_BAR_CLEARANCE,
      arm.length * ZENTRUM_SCHEMATIC_STOP_BAR_MAXIMUM_REACH,
    );
    return getStopBar(node, [arm], reach, trackWidth);
  };

  if (places.length < 2) {
    // One rule per straight, so a crossing is two rules rather than a star.
    const straights: ZentrumSchematicNodeArm[][] = [];
    for (const arm of arms) {
      const straight = straights.find((one) => isOppositeArm(one[0], arm));
      if (straight) straight.push(arm);
      else straights.push([arm]);
    }
    return dropCoveredBars(
      node,
      straights.map((straight) => ({
        arms: straight,
        bar: getStopBar(node, straight, 0, trackWidth),
      })),
      trackWidth,
    );
  }

  const placeBars = places.flatMap((place): StopBarEntry[] => {
    const chosen = getPlaceArms(place, places, arms);
    if (chosen.length === 0) return [];
    const straight = getStraightBar(chosen);
    if (straight) return [straight];
    const busiest = [...chosen].sort(
      (left, right) =>
        (place.armTripCounts.get(right.nodeId) ?? 0) -
          (place.armTripCounts.get(left.nodeId) ?? 0) || left.nodeId.localeCompare(right.nodeId),
    )[0];
    return [{ arms: [busiest], bar: getArmBar(busiest) }];
  });
  return dropCoveredBars(node, placeBars, trackWidth);
};

/**
 * The farthest a corridor may push a name off its stop, in band half widths. A corridor leaving
 * the way the name stands would otherwise push it to the next stop.
 */
const ZENTRUM_SCHEMATIC_LABEL_MAXIMUM_REACH = 2;

/** The four sides a name may stand on, as the direction it stands in from the stop. */
const LABEL_SIDE_DIRECTIONS = {
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
  above: { x: 0, y: -1 },
  below: { x: 0, y: 1 },
} as const;

/**
 * How far a name going one way from the stop travels before it is off a corridor's band: half the
 * width when square to it, capped when nearly along it, nothing when the corridor leaves behind it.
 */
const getArmReach = (
  arm: ZentrumSchematicNodeArm,
  trackWidth: number,
  direction: SchematicPoint,
): number => {
  const { lowest, highest } = getBandExtent([arm], trackWidth);
  const halfWidth = Math.max(Math.abs(lowest), Math.abs(highest));
  const normal = { x: -arm.outward.y, y: arm.outward.x };
  const across = Math.abs(dotProduct(normal, direction));
  return dotProduct(arm.outward, direction) > 0.05
    ? Math.min(
        halfWidth / Math.max(across, 0.35),
        halfWidth * ZENTRUM_SCHEMATIC_LABEL_MAXIMUM_REACH,
      )
    : halfWidth * across;
};

/** How far the stop's drawing reaches towards one side: its rules, and the bands leaving it. */
const getSideClearance = (
  node: ZentrumSchematicNode,
  arms: readonly ZentrumSchematicNodeArm[],
  bars: readonly { from: SchematicPoint; to: SchematicPoint }[],
  trackWidth: number,
  direction: SchematicPoint,
): number =>
  Math.max(
    0,
    // A capsule reaches its own half width past the rule it is stroked along, every way round.
    ...bars.flatMap((bar) =>
      [bar.from, bar.to].map(
        (point) =>
          (point.x - node.x) * direction.x +
          (point.y - node.y) * direction.y +
          (trackWidth * ZENTRUM_SCHEMATIC_STOP_CAPSULE_WIDTH) / 2,
      ),
    ),
    ...arms.map((arm) => getArmReach(arm, trackWidth, direction)),
  );

/** How far the station reaches from its coordinate, on each side a name may stand on. */
const getLabelClearance = (
  node: ZentrumSchematicNode,
  arms: readonly ZentrumSchematicNodeArm[],
  bars: readonly { from: SchematicPoint; to: SchematicPoint }[],
  trackWidth: number,
): ZentrumSchematicLabelClearance => ({
  left: getSideClearance(node, arms, bars, trackWidth, LABEL_SIDE_DIRECTIONS.left),
  right: getSideClearance(node, arms, bars, trackWidth, LABEL_SIDE_DIRECTIONS.right),
  above: getSideClearance(node, arms, bars, trackWidth, LABEL_SIDE_DIRECTIONS.above),
  below: getSideClearance(node, arms, bars, trackWidth, LABEL_SIDE_DIRECTIONS.below),
});

/** The rules each drawn stop is marked with, as wide as what calls there, one per named place. */
export const getZentrumSchematicStopMarks = (
  edges: readonly ZentrumSchematicEdge[],
  trackWidth: number,
  boardingPlacesByNodeId: ReadonlyMap<string, readonly ZentrumSchematicBoardingPlace[]>,
): readonly ZentrumSchematicStopMark[] => {
  const edgesByNodeId = new Map<string, ZentrumSchematicEdge[]>();
  for (const edge of edges) {
    for (const node of [edge.from, edge.to]) {
      edgesByNodeId.set(node.id, [...(edgesByNodeId.get(node.id) ?? []), edge]);
    }
  }
  return [...edgesByNodeId].flatMap(([nodeId, nodeEdges]): ZentrumSchematicStopMark[] => {
    const node = zentrumSchematicNodeById.get(nodeId);
    if (!node) return [];
    const arms = getNodeArms(node, nodeEdges);
    const bars = getNodeStopBars(node, arms, boardingPlacesByNodeId.get(nodeId) ?? [], trackWidth);
    // Two places can settle on the same rule; drawn twice it would only thicken.
    const dataByBar = new Map(
      bars.map((bar) => [
        `${formatPoint(bar.from)} ${formatPoint(bar.to)}`,
        `M ${formatPoint(bar.from)} L ${formatPoint(bar.to)}`,
      ]),
    );
    if (dataByBar.size === 0) return [];
    return [
      {
        nodeId,
        data: [...dataByBar.values()].join(" "),
        labelClearance: getLabelClearance(node, arms, bars, trackWidth),
      },
    ];
  });
};
