import type { KnipConfig } from "knip";

/**
 * knip finds files, exports and dependencies that nothing reaches. Run it with
 * `pnpm run knip`.
 *
 * Two things shape this config, and both come from how the repo is built:
 *
 * 1. A package reaches its own source through the `#src/*` subpath import its
 *    package.json declares, and a sibling's through the `@wfgraph/*` path aliases in
 *    the root tsconfig.json. knip resolves both to real files, which is why the
 *    workspace entry lists below can stay small.
 * 2. `@wfgraph/core` is the only workspace that builds. tsdown inlines the
 *    `@wfgraph/shared` source it reaches into packages/core/dist, so some of core's
 *    declared dependencies are imported by the built bundle rather than by
 *    core's own source. Those are named in ignoreDependencies with the reason.
 */
const config: KnipConfig = {
  // The SPA's stylesheet pulls Tailwind and its animation plugin in with CSS
  // `@import`, which is the only way those two dependencies are ever named. A
  // knip compiler turns a file of any extension into something knip can parse,
  // and lifting the `@` off each `@import` leaves a plain import statement.
  // knip 6.29 documents a built-in `.css` compiler but ships none, so setting
  // `css: true` crashes; this hands it the function the docs print.
  //
  // A compiler is global in knip 6.29 while the one stylesheet lives in
  // packages/client, so every workspace whose project glob names no stylesheet
  // prints one standing "Compiled extension excluded by project" hint. Hints are
  // informational and leave the exit code at 0, and giving those workspaces a
  // `**/*.css` glob only trades the hint for a "no matches" one.
  compilers: {
    css: (text: string) =>
      [...text.matchAll(/(?<=@)import[^;]+/g)].map(([m]) => m).join("\n"),
  },

  // An export referenced inside its own file is reachable code; the only thing
  // wrong with it is a wider-than-needed declaration. Exports that nothing
  // references at all are still reported, which is the signal worth acting on.
  ignoreExportsUsedInFile: true,

  workspaces: {
    ".": {
      entry: [
        // Every entry is named on its own line, because knip treats an entry as
        // reachable by definition. `scripts/*.ts` and `examples/*.ts` made each
        // directory entirely self-justifying, so a file nobody ran and nobody
        // imported sat there reported as fine. Naming them means adding one is a
        // visible decision, and anything else in these two trees has to earn its
        // place by being imported.
        //
        // knip already reads the "scripts" block of package.json and treats a
        // file a script runs as an entry, which covers scripts/migrate.ts and
        // scripts/unqualify-migrations.ts through the two db: scripts. Listing
        // such a file here draws a "redundant entry pattern" hint. What remains
        // is the one it cannot see.
        //
        // Run by the afterFileEdit hook in .cursor/hooks.json:
        "scripts/format-edited-file.ts",

        // Named in the concurrently command line scripts/dev.ts builds, which
        // is a string knip cannot follow:
        "scripts/dev-client.ts",
      ],
      project: ["*.ts", "scripts/**/*.ts"],

      ignoreDependencies: [
        // @effect/tsgo embeds the Effect language-service plugin into its
        // patched TypeScript-Go binary. The plugin keeps this historical name
        // in tsconfig even though there is no separate package to declare.
        "@effect/language-service",
      ],

      // drizzle-kit is a root dev dependency, so knip looks for the Drizzle
      // config beside the root manifest. This repo keeps it with the schema it
      // points at.
      drizzle: { config: ["packages/core/drizzle.config.ts"] },
    },

    examples: {
      // app.ts is found rather than named: knip reads the "dev" and "start"
      // scripts in this package's manifest and takes the file they run as the
      // entry.
      entry: [],
      project: ["*.ts"],
    },

    "packages/shared": {
      // Core and plugins reach into this tree by the `@wfgraph/shared/*` specifier,
      // which the root tsconfig maps to these sources, so leaving entry empty
      // lets those imports decide what is reachable and lets knip report the
      // rest.
      entry: [],
      project: ["src/**/*.{ts,tsx}"],

      // This package's "exports" map is `"./*": "./src/*.ts"`, so knip takes
      // every source file here as an entry, and an entry's exports are exempt by
      // default. That left the whole package unchecked for dead exports while
      // the config above read as though it were checked. This turns the check
      // back on; nothing outside the repo consumes @wfgraph/shared, so an export
      // no sibling imports is dead.
      includeEntryExports: true,
    },

    "packages/core": {
      // The entries come from the tsdown plugin, which reads them out of
      // tsdown.config.ts, so this list cannot drift from what the build emits.
      // Whether the "exports" map names those same files is a separate question,
      // and the comment in tsdown.config.ts is where it is answered.
      entry: [],
      project: ["src/**/*.{ts,tsx}"],

      ignoreDependencies: [
        // packages/core/dist/index.js imports graphology and @orpc/contract, and
        // the emitted .d.ts files import @standard-schema/spec. All three arrive
        // through the @wfgraph/shared source that tsdown inlines into the bundle —
        // the RPC contracts are built with `oc` from @orpc/contract — so the
        // published package needs them declared here even though no file under
        // packages/core/src names them.
        //
        // @standard-schema/spec's entry is deliberate for that reason, even
        // though define-action.test.ts also imports it: knip will keep hinting
        // "Remove from ignoreDependencies" for it, since it cannot see the .d.ts
        // import the entry justifies. That hint is expected; do not act on it.
        "graphology",
        "@orpc/contract",
        "@standard-schema/spec",
      ],
    },

    "packages/client": {
      // Both entries are found rather than named. knip's Vite plugin reads
      // vite.config.ts, follows `root` to src/index.html, and takes the script
      // tag there as the SPA's entry; src/index.ts, the tiny module a host
      // imports to hand the built bundle to createWfGraphApp, comes from the
      // "exports" map.
      entry: [
        // Run by the theme:build script as a CLI file argument, which is a
        // string knip cannot follow. The built wfgraph.js/wfgraph.css it
        // generates are reached through ordinary imports.
        "src/theme/wfgraph-theme.ts",
      ],
      project: ["src/**/*.{ts,tsx}", "**/*.css"],

      // components.json points shadcn's generator at src/components/ui, and what
      // it writes there is the primitive's whole surface. A name pruned out of
      // one of those export blocks comes back the next time the component is
      // added or updated, so export reports are muted for that one directory.
      // File reports still apply, which is how the six unused components in it
      // were found.
      ignoreIssues: { "src/components/ui/**": ["exports", "types"] },
    },

    "packages/plugins": {
      // src/index.ts and src/ui.ts are the two names in this package's "exports"
      // map, and knip picks them up from there. The first exports the
      // integrations as values, which a host passes to createWfGraphApp; the second
      // exports the icons and output renderers, which are React components and
      // so cannot travel over /api/extensions.
      entry: [],
      project: ["src/**/*.{ts,tsx}"],
    },
  },
};

export default config;
