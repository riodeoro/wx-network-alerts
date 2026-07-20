const BUCKET_BASE = "./data/";
const CONFIG_BASE = "./data/";

const CHART_WINDOWS = [24, 72, 168, 720, 2160, 4380];

function resolveChartWindow(hours) {
  for (const w of CHART_WINDOWS) if (w >= hours) return w;
  return null;
}

function safeFc(fcName) {
  return fcName.trim().replace(/[^A-Za-z0-9_-]/g, "_");
}

const memCache = new Map();

async function fetchJson(filename) {
  if (memCache.has(filename)) return memCache.get(filename);
  try {
    const res = await fetch(BUCKET_BASE + filename, { cache: "no-store" });
    if (!res.ok) return null;
    const data = await res.json();
    memCache.set(filename, data);
    return data;
  } catch (e) {
    console.warn("fetchJson failed", filename, e);
    return null;
  }
}

async function fetchText(filename) {
  if (memCache.has(filename)) return memCache.get(filename);
  try {
    const res = await fetch(BUCKET_BASE + filename, { cache: "no-store" });
    if (!res.ok) return null;
    const data = await res.text();
    memCache.set(filename, data);
    return data;
  } catch (e) {
    return null;
  }
}

function loadCharts(fc, hours, suffix) {
  const w = resolveChartWindow(hours);
  if (w === null) return Promise.resolve(null);
  return fetchJson(`${safeFc(fc)}_${w}h_${suffix}.json`);
}

