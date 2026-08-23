import type {
  Departure,
  DepartureBoard,
  TransitLine,
  TransportMode,
  TripCall,
} from "../data/transit-types";
import { createLineSign } from "../data/line-signs";
import { compareLineIds, getLineFamilyId, isSameLineFamily } from "./line-families";
import { isZentrumStop } from "../data/zentrum-stops";
import { addOnce, getDistinctByFrequency, toSortedIds } from "./collections";
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

/**
 * How many boards a line diagram is read from beside the rider's own.
 *
 * The diagram places its vehicle marks from the trips of boards taken along the line, and it used
 * to ask for one board per core stop the line calls at — ten of them for Linie 3, each carrying the
 * complete calling sequence of twenty trips. That is a hundred kilobytes a stop, every refresh, for
 * marks that move a few pixels. Asked for one line, a board reaches an hour and a half ahead
 * instead of twenty minutes, so these few now see more than ten did.
 *
 * Three, because that is what it takes to see the whole fleet rather than most of it: one board at
 * each end of the line covers both directions of it end to end, and a third inside covers the short
 * workings that turn back before ever reaching an end.
 *
 * Three is also where it stops being worth asking. Measured against every stop of the line read at
 * once — S1, S2, 1, 3 and 4, at several times of day, scored from the worst stop a rider could be
 * standing at — the share of the running fleet a view sees goes:
 *
 *     boards   1     2     3     4     5     6
 *     fleet    62%   90%   96%  100%  100%  100%   (mean)
 *              0%    50%  ~100% ~100% ~100% ~100%  (worst rider position)
 *
 * The fourth board gained nothing on any line, at any time, from any stop. Neither did doubling a
 * board's rows: the same three boards score the same at twenty rows as at forty, because a vehicle
 * still running passes the stops ahead of it well inside the ninety minutes twenty filtered rows
 * already reach. Neither did an arrivals board at each terminus, read to catch the vehicle on its
 * final link that no departures board still lists: across five lines it added no vehicle at all.
 *
 * What the three still miss is one shape of trip: a working that both begins and ends between two
 * samples, so no board this view asks for ever has it ahead of them — a Bad Herrenalb–Kirchfeld S1
 * turning off the drawn line, listed only at seven consecutive stops in a stretch the samples
 * straddle. Reaching it needs eight boards, not four: two and a half times the traffic to place,
 * for a minute or two, a train that is about to leave the diagram anyway.
 */
export const LINE_OBSERVATION_LIMIT = 3;

/**
 * The stops a line's vehicles are read from, beside the rider's own board.
 *
 * These are read filtered to the line, which is what changed the arithmetic: an unfiltered board
 * spends its rows on every line at the stop and reaches about twenty minutes, so a vehicle still
 * out at the end of its run appeared on none of them. Filtered, the whole row budget goes to this
 * line and three boards cover a corridor that seven unfiltered ones could not.
 *
 * Observation posts are no longer excluded. They were, because the shell passed their loaded boards
 * straight to the diagram — but those boards are unfiltered and answer a different question, so a
 * post that sits on this line is now as worth sampling as any other stop.
 *
 * Where they are taken is what decides whether the diagram shows every train running or only the
 * ones near the middle. A board lists a trip while that stop is still ahead of it, so a board sees
 * the vehicles *behind* it: standing one call in from a terminus, it sees every vehicle running
 * towards that terminus bar the one already on the final link, and the pair of them covers the
 * whole line in both directions. Spread evenly instead, the same two boards cover the middle alone
 * — a vehicle past the outer sample is on no board in hand, and on a fresh visit there is no
 * retained observation to place it from either.
 *
 * The ends are the guarantee; the budget beyond them is spent by halving the widest stretch not yet
 * read from, because the trips the ends cannot see are the short workings that turn back before
 * reaching one, and those are only ever listed inside the stretch they actually run.
 *
 * The terminus itself is the one stop that says nothing about the vehicles heading for it: its
 * board is the departures *from* it, which is the return workings the far end's sample already
 * sees. So it stands last, for the short line that has nothing else.
 *
 * The rider's own board is one of these readings, not an extra beside them: standing where a sample
 * would be taken, they *are* that sample, and the request is not made twice.
 */
export function getLineObservationStopIds(
  lineStopIds: readonly string[],
  currentStopId: string,
  limit = LINE_OBSERVATION_LIMIT,
): string[] {
  const chain = [...new Set(lineStopIds)];
  const lastIndex = chain.length - 1;
  if (lastIndex < 0) return [];

  const indices: number[] = [];
  const addIndex = (index: number) => {
    if (index >= 0 && index <= lastIndex && !indices.includes(index)) indices.push(index);
  };
  addIndex(Math.min(1, lastIndex));
  addIndex(Math.max(0, lastIndex - 1));
  while (indices.length < limit) {
    const read = [...indices].sort((first, second) => first - second);
    let widest = 1;
    let halved = -1;
    for (const [position, index] of read.slice(0, -1).entries()) {
      const stretch = read[position + 1] - index;
      if (stretch > widest) {
        widest = stretch;
        halved = Math.floor((index + read[position + 1]) / 2);
      }
    }
    // Nothing left unread between two samples: the line is shorter than the budget.
    if (halved < 0) break;
    addIndex(halved);
  }
  addIndex(0);
  addIndex(lastIndex);

  const read = new Set<string>();
  for (const index of indices) {
    if (read.size >= limit) break;
    read.add(chain[index]);
  }
  return [...read].filter((stopId) => stopId !== currentStopId);
}

/**
 * The whole chain of stops a line calls at, as the fullest trip in hand describes it.
 *
 * Sampling the line from its *core* stops only ever reached into the Zentrum, which is the one
 * stretch every observation post already sees. A loaded trip states the complete run, so the
 * samples can be spread across the real line instead — including the outer thirds, which is where
 * marks were missing. Until a trip carries its calls the core stops are all there is to go on.
 */
export function getLineCallStopIds(
  trips: readonly Departure[],
  line: TransitLine | undefined,
): readonly string[] {
  let longest: Departure | undefined;
  for (const trip of trips) {
    if ((trip.tripCalls?.length ?? 0) > (longest?.tripCalls?.length ?? 0)) longest = trip;
  }
  const called =
    longest?.tripCalls?.flatMap((call) => (call.localStopId ? [call.localStopId] : [])) ?? [];
  return called.length > 0 ? called : (line?.zentrumStopIds ?? []);
}

/**
 * The provider's per-direction ids for one line, which is what a filtered board is asked for.
 *
 * A line is two of these — `:H:` and `:R:` — and a board filtered to one of them shows one
 * direction, so both have to be named. They are read off the departures rather than authored: the
 * feed already states one on every row as `routeDirectionId`.
 */
export function getLineDirectionIds(lineId: string, departures: readonly Departure[]): string[] {
  return toSortedIds(
    departures.flatMap((departure) =>
      departure.routeDirectionId && isSameLineFamily(departure.lineId, lineId)
        ? [departure.routeDirectionId]
        : [],
    ),
  );
}

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
