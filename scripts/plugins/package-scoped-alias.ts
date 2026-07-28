import { fileURLToPath } from "node:url";
import type { Alias, Plugin } from "vite";

const packagesDir = fileURLToPath(new URL("../../packages", import.meta.url));
const pluginsSrc = `${packagesDir}/plugins/src`;

/**
 * `@rova/plugins` publishes a dist, but everything inside this repo is built and
 * tested against the workspace sources instead: the resolver would otherwise
 * hand back whatever the last `build:plugins` left behind, and the two halves of
 * the editor would disagree about which integrations exist. The root tsconfig's
 * paths say the same thing for tsc and for oxlint.
 *
 * Both Vite configs spread this in, because vitest.config.ts replaces
 * vite.config.ts rather than extending it: vitest looks for `vitest.config`
 * before `vite.config` and stops at the first file it finds, so anything only
 * vite.config.ts declares is simply absent under the test runner.
 */
export const workspaceSourceAliases: Alias[] = [
  { find: /^@rova\/plugins$/, replacement: `${pluginsSrc}/index.ts` },
  { find: /^@rova\/plugins\/(.*)$/, replacement: `${pluginsSrc}/$1` },
];

/**
 * The package whose own `src` an importer sits in, or null for a file anywhere
 * else, which then keeps the normal resolver.
 *
 * Plain string work rather than a pattern built from the absolute packages path:
 * a checkout under a directory holding `(`, `+`, `[` or any other regex
 * metacharacter would otherwise change what that pattern matches.
 */
function ownerPackageOf(importer: string): string | null {
  const prefix = `${packagesDir}/`;
  if (!importer.startsWith(prefix)) {
    return null;
  }

  const [owner, sourceDir] = importer.slice(prefix.length).split("/");
  if (!owner || sourceDir !== "src") {
    return null;
  }

  return owner;
}

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
  return {
    name: "rova:package-scoped-alias",
    enforce: "pre",
    async resolveId(source, importer) {
      if (!importer || !source.startsWith("@/")) {
        return null;
      }

      const owner = ownerPackageOf(importer);
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
