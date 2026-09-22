// Travel cost as the game shows it. Every travel burns 10 stamina until the
// bar is empty; the travels that no longer fit cost 2 barils each on top, the
// stamina still being spent in full. The gauge reads as stamina LEFT once you
// arrive, so a neighbouring region leaves it nearly full, a 10-travel trip
// drains it to empty, and anything beyond that stays empty and adds barils.
export const STAMINA_PER_TRAVEL = 10
export const MAX_STAMINA = 100
export const MAX_STAMINA_TRAVELS = MAX_STAMINA / STAMINA_PER_TRAVEL
export const BARILS_PER_EXTRA_TRAVEL = 2
export const BARIL_ICON_URL = 'https://media.warera.io/images/itemsv2/oil.png?v=1'

export function travelCost(travels: number) {
  const paidWithStamina = Math.min(travels, MAX_STAMINA_TRAVELS)
  const extraTravels = travels - paidWithStamina
  return {
    staminaLeft: MAX_STAMINA - paidWithStamina * STAMINA_PER_TRAVEL,
    barils: extraTravels * BARILS_PER_EXTRA_TRAVEL,
  }
}
