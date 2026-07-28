import { fileURLToPath } from "node:url";
import type { Alias } from "vite";

const pluginsSrc = fileURLToPath(
  new URL("../../packages/plugins/src", import.meta.url)
);

/**
 * `@rova/plugins` publishes a dist, but everything inside this repo is built and
 * tested against the workspace sources instead: the resolver would otherwise
 * hand back whatever the last `build:plugins` left behind, and the two halves of
 * the editor would disagree about which integrations exist. The root tsconfig's
 * paths say the same thing for tsc and for oxlint.
 *
 * Both Vite configs spread this in, because vitest.config.ts replaces
 * vite.config.ts rather than extending it: vitest looks for `vitest.config`
 * before `vite.config` and stops at the first file it finds, so anything only
 * vite.config.ts declares is simply absent under the test runner.
 */
export const workspaceSourceAliases: Alias[] = [
  { find: /^@rova\/plugins$/, replacement: `${pluginsSrc}/index.ts` },
  { find: /^@rova\/plugins\/(.*)$/, replacement: `${pluginsSrc}/$1` },
];
