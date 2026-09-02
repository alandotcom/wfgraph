import {
  type ExtensionCatalog,
  findIntegration,
} from "@wfgraph/shared/extensions/catalog";

/** One choice: what the builder reads, and the name a sender posts. */
export type EventChoice = {
  name: string;
  label: string;
  /** Integration label, absent for a host Event. */
  group?: string | undefined;
};

export function catalogEventChoices(catalog: ExtensionCatalog): EventChoice[] {
  return catalog.events.map((event) => ({
    name: event.name,
    label: event.label,
    group: event.integration
      ? (findIntegration(catalog, event.integration)?.label ??
        event.integration)
      : undefined,
  }));
}
