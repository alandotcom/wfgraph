/**
 * The repository's structural lint rules, loaded by oxlint as the `wfgraph` JS
 * plugin (`.oxlintrc.json`, `jsPlugins`). Each rule names the helper to write
 * instead of the hand-rolled shape it reports; AGENTS.md ("Code cleanliness")
 * holds the same list in prose. The node types come from `@oxlint/plugins`, so
 * each visitor handler receives the node it is keyed by, already narrowed.
 */

import type { CreateRule, ESTree, Plugin } from "@oxlint/plugins";

/** Any node a field of the tree can hold, including a hole or an absent child. */
type MaybeNode = ESTree.Node | null | undefined;

function isIdentifierNamed(node: MaybeNode, name: string): boolean {
  return node?.type === "Identifier" && node.name === name;
}

/** The name of a dotted property access, or undefined for anything else. */
function memberPropertyName(node: MaybeNode): string | undefined {
  return node?.type === "MemberExpression" &&
    !node.computed &&
    node.property.type === "Identifier"
    ? node.property.name
    : undefined;
}

/** Whether a node is a call of the form `<anything>.<name>(...)`. */
function isMethodCall(node: ESTree.CallExpression, name: string): boolean {
  return memberPropertyName(node.callee) === name;
}

/** Whether a node is a call of the form `<namespace>.<name>(...)`. */
function isNamespacedCall(
  node: MaybeNode,
  namespace: string,
  name: string
): boolean {
  return (
    node?.type === "CallExpression" &&
    node.callee.type === "MemberExpression" &&
    isIdentifierNamed(node.callee.object, namespace) &&
    memberPropertyName(node.callee) === name
  );
}

/**
 * Whether a node is `new Set(values)`. A `new Set()` with no argument builds an
 * empty set for a caller to fill, which is not the dedupe `uniq` replaces.
 */
function isDedupeSet(node: MaybeNode): boolean {
  return (
    node?.type === "NewExpression" &&
    isIdentifierNamed(node.callee, "Set") &&
    node.arguments.length === 1
  );
}

function isEmptyObjectLiteral(node: MaybeNode): boolean {
  return node?.type === "ObjectExpression" && node.properties.length === 0;
}

/** Whether a node reads `value === undefined` or `value !== undefined`. */
function isUndefinedComparison(node: MaybeNode): boolean {
  return (
    node?.type === "BinaryExpression" &&
    (node.operator === "===" || node.operator === "!==") &&
    (isIdentifierNamed(node.left, "undefined") ||
      isIdentifierNamed(node.right, "undefined"))
  );
}

/** A node's source offsets, as a key a Set can hold. */
function rangeKey(node: ESTree.Node): string {
  return `${node.start}:${node.end}`;
}

const noFilterBoolean = {
  meta: {
    messages: {
      noFilterBoolean: "Use compact from es-toolkit/array.",
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        if (
          isMethodCall(node, "filter") &&
          node.arguments.length === 1 &&
          isIdentifierNamed(node.arguments[0], "Boolean")
        ) {
          context.report({ node, messageId: "noFilterBoolean" });
        }
      },
    };
  },
} satisfies CreateRule;

const noSetSpreadUniq = {
  meta: {
    messages: {
      noSetSpreadUniq: "Use uniq from es-toolkit/array.",
    },
  },
  create(context) {
    return {
      // `[...new Set(x)]`, and nothing else in the literal. A hole counts as
      // an element, so `[, ...new Set(x)]` is a two-element literal.
      ArrayExpression(node) {
        const only = node.elements.length === 1 ? node.elements[0] : undefined;
        if (only?.type === "SpreadElement" && isDedupeSet(only.argument)) {
          context.report({ node, messageId: "noSetSpreadUniq" });
        }
      },

      // `Array.from(new Set(x))`. `Array.from(new Set(x), fn)` maps as it
      // reads, which `uniq` does not do, so it is left alone.
      CallExpression(node) {
        if (
          isNamespacedCall(node, "Array", "from") &&
          node.arguments.length === 1 &&
          isDedupeSet(node.arguments[0])
        ) {
          context.report({ node, messageId: "noSetSpreadUniq" });
        }
      },
    };
  },
} satisfies CreateRule;

