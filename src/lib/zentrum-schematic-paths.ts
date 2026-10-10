/**
 * A line pattern as the drawing paints it: one softly bent stroke down its lanes. Geometry only;
 * which lane a line holds is decided in `zentrum-schematic-lanes.ts`.
 */
import {
  type SchematicPoint,
  type ZentrumSchematicEdge,
  type ZentrumSchematicLinePath,
  type ZentrumSchematicNode,
  type ZentrumSchematicStroke,
  crossProduct,
  dotProduct,
  getEdgeKey,
  getLineIntersection,
  getLineTrackPoint,
  getZentrumSchematicStopId,
  getUnitVector,
  formatPoint,
  subtractPoints,
} from "./zentrum-schematic-plan";

/** How many points a bend is sampled into for a mark to follow. */
const ZENTRUM_SCHEMATIC_BEND_SAMPLES = 6;
/**
 * How far a line rounds a turn either side of its lane intersection. Kept tight, because a broad
 * bend skirts the stop and leaves its mark beside the lines it should gather.
 */
const ZENTRUM_SCHEMATIC_LINE_BEND_DISTANCE = 10;

/** The innermost radius of a junction's turn, in lanes. */
const ZENTRUM_SCHEMATIC_JUNCTION_RADIUS = 1;

/** Maximum share of a lane's straight available to a turn. */
const ZENTRUM_SCHEMATIC_BEND_REACH = 0.75;

/**
 * One softly bent SVG path per line pattern. At a turn the lanes are extended to their intersection
 * (not the stop's centre, since offsets differ per corridor) and joined by a tangent arc; a
 * sideways step on a straight joins with a cubic.
 */
export function getZentrumSchematicLinePathData(
  linePath: ZentrumSchematicLinePath,
  edges: readonly ZentrumSchematicEdge[],
  trackWidth: number | undefined,
): string {
  return joinPieces(getZentrumSchematicLinePathPieces(linePath, edges, trackWidth));
}

const joinPieces = (pieces: readonly ZentrumSchematicLinePathPiece[]): string =>
  pieces.length === 0
    ? ""
    : [`M ${formatPoint(pieces[0].start)}`, ...pieces.flatMap(({ commands }) => commands)].join(
        " ",
      );

/** One line pattern as the drawing paints it: the geometry, and every line that geometry is. */
export type ZentrumSchematicDrawnPath = ZentrumSchematicLinePath & {
  /** The pattern as one SVG path, in the drawing's own units. */
  data: string;
  /** Every line drawn by this path: a trunk and branches coinciding are painted once. */
  lineIds: readonly string[];
  /** The pattern cut at the capsules, one stretch per corridor, for lighting. */
  segments: readonly ZentrumSchematicLinePathSegment[];
  /** Local regions where this path is painted above crossing routes. */
  foregroundRegions: readonly { x: number; y: number; width: number; height: number }[];
};

/** How many lanes a pattern runs beside, on average over its corridors. */
const getMeanLaneCount = (
  { nodes }: ZentrumSchematicLinePath,
  laneCountByEdgeId: ReadonlyMap<string, number>,
): number => {
  const laneCounts = nodes
    .slice(1)
    .map((node, index) => laneCountByEdgeId.get(getEdgeKey(nodes[index].id, node.id)) ?? 1);
  return laneCounts.reduce((sum, count) => sum + count, 0) / Math.max(1, laneCounts.length);
};

/**
 * One path per distinct geometry, coincident lines gathered, lit stretch by stretch along its own
 * vehicle paths. Wider bands are painted first: a line over a band hides it for one lane,
 * while a band over a line hides the line for the band's whole width.
 */
export function getZentrumSchematicDrawnPaths(
  linePaths: readonly ZentrumSchematicLinePath[],
  edges: readonly ZentrumSchematicEdge[],
  trackWidth: number | undefined,
  vehiclePathsByPathId: ReadonlyMap<string, ReadonlyMap<string, ZentrumSchematicCorridorPath>>,
  capsulesByNodeId: ReadonlyMap<string, readonly ZentrumSchematicStroke[]>,
): readonly ZentrumSchematicDrawnPath[] {
  const drawnByGeometry = new Map<string, ZentrumSchematicDrawnPath & { lineIds: string[] }>();
  for (const linePath of linePaths) {
    const pieces = getZentrumSchematicLinePathPieces(linePath, edges, trackWidth, capsulesByNodeId);
    const data = joinPieces(pieces);
    const coincident = drawnByGeometry.get(`${linePath.trackId}:${data}`);
    if (coincident) {
      coincident.lineIds.push(linePath.lineId);
      continue;
    }
    drawnByGeometry.set(`${linePath.trackId}:${data}`, {
      ...linePath,
      data,
      lineIds: [linePath.lineId],
      segments: toLinePathSegments(vehiclePathsByPathId.get(linePath.id) ?? new Map()),
      foregroundRegions: getZentrumSchematicForegroundRegions(linePath, edges, trackWidth),
    });
  }
  const laneCountByEdgeId = new Map(edges.map(({ id, trackIds }) => [id, trackIds.length]));
  // A stable sort, so equal bands keep timetable order.
  return [...drawnByGeometry.values()]
    .map((drawn) => ({ drawn, meanLaneCount: getMeanLaneCount(drawn, laneCountByEdgeId) }))
    .sort((left, right) => right.meanLaneCount - left.meanLaneCount)
    .map(({ drawn }) => drawn);
}

