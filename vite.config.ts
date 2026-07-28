import { fileURLToPath } from "node:url";
import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { packageScopedAlias } from "./scripts/plugins/package-scoped-alias";

/**
 * The SPA's build and its dev server. `pnpm run build:client` runs the build
 * half; `server.ts` creates the dev half in middleware mode inside its own
 * process, so the whole repo stays on one port.
 *
 * The config sits at the repo root rather than in packages/client because the
 * client build has always been driven from here, and because everything it
 * touches is a root dev dependency.
 */

const repoRoot = fileURLToPath(new URL(".", import.meta.url));
const clientSrc = fileURLToPath(
  new URL("./packages/client/src", import.meta.url)
);
const pluginsSrc = fileURLToPath(
  new URL("./packages/plugins/src", import.meta.url)
);

// `build:client` sets this so the bundle lands beside @rova/client's own
// tsdown output, which is where `clientBundle.dir` points a host.
const outDir = fileURLToPath(
  new URL(process.env.CLIENT_DIST_DIR ?? "./dist/client", import.meta.url)
);

export default defineConfig({
  // index.html lives beside the source it loads, so the source directory is the
  // project root and `outDir` below is what pulls the output back out of it.
  root: clientSrc,
  // Relative asset URLs. The server rewrites index.html's <base> tag to
  // wherever the host mounted Rova, and that tag is what resolves them, so a
  // sub-path mount needs no rebuild.
  base: "./",
  // The repo's public/ holds leftovers from the Next.js template that nothing
  // references, and it is not under this root in any case. Saying so keeps Vite
  // from serving an unrelated directory in development.
  publicDir: false,
  plugins: [
    packageScopedAlias(),
    react(),
    // The React Compiler memoizes components and hooks, which is why almost
    // nothing in the client reaches for useMemo or useCallback by hand.
    // `panicThreshold: "none"` leaves a component the compiler cannot handle
    // uncompiled instead of failing the build over it.
    babel({ presets: [reactCompilerPreset({ panicThreshold: "none" })] }),
    tailwindcss(),
  ],
  resolve: {
    alias: [
      // @rova/plugins publishes its dist, but the client is built from the
      // workspace and has to see plugin sources: development would otherwise
      // serve whatever the last `build:plugins` left behind, and the two halves
      // of the editor would disagree about which integrations exist. The root
      // tsconfig's paths say the same thing for tsc and for oxlint.
      { find: /^@rova\/plugins$/, replacement: `${pluginsSrc}/index.ts` },
      { find: /^@rova\/plugins\/(.*)$/, replacement: `${pluginsSrc}/$1` },
    ],
  },
  build: {
    outDir,
    // outDir sits outside the root above, which Vite will not clear unless it
    // is told to. Clearing is what keeps the previous build's hashed chunks out
    // of the published tarball.
    emptyOutDir: true,
    // Chunks land beside index.html rather than in an assets/ subdirectory,
    // which is the layout @rova/client documents and the server serves.
    assetsDir: "",
    sourcemap: false,
  },
  server: {
    fs: {
      // Sources from three workspace packages reach the browser, so the dev
      // server reads from the whole monorepo rather than the client alone.
      allow: [repoRoot],
    },
  },
});
