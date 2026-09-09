/**
 * Floor Analytics dashboard.
 *
 * Every figure on screen comes from lib/liveCasinoMetrics.js, which is a pure
 * function of the clock — so this file never invents a number, history is
 * recomputed rather than accumulated, and two browsers open at the same moment
 * agree exactly.
 *
 * Charts are hand-rolled inline SVG: no chart library, no build step, so the
 * whole dashboard stays a static folder any host can serve.
 */

import {
  getLiveCasinoActivity,
  getGamePlayersAt,
  getPlayersForShare,
  getFloorHistory,
  buildBannerLine,
  formatCount,
} from "./lib/liveCasinoMetrics.js";

// ---------------------------------------------------------------------------
// Game grid configuration
//
// PORTING NOTE (for the mobile app): everything below is presentation. The only
// numbers that matter come from two calls —
//   getGamePlayersAt(catalog, gameName, nowMs)          for catalogued games
//   getPlayersForShare(catalog, key, share, nowMs)      for the app's own games
// Both return a plain integer. Render it however the platform likes; the engine
// module is dependency-free and runs unchanged in any JS runtime.
// ---------------------------------------------------------------------------

const CASINO_APP = "https://psk-casino-demo.vercel.app";

/**
 * The companion app's own games. These postdate the PSK export, so they have no
 * measured share — the values below are declared, and are the only numbers in
 * this project not derived from the event logs. They drive the same drift maths
 * as every catalogued game.
 */
const PSK_ORIGINALS = [
  { gameName: "Crash", provider: "PSK Originals", share: 0.042, href: `${CASINO_APP}/crash` },
  { gameName: "Slots", provider: "PSK Originals", share: 0.036, href: `${CASINO_APP}/` },
  { gameName: "Roulette", provider: "PSK Originals", share: 0.027, href: `${CASINO_APP}/roulette` },
];

const TILES_PER_ROW = 8;

/**
 * Rows are built by popularity, not by category — because the measured data
 * will not honestly fill a category row. PSK's floor is 93% slots: only two
 * non-slots games draw more than ten players, so a "Table Games" row would
 * read 130, 3, 2, 1 and look broken rather than quiet. Ranking instead keeps
 * every tile healthy, and the table and dice leaders still surface on their
 * own merit (they rank 7th and 8th).
 */
const ROW_SIZE_MIN = 3;
/** Below this share a tile can round to nobody at quiet hours. Never show one. */
const MIN_TILE_SHARE = 0.004;

const POLL_MS = 3000;
const ROTATE_MS = 4500;
const TABLE_ROWS = 10;
const HISTORY_MINUTES = 60;
const HISTORY_STEP_MINUTES = 2;
const SPARK_MINUTES = 30;
const SPARK_STEP_MINUTES = 2;
const FEED_MAX = 7;

const el = (id) => document.getElementById(id);

const bannerLineEl = el("bannerLine");
const clockEl = el("clock");
const chartEl = el("floorChart");
const chartWrapEl = el("chartWrap");
const chartTipEl = el("chartTip");
const chartRangeEl = el("chartRange");
const gamesBodyEl = el("gamesBody");
const categoryBarsEl = el("categoryBars");
const feedEl = el("feed");
const noteEl = el("note");
const gameRowsEl = el("gameRows");
const gamesShownEl = el("gamesShown");

/** Which games each grid row is currently showing, by row title. */
let gameRowsShown = {};

let catalog = null;
let bannerIndex = 0;
/** Last seen per-game counts, so the feed can report genuine increases. */
let previousCounts = new Map();
/** @type {{text: string, at: Date}[]} */
let feedItems = [];
/** Retained for the chart's hover layer. */
let historyPoints = [];
let chartGeometry = null;

// ---------------------------------------------------------------------------
// Tile artwork — the export carries no thumbnails, so each game gets a
// deterministic gradient from its name. Deliberate, not a broken image.
// ---------------------------------------------------------------------------

