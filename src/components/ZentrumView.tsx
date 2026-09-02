import { useMemo } from "react";
import { createLineSign } from "../data/line-signs";
import type { DepartureBoardCoverage } from "../data/transit-types";
import { type ObservedNetwork } from "../lib/observed-network";
import { compareLineIds } from "../lib/line-families";
import { navigateTo, routePaths } from "../routing";
import { LineBadge } from "./LineBadge";

export function ZentrumView({
  network,
  coverage,
}: {
  network: ObservedNetwork;
  /** How many of the Zentrum's observation posts this reading rests on. */
  coverage: DepartureBoardCoverage;
}) {
  // The feed states each line's mode, and the badge needs it for the lines that have no verified sign.
  const signByLineId = useMemo(
    () =>
      new Map(network.lines.map((line) => [line.id, createLineSign(line.id, line.transportMode)])),
    [network.lines],
  );
  // The observation only knows a stop exists once a trip called there, so the list is what is
  // running through the Zentrum right now. By name, because that is the one order a rider does not
  // have to be taught and the only one that holds still while the boards refresh; each stop's signs
  // are resolved here so the row neither sorts nor looks them up twice.
  const stops = useMemo(
    () =>
      [...network.stops]
        .sort((a, b) => a.name.localeCompare(b.name, "de"))
        .map((stop) => ({
          ...stop,
          lines: [...stop.lineIds]
            .sort(compareLineIds)
            .map((lineId) => signByLineId.get(lineId) ?? createLineSign(lineId, "other")),
        })),
    [network.stops, signByLineId],
  );

  return (
    <>
      <div className="panel-heading">
        <div className="stop-title">
          <h1>Zentrum</h1>
        </div>
      </div>

      {stops.length > 0 ? (
        <div className="zentrum-stops-scroll">
          <section className="zentrum-stops" aria-label="Haltestellen im Zentrum">
            {stops.map((stop) => (
              <button
                key={stop.id}
                onClick={() => navigateTo(routePaths.stop(stop.id))}
                aria-label={`${stop.name}, Linien ${stop.lines.map((line) => line.id).join(", ")}. Haltestelle öffnen`}
              >
                <span className="zentrum-stop-name">{stop.name}</span>
                <span className="zentrum-stop-lines">
                  {stop.lines.map((line) => (
                    <LineBadge key={line.id} line={line} size="xs" />
                  ))}
                </span>
              </button>
            ))}
          </section>
        </div>
      ) : coverage.status === "loading" ? (
        <div className="panel-empty">
          <strong>Haltestellen werden geladen …</strong>
        </div>
      ) : coverage.status === "unavailable" ? (
        <div className="panel-empty">
          <strong>Zentrum derzeit nicht abrufbar</strong>
          <span>Der KVV-Feed konnte nicht gelesen werden.</span>
        </div>
      ) : (
        <div className="panel-empty">
          <strong>Derzeit keine Fahrten beobachtet</strong>
        </div>
      )}
    </>
  );
}
