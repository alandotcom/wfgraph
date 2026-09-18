import { describe, expect, it } from "vitest";
import {
  mobileSheetCameraStep,
  revealCameraStep,
  type MobileSheetCameraSlot,
  type RevealCameraSlot,
  type RevealPlacementRequest,
} from "./reveal-camera";

const slot = (overrides: Partial<RevealCameraSlot>): RevealCameraSlot => ({
  addressId: "wf|draft|overview",
  subjectKey: "node:a",
  level: "browse",
  occupiedWidth: 368,
  resizeSequence: 0,
  ...overrides,
});

const step = (input: {
  shown: RevealCameraSlot | null;
  next: RevealCameraSlot;
  request?: RevealPlacementRequest;
  answeredSequence?: number;
}) =>
  revealCameraStep({
    shown: input.shown,
    next: input.next,
    request: input.request ?? null,
    answeredSequence: input.answeredSequence ?? 0,
  });

describe("revealCameraStep", () => {
  it("places on open, on an occupied-width increase, and on a new subject", () => {
    expect(
      step({
        shown: slot({ level: "closed", occupiedWidth: 0 }),
        next: slot({}),
      })
    ).toBe("place");
    expect(step({ shown: slot({}), next: slot({ occupiedWidth: 648 }) })).toBe(
      "place"
    );
    expect(
      step({ shown: slot({}), next: slot({ subjectKey: "node:b" }) })
    ).toBe("place");
  });

  it("keeps the camera on close, on same-width level changes, and while nothing changed", () => {
    expect(
      step({ shown: slot({ level: "focus" }), next: slot({ level: "closed" }) })
    ).toBe("keep");
    expect(
      step({
        shown: slot({ level: "browse" }),
        next: slot({ level: "closed" }),
      })
    ).toBe("keep");
    expect(step({ shown: slot({}), next: slot({ level: "focus" }) })).toBe(
      "keep"
    );
    expect(
      step({ shown: slot({ level: "focus" }), next: slot({ level: "browse" }) })
    ).toBe("keep");
    expect(step({ shown: slot({ occupiedWidth: 648 }), next: slot({}) })).toBe(
      "keep"
    );
    expect(step({ shown: slot({}), next: slot({}) })).toBe("keep");
    expect(
      step({
        shown: slot({ level: "closed" }),
        next: slot({ level: "closed", subjectKey: null }),
      })
    ).toBe("keep");
  });

  it("leaves a new address to the scope camera, and waits for a first slot", () => {
    expect(
      step({
        shown: slot({}),
        next: slot({ addressId: "wf|runs|overview", level: "closed" }),
      })
    ).toBe("keep");
    expect(step({ shown: null, next: slot({}) })).toBe("keep");
  });

  it("answers a placement request for the shown address, across an address change", () => {
    const request = {
      addressId: "wf|draft|group:g1",
      nodeIds: ["a"],
      sequence: 3,
    };
    const next = slot({ addressId: "wf|draft|group:g1" });
    expect(step({ shown: slot({}), next, request })).toBe("place-request");
    expect(step({ shown: null, next, request })).toBe("place-request");
    expect(step({ shown: slot({}), next, request, answeredSequence: 3 })).toBe(
      "keep"
    );
    expect(step({ shown: slot({}), next: slot({}), request })).toBe("keep");
  });
});

describe("mobileSheetCameraStep", () => {
  const address = "wf|draft|overview";
  const sheet = (
    depth: number,
    id: string,
    level: "summary" | "inspector" = "summary"
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
        next: sheet(2, "a", "inspector"),
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
      level: "summary" | "inspector"
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
        next: addressSheet(2, "inspector"),
      })
    ).toBe("keep");
  });
});
