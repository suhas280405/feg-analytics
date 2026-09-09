/**
 * Tests for lib/liveCasinoMetrics.js.
 *
 * These are not incidental checks — they encode the realism properties that
 * decide whether the banner reads as "live" or as "obviously random numbers":
 * smooth drift, stable ranking, a real hour rhythm, and identical output on
 * every device. Zero dependencies; run with plain node.
 *
 * Usage:
 *   node test/testLiveCasinoMetrics.mjs
 */

import {
  getLiveCasinoActivity,
  getGamePlayersAt,
  getPlayersForShare,
  getFloorHistory,
  PEAK_CONCURRENT_PLAYERS,
} from "../lib/liveCasinoMetrics.js";

let failures = 0;

function check(description, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${description}`);
  } else {
    failures++;
    console.log(`  FAIL  ${description}${detail ? ` — ${detail}` : ""}`);
  }
}

/**
 * A miniature catalog with the same shape buildCasinoCatalog.ts emits.
 * Shares deliberately mirror the real export's head (5.2%, 4.9%, 3.7%, ...)
 * so ranking-stability behaviour is exercised at realistic margins.
 */
const CATALOG = {
  generatedAt: "2026-09-09T00:00:00.000Z",
  disclaimer: "test catalog",
  sourceLaunchRows: 1000,
  // Quiet at 04:00, busy at 13:00 — same shape as the measured curve.
  hourWeights: Array.from({ length: 24 }, (_, h) => (h === 4 ? 0.34 : h === 13 ? 1.43 : 1.0)),
  games: [
    { gameName: "Sizzling Hot Deluxe", provider: "Greentube", category: "Slots", launches: 520, share: 0.052 },
    { gameName: "40 Super Hot Bell Link", provider: "EGT Digital", category: "Slots", launches: 488, share: 0.0488 },
    { gameName: "Royal Seven XXL", provider: "Gamomat", category: "Slots", launches: 370, share: 0.037 },
    { gameName: "Sugar Rush 1000", provider: "PragmaticPlay", category: "Slots", launches: 353, share: 0.0353 },
    { gameName: "BlackJack MH", provider: "Playn Go", category: "Blackjack", launches: 318, share: 0.0318 },
    { gameName: "European Roulette", provider: "Playtech", category: "Roulette", launches: 200, share: 0.02 },
    { gameName: "27 Dice", provider: "Fazi", category: "Dice", launches: 150, share: 0.015 },
  ],
};
// Long tail. Real game popularity is power-law — a handful of hits, then
// hundreds of games with a launch or two — so the tail decays as 1/(i+1)^2
// rather than sitting flat. That shape matters: it is what makes rarely-played
// games legitimately drop to nobody at quiet hours. The tail also absorbs
// exactly the remaining share, honouring buildCatalog's guarantee that shares
// sum to 1.
// The exponent matters: too steep and the first tail entry outranks the real
// head games. 0.7 over 800 games reproduces the measured ratio — a ~5% leader
// against a tail averaging well under 0.1% each.
const HEAD_SHARE = CATALOG.games.reduce((sum, g) => sum + g.share, 0);
const TAIL_GAMES = 800;
const decay = Array.from({ length: TAIL_GAMES }, (_, i) => 1 / (i + 1) ** 0.7);
const decaySum = decay.reduce((a, b) => a + b, 0);
for (let i = 0; i < TAIL_GAMES; i++) {
  CATALOG.games.push({
    gameName: `Tail Game ${i}`,
    provider: "Amusnet",
    category: "Slots",
    launches: Math.max(1, Math.round(8000 * decay[i])),
    share: (1 - HEAD_SHARE) * (decay[i] / decaySum),
  });
}

// Fixed instants, always evaluated against the UTC hour so results do not
// depend on the machine's timezone. Taken on the hour: the curve interpolates
// between neighbouring hours, so a :30 sample sits halfway to the next hour
// and would not exercise the measured weight itself.
const BUSY = Date.UTC(2026, 8, 9, 13, 0, 0);
const QUIET = Date.UTC(2026, 8, 9, 4, 0, 0);
const OPTS = { useUtcHour: true };

const activity = getLiveCasinoActivity(CATALOG, BUSY, OPTS);

console.log("--- shape ---");

check("returns a totalOnline figure", typeof activity.totalOnline === "number", String(activity.totalOnline));
check("returns a games array", Array.isArray(activity.games), typeof activity.games);
check("returns a categories array", Array.isArray(activity.categories), typeof activity.categories);
check(
  "output carries the not-real-numbers disclaimer",
  typeof activity.disclaimer === "string" && activity.disclaimer.length > 0,
  activity.disclaimer,
);

console.log("\n--- determinism (every device must show the same numbers) ---");

check(
  "same catalog + same instant -> byte-identical output",
  JSON.stringify(getLiveCasinoActivity(CATALOG, BUSY, OPTS)) === JSON.stringify(activity),
);
check(
  "a different instant -> different numbers (it genuinely moves)",
  JSON.stringify(getLiveCasinoActivity(CATALOG, BUSY + 60_000, OPTS)) !== JSON.stringify(activity),
);

console.log("\n--- smooth drift (no teleporting) ---");

// Poll every 3s for 10 minutes and look at the biggest single-tick jump of
// the headline game. A re-rolled random number would swing wildly here.
let maxRelJump = 0;
let previous = null;
for (let t = 0; t < 200; t++) {
  const at = getLiveCasinoActivity(CATALOG, BUSY + t * 3000, OPTS);
  const top = at.games.find((g) => g.gameName === "Sizzling Hot Deluxe");
  if (previous !== null && top) {
    maxRelJump = Math.max(maxRelJump, Math.abs(top.players - previous) / Math.max(previous, 1));
  }
  if (top) previous = top.players;
}
check(
  "headline game never jumps more than 15% between 3s polls",
  maxRelJump < 0.15,
  `biggest jump was ${(maxRelJump * 100).toFixed(1)}%`,
);
check("but it does move at all across the window", maxRelJump > 0, `max jump ${maxRelJump}`);

console.log("\n--- ranking stability (leaderboards don't reshuffle every tick) ---");

const leaderCounts = new Map();
for (let t = 0; t < 100; t++) {
  const at = getLiveCasinoActivity(CATALOG, BUSY + t * 6000, OPTS);
  const leader = at.games[0]?.gameName ?? "none";
  leaderCounts.set(leader, (leaderCounts.get(leader) ?? 0) + 1);
}
const dominant = [...leaderCounts.entries()].sort((a, b) => b[1] - a[1])[0];
check(
  "one game holds the top spot in at least 80% of ticks over 10 minutes",
  (dominant?.[1] ?? 0) >= 80,
  `top spot held by "${dominant?.[0]}" in ${dominant?.[1]}/100 ticks`,
);

console.log("\n--- real hour rhythm ---");

const busyTotal = getLiveCasinoActivity(CATALOG, BUSY, OPTS).totalOnline;
const quietTotal = getLiveCasinoActivity(CATALOG, QUIET, OPTS).totalOnline;
check("4am is quieter than 1pm", quietTotal < busyTotal, `04:00=${quietTotal} 13:00=${busyTotal}`);
check(
  "the busy/quiet ratio tracks the measured curve (1.43 / 0.34 ~ 4.2x)",
  busyTotal / quietTotal > 3 && busyTotal / quietTotal < 5.5,
  `ratio ${(busyTotal / quietTotal).toFixed(2)}`,
);
check(
  "peak-hour total lands near the configured peak headcount",
  busyTotal > PEAK_CONCURRENT_PLAYERS && busyTotal < PEAK_CONCURRENT_PLAYERS * 1.8,
  `${busyTotal} vs peak setting ${PEAK_CONCURRENT_PLAYERS}`,
);

// The curve is per-hour data, but the floor must not visibly lurch when the
// clock ticks over an hour boundary mid-demo.
const beforeHour = getLiveCasinoActivity(CATALOG, BUSY - 2000, OPTS).totalOnline;
const afterHour = getLiveCasinoActivity(CATALOG, BUSY + 2000, OPTS).totalOnline;
check(
  "the floor does not lurch across an hour boundary",
  Math.abs(afterHour - beforeHour) / beforeHour < 0.05,
  `12:59:58=${beforeHour} 13:00:02=${afterHour}`,
);

console.log("\n--- internal consistency ---");

check(
  "displayed games are sorted by player count, busiest first",
  activity.games.every((g, i) => i === 0 || (activity.games[i - 1]?.players ?? 0) >= g.players),
  activity.games.map((g) => g.players).join(","),
);
check(
  "no displayed game ever shows zero players",
  activity.games.every((g) => g.players > 0),
  JSON.stringify(activity.games.filter((g) => g.players <= 0)),
);
check(
  "even at the quietest hour nothing displayed drops to zero",
  getLiveCasinoActivity(CATALOG, QUIET, OPTS).games.every((g) => g.players > 0),
);

const categoryTotal = activity.categories.reduce((sum, c) => sum + c.players, 0);
check(
  "category counts account for every player online",
  categoryTotal === activity.totalOnline,
  `categories=${categoryTotal} totalOnline=${activity.totalOnline}`,
);
check(
  "displayed games are a subset of the whole floor, not the whole floor",
  activity.games.reduce((sum, g) => sum + g.players, 0) < activity.totalOnline,
);
check(
  "headline game count is close to its real share of the floor",
  Math.abs((activity.games[0]?.players ?? 0) - 0.052 * activity.totalOnline) < 0.052 * activity.totalOnline * 0.25,
  `${activity.games[0]?.players} vs expected ~${Math.round(0.052 * activity.totalOnline)}`,
);
check(
  "categories are sorted busiest-first too",
  activity.categories.every((c, i) => i === 0 || (activity.categories[i - 1]?.players ?? 0) >= c.players),
  activity.categories.map((c) => `${c.category}:${c.players}`).join(" "),
);

console.log("\n--- options ---");

check(
  "topN controls how many games come back",
  getLiveCasinoActivity(CATALOG, BUSY, { ...OPTS, topN: 3 }).games.length === 3,
  String(getLiveCasinoActivity(CATALOG, BUSY, { ...OPTS, topN: 3 }).games.length),
);
check(
  "peakConcurrent scales the whole floor",
  getLiveCasinoActivity(CATALOG, BUSY, { ...OPTS, peakConcurrent: 6400 }).totalOnline > busyTotal * 1.8,
);

console.log("\n--- games in play (KPI tile) ---");

check(
  "counts every occupied game, not just the displayed ones",
  activity.gamesInPlay > activity.games.length,
  `inPlay=${activity.gamesInPlay} displayed=${activity.games.length}`,
);
check(
  "never exceeds the catalogue",
  activity.gamesInPlay <= CATALOG.games.length,
  `${activity.gamesInPlay} of ${CATALOG.games.length}`,
);
check(
  "fewer games are occupied at 4am than at 1pm",
  getLiveCasinoActivity(CATALOG, QUIET, OPTS).gamesInPlay < activity.gamesInPlay,
  `04:00=${getLiveCasinoActivity(CATALOG, QUIET, OPTS).gamesInPlay} 13:00=${activity.gamesInPlay}`,
);

console.log("\n--- per-game lookup (drives the row sparklines) ---");

// A sparkline that disagrees with the number printed next to it is the kind of
// bug an audience spots instantly, so the two paths must agree exactly.
const headline = activity.games[0];
check(
  "getGamePlayersAt agrees exactly with the activity reading",
  getGamePlayersAt(CATALOG, headline.gameName, BUSY, OPTS) === headline.players,
  `lookup=${getGamePlayersAt(CATALOG, headline.gameName, BUSY, OPTS)} activity=${headline.players}`,
);
check(
  "agrees at other instants too, not just this one",
  [1, 7, 30, 120].every((mins) => {
    const at = BUSY + mins * 60_000;
    const fromActivity = getLiveCasinoActivity(CATALOG, at, OPTS).games.find(
      (g) => g.gameName === headline.gameName,
    );
    return getGamePlayersAt(CATALOG, headline.gameName, at, OPTS) === fromActivity?.players;
  }),
);
check(
  "an unknown game reads as nobody playing rather than throwing",
  getGamePlayersAt(CATALOG, "No Such Game", BUSY, OPTS) === 0,
);

console.log("\n--- declared-share lookup (games with no measured history) ---");

// The companion app's own games (Crash, Roulette, Slots) postdate the PSK
// export, so they have no measured share. They still have to behave exactly
// like catalogued games — same floor, same smooth drift — so both paths run
// through one implementation.
check(
  "a catalogued game's own share reproduces its catalogued count exactly",
  getPlayersForShare(CATALOG, headline.gameName, headline.share ?? 0.052, BUSY, OPTS) ===
    getGamePlayersAt(CATALOG, headline.gameName, BUSY, OPTS),
  `share-path=${getPlayersForShare(CATALOG, headline.gameName, 0.052, BUSY, OPTS)} catalog-path=${getGamePlayersAt(CATALOG, headline.gameName, BUSY, OPTS)}`,
);
check(
  "a bigger declared share means more players",
  getPlayersForShare(CATALOG, "Crash", 0.04, BUSY, OPTS) >
    getPlayersForShare(CATALOG, "Crash", 0.01, BUSY, OPTS),
);
check(
  "it drifts smoothly rather than being re-rolled",
  (() => {
    let worst = 0;
    let prev = null;
    for (let t = 0; t < 60; t++) {
      const v = getPlayersForShare(CATALOG, "Crash", 0.04, BUSY + t * 3000, OPTS);
      if (prev !== null) worst = Math.max(worst, Math.abs(v - prev) / Math.max(prev, 1));
      prev = v;
    }
    return worst > 0 && worst < 0.15;
  })(),
);
check(
  "it follows the same daily rhythm as the rest of the floor",
  getPlayersForShare(CATALOG, "Crash", 0.04, QUIET, OPTS) <
    getPlayersForShare(CATALOG, "Crash", 0.04, BUSY, OPTS),
);

console.log("\n--- floor history (drives the players-online chart) ---");

const history = getFloorHistory(CATALOG, BUSY, { minutes: 60, stepMinutes: 2, ...OPTS });

check("returns one point per step across the window", history.length === 31, `got ${history.length}`);
check(
  "points run oldest to newest",
  history.every((p, i) => i === 0 || p.t > history[i - 1].t),
);
check("the window ends at the requested instant", history[history.length - 1]?.t === BUSY, String(history[history.length - 1]?.t));
check(
  "the window starts 60 minutes back",
  history[0]?.t === BUSY - 60 * 60_000,
  `${history[0]?.t} vs ${BUSY - 60 * 60_000}`,
);
check(
  "the chart's final point equals the headline total exactly",
  history[history.length - 1]?.totalOnline === activity.totalOnline,
  `history=${history[history.length - 1]?.totalOnline} headline=${activity.totalOnline}`,
);
check(
  "history is plausible throughout — no zero or negative floor",
  history.every((p) => p.totalOnline > 0),
);
check(
  "history shows the overnight climb rather than a flat line",
  new Set(history.map((p) => p.totalOnline)).size > 5,
  `${new Set(history.map((p) => p.totalOnline)).size} distinct values`,
);

console.log(`\n${failures === 0 ? "All checks passed." : `${failures} check(s) FAILED.`}`);
process.exitCode = failures === 0 ? 0 : 1;
