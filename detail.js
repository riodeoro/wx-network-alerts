import { YEAR_MIN, R2_BASE } from "./config.js";
import {
  ALL_SENSOR_COLS,
  CIRCULAR_COLS,
  COL_FALLBACK,
  STATION_DETAIL_MAX,
  loadStationConfig,
  stationSource,
  stationSeries,
  safeName,
  dispUnit,
} from "./data.js";
import {
  ready,
  registerFile,
  dropFile,
  qTable,
  pack,
  num,
  str,
  lit,
  ident,
} from "./duck.js";
import {
  buildStationDetail,
  isoStamp,
  ARROW_COL,
  ARROW_DIR_COL,
  SENSOR_GROUPS,
  MUTED_SCALE,
  MUTED_OPACITY,
  FONT_FAMILY,
  axisStyle,
  circularAxis,
  emptyFig,
} from "./charts.js";
import {
  RAIN_COL,
  RANGE_FILL,
  NORMALS_PREFIX,
  loadNormals,
  bandFor,
  supports,
  anySupported,
  cumulativeSeries,
  remapAlerts,
  applyNormals,
} from "./normals.js";

export {
  RAIN_COL as NORMALS_RAIN_COL,
  loadNormals as neighbourNormals,
  normalsRangeTraces,
} from "./normals.js";

const ATTR_TAB = {
  Rh: "rh",
  Wspd: "wind",
  Dir: "wind",
  Temp: "temp",
  Rn_1: "rn1",
  Vbat: "power",
};

const RANGE_SUFFIXES = ["data", "rh", "wind", "temp", "rn1", "power"];

const DIR_CONC_RE = /^Direction concentration/;

const OPTIONAL_COLS = new Set([
  "SM1", "SM2", "SM3", "ST1", "ST2", "ST3",
  "PrecipOP2", "PrecipPC2", "Rn_1_OP2", "Rn_1_PC2", "SDepth",
]);

const GROUP_OF = new Map();
for (const [key, group] of Object.entries(SENSOR_GROUPS)) {
  for (const col of group.members) GROUP_OF.set(col, key);
}

const ALERTS_NAME = "Alerts";

const PLOT_PREF = {
  "tab-rh": ["Rh", "Temp"],
  "tab-wind": ["Wspd", "Mx_Spd"],
  "tab-temp": ["Temp", "Rh"],
  "tab-rn1": ["Rn_1", "Rh"],
  "tab-power": ["Vbat", "Vslr"],
};

const SERIES_CACHE_MAX = 8;

const PLOT_CONFIG = {
  responsive: true,
  displaylogo: false,
  showTips: false,
  displayModeBar: "hover",
  modeBarButtonsToRemove: ["lasso2d", "select2d"],
};

const DENSITY_CONFIG = {
  responsive: true,
  displaylogo: false,
  showTips: false,
  displayModeBar: "hover",
  modeBarButtonsToRemove: ["select2d"],
};

const VIEW_TIME = "time";
const VIEW_DENSITY = "density";
const HOUR_KEY = "@hour";
const HOUR_LABEL = "Hour of day";
const DENSITY_BINS = 60;
const DIR_BINS = 36;
const QUANTUM_SCALE = 1e6;
const PICK_COLOR = "#ff2ec4";
const PICK_NAME = "Selected";
const HEAT_SCALE = [
  [0.0, "#fcd9a8"],
  [0.35, "#f5a524"],
  [0.7, "#d97706"],
  [1.0, "#7c2d12"],
];
const PICK_BAR_SPACE = 32;
const PICK_EPS = 1e-9;
const PICK_STYLE_ID = "wx-detail-pick-styles";
const HIST_COLOR = "#2c5fa9";
const HIST_LEVELS = [
  { q: 0.5, name: "50% of hours", width: 1.6, dash: "solid" },
  { q: 0.8, name: "80% of hours", width: 1.3, dash: "4px,3px" },
];
const HIST_CORE = 0.02;
const HIST_GRID = 30;
const HIST_SMOOTH_PASSES = 2;
const HIST_FILES_MAX = 3;
const HIST_SERIES_MAX = 8;
const HISTORY_DIR = "history";
const HIST_ROWS_MAX = 600000;
const DENSITY_TOP = 28;
const DENSITY_TOP_HIST = 40;
const CELL_MAX = 240;
const RAIN_KEYS = new Set(["Rn_1", "Rn_1_OP2", "Rn_1_PC2"]);
const RAIN_SUFFIX = ", > 0 mm";
const CELL_SIZE = {
  Temp: 0.5,
  Rh: 2,
  Wspd: 1,
  Mx_Spd: 1,
  Rn_1: 0.2,
  Rn_1_OP2: 0.2,
  Rn_1_PC2: 0.2,
  Vbat: 0.05,
  Vslr: 0.5,
  Ibat: 0.05,
  SM1: 1,
  SM2: 1,
  SM3: 1,
  ST1: 0.5,
  ST2: 0.5,
  ST3: 0.5,
  SDepth: 2,
  PYR: 20,
  FFMC: 1,
  ISI: 0.5,
  FWI: 1,
  DC: 10,
  DMC: 2,
  BUI: 2,
};
const DAY_MS = 24 * 3600 * 1000;
const CUM_DAYS = [0, 31, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335];
const NORMAL_NAME = "P10–P90 for these dates";

const MOBILE = () => window.matchMedia("(max-width: 768px)").matches;

const CHECK_SVG =
  '<svg viewBox="0 0 12 12" aria-hidden="true" focusable="false">' +
  '<path d="M2.4 6.3 4.8 8.7 9.6 3.5"/></svg>';

let _normalsOn = false;

let _arrowsOn = false;

export function resetHistorical() {
  _normalsOn = false;
}

export function historicalOn() {
  return _normalsOn;
}

const NORMALS_WAIT_MS = 120;

const GATE_WAIT_MS = 4000;

const FIT_PAD = 0.06;
const FIT_FLAT = 0.5;
const SLIDER_PAD = 0.05;

let _configPromise = null;
let _config = null;
let _enginePromise = null;

export function warmConfig() {
  if (_configPromise) return _configPromise;
  _configPromise = loadStationConfig()
    .then((rows) => {
      _config = rows;
      return rows;
    })
    .catch(() => {
      _config = null;
      return null;
    });
  return _configPromise;
}

export function warmEngine() {
  if (!_enginePromise) _enginePromise = ready().catch(() => null);
  return _enginePromise;
}

let _neighbourPromise = null;
let _neighbourMap = null;

export function neighbourGroups() {
  if (_neighbourMap) return Promise.resolve(_neighbourMap);
  if (!_neighbourPromise) {
    _neighbourPromise = warmConfig()
      .then((rows) => {
        const map = new Map();
        for (const r of rows || []) {
          if (!r || !r.station_name) continue;
          const list = Array.isArray(r.neighbours)
            ? r.neighbours.filter(Boolean)
            : [];
          if (!list.length) continue;
          const key = normName(r.station_name);
          if (key && !map.has(key)) map.set(key, list);
        }
        _neighbourMap = map;
        return map;
      })
      .catch(() => {
        _neighbourMap = new Map();
        return _neighbourMap;
      });
  }
  return _neighbourPromise;
}

let _coordPromise = null;

export function stationCoords() {
  if (!_coordPromise) {
    _coordPromise = warmConfig()
      .then((rows) => {
        const map = new Map();
        for (const r of rows || []) {
          if (!r || !r.station_name) continue;
          if (!Number.isFinite(r.lat) || !Number.isFinite(r.lon)) continue;
          const key = normName(r.station_name);
          if (key && !map.has(key)) {
            map.set(key, {
              lat: r.lat,
              lon: r.lon,
              elev: Number.isFinite(r.elev) ? r.elev : null,
              name: r.station_name,
              fc: r.fire_centre || null,
              enabled: r.enabled !== false,
            });
          }
        }
        return map;
      })
      .catch(() => new Map());
  }
  return _coordPromise;
}

function normName(s) {
  return String(s == null ? "" : s)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function candidateNames(station) {
  const out = [station];
  const rows = _config;
  if (!rows || !rows.length) return out;

  const target = normName(station);
  if (!target) return out;

  const names = [];
  const seen = new Set();
  for (const r of rows) {
    const n = r.station_name;
    if (n && !seen.has(n)) {
      seen.add(n);
      names.push(n);
    }
  }

  const exact = names.find((n) => n === station);
  if (exact && !out.includes(exact)) out.push(exact);

  const norm = names.find((n) => normName(n) === target);
  if (norm && !out.includes(norm)) out.push(norm);

  const prefix = names
    .filter((n) => {
      const v = normName(n);
      return v.indexOf(target) === 0 || target.indexOf(v) === 0;
    })
    .sort((a, b) => a.length - b.length)[0];
  if (prefix && !out.includes(prefix)) out.push(prefix);

  return out;
}

const TYPED_ARRAY_CTORS = {
  f8: Float64Array,
  f4: Float32Array,
  i4: Int32Array,
  u4: Uint32Array,
  i2: Int16Array,
  u2: Uint16Array,
  i1: Int8Array,
  u1: Uint8Array,
};

function decodeArray(v) {
  if (Array.isArray(v)) return v;
  if (!v || typeof v !== "object") return null;
  if (typeof v.bdata !== "string" || typeof v.dtype !== "string") return null;
  if (v.shape !== undefined && String(v.shape).indexOf(",") >= 0) return null;
  const Ctor = TYPED_ARRAY_CTORS[v.dtype];
  if (!Ctor) return null;
  try {
    const bin = atob(v.bdata);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    if (bytes.byteLength % Ctor.BYTES_PER_ELEMENT !== 0) return null;
    return Array.from(
      new Ctor(bytes.buffer, 0, bytes.byteLength / Ctor.BYTES_PER_ELEMENT)
    );
  } catch (e) {
    void e;
    return null;
  }
}

const STAMP_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/;

function parseStamp(v) {
  if (v === null || v === undefined) return NaN;
  if (typeof v === "number") return v;
  const m = STAMP_RE.exec(String(v));
  if (!m) return NaN;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], m[6] ? +m[6] : 0);
}

const HOVER_STATION_RE = /^<b>(.*?)<\/b>/;

function axisIdsForStation(fig, station) {
  const ids = new Set();
  for (const tr of (fig && fig.data) || []) {
    const ht = tr && tr.hovertemplate;
    if (typeof ht !== "string") continue;
    const m = HOVER_STATION_RE.exec(ht);
    if (m && m[1].trim() === station) ids.add(tr.xaxis || "x");
  }
  return ids;
}

function bandHoverText(text) {
  if (typeof text !== "string") return null;
  const parts = text.split("<br>");
  const rest = parts[0].indexOf("<b>") === 0 ? parts.slice(1) : parts;
  const out = rest.join("<br>").trim();
  return out || null;
}

