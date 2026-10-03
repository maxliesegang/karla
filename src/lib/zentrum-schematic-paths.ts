/**
 * A line pattern as the drawing paints it: one softly bent stroke down its lanes. Geometry only;
 * which lane a line holds is decided in `zentrum-schematic-lanes.ts`.
 */
import {
  type SchematicPoint,
  type ZentrumSchematicEdge,
  type ZentrumSchematicLinePath,
  crossProduct,
  dotProduct,
  getEdgeKey,
  getLineIntersection,
  getLineTrackPoint,
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

/**
 * One uninterrupted, softly bent SVG path for a line pattern.
 *
 * At a turn the two lanes are extended to where they intersect and joined by an arc tangent to
 * both. That point is not the stop's centre, since the lanes are offset differently on each
 * corridor; using a corridor end as the corner would kink. A lane stepping sideways on a straight
 * joins with a cubic.
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
  /**
   * Every line drawn by this path. A trunk and its branches share a lane and a colour, so where
   * their patterns coincide they are painted once and the path answers for all of them.
   */
  lineIds: readonly string[];
  /** The pattern cut at the stops' capsules, one stretch per corridor, which an overlay lights by. */
  segments: readonly ZentrumSchematicLinePathSegment[];
};

/** The patterns the drawing paints: one path per distinct geometry, coincident lines gathered. */
export function getZentrumSchematicDrawnPaths(
  linePaths: readonly ZentrumSchematicLinePath[],
  edges: readonly ZentrumSchematicEdge[],
  trackWidth: number | undefined,
  stopLinesByNodeId: ReadonlyMap<string, readonly ZentrumSchematicStopLine[]> = new Map(),
): readonly ZentrumSchematicDrawnPath[] {
  const drawnByGeometry = new Map<string, ZentrumSchematicDrawnPath & { lineIds: string[] }>();
  for (const linePath of linePaths) {
    const pieces = getZentrumSchematicLinePathPieces(linePath, edges, trackWidth);
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
      segments: getZentrumSchematicLinePathSegments(linePath, edges, trackWidth, stopLinesByNodeId),
    });
  }
  return [...drawnByGeometry.values()];
}

/** One corridor's stretch of a drawn line pattern, from one stop's capsule to the next's. */
export type ZentrumSchematicLinePathSegment = {
  /** The observed corridor this stretch runs along. */
  edgeId: string;
  /** The stretch as an SVG path, in schematic units, starting where the previous one ended. */
  data: string;
};

/**
 * A drawn line pattern split at the stops, one stretch per corridor, cut where the marks halt: on
 * the stop's capsule. Joined end to end they run the whole of `getZentrumSchematicLinePathData`,
 * with its bends as the points a mark follows round them.
 */
export function getZentrumSchematicLinePathSegments(
  linePath: ZentrumSchematicLinePath,
  edges: readonly ZentrumSchematicEdge[],
  trackWidth: number | undefined,
  stopLinesByNodeId: ReadonlyMap<string, readonly ZentrumSchematicStopLine[]> = new Map(),
): readonly ZentrumSchematicLinePathSegment[] {
  return [
    ...getZentrumSchematicVehiclePathsByEdgeId(linePath, edges, trackWidth, stopLinesByNodeId),
  ].map(([edgeId, { points }]) => ({
    edgeId,
    data: points
      .map((point, index) => `${index === 0 ? "M" : "L"} ${formatPoint(point)}`)
      .join(" "),
  }));
}

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

/** The arc one bend draws: tangent to both lanes at the approach and the leave, around the corner. */
const getZentrumSchematicBendPoints = (
  radius: number,
  approach: SchematicPoint,
  leave: SchematicPoint,
  incomingDirection: SchematicPoint,
): readonly SchematicPoint[] => {
  // The centre is a radius off the approach, on the side from which the leave is a radius away too.
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

const getZentrumSchematicLinePathBend = (
  segment: { from: SchematicPoint; to: SchematicPoint },
  next: { from: SchematicPoint; to: SchematicPoint },
): ZentrumSchematicLinePathBend => {
  const incomingDirection = getUnitVector(segment.from, segment.to);
  const outgoingDirection = getUnitVector(next.from, next.to);
  // A lane held level through the stop needs no join. A turn whose lanes meet at the stop still
  // rounds, hence the direction test.
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
    const bendDistance = Math.min(
      ZENTRUM_SCHEMATIC_LINE_BEND_DISTANCE,
      incomingDistance / 3,
      outgoingDistance / 3,
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

/** A pattern's legs and the bends between them; the stroke and the marks' paths both read this. */
const getZentrumSchematicLaneLegs = (
  linePath: ZentrumSchematicLinePath,
  edges: readonly ZentrumSchematicEdge[],
  trackWidth: number | undefined,
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
            from: getLineTrackPoint(edge, from, linePath.trackId, edge.trackLineIds, trackWidth),
            to: getLineTrackPoint(edge, to, linePath.trackId, edge.trackLineIds, trackWidth),
          },
        ]
      : [];
  });
  const bends = legs
    .slice(0, -1)
    .map((leg, index) => getZentrumSchematicLinePathBend(leg, legs[index + 1]));
  return { legs, bends };
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

/**
 * The pattern as one piece per corridor: the bend into it and its straight. Each bit of geometry
 * belongs to exactly one piece, so the whole path and its stretches draw the same line.
 */
