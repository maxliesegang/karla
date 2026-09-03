import type { DepartureBoard, TransitLine, TransportMode, TripCall } from "../data/transit-types";
import { createLineSign } from "../data/line-signs";
import { compareLineIds, getLineFamilyId } from "./line-families";
import { isZentrumStop } from "../data/zentrum-stops";
import { addOnce, getDistinctByFrequency } from "./collections";
import { getDistinctTimetableTrips } from "./trips";

/**
 * The network as the live feed actually shows it, rather than as a list kept by hand.
 *
 * Every departure the feed answers carries its whole trip: the calling points behind and ahead of
 * it. Read across a handful of boards those trips spell out the network — which stops the Zentrum
 * actually has service at today, and which lines call there. Nothing here is authored, so a line
 * that stops running disappears on its own, and one that starts running appears without an edit.
 *
 * Only the list in `zentrum-stops.ts` is a decision: it says which stops count as the Zentrum.
 * Everything about them — that they have service today, and which lines call — is observed.
 */

/**
 * The boards the network is read from.
 *
 * A board answers with the whole trip behind each departure, so these few reach far past
 * themselves: between them the trips spell out which stops have service today and which lines call
 * there. They are observation posts, not a list of what any view contains — what a view contains is
 * whatever the trips turn out to run through.
 *
 * They are split because they answer two different questions on two different clocks. The Zentrum
 * posts feed the list a rider is looking at; the reach posts describe the rest of the network — the
 * lines that are running and where the stops are — and neither of those changes in ninety seconds.
 *
 * Both tiers were chosen by measurement rather than by prominence. Every stop of the municipality
 * that could plausibly serve as a post — the Zentrum's own stops and the eighteen largest
 * interchanges outside it by line count and by calls — was read at six service patterns (Mon 08:00,
 * 12:00, 17:00, Sat 18:00, Sun 11:00, and Sun 03:00 night service), and every combination scored on
 * the share of the *whole network's* stop-and-line pairs it saw at its worst reading. Scored on the
 * Zentrum alone, an outside post can only ever look worthless — it rides one corridor in and
 * re-reports a stretch already covered — which is how a set that reads five stops inside the ring
 * came to look sufficient. Against the whole network the five saw half of it:
 *
 *     worst-case share of the network seen   stop*line   stops   lines
 *     the five Zentrum posts                     51%      57%     48%
 *     these nine                                 81%      82%     78%
 *
 * The nine are better on the Zentrum too — 85% of its stop-and-line pairs at the worst reading
 * against 65% — so this is not a trade of one view against another.
 */

/**
 * The posts the Zentrum list rests on.
 *
 * Four, because past that the additions were redundant with each other: dropping either Kronenplatz
 * or Ettlinger Tor from the old five cost nothing at all at the worst reading, both of them sitting
 * mid-corridor on axes that Europaplatz and the Hauptbahnhof already run end to end through.
 * Each of these four costs something to drop.
 */
export const ZENTRUM_OBSERVATION_POST_STOP_IDS = [
  "europaplatz",
  "karlstor",
  "hauptbahnhof",
  "albtalbahnhof",
] as const;

/**
 * The posts the rest of the network is read from.
 *
 * Three of them are where the tram-trains change system, which is why they see what nothing in the
 * Zentrum does: a vehicle that leaves the tram network for the railway is listed at the transition
 * and then runs out of reach of every city post. Albtalbahnhof is the southern one and sits in the
 * Zentrum tier already; Durlach and Rheinbergstraße are the eastern and western ones.
 *
 * The other two are bus hubs, and buses are what the Zentrum posts are worst at: a bus that never
 * enters the ring is on no board inside it. Entenfang is the western hub, Zündhütle the way to the
 * Bergdörfer.
 *
 * What each one is the *only* source of, across the six readings, is the argument for it:
 *
 *     durlach-bahnhof    RE1 RE45 RE73, S3 S31 S32, 21 31, MX17a, NL12 NL13
 *     rheinbergstrasse   S51, 74, 75
 *     entenfang          2 60 62 70, NL15 NL16 NL17
 *     zuendhuetle        1 24 44 47
 *     turmberg           23 26
 *
 * Turmberg is the marginal one — it is here for the stops rather than the lines, taking the share
 * of the network's stops seen from 82% to 86%. It is the first post to drop if these ever cost too
 * much.
 */
export const REACH_OBSERVATION_POST_STOP_IDS = [
  "durlach-bahnhof",
  "rheinbergstrasse",
  "entenfang",
  "zuendhuetle",
  "turmberg",
] as const;

export type ObservedStop = {
  id: string;
  name: string;
  /** Line ids seen calling here, in the order they were first observed. */
  lineIds: string[];
  /** How many trips called here, which is how the view decides what to list first. */
  callCount: number;
};

