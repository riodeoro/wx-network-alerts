const DATA_BASE = (window.WX_DATA_BASE || "./data").replace(/\/+$/, "") + "/";

const BUCKET_BASE = DATA_BASE;
const CONFIG_BASE = DATA_BASE;

const CHART_WINDOWS = [24, 48, 72, 168, 336, 720, 1440, 2160, 4380];

const MOBILE_QUERY = window.matchMedia("(max-width: 768px)");
const isMobile = () => MOBILE_QUERY.matches;

const HEIGHT_BASE_PX = 900;

const HEIGHT_SCALE_MAX = 1.6;

function heightScale() {
  if (isMobile()) return 1;
  const h = window.innerHeight || 0;
  const raw = Math.min(HEIGHT_SCALE_MAX, Math.max(1, h / HEIGHT_BASE_PX));
  return Math.round(raw * 100) / 100;
}

const _taskQueue = [];

const _taskChannel =
  typeof MessageChannel === "function" ? new MessageChannel() : null;

if (_taskChannel) {
  _taskChannel.port1.onmessage = () => {
    const fn = _taskQueue.shift();
    if (fn) fn();
  };
}

function nextTask(fn) {
  if (!_taskChannel) {
    setTimeout(fn, 0);
    return;
  }
  _taskQueue.push(fn);
  _taskChannel.port2.postMessage(0);
}

function afterFrame(fn) {
  requestAnimationFrame(() => nextTask(fn));
}

function afterPaint() {
  return new Promise((resolve) => afterFrame(resolve));
}

function whenIdle(fn, timeout) {
  if (typeof requestIdleCallback === "function") {
    requestIdleCallback(fn, { timeout: timeout });
  } else {
    setTimeout(fn, 32);
  }
}

function inputPending() {
  const s = typeof navigator !== "undefined" ? navigator.scheduling : null;
  if (!s || typeof s.isInputPending !== "function") return false;
  try {
    return s.isInputPending();
  } catch (e) {
    return false;
  }
}

const PREBUILD_HOLD_MS = 1400;

const PREBUILD_RECHECK_MS = 200;

const TAB_INTENT_HOLD_MS = 700;

const FREE_IDLE_TIMEOUT_MS = 1500;

let _prebuildHoldUntil = 0;

function holdPrebuild(msAhead) {
  const until = performance.now() + (msAhead || PREBUILD_HOLD_MS);
  if (until > _prebuildHoldUntil) _prebuildHoldUntil = until;
}

function held() {
  return performance.now() < _prebuildHoldUntil;
}

function whenFree(fn) {
  const attempt = () => {
    const wait = _prebuildHoldUntil - performance.now();
    if (wait > 0) {
      setTimeout(attempt, Math.min(wait + 20, PREBUILD_RECHECK_MS));
      return;
    }
    whenIdle(() => {
      if (held() || inputPending()) {
        attempt();
        return;
      }
      fn();
    }, FREE_IDLE_TIMEOUT_MS);
  };
  attempt();
}

function resolveChartWindow(hours) {
  for (const w of CHART_WINDOWS) if (w >= hours) return w;
  return null;
}

function safeFc(fcName) {
  return fcName.trim().replace(/[^A-Za-z0-9_-]/g, "_");
}

const memCache = new Map();

const rawCache = new Map();

const GL_TRACE_TYPES = {
  scattergl: "scatter",
  scatterpolargl: "scatterpolar",
  heatmapgl: "heatmap",
};

function stripWebgl(bundle) {
  if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)) {
    return bundle;
  }
  for (const key of Object.keys(bundle)) {
    const fig = bundle[key];
    if (!fig || typeof fig !== "object" || !Array.isArray(fig.data)) continue;
    for (const tr of fig.data) {
      if (!tr || typeof tr !== "object") continue;
      const swap = GL_TRACE_TYPES[tr.type];
      if (swap && !(tr.meta && tr.meta.keep_gl)) tr.type = swap;
    }
  }
  return bundle;
}

const inflight = new Map();

function fetchBody(filename) {
  const hit = rawCache.get(filename);
  if (hit) return hit;
  const job = fetch(BUCKET_BASE + filename, { cache: "no-cache" }).then((res) =>
    res.ok ? res.text() : null
  );
  rawCache.set(filename, job);
  job.catch(() => {
    if (rawCache.get(filename) === job) rawCache.delete(filename);
  });
  return job;
}

function warmFile(filename) {
  if (!filename) return;
  if (memCache.has(filename) || inflight.has(filename) || rawCache.has(filename)) {
    return;
  }
  fetchBody(filename).catch(() => null);
}

function fetchShared(filename, parse, onError) {
  if (memCache.has(filename)) return Promise.resolve(memCache.get(filename));
  const hit = inflight.get(filename);
  if (hit) return hit;
  const job = (async () => {
    try {
      const body = await fetchBody(filename);
      const data = body === null ? null : parse(body);
      memCache.set(filename, data);
      return data;
    } catch (e) {
      if (onError) onError(e);
      return null;
    } finally {
      inflight.delete(filename);
      rawCache.delete(filename);
    }
  })();
  inflight.set(filename, job);
  return job;
}

function fetchJson(filename) {
  return fetchShared(
    filename,
    (body) => stripWebgl(JSON.parse(body)),
    (e) => console.warn("fetchJson failed", filename, e)
  );
}

function fetchText(filename) {
  return fetchShared(filename, (body) => body, null);
}

function chartFile(fc, hours, suffix) {
  const w = resolveChartWindow(hours);
  return w === null ? null : `${safeFc(fc)}_${w}h_${suffix}.json`;
}

function textFile(fc, hours, suffix) {
  const w = resolveChartWindow(hours);
  return w === null ? null : `${safeFc(fc)}_${w}h_${suffix}.txt`;
}

function peekCharts(fc, hours, suffix) {
  const file = chartFile(fc, hours, suffix);
  if (file === null) return null;
  const hit = memCache.get(file);
  return hit && typeof hit.then !== "function" ? hit : null;
}

function loadCharts(fc, hours, suffix) {
  const file = chartFile(fc, hours, suffix);
  if (file === null) return Promise.resolve(null);
  return fetchJson(file);
}

function loadText(fc, hours, suffix) {
  const file = textFile(fc, hours, suffix);
  if (file === null) return Promise.resolve(null);
  return fetchText(file);
}

async function extractDateRange(fc, hours) {
  for (const suffix of ["data", "rh", "wind", "temp", "rn1", "power"]) {
    const c = await loadCharts(fc, hours, suffix);
    if (!c) continue;
    if (c._date_min && c._date_max) return [c._date_min, c._date_max];
  }
  return [null, null];
}

function el(tag, className, html) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (html !== undefined) n.innerHTML = html;
  return n;
}

function deepClone(obj) {
  if (typeof structuredClone === "function") {
    try { return structuredClone(obj); } catch (e) {}
  }
  return JSON.parse(JSON.stringify(obj));
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
    return Array.from(new Ctor(bytes.buffer, 0, bytes.byteLength / Ctor.BYTES_PER_ELEMENT));
  } catch (e) {
    return null;
  }
}

function isHeatmap(tr) {
  return !!tr && (tr.type === "heatmap" || tr.type === "heatmapgl");
}

function hoverStation(s) {
  if (typeof s !== "string") return null;
  const m = /^<b>(.*?)<\/b>/.exec(s);
  return m ? m[1].trim() : null;
}

function traceStationLabels(tr) {
  if (!tr || isHeatmap(tr)) return null;
  const txt = decodeArray(tr.text) || decodeArray(tr.hovertext);
  if (!txt || !txt.length) return null;
  const labels = txt.map(hoverStation);
  return labels.some(Boolean) ? labels : null;
}

function heatmapStationRows(tr) {
  const y = decodeArray(tr.y);
  if (!y || !y.length) return null;
  return y.every(v => typeof v === "string") ? y : null;
}

function heatmapDefaultRows(tr) {
  if (!tr || !tr.meta || typeof tr.meta !== "object") return null;
  const rows = tr.meta.default_rows;
  if (!Array.isArray(rows) || !rows.length) return null;
  return rows.every(v => typeof v === "string") ? rows : null;
}

function figureStations(data) {
  const found = new Set();
  for (const tr of data || []) {
    if (isHeatmap(tr)) {
      const rows = heatmapStationRows(tr);
      if (rows) for (const s of rows) found.add(s);
      continue;
    }
    const labels = traceStationLabels(tr);
    if (labels) for (const s of labels) if (s) found.add(s);
  }
  return Array.from(found).sort((a, b) => a.localeCompare(b));
}

function pointArray(v, n) {
  if (v === undefined || v === null) return { skip: true };
  if (Array.isArray(v)) {
    return v.length === n ? { arr: v } : { abort: true };
  }
  if (typeof v === "object") {
    if (typeof v.bdata !== "string") return { skip: true };
    const arr = decodeArray(v);
    if (!arr || arr.length !== n) return { abort: true };
    return { arr: arr };
  }
  return { skip: true };
}

function filterPointTrace(tr, sel) {
  const labels = traceStationLabels(tr);
  if (!labels) return tr;
  const n = labels.length;
  const keep = labels.map(s => !!s && sel.has(s));
  if (keep.every(Boolean)) return tr;

  const take = (arr) => arr.filter((_v, i) => keep[i]);
  const out = Object.assign({}, tr);

  for (const key of ["x", "y", "z", "text", "hovertext", "customdata", "ids"]) {
    const res = pointArray(tr[key], n);
    if (res.abort) return tr;
    if (res.arr) out[key] = take(res.arr);
  }

  if (tr.marker && typeof tr.marker === "object") {
    const marker = Object.assign({}, tr.marker);
    for (const key of ["color", "size", "opacity", "symbol"]) {
      const res = pointArray(marker[key], n);
      if (res.abort) return tr;
      if (res.arr) marker[key] = take(res.arr);
    }
    if (marker.line && typeof marker.line === "object") {
      const line = Object.assign({}, marker.line);
      for (const key of ["color", "width"]) {
        const res = pointArray(line[key], n);
        if (res.abort) return tr;
        if (res.arr) line[key] = take(res.arr);
      }
      marker.line = line;
    }
    out.marker = marker;
  }
  return out;
}

function filterHeatmapTrace(tr, sel) {
  const rows = heatmapStationRows(tr);
  if (!rows) return { trace: tr, rows: null };
  const keep = rows.map(s => sel.has(s));
  const kept = rows.filter((_v, i) => keep[i]);
  if (kept.length === rows.length) return { trace: tr, rows: kept };

  const out = Object.assign({}, tr, { y: kept });
  for (const key of ["z", "text", "hovertext", "customdata"]) {
    const v = tr[key];
    if (v === undefined || v === null) continue;
    if (!Array.isArray(v) || v.length !== rows.length) return { trace: tr, rows: null };
    out[key] = v.filter((_v, i) => keep[i]);
  }
  return { trace: out, rows: kept };
}

function axisLayoutKey(ref, kind) {
  const id = typeof ref === "string" && ref ? ref : kind;
  return (kind === "x" ? "xaxis" : "yaxis") + id.slice(1);
}

function applyStationFilter(fig, sel) {
  const data = (fig && fig.data) || [];
  const layout = (fig && fig.layout) || {};
  const active = sel && sel.size ? sel : null;
  const hasDefaults = data.some(tr => isHeatmap(tr) && heatmapDefaultRows(tr));
  if (!active && !hasDefaults) return { data: data, layout: layout };

  const outData = [];
  const axisPatch = {};

  for (const tr of data) {
    if (isHeatmap(tr)) {
      const rows = heatmapStationRows(tr);
      const defaults = heatmapDefaultRows(tr);
      if (!rows || (!active && !defaults)) {
        outData.push(tr);
        continue;
      }
      const keepSet = active || new Set(defaults);
      const res = filterHeatmapTrace(tr, keepSet);
      if (!res.rows) {
        outData.push(tr);
        continue;
      }
      const ykey = axisLayoutKey(tr.yaxis, "y");
      const xkey = axisLayoutKey(tr.xaxis, "x");
      if (!res.rows.length) {
        axisPatch[ykey] = Object.assign({}, layout[ykey], { visible: false });
        axisPatch[xkey] = Object.assign({}, layout[xkey], { visible: false });
        continue;
      }
      outData.push(res.trace);
      if (layout[ykey] && Array.isArray(layout[ykey].categoryarray)) {
        axisPatch[ykey] = Object.assign({}, layout[ykey], { categoryarray: res.rows });
      }
      continue;
    }
    outData.push(active ? filterPointTrace(tr, active) : tr);
  }

  const outLayout = Object.keys(axisPatch).length
    ? Object.assign({}, layout, axisPatch)
    : layout;

  return { data: outData, layout: outLayout };
}

function ensureStationFilterStyles() {
  if (document.getElementById("wx-stnf-styles")) return;
  const st = document.createElement("style");
  st.id = "wx-stnf-styles";
  st.textContent = [
    ".wx-stnf{position:relative;display:flex;justify-content:flex-end;align-items:center;",
    "z-index:1;}",
    ".wx-stnf.open{z-index:1100;}",
    ".wx-stnf-inline{height:18px;margin:0 0 -4px 0;}",
    ".wx-stnf-float{position:absolute;top:14px;right:8px;}",
    ".wx-stnf-btn{font-family:inherit;font-size:11px;font-weight:500;letter-spacing:.01em;",
    "color:var(--text-muted);background:transparent;border:none;border-radius:0;",
    "padding:0;cursor:pointer;display:inline-flex;align-items:center;gap:4px;",
    "max-width:100%;line-height:1.4;}",
    ".wx-stnf-btn:hover{color:var(--text);}",
    ".wx-stnf-btn.on{color:var(--text);}",
    ".wx-stnf-btn > span:first-child{overflow:hidden;text-overflow:ellipsis;",
    "white-space:nowrap;max-width:190px;}",
    ".wx-stnf-btn .caret{font-size:8px;opacity:.6;flex:0 0 auto;}",
    ".wx-stnf-menu{position:absolute;top:calc(100% + 5px);right:0;width:220px;z-index:1100;",
    "background:var(--surface);border:1px solid var(--line);border-radius:4px;",
    "box-shadow:0 2px 6px rgba(0,0,0,.05);padding:5px;display:none;}",
    ".wx-stnf-menu.open{display:block;}",
    ".wx-stnf-menu .wx-stnf-search{width:100%;box-sizing:border-box;font-family:inherit;",
    "font-size:11px;line-height:1.4;color:var(--text);background:transparent;",
    "border:none;border-bottom:1px solid #f1f0ee;border-radius:0;",
    "padding:3px 6px 6px 6px;margin:0 0 5px 0;}",
    ".wx-stnf-menu .wx-stnf-search::placeholder{color:var(--text-muted);opacity:.6;}",
    ".wx-stnf-menu .wx-stnf-search:focus{outline:none;",
    "border-bottom-color:var(--line);}",
    ".wx-stnf-list{max-height:210px;overflow-y:auto;margin-top:3px;}",
    ".wx-stnf-opt{padding:5px 6px;border-radius:3px;font-size:12px;font-weight:400;",
    "color:var(--text-muted);cursor:pointer;white-space:nowrap;overflow:hidden;",
    "text-overflow:ellipsis;}",
    ".wx-stnf-opt:hover{background:#fafaf9;color:var(--text);}",
    ".wx-stnf-opt.sel{color:var(--text);font-weight:500;background:#f3f2ef;}",
    ".wx-stnf-opt.dis{opacity:.38;cursor:default;}",
    ".wx-stnf-opt.dis:hover{background:transparent;color:var(--text-muted);}",
    ".wx-stnf-sep{height:1px;background:var(--line);margin:5px 2px;}",
    ".wx-stnf-none{padding:6px;font-size:12px;color:var(--text-muted);}",
    "@media (max-width:768px){.wx-stnf-menu{width:210px;}",
    ".wx-stnf-menu .wx-stnf-search{font-size:16px;}.wx-stnf-opt{padding:8px 6px;}",
    ".wx-stnf-btn > span:first-child{max-width:130px;}}",
  ].join("");
  document.head.appendChild(st);
}

function captureView(plotDiv) {
  const full = plotDiv && plotDiv._fullLayout;
  if (!full) return null;

  const skip = new Set();
  for (const tr of plotDiv.data || []) {
    if (!isHeatmap(tr)) continue;
    skip.add(axisLayoutKey(tr.xaxis, "x"));
    skip.add(axisLayoutKey(tr.yaxis, "y"));
  }

  const view = {};
  for (const key of Object.keys(full)) {
    if (/^[xy]axis\d*$/.test(key)) {
      const ax = full[key];
      if (!ax || skip.has(key) || ax.type === "category") continue;
      if (!Array.isArray(ax.range)) continue;
      view[key] = { range: ax.range.slice(), autorange: false };
    } else if (/^scene\d*$/.test(key)) {
      const sc = full[key];
      if (!sc) continue;
      const patch = {};
      if (sc.camera) patch.camera = deepClone(sc.camera);
      for (const ak of ["xaxis", "yaxis", "zaxis"]) {
        const a = sc[ak];
        if (a && Array.isArray(a.range) && a.type !== "category") {
          patch[ak] = { range: a.range.slice(), autorange: false };
        }
      }
      if (Object.keys(patch).length) view[key] = patch;
    }
  }
  return Object.keys(view).length ? view : null;
}

function mergeView(layout, view) {
  if (!view) return layout;
  const out = Object.assign({}, layout);
  for (const key of Object.keys(view)) {
    const patch = view[key];
    if (/^scene\d*$/.test(key)) {
      const scene = Object.assign({}, out[key]);
      for (const pk of Object.keys(patch)) {
        scene[pk] = (pk === "xaxis" || pk === "yaxis" || pk === "zaxis")
          ? Object.assign({}, scene[pk], patch[pk])
          : patch[pk];
      }
      out[key] = scene;
    } else {
      out[key] = Object.assign({}, out[key], patch);
    }
  }
  return out;
}

const NEIGHBOUR_SHOW = "Show neighbours";

const NEIGHBOUR_PALETTE = [
  "#2b9282", "#b1389f", "#66b6dc", "#007830", "#ef8897",
  "#8f1156", "#bfac45", "#9a990f", "#341793",
];

const NEIGHBOUR_LINE_WIDTH = 1.3;

const NEIGHBOUR_LINE_OPACITY = 0.9;

const NEIGHBOUR_MUTED_OPACITY = 0.55;

const OVERLAY_FOCUS_COLOR = "#26231f";

const HIST_LINE_COLOR = "#26231f";

const OVERLAY_FOCUS_WIDTH = 2.2;

const NEIGHBOUR_OVERLAY_ROWS = 1;

const NEIGHBOUR_LEGEND_MARGIN = 24;

const NEIGHBOUR_LEGEND_COLS = 5;

const NEIGHBOUR_LEGEND_ROW_PX = 14;

const OVERLAY_LABEL = "Overlay";

const CUMULATIVE_LABEL = "Cumulative";

const CUMULATIVE_HOVER_RE = /(<\/b><br>[A-Za-z0-9_]+):/;

const CHECK_ICON =
  '<svg viewBox="0 0 12 12" aria-hidden="true" focusable="false">' +
  '<path d="M2.4 6.3 4.8 8.7 9.6 3.5"/></svg>';

const DETAIL_HOVER_TIME = "%m-%d %H:%M";

const DETAIL_HOVER_BG = "white";

const DETAIL_HOVER_BORDER = "#e8e6e3";

const DETAIL_HOVER_TEXT = "#26231f";

const DETAIL_FONT_SIZE = 11;

const DETAIL_FONT_COLOR = "#57534e";

function applyDetailHoverStyle(layout) {
  if (!layout) return layout;
  layout.hovermode = "x unified";
  layout.hoverlabel = {
    bgcolor: DETAIL_HOVER_BG,
    bordercolor: DETAIL_HOVER_BORDER,
    font: { color: DETAIL_HOVER_TEXT },
    align: "left",
  };
  layout.font = Object.assign({}, layout.font, {
    size: DETAIL_FONT_SIZE,
    color: DETAIL_FONT_COLOR,
  });
  for (const key of Object.keys(layout)) {
    if (!/^xaxis\d*$/.test(key)) continue;
    const ax = layout[key];
    if (ax) ax.hoverformat = DETAIL_HOVER_TIME;
  }
  return layout;
}

let _nbGroups = null;

function neighbourKey(name) {
  return String(name == null ? "" : name)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

let _nbCoords = null;

let _nbWarm = null;

function warmNeighbours(done) {
  if (_nbGroups && _nbCoords) {
    if (typeof done === "function") done();
    return;
  }
  if (!_nbWarm) {
    _nbWarm = detailModule()
      .then((m) =>
        Promise.all([
          typeof m.neighbourGroups === "function" ? m.neighbourGroups() : null,
          typeof m.stationCoords === "function" ? m.stationCoords() : null,
        ])
      )
      .then(([map, coords]) => {
        if (map && map.size) _nbGroups = map;
        if (coords && coords.size) _nbCoords = coords;
      })
      .catch(() => {})
      .then(() => {
        _nbWarm = null;
      });
  }
  if (typeof done === "function") _nbWarm.then(done, done);
}

function stationCoord(name) {
  if (!_nbCoords || !name) return null;
  return _nbCoords.get(neighbourKey(name)) || null;
}

function neighboursFor(station, pool) {
  if (!_nbGroups || !station || !pool || !pool.length) return [];
  const ranked = _nbGroups.get(neighbourKey(station));
  if (!ranked || !ranked.length) return [];
  const index = new Map();
  for (const name of pool) {
    const key = neighbourKey(name);
    if (key && !index.has(key)) index.set(key, name);
  }
  const out = [];
  for (const name of ranked) {
    const hit = index.get(neighbourKey(name));
    if (hit) {
      if (out.indexOf(hit) < 0) out.push(hit);
      continue;
    }
    const at = stationCoord(name);
    const far = at && at.fc ? at.name || name : null;
    if (far && out.indexOf(far) < 0) out.push(far);
  }
  return out;
}

function nearbyStations() {
  if (!_nbCoords) return [];
  const out = [];
  for (const at of _nbCoords.values()) {
    if (!at || !at.name || !at.fc || at.enabled === false) continue;
    out.push(at);
  }
  return out;
}

const FC_INITIALS = {
  "Kamloops Fire Centre": "KFC",
  "Northwest Fire Centre": "NWFC",
  "Cariboo Fire Centre": "CaFC",
  "Coastal Fire Centre": "CoFC",
  "Southeast Fire Centre": "SEFC",
  "Prince George Fire Centre": "PGFC",
};

function mapStationName(name) {
  const at = stationCoord(name);
  if (!at || !at.fc || at.fc === state.fc) return name;
  const tag = FC_INITIALS[at.fc];
  return tag ? `${name} (${tag})` : name;
}

function inCurrentFc(name) {
  const at = stationCoord(name);
  return !at || (at.fc || UNASSIGNED_FC) === state.fc;
}

let _candCache = null;

function mapCandidates() {
  const fc = state.fc;
  if (_candCache && _candCache.fc === fc && _candCache.coords === _nbCoords &&
      _candCache.groups === _nbGroups) {
    return _candCache.list;
  }
  const list = nearbyStations().filter((at) => (at.fc || UNASSIGNED_FC) === fc);
  _candCache = { fc: fc, coords: _nbCoords, groups: _nbGroups, list: list };
  return list;
}

function stationFilterControl(stations, onChange, floating, neighbours) {
  ensureStationFilterStyles();

  const selected = new Set();
  const wrap = el("div", "wx-stnf " + (floating ? "wx-stnf-float" : "wx-stnf-inline"));
  const btn = el("button", "wx-stnf-btn");
  btn.type = "button";
  const btnText = el("span");
  const caret = el("span", "caret", "\u25BE");
  btn.appendChild(btnText);
  btn.appendChild(caret);

  const menu = el("div", "wx-stnf-menu");
  const search = el("input", "wx-stnf-search");
  search.type = "text";
  search.placeholder = "Filter stations";

  const allOpt = el("div", "wx-stnf-opt sel", "All stations");

  const nbOpt = neighbours ? el("div", "wx-stnf-opt", NEIGHBOUR_SHOW) : null;
  let nbOn = false;
  let nbPrev = null;
  let nbStation = null;
  let nbOrder = null;
  const nbAdded = new Set();
  const nbRemoved = new Set();

  const nbList = () => {
    if (!neighbours) return [];
    const station = neighbours.focus();
    return station ? neighbours.resolve(station) : [];
  };

  const sep = el("div", "wx-stnf-sep");
  const list = el("div", "wx-stnf-list");
  const empty = el("div", "wx-stnf-none", "No match");
  empty.style.display = "none";

  const rows = [];
  for (const name of stations) {
    const opt = el("div", "wx-stnf-opt");
    opt.textContent = name;
    list.appendChild(opt);
    rows.push({ opt: opt, name: name });
  }
  list.appendChild(empty);

  let open = false;
  let shownCount = null;

  const sync = () => {
    const n = nbOn && shownCount !== null ? shownCount : selected.size;
    if (nbOn && nbAdded.size) {
      btnText.textContent = n === 1 ? "1 station" : `${n} stations`;
    } else if (nbOn) {
      btnText.textContent = n === 1 ? "1 neighbour" : `${n} neighbours`;
    } else {
      btnText.textContent = n === 0
        ? "All stations"
        : (n === 1 ? Array.from(selected)[0] : `${n} stations`);
    }
    btn.className = "wx-stnf-btn" + (n ? " on" : "");
    allOpt.className = "wx-stnf-opt" + (n ? "" : " sel");
    if (nbOpt) {
      nbOpt.textContent = NEIGHBOUR_SHOW;
      nbOpt.style.display = nbOn ? "none" : "";
      const off = !nbList().length;
      nbOpt.className = "wx-stnf-opt" + (off ? " dis" : "");
    }
    for (const r of rows) {
      r.opt.className = "wx-stnf-opt" + (selected.has(r.name) ? " sel" : "");
    }
  };

  const nbCancel = () => {
    nbOn = false;
    nbPrev = null;
    nbStation = null;
    nbOrder = null;
    nbAdded.clear();
    nbRemoved.clear();
  };

  const nbRestore = () => {
    const prev = nbPrev;
    nbCancel();
    selected.clear();
    if (prev) for (const name of prev) selected.add(name);
  };

  const emit = (fresh) => {
    sync();
    onChange(
      selected.size ? new Set(selected) : null,
      nbOn && nbOrder ? nbOrder.slice() : null,
      nbOn ? nbStation : null,
      !!fresh
    );
  };

  const outside = (ev) => {
    if (!wrap.contains(ev.target)) setOpen(false);
  };

  const onKey = (ev) => {
    if (ev.key === "Escape") setOpen(false);
  };

  function setOpen(next) {
    if (open === next) return;
    open = next;
    menu.className = "wx-stnf-menu" + (open ? " open" : "");
    wrap.classList.toggle("open", open);
    caret.textContent = open ? "\u25B4" : "\u25BE";
    if (open && nbOpt) sync();
    if (open) showRows(search.value.trim().toLowerCase());
    if (open) {
      document.addEventListener("mousedown", outside, true);
      document.addEventListener("keydown", onKey, true);
      search.focus();
    } else {
      document.removeEventListener("mousedown", outside, true);
      document.removeEventListener("keydown", onKey, true);
      clearSearch();
    }
  }

  function showRows(q) {
    let shown = 0;
    for (const r of rows) {
      const hit = inCurrentFc(r.name) && (!q || r.name.toLowerCase().indexOf(q) >= 0);
      r.opt.style.display = hit ? "block" : "none";
      if (hit) shown++;
    }
    empty.style.display = shown ? "none" : "block";
  }

  function clearSearch() {
    search.value = "";
    showRows("");
  }

  btn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    setOpen(!open);
  });

  allOpt.addEventListener("click", () => {
    setOpen(false);
    if (!selected.size && !nbOn) return;
    nbCancel();
    selected.clear();
    emit();
  });

  if (nbOpt) {
    nbOpt.addEventListener("click", () => {
      if (nbOn) return;
      const station = neighbours.focus();
      const picks = station ? neighbours.resolve(station) : [];
      if (!picks.length) return;
      setOpen(false);
      nbPrev = new Set(selected);
      nbStation = station;
      nbOrder = picks.slice();
      nbAdded.clear();
      nbRemoved.clear();
      selected.clear();
      for (const name of picks) selected.add(name);
      nbOn = true;
      emit(true);
    });
  }

  for (const r of rows) {
    r.opt.addEventListener("click", () => {
      if (nbOn && wrap._wxNbToggle(r.name)) return;
      if (
        !nbOn && !selected.size && neighbours &&
        typeof neighbours.open === "function"
      ) {
        const now = neighbours.focus();
        if (now && neighbourKey(now) === neighbourKey(r.name)) {
          setOpen(false);
          return;
        }
        if (neighbours.open(r.name)) {
          setOpen(false);
          return;
        }
      }
      nbCancel();
      if (selected.has(r.name)) selected.delete(r.name);
      else selected.add(r.name);
      emit();
    });
  }

  search.addEventListener("input", () => {
    showRows(search.value.trim().toLowerCase());
  });

  menu.appendChild(search);
  menu.appendChild(allOpt);
  if (nbOpt) menu.appendChild(nbOpt);
  menu.appendChild(sep);
  menu.appendChild(list);
  wrap.appendChild(btn);
  wrap.appendChild(menu);
  wrap._wxClear = () => {
    if (nbOn) {
      nbRestore();
      emit();
      return true;
    }
    if (!selected.size) return false;
    selected.clear();
    emit();
    return true;
  };
  wrap._wxNbToggle = (name) => {
    if (!nbOn || !name) return false;
    if (selected.has(name)) {
      if (selected.size <= 1) return false;
      selected.delete(name);
      if (nbAdded.has(name)) nbAdded.delete(name);
      else nbRemoved.add(name);
      nbOrder = (nbOrder || []).filter((n) => n !== name);
    } else {
      selected.add(name);
      if (nbRemoved.has(name)) nbRemoved.delete(name);
      else nbAdded.add(name);
      nbOrder = (nbOrder || []).concat([name]);
    }
    emit();
    return true;
  };
  wrap._wxNbAdded = (name) => nbAdded.has(name);
  wrap._wxNbActive = () => nbOn;
  wrap._wxShown = (n) => {
    const next = Number.isFinite(n) ? n : null;
    if (next === shownCount) return;
    shownCount = next;
    sync();
  };
  wrap._wxNbEdited = () => nbOn && (nbAdded.size > 0 || nbRemoved.size > 0);
  wrap._wxNbExtra = () => nbOn && nbAdded.size > 0;
  wrap._wxNbReset = () => {
    if (!nbOn || !neighbours || !nbStation) return false;
    const picks = neighbours.resolve(nbStation);
    if (!picks.length) return false;
    nbOrder = picks.slice();
    nbAdded.clear();
    nbRemoved.clear();
    selected.clear();
    for (const name of picks) selected.add(name);
    emit();
    return true;
  };
  wrap._wxState = (withNeighbours) => {
    if (nbOn && withNeighbours && nbStation) {
      return {
        selected: Array.from(selected),
        nb: {
          station: nbStation,
          prev: nbPrev ? Array.from(nbPrev) : [],
          added: Array.from(nbAdded),
          removed: Array.from(nbRemoved),
        },
      };
    }
    return { selected: Array.from(selected), nb: null };
  };
  wrap._wxRestore = (st) => {
    if (!st) return false;
    const local = new Set(stations);
    const known = (name) => local.has(name) || !!stationCoord(name);
    nbCancel();
    selected.clear();
    if (st.nb && neighbours) {
      const picks = neighbours.resolve(st.nb.station);
      if (picks.length) {
        nbOn = true;
        nbStation = st.nb.station;
        nbOrder = picks.slice();
        nbPrev = new Set(st.nb.prev.filter((name) => local.has(name)));
        const gone = new Set(st.nb.removed || []);
        for (const name of picks) {
          if (gone.has(name) && picks.length - nbRemoved.size > 1) {
            nbRemoved.add(name);
            continue;
          }
          selected.add(name);
        }
        nbOrder = nbOrder.filter((n) => selected.has(n));
        for (const name of st.nb.added || []) {
          if (selected.has(name) || !known(name)) continue;
          selected.add(name);
          nbAdded.add(name);
          nbOrder.push(name);
        }
        emit();
        return true;
      }
    }
    for (const name of st.selected) if (known(name)) selected.add(name);
    if (!selected.size) return false;
    emit();
    return true;
  };
  let replacePicks = false;
  wrap._wxReplacePicks = () => {
    replacePicks = true;
  };
  wrap._wxNbRetarget = () => {
    const replacing = replacePicks;
    replacePicks = false;
    if (!neighbours) return false;
    if (!nbOn) {
      const focus = neighbours.focus();
      let cleared = false;
      if (focus && selected.size === 1) {
        const only = selected.values().next().value;
        if (neighbourKey(only) === neighbourKey(focus)) {
          selected.clear();
          cleared = true;
        }
      }
      const done = () => {
        if (cleared) emit();
        return cleared;
      };
      if ((selected.size && !replacing) || isMobile()) return done();
      const around = focus ? neighbours.resolve(focus) : [];
      if (!around.length) return done();
      selected.clear();
      nbPrev = new Set();
      nbStation = focus;
      nbOrder = around.slice();
      nbAdded.clear();
      nbRemoved.clear();
      for (const name of around) selected.add(name);
      nbOn = true;
      emit(true);
      return true;
    }
    const station = neighbours.focus();
    if (!station || station === nbStation) return false;
    const picks = neighbours.resolve(station);
    if (!picks.length) {
      nbRestore();
      emit();
      return true;
    }
    nbStation = station;
    nbOrder = picks.slice();
    nbAdded.clear();
    nbRemoved.clear();
    selected.clear();
    for (const name of picks) selected.add(name);
    emit();
    return true;
  };
  sync();
  return wrap;
}

function usedAxisIds(data) {
  const ids = new Set();
  for (const tr of data || []) {
    if (tr.scene) ids.add(tr.scene);
    else if (tr.type === "scatter3d" || tr.type === "surface" || tr.type === "mesh3d") ids.add("scene");
    else ids.add(tr.xaxis || "x");
  }
  return ids;
}

function collectPanels(layout, used) {
  const panels = [];
  const filter = used && used.size ? used : null;
  for (const key of Object.keys(layout)) {
    if (/^xaxis\d*$/.test(key)) {
      const ax = layout[key];
      if (!ax || !Array.isArray(ax.domain)) continue;
      const idx = key === "xaxis" ? "" : key.slice(5);
      let ykey = "yaxis" + idx;
      if (typeof ax.anchor === "string" && /^y\d*$/.test(ax.anchor)) {
        ykey = "yaxis" + ax.anchor.slice(1);
      }
      const ay = layout[ykey];
      if (!ay || !Array.isArray(ay.domain)) continue;
      if (ax.visible === false || ay.visible === false) continue;
      if (filter && !filter.has("x" + idx)) continue;
      panels.push({
        type: "xy",
        xkey: key,
        ykey: ykey,
        axisId: "x" + idx,
        x0: ax.domain[0], x1: ax.domain[1],
        y0: ay.domain[0], y1: ay.domain[1],
      });
    } else if (/^scene\d*$/.test(key)) {
      const sc = layout[key];
      if (!sc || !sc.domain || !Array.isArray(sc.domain.x) || !Array.isArray(sc.domain.y)) continue;
      if (filter && !filter.has(key)) continue;
      panels.push({
        type: "scene",
        skey: key,
        axisId: key,
        x0: sc.domain.x[0], x1: sc.domain.x[1],
        y0: sc.domain.y[0], y1: sc.domain.y[1],
      });
    }
  }
  return panels;
}

function columnStarts(panels) {
  const starts = [];
  for (const p of panels) {
    if (!starts.some(v => Math.abs(v - p.x0) < 0.01)) starts.push(p.x0);
  }
  starts.sort((a, b) => a - b);
  return starts;
}

function legendEntryCount(data) {
  let n = 0;
  for (const tr of data || []) {
    if (tr.showlegend === false) continue;
    if (!tr.name) continue;
    if (tr.type === "heatmap" || tr.type === "heatmapgl") continue;
    n++;
  }
  return n;
}

function colorbarTraces(data) {
  const out = [];
  for (const tr of data || []) {
    if (tr.showscale === true || (tr.colorbar && tr.showscale !== false)) out.push(tr);
  }
  return out;
}

function remapPoint(x, y, from, to) {
  const fx = (from.x1 - from.x0) || 1;
  const fy = (from.y1 - from.y0) || 1;
  return [
    to.x0 + ((x - from.x0) / fx) * (to.x1 - to.x0),
    to.y0 + ((y - from.y0) / fy) * (to.y1 - to.y0),
  ];
}

function panelIndexForPoint(boxes, x, y) {
  const pad = 0.05;
  let above = -1;
  let aboveGap = Infinity;
  let inside = -1;
  let insideDist = Infinity;
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i];
    if (x < b.x0 - pad || x > b.x1 + pad) continue;
    if (y >= b.y1 - 0.001) {
      const gap = y - b.y1;
      if (gap < aboveGap) { aboveGap = gap; above = i; }
    } else if (y >= b.y0 - pad) {
      const d = Math.abs(y - (b.y0 + b.y1) / 2);
      if (d < insideDist) { insideDist = d; inside = i; }
    }
  }
  if (above >= 0 && aboveGap <= 0.12) return above;
  if (inside >= 0) return inside;
  return above;
}

function tuneFonts(layout, panelCount) {
  layout.font = Object.assign({}, layout.font, { size: 11 });

  if (layout.title) {
    const t = typeof layout.title === "string" ? { text: layout.title } : Object.assign({}, layout.title);
    t.font = Object.assign({}, t.font, { size: 12 });
    t.x = 0;
    t.xanchor = "left";
    t.xref = "paper";
    t.y = 1;
    t.yanchor = "top";
    t.yref = "container";
    t.pad = { t: 6, l: 0, r: 0, b: 0 };
    t.automargin = true;
    layout.title = t;
  }

  for (const key of Object.keys(layout)) {
    if (!/^[xy]axis\d*$/.test(key)) continue;
    const ax = layout[key];
    if (!ax) continue;
    const size = (ax.tickfont && ax.tickfont.size) || 10;
    ax.tickfont = Object.assign({}, ax.tickfont, { size: Math.min(size, 9) });
    if (panelCount <= 6) ax.automargin = true;
    if (ax.title) {
      const at = typeof ax.title === "string" ? { text: ax.title } : Object.assign({}, ax.title);
      at.font = Object.assign({}, at.font, { size: 10 });
      if (key.charAt(0) === "x") at.standoff = 14;
      ax.title = at;
    }
  }

  if (Array.isArray(layout.annotations)) {
    for (const a of layout.annotations) {
      const size = (a.font && a.font.size) || 11;
      a.font = Object.assign({}, a.font, { size: Math.min(size, 12) });
    }
  }
}

function applyLegend(layout) {
  const legend = Object.assign({}, layout.legend);
  legend.orientation = "h";
  legend.x = 0;
  legend.xanchor = "left";
  legend.y = 1;
  legend.yanchor = "bottom";
  legend.font = Object.assign({}, legend.font, { size: 9 });
  legend.entrywidth = 0.5;
  legend.entrywidthmode = "fraction";
  legend.tracegroupgap = 3;
  layout.legend = legend;
}

function applyColorbars(fig, panels, bottomPanel, plotAreaPx) {
  let needsRoom = false;
  const offset = Math.min(0.35, 66 / Math.max(plotAreaPx, 120));
  for (const tr of colorbarTraces(fig.data)) {
    const axisId = tr.xaxis || "x";
    const panel = panels.find(p => p.axisId === axisId) || bottomPanel;
    const old = tr.colorbar || {};
    const titleText = typeof old.title === "string" ? old.title : (old.title && old.title.text) || "";
    const bar = {
      orientation: "h",
      x: 0.5,
      xanchor: "center",
      len: 0.75,
      thickness: 10,
      tickfont: { size: 8 },
      outlinewidth: 0,
    };
    if (old.tickformat) bar.tickformat = old.tickformat;
    if (old.tickvals) bar.tickvals = old.tickvals;
    if (titleText) bar.title = { text: titleText, side: "top", font: { size: 9 } };

    const atBottom = panel && bottomPanel && panel.axisId === bottomPanel.axisId;
    if (!panel || atBottom) {
      bar.y = (panel ? panel.y0 : 0) - offset;
      bar.yanchor = "top";
      needsRoom = true;
    } else {
      bar.y = panel.y1 + 0.015;
      bar.yanchor = "bottom";
    }
    tr.colorbar = bar;
  }
  return needsRoom;
}

function buildMobileFigure(figDict, opts) {
  const fig = deepClone(figDict);
  const layout = fig.layout || (fig.layout = {});
  const origHeight = opts.height || layout.height || 420;
  const origMargin = Object.assign({ l: 50, r: 50, t: 60, b: 60 }, layout.margin);

  delete layout.width;
  layout.autosize = true;
  layout.dragmode = false;
  for (const key of Object.keys(layout)) {
    if (/^scene\d*$/.test(key) && layout[key]) layout[key].dragmode = false;
  }

  const panels = collectPanels(layout, usedAxisIds(fig.data));
  const cols = columnStarts(panels);
  const canReflow = panels.length > 1 && cols.length > 1;

  const entries = layout.showlegend === false ? 0 : legendEntryCount(fig.data);
  const legendRows = entries > 0 ? Math.min(4, Math.ceil(entries / 2)) : 0;
  if (legendRows) applyLegend(layout);

  tuneFonts(layout, panels.length || 1);

  const titleText = layout.title && layout.title.text ? String(layout.title.text) : "";
  const titleLines = titleText
    ? Math.min(3, Math.max(1, Math.ceil(titleText.replace(/<[^>]*>/g, "").length / 42)))
    : 0;
  const titlePx = titleLines ? 10 + titleLines * 16 : 0;
  const legendPx = legendRows ? legendRows * 15 + 10 : 0;
  const subplotTitlePx = (canReflow && Array.isArray(layout.annotations) && layout.annotations.length) ? 16 : 0;
  const marginTop = Math.max(14, titlePx + legendPx + subplotTitlePx);
  const marginLeft = Math.max(38, Math.min(origMargin.l, 52));
  const marginRight = 12;
  let marginBottom = 56;

  let height;
  let ordered = panels;
  let bottomPanel = null;

  if (canReflow) {
    ordered = panels.slice().sort((a, b) => {
      const ca = cols.findIndex(v => Math.abs(v - a.x0) < 0.01);
      const cb = cols.findIndex(v => Math.abs(v - b.x0) < 0.01);
      if (ca !== cb) return ca - cb;
      return b.y0 - a.y0;
    });

    const boxes = ordered.map(p => ({ x0: p.x0, x1: p.x1, y0: p.y0, y1: p.y1 }));
    const plotArea = Math.max(80, origHeight - origMargin.t - origMargin.b);
    const baseCell = Math.max.apply(null, ordered.map(p => plotArea * (p.y1 - p.y0)));
    const n = ordered.length;

    let cellPx;
    let gapPx;
    if (baseCell < 140) {
      cellPx = n > 10 ? 44 : Math.max(48, Math.min(baseCell, 62));
      gapPx = n > 10 ? 10 : 14;
    } else {
      cellPx = n >= 3 ? 320 : Math.max(300, Math.min(baseCell, 420));
      const rotated = ordered.slice(0, -1).some(p => {
        const ax = p.type === "xy" ? layout[p.xkey] : null;
        return !!(ax && ax.tickangle);
      });
      gapPx = rotated ? 120 : 90;
    }

    const plotPx = n * cellPx + (n - 1) * gapPx;
    const step = (cellPx + gapPx) / plotPx;
    const cellFrac = cellPx / plotPx;

    ordered.forEach((p, i) => {
      p.newY1 = 1 - i * step;
      p.newY0 = p.newY1 - cellFrac;
      p.newX0 = 0;
      p.newX1 = 1;
    });

    if (Array.isArray(layout.annotations)) {
      for (const a of layout.annotations) {
        if (a.xref !== "paper" || a.yref !== "paper") continue;
        if (typeof a.x !== "number" || typeof a.y !== "number") continue;
        const idx = panelIndexForPoint(boxes, a.x, a.y);
        if (idx < 0) continue;
        const p = ordered[idx];
        const to = { x0: p.newX0, x1: p.newX1, y0: p.newY0, y1: p.newY1 };
        const pt = remapPoint(a.x, a.y, boxes[idx], to);
        a.x = pt[0];
        a.y = pt[1];
      }
    }

    if (Array.isArray(layout.shapes)) {
      for (const s of layout.shapes) {
        if (s.xref !== "paper" || s.yref !== "paper") continue;
        const sx0 = Math.min(s.x0, s.x1);
        const sx1 = Math.max(s.x0, s.x1);
        const sy0 = Math.min(s.y0, s.y1);
        const sy1 = Math.max(s.y0, s.y1);
        const hits = [];
        for (let i = 0; i < boxes.length; i++) {
          const b = boxes[i];
          const cx = (b.x0 + b.x1) / 2;
          const cy = (b.y0 + b.y1) / 2;
          if (cx >= sx0 && cx <= sx1 && cy >= sy0 && cy <= sy1) hits.push(ordered[i]);
        }
        if (!hits.length) continue;
        s.x0 = 0;
        s.x1 = 1;
        s.y0 = Math.max(0, Math.min.apply(null, hits.map(p => p.newY0)) - 0.004);
        s.y1 = Math.min(1, Math.max.apply(null, hits.map(p => p.newY1)) + 0.004);
      }
    }

    for (const p of ordered) {
      if (p.type === "xy") {
        layout[p.xkey].domain = [p.newX0, p.newX1];
        layout[p.ykey].domain = [p.newY0, p.newY1];
      } else {
        layout[p.skey].domain = { x: [p.newX0, p.newX1], y: [p.newY0, p.newY1] };
      }
      p.x0 = p.newX0;
      p.x1 = p.newX1;
      p.y0 = p.newY0;
      p.y1 = p.newY1;
    }

    height = plotPx + marginTop + marginBottom;
    bottomPanel = ordered[ordered.length - 1];
  } else {
    height = Math.round(Math.max(origHeight, 300) * 1.15);
    if (panels.length === 1) {
      const p = panels[0];
      const box = { x0: p.x0, x1: p.x1, y0: p.y0, y1: p.y1 };
      if (box.x0 > 0.001 || box.x1 < 0.999 || box.y0 > 0.001 || box.y1 < 0.999) {
        const to = { x0: 0, x1: 1, y0: 0, y1: 1 };
        if (Array.isArray(layout.annotations)) {
          for (const a of layout.annotations) {
            if (a.xref !== "paper" || a.yref !== "paper") continue;
            if (typeof a.x !== "number" || typeof a.y !== "number") continue;
            const pt = remapPoint(a.x, a.y, box, to);
            a.x = pt[0];
            a.y = pt[1];
          }
        }
        if (Array.isArray(layout.shapes)) {
          for (const sh of layout.shapes) {
            if (sh.xref !== "paper" || sh.yref !== "paper") continue;
            const p0 = remapPoint(sh.x0, sh.y0, box, to);
            const p1 = remapPoint(sh.x1, sh.y1, box, to);
            sh.x0 = p0[0]; sh.y0 = p0[1];
            sh.x1 = p1[0]; sh.y1 = p1[1];
          }
        }
        if (p.type === "xy") {
          layout[p.xkey].domain = [0, 1];
          layout[p.ykey].domain = [0, 1];
        } else {
          layout[p.skey].domain = { x: [0, 1], y: [0, 1] };
        }
        p.x0 = 0; p.x1 = 1; p.y0 = 0; p.y1 = 1;
      }
    }
    bottomPanel = panels.length
      ? panels.reduce((a, b) => (a.y0 <= b.y0 ? a : b))
      : null;
  }

  const plotAreaPx = Math.max(120, height - marginTop - marginBottom);
  if (applyColorbars(fig, ordered, bottomPanel, plotAreaPx)) {
    marginBottom += 84;
    height += 84;
  }

  layout.margin = { l: marginLeft, r: marginRight, t: marginTop, b: marginBottom };
  layout.height = Math.round(height);

  return fig;
}

function traceHidden(tr) {
  return !!tr && (tr.visible === false || tr.visible === "legendonly");
}

function legendStationSet(data) {
  const found = new Set();
  let labeled = 0;
  let hidden = 0;
  for (const tr of data || []) {
    if (isHeatmap(tr)) continue;
    const labels = traceStationLabels(tr);
    if (!labels) continue;
    labeled++;
    if (traceHidden(tr)) {
      hidden++;
      continue;
    }
    for (const s of labels) if (s) found.add(s);
  }
  if (!labeled || !hidden) return null;
  return found;
}

function sameRows(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function prepareScorecards(filtered, source) {
  const data = [];
  const layout = Object.assign({}, (filtered && filtered.layout) || {});
  const cards = [];
  const srcByAxis = new Map();
  for (const tr of source || []) {
    if (!isHeatmap(tr) || !heatmapStationRows(tr)) continue;
    const key = (tr.yaxis || "y") + "|" + (tr.xaxis || "x");
    if (!srcByAxis.has(key)) srcByAxis.set(key, tr);
  }
  ((filtered && filtered.data) || []).forEach((tr, i) => {
    if (!isHeatmap(tr) || !heatmapStationRows(tr)) {
      data.push(tr);
      return;
    }
    data.push(deepClone(tr));
    const ykey = axisLayoutKey(tr.yaxis, "y");
    const ax = layout[ykey];
    let catKey = null;
    if (ax && Array.isArray(ax.categoryarray)) {
      layout[ykey] = deepClone(ax);
      catKey = ykey + ".categoryarray";
    }
    const key = (tr.yaxis || "y") + "|" + (tr.xaxis || "x");
    const full = source ? (srcByAxis.get(key) || tr) : tr;
    cards.push({
      index: i,
      trace: deepClone(full),
      catKey: catKey,
      defaults: source ? heatmapDefaultRows(full) : null,
    });
  });
  return { data: data, layout: layout, cards: cards };
}

function pointStats(data) {
  const stats = new Map();
  let usable = false;
  for (const tr of data || []) {
    if (isHeatmap(tr) || traceHidden(tr)) continue;
    const labels = traceStationLabels(tr);
    if (!labels) continue;
    const rates = decodeArray(tr.customdata);
    if (!rates || rates.length !== labels.length) continue;
    usable = true;
    const flagged = !!(tr.meta && tr.meta.scorecard_flag);
    for (let i = 0; i < labels.length; i++) {
      const stn = labels[i];
      const v = Number(rates[i]);
      if (!stn || !isFinite(v)) continue;
      let s = stats.get(stn);
      if (!s) {
        s = { peak_pos: 0, peak_neg: 0, flag_count: 0, total: 0 };
        stats.set(stn, s);
      }
      s.total++;
      if (flagged) s.flag_count++;
      if (v > s.peak_pos) s.peak_pos = v;
      if (v < s.peak_neg) s.peak_neg = v;
    }
  }
  return usable ? stats : null;
}

function metricValue(stat, kind) {
  if (kind === "peak_pos") return stat.peak_pos;
  if (kind === "peak_neg") return stat.peak_neg;
  if (kind === "flag_count") return stat.flag_count;
  return 0;
}

function metricText(value, kind) {
  if (!value) return "";
  if (kind === "flag_count") return String(Math.round(value));
  const n = Math.round(value);
  return kind === "peak_pos" && n > 0 ? "+" + n : String(n);
}

function rebuildScorecard(src, stats, rows) {
  const kinds = src && src.meta && src.meta.metric_kinds;
  if (!Array.isArray(kinds) || !kinds.length) return null;
  if (src.hovertext !== undefined || src.customdata !== undefined) return null;

  const keep = rows.filter(stn => stats.has(stn));
  keep.sort((a, b) => {
    const sa = stats.get(a);
    const sb = stats.get(b);
    const ma = Math.max(Math.abs(sa.peak_pos), Math.abs(sa.peak_neg));
    const mb = Math.max(Math.abs(sb.peak_pos), Math.abs(sb.peak_neg));
    if (mb !== ma) return mb - ma;
    if (sb.flag_count !== sa.flag_count) return sb.flag_count - sa.flag_count;
    if (sb.total !== sa.total) return sb.total - sa.total;
    return a.localeCompare(b);
  });

  const z = [];
  const text = [];
  for (const stn of keep) {
    const s = stats.get(stn);
    const zRow = [];
    const tRow = [];
    for (const kind of kinds) {
      const v = metricValue(s, kind);
      zRow.push(Math.abs(v));
      tRow.push(metricText(v, kind));
    }
    z.push(zRow);
    text.push(tRow);
  }
  return { rows: keep, z: z, text: text };
}

function sameCells(a, b) {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const ra = a[i];
    const rb = b[i];
    if (Array.isArray(ra) !== Array.isArray(rb)) return false;
    if (Array.isArray(ra)) {
      if (ra.length !== rb.length) return false;
      for (let j = 0; j < ra.length; j++) if (String(ra[j]) !== String(rb[j])) return false;
    } else if (String(ra) !== String(rb)) {
      return false;
    }
  }
  return true;
}

const SCORECARD_ROW_MIN_PX = 22;

function scorecardRowBudget(pd, tr) {
  if (!pd || !pd._fullLayout) return Infinity;
  const ax = pd._fullLayout[axisLayoutKey(tr.yaxis, "y")];
  const len = ax && ax._length;
  if (!len || !isFinite(len)) return Infinity;
  return Math.max(1, Math.floor(len / SCORECARD_ROW_MIN_PX));
}

function truncateScorecard(next, budget) {
  if (!next || !Array.isArray(next.rows)) return next;
  if (!isFinite(budget) || next.rows.length <= budget) return next;
  if (next.z !== undefined && !Array.isArray(next.z)) return next;
  if (next.text !== undefined && !Array.isArray(next.text)) return next;
  const cut = (arr) => (Array.isArray(arr) ? arr.slice(0, budget) : arr);
  const out = { rows: next.rows.slice(0, budget) };
  if (next.z !== undefined) out.z = cut(next.z);
  if (next.text !== undefined) out.text = cut(next.text);
  if (next.source) {
    const src = {};
    for (const key of ["hovertext", "customdata"]) {
      const v = next.source[key];
      if (v === undefined) continue;
      if (!Array.isArray(v)) return next;
      src[key] = cut(v);
    }
    out.source = src;
  }
  return out;
}

function scorecardUpdates(cards, current, pd) {
  const sel = legendStationSet(current);
  const stats = sel ? pointStats(current) : null;
  const jobs = [];
  const layoutPatch = {};
  for (const card of cards || []) {
    const src = card.trace;
    const rows = heatmapStationRows(src);
    if (!rows) continue;

    let next = stats ? rebuildScorecard(src, stats, rows) : null;
    if (!next) {
      const keepSet = sel || (card.defaults ? new Set(card.defaults) : null);
      const res = keepSet
        ? filterHeatmapTrace(src, keepSet)
        : { trace: src, rows: rows };
      if (!res.rows) continue;
      next = {
        rows: res.rows,
        z: res.trace.z,
        text: res.trace.text,
        source: res.trace,
      };
    }

    next = truncateScorecard(next, scorecardRowBudget(pd, src));

    const cur = current && current[card.index];
    if (cur && sameRows(heatmapStationRows(cur), next.rows) && sameCells(cur.text, next.text)) {
      continue;
    }

    const upd = { y: [next.rows.slice()] };
    if (next.z !== undefined) upd.z = [deepClone(next.z)];
    if (next.text !== undefined) upd.text = [deepClone(next.text)];
    if (next.source) {
      for (const key of ["hovertext", "customdata"]) {
        if (next.source[key] !== undefined) upd[key] = [deepClone(next.source[key])];
      }
    }
    jobs.push({ index: card.index, update: upd });
    if (card.catKey) layoutPatch[card.catKey] = next.rows.slice();
  }
  return { jobs: jobs, layout: layoutPatch };
}

const FIT_ROW_MAX_PX = 60;
const FIT_CBAR_MIN_PX = 70;
const FIT_CBAR_MAX_PX = 240;

function fitRowAxis(pd) {
  const fl = pd._fullLayout;
  if (!fl || !fl.yaxis || fl.yaxis2) return;
  const ya = fl.yaxis;
  const len = ya._length;
  if (!len || len < 60) return;

  let n = 0;
  if (ya.type === "category") {
    n = (ya._categories && ya._categories.length) || 0;
  } else if (Array.isArray(ya.tickvals)) {
    n = ya.tickvals.length;
  }
  if (!n || n > 60) return;

  const reversed = Array.isArray(ya.range) && ya.range[0] > ya.range[1];
  const key = n + "|" + Math.round(len) + "|" + (reversed ? 1 : 0);
  if (pd._wxRowFit === key) return;
  pd._wxRowFit = key;

  const slots = Math.max(n, len / FIT_ROW_MAX_PX);
  const pad = (slots - n) / 2;
  const lo = -0.5 - pad;
  const hi = n - 0.5 + pad;
  try {
    Plotly.relayout(pd, { "yaxis.range": reversed ? [hi, lo] : [lo, hi] });
  } catch (e) {}
}

function fitColorbars(pd) {
  const fl = pd._fullLayout;
  if (!fl) return;
  const ya = fl.yaxis;
  const len = (ya && ya._length) || fl.height;
  if (!len) return;

  const idx = [];
  (pd.data || []).forEach((tr, i) => {
    if (tr && tr.colorbar) idx.push(i);
  });
  if (!idx.length) return;

  const target = Math.round(Math.max(
    FIT_CBAR_MIN_PX,
    Math.min(len * 0.92, FIT_CBAR_MAX_PX)
  ));
  const key = target + "|" + idx.join(",");
  if (pd._wxCbarFit === key) return;
  pd._wxCbarFit = key;

  try {
    Plotly.restyle(pd, {
      "colorbar.lenmode": "pixels",
      "colorbar.len": target,
      "colorbar.y": 0.5,
      "colorbar.yanchor": "middle",
    }, idx);
  } catch (e) {}
}

const TICK_OVERHANG_PAD = 8;

function settleAngledTicks(pd) {
  if (pd._wxTickFix) return;
  const fl = pd._fullLayout;
  if (!fl || !fl.xaxis) return;
  const xa = fl.xaxis;
  if (xa.type !== "category" || !xa.tickangle) return;
  pd._wxTickFix = true;
  if (xa.automargin === "bottom") return;
  if (!plotRoomy(pd)) return;
  const size = fl._size || {};
  const r = Math.max(
    (fl.margin && fl.margin.r) || 0,
    (size.r || 0) + TICK_OVERHANG_PAD
  );
  try {
    Plotly.relayout(pd, { "xaxis.automargin": "bottom", "margin.r": r });
  } catch (e) {}
}

const PLOT_AREA_MIN = 24;

function plotFloor(pd) {
  const m = pd && pd._fullLayout && pd._fullLayout.margin;
  if (!m) return PLOT_AREA_MIN;
  return Math.round((m.t || 0) + (m.b || 0)) + PLOT_AREA_MIN;
}

function plotRoomy(pd) {
  if (!pd || !pd._fullLayout || !pd.isConnected) return false;
  if (!pd.clientWidth) return false;
  return pd.clientHeight >= plotFloor(pd);
}

function fitPlot(pd) {
  if (!pd || !pd._wxDrawn || !plotRoomy(pd)) return;
  fitRowAxis(pd);
  fitColorbars(pd);
}

function paneIsActive(node) {
  const pane = node && node.closest ? node.closest(".tab-pane") : null;
  return !pane || pane.classList.contains("active");
}

function settlePlot(pd) {
  if (!pd || !pd._wxSettlePending) return;
  pd._wxSettlePending = false;
  if (!pd.isConnected) return;
  settleAngledTicks(pd);
  syncSize(pd);
  fitPlot(pd);
}

function needsResize(pd) {
  if (!plotRoomy(pd)) return false;
  const w = pd.clientWidth;
  const h = pd.clientHeight;
  return (
    Math.abs(Math.round(pd._fullLayout.width || 0) - w) > 1 ||
    Math.abs(Math.round(pd._fullLayout.height || 0) - h) > 1
  );
}

function syncSize(pd) {
  if (!needsResize(pd)) return false;
  const lay = pd.layout;
  if (lay && lay.width && lay.height) return false;
  if (pd._redrawTimer) {
    clearTimeout(pd._redrawTimer);
    pd._redrawTimer = null;
  }
  if (lay) {
    delete lay.width;
    delete lay.height;
  }
  try {
    const p = Plotly.relayout(pd, { autosize: true });
    if (p && typeof p.catch === "function") p.catch(() => {});
  } catch (e) {
    void e;
  }
  return true;
}

const MOUNT_BUDGET_MS = 8;

const MOUNT_MARGIN_PX = 700;

const MOUNT_IDLE_MS = 250;

const MOUNT_ORPHAN_MS = 20000;

const _mountQueue = [];

let _mountFront = false;

let _mountPoll = 0;

let _mountKick = 0;

function mountRank(job) {
  const pane = job.node.closest ? job.node.closest(".tab-pane") : null;
  if (!pane) return 0;
  return pane.classList.contains("active") ? 0 : 1;
}

function mountNear(node) {
  const r = node.getBoundingClientRect();
  if (!r.height && !r.width) return false;
  const h = window.innerHeight || 0;
  return r.bottom > -MOUNT_MARGIN_PX && r.top < h + MOUNT_MARGIN_PX;
}

function nextMountIndex() {
  for (let i = 0; i < _mountQueue.length; i++) {
    const job = _mountQueue[i];
    if (!job.node.isConnected) continue;
    if (mountRank(job) !== 0) continue;
    if (!job.node.clientWidth) continue;
    if (!mountNear(job.node)) continue;
    return i;
  }
  return -1;
}

function activeMountsPending() {
  for (const job of _mountQueue) {
    if (job.node.isConnected && mountRank(job) === 0) return true;
  }
  return false;
}

function pruneMounts() {
  const now = performance.now();
  for (let i = _mountQueue.length - 1; i >= 0; i--) {
    const job = _mountQueue[i];
    if (job.node.isConnected) continue;
    if (now - job.born < MOUNT_ORPHAN_MS) continue;
    _mountQueue.splice(i, 1);
  }
}

function runMount(idx) {
  const job = _mountQueue.splice(idx, 1)[0];
  try {
    job.run();
  } catch (e) {
    void e;
  }
}

function drainMounts() {
  _mountFront = false;
  const start = performance.now();
  let yielded = false;
  for (;;) {
    if (inputPending()) {
      yielded = true;
      break;
    }
    const idx = nextMountIndex();
    if (idx < 0) break;
    runMount(idx);
    if (performance.now() - start >= MOUNT_BUDGET_MS) {
      yielded = true;
      break;
    }
  }
  pruneMounts();
  if (!_mountQueue.length) return;
  if (yielded) {
    kickMounts();
    return;
  }
  scheduleMountPoll();
}

function scheduleMountPoll() {
  if (_mountPoll || !activeMountsPending()) return;
  _mountPoll = setTimeout(() => {
    _mountPoll = 0;
    kickMounts();
  }, MOUNT_IDLE_MS);
}

function kickMounts() {
  if (!_mountQueue.length || _mountFront) return;
  _mountFront = true;
  afterFrame(drainMounts);
}

function kickMountsSoon() {
  if (_mountKick) return;
  _mountKick = requestAnimationFrame(() => {
    _mountKick = 0;
    kickMounts();
    catchUpResize();
  });
}

function mountWithin(root) {
  if (!root) return;
  for (let i = 0; i < _mountQueue.length; ) {
    const job = _mountQueue[i];
    if (job.node.isConnected && root.contains(job.node)) runMount(i);
    else i++;
  }
}

function queueMount(node, run) {
  _mountQueue.push({ node: node, run: run, born: performance.now() });
  kickMounts();
}

document.addEventListener("scroll", kickMountsSoon, true);

window.addEventListener("resize", kickMountsSoon);

function graph(figDict, opts = {}) {
  const wrap = el("div", "wx-graph");
  const plotDiv = el("div", "wx-plot");
  plotDiv.style.width = "100%";
  wrap.appendChild(plotDiv);
  wrap._wxPlotDiv = plotDiv;

  const scheduleFit = () => {
    fitPlot(plotDiv);
  };
  wrap._wxFit = scheduleFit;

  wrap._wxResize = () => {
    if (wrap._wxHold) return;
    if (!plotDiv._wxDrawn || !plotDiv._fullLayout) return;
    if (syncSize(plotDiv)) scheduleFit();
  };

  const drawnHooks = [];
  wrap._wxOnDrawn = (fn) => {
    if (plotDiv._wxDrawn) fn();
    else drawnHooks.push(fn);
  };

  if (!figDict) {
    ensureEmptyStyles();
    plotDiv.classList.add("wx-plot-empty");
    plotDiv.appendChild(el("div", "unavailable", "Chart data unavailable."));
    return wrap;
  }

  const wait = el("div", "wx-plot-wait");
  wait.setAttribute("role", "status");
  wait.setAttribute("aria-label", "Loading chart");
  wait.appendChild(el("div", "wx-plot-spin"));
  plotDiv.appendChild(wait);
  const clearWait = () => {
    if (wait.parentNode) wait.parentNode.removeChild(wait);
  };

  let fig = figDict;
  let layout;

  if (isMobile()) {
    try {
      fig = buildMobileFigure(figDict, opts);
      layout = fig.layout;
    } catch (e) {
      fig = figDict;
      layout = null;
    }
  }

  if (!layout) {
    layout = Object.assign({}, figDict.layout || {});
    delete layout.width;
    layout.autosize = true;
    layout.height = opts.height || layout.height || 420;
    fig = figDict;
  }

  const height = layout.height;
  plotDiv.style.height = height + "px";
  wrap._wxBaseHeight = height;

  const mobile = isMobile();
  const config = {
    responsive: false,
    displaylogo: false,
    displayModeBar: (mobile || opts.noModeBar) ? false : "hover",
  };
  if (mobile) {
    config.scrollZoom = false;
    config.doubleClick = false;
    config.showAxisDragHandles = false;
    config.showAxisRangeEntryBoxes = false;
    config.editable = false;
  }

  wrap._wxConfig = config;

  let selected = null;
  let mounted = false;
  let listening = false;
  let cards = [];
  let syncing = false;

  const syncScorecards = () => {
    if (syncing || !cards.length || !plotDiv.data) return;
    const res = scorecardUpdates(cards, plotDiv.data, plotDiv);
    if (!res.jobs.length) return;
    syncing = true;
    try {
      for (const job of res.jobs) Plotly.restyle(plotDiv, job.update, [job.index]);
      if (Object.keys(res.layout).length) Plotly.relayout(plotDiv, res.layout);
    } catch (e) {
      console.warn("scorecard sync failed", e);
    }
    requestAnimationFrame(() => { syncing = false; });
  };

  const draw = () => {
    const filtered = applyStationFilter({ data: fig.data || [], layout: layout }, selected);
    const prepared = prepareScorecards(
      filtered,
      selected && selected.size ? null : fig.data || []
    );
    cards = prepared.cards;
    if (mounted) {
      const next = mergeView(prepared.layout, captureView(plotDiv));
      Plotly.react(plotDiv, prepared.data, next, config)
        .then(() => {
          syncSize(plotDiv);
          fitPlot(plotDiv);
        });
    } else {
      clearWait();
      Plotly.newPlot(plotDiv, prepared.data, prepared.layout, config)
        .then(() => {
          mounted = true;
          plotDiv._wxDrawn = true;
          plotDiv._wxWidth = plotDiv.clientWidth;
          if (!listening && typeof plotDiv.on === "function") {
            listening = true;
            plotDiv.on("plotly_restyle", syncScorecards);
          }
          plotDiv._wxSettlePending = true;
          if (paneIsActive(plotDiv)) settlePlot(plotDiv);
          else nextTask(() => settlePlot(plotDiv));
          for (const fn of drawnHooks.splice(0)) fn();
        });
    }
  };

  if (opts.stationFilter) {
    const stations = figureStations(fig.data);
    if (stations.length > 1) {
      const control = stationFilterControl(stations, (sel) => {
        selected = sel;
        if (!mounted) return;
        try {
          draw();
        } catch (e) {
          console.warn("station filter failed", e);
        }
      }, !mobile);
      if (mobile) {
        wrap.insertBefore(control, plotDiv);
      } else {
        wrap.style.position = "relative";
        wrap.appendChild(control);
      }
    }
  }

  queueMount(plotDiv, () => {
    try {
      draw();
    } catch (e) {
      clearWait();
      ensureEmptyStyles();
      plotDiv.classList.add("wx-plot-empty");
      plotDiv.appendChild(el("div", "unavailable", "Chart failed to render."));
    }
  });

  watchResize(plotDiv, () => {
    if (!plotDiv._wxDrawn || !plotDiv._fullLayout) return;
    if (syncSize(plotDiv)) scheduleFit();
  });

  return wrap;
}

const CARD_ANIM_MS = 0;

const EXPAND_ICON =
  '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
  '<path d="M9.7 6.3 13.5 2.5M10.3 2.5h3.2v3.2M6.3 9.7 2.5 13.5M5.7 13.5H2.5v-3.2"/></svg>';

const COLLAPSE_ICON =
  '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
  '<path d="M13.5 2.5 9.7 6.3M9.7 3.1v3.2h3.2M2.5 13.5 6.3 9.7M6.3 12.9V9.7H3.1"/></svg>';

function ensureCardExpandStyles() {
  if (document.getElementById("wx-cardexpand-styles")) return;
  const st = document.createElement("style");
  st.id = "wx-cardexpand-styles";
  st.textContent = [
    ".wx-expandable{position:relative;overflow:hidden;box-sizing:border-box;",
    "display:flex;flex-direction:column;",
    "transition:border-color .2s ease,box-shadow .24s ease;}",
    ".wx-expandable > .wx-graph{flex:1 1 auto;min-height:0;}",
    ".wx-expandable.wx-sized > .wx-graph > .wx-plot{height:100%!important;}",
    ".wx-expandable.wx-expanded{border-color:#dcd9d4;box-shadow:0 6px 22px rgba(0,0,0,.07);}",
    ".wx-card-collapsed{opacity:0;overflow:hidden;pointer-events:none;",
    "padding-left:0;padding-right:0;border-left-width:0;border-right-width:0;}",
    ".wx-expand-btn{position:absolute;top:8px;right:8px;z-index:30;width:26px;height:26px;",
    "padding:0;display:flex;align-items:center;justify-content:center;",
    "border:1px solid transparent;border-radius:6px;background:transparent;",
    "color:var(--text-muted,#8a857d);cursor:pointer;opacity:0;",
    "transition:opacity .15s ease,background-color .15s ease,border-color .15s ease,color .15s ease;}",
    ".wx-expandable:hover .wx-expand-btn,.wx-insight-shell:hover .wx-expand-btn,",
    ".wx-expand-btn:focus-visible{opacity:1;}",
    ".wx-expanded > .wx-expand-btn{opacity:1;}",
    ".wx-expand-btn:hover{background:#f3f2ef;border-color:var(--line,#e8e6e3);",
    "color:var(--text,#26231f);}",
    ".wx-expand-btn svg{width:15px;height:15px;fill:none;stroke:currentColor;",
    "stroke-width:1.4;stroke-linecap:round;stroke-linejoin:round;}",
    ".wx-expandable .js-plotly-plot .modebar{transform:translateX(-30px)!important;}",
    ".wx-expandable .wx-stnf-float{right:40px;}",
    "@media (max-width:768px){.wx-expand-btn{display:none;}}",
  ].join("");
  document.head.appendChild(st);
}

function findGraphWrap(node) {
  if (!node) return null;
  if (node.classList && node.classList.contains("wx-graph")) return node;
  return node.querySelector ? node.querySelector(".wx-graph") : null;
}

function siblingCard(c) {
  const row = c.parentNode;
  if (!row || !row.classList || !row.classList.contains("wx-chart-row")) return null;
  for (const node of row.children) {
    if (node !== c && node.classList && node.classList.contains("wx-card")) return node;
  }
  return null;
}

function siblingGraphResize(sib) {
  if (!sib) return () => {};
  const gw = sib.querySelector(".wx-graph");
  if (gw && typeof gw._wxResize === "function") return gw._wxResize;
  const pd = sib.querySelector(".wx-plot");
  return () => {
    syncSize(pd);
  };
}

function setExpandButton(btn, on) {
  btn.innerHTML = on ? COLLAPSE_ICON : EXPAND_ICON;
  const label = on ? "Collapse" : "Expand";
  btn.setAttribute("aria-label", label);
  btn.setAttribute("aria-expanded", on ? "true" : "false");
}

function expandButton(onToggle) {
  const btn = el("button", "wx-expand-btn");
  btn.type = "button";
  setExpandButton(btn, false);
  btn.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    onToggle();
  });
  return btn;
}

const SEED_ORPHAN_MS = 20000;

const SEED_RETRY_MS = 120;

const _seedQueue = [];

let _seedRaf = 0;

let _seedTimer = 0;

function queueSeed(job) {
  job.born = performance.now();
  _seedQueue.push(job);
  kickSeeds();
}

function kickSeeds() {
  if (_seedRaf || !_seedQueue.length) return;
  if (_seedTimer) {
    clearTimeout(_seedTimer);
    _seedTimer = 0;
  }
  _seedRaf = requestAnimationFrame(flushSeeds);
}

function flushSeeds() {
  _seedRaf = 0;
  const now = performance.now();
  const jobs = _seedQueue.splice(0);
  const writes = [];
  for (const job of jobs) {
    if (job.done && job.done()) continue;
    if (!job.node.isConnected) {
      if (now - job.born < SEED_ORPHAN_MS) _seedQueue.push(job);
      continue;
    }
    const w = job.read();
    if (w) writes.push(w);
    else _seedQueue.push(job);
  }
  for (const w of writes) w.write();
  for (const w of writes) if (w.after) w.after();
  if (_seedQueue.length && !_seedTimer) {
    _seedTimer = setTimeout(() => {
      _seedTimer = 0;
      kickSeeds();
    }, SEED_RETRY_MS);
  }
}

function makeCardExpandable(c, child) {
  const graphWrap = findGraphWrap(child);
  if (!graphWrap) return;
  ensureCardExpandStyles();
  c.classList.add("wx-expandable");

  const plotDiv = graphWrap._wxPlotDiv || graphWrap.querySelector(".wx-plot");
  const resize = graphWrap._wxResize || (() => {
    syncSize(plotDiv);
  });

  let baseH = 0;
  let rowGap = 16;
  let expanded = false;
  let timer = 0;
  let quiet = false;
  let plain = false;

  queueSeed({
    node: c,
    done: () => !!c.style.height,
    read: () => {
      const h = Math.round(c.getBoundingClientRect().height);
      if (!h) return null;
      const want = Math.round(graphWrap._wxBaseHeight || 0);
      const have = plotDiv ? Math.round(plotDiv.getBoundingClientRect().height) : 0;
      const next = want && have < want ? h + (want - have) : h;
      return {
        write: () => {
          if (c.style.height) return;
          baseH = next;
          c.style.height = baseH + "px";
          c.classList.add("wx-sized");
        },
        after: () => resize(),
      };
    },
  });

  const rowOf = () => {
    const r = c.parentNode;
    return (r && r.classList && r.classList.contains("wx-chart-row")) ? r : null;
  };

  const targetHeight = (widens) => {
    const base = baseH || Math.round(c.getBoundingClientRect().height) || 452;
    if (widens) return base;
    return Math.min(4000, Math.max(Math.round(base * 1.6), base + 180));
  };

  const chromeSize = () => {
    const cr = c.getBoundingClientRect();
    const pr = plotDiv ? plotDiv.getBoundingClientRect() : null;
    if (!pr || !pr.width || !pr.height) return null;
    return [cr.width - pr.width, cr.height - pr.height];
  };

  const growWith = (from, chrome, finalW, finalH) => {
    if (!plotDiv || !chrome) return false;
    const fw = Math.round(finalW - chrome[0]);
    const fh = Math.round(finalH - chrome[1]);
    if (!(fw > 40) || fh < plotFloor(plotDiv)) return false;
    try {
      Plotly.relayout(plotDiv, { autosize: false, width: fw, height: fh });
    } catch (e) {
      return false;
    }
    return true;
  };

  const settle = () => {
    if (!plotDiv) return;
    if (plotDiv.layout) {
      delete plotDiv.layout.width;
      delete plotDiv.layout.height;
    }
    if (graphWrap && graphWrap._wxHold) return;
    if (!plotRoomy(plotDiv)) return;
    try {
      Plotly.relayout(plotDiv, { autosize: true });
    } catch (e) {}
    resize();
  };

  const apply = (on) => {
    if (on === expanded) return;
    if (!baseH) baseH = Math.round(c.getBoundingClientRect().height) || 452;
    expanded = on;
    setExpandButton(btn, on);

    const chrome = quiet ? null : chromeSize();

    c.classList.toggle("wx-expanded", on);

    const row = rowOf();
    const sib = row ? siblingCard(c) : null;
    let finalW = c.getBoundingClientRect().width;

    if (row && sib) {
      const rowW = row.clientWidth;
      const startC = c.getBoundingClientRect().width;
      const startS = sib.getBoundingClientRect().width;
      const startM = getComputedStyle(sib).marginLeft;
      if (on) rowGap = parseFloat(startM) || rowGap;
      c.style.flex = "0 0 auto";
      sib.style.flex = "0 0 auto";
      c.style.width = startC + "px";
      sib.style.width = startS + "px";
      sib.style.marginLeft = startM;
      void row.offsetWidth;
      if (on) {
        finalW = rowW;
        c.style.width = rowW + "px";
        sib.style.width = "0px";
        sib.style.marginLeft = "0px";
        sib.classList.add("wx-card-collapsed");
      } else {
        const half = Math.max(0, Math.round((rowW - rowGap) / 2));
        finalW = half;
        c.style.width = half + "px";
        sib.style.width = half + "px";
        sib.style.marginLeft = rowGap + "px";
        sib.classList.remove("wx-card-collapsed");
      }
    }

    const finalH = on ? targetHeight(!!(row && sib)) : baseH;
    c.style.height = finalH + "px";
    growWith(null, chrome, finalW, finalH);

    if (timer) clearTimeout(timer);
    const done = () => {
      timer = 0;
      if (!expanded && sib) {
        c.style.width = "";
        c.style.flex = "";
        sib.style.width = "";
        sib.style.flex = "";
        sib.style.marginLeft = "";
      }
      settle();
      if (sib) siblingGraphResize(sib)();
    };
    if (quiet) done();
    else timer = setTimeout(done, CARD_ANIM_MS + 40);
  };

  c._wxNoAnim = (fn) => {
    const prev = c.style.transition;
    c.style.transition = "none";
    quiet = true;
    try {
      fn();
    } finally {
      void c.offsetWidth;
      c.style.transition = prev;
      quiet = false;
    }
  };

  c._wxRebase = (h) => {
    if (!(h > 0)) return;
    baseH = Math.round(h);
    c.classList.add("wx-sized");
    if (!expanded) {
      c.style.height = baseH + "px";
      return;
    }
    const r = rowOf();
    c.style.height = targetHeight(!!(r && siblingCard(c))) + "px";
    resize();
  };

  c._wxExpand = (on, noScale) => {
    plain = !!noScale;
    try {
      apply(!!on);
    } finally {
      plain = false;
    }
  };

  c._wxIsExpanded = () => expanded;

  const btn = expandButton(() => apply(!expanded));
  c.appendChild(btn);

  watchResize(c, () => {
    if (!expanded) return;
    const row = rowOf();
    if (row) c.style.width = row.clientWidth + "px";
    resize();
  });
}

function card(child, extraStyle, opts) {
  const c = el("div", "wx-card");
  if (extraStyle) Object.assign(c.style, extraStyle);
  c.appendChild(child);
  const fixed = !!(opts && opts.expandable === false);
  if (!isMobile() && !fixed) makeCardExpandable(c, child);
  return c;
}

function row(left, right) {
  const r = el("div", "wx-chart-row");
  r.appendChild(card(left));
  r.appendChild(card(right));
  return r;
}

const BOX_CARD_HEIGHT = 340;
const ROW_CARD_SCALE = 0.88;

function boxHeight() {
  return isMobile() ? undefined : Math.round(BOX_CARD_HEIGHT * heightScale());
}

function boxCard(fig) {
  return card(graph(fig, { height: boxHeight() }), null, { expandable: false });
}

function rowGraph(fig, opts) {
  const o = Object.assign({}, opts);
  if (!isMobile() && !o.height) {
    const natural = (fig && fig.layout && fig.layout.height) || 420;
    o.height = Math.round(natural * ROW_CARD_SCALE * heightScale());
  }
  return graph(fig, o);
}

function ensureEmptyStyles() {
  if (document.getElementById("wx-empty-styles")) return;
  const st = document.createElement("style");
  st.id = "wx-empty-styles";
  st.textContent = [
    ".wx-plot-empty{display:flex;align-items:center;justify-content:center;",
    "min-height:120px;box-sizing:border-box;}",
    ".wx-plot-empty > .unavailable{padding:0;font-size:12px;color:#a9a49c;",
    "text-align:center;}",
  ].join("");
  document.head.appendChild(st);
}

function unavailable() {
  ensureEmptyStyles();
  const box = el("div", "wx-card wx-plot-empty");
  box.appendChild(el("div", "unavailable", "Chart data unavailable."));
  return box;
}

function stripTitle(figDict) {
  if (!figDict || !figDict.layout) return figDict;
  const fig = deepClone(figDict);
  delete fig.layout.title;
  const margin = fig.layout.margin || {};
  const top = typeof margin.t === "number" ? Math.min(margin.t, 40) : 40;
  fig.layout.margin = Object.assign({}, margin, { t: top });
  return fig;
}

function annotateEmptyPanels(figDict, message, subtitle) {
  if (!figDict || !figDict.layout || !Array.isArray(figDict.data)) return figDict;

  const used = usedAxisIds(figDict.data);
  const fig = deepClone(figDict);
  const layout = fig.layout;
  const notes = [];
  const fillers = [];

  for (const key of Object.keys(layout)) {
    if (!/^xaxis\d*$/.test(key)) continue;
    const ax = layout[key];
    if (!ax || !Array.isArray(ax.domain)) continue;
    const idx = key === "xaxis" ? "" : key.slice(5);
    const axisId = "x" + idx;
    if (used.has(axisId)) continue;

    let ykey = "yaxis" + idx;
    if (typeof ax.anchor === "string" && /^y\d*$/.test(ax.anchor)) {
      ykey = "yaxis" + ax.anchor.slice(1);
    }
    const ay = layout[ykey];
    if (!ay || !Array.isArray(ay.domain)) continue;

    const blank = {
      showgrid: false, zeroline: false, showline: false,
      showticklabels: false, ticks: "", title: { text: "" },
    };
    Object.assign(ax, blank);
    Object.assign(ay, blank);

    const cx = (ax.domain[0] + ax.domain[1]) / 2;
    const cy = (ay.domain[0] + ay.domain[1]) / 2;

    notes.push({
      text: message,
      xref: "paper", yref: "paper",
      x: cx, y: subtitle ? cy + 0.03 : cy,
      xanchor: "center", yanchor: "middle",
      showarrow: false,
      font: { size: 12, color: "#a9a49c" },
    });
    if (subtitle) {
      notes.push({
        text: subtitle,
        xref: "paper", yref: "paper",
        x: cx, y: cy - 0.05,
        xanchor: "center", yanchor: "middle",
        showarrow: false,
        font: { size: 10.5, color: "#c4c0b9" },
      });
    }

    fillers.push({
      type: "scatter", mode: "markers", x: [], y: [],
      xaxis: axisId, yaxis: "y" + (ykey === "yaxis" ? "" : ykey.slice(5)),
      showlegend: false, hoverinfo: "skip",
    });
  }

  if (!notes.length) return figDict;

  layout.annotations = (layout.annotations || []).concat(notes);
  fig.data = fig.data.concat(fillers);
  return fig;
}

function ensureGridToggleStyles() {
  if (document.getElementById("wx-gridtoggle-styles")) return;
  const st = document.createElement("style");
  st.id = "wx-gridtoggle-styles";
  st.textContent = [
    ".wx-grid-toggle{display:flex;align-items:center;justify-content:flex-end;",
    "gap:14px;min-height:26px;margin:4px 0 2px 0;padding:0 40px 0 6px;",
    "user-select:none;}",
    ".wx-grid-toggle .wx-stnf{flex:0 0 auto;margin:0;height:auto;}",
    ".wx-grid-seg{display:inline-flex;align-items:center;gap:2px;flex:0 0 auto;}",
    ".wx-grid-seg button{font-family:inherit;font-size:11px;font-weight:500;",
    "letter-spacing:.01em;line-height:1.4;color:var(--text-muted,#8a857d);",
    "background:transparent;border:1px solid transparent;border-radius:999px;",
    "padding:2px 9px;margin:0;cursor:pointer;",
    "transition:color .12s ease,border-color .12s ease,background-color .12s ease;}",
    ".wx-grid-seg button:hover{color:var(--text,#26231f);",
    "border-color:var(--line,#e8e6e3);}",
    ".wx-grid-seg button.on{color:var(--text,#26231f);background:#f3f2ef;",
    "border-color:var(--line,#e8e6e3);}",
    ".wx-grid-toggle label{display:inline-flex;align-items:center;gap:6px;cursor:pointer;",
    "font-family:inherit;font-size:11px;font-weight:500;letter-spacing:.01em;",
    "text-transform:none;color:var(--text-muted,#8a857d);background:transparent;",
    "border:1px solid transparent;border-radius:999px;padding:2px 8px 2px 6px;",
    "transition:color .12s ease,border-color .12s ease;}",
    ".wx-grid-toggle label:hover{color:var(--text,#26231f);border-color:var(--line,#e8e6e3);}",
    ".wx-grid-toggle label.on{color:var(--text,#26231f);}",
    ".wx-grid-mode{display:none;flex:0 0 auto;align-items:center;gap:4px;",
    "font-family:inherit;font-size:11px;font-weight:500;letter-spacing:.01em;",
    "line-height:1.4;color:var(--text-muted,#8a857d);background:transparent;",
    "border:none;border-radius:0;padding:0;margin:0;cursor:pointer;",
    "transition:color .12s ease;}",
    ".wx-grid-mode.show{display:inline-flex;}",
    ".wx-grid-mode.wx-grid-mode,.wx-grid-mode.wx-grid-mode:hover,",
    ".wx-grid-mode.wx-grid-mode:focus,.wx-grid-mode.wx-grid-mode:active{",
    "background:transparent;border:none;box-shadow:none;border-radius:0;padding:0;}",
    ".wx-grid-mode:hover{color:var(--text,#26231f);}",
    ".wx-grid-mode.on{color:var(--text,#26231f);}",
    ".wx-grid-mode .box{width:11px;height:11px;flex:0 0 auto;border-radius:2px;",
    "border:1px solid currentColor;background:transparent;opacity:.55;",
    "box-sizing:border-box;display:inline-flex;align-items:center;",
    "justify-content:center;}",
    ".wx-grid-mode.on .box{opacity:1;}",
    ".wx-grid-mode .box svg{width:9px;height:9px;fill:none;stroke:currentColor;",
    "stroke-width:2;stroke-linecap:round;stroke-linejoin:round;opacity:0;}",
    ".wx-grid-mode.on .box svg{opacity:1;}",
    ".wx-grid-toggle input[type=\"checkbox\"]{cursor:pointer;width:12px;height:12px;margin:0;",
    "accent-color:var(--accent,#2c5fa9);}",
    ".wx-grid-headwrap{display:none;align-items:baseline;margin-right:auto;",
    "min-width:0;flex:0 1 auto;}",
    ".wx-grid-headwrap.show{display:flex;}",
    ".wx-grid-head{display:none;min-width:0;flex:0 1 auto;",
    "font-size:13px;font-weight:600;letter-spacing:-.015em;color:var(--text,#26231f);",
    "white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}",
    ".wx-grid-head.show{display:block;}",
    "@media (max-width:768px){.wx-grid-toggle{min-height:0;margin:2px 0;",
    "padding:0 6px;}}",
  ].join("");
  document.head.appendChild(st);
}

function ensureGridHoldStyles() {
  if (document.getElementById("wx-gridhold-styles")) return;
  const st = document.createElement("style");
  st.id = "wx-gridhold-styles";
  st.textContent = [
    ".station-grid.wx-grid-hold{position:relative;}",
    ".wx-grid-holdspin{display:none;}",
    ".station-grid.wx-grid-hold > .wx-graph{visibility:hidden;}",
    ".station-grid.wx-grid-hold > .wx-grid-holdspin{display:flex;position:absolute;",
    "left:0;right:0;top:0;bottom:0;height:auto;z-index:2;}",
  ].join("");
  document.head.appendChild(st);
}

const GRID_STATION_RE = /<b>(.*?)<\/b>/;

function gridTraceStation(tr) {
  if (!tr) return null;
  if (tr.meta && typeof tr.meta.station === "string") {
    const name = tr.meta.station.trim();
    if (name) return name;
  }
  const ht = tr.hovertemplate;
  if (typeof ht !== "string") return null;
  const m = GRID_STATION_RE.exec(ht);
  return m ? m[1].trim() : null;
}

function gridAxisStations(fig) {
  const map = new Map();
  for (const tr of (fig && fig.data) || []) {
    const id = (tr && tr.xaxis) || "x";
    if (map.has(id)) continue;
    const name = gridTraceStation(tr);
    if (name) map.set(id, name);
  }
  return map;
}

function cloneLayout(layout) {
  if (!layout) return {};
  const tpl = layout.template;
  if (!tpl) return deepClone(layout);
  const rest = Object.assign({}, layout);
  delete rest.template;
  const out = deepClone(rest);
  out.template = tpl;
  return out;
}

function isAlertTrace(tr) {
  if (!tr) return false;
  if (tr.meta && tr.meta.band_hover) return true;
  return tr.mode === "markers" && !tr.hovertemplate;
}

function bandHoverBody(text) {
  const parts = String(text).split("<br>");
  const rest = parts[0].indexOf("<b>") === 0 ? parts.slice(1) : parts;
  const out = rest.join("<br>").trim();
  return out || null;
}

const BAND_GLYPH_FALLBACK = "rgb(138, 95, 242)";

const BAND_FILL_FALLBACK = "rgba(138, 95, 242, 0.27)";

const BAND_GLYPH_R = 3;

const BAND_GLYPH_STROKE = 1;

const BAND_GLYPH_CX = 20;

const SVG_NS = "http://www.w3.org/2000/svg";

function bandTraceFill(tr, layout) {
  const xid = tr.xaxis || "x";
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of decodeArray(tr.x) || []) {
    if (v === null || v === undefined) continue;
    const t = stampMs(v);
    if (!isFinite(t)) continue;
    if (t < lo) lo = t;
    if (t > hi) hi = t;
  }
  let best = null;
  let gap = Infinity;
  for (const sh of (layout && layout.shapes) || []) {
    if (!sh || sh.type !== "rect" || typeof sh.xref !== "string") continue;
    if (sh.xref.split(" ")[0] !== xid) continue;
    if (!solid(sh.fillcolor)) continue;
    const a = stampMs(sh.x0);
    const b = stampMs(sh.x1);
    if (!isFinite(a) || !isFinite(b)) continue;
    const d = isFinite(lo)
      ? Math.abs(Math.min(a, b) - lo) + Math.abs(Math.max(a, b) - hi)
      : 0;
    if (d < gap) {
      gap = d;
      best = sh.fillcolor;
    }
  }
  return best || BAND_FILL_FALLBACK;
}

const BAND_HOVER_STEP_MS = 3600000;

function bandHourPoints(tr) {
  const xs = decodeArray(tr.x) || [];
  const ys = decodeArray(tr.y) || [];
  const segs = [];
  let seg = null;
  for (let i = 0; i < xs.length; i++) {
    const v = xs[i];
    if (v === null || v === undefined) {
      seg = null;
      continue;
    }
    const t = stampMs(v);
    if (!isFinite(t)) continue;
    if (!seg) {
      seg = { lo: t, hi: t, ylo: Infinity, yhi: -Infinity };
      segs.push(seg);
    }
    if (t < seg.lo) seg.lo = t;
    if (t > seg.hi) seg.hi = t;
    const y = Number(ys[i]);
    if (isFinite(y)) {
      if (y < seg.ylo) seg.ylo = y;
      if (y > seg.yhi) seg.yhi = y;
    }
  }
  const seen = new Set();
  const x = [];
  const y = [];
  segs.sort((a, b) => a.lo - b.lo);
  for (const s of segs) {
    const key = s.lo + "-" + s.hi;
    if (seen.has(key)) continue;
    seen.add(key);
    const ylo = isFinite(s.ylo) ? s.ylo : 0;
    const yhi = isFinite(s.yhi) ? s.yhi : ylo;
    if (x.length) {
      x.push(null);
      y.push(null);
    }
    let k = 0;
    for (let t = s.lo; t <= s.hi; t += BAND_HOVER_STEP_MS) {
      x.push(isoStampMs(t));
      y.push(k % 2 ? yhi : ylo);
      k++;
    }
    if (k === 1) {
      x.push(isoStampMs(s.lo));
      y.push(yhi);
    }
  }
  return x.length ? { x: x, y: y } : null;
}

function isoStampMs(ms) {
  const d = new Date(ms);
  const p = (v) => String(v).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
  );
}

function unifiedBandTrace(tr, layout) {
  if (!tr || !tr.meta || !tr.meta.band_hover) return tr;
  let out = tr;
  if (!tr.hovertemplate && typeof tr.text === "string" && tr.text) {
    const body = bandHoverBody(tr.text);
    if (body) {
      out = Object.assign({}, tr);
      out.hovertemplate = body + "<extra></extra>";
      out.hoveron = "points";
      delete out.hoverinfo;
      const hours = bandHourPoints(tr);
      if (hours) {
        out.x = hours.x;
        out.y = hours.y;
        out.fill = "none";
      }
    }
  }
  if (layout && !tr.meta.band_fill) {
    if (out === tr) out = Object.assign({}, tr);
    out.meta = Object.assign({}, tr.meta, { band_fill: bandTraceFill(tr, layout) });
  }
  return out;
}

function paintBandGlyphs(pd) {
  const layer = pd && pd.querySelector ? pd.querySelector(".hoverlayer") : null;
  if (!layer) return;
  for (const g of layer.querySelectorAll(".legend .traces")) {
    const d = g.__data__;
    const item = Array.isArray(d) ? d[0] : d;
    const meta = item && item.trace ? item.trace.meta : null;
    if (!meta || !meta.band_hover) continue;
    const fill = meta.band_fill || BAND_FILL_FALLBACK;
    const edge = solid(fill) || meta.band_color || BAND_GLYPH_FALLBACK;
    const pts = g.querySelector(".legendpoints");
    if (!pts || pts.querySelector(".wx-band-glyph")) continue;
    let cx = BAND_GLYPH_CX;
    const ref = pts.querySelector("path");
    if (ref && typeof pts.getScreenCTM === "function") {
      try {
        const box = ref.getBoundingClientRect();
        const m = pts.getScreenCTM();
        if (box.width > 0 && m && m.a) cx = (box.left + box.width / 2 - m.e) / m.a;
      } catch (e) {
        void e;
      }
    }
    for (const child of Array.from(pts.children)) child.style.display = "none";
    const dot = document.createElementNS(SVG_NS, "rect");
    dot.setAttribute("class", "wx-band-glyph");
    const inset = BAND_GLYPH_STROKE / 2;
    dot.setAttribute("x", String(cx - BAND_GLYPH_R + inset));
    dot.setAttribute("y", String(-BAND_GLYPH_R + inset));
    dot.setAttribute("width", String(BAND_GLYPH_R * 2 - BAND_GLYPH_STROKE));
    dot.setAttribute("height", String(BAND_GLYPH_R * 2 - BAND_GLYPH_STROKE));
    dot.setAttribute("fill", fill);
    dot.setAttribute("stroke", edge);
    dot.setAttribute("stroke-width", String(BAND_GLYPH_STROKE));
    pts.appendChild(dot);
  }
}

function wireBandGlyphs(wrap) {
  wirePlotBandGlyphs(wrap._wxGridPlot);
}

function fitHoverReach(pd) {
  const fl = pd && pd._fullLayout;
  if (!fl) return;
  let step = Infinity;
  for (const key of Object.keys(fl)) {
    if (!/^xaxis\d*$/.test(key)) continue;
    const ax = fl[key];
    if (!ax || ax.visible === false || ax.type !== "date" || !(ax._length > 0)) continue;
    const r = Array.isArray(ax._rl)
      ? ax._rl
      : Array.isArray(ax.range) ? ax.range.map(stampMs) : null;
    if (!r || !isFinite(r[0]) || !isFinite(r[1])) continue;
    const span = Math.abs(r[1] - r[0]);
    if (!(span > 0)) continue;
    const px = (ax._length * BAND_HOVER_STEP_MS) / span;
    if (px < step) step = px;
  }
  if (!isFinite(step)) return;
  const reach = Math.max(1, Math.floor(step / 2));
  if (fl.hoverdistance !== reach) fl.hoverdistance = reach;
  if (pd.layout && pd.layout.hoverdistance !== reach) pd.layout.hoverdistance = reach;
}

function wirePlotBandGlyphs(pd) {
  if (!pd || typeof pd.on !== "function" || pd._wxBandGlyphWired) return;
  pd._wxBandGlyphWired = true;
  fitHoverReach(pd);
  pd.on("plotly_afterplot", () => fitHoverReach(pd));
  pd.on("plotly_relayout", () => fitHoverReach(pd));
  pd.on("plotly_hover", () => {
    paintBandGlyphs(pd);
    requestAnimationFrame(() => paintBandGlyphs(pd));
  });
}

function overlayHoverTemplate(ht) {
  if (typeof ht !== "string") return ht;
  return ht.replace(/<br>%\{x(\|[^}]*)?\}/g, "");
}

function cumulativeHoverTemplate(ht) {
  if (typeof ht !== "string") return ht;
  return ht.replace(CUMULATIVE_HOVER_RE, "$1 total:");
}

function cumulativeTraces(data) {
  const totals = new Map();
  const out = [];
  for (const tr of data || []) {
    const y = tr && !isAlertTrace(tr) ? decodeArray(tr.y) : null;
    if (!y) {
      out.push(tr);
      continue;
    }
    const id = tr.xaxis || "x";
    let total = totals.get(id) || 0;
    const sums = new Array(y.length);
    for (let i = 0; i < y.length; i++) {
      const v = y[i] === null || y[i] === undefined ? NaN : Number(y[i]);
      if (isFinite(v)) {
        total += Math.max(0, v);
        sums[i] = Math.round(total * 1000) / 1000;
      } else {
        sums[i] = null;
      }
    }
    totals.set(id, total);
    const next = Object.assign({}, tr, { y: sums });
    if (tr.hovertemplate) {
      next.hovertemplate = cumulativeHoverTemplate(tr.hovertemplate);
    }
    out.push(next);
  }
  return out;
}

function gridStationNames(fig) {
  const anns = (fig && fig.layout && fig.layout.annotations) || [];
  const names = [];
  const seen = new Set();
  for (const a of anns) {
    if (!a || typeof a.text !== "string") continue;
    const t = a.text.replace(/<[^>]*>/g, "").trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    names.push(t);
  }
  return names;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stationRanges(text, names) {
  const ordered = names.slice().sort((a, b) => b.length - a.length);
  const re = new RegExp("(?:" + ordered.map(escapeRegex).join("|") + ")", "g");
  const ranges = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    const from = m.index;
    const to = from + m[0].length;
    const prev = from > 0 ? text.charAt(from - 1) : " ";
    const next = to < text.length ? text.charAt(to) : " ";
    if (/[A-Za-z0-9]/.test(prev) || /[A-Za-z0-9]/.test(next)) continue;
    ranges.push({ start: from, end: to, name: m[0] });
  }

  const exact = new Set(names);
  let offset = 0;
  for (const line of text.split("\n")) {
    const colon = line.indexOf(":");
    if (colon > 0 && colon <= 44) {
      const label = line.slice(0, colon).trim();
      if (label && label === label.toUpperCase()) {
        const from = offset + line.indexOf(label);
        const to = from + label.length;
        const covered = ranges.some(r => r.start < to && r.end > from);
        if (!covered) {
          let hit = exact.has(label) ? label : null;
          if (!hit) hit = ordered.find(n => n.indexOf(label) === 0 || label.indexOf(n) === 0);
          if (hit) ranges.push({ start: from, end: to, name: hit });
        }
      }
    }
    offset += line.length + 1;
  }

  ranges.sort((a, b) => a.start - b.start);
  const out = [];
  let lastEnd = -1;
  for (const r of ranges) {
    if (r.start < lastEnd) continue;
    out.push(r);
    lastEnd = r.end;
  }
  return out;
}

function applyStationRanges(block, ranges, onPick) {
  const nodes = [];
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, null);
  let pos = 0;
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const len = node.nodeValue.length;
    nodes.push({ node: node, start: pos, end: pos + len });
    pos += len;
  }

  const groups = new Map();

  for (const item of nodes) {
    const hits = [];
    ranges.forEach((r, id) => {
      const s = Math.max(r.start, item.start);
      const e = Math.min(r.end, item.end);
      if (e > s) hits.push({ s: s - item.start, e: e - item.start, id: id, name: r.name });
    });
    if (!hits.length) continue;
    hits.sort((a, b) => a.s - b.s);

    const text = item.node.nodeValue;
    const frag = document.createDocumentFragment();
    let last = 0;
    for (const hit of hits) {
      if (hit.s > last) frag.appendChild(document.createTextNode(text.slice(last, hit.s)));
      const span = el("span", "wx-stn-link");
      span.textContent = text.slice(hit.s, hit.e);
      span.dataset.station = hit.name;
      span.title = "Open " + hit.name + " chart";
      span.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        onPick(hit.name);
      });
      frag.appendChild(span);
      if (!groups.has(hit.id)) groups.set(hit.id, []);
      groups.get(hit.id).push(span);
      last = hit.e;
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    if (item.node.parentNode) item.node.parentNode.replaceChild(frag, item.node);
  }

  for (const spans of groups.values()) {
    const set = (on) => {
      for (const s of spans) s.classList.toggle("wx-stn-hot", on);
    };
    for (const span of spans) {
      span.addEventListener("mouseenter", () => set(true));
      span.addEventListener("mouseleave", () => set(false));
    }
  }
}

function linkifyStations(root, names, onPick) {
  if (!root || !names || !names.length) return;
  let blocks = root.querySelectorAll ? root.querySelectorAll("code") : null;
  if (!blocks || !blocks.length) blocks = [root];
  for (const block of blocks) {
    const text = block.textContent || "";
    if (!text) continue;
    const ranges = stationRanges(text, names);
    if (ranges.length) applyStationRanges(block, ranges, onPick);
  }
}

function ensureInsightStyles() {
  if (document.getElementById("wx-insight-styles")) return;
  const st = document.createElement("style");
  st.id = "wx-insight-styles";
  st.textContent = [
    ".wx-insight-shell{position:relative;margin-bottom:16px;}",
    ".wx-insight-shell > .wx-ov-wrap{max-height:max(180px,20vh);}",
    ".wx-insight-shell > .wx-expand-btn{top:1px;right:4px;background:var(--surface,#fff);",
    "border-color:var(--line,#e8e6e3);}",
    ".wx-stn-link{cursor:pointer;border-bottom:1px dotted currentColor;}",
    ".wx-stn-link.wx-stn-hot{background:#e2e9f3;}",
    "@media (max-width:768px){.wx-insight-shell{margin-bottom:10px;}}",
  ].join("");
  document.head.appendChild(st);
}

function makeBoxExpandable(shell, target) {
  ensureCardExpandStyles();
  const baseMax = Math.round(parseFloat(getComputedStyle(target).maxHeight)) || 180;
  let expanded = false;
  let timer = 0;

  const btn = expandButton(() => {
    expanded = !expanded;
    setExpandButton(btn, expanded);
    shell.classList.toggle("wx-expanded", expanded);
    if (timer) clearTimeout(timer);
    if (expanded) {
      const cap = Math.max(baseMax + 160, Math.round((window.innerHeight || 900) * 0.7));
      target.style.maxHeight = Math.min(target.scrollHeight + 4, cap) + "px";
    } else {
      target.style.maxHeight = baseMax + "px";
      timer = setTimeout(() => {
        timer = 0;
        if (!expanded) target.style.maxHeight = "";
      }, CARD_ANIM_MS + 40);
    }
  });
  shell.appendChild(btn);

  queueSeed({
    node: shell,
    done: null,
    read: () => {
      const over = target.scrollHeight > target.clientHeight + 4;
      return {
        write: () => {
          btn.style.display = over ? "" : "none";
        },
      };
    },
  });
}

const GRID_H_SPACING = 0.012;
const GRID_V_SPACING_NUM = 0.3;
const GRID_V_SPACING_MIN = 0.006;
const GRID_ROW_PX = 54;
const GRID_PAD_PX = 40;
const GRID_ZONE_PAD_Y = 0.005;
const GRID_ZONE_EDGE_LEFT = 0.02;
const GRID_ZONE_EDGE_RIGHT = 0.01;
const GRID_Y_PAD = 0.05;
const GRID_CIRCULAR_COLS = new Set(["Dir"]);
const GRID_CIRCULAR_RANGE = [0, 360];
const GRID_COL_RE = /<\/b><br>([A-Za-z0-9_]+)/;
const DETAIL_COL_RE = /^([A-Za-z0-9_]+)/;

function gridColumnName(fig) {
  for (const tr of (fig && fig.data) || []) {
    if (!tr) continue;
    if (tr.meta && tr.meta.band_hover) continue;
    if (tr.meta && typeof tr.meta.col === "string" && tr.meta.col) {
      return tr.meta.col;
    }
    const ht = tr.hovertemplate;
    if (typeof ht !== "string") continue;
    const m = GRID_COL_RE.exec(ht);
    if (m) return m[1];
  }
  return null;
}

function detailColumnName(dpd) {
  for (const tr of (dpd && dpd.data) || []) {
    if (!tr || (tr.yaxis || "y") !== "y" || tr.mode === "markers") continue;
    const ht = tr.hovertemplate;
    if (typeof ht !== "string" || ht.indexOf(":") < 1) continue;
    const m = DETAIL_COL_RE.exec(ht);
    if (m) return m[1];
  }
  return null;
}

const STAMP_MS_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2})(?::(\d{2})(?::(\d{2})(\.\d+)?)?)?)?/;

function stampMs(v) {
  if (typeof v === "number") return v;
  if (v === null || v === undefined) return NaN;
  const m = STAMP_MS_RE.exec(String(v));
  if (!m) return NaN;
  const ms = Date.UTC(
    +m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)
  );
  return m[7] ? ms + Math.round(parseFloat(m[7]) * 1000) : ms;
}

function spanMs(range) {
  if (!Array.isArray(range) || range.length !== 2) return null;
  const a = stampMs(range[0]);
  const b = stampMs(range[1]);
  if (!isFinite(a) || !isFinite(b) || a === b) return null;
  return a < b ? [a, b] : [b, a];
}

const _traceTimes = new WeakMap();

function traceTimes(tr) {
  const x = tr && tr.x;
  if (!x || typeof x !== "object") return null;
  if (_traceTimes.has(x)) return _traceTimes.get(x);
  const src = decodeArray(x);
  let out = null;
  if (src && src.length) {
    out = new Float64Array(src.length);
    for (let i = 0; i < src.length; i++) {
      const t = stampMs(src[i]);
      if (!isFinite(t) || (i && t < out[i - 1])) {
        out = null;
        break;
      }
      out[i] = t;
    }
  }
  _traceTimes.set(x, out);
  return out;
}

function edgeValue(t, y, k, x) {
  if (k <= 0 || k >= y.length || y[k - 1] === null || y[k] === null) return NaN;
  const a = Number(y[k - 1]);
  const b = Number(y[k]);
  const dt = t[k] - t[k - 1];
  return dt > 0 ? a + ((b - a) * (x - t[k - 1])) / dt : b;
}

function sameRange(a, b) {
  if (!a || !b) return false;
  const a0 = Number(a[0]);
  const a1 = Number(a[1]);
  const b0 = Number(b[0]);
  const b1 = Number(b[1]);
  if (!isFinite(a0) || !isFinite(a1) || !isFinite(b0) || !isFinite(b1)) return false;
  const tol = (Math.abs(b1 - b0) || 1) * 1e-6;
  return Math.abs(a0 - b0) < tol && Math.abs(a1 - b1) < tol;
}

function detailFit(dpd, view) {
  if (!dpd) return null;
  if (typeof dpd._wxFitY === "function") {
    const own = dpd._wxFitY(view);
    if (own) return own;
  }
  return axisRange(dpd._fullLayout, "yaxis");
}

function stackYRange(fig, placed, base, view) {
  if (GRID_CIRCULAR_COLS.has(gridColumnName(fig))) return GRID_CIRCULAR_RANGE.slice();
  let lo = Infinity;
  let hi = -Infinity;
  for (const tr of (fig && fig.data) || []) {
    if (!placed.has(tr.xaxis || "x") || isAlertTrace(tr)) continue;
    const y = decodeArray(tr.y) || (Array.isArray(tr.y) ? tr.y : null);
    if (!y) continue;
    const times = view ? traceTimes(tr) : null;
    const t = times && times.length === y.length ? times : null;
    let i = 0;
    if (t) {
      let b = y.length;
      while (i < b) {
        const m = (i + b) >> 1;
        if (t[m] < view[0]) i = m + 1;
        else b = m;
      }
    }
    const first = i;
    for (; i < y.length; i++) {
      if (t && t[i] > view[1]) break;
      if (y[i] === null) continue;
      const v = Number(y[i]);
      if (!isFinite(v)) continue;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    if (!t) continue;
    const head = edgeValue(t, y, first, view[0]);
    const tail = edgeValue(t, y, i, view[1]);
    if (isFinite(head)) {
      if (head < lo) lo = head;
      if (head > hi) hi = head;
    }
    if (isFinite(tail)) {
      if (tail < lo) lo = tail;
      if (tail > hi) hi = tail;
    }
  }
  if (hi >= lo) {
    const span = hi - lo;
    const pad = span > 0 ? span * GRID_Y_PAD : Math.max(Math.abs(hi) * GRID_Y_PAD, 1);
    lo -= pad;
    hi += pad;
  } else if (!base) {
    return null;
  } else {
    lo = Infinity;
    hi = -Infinity;
  }
  if (base) {
    const b0 = Number(base[0]);
    const b1 = Number(base[1]);
    if (isFinite(b0) && isFinite(b1)) {
      lo = Math.min(lo, Math.min(b0, b1));
      hi = Math.max(hi, Math.max(b0, b1));
    }
  }
  return isFinite(lo) && isFinite(hi) && hi > lo ? [lo, hi] : null;
}

function gridCells(fig) {
  const layout = (fig && fig.layout) || {};
  const stations = gridAxisStations(fig);
  const out = [];
  for (const key of Object.keys(layout)) {
    if (!/^xaxis\d*$/.test(key)) continue;
    const ax = layout[key];
    if (!ax || !Array.isArray(ax.domain) || ax.visible === false) continue;
    const idx = key === "xaxis" ? "" : key.slice(5);
    const id = "x" + idx;
    const station = stations.get(id);
    if (!station) continue;
    const anchor =
      typeof ax.anchor === "string" && /^y\d*$/.test(ax.anchor) ? ax.anchor : "y" + idx;
    const ykey = "yaxis" + anchor.slice(1);
    const ay = layout[ykey];
    if (!ay || !Array.isArray(ay.domain)) continue;
    out.push({
      id: id,
      xkey: key,
      ykey: ykey,
      station: station,
      x0: ax.domain[0],
      x1: ax.domain[1],
      y0: ay.domain[0],
      y1: ay.domain[1],
      matches: typeof ax.matches === "string" ? ax.matches : null,
    });
  }
  return out;
}

function gridZoneKey(cell) {
  return cell.matches || cell.id;
}

function gridZoneFills(fig, cells) {
  const shapes = ((fig.layout && fig.layout.shapes) || []).filter(
    (s) => s && String(s.xref) === "paper" && String(s.yref) === "paper"
  );
  const boxes = new Map();
  for (const cell of cells) {
    const key = gridZoneKey(cell);
    const box = boxes.get(key);
    if (!box) {
      boxes.set(key, { x0: cell.x0, x1: cell.x1, y0: cell.y0, y1: cell.y1 });
      continue;
    }
    box.y0 = Math.min(box.y0, cell.y0);
    box.y1 = Math.max(box.y1, cell.y1);
  }
  const out = new Map();
  for (const [key, box] of boxes) {
    const cx = (box.x0 + box.x1) / 2;
    const cy = (box.y0 + box.y1) / 2;
    const hit = shapes.find(
      (s) =>
        Math.min(s.x0, s.x1) <= cx &&
        cx <= Math.max(s.x0, s.x1) &&
        Math.min(s.y0, s.y1) <= cy &&
        cy <= Math.max(s.y0, s.y1)
    );
    if (hit && hit.fillcolor) out.set(key, hit.fillcolor);
  }
  return out;
}

function packGrid(cells, selected, stack, align, rank) {
  const wanted = selected && selected.size
    ? cells.filter((c) => selected.has(c.station))
    : cells;
  const use = wanted.length ? wanted : cells;

  const order = [];
  const byCol = new Map();

  if (stack) {
    order.push({ key: "0", x0: 0 });
    const seat = rank && rank.size ? (c) => {
      const at = rank.get(c.station);
      return at === undefined ? Infinity : at;
    } : null;
    byCol.set("0", use.slice().sort(
      seat
        ? (a, b) => seat(a) - seat(b) || a.x0 - b.x0 || b.y0 - a.y0
        : (a, b) => a.x0 - b.x0 || b.y0 - a.y0
    ));
  } else {
    for (const cell of use) {
      const key = cell.x0.toFixed(4);
      if (!byCol.has(key)) {
        byCol.set(key, []);
        order.push({ key: key, x0: cell.x0 });
      }
      byCol.get(key).push(cell);
    }
    order.sort((a, b) => a.x0 - b.x0);
  }

  const cols = order.length;
  const spread = align && align[1] > align[0];
  const width = spread ? align[1] - align[0] : (1 - GRID_H_SPACING * (cols - 1)) / cols;
  let rows = 0;
  for (const col of order) rows = Math.max(rows, byCol.get(col.key).length);
  const gap = Math.max(GRID_V_SPACING_MIN, GRID_V_SPACING_NUM / Math.max(rows, 1));
  const height = (1 - gap * (rows - 1)) / rows;

  const colX = spread ? () => align[0] : (j) => j * (width + GRID_H_SPACING);
  const placed = new Map();
  const list = [];

  order.forEach((col, j) => {
    const items = stack
      ? byCol.get(col.key)
      : byCol.get(col.key).slice().sort((a, b) => b.y0 - a.y0);
    items.forEach((cell, i) => {
      const y1 = 1 - i * (height + gap);
      const spot = {
        cell: cell,
        col: j,
        x0: colX(j),
        x1: colX(j) + width,
        y0: Math.max(0, y1 - height),
        y1: y1,
      };
      placed.set(cell.id, spot);
      list.push(spot);
    });
  });

  return {
    placed: placed,
    list: list,
    cols: cols,
    rows: rows,
    width: width,
    colX: colX,
  };
}

function gridRowPx(fig, cells) {
  const total = (fig.layout && fig.layout.height) || 0;
  const rows = new Set(cells.map((c) => c.y0.toFixed(4))).size;
  if (!total || !rows) return GRID_ROW_PX;
  const px = (total - GRID_PAD_PX) / rows;
  return px > 8 ? px : GRID_ROW_PX;
}

function buildGridFigure(fig, cells, fills, rowPx, selected, link, ranges, rank) {
  const stack = !!(selected && selected.size);
  const align = stack && link && link.align ? link.align : null;
  const layout = cloneLayout(fig.layout);
  const pack = packGrid(cells, selected, stack, align, rank);
  const placed = pack.placed;

  for (const cell of cells) {
    const ax = layout[cell.xkey];
    const ay = layout[cell.ykey];
    const spot = placed.get(cell.id);
    if (!ax || !ay || !spot) continue;
    ax.visible = true;
    ay.visible = true;
    ax.domain = [spot.x0, spot.x1];
    ay.domain = [spot.y0, spot.y1];
  }

  if (stack) {
    for (const key of Object.keys(layout)) {
      if (!/^xaxis\d*$/.test(key)) continue;
      const ax = layout[key];
      if (!ax) continue;
      const idx = key === "xaxis" ? "" : key.slice(5);
      if (placed.has("x" + idx)) continue;
      const anchor =
        typeof ax.anchor === "string" && /^y\d*$/.test(ax.anchor) ? ax.anchor : "y" + idx;
      delete layout["yaxis" + anchor.slice(1)];
      delete layout[key];
    }
  } else {
    for (const cell of cells) {
      if (placed.has(cell.id)) continue;
      if (layout[cell.xkey]) layout[cell.xkey].visible = false;
      if (layout[cell.ykey]) layout[cell.ykey].visible = false;
    }
  }

  const groups = [];
  if (stack) {
    if (pack.list.length) groups.push(pack.list.map((spot) => spot.cell));
  } else {
    const zones = new Map();
    for (const spot of pack.list) {
      const key = gridZoneKey(spot.cell);
      if (!zones.has(key)) zones.set(key, []);
      zones.get(key).push(spot.cell);
    }
    for (const list of zones.values()) groups.push(list);
  }

  let anchorKey = null;
  let span = null;
  for (const list of groups) {
    list.sort((a, b) => placed.get(b.id).y1 - placed.get(a.id).y1);
    const anchor = list[0];
    delete layout[anchor.xkey].matches;
    anchorKey = anchor.xkey;
    for (const cell of list.slice(1)) layout[cell.xkey].matches = anchor.id;
    if (!ranges) continue;
    let r = null;
    for (const cell of list) {
      const hit = ranges.get(cell.station);
      if (hit) {
        r = hit;
        break;
      }
    }
    if (!r) continue;
    span = r;
    for (const cell of list) {
      const ax = layout[cell.xkey];
      if (!ax) continue;
      ax.range = [r[0], r[1]];
      ax.autorange = false;
    }
  }

  const byStation = new Map();
  for (const cell of cells) byStation.set(cell.station, cell);

  if (Array.isArray(layout.annotations)) {
    const kept = [];
    for (const a of layout.annotations) {
      const cell = a && typeof a.text === "string"
        ? byStation.get(a.text.replace(/<[^>]*>/g, "").trim())
        : null;
      if (!cell) {
        kept.push(a);
        continue;
      }
      const spot = placed.get(cell.id);
      if (!spot) {
        if (stack) continue;
        a.visible = false;
        kept.push(a);
        continue;
      }
      a.visible = true;
      a.y = spot.y1 - 0.002;
      if (!a.xref || a.xref === "paper") a.x = (spot.x0 + spot.x1) / 2;
      kept.push(a);
    }
    layout.annotations = kept;
  }

  const bands = [];
  if (stack) {
    let run = null;
    for (const spot of pack.list) {
      const key = gridZoneKey(spot.cell);
      if (!run || run.key !== key) {
        run = { key: key, spots: [] };
        bands.push(run);
      }
      run.spots.push(spot);
    }
  } else {
    const byZone = new Map();
    for (const spot of pack.list) {
      const key = gridZoneKey(spot.cell);
      if (!byZone.has(key)) byZone.set(key, { key: key, spots: [] });
      byZone.get(key).spots.push(spot);
    }
    for (const band of byZone.values()) bands.push(band);
  }

  const shapes = [];
  for (const band of bands) {
    const fill = fills.get(band.key);
    if (!fill) continue;
    const j = band.spots[0].col;
    const x0 = pack.colX(j);
    const x1 = x0 + pack.width;
    const left = j > 0
      ? (pack.colX(j - 1) + pack.width + x0) / 2
      : Math.max(0, x0 - GRID_ZONE_EDGE_LEFT);
    const right = j < pack.cols - 1
      ? (x1 + pack.colX(j + 1)) / 2
      : Math.min(1, x1 + GRID_ZONE_EDGE_RIGHT);
    let top = -Infinity;
    let bottom = Infinity;
    for (const spot of band.spots) {
      top = Math.max(top, spot.y1);
      bottom = Math.min(bottom, spot.y0);
    }
    shapes.push({
      type: "rect",
      xref: "paper",
      yref: "paper",
      x0: left,
      x1: right,
      y0: Math.max(0, bottom - GRID_ZONE_PAD_Y),
      y1: Math.min(1, top + GRID_ZONE_PAD_Y),
      fillcolor: fill,
      line: { width: 0 },
      layer: "below",
    });
  }

  for (const s of (fig.layout && fig.layout.shapes) || []) {
    const xref = s && s.xref ? String(s.xref) : "";
    if (!xref || xref === "paper" || xref.charAt(0) !== "x") continue;
    if (!placed.has(xref.split(" ")[0])) continue;
    shapes.push(deepClone(s));
  }
  layout.shapes = shapes;

  const data = [];
  for (const tr of fig.data || []) {
    const on = placed.has(tr.xaxis || "x");
    if (stack && !on) continue;
    const out = Object.assign({}, unifiedBandTrace(tr));
    out.visible = on ? true : false;
    data.push(out);
  }

  applyDetailHoverStyle(layout);

  if (stack) {
    if (link && link.range && anchorKey && layout[anchorKey]) {
      layout[anchorKey].range = link.range.slice();
      layout[anchorKey].autorange = false;
      span = link.range;
    }
  }

  let yRange = null;
  if (stack) {
    yRange = stackYRange(
      fig,
      placed,
      link && link.yRange ? link.yRange : null,
      spanMs(span)
    );
    if (yRange) {
      for (const cell of cells) {
        const ay = placed.has(cell.id) ? layout[cell.ykey] : null;
        if (!ay) continue;
        ay.range = yRange.slice();
        ay.autorange = false;
      }
    }
  }

  delete layout.width;
  layout.autosize = true;
  layout.height = Math.round(pack.rows * rowPx + GRID_PAD_PX);

  return {
    data: data,
    layout: layout,
    yRange: yRange,
    ids: stack ? new Set(placed.keys()) : null,
  };
}

const FOREIGN_AXIS_BASE = 900;

function retargetRef(ref, from, to) {
  if (typeof ref !== "string") return ref;
  const parts = ref.split(" ");
  if (parts[0] === from) parts[0] = to;
  return parts.join(" ");
}

function stationGridPart(fig, name) {
  if (!fig || !Array.isArray(fig.data)) return null;
  const key = neighbourKey(name);
  let xid = null;
  for (const [id, nm] of gridAxisStations(fig)) {
    if (neighbourKey(nm) === key) {
      xid = id;
      break;
    }
  }
  if (!xid) return null;
  const lay = fig.layout || {};
  const idx = xid === "x" ? "" : xid.slice(1);
  const xa = lay["xaxis" + idx];
  if (!xa) return null;
  const yid =
    typeof xa.anchor === "string" && /^y\d*$/.test(xa.anchor) ? xa.anchor : "y" + idx;
  const ya = lay["yaxis" + yid.slice(1)];
  if (!ya) return null;
  const strip = (t) => neighbourKey(String(t).replace(/<[^>]*>/g, ""));
  return {
    name: name,
    xid: xid,
    yid: yid,
    xaxis: xa,
    yaxis: ya,
    traces: fig.data
      .filter((tr) => tr && (tr.xaxis || "x") === xid)
      .map((tr) => unifiedBandTrace(tr, lay)),
    shapes: (lay.shapes || []).filter(
      (sh) => sh && typeof sh.xref === "string" && sh.xref.split(" ")[0] === xid
    ),
    annotation:
      (lay.annotations || []).find(
        (a) => a && typeof a.text === "string" && strip(a.text) === key
      ) || null,
  };
}

function overlayColor(i) {
  return NEIGHBOUR_PALETTE[i % NEIGHBOUR_PALETTE.length];
}

const NEIGHBOUR_MAP_DEM_TILES =
  "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";

const NEIGHBOUR_MAP_ATTRIBUTION =
  "Elevation: Terrain Tiles, Mapzen / AWS Open Data " +
  "(SRTM, GMTED2010, ETOPO1, NRCan CDEM, USGS NED)";

const NEIGHBOUR_MAP_WIDTH = 360;

const NEIGHBOUR_MAP_HEIGHT = 200;

const NEIGHBOUR_MAP_WIDTH_EXPANDED = 640;

const NEIGHBOUR_MAP_HEIGHT_EXPANDED = 420;

const NEIGHBOUR_MAP_ZOOM_PAD = 0.8;

const NEIGHBOUR_MAP_LABEL_GAP = 3;

const NEIGHBOUR_MAP_EDGE = 2;

const NEIGHBOUR_MAP_ATTRIB_WAIT_MS = 15000;

const NEIGHBOUR_MAP_MATCH_MS = 30 * 60 * 1000;

const NEIGHBOUR_MAP_RAIN_COL = "Rn_1";

const RAIN_MIN_R = 9;

const RAIN_MAX_R = 32;

const RAIN_CAP_MM = 10;

function rainRadius(mm) {
  const f = Math.sqrt(Math.min(mm, RAIN_CAP_MM) / RAIN_CAP_MM);
  return Math.round(RAIN_MIN_R + (RAIN_MAX_R - RAIN_MIN_R) * f);
}

const NEIGHBOUR_MAP_RING_PX = 2;

const NEIGHBOUR_MAP_CAND_PX = 6;

const NEIGHBOUR_MAP_STATION_PX = 7;

const NEIGHBOUR_MAP_STATION_COLOR = "#6b665e";

const NEIGHBOUR_MAP_NEIGHBOUR_COLOR = "#2c5fa9";

const NEIGHBOUR_MAP_LINE_COLOR = "#8a857d";

const NEIGHBOUR_MAP_STAR_PX = 16;

const BARB_BOX = 56;

const BARB_HALF = BARB_BOX / 2;

const BARB_STAFF = 20;

const BARB_FEATHER = 9;

const BARB_SLANT = 3;

const BARB_STEP = 4;

const BARB_PENNANT = 5;

const BARB_UNIT = 5;

const BARB_CALM_R = 4.5;

const BARB_DOT_R = 2.4;

const BARB_STROKE = 1.6;

const BARB_HALO = 3.8;

const BARB_SPEED_KEY = "station_grid";

const BARB_DIR_KEY = "station_grid_dir";

const BARB_SPEED_COL = "Wspd";

const MAP_STAR_PATH =
  "M12 2.2l2.95 6.2 6.8.8-5.03 4.67 1.33 6.73L12 17.25 5.95 20.6l1.33-6.73L2.25 9.2l6.8-.8z";

const MAP_TIP_ALERTS = 3;

const MAP_HINT_OPEN = "Click to open";

const MAP_MIN_ICON =
  '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
  '<path d="M3.5 8h9"/></svg>';

const MAP_PILL_ICON =
  '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
  '<path d="M1.8 4.2 5.8 2.5l4.4 1.8 4-1.7v9.2l-4 1.7-4.4-1.8-4 1.7z' +
  'M5.8 2.5v9.2M10.2 4.3v9.2"/></svg>';

const NEIGHBOUR_MAP_RING_FALLBACK = "#8a857d";

const NEIGHBOUR_MAP_UNITS = {
  Rh: { unit: "%", gap: "", digits: 0 },
  Temp: { unit: "\u00b0C", gap: "", digits: 1 },
  Wspd: { unit: "km/h", gap: " ", digits: 1 },
  Mx_Spd: { unit: "km/h", gap: " ", digits: 1 },
  Dir: { unit: "°", gap: "", digits: 0 },
  Rn_1: { unit: "mm", gap: " ", digits: 1 },
  Vbat: { unit: "V", gap: " ", digits: 1 },
};

const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const NEIGHBOUR_MAP_ZOOM_MIN = 3;

const NEIGHBOUR_MAP_ZOOM_MAX = 12;

const NEIGHBOUR_MAP_MIN_SPAN_DEG = 0.02;

const NEIGHBOUR_MAP_HALO = "#ffffff";

const NEIGHBOUR_MAP_PAPER = "#f3f2ef";

const NEIGHBOUR_MAP_FONT =
  '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';

const NEIGHBOUR_MAP_STYLE = {
  version: 8,
  sources: {
    dem: {
      type: "raster-dem",
      tiles: [NEIGHBOUR_MAP_DEM_TILES],
      tileSize: 256,
      maxzoom: 15,
      encoding: "terrarium",
      attribution: NEIGHBOUR_MAP_ATTRIBUTION,
    },
  },
  layers: [
    {
      id: "paper",
      type: "background",
      paint: { "background-color": NEIGHBOUR_MAP_PAPER },
    },
    {
      id: "relief-fill",
      type: "hillshade",
      source: "dem",
      paint: {
        "hillshade-illumination-direction": 20,
        "hillshade-exaggeration": [
          "interpolate", ["linear"], ["zoom"], 5, 0.12, 9, 0.2, 12, 0.28,
        ],
        "hillshade-shadow-color": "#857b6d",
        "hillshade-highlight-color": "#fffdf8",
        "hillshade-accent-color": "#a39a8c",
      },
    },
    {
      id: "relief",
      type: "hillshade",
      source: "dem",
      paint: {
        "hillshade-illumination-direction": 315,
        "hillshade-exaggeration": [
          "interpolate", ["linear"], ["zoom"], 5, 0.3, 9, 0.45, 12, 0.6,
        ],
        "hillshade-shadow-color": "#6f665a",
        "hillshade-highlight-color": "#fffdf8",
        "hillshade-accent-color": "#9a9184",
      },
    },
  ],
};

const MAP_SCALE_MAX_PX = 80;

const MAP_TILE_WAIT_MS = 5000;

const MAP_ZOOM_LABEL_STEP = 1.2;

const MAP_EASE_MS = 300;

const MAP_EARTH_CIRC_M = 2 * Math.PI * 6378137;

function mapScaleStep(lat, zoom) {
  const mpp =
    (MAP_EARTH_CIRC_M * Math.cos((lat * Math.PI) / 180)) / (512 * Math.pow(2, zoom));
  if (!(mpp > 0)) return null;
  const most = mpp * MAP_SCALE_MAX_PX;
  const base = Math.pow(10, Math.floor(Math.log10(most)));
  const nice = [5, 2, 1].map((k) => k * base).find((v) => v <= most) || base;
  return {
    px: Math.round(nice / mpp),
    text: nice >= 1000 ? `${nice / 1000} km` : `${nice} m`,
  };
}

const EARTH_RADIUS_KM = 6371;

function ensureNeighbourMapStyles() {
  if (document.getElementById("wx-nbmap-styles")) return;
  ensureCardExpandStyles();
  const st = document.createElement("style");
  st.id = "wx-nbmap-styles";
  st.textContent = [
    ".wx-nb-map-park{position:fixed;left:-100000px;top:0;width:max-content;",
    "visibility:hidden;pointer-events:none;}",
    ".wx-nb-stack{display:flex;align-items:stretch;margin-bottom:16px;}",
    ".wx-nb-main{flex:1 1 auto;min-width:0;}",
    ".wx-nb-main > :last-child{margin-bottom:0;}",
    ".wx-nb-map-slot{flex:0 0 auto;min-width:0;}",
    ".wx-nb-stack.has-map > .wx-nb-map-slot{margin-left:12px;}",
    ".wx-nb-map{display:none;position:sticky;top:0;z-index:5;",
    "background:" + NEIGHBOUR_MAP_PAPER + ";border:1px solid var(--line,#e8e6e3);",
    "border-radius:10px;box-shadow:0 1px 3px rgba(0,0,0,.04);overflow:hidden;}",
    ".wx-nb-map.show{display:block;}",
    ".wx-nb-map:hover .wx-expand-btn{opacity:1;}",
    ".wx-nb-map .wx-nb-map-min{right:38px;}",
    ".wx-nb-map-pill{display:none;align-items:center;gap:6px;font-family:inherit;",
    "font-size:11px;font-weight:600;letter-spacing:.01em;color:var(--text,#26231f);",
    "background:#fff;border:none;padding:6px 12px;margin:0;cursor:pointer;}",
    ".wx-nb-map-pill:hover{background:#f3f2ef;}",
    ".wx-nb-map-pill svg{width:13px;height:13px;fill:none;stroke:currentColor;",
    "stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round;}",
    ".wx-nb-map.collapsed{border-radius:999px;}",
    ".wx-nb-map.collapsed .wx-nb-map-pill{display:inline-flex;}",
    ".wx-nb-map.collapsed > :not(.wx-nb-map-pill){display:none!important;}",
    ".wx-nb-map.wx-nb-map-fixed .wx-expand-btn,.wx-nb-map.wx-nb-map-fixed .wx-nb-map-min,",
    ".wx-nb-map.wx-nb-map-fixed .wx-nb-map-pill{display:none!important;}",
    ".wx-nb-map .wx-expand-btn{background:rgba(255,255,255,.85);",
    "border-color:var(--line,#e8e6e3);}",
    ".wx-nb-map .wx-expand-btn:hover{background:#fff;}",
    ".wx-nb-map-plot{display:block;}",
    ".wx-nb-map-plot,.wx-nb-map-labels,.wx-nb-map-scale{transition:opacity .2s ease;}",
    ".wx-nb-map.wx-nb-map-wait .wx-nb-map-plot,.wx-nb-map.wx-nb-map-wait .wx-nb-map-labels,",
    ".wx-nb-map.wx-nb-map-wait .wx-nb-map-scale{opacity:0;transition:none;}",
    ".wx-nb-map-labels{position:absolute;left:0;top:0;right:0;bottom:0;",
    "pointer-events:none;overflow:hidden;z-index:2;}",
    ".wx-nb-map-labels > span{position:absolute;left:0;top:0;white-space:nowrap;",
    "font-size:10px;line-height:13px;font-weight:600;color:var(--text,#26231f);",
    "padding:1px 4px;border-radius:4px;background:rgba(255,255,255,.62);}",
    ".wx-nb-map.wx-expanded .wx-nb-map-labels > span{font-size:12px;line-height:16px;",
    "padding:1px 6px;}",
    ".wx-nb-map-labels > span.focus{font-weight:700;}",
    ".wx-nb-map-labels .km{color:#5f5a52;font-weight:500;}",
    ".wx-nb-map-labels .val{font-weight:700;}",
    ".wx-nb-map-labels .none{color:var(--text-muted,#8a857d);font-weight:500;}",
    ".wx-nb-map-labels > span.off{color:var(--text-muted,#8a857d);}",
    ".wx-nb-map-labels > i{position:absolute;left:0;top:0;box-sizing:border-box;",
    "border-radius:50%;border:2px solid transparent;",
    "box-shadow:0 0 0 2px #fff;}",
    ".wx-nb-map-labels > i{pointer-events:auto;cursor:pointer;}",
    ".wx-nb-map-labels > i.focus{cursor:default;}",
    ".wx-nb-map-labels > i.star{border:none;border-radius:50%;box-shadow:none;}",
    ".wx-nb-map-labels > i.star svg{display:block;width:100%;height:100%;overflow:visible;}",
    ".wx-nb-map-labels > i.star path{stroke:#fff;stroke-width:2.2;stroke-linejoin:round;",
    "paint-order:stroke;}",
    ".wx-nb-map-labels > i.cand{background:#c9c4bc;border-color:#c9c4bc;}",
    ".wx-nb-map-labels > i.cand:hover{background:#8a857d;border-color:#8a857d;}",
    ".wx-nb-map-labels > i.ext{cursor:default;}",
    ".wx-nb-map-labels > i.cand.ext:hover{background:#c9c4bc;border-color:#c9c4bc;}",
    ".wx-nb-map-labels > i.hit{background:#2c5fa9!important;border-color:#2c5fa9!important;",
    "box-shadow:0 0 0 2px #fff,0 0 0 4px rgba(44,95,169,.3);z-index:1;}",
    ".wx-nb-map-tip{position:absolute;left:0;top:0;z-index:5;display:none;",
    "pointer-events:none;padding:5px 8px;border-radius:6px;",
    "color:var(--text,#26231f);background:var(--surface,#fff);",
    "border:1px solid var(--line,#e8e6e3);box-shadow:0 1px 3px rgba(0,0,0,.04);",
    "white-space:nowrap;max-width:calc(100% - 8px);box-sizing:border-box;}",
    ".wx-nb-map-tip > div{overflow:hidden;text-overflow:ellipsis;}",
    ".wx-nb-map-tip .n{font-size:11px;line-height:16px;font-weight:600;",
    "letter-spacing:-.01em;}",
    ".wx-nb-map-tip .a{display:flex;align-items:center;gap:6px;margin-top:3px;",
    "font-size:10px;line-height:13px;font-weight:500;letter-spacing:.03em;color:#a9a49c;}",
    ".wx-nb-map-tip .a span{overflow:hidden;text-overflow:ellipsis;}",
    ".wx-nb-map-tip .a i{flex:0 0 auto;width:3px;height:11px;border-radius:1px;}",
    ".wx-nb-map-tip .a.more{display:block;padding-left:9px;}",
    ".wx-nb-map-tip.on{display:block;}",
    ".wx-nb-map-labels > i.off{opacity:.35;}",
    ".wx-nb-map-labels > i.wx-nb-map-barb{border:none;border-radius:0;box-shadow:none;",
    "background:none;pointer-events:none;cursor:default;}",
    ".wx-nb-map-labels > i.wx-nb-map-barb svg{display:block;width:100%;height:100%;",
    "overflow:visible;}",
    ".wx-nb-map-labels > i.barbed{background:transparent!important;",
    "border-color:transparent!important;box-shadow:none;}",
    ".wx-nb-map-labels > i.barbed svg{visibility:hidden;}",
    ".wx-nb-map-labels > i.wx-nb-map-rain{border-radius:50%;",
    "border:1px solid rgba(44,111,199,.35);background:rgba(44,111,199,.2);",
    "box-shadow:none;pointer-events:none;cursor:default;}",
    ".wx-nb-map-labels > b.wx-nb-map-dist{position:absolute;left:0;top:0;",
    "white-space:nowrap;font-size:9px;line-height:11px;font-weight:600;color:#6f6a62;",
    "padding:0 3px;border-radius:3px;background:rgba(243,242,239,.85);pointer-events:none;}",
    ".wx-nb-map.wx-expanded .wx-nb-map-labels > b.wx-nb-map-dist{font-size:10px;",
    "line-height:13px;}",
    ".wx-nb-map-labels > span.hot{z-index:1;background:rgba(255,255,255,.95);",
    "box-shadow:0 0 0 1px rgba(38,35,31,.28);}",
    ".wx-nb-map-labels > i.hot{filter:drop-shadow(0 0 2px rgba(38,35,31,.7));}",
    ".wx-nb-map-labels > span.peek{z-index:1;background:rgba(255,255,255,.95);",
    "box-shadow:0 0 0 1px rgba(38,35,31,.28);}",
    ".wx-nb-map-labels > span.zl{font-weight:500;animation:wx-zl-in .2s ease;}",
    "@keyframes wx-zl-in{from{opacity:0;}to{opacity:1;}}",
    ".wx-nb-map-labels > i.peek{filter:drop-shadow(0 0 2px rgba(38,35,31,.7));}",
    ".wx-nb-map-time{position:absolute;left:8px;top:8px;z-index:3;display:none;",
    "padding:2px 7px;border-radius:6px;font-size:10px;font-weight:600;",
    "letter-spacing:.02em;color:var(--text,#26231f);background:rgba(255,255,255,.85);",
    "border:1px solid var(--line,#e8e6e3);pointer-events:none;}",
    ".wx-nb-map-time.on{display:block;}",
    ".wx-nb-map-scale{position:absolute;left:8px;bottom:8px;z-index:3;display:none;",
    "box-sizing:border-box;padding:0 3px;font-size:9px;line-height:12px;font-weight:600;",
    "color:#5f5a52;border:1.5px solid #5f5a52;border-top:none;",
    "background:rgba(255,255,255,.6);pointer-events:none;white-space:nowrap;}",
    ".wx-nb-map-scale.on{display:block;}",
    ".wx-nb-map .maplibregl-ctrl-attrib{font-size:9px;",
    "background:rgba(255,255,255,.75)!important;color:var(--text-muted,#8a857d);}",
    ".wx-nb-map .maplibregl-ctrl-attrib a{color:var(--text-muted,#8a857d);}",
    "@media (max-width:768px){.wx-nb-stack{flex-direction:column;margin-bottom:10px;}",
    ".wx-nb-map-slot{order:-1;max-width:100%;}",
    ".wx-nb-stack.has-map > .wx-nb-map-slot{margin-left:0;}",
    ".wx-nb-map{position:relative;top:auto!important;max-width:100%;",
    "margin-bottom:10px;box-shadow:none;}",
    ".wx-nb-map.collapsed{display:none!important;}",
    ".wx-nb-map .wx-nb-map-min,.wx-nb-map-pill{display:none!important;}}",
  ].join("");
  document.head.appendChild(st);
}

function distanceKm(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function elevationDiff(here, at) {
  if (!here || !at || !Number.isFinite(here.elev) || !Number.isFinite(at.elev)) return null;
  const d = Math.round(at.elev - here.elev);
  if (d > 0) return `\u25b2${d} m`;
  if (d < 0) return `\u25bc${Math.abs(d)} m`;
  return "\u00b10 m";
}

function lineMeta(here, at) {
  const km = distanceLabel(distanceKm(here, at));
  const dz = elevationDiff(here, at);
  return dz ? `${km} ${dz}` : km;
}

function neighbourMeta(here, at) {
  const km = distanceLabel(distanceKm(here, at));
  const dz = elevationDiff(here, at);
  return dz ? `${km}, ${dz}` : km;
}

function placeMeta(at) {
  return at && Number.isFinite(at.elev) ? `${Math.round(at.elev)} m` : null;
}

function focusMeta(here) {
  return here && Number.isFinite(here.elev) ? `${Math.round(here.elev)} m` : null;
}

function distanceLabel(km) {
  return km >= 1 ? `${Math.round(km)} km` : `${km.toFixed(1)} km`;
}

function neighbourMapView(points, w, h) {
  const mercY = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
  let lonLo = Infinity;
  let lonHi = -Infinity;
  let yLo = Infinity;
  let yHi = -Infinity;
  for (const p of points) {
    const y = mercY(p.lat);
    lonLo = Math.min(lonLo, p.lon);
    lonHi = Math.max(lonHi, p.lon);
    yLo = Math.min(yLo, y);
    yHi = Math.max(yHi, y);
  }
  const lonSpan = Math.max(lonHi - lonLo, NEIGHBOUR_MAP_MIN_SPAN_DEG);
  const ySpan = Math.max(yHi - yLo, (NEIGHBOUR_MAP_MIN_SPAN_DEG * Math.PI) / 180);
  const zx = Math.log2((w * 360) / (512 * lonSpan));
  const zy = Math.log2((h * 2 * Math.PI) / (512 * ySpan));
  const zoom = Math.max(
    NEIGHBOUR_MAP_ZOOM_MIN,
    Math.min(NEIGHBOUR_MAP_ZOOM_MAX, Math.min(zx, zy) - NEIGHBOUR_MAP_ZOOM_PAD)
  );
  const yMid = (yLo + yHi) / 2;
  return {
    center: {
      lon: (lonLo + lonHi) / 2,
      lat: ((2 * Math.atan(Math.exp(yMid)) - Math.PI / 2) * 180) / Math.PI,
    },
    zoom: zoom,
  };
}

function neighbourMapProject(view, w, h) {
  const scale = 512 * Math.pow(2, view.zoom);
  const fx = (lon) => ((lon + 180) / 360) * scale;
  const fy = (lat) => {
    const r = (lat * Math.PI) / 180;
    return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * scale;
  };
  const cx = fx(view.center.lon);
  const cy = fy(view.center.lat);
  return (lon, lat) => ({ x: fx(lon) - cx + w / 2, y: fy(lat) - cy + h / 2 });
}

function gridTimeMs(v) {
  if (typeof v === "number") return v;
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(String(v));
  if (!m) return NaN;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
}

function mapTimeLabel(ms) {
  const d = new Date(ms);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${MONTH_ABBR[d.getUTCMonth()]} ${d.getUTCDate()} ${hh}:${mm}`;
}

function mapValueText(v, col) {
  const u = NEIGHBOUR_MAP_UNITS[col] || { unit: "", gap: "", digits: 1 };
  return v.toFixed(u.digits) + (u.unit ? u.gap + u.unit : "");
}

function gridSeriesAt(series, xval) {
  if (!series || !series.t.length) return null;
  const t = series.t;
  let lo = 0;
  let hi = t.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (t[mid] < xval) lo = mid + 1;
    else hi = mid;
  }
  let best = -1;
  let gap = Infinity;
  for (const i of [lo - 1, lo]) {
    if (i < 0 || i >= t.length) continue;
    const d = Math.abs(t[i] - xval);
    if (d < gap) {
      gap = d;
      best = i;
    }
  }
  if (best < 0 || gap > NEIGHBOUR_MAP_MATCH_MS) return null;
  const v = series.v[best];
  return isFinite(v) ? v : null;
}

function gridStationSeries(data, source, axisStations, col) {
  const out = new Map();
  (source || []).forEach((tr, i) => {
    if (!tr || isAlertTrace(tr)) return;
    const ht = typeof tr.hovertemplate === "string" ? tr.hovertemplate : "";
    const m = GRID_COL_RE.exec(ht);
    const label = (tr.meta && tr.meta.col) || (m ? m[1] : null);
    if (col && label !== col) return;
    const name = axisStations.get(tr.xaxis || "x");
    if (!name) return;
    const use = data[i] || tr;
    const xs = decodeArray(use.x);
    const ys = decodeArray(use.y);
    if (!xs || !ys) return;
    let s = out.get(name);
    if (!s) {
      s = { pts: [] };
      out.set(name, s);
    }
    for (let k = 0; k < xs.length && k < ys.length; k++) {
      const t = gridTimeMs(xs[k]);
      const y = ys[k] === null || ys[k] === undefined ? NaN : Number(ys[k]);
      if (isFinite(t)) s.pts.push([t, y]);
    }
  });
  for (const [name, s] of out) {
    s.pts.sort((a, b) => a[0] - b[0]);
    out.set(name, { t: s.pts.map((p) => p[0]), v: s.pts.map((p) => p[1]) });
  }
  return out;
}

function gridAlertMarks(fig, axisStations) {
  const out = new Map();
  const add = (name, mark) => {
    const key = neighbourKey(name);
    if (!out.has(key)) out.set(key, []);
    out.get(key).push(mark);
  };
  for (const sh of (fig && fig.layout && fig.layout.shapes) || []) {
    if (!sh || sh.type !== "rect" || typeof sh.xref !== "string") continue;
    const name = axisStations.get(sh.xref);
    const color = solid(sh.fillcolor);
    if (!name || !color) continue;
    const a = gridTimeMs(sh.x0);
    const b = gridTimeMs(sh.x1);
    if (!isFinite(a) || !isFinite(b)) continue;
    add(name, { x0: Math.min(a, b), x1: Math.max(a, b), color: color });
  }
  for (const tr of (fig && fig.data) || []) {
    if (!tr || tr.mode !== "markers" || tr.hovertemplate) continue;
    if (tr.meta && tr.meta.band_hover) continue;
    const name = axisStations.get(tr.xaxis || "x");
    if (!name) continue;
    const xs = decodeArray(tr.x) || [];
    const raw = tr.marker && tr.marker.color;
    const colors = decodeArray(raw);
    const flat = typeof raw === "string" ? raw : null;
    for (let i = 0; i < xs.length; i++) {
      const t = gridTimeMs(xs[i]);
      const color = solid((colors && colors[i]) || flat);
      if (!isFinite(t) || !color) continue;
      add(name, {
        x0: t - NEIGHBOUR_MAP_MATCH_MS,
        x1: t + NEIGHBOUR_MAP_MATCH_MS,
        color: color,
      });
    }
  }
  return out;
}

function gridAlertsAt(marks, xval) {
  const out = new Map();
  for (const [key, list] of marks) {
    for (const m of list) {
      if (xval >= m.x0 && xval < m.x1) {
        out.set(key, m.color);
        break;
      }
    }
  }
  return out;
}

function windowAlertInfo(findings) {
  const out = new Map();
  const ranked = (findings || [])
    .filter((f) => f && f.station && f.section)
    .slice()
    .sort((a, b) => ovSeverity(b) - ovSeverity(a));
  for (const f of ranked) {
    const key = neighbourKey(f.station);
    if (!out.has(key)) out.set(key, []);
    const list = out.get(key);
    if (list.some((x) => x.section === f.section)) continue;
    list.push({ section: f.section, color: solid(f.color) || NEIGHBOUR_MAP_RING_FALLBACK });
  }
  return out;
}

function windowAlertColors(findings) {
  const best = new Map();
  for (const f of findings || []) {
    if (!f || !f.station) continue;
    const key = neighbourKey(f.station);
    const sev = ovSeverity(f);
    const have = best.get(key);
    if (have && have.sev >= sev) continue;
    best.set(key, { sev: sev, color: solid(f.color) || NEIGHBOUR_MAP_RING_FALLBACK });
  }
  const out = new Map();
  for (const [key, v] of best) out.set(key, v.color);
  return out;
}

function neighbourMapLabel(label, name, km, focus) {
  label.node.className = focus ? "focus" : "";
  label.node.innerHTML = "";
  label.node.appendChild(document.createTextNode(km ? name + " " : name));
  if (km) label.node.appendChild(el("span", "km", `(${km})`));
  label.dot.classList.remove("off");
}

function neighbourMapReading(label, name, km, focus, reading) {
  const off = reading.value === null;
  label.node.className = (focus ? "focus" : "") + (off ? " off" : "");
  label.node.innerHTML = "";
  label.node.appendChild(document.createTextNode(km ? `${name} (${km}) ` : name + " "));
  label.node.appendChild(
    off ? el("span", "none", "no data") : el("span", "val", reading.text)
  );
  label.dot.classList.toggle("off", off);
}

function windBarbParts(speed) {
  const n = Math.round(speed / BARB_UNIT) * BARB_UNIT;
  const c = BARB_HALF;
  const tip = c - BARB_STAFF;
  if (n < BARB_UNIT) {
    return `<circle cx="${c}" cy="${c}" r="${BARB_CALM_R}" fill="none"/>`;
  }
  let rest = n;
  const pennants = Math.floor(rest / 50);
  rest -= pennants * 50;
  const fulls = Math.floor(rest / 10);
  rest -= fulls * 10;
  const half = rest >= 5;
  let out = `<path d="M${c} ${c}L${c} ${tip}" fill="none"/>`;
  let y = tip;
  for (let i = 0; i < pennants; i++) {
    out +=
      `<polygon points="${c},${y} ${c + BARB_FEATHER},${y - BARB_SLANT} ` +
      `${c},${y + BARB_PENNANT}"/>`;
    y += BARB_PENNANT + 2;
  }
  for (let i = 0; i < fulls; i++) {
    out += `<path d="M${c} ${y}L${c + BARB_FEATHER} ${y - BARB_SLANT}" fill="none"/>`;
    y += BARB_STEP;
  }
  if (half) {
    if (!pennants && !fulls) y += BARB_STEP;
    out +=
      `<path d="M${c} ${y}L${c + BARB_FEATHER / 2} ${y - BARB_SLANT / 2}" fill="none"/>`;
  }
  return out;
}

function windBarbSvg(speed, dir, color) {
  const c = BARB_HALF;
  const parts = windBarbParts(speed);
  return (
    `<svg viewBox="0 0 ${BARB_BOX} ${BARB_BOX}" aria-hidden="true" focusable="false">` +
    `<g transform="rotate(${dir} ${c} ${c})" stroke-linecap="round" stroke-linejoin="round">` +
    `<g stroke="#fff" fill="#fff" stroke-width="${BARB_HALO}">${parts}</g>` +
    `<g stroke="${color}" fill="${color}" stroke-width="${BARB_STROKE}">${parts}</g>` +
    `</g><circle cx="${c}" cy="${c}" r="${BARB_DOT_R}" fill="${color}" ` +
    `stroke="#fff" stroke-width="1.2"/></svg>`
  );
}

function boxesOverlap(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

function placeNeighbourLabels(labels, at, w, h, hold) {
  const reach = (l) => (l.barbRoom ? BARB_STAFF : l.size / 2);
  const marks = labels.map((l, i) => {
    const p = at[i];
    const r = reach(l) + 2;
    return { x: p.x - r, y: p.y - r, w: 2 * r, h: 2 * r };
  });
  const placed = [];
  labels.forEach((l, i) => {
    const p = at[i];
    const lw = l.node.offsetWidth;
    const lh = l.node.offsetHeight;
    const gap = reach(l) + NEIGHBOUR_MAP_LABEL_GAP;
    const spots = [
      { x: p.x + gap, y: p.y - lh / 2 },
      { x: p.x - gap - lw, y: p.y - lh / 2 },
      { x: p.x - lw / 2, y: p.y - gap - lh },
      { x: p.x - lw / 2, y: p.y + gap },
      { x: p.x + gap - 2, y: p.y - gap - lh + 2 },
      { x: p.x - gap - lw + 2, y: p.y - gap - lh + 2 },
      { x: p.x + gap - 2, y: p.y + gap - 2 },
      { x: p.x - gap - lw + 2, y: p.y + gap - 2 },
    ].map((q) => ({ x: q.x, y: q.y, w: lw, h: lh }));
    const inside = (q) =>
      q.x >= NEIGHBOUR_MAP_EDGE &&
      q.y >= NEIGHBOUR_MAP_EDGE &&
      q.x + q.w <= w - NEIGHBOUR_MAP_EDGE &&
      q.y + q.h <= h - NEIGHBOUR_MAP_EDGE;
    const clear = (q) =>
      !placed.some((o) => boxesOverlap(q, o)) &&
      !marks.some((m, j) => j !== i && boxesOverlap(q, m));
    let at0 = !l.optional && hold && Number.isInteger(l.spot) ? l.spot : -1;
    if (at0 < 0) at0 = spots.findIndex((q) => inside(q) && clear(q));
    const dropped = !!l.optional && at0 < 0;
    if (at0 < 0) at0 = spots.findIndex((q) => inside(q));
    if (at0 < 0) at0 = 0;
    l.spot = at0;
    const pick = spots[at0];
    l.node.style.visibility = dropped ? "hidden" : "";
    if (!dropped) placed.push(pick);
    l.node.style.transform = `translate(${Math.round(pick.x)}px,${Math.round(pick.y)}px)`;
    if (l.dot) {
      l.dot.style.transform =
        `translate(${Math.round(p.x - l.size / 2)}px,${Math.round(p.y - l.size / 2)}px)`;
      l.dot._x = p.x;
      l.dot._y = p.y;
    }
    if (l.rain && l.rainR) {
      l.rain.style.transform =
        `translate(${Math.round(p.x - l.rainR)}px,${Math.round(p.y - l.rainR)}px)`;
    }
    if (l.barb) {
      l.barb.style.transform =
        `translate(${Math.round(p.x - BARB_HALF)}px,${Math.round(p.y - BARB_HALF)}px)`;
    }
  });
  const hubAt = labels.findIndex((l) => l.isFocus);
  const hub = hubAt >= 0 ? at[hubAt] : null;
  labels.forEach((l, i) => {
    if (!l.dist) return;
    l.dist.style.display = hub ? "" : "none";
    if (!hub) return;
    const p = at[i];
    const dw = l.dist.offsetWidth;
    const dh = l.dist.offsetHeight;
    const len = Math.hypot(p.x - hub.x, p.y - hub.y);
    const room = reach(l) + reach(labels[hubAt]) + 2 * NEIGHBOUR_MAP_LABEL_GAP;
    const box = {
      x: (p.x + hub.x) / 2 - dw / 2,
      y: (p.y + hub.y) / 2 - dh / 2,
      w: dw,
      h: dh,
    };
    const ok =
      len - room >= Math.hypot(dw, dh) &&
      box.x >= NEIGHBOUR_MAP_EDGE &&
      box.y >= NEIGHBOUR_MAP_EDGE &&
      box.x + dw <= w - NEIGHBOUR_MAP_EDGE &&
      box.y + dh <= h - NEIGHBOUR_MAP_EDGE &&
      !placed.some((o) => boxesOverlap(box, o)) &&
      !marks.some((m) => boxesOverlap(box, m));
    l.dist.style.visibility = ok ? "" : "hidden";
    l.dist.style.transform = `translate(${Math.round(box.x)}px,${Math.round(box.y)}px)`;
    if (ok) placed.push(box);
  });
}

function collapseMapAttribution(plot) {
  const fold = () => {
    const box = plot.querySelector(".maplibregl-ctrl-attrib.maplibregl-compact-show");
    if (!box) return false;
    box.classList.remove("maplibregl-compact-show");
    box.removeAttribute("open");
    return true;
  };
  if (fold()) return () => {};
  const watch = new MutationObserver(() => {
    if (fold()) stop();
  });
  const timer = setTimeout(() => stop(), NEIGHBOUR_MAP_ATTRIB_WAIT_MS);
  const stop = () => {
    watch.disconnect();
    clearTimeout(timer);
  };
  watch.observe(plot, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["class", "open"],
  });
  return stop;
}

let _sharedNeighbourMap = null;

let _mapHolder = null;

function mapHolder() {
  if (_mapHolder && _mapHolder.isConnected) return _mapHolder;
  ensureNeighbourMapStyles();
  _mapHolder = el("div", "wx-nb-map-park");
  _mapHolder.setAttribute("aria-hidden", "true");
  document.body.appendChild(_mapHolder);
  return _mapHolder;
}

function sharedNeighbourMap() {
  if (!_sharedNeighbourMap) _sharedNeighbourMap = neighbourMap();
  return _sharedNeighbourMap;
}

function inActivePane(node) {
  return !!(node && node.closest && node.closest(".tab-pane.active"));
}

function fitRailPlots(row) {
  if (!row || !row.querySelectorAll || !window.Plotly) return;
  for (const pd of row.querySelectorAll(".wx-detail-plot")) {
    if (!pd._fullLayout || !pd.isConnected) continue;
    const w = Math.round(pd.clientWidth || 0);
    const cur = Math.round(pd._fullLayout.width || 0);
    if (!w || Math.abs(w - cur) < 2) continue;
    try {
      const p = Plotly.relayout(pd, { width: w });
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch (e) {
      void e;
    }
  }
  const grids = Array.from(row.querySelectorAll(".station-grid")).filter(
    (g) => typeof g._wxRefresh === "function"
  );
  if (!grids.length) return;
  for (const g of grids) if (typeof g._wxRailFit === "function") g._wxRailFit();
  requestAnimationFrame(() => {
    for (const g of grids) if (g.isConnected) g._wxRefresh();
  });
}

function neighbourMap() {
  ensureNeighbourMapStyles();
  const node = el("div", "wx-nb-map");
  const plot = el("div", "wx-nb-map-plot");
  const layer = el("div", "wx-nb-map-labels");
  const chip = el("div", "wx-nb-map-time");
  const tip = el("div", "wx-nb-map-tip");
  const scaleBar = el("div", "wx-nb-map-scale");
  node.appendChild(plot);
  node.appendChild(layer);
  node.appendChild(chip);
  node.appendChild(tip);
  node.appendChild(scaleBar);

  const paintScale = (lat, zoom) => {
    const step = mapScaleStep(lat, zoom);
    if (!step) {
      scaleBar.className = "wx-nb-map-scale";
      return;
    }
    scaleBar.style.width = step.px + "px";
    scaleBar.textContent = step.text;
    scaleBar.className = "wx-nb-map-scale on";
  };

  let acts = null;
  let extras = [];
  let quietNow = false;
  let valuesAt = null;
  let owner = null;
  let expanded = !isMobile();
  let drawn = false;
  let sig = null;
  let last = null;
  let current = null;
  let place = null;
  let hoverAt = null;
  let shownAt = null;
  let hoverStation = null;
  let shownStation = null;
  let home = null;
  let viewRev = 0;
  let forceFit = false;
  let shownSet = null;
  let marked = null;
  let peekKey = null;
  let zoomOn = false;

  const zoomMode = () => !!(owner && owner._wxMapZoomLabels);

  const applyPeek = () => {
    if (!current) return;
    const zm = zoomMode();
    for (const l of current) {
      const on = !!peekKey && neighbourKey(l.name) === peekKey;
      if (l.quiet) {
        l.optional = zm && zoomOn && !on;
        l.node.style.display = on || l.optional ? "" : "none";
        if (zm) neighbourMapLabel(l, l.display, on ? l.meta : null, !!l.isFocus);
        l.node.classList.toggle("zl", !!l.optional);
      } else {
        l.optional = false;
      }
      l.node.classList.toggle("peek", on);
      l.dot.classList.toggle("peek", on);
    }
  };
  let tool = null;

  const paintMarks = () => {
    const has = (key) => !!marked && marked.has(key);
    for (const e of extras) e.dot.classList.toggle("hit", has(e.key));
    if (!current) return;
    for (const l of current) l.dot.classList.toggle("hit", has(neighbourKey(l.name)));
  };
  let clearTimer = 0;
  let unbind = () => {};
  let unwatch = () => {};

  const fixedSize = () =>
    owner && typeof owner._wxMapSize === "function" ? owner._wxMapSize() : null;

  const size = () =>
    fixedSize() ||
    (expanded
      ? { w: NEIGHBOUR_MAP_WIDTH_EXPANDED, h: NEIGHBOUR_MAP_HEIGHT_EXPANDED }
      : { w: NEIGHBOUR_MAP_WIDTH, h: NEIGHBOUR_MAP_HEIGHT });

  const folded = () => collapsed && !fixedSize();

  const syncChrome = () => {
    const fixed = !!fixedSize();
    node.classList.toggle("wx-nb-map-fixed", fixed);
    node.classList.toggle("collapsed", collapsed && !fixed);
    node.classList.toggle("wx-expanded", fixed || expanded);
  };

  const btn = expandButton(() => {
    expanded = !expanded;
    setExpandButton(btn, expanded);
    node.classList.toggle("wx-expanded", expanded);
    if (last) {
      sig = null;
      show(last.focus, last.names, valuesAt, owner, acts, last.quiet);
    }
  });
  setExpandButton(btn, expanded);
  node.classList.toggle("wx-expanded", expanded);
  node.appendChild(btn);

  let collapsed = isMobile();
  let refitOnOpen = false;
  node.classList.toggle("collapsed", collapsed);
  const minBtn = el("button", "wx-expand-btn wx-nb-map-min");
  minBtn.type = "button";
  minBtn.innerHTML = MAP_MIN_ICON;
  minBtn.setAttribute("aria-label", "Minimise map");
  const pill = el("button", "wx-nb-map-pill");
  pill.type = "button";
  pill.innerHTML = MAP_PILL_ICON;
  pill.appendChild(el("span", null, "Map"));
  const setCollapsed = (on) => {
    collapsed = on;
    node.classList.toggle("collapsed", on);
    hideTip();
    if (owner && node.classList.contains("show")) markRow(owner, true);
    if (on) return;
    if (refitOnOpen && last) {
      refitOnOpen = false;
      sig = null;
      drawnLines = null;
      show(last.focus, last.names, valuesAt, owner, acts, last.quiet);
      return;
    }
    if (!drawn) return;
    requestAnimationFrame(() => {
      const sub =
        plot._fullLayout && plot._fullLayout.map && plot._fullLayout.map._subplot;
      try {
        if (sub && sub.map && typeof sub.map.resize === "function") sub.map.resize();
        else Plotly.Plots.resize(plot);
      } catch (e) {
        void e;
      }
      const gl = liveMap();
      if (gl && !tilesReady(gl)) {
        node.classList.add("wx-nb-map-wait");
        awaitTiles(gl);
      }
      if (place) place();
    });
  };
  minBtn.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    setCollapsed(true);
  });
  pill.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    setCollapsed(false);
  });
  node.appendChild(minBtn);
  node.appendChild(pill);

  const release = () => {
    unbind();
    unbind = () => {};
    unwatch();
    unwatch = () => {};
    place = null;
    current = null;
  };

  const paintBarb = (l, b) => {
    if (!l.barb) return;
    const on = !!(b && b.s !== null && b.d !== null);
    l.dot.classList.toggle("barbed", on);
    if (!on) {
      l.barb.style.display = "none";
      return;
    }
    const key = Math.round(b.s / BARB_UNIT) + "|" + b.d + "|" + l.color;
    if (l.barb._sig !== key) {
      l.barb._sig = key;
      l.barb.innerHTML = windBarbSvg(b.s, b.d, l.color);
    }
    l.barb.style.display = "";
  };

  const paintRain = (l, mm) => {
    if (!l.rain) return;
    const on = mm !== null && mm !== undefined && mm > 0;
    if (!on) {
      l.rain.style.display = "none";
      l.rainR = 0;
      return;
    }
    const r = rainRadius(mm);
    if (l.rainR !== r) {
      l.rainR = r;
      l.rain.style.width = 2 * r + "px";
      l.rain.style.height = 2 * r + "px";
    }
    l.rain.style.display = "";
  };

  const paintLabels = () => {
    if (!current) return;
    const status = typeof valuesAt === "function" ? valuesAt(hoverAt) : null;
    const readings = status && status.values ? status : null;
    const alerts = status && status.alerts ? status.alerts : null;
    const room = !!(readings && readings.barbs);
    const hold = !!readings && shownAt !== null && current.every((l) => l.barbRoom === room);
    shownAt = readings ? hoverAt : null;
    current.forEach((l) => {
      l.barbRoom = room;
    });
    current.forEach((l) => {
      const ring = alerts ? alerts.get(neighbourKey(l.name)) : null;
      l.dot.style.boxShadow = ring
        ? `0 0 0 2px #fff, 0 0 0 ${NEIGHBOUR_MAP_RING_PX + 2}px ${ring}`
        : "";
    });
    if (readings) {
      chip.textContent = mapTimeLabel(hoverAt);
      chip.className = "wx-nb-map-time on";
    } else {
      chip.className = "wx-nb-map-time";
    }
    current.forEach((l, i) => {
      if (!readings) {
        paintBarb(l, null);
        paintRain(l, null);
        neighbourMapLabel(l, l.display, l.meta, !!l.isFocus);
        return;
      }
      const key = neighbourKey(l.name);
      const v = readings.values.get(key);
      const value = v === undefined ? null : v;
      const b = readings.barbs ? readings.barbs.get(key) || null : null;
      paintBarb(l, b);
      paintRain(l, readings.rain ? readings.rain.get(key) : null);
      const dirText = b && b.d !== null ? ` ${b.d}\u00b0` : "";
      neighbourMapReading(l, l.display, l.meta, !!l.isFocus, {
        value: value,
        text: value === null ? "" : mapValueText(value, readings.col) + dirText,
      });
    });
    const hot = hoverAt !== null && hoverStation ? neighbourKey(hoverStation) : null;
    shownStation = hoverStation;
    current.forEach((l) => {
      const on = !!hot && neighbourKey(l.name) === hot;
      l.node.classList.toggle("hot", on);
      l.dot.classList.toggle("hot", on);
      if (l.barb) l.barb.classList.toggle("hot", on);
    });
    paintMarks();
    applyPeek();
    if (place) place(hold);
  };

  const setTime = (xval, slot, station) => {
    if (slot && slot !== owner) return;
    if (clearTimer) {
      clearTimeout(clearTimer);
      clearTimer = 0;
    }
    if (xval === null || xval === undefined) {
      if (hoverAt === null) return;
      clearTimer = setTimeout(() => {
        clearTimer = 0;
        hoverAt = null;
        paintLabels();
      }, HOVER_HOLD_MS);
      return;
    }
    const who = station || null;
    hoverAt = xval;
    hoverStation = who;
    if (shownAt === xval && shownStation === who) return;
    paintLabels();
  };

  let parked = false;
  let drawnSize = null;
  let drawnLines = null;
  let drawnFc = null;
  let stale = false;
  let reacting = null;

  const syncHome = () => {
    const sub =
      plot._fullLayout && plot._fullLayout.map && plot._fullLayout.map._subplot;
    if (!sub || !home) return;
    sub.viewInitial = {
      center: { lon: home.center.lon, lat: home.center.lat },
      zoom: home.zoom,
      bearing: 0,
      pitch: 0,
    };
  };

  const liveMap = () => {
    const sub =
      plot._fullLayout && plot._fullLayout.map && plot._fullLayout.map._subplot;
    return sub && sub.map && typeof sub.map.getBounds === "function" ? sub.map : null;
  };

  let waitTimer = 0;
  let waitOff = null;

  const reveal = () => {
    if (waitTimer) {
      clearTimeout(waitTimer);
      waitTimer = 0;
    }
    if (waitOff) {
      waitOff();
      waitOff = null;
    }
    node.classList.remove("wx-nb-map-wait");
  };

  const tilesReady = (gl) => {
    try {
      return gl.loaded() && gl.areTilesLoaded();
    } catch (e) {
      return true;
    }
  };

  const awaitTiles = (gl) => {
    if (!node.classList.contains("wx-nb-map-wait")) return;
    if (waitOff) {
      waitOff();
      waitOff = null;
    }
    if (!gl || tilesReady(gl)) {
      reveal();
      return;
    }
    const on = () => reveal();
    gl.on("idle", on);
    waitOff = () => gl.off("idle", on);
    if (waitTimer) clearTimeout(waitTimer);
    waitTimer = setTimeout(reveal, MAP_TILE_WAIT_MS);
  };

  const keptView = (points, w, h) => {
    if (!drawn || drawnSize !== w + "x" + h || drawnFc !== state.fc) return null;
    const gl = liveMap();
    if (!gl) return null;
    try {
      const b = gl.getBounds();
      const inside = points.every((p) => b.contains([p.at.lon, p.at.lat]));
      if (!inside) return null;
      const c = gl.getCenter();
      return { center: { lon: c.lng, lat: c.lat }, zoom: gl.getZoom() };
    } catch (e) {
      return null;
    }
  };

  const markRow = (slot, on) => {
    const row = slot && slot.parentNode;
    if (!row || !row.classList || !row.classList.contains("wx-nb-stack")) return;
    row.classList.toggle("has-map", on);
    if (on) node.style.top = isMobile() ? "" : stickyOffset() + PANEL_MARGIN + "px";
    const rail = on ? (folded() ? "c" : String(size().w)) : "";
    if (row._wxRail === rail) return;
    const first = row._wxRail === undefined && !on;
    row._wxRail = rail;
    if (first) return;
    fitRailPlots(row);
    requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
  };

  const park = () => {
    const box = mapHolder();
    if (node.parentNode !== box) box.appendChild(node);
  };

  const reserve = (slot) => {
    if (!slot || !slot.isConnected || node.parentNode !== slot || isMobile()) return false;
    const w = Math.round(node.offsetWidth || 0) || (folded() ? 0 : size().w + 2);
    if (!(w > 0)) return false;
    slot.style.width = w + "px";
    slot._wxReserved = true;
    return true;
  };

  const unreserve = (slot) => {
    if (!slot || !slot._wxReserved) return;
    slot._wxReserved = false;
    slot.style.width = "";
    markRow(slot, false);
  };

  const hide = () => {
    park();
    markRow(owner, false);
    owner = null;
    hoverAt = null;
    shownAt = null;
    parked = true;
    if (clearTimer) {
      clearTimeout(clearTimer);
      clearTimer = 0;
    }
    chip.className = "wx-nb-map-time";
  };

  const tipFor = (name, meta, verb) => ({ name: name, meta: meta, verb: verb });

  const showTip = (dot, info, w) => {
    tip.innerHTML = "";
    const head = el("div", "n");
    head.appendChild(document.createTextNode(info.name));
    if (info.meta) head.appendChild(document.createTextNode(` (${info.meta})`));
    tip.appendChild(head);
    const found = [];
    for (const a of found.slice(0, MAP_TIP_ALERTS)) {
      const row = el("div", "a");
      const swatch = el("i");
      swatch.style.background = a.color;
      row.appendChild(swatch);
      row.appendChild(el("span", null, a.section));
      tip.appendChild(row);
    }
    if (found.length > MAP_TIP_ALERTS) {
      tip.appendChild(el("div", "a more", `+${found.length - MAP_TIP_ALERTS} more`));
    }
    tip.className = "wx-nb-map-tip on";
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    const x = Math.max(4, Math.min(w - tw - 4, (dot._x || 0) - tw / 2));
    const above = (dot._y || 0) - th - 10;
    const y = above >= 4 ? above : (dot._y || 0) + 10;
    tip.style.transform = `translate(${Math.round(x)}px,${Math.round(y)}px)`;
  };

  const hideTip = () => {
    tip.className = "wx-nb-map-tip";
  };


  const wireDot = (dot, w, describe, act) => {
    if (describe) {
      dot.addEventListener("pointerenter", () => showTip(dot, describe(), w));
      dot.addEventListener("pointerleave", hideTip);
    }
    if (!act) return;
    dot.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      hideTip();
      act(ev);
    });
  };

  const attachLabels = (labels, view, w, h, focusAt) => {
    layer.innerHTML = "";
    hideTip();
    for (const l of labels) {
      l.rain.style.display = "none";
      l.rainR = 0;
      layer.appendChild(l.rain);
    }
    const taken = new Set(labels.map((l) => neighbourKey(l.name)));
    extras = [];
    const localOnly = !!(owner && owner._wxMapLocalOnly);
    for (const at of localOnly ? [] : mapCandidates()) {
      if (taken.has(neighbourKey(at.name))) continue;
      const dot = el("i", "cand");
      dot.style.width = NEIGHBOUR_MAP_CAND_PX + "px";
      dot.style.height = NEIGHBOUR_MAP_CAND_PX + "px";
      const meta = focusAt ? neighbourMeta(focusAt, at) : placeMeta(at);
      const away = !inCurrentFc(at.name);
      if (away) dot.classList.add("ext");
      wireDot(
        dot,
        w,
        () => tipFor(mapStationName(at.name), meta, MAP_HINT_OPEN),
        away
          ? null
          : () => {
              if (acts && typeof acts.open === "function") acts.open(at.name);
            }
      );
      extras.push({ dot: dot, lon: at.lon, lat: at.lat, key: neighbourKey(at.name) });
      layer.appendChild(dot);
    }
    labels.forEach((l) => {
      l.dot.style.width = l.size + "px";
      l.dot.style.height = l.size + "px";
      l.dot.style.background = l.color;
      l.dot.style.borderColor = l.color;
      if (l.isFocus) {
        l.dot.classList.add("focus", "star");
        l.dot.style.background = "transparent";
        l.dot.style.borderColor = "transparent";
        l.dot.innerHTML =
          '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
          `<path d="${MAP_STAR_PATH}" fill="${l.color}"/></svg>`;
      } else {
        const away = !inCurrentFc(l.name);
        if (away) l.dot.classList.add("ext");
        wireDot(
          l.dot,
          w,
          l.quiet ? () => tipFor(l.display, l.meta, MAP_HINT_OPEN) : null,
          away
            ? null
            : () => {
                if (acts && typeof acts.open === "function") acts.open(l.name);
              }
        );
      }
      layer.appendChild(l.dot);
    });
    for (const l of labels) {
      l.barb.style.width = BARB_BOX + "px";
      l.barb.style.height = BARB_BOX + "px";
      l.barb.style.display = "none";
      layer.appendChild(l.barb);
    }
    for (const l of labels) {
      if (l.dist) layer.appendChild(l.dist);
    }
    for (const l of labels) {
      l.node.style.display = l.quiet ? "none" : "";
      layer.appendChild(l.node);
    }
    const fixed = neighbourMapProject(view, w, h);
    const sub =
      plot._fullLayout && plot._fullLayout.map && plot._fullLayout.map._subplot;
    const gl = sub && sub.map && typeof sub.map.project === "function" ? sub.map : null;
    const project = (lon, lat) => {
      if (gl) {
        const q = gl.project([lon, lat]);
        return { x: q.x, y: q.y };
      }
      return fixed(lon, lat);
    };
    current = labels;
    syncHome();
    place = (hold) => {
      const half = NEIGHBOUR_MAP_CAND_PX / 2;
      for (const e of extras) {
        const q = project(e.lon, e.lat);
        const inside = q.x >= -half && q.y >= -half && q.x <= w + half && q.y <= h + half;
        e.dot.style.display = inside ? "" : "none";
        if (!inside) continue;
        e.dot._x = q.x;
        e.dot._y = q.y;
        e.dot.style.transform = `translate(${Math.round(q.x - half)}px,${Math.round(q.y - half)}px)`;
      }
      const zoomNow = gl ? gl.getZoom() : view.zoom;
      const zoomWant = zoomMode() && !!home && zoomNow >= home.zoom + MAP_ZOOM_LABEL_STEP;
      if (zoomWant !== zoomOn) {
        zoomOn = zoomWant;
        applyPeek();
      }
      const at = labels.map((l) => project(l.lon, l.lat));
      placeNeighbourLabels(labels, at, w, h, !!hold);
      const mid = gl ? gl.getCenter() : null;
      paintScale(mid ? mid.lat : view.center.lat, gl ? gl.getZoom() : view.zoom);
    };
    shownAt = null;
    paintLabels();
    layer.style.visibility = "";
    if (gl) {
      const move = () => {
        if (place) place();
      };
      gl.on("move", move);
      unbind = () => gl.off("move", move);
    }
  };

  const show = (focus, names, source, slot, actions, quiet) => {
    if (
      slot && owner && slot !== owner && owner.isConnected &&
      inActivePane(owner) && !inActivePane(slot)
    ) {
      return;
    }
    if (actions) acts = actions;
    if (owner && owner !== slot && !(slot && reserve(owner))) markRow(owner, false);
    if (slot && node.parentNode !== slot) slot.appendChild(node);
    const want = (slot && slot._wxMapTool) || null;
    if (tool !== want) {
      if (tool && tool.parentNode === node) node.removeChild(tool);
      tool = want;
      if (tool) node.appendChild(tool);
    }
    if (slot && slot._wxReserved) {
      slot._wxReserved = false;
      slot.style.width = "";
    }
    const switched = owner !== (slot || null) || valuesAt !== (source || null);
    if (owner !== (slot || null)) {
      marked = null;
      peekKey = null;
      zoomOn = false;
      const gl = liveMap();
      if (owner && gl && drawn && drawnFc === state.fc && shownSet) {
        try {
          const c = gl.getCenter();
          owner._wxMapView = {
            fc: drawnFc,
            set: shownSet,
            center: { lon: c.lng, lat: c.lat },
            zoom: gl.getZoom(),
          };
        } catch (e) {
          void e;
        }
      }
    }
    owner = slot || null;
    syncChrome();
    valuesAt = source || null;
    if (!node.isConnected) {
      last = { focus: focus, names: names, quiet: !!quiet };
      stale = true;
      return;
    }
    const here = focus ? stationCoord(focus) : null;
    if (!names || !names.length) {
      hide();
      return;
    }
    const items = [];
    names.forEach((name, i) => {
      const at = stationCoord(name);
      if (!at) return;
      items.push({
        name: name,
        at: at,
        color: quiet ? NEIGHBOUR_MAP_STATION_COLOR : NEIGHBOUR_MAP_NEIGHBOUR_COLOR,
        meta: here ? (quiet ? neighbourMeta(here, at) : null) : placeMeta(at),
        dist: here && !quiet ? lineMeta(here, at) : null,
      });
    });
    if (!items.length) {
      hide();
      return;
    }

    last = { focus: focus, names: names, quiet: !!quiet };
    node.classList.add("show");
    const { w, h } = size();
    plot.style.width = w + "px";
    plot.style.height = h + "px";
    markRow(slot, true);
    quietNow = !!quiet;
    const next = [here ? focus : "", w, h, quiet ? "q" : ""]
      .concat(items.map((it) => it.name))
      .join("\u0001");
    hideTip();
    const wasParked = parked || stale;
    parked = false;
    stale = false;
    if (drawn && next === sig && (current || reacting === next)) {
      if (forceFit) {
        forceFit = false;
        const gl = liveMap();
        if (gl && home) {
          try {
            gl.jumpTo({ center: [home.center.lon, home.center.lat], zoom: home.zoom });
          } catch (e) {
            void e;
          }
        }
      }
      if (switched || wasParked) {
        hoverAt = null;
        shownAt = null;
        paintLabels();
      }
      return;
    }
    sig = next;
    release();

    const spokes = here && !quiet ? items : [];
    const lineLon = [];
    const lineLat = [];
    for (const it of spokes) {
      lineLon.push(here.lon, it.at.lon, null);
      lineLat.push(here.lat, it.at.lat, null);
    }
    const data = [{
      type: "scattermap",
      mode: "lines",
      lon: lineLon,
      lat: lineLat,
      connectgaps: false,
      line: { color: NEIGHBOUR_MAP_LINE_COLOR, width: 1 },
      opacity: 0.8,
      hoverinfo: "skip",
      showlegend: false,
    }];
    data.push({
      type: "scattermap",
      mode: "markers",
      lon: [],
      lat: [],
      hoverinfo: "skip",
      showlegend: false,
    });
    const all = (here
      ? [{
          at: here,
          color: OVERLAY_FOCUS_COLOR,
          name: focus,
          meta: focusMeta(here),
          size: NEIGHBOUR_MAP_STAR_PX,
          isFocus: true,
        }]
      : []
    ).concat(items.map((it) => ({
      at: it.at,
      color: it.color,
      name: it.name,
      meta: it.meta,
      dist: it.dist,
      size: quiet ? NEIGHBOUR_MAP_STATION_PX : 8,
      quiet: !!quiet,
    })));

    const fit = neighbourMapView(all.map((p) => p.at), w, h);
    home = fit;
    const fresh = forceFit;
    forceFit = false;
    const setKey = [here ? focus : "", quiet ? "q" : ""]
      .concat(items.map((it) => it.name))
      .join("\u0001");
    const saved = slot && slot._wxMapView;
    const recall =
      !fresh && saved && saved.fc === state.fc && saved.set === setKey
        ? { center: saved.center, zoom: saved.zoom }
        : null;
    if (slot) slot._wxMapView = null;
    shownSet = setKey;
    const held = fresh || recall ? null : keptView(all, w, h);
    const view = recall || held || fit;
    const sameSize = drawnSize === w + "x" + h;
    const liveGl = drawn && drawnFc === state.fc ? liveMap() : null;
    let shown = view;
    if (liveGl) {
      try {
        const c = liveGl.getCenter();
        shown = { center: { lon: c.lng, lat: c.lat }, zoom: liveGl.getZoom() };
      } catch (e) {
        shown = view;
      }
    } else if (!held) {
      viewRev += 1;
    }
    const glide = !!liveGl && !held ? { to: view, ease: sameSize && !recall } : null;
    if (!sameSize) layer.style.visibility = "hidden";
    drawnSize = w + "x" + h;
    const layout = {
      width: w,
      height: h,
      margin: { l: 0, r: 0, t: 0, b: 0 },
      showlegend: false,
      paper_bgcolor: NEIGHBOUR_MAP_PAPER,
      font: { family: NEIGHBOUR_MAP_FONT, size: 11, color: DETAIL_HOVER_TEXT },
      uirevision: "nbmap|" + (state.fc || "") + "|" + viewRev,
      map: {
        style: NEIGHBOUR_MAP_STYLE,
        center: shown.center,
        zoom: shown.zoom,
        uirevision: "nbmap|" + (state.fc || "") + "|" + viewRev,
      },
    };
    const labels = all.map((p) => ({
      node: el("span"),
      dot: el("i"),
      barb: el("i", "wx-nb-map-barb"),
      rain: el("i", "wx-nb-map-rain"),
      rainR: 0,
      dist: p.dist ? el("b", "wx-nb-map-dist", p.dist) : null,
      barbRoom: false,
      spot: null,
      name: p.name,
      display: mapStationName(p.name),
      meta: p.meta,
      color: p.color,
      lon: p.at.lon,
      lat: p.at.lat,
      size: p.size,
      isFocus: !!p.isFocus,
      quiet: !!p.quiet,
    }));
    const mine = sig;
    const lineSig = JSON.stringify([
      w,
      h,
      data.map((tr) => [tr.lon, tr.lat, tr.line ? tr.line.color : ""]),
    ]);
    const kept = fresh || recall ? null : keptView(all, w, h);
    if (drawn && kept && lineSig === drawnLines && liveMap()) {
      attachLabels(labels, kept, w, h, here);
      return;
    }
    const warm = drawn && drawnFc === state.fc && !!liveMap();
    if (warm) reveal();
    else node.classList.add("wx-nb-map-wait");
    drawnLines = lineSig;
    drawnFc = state.fc;
    reacting = mine;
    let done;
    try {
      done = Plotly.react(plot, data, layout, {
        displayModeBar: false,
        scrollZoom: true,
        responsive: false,
      });
      drawn = true;
    } catch (e) {
      console.warn("neighbour map failed", e);
      reveal();
      hide();
      return;
    }
    if (warm && liveMap()) attachLabels(labels, view, w, h, here);
    Promise.resolve(done)
      .then(() => {
        if (reacting === mine) reacting = null;
        if (sig !== mine) return;
        if (!node.isConnected) {
          sig = null;
          stale = true;
          return;
        }
        const gl = liveMap();
        if (gl && typeof gl.resize === "function") {
          try {
            gl.resize();
          } catch (e) {
            void e;
          }
        }
        if (gl && glide) {
          const dest = {
            center: [glide.to.center.lon, glide.to.center.lat],
            zoom: glide.to.zoom,
          };
          try {
            if (glide.ease) gl.easeTo(Object.assign({ duration: MAP_EASE_MS }, dest));
            else gl.jumpTo(dest);
          } catch (e) {
            void e;
          }
        }
        unwatch();
        unwatch = collapseMapAttribution(plot);
        awaitTiles(gl);
        if (current === labels && place) {
          syncHome();
          place();
          layer.style.visibility = "";
          return;
        }
        attachLabels(labels, view, w, h, here);
      })
      .catch((e) => {
        if (reacting === mine) reacting = null;
        console.warn("neighbour map failed", e);
        reveal();
        hide();
      });
  };

  return {
    node: node,
    show: show,
    hide: (slot) => {
      if (slot && slot !== owner) {
        unreserve(slot);
        return;
      }
      hide();
    },
    park: () => {
      park();
      owner = null;
      hoverAt = null;
      shownAt = null;
      parked = true;
      if (clearTimer) {
        clearTimeout(clearTimer);
        clearTimer = 0;
      }
      chip.className = "wx-nb-map-time";
      hideTip();
    },
    time: setTime,
    fit: () => {
      forceFit = true;
    },
    railWidth: () =>
      collapsed ? 0 : (expanded ? NEIGHBOUR_MAP_WIDTH_EXPANDED : NEIGHBOUR_MAP_WIDTH) + 2,
    peek: (slot, name) => {
      if (slot && slot !== owner) return;
      const key = name ? neighbourKey(name) : null;
      if (key === peekKey) return;
      peekKey = key;
      applyPeek();
      if (place) place();
    },
    mark: (slot, keys) => {
      if (slot && slot !== owner) return;
      marked = keys && keys.size ? keys : null;
      paintMarks();
    },
    refresh: (slot) => {
      if (slot && slot !== owner) return;
      if (hoverAt === null) return;
      paintLabels();
    },
    collapse: (on) => setCollapsed(!!on),
    reset: () => {
      if (collapsed) refitOnOpen = true;
    },
  };
}

function buildOverlayFigure(fig, cells, rowPx, selected, link, ranges, rank, focus) {
  if (!selected || !selected.size) return null;

  const focusKey = focus ? neighbourKey(focus) : "";
  const isFocus = (cell) =>
    !!focusKey && neighbourKey(cell.station) === focusKey;

  const use = cells.filter(
    (cell) => selected.has(cell.station) || isFocus(cell)
  );
  if (!use.length) return null;

  const seat =
    rank && rank.size
      ? (cell) => {
          const at = rank.get(cell.station);
          return at === undefined ? Infinity : at;
        }
      : null;
  const lead = (cell) => (isFocus(cell) ? 0 : 1);
  use.sort(
    (a, b) =>
      lead(a) - lead(b) ||
      (seat ? seat(a) - seat(b) : 0) ||
      a.x0 - b.x0 ||
      b.y0 - a.y0
  );
  const hasFocus = isFocus(use[0]);

  const layout = cloneLayout(fig.layout);
  const host = use[0];
  const ax = layout[host.xkey];
  const ay = layout[host.ykey];
  if (!ax || !ay) return null;

  const hostX = host.id;
  const hostY = host.ykey === "yaxis" ? "y" : "y" + host.ykey.slice(5);

  for (const key of Object.keys(layout)) {
    if (!/^xaxis\d*$/.test(key) || key === host.xkey) continue;
    const other = layout[key];
    const idx = key === "xaxis" ? "" : key.slice(5);
    const anchor =
      other && typeof other.anchor === "string" && /^y\d*$/.test(other.anchor)
        ? other.anchor
        : "y" + idx;
    const ykey = "yaxis" + anchor.slice(1);
    if (ykey !== host.ykey) delete layout[ykey];
    delete layout[key];
  }

  const spread = !!(link && link.align && link.align[1] > link.align[0]);
  delete ax.matches;
  ax.visible = true;
  ax.domain = spread ? link.align.slice() : [0, 1];
  ay.visible = true;
  ay.domain = [0, 1];

  let range = link && link.range ? link.range.slice() : null;
  if (!range && ranges) {
    for (const cell of use) {
      const hit = ranges.get(cell.station);
      if (hit) {
        range = [hit[0], hit[1]];
        break;
      }
    }
  }
  if (range) {
    ax.range = range;
    ax.autorange = false;
  }

  const placed = new Map();
  const slot = new Map();
  use.forEach((cell, i) => {
    placed.set(cell.id, {
      cell: cell,
      col: 0,
      x0: ax.domain[0],
      x1: ax.domain[1],
      y0: 0,
      y1: 1,
    });
    slot.set(cell.id, i);
  });

  const built = [];
  const named = new Set();
  for (const tr of fig.data || []) {
    const id = tr.xaxis || "x";
    if (!slot.has(id) || isAlertTrace(tr)) continue;
    const i = slot.get(id);
    const station = use[i].station;
    const front = hasFocus && i === 0;
    const color = front
      ? OVERLAY_FOCUS_COLOR
      : overlayColor(hasFocus ? i - 1 : i);
    const out = Object.assign({}, tr);
    out.xaxis = hostX;
    out.yaxis = hostY;
    out.visible = true;
    out.name = station;
    out.legendgroup = station;
    out.showlegend = !named.has(i);
    named.add(i);
    out.legendrank = i;
    out.opacity = front
      ? 1
      : hasFocus
        ? NEIGHBOUR_MUTED_OPACITY
        : NEIGHBOUR_LINE_OPACITY;
    if (tr.hovertemplate) out.hovertemplate = overlayHoverTemplate(tr.hovertemplate);
    out.line = Object.assign({}, tr.line, {
      color: color,
      width: front ? OVERLAY_FOCUS_WIDTH : NEIGHBOUR_LINE_WIDTH,
      dash: "solid",
    });
    if (tr.marker) out.marker = Object.assign({}, tr.marker, { color: color });
    delete out.fill;
    delete out.fillcolor;
    built.push({ rank: i, trace: out });
  }
  if (!built.length) return null;

  built.sort((a, b) => b.rank - a.rank);
  const data = built.map((b) => b.trace);

  const known = new Set(cells.map((cell) => cell.station));
  if (Array.isArray(layout.annotations)) {
    layout.annotations = layout.annotations.filter((a) => {
      if (!a || typeof a.text !== "string") return true;
      return !known.has(a.text.replace(/<[^>]*>/g, "").trim());
    });
  }

  layout.shapes = [];
  applyDetailHoverStyle(layout);
  layout.showlegend = true;
  layout.legend = {
    orientation: "h",
    x: 0,
    xanchor: "left",
    y: 1,
    yanchor: "bottom",
    bgcolor: "rgba(255,255,255,0)",
    font: { size: 9, color: "#57534e" },
    traceorder: "normal",
    tracegroupgap: 3,
    entrywidth: 1 / NEIGHBOUR_LEGEND_COLS,
    entrywidthmode: "fraction",
  };

  const legendRows = Math.max(
    1,
    Math.ceil(use.length / NEIGHBOUR_LEGEND_COLS)
  );
  const legendPx =
    NEIGHBOUR_LEGEND_MARGIN + (legendRows - 1) * NEIGHBOUR_LEGEND_ROW_PX;

  layout.margin = Object.assign({}, layout.margin, {
    t: Math.max(((layout.margin || {}).t) || 0, legendPx),
  });

  const yRange = stackYRange(
    fig,
    placed,
    link && link.yRange ? link.yRange : null,
    spanMs(range)
  );
  if (yRange) {
    ay.range = yRange.slice();
    ay.autorange = false;
  }

  delete layout.width;
  layout.autosize = true;
  layout.height = Math.round(
    rowPx * NEIGHBOUR_OVERLAY_ROWS +
      GRID_PAD_PX +
      (legendRows - 1) * NEIGHBOUR_LEGEND_ROW_PX
  );

  return {
    data: data,
    layout: layout,
    yRange: yRange,
    ids: new Set(placed.keys()),
  };
}

function stationGrid(c, views, opts) {
  const list = (views && views.length ? views : [{ key: "station_grid" }])
    .filter((v) => c && c[v.key]);
  if (!list.length) return el("div");

  let fig = c[list[0].key];
  const scale = heightScale();
  const baseHeight = (fig.layout && fig.layout.height) || 400;
  const h = Math.round(
    Math.max(baseHeight - GRID_PAD_PX, 0) * scale +
      Math.min(baseHeight, GRID_PAD_PX)
  );
  const wrap = el("div", "station-grid");

  const known = new Set();
  for (const v of list) {
    for (const name of gridStationNames(c[v.key])) known.add(name);
  }
  wrap._wxStations = Array.from(known);
  wrap._wxAxisStations = new Map();

  let cells = [];
  let fills = null;
  let rowPx = 0;
  let gridCol = null;
  let baseSlots = null;
  let pendingRanges = null;
  let viewKey = null;
  let cumFrom = null;
  let cumData = null;

  const canCumulate = !!(opts && opts.cumulative);

  const useFigure = (key) => {
    fig = c[key];
    viewKey = key;
    applyDetailHoverStyle(fig && fig.layout);
    captureStationAnnotations(fig, wrap._wxStations);
    wrap._wxAxisStations.clear();
    for (const [id, name] of gridAxisStations(fig)) {
      wrap._wxAxisStations.set(id, name);
    }
    cells = gridCells(fig);
    fills = gridZoneFills(fig, cells);
    rowPx = gridRowPx(fig, cells) * scale;
    gridCol = gridColumnName(fig);
    if (fig && Array.isArray(fig.data)) {
      fig.data = fig.data.map((tr) => unifiedBandTrace(tr, fig.layout));
    }
    if (!baseSlots) {
      baseSlots = new Map();
      for (const cell of cells) {
        baseSlots.set(cell.station, [cell.x0, cell.x1, cell.y0, cell.y1]);
      }
      return;
    }
    for (const cell of cells) {
      const slot = baseSlots.get(cell.station);
      if (!slot) continue;
      cell.x0 = slot[0];
      cell.x1 = slot[1];
      cell.y0 = slot[2];
      cell.y1 = slot[3];
    }
  };
  useFigure(list[0].key);

  const suffix = (opts && opts.suffix) || null;
  const foreign = new Map();
  let aug = null;
  let refreshQueued = false;

  const baseSrc = () => ({ key: "", base: fig, fig: fig, cells: cells, fills: fills });

  const queueRefresh = () => {
    if (refreshQueued) return;
    refreshQueued = true;
    requestAnimationFrame(() => {
      refreshQueued = false;
      if (selected && selected.size) apply();
    });
  };

  const foreignPart = (name) => {
    const k = viewKey + "|" + neighbourKey(name);
    if (foreign.has(k)) return foreign.get(k);
    const entry = { part: null, done: false, job: null };
    let finish = null;
    entry.job = new Promise((resolve) => {
      finish = resolve;
    });
    foreign.set(k, entry);
    const at = stationCoord(name);
    if (!at || !at.fc || !suffix) {
      entry.done = true;
      finish();
      return entry;
    }
    const vk = viewKey;
    const fc = state.fc;
    const hours = state.hours;
    const settle = () => {
      if (entry.done) return;
      entry.done = true;
      finish();
      queueRefresh();
    };
    setTimeout(settle, FOREIGN_WAIT_MS);
    Promise.resolve(loadCharts(at.fc, hours, suffix))
      .then((cc) => {
        if (state.fc !== fc || state.hours !== hours) return;
        entry.part = stationGridPart(cc && cc[vk], name);
        if (entry.done) {
          if (entry.part) queueRefresh();
          return;
        }
        settle();
      })
      .catch(() => {})
      .then(settle);
    return entry;
  };

  const foreignJobs = () => {
    const out = [];
    if (!selected || !selected.size) return out;
    const have = new Set(cells.map((cl) => neighbourKey(cl.station)));
    for (const name of selected) {
      if (have.has(neighbourKey(name))) continue;
      const entry = foreignPart(name);
      if (!entry.done) out.push(entry.job);
    }
    return out;
  };

  const foreignPending = () => foreignJobs().length > 0;

  const augmentWith = (parts, key) => {
    const layout = Object.assign({}, fig.layout);
    const data = (fig.data || []).slice();
    const shapes = ((fig.layout && fig.layout.shapes) || []).slice();
    const anns = ((fig.layout && fig.layout.annotations) || []).slice();
    const lead = cells.find((cl) => cl.matches);
    const matchX = lead ? lead.matches : null;
    const extra = [];
    parts.forEach((p, i) => {
      const n = FOREIGN_AXIS_BASE + i;
      const xid = "x" + n;
      const yid = "y" + n;
      const xa = deepClone(p.xaxis);
      xa.anchor = yid;
      if (matchX) xa.matches = matchX;
      else delete xa.matches;
      const ya = deepClone(p.yaxis);
      ya.anchor = xid;
      delete ya.matches;
      layout["xaxis" + n] = xa;
      layout["yaxis" + n] = ya;
      for (const tr of p.traces) data.push(Object.assign({}, tr, { xaxis: xid, yaxis: yid }));
      for (const sh of p.shapes) {
        const copy = deepClone(sh);
        copy.xref = retargetRef(sh.xref, p.xid, xid);
        copy.yref = retargetRef(sh.yref, p.yid, yid);
        shapes.push(copy);
      }
      if (p.annotation) {
        const a = deepClone(p.annotation);
        if (String(a.text).replace(/<[^>]*>/g, "").trim() !== p.name) {
          a.text = String(a.text).replace(/(<[^>]*>)*[^<]+/, (m, tag) => (tag || "") + p.name);
        }
        anns.push(a);
      }
      wrap._wxAxisStations.set(xid, p.name);
      const dx = Array.isArray(xa.domain) ? xa.domain : [0, 1];
      const dy = Array.isArray(ya.domain) ? ya.domain : [0, 1];
      extra.push({
        id: xid,
        xkey: "xaxis" + n,
        ykey: "yaxis" + n,
        station: p.name,
        x0: dx[0],
        x1: dx[1],
        y0: dy[0],
        y1: dy[1],
        matches: matchX,
      });
    });
    layout.shapes = shapes;
    layout.annotations = anns;
    return {
      key: key,
      base: fig,
      fig: { data: data, layout: layout },
      cells: cells.concat(extra),
      fills: fills,
    };
  };

  const srcNow = () => {
    if (!selected || !selected.size) return baseSrc();
    const have = new Set(cells.map((cl) => neighbourKey(cl.station)));
    const parts = [];
    for (const name of selected) {
      if (have.has(neighbourKey(name))) continue;
      const entry = foreignPart(name);
      if (entry && entry.part) parts.push(entry.part);
    }
    if (!parts.length) return baseSrc();
    parts.sort((a, b) => a.name.localeCompare(b.name));
    const key = viewKey + "|" + parts.map((p) => p.name).join("\u0001");
    if (aug && aug.key === key && aug.base === fig) return aug;
    aug = augmentWith(parts, key);
    return aug;
  };

  const g = graph(fig, { height: h, noModeBar: true });
  const selPd = el("div", "wx-plot wx-plot-sel");
  selPd.style.width = "100%";
  selPd.style.display = "none";
  g.appendChild(selPd);
  const sigs = new WeakMap();
  const baseView = list[0].key;
  const activePd = () => wrap._wxGridPlot || g._wxPlotDiv;
  const showPd = (pd) => {
    const was = activePd();
    if (was === pd && pd.style.display !== "none") return;
    if (typeof wrap._wxSpikeOff === "function") wrap._wxSpikeOff();
    const base = g._wxPlotDiv;
    base.style.display = pd === base ? "" : "none";
    selPd.style.display = pd === selPd ? "" : "none";
    wrap._wxGridPlot = pd;
    if (pd._wxSpikeAt) {
      wrap._wxSpikeAt = pd._wxSpikeAt;
      wrap._wxSpikeOff = pd._wxSpikeOff;
    }
  };
  const fitSel = () => {
    if (selPd._wxDrawn && selPd.style.display !== "none") fitPlot(selPd);
  };
  if (typeof ResizeObserver === "function") {
    let selTimer = 0;
    new ResizeObserver(() => {
      if (selTimer) clearTimeout(selTimer);
      selTimer = setTimeout(() => {
        selTimer = 0;
        if (!selPd._wxDrawn || selPd.style.display === "none" || g._wxHold) return;
        if (syncSize(selPd)) fitSel();
      }, SEL_RESIZE_SETTLE_MS);
    }).observe(selPd);
  }

  let selected = null;
  let order = null;
  let overlay = false;
  let cumulative = false;
  let autoExpanded = false;
  wrap._wxStacked = false;
  wrap._wxCumulative = false;

  let histInfo = null;
  let histKey = "";
  let histApi = null;
  let histQueued = false;
  const histCache = new Map();

  const historicalNow = () =>
    histInfo && histApi && panelPlot(wrap._wxPanel) ? histInfo : null;

  const histNormals = (name) => {
    const key = neighbourKey(name);
    if (histCache.has(key)) return histCache.get(key);
    const entry = { n: null, done: false, job: null };
    histCache.set(key, entry);
    entry.job = Promise.resolve(histApi.neighbourNormals(name))
      .then((n) => {
        entry.n = n || null;
      })
      .catch(() => {})
      .then(() => {
        entry.done = true;
        if (histQueued) return;
        histQueued = true;
        requestAnimationFrame(() => {
          histQueued = false;
          if (selected && selected.size) apply();
        });
      });
    return entry;
  };

  const histWanted = () => {
    if (!histApi && _detailRef) histApi = _detailRef;
    return !!(
      histApi &&
      gridCol &&
      !overlay &&
      typeof histApi.historicalOn === "function" &&
      histApi.historicalOn()
    );
  };

  const histJobs = () => {
    const out = [];
    if (!selected || !selected.size || !histWanted()) return out;
    for (const name of selected) {
      const entry = histNormals(name);
      if (!entry.done) out.push(entry.job);
    }
    return out;
  };

  const histPending = () => {
    if (!historicalNow() || overlay || !gridCol) return false;
    return histJobs().length > 0;
  };

  const historicalBands = (next, list, hist) => {
    if (!hist || !gridCol || !next || !next.ids) return "";
    const shown = list.filter((cell) => next.ids.has(cell.id));
    const entries = shown.map((cell) => histNormals(cell.station));
    if (entries.some((e) => !e.done)) return "";
    const bands = [];
    const lit = new Set();
    const names = [];
    for (let i = 0; i < shown.length; i++) {
      const cell = shown[i];
      const n = entries[i].n;
      if (!n) continue;
      const yid = "y" + cell.ykey.slice(5);
      const traces = histApi.normalsRangeTraces(
        n, gridCol, hist.startMs, hist.endMs, cell.id, yid
      );
      if (!traces || !traces.length) continue;
      for (const tr of traces) bands.push(tr);
      lit.add(cell.id);
      names.push(cell.station);
    }
    if (!bands.length) return "";
    next.data = bands.concat(
      next.data.map((tr) => {
        if (!tr || !lit.has(tr.xaxis || "x") || isAlertTrace(tr)) return tr;
        if (tr.meta && (tr.meta.band_hover || tr.meta.normals)) return tr;
        const out = Object.assign({}, tr);
        if (out.fill) out.fill = "none";
        if (out.line) out.line = Object.assign({}, out.line, { color: HIST_LINE_COLOR });
        if (out.marker) out.marker = Object.assign({}, out.marker, { color: HIST_LINE_COLOR });
        return out;
      })
    );
    return names.sort().join("\u0001");
  };

  wrap._wxHistorical = (info) => {
    const key = info ? info.startMs + "-" + info.endMs : "";
    if (key === histKey) return;
    histKey = key;
    histInfo = info || null;
    if (!histApi && _detailRef) histApi = _detailRef;
    detailModule()
      .then((m) => {
        histApi = m;
        if (selected && selected.size) apply();
      })
      .catch(() => {});
  };

  const cumulativeSource = (from) => {
    const f = from || srcNow().fig;
    const data = (f && f.data) || [];
    if (cumFrom !== data) {
      cumFrom = data;
      cumData = cumulativeTraces(data);
    }
    return { data: cumData, layout: f.layout };
  };

  const releasePushed = (dpd) => {
    if (!dpd || !wrap._wxYPushed) return;
    wrap._wxYPushed = false;
    try {
      Plotly.relayout(dpd, { "yaxis.autorange": true });
    } catch (e) {
      void e;
    }
  };

  const quietly = (fn) => {
    if (typeof wrap._wxNoAnim === "function") wrap._wxNoAnim(fn);
    else fn();
  };

  const sharedColumn = (dpd) => {
    const dcol = detailColumnName(dpd);
    return !!(gridCol && dcol && dcol.toLowerCase() === gridCol.toLowerCase());
  };

  const linkGeom = (totals) => {
    const pd = selPd._wxDrawn ? selPd : g._wxPlotDiv;
    const dpd = panelPlot(wrap._wxPanel);
    if (!pd || !dpd || !pd._fullLayout || !dpd._fullLayout) return null;
    const gs = pd._fullLayout._size;
    const ds = dpd._fullLayout._size;
    const dxa = dpd._fullLayout.xaxis;
    if (!gs || !ds || !dxa) return null;
    const gr = pd.getBoundingClientRect();
    const dr = dpd.getBoundingClientRect();
    if (!gr.width || !dr.width) return null;
    const gw = gr.width - (gs.l || 0) - (gs.r || 0);
    const dw = dr.width - (ds.l || 0) - (ds.r || 0);
    if (!(gw > 0) || !(dw > 0)) return null;
    const x0 = (dr.left + ds.l - gr.left - gs.l) / gw;
    const x1 = (dr.left + ds.l + dw - gr.left - gs.l) / gw;
    if (!(x1 > x0)) return null;
    const range = Array.isArray(dxa.range) ? dxa.range.slice() : null;
    return {
      align: [Math.max(0, Math.min(1, x0)), Math.max(0, Math.min(1, x1))],
      range: range,
      yRange:
        !totals && sharedColumn(dpd) ? detailFit(dpd, spanMs(range)) : null,
    };
  };

  let fitIds = null;
  let fitFrame = 0;

  const refit = () => {
    fitFrame = 0;
    const pd = activePd();
    const fl = pd && pd._fullLayout;
    if (!fl || !pd.layout || !fitIds || !wrap._wxStacked) return;
    const key = anchorXAxisKey(fl);
    const view = key ? spanMs(axisRange(fl, key)) : null;
    if (!view) return;
    const dpd = panelPlot(wrap._wxPanel);
    const totals = wrap._wxCumulative === true;
    const base =
      dpd && !totals && sharedColumn(dpd) ? detailFit(dpd, view) : null;
    const now = srcNow();
    const range = stackYRange(
      totals ? cumulativeSource(now.fig) : now.fig, fitIds, base, view
    );
    if (!range) return;
    const patch = {};
    let dirty = false;
    for (const k of Object.keys(pd.layout)) {
      if (!/^yaxis\d*$/.test(k)) continue;
      const ya = fl[k];
      if (!ya || ya.visible === false || sameRange(ya.range, range)) continue;
      patch[k + ".autorange"] = false;
      patch[k + ".range"] = range.slice();
      dirty = true;
    }
    try {
      if (dirty) Plotly.relayout(pd, patch);
      if (base && !sameRange(axisRange(dpd._fullLayout, "yaxis"), range)) {
        wrap._wxYPushed = true;
        Plotly.relayout(dpd, {
          "yaxis.autorange": false,
          "yaxis.range": range.slice(),
        });
      }
    } catch (e) {
      void e;
    }
  };

  wrap._wxShareY = (col, base, xrange) => {
    if (!base || !selected || !selected.size) return null;
    if (overlay && canCumulate && cumulative && order) return null;
    if (wrap._wxCumulative) return null;
    if (!gridCol || !col || String(col).toLowerCase() !== gridCol.toLowerCase()) {
      return null;
    }
    const view = spanMs(xrange);
    if (!view) return null;
    const lit = wrap._wxPanel;
    const focus = overlay && lit ? neighbourKey(lit._wxStation || "") : "";
    const now = srcNow();
    const ids = new Set();
    for (const cell of now.cells) {
      if (selected.has(cell.station) || (focus && neighbourKey(cell.station) === focus)) {
        ids.add(cell.id);
      }
    }
    return ids.size ? stackYRange(now.fig, ids, base, view) : null;
  };

  let awaitTimer = 0;
  let awaiting = false;
  let veilNext = false;
  let veiled = false;
  let veilTimer = 0;
  const holdSpin = el("div", "wx-grid-holdspin wx-plot-wait");
  holdSpin.setAttribute("role", "status");
  holdSpin.setAttribute("aria-label", "Loading chart");
  holdSpin.appendChild(el("div", "wx-plot-spin"));

  const stackRowFor = (count) => {
    if (isMobile()) return rowPx;
    const width = g.getBoundingClientRect().width || 0;
    const byWidth = width * GRID_STACK_ROW_RATIO;
    const byView =
      ((window.innerHeight || 900) * GRID_STACK_VIEW_SHARE) / Math.max(1, count);
    return Math.round(Math.max(rowPx, Math.min(GRID_STACK_ROW_MAX, byWidth, byView)));
  };

  const expectedRows = () => {
    const have = new Set(cells.map((cl) => neighbourKey(cl.station)));
    let n = 0;
    for (const name of selected) {
      const key = neighbourKey(name);
      if (have.has(key)) {
        n++;
        continue;
      }
      const entry = foreign.get(viewKey + "|" + key);
      if (entry && entry.done) {
        if (entry.part) n++;
        continue;
      }
      const at = stationCoord(name);
      if (at && at.fc && suffix) n++;
    }
    return n;
  };

  const holdHeight = () => {
    if (isMobile() || overlay || !selected || !selected.size) return 0;
    const rows = expectedRows();
    if (!rows) return 0;
    const vis = activePd();
    const outer = wrap.getBoundingClientRect().height;
    const inner = vis ? vis.getBoundingClientRect().height : 0;
    const chrome = Math.max(0, Math.round(outer - inner));
    return Math.round(rows * stackRowFor(selected.size) + GRID_PAD_PX) + chrome;
  };

  let veilHeight = 0;

  const veil = () => {
    if (veilTimer) {
      clearTimeout(veilTimer);
      veilTimer = 0;
    }
    if (!veiled) {
      ensureGridHoldStyles();
      if (holdSpin.parentNode !== wrap) wrap.appendChild(holdSpin);
      veiled = true;
      veilHeight = 0;
      wrap.classList.add("wx-grid-hold");
    }
    const est = holdHeight();
    if (est > 0 && est !== veilHeight && typeof wrap._wxRebase === "function") {
      veilHeight = est;
      quietly(() => wrap._wxRebase(est));
    }
  };

  const unveil = () => {
    veilNext = false;
    if (veilTimer) {
      clearTimeout(veilTimer);
      veilTimer = 0;
    }
    if (!veiled) return;
    veiled = false;
    veilHeight = 0;
    wrap.classList.remove("wx-grid-hold");
  };

  const waitingDetail = () => !!(awaiting && !panelPlot(wrap._wxPanel));

  const blocked = () =>
    !!(selected && selected.size) &&
    (waitingDetail() || foreignPending() || histPending());

  const outdated = () =>
    !!(selected && selected.size) && (waitingDetail() || foreignPending());

  const veilSoon = () => {
    if (veiled || veilTimer || !outdated()) return;
    veilTimer = setTimeout(() => {
      veilTimer = 0;
      if (outdated()) veil();
    }, GRID_VEIL_DELAY_MS);
  };

  wrap._wxAwaitDetail = (on) => {
    if (awaitTimer) {
      clearTimeout(awaitTimer);
      awaitTimer = 0;
    }
    const was = awaiting;
    awaiting = !!on;
    if (awaiting) {
      veilNext = true;
      awaitTimer = setTimeout(() => {
        awaitTimer = 0;
        awaiting = false;
        apply();
      }, GRID_DETAIL_WAIT_MS);
      return;
    }
    if (was) apply();
  };

  wrap._wxReady = () => {
    const jobs = foreignJobs().concat(histJobs());
    return jobs.length ? Promise.all(jobs) : null;
  };

  wrap._wxRefit = () => {
    if (!fitFrame) fitFrame = requestAnimationFrame(refit);
  };

  const captureRanges = () => {
    const pd = activePd();
    const fl = pd && pd._fullLayout;
    if (!fl) return null;
    const out = new Map();
    for (const cell of srcNow().cells) {
      const xa = fl[cell.xkey];
      if (!xa || xa.visible === false) continue;
      if (!Array.isArray(xa.range) || xa.range.length !== 2) continue;
      out.set(cell.station, [xa.range[0], xa.range[1]]);
    }
    return out.size ? out : null;
  };

  const render = () => {
    if (!cells.length) return true;
    const filtered = !!(selected && selected.size);
    if (filtered) histJobs();
    if (blocked()) {
      if (veilNext || veiled) veil();
      else veilSoon();
      return true;
    }
    const base = g._wxPlotDiv;
    if (!base || !base.data || !base.isConnected) {
      if (filtered && (veilNext || veiled)) veil();
      return false;
    }
    const done = paint(base);
    unveil();
    return done;
  };

  const paint = (base) => {
    const visible = activePd();
    const pd = selected && selected.size ? selPd : base;

    const useRanges = pendingRanges;
    pendingRanges = null;

    const filtered = !!(selected && selected.size);
    wrap._wxStacked = filtered;
    wrap._wxOverlay = false;
    wrap._wxCumulative = false;
    if (!filtered) {
      if (typeof wrap._wxSpikeOff === "function") wrap._wxSpikeOff();
      const open = panelPlot(wrap._wxPanel);
      if (open) dropHover(open);
      releasePushed(open);
    }
    const src = srcNow();
    syncMap(false);
    const wantOverlay = filtered && overlay;
    const wantCum = wantOverlay && canCumulate && cumulative && !!order;
    const hist = filtered && !wantOverlay ? historicalNow() : null;
    const histCum = !!(hist && gridCol && gridCol === histApi.NORMALS_RAIN_COL);
    const link = filtered ? linkGeom(wantCum || histCum) : null;
    const lit = wrap._wxPanel;
    const focus =
      wantOverlay && lit && lit.style.display !== "none"
        ? lit._wxStation || null
        : null;
    const stackRow =
      filtered && !wantOverlay ? stackRowFor(selected.size) : rowPx;
    let next = null;
    try {
      if (wantOverlay) {
        next = buildOverlayFigure(
          wantCum ? cumulativeSource(src.fig) : src.fig,
          src.cells, rowPx, selected, link, useRanges, order, focus
        );
      }
      wrap._wxOverlay = !!next;
      wrap._wxCumulative = !!next && wantCum;
      if (!next) {
        next = buildGridFigure(
          histCum ? cumulativeSource(src.fig) : src.fig,
          src.cells, src.fills, stackRow, selected, link, useRanges, order
        );
        if (histCum) wrap._wxCumulative = true;
      }
    } catch (e) {
      console.warn("station grid filter failed", e);
      return true;
    }
    let histSig = "";
    if (hist && !wrap._wxOverlay) {
      try {
        histSig = historicalBands(next, src.cells, hist);
      } catch (e) {
        console.warn("neighbour normals failed", e);
        histSig = "";
      }
    }
    const ids = filtered ? next.ids || null : null;
    if (ctlRef && typeof ctlRef._wxShown === "function") {
      let shown = null;
      if (filtered) {
        shown = 0;
        for (const cell of src.cells) if (selected.has(cell.station)) shown++;
      }
      ctlRef._wxShown(shown);
    }
    if (isMobile()) {
      try {
        next = buildMobileFigure(next, { height: next.layout.height });
      } catch (e) {
        void e;
      }
    }

    const natural = next.layout.height;
    const chrome = Math.max(
      0,
      Math.round(wrap.getBoundingClientRect().height - visible.getBoundingClientRect().height)
    );

    const canExpand = typeof wrap._wxExpand === "function";
    const isOpen = () => !!(wrap._wxIsExpanded && wrap._wxIsExpanded());
    const collapsing = canExpand && autoExpanded && !(filtered && wantOverlay);
    const expanding = canExpand && filtered && wantOverlay && !isOpen();
    const willOpen = collapsing ? false : expanding ? true : isOpen();

    const sig = [
      viewKey,
      src.key,
      wantOverlay ? "1" : "0",
      wantCum ? "1" : "0",
      focus || "",
      selected ? Array.from(selected).sort().join("\u0001") : "",
      order ? Array.from(order.keys()).join("\u0002") : "",
      Math.round(stackRow),
      Math.round(natural),
      chrome,
      hist ? hist.startMs + "-" + hist.endMs + (histCum ? "c" : "") : "",
      histSig,
      willOpen ? "1" : "0",
      link
        ? [
            (link.align || []).join(","),
            (link.range || []).join(","),
            (link.yRange || []).join(","),
          ].join("|")
        : "",
    ].join("~");

    const same =
      !useRanges &&
      pd._wxDrawn &&
      (sigs.has(pd)
        ? sigs.get(pd) === sig
        : pd === base && !filtered && viewKey === baseView && !wantOverlay);
    if (same && pd === visible) {
      if (veiled && typeof wrap._wxRebase === "function") {
        quietly(() => wrap._wxRebase(natural + chrome));
      }
      return true;
    }

    g._wxHold = true;
    try {
      quietly(() => {
        if (collapsing) {
          autoExpanded = false;
          wrap._wxExpand(false);
        }
        if (typeof wrap._wxRebase === "function") wrap._wxRebase(natural + chrome);
        if (expanding) {
          autoExpanded = true;
          wrap._wxExpand(true, true);
        }
      });

      showPd(pd);
      if (same) {
        if (syncSize(pd)) {
          if (pd === base) g._wxFit();
          else fitSel();
        }
        return true;
      }
      sigs.set(pd, sig);

      if (canExpand && isOpen()) {
        delete next.layout.height;
        next.layout.autosize = true;
      } else {
        pd.style.height = natural + "px";
      }

      try {
        Plotly.react(pd, next.data, next.layout, g._wxConfig);
      } catch (e) {
        console.warn("station grid redraw failed", e);
        sigs.delete(pd);
        return true;
      }
      if (pd === selPd && !selPd._wxDrawn) {
        selPd._wxDrawn = true;
        if (typeof wrap._wxRewire === "function") wrap._wxRewire();
      }
      if (pd === selPd) selPd._wxWidth = selPd.clientWidth;
      fitIds = ids;

      if (link && link.yRange && next.yRange) {
        const dpd = panelPlot(wrap._wxPanel);
        if (dpd) {
          wrap._wxYPushed = true;
          pushRange(dpd, "yaxis", next.yRange);
        }
      } else if (wrap._wxCumulative) {
        releasePushed(panelPlot(wrap._wxPanel));
      }

    } finally {
      g._wxHold = false;
    }

    const fl = pd._fullLayout;
    const want = Math.round(pd.clientHeight || 0);
    if (pd !== base) {
      syncSize(pd);
      fitSel();
    } else if (fl && want && Math.abs(Math.round(fl.height || 0) - want) > 1) {
      if (typeof g._wxResize === "function") g._wxResize();
    } else if (typeof g._wxFit === "function") {
      g._wxFit();
    }
    return true;
  };

  const apply = () => {
    if (!render()) requestAnimationFrame(apply);
  };

  watchResize(wrap, () => {
    if (selected && selected.size && !overlay) apply();
  });

  wrap._wxRefresh = () => {
    if (selected && selected.size) apply();
  };

  wrap._wxHasFilter = () => !!(selected && selected.size);

  wrap._wxFilterNames = () => (selected ? Array.from(selected) : []);

  wrap._wxRailFit = () => {
    if (selected && selected.size) return;
    const pd = g._wxPlotDiv;
    if (!pd || !pd._wxDrawn || !pd._fullLayout || !pd.isConnected) return;
    if (pd.style.display === "none") return;
    const w = Math.round(pd.clientWidth || 0);
    if (!w || Math.abs(w - Math.round(pd._fullLayout.width || 0)) < 2) return;
    const drop = () => {
      if (pd.layout) delete pd.layout.width;
      pd._wxWidth = pd.clientWidth;
      fitPlot(pd);
    };
    g._wxHold = true;
    try {
      const p = Plotly.relayout(pd, { width: w });
      if (p && typeof p.then === "function") p.then(drop, drop);
      else drop();
    } catch (e) {
      void e;
    } finally {
      g._wxHold = false;
    }
  };

  const names = Array.from(new Set(Array.from(wrap._wxAxisStations.values()))).sort(
    (a, b) => a.localeCompare(b)
  );

  let bar = null;
  let nbMap = null;
  let ctlRef = null;
  let syncMap = () => {};
  if (names.length > 1 || list.length > 1) {
    ensureGridToggleStyles();
    bar = el("div", "wx-grid-toggle");
  }

  if (bar && list.length > 1) {
    const seg = el("div", "wx-grid-seg");
    const buttons = [];
    let active = list[0].key;
    for (const v of list) {
      const btn = el("button", v.key === active ? "on" : null, v.label || v.key);
      btn.type = "button";
      buttons.push({ btn: btn, key: v.key });
      btn.addEventListener("click", () => {
        if (v.key === active) return;
        pendingRanges = captureRanges();
        active = v.key;
        for (const b of buttons) b.btn.className = b.key === active ? "on" : "";
        useFigure(active);
        if (typeof wrap._wxHeaderSync === "function") wrap._wxHeaderSync();
        apply();
      });
      seg.appendChild(btn);
    }
    bar.appendChild(seg);
  }

  if (bar && names.length > 1) {
    warmNeighbours();

    const modeBtn = el("button", "wx-grid-mode");
    modeBtn.type = "button";
    modeBtn.appendChild(el("span", "box", CHECK_ICON));
    modeBtn.appendChild(el("span", null, OVERLAY_LABEL));

    let cumBtn = null;
    if (canCumulate) {
      cumBtn = el("button", "wx-grid-mode");
      cumBtn.type = "button";
      cumBtn.appendChild(el("span", "box", CHECK_ICON));
      cumBtn.appendChild(el("span", null, CUMULATIVE_LABEL));
    }

    const cumReady = () =>
      !!(cumBtn && overlay && order && selected && selected.size);

    const syncMode = () => {
      const pick = !!(selected && selected.size);
      modeBtn.className =
        "wx-grid-mode" + (pick ? " show" : "") + (overlay ? " on" : "");
      modeBtn.setAttribute("aria-pressed", overlay ? "true" : "false");
      if (!cumBtn) return;
      const ready = cumReady();
      if (!ready) cumulative = false;
      cumBtn.className =
        "wx-grid-mode" + (ready ? " show" : "") + (cumulative ? " on" : "");
      cumBtn.setAttribute("aria-pressed", cumulative ? "true" : "false");
    };

    modeBtn.addEventListener("click", () => {
      if (!selected || !selected.size) return;
      pendingRanges = captureRanges();
      overlay = !overlay;
      syncMode();
      apply();
    });

    if (cumBtn) {
      cumBtn.addEventListener("click", () => {
        if (!cumReady()) return;
        pendingRanges = captureRanges();
        cumulative = !cumulative;
        syncMode();
        apply();
      });
    }

    syncMode();
    bar.appendChild(modeBtn);
    if (cumBtn) bar.appendChild(cumBtn);

    let mapCache = null;
    const mapSeries = () => {
      const now = srcNow().fig;
      const src = (now && now.data) || [];
      const use = wrap._wxCumulative ? cumulativeSource(now).data : src;
      if (mapCache && mapCache.src === src && mapCache.use === use) return mapCache;
      const col = gridColumnName(now);
      mapCache = {
        src: src,
        use: use,
        col: col,
        series: gridStationSeries(use, src, wrap._wxAxisStations, col),
        hourly:
          col === NEIGHBOUR_MAP_RAIN_COL
            ? use === src
              ? null
              : gridStationSeries(src, src, wrap._wxAxisStations, col)
            : undefined,
      };
      return mapCache;
    };
    let markCache = null;
    const mapMarks = () => {
      const now = srcNow().fig;
      const src = (now && now.data) || [];
      if (markCache && markCache.src === src) return markCache.marks;
      markCache = { src: src, marks: gridAlertMarks(now, wrap._wxAxisStations) };
      return markCache.marks;
    };
    const barbMode = !!(opts && opts.barbs) && !!c[BARB_SPEED_KEY] && !!c[BARB_DIR_KEY];
    let barbLocal = null;
    const barbPick = (f) => {
      const out = new Map();
      if (!f) return out;
      const found = gridStationSeries(f.data, f.data, gridAxisStations(f), gridColumnName(f));
      for (const [name, s] of found) out.set(neighbourKey(name), s);
      return out;
    };
    const barbLocalSeries = () => {
      if (!barbLocal) {
        barbLocal = { s: barbPick(c[BARB_SPEED_KEY]), d: barbPick(c[BARB_DIR_KEY]) };
      }
      return barbLocal;
    };
    const barbForeign = new Map();
    const barbForeignFor = (name) => {
      const k = neighbourKey(name);
      if (barbForeign.has(k)) return barbForeign.get(k);
      const entry = { s: null, d: null };
      barbForeign.set(k, entry);
      const at = stationCoord(name);
      if (!at || !at.fc || !suffix) return entry;
      const fc = state.fc;
      const hours = state.hours;
      Promise.resolve(loadCharts(at.fc, hours, suffix))
        .then((cc) => {
          if (!cc || state.fc !== fc || state.hours !== hours) return;
          const one = (key) => {
            const p = stationGridPart(cc[key], name);
            if (!p) return null;
            const found = gridStationSeries(
              p.traces, p.traces, new Map([[p.xid, p.name]]), gridColumnName(cc[key])
            );
            return found.get(p.name) || null;
          };
          entry.s = one(BARB_SPEED_KEY);
          entry.d = one(BARB_DIR_KEY);
          if (_sharedNeighbourMap) _sharedNeighbourMap.refresh(mapSlot);
        })
        .catch(() => {});
      return entry;
    };
    const barbSource = (xval) => {
      const loc = barbLocalSeries();
      const values = new Map();
      const barbs = new Map();
      const put = (key, ss, ds) => {
        const s = ss ? gridSeriesAt(ss, xval) : null;
        const d0 = ds ? gridSeriesAt(ds, xval) : null;
        const d = d0 === null ? null : ((Math.round(d0) % 360) + 360) % 360;
        values.set(key, s);
        barbs.set(key, { s: s, d: d });
      };
      for (const key of new Set([...loc.s.keys(), ...loc.d.keys()])) {
        put(key, loc.s.get(key), loc.d.get(key));
      }
      const want = mapArgs ? [mapArgs.focus].concat(mapArgs.rank || []) : [];
      for (const name of want) {
        if (!name) continue;
        const key = neighbourKey(name);
        if (barbs.has(key)) continue;
        const entry = barbForeignFor(name);
        put(key, entry.s, entry.d);
      }
      return {
        col: gridColumnName(c[BARB_SPEED_KEY]) || BARB_SPEED_COL,
        values: values,
        alerts: gridAlertsAt(mapMarks(), xval),
        barbs: barbs,
      };
    };
    const mapSource = (xval) => {
      if (xval === null || xval === undefined) {
        return { col: null, values: null, alerts: null };
      }
      if (barbMode) return barbSource(xval);
      const cache = mapSeries();
      const values = new Map();
      for (const [name, series] of cache.series) {
        values.set(neighbourKey(name), gridSeriesAt(series, xval));
      }
      const out = { col: cache.col, values: values, alerts: gridAlertsAt(mapMarks(), xval) };
      if (cache.hourly !== undefined) {
        const hourly = cache.hourly || cache.series;
        out.rain = new Map();
        for (const [name, series] of hourly) {
          out.rain.set(neighbourKey(name), gridSeriesAt(series, xval));
        }
      }
      return out;
    };
    ensureNeighbourMapStyles();
    const headWrap = el("div", "wx-grid-headwrap");
    const head = el("div", "wx-grid-head");
    const resetLink = el("button", "wx-grid-mode");
    resetLink.appendChild(el("span", null, NEIGHBOUR_RESET_LABEL));
    resetLink.type = "button";
    resetLink.title = "Go back to the default neighbours";
    resetLink.addEventListener("click", () => {
      if (ctlRef && typeof ctlRef._wxNbReset === "function") ctlRef._wxNbReset();
    });
    headWrap.appendChild(head);
    bar.insertBefore(headWrap, bar.firstChild);
    let headFocus = null;
    const syncHeader = () => {
      const edited = !!(
        headFocus && ctlRef && typeof ctlRef._wxNbEdited === "function" && ctlRef._wxNbEdited()
      );
      resetLink.className = "wx-grid-mode" + (edited ? " show" : "");
      headWrap.className = "wx-grid-headwrap" + (headFocus ? " show" : "");
      if (!headFocus) {
        head.className = "wx-grid-head";
        head.textContent = "";
        return;
      }
      const col = gridColumnName(fig);
      const u = col ? NEIGHBOUR_MAP_UNITS[col] : null;
      const attr = col ? (u && u.unit ? `${col} (${u.unit})` : col) : "";
      const extra = !!(
        ctlRef && typeof ctlRef._wxNbExtra === "function" && ctlRef._wxNbExtra()
      );
      const lead = `${headFocus} ${extra ? "comparison" : "neighbours"}`;
      head.textContent = attr ? `${lead} ${attr}` : lead;
      head.title = head.textContent;
      head.className = "wx-grid-head show";
    };
    wrap._wxHeaderSync = syncHeader;
    const mapSlot = el("div", "wx-nb-map-slot");
    let mapArgs = null;
    const mapActions = {
      alerts: (name) => {
        const info = wrap._wxAlertInfo;
        return info ? info.get(neighbourKey(name)) || null : null;
      },
      open: (name) => {
        const panel = wrap._wxPanel;
        if (!panel) return;
        const lit = panel.style.display !== "none" ? panel._wxStation : null;
        if (lit && neighbourKey(lit) === neighbourKey(name)) return;
        const key = neighbourKey(name);
        const local = names.find((n) => neighbourKey(n) === key);
        if (ctlRef && typeof ctlRef._wxReplacePicks === "function") ctlRef._wxReplacePicks();
        openStationChart(panel, local || name, state.activeTab);
      },
    };
    mapSlot._wxMapTool = mapSearch(mapSlot, state.fc, (name) => mapActions.open(name));
    nbMap = {
      slot: mapSlot,
      show: (focus, rank, fresh, quiet) => {
        mapArgs = { focus: focus, rank: rank, quiet: !!quiet };
        const map = sharedNeighbourMap();
        map.show(focus, rank, mapSource, mapSlot, mapActions, !!quiet);
      },
      hide: () => {
        mapArgs = null;
        if (_sharedNeighbourMap) _sharedNeighbourMap.hide(mapSlot);
      },
      claim: () => {
        if (mapArgs) {
          sharedNeighbourMap().show(
            mapArgs.focus, mapArgs.rank, mapSource, mapSlot, mapActions, mapArgs.quiet
          );
        }
      },
    };
    wrap._wxMapTime = (xval, station) => {
      if (_sharedNeighbourMap) _sharedNeighbourMap.time(xval, mapSlot, station);
    };
    wrap._wxMapClaim = nbMap.claim;
    const mapList = () => {
      if (selected && selected.size && order && headFocus) {
        return { focus: headFocus, names: Array.from(order.keys()) };
      }
      const panel = wrap._wxPanel;
      const focus =
        panel && panel.style.display !== "none" ? panel._wxStation || null : null;
      if (!focus) return null;
      const key = neighbourKey(focus);
      if (selected && selected.size) {
        const picks = Array.from(selected).filter((n) => neighbourKey(n) !== key);
        if (picks.length) return { focus: focus, names: picks };
      }
      if (!panelPlot(panel)) return { keep: true, names: [] };
      const around = neighboursFor(focus, names).filter((n) => neighbourKey(n) !== key);
      return around.length ? { focus: focus, names: around, quiet: true } : null;
    };
    syncMap = (fresh) => {
      const m = mapList();
      if (m && m.keep) return;
      if (!m || !m.names.length) {
        nbMap.hide();
        return;
      }
      nbMap.show(m.focus, m.names, fresh, !!m.quiet);
    };
    wrap._wxMapSync = () => syncMap(false);
    wrap._wxMapPark = () => {
      if (_sharedNeighbourMap) _sharedNeighbourMap.hide(mapSlot);
    };

    const ctl = stationFilterControl(names, (sel, rank, focus, fresh) => {
      selected = sel;
      order = rank && rank.length
        ? new Map(rank.map((name, i) => [name, i]))
        : null;
      if (!selected || !selected.size) overlay = false;
      syncMode();
      headFocus = order && focus ? focus : null;
      syncHeader();
      syncMap(fresh);
      apply();
    }, false, {
      focus: () => {
        const panel = wrap._wxPanel;
        if (!panel || panel.style.display === "none") return null;
        return panel._wxStation || null;
      },
      resolve: (station) => neighboursFor(station, names),
      open: (station) => {
        const panel = wrap._wxPanel;
        if (!panel || !station) return false;
        openStationChart(panel, station, state.activeTab);
        return true;
      },
    });
    ctlRef = ctl;
    wrap._wxClearFilter = () =>
      typeof ctl._wxClear === "function" ? ctl._wxClear() : false;
    wrap._wxNeighbourSync = () =>
      typeof ctl._wxNbRetarget === "function" ? ctl._wxNbRetarget() : false;
    wrap._wxGridState = (withNeighbours) => ({
      filter: ctl._wxState(withNeighbours),
      overlay: overlay,
      cumulative: cumulative,
    });
    wrap._wxGridRestore = (st) => {
      if (!st || !st.filter) return;
      const wasOverlay = overlay;
      const wasCumulative = cumulative;
      const wasVeil = veilNext;
      overlay = !!st.overlay;
      cumulative = !!st.cumulative;
      veilNext = true;
      if (!ctl._wxRestore(st.filter) || !selected || !selected.size) {
        overlay = wasOverlay;
        cumulative = wasCumulative;
        veilNext = wasVeil;
        syncMode();
        return;
      }
      syncMode();
      apply();
    };
    bar.appendChild(resetLink);
    bar.appendChild(ctl);
    warmNeighbours(() => syncMap(false));
  }

  if (bar) wrap.appendChild(bar);
  wrap._wxNbMap = nbMap;

  wrap.appendChild(g);
  wrap._wxGridPlot = g._wxPlotDiv;
  wrap._wxGraphWrap = g;
  if (!isMobile()) makeCardExpandable(wrap, g);
  wireGridStationClicks(wrap, g);

  return wrap;
}

async function insightBanner(fc, hours, tab, panel, onPick) {
  const source = INSIGHT_SOURCES.find((s) => s[0] === tab);
  const [text, palette] = await Promise.all([
    loadText(fc, hours, `insights_${tab}`),
    loadCharts(fc, hours, `insights_${tab}`),
  ]);

  const parsed = source ? parseFindings(text || "", source) : [];
  const findings = tab === DATA_SUFFIX
    ? parsed.filter((f) => isDataSection(f.section) || f.section === UNCONFIGURED_SECTION)
    : parsed;
  ensureOverviewStyles();
  ensureInsightStyles();

  const shell = el("div", "wx-insight-shell");
  const grid = panel ? panel._wxGrid : null;
  if (!findings.length) {
    const missing = text === null || text === undefined;
    shell.appendChild(emptyTable(missing ? SENSOR_MISSING_TEXT : SENSOR_EMPTY_TEXT));
    return shell;
  }

  const colors = colorMap(palette);
  for (const f of findings) {
    f.color = colors.get(colorKey(f.section, f.station)) || null;
  }
  applySeverity(findings);
  if (grid) {
    grid._wxAlertColors = windowAlertColors(findings);
    grid._wxAlertInfo = windowAlertInfo(findings);
  }

  const wrap = sensorTable(findings, panel, null, {
    areas: source ? [source[2]] : AREA_ORDER,
    headers: false,
    onPick: onPick,
  });
  shell.appendChild(wrap);
  makeBoxExpandable(shell, wrap);
  return shell;
}

function insightStack(banner, panel, grid) {
  const nbMap = grid ? grid._wxNbMap : null;
  if (!nbMap) {
    const flat = document.createDocumentFragment();
    flat.appendChild(banner);
    flat.appendChild(panel);
    flat.appendChild(grid);
    return flat;
  }
  ensureNeighbourMapStyles();
  const main = el("div", "wx-nb-main");
  main.appendChild(banner);
  main.appendChild(panel);
  main.appendChild(grid);
  const stack = el("div", "wx-nb-stack");
  stack.appendChild(main);
  stack.appendChild(nbMap.slot);
  return stack;
}

const OVERVIEW_TAB = "tab-overview";

const DATA_TAB = "tab-data";

const DATA_SUFFIX = "data";

const DATA_AREA = "Data";

const INSIGHT_SOURCES = [
  [DATA_SUFFIX, DATA_TAB, DATA_AREA],
  ["rh", "tab-rh", "RH"],
  ["wind", "tab-wind", "Wind"],
  ["temp", "tab-temp", "Temp"],
  ["rn1", "tab-rn1", "Precip"],
  ["power", "tab-power", "Power"],
];

const DATA_SECTION = "MISSING DATA";

const UNCONFIGURED_SECTION = "UNCONFIGURED SENSORS";

const OVERVIEW_DATA_LIMIT = 5;

const DATA_OUTAGE_TIEBREAK = 0.5;

const MISSING_HOURS_RE = /(\d+)h\b/g;

const MISSING_OUTAGE_RE = /^Outage\b/i;

function isDataSection(section) {
  return section === DATA_SECTION;
}

function dataRowOrder(a, b) {
  const aMissing = isDataSection(a.f.section) ? 0 : 1;
  const bMissing = isDataSection(b.f.section) ? 0 : 1;
  if (aMissing !== bMissing) return aMissing - bMissing;
  const aAt = a.f.at === null || a.f.at === undefined ? -Infinity : a.f.at;
  const bAt = b.f.at === null || b.f.at === undefined ? -Infinity : b.f.at;
  if (aAt !== bAt) return bAt > aAt ? 1 : -1;
  return ovSeverity(b.f) - ovSeverity(a.f) || a.i - b.i;
}

function missingHours(f) {
  let max = 0;
  for (const m of String(f.detail || "").matchAll(MISSING_HOURS_RE)) {
    max = Math.max(max, Number(m[1]));
  }
  return max;
}

const MONTH_INDEX = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};

const BRACKET_STAMP_RE =
  /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?/g;

const TIME_BRACKET_RE =
  /(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d|ongoing|since|last |until |from /i;

const STAMP_FUTURE_SLACK_MS = 30 * 24 * 3600 * 1000;

const FINDING_LABEL_MAX = 44;

const BRACKET_SAME_DAY_END_RE = /^\s*[\u2013-]\s*(\d{1,2}):(\d{2})(?!\d)/;

function bracketStamp(when) {
  if (!when) return null;
  const now = Date.now();
  const year = new Date(now).getUTCFullYear();
  let best = null;
  let m;
  BRACKET_STAMP_RE.lastIndex = 0;
  while ((m = BRACKET_STAMP_RE.exec(when)) !== null) {
    const mon = MONTH_INDEX[m[1]];
    if (mon === undefined) continue;
    const day = Number(m[2]);
    const hh = m[3] ? Number(m[3]) : 0;
    const mm = m[4] ? Number(m[4]) : 0;
    let endHh = hh;
    let endMm = mm;
    const tail = BRACKET_SAME_DAY_END_RE.exec(when.slice(BRACKET_STAMP_RE.lastIndex));
    if (tail) {
      endHh = Number(tail[1]);
      endMm = Number(tail[2]);
    }
    let ms = Date.UTC(year, mon, day, endHh, endMm);
    if (ms > now + STAMP_FUTURE_SLACK_MS) ms = Date.UTC(year - 1, mon, day, endHh, endMm);
    if (best === null || ms > best) best = ms;
  }
  return best;
}

function stripInsightWrapper(text) {
  let out = String(text || "");
  if (out.startsWith("<!-- hash:")) {
    const nl = out.indexOf("\n");
    out = nl >= 0 ? out.slice(nl + 1) : "";
  }
  out = out.trim();
  if (out.startsWith("```")) {
    out = out.slice(3);
    if (out.endsWith("```")) out = out.slice(0, -3);
  }
  return out.trim();
}

function parseFindings(text, source) {
  const out = [];
  let section = "";
  for (const raw of stripInsightWrapper(text).split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) continue;
    const colon = line.indexOf(":");
    const label = colon > 0 ? line.slice(0, colon).trim() : "";
    const indented = /^\s/.test(line);
    const isFinding =
      !!label &&
      (colon <= FINDING_LABEL_MAX || indented) &&
      label === label.toUpperCase() &&
      /[A-Z0-9]/.test(label);
    if (!isFinding) {
      section = line.trim();
      continue;
    }
    let detail = line.slice(colon + 1).trim();
    let when = "";
    const bracket = /\s*\[([^\]]+)\]$/.exec(detail);
    if (bracket && TIME_BRACKET_RE.test(bracket[1])) {
      when = bracket[1].trim();
      detail = detail.slice(0, bracket.index).trim();
    }
    if (!detail) continue;
    out.push({
      station: label,
      section: section,
      detail: detail,
      when: when,
      ongoing: /ongoing/i.test(when),
      at: bracketStamp(when),
      tab: source[1],
      area: source[2],
    });
  }
  return out;
}

function colorKey(section, station) {
  return String(section || "") + "\u0000" + String(station || "");
}

function colorMap(records) {
  const map = new Map();
  if (!Array.isArray(records)) return map;
  for (const r of records) {
    if (!r || !r.color) continue;
    map.set(colorKey(r.section, r.station), String(r.color));
  }
  return map;
}

async function collectFindings(fc, hours) {
  const [texts, palettes] = await Promise.all([
    Promise.all(
      INSIGHT_SOURCES.map((s) => loadText(fc, hours, `insights_${s[0]}`))
    ),
    Promise.all(
      INSIGHT_SOURCES.map((s) => loadCharts(fc, hours, `insights_${s[0]}`))
    ),
  ]);
  const out = [];
  const dataRows = [];
  const missing = new Set();
  texts.forEach((text, i) => {
    if (text === null || text === undefined) missing.add(INSIGHT_SOURCES[i][2]);
    if (!text) return;
    const palette = colorMap(palettes[i]);
    for (const f of parseFindings(text, INSIGHT_SOURCES[i])) {
      f.color = palette.get(colorKey(f.section, f.station)) || null;
      if (f.area === DATA_AREA) {
        if (isDataSection(f.section)) dataRows.push(f);
        continue;
      }
      out.push(f);
    }
  });
  applySeverity(dataRows)
    .map((f, i) => ({ f: f, i: i }))
    .sort(dataRowOrder)
    .slice(0, OVERVIEW_DATA_LIMIT)
    .forEach((e) => out.push(e.f));
  return { findings: applySeverity(out), missing: missing };
}

const SEVERITY_CATEGORY_STEP = 100;
const SEVERITY_DURATION_WEIGHT = 12;
const SEVERITY_MAGNITUDE_WEIGHT = 12;
const SEVERITY_FREQUENCY_WEIGHT = 8;
const SEVERITY_ONGOING_BONUS = 4;
const SEVERITY_DRY_PERSIST_BONUS = 4;

const SEVERITY_MAX_MODIFIER =
  SEVERITY_DURATION_WEIGHT +
  SEVERITY_MAGNITUDE_WEIGHT +
  SEVERITY_FREQUENCY_WEIGHT +
  SEVERITY_ONGOING_BONUS +
  SEVERITY_DRY_PERSIST_BONUS;

const SEVERITY_RANK_FLOOR = 26;

const SEVERITY_DEFAULT_RANK = 25;

const SEVERITY_AREA_DEFAULT_RANK = {
  Power: 3,
  RH: 22,
  Wind: 24,
  Temp: 23,
  Precip: 21,
  Data: 22,
};

const SEV_RE = {
  readings: /^(\d+)\s+reading/i,
  shifts: /^(\d+)\s+shift/i,
  hours: /^(\d+)\s+hour/i,
  uncorrelated: /^(\d+)\s+uncorrelated/i,
  parenReadings: /\((\d+)\s+reading/i,
  pctOfDays: /\((\d+(?:\.\d+)?)\s*%\s+of\s+days/i,
  rhMax: /max\s+(-?\d+(?:\.\d+)?)\s*%/i,
  rhPeak: /peak\s+\u0394\s*([+-]?\d+(?:\.\d+)?)\s*%\/h/i,
  tempPeak: /peak\s+([+-]?\d+(?:\.\d+)?)\s*\u00b0C\/h/i,
  peakKmh: /peak\s+(-?\d+(?:\.\d+)?)\s*km\/h/i,
  leadKmh: /^(-?\d+(?:\.\d+)?)\s*km\/h/i,
  leadPct: /^(-?\d+(?:\.\d+)?)\s*%/i,
  leadMmh: /^(-?\d+(?:\.\d+)?)\s*mm\/h/i,
  leadTemp: /^(-?\d+(?:\.\d+)?)\s*\u00b0C/i,
  parenTemp: /\((-?\d+(?:\.\d+)?)\s*\u00b0C\)/i,
  ratio: /(\d+(?:\.\d+)?)\s*\u00d7\s*typical/i,
  rainMm: /Rn_1\s*\((-?\d+(?:\.\d+)?)\s*mm\)/i,
  forHours: /for\s+(\d+(?:\.\d+)?)\s*h\b/i,
  silentHours: /silent\s+(\d+(?:\.\d+)?)\s*h\s+straight/i,
  neighbourZero: /(\d+)\s+of\s+(\d+)\s+neighbour/i,
  silentZero: /silent\s+(\d+)\s+of\s+(\d+)\s+neighbour/i,
  behindMm: /vs\s+(\d+(?:\.\d+)?)/i,
  vbatMin: /min\s+(-?\d+(?:\.\d+)?)\s*V/i,
  vbatDrop: /dropped\s+(-?\d+(?:\.\d+)?)\s*V/i,
  noCharge: /no charge\s+(\d+)/i,
  dryPersist: /zero\s+Rn_1/i,
};

const SEVERITY_CATEGORIES = [
  ["Power", "LOW BATTERY VOLTAGE", 1, { mag: { re: SEV_RE.vbatMin, invert: true } }],
  ["Power", "NO DAYTIME CHARGING", 2, { freq: { re: SEV_RE.noCharge } }],
  ["Power", "BATTERY VOLTAGE DECLINING", 3, { mag: { re: SEV_RE.vbatDrop } }],
  ["Data", "MISSING DATA", 3, {}],
  ["RH", "RH READ 0%", 4, { freq: { re: SEV_RE.readings } }],
  ["RH", "RH EXCEEDED 100%", 5, {
    freq: { re: SEV_RE.readings },
    mag: { re: SEV_RE.rhMax },
  }],
  ["Wind", "SUSTAINED WIND EXCEEDED GUST (WSPD > MX_SPD)", 6, {
    freq: { re: SEV_RE.readings },
    mag: { re: SEV_RE.peakKmh },
  }],
  ["Precip", "SILENT RAIN GAUGES (\u22656 CONSECUTIVE NEIGHBOUR RAIN HOURS)", 7, {
    dur: { re: SEV_RE.silentHours },
    freq: { re: SEV_RE.neighbourZero },
  }],
  ["Precip", "SILENT RAIN GAUGES (SILENT \u226560% OF NEIGHBOUR RAIN HOURS)", 8, {
    freq: { re: SEV_RE.silentZero },
  }],
  ["Precip", "RAIN GAUGES MISSING NEIGHBOUR RAIN", 7, {
    noOngoing: true,
    noSpan: true,
  }],
  ["Precip", "PRECIPITATION (RN_1) RECORDED WHILE RH WAS BELOW 10%", 8, {
    freq: { re: SEV_RE.hours },
    mag: { re: SEV_RE.rainMm },
  }],
  ["Precip", "PRECIPITATION (RN_1) RECORDED WHILE RH WAS 10\u201325%", 9, {
    freq: { re: SEV_RE.hours },
    mag: { re: SEV_RE.rainMm },
  }],
  ["Wind", "LOW WSPD DAYS (<1 KM/H FOR \u226590% OF DAY)", 10, {
    noOngoing: true,
    noSpan: true,
  }],
  ["RH", "RH CHANGED >50%/H, OR \u226520%/H DECOUPLED FROM TEMPERATURE AND WIND", 11, {
    freq: { re: SEV_RE.shifts },
    mag: { re: SEV_RE.rhPeak, abs: true },
  }],
  ["Temp", "TEMPERATURE CHANGED >5\u00b0C/H, UNCORRELATED WITH RH", 13, {
    freq: { re: SEV_RE.uncorrelated },
    mag: { re: SEV_RE.tempPeak, abs: true },
  }],
  ["RH", "PERSISTENT STATES", 14, {
    dur: { re: SEV_RE.forHours },
    dry: SEV_RE.dryPersist,
  }],
  ["Temp", "PERSISTENT STATES", 15, { dur: { re: SEV_RE.forHours } }],
  ["Wind", "DAILY DIRECTION CONCENTRATION", 16, {
    noOngoing: true,
    noSpan: true,
  }],
  ["Wind", "DIRECTION BIAS OVER 14-DAY WINDOW", 17, {
    mag: { re: SEV_RE.ratio },
    freq: { re: SEV_RE.pctOfDays },
  }],
  ["Wind", "GUSTS EXCEEDED 80 KM/H", 18, {
    mag: { re: SEV_RE.leadKmh },
    freq: { re: SEV_RE.parenReadings },
  }],
  ["Wind", "SUSTAINED WIND EXCEEDED 60 KM/H", 19, {
    mag: { re: SEV_RE.leadKmh },
    freq: { re: SEV_RE.parenReadings },
  }],
  ["Temp", "TEMPERATURE EXCEEDED 35\u00b0C", 20, {
    mag: { re: SEV_RE.leadTemp, abs: true },
  }],
  ["Temp", "TEMPERATURE DROPPED BELOW -35\u00b0C", 20, {
    mag: { re: SEV_RE.leadTemp, abs: true },
  }],
  ["Precip", "HIGH PRECIPITATION", 21, { mag: { re: SEV_RE.leadMmh } }],
  ["RH", "RH DROPPED AS LOW AS", 22, { mag: { re: SEV_RE.leadPct, invert: true } }],
  ["Temp", "EXTREME VALUES", 23, { mag: { re: SEV_RE.parenTemp, abs: true } }],
  ["Wind", "WIND SPEED OUTLIERS", 24, { mag: { re: SEV_RE.leadKmh } }],
  ["Wind", "GUST OUTLIERS", 24, { mag: { re: SEV_RE.leadKmh } }],
];

function severityKey(area, section) {
  return String(area || "") + "\u0000" + String(section || "");
}

const SEVERITY_RANKS = new Map();
const SEVERITY_RULES = new Map();

for (const [area, section, rank, rules] of SEVERITY_CATEGORIES) {
  const key = severityKey(area, section);
  SEVERITY_RANKS.set(key, rank);
  SEVERITY_RULES.set(key, rules || {});
}

function severityRankGap() {
  const ranks = Array.from(new Set(Array.from(SEVERITY_RANKS.values()))).sort(
    (a, b) => a - b
  );
  let gap = Infinity;
  for (let i = 1; i < ranks.length; i++) {
    gap = Math.min(gap, ranks[i] - ranks[i - 1]);
  }
  return ranks.length > 1 ? gap : Infinity;
}

function severityScaleOk() {
  return severityRankGap() * SEVERITY_CATEGORY_STEP > SEVERITY_MAX_MODIFIER;
}

if (!severityScaleOk()) {
  console.warn("severity modifiers can reorder categories");
}

function severityRank(area, section) {
  const hit = SEVERITY_RANKS.get(severityKey(area, section));
  if (hit !== undefined) return hit;
  const fallback = SEVERITY_AREA_DEFAULT_RANK[area];
  return fallback === undefined ? SEVERITY_DEFAULT_RANK : fallback;
}

function severityBase(area, section) {
  return (SEVERITY_RANK_FLOOR - severityRank(area, section)) * SEVERITY_CATEGORY_STEP;
}

function readMetric(text, rule) {
  if (!rule || !rule.re) return null;
  const m = rule.re.exec(text);
  if (!m) return null;
  const v = Number(m[rule.index || 1]);
  if (!isFinite(v)) return null;
  if (rule.abs) return Math.abs(v);
  return rule.invert ? -v : v;
}

function bracketSpanHours(when) {
  if (!when) return null;
  const now = Date.now();
  const year = new Date(now).getUTCFullYear();
  let lo = null;
  let hi = null;
  let m;
  BRACKET_STAMP_RE.lastIndex = 0;
  while ((m = BRACKET_STAMP_RE.exec(when)) !== null) {
    const mon = MONTH_INDEX[m[1]];
    if (mon === undefined) continue;
    const day = Number(m[2]);
    const hh = m[3] ? Number(m[3]) : 0;
    const mm = m[4] ? Number(m[4]) : 0;
    let ms = Date.UTC(year, mon, day, hh, mm);
    if (ms > now + STAMP_FUTURE_SLACK_MS) ms = Date.UTC(year - 1, mon, day, hh, mm);
    if (lo === null || ms < lo) lo = ms;
    if (hi === null || ms > hi) hi = ms;
  }
  if (lo === null || hi === null || hi <= lo) return null;
  return (hi - lo) / 3600000;
}

function severityMetrics(f) {
  const rules = SEVERITY_RULES.get(severityKey(f.area, f.section)) || {};
  const detail = String(f.detail || "");
  const out = {
    dur: readMetric(detail, rules.dur),
    mag: readMetric(detail, rules.mag),
    freq: readMetric(detail, rules.freq),
    dry: !!(rules.dry && rules.dry.test(detail)),
  };
  if (out.dur === null && !rules.noSpan) out.dur = bracketSpanHours(f.when);
  return out;
}

const SEVERITY_METRIC_KEYS = ["dur", "mag", "freq"];

function severityUnit(v, range) {
  if (v === null || !range) return 0;
  const lo = range[0];
  const hi = range[1];
  if (!(hi > lo)) return 0;
  return (v - lo) / (hi - lo);
}

function applySeverity(findings) {
  const groups = new Map();
  for (const f of findings) {
    const key = severityKey(f.area, f.section);
    const metrics = severityMetrics(f);
    f._severityMetrics = metrics;
    let g = groups.get(key);
    if (!g) {
      g = { dur: null, mag: null, freq: null };
      groups.set(key, g);
    }
    for (const k of SEVERITY_METRIC_KEYS) {
      const v = metrics[k];
      if (v === null || !isFinite(v)) continue;
      if (!g[k]) g[k] = [v, v];
      else {
        g[k][0] = Math.min(g[k][0], v);
        g[k][1] = Math.max(g[k][1], v);
      }
    }
  }

  for (const f of findings) {
    const g = groups.get(severityKey(f.area, f.section)) || {};
    const m = f._severityMetrics;
    let score = severityBase(f.area, f.section);
    score += SEVERITY_DURATION_WEIGHT * severityUnit(m.dur, g.dur);
    score += SEVERITY_MAGNITUDE_WEIGHT * severityUnit(m.mag, g.mag);
    score += SEVERITY_FREQUENCY_WEIGHT * severityUnit(m.freq, g.freq);
    const rules = SEVERITY_RULES.get(severityKey(f.area, f.section)) || {};
    if (f.ongoing && !rules.noOngoing) score += SEVERITY_ONGOING_BONUS;
    if (m.dry) score += SEVERITY_DRY_PERSIST_BONUS;
    f.severity = score;
  }

  for (const f of findings) {
    if (f.area !== DATA_AREA || !isDataSection(f.section)) continue;
    f.severity =
      severityBase(f.area, f.section) +
      missingHours(f) +
      (MISSING_OUTAGE_RE.test(String(f.detail || "")) ? DATA_OUTAGE_TIEBREAK : 0);
  }

  return findings;
}

function ovSeverity(f) {
  return typeof f.severity === "number" && isFinite(f.severity) ? f.severity : 0;
}

function ensureOverviewStyles() {
  if (document.getElementById("wx-overview-styles")) return;
  const st = document.createElement("style");
  st.id = "wx-overview-styles";
  st.textContent = [
    ".wx-ov-shell{display:flex;flex-direction:column;min-height:320px;}",
    ".wx-ov-chart{flex:0 0 auto;background:var(--surface);overflow:hidden;",
    "border:1px solid var(--line);border-radius:10px;padding:12px;",
    "box-shadow:0 1px 3px rgba(0,0,0,.04);margin-bottom:10px;}",
    ".wx-ov-wrap{flex:0 1 auto;min-height:0;overflow:auto;",
    "background:var(--surface);border:1px solid var(--line);",
    "border-radius:10px;box-shadow:0 1px 3px rgba(0,0,0,.04);}",
    ".wx-ov-table{width:100%;border-collapse:separate;border-spacing:0;}",
    ".wx-ov-table th{position:sticky;top:0;z-index:1;padding:7px 12px;",
    "text-align:left;font-size:9px;font-weight:600;letter-spacing:.06em;",
    "text-transform:uppercase;color:var(--text-muted);background:#fcfcfb;",
    "white-space:nowrap;cursor:pointer;user-select:none;",
    "border-bottom:1px solid var(--line);}",
    ".wx-ov-table th:hover{color:var(--text);}",
    ".wx-ov-table th .a{margin-left:5px;color:var(--accent);}",
    ".wx-ov-table td{padding:5px 12px;vertical-align:top;",
    "border-top:1px solid #f5f4f2;}",
    ".wx-ov-table td:first-child,.wx-ov-table th:first-child{",
    "border-left:3px solid transparent;}",
    ".wx-ov-table tbody tr:first-child td{border-top:none;}",
    ".wx-ov-row{cursor:pointer;}",
    ".wx-ov-row:hover td{background:#fafaf9;}",
    ".wx-ov-row.sel td{background:#f2f5fa;}",
    ".wx-ov-sensor{font-size:10px;font-weight:600;letter-spacing:.04em;",
    "text-transform:uppercase;color:var(--text-muted);white-space:nowrap;}",
    ".wx-ov-name{font-size:11px;font-weight:600;letter-spacing:-.01em;",
    "color:var(--text);white-space:nowrap;}",
    ".wx-ov-type{font-size:10px;letter-spacing:.03em;color:#a9a49c;}",
    ".wx-ov-detail{font-size:12px;color:var(--text);line-height:1.35;}",
    ".wx-ov-when{font-size:10px;color:var(--text-muted);white-space:nowrap;}",
    ".wx-ov-sect thead th{height:28px;box-sizing:border-box;padding-top:0;",
    "padding-bottom:0;z-index:3;}",
    ".wx-ov-sect td{padding-top:4px;padding-bottom:4px;line-height:16px;",
    "vertical-align:baseline;}",
    ".wx-ov-sect .wx-ov-detail{width:100%;}",
    ".wx-ov-sect .wx-ov-group td{position:sticky;top:28px;z-index:2;",
    "padding-top:2px;padding-bottom:2px;font-size:11px;font-weight:700;",
    "letter-spacing:.07em;text-transform:uppercase;color:var(--text);",
    "background:#f3f2ef;border-top:1px solid var(--line);",
    "border-bottom:1px solid var(--line);}",
    ".wx-ov-table tbody tr.wx-ov-group:first-child td{border-top:none;}",
    ".wx-ov-sect .wx-ov-group + tr td{border-top:none;}",
    ".wx-ov-sect .wx-ov-sub td{padding-top:3px;padding-bottom:3px;",
    "font-size:10px;font-weight:500;letter-spacing:.04em;",
    "color:var(--text-muted);background:#fafaf9;}",
    ".wx-ov-sect .wx-ov-none td{padding-top:5px;padding-bottom:5px;",
    "font-size:10px;font-weight:500;letter-spacing:.04em;",
    "text-transform:uppercase;color:#a9a49c;}",
    "@media (max-width:768px){.wx-ov-chart{padding:8px;}",
    ".wx-ov-table th,.wx-ov-table td{padding:5px 8px;}}",
  ].join("");
  document.head.appendChild(st);
}

function ovText(tag, className, txt) {
  const n = el(tag, className);
  n.textContent = txt == null ? "" : String(txt);
  return n;
}

const ONGOING_SUFFIX_RE = /,\s*ongoing\s*$/i;

const EXTREME_SECTION = "EXTREME VALUES";

const EXTREME_PREFIX_RE = /^(Highest|Lowest)\b/;

const SENSOR_COLUMNS = ["Station", "Alert", "Time"];

const TAB_COLUMNS = ["Station", "Alert", "Type", "Time"];

const OVERVIEW_CELLS = {
  Sensor: (f) => ovText("td", "wx-ov-sensor", f.area),
  Station: (f) => ovText("td", "wx-ov-name", f.station),
  Alert: (f) => ovText("td", "wx-ov-detail", ovDetail(f)),
  Type: (f) => ovText("td", "wx-ov-type", f.section),
  Time: (f) => ovText("td", "wx-ov-when", ovWhen(f)),
};

const OVERVIEW_PLOT_MAX = 420;

const OVERVIEW_PLOT_MIN = 220;

const OVERVIEW_PLOT_SHARE = 0.5;


const PANEL_CHROME = 96;

const OVERVIEW_SORTS = {
  Sensor: (a, b) => ovAreaRank(a) - ovAreaRank(b),
  Type: (a, b) => String(a.section || "").localeCompare(String(b.section || "")),
  Alert: (a, b) => ovDetail(a).localeCompare(ovDetail(b)),
  Time: (a, b) => ovStamp(a) - ovStamp(b),
};

const OVERVIEW_BLANK = {
  Type: (f) => !f.section,
  Time: (f) => f.at === null || f.at === undefined,
};

const AREA_RANK = new Map(INSIGHT_SOURCES.map((s, i) => [s[2], i]));

const AREA_ORDER = INSIGHT_SOURCES.map((s) => s[2]);

const SENSOR_EMPTY_TEXT = "No alerts";

const SENSOR_MISSING_TEXT = "Not available";

const SENSOR_SORTS = {
  Station: (a, b) =>
    String(a.station || "").localeCompare(String(b.station || "")),
  Alert: (a, b) => ovDetail(a).localeCompare(ovDetail(b)),
  Time: (a, b) => ovStamp(a) - ovStamp(b),
};

function ovAreaRank(f) {
  const i = AREA_RANK.get(f.area);
  return i === undefined ? AREA_RANK.size : i;
}

function ovStamp(f) {
  return f.at === null || f.at === undefined ? 0 : f.at;
}

function ovWhen(f) {
  return String(f.when || "").replace(ONGOING_SUFFIX_RE, "").trim();
}

function ovDetail(f) {
  const text = String(f.detail || "");
  if (f.section === EXTREME_SECTION && EXTREME_PREFIX_RE.test(text)) {
    return text.replace(EXTREME_PREFIX_RE, "$1 in window");
  }
  return text;
}

function chartPanel() {
  const panel = el("div", "wx-ov-chart");
  panel.style.display = "none";
  return panel;
}

function tabPanel(grid) {
  const panel = chartPanel();
  if (grid) {
    grid._wxPanel = panel;
    panel._wxGrid = grid;
  }
  return panel;
}

function resetOverviewChart(panel) {
  if (typeof panel._wxRowWatch === "function") {
    try { panel._wxRowWatch(); } catch (e) {}
  }
  panel._wxRowWatch = null;
  if (typeof panel._wxCleanup === "function") {
    try { panel._wxCleanup(); } catch (e) {}
  } else {
    for (const pd of panel.querySelectorAll(".wx-detail-plot")) {
      try { Plotly.purge(pd); } catch (e) {}
    }
  }
  panel._wxCleanup = null;
  panel._wxStation = null;
  panel._wxTab = null;
  panel._wxPick = null;
  if (panel._wxRow) {
    panel._wxRow.classList.remove("sel");
    panel._wxRow = null;
  }
  panel.innerHTML = "";
}

function closeOverviewChart(panel, keepGrid) {
  const token = (panel._wxCloseToken || 0) + 1;
  panel._wxCloseToken = token;
  panel._wxOpenToken = (panel._wxOpenToken || 0) + 1;
  if (panel._wxRow) panel._wxRow.classList.remove("sel");
  panel.style.display = "none";
  panel.style.height = "";
  if (typeof panel._wxMapFocus === "function") panel._wxMapFocus();
  const grid = panel._wxGrid;
  if (grid && !keepGrid) {
    grid._wxYPushed = false;
    const cleared =
      typeof grid._wxClearFilter === "function" && grid._wxClearFilter();
    if (!cleared && typeof grid._wxRefresh === "function") grid._wxRefresh();
  }
  if (grid && typeof grid._wxAwaitDetail === "function") grid._wxAwaitDetail(false);
  if (grid && typeof grid._wxMapSync === "function") grid._wxMapSync();
  afterPaint().then(() => {
    if (panel._wxCloseToken !== token || panel.style.display !== "none") return;
    resetOverviewChart(panel);
  });
}

function detailPlotMax() {
  return Math.round(OVERVIEW_PLOT_MAX * heightScale());
}

function overviewPlotCap(panel) {
  const shell = panel.parentNode;
  if (!shell || !shell.classList.contains("wx-ov-shell")) {
    return detailPlotMax();
  }
  const room = shell.clientHeight;
  if (!room) return detailPlotMax();
  return Math.max(
    OVERVIEW_PLOT_MIN,
    Math.min(detailPlotMax(), Math.round(room * OVERVIEW_PLOT_SHARE))
  );
}

const PANEL_MARGIN = 12;

function stickyOffset() {
  const nav = document.getElementById("wx-nav");
  if (!nav) return 0;
  const pos = getComputedStyle(nav).position;
  if (pos !== "sticky" && pos !== "fixed") return 0;
  return Math.round(nav.getBoundingClientRect().height);
}

function showPanel(panel) {
  const rect = panel.getBoundingClientRect();
  const room = window.innerHeight || 0;
  const guard = stickyOffset() + PANEL_MARGIN;
  if (rect.top >= guard && rect.bottom <= room) return;
  const top = rect.top + window.scrollY - guard;
  try {
    window.scrollTo(0, Math.max(0, top));
  } catch (e) {
    void e;
  }
}

function revealRow(row) {
  const wrap = row.closest ? row.closest(".wx-ov-wrap") : null;
  if (!wrap) return;
  const head = wrap.querySelector("thead");
  const group = wrap.querySelector(".wx-ov-group");
  const box = wrap.getBoundingClientRect();
  const seen = row.getBoundingClientRect();
  const top =
    box.top +
    (head ? head.getBoundingClientRect().height : 0) +
    (group ? group.getBoundingClientRect().height : 0);
  if (seen.top < top) wrap.scrollTop -= top - seen.top;
  else if (seen.bottom > box.bottom) wrap.scrollTop += seen.bottom - box.bottom;
}

function watchRowVisible(panel, row) {
  if (typeof ResizeObserver !== "function") return;
  let raf = 0;
  const run = () => {
    raf = 0;
    if (panel._wxRow !== row || !row.isConnected) return;
    revealRow(row);
  };
  const obs = new ResizeObserver(() => {
    if (raf) return;
    raf = requestAnimationFrame(run);
  });
  try {
    obs.observe(panel);
  } catch (e) {
    return;
  }
  panel._wxRowWatch = () => {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    try { obs.disconnect(); } catch (e) {}
  };
}

function openStationChart(panel, station, tabId) {
  if (!panel || !station) return;
  if (panel.style.display !== "none" && panel._wxStation === station) {
    closeDetailByUser(panel);
    return;
  }
  openOverviewChart(panel, { station: station, tab: tabId || null }, null);
}

function toggleOverviewChart(panel, f, row) {
  if (panel.style.display !== "none" && panel._wxRow === row) {
    closeDetailByUser(panel);
    return;
  }
  openOverviewChart(panel, f, row);
}

function detailSpacer() {
  const wrap = el("div", "wx-detail-control wx-detail-spacer");
  wrap.setAttribute("aria-hidden", "true");
  wrap.appendChild(el("label", null, "\u00a0"));
  const sel = document.createElement("select");
  sel.className = "wx-detail-select";
  sel.tabIndex = -1;
  wrap.appendChild(sel);
  return wrap;
}

function holdHeightFor(panel) {
  const cap = overviewPlotCap(panel);
  if (_detailRef && typeof _detailRef.plotHeight === "function") {
    return _detailRef.plotHeight(cap);
  }
  return cap;
}

function openOverviewChart(panel, f, row, pick, view, restore) {
  ensureOverviewStyles();
  ensureDetailStyles();
  const openToken = (panel._wxOpenToken || 0) + 1;
  panel._wxOpenToken = openToken;
  const wasOpen = panel.style.display !== "none";
  resetOverviewChart(panel);
  panel.style.display = "";
  panel._wxRow = row || null;
  panel._wxStation = f.station || null;
  panel._wxTab = f.tab || null;
  if (row) row.classList.add("sel");
  if (typeof panel._wxMapFocus === "function") panel._wxMapFocus();

  if (!wasOpen) {
    panel.style.height = "";
  }

  const fold = f.tab !== DATA_TAB && !isMobile();
  const head = el("div", fold ? "wx-detail-head wx-detail-controls" : "wx-detail-head");
  const title = el("span", "t");
  title.textContent = f.station;
  const close = el("button", fold ? "wx-detail-close" : null, "Close");
  close.type = "button";
  close.addEventListener("click", () => closeDetailByUser(panel));
  head.appendChild(title);
  if (fold) head.appendChild(detailSpacer());
  head.appendChild(close);

  const body = el("div", "wx-detail-body");
  const loading = el("div", fold ? "al-loading wx-detail-hold" : "al-loading");
  loading.appendChild(el("div", "spinner"));
  loading.appendChild(el("span", null, "Loading\u2026"));
  body.appendChild(loading);

  panel.appendChild(head);
  panel.appendChild(body);
  if (fold) loading.style.height = holdHeightFor(panel) + "px";
  if (row) {
    watchRowVisible(panel, row);
    requestAnimationFrame(() => {
      if (panel._wxRow === row) revealRow(row);
    });
  } else if (!restore) {
    requestAnimationFrame(() => {
      if (panel._wxRow === null) showPanel(panel);
    });
  }

  if (f.tab === DATA_TAB) {
    mountGantt(panel, body, f, row);
    return;
  }

  const opts = detailOpts(f.station, f.tab);
  opts.maxHeight = () => overviewPlotCap(panel);
  opts.hold = !!restore;
  opts.gate = () => {
    const grid = panel._wxGrid;
    return grid && typeof grid._wxReady === "function" ? grid._wxReady() : null;
  };
  opts.onFit = () => {
    const grid = panel._wxGrid;
    if (!grid) return;
    if (typeof grid._wxAwaitDetail === "function") grid._wxAwaitDetail(false);
    if (typeof grid._wxRefit === "function") grid._wxRefit();
  };
  opts.onHistorical = (info) => {
    const grid = panel._wxGrid;
    if (grid && typeof grid._wxHistorical === "function") grid._wxHistorical(info);
  };
  opts.foldHead = fold;
  opts.pick = pick || null;
  opts.view = view || null;
  opts.shareY = (col, base, xrange) => {
    const grid = panel._wxGrid;
    return grid && typeof grid._wxShareY === "function"
      ? grid._wxShareY(col, base, xrange)
      : null;
  };
  detailModule()
    .then((m) => {
      if (fold && loading.isConnected && typeof m.plotHeight === "function") {
        loading.style.height = m.plotHeight(opts.maxHeight) + "px";
      }
      return m.mount(panel, opts);
    })
    .then(() => {
      if (panel._wxOpenToken !== openToken) return;
      wirePanelHover(panel);
      wirePlotBandGlyphs(panelPlot(panel));
      const grid = panel._wxGrid;
      if (grid) {
        requestAnimationFrame(() => {
          if (panel._wxOpenToken !== openToken) return;
          if (typeof grid._wxAwaitDetail === "function") grid._wxAwaitDetail(false);
          if (
            typeof grid._wxNeighbourSync === "function" &&
            grid._wxNeighbourSync()
          ) {
            return;
          }
          if (typeof grid._wxMapSync === "function") grid._wxMapSync();
          if (typeof grid._wxRefresh === "function") grid._wxRefresh();
        });
      }
      if (panel._wxRow !== (row || null)) return;
      if (!row && restore) return;
      requestAnimationFrame(() => {
        if (panel._wxRow !== (row || null)) return;
        if (row) revealRow(row);
        else showPanel(panel);
      });
    })
    .catch((e) => {
      console.warn("detail module failed", e);
      if (panel._wxOpenToken !== openToken) return;
      const held = panel._wxGrid;
      if (held && typeof held._wxAwaitDetail === "function") {
        held._wxAwaitDetail(false);
        if (typeof held._wxRefresh === "function") held._wxRefresh();
      }
      if (!panel.isConnected) return;
      body.innerHTML = "";
      body.appendChild(
        el("div", "wx-detail-msg", "Could not load the station chart.")
      );
    });
}

const GANTT_TAG_RE = /<[^>]*>/g;

const GANTT_PCT_RE = /\s+\(\d+%\)$/;

const GANTT_NC_SEP = " \u2715 ";

const GANTT_SUB_PREFIX = "\u2514";

const GANTT_ROW_PX = 40;

const GANTT_PANEL_PAD = 84;

const GANTT_PANEL_MIN = 160;

const GANTT_CLICK_DELAY = 300;

function ganttRowOwners(labels) {
  const owners = [];
  let current = null;
  for (const raw of labels) {
    const text = String(raw == null ? "" : raw).replace(GANTT_TAG_RE, "").trim();
    if (text.indexOf(GANTT_SUB_PREFIX) === 0) {
      owners.push(current);
      continue;
    }
    const nc = text.indexOf(GANTT_NC_SEP);
    if (nc > 0) {
      current = null;
      owners.push(text.slice(0, nc).trim());
      continue;
    }
    current = text.replace(GANTT_PCT_RE, "").trim() || null;
    owners.push(current);
  }
  return owners;
}

function ganttTrace(tr, keep) {
  const ys = tr ? decodeArray(tr.y) : null;
  if (!ys) return null;
  const n = ys.length;
  const picks = [];
  for (let i = 0; i < n; i++) {
    const at = keep.get(Math.round(Number(ys[i])));
    if (at !== undefined) picks.push([i, at]);
  }
  if (!picks.length) return null;
  const out = Object.assign({}, tr);
  out.y = picks.map((p) => p[1]);
  for (const key of ["x", "base", "text", "hovertext", "customdata"]) {
    const arr = decodeArray(tr[key]);
    if (!arr) continue;
    if (arr.length !== n) return null;
    out[key] = picks.map((p) => arr[p[0]]);
  }
  return out;
}

function ganttRows(layout) {
  const ya = layout && layout.yaxis;
  const labels = ya ? decodeArray(ya.ticktext) : null;
  const vals = ya ? decodeArray(ya.tickvals) : null;
  if (!labels || !vals || labels.length !== vals.length) return null;
  return { labels: labels, vals: vals };
}

function ganttRebuild(fig, kept, keepAll, keepData, hidden) {
  const data = [];
  for (const tr of fig.data || []) {
    if (tr && tr.type === "bar") {
      if (hidden && hidden.has(ganttTraceKey(tr))) {
        data.push(Object.assign({}, tr, { visible: "legendonly" }));
        continue;
      }
      const out = ganttTrace(tr, keepAll);
      if (out) data.push(Object.assign(out, { visible: true }));
      continue;
    }
    const out = ganttTrace(tr, keepData);
    if (out) data.push(out);
  }
  const layout = cloneLayout(fig.layout || {});
  const n = kept.length;
  const margin = layout.margin || {};
  layout.yaxis = Object.assign({}, layout.yaxis, {
    tickvals: kept.map((_v, i) => i),
    ticktext: kept,
    range: [Math.max(n, 1) - 0.5, -0.5],
    autorange: false,
    automargin: true,
  });
  layout.height = Math.max(
    GANTT_PANEL_MIN,
    n * GANTT_ROW_PX + (Number(margin.t) || 0) + (Number(margin.b) || 0)
  );
  return { data: data, layout: layout };
}

function ganttForStation(fig, station) {
  const rows = fig && Array.isArray(fig.data) ? ganttRows(fig.layout) : null;
  if (!rows) return null;
  const want = neighbourKey(station);
  const owners = ganttRowOwners(rows.labels);
  const kept = [];
  const keep = new Map();
  owners.forEach((owner, i) => {
    if (!owner || neighbourKey(owner) !== want) return;
    keep.set(Math.round(Number(rows.vals[i])), kept.length);
    kept.push(rows.labels[i]);
  });
  if (!kept.length) return null;
  const out = ganttRebuild(fig, kept, keep, keep, null);
  if (!out.data.some((tr) => tr.type === "bar")) return null;
  delete out.layout.title;
  out.layout.annotations = [];
  out.layout.margin = Object.assign({}, out.layout.margin, { t: 24 });
  out.layout.height = Math.max(GANTT_PANEL_MIN, kept.length * GANTT_ROW_PX + GANTT_PANEL_PAD);
  return out;
}

function ganttTraceKey(tr) {
  return String((tr && (tr.legendgroup || tr.name)) || "");
}

function ganttCompact(base, hidden) {
  if (!base || !hidden.size || !Array.isArray(base.data)) return base;
  const rows = ganttRows(base.layout);
  if (!rows) return base;

  const rowAt = new Map();
  rows.vals.forEach((v, i) => rowAt.set(Math.round(Number(v)), i));
  const owners = ganttRowOwners(rows.labels);

  const dataRows = new Set();
  for (const tr of base.data) {
    if (!tr || tr.type !== "bar" || hidden.has(ganttTraceKey(tr))) continue;
    for (const y of decodeArray(tr.y) || []) {
      const i = rowAt.get(Math.round(Number(y)));
      if (i !== undefined) dataRows.add(i);
    }
  }

  const live = new Set();
  dataRows.forEach((i) => {
    if (owners[i]) live.add(neighbourKey(owners[i]));
  });

  const kept = [];
  const keepAll = new Map();
  const keepData = new Map();
  rows.labels.forEach((label, i) => {
    const text = String(label == null ? "" : label).replace(GANTT_TAG_RE, "").trim();
    const header = text.indexOf(GANTT_SUB_PREFIX) !== 0 && text.indexOf(GANTT_NC_SEP) < 0;
    const hasData = dataRows.has(i);
    if (!hasData && !(header && !!owners[i] && live.has(neighbourKey(owners[i])))) return;
    const y = Math.round(Number(rows.vals[i]));
    keepAll.set(y, kept.length);
    if (hasData) keepData.set(y, kept.length);
    kept.push(label);
  });

  return ganttRebuild(base, kept, keepAll, keepData, hidden);
}

function wholeGantt(fig) {
  const layout = cloneLayout(fig.layout || {});
  delete layout.width;
  layout.autosize = true;
  layout.height = layout.height || 420;
  return { data: fig.data || [], layout: layout };
}

function ganttView(g, base, cap) {
  const view = { base: base, hidden: new Set() };
  let want = null;
  let timer = null;

  const draw = () => {
    const built = ganttCompact(view.base, view.hidden);
    const next = { data: built.data, layout: cloneLayout(built.layout) };
    if (typeof cap === "function") {
      const limit = cap();
      if (limit && next.layout.height > limit) next.layout.height = limit;
    }
    want = next;
    g._wxOnDrawn(() => {
      if (want === next) renderPlot(g, next);
    });
  };

  const keys = () => {
    const out = [];
    for (const tr of view.base.data || []) {
      if (!tr || tr.type !== "bar") continue;
      const k = ganttTraceKey(tr);
      if (k && out.indexOf(k) < 0) out.push(k);
    }
    return out;
  };

  const toggle = (key) => {
    if (view.hidden.has(key)) view.hidden.delete(key);
    else view.hidden.add(key);
    draw();
  };

  const isolate = (key) => {
    const all = keys();
    const solo = all.every((k) => (k === key) !== view.hidden.has(k));
    view.hidden = new Set(solo ? [] : all.filter((k) => k !== key));
    draw();
  };

  g._wxOnDrawn(() => {
    const pd = g._wxPlotDiv;
    if (!pd || pd._wxGanttLegend || typeof pd.on !== "function") return;
    pd._wxGanttLegend = true;
    const keyOf = (ev) => {
      const list = ev && (ev.data || ev.fullData);
      return list ? ganttTraceKey(list[ev.curveNumber]) : "";
    };
    pd.on("plotly_legendclick", (ev) => {
      const key = keyOf(ev);
      if (timer) clearTimeout(timer);
      const delay = (pd._context && pd._context.doubleClickDelay) || GANTT_CLICK_DELAY;
      timer = setTimeout(() => {
        timer = null;
        if (key) toggle(key);
      }, delay);
      return false;
    });
    let resetting = false;
    pd.on("plotly_doubleclick", () => {
      resetting = true;
    });
    pd.on("plotly_relayout", () => {
      if (!resetting) return;
      resetting = false;
      draw();
    });
    pd.on("plotly_legenddoubleclick", (ev) => {
      if (timer) clearTimeout(timer);
      timer = null;
      const key = keyOf(ev);
      if (key) isolate(key);
      return false;
    });
  });

  view.setBase = (next) => {
    view.base = next;
    draw();
  };

  return view;
}

function ganttMessage(body, text) {
  body.innerHTML = "";
  body.appendChild(ovText("div", "wx-detail-msg", text));
}

function renderPlot(g, next) {
  const pd = g._wxPlotDiv;
  if (!pd || !pd._wxDrawn || !pd.isConnected) return;
  next.layout.autosize = true;
  delete next.layout.width;
  pd._wxRowFit = null;
  let view = next;
  if (isMobile()) {
    try {
      view = buildMobileFigure(next, { height: next.layout.height });
    } catch (e) {
      view = next;
    }
  }
  pd.style.height = view.layout.height + "px";
  try {
    Plotly.react(pd, view.data, view.layout, g._wxConfig);
  } catch (e) {
    console.warn("plot redraw failed", e);
    return;
  }
  if (typeof g._wxResize === "function") g._wxResize();
  if (typeof g._wxFit === "function") g._wxFit();
}

function mountGantt(panel, body, f, row) {
  const owner = row || null;
  const station = f.station || null;
  const fc = state.fc;
  const hours = state.hours;
  const live = () =>
    body.isConnected &&
    panel._wxRow === owner &&
    panel._wxStation === station &&
    state.fc === fc &&
    state.hours === hours;

  panel._wxCleanup = () => {
    for (const pd of panel.querySelectorAll(".wx-plot")) {
      try { Plotly.purge(pd); } catch (e) {}
    }
  };

  loadCharts(fc, hours, DATA_SUFFIX)
    .then((c) => {
      if (!live()) return;
      if (!c || !c.data_gantt) {
        ganttMessage(body, "Missing-data chart unavailable for this window.");
        return;
      }
      const fig = ganttForStation(c.data_gantt, station);
      if (!fig) {
        ganttMessage(body, `No missing-data rows for ${station} in this window.`);
        return;
      }
      const shell = panel.parentNode;
      const inShell = !!(shell && shell.classList.contains("wx-ov-shell"));
      const cap = inShell ? () => overviewPlotCap(panel) : null;
      const height = cap ? Math.min(fig.layout.height, cap()) : fig.layout.height;
      body.innerHTML = "";
      const g = graph({ data: fig.data, layout: cloneLayout(fig.layout) }, { height: height });
      body.appendChild(g);
      ganttView(g, fig, cap);
      requestAnimationFrame(() => {
        if (!live()) return;
        if (row) revealRow(row);
        else showPanel(panel);
      });
    })
    .catch((e) => {
      console.warn("gantt panel failed", e);
      if (!body.isConnected) return;
      ganttMessage(body, "Could not load the missing-data chart.");
    });
}

const RGBA_RE = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i;

function solid(color) {
  const raw = String(color || "");
  if (/^#[0-9a-f]{6}$/i.test(raw)) return raw;
  const m = RGBA_RE.exec(raw);
  return m ? `rgb(${m[1]}, ${m[2]}, ${m[3]})` : null;
}

function overviewRow(f, panel, columns, onPick) {
  const row = el("tr", "wx-ov-row");
  for (const name of columns) {
    const build = OVERVIEW_CELLS[name];
    if (!build) continue;
    const cell = build(f);
    if (name === "Sensor") row._wxSensor = cell;
    if (name === "Type") row._wxType = cell;
    if (!row.firstChild) {
      const bar = solid(f.color);
      if (bar) cell.style.borderLeftColor = bar;
    }
    row.appendChild(cell);
  }
  row.title = "Show " + f.station;
  row._wxStation = f.station || null;
  row._wxFinding = f;
  row.addEventListener("click", () => {
    if (onPick) onPick(f, row);
    else toggleOverviewChart(panel, f, row);
  });
  row.addEventListener("pointerenter", () => {
    if (f.tab !== DATA_TAB) prefetchDetail(f.station, f.tab);
  });
  row.addEventListener("pointerleave", cancelPrefetch);
  return row;
}

function groupRank(entries) {
  const area = new Map();
  const section = new Map();
  for (const e of entries) {
    const sev = ovSeverity(e.f);
    const a = String(e.f.area || "");
    const k = a + "\u0000" + String(e.f.section || "");
    if (!area.has(a) || area.get(a) < sev) area.set(a, sev);
    if (!section.has(k) || section.get(k) < sev) section.set(k, sev);
  }
  return { area: area, section: section };
}

function stationGroupOrder(entries, dir) {
  const count = new Map();
  const top = new Map();
  for (const e of entries) {
    const k = String(e.f.station || "");
    count.set(k, (count.get(k) || 0) + 1);
    top.set(k, Math.max(top.has(k) ? top.get(k) : -Infinity, ovSeverity(e.f)));
  }
  return entries.slice().sort((a, b) => {
    const sa = String(a.f.station || "");
    const sb = String(b.f.station || "");
    if (sa !== sb) {
      return (
        dir * (count.get(sb) - count.get(sa) || top.get(sb) - top.get(sa)) ||
        sa.localeCompare(sb)
      );
    }
    return ovSeverity(b.f) - ovSeverity(a.f) || a.i - b.i;
  });
}

function sortRows(entries, column, dir) {
  if (dir && column === "Station") return stationGroupOrder(entries, dir);
  const flat = dir && column !== "Sensor" && column !== "Type";
  if (flat) {
    const cmp = OVERVIEW_SORTS[column];
    const blank = OVERVIEW_BLANK[column];
    if (cmp) {
      return entries.slice().sort((a, b) => {
        if (blank) {
          const ab = blank(a.f);
          const bb = blank(b.f);
          if (ab !== bb) return ab ? 1 : -1;
        }
        return dir * cmp(a.f, b.f) || a.i - b.i;
      });
    }
  }

  const rank = groupRank(entries);
  return entries.slice().sort((a, b) => {
    const aArea = String(a.f.area || "");
    const bArea = String(b.f.area || "");
    if (aArea !== bArea) {
      if (column === "Sensor") return dir * (ovAreaRank(a.f) - ovAreaRank(b.f));
      if (aArea === DATA_AREA || bArea === DATA_AREA) {
        return aArea === DATA_AREA ? -1 : 1;
      }
      return (
        rank.area.get(bArea) - rank.area.get(aArea) || aArea.localeCompare(bArea)
      );
    }
    if (aArea === DATA_AREA && column !== "Type") return dataRowOrder(a, b);
    const aSec = String(a.f.section || "");
    const bSec = String(b.f.section || "");
    if (aSec !== bSec) {
      if (!aSec || !bSec) return aSec ? -1 : 1;
      if (column === "Type") return dir * aSec.localeCompare(bSec);
      const aKey = aArea + "\u0000" + aSec;
      const bKey = bArea + "\u0000" + bSec;
      return (
        rank.section.get(bKey) - rank.section.get(aKey) || aSec.localeCompare(bSec)
      );
    }
    return ovSeverity(b.f) - ovSeverity(a.f) || a.i - b.i;
  });
}

function overviewTable(findings, panel, columns, onPick) {
  const wrap = el("div", "wx-ov-wrap");
  const table = el("table", "wx-ov-table");
  const thead = el("thead");
  const headRow = el("tr");
  const tbody = el("tbody");

  const entries = findings.map((f, i) => ({
    f: f,
    i: i,
    row: overviewRow(f, panel, columns, onPick),
  }));
  for (const e of entries) tbody.appendChild(e.row);

  let column = null;
  let dir = 0;
  const cells = new Map();

  const apply = () => {
    for (const [name, cell] of cells) {
      const mark = cell.querySelector(".a");
      if (mark) mark.remove();
      if (name !== column || !dir) continue;
      const arrow = el("span", "a");
      const down = name === "Station" ? dir > 0 : dir < 0;
      arrow.textContent = down ? "\u2193" : "\u2191";
      cell.appendChild(arrow);
    }
    const ordered = sortRows(entries, column, dir);
    let area = null;
    let section = null;
    for (const e of ordered) {
      tbody.appendChild(e.row);
      const a = String(e.f.area || "");
      const s = String(e.f.section || "");
      if (e.row._wxSensor) {
        e.row._wxSensor.textContent = a && a === area ? "" : a;
      }
      if (e.row._wxType) {
        e.row._wxType.textContent = s && s === section && a === area ? "" : s;
      }
      area = a;
      section = s;
    }
    wrap.scrollTop = 0;
  };

  for (const label of columns) {
    const cell = ovText("th", null, label);
    cells.set(label, cell);
    cell.addEventListener("click", () => {
      if (column !== label) {
        column = label;
        dir = 1;
      } else if (dir === 1) {
        dir = -1;
      } else {
        column = null;
        dir = 0;
      }
      apply();
    });
    headRow.appendChild(cell);
  }

  thead.appendChild(headRow);
  table.appendChild(thead);
  table.appendChild(tbody);
  wrap.appendChild(table);
  apply();
  return wrap;
}

function sensorRowOrder(column, dir) {
  const cmp = dir ? SENSOR_SORTS[column] : null;
  const blank = dir ? OVERVIEW_BLANK[column] : null;
  return (a, b) => {
    if (cmp) {
      if (blank) {
        const ab = blank(a.f);
        const bb = blank(b.f);
        if (ab !== bb) return ab ? 1 : -1;
      }
      return dir * cmp(a.f, b.f) || a.i - b.i;
    }
    if (a.f.area === DATA_AREA) return dataRowOrder(a, b);
    return ovSeverity(b.f) - ovSeverity(a.f) || a.i - b.i;
  };
}

function sensorSections(entries, column, dir, areas) {
  const order = sensorRowOrder(column, dir);
  const out = [];
  for (const area of areas || AREA_ORDER) {
    const groups = new Map();
    for (const e of entries) {
      if (e.f.area !== area) continue;
      const key = String(e.f.section || "");
      let g = groups.get(key);
      if (!g) {
        g = { section: key, top: -Infinity, rows: [] };
        groups.set(key, g);
      }
      g.rows.push(e);
      g.top = Math.max(g.top, ovSeverity(e.f));
    }
    const types = Array.from(groups.values()).sort((a, b) => {
      if (!a.section || !b.section) {
        if (a.section === b.section) return 0;
        return a.section ? -1 : 1;
      }
      return b.top - a.top || a.section.localeCompare(b.section);
    });
    for (const g of types) g.rows.sort(order);
    out.push({ area: area, types: types });
  }
  return out;
}

function sensorEmptyText(area, missing) {
  if (missing && missing.has(area)) return SENSOR_MISSING_TEXT;
  return SENSOR_EMPTY_TEXT;
}

function spanRow(className, text, span) {
  const row = el("tr", className);
  const cell = ovText("td", null, text);
  cell.colSpan = span;
  row.appendChild(cell);
  return row;
}

function sensorTable(findings, panel, missing, opts) {
  const columns = SENSOR_COLUMNS;
  const areas = (opts && opts.areas) || AREA_ORDER;
  const headers = !(opts && opts.headers === false);
  const onPick = (opts && opts.onPick) || null;
  const wrap = el("div", "wx-ov-wrap");
  const table = el("table", "wx-ov-table wx-ov-sect");
  const thead = el("thead");
  const headRow = el("tr");
  const tbody = el("tbody");

  const entries = findings.map((f, i) => ({
    f: f,
    i: i,
    row: overviewRow(f, panel, columns, onPick),
  }));

  let column = null;
  let dir = 0;
  const cells = new Map();

  const apply = () => {
    for (const [name, cell] of cells) {
      const mark = cell.querySelector(".a");
      if (mark) mark.remove();
      if (name !== column || !dir) continue;
      const arrow = el("span", "a");
      arrow.textContent = dir < 0 ? "↓" : "↑";
      cell.appendChild(arrow);
    }
    const nodes = [];
    for (const group of sensorSections(entries, column, dir, areas)) {
      if (headers) nodes.push(spanRow("wx-ov-group", group.area, columns.length));
      if (!group.types.length) {
        nodes.push(
          spanRow("wx-ov-none", sensorEmptyText(group.area, missing), columns.length)
        );
        continue;
      }
      for (const type of group.types) {
        if (type.section) {
          nodes.push(spanRow("wx-ov-sub", type.section, columns.length));
        }
        for (const e of type.rows) nodes.push(e.row);
      }
    }
    tbody.replaceChildren(...nodes);
    wrap.scrollTop = 0;
  };

  for (const label of columns) {
    const cell = ovText("th", null, label);
    cells.set(label, cell);
    cell.addEventListener("click", () => {
      if (column !== label) {
        column = label;
        dir = 1;
      } else if (dir === 1) {
        dir = -1;
      } else {
        column = null;
        dir = 0;
      }
      apply();
    });
    headRow.appendChild(cell);
  }

  thead.appendChild(headRow);
  table.appendChild(thead);
  table.appendChild(tbody);
  wrap.appendChild(table);
  apply();
  return wrap;
}

function emptyTable(text) {
  const wrap = el("div", "wx-ov-wrap");
  const table = el("table", "wx-ov-table wx-ov-sect");
  const tbody = el("tbody");
  tbody.appendChild(spanRow("wx-ov-none", text, 1));
  table.appendChild(tbody);
  wrap.appendChild(table);
  return wrap;
}

const OVERVIEW_SHELL_GAP = 8;

function overviewReserve(shell) {
  let reserve = OVERVIEW_SHELL_GAP;
  const px = (v) => parseFloat(v) || 0;

  let node = shell;
  while (node && node !== document.body && node.nodeType === 1) {
    let cs = null;
    try {
      cs = window.getComputedStyle(node);
    } catch (e) {
      cs = null;
    }
    if (cs) {
      reserve += px(cs.marginBottom);
      if (node !== shell) {
        reserve += px(cs.paddingBottom) + px(cs.borderBottomWidth);
      }
    }
    node = node.parentNode;
  }

  const footer = document.querySelector(".al-footer");
  if (footer) {
    const box = footer.getBoundingClientRect();
    if (box.height) {
      let cs = null;
      try {
        cs = window.getComputedStyle(footer);
      } catch (e) {
        cs = null;
      }
      reserve += box.height + (cs ? px(cs.marginTop) + px(cs.marginBottom) : 0);
    }
  }

  return Math.round(reserve);
}

function sizeOverviewShell() {
  const root = activePane() || $main;
  const shell = root && root.querySelector(".wx-ov-shell");
  if (!shell) return;
  const top = shell.getBoundingClientRect().top;
  const avail = window.innerHeight - top - overviewReserve(shell);
  shell.style.height = Math.max(320, Math.round(avail)) + "px";
  const picker = shell.closest(".wx-ov-stack");
  if (picker && typeof picker._wxMapClaim === "function") picker._wxMapClaim();
}



const OV_DEFAULT_TAB = "tab-temp";

const OV_FIND_MAX = 8;

function ensureOverviewPickerStyles() {
  if (document.getElementById("wx-ovpick-styles")) return;
  const st = document.createElement("style");
  st.id = "wx-ovpick-styles";
  st.textContent = [
    ".wx-ov-stack{margin-bottom:0;}",
    "@media (min-width:769px){.wx-ov-slot{background:" + NEIGHBOUR_MAP_PAPER + ";",
    "border-radius:10px;}}",
    ".wx-ov-find{position:absolute;top:8px;right:68px;z-index:30;width:150px;}",
    ".wx-nb-map.wx-expanded .wx-ov-find{width:190px;}",
    ".wx-nb-map.wx-nb-map-fixed .wx-ov-find{right:8px;}",
    ".wx-ov-find{transition:opacity .2s ease;}",
    ".wx-nb-map.wx-nb-map-wait .wx-ov-find{opacity:0;pointer-events:none;transition:none;}",
    ".wx-ov-find svg{position:absolute;left:8px;top:7px;width:12px;height:12px;fill:none;",
    "stroke:var(--text-muted,#8a857d);stroke-width:1.5;stroke-linecap:round;pointer-events:none;}",
    ".wx-ov-find-input{display:block;width:100%;height:26px;box-sizing:border-box;margin:0;",
    "font-family:inherit;font-size:11px;font-weight:500;letter-spacing:.01em;",
    "padding:0 8px 0 25px;color:var(--text,#26231f);background:rgba(255,255,255,.85);",
    "border:1px solid var(--line,#e8e6e3);border-radius:6px;outline:none;box-shadow:none;",
    "-webkit-appearance:none;appearance:none;transition:background-color .15s ease,border-color .15s ease;}",
    ".wx-ov-find-input::placeholder{color:var(--text-muted,#8a857d);}",
    ".wx-ov-find-input:hover{background:#fff;}",
    ".wx-ov-find-input:focus{background:#fff;border-color:#c9c4bc;}",
    ".wx-ov-find-input::-webkit-search-cancel-button{-webkit-appearance:none;display:none;}",
    ".wx-ov-find-list{display:none;position:absolute;left:0;right:0;top:30px;",
    "background:var(--surface,#fff);border:1px solid var(--line,#e8e6e3);border-radius:6px;",
    "box-shadow:0 1px 3px rgba(0,0,0,.04);padding:3px 0;max-height:150px;overflow:auto;}",
    ".wx-ov-find-list.on{display:block;}",
    ".wx-ov-find-opt{padding:4px 9px;font-size:11px;font-weight:500;color:var(--text,#26231f);",
    "white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer;}",
    ".wx-ov-find-opt.act{background:#f3f2ef;}",
    ".wx-ov-find-none{padding:4px 9px;font-size:11px;color:var(--text-muted,#8a857d);}",
  ].join("");
  document.head.appendChild(st);
}

function coordFc(at) {
  return (at && at.fc) || UNASSIGNED_FC;
}

function pickableCoords() {
  if (!_nbCoords) return [];
  const offered = new Set(Array.from($fcSelect.options).map((o) => o.value).filter(Boolean));
  const out = [];
  for (const at of _nbCoords.values()) {
    if (!at || !at.name || at.enabled === false) continue;
    if (!offered.has(coordFc(at))) continue;
    out.push(at);
  }
  return out;
}

function mapSearch(slot, fc, onPick) {
  ensureOverviewPickerStyles();
  const find = el("div", "wx-ov-find");
  find.innerHTML =
    '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
    '<circle cx="7" cy="7" r="4.5"/><path d="M10.4 10.4 14 14"/></svg>';
  const input = document.createElement("input");
  input.className = "wx-ov-find-input";
  input.type = "search";
  input.placeholder = "Find a station";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.setAttribute("aria-label", "Find a station");
  const list = el("div", "wx-ov-find-list");
  list.setAttribute("role", "listbox");
  find.appendChild(input);
  find.appendChild(list);

  let hits = [];
  let active = -1;

  const markHits = () => {
    if (!_sharedNeighbourMap) return;
    _sharedNeighbourMap.mark(slot, new Set(hits.map((at) => neighbourKey(at.name))));
  };

  const closeList = () => {
    list.className = "wx-ov-find-list";
    active = -1;
  };

  const clearFind = () => {
    input.value = "";
    hits = [];
    closeList();
    markHits();
  };

  const pick = (name) => {
    clearFind();
    input.blur();
    onPick(name);
  };

  const paintList = () => {
    list.innerHTML = "";
    if (!input.value.trim()) {
      closeList();
      return;
    }
    if (!hits.length) {
      list.appendChild(el("div", "wx-ov-find-none", "No matching stations"));
    }
    hits.forEach((at, i) => {
      const opt = el("div", "wx-ov-find-opt" + (i === active ? " act" : ""));
      opt.setAttribute("role", "option");
      opt.textContent = at.name;
      opt.addEventListener("mousedown", (ev) => {
        ev.preventDefault();
        pick(at.name);
      });
      opt.addEventListener("mouseenter", () => {
        active = i;
        for (const [j, node] of Array.from(list.children).entries()) {
          node.classList.toggle("act", j === i);
        }
      });
      list.appendChild(opt);
    });
    list.className = "wx-ov-find-list on";
  };

  const search = () => {
    const q = neighbourKey(input.value);
    hits = [];
    active = -1;
    if (q) {
      const scored = [];
      for (const at of pickableCoords()) {
        if (coordFc(at) !== fc) continue;
        const k = neighbourKey(at.name);
        const i = k.indexOf(q);
        if (i < 0) continue;
        scored.push({ at: at, lead: i === 0 ? 0 : 1 });
      }
      scored.sort((a, b) => a.lead - b.lead || a.at.name.localeCompare(b.at.name));
      hits = scored.slice(0, OV_FIND_MAX).map((x) => x.at);
      if (hits.length) active = 0;
    }
    paintList();
    markHits();
  };

  input.addEventListener("focus", () => warmNeighbours(() => {
    if (input.value.trim()) search();
  }));
  input.addEventListener("input", () => warmNeighbours(search));
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      if (!hits.length) return;
      ev.preventDefault();
      const step = ev.key === "ArrowDown" ? 1 : -1;
      active = (active + step + hits.length) % hits.length;
      paintList();
      return;
    }
    if (ev.key === "Enter") {
      ev.preventDefault();
      const at = hits[active >= 0 ? active : 0];
      if (at) pick(at.name);
      return;
    }
    if (ev.key === "Escape") {
      ev.preventDefault();
      clearFind();
      input.blur();
    }
  });
  input.addEventListener("blur", () => {
    setTimeout(closeList, 0);
  });

  find._wxRemark = markHits;
  return find;
}

function overviewPicker(fc, findings, table, shell) {
  ensureNeighbourMapStyles();
  ensureOverviewPickerStyles();
  const stack = el("div", "wx-nb-stack wx-ov-stack");
  const main = el("div", "wx-nb-main");
  main.appendChild(shell);
  const slot = el("div", "wx-nb-map-slot wx-ov-slot");
  if (isMobile()) {
    slot.style.minHeight = NEIGHBOUR_MAP_HEIGHT + 12 + "px";
  } else {
    slot.style.width = NEIGHBOUR_MAP_WIDTH_EXPANDED + 2 + "px";
    stack.classList.add("has-map");
  }
  slot._wxMapZoomLabels = true;
  slot._wxMapLocalOnly = true;
  slot._wxMapSize = () => {
    if (isMobile()) {
      const room = Math.round(slot.clientWidth || 0) - 2;
      return {
        w: room > 0 ? Math.min(NEIGHBOUR_MAP_WIDTH_EXPANDED, room) : NEIGHBOUR_MAP_WIDTH,
        h: NEIGHBOUR_MAP_HEIGHT,
      };
    }
    const tall = Math.round(shell.clientHeight || 0) - 2;
    return {
      w: NEIGHBOUR_MAP_WIDTH_EXPANDED,
      h: Math.max(NEIGHBOUR_MAP_HEIGHT, tall),
    };
  };
  stack.appendChild(main);
  stack.appendChild(slot);

  let shownKey = null;

  const fcNames = () =>
    pickableCoords()
      .filter((at) => coordFc(at) === fc)
      .map((at) => at.name);

  const openHere = (station) => {
    const f = stationFinding(findings, station);
    openFindingInTab({ station: f.station || station, tab: f.tab });
  };

  const pick = (name) => {
    const at = stationCoord(name);
    if (!at || coordFc(at) !== fc) return;
    openHere(at.name || name);
  };

  slot._wxMapTool = mapSearch(slot, fc, pick);

  const sync = () => {
    if (state.fc !== fc || !inActivePane(slot)) return;
    const map = sharedNeighbourMap();
    const focus = null;
    const key = focus ? neighbourKey(focus) : "";
    if (key !== shownKey) {
      shownKey = key;
      map.fit();
    }
    const actions = { open: (name) => pick(name) };
    if (focus) {
      const around = neighboursFor(
        focus,
        pickableCoords().map((at) => at.name)
      ).filter((n) => neighbourKey(n) !== key);
      if (around.length) {
        map.show(focus, around, null, slot, actions, false);
        slot._wxMapTool._wxRemark();
        return;
      }
    }
    const names = fcNames().filter((n) => neighbourKey(n) !== key);
    if (!names.length) {
      map.hide(slot);
      return;
    }
    map.show(focus, names, null, slot, actions, true);
    slot._wxMapTool._wxRemark();
  };

  stack._wxPeek = (name) => {
    if (_sharedNeighbourMap) _sharedNeighbourMap.peek(slot, name || null);
  };
  stack._wxMapClaim = () => {
    warmNeighbours(() => {
      if (state.fc !== fc) return;
      sync();
    });
  };
  return stack;
}

let _carryOverride = null;

function openFindingInTab(f) {
  const tabId = f.tab;
  if (!tabId || tabId === OVERVIEW_TAB) return;
  if (!CARRY_TABS.has(tabId)) {
    renderTab(tabId);
    return;
  }
  _carryOverride = {
    tab: tabId,
    saved: { station: f.station, tab: tabId, pick: null, view: null },
  };
  renderTab(tabId);
}

function stationFinding(findings, station) {
  const key = neighbourKey(station);
  let best = null;
  for (const f of findings) {
    if (neighbourKey(f.station) !== key || !CARRY_TABS.has(f.tab) || f.tab === OVERVIEW_TAB) {
      continue;
    }
    if (!best || ovSeverity(f) > ovSeverity(best)) best = f;
  }
  return best || { station: station, tab: OV_DEFAULT_TAB };
}

async function buildOverview(fc, hours) {
  ensureOverviewStyles();
  const box = el("div");

  let findings = [];
  let missing = new Set();
  try {
    const found = await collectFindings(fc, hours);
    findings = found.findings;
    missing = found.missing;
  } catch (e) {
    console.warn("overview failed", e);
    findings = [];
    missing = new Set(AREA_ORDER);
  }

  const shell = el("div", "wx-ov-shell");
  const table = sensorTable(findings, null, missing, {
    onPick: (f) => openFindingInTab(f),
  });
  shell.appendChild(table);
  const picker = overviewPicker(fc, findings, table, shell);
  box.appendChild(picker);
  let peeked = null;
  table.addEventListener("pointerover", (ev) => {
    const row = ev.target && ev.target.closest ? ev.target.closest(".wx-ov-row") : null;
    const name = row ? row._wxStation || null : null;
    if (name === peeked) return;
    peeked = name;
    picker._wxPeek(name);
  });
  table.addEventListener("pointerleave", () => {
    peeked = null;
    picker._wxPeek(null);
  });
  requestAnimationFrame(sizeOverviewShell);

  if (!isMobile()) {
    const first = findings.find((x) => x.tab !== DATA_TAB);
    whenFree(() => {
      if (state.fc !== fc || state.hours !== hours) return;
      warmDetail(true);
      if (!first) return;
      detailModule()
        .then((m) => m.prefetch(detailOpts(first.station, first.tab)))
        .catch(() => {});
    });
  }

  return box;
}

async function buildRh(fc, hours) {
  const c = await loadCharts(fc, hours, "rh");
  if (!c) return unavailable();
  const box = el("div");
  const grid = stationGrid(c, null, { suffix: "rh" });
  const panel = tabPanel(grid);
  const banner = await insightBanner(fc, hours, "rh", panel);
  box.appendChild(insightStack(banner, panel, grid));
  box.appendChild(boxCard(c.rh_distribution));
  box.appendChild(row(
    rowGraph(c.rh_volcano, { stationFilter: true }),
    rowGraph(c.rh100_scatter)
  ));
  return box;
}

async function buildWind(fc, hours) {
  const c = await loadCharts(fc, hours, "wind");
  if (!c) return unavailable();
  const box = el("div");
  const grid = stationGrid(c, [
    { key: "station_grid", label: "Wspd" },
    { key: "station_grid_mx", label: "Mx Spd" },
    { key: "station_grid_dir", label: "Dir" },
  ], { suffix: "wind", barbs: true });
  const panel = tabPanel(grid);
  const banner = await insightBanner(fc, hours, "wind", panel);
  box.appendChild(insightStack(banner, panel, grid));
  box.appendChild(row(
    graph(c.wind_distribution, { height: boxHeight() }),
    graph(c.mx_distribution, { height: boxHeight() })
  ));
  box.appendChild(row(rowGraph(c.wind_stall_heatmap), rowGraph(c.dir_coverage_heatmap)));
  return box;
}

async function buildTemp(fc, hours) {
  const c = await loadCharts(fc, hours, "temp");
  if (!c) return unavailable();
  const box = el("div");
  const grid = stationGrid(c, null, { suffix: "temp" });
  const panel = tabPanel(grid);
  const banner = await insightBanner(fc, hours, "temp", panel);
  box.appendChild(insightStack(banner, panel, grid));
  box.appendChild(boxCard(c.temp_distribution));
  box.appendChild(row(
    rowGraph(c.temp_volcano, { stationFilter: true }),
    rowGraph(c.constant_temp_gantt)
  ));
  return box;
}

async function buildRn1(fc, hours) {
  const c = await loadCharts(fc, hours, "rn1");
  if (!c) return unavailable();
  const box = el("div");
  const grid = stationGrid(c, null, { cumulative: true, suffix: "rn1" });
  const panel = tabPanel(grid);
  const banner = await insightBanner(fc, hours, "rn1", panel);
  box.appendChild(insightStack(banner, panel, grid));
  box.appendChild(boxCard(c.rn1_distribution));
  box.appendChild(row(
    rowGraph(c.precip_diagnostic_dashboard, { stationFilter: true }),
    rowGraph(c.precip_silent_sensor)
  ));
  return box;
}

async function buildPower(fc, hours) {
  const c = await loadCharts(fc, hours, "power");
  if (!c) return unavailable();
  const box = el("div");
  const grid = stationGrid(c, null, { suffix: "power" });
  const panel = tabPanel(grid);
  const banner = await insightBanner(fc, hours, "power", panel);
  box.appendChild(insightStack(banner, panel, grid));
  box.appendChild(boxCard(stripTitle(c.power_distribution)));
  box.appendChild(row(
    rowGraph(annotateEmptyPanels(c.power_diagnostic_dashboard,
                                 "No daytime no-charge events detected")),
    rowGraph(c.vbat_heatmap)
  ));
  return box;
}

function dataGantt(fig) {
  ensureDetailStyles();
  const g = graph(fig);
  const node = card(g, null, { expandable: false });
  const whole = wholeGantt(fig);
  const view = ganttView(g, whole, null);
  let picked = null;

  const head = el("div", "wx-detail-head");
  const title = el("span", "t");
  const close = el("button", null, "Close");
  close.type = "button";
  head.appendChild(title);
  head.appendChild(close);
  head.style.display = "none";
  node.insertBefore(head, g);

  const clear = () => {
    if (picked) picked.classList.remove("sel");
    picked = null;
    head.style.display = "none";
    title.textContent = "";
    view.setBase(whole);
  };

  close.addEventListener("click", clear);

  const pick = (f, row) => {
    if (picked === row) {
      clear();
      return;
    }
    const next = ganttForStation(fig, f.station);
    if (!next) return;
    if (picked) picked.classList.remove("sel");
    picked = row;
    row.classList.add("sel");
    title.textContent = f.station;
    head.style.display = "";
    view.setBase(next);
    requestAnimationFrame(() => {
      if (picked === row) showPanel(node);
    });
  };

  return { node: node, pick: pick };
}

async function buildData(fc, hours) {
  const c = await loadCharts(fc, hours, DATA_SUFFIX);
  const box = el("div");
  const view = c && c.data_gantt ? dataGantt(c.data_gantt) : null;
  const pick = view ? view.pick : () => {};
  box.appendChild(await insightBanner(fc, hours, DATA_SUFFIX, null, pick));
  box.appendChild(view ? view.node : unavailable());
  return box;
}

let _detailModule = null;

let _detailRef = null;

function resetHistorical() {
  if (!_detailModule) return;
  _detailModule.then(
    (m) => {
      if (typeof m.resetHistorical === "function") m.resetHistorical();
    },
    () => {}
  );
}

function closeDetailByUser(panel) {
  resetHistorical();
  closeOverviewChart(panel);
}

function detailModule() {
  if (!_detailModule) {
    _detailModule = import("./detail.js").then((m) => {
      _detailRef = m;
      return m;
    });
    _detailModule.catch(() => { _detailModule = null; });
  }
  return _detailModule;
}

let _warmedEngine = false;
let _warmScheduled = false;

function warmDetail(engine) {
  detailModule()
    .then((m) => {
      m.warmConfig();
      if (engine && !_warmedEngine) {
        _warmedEngine = true;
        m.warmEngine();
      }
    })
    .catch(() => {});
}

function scheduleWarm() {
  if (_warmScheduled) return;
  _warmScheduled = true;
  whenFree(() => warmDetail(!isMobile()));
}

const TAB_SUFFIX = {
  "tab-overview": "data",
  "tab-rh": "rh",
  "tab-wind": "wind",
  "tab-temp": "temp",
  "tab-rn1": "rn1",
  "tab-power": "power",
  [DATA_TAB]: DATA_SUFFIX,
};

function detailOpts(station, tabId) {
  const fc = state.fc;
  const hours = state.hours;
  const tab = tabId || state.activeTab;
  return {
    station: station,
    tab: tab,
    hours: hours,
    fc: fc,
    tabSuffix: TAB_SUFFIX[tab] || null,
    range: state.range,
    getChart: (suffix) => loadCharts(fc, hours, suffix),
    peekChart: (suffix) => peekCharts(fc, hours, suffix),
  };
}

const PREFETCH_DWELL_MS = 350;

let _prefetchTimer = 0;

function prefetchDetail(station, tabId) {
  if (!station || !state.fc) return;
  if (_prefetchTimer) clearTimeout(_prefetchTimer);
  const fc = state.fc;
  const hours = state.hours;
  _prefetchTimer = setTimeout(() => {
    _prefetchTimer = 0;
    whenFree(() => {
      if (state.fc !== fc || state.hours !== hours) return;
      warmDetail(true);
      detailModule()
        .then((m) => m.prefetch(detailOpts(station, tabId)))
        .catch(() => {});
    });
  }, PREFETCH_DWELL_MS);
}

function cancelPrefetch() {
  if (!_prefetchTimer) return;
  clearTimeout(_prefetchTimer);
  _prefetchTimer = 0;
}

function ensureDetailStyles() {
  if (document.getElementById("wx-detail-styles")) return;
  const st = document.createElement("style");
  st.id = "wx-detail-styles";
  st.textContent = [
    ".wx-detail-head{display:flex;align-items:center;gap:10px;margin-bottom:8px;}",
    ".wx-detail-head .t{flex:1 1 auto;min-width:0;font-size:13px;font-weight:600;",
    "letter-spacing:-.015em;overflow:hidden;text-overflow:ellipsis;",
    "white-space:nowrap;}",
    ".wx-detail-head button{flex:0 0 auto;font-size:12px;padding:4px 11px;}",
    ".wx-detail-body{min-height:0;}",
    ".wx-detail-controls{display:flex;flex-wrap:wrap;gap:10px;margin-bottom:4px;}",
    ".wx-detail-controls > .t{align-self:flex-end;flex:0 1 auto;min-width:0;",
    "max-width:260px;margin-right:6px;font-size:13px;font-weight:600;",
    "letter-spacing:-.015em;line-height:28px;overflow:hidden;",
    "text-overflow:ellipsis;white-space:nowrap;}",
    ".wx-detail-spacer{visibility:hidden;flex:0 0 0;width:0;min-width:0;",
    "overflow:hidden;}",
    ".al-loading.wx-detail-hold{padding:0;box-sizing:border-box;}",
    ".wx-detail-controls > .wx-detail-close{align-self:flex-end;flex:0 0 auto;",
    "margin-left:auto;font-size:12px;padding:4px 11px;min-height:28px;}",
    ".wx-detail-control{display:flex;flex-direction:column;gap:2px;min-width:150px;}",
    ".wx-detail-control label{font-size:9px;letter-spacing:.06em;}",
    ".wx-detail-select{font-family:inherit;font-size:12px;font-weight:500;",
    "color:var(--text,#26231f);background:var(--surface,#fff);",
    "border:1px solid var(--line,#e8e6e3);border-radius:7px;padding:4px 8px;",
    "min-height:28px;box-sizing:border-box;cursor:pointer;}",
    ".wx-detail-select:hover{border-color:#d9d6d1;}",
    ".wx-detail-msg{padding:40px 8px;font-size:13px;line-height:1.6;",
    "color:var(--text-muted,#8a857d);text-align:center;}",
    "@media (max-width:768px){.wx-detail-control{min-width:0;flex:1 1 100%;}",
    ".wx-detail-select{min-height:44px;font-size:16px;}",
    ".wx-detail-head button{min-height:40px;}}",
  ].join("");
  document.head.appendChild(st);
}

function wireGridAlertClicks(wrap) {
  const axisStations = wrap._wxAxisStations;
  if (!axisStations || !axisStations.size) return;
  const pd = wrap._wxGridPlot;
  if (!pd || typeof pd.on !== "function" || pd._wxAlertWired) return;
  pd._wxAlertWired = true;

  const stationAt = (ev) => {
    const pts = (ev && ev.points) || [];
    for (const pt of pts) {
      if (!pt || !pt.data || !isAlertTrace(pt.data)) continue;
      const name = axisStations.get(pt.data.xaxis || "x");
      if (name) return name;
    }
    return null;
  };

  pd.on("plotly_click", (ev) => {
    const name = stationAt(ev);
    if (name) openStationChart(wrap._wxPanel, name, state.activeTab);
  });
  pd.on("plotly_hover", (ev) => {
    const name = stationAt(ev);
    pd.style.cursor = name ? "pointer" : "";
    if (name) prefetchDetail(name, state.activeTab);
    else cancelPrefetch();
  });
  pd.on("plotly_unhover", () => {
    pd.style.cursor = "";
    cancelPrefetch();
  });
}

const ZOOM_DRAG_MIN_PX = 3;

function ensureGridZoomStyles() {
  if (document.getElementById("wx-gridzoom-styles")) return;
  const st = document.createElement("style");
  st.id = "wx-gridzoom-styles";
  st.textContent = [
    ".station-grid .js-plotly-plot.wx-zooming .zoombox{",
    "fill:rgba(38,35,31,.16)!important;}",
    ".station-grid .js-plotly-plot .zoombox-corners{fill:var(--surface,#fff)!important;",
    "stroke:var(--text,#26231f)!important;stroke-width:1.5!important;}",
  ].join("");
  document.head.appendChild(st);
}

function wireGridZoom(wrap) {
  const pd = wrap._wxGridPlot;
  if (!pd || pd._wxZoomWired) return;
  pd._wxZoomWired = true;
  ensureGridZoomStyles();

  let active = false;
  let x0 = 0;
  let y0 = 0;

  const onMove = (ev) => {
    if (active) return;
    if (
      Math.abs(ev.clientX - x0) < ZOOM_DRAG_MIN_PX &&
      Math.abs(ev.clientY - y0) < ZOOM_DRAG_MIN_PX
    ) {
      return;
    }
    active = true;
    pd.classList.add("wx-zooming");
  };

  const stop = () => {
    document.removeEventListener("mousemove", onMove, true);
    document.removeEventListener("mouseup", stop, true);
    window.removeEventListener("blur", stop);
    if (!active) return;
    active = false;
    pd.classList.remove("wx-zooming");
  };

  pd.addEventListener("mousedown", (ev) => {
    if (ev.button !== 0) return;
    active = false;
    x0 = ev.clientX;
    y0 = ev.clientY;
    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("mouseup", stop, true);
    window.addEventListener("blur", stop);
  }, true);
}

function ensureGridSpikeStyles() {
  if (document.getElementById("wx-gridspike-styles")) return;
  const st = document.createElement("style");
  st.id = "wx-gridspike-styles";
  st.textContent = [
    ".wx-graph{position:relative;}",
    ".wx-grid-spike{position:absolute;left:0;top:0;width:0;height:0;",
    "border-left:1px dotted #78716c;pointer-events:none;",
    "opacity:0;z-index:4;}",
    ".wx-grid-spike.on{opacity:.9;}",
  ].join("");
  document.head.appendChild(st);
}

function fullXAxis(fl, id) {
  const key = !id || id === "x" ? "xaxis" : "xaxis" + id.slice(1);
  return fl[key] || null;
}

function anchoredYAxis(fl, xa) {
  const anchor =
    typeof xa.anchor === "string" && xa.anchor.charAt(0) === "y" ? xa.anchor : "y";
  return fl[anchor === "y" ? "yaxis" : "yaxis" + anchor.slice(1)] || null;
}

function axisValue(xa, v) {
  if (!xa) return null;
  try {
    const c = typeof xa.d2c === "function" ? xa.d2c(v) : Number(v);
    return isFinite(c) ? c : null;
  } catch (e) {
    return null;
  }
}

function hoverAxis(pd, pt) {
  const fl = pd && pd._fullLayout;
  if (!fl || !pt) return null;
  if (pt.xaxis && typeof pt.xaxis._offset === "number") return pt.xaxis;
  return fullXAxis(fl, (pt.data && pt.data.xaxis) || "x");
}

function gridSpikeVertical(pd, xa) {
  const fl = pd && pd._fullLayout;
  if (!fl || !xa || typeof xa._offset !== "number") return null;

  const group = xa.matches || xa._id;
  let top = Infinity;
  let bottom = -Infinity;

  for (const key of Object.keys(fl)) {
    if (!/^xaxis\d*$/.test(key)) continue;
    const ax = fl[key];
    if (!ax || ax.visible === false) continue;
    if ((ax.matches || ax._id) !== group) continue;
    const ya = anchoredYAxis(fl, ax);
    if (!ya || typeof ya._offset !== "number" || !ya._length) continue;
    top = Math.min(top, ya._offset);
    bottom = Math.max(bottom, ya._offset + ya._length);
  }

  if (!(bottom > top)) {
    const ya = anchoredYAxis(fl, xa);
    if (!ya || typeof ya._offset !== "number" || !ya._length) return null;
    top = ya._offset;
    bottom = ya._offset + ya._length;
  }

  return { top: top, height: bottom - top };
}

const HOVER_ECHO_MS = 120;

const HOVER_HOLD_MS = 160;

let _hoverEchoTarget = null;
let _hoverEchoAt = 0;

function hoverEcho(gd) {
  return _hoverEchoTarget === gd && Date.now() - _hoverEchoAt < HOVER_ECHO_MS;
}

function pushHover(gd, xval, subplot) {
  if (!gd || !window.Plotly || !Plotly.Fx || typeof Plotly.Fx.hover !== "function") {
    return;
  }
  _hoverEchoTarget = gd;
  _hoverEchoAt = Date.now();
  try {
    Plotly.Fx.hover(gd, { xval: xval }, subplot, true);
  } catch (e) {
    void e;
  }
}

function dropHover(gd) {
  if (!gd || !window.Plotly || !Plotly.Fx || typeof Plotly.Fx.unhover !== "function") {
    return;
  }
  _hoverEchoTarget = gd;
  _hoverEchoAt = Date.now();
  try {
    Plotly.Fx.unhover(gd);
  } catch (e) {
    void e;
  }
}

function panelPlot(panel) {
  if (!panel || panel.style.display === "none") return null;
  const pd = panel.querySelector(".wx-detail-plot");
  return pd && pd._fullLayout && typeof pd.on === "function" ? pd : null;
}

function gridAxisForStation(wrap, station) {
  const map = wrap && wrap._wxAxisStations;
  if (!map || !station) return null;
  for (const [id, name] of map) {
    if (name === station) return id;
  }
  return null;
}

function gridTopAxis(pd) {
  const fl = pd && pd._fullLayout;
  if (!fl) return null;
  let best = null;
  let top = Infinity;
  for (const key of Object.keys(fl)) {
    if (!/^xaxis\d*$/.test(key)) continue;
    const xa = fl[key];
    if (!xa || xa.visible === false || typeof xa._offset !== "number") continue;
    const ya = anchoredYAxis(fl, xa);
    if (!ya || typeof ya._offset !== "number") continue;
    if (ya._offset < top) {
      top = ya._offset;
      best = xa;
    }
  }
  return best;
}

function gridHoverAt(wrap, station, xval) {
  const pd = wrap && wrap._wxGridPlot;
  const fl = pd && pd._fullLayout;
  if (!fl) return;
  const id = gridAxisForStation(wrap, station);
  let xa = id ? fullXAxis(fl, id) : null;
  if (!xa || xa.visible === false || typeof xa._offset !== "number") {
    xa = gridTopAxis(pd);
  }
  if (!xa) return;
  if (typeof wrap._wxSpikeAt === "function") wrap._wxSpikeAt(xa, xval);
  if (wrap._wxOverlay) return;
  const ya = anchoredYAxis(fl, xa);
  if (ya && ya._id) pushHover(pd, xval, xa._id + ya._id);
}

function gridHoverOff(wrap) {
  if (typeof wrap._wxSpikeOff === "function") wrap._wxSpikeOff();
  if (wrap && wrap._wxGridPlot) dropHover(wrap._wxGridPlot);
}

function wirePanelHover(panel) {
  const wrap = panel && panel._wxGrid;
  const dpd = panelPlot(panel);
  if (!wrap || !dpd || dpd._wxLinkWired) return;
  dpd._wxLinkWired = true;

  let timer = 0;
  const cancel = () => {
    if (timer) {
      clearTimeout(timer);
      timer = 0;
    }
  };

  const mapTime = (xval) => {
    if (hoverEcho(dpd)) return;
    if (typeof wrap._wxMapTime === "function") wrap._wxMapTime(xval, panel._wxStation);
  };

  dpd.on("plotly_hover", (ev) => {
    cancel();
    const pt = ev && ev.points && ev.points[0];
    const xval = pt ? axisValue(hoverAxis(dpd, pt), pt.x) : null;
    if (xval !== null) mapTime(xval);
    if (!wrap._wxStacked || hoverEcho(dpd)) return;
    if (xval === null) return;
    gridHoverAt(wrap, panel._wxStation, xval);
  });
  dpd.on("plotly_unhover", () => {
    cancel();
    mapTime(null);
    if (!wrap._wxStacked || hoverEcho(dpd)) return;
    timer = setTimeout(() => {
      timer = 0;
      gridHoverOff(wrap);
    }, HOVER_HOLD_MS);
  });

  wirePanelRangeSync(panel, dpd);
}

const RANGE_ECHO_MS = 250;

const RANGE_SYNC_MS = 80;

const RANGE_KEY_RE = /^xaxis\d*\.(range|autorange)/;

let _rangeEchoTarget = null;
let _rangeEchoAt = 0;

function rangeEcho(gd) {
  return _rangeEchoTarget === gd && Date.now() - _rangeEchoAt < RANGE_ECHO_MS;
}

function isRangeEvent(e) {
  if (!e) return false;
  for (const key of Object.keys(e)) {
    if (RANGE_KEY_RE.test(key)) return true;
  }
  return false;
}

function anchorXAxisKey(fl) {
  if (!fl) return null;
  for (const key of Object.keys(fl)) {
    if (!/^xaxis\d*$/.test(key)) continue;
    const xa = fl[key];
    if (!xa || xa.visible === false || typeof xa._offset !== "number") continue;
    if (!xa.matches) return key;
  }
  return null;
}

function axisRange(fl, key) {
  const xa = fl && fl[key];
  const r = xa && xa.range;
  return Array.isArray(r) && r.length === 2 ? [r[0], r[1]] : null;
}

function rangeValue(xa, v) {
  try {
    const n = typeof xa.r2l === "function" ? xa.r2l(v) : Number(v);
    return isFinite(n) ? n : NaN;
  } catch (e) {
    return NaN;
  }
}

function rangeMatches(xa, a, b) {
  if (!xa || !a || !b) return false;
  const a0 = rangeValue(xa, a[0]);
  const a1 = rangeValue(xa, a[1]);
  const b0 = rangeValue(xa, b[0]);
  const b1 = rangeValue(xa, b[1]);
  if (!isFinite(a0) || !isFinite(a1) || !isFinite(b0) || !isFinite(b1)) return false;
  const span = Math.abs(a1 - a0) || 1;
  const tol = span * 1e-4;
  return Math.abs(a0 - b0) < tol && Math.abs(a1 - b1) < tol;
}

function eventRange(e, key) {
  if (!e) return null;
  const whole = e[key + ".range"];
  if (Array.isArray(whole) && whole.length === 2) return [whole[0], whole[1]];
  const lo = e[key + ".range[0]"];
  const hi = e[key + ".range[1]"];
  if (lo !== undefined && hi !== undefined) return [lo, hi];
  for (const k of Object.keys(e)) {
    const m = /^(xaxis\d*)\.range\[0\]$/.exec(k);
    if (!m) continue;
    const top = e[m[1] + ".range[1]"];
    if (top !== undefined) return [e[k], top];
  }
  for (const k of Object.keys(e)) {
    if (!/^xaxis\d*\.range$/.test(k)) continue;
    const v = e[k];
    if (Array.isArray(v) && v.length === 2) return [v[0], v[1]];
  }
  return null;
}

function pushRange(gd, key, range, done) {
  const finish = () => {
    if (typeof done === "function") done();
  };
  if (!gd || !range || !window.Plotly || typeof Plotly.relayout !== "function") {
    finish();
    return;
  }
  _rangeEchoTarget = gd;
  _rangeEchoAt = Date.now();
  const patch = {};
  patch[key + ".autorange"] = false;
  patch[key + ".range"] = [range[0], range[1]];
  try {
    const p = Plotly.relayout(gd, patch);
    if (p && typeof p.then === "function") {
      p.then(
        () => {
          if (_rangeEchoTarget === gd) _rangeEchoAt = Date.now();
          finish();
        },
        finish
      );
    } else {
      finish();
    }
  } catch (e) {
    void e;
    finish();
  }
}

function wireRangeSync(gd, srcKeyOf, dstOf) {
  if (!gd || typeof gd.on !== "function") return;
  let queued = null;
  let busy = false;
  let timer = 0;

  const flush = () => {
    if (busy || !queued) return;
    const range = queued;
    queued = null;
    const dst = dstOf();
    if (!dst) return;
    const cur = axisRange(dst.gd._fullLayout, dst.key);
    if (rangeMatches(dst.gd._fullLayout[dst.key], range, cur)) return;
    busy = true;
    pushRange(dst.gd, dst.key, range, () => {
      busy = false;
      flush();
    });
  };

  const queue = (range) => {
    if (!range) return;
    queued = range;
    flush();
  };

  gd.on("plotly_relayouting", (e) => {
    if (rangeEcho(gd)) return;
    const key = srcKeyOf();
    if (!key) return;
    queue(eventRange(e, key));
  });

  gd.on("plotly_relayout", (e) => {
    if (rangeEcho(gd) || !isRangeEvent(e)) return;
    const key = srcKeyOf();
    if (!key) return;
    queue(axisRange(gd._fullLayout, key) || eventRange(e, key));
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = 0;
      const settled = srcKeyOf();
      if (settled) queue(axisRange(gd._fullLayout, settled));
    }, RANGE_SYNC_MS);
  });
}

function wireGridRangeSync(wrap) {
  const pd = wrap._wxGridPlot;
  if (!pd || typeof pd.on !== "function" || pd._wxRangeWired) return;
  pd._wxRangeWired = true;
  wireRangeSync(
    pd,
    () => (wrap._wxStacked ? anchorXAxisKey(pd._fullLayout) : null),
    () => {
      if (!wrap._wxStacked) return null;
      const dpd = panelPlot(wrap._wxPanel);
      return dpd ? { gd: dpd, key: "xaxis" } : null;
    }
  );
}

const Y_RANGE_KEY_RE = /^yaxis\d*\.range/;

function wireGridFit(wrap) {
  const pd = wrap._wxGridPlot;
  if (!pd || typeof pd.on !== "function" || pd._wxFitWired) return;
  pd._wxFitWired = true;
  pd.on("plotly_relayout", (e) => {
    if (!wrap._wxStacked || !isRangeEvent(e)) return;
    for (const key of Object.keys(e)) {
      if (Y_RANGE_KEY_RE.test(key)) return;
    }
    if (typeof wrap._wxRefit === "function") wrap._wxRefit();
  });
}

function wirePanelRangeSync(panel, dpd) {
  const wrap = panel && panel._wxGrid;
  if (!wrap || !dpd) return;
  wireRangeSync(
    dpd,
    () => (wrap._wxStacked ? "xaxis" : null),
    () => {
      const pd = wrap._wxStacked ? wrap._wxGridPlot : null;
      const key = pd ? anchorXAxisKey(pd._fullLayout) : null;
      return key ? { gd: pd, key: key } : null;
    }
  );
}

function wireGridMapTime(wrap) {
  const pd = wrap._wxGridPlot;
  if (!pd || typeof pd.on !== "function" || pd._wxMapTimeWired) return;
  pd._wxMapTimeWired = true;
  const send = (xval, station) => {
    if (hoverEcho(pd)) return;
    if (typeof wrap._wxMapTime === "function") wrap._wxMapTime(xval, station);
  };
  const nearest = (ev, pts) => {
    const e = ev && ev.event;
    const box = pd.getBoundingClientRect();
    if (!e || typeof e.clientY !== "number") return pts.length === 1 ? pts[0] : null;
    const my = e.clientY - box.top;
    let best = null;
    let gap = Infinity;
    for (const p of pts) {
      const ya = p.yaxis;
      const y = Number(p.y);
      if (!ya || typeof ya.l2p !== "function" || !Number.isFinite(y)) continue;
      const d = Math.abs(ya.l2p(y) + ya._offset - my);
      if (d < gap) {
        gap = d;
        best = p;
      }
    }
    return best;
  };
  const stationOf = (ev) => {
    const pts = ((ev && ev.points) || []).filter((p) => p && p.data && !isAlertTrace(p.data));
    if (!pts.length) return null;
    if (wrap._wxOverlay) {
      const pt = nearest(ev, pts);
      return pt && typeof pt.data.name === "string" ? pt.data.name : null;
    }
    const pt = pts[0];
    const axes = wrap._wxAxisStations;
    return (axes && axes.get(pt.data.xaxis || "x")) || gridTraceStation(pt.data) || null;
  };
  pd.on("plotly_hover", (ev) => {
    const pt = ev && ev.points && ev.points[0];
    const xval = pt ? axisValue(hoverAxis(pd, pt), pt.x) : null;
    if (xval !== null) send(xval, stationOf(ev));
  });
  pd.on("plotly_unhover", () => send(null));
  pd.addEventListener("mouseleave", () => send(null));
}

function wireGridSpike(wrap) {
  const pd = wrap._wxGridPlot;
  const host = wrap._wxGraphWrap;
  if (!pd || !host || typeof pd.on !== "function" || pd._wxSpikeWired) return;
  pd._wxSpikeWired = true;

  ensureGridSpikeStyles();
  const line = el("div", "wx-grid-spike");
  host.appendChild(line);

  let timer = 0;
  let raf = 0;
  let pending = null;
  let offsets = null;
  const spans = new Map();

  const cancel = () => {
    if (timer) {
      clearTimeout(timer);
      timer = 0;
    }
  };

  const invalidate = () => {
    offsets = null;
    spans.clear();
  };

  const originOf = () => {
    if (offsets) return offsets;
    const base = pd.getBoundingClientRect();
    const box = host.getBoundingClientRect();
    offsets = { x: base.left - box.left, y: base.top - box.top };
    return offsets;
  };

  const spanOf = (xa) => {
    const key = (xa && xa._id) || "x";
    if (spans.has(key)) return spans.get(key);
    const span = gridSpikeVertical(pd, xa);
    spans.set(key, span);
    return span;
  };

  const hide = () => {
    cancel();
    pending = null;
    if (raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
    line.className = "wx-grid-spike";
  };

  const paint = () => {
    raf = 0;
    const job = pending;
    pending = null;
    if (!job) return;
    const span = spanOf(job.xa);
    let px = NaN;
    try {
      px = job.xa.c2p(job.xval);
    } catch (e) {
      void e;
    }
    if (!span || !isFinite(px)) {
      line.className = "wx-grid-spike";
      return;
    }
    const origin = originOf();
    line.style.left = Math.round(origin.x + job.xa._offset + px) + "px";
    line.style.top = Math.round(origin.y + span.top) + "px";
    line.style.height = Math.round(span.height) + "px";
    line.className = "wx-grid-spike on";
  };

  const place = (xa, xval) => {
    if (!xa || typeof xa._offset !== "number") {
      hide();
      return false;
    }
    pending = { xa: xa, xval: xval };
    if (!raf) raf = requestAnimationFrame(paint);
    return true;
  };

  pd._wxSpikeAt = place;
  pd._wxSpikeOff = hide;
  wrap._wxSpikeAt = place;
  wrap._wxSpikeOff = hide;

  pd.on("plotly_hover", (ev) => {
    cancel();
    const pt = ev && ev.points && ev.points[0];
    const xa = hoverAxis(pd, pt);
    const xval = pt ? axisValue(xa, pt.x) : null;
    if (!xa || xval === null) {
      hide();
      return;
    }
    place(xa, xval);
    if (!wrap._wxStacked || hoverEcho(pd)) return;
    const dpd = panelPlot(wrap._wxPanel);
    if (dpd) pushHover(dpd, xval, "xy");
  });
  pd.on("plotly_unhover", () => {
    cancel();
    const echo = hoverEcho(pd);
    const linked = wrap._wxStacked && !echo;
    timer = setTimeout(() => {
      timer = 0;
      line.className = "wx-grid-spike";
      if (!linked) return;
      const dpd = panelPlot(wrap._wxPanel);
      if (dpd) dropHover(dpd);
    }, HOVER_HOLD_MS);
  });
  pd.on("plotly_relayout", () => {
    invalidate();
    hide();
  });
  pd.on("plotly_afterplot", invalidate);
  pd.addEventListener("mouseleave", hide);
}

function captureStationAnnotations(fig, names) {
  const anns = (fig && fig.layout && fig.layout.annotations) || [];
  if (!anns.length || !names || !names.length) return;
  const known = new Set(names);
  for (const a of anns) {
    if (!a || typeof a.text !== "string") continue;
    if (!known.has(a.text.replace(/<[^>]*>/g, "").trim())) continue;
    a.captureevents = true;
  }
}

function annotationStation(ev, known) {
  const a = ev && ev.annotation;
  if (!a || typeof a.text !== "string") return null;
  const name = a.text.replace(/<[^>]*>/g, "").trim();
  return known.has(name) ? name : null;
}

function markStationCursors(pd, known) {
  if (!pd || !pd.querySelectorAll) return false;
  const nodes = pd.querySelectorAll(".annotation text");
  if (!nodes.length) return false;
  for (const n of nodes) {
    const name = (n.textContent || "").trim();
    if (!known.has(name)) continue;
    n.style.cursor = "pointer";
    const host = (n.closest && n.closest(".annotation")) || n;
    if (host._wxHoverWired) continue;
    host._wxHoverWired = true;
    host.style.cursor = "pointer";
    host.addEventListener("mouseenter", () => {
      n.style.textDecoration = "underline";
      prefetchDetail(name, state.activeTab);
    });
    host.addEventListener("mouseleave", () => {
      n.style.textDecoration = "";
      cancelPrefetch();
    });
  }
  return true;
}

function wireGridStationClicks(wrap, g) {
  const known = new Set(wrap._wxStations || []);

  const run = () => {
    const pd = wrap._wxGridPlot;
    if (!pd || typeof pd.on !== "function") return;
    if (!pd._wxGridWired) {
      pd._wxGridWired = true;
      if (known.size) {
        pd.on("plotly_clickannotation", (ev) => {
          const name = annotationStation(ev, known);
          if (name) openStationChart(wrap._wxPanel, name, state.activeTab);
        });
        pd.on("plotly_hoverannotation", (ev) => {
          const name = annotationStation(ev, known);
          if (name) prefetchDetail(name, state.activeTab);
        });
        pd.on("plotly_afterplot", () => markStationCursors(pd, known));
        markStationCursors(pd, known);
      }
    }
    wireGridAlertClicks(wrap);
    wireGridSpike(wrap);
    wireGridMapTime(wrap);
    wireBandGlyphs(wrap);
    wireGridRangeSync(wrap);
    wireGridFit(wrap);
    wireGridZoom(wrap);
  };

  wrap._wxRewire = run;
  if (g && typeof g._wxOnDrawn === "function") g._wxOnDrawn(run);
}

const TABS = [
  { id: OVERVIEW_TAB, label: "Overview", build: buildOverview },
  { id: "tab-rh",    label: "RH",    build: buildRh },
  { id: "tab-wind",  label: "Wind",  build: buildWind },
  { id: "tab-temp",  label: "Temp",  build: buildTemp },
  { id: "tab-rn1",   label: "Precip", build: buildRn1 },
  { id: "tab-power", label: "Power", build: buildPower },
  { id: DATA_TAB,    label: "Data",  build: buildData },
];

const state = { fc: null, hours: 72, activeTab: OVERVIEW_TAB, range: null };

const $main = document.getElementById("al-main-content");
const $footer = document.getElementById("al-timing-diag");
const $fcSelect = document.getElementById("al-fc-select");
const $rangeSelect = document.getElementById("al-range-select");
const $connError = document.getElementById("conn-error");

function showConnError(e) {
  if (!$connError) return;
  $connError.textContent =
    "Could not load the fire centre list from " + CONFIG_BASE +
    " (" + ((e && e.message) || e) + ").";
  $connError.style.display = "block";
}

function clearConnError() {
  if (!$connError) return;
  $connError.textContent = "";
  $connError.style.display = "none";
}

const _resizeHooks = new Set();

let _resizeTimer = 0;

function keepRowVisible() {
  const root = activePane();
  const panel = root && root.querySelector(".wx-ov-chart");
  if (panel && panel._wxRow && panel._wxRow.isConnected) {
    revealRow(panel._wxRow);
  }
}

let _resizeDirty = false;

function runResizeHooks() {
  const active = activePane();
  _resizeDirty = false;
  for (const hook of Array.from(_resizeHooks)) {
    if (!hook.node.isConnected) {
      _resizeHooks.delete(hook);
      continue;
    }
    const pane = hook.node.closest ? hook.node.closest(".tab-pane") : null;
    if (pane && pane !== active) {
      _resizeDirty = true;
      continue;
    }
    if (!mountNear(hook.node)) {
      _resizeDirty = true;
      continue;
    }
    try {
      hook.run();
    } catch (e) {
      void e;
    }
  }
}

function catchUpResize() {
  if (!_resizeDirty) return;
  runResizeHooks();
}

function watchResize(node, run) {
  _resizeHooks.add({ node: node, run: run });
}

window.addEventListener("resize", () => {
  if (_resizeTimer) clearTimeout(_resizeTimer);
  _resizeTimer = setTimeout(() => {
    _resizeTimer = 0;
    runResizeHooks();
    sizeOverviewShell();
    keepRowVisible();
  }, 140);
});

function resizePlots(node) {
  if (!node || !node.querySelectorAll) return;
  for (const pd of node.querySelectorAll(".wx-plot")) {
    if (!pd._wxDrawn || !pd._fullLayout) continue;
    if (pd._wxSettlePending) settlePlot(pd);
    if (!syncSize(pd)) continue;
    pd._wxWidth = pd.clientWidth;
    fitPlot(pd);
  }
}

function captureOpenDetail() {
  const root = activePane();
  const panel = root && root.querySelector(".wx-ov-chart");
  if (!panel || panel.style.display === "none" || !panel._wxStation) return null;
  return {
    station: panel._wxStation,
    tab: panel._wxTab || null,
    pick: panel._wxPick || null,
  };
}

function restoreOpenDetail(saved, pane) {
  if (!saved || !saved.station) return;
  const root = pane || activePane();
  const panel = root && root.querySelector(".wx-ov-chart");
  if (!panel) return;
  let row = null;
  for (const r of root.querySelectorAll(".wx-ov-row")) {
    if (r._wxStation !== saved.station) continue;
    if (!row) row = r;
    if (saved.tab && r._wxFinding && r._wxFinding.tab === saved.tab) {
      row = r;
      break;
    }
  }
  const f = row && row._wxFinding
    ? row._wxFinding
    : { station: saved.station, tab: saved.tab };
  openOverviewChart(panel, f, row, saved.pick || null, saved.view || null, true);
}

let _pendingDetail = null;

function activeGrid(pane) {
  const root = pane || activePane();
  if (!root) return null;
  for (const g of root.querySelectorAll(".station-grid")) {
    if (typeof g._wxGridState === "function") return g;
  }
  return null;
}

function captureGridState(withNeighbours) {
  const grid = activeGrid();
  return grid ? grid._wxGridState(withNeighbours) : null;
}

function preReserveRail(grid) {
  const nb = grid && grid._wxNbMap;
  const slot = nb && nb.slot;
  const row = slot && slot.parentNode;
  if (!slot || !row || !row.classList || !row.classList.contains("wx-nb-stack")) return;
  if (isMobile() || slot.firstChild || row.classList.contains("has-map")) return;
  const w = sharedNeighbourMap().railWidth();
  if (!w) return;
  slot.style.width = w + "px";
  slot._wxReserved = true;
  row.classList.add("has-map");
  row._wxRail = String(w - 2);
}

function restoreCarried(saved, gridState, pane) {
  const opening = !!(saved && saved.station);
  const grid = activeGrid(pane);
  if (opening) preReserveRail(grid);
  const linked = !!(opening && grid && typeof grid._wxAwaitDetail === "function");
  if (linked) grid._wxAwaitDetail(true);
  if (opening) restoreOpenDetail(saved, pane);
  if (gridState) restoreGridState(gridState, pane);
  if (linked && typeof grid._wxNeighbourSync === "function") grid._wxNeighbourSync();
}

function restoreGridState(saved, pane) {
  if (!saved) return;
  const grid = activeGrid(pane);
  if (grid && typeof grid._wxGridRestore === "function") grid._wxGridRestore(saved);
}

const TAB_PREFETCH_DELAY_MS = 150;

let _tabWarmToken = 0;

let _revealToken = 0;

let $panes = null;

const tabPanes = new Map();

function activePane() {
  return $panes ? $panes.querySelector(".tab-pane.active") : null;
}

function tabShell() {
  if ($panes && $panes.isConnected) return $panes;
  $main.innerHTML = "";
  tabPanes.clear();

  const bar = el("div", "al-tabs");
  bar.addEventListener(
    "pointermove",
    (ev) => {
      if (ev.pointerType && ev.pointerType !== "mouse") return;
      holdPrebuild(TAB_INTENT_HOLD_MS);
    },
    { passive: true }
  );
  for (const t of TABS) {
    const btn = el("div", "al-tab", t.label);
    btn.dataset.tab = t.id;
    let pressed = false;
    btn.addEventListener("pointerdown", (ev) => {
      pressed = ev.pointerType === "mouse" && ev.button === 0;
      if (!pressed) return;
      cancelPrefetch();
      renderTab(t.id);
    });
    btn.addEventListener("click", () => {
      if (pressed) {
        pressed = false;
        return;
      }
      cancelPrefetch();
      renderTab(t.id);
    });
    let hoverTimer = 0;
    btn.addEventListener("pointerenter", (ev) => {
      if (ev.pointerType && ev.pointerType !== "mouse") return;
      if (t.id === state.activeTab) return;
      if (hoverTimer) clearTimeout(hoverTimer);
      hoverTimer = setTimeout(() => {
        hoverTimer = 0;
        prebuildHovered(t.id);
      }, PREBUILD_HOVER_MS);
      if (!CARRY_TABS.has(t.id)) return;
      warmCarryFiles(t.id);
      const station = carriedStation();
      if (station) prefetchDetail(station, t.id);
    });
    btn.addEventListener("pointerleave", () => {
      if (hoverTimer) {
        clearTimeout(hoverTimer);
        hoverTimer = 0;
      }
      cancelPrefetch();
    });
    bar.appendChild(btn);
  }
  $main.appendChild(bar);

  $panes = el("div", "tab-panes");
  $main.appendChild($panes);
  return $panes;
}

function resetTabs() {
  _prebuildToken++;
  _prebuildDone.clear();
  tabPanes.clear();
  if (_sharedNeighbourMap) _sharedNeighbourMap.park();
  if ($panes) $panes.innerHTML = "";
  for (let i = _mountQueue.length - 1; i >= 0; i--) {
    if (!_mountQueue[i].node.isConnected) _mountQueue.splice(i, 1);
  }
}

function paneFor(tab) {
  let entry = tabPanes.get(tab.id);
  if (entry && entry.pane.isConnected) return entry;
  const host = tabShell();
  const pane = el("div", "tab-content tab-pane");
  pane.dataset.tab = tab.id;
  const loading = el("div", "al-loading");
  loading.appendChild(el("div", "spinner"));
  loading.appendChild(el("span", null, "Loading\u2026"));
  pane.appendChild(loading);
  host.appendChild(pane);
  entry = { pane: pane, ready: false, job: null };
  tabPanes.set(tab.id, entry);
  return entry;
}

function fillPane(tab) {
  const entry = paneFor(tab);
  if (entry.ready) return Promise.resolve(entry);
  if (entry.job) return entry.job;

  const fc = state.fc;
  const hours = state.hours;
  entry.job = afterPaint()
    .then(() => {
      if (state.fc !== fc || state.hours !== hours) return null;
      return tab.build(fc, hours);
    })
    .then((content) => {
      entry.job = null;
      if (!content) return entry;
      if (!entry.pane.isConnected) return entry;
      if (state.fc !== fc || state.hours !== hours) return entry;
      entry.pane.innerHTML = "";
      entry.pane.appendChild(content);
      entry.ready = true;
      const live = entry.pane.classList.contains("active");
      const pending = _pendingDetail;
      if (
        live &&
        pending &&
        pending.fc === fc &&
        pending.hours === hours &&
        pending.tab === tab.id
      ) {
        _pendingDetail = null;
        try {
          sizeOverviewShell();
          restoreCarried(pending.saved, pending.grid, entry.pane);
        } catch (e) {
          console.warn("detail restore failed", e);
        }
      }
      if (live) requestAnimationFrame(sizeOverviewShell);
      return entry;
    })
    .catch((e) => {
      entry.job = null;
      console.warn("tab build failed", tab.id, e);
      entry.pane.innerHTML = "";
      entry.pane.appendChild(unavailable());
      entry.ready = true;
      return entry;
    });
  return entry.job;
}

function tabPayloadFiles(fc, hours, tab) {
  const suffix = TAB_SUFFIX[tab.id];
  if (!suffix || tab.id === OVERVIEW_TAB) return [];
  return [
    chartFile(fc, hours, suffix),
    textFile(fc, hours, `insights_${suffix}`),
    chartFile(fc, hours, `insights_${suffix}`),
  ];
}

function prefetchTabPayloads(fc, hours, tabs) {
  for (const tab of tabs) {
    for (const file of tabPayloadFiles(fc, hours, tab)) warmFile(file);
  }
}

const PREBUILD_TABS = ["tab-rh", "tab-wind", "tab-temp", "tab-rn1", "tab-power"];

const PREBUILD_HOVER_MS = 120;

let _prebuildToken = 0;

let _prebuildRunning = false;

let _prebuildFront = null;

const _prebuildDone = new Set();

function prebuildable(tabId) {
  return (
    !isMobile() &&
    !!state.fc &&
    PREBUILD_TABS.indexOf(tabId) >= 0 &&
    tabId !== state.activeTab &&
    !_prebuildDone.has(tabId)
  );
}

function prebuildTab(tab, eager) {
  const fc = state.fc;
  const hours = state.hours;
  const token = _prebuildToken;
  _prebuildDone.add(tab.id);
  const stale = () =>
    token !== _prebuildToken || state.fc !== fc || state.hours !== hours;
  return fillPane(tab).then((entry) => {
    if (stale() || !entry || !entry.ready || !entry.pane.isConnected) return;
    const draw = () => {
      if (stale() || !entry.pane.isConnected) return;
      const grid = activeGrid(entry.pane);
      if (grid) mountWithin(grid);
    };
    if (eager) {
      draw();
      return;
    }
    return new Promise((resolve) => {
      whenFree(() => {
        draw();
        resolve();
      });
    });
  });
}

function nextPrebuild() {
  if (_prebuildFront && prebuildable(_prebuildFront)) {
    return TABS.find((t) => t.id === _prebuildFront) || null;
  }
  for (const id of PREBUILD_TABS) {
    if (prebuildable(id)) return TABS.find((t) => t.id === id) || null;
  }
  return null;
}

function prebuildPanes() {
  if (_prebuildRunning || isMobile() || !state.fc) return;
  const token = _prebuildToken;
  _prebuildRunning = true;
  const step = () => {
    if (token !== _prebuildToken) {
      _prebuildRunning = false;
      prebuildPanes();
      return;
    }
    const tab = nextPrebuild();
    if (!tab) {
      _prebuildRunning = false;
      return;
    }
    whenFree(() => {
      if (token !== _prebuildToken || !prebuildable(tab.id)) {
        step();
        return;
      }
      prebuildTab(tab, false).then(step, step);
    });
  };
  step();
}

function prebuildHovered(tabId) {
  if (isMobile() || !state.fc || tabId === state.activeTab) return;
  if (PREBUILD_TABS.indexOf(tabId) < 0) return;
  _prebuildFront = tabId;
  prebuildPanes();
}

function warmTabPayloads() {
  const fc = state.fc;
  const hours = state.hours;
  if (!fc) return;
  const token = ++_tabWarmToken;
  const queue = TABS.filter(
    (t) => t.id !== OVERVIEW_TAB && t.id !== state.activeTab
  );
  if (!queue.length) return;
  setTimeout(() => {
    if (token !== _tabWarmToken || state.fc !== fc || state.hours !== hours) return;
    prefetchTabPayloads(fc, hours, queue);
  }, TAB_PREFETCH_DELAY_MS);
}

function markTabButtons(tabId) {
  for (const btn of $main.querySelectorAll(".al-tab")) {
    btn.classList.toggle("active", btn.dataset.tab === tabId);
  }
}

function showPane(host, entry) {
  for (const pane of host.children) {
    if (!pane.classList.contains("tab-pane")) continue;
    pane.classList.toggle("active", pane === entry.pane);
  }
}

function parkPlots(pane) {
  const out = [];
  for (const pd of pane.querySelectorAll(".wx-plot")) {
    if (!pd._wxDrawn) continue;
    pd.style.contentVisibility = "hidden";
    out.push(pd);
  }
  return out;
}

function viewportGap(node) {
  const r = node.getBoundingClientRect();
  const h = window.innerHeight || 0;
  if (r.bottom < 0) return -r.bottom;
  if (r.top > h) return r.top - h;
  return 0;
}

function unparkPlots(pane, plots) {
  const token = (pane._wxParkToken || 0) + 1;
  pane._wxParkToken = token;
  if (!plots.length) return;
  let queue = null;
  const step = () => {
    if (pane._wxParkToken !== token) return;
    if (!pane.isConnected || !pane.classList.contains("active")) {
      for (const pd of queue || plots) pd.style.contentVisibility = "";
      return;
    }
    if (!queue) {
      queue = plots
        .map((pd, i) => ({ pd: pd, i: i, gap: viewportGap(pd) }))
        .sort((a, b) => a.gap - b.gap || a.i - b.i)
        .map((item) => item.pd);
    }
    const pd = queue.shift();
    if (pd) pd.style.contentVisibility = "";
    if (queue.length) requestAnimationFrame(step);
  };
  if (pane.classList.contains("active")) {
    const ranked = plots
      .map((pd, i) => ({ pd: pd, i: i, gap: viewportGap(pd) }))
      .sort((a, b) => a.gap - b.gap || a.i - b.i);
    queue = [];
    for (const item of ranked) {
      if (item.gap <= 0) item.pd.style.contentVisibility = "";
      else queue.push(item.pd);
    }
    if (!queue.length) return;
  }
  requestAnimationFrame(step);
}

function revealPane(host, entry, frames, built, staged) {
  const token = ++_revealToken;
  return new Promise((resolve) => {
    const apply = () => {
      if (token !== _revealToken) {
        resolve(false);
        return;
      }
      const parked = staged ? parkPlots(entry.pane) : null;
      showPane(host, entry);
      if (parked) unparkPlots(entry.pane, parked);
      resolve(true);
    };
    if (built) {
      let shown = false;
      const once = () => {
        if (shown) return;
        shown = true;
        apply();
        if (token === _revealToken) sizeOverviewShell();
      };
      built.then(once, once);
      afterPaint().then(() => nextTask(once));
      return;
    }
    if (frames <= 0) {
      apply();
      return;
    }
    const step = (left) => {
      requestAnimationFrame(() => {
        if (token !== _revealToken) {
          resolve(false);
          return;
        }
        if (left > 1) step(left - 1);
        else apply();
      });
    };
    step(frames);
  });
}

const GRID_DETAIL_WAIT_MS = 15000;

const FOREIGN_WAIT_MS = 4000;

const GRID_VEIL_DELAY_MS = 150;

const SEL_RESIZE_SETTLE_MS = 100;

const NEIGHBOUR_RESET_LABEL = "Reset to neighbours";

const GRID_STACK_ROW_RATIO = 1 / 12;

const GRID_STACK_ROW_MAX = 150;

const GRID_STACK_VIEW_SHARE = 0.5;

const CARRY_TABS = new Set([
  "tab-rh", "tab-wind", "tab-temp", "tab-rn1", "tab-power",
]);

function captureTabCarry(pane, fromId, tabId) {
  if (!CARRY_TABS.has(fromId) || !CARRY_TABS.has(tabId)) return null;
  const panel = pane.querySelector(".wx-ov-chart");
  const open =
    panel && panel.style.display !== "none" && panel._wxStation ? panel._wxStation : null;
  const grid = activeGrid(pane);
  const gridState = grid ? grid._wxGridState(!!open) : null;
  const picked = !!(gridState && gridState.filter && gridState.filter.selected.length);
  const dpd = open ? panelPlot(panel) : null;
  const xr = dpd && dpd.layout && dpd.layout.xaxis && dpd.layout.xaxis.range;
  const view = Array.isArray(xr) && xr.length === 2 ? [xr[0], xr[1]] : null;
  return {
    saved: open ? { station: open, tab: tabId, pick: null, view: view } : null,
    grid: picked ? gridState : null,
    hasGrid: !!grid,
  };
}

function carriedStation() {
  if (!CARRY_TABS.has(state.activeTab)) return null;
  const pane = activePane();
  const panel = pane && pane.querySelector(".wx-ov-chart");
  if (!panel || panel.style.display === "none") return null;
  return panel._wxStation || null;
}

function warmCarryFiles(tabId) {
  const suffix = TAB_SUFFIX[tabId];
  if (!suffix || !state.fc || tabId === OVERVIEW_TAB || tabId === DATA_TAB) return;
  const grid = activeGrid();
  const local = new Set(((grid && grid._wxStations) || []).map(neighbourKey));
  const names = new Set();
  if (grid && typeof grid._wxFilterNames === "function") {
    for (const name of grid._wxFilterNames()) names.add(name);
  }
  const station = carriedStation();
  if (station && _nbGroups) {
    for (const name of _nbGroups.get(neighbourKey(station)) || []) names.add(name);
  }
  const own = safeFc(state.fc);
  for (const name of names) {
    if (local.has(neighbourKey(name))) continue;
    const at = stationCoord(name);
    if (!at || !at.fc || safeFc(at.fc) === own) continue;
    warmFile(chartFile(at.fc, state.hours, suffix));
  }
}

function applyTabCarry(carry, pane) {
  if (!carry) return;
  const panel = pane.querySelector(".wx-ov-chart");
  const grid = activeGrid(pane);
  const isOpen = !!(panel && panel.style.display !== "none");
  const ownGrid = !!(grid && carry.hasGrid);
  const clearGrid = () => {
    if (ownGrid && !carry.grid && typeof grid._wxClearFilter === "function") {
      grid._wxClearFilter();
    }
  };
  if (!carry.saved) {
    if (ownGrid && carry.grid) restoreGridState(carry.grid, pane);
    clearGrid();
    if (isOpen) closeOverviewChart(panel, ownGrid);
    return;
  }
  if (isOpen && panel._wxStation === carry.saved.station) {
    const dpd = panelPlot(panel);
    const want = carry.saved.view;
    if (dpd && want && typeof dpd._wxSetView === "function") dpd._wxSetView(want);
    if (ownGrid && carry.grid) restoreGridState(carry.grid, pane);
    clearGrid();
    if (grid && typeof grid._wxNeighbourSync === "function") grid._wxNeighbourSync();
    return;
  }
  clearGrid();
  restoreCarried(carry.saved, ownGrid ? carry.grid : null, pane);
}

function renderTab(tabId) {
  const tab = TABS.find((t) => t.id === tabId) || TABS[0];
  const host = tabShell();
  const entry = paneFor(tab);
  const current = host.querySelector(".tab-pane.active");

  if (state.activeTab === tab.id && current === entry.pane && entry.ready) {
    return Promise.resolve();
  }

  const forced = _carryOverride && _carryOverride.tab === tab.id ? _carryOverride : null;
  _carryOverride = null;
  const carry = forced
    ? { saved: forced.saved, grid: null, hasGrid: false }
    : current && current !== entry.pane && current.dataset.tab !== tab.id
      ? captureTabCarry(current, current.dataset.tab, tab.id)
      : null;
  const carryNow = !!carry && entry.ready;
  const carryLater =
    carry && !entry.ready && (carry.saved || carry.grid)
      ? {
          fc: state.fc,
          hours: state.hours,
          tab: tab.id,
          saved: carry.saved,
          grid: carry.grid,
        }
      : null;
  if (carryLater) _pendingDetail = carryLater;
  let carried = false;
  const runCarry = () => {
    if (!carry || carried || !entry.ready || state.activeTab !== tab.id) return;
    let go = carryNow;
    if (carryLater && _pendingDetail === carryLater) {
      _pendingDetail = null;
      go = true;
    }
    if (!go) return;
    carried = true;
    try {
      applyTabCarry(carry, entry.pane);
    } catch (e) {
      console.warn("tab carry failed", e);
    }
  };

  state.activeTab = tab.id;
  writeRoute(false);
  holdPrebuild(PREBUILD_HOLD_MS);
  markTabButtons(tab.id);

  const moving = !!current && current !== entry.pane;
  const frames = moving ? 1 : 0;
  const cold = moving && !entry.ready;
  const job = entry.ready ? Promise.resolve(entry) : fillPane(tab);
  const reveal = revealPane(
    host,
    entry,
    frames,
    cold ? job : null,
    moving && entry.ready
  );

  reveal.then((ok) => {
    if (!ok) return;
    runCarry();
    const shown = activeGrid(entry.pane);
    if (shown && typeof shown._wxMapClaim === "function") shown._wxMapClaim();
    const picker = entry.pane.querySelector(".wx-ov-stack");
    if (picker && typeof picker._wxMapClaim === "function") picker._wxMapClaim();
    afterFrame(() => {
      if (state.activeTab !== tab.id) return;
      kickMounts();
      kickSeeds();
      scheduleWarm();
      warmTabPayloads();
      prebuildPanes();
    });
  });

  return Promise.all([job, reveal]).then((res) => {
    if (!res[1] || state.activeTab !== tab.id) return;
    return afterPaint().then(() => {
      if (state.activeTab !== tab.id) return;
      runCarry();
      resizePlots(entry.pane);
      catchUpResize();
      sizeOverviewShell();
      const picker = entry.pane.querySelector(".wx-ov-stack");
      if (picker && typeof picker._wxMapClaim === "function") picker._wxMapClaim();
      kickMounts();
    });
  });
}

let runToken = 0;

async function runAnalysis() {
  const fc = $fcSelect.value;
  const hours = parseInt($rangeSelect.value, 10);
  if (!fc) {
    resetTabs();
    $main.innerHTML = "";
    $panes = null;
    $footer.textContent = "";
    return;
  }
  const sameFc = state.fc === fc;
  if (!sameFc && _sharedNeighbourMap) _sharedNeighbourMap.reset();
  const changed = state.fc !== fc || state.hours !== hours;
  const carried = _pendingDetail ? _pendingDetail.saved : null;
  const carriedGrid = _pendingDetail ? _pendingDetail.grid : null;
  const keep = sameFc && changed;
  const live = keep ? captureOpenDetail() : null;
  const reopen = keep ? live || carried : null;
  const gridKeep = keep
    ? (live ? captureGridState(true) : null) || carriedGrid || captureGridState(false)
    : null;
  state.fc = fc;
  state.hours = hours;
  if (changed) state.range = null;
  if (changed) {
    memCache.clear();
    inflight.clear();
    rawCache.clear();
    resetTabs();
    cancelPrefetch();
  }

  const token = ++runToken;
  $footer.textContent = "";

  const pending = reopen || gridKeep
    ? {
        fc: fc,
        hours: hours,
        tab: state.activeTab || OVERVIEW_TAB,
        saved: reopen,
        grid: gridKeep,
      }
    : null;
  _pendingDetail = pending;

  await renderTab(state.activeTab || OVERVIEW_TAB);
  if (token !== runToken) return;

  if (pending && _pendingDetail === pending) {
    _pendingDetail = null;
    restoreCarried(reopen, gridKeep, activePane());
  }

  const [dmin, dmax] = await extractDateRange(fc, hours);
  if (token !== runToken) return;
  state.range = dmin && dmax ? [dmin, dmax] : null;

  $footer.textContent = (dmin && dmax)
    ? `Data range:  ${dmin}  –  ${dmax}`
    : `FC: ${fc}  |  Window: ${hours}h`;
}

const UNASSIGNED_FC = "No Fire Centre";

async function populateDropdown() {
  try {
    const res = await fetch(CONFIG_BASE + "fire_centres.json", { cache: "no-cache" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const centres = await res.json();
    if (!Array.isArray(centres) || !centres.length) throw new Error("no fire centres");
    clearConnError();
    const named = centres.filter((c) => c !== UNASSIGNED_FC).sort((a, b) => a.localeCompare(b));
    const option = (c) => `<option value="${c.replace(/"/g, "&quot;")}">${c}</option>`;
    $fcSelect.innerHTML = '<option value="" selected disabled hidden>Select Centre…</option>' +
      named.map(option).join("") +
      (centres.includes(UNASSIGNED_FC) ? "<hr>" + option(UNASSIGNED_FC) : "");
  } catch (e) {
    showConnError(e);
    $fcSelect.innerHTML = '<option value="">- unavailable -</option>';
  }
}

function handleBreakpointChange() {
  resetTabs();
  if (state.fc) renderTab(state.activeTab || OVERVIEW_TAB);
}

if (typeof MOBILE_QUERY.addEventListener === "function") {
  MOBILE_QUERY.addEventListener("change", handleBreakpointChange);
} else if (typeof MOBILE_QUERY.addListener === "function") {
  MOBILE_QUERY.addListener(handleBreakpointChange);
}

function closeOpenPanels(root) {
  if (!root || !root.querySelectorAll) return;
  for (const panel of root.querySelectorAll(".wx-ov-chart")) {
    if (panel.style.display !== "none") closeDetailByUser(panel);
  }
}

const $brand = document.querySelector("#wx-nav .brand");
if ($brand) {
  $brand.style.cursor = "pointer";
  $brand.addEventListener("click", () => {
    if (!state.fc) return;
    Promise.resolve(renderTab(OVERVIEW_TAB)).then(() => closeOpenPanels(activePane()));
    try {
      window.scrollTo(0, 0);
    } catch (e) {
      void e;
    }
  });
}

const ROUTE_KEYS = ["fc", "window", "tab", "hours"];

const WINDOW_CODES = {
  24: "24h",
  48: "48h",
  72: "72h",
  168: "7d",
  336: "2w",
  720: "1mo",
  1440: "2mo",
  2160: "3mo",
  4380: "6mo",
};

function windowCode(hours) {
  const h = parseInt(hours, 10);
  return WINDOW_CODES[h] || h + "h";
}

const FC_CODES = {
  kamloops: "KFC",
  northwest: "NWFC",
  coastal: "CoFC",
  cariboo: "CaFC",
  southeast: "SEFC",
  princegeorge: "PGFC",
  quickdeploy: "QD",
};

function fcKey(name) {
  return name.toLowerCase().replace(/fire\s*centre/g, "").replace(/[^a-z0-9]/g, "");
}

function fcCode(name) {
  return FC_CODES[fcKey(name)] || safeFc(name);
}

function tabSlug(tab) {
  return tab.label.toLowerCase();
}

function routeFromUrl() {
  const q = new URLSearchParams(location.search);
  const name = q.get("fc");
  if (!name) return { empty: true, fc: null, hours: null, tab: OVERVIEW_TAB };
  const code = name.trim().toLowerCase();
  const key = fcKey(name);
  let fc = null;
  for (const opt of $fcSelect.options) {
    if (!opt.value) continue;
    if (fcCode(opt.value).toLowerCase() === code || fcKey(opt.value) === key) {
      fc = opt.value;
      break;
    }
  }
  const asked = (q.get("window") || "").trim().toLowerCase();
  let hours = null;
  for (const opt of $rangeSelect.options) {
    if (windowCode(opt.value) === asked) {
      hours = opt.value;
      break;
    }
  }
  const slug = (q.get("tab") || "").toLowerCase();
  const tab = TABS.find((t) => tabSlug(t) === slug);
  return { empty: false, fc: fc, hours: hours, tab: tab ? tab.id : OVERVIEW_TAB };
}

function routeSearch() {
  const fc = $fcSelect.value;
  if (!fc) return "";
  const q = new URLSearchParams();
  q.set("fc", fcCode(fc));
  q.set("window", windowCode($rangeSelect.value));
  const tab = TABS.find((t) => t.id === state.activeTab);
  if (tab && tab.id !== OVERVIEW_TAB) q.set("tab", tabSlug(tab));
  for (const [key, value] of new URLSearchParams(location.search)) {
    if (!ROUTE_KEYS.includes(key)) q.append(key, value);
  }
  return "?" + q.toString();
}

function writeRoute(replace) {
  const search = routeSearch();
  if (!search || location.search === search) return;
  const url = location.pathname + search;
  try {
    if (replace) history.replaceState(null, "", url);
    else history.pushState(null, "", url);
  } catch (e) {
    void e;
  }
}

function applyRoute() {
  const route = routeFromUrl();
  if (route.empty) {
    if (!$fcSelect.value) return;
    $fcSelect.value = "";
    state.activeTab = OVERVIEW_TAB;
    runAnalysis();
    return;
  }
  if (!route.fc) return;
  const hours = route.hours || $rangeSelect.value;
  const same = $fcSelect.value === route.fc && $rangeSelect.value === hours;
  $fcSelect.value = route.fc;
  $rangeSelect.value = hours;
  if (same) {
    renderTab(route.tab);
    return;
  }
  state.activeTab = route.tab;
  writeRoute(true);
  runAnalysis();
}

function onSelectionChange() {
  writeRoute(false);
  runAnalysis();
}

$fcSelect.addEventListener("change", () => {
  state.activeTab = OVERVIEW_TAB;
  onSelectionChange();
});
$rangeSelect.addEventListener("change", onSelectionChange);
window.addEventListener("popstate", applyRoute);
populateDropdown().then(applyRoute);