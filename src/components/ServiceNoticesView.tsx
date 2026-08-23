import { useMemo } from "react";
import type { ServiceNoticeBoard, TransitNetwork } from "../data/transit-types";
import { findNoticesInNetwork } from "../lib/service-notices";
import { ServiceNoticePanel } from "./ServiceNoticePanel";

/** The one place where the operator's published notices are listed in full. */
export function ServiceNoticesView({
  network,
  noticeBoard,
  feedNow,
}: {
  network: TransitNetwork;
  noticeBoard: ServiceNoticeBoard | null;
  feedNow: number;
}) {
  const notices = useMemo(
    () =>
      noticeBoard
        ? findNoticesInNetwork(
            noticeBoard.notices,
            network.lines,
            network.stops.map((stop) => stop.id),
          )
        : [],
    [network.lines, network.stops, noticeBoard],
  );

  return (
    <section className="service-notices-view" aria-labelledby="service-notices-title">
      <div className="panel-heading">
        <h1 id="service-notices-title">Meldungen des KVV</h1>
      </div>
      <ServiceNoticePanel
        noticeBoard={noticeBoard}
        notices={notices}
        lines={network.lines}
        feedNow={feedNow}
        emptyLabel="Keine Meldungen für das KARLA-Netz"
      />
    </section>
  );
}
