/**
 * The plan itself: the stops it draws, the window it is cropped to, and the geometry every reading
 * of it is measured in.
 *
 * Authored, not observed — this is the drawing surface, and what runs over it is the reading built
 * on top (`zentrum-schematic.ts`). Everything the lanes, the drawn paths and the stop marks are
 * laid out from lives here, so each of those is a reading of one plan rather than a plan of its
 * own.
 */
import { getVerifiedLineColor } from "../data/line-signs";
import { isZentrumStop } from "../data/zentrum-stops";
import { getLineTrunkId } from "./line-families";
/**
 * The window on the grid that the view draws, and scales its layer by.
 *
 * Cropped to what the drawing actually occupies -- the outermost dots and the labels hanging off
 * them -- rather than to a round number with the plan floating inside it. The margin is what a
 * label needs and no more, because every unit of it is scale the plan does not get: the panel is
 * wider than the plan is, so the fit is decided by the height, and empty height is the one thing
 * that makes the whole Zentrum smaller than it had to be. The origin is a crop, not a shift, so
 * every node below stays on the grid.
 */
export const ZENTRUM_SCHEMATIC_VIEWBOX = { x: 8, y: 44, width: 1156, height: 638 } as const;

export const ZENTRUM_SCHEMATIC_GRID = 22;

/**
 * The stable drawing surface for the Zentrum.
 *
 * One dot is one stop, and the stop page it opens. The plan drew the parts of a complex apart for
 * a while -- both Marktplatz tunnels, Europaplatz's tunnel and its two surface platforms -- because
 * that is a choice a rider makes on the ground. Geography would not pay for it: the feed puts
 * Europaplatz's tunnel eleven metres from its western platforms and Ettlinger Tor's two levels
 * fifty-five, and no plan can draw two names eleven metres apart. Each pair had to be pushed a step
 * and a half apart in a direction the layout chose rather than the city, and those pushes were most
 * of the distortion in the drawing: twelve of thirty-seven corridors ran in the wrong one of the
 * eight directions, and no arrangement without faults existed at all. Merged, one corridor of
 * twenty-eight is wrong and the mean error is 7.4 degrees. Which tunnel a vehicle is in is the
 * price, and the stop page still answers it.
 *
 * The positions are octilinear in the sense the transit-map literature gives the word: every
 * corridor a trip has been observed running runs level, upright or at 45 degrees. They are solved
 * rather than drawn -- `npm run solve:zentrum` states what this table is answerable to, measures
 * the one standing here against the coordinates the feed publishes for the platforms it draws, and
 * prints the closest octilinear drawing to the real city it can find. North is up.
 *
 * Coordinates decide only where an observed trip is drawn. They never state that a service exists.
 */
export type ZentrumSchematicNode = {
  /** The stop this place is, which is also the page the dot opens. */
  id: string;
  /** What this place is called. Read out beside the dot, and printed when a vehicle is on it. */
  label: string;
  x: number;
  y: number;
  /**
   * Which side of the dot the name stands on, away from the corridors leaving it.
   *
   * Solved with the position rather than chosen afterwards, because a side is only free relative to
   * the corridors that end up at the dot; `npm run solve:zentrum` prints it with the coordinates.
   */
  labelSide?: "left" | "right" | "above" | "below";
};

