import { describe, expect, it } from "vitest";
import {
  revealCameraStep,
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
  it("places on open, on Browse widening to Focus, and on a new subject", () => {
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

  it("keeps the camera on close, on Focus back to Browse, and while nothing changed", () => {
    expect(
      step({ shown: slot({ level: "focus" }), next: slot({ level: "closed" }) })
    ).toBe("keep");
    expect(
      step({
        shown: slot({ level: "browse" }),
        next: slot({ level: "closed" }),
      })
    ).toBe("keep");
    expect(
      step({ shown: slot({ level: "focus" }), next: slot({ level: "browse" }) })
    ).toBe("keep");
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