function extractAlerts(fig, station) {
  const empty = { points: [], bands: [] };
  if (!fig || !Array.isArray(fig.data)) return empty;

  const ids = axisIdsForStation(fig, station);
  if (!ids.size) return empty;

  const points = [];

  const labels = new Map();

  for (const tr of fig.data) {
    if (!tr || !ids.has(tr.xaxis || "x")) continue;

    if (tr.meta && tr.meta.band_hover) {
      const xs = decodeArray(tr.x) || [];
      const label = bandHoverText(tr.text);
      if (!label) continue;
      let fresh = true;
      for (const v of xs) {
        if (v === null || v === undefined) {
          fresh = true;
          continue;
        }
        if (!fresh) continue;
        const t = parseStamp(v);
        if (!Number.isFinite(t)) continue;
        labels.set(t, label);
        fresh = false;
      }
      continue;
    }

    if (tr.mode !== "markers") continue;
    const xs = decodeArray(tr.x) || [];
    const ys = decodeArray(tr.y) || [];
    const text = decodeArray(tr.text) || [];
    const rawColor = tr.marker && tr.marker.color;
    const colors = decodeArray(rawColor);
    const flat = typeof rawColor === "string" ? rawColor : null;
    for (let i = 0; i < xs.length; i++) {
      const t = parseStamp(xs[i]);
      const y = Number(ys[i]);
      if (!Number.isFinite(t) || !Number.isFinite(y)) continue;
      points.push({
        t,
        y,
        color: (colors && colors[i]) || flat || null,
        text: text[i] == null ? "" : String(text[i]),
      });
    }
  }
  points.sort((a, b) => a.t - b.t);

  const bands = [];
  for (const s of (fig.layout && fig.layout.shapes) || []) {
    if (!s || s.type !== "rect") continue;
    if (!ids.has(typeof s.xref === "string" ? s.xref : "")) continue;
    const x0 = parseStamp(s.x0);
    const x1 = parseStamp(s.x1);
    if (!Number.isFinite(x0) || !Number.isFinite(x1)) continue;
    bands.push({
      x0: Math.min(x0, x1),
      x1: Math.max(x0, x1),
      fillcolor: s.fillcolor || null,
      label: labels.get(x0) || null,
    });
  }

  return { points, bands };
}

let _alertCache = new WeakMap();

function lruGet(map, key) {
  if (!map.has(key)) return null;
  const v = map.get(key);
  map.delete(key);
  map.set(key, v);
  return v;
}

function lruSet(map, key, value, cap) {
  if (map.has(key)) map.delete(key);
  else if (map.size >= cap) map.delete(map.keys().next().value);
  map.set(key, value);
}

function isDirConc(b) {
  return !!(b && b.label && DIR_CONC_RE.test(b.label));
}

function ownedAlerts(col, a) {
  if (!a) return a;
  const bands = a.bands || [];
  if (col === "Dir") return { points: [], bands: bands.filter(isDirConc) };
  if (col === "Wspd") {
    return { points: a.points || [], bands: bands.filter((b) => !isDirConc(b)) };
  }
  return a;
}

function chartAlerts(chart, station) {
  if (!chart || typeof chart !== "object" || !chart.station_grid) return null;
  let byStation = _alertCache.get(chart);
  if (!byStation) {
    byStation = new Map();
    _alertCache.set(chart, byStation);
  }
  if (!byStation.has(station)) {
    byStation.set(station, extractAlerts(chart.station_grid, station));
  }
  return byStation.get(station);
}

function alertsFor(opts, col) {
  const suffix = ATTR_TAB[col] || null;
  if (!suffix || typeof opts.getChart !== "function") {
    return Promise.resolve(null);
  }
  return Promise.resolve()
    .then(() => opts.getChart(suffix))
    .then((c) => chartAlerts(c, opts.station))
    .catch(() => null)
    .then((a) => ownedAlerts(col, a));
}

function primeAlerts(opts) {
  for (const c of PLOT_PREF[opts.tab] || []) alertsFor(opts, c);
}

function explicitBounds(opts) {
  if (!Array.isArray(opts.range) || opts.range.length !== 2) return null;
  const lo = parseStamp(opts.range[0]);
  const hi = parseStamp(opts.range[1]);
  return Number.isFinite(lo) && Number.isFinite(hi) && hi > lo ? [lo, hi] : null;
}

async function windowBounds(opts) {
  const given = explicitBounds(opts);
  if (given) return given;
  if (typeof opts.getChart === "function") {
    for (const suffix of RANGE_SUFFIXES) {
      let c = null;
      try {
        c = await opts.getChart(suffix);
      } catch (e) {
        void e;
        c = null;
      }
      if (!c || !c._date_min || !c._date_max) continue;
      const lo = parseStamp(c._date_min);
      const hi = parseStamp(c._date_max);
      if (Number.isFinite(lo) && Number.isFinite(hi) && hi > lo) return [lo, hi];
      break;
    }
  }
  const end = Date.now();
  const span = Math.max(1, Number(opts.hours) || 168) * 3600 * 1000;
  return [end - span, end];
}

function yearsFor(startMs, endMs) {
  const lo = new Date(startMs).getUTCFullYear();
  const hi = new Date(endMs).getUTCFullYear();
  const out = [];
  for (let y = Math.max(YEAR_MIN, lo); y <= hi; y++) out.push(y);
  return out.length ? out : [hi];
}

const _seriesCache = new Map();

async function openSource(station, years) {
  await warmEngine();
  await warmConfig();
  let lastName = station;
  for (const name of candidateNames(station)) {
    lastName = name;
    let src = null;
    try {
      src = await stationSource(name, years, [name]);
    } catch (e) {
      void e;
      src = null;
    }
    if (src) return { source: src, name };
  }
  const err = new Error("no stored data for " + lastName);
  err.code = "NO_DATA";
  throw err;
}

function hasReadings(series, col) {
  const v = series && series[col];
  if (!v) return false;
  for (let i = 0; i < series.n; i++) {
    if (Number.isFinite(v[i])) return true;
  }
  return false;
}

async function load(opts) {
  const [startMs, endMs] = await windowBounds(opts);
  const key = [opts.station, opts.fc, opts.hours, startMs, endMs].join("|");

  const hit = lruGet(_seriesCache, key);
  if (hit) return hit;

  const p = (async () => {
    const years = yearsFor(startMs, endMs);
    const { source, name } = await openSource(opts.station, years);

    const want = source.columns.filter((c) => ALL_SENSOR_COLS.includes(c));
    if (!want.length) {
      const err = new Error("no sensor columns");
      err.code = "NO_COLUMNS";
      throw err;
    }

    const series = await stationSeries(source, name, want, STATION_DETAIL_MAX, [
      startMs,
      endMs,
    ]);
    if (!series || !series.n) {
      const err = new Error("no rows");
      err.code = "NO_ROWS";
      throw err;
    }
    const cols = want.filter(
      (c) => !OPTIONAL_COLS.has(c) || hasReadings(series, c)
    );
    if (!cols.length) {
      const err = new Error("no sensor columns");
      err.code = "NO_COLUMNS";
      throw err;
    }
    return { series, name, startMs, endMs, cols };
  })();

  p.catch(() => {
    if (_seriesCache.get(key) === p) _seriesCache.delete(key);
  });
  lruSet(_seriesCache, key, p, SERIES_CACHE_MAX);
  return p;
}

const _historyFiles = new Map();
const _historySeries = new Map();
let _historySeq = 0;

function releaseHistory(station, job) {
  for (const key of Array.from(_historySeries.keys())) {
    if (key.indexOf(station + "|") === 0) _historySeries.delete(key);
  }
  Promise.resolve(job)
    .then((entry) => {
      if (!entry) return;
      for (const name of entry.files) dropFile(name);
    })
    .catch(() => {});
}

function historyUrl(station) {
  return `${R2_BASE}/${NORMALS_PREFIX}/${HISTORY_DIR}/${safeName(station)}.parquet`;
}

async function fetchHistoryFiles(station) {
  await warmEngine();
  const res = await fetch(historyUrl(station), { credentials: "omit", cache: "no-cache" });
  if (!res.ok) return null;
  const buf = new Uint8Array(await res.arrayBuffer());
  const name = `wxh_${++_historySeq}.parquet`;
  await registerFile(name, buf);
  try {
    const desc = pack(
      await qTable(`DESCRIBE SELECT * FROM read_parquet([${lit(name)}], union_by_name = true)`)
    );
    return { files: [name], cols: new Set(str(desc, "column_name")) };
  } catch (e) {
    dropFile(name);
    throw e;
  }
}

function historyFiles(station) {
  const hit = lruGet(_historyFiles, station);
  if (hit) return hit;
  while (_historyFiles.size >= HIST_FILES_MAX) {
    const oldest = _historyFiles.keys().next().value;
    const job = _historyFiles.get(oldest);
    _historyFiles.delete(oldest);
    releaseHistory(oldest, job);
  }
  const p = fetchHistoryFiles(station);
  p.catch(() => {
    if (_historyFiles.get(station) === p) _historyFiles.delete(station);
  });
  _historyFiles.set(station, p);
  return p;
}

async function queryHistory(station, cols) {
  const entry = await historyFiles(station);
  if (!entry || !entry.cols.has("DATE_TIME_PARSED")) return null;
  const exprs = [];
  const have = [];
  for (const c of cols) {
    const names = [c]
      .concat(COL_FALLBACK[c] || [])
      .filter((n) => entry.cols.has(n));
    if (!names.length) continue;
    const parts = names.map(
      (n) => `TRY_CAST(TRY_CAST(${ident(n)} AS FLOAT) AS DOUBLE)`
    );
    exprs.push(
      `${parts.length > 1 ? `COALESCE(${parts.join(", ")})` : parts[0]} AS ${ident(c)}`
    );
    have.push(c);
  }
  if (!have.length) return null;
  const stamp = 'TRY_CAST("DATE_TIME_PARSED" AS TIMESTAMP)';
  const res = pack(
    await qTable(
      `SELECT CAST(epoch_ms(${stamp}) AS DOUBLE) AS t_ms, ${exprs.join(", ")} ` +
        `FROM read_parquet([${entry.files.map(lit).join(", ")}], union_by_name = true) ` +
        `WHERE ${stamp} IS NOT NULL LIMIT ${HIST_ROWS_MAX}`
    )
  );
  if (!res.n) return null;
  const out = { n: res.n, t: num(res, "t_ms"), cols: have };
  for (const c of have) out[c] = num(res, c);
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < out.n; i++) {
    const t = out.t[i];
    if (t < lo) lo = t;
    if (t > hi) hi = t;
  }
  out.years = [new Date(lo).getUTCFullYear(), new Date(hi).getUTCFullYear()];
  return out;
}

function historySeries(station, cols) {
  const key = station + "|" + cols.join(",");
  const hit = lruGet(_historySeries, key);
  if (hit) return hit;
  const p = queryHistory(station, cols);
  p.catch(() => {
    if (_historySeries.get(key) === p) _historySeries.delete(key);
  });
  lruSet(_historySeries, key, p, HIST_SERIES_MAX);
  return p;
}

