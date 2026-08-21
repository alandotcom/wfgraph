import { useTheme } from "next-themes";

export type ColorMode = "light" | "dark" | "system";
export type ResolvedColorMode = "light" | "dark";

const toColorMode = (value: string | undefined): ColorMode => {
  if (value === "light" || value === "dark") {
    return value;
  }
  return "system";
};

const toResolvedColorMode = (value: string | undefined): ResolvedColorMode =>
  value === "dark" ? "dark" : "light";

/** The app-sized, typed surface over next-themes' open string contract. */
export function useColorMode() {
  const { theme, resolvedTheme, setTheme } = useTheme();

  return {
    mode: toColorMode(theme),
    resolvedMode: toResolvedColorMode(resolvedTheme),
    setMode: (mode: ColorMode) => setTheme(mode),
  };
}
