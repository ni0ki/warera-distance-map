import { useCallback, useEffect, useMemo, useState } from 'react'
import Map, { Layer, Source } from 'react-map-gl/maplibre'
import type {
  CircleLayerSpecification,
  DataDrivenPropertyValueSpecification,
  ExpressionSpecification,
  FillLayerSpecification,
  FilterSpecification,
  LineLayerSpecification,
  Map as MapLibreMap,
  MapLayerMouseEvent,
  MapLibreEvent,
  ResolvedImageSpecification,
  StyleSpecification,
  SymbolLayerSpecification,
} from 'maplibre-gl'
import * as topojson from 'topojson-client'
import type { FeatureCollection, Geometry } from 'geojson'
import { fetchMapData } from './data/mapData'
import DistanceHistogram from './DistanceHistogram'
import HopDistanceBar, { HopDistanceInstructions } from './HopDistanceBar'
import RoutePlanner from './RoutePlanner'
import { buildPath, computeHopDistances } from './graph'
import { MAX_CASES, planRoute, type PickMode, type Route } from './route'


// No raster/vector tile basemap: the game ships its own world landmass and
// country polygons, so the map is built entirely from that vector data.
const BASE_STYLE: StyleSpecification = {
  version: 8,
  glyphs: 'https://fonts.openmaptiles.org/{fontstack}/{range}.pbf',
  sources: {},
  layers: [
    { id: 'background', type: 'background', paint: { 'background-color': '#0b1c33' } },
  ],
}

// Regions further than this many travels also get a dot stipple painted on top
// of the heatmap gradient, getting denser the further away the region is.
// MapLibre can't vary a fill-pattern's geometry per feature, so one tile is
// pre-rendered per density bucket and a `step` expression picks between them.
// Each bucket shrinks the tile (denser dots) and grows the radius (bigger
// dots), so distance reads as steadily heavier stipple. Both are css px.
const DOTS_MIN_DISTANCE = 10
const DOTS_COLOR = '#3a3a3a'
const DOTS_PIXEL_RATIO = 2
const DOTS_LEVELS = [
  { minDistance: DOTS_MIN_DISTANCE + 1, tile: 9.25, radius: 0.4 },
  { minDistance: DOTS_MIN_DISTANCE + 2, tile: 9, radius: 0.6 },
  { minDistance: DOTS_MIN_DISTANCE + 3, tile: 8, radius: 0.75 },
  { minDistance: DOTS_MIN_DISTANCE + 4, tile: 7.5, radius: 1 },
  { minDistance: DOTS_MIN_DISTANCE + 5, tile: 7, radius: 1.25 },
  { minDistance: DOTS_MIN_DISTANCE + 6, tile: 6.5, radius: 1.5 },
  { minDistance: DOTS_MIN_DISTANCE + 7, tile: 6.25, radius: 1.75 },
  { minDistance: DOTS_MIN_DISTANCE + 8, tile: 6, radius: 2 },
]

const dotsImageId = (index: number) => `dots-${index}`

// Regions inside the threshold get this fully transparent tile rather than a
// data-driven fill-opacity. Every data-driven paint property costs a per-vertex
// GPU buffer that must be recomputed and re-uploaded on each selection, and the
// regions source has ~181k vertices, so dropping one is worth a 1px image.
const DOTS_BLANK_ID = 'dots-blank'

// Crate gold, home blue and a green for where the player stands, shared by the
// route line, its markers and the region outlines so a colour means the same
// thing wherever it shows up.
const ROUTE_CASE_COLOR = '#f1c40f'
const ROUTE_HOME_COLOR = '#4a90d9'
const ROUTE_PLAYER_COLOR = '#2ecc71'

// Depends on nothing, so it is hoisted: a fresh object here would make
// react-map-gl deep-compare it on every render. Same for every route paint
// below, which is why the roles ride in the data rather than in the props.
const HIGHLIGHT_PAINT = {
  'line-color': [
    'match',
    ['get', 'role'],
    'home', ROUTE_HOME_COLOR,
    'case', ROUTE_CASE_COLOR,
    'player', ROUTE_PLAYER_COLOR,
    '#ffffff',
  ],
  'line-width': ['case', ['==', ['get', 'role'], 'start'], 2.5, 1.8],
} as LineLayerSpecification['paint']

