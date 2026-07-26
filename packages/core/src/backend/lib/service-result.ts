/**
 * Why a service call failed, stated in the domain's own terms.
 *
 * Services return one of these instead of an HTTP status so that nothing inside
 * the backend has to know how the failure will eventually be transported. The
 * adapters at the edges (the oRPC error mapper, the HTTP response helper) each
 * translate a kind into whatever their transport expects.
 *
 * - `invalid`: the caller's input or the resource it points at does not pass validation.
 * - `unauthorized`: the caller's credentials did not authenticate. This is distinct from
 *   `invalid` because the inbound webhook and wait-hook endpoints are reached by third
 *   parties, who need to tell a rejected API key apart from a malformed request.
 * - `not_found`: the addressed resource does not exist.
 * - `conflict`: the request collides with existing state, such as a duplicate name.
 * - `internal`: something failed on our side and the caller cannot fix it.
 */
export type ServiceFailureKind =
  | "invalid"
  | "unauthorized"
  | "not_found"
  | "conflict"
  | "internal";

export type ServiceSuccess<T> = {
  ok: true;
  data: T;
};

export type ServiceFailure<K extends ServiceFailureKind, E> = {
  ok: false;
  kind: K;
  error: E;
};

export type ServiceResult<T, K extends ServiceFailureKind, E> =
  | ServiceSuccess<T>
  | ServiceFailure<K, E>;

export function success<T>(data: T): ServiceSuccess<T> {
  return { ok: true, data };
}

export function failure<K extends ServiceFailureKind, E>(
  kind: K,
  error: E
): ServiceFailure<K, E> {
  return { ok: false, kind, error };
}
