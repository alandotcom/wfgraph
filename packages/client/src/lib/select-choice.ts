/**
 * Adapters between Base UI's Select and the way this app writes one.
 *
 * These live outside `components/ui/select.tsx` because the shadcn CLI
 * overwrites that file on every `shadcn add select`, and anything added inside
 * it disappears with the next pull. What stays there is the one line that calls
 * in.
 */

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
