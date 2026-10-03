import type { TransitLine, TransportMode } from "./transit-types";

/** A mode's name in text; nothing is conveyed by colour alone. */
export const labelByTransportMode: Record<TransportMode, string> = {
  lightRail: "Stadtbahn",
  tram: "Straßenbahn",
  bus: "Bus",
  other: "Linie",
};

/**
 * Neutral colours for lines missing from the GTFS snapshot, so new lines stay readable without
 * inventing a colour.
 */
const neutralColorByTransportMode: Record<TransportMode, string> = {
  lightRail: "#2f4f56",
  tram: "#3f4a4a",
  bus: "#6b6257",
  other: "#59635f",
};

/**
 * Official `route_color` values from KVV's CC0 GTFS feed, version 20260825
 * (https://projekte.kvv-efa.de/GTFS/google_transit.zip, `routes.txt`), grouped by colour. `E` is
 * ambiguous (VBK tram red, AVG rail green) and handled below. `SEV 15` keeps the VBK colour.
 */
const lineIdsByColor: Record<string, readonly string[]> = {
  "#0073df": ["2", "NL2"],
  "#00a4b1": ["S31", "S32"],
  "#00b875": ["FEX", "S1", "S11", "S12"],
  "#00d9b8": ["S42"],
  "#178a17": ["18"],
  "#37275a": ["S6"],
  "#4d4d17": ["S8", "S81"],
  "#4dd3ff": ["5"],
  "#520000": ["17"],
  "#6eb500": ["6"],
  "#8000ff": [
    "21",
    "22",
    "23",
    "24",
    "26",
    "27",
    "30",
    "31",
    "31X",
    "32",
    "42",
    "44",
    "47",
    "50",
    "51",
    "52",
    "55",
    "60",
    "62",
    "70",
    "71",
    "72",
    "73",
    "74",
    "75",
    "83",
    "101",
    "102",
    "103",
    "103s",
    "104",
    "104s",
    "105",
    "106",
    "107",
    "108",
    "109",
    "110",
    "111",
    "112",
    "113",
    "114",
    "115",
    "116",
    "117",
    "120",
    "121",
    "122",
    "123",
    "124",
    "125",
    "125X",
    "125s",
    "126",
    "127",
    "128",
    "129",
    "131",
    "132",
    "133",
    "134",
    "135",
    "136",
    "137",
    "138",
    "139",
    "140",
    "143",
    "144",
    "145",
    "145s",
    "149s",
    "151",
    "152",
    "153",
    "154",
    "155",
    "158",
    "159",
    "160",
    "161",
    "162",
    "162s",
    "163",
    "164",
    "180",
    "181",
    "182",
    "183",
    "185",
    "186",
    "187",
    "188",
    "189",
    "192",
    "193",
    "194",
    "195",
    "198",
    "201",
    "201/205",
    "202",
    "203",
    "204",
    "205",
    "206",
    "207",
    "208",
    "209",
    "211",
    "212",
    "213",
    "214",
    "215",
    "216",
    "217",
    "218",
    "221",
    "222",
    "223",
    "225",
    "226",
    "227",
    "231",
    "232",
    "233",
    "234",
    "234s",
    "235",
    "236",
    "239",
    "240",
    "240s",
    "241",
    "242",
    "244",
    "246",
    "247",
    "248",
    "251",
    "252",
    "253",
    "254",
    "255",
    "257",
    "258",
    "259",
    "262",
    "263",
    "264",
    "264s",
    "265",
    "266",
    "267",
    "268",
    "268s",
    "271",
    "272",
    "273",
    "274",
    "275",
    "276",
    "277",
    "281",
    "290",
    "291",
    "292",
    "293",
    "719",
    "ALT31",
    "ALT32",
    "ALT42",
    "ALT47",
    "ALT50",
    "ALT52",
    "ALT53",
    "ALT54",
    "ALT62",
    "ALT64",
    "ALT70",
    "H",
    "M",
    "NL11",
    "NL12",
    "NL13",
    "NL14",
    "NL15",
    "NL16",
    "NL17",
    "NL3",
    "RB1",
    "RB2",
    "RB3",
    "SEV",
    "SEV 10",
    "SEV 11",
    "SEV 12",
    "SEV 13",
    "SEV 13X",
    "SEV 14",
    "SEV 15",
    "SEV 16",
    "SEV S11",
    "SEV S31/S32",
    "SEV S4",
    "SEV S41",
    "SEV S41/S42",
    "SEV S5",
    "SEV S5/S51",
    "SEV S51",
    "SEV S6",
    "SEV S7/S71",
    "SEV S7/S8",
    "SEV S8/S81",
    "X34",
    "X44",
    "X45",
  ],
  "#806600": ["3"],
  "#990066": ["S4"],
  "#a34da7": ["S2"],
  "#b3ff00": ["S41"],
  "#ff0000": ["1", "NL1"],
  "#ff8000": ["8"],
  "#ff80b3": ["S5", "S51", "S52", "S53"],
  "#ffcc00": ["4"],
  "#ffff00": ["S7", "S71"],
};

const verifiedColorByLineId = new Map(
  Object.entries(lineIdsByColor).flatMap(([color, lineIds]) =>
    lineIds.map((lineId) => [lineId, color]),
  ),
);

/** The colour KVV's feed gives a line; never for `E`, which needs a mode (`getVerifiedColor`). */
export const getVerifiedLineColor = (lineId: string): string | undefined =>
  lineId === "E" ? undefined : verifiedColorByLineId.get(lineId);

const getVerifiedColor = (lineId: string, mode: TransportMode): string | undefined => {
  if (lineId === "E") {
    if (mode === "tram") return "#ff0000";
    if (mode === "lightRail") return "#00b875";
    return undefined;
  }
  return verifiedColorByLineId.get(lineId);
};

const hexChannel = (hex: string, offset: number): number =>
  Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
const linearChannel = (channel: number): number =>
  channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
const relativeLuminance = (hex: string): number =>
  0.2126 * linearChannel(hexChannel(hex, 1)) +
  0.7152 * linearChannel(hexChannel(hex, 3)) +
  0.0722 * linearChannel(hexChannel(hex, 5));
const contrastRatio = (first: string, second: string): number => {
  const lighter = Math.max(relativeLuminance(first), relativeLuminance(second));
  const darker = Math.min(relativeLuminance(first), relativeLuminance(second));
  return (lighter + 0.05) / (darker + 0.05);
};

/** KVV publishes white route text throughout, even on light colours. */
function getAccessibleTextColor(color: string): string {
  if (contrastRatio(color, "#ffffff") >= 4.5) return "#fff";
  if (contrastRatio(color, "#102c2c") >= 4.5) return "#102c2c";
  return "#000";
}

/**
 * A line's sign: from GTFS where known, else neutral by mode. Which lines run comes only from the
 * live feed.
 */
export function createLineSign(lineId: string, mode: TransportMode): TransitLine {
  const verifiedColor = getVerifiedColor(lineId, mode);
  const color = verifiedColor ?? neutralColorByTransportMode[mode];
  return {
    id: lineId,
    name: `${labelByTransportMode[mode]} ${lineId}`,
    transportMode: mode,
    color,
    textColor: getAccessibleTextColor(color),
    destinations: [],
    zentrumCalls: [],
  };
}

/** A departure's sign, preferring the caller's line record (which has the observed ends). */
export function getLineSign(
  lines: readonly TransitLine[],
  lineId: string,
  mode: TransportMode,
): TransitLine {
  return lines.find((line) => line.id === lineId) ?? createLineSign(lineId, mode);
}
