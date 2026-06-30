/* ============================================================
   HidroMet — Climatología (réplica de la metodología PISCO para Ecuador).
   Normales 1991–2020 grilladas a 0.05° (precip/Tmáx/Tmín/PET) corregidas con
   estaciones. Cuatro pestañas: Mapas · Por estación · Por coordenada · Metodología.
   Backend: /api/clima/* (app/modulos/clima/datos.py).
   ============================================================ */
"use strict";

(() => {
  const esc = v => String(v ?? "").replace(/[&<>"']/g,
    c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const num = (v, d = 0) => (v == null || isNaN(v) ? "—" : Number(v).toLocaleString("es-EC",
    { minimumFractionDigits: d, maximumFractionDigits: d }));

  const VARS = [
    { id: "precip", et: "Precipitación", u: "mm" },
    { id: "tmax", et: "T. máxima", u: "°C" },
    { id: "tmin", et: "T. mínima", u: "°C" },
    { id: "pet", et: "PET", u: "mm" },
    { id: "balance", et: "Balance P−PET", u: "mm/año", soloAnual: true },
    { id: "aridez", et: "Aridez P/PET", u: "", soloAnual: true },
  ];
  const MESES = ["Anual", "Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];
  const COL = { precip: "#2f7fc1", pet: "#d08a2e", tmax: "#e0562d", tmin: "#2e8bc0", obs: "#10243f" };

  // Estilos del módulo (inyectados una vez) ----------------------------------
  function inyectarCSS() {
    if (document.getElementById("clima-css")) return;
    const s = document.createElement("style");
    s.id = "clima-css";
    s.textContent = `
      .cl-wrap{display:flex;flex-direction:column;gap:14px}
      .cl-toolbar{display:flex;flex-wrap:wrap;gap:14px;align-items:flex-end;
        background:var(--surface,#fff);border:1px solid var(--line,#e2e7ee);border-radius:13px;
        padding:12px 14px;box-shadow:var(--shadow-card,0 1px 2px rgba(20,30,50,.05))}
      .cl-grupo{display:flex;flex-direction:column;gap:6px}
      .cl-grupo>span{font:600 10px var(--mono,monospace);letter-spacing:.07em;text-transform:uppercase;color:var(--faint,#8a93a3)}
      .cl-pills{display:flex;flex-wrap:wrap;gap:6px}
      .cl-pill{border:1px solid var(--line,#d7dde6);background:var(--surface-2,#f6f8fb);color:var(--muted,#5b6678);
        border-radius:999px;padding:6px 13px;font:600 12.5px var(--fuente,sans-serif);cursor:pointer;transition:all .14s}
      .cl-pill:hover{border-color:var(--blue,#2f7fc1)}
      .cl-pill.on{background:var(--blue,#2f7fc1);border-color:var(--blue,#2f7fc1);color:#fff;box-shadow:0 2px 8px rgba(47,127,193,.25)}
      .cl-meses{display:flex;flex-wrap:wrap;gap:4px}
      .cl-mes{min-width:30px;text-align:center;border:1px solid var(--line,#d7dde6);background:var(--surface-2,#f6f8fb);
        color:var(--muted,#5b6678);border-radius:8px;padding:5px 8px;font:600 11.5px var(--mono,monospace);cursor:pointer}
      .cl-mes.on{background:var(--ink,#1f2a3a);border-color:var(--ink,#1f2a3a);color:#fff}
      .cl-card{background:var(--surface,#fff);border:1px solid var(--line,#e2e7ee);border-radius:13px;
        padding:14px 16px;box-shadow:var(--shadow-card,0 1px 2px rgba(20,30,50,.05))}
      .cl-maptit{font:600 14px var(--fuente,sans-serif);color:var(--ink,#1f2a3a);margin:0 0 8px}
      .cl-plot{width:100%}
      .cl-grid2{display:grid;grid-template-columns:minmax(0,1.15fr) minmax(260px,.85fr);gap:14px;align-items:start}
      @media(max-width:920px){.cl-grid2{grid-template-columns:1fr}}
      .cl-kpis{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:4px}
      .cl-kpi{background:var(--surface-2,#f6f8fb);border:1px solid var(--line-3,#eaeef4);border-radius:10px;padding:10px 12px}
      .cl-kpi .v{font:700 19px var(--mono,monospace);color:var(--ink,#1f2a3a)}
      .cl-kpi .v small{font-size:11px;color:var(--muted-2,#8a93a3);font-weight:600}
      .cl-kpi .e{font:600 10px var(--mono,monospace);letter-spacing:.05em;text-transform:uppercase;color:var(--faint,#8a93a3);margin-top:3px}
      .cl-conf{display:inline-flex;align-items:center;gap:7px;font-size:12px;border-radius:999px;padding:4px 11px;margin-top:2px}
      .cl-conf.ok{background:rgba(34,150,90,.12);color:#1d7a47}
      .cl-conf.med{background:rgba(216,150,30,.14);color:#9a6a12}
      .cl-conf.baja{background:rgba(196,60,40,.13);color:#a8341f}
      .cl-tabla{width:100%;border-collapse:collapse;font-size:12px;font-variant-numeric:tabular-nums;margin-top:6px}
      .cl-tabla th{font:600 10px var(--mono,monospace);letter-spacing:.04em;text-transform:uppercase;color:var(--faint,#8a93a3);
        text-align:right;padding:5px 7px;border-bottom:1px solid var(--line,#e2e7ee)}
      .cl-tabla th:first-child{text-align:left}
      .cl-tabla td{padding:4px 7px;text-align:right;border-bottom:1px solid var(--line-3,#f0f3f7);color:var(--ink-2,#3a4656)}
      .cl-tabla td:first-child{text-align:left;font-weight:600;color:var(--muted,#5b6678)}
      .cl-coords{display:flex;flex-wrap:wrap;gap:12px;align-items:flex-end}
      .cl-campo{display:flex;flex-direction:column;gap:5px}
      .cl-campo>span{font:600 10px var(--mono,monospace);letter-spacing:.06em;text-transform:uppercase;color:var(--faint,#8a93a3)}
      .cl-campo input{width:130px;border:1px solid var(--line,#d7dde6);border-radius:9px;padding:8px 11px;
        font:600 13px var(--mono,monospace);background:var(--surface,#fff);color:var(--ink,#1f2a3a)}
      .cl-btn{background:var(--blue,#2f7fc1);color:#fff;border:none;border-radius:9px;padding:9px 18px;
        font:600 13px var(--fuente,sans-serif);cursor:pointer;transition:filter .15s}
      .cl-btn:hover{filter:brightness(1.07)}
      .cl-hint{font-size:11.5px;color:var(--faint,#8a93a3);margin-top:7px}
      .cl-nota{font-size:11.5px;color:var(--muted-2,#8a93a3);line-height:1.5;margin:10px 0 0}
      .cl-glo{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:13px}
      .cl-glo-card{background:var(--surface,#fff);border:1px solid var(--line,#e2e7ee);border-radius:13px;padding:15px 17px;
        box-shadow:var(--shadow-card,0 1px 2px rgba(20,30,50,.05))}
      .cl-glo-card h4{margin:0 0 7px;font:650 13.5px var(--fuente,sans-serif);color:var(--ink,#1f2a3a);
        display:flex;align-items:center;gap:8px}
      .cl-glo-card h4::before{content:"";width:8px;height:8px;border-radius:50%;background:var(--blue,#2f7fc1);flex:0 0 auto}
      .cl-glo-card p{margin:0;font-size:12.8px;line-height:1.6;color:var(--ink-2,#3a4656)}
      .cl-glo-intro{background:linear-gradient(135deg,rgba(47,127,193,.10),rgba(47,127,193,.02));
        border:1px solid rgba(47,127,193,.22);border-radius:14px;padding:16px 19px;margin-bottom:14px}
      .cl-glo-intro h3{margin:0 0 7px;font:700 16px var(--fuente,sans-serif);color:var(--ink,#1f2a3a)}
      .cl-glo-intro p{margin:0;font-size:13.2px;line-height:1.65;color:var(--ink-2,#3a4656)}
      .cl-vacio{text-align:center;color:var(--faint,#8a93a3);padding:34px 12px;font-size:13px}
      .cl-adv{padding:0;overflow:hidden}
      .cl-adv-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:12px 16px;
        border-bottom:1px solid var(--line-3,#eef2f7);font-size:14px;color:var(--ink,#1f2a3a)}
      .cl-adv-em{font-size:11.5px;color:var(--faint,#8a93a3)}
      .cl-adv-dia{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:9px 16px;border-bottom:1px solid var(--line-3,#f2f5f9)}
      .cl-adv-dia:last-child{border-bottom:none}
      .cl-adv-d{font:600 12px var(--mono,monospace);color:var(--muted,#5b6678);min-width:130px}
      .cl-adv-v{font-size:12px;color:var(--ink-2,#3a4656);flex:1;min-width:200px}
      .cl-adv-badge{margin-left:auto;font:600 11px var(--mono,monospace);border-radius:999px;padding:3px 11px;white-space:nowrap}
      .cl-adv-badge.conf{background:rgba(34,150,90,.13);color:#1d7a47}
      .cl-adv-badge.no{background:rgba(150,160,175,.16);color:#6b7686}`;
    document.head.appendChild(s);
  }

  // Contorno provincial (geojson) reutilizable -------------------------------
  let geo = null;
  async function cargarGeo() {
    if (geo !== null) return;
    try { geo = await App.api("/datos/capas/provincias.geojson"); } catch (e) { geo = false; }
  }
  function contorno() {
    if (!geo || !geo.features) return [];
    const xs = [], ys = [];
    for (const f of geo.features) {
      const g = f.geometry; if (!g) continue;
      const polys = g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : [];
      for (const poly of polys) for (const ring of poly) {
        for (const [x, y] of ring) { xs.push(x); ys.push(y); } xs.push(null); ys.push(null);
      }
    }
    return [
      { type: "scatter", mode: "lines", x: xs, y: ys, hoverinfo: "skip", showlegend: false,
        line: { color: "rgba(255,255,255,.85)", width: 2.4 } },
      { type: "scatter", mode: "lines", x: xs, y: ys, hoverinfo: "skip", showlegend: false,
        line: { color: "rgba(40,55,80,.55)", width: 0.8 } },
    ];
  }

  // Mapa de una normal --------------------------------------------------------
  function pintarMapa(host, d) {
    if (!window.Plotly || !host) return;
    if (!d || d.error) { host.innerHTML = `<div class="cl-vacio">${esc(d && d.error || "Sin datos")}</div>`; return; }
    const dec = (d.variable === "tmax" || d.variable === "tmin") ? 1 : (d.variable === "aridez" ? 2 : 0);
    const heat = {
      type: "heatmap", x: d.lon, y: d.lat, z: d.campo, colorscale: d.colorscale,
      zmin: d.vmin, zmax: d.vmax, zsmooth: "best", hoverongaps: false,
      colorbar: { title: { text: d.unidad || "", side: "right", font: { size: 11 } }, thickness: 13,
        len: 0.9, outlinewidth: 0, tickfont: { size: 10 }, x: 1.01 },
      hovertemplate: `lat %{y:.2f}, lon %{x:.2f}<br><b>%{z:.${dec}f} ${esc(d.unidad || "")}</b><extra></extra>`,
    };
    const layout = App.plotlyLayoutBase({
      height: 540, margin: { l: 6, r: 6, t: 6, b: 6 },
      xaxis: { visible: false, scaleanchor: "y", constrain: "domain", fixedrange: false },
      yaxis: { visible: false, fixedrange: false },
    });
    Plotly.react(host, [heat, ...contorno()], layout, App.plotlyConfig());
  }

  // Climograma (barras precip + líneas temp + PET + obs) ----------------------
  function pintarClimograma(host, p) {
    if (!window.Plotly || !host) return;
    const meses = p.meses || MESES.slice(1);
    const V = p.vars || {};
    const traces = [];
    if (V.precip) traces.push({ type: "bar", x: meses, y: V.precip.valores, name: "Precipitación",
      marker: { color: COL.precip, opacity: .82 }, yaxis: "y", hovertemplate: "%{y} mm<extra>Precip</extra>" });
    if (V.pet) traces.push({ type: "scatter", mode: "lines", x: meses, y: V.pet.valores, name: "PET",
      line: { color: COL.pet, width: 1.8, dash: "dot" }, yaxis: "y", hovertemplate: "%{y} mm<extra>PET</extra>" });
    if (V.tmax) traces.push({ type: "scatter", mode: "lines+markers", x: meses, y: V.tmax.valores, name: "T. máx",
      line: { color: COL.tmax, width: 2.4 }, marker: { size: 5 }, yaxis: "y2", hovertemplate: "%{y} °C<extra>Tmáx</extra>" });
    if (V.tmin) traces.push({ type: "scatter", mode: "lines+markers", x: meses, y: V.tmin.valores, name: "T. mín",
      line: { color: COL.tmin, width: 2.4 }, marker: { size: 5 }, yaxis: "y2", hovertemplate: "%{y} °C<extra>Tmín</extra>" });
    const o = p.observado;
    if (o) {
      if (o.precip) traces.push({ type: "scatter", mode: "markers", x: meses, y: o.precip, name: "Precip. observada",
        marker: { color: COL.obs, symbol: "circle-open", size: 7, line: { width: 1.6 } }, yaxis: "y",
        hovertemplate: "%{y} mm<extra>Obs</extra>" });
      if (o.tmax) traces.push({ type: "scatter", mode: "markers", x: meses, y: o.tmax, name: "Tmáx observada",
        marker: { color: COL.obs, symbol: "x-thin-open", size: 7, line: { width: 1.6 } }, yaxis: "y2", showlegend: false,
        hovertemplate: "%{y} °C<extra>Obs</extra>" });
      if (o.tmin) traces.push({ type: "scatter", mode: "markers", x: meses, y: o.tmin, name: "Tmín observada",
        marker: { color: COL.obs, symbol: "x-thin-open", size: 7, line: { width: 1.6 } }, yaxis: "y2", showlegend: false,
        hovertemplate: "%{y} °C<extra>Obs</extra>" });
    }
    const layout = App.plotlyLayoutBase({
      height: 360, margin: { l: 50, r: 50, t: 12, b: 34 }, barmode: "overlay",
      legend: { orientation: "h", y: 1.13, x: 0.5, xanchor: "center", font: { size: 11 } },
      xaxis: { tickfont: { size: 11 }, fixedrange: true },
      yaxis: { title: { text: "Precipitación / PET (mm)", font: { size: 10.5 } }, rangemode: "tozero", fixedrange: true },
      yaxis2: { title: { text: "Temperatura (°C)", font: { size: 10.5 } }, overlaying: "y", side: "right", fixedrange: true },
    });
    Plotly.react(host, traces, layout, App.plotlyConfig());
  }

  function tablaMensual(p) {
    const meses = p.meses || MESES.slice(1);
    const fila = (et, arr, u) => `<tr><td>${esc(et)}</td>${meses.map((_, i) =>
      `<td>${arr && arr[i] != null ? esc(arr[i]) : "—"}</td>`).join("")}</tr>`;
    const V = p.vars || {};
    return `<table class="cl-tabla"><thead><tr><th>Variable</th>${meses.map(m => `<th>${esc(m)}</th>`).join("")}</tr></thead>
      <tbody>
        ${V.precip ? fila("Precip (mm)", V.precip.valores) : ""}
        ${V.tmax ? fila("Tmáx (°C)", V.tmax.valores) : ""}
        ${V.tmin ? fila("Tmín (°C)", V.tmin.valores) : ""}
        ${V.pet ? fila("PET (mm)", V.pet.valores) : ""}
      </tbody></table>`;
  }

  function chipConfianza(c) {
    if (!c || c.dist_estacion_km == null) return "";
    const d = c.dist_estacion_km;
    const cls = c.fuera_calibracion ? "baja" : d <= 10 ? "ok" : d <= 30 ? "med" : "baja";
    const txt = c.fuera_calibracion ? "Fuera de calibración (>4000 m)"
      : `Estación más cercana a ${num(d, 1)} km · ${d <= 10 ? "alta" : d <= 30 ? "media" : "baja"} confianza`;
    return `<div class="cl-conf ${cls}">● ${esc(txt)}</div>`;
  }

  function tarjetaPunto(p, titulo) {
    if (p.error) return `<div class="cl-vacio">${esc(p.error)}</div>`;
    const fuera = p.fuera_dominio || !(p.vars && p.vars.precip && p.vars.precip.anual != null);
    if (fuera) return `<div class="cl-card"><p class="cl-maptit">${esc(titulo || "")}</p>
      <div class="cl-vacio">Esta ubicación está fuera del dominio continental de la Climatología
      (Ecuador continental, 0.05°). Galápagos y el océano no tienen climatología grillada.</div></div>`;
    const V = p.vars;
    const kpi = (e, v, u, d) => `<div class="cl-kpi"><div class="v">${num(v, d)} <small>${esc(u)}</small></div><div class="e">${esc(e)}</div></div>`;
    return `<div class="cl-card">
      ${titulo ? `<p class="cl-maptit">${esc(titulo)}</p>` : ""}
      <div class="cl-kpis">
        ${kpi("Lluvia anual", V.precip && V.precip.anual, "mm", 0)}
        ${kpi("PET anual", V.pet && V.pet.anual, "mm", 0)}
        ${kpi("Tmáx media", V.tmax && V.tmax.anual, "°C", 1)}
        ${kpi("Tmín media", V.tmin && V.tmin.anual, "°C", 1)}
      </div>
      ${chipConfianza(p.confianza)}
      <div style="overflow-x:auto">${tablaMensual(p)}</div>
      ${p.observado ? `<p class="cl-nota">Marcadores = normales <b>observadas</b> de la estación. Como el producto está
        corregido con observaciones, sobre la estación coinciden casi exactamente con la Climatología.</p>` : ""}
    </div>`;
  }

  // PESTAÑA 1 — MAPAS ---------------------------------------------------------
  const E = { mapVar: "precip", mapEsc: "anual", mapaCache: {} };
  async function tabMapas(c) {
    inyectarCSS(); await cargarGeo();
    c.innerHTML = `<div class="cl-wrap">
      <div class="cl-toolbar">
        <div class="cl-grupo"><span>Variable</span><div class="cl-pills" data-rol="vars">
          ${VARS.map(v => `<button class="cl-pill ${v.id === E.mapVar ? "on" : ""}" data-v="${v.id}">${esc(v.et)}</button>`).join("")}
        </div></div>
        <div class="cl-grupo"><span>Escala (mes / anual)</span><div class="cl-meses" data-rol="meses">
          ${MESES.map((m, i) => `<button class="cl-mes ${(i === 0 ? "anual" : i) == E.mapEsc ? "on" : ""}" data-e="${i === 0 ? "anual" : i}">${esc(m)}</button>`).join("")}
        </div></div>
      </div>
      <div class="cl-card"><h3 class="cl-maptit" data-rol="tit">Cargando…</h3><div class="cl-plot" data-rol="plot"></div>
        <p class="cl-nota">Normales 1991–2020 (~5 km) construidas con CHIRPS satelital corregido con estaciones. Pasa el cursor para leer lat/lon y valor.</p></div>
    </div>`;
    const plot = c.querySelector('[data-rol="plot"]'), tit = c.querySelector('[data-rol="tit"]');
    const meses = c.querySelector('[data-rol="meses"]');
    async function dibujar() {
      const v = VARS.find(x => x.id === E.mapVar);
      if (v && v.soloAnual) E.mapEsc = "anual";
      // las variables solo-anual deshabilitan los meses
      meses.querySelectorAll(".cl-mes").forEach(b => {
        const anual = b.dataset.e === "anual";
        b.style.opacity = (v && v.soloAnual && !anual) ? .35 : "";
        b.style.pointerEvents = (v && v.soloAnual && !anual) ? "none" : "";
        b.classList.toggle("on", b.dataset.e == String(E.mapEsc));
      });
      tit.textContent = "Cargando…";
      const key = `${E.mapVar}|${E.mapEsc}`;
      let d = E.mapaCache[key];
      if (!d) {
        try { d = await App.api(`/clima/mapa?variable=${E.mapVar}&escala=${E.mapEsc}`); E.mapaCache[key] = d; }
        catch (e) { tit.textContent = "Error"; plot.innerHTML = `<div class="cl-vacio">${esc(e.message)}</div>`; return; }
      }
      tit.textContent = d.titulo || "";
      pintarMapa(plot, d);
    }
    c.querySelector('[data-rol="vars"]').onclick = e => {
      const b = e.target.closest("[data-v]"); if (!b) return;
      E.mapVar = b.dataset.v;
      c.querySelectorAll('[data-rol="vars"] .cl-pill').forEach(x => x.classList.toggle("on", x.dataset.v === E.mapVar));
      dibujar();
    };
    meses.onclick = e => {
      const b = e.target.closest("[data-e]"); if (!b) return;
      E.mapEsc = b.dataset.e === "anual" ? "anual" : Number(b.dataset.e);
      dibujar();
    };
    dibujar();
  }

  // PESTAÑA 2 — POR ESTACIÓN --------------------------------------------------
  async function tabEstacion(c) {
    inyectarCSS();
    c.innerHTML = `<div class="cl-vacio">Cargando estaciones…</div>`;
    let ests = [];
    try { ests = (await App.api("/clima/estaciones")).estaciones || []; } catch (e) {}
    if (!ests.length) { c.innerHTML = `<div class="cl-vacio">No hay estaciones disponibles.</div>`; return; }
    const opt = ests.map(e => `<option value="${esc(e.codigo)}">${esc(e.nombre || e.codigo)} (${esc(e.codigo)})${e.region ? " · " + esc(e.region) : ""}</option>`).join("");
    c.innerHTML = `<div class="cl-wrap">
      <div class="cl-toolbar">
        <div class="cl-grupo" style="flex:1;min-width:260px"><span>Estación</span>
          <select data-rol="est" style="border:1px solid var(--line,#d7dde6);border-radius:9px;padding:8px 11px;font:500 13px var(--fuente,sans-serif);background:var(--surface,#fff);color:var(--ink,#1f2a3a)">${opt}</select></div>
      </div>
      <div class="cl-grid2">
        <div class="cl-card"><h3 class="cl-maptit" data-rol="tit">Climograma</h3><div class="cl-plot" data-rol="climo"></div>
          <p class="cl-nota">Barras = precipitación y PET (eje izq., mm); líneas = temperaturas (eje der., °C); marcadores = normales observadas.</p></div>
        <div data-rol="ficha"></div>
      </div>
    </div>`;
    const sel = c.querySelector('[data-rol="est"]'), climo = c.querySelector('[data-rol="climo"]');
    const ficha = c.querySelector('[data-rol="ficha"]'), tit = c.querySelector('[data-rol="tit"]');
    async function cargar() {
      const cod = sel.value;
      const nom = (ests.find(e => String(e.codigo) === String(cod)) || {}).nombre || cod;
      tit.textContent = `Climograma — ${nom}`;
      climo.innerHTML = `<div class="cl-vacio">Cargando…</div>`; ficha.innerHTML = "";
      let p;
      try { p = await App.api(`/clima/estacion?codigo=${encodeURIComponent(cod)}`); }
      catch (e) { climo.innerHTML = `<div class="cl-vacio">${esc(e.message)}</div>`; return; }
      ficha.innerHTML = tarjetaPunto(p, `${nom} (${cod})`);
      if (p.error || p.fuera_dominio || !(p.vars && p.vars.precip && p.vars.precip.anual != null)) {
        climo.innerHTML = `<div class="cl-vacio">Sin climatología grillada en esta estación (fuera del dominio continental).</div>`;
      } else { climo.innerHTML = ""; pintarClimograma(climo, p); }
    }
    sel.onchange = cargar; cargar();
  }

  // PESTAÑA 3 — POR COORDENADA ------------------------------------------------
  async function tabPunto(c) {
    inyectarCSS();
    c.innerHTML = `<div class="cl-wrap">
      <div class="cl-toolbar">
        <div class="cl-coords">
          <div class="cl-campo"><span>Latitud</span><input data-rol="lat" type="number" step="0.01" value="-0.18" placeholder="-0.18"></div>
          <div class="cl-campo"><span>Longitud</span><input data-rol="lon" type="number" step="0.01" value="-78.47" placeholder="-78.47"></div>
          <button class="cl-btn" data-rol="ir">Consultar</button>
        </div>
        <div class="cl-hint">Ecuador continental: latitud −5.0 a 1.4 · longitud −81.1 a −75.2. Ej.: Quito −0.18, −78.47.</div>
      </div>
      <div class="cl-grid2">
        <div class="cl-card"><h3 class="cl-maptit" data-rol="tit">Climograma del punto</h3><div class="cl-plot" data-rol="climo"></div></div>
        <div data-rol="ficha"></div>
      </div>
    </div>`;
    const lat = c.querySelector('[data-rol="lat"]'), lon = c.querySelector('[data-rol="lon"]');
    const climo = c.querySelector('[data-rol="climo"]'), ficha = c.querySelector('[data-rol="ficha"]');
    const tit = c.querySelector('[data-rol="tit"]');
    async function consultar() {
      const la = parseFloat(lat.value), lo = parseFloat(lon.value);
      if (isNaN(la) || isNaN(lo)) { App.aviso("Ingresa latitud y longitud válidas.", "error"); return; }
      tit.textContent = `Climograma — ${la.toFixed(2)}, ${lo.toFixed(2)}`;
      climo.innerHTML = `<div class="cl-vacio">Cargando…</div>`; ficha.innerHTML = "";
      let p;
      try { p = await App.api(`/clima/punto?lat=${la}&lon=${lo}`); }
      catch (e) { climo.innerHTML = `<div class="cl-vacio">${esc(e.message)}</div>`; return; }
      ficha.innerHTML = tarjetaPunto(p, `Punto ${la.toFixed(3)}, ${lo.toFixed(3)}`);
      if (p.error || p.fuera_dominio || !(p.vars && p.vars.precip && p.vars.precip.anual != null)) {
        climo.innerHTML = `<div class="cl-vacio">Fuera del dominio continental.</div>`;
      } else { climo.innerHTML = ""; pintarClimograma(climo, p); }
    }
    c.querySelector('[data-rol="ir"]').onclick = consultar;
    [lat, lon].forEach(i => i.onkeydown = e => { if (e.key === "Enter") consultar(); });
    consultar();
  }

  // PESTAÑA 4 — METODOLOGÍA ---------------------------------------------------
  async function tabGlosario(c) {
    inyectarCSS();
    c.innerHTML = `<div class="cl-vacio">Cargando…</div>`;
    let g;
    try { g = await App.api("/clima/glosario"); } catch (e) { c.innerHTML = `<div class="cl-vacio">${esc(e.message)}</div>`; return; }
    c.innerHTML = `
      <div class="cl-glo-intro"><h3>${esc(g.titulo || "Metodología")}</h3><p>${esc(g.intro || "")}</p></div>
      <div class="cl-glo">
        ${(g.secciones || []).map(s => `<div class="cl-glo-card"><h4>${esc(s.titulo)}</h4><p>${esc(s.texto)}</p></div>`).join("")}
      </div>`;
  }

  // PESTAÑA 5 — RÉCORDS (series históricas con envolvente máx/mín) ------------
  const VARREC = { precip: { et: "Precipitación", u: "mm" }, Tmax: { et: "T. máxima", u: "°C" }, Tmin: { et: "T. mínima", u: "°C" } };

  function oscuroTema() { return document.documentElement.getAttribute("data-tema") === "oscuro"; }

  function pintarRecords(host, d, mostrarPct) {
    const rgb = d.es_precip ? "47,127,193" : "224,86,45";
    const ink = oscuroTema() ? "#e8edf6" : "#0f1b2d";
    const faint = oscuroTema() ? "rgba(200,210,225,.55)" : "rgba(60,70,90,.5)";
    const x = d.fechas, e = d.env, u = d.unidad;
    const banda = (lo, hi, op) => ([
      { type: "scatter", mode: "lines", x, y: lo, line: { width: 0 }, hoverinfo: "skip", showlegend: false, connectgaps: false },
      { type: "scatter", mode: "lines", x, y: hi, line: { width: 0 }, fill: "tonexty", fillcolor: `rgba(${rgb},${op})`, hoverinfo: "skip", showlegend: false, connectgaps: false },
    ]);
    let traces = [...banda(e.min, e.max, 0.09)];
    if (mostrarPct) traces.push(...banda(e.p10, e.p90, 0.14), ...banda(e.p25, e.p75, 0.22));
    traces.push({ type: "scatter", mode: "lines", x, y: e.p50, line: { width: 1.4, dash: "dot", color: faint }, connectgaps: false, hovertemplate: `mediana %{y} ${u}<extra></extra>`, showlegend: false });
    traces.push({ type: "scatter", mode: "lines+markers", x, y: d.actual.valores, line: { width: 2.4, color: ink }, marker: { size: 3.4, color: ink }, connectgaps: false, hovertemplate: `%{x|%d %b}: <b>%{y} ${u}</b><extra>${d.anio}</extra>`, showlegend: false });
    const rmx = d.records.max || [];
    if (rmx.length) traces.push({ type: "scatter", mode: "markers", x: rmx.map(r => r.fecha), y: rmx.map(r => r.valor), marker: { symbol: "star", size: 13, color: "#c43c28", line: { color: "#fff", width: 1 } }, customdata: rmx.map(r => [r.anterior, r.anio_anterior]), hovertemplate: `¡Récord MÁX! %{y} ${u}<br>supera ${"%{customdata[0]}"} de ${"%{customdata[1]}"}<extra></extra>`, showlegend: false });
    const rmn = d.records.min || [];
    if (rmn.length) traces.push({ type: "scatter", mode: "markers", x: rmn.map(r => r.fecha), y: rmn.map(r => r.valor), marker: { symbol: "star-triangle-down", size: 13, color: "#1b6fae", line: { color: "#fff", width: 1 } }, customdata: rmn.map(r => [r.anterior, r.anio_anterior]), hovertemplate: `¡Récord MÍN! %{y} ${u}<br>bajo ${"%{customdata[0]}"} de ${"%{customdata[1]}"}<extra></extra>`, showlegend: false });
    const layout = App.plotlyLayoutSerie("", {
      xaxis: { type: "date", tickformat: "%d %b", nticks: 12, hoverformat: "%d %b" },
      yaxis: { title: { text: u }, rangemode: d.es_precip ? "tozero" : "normal" },
      showlegend: false, height: 380, margin: { l: 56, r: 18, t: 12, b: 40 },
    });
    Plotly.react(host, traces, layout, App.plotlyConfig());
  }

  function kpisRecords(d) {
    const u = d.unidad, ext = d.resumen.extremo_max;
    const k = (e, v) => `<div class="cl-kpi"><div class="v">${v}</div><div class="e">${e}</div></div>`;
    return `<div class="cl-kpis" style="grid-template-columns:repeat(auto-fit,minmax(150px,1fr))">
      ${k("Récords máx " + d.anio, `<span style="color:#c43c28">${d.resumen.n_record_max}</span>`)}
      ${k("Récords mín " + d.anio, d.es_precip ? "<small>n/a precip</small>" : `<span style="color:#1b6fae">${d.resumen.n_record_min}</span>`)}
      ${k("Máx del año", ext ? `${num(ext.valor, 1)} <small>${u}</small>` : "—")}
      ${k("Años de referencia", `${d.periodo.desde}–${d.periodo.hasta}`)}
    </div>`;
  }

  function leyendaRecords(d) {
    const rgb = d.es_precip ? "47,127,193" : "224,86,45";
    const ink = oscuroTema() ? "#e8edf6" : "#0f1b2d";
    const it = (sw, t) => `<span style="display:inline-flex;align-items:center;gap:6px;font-size:11.5px;color:var(--muted,#5b6678)">${sw}<span>${t}</span></span>`;
    let items = [
      it(`<span style="width:15px;height:10px;border-radius:2px;background:rgba(${rgb},.18);border:1px solid rgba(${rgb},.4)"></span>`, "máx–mín histórico"),
      it(`<span style="width:16px;height:0;border-top:2.4px solid ${ink}"></span>`, `${d.anio} observado`),
      it(`<span style="color:#c43c28;font-size:13px">★</span>`, "récord máximo"),
    ];
    if (!d.es_precip) items.push(it(`<span style="color:#1b6fae;font-size:12px">▼</span>`, "récord mínimo"));
    return `<div style="display:flex;flex-wrap:wrap;gap:15px;align-items:center">${items.join("")}</div>`;
  }

  function tablaRecords(d) {
    const recs = [...(d.records.max || []).map(r => ({ ...r, t: "máx" })),
      ...(d.es_precip ? [] : (d.records.min || []).map(r => ({ ...r, t: "mín" })))]
      .sort((a, b) => (a.fecha < b.fecha ? -1 : 1));
    if (!recs.length) return `<div class="cl-card"><p class="cl-nota" style="margin:0">Sin récords en ${d.anio}: ningún día superó el extremo histórico (con ≥${d.umbral_n} años de referencia).</p></div>`;
    const u = d.unidad;
    const filas = recs.map(r => `<tr>
      <td>${esc(r.fecha)}</td>
      <td style="text-align:left"><b style="color:${r.t === "máx" ? "#c43c28" : "#1b6fae"}">${r.t}</b></td>
      <td>${num(r.valor, 1)} ${u}</td>
      <td>${num(r.anterior, 1)} ${u}</td>
      <td>${r.anio_anterior ?? "—"}</td></tr>`).join("");
    return `<div class="cl-card"><h3 class="cl-maptit">Récords de ${d.anio} (${recs.length})</h3>
      <table class="cl-tabla"><thead><tr><th>Fecha</th><th style="text-align:left">Tipo</th><th>Valor</th><th>Récord previo</th><th>Año</th></tr></thead>
      <tbody>${filas}</tbody></table></div>`;
  }

  async function tabRecords(c) {
    inyectarCSS();
    c.innerHTML = `<div class="cl-vacio">Cargando estaciones…</div>`;
    let ests = [];
    try { ests = (await App.api("/clima/records_estaciones")).estaciones || []; } catch (e) {}
    if (!ests.length) { c.innerHTML = `<div class="cl-vacio">No hay base de observaciones unificada disponible.</div>`; return; }
    const anioActual = new Date().getFullYear();
    const inp = "border:1px solid var(--line,#d7dde6);border-radius:9px;padding:8px 11px;background:var(--surface,#fff);color:var(--ink,#1f2a3a)";
    const opt = ests.map(e => `<option value="${esc(e.codigo)}">${esc(e.nombre || e.codigo)} (${esc(e.codigo)})${e.region ? " · " + esc(e.region) : ""}</option>`).join("");
    c.innerHTML = `<div class="cl-wrap">
      <div class="cl-toolbar">
        <div class="cl-grupo" style="flex:1;min-width:240px"><span>Estación</span>
          <select data-rol="est" style="${inp};font:500 13px var(--fuente,sans-serif)">${opt}</select></div>
        <div class="cl-grupo"><span>Variable</span><div class="cl-pills" data-rol="vars"></div></div>
        <div class="cl-grupo"><span>Año</span>
          <input data-rol="anio" type="number" value="${anioActual}" min="1990" max="${anioActual}" style="${inp};width:92px;font:600 13px var(--mono,monospace)"></div>
        <div class="cl-grupo"><span>Bandas</span>
          <label style="display:inline-flex;align-items:center;gap:7px;font-size:12.5px;color:var(--muted,#5b6678);cursor:pointer;padding-bottom:6px">
            <input type="checkbox" data-rol="pct" checked> percentiles P10–P90 · P25–P75</label></div>
      </div>
      <div data-rol="kpis"></div>
      <div class="cl-card"><h3 class="cl-maptit" data-rol="tit">Serie histórica</h3>
        <div data-rol="leyenda" style="margin:0 0 8px"></div>
        <div class="cl-plot" data-rol="plot"></div>
        <p class="cl-nota" data-rol="pie"></p></div>
      <div data-rol="tabla"></div>
    </div>`;
    const sel = c.querySelector('[data-rol="est"]'), varsBox = c.querySelector('[data-rol="vars"]');
    const anioIn = c.querySelector('[data-rol="anio"]'), pct = c.querySelector('[data-rol="pct"]');
    const kpis = c.querySelector('[data-rol="kpis"]'), tit = c.querySelector('[data-rol="tit"]');
    const plot = c.querySelector('[data-rol="plot"]'), pie = c.querySelector('[data-rol="pie"]');
    const tabla = c.querySelector('[data-rol="tabla"]'), ley = c.querySelector('[data-rol="leyenda"]');
    let estVar = "precip";
    function pintarVars() {
      const e = ests.find(x => String(x.codigo) === String(sel.value)) || {};
      const disp = e.variables && e.variables.length ? e.variables : ["precip"];
      if (!disp.includes(estVar)) estVar = disp[0];
      varsBox.innerHTML = ["precip", "Tmax", "Tmin"].filter(v => disp.includes(v))
        .map(v => `<button class="cl-pill ${v === estVar ? "on" : ""}" data-v="${v}">${VARREC[v].et}</button>`).join("");
    }
    async function cargar() {
      const cod = sel.value, anio = parseInt(anioIn.value) || anioActual;
      tit.textContent = "Cargando…"; plot.innerHTML = `<div class="cl-vacio">Cargando…</div>`;
      kpis.innerHTML = ""; tabla.innerHTML = ""; ley.innerHTML = ""; pie.textContent = "";
      let d;
      try { d = await App.api(`/clima/records?codigo=${encodeURIComponent(cod)}&variable=${estVar}&anio=${anio}`); }
      catch (e) { tit.textContent = "Error"; plot.innerHTML = `<div class="cl-vacio">${esc(e.message)}</div>`; return; }
      if (d.error) { tit.textContent = "Sin datos"; plot.innerHTML = `<div class="cl-vacio">${esc(d.error)}</div>`; return; }
      tit.textContent = `${VARREC[estVar].et} — ${esc(d.nombre)} (${esc(d.codigo)}) · ${d.anio} vs ${d.periodo.desde}–${d.periodo.hasta}`;
      ley.innerHTML = leyendaRecords(d);
      plot.innerHTML = ""; pintarRecords(plot, d, pct.checked);
      kpis.innerHTML = kpisRecords(d);
      tabla.innerHTML = tablaRecords(d);
      pie.textContent = `Envolvente sobre ${d.n_anios_rango} años con datos; se exige ≥${d.umbral_n} años por día para declarar récord. Precip mayormente producto PISCO (ventana ${d.agregacion}); temperatura observada.`;
    }
    sel.onchange = () => { pintarVars(); cargar(); };
    varsBox.onclick = e => { const b = e.target.closest("[data-v]"); if (!b) return; estVar = b.dataset.v; pintarVars(); cargar(); };
    anioIn.onchange = cargar;
    pct.onchange = cargar;
    pintarVars(); cargar();
  }

  App.registrar("clima", {
    titulo: "Climatología", orden: 2.5,
    async render(vista) {
      vista.dataset.screenLabel = "Climatología";
      App.vistaPestanas(vista, {
        kicker: "Normales 1991–2020 · grilla 0.05° de Ecuador",
        titulo: "Climatología",
        sub: "Climatologías grilladas de Ecuador (~5 km) corregidas con observaciones",
        inicial: "mapas",
        pestanas: [
          { id: "mapas", etiqueta: "Mapas", render: tabMapas },
          { id: "estacion", etiqueta: "Por estación", render: tabEstacion },
          { id: "records", etiqueta: "Récords", render: tabRecords },
          { id: "punto", etiqueta: "Por coordenada", render: tabPunto },
          { id: "glosario", etiqueta: "Metodología", render: tabGlosario },
        ],
      });
    },
  });
})();
