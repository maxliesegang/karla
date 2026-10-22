/** TRIAS replies in the shape KVV's server writes them (docs/kvv-trias-api.md), trimmed to the facts tested. */

const text = (value: string) =>
  `<trias:Text>${value}</trias:Text><trias:Language>de</trias:Language>`;

type ServiceTime = { timetabled: string; estimated?: string };

const serviceTime = (element: string, time: ServiceTime | undefined) =>
  time
    ? `<trias:${element}><trias:TimetabledTime>${time.timetabled}</trias:TimetabledTime>${
        time.estimated ? `<trias:EstimatedTime>${time.estimated}</trias:EstimatedTime>` : ""
      }</trias:${element}>`
    : "";

export type TriasCall = {
  ref: string;
  name: string;
  bay?: string;
  arrival?: ServiceTime;
  departure?: ServiceTime;
};

export const triasCall = ({ ref, name, bay, arrival, departure }: TriasCall) =>
  `<trias:StopPointRef>${ref}</trias:StopPointRef><trias:StopPointName>${text(name)}</trias:StopPointName>${
    bay ? `<trias:PlannedBay>${text(bay)}</trias:PlannedBay>` : ""
  }${serviceTime("ServiceArrival", arrival)}${serviceTime("ServiceDeparture", departure)}`;

export type TriasService = {
  journeyRef?: string;
  operatingDay?: string;
  lineName?: string;
  ptMode?: string;
  submode?: string;
  destination?: string;
  attributes?: string[];
  cancelled?: boolean;
};

export const triasService = ({
  journeyRef = "kvv:22305:E:R:s26:1762",
  operatingDay = "2026-10-17",
  lineName = "S5",
  ptMode = "rail",
  submode = "<trias:RailSubmode>suburbanRailway</trias:RailSubmode>",
  destination = "Pforzheim Hauptbahnhof",
  attributes = ["Stufenloses Fahrzeug, WLAN"],
  cancelled = false,
}: TriasService = {}) =>
  `<trias:Service><trias:OperatingDayRef>${operatingDay}</trias:OperatingDayRef><trias:JourneyRef>${journeyRef}</trias:JourneyRef><trias:ServiceSection><trias:LineRef>${journeyRef.split(":").slice(0, 4).join(":")}</trias:LineRef><trias:DirectionRef>inward</trias:DirectionRef><trias:Mode><trias:PtMode>${ptMode}</trias:PtMode>${submode}</trias:Mode><trias:PublishedLineName>${text(lineName)}</trias:PublishedLineName></trias:ServiceSection>${attributes
    .map(
      (attribute) =>
        `<trias:Attribute><trias:Text>${text(attribute)}</trias:Text><trias:Code>41</trias:Code></trias:Attribute>`,
    )
    .join(
      "",
    )}${cancelled ? "<trias:Cancelled>true</trias:Cancelled>" : ""}<trias:DestinationText>${text(destination)}</trias:DestinationText></trias:Service>`;

export type TriasStopEvent = {
  previous?: TriasCall[];
  current: TriasCall;
  onward?: TriasCall[];
  service?: TriasService;
  journeyNumber?: string;
};

export const triasStopEvent = ({
  previous = [],
  current,
  onward = [],
  service,
  journeyNumber,
}: TriasStopEvent) =>
  `<trias:StopEventResult><trias:ResultId>ID-1</trias:ResultId><trias:StopEvent>${previous
    .map(
      (call) =>
        `<trias:PreviousCall><trias:CallAtStop>${triasCall(call)}</trias:CallAtStop></trias:PreviousCall>`,
    )
    .join(
      "",
    )}<trias:ThisCall><trias:CallAtStop>${triasCall(current)}</trias:CallAtStop></trias:ThisCall>${onward
    .map(
      (call) =>
        `<trias:OnwardCall><trias:CallAtStop>${triasCall(call)}</trias:CallAtStop></trias:OnwardCall>`,
    )
    .join("")}${triasService(service)}${
    journeyNumber
      ? `<trias:Extension><trias:PublishedJourneyNumber><trias:Text xml:lang="de">${journeyNumber}</trias:Text></trias:PublishedJourneyNumber></trias:Extension>`
      : ""
  }</trias:StopEvent></trias:StopEventResult>`;

