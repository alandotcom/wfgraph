/**
 * The repository's structural lint rules, loaded by oxlint as the `wfgraph` JS
 * plugin (`.oxlintrc.json`, `jsPlugins`). Each rule names the helper to write
 * instead of the hand-rolled shape it reports; AGENTS.md ("Code cleanliness")
 * holds the same list in prose.
 */

/**
 * A node of the syntax tree oxlint passes to a visitor.
 *
 * The types are declared here rather than imported because the `oxlint` package
 * publishes no plugin types, only the `RuleTester` under `oxlint/plugins-dev`.
 * The `read*` helpers in this file read a node's fields, because
 * `typescript/no-unsafe-type-assertion` applies to this file and forbids a cast.
 */
type AstNode = {
  type: string;
  /** The source offsets oxlint underlines when a rule reports this node. */
  range: [number, number];
};

/** The object oxlint passes to a rule for the file being linted. */
type RuleContext = {
  report(diagnostic: { node: AstNode; messageId: string }): void;
};

/**
 * A rule: the messages it can report, and a `create` function returning a
 * visitor keyed by AST node type. oxlint implements the ESLint v9 rule shape.
 */
type Rule = {
  meta: { messages: Record<string, string> };
  create(context: RuleContext): Record<string, (node: AstNode) => void>;
};

function isAstNode(value: unknown): value is AstNode {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    typeof value.type === "string"
  );
}

function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

/**
 * One field of a node, whatever it holds.
 *
 * `AstNode` carries no index signature, because oxlint's own node types have
 * none and a visitor handler would then not be assignable to the handler type
 * oxlint expects. `Reflect.get` reads a field without adding one.
 */
function readField(node: AstNode, field: string): unknown {
  return Reflect.get(node, field);
}

/** The child node at `field`, or undefined when the field holds anything else. */
function readNode(node: AstNode, field: string): AstNode | undefined {
  const value = readField(node, field);
  return isAstNode(value) ? value : undefined;
}

/** The child nodes at `field`, skipping the holes an array literal can carry. */
function readNodes(node: AstNode, field: string): AstNode[] {
  const value = readField(node, field);
  return isUnknownArray(value) ? value.filter(isAstNode) : [];
}

/**
 * The child nodes at `field`, with an array literal's hole kept as undefined.
 * `[, ...values]` holds two elements, and a rule counting elements has to see
 * the hole to tell that literal apart from `[...values]`.
 */
function readNodesWithHoles(
  node: AstNode,
  field: string
): (AstNode | undefined)[] {
  const value = readField(node, field);
  return isUnknownArray(value)
    ? value.map((element) => (isAstNode(element) ? element : undefined))
    : [];
}

/** The string at `field`, or undefined when the field holds anything else. */
function readString(node: AstNode, field: string): string | undefined {
  const value = readField(node, field);
  return typeof value === "string" ? value : undefined;
}

function isIdentifierNamed(node: AstNode | undefined, name: string): boolean {
  return node?.type === "Identifier" && readString(node, "name") === name;
}

/** The name of a dotted property access, or undefined for anything else. */
function memberPropertyName(node: AstNode | undefined): string | undefined {
  if (
    node?.type !== "MemberExpression" ||
    readField(node, "computed") === true
  ) {
    return undefined;
  }

  const property = readNode(node, "property");
  return property?.type === "Identifier"
    ? readString(property, "name")
    : undefined;
}

/** Whether a node is a call of the form `<anything>.<name>(...)`. */
function isMethodCall(node: AstNode, name: string): boolean {
  return (
    node.type === "CallExpression" &&
    memberPropertyName(readNode(node, "callee")) === name
  );
}

/** Whether a node is a call of the form `<namespace>.<name>(...)`. */
function isNamespacedCall(
  node: AstNode | undefined,
  namespace: string,
  name: string
): boolean {
  if (node?.type !== "CallExpression") {
    return false;
  }

  const callee = readNode(node, "callee");
  if (callee?.type !== "MemberExpression") {
    return false;
  }

  return (
    isIdentifierNamed(readNode(callee, "object"), namespace) &&
    memberPropertyName(callee) === name
  );
}

/**
 * Whether a node is `new Set(values)`. A `new Set()` with no argument builds an
 * empty set for a caller to fill, which is not the dedupe `uniq` replaces.
 */
function isDedupeSet(node: AstNode | undefined): boolean {
  return (
    node?.type === "NewExpression" &&
    isIdentifierNamed(readNode(node, "callee"), "Set") &&
    readNodes(node, "arguments").length === 1
  );
}

function isEmptyObjectLiteral(node: AstNode | undefined): boolean {
  return (
    node?.type === "ObjectExpression" &&
    readNodes(node, "properties").length === 0
  );
}

