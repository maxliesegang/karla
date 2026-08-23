import { findCatalogStop } from "./generated/kvv-stop-catalog";
import { kvvStopMappingByLocalStopId } from "./kvv-stop-mappings";
import { getBaseName } from "../lib/stop-naming";
import type { TransitNetwork, TransitStop } from "./transit-types";

/**
 * The stops the app must be able to resolve, and the little about them that someone decided.
 *
 * Which stops those are is `kvv-stop-mappings.ts`: a stop the app addresses by a stable id is a
 * stop it has a provider id for, and there is no second list to keep in step with that one. What a
 * stop is called and where it stands are facts the operator publishes, read from the generated
 * catalog rather than typed here — half the hand-typed positions this file used to carry sat over
 * 100 m from the stop, one of them 501 m, against the 900 m that decides whether the nearby ranking
 * offers a stop at all.
 *
 * What is left below is the part no source states: the one place where the operator's name is not
 * the only name to show.
 */

/**
 * The municipality the app is a board for. A stop inside it needs no qualifier; a stop outside it
 * is where the operator's bare name stops being enough — Durlach's station is published as
 * "Bahnhof", which names nothing on its own in a list that spans the whole network.
 */
const MUNICIPALITY_NAME = "Karlsruhe";

/** Where the stop is known by a second name the operator does not publish. */
const authoredNamesByStopId: Readonly<Record<string, Pick<TransitStop, "alias">>> = {
  // Renamed in 2021. The square is still Mendelssohnplatz on the ground and in riders' mouths.
  "rueppurrer-tor": { alias: "Mendelssohnplatz" },
};

function createStop(localStopId: string, providerStopId: string): TransitStop | undefined {
  const catalogStop = findCatalogStop(providerStopId);
  if (!catalogStop) return undefined;
  // The locality is the operator's own, not a second list: a stop outside Karlsruhe carries it as
  // its alias, which is what the search line and the board's subtitle already show. An authored
  // name wins over it, because that is the case someone decided about on purpose.
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
  // A stop the catalog has since dropped loses its entry rather than appearing without a position:
  // `tests/stop-catalog.test.ts` holds that to nothing today, so a renumbered stop fails the build
  // instead of reaching a rider as a board that will not load.
  stops: Object.entries(kvvStopMappingByLocalStopId).flatMap(
    ([localStopId, { providerStopId }]) => {
      const stop = createStop(localStopId, providerStopId);
      return stop ? [stop] : [];
    },
  ),
  // Lines are not kept here: which lines run, and where they run, is read from the live feed
  // in `lib/observed-network.ts`. Only the stops the app must be able to resolve stay stable.
  lines: [],
};
