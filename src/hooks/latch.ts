import { useState } from "react";

/** True from the first render `condition` holds, and for the rest of the component's life. */
export function useLatch(condition: boolean): boolean {
  const [isLatched, setIsLatched] = useState(condition);
  if (condition && !isLatched) setIsLatched(true);
  return isLatched || condition;
}
