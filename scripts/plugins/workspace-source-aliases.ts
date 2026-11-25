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
 * the same thing for tsc and for oxlint. Each `@wfgraph/plugins` alias matches
 * one name in that package's "exports" map: an integration resolves to its
 * `src/<name>/index.ts` and `ui` to `src/ui.ts`.
 *
 * The Vite and Vitest configs spread this in by relative path, and it stays here
 * rather than in any one of them because none contains the others. Vitest looks
 * for `vitest.config` before `vite.config` and stops at the first match, so it
 * never reads the client's config and every test runner declares the aliases it
 * needs.
 */
export const workspaceSourceAliases: Alias[] = [
  {
    find: /^@wfgraph\/plugins\/(clerk|linear|posthog|resend|slack|twilio)$/,
    replacement: `${pluginsSrc}/$1/index.ts`,
  },
  { find: /^@wfgraph\/plugins\/ui$/, replacement: `${pluginsSrc}/ui.ts` },
  { find: /^@wfgraph\/core$/, replacement: `${coreSrc}/index.ts` },
  { find: /^@wfgraph\/core\/(.*)$/, replacement: `${coreSrc}/$1` },
];