/** Whether a node reads `value === undefined` or `value !== undefined`. */
function isUndefinedComparison(node: AstNode | undefined): boolean {
  if (node?.type !== "BinaryExpression") {
    return false;
  }

  const operator = readString(node, "operator");
  if (operator !== "===" && operator !== "!==") {
    return false;
  }

  return (
    isIdentifierNamed(readNode(node, "left"), "undefined") ||
    isIdentifierNamed(readNode(node, "right"), "undefined")
  );
}

/** A node's source offsets, as a key a Set can hold. */
function rangeKey(node: AstNode): string {
  return `${node.range[0]}:${node.range[1]}`;
}

const noFilterBoolean: Rule = {
  meta: {
    messages: {
      noFilterBoolean: "Use compact from es-toolkit/array.",
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        if (!isMethodCall(node, "filter")) {
          return;
        }

        const args = readNodes(node, "arguments");
        if (args.length === 1 && isIdentifierNamed(args[0], "Boolean")) {
          context.report({ node, messageId: "noFilterBoolean" });
        }
      },
    };
  },
};

const noSetSpreadUniq: Rule = {
  meta: {
    messages: {
      noSetSpreadUniq: "Use uniq from es-toolkit/array.",
    },
  },
  create(context) {
    return {
      // `[...new Set(x)]`, and nothing else in the literal.
      ArrayExpression(node) {
        const elements = readNodesWithHoles(node, "elements");
        const only = elements.length === 1 ? elements[0] : undefined;
        if (
          only?.type === "SpreadElement" &&
          isDedupeSet(readNode(only, "argument"))
        ) {
          context.report({ node, messageId: "noSetSpreadUniq" });
        }
      },

      // `Array.from(new Set(x))`. `Array.from(new Set(x), fn)` maps as it
      // reads, which `uniq` does not do, so it is left alone.
      CallExpression(node) {
        if (!isNamespacedCall(node, "Array", "from")) {
          return;
        }

        const args = readNodes(node, "arguments");
        if (args.length === 1 && isDedupeSet(args[0])) {
          context.report({ node, messageId: "noSetSpreadUniq" });
        }
      },
    };
  },
};

const noEntriesRoundTrip: Rule = {
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
        const source = readNodes(node, "arguments")[0];
        if (source?.type !== "CallExpression") {
          return;
        }

        const callee = readNode(source, "callee");
        if (callee === undefined) {
          return;
        }

        const method = memberPropertyName(callee);
        if (method !== "map" && method !== "filter") {
          return;
        }

        if (isNamespacedCall(readNode(callee, "object"), "Object", "entries")) {
          context.report({ node, messageId: "noEntriesRoundTrip" });
        }
      },
    };
  },
};

const noConditionalSpread: Rule = {
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
        const spread = readNodes(node, "properties").find(
          (property) => property.type === "SpreadElement"
        );
        if (spread === undefined) {
          return;
        }

        const argument = readNode(spread, "argument");
        if (argument?.type !== "ConditionalExpression") {
          return;
        }

        // The shape omitUndefined replaces: one arm is the empty object, and
        // the test is an undefined check rather than a truthiness check. A
        // truthy test also drops "" and 0, which omitUndefined keeps.
        if (!isUndefinedComparison(readNode(argument, "test"))) {
          return;
        }

        if (
          isEmptyObjectLiteral(readNode(argument, "consequent")) ||
          isEmptyObjectLiteral(readNode(argument, "alternate"))
        ) {
          context.report({ node: spread, messageId: "noConditionalSpread" });
        }
      },
    };
  },
};

const noLocaleCompare: Rule = {
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
};

/**
 * The function names a hand-rolled plain-object guard is given. `isRecord` is
 * not one of them: a record here is a database row, and a guard by that name is
 * usually about a row rather than about a plain object.
 */
const objectGuardNames = new Set(["isJsonObject", "isPlainObject"]);

/** The value types a hand-rolled `Record` predicate narrows to. */
const wideValueTypes = new Set(["TSUnknownKeyword", "TSAnyKeyword"]);

