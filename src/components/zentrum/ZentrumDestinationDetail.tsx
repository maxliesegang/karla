import type { DepartureBoard } from "../../data/transit-types";
import { formatClockTime, getStaleBoardLabel } from "../../lib/departure-presentation";
import { formatPlatformLabel } from "../../lib/platform-naming";
import {
  type ZentrumTravelTime,
  getMinutesUntilDeparture,
  getRideMinutes,
} from "../../lib/zentrum-schematic-overlays";
import {
  findZentrumBoardingDeparture,
  getZentrumBoardingPlatformLabel,
  getZentrumTravelSourceLabel,
} from "../../lib/zentrum-presentation";
import { getDepartureAddressId, routePaths } from "../../routing";
import { LineBadge } from "../LineBadge";
import type { ZentrumLineSignReader } from "./line-sign";
import type { ZentrumReachableStop } from "../../lib/zentrum-stop-view";

/** How many of a line's next rides a row lists. */
const RIDES_PER_LINE = 3;

/** The rides grouped by line, the soonest line first. */
const groupRidesByLine = (rides: readonly ZentrumTravelTime[]) => {
  const ridesByLineId = new Map<string, ZentrumTravelTime[]>();
  for (const ride of rides) {
    const lineRides = ridesByLineId.get(ride.lineId) ?? [];
    ridesByLineId.set(ride.lineId, [...lineRides, ride]);
  }
  return [...ridesByLineId];
};

export function ZentrumDestinationDetail({
  originStopId,
  originStopLabel,
  reachableStop,
  rides,
  board,
  feedNow,
  getSign,
  onClose,
  onSelectStop,
}: {
  originStopId: string;
  originStopLabel: string;
  reachableStop: ZentrumReachableStop;
  /** Every direct ride there, soonest departure first. */
  rides: readonly ZentrumTravelTime[];
  board: DepartureBoard | null;
  feedNow: number;
  getSign: ZentrumLineSignReader;
  onClose: () => void;
  onSelectStop: (stopId: string) => void;
}) {
  const boardingDeparture = findZentrumBoardingDeparture(board, reachableStop);
  const boardingPlatformLabel = boardingDeparture
    ? formatPlatformLabel(
        boardingDeparture.platformCode,
        boardingDeparture.platformKind,
        "unbekannt",
      )
    : getZentrumBoardingPlatformLabel(reachableStop.boardingCall);
  const staleBoardLabel = getStaleBoardLabel(board, feedNow);
  return (
    <aside
      className="zentrum-panel"
      data-entrance-motion="rise"
      aria-label={`Direkt nach ${reachableStop.label}`}
    >
      <div className="zentrum-panel-heading">
        <LineBadge line={getSign(reachableStop.lineId)} size="sm" />
        <h2>{reachableStop.label}</h2>
        <button
          type="button"
          className="zentrum-panel-close"
          aria-label={`Zurück zu ${originStopLabel}`}
          onClick={onClose}
        >
          ×
        </button>
      </div>
      <div className="zentrum-panel-list">
        <p className="zentrum-destination-direction">
          Richtung {(boardingDeparture ?? reachableStop.departure).destination}
        </p>
        <ol className="zentrum-panel-calls zentrum-destination-calls">
          <li>
            <span>
              {originStopLabel}
              <small>{boardingPlatformLabel}</small>
            </span>
            <b>{formatClockTime(new Date(reachableStop.departsAt))}</b>
          </li>
          <li>
            <span>{reachableStop.label}</span>
            <b>{formatClockTime(new Date(reachableStop.arrivesAt))}</b>
          </li>
        </ol>
        <p className="zentrum-panel-note">Direkt · {getZentrumTravelSourceLabel(reachableStop)}</p>
        {rides.length > 1 && (
          <ul
            className="zentrum-destination-rides"
            aria-label={`Direkt nach ${reachableStop.label}`}
          >
            {groupRidesByLine(rides).map(([lineId, lineRides]) => {
              const waits = lineRides
                .slice(0, RIDES_PER_LINE)
                .map((ride) => getMinutesUntilDeparture(ride.departsAt, feedNow));
              return (
                <li key={lineId}>
                  <LineBadge line={getSign(lineId)} size="sm" />
                  <span>{getRideMinutes(lineRides[0])} min Fahrt</span>
                  <b>{waits.map((wait) => (wait <= 0 ? "jetzt" : wait)).join(" · ")} min</b>
                </li>
              );
            })}
          </ul>
        )}
        {boardingDeparture?.serviceNote && (
          <p className="zentrum-boarding-note">{boardingDeparture.serviceNote}</p>
        )}
        {staleBoardLabel && <p className="zentrum-panel-note">{staleBoardLabel}</p>}
      </div>
      <a
        className="zentrum-panel-link"
        href={`#${routePaths.ride(getDepartureAddressId(reachableStop.departure), originStopId, reachableStop.nodeId)}`}
      >
        Diese Fahrt öffnen →
      </a>
      <button
        className="zentrum-destination-action"
        type="button"
        onClick={() => onSelectStop(reachableStop.nodeId)}
      >
        Ab {reachableStop.label} lesen
      </button>
    </aside>
  );
}
