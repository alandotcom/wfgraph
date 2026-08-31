/**
 * What a node may address, as the Events that can reach it agree on it.
 *
 * Several Events reaching one node is the ordinary case (ADR-0007), and each
 * carries its own payload. This module is the one answer to what that leaves
 * addressable: a path every Event declares is guaranteed, a path only some
 * declare arrives absent on the rest, and a path they type differently has no
 * answer at all. The picker and the save both read it, so an editor that offers
 * a path and a save that refuses it cannot drift apart.
 */

import { compact, uniq } from "es-toolkit/array";
import type { EventMetadata } from "#src/extensions/catalog";
import type { ReferenceField } from "#src/graph/node-references";
import type {
  WorkflowSchemaFieldType,
  WorkflowSchemaItemType,
} from "#src/graph/schema-codec";

/**
 * One path, reconciled across the Events that can reach the node.
 *
 * `nullable` covers both ways a value goes missing: an Event declaring the path
 * may send null, and an Event never declaring it sends nothing. `typeClash` is
 * the case with no reconciled answer, which is why `type` is absent there rather
 * than guessed.
 */
export type ReachableField = ReferenceField & {
  /** The Events declaring this path, in the order they reach the node. */
  declaredBy: string[];
  typeClash?: { types: WorkflowSchemaFieldType[]; events: string[] };
};

type Declaration = { event: EventMetadata; field: ReferenceField };

/**
 * The one type these declarations agree on, or the clash between them.
 *
 * An undeclared type states nothing, so it neither agrees nor disagrees; what
 * decides is how many distinct declared types there are.
 */
function reconcileType(declarations: Declaration[]): {
  type?: WorkflowSchemaFieldType;
  typeClash?: ReachableField["typeClash"];
} {
  const distinct = uniq(
    compact(declarations.map((declaration) => declaration.field.type))
  );

  if (distinct.length < 2) {
    return distinct[0] ? { type: distinct[0] } : {};
  }

  return {
    typeClash: {
      types: distinct,
      events: declarations
        .filter((declaration) => declaration.field.type)
        .map((declaration) => declaration.event.name),
    },
  };
}

function reconcileDescription(declarations: Declaration[]): string | undefined {
  return declarations.find((declaration) => declaration.field.description)
    ?.field.description;
}

/**
 * The enum values, kept only where every Event declares the same set. A value
 * one Event allows and another does not is not a value the path is held to.
 */
function reconcileEnumValues(
  declarations: Declaration[]
): string[] | undefined {
  const sets = uniq(
    declarations.map((declaration) =>
      (declaration.field.enumValues ?? []).toSorted().join(" ")
    )
  );

  return sets.length === 1 && declarations[0]?.field.enumValues
    ? [...declarations[0].field.enumValues]
    : undefined;
}

/**
 * The type an open record's keys carry, kept only where every Event declaring
 * the path opens it onto the same one.
 *
 * An Event declaring the path as a closed object contributes no value type, and
 * that disagreement closes the reconciled path: a key one Event carries and
 * another does not is not a key a rule may be built on.
 */
function reconcileValueType(
  declarations: Declaration[]
): WorkflowSchemaItemType | undefined {
  const distinct = uniq(
    declarations.map((declaration) => declaration.field.valueType)
  );

  return distinct.length === 1 ? distinct[0] : undefined;
}

/**
 * The Events among these that leave the path out of their payload, by name.
 *
 * Part of the reconciliation contract rather than a caller's own arithmetic: it
 * is the half of `nullable` that says a run can arrive without the path at all.
 */
export function absentOn(
  field: ReachableField,
  events: readonly EventMetadata[]
): string[] {
  return events
    .map((event) => event.name)
    .filter((name) => !field.declaredBy.includes(name));
}

/**
 * Every path any of these Events declares, each reconciled once and offered in
 * the order the Events declare them.
 *
 * A path only some Events declare is kept rather than hidden: it is reachable
 * on the runs that carry it, and `nullable` is what says the others do not. What
 * a caller does with that is its own decision -- the picker labels it, the save
 * holds a required target to it.
 */
export function reachableEventFields(
  events: readonly EventMetadata[]
): ReachableField[] {
  const declarationsByPath = new Map<string, Declaration[]>();

  for (const event of events) {
    for (const field of event.payloadFields) {
      const declarations = declarationsByPath.get(field.path);
      if (declarations) {
        declarations.push({ event, field });
      } else {
        declarationsByPath.set(field.path, [{ event, field }]);
      }
    }
  }

  return Array.from(declarationsByPath.entries()).map(
    ([path, declarations]) => {
      const { type, typeClash } = reconcileType(declarations);
      const description = reconcileDescription(declarations);
      const enumValues = reconcileEnumValues(declarations);
      const valueType = reconcileValueType(declarations);

      return {
        path,
        ...(description ? { description } : {}),
        ...(type ? { type } : {}),
        ...(valueType ? { valueType } : {}),
        ...(enumValues ? { enumValues } : {}),
        ...(typeClash ? { typeClash } : {}),
        ...(declarations.length < events.length ||
        declarations.some((declaration) => declaration.field.nullable)
          ? { nullable: true }
          : {}),
        declaredBy: declarations.map((declaration) => declaration.event.name),
      };
    }
  );
}
