/**
 * Readings lit over the plan's route traces: corridors lit whole, and stretches lit from a moving
 * mark onwards. Progress (where trams are still going), a stop's departures (the way the next trams
 * take to it), and travel times (how soon each stop is reached without changing).
 */
import type { Departure, TripCall } from "../data/transit-types";
import { getCountdownMinutes } from "./feed-clock";
import { compareLineIds } from "./line-families";
import { collapseTurnaroundCalls, getTripCallInstant } from "./trip-calls";
import { isSameRun } from "./trips";
import type { ZentrumSchematicVehicle } from "./zentrum-schematic";
import { findZentrumSchematicNodeId, getEdgeKey, isRailDeparture } from "./zentrum-schematic-plan";

/** A stretch of a mark's path, lit from the mark to `end`. */
export type ZentrumSchematicLitStretch = {
  vehicle: ZentrumSchematicVehicle;
  /** Where along the path it ends; 1 is the end of the link. */
  end: number;
};

export type ZentrumSchematicOverlay = {
  /** The corridors lit whole, by the line whose lane they are lit in. */
  edgeIdsByLineId: ReadonlyMap<string, ReadonlySet<string>>;
  stretches: readonly ZentrumSchematicLitStretch[];
};

const lightEdges = (
  edgeIdsByLineId: Map<string, Set<string>>,
  lineId: string,
  edgeIds: Iterable<string>,
) => {
  const lit = edgeIdsByLineId.get(lineId) ?? new Set<string>();
  edgeIdsByLineId.set(lineId, lit);
  for (const edgeId of edgeIds) lit.add(edgeId);
};

/**
 * Corridors lit while any tram of the line has them ahead; a tram's own corridor from the tram on.
 */
export function getZentrumProgressOverlay(
  vehicles: readonly ZentrumSchematicVehicle[],
): ZentrumSchematicOverlay {
  const edgeIdsByLineId = new Map<string, Set<string>>();
  const stretches: ZentrumSchematicLitStretch[] = [];
  for (const vehicle of vehicles) {
    const onPath = new Set(vehicle.path.edgeRanges.map(({ edgeId }) => edgeId));
    lightEdges(
      edgeIdsByLineId,
      vehicle.lineId,
      vehicle.aheadEdgeIds.filter((edgeId) => !onPath.has(edgeId)),
    );
    if (onPath.size > 0 && vehicle.progress < 1) stretches.push({ vehicle, end: 1 });
  }
  return { edgeIdsByLineId, stretches };
}

/** A tram on the plan that will leave a stop, and when. */
export type ZentrumStopDeparture = {
  vehicle: ZentrumSchematicVehicle;
  /** The call the tram leaves the stop by. */
  call: TripCall;
  departsAt: number;
  /** Standing at the stop, not on its way. */
  isAtStop: boolean;
};

/**
 * The next tram per line and destination a rider at a stop can take, and the way it has to come.
 */
export function getZentrumStopDepartures(
  vehicles: readonly ZentrumSchematicVehicle[],
  nodeId: string,
): { departures: readonly ZentrumStopDeparture[]; overlay: ZentrumSchematicOverlay } {
  const candidates = getZentrumStopApproaches(vehicles, nodeId);
  const nextByWay = new Map<string, ZentrumStopApproach>();
  for (const candidate of candidates) {
    const key = `${candidate.vehicle.lineId}\u0000${candidate.vehicle.destination}`;
    const known = nextByWay.get(key);
    if (!known || candidate.departsAt < known.departsAt) nextByWay.set(key, candidate);
  }
  const next = [...nextByWay.values()].sort(
    (left, right) =>
      left.departsAt - right.departsAt || compareLineIds(left.vehicle.lineId, right.vehicle.lineId),
  );
  return {
    departures: next.map(({ vehicle, call, departsAt, isAtStop }) => ({
      vehicle,
      call,
      departsAt,
      isAtStop,
    })),
    overlay: lightApproaches(next),
  };
}

