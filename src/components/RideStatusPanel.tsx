import type { Departure, TransitLine } from "../data/transit-types";
import type { RidePositionController } from "../hooks/ride-position";
import {
  formatClockTime,
  getRideCountdownSourceLabel,
  getTripCallTimeReading,
} from "../lib/departure-presentation";
import type { RideProgress } from "../lib/ride-progress";
import { classNames } from "../lib/class-names";
import { LineBadge } from "./LineBadge";

/**
 * The ride card, always in view: the next stop as a countdown, and the Ausstieg with its stop
 * count. It says whether the countdown comes from the rider's position or the feed's estimate, and
 * once boards stop listing the trip, that it shows the last observation and when it was taken.
 */
export function RideStatusPanel({
  line,
  departure,
  rideProgress,
  feedNow,
  isRetainedObservation,
  observedAt,
  ridePosition,
  onClearAlighting,
  onShowPosition,
  onEndRide,
}: {
  line: TransitLine;
  departure: Departure;
  rideProgress: RideProgress;
  feedNow: number;
  /** Boards no longer carry the trip; this is its last reading. */
  isRetainedObservation: boolean;
  observedAt: number;
  /** The device's position reading, and the way to grant it. */
  ridePosition: RidePositionController;
  onClearAlighting?: () => void;
  /** Shows the trip's position in the line diagram. */
  onShowPosition: () => void;
  onEndRide: () => void;
}) {
  const {
    nextCall,
    minutesToNextCall,
    alightingCall,
    stopsToAlighting,
    isAlightingNext,
    isFinished,
    finalCall,
  } = rideProgress;
  const alightingCallTime = alightingCall && getTripCallTimeReading(alightingCall, feedNow);
  const nextCallTime = nextCall && getTripCallTimeReading(nextCall, feedNow);
  const countdownSourceLabel = getRideCountdownSourceLabel(rideProgress, nextCallTime);

  if (isFinished) {
    return (
      <section className="ride-status ride-status-ended" aria-label="Fahrt beendet">
        <div className="ride-status-line">
          <LineBadge line={line} />
          <h1 className="ride-status-destination">Fahrt beendet</h1>
        </div>
        <p className="ride-status-primary">{finalCall?.stopName ?? departure.destination}</p>
        <button type="button" className="ride-status-action" onClick={onEndRide}>
          Abfahrten hier
        </button>
      </section>
    );
  }

  return (
    <section
      className={classNames("ride-status", isAlightingNext && "ride-status-alighting-next")}
      aria-label={`Fahrt ${line.id} Richtung ${departure.destination}`}
      aria-live="polite"
    >
      <div className="ride-status-line">
        <LineBadge line={line} />
        <h1 className="ride-status-destination">{departure.destination}</h1>
        <button
          type="button"
          className="ride-status-end"
          onClick={onEndRide}
          aria-label="Fahrt beenden"
        >
          Beenden
        </button>
      </div>

      {nextCall && (
        <div className="ride-status-next">
          <small>{isAlightingNext ? "Nächster Halt · dein Ausstieg" : "Nächster Halt"}</small>
          <p className="ride-status-primary">{nextCall.stopName}</p>
          <p className="ride-status-timing">
            {minutesToNextCall === undefined
              ? "ohne Zeitangabe"
              : minutesToNextCall <= 0
                ? "jetzt"
                : `in ${minutesToNextCall} min`}
            {/* The clock time the countdown lands on, and the struck schedule. */}
            {nextCallTime && (
              <>
                <span
                  className={classNames("ride-status-call-time", nextCallTime.punctuality)}
                  aria-hidden="true"
                >
                  an {nextCallTime.expectedTime}
                  {nextCallTime.scheduledTime && <s>{nextCallTime.scheduledTime}</s>}
                </span>
                <span className="ride-status-sr">{nextCallTime.accessibilityLabel}</span>
              </>
            )}
          </p>
          <p className="ride-status-source">{countdownSourceLabel}</p>
        </div>
      )}

      {alightingCall && !isAlightingNext && (
        <div className="ride-status-alighting">
          <span>
            <small>Ausstieg</small>
            <strong>{alightingCall.stopName}</strong>
          </span>
          <span className="ride-status-remaining">
            {stopsToAlighting === 1 ? "noch 1 Halt" : `noch ${stopsToAlighting} Halte`}
            {alightingCallTime && ` · ca. ${alightingCallTime.expectedTime}`}
          </span>
          {onClearAlighting && (
            <button
              type="button"
              onClick={onClearAlighting}
              aria-label={`Ausstieg ${alightingCall.stopName} aufheben`}
            >
              ×
            </button>
          )}
        </div>
      )}

      {/* Finding the trip on the line, and, until an Ausstieg is marked, how to mark one. */}
      <div className="ride-status-foot">
        <button type="button" className="ride-status-position" onClick={onShowPosition}>
          Position auf Linie
        </button>
        {ridePosition.canEnable && (
          <button type="button" className="ride-status-position" onClick={ridePosition.enable}>
            Standort nutzen
          </button>
        )}
        {!alightingCall && (
          <p className="ride-status-hint">Halt antippen, um den Ausstieg zu merken</p>
        )}
      </div>

      {/* The disclosure that the boards no longer list the trip. */}
      {/* Location denied or unanswered: the ride uses the feed's estimate and says so once. */}
      {ridePosition.message && (
        <p className="ride-status-note" role="status">
          {ridePosition.message}
        </p>
      )}

      {isRetainedObservation && (
        <p className="ride-status-retained" role="status">
          Letzte Beobachtung {formatClockTime(new Date(observedAt))}
        </p>
      )}
    </section>
  );
}
