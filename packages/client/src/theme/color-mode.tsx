import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";

/**
 * Color-mode ownership moved from next-themes to Astryx's `<Theme>` provider,
 * which writes `data-theme="light|dark"` on `<html>` only when given an
 * explicit mode. This provider resolves "system" itself against the OS media
 * query so the attribute is always set, which is what the legacy token block
 * in globals.css and the Tailwind `dark:` variant key off.
 *
 * The storage key matches next-themes' default ("theme") so an existing
 * visitor's saved choice survives the cutover.
 */

export type ColorMode = "light" | "dark" | "system";
export type ResolvedColorMode = "light" | "dark";

const STORAGE_KEY = "theme";
const QUERY = "(prefers-color-scheme: dark)";

const ColorModeContext = createContext<{
  mode: ColorMode;
  resolvedMode: ResolvedColorMode;
  setMode: (mode: ColorMode) => void;
} | null>(null);

const subscribeToSystemScheme = (onChange: () => void) => {
  const media = window.matchMedia(QUERY);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
};

const readStoredMode = (): ColorMode => {
  const stored = window.localStorage.getItem(STORAGE_KEY);
  return stored === "light" || stored === "dark" ? stored : "system";
};

export function ColorModeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ColorMode>(readStoredMode);

  const setMode = useCallback((next: ColorMode) => {
    window.localStorage.setItem(STORAGE_KEY, next);
    setModeState(next);
  }, []);

  // Subscribed even when an explicit mode is chosen; reading a store this
  // cheap costs less than conditionally mounting the subscription.
  const systemPrefersDark = useSyncExternalStore(
    subscribeToSystemScheme,
    () => window.matchMedia(QUERY).matches,
    () => false
  );

  const resolvedMode: ResolvedColorMode =
    mode === "system" ? (systemPrefersDark ? "dark" : "light") : mode;

  const value = useMemo(
    () => ({ mode, resolvedMode, setMode }),
    [mode, resolvedMode, setMode]
  );

  return <ColorModeContext value={value}>{children}</ColorModeContext>;
}

export function useColorMode() {
  const context = useContext(ColorModeContext);
  if (!context) {
    throw new Error("useColorMode must be used within ColorModeProvider");
  }
  return context;
}
