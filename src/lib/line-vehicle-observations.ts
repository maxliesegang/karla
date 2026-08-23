import type { Departure } from "../data/transit-types";
import { findFinalCallInstant } from "./trip-calls";
import { getVehicleTripKey } from "./trips";

/** A finished trip is kept briefly so a clock correction at its final call does not churn state. */
const LINE_VEHICLE_EXPIRY_GRACE_MS = 2 * 60_000;
/** The observation is bounded even if a provider returns an unexpectedly large board. */
export const LINE_VEHICLE_OBSERVATION_CAPACITY = 256;

export type LineVehicleObservation = {
  departure: Departure;
  observedAt: number;
  expiresAt: number;
};

/** The final expected call, plus the grace a marker is held for. */
export function findLineVehicleExpiry(departure: Departure): number | undefined {
  const finalInstant = findFinalCallInstant(departure.tripCalls);
  return finalInstant === undefined ? undefined : finalInstant + LINE_VEHICLE_EXPIRY_GRACE_MS;
}

/**
 * Adds the latest board observations to the bounded set of vehicles being followed.
 *
 * A departure board stops listing a trip once it has passed that stop. Its complete call sequence
 * still describes the rest of the run, so the observation remains useful until the final expected
 * call. A fresh observation replaces the older one; departures from several boards have already
 * been reduced to the copy with the longest call sequence before they reach this function.
 */
export function updateLineVehicleObservations(
  previous: readonly LineVehicleObservation[],
  observedDepartures: readonly Departure[],
  /**
   * When the batch was read. A number says every departure came off one board; a lookup is what a
   * caller reading several boards on different cadences passes, so a trip is stamped with the age
   * of the board it actually came from rather than with the freshest board in the set.
   */
  observedAt: number | ((departure: Departure) => number),
  feedNow: number,
  capacity = LINE_VEHICLE_OBSERVATION_CAPACITY,
): LineVehicleObservation[] {
  const resolveObservedAt = typeof observedAt === "function" ? observedAt : () => observedAt;
  const observationByVehicleKey = new Map(
    previous
      .filter((observation) => observation.expiresAt > feedNow)
      .map((observation) => [getVehicleTripKey(observation.departure), observation]),
  );

  for (const departure of observedDepartures) {
    const key = getVehicleTripKey(departure);
    if (departure.status === "cancelled") {
      observationByVehicleKey.delete(key);
      continue;
    }

    const expiresAt = findLineVehicleExpiry(departure);
    if (expiresAt === undefined || expiresAt <= feedNow) continue;
    observationByVehicleKey.set(key, {
      departure,
      observedAt: resolveObservedAt(departure),
      expiresAt,
    });
  }

  return [...observationByVehicleKey.values()]
    .sort((left, right) => right.observedAt - left.observedAt || left.expiresAt - right.expiresAt)
    .slice(0, capacity);
}

/**
 * The current board entries plus still-running trips the boards have stopped listing.
 * Current entries win over retained ones because they carry the latest deviations.
 */
export function getCurrentLineVehicleDepartures(
  observations: readonly LineVehicleObservation[],
  observedDepartures: readonly Departure[],
  feedNow: number,
): Departure[] {
  const currentKeys = new Set(observedDepartures.map(getVehicleTripKey));
  return [
    // A current entry may still have enough timed calls to place a mark even when its final call is
    // incomplete. Show it now; only retention requires a trustworthy expiry.
    ...observedDepartures.filter((departure) => departure.status !== "cancelled"),
    ...observations.flatMap((observation) =>
      observation.expiresAt > feedNow && !currentKeys.has(getVehicleTripKey(observation.departure))
        ? [observation.departure]
        : [],
    ),
  ];
}
