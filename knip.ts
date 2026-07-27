import type { KnipConfig } from "knip";

/**
 * knip finds files, exports and dependencies that nothing reaches. Run it with
 * `bun run knip`, which uses the knip-bun binary so config files that touch
 * `Bun.env` (packages/core/drizzle.config.ts) can be loaded.
 *
 * Two things shape this config, and both come from how the repo is built:
 *
 * 1. Every cross-package import goes through a tsconfig path alias (`@/shared/*`,
 *    `@/backend/*`, `@/*`), so the package specifiers `@rova/core` and
 *    `@rova/shared` almost never appear in source. knip reads those aliases from
 *    the root tsconfig.json and resolves them to real files, which is why the
 *    workspace entry lists below can stay small.
 * 2. `@rova/core` is the only workspace that builds. tsdown inlines the
 *    `@rova/shared` source it reaches into packages/core/dist, so some of core's
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
  // A compiler is global in knip 6.29 while stylesheets live in packages/core
  // alone, so each of the other three workspaces prints one standing
  // "Compiled extension excluded by project" hint. Hints are informational and
  // leave the exit code at 0, and giving those workspaces a `**/*.css` glob
  // only trades the hint for a "no matches" one.
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
        // file a script runs as an entry, which covers scripts/build-client.ts,
        // scripts/compile.ts and scripts/copy-migrations.ts. Listing those here
        // draws a "redundant entry pattern" hint. What remains is the four it
        // cannot see.
        //
        // Run by "dev:app", whose command carries env assignments and a `--hot`
        // flag ahead of the file:
        "server.ts",
        // Run by "example:library-trigger", whose command is a single `sh -c`
        // string that knip does not read into:
        "examples/library-trigger.ts",
        // Run by the afterFileEdit hook in .cursor/hooks.json:
        "scripts/format-edited-file.ts",
        // Run by hand against a deployed database. Nothing in the repo calls it,
        // which is why it has to be listed rather than found.
        "scripts/migrate-prod.ts",
      ],
      project: ["*.ts", "*.mjs", "examples/**/*.ts", "scripts/**/*.ts"],

      // drizzle-kit is a root dev dependency, so knip looks for the Drizzle
      // config beside the root manifest. This repo keeps it with the schema it
      // points at.
      drizzle: { config: ["packages/core/drizzle.config.ts"] },

      ignoreDependencies: [
        // scripts/plugins/react-compiler-plugin.ts names these three as strings
        // in the options object it hands to @babel/core, so no import statement
        // mentions them.
        "@babel/preset-react",
        "@babel/preset-typescript",
        "babel-plugin-react-compiler",
      ],
    },

    "packages/shared": {
      // Nothing imports the `@rova/shared` package specifier. Core and plugins
      // reach into this tree through the `@/shared/*` alias, so leaving entry
      // empty lets those imports decide what is reachable and lets knip report
      // the rest.
      entry: [],
      project: ["src/**/*.{ts,tsx}"],
    },

    "packages/core": {
      // src/index.ts, src/app.ts, and src/node.ts come from the tsdown plugin,
      // which reads them out of tsdown.config.ts.
      entry: [],
      project: ["src/**/*.{ts,tsx}"],

      ignoreDependencies: [
        // packages/core/dist/index.js imports graphology, and the emitted .d.ts
        // files import @standard-schema/spec. Both arrive through the
        // @rova/shared source that tsdown inlines into the bundle, so the
        // published package needs them declared here.
        "graphology",
        "@standard-schema/spec",
      ],
    },

    "packages/client": {
      // The SPA is rooted at the script tag in src/index.html; src/index.ts is
      // the tiny module a host imports to hand the built bundle to
      // createRovaApp, and knip picks that up from the "exports" map.
      entry: ["src/main.tsx"],
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
      // src/index.ts, src/server.ts and src/ui.ts are the three names in this
      // package's "exports" map, and knip picks them up from there. All three
      // exist for their import side effects: they register plugin metadata, the
      // server-side lazy loaders (step importers and connection tests), and
      // React components.
      entry: [],
      project: ["src/**/*.{ts,tsx}"],
      ignoreDependencies: [
        // The plugin icons and output renderers are .tsx compiled with the
        // automatic JSX runtime, so react arrives as a `react/jsx-runtime`
        // import that the transform adds and @types/react is what tsc reads.
        "react",
        "@types/react",
      ],
    },
  },
};

export default config;
