/**
 * Live casino activity — turns the REAL measured catalog into a
 * production-scale "who is playing what right now" reading.
 *
 * ============================ READ THIS FIRST ============================
 * The player counts this module returns are SYNTHETIC. They are not real PSK
 * figures and must never be presented as such.
 *
 * What is real (measured from a 31-day PSK casino event-log export):
 *   - which games exist, and their provider
 *   - each game's popularity relative to every other game
 *   - the hour-of-day rhythm of when people actually play
 *
 * What is synthesised here: the absolute headcount. The export covers a
 * sample of top users only — ~18 launches an hour across 887 games — so a
 * literal reading gives "1 player", which is equally untrue of PSK's real
 * casino. This module scales the real shape to a production-like floor.
 * =======================================================================
 *
 * Design constraints that make it read as live rather than as random noise:
 *
 *   1. Deterministic from the clock alone. No stored state, no session seed.
 *      Two people opening the page on different devices at the same moment
 *      see identical numbers — which is what makes it survive being handed
 *      to someone during a demo.
 *   2. Counts drift smoothly. Value noise interpolated with smoothstep, not
 *      a fresh random number per poll. 143 -> 146 -> 141 reads as real;
 *      143 -> 41 -> 300 does not.
 *   3. Ranking stays mostly stable, with occasional swaps between neighbours.
 *      That falls out of drift being small relative to the real gaps between
 *      games, rather than being special-cased.
 *   4. The daily rhythm is the measured one, interpolated between hours so
 *      the floor never lurches on an hour boundary.
 *
 * Zero dependencies, no build step: loaded directly by the browser as an ES
 * module and by node for its tests.
 */

/**
 * @typedef {Object} CasinoGameStat
 * @property {string} gameName
 * @property {string} provider
 * @property {string} category
 * @property {number} launches
 * @property {number} share  Fraction of all launches; sums to 1 across games.
 *
 * @typedef {Object} CasinoCatalog
 * @property {string} generatedAt
 * @property {string} disclaimer
 * @property {number} sourceLaunchRows
 * @property {number[]} hourWeights  24 multipliers, mean 1.0.
 * @property {CasinoGameStat[]} games
 *
 * @typedef {Object} LiveGame
 * @property {string} gameName
 * @property {string} provider
 * @property {string} category
 * @property {number} players
 *
 * @typedef {Object} LiveCategory
 * @property {string} category
 * @property {number} players
 *
 * @typedef {Object} LiveCasinoActivity
 * @property {number} totalOnline   Players across the whole floor.
 * @property {number} gamesInPlay   How many games have at least one player.
 * @property {LiveGame[]} games     The busiest `topN`, busiest first.
 * @property {LiveCategory[]} categories  Every category, busiest first.
 * @property {number} asOfMs
 * @property {string} disclaimer
 */

/**
 * The one number to turn if the floor should feel busier or quieter on stage.
 * Represents the whole-floor headcount at an average hour (hourWeights has a
 * mean of 1.0, so this is the daily average, and peak hours exceed it).
 */
export const PEAK_CONCURRENT_PLAYERS = 3200;

export const ACTIVITY_DISCLAIMER =
  "Player counts are synthetic demo values, not real PSK figures. Game mix, " +
  "relative popularity and time-of-day rhythm are derived from real PSK casino event logs.";

/** How far a single game's count wanders from its share-implied baseline. */
const GAME_DRIFT_AMPLITUDE = 0.04;
/** Time for one full drift excursion. Long vs. the ~3s poll, so steps are small. */
const GAME_DRIFT_PERIOD_MS = 20_000;
/** The whole floor breathes too, more gently than any individual game. */
const TOTAL_DRIFT_AMPLITUDE = 0.03;
const TOTAL_DRIFT_PERIOD_MS = 45_000;

const DEFAULT_TOP_N = 12;

// ---------------------------------------------------------------------------
// Deterministic noise
//
// Integer-only hashing via Math.imul, so a browser and node produce bit-identical
// results — the property the "same numbers on every device" guarantee rests on.
// ---------------------------------------------------------------------------

