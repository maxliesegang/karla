import { navigateTo, routePaths } from "../routing";

/**
 * A stop is the one level with nothing beneath it, so it is the only genuine dead end. A provider
 * read that failed is not that dead end: nothing was learned about the stop, so the view says so
 * and offers the read again rather than claiming the stop does not exist.
 */
export function StopNotFoundView({
  isFailed,
  onRetry,
}: {
  isFailed: boolean;
  onRetry: () => void;
}) {
  return (
    <section className="not-found">
      {isFailed ? (
        <>
          <h1>Haltestelle nicht erreichbar</h1>
          <p>
            Diese Haltestelle ließ sich gerade nicht vom KVV-Feed lesen — ob es sie gibt, ist damit
            nicht gesagt. Ein erneuter Versuch kann helfen.
          </p>
          <div className="not-found-actions">
            <button onClick={onRetry}>Erneut versuchen</button>
            <button className="not-found-secondary" onClick={() => navigateTo(routePaths.home())}>
              Zur Startseite
            </button>
          </div>
        </>
      ) : (
        <>
          <h1>Haltestelle nicht gefunden</h1>
          <button onClick={() => navigateTo(routePaths.home())}>Zur Startseite</button>
        </>
      )}
    </section>
  );
}
