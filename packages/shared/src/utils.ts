import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import { z } from "zod";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** An `{ message }` carrier, the shape SDKs nest one level down. */
const nestedErrorSchema = z.looseObject({
  message: z.string().optional().catch(undefined),
});

/**
 * The union of every place a thrown value is known to carry its message.
 *
 * A thrown value arrives as `unknown`, so this is where it becomes typed. Each
 * member is `.optional().catch(undefined)` so a field of the wrong type is
 * dropped while its siblings survive, which is how the per-field `typeof`
 * checks below used to behave. `looseObject` keeps unknown keys and accepts
 * class instances, so an SDK error object passes with its own fields intact.
 */
const errorEnvelopeSchema = z.looseObject({
  message: z.string().optional().catch(undefined),
  // Some SDKs put the HTTP body on the error, with `error` as text or an object.
  responseBody: z
    .looseObject({
      error: z
        .union([z.string(), nestedErrorSchema])
        .optional()
        .catch(undefined),
    })
    .optional()
    .catch(undefined),
  error: z.union([z.string(), nestedErrorSchema]).optional().catch(undefined),
  data: z
    .looseObject({
      error: z.string().optional().catch(undefined),
      message: z.string().optional().catch(undefined),
    })
    .optional()
    .catch(undefined),
  reason: z.string().optional().catch(undefined),
  statusText: z.string().optional().catch(undefined),
  status: z.number().optional().catch(undefined),
});

/**
 * A Promise-like: any object carrying a callable `then`. The object test is the
 * parse; the refinement reads the one member that makes it awaitable, off a
 * value zod has already typed.
 */
const thenableSchema = z
  .looseObject({})
  .refine((value) => typeof value.then === "function");

/**
 * Extract a meaningful error message from various error types.
 * Handles Error instances, objects with message/error properties, strings,
 * and nested error structures common in API/provider SDKs.
 * Note: This is synchronous - use getErrorMessageAsync for Promise errors.
 */
export function getErrorMessage(error: unknown): string {
  // Handle null/undefined
  if (error === null || error === undefined) {
    return "Unknown error";
  }

  // Handle Error instances (and their subclasses)
  if (error instanceof Error) {
    // Some errors have a cause property with more details
    if (error.cause && error.cause instanceof Error) {
      return `${error.message}: ${error.cause.message}`;
    }
    return error.message;
  }

  // Handle strings
  if (typeof error === "string") {
    return error;
  }

  // Handle objects
  const envelope = errorEnvelopeSchema.safeParse(error);
  if (envelope.success) {
    const obj = envelope.data;

    // Check for common error message properties
    if (obj.message) {
      return obj.message;
    }

    // Some SDKs wrap errors in responseBody or data
    const body = obj.responseBody;
    if (body) {
      if (typeof body.error === "string") {
        return body.error;
      }
      if (body.error?.message !== undefined) {
        return body.error.message;
      }
    }

    // Check for nested error property
    if (typeof obj.error === "string") {
      if (obj.error) {
        return obj.error;
      }
    } else if (obj.error?.message !== undefined) {
      return obj.error.message;
    }

    // Check for data.error pattern (common in API responses)
    const data = obj.data;
    if (data) {
      if (data.error !== undefined) {
        return data.error;
      }
      if (data.message !== undefined) {
        return data.message;
      }
    }

    // Check for reason property (common in some error types)
    if (obj.reason) {
      return obj.reason;
    }

    // Check for statusText (HTTP errors)
    if (obj.statusText) {
      const status = obj.status === undefined ? "" : ` (${obj.status})`;
      return `${obj.statusText}${status}`;
    }

    // Try to stringify the error object (but avoid [object Object])
    try {
      const stringified = JSON.stringify(error, null, 0);
      if (stringified && stringified !== "{}" && stringified.length < 500) {
        return stringified;
      }
    } catch {
      // Ignore stringify errors
    }

    // Last resort: use Object.prototype.toString
    const objectToString = Object.prototype.toString.call(error);
    if (objectToString !== "[object Object]") {
      return objectToString;
    }
  }

  return "Unknown error";
}

/**
 * Async version that handles Promise errors by awaiting them first.
 * Use this in catch blocks where the error might be a Promise.
 */
export async function getErrorMessageAsync(error: unknown): Promise<string> {
  // If error is a Promise, await it to get the actual error
  if (error instanceof Promise) {
    try {
      const resolvedValue = await error;
      // The promise resolved - check if it contains error info
      return getErrorMessage(resolvedValue);
    } catch (rejectedError) {
      return getErrorMessage(rejectedError);
    }
  }

  // Check if it's a thenable (Promise-like)
  if (thenableSchema.safeParse(error).success) {
    try {
      const resolvedValue = await Promise.resolve(error);
      // The promise resolved - check if it contains error info
      return getErrorMessage(resolvedValue);
    } catch (rejectedError) {
      return getErrorMessage(rejectedError);
    }
  }

  return getErrorMessage(error);
}
