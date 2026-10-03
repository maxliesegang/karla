/** The stop marks, laid out from the same corridors and lanes as the lines they cross. */
import {
  type ZentrumSchematicBoardingPlace,
  type SchematicPoint,
  type ZentrumSchematicEdge,
  type ZentrumSchematicLinePath,
  type ZentrumSchematicNode,
  type ZentrumSchematicStroke,
  crossProduct,
  dotProduct,
  getTrackOffset,
  subtractPoints,
  getUnitVector,
  orientCorridorRun,
  formatPoint,
  zentrumSchematicNodeById,
} from "./zentrum-schematic-plan";
import {
  type ZentrumSchematicLaneBend,
  getZentrumSchematicLaneBends,
} from "./zentrum-schematic-paths";

/**
 * A stop's mark as a printed plan draws it: one capsule per place to stand, square across the lanes
 * where they run straight, places of one stop joined by a link. Places apart (Karlstor's line 3 and
 * lines 4/5, a street apart) each stand on the arm only they serve.
 */
export type ZentrumSchematicStopMark = {
  nodeId: string;
  /** The capsule the name is set beside: the busiest place's. */
  main: ZentrumSchematicStroke;
  /** Every capsule, the main one first, as spines in schematic units. */
  capsules: readonly ZentrumSchematicStroke[];
  /** The links joining the other capsules to the main one. */
  links: readonly ZentrumSchematicStroke[];
};

/** A capsule's width in lanes: a little wider than a lane, so it reads as across the lines. */
export const ZENTRUM_SCHEMATIC_STOP_CAPSULE_WIDTH = 1.15;

/** How much of the capsule's width is its white body; the rest is the outline either side. */
export const ZENTRUM_SCHEMATIC_STOP_CAPSULE_FILL = 0.62;

/**
 * A link is a dotted rule (a walk between places): dot width in lanes, dots `..._LINK_PITCH` apart.
 */
export const ZENTRUM_SCHEMATIC_STOP_LINK_WIDTH = 0.32;

export const ZENTRUM_SCHEMATIC_STOP_LINK_PITCH = 0.8;

/** How far a capsule reaches past the band's paint, in lanes, so it reads as crossing it. */
const ZENTRUM_SCHEMATIC_STOP_OVERHANG = 0.1;

/** Clearance from a bend, an unmarked band or another capsule, in lanes. */
const ZENTRUM_SCHEMATIC_STOP_CLEARANCE = 0.4;

/**
 * How much further from the stop the main place may stand so the other place links cleanly, in
 * lanes.
 */
const ZENTRUM_SCHEMATIC_STOP_SLACK = 6;

/** How far a link stands off a curve, in lanes: a lane where it can, less where it must. */
const ZENTRUM_SCHEMATIC_LINK_CLEARANCES = [1, 0.5, 0];

/**
 * How far along its corridor a capsule may stand: halfway, since the next stop's are at the other
 * end.
 */
const ZENTRUM_SCHEMATIC_STOP_MAXIMUM_REACH = 0.5;

/** The widest paint a lane lays, its casing at 1.43 lanes, as a half width in lanes. */
const ZENTRUM_SCHEMATIC_LANE_PAINT = 0.72;

/** One corridor as it leaves a stop: the way out, how far it runs, and the lanes it carries. */
type ZentrumSchematicNodeArm = {
  edge: ZentrumSchematicEdge;
  /** The stop at the far end, which boarding places name corridors by. */
  nodeId: string;
  outward: SchematicPoint;
  length: number;
  /** The corridor's band paint, which other places' capsules and every link keep off. */
  band: Outline;
};

type Outline = readonly SchematicPoint[];

const getNodeArms = (
  node: ZentrumSchematicNode,
  edges: readonly ZentrumSchematicEdge[],
  trackWidth: number,
): readonly ZentrumSchematicNodeArm[] =>
  edges.map((edge) => {
    const other = edge.from.id === node.id ? edge.to : edge.from;
    return {
      edge,
      nodeId: other.id,
      outward: getUnitVector(node, other),
      length: Math.hypot(other.x - node.x, other.y - node.y),
      band: getBandOutline(edge, trackWidth),
    };
  });