function chartReady(opts, suffix) {
  if (!suffix) return false;
  if (typeof opts.peekChart !== "function") return true;
  return !!opts.peekChart(suffix);
}

function boundsReady(opts) {
  if (explicitBounds(opts)) return true;
  return chartReady(opts, RANGE_SUFFIXES[0]);
}

export function prefetch(opts) {
  if (!opts || !opts.station) return;
  warmEngine();
  loadNormals(opts.station);
  for (const c of PLOT_PREF[opts.tab] || []) {
    if (chartReady(opts, ATTR_TAB[c])) alertsFor(opts, c);
  }
  if (boundsReady(opts)) load(opts).catch(() => {});
}

function wantsDir(opts, cols) {
  return opts.tab === "tab-wind" && cols.includes("Dir");
}

async function dirBands(opts) {
  let a = null;
  try {
    a = await alertsFor(opts, "Dir");
  } catch (e) {
    void e;
    a = null;
  }
  return !!(a && a.bands && a.bands.length);
}

async function preferredCols(opts, cols) {
  const pref = PLOT_PREF[opts.tab] || [];
  if (!wantsDir(opts, cols)) return pref;
  const suffix = ATTR_TAB.Dir;
  const cached =
    typeof opts.peekChart === "function" ? opts.peekChart(suffix) : true;
  if (!cached) return pref;
  return (await dirBands(opts)) ? ["Dir", "Wspd"] : pref;
}

function pickPlotCols(pref, cols) {
  const have = (c) => c && cols.includes(c);
  let primary = pref.find(have) || null;
  let secondary = pref.filter(have).find((c) => c !== primary) || null;
  if (!primary) primary = cols[0] || null;
  if (secondary === primary) secondary = null;
  return { primary, secondary };
}

function orderedCols(cols) {
  const rank = new Map(ALL_SENSOR_COLS.map((c, i) => [c, i]));
  return cols
    .slice()
    .sort((a, b) => (rank.get(a) ?? 999) - (rank.get(b) ?? 999));
}

function plotChoices(cols) {
  const out = [];
  for (const c of cols) {
    const key = GROUP_OF.get(c) || c;
    if (!out.includes(key)) out.push(key);
  }
  return out;
}

function choiceLabel(key) {
  return SENSOR_GROUPS[key] ? SENSOR_GROUPS[key].label : dispUnit(key);
}

function choiceCols(key) {
  return SENSOR_GROUPS[key] ? SENSOR_GROUPS[key].members : [key];
}

function detailHeight(modal, plot) {
  const vh = window.innerHeight || 800;
  const cap = Math.max(300, vh - (MOBILE() ? 16 : 56));
  const chrome = modal ? modal.offsetHeight - (plot ? plot.offsetHeight : 0) : 0;
  const avail = cap - Math.max(0, chrome) - 12;
  return Math.round(Math.max(320, Math.min(760, avail)));
}

export function plotHeight(maxHeight) {
  const h = detailHeight(null, null);
  const v = typeof maxHeight === "function" ? maxHeight() : maxHeight;
  const cap = Number(v) || 0;
  return cap ? Math.min(h, cap) : h;
}

function focusWindow(fig, startMs, endMs, view) {
  const ax = fig.layout && fig.layout.xaxis;
  if (!ax) return fig;
  const span = view || [startMs, endMs];
  ax.range = [isoStamp(span[0]), isoStamp(span[1])];
  ax.autorange = false;
  ax.rangeslider = Object.assign({}, ax.rangeslider, {
    autorange: false,
    range: [isoStamp(startMs), isoStamp(endMs)],
  });
  return fig;
}

function fullView(plot) {
  const ax = plot && plot._fullLayout && plot._fullLayout.xaxis;
  const r = ax && ax.range;
  if (!r || r.length !== 2 || typeof ax.r2l !== "function") return null;
  const lo = ax.r2l(r[0]);
  const hi = ax.r2l(r[1]);
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return null;
  return [lo, hi];
}

function edgeValue(t, v, k, n, x) {
  if (k <= 0 || k >= n) return NaN;
  const a = v[k - 1];
  const b = v[k];
  if (!Number.isFinite(a) || !Number.isFinite(b)) return NaN;
  const dt = t[k] - t[k - 1];
  return dt > 0 ? a + ((b - a) * (x - t[k - 1])) / dt : b;
}

function extent(t, v, n, view, box) {
  let a = 0;
  let b = n;
  while (a < b) {
    const m = (a + b) >> 1;
    if (t[m] < view[0]) a = m + 1;
    else b = m;
  }
  let min = box.min;
  let max = box.max;
  let i = a;
  for (; i < n && t[i] <= view[1]; i++) {
    const y = v[i];
    if (!Number.isFinite(y)) continue;
    if (y < min) min = y;
    if (y > max) max = y;
  }
  const head = edgeValue(t, v, a, n, view[0]);
  const tail = edgeValue(t, v, i, n, view[1]);
  if (Number.isFinite(head)) {
    if (head < min) min = head;
    if (head > max) max = head;
  }
  if (Number.isFinite(tail)) {
    if (tail < min) min = tail;
    if (tail > max) max = tail;
  }
  box.min = min;
  box.max = max;
}

function fitRange(series, col, view, band) {
  if (!series || !series.n || !col) return null;
  const list = choiceCols(col).filter((c) => !CIRCULAR_COLS.has(c) && series[c]);
  if (!list.length) return null;
  const box = { min: Infinity, max: -Infinity };
  for (const c of list) extent(series.t, series[c], series.n, view, box);
  if (band && Array.isArray(band.x) && band.x.length) {
    extent(band.x, band.p10, band.x.length, view, box);
    extent(band.x, band.p90, band.x.length, view, box);
  }
  const min = box.min;
  const max = box.max;
  if (min > max) return null;
  const span = max - min;
  const pad = span > 0 ? span * FIT_PAD : Math.max(Math.abs(max) * FIT_PAD, FIT_FLAT);
  const low = min >= 0 && min - pad < 0 ? 0 : min - pad;
  return [low, max + pad];
}

function sliderRange(fig, axis) {
  let min = Infinity;
  let max = -Infinity;
  let zero = false;
  for (const tr of fig.data) {
    if (!tr || (tr.yaxis || "y") !== axis || !tr.y) continue;
    if (tr.fill === "tozeroy") zero = true;
    const y = tr.y;
    for (let i = 0; i < y.length; i++) {
      const v = y[i];
      if (v === null || !Number.isFinite(v)) continue;
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  if (min > max) return null;
  const lo = zero ? Math.min(min, 0) : min;
  const hi = zero ? Math.max(max, 0) : max;
  const pad = (hi - lo || 1) * SLIDER_PAD;
  return [zero && lo === 0 ? 0 : lo - pad, zero && hi === 0 ? 0 : hi + pad];
}

function sliderAxis(fig, axis) {
  const range = sliderRange(fig, axis);
  return range ? { rangemode: "fixed", range } : { rangemode: "auto" };
}

function tidySlider(plot) {
  const box = plot.querySelector(".rangeslider-container");
  if (!box) return;
  const bg = box.querySelector(".rangeslider-bg");
  const slide = box.querySelector(".rangeslider-slidebox");
  const height = bg ? bg.getAttribute("height") : null;
  if (slide && height !== null) {
    slide.setAttribute("y", 0);
    slide.setAttribute("height", height);
  }
  for (const mask of box.querySelectorAll(
    ".rangeslider-mask-min-opp-axis, .rangeslider-mask-max-opp-axis"
  )) {
    mask.style.display = "none";
  }
}

function currentView(plot) {
  const ax = plot && plot.layout && plot.layout.xaxis;
  const r = ax && ax.range;
  if (!r || r.length !== 2) return null;
  const lo = parseStamp(r[0]);
  const hi = parseStamp(r[1]);
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return null;
  return [lo, hi];
}

function startView(range) {
  if (!Array.isArray(range) || range.length !== 2) return null;
  const lo = parseStamp(range[0]);
  const hi = parseStamp(range[1]);
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return null;
  return [lo, hi];
}

function seriesCols(series, key) {
  return choiceCols(key).filter((c) => series[c]);
}

function hourOf(ms) {
  return new Date(ms).getUTCHours();
}

function densityKeys(primary, secondary) {
  return secondary === HOUR_KEY
    ? { x: HOUR_KEY, y: primary }
    : { x: primary, y: secondary };
}

function keyLabel(key) {
  if (key === HOUR_KEY) return HOUR_LABEL;
  return RAIN_KEYS.has(key) ? choiceLabel(key) + RAIN_SUFFIX : choiceLabel(key);
}

function valuesAt(series, key, cols, i) {
  if (key === HOUR_KEY) return [hourOf(series.t[i])];
  const out = [];
  const circ = isCircularKey(key);
  const rain = RAIN_KEYS.has(key);
  for (const c of cols) {
    const v = series[c][i];
    if (!Number.isFinite(v)) continue;
    if (rain && !(v > 0)) continue;
    out.push(circ ? ((v % 360) + 360) % 360 : v);
  }
  return out;
}

function eachPair(series, xKey, yKey, fn) {
  const xCols = xKey === HOUR_KEY ? [] : seriesCols(series, xKey);
  const yCols = yKey === HOUR_KEY ? [] : seriesCols(series, yKey);
  if (xKey !== HOUR_KEY && !xCols.length) return;
  if (yKey !== HOUR_KEY && !yCols.length) return;
  for (let i = 0; i < series.n; i++) {
    const xv = valuesAt(series, xKey, xCols, i);
    if (!xv.length) continue;
    const yv = valuesAt(series, yKey, yCols, i);
    for (const x of xv) for (const y of yv) fn(i, x, y);
  }
}

function isCircularKey(key) {
  return !SENSOR_GROUPS[key] && CIRCULAR_COLS.has(key);
}

function quantum(values) {
  const seen = new Set();
  for (const v of values) seen.add(Math.round(v * QUANTUM_SCALE));
  if (seen.size < 2) return 0;
  const u = Array.from(seen).sort((a, b) => a - b);
  let q = Infinity;
  for (let i = 1; i < u.length; i++) {
    const d = u[i] - u[i - 1];
    if (d > 0 && d < q) q = d;
  }
  return Number.isFinite(q) ? q / QUANTUM_SCALE : 0;
}

function alignedSpec(min, span, q, maxBins) {
  const cells = Math.round(span / q) + 1;
  const step = q * Math.max(1, Math.ceil(cells / maxBins));
  const lo = min - q / 2;
  return { lo: lo, step: step, n: Math.max(1, Math.ceil((span + q) / step - 1e-6)) };
}

function binSpec(values, key) {
  if (key === HOUR_KEY) return { lo: -0.5, step: 1, n: 24 };
  if (isCircularKey(key)) {
    const q = quantum(values);
    if (q > 0 && q <= 180) return alignedSpec(0, 360 - q, q, DIR_BINS);
    return { lo: 0, step: 360 / DIR_BINS, n: DIR_BINS };
  }
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!(max > min)) return { lo: min - 0.5, step: 1, n: 1 };
  const span = max - min;
  const q = quantum(values);
  if (q > 0 && span / q < 1e5) return alignedSpec(min, span, q, DENSITY_BINS);
  return { lo: min, step: span / DENSITY_BINS, n: DENSITY_BINS };
}

function binOf(spec, v) {
  const k = Math.floor((v - spec.lo) / spec.step);
  return Math.min(spec.n - 1, Math.max(0, k));
}

function centres(spec) {
  const out = new Array(spec.n);
  for (let k = 0; k < spec.n; k++) out[k] = spec.lo + (k + 0.5) * spec.step;
  return out;
}

function axisFor(key, label, spec) {
  if (key === HOUR_KEY) {
    return Object.assign(axisStyle(HOUR_LABEL), {
      range: [-0.5, 23.5],
      autorange: false,
      tickmode: "linear",
      tick0: 0,
      dtick: 3,
    });
  }
  if (isCircularKey(key)) {
    return Object.assign(circularAxis(label), {
      range: [spec.lo, spec.lo + spec.n * spec.step],
      autorange: false,
    });
  }
  return Object.assign(axisStyle(label), {
    range: [spec.lo, spec.lo + spec.n * spec.step],
    autorange: false,
  });
}

function cellOf(spec, v) {
  const k = Math.floor((v - spec.lo) / spec.step);
  if (k >= 0 && k < spec.n) return k;
  if (k === spec.n && v <= spec.lo + spec.n * spec.step + PICK_EPS) return spec.n - 1;
  return -1;
}

function coreRange(values, n) {
  if (!n) return null;
  const s = Float64Array.from(values.subarray(0, n)).sort();
  return [s[Math.floor((n - 1) * HIST_CORE)], s[Math.ceil((n - 1) * (1 - HIST_CORE))]];
}

function doyOf(ms) {
  const d = new Date(ms);
  return CUM_DAYS[d.getUTCMonth()] + d.getUTCDate();
}

function windowDays(startMs, endMs) {
  const out = new Uint8Array(367);
  for (let d = Math.floor(startMs / DAY_MS) * DAY_MS; d <= endMs; d += DAY_MS) {
    out[doyOf(d)] = 1;
  }
  return out;
}

function niceStep(raw) {
  if (!(raw > 0)) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const m of [1, 2, 5, 10]) if (m * mag >= raw) return m * mag;
  return 10 * mag;
}

