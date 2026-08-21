import { LinkProvider } from "@astryxdesign/core/Link";
import { Theme } from "@astryxdesign/core/theme";
import { Link } from "@tanstack/react-router";
import { ThemeProvider as ColorModeProvider } from "next-themes";
import type { ComponentPropsWithRef, ReactNode } from "react";
import { useColorMode } from "./color-mode";
import { wfgraphTheme } from "./wfgraph";

function TanStackLink({ href, ...props }: ComponentPropsWithRef<"a">) {
  // Astryx names the destination `href`; TanStack Router names it `to`.
  return <Link to={href} {...props} />;
}

function AstryxTheme({ children }: { children: ReactNode }) {
  const { resolvedMode } = useColorMode();
  return (
    <LinkProvider component={TanStackLink}>
      <Theme mode={resolvedMode} theme={wfgraphTheme}>
        {children}
      </Theme>
    </LinkProvider>
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
