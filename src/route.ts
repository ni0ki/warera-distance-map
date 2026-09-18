import { buildPath, computeHopDistances, type Adjacency } from './graph'

// The game only ever holds five of your crates on the map at once.
export const MAX_CASES = 5

// While set, a click on the map assigns that role instead of moving the
// heatmap's origin.
export type PickMode = 'player' | 'home' | 'case' | null

export interface RouteStep {
  caseId: string
  // Travels walked to reach this crate, the trip home excluded since it is free.
  travels: number
  // True on the one leg that spends the free trip home before walking out.
  viaHome: boolean
  // Regions walked through, starting at wherever the walk began.
  path: string[]
}

export interface Route {
  steps: RouteStep[]
  travels: number
  // Crates neither the player nor home can walk to, so never collectable.
  unreachable: string[]
}

// Travelling home is free, but only once a trip, so the route has two things to
// decide: the order the crates are collected in, and which single leg (if any)
// is worth starting from home rather than from the crate just collected.
//
// That is a small asymmetric TSP with a fixed start, a free end and one
// teleport, solved exactly by the usual Held-Karp pass over subsets with the
// spent/unspent trip home carried as an extra bit of state -- 2^5 x 5 x 2
// states here, so "best" really is best and not a heuristic.
export function planRoute(
  startId: string,
  homeId: string | null,
  caseIds: string[],
  adjacency: Adjacency,
): Route {
  // One BFS per distinct origin (the player, home, each crate), memoised: at
  // most seven passes over 726 nodes, and the predecessors double as the path
  // the route draws.
  const searches = new Map<string, ReturnType<typeof computeHopDistances>>()
  const searchFrom = (regionId: string) => {
    let search = searches.get(regionId)
    if (!search) {
      search = computeHopDistances(regionId, adjacency)
      searches.set(regionId, search)
    }
    return search
  }
  const distance = (fromId: string, toId: string) =>
    searchFrom(fromId).distances.get(toId) ?? Infinity

  // The trip home is a teleport rather than a walk, so a crate on a landmass
  // the player cannot reach still counts as long as home is on it.
  const startDistances = searchFrom(startId).distances
  const homeDistances = homeId ? searchFrom(homeId).distances : null
  const wanted = [...new Set(caseIds)]
  const crates = wanted.filter((id) => startDistances.has(id) || homeDistances?.has(id))
  const unreachable = wanted.filter((id) => !crates.includes(id))
  if (crates.length === 0) return { steps: [], travels: 0, unreachable }

  // best[collected][last][spent]: cheapest way to hold exactly `collected`,
  // standing on crate `last`, with the free trip home spent or still in hand.
  // cameFrom holds the previous (crate, spent) pair encoded as crate * 2 + spent.
  const count = crates.length
  const stateCount = 1 << count
  const best = Array.from({ length: stateCount }, () =>
    Array.from({ length: count }, () => [Infinity, Infinity]),
  )
  const cameFrom = Array.from({ length: stateCount }, () =>
    Array.from({ length: count }, () => [-1, -1]),
  )

  for (let crate = 0; crate < count; crate++) {
    best[1 << crate][crate][0] = distance(startId, crates[crate])
    if (homeId) best[1 << crate][crate][1] = distance(homeId, crates[crate])
  }
  for (let collected = 1; collected < stateCount; collected++) {
    for (let last = 0; last < count; last++) {
      if (!(collected & (1 << last))) continue
      for (let spent = 0; spent < 2; spent++) {
        const costSoFar = best[collected][last][spent]
        if (costSoFar === Infinity) continue
        for (let next = 0; next < count; next++) {
          if (collected & (1 << next)) continue
          const reached = collected | (1 << next)
          const walked = costSoFar + distance(crates[last], crates[next])
          if (walked < best[reached][next][spent]) {
            best[reached][next][spent] = walked
            cameFrom[reached][next][spent] = last * 2 + spent
          }
          // spending the one free trip home on this leg instead
          if (spent === 0 && homeId) {
            const fromHome = costSoFar + distance(homeId, crates[next])
            if (fromHome < best[reached][next][1]) {
              best[reached][next][1] = fromHome
              cameFrom[reached][next][1] = last * 2 + 0
            }
          }
        }
      }
    }
  }

  // The trip ends wherever the last crate is, and an unspent trip home wins
  // ties: it is worth keeping when it buys nothing.
  const allCollected = stateCount - 1
  let travels = Infinity
  let endsAt = -1
  let endsSpent = 0
  for (let spent = 0; spent < 2; spent++) {
    for (let crate = 0; crate < count; crate++) {
      if (best[allCollected][crate][spent] < travels) {
        travels = best[allCollected][crate][spent]
        endsAt = crate
        endsSpent = spent
      }
    }
  }
  // Only reachable through a home no walk from here connects to, in an order
  // that does not exist -- the filter above rules this out, so it is a guard.
  if (endsAt === -1 || travels === Infinity) return { steps: [], travels: 0, unreachable: wanted }

  const order: { crate: number; viaHome: boolean }[] = []
  let collected = allCollected
  let current = endsAt
  let spent = endsSpent
  while (current !== -1) {
    const previous = cameFrom[collected][current][spent]
    // the start leg has no predecessor, and its own bit says how it was walked
    const previousSpent = previous === -1 ? 0 : previous % 2
    order.push({ crate: current, viaHome: spent > previousSpent })
    collected ^= 1 << current
    current = previous === -1 ? -1 : Math.floor(previous / 2)
    spent = previousSpent
  }
  order.reverse()

  const steps: RouteStep[] = []
  let position = startId
  for (const { crate, viaHome } of order) {
    const caseId = crates[crate]
    const walkFrom = viaHome ? homeId! : position
    steps.push({
      caseId,
      travels: distance(walkFrom, caseId),
      viaHome,
      path: buildPath(walkFrom, caseId, searchFrom(walkFrom).predecessors),
    })
    position = caseId
  }

  return { steps, travels, unreachable }
}