const WALKED_LEG_FILTER = ['==', ['get', 'kind'], 'walk'] as FilterSpecification
const HOME_LEG_FILTER = ['==', ['get', 'kind'], 'home'] as FilterSpecification

const ROUTE_LINE_LAYOUT = {
  'line-cap': 'round',
  'line-join': 'round',
} as LineLayerSpecification['layout']

const ROUTE_GLOW_PAINT = {
  'line-color': ROUTE_CASE_COLOR,
  'line-width': 9,
  'line-blur': 4,
  'line-opacity': 0.3,
} as LineLayerSpecification['paint']

const ROUTE_CORE_PAINT = {
  'line-color': ROUTE_CASE_COLOR,
  'line-width': 2.5,
  'line-opacity': 0.95,
} as LineLayerSpecification['paint']

// The free trip home is not walked, so it is drawn as a dashed shortcut
// straight back rather than as a path through the regions in between.
const ROUTE_HOME_LEG_PAINT = {
  'line-color': ROUTE_HOME_COLOR,
  'line-width': 1.6,
  'line-dasharray': [3, 2],
  'line-opacity': 0.85,
} as LineLayerSpecification['paint']

const ROUTE_MARKER_PAINT = {
  'circle-radius': 9,
  'circle-color': [
    'match',
    ['get', 'role'],
    'home', ROUTE_HOME_COLOR,
    'player', ROUTE_PLAYER_COLOR,
    ROUTE_CASE_COLOR,
  ],
  'circle-stroke-color': '#0b1c33',
  'circle-stroke-width': 1.5,
} as CircleLayerSpecification['paint']

// allow-overlap: two crates in neighbouring regions would otherwise drop one
// of the collection numbers, which is the one thing the marker is there for.
const ROUTE_MARKER_LAYOUT = {
  'text-field': ['get', 'label'],
  'text-size': 11,
  'text-font': ['Noto Sans Regular'],
  'text-allow-overlap': true,
  'text-ignore-placement': true,
} as SymbolLayerSpecification['layout']

const ROUTE_MARKER_LABEL_PAINT = { 'text-color': '#0b1c33' } as SymbolLayerSpecification['paint']

// Two dots per tile on opposite quarter-points, which lays them out as a
// diagonal lattice rather than a square grid. Each dot is stamped at every
// wrapped position too, so one straddling a tile edge still tiles seamlessly.
function createDotsImage(tile: number, radius: number): ImageData {
  const size = Math.round(tile * DOTS_PIXEL_RATIO)
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = DOTS_COLOR
  for (const center of [0.25, 0.75]) {
    for (const dx of [-size, 0, size]) {
      for (const dy of [-size, 0, size]) {
        ctx.beginPath()
        ctx.arc(center * size + dx, center * size + dy, radius * DOTS_PIXEL_RATIO, 0, Math.PI * 2)
        ctx.fill()
      }
    }
  }
  return ctx.getImageData(0, 0, size, size)
}

function registerDotsImages(map: MapLibreMap) {
  if (!map.hasImage(DOTS_BLANK_ID)) {
    map.addImage(DOTS_BLANK_ID, { width: 1, height: 1, data: new Uint8Array(4) })
  }
  DOTS_LEVELS.forEach((level, index) => {
    const id = dotsImageId(index)
    if (map.hasImage(id)) return
    map.addImage(id, createDotsImage(level.tile, level.radius), { pixelRatio: DOTS_PIXEL_RATIO })
  })
}

// ['step', <hop distance>, 'dots-blank', 11, 'dots-0', 12, 'dots-1', ...]
function dotsPattern(hopDistance: ExpressionSpecification) {
  return [
    'step',
    hopDistance,
    DOTS_BLANK_ID,
    ...DOTS_LEVELS.flatMap((level, index) => [level.minDistance, dotsImageId(index)]),
  ] as unknown as DataDrivenPropertyValueSpecification<ResolvedImageSpecification>
}

