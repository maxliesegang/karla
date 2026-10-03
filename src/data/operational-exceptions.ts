/**
 * The operator's words for running off the published route, shared by the parser (which lifts these
 * remarks into notes) and corridor grouping (which never learns a route from such a trip).
 */

/** The words as one regex alternation; `SEV` gets word boundaries, being short. */
export const EXCEPTIONAL_OPERATION_WORDS = "umleitung|ersatzverkehr|schienenersatz|\\bsev\\b";

const EXCEPTIONAL_OPERATION_PATTERN = new RegExp(EXCEPTIONAL_OPERATION_WORDS, "i");

/** Whether a note announces an exceptional operation. */
export const isExceptionalOperationNote = (note: string | undefined): boolean =>
  EXCEPTIONAL_OPERATION_PATTERN.test(note ?? "");