/** Whether two ways out of a stop are the two ends of one straight through it. */
const isOppositeArm = (left: ZentrumSchematicNodeArm, right: ZentrumSchematicNodeArm): boolean =>
  dotProduct(left.outward, right.outward) < -0.99;

/** Each straight through a stop, as the two arms it runs out on. */
const getStraights = (arms: readonly ZentrumSchematicNodeArm[]): ZentrumSchematicNodeArm[][] =>
  arms.flatMap((arm, index) =>
    arms
      .slice(index + 1)
      .filter((other) => isOppositeArm(arm, other))
      .map((other) => [arm, other]),
  );

/** The bands one capsule can cross at the stop itself: each straight, and each arm none runs on. */
const getStopBands = (arms: readonly ZentrumSchematicNodeArm[]): ZentrumSchematicNodeArm[][] => [
  ...getStraights(arms),
  ...arms.filter((arm) => !arms.some((other) => isOppositeArm(arm, other))).map((arm) => [arm]),
];

/** The cheapest of some options, the first among equals; undefined where there are none. */
const getCheapest = <Option extends { cost: number }>(
  options: readonly Option[],
): Option | undefined =>
  options.reduce<Option | undefined>(
    (best, option) => (!best || option.cost < best.cost ? option : best),
    undefined,
  );

/** Half a capsule's width with the room it keeps around it, in schematic units. */
const getCapsuleKeepOut = (trackWidth: number): number =>
  trackWidth * (ZENTRUM_SCHEMATIC_STOP_CAPSULE_WIDTH / 2 + ZENTRUM_SCHEMATIC_STOP_CLEARANCE);

/**
 * How far a capsule's spine runs past the outermost lane's middle, so it reaches past the paint.
 */
const getCapsuleOverhang = (trackWidth: number): number =>
  trackWidth * (0.5 + ZENTRUM_SCHEMATIC_STOP_OVERHANG);

const getNormal = (edge: ZentrumSchematicEdge): SchematicPoint => {
  const run = orientCorridorRun(edge);
  return { x: -run.y, y: run.x };
};

/**
 * How far a capsule reaches either side of the corridor's middle to cross every lane on these arms.
 */
const getBandExtent = (
  arms: readonly ZentrumSchematicNodeArm[],
  trackWidth: number,
): { lowest: number; highest: number } => {
  const overhang = getCapsuleOverhang(trackWidth);
  return {
    lowest: Math.min(...arms.map(({ edge }) => getTrackOffset(edge, 0, trackWidth))) - overhang,
    highest:
      Math.max(
        ...arms.map(({ edge }) => getTrackOffset(edge, edge.trackLineIds.length - 1, trackWidth)),
      ) + overhang,
  };
};

