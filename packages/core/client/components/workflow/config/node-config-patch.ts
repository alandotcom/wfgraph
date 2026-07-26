/**
 * How every node config form writes back to the node it is editing.
 *
 * A form hands back a patch: the set of config keys that change together. That
 * shape exists so a rule spanning more than one key stays a single write. The
 * webhook trigger has such a rule — editing its request schema also republishes
 * the contract downstream consumers read — and expressing it as two sequential
 * one-key writes is what let the two keys drift apart.
 *
 * Keys absent from the patch keep whatever the node already stores.
 */
export type NodeConfigPatch = Record<string, unknown>;

/** The write half of a config form's interface. */
export type UpdateNodeConfig = (patch: NodeConfigPatch) => void;