type ZentrumStopApproach = ZentrumStopDeparture & {
  /** Corridors past the end of the tram's path, lit whole. */
  edgeIds: readonly string[];
  /** Where the lit stretch on the tram's path ends, if ahead of it. */
  end?: number;
};

const lightApproaches = (approaches: Iterable<ZentrumStopApproach>): ZentrumSchematicOverlay => {
  const edgeIdsByLineId = new Map<string, Set<string>>();
  const stretches: ZentrumSchematicLitStretch[] = [];
  for (const { vehicle, edgeIds, end } of approaches) {
    lightEdges(edgeIdsByLineId, vehicle.lineId, edgeIds);
    if (end !== undefined) stretches.push({ vehicle, end });
  }
  return { edgeIdsByLineId, stretches };
};

/** Every tram on the plan that will still leave a stop. */
function getZentrumStopApproaches(
  vehicles: readonly ZentrumSchematicVehicle[],
  nodeId: string,
): ZentrumStopApproach[] {
  const candidates: ZentrumStopApproach[] = [];
  for (const vehicle of vehicles) {
    const { aheadStops } = vehicle;
    // A moving tram has left the stop its link starts at.
    const firstIndex = vehicle.progress === 0 ? 0 : 1;
    const index = aheadStops.findIndex(
      (stop, at) => at >= firstIndex && stop.nodeId === nodeId && stop.departsAt !== undefined,
    );
    if (index < 0) continue;
    const stop = aheadStops[index];
    if (index === 0) {
      candidates.push({
        vehicle,
        call: stop.call,
        departsAt: stop.departsAt ?? 0,
        isAtStop: true,
        edgeIds: [],
      });
      continue;
    }
    // On the mark's path the stretch ends at the stop; past it, corridors to the stop are lit
    // whole.
    const edgeIds: string[] = [];
    let end: number | undefined = stop.pathProgress;
    if (end === undefined) {
      let lastOnPath = 0;
      for (let at = 1; at < index; at += 1) {
        if (aheadStops[at].pathProgress !== undefined) lastOnPath = at;
      }
      for (let at = lastOnPath; at < index; at += 1) {
        edgeIds.push(getEdgeKey(aheadStops[at].nodeId, aheadStops[at + 1].nodeId));
      }
      end = 1;
    }
    candidates.push({
      vehicle,
      call: stop.call,
      departsAt: stop.departsAt ?? 0,
      isAtStop: false,
      edgeIds,
      end: vehicle.path.edgeRanges.length > 0 && end > vehicle.progress ? end : undefined,
    });
  }

  return candidates;
}

/** One row of a stop's board, read against the plan. */
export type ZentrumStopBoardRow = {
  departure: Departure;
  /** The tram on the plan this row is, if drawn. */
  vehicleId?: string;
};

/**
 * A stop's whole board and what the plan shows of it: drawn trams carry the countdown and light
 * their way; trams not yet on the plan stay on the board only.
 */
export function getZentrumStopBoard(
  boardDepartures: readonly Departure[],
  vehicles: readonly ZentrumSchematicVehicle[],
  nodeId: string,
  feedNow: number,
): {
  rows: readonly ZentrumStopBoardRow[];
  overlay: ZentrumSchematicOverlay;
  /** Each drawn tram's minutes until it leaves, as its row counts them. */
  vehicleMinutesById: ReadonlyMap<string, number>;
} {
  const approaches = getZentrumStopApproaches(vehicles, nodeId);
  const rows: ZentrumStopBoardRow[] = [];
  const shown: ZentrumStopApproach[] = [];
  const vehicleMinutesById = new Map<string, number>();
  for (const departure of boardDepartures) {
    const approach = approaches.find(({ vehicle }) => isSameRun(departure, vehicle.departure));
    rows.push(approach ? { departure, vehicleId: approach.vehicle.id } : { departure });
    if (!approach || departure.status === "cancelled") continue;
    // A multi-place stop lists a tram once per place; the first row counts.
    if (vehicleMinutesById.has(approach.vehicle.id)) continue;
    shown.push(approach);
    vehicleMinutesById.set(approach.vehicle.id, getCountdownMinutes(departure, feedNow));
  }
  return { rows, overlay: lightApproaches(shown), vehicleMinutesById };
}

