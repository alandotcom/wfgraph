import { RuleTester } from "oxlint/plugins-dev";
import { describe, it } from "vitest";
import plugin from "./conventions-plugin";

/**
 * Accepted and rejected snippets per rule. The suite also covers the loader:
 * oxlint's JS plugin API is alpha, so a release that changes the rule shape or
 * the AST fails here instead of silently reporting nothing during
 * `pnpm run lint`.
 */
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester({
  languageOptions: { parserOptions: { lang: "ts" } },
});

const rules = plugin.rules;

/** A rule as this plugin declares it. */
type PluginRule = (typeof rules)[keyof typeof rules];

/** The fields a report and a text lookup need from a node. */
type ReportedNode = { type: string; range: [number, number] };

/**
 * Wraps a rule so each report carries the source text of the node it named,
 * which RuleTester then matches against the expected error message. A rule
 * that underlines a parent or a neighbour instead of the offending node fails
 * the wrapped run even though it still reports the right number of errors.
 */
function reportsNodeText(rule: PluginRule) {
  return {
    meta: rule.meta,
    create(context: {
      report(diagnostic: { node: ReportedNode; message: string }): void;
      sourceCode: { getText(node: ReportedNode): string };
    }) {
      return rule.create({
        report: ({ node }) =>
          context.report({ node, message: context.sourceCode.getText(node) }),
      });
    },
  };
}

ruleTester.run("no-filter-boolean", rules["no-filter-boolean"], {
  valid: ["const kept = compact(values);"],
  invalid: [
    {
      code: "const kept = values.filter(Boolean);",
      errors: [{ messageId: "noFilterBoolean" }],
    },
  ],
});

ruleTester.run(
  "no-filter-boolean reports the call",
  reportsNodeText(rules["no-filter-boolean"]),
  {
    valid: [],
    invalid: [
      {
        code: "const kept = values.filter(Boolean);",
        errors: ["values.filter(Boolean)"],
      },
    ],
  }
);

ruleTester.run("no-set-spread-uniq", rules["no-set-spread-uniq"], {
  valid: [
    "const ids = uniq(values);",
    "const set = new Set(values);",
    // A mapping function reads and maps in one pass, which uniq does not do.
    "const labels = Array.from(new Set(values), toLabel);",
    // An empty set is built for a caller to fill, not to dedupe an input.
    "const seen = new Set();",
    "const ids = Array.from(new Set());",
    // A literal holding more than the spread is a concatenation.
    "const ids = [...new Set(values), ...extra];",
    // A hole is an element, so this literal is not a bare dedupe either.
    "const ids = [, ...new Set(values)];",
  ],
  invalid: [
    {
      code: "const ids = [...new Set(values)];",
      errors: [{ messageId: "noSetSpreadUniq" }],
    },
    {
      code: "const ids = Array.from(new Set(values));",
      errors: [{ messageId: "noSetSpreadUniq" }],
    },
  ],
});

ruleTester.run(
  "no-set-spread-uniq reports the literal or the call",
  reportsNodeText(rules["no-set-spread-uniq"]),
  {
    valid: [],
    invalid: [
      {
        code: "const ids = [...new Set(values)];",
        errors: ["[...new Set(values)]"],
      },
      {
        code: "const ids = Array.from(new Set(values));",
        errors: ["Array.from(new Set(values))"],
      },
    ],
  }
);

ruleTester.run("no-entries-round-trip", rules["no-entries-round-trip"], {
  valid: [
    "const shaped = mapValues(input, (value) => value.id);",
    "const shaped = Object.fromEntries(pairs);",
  ],
  invalid: [
    {
      code: "const shaped = Object.fromEntries(Object.entries(input).map(([key, value]) => [key, value.id]));",
      errors: [{ messageId: "noEntriesRoundTrip" }],
    },
    {
      code: "const shaped = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));",
      errors: [{ messageId: "noEntriesRoundTrip" }],
    },
  ],
});

ruleTester.run(
  "no-entries-round-trip reports the fromEntries call",
  reportsNodeText(rules["no-entries-round-trip"]),
  {
    valid: [],
    invalid: [
      {
        code: "const shaped = Object.fromEntries(Object.entries(input).map(toEntry));",
        errors: ["Object.fromEntries(Object.entries(input).map(toEntry))"],
      },
    ],
  }
);

