import { atom } from "jotai";
import type { OverlayStackItem } from "@/components/overlays/types";

/**
 * Mirror of the overlay stack that OverlayProvider owns. overlay-sync.tsx
 * writes the provider's stack in here whenever it changes, which is what lets
 * Jotai-based code subscribe to overlay state.
 */
export const overlayStackAtom = atom<OverlayStackItem[]>([]);
