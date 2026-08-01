/**
 * What middleware puts in a handler's bag, and the order two of them settle in.
 */

import { describe, expect, it } from "vitest";
import {
  BaseMiddleware,
  stepContextFor,
  type TransformStepInputArgs,
} from "#src/backend/extensions/middleware";

class Adds extends BaseMiddleware {
  constructor(
    readonly id: string,
    private readonly added: Record<string, unknown>
  ) {
    super();
  }

  override transformStepInput(
    args: TransformStepInputArgs
  ): TransformStepInputArgs {
    return { ...args, ctx: { ...args.ctx, ...this.added } };
  }
}

/** A middleware serving one action alone, which is what the hook is told for. */
class OnlyFor extends BaseMiddleware {
  readonly id = "only-for";

  override transformStepInput(
    args: TransformStepInputArgs
  ): TransformStepInputArgs {
    return args.actionType === "slack/send-message"
      ? { ...args, ctx: { ...args.ctx, scoped: true } }
      : args;
  }
}

describe("stepContextFor", () => {
  it("answers nothing when a host declared no middleware", () => {
    expect(stepContextFor([], "slack/send-message")).toEqual({});
  });

  it("merges what each one added", () => {
    const merged = stepContextFor(
      [new Adds("db", { db: "handle" }), new Adds("log", { log: "logger" })],
      "slack/send-message"
    );

    expect(merged).toEqual({ db: "handle", log: "logger" });
  });

  // Last wins, which is what lets a host put a narrower middleware after a
  // general one rather than reordering the general one around it.
  it("lets a later middleware overwrite an earlier one's key", () => {
    const merged = stepContextFor(
      [
        new Adds("first", { db: "first" }),
        new Adds("second", { db: "second" }),
      ],
      "slack/send-message"
    );

    expect(merged).toEqual({ db: "second" });
  });

  it("tells each one which action it is serving", () => {
    expect(stepContextFor([new OnlyFor()], "slack/send-message")).toEqual({
      scoped: true,
    });
    expect(stepContextFor([new OnlyFor()], "twilio/send-sms")).toEqual({});
  });

  // The base answers its arguments unchanged, so a middleware states only what
  // it adds and overriding no hook is a middleware that does nothing.
  it("passes the context through a middleware that overrides no hook", () => {
    class Silent extends BaseMiddleware {
      readonly id = "silent";
    }

    expect(
      stepContextFor(
        [new Adds("db", { db: "handle" }), new Silent()],
        "slack/send-message"
      )
    ).toEqual({ db: "handle" });
  });
});