export const triasReply = (respondedAt: string, payload: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><trias:Trias xmlns:siri="http://www.siri.org.uk/siri" xmlns:trias="http://www.vdv.de/trias" version="1.2"><trias:ServiceDelivery><siri:ResponseTimestamp>${respondedAt}</siri:ResponseTimestamp><siri:Status>true</siri:Status><trias:DeliveryPayload>${payload}</trias:DeliveryPayload></trias:ServiceDelivery></trias:Trias>`;

export type TriasSituation = {
  number?: string;
  version?: string;
  summary: string;
  description?: string;
  detail?: string;
  start?: string;
  end?: string;
  priority?: string;
  lineRefs?: string[];
};

/** A SIRI situation as a board's `StopEventResponseContext` carries it. */
export const triasSituation = ({
  number,
  version = "1",
  summary,
  description,
  detail,
  start,
  end,
  priority = "3",
  lineRefs = [],
}: TriasSituation) =>
  `<trias:PtSituation><siri:CreationTime>2026-09-18T10:04:00Z</siri:CreationTime>${
    number ? `<siri:SituationNumber>${number}</siri:SituationNumber>` : "<siri:SituationNumber/>"
  }<siri:Version>${version}</siri:Version>${
    start || end
      ? `<siri:ValidityPeriod>${start ? `<siri:StartTime>${start}</siri:StartTime>` : ""}${
          end ? `<siri:EndTime>${end}</siri:EndTime>` : ""
        }</siri:ValidityPeriod>`
      : ""
  }<siri:Priority>${priority}</siri:Priority><siri:Summary>${summary}</siri:Summary>${
    description ? `<siri:Description>${description}</siri:Description>` : "<siri:Description/>"
  }${detail ? `<siri:Detail>${detail}</siri:Detail>` : "<siri:Detail/>"}${
    lineRefs.length
      ? `<siri:Affects><siri:VehicleJourneys>${lineRefs
          .map(
            (ref) =>
              `<siri:AffectedVehicleJourney><siri:LineRef>${ref}</siri:LineRef><siri:Route></siri:Route></siri:AffectedVehicleJourney>`,
          )
          .join("")}</siri:VehicleJourneys></siri:Affects>`
      : ""
  }</trias:PtSituation>`;

export const triasStopEvents = (
  respondedAt: string,
  events: string[],
  error?: string,
  situations: string[] = [],
) =>
  triasReply(
    respondedAt,
    `<trias:StopEventResponse>${
      error
        ? `<trias:ErrorMessage><trias:Code>-4030</trias:Code><trias:Text>${text(error)}</trias:Text></trias:ErrorMessage>`
        : ""
    }<trias:StopEventResponseContext><trias:Situations>${situations.join(
      "",
    )}</trias:Situations></trias:StopEventResponseContext>${events.join("")}</trias:StopEventResponse>`,
  );

export const triasTripInfo = (
  respondedAt: string,
  {
    previous = [],
    onward = [],
    service,
  }: { previous?: TriasCall[]; onward?: TriasCall[]; service?: TriasService },
) =>
  triasReply(
    respondedAt,
    `<trias:TripInfoResponse><trias:TripInfoResult>${previous
      .map((call) => `<trias:PreviousCall>${triasCall(call)}</trias:PreviousCall>`)
      .join("")}${onward
      .map((call) => `<trias:OnwardCall>${triasCall(call)}</trias:OnwardCall>`)
      .join("")}${triasService(service)}</trias:TripInfoResult></trias:TripInfoResponse>`,
  );