const getZentrumSchematicLinePathPieces = (
  linePath: ZentrumSchematicLinePath,
  edges: readonly ZentrumSchematicEdge[],
  trackWidth: number | undefined,
): readonly ZentrumSchematicLinePathPiece[] => {
  const { legs, bends } = getZentrumSchematicLaneLegs(linePath, edges, trackWidth);
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
 * The stretch a mark follows along one corridor: the stroke's own geometry as points, so a mark
 * hands over between corridors exactly where its line's stroke turns.
 */
export type ZentrumSchematicVehiclePath = {
  /** The corridor's two ends, in the order the line path runs them. */
  fromNodeId: string;
  toNodeId: string;
  /** In the line path's own direction, duplicates removed. */
  points: readonly SchematicPoint[];
  /**
   * Each point's share of the path's length, ascending to 1. A moving mark is keyframed on these,
   * so the compositor's straight interpolation follows the bend.
   */
  steps: readonly number[];
};

/** A straight a mark halts on at a stop: the spine of one of the stop's capsules. */
export type ZentrumSchematicStopLine = { from: SchematicPoint; to: SchematicPoint };

/** How far along a stroke's segment it crosses a stop line, as a share of it; undefined if not. */
const getStopLineCrossing = (
  start: SchematicPoint,
  end: SchematicPoint,
  line: ZentrumSchematicStopLine,
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
 * One line pattern's vehicle paths, by the corridor each is read on.
 *
 * The pattern's stroke is cut where it crosses each stop's capsule, so a mark halts on the capsule
 * it calls at. A capsule laid out along an arm past a bend (a corner stop, or a place standing
 * clear of the curves) has the mark ride round the bend to it. Where the lane crosses no capsule,
 * the cut falls where the stroke starts its bend, or at the stop on a straight.
 */
export function getZentrumSchematicVehiclePathsByEdgeId(
  linePath: ZentrumSchematicLinePath,
  edges: readonly ZentrumSchematicEdge[],
  trackWidth: number | undefined,
  stopLinesByNodeId: ReadonlyMap<string, readonly ZentrumSchematicStopLine[]> = new Map(),
): ReadonlyMap<string, ZentrumSchematicVehiclePath> {
  const { legs, bends } = getZentrumSchematicLaneLegs(linePath, edges, trackWidth);
  const pathsByEdgeId = new Map<string, ZentrumSchematicVehiclePath>();
  if (legs.length === 0) return pathsByEdgeId;

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
  if (points.length < 2) return pathsByEdgeId;

  // Each stop is looked for between the middles of the stretches either side of it.
  const nodeIds = [legs[0].fromNodeId, ...legs.map(({ toNodeId }) => toNodeId)];
  const cuts = nodeIds.map((nodeId, index) => {
    const fallback = fallbacks[index];
    const earliest = index === 0 ? 0 : (fallbacks[index - 1] + fallback) / 2;
    const latest = index === nodeIds.length - 1 ? total : (fallback + fallbacks[index + 1]) / 2;
    let cut = fallback;
    for (const line of stopLinesByNodeId.get(nodeId) ?? []) {
      for (let point = 1; point < points.length; point += 1) {
        const along = getStopLineCrossing(points[point - 1], points[point], line);
        if (along === undefined) continue;
        const distance = distances[point - 1] + (distances[point] - distances[point - 1]) * along;
        if (distance < earliest || distance > latest) continue;
        if (cut === fallback || Math.abs(distance - fallback) < Math.abs(cut - fallback)) {
          cut = distance;
        }
      }
    }
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
  legs.forEach((leg, index) => {
    const [start, end] = [cuts[index], cuts[index + 1]];
    const stretch = [
      pointAt(start),
      ...points.filter((_, point) => distances[point] > start && distances[point] < end),
      pointAt(end),
    ];
    const steps = getPathSteps(stretch);
    if (steps)
      pathsByEdgeId.set(leg.edgeId, {
        fromNodeId: leg.fromNodeId,
        toNodeId: leg.toNodeId,
        points: stretch,
        steps,
      });
  });
  return pathsByEdgeId;
}

/** Each point's share of the run's length; undefined for no length. */
const getPathSteps = (points: readonly SchematicPoint[]): readonly number[] | undefined => {
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
export const reverseZentrumSchematicVehiclePath = (
  path: ZentrumSchematicVehiclePath,
): ZentrumSchematicVehiclePath => ({
  fromNodeId: path.toNodeId,
  toNodeId: path.fromNodeId,
  points: [...path.points].reverse(),
  steps: path.steps.map((step) => 1 - step).reverse(),
});

/** A corridor's vehicle path, read from the stop a run leaves it by. */
export const orientZentrumSchematicVehiclePath = (
  path: ZentrumSchematicVehiclePath,
  fromNodeId: string,
): ZentrumSchematicVehiclePath =>
  path.fromNodeId === fromNodeId ? path : reverseZentrumSchematicVehiclePath(path);

/**
 * Trip-ordered vehicle paths joined into one stretch, dropping the point each shares with the one
 * before. Undefined where they add up to no length.
 */
export function joinZentrumSchematicVehiclePaths(
  paths: readonly ZentrumSchematicVehiclePath[],
): { points: readonly SchematicPoint[]; steps: readonly number[] } | undefined {
  const points = paths.flatMap((path, index) => (index === 0 ? path.points : path.points.slice(1)));
  const steps = getPathSteps(points);
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
