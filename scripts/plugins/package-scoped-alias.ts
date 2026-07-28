import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

const packagesDir = fileURLToPath(new URL("../../packages", import.meta.url));

/**
 * Resolves `@/` the way AGENTS.md defines it and .oxlintrc.json enforces it:
 * the importing package's own `src`, never another's. A Vite alias cannot
 * express that, because an alias is one mapping for the whole project while
 * this prefix means four different directories depending on who wrote it. So
 * the importer decides, and a file outside `packages/<name>/src` falls through
 * to the normal resolver.
 *
 * Both Vite configs need it. The client bundle is not client source alone:
 * `@rova/shared` and `@rova/plugins` resolve to their own sources, and those
 * carry `@/` imports meaning their own package, so a plain alias to
 * `packages/client/src` would send them to files that do not exist.
 */
export function packageScopedAlias(): Plugin {
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
