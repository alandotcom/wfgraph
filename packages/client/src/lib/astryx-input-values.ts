import type { ISODateTimeString } from "@astryxdesign/core/DateTimeInput";
import type { ISOTimeString } from "@astryxdesign/core/TimeInput";
import { createISOTimeString } from "@astryxdesign/core/utils";

const ISO_LOCAL_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/;

function isISODateTimeString(value: string): value is ISODateTimeString {
  return ISO_LOCAL_DATE_TIME.test(value);
}

export function toISODateTimeString(
  value: string | undefined
): ISODateTimeString | undefined {
  return value && isISODateTimeString(value) ? value : undefined;
}

export function toISOTimeString(
  value: string | undefined
): ISOTimeString | undefined {
  return value ? (createISOTimeString(value) ?? undefined) : undefined;
}
