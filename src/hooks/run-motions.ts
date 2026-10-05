import { createRunMotions, type RunMotions } from "../lib/vehicle-positioning";

/**
 * One record of mark motion for the app's life, shared by every view: a view opened later continues
 * a run's mark where another left it, so one run sits in one place whichever view draws it.
 */
const runMotions = createRunMotions();

export const useRunMotions = (): RunMotions => runMotions;
