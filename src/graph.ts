export type Adjacency = Map<string, string[]>

// Unweighted, undirected adjacency graph -> plain BFS gives the shortest
// hop count ("travels") from sourceId to every reachable region, plus a
// predecessor map so the actual shortest path can be reconstructed later.
export function computeHopDistances(sourceId: string, adjacency: Adjacency) {
  const distances = new Map<string, number>([[sourceId, 0]])
  const predecessors = new Map<string, string>()
  const queue = [sourceId]
  let head = 0
  while (head < queue.length) {
    const current = queue[head++]
    const currentDistance = distances.get(current)!
    for (const neighborId of adjacency.get(current) ?? []) {
      if (!distances.has(neighborId)) {
        distances.set(neighborId, currentDistance + 1)
        predecessors.set(neighborId, current)
        queue.push(neighborId)
      }
    }
  }
  return { distances, predecessors }
}

export function buildPath(
  sourceId: string,
  targetId: string,
  predecessors: Map<string, string>,
): string[] {
  const path = [targetId]
  let current = targetId
  while (current !== sourceId) {
    const previous = predecessors.get(current)
    if (!previous) return [] // unreachable
    path.push(previous)
    current = previous
  }
  return path.reverse()
}
