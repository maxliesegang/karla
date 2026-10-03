/**
 * A minimal `renderHook` on happy-dom for the node runner. Importing it registers happy-dom's
 * globals for the file; each test file runs in its own process.
 */
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");

export type RenderedHook<Props, Result> = {
  readonly current: Result;
  rerender(props: Props): Promise<void>;
  unmount(): Promise<void>;
};

export async function renderHook<Props, Result>(
  hook: (props: Props) => Result,
  initialProps: Props,
): Promise<RenderedHook<Props, Result>> {
  let current!: Result;
  const Probe = (props: { hookProps: Props }) => {
    current = hook(props.hookProps);
    return null;
  };
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(createElement(Probe, { hookProps: initialProps })));
  return {
    get current() {
      return current;
    },
    rerender: (props) => act(async () => root.render(createElement(Probe, { hookProps: props }))),
    unmount: () => act(async () => root.unmount()),
  };
}

/** Lets pending promises settle inside `act`, so the state they set is rendered. */
export const flush = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