ruleTester.run("no-conditional-spread", rules["no-conditional-spread"], {
  valid: [
    "const payload = omitUndefined({ id, label });",
    // A truthy test also drops "" and 0, which omitUndefined keeps.
    "const payload = { id, ...(label ? { label } : {}) };",
    // Neither arm is empty, so this chooses between two shapes.
    "const payload = { id, ...(flag ? { a: 1 } : { b: 2 }) };",
    // omitUndefined around this literal would delete base's own label.
    "const payload = { ...base, ...(label === undefined ? {} : { label }) };",
  ],
  invalid: [
    {
      code: "const payload = { id, ...(label === undefined ? {} : { label }) };",
      errors: [{ messageId: "noConditionalSpread" }],
    },
    {
      code: "const payload = { id, ...(label !== undefined ? { label } : {}) };",
      errors: [{ messageId: "noConditionalSpread" }],
    },
    {
      code: "const payload = { id, ...(undefined === label ? {} : { label }) };",
      errors: [{ messageId: "noConditionalSpread" }],
    },
  ],
});

ruleTester.run(
  "no-conditional-spread reports the spread",
  reportsNodeText(rules["no-conditional-spread"]),
  {
    valid: [],
    invalid: [
      {
        code: "const payload = { id, ...(label === undefined ? {} : { label }) };",
        errors: ["...(label === undefined ? {} : { label })"],
      },
    ],
  }
);

ruleTester.run("no-locale-compare", rules["no-locale-compare"], {
  valid: [
    "const order = compareText(left, right);",
    "const order = new Intl.Collator().compare(left, right);",
  ],
  invalid: [
    {
      code: "const order = left.localeCompare(right);",
      errors: [{ messageId: "noLocaleCompare" }],
    },
  ],
});

ruleTester.run(
  "no-locale-compare reports the call",
  reportsNodeText(rules["no-locale-compare"]),
  {
    valid: [],
    invalid: [
      {
        code: "const order = left.localeCompare(right);",
        errors: ["left.localeCompare(right)"],
      },
    ],
  }
);

ruleTester.run(
  "no-hand-rolled-object-guard",
  rules["no-hand-rolled-object-guard"],
  {
    valid: [
      "function isEventPayload(value: JsonValue): value is EventPayload { return true; }",
      // A record here is a database row, so a guard by that name is not the
      // plain-object guard this rule replaces.
      "function isRecord(value: unknown) { return true; }",
      // A narrower value type describes a specific shape rather than any bag.
      "function isLabelMap(value: unknown): value is Record<string, string> { return true; }",
    ],
    invalid: [
      {
        code: "function isJsonObject(value: JsonValue) { return true; }",
        errors: [{ messageId: "noHandRolledObjectGuard" }],
      },
      {
        code: "function isPlainObject(value: unknown) { return true; }",
        errors: [{ messageId: "noHandRolledObjectGuard" }],
      },
      {
        code: "function looksLikeABag(value: unknown): value is Record<string, unknown> { return true; }",
        errors: [{ messageId: "noHandRolledObjectGuard" }],
      },
      {
        code: "function looksLikeABag(value: unknown): value is Record<string, any> { return true; }",
        errors: [{ messageId: "noHandRolledObjectGuard" }],
      },
    ],
  }
);

ruleTester.run(
  "no-hand-rolled-object-guard reports the predicate",
  reportsNodeText(rules["no-hand-rolled-object-guard"]),
  {
    valid: [],
    invalid: [
      {
        code: "function looksLikeABag(value: unknown): value is Record<string, unknown> { return true; }",
        errors: ["value is Record<string, unknown>"],
      },
    ],
  }
);

ruleTester.run("no-changed-flag", rules["no-changed-flag"], {
  valid: [
    "const next = mapOrSame(items, replace);",
    "let changed = items.length;",
    // dirty is this repository's word for an edit not yet saved.
    "let dirty = false;",
    // A loop counter is not a flag one traversal sets and the next reads.
    "for (let changed = false; !changed; ) { changed = true; }",
  ],
  invalid: [
    {
      code: "let changed = false;",
      errors: [{ messageId: "noChangedFlag" }],
    },
  ],
});

