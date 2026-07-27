import { createStore } from "jotai";

/**
 * The one Jotai store the app runs on.
 *
 * It is created here rather than implicitly by `<Provider>` so that code
 * outside the React tree can reach it. The workflow route's loader is the
 * reason: hydrating the editor before the first render is what keeps the load
 * out of an effect, and a loader runs before there is a component to hold a
 * hook.
 */
export const appStore = createStore();
