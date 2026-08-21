import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useColorMode } from "./color-mode";
import { ThemeProvider } from "./theme-provider";

function ColorModeProbe() {
  const { mode, resolvedMode } = useColorMode();
  return <p>{`${mode}:${resolvedMode}`}</p>;
}

const createStorage = (): Storage => {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
};

describe("ThemeProvider", () => {
  beforeEach(() => {
    const storage = createStorage();
    vi.stubGlobal("localStorage", storage);
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: storage,
    });
  });

  afterEach(() => {
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.removeAttribute("data-astryx-theme");
    vi.unstubAllGlobals();
  });

  it("applies a saved mode to Astryx and its children", async () => {
    window.localStorage.setItem("theme", "dark");

    render(
      <ThemeProvider>
        <ColorModeProbe />
      </ThemeProvider>
    );

    expect(await screen.findByText("dark:dark")).toBeTruthy();
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.dataset.astryxTheme).toBe("wfgraph");
  });

  it("still renders when browser storage is unavailable", () => {
    window.localStorage.getItem = () => {
      throw new DOMException("Storage denied", "SecurityError");
    };
    window.localStorage.setItem = () => {
      throw new DOMException("Storage denied", "SecurityError");
    };

    expect(() =>
      render(
        <ThemeProvider>
          <ColorModeProbe />
        </ThemeProvider>
      )
    ).not.toThrow();
  });
});
