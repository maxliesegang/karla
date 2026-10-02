/**
 * The readings the plan can light over its quiet route traces, all in one shape: corridors lit
 * whole, and stretches lit from a moving mark onwards.
 *
 * - Progress: where the trams on the plan are still going.
 * - A stop's departures: the way the next trams take to the stop a rider stands at.
 * - Travel times: how soon a rider at a stop reaches every other one, without changing.
 */
import type { Departure, TripCall } from "../data/transit-types";
import { getCountdownMinutes } from "./feed-clock";
import { compareLineIds } from "./line-families";
import { collapseTurnaroundCalls, getTripCallInstant } from "./trip-calls";
import { isSameRun } from "./trips";
import type { ZentrumSchematicVehicle } from "./zentrum-schematic";
import { findZentrumSchematicNodeId, getEdgeKey, isRailDeparture } from "./zentrum-schematic-plan";

/** A stretch of a mark's own path, lit from the mark to `end`, which goes out as the mark moves. */
export type ZentrumSchematicLitStretch = {
  vehicle: ZentrumSchematicVehicle;
  /** Where along the mark's path the stretch ends; 1 is the end of its link. */
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
 * Where the trams on the plan are still going. A corridor is lit while any tram of its line has it
 * ahead; the corridor a tram is on is lit from the tram onwards, so it goes out behind the last one.
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

/** One tram on the plan that will leave a stop, and when. */
export type ZentrumStopDeparture = {
  vehicle: ZentrumSchematicVehicle;
  /** The call the tram leaves the stop by. */
  call: TripCall;
  departsAt: number;
  /** The tram is standing at the stop rather than on its way to it. */
  isAtStop: boolean;
};

/**
 * The trams on the plan a rider at a stop can take next, and the way each still has to come.
 * Only the next tram per line and destination: a second one behind it would light the same lane.
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

/** A tram on the plan on its way to a stop, with the way it still has to come. */
type ZentrumStopApproach = ZentrumStopDeparture & {
  /** The corridors past the end of the tram's own path, lit whole. */
  edgeIds: readonly string[];
  /** Where the lit stretch on the tram's own path ends, if it has one ahead of it. */
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

/** Every tram on the plan that will still leave a stop, and the way each has to come. */
function getZentrumStopApproaches(
  vehicles: readonly ZentrumSchematicVehicle[],
  nodeId: string,
): ZentrumStopApproach[] {
  const candidates: ZentrumStopApproach[] = [];
  for (const vehicle of vehicles) {
    const { aheadStops } = vehicle;
    // A tram that has started moving has left the stop its link starts at.
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
    // On the mark's own path the stretch ends at the stop; past it, the path is lit to its end
    // and the corridors on to the stop are lit whole.
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

/** One departure of a stop's board, read against the plan. */
export type ZentrumStopBoardRow = {
  departure: Departure;
  /** The tram on the plan this departure is, if it is drawn already. */
  vehicleId?: string;
};

/**
 * A stop's whole board, and what of it the plan can show.
 *
 * The board says *when*, for every departure; the plan says *from where*, for the ones it draws:
 * their marks carry the countdown and light the way still to come. A tram not on the plan yet is
 * on the board only, since marking it anywhere would read as a tram standing there.
 */
export function getZentrumStopBoard(
  boardDepartures: readonly Departure[],
  vehicles: readonly ZentrumSchematicVehicle[],
  nodeId: string,
  feedNow: number,
): {
  rows: readonly ZentrumStopBoardRow[];
  overlay: ZentrumSchematicOverlay;
  /** The minutes each drawn tram leaves the stop in, as its board row counts them. */
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
    // A stop of several places lists one tram once per place; the first row is when it leaves.
    if (vehicleMinutesById.has(approach.vehicle.id)) continue;
    shown.push(approach);
    vehicleMinutesById.set(approach.vehicle.id, getCountdownMinutes(departure, feedNow));
  }
  return { rows, overlay: lightApproaches(shown), vehicleMinutesById };
}

/** The soonest a rider leaving one stop now is at another, and the tram that gets them there. */
export type ZentrumTravelTime = {
  arrivesAt: number;
  lineId: string;
  /** When that tram leaves the rider's stop. */
  departsAt: number;
};

/**
 * How soon a rider at a stop reaches every other stop on the plan, riding one tram.
 *
 * Read from every run the posts named, not only those on the plan: the wait for a tram still
 * outside the Zentrum is part of the answer. Direct rides only, because the feed says nothing
 * reliable about changing. Each stop lights the corridors its ride took, in that line's lane.
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
    // The rider boards at the last call of a complex, which is when the tram leaves it.
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

/** Whole minutes until a tram leaves, counted the way a departure board counts them. */
export const getMinutesUntilDeparture = (departsAt: number, feedNow: number): number =>
  Math.max(0, Math.floor((departsAt - Math.floor(feedNow / 60_000) * 60_000) / 60_000));

/** Whole minutes until a rider arrives, rounded up: a minute early is no promise. */
export const getMinutesUntilArrival = (arrivesAt: number, feedNow: number): number =>
  Math.max(0, Math.ceil((arrivesAt - feedNow) / 60_000));
