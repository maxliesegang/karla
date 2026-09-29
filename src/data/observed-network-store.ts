import type { Departure, DepartureBoard, TripCall } from "./transit-types";
import {
  buildObservedNetworkFromTrips,
  type ObservedNetwork,
  type ObservedTripTopology,
} from "../lib/observed-network";
import { findFinalCallInstant, getCallSequenceKey } from "../lib/trip-calls";
import { RUN_ENDED_GRACE_MS, RUN_READING_MAX_AGE_MS } from "./run-reading-store";

const EMPTY_OBSERVED_NETWORK: ObservedNetwork = { stops: [], lines: [], tripCount: 0 };

/** The topology fields a call may teach, with every per-run timing fact removed. */
const toTopologyCall = (call: TripCall): TripCall => ({
  stopName: call.stopName,
  ...(call.placeName ? { placeName: call.placeName } : {}),
  ...(call.platformLabel ? { platformLabel: call.platformLabel } : {}),
  ...(call.platformCode ? { platformCode: call.platformCode } : {}),
  ...(call.providerStopPointId ? { providerStopPointId: call.providerStopPointId } : {}),
  ...(call.localStopId ? { localStopId: call.localStopId } : {}),
  ...(call.latitude !== undefined ? { latitude: call.latitude } : {}),
  ...(call.longitude !== undefined ? { longitude: call.longitude } : {}),
});

const toTopology = (departure: Departure): ObservedTripTopology | undefined =>
  departure.status !== "cancelled" && departure.tripCalls?.length
    ? {
        id: departure.id,
        ...(departure.tripId ? { tripId: departure.tripId } : {}),
        lineId: departure.lineId,
        transportMode: departure.transportMode,
        destination: departure.destination,
        tripCalls: departure.tripCalls.map(toTopologyCall),
      }
    : undefined;

/** One distinct published topology of a timetable trip; diversions are evidence of their own. */
const getTopologyKey = (trip: ObservedTripTopology): string =>
  [
    trip.tripId ?? trip.id,
    trip.lineId,
    trip.transportMode,
    trip.destination,
    getCallSequenceKey(trip.tripCalls ?? []),
  ].join("\u0000");

/**
 * When a trip stops teaching the network anything: the lifetime its run's evidence is kept for.
 *
 * Ended at its last call plus the grace, or aged out when its calls state no time, exactly as
 * `RunReadingStore` retires the run — so the network forgets a trip when the evidence about it is
 * gone, and not a session later.
 */
const getTopologyExpiry = (departure: Departure, now: number): number =>
  (findFinalCallInstant(departure.tripCalls) ?? now + RUN_READING_MAX_AGE_MS) + RUN_ENDED_GRACE_MS;

/**
 * Knowledge learned from live boards, independent of whichever view fetched them.
 *
 * One topology-only record is retained per distinct timetable route, until that trip has run: a
 * line that stops running leaves the network by itself. Re-reading the same trip does not make it
 * count twice; a diverted route remains usable evidence alongside its ordinary one. No run reading
 * is retained here.
 */
export class ObservedNetworkStore {
  private readonly tripsByKey = new Map<
    string,
    { topology: ObservedTripTopology; expiresAt: number }
  >();
  private readonly listeners = new Set<() => void>();
  private snapshot = EMPTY_OBSERVED_NETWORK;

  rememberBoard(board: DepartureBoard, now = Date.now()): void {
    if (board.dataStatus !== "live") return;
    let changed = false;
    for (const departure of board.departures) {
      const topology = toTopology(departure);
      if (!topology) continue;
      const key = getTopologyKey(topology);
      const expiresAt = getTopologyExpiry(departure, now);
      const known = this.tripsByKey.get(key);
      if (known) {
        known.expiresAt = Math.max(known.expiresAt, expiresAt);
        continue;
      }
      if (expiresAt <= now) continue;
      this.tripsByKey.set(key, { topology, expiresAt });
      changed = true;
    }
    for (const [key, { expiresAt }] of this.tripsByKey) {
      if (expiresAt > now) continue;
      this.tripsByKey.delete(key);
      changed = true;
    }
    if (!changed) return;
    this.snapshot = buildObservedNetworkFromTrips(
      [...this.tripsByKey.values()].map(({ topology }) => topology),
    );
    for (const listener of this.listeners) listener();
  }

  getSnapshot = (): ObservedNetwork => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
}