/** A capsule square to the arms' band, `reach` out along the first of them. */
const getBandCapsule = (
  node: ZentrumSchematicNode,
  arms: readonly ZentrumSchematicNodeArm[],
  reach: number,
  trackWidth: number,
): ZentrumSchematicStroke => {
  const normal = getNormal(arms[0].edge);
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

/** A stroke widened to the paint it lays, round ends included, as a four-cornered outline. */
export const getStrokeOutline = (
  { from, to }: ZentrumSchematicStroke,
  halfWidth: number,
): Outline => {
  const length = Math.hypot(to.x - from.x, to.y - from.y);
  const along =
    length === 0 ? { x: 1, y: 0 } : { x: (to.x - from.x) / length, y: (to.y - from.y) / length };
  const across = { x: -along.y * halfWidth, y: along.x * halfWidth };
  const start = { x: from.x - along.x * halfWidth, y: from.y - along.y * halfWidth };
  const end = { x: to.x + along.x * halfWidth, y: to.y + along.y * halfWidth };
  return [
    { x: start.x + across.x, y: start.y + across.y },
    { x: end.x + across.x, y: end.y + across.y },
    { x: end.x - across.x, y: end.y - across.y },
    { x: start.x - across.x, y: start.y - across.y },
  ];
};

/** A corridor's band of lanes, casing included, as the outline it paints between its stops. */
export const getBandOutline = (edge: ZentrumSchematicEdge, trackWidth: number): Outline => {
  const normal = getNormal(edge);
  const reach = trackWidth * ZENTRUM_SCHEMATIC_LANE_PAINT;
  const lowest = getTrackOffset(edge, 0, trackWidth) - reach;
  const highest = getTrackOffset(edge, edge.trackLineIds.length - 1, trackWidth) + reach;
  const at = (point: SchematicPoint, offset: number) => ({
    x: point.x + normal.x * offset,
    y: point.y + normal.y * offset,
  });
  return [at(edge.from, lowest), at(edge.to, lowest), at(edge.to, highest), at(edge.from, highest)];
};

/** A lane's bend as the outlines of the short strokes it is drawn with. */
const getBendOutlines = (
  { points }: ZentrumSchematicLaneBend,
  trackWidth: number,
  clearance = 0,
): Outline[] =>
  points
    .slice(1)
    .map((to, index) =>
      getStrokeOutline(
        { from: points[index], to },
        trackWidth * (ZENTRUM_SCHEMATIC_LANE_PAINT + clearance),
      ),
    );

/** Whether two convex outlines overlap: they do unless an edge of one separates them. */
export const isOverlapping = (left: Outline, right: Outline): boolean =>
  [left, right].every((outline) =>
    outline.every((point, index) => {
      const next = outline[(index + 1) % outline.length];
      const axis = { x: point.y - next.y, y: next.x - point.x };
      const project = (points: Outline) => points.map(({ x, y }) => x * axis.x + y * axis.y);
      const leftProjection = project(left);
      const rightProjection = project(right);
      return (
        Math.max(...leftProjection) > Math.min(...rightProjection) &&
        Math.max(...rightProjection) > Math.min(...leftProjection)
      );
    }),
  );

/**
 * A corner stop's capsule, as TfL draws one: a pill along the corner's diagonal through the middle
 * of each lane's curve. Undefined where the middles do not line up.
 */
const getCornerCapsule = (
  [first, second]: readonly ZentrumSchematicNodeArm[],
  bends: readonly ZentrumSchematicLaneBend[],
  trackWidth: number,
): ZentrumSchematicStroke | undefined => {
  const middles = bends.map(({ points }) => points[Math.floor(points.length / 2)]);
  if (middles.length === 0) return undefined;
  const bisector = getUnitVector(
    { x: 0, y: 0 },
    { x: first.outward.x + second.outward.x, y: first.outward.y + second.outward.y },
  );
  const along = (point: SchematicPoint) => dotProduct(point, bisector);
  const across = (point: SchematicPoint) => point.x * -bisector.y + point.y * bisector.x;
  const middle = across(middles[0]);
  if (middles.some((point) => Math.abs(across(point) - middle) > trackWidth * 0.35)) {
    return undefined;
  }
  const overhang = getCapsuleOverhang(trackWidth);
  const at = (distance: number) => ({
    x: bisector.x * distance - bisector.y * middle,
    y: bisector.y * distance + bisector.x * middle,
  });
  return {
    from: at(Math.min(...middles.map(along)) - overhang),
    to: at(Math.max(...middles.map(along)) + overhang),
  };
};

/** One way a place's capsule can be laid, and how far from the stop it stands. */
type ZentrumSchematicCapsuleOption = { capsule: ZentrumSchematicStroke; reach: number };

/**
 * Where a place's capsule can stand: square across its straight lanes, as near the stop as clear.
 * At the stop if nothing bends there, else stepped out along each arm carrying all its lanes to the
 * first spot clear of bends, unmarked bands and laid capsules.
 */
const getCapsuleOptions = (
  node: ZentrumSchematicNode,
  chosen: readonly ZentrumSchematicNodeArm[],
  arms: readonly ZentrumSchematicNodeArm[],
  obstacles: readonly Outline[],
  trackWidth: number,
  slack = 0,
): readonly ZentrumSchematicCapsuleOption[] => {
  const { covers, isClear } = getPlaceFit(chosen, arms, obstacles, trackWidth);
  const atStop = getStopBands(chosen).flatMap((band) => {
    const capsule = getBandCapsule(node, band, 0, trackWidth);
    return covers(band) && isClear(capsule, band) ? [{ capsule, reach: 0 }] : [];
  });
  if (atStop.length > 0 && slack === 0) return atStop;

  // Out along each arm from the first clear spot, and `slack` further for a stop laying two.
  const step = trackWidth / 4;
  return [
    ...atStop,
    ...chosen
      .filter((arm) => covers([arm]))
      .flatMap((arm) => {
        const options: ZentrumSchematicCapsuleOption[] = [];
        const farthest = arm.length * ZENTRUM_SCHEMATIC_STOP_MAXIMUM_REACH;
        for (let reach = step; reach <= farthest; reach += step) {
          if (options.length > 0 && reach > options[0].reach + slack) break;
          const capsule = getBandCapsule(node, [arm], reach, trackWidth);
          if (isClear(capsule, [arm])) options.push({ capsule, reach });
        }
        return options;
      }),
  ];
};

/** What a place's capsule must cross, and what it must keep clear of. */
const getPlaceFit = (
  chosen: readonly ZentrumSchematicNodeArm[],
  arms: readonly ZentrumSchematicNodeArm[],
  obstacles: readonly Outline[],
  trackWidth: number,
) => {
  const needed = new Set(chosen.flatMap(({ edge }) => edge.trackLineIds));
  const halfWidth = getCapsuleKeepOut(trackWidth);
  return {
    covers: (band: readonly ZentrumSchematicNodeArm[]) =>
      [...needed].every((trackId) => band.some(({ edge }) => edge.trackLineIds.includes(trackId))),
    isClear: (capsule: ZentrumSchematicStroke, band: readonly ZentrumSchematicNodeArm[]) => {
      const outline = getStrokeOutline(capsule, halfWidth);
      return (
        obstacles.every((obstacle) => !isOverlapping(outline, obstacle)) &&
        arms.every((arm) => band.includes(arm) || !isOverlapping(outline, arm.band))
      );
    },
  };
};

/** The eight ways the plan runs, which a link between two capsules runs too. */
const OCTILINEAR_DIRECTIONS: readonly SchematicPoint[] = Array.from({ length: 8 }, (_, index) => ({
  x: Math.round(Math.cos((index * Math.PI) / 4) * 1e9) / 1e9,
  y: Math.round(Math.sin((index * Math.PI) / 4) * 1e9) / 1e9,
}));

/**
 * The second place's capsule for a laid main one, and their link: an octilinear link from an end of
 * the main capsule fixes how far out this one stands. The nearest fit wins; undefined if none.
 */
const getLinkedCapsule = (
  node: ZentrumSchematicNode,
  main: ZentrumSchematicStroke,
  chosen: readonly ZentrumSchematicNodeArm[],
  arms: readonly ZentrumSchematicNodeArm[],
  obstacles: readonly Outline[],
  linkObstacles: readonly Outline[],
  trackWidth: number,
): { capsule: ZentrumSchematicStroke; link: ZentrumSchematicStroke; cost: number } | undefined => {
  const { covers, isClear } = getPlaceFit(chosen, arms, obstacles, trackWidth);
  const inset = trackWidth * ZENTRUM_SCHEMATIC_STOP_CLEARANCE;
  const solutions = chosen
    .filter((arm) => covers([arm]))
    .flatMap((arm) => {
      const atStop = getBandCapsule(node, [arm], 0, trackWidth);
      const farthest = arm.length * ZENTRUM_SCHEMATIC_STOP_MAXIMUM_REACH;
      return [main.from, main.to].flatMap((start) =>
        [atStop.from, atStop.to].flatMap((end) =>
          OCTILINEAR_DIRECTIONS.flatMap((direction) => {
            // end + outward * reach = start + direction * length, solved for both.
            const across = crossProduct(arm.outward, direction);
            if (Math.abs(across) < 1e-6) return [];
            const offset = subtractPoints(end, start);
            const reach = -crossProduct(offset, direction) / across;
            const length =
              dotProduct(offset, direction) + dotProduct(arm.outward, direction) * reach;
            if (reach <= 0 || reach > farthest || length < inset * 2) return [];
            const capsule = getBandCapsule(node, [arm], reach, trackWidth);
            if (!isClear(capsule, [arm])) return [];
            // Tested short of its ends, which stand at the capsules on either side of the paint.
            const spine = {
              from: { x: start.x + direction.x * inset, y: start.y + direction.y * inset },
              to: {
                x: start.x + direction.x * (length - inset),
                y: start.y + direction.y * (length - inset),
              },
            };
            const outline = getStrokeOutline(spine, 0.01);
            if (linkObstacles.some((obstacle) => isOverlapping(outline, obstacle))) return [];
            const link = {
              from: start,
              to: { x: start.x + direction.x * length, y: start.y + direction.y * length },
            };
            // A level or upright link reads as part of the grid; a diagonal one only where needed.
            const isDiagonal = direction.x !== 0 && direction.y !== 0;
            return [{ capsule, link, cost: reach + length * (isDiagonal ? 1.5 : 1) }];
          }),
        ),
      );
    });
  return getCheapest(solutions);
};

/**
 * The arms a place is drawn on: those the stop's other places do not use (every place shares the
 * busy corridor, as at Karlstor), else its own.
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

/** The fallback: one capsule across each straight at the stop, and one across each other arm. */
const getStopCapsules = (
  node: ZentrumSchematicNode,
  chosen: readonly ZentrumSchematicNodeArm[],
  trackWidth: number,
): readonly ZentrumSchematicStroke[] => {
  const laneCount = (band: readonly ZentrumSchematicNodeArm[]) =>
    Math.max(...band.map(({ edge }) => edge.trackLineIds.length));
  return getStopBands(chosen)
    .sort((left, right) => laneCount(right) - laneCount(left))
    .map((band) => getBandCapsule(node, band, 0, trackWidth));
};

/**
 * A place's arms split into groups one capsule can cross. Usually one; where no straight carries
 * every lane (Tivoli: 3 and 6 from the west, E from the north), the bands are crossed busiest first
 * and linked like a stop's places.
 */
const getCapsuleGroups = (
  chosen: readonly ZentrumSchematicNodeArm[],
): (readonly ZentrumSchematicNodeArm[])[] => {
  const lanesOf = (band: readonly ZentrumSchematicNodeArm[]) =>
    new Set(band.flatMap(({ edge }) => edge.trackLineIds));
  const bands = [...getStraights(chosen), ...chosen.map((arm) => [arm])];
  const remaining = lanesOf(chosen);
  const coversAll = (band: readonly ZentrumSchematicNodeArm[]) =>
    [...remaining].every((trackId) => lanesOf([band[0]]).has(trackId)) ||
    [...remaining].every((trackId) => lanesOf(band.slice(-1)).has(trackId));
  if (bands.some(coversAll)) return [chosen];
  const groups: (readonly ZentrumSchematicNodeArm[])[] = [];
  while (remaining.size > 0) {
    const gain = (band: readonly ZentrumSchematicNodeArm[]) =>
      [...lanesOf(band)].filter((trackId) => remaining.has(trackId)).length;
    const [band] = [...bands].sort((left, right) => gain(right) - gain(left));
    if (gain(band) === 0) break;
    groups.push(band);
    for (const trackId of lanesOf(band)) remaining.delete(trackId);
  }
  return groups;
};

/** A corner every lane turns through, which is one pill across the bend. */
const isCorner = (chosen: readonly ZentrumSchematicNodeArm[]): boolean => {
  if (chosen.length !== 2 || isOppositeArm(chosen[0], chosen[1])) return false;
  const [first, second] = chosen.map(({ edge }) => edge.trackLineIds);
  return first.length === second.length && first.every((trackId) => second.includes(trackId));
};

/**
 * A stop's capsules and links: each place across its straight lanes near the stop; a second place
 * is chosen for the first so their link crosses empty ground.
 */
const getNodeMark = (
  node: ZentrumSchematicNode,
  arms: readonly ZentrumSchematicNodeArm[],
  places: readonly ZentrumSchematicBoardingPlace[],
  bends: readonly ZentrumSchematicLaneBend[],
  trackWidth: number,
): ZentrumSchematicStopMark => {
  const bendOutlines = bends.flatMap((bend) => getBendOutlines(bend, trackWidth));
  const groups = (
    places.length < 2 ? [arms] : places.map((place) => getPlaceArms(place, places, arms))
  )
    .filter((chosen) => chosen.length > 0)
    .flatMap(getCapsuleGroups);

  const corner =
    groups.length === 1 && isCorner(groups[0])
      ? getCornerCapsule(groups[0], bends, trackWidth)
      : undefined;
  if (corner) return { nodeId: node.id, main: corner, capsules: [corner], links: [] };

  // Each group leads in turn, the others laid around it with octilinear links; the layout nearest
  // the stop wins, with tighter curve clearance only where nothing roomier fits.
  const clearance = getCapsuleKeepOut(trackWidth);
  const slack = groups.length > 1 ? trackWidth * ZENTRUM_SCHEMATIC_STOP_SLACK : 0;
  const leads = groups.map((lead, index) => ({
    lead,
    others: groups.filter((_, other) => other !== index),
    options: getCapsuleOptions(node, lead, arms, bendOutlines, trackWidth, slack),
  }));
  const layOut = (linkClearance: number) => {
    const linkObstacles = [
      ...arms.map(({ band }) => band),
      ...bends.flatMap((bend) => getBendOutlines(bend, trackWidth, linkClearance)),
    ];
    const layouts = leads.flatMap(({ others, options }) =>
      options.flatMap(({ capsule: main, reach }) => {
        const capsules = [main];
        const links: ZentrumSchematicStroke[] = [];
        let cost = reach;
        for (const chosen of others) {
          const laid = capsules.map((one) => getStrokeOutline(one, clearance));
          const linked = getLinkedCapsule(
            node,
            main,
            chosen,
            arms,
            [...bendOutlines, ...laid],
            linkObstacles,
            trackWidth,
          );
          if (!linked) return [];
          capsules.push(linked.capsule);
          links.push(linked.link);
          cost += linked.cost;
        }
        return [{ capsules, links, cost }];
      }),
    );
    return getCheapest(layouts);
  };
  const best = ZENTRUM_SCHEMATIC_LINK_CLEARANCES.reduce<ReturnType<typeof layOut>>(
    (found, linkClearance) => found ?? layOut(linkClearance),
    undefined,
  );
  if (best) return { nodeId: node.id, main: best.capsules[0], ...best };
  // Nothing fits cleanly: every group marked at the stop itself.
  const capsules = groups.flatMap((chosen) => getStopCapsules(node, chosen, trackWidth));
  return { nodeId: node.id, main: capsules[0], capsules, links: [] };
};

/** Strokes as one SVG path of straight lines, in schematic units. */
export const getZentrumSchematicStrokeData = (strokes: readonly ZentrumSchematicStroke[]): string =>
  strokes.map(({ from, to }) => `M ${formatPoint(from)} L ${formatPoint(to)}`).join(" ");

/** The capsules each drawn stop is marked with, one per place, as wide as what calls there. */
export const getZentrumSchematicStopMarks = (
  edges: readonly ZentrumSchematicEdge[],
  linePaths: readonly ZentrumSchematicLinePath[],
  trackWidth: number,
  boardingPlacesByNodeId: ReadonlyMap<string, readonly ZentrumSchematicBoardingPlace[]>,
): readonly ZentrumSchematicStopMark[] => {
  const edgesByNodeId = new Map<string, ZentrumSchematicEdge[]>();
  for (const edge of edges) {
    for (const { id } of [edge.from, edge.to]) addTo(edgesByNodeId, id, edge);
  }
  const bendsByNodeId = new Map<string, ZentrumSchematicLaneBend[]>();
  for (const bend of getZentrumSchematicLaneBends(linePaths, edges, trackWidth)) {
    addTo(bendsByNodeId, bend.nodeId, bend);
  }
  return [...edgesByNodeId].flatMap(([nodeId, nodeEdges]): ZentrumSchematicStopMark[] => {
    const node = zentrumSchematicNodeById.get(nodeId);
    if (!node) return [];
    return [
      getNodeMark(
        node,
        getNodeArms(node, nodeEdges, trackWidth),
        boardingPlacesByNodeId.get(nodeId) ?? [],
        bendsByNodeId.get(nodeId) ?? [],
        trackWidth,
      ),
    ];
  });
};

const addTo = <Value>(map: Map<string, Value[]>, key: string, value: Value) => {
  const values = map.get(key);
  if (values) values.push(value);
  else map.set(key, [value]);
};
