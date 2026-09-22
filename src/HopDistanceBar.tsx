import TravelCostReadout from './TravelCost'
import { BARILS_PER_EXTRA_TRAVEL, MAX_STAMINA_TRAVELS } from './travel'

interface HopDistanceBarProps {
  fromName: string
  toName: string
  travels: number | undefined // undefined when the target is unreachable
}

function HopDistanceBar({ fromName, toName, travels }: HopDistanceBarProps) {
  if (travels === undefined) {
    return (
      <div className="hop-distance-bar">
        <div className="hop-distance-bar__label">
          {fromName} → {toName}
        </div>
        unreachable
      </div>
    )
  }

  return (
    <div className="hop-distance-bar">
      <div className="hop-distance-bar__label">
        {fromName} → {toName} · {travels} region{travels === 1 ? '' : 's'} away
      </div>
      <TravelCostReadout travels={travels} />
      {travels > MAX_STAMINA_TRAVELS && (
        <p className="hop-distance-bar__warning">
          ⚠️ Once your stamina is depleted, each further region costs {BARILS_PER_EXTRA_TRAVEL} barils.
        </p>
      )}
    </div>
  )
}

// Shown in place of the bar until a start region is picked. The second step
// differs by input mode, since touch has no hover to read a destination from.
export function HopDistanceInstructions({ canHover }: { canHover: boolean }) {
  return (
    <p className="hop-distance-bar hop-distance-bar--instructions">
      Select a start region to display its information, then {canHover ? 'hover' : 'click'} on
      another region to show the distance between them
    </p>
  )
}

export default HopDistanceBar
