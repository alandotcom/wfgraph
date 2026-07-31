import { createContext, type ReactNode, useContext } from "react";
import type { IntegrationUi } from "@rova/plugins/ui";

/**
 * The icons and output renderers the editor draws integrations with, held as
 * context because the components reading them include a React Flow custom node,
 * which React Flow instantiates itself and can be handed nothing but
 * serializable graph data.
 */
const IntegrationUiContext = createContext<Record<
  string,
  IntegrationUi
> | null>(null);

export function IntegrationUiProvider({
  children,
  value,
}: {
  children: ReactNode;
  value: Record<string, IntegrationUi>;
}) {
  return (
    <IntegrationUiContext.Provider value={value}>
      {children}
    </IntegrationUiContext.Provider>
  );
}

/**
 * The whole record, keyed by integration type. A missing key is the normal case
 * for an integration that ships no React half.
 */
export function useIntegrationUi(): Record<string, IntegrationUi> {
  const value = useContext(IntegrationUiContext);
  if (!value) {
    throw new Error(
      "useIntegrationUi must be used within an IntegrationUiProvider"
    );
  }
  return value;
}