/** The soonest a rider leaving one stop now reaches another, and the tram. */
export type ZentrumTravelTime = {
  arrivesAt: number;
  lineId: string;
  /** When that tram leaves the rider's stop. */
  departsAt: number;
};

/**
 * How soon a rider at a stop reaches every other stop on one tram, from every run the posts named
 * (waits for trams outside the Zentrum count). Direct rides only; the feed says nothing reliable
 * about changes.
 */
export function getZentrumTravelTimes(
  departures: readonly Departure[],
  nodeId: string,
  feedNow: number,
): {
  travelTimesByNodeId: ReadonlyMap<string, ZentrumTravelTime>;
  overlay: ZentrumSchematicOverlay;
} {
  const bestByNodeId = new Map<string, ZentrumTravelTime & { edgeIds: readonly string[] }>();
  for (const departure of departures) {
    if (departure.status === "cancelled") continue;
    if (!isRailDeparture(departure)) continue;
    const calls = collapseTurnaroundCalls(departure.tripCalls ?? []);
    const nodeIds = calls.map((call) => findZentrumSchematicNodeId(call));
    // Boarding at a complex's last call.
    let boardIndex = -1;
    for (const [index, call] of calls.entries()) {
      if (nodeIds[index] !== nodeId || nodeIds[index + 1] === nodeId) continue;
      const leaves = getTripCallInstant(call);
      if (leaves !== undefined && leaves >= feedNow) {
        boardIndex = index;
        break;
      }
    }
    if (boardIndex < 0) continue;
    const departsAt = getTripCallInstant(calls[boardIndex]) ?? feedNow;

    const edgeIds: string[] = [];
    let previous = nodeId;
    for (let index = boardIndex + 1; index < calls.length; index += 1) {
      const node = nodeIds[index];
      if (!node) break;
      if (node === previous) continue;
      edgeIds.push(getEdgeKey(previous, node));
      previous = node;
      const arrivesAt = getTripCallInstant(calls[index], "arrival");
      if (arrivesAt === undefined || node === nodeId) continue;
      const known = bestByNodeId.get(node);
      const isBetter =
        !known ||
        arrivesAt < known.arrivesAt ||
        (arrivesAt === known.arrivesAt && compareLineIds(departure.lineId, known.lineId) < 0);
      if (isBetter) {
        bestByNodeId.set(node, {
          arrivesAt,
          lineId: departure.lineId,
          departsAt,
          edgeIds: [...edgeIds],
        });
      }
    }
  }

  const edgeIdsByLineId = new Map<string, Set<string>>();
  for (const { lineId, edgeIds } of bestByNodeId.values()) {
    lightEdges(edgeIdsByLineId, lineId, edgeIds);
  }
  return {
    travelTimesByNodeId: new Map(
      [...bestByNodeId].map(([id, { arrivesAt, lineId, departsAt }]) => [
        id,
        { arrivesAt, lineId, departsAt },
      ]),
    ),
    overlay: { edgeIdsByLineId, stretches: [] },
  };
}

/** Whole minutes until departure, as a board counts them. */
export const getMinutesUntilDeparture = (departsAt: number, feedNow: number): number =>
  Math.max(0, Math.floor((departsAt - Math.floor(feedNow / 60_000) * 60_000) / 60_000));

/** Whole minutes until arrival, rounded up. */
export const getMinutesUntilArrival = (arrivesAt: number, feedNow: number): number =>
  Math.max(0, Math.ceil((arrivesAt - feedNow) / 60_000));
