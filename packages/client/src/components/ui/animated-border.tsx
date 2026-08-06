import { cn } from "@rova/shared/utils";

interface AnimatedBorderProps {
  className?: string;
}

/**
 * The border sweep worn by a node while its step is running.
 *
 * The keyframes and the reduced-motion alternative live in `globals.css`; this
 * component only draws the ring, so the rules are emitted once rather than once
 * per running node. Colour comes from `--info`, the token that carries "work in
 * progress" across the editor.
 */
export const AnimatedBorder = ({ className }: AnimatedBorderProps) => {
  return (
    <>
      <div
        className={cn(
          "pointer-events-none absolute inset-0 animate-border-mask rounded-[inherit]",
          className
        )}
      >
        <svg
          className="size-full overflow-visible"
          xmlns="http://www.w3.org/2000/svg"
        >
          <rect
            fill="none"
            height="calc(100% - 2px)"
            rx="6"
            stroke="var(--info)"
            strokeWidth="2"
            width="calc(100% - 2px)"
            x="1"
            y="1"
          />
        </svg>
      </div>
      {/* Static faint border, so the node keeps a defined edge under the sweep
          and still reads as running when motion is reduced. */}
      <div
        className={cn(
          "pointer-events-none absolute inset-0 rounded-[inherit] border-2 border-info/20",
          className
        )}
      />
    </>
  );
};
