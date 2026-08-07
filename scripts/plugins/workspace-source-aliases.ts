import { fileURLToPath } from "node:url";
import type { Alias } from "vite";

const pluginsSrc = fileURLToPath(
  new URL("../../packages/plugins/src", import.meta.url)
);

const coreSrc = fileURLToPath(
  new URL("../../packages/core/src", import.meta.url)
);

/**
 * `@wfgraph/plugins` and `@wfgraph/core` both publish a dist, but everything inside
 * this repo is built and tested against the workspace sources instead: the
 * resolver would otherwise hand back whatever the last build left behind, and
 * the two halves of the editor would disagree about which integrations exist. A
 * plugin reaching `@wfgraph/core/plugin` is the same story from the other side: a
 * step written against a constructor that changed this morning would be tested
 * against the one that was published last week. The root tsconfig's paths say
 * the same thing for tsc and for oxlint.
 *
 * Two configs spread this in by relative path, the root `vitest.config.ts` and
 * `packages/client/vite.config.ts`, and it stays here rather than in either of
 * them because neither one contains the other. vitest is the reason there are
 * two: it looks for `vitest.config` before `vite.config` and stops at the first
 * file it finds, so it never reads the client's config and anything the tests
 * need has to be declared again at the root.
 */
export const workspaceSourceAliases: Alias[] = [
  { find: /^@wfgraph\/plugins$/, replacement: `${pluginsSrc}/index.ts` },
  { find: /^@wfgraph\/plugins\/(.*)$/, replacement: `${pluginsSrc}/$1` },
  { find: /^@wfgraph\/core$/, replacement: `${coreSrc}/index.ts` },
  { find: /^@wfgraph\/core\/(.*)$/, replacement: `${coreSrc}/$1` },
];
