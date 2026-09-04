import { useLayoutEffect, useRef, useState } from "react";
import { scrollIntoView } from "../../lib/scroll";

/**
 * Layout measurement and placement for the line diagram.
 *
 * These hooks read and watch the diagram's real DOM — row centres, scroll extents, the addressed
 * row — and turn them into state the panel and the vehicle layer render from. They are the only
 * place the diagram's class names and data attributes are queried.
 */

export type VehicleLayerGeometry = {
  coordinateKey: string;
  stopCenterOffsets: readonly number[];
  trackLeft: number;
};
export const EMPTY_VEHICLE_LAYER_GEOMETRY: VehicleLayerGeometry = {
  coordinateKey: "",
  stopCenterOffsets: [],
  trackLeft: 0,
};

/**
 * Where the diagram stands, and the one question of when it is allowed to move itself.
 *
 * It places itself when the rider opens something new to read — a line, or a trip pinned on it —
 * and never again. Walking along the line to another of its stops is not opening anything: the
 * rows the rider tapped are the rows they are still reading, so the list stays exactly where it
 * was and the only thing that changes is which row is marked as theirs. That mark travelling
 * between two rows the rider can both see is the whole of what that navigation looks like, and it
 * is why the stop is deliberately no part of the key here.
 *
 * What it places itself on is what was opened. A pinned trip is a vehicle somewhere on the line,
 * and where that vehicle is is the thing the rider chose it to see; the stop they would board at
 * is a row they already had in view. Without a pinned trip there is no vehicle to stand on and the
 * rider's own stop is the reading, so the same effect falls back to it — which is also what a line
 * opened at a stop lands on.
 *
 * Opening arrives already placed: there is no previous reading to travel from, and an animation
 * would only make the rider wait to see where they are. Pinning a trip on a line already open does
 * have a previous position, and gliding between the two rows is what says the two readings are of
 * one line. A different stop chain — another line, the other direction, a variant calling
 * elsewhere — is not a move within anything, so it is placed rather than travelled to, the same
 * reasoning that remounts the vehicle layer on that key. Between all of these every scroll belongs
 * to the rider: live data and clock ticks never move the list. Vehicle marks are measured and move
 * independently, so they are deliberately no part of this.
 */
export function useStopPlacement({
  placementKey,
  chainKey,
  containerRef,
}: {
  /** The line or the trip being read, never the stop — see above. `null` places nothing. */
  placementKey: string | null;
  /** The stop chain the placement is made in; travelling only happens within one of these. */
  chainKey: string;
  containerRef: React.RefObject<HTMLDivElement | null>;
}) {
  const placedRef = useRef<{ key: string; chainKey: string } | null>(null);

  // The row placed on can arrive after the line or trip sequence, and a pinned trip's vehicle can
  // arrive after both. Do not consume the placement until one of them exists; after that, live data
  // and clock ticks cannot move the list again — including the mark itself, which keeps moving.
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!placementKey || !container) {
      placedRef.current = null;
      return;
    }
    const placed = placedRef.current;
    if (placed?.key === placementKey && placed.chainKey === chainKey) return;

    const stopRow =
      container.querySelector<HTMLElement>('[data-trip-position-anchor="true"]') ??
      container.querySelector<HTMLElement>('[data-current-stop="true"]');
    if (!stopRow) return;
    if (placed?.chainKey === chainKey) {
      scrollIntoView(stopRow, { block: "center" });
    } else {
      stopRow.scrollIntoView({ block: "center", inline: "nearest", behavior: "auto" });
    }
    placedRef.current = { key: placementKey, chainKey };
  });
}

/**
 * Whether the rider's own stop moved between two readings of one diagram.
 *
 * Walking along the line changes one thing on the screen and this is it: the note under a stop name
 * saying where the rider is. The diagram itself does not move — the rows they tapped are the rows
 * they are still reading (`useStopPlacement`) — so the note is the whole of what that navigation
 * looks like, and the one question here is whether it has a previous place in this diagram to move
 * from, or is simply where it is. Derived while rendering rather than in an effect, for the same
 * reason the dashboard derives which of its halves changed: the answer has to be on the element in
 * the commit that mounts the note, or the motion it orders would already be a frame under way.
 *
 * A different stop chain is not a move within anything — the rows themselves are not the same rows —
 * and neither is a marker that was not on the diagram at all. Both say the note is simply where it
 * is.
 */
export type CurrentStopMove = "travelled" | undefined;

/** Where the rider's own stop stood, in the chain it stood in. `-1` is a diagram not marking one. */
export type CurrentStopPlace = { index: number; chainKey: string };

