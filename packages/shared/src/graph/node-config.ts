/**
 * Typed reads off a node's config bag.
 *
 * The bag stays open for plugin fields; these helpers own the keys every package
 * used to probe with a local `readConfigString` copy.
 */

import { BUILT_IN_ACTION_IDS } from "#src/actions/built-in-actions";

export function readConfigString(
  config: Record<string, unknown> | undefined,
  key: string
): string | undefined {
  const value = config?.[key];
  return typeof value === "string" ? value : undefined;
}

export function readConfigStringOr(
  config: Record<string, unknown> | undefined,
  key: string,
  fallback: string
): string {
  return readConfigString(config, key) ?? fallback;
}

/** Trimmed string read, for validators that treat whitespace as absent. */
export function readConfigTrimmedString(
  config: Record<string, unknown> | undefined,
  key: string
): string | undefined {
  const value = readConfigString(config, key)?.trim();
  return value && value.length > 0 ? value : undefined;
}

/** Minimal node shape shared helpers accept (persisted or editor). */
export type NodeConfigSource = {
  data: {
    type: string;
    enabled?: boolean;
    config?: Record<string, unknown>;
  };
};

export function actionTypeOf(
  node: NodeConfigSource | undefined
): string | undefined {
  if (!node || node.data.type !== "action") {
    return undefined;
  }
  return readConfigString(node.data.config, "actionType");
}

export function enabledActionTypeOf(
  node: NodeConfigSource | undefined
): string | undefined {
  return node?.data.enabled === false ? undefined : actionTypeOf(node);
}

export function isWaitActionType(value: unknown): boolean {
  return value === BUILT_IN_ACTION_IDS.wait;
}

export function isWaitNode(node: NodeConfigSource | undefined): boolean {
  if (!node || node.data.type !== "action") {
    return false;
  }
  return isWaitActionType(actionTypeOf(node));
}

/** A Wait node that parks on Events rather than on a clock. */
export function isEventWaitNode(node: NodeConfigSource | undefined): boolean {
  return (
    isWaitNode(node) &&
    readConfigString(node?.data.config, "waitMode") === "event"
  );
}

/**
 * The entry node, which every graph has one of. `data.type` is the field the
 * wire schema requires; React Flow's own top-level `type` is optional there.
 */
export function isLifecycleNode(node: NodeConfigSource | undefined): boolean {
  return node?.data.type === "lifecycle";
}

export function isConditionNode(node: NodeConfigSource | undefined): boolean {
  if (!node || node.data.type !== "action") {
    return false;
  }
  return actionTypeOf(node) === BUILT_IN_ACTION_IDS.condition;
}

export function isEventSplitActionNode(
  node: NodeConfigSource | undefined
): boolean {
  if (!node || node.data.type !== "action") {
    return false;
  }
  return actionTypeOf(node) === BUILT_IN_ACTION_IDS.eventSplit;
}
