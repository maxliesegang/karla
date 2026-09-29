/**
 * A line pattern as the drawing paints it: one softly bent stroke down the lanes it holds.
 *
 * Geometry only. Which lane a line is in is the layout's answer (`zentrum-schematic-lanes.ts`);
 * this is what that answer looks like drawn — the straights, the arcs that join them, and the
 * stretches the drawing lights one at a time.
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

/** How finely a bend is read as points for a mark to follow along it. */
const ZENTRUM_SCHEMATIC_BEND_SAMPLES = 6;
/**
 * How far a line rounds a turn before and after its lane intersection.
 *
 * Kept close to the stop: a broad bend can skirt around the authored station coordinate, leaving
 * the stop's own mark beside the lines it is meant to gather. Ten units leaves the turn soft while
 * its middle still crosses the stop, including the offset outer lanes of a busy corridor.
 */
const ZENTRUM_SCHEMATIC_LINE_BEND_DISTANCE = 10;

/**
 * One uninterrupted, softly bent SVG path for an observed line pattern.
 *
 * Each straight keeps the line's stable lane within its corridor. At a turn, the two lane
 * centre-lines are extended to their geometric intersection and joined by a circular arc tangent
 * to both. The intersection is not necessarily the stop's centre: the lanes on the two corridors
 * can have different offsets. Using either corridor's endpoint as the corner makes the apparent
 * angle wrong and produces a kink, most visibly at a right angle. A straight join still uses a
 * cubic transition, so a corridor whose companions change can move the line sideways without a
 * mitred corner.
 */
export function getZentrumSchematicLinePathData(
  linePath: ZentrumSchematicLinePath,
  edges: readonly ZentrumSchematicEdge[],
  trackWidth: number | undefined,
): string {
  const pieces = getZentrumSchematicLinePathPieces(linePath, edges, trackWidth);
  if (pieces.length === 0) return "";
  return [`M ${formatPoint(pieces[0].start)}`, ...pieces.flatMap(({ commands }) => commands)].join(
    " ",
  );
}

/** One line pattern as the drawing paints it: the geometry, and every line that geometry is. */
export type ZentrumSchematicDrawnPath = ZentrumSchematicLinePath & {
  /** The pattern as one SVG path, in the drawing's own units. */
  data: string;
  /**
   * Every line drawn by this one path.
   *
   * A trunk and its branches hold one lane and are signed one colour, so wherever their patterns
   * coincide they are one drawn path — and that path answers for all of them. Printing it once per
   * line would only lay the line, and its casing, exactly over itself; asking it for one line's
   * identity would light the lane for whichever of them happened to be laid out first.
   */
  lineIds: readonly string[];
};

/**
 * The patterns the drawing actually paints: one path per distinct piece of geometry.
 *
 * Path data is the drawing's dearest reading, and coincident patterns are gathered here rather
 * than laid over one another — so the drawing paints each lane once, and a lane answers for every
 * line running in it.
 */
export function getZentrumSchematicDrawnPaths(
  linePaths: readonly ZentrumSchematicLinePath[],
  edges: readonly ZentrumSchematicEdge[],
  trackWidth: number | undefined,
): readonly ZentrumSchematicDrawnPath[] {
  const drawnByGeometry = new Map<string, ZentrumSchematicDrawnPath & { lineIds: string[] }>();
  for (const linePath of linePaths) {
    const data = getZentrumSchematicLinePathData(linePath, edges, trackWidth);
    const coincident = drawnByGeometry.get(`${linePath.trackId}:${data}`);
    if (coincident) {
      coincident.lineIds.push(linePath.lineId);
      continue;
    }
    drawnByGeometry.set(`${linePath.trackId}:${data}`, {
      ...linePath,
      data,
      lineIds: [linePath.lineId],
    });
  }
  return [...drawnByGeometry.values()];
}

/** One corridor's stretch of a drawn line pattern: the turn into it, and the straight along it. */
export type ZentrumSchematicLinePathSegment = {
  /** The observed corridor this stretch runs along. */
  edgeId: string;
  /** The stretch as an SVG path, in schematic units, starting where the previous one ended. */
  data: string;
};

/**
 * A drawn line pattern split at the stops, one stretch per corridor it runs along.
 *
 * The stretch a corridor gets is its own straight and the bend leaving the stop before it -- the
 * turn is how the line arrives in the corridor, so it colours with the corridor being entered,
 * which is the one a vehicle heading along it is making for. Joined end to end the stretches are
 * the one drawn line (`getZentrumSchematicLinePathData`), so a reading that colours stretch by
 * stretch and one that draws the line whole lay the same geometry on the same lane.
 */
export function getZentrumSchematicLinePathSegments(
  linePath: ZentrumSchematicLinePath,
  edges: readonly ZentrumSchematicEdge[],
  trackWidth: number | undefined,
): readonly ZentrumSchematicLinePathSegment[] {
  return getZentrumSchematicLinePathPieces(linePath, edges, trackWidth).map(
    ({ edgeId, start, commands }) => ({
      edgeId,
      data: [`M ${formatPoint(start)}`, ...commands].join(" "),
    }),
  );
}

