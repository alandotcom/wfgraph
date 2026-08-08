import { vi } from "vitest";
import { hydrateExtensionsFromApi } from "#src/lib/extensions";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import { emptyExtensionCatalog } from "@wfgraph/shared/extensions/catalog";

export async function hydrateTestCatalog(
  catalog: ExtensionCatalog
): Promise<void> {
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ catalog }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      )
    )
  );
  const result = await hydrateExtensionsFromApi();
  if (!result.ok) {
    throw new Error(`hydrateTestCatalog failed: ${result.reason}`);
  }
}

export async function clearTestCatalog(): Promise<void> {
  await hydrateTestCatalog(emptyExtensionCatalog);
}