export const ZENTRUM_SCHEMATIC_NODES: readonly ZentrumSchematicNode[] = [
  { id: "karl-wilhelm-platz", label: "Karl-Wilhelm-Platz", x: 946, y: 66, labelSide: "right" },
  { id: "muehlburger-tor", label: "Mühlburger Tor", x: 110, y: 154, labelSide: "left" },
  { id: "europaplatz", label: "Europaplatz", x: 374, y: 154, labelSide: "above" },
  { id: "marktplatz", label: "Marktplatz", x: 572, y: 154, labelSide: "above" },
  { id: "kronenplatz", label: "Kronenplatz", x: 726, y: 154, labelSide: "below" },
  { id: "durlacher-tor", label: "Durlacher Tor", x: 858, y: 154, labelSide: "below" },
  { id: "gottesauer-platz", label: "Gottesauer Platz", x: 1034, y: 154, labelSide: "right" },
  { id: "karlstor", label: "Karlstor", x: 374, y: 286, labelSide: "left" },
  { id: "ettlinger-tor", label: "Ettlinger Tor", x: 572, y: 286, labelSide: "right" },
  { id: "rueppurrer-tor", label: "Rüppurrer Tor", x: 726, y: 286, labelSide: "above" },
  { id: "ostendstrasse", label: "Ostendstraße", x: 858, y: 286, labelSide: "right" },
  { id: "lessingstrasse", label: "Lessingstraße", x: 154, y: 308, labelSide: "right" },
  { id: "otto-sachs-strasse", label: "Otto-Sachs-Straße", x: 264, y: 330, labelSide: "right" },
  { id: "arbeitsagentur", label: "Arbeitsagentur", x: 198, y: 352, labelSide: "above" },
  { id: "mathystrasse", label: "Mathystraße", x: 374, y: 374, labelSide: "right" },
  { id: "kongresszentrum", label: "Kongresszentrum", x: 572, y: 374, labelSide: "right" },
  { id: "werderstrasse", label: "Werderstraße", x: 726, y: 462, labelSide: "right" },
  { id: "zkm", label: "ZKM", x: 198, y: 484, labelSide: "right" },
  { id: "kolpingplatz", label: "Kolpingplatz", x: 374, y: 506, labelSide: "right" },
  { id: "augartenstrasse", label: "Augartenstraße", x: 572, y: 506, labelSide: "right" },
  { id: "welfenstrasse", label: "Welfenstraße", x: 198, y: 616, labelSide: "below" },
  { id: "barbarossaplatz", label: "Barbarossaplatz", x: 286, y: 616, labelSide: "below" },
  { id: "ebertstrasse", label: "Ebertstraße", x: 374, y: 616, labelSide: "below" },
  { id: "hauptbahnhof", label: "Hauptbahnhof", x: 462, y: 616, labelSide: "above" },
  { id: "poststrasse", label: "Poststraße", x: 572, y: 616, labelSide: "below" },
  { id: "tivoli", label: "Tivoli", x: 726, y: 616, labelSide: "right" },
  { id: "albtalbahnhof", label: "Albtalbahnhof", x: 418, y: 660, labelSide: "below" },
] as const;

export const zentrumSchematicNodeById = new Map(
  ZENTRUM_SCHEMATIC_NODES.map((node) => [node.id, node]),
);

/**
 * The place on the plan a call is at, if the plan draws one.
 *
 * A node is a stop, so this is the stop the registry already resolved the provider's identity to,
 * and nothing here has to be authored or kept true. It was authored once: a table of provider stop
 * points and platform codes stood between a call and the plan, so that a call at Europaplatz's
 * tunnel and one at its street platforms reached different dots. That table could be wrong without
 * saying so -- a stopping position the operator added was a call matching no rule, placed nowhere,
 * and a corridor quietly not drawn. Drawing a complex as one place retires the whole failure: every
 * call at a Zentrum stop reaches the dot for that stop, and a call at a stop the plan does not draw
 * reaches nothing, which is the same answer it should always have given.
 */
export const findZentrumSchematicNodeId = (call: { localStopId?: string }): string | undefined =>
  isZentrumStop(call.localStopId) ? call.localStopId : undefined;

export type ZentrumSchematicObservedEdge = {
  id: string;
  from: ZentrumSchematicNode;
  to: ZentrumSchematicNode;
  lineIds: readonly string[];
};

/**
 * An observed corridor with its lanes named, before the reading has settled where its band stands.
 */
export type ZentrumSchematicLanedEdge = ZentrumSchematicObservedEdge & {
  trackLineIds: readonly string[];
};

export type ZentrumSchematicEdge = ZentrumSchematicLanedEdge & {
  /**
   * How far the middle of this corridor's band of lanes sits off the corridor's own middle,
   * signed along the corridor normal, in drawing units.
   *
   * Centred -- zero -- wherever the corridor belongs to no straight that asks it to stand
   * elsewhere; see `getTrackBandOffsetByEdgeId` for the straight that moves it.
   */
  trackBandOffset: number;
};

export type ZentrumSchematicLinePath = {
  id: string;
  lineId: string;
  /** The lane this pattern is drawn in: the line's own, or its trunk's where the two are one. */
  trackId: string;
  nodes: readonly ZentrumSchematicNode[];
};