/** One corridor's stretch of a drawn line pattern, from one stop's capsule to the next's. */
export type ZentrumSchematicLinePathSegment = {
  /** The observed corridor this stretch runs along. */
  corridorId: string;
  /** The stretch as an SVG path, in schematic units, starting where the previous one ended. */
  data: string;
};

const getZentrumSchematicForegroundRegions = (
  linePath: ZentrumSchematicLinePath,
  edges: readonly ZentrumSchematicEdge[],
  trackWidth: number | undefined,
): ZentrumSchematicDrawnPath["foregroundRegions"] => {
  const { legs, bends } = getZentrumSchematicLaneLegs(linePath, edges, trackWidth);
  const padding = (trackWidth ?? ZENTRUM_SCHEMATIC_LINE_BEND_DISTANCE) * 2;
  const regions = bends.flatMap(({ points }) => {
    if (points.length === 0) return [];
    const left = Math.min(...points.map((point) => point.x));
    const top = Math.min(...points.map((point) => point.y));
    return [
      {
        x: left - padding,
        y: top - padding,
        width: Math.max(...points.map((point) => point.x)) - left + padding * 2,
        height: Math.max(...points.map((point) => point.y)) - top + padding * 2,
      },
    ];
  });
  const crossing = getDurlacherTorCrossingRegion(linePath, edges, legs, trackWidth, padding);
  return crossing ? [...regions, crossing] : regions;
};

const getDurlacherTorCrossingRegion = (
  { nodes }: ZentrumSchematicLinePath,
  edges: readonly ZentrumSchematicEdge[],
  legs: readonly ZentrumSchematicLaneLeg[],
  trackWidth: number | undefined,
  padding: number,
): ZentrumSchematicDrawnPath["foregroundRegions"][number] | undefined => {
  const isTor = (id: string) => getZentrumSchematicStopId(id) === "durlacher-tor";
  const index = nodes.findIndex(({ id }) => isTor(id));
  const node = nodes[index];
  const previous = nodes[index - 1];
  const next = nodes[index + 1];
  if (!node || !previous || !next || (previous.y - node.y) * (next.y - node.y) >= 0)
    return undefined;
  const band = edges
    .filter(({ from, to }) => (isTor(from.id) || isTor(to.id)) && from.y === to.y)
    .flatMap((edge) =>
      edge.trackIds.map(
        (trackId) => getLineTrackPoint(edge, edge.from, trackId, edge.trackIds, trackWidth).y,
      ),
    );
  if (band.length === 0) return undefined;
  const top = Math.min(...band) - padding;
  const bottom = Math.max(...band) + padding;
  const xs = legs
    .filter((leg) => isTor(leg.fromNodeId) || isTor(leg.toNodeId))
    .flatMap(({ from, to }) =>
      to.y === from.y
        ? []
        : [top, bottom].map((y) => from.x + ((y - from.y) * (to.x - from.x)) / (to.y - from.y)),
    );
  if (xs.length === 0) return undefined;
  const left = Math.min(...xs) - padding;
  return { x: left, y: top, width: Math.max(...xs) + padding - left, height: bottom - top };
};

/** A line's vehicle paths as lit stretches; joined, they run the whole stroke, bends included. */
const toLinePathSegments = (
  pathsByCorridorId: ReadonlyMap<string, ZentrumSchematicCorridorPath>,
): readonly ZentrumSchematicLinePathSegment[] =>
  [...pathsByCorridorId].map(([corridorId, { points }]) => ({
    corridorId,
    data: points
      .map((point, index) => `${index === 0 ? "M" : "L"} ${formatPoint(point)}`)
      .join(" "),
  }));

/** How the path leaves one corridor's lane for the next: a bend, or nothing at all. */
type ZentrumSchematicLinePathBend = {
  /** Where the straight of the outgoing corridor's stretch begins, on that corridor's lane. */
  approach: SchematicPoint;
  /** Where the bend ends and the next corridor's straight takes over. */
  leave: SchematicPoint;
  /** The bend's own commands, empty where the two lanes meet without one. */
  data: string;
  /** The bend sampled as points, so a mark turns the curve the stroke draws. Empty for no bend. */
  points: readonly SchematicPoint[];
};