function loadText(fc, hours, suffix) {
  const w = resolveChartWindow(hours);
  if (w === null) return Promise.resolve(null);
  return fetchText(`${safeFc(fc)}_${w}h_${suffix}.txt`);
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

function graph(figDict, opts = {}) {
  const wrap = el("div");
  const plotDiv = el("div");
  plotDiv.style.width = "100%";
  wrap.appendChild(plotDiv);
  if (!figDict) {
    wrap.appendChild(el("div", "unavailable", "Chart data unavailable."));
    return wrap;
  }

  const layout = Object.assign({}, figDict.layout || {});
  const height = opts.height || layout.height || 420;
  delete layout.width;
  layout.autosize = true;
  layout.height = height;
  plotDiv.style.height = height + "px";

  const config = {
    responsive: true,
    displaylogo: false,
    displayModeBar: opts.noModeBar ? false : "hover",
  };

  const mount = () => {
    if (!plotDiv.isConnected || plotDiv.clientWidth === 0) {
      requestAnimationFrame(mount);
      return;
    }
    try {
      Plotly.newPlot(plotDiv, figDict.data || [], layout, config)
        .then(() => Plotly.Plots.resize(plotDiv));
    } catch (e) {
      plotDiv.appendChild(el("div", "unavailable", "Chart failed to render."));
    }
  };
  requestAnimationFrame(mount);

  window.addEventListener("resize", () => {
    if (plotDiv.isConnected && plotDiv.clientWidth) Plotly.Plots.resize(plotDiv);
  });

  return wrap;
}

function card(child, extraStyle) {
  const c = el("div", "wx-card");
  if (extraStyle) Object.assign(c.style, extraStyle);
  c.appendChild(child);
  return c;
}

function row(left, right) {
  const r = el("div", "wx-chart-row");
  r.appendChild(card(left));
  r.appendChild(card(right));
  return r;
}

function unavailable() {
  return el("div", "unavailable", "Chart data unavailable.");
}

function stationGrid(c) {
  if (!c || !c.station_grid) return el("div");
  const fig = c.station_grid;
  const h = (fig.layout && fig.layout.height) || 400;
  const wrap = el("div", "station-grid");
  wrap.appendChild(graph(fig, { height: h, noModeBar: true }));
  return wrap;
}

async function insightBanner(fc, hours, tab) {
  let text = await loadText(fc, hours, `insights_${tab}`);

  if (text && text.startsWith("<!-- hash:")) {
    const nl = text.indexOf("\n");
    text = nl >= 0 ? text.slice(nl + 1) : "";
  }
  if (!text || !text.trim()) {
    return el("div", "insight-empty", "No alerts");
  }

  let inner = text.trim();
  if (inner.startsWith("```")) {
    inner = inner.slice(3);
    if (inner.endsWith("```")) inner = inner.slice(0, -3);
    inner = inner.trim();
  }

  const sections = [];
  let current = [];
  for (const line of inner.split("\n")) {
    if (line === line.toUpperCase() && line.trim() && !line.startsWith(" ") && current.length) {
      sections.push(current.join("\n"));
      current = [];
    }
    current.push(line);
  }
  if (current.length) sections.push(current.join("\n"));

  const banner = el("div", "insight-banner");
  for (const s of sections) {
    const pre = el("pre");
    const code = el("code");
    code.textContent = s;
    pre.appendChild(code);
    banner.appendChild(pre);
    if (window.hljs) {
      try { window.hljs.highlightElement(code); } catch (e) {}
    }
  }
  return banner;
}

async function buildRh(fc, hours) {
  const c = await loadCharts(fc, hours, "rh");
  if (!c) return unavailable();
  const box = el("div");
  box.appendChild(await insightBanner(fc, hours, "rh"));
  box.appendChild(stationGrid(c));
  box.appendChild(row(graph(c.rh_distribution), graph(c.rh_volcano)));
  box.appendChild(card(graph(c.rh100_scatter)));
  return box;
}

async function buildWind(fc, hours) {
  const c = await loadCharts(fc, hours, "wind");
  if (!c) return unavailable();
  const box = el("div");
  box.appendChild(await insightBanner(fc, hours, "wind"));
  box.appendChild(stationGrid(c));
  box.appendChild(row(graph(c.wind_distribution), graph(c.mx_distribution)));
  box.appendChild(row(graph(c.wind_stall_heatmap), graph(c.dir_coverage_heatmap)));
  return box;
}

async function buildTemp(fc, hours) {
  const c = await loadCharts(fc, hours, "temp");
  if (!c) return unavailable();
  const box = el("div");
  box.appendChild(await insightBanner(fc, hours, "temp"));
  box.appendChild(stationGrid(c));
  box.appendChild(row(graph(c.temp_distribution), graph(c.temp_volcano)));
  box.appendChild(card(graph(c.constant_temp_gantt)));
  return box;
}

async function buildRn1(fc, hours) {
  const c = await loadCharts(fc, hours, "rn1");
  if (!c) return unavailable();
  const box = el("div");
  box.appendChild(await insightBanner(fc, hours, "rn1"));
  box.appendChild(stationGrid(c));
  box.appendChild(row(graph(c.rn1_distribution), graph(c.precip_diagnostic_dashboard)));
  box.appendChild(card(graph(c.precip_silent_sensor)));
  return box;
}

async function buildPower(fc, hours) {
  const c = await loadCharts(fc, hours, "power");
  if (!c) return unavailable();
  const box = el("div");
  box.appendChild(await insightBanner(fc, hours, "power"));
  box.appendChild(stationGrid(c));
  box.appendChild(card(graph(c.power_distribution)));
  box.appendChild(row(graph(c.power_diagnostic_dashboard), graph(c.vbat_heatmap)));
  return box;
}

const TABS = [
  { id: "tab-rh",    label: "Rh",    build: buildRh },
  { id: "tab-wind",  label: "Wind",  build: buildWind },
  { id: "tab-temp",  label: "Temp",  build: buildTemp },
  { id: "tab-rn1",   label: "Rn_1",  build: buildRn1 },
  { id: "tab-power", label: "Power", build: buildPower },
];

const state = { fc: null, hours: 168, activeTab: "tab-rh" };

const $main = document.getElementById("al-main-content");
const $footer = document.getElementById("al-timing-diag");
const $fcSelect = document.getElementById("al-fc-select");
const $rangeSelect = document.getElementById("al-range-select");
const $runBtn = document.getElementById("al-btn-run");
const $connError = document.getElementById("conn-error");

function showLoading() {
  $main.innerHTML = "";
  const l = el("div", "al-loading");
  l.appendChild(el("div", "spinner"));
  l.appendChild(el("span", null, "Loading charts…"));
  $main.appendChild(l);
}

async function renderTab(tabId) {
  const tab = TABS.find(t => t.id === tabId) || TABS[0];
  state.activeTab = tab.id;

  $main.innerHTML = "";

  const tabsBar = el("div", "al-tabs");
  for (const t of TABS) {
    const btn = el("div", "al-tab" + (t.id === tab.id ? " active" : ""), t.label);
    btn.addEventListener("click", () => renderTab(t.id));
    tabsBar.appendChild(btn);
  }
  $main.appendChild(tabsBar);

  const body = el("div", "tab-content");
  const loading = el("div", "al-loading");
  loading.appendChild(el("div", "spinner"));
  loading.appendChild(el("span", null, "Loading charts…"));
  body.appendChild(loading);
  $main.appendChild(body);

  const content = await tab.build(state.fc, state.hours);
  body.innerHTML = "";
  body.appendChild(content);
}

async function runAnalysis() {
  const fc = $fcSelect.value;
  const hours = parseInt($rangeSelect.value, 10);
  if (!fc) {
    $main.innerHTML = "";
    return;
  }
  state.fc = fc;
  state.hours = hours;
  memCache.clear();

  $runBtn.disabled = true;
  showLoading();

  await renderTab(state.activeTab || "tab-rh");

  const [dmin, dmax] = await extractDateRange(fc, hours);
  $footer.textContent = (dmin && dmax)
    ? `Data range:  ${dmin}  →  ${dmax}`
    : `FC: ${fc}  |  Window: ${hours}h`;

  $runBtn.disabled = false;
}

async function populateDropdown() {
  try {
    const res = await fetch(CONFIG_BASE + "fire_centres.json", { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const centres = await res.json();
    if (!Array.isArray(centres) || !centres.length) throw new Error("no fire centres");
    centres.sort((a, b) => a.localeCompare(b));
    $fcSelect.innerHTML = '<option value="" selected disabled hidden>Select Centre…</option>' +
      centres.map(c => `<option value="${c.replace(/"/g, "&quot;")}">${c}</option>`).join("");
  } catch (e) {
    showConnError(e);
    $fcSelect.innerHTML = '<option value="">- unavailable -</option>';
  }
}



$runBtn.addEventListener("click", runAnalysis);
$rangeSelect.addEventListener("change", () => { state.hours = parseInt($rangeSelect.value, 10); });
populateDropdown();
