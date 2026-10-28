import type { OperatorArea } from "../network-definition";

/**
 * Operator families around KVV, by Verbund (districts) or rail operator (states). A journey's ends
 * pick between lines of one name, so S-Bahn Stuttgart's S3 and S-Bahn Rhein-Neckar's S3 get their
 * own colours. KVV first: its lines take KVV's own colours.
 */
export const kvvOperatorAreas: readonly OperatorArea[] = [
  {
    operators: ["kvv-"],
    districts: ["de:08212", "de:08215", "de:08216", "de:08211", "de:08231", "de:08236"],
    isHome: true,
  },
  {
    operators: ["vrn-"],
    districts: [
      ...["de:08221", "de:08222", "de:08225", "de:08226", "de:08128", "de:06431"],
      ...["de:07311", "de:07312", "de:07313", "de:07314", "de:07316", "de:07317", "de:07318"],
      ...["de:07319", "de:07320", "de:07332", "de:07333", "de:07334", "de:07335", "de:07336"],
      ...["de:07337", "de:07338", "de:07340"],
    ],
  },
  {
    operators: ["vvs-"],
    districts: ["de:08111", "de:08115", "de:08116", "de:08117", "de:08118", "de:08119"],
  },
  { operators: ["hnv-"], districts: ["de:08121", "de:08125"] },
  { operators: ["vpe-"], districts: ["de:08231", "de:08236"] },
  { operators: ["vgc-"], districts: ["de:08235"] },
  { operators: ["vgf-"], districts: ["de:08237"] },
  { operators: ["tgo-"], districts: ["de:08317"] },
  { operators: ["rvf-"], districts: ["de:08311", "de:08315", "de:08316"] },
  { operators: ["naldo-"], districts: ["de:08415", "de:08416", "de:08417", "de:08437"] },
  {
    operators: ["ding-", "regio-s-bahn-donau-iller"],
    districts: ["de:08421", "de:08425", "de:08426", "de:09775"],
  },
  { operators: ["bodo-"], districts: ["de:08435", "de:08436", "de:09776"] },
  { operators: ["move-"], districts: ["de:08325", "de:08326", "de:08327"] },
  { operators: ["vhb-"], districts: ["de:08335"] },
  { operators: ["rvl-"], districts: ["de:08336"] },
  { operators: ["wtv-"], districts: ["de:08337"] },
  { operators: ["kvsh-"], districts: ["de:08127"] },
  { operators: ["ostalb-mobil-"], districts: ["de:08136"] },
  {
    operators: ["db-regio-ag-baden-wurttemberg", "arverio-bw", "sweg-sudwest", "svg-stuttgart"],
    districts: ["de:08"],
  },
  {
    operators: ["db-regio-mitte", "vlexx", "trans-regio", "saarbahn"],
    districts: ["de:07", "de:10", "de:06"],
  },
  { operators: ["rmv-", "hlb"], districts: ["de:06"] },
];