/**
 * The arc one bend draws: tangent to both lanes at the approach and the leave, around the corner.
 */
const getZentrumSchematicBendPoints = (
  radius: number,
  approach: SchematicPoint,
  leave: SchematicPoint,
  incomingDirection: SchematicPoint,
): readonly SchematicPoint[] => {
  // The centre is a radius off both the approach and the leave.
  const centre = (sign: 1 | -1): SchematicPoint => ({
    x: approach.x - incomingDirection.y * radius * sign,
    y: approach.y + incomingDirection.x * radius * sign,
  });
  const chosen =
    Math.abs(Math.hypot(leave.x - centre(1).x, leave.y - centre(1).y) - radius) <=
    Math.abs(Math.hypot(leave.x - centre(-1).x, leave.y - centre(-1).y) - radius)
      ? centre(1)
      : centre(-1);
  const to = (point: SchematicPoint) => ({ x: point.x - chosen.x, y: point.y - chosen.y });
  const startAngle = Math.atan2(to(approach).y, to(approach).x);
  const endAngle = Math.atan2(to(leave).y, to(leave).x);
  // The shorter way round.
  let sweep = endAngle - startAngle;
  while (sweep > Math.PI) sweep -= 2 * Math.PI;
  while (sweep < -Math.PI) sweep += 2 * Math.PI;
  return Array.from({ length: ZENTRUM_SCHEMATIC_BEND_SAMPLES + 1 }, (_, index) => {
    const angle = startAngle + (sweep * index) / ZENTRUM_SCHEMATIC_BEND_SAMPLES;
    return { x: chosen.x + Math.cos(angle) * radius, y: chosen.y + Math.sin(angle) * radius };
  });
};

/** The cubic a straight join draws, sampled from the approach to the leave. */
const getZentrumSchematicCubicPoints = (
  firstControl: SchematicPoint,
  secondControl: SchematicPoint,
  approach: SchematicPoint,
  leave: SchematicPoint,
): readonly SchematicPoint[] => {
  const point = (t: number): SchematicPoint => {
    const u = 1 - t;
    return {
      x:
        u * u * u * approach.x +
        3 * u * u * t * firstControl.x +
        3 * u * t * t * secondControl.x +
        t * t * t * leave.x,
      y:
        u * u * u * approach.y +
        3 * u * u * t * firstControl.y +
        3 * u * t * t * secondControl.y +
        t * t * t * leave.y,
    };
  };
  return Array.from({ length: ZENTRUM_SCHEMATIC_BEND_SAMPLES + 1 }, (_, index) =>
    point(index / ZENTRUM_SCHEMATIC_BEND_SAMPLES),
  );
};

/**
 * Lanes turning between the same edges share one curve centre and stay a lane apart.
 */
const getLaneBendDistance = (
  node: ZentrumSchematicNode,
  arriving: ZentrumSchematicEdge,
  leaving: ZentrumSchematicEdge,
  trackId: string,
  trackWidth: number | undefined,
): number | undefined => {
  if (trackWidth === undefined) return undefined;
  const far = (edge: ZentrumSchematicEdge) => (edge.from.id === node.id ? edge.to : edge.from);
  const incoming = getUnitVector(far(arriving), node);
  const outgoing = getUnitVector(node, far(leaving));
  const turn = Math.acos(Math.max(-1, Math.min(1, dotProduct(incoming, outgoing))));
  if (turn < 0.001) return undefined;
  const inside = getUnitVector(incoming, outgoing);
  const turning = arriving.trackIds.filter((id) => leaving.trackIds.includes(id));
  const corners = turning.flatMap((id) => {
    const corner = getLineIntersection(
      getLineTrackPoint(arriving, node, id, arriving.trackIds, trackWidth),
      incoming,
      getLineTrackPoint(leaving, node, id, leaving.trackIds, trackWidth),
      outgoing,
    );
    return corner ? [{ id, corner, depth: dotProduct(subtractPoints(corner, node), inside) }] : [];
  });
  const own = corners.find(({ id }) => id === trackId);
  if (!own) return undefined;
  const innermost = Math.max(...corners.map(({ depth }) => depth));
  const extraRadius = (depth: number) => (innermost - depth) * Math.cos(turn / 2);
  const tangent = Math.tan(turn / 2);
  const preferredRadius = node.isJunction
    ? trackWidth * ZENTRUM_SCHEMATIC_JUNCTION_RADIUS
    : ZENTRUM_SCHEMATIC_LINE_BEND_DISTANCE / tangent;
  // A short arm tightens the whole band, preserving its common curve centre.
  const availableRadius = Math.min(
    ...corners.map(({ corner, depth }) => {
      const incomingLength = dotProduct(subtractPoints(corner, far(arriving)), incoming);
      const outgoingLength = dotProduct(subtractPoints(far(leaving), corner), outgoing);
      return (
        (Math.min(incomingLength, outgoingLength) * ZENTRUM_SCHEMATIC_BEND_REACH) / tangent -
        extraRadius(depth)
      );
    }),
  );
  const innerRadius = Math.max(0, Math.min(preferredRadius, availableRadius));
  return (innerRadius + extraRadius(own.depth)) * tangent;
};

