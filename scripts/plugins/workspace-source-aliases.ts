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
 * the same thing for tsc and for oxlint. The `@wfgraph/plugins` aliases follow
 * that package's "exports" map: `ui` resolves to `src/ui.ts`, and any other
 * single name to `src/<name>/index.ts`. A deeper path such as
 * `@wfgraph/plugins/slack/client` matches neither alias, so it fails to resolve
 * here as it does for an adopter.
 *
 * The Vite and Vitest configs spread this in by relative path, and it stays here
 * rather than in any one of them because none contains the others. Vitest looks
 * for `vitest.config` before `vite.config` and stops at the first match, so it
 * never reads the client's config and every test runner declares the aliases it
 * needs.
 */
export const workspaceSourceAliases: Alias[] = [
  { find: /^@wfgraph\/plugins\/ui$/, replacement: `${pluginsSrc}/ui.ts` },
  {
    find: /^@wfgraph\/plugins\/([^/]+)$/,
    replacement: `${pluginsSrc}/$1/index.ts`,
  },
  { find: /^@wfgraph\/core$/, replacement: `${coreSrc}/index.ts` },
  { find: /^@wfgraph\/core\/(.*)$/, replacement: `${coreSrc}/$1` },
];
