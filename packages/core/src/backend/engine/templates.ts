/**
 * Replacing the `{{@nodeId:Label.field}}` references in a node's config with the
 * values the nodes upstream of it left behind.
 */

import {
  isEntityStateSourceId,
  parseTemplate,
  resolveOutputPath,
  type TemplateToken,
} from "@wfgraph/shared/graph/node-references";
import type { TemplateJsonShape } from "@wfgraph/shared/plugins/action-fields";
import { mapTemplateConfigStrings } from "@wfgraph/shared/plugins/template-config";
import type { NodeOutputs } from "#src/backend/engine/contracts";
import type { EntityTemplateContext } from "#src/backend/engine/entities";
import { outputKey } from "#src/backend/engine/traversal";

/**
 * Render a resolved value back into the surrounding template string. Objects and
 * arrays become JSON so a whole node output can be dropped into a text field.
 * A missing value renders as empty text, which is what an upstream node that was
 * disabled or that failed to produce the field leaves behind.
 */
function stringifyTemplateValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    return value;
  }
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return `${value}`;
  }
  if (typeof value === "symbol") {
    return value.toString();
  }
  return "";
}

function resolveTemplateToken(
  token: TemplateToken,
  outputs: NodeOutputs,
  entityContext?: EntityTemplateContext
): string {
  if (isEntityStateSourceId(token.nodeId)) {
    return entityContext?.sourceId === token.nodeId &&
      entityContext.entityType === token.sourceType
      ? stringifyTemplateValue(entityContext.values[token.fieldPath])
      : token.raw;
  }

  const output = outputs[outputKey(token.nodeId)];
  if (!output) {
    // The token names a node that has not run, so the authored text stays put.
    return token.raw;
  }

  return stringifyTemplateValue(
    resolveOutputPath(output.data, token.fieldPath)
  );
}

/**
 * Replace every `{{@nodeId:Label.field}}` reference in the config's string values
 * with the upstream value it names.
 *
 * Both the grammar and the path walking come from `node-references`, the module
 * the editor's autocomplete builds its suggestions with, so a path it offers
 * (`items[0].name`, say) resolves to the same value here at run time.
 *
 * A key holding `undefined` is dropped rather than carried, because a step decodes
 * its config through its schema's canonical JSON codec, where an optional field
 * takes an absent key or a null and refuses one present and empty. A builder left
 * the field blank either way.
 *
 * `literalKeys` are the keys the action declared `literal`, whose values pass
 * through as they were authored.
 *
 * `jsonShapes` names the keys whose text is JSON holding authored values, and
 * which layout each is in. Those resolve one value at a time, because
 * substituting into the whole string lets a resolved `"` or newline break the
 * JSON and cost the step every value in it rather than one.
 */
export function processTemplates(
  config: Record<string, unknown>,
  outputs: NodeOutputs,
  literalKeys: ReadonlySet<string>,
  jsonShapes: ReadonlyMap<string, TemplateJsonShape> = new Map(),
  entityContext?: EntityTemplateContext
): Record<string, unknown> {
  return mapTemplateConfigStrings(
    config,
    { literalKeys, jsonShapes },
    ({ value }) => resolveTemplateString(value, outputs, entityContext)
  );
}

/** One authored string with its references replaced. */
export function resolveTemplateString(
  value: string,
  outputs: NodeOutputs,
  entityContext?: EntityTemplateContext
): string {
  return parseTemplate(value)
    .map((segment) =>
      segment.kind === "literal"
        ? segment.text
        : resolveTemplateToken(segment.token, outputs, entityContext)
    )
    .join("");
}