/**
 * The lane a line is drawn in, which is not always a lane of its own.
 *
 * S1 and S11 are one service to anybody in the Zentrum: they run the same corridors here, and KVV
 * prints them in one colour because what they differ over is an hour out of town. Drawn a lane
 * apart they read as two parallel services, and spend on that fiction a lane the corridor could
 * have given to a line that really is somewhere else. So a branch shares its trunk's lane, and the
 * two part where their observed patterns part -- which is the drawing the operator itself prints.
 *
 * Both halves of the test have to hold. The trunk alone would draw S4 and S41 as one lane, and the
 * operator signs those in different colours precisely because they go different ways; one would be
 * left hidden under the other. The colour alone would gather every service the feed happens to sign
 * alike -- the FEX beside S1, and the whole violet bus book. Neither half names a line anywhere.
 */
const getLineTrackKey = (lineId: string): string => {
  const trunkId = getLineTrunkId(lineId);
  const color = getVerifiedLineColor(lineId);
  return trunkId && color ? `${trunkId}\u0000${color}` : `\u0000${lineId}`;
};

/**
 * Which lane each of the drawn lines holds, named by the shortest line id in the lane -- the trunk,
 * where a trunk is drawn; a line sharing with nobody is its own lane and keeps its own name.
 */
export const getTrackIdByLineId = (lineIds: readonly string[]): ReadonlyMap<string, string> => {
  const lineIdsByTrackKey = new Map<string, string[]>();
  for (const lineId of lineIds) {
    const key = getLineTrackKey(lineId);
    lineIdsByTrackKey.set(key, [...(lineIdsByTrackKey.get(key) ?? []), lineId]);
  }
  return new Map(
    [...lineIdsByTrackKey.values()].flatMap((trackLineIds) => {
      const trackId = [...trackLineIds].sort(
        (left, right) => left.length - right.length || left.localeCompare(right, "de"),
      )[0];
      return trackLineIds.map((lineId) => [lineId, trackId] as const);
    }),
  );
};

export const getEdgeKey = (leftId: string, rightId: string): string =>
  leftId < rightId ? `${leftId}\u0000${rightId}` : `${rightId}\u0000${leftId}`;

export type SchematicPoint = { x: number; y: number };

/**
 * The direction a corridor is measured in, whichever way its edge id happens to read.
 *
 * Edge ids are alphabetical, so the same straight can be stated west-to-east on one segment and
 * east-to-west on the next. Orienting every level corridor west-to-east and every steeper one
 * north-to-south is what keeps a line in the same lane when it crosses a stop: the lane normal is
 * taken from this run, so both segments agree on which side "before" is.
 */
export const orientCorridorRun = (edge: ZentrumSchematicObservedEdge): SchematicPoint => {
  let x = edge.to.x - edge.from.x;
  let y = edge.to.y - edge.from.y;
  if ((Math.abs(x) >= Math.abs(y) && x < 0) || (Math.abs(y) > Math.abs(x) && y < 0)) {
    x *= -1;
    y *= -1;
  }
  const length = Math.hypot(x, y) || 1;
  return { x: x / length, y: y / length };
};

/**
 * The width one lane is drawn at, which is also the distance between two neighbouring lanes.
 *
 * They are one number on purpose. Lines sharing a corridor are what the corridor is: the thing to
 * read there is a single band as wide as the traffic it carries, striped in the colours running
 * through it. Pitched any wider than they are drawn, the lanes stand a stripe of the background
 * apart -- which says the services are apart on the ground, where they are on one pair of rails,
 * and spends width on saying it. So a lane is laid exactly one lane's width from its neighbour and
 * the colours meet, with the casings beneath them fusing into one outline around the whole band.
 */
const ZENTRUM_SCHEMATIC_TRACK_WIDTH = 7;

/**
 * The widest a corridor's band of lanes may grow before the lanes themselves are thinned.
 *
 * Eight lanes is the most the Zentrum has been read carrying -- the S-Bahnen and the trams between
 * the Hauptbahnhof and the Poststraße -- and the band holds that many at the full lane width. A
 * corridor busier than that thins every lane in the drawing rather than spilling over its
 * neighbouring corridors, because one width for the whole plan is what a line being one stroke
 * from end to end requires, and it is what makes lanes that touch on one corridor touch on all of
 * them.
 */
const ZENTRUM_SCHEMATIC_TRACK_BAND_WIDTH = 56;

