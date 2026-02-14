export type ServiceSuccess<T> = {
  ok: true;
  data: T;
};

export type ServiceFailure<S extends number, E> = {
  ok: false;
  status: S;
  error: E;
};

export type ServiceResult<T, S extends number, E> =
  | ServiceSuccess<T>
  | ServiceFailure<S, E>;

export function success<T>(data: T): ServiceSuccess<T> {
  return { ok: true, data };
}

export function failure<S extends number, E>(
  status: S,
  error: E
): ServiceFailure<S, E> {
  return { ok: false, status, error };
}
