import type { DepartureBoardCoverage } from "../data/transit-types";

/** A view's nouns for the three empty states. */
export type ObservationEmptyStateLabels = {
  /** No answer yet. */
  loading: string;
  /** Could not be read. */
  unavailable: string;
  /** Answered with nothing, which is a reading, not a failure. */
  empty: string;
};

/** The empty state for a view reading the observation; which state comes from coverage. */
export function ObservationEmptyState({
  coverage,
  labels,
}: {
  coverage: DepartureBoardCoverage;
  labels: ObservationEmptyStateLabels;
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