ruleTester.run(
  "no-changed-flag reports the declaration",
  reportsNodeText(rules["no-changed-flag"]),
  {
    valid: [],
    invalid: [
      {
        code: "let changed = false;",
        errors: ["let changed = false;"],
      },
    ],
  }
);

ruleTester.run("parameter-names", rules["parameter-names"], {
  valid: [
    "function read(input: ReadInput) { return input; }",
    "const read = (options: ReadOptions) => options;",
    "function f(...args: unknown[]) {}",
    // A name in a type position mirrors the callback shape a library documents.
    "type Handler = (ctx: Context) => void;",
    "interface Client { call(ctx: Context): void; }",
    "declare function read(ctx: Context): void;",
    // A destructured key is the caller's field name, not a parameter name.
    "const read = ({ ctx }: ReadInput) => ctx;",
  ],
  invalid: [
    {
      code: "function read(ctx: Context) { return ctx; }",
      errors: [{ messageId: "parameterNames" }],
    },
    {
      code: "const read = function (ctx: Context) { return ctx; };",
      errors: [{ messageId: "parameterNames" }],
    },
    {
      code: "class Reader { read(ctx: Context) { return ctx; } }",
      errors: [{ messageId: "parameterNames" }],
    },
    {
      code: "const read = (opts: Options) => opts;",
      errors: [{ messageId: "parameterNames" }],
    },
    {
      code: "function read(params: Params) { return params; }",
      errors: [{ messageId: "parameterNames" }],
    },
    {
      code: "function read(args: Args) { return args; }",
      errors: [{ messageId: "parameterNames" }],
    },
    {
      code: "const read = (ctx = {}) => ctx;",
      errors: [{ messageId: "parameterNames" }],
    },
  ],
});

ruleTester.run(
  "parameter-names reports the binding",
  reportsNodeText(rules["parameter-names"]),
  {
    valid: [],
    invalid: [
      {
        code: "const read = (ctx = {}) => ctx;",
        errors: ["ctx"],
      },
    ],
  }
);

ruleTester.run("es-toolkit-subpath", rules["es-toolkit-subpath"], {
  valid: [
    'import { uniq } from "es-toolkit/array";',
    'import { isNil } from "es-toolkit/predicate";',
  ],
  invalid: [
    {
      code: 'import { uniq } from "es-toolkit";',
      errors: [{ messageId: "esToolkitBare" }],
    },
    {
      code: 'import { get } from "es-toolkit/compat";',
      errors: [{ messageId: "esToolkitCompat" }],
    },
  ],
});

ruleTester.run(
  "es-toolkit-subpath reports the import",
  reportsNodeText(rules["es-toolkit-subpath"]),
  {
    valid: [],
    invalid: [
      {
        code: 'import { uniq } from "es-toolkit";',
        errors: ['import { uniq } from "es-toolkit";'],
      },
    ],
  }
);

ruleTester.run("no-effect-pipe-import", rules["no-effect-pipe-import"], {
  valid: [
    'import { Effect } from "effect";',
    'import { pipe } from "es-toolkit/fp";',
    // A type-only import calls nothing.
    'import type { pipe } from "effect";',
    'import { type flow } from "effect";',
  ],
  invalid: [
    {
      code: 'import { pipe } from "effect";',
      errors: [{ messageId: "noEffectPipeImport" }],
    },
    {
      code: 'import { flow } from "effect";',
      errors: [{ messageId: "noEffectPipeImport" }],
    },
    {
      code: 'import { Effect, pipe } from "effect";',
      errors: [{ messageId: "noEffectPipeImport" }],
    },
  ],
});

ruleTester.run(
  "no-effect-pipe-import reports the specifier",
  reportsNodeText(rules["no-effect-pipe-import"]),
  {
    valid: [],
    invalid: [
      {
        code: 'import { Effect, pipe } from "effect";',
        errors: ["pipe"],
      },
    ],
  }
);
