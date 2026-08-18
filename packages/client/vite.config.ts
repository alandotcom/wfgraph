import { fileURLToPath } from "node:url";
import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { defineConfig } from "vite";
// Keep the `.ts`: Vite's coming native config loader is node's own, which
// guesses no extension.
import { workspaceSourceAliases } from "../../scripts/plugins/workspace-source-aliases.ts";

/**
 * The SPA's build and its dev server, both owned by the package whose source
 * they compile. `pnpm run build` here runs the build half after tsdown; `pnpm
 * run dev` at the repo root starts the dev half beside the example app.
 *
 * Development is two processes. This one serves the editor and proxies the API
 * to the app; the app serves the API and, in production only, the built bundle.
 * Nothing dispatches between them in code, which is the whole point: the app is
 * the mount an adopter writes, and a dev server that answers page views is not
 * part of it.
 */

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

// index.html lives beside the source it loads, so the source directory is the
// Vite project root and `outDir` below is what pulls the output back out of it.
const clientSrc = fileURLToPath(new URL("./src", import.meta.url));

// Beside @wfgraph/client's own tsdown output, which is where `clientBundle.dir`
// points a host.
const outDir = fileURLToPath(new URL("./dist/client", import.meta.url));

// Where examples/app.ts listens, read from the same variable the app reads so
// `PORT=4018 pnpm run dev` moves both halves together.
//
// The example mounts Workflow Graph at the root, which puts every backend route under
// `/api`: rpc, rest, openapi.json, docs, extensions, inngest, and the webhook
// and resume paths. Mounting under a `basePath` would move them all, and this
// proxy rule would have to move with them.
const APP_ORIGIN = `http://localhost:${process.env.PORT ?? 4017}`;

export default defineConfig({
  root: clientSrc,
  // Relative asset URLs. The server rewrites index.html's <base> tag to
  // wherever the host mounted Workflow Graph, and that tag is what resolves them, so a
  // sub-path mount needs no rebuild. Vite resolves a relative base to "/" in
  // development, where the tag is served unrewritten.
  base: "./",
  // The repo's public/ holds leftovers from the Next.js template that nothing
  // references, and it is not under this root in any case. Saying so keeps Vite
  // from serving an unrelated directory in development.
  publicDir: false,
  plugins: [
    react(),
    // The React Compiler memoizes components and hooks, which is why almost
    // nothing in the client reaches for useMemo or useCallback by hand.
    // `panicThreshold: "none"` leaves a component the compiler cannot handle
    // uncompiled instead of failing the build over it.
    babel({ presets: [reactCompilerPreset({ panicThreshold: "none" })] }),
    tailwindcss(),
  ],
  resolve: {
    alias: [...workspaceSourceAliases],
  },
  build: {
    outDir,
    // outDir sits outside the root above, which Vite will not clear unless it
    // is told to. Clearing is what keeps the previous build's hashed chunks out
    // of the published tarball.
    emptyOutDir: true,
    // Chunks land beside index.html rather than in an assets/ subdirectory,
    // which is the layout @wfgraph/client documents and the server serves.
    assetsDir: "",
    sourcemap: false,
  },
  server: {
    // Vite's default appType answers an unmatched page view with index.html, so
    // the browser router's own paths need nothing declared here.
    proxy: {
      "/api": APP_ORIGIN,
    },
    fs: {
      // Sources from three workspace packages reach the browser, so the dev
      // server reads from the whole monorepo rather than the client alone.
      allow: [repoRoot],
    },
  },
});
