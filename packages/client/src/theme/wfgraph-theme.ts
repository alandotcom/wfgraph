import { defineTheme } from "@astryxdesign/core/theme";

/**
 * The editor's Astryx theme, translated from the shadcn-era oklch tokens that
 * still live in `src/routes/globals.css`. The palette is pure neutral — every
 * value here has chroma 0 — so `neutralStyle: "neutral"` generates the ramps
 * and the overrides below pin the exact legacy values on top of them.
 *
 * Run `pnpm --filter @wfgraph/client exec astryx theme build
 * src/theme/wfgraph-theme.ts` after editing; the built CSS + JS are committed
 * beside this file and are what the app imports.
 */
export const wfgraphTheme = defineTheme({
  name: "wfgraph",
  color: { neutralStyle: "neutral" },
  typography: {
    body: {
      family: "Geist Variable",
      fallbacks: "ui-sans-serif, system-ui, -apple-system, sans-serif",
    },
    code: {
      family: "Geist Mono Variable",
      fallbacks: "ui-monospace, SFMono-Regular, monospace",
    },
  },
  tokens: {
    // Paper / Void: the canvas and page backgrounds.
    "--color-background-body": ["oklch(1 0 0)", "oklch(0 0 0)"],
    "--color-background-surface": ["oklch(1 0 0)", "oklch(0.205 0 0)"],
    "--color-background-card": ["oklch(1 0 0)", "oklch(0.205 0 0)"],
    "--color-background-popover": ["oklch(1 0 0)", "oklch(0.205 0 0)"],
    "--color-background-muted": ["oklch(0.97 0 0)", "oklch(0.15 0 0)"],
    "--color-text-primary": ["oklch(0.145 0 0)", "oklch(0.98 0 0)"],
    "--color-text-secondary": ["oklch(0.556 0 0)", "oklch(0.65 0 0)"],
    "--color-border": ["oklch(0.922 0 0)", "oklch(0.27 0 0)"],
    // The editor's "accent" is its foreground: near-black in light mode,
    // near-white in dark. Primary buttons read as ink, not brand colour. A
    // neutral seed cannot go through Astryx's chromatic HCT accent generator,
    // so all three members of the accent family are explicit here.
    "--color-accent": ["oklch(0.205 0 0)", "oklch(0.98 0 0)"],
    "--color-accent-muted": ["#1717171A", "#F8F8F83F"],
    "--color-on-accent": ["oklch(0.985 0 0)", "oklch(0.09 0 0)"],
  },
});