function cellSize(key) {
  const col = SENSOR_GROUPS[key] ? SENSOR_GROUPS[key].members[0] : key;
  return CELL_SIZE[col] || 0;
}

function fixedSpec(values, key, extra) {
  if (key === HOUR_KEY || isCircularKey(key)) return binSpec(values, key);
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of values) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  for (const r of extra || []) {
    if (!r || !Number.isFinite(r[0]) || !Number.isFinite(r[1])) continue;
    if (r[0] < lo) lo = r[0];
    if (r[1] > hi) hi = r[1];
  }
  if (!(hi >= lo)) return binSpec(values, key);
  const q = quantum(values);
  let step = cellSize(key) || niceStep((hi - lo) / DENSITY_BINS);
  if (q > step) step = q;
  const off = q > 0 && q <= step ? q / 2 : 0;
  for (;;) {
    const k0 = Math.floor((lo + off) / step + PICK_EPS);
    const k1 = Math.floor((hi + off) / step + PICK_EPS);
    const n = k1 - k0 + 1;
    if (n <= CELL_MAX) return { lo: k0 * step - off, step: step, n: Math.max(1, n) };
    step *= 2;
  }
}

function normalsLimits(series, band) {
  const bx = band && band.x;
  if (!bx || bx.length < 2) return null;
  const round = (v) => (v === null || !Number.isFinite(v) ? null : Math.round(v * 10) / 10);
  const lo = new Array(24).fill(Infinity);
  const hi = new Array(24).fill(-Infinity);
  let j = 0;
  for (let i = 0; i < series.n; i++) {
    const t = series.t[i];
    if (t < bx[0] || t > bx[bx.length - 1]) continue;
    while (j < bx.length - 2 && bx[j + 1] < t) j++;
    const a10 = round(band.p10[j]);
    const b10 = round(band.p10[j + 1]);
    const a90 = round(band.p90[j]);
    const b90 = round(band.p90[j + 1]);
    if (a10 === null || b10 === null || a90 === null || b90 === null) continue;
    const f = bx[j + 1] > bx[j] ? (t - bx[j]) / (bx[j + 1] - bx[j]) : 0;
    const p10 = a10 + (b10 - a10) * f;
    const p90 = a90 + (b90 - a90) * f;
    const h = hourOf(t);
    if (p10 < lo[h]) lo[h] = p10;
    if (p90 > hi[h]) hi[h] = p90;
  }
  let min = Infinity;
  let max = -Infinity;
  for (let h = 0; h < 24; h++) {
    if (!Number.isFinite(lo[h]) || !Number.isFinite(hi[h])) {
      lo[h] = NaN;
      hi[h] = NaN;
      continue;
    }
    if (lo[h] < min) min = lo[h];
    if (hi[h] > max) max = hi[h];
  }
  if (!(min <= max)) return null;
  const years = Array.isArray(band.years) && band.years.length === 2 ? band.years : null;
  return {
    kind: "normals",
    lo: lo,
    hi: hi,
    range: [min, max],
    title: years ? `Normals ${years[0]}–${years[1]}` : "Normals",
  };
}

function normalsTraces(norm, spec) {
  const snap = (v, up) => {
    const k = (v - spec.lo) / spec.step;
    return spec.lo + (up ? Math.ceil(k - PICK_EPS) : Math.floor(k + PICK_EPS)) * spec.step;
  };
  const line = { color: HIST_COLOR, width: 1.6, shape: "hv" };
  const make = (vals, up, legend) => {
    const x = [];
    const y = [];
    for (let h = 0; h < 24; h++) {
      x.push(h - 0.5);
      y.push(Number.isFinite(vals[h]) ? snap(vals[h], up) : null);
    }
    x.push(23.5);
    y.push(y[23]);
    return {
      type: "scatter",
      mode: "lines",
      x: x,
      y: y,
      line: line,
      connectgaps: false,
      name: NORMAL_NAME,
      legendgroup: "normals",
      showlegend: legend,
      hoverinfo: "skip",
    };
  };
  return [make(norm.lo, false, true), make(norm.hi, true, false)];
}

function historyPairs(hist, xKey, yKey, days) {
  let x = new Float64Array(Math.max(16, hist.n));
  let y = new Float64Array(x.length);
  let n = 0;
  eachPair(hist, xKey, yKey, (i, a, b) => {
    if (days && !days[doyOf(hist.t[i])]) return;
    if (n === x.length) {
      const nx = new Float64Array(x.length * 2);
      const ny = new Float64Array(x.length * 2);
      nx.set(x);
      ny.set(y);
      x = nx;
      y = ny;
    }
    x[n] = a;
    y[n] = b;
    n++;
  });
  const plain = (key) => key !== HOUR_KEY && !isCircularKey(key);
  return {
    x: x,
    y: y,
    n: n,
    xr: plain(xKey) ? coreRange(x, n) : null,
    yr: plain(yKey) ? coreRange(y, n) : null,
  };
}

function smoothGrid(grid) {
  const ny = grid.length;
  const nx = grid[0].length;
  const pass = (get, rows, cols) => {
    const out = [];
    for (let r = 0; r < rows; r++) {
      const row = new Array(cols);
      for (let c = 0; c < cols; c++) {
        let sum = 2 * get(r, c);
        let w = 2;
        if (c > 0) {
          sum += get(r, c - 1);
          w += 1;
        }
        if (c < cols - 1) {
          sum += get(r, c + 1);
          w += 1;
        }
        row[c] = sum / w;
      }
      out.push(row);
    }
    return out;
  };
  const across = pass((r, c) => grid[r][c], ny, nx);
  const down = pass((r, c) => across[c][r], nx, ny);
  const out = [];
  for (let r = 0; r < ny; r++) {
    const row = new Array(nx);
    for (let c = 0; c < nx; c++) row[c] = down[c][r];
    out.push(row);
  }
  return out;
}

function levelFor(grid, q) {
  const vals = [];
  let sum = 0;
  for (const row of grid) {
    for (const v of row) {
      if (v > 0) {
        vals.push(v);
        sum += v;
      }
    }
  }
  if (!sum) return 0;
  vals.sort((a, b) => b - a);
  let acc = 0;
  for (const v of vals) {
    acc += v;
    if (acc >= q * sum) return v;
  }
  return vals[vals.length - 1];
}

function padded(values, step) {
  return [values[0] - step].concat(values, [values[values.length - 1] + step]);
}

function coarseGrid(hgrid, fx, fy) {
  const ny = Math.ceil(hgrid.length / fy);
  const nx = Math.ceil(hgrid[0].length / fx);
  const out = [];
  for (let r = 0; r < ny; r++) out.push(new Array(nx).fill(0));
  for (let r = 0; r < hgrid.length; r++) {
    const row = out[Math.floor(r / fy)];
    for (let c = 0; c < hgrid[r].length; c++) row[Math.floor(c / fx)] += hgrid[r][c];
  }
  return out;
}

function coarseCentres(spec, f, n) {
  const out = new Array(n);
  for (let k = 0; k < n; k++) {
    const a = k * f;
    const b = Math.min(spec.n, a + f);
    out[k] = spec.lo + ((a + b) / 2) * spec.step;
  }
  return out;
}

function historyTraces(hgrid, cx, cy, xSpec, ySpec) {
  const fx = Math.max(1, Math.ceil(xSpec.n / HIST_GRID));
  const fy = Math.max(1, Math.ceil(ySpec.n / HIST_GRID));
  let smooth = coarseGrid(hgrid, fx, fy);
  for (let k = 0; k < HIST_SMOOTH_PASSES; k++) smooth = smoothGrid(smooth);
  const gx = coarseCentres(xSpec, fx, smooth[0].length);
  const gy = coarseCentres(ySpec, fy, smooth.length);
  const blank = new Array(gx.length + 2).fill(0);
  const z = [blank].concat(smooth.map((row) => [0].concat(row, [0])), [blank]);
  const px = padded(gx, xSpec.step * fx);
  const py = padded(gy, ySpec.step * fy);
  const out = [];
  for (const lv of HIST_LEVELS) {
    const level = levelFor(smooth, lv.q);
    if (!(level > 0)) continue;
    const line = { color: HIST_COLOR, width: lv.width, dash: lv.dash, smoothing: 1.3 };
    out.push({
      type: "contour",
      x: px,
      y: py,
      z: z,
      autocontour: false,
      contours: {
        start: level,
        end: level,
        size: level,
        coloring: "none",
        showlabels: false,
      },
      line: line,
      showscale: false,
      showlegend: false,
      hoverinfo: "skip",
    });
    out.push({
      type: "scatter",
      mode: "lines",
      x: [null],
      y: [null],
      name: lv.name,
      line: line,
      hoverinfo: "skip",
      showlegend: true,
    });
  }
  return out;
}

