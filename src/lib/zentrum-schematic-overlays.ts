/**
 * Readings lit over the plan's route traces: corridors lit whole, and stretches lit from a moving
 * mark onwards. Progress (where trams are still going), a stop's departures (the way the next trams
 * take to it), and travel times (how soon each stop is reached without changing).
 */
import type { Departure, TripCall } from "../data/transit-types";
import { getCountdownMinutes } from "./feed-clock";
import {
  type DirectTravelTime,
  getDirectTravelTimes,
  type TravelMeasure,
} from "./direct-travel-times";
import { compareLineIds } from "./line-families";
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
  corridorIdsByLineId: ReadonlyMap<string, ReadonlySet<string>>;
  stretches: readonly ZentrumSchematicLitStretch[];
};

const lightCorridors = (
  corridorIdsByLineId: Map<string, Set<string>>,
  lineId: string,
  corridorIds: Iterable<string>,
) => {
  const lit = corridorIdsByLineId.get(lineId) ?? new Set<string>();
  corridorIdsByLineId.set(lineId, lit);
  for (const corridorId of corridorIds) lit.add(corridorId);
};

/**
 * Corridors lit while any tram of the line has them ahead; a tram's own corridor from the tram on.
 */
export function getZentrumVehiclePathsOverlay(
  vehicles: readonly ZentrumSchematicVehicle[],
): ZentrumSchematicOverlay {
  const corridorIdsByLineId = new Map<string, Set<string>>();
  const stretches: ZentrumSchematicLitStretch[] = [];
  for (const vehicle of vehicles) {
    const onPath = new Set(vehicle.path.corridorRanges.map(({ corridorId }) => corridorId));
    lightCorridors(
      corridorIdsByLineId,
      vehicle.lineId,
      vehicle.aheadCorridorIds.filter((corridorId) => !onPath.has(corridorId)),
    );
    if (onPath.size > 0 && vehicle.progress < 1) stretches.push({ vehicle, end: 1 });
  }
  return { corridorIdsByLineId, stretches };
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
  corridorIds: readonly string[];
  /** Where the lit stretch on the tram's path ends, if ahead of it. */
  end?: number;
};

const lightApproaches = (approaches: Iterable<ZentrumStopApproach>): ZentrumSchematicOverlay => {
  const corridorIdsByLineId = new Map<string, Set<string>>();
  const stretches: ZentrumSchematicLitStretch[] = [];
  for (const { vehicle, corridorIds, end } of approaches) {
    lightCorridors(corridorIdsByLineId, vehicle.lineId, corridorIds);
    if (end !== undefined) stretches.push({ vehicle, end });
  }
  return { corridorIdsByLineId, stretches };
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
        corridorIds: [],
      });
      continue;
    }
    // On the mark's path the stretch ends at the stop; past it, corridors to the stop are lit
    // whole.
    const corridorIds: string[] = [];
    let end: number | undefined = stop.pathProgress;
    if (end === undefined) {
      let lastOnPath = 0;
      for (let at = 1; at < index; at += 1) {
        if (aheadStops[at].pathProgress !== undefined) lastOnPath = at;
      }
      for (let at = lastOnPath; at < index; at += 1) {
        corridorIds.push(getEdgeKey(aheadStops[at].nodeId, aheadStops[at + 1].nodeId));
      }
      end = 1;
    }
    candidates.push({
      vehicle,
      call: stop.call,
      departsAt: stop.departsAt ?? 0,
      isAtStop: false,
      corridorIds,
      end: vehicle.path.corridorRanges.length > 0 && end > vehicle.progress ? end : undefined,
    });
  }

  return candidates;
}

/** The trams on the plan that will still leave a stop; the rest of its lines' trams have left it. */
export const getZentrumApproachingVehicleIds = (
  vehicles: readonly ZentrumSchematicVehicle[],
  nodeId: string,
): ReadonlySet<string> =>
  new Set(getZentrumStopApproaches(vehicles, nodeId).map(({ vehicle }) => vehicle.id));

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
export type ZentrumTravelTime = Omit<DirectTravelTime, "stopIds">;

export type ZentrumTravelMeasure = TravelMeasure;

/** Whole minutes on board, at least one. */
export const getRideMinutes = ({ departsAt, arrivesAt }: ZentrumTravelTime): number =>
  Math.max(1, Math.round((arrivesAt - departsAt) / 60_000));

/**
 * How soon, or how briefly, a rider at a stop reaches every other stop on one tram, from every run
 * the posts named (waits for trams outside the Zentrum count). A run's reach ends where it leaves
 * the plan.
 */
export function getZentrumTravelTimes(
  departures: readonly Departure[],
  nodeId: string,
  feedNow: number,
  measure: ZentrumTravelMeasure = "arrival",
): {
  travelTimesByNodeId: ReadonlyMap<string, ZentrumTravelTime>;
  overlay: ZentrumSchematicOverlay;
} {
  const times = getDirectTravelTimes(
    departures.filter(isRailDeparture),
    nodeId,
    feedNow,
    measure,
    findZentrumSchematicNodeId,
  );
  const corridorIdsByLineId = new Map<string, Set<string>>();
  for (const { lineId, stopIds } of times.values()) {
    lightCorridors(
      corridorIdsByLineId,
      lineId,
      stopIds.slice(1).map((stopId, index) => getEdgeKey(stopIds[index], stopId)),
    );
  }
  return {
    travelTimesByNodeId: new Map(
      [...times].map(([id, { arrivesAt, lineId, departsAt }]) => [
        id,
        { arrivesAt, lineId, departsAt },
      ]),
    ),
    overlay: { corridorIdsByLineId, stretches: [] },
  };
}

/** Whole minutes until departure, as a board counts them. */
export const getMinutesUntilDeparture = (departsAt: number, feedNow: number): number =>
  Math.max(0, Math.floor((departsAt - Math.floor(feedNow / 60_000) * 60_000) / 60_000));

export { getMinutesUntilArrival } from "./direct-travel-times";
