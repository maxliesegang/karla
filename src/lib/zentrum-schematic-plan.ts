/**
 * The plan itself: the stops it draws, the window it is cropped to, and the geometry every reading
 * of it is measured in. Authored, not observed; what runs over it is `zentrum-schematic.ts`.
 */
import { getVerifiedLineColor } from "../data/line-signs";
import type { Departure } from "../data/transit-types";
import { isZentrumStop } from "../data/zentrum-stops";
import { getLineTrunkId } from "./line-families";
/**
 * The window drawn, cropped to the outermost dots and labels: any margin shrinks the plan, whose
 * fit is height-bound. A crop, not a shift, so nodes stay on the grid.
 */
export const ZENTRUM_SCHEMATIC_VIEWBOX = { x: 8, y: 44, width: 1156, height: 638 } as const;

export const ZENTRUM_SCHEMATIC_GRID = 22;

/**
 * One stop on the plan, and the page its dot opens. A complex is one dot. Positions are octilinear
 * and solved against platform coordinates (`npm run solve:zentrum`), north up; they decide only
 * where an observed trip is drawn.
 */
export type ZentrumSchematicNode = {
  /** The stop, and the page the dot opens. */
  id: string;
  label: string;
  x: number;
  y: number;
  /** The side the name stands on, clear of the corridors; solved with the position. */
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

/** Only rail is drawn. */
export const isRailDeparture = ({ transportMode }: Pick<Departure, "transportMode">): boolean =>
  transportMode === "tram" || transportMode === "lightRail";

/** The dot a call is at: the stop the registry resolved it to. */
export const findZentrumSchematicNodeId = (call: { localStopId?: string }): string | undefined =>
  isZentrumStop(call.localStopId) ? call.localStopId : undefined;

export type ZentrumSchematicObservedEdge = {
  id: string;
  from: ZentrumSchematicNode;
  to: ZentrumSchematicNode;
  lineIds: readonly string[];
};

/** An observed corridor with its lanes ordered, before its band has been placed. */
export type ZentrumSchematicLanedEdge = ZentrumSchematicObservedEdge & {
  trackLineIds: readonly string[];
};

export type ZentrumSchematicEdge = ZentrumSchematicLanedEdge & {
  /**
   * How far the middle of the band of lanes sits off the corridor's middle, along its normal, in
   * lanes. Zero unless a straight moves it (`getTrackBandOffsetByEdgeId`).
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
 * The lane a line is drawn in. A branch in its trunk's colour (S1 and S11) shares the trunk's lane;
 * both trunk and colour must agree, or S41 would hide under S4.
 */
const getLineTrackKey = (lineId: string): string => {
  const trunkId = getLineTrunkId(lineId);
  const color = getVerifiedLineColor(lineId);
  return trunkId && color ? `${trunkId}\u0000${color}` : `\u0000${lineId}`;
};

/** Which lane each drawn line holds, named by the shortest line id in it. */
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

/** Line ids in timetable order (`S2` before `S11`); one collator for the hot lane search. */
export const compareLineIdsNaturally = new Intl.Collator("de", { numeric: true }).compare;

export const getEdgeKey = (leftId: string, rightId: string): string =>
  leftId < rightId ? `${leftId}\u0000${rightId}` : `${rightId}\u0000${leftId}`;

export type SchematicPoint = { x: number; y: number };

/** A straight stroke on the plan: a capsule's spine, or the link between two capsules. */
export type ZentrumSchematicStroke = { from: SchematicPoint; to: SchematicPoint };

/**
 * The direction a corridor is measured in: level ones west to east, others north to south. Lanes
 * offset along its normal, so it must agree across a stop for a line to keep its lane.
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
 * The lane width before the plan is measured. Width equals pitch, so shared lanes read as one band.
 */
const ZENTRUM_SCHEMATIC_TRACK_WIDTH = 7;

/** The on-screen lane width aimed for, in CSS pixels, so lines keep one weight at any plan size. */
const ZENTRUM_SCHEMATIC_TRACK_PIXELS = 6;

/**
 * The widest band, in plan units, before every lane is thinned: Albtalbahnhof stands 62 units off
 * the Hauptbahnhof's ten lanes, and this still clears its capsule.
 */
const ZENTRUM_SCHEMATIC_TRACK_BAND_WIDTH = 80;

/** The step the width moves in, so a resize redraws only once it shows. */
const ZENTRUM_SCHEMATIC_TRACK_WIDTH_STEP = 0.25;

/** The lane width for a plan `planWidth` CSS pixels wide, capped by the busiest corridor. */
export const getZentrumSchematicTrackWidth = (
  edges: readonly ZentrumSchematicLanedEdge[],
  planWidth: number | undefined,
): number => {
  const wanted =
    planWidth === undefined || planWidth <= 0
      ? ZENTRUM_SCHEMATIC_TRACK_WIDTH
      : Math.max(
          ZENTRUM_SCHEMATIC_TRACK_WIDTH_STEP,
          Math.round(
            (ZENTRUM_SCHEMATIC_TRACK_PIXELS * ZENTRUM_SCHEMATIC_VIEWBOX.width) /
              planWidth /
              ZENTRUM_SCHEMATIC_TRACK_WIDTH_STEP,
          ) * ZENTRUM_SCHEMATIC_TRACK_WIDTH_STEP,
        );
  return Math.min(
    wanted,
    ZENTRUM_SCHEMATIC_TRACK_BAND_WIDTH /
      Math.max(...edges.map((edge) => edge.trackLineIds.length), 1),
  );
};

/** A lane's signed distance from the middle of its corridor, positive along the corridor normal. */
export const getTrackOffset = (
  edge: ZentrumSchematicEdge,
  lineIndex: number,
  trackWidth: number,
): number => (edge.trackBandOffset + lineIndex - (edge.trackLineIds.length - 1) / 2) * trackWidth;

/** Where a lane runs at a stop; without a width, every line runs down the corridor's centre. */
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
 * One place to stand at a stop, by the corridors its trips use: the feed gives one coordinate per
 * stop point, so a platform is located by what runs through it.
 */
export type ZentrumSchematicBoardingPlace = {
  /** Trips per corridor boarding here, by the far end's stop. */
  armTripCounts: ReadonlyMap<string, number>;
  /** Calls observed boarding here, ranking places at the stop. */
  tripCount: number;
};