function densityFigure(series, xKey, yKey, mask, height, ref, axes) {
  if (!xKey || !yKey) return emptyFig("", height);
  const xs = [];
  const ys = [];
  const hit = [];
  eachPair(series, xKey, yKey, (i, x, y) => {
    xs.push(x);
    ys.push(y);
    hit.push(!!(mask && mask[i]));
  });
  if (!xs.length) {
    const rain = RAIN_KEYS.has(xKey) || RAIN_KEYS.has(yKey);
    return emptyFig(
      rain
        ? "No hours in this window have rain > 0 mm."
        : "No hours in this window have both readings.",
      height
    );
  }
  const histOn = !!ref;
  const norm = ref && ref.kind === "normals" && xKey === HOUR_KEY ? ref : null;
  const pairs =
    !norm && ref && ref.state === "ready" && ref.pairs && ref.pairs.n ? ref.pairs : null;
  const xSpec = fixedSpec(xs, xKey, [axes && axes.x, pairs && pairs.xr]);
  const ySpec = fixedSpec(ys, yKey, [
    axes && axes.y,
    pairs && pairs.yr,
    norm && norm.range,
  ]);
  const grid = () => {
    const out = new Array(ySpec.n);
    for (let r = 0; r < ySpec.n; r++) out[r] = new Array(xSpec.n).fill(0);
    return out;
  };
  const counts = grid();
  const picks = grid();
  let peak = 0;
  for (let k = 0; k < xs.length; k++) {
    const r = binOf(ySpec, ys[k]);
    const c = binOf(xSpec, xs[k]);
    counts[r][c] += 1;
    if (hit[k]) picks[r][c] += 1;
    if (counts[r][c] > peak) peak = counts[r][c];
  }

  let hgrid = null;
  let htotal = 0;
  if (pairs) {
    hgrid = grid();
    for (let k = 0; k < pairs.n; k++) {
      const c = cellOf(xSpec, pairs.x[k]);
      const r = cellOf(ySpec, pairs.y[k]);
      if (c < 0 || r < 0) continue;
      hgrid[r][c] += 1;
      htotal += 1;
    }
    if (!htotal) hgrid = null;
  }

  const logOf = (v) => (v ? Math.log10(v) : null);
  const z = counts.map((row) => row.map(logOf));
  const cx = centres(xSpec);
  const cy = centres(ySpec);
  const zmax = Math.max(Math.log10(Math.max(peak, 1)), 0.3);
  const tickvals = [];
  const ticktext = [];
  for (let k = 0; k <= zmax; k++) {
    tickvals.push(k);
    ticktext.push(Math.pow(10, k).toLocaleString("en-US"));
  }

  const xLabel = keyLabel(xKey);
  const yLabel = keyLabel(yKey);
  const xFmt = xKey === HOUR_KEY ? "%{x:.0f}" : "%{x:.1f}";
  const yFmt = yKey === HOUR_KEY ? "%{y:.0f}" : "%{y:.1f}";
  const colorbar = {
    title: { text: "hours", side: "right", font: { size: 11, color: "#57534e" } },
    thickness: 12,
    len: 0.85,
    outlinewidth: 0,
    tickfont: { size: 10, color: "#8a857d" },
    tickvals: tickvals,
    ticktext: ticktext,
  };
  const head = `${xLabel}: ${xFmt}<br>${yLabel}: ${yFmt}<br>`;
  const normHover =
    !!norm && norm.lo.every(Number.isFinite) && xSpec.n === 24 && xSpec.lo === -0.5;
  let hovertemplate = head + "Hours: %{customdata:,.0f}<extra></extra>";
  let custom = (src) => src;
  if (normHover) {
    hovertemplate =
      head +
      "Hours: %{customdata[0]:,.0f}<br>" +
      "P10–P90: %{customdata[1]:.1f} to %{customdata[2]:.1f}<extra></extra>";
    custom = (src) => src.map((row) => row.map((v, c) => [v, norm.lo[c], norm.hi[c]]));
  }
  const base = {
    type: "heatmap",
    x: cx,
    y: cy,
    zmin: 0,
    zmax: zmax,
    zauto: false,
    xgap: 0,
    ygap: 0,
  };
  const data = [];
  if (mask) {
    data.push(
      Object.assign({}, base, {
        z: z,
        colorscale: MUTED_SCALE,
        opacity: MUTED_OPACITY,
        showscale: false,
        hoverinfo: "skip",
      })
    );
    data.push(
      Object.assign({}, base, {
        z: picks.map((row) => row.map(logOf)),
        customdata: custom(picks),
        colorscale: HEAT_SCALE,
        hoverongaps: false,
        hovertemplate: hovertemplate,
        colorbar: colorbar,
      })
    );
  } else {
    data.push(
      Object.assign({}, base, {
        z: z,
        customdata: custom(counts),
        colorscale: HEAT_SCALE,
        hoverongaps: false,
        hovertemplate: hovertemplate,
        colorbar: colorbar,
      })
    );
  }

  const lines = norm
    ? normalsTraces(norm, ySpec)
    : hgrid
      ? historyTraces(hgrid, cx, cy, xSpec, ySpec)
      : [];
  for (const tr of lines) data.push(tr);

  const layout = {
    height: height,
    margin: { l: 60, r: 24, t: histOn ? DENSITY_TOP_HIST : DENSITY_TOP, b: 48 },
    plot_bgcolor: "#ffffff",
    paper_bgcolor: "white",
    font: { size: 11, color: "#57534e", family: FONT_FAMILY },
    xaxis: axisFor(xKey, xLabel, xSpec),
    yaxis: axisFor(yKey, yLabel, ySpec),
    dragmode: "lasso",
    hovermode: "closest",
    showlegend: lines.length > 0,
    hoverlabel: { bgcolor: "white", bordercolor: "#e8e6e3", font: { color: "#26231f" } },
    selections: [],
    uirevision: `${xKey}|${yKey}`,
  };
  if (lines.length) {
    layout.legend = {
      orientation: "h",
      x: 0,
      xanchor: "left",
      y: 1,
      yanchor: "bottom",
      font: { size: 11, color: "#57534e" },
      bgcolor: "rgba(0,0,0,0)",
      itemclick: false,
      itemdoubleclick: false,
    };
    if (norm) {
      layout.legend.title = { text: norm.title, font: { size: 11, color: "#26231f" } };
    } else if (hgrid && ref.series && Array.isArray(ref.series.years)) {
      const [y0, y1] = ref.series.years;
      layout.legend.title = {
        text: y0 === y1 ? `Same dates, ${y0}` : `Same dates, ${y0}–${y1}`,
        font: { size: 11, color: "#26231f" },
      };
    }
  } else if (histOn) {
    const note =
      ref.state === "loading"
        ? "Loading history…"
        : "No history on record for these dates";
    layout.annotations = [
      {
        text: note,
        xref: "paper",
        yref: "paper",
        x: 0,
        y: 1,
        xanchor: "left",
        yanchor: "bottom",
        showarrow: false,
        font: { size: 11, color: "#8a857d" },
      },
    ];
  }
  return { data: data, layout: layout, spec: { x: xSpec, y: ySpec } };
}

