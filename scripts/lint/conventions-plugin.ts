/**
 * The repository's structural lint rules, loaded by oxlint as the `wfgraph` JS
 * plugin (`.oxlintrc.json`, `jsPlugins`). Each rule names the helper to write
 * instead of the hand-rolled shape it reports; AGENTS.md ("Code cleanliness")
 * holds the same list in prose. A rule is turned on in `.oxlintrc.json` by the
 * commit that clears its last violation.
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

function isNewSet(node: AstNode | undefined): boolean {
  return (
    node?.type === "NewExpression" &&
    isIdentifierNamed(readNode(node, "callee"), "Set")
  );
}

function isEmptyObjectLiteral(node: AstNode | undefined): boolean {
  return (
    node?.type === "ObjectExpression" &&
    readNodes(node, "properties").length === 0
  );
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
      // `[...new Set(x)]`
      ArrayExpression(node) {
        const elements = readNodes(node, "elements");
        const only = elements.length === 1 ? elements[0] : undefined;
        if (
          only?.type === "SpreadElement" &&
          isNewSet(readNode(only, "argument"))
        ) {
          context.report({ node, messageId: "noSetSpreadUniq" });
        }
      },

      // `Array.from(new Set(x))`, with or without a mapping function.
      CallExpression(node) {
        if (!isNamespacedCall(node, "Array", "from")) {
          return;
        }

        if (isNewSet(readNodes(node, "arguments")[0])) {
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
        "Use mapValues, pickBy or omitBy from es-toolkit/object.",
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
        "Use omitUndefined from @wfgraph/shared/utils/omit-undefined, or omitBy with isNil from es-toolkit/object when null must go too.",
    },
  },
  create(context) {
    return {
      SpreadElement(node) {
        const argument = readNode(node, "argument");
        if (argument?.type !== "ConditionalExpression") {
          return;
        }

        if (
          isEmptyObjectLiteral(readNode(argument, "consequent")) ||
          isEmptyObjectLiteral(readNode(argument, "alternate"))
        ) {
          context.report({ node, messageId: "noConditionalSpread" });
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

/** The function names a hand-rolled plain-object guard is given. */
const objectGuardNames = new Set(["isJsonObject", "isPlainObject", "isRecord"]);

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

/** The flag names a loop uses to record that it changed something. */
const changedFlagNames = new Set(["changed", "dirty", "mutated"]);

const noChangedFlag: Rule = {
  meta: {
    messages: {
      noChangedFlag:
        "Use mapOrSame or mapValuesOrSame from @wfgraph/shared/utils/map-or-same.",
    },
  },
  create(context) {
    return {
      VariableDeclaration(node) {
        if (readString(node, "kind") !== "let") {
          return;
        }

        for (const declaration of readNodes(node, "declarations")) {
          const id = readNode(declaration, "id");
          const init = readNode(declaration, "init");
          const name = id === undefined ? undefined : readString(id, "name");

          if (
            name !== undefined &&
            changedFlagNames.has(name) &&
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
 * The node types that carry a parameter list. An arrow function, a method
 * signature and a bare function type all hold the same `params` array.
 */
const functionNodeTypes = [
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
  "TSDeclareFunction",
  "TSFunctionType",
  "TSMethodSignature",
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
        // A rest parameter forwards a whole argument list rather than naming
        // one object, and `...args` is the idiom for that, so this rule
        // exempts it.
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
  },
};

export default plugin;
