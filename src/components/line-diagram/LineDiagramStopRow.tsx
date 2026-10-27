import { memo } from "react";
import { formatBayTexts, type LineDiagramStop } from "../../lib/line-diagram";
import { getCallTimeReading } from "../../lib/stop-event-presentation";
import { classNames } from "../../lib/class-names";

function LineDiagramStopRowView({
  diagramStop,
  index,
  isCurrent,
  vehicleLabel,
  isFirst,
  isLast,
  isSelectedStopEvent,
  isAlighting,
  isDatedJourneyPositionAnchor,
  onActivate,
  feedNow,
}: {
  diagramStop: LineDiagramStop;
  index: number;
  /** This row is one occurrence of the stop the rider has open. */
  isCurrent: boolean;
  /** The marks standing on this row, spoken; empty if none. */
  vehicleLabel: string;
  isFirst: boolean;
  isLast: boolean;
  isSelectedStopEvent: boolean;
  /** This row is the Ausstieg the rider marked. */
  isAlighting: boolean;
  /** The row nearest the selected vehicle, or its next call before a mark exists. */
  isDatedJourneyPositionAnchor: boolean;
  /** Open the stop, or on a ride mark it as the Ausstieg. */
  onActivate: { kind: "open" | "mark"; run: (stopId: string) => void };
  /** The feed's clock, for call times. */
  feedNow: number;
}) {
  const { stopName, placeName, bayTexts, stopId } = diagramStop;
  // Only a chosen journey states times; otherwise they would read as the line's own.
  const callTime = isSelectedStopEvent ? getCallTimeReading(diagramStop.call, feedNow) : undefined;
  const label = [
    // Spoken with its place, so an out-of-town stop is not mistaken for a local namesake.
    placeName ? `${stopName}, ${placeName}` : stopName,
    ...(bayTexts ?? []),
    ...(callTime ? [callTime.accessibilityLabel] : []),
    ...(isCurrent ? [isSelectedStopEvent ? "Fahrt hier ausgewählt" : "aktueller Halt"] : []),
    ...(isAlighting ? ["dein Ausstieg"] : []),
    ...(vehicleLabel ? [vehicleLabel] : []),
  ].join(", ");

  return (
    <div
      className={classNames(
        "line-diagram-stop",
        callTime?.isPast && "past-call",
        isCurrent && "current",
        isAlighting && "line-diagram-alighting",
        isFirst && "terminus-start",
        isLast && "terminus-end",
      )}
      data-current-stop={isCurrent || undefined}
      data-journey-position-anchor={isDatedJourneyPositionAnchor || undefined}
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
            : `${label}, Abfahrten ${isSelectedStopEvent ? "mit dieser Fahrt " : ""}öffnen`
        }
      >
        <span className="line-diagram-stop-name">
          {placeName && <small className="line-diagram-stop-place">{placeName}</small>}
          <strong>{stopName}</strong>
          {/* Two rows of one stop: which one this is. */}
          {bayTexts && bayTexts.length > 0 && (
            <small className="line-diagram-stop-platform" aria-hidden="true">
              {formatBayTexts(bayTexts)}
            </small>
          )}
          {/* The rider's stop note; it moves from the previous row to the tapped one. */}
          {isCurrent && (
            <small className="line-diagram-current-note">
              {isSelectedStopEvent ? "Ausgewählt" : "Aktueller Halt"}
            </small>
          )}
          {isAlighting && <small className="line-diagram-alighting-note">Ausstieg</small>}
        </span>
        {callTime && (
          /* The call time, with the struck schedule where moved, as on the board. */
          <span className="line-diagram-call-time" aria-hidden="true">
            <strong className={callTime.punctuality}>{callTime.expectedTime}</strong>
            {callTime.timetabledTime && <s>{callTime.timetabledTime}</s>}
          </span>
        )}
      </button>
    </div>
  );
}

/** Rows use a coarse clock, so mark movement re-renders only the vehicle layer. */
export const LineDiagramStopRow = memo(LineDiagramStopRowView);
