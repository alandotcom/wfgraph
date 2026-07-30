import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { RadioGroup as RadioGroupPrimitive } from "@base-ui/react/radio-group";
import { cn } from "@rova/shared/utils";

/**
 * One exclusive choice, in the house style over Base UI.
 *
 * The primitive is what carries the group semantics and the roving tab stop, so
 * a keyboard user arrows within the group rather than tabbing through every
 * option. Hang the group name on it with `aria-labelledby`.
 */
function RadioGroup<Value>({
  className,
  ...props
}: RadioGroupPrimitive.Props<Value>) {
  return (
    <RadioGroupPrimitive
      className={cn("space-y-1.5", className)}
      data-slot="radio-group"
      {...props}
    />
  );
}

/** The dot itself. Pair it with its label inside a `<label>`. */
function Radio<Value>({
  className,
  ...props
}: RadioPrimitive.Root.Props<Value>) {
  return (
    <RadioPrimitive.Root
      className={cn(
        "flex size-4 shrink-0 items-center justify-center rounded-full border border-input bg-background outline-none transition-shadow focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 data-[checked]:border-primary data-[checked]:bg-primary data-[checked]:text-primary-foreground data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50",
        className
      )}
      data-slot="radio"
      {...props}
    >
      <RadioPrimitive.Indicator className="flex items-center justify-center before:size-1.5 before:rounded-full before:bg-current data-[unchecked]:hidden" />
    </RadioPrimitive.Root>
  );
}

export { Radio, RadioGroup };
