import {
  LinearError,
  type LinearErrorRaw,
  parseLinearError,
} from "@linear/sdk";
import { z } from "zod";

/**
 * The error payload Linear's `parseLinearError` reads: the GraphQL request that
 * failed, the response that came back with its status and GraphQL errors, and a
 * top-level message. Anything caught while talking to Linear arrives as `unknown`,
 * so this schema is the boundary that decides whether Linear can classify it.
 *
 * Every level stays open, because Linear reads fields this schema does not name
 * (`response.data`, `response.headers`) and the validated value is handed on to
 * Linear whole. The named fields are the ones Linear reads unguarded: a `message`
 * that is not a string, or a `response.errors` that is not a list of objects,
 * makes Linear's own parsing throw.
 *
 * Fields are described as the API sends them. Linear's LinearErrorRaw types both
 * the per-error `message` and `extensions.type` as its LinearErrorType enum, while
 * the wire carries readable text ("Authentication required") and a lowercase
 * phrase ("authentication error") that Linear maps back to the enum itself.
 */
const linearGraphqlErrorSchema = z.looseObject({
  message: z.string().optional(),
  path: z.array(z.string()).optional(),
  extensions: z
    .looseObject({
      type: z.string().optional(),
      userError: z.boolean().optional(),
      userPresentableMessage: z.string().optional(),
    })
    .optional(),
});

const linearErrorRawSchema = z.looseObject({
  name: z.string().optional(),
  message: z.string().optional(),
  request: z
    .looseObject({
      query: z.string().optional(),
      variables: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
  response: z
    .looseObject({
      status: z.number().optional(),
      error: z.string().optional(),
      errors: z.array(linearGraphqlErrorSchema).optional(),
    })
    .optional(),
});

/**
 * Normalizes anything thrown while talking to Linear into a LinearError, which is
 * what the steps read an error type and a message from. The SDK wraps its own
 * failures, so the remaining cases are a raw error payload from a GraphQL client,
 * a plain Error, and a bare string.
 */
export function toLinearError(error: unknown): LinearError {
  if (error instanceof LinearError) {
    return error;
  }

  const raw = linearErrorRawSchema.safeParse(error);

  if (raw.success) {
    // Linear's own type for this payload disagrees with what its API sends for the
    // GraphQL error fields, so the validated value goes back under Linear's type.
    // The assertion narrows `message` and `extensions.type` from the string the wire
    // carries to Linear's enum, which holds because Linear maps that text back itself.
    // Removing the assertion turns this into a type error, so the narrowing is the
    // point rather than an oversight.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    return parseLinearError(raw.data as LinearErrorRaw);
  }

  if (error instanceof Error) {
    return parseLinearError({ name: error.name, message: error.message });
  }

  if (typeof error === "string") {
    return parseLinearError({ message: error });
  }

  return parseLinearError();
}