const getZentrumSchematicLinePathBend = (
  segment: { from: SchematicPoint; to: SchematicPoint },
  next: { from: SchematicPoint; to: SchematicPoint },
  laneBendDistance?: number,
): ZentrumSchematicLinePathBend => {
  const incomingDirection = getUnitVector(segment.from, segment.to);
  const outgoingDirection = getUnitVector(next.from, next.to);
  // A lane held level needs no join; a turn meeting at the stop still rounds.
  if (
    next.from.x === segment.to.x &&
    next.from.y === segment.to.y &&
    Math.abs(crossProduct(incomingDirection, outgoingDirection)) < 0.001
  ) {
    return { approach: segment.to, leave: segment.to, data: "", points: [] };
  }
  const corner = getLineIntersection(segment.to, incomingDirection, next.from, outgoingDirection);
  const incomingLength = Math.hypot(segment.to.x - segment.from.x, segment.to.y - segment.from.y);
  const outgoingLength = Math.hypot(next.to.x - next.from.x, next.to.y - next.from.y);
  const incomingDistance = corner
    ? dotProduct(subtractPoints(corner, segment.from), incomingDirection)
    : 0;
  const outgoingDistance = corner
    ? dotProduct(subtractPoints(next.to, corner), outgoingDirection)
    : 0;
  if (corner && incomingDistance > 0 && outgoingDistance > 0) {
    const bendDistance =
      laneBendDistance === undefined
        ? Math.min(ZENTRUM_SCHEMATIC_LINE_BEND_DISTANCE, incomingDistance / 3, outgoingDistance / 3)
        : Math.min(
            laneBendDistance,
            incomingDistance * ZENTRUM_SCHEMATIC_BEND_REACH,
            outgoingDistance * ZENTRUM_SCHEMATIC_BEND_REACH,
          );
    const approach = {
      x: corner.x - incomingDirection.x * bendDistance,
      y: corner.y - incomingDirection.y * bendDistance,
    };
    const leave = {
      x: corner.x + outgoingDirection.x * bendDistance,
      y: corner.y + outgoingDirection.y * bendDistance,
    };
    const turnAngle = Math.acos(
      Math.max(-1, Math.min(1, dotProduct(incomingDirection, outgoingDirection))),
    );
    const radius = bendDistance / Math.tan(turnAngle / 2);
    const sweep = crossProduct(incomingDirection, outgoingDirection) > 0 ? 1 : 0;
    return {
      approach,
      leave,
      data: `A ${radius.toFixed(2)} ${radius.toFixed(2)} 0 0 ${sweep} ${formatPoint(leave)}`,
      points: getZentrumSchematicBendPoints(radius, approach, leave, incomingDirection),
    };
  }
  const bendDistance = Math.min(
    ZENTRUM_SCHEMATIC_LINE_BEND_DISTANCE,
    incomingLength / 3,
    outgoingLength / 3,
  );
  const approach = {
    x: segment.to.x - incomingDirection.x * bendDistance,
    y: segment.to.y - incomingDirection.y * bendDistance,
  };
  const leave = {
    x: next.from.x + outgoingDirection.x * bendDistance,
    y: next.from.y + outgoingDirection.y * bendDistance,
  };
  return {
    approach,
    leave,
    data: `C ${formatPoint(segment.to)} ${formatPoint(next.from)} ${formatPoint(leave)}`,
    points: getZentrumSchematicCubicPoints(segment.to, next.from, approach, leave),
  };
};

/** One corridor of a line pattern, on the line's own lane, in the direction the pattern runs it. */
type ZentrumSchematicLaneLeg = {
  edgeId: string;
  fromNodeId: string;
  toNodeId: string;
  from: SchematicPoint;
  to: SchematicPoint;
};

