import { RuleTester } from "oxlint/plugins-dev";
import { describe, it } from "vitest";
import plugin from "./conventions-plugin";

/**
 * One accepted and one rejected snippet per rule. The point of the suite is as
 * much the loader as the rules: oxlint's JS plugin API is alpha, so a release
 * that changes the rule shape or the AST fails here rather than by quietly
 * reporting nothing during `pnpm run lint`.
 */
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester({
  languageOptions: { parserOptions: { lang: "ts" } },
});

const rules = plugin.rules;

ruleTester.run("no-filter-boolean", rules["no-filter-boolean"], {
  valid: ["const kept = compact(values);"],
  invalid: [
    {
      code: "const kept = values.filter(Boolean);",
      errors: [{ messageId: "noFilterBoolean" }],
    },
  ],
});

ruleTester.run("no-set-spread-uniq", rules["no-set-spread-uniq"], {
  valid: ["const ids = uniq(values);", "const set = new Set(values);"],
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

ruleTester.run("no-conditional-spread", rules["no-conditional-spread"], {
  valid: ["const payload = omitUndefined({ id, label });"],
  invalid: [
    {
      code: "const payload = { id, ...(label === undefined ? {} : { label }) };",
      errors: [{ messageId: "noConditionalSpread" }],
    },
    {
      code: "const payload = { id, ...(label ? { label } : {}) };",
      errors: [{ messageId: "noConditionalSpread" }],
    },
  ],
});

ruleTester.run("no-locale-compare", rules["no-locale-compare"], {
  valid: ["const order = compareText(left, right);"],
  invalid: [
    {
      code: "const order = left.localeCompare(right);",
      errors: [{ messageId: "noLocaleCompare" }],
    },
  ],
});

ruleTester.run(
  "no-hand-rolled-object-guard",
  rules["no-hand-rolled-object-guard"],
  {
    valid: [
      "function isEventPayload(value: JsonValue): value is EventPayload { return true; }",
    ],
    invalid: [
      {
        code: "function isJsonObject(value: JsonValue) { return true; }",
        errors: [{ messageId: "noHandRolledObjectGuard" }],
      },
      {
        code: "function looksLikeABag(value: unknown): value is Record<string, unknown> { return true; }",
        errors: [{ messageId: "noHandRolledObjectGuard" }],
      },
    ],
  }
);

ruleTester.run("no-changed-flag", rules["no-changed-flag"], {
  valid: [
    "const next = mapOrSame(items, replace);",
    "let changed = items.length;",
  ],
  invalid: [
    {
      code: "let changed = false;",
      errors: [{ messageId: "noChangedFlag" }],
    },
    {
      code: "let mutated = false;",
      errors: [{ messageId: "noChangedFlag" }],
    },
  ],
});

ruleTester.run("parameter-names", rules["parameter-names"], {
  valid: [
    "function read(input: ReadInput) { return input; }",
    "const read = (options: ReadOptions) => options;",
  ],
  invalid: [
    {
      code: "function read(ctx: Context) { return ctx; }",
      errors: [{ messageId: "parameterNames" }],
    },
    {
      code: "const read = (opts: Options) => opts;",
      errors: [{ messageId: "parameterNames" }],
    },
  ],
});
