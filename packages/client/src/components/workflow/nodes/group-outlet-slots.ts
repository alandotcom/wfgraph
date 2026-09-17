/**
 * Where a collapsed Group card places its bottom outlets. The bottom edge is
 * split into one equal slot per outlet, each handle sits at its slot's centre,
 * and each label is at most its slot's width less a small gap, so two labels
 * never overlap. Offsets and widths are CSS percentages of the card's width.
 */

/** The gap, in pixels, kept between two neighbouring outlet labels. */
const LABEL_GAP_PX = 4;

export type GroupOutletSlot = {
  /** The handle's and label's centre, from the card's left edge. */
  offset: string;
  /** The widest a label may draw before it truncates. */
  labelMaxWidth: string;
};

/** The slots of `count` outlets, left to right. */
export function groupOutletSlots(count: number): GroupOutletSlot[] {
  const slotPercent = 100 / count;
  return Array.from({ length: count }, (_, index) => ({
    offset: `${(index + 0.5) * slotPercent}%`,
    labelMaxWidth: `calc(${slotPercent}% - ${LABEL_GAP_PX}px)`,
  }));
}
