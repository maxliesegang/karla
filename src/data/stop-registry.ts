import type { KvvCall } from "./kvv-feed";
import { kvvStopMappingByLocalStopId } from "./kvv-stop-mappings";
import type { StopPlace, Call } from "./transit-types";
import { createStopSlug } from "../lib/stop-slug";
import { findCatalogStop } from "./generated/kvv-stop-catalog";
import { kvvBayPositionByKey } from "./generated/kvv-bay-positions";

/** A dynamic stop id: name slug plus a short digest of the provider id (`hbf--1a2b3c`). */
export const DYNAMIC_STOP_ID_PATTERN = /^(.*?)--([a-z0-9]+)$/;

/**
 * Provider stop point to local stop id, inverted once; every stop point of a place maps to it, so a
 * journey resolves from whichever it calls at.
 */
const localStopIdByProviderId: ReadonlyMap<string, string> = new Map(
  Object.entries(kvvStopMappingByLocalStopId).flatMap(([localId, mapping]) =>
    [mapping.providerStopId, ...(mapping.otherProviderStopIds ?? [])].map(
      (providerStopId) => [providerStopId, localId] as const,
    ),
  ),
);

/** The digest a dynamic id carries, so a deep link names one stop point. */
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
  /** The id a deep link already used, so resolving it does not mint a second. */
  preferredId?: string;
};

/**
 * Provider id to local stop and back, for the session. Authored stops first; others are met through
 * searches or journey calls and keep the same local id thereafter.
 */
export class StopRegistry {
  private readonly authoredStopsById: ReadonlyMap<string, StopPlace>;
  private readonly dynamicStops = new Map<string, StopPlace>();
  /** Both directions of the dynamic-id pairing. */
  private readonly providerIdByDynamicStopId = new Map<string, string>();
  private readonly dynamicStopIdByProviderId = new Map<string, string>();

  constructor(authoredStops: readonly StopPlace[]) {
    this.authoredStopsById = new Map(authoredStops.map((stop) => [stop.id, stop]));
  }

  /** A stop the session holds, authored or dynamic. */
  findStop(stopId: string): StopPlace | undefined {
    return this.authoredStopsById.get(stopId) ?? this.dynamicStops.get(stopId);
  }

  /** The provider stop point behind a local stop. */
  findProviderStopId(stopId: string): string | undefined {
    return (
      kvvStopMappingByLocalStopId[stopId]?.providerStopId ??
      this.providerIdByDynamicStopId.get(stopId)
    );
  }

  /** The local page for a provider stop, preferring the fixed mapping. */
  findLocalStopId(providerId: string): string | undefined {
    return (
      localStopIdByProviderId.get(providerId) ?? this.dynamicStopIdByProviderId.get(providerId)
    );
  }

  /** Registers a stop the authored network lacks, once per session. */
  register({
    providerId,
    name,
    placeName,
    latitude,
    longitude,
    preferredId,
  }: StopRegistration): StopPlace {
    // The authored stop wins over a search hit or an old dynamic id, so page and journey calls use
    // one id.
    const authoredId = localStopIdByProviderId.get(providerId);
    const authored = authoredId ? this.authoredStopsById.get(authoredId) : undefined;
    if (authored) return authored;

    // Likewise a registered dynamic stop: a different spelling enriches it rather than duplicating
    // it.
    const registeredId = this.dynamicStopIdByProviderId.get(providerId);
    const registered = registeredId ? this.dynamicStops.get(registeredId) : undefined;
    if (registered) {
      if (registered.latitude === undefined && latitude !== undefined) {
        const enriched = { ...registered, latitude, longitude };
        this.dynamicStops.set(registered.id, enriched);
        return enriched;
      }
      return registered;
    }

    const id = preferredId ?? `${createStopSlug(name)}--${hashProviderStopId(providerId)}`;
    // The municipality goes in the alias slot.
    const stop: StopPlace = { id, name, alias: placeName, latitude, longitude };
    this.dynamicStops.set(id, stop);
    this.providerIdByDynamicStopId.set(id, providerId);
    this.dynamicStopIdByProviderId.set(providerId, id);
    return stop;
  }

  /**
   * Provider calls with every stop resolved to a local one, and located where the feed left them
   * unlocated (a board's own call; every TRIAS call).
   */
  toCalls(calls: readonly KvvCall[]): Call[] {
    return calls.map(({ providerId, ...journeyStop }) => {
      const localStopId = providerId
        ? this.resolveCallStopId(providerId, journeyStop)
        : createStopSlug(journeyStop.stopName);
      return {
        ...journeyStop,
        ...(providerId && journeyStop.latitude === undefined
          ? this.findPosition(providerId, journeyStop.bay)
          : {}),
        // Kept alongside the local id: which part of the page the rider is sent to.
        providerStopPointId: providerId,
        localStopId,
      };
    });
  }

  /**
   * A city rail bay's position, else the catalog's for its stop, else the one its stop was
   * registered with.
   */
  private findPosition(
    providerId: string,
    bay: string | undefined,
  ): { latitude?: number; longitude?: number } {
    const bayPosition = kvvBayPositionByKey.get(`${providerId}|${bay ?? ""}`);
    if (bayPosition) return { latitude: bayPosition.latitude, longitude: bayPosition.longitude };
    const catalogStop = findCatalogStop(providerId);
    if (catalogStop) return { latitude: catalogStop.latitude, longitude: catalogStop.longitude };
    const stopId = this.dynamicStopIdByProviderId.get(providerId);
    const stop = stopId === undefined ? undefined : this.dynamicStops.get(stopId);
    return stop?.latitude === undefined
      ? {}
      : { latitude: stop.latitude, longitude: stop.longitude };
  }

  /**
   * The local id for a journey call, registering it with its position; fills in a position missing
   * from a search-registered stop.
   */
  private resolveCallStopId(providerId: string, journeyStop: Omit<KvvCall, "providerId">): string {
    const knownId = this.findLocalStopId(providerId);
    if (!knownId) {
      return this.register({
        providerId,
        name: journeyStop.stopName,
        placeName: journeyStop.placeName,
        latitude: journeyStop.latitude,
        longitude: journeyStop.longitude,
      }).id;
    }

    const known = this.dynamicStops.get(knownId);
    if (known && known.latitude === undefined && journeyStop.latitude !== undefined) {
      this.dynamicStops.set(knownId, {
        ...known,
        latitude: journeyStop.latitude,
        longitude: journeyStop.longitude,
      });
    }
    return knownId;
  }
}
