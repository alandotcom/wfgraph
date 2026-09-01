import { installAuthorizationGrants } from "#src/lib/extensions";
import type { WfGraphOperationId } from "@wfgraph/shared/authorization/operations";

/** Installs a complete authorization snapshot for one isolated client test. */
export function installAuthorizationGrantsForTests(
  operationIds: readonly WfGraphOperationId[]
): void {
  installAuthorizationGrants(operationIds);
}

/** Restores the safe default after a client test changes authorization state. */
export function resetAuthorizationGrantsForTests(): void {
  installAuthorizationGrants([]);
}
