/**
 * Adapters between Base UI's Select and the way this app writes one.
 *
 * These live outside `components/ui/select.tsx` because the shadcn CLI
 * overwrites that file on every `shadcn add select`, and anything added inside
 * it disappears with the next pull. What stays there is the one line that calls
 * in.
 */

import { Children, isValidElement, type ReactNode } from "react";

/** What Base UI's `items` prop takes: the label to show for a stored value. */
export type SelectItemLabel = { label: string; value: string | null };

/** Runs `onChosen` for a real selection and ignores a clear. */
export function whenChosen(onChosen: (value: string) => void) {
  return (value: string | null) => {
    if (value !== null) {
      onChosen(value);
    }
  };
}

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }

  if (Array.isArray(node)) {
    return node.map(textOf).join(" ");
  }

  if (isValidElement<{ children?: ReactNode }>(node)) {
    return textOf(node.props.children);
  }

  return "";
}

/**
 * The label to show for each value, read off the `SelectItem` children.
 *
 * Base UI renders the raw stored value in the trigger unless `Select.Root` is
 * given an `items` map, and every picker in this app already spells its labels
 * out as the children of its items. Deriving the map here keeps all 16 call
 * sites from restating those labels a second time as a prop.
 *
 * An item carrying secondary text (a description under its label) names its own
 * `label` instead: reading its text would concatenate every nested string into
 * the trigger.
 */
export function selectItemsFromChildren(
  children: ReactNode
): SelectItemLabel[] {
  const items: SelectItemLabel[] = [];

  const visit = (node: ReactNode) => {
    Children.forEach(node, (child) => {
      if (
        !isValidElement<{
          value?: unknown;
          label?: unknown;
          children?: ReactNode;
        }>(child)
      ) {
        return;
      }

      if (typeof child.props.value === "string" || child.props.value === null) {
        const label =
          typeof child.props.label === "string"
            ? child.props.label
            : textOf(child.props.children).trim();
        if (label) {
          items.push({ label, value: child.props.value });
        }
      }

      if (child.props.children) {
        visit(child.props.children);
      }
    });
  };

  visit(children);
  return items;
}
