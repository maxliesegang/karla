import type { KvvTripCall } from "./kvv-efa-parsers";
import { kvvStopMappingByLocalStopId } from "./kvv-stop-mappings";
import type { TransitStop, TripCall } from "./transit-types";
import { createStopSlug } from "../lib/stop-slug";

/** A dynamic stop id is its name slug plus a short digest of the provider id: `hbf--1a2b3c`. */
export const DYNAMIC_STOP_ID_PATTERN = /^(.*?)--([a-z0-9]+)$/;

/**
 * Provider stop point -> local stop id, inverted once. A trip sequence resolves one entry per
 * calling point, which is far too often to be scanning the mapping table each time.
 *
 * Every stop point of a place is inverted, not only the one its board is requested for: a place is
 * one local stop however many platforms the operator numbers it across, and a trip must resolve to
 * it from whichever of them it calls at.
 */
const localStopIdByProviderId: ReadonlyMap<string, string> = new Map(
  Object.entries(kvvStopMappingByLocalStopId).flatMap(([localId, mapping]) =>
    [mapping.providerStopId, ...(mapping.otherProviderStopIds ?? [])].map(
      (providerStopId) => [providerStopId, localId] as const,
    ),
  ),
);

/** The short digest a dynamic stop id carries, so a deep link names one stop point and not a name. */
export function hashProviderStopId(providerId: string): string {
  let hash = 2166136261;
  for (const character of providerId) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export type StopRegistration = {
  providerId: string;
  name: string;
  placeName?: string;
  latitude?: number;
  longitude?: number;
  /** The id a deep link already used, so resolving that link does not mint a second one. */
  preferredId?: string;
};

/**
 * Which stop a provider id is, and which provider id a stop is — in both directions, for the
 * session.
 *
 * The authored network is stable local data and answers first; every other stop is one the session
 * has met, through a name search or through a calling point of a trip, and is kept so the same
 * provider stop resolves to the same local id wherever it turns up again.
 */
export class StopRegistry {
  private readonly authoredStopsById: ReadonlyMap<string, TransitStop>;
  private readonly dynamicStops = new Map<string, TransitStop>();
  /** Both directions of the dynamic id <-> provider id pairing, so neither lookup has to scan. */
  private readonly providerIdByDynamicStopId = new Map<string, string>();
  private readonly dynamicStopIdByProviderId = new Map<string, string>();

  constructor(authoredStops: readonly TransitStop[]) {
    this.authoredStopsById = new Map(authoredStops.map((stop) => [stop.id, stop]));
  }

  /** A stop the session already holds, whether it is authored or dynamically resolved. */
  findStop(stopId: string): TransitStop | undefined {
    return this.authoredStopsById.get(stopId) ?? this.dynamicStops.get(stopId);
  }

  /** The provider stop point behind a local stop, whether it is authored or dynamically resolved. */
  findProviderStopId(stopId: string): string | undefined {
    return (
      kvvStopMappingByLocalStopId[stopId]?.providerStopId ??
      this.providerIdByDynamicStopId.get(stopId)
    );
  }

  /** A supported local page for this provider stop, preferring the fixed mapping over a dynamic one. */
  findLocalStopId(providerId: string): string | undefined {
    return (
      localStopIdByProviderId.get(providerId) ?? this.dynamicStopIdByProviderId.get(providerId)
    );
  }

  /**
   * A stop the session has met but the authored network does not list. Registered once and kept for
   * the session, so the same provider stop resolves to the same local id wherever it turns up.
   */
  register({
    providerId,
    name,
    placeName,
    latitude,
    longitude,
    preferredId,
  }: StopRegistration): TransitStop {
    const id = preferredId ?? `${createStopSlug(name)}--${hashProviderStopId(providerId)}`;
    // A stop outside the core is shown with the municipality beside its name, which is the second
    // name a rider knows it by — the same slot a local stop states a colloquial name in.
    const stop: TransitStop = { id, name, alias: placeName, latitude, longitude };
    this.dynamicStops.set(id, stop);
    this.providerIdByDynamicStopId.set(id, providerId);
    this.dynamicStopIdByProviderId.set(providerId, id);
    return stop;
  }

  /** Provider calling points as the app states them: every one resolved to a local stop of ours. */
  toTripCalls(tripCalls: readonly KvvTripCall[]): TripCall[] {
    return tripCalls.map(({ providerId, ...tripStop }) => ({
      ...tripStop,
      localStopId: providerId
        ? this.resolveTripCallStopId(providerId, tripStop)
        : createStopSlug(tripStop.stopName),
    }));
  }

  /**
   * The local id for one calling point of a trip. The feed states where every calling point is, so
   * a stop first met inside a trip is registered with its position — that is what lets a rider be
   * placed against stops the authored network never listed. A stop already met through the name
   * search carries no position, so the first call that states one fills it in.
   */
  private resolveTripCallStopId(
    providerId: string,
    tripStop: Omit<KvvTripCall, "providerId">,
  ): string {
    const knownId = this.findLocalStopId(providerId);
    if (!knownId) {
      return this.register({
        providerId,
        name: tripStop.stopName,
        placeName: tripStop.placeName,
        latitude: tripStop.latitude,
        longitude: tripStop.longitude,
      }).id;
    }

    const known = this.dynamicStops.get(knownId);
    if (known && known.latitude === undefined && tripStop.latitude !== undefined) {
      this.dynamicStops.set(knownId, {
        ...known,
        latitude: tripStop.latitude,
        longitude: tripStop.longitude,
      });
    }
    return knownId;
  }
}
