import type { DepartureBoardCoverage } from "../data/transit-types";

/** What a view calls the thing it has nothing of yet, in the three states it can be in. */
export type ObservationEmptyLabels = {
  /** While the observation has not answered at all. */
  loading: string;
  /** Where it could not be read. */
  unavailable: string;
  /** Where it answered and named nothing — which is a reading, not a failure. */
  empty: string;
};

/**
 * What a view reading the observation says while it has nothing to show.
 *
 * The three states are one statement each, and which of them a view is in is a fact about the
 * coverage rather than about the view — so the branch, and the one sentence that explains a failed
 * reading, are said here once. Each view brings its own nouns, because *keine Linien* and *keine
 * Fahrten* are different things not to have.
 */
export function ObservationEmptyState({
  coverage,
  labels,
}: {
  coverage: DepartureBoardCoverage;
  labels: ObservationEmptyLabels;
}) {
  return (
    <div className="panel-empty">
      {coverage.status === "loading" ? (
        <strong>{labels.loading}</strong>
      ) : coverage.status === "unavailable" ? (
        <>
          <strong>{labels.unavailable}</strong>
          <span>Der KVV-Feed konnte nicht gelesen werden.</span>
        </>
      ) : (
        <strong>{labels.empty}</strong>
      )}
    </div>
  );
}