function hashString(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function gradientFor(name) {
  const h = hashString(name);
  const hue = h % 360;
  const hue2 = (hue + 34 + ((h >>> 9) % 40)) % 360;
  return `linear-gradient(135deg, hsl(${hue} 52% 34%), hsl(${hue2} 56% 20%))`;
}

function glyphFor(name) {
  const words = name.replace(/[^\p{L}\p{N} ]/gu, " ").split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

const timeOfDay = (d) => d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

// ---------------------------------------------------------------------------
// Players-online chart
// ---------------------------------------------------------------------------

const CHART_W = 900;
const CHART_H = 220;
const PAD = { top: 14, right: 54, bottom: 24, left: 8 };

function renderChart(points) {
  if (points.length < 2) return;

  const values = points.map((p) => p.totalOnline);
  const rawMin = Math.min(...values);
  const rawMax = Math.max(...values);
  // Pad the domain so the line never grazes the frame. The axis is labelled
  // with real values at both ends, so a non-zero baseline stays readable —
  // the fill below is a low-opacity glow on a line chart, not an area whose
  // height is meant to be read as the quantity itself.
  const span = Math.max(rawMax - rawMin, 1);
  const min = Math.floor((rawMin - span * 0.25) / 10) * 10;
  const max = Math.ceil((rawMax + span * 0.25) / 10) * 10;

  const plotW = CHART_W - PAD.left - PAD.right;
  const plotH = CHART_H - PAD.top - PAD.bottom;
  const x = (i) => PAD.left + (i / (points.length - 1)) * plotW;
  const y = (v) => PAD.top + (1 - (v - min) / (max - min)) * plotH;

  chartGeometry = { x, y, min, max, plotW, plotH };

  const line = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.totalOnline).toFixed(1)}`).join("");
  const area = `${line}L${x(points.length - 1).toFixed(1)},${(PAD.top + plotH).toFixed(1)}L${x(0).toFixed(1)},${(PAD.top + plotH).toFixed(1)}Z`;

  const ticks = [min, Math.round((min + max) / 2), max];
  const gridRows = ticks
    .map(
      (t) =>
        `<line class="grid-line" x1="${PAD.left}" x2="${PAD.left + plotW}" y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}"/>` +
        `<text class="axis-label" x="${PAD.left + plotW + 8}" y="${(y(t) + 3.5).toFixed(1)}">${formatCount(t)}</text>`,
    )
    .join("");

  // Time labels at both ends and the middle.
  const timeAt = (i) => timeOfDay(new Date(points[i].t));
  const midIndex = Math.floor((points.length - 1) / 2);
  const xLabels =
    `<text class="axis-label" x="${PAD.left}" y="${CHART_H - 6}" text-anchor="start">${timeAt(0)}</text>` +
    `<text class="axis-label" x="${(PAD.left + plotW / 2).toFixed(1)}" y="${CHART_H - 6}" text-anchor="middle">${timeAt(midIndex)}</text>` +
    `<text class="axis-label" x="${(PAD.left + plotW).toFixed(1)}" y="${CHART_H - 6}" text-anchor="end">now</text>`;

  const lastX = x(points.length - 1);
  const lastY = y(points[points.length - 1].totalOnline);

  chartEl.innerHTML = `
    <defs>
      <linearGradient id="floorFill" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="var(--data-green)" stop-opacity="0.28"/>
        <stop offset="100%" stop-color="var(--data-green)" stop-opacity="0"/>
      </linearGradient>
    </defs>
    ${gridRows}
    <path d="${area}" fill="url(#floorFill)"/>
    <path d="${line}" fill="none" stroke="var(--data-green)" stroke-width="2"
          stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${lastX.toFixed(1)}" cy="${lastY.toFixed(1)}" r="4"
            fill="var(--data-green)" stroke="var(--surface)" stroke-width="2"/>
    ${xLabels}
    <g id="chartHover"></g>`;
}

/** Crosshair + tooltip. An HTML chart is interactive by default. */
function bindChartHover() {
  const move = (event) => {
    if (!chartGeometry || historyPoints.length < 2) return;

    const rect = chartEl.getBoundingClientRect();
    const clientX = event.touches ? event.touches[0].clientX : event.clientX;
    const ratio = (clientX - rect.left) / rect.width;
    const index = Math.max(0, Math.min(historyPoints.length - 1, Math.round(ratio * (historyPoints.length - 1))));
    const point = historyPoints[index];

    const px = chartGeometry.x(index);
    const py = chartGeometry.y(point.totalOnline);

    const hover = chartEl.querySelector("#chartHover");
    if (hover) {
      hover.innerHTML =
        `<line class="crosshair" x1="${px.toFixed(1)}" x2="${px.toFixed(1)}" y1="${PAD.top}" y2="${(CHART_H - PAD.bottom).toFixed(1)}"/>` +
        `<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="4.5" fill="var(--data-green)" stroke="var(--surface)" stroke-width="2"/>`;
    }

    chartTipEl.innerHTML =
      `<div class="tt-v">${formatCount(point.totalOnline)} players</div>` +
      `<div class="tt-t">${timeOfDay(new Date(point.t))}</div>`;
    chartTipEl.classList.add("on");

    // Position in wrapper space, flipping near the right edge so it stays visible.
    const wrapRect = chartWrapEl.getBoundingClientRect();
    const pxCss = (px / CHART_W) * rect.width + (rect.left - wrapRect.left);
    const tipW = chartTipEl.offsetWidth;
    chartTipEl.style.left = `${Math.max(0, Math.min(pxCss - tipW / 2, wrapRect.width - tipW))}px`;
    chartTipEl.style.top = `${(py / CHART_H) * rect.height - 52}px`;
  };

  chartEl.addEventListener("mousemove", move);
  chartEl.addEventListener("touchmove", move, { passive: true });
  const leave = () => {
    chartTipEl.classList.remove("on");
    const hover = chartEl.querySelector("#chartHover");
    if (hover) hover.innerHTML = "";
  };
  chartEl.addEventListener("mouseleave", leave);
  chartEl.addEventListener("touchend", leave);
}