/**
 * Whether two of those are two places of one note. Separated from the hook because it is a fact
 * about two readings and not about React: the same chain and two different rows on it is one note
 * that moved.
 */
export function describeCurrentStopMove(
  previous: CurrentStopPlace,
  next: CurrentStopPlace,
): CurrentStopMove {
  if (previous.chainKey !== next.chainKey) return undefined;
  if (previous.index < 0 || next.index < 0 || previous.index === next.index) return undefined;
  return "travelled";
}

export function useCurrentStopMove(currentStopIndex: number, chainKey: string): CurrentStopMove {
  const [previous, setPrevious] = useState<CurrentStopPlace & { move: CurrentStopMove }>({
    index: currentStopIndex,
    chainKey,
    move: undefined,
  });

  if (previous.index === currentStopIndex && previous.chainKey === chainKey) return previous.move;

  const next = { index: currentStopIndex, chainKey };
  const move = describeCurrentStopMove(previous, next);
  setPrevious({ ...next, move });
  return move;
}

/**
 * The trip the diagram is drawn from, held across the moment another stop's board is being read.
 *
 * Walking along a line re-addresses the stop, and every board behind the trip is keyed by that
 * stop: for the few hundred milliseconds it takes them to answer, the feed has nothing to say about
 * a trip the rider has not stopped reading. Letting the diagram believe that is what made a step
 * between two stops of one line look like a navigation — the call times leave every row, the drawn
 * trip falls back to whichever one of the line the boards can still see, and the stop chain those
 * rows are is replaced under a scroll position measured against the old one.
 *
 * So the trip is held for as long as the address names it. This retains a reading, never a level:
 * the moment the address stops naming the trip the hold is dropped with it, and a trip the boards
 * answer for and no longer contain is a trip that has genuinely gone. What is held is also exactly
 * what was already on the screen — no time is restated as fresher than it was read, because it is
 * the same reading, and the freshness the diagram states is read from it rather than from a board
 * that is momentarily absent.
 */
export type HeldTrip<T> = { tripId: string; departure: T } | null;

/**
 * The rule itself, as a fact about one reading rather than about React: draw the addressed trip's
 * last reading, and go on holding it for exactly as long as the address names that trip.
 */
export function holdAddressedTrip<T>(
  held: HeldTrip<T>,
  tripId: string | undefined,
  departure: T | undefined,
): { drawn: T | undefined; held: HeldTrip<T> } {
  // A diagram reading no trip holds nothing, so leaving one never leaves a hold behind for the next
  // trip that happens to be addressed to pick up.
  if (!tripId) return { drawn: departure, held: null };
  if (departure) return { drawn: departure, held: { tripId, departure } };
  const kept = held?.tripId === tripId ? held : null;
  return { drawn: kept?.departure, held: kept };
}

export function useRetainedDiagramTrip<T>(
  /** The trip the address names, which is what the hold belongs to. */
  tripId: string | undefined,
  departure: T | undefined,
): T | undefined {
  const [held, setHeld] = useState<HeldTrip<T>>(null);

  const next = holdAddressedTrip(held, tripId, departure);
  if (next.held?.tripId !== held?.tripId || next.held?.departure !== held?.departure) {
    setHeld(next.held);
  }
  return next.drawn;
}

/** A ride moves only when the rider explicitly asks to return to its position. */
export function useRequestedTripPosition(
  request: number,
  containerRef: React.RefObject<HTMLDivElement | null>,
) {
  const handledRequestRef = useRef(request);

  useLayoutEffect(() => {
    if (request === handledRequestRef.current) return;
    const anchor = containerRef.current?.querySelector<HTMLElement>(
      '[data-trip-position-anchor="true"]',
    );
    // A next-call row is normally available before the button can be pressed. If live data is in
    // the middle of replacing the sequence, leave the request pending and fulfil it next render.
    if (!anchor) return;
    anchor.scrollIntoView({ block: "center", inline: "nearest", behavior: "auto" });
    handledRequestRef.current = request;
  });
}

/** Whether the real first row has passed above its scrollport and needs a contextual stand-in. */
export function isTopTerminusPastViewport(rowBottom: number, viewportTop: number): boolean {
  return rowBottom <= viewportTop + 0.5;
}

/**
 * Reveals a summary after the real top terminus leaves the internal scrollport.
 *
 * The summary is an overlay, never another measured stop. IntersectionObserver watches one row at
 * the point where its visibility actually changes, replacing the old per-scroll scan of every row.
 */
