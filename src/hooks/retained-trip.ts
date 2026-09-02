import { useEffect, useMemo, useState } from "react";
import { transitSource } from "../data/transit-source";
import type { Departure, TripReading } from "../data/transit-types";
import { getVehicleTripKey, isBetterTripReading } from "../lib/trips";
import { DEPARTURE_BOARD_REFRESH_MS } from "./departure-board";
import { useDeviceNow } from "./clock";
import { useKeyedLoad, type KeyedLoadOptions } from "./keyed-load";
import {
  findActiveRideObservation,
  forgetActiveRideObservation,
  getActiveRideExpiry,
  rememberActiveRideObservation,
  type ActiveRideObservation,
} from "../lib/active-ride";

/**
 * The trip a rider is on, kept for as long as the ride lasts.
 *
 * A trip is found by reading departure boards, and a departure board only lists what has not left
 * yet — so a few minutes after boarding, every board along the line has stopped mentioning the trip
 * the rider is sitting on. Dropping the view at that point ends the mode exactly when it starts
 * being useful.
 *
 * The last observation of the trip is therefore kept, with the instant it was read, and handed back
 * when the boards no longer carry it. It is not a refresh and never claims to be: `isRetained` says
 * the view is reading an observation from `observedAt`, which is what the ride status states. The
 * calls it carries hold their own scheduled times and deviations, so the ride still runs down
 * against the clock.
 *
 * Kept is not the same as abandoned. A trip that has left every board — or that only appears on one
 * read too slowly to be timing it, which the twenty-minute network observation posts are — can still
 * be *asked for* by name — the one-trip endpoint answers from the locator the row was remembered with — so the ride
 * a rider is actually on goes on being read on the board's own cadence, one request for one
 * vehicle. Measured against the feed, a trip's stated deviation moves about every thirty-five
 * seconds; a ride held for ten minutes on a single reading is a dozen revisions out of date, and it
 * is the one vehicle on the screen the rider is inside of. Only the ride earns this: the marks on a
 * line diagram are held the same way and stay unread, because there are ten of them and nobody is
 * sitting on any of them.
 *
 * What that re-reading renews is the *sequence*: the calls ahead and how the run is doing along
 * them. The row's own published time and deviation are the board's statement about this vehicle at
 * one stop, and they are not re-read once no board carries the row — the retained departure keeps
 * stating them until the boards pick the trip up again. `lib/vehicle-positioning.ts` knows this and
 * stops trusting the row once its departure is behind us.
 *
 * Each reading is dated by the source, never here. A trip asked for is not always a trip re-read —
 * a sequence still inside the tolerance is answered from the one in hand, and a row that arrived
 * carrying its own calls is never re-read at all — so stamping the clock on arrival would restate
 * a kept reading as a fresh one and have the ride claim an age it does not have.
 */
export type RetainedTrip = {
  departure: Departure | undefined;
  /** When this observation of the trip was read; only meaningful while `isRetained`. */
  observedAt: number;
  /** The boards no longer list this trip, and what is in view is the last reading of it. */
  isRetained: boolean;
};

type TripObservation = ActiveRideObservation & { key: string };

const loadRetainedTrip = (departureId: string): Promise<TripReading | undefined> =>
  transitSource.getTrip(departureId, DEPARTURE_BOARD_REFRESH_MS);

const RETAINED_TRIP_LOAD_OPTIONS: KeyedLoadOptions<TripReading | undefined> = {
  refreshMs: DEPARTURE_BOARD_REFRESH_MS,
  // A trip the source can no longer name is not a trip that stopped running; it is a locator the
  // cap evicted. Backing off is right, and the kept observation still answers the view meanwhile.
  isFailure: (reading) => reading === undefined,
};

/**
 * The trip read on its own while no board carries it, or nothing where there is none to read.
 *
 * Asked for by departure id, which is what the source remembers a locator against — and what its
 * own eviction policy protects while a run is still out on the route.
 */