const noEntriesRoundTrip = {
  meta: {
    messages: {
      noEntriesRoundTrip:
        "Use mapValues, pickBy or omitBy from es-toolkit/object. Those helpers assign result[key] = value, so an object that can carry an own __proto__ key, such as stored JSON or a webhook body, keeps Object.fromEntries with a disable comment.",
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        if (!isNamespacedCall(node, "Object", "fromEntries")) {
          return;
        }

        // The argument is `Object.entries(x).map(...)` or `.filter(...)`, so the
        // reported call reads two levels down from `Object.fromEntries`.
        const source = node.arguments[0];
        if (
          source?.type !== "CallExpression" ||
          source.callee.type !== "MemberExpression"
        ) {
          return;
        }

        const method = memberPropertyName(source.callee);
        if (
          (method === "map" || method === "filter") &&
          isNamespacedCall(source.callee.object, "Object", "entries")
        ) {
          context.report({ node, messageId: "noEntriesRoundTrip" });
        }
      },
    };
  },
} satisfies CreateRule;

const noConditionalSpread = {
  meta: {
    messages: {
      noConditionalSpread:
        "Use omitUndefined from @wfgraph/shared/utils/omit-undefined, or omitBy from es-toolkit/object with isNil from es-toolkit/predicate when null must go too. Inside a literal that spreads a base object, spread omitUndefined({ ... }) after the base.",
    },
  },
  create(context) {
    return {
      ObjectExpression(node) {
        // Only the first spread in the literal is a candidate. A spread that
        // follows another one sits on top of a base object, and wrapping the
        // whole literal in omitUndefined would delete the base's value for the
        // key; the fix there is omitUndefined around the added keys alone.
        const spread = node.properties.find(
          (property) => property.type === "SpreadElement"
        );
        if (spread?.argument.type !== "ConditionalExpression") {
          return;
        }

        // The shape omitUndefined replaces: one arm is the empty object, and
        // the test is an undefined check rather than a truthiness check. A
        // truthy test also drops "" and 0, which omitUndefined keeps.
        const { test, consequent, alternate } = spread.argument;
        if (
          isUndefinedComparison(test) &&
          (isEmptyObjectLiteral(consequent) || isEmptyObjectLiteral(alternate))
        ) {
          context.report({ node: spread, messageId: "noConditionalSpread" });
        }
      },
    };
  },
} satisfies CreateRule;

const noLocaleCompare = {
  meta: {
    messages: {
      noLocaleCompare: "Use compareText from @wfgraph/shared/types/string.",
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        if (isMethodCall(node, "localeCompare")) {
          context.report({ node, messageId: "noLocaleCompare" });
        }
      },
    };
  },
} satisfies CreateRule;

/**
 * The function names a hand-rolled plain-object guard is given. `isRecord` is
 * not one of them: a record here is a database row, and a guard by that name is
 * usually about a row rather than about a plain object.
 */
const objectGuardNames = new Set(["isJsonObject", "isPlainObject"]);

/** The value types a hand-rolled `Record` predicate narrows to. */
const wideValueTypes = new Set(["TSUnknownKeyword", "TSAnyKeyword"]);

const noHandRolledObjectGuard = {
  meta: {
    messages: {
      noHandRolledObjectGuard:
        "Use isJsonObject from @wfgraph/shared/types/json for a JsonValue, or isPlainObject from es-toolkit/predicate for unknown.",
    },
  },
  create(context) {
    return {
      FunctionDeclaration(node) {
        if (node.id !== null && objectGuardNames.has(node.id.name)) {
          context.report({ node, messageId: "noHandRolledObjectGuard" });
        }
      },

      // `x is Record<string, unknown>` and `x is Record<string, any>`, whatever
      // the function holding the predicate is called.
      TSTypePredicate(node) {
        const reference = node.typeAnnotation?.typeAnnotation;
        if (
          reference?.type !== "TSTypeReference" ||
          !isIdentifierNamed(reference.typeName, "Record")
        ) {
          return;
        }

        const params = reference.typeArguments?.params ?? [];
        const [key, value] = params;
        if (
          params.length === 2 &&
          key?.type === "TSStringKeyword" &&
          value !== undefined &&
          wideValueTypes.has(value.type)
        ) {
          context.report({ node, messageId: "noHandRolledObjectGuard" });
        }
      },
    };
  },
} satisfies CreateRule;

const noChangedFlag = {
  meta: {
    messages: {
      noChangedFlag:
        "Use mapOrSame or mapValuesOrSame from @wfgraph/shared/utils/map-or-same.",
    },
  },
  create(context) {
    // The declarations that open a `for` loop. A loop counter is the one place
    // this flag is not standing in for mapOrSame, and a visitor reaches the
    // ForStatement before the declaration in its initializer, so recording the
    // initializer's offsets here is enough to skip it.
    const loopInitializers = new Set<string>();

    return {
      ForStatement(node) {
        if (node.init?.type === "VariableDeclaration") {
          loopInitializers.add(rangeKey(node.init));
        }
      },

      VariableDeclaration(node) {
        if (node.kind !== "let" || loopInitializers.has(rangeKey(node))) {
          return;
        }

        for (const declaration of node.declarations) {
          // `changed` alone. `dirty` is this repository's word for an edit not
          // yet saved, which is state a person acts on rather than a flag one
          // traversal sets and the next reads.
          if (
            isIdentifierNamed(declaration.id, "changed") &&
            declaration.init?.type === "Literal" &&
            declaration.init.value === false
          ) {
            context.report({ node, messageId: "noChangedFlag" });
          }
        }
      },
    };
  },
} satisfies CreateRule;

