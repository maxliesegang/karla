/**
 * The mark a stop is drawn as: a rule laid across the lines calling there.
 *
 * Laid out from the same corridors and the same lane width the lanes themselves are, so a stop's
 * rule crosses exactly what is drawn beneath it.
 */
import {
  type ZentrumSchematicBoardingPlace,
  type SchematicPoint,
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
 * The mark a stop is drawn as: a rule laid across the lines calling there.
 *
 * The plan draws every line in its own lane, so a dot on the middle of a corridor sits on whichever
 * lane happens to run through it and leaves the rest unmarked -- the lines beside it read as
 * passing the stop rather than calling at it. The mark therefore has to reach every lane that meets
 * here. It was a hull for a while, LOOM's rectangulised station polygon, and a hull is the wrong
 * shape for this plan: wide enough to reach every lane on every corridor, it becomes a lozenge as
 * large as the junction it stands on, and the corner the lines turn through -- the one thing a
 * junction is read for -- is drawn inside a white box. Twenty-five of them are what a reader sees
 * first, above the network they are meant to annotate.
 *
 * So the mark is the tick every printed transit plan uses: one fine rule across the band, square to
 * the corridor it crosses. It costs the drawing nothing, it never covers a colour for longer than
 * its own width, and it is the same mark at every stop whatever the corridors do there.
 *
 * A junction gets one rule per place to stand rather than one per corridor. Where the reading has
 * named a stop's places (`ZentrumSchematicBoardingPlace`) each of them is drawn on the corridor
 * that is most its own, standing clear of the bands crossing it: Karlstor comes out with a rule on
 * its eastern arm and one on its southern, which is where its platforms are. Where the reading has
 * named none, the stop is drawn with one rule for each straight through it, crossed at the middle.
 */
export type ZentrumSchematicStopMark = {
  nodeId: string;
  /** The rules as one path of straight strokes, in schematic units. Painted, never filled. */
  data: string;
  /**
   * How far the station reaches from its authored coordinate, on each of the four sides a name may
   * stand on.
   *
   * One enclosing radius was the reading before this, and a radius is the wrong measure: a rule
   * pushed out along Karlstor's eastern arm is two lane widths east of the coordinate and nothing
   * at all west of it, yet the radius spaced the western name off by the whole of that reach. The
   * name then floated a band's width clear of the station it names, which on a plan of
   * twenty-five names is the difference between reading a label and hunting for its stop. Each
   * side is therefore measured on its own, over the rules drawn here and over the paint of every
   * corridor leaving the stop, so a name stands exactly clear of what is drawn on its side and no
   * further.
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

/**
 * How far past the band's paint each rule reaches, as a multiple of one lane's width.
 *
 * Enough that the rule reads as crossing the band rather than as being clipped by it, and no more:
 * the overhang is the whole of what the mark adds to the drawing's footprint.
 */
const ZENTRUM_SCHEMATIC_STOP_BAR_OVERHANG = 0.55;

/**
 * How far a rule stands clear of a band crossing its corridor, as a multiple of one lane's width.
 *
 * A place drawn on one arm of a junction has to be outside the traffic running across that arm,
 * or it reads as a rule over the crossing rather than as a platform on the arm.
 */
const ZENTRUM_SCHEMATIC_STOP_BAR_CLEARANCE = 1;

/**
 * How far along its corridor a rule may be pushed, as a share of the corridor's length.
 *
 * The Zentrum has corridors one grid step long. A rule pushed clear of a wide crossing band would
 * land on the next stop along, so the clearance gives way to the corridor.
 */
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
 * One rule across the band of the corridors given, standing `reach` out along the first of them.
 *
 * The rule is laid on the corridor's oriented normal, which is the same measurement the lanes
 * themselves are offset along, so it crosses the band it is drawn from squarely however the edge
 * happens to be stated. Two opposite arms hand in one band and are crossed at the stop itself.
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

/**
 * The arms a place is drawn on: the ones that are most its own.
 *
 * Every place at a junction shares the busy corridor through it -- at Karlstor both places run to
 * Europaplatz -- so the corridor that says which place this is, is the one the others do not use.
 * Where the places share everything, a place is simply drawn on its own arms, which is what a stop
 * with one place is drawn on anyway.
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
 * The rules one stop is drawn with, given the places to stand the reading has named there.
 *
 * A place standing on a straight -- both ways out of one street -- is crossed at the stop itself,
 * because that is where a platform on a street is. A place standing on one arm is pushed out along
 * it until it is clear of the widest band crossing that arm, or as far as the arm allows.
 */
const getNodeStopBars = (
  node: ZentrumSchematicNode,
  arms: readonly ZentrumSchematicNodeArm[],
  places: readonly ZentrumSchematicBoardingPlace[],
  trackWidth: number,
): { from: SchematicPoint; to: SchematicPoint }[] => {
  const getStraightBar = (chosen: readonly ZentrumSchematicNodeArm[]) => {
    const opposites = chosen.flatMap((arm, index) =>
      chosen.slice(index + 1).some((other) => isOppositeArm(arm, other)) ? [arm] : [],
    );
    const straight = opposites[0];
    return straight
      ? getStopBar(
          node,
          [straight, ...chosen.filter((arm) => isOppositeArm(straight, arm))],
          0,
          trackWidth,
        )
      : undefined;
  };
  const getArmBar = (arm: ZentrumSchematicNodeArm) => {
    // Clear of the crossing traffic: how far the widest band that is not on this straight reaches
    // across it, which is what the rule has to stand outside to read as a platform on this arm.
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
    // One straight at a time, so a crossing is two rules over each other rather than a star: the
    // arms of one street hand in one band and are crossed once, at the stop.
    const straights: ZentrumSchematicNodeArm[][] = [];
    for (const arm of arms) {
      const straight = straights.find((one) => isOppositeArm(one[0], arm));
      if (straight) straight.push(arm);
      else straights.push([arm]);
    }
    return straights.map((straight) => getStopBar(node, straight, 0, trackWidth));
  }

  return places.flatMap((place) => {
    const chosen = getPlaceArms(place, places, arms);
    if (chosen.length === 0) return [];
    const straight = getStraightBar(chosen);
    if (straight) return [straight];
    const busiest = [...chosen].sort(
      (left, right) =>
        (place.armTripCounts.get(right.nodeId) ?? 0) -
          (place.armTripCounts.get(left.nodeId) ?? 0) || left.nodeId.localeCompare(right.nodeId),
    )[0];
    return [getArmBar(busiest)];
  });
};

/**
 * The farthest a corridor may space a name off its stop, as a multiple of the band's half width.
 *
 * A corridor leaving the stop the way the name stands is one the name can only clear by being
 * pushed along it, and a shallow angle would push it the whole way to the next stop. Two half
 * widths clears the diagonal a name most often has to sit beside -- Rüppurrer Tor's -- and leaves
 * every name still reading as belonging to the dot it hangs from.
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
 * How far a corridor's paint reaches from the stop, going one way out of it.
 *
 * A band is the strip half a width either side of the corridor it runs along, and how far a name
 * has to travel to leave that strip depends on the angle between the two. Square to the corridor
 * it is half the width; along a corridor pointing the same way it never leaves at all, so the
 * reach is capped — a name is spaced off a station, not walked to the next one. Ninety degrees the
 * other way, where the corridor leaves the stop behind the name, the strip is already behind it.
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

/**
 * How far the station reaches from its coordinate towards one side.
 *
 * Two things are drawn at a stop and a name has to clear both: the rules the stop is marked with,
 * which are measured where their ends actually lie, and the bands of the corridors leaving it,
 * measured by how far the name has to go to be off them.
 */
const getSideClearance = (
  node: ZentrumSchematicNode,
  arms: readonly ZentrumSchematicNodeArm[],
  bars: readonly { from: SchematicPoint; to: SchematicPoint }[],
  trackWidth: number,
  direction: SchematicPoint,
): number =>
  Math.max(
    0,
    ...bars.flatMap((bar) =>
      [bar.from, bar.to].map(
        (point) => (point.x - node.x) * direction.x + (point.y - node.y) * direction.y,
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

/**
 * The rule, or rules, each stop the reading draws is marked with.
 *
 * Sized from the corridors themselves, so a mark is exactly as wide as what calls there, and placed
 * from the places to stand the reading has named, so a junction says how many of them it is.
 */
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
    // Two places of one stop can settle on the same rule -- the same straight, crossed at the same
    // point -- and drawing it twice only thickens it.
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
