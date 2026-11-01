import { useRef, useState } from "react";
import { useStoredPreference } from "../hooks/stored-preference";
import {
  savedStops,
  withoutSavedStop,
  withSavedStopMoved,
  type SavedStop,
} from "../lib/saved-stops";

type RowDrag = {
  stopId: string;
  order: SavedStop[];
  /** The pointer's y where the row would sit untranslated. */
  originY: number;
  offsetY: number;
};

/**
 * Dragging a row by its handle: the row follows the pointer and swaps with a neighbour once past
 * half its height. The order is stored on release, so a cancelled drag changes nothing.
 */
function useRowDrag(saved: readonly SavedStop[]) {
  const [drag, setDrag] = useState<RowDrag | null>(null);
  const dragRef = useRef<RowDrag | null>(null);
  const rows = useRef(new Map<string, HTMLLIElement>());
  const update = (next: RowDrag | null) => {
    dragRef.current = next;
    setDrag(next);
  };

  const handleProps = (stopId: string) => ({
    onPointerDown: (event: React.PointerEvent<HTMLElement>) => {
      if (event.button !== 0) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      update({ stopId, order: [...saved], originY: event.clientY, offsetY: 0 });
    },
    onPointerMove: (event: React.PointerEvent<HTMLElement>) => {
      const current = dragRef.current;
      if (!current) return;
      let { order, originY } = current;
      const index = order.findIndex((stop) => stop.stopId === stopId);
      const offsetY = event.clientY - originY;
      const nextHeight = rows.current.get(order[index + 1]?.stopId ?? "")?.offsetHeight;
      const previousHeight = rows.current.get(order[index - 1]?.stopId ?? "")?.offsetHeight;
      if (nextHeight && offsetY > nextHeight / 2) {
        order = withSavedStopMoved(order, stopId, 1);
        originY += nextHeight;
      } else if (previousHeight && offsetY < -previousHeight / 2) {
        order = withSavedStopMoved(order, stopId, -1);
        originY -= previousHeight;
      }
      update({ ...current, order, originY, offsetY: event.clientY - originY });
    },
    onPointerUp: () => {
      if (dragRef.current) savedStops.write(dragRef.current.order);
      update(null);
    },
    onPointerCancel: () => update(null),
  });

  const rowRef = (stopId: string) => (row: HTMLLIElement | null) => {
    if (row) rows.current.set(stopId, row);
    else rows.current.delete(stopId);
  };

  return { drag, handleProps, rowRef };
}

/** The saved stops in their home order, to reorder or remove; applied immediately. */
export function SavedStopsView() {
  const saved = useStoredPreference(savedStops);
  const { drag, handleProps, rowRef } = useRowDrag(saved);
  const shown = drag?.order ?? saved;

  return (
    <section className="settings-view saved-stops-view" aria-labelledby="saved-stops-title">
      <div className="panel-heading">
        <h1 id="saved-stops-title">Gemerkte Haltestellen</h1>
      </div>
      {saved.length === 0 ? (
        <p className="settings-footnote">
          Noch keine Haltestelle gemerkt. Mit ☆ an einer Haltestelle kommt sie auf die Startseite.
        </p>
      ) : (
        <>
          <ul className="settings-list">
            {shown.map((stop) => {
              const isDragged = drag?.stopId === stop.stopId;
              return (
                <li
                  key={stop.stopId}
                  ref={rowRef(stop.stopId)}
                  className={`settings-row saved-stop-row${isDragged ? " is-dragged" : ""}`}
                  style={isDragged ? { transform: `translateY(${drag.offsetY}px)` } : undefined}
                >
                  <button
                    type="button"
                    className="saved-stop-handle"
                    aria-label={`${stop.stopName} verschieben`}
                    aria-keyshortcuts="ArrowUp ArrowDown"
                    title="Ziehen zum Verschieben"
                    onKeyDown={(event) => {
                      const step = { ArrowUp: -1, ArrowDown: 1 }[event.key] as -1 | 1 | undefined;
                      if (!step) return;
                      event.preventDefault();
                      savedStops.write(withSavedStopMoved(saved, stop.stopId, step));
                    }}
                    {...handleProps(stop.stopId)}
                  >
                    <svg viewBox="0 0 10 16" aria-hidden="true">
                      {[3, 8, 13].flatMap((y) =>
                        [2.5, 7.5].map((x) => <circle key={`${x}:${y}`} cx={x} cy={y} r="1.4" />),
                      )}
                    </svg>
                  </button>
                  <strong>{stop.stopName}</strong>
                  <button
                    type="button"
                    className="saved-stop-remove"
                    aria-label={`${stop.stopName} entfernen`}
                    onClick={() => savedStops.write(withoutSavedStop(saved, stop.stopId))}
                  >
                    <span aria-hidden="true">✕</span>
                  </button>
                </li>
              );
            })}
          </ul>
          <p className="settings-footnote">
            In dieser Reihenfolge stehen sie auf der Startseite und zuerst in der Suche. Zum
            Verschieben am Griff ziehen.
          </p>
        </>
      )}
    </section>
  );
}