/** The abbreviations this repository does not use for a parameter. */
const rejectedParameterNames = new Set(["ctx", "opts", "params", "args"]);

const parameterNames = {
  meta: {
    messages: {
      parameterNames: "Name the parameter input, options or context.",
    },
  },
  create(context) {
    function checkParameters(
      node: ESTree.Function | ESTree.ArrowFunctionExpression
    ): void {
      for (const param of node.params) {
        // A parameter written with a default value wraps its identifier, so
        // the binding is read through that wrapper. A rest parameter stays
        // `...args`.
        const binding = param.type === "AssignmentPattern" ? param.left : param;
        if (
          binding.type === "Identifier" &&
          rejectedParameterNames.has(binding.name)
        ) {
          context.report({ node: binding, messageId: "parameterNames" });
        }
      }
    }

    // A class method and an object method are both FunctionExpression, so the
    // three handlers cover every implementation. A parameter in a type
    // position (TSFunctionType, TSMethodSignature, TSDeclareFunction) is left
    // alone, because the name there mirrors the callback shape a library
    // documents.
    return {
      FunctionDeclaration: checkParameters,
      FunctionExpression: checkParameters,
      ArrowFunctionExpression: checkParameters,
    };
  },
} satisfies CreateRule;

/**
 * These two rules replace `no-restricted-imports` entries. An override replaces
 * that rule's options wholesale rather than merging them, so each entry had to
 * be repeated in every override that set the rule, and a file whose override
 * turned it off lost them. A plugin rule is set once at the root and every
 * override keeps it.
 */
const esToolkitSubpath = {
  meta: {
    messages: {
      esToolkitBare:
        "Import from the es-toolkit subpath that holds the helper: es-toolkit/array, /object, /predicate, /string, /function, /promise, /math, or /fp.",
      esToolkitCompat:
        "es-toolkit/compat is the lodash compatibility shim. Every helper has a typed home under another es-toolkit subpath.",
    },
  },
  create(context) {
    return {
      ImportDeclaration(node) {
        if (node.source.value === "es-toolkit") {
          context.report({ node, messageId: "esToolkitBare" });
        } else if (node.source.value === "es-toolkit/compat") {
          context.report({ node, messageId: "esToolkitCompat" });
        }
      },
    };
  },
} satisfies CreateRule;

/** The two names Effect exports that this repository takes from es-toolkit. */
const effectPipeNames = new Set(["pipe", "flow"]);

const noEffectPipeImport = {
  meta: {
    messages: {
      noEffectPipeImport:
        "Compose an Effect with Effect.gen and the .pipe method. The bare names pipe and flow belong to es-toolkit/fp.",
    },
  },
  create(context) {
    return {
      ImportDeclaration(node) {
        // A type-only import calls nothing, so it is not what this rule is
        // aimed at, whether the whole declaration or the one specifier says
        // `type`.
        if (node.source.value !== "effect" || node.importKind === "type") {
          return;
        }

        for (const specifier of node.specifiers) {
          if (
            specifier.type === "ImportSpecifier" &&
            specifier.importKind !== "type" &&
            specifier.imported.type === "Identifier" &&
            effectPipeNames.has(specifier.imported.name)
          ) {
            context.report({
              node: specifier,
              messageId: "noEffectPipeImport",
            });
          }
        }
      },
    };
  },
} satisfies CreateRule;

const plugin = {
  meta: { name: "wfgraph" },
  rules: {
    "no-filter-boolean": noFilterBoolean,
    "no-set-spread-uniq": noSetSpreadUniq,
    "no-entries-round-trip": noEntriesRoundTrip,
    "no-conditional-spread": noConditionalSpread,
    "no-locale-compare": noLocaleCompare,
    "no-hand-rolled-object-guard": noHandRolledObjectGuard,
    "no-changed-flag": noChangedFlag,
    "parameter-names": parameterNames,
    "es-toolkit-subpath": esToolkitSubpath,
    "no-effect-pipe-import": noEffectPipeImport,
  },
} satisfies Plugin;

export default plugin;
