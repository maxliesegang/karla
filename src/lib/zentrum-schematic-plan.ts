/**
 * The plan itself: the stops it draws, the window it is cropped to, and the geometry every reading
 * of it is measured in. Authored, not observed; what runs over it is `zentrum-schematic.ts`.
 */
import { getVerifiedLineColor } from "../data/line-signs";
import type { Departure } from "../data/transit-types";
import { isZentrumStop } from "../data/zentrum-stops";
import { getLineTrunkId } from "./line-families";
/**
 * The window the view draws, cropped to the outermost dots and their labels. Any margin beyond
 * that shrinks the whole plan, since its fit is decided by the height. The origin is a crop, not a
 * shift, so the nodes stay on the grid.
 */
export const ZENTRUM_SCHEMATIC_VIEWBOX = { x: 8, y: 44, width: 1156, height: 638 } as const;

export const ZENTRUM_SCHEMATIC_GRID = 22;

/**
 * One stop on the plan, and the stop page its dot opens.
 *
 * A complex is one dot: its parts are metres apart, which no plan can draw without distorting the
 * corridors around it. The stop page still says which platform.
 *
 * Positions are octilinear (every observed corridor runs level, upright or at 45 degrees) and
 * solved against the feed's platform coordinates by `npm run solve:zentrum`. North is up.
 * Coordinates decide only where an observed trip is drawn, never that a service exists.
 */
export type ZentrumSchematicNode = {
  /** The stop this place is, which is also the page the dot opens. */
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

/** Only rail is drawn: the plan is a rail plan, and a bus has no corridor on it to ride. */
export const isRailDeparture = ({ transportMode }: Pick<Departure, "transportMode">): boolean =>
  transportMode === "tram" || transportMode === "lightRail";

/**
 * The dot a call is at, if the plan draws one. A dot is a stop, so this is the stop the registry
 * already resolved the call to; nothing here is authored that could silently go stale.
 */
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
 * The lane a line is drawn in.
 *
 * A branch signed in its trunk's colour (S1 and S11) shares the trunk's lane and parts where its
 * pattern parts, as the operator draws it. Both the trunk and the colour must agree: the trunk
 * alone would hide S41 under S4, the colour alone would merge unrelated services signed alike.
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

/** Line ids in timetable order (`S2` before `S11`), with one collator for the hot lane search. */
export const compareLineIdsNaturally = new Intl.Collator("de", { numeric: true }).compare;

export const getEdgeKey = (leftId: string, rightId: string): string =>
  leftId < rightId ? `${leftId}\u0000${rightId}` : `${rightId}\u0000${leftId}`;

export type SchematicPoint = { x: number; y: number };

/**
 * The direction a corridor is measured in: level ones west to east, steeper ones north to south.
 * Edge ids are alphabetical and so point either way; lanes are offset along this direction's
 * normal, so it must agree across a stop for a line to keep its lane.
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
 * The width a lane is drawn at before the plan has been measured. A lane's width is also the pitch
 * between lanes, so that lines sharing a corridor read as one striped band rather than as services
 * apart on the ground.
 */
const ZENTRUM_SCHEMATIC_TRACK_WIDTH = 7;

/**
 * The width a lane aims for on screen, in CSS pixels. A line keeps one weight however big the plan
 * is drawn: a small plan does not thin it to a hairline, and zooming in pulls the lanes apart rather
 * than fattening them.
 */
const ZENTRUM_SCHEMATIC_TRACK_PIXELS = 6;

/**
 * The widest a band may grow, in plan units, before every lane in the plan is thinned. Set by the
 * closest the plan brings a stop to a busy corridor it does not call at: Albtalbahnhof stands 62
 * units off the Hauptbahnhof's ten lanes, and a band this wide still leaves its capsule clear. One
 * width for the whole plan keeps each line one stroke.
 */
const ZENTRUM_SCHEMATIC_TRACK_BAND_WIDTH = 80;

/** The step the width moves in, so a resize redraws the lanes only once it shows. */
const ZENTRUM_SCHEMATIC_TRACK_WIDTH_STEP = 0.25;

/**
 * The width every lane in this reading is drawn at, for a plan drawn `planWidth` CSS pixels wide:
 * the on-screen aim, held to what the busiest corridor leaves room for.
 */
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
 * One place to stand at a stop, said in the only terms the plan can draw: the corridors its trips
 * use. Platforms whose trips leave by the same corridors are one place; the feed gives one
 * coordinate per stop point, so a platform can only be located by what runs through it.
 */
export type ZentrumSchematicBoardingPlace = {
  /** The corridors trips boarding here run, by the stop at their far end, and how many run each. */
  armTripCounts: ReadonlyMap<string, number>;
  /** The calls observed boarding here, which ranks a place against the others at its stop. */
  tripCount: number;
};