/**
 * The width every lane in this reading is drawn at, and the pitch its lanes are laid on.
 *
 * Read from the busiest corridor rather than fixed, so the plan answers for the whole of what is
 * running: it is the full lane width for any Zentrum a rider has seen, and narrows only for a
 * drawing this one has not been -- which is a different drawing, not a flicker between refreshes.
 */
export const getZentrumSchematicTrackWidth = (
  edges: readonly ZentrumSchematicLanedEdge[],
): number =>
  Math.min(
    ZENTRUM_SCHEMATIC_TRACK_WIDTH,
    ZENTRUM_SCHEMATIC_TRACK_BAND_WIDTH /
      Math.max(...edges.map((edge) => edge.trackLineIds.length), 1),
  );

/** A lane's signed distance from the middle of its corridor, positive along the corridor normal. */
export const getTrackOffset = (
  edge: ZentrumSchematicEdge,
  lineIndex: number,
  trackWidth: number,
): number => edge.trackBandOffset + (lineIndex - (edge.trackLineIds.length - 1) / 2) * trackWidth;

/**
 * Where a lane runs at a stop -- the middle of the dot, unless the corridor is drawn lane by lane.
 *
 * No width is the plan's other reading, where every line is drawn down the centre of the corridor
 * because only one of them is drawn at a time.
 */
export const getLineTrackPoint = (
  edge: ZentrumSchematicEdge,
  node: ZentrumSchematicNode,
  trackId: string,
  corridorTrackIds: readonly string[],
  trackWidth: number | undefined,
): SchematicPoint => {
  if (trackWidth === undefined) return node;
  const run = orientCorridorRun(edge);
  const offset = getTrackOffset(edge, Math.max(corridorTrackIds.indexOf(trackId), 0), trackWidth);
  return { x: node.x + -run.y * offset, y: node.y + run.x * offset };
};

export const formatPoint = ({ x, y }: SchematicPoint): string => `${x.toFixed(2)} ${y.toFixed(2)}`;

export const subtractPoints = (left: SchematicPoint, right: SchematicPoint): SchematicPoint => ({
  x: left.x - right.x,
  y: left.y - right.y,
});

export const crossProduct = (left: SchematicPoint, right: SchematicPoint): number =>
  left.x * right.y - left.y * right.x;

export const dotProduct = (left: SchematicPoint, right: SchematicPoint): number =>
  left.x * right.x + left.y * right.y;

export const getUnitVector = (from: SchematicPoint, to: SchematicPoint): SchematicPoint => {
  const run = subtractPoints(to, from);
  const length = Math.hypot(run.x, run.y) || 1;
  return { x: run.x / length, y: run.y / length };
};

export const getLineIntersection = (
  leftPoint: SchematicPoint,
  leftDirection: SchematicPoint,
  rightPoint: SchematicPoint,
  rightDirection: SchematicPoint,
): SchematicPoint | undefined => {
  const directionCrossProduct = crossProduct(leftDirection, rightDirection);
  if (Math.abs(directionCrossProduct) < 0.001) return undefined;
  const distanceAlongLeft =
    crossProduct(subtractPoints(rightPoint, leftPoint), rightDirection) / directionCrossProduct;
  return {
    x: leftPoint.x + leftDirection.x * distanceAlongLeft,
    y: leftPoint.y + leftDirection.y * distanceAlongLeft,
  };
};

/**
 * Where a stop's platforms stand, said in the only terms the plan can draw: the corridors the
 * trips using them run.
 *
 * A junction is rarely one platform. Karlstor's trams to Ettlinger Tor board on the eastern arm
 * and its trams to Mathystraße on the southern one; Europaplatz has a tunnel under the square and
 * two surface platforms, one west and one south of it. A rider standing there knows this, and a
 * plan that draws one mark over the whole crossing does not say it.
 *
 * It is read rather than authored, from the platform each call is published at: platforms whose
 * trips leave by exactly the same corridors are one place to stand, and platforms whose trips
 * leave by different ones are different places. Nothing here is a coordinate — the feed publishes
 * one position for a whole stop point, so where a platform is can only be said by what runs
 * through it. A stop the reading learns nothing about keeps the one mark it always had.
 */
export type ZentrumSchematicBoardingPlace = {
  /** The corridors trips boarding here run, by the stop at their far end, and how many run each. */
  armTripCounts: ReadonlyMap<string, number>;
  /** The calls observed boarding here, which ranks a place against the others at its stop. */
  tripCount: number;
};
