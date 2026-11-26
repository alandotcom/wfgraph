import { describe, expect, it } from "vitest";
import {
  mobileSheetCameraStep,
  type MobileSheetCameraSlot,
} from "./reveal-camera";

describe("mobileSheetCameraStep", () => {
  const address = "wf|draft|overview";
  const sheet = (
    depth: number,
    id: string,
    level: "summary" | "full" = "summary"
  ): MobileSheetCameraSlot => ({
    addressId: address,
    sheet: { depth, level, inspected: { kind: "node", id } },
  });
  const none: MobileSheetCameraSlot = { addressId: address, sheet: null };

  it("places a summary sheet that opens over the canvas or over another sheet", () => {
    expect(mobileSheetCameraStep({ shown: none, next: sheet(1, "a") })).toBe(
      "place"
    );
    expect(
      mobileSheetCameraStep({
        shown: sheet(1, "split"),
        next: sheet(2, "wait"),
      })
    ).toBe("place");
    expect(
      mobileSheetCameraStep({ shown: sheet(1, "a"), next: sheet(1, "b") })
    ).toBe("place");
  });

  it("keeps the camera on Back, for the inspector, and in a new address", () => {
    expect(
      mobileSheetCameraStep({
        shown: sheet(2, "wait"),
        next: sheet(1, "split"),
      })
    ).toBe("keep");
    expect(
      mobileSheetCameraStep({
        shown: sheet(1, "a"),
        next: sheet(2, "a", "full"),
      })
    ).toBe("keep");
    expect(
      mobileSheetCameraStep({
        shown: { addressId: "wf|runs|run_1", sheet: null },
        next: sheet(1, "a"),
      })
    ).toBe("keep");
    expect(mobileSheetCameraStep({ shown: null, next: sheet(1, "a") })).toBe(
      "keep"
    );
    expect(mobileSheetCameraStep({ shown: sheet(1, "a"), next: none })).toBe(
      "keep"
    );
  });

  it("places an address sheet over the bottom of the canvas and keeps the camera under an address inspector", () => {
    const addressSheet = (
      depth: number,
      level: "summary" | "full"
    ): MobileSheetCameraSlot => ({
      addressId: address,
      sheet: { depth, level, inspected: null },
    });
    expect(
      mobileSheetCameraStep({
        shown: addressSheet(1, "summary"),
        next: addressSheet(2, "summary"),
      })
    ).toBe("place");
    expect(
      mobileSheetCameraStep({
        shown: addressSheet(1, "summary"),
        next: addressSheet(2, "full"),
      })
    ).toBe("keep");
  });
});
