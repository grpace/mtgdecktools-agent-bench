/**
 * The mirror check (SITE-DATA 2.15, METHODOLOGY "Mirror games"). Games between two seats of the same setup are never
 * rated: self-play says nothing about how a setup compares with others. They still count as format data (decks, play
 * and draw) and as a fairness monitor: both sides are the same setup, so anything that splits them, other than who was
 * on the play, should win about half the time. Two splits are checked:
 *   contributor     one contributor's seats of a setup against other contributors' seats of the same setup
 *                   (a configuration or a harness that differs from everyone else's shows up here);
 *   context_policy  seats of a setup with one context policy (a fresh session per game or match, or one session)
 *                   against seats of it with another (the open question in METHODOLOGY §10).
 * A check deviates when it has at least MIRROR_MIN_GAMES games and its 95% Wilson range excludes 50%: a screening
 * flag, not a test (games within a match or event are clustered and many checks run at once, so expect about one in 20
 * to deviate by chance). On the play is reported from game 1 only, where the event seed decides it (2.17): in games
 * 2–3 the previous game's loser chose, and that side more often holds the weaker deck, so the all-games rate is biased
 * toward 50% and is reported only for reference. Nothing here touches a rating.
 */
import type { Ctx } from './context.js';
import { wilson } from './outcomes.js';
import { contributorOf, groupKey, type Identities } from './scoring.js';
import type { MirrorCheck, MirrorCheckRow } from './schema.js';

export const MIRROR_MIN_GAMES = 20;

const rate = (w: number, n: number) => (n ? { value: w / n, ci: wilson(w, n) } : null);
const pct = (x: number) => `${Math.round(x * 100)}%`;

export function mirrorCheck(ctx: Ctx, ids: Identities, minGames = MIRROR_MIN_GAMES): MirrorCheck {
  let games = 0;
  let onPlayGames = 0;
  let onPlayWins = 0;
  let chosenGames = 0;
  let chosenWins = 0;
  const events = new Set<string>();
  const identities = new Set<string>();
  const tally = new Map<string, { kind: MirrorCheckRow['kind']; identity: string; value: string; handle: string | null; games: number; wins: number }>();
  const add = (kind: MirrorCheckRow['kind'], identity: string, value: string, handle: string | null, won: boolean) => {
    const k = `${kind}\u0000${identity}\u0000${value}`;
    const t = tally.get(k) ?? { kind, identity, value, handle, games: 0, wins: 0 };
    t.games++;
    if (won) t.wins++;
    if (handle) t.handle = handle;
    tally.set(k, t);
  };
  for (const ev of ctx.events) {
    if (groupKey(ev) == null) continue; // finished, pooled, not excluded, not Early Test Data
    for (const g of ev.games) {
      if (!g.over || !g.winner || g.forfeitedBy || g.seats.length !== 2) continue;
      const [sa, sb] = g.seats as [string, string];
      const A = ev.seats.find((s) => s.name === sa);
      const B = ev.seats.find((s) => s.name === sb);
      if (!A?.llm || !B?.llm) continue;
      const xa = ids.of(ev, sa);
      const xb = ids.of(ev, sb);
      if (!xa.rated || !xb.rated || xa.key !== xb.key) continue;
      games++;
      events.add(ev.id);
      identities.add(xa.key);
      if (g.onPlay === sa || g.onPlay === sb) {
        if (g.gameInMatch <= 1) {
          onPlayGames++;
          if (g.winner === g.onPlay) onPlayWins++;
        } else {
          chosenGames++;
          if (g.winner === g.onPlay) chosenWins++;
        }
      }
      const ca = contributorOf(ev, sa, ctx.contributorPublic);
      const cb = contributorOf(ev, sb, ctx.contributorPublic);
      if (ca.key !== cb.key) {
        add('contributor', xa.key, ca.key, ca.handle, g.winner === sa);
        add('contributor', xa.key, cb.key, cb.handle, g.winner === sb);
      }
      const pa = A.contextPolicy ?? 'harness';
      const pb = B.contextPolicy ?? 'harness';
      if (pa !== pb) {
        add('context_policy', xa.key, pa, null, g.winner === sa);
        add('context_policy', xa.key, pb, null, g.winner === sb);
      }
    }
  }
  const checks: MirrorCheckRow[] = [...tally.values()]
    .map((t) => {
      const r = rate(t.wins, t.games);
      const deviates = t.games >= minGames && !!r?.ci && (r.ci[0] > 0.5 || r.ci[1] < 0.5);
      return {
        kind: t.kind, identity: t.identity, label: ids.info.get(t.identity)?.label ?? t.identity, value: t.value,
        ...(t.kind === 'contributor' ? { handle: t.handle } : {}),
        games: t.games, wins: t.wins, rate: r, deviates,
      };
    })
    .sort((x, y) => Number(y.deviates) - Number(x.deviates) || x.kind.localeCompare(y.kind) || x.identity.localeCompare(y.identity) || y.games - x.games || x.value.localeCompare(y.value));
  const dev = checks.filter((c) => c.deviates);
  const who = (c: MirrorCheckRow) => (c.kind === 'contributor' ? `${c.handle ?? 'a contributor'}'s ${c.label}` : `${c.label} with ${c.value === 'harness' ? 'one session' : c.value === 'fresh-per-game' ? 'a fresh session per game' : 'a fresh session per match'}`);
  const summary = !games
    ? 'No mirror games yet: no finished rated table has paired two seats of the same setup.'
    : dev.length
      ? `${dev.length} mirror check${dev.length === 1 ? ' deviates' : 's deviate'} from 50%: ${dev.slice(0, 3).map((c) => `${who(c)} won ${pct(c.rate!.value)} of ${c.games} mirror games`).join('; ')}${dev.length > 3 ? '; …' : ''}. Mirror games are never rated; a deviation is a reason to look at those setups, not a result.`
      : `No deviations: in ${games} mirror game${games === 1 ? '' : 's'} no contributor or context policy won clearly more or less than half against the same setup (checks need ${minGames} games).`;
  return {
    games, events: events.size, identities: identities.size,
    on_play: { games: onPlayGames, wins: onPlayWins, rate: rate(onPlayWins, onPlayGames), basis: 'game_1' },
    on_play_all_games: { games: onPlayGames + chosenGames, wins: onPlayWins + chosenWins, rate: rate(onPlayWins + chosenWins, onPlayGames + chosenGames) },
    min_games: minGames, checks, deviations: dev.length, summary,
  };
}
