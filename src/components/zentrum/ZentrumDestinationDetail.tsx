import type { DepartureBoard } from "../../data/transit-types";
import { formatClockTime, getStaleBoardLabel } from "../../lib/departure-presentation";
import { formatPlatformLabel } from "../../lib/platform-naming";
import {
  findZentrumBoardingDeparture,
  getZentrumBoardingPlatformLabel,
  getZentrumTravelSourceLabel,
} from "../../lib/zentrum-presentation";
import { getDepartureAddressId, routePaths } from "../../routing";
import { LineBadge } from "../LineBadge";
import type { ZentrumLineSignReader } from "./line-sign";
import type { ZentrumReachableStop } from "../../lib/zentrum-stop-view";

export function ZentrumDestinationDetail({
  originStopId,
  originStopLabel,
  reachableStop,
  board,
  feedNow,
  getSign,
  onClose,
  onSelectStop,
}: {
  originStopId: string;
  originStopLabel: string;
  reachableStop: ZentrumReachableStop;
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
