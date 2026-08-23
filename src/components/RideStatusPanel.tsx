import type { Departure, TransitLine } from "../data/transit-types";
import type { RidePositionController } from "../hooks/ride-position";
import { formatClockTime, getTripCallTimeReading } from "../lib/departure-presentation";
import type { TripProgress } from "../lib/trip-progress";
import { classNames } from "../lib/class-names";
import { formatDistance } from "../lib/geo";
import { LineBadge } from "./LineBadge";

/**
 * What a rider on board is reading.
 *
 * One card, always in view, answering the only question the ride has: where am I going and when am
 * I there. It states the next stop as a countdown rather than a clock time — someone on a tram
 * counts stops and minutes, not timetable times — and keeps the marked Ausstieg beside it so the
 * rider does not have to hold the stop count themselves.
 *
 * It is also where the mode is honest about itself. The countdown is read from the rider's own
 * position where they have granted one, and from the feed's estimate where they have not or where
 * the fix cannot be placed — two different claims, so the card says which one it is making and
 * offers the better one where it is not yet in use.
 * A departure board only lists what has not left
 * yet, so a few minutes after boarding no board mentions this trip any more: the view then reads
 * the last observation of it, and says so with the time it was taken. Nothing is refreshed silently
 * and nothing claims to be live that is not.
 */
export function RideStatusPanel({
  line,
  departure,
  tripProgress,
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
  tripProgress: TripProgress;
  feedNow: number;
  /** The boards no longer carry this trip; what is shown is the last reading of it. */
  isRetainedObservation: boolean;
  observedAt: number;
  /** The device's own reading of where the rider is, and the way to grant it. */
  ridePosition: RidePositionController;
  onClearAlighting?: () => void;
  /** Brings the trip's best known position back into the line diagram. */
  onShowPosition: () => void;
  onEndRide: () => void;
}) {
  const {
    nextCall,
    minutesToNextCall,
    alightingCall,
    metersToNextCall,
    stopsToAlighting,
    isAlightingNext,
    isFinished,
    finalCall,
  } = tripProgress;
  const alightingCallTime = alightingCall && getTripCallTimeReading(alightingCall, feedNow);
  const nextCallTime = nextCall && getTripCallTimeReading(nextCall, feedNow);
  // Which of the two witnesses the countdown came from, and — where the device is the witness —
  // how much of the link is left. A rider deciding whether to stand up is entitled to know whether
  // the app can see where they are.
  const sourceLabel =
    tripProgress.source === "schedule"
      ? "geschätzt nach Fahrplan"
      : metersToNextCall === undefined
        ? "nach Standort"
        : `nach Standort · noch ${formatDistance(metersToNextCall)}`;

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
            {/* The countdown already carries the deviation, so a "+3" beside it read as three
                further minutes to add. What belongs here is the clock time that countdown lands on,
                and the schedule it was moved off — spoken in one sentence, struck beside it. */}
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
          <p className="ride-status-source">{sourceLabel}</p>
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

      {/* The two quiet actions share one row: finding the trip on the line, and — until an Ausstieg
          is marked, which is when it has done its job — how a stop becomes one. */}
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

      {/* The mode outlives the boards that found the trip; what it must never do is pretend it did
          not. This is the whole of that disclosure. */}
      {/* Told no, or told nothing: the ride keeps running on the feed's estimate and says so once,
          rather than asking again for something the browser has already answered. */}
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
