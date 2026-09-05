import { useMemo, useState } from "react";
import { transitSource } from "../data/transit-source";
import type { Departure } from "../data/transit-types";
import { toSortedIds } from "../lib/collections";
import { mergeTripSequence } from "../lib/trip-calls";
import { DEPARTURE_BOARD_REFRESH_MS } from "./departure-board";
import { createFreshEntryLoad, useKeyedLoad, type KeyedLoadOptions } from "./keyed-load";

/**
 * How stale a trip reading the rider is not riding may be.
 *
 * A mark is placed from these readings' calls, and the feed revises its statement about where a
 * vehicle is about every thirty-five seconds, so an unchosen trip is re-read once a minute: half
 * the drift a mark can carry, at a fraction of a board's transfer. What a rider reads beside the
 * row — countdown, platform, delay — is still the board row's, so the boards keep their own slower
 * clock, and only the ride, the vehicle somebody is sitting in, reads faster than this.
 */
export const LINE_TRIP_MAX_AGE_MS = 60_000;

type TripMemory = { source: readonly Departure[] | null; tripById: ReadonlyMap<string, Departure> };
const EMPTY_TRIP_MEMORY: TripMemory = { source: null, tripById: new Map() };

/**
 * The key is JSON because departure ids may contain punctuation from provider names. It carries how
 * fresh each trip has to be as well as which trips: the vehicle a rider chose is worth re-reading
 * on every board refresh, the others behind it are not.
 */
const loadTrips = (key: string, isEntryRead: boolean) =>
  Promise.all(
    (JSON.parse(key) as [string, number][]).map(([departureId, maxAgeMs]) =>
      // An entry read names no tolerance: a view's first marks are placed from whatever the last
      // visit left in memory otherwise, a revision behind the feed, and the reading that would
      // correct them arrives after the rider has started watching.
      transitSource.getTrip(departureId, isEntryRead ? 0 : maxAgeMs),
    ),
    // When each sequence was read is not a fact these rows carry: the times a rider reads beside
    // them come from the stop row, which dates itself through the board it arrived on.
  ).then((readings) => readings.flatMap((reading) => (reading ? [reading.trip] : [])));

/**
 * Complete calls for the explicitly relevant departures, one provider request per trip.
 *
 * This is deliberately used for the departures a reading in view actually places — one line at the
 * stop in view, the vehicles drawn on the Zentrum map — not for discovering a whole network: the
 * latter is already shared by a bounded number of batched observation boards.
 *
 * Two things keep the requests down. A trip's *sequence* does not move — the calls ahead are
 * fixed, and the departure facts a rider reads beside a row come from the stop row — so the vehicle
 * the rider did not choose is re-read at `LINE_TRIP_MAX_AGE_MS`, not on every board refresh. And a
 * sequence once read is kept for as long as its departure is on the board: rows roll off the end
 * of a board constantly, and re-asking for every trip because the *set* changed is what made a
 * diagram blank on a refresh.
 */
export function useTripDepartures(
  /** Memoize this: it decides the load key and the identity of everything read from the result. */
  departures: readonly Departure[],
  selectedDepartureId?: string,
  refreshMs = DEPARTURE_BOARD_REFRESH_MS,
): readonly Departure[] {
  const departureIds = toSortedIds(departures.map(({ id }) => id));
  const key =
    departureIds.length > 0
      ? JSON.stringify(
          departureIds.map((id) => [
            id,
            id === selectedDepartureId ? refreshMs : LINE_TRIP_MAX_AGE_MS,
          ]),
        )
      : null;
  const loadOptions = useMemo<KeyedLoadOptions<Departure[]>>(
    () => ({ refreshMs, isFailure: (trips) => trips.length === 0 }),
    [refreshMs],
  );
  // One loader per view, whose first run is the entry read that looks past the source's cache;
  // every run after it keeps the tolerance the key states.
  const load = useMemo(() => createFreshEntryLoad(loadTrips), []);
  const loaded = useKeyedLoad(key, load, loadOptions);
  const [remembered, setRemembered] = useState<TripMemory>(EMPTY_TRIP_MEMORY);

  // Learned while rendering rather than in an effect, so a sequence that has arrived is never a
  // paint late. Trimming to the departures in hand is what bounds the memory: a trip is forgotten
  // when its row leaves the board.
  if (loaded && loaded.length > 0 && remembered.source !== loaded) {
    const tripById = new Map<string, Departure>();
    for (const { id } of departures) {
      const kept = remembered.tripById.get(id);
      if (kept) tripById.set(id, kept);
    }
    for (const trip of loaded) tripById.set(trip.id, trip);
    setRemembered({ source: loaded, tripById });
  }

  // The stop row stays the departure fact — its countdown, platform and delay are the fresh ones —
  // and the trip contributes only what a board row cannot state: the whole sequence behind it.
  return useMemo(
    () =>
      departures.flatMap((departure) => {
        const trip = remembered.tripById.get(departure.id);
        return trip ? [mergeTripSequence(departure, trip)] : [];
      }),
    [departures, remembered],
  );
}
