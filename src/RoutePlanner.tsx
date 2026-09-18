import { useMemo, useState } from 'react'
import TravelCostReadout from './TravelCost'
import { BARILS_PER_EXTRA_TRAVEL, MAX_STAMINA_TRAVELS } from './travel'
import { MAX_CASES, type PickMode, type Route } from './route'

const CRATE_ICON_URL = 'https://media.warera.io/images/itemsv2/woodenCase.png?v=1'

function regionCount(travels: number) {
  return `${travels} region${travels === 1 ? '' : 's'}`
}

interface RegionFieldProps {
  label: string
  regionId: string | null
  regionName: (regionId: string) => string
  armed: boolean
  onArm: () => void
  onClear: () => void
}

function RegionField({ label, regionId, regionName, armed, onArm, onClear }: RegionFieldProps) {
  return (
    <div className="route-planner__field">
      <span className="route-planner__field-label">{label}</span>
      {/* the column is narrow enough to ellipsise a long name, so the full one
          stays available on hover */}
      <span className="route-planner__field-value" title={regionId ? regionName(regionId) : undefined}>
        {regionId ? regionName(regionId) : <em className="route-planner__empty">not set</em>}
      </span>
      <button type="button" className="route-planner__button" aria-pressed={armed} onClick={onArm}>
        {armed ? 'Picking…' : regionId ? 'Change' : 'Set'}
      </button>
      <button
        type="button"
        className="route-planner__button"
        disabled={!regionId}
        onClick={onClear}
        title={`Clear ${label.toLowerCase()}`}
      >
        Reset
      </button>
    </div>
  )
}

const PICK_HINTS: Record<Exclude<PickMode, null>, string> = {
  player: 'Click the region you are standing on',
  home: 'Click your home region',
  case: 'Click a region holding a case — click a picked one again to drop it',
}

interface RoutePlannerProps {
  playerId: string | null
  homeId: string | null
  caseIds: string[]
  regionName: (regionId: string) => string
  picking: PickMode
  onPick: (mode: PickMode) => void
  onClearPlayer: () => void
  onClearHome: () => void
  onRemoveCase: (regionId: string) => void
  onClearCases: () => void
  onPlan: () => void
  route: Route | null
}

