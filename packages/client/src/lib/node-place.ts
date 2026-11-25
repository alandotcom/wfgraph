/**
 * Where a step sits in its workflow, said in step names, so two steps a person
 * sees under one name can be told apart without printing an id. The command
 * palette shows the place under every step it finds, and the issues list adds
 * it to a heading only when another step has the same name.
 *
 * `nameOf` is the caller's, so each surface keeps the names it already shows.
 */

import { compact } from "es-toolkit/array";

/**
 * Generic over the node, because the editor's canvas nodes and the persisted
 * nodes the issue collector reads are different types with these fields.
 */
type NodePlaceInput<
  Node extends { id: string; parentId?: string | undefined },
> = {
  nodes: readonly Node[];
  edges: readonly { source: string; target: string }[];
  nameOf: (node: Node) => string;
};

/**
 * Each node's place as a phrase: the Group it is in and the step its first
 * incoming connection comes from, as "in Lookups, after Send email". A node
 * with neither, such as the Lifecycle node, has no entry.
 */
export function nodePlaces<
  Node extends { id: string; parentId?: string | undefined },
>(input: NodePlaceInput<Node>): Map<string, string> {
  // Maps keyed by node id: an id is text a saved graph or the build agent
  // chose, so a plain record could lose a node named `__proto__`.
  const byId = new Map(input.nodes.map((node) => [node.id, node]));
  const firstSourceByTarget = new Map<string, string>();
  for (const edge of input.edges) {
    if (!firstSourceByTarget.has(edge.target) && byId.has(edge.source)) {
      firstSourceByTarget.set(edge.target, edge.source);
    }
  }

  return new Map(
    input.nodes.flatMap((node) => {
      const group =
        node.parentId === undefined ? undefined : byId.get(node.parentId);
      const sourceId = firstSourceByTarget.get(node.id);
      const source = sourceId === undefined ? undefined : byId.get(sourceId);
      const place = compact([
        group ? `in ${input.nameOf(group)}` : undefined,
        source ? `after ${input.nameOf(source)}` : undefined,
      ]).join(", ");
      return place === "" ? [] : [[node.id, place] as const];
    })
  );
}

/**
 * Each node's name, with its place added in parentheses when another node in
 * the graph has the same name: two unnamed steps read "Action (after Send
 * email)" and "Action (after Wait 1 day)".
 */
export function distinctNodeNames<
  Node extends { id: string; parentId?: string | undefined },
>(input: NodePlaceInput<Node>): Map<string, string> {
  const names = new Map(
    input.nodes.map((node) => [node.id, input.nameOf(node)])
  );
  const nodesByName = Map.groupBy(
    input.nodes,
    (node) => names.get(node.id) ?? ""
  );
  const places = nodePlaces(input);

  return new Map(
    input.nodes.map((node) => {
      const name = names.get(node.id) ?? "";
      const place = places.get(node.id);
      const shared = (nodesByName.get(name)?.length ?? 0) > 1;
      return [node.id, shared && place ? `${name} (${place})` : name];
    })
  );
}
