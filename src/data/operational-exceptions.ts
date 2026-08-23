/**
 * The operator's words for running something other than the published route.
 *
 * One vocabulary, stated once, because two readers of the same note must not disagree about what
 * it announces: the parser peels these remarks out of destinations and hints so the board states
 * them, and the corridor grouping refuses to teach or reuse a route from a trip that carries one —
 * a temporary diversion must never become the route a later trip is promised.
 */

/**
 * The words an exceptional operation is announced with, as one alternation for building patterns.
 * `SEV` alone is short enough to sit inside an unrelated word, so it alone carries word boundaries.
 */
export const EXCEPTIONAL_OPERATION_WORDS = "umleitung|ersatzverkehr|schienenersatz|\\bsev\\b";

const EXCEPTIONAL_OPERATION_PATTERN = new RegExp(EXCEPTIONAL_OPERATION_WORDS, "i");

/** Whether a service note announces that its trip is running an exceptional operation. */
export const isExceptionalOperationNote = (note: string | undefined): boolean =>
  EXCEPTIONAL_OPERATION_PATTERN.test(note ?? "");
