import { memo } from "react";
import type { LineDiagramStop } from "../../lib/line-diagram";
import { getInterchangeLabel } from "../../lib/line-diagram";
import { getTripCallTimeReading } from "../../lib/departure-presentation";
import { classNames } from "../../lib/class-names";
import type { CoveredStopSpan } from "./layout";

const COMPACT_INTERCHANGE_PREVIEW_LIMIT = 2;
/** Markers are capped because they signal covered stops; the spoken label carries the exact count. */
const COVERED_STOP_MARKER_LIMIT = 3;

const formatCoveredStopCount = (count: number) => `${count} ${count === 1 ? "Halt" : "Halte"}`;

function InterchangeTokens({ interchanges }: { interchanges: LineDiagramStop["interchanges"] }) {
  return interchanges.map((interchangeLine) => (
    <span key={interchangeLine.id} className="line-diagram-interchange">
      {interchangeLine.id}
    </span>
  ));
}

function LineDiagramStopRowView({
  diagramStop,
  index,
  currentStopIndex,
  vehicleLabel,
  isFirst,
  isLast,
  coveredStopSpan,
  isSelectedTrip,
  isAlighting,
  isTripPositionAnchor,
  onActivate,
  feedNow,
}: {
  diagramStop: LineDiagramStop;
  index: number;
  currentStopIndex: number;
  /** What the marks standing on this row are, spoken. Empty where none is. */
  vehicleLabel: string;
  isFirst: boolean;
  isLast: boolean;
  /** Set on a terminus once the diagram scrolls: the strip it reserves for the span it covers. */
  coveredStopSpan: CoveredStopSpan | null;
  isSelectedTrip: boolean;
  /** This row is the Ausstieg the rider marked. */
  isAlighting: boolean;
  /** The stable stop row nearest the selected vehicle, or its next call before a mark is available. */
  isTripPositionAnchor: boolean;
  /** What the row does: open the stop, or mark it as the Ausstieg while the rider is on board. */
  onActivate: { kind: "open" | "mark"; run: (stopId: string) => void };
  /** The feed's clock, which is what the call times are read against. */
  feedNow: number;
}) {
  const { stopName, placeName, interchanges, stopId } = diagramStop;
  const isCurrent = index === currentStopIndex;
  // Only a chosen trip has times to state. Without one the diagram describes the whole line, and
  // the times of whichever trip happens to be drawn would read as the line's own.
  const callTime = isSelectedTrip
    ? getTripCallTimeReading(diagramStop.tripCall, feedNow)
    : undefined;
  const label = [
    // Spoken as one address, so a stop out of town is never read as the one of the same name here.
    placeName ? `${stopName}, ${placeName}` : stopName,
    ...(callTime ? [callTime.accessibilityLabel] : []),
    ...(isCurrent ? [isSelectedTrip ? "Einstieg" : "aktueller Halt"] : []),
    ...(isAlighting ? ["dein Ausstieg"] : []),
    ...(vehicleLabel ? [vehicleLabel] : []),
  ].join(", ");
  const interchangeLabel = getInterchangeLabel(interchanges);
  const compactInterchanges = interchanges.slice(0, COMPACT_INTERCHANGE_PREVIEW_LIMIT);
  const additionalInterchangeCount = interchanges.length - compactInterchanges.length;

  return (
    <div
      className={classNames(
        "line-diagram-stop",
        callTime?.isPast && "past-call",
        isCurrent && "current",
        isAlighting && "line-diagram-alighting",
        isFirst && "terminus-start",
        isLast && "terminus-end",
        coveredStopSpan && "has-covered-stop-span",
        coveredStopSpan && coveredStopSpan.count > 0 && "has-covered-stops",
      )}
      data-current-stop={isCurrent || undefined}
      data-trip-position-anchor={isTripPositionAnchor || undefined}
      data-line-diagram-stop-index={index}
      aria-current={isCurrent ? "location" : undefined}
    >
      <span className="line-diagram-track" aria-hidden="true">
        <i className="line-diagram-node" />
      </span>
      <button
        type="button"
        className="line-diagram-stop-action"
        aria-pressed={onActivate.kind === "mark" ? isAlighting : undefined}
        onClick={() => onActivate.run(stopId)}
        aria-label={
          onActivate.kind === "mark"
            ? `${label}, ${isAlighting ? "Ausstieg aufheben" : "als Ausstieg merken"}`
            : `${label}, Abfahrten ${isSelectedTrip ? "mit dieser Fahrt " : ""}öffnen`
        }
      >
        <span className="line-diagram-stop-name">
          {placeName && <small className="line-diagram-stop-place">{placeName}</small>}
          <strong>{stopName}</strong>
          {/* The one thing that moves when the rider walks along the line, which is why it is
              named: it travels from the row they were on to the row they tapped. */}
          {isCurrent && (
            <small className="line-diagram-current-note">
              {isSelectedTrip ? "Einstieg" : "Aktueller Halt"}
            </small>
          )}
          {isAlighting && <small className="line-diagram-alighting-note">Ausstieg</small>}
        </span>
        {callTime && (
          /* When the trip is due here, with the schedule struck beneath it where a deviation moved
             it — the same reading the departure board gives, so the two never disagree. A call
             running to time needs no second line at all. */
          <span className="line-diagram-call-time" aria-hidden="true">
            <strong className={callTime.punctuality}>{callTime.expectedTime}</strong>
            {callTime.scheduledTime && <s>{callTime.scheduledTime}</s>}
          </span>
        )}
      </button>

      {interchanges.length > 0 && (
        <>
          <span
            className="line-diagram-interchanges-full"
            role="note"
            aria-label={interchangeLabel}
          >
            <small>Umstieg</small>
            <span className="line-diagram-interchange-list" aria-hidden="true">
              <InterchangeTokens interchanges={interchanges} />
            </span>
          </span>
          {additionalInterchangeCount > 0 ? (
            <details className="line-diagram-interchanges-compact">
              <summary aria-label={interchangeLabel}>
                <small>Umstieg</small>
                <span className="line-diagram-interchange-list" aria-hidden="true">
                  <InterchangeTokens interchanges={compactInterchanges} />
                </span>
                <b aria-hidden="true">+{additionalInterchangeCount}</b>
                <i aria-hidden="true">⌄</i>
              </summary>
              <span className="line-diagram-interchange-list" aria-hidden="true">
                <InterchangeTokens interchanges={interchanges} />
              </span>
            </details>
          ) : (
            <span
              className="line-diagram-interchanges-compact line-diagram-interchanges-compact-static"
              role="note"
              aria-label={interchangeLabel}
            >
              <small>Umstieg</small>
              <span className="line-diagram-interchange-list" aria-hidden="true">
                <InterchangeTokens interchanges={compactInterchanges} />
              </span>
            </span>
          )}
        </>
      )}

      {/* The pinned terminus stands in for the stops behind it rather than pointing at them: the
          track carries on past the node, and every stop out of reach puts a dot on it. The strip is
          reserved for as long as the diagram scrolls, so filling and emptying it never moves a row
          under the reader — and never feeds a height back into the count that measures it. */}
      {coveredStopSpan && (
        <span
          className="line-diagram-covered-stop-span"
          role={coveredStopSpan.count > 0 ? "note" : undefined}
          aria-label={
            coveredStopSpan.count > 0
              ? `${formatCoveredStopCount(coveredStopSpan.count)} ${
                  coveredStopSpan.direction === "above" ? "oberhalb" : "unterhalb"
                }`
              : undefined
          }
        >
          <span className="line-diagram-covered-stop-span-track" aria-hidden="true">
            {Array.from(
              { length: Math.min(coveredStopSpan.count, COVERED_STOP_MARKER_LIMIT) },
              (_, markerIndex) => (
                <i key={markerIndex} />
              ),
            )}
          </span>
        </span>
      )}
    </div>
  );
}

/**
 * Rows read a coarser clock than the marks do, so a vehicle's second-by-second travel re-renders
 * the layer it lives in and nothing else. A call time reads in whole minutes, and everything else
 * on a row changes only when the board does.
 */
export const LineDiagramStopRow = memo(LineDiagramStopRowView);
