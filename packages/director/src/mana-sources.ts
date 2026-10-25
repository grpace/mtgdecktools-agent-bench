/**
 * Mana sources from the engine's own data, for manual mana payment (game.ts) and the observation (render-v4.ts).
 *
 * phase-server offers two shapes of mana action:
 *  - lands: `TapLandForMana` (one action per color the land can make, `data.selection.mana_type`), and
 *    `ActivateManaSource`;
 *  - everything else (mana creatures, mana rocks, Treasures and other tokens): a plain `ActivateAbility`
 *    { source_id, ability_index }. The engine marks the ability itself as a mana ability
 *    (`objects[source_id].abilities[ability_index].is_mana_ability`) and says what it makes (`effect.produced`).
 *    An "any color" ability asks for the color next (waiting_for `ChooseManaColor`).
 * Only the engine's flags are read here, never the ability text.
 */

/** The land mana actions: the color is in the action (`data.selection.mana_type`). */
export const LAND_MANA_ACTIONS = new Set(['TapLandForMana', 'ActivateManaSource']);

export const COLOR_LETTER: Record<string, string> = { White: 'W', Blue: 'U', Black: 'B', Red: 'R', Green: 'G', Colorless: 'C' };
const WUBRG = ['White', 'Blue', 'Black', 'Red', 'Green'];

/** The engine ability an `ActivateAbility` action uses, from the state. */
function abilityOf(state: any, a: any): any {
  if (a?.type !== 'ActivateAbility') return undefined;
  return state?.objects?.[String(a.data?.source_id)]?.abilities?.[Number(a.data?.ability_index ?? 0)];
}

/** Whether an engine action makes mana: a land's mana action, or an activated ability the engine marks as a mana ability. */
export function isManaAction(state: any, a: any): boolean {
  if (LAND_MANA_ACTIONS.has(a?.type)) return true;
  return abilityOf(state, a)?.is_mana_ability === true;
}

/** Cost parts the Director can pay by activating the ability alone: no mana, no card or permanent to choose. */
function simpleCost(c: any): boolean {
  if (c == null) return true;
  switch (c.type) {
    case 'Tap':
    case 'PayLife':
      return true;
    case 'Sacrifice':
    case 'RemoveCounter':
    case 'Exile':
      // Only the source itself ("{T}, Sacrifice this: …"): anything else is a choice.
      return c.target == null ? c.self_ref === true || c.type === 'RemoveCounter' : c.target?.type === 'SelfRef';
    case 'Composite':
      return (c.costs ?? []).every(simpleCost);
    default:
      return false;
  }
}

/**
 * Whether the Director can carry out this mana action for a tap plan (`mana=[…]`): a land, or a mana ability whose cost
 * is tapping, sacrificing or otherwise using only the source itself (a Treasure, a mana creature, a mana rock). Mana
 * abilities that cost mana themselves ("{1}, {T}: Add {R}{G}") or ask for another card are offered as options instead.
 */
export function isPlanManaAction(state: any, a: any): boolean {
  if (LAND_MANA_ACTIONS.has(a?.type)) return true;
  const ab = abilityOf(state, a);
  return ab?.is_mana_ability === true && simpleCost(ab.cost);
}

/** Engine color names an ability's `effect.produced` can make (WUBRG order, then Colorless). */
export function producedColors(produced: any): string[] {
  if (!produced || typeof produced !== 'object') return [];
  const out = new Set<string>();
  switch (produced.type) {
    case 'Fixed':
      for (const c of produced.colors ?? []) out.add(c);
      break;
    case 'Colorless':
      out.add('Colorless');
      break;
    case 'Mixed':
      for (const c of produced.colors ?? []) out.add(c);
      if (produced.colorless_count) out.add('Colorless');
      break;
    case 'AnyOneColor':
    case 'AnyCombination':
      for (const c of produced.color_options ?? WUBRG) out.add(c);
      break;
    case 'ChoiceAmongCombinations':
      for (const combo of produced.options ?? []) for (const c of combo ?? []) out.add(c);
      break;
    default:
      // Chosen color, colors among permanents, an opponent's lands…: depends on the game; any color it may be.
      for (const c of WUBRG) out.add(c);
  }
  return [...WUBRG, 'Colorless'].filter((c) => out.has(c));
}

/** Engine color names a mana action can make. */
export function manaActionColors(state: any, a: any): string[] {
  if (LAND_MANA_ACTIONS.has(a?.type)) return a.data?.selection?.mana_type ? [a.data.selection.mana_type] : [];
  const ab = abilityOf(state, a);
  return ab?.is_mana_ability ? producedColors(ab.effect?.produced) : [];
}

/** Colors an object's mana abilities can make (engine flags), for objects without legal actions (the opponent's). */
export function objectManaColors(o: any): string[] {
  const out = new Set<string>();
  for (const ab of o?.abilities ?? []) if (ab?.is_mana_ability) for (const c of producedColors(ab.effect?.produced)) out.add(c);
  return [...WUBRG, 'Colorless'].filter((c) => out.has(c));
}

/** Engine colors as letters: "G", "W/G", "any" (all five colors). */
export function makesText(colors: string[]): string {
  if (WUBRG.every((c) => colors.includes(c))) return 'any';
  return colors.map((c) => COLOR_LETTER[c] ?? c).join('/');
}

const HYBRID = /^(White|Blue|Black|Red|Green)(White|Blue|Black|Red|Green)$/;

/**
 * Whether the mana already in the pool pays this cost in full (so finishing the payment taps nothing more). Exact for
 * colored, colorless, generic and two-color hybrid costs; undefined (unknown) for anything else (Phyrexian, snow,
 * restricted mana in the pool…), where the caller must not assume either way.
 */
export function poolCovers(cost: any, pool: any[]): boolean | undefined {
  if (!cost || cost.type !== 'Cost') return undefined;
  const mana: string[] = [];
  for (const m of pool ?? []) {
    if (Array.isArray(m?.restrictions) && m.restrictions.length) return undefined;
    if (typeof m?.color !== 'string') return undefined;
    mana.push(m.color);
  }
  const single: string[] = [];
  const hybrid: string[][] = [];
  for (const s of cost.shards ?? []) {
    if (typeof s !== 'string') return undefined;
    if (s in COLOR_LETTER) single.push(s);
    else {
      const h = HYBRID.exec(s);
      if (!h) return undefined;
      hybrid.push([h[1]!, h[2]!]);
    }
  }
  const left = [...mana];
  for (const s of single) {
    const i = left.indexOf(s);
    if (i < 0) return false;
    left.splice(i, 1);
  }
  // Hybrid pips: a small backtracking match (costs have a handful at most).
  const fit = (k: number, rest: string[]): string[] | null => {
    if (k === hybrid.length) return rest;
    for (const c of hybrid[k]!) {
      const i = rest.indexOf(c);
      if (i < 0) continue;
      const r = fit(k + 1, [...rest.slice(0, i), ...rest.slice(i + 1)]);
      if (r) return r;
    }
    return null;
  };
  const after = fit(0, left);
  if (!after) return false;
  return after.length >= (cost.generic ?? 0);
}
