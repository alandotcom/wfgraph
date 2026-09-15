import { describe, expect, it } from "vitest";
import {
  revealCameraStep,
  untouchedBefore,
  type RevealCameraSlot,
  type RevealPlacementRequest,
} from "./reveal-camera";

const slot = (overrides: Partial<RevealCameraSlot>): RevealCameraSlot => ({
  addressId: "wf|draft|overview",
  subjectKey: "node:a",
  level: "browse",
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
  it("places on open, on a level change, and on a new subject", () => {
    expect(step({ shown: slot({ level: "closed" }), next: slot({}) })).toBe(
      "place"
    );
    expect(step({ shown: slot({}), next: slot({ level: "focus" }) })).toBe(
      "place"
    );
    expect(
      step({ shown: slot({}), next: slot({ subjectKey: "node:b" }) })
    ).toBe("place");
  });

  it("restores on close and keeps while nothing changed", () => {
    expect(
      step({ shown: slot({ level: "focus" }), next: slot({ level: "closed" }) })
    ).toBe("restore");
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

describe("untouchedBefore", () => {
  const before = { centerX: 0, centerY: 0, zoom: 1 };
  const placed = { centerX: 120, centerY: 0, zoom: 1 };
  const stored = { before, placed };

  it("answers the camera from before Reveal while the viewport sits where it was placed", () => {
    expect(untouchedBefore(placed, stored)).toBe(before);
  });

  it("treats a sub-pixel difference as the same camera", () => {
    const nearly = { centerX: 120.3, centerY: 0.2, zoom: 1.0004 };
    expect(untouchedBefore(nearly, stored)).toBe(before);
  });

  it("answers null once a person moved the camera, or with no placement", () => {
    const panned = { centerX: 400, centerY: 90, zoom: 1 };
    expect(untouchedBefore(panned, stored)).toBeNull();
    expect(untouchedBefore(placed, null)).toBeNull();
  });
});
