import { defineConfig } from "tsdown";
import manifest from "./package.json" with { type: "json" };

// One named entry per subpath in this package's "exports" map, which makes that
// map the one list of the package's entries. "./ui" builds from src/ui.ts, and
// every other subpath "./<name>" builds from src/<name>/index.ts. tsdown writes
// each entry to dist/<name>.js and dist/<name>.d.ts, which are the paths the map
// points at, and puts code two entries share in a chunk both import statically.
//
// Each integration has its own entry so a host loads only the integrations it
// lists: a Cloudflare Worker that imports Slack alone starts without parsing the
// other five. The integrations are server-only values and `ui` holds the React
// components, so a server imports an integration without pulling React in, and
// the browser imports `ui` without pulling a vendor client in.
//
// tsdown loads this file with Node's own TypeScript support, which is what
// accepts the JSON import attribute on the manifest import.
//
// @wfgraph/shared is private and gets inlined, as it is into @wfgraph/core.
const entry = Object.fromEntries(
  Object.keys(manifest.exports).map((subpath) => {
    const name = subpath.replace(/^\.\//, "");
    return [name, name === "ui" ? "src/ui.ts" : `src/${name}/index.ts`];
  })
);

export default defineConfig({
  entry,
  format: "esm",
  platform: "node",
  outDir: "dist",
  fixedExtension: false,
  sourcemap: false,
  dts: true,
  tsconfig: "../../tsconfig.build.json",
  clean: true,
});