// Unlike the other panels this one is interactive, so it keeps its pointer
// events and arms the map instead of reading it: while `picking` is set the
// next click on a region lands here rather than moving the heatmap's origin.
function RoutePlanner({
  playerId,
  homeId,
  caseIds,
  regionName,
  picking,
  onPick,
  onClearPlayer,
  onClearHome,
  onRemoveCase,
  onClearCases,
  onPlan,
  route,
}: RoutePlannerProps) {
  const [open, setOpen] = useState(false)

  // Once a route exists each crate carries the position it is collected at.
  const orderByCase = useMemo(() => {
    const order = new Map<string, number>()
    route?.steps.forEach((step, index) => order.set(step.caseId, index + 1))
    return order
  }, [route])

  // Home only ever makes a route cheaper, so it is not required to plan one.
  const canPlan = playerId !== null && caseIds.length > 0
  const extraTravels = route ? Math.max(0, route.travels - MAX_STAMINA_TRAVELS) : 0

  return (
    <>
      {/* Same collapse pattern as the histogram: the button and the collapsed
          state only exist under the phone breakpoint, CSS decides which. */}
      <button
        type="button"
        className="route-planner-toggle"
        aria-expanded={open}
        aria-controls="route-planner"
        onClick={() => setOpen((wasOpen) => !wasOpen)}
      >
        {open ? 'Hide crates' : 'Crates'}
      </button>

      <section id="route-planner" className="route-planner" data-open={open}>
        <h2 className="route-planner__title">
          <img className="route-planner__crate-icon" src={CRATE_ICON_URL} alt="" />
          Wooden case route
        </h2>

        <RegionField
          label="You are"
          regionId={playerId}
          regionName={regionName}
          armed={picking === 'player'}
          onArm={() => onPick(picking === 'player' ? null : 'player')}
          onClear={onClearPlayer}
        />
        <RegionField
          label="Home"
          regionId={homeId}
          regionName={regionName}
          armed={picking === 'home'}
          onArm={() => onPick(picking === 'home' ? null : 'home')}
          onClear={onClearHome}
        />

        <div className="route-planner__field">
          <span className="route-planner__field-label">
            Cases {caseIds.length}/{MAX_CASES}
          </span>
          <span className="route-planner__field-value" />
          <button
            type="button"
            className="route-planner__button"
            aria-pressed={picking === 'case'}
            disabled={caseIds.length >= MAX_CASES && picking !== 'case'}
            onClick={() => onPick(picking === 'case' ? null : 'case')}
          >
            {picking === 'case' ? 'Picking…' : 'Add'}
          </button>
          <button
            type="button"
            className="route-planner__button"
            disabled={caseIds.length === 0}
            onClick={onClearCases}
            title="Clear every case region"
          >
            Reset
          </button>
        </div>

        {caseIds.length > 0 && (
          <ul className="route-planner__cases">
            {caseIds.map((caseId) => (
              <li key={caseId} className="route-planner__case">
                <span className="route-planner__case-order">{orderByCase.get(caseId) ?? '·'}</span>
                <span className="route-planner__case-name" title={regionName(caseId)}>
                  {regionName(caseId)}
                </span>
                <button
                  type="button"
                  className="route-planner__remove"
                  onClick={() => onRemoveCase(caseId)}
                  aria-label={`Remove ${regionName(caseId)}`}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}

        {picking && <p className="route-planner__hint">{PICK_HINTS[picking]}. Esc cancels.</p>}

        <button type="button" className="route-planner__plan" disabled={!canPlan} onClick={onPlan}>
          Best route
        </button>
        {!canPlan && (
          <p className="route-planner__hint">Set where you are and at least one case first.</p>
        )}
        {canPlan && !homeId && (
          <p className="route-planner__hint">
            Set a home region too and the route can spend one free travel home.
          </p>
        )}

        {route && (
          <div className="route-planner__result">
            <ol className="route-planner__legs">
              <li className="route-planner__leg route-planner__leg--start">
                <span className="route-planner__leg-order">◎</span>
                <span className="route-planner__leg-name" title={regionName(playerId!)}>
                  {regionName(playerId!)}
                </span>
                <span className="route-planner__leg-cost">start</span>
              </li>
              {route.steps.map((step, index) => (
                <li key={step.caseId} className="route-planner__leg">
                  {step.viaHome && (
                    <span className="route-planner__leg-home">
                      ↩ travel home to {regionName(homeId!)} · free
                    </span>
                  )}
                  <span className="route-planner__leg-order">{index + 1}</span>
                  <span className="route-planner__leg-name" title={regionName(step.caseId)}>
                  {regionName(step.caseId)}
                </span>
                  <span className="route-planner__leg-cost">{regionCount(step.travels)}</span>
                </li>
              ))}
            </ol>

            <div className="route-planner__total">Total {regionCount(route.travels)} travelled</div>
            <TravelCostReadout travels={route.travels} />

            {extraTravels > 0 && (
              <p className="route-planner__warning">
                ⚠️ This route outruns a full stamina bar by {regionCount(extraTravels)}, billed at{' '}
                {BARILS_PER_EXTRA_TRAVEL} barils each.
              </p>
            )}
            {route.unreachable.length > 0 && (
              <p className="route-planner__warning">
                ⚠️ Neither you nor home can walk to {route.unreachable.map(regionName).join(', ')} —
                left out of the trip.
              </p>
            )}
            {homeId && (
              <p className="route-planner__note">
                Travelling home is free but only once a trip, so the route spends it on the leg
                where it saves the most — or keeps it if it saves nothing.
              </p>
            )}
          </div>
        )}
      </section>
    </>
  )
}

export default RoutePlanner
