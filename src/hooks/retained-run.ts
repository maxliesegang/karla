import { useEffect, useMemo, useRef, useState } from "react";
import { transitSource } from "../data/transit-source";
import type { Departure } from "../data/transit-types";
import { getDepartureReadInstant } from "../lib/trips";
import { DEPARTURE_BOARD_REFRESH_MS } from "./departure-board";
import { useDeviceNow } from "./clock";
import { useKeyedLoad, type KeyedLoadOptions } from "./keyed-load";
import { useRuns } from "./run-reading-store";
import {
  findActiveRideObservation,
  forgetActiveRideObservation,
  rememberActiveRideObservation,
} from "../lib/active-ride";

/**
 * The run a rider is on, kept for as long as the ride lasts.
 *
 * A run is found by reading departure boards, and a departure board only lists what has not left
 * yet — so a few minutes after boarding, every board along the line has stopped mentioning the run
 * the rider is sitting on. Dropping the view at that point ends the mode exactly when it starts
 * being useful.
 *
 * What it keeps is the *name* of the run to go on reading, never a reading of its own: `useRuns`
 * reads the store, where every contest between a board's row and a reading of the run's own has
 * already been settled (`RunReadingStore`). Beyond the name it owns only the *gaps* — the
 * observation mirrored to storage, which answers while the source has nothing at all.
 *
 * While no board is reading it, the ride *asks* for its run by name, on the board's own cadence,
 * one request for one vehicle. A run's stated deviation moves about every
 * `FEED_REVISION_INTERVAL_MS`, so a ride held ten minutes on a single reading is a dozen revisions
 * out of date. Only the ride earns that cadence: a diagram's marks are re-read on the line's slower
 * run clock, because there are ten of them and nobody is sitting on any of them.
 *
 * What the re-reading renews is the *sequence*. The row's own published time and deviation are the
 * board's statement about this vehicle at one stop and are not re-read once no board carries the
 * row; `lib/vehicle-positioning.ts` knows this and stops trusting the row once its departure is
 * behind us.
 *
 * Each reading is dated by the source, never here. A run asked for is not always a run re-read, so
 * stamping the clock on arrival would have the ride claim an age it does not have.
 */
export type RetainedRun = {
  departure: Departure | undefined;
  /** When this observation of the run was read; only meaningful while `isRetained`. */
  observedAt: number;
  /** The boards no longer list this run, and what is in view is the last reading of it. */
  isRetained: boolean;
};

const EMPTY_IDS: readonly string[] = [];

const loadRetainedRun = (rowId: string): Promise<Departure | undefined> =>
  transitSource.getRun(rowId, DEPARTURE_BOARD_REFRESH_MS);

const RETAINED_RUN_LOAD_OPTIONS: KeyedLoadOptions<Departure | undefined> = {
  refreshMs: DEPARTURE_BOARD_REFRESH_MS,
  // A run the source can no longer name is not a run that stopped running; it is a locator the
  // cap evicted. Backing off is right, and the kept observation still answers the view meanwhile.
  isFailure: (reading) => reading === undefined,
};

/** Keeps the ride's own run being read while no board is reading it, on the board's own cadence. */
function useRetainedRunRead(rowId: string | undefined): void {
  useKeyedLoad(rowId ?? null, loadRetainedRun, RETAINED_RUN_LOAD_OPTIONS);
}

export function useRetainedRun(
  addressId: string | undefined,
  departure: Departure | undefined,
): RetainedRun {
  // How old the reading in hand is, on the clock its timestamp was taken from. Ticking, so a board
  // that goes quiet starts the ride's own re-reading by itself rather than at the next render.
  const now = useDeviceNow();
  // Read from storage once per ride: a reload finds the ride it was reading. It seeds the id below
  // and is the answer of last resort behind it, and this session's own readings overtake it on the
  // very next paint.
  const storedObservation = useMemo(
    () => (addressId ? findActiveRideObservation(addressId) : null),
    [addressId],
  );

  // The name of the run to go on reading, the way a line diagram keeps the names of its marks
  // (`lib/line-run-departures.ts`). Stated once per ride and then it stands.
  const [anchor, setAnchor] = useState<{ rideId: string; rowId: string } | null>(null);
  const anchored = anchor?.rideId === addressId ? anchor : null;
  const rowId = departure?.id ?? anchored?.rowId ?? storedObservation?.departure.id;
  if (addressId && rowId && rowId !== anchored?.rowId) {
    setAnchor({ rideId: addressId, rowId });
  }

  // Only while no board is currently reading it. A run listed on a board is not the same thing as
  // a run being re-read: the network observation posts are read every twenty minutes and carry
  // whole calling sequences, so a ride can be "on a board" and still be publishing half-hour-old
  // deviations. What suppresses the request is a reading no older than the board cadence — anything
  // slower than that is a reading the ride has to renew for itself.
  const departureReadAt = (departure && getDepartureReadInstant(departure)) ?? 0;
  const isReadingCurrent = Boolean(departure) && now - departureReadAt < DEPARTURE_BOARD_REFRESH_MS;
  // Only the ride earns a request of its own: away from it the run in view is the one on the board
  // beside it, and reading it separately would spend a request restating what that row just said.
  useRetainedRunRead(!addressId || isReadingCurrent ? undefined : rowId);
  const readRowIds = useMemo(() => (rowId ? [rowId] : EMPTY_IDS), [rowId]);
  const [live] = useRuns(readRowIds);

  // Nothing left to prefer here; where the source knows nothing at all, the board's row stands.
  const reading = live ?? departure;

  // Mirrored to storage, where the next reload finds it, and forgotten with the ride. The instant
  // last written is kept beside the write, so the mirror records the best the ride ever saw rather
  // than whatever the most recent render held.
  const mirroredAt = useRef<{ rideId: string; observedAt: number } | null>(null);
  useEffect(() => {
    if (!addressId) {
      mirroredAt.current = null;
      forgetActiveRideObservation();
      return;
    }
    if (!reading) return;
    const observedAt = getDepartureReadInstant(reading) ?? 0;
    const written = mirroredAt.current;
    if (written?.rideId === addressId && observedAt <= written.observedAt) return;
    rememberActiveRideObservation(addressId, reading, observedAt);
    mirroredAt.current = { rideId: addressId, observedAt };
  }, [addressId, reading]);

  // The stored observation answers only where the source has nothing at all: the paint before a
  // reload's first reading lands, and a run the cap evicted while the ride was still reading it.
  // It may be older than the last reading this session took — `observedAt` states its real age
  // either way, and the request above goes on asking until the source can answer again.
  const shown = reading ?? storedObservation?.departure;
  const observedAt = (shown && getDepartureReadInstant(shown)) ?? 0;
  const isRetained = Boolean(addressId && shown && !departure);
  return { departure: shown, observedAt, isRetained };
}
