import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vitest/config";

const packagesDir = fileURLToPath(new URL("./packages", import.meta.url));

/**
 * Resolves `@/` the way AGENTS.md defines it and .oxlintrc.json enforces it:
 * the importing package's own `src`, never another's. A Vite alias cannot
 * express that, because an alias is one mapping for the whole project while
 * this prefix means four different directories depending on who wrote it. So
 * the importer decides, and a file outside `packages/<name>/src` falls through
 * to the normal resolver.
 */
function packageScopedAlias(): Plugin {
  const importerPackage = new RegExp(
    `^${packagesDir}/([^/]+)/src/`.replaceAll(".", "\\.")
  );

  return {
    name: "rova:package-scoped-alias",
    enforce: "pre",
    async resolveId(source, importer) {
      if (!importer || !source.startsWith("@/")) {
        return null;
      }

      const owner = importerPackage.exec(importer)?.[1];
      if (!owner) {
        return null;
      }

      // Hand the rewritten path back to the rest of the chain so Vite still
      // does extension and directory-index resolution for it.
      const resolved = await this.resolve(
        `${packagesDir}/${owner}/src/${source.slice("@/".length)}`,
        importer,
        { skipSelf: true }
      );

      return resolved ?? null;
    },
  };
}

export default defineConfig({
  plugins: [packageScopedAlias()],
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          environment: "node",
          include: ["packages/{shared,core,plugins}/src/**/*.test.{ts,tsx}"],
        },
      },
      {
        extends: true,
        test: {
          name: "client",
          // Only the client renders components, so only the client pays for a
          // DOM. The backend packages run bare, which is what an embedder's
          // process looks like.
          environment: "happy-dom",
          include: ["packages/client/src/**/*.test.{ts,tsx}"],
          setupFiles: ["./test-setup.ts"],
          server: {
            deps: {
              // bundle.test.ts imports the built @rova/client to check where
              // `clientBundle.dir` lands, and that answer comes from the built
              // file's own `import.meta.url`. The module runner rewrites that,
              // so this one artifact goes to node's loader untouched.
              external: [/packages\/client\/dist\//],
            },
          },
        },
      },
    ],
  },
});