function useRetainedTripReading(departureId: string | undefined): TripReading | undefined {
  return (
    useKeyedLoad(departureId ?? null, loadRetainedTrip, RETAINED_TRIP_LOAD_OPTIONS) ?? undefined
  );
}

export function useRetainedTrip(
  tripId: string | undefined,
  departure: Departure | undefined,
  /** When the board this trip was read from arrived, which is what dates the observation. */
  receivedAt: number,
): RetainedTrip {
  // How old the reading in hand is, on the clock its timestamp was taken from. Ticking, so a board
  // that goes quiet starts the ride's own re-reading by itself rather than at the next render.
  const now = useDeviceNow();
  const [observation, setObservation] = useState<TripObservation | null>(null);
  const storedObservation = useMemo(() => {
    if (!tripId) return null;
    const stored = findActiveRideObservation(tripId);
    return stored ? { ...stored, key: getVehicleTripKey(stored.departure) } : null;
  }, [tripId]);

  let resolvedObservation = observation?.routeId === tripId ? observation : storedObservation;
  // Only while no board is currently reading it. A trip listed on a board is not the same thing as
  // a trip being re-read: the network observation posts are read every twenty minutes and carry
  // whole calling sequences, so a ride can be "on a board" and still be publishing half-hour-old
  // deviations. What suppresses the request is a reading no older than the board cadence — anything
  // slower than that is a reading the ride has to renew for itself.
  const isObservationCurrent = Boolean(departure) && now - receivedAt < DEPARTURE_BOARD_REFRESH_MS;
  // Only the ride earns a request of its own: away from it the trip in view is the one on the board
  // beside it, and reading it separately would spend a request restating what that row just said.
  const refreshed = useRetainedTripReading(
    !tripId || isObservationCurrent
      ? undefined
      : (departure?.id ?? resolvedObservation?.departure.id),
  );
  if (!tripId && observation) setObservation(null);
  if (tripId && !departure && storedObservation && observation?.routeId !== tripId) {
    setObservation(storedObservation);
    resolvedObservation = storedObservation;
  }
  // A reading of its own is an observation like any other, and the two are settled by the one rule
  // every contest between readings of a vehicle is settled by (`lib/trips.ts`): the row on a board
  // is preferred while it is the better statement about this trip, and not merely because it exists.
  const boardReading = departure ? { trip: departure, receivedAt } : undefined;
  const reading =
    boardReading && !(refreshed && isBetterTripReading(refreshed, boardReading))
      ? boardReading
      : refreshed;
  const observedTrip = reading?.trip;
  const observedAt = reading?.receivedAt ?? 0;
  if (tripId && observedTrip) {
    const key = getVehicleTripKey(observedTrip);
    const current = resolvedObservation;
    // A thinner reading of the same trip is not an improvement on the one already held.
    const isBetterObservation =
      current?.key !== key ||
      (observedTrip.tripCalls?.length ?? 0) > (current.departure.tripCalls?.length ?? 0) ||
      observedAt > current.observedAt;
    if (isBetterObservation) {
      const next = {
        routeId: tripId,
        departure: observedTrip,
        observedAt,
        expiresAt: getActiveRideExpiry(observedTrip, observedAt),
        key,
      };
      setObservation(next);
      resolvedObservation = next;
    }
  }

  useEffect(() => {
    if (!tripId) {
      forgetActiveRideObservation();
      return;
    }
    if (observation?.routeId === tripId) {
      rememberActiveRideObservation(tripId, observation.departure, observation.observedAt);
    }
  }, [observation, tripId]);

  // A trip the boards still carry is being read, not remembered, and states no observation time —
  // whichever of the two readings of it turned out to be the later one.
  if (departure && reading) {
    return { departure: reading.trip, observedAt: reading.receivedAt, isRetained: false };
  }
  const retained = resolvedObservation;
  if (!tripId || !retained) return { departure: undefined, observedAt: 0, isRetained: false };
  return { departure: retained.departure, observedAt: retained.observedAt, isRetained: true };
}
