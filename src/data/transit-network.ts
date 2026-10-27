import { network } from "../networks/network";
import { getBaseName } from "../lib/stop-naming";
import type { TransitNetwork, StopPlace } from "./transit-types";

/**
 * The stops the app must resolve: the network's stop places, named and placed from its
 * generated catalog (hand-typed positions drift by hundreds of metres). Only what no source states
 * is authored here.
 */

/** Second names the operator does not publish. */
const authoredNamesByStopId: Readonly<Record<string, Pick<StopPlace, "alias">>> = {
  // Renamed in 2021; still Mendelssohnplatz to riders.
  "rueppurrer-tor": { alias: "Mendelssohnplatz" },
};

function createStop(localStopId: string, stopPointId: string): StopPlace | undefined {
  const catalogStop = network.findCatalogStop(stopPointId);
  if (!catalogStop) return undefined;
  // Outside Karlsruhe the locality is the alias; an authored name wins.
  const placeName = getBaseName(catalogStop.placeName);
  return {
    id: localStopId,
    name: getBaseName(catalogStop.name),
    latitude: catalogStop.latitude,
    longitude: catalogStop.longitude,
    // Outside the home municipality a stop needs a qualifier (Durlach's station is just "Bahnhof").
    ...(placeName === network.home.placeName ? {} : { alias: placeName }),
    ...authoredNamesByStopId[localStopId],
  };
}

export const transitNetwork: TransitNetwork = {
  // Stops dropped from the catalog lose their entry; `tests/stop-catalog.test.ts` fails the build
  // on it.
  stops: Object.entries(network.stopPlaces).flatMap(([localStopId, { stopPoints }]) => {
    const stop = createStop(localStopId, stopPoints[0]);
    return stop ? [stop] : [];
  }),
  // Lines come from the live feed (`lib/observed-network.ts`).
  lines: [],
};
