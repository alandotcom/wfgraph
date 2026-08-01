/**
 * What a host puts in every handler's bag, without every handler asking for it.
 *
 * A database client, a tenant-scoped logger, a feature-flag reader: things an
 * application already has and a handler would otherwise reach for through a
 * module-level singleton. Inngest's shape, so a host that has written an Inngest
 * middleware has written this one.
 *
 * The values travel beside the node's input record rather than inside it. That
 * record is written to the run log as jsonb, and a client put there would be
 * stored, read back as `{}`, and shown to whoever opens the run panel.
 */

/** What a hook is told, and what it answers with more of. */
export type TransformStepInputArgs = {
  /** The action about to run, for a middleware that only serves some of them. */
  readonly actionType: string;
  /** What earlier middleware added, which this one adds to. */
  readonly ctx: Readonly<Record<string, unknown>>;
};

/**
 * A middleware, as a host writes one.
 *
 * Extend it and override the hook you want. The base answers its arguments
 * unchanged, so a middleware states only what it adds.
 */
export abstract class BaseMiddleware {
  /** Names this middleware in a log line. */
  abstract readonly id: string;

  transformStepInput(args: TransformStepInputArgs): TransformStepInputArgs {
    return args;
  }
}

/**
 * Everything the middleware added, for one node.
 *
 * They run in the order the host listed them and the last to run wins, so a
 * middleware later in the list overwrites a key an earlier one set.
 */
export function stepContextFor(
  middleware: readonly BaseMiddleware[],
  actionType: string
): Readonly<Record<string, unknown>> {
  let args: TransformStepInputArgs = { actionType, ctx: {} };

  for (const one of middleware) {
    args = one.transformStepInput(args);
  }

  return args.ctx;
}