export function useTopTerminusSummary({
  scrollContainerRef,
  enabled,
  coordinateKey,
}: {
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
  enabled: boolean;
  /** Reconnect when the stop chain beneath the persistent panel changes. */
  coordinateKey: string;
}): boolean {
  const [isShown, setIsShown] = useState(false);

  useLayoutEffect(() => {
    const scrollContainer = scrollContainerRef.current;
    const firstRow = scrollContainer?.querySelector<HTMLElement>(
      '.line-diagram-stop-list > [data-line-diagram-stop-index="0"]',
    );
    if (!enabled || !scrollContainer || !firstRow) {
      setIsShown(false);
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        const rootTop = entry.rootBounds?.top;
        setIsShown(
          rootTop !== undefined &&
            !entry.isIntersecting &&
            isTopTerminusPastViewport(entry.boundingClientRect.bottom, rootTop),
        );
      },
      { root: scrollContainer, threshold: 0 },
    );
    observer.observe(firstRow);
    return () => observer.disconnect();
  }, [coordinateKey, enabled, scrollContainerRef]);

  return enabled && isShown;
}

/**
 * The node centre in stop-list coordinates, without the visual translation applied by sticky UI.
 *
 * A node is anchored by its own centre: it is placed at a point on its track — the middle of an
 * ordinary row, either end of a fork's junction — and then pulled back over that point by half its
 * own size in each direction. That pull-back is a transform, so it never reaches layout, and the
 * offset measured here is already the centre. Adding half the node's height to it would push every
 * mark below the node it belongs to, by more the larger the node is: furthest at the rider's own
 * stop, which is exactly where a mark being off the node is most visible.
 */
export const getMeasuredNodeCenterOffset = (
  rowOffsetTop: number,
  trackOffsetTop: number,
  nodeOffsetTop: number,
): number => rowOffsetTop + trackOffsetTop + nodeOffsetTop;

/**
 * The real row centres the vehicle marks travel between, measured from the diagram's own layout.
 *
 * Markers live once in a continuous layer rather than once per stop row. Row centres are measured
 * because qualifiers, call times and the current-stop note can make row heights differ.
 * ResizeObserver runs only when layout changes; the one-second vehicle tick reuses this geometry.
 *
 * Measurement is a render behind the chain it measures, so between the two there is one render in
 * which the offsets in state belong to rows that are no longer on the screen. Nothing is returned
 * for it — a mark placed against another chain's rows is worse than no mark for one frame — and
 * that is settled here rather than at each call site, where two copies of the same guard is one
 * copy too many.
 */
export function useVehicleLayerGeometry({
  stopListRef,
  coordinateKey,
}: {
  stopListRef: React.RefObject<HTMLDivElement | null>;
  /** The stop chain the geometry belongs to; a different chain gets measured from scratch. */
  coordinateKey: string;
}): VehicleLayerGeometry {
  const [geometry, setGeometry] = useState(EMPTY_VEHICLE_LAYER_GEOMETRY);

  useLayoutEffect(() => {
    const stopList = stopListRef.current;
    if (!stopList) return;

    const stopRows = [...stopList.querySelectorAll<HTMLElement>("[data-line-diagram-stop-index]")];
    const measure = () => {
      const track = stopRows[0]?.querySelector<HTMLElement>(".line-diagram-track");
      const nextGeometry = {
        coordinateKey,
        // The node, not the row: wrapped names and call details make the row's own centre
        // incidental, while the node is the point the rail and marker actually meet.
        stopCenterOffsets: stopRows.map((row) => {
          const rowTrack = row.querySelector<HTMLElement>(".line-diagram-track");
          const node = rowTrack?.querySelector<HTMLElement>(".line-diagram-node");
          return rowTrack && node
            ? getMeasuredNodeCenterOffset(row.offsetTop, rowTrack.offsetTop, node.offsetTop)
            : row.offsetTop + row.offsetHeight / 2;
        }),
        trackLeft: track?.offsetLeft ?? 0,
      };
      setGeometry((current) =>
        current.coordinateKey === nextGeometry.coordinateKey &&
        current.trackLeft === nextGeometry.trackLeft &&
        current.stopCenterOffsets.length === nextGeometry.stopCenterOffsets.length &&
        current.stopCenterOffsets.every(
          (stopCenterOffset, index) => stopCenterOffset === nextGeometry.stopCenterOffsets[index],
        )
          ? current
          : nextGeometry,
      );
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(stopList);
    stopRows.forEach((row) => observer.observe(row));
    return () => observer.disconnect();
  }, [coordinateKey, stopListRef]);

  return geometry.coordinateKey === coordinateKey ? geometry : EMPTY_VEHICLE_LAYER_GEOMETRY;
}