const noHandRolledObjectGuard: Rule = {
  meta: {
    messages: {
      noHandRolledObjectGuard:
        "Use isJsonObject from @wfgraph/shared/types/json for a JsonValue, or isPlainObject from es-toolkit/predicate for unknown.",
    },
  },
  create(context) {
    return {
      FunctionDeclaration(node) {
        const id = readNode(node, "id");
        const name = id === undefined ? undefined : readString(id, "name");
        if (name !== undefined && objectGuardNames.has(name)) {
          context.report({ node, messageId: "noHandRolledObjectGuard" });
        }
      },

      // `x is Record<string, unknown>` and `x is Record<string, any>`, whatever
      // the function holding the predicate is called.
      TSTypePredicate(node) {
        const annotation = readNode(node, "typeAnnotation");
        if (annotation === undefined) {
          return;
        }

        const reference = readNode(annotation, "typeAnnotation");
        if (
          reference?.type !== "TSTypeReference" ||
          !isIdentifierNamed(readNode(reference, "typeName"), "Record")
        ) {
          return;
        }

        const typeArguments = readNode(reference, "typeArguments");
        const params =
          typeArguments === undefined ? [] : readNodes(typeArguments, "params");
        if (params.length !== 2) {
          return;
        }

        const [key, value] = params;
        if (
          key?.type === "TSStringKeyword" &&
          value !== undefined &&
          wideValueTypes.has(value.type)
        ) {
          context.report({ node, messageId: "noHandRolledObjectGuard" });
        }
      },
    };
  },
};

const noChangedFlag: Rule = {
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
        const init = readNode(node, "init");
        if (init?.type === "VariableDeclaration") {
          loopInitializers.add(rangeKey(init));
        }
      },

      VariableDeclaration(node) {
        if (
          readString(node, "kind") !== "let" ||
          loopInitializers.has(rangeKey(node))
        ) {
          return;
        }

        for (const declaration of readNodes(node, "declarations")) {
          const id = readNode(declaration, "id");
          const init = readNode(declaration, "init");
          const name = id === undefined ? undefined : readString(id, "name");

          // `changed` alone. `dirty` is this repository's word for an edit not
          // yet saved, which is state a person acts on rather than a flag one
          // traversal sets and the next reads.
          if (
            name === "changed" &&
            init?.type === "Literal" &&
            readField(init, "value") === false
          ) {
            context.report({ node, messageId: "noChangedFlag" });
          }
        }
      },
    };
  },
};

/** The abbreviations this repository does not use for a parameter. */
const rejectedParameterNames = new Set(["ctx", "opts", "params", "args"]);

/**
 * The node types that carry a parameter list this rule names. A class method
 * and an object method are both FunctionExpression, so all three entries are
 * implementations. A parameter in a type position (TSFunctionType,
 * TSMethodSignature, TSDeclareFunction) is left alone, because the name there
 * mirrors the callback shape a library documents.
 */
const functionNodeTypes = [
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
];

const parameterNames: Rule = {
  meta: {
    messages: {
      parameterNames: "Name the parameter input, options or context.",
    },
  },
  create(context) {
    function checkParameters(node: AstNode): void {
      for (const param of readNodes(node, "params")) {
        if (param.type === "RestElement") {
          continue;
        }

        // A parameter written with a default value wraps its identifier, so
        // the binding is read through that wrapper.
        const binding =
          param.type === "AssignmentPattern" ? readNode(param, "left") : param;
        if (binding?.type !== "Identifier") {
          continue;
        }

        const name = readString(binding, "name");
        if (name !== undefined && rejectedParameterNames.has(name)) {
          context.report({ node: binding, messageId: "parameterNames" });
        }
      }
    }

    return Object.fromEntries(
      functionNodeTypes.map((type) => [type, checkParameters])
    );
  },
};

/** The source of an import declaration, when it is a plain string. */
function importSource(node: AstNode): string | undefined {
  const source = readNode(node, "source");
  return source === undefined ? undefined : readString(source, "value");
}

/**
 * These two rules replace `no-restricted-imports` entries. An override replaces
 * that rule's options wholesale rather than merging them, so each entry had to
 * be repeated in every override that set the rule, and a file whose override
 * turned it off lost them. A plugin rule is set once at the root and every
 * override keeps it.
 */
const esToolkitSubpath: Rule = {
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
        const source = importSource(node);
        if (source === "es-toolkit") {
          context.report({ node, messageId: "esToolkitBare" });
        } else if (source === "es-toolkit/compat") {
          context.report({ node, messageId: "esToolkitCompat" });
        }
      },
    };
  },
};

/** The two names Effect exports that this repository takes from es-toolkit. */
const effectPipeNames = new Set(["pipe", "flow"]);

const noEffectPipeImport: Rule = {
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
        if (
          importSource(node) !== "effect" ||
          readString(node, "importKind") === "type"
        ) {
          return;
        }

        for (const specifier of readNodes(node, "specifiers")) {
          if (
            specifier.type !== "ImportSpecifier" ||
            readString(specifier, "importKind") === "type"
          ) {
            continue;
          }

          const imported = readNode(specifier, "imported");
          const name =
            imported === undefined ? undefined : readString(imported, "name");
          if (name !== undefined && effectPipeNames.has(name)) {
            context.report({
              node: specifier,
              messageId: "noEffectPipeImport",
            });
          }
        }
      },
    };
  },
};

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
};

export default plugin;
