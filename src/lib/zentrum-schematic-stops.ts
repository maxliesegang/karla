/** The stop marks, laid out from the same corridors and lanes as the lines they cross. */
import {
  type ZentrumSchematicBoardingPlace,
  type SchematicPoint,
  type ZentrumSchematicEdge,
  type ZentrumSchematicLinePath,
  type ZentrumSchematicNode,
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

/** A straight stroke on the plan: a capsule's spine, or the link between two capsules. */
export type ZentrumSchematicStroke = { from: SchematicPoint; to: SchematicPoint };

/**
 * A stop's mark, as a printed network plan draws one: one capsule for each place to stand, laid
 * square across every lane calling there where those lanes run straight, and the places of one
 * stop joined into one shape by a link.
 *
 * A stop is one capsule wherever the feed says it is one place, however many platforms and levels
 * it has: the stop page says which platform. Where its platforms are places apart (Karlstor's line
 * 3 and its lines 4 and 5, a street apart), each place stands on the arm only it serves.
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
 * A link is a dotted rule, the plan's mark for a walk between two places of one stop: each dot is
 * this many lanes across, and the dots stand `ZENTRUM_SCHEMATIC_STOP_LINK_PITCH` lanes apart.
 */
export const ZENTRUM_SCHEMATIC_STOP_LINK_WIDTH = 0.32;

export const ZENTRUM_SCHEMATIC_STOP_LINK_PITCH = 0.8;

/** How far a capsule reaches past the band's paint, in lanes, so it reads as crossing it. */
const ZENTRUM_SCHEMATIC_STOP_OVERHANG = 0.1;

/** The room a capsule keeps from a bend, a band it does not mark, or another capsule, in lanes. */
const ZENTRUM_SCHEMATIC_STOP_CLEARANCE = 0.4;

/** How much further than its nearest clear spot a stop's main place may stand, in lanes, to let
 * the stop's other place link to it cleanly. */
const ZENTRUM_SCHEMATIC_STOP_SLACK = 6;

/** How far a link stands off a curve, in lanes: a lane where it can, less where it must. */
const ZENTRUM_SCHEMATIC_LINK_CLEARANCES = [1, 0.5, 0];

/**
 * How far along its corridor a capsule may stand: up to halfway, since the next stop's own
 * capsules stand at the other end.
 */
const ZENTRUM_SCHEMATIC_STOP_MAXIMUM_REACH = 0.5;

/** The widest paint a lane lays, its casing at 1.43 lanes, as a half width in lanes. */
const ZENTRUM_SCHEMATIC_LANE_PAINT = 0.72;

/** One corridor as it leaves a stop: the way out, how far it runs, and the lanes it carries. */
type ZentrumSchematicNodeArm = {
  edge: ZentrumSchematicEdge;
  /** The stop at the far end, which is what a boarding place names its corridors by. */
  nodeId: string;
  outward: SchematicPoint;
  length: number;
};

type Outline = readonly SchematicPoint[];

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

const getNormal = (edge: ZentrumSchematicEdge): SchematicPoint => {
  const run = orientCorridorRun(edge);
  return { x: -run.y, y: run.x };
};

/** How far a capsule reaches either side of a corridor's middle to cross every lane on these arms. */
const getBandExtent = (
  arms: readonly ZentrumSchematicNodeArm[],
  trackWidth: number,
): { lowest: number; highest: number } => {
  const overhang = trackWidth * (0.5 + ZENTRUM_SCHEMATIC_STOP_OVERHANG);
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
 * The capsule a corner stop is drawn with, as TfL draws a station on a bend: one pill along the
 * corner's diagonal, through the middle of each lane's curve. The curves are drawn round one
 * corner, so their middles stand in a line. Undefined where they do not.
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
  const overhang = trackWidth * (0.5 + ZENTRUM_SCHEMATIC_STOP_OVERHANG);
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
 * Where one place's capsule can stand: square across its lanes where they run straight, as near
 * the stop as that allows. At the stop itself where nothing bends or crosses there; else stepped
 * out along each of its arms that carries every lane it marks, to the first spot clear of every
 * bend, every band it does not mark, and every capsule already laid.
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
  const atStop = [
    ...chosen.flatMap((arm, index) =>
      chosen.slice(index + 1).flatMap((other) => (isOppositeArm(arm, other) ? [[arm, other]] : [])),
    ),
    ...chosen
      .filter((arm) => !chosen.some((other) => isOppositeArm(arm, other)))
      .map((arm) => [arm]),
  ].flatMap((band) => {
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
  const halfWidth =
    trackWidth * (ZENTRUM_SCHEMATIC_STOP_CAPSULE_WIDTH / 2 + ZENTRUM_SCHEMATIC_STOP_CLEARANCE);
  return {
    covers: (band: readonly ZentrumSchematicNodeArm[]) =>
      [...needed].every((trackId) => band.some(({ edge }) => edge.trackLineIds.includes(trackId))),
    isClear: (capsule: ZentrumSchematicStroke, band: readonly ZentrumSchematicNodeArm[]) => {
      const outline = getStrokeOutline(capsule, halfWidth);
      const crossed = arms
        .filter((arm) => !band.includes(arm))
        .map((arm) => getBandOutline(arm.edge, trackWidth));
      return [...obstacles, ...crossed].every((obstacle) => !isOverlapping(outline, obstacle));
    },
  };
};

/** The eight ways the plan runs, which a link between two capsules runs too. */
const OCTILINEAR_DIRECTIONS: readonly SchematicPoint[] = Array.from({ length: 8 }, (_, index) => ({
  x: Math.round(Math.cos((index * Math.PI) / 4) * 1e9) / 1e9,
  y: Math.round(Math.sin((index * Math.PI) / 4) * 1e9) / 1e9,
}));

/**
 * The second place's capsule for a main one already laid, and the link joining them: the link runs
 * one of the plan's eight ways from an end of the main capsule to an end of this one, which fixes
 * how far out along its arm this capsule stands. Of those that fit, the nearest wins. Undefined
 * where none fits.
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
  return solutions.reduce<(typeof solutions)[number] | undefined>(
    (best, solution) => (!best || solution.cost < best.cost ? solution : best),
    undefined,
  );
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
 * Where no capsule can mark a place whole and clear, it is marked at the stop itself: one capsule
 * across each straight, crossing there, and one across each arm no straight runs on.
 */
const getStopCapsules = (
  node: ZentrumSchematicNode,
  chosen: readonly ZentrumSchematicNodeArm[],
  trackWidth: number,
): readonly ZentrumSchematicStroke[] => {
  const bands: ZentrumSchematicNodeArm[][] = [];
  for (const arm of chosen) {
    const straight = bands.find((band) => isOppositeArm(band[0], arm));
    if (straight) straight.push(arm);
    else bands.push([arm]);
  }
  const laneCount = (band: readonly ZentrumSchematicNodeArm[]) =>
    Math.max(...band.map(({ edge }) => edge.trackLineIds.length));
  return bands
    .sort((left, right) => laneCount(right) - laneCount(left))
    .map((band) => getBandCapsule(node, band, 0, trackWidth));
};

/**
 * The arms of a place, split into the groups one capsule each can cross. Most places are one group:
 * some straight or arm carries every lane calling there. Where none does (Tivoli: lines 3 and 6
 * from the west, line E from the north), the place is crossed band by band, the busiest first,
 * and its capsules are laid and linked as a stop's places are.
 */
const getCapsuleGroups = (
  chosen: readonly ZentrumSchematicNodeArm[],
): (readonly ZentrumSchematicNodeArm[])[] => {
  const lanesOf = (band: readonly ZentrumSchematicNodeArm[]) =>
    new Set(band.flatMap(({ edge }) => edge.trackLineIds));
  const bands = [
    ...chosen.flatMap((arm, index) =>
      chosen.slice(index + 1).flatMap((other) => (isOppositeArm(arm, other) ? [[arm, other]] : [])),
    ),
    ...chosen.map((arm) => [arm]),
  ];
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
 * A stop's capsules and links. Each place stands across its own lanes where they run straight, as
 * near the stop as it can; where a stop has two places, the second is chosen for the first, so
 * the two stand near each other and their link runs through empty ground rather than along a band.
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

  // Each group leads in turn: it is tried at each spot it can stand, every other group is laid for
  // it with an octilinear link, and the layout standing nearest the stop wins -- with the tightest
  // clearance from the curves only where nothing roomier fits.
  const clearance =
    trackWidth * (ZENTRUM_SCHEMATIC_STOP_CAPSULE_WIDTH / 2 + ZENTRUM_SCHEMATIC_STOP_CLEARANCE);
  const slack = groups.length > 1 ? trackWidth * ZENTRUM_SCHEMATIC_STOP_SLACK : 0;
  const leads = groups.map((lead, index) => ({
    lead,
    others: groups.filter((_, other) => other !== index),
    options: getCapsuleOptions(node, lead, arms, bendOutlines, trackWidth, slack),
  }));
  const layOut = (linkClearance: number) => {
    const linkObstacles = [
      ...arms.map((arm) => getBandOutline(arm.edge, trackWidth)),
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
    return layouts.reduce<(typeof layouts)[number] | undefined>(
      (chosen, layout) => (!chosen || layout.cost < chosen.cost ? layout : chosen),
      undefined,
    );
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
    for (const node of [edge.from, edge.to]) {
      edgesByNodeId.set(node.id, [...(edgesByNodeId.get(node.id) ?? []), edge]);
    }
  }
  const bendsByNodeId = new Map<string, ZentrumSchematicLaneBend[]>();
  for (const bend of getZentrumSchematicLaneBends(linePaths, edges, trackWidth)) {
    bendsByNodeId.set(bend.nodeId, [...(bendsByNodeId.get(bend.nodeId) ?? []), bend]);
  }
  return [...edgesByNodeId].flatMap(([nodeId, nodeEdges]): ZentrumSchematicStopMark[] => {
    const node = zentrumSchematicNodeById.get(nodeId);
    if (!node) return [];
    return [
      getNodeMark(
        node,
        getNodeArms(node, nodeEdges),
        boardingPlacesByNodeId.get(nodeId) ?? [],
        bendsByNodeId.get(nodeId) ?? [],
        trackWidth,
      ),
    ];
  });
};