/** Where an end leg's lane, run on, crosses the nearest of its stop's capsules. */
const getCapsuleEnd = (
  end: SchematicPoint,
  other: SchematicPoint,
  capsules: readonly ZentrumSchematicStroke[],
): SchematicPoint => {
  const direction = getUnitVector(other, end);
  const crossings = capsules.flatMap(({ from, to }) => {
    const span = subtractPoints(to, from);
    const length = Math.hypot(span.x, span.y);
    if (length === 0) return [];
    const crossing = getLineIntersection(end, direction, from, {
      x: span.x / length,
      y: span.y / length,
    });
    if (!crossing) return [];
    const onCapsule = dotProduct(subtractPoints(crossing, from), span) / (length * length);
    const beyond = dotProduct(subtractPoints(crossing, end), direction);
    const legLength = Math.hypot(end.x - other.x, end.y - other.y);
    return onCapsule >= 0 && onCapsule <= 1 && beyond > -legLength
      ? [{ crossing, distance: Math.abs(beyond) }]
      : [];
  });
  return (
    crossings.reduce<{ crossing: SchematicPoint; distance: number } | undefined>(
      (best, option) => (!best || option.distance < best.distance ? option : best),
      undefined,
    )?.crossing ?? end
  );
};

/**
 * A pattern's legs and the bends between them; the stroke and the marks' paths both read this.
 * With the stops' capsules, the pattern's two ends stop on them.
 */
const getZentrumSchematicLaneLegs = (
  linePath: ZentrumSchematicLinePath,
  edges: readonly ZentrumSchematicEdge[],
  trackWidth: number | undefined,
  capsulesByNodeId?: ReadonlyMap<string, readonly ZentrumSchematicStroke[]>,
): { legs: readonly ZentrumSchematicLaneLeg[]; bends: readonly ZentrumSchematicLinePathBend[] } => {
  const edgeByKey = new Map(edges.map((edge) => [edge.id, edge]));
  const legs = linePath.nodes.slice(1).flatMap((to, index) => {
    const from = linePath.nodes[index];
    const edge = edgeByKey.get(getEdgeKey(from.id, to.id));
    return edge
      ? [
          {
            edgeId: edge.id,
            fromNodeId: from.id,
            toNodeId: to.id,
            from: getLineTrackPoint(edge, from, linePath.trackId, edge.trackIds, trackWidth),
            to: getLineTrackPoint(edge, to, linePath.trackId, edge.trackIds, trackWidth),
          },
        ]
      : [];
  });
  const bends = legs.slice(0, -1).map((leg, index) => {
    const next = legs[index + 1];
    const arriving = edgeByKey.get(leg.edgeId);
    const leaving = edgeByKey.get(next.edgeId);
    const node = linePath.nodes.find(({ id }) => id === leg.toNodeId);
    const laneBendDistance =
      arriving && leaving && node
        ? getLaneBendDistance(node, arriving, leaving, linePath.trackId, trackWidth)
        : undefined;
    return getZentrumSchematicLinePathBend(leg, next, laneBendDistance);
  });
  const first = legs[0];
  const last = legs.at(-1);
  if (!capsulesByNodeId || !first || !last) return { legs, bends };
  const firstFrom = getCapsuleEnd(
    first.from,
    first.to,
    capsulesByNodeId.get(first.fromNodeId) ?? [],
  );
  const lastTo = getCapsuleEnd(last.to, last.from, capsulesByNodeId.get(last.toNodeId) ?? []);
  const ended = legs.map((leg, index) => ({
    ...leg,
    from: index === 0 ? firstFrom : leg.from,
    to: index === legs.length - 1 ? lastTo : leg.to,
  }));
  return { legs: ended, bends };
};

/** Where a lane is not straight at a stop: a turn, or a step sideways, as the points it draws. */
export type ZentrumSchematicLaneBend = {
  nodeId: string;
  trackId: string;
  points: readonly SchematicPoint[];
};

/** Every lane's bends at the stops it passes, which a stop's sign keeps off. */
export function getZentrumSchematicLaneBends(
  linePaths: readonly ZentrumSchematicLinePath[],
  edges: readonly ZentrumSchematicEdge[],
  trackWidth: number,
): readonly ZentrumSchematicLaneBend[] {
  return linePaths.flatMap((linePath) => {
    const { legs, bends } = getZentrumSchematicLaneLegs(linePath, edges, trackWidth);
    return bends.flatMap((bend, index) =>
      bend.points.length > 0
        ? [{ nodeId: legs[index].toNodeId, trackId: linePath.trackId, points: bend.points }]
        : [],
    );
  });
}

type ZentrumSchematicLinePathPiece = {
  edgeId: string;
  start: SchematicPoint;
  commands: readonly string[];
};

