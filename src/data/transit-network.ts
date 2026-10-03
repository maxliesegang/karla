import { findCatalogStop } from "./generated/kvv-stop-catalog";
import { kvvStopMappingByLocalStopId } from "./kvv-stop-mappings";
import { getBaseName } from "../lib/stop-naming";
import type { TransitNetwork, TransitStop } from "./transit-types";

/**
 * The stops the app must resolve: those in `kvv-stop-mappings.ts`, named and placed from the
 * generated catalog (hand-typed positions drift by hundreds of metres). Only what no source states
 * is authored here.
 */

/**
 * The home municipality; stops outside it need a qualifier (Durlach's station is just "Bahnhof").
 */
const MUNICIPALITY_NAME = "Karlsruhe";

/** Second names the operator does not publish. */
const authoredNamesByStopId: Readonly<Record<string, Pick<TransitStop, "alias">>> = {
  // Renamed in 2021; still Mendelssohnplatz to riders.
  "rueppurrer-tor": { alias: "Mendelssohnplatz" },
};

function createStop(localStopId: string, providerStopId: string): TransitStop | undefined {
  const catalogStop = findCatalogStop(providerStopId);
  if (!catalogStop) return undefined;
  // Outside Karlsruhe the locality is the alias; an authored name wins.
  const placeName = getBaseName(catalogStop.placeName);
  return {
    id: localStopId,
    name: getBaseName(catalogStop.name),
    latitude: catalogStop.latitude,
    longitude: catalogStop.longitude,
    ...(placeName === MUNICIPALITY_NAME ? {} : { alias: placeName }),
    ...authoredNamesByStopId[localStopId],
  };
}

export const transitNetwork: TransitNetwork = {
  // Stops dropped from the catalog lose their entry; `tests/stop-catalog.test.ts` fails the build
  // on it.
  stops: Object.entries(kvvStopMappingByLocalStopId).flatMap(
    ([localStopId, { providerStopId }]) => {
      const stop = createStop(localStopId, providerStopId);
      return stop ? [stop] : [];
    },
  ),
  // Lines come from the live feed (`lib/observed-network.ts`).
  lines: [],
};