function inPolygon(poly, x, y) {
  const px = poly.x;
  const py = poly.y;
  const n = Math.min(px.length, py.length);
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = px[i];
    const yi = py[i];
    const xj = px[j];
    const yj = py[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function lassoOf(ev) {
  const lp = ev && ev.lassoPoints;
  if (!lp || !Array.isArray(lp.x) || !Array.isArray(lp.y)) return null;
  const x = [];
  const y = [];
  const n = Math.min(lp.x.length, lp.y.length);
  for (let i = 0; i < n; i++) {
    const a = Number(lp.x[i]);
    const b = Number(lp.y[i]);
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    x.push(a);
    y.push(b);
  }
  return x.length >= 3 ? { x: x, y: y } : null;
}

function selectedIdx(series, sel) {
  if (!sel || !sel.length) return null;
  const hits = sel.map((c) => {
    const hit = new Uint8Array(series.n);
    eachPair(series, c.xKey, c.yKey, (i, x, y) => {
      if (hit[i]) return;
      const cx = c.spec.x.lo + (binOf(c.spec.x, x) + 0.5) * c.spec.x.step;
      const cy = c.spec.y.lo + (binOf(c.spec.y, y) + 0.5) * c.spec.y.step;
      if (inPolygon(c.poly, cx, cy)) hit[i] = 1;
    });
    return hit;
  });
  const out = [];
  for (let i = 0; i < series.n; i++) {
    if (hits.every((h) => h[i])) out.push(i);
  }
  return out;
}

function ensurePickStyles() {
  if (document.getElementById(PICK_STYLE_ID)) return;
  const st = document.createElement("style");
  st.id = PICK_STYLE_ID;
  st.textContent = [
    ".wx-pick-bar{display:flex;flex-wrap:wrap;align-items:center;gap:6px;",
    "min-height:26px;margin-top:6px;font-size:12px;color:var(--text,#26231f);}",
    ".wx-pick-count{display:inline-flex;align-items:center;gap:6px;font-weight:500;",
    "min-height:26px;box-sizing:border-box;padding:0 3px 0 10px;white-space:nowrap;",
    "border:1px solid var(--line,#e8e6e3);border-radius:999px;background:var(--surface,#fff);}",
    `.wx-pick-ring{width:9px;height:9px;border-radius:50%;border:1.6px solid ${PICK_COLOR};`,
    "box-sizing:border-box;flex:0 0 auto;}",
    ".wx-pick-x{all:unset;display:inline-flex;align-items:center;justify-content:center;",
    "width:20px;height:20px;border-radius:50%;font-size:14px;line-height:1;",
    "color:var(--text-muted,#8a857d);cursor:pointer;}",
    ".wx-pick-x:hover{background:#f3f2ef;color:var(--text,#26231f);}",
    "@media (max-width:768px){.wx-pick-x{width:28px;height:28px;}}",
  ].join("");
  document.head.appendChild(st);
}

function pickedTrace(series, idx, key, yaxis, showlegend) {
  const cols = seriesCols(series, key);
  if (!cols.length || !idx.length) return null;
  const x = [];
  const y = [];
  for (const i of idx) {
    let v = NaN;
    for (const c of cols) {
      if (Number.isFinite(series[c][i])) {
        v = series[c][i];
        break;
      }
    }
    if (!Number.isFinite(v)) continue;
    x.push(isoStamp(series.t[i]));
    y.push(v);
  }
  if (!x.length) return null;
  return {
    type: "scattergl",
    mode: "markers",
    name: PICK_NAME,
    x: x,
    y: y,
    xaxis: "x",
    yaxis: yaxis,
    marker: {
      symbol: "circle-open",
      color: PICK_COLOR,
      size: 8,
      line: { width: 1.6, color: PICK_COLOR },
    },
    hoverinfo: "skip",
    legendgroup: PICK_NAME,
    showlegend: !!showlegend,
  };
}

function node(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
}

function message(body, text) {
  body.innerHTML = "";
  body.appendChild(node("div", "wx-detail-msg", text));
}

function toggleButton(label) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "wx-detail-select";
  btn.style.display = "inline-flex";
  btn.style.alignItems = "center";
  btn.style.gap = "6px";
  btn.style.flex = "0 0 auto";
  const mark = node("span", "wx-grid-mode show");
  mark.style.cursor = "inherit";
  const box = node("span", "box");
  box.innerHTML = CHECK_SVG;
  mark.appendChild(box);
  btn.appendChild(mark);
  btn.appendChild(node("span", null, label));
  return { btn, mark };
}

export async function mount(host, opts) {
  const body = host.querySelector(".wx-detail-body");
  const title = host.querySelector(".wx-detail-head .t");
  if (!body) return;

  primeAlerts(opts);
  loadNormals(opts.station);

  let payload;
  try {
    payload = await load(opts);
  } catch (e) {
    if (!host.isConnected) return;
    if (e && e.code === "NO_DATA")
      message(
        body,
        `No stored data found for ${opts.station}. The alert view and the ` +
          `stored data may be using different station names.`
      );
    else if (e && e.code === "NO_ROWS")
      message(
        body,
        `No observations on record for ${opts.station} in this window.`
      );
    else if (e && e.code === "NO_COLUMNS")
      message(body, `No plottable sensors on record for ${opts.station}.`);
    else {
      console.warn("station detail failed", e);
      message(body, "Could not read the station data.");
    }
    return;
  }
  if (!host.isConnected) return;

  const cols = plotChoices(orderedCols(payload.cols));
  const pref = await preferredCols(opts, cols);
  if (!host.isConnected) return;
  const picked = pickPlotCols(pref, cols);
  let primary = picked.primary;
  let secondary = picked.secondary;

  const kept =
    opts.pick && cols.includes(opts.pick.primary) ? opts.pick : null;
  const startMode = kept && kept.mode === VIEW_DENSITY ? VIEW_DENSITY : VIEW_TIME;
  let startSecondary = null;
  let clauses = [];
  if (kept) {
    primary = kept.primary;
    secondary =
      kept.secondary &&
      kept.secondary !== primary &&
      cols.includes(kept.secondary)
        ? kept.secondary
        : null;
    if (startMode === VIEW_DENSITY) {
      startSecondary =
        kept.secondary === HOUR_KEY || secondary ? kept.secondary : HOUR_KEY;
    }
  }

  let wantMode = startMode;

  const remember = () => {
    host._wxPick = {
      primary: primary,
      secondary: secondary || null,
      mode: wantMode,
    };
  };
  if (kept) remember();

  body.innerHTML = "";
  if (title) title.textContent = payload.name;

  const controls = node("div", "wx-detail-controls");

  const mkSelect = (labelText, value, allowNone) => {
    const wrap = node("div", "wx-detail-control");
    const lab = node("label", null, labelText);
    const sel = document.createElement("select");
    sel.className = "wx-detail-select";
    if (allowNone) {
      const o = document.createElement("option");
      o.value = "";
      o.textContent = "None";
      sel.appendChild(o);
    }
    for (const c of cols) {
      const o = document.createElement("option");
      o.value = c;
      o.textContent = choiceLabel(c);
      sel.appendChild(o);
    }
    sel.value = value || "";
    wrap.appendChild(lab);
    wrap.appendChild(sel);
    controls.appendChild(wrap);
    return sel;
  };

  const selPrimary = mkSelect("Attribute", primary, false);
  const selSecondary = mkSelect("Compare with", secondary, true);

  let mode = VIEW_TIME;
  let pickIdx = selectedIdx(payload.series, clauses);

  const addOption = (sel, value, text) => {
    const o = document.createElement("option");
    o.value = value;
    o.textContent = text;
    sel.appendChild(o);
  };

  const densitySecondary = () => {
    if (!secondary || secondary === primary) secondary = HOUR_KEY;
  };

  const fillSecondary = () => {
    selSecondary.innerHTML = "";
    if (mode === VIEW_DENSITY) {
      addOption(selSecondary, HOUR_KEY, HOUR_LABEL);
      for (const c of cols) {
        if (c !== primary) addOption(selSecondary, c, choiceLabel(c));
      }
    } else {
      addOption(selSecondary, "", "None");
      for (const c of cols) addOption(selSecondary, c, choiceLabel(c));
    }
    selSecondary.value = secondary || "";
  };

  const viewWrap = node("div", "wx-detail-control");
  viewWrap.appendChild(node("label", null, "View"));
  const selView = document.createElement("select");
  selView.className = "wx-detail-select";
  for (const [value, text] of [
    [VIEW_TIME, "Line"],
    [VIEW_DENSITY, "Density"],
  ]) {
    const o = document.createElement("option");
    o.value = value;
    o.textContent = text;
    selView.appendChild(o);
  }
  selView.value = mode;
  viewWrap.appendChild(selView);
  controls.appendChild(viewWrap);

  if (typeof window.ensureGridToggleStyles === "function") {
    window.ensureGridToggleStyles();
  }
  const normalsWrap = node("div", "wx-detail-control");
  normalsWrap.appendChild(node("label", null, "Historical"));
  const normalsRow = node("div");
  normalsRow.style.display = "flex";
  normalsRow.style.alignItems = "stretch";
  normalsRow.style.gap = "6px";
  const normalsToggle = toggleButton("Show");
  const normalsBtn = normalsToggle.btn;
  const normalsMark = normalsToggle.mark;
  normalsRow.appendChild(normalsBtn);
  normalsWrap.appendChild(normalsRow);
  normalsWrap.style.minWidth = "0";
  controls.appendChild(normalsWrap);

  const hasDir = hasReadings(payload.series, ARROW_DIR_COL);
  const arrowsBtn = document.createElement("button");
  arrowsBtn.type = "button";
  arrowsBtn.className = "wx-grid-mode show";
  arrowsBtn.style.alignSelf = "flex-end";
  arrowsBtn.style.minHeight = "28px";
  const arrowsBox = node("span", "box");
  arrowsBox.innerHTML = CHECK_SVG;
  arrowsBtn.appendChild(arrowsBox);
  arrowsBtn.appendChild(node("span", null, "Wind arrows"));
  controls.appendChild(arrowsBtn);

  if (opts.foldHead && title) {
    const head = title.closest(".wx-detail-head");
    const close = head ? head.querySelector("button") : null;
    if (head && close && head.parentNode === host) {
      close.classList.add("wx-detail-close");
      controls.insertBefore(title, controls.firstChild);
      controls.appendChild(close);
      head.remove();
    }
  }

  let normals = null;

  const updateNormalsControl = () => {
    const avail =
      mode === VIEW_DENSITY || anySupported(normals, [primary, secondary]);
    const on = avail && _normalsOn;
    normalsBtn.disabled = !avail;
    normalsMark.className = "wx-grid-mode show" + (on ? " on" : "");
    normalsBtn.setAttribute("aria-pressed", on ? "true" : "false");
    normalsBtn.style.opacity = avail ? "" : "0.4";
    normalsBtn.style.cursor = avail ? "pointer" : "default";
  };
  updateNormalsControl();

  const arrowsAvail = () =>
    mode === VIEW_TIME &&
    hasDir &&
    (primary === ARROW_COL || secondary === ARROW_COL);

  const updateArrowsControl = () => {
    const avail = arrowsAvail();
    const on = avail && _arrowsOn;
    arrowsBtn.style.display = avail ? "" : "none";
    arrowsBtn.className = "wx-grid-mode show" + (on ? " on" : "");
    arrowsBtn.setAttribute("aria-pressed", on ? "true" : "false");
  };
  updateArrowsControl();

  const plot = node("div", "wx-detail-plot");
  plot.style.width = "100%";

  const dplot = node("div", "wx-detail-density");
  dplot.style.width = "100%";
  dplot.style.display = "none";
  let dDrawn = false;
  let dWired = false;

  ensurePickStyles();
  const bar = node("div", "wx-pick-bar");
  bar.style.display = "none";

  const hold = !!kept || !!opts.hold;

  const wait = hold ? node("div", "wx-plot-wait") : null;
  if (wait) {
    wait.appendChild(node("div", "wx-plot-spin"));
    plot.appendChild(wait);
  }

  body.appendChild(controls);
  body.appendChild(plot);
  body.appendChild(dplot);
  body.appendChild(bar);

  const modal = host.querySelector(".wx-detail-modal");
  const capHeight = () => {
    const v =
      typeof opts.maxHeight === "function" ? opts.maxHeight() : opts.maxHeight;
    return Number(v) || 0;
  };
  const heightFor = () => {
    const h = detailHeight(modal, mode === VIEW_DENSITY ? dplot : plot);
    const cap = capHeight();
    return cap ? Math.min(h, cap) : h;
  };
  const densityHeight = () =>
    Math.max(240, heightFor() - (modal ? 0 : PICK_BAR_SPACE));
  const timeHeight = () => (clauses.length ? densityHeight() : heightFor());
  const sizeFor = (target) => (target === dplot ? densityHeight() : timeHeight());
  plot.style.minHeight = heightFor() + "px";
  if (wait) wait.style.height = plot.style.minHeight;

  let alertsPrimary = null;
  let alertsSecondary = null;

  let drawn = false;
  let wired = false;
  let showAlerts = true;

  const toggleAlerts = () => {
    showAlerts = !showAlerts;
    draw();
    return false;
  };

  const onLegend = (ev) => {
    const list = ev && (ev.data || ev.fullData);
    const tr = list ? list[ev.curveNumber] : null;
    if (tr && tr.meta && tr.meta.normals_legend) return false;
    if (tr && tr.name !== ALERTS_NAME) return true;
    return toggleAlerts();
  };

  let shown = null;
  let fitFrame = 0;

  let yHeld = false;
  let selfLayout = 0;

  plot._wxFitY = (view) => {
    const span = view || fullView(plot);
    return shown && span
      ? fitRange(shown.series, shown.primary, span, shown.band1)
      : null;
  };

  const viewRanges = (view) => {
    const out = {};
    let r1 = yHeld
      ? null
      : fitRange(shown.series, shown.primary, view, shown.band1);
    if (r1 && typeof opts.shareY === "function") {
      const shared = opts.shareY(
        shown.primary,
        r1,
        [isoStamp(view[0]), isoStamp(view[1])]
      );
      if (shared) r1 = shared;
    }
    if (r1) out["yaxis.range"] = r1;
    const r2 = shown.secondary
      ? fitRange(shown.series, shown.secondary, view, shown.band2)
      : null;
    if (r2) out["yaxis2.range"] = r2;
    return out;
  };

  const ownRelayout = (update) => {
    selfLayout += 1;
    const done = () => {
      selfLayout = Math.max(0, selfLayout - 1);
    };
    try {
      const p = Plotly.relayout(plot, update);
      if (p && typeof p.then === "function") p.then(done, done);
      else done();
    } catch (e) {
      void e;
      done();
    }
  };

  const refit = () => {
    fitFrame = 0;
    if (!plot.isConnected || !shown) return;
    const view = fullView(plot);
    if (!view) return;
    const update = viewRanges(view);
    if (!Object.keys(update).length) return;
    ownRelayout(update);
  };

  plot._wxSetView = (range) => {
    const span = startView(range);
    if (!span || !shown || !plot._fullLayout || !plot.isConnected) return false;
    const now = fullView(plot);
    if (now && Math.abs(now[0] - span[0]) < 1000 && Math.abs(now[1] - span[1]) < 1000) {
      return false;
    }
    const update = viewRanges(span);
    update["xaxis.autorange"] = false;
    update["xaxis.range"] = [isoStamp(span[0]), isoStamp(span[1])];
    ownRelayout(update);
    return true;
  };

  const onRelayout = (ev) => {
    if (!ev) return;
    if (selfLayout) return;
    let moved = false;
    if (ev["yaxis.autorange"] === false && ev["yaxis.range"]) {
      yHeld = true;
    } else if (ev["yaxis.autorange"] === true) {
      yHeld = false;
      moved = true;
    }
    if (fitFrame) return;
    for (const key of Object.keys(ev)) {
      if (key.indexOf("xaxis.") === 0) {
        moved = true;
        break;
      }
    }
    if (moved) fitFrame = requestAnimationFrame(refit);
  };

  const wire = () => {
    plot.style.minHeight = "";
    if (wired || typeof plot.on !== "function") return;
    wired = true;
    plot.on("plotly_legendclick", onLegend);
    plot.on("plotly_legenddoubleclick", onLegend);
    plot.on("plotly_relayout", onRelayout);
    plot.on("plotly_afterplot", () => tidySlider(plot));
    tidySlider(plot);
    if (typeof window.wireDetailHover === "function") window.wireDetailHover(plot);
  };

  const reportHistorical = () => {
    if (typeof opts.onHistorical !== "function") return;
    const histOn = _normalsOn && anySupported(normals, [primary, secondary]);
    opts.onHistorical(
      histOn ? { startMs: payload.startMs, endMs: payload.endMs } : null
    );
  };

  const drawTime = () => {
    if (!plot.isConnected) return;
    const on = _normalsOn && !!normals;
    const rainPrimary = on && primary === RAIN_COL && supports(normals, RAIN_COL);
    const rainSecondary = on && secondary === RAIN_COL && supports(normals, RAIN_COL);
    let series = payload.series;
    let aPrimary = alertsPrimary;
    let aSecondary = alertsSecondary;
    if (rainPrimary || rainSecondary) {
      series = cumulativeSeries(series, RAIN_COL);
      if (rainPrimary) aPrimary = remapAlerts(aPrimary, series, RAIN_COL);
      if (rainSecondary) aSecondary = remapAlerts(aSecondary, series, RAIN_COL);
    }
    const fig = buildStationDetail(
      series,
      primary,
      secondary || null,
      aPrimary,
      aSecondary,
      showAlerts,
      _arrowsOn && arrowsAvail()
    );
    let band1 = null;
    let band2 = null;
    if (on) {
      band1 = applyNormals(fig, normals, primary, "y", payload.startMs, payload.endMs);
      if (secondary && fig.layout && fig.layout.yaxis2) {
        band2 = applyNormals(fig, normals, secondary, "y2", payload.startMs, payload.endMs);
      }
      let y0 = Infinity;
      let y1 = -Infinity;
      for (const b of [band1, band2]) {
        if (!b || !Array.isArray(b.years) || b.years.length !== 2) continue;
        y0 = Math.min(y0, b.years[0]);
        y1 = Math.max(y1, b.years[1]);
      }
      if (y0 <= y1 && fig.layout) {
        fig.data.push({
          type: "scatter",
          mode: "lines",
          x: [null],
          y: [null],
          fill: "toself",
          fillcolor: RANGE_FILL,
          line: { width: 0 },
          name: y0 === y1 ? `P10-P90, ${y0}` : `P10-P90, ${y0}–${y1}`,
          showlegend: true,
          hoverinfo: "skip",
          meta: { normals_legend: true },
        });
        fig.layout.showlegend = true;
      }
    }
    const ringIdx = pickIdx;
    if (ringIdx && ringIdx.length && Array.isArray(fig.data) && fig.layout) {
      const p1 = pickedTrace(series, ringIdx, primary, "y", true);
      if (p1) fig.data.push(p1);
      if (secondary && fig.layout.yaxis2) {
        const p2 = pickedTrace(series, ringIdx, secondary, "y2", !p1);
        if (p2) fig.data.push(p2);
      }
      if (p1) fig.layout.showlegend = true;
    }
    const kept = drawn
      ? fullView(plot) || currentView(plot)
      : startView(opts.view);
    focusWindow(fig, payload.startMs, payload.endMs, kept);
    const view = kept || [payload.startMs, payload.endMs];
    const hasSecond = !!(secondary && fig.layout.yaxis2);
    shown = {
      series,
      primary,
      secondary: hasSecond ? secondary : null,
      band1,
      band2: hasSecond ? band2 : null,
    };
    const slider = fig.layout.xaxis.rangeslider;
    slider.yaxis = sliderAxis(fig, "y");
    const heldAxis = yHeld && plot._fullLayout ? plot._fullLayout.yaxis : null;
    let r1 =
      heldAxis && Array.isArray(heldAxis.range)
        ? heldAxis.range.slice()
        : fitRange(series, primary, view, band1);
    if (r1 && !heldAxis && typeof opts.shareY === "function") {
      const shared = opts.shareY(primary, r1, fig.layout.xaxis.range);
      if (shared) r1 = shared;
    }
    if (r1) {
      fig.layout.yaxis.range = r1;
      fig.layout.yaxis.autorange = false;
    }
    if (hasSecond) {
      slider.yaxis2 = sliderAxis(fig, "y2");
      const r2 = fitRange(series, secondary, view, band2);
      if (r2) {
        fig.layout.yaxis2.range = r2;
        fig.layout.yaxis2.autorange = false;
      }
    }
    fig.layout.height = timeHeight();
    if (typeof window.quietHoverFigure === "function") window.quietHoverFigure(fig);
    if (drawn) {
      Plotly.react(plot, fig.data, fig.layout, PLOT_CONFIG);
    } else {
      drawn = true;
      if (wait && wait.parentNode) wait.parentNode.removeChild(wait);
      const p = Plotly.newPlot(plot, fig.data, fig.layout, PLOT_CONFIG);
      if (p && p.then) p.then(wire, () => {});
      else wire();
    }
    reportHistorical();
    if (typeof opts.onFit === "function") opts.onFit();
  };

  let dSpec = null;
  let dRedraw = false;
  let dRev = 0;
  let dWaitSeq = 0;
  let dForce = false;
  let dWaitNode = null;
  let dShown = null;
  let hist = null;
  let normalsDone = false;
  let normCache = null;
  let viewCache = null;

  const viewData = () => {
    if (viewCache) return viewCache;
    const span = [payload.startMs, payload.endMs];
    viewCache = {
      series: payload.series,
      offset: 0,
      span: span,
      key: span.join("-"),
      days: windowDays(span[0], span[1]),
    };
    return viewCache;
  };

  const histCols = (keys) => {
    const out = [];
    for (const k of [keys.x, keys.y]) {
      if (k === HOUR_KEY) continue;
      for (const c of choiceCols(k)) if (!out.includes(c)) out.push(c);
    }
    return out.sort();
  };

  const historyFor = (keys, view) => {
    if (!_normalsOn) return null;
    const want = histCols(keys);
    const key = want.join(",");
    if (!hist || hist.key !== key) {
      const mine = { key: key, state: "loading", series: null, pairs: null, pairsKey: "" };
      hist = mine;
      mine.job = historySeries(payload.name, want)
        .catch((e) => {
          console.warn("station history failed", e);
          return null;
        })
        .then((h) => {
          if (hist !== mine) return;
          mine.series = h && h.n ? h : null;
          mine.state = mine.series ? "ready" : "none";
          if (dplot.isConnected && mode === VIEW_DENSITY && _normalsOn) drawDensity();
        });
    }
    if (hist.state === "ready") {
      const pk = keys.x + "|" + keys.y + "|" + view.key;
      if (hist.pairsKey !== pk) {
        hist.pairs = historyPairs(hist.series, keys.x, keys.y, view.days);
        hist.pairsKey = pk;
      }
    }
    return hist;
  };

  const normalsRef = (col, view) => {
    const key = col + "|" + view.key;
    if (normCache && normCache.key === key) return normCache.value;
    const band = bandFor(normals, col, payload.startMs, payload.endMs);
    const value = band ? normalsLimits(view.series, band) : null;
    normCache = { key: key, value: value };
    return value;
  };

  const windowDoys = windowDays(payload.startMs, payload.endMs);

  const stationRange = (key) => {
    if (!normals || !normals.attrs || key === HOUR_KEY || isCircularKey(key)) return null;
    let lo = Infinity;
    let hi = -Infinity;
    for (const c of choiceCols(key)) {
      const a = normals.attrs[c];
      if (!a || !Array.isArray(a.d)) continue;
      const p10 = a.d[1] || [];
      const p90 = a.d[5] || [];
      for (let doy = 1; doy <= 366; doy++) {
        if (!windowDoys[doy]) continue;
        const v10 = p10[doy - 1];
        const v90 = p90[doy - 1];
        if (v10 !== null && Number.isFinite(v10) && v10 < lo) lo = v10;
        if (v90 !== null && Number.isFinite(v90) && v90 > hi) hi = v90;
      }
    }
    return lo <= hi ? [lo, hi] : null;
  };

  const densityRef = (keys, view) => {
    if (!_normalsOn) return null;
    if (keys.x === HOUR_KEY && keys.y !== RAIN_COL && !SENSOR_GROUPS[keys.y]) {
      if (!normalsDone) return { state: "loading", job: normalsJob };
      if (supports(normals, keys.y)) {
        const ref = normalsRef(keys.y, view);
        if (ref) return ref;
      }
    }
    return historyFor(keys, view);
  };

  const setClauses = (next) => {
    clauses = next;
    pickIdx = selectedIdx(payload.series, clauses);
    remember();
    renderBar();
  };

  const pillNode = (text, ring, label, onClear) => {
    const pill = node("span", "wx-pick-count");
    if (ring) pill.appendChild(node("span", "wx-pick-ring"));
    pill.appendChild(node("span", null, text));
    const x = document.createElement("button");
    x.type = "button";
    x.className = "wx-pick-x";
    x.textContent = "\u00d7";
    x.setAttribute("aria-label", label);
    x.addEventListener("click", onClear);
    pill.appendChild(x);
    return pill;
  };

  const renderBar = () => {
    const visible = clauses.length > 0;
    bar.style.display = mode === VIEW_DENSITY || visible ? "flex" : "none";
    bar.style.visibility = visible ? "" : "hidden";
    bar.innerHTML = "";
    if (!visible) return;
    const n = pickIdx ? pickIdx.length : 0;
    bar.appendChild(
      pillNode(
        `${n.toLocaleString("en-US")} hour${n === 1 ? "" : "s"} selected`,
        true,
        "Clear selection",
        () => {
          setClauses([]);
          draw();
        }
      )
    );
  };

  const onSelected = (ev) => {
    if (dRedraw || mode !== VIEW_DENSITY || !secondary || !dSpec) return;
    const poly = lassoOf(ev);
    if (!poly) return;
    const keys = densityKeys(primary, secondary);
    const next = [
      { xKey: keys.x, yKey: keys.y, poly: poly, spec: { x: dSpec.x, y: dSpec.y } },
    ];
    const idx = selectedIdx(payload.series, next);
    if (idx && idx.length) setClauses(next);
    drawDensity();
  };

  const wireDensity = () => {
    if (dWired || typeof dplot.on !== "function") return;
    dWired = true;
    if (typeof window.wireChartHover === "function") window.wireChartHover(dplot);
    dplot.on("plotly_selected", onSelected);
    const clearAll = () => {
      if (dRedraw) return;
      dRev += 1;
      if (clauses.length) setClauses([]);
      drawDensity();
    };
    dplot.on("plotly_deselect", clearAll);
    dplot.on("plotly_doubleclick", clearAll);
  };

  const showDensityWait = () => {
    if (dWaitNode) return;
    dWaitNode = node("div", "wx-plot-wait");
    dWaitNode.appendChild(node("div", "wx-plot-spin"));
    dWaitNode.style.height = densityHeight() + "px";
    dplot.style.minHeight = dWaitNode.style.height;
    dplot.appendChild(dWaitNode);
  };

  const dropDensityWait = () => {
    if (!dWaitNode) return;
    if (dWaitNode.parentNode) dWaitNode.parentNode.removeChild(dWaitNode);
    dWaitNode = null;
    dplot.style.minHeight = "";
  };

  const drawDensity = () => {
    if (!dplot.isConnected) return;
    const keys = densityKeys(primary, secondary);
    const view = viewData();
    const ref = densityRef(keys, view);
    const token = ++dWaitSeq;
    const shownKey = `${keys.x}|${keys.y}|${_normalsOn ? 1 : 0}`;
    if (ref && ref.state === "loading" && ref.job && !dForce) {
      if (dDrawn && dShown !== shownKey) {
        try {
          Plotly.purge(dplot);
        } catch (e) {
          void e;
        }
        dDrawn = false;
        dWired = false;
        dSpec = null;
        dShown = null;
      }
      if (!dDrawn) showDensityWait();
      Promise.race([
        Promise.resolve(ref.job).catch(() => null),
        new Promise((resolve) => setTimeout(resolve, GATE_WAIT_MS)),
      ]).then(() => {
        if (token !== dWaitSeq || !dplot.isConnected || mode !== VIEW_DENSITY) return;
        dForce = true;
        try {
          drawDensity();
        } finally {
          dForce = false;
        }
      });
      return;
    }
    dropDensityWait();
    let mask = null;
    if (clauses.length) {
      mask = new Uint8Array(payload.series.n);
      for (const i of pickIdx || []) mask[i] = 1;
    }
    const fig = densityFigure(
      payload.series,
      keys.x,
      keys.y,
      mask,
      densityHeight(),
      ref,
      { x: stationRange(keys.x), y: stationRange(keys.y) }
    );
    dSpec = fig.spec || null;
    dShown = shownKey;
    if (fig.layout && fig.layout.uirevision) fig.layout.uirevision += "|" + dRev;
    if (typeof window.quietHoverFigure === "function") window.quietHoverFigure(fig);
    const pre = dplot._fullLayout && dplot._fullLayout._preGUI;
    if (pre) {
      for (const k of Object.keys(pre)) {
        if (k.indexOf("selections") === 0) delete pre[k];
      }
    }
    if (dDrawn) {
      dRedraw = true;
      try {
        const p = Plotly.react(dplot, fig.data, fig.layout, DENSITY_CONFIG);
        const done = () => setTimeout(() => { dRedraw = false; }, 0);
        if (p && p.then) p.then(done, done);
        else done();
      } catch (e) {
        void e;
        dRedraw = false;
      }
    } else {
      dDrawn = true;
      const p = Plotly.newPlot(dplot, fig.data, fig.layout, DENSITY_CONFIG);
      if (p && p.then) p.then(wireDensity, () => {});
      else wireDensity();
    }
    reportHistorical();
  };

  const draw = () => {
    if (mode === VIEW_DENSITY) drawDensity();
    else drawTime();
  };

  let seq = 0;
  const syncAlerts = async (paintFirst) => {
    const token = ++seq;
    const wantPrimary = primary;
    const wantSecondary = secondary || null;
    const pending = Promise.all([
      alertsFor(opts, wantPrimary),
      wantSecondary ? alertsFor(opts, wantSecondary) : Promise.resolve(null),
    ]);
    if (paintFirst) {
      alertsPrimary = null;
      alertsSecondary = null;
      draw();
    }
    const [a, b] = await pending;
    if (token !== seq || !plot.isConnected) return;
    alertsPrimary = a;
    alertsSecondary = b;
    draw();
  };

  const normalsJob = loadNormals(payload.name).then((n) => {
    normals = n;
    normalsDone = true;
    normCache = null;
    if (!plot.isConnected) return;
    updateNormalsControl();
    if (mode === VIEW_DENSITY) {
      if (dDrawn) drawDensity();
      return;
    }
    if (_normalsOn && drawn && anySupported(n, [primary, secondary])) draw();
  });

  normalsBtn.addEventListener("click", () => {
    if (normalsBtn.disabled) return;
    _normalsOn = !_normalsOn;
    updateNormalsControl();
    draw();
  });

  arrowsBtn.addEventListener("click", () => {
    if (!arrowsAvail()) return;
    _arrowsOn = !_arrowsOn;
    updateArrowsControl();
    draw();
  });

  const setMode = (next) => {
    if (next === mode) return;
    mode = next;
    wantMode = next;
    selView.value = mode;
    if (mode === VIEW_TIME && secondary === HOUR_KEY) secondary = null;
    if (mode === VIEW_DENSITY) densitySecondary();
    remember();
    fillSecondary();
    renderBar();
    updateNormalsControl();
    updateArrowsControl();
    if (mode === VIEW_DENSITY) {
      plot.style.display = "none";
      dplot.style.display = "";
      draw();
      return;
    }
    dplot.style.display = "none";
    plot.style.display = "";
    syncAlerts(false);
  };

  selView.addEventListener("change", () => setMode(selView.value));

  if (_normalsOn) {
    await Promise.race([
      normalsJob,
      new Promise((resolve) =>
        setTimeout(resolve, hold ? GATE_WAIT_MS : NORMALS_WAIT_MS)
      ),
    ]);
    if (!plot.isConnected) return;
  }

  if (hold && typeof opts.gate === "function") {
    const gate = opts.gate();
    if (gate && typeof gate.then === "function") {
      await Promise.race([
        gate.catch(() => null),
        new Promise((resolve) => setTimeout(resolve, GATE_WAIT_MS)),
      ]);
      if (!plot.isConnected) return;
    }
  }

  renderBar();
  await syncAlerts(!hold);
  if (!plot.isConnected) return;

  if (startMode === VIEW_DENSITY) {
    if (startSecondary) secondary = startSecondary;
    setMode(VIEW_DENSITY);
  }

  let touched = !!kept;

  if (wantsDir(opts, cols) && primary !== "Dir") {
    dirBands(opts).then((hit) => {
      if (!hit || touched || !plot.isConnected) return;
      primary = "Dir";
      secondary = "Wspd";
      yHeld = false;
      selPrimary.value = primary;
      fillSecondary();
      updateNormalsControl();
      updateArrowsControl();
      syncAlerts(true);
    });
  }

  selPrimary.addEventListener("change", () => {
    touched = true;
    primary = selPrimary.value;
    yHeld = false;
    if (mode === VIEW_DENSITY) densitySecondary();
    else if (secondary === primary) secondary = null;
    fillSecondary();
    remember();
    updateNormalsControl();
    updateArrowsControl();
    syncAlerts(true);
  });
  selSecondary.addEventListener("change", () => {
    touched = true;
    secondary = selSecondary.value || null;
    if (mode === VIEW_DENSITY) densitySecondary();
    else if (secondary === primary) secondary = null;
    fillSecondary();
    remember();
    updateNormalsControl();
    updateArrowsControl();
    syncAlerts(true);
  });

  let resizeFrame = 0;
  let lastWidth = 0;

  const applySize = () => {
    const target = mode === VIEW_DENSITY ? dplot : plot;
    if (!target.isConnected || !target._fullLayout) return;
    const w = Math.round(target.clientWidth || 0);
    if (!w) return;
    lastWidth = w;
    const h = sizeFor(target);
    const curW = Math.round((target.layout && target.layout.width) || 0);
    const curH = Math.round((target.layout && target.layout.height) || 0);
    if (Math.abs(curW - w) < 2 && Math.abs(curH - h) < 2) return;
    try {
      const p = Plotly.relayout(target, { width: w, height: h });
      if (p && p.catch) p.catch(() => {});
    } catch (e) {
      void e;
    }
  };

  const onResize = () => {
    if (resizeFrame) return;
    resizeFrame = requestAnimationFrame(() => {
      resizeFrame = 0;
      applySize();
    });
  };

  window.addEventListener("resize", onResize);

  let observer = null;
  if (typeof ResizeObserver === "function") {
    observer = new ResizeObserver(() => {
      const target = mode === VIEW_DENSITY ? dplot : plot;
      const w = Math.round(target.clientWidth || 0);
      if (!w || w === lastWidth) return;
      onResize();
    });
    try {
      observer.observe(plot);
      observer.observe(dplot);
    } catch (e) {
      void e;
      observer = null;
    }
  }

  host._wxCleanup = () => {
    window.removeEventListener("resize", onResize);
    if (observer) {
      try {
        observer.disconnect();
      } catch (e) {
        void e;
      }
    }
    if (resizeFrame) cancelAnimationFrame(resizeFrame);
    resizeFrame = 0;
    try {
      Plotly.purge(plot);
    } catch (e) {
      void e;
    }
    try {
      Plotly.purge(dplot);
    } catch (e) {
      void e;
    }
  };
}

export function clearCache() {
  _seriesCache.clear();
  _alertCache = new WeakMap();
}