/** A row's 30-minute sparkline. Same source as the count beside it. */
function sparklineSvg(gameName, nowMs) {
  const values = [];
  for (let offset = SPARK_MINUTES; offset >= 0; offset -= SPARK_STEP_MINUTES) {
    values.push(getGamePlayersAt(catalog, gameName, nowMs - offset * 60_000));
  }
  const w = 76;
  const h = 22;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = Math.max(max - min, 1);
  const path = values
    .map((v, i) => {
      const px = (i / (values.length - 1)) * w;
      const py = h - 2 - ((v - min) / range) * (h - 4);
      return `${i === 0 ? "M" : "L"}${px.toFixed(1)},${py.toFixed(1)}`;
    })
    .join("");
  const rising = values[values.length - 1] >= values[0];
  return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true">
      <path d="${path}" fill="none" stroke="${rising ? "var(--data-green)" : "var(--data-blue)"}"
            stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>
    </svg>`;
}

// ---------------------------------------------------------------------------
// Panels
// ---------------------------------------------------------------------------

function renderKpis(activity, history) {
  el("kpiOnline").textContent = formatCount(activity.totalOnline);

  // 15 minutes back, taken from the same recomputed history the chart draws.
  const stepsBack = Math.round(15 / HISTORY_STEP_MINUTES);
  const past = history[history.length - 1 - stepsBack];
  const deltaEl = el("kpiOnlineDelta");
  if (past) {
    const diff = activity.totalOnline - past.totalOnline;
    const pct = (diff / past.totalOnline) * 100;
    deltaEl.textContent = `${diff >= 0 ? "+" : ""}${pct.toFixed(1)}%`;
    deltaEl.className = `delta ${diff > 0 ? "up" : diff < 0 ? "down" : "flat"}`;
  }

  el("kpiGames").textContent = formatCount(activity.gamesInPlay);
  el("kpiGamesSub").textContent = `of ${formatCount(catalog.games.length)} in the catalogue`;

  const topCategory = activity.categories[0];
  if (topCategory) {
    el("kpiCategory").textContent = topCategory.category;
    const pct = ((topCategory.players / activity.totalOnline) * 100).toFixed(0);
    el("kpiCategorySub").textContent = `${formatCount(topCategory.players)} players · ${pct}% of the floor`;
  }

  const peak = history.reduce((best, p) => (p.totalOnline > best.totalOnline ? p : best), history[0]);
  el("kpiPeak").textContent = formatCount(peak.totalOnline);
  el("kpiPeakSub").textContent = `at ${timeOfDay(new Date(peak.t))} · past hour`;
}

function renderTable(activity, nowMs) {
  const rows = activity.games.slice(0, TABLE_ROWS);
  gamesBodyEl.innerHTML = rows
    .map((game, i) => {
      const share = ((game.players / activity.totalOnline) * 100).toFixed(1);
      return `<tr>
        <td class="rank">${i + 1}</td>
        <td>
          <div class="game-cell">
            <div class="game-art" style="background:${gradientFor(game.gameName)}">${escapeHtml(glyphFor(game.gameName))}</div>
            <div style="min-width:0">
              <div class="game-name" title="${escapeHtml(game.gameName)}">${escapeHtml(game.gameName)}</div>
              <div class="game-provider">${escapeHtml(game.provider)}</div>
            </div>
          </div>
        </td>
        <td><span class="tag">${escapeHtml(game.category)}</span></td>
        <td class="num"><span class="players">${formatCount(game.players)}</span></td>
        <td class="num" style="color:var(--muted)">${share}%</td>
        <td>${sparklineSvg(game.gameName, nowMs)}</td>
      </tr>`;
    })
    .join("");
}

function renderCategories(activity) {
  const max = activity.categories[0]?.players ?? 1;
  categoryBarsEl.innerHTML = activity.categories
    .map((c) => {
      const pct = ((c.players / activity.totalOnline) * 100).toFixed(1);
      return `<div class="bar-row" title="${escapeHtml(c.category)}: ${formatCount(c.players)} players (${pct}% of the floor)">
        <div class="bar-top">
          <span class="bar-name">${escapeHtml(c.category)}</span>
          <span class="bar-val">${formatCount(c.players)} <span style="color:var(--dim);font-weight:400">${pct}%</span></span>
        </div>
        <div class="bar-track"><div class="bar-fill" style="width:${(c.players / max) * 100}%"></div></div>
      </div>`;
    })
    .join("");
}

/**
 * Feed entries are derived from genuine increases between polls, never
 * fabricated — if no game gained players this tick, nothing is added.
 */
function updateFeed(activity) {
  const gained = [];
  for (const game of activity.games) {
    const before = previousCounts.get(game.gameName);
    if (before !== undefined && game.players > before) {
      gained.push({ name: game.gameName, by: game.players - before, total: game.players });
    }
  }
  previousCounts = new Map(activity.games.map((g) => [g.gameName, g.players]));

  if (gained.length > 0) {
    const pick = gained.sort((a, b) => b.by - a.by)[0];
    feedItems.unshift({
      text: `<b>${escapeHtml(String(pick.by))} player${pick.by === 1 ? "" : "s"}</b> joined ${escapeHtml(pick.name)}`,
      at: new Date(),
    });
    feedItems = feedItems.slice(0, FEED_MAX);
  }

  feedEl.innerHTML =
    feedItems.length === 0
      ? '<div class="feed-empty">Watching the floor…</div>'
      : feedItems
          .map(
            (item) => `<div class="feed-row">
              <span class="feed-dot"></span>
              <span class="feed-text">${item.text}</span>
              <span class="feed-time">${item.at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
            </div>`,
          )
          .join("");
}

// ---------------------------------------------------------------------------
// Game grid
// ---------------------------------------------------------------------------

/** Tracks each tile's count element so ticks update text in place, never re-render. */
const tileCountIndex = new Map();

function tileMarkup(game, { href } = {}) {
  const art =
    `<div class="g-name">${escapeHtml(game.gameName)}</div>` +
    `<div class="g-prov">${escapeHtml(game.provider)}</div>` +
    (href ? '<span class="g-play-tag">PLAY</span>' : "");

  // A link only where a real game exists to open. Everything else is a plain
  // div, so there is nothing to click and nothing that pretends to be clickable.
  const artEl = href
    ? `<a class="g-art" href="${href}" style="background:${gradientFor(game.gameName)}">${art}</a>`
    : `<div class="g-art" style="background:${gradientFor(game.gameName)}">${art}</div>`;

  return `<div class="g-tile">
      ${artEl}
      <div class="g-count"><span class="g-dot"></span><b data-count="${escapeHtml(game.gameName)}">0</b> playing</div>
    </div>`;
}

function rowMarkup(icon, title, tiles) {
  return `<div class="game-row">
      <div class="row-head">
        <span class="r-ico">${icon}</span>
        <h3>${escapeHtml(title)}</h3>
        <span class="chev">›</span>
        <span class="r-total" data-rowtotal="${escapeHtml(title)}"></span>
      </div>
      <div class="tile-row">${tiles}</div>
    </div>`;
}

function buildGameRows() {
  // Catalogue order is by real popularity, so membership stays stable between
  // ticks — tiles must not shuffle under the cursor every three seconds.
  const ranked = catalog.games.filter((g) => g.share >= MIN_TILE_SHARE);

  const rows = [
    { icon: "🎲", title: "PSK Originals", games: PSK_ORIGINALS, playable: true },
    { icon: "🔥", title: "Trending now", games: ranked.slice(0, TILES_PER_ROW) },
    { icon: "🎰", title: "Popular", games: ranked.slice(TILES_PER_ROW, TILES_PER_ROW * 2) },
  ].filter((row) => row.games.length >= ROW_SIZE_MIN);

  gameRowsEl.innerHTML = rows
    .map((row) =>
      rowMarkup(
        row.icon,
        row.title,
        row.games.map((g) => tileMarkup(g, row.playable ? { href: g.href } : {})).join(""),
      ),
    )
    .join("");

  tileCountIndex.clear();
  for (const node of gameRowsEl.querySelectorAll("[data-count]")) {
    tileCountIndex.set(node.getAttribute("data-count"), node);
  }

  gameRowsShown = Object.fromEntries(rows.map((row) => [row.title, row.games]));
}

function updateGameRows(nowMs) {
  if (tileCountIndex.size === 0) return;

  for (const [title, games] of Object.entries(gameRowsShown)) {
    let rowTotal = 0;
    for (const game of games) {
      // Catalogued games look their share up; the app's own games carry a
      // declared one. Both go through the same engine maths.
      const players =
        game.share !== undefined && game.href !== undefined
          ? getPlayersForShare(catalog, game.gameName, game.share, nowMs)
          : getGamePlayersAt(catalog, game.gameName, nowMs);

      rowTotal += players;
      const node = tileCountIndex.get(game.gameName);
      if (node) node.textContent = formatCount(players);
    }
    const totalNode = gameRowsEl.querySelector(`[data-rowtotal="${CSS.escape(title)}"]`);
    if (totalNode) totalNode.textContent = `${formatCount(rowTotal)} playing`;
  }
}

// ---------------------------------------------------------------------------
// Banner
// ---------------------------------------------------------------------------

const withCountMarkup = (text) => text.replace(/^([\d,]+)/, (n) => `<span class="count">${n}</span>`);

function rotateBanner() {
  if (!catalog) return;
  bannerIndex++;
  const line = buildBannerLine(getLiveCasinoActivity(catalog, Date.now()), bannerIndex);
  if (!line) return;
  bannerLineEl.classList.add("swapping");
  window.setTimeout(() => {
    bannerLineEl.innerHTML = withCountMarkup(line.text);
    bannerLineEl.classList.remove("swapping");
  }, 240);
}

// ---------------------------------------------------------------------------
// Tick
// ---------------------------------------------------------------------------

function render() {
  if (!catalog) return;
  const nowMs = Date.now();

  const activity = getLiveCasinoActivity(catalog, nowMs, { topN: TABLE_ROWS });
  historyPoints = getFloorHistory(catalog, nowMs, {
    minutes: HISTORY_MINUTES,
    stepMinutes: HISTORY_STEP_MINUTES,
  });

  if (!bannerLineEl.classList.contains("swapping")) {
    const line = buildBannerLine(activity, bannerIndex);
    if (line) bannerLineEl.innerHTML = withCountMarkup(line.text);
  }

  renderKpis(activity, historyPoints);
  renderChart(historyPoints);
  renderTable(activity, nowMs);
  renderCategories(activity);
  updateFeed(activity);
  updateGameRows(nowMs);

  clockEl.textContent = `Updated ${new Date().toLocaleTimeString()}`;
  chartRangeEl.textContent = `${timeOfDay(new Date(historyPoints[0].t))} — now`;
}

async function start() {
  try {
    const res = await fetch("./data/casinoCatalog.json");
    if (!res.ok) throw new Error(`catalog request failed: ${res.status}`);
    catalog = await res.json();
  } catch (err) {
    bannerLineEl.textContent = "Could not load the casino catalog.";
    gamesBodyEl.innerHTML =
      '<tr><td colspan="6" style="padding:16px 8px;color:var(--dim)">Serve this folder over http ' +
      "(<code>node serve.mjs</code>) — opening index.html straight from disk blocks the data fetch.</td></tr>";
    console.error(err);
    return;
  }

  noteEl.innerHTML =
    `<strong>How these numbers are produced.</strong> The game line-up, each game's popularity relative to the others, ` +
    `and the time-of-day rhythm are measured from a real PSK casino event-log export ` +
    `(${formatCount(catalog.sourceLaunchRows)} game launches across ${formatCount(catalog.games.length)} games). ` +
    `Concurrent-player counts are <strong>simulated demo values, not real PSK figures</strong> — the export samples ` +
    `top users only, so it carries the shape of play but not its true scale.`;

  buildGameRows();
  gamesShownEl.textContent = `${formatCount(catalog.games.length)} games in the catalogue`;
  bindChartHover();
  render();
  window.setInterval(render, POLL_MS);
  window.setInterval(rotateBanner, ROTATE_MS);
}

start();