// Selecting a region changes a paint expression rather than the source data.
// Handing <Source> a fresh FeatureCollection makes react-map-gl call setData(),
// and MapLibre then re-serialises and re-tiles all 726 regions -- 7.3 MB and
// ~181k coordinates -- on every single click. A `match` compiles to a hash
// lookup, so resolving a region's distance stays O(1) per feature.
//
// Two shape constraints: `match` needs at least one label/output pair, and
// `interpolate` rejects a constant input, so the nothing-selected case still
// goes through a match -- one whose label can never equal a real regionId.
function hopDistanceExpression(
  distances: globalThis.Map<string, number>,
  unreachable: number,
): ExpressionSpecification {
  const branches: (string | number)[] = []
  for (const [regionId, distance] of distances) branches.push(regionId, distance)
  if (branches.length === 0) {
    return ['match', ['get', 'regionId'], '', -1, -1] as unknown as ExpressionSpecification
  }
  return [
    'match',
    ['get', 'regionId'],
    ...branches,
    unreachable,
  ] as unknown as ExpressionSpecification
}


interface MapLayers {
  lands: FeatureCollection
  countries: FeatureCollection
  countryLabels: FeatureCollection<Geometry, { countryName: string; textSize: number; textColor: string; strokeColor: string }>
  regions: FeatureCollection<
    Geometry,
    { regionId: string; lineColor: string; position: [number, number]; neighbors: string[] }
  >
  regionLabels: FeatureCollection<Geometry, { regionId: string; name: string; textColor: string; strokeColor: string }>
}

// countryLabels/regionLabels store already-real lon/lat in `coordinates`
// (verified against each country's own polygon centroid), unlike every other
// object in this topology, whose coordinates are quantized and need the
// topology's transform applied. Running these two through topojson.feature()
// re-applies that transform on top of already-real coordinates, collapsing
// every label toward the transform's translate origin. So they're read
// directly instead of going through topojson-client.
type RawPointGeometryCollection = {
  geometries: { coordinates: [number, number]; properties: Record<string, unknown> }[]
}

function pointsToFeatureCollection(geometryCollection: RawPointGeometryCollection): FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: geometryCollection.geometries.map((geometry) => ({
      type: 'Feature' as const,
      properties: geometry.properties,
      geometry: { type: 'Point' as const, coordinates: geometry.coordinates },
    })),
  }
}

// The selected region is the whole app state, so it lives in the query string:
// ?region=<regionId> makes a heatmap shareable and survives a reload. There is
// no router here, so this pokes at history directly.
const REGION_PARAM = 'region'

function readRegionFromUrl() {
  return new URLSearchParams(window.location.search).get(REGION_PARAM)
}

function writeRegionToUrl(regionId: string | null, { replace = false } = {}) {
  const url = new URL(window.location.href)
  if (regionId) url.searchParams.set(REGION_PARAM, regionId)
  else url.searchParams.delete(REGION_PARAM)
  if (replace) window.history.replaceState(null, '', url)
  else window.history.pushState(null, '', url)
}

// The home region is a property of the player rather than of the link, so it
// outlives the query string: a cookie brings it back on any later visit,
// including one through a shared ?region= url that carries someone else's
// selection. The crates themselves are not stored -- they move every hour.
const HOME_COOKIE = 'warera-home-region'
const HOME_COOKIE_MAX_AGE = 60 * 60 * 24 * 365

function readHomeFromCookie() {
  const match = document.cookie.match(new RegExp(`(?:^|;\\s*)${HOME_COOKIE}=([^;]*)`))
  return match ? decodeURIComponent(match[1]) : null
}

function writeHomeToCookie(regionId: string | null) {
  const value = regionId ? encodeURIComponent(regionId) : ''
  const maxAge = regionId ? HOME_COOKIE_MAX_AGE : 0
  document.cookie = `${HOME_COOKIE}=${value}; path=/; max-age=${maxAge}; samesite=lax`
}

// A planned route kept with the inputs it was planned for, so a changed
// position, home or crate list invalidates it during render rather than
// through an effect.
interface PlannedRoute {
  playerId: string
  homeId: string | null
  caseIds: string[]
  route: Route
}

// Touch devices have no hover, so there is no way to point at a destination
// without committing to it. `(hover: hover)` is the primary-pointer test the
// CSS spec defines for exactly this, and it is watched rather than read once so
// a 2-in-1 switching between trackpad and touch keeps up.
function useCanHover() {
  const [canHover, setCanHover] = useState(() => window.matchMedia('(hover: hover)').matches)

  useEffect(() => {
    const query = window.matchMedia('(hover: hover)')
    const sync = () => setCanHover(query.matches)
    query.addEventListener('change', sync)
    return () => query.removeEventListener('change', sync)
  }, [])

  return canHover
}

