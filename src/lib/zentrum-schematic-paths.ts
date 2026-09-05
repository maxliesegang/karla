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
  printPoint,
  subtractPoints,
} from "./zentrum-schematic-plan";
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
  return [`M ${printPoint(pieces[0].start)}`, ...pieces.flatMap(({ commands }) => commands)].join(
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
      data: [`M ${printPoint(start)}`, ...commands].join(" "),
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
    return { approach: segment.to, leave: segment.to, data: "" };
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
      data: `A ${radius.toFixed(2)} ${radius.toFixed(2)} 0 0 ${sweep} ${printPoint(leave)}`,
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
    data: `C ${printPoint(segment.to)} ${printPoint(next.from)} ${printPoint(leave)}`,
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
    const commands = [...(incomingBend?.data ? [incomingBend.data] : []), `L ${printPoint(end)}`];
    return { edgeId: segment.edgeId, start, commands };
  });
};