export type ObservedLine = {
  id: string;
  transportMode: TransportMode;
  /** Destinations seen on this line, most frequent first — what a rider reads on the front. */
  destinations: string[];
};

export type ObservedNetwork = {
  stops: ObservedStop[];
  lines: ObservedLine[];
  /** How many trips the view was built from, so it can say how well observed it is. */
  tripCount: number;
};

/**
 * Where the stops the feed has named actually are.
 *
 * Every calling point of every trip states its position, and the trips read at a handful of posts
 * in the Zentrum run far past it — so a few boards know where several hundred stops are, most of
 * them well outside the core. That is what lets a rider standing in Durlach be placed against the
 * stop they are at rather than against the nearest stop somebody wrote down.
 *
 * Positions only. Whether a stop has service is still read from its own board.
 */
export type ObservedStopPosition = {
  id: string;
  name: string;
  placeName?: string;
  latitude: number;
  longitude: number;
};

export function getObservedStopPositions(
  boards: readonly DepartureBoard[],
): ObservedStopPosition[] {
  const positionById = new Map<string, ObservedStopPosition>();

  for (const board of boards) {
    if (board.dataStatus !== "live") continue;
    for (const departure of board.departures) {
      for (const call of departure.tripCalls ?? []) {
        const { localStopId, latitude, longitude } = call;
        if (!localStopId || latitude === undefined || longitude === undefined) continue;
        if (positionById.has(localStopId)) continue;
        positionById.set(localStopId, {
          id: localStopId,
          name: call.stopName,
          placeName: call.placeName,
          latitude,
          longitude,
        });
      }
    }
  }

  return [...positionById.values()];
}

/** A call is only usable once it resolves to a stop we can address. */
type IdentifiedCall = TripCall & { localStopId: string };

function isIdentifiedCall(call: TripCall): call is IdentifiedCall {
  return Boolean(call.localStopId);
}

export function buildObservedNetwork(boards: readonly DepartureBoard[]): ObservedNetwork {
  const stops = new Map<string, ObservedStop>();
  const lines = new Map<string, { transportMode: TransportMode; destinations: string[] }>();

  const trips = getDistinctTimetableTrips(boards);

  for (const trip of trips) {
    const line = lines.get(trip.lineId) ?? { transportMode: trip.transportMode, destinations: [] };
    line.destinations.push(trip.destination);
    lines.set(trip.lineId, line);

    for (const call of (trip.tripCalls ?? []).filter(isIdentifiedCall)) {
      if (!isZentrumStop(call.localStopId)) continue;
      const stop = stops.get(call.localStopId) ?? {
        id: call.localStopId,
        name: call.stopName,
        lineIds: [],
        callCount: 0,
      };
      addOnce(stop.lineIds, trip.lineId);
      stop.callCount += 1;
      stops.set(call.localStopId, stop);
    }
  }

  return {
    stops: [...stops.values()],
    lines: [...lines.entries()].map(([id, line]) => ({
      id,
      transportMode: line.transportMode,
      destinations: getDistinctByFrequency(line.destinations),
    })),
    tripCount: trips.length,
  };
}

/**
 * The observed lines as the rest of the app's views expect them — official sign where there is one,
 * neutral otherwise, and the two ends the line was seen running between.
 *
 * This replaces a kept list of lines. A line that is not running is not observed, so it is not
 * offered to a rider; one that starts running appears without an edit.
 */
type ObservedLineFamily = { sign: TransitLine; destinations: string[]; zentrumStopIds: string[] };

export function getObservedTransitLines(network: ObservedNetwork): TransitLine[] {
  const familyById = new Map<string, ObservedLineFamily>();

  const getFamily = (lineId: string, transportMode: TransportMode): ObservedLineFamily => {
    const familyId = getLineFamilyId(lineId);
    const existing = familyById.get(familyId);
    if (existing) return existing;
    const sign = { ...createLineSign(lineId, transportMode), id: familyId, name: familyId };
    const created: ObservedLineFamily = { sign, destinations: [], zentrumStopIds: [] };
    familyById.set(familyId, created);
    return created;
  };

  for (const observed of network.lines) {
    const family = getFamily(observed.id, observed.transportMode);
    for (const destination of observed.destinations) addOnce(family.destinations, destination);
  }

  // Walked once rather than re-scanned per line: a stop states the lines calling there already.
  for (const stop of network.stops) {
    for (const lineId of stop.lineIds) {
      const family = familyById.get(getLineFamilyId(lineId));
      if (family) addOnce(family.zentrumStopIds, stop.id);
    }
  }

  return [...familyById.values()]
    .map(({ sign, destinations, zentrumStopIds }) => ({ ...sign, destinations, zentrumStopIds }))
    .sort((a, b) => compareLineIds(a.id, b.id));
}
