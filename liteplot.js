(function () {
  "use strict";

  const SVG_NS = "http://www.w3.org/2000/svg";
  const SEC = 1000;
  const MIN = 60 * SEC;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;
  const AVG_MONTH = 30.4375 * DAY;
  const AVG_YEAR = 365.25 * DAY;
  const COLORWAY = [
    "#332288", "#88ccee", "#44aa99", "#117733",
    "#999933", "#ddcc77", "#cc6677", "#882255",
  ];
  const DEFAULT_FONT = '"BC Sans", "Noto Sans", Verdana, Arial, sans-serif';
  const MIN_DRAG = 8;
  const BOX_SHOW_PX = 3;
  const DBL_DELAY = 300;
  const LEGEND_ROW = 19;
  const LEGEND_GAP = 5;
  const LEGEND_TOP_GAP = 9;
  const LEGEND_PAD_W = 5;
  const PAPER_PAD = 12;
  const CB_TITLE_GAP = 4;
  const CB_TICK_GAP = 3;
  const ANN_PAD = 2;
  const ZOOM_FILL = "rgba(0,0,0,0.2)";
  const TICK_BASELINE = 0.35;
  const LABEL_GAP = 1;
  const LABEL_BELOW = 0.616;
  const LABEL_ABOVE = 0.584;
  const AUTO_PAD = 9;
  const XLABEL_GAP = 1;
  const BOX_GAP = 0.3;
  const BOX_GROUP_GAP = 0.3;
  const BOX_HOVER_SLOP = 3;
  const BOX_STATS = ["lf", "q1", "med", "q3", "uf"];
  const CAP_SHIFT = 0.7;
  const MID_SHIFT = 0.35;
  const LINE_SPACING = 1.3;
  const TEXT_ASCENT = 1.0;
  const TEXT_DESCENT = 0.225;
  const TITLE_ASCENT = 1.0;
  const TITLE_DESCENT = 0.3;
  const TITLE_STANDOFF = 15;
  const TITLE_PAD = 6;
  const XLABEL_PAD = 12;
  const DATE_RE = /^\s*(-?\d{4})(?:-(\d{1,2})(?:-(\d{1,2})(?:[ T](\d{1,2})(?::(\d{1,2})(?::(\d{1,2})(\.\d+)?)?)?)?)?)?/;
  const ENTITY = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", nbsp: " " };
  const DTYPES = {
    f8: Float64Array, f4: Float32Array, i4: Int32Array, u4: Uint32Array,
    i2: Int16Array, u2: Uint16Array, i1: Int8Array, u1: Uint8Array, u1c: Uint8ClampedArray,
  };

  const decodedCache = new WeakMap();
  const timeCache = new WeakMap();
  const numCache = new WeakMap();

  function base64Buffer(s) {
    const bin = atob(s);
    const n = bin.length;
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = bin.charCodeAt(i);
    return out.buffer;
  }

  function decode(v) {
    if (v === null || v === undefined) return null;
    if (Array.isArray(v) || ArrayBuffer.isView(v)) return v;
    if (typeof v === "object" && v.dtype && v.bdata !== undefined) {
      if (decodedCache.has(v)) return decodedCache.get(v);
      let out = null;
      try {
        const T = DTYPES[v.dtype];
        const buf = typeof v.bdata === "string" ? base64Buffer(v.bdata) : v.bdata;
        out = T ? new T(buf) : null;
      } catch (e) {
        out = null;
      }
      decodedCache.set(v, out);
      return out;
    }
    return null;
  }

  function dateMs(v) {
    if (typeof v === "number") return v;
    if (v instanceof Date) return v.getTime();
    if (typeof v !== "string") return NaN;
    const m = DATE_RE.exec(v);
    if (!m) return NaN;
    const ms = Date.UTC(
      Number(m[1]),
      m[2] ? Number(m[2]) - 1 : 0,
      m[3] ? Number(m[3]) : 1,
      m[4] ? Number(m[4]) : 0,
      m[5] ? Number(m[5]) : 0,
      m[6] ? Number(m[6]) : 0
    );
    return m[7] ? ms + Number(m[7]) * 1000 : ms;
  }

  function numOf(v) {
    if (v === null || v === undefined || v === "") return NaN;
    const n = typeof v === "number" ? v : Number(v);
    return isFinite(n) ? n : NaN;
  }

  function pad2(n) {
    return n < 10 ? "0" + n : String(n);
  }

  function msText(ms) {
    if (!isFinite(ms)) return null;
    const d = new Date(ms);
    let s =
      d.getUTCFullYear() + "-" + pad2(d.getUTCMonth() + 1) + "-" + pad2(d.getUTCDate()) +
      " " + pad2(d.getUTCHours()) + ":" + pad2(d.getUTCMinutes());
    const sec = d.getUTCSeconds();
    const milli = d.getUTCMilliseconds();
    if (sec || milli) {
      s += ":" + pad2(sec);
      if (milli) s += "." + String(milli).padStart(3, "0").replace(/0+$/, "");
    }
    return s;
  }

  function isDateString(v) {
    return typeof v === "string" && DATE_RE.test(v) && /^\s*-?\d{4}-\d/.test(v);
  }

  function valuesAsTime(raw) {
    const arr = decode(raw);
    if (!arr) return null;
    if (timeCache.has(arr)) return timeCache.get(arr);
    const n = arr.length;
    const out = new Float64Array(n);
    let sorted = true;
    let prev = -Infinity;
    for (let i = 0; i < n; i++) {
      const t = dateMs(arr[i]);
      out[i] = isFinite(t) ? t : NaN;
      if (out[i] === out[i]) {
        if (out[i] < prev) sorted = false;
        prev = out[i];
      }
    }
    const res = { v: out, sorted: sorted };
    timeCache.set(arr, res);
    return res;
  }

  function valuesAsNumber(raw) {
    const arr = decode(raw);
    if (!arr) return null;
    if (numCache.has(arr)) return numCache.get(arr);
    const n = arr.length;
    const out = new Float64Array(n);
    let sorted = true;
    let prev = -Infinity;
    for (let i = 0; i < n; i++) {
      out[i] = numOf(arr[i]);
      if (out[i] === out[i]) {
        if (out[i] < prev) sorted = false;
        prev = out[i];
      }
    }
    const res = { v: out, sorted: sorted };
    numCache.set(arr, res);
    return res;
  }

  function at(v, i) {
    if (Array.isArray(v) || ArrayBuffer.isView(v)) return v[i];
    return v;
  }

  function maxOf(v, dflt) {
    if (Array.isArray(v) || ArrayBuffer.isView(v)) {
      let m = -Infinity;
      for (let i = 0; i < v.length; i++) {
        const n = Number(v[i]);
        if (isFinite(n) && n > m) m = n;
      }
      return isFinite(m) ? m : dflt;
    }
    const n = Number(v);
    return isFinite(n) ? n : dflt;
  }

  class Axis {
    constructor(name, input, letter) {
      this._name = name;
      this._id = letter + name.slice(5);
      this._letter = letter;
      this._input = input;
      this.anchor = input.anchor || (letter === "x" ? "y" : "x");
      this.domain = Array.isArray(input.domain) && input.domain.length === 2
        ? [Number(input.domain[0]), Number(input.domain[1])]
        : [0, 1];
      this.matches = typeof input.matches === "string" ? input.matches : undefined;
      this.visible = input.visible !== false;
      this.type = input.type === "date" || input.type === "linear" || input.type === "category" ? input.type : "-";
      this.tickangle = isFinite(Number(input.tickangle)) ? Number(input.tickangle) : 0;
      this.categoryorder = input.categoryorder;
      this.categoryarray = input.categoryarray;
      this._categories = null;
      this._catMap = null;
      const title = input.title && typeof input.title === "object" ? input.title : {};
      this.titleText = typeof input.title === "string" ? input.title : title.text;
      this.titleFont = Object.assign({}, title.font);
      this.titleStandoff = title.standoff === undefined ? undefined : Number(title.standoff);
      this.showticklabels = input.showticklabels !== false;
      this.showgrid = input.showgrid === undefined ? true : !!input.showgrid;
      this.zeroline = input.zeroline === undefined ? true : !!input.zeroline;
      this.zerolinecolor = input.zerolinecolor || "#2d2d2d";
      this.zerolinewidth = input.zerolinewidth === undefined ? 1 : Number(input.zerolinewidth);
      this.dtick = input.dtick;
      this._explicitGrid = input.showgrid !== undefined;
      this._explicitZero = input.zeroline !== undefined;
      this.gridcolor = input.gridcolor || "#edebe9";
      this.gridwidth = input.gridwidth === undefined ? 1 : Number(input.gridwidth);
      this.tickfont = Object.assign({}, input.tickfont);
      this.nticks = Number(input.nticks) || 0;
      this.tickmode = input.tickmode;
      this.tickvals = input.tickvals;
      this.ticktext = input.ticktext;
      this.hoverformat = input.hoverformat;
      this.fixedrange = !!input.fixedrange;
      this.automargin = input.automargin === undefined ? false : input.automargin;
      this.autorange = input.autorange;
      this.range = null;
      this._rl = null;
      this._offset = 0;
      this._length = 0;
      this._m = 1;
      this._b = 0;
    }

    d2c(v) {
      if (this.type === "date") return dateMs(v);
      if (this.type === "category") {
        if (typeof v === "number") return v;
        if (v === null || v === undefined) return NaN;
        const k = this._catMap ? this._catMap.get(String(v)) : undefined;
        return k === undefined ? NaN : k;
      }
      return numOf(v);
    }

    c2l(v) {
      return v;
    }

    l2c(v) {
      return v;
    }

    d2l(v) {
      return this.d2c(v);
    }

    r2l(v) {
      return this.type === "category" ? numOf(v) : this.d2c(v);
    }

    r2c(v) {
      return this.r2l(v);
    }

    l2r(v) {
      return this.type === "date" ? msText(v) : v;
    }

    c2r(v) {
      return this.l2r(v);
    }

    c2d(v) {
      if (this.type === "category") {
        const k = Math.round(v);
        return this._categories && this._categories[k] !== undefined ? this._categories[k] : v;
      }
      return this.l2r(v);
    }

    l2d(v) {
      return this.l2r(v);
    }

    l2p(v) {
      return this._m * v + this._b;
    }

    c2p(v) {
      return this._m * v + this._b;
    }

    d2p(v) {
      return this.l2p(this.d2c(v));
    }

    r2p(v) {
      return this.l2p(this.r2l(v));
    }

    p2l(px) {
      return (px - this._b) / this._m;
    }

    p2c(px) {
      return this.p2l(px);
    }

    p2r(px) {
      return this.l2r(this.p2l(px));
    }

    p2d(px) {
      return this.l2r(this.p2l(px));
    }
  }

  function axisKey(id, letter) {
    const s = typeof id === "string" && id ? id : letter;
    return (letter === "x" ? "xaxis" : "yaxis") + s.slice(1);
  }

  function setPath(obj, path, value) {
    const parts = [];
    path.replace(/([^.[\]]+)|\[(\d+)\]/g, (m, key, idx) => {
      parts.push(idx !== undefined ? Number(idx) : key);
      return m;
    });
    if (!parts.length) return;
    let o = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      const k = parts[i];
      const nextIsIdx = typeof parts[i + 1] === "number";
      if (o[k] === null || typeof o[k] !== "object") o[k] = nextIsIdx ? [] : {};
      o = o[k];
    }
    const last = parts[parts.length - 1];
    if (value === null || value === undefined) {
      if (Array.isArray(o) && typeof last === "number") o[last] = null;
      else delete o[last];
    } else {
      o[last] = value;
    }
  }

  function deepCopyValue(v) {
    if (Array.isArray(v)) return v.slice();
    if (v && typeof v === "object") return Object.assign({}, v);
    return v;
  }

  function roundUp(val, set) {
    for (let i = 0; i < set.length; i++) if (set[i] > val) return set[i];
    return set[set.length - 1];
  }

  function roundDTick(rough, base, set) {
    return base * roundUp(rough / base, set);
  }

  function cleanNum(v) {
    return Number(v.toPrecision(12));
  }

  function linearTicks(ax) {
    const r0 = Math.min(ax._rl[0], ax._rl[1]);
    const r1 = Math.max(ax._rl[0], ax._rl[1]);
    const span = r1 - r0;
    if (!(span > 0)) return { vals: [], text: [] };
    const tol = span * 1e-4;
    if (Array.isArray(ax.tickvals) && (ax.tickmode === "array" || ax.tickmode === undefined)) {
      const vals = [];
      const text = [];
      ax.tickvals.forEach((tv, i) => {
        const v = ax.d2c(tv);
        if (!isFinite(v) || v < r0 - tol || v > r1 + tol) return;
        vals.push(v);
        const tt = Array.isArray(ax.ticktext) ? ax.ticktext[i] : undefined;
        text.push(tt !== undefined && tt !== null ? String(tt) : formatLinear(v, 0, 0));
      });
      return { vals: vals, text: text };
    }
    const nt = ax.nticks || Math.max(4, Math.min(9, ax._length / (ax._letter === "y" ? 40 : 80))) + 1;
    const rough = span / nt;
    const base = Math.pow(10, Math.floor(Math.log(rough) / Math.LN10));
    const dtick = roundDTick(rough, base, [2, 5, 10]);
    const maxEnd = Math.max(Math.abs(r0), Math.abs(r1));
    const rangeExp = Math.floor(Math.log(maxEnd) / Math.LN10 + 0.01);
    const exp = rangeExp > 3 ? 3 * Math.round((rangeExp - 1) / 3) : 0;
    const first = Math.ceil((r0 - tol) / dtick);
    const vals = [];
    const text = [];
    for (let k = first; k * dtick <= r1 + tol && vals.length < 1000; k++) {
      const v = cleanNum(k * dtick);
      vals.push(v);
      text.push(formatLinear(v, dtick, exp));
    }
    return { vals: vals, text: text };
  }

  function categoryTicks(ax, fontSize) {
    const cats = ax._categories || [];
    const r0 = Math.min(ax._rl[0], ax._rl[1]);
    const r1 = Math.max(ax._rl[0], ax._rl[1]);
    if (!(r1 > r0) || !cats.length) return { vals: [], text: [] };
    const minPx = Math.round(1.2 * fontSize);
    const nt = ax.nticks || ax._length / minPx;
    const fixed = Number(ax.dtick);
    const dtick = fixed > 0 ? Math.max(1, Math.round(fixed)) : Math.max(1, Math.ceil((r1 - r0) / nt));
    const vals = [];
    const text = [];
    for (let k = Math.ceil(r0 / dtick) * dtick; k <= r1 + 1e-9; k += dtick) {
      if (k < 0 || k >= cats.length) continue;
      vals.push(k);
      text.push(cats[k]);
    }
    return { vals: vals, text: text };
  }

  const SI = { 3: "k", 6: "M", 9: "G", 12: "T" };

  function formatLinear(v, dtick, exp) {
    let x = v;
    let step = dtick;
    let suffix = "";
    if (exp && SI[exp]) {
      const div = Math.pow(10, exp);
      x = v / div;
      step = dtick / div;
      suffix = SI[exp];
    }
    let dec = 0;
    if (step > 0) dec = Math.max(0, Math.ceil(-Math.log(step) / Math.LN10 - 0.01));
    else {
      const s = String(cleanNum(Math.abs(x)));
      const dot = s.indexOf(".");
      dec = dot < 0 ? 0 : s.length - dot - 1;
    }
    dec = Math.min(dec, 15);
    let s = Math.abs(x).toFixed(dec);
    if (dec > 0) s = s.replace(/\.?0+$/, "");
    if (Number(s) === 0) return "0";
    return (x < 0 ? "−" : "") + s + suffix;
  }

  function addMonths(ms, n) {
    const d = new Date(ms);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, d.getUTCDate(),
      d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds());
  }

  function dateTicks(ax) {
    const r0 = Math.min(ax._rl[0], ax._rl[1]);
    const r1 = Math.max(ax._rl[0], ax._rl[1]);
    const span = r1 - r0;
    if (!(span > 0)) return [];
    const tol = span * 1e-4;
    if (Array.isArray(ax.tickvals) && ax.tickmode === "array") {
      return ax.tickvals.map((v) => dateMs(v)).filter((v) => isFinite(v) && v >= r0 - tol && v <= r1 + tol);
    }
    const nt = ax.nticks || Math.max(4, Math.min(9, ax._length / (ax._letter === "y" ? 40 : 80))) + 1;
    const rough = span / nt;
    const x2 = rough * 2;
    let tick0 = Date.UTC(2000, 0, 1);
    const out = [];
    if (x2 > AVG_MONTH) {
      let months;
      if (x2 > AVG_YEAR) {
        const years = rough / AVG_YEAR;
        const base = Math.pow(10, Math.floor(Math.log(years) / Math.LN10));
        months = 12 * base * roundUp(years / base, [2, 5, 10]);
      } else {
        months = roundUp(rough / AVG_MONTH, [1, 2, 3, 6]);
      }
      ax._dateUnit = months >= 12 ? "y" : "m";
      const d0 = new Date(r0 - tol);
      let k = (d0.getUTCFullYear() - 2000) * 12 + d0.getUTCMonth();
      k = Math.floor(k / months) * months;
      for (let guard = 0; guard < 2000; guard++, k += months) {
        const t = Date.UTC(2000, k, 1);
        if (t > r1 + tol) break;
        if (t >= r0 - tol) out.push(t);
      }
      return out;
    }
    let dtick;
    if (x2 > DAY) {
      dtick = roundDTick(rough, DAY, [1, 2, 3, 7, 14]);
      tick0 = Date.UTC(2000, 0, 2);
    } else if (x2 > HOUR) {
      dtick = roundDTick(rough, HOUR, [1, 2, 3, 6, 12]);
    } else if (x2 > MIN) {
      dtick = roundDTick(rough, MIN, [1, 2, 5, 10, 15, 30]);
    } else if (x2 > SEC) {
      dtick = roundDTick(rough, SEC, [1, 2, 5, 10, 15, 30]);
    } else {
      const base = Math.pow(10, Math.floor(Math.log(rough) / Math.LN10));
      dtick = roundDTick(rough, base, [2, 5, 10]);
    }
    ax._dateUnit = dtick >= DAY ? "d" : dtick >= MIN ? "M" : dtick >= SEC ? "S" : "ms";
    const first = Math.ceil((r0 - tol - tick0) / dtick);
    for (let k = first; tick0 + k * dtick <= r1 + tol && out.length < 2000; k++) {
      out.push(tick0 + k * dtick);
    }
    return out;
  }

  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  function dateParts(ms, unit) {
    const d = new Date(ms);
    const mon = MONTHS[d.getUTCMonth()];
    const day = d.getUTCDate();
    const year = d.getUTCFullYear();
    const hm = pad2(d.getUTCHours()) + ":" + pad2(d.getUTCMinutes());
    if (unit === "y") return [String(year), ""];
    if (unit === "m") return [mon + " " + year, ""];
    if (unit === "d") return [mon + " " + day, String(year)];
    const head = mon + " " + day + ", " + year;
    if (unit === "M") return [hm, head];
    if (unit === "S") return [hm + ":" + pad2(d.getUTCSeconds()), head];
    return [hm + ":" + pad2(d.getUTCSeconds()) + "." + String(d.getUTCMilliseconds()).padStart(3, "0"), head];
  }

  function dateTickText(ax, vals) {
    const unit = ax._dateUnit || "d";
    let prevHead = null;
    return vals.map((v) => {
      const parts = dateParts(v, unit);
      let text = parts[0];
      if (parts[1] && parts[1] !== prevHead) {
        text += "<br>" + parts[1];
        prevHead = parts[1];
      }
      return text;
    });
  }

  function hasMarkers(tr) {
    return String(tr.mode).indexOf("markers") >= 0;
  }

  function hasLines(tr) {
    return String(tr.mode).indexOf("lines") >= 0;
  }

  function markerPad(ft) {
    if (!hasMarkers(ft)) return 0;
    const size = maxOf(ft.marker.size, 6);
    return Math.max(size / 1.6, 3);
  }

  function boxExtremes(ft, letter, len) {
    const boxes = ft._boxes;
    if (!boxes || !boxes.length) return null;
    let lo = Infinity;
    let hi = -Infinity;
    for (const b of boxes) {
      const a = letter === "x" ? b.pos - ft._dPos : Math.min(b.lf, b.q1);
      const z = letter === "x" ? b.pos + ft._dPos : Math.max(b.uf, b.q3);
      if (a < lo) lo = a;
      if (z > hi) hi = z;
    }
    if (!(hi >= lo)) return null;
    const pad = letter === "x" ? 0 : 0.05 * len;
    return { mins: [{ val: lo, pad: pad }], maxs: [{ val: hi, pad: pad }], tozero: false };
  }

  function barExtremes(ft, letter, len) {
    const bars = ft._bars;
    if (!bars || !bars.length) return null;
    const isPos = (letter === "y") === ft._horiz;
    let lo = Infinity;
    let hi = -Infinity;
    for (const b of bars) {
      const a = isPos ? b.p - b.w / 2 : Math.min(b.b0, b.b1);
      const z = isPos ? b.p + b.w / 2 : Math.max(b.b0, b.b1);
      if (a < lo) lo = a;
      if (z > hi) hi = z;
    }
    if (!(hi >= lo)) return null;
    const pad = isPos ? 0 : 0.05 * len;
    return { mins: [{ val: lo, pad: pad }], maxs: [{ val: hi, pad: pad }], tozero: false };
  }

  function heatExtremes(ft, letter) {
    const e = letter === "x" ? ft._xe : ft._ye;
    if (!e || e.length < 2) return null;
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < e.length; i++) {
      if (e[i] < lo) lo = e[i];
      if (e[i] > hi) hi = e[i];
    }
    if (!(hi >= lo)) return null;
    return { mins: [{ val: lo, pad: 0 }], maxs: [{ val: hi, pad: 0 }], tozero: false };
  }

  function traceExtremes(ft, letter, len) {
    if (ft._box) return boxExtremes(ft, letter, len);
    if (ft._bar) return barExtremes(ft, letter, len);
    if (ft._heat) return heatExtremes(ft, letter);
    const vals = letter === "x" ? ft._xs : ft._ys;
    if (!vals) return null;
    let lo = Infinity;
    let hi = -Infinity;
    const n = ft._len;
    for (let i = 0; i < n; i++) {
      const xv = ft._xs[i];
      const yv = ft._ys[i];
      if (xv !== xv || yv !== yv) continue;
      const v = vals[i];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    if (!(hi >= lo)) return null;
    const ppad = markerPad(ft);
    const fill = ft.fill;
    let padded = true;
    let tozero = false;
    if (letter === "x") {
      if (fill === "tonexty" || fill === "tozeroy" || (!hasMarkers(ft) && !ft._hasText)) padded = false;
      if (fill === "tozerox") tozero = true;
    } else {
      if (fill === "tozeroy") tozero = true;
      else if (fill === "tonextx" || fill === "tozerox") padded = false;
    }
    const pad = ppad + (padded ? 0.05 * len : 0);
    const mins = [];
    const maxs = [];
    if (tozero) {
      mins.push({ val: Math.min(0, lo), pad: lo < 0 ? pad : 0 });
      maxs.push({ val: Math.max(0, hi), pad: hi > 0 ? pad : 0 });
    } else {
      mins.push({ val: lo, pad: pad });
      maxs.push({ val: hi, pad: pad });
    }
    return { mins: mins, maxs: maxs, tozero: tozero };
  }

  function autoRange(axes, traces, len) {
    const mins = [];
    const maxs = [];
    let tozero = false;
    const ids = new Set(axes.map((a) => a._id));
    for (const ft of traces) {
      if (ft.visible !== true) continue;
      const letter = axes[0]._letter;
      const id = letter === "x" ? ft.xaxis : ft.yaxis;
      if (!ids.has(id)) continue;
      const ex = traceExtremes(ft, letter, len);
      if (!ex) continue;
      for (const m of ex.mins) mins.push(m);
      for (const m of ex.maxs) maxs.push(m);
      if (ex.tozero) tozero = true;
    }
    const isDate = axes[0].type === "date";
    if (!mins.length || !maxs.length) {
      if (isDate) return [Date.UTC(2000, 0, 1), Date.UTC(2001, 0, 1)];
      return axes[0]._letter === "x" ? [-1, 6] : [-1, 4];
    }
    let minmin = Infinity;
    let maxmax = -Infinity;
    for (const m of mins) if (m.val < minmin) minmin = m.val;
    for (const m of maxs) if (m.val > maxmax) maxmax = m.val;
    if (minmin === maxmax) {
      const v = minmin;
      if (isDate) return [v - DAY, v + DAY];
      return [v - 1, v + 1];
    }
    let best = 0;
    let minBest = mins[0];
    let maxBest = maxs[0];
    const rangemode = axes[0]._input && axes[0]._input.rangemode;
    for (const a of mins) {
      for (const b of maxs) {
        const dv = b.val - a.val;
        if (!(dv > 0)) continue;
        const dp = len - a.pad - b.pad;
        const m = dp > 0 ? dv / dp : dv / len;
        if (m > best) {
          best = m;
          minBest = a;
          maxBest = b;
        }
      }
    }
    if (rangemode === "tozero" || rangemode === "nonnegative") {
      if (minBest.val >= 0) minBest = { val: 0, pad: 0 };
      if (rangemode === "tozero" && maxBest.val <= 0) maxBest = { val: 0, pad: 0 };
      const dv = maxBest.val - minBest.val;
      const dp = len - minBest.pad - maxBest.pad;
      best = dv > 0 ? (dp > 0 ? dv / dp : dv / len) : best;
    }
    return [minBest.val - best * minBest.pad, maxBest.val + best * maxBest.pad];
  }

  function cssFont(size, family) {
    return size + "px " + (family || DEFAULT_FONT);
  }

  let measureCtx = null;

  function textWidth(text, font) {
    if (!measureCtx) measureCtx = document.createElement("canvas").getContext("2d");
    measureCtx.font = font;
    return measureCtx.measureText(text).width;
  }

  function decodeEntities(s) {
    return s.replace(/&(#?\w+);/g, (m, k) => (ENTITY[k] !== undefined ? ENTITY[k] : m));
  }

  function richRuns(text) {
    const lines = [[]];
    let bold = 0;
    let italic = 0;
    const src = String(text == null ? "" : text).replace(/\r\n?|\n/g, "<br>");
    const re = /<\s*(\/?)\s*(b|i|br|em|strong|span|sup|sub)\b([^>]*)>|([^<]+)|(<)/gi;
    const spans = [];
    let m;
    while ((m = re.exec(src))) {
      if (m[4] !== undefined || m[5] !== undefined) {
        const t = decodeEntities(m[4] !== undefined ? m[4] : m[5]);
        if (!t) continue;
        const run = { text: t, bold: bold > 0, italic: italic > 0 };
        for (const sp of spans) {
          if (sp.size) run.size = sp.size;
          if (sp.color) run.color = sp.color;
          if (sp.bold) run.bold = true;
        }
        lines[lines.length - 1].push(run);
        continue;
      }
      const close = m[1] === "/";
      const tag = m[2].toLowerCase();
      if (tag === "br") {
        lines.push([]);
      } else if (tag === "b" || tag === "strong") {
        bold += close ? -1 : 1;
      } else if (tag === "i" || tag === "em") {
        italic += close ? -1 : 1;
      } else if (tag === "span") {
        if (close) spans.pop();
        else {
          const style = /style\s*=\s*["']([^"']*)["']/i.exec(m[3] || "");
          const sp = {};
          if (style) {
            const fsz = /font-size\s*:\s*([\d.]+)px/i.exec(style[1]);
            const col = /(?:^|;)\s*color\s*:\s*([^;]+)/i.exec(style[1]);
            const fw = /font-weight\s*:\s*(bold|[6-9]00)/i.exec(style[1]);
            if (fsz) sp.size = Number(fsz[1]);
            if (col) sp.color = col[1].trim();
            if (fw) sp.bold = true;
          }
          spans.push(sp);
        }
      }
    }
    return lines;
  }

  function isPlain(text) {
    return !/[<&\n]/.test(text);
  }

  function runFont(run, size, family) {
    return (run.italic ? "italic " : "") + (run.bold ? "bold " : "") + cssFont(run.size || size, family);
  }

  function richSize(text, size, family) {
    if (isPlain(text)) return { w: textWidth(text, cssFont(size, family)), lines: 1 };
    const lines = richRuns(text);
    let w = 0;
    for (const ln of lines) {
      let lw = 0;
      for (const run of ln) lw += textWidth(run.text, runFont(run, size, family));
      if (lw > w) w = lw;
    }
    return { w: w, lines: Math.max(1, lines.length) };
  }

  function el(tag, cls) {
    const n = document.createElementNS(SVG_NS, tag);
    if (cls) n.setAttribute("class", cls);
    return n;
  }

  function addEmitter(gd) {
    if (gd._wxLiteEv) return;
    const ev = new Map();
    gd._wxLiteEv = ev;
    gd.on = function (name, fn) {
      if (typeof fn !== "function") return gd;
      if (!ev.has(name)) ev.set(name, []);
      ev.get(name).push(fn);
      return gd;
    };
    gd.addListener = gd.on;
    gd.once = function (name, fn) {
      const wrap = function (data) {
        gd.removeListener(name, wrap);
        return fn.call(gd, data);
      };
      wrap._wxOrig = fn;
      return gd.on(name, wrap);
    };
    gd.removeListener = function (name, fn) {
      const list = ev.get(name);
      if (!list) return gd;
      const i = list.findIndex((f) => f === fn || f._wxOrig === fn);
      if (i >= 0) list.splice(i, 1);
      return gd;
    };
    gd.off = gd.removeListener;
    gd.removeAllListeners = function (name) {
      if (name === undefined) ev.clear();
      else ev.delete(name);
      return gd;
    };
    gd.emit = function (name, data) {
      const list = ev.get(name);
      if (!list || !list.length) return false;
      for (const fn of list.slice()) {
        try {
          fn.call(gd, data);
        } catch (e) {
          setTimeout(() => {
            throw e;
          }, 0);
        }
      }
      return true;
    };
    gd._wxLiteTrigger = function (name, data) {
      const list = ev.get(name);
      let out;
      if (!list) return out;
      for (const fn of list.slice()) {
        try {
          const r = fn.call(gd, data);
          if (r !== undefined) out = r;
        } catch (e) {
          setTimeout(() => {
            throw e;
          }, 0);
        }
      }
      return out;
    };
  }

  function dropEmitter(gd) {
    for (const k of ["on", "addListener", "once", "removeListener", "off", "removeAllListeners", "emit", "_wxLiteTrigger"]) {
      try {
        delete gd[k];
      } catch (e) {
        void e;
      }
    }
    delete gd._wxLiteEv;
  }

  function ensureStyles() {
    if (document.getElementById("wx-lite-styles")) return;
    const st = document.createElement("style");
    st.id = "wx-lite-styles";
    st.textContent = [
      ".wx-lite-root{position:absolute;left:0;top:0;user-select:none;-webkit-user-select:none;}",
      ".wx-lite-canvas{position:absolute;left:0;top:0;display:block;}",
      ".wx-lite-svg{position:absolute;left:0;top:0;overflow:visible;pointer-events:none;}",
      ".wx-lite-svg .annotation .cursor-pointer,.wx-lite-svg .legend .legendtoggle{pointer-events:all;}",
      ".wx-lite-svg .legendtoggle{cursor:pointer;}",
      ".wx-lite-svg .zoombox{fill:" + ZOOM_FILL + ";}",
      ".wx-lite-svg .zoombox-corners{fill:#fff;stroke:#444;stroke-width:1;}",
    ].join("");
    document.head.appendChild(st);
  }

  function liteState(gd) {
    let st = gd._wxLiteState;
    if (st) return st;
    ensureStyles();
    st = {
      root: document.createElement("div"),
      canvas: document.createElement("canvas"),
      svg: el("svg", "main-svg wx-lite-svg"),
      annLayer: el("g", "infolayer"),
      legendLayer: el("g", "legendlayer"),
      zoomLayer: el("g", "zoomlayer"),
      raf: 0,
      stale: false,
      hover: null,
      hoverKey: "",
      moveRaf: 0,
      lastMove: null,
      drag: null,
      initial: null,
      legendTimer: 0,
      legendClicks: 0,
      painted: false,
      ro: null,
      listeners: null,
    };
    st.root.className = "wx-lite-root";
    st.canvas.className = "wx-lite-canvas";
    st.svg.setAttribute("xmlns", SVG_NS);
    st.svg.appendChild(st.annLayer);
    st.svg.appendChild(st.legendLayer);
    st.svg.appendChild(st.zoomLayer);
    st.root.appendChild(st.canvas);
    st.root.appendChild(st.svg);
    gd._wxLiteState = st;
    return st;
  }

  function mountDom(gd) {
    const st = liteState(gd);
    if (st.root.parentNode !== gd) {
      while (gd.firstChild) gd.removeChild(gd.firstChild);
      gd.appendChild(st.root);
    }
    if (window.getComputedStyle(gd).position === "static") gd.style.position = "relative";
    gd.classList.add("js-plotly-plot");
    if (!st.listeners) wireEvents(gd, st);
    if (!st.ro && typeof ResizeObserver === "function") {
      st.ro = new ResizeObserver(() => {
        if (st.stale && gd.clientWidth > 0) schedulePaint(gd);
      });
      st.ro.observe(gd);
    }
    return st;
  }

  function templateLayout(layout) {
    const t = layout && layout.template;
    return (t && typeof t === "object" && t.layout && typeof t.layout === "object") ? t.layout : {};
  }

  function fullTrace(tr, i, colorway) {
    const visible = tr.visible === undefined ? true : tr.visible;
    const xsRaw = decode(tr.x);
    const ysRaw = decode(tr.y);
    const n = Math.min(xsRaw ? xsRaw.length : 0, ysRaw ? ysRaw.length : 0);
    const color = colorway[i % colorway.length];
    const line = Object.assign({ color: color, width: 2, dash: "solid", shape: "linear" }, tr.line);
    if (!tr.line || tr.line.color === undefined) {
      line.color = tr.marker && typeof tr.marker.color === "string" ? tr.marker.color : color;
    }
    const marker = Object.assign({ size: 6, opacity: 1 }, tr.marker);
    if (marker.color === undefined) marker.color = line.color;
    marker.line = Object.assign({ width: 0, color: "#2d2d2d" }, tr.marker && tr.marker.line);
    const mode = tr.mode || (n < 20 ? "lines+markers" : "lines");
    const ft = {
      index: i,
      _input: tr,
      type: tr.type || "scatter",
      mode: mode,
      visible: visible,
      xaxis: tr.xaxis || "x",
      yaxis: tr.yaxis || "y",
      name: tr.name !== undefined ? tr.name : "trace " + i,
      legendgroup: tr.legendgroup || "",
      legendrank: tr.legendrank === undefined ? 1000 : Number(tr.legendrank),
      showlegend: tr.showlegend === undefined ? true : !!tr.showlegend,
      opacity: tr.opacity === undefined ? 1 : Number(tr.opacity),
      fill: tr.fill || "none",
      fillcolor: tr.fillcolor,
      line: line,
      marker: marker,
      connectgaps: !!tr.connectgaps,
      cliponaxis: tr.cliponaxis !== false,
      hoverinfo: tr.hoverinfo === undefined ? "all" : tr.hoverinfo,
      hoveron: tr.hoveron || "points",
      text: tr.text,
      hovertext: tr.hovertext,
      customdata: tr.customdata,
      _hasText: String(mode).indexOf("text") >= 0,
      _rawX: xsRaw,
      _rawY: ysRaw,
      _len: n,
      _xs: null,
      _ys: null,
      _xSorted: true,
    };
    if (ft.fill !== "none" && !ft.fillcolor) ft.fillcolor = withAlpha(line.color, 0.5);
    if (ft.type === "bar") {
      ft._bar = true;
      ft.mode = "";
      ft._horiz = tr.orientation === "h";
      ft.orientation = ft._horiz ? "h" : "v";
      ft.fill = "none";
      const mc = tr.marker && tr.marker.color !== undefined ? tr.marker.color : color;
      ft.marker = Object.assign({}, tr.marker, { color: mc });
      ft.marker.line = Object.assign({ width: 0, color: "#2d2d2d" }, tr.marker && tr.marker.line);
      ft._len = 0;
    }
    if (ft.type === "heatmap") {
      ft._heat = true;
      ft.mode = "";
      ft.fill = "none";
      ft._len = 0;
      ft.showlegend = false;
    }
    if (ft.type === "box") {
      ft._box = true;
      ft.mode = "";
      ft.hoveron = tr.hoveron || "boxes+points";
      if (!tr.line || tr.line.width === undefined) ft.line.width = 2;
      if (!ft.fillcolor) ft.fillcolor = withAlpha(ft.line.color, 0.5);
      ft._len = 0;
    }
    return ft;
  }

  function withAlpha(color, a) {
    const c = String(color || "#2d2d2d").trim();
    let m = /^#([0-9a-f]{3})$/i.exec(c);
    if (m) {
      const h = m[1];
      return `rgba(${parseInt(h[0] + h[0], 16)},${parseInt(h[1] + h[1], 16)},${parseInt(h[2] + h[2], 16)},${a})`;
    }
    m = /^#([0-9a-f]{6})$/i.exec(c);
    if (m) {
      const h = m[1];
      return `rgba(${parseInt(h.slice(0, 2), 16)},${parseInt(h.slice(2, 4), 16)},${parseInt(h.slice(4, 6), 16)},${a})`;
    }
    m = /^rgba?\(([^)]+)\)$/i.exec(c);
    if (m) {
      const p = m[1].split(",").map((s) => s.trim());
      return `rgba(${p[0]},${p[1]},${p[2]},${a})`;
    }
    return c;
  }

  function guessType(input, traces, id, letter) {
    if (input.type === "date" || input.type === "linear" || input.type === "category") return input.type;
    for (const tr of traces) {
      if (!tr) continue;
      const tid = letter === "x" ? tr.xaxis || "x" : tr.yaxis || "y";
      if (tid !== id) continue;
      const raw = decode(letter === "x" ? tr.x : tr.y);
      if (!raw || !raw.length) continue;
      for (let i = 0; i < raw.length && i < 20; i++) {
        const v = raw[i];
        if (v === null || v === undefined || v === "") continue;
        if (isDateString(v)) return "date";
        return typeof v === "string" ? "category" : "linear";
      }
    }
    if (Array.isArray(input.range) && isDateString(input.range[0])) return "date";
    return "linear";
  }

  function marginAllows(ax, side) {
    const am = ax.automargin;
    if (am === true) return true;
    if (typeof am !== "string") return false;
    const parts = am.split("+");
    if (parts.indexOf(side) >= 0) return true;
    if ((side === "left" || side === "right") && parts.indexOf("width") >= 0) return true;
    return (side === "top" || side === "bottom") && parts.indexOf("height") >= 0;
  }

  function buildCategories(ax, data) {
    const cats = ax.categoryorder === "array" && Array.isArray(ax.categoryarray)
      ? ax.categoryarray.map(String)
      : [];
    const map = new Map();
    cats.forEach((c, i) => {
      if (!map.has(c)) map.set(c, i);
    });
    const list = cats.slice();
    for (const tr of data) {
      if (!tr) continue;
      const tid = ax._letter === "x" ? tr.xaxis || "x" : tr.yaxis || "y";
      if (tid !== ax._id) continue;
      const raw = decode(ax._letter === "x" ? tr.x : tr.y);
      if (!raw) continue;
      for (let i = 0; i < raw.length; i++) {
        const v = raw[i];
        if (v === null || v === undefined) continue;
        const k = String(v);
        if (map.has(k)) continue;
        map.set(k, list.length);
        list.push(k);
      }
    }
    if (ax.categoryorder === "category ascending" || ax.categoryorder === "category descending") {
      list.sort();
      if (ax.categoryorder === "category descending") list.reverse();
      map.clear();
      list.forEach((c, i) => map.set(c, i));
    }
    ax._categories = list;
    ax._catMap = map;
  }

  function valuesAsCategory(raw, ax) {
    const arr = decode(raw);
    if (!arr) return null;
    const n = arr.length;
    const out = new Float64Array(n);
    let sorted = true;
    let prev = -Infinity;
    for (let i = 0; i < n; i++) {
      out[i] = ax.d2c(arr[i]);
      if (out[i] === out[i]) {
        if (out[i] < prev) sorted = false;
        prev = out[i];
      }
    }
    return { v: out, sorted: sorted };
  }

  function axisValues(ax, raw) {
    if (!ax) return valuesAsNumber(raw);
    if (ax.type === "date") return valuesAsTime(raw);
    if (ax.type === "category") return valuesAsCategory(raw, ax);
    return valuesAsNumber(raw);
  }

  function buildBoxes(ft, xa, layout) {
    const tr = ft._input;
    const pos = decode(tr.x);
    const q1 = decode(tr.q1);
    const med = decode(tr.median);
    const q3 = decode(tr.q3);
    const lf = decode(tr.lowerfence);
    const uf = decode(tr.upperfence);
    const boxes = [];
    if (pos && q1 && med && q3 && lf && uf && xa) {
      for (let i = 0; i < pos.length; i++) {
        const p = xa.d2c(pos[i]);
        const b = {
          i: i,
          pos: p,
          q1: numOf(q1[i]),
          med: numOf(med[i]),
          q3: numOf(q3[i]),
          lf: numOf(lf[i]),
          uf: numOf(uf[i]),
        };
        if (!isFinite(p) || !isFinite(b.q1) || !isFinite(b.q3) || !isFinite(b.med)) continue;
        if (!isFinite(b.lf)) b.lf = b.q1;
        if (!isFinite(b.uf)) b.uf = b.q3;
        boxes.push(b);
      }
    }
    const sorted = boxes.map((b) => b.pos).sort((a, b) => a - b);
    let gap = Infinity;
    for (let i = 1; i < sorted.length; i++) {
      const d = sorted[i] - sorted[i - 1];
      if (d > 0 && d < gap) gap = d;
    }
    const dPos = isFinite(gap) ? gap / 2 : 0.5;
    const boxgap = layout.boxgap === undefined ? BOX_GAP : Number(layout.boxgap);
    const groupgap = layout.boxgroupgap === undefined ? BOX_GROUP_GAP : Number(layout.boxgroupgap);
    const bdPos = dPos * (1 - boxgap) * (1 - groupgap);
    const ww = tr.whiskerwidth === undefined ? 0.5 : Number(tr.whiskerwidth);
    ft._boxes = boxes;
    ft._dPos = dPos;
    ft._bdPos = bdPos;
    ft._wdPos = bdPos * ww;
  }

  function buildBars(ft, xa, ya, layout) {
    const tr = ft._input;
    const horiz = ft._horiz;
    const pa = horiz ? ya : xa;
    const sa = horiz ? xa : ya;
    const posRaw = decode(horiz ? tr.y : tr.x);
    const sizeRaw = decode(horiz ? tr.x : tr.y);
    const baseRaw = tr.base === undefined ? null : decode(tr.base);
    const scalarBase = tr.base !== undefined && !baseRaw ? tr.base : undefined;
    const bars = [];
    if (posRaw && sizeRaw && pa && sa) {
      const pos = axisValues(pa, posRaw).v;
      const base = baseRaw ? axisValues(sa, baseRaw).v : null;
      const b0s = scalarBase !== undefined ? sa.d2c(scalarBase) : 0;
      const n = Math.min(pos.length, sizeRaw.length);
      for (let i = 0; i < n; i++) {
        const p = pos[i];
        const size = numOf(sizeRaw[i]);
        const b0 = base ? base[i] : b0s;
        if (!isFinite(p) || !isFinite(size) || !isFinite(b0)) continue;
        bars.push({ i: i, p: p, b0: b0, b1: b0 + size });
      }
    }
    const sorted = bars.map((b) => b.p).sort((a, b) => a - b);
    let gap = Infinity;
    for (let i = 1; i < sorted.length; i++) {
      const d = sorted[i] - sorted[i - 1];
      if (d > 0 && d < gap) gap = d;
    }
    const dPos = isFinite(gap) ? gap : 1;
    const bargap = layout.bargap === undefined ? 0.2 : Number(layout.bargap);
    const dflt = dPos * (1 - bargap);
    const wRaw = tr.width;
    const wArr = decode(wRaw);
    for (const b of bars) {
      const w = wArr ? numOf(wArr[b.i]) : wRaw !== undefined ? numOf(wRaw) : dflt;
      b.w = isFinite(w) ? w : dflt;
    }
    ft._bars = bars;
    ft._pa = pa;
    ft._sa = sa;
  }

  function cellEdges(vals, ax) {
    const n = vals.length;
    const out = new Float64Array(n + 1);
    if (!n) return out;
    if (ax && ax.type === "category") {
      for (let i = 0; i < n; i++) out[i] = vals[i] - 0.5;
      out[n] = vals[n - 1] + 0.5;
      return out;
    }
    if (n === 1) {
      out[0] = vals[0] - 0.5;
      out[1] = vals[0] + 0.5;
      return out;
    }
    out[0] = vals[0] - (vals[1] - vals[0]) / 2;
    for (let i = 1; i < n; i++) out[i] = (vals[i - 1] + vals[i]) / 2;
    out[n] = vals[n - 1] + (vals[n - 1] - vals[n - 2]) / 2;
    return out;
  }

  function parseColor(c) {
    const s = String(c || "").trim();
    let m = /^#([0-9a-f]{3})$/i.exec(s);
    if (m) {
      const h = m[1];
      return [parseInt(h[0] + h[0], 16), parseInt(h[1] + h[1], 16), parseInt(h[2] + h[2], 16), 1];
    }
    m = /^#([0-9a-f]{6})$/i.exec(s);
    if (m) {
      const h = m[1];
      return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 1];
    }
    m = /^rgba?\(([^)]+)\)$/i.exec(s);
    if (m) {
      const p = m[1].split(",").map((v) => Number(v.trim()));
      return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
    }
    if (s === "white") return [255, 255, 255, 1];
    if (s === "black") return [0, 0, 0, 1];
    return [68, 68, 68, 1];
  }

  const DEFAULT_SCALE = [[0, "#f4f4f4"], [0.5, "#898785"], [1, "#2d2d2d"]];

  function scaleStops(cs) {
    const list = Array.isArray(cs) && cs.length >= 2 ? cs : DEFAULT_SCALE;
    return list.map((st) => ({ v: Number(st[0]), c: parseColor(st[1]) }));
  }

  function scaleColor(stops, t) {
    const x = Math.max(0, Math.min(1, t));
    let k = 1;
    while (k < stops.length - 1 && stops[k].v < x) k++;
    const a = stops[k - 1];
    const b = stops[k];
    const f = b.v > a.v ? (x - a.v) / (b.v - a.v) : 0;
    const r = Math.round(a.c[0] + (b.c[0] - a.c[0]) * f);
    const g = Math.round(a.c[1] + (b.c[1] - a.c[1]) * f);
    const bl = Math.round(a.c[2] + (b.c[2] - a.c[2]) * f);
    return [r, g, bl];
  }

  function buildHeat(ft, xa, ya) {
    const tr = ft._input;
    const zRaw = Array.isArray(tr.z) ? tr.z : [];
    const rows = zRaw.map((r) => decode(r) || []);
    const ny = rows.length;
    let nx = 0;
    for (const r of rows) nx = Math.max(nx, r.length);
    const xRaw = decode(tr.x);
    const yRaw = decode(tr.y);
    const xs = xRaw && xa ? axisValues(xa, xRaw).v : Float64Array.from({ length: nx }, (_, i) => i);
    const ys = yRaw && ya ? axisValues(ya, yRaw).v : Float64Array.from({ length: ny }, (_, i) => i);
    let zmin = Number(tr.zmin);
    let zmax = Number(tr.zmax);
    if (!isFinite(zmin) || !isFinite(zmax)) {
      let lo = Infinity;
      let hi = -Infinity;
      for (const r of rows) {
        for (let j = 0; j < r.length; j++) {
          const v = numOf(r[j]);
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
      }
      if (!isFinite(zmin)) zmin = lo;
      if (!isFinite(zmax)) zmax = hi;
    }
    ft._z = rows;
    ft._hx = xs;
    ft._hy = ys;
    ft._xe = cellEdges(xs, xa);
    ft._ye = cellEdges(ys, ya);
    ft._zmin = zmin;
    ft._zmax = zmax;
    ft._stops = scaleStops(tr.colorscale);
    ft._showscale = tr.showscale !== false;
  }

  function computeLayout(gd) {
    let push = { l: 0, t: 0, b: 0, r: 0 };
    let fl = null;
    for (let pass = 0; pass < 6; pass++) {
      fl = buildFull(gd, push);
      const need = labelPush(fl, gd._wxLiteState);
      const next = {
        l: Math.max(push.l, need.l),
        t: Math.max(push.t, need.t),
        b: need.b,
        r: need.r,
      };
      if (next.l === push.l && next.t === push.t && next.b === push.b && next.r === push.r) break;
      if (pass > 0 && need.l <= fl._size.l && need.t <= fl._size.t && need.b <= fl._size.b && need.r <= fl._size.r &&
        next.b >= push.b && next.r >= push.r) break;
      push = next;
    }
    return fl;
  }

  function tickFontOf(ax, fl) {
    const size = Number(ax.tickfont.size) || fl.font.size;
    return {
      size: size,
      family: ax.tickfont.family || fl.font.family,
      css: cssFont(size, ax.tickfont.family || fl.font.family),
      color: ax.tickfont.color || fl.font.color,
    };
  }

  function titleFontOf(ax, fl) {
    const f = ax.titleFont || {};
    const size = Number(f.size) || Math.round(1.2 * fl.font.size);
    return {
      size: size,
      css: cssFont(size, f.family || fl.font.family),
      color: f.color || fl.font.color,
    };
  }

  function tickLabelText(ax, i) {
    const t = ax._tickText ? ax._tickText[i] : String(ax._tickVals[i]);
    return typeof t === "string" && t.indexOf("\n") >= 0 ? t.replace(/\r?\n/g, " ") : t;
  }

  function xLabelBoxes(ax, fl, st) {
    const out = [];
    if (!ax.visible || !ax.showticklabels || !ax._tickVals || !ax._tickVals.length) return out;
    const anchor = st.byId.get(ax.anchor);
    const bottom = anchor ? anchor._offset + anchor._length : fl._size.t + fl._size.h;
    const tf = tickFontOf(ax, fl);
    const fs = tf.size;
    const ang = ax.tickangle;
    const rad = (ang * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const cy = bottom + XLABEL_GAP + fs / 2;
    for (let i = 0; i < ax._tickVals.length; i++) {
      const rel = ax.l2p(ax._tickVals[i]);
      if (rel < -0.5 || rel > ax._length + 0.5) continue;
      const x = ax._offset + rel;
      const text = tickLabelText(ax, i);
      const sz = richSize(text, fs, tf.family);
      const w = sz.w;
      const x0 = ang > 0 ? 0 : ang < 0 ? -w : -w / 2;
      const x1 = x0 + w;
      const y0 = fs / 2 - TEXT_ASCENT * fs;
      const y1 = fs / 2 + (sz.lines - 1) * LINE_SPACING * fs + TEXT_DESCENT * fs;
      let minX = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const [lx, ly] of [[x0, y0], [x1, y0], [x0, y1], [x1, y1]]) {
        const rx = x + lx * cos - ly * sin;
        const ry = cy + lx * sin + ly * cos;
        if (rx < minX) minX = rx;
        if (rx > maxX) maxX = rx;
        if (ry > maxY) maxY = ry;
      }
      out.push({ x: x, cy: cy, text: text, minX: minX, maxX: maxX, maxY: maxY, fs: fs });
    }
    return out;
  }

  function yLabelDepth(ax, fl) {
    if (!ax.visible || !ax.showticklabels || !ax._tickVals || !ax._tickVals.length) return 0;
    const tf = tickFontOf(ax, fl);
    let w = 0;
    for (let i = 0; i < ax._tickVals.length; i++) {
      w = Math.max(w, richSize(tickLabelText(ax, i), tf.size, tf.family).w);
    }
    return w + LABEL_GAP;
  }

  function hasTitle(ax) {
    return ax.visible && ax.titleText !== undefined && ax.titleText !== null && String(ax.titleText) !== "";
  }

  function reservesTitle(ax) {
    return ax.visible && ax.titleText !== undefined && ax.titleText !== null;
  }

  function axisTitlePos(ax, fl, st) {
    if (!hasTitle(ax)) return null;
    const tf = titleFontOf(ax, fl);
    const standoff = ax.titleStandoff === undefined ? TITLE_STANDOFF : ax.titleStandoff;
    const anchor = st.byId.get(ax.anchor);
    if (ax._letter === "y") {
      const left = anchor ? anchor._offset : fl._size.l;
      const depth = yLabelDepth(ax, fl);
      const x = left - depth - standoff - TITLE_DESCENT * tf.size;
      return { x: x, y: ax._offset + ax._length / 2, font: tf, left: x - TITLE_ASCENT * tf.size };
    }
    const bottom = anchor ? anchor._offset + anchor._length : fl._size.t + fl._size.h;
    let depth = 0;
    for (const b of xLabelBoxes(ax, fl, st)) depth = Math.max(depth, b.maxY - bottom);
    const y = bottom + depth + standoff + CAP_SHIFT * tf.size;
    return { x: ax._offset + ax._length / 2, y: y, font: tf, bottom: y + TITLE_DESCENT * tf.size };
  }

  function labelPush(fl, st) {
    const out = { l: 0, t: 0, b: 0, r: 0 };
    const size = fl._size;
    for (const ax of fl._axes) {
      if (ax._letter !== "y" || !ax.visible) continue;
      const anchor = st.byId.get(ax.anchor);
      const lead = anchor ? anchor.domain[0] * size.w : 0;
      const vals = ax._tickVals;
      if (ax.showticklabels && vals && vals.length && ax.automargin) {
        const fs = Number(ax.tickfont.size) || fl.font.size;
        const xpos = anchor ? anchor._offset : size.l;
        const font = cssFont(fs, ax.tickfont.family || fl.font.family);
        const top = ax._offset;
        const bottom = ax._offset + ax._length;
        for (let i = 0; i < vals.length; i++) {
          const py = ax._offset + ax.l2p(vals[i]);
          if (marginAllows(ax, "bottom")) {
            out.b = Math.max(out.b, Math.max(0, py + LABEL_BELOW * fs - bottom) + AUTO_PAD);
          }
          if (marginAllows(ax, "top")) {
            out.t = Math.max(out.t, Math.max(0, top - (py - LABEL_ABOVE * fs)) + AUTO_PAD);
          }
          if (marginAllows(ax, "left")) {
            const text = tickLabelText(ax, i);
            const tw = isPlain(text) ? textWidth(text, font) : richSize(text, fs, ax.tickfont.family || fl.font.family).w;
            out.l = Math.max(out.l, LABEL_GAP + tw + PAPER_PAD - lead);
          }
        }
      }
      if (marginAllows(ax, "left") && reservesTitle(ax)) {
        const tf = titleFontOf(ax, fl);
        const standoff = ax.titleStandoff === undefined ? TITLE_STANDOFF : ax.titleStandoff;
        const need = yLabelDepth(ax, fl) + standoff + CAP_SHIFT * tf.size + PAPER_PAD;
        out.l = Math.max(out.l, need - lead);
      }
    }
    for (const ax of fl._axes) {
      if (ax._letter !== "x" || !ax.visible || !ax.automargin) continue;
      const anchor = st.byId.get(ax.anchor);
      const bottom = anchor ? anchor._offset + anchor._length : size.t + size.h;
      const lead = ax.domain[0] * size.w;
      const trail = (1 - ax.domain[1]) * size.w;
      const plotRight = size.l + size.w;
      for (const b of xLabelBoxes(ax, fl, st)) {
        if (marginAllows(ax, "bottom")) out.b = Math.max(out.b, b.maxY - bottom + XLABEL_PAD);
        if (marginAllows(ax, "right")) out.r = Math.max(out.r, b.maxX - plotRight + XLABEL_PAD - trail);
        if (marginAllows(ax, "left")) out.l = Math.max(out.l, size.l - b.minX + XLABEL_PAD - lead);
      }
      if (marginAllows(ax, "bottom") && reservesTitle(ax)) {
        const tf = titleFontOf(ax, fl);
        const standoff = ax.titleStandoff === undefined ? TITLE_STANDOFF : ax.titleStandoff;
        let depth = 0;
        for (const b of xLabelBoxes(ax, fl, st)) depth = Math.max(depth, b.maxY - bottom);
        out.b = Math.max(out.b, depth + standoff + CAP_SHIFT * tf.size + PAPER_PAD);
      }
    }
    const W = fl.width;
    const H = fl.height;
    const lgd = legendGeom(fl);
    if (lgd) {
      const cR = lgd.xanchor === "left" ? lgd.width : lgd.xanchor === "right" ? 0 : lgd.width / 2;
      if (lgd.left + lgd.width > W - PAPER_PAD && lgd.lx > 0) {
        out.r = Math.max(out.r, W - size.l - (W - PAPER_PAD - size.l - cR) / lgd.lx);
      }
      const cB = lgd.yanchor === "top" ? lgd.height : lgd.yanchor === "bottom" ? 0 : lgd.height / 2;
      if (lgd.top + lgd.height > H - PAPER_PAD && 1 - lgd.ly > 0) {
        out.b = Math.max(out.b, H - size.t - (H - PAPER_PAD - size.t - cB) / (1 - lgd.ly));
      }
    }
    for (const ft of st.fullData || []) {
      const g = colorbarGeom(ft, fl);
      if (!g) continue;
      const cR = g.xanchor === "left" ? g.width : g.xanchor === "right" ? 0 : g.width / 2;
      if (g.left + g.width > W - PAPER_PAD && g.xv > 0) {
        out.r = Math.max(out.r, W - size.l - (W - PAPER_PAD - size.l - cR) / g.xv);
      }
    }
    out.l = Math.round(out.l);
    out.t = Math.round(out.t);
    out.b = Math.round(out.b);
    out.r = Math.round(out.r);
    return out;
  }

  function buildFull(gd, push) {
    const st = liteState(gd);
    const layout = gd.layout || (gd.layout = {});
    const data = gd.data || (gd.data = []);
    const prev = gd._fullLayout;
    let width = Number(layout.width) || 0;
    let height = Number(layout.height) || 0;
    if (!width) width = Math.round(gd.clientWidth) || (prev && prev.width) || 700;
    if (!height) {
      height = Math.round(gd.clientHeight) || parseFloat(gd.style.height) || (prev && prev.height) || 450;
    }
    width = Math.max(10, width);
    height = Math.max(10, height);
    const m = Object.assign({ l: 80, r: 80, t: 100, b: 80, pad: 0, autoexpand: true }, layout.margin);
    let pushT = Number(m.t) || 0;
    const tpl = templateLayout(layout);
    const colorway = Array.isArray(layout.colorway) ? layout.colorway : Array.isArray(tpl.colorway) ? tpl.colorway : COLORWAY;
    const fullData = data.map((tr, i) => fullTrace(tr || {}, i, colorway));
    const font = Object.assign({ family: DEFAULT_FONT, size: 12, color: "#2d2d2d" }, tpl.font, layout.font);
    const fl = {
      _wxLite: true,
      width: width,
      height: height,
      autosize: layout.autosize,
      margin: m,
      font: font,
      paper_bgcolor: layout.paper_bgcolor || "#fff",
      plot_bgcolor: layout.plot_bgcolor || "#fff",
      hovermode: layout.hovermode === undefined ? "closest" : layout.hovermode,
      hoverdistance: layout.hoverdistance === undefined ? 20 : Number(layout.hoverdistance),
      hoverlabel: Object.assign({}, layout.hoverlabel),
      dragmode: layout.dragmode === undefined ? "zoom" : layout.dragmode,
      showlegend: layout.showlegend,
      legend: Object.assign({}, layout.legend),
      annotations: Array.isArray(layout.annotations) ? layout.annotations : [],
      title: layoutTitle(layout, tpl, font),
      shapes: Array.isArray(layout.shapes) ? layout.shapes : [],
      _size: null,
      _axes: [],
      _shapeLine: tpl.shapedefaults && tpl.shapedefaults.line && tpl.shapedefaults.line.color,
    };
    let legendRows = 0;
    const legendItems = legendEntries(fullData, layout);
    if (legendItems.length) {
      const cols = legendCols(fl.legend);
      legendRows = Math.ceil(legendItems.length / cols);
      const lh = legendRows * LEGEND_ROW + 2 * LEGEND_GAP;
      if (isTopLegend(fl.legend) && m.autoexpand !== false) {
        pushT = Math.max(pushT, lh + LEGEND_TOP_GAP);
      }
    }
    const autoExpand = m.autoexpand !== false;
    const l = autoExpand ? Math.max(Number(m.l) || 0, push.l) : Number(m.l) || 0;
    const r = autoExpand ? Math.max(Number(m.r) || 0, push.r || 0) : Number(m.r) || 0;
    const t = autoExpand ? Math.max(pushT, push.t) : pushT;
    const b = autoExpand ? Math.max(Number(m.b) || 0, push.b) : Number(m.b) || 0;
    const size = { l: l, r: r, t: t, b: b, p: Number(m.pad) || 0 };
    size.w = Math.max(1, width - l - r);
    size.h = Math.max(1, height - t - b);
    fl._size = size;

    const names = new Set();
    for (const key of Object.keys(layout)) if (/^[xy]axis\d*$/.test(key)) names.add(key);
    for (const ft of fullData) {
      names.add(axisKey(ft.xaxis, "x"));
      names.add(axisKey(ft.yaxis, "y"));
    }
    const axes = [];
    for (const name of names) {
      const letter = name.charAt(0);
      let input = layout[name];
      if (!input || typeof input !== "object") {
        input = {};
        layout[name] = input;
      }
      const tpl = templateLayout(layout);
      const tplAxis = tpl[letter + "axis"] || {};
      const merged = Object.assign({}, tplAxis, input);
      const tTitle = tplAxis.title && typeof tplAxis.title === "object" ? tplAxis.title : {};
      const iTitle = input.title && typeof input.title === "object"
        ? input.title
        : input.title !== undefined && input.title !== null ? { text: input.title } : {};
      merged.title = Object.assign({}, tTitle, iTitle);
      merged.title.font = Object.assign({}, tTitle.font, iTitle.font);
      const ax = new Axis(name, merged, letter);
      ax._input = input;
      ax.type = guessType(input, data, ax._id, letter);
      if (!input.type) input.type = ax.type;
      if (ax.type === "category") buildCategories(ax, data);
      if (letter === "x") {
        ax._offset = size.l + ax.domain[0] * size.w;
        ax._length = (ax.domain[1] - ax.domain[0]) * size.w;
      } else {
        ax._offset = size.t + (1 - ax.domain[1]) * size.h;
        ax._length = (ax.domain[1] - ax.domain[0]) * size.h;
      }
      fl[name] = ax;
      axes.push(ax);
    }
    fl._axes = axes;
    const byId = new Map(axes.map((a) => [a._id, a]));

    for (const ft of fullData) {
      const xa = byId.get(ft.xaxis);
      const ya = byId.get(ft.yaxis);
      ft._xa = xa;
      ft._ya = ya;
      if (ft._box) {
        ft._xs = new Float64Array(0);
        ft._ys = new Float64Array(0);
        ft._len = 0;
        buildBoxes(ft, xa, layout);
        continue;
      }
      if (ft._bar) {
        ft._xs = new Float64Array(0);
        ft._ys = new Float64Array(0);
        ft._len = 0;
        buildBars(ft, xa, ya, layout);
        continue;
      }
      if (ft._heat) {
        ft._xs = new Float64Array(0);
        ft._ys = new Float64Array(0);
        ft._len = 0;
        buildHeat(ft, xa, ya);
        continue;
      }
      const xt = axisValues(xa, ft._input.x);
      const yt = axisValues(ya, ft._input.y);
      ft._xs = xt ? xt.v : new Float64Array(0);
      ft._ys = yt ? yt.v : new Float64Array(0);
      ft._xSorted = xt ? xt.sorted : true;
      ft._len = Math.min(ft._xs.length, ft._ys.length);
    }

    for (const ft of fullData) {
      const horiz = ft.type === "bar" && ft._input.orientation === "h";
      if (ft.type !== "bar" && !ft._box) continue;
      const pa = horiz ? ft._ya : ft._xa;
      if (!pa) continue;
      if (!pa._explicitGrid) pa.showgrid = false;
      if (!pa._explicitZero) pa.zeroline = false;
    }

    const groups = new Map();
    for (const ax of axes) {
      const lead = ax.matches && byId.has(ax.matches) ? ax.matches : ax._id;
      if (!groups.has(lead)) groups.set(lead, []);
      groups.get(lead).push(ax);
    }
    for (const [lead, members] of groups) {
      const master = byId.get(lead);
      const ordered = [master].concat(members.filter((a) => a !== master));
      let explicit = null;
      for (const ax of ordered) {
        const inp = ax._input;
        if (inp.autorange === true || inp.autorange === "reversed") continue;
        if (Array.isArray(inp.range) && inp.range.length === 2) {
          const r0 = ax.r2l(inp.range[0]);
          const r1 = ax.r2l(inp.range[1]);
          if (isFinite(r0) && isFinite(r1) && r0 !== r1) {
            explicit = [r0, r1];
            break;
          }
        }
      }
      let rl = explicit;
      let auto = false;
      if (!rl) {
        rl = autoRange(ordered, fullData, master._length || 1);
        if (master._input.autorange === "reversed") rl = [rl[1], rl[0]];
        auto = true;
      }
      for (const ax of ordered) {
        ax._rl = [rl[0], rl[1]];
        ax.range = [ax.l2r(rl[0]), ax.l2r(rl[1])];
        ax.autorange = auto;
        const span = rl[1] - rl[0];
        if (ax._letter === "x") {
          ax._m = ax._length / span;
          ax._b = -ax._m * rl[0];
        } else {
          ax._m = -ax._length / span;
          ax._b = -ax._m * rl[1];
        }
        if (auto) {
          ax._input.range = ax.range.slice();
          if (ax._input.autorange !== "reversed") ax._input.autorange = true;
        }
      }
    }

    for (const ax of axes) {
      if (!ax.visible) continue;
      if (ax.type === "category" && !Array.isArray(ax.tickvals)) {
        const tk = (ax.showgrid || ax.showticklabels) ? categoryTicks(ax, Number(ax.tickfont.size) || font.size) : { vals: [], text: [] };
        ax._tickVals = tk.vals;
        ax._tickText = tk.text;
      } else if (ax.type === "date") {
        const vals = (ax.showgrid || ax.showticklabels) ? dateTicks(ax) : [];
        ax._tickVals = vals;
        ax._tickText = ax.showticklabels && ax._letter === "x" ? dateTickText(ax, vals) : null;
      } else {
        const tk = (ax.showgrid || ax.showticklabels) ? linearTicks(ax) : { vals: [], text: [] };
        ax._tickVals = tk.vals;
        ax._tickText = tk.text;
      }
    }

    fl._legendItems = legendItems;
    fl._legendRows = legendRows;
    st.fullData = fullData;
    gd._fullLayout = fl;
    gd._fullData = fullData;
    gd.calcdata = fullData.map((ft) => (ft._box ? ft._boxes.map((b) => ({
      x: b.pos,
      pos: b.pos,
      q1: b.q1,
      med: b.med,
      q3: b.q3,
      lf: b.lf,
      uf: b.uf,
      min: b.lf,
      max: b.uf,
    })) : []));
    st.byId = byId;
    return fl;
  }

  function layoutTitle(layout, tpl, font) {
    const raw = layout.title;
    const own = raw && typeof raw === "object" ? raw : raw !== undefined && raw !== null ? { text: raw } : {};
    const base = tpl.title && typeof tpl.title === "object" ? tpl.title : {};
    const t = Object.assign({}, base, own);
    t.font = Object.assign({}, font, base.font, own.font);
    t.font.size = (own.font && own.font.size) || (base.font && base.font.size) || font.size * 1.4;
    return t;
  }

  function isTopLegend(lg) {
    const y = lg.y === undefined ? 1 : Number(lg.y);
    return y >= 1 && (lg.yanchor === "bottom" || y > 1);
  }

  function legendCols(lg) {
    if (lg.orientation !== "h") return 1;
    if (lg.entrywidthmode === "fraction" && Number(lg.entrywidth) > 0) {
      return Math.max(1, Math.floor(1 / Number(lg.entrywidth) + 1e-9));
    }
    return 5;
  }

  function legendEntries(fullData, layout) {
    const shown = fullData.filter((ft) => ft.showlegend && ft.visible !== false && !ft._heat);
    const grouped = shown.some((ft) => ft.legendgroup);
    const want = layout.showlegend === undefined ? shown.length > (grouped ? 0 : 1) : !!layout.showlegend;
    if (!want) return [];
    const seen = new Set();
    const items = [];
    shown.forEach((ft) => {
      const g = ft.legendgroup;
      if (g && seen.has(g)) return;
      if (g) seen.add(g);
      items.push(ft);
    });
    items.sort((a, b) => a.legendrank - b.legendrank || a.index - b.index);
    return items;
  }

  function legendGeom(fl) {
    const items = fl._legendItems;
    if (!items || !items.length || isTopLegend(fl.legend)) return null;
    const size = fl._size;
    const lg = fl.legend;
    const f = Object.assign({}, fl.font, lg.font);
    const fs = Number(f.size) || 12;
    const fam = f.family || fl.font.family;
    const font = cssFont(fs, fam);
    const horiz = lg.orientation === "h";
    const gap = lg.tracegroupgap === undefined ? 10 : Number(lg.tracegroupgap);
    const fraction = lg.entrywidthmode === "fraction" && Number(lg.entrywidth) > 0;
    const brk = (a, b) => !!(a.legendgroup || b.legendgroup) && a.legendgroup !== b.legendgroup;
    const entries = [];
    let y = LEGEND_GAP;
    let maxW = 0;
    if (!horiz || fraction) {
      const colW = fraction ? Number(lg.entrywidth) * size.w : 0;
      const cols = horiz && fraction ? Math.max(1, Math.floor(1 / Number(lg.entrywidth) + 1e-9)) : 1;
      let textMax = 0;
      for (const ft of items) textMax = Math.max(textMax, textWidth(String(ft.name), font));
      let col = 0;
      items.forEach((ft, i) => {
        const w = fraction ? colW : 40 + textMax;
        if (i > 0) {
          if (col + 1 < cols) col++;
          else {
            col = 0;
            y += LEGEND_ROW + (brk(items[i - 1], ft) ? gap : 0);
          }
        }
        entries.push({ ft: ft, x: col * colW, y: y + LEGEND_ROW / 2, w: w });
        maxW = Math.max(maxW, col * colW + w);
      });
    } else {
      let x = 0;
      items.forEach((ft, i) => {
        const w = 40 + textWidth(String(ft.name), font) + 10;
        if (i > 0 && x + w > size.w) {
          x = 0;
          y += LEGEND_ROW + (brk(items[i - 1], ft) ? gap : 0);
        }
        entries.push({ ft: ft, x: x, y: y + LEGEND_ROW / 2, w: w });
        x += w;
        maxW = Math.max(maxW, x);
      });
    }
    y += LEGEND_ROW;
    const width = Math.ceil(maxW + LEGEND_PAD_W);
    const height = y + LEGEND_GAP;
    const lx = lg.x === undefined ? (horiz ? 0 : 1.02) : Number(lg.x);
    const ly = lg.y === undefined ? (horiz ? -0.1 : 1) : Number(lg.y);
    const xanchor = lg.xanchor && lg.xanchor !== "auto" ? lg.xanchor : "left";
    const yanchor = lg.yanchor && lg.yanchor !== "auto"
      ? lg.yanchor
      : ly >= 2 / 3 ? "top" : ly <= 1 / 3 ? "bottom" : "middle";
    const px = size.l + lx * size.w;
    const py = size.t + (1 - ly) * size.h;
    const left = xanchor === "left" ? px : xanchor === "right" ? px - width : px - width / 2;
    const top = yanchor === "top" ? py : yanchor === "bottom" ? py - height : py - height / 2;
    return {
      left: left, top: top, width: width, height: height, entries: entries,
      fs: fs, fam: fam, color: f.color, lx: lx, ly: ly, xanchor: xanchor, yanchor: yanchor,
    };
  }

  function colorbarGeom(ft, fl) {
    if (!ft._heat || !ft._showscale || ft.visible !== true) return null;
    const cb = Object.assign({}, ft._input.colorbar);
    const size = fl._size;
    const thick = cb.thicknessmode === "fraction"
      ? Number(cb.thickness) * size.w
      : cb.thickness === undefined ? 30 : Number(cb.thickness);
    const lenV = cb.len === undefined ? 1 : Number(cb.len);
    const L = cb.lenmode === "pixels" ? lenV : lenV * size.h;
    const xv = cb.x === undefined ? 1.02 : Number(cb.x);
    const yv = cb.y === undefined ? 0.5 : Number(cb.y);
    const xanchor = cb.xanchor || "left";
    const yanchor = cb.yanchor || "middle";
    const xpad = cb.xpad === undefined ? 10 : Number(cb.xpad);
    const ypad = cb.ypad === undefined ? 10 : Number(cb.ypad);
    const title = cb.title && typeof cb.title === "object" ? cb.title : cb.title !== undefined ? { text: cb.title } : {};
    const tfont = Object.assign({}, fl.font, title.font);
    const tfs = Number(title.font && title.font.size) || Math.round(1.2 * fl.font.size);
    const hasTitle = title.text !== undefined && title.text !== null && String(title.text) !== "";
    const titleLines = hasTitle ? richRuns(title.text).length : 0;
    const titleH = hasTitle ? titleLines * LINE_SPACING * tfs + CB_TITLE_GAP : 0;
    const kfont = Object.assign({}, fl.font, cb.tickfont);
    const kfs = Number(kfont.size) || fl.font.size;
    const kcss = cssFont(kfs, kfont.family || fl.font.family);
    const zmin = ft._zmin;
    const zmax = ft._zmax;
    let vals;
    let texts;
    if (Array.isArray(cb.tickvals)) {
      vals = cb.tickvals.map(Number).filter((v) => isFinite(v) && v >= Math.min(zmin, zmax) - 1e-9 && v <= Math.max(zmin, zmax) + 1e-9);
      texts = vals.map((v) => {
        const k = cb.tickvals.map(Number).indexOf(v);
        return Array.isArray(cb.ticktext) && cb.ticktext[k] !== undefined ? String(cb.ticktext[k]) : formatLinear(v, 0, 0);
      });
    } else {
      const fake = { _rl: [zmin, zmax], _length: L, _letter: "y", nticks: Number(cb.nticks) || 0, d2c: numOf };
      const tk = linearTicks(fake);
      vals = tk.vals;
      texts = tk.text;
    }
    let tw = 0;
    for (const t of texts) tw = Math.max(tw, textWidth(t, kcss));
    const width = xpad + thick + CB_TICK_GAP + tw + xpad;
    const px = size.l + xv * size.w;
    const py = size.t + (1 - yv) * size.h;
    const left = xanchor === "left" ? px : xanchor === "right" ? px - width : px - width / 2;
    const top = yanchor === "top" ? py : yanchor === "bottom" ? py - L : py - L / 2;
    const barTop = top + ypad + titleH;
    const barBot = top + L - ypad;
    return {
      ft: ft, left: left, top: top, width: width, height: L, xv: xv, xanchor: xanchor,
      barLeft: left + xpad, barTop: barTop, barBot: barBot, thick: thick,
      vals: vals, texts: texts, kfs: kfs, kfam: kfont.family || fl.font.family, kcolor: kfont.color || fl.font.color,
      title: hasTitle ? String(title.text) : "", tfs: tfs, tfam: tfont.family || fl.font.family, tcolor: tfont.color || fl.font.color,
      titleTop: top + ypad,
    };
  }

  function drawColorbars(ctx, gd, fl) {
    for (const ft of gd._fullData) {
      const g = colorbarGeom(ft, fl);
      if (!g || !(g.barBot > g.barTop)) continue;
      const grad = ctx.createLinearGradient(0, g.barBot, 0, g.barTop);
      for (const st of ft._stops) {
        grad.addColorStop(Math.max(0, Math.min(1, st.v)), "rgb(" + st.c[0] + "," + st.c[1] + "," + st.c[2] + ")");
      }
      ctx.fillStyle = grad;
      ctx.fillRect(g.barLeft, g.barTop, g.thick, g.barBot - g.barTop);
      const span = ft._zmax - ft._zmin;
      ctx.font = cssFont(g.kfs, g.kfam);
      ctx.fillStyle = g.kcolor;
      ctx.textAlign = "left";
      ctx.textBaseline = "alphabetic";
      g.vals.forEach((v, i) => {
        const f = span > 0 ? (v - ft._zmin) / span : 0;
        const y = g.barBot - f * (g.barBot - g.barTop);
        ctx.fillText(g.texts[i], g.barLeft + g.thick + CB_TICK_GAP, y + MID_SHIFT * g.kfs);
      });
      if (g.title) drawRich(ctx, g.title, g.barLeft, g.titleTop + TEXT_ASCENT * g.tfs, "left", g.tfs, g.tfam, g.tcolor, 0);
    }
  }

  function schedulePaint(gd) {
    const st = gd._wxLiteState;
    if (!st || st.raf) return;
    st.raf = requestAnimationFrame(() => {
      st.raf = 0;
      paint(gd);
    });
  }

  function paintNow(gd) {
    const st = gd._wxLiteState;
    if (!st) return;
    if (st.raf) {
      cancelAnimationFrame(st.raf);
      st.raf = 0;
    }
    paint(gd);
  }

  function paint(gd) {
    const st = gd._wxLiteState;
    const fl = gd._fullLayout;
    if (!st || !fl || !fl._wxLite) return;
    if (!gd.isConnected || !gd.clientWidth) {
      st.stale = true;
      return;
    }
    st.stale = false;
    st.painted = true;
    const W = fl.width;
    const H = fl.height;
    const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    const cv = st.canvas;
    const pw = Math.round(W * dpr);
    const ph = Math.round(H * dpr);
    if (cv.width !== pw) cv.width = pw;
    if (cv.height !== ph) cv.height = ph;
    cv.style.width = W + "px";
    cv.style.height = H + "px";
    const ctx = cv.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = fl.paper_bgcolor;
    ctx.fillRect(0, 0, W, H);
    if (fl.plot_bgcolor && !/rgba\([^)]*,\s*0\s*\)$/.test(fl.plot_bgcolor) && fl.plot_bgcolor !== "transparent") {
      for (const xa of fl._axes) {
        if (xa._letter !== "x" || !xa.visible) continue;
        const ya = st.byId.get(xa.anchor);
        if (!ya || !ya.visible) continue;
        ctx.fillStyle = fl.plot_bgcolor;
        ctx.fillRect(xa._offset, ya._offset, xa._length, ya._length);
      }
    }
    drawShapes(ctx, fl, st, "below");
    drawGrids(ctx, fl, st);
    drawTraces(ctx, gd, fl, st);
    drawShapes(ctx, fl, st, "above");
    drawColorbars(ctx, gd, fl);
    drawTickLabels(ctx, fl, st);
    drawXTickLabels(ctx, fl, st);
    drawAxisTitles(ctx, fl, st);
    drawLayoutTitle(ctx, fl);
  }

  function shapeX(fl, st, ref, v) {
    const size = fl._size;
    if (!ref || ref === "paper") return size.l + Number(v) * size.w;
    const m = /^(x\d*)( domain)?$/.exec(ref);
    const ax = m && st.byId.get(m[1]);
    if (!ax) return NaN;
    if (m[2]) return ax._offset + Number(v) * ax._length;
    return ax._offset + ax.l2p(ax.d2c(v));
  }

  function shapeY(fl, st, ref, v) {
    const size = fl._size;
    if (!ref || ref === "paper") return size.t + (1 - Number(v)) * size.h;
    const m = /^(y\d*)( domain)?$/.exec(ref);
    const ax = m && st.byId.get(m[1]);
    if (!ax) return NaN;
    if (m[2]) return ax._offset + (1 - Number(v)) * ax._length;
    return ax._offset + ax.l2p(ax.d2c(v));
  }

  function shapeClip(fl, st, sh) {
    const xm = /^(x\d*)/.exec(sh.xref || "");
    const ym = /^(y\d*)/.exec(sh.yref || "");
    const xa = xm && st.byId.get(xm[1]);
    const ya = ym && st.byId.get(ym[1]);
    if (!xa && !ya) return null;
    const size = fl._size;
    const x0 = xa ? xa._offset : size.l;
    const w = xa ? xa._length : size.w;
    let y0 = ya ? ya._offset : size.t;
    let h = ya ? ya._length : size.h;
    if (xa && !ya) {
      const anchor = st.byId.get(xa.anchor);
      if (anchor) {
        y0 = anchor._offset;
        h = anchor._length;
      }
    }
    return [x0, y0, w, h];
  }

  function drawShapes(ctx, fl, st, layer) {
    for (const sh of fl.shapes) {
      if (!sh || sh.visible === false) continue;
      const lay = sh.layer === "below" ? "below" : "above";
      if (lay !== layer) continue;
      const type = sh.type || "rect";
      const x0 = shapeX(fl, st, sh.xref, sh.x0);
      const x1 = shapeX(fl, st, sh.xref, sh.x1);
      const y0 = shapeY(fl, st, sh.yref, sh.y0);
      const y1 = shapeY(fl, st, sh.yref, sh.y1);
      if (![x0, x1, y0, y1].every(isFinite)) continue;
      const line = Object.assign({ width: 2, color: fl._shapeLine || "#2d2d2d", dash: "solid" }, sh.line);
      const clip = shapeClip(fl, st, sh);
      ctx.save();
      if (sh.opacity !== undefined) ctx.globalAlpha = Number(sh.opacity);
      if (clip) {
        ctx.beginPath();
        ctx.rect(clip[0], clip[1], clip[2], clip[3]);
        ctx.clip();
      }
      if (type === "rect") {
        const left = Math.min(x0, x1);
        const top = Math.min(y0, y1);
        const w = Math.abs(x1 - x0);
        const h = Math.abs(y1 - y0);
        if (sh.fillcolor) {
          ctx.fillStyle = sh.fillcolor;
          ctx.fillRect(left, top, w, h);
        }
        if (Number(line.width) > 0 && line.color) {
          ctx.lineWidth = Number(line.width);
          ctx.strokeStyle = line.color;
          ctx.strokeRect(left, top, w, h);
        }
      } else if (type === "line") {
        if (Number(line.width) > 0 && line.color) {
          ctx.lineWidth = Number(line.width);
          ctx.strokeStyle = line.color;
          const dash = dashPattern(line.dash, Number(line.width));
          if (dash) ctx.setLineDash(dash);
          ctx.beginPath();
          ctx.moveTo(x0, y0);
          ctx.lineTo(x1, y1);
          ctx.stroke();
          ctx.setLineDash([]);
        }
      }
      ctx.restore();
    }
  }

  function dashPattern(dash, w) {
    const lw = w || 1;
    if (dash === "dot") return [lw * 1, lw * 2];
    if (dash === "dash") return [lw * 3, lw * 3];
    if (dash === "longdash") return [lw * 5, lw * 5];
    if (dash === "dashdot") return [lw * 3, lw * 2, lw, lw * 2];
    return null;
  }

  function crisp(v, w) {
    const r = Math.round(v);
    return Math.round(w) % 2 === 1 ? r + 0.5 : r;
  }

  function drawGrids(ctx, fl, st) {
    for (const ax of fl._axes) {
      if (!ax.visible || !ax.showgrid || !ax._tickVals || !ax._tickVals.length) continue;
      const other = st.byId.get(ax.anchor);
      if (!other) continue;
      const w = ax.gridwidth || 1;
      ctx.lineWidth = w;
      ctx.strokeStyle = ax.gridcolor;
      ctx.beginPath();
      for (const v of ax._tickVals) {
        const rel = ax.l2p(v);
        if (!(rel > 1 && rel < ax._length - 1)) continue;
        const p = ax._offset + rel;
        if (ax._letter === "x") {
          const x = crisp(p, w);
          ctx.moveTo(x, other._offset);
          ctx.lineTo(x, other._offset + other._length);
        } else {
          const y = crisp(p, w);
          ctx.moveTo(other._offset, y);
          ctx.lineTo(other._offset + other._length, y);
        }
      }
      ctx.stroke();
    }
    for (const ax of fl._axes) {
      if (!ax.visible || !ax.zeroline || ax.type !== "linear") continue;
      const other = st.byId.get(ax.anchor);
      if (!other) continue;
      const lo = Math.min(ax._rl[0], ax._rl[1]);
      const hi = Math.max(ax._rl[0], ax._rl[1]);
      if (!(0 >= lo && 0 <= hi)) continue;
      const w = ax.zerolinewidth || 1;
      const p = ax._offset + ax.l2p(0);
      ctx.lineWidth = w;
      ctx.strokeStyle = ax.zerolinecolor;
      ctx.beginPath();
      if (ax._letter === "x") {
        const x = crisp(p, w);
        ctx.moveTo(x, other._offset);
        ctx.lineTo(x, other._offset + other._length);
      } else {
        const y = crisp(p, w);
        ctx.moveTo(other._offset, y);
        ctx.lineTo(other._offset + other._length, y);
      }
      ctx.stroke();
    }
  }

  function subplotOrder(a, b) {
    const na = Number(a.slice(1)) || 1;
    const nb = Number(b.slice(1)) || 1;
    return na - nb;
  }

  function drawTraces(ctx, gd, fl, st) {
    const bySub = new Map();
    for (const ft of gd._fullData) {
      if (ft.visible !== true || !ft._xa || !ft._ya) continue;
      if (!ft._xa.visible && !ft._ya.visible) continue;
      const key = ft.xaxis;
      if (!bySub.has(key)) bySub.set(key, []);
      bySub.get(key).push(ft);
    }
    const keys = Array.from(bySub.keys()).sort(subplotOrder);
    for (const key of keys) {
      const list = bySub.get(key).slice().sort((a, b) => layerRank(a) - layerRank(b) || a.index - b.index);
      let prev = null;
      for (const ft of list) {
        drawTrace(ctx, ft, prev, fl);
        prev = ft;
      }
    }
  }

  function pixels(ft) {
    const xa = ft._xa;
    const ya = ft._ya;
    const n = ft._len;
    const px = new Float64Array(n);
    const py = new Float64Array(n);
    const xo = xa._offset;
    const yo = ya._offset;
    for (let i = 0; i < n; i++) {
      const x = ft._xs[i];
      const y = ft._ys[i];
      if (x !== x || y !== y) {
        px[i] = NaN;
        py[i] = NaN;
        continue;
      }
      px[i] = xo + xa._m * x + xa._b;
      py[i] = yo + ya._m * y + ya._b;
    }
    return { px: px, py: py };
  }

  function segments(px, py, connect) {
    const out = [];
    let cur = null;
    for (let i = 0; i < px.length; i++) {
      if (px[i] !== px[i]) {
        if (!connect && cur) {
          out.push(cur);
          cur = null;
        }
        continue;
      }
      if (!cur) cur = [];
      cur.push(i);
    }
    if (cur) out.push(cur);
    return out;
  }

  function clipRect(ctx, ft) {
    const xa = ft._xa;
    const ya = ft._ya;
    ctx.beginPath();
    ctx.rect(xa._offset, ya._offset, xa._length, ya._length);
    ctx.clip();
  }

  function drawBoxes(ctx, ft) {
    const boxes = ft._boxes;
    if (!boxes || !boxes.length) return;
    const xa = ft._xa;
    const ya = ft._ya;
    const half = Math.abs(xa._m) * ft._bdPos;
    const whisk = Math.abs(xa._m) * ft._wdPos;
    const yp = (v) => ya._offset + ya.l2p(v);
    ctx.save();
    ctx.globalAlpha = isFinite(ft.opacity) ? ft.opacity : 1;
    clipRect(ctx, ft);
    const lw = Number(ft.line.width);
    for (const b of boxes) {
      const xc = xa._offset + xa.l2p(b.pos);
      const x0 = xc - half;
      const x1 = xc + half;
      const yq1 = yp(b.q1);
      const yq3 = yp(b.q3);
      if (ft.fillcolor) {
        ctx.fillStyle = ft.fillcolor;
        ctx.fillRect(x0, Math.min(yq1, yq3), x1 - x0, Math.abs(yq3 - yq1));
      }
      if (lw > 0 && ft.line.color) {
        const ym = yp(b.med);
        const ylf = yp(b.lf);
        const yuf = yp(b.uf);
        ctx.lineWidth = lw;
        ctx.strokeStyle = ft.line.color;
        ctx.lineJoin = "miter";
        ctx.beginPath();
        ctx.moveTo(x0, ym);
        ctx.lineTo(x1, ym);
        ctx.moveTo(x0, yq1);
        ctx.lineTo(x1, yq1);
        ctx.lineTo(x1, yq3);
        ctx.lineTo(x0, yq3);
        ctx.closePath();
        ctx.moveTo(xc, yq1);
        ctx.lineTo(xc, ylf);
        ctx.moveTo(xc, yq3);
        ctx.lineTo(xc, yuf);
        ctx.moveTo(xc - whisk, ylf);
        ctx.lineTo(xc + whisk, ylf);
        ctx.moveTo(xc - whisk, yuf);
        ctx.lineTo(xc + whisk, yuf);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  function layerRank(ft) {
    if (ft._heat) return 0;
    if (ft._bar) return 1;
    if (ft._box) return 2;
    return 3;
  }

  function pixelOf(ax, v) {
    return ax._offset + ax.l2p(v);
  }

  function drawBars(ctx, ft) {
    const bars = ft._bars;
    if (!bars || !bars.length) return;
    const pa = ft._pa;
    const sa = ft._sa;
    const mk = ft.marker;
    const lw = Number(mk.line && mk.line.width) || 0;
    const lc = mk.line && mk.line.color;
    ctx.save();
    ctx.globalAlpha = isFinite(ft.opacity) ? ft.opacity : 1;
    clipRect(ctx, ft);
    for (const b of bars) {
      let s0 = pixelOf(sa, b.b0);
      let s1 = pixelOf(sa, b.b1);
      let p0 = pixelOf(pa, b.p - b.w / 2);
      let p1 = pixelOf(pa, b.p + b.w / 2);
      if (![s0, s1, p0, p1].every(isFinite)) continue;
      const odd = Math.round(lw) % 2 === 1 ? 0.5 : 0;
      s0 = Math.round(s0) + odd;
      s1 = Math.round(s1) + odd;
      p0 = Math.round(p0) + odd;
      p1 = Math.round(p1) + odd;
      const x0 = ft._horiz ? Math.min(s0, s1) : Math.min(p0, p1);
      const x1 = ft._horiz ? Math.max(s0, s1) : Math.max(p0, p1);
      const y0 = ft._horiz ? Math.min(p0, p1) : Math.min(s0, s1);
      const y1 = ft._horiz ? Math.max(p0, p1) : Math.max(s0, s1);
      const fill = typeof mk.color === "string" ? mk.color : at(mk.color, b.i);
      if (fill) {
        ctx.fillStyle = fill;
        ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
      }
      if (lw > 0 && lc) {
        ctx.lineWidth = lw;
        ctx.strokeStyle = typeof lc === "string" ? lc : at(lc, b.i) || "#2d2d2d";
        ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
      }
    }
    ctx.restore();
  }

  function contrastText(rgb) {
    const lum = (rgb[0] * 299 + rgb[1] * 587 + rgb[2] * 114) / 1000;
    return lum >= 128 ? "#2d2d2d" : "#fff";
  }

  function heatCellText(ft, i, j) {
    const tr = ft._input;
    const tpl = tr.texttemplate;
    if (typeof tpl !== "string" || !tpl) return "";
    const txt = Array.isArray(tr.text) && Array.isArray(tr.text[i]) ? tr.text[i][j] : undefined;
    const z = ft._z[i] ? ft._z[i][j] : undefined;
    return tpl.replace(/%\{(text|z)(:[^}]*)?\}/g, (m, key) => {
      const v = key === "text" ? txt : z;
      return v === undefined || v === null ? "" : String(v);
    });
  }

  function drawHeat(ctx, ft, fl) {
    const xa = ft._xa;
    const ya = ft._ya;
    const xe = ft._xe;
    const ye = ft._ye;
    const z = ft._z;
    const span = ft._zmax - ft._zmin;
    const xgap = Number(ft._input.xgap) || 0;
    const ygap = Number(ft._input.ygap) || 0;
    const tf = Object.assign({}, ft._input.textfont);
    const fs = Number(tf.size) || fl.font.size;
    const fam = tf.family || fl.font.family;
    ctx.save();
    ctx.globalAlpha = isFinite(ft.opacity) ? ft.opacity : 1;
    clipRect(ctx, ft);
    const labels = [];
    for (let i = 0; i < z.length; i++) {
      const row = z[i];
      const ya0 = pixelOf(ya, ye[i]);
      const ya1 = pixelOf(ya, ye[i + 1]);
      const top = Math.round(Math.min(ya0, ya1) + ygap / 2);
      const bot = Math.round(Math.max(ya0, ya1) - ygap / 2);
      if (!(bot > top)) continue;
      for (let j = 0; j < row.length; j++) {
        const v = numOf(row[j]);
        if (!isFinite(v)) continue;
        const xa0 = pixelOf(xa, xe[j]);
        const xa1 = pixelOf(xa, xe[j + 1]);
        const left = Math.round(Math.min(xa0, xa1) + xgap / 2);
        const right = Math.round(Math.max(xa0, xa1) - xgap / 2);
        if (!(right > left)) continue;
        const rgb = scaleColor(ft._stops, span > 0 ? (v - ft._zmin) / span : 0);
        ctx.fillStyle = "rgb(" + rgb[0] + "," + rgb[1] + "," + rgb[2] + ")";
        ctx.fillRect(left, top, right - left, bot - top);
        const text = heatCellText(ft, i, j);
        if (text) {
          const room = richSize(text, fs, fam);
          if (room.w + CELL_TEXT_PAD <= right - left && room.h <= bot - top + 2) {
            labels.push({ text: text, x: (left + right) / 2, y: (top + bot) / 2, color: tf.color || contrastText(rgb) });
          }
        }
      }
    }
    for (const lb of labels) drawRich(ctx, lb.text, lb.x, lb.y, "center", fs, fam, lb.color, 0, MID_SHIFT * fs);
    ctx.restore();
  }

  function drawTextPoints(ctx, ft, fl) {
    const tr = ft._input;
    const texts = decode(tr.text) || (typeof tr.text === "string" ? null : null);
    const tf = Object.assign({}, tr.textfont);
    const fam = tf.family || fl.font.family;
    ensurePixels(ft);
    const px = ft._px;
    const py = ft._py;
    for (let i = 0; i < ft._len; i++) {
      const x = px[i];
      const y = py[i];
      if (x !== x || y !== y) continue;
      const t = texts ? texts[i] : tr.text;
      if (t === undefined || t === null || t === "") continue;
      const size = Number(at(tf.size, i)) || fl.font.size;
      const color = at(tf.color, i) || fl.font.color;
      const lines = richRuns(String(t)).length;
      drawRich(ctx, String(t), x, y, "center", size, at(fam, i) || fam, color, 0, MID_SHIFT * size - ((lines - 1) * LINE_SPACING * size) / 2);
    }
  }

  function drawTrace(ctx, ft, prev, fl) {
    if (ft._box) {
      drawBoxes(ctx, ft);
      return;
    }
    if (ft._bar) {
      drawBars(ctx, ft);
      return;
    }
    if (ft._heat) {
      drawHeat(ctx, ft, fl);
      return;
    }
    const n = ft._len;
    if (!n) return;
    ensurePixels(ft);
    const px = ft._px;
    const py = ft._py;
    const alpha = isFinite(ft.opacity) ? ft.opacity : 1;
    ctx.save();
    ctx.globalAlpha = alpha;
    clipRect(ctx, ft);
    const segs = segments(px, py, ft.connectgaps);
    const ya = ft._ya;
    if (ft.fill === "tozeroy" && ft.fillcolor) {
      const z = ya._offset + ya.l2p(0);
      const zy = isFinite(z) ? z : ya._offset + ya._length;
      ctx.fillStyle = ft.fillcolor;
      ctx.beginPath();
      for (const s of segs) {
        ctx.moveTo(px[s[0]], zy);
        for (const i of s) ctx.lineTo(px[i], py[i]);
        ctx.lineTo(px[s[s.length - 1]], zy);
        ctx.closePath();
      }
      ctx.fill();
    } else if (ft.fill === "tonexty" && ft.fillcolor && prev && prev._px) {
      ctx.fillStyle = ft.fillcolor;
      ctx.beginPath();
      const ppx = prev._px;
      const ppy = prev._py;
      let started = false;
      for (let i = 0; i < n; i++) {
        if (px[i] !== px[i]) continue;
        if (!started) {
          ctx.moveTo(px[i], py[i]);
          started = true;
        } else ctx.lineTo(px[i], py[i]);
      }
      for (let i = ppx.length - 1; i >= 0; i--) {
        if (ppx[i] !== ppx[i]) continue;
        ctx.lineTo(ppx[i], ppy[i]);
      }
      if (started) {
        ctx.closePath();
        ctx.fill();
      }
    }
    if (hasLines(ft) && Number(ft.line.width) > 0 && ft.line.color) {
      ctx.lineWidth = Number(ft.line.width);
      ctx.strokeStyle = ft.line.color;
      ctx.lineJoin = "round";
      ctx.lineCap = "butt";
      if (ft.line.dash === "dot") ctx.setLineDash([2, 3]);
      else if (ft.line.dash === "dash") ctx.setLineDash([6, 4]);
      ctx.beginPath();
      const shape = ft.line.shape;
      for (const s of segs) {
        ctx.moveTo(px[s[0]], py[s[0]]);
        if (s.length === 1) ctx.lineTo(px[s[0]] + 0.01, py[s[0]]);
        for (let k = 1; k < s.length; k++) {
          if (shape === "hv") ctx.lineTo(px[s[k]], py[s[k - 1]]);
          else if (shape === "vh") ctx.lineTo(px[s[k - 1]], py[s[k]]);
          ctx.lineTo(px[s[k]], py[s[k]]);
        }
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (hasMarkers(ft)) {
      if (!ft.cliponaxis) {
        ctx.restore();
        ctx.save();
        ctx.globalAlpha = alpha;
      }
      drawMarkers(ctx, ft, px, py, alpha);
    }
    if (ft._hasText && fl) drawTextPoints(ctx, ft, fl);
    ctx.restore();
  }

  function drawMarkers(ctx, ft, px, py, alpha) {
    const mk = ft.marker;
    const n = px.length;
    const xa = ft._xa;
    const ya = ft._ya;
    const lw = Number(mk.line && mk.line.width) || 0;
    const lc = mk.line && mk.line.color;
    const scalarColor = typeof mk.color === "string" ? mk.color : null;
    const scalarSize = !(Array.isArray(mk.size) || ArrayBuffer.isView(mk.size));
    const scalarOpacity = !(Array.isArray(mk.opacity) || ArrayBuffer.isView(mk.opacity));
    const left = xa._offset - 0.5;
    const right = xa._offset + xa._length + 0.5;
    const top = ya._offset - 0.5;
    const bottom = ya._offset + ya._length + 0.5;
    for (let i = 0; i < n; i++) {
      const x = px[i];
      const y = py[i];
      if (x !== x) continue;
      if (!ft.cliponaxis && (x < left || x > right || y < top || y > bottom)) continue;
      const size = scalarSize ? Number(mk.size) : Number(at(mk.size, i));
      const r = (isFinite(size) ? size : 6) / 2;
      if (!(r > 0)) continue;
      const color = scalarColor || at(mk.color, i) || ft.line.color;
      const op = scalarOpacity ? Number(mk.opacity) : Number(at(mk.opacity, i));
      ctx.globalAlpha = alpha * (isFinite(op) ? op : 1);
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      if (lw > 0 && lc) {
        ctx.lineWidth = lw;
        ctx.strokeStyle = typeof lc === "string" ? lc : at(lc, i) || "#2d2d2d";
        ctx.stroke();
      }
    }
    ctx.globalAlpha = alpha;
  }

  function drawTickLabels(ctx, fl, st) {
    for (const ax of fl._axes) {
      if (ax._letter !== "y" || !ax.visible || !ax.showticklabels) continue;
      const vals = ax._tickVals;
      if (!vals || !vals.length) continue;
      const anchor = st.byId.get(ax.anchor);
      const xpos = anchor ? anchor._offset : fl._size.l;
      const size = Number(ax.tickfont.size) || fl.font.size;
      ctx.font = cssFont(size, ax.tickfont.family || fl.font.family);
      ctx.fillStyle = ax.tickfont.color || fl.font.color;
      ctx.textAlign = "right";
      ctx.textBaseline = "alphabetic";
      for (let i = 0; i < vals.length; i++) {
        const y = ax._offset + ax.l2p(vals[i]);
        const text = ax._tickText ? ax._tickText[i] : String(vals[i]);
        if (isPlain(text)) ctx.fillText(text, xpos - LABEL_GAP, y + TICK_BASELINE * size);
        else drawRich(ctx, text, xpos - LABEL_GAP, y + TICK_BASELINE * size, "right", size, ax.tickfont.family || fl.font.family, ax.tickfont.color || fl.font.color, 0);
      }
    }
  }

  function drawXTickLabels(ctx, fl, st) {
    for (const ax of fl._axes) {
      if (ax._letter !== "x") continue;
      const boxes = xLabelBoxes(ax, fl, st);
      if (!boxes.length) continue;
      const tf = tickFontOf(ax, fl);
      ctx.font = tf.css;
      ctx.fillStyle = tf.color;
      ctx.textBaseline = "alphabetic";
      const ang = ax.tickangle;
      ctx.textAlign = ang > 0 ? "left" : ang < 0 ? "right" : "center";
      const align = ang > 0 ? "left" : ang < 0 ? "right" : "center";
      for (const b of boxes) {
        if (isPlain(b.text)) {
          ctx.save();
          ctx.translate(b.x, b.cy);
          if (ang) ctx.rotate((ang * Math.PI) / 180);
          ctx.fillText(b.text, 0, b.fs / 2);
          ctx.restore();
        } else {
          drawRich(ctx, b.text, b.x, b.cy, align, tf.size, tf.family, tf.color, ang ? (ang * Math.PI) / 180 : 0, b.fs / 2);
        }
      }
    }
  }

  const CELL_TEXT_PAD = -2;

  function richSize(text, size, family) {
    const lines = richRuns(text);
    let w = 0;
    for (const ln of lines) {
      let lw = 0;
      for (const run of ln) lw += textWidth(run.text, runFont(run, size, family));
      w = Math.max(w, lw);
    }
    return { w: w, h: lines.length * size * LINE_SPACING };
  }

  function drawRich(ctx, text, x, y, align, size, family, color, rotate, dy) {
    const lines = richRuns(text);
    const lineH = size * LINE_SPACING;
    ctx.save();
    ctx.translate(x, y);
    if (rotate) ctx.rotate(rotate);
    if (dy) ctx.translate(0, dy);
    ctx.fillStyle = color;
    ctx.textBaseline = "alphabetic";
    ctx.textAlign = "left";
    lines.forEach((ln, li) => {
      const fonts = ln.map((run) => runFont(run, size, family));
      let w = 0;
      ln.forEach((run, k) => {
        w += textWidth(run.text, fonts[k]);
      });
      let cx = align === "center" ? -w / 2 : align === "right" ? -w : 0;
      ln.forEach((run, k) => {
        ctx.font = fonts[k];
        ctx.fillStyle = run.color || color;
        ctx.fillText(run.text, cx, li * lineH);
        cx += textWidth(run.text, fonts[k]);
      });
    });
    ctx.restore();
  }

  function drawAxisTitles(ctx, fl, st) {
    for (const ax of fl._axes) {
      const tp = axisTitlePos(ax, fl, st);
      if (!tp) continue;
      const fam = (ax.titleFont && ax.titleFont.family) || fl.font.family;
      if (ax._letter === "y") drawRich(ctx, ax.titleText, tp.x, tp.y, "center", tp.font.size, fam, tp.font.color, -Math.PI / 2);
      else drawRich(ctx, ax.titleText, tp.x, tp.y, "center", tp.font.size, fam, tp.font.color, 0);
    }
  }

  function drawLayoutTitle(ctx, fl) {
    const t = fl.title;
    if (!t || t.text === undefined || t.text === null || String(t.text) === "") return;
    const size = Number(t.font.size) || fl.font.size * 1.4;
    const sz = fl._size;
    const xref = t.xref === "paper" ? "paper" : "container";
    const xv = t.x === undefined ? 0.5 : Number(t.x);
    const x = xref === "paper" ? sz.l + xv * sz.w : xv * fl.width;
    let anchor = t.xanchor;
    if (!anchor || anchor === "auto") anchor = xv < 1 / 3 ? "left" : xv > 2 / 3 ? "right" : "center";
    const align = anchor === "left" ? "left" : anchor === "right" ? "right" : "center";
    let y;
    if (typeof t.y === "number" && t.yref !== "paper") y = (1 - t.y) * fl.height + MID_SHIFT * size;
    else y = sz.t / 2;
    drawRich(ctx, t.text, x, y, align, size, t.font.family || fl.font.family, t.font.color || fl.font.color, 0);
  }

  function annPosition(fl, st, a) {
    const size = fl._size;
    let x;
    let y;
    const xref = a.xref || "x";
    const yref = a.yref || "y";
    if (xref === "paper") x = size.l + Number(a.x) * size.w;
    else {
      const ax = st.byId.get(xref.replace(/ domain$/, ""));
      if (!ax) return null;
      x = / domain$/.test(xref) ? ax._offset + Number(a.x) * ax._length : ax._offset + ax.l2p(ax.d2c(a.x));
    }
    if (yref === "paper") y = size.t + (1 - Number(a.y)) * size.h;
    else {
      const ay = st.byId.get(yref.replace(/ domain$/, ""));
      if (!ay) return null;
      y = / domain$/.test(yref) ? ay._offset + (1 - Number(a.y)) * ay._length : ay._offset + ay.l2p(ay.d2c(a.y));
    }
    return isFinite(x) && isFinite(y) ? { x: x, y: y } : null;
  }

  function buildAnnotations(gd, fl, st) {
    const layer = st.annLayer;
    while (layer.firstChild) layer.removeChild(layer.firstChild);
    const anns = fl.annotations;
    anns.forEach((a, index) => {
      if (!a || a.visible === false || a.text === undefined || a.text === null || a.text === "") return;
      const pos = annPosition(fl, st, a);
      if (!pos) return;
      const f = Object.assign({}, fl.font, a.font);
      const fs = Number(f.size) || 12;
      const lines = richRuns(a.text);
      const lineH = fs * 1.176;
      let maxW = 0;
      for (const ln of lines) {
        let w = 0;
        for (const run of ln) {
          w += textWidth(run.text, (run.italic ? "italic " : "") + (run.bold ? "bold " : "") + cssFont(fs, f.family));
        }
        if (w > maxW) maxW = w;
      }
      const boxW = maxW + 2 * ANN_PAD;
      const boxH = lines.length * lineH + 2 * ANN_PAD;
      const xanchor = a.xanchor === "left" || a.xanchor === "right" ? a.xanchor : "center";
      const yanchor = a.yanchor === "top" || a.yanchor === "bottom" ? a.yanchor : "middle";
      let bx = pos.x - boxW / 2;
      if (xanchor === "left") bx = pos.x;
      else if (xanchor === "right") bx = pos.x - boxW;
      let by = pos.y - boxH / 2;
      if (yanchor === "top") by = pos.y;
      else if (yanchor === "bottom") by = pos.y - boxH;
      bx = Math.round(bx);
      by = Math.round(by);
      const g = el("g", "annotation");
      g.setAttribute("data-index", String(index));
      const tg = el("g", "annotation-text-g");
      const hit = el("g", a.captureevents ? "cursor-pointer" : "");
      hit.setAttribute("transform", `translate(${bx},${by})`);
      if (!a.captureevents) hit.style.pointerEvents = "none";
      const bg = el("rect", "bg");
      bg.setAttribute("x", "0");
      bg.setAttribute("y", "0");
      bg.setAttribute("width", String(Math.max(1, Math.round(boxW))));
      bg.setAttribute("height", String(Math.round(boxH)));
      bg.setAttribute("fill", a.bgcolor || "rgba(0,0,0,0)");
      const text = el("text", "annotation-text");
      text.setAttribute("text-anchor", xanchor === "center" ? "middle" : xanchor === "left" ? "start" : "end");
      const tx = xanchor === "center" ? boxW / 2 : xanchor === "left" ? ANN_PAD : boxW - ANN_PAD;
      text.setAttribute("x", String(tx));
      text.style.fontFamily = f.family;
      text.style.fontSize = fs + "px";
      text.style.fill = f.color || "#2d2d2d";
      text.style.whiteSpace = "pre";
      lines.forEach((ln, li) => {
        const baseline = ANN_PAD + li * lineH + 0.8 * lineH;
        if (lines.length === 1) {
          text.setAttribute("y", String(baseline));
          for (const run of ln) text.appendChild(runNode(run));
          return;
        }
        const span = el("tspan", "line");
        span.setAttribute("x", String(tx));
        span.setAttribute("y", String(baseline));
        for (const run of ln) span.appendChild(runNode(run));
        text.appendChild(span);
      });
      hit.appendChild(bg);
      hit.appendChild(text);
      tg.appendChild(hit);
      g.appendChild(tg);
      if (a.captureevents) {
        hit.addEventListener("click", (event) => {
          gd.emit("plotly_clickannotation", annEvent(gd, index, event));
        });
        hit.addEventListener("mouseover", (event) => {
          if (event.relatedTarget && hit.contains(event.relatedTarget)) return;
          gd.emit("plotly_hoverannotation", annEvent(gd, index, event));
        });
        hit.addEventListener("mouseout", (event) => {
          if (event.relatedTarget && hit.contains(event.relatedTarget)) return;
          gd.emit("plotly_unhoverannotation", annEvent(gd, index, event));
        });
      }
      layer.appendChild(g);
    });
  }

  function runNode(run) {
    if (!run.bold && !run.italic && !run.size && !run.color) return document.createTextNode(run.text);
    const t = el("tspan");
    if (run.bold) t.style.fontWeight = "bold";
    if (run.italic) t.style.fontStyle = "italic";
    if (run.size) t.style.fontSize = run.size + "px";
    if (run.color) t.style.fill = run.color;
    t.textContent = run.text;
    return t;
  }

  function annEvent(gd, index, event) {
    const input = (gd.layout && gd.layout.annotations && gd.layout.annotations[index]) || {};
    return { index: index, annotation: input, fullAnnotation: input, event: event };
  }

  function buildLegend(gd, fl, st) {
    const layer = st.legendLayer;
    while (layer.firstChild) layer.removeChild(layer.firstChild);
    const items = fl._legendItems;
    if (!items || !items.length) return;
    const geo = legendGeom(fl);
    if (geo) {
      buildLegendGeneral(gd, fl, st, geo);
      return;
    }
    const lg = fl.legend;
    const size = fl._size;
    const cols = legendCols(lg);
    const entryW = lg.orientation === "h"
      ? (lg.entrywidthmode === "fraction" && Number(lg.entrywidth) > 0
        ? Number(lg.entrywidth) * size.w
        : Number(lg.entrywidth) || 120)
      : 160;
    const rows = fl._legendRows;
    const height = rows * LEGEND_ROW + 2 * LEGEND_GAP;
    const x = size.l + (lg.x === undefined ? 0 : Number(lg.x)) * size.w;
    const top = isTopLegend(lg) ? size.t - height : size.t;
    const f = Object.assign({}, fl.font, lg.font);
    const fs = Number(f.size) || 12;
    const g = el("g", "legend");
    g.setAttribute("transform", `translate(${Math.round(x)},${Math.round(top)})`);
    items.forEach((ft, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const item = el("g", "traces");
      item.setAttribute("transform", `translate(${col * entryW},${LEGEND_GAP + row * LEGEND_ROW + LEGEND_ROW / 2})`);
      const hidden = groupHidden(gd, ft);
      item.style.opacity = hidden ? "0.5" : "1";
      const layers = el("g", "layers");
      layers.style.opacity = String(isFinite(ft.opacity) ? ft.opacity : 1);
      if (hasLines(ft) && Number(ft.line.width) > 0) {
        const p = el("path", "js-line");
        p.setAttribute("d", "M5,0h30");
        p.setAttribute("fill", "none");
        p.setAttribute("stroke", ft.line.color);
        p.setAttribute("stroke-width", String(Math.min(5, Number(ft.line.width))));
        layers.appendChild(p);
      } else if (ft.fill !== "none" && ft.fillcolor) {
        const p = el("path", "js-fill");
        p.setAttribute("d", "M5,-4h30v8h-30Z");
        p.setAttribute("fill", ft.fillcolor);
        layers.appendChild(p);
      }
      if (hasMarkers(ft)) {
        const c = el("circle", "scatterpts");
        c.setAttribute("cx", "20");
        c.setAttribute("cy", "0");
        c.setAttribute("r", String(Math.min(8, maxOf(ft.marker.size, 6)) / 2));
        c.setAttribute("fill", typeof ft.marker.color === "string" ? ft.marker.color : ft.line.color);
        layers.appendChild(c);
      }
      const text = el("text", "legendtext");
      text.setAttribute("text-anchor", "start");
      text.setAttribute("x", "40");
      text.setAttribute("y", String(0.39 * fs));
      text.style.fontFamily = f.family;
      text.style.fontSize = fs + "px";
      text.style.fill = f.color || "#2d2d2d";
      text.style.whiteSpace = "pre";
      text.textContent = String(ft.name);
      const toggle = el("rect", "legendtoggle");
      toggle.setAttribute("x", "0");
      toggle.setAttribute("y", String(-LEGEND_ROW / 2));
      toggle.setAttribute("width", String(entryW));
      toggle.setAttribute("height", String(LEGEND_ROW));
      toggle.setAttribute("fill", "rgba(0,0,0,0)");
      toggle.addEventListener("click", (event) => legendClick(gd, ft, event));
      item.appendChild(text);
      item.appendChild(layers);
      item.appendChild(toggle);
      g.appendChild(item);
    });
    layer.appendChild(g);
  }

  function legendSymbol(ft) {
    const layers = el("g", "layers");
    layers.style.opacity = String(isFinite(ft.opacity) ? ft.opacity : 1);
    if (ft._bar) {
      const mk = ft.marker || {};
      const p = el("path", "legendundefined");
      p.setAttribute("d", "M6,6H-6V-6H6Z");
      p.setAttribute("transform", "translate(20,0)");
      const fill = typeof mk.color === "string" ? mk.color : at(mk.color, 0) || "#2d2d2d";
      p.setAttribute("fill", fill);
      const lw = Math.min(2, Number(mk.line && mk.line.width) || 0);
      const lc = mk.line && (typeof mk.line.color === "string" ? mk.line.color : at(mk.line.color, 0));
      if (lw > 0 && lc) {
        p.setAttribute("stroke", lc);
        p.setAttribute("stroke-width", String(lw));
      }
      layers.appendChild(p);
      return layers;
    }
    if (hasLines(ft) && Number(ft.line.width) > 0) {
      const p = el("path", "js-line");
      p.setAttribute("d", "M5,0h30");
      p.setAttribute("fill", "none");
      p.setAttribute("stroke", ft.line.color);
      p.setAttribute("stroke-width", String(Math.min(5, Number(ft.line.width))));
      const dash = dashPattern(ft.line.dash, Number(ft.line.width));
      if (dash) p.setAttribute("stroke-dasharray", dash.join(","));
      layers.appendChild(p);
    } else if (ft.fill !== "none" && ft.fillcolor) {
      const p = el("path", "js-fill");
      p.setAttribute("d", "M5,-4h30v8h-30Z");
      p.setAttribute("fill", ft.fillcolor);
      layers.appendChild(p);
    }
    if (hasMarkers(ft)) {
      const mk = ft.marker;
      const sz = Number(at(mk.size, 0));
      const c = el("circle", "scatterpts");
      c.setAttribute("cx", "20");
      c.setAttribute("cy", "0");
      c.setAttribute("r", String(Math.min(8, isFinite(sz) ? sz : 6) / 2));
      const fill = typeof mk.color === "string" ? mk.color : at(mk.color, 0) || ft.line.color;
      c.setAttribute("fill", fill);
      const op = Number(at(mk.opacity, 0));
      if (isFinite(op)) c.setAttribute("opacity", String(op));
      const lw = Number(mk.line && mk.line.width) || 0;
      const lc = mk.line && (typeof mk.line.color === "string" ? mk.line.color : at(mk.line.color, 0));
      if (lw > 0 && lc) {
        c.setAttribute("stroke", lc);
        c.setAttribute("stroke-width", String(Math.min(2, lw)));
      }
      layers.appendChild(c);
    }
    return layers;
  }

  function buildLegendGeneral(gd, fl, st, geo) {
    const layer = st.legendLayer;
    const g = el("g", "legend");
    g.setAttribute("transform", `translate(${Math.round(geo.left * 100) / 100},${Math.round(geo.top * 100) / 100})`);
    for (const en of geo.entries) {
      const ft = en.ft;
      const item = el("g", "traces");
      item.setAttribute("transform", `translate(${en.x},${en.y})`);
      item.style.opacity = groupHidden(gd, ft) ? "0.5" : "1";
      const text = el("text", "legendtext");
      text.setAttribute("text-anchor", "start");
      text.setAttribute("x", "40");
      text.setAttribute("y", String(0.39 * geo.fs));
      text.style.fontFamily = geo.fam;
      text.style.fontSize = geo.fs + "px";
      text.style.fill = geo.color || "#2d2d2d";
      text.style.whiteSpace = "pre";
      text.textContent = String(ft.name);
      const toggle = el("rect", "legendtoggle");
      toggle.setAttribute("x", "0");
      toggle.setAttribute("y", String(-LEGEND_ROW / 2));
      toggle.setAttribute("width", String(en.w));
      toggle.setAttribute("height", String(LEGEND_ROW));
      toggle.setAttribute("fill", "rgba(0,0,0,0)");
      toggle.addEventListener("click", (event) => legendClick(gd, ft, event));
      item.appendChild(text);
      item.appendChild(legendSymbol(ft));
      item.appendChild(toggle);
      g.appendChild(item);
    }
    layer.appendChild(g);
  }

  function groupOf(gd, ft) {
    const out = [];
    (gd._fullData || []).forEach((t) => {
      if (t === ft || (ft.legendgroup && t.legendgroup === ft.legendgroup)) out.push(t.index);
    });
    return out;
  }

  function groupHidden(gd, ft) {
    return groupOf(gd, ft).every((i) => {
      const tr = gd.data[i];
      return tr && tr.visible === "legendonly";
    });
  }

  function legendClick(gd, ft, event) {
    const st = gd._wxLiteState;
    if (!st) return;
    const info = { event: event, curveNumber: ft.index, data: gd.data, layout: gd.layout, fullData: gd._fullData, fullLayout: gd._fullLayout };
    st.legendClicks += 1;
    if (st.legendClicks === 1) {
      if (gd._wxLiteTrigger("plotly_legendclick", info) === false) {
        st.legendClicks = 0;
        return;
      }
      const delay = (gd._context && gd._context.doubleClickDelay) || DBL_DELAY;
      st.legendTimer = setTimeout(() => {
        st.legendTimer = 0;
        st.legendClicks = 0;
        toggleGroup(gd, ft);
      }, delay);
      return;
    }
    if (st.legendTimer) clearTimeout(st.legendTimer);
    st.legendTimer = 0;
    st.legendClicks = 0;
    if (gd._wxLiteTrigger("plotly_legenddoubleclick", info) === false) return;
    isolateGroup(gd, ft);
  }

  function toggleGroup(gd, ft) {
    const idx = groupOf(gd, ft);
    const hide = !groupHidden(gd, ft);
    restyle(gd, { visible: hide ? "legendonly" : true }, idx);
  }

  function isolateGroup(gd, ft) {
    const mine = new Set(groupOf(gd, ft));
    const items = (gd._fullLayout && gd._fullLayout._legendItems) || [];
    const others = items.filter((t) => !mine.has(t.index));
    const soloAlready = !groupHidden(gd, ft) && others.every((t) => groupHidden(gd, t));
    const vis = [];
    const idx = [];
    (gd.data || []).forEach((tr, i) => {
      if (!tr || tr.visible === false) return;
      const listed = (gd._fullData[i] && gd._fullData[i].showlegend) || mine.has(i);
      if (!listed && !items.some((t) => t.legendgroup && t.legendgroup === gd._fullData[i].legendgroup)) return;
      idx.push(i);
      vis.push(soloAlready || mine.has(i) ? true : "legendonly");
    });
    if (idx.length) restyle(gd, { visible: vis }, idx);
  }

  function render(gd) {
    const st = mountDom(gd);
    const fl = computeLayout(gd);
    st.svg.setAttribute("width", String(fl.width));
    st.svg.setAttribute("height", String(fl.height));
    st.root.style.width = fl.width + "px";
    st.root.style.height = fl.height + "px";
    buildAnnotations(gd, fl, st);
    buildLegend(gd, fl, st);
    clearZoom(st);
    st.hoverKey = "";
    st.hover = null;
    if (!st.painted && gd.isConnected && gd.clientWidth) paintNow(gd);
    else schedulePaint(gd);
    return fl;
  }

  function rememberInitial(gd) {
    const st = gd._wxLiteState;
    const fl = gd._fullLayout;
    if (!st || !fl) return;
    const init = new Map();
    for (const ax of fl._axes) {
      if (ax._letter !== "x") continue;
      init.set(ax._name, { auto: ax.autorange === true, range: ax.range.slice() });
    }
    st.initial = init;
  }

  function newPlot(gd, data, layout, config) {
    if (gd._wxLiteState && gd._fullLayout) purge(gd, true);
    addEmitter(gd);
    gd.data = Array.isArray(data) ? data : [];
    gd.layout = layout && typeof layout === "object" ? layout : {};
    gd._context = Object.assign({ doubleClick: "reset+autosize", doubleClickDelay: DBL_DELAY }, config);
    render(gd);
    rememberInitial(gd);
    gd.emit("plotly_afterplot");
    return Promise.resolve(gd);
  }

  function react(gd, data, layout, config) {
    if (!gd._fullLayout || !gd._wxLiteState) return newPlot(gd, data, layout, config);
    gd.data = Array.isArray(data) ? data : [];
    gd.layout = layout && typeof layout === "object" ? layout : {};
    if (config) gd._context = Object.assign({ doubleClick: "reset+autosize", doubleClickDelay: DBL_DELAY }, config);
    unhoverQuiet(gd);
    render(gd);
    rememberInitial(gd);
    gd.emit("plotly_afterplot");
    return Promise.resolve(gd);
  }

  function relayout(gd, a, b) {
    if (!gd._fullLayout) return Promise.reject(new Error("not plotted"));
    const patch = typeof a === "string" ? { [a]: b } : Object.assign({}, a || {});
    const layout = gd.layout || (gd.layout = {});
    const fl = gd._fullLayout;
    const byId = gd._wxLiteState.byId;
    const groupOfAxis = (name) => {
      const ax = fl[name];
      if (!ax) return [name];
      const lead = ax.matches && byId.has(ax.matches) ? ax.matches : ax._id;
      return fl._axes.filter((o) => o._id === lead || o.matches === lead).map((o) => o._name);
    };
    for (const key of Object.keys(patch)) {
      const v = patch[key];
      if (key === "autosize") {
        layout.autosize = v;
        continue;
      }
      const m = /^([xy]axis\d*)\.(range|autorange)(\[(\d)\])?$/.exec(key);
      if (m) {
        const targets = m[1].charAt(0) === "x" ? groupOfAxis(m[1]) : [m[1]];
        for (const name of targets) {
          if (!layout[name] || typeof layout[name] !== "object") layout[name] = {};
          const inp = layout[name];
          if (m[2] === "range") {
            if (m[4] !== undefined) {
              const cur = Array.isArray(inp.range) ? inp.range.slice() : (fl[name] ? fl[name].range.slice() : [null, null]);
              cur[Number(m[4])] = v;
              inp.range = cur;
            } else {
              inp.range = Array.isArray(v) ? v.slice() : v;
            }
            inp.autorange = false;
          } else {
            inp.autorange = v;
          }
        }
        continue;
      }
      setPath(layout, key, deepCopyValue(v));
    }
    render(gd);
    gd.emit("plotly_afterplot");
    gd.emit("plotly_relayout", patch);
    return Promise.resolve(gd);
  }

  function restyle(gd, update, a, b) {
    if (!gd._fullLayout) return Promise.reject(new Error("not plotted"));
    let upd = update;
    let indices = a;
    if (typeof update === "string") {
      upd = { [update]: a };
      indices = b;
    }
    const data = gd.data || [];
    let idx;
    if (indices === undefined || indices === null) idx = data.map((_, i) => i);
    else idx = Array.isArray(indices) ? indices : [indices];
    for (const key of Object.keys(upd || {})) {
      const val = upd[key];
      idx.forEach((ti, k) => {
        const tr = data[ti];
        if (!tr) return;
        const v = Array.isArray(val) ? val[k % val.length] : val;
        setPath(tr, key, v);
      });
    }
    unhoverQuiet(gd);
    render(gd);
    gd.emit("plotly_afterplot");
    gd.emit("plotly_restyle", [upd, idx]);
    return Promise.resolve(gd);
  }

  function resize(gd) {
    if (!gd._fullLayout) return Promise.resolve(gd);
    render(gd);
    gd.emit("plotly_afterplot");
    return Promise.resolve(gd);
  }

  function purge(gd, keepEvents) {
    const st = gd._wxLiteState;
    if (st) {
      if (st.raf) cancelAnimationFrame(st.raf);
      if (st.moveRaf) cancelAnimationFrame(st.moveRaf);
      if (st.legendTimer) clearTimeout(st.legendTimer);
      if (st.ro) st.ro.disconnect();
      endDrag(st);
      if (st.listeners) {
        for (const [target, type, fn, opt] of st.listeners) target.removeEventListener(type, fn, opt);
      }
      if (st.root.parentNode === gd) gd.removeChild(st.root);
    }
    delete gd._wxLiteState;
    delete gd._fullLayout;
    delete gd._fullData;
    delete gd.calcdata;
    delete gd._context;
    delete gd.data;
    delete gd.layout;
    if (!keepEvents) dropEmitter(gd);
    gd.classList.remove("js-plotly-plot");
    return gd;
  }

  function subplotAt(gd, x, y) {
    const fl = gd._fullLayout;
    const st = gd._wxLiteState;
    if (!fl || !st) return null;
    for (const xa of fl._axes) {
      if (xa._letter !== "x" || !xa.visible) continue;
      const ya = st.byId.get(xa.anchor);
      if (!ya || !ya.visible) continue;
      if (x >= xa._offset && x <= xa._offset + xa._length && y >= ya._offset && y <= ya._offset + ya._length) {
        return { xa: xa, ya: ya };
      }
    }
    return null;
  }

  function nearestIndex(ft, xpx) {
    const px = ft._px;
    const valid = ft._valid;
    if (!px || !valid || !valid.length) return -1;
    if (ft._xSorted) {
      let lo = 0;
      let hi = valid.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (px[valid[mid]] < xpx) lo = mid + 1;
        else hi = mid;
      }
      let best = valid[lo];
      if (lo > 0 && Math.abs(px[valid[lo - 1]] - xpx) <= Math.abs(px[best] - xpx)) best = valid[lo - 1];
      return best;
    }
    let best = -1;
    let gap = Infinity;
    for (let k = 0; k < valid.length; k++) {
      const d = Math.abs(px[valid[k]] - xpx);
      if (d < gap) {
        gap = d;
        best = valid[k];
      }
    }
    return best;
  }

  function nearest2d(ft, x, y) {
    const px = ft._px;
    const py = ft._py;
    const valid = ft._valid;
    if (!valid || !valid.length) return null;
    const sizes = ft.marker.size;
    const scalar = !(Array.isArray(sizes) || ArrayBuffer.isView(sizes));
    const r0 = Math.max(3, (scalar ? Number(sizes) || 6 : 6) / 2);
    let best = -1;
    let bestD = Infinity;
    for (let k = 0; k < valid.length; k++) {
      const i = valid[k];
      const rad = scalar ? r0 : Math.max(3, (Number(at(sizes, i)) || 6) / 2);
      const d = Math.max(Math.hypot(px[i] - x, py[i] - y) - rad, 1 - 3 / rad);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best < 0 ? null : { i: best, d: bestD };
  }

  function ensurePixels(ft) {
    const sig = ft._xa._offset + ":" + ft._xa._m + ":" + ft._xa._b + ":" + ft._ya._offset + ":" + ft._ya._m + ":" + ft._ya._b;
    if (ft._px && ft._pxFor === sig) return;
    const pp = pixels(ft);
    ft._px = pp.px;
    ft._py = pp.py;
    let count = 0;
    for (let i = 0; i < pp.px.length; i++) if (pp.px[i] === pp.px[i]) count++;
    const valid = new Int32Array(count);
    for (let i = 0, k = 0; i < pp.px.length; i++) if (pp.px[i] === pp.px[i]) valid[k++] = i;
    ft._valid = valid;
    ft._pxFor = sig;
  }

  function pointFor(gd, ft, i, dist) {
    const tr = ft._input;
    const raw = decode(tr.x);
    const rawY = decode(tr.y);
    const cd = decode(tr.customdata);
    const pt = {
      data: tr,
      fullData: ft,
      curveNumber: ft.index,
      pointNumber: i,
      pointIndex: i,
      x: raw ? raw[i] : ft._xs[i],
      y: rawY ? rawY[i] : ft._ys[i],
      xaxis: ft._xa,
      yaxis: ft._ya,
      _dist: dist,
    };
    if (cd) pt.customdata = cd[i];
    else if (tr.customdata !== undefined) pt.customdata = tr.customdata;
    const tx = tr.text;
    if (Array.isArray(tx)) {
      if (tx[i] !== undefined) pt.text = tx[i];
    } else if (typeof tx === "string") pt.text = tx;
    const htx = tr.hovertext;
    if (Array.isArray(htx)) {
      if (htx[i] !== undefined) pt.hovertext = htx[i];
    } else if (typeof htx === "string") pt.hovertext = htx;
    return pt;
  }

  function hoverPoints(gd, x, y) {
    const fl = gd._fullLayout;
    if (!fl || fl.hovermode === false) return null;
    const sub = subplotAt(gd, x, y);
    if (!sub) return null;
    const hd = Number(fl.hoverdistance);
    const reach = isFinite(hd) && hd >= 0 ? (hd === 0 ? Infinity : hd) : 20;
    const pts = [];
    const closest = fl.hovermode === "closest";
    for (const ft of gd._fullData) {
      if (ft.visible !== true || ft.xaxis !== sub.xa._id || ft.yaxis !== sub.ya._id) continue;
      if (ft.hoverinfo === "skip" || String(ft.hoveron).indexOf("points") < 0) continue;
      if (!ft._len) continue;
      ensurePixels(ft);
      if (closest && hasMarkers(ft)) {
        const hit = nearest2d(ft, x, y);
        if (hit && hit.d < reach) pts.push(pointFor(gd, ft, hit.i, hit.d));
        continue;
      }
      const i = nearestIndex(ft, x);
      if (i < 0) continue;
      const sizes = ft.marker.size;
      const perPoint = Array.isArray(sizes) || ArrayBuffer.isView(sizes);
      const mrc = perPoint && hasMarkers(ft) ? Math.max(Number(at(sizes, i)) / 1.6, 3) : 0;
      const rad = Math.max(3, mrc || 0);
      const kink = 1 - 1 / rad;
      const dxRaw = Math.abs(ft._px[i] - x);
      let d = dxRaw < rad ? (kink * dxRaw) / rad : dxRaw - rad + kink;
      if (closest) {
        const dyRaw = Math.abs(ft._py[i] - y);
        const dy = dyRaw < rad ? (kink * dyRaw) / rad : dyRaw - rad + kink;
        d = Math.sqrt(d * d + dy * dy);
      }
      if (!(d < reach)) continue;
      pts.push(pointFor(gd, ft, i, d));
    }
    pts.sort((p, q) => p._dist - q._dist || p.curveNumber - q.curveNumber);
    const near = pts.length && pts[0]._dist <= BOX_HOVER_SLOP;
    if (!closest) {
      const bars = barHoverPoints(gd, sub, x, y, false);
      if (bars.length || pts.length) return { sub: sub, points: pts.concat(bars) };
      return null;
    }
    if (!near) {
      const bars = barHoverPoints(gd, sub, x, y, true);
      if (bars.length) return { sub: sub, points: [bars[0]] };
      const cell = heatHoverPoint(gd, sub, x, y);
      if (cell) return { sub: sub, points: [cell] };
    }
    if (!near) {
      const boxPts = boxHoverPoints(gd, sub, x, y);
      if (boxPts) return { sub: sub, points: boxPts };
    }
    if (!pts.length) return null;
    const keep = closest ? [pts[0]] : pts;
    return { sub: sub, points: keep };
  }

  function rawAt(v, i) {
    const arr = decode(v);
    if (arr) return arr[i];
    return v;
  }

  function barHoverPoints(gd, sub, x, y, inside) {
    const out = [];
    for (const ft of gd._fullData) {
      if (!ft._bar || ft.visible !== true || ft.xaxis !== sub.xa._id || ft.yaxis !== sub.ya._id) continue;
      if (ft.hoverinfo === "skip") continue;
      const tr = ft._input;
      let best = null;
      let bestD = Infinity;
      for (const b of ft._bars) {
        const s0 = pixelOf(ft._sa, b.b0);
        const s1 = pixelOf(ft._sa, b.b1);
        const p0 = pixelOf(ft._pa, b.p - b.w / 2);
        const p1 = pixelOf(ft._pa, b.p + b.w / 2);
        const sv = ft._horiz ? x : y;
        const pv = ft._horiz ? y : x;
        if (sv < Math.min(s0, s1) - 0.5 || sv > Math.max(s0, s1) + 0.5) continue;
        const pc = (p0 + p1) / 2;
        if (inside && (pv < Math.min(p0, p1) || pv > Math.max(p0, p1))) continue;
        const d = Math.abs(pv - pc);
        if (d < bestD) {
          bestD = d;
          best = b;
        }
      }
      if (!best) continue;
      const pt = {
        data: tr,
        fullData: ft,
        curveNumber: ft.index,
        pointNumber: best.i,
        pointIndex: best.i,
        x: ft._horiz ? ft._sa.c2d(best.b1) : rawAt(tr.x, best.i),
        y: ft._horiz ? rawAt(tr.y, best.i) : ft._sa.c2d(best.b1),
        xaxis: ft._xa,
        yaxis: ft._ya,
      };
      const end = pixelOf(ft._sa, best.b1);
      const q0 = pixelOf(ft._pa, best.p - best.w / 2);
      const q1 = pixelOf(ft._pa, best.p + best.w / 2);
      pt.bbox = ft._horiz
        ? { x0: end, x1: end, y0: Math.min(q0, q1), y1: Math.max(q0, q1) }
        : { x0: Math.min(q0, q1), x1: Math.max(q0, q1), y0: end, y1: end };
      if (tr.base !== undefined) pt.base = rawAt(tr.base, best.i);
      const htx = tr.hovertext;
      if (Array.isArray(htx)) pt.hovertext = htx[best.i];
      else if (typeof htx === "string") pt.hovertext = htx;
      const tx = tr.text;
      if (Array.isArray(tx)) pt.text = tx[best.i];
      else if (typeof tx === "string") pt.text = tx;
      const cd = decode(tr.customdata);
      if (cd) pt.customdata = cd[best.i];
      out.push(pt);
    }
    return out;
  }

  function heatHoverPoint(gd, sub, x, y) {
    for (let k = gd._fullData.length - 1; k >= 0; k--) {
      const ft = gd._fullData[k];
      if (!ft._heat || ft.visible !== true || ft.xaxis !== sub.xa._id || ft.yaxis !== sub.ya._id) continue;
      if (ft.hoverinfo === "skip") continue;
      const xv = ft._xa.p2l(x - ft._xa._offset);
      const yv = ft._ya.p2l(y - ft._ya._offset);
      const j = edgeIndex(ft._xe, xv);
      const i = edgeIndex(ft._ye, yv);
      if (i < 0 || j < 0 || !ft._z[i] || ft._z[i][j] === undefined) continue;
      const tr = ft._input;
      const pt = {
        data: tr,
        fullData: ft,
        curveNumber: ft.index,
        pointNumber: [i, j],
        pointIndex: [i, j],
        x: tr.x !== undefined ? rawAt(tr.x, j) : j,
        y: tr.y !== undefined ? rawAt(tr.y, i) : i,
        z: ft._z[i][j],
        xaxis: ft._xa,
        yaxis: ft._ya,
      };
      if (Array.isArray(tr.hovertext) && Array.isArray(tr.hovertext[i])) pt.hovertext = tr.hovertext[i][j];
      if (Array.isArray(tr.text) && Array.isArray(tr.text[i])) pt.text = tr.text[i][j];
      return pt;
    }
    return null;
  }

  function edgeIndex(edges, v) {
    const n = edges.length - 1;
    if (n < 1 || !isFinite(v)) return -1;
    const asc = edges[n] >= edges[0];
    for (let i = 0; i < n; i++) {
      const a = edges[i];
      const b = edges[i + 1];
      if (asc ? v >= a && v < b : v <= a && v > b) return i;
    }
    return -1;
  }

  function boxHoverPoints(gd, sub, x, y) {
    let best = null;
    let bestD = Infinity;
    for (const ft of gd._fullData) {
      if (!ft._box || ft.visible !== true || ft.xaxis !== sub.xa._id || ft.yaxis !== sub.ya._id) continue;
      if (ft.hoverinfo === "skip" || String(ft.hoveron).indexOf("boxes") < 0) continue;
      const xa = ft._xa;
      const ya = ft._ya;
      const half = Math.abs(xa._m) * (ft._dPos || ft._bdPos);
      for (const b of ft._boxes) {
        const d = Math.abs(x - (xa._offset + xa.l2p(b.pos)));
        if (d > half || d >= bestD) continue;
        const ya0 = ya._offset + ya.l2p(Math.max(b.uf, b.q3));
        const ya1 = ya._offset + ya.l2p(Math.min(b.lf, b.q1));
        if (y < Math.min(ya0, ya1) - BOX_HOVER_SLOP || y > Math.max(ya0, ya1) + BOX_HOVER_SLOP) continue;
        best = { ft, b };
        bestD = d;
      }
    }
    if (!best) return null;
    const { ft, b } = best;
    const rawX = decode(ft._input.x);
    return BOX_STATS.map((key) => ({
      data: ft._input,
      fullData: ft,
      curveNumber: ft.index,
      pointNumber: b.i,
      pointIndex: b.i,
      x: rawX ? rawX[b.i] : b.pos,
      y: b[key],
      xaxis: ft._xa,
      yaxis: ft._ya,
      hoverOnBox: true,
    }));
  }

  function localPoint(gd, ev) {
    const box = gd.getBoundingClientRect();
    return { x: ev.clientX - box.left, y: ev.clientY - box.top };
  }

  function overOverlay(target) {
    if (!target || !target.closest) return false;
    return !!target.closest(".annotation .cursor-pointer, .legend");
  }

  function emitHover(gd, st, ev, at) {
    const hit = at && !overOverlay(ev.target) ? hoverPoints(gd, at.x, at.y) : null;
    const key = hit
      ? hit.sub.xa._id + "|" + hit.points.map((p) => p.curveNumber + ":" + p.pointNumber).join(",")
      : "";
    if (key === st.hoverKey) return;
    const old = st.hover;
    st.hoverKey = key;
    st.hover = hit ? hit.points : null;
    if (!hit) {
      if (old) gd.emit("plotly_unhover", { event: ev, points: old });
      return;
    }
    for (const p of hit.points) delete p._dist;
    const xa = hit.sub.xa;
    const ya = hit.sub.ya;
    gd.emit("plotly_hover", {
      event: ev,
      points: hit.points,
      xaxes: [xa],
      yaxes: [ya],
      xvals: [xa.p2c(at.x - xa._offset)],
      yvals: [ya.p2c(at.y - ya._offset)],
    });
  }

  function unhoverQuiet(gd) {
    const st = gd._wxLiteState;
    if (!st || !st.hover) return;
    const old = st.hover;
    st.hover = null;
    st.hoverKey = "";
    gd.emit("plotly_unhover", { points: old });
  }

  function syncCursor(gd, st, at) {
    const fl = gd._fullLayout;
    if (!fl) return;
    let cur = "";
    if (!gd.style.cursor && at && fl.dragmode === "zoom" && subplotAt(gd, at.x, at.y)) cur = "crosshair";
    if (st.drag && st.drag.active) cur = "crosshair";
    if (st.canvas.style.cursor !== cur) st.canvas.style.cursor = cur;
  }

  function processMove(gd, st) {
    st.moveRaf = 0;
    const ev = st.lastMove;
    if (!ev || !gd._fullLayout) return;
    if (st.drag && st.drag.active) return;
    const at = localPoint(gd, ev);
    emitHover(gd, st, ev, at);
    syncCursor(gd, st, at);
  }

  function clearZoom(st) {
    while (st.zoomLayer.firstChild) st.zoomLayer.removeChild(st.zoomLayer.firstChild);
  }

  function drawZoom(st, d, x1) {
    clearZoom(st);
    const xa = d.xa;
    const ya = d.ya;
    const left = xa._offset;
    const top = ya._offset;
    const w = xa._length;
    const h = ya._length;
    const a = Math.max(left, Math.min(left + w, Math.min(d.x0, x1)));
    const b = Math.max(left, Math.min(left + w, Math.max(d.x0, x1)));
    const box = el("path", "zoombox");
    box.setAttribute("fill-rule", "evenodd");
    box.setAttribute(
      "d",
      `M${left},${top}H${left + w}V${top + h}H${left}Z` +
        `M${a},${top}V${top + h}H${b}V${top}Z`
    );
    const c = el("path", "zoombox-corners");
    const cy = top + h / 2;
    const s = Math.min(h / 2, 10);
    c.setAttribute(
      "d",
      `M${a - 0.5},${cy - s}h-3v${2 * s}h3Z` +
        `M${b + 0.5},${cy - s}h3v${2 * s}h-3Z`
    );
    st.zoomLayer.appendChild(box);
    st.zoomLayer.appendChild(c);
  }

  function endDrag(st) {
    const d = st && st.drag;
    if (!d) return;
    document.removeEventListener("mousemove", d.move, true);
    document.removeEventListener("mouseup", d.up, true);
    window.removeEventListener("blur", d.cancel);
    st.drag = null;
    clearZoom(st);
  }

  function zoomTo(gd, xa, lo, hi) {
    const fl = gd._fullLayout;
    const byId = gd._wxLiteState.byId;
    const lead = xa.matches && byId.has(xa.matches) ? xa.matches : xa._id;
    const names = [xa._name].concat(
      fl._axes
        .filter((o) => o !== xa && o._letter === "x" && (o._id === lead || o.matches === lead))
        .map((o) => o._name)
    );
    const r0 = xa.l2r(lo);
    const r1 = xa.l2r(hi);
    const patch = {};
    for (const name of names) {
      patch[name + ".range[0]"] = r0;
      patch[name + ".range[1]"] = r1;
    }
    return relayout(gd, patch);
  }

  function resetAxes(gd, at) {
    const fl = gd._fullLayout;
    const st = gd._wxLiteState;
    if (!fl || !st || !st.initial) return;
    const sub = at ? subplotAt(gd, at.x, at.y) : null;
    const byId = st.byId;
    const lead = sub ? (sub.xa.matches && byId.has(sub.xa.matches) ? sub.xa.matches : sub.xa._id) : null;
    const axes = fl._axes.filter((o) => o._letter === "x" && (!lead || o._id === lead || o.matches === lead));
    const atInitial = axes.every((o) => {
      const init = st.initial.get(o._name);
      if (!init) return true;
      return Math.abs(o.r2l(init.range[0]) - o._rl[0]) < 1e-6 * Math.abs(o._rl[1] - o._rl[0] || 1) &&
        Math.abs(o.r2l(init.range[1]) - o._rl[1]) < 1e-6 * Math.abs(o._rl[1] - o._rl[0] || 1);
    });
    const mode = (gd._context && gd._context.doubleClick) || "reset+autosize";
    const patch = {};
    if (!atInitial && /reset/.test(mode)) {
      for (const o of axes) {
        const init = st.initial.get(o._name);
        if (!init) continue;
        if (init.auto) patch[o._name + ".autorange"] = true;
        else {
          patch[o._name + ".range[0]"] = init.range[0];
          patch[o._name + ".range[1]"] = init.range[1];
        }
      }
    } else if (/autosize/.test(mode)) {
      for (const o of axes) patch[o._name + ".autorange"] = true;
    }
    if (!Object.keys(patch).length) return;
    relayout(gd, patch);
  }

  function wireEvents(gd, st) {
    const list = [];
    const on = (target, type, fn, opt) => {
      target.addEventListener(type, fn, opt);
      list.push([target, type, fn, opt]);
    };
    st.listeners = list;
    let downAt = null;
    let dragged = false;

    on(gd, "mousemove", (ev) => {
      st.lastMove = ev;
      if (!st.moveRaf) st.moveRaf = requestAnimationFrame(() => processMove(gd, st));
    });

    on(gd, "mouseleave", (ev) => {
      if (st.moveRaf) {
        cancelAnimationFrame(st.moveRaf);
        st.moveRaf = 0;
      }
      st.lastMove = null;
      if (st.drag && st.drag.active) return;
      if (st.hover) {
        const old = st.hover;
        st.hover = null;
        st.hoverKey = "";
        gd.emit("plotly_unhover", { event: ev, points: old });
      }
      syncCursor(gd, st, null);
    });

    on(gd, "mousedown", (ev) => {
      if (ev.button !== 0 || overOverlay(ev.target)) return;
      const fl = gd._fullLayout;
      if (!fl) return;
      const at = localPoint(gd, ev);
      downAt = { x: ev.clientX, y: ev.clientY };
      dragged = false;
      if (fl.dragmode !== "zoom") return;
      const sub = subplotAt(gd, at.x, at.y);
      if (!sub || sub.xa.fixedrange) return;
      endDrag(st);
      const d = { xa: sub.xa, ya: sub.ya, x0: at.x, active: false, last: at.x };
      d.move = (e) => {
        const p = localPoint(gd, e);
        d.last = p.x;
        if (!d.active) {
          if (Math.abs(e.clientX - downAt.x) < BOX_SHOW_PX && Math.abs(e.clientY - downAt.y) < BOX_SHOW_PX) return;
          d.active = true;
          dragged = true;
          if (st.hover) {
            const old = st.hover;
            st.hover = null;
            st.hoverKey = "";
            gd.emit("plotly_unhover", { event: e, points: old });
          }
        }
        drawZoom(st, d, p.x);
        e.preventDefault();
      };
      d.up = (e) => {
        const was = d.active;
        const x1 = Math.max(d.xa._offset, Math.min(d.xa._offset + d.xa._length, d.last));
        const x0 = d.x0;
        endDrag(st);
        if (!was) return;
        dragged = true;
        if (Math.abs(x1 - x0) < MIN_DRAG) {
          syncCursor(gd, st, localPoint(gd, e));
          return;
        }
        const xa = d.xa;
        const lo = xa.p2l(Math.min(x0, x1) - xa._offset);
        const hi = xa.p2l(Math.max(x0, x1) - xa._offset);
        zoomTo(gd, xa, lo, hi);
      };
      d.cancel = () => endDrag(st);
      st.drag = d;
      document.addEventListener("mousemove", d.move, true);
      document.addEventListener("mouseup", d.up, true);
      window.addEventListener("blur", d.cancel);
      ev.preventDefault();
    });

    on(gd, "click", (ev) => {
      if (overOverlay(ev.target)) return;
      if (dragged) {
        dragged = false;
        return;
      }
      if (downAt && (Math.abs(ev.clientX - downAt.x) > BOX_SHOW_PX || Math.abs(ev.clientY - downAt.y) > BOX_SHOW_PX)) return;
      if (st.moveRaf) {
        cancelAnimationFrame(st.moveRaf);
        st.moveRaf = 0;
      }
      const at = localPoint(gd, ev);
      emitHover(gd, st, ev, at);
      if (st.hover && st.hover.length) gd.emit("plotly_click", { event: ev, points: st.hover });
    });

    on(gd, "dblclick", (ev) => {
      if (overOverlay(ev.target)) return;
      const ctx = gd._context || {};
      if (ctx.doubleClick === false) return;
      const fl = gd._fullLayout;
      if (!fl || fl.dragmode === false) return;
      const at = localPoint(gd, ev);
      if (!subplotAt(gd, at.x, at.y)) return;
      gd.emit("plotly_doubleclick", null);
      resetAxes(gd, at);
    });
  }

  const LITE_LAYOUT_BLOCK = [
    "coloraxis", "updatemenus", "sliders", "images", "polar", "geo", "mapbox", "map",
    "ternary", "selections", "grid",
  ];

  function liteAxisOk(key, ax) {
    if (!ax || typeof ax !== "object") return true;
    if (ax.overlaying || ax.rangeslider || ax.rangeselector || ax.mirror || ax.scaleanchor) return false;
    if (ax.side === "top" || ax.side === "right") return false;
    const t = ax.type;
    if (t && t !== "linear" && t !== "category" && t !== "date" && t !== "-") return false;
    if (t === "date" && key.charAt(0) === "y" && ax.showticklabels !== false) return false;
    if (ax.tickformat || ax.ticksuffix || ax.tickprefix || ax.showexponent || ax.exponentformat) return false;
    if (ax.ticks === "outside" || ax.ticks === "inside" || ax.showline) return false;
    if (ax.dtick !== undefined && t !== "category" && !(Array.isArray(ax.categoryarray))) return false;
    const isCat = t === "category" || Array.isArray(ax.categoryarray);
    if (ax.tickmode && ax.tickmode !== "array" && ax.tickmode !== "auto" && !(ax.tickmode === "linear" && isCat)) return false;
    if (ax.showspikes || ax.spikemode) return ax.showspikes === false;
    return true;
  }

  function liteTraceOk(tr) {
    const type = tr.type || "scatter";
    if (type === "box") {
      if (!tr.q1 || !tr.median || !tr.q3 || tr.y !== undefined || tr.orientation === "h") return false;
      return !(tr.boxmean || tr.notched || tr.mean || tr.sd);
    }
    if (type === "bar") {
      if (tr.orientation !== "h") return false;
      if (tr.text !== undefined && tr.textposition !== "none") return false;
      return !(tr.error_x || tr.error_y || (tr.marker && (tr.marker.colorscale || tr.marker.pattern)));
    }
    if (type === "heatmap") {
      if (!Array.isArray(tr.z) || tr.zsmooth || tr.coloraxis) return false;
      if (tr.colorscale !== undefined && !Array.isArray(tr.colorscale)) return false;
      if (tr.texttemplate !== undefined && !/^(%\{(text|z)\}|[^%])*$/.test(String(tr.texttemplate))) return false;
      return true;
    }
    if (type !== "scatter" && type !== "scattergl") return false;
    const mode = String(tr.mode || "lines");
    if (!/^(lines|markers|text)(\+(lines|markers|text))*$/.test(mode)) return false;
    const mk = tr.marker || {};
    if (mk.symbol !== undefined && mk.symbol !== "circle") return false;
    if (mk.colorscale || mk.colorbar || mk.gradient || mk.coloraxis) return false;
    if (tr.line && tr.line.shape && ["linear", "hv", "vh"].indexOf(tr.line.shape) < 0) return false;
    if (tr.fill && tr.fill !== "none" && tr.fill !== "tozeroy" && tr.fill !== "tonexty") return false;
    if (tr.error_x || tr.error_y || tr.texttemplate) return false;
    if (tr.textposition !== undefined && tr.textposition !== "middle center") return false;
    return true;
  }

  function supports(data, layout) {
    if (!Array.isArray(data) || !data.length) return false;
    for (const tr of data) {
      if (!tr || typeof tr !== "object" || !liteTraceOk(tr)) return false;
    }
    const lay = layout || {};
    for (const k of LITE_LAYOUT_BLOCK) if (lay[k]) return false;
    if (lay.barmode && lay.barmode !== "overlay" && data.filter((t) => t && t.type === "bar").length > 1) return false;
    if (lay.hovermode !== undefined && lay.hovermode !== false &&
      ["closest", "x unified", "x"].indexOf(lay.hovermode) < 0) return false;
    for (const k of Object.keys(lay)) {
      if (/^scene\d*$/.test(k)) return false;
      if (/^[xy]axis\d*$/.test(k) && !liteAxisOk(k, lay[k])) return false;
    }
    for (const a of lay.annotations || []) {
      if (!a) continue;
      if (a.showarrow !== false) return false;
    }
    for (const sh of lay.shapes || []) {
      if (!sh) continue;
      const t = sh.type || "rect";
      if (t !== "rect" && t !== "line") return false;
    }
    return true;
  }

  function isLite(gd) {
    return !!(gd && gd._wxLite);
  }

  function resolve(gd) {
    if (typeof gd === "string") return document.getElementById(gd);
    return gd;
  }

  const api = {
    newPlot: newPlot,
    react: react,
    relayout: relayout,
    restyle: restyle,
    purge: purge,
    resize: resize,
    unhover: (gd) => {
      const st = gd._wxLiteState;
      if (!st) return;
      if (st.moveRaf) {
        cancelAnimationFrame(st.moveRaf);
        st.moveRaf = 0;
      }
      unhoverQuiet(gd);
    },
    paintNow: paintNow,
    supports: supports,
  };

  window.WxLite = api;

  function patch(P) {
    if (!P || P._wxLitePatched) return;
    P._wxLitePatched = true;
    const wrap = (name, fn) => {
      const orig = P[name];
      P[name] = function (gd) {
        const node = resolve(gd);
        if (isLite(node)) {
          try {
            return fn.apply(null, [node].concat(Array.prototype.slice.call(arguments, 1)));
          } catch (e) {
            return Promise.reject(e);
          }
        }
        return typeof orig === "function" ? orig.apply(this, arguments) : Promise.reject(new Error("Plotly unavailable"));
      };
    };
    wrap("newPlot", newPlot);
    wrap("react", react);
    wrap("relayout", relayout);
    wrap("restyle", restyle);
    const origPurge = P.purge;
    P.purge = function (gd) {
      const node = resolve(gd);
      if (node && (node._wxLiteState || isLite(node))) return purge(node);
      return typeof origPurge === "function" ? origPurge.apply(this, arguments) : node;
    };
    P.Plots = P.Plots || {};
    const origResize = P.Plots.resize;
    P.Plots.resize = function (gd) {
      const node = resolve(gd);
      if (isLite(node)) return resize(node);
      return typeof origResize === "function" ? origResize.apply(this, arguments) : Promise.resolve(node);
    };
    P.Fx = P.Fx || {};
    const origUnhover = P.Fx.unhover;
    P.Fx.unhover = function (gd) {
      const node = resolve(gd);
      if (isLite(node)) return api.unhover(node);
      return typeof origUnhover === "function" ? origUnhover.apply(this, arguments) : undefined;
    };
  }

  const PLOTLY_SRC = "https://cdn.plot.ly/plotly-2.35.2.min.js";
  let realPlotly = null;
  let capturedPlotly = null;
  let plotlyJob = null;
  let stub = null;

  function loadPlotly() {
    if (realPlotly) return Promise.resolve(realPlotly);
    if (plotlyJob) return plotlyJob;
    plotlyJob = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = PLOTLY_SRC;
      s.charset = "utf-8";
      s.async = true;
      s.onload = () => {
        if (!capturedPlotly && window.Plotly && window.Plotly !== stub) {
          capturedPlotly = window.Plotly;
          window.Plotly = stub;
        }
        if (capturedPlotly && typeof capturedPlotly.newPlot === "function") {
          realPlotly = capturedPlotly;
          resolve(realPlotly);
          return;
        }
        plotlyJob = null;
        reject(new Error("Plotly failed to load"));
      };
      s.onerror = () => {
        plotlyJob = null;
        if (s.parentNode) s.parentNode.removeChild(s);
        reject(new Error("Plotly failed to load"));
      };
      document.head.appendChild(s);
    });
    return plotlyJob;
  }

  function deferred(name) {
    return function () {
      const args = arguments;
      if (realPlotly) return realPlotly[name].apply(realPlotly, args);
      return loadPlotly().then((p) => p[name].apply(p, args));
    };
  }

  function makeStub() {
    return {
      newPlot: deferred("newPlot"),
      react: deferred("react"),
      relayout: deferred("relayout"),
      restyle: deferred("restyle"),
      purge(gd) {
        if (realPlotly) return realPlotly.purge.apply(realPlotly, arguments);
        return gd;
      },
      Plots: {
        resize() {
          if (realPlotly) return realPlotly.Plots.resize.apply(realPlotly.Plots, arguments);
          return Promise.resolve();
        },
      },
      Fx: {
        unhover() {
          if (realPlotly) return realPlotly.Fx.unhover.apply(realPlotly.Fx, arguments);
          return undefined;
        },
      },
      wxLoad: loadPlotly,
      wxReady: () => !!realPlotly,
    };
  }

  if (window.Plotly) {
    patch(window.Plotly);
  } else {
    stub = makeStub();
    patch(stub);
    try {
      Object.defineProperty(window, "Plotly", {
        configurable: true,
        enumerable: true,
        get() {
          return stub;
        },
        set(v) {
          if (v && v !== stub) capturedPlotly = v;
        },
      });
    } catch (e) {
      void e;
      window.Plotly = stub;
    }
  }
})();