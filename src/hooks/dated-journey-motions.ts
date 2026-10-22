import { createDatedJourneyMotions, type DatedJourneyMotions } from "../lib/vehicle-positioning";

/**
 * One record of mark motion for the app's life, shared by every view: a view opened later continues
 * a dated journey's mark where another left it, so one dated journey sits in one place whichever
 * view draws it.
 */
const datedJourneyMotions = createDatedJourneyMotions();

export const useDatedJourneyMotions = (): DatedJourneyMotions => datedJourneyMotions;
