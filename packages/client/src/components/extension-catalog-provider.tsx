import { createContext, type ReactNode, useContext } from "react";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";

/**
 * The extension catalog the editor draws from, held as context so tests can
 * hand a fixture without writing the boot module, and so React Flow nodes
 * (which receive only serializable graph data) still reach the same document.
 */
const ExtensionCatalogContext = createContext<ExtensionCatalog | null>(null);

export function ExtensionCatalogProvider({
  children,
  value,
}: {
  children: ReactNode;
  value: ExtensionCatalog;
}) {
  return (
    <ExtensionCatalogContext.Provider value={value}>
      {children}
    </ExtensionCatalogContext.Provider>
  );
}

export function useExtensionCatalog(): ExtensionCatalog {
  const value = useContext(ExtensionCatalogContext);
  if (!value) {
    throw new Error(
      "useExtensionCatalog must be used within an ExtensionCatalogProvider"
    );
  }
  return value;
}