/** FNV-1a. Maps a game name to a stable 32-bit seed. */
function hashString(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/** Seeded integer hash -> [0, 1). */
function hashToUnit(seed, step) {
  let h = (seed ^ Math.imul(step | 0, 374761393)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4294967296;
}

/** Smoothstep — eases the interpolation so drift has no visible corners. */
function smoothstep(t) {
  return t * t * (3 - 2 * t);
}

/**
 * Continuous value noise in [-1, 1]: interpolates between per-step random
 * values, so consecutive polls a few seconds apart differ only slightly.
 */
function smoothNoise(seed, timeMs, periodMs) {
  const x = timeMs / periodMs;
  const step = Math.floor(x);
  const frac = x - step;
  const a = hashToUnit(seed, step);
  const b = hashToUnit(seed, step + 1);
  return (a + (b - a) * smoothstep(frac)) * 2 - 1;
}

// ---------------------------------------------------------------------------
// Time of day
// ---------------------------------------------------------------------------

/**
 * The measured weight for this moment, interpolated toward the next hour so
 * the floor never steps discontinuously at :00.
 *
 * Uses the viewer's LOCAL hour by default rather than UTC: the curve's shape
 * is the real measured one either way, and aligning it to the room's clock
 * means a mid-morning demo shows mid-morning traffic instead of whatever
 * UTC happens to be. Everyone in one room shares a timezone, so the
 * same-numbers-everywhere property holds where it matters. Tests pass
 * `useUtcHour` to stay independent of the machine's timezone.
 */
function hourFactor(hourWeights, nowMs, useUtcHour) {
  const date = new Date(nowMs);
  const hour = useUtcHour ? date.getUTCHours() : date.getHours();
  const minutes = useUtcHour ? date.getUTCMinutes() : date.getMinutes();
  const seconds = useUtcHour ? date.getUTCSeconds() : date.getSeconds();
  const frac = (minutes * 60 + seconds) / 3600;

  const current = hourWeights[hour] ?? 1;
  const next = hourWeights[(hour + 1) % 24] ?? 1;
  return current + (next - current) * frac;
}

// ---------------------------------------------------------------------------
// Core reading
//
// Every consumer — the activity reading, a single game's sparkline, the floor
// history chart — goes through these two functions. That is deliberate: it is
// what makes a sparkline structurally incapable of disagreeing with the number
// printed beside it.
// ---------------------------------------------------------------------------

/** Whole-floor headcount before it is split across games. */
function floorSizeAt(catalog, nowMs, peak, useUtcHour) {
  return (
    peak *
    hourFactor(catalog.hourWeights, nowMs, useUtcHour) *
    (1 + TOTAL_DRIFT_AMPLITUDE * smoothNoise(0x5eed, nowMs, TOTAL_DRIFT_PERIOD_MS))
  );
}

/** One game's headcount: its real share of the floor, plus its own smooth drift. */
function playersFor(gameName, share, floorSize, nowMs) {
  const drift = 1 + GAME_DRIFT_AMPLITUDE * smoothNoise(hashString(gameName), nowMs, GAME_DRIFT_PERIOD_MS);
  // Long-tail games legitimately round to nobody playing right now — 887 games
  // are not all occupied at once, and forcing a floor of 1 would inflate the
  // total by several hundred phantom players.
  return Math.max(0, Math.round(share * floorSize * drift));
}

/** Name -> stat lookup, memoised per catalog so repeated sparkline reads stay cheap. */
const gameIndexCache = new WeakMap();
function gameIndexFor(catalog) {
  let index = gameIndexCache.get(catalog);
  if (!index) {
    index = new Map(catalog.games.map((g) => [g.gameName, g]));
    gameIndexCache.set(catalog, index);
  }
  return index;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Reads the floor at a given instant.
 *
 * @param {CasinoCatalog} catalog
 * @param {number} [nowMs]
 * @param {{topN?: number, peakConcurrent?: number, useUtcHour?: boolean}} [options]
 * @returns {LiveCasinoActivity}
 */
export function getLiveCasinoActivity(catalog, nowMs = Date.now(), options = {}) {
  const topN = options.topN ?? DEFAULT_TOP_N;
  const peak = options.peakConcurrent ?? PEAK_CONCURRENT_PLAYERS;
  const useUtcHour = options.useUtcHour ?? false;

  const floorSize = floorSizeAt(catalog, nowMs, peak, useUtcHour);

  /** @type {LiveGame[]} */
  const live = [];
  const byCategory = new Map();
  let totalOnline = 0;

  for (const game of catalog.games) {
    const players = playersFor(game.gameName, game.share, floorSize, nowMs);
    if (players === 0) continue;

    totalOnline += players;
    byCategory.set(game.category, (byCategory.get(game.category) ?? 0) + players);
    live.push({ gameName: game.gameName, provider: game.provider, category: game.category, players });
  }

  // Ranking is recomputed from the drifted counts, so neighbouring games swap
  // places occasionally on their own — no special-casing needed.
  live.sort((a, b) => b.players - a.players || a.gameName.localeCompare(b.gameName));

  const categories = [...byCategory.entries()]
    .map(([category, players]) => ({ category, players }))
    .sort((a, b) => b.players - a.players || a.category.localeCompare(b.category));

  return {
    totalOnline,
    // Every occupied game, not just the displayed slice — the long tail thins
    // out at quiet hours, which is itself a realistic thing to show.
    gamesInPlay: live.length,
    games: live.slice(0, topN),
    categories,
    asOfMs: nowMs,
    disclaimer: ACTIVITY_DISCLAIMER,
  };
}

/**
 * One game's headcount at an instant, without pricing the whole floor.
 *
 * O(1), so a row's 30-point sparkline costs nothing. Returns the identical
 * number `getLiveCasinoActivity` reports for that game at that instant.
 *
 * @param {CasinoCatalog} catalog
 * @param {string} gameName
 * @param {number} [nowMs]
 * @param {{peakConcurrent?: number, useUtcHour?: boolean}} [options]
 * @returns {number}
 */
export function getGamePlayersAt(catalog, gameName, nowMs = Date.now(), options = {}) {
  const game = gameIndexFor(catalog).get(gameName);
  if (!game) return 0;
  return getPlayersForShare(catalog, game.gameName, game.share, nowMs, options);
}

/**
 * The headcount for a game whose share is declared rather than measured.
 *
 * The companion app's own games (Crash, Roulette, the slot machine) postdate
 * the PSK export, so no share can be measured for them. Their share is stated
 * by the caller instead — but everything downstream is identical to a
 * catalogued game: same floor, same daily rhythm, same smooth drift. Keeping
 * both on one implementation is what stops the two ever behaving differently.
 *
 * @param {CasinoCatalog} catalog
 * @param {string} key       Stable identity for the drift seed — the game's name.
 * @param {number} share     Fraction of the floor, on the same scale as catalog shares.
 * @param {number} [nowMs]
 * @param {{peakConcurrent?: number, useUtcHour?: boolean}} [options]
 * @returns {number}
 */
export function getPlayersForShare(catalog, key, share, nowMs = Date.now(), options = {}) {
  const floorSize = floorSizeAt(
    catalog,
    nowMs,
    options.peakConcurrent ?? PEAK_CONCURRENT_PLAYERS,
    options.useUtcHour ?? false,
  );
  return playersFor(key, share, floorSize, nowMs);
}

/**
 * The floor's recent past, for the players-online chart.
 *
 * The engine is a pure function of the clock, so history is not recorded — it
 * is recomputed, and comes back identical to what the page actually displayed
 * at those moments. The final point equals the current reading exactly.
 *
 * @param {CasinoCatalog} catalog
 * @param {number} [nowMs]
 * @param {{minutes?: number, stepMinutes?: number, peakConcurrent?: number, useUtcHour?: boolean}} [options]
 * @returns {{t: number, totalOnline: number}[]}
 */
export function getFloorHistory(catalog, nowMs = Date.now(), options = {}) {
  const minutes = options.minutes ?? 60;
  const stepMinutes = options.stepMinutes ?? 2;
  const peak = options.peakConcurrent ?? PEAK_CONCURRENT_PLAYERS;
  const useUtcHour = options.useUtcHour ?? false;

  const points = [];
  for (let offset = minutes; offset >= 0; offset -= stepMinutes) {
    const t = nowMs - offset * 60_000;
    const floorSize = floorSizeAt(catalog, t, peak, useUtcHour);
    let totalOnline = 0;
    for (const game of catalog.games) {
      totalOnline += playersFor(game.gameName, game.share, floorSize, t);
    }
    points.push({ t, totalOnline });
  }
  // Guard against a step that does not divide the window: the chart's last
  // point must be *now*, or it would contradict the headline number.
  if (points.length > 0 && points[points.length - 1].t !== nowMs) {
    const floorSize = floorSizeAt(catalog, nowMs, peak, useUtcHour);
    let totalOnline = 0;
    for (const game of catalog.games) {
      totalOnline += playersFor(game.gameName, game.share, floorSize, nowMs);
    }
    points.push({ t: nowMs, totalOnline });
  }
  return points;
}

/**
 * One rotating banner line, e.g. "1,284 members are playing Sizzling Hot Deluxe".
 * Cycles through the busiest games and the busiest categories so the banner
 * varies without ever inventing anything the activity reading does not contain.
 *
 * @param {LiveCasinoActivity} activity
 * @param {number} index
 * @returns {{text: string, players: number, subject: string} | null}
 */
export function buildBannerLine(activity, index) {
  /** @type {{text: string, players: number, subject: string}[]} */
  const lines = [];

  for (const game of activity.games.slice(0, 6)) {
    lines.push({
      text: `${formatCount(game.players)} ${plural(game.players, "member is", "members are")} playing ${game.gameName}`,
      players: game.players,
      subject: game.gameName,
    });
  }

  for (const category of activity.categories.slice(0, 3)) {
    lines.push({
      text: `${formatCount(category.players)} ${plural(category.players, "member is", "members are")} in ${category.category}`,
      players: category.players,
      subject: category.category,
    });
  }

  if (lines.length === 0) return null;
  return lines[((index % lines.length) + lines.length) % lines.length] ?? null;
}

/** @param {number} n */
export function formatCount(n) {
  return n.toLocaleString("en-US");
}

function plural(n, one, many) {
  return n === 1 ? one : many;
}
