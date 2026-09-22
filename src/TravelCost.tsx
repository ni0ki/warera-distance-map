import { BARIL_ICON_URL, MAX_STAMINA, travelCost } from './travel'

function StaminaIcon() {
  return (
    <svg className="stamina-bar__icon" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M16.5,5.5A2,2 0 0,0 18.5,3.5A2,2 0 0,0 16.5,1.5A2,2 0 0,0 14.5,3.5A2,2 0 0,0 16.5,5.5M12.9,19.4L13.9,15L16,17V23H18V15.5L15.9,13.5L16.5,10.5C17.89,12.09 19.89,13 22,13V11C20.24,11.03 18.6,10.11 17.7,8.6L16.7,7C16.34,6.4 15.7,6 15,6C14.7,6 14.5,6.1 14.2,6.1L9,8.3V13H11V9.6L12.8,8.9L11.2,17L6.3,16L5.9,18L12.9,19.4M4,9A1,1 0 0,1 3,8A1,1 0 0,1 4,7H7V9H4M5,5A1,1 0 0,1 4,4A1,1 0 0,1 5,3H10V5H5M3,13A1,1 0 0,1 2,12A1,1 0 0,1 3,11H7V13H3Z"
      />
    </svg>
  )
}

// What a trip of `travels` regions leaves you with: the stamina gauge as the
// game draws it, plus the barils the travels past an empty bar had to burn.
function TravelCostReadout({ travels }: { travels: number }) {
  const { staminaLeft, barils } = travelCost(travels)

  return (
    <div className="travel-cost">
      <div
        className="stamina-bar"
        role="img"
        aria-label={`${staminaLeft} of ${MAX_STAMINA} stamina left`}
      >
        <div
          className="stamina-bar__fill"
          style={{ width: `${(staminaLeft / MAX_STAMINA) * 100}%` }}
        />
        <div className="stamina-bar__content">
          <StaminaIcon />
          {staminaLeft}/{MAX_STAMINA}
        </div>
      </div>
      {barils > 0 && (
        <span className="travel-cost__barils">
          <img className="travel-cost__baril-icon" src={BARIL_ICON_URL} alt="" />
          {barils} baril{barils === 1 ? '' : 's'}
        </span>
      )}
    </div>
  )
}

export default TravelCostReadout