/** How the path leaves one corridor's lane for the next: a bend, or nothing at all. */
type ZentrumSchematicLinePathBend = {
  /** Where the straight of the outgoing corridor's stretch begins, on that corridor's lane. */
  approach: SchematicPoint;
  /** Where the bend ends and the next corridor's straight takes over. */
  leave: SchematicPoint;
  /** The bend's own commands, empty where the two lanes meet without one. */
  data: string;
  /**
   * The bend as points from the approach to the leave, the arc sampled finely enough that a mark
   * riding them reads as turning the same curve the stroke draws. Empty where there is no bend.
   */
  points: readonly SchematicPoint[];
};

/** The arc one bend draws: tangent to both lanes at the approach and the leave, around the corner. */
const getZentrumSchematicBendPoints = (
  bendDistance: number,
  approach: SchematicPoint,
  leave: SchematicPoint,
  incomingDirection: SchematicPoint,
  outgoingDirection: SchematicPoint,
): readonly SchematicPoint[] => {
  const turnAngle = Math.acos(
    Math.max(
      -1,
      Math.min(
        1,
        incomingDirection.x * outgoingDirection.x + incomingDirection.y * outgoingDirection.y,
      ),
    ),
  );
  const radius = bendDistance / Math.tan(turnAngle / 2);
  // The centre stands a radius off the approach, across the incoming lane; of the two sides it is
  // the one from which the leave is a radius away too.
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
  // The arc the geometry subtends is the turn angle itself, and the samples read the shorter way
  // round between the two radii.
  let sweep = endAngle - startAngle;
  while (sweep > Math.PI) sweep -= 2 * Math.PI;
  while (sweep < -Math.PI) sweep += 2 * Math.PI;
  return Array.from({ length: ZENTRUM_SCHEMATIC_BEND_SAMPLES + 1 }, (_, index) => {
    const angle = startAngle + (sweep * index) / ZENTRUM_SCHEMATIC_BEND_SAMPLES;
    return { x: chosen.x + Math.cos(angle) * radius, y: chosen.y + Math.sin(angle) * radius };
  });
};

