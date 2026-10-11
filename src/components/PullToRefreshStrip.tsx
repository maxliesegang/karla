/** What each pull says while it reads, the same in a panel and on the page. */
export const BOARD_REFRESH_LABEL = "Abfahrten werden aktualisiert …";
export const NEARBY_REFRESH_LABEL = "Standort wird bestimmt …";
export const getLineRefreshLabel = (isRide: boolean) =>
  isRide ? "Fahrt wird aktualisiert …" : "Fahrten werden aktualisiert …";

/** The strip a pull grows above its list; `usePullToRefresh` draws it through the DOM. */
export function PullToRefreshStrip({
  stripRef,
  busyLabel,
}: {
  stripRef: React.RefObject<HTMLDivElement | null>;
  /** What is being read again, said while the refresh runs. */
  busyLabel: string;
}) {
  return (
    <div ref={stripRef} className="pull-refresh" role="status">
      <div className="pull-refresh-inner">
        <span className="pull-refresh-label" data-pull="hint">
          Zum Aktualisieren ziehen
        </span>
        <span className="pull-refresh-label" data-pull="ready">
          Loslassen zum Aktualisieren
        </span>
        <span className="pull-refresh-label" data-pull="busy">
          {busyLabel}
        </span>
      </div>
    </div>
  );
}
