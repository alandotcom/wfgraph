import { uniq } from "es-toolkit/array";
import { isEqual } from "es-toolkit/predicate";

export type EnumMetadata = {
  readonly enumValues?: readonly string[] | undefined;
  readonly enumLabels?: Readonly<Record<string, string>> | undefined;
};

/** An authored enum label, excluding inherited object prototype properties. */
export function enumLabelForValue(
  labels: Readonly<Record<string, string>> | undefined,
  value: string
): string | undefined {
  return labels && Object.hasOwn(labels, value) ? labels[value] : undefined;
}

/**
 * Enum values and labels several declarations agree on.
 *
 * Values keep the first declaration's order. A label survives only when every
 * declaration gives that raw value the same label.
 */
export function reconcileEnumMetadata(declarations: readonly EnumMetadata[]): {
  enumValues?: string[];
  enumLabels?: Readonly<Record<string, string>>;
} {
  const [first, ...rest] = declarations;
  if (!first?.enumValues) {
    return {};
  }

  const expected = first.enumValues.toSorted();
  const valuesAgree = rest.every(
    (declaration) =>
      declaration.enumValues &&
      isEqual(declaration.enumValues.toSorted(), expected)
  );
  if (!valuesAgree) {
    return {};
  }

  const enumValues = [...first.enumValues];
  const entries = enumValues.flatMap((value): [string, string][] => {
    const labels = uniq(
      declarations.map((declaration) =>
        enumLabelForValue(declaration.enumLabels, value)
      )
    );
    const [label] = labels;
    return labels.length === 1 && label ? [[value, label]] : [];
  });

  return entries.length > 0
    ? { enumValues, enumLabels: Object.fromEntries(entries) }
    : { enumValues };
}
