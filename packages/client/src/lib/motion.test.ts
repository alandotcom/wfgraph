import { afterEach, describe, expect, it, vi } from "vitest";
import { viewportAnimationDuration } from "#src/lib/motion";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("viewportAnimationDuration", () => {
  it("keeps the standard viewport transition when motion is allowed", () => {
    vi.spyOn(window, "matchMedia").mockReturnValue({
      matches: false,
    } as MediaQueryList);

    expect(viewportAnimationDuration()).toBe(300);
  });

  it("snaps the viewport when reduced motion is requested", () => {
    vi.spyOn(window, "matchMedia").mockReturnValue({
      matches: true,
    } as MediaQueryList);

    expect(viewportAnimationDuration()).toBe(0);
  });
});
