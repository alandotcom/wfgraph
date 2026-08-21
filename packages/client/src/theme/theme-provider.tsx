import { Theme } from "@astryxdesign/core/theme";
import { ThemeProvider as ColorModeProvider } from "next-themes";
import type { ReactNode } from "react";
import { useColorMode } from "./color-mode";
import { wfgraphTheme } from "./wfgraph";

function AstryxTheme({ children }: { children: ReactNode }) {
  const { resolvedMode } = useColorMode();
  return (
    <Theme mode={resolvedMode} theme={wfgraphTheme}>
      {children}
    </Theme>
  );
}

/** One root for persisted color mode and the editor's Astryx theme. */
export function ThemeProvider({ children }: { children: ReactNode }) {
  return (
    <ColorModeProvider
      attribute="data-theme"
      defaultTheme="system"
      disableTransitionOnChange
      enableSystem
    >
      <AstryxTheme>{children}</AstryxTheme>
    </ColorModeProvider>
  );
}