/** The pattern as one piece per corridor (bend in, then straight), so path and stretches agree. */
const getZentrumSchematicLinePathPieces = (
  linePath: ZentrumSchematicLinePath,
  edges: readonly ZentrumSchematicEdge[],
  trackWidth: number | undefined,
  capsulesByNodeId?: ReadonlyMap<string, readonly ZentrumSchematicStroke[]>,
): readonly ZentrumSchematicLinePathPiece[] => {
  const { legs, bends } = getZentrumSchematicLaneLegs(
    linePath,
    edges,
    trackWidth,
    capsulesByNodeId,
  );
  return legs.map((segment, index) => {
    const incomingBend = bends[index - 1];
    const outgoingBend = bends[index];
    const start = incomingBend ? incomingBend.approach : segment.from;
    const end = outgoingBend ? outgoingBend.approach : segment.to;
    const commands = [...(incomingBend?.data ? [incomingBend.data] : []), `L ${formatPoint(end)}`];
    return { edgeId: segment.edgeId, start, commands };
  });
};

/**
 * A mark's stretch along one corridor, as the stroke's own points, so it turns where the stroke
 * does.
 */
export type ZentrumSchematicCorridorPath = {
  /** The corridor's two ends, in the order the line path runs them. */
  fromNodeId: string;
  toNodeId: string;
  /** In the line path's own direction, duplicates removed. */
  points: readonly SchematicPoint[];
  /**
   * Each point's share of the length, ascending to 1; marks are keyframed on these to follow bends.
   */
  steps: readonly number[];
};

/** Where along a segment it crosses a capsule's spine, as a share; undefined if not. */
const getStopLineCrossing = (
  start: SchematicPoint,
  end: SchematicPoint,
  line: ZentrumSchematicStroke,
): number | undefined => {
  const run = subtractPoints(end, start);
  const span = subtractPoints(line.to, line.from);
  const across = crossProduct(run, span);
  if (Math.abs(across) < 1e-9) return undefined;
  const offset = subtractPoints(line.from, start);
  const along = crossProduct(offset, span) / across;
  const onLine = crossProduct(offset, run) / across;
  return along >= 0 && along <= 1 && onLine >= 0 && onLine <= 1 ? along : undefined;
};

/**
 * A pattern's stroke across one stop from the first capsule it crosses to the last, which a run
 * calling at both places in turn rides between its two calls.
 */
export type ZentrumSchematicStopStretch = {
  nodeId: string;
  /** The stops either side (not junctions), in the line path's order. */
  fromNodeId: string;
  toNodeId: string;
  points: readonly SchematicPoint[];
  steps: readonly number[];
};

/** A stop stretch's key: the stop and the stops either side, in either order. */
export const getZentrumSchematicStopStretchKey = (
  nodeId: string,
  sideNodeId: string,
  otherSideNodeId: string,
): string => `${nodeId}\u0001${getEdgeKey(sideNodeId, otherSideNodeId)}`;

/** A stop stretch, read in the direction of a run arriving from `fromNodeId`. */
export const orientZentrumSchematicStopStretch = (
  stretch: ZentrumSchematicStopStretch,
  fromNodeId: string,
): ZentrumSchematicStopStretch =>
  stretch.fromNodeId === fromNodeId
    ? stretch
    : {
        ...stretch,
        fromNodeId: stretch.toNodeId,
        toNodeId: stretch.fromNodeId,
        points: [...stretch.points].reverse(),
        steps: stretch.steps.map((step) => 1 - step).reverse(),
      };

/**
 * One pattern's vehicle paths by corridor, stop to stop, cut where the stroke crosses each stop's
 * capsule so marks halt on it. Without a capsule crossing, the cut falls where the bend starts, or
 * at the stop. A corridor through a junction is one path. Where the stroke crosses two or more of a
 * stop's capsules, the stretch between the outermost crossings is kept as well.
 */
