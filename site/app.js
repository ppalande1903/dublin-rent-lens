/* Dublin Rent Lens: static front end. Reads the JSON the pipeline exports to site/data/. */
(async function () {
  "use strict";
  const $ = (s, el = document) => el.querySelector(s);
  const NS = "http://www.w3.org/2000/svg";
  const euro = (v) => (v == null ? "n/a" : "€" + Math.round(v).toLocaleString("en-IE"));
  const pct = (v, d = 1) => (v == null ? "n/a" : (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v * 100).toFixed(d) + "%");
  const qlabel = (t) => { const n = t + 3; return `${2007 + Math.floor(n / 4)} Q${(n % 4) + 1}`; };
  const yearOf = (t) => 2007 + Math.floor((t + 3) / 4);
  const el = (tag, attrs = {}, text) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) k === "class" ? (e.className = v) : e.setAttribute(k, v);
    if (text != null) e.textContent = text;
    return e;
  };
  const sv = (tag, attrs = {}, style = {}) => {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    Object.assign(e.style, style);
    return e;
  };

  const NAMES = {
    D1: "North inner city", D2: "South inner city", D3: "Clontarf, Drumcondra", D4: "Ballsbridge, Sandymount",
    D5: "Raheny, Artane", D6: "Rathmines, Ranelagh", D6W: "Terenure, Templeogue", D7: "Stoneybatter, Phibsboro",
    D8: "Rialto, Inchicore", D9: "Glasnevin, Beaumont", D10: "Ballyfermot", D11: "Finglas", D12: "Crumlin, Walkinstown",
    D13: "Sutton, Donaghmede", D14: "Dundrum, Churchtown", D15: "Blanchardstown, Castleknock", D16: "Ballinteer, Knocklyon",
    D17: "Coolock, Clongriffin", D18: "Foxrock, Sandyford", D20: "Palmerstown, Chapelizod", D22: "Clondalkin", D24: "Tallaght",
  };
  // tile-map positions [col, row], west->east, north->south; rows 0-1 are north of the Liffey
  const POS = {
    D15: [0, 0], D11: [1, 0], D9: [2, 0], D17: [3, 0], D13: [4, 0],
    D20: [0, 1], D7: [1, 1], D1: [2, 1], D3: [3, 1], D5: [4, 1],
    D10: [0, 2], D8: [1, 2], D2: [2, 2], D4: [3, 2],
    D22: [0, 3], D12: [1, 3], D6: [2, 3], D14: [3, 3],
    D24: [0, 4], D6W: [1, 4], D16: [2, 4], D18: [3, 4],
  };
  const BEDS = { "One bed": "1 bed", "Two bed": "2 beds", "Three bed": "3 beds", "Four plus bed": "4+ beds", "All bedrooms": "Any size" };
  const TYPES = { Apartment: "Apartment", "Other flats": "Other flat", "Terrace house": "Terraced house",
    "Semi detached house": "Semi-detached house", "Detached house": "Detached house", "All property types": "Any type" };

  /* ---------------- theme ---------------- */
  try { const t = localStorage.getItem("rl-theme"); if (t) document.documentElement.dataset.theme = t; } catch (_) {}
  $("#theme").addEventListener("click", () => {
    const cur = document.documentElement.dataset.theme ||
      (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    const next = cur === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("rl-theme", next); } catch (_) {}
  });

  /* ---------------- tooltip ---------------- */
  const tip = $("#tip");
  function showTip(pt, title, rows) {
    tip.replaceChildren(el("div", { class: "t" }, title));
    for (const r of rows) {
      const row = el("div", { class: "r" });
      const s = el("span");
      if (r.color) { const i = el("i"); i.style.borderColor = r.color; if (r.dash) i.style.borderTopStyle = "dashed"; s.append(i); }
      s.append(document.createTextNode(r.label));
      row.append(s, el("b", {}, r.value));
      tip.append(row);
    }
    tip.hidden = false;
    const pad = 14, w = tip.offsetWidth, h = tip.offsetHeight;
    let x = pt.x + pad, y = pt.y + pad;
    if (x + w > innerWidth - 8) x = pt.x - w - pad;
    if (y + h > innerHeight - 8) y = pt.y - h - pad;
    tip.style.left = Math.max(8, x) + "px";
    tip.style.top = Math.max(8, y) + "px";
  }
  const hideTip = () => (tip.hidden = true);
  const rectPoint = (node) => { const r = node.getBoundingClientRect(); return { x: r.right, y: r.top }; };

  /* ---------------- data ---------------- */
  let meta, dub, dists, segs, evals;
  try {
    [meta, dub, dists, segs, evals] = await Promise.all(
      ["meta", "dublin", "districts", "segments", "evaluation"].map((f) => fetch(`data/${f}.json`).then((r) => r.json())));
  } catch (e) {
    $("#tiles").textContent = "Couldn't load the data. If you opened this file directly, serve the folder over HTTP instead.";
    return;
  }
  const byId = Object.fromEntries(dists.map((d) => [d.id, d]));
  $("#issueLeft").textContent = `Vol. 1 · A field guide to renting in Dublin`;
  $("#issueRight").textContent = `Rents to ${meta.rent_data_to} · sales to ${new Date(meta.sales_to).toLocaleDateString("en-IE", { month: "short", year: "numeric" })} · updated weekly`;

  /* ---------------- scales ---------------- */
  function niceTicks(min, max, n = 5) {
    const span = max - min || 1, step0 = span / n, mag = 10 ** Math.floor(Math.log10(step0));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= n) || 10 * mag;
    const out = [];
    for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) out.push(v);
    return out;
  }
  const lin = (d0, d1, r0, r1) => (v) => r0 + ((v - d0) / (d1 - d0 || 1)) * (r1 - r0);

  /* ---------------- line chart (crosshair + tooltip) ---------------- */
  function lineChart(box, { series, band, height = 300, yFmt = euro, endLabels = true, title = "", notes = [] }) {
    box.replaceChildren();
    const W = Math.max(320, box.clientWidth), H = height;
    const m = { l: 56, r: endLabels ? 92 : 16, t: 12, b: 28 };
    const ts = new Set(), vals = [];
    series.forEach((s) => s.points.forEach(([t, v]) => { ts.add(t); vals.push(v); }));
    (band?.points || []).forEach(([t, lo, hi]) => { ts.add(t); vals.push(lo, hi); });
    const tl = [...ts].sort((a, b) => a - b);
    const yt = niceTicks(Math.min(...vals) * 0.96, Math.max(...vals) * 1.02, 5);
    const x = lin(tl[0], tl[tl.length - 1], m.l, W - m.r), y = lin(yt[0], yt[yt.length - 1], H - m.b, m.t);
    const svg = sv("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": title });
    const g = sv("g", { class: "axis" });
    yt.forEach((v) => {
      g.append(sv("line", { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v), class: v === yt[0] ? "baseline" : "gridline" }));
      const tx = sv("text", { x: m.l - 8, y: y(v) + 4, "text-anchor": "end" }); tx.textContent = yFmt(v); g.append(tx);
    });
    const y0 = yearOf(tl[0]), y1 = yearOf(tl[tl.length - 1]), every = y1 - y0 > 12 ? 3 : y1 - y0 > 6 ? 2 : 1;
    for (let yr = y0 + 1; yr <= y1; yr++) {
      if ((yr - y0) % every) continue;
      const t = (yr - 2007) * 4 - 3; // Q1 of that year
      if (t < tl[0] || t > tl[tl.length - 1]) continue;
      const tx = sv("text", { x: x(t), y: H - 8, "text-anchor": "middle" }); tx.textContent = yr; g.append(tx);
    }
    svg.append(g);
    if (band?.points.length) {
      const pts = band.points.map(([t, , hi]) => `${x(t)},${y(hi)}`).concat(band.points.slice().reverse().map(([t, lo]) => `${x(t)},${y(lo)}`));
      svg.append(sv("polygon", { points: pts.join(" "), class: "band-fill" }, { fill: band.color }));
    }
    const path = (pts) => pts.map(([t, v], i) => `${i ? "L" : "M"}${x(t).toFixed(1)},${y(v).toFixed(1)}`).join("");
    series.forEach((s) => {
      const solid = s.dashFrom == null ? s.points : s.points.filter(([t]) => t <= s.dashFrom);
      const dashed = s.dashFrom == null ? [] : s.points.filter(([t]) => t >= s.dashFrom);
      if (solid.length) svg.append(sv("path", { d: path(solid), class: "line" }, { stroke: s.color, strokeDasharray: s.dash ? "5 4" : "" }));
      if (dashed.length) svg.append(sv("path", { d: path(dashed), class: "line" }, { stroke: s.color, strokeDasharray: "5 4" }));
    });
    if (endLabels) {
      const ends = series.filter((s) => s.label !== false).map((s) => { const p = s.points[s.points.length - 1]; return { s, yv: y(p[1]), v: p[1] }; })
        .sort((a, b) => a.yv - b.yv);
      for (let i = 1; i < ends.length; i++) if (ends[i].yv - ends[i - 1].yv < 14) ends[i].yv = ends[i - 1].yv + 14;
      ends.forEach(({ s, yv, v }) => {
        const tx = sv("text", { x: W - m.r + 8, y: yv + 4, class: "endlabel" });
        tx.textContent = `${s.name} ${yFmt(v)}`; svg.append(tx);
      });
    }
    // handwritten notes: text offset from a point, with a little curved arrow
    notes.forEach(({ t, v, text, dx = 20, dy = -30 }) => {
      const px = x(t), py = y(v), tx = px + dx, ty = py + dy;
      const bend = dx > 0 ? -12 : 12;
      svg.append(sv("path", { class: "annot-arrow", d: `M${tx - Math.sign(dx) * 4},${ty + (dy < 0 ? 6 : -14)} Q${px + dx / 2 + bend},${py + dy / 2} ${px + Math.sign(dx) * 3},${py + Math.sign(dy) * 4}` }));
      const tt = sv("text", { x: tx, y: ty, class: "annot", "text-anchor": dx > 0 ? "start" : "end" }); tt.textContent = text; svg.append(tt);
    });
    // crosshair layer
    const hair = sv("line", { y1: m.t, y2: H - m.b, class: "crosshair", visibility: "hidden" });
    const dots = series.map((s) => sv("circle", { r: 4, class: "dot", visibility: "hidden" }, { fill: s.color }));
    svg.append(hair, ...dots);
    const hit = sv("rect", { x: m.l, y: 0, width: W - m.l - m.r, height: H, fill: "transparent", tabindex: 0, "aria-label": `${title}. Use arrow keys to read values.` });
    svg.append(hit);
    let idx = tl.length - 1;
    const valAt = (s, t) => s.points.find((p) => p[0] === t)?.[1];
    function focusT(i, pt) {
      idx = Math.max(0, Math.min(tl.length - 1, i));
      const t = tl[idx], X = x(t);
      hair.setAttribute("x1", X); hair.setAttribute("x2", X); hair.setAttribute("visibility", "visible");
      const rows = [];
      series.forEach((s, k) => {
        const v = valAt(s, t);
        if (v == null) { dots[k].setAttribute("visibility", "hidden"); return; }
        dots[k].setAttribute("cx", X); dots[k].setAttribute("cy", y(v)); dots[k].setAttribute("visibility", "visible");
        rows.push({ label: s.name, value: yFmt(v), color: s.color, dash: s.dash || (s.dashFrom != null && t > s.dashFrom) });
      });
      const b = band?.points.find((p) => p[0] === t);
      if (b) rows.push({ label: band.name || "80% range", value: `${yFmt(b[1])}–${yFmt(b[2])}`, color: band.color });
      const r = svg.getBoundingClientRect();
      showTip(pt || { x: r.left + (X / W) * r.width, y: r.top + 20 }, qlabel(t), rows);
    }
    const clear = () => { hair.setAttribute("visibility", "hidden"); dots.forEach((d) => d.setAttribute("visibility", "hidden")); hideTip(); };
    hit.addEventListener("pointermove", (e) => {
      const r = svg.getBoundingClientRect(), px = ((e.clientX - r.left) / r.width) * W;
      let best = 0;
      tl.forEach((t, i) => { if (Math.abs(x(t) - px) < Math.abs(x(tl[best]) - px)) best = i; });
      focusT(best, { x: e.clientX, y: e.clientY });
    });
    hit.addEventListener("pointerleave", clear);
    hit.addEventListener("blur", clear);
    hit.addEventListener("focus", () => focusT(idx));
    hit.addEventListener("keydown", (e) => {
      if (e.key === "ArrowLeft") { focusT(idx - 1); e.preventDefault(); }
      if (e.key === "ArrowRight") { focusT(idx + 1); e.preventDefault(); }
    });
    box.append(svg);
  }

  function legend(items) {
    const l = el("div", { class: "legend" });
    items.forEach(({ label, color, dash, box }) => {
      const s = el("span"), i = el("i", { class: box ? "box" : dash ? "dash" : "" });
      box ? (i.style.background = color) : (i.style.borderColor = color);
      s.append(i, document.createTextNode(label));
      l.append(s);
    });
    return l;
  }

  function table(headers, rows, bestCol) {
    const t = el("table"), thead = el("thead"), tr = el("tr");
    headers.forEach((h) => tr.append(el("th", {}, h)));
    thead.append(tr); t.append(thead);
    const tb = el("tbody");
    rows.forEach((r) => {
      const row = el("tr");
      r.forEach((c, i) => row.append(el("td", bestCol && bestCol(r, i) ? { class: "best" } : {}, c)));
      tb.append(row);
    });
    t.append(tb);
    return t;
  }

  /* ---------------- Georgian door illustration ---------------- */
  function georgianDoor(colour) {
    const ink = "#1d2b33", stone = "#e7dcc6", glass = "#fbefc1", brass = "#c9a24a";
    const svg = sv("svg", { viewBox: "0 0 120 190", "aria-hidden": "true" });
    const add = (tag, attrs) => { const e = sv(tag, attrs); svg.append(e); return e; };
    add("rect", { x: 3, y: 44, width: 14, height: 146, fill: stone, stroke: ink, "stroke-width": 1.5 });
    add("rect", { x: 103, y: 44, width: 14, height: 146, fill: stone, stroke: ink, "stroke-width": 1.5 });
    add("path", { d: "M12,54 A48,48 0 0 1 108,54 Z", fill: stone, stroke: ink, "stroke-width": 1.5 });
    add("path", { d: "M20,54 A40,40 0 0 1 100,54 Z", fill: glass, stroke: ink, "stroke-width": 1.5 });
    for (let a = 15; a < 180; a += 30) {
      const r = (a * Math.PI) / 180;
      add("line", { x1: 60, y1: 54, x2: 60 + 40 * Math.cos(r), y2: 54 - 40 * Math.sin(r), stroke: ink, "stroke-width": 1.1 });
    }
    add("path", { d: "M50,54 A10,10 0 0 1 70,54 Z", fill: ink });
    add("rect", { x: 20, y: 56, width: 80, height: 130, fill: colour, stroke: ink, "stroke-width": 2 });
    [[27, 64], [63, 64], [27, 104], [63, 104], [27, 146], [63, 146]].forEach(([px, py], k) =>
      add("rect", { x: px, y: py, width: 30, height: k > 3 ? 32 : 34, fill: "none", stroke: "rgba(0,0,0,.28)", "stroke-width": 1.5, rx: 1 }));
    add("circle", { cx: 60, cy: 96, r: 4, fill: brass, stroke: ink, "stroke-width": 1 });
    add("circle", { cx: 60, cy: 104, r: 6, fill: "none", stroke: brass, "stroke-width": 2 });
    add("rect", { x: 47, y: 138, width: 26, height: 5, rx: 1, fill: brass, stroke: ink, "stroke-width": .8 });
    add("circle", { cx: 91, cy: 124, r: 3.2, fill: brass, stroke: ink, "stroke-width": .8 });
    add("rect", { x: 8, y: 185, width: 104, height: 5, fill: stone, stroke: ink, "stroke-width": 1.2 });
    return svg;
  }

  /* ---------------- hero tiles ---------------- */
  (function tiles() {
    const L = dub.latest, peak = dub.peak_2007_08, f4 = dub.forecast[dub.forecast.length - 1];
    const price = dub.prices.find((p) => p[0] === meta.yield_year);
    const data = [
      { label: "Average new-tenancy rent, Dublin", value: euro(L.rent), foot: [`${qlabel(L.t)} · `, pct(L.yoy), " on a year earlier"] },
      { label: "Compared with the 2007–08 peak", value: pct(L.rent / peak.rent - 1, 0), foot: [`Peak ${euro(peak.rent)} in ${qlabel(peak.t)}`] },
      { label: `Forecast for ${qlabel(f4.t)}`, value: euro(f4.mid), foot: [`80% range ${euro(f4.lo)}–${euro(f4.hi)}`] },
      { label: `Median Dublin sale price, ${meta.yield_year}`, value: euro(price?.[1]), foot: [`${(price?.[2] || 0).toLocaleString("en-IE")} market sales`] },
    ];
    const box = $("#tiles");
    const colours = ["#c63b2f", "#1f6f54", "#2b4f8e", "#e0a526"];
    box.replaceChildren(...data.map((d, i) => {
      const c = el("div", { class: "door" });
      const plaque = el("div", { class: "plaque" });
      const foot = el("div", { class: "tfoot" });
      d.foot.forEach((part, k) => foot.append(k === 1 && d.foot.length === 3 ? el("span", { class: "delta-up" }, part) : document.createTextNode(part)));
      plaque.append(el("div", { class: "label" }, d.label), el("div", { class: "value" }, d.value), foot);
      c.append(georgianDoor(colours[i]), plaque);
      return c;
    }));
  })();

  /* ---------------- fair-rent checker ---------------- */
  const C = Object.fromEntries(segs.cols.map((c, i) => [c, i]));
  const areaKey = (r) => `${r[C.area]}|${r[C.district]}`;
  const areaLabel = (r) => r[C.district] === "Co. Dublin" ? `${r[C.area]}, Co. Dublin` : `${r[C.area]}, Dublin ${r[C.district].slice(1)}`;
  const areas = new Map();
  segs.rows.forEach((r) => { const k = areaKey(r); if (!areas.has(k)) areas.set(k, { label: areaLabel(r), rows: [] }); areas.get(k).rows.push(r); });
  const labelToKey = new Map([...areas].map(([k, a]) => [a.label.toLowerCase(), k]));
  $("#areaList").replaceChildren(...[...areas.values()].sort((a, b) => a.label.localeCompare(b.label)).map((a) => el("option", { value: a.label })));
  $("#checkSub").textContent = `Typical rents for ${segs.rows.length} area and unit combinations, nowcast for ${meta.nowcast_for} from RTB data to ${meta.rent_data_to}.`;

  let current = null;
  function fillSelect(sel, values, names, preferred) {
    sel.replaceChildren(...values.map((v) => el("option", { value: v }, names[v] || v)));
    sel.value = values.includes(preferred) ? preferred : values[0];
  }
  function onArea() {
    const key = labelToKey.get($("#areaInput").value.trim().toLowerCase());
    current = key ? areas.get(key) : null;
    if (!current) { renderCheck(); return; }
    const beds = Object.keys(BEDS).filter((b) => current.rows.some((r) => r[C.beds] === b));
    fillSelect($("#bedsSel"), beds, BEDS, $("#bedsSel").value || "Two bed");
    onBeds();
  }
  function onBeds() {
    const b = $("#bedsSel").value;
    const types = Object.keys(TYPES).filter((t) => current.rows.some((r) => r[C.beds] === b && r[C.ptype] === t));
    fillSelect($("#typeSel"), types, TYPES, $("#typeSel").value || "Apartment");
    renderCheck();
  }
  function renderCheck() {
    const out = $("#checkResult");
    if (!current) { out.replaceChildren(el("div", { class: "receipt-paper" }), el("p", { class: "muted" }, "Choose an area from the list to see its typical rent.")); return; }
    const r = current.rows.find((x) => x[C.beds] === $("#bedsSel").value && x[C.ptype] === $("#typeSel").value);
    if (!r) return;
    const [typ, lo, hi] = [r[C.typical], r[C.lo], r[C.hi]];
    const ask = parseFloat($("#askInput").value);
    const rh = el("div", { class: "r-head" });
    rh.append(el("span", {}, "Rent check"), el("span", {}, `Nowcast · ${meta.nowcast_for}`));
    const line = (k, v) => { const l = el("div", { class: "line" }); l.append(el("span", {}, k), el("span"), el("b", {}, v)); return l; };
    const head = el("div", { class: "typical" });
    head.append(el("span", { class: "big" }, euro(typ)), el("span", { class: "per" }, "/ month, typical"));
    const nodes = [el("div", { class: "receipt-paper" }), rh,
      line("Area", areaLabel(r)), line("Size", BEDS[r[C.beds]]), line("Type", TYPES[r[C.ptype]]),
      line("Asking", ask > 0 ? euro(ask) : "—"), head, el("div", { class: "range" }, `80% range ${euro(lo)}–${euro(hi)}`)];
    if (ask > 0) {
      const diff = ask / typ - 1;
      let cls, icon, text;
      if (ask > hi) { const big = diff > 0.15; cls = big ? "critical" : "warning"; icon = big ? "!!" : "!"; text = `${big ? "Way over" : "Above typical"} ${pct(diff, 0)}`; }
      else if (ask < lo) { cls = "good"; icon = "↓"; text = `Below typical ${pct(diff, 0)}`; }
      else { cls = "good"; icon = "✓"; text = `Fair · ${pct(diff, 0)}`; }
      const v = el("div", { class: `stamp ${cls}`, role: "status" }); v.append(el("i", { "aria-hidden": "true" }, icon), document.createTextNode(text));
      nodes.push(v);
    }
    nodes.push(gauge(lo, typ, hi, ask > 0 ? ask : null));
    nodes.push(el("p", { class: "explain" },
      `${BEDS[r[C.beds]]}, ${TYPES[r[C.ptype]].toLowerCase()} in ${areaLabel(r)}. The RTB last recorded an average of ` +
      `${euro(r[C.last_rent])} for new tenancies here in ${qlabel(r[C.last_t])}; the model projects that to ${meta.nowcast_for} ` +
      `using how similar segments and the district have been moving. Individual homes vary more than averages, so treat the range as a guide.`));
    out.replaceChildren(...nodes);
  }
  function gauge(lo, typ, hi, ask) {
    // draw at the real width so the labels stay legible on phones
    const W = Math.max(260, Math.min(560, $("#checkResult").clientWidth - 56)), H = 86, m = 16;
    const vmin = Math.min(lo, ask ?? lo) * 0.9, vmax = Math.max(hi, ask ?? hi) * 1.08;
    const x = lin(vmin, vmax, m, W - m);
    const svg = sv("svg", { viewBox: `0 0 ${W} ${H}`, class: "gauge", role: "img",
      "aria-label": `Typical ${euro(typ)}, range ${euro(lo)} to ${euro(hi)}${ask ? `, asking ${euro(ask)}` : ""}` });
    svg.append(sv("line", { x1: m, x2: W - m, y1: 44, y2: 44, class: "baseline" }));
    svg.append(sv("rect", { x: x(lo), y: 32, width: x(hi) - x(lo), height: 24, rx: 4 }, { fill: "var(--s1)", opacity: 0.22 }));
    svg.append(sv("line", { x1: x(typ), x2: x(typ), y1: 28, y2: 60 }, { stroke: "var(--s1)", strokeWidth: 3 }));
    const lab = (X, Y, txt, anchor = "middle", cls = "lbl") => { const t = sv("text", { x: X, y: Y, "text-anchor": anchor, class: cls }); t.textContent = txt; svg.append(t); };
    lab(x(lo), 76, euro(lo)); lab(x(hi), 76, euro(hi)); lab(x(typ), 20, `typical ${euro(typ)}`, "middle", "endlabel");
    if (ask) {
      const X = x(ask);
      svg.append(sv("path", { d: `M${X - 7},${66} L${X + 7},${66} L${X},${57} Z` }, { fill: "var(--ink)" }));
      svg.append(sv("line", { x1: X, x2: X, y1: 30, y2: 58 }, { stroke: "var(--ink)", strokeWidth: 2, strokeDasharray: "3 2" }));
      lab(Math.min(Math.max(X, 60), W - 60), 84, `asking ${euro(ask)}`, "middle", "endlabel");
    }
    return svg;
  }
  $("#areaInput").addEventListener("change", onArea);
  $("#areaInput").addEventListener("input", () => { if (labelToKey.has($("#areaInput").value.trim().toLowerCase())) onArea(); });
  $("#bedsSel").addEventListener("change", onBeds);
  $("#typeSel").addEventListener("change", renderCheck);
  $("#askInput").addEventListener("input", renderCheck);
  addEventListener("resize", () => { clearTimeout(renderCheck.t); renderCheck.t = setTimeout(renderCheck, 150); });
  $("#checkForm").addEventListener("submit", (e) => e.preventDefault());
  function setArea(label) {
    $("#areaInput").value = label; onArea();
    document.getElementById("check").scrollIntoView({ behavior: "smooth" });
  }
  // start with a real example so the tool is never empty
  const starter = [...areas.values()].find((a) => a.label.startsWith("Rathmines")) || [...areas.values()][0];
  $("#areaInput").value = starter.label; onArea();

  /* ---------------- tile map ---------------- */
  const lfl2 = (d) => d.like_for_like["Two bed|Apartment"]?.typical ?? null;
  const METRICS = [
    { id: "lfl2", label: "2-bed apartment, typical now", get: lfl2, fmt: euro,
      note: `Typical rent for a two-bed apartment, nowcast for ${meta.nowcast_for}: the median across the district's neighbourhoods. Like-for-like, so it isn't skewed by the mix of homes. Striped tiles don't have enough recent two-bed apartment data.` },
    { id: "avg", label: "Average rent, all new tenancies", get: (d) => d.latest, fmt: euro,
      note: `Average rent for all new tenancies in ${meta.rent_data_to}. It reflects the mix of homes (lots of small flats pull it down) as well as price.` },
    { id: "yoy", label: "Change over 12 months", get: (d) => d.yoy, fmt: (v) => pct(v),
      note: `Change in the average rent for new tenancies, ${qlabel(meta.rent_t - 4)} to ${meta.rent_data_to}.` },
    { id: "yield", label: "Gross yield (rent vs buy)", get: (d) => d.sales.gross_yield, fmt: (v) => (v == null ? "n/a" : (v * 100).toFixed(1) + "%"),
      note: `12 × the ${meta.yield_year} average rent ÷ the ${meta.yield_year} median sale price. Higher means buying is cheaper relative to renting.` },
  ];
  let metric = METRICS[0], selected = "D8";
  const bar = $("#metricBar");
  METRICS.forEach((mt) => {
    const b = el("button", { class: "chip", role: "radio", type: "button", "aria-checked": String(mt === metric) }, mt.label);
    b.addEventListener("click", () => { metric = mt; [...bar.children].forEach((c) => c.setAttribute("aria-checked", String(c === b))); renderMap(); });
    bar.append(b);
  });
  function quantileBreaks(values, k = 6) {
    const s = values.slice().sort((a, b) => a - b);
    return Array.from({ length: k - 1 }, (_, i) => s[Math.floor(((i + 1) * s.length) / k)]);
  }
  function renderMap() {
    const box = $("#tilemap");
    const vals = dists.map((d) => metric.get(d)).filter((v) => v != null);
    const br = quantileBreaks(vals);
    const bin = (v) => br.filter((b) => v >= b).length;
    const tiles = dists.map((d) => {
      const [c, r] = POS[d.id], v = metric.get(d);
      const b = el("button", { class: `dtile ${r <= 1 ? "north" : "south"}`, type: "button", "aria-pressed": String(d.id === selected),
        "aria-label": `${d.id} ${NAMES[d.id]}: ${metric.fmt(v)}` });
      b.style.gridColumn = c + 1; b.style.gridRow = r + 1;
      if (v == null) { b.style.background = "var(--na)"; b.style.color = "var(--ink-2)"; }
      else { const k = bin(v); b.style.background = `var(--q${k})`; b.style.color = `var(--qi${k})`; }
      b.append(el("span", { class: "id" }, d.id), el("span", { class: "v" }, metric.fmt(v)));
      b.addEventListener("click", () => { selected = d.id; renderMap(); renderPanel(); });
      const tipRows = () => [{ label: metric.label, value: metric.fmt(v) }, { label: "Average rent", value: euro(d.latest) }, { label: "12-month change", value: pct(d.yoy) }];
      b.addEventListener("pointermove", (e) => showTip({ x: e.clientX, y: e.clientY }, `${d.id} · ${NAMES[d.id]}`, tipRows()));
      b.addEventListener("pointerleave", hideTip);
      b.addEventListener("focus", () => showTip(rectPoint(b), `${d.id} · ${NAMES[d.id]}`, tipRows()));
      b.addEventListener("blur", hideTip);
      return b;
    });
    const river = sv("svg", { class: "liffey", viewBox: "0 0 100 14", preserveAspectRatio: "none", "aria-hidden": "true" });
    river.append(sv("path", { d: "M0,7 C10,3 20,11 30,7 S50,3 60,7 S75,11 82,7 L100,7" }));
    const bay = el("div", { class: "bay", "aria-hidden": "true" }, "~ Dublin Bay ~");
    Object.assign(bay.style, { gridColumn: "5", gridRow: "3 / span 3" });
    box.replaceChildren(...tiles, bay, river);
    // legend
    const lg = $("#mapLegend");
    const edges = [Math.min(...vals), ...br, Math.max(...vals)];
    lg.replaceChildren(...edges.slice(0, -1).map((e, i) => {
      const s = el("span", { class: "sw" }), sw = el("i"); sw.style.background = `var(--q${i})`;
      s.append(sw, document.createTextNode(`${metric.fmt(e)}–${metric.fmt(edges[i + 1])}`));
      return s;
    }));
    if (dists.some((d) => metric.get(d) == null)) { const s = el("span", { class: "sw" }), sw = el("i"); sw.style.background = "var(--na)"; s.append(sw, document.createTextNode("not enough data")); lg.append(s); }
    $("#mapNote").textContent = metric.note;
  }

  /* ---------------- district panel ---------------- */
  const dubSeries = dub.series.map(([t, v]) => [t, v]);
  function renderPanel() {
    const d = byId[selected], p = $("#panel");
    const lastOfficial = Math.max(...d.series.filter((s) => s[2] === "o").map((s) => s[0]));
    const pts = d.series.map(([t, v]) => [t, v]);
    const last = pts[pts.length - 1];
    const fc = [[last[0], last[1], last[1]], ...d.forecast.map((f) => [f.t, f.lo, f.hi])];
    const fcMid = [last, ...d.forecast.map((f) => [f.t, f.mid])];
    const head = el("div");
    head.append(el("h3", {}, d.id), el("span", { class: "area-name" }, NAMES[d.id]));
    const nbs = el("div", { class: "nbs" });
    d.neighbourhoods.slice(0, 14).forEach((n) => {
      const lab = `${n}, Dublin ${d.id.slice(1)}`;
      if (!labelToKey.has(lab.toLowerCase())) return;
      const b = el("button", { type: "button", title: "Check a rent here" }, n);
      b.addEventListener("click", () => setArea(lab));
      nbs.append(b);
    });
    const s = d.sales, twoBed = lfl2(d);
    const kv = el("div", { class: "kv" });
    [[euro(d.latest), `Average rent, ${meta.rent_data_to}`], [pct(d.yoy), "Change over 12 months"],
     [twoBed ? euro(twoBed) : "n/a", `2-bed apartment, ${meta.nowcast_for}`], [pct(d.since_2015, 0), "Rent change since 2015"],
     [euro(s.median_price), `Median sale price, ${meta.yield_year}`], [s.gross_yield ? (s.gross_yield * 100).toFixed(1) + "%" : "n/a", "Gross yield"],
    ].forEach(([v, l]) => { const c = el("div"); c.append(el("b", {}, v), el("span", {}, l)); kv.append(c); });
    const chart = el("div", { class: "chart" });
    const lg = legend([
      { label: `${d.id} average`, color: "var(--s1)" },
      { label: "reconstructed (after 2021)", color: "var(--s1)", dash: true },
      { label: "Dublin average", color: "var(--ctx)" },
      { label: "forecast, 80% range", color: "var(--s1)", box: true },
    ]);
    const note = el("p", { class: "note" },
      `RTB stopped publishing postal-district averages after ${qlabel(lastOfficial)}; later values are rebuilt from the district's neighbourhoods (validated error ${evals.reconstruction.mape_by_years_since_anchor["4"].toFixed(1)}% four years out). Hover or use arrow keys on the chart to read values.`);
    p.replaceChildren(head, nbs, kv, lg, chart, note);
    lineChart(chart, {
      title: `${d.id} average rent by quarter, with forecast`, height: 280,
      series: [
        { name: d.id, color: "var(--s1)", points: pts, dashFrom: lastOfficial },
        { name: "Dublin", color: "var(--ctx)", points: dubSeries },
        { name: "Forecast", color: "var(--s1)", points: fcMid, dash: true, label: false },
      ],
      band: { name: "80% range", color: "var(--s1)", points: fc },
    });
  }

  /* ---------------- rent vs buy ---------------- */
  function yieldChart() {
    const box = $("#yieldChart");
    const items = dists.filter((d) => d.sales.gross_yield).map((d) => ({ id: d.id, v: d.sales.gross_yield, d })).sort((a, b) => b.v - a.v);
    const W = Math.max(300, box.clientWidth), row = 20, gap = 2, m = { l: 44, r: 52, t: 6, b: 22 };
    const H = m.t + items.length * row + m.b;
    const x = lin(0, Math.max(...items.map((i) => i.v)) * 1.05, m.l, W - m.r);
    const svg = sv("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Gross rental yield by district, ranked" });
    niceTicks(0, Math.max(...items.map((i) => i.v)) * 1.05, 4).forEach((v) => {
      svg.append(sv("line", { x1: x(v), x2: x(v), y1: m.t, y2: H - m.b, class: v === 0 ? "baseline" : "gridline" }));
      const t = sv("text", { x: x(v), y: H - 6, "text-anchor": "middle", class: "lbl" }); t.textContent = (v * 100).toFixed(0) + "%"; svg.append(t);
    });
    const labelled = new Set([...items.slice(0, 3), ...items.slice(-3)].map((i) => i.id));
    items.forEach((it, i) => {
      const Y = m.t + i * row, h = row - gap, X1 = x(it.v), X0 = x(0), r = Math.min(4, h / 2);
      const lab = sv("text", { x: m.l - 6, y: Y + h / 2 + 4, "text-anchor": "end", class: "lbl" }); lab.textContent = it.id; svg.append(lab);
      const bar = sv("path", { d: `M${X0},${Y} H${X1 - r} Q${X1},${Y} ${X1},${Y + r} V${Y + h - r} Q${X1},${Y + h} ${X1 - r},${Y + h} H${X0} Z`,
        class: "bar", tabindex: 0, "aria-label": `${it.id}: ${(it.v * 100).toFixed(1)}%` }, { fill: "var(--s1)" });
      const rows = () => [{ label: "Gross yield", value: (it.v * 100).toFixed(2) + "%" }, { label: "Median price", value: euro(it.d.sales.median_price) },
        { label: "Average rent", value: euro(it.d.sales.median_price * it.v / 12) }, { label: "Years of rent to buy", value: it.d.sales.price_to_rent.toFixed(1) }];
      bar.addEventListener("pointermove", (e) => showTip({ x: e.clientX, y: e.clientY }, `${it.id} · ${NAMES[it.id]}`, rows()));
      bar.addEventListener("pointerleave", hideTip);
      bar.addEventListener("focus", () => showTip(rectPoint(bar), `${it.id} · ${NAMES[it.id]}`, rows()));
      bar.addEventListener("blur", hideTip);
      svg.append(bar);
      if (labelled.has(it.id)) { const t = sv("text", { x: X1 + 6, y: Y + h / 2 + 4, class: "lbl" }); t.textContent = (it.v * 100).toFixed(1) + "%"; svg.append(t); }
    });
    box.replaceChildren(svg);
    $("#yieldTable").replaceChildren(table(["District", "Median price", "Avg rent", "Gross yield", "Years of rent"],
      items.map((i) => [`${i.id} ${NAMES[i.id]}`, euro(i.d.sales.median_price), euro(i.d.sales.median_price * i.v / 12), (i.v * 100).toFixed(2) + "%", i.d.sales.price_to_rent.toFixed(1)])));
    const hi = items[0], lo = items[items.length - 1];
    $("#buySub").textContent = `In ${meta.yield_year}, a typical home cost ${hi.d.sales.price_to_rent.toFixed(0)} years of average rent in ${hi.id} (${NAMES[hi.id]}) but ${lo.d.sales.price_to_rent.toFixed(0)} years in ${lo.id} (${NAMES[lo.id]}).`;
  }

  function bedsChart() {
    const colors = ["var(--s1)", "var(--s2)", "var(--s3)", "var(--s4)"];
    const names = { "One bed": "1 bed", "Two bed": "2 bed", "Three bed": "3 bed", "Four plus bed": "4+ bed" };
    const series = Object.entries(dub.by_beds).map(([k, pts], i) => ({ name: names[k], color: colors[i], points: pts }));
    const box = $("#bedsChart");
    box.replaceChildren();
    box.append(legend(series.map((s) => ({ label: s.name, color: s.color }))));
    const c = el("div"); box.append(c);
    const two = series[1].points;
    const peak = two.filter(([t]) => t <= 8).reduce((a, b) => (b[1] > a[1] ? b : a));
    const low = two.filter(([t]) => t > 8 && t <= 30).reduce((a, b) => (b[1] < a[1] ? b : a));
    lineChart(c, { series, height: 300, title: "Dublin average rent by number of bedrooms",
      notes: [{ t: peak[0], v: peak[1], text: `${yearOf(peak[0])} peak`, dx: 26, dy: -34 },
              { t: low[0], v: low[1], text: `the ${yearOf(low[0])} low`, dx: 30, dy: 40 }] });
    const ts = series[0].points.map((p) => p[0]).filter((t) => (t + 3) % 4 === 3); // Q4 each year
    $("#bedsTable").replaceChildren(table(["Quarter", ...series.map((s) => s.name)],
      ts.map((t) => [qlabel(t), ...series.map((s) => euro(s.points.find((p) => p[0] === t)?.[1]))])));
  }

  /* ---------------- findings ---------------- */
  function findings() {
    const L = dub.latest, peak = dub.peak_2007_08, tr = dub.trough;
    const f4 = dub.forecast[dub.forecast.length - 1];
    const items = [];
    items.push([`Rents are ${pct(L.rent / peak.rent - 1, 0)} above the 2008 peak`,
      `The average new tenancy in Dublin cost ${euro(L.rent)} a month in ${qlabel(L.t)}, against ${euro(peak.rent)} at the 2007–08 peak and ${euro(tr.rent)} at the ${qlabel(tr.t)} low: ${pct(L.rent / tr.rent - 1, 0)} since the bottom.`]);
    // averages vs like-for-like: the pair with the biggest ranking flip
    let best = null;
    for (const a of dists) for (const b of dists) {
      const la = lfl2(a), lb = lfl2(b);
      if (!la || !lb || a.latest >= b.latest || la <= lb) continue;
      const score = (b.latest - a.latest) / b.latest + (la - lb) / lb;
      if (!best || score > best.score) best = { a, b, la, lb, score };
    }
    if (best) items.push([`Averages mislead: ${best.a.id} looks cheaper than ${best.b.id}, but isn't`,
      `${best.a.id}'s average rent (${euro(best.a.latest)}) is below ${best.b.id}'s (${euro(best.b.latest)}) because of its mix of smaller, older homes. Compare the same home, a two-bed apartment, and ${best.a.id} costs ${euro(best.la)} against ${euro(best.lb)}.`]);
    const fast = dists.filter((d) => d.yoy != null).sort((a, b) => b.yoy - a.yoy);
    items.push([`${fast[0].id} rose fastest: ${pct(fast[0].yoy)} in a year`,
      `${NAMES[fast[0].id]} outpaced Dublin as a whole (${pct(L.yoy)}), followed by ${fast[1].id} (${pct(fast[1].yoy)}). The slowest was ${fast[fast.length - 1].id} at ${pct(fast[fast.length - 1].yoy)}.`]);
    const ys = dists.filter((d) => d.sales.gross_yield).sort((a, b) => b.sales.gross_yield - a.sales.gross_yield);
    const hi = ys[0], lo = ys[ys.length - 1];
    items.push([`Buying is relatively cheapest in ${hi.id}`,
      `A home in ${NAMES[hi.id]} cost about ${hi.sales.price_to_rent.toFixed(0)} years of average rent in ${meta.yield_year} (gross yield ${(hi.sales.gross_yield * 100).toFixed(1)}%). In ${NAMES[lo.id]} (${lo.id}) it was ${lo.sales.price_to_rent.toFixed(0)} years.`]);
    const h4 = evals.forecast.by_horizon[3];
    items.push([`Expect about ${pct(f4.mid / L.rent - 1)} by ${qlabel(f4.t)}`,
      `The district model forecasts Dublin's average at ${euro(f4.mid)} (80% range ${euro(f4.lo)}–${euro(f4.hi)}). In backtests four quarters ahead it erred by ${h4.model.toFixed(1)}% on average, against ${h4.drift.toFixed(1)}% for "last year's trend continues".`]);
    $("#findingsList").replaceChildren(...items.map(([t, p]) => { const li = el("li"); li.append(el("b", {}, t), el("p", {}, p)); return li; }));
  }

  /* ---------------- methods ---------------- */
  function methods() {
    const fr = evals.fair_rent, fc = evals.forecast, rc = evals.reconstruction;
    const card = (title, headline, sub, body, tbl) => {
      const c = el("div", { class: "card" });
      c.append(el("h3", {}, title), el("div", { class: "headline" }, headline), el("p", { class: "muted" }, sub), el("p", {}, body));
      if (tbl) c.append(tbl);
      return c;
    };
    const f1 = (v) => v.toFixed(2) + "%";
    const bestOf = (r, i) => i > 0 && i < 4 && r[i] === [r[1], r[2], r[3]].reduce((a, b) => (parseFloat(a) <= parseFloat(b) ? a : b));
    $("#methodGrid").replaceChildren(
      card("Fair-rent nowcast", f1(fr.mape.model), "mean absolute % error, 2025 held out",
        `Gradient-boosted quantile regression learns each segment's growth since its last RTB figure, as a correction to the district trend. ` +
        `Trained to 2023, calibrated on 2024 (conformal), tested on 2025 with data frozen at 2024 Q4. The 80% ranges covered ${(fr.interval.coverage * 100).toFixed(0)}% of outcomes.`,
        table(["Quarters stale", "Model", "Trend", "Carry fwd"], fr.by_age.map((r) => [String(r.age), f1(r.model), f1(r.district_drift), f1(r.carry_forward)]), bestOf)),
      card("District forecast", f1(fc.by_horizon[3].model), "error four quarters ahead",
        `One global model pools all 22 districts to learn next-quarter growth from recent growth and seasonality, then runs recursively. ` +
        `Rolling-origin backtest over ${fc.origins} forecast origins; the 80% bands are the model's own historical errors.`,
        table(["Horizon", "Model", "Trend", "No change"], fc.by_horizon.map((r) => [`${r.h}q`, f1(r.model), f1(r.drift), f1(r.naive)]), bestOf)),
      card("District reconstruction", f1(rc.mape), `mean error over ${rc.quarters_compared} district-quarters`,
        "RTB stopped publishing postal-district averages after 2021. Each is extended by chain-linking the growth of its neighbourhoods. " +
        "To measure the error, the same method rebuilt 2014–2021 from a 2013 starting point and was compared with the official figures.",
        table(["Years out", "Error"], Object.entries(rc.mape_by_years_since_anchor).map(([k, v]) => [k, f1(v)]))),
    );
    $("#provenance").textContent = `Rent data to ${meta.rent_data_to}; sales to ${meta.sales_to}; nowcast for ${meta.nowcast_for}. ` +
      `Regenerated ${meta.generated} by the pipeline in ${meta.runtime_s}s (${meta.n_rent_rows.toLocaleString("en-IE")} rent rows, ${meta.n_sales.toLocaleString("en-IE")} Dublin sales).`;
  }

  /* ---------------- render + responsive ---------------- */
  function renderAll() { renderMap(); renderPanel(); yieldChart(); bedsChart(); }
  renderAll(); findings(); methods();
  let rt;
  addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(() => { yieldChart(); bedsChart(); renderPanel(); }, 150); });
})();