function BaseMap() {
  const [layers, setLayers] = useState<MapLayers | null>(null)
  const [requestedRegionId, setRequestedRegionId] = useState<string | null>(readRegionFromUrl)
  const [hoveredRegionId, setHoveredRegionId] = useState<string | null>(null)
  const [tappedTargetId, setTappedTargetId] = useState<string | null>(null)
  const canHover = useCanHover()
  const [dotsReady, setDotsReady] = useState(false)
  const [requestedHomeId, setRequestedHomeId] = useState<string | null>(readHomeFromCookie)
  // Where the player stands right now. Not persisted: it changes with every
  // trip, unlike home.
  const [playerId, setPlayerId] = useState<string | null>(null)
  const [caseIds, setCaseIds] = useState<string[]>([])
  const [picking, setPicking] = useState<PickMode>(null)
  const [plan, setPlan] = useState<PlannedRoute | null>(null)

  const handleLoad = useCallback((event: MapLibreEvent) => {
    registerDotsImages(event.target)
    setDotsReady(true)
  }, [])

  useEffect(() => {
    let cancelled = false

    fetchMapData()
      .then((data) => {
        if (cancelled) return
        const { objects } = data.map
        setLayers({
          lands: topojson.feature(data.map, objects.lands) as FeatureCollection,
          countries: topojson.feature(data.map, objects.countries) as FeatureCollection,
          countryLabels: pointsToFeatureCollection(
            objects.countryLabels as unknown as RawPointGeometryCollection,
          ) as MapLayers['countryLabels'],
          regions: topojson.feature(data.map, objects.regions) as MapLayers['regions'],
          regionLabels: pointsToFeatureCollection(
            objects.regionLabels as unknown as RawPointGeometryCollection,
          ) as MapLayers['regionLabels'],
        })
      })
      .catch((err) => {
        console.error('Failed to load map data', err)
      })

    return () => {
      cancelled = true
    }
  }, [])

  // Back/forward move through previously selected regions.
  useEffect(() => {
    const syncFromUrl = () => {
      setRequestedRegionId(readRegionFromUrl())
      setTappedTargetId(null)
    }
    window.addEventListener('popstate', syncFromUrl)
    return () => window.removeEventListener('popstate', syncFromUrl)
  }, [])

  const regionNameById = useMemo(() => {
    const map = new globalThis.Map<string, string>()
    for (const feature of layers?.regionLabels.features ?? []) {
      map.set(feature.properties.regionId, feature.properties.name)
    }
    return map
  }, [layers])

  const adjacency = useMemo(() => {
    const map = new globalThis.Map<string, string[]>()
    for (const feature of layers?.regions.features ?? []) {
      map.set(feature.properties.regionId, feature.properties.neighbors)
    }
    return map
  }, [layers])

  // A ?region= pointing at something this map doesn't have would otherwise BFS
  // from a phantom node and paint every region as unreachable, so it is dropped
  // rather than selected -- both here and (once the data is in) from the url.
  const selectedRegionId =
    requestedRegionId && layers && !adjacency.has(requestedRegionId) ? null : requestedRegionId

  useEffect(() => {
    if (!layers || !requestedRegionId || adjacency.has(requestedRegionId)) return
    console.warn('Unknown region in url, ignoring:', requestedRegionId)
    writeRegionToUrl(null, { replace: true })
  }, [layers, requestedRegionId, adjacency])

  // Same treatment as ?region=: a cookie written before a map update can name
  // a region that no longer exists, which would plan every route from a
  // phantom node, so it is dropped rather than used.
  const homeId =
    requestedHomeId && layers && !adjacency.has(requestedHomeId) ? null : requestedHomeId

  useEffect(() => {
    if (!layers || !requestedHomeId || adjacency.has(requestedHomeId)) return
    console.warn('Unknown home region in cookie, ignoring:', requestedHomeId)
    writeHomeToCookie(null)
  }, [layers, requestedHomeId, adjacency])

  // A route only describes the position, home and crates it was planned for,
  // so it is kept alongside them and read back only while all three match.
  const route =
    plan && plan.playerId === playerId && plan.homeId === homeId && plan.caseIds === caseIds
      ? plan.route
      : null

  // Arming a pick takes over the next map click, so there has to be a way out
  // that does not commit to a region.
  useEffect(() => {
    if (!picking) return
    const cancel = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPicking(null)
    }
    window.addEventListener('keydown', cancel)
    return () => window.removeEventListener('keydown', cancel)
  }, [picking])

  const positionById = useMemo(() => {
    const map = new globalThis.Map<string, [number, number]>()
    for (const feature of layers?.regions.features ?? []) {
      map.set(feature.properties.regionId, feature.properties.position)
    }
    return map
  }, [layers])

  const handleClick = useCallback(
    (event: MapLayerMouseEvent) => {
      const regionId = event.features?.[0]?.properties?.regionId as string | undefined

      // Armed by the route planner: the click assigns a role instead of moving
      // the heatmap, and a click on the sea disarms rather than committing.
      if (picking) {
        if (!regionId) {
          setPicking(null)
          return
        }
        if (picking === 'player') {
          setPlayerId(regionId)
          setPicking(null)
          return
        }
        if (picking === 'home') {
          setRequestedHomeId(regionId)
          writeHomeToCookie(regionId)
          setPicking(null)
          return
        }
        if (caseIds.includes(regionId)) {
          setCaseIds(caseIds.filter((id) => id !== regionId))
          return
        }
        if (caseIds.length >= MAX_CASES) return
        const nextCases = [...caseIds, regionId]
        setCaseIds(nextCases)
        // Nothing left to pick, so stop swallowing clicks.
        if (nextCases.length >= MAX_CASES) setPicking(null)
        return
      }

      if (!regionId) {
        setRequestedRegionId(null)
        setTappedTargetId(null)
        writeRegionToUrl(null)
        return
      }
      console.log(regionNameById.get(regionId) ?? '(unknown region)', regionId)

      // Without hover a tap has to carry both roles: the first picks the start,
      // the second picks the destination, and a third starts over from there.
      if (!canHover && selectedRegionId && !tappedTargetId) {
        if (regionId !== selectedRegionId) setTappedTargetId(regionId)
        return
      }

      setTappedTargetId(null)
      setRequestedRegionId(regionId)
      writeRegionToUrl(regionId)
    },
    [regionNameById, canHover, selectedRegionId, tappedTargetId, picking, caseIds],
  )

  const handleHover = useCallback(
    (event: MapLayerMouseEvent) => {
      if (!canHover) return // a tap synthesises mousemove; ignore it
      setHoveredRegionId((event.features?.[0]?.properties?.regionId as string | undefined) ?? null)
    },
    [canHover],
  )

  const handleClearPlayer = useCallback(() => {
    setPlayerId(null)
    setPicking((mode) => (mode === 'player' ? null : mode))
  }, [])

  const handleClearHome = useCallback(() => {
    setRequestedHomeId(null)
    writeHomeToCookie(null)
    setPicking((mode) => (mode === 'home' ? null : mode))
  }, [])

  const handleClearCases = useCallback(() => {
    setCaseIds([])
    setPicking((mode) => (mode === 'case' ? null : mode))
  }, [])

  const handleRemoveCase = useCallback((regionId: string) => {
    setCaseIds((previous) => previous.filter((id) => id !== regionId))
  }, [])

  const handlePlanRoute = useCallback(() => {
    if (!playerId || caseIds.length === 0) return
    setPicking(null)
    setPlan({ playerId, homeId, caseIds, route: planRoute(playerId, homeId, caseIds, adjacency) })
  }, [playerId, homeId, caseIds, adjacency])

  const regionName = useCallback(
    (regionId: string) => regionNameById.get(regionId) ?? '?',
    [regionNameById],
  )

  // Whichever way the destination was picked, the rest of the map reads it here.
  const targetRegionId = canHover ? hoveredRegionId : tappedTargetId

  const handleMouseLeave = useCallback(() => setHoveredRegionId(null), [])

  // BFS hop-distance ("travels") from the selected region to every other one.
  // Cheap: 726 nodes, ~2.5k edges.
  const heatmap = useMemo(() => {
    const empty = {
      maxHop: 1,
      distances: new globalThis.Map<string, number>(),
      predecessors: new globalThis.Map<string, string>(),
    }
    if (!layers || !selectedRegionId) return empty

    const { distances, predecessors } = computeHopDistances(selectedRegionId, adjacency)
    return { maxHop: Math.max(1, ...distances.values()), distances, predecessors }
  }, [layers, selectedRegionId, adjacency])

  // The whole heatmap in one expression: regionId -> travels, with unreachable
  // regions falling back to maxHop and -1 standing for "nothing selected",
  // which the fill-opacity expression renders as fully transparent (the layer
  // then only serves as an invisible click target).
  const hopDistance = useMemo(
    () => hopDistanceExpression(heatmap.distances, heatmap.maxHop),
    [heatmap],
  )

  // Memoised so their identity is stable: react-map-gl bails out of its paint
  // diff on `paint !== prevProps.paint`, and without that it deep-walks these
  // expressions -- the match alone is ~1.5k elements -- on every single render,
  // hover included.
  //
  // Each layer also carries exactly one data-driven paint property rather than
  // two. A data-driven property is stored as a per-vertex GPU buffer that has to
  // be recomputed and re-uploaded whenever the expression changes, and this
  // source has ~181k vertices, so the second one is not free.
  const regionsFillPaint = useMemo(() => {
    const ramp = (alpha: number) =>
      [
        'interpolate',
        ['linear'],
        hopDistance,
        0, `rgba(46, 204, 113, ${alpha})`,
        heatmap.maxHop / 2, `rgba(241, 196, 15, ${alpha})`,
        heatmap.maxHop, `rgba(231, 76, 60, ${alpha})`,
      ] as unknown as ExpressionSpecification

    return {
      // the alpha rides inside the colour ramp instead of a second property;
      // past the dot threshold it drops so the dark ground dulls the colour
      'fill-color': ['step', hopDistance, ramp(0.9), DOTS_MIN_DISTANCE + 1, ramp(0.75)],
      // constant, so it costs no per-vertex buffer at all
      'fill-opacity': selectedRegionId ? 1 : 0,
    } as FillLayerSpecification['paint']
  }, [hopDistance, heatmap.maxHop, selectedRegionId])

  const regionsDotsPaint = useMemo(
    () =>
      ({
        'fill-pattern': dotsPattern(hopDistance),
        'fill-opacity': 0.85,
      }) as FillLayerSpecification['paint'],
    [hopDistance],
  )

  // The shortest path (sequence of regionIds) from the selected region to
  // whichever region is currently hovered, reconstructed from the same BFS
  // pass used to paint the heatmap.
  const hoverPath = useMemo(() => {
    if (!selectedRegionId || !targetRegionId || targetRegionId === selectedRegionId) return []
    return buildPath(selectedRegionId, targetRegionId, heatmap.predecessors)
  }, [selectedRegionId, targetRegionId, heatmap.predecessors])

  const regionFeatureById = useMemo(() => {
    const map = new globalThis.Map<string, MapLayers['regions']['features'][number]>()
    for (const feature of layers?.regions.features ?? []) {
      map.set(feature.properties.regionId, feature)
    }
    return map
  }, [layers])

  // At most nine features -- start, target, home, position and five crates --
  // so re-uploading it on every hover is cheap. Pushed least to most telling,
  // because one region can hold several roles and the last drawn outline wins.
  const highlightData = useMemo<FeatureCollection>(() => {
    const features = []
    const start = selectedRegionId ? regionFeatureById.get(selectedRegionId) : undefined
    const target =
      targetRegionId && targetRegionId !== selectedRegionId
        ? regionFeatureById.get(targetRegionId)
        : undefined
    if (start) features.push({ ...start, properties: { role: 'start' } })
    if (target) features.push({ ...target, properties: { role: 'target' } })
    const home = homeId ? regionFeatureById.get(homeId) : undefined
    if (home) features.push({ ...home, properties: { role: 'home' } })
    const player = playerId ? regionFeatureById.get(playerId) : undefined
    if (player) features.push({ ...player, properties: { role: 'player' } })
    for (const caseId of caseIds) {
      const crate = regionFeatureById.get(caseId)
      if (crate) features.push({ ...crate, properties: { role: 'case' } })
    }
    return { type: 'FeatureCollection', features }
  }, [selectedRegionId, targetRegionId, regionFeatureById, homeId, playerId, caseIds])

  const hoverPathLinks = useMemo<FeatureCollection>(() => {
    const features = []
    for (let i = 0; i < hoverPath.length - 1; i++) {
      const from = positionById.get(hoverPath[i])
      const to = positionById.get(hoverPath[i + 1])
      if (!from || !to) continue
      features.push({
        type: 'Feature' as const,
        properties: {},
        geometry: { type: 'LineString' as const, coordinates: [from, to] },
      })
    }
    return { type: 'FeatureCollection', features }
  }, [hoverPath, positionById])

  // Every walked leg drawn region by region, with the free trips home as one
  // straight dashed jump: no regions are crossed on the way, so drawing a path
  // there would claim a cost the trip does not have.
  const routeLinks = useMemo<FeatureCollection>(() => {
    const features = []
    if (route && playerId) {
      let position = playerId
      for (const step of route.steps) {
        if (step.viaHome && homeId) {
          const from = positionById.get(position)
          const to = positionById.get(homeId)
          if (from && to) {
            features.push({
              type: 'Feature' as const,
              properties: { kind: 'home' },
              geometry: { type: 'LineString' as const, coordinates: [from, to] },
            })
          }
        }
        for (let i = 0; i < step.path.length - 1; i++) {
          const from = positionById.get(step.path[i])
          const to = positionById.get(step.path[i + 1])
          if (!from || !to) continue
          features.push({
            type: 'Feature' as const,
            properties: { kind: 'walk' },
            geometry: { type: 'LineString' as const, coordinates: [from, to] },
          })
        }
        position = step.caseId
      }
    }
    return { type: 'FeatureCollection', features }
  }, [route, playerId, homeId, positionById])

  // Pins for home, the player and every crate, readable at any zoom unlike the
  // region outlines. Once a route exists each crate wears the order it is
  // collected in. One pin per region, since a crate can sit on the region you
  // are standing on and you can be standing at home: whichever role says the
  // most about the region wins, and the panel spells the rest out.
  //
  // 'H' and 'P' rather than a house or a pin glyph: the label stack is Noto
  // Sans and a glyph it is missing renders as nothing at all.
  const routeMarkers = useMemo<FeatureCollection>(() => {
    const orderByCase = new globalThis.Map<string, number>()
    route?.steps.forEach((step, index) => orderByCase.set(step.caseId, index + 1))

    const pins = new globalThis.Map<string, { role: string; label: string }>()
    if (homeId) pins.set(homeId, { role: 'home', label: 'H' })
    if (playerId) pins.set(playerId, { role: 'player', label: 'P' })
    for (const caseId of caseIds) {
      const order = orderByCase.get(caseId)
      pins.set(caseId, { role: 'case', label: order ? String(order) : '' })
    }

    const features = []
    for (const [regionId, properties] of pins) {
      const position = positionById.get(regionId)
      if (!position) continue
      features.push({
        type: 'Feature' as const,
        properties,
        geometry: { type: 'Point' as const, coordinates: position },
      })
    }
    return { type: 'FeatureCollection', features }
  }, [route, homeId, playerId, caseIds, positionById])

  return (
    <>
      <Map
        initialViewState={{
          longitude: 10,
          latitude: 20,
          zoom: 3,
        }}
        style={{ width: '100%', height: '100%' }}
        mapStyle={BASE_STYLE}
        cursor={picking ? 'crosshair' : undefined}
        onLoad={handleLoad}
        interactiveLayerIds={layers ? ['regions-fill'] : []}
        onClick={handleClick}
        onMouseMove={handleHover}
        onMouseOut={handleMouseLeave}
      >
        {layers && (
          <>
            <Source id="lands" type="geojson" data={layers.lands}>
              <Layer id="lands-fill" type="fill" paint={{ 'fill-color': '#1c2e4a' }} />
            </Source>

            <Source id="countries" type="geojson" data={layers.countries}>
              <Layer
                id="countries-fill"
                type="fill"
                paint={{
                  'fill-color': ['get', 'fillColor'],
                  'fill-opacity': selectedRegionId ? 1 : 0,
                }}
              />
              <Layer
                id="countries-outline"
                type="line"
                paint={{
                  'line-color': selectedRegionId ? ['get', 'outlineColor'] : '#5a5a5a',
                  'line-width': 1,
                }}
              />
            </Source>

            <Source id="regions" type="geojson" data={layers.regions}>
              {/* also doubles as the heatmap fill once a region is selected: no
                  minzoom, so the heatmap stays visible even fully zoomed out */}
              <Layer
                id="regions-fill"
                type="fill"
                paint={regionsFillPaint}
              />
              {/* dot stipple over the far-away regions; denser the further out */}
              {dotsReady && (
                <Layer
                  id="regions-dots"
                  type="fill"
                  paint={regionsDotsPaint}
                />
              )}
              <Layer
                id="regions-outline"
                type="line"
                minzoom={3}
                paint={{
                  'line-color': selectedRegionId ? '#000000' : '#cccccc',
                  'line-width': 0.6,
                  'line-opacity': selectedRegionId ? 0.8 : 0.6,
                }}
              />
            </Source>

            {/* The start and destination outlines live on their own source of at
                most two features. Filtering them out of the 726-region source
                instead would make MapLibre re-bucket every region tile on each
                hover, which is what made hovering crawl. No minzoom, unlike
                regions-outline: they stay visible however far out you zoom. */}
            <Source id="highlight" type="geojson" data={highlightData}>
              <Layer
                id="highlight-outline"
                type="line"
                paint={HIGHLIGHT_PAINT}
              />
            </Source>

            <Source id="hover-path" type="geojson" data={hoverPathLinks}>
              <Layer
                id="hover-path-glow"
                type="line"
                layout={{ 'line-cap': 'round', 'line-join': 'round' }}
                paint={{ 'line-color': '#ffffff', 'line-width': 8, 'line-blur': 4, 'line-opacity': 0.35 }}
              />
              <Layer
                id="hover-path-core"
                type="line"
                layout={{ 'line-cap': 'round', 'line-join': 'round' }}
                paint={{ 'line-color': '#ffffff', 'line-width': 2, 'line-opacity': 0.95 }}
              />
            </Source>

            <Source id="region-labels" type="geojson" data={layers.regionLabels}>
              <Layer
                id="region-labels-symbol"
                type="symbol"
                minzoom={4}
                layout={{
                  'text-field': ['get', 'name'],
                  'text-size': 11,
                  'text-font': ['Noto Sans Regular'],
                }}
                paint={{
                  'text-color': '#ffffff',
                  'text-halo-color': '#000000',
                  'text-halo-width': 1,
                }}
              />
            </Source>

            {/* The planned trip, declared last so it draws over the labels. */}
            <Source id="route" type="geojson" data={routeLinks}>
              <Layer
                id="route-glow"
                type="line"
                filter={WALKED_LEG_FILTER}
                layout={ROUTE_LINE_LAYOUT}
                paint={ROUTE_GLOW_PAINT}
              />
              <Layer
                id="route-core"
                type="line"
                filter={WALKED_LEG_FILTER}
                layout={ROUTE_LINE_LAYOUT}
                paint={ROUTE_CORE_PAINT}
              />
              <Layer
                id="route-home-leg"
                type="line"
                filter={HOME_LEG_FILTER}
                layout={ROUTE_LINE_LAYOUT}
                paint={ROUTE_HOME_LEG_PAINT}
              />
            </Source>

            <Source id="route-markers" type="geojson" data={routeMarkers}>
              <Layer id="route-markers-pin" type="circle" paint={ROUTE_MARKER_PAINT} />
              <Layer
                id="route-markers-label"
                type="symbol"
                layout={ROUTE_MARKER_LAYOUT}
                paint={ROUTE_MARKER_LABEL_PAINT}
              />
            </Source>
          </>
        )}
      </Map>

      {layers && selectedRegionId && (
        <DistanceHistogram
          regionName={regionNameById.get(selectedRegionId) ?? '?'}
          distances={heatmap.distances}
          totalRegions={layers.regions.features.length}
        />
      )}

      {layers && (
        <RoutePlanner
          playerId={playerId}
          homeId={homeId}
          caseIds={caseIds}
          regionName={regionName}
          picking={picking}
          onPick={setPicking}
          onClearPlayer={handleClearPlayer}
          onClearHome={handleClearHome}
          onRemoveCase={handleRemoveCase}
          onClearCases={handleClearCases}
          onPlan={handlePlanRoute}
          route={route}
        />
      )}

      {!selectedRegionId && <HopDistanceInstructions canHover={canHover} />}

      {selectedRegionId && targetRegionId && targetRegionId !== selectedRegionId && (
        <HopDistanceBar
          fromName={regionNameById.get(selectedRegionId) ?? '?'}
          toName={regionNameById.get(targetRegionId) ?? '?'}
          travels={heatmap.distances.get(targetRegionId)}
        />
      )}
    </>
  )
}

export default BaseMap
