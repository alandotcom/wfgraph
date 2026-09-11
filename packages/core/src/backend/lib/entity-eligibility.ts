import { createHash } from "node:crypto";

/** Stable non-sensitive reference to one serialized Entity Eligibility condition. */
export function entityEligibilityConditionId(condition: string): string {
  return createHash("sha256").update(condition).digest("hex");
}