export function getZentrumSchematicVehiclePaths(
  linePath: ZentrumSchematicLinePath,
  edges: readonly ZentrumSchematicEdge[],
  trackWidth: number | undefined,
  stopLinesByNodeId: ReadonlyMap<string, readonly ZentrumSchematicStroke[]>,
): {
  pathsByCorridorId: ReadonlyMap<string, ZentrumSchematicCorridorPath>;
  stopStretches: readonly ZentrumSchematicStopStretch[];
} {
  const { legs, bends } = getZentrumSchematicLaneLegs(
    linePath,
    edges,
    trackWidth,
    stopLinesByNodeId,
  );
  const pathsByCorridorId = new Map<string, ZentrumSchematicCorridorPath>();
  const stopStretches: ZentrumSchematicStopStretch[] = [];
  if (legs.length === 0) return { pathsByCorridorId, stopStretches };

  // The whole stroke as one polyline, with each point's distance along it.
  const points: SchematicPoint[] = [];
  const distances: number[] = [];
  const push = (point: SchematicPoint) => {
    const last = points.at(-1);
    if (last && last.x === point.x && last.y === point.y) return;
    distances.push(
      last ? (distances.at(-1) ?? 0) + Math.hypot(point.x - last.x, point.y - last.y) : 0,
    );
    points.push(point);
  };
  const fallbacks = [0];
  push(legs[0].from);
  for (const [index, bend] of bends.entries()) {
    push(bend.points[0] ?? legs[index].to);
    fallbacks.push(distances.at(-1) ?? 0);
    for (const point of bend.points.slice(1)) push(point);
  }
  push(legs[legs.length - 1].to);
  const total = distances.at(-1) ?? 0;
  fallbacks.push(total);
  if (points.length < 2) return { pathsByCorridorId, stopStretches };

  // Each stop is looked for between the middles of the stretches either side of it.
  const nodeIds = [legs[0].fromNodeId, ...legs.map(({ toNodeId }) => toNodeId)];
  const stopIndices = nodeIds.flatMap((nodeId, index) =>
    stopLinesByNodeId.has(nodeId) ? [index] : [],
  );
  // Where each stop is cut, and the first and last capsule crossings where two capsules are crossed.
  const crossingSpans: ({ first: number; last: number } | undefined)[] = [];
  const cuts = stopIndices.map((index, at) => {
    const nodeId = nodeIds[index];
    const fallback = fallbacks[index];
    const earliest = at === 0 ? 0 : (fallbacks[stopIndices[at - 1]] + fallback) / 2;
    const latest =
      at === stopIndices.length - 1 ? total : (fallback + fallbacks[stopIndices[at + 1]]) / 2;
    let cut = fallback;
    const crossings: number[] = [];
    let crossedCapsules = 0;
    for (const line of stopLinesByNodeId.get(nodeId) ?? []) {
      let crossesLine = false;
      for (let point = 1; point < points.length; point += 1) {
        const along = getStopLineCrossing(points[point - 1], points[point], line);
        if (along === undefined) continue;
        const distance = distances[point - 1] + (distances[point] - distances[point - 1]) * along;
        if (distance < earliest || distance > latest) continue;
        crossings.push(distance);
        crossesLine = true;
        if (cut === fallback || Math.abs(distance - fallback) < Math.abs(cut - fallback)) {
          cut = distance;
        }
      }
      if (crossesLine) crossedCapsules += 1;
    }
    crossingSpans.push(
      crossedCapsules >= 2
        ? { first: Math.min(...crossings), last: Math.max(...crossings) }
        : undefined,
    );
    return cut;
  });

  const pointAt = (distance: number): SchematicPoint => {
    let index = 1;
    while (index < points.length - 1 && distances[index] < distance) index += 1;
    const span = distances[index] - distances[index - 1];
    const share = span > 0 ? (distance - distances[index - 1]) / span : 0;
    return {
      x: points[index - 1].x + (points[index].x - points[index - 1].x) * share,
      y: points[index - 1].y + (points[index].y - points[index - 1].y) * share,
    };
  };
  const getStretch = (start: number, end: number) => {
    const stretch = [
      pointAt(start),
      ...points.filter((_, point) => distances[point] > start && distances[point] < end),
      pointAt(end),
    ];
    const steps = getZentrumSchematicPathSteps(stretch);
    return steps && { points: stretch, steps };
  };
  stopIndices.slice(1).forEach((index, at) => {
    const stretch = getStretch(cuts[at], cuts[at + 1]);
    const [fromNodeId, toNodeId] = [nodeIds[stopIndices[at]], nodeIds[index]];
    if (stretch)
      pathsByCorridorId.set(getEdgeKey(fromNodeId, toNodeId), {
        fromNodeId,
        toNodeId,
        ...stretch,
      });
  });
  stopIndices.forEach((index, at) => {
    const span = crossingSpans[at];
    const [fromNodeId, toNodeId] = [nodeIds[stopIndices[at - 1]], nodeIds[stopIndices[at + 1]]];
    const stretch = span && getStretch(span.first, span.last);
    if (stretch && fromNodeId && toNodeId)
      stopStretches.push({ nodeId: nodeIds[index], fromNodeId, toNodeId, ...stretch });
  });
  return { pathsByCorridorId, stopStretches };
}

/**
 * A vehicle path cut back to where it meets a point on it: the part after `start`, or the part
 * before `end`. The point is taken at the nearest place along the path.
 */