/** A cubic sampled the way the bend's own command states it, from the approach to the leave. */
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
  // A lane held level through the stop arrives exactly where the next corridor's lane starts and
  // runs on in the same direction, so the join is nothing at all and the straight runs on through.
  // A corner whose lanes meet on the stop itself is not this: it is still a turn, and still rounds.
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
      Math.max(
        -1,
        Math.min(
          1,
          incomingDirection.x * outgoingDirection.x + incomingDirection.y * outgoingDirection.y,
        ),
      ),
    );
    const radius = bendDistance / Math.tan(turnAngle / 2);
    const sweep = crossProduct(incomingDirection, outgoingDirection) > 0 ? 1 : 0;
    return {
      approach,
      leave,
      data: `A ${radius.toFixed(2)} ${radius.toFixed(2)} 0 0 ${sweep} ${formatPoint(leave)}`,
      points: getZentrumSchematicBendPoints(
        bendDistance,
        approach,
        leave,
        incomingDirection,
        outgoingDirection,
      ),
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

type ZentrumSchematicLinePathPiece = {
  edgeId: string;
  start: SchematicPoint;
  commands: readonly string[];
};

/**
 * The drawn line pattern as one piece per corridor, from which the whole path and the per-corridor
 * stretches are both read.
 *
 * A piece carries its corridor's straight and the bend leaving the stop before it; the bend into
 * the first corridor is the pattern's start, and the last corridor's straight runs to the
 * pattern's end. Every piece of geometry belongs to exactly one piece, so stretching and joining
 * the pieces draw the same line exactly once.
 */
const getZentrumSchematicLinePathPieces = (
  linePath: ZentrumSchematicLinePath,
  edges: readonly ZentrumSchematicEdge[],
  trackWidth: number | undefined,
): readonly ZentrumSchematicLinePathPiece[] => {
  const edgeByKey = new Map(edges.map((edge) => [edge.id, edge]));
  const segments = linePath.nodes.slice(1).flatMap((to, index) => {
    const from = linePath.nodes[index];
    const edge = edgeByKey.get(getEdgeKey(from.id, to.id));
    return edge
      ? [
          {
            edgeId: edge.id,
            from: getLineTrackPoint(edge, from, linePath.trackId, edge.trackLineIds, trackWidth),
            to: getLineTrackPoint(edge, to, linePath.trackId, edge.trackLineIds, trackWidth),
          },
        ]
      : [];
  });
  if (segments.length === 0) return [];

  const bends = segments
    .slice(0, -1)
    .map((segment, index) => getZentrumSchematicLinePathBend(segment, segments[index + 1]));
  return segments.map((segment, index) => {
    const incomingBend = bends[index - 1];
    const outgoingBend = bends[index];
    const start = incomingBend ? incomingBend.approach : segment.from;
    const end = outgoingBend ? outgoingBend.approach : segment.to;
    const commands = [...(incomingBend?.data ? [incomingBend.data] : []), `L ${formatPoint(end)}`];
    return { edgeId: segment.edgeId, start, commands };
  });
};

/**
 * The drawn stretch a mark follows for one corridor of one line path, as the stroke paints it.
 *
 * This is the same geometry the path data states, read as points rather than commands: the bend
 * into the corridor (which belongs to the corridor being entered), then the straight along it.
 * Two corridors' paths meet at one point -- the approach the stroke itself turns through -- so a
 * mark following its line's lane hands over between corridors exactly where its line's stroke does,
 * turning the corner instead of jumping across it.
 */
export type ZentrumSchematicVehiclePath = {
  /** The corridor's two ends, in the order the line path runs them. */
  fromNodeId: string;
  toNodeId: string;
  /** The vehicle path as points, in the line path's own direction, duplicates removed. */
  points: readonly SchematicPoint[];
  /**
   * How far along the vehicle path each point stands, as a share of its length: ascending, ending at 1.
   * These are the boundaries a moving mark is keyframed on, so the compositor's straight
   * interpolation between them follows the drawn bend.
   */
  steps: readonly number[];
};

/** One line pattern's vehicle paths, by the corridor each is read on. */
export function getZentrumSchematicVehiclePathsByEdgeId(
  linePath: ZentrumSchematicLinePath,
  edges: readonly ZentrumSchematicEdge[],
  trackWidth: number | undefined,
): ReadonlyMap<string, ZentrumSchematicVehiclePath> {
  const edgeByKey = new Map(edges.map((edge) => [edge.id, edge]));
  const segments = linePath.nodes.slice(1).flatMap((to, index) => {
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

  const bends = segments
    .slice(0, -1)
    .map((segment, index) => getZentrumSchematicLinePathBend(segment, segments[index + 1]));
  const pathsByEdgeId = new Map<string, ZentrumSchematicVehiclePath>();
  segments.forEach((segment, index) => {
    const incomingBend = bends[index - 1];
    const outgoingBend = bends[index];
    const end = outgoingBend ? outgoingBend.approach : segment.to;
    const points = [
      ...(incomingBend && incomingBend.points.length > 0 ? incomingBend.points : [segment.from]),
      end,
    ];
    const steps = getPathSteps(points);
    if (steps)
      pathsByEdgeId.set(segment.edgeId, {
        fromNodeId: segment.fromNodeId,
        toNodeId: segment.toNodeId,
        points,
        steps,
      });
  });
  return pathsByEdgeId;
}

/** How far along a run of points each stands, as a share of the whole; undefined for no length. */
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

/** A vehicle path read the other way round, for runs that travel it backwards. */
export const reverseZentrumSchematicVehiclePath = (
  path: ZentrumSchematicVehiclePath,
): ZentrumSchematicVehiclePath => ({
  fromNodeId: path.toNodeId,
  toNodeId: path.fromNodeId,
  points: [...path.points].reverse(),
  steps: path.steps.map((step) => 1 - step).reverse(),
});

/**
 * Several vehicle paths of one line joined into the one stretch a mark follows across them.
 *
 * The paths are handed in trip-ordered, so each begins where the one before it ends -- the approach
 * the stroke itself turns through -- and the join drops the shared point. Nothing where the paths
 * add up to no length, which a straight across a single stop is.
 */
export function joinZentrumSchematicVehiclePaths(
  paths: readonly ZentrumSchematicVehiclePath[],
): { points: readonly SchematicPoint[]; steps: readonly number[] } | undefined {
  const points = paths.flatMap((path, index) => (index === 0 ? path.points : path.points.slice(1)));
  const steps = getPathSteps(points);
  return steps ? { points, steps } : undefined;
}

/** A vehicle path's visible portion as a polyline, inclusive of both requested progress boundaries. */
export function getZentrumSchematicVehiclePathData(
  path: { points: readonly SchematicPoint[]; steps: readonly number[] },
  startProgress: number,
  endProgress = 1,
): string {
  const start = Math.min(1, Math.max(0, startProgress));
  const end = Math.min(1, Math.max(0, endProgress));
  if (end <= start || path.points.length < 2) return "";

  const pointAt = (progress: number): SchematicPoint => {
    let index = 1;
    const last = path.points.length - 1;
    while (index < last && path.steps[index] < progress) index += 1;
    const from = path.points[index - 1];
    const to = path.points[index];
    const span = path.steps[index] - path.steps[index - 1];
    const share = span > 0 ? (progress - path.steps[index - 1]) / span : 0;
    return {
      x: from.x + (to.x - from.x) * share,
      y: from.y + (to.y - from.y) * share,
    };
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

/** Where a mark stands on a vehicle path at a progress, and which way its mark is pointed there. */
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
