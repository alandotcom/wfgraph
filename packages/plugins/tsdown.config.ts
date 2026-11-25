import { defineConfig } from "tsdown";

// One named entry per name in this package's "exports" map. tsdown writes each
// entry to dist/<key>.js and dist/<key>.d.ts, which are the paths the map points at,
// and puts code two entries share in a chunk both import statically.
//
// Each integration has its own entry so a host loads only the integrations it
// lists: a Cloudflare Worker that imports Slack alone starts without parsing the
// other five. The integrations are server-only values and `ui` holds the React
// components, so a server imports an integration without pulling React in, and
// the browser imports `ui` without pulling a vendor client in.
//
// @wfgraph/shared is private and gets inlined, as it is into @wfgraph/core.
export default defineConfig({
  entry: {
    clerk: "src/clerk/index.ts",
    linear: "src/linear/index.ts",
    posthog: "src/posthog/index.ts",
    resend: "src/resend/index.ts",
    slack: "src/slack/index.ts",
    twilio: "src/twilio/index.ts",
    ui: "src/ui.ts",
  },
  format: "esm",
  platform: "node",
  outDir: "dist",
  fixedExtension: false,
  sourcemap: false,
  dts: true,
  tsconfig: "../../tsconfig.build.json",
  clean: true,
});