export function trimZentrumSchematicCorridorPath(
  path: ZentrumSchematicCorridorPath,
  { start, end }: { start?: SchematicPoint; end?: SchematicPoint },
): ZentrumSchematicCorridorPath {
  const nearest = (points: readonly SchematicPoint[], target: SchematicPoint) => {
    let best = { segment: 1, point: points[0], distance: Number.POSITIVE_INFINITY };
    for (let segment = 1; segment < points.length; segment += 1) {
      const from = points[segment - 1];
      const run = subtractPoints(points[segment], from);
      const length = dotProduct(run, run);
      const share =
        length > 0
          ? Math.max(0, Math.min(1, dotProduct(subtractPoints(target, from), run) / length))
          : 0;
      const point = { x: from.x + run.x * share, y: from.y + run.y * share };
      const distance = Math.hypot(point.x - target.x, point.y - target.y);
      if (distance < best.distance) best = { segment, point, distance };
    }
    return best;
  };
  let points = path.points;
  if (end) {
    const { segment, point } = nearest(points, end);
    points = [...points.slice(0, segment), point];
  }
  if (start) {
    const { segment, point } = nearest(points, start);
    points = [point, ...points.slice(segment)];
  }
  const steps = getZentrumSchematicPathSteps(points);
  return steps ? { ...path, points, steps } : path;
}

/** Each point's share of the run's length; undefined for no length. */
export const getZentrumSchematicPathSteps = (
  points: readonly SchematicPoint[],
): readonly number[] | undefined => {
  const steps: number[] = [0];
  let length = 0;
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    length += Math.hypot(current.x - previous.x, current.y - previous.y);
    steps.push(length);
  }
  if (length <= 0) return undefined;
  return steps.map((step) => step / length);
};

/** A vehicle path the other way round. */
export const reverseZentrumSchematicCorridorPath = (
  path: ZentrumSchematicCorridorPath,
): ZentrumSchematicCorridorPath => ({
  fromNodeId: path.toNodeId,
  toNodeId: path.fromNodeId,
  points: [...path.points].reverse(),
  steps: path.steps.map((step) => 1 - step).reverse(),
});

/** A corridor's vehicle path, read from the stop a run leaves it by. */
export const orientZentrumSchematicCorridorPath = (
  path: ZentrumSchematicCorridorPath,
  fromNodeId: string,
): ZentrumSchematicCorridorPath =>
  path.fromNodeId === fromNodeId ? path : reverseZentrumSchematicCorridorPath(path);

/**
 * Trip-ordered vehicle paths joined into one stretch, dropping the point each shares with the one
 * before. Undefined where they add up to no length.
 */
export function joinZentrumSchematicCorridorPaths(
  paths: readonly ZentrumSchematicCorridorPath[],
): { points: readonly SchematicPoint[]; steps: readonly number[] } | undefined {
  const points = paths.flatMap((path, index) => (index === 0 ? path.points : path.points.slice(1)));
  const steps = getZentrumSchematicPathSteps(points);
  return steps ? { points, steps } : undefined;
}

/** The part of a vehicle path between two progresses, as a polyline. */
export function getZentrumSchematicVehiclePathData(
  path: { points: readonly SchematicPoint[]; steps: readonly number[] },
  startProgress: number,
  endProgress = 1,
): string {
  const start = Math.min(1, Math.max(0, startProgress));
  const end = Math.min(1, Math.max(0, endProgress));
  if (end <= start || path.points.length < 2) return "";

  const pointAt = (progress: number): SchematicPoint => {
    const { x, y } = getZentrumSchematicVehiclePathPlacement(path, progress);
    return { x, y };
  };

  const points = [pointAt(start)];
  for (let index = 1; index < path.points.length - 1; index += 1) {
    const progress = path.steps[index];
    if (progress > start && progress < end) points.push(path.points[index]);
  }
  points.push(pointAt(end));
  return [
    `M ${formatPoint(points[0])}`,
    ...points.slice(1).map((point) => `L ${formatPoint(point)}`),
  ].join(" ");
}

/** Where a mark stands on a vehicle path at a progress, and which way it points. */
export function getZentrumSchematicVehiclePathPlacement(
  path: { points: readonly SchematicPoint[]; steps: readonly number[] },
  progress: number,
): { x: number; y: number; angle: number | undefined } {
  const { points, steps } = path;
  const last = points.length - 1;
  if (last < 1) {
    const [point] = points;
    return point ? { x: point.x, y: point.y, angle: undefined } : { x: 0, y: 0, angle: undefined };
  }
  const share = Math.min(1, Math.max(0, progress));
  let index = 1;
  while (index < last && steps[index] < share) index += 1;
  const from = points[index - 1];
  const to = points[index];
  const span = steps[index] - steps[index - 1];
  const shareIn = span > 0 ? (share - steps[index - 1]) / span : 0;
  return {
    x: from.x + (to.x - from.x) * shareIn,
    y: from.y + (to.y - from.y) * shareIn,
    angle: (Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI,
  };
}
