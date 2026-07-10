/* ============================================================
   HidroMet — Climatología de Ecuador (grillas 1991–2020 calibradas con estaciones).
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
  // Estados con voz propia: icono + texto centrado (usa .cl-vacio de clima.css).
  const vacio = (ic, txt) => `<div class="cl-vacio"><span class="ic">${ic}</span><span>${txt}</span></div>`;
  const cargando = txt => vacio("⏳", txt || "Cargando…");
  // Sobre un host que YA es un plot de Plotly, hacer host.innerHTML=... deja estado
  // interno huérfano y el siguiente Plotly.react renderiza a 0px de alto. Purga primero.
  function limpiarPlot(host) {
    try { if (window.Plotly && host && host.classList && host.classList.contains("js-plotly-plot")) Plotly.purge(host); }
    catch (e) {}
    // El purge elimina los handlers plotly_click pero los flags _clickEst/_clickRank
    // persisten en el nodo → sin esto, tras un error transitorio el clic quedaba muerto.
    if (host) { delete host._clickEst; delete host._clickRank; }
  }

  // c = color representativo de la variable (≈ su paleta en el mapa); alimenta el
  // swatch del pill (--pc) para que el control enseñe el color del campo.
  const VARS = [
    { id: "precip", et: "Precipitación", u: "mm", c: "#2f7fc1" },
    { id: "tmax", et: "T. máxima", u: "°C", c: "#e0562d" },
    { id: "tmin", et: "T. mínima", u: "°C", c: "#2e8bc0" },
    { id: "pet", et: "PET", u: "mm", c: "#d08a2e" },
    { id: "balance", et: "Balance P−PET", u: "mm/año", soloAnual: true, c: "#2f9e8f" },
    { id: "aridez", et: "Aridez P/PET", u: "", soloAnual: true, c: "#b07a2e" },
  ];
  const MESES = ["Anual", "Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];
  const COL = { precip: "#2f7fc1", pet: "#d08a2e", tmax: "#e0562d", tmin: "#2e8bc0", obs: "#10243f" };

  // Estilos del módulo: viven en ui/css/clima.css (cargado desde index.html).
  // Se conserva la función como no-op para no tocar los call-sites de cada pestaña.
  function inyectarCSS() {}

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
    // Mapa TEMÁTICO (Climatología no es Pronóstico): claro = halo blanco + línea negra
    // (papel); oscuro = halo del fondo del tema + línea clara, para que el contorno se
    // lea sobre el mar oscuro. Se redibuja al conmutar el tema (_alTema → dibujar).
    const osc = App.tema && App.tema() === "oscuro";
    return [
      { type: "scatter", mode: "lines", x: xs, y: ys, hoverinfo: "skip", showlegend: false,
        line: { color: osc ? "#0B1322" : "#ffffff", width: 2.8 } },
      { type: "scatter", mode: "lines", x: xs, y: ys, hoverinfo: "skip", showlegend: false,
        line: { color: osc ? "#AEBBD0" : "#000000", width: 1.2 } },
    ];
  }

  // Capa de estaciones sobre el mapa: valor de la normal activa muestreado en cada
  // estación (endpoint /clima/estaciones?mes=&variable=), coloreado con la MISMA
  // escala del heatmap para leerse como parte del campo.
  function trazaEstaciones(ce, d) {
    const pts = ((ce && ce.estaciones) || []).filter(e => e.valor != null && e.lat != null && e.lon != null);
    if (!pts.length) return [];
    const dec = ce.dec != null ? ce.dec : 1;
    return [{
      type: "scatter", mode: "markers", meta: "estaciones", showlegend: false,
      x: pts.map(e => e.lon), y: pts.map(e => e.lat),
      customdata: pts.map(e => [e.nombre || e.codigo, e.codigo, num(e.valor, dec)]),
      marker: { size: 8.5, color: pts.map(e => e.valor), colorscale: d.colorscale,
        cmin: d.vmin, cmax: d.vmax, showscale: false,
        line: { color: "#ffffff", width: 1.5 } },
      hovertemplate: `<b>%{customdata[0]}</b> (%{customdata[1]})<br>` +
        `<b>%{customdata[2]} ${esc(ce.unidad || "")}</b> · clic → ficha de la estación<extra></extra>`,
    }];
  }

  // Leyenda HORIZONTAL bajo el mapa — mismo componente visual que las cartas
  // (ct-leyenda-*: barra de gradiente + ticks mono). Pedido del dueño 2026-07-09:
  // la barra vertical de Plotly robaba media pantalla en móvil y desentonaba.
  function leyendaMapa(d, dec) {
    const cs = d.colorscale || [];
    if (!cs.length || d.vmin == null || d.vmax == null) return "";
    const stops = cs.map(p => `${p[1]} ${(p[0] * 100).toFixed(2)}%`).join(", ");
    const rango = (d.vmax - d.vmin) || 1;
    // Ticks "bonitos" (múltiplos de 1/2/2.5/5×10^k), posicionados por su valor real.
    const crudo = rango / 6, pot = Math.pow(10, Math.floor(Math.log10(crudo)));
    const paso = [1, 2, 2.5, 5, 10].map(m => m * pot).find(s => rango / s <= 7) || crudo;
    let tk = "";
    for (let v = Math.ceil(d.vmin / paso) * paso; v <= d.vmax + 1e-9; v += paso) {
      const pos = ((v - d.vmin) / rango) * 100;
      tk += `<span class="t" style="left:${pos.toFixed(2)}%">${esc(String(+v.toFixed(dec)))}</span>`;
    }
    return `<div class="ct-leyenda-cab"><span class="ct-leyenda-unidad mono">${esc(d.unidad || "")}</span>` +
      `<span class="ct-leyenda-sub mono">normal 1991–2020</span></div>` +
      `<div class="ct-leyenda-barra" style="background:linear-gradient(to right, ${stops})"></div>` +
      `<div class="ct-leyenda-ticks">${tk}</div>`;
  }

  // Mapa de una normal --------------------------------------------------------
  function pintarMapa(host, d, ce) {
    if (!window.Plotly || !host) return;
    if (!d || d.error) { limpiarPlot(host); host.innerHTML = vacio("🗺️", esc(d && d.error || "Sin datos")); return; }
    const dec = (d.variable === "tmax" || d.variable === "tmin") ? 1 : (d.variable === "aridez" ? 2 : 0);
    const heat = {
      type: "heatmap", x: d.lon, y: d.lat, z: d.campo, colorscale: d.colorscale,
      zmin: d.vmin, zmax: d.vmax, zsmooth: "best", hoverongaps: false,
      showscale: false,   // v12: la escala vive en la leyenda horizontal bajo el mapa
      hovertemplate: `lat %{y:.2f}, lon %{x:.2f}<br><b>%{z:.${dec}f} ${esc(d.unidad || "")}</b><extra></extra>`,
    };
    // Encuadre ECUADOR CONTINENTAL: la grilla es continental, pero el contorno
    // provincial incluye Galápagos y el autorange alejaba el mapa hacia el oeste.
    // Rango fijo del render (bbox continental); los datos NO se filtran.
    // Altura ajustada al ASPECTO de Ecuador (lat 6.7° / lon 6.1° ≈ 1.1): el mapa
    // estrecho queda ceñido al país, sin franjas de mar muertas (pedido del dueño).
    const alto = Math.max(380, Math.min(640, Math.round((host.clientWidth || 520) * 1.08)));
    const layout = App.plotlyLayoutBase({
      height: alto, margin: { l: 6, r: 6, t: 6, b: 6 },
      xaxis: { visible: false, scaleanchor: "y", constrain: "domain", fixedrange: false,
        range: [-81.2, -75.1] },
      yaxis: { visible: false, fixedrange: false, range: [-5.1, 1.6] },
    });
    Plotly.react(host, [heat, ...contorno(), ...trazaEstaciones(ce, d)], layout, App.plotlyConfig());
    if (App.pinchZoomMapa) App.pinchZoomMapa(host);   // v17: pinza = zoom del mapa
    const ley = host.parentElement && host.parentElement.querySelector('[data-rol="leyenda"]');
    if (ley) ley.innerHTML = leyendaMapa(d, dec);
  }

  // Climograma (barras precip + líneas temp + PET + obs) ----------------------
  function pintarClimograma(host, p) {
    if (!window.Plotly || !host) return;
    const osc = App.tema && App.tema() === "oscuro";
    const obsCol = osc ? "#AEBBD0" : "#64748B";                    // observado, discreto (no compite)
    const grid = osc ? "rgba(140,155,185,.12)" : "rgba(120,130,150,.14)";
    const linea = osc ? "#3a4a66" : "#d3dbe6";
    const txt = osc ? "#c6d0e0" : "#46597A";
    const brdM = osc ? "#101a2b" : "#ffffff";                      // borde de marcador (separa del fondo)
    const meses = p.meses || MESES.slice(1);
    const V = p.vars || {};
    const traces = [];
    if (V.precip) traces.push({ type: "bar", x: meses, y: V.precip.valores, name: "Precipitación",
      marker: { color: COL.precip, opacity: .85 }, yaxis: "y", hovertemplate: "%{y} mm<extra>Precip</extra>" });
    if (V.pet) traces.push({ type: "scatter", mode: "lines", x: meses, y: V.pet.valores, name: "PET",
      line: { color: COL.pet, width: 1.8, dash: "dot", shape: "spline" }, yaxis: "y", hovertemplate: "%{y} mm<extra>PET</extra>" });
    if (V.tmax) traces.push({ type: "scatter", mode: "lines+markers", x: meses, y: V.tmax.valores, name: "T. máx",
      line: { color: COL.tmax, width: 2.6, shape: "spline" }, marker: { size: 5.5, color: COL.tmax, line: { color: brdM, width: 1 } },
      yaxis: "y2", hovertemplate: "%{y} °C<extra>Tmáx</extra>" });
    if (V.tmin) traces.push({ type: "scatter", mode: "lines+markers", x: meses, y: V.tmin.valores, name: "T. mín",
      line: { color: COL.tmin, width: 2.6, shape: "spline" }, marker: { size: 5.5, color: COL.tmin, line: { color: brdM, width: 1 } },
      yaxis: "y2", hovertemplate: "%{y} °C<extra>Tmín</extra>" });
    const o = p.observado;
    if (o) {
      if (o.precip) traces.push({ type: "scatter", mode: "markers", x: meses, y: o.precip, name: "Precip. observada",
        marker: { color: obsCol, symbol: "circle", size: 5, opacity: .9 }, yaxis: "y",
        hovertemplate: "%{y} mm<extra>Obs</extra>" });
      if (o.tmax) traces.push({ type: "scatter", mode: "markers", x: meses, y: o.tmax, name: "Tmáx observada",
        marker: { color: obsCol, symbol: "diamond", size: 5, opacity: .9 }, yaxis: "y2", showlegend: false,
        hovertemplate: "%{y} °C<extra>Obs</extra>" });
      if (o.tmin) traces.push({ type: "scatter", mode: "markers", x: meses, y: o.tmin, name: "Tmín observada",
        marker: { color: obsCol, symbol: "diamond", size: 5, opacity: .9 }, yaxis: "y2", showlegend: false,
        hovertemplate: "%{y} °C<extra>Obs</extra>" });
    }
    const layout = App.plotlyLayoutBase({
      height: 360, margin: { l: 52, r: 52, t: 16, b: 36 }, barmode: "overlay",
      legend: { orientation: "h", y: 1.15, x: 0.5, xanchor: "center", font: { size: 11 }, bgcolor: "rgba(0,0,0,0)" },
      xaxis: { tickfont: { size: 11, color: txt }, fixedrange: true, showgrid: false, showline: true,
        linecolor: linea, ticks: "outside", ticklen: 4, tickcolor: linea },
      yaxis: { title: { text: "Precipitación / PET (mm)", font: { size: 10.5, color: txt } }, tickfont: { size: 10, color: txt },
        rangemode: "tozero", fixedrange: true, gridcolor: grid, griddash: "dot", zeroline: false, showline: false },
      yaxis2: { title: { text: "Temperatura (°C)", font: { size: 10.5, color: txt } }, tickfont: { size: 10, color: txt },
        overlaying: "y", side: "right", fixedrange: true, showgrid: false, zeroline: false },
    });
    Plotly.react(host, traces, layout, App.plotlyConfig());
  }

  function tablaMensual(p) {
    const meses = p.meses || MESES.slice(1);
    const fila = (et, arr, cls) => `<tr${cls ? ` class="${cls}"` : ""}><td>${esc(et)}</td>${meses.map((_, i) =>
      `<td>${arr && arr[i] != null ? esc(arr[i]) : "—"}</td>`).join("")}</tr>`;
    const V = p.vars || {};
    // Percentiles mensuales OBSERVADOS (resumen_obs, solo estaciones): rango P10–P90.
    const R = p.resumen_obs || {};
    const banda = (o, d) => (o && o.p10 && o.p90)
      ? meses.map((_, i) => (o.p10[i] != null && o.p90[i] != null
        ? `${num(o.p10[i], d)}–${num(o.p90[i], d)}` : null))
      : null;
    const bp = banda(R.precip, 0), bx = banda(R.tmax, 1), bn = banda(R.tmin, 1);
    return `<table class="cl-tabla"><thead><tr><th>Variable</th>${meses.map(m => `<th>${esc(m)}</th>`).join("")}</tr></thead>
      <tbody>
        ${V.precip ? fila("Precip (mm)", V.precip.valores) : ""}
        ${bp ? fila("Precip P10–P90 obs.", bp, "cl-pct") : ""}
        ${V.tmax ? fila("Tmáx (°C)", V.tmax.valores) : ""}
        ${bx ? fila("Tmáx P10–P90 obs.", bx, "cl-pct") : ""}
        ${V.tmin ? fila("Tmín (°C)", V.tmin.valores) : ""}
        ${bn ? fila("Tmín P10–P90 obs.", bn, "cl-pct") : ""}
        ${V.pet ? fila("PET (mm)", V.pet.valores) : ""}
      </tbody></table>`;
  }

  // Resumen de la serie observada de la estación: años, completitud, récords con fecha.
  function resumenObs(r) {
    if (!r) return "";
    const filas = [["precip", "Precipitación", "mm"], ["tmax", "T. máxima", "°C"], ["tmin", "T. mínima", "°C"]]
      .filter(([k]) => r[k]).map(([k, et, u]) => {
        const o = r[k];
        const rec = x => x ? `${num(x.valor, 1)} <small>${esc(u)}</small> <span class="cl-fecha">${esc(x.fecha)}</span>` : "—";
        return `<tr><td>${esc(et)}</td><td>${o.n_anios != null ? num(o.n_anios) : "—"} <small>${o.desde}–${o.hasta}</small></td>
          <td>${num(o.completitud, 0)}%</td><td>${rec(o.record_max)}</td><td>${k === "precip" ? "—" : rec(o.record_min)}</td></tr>`;
      }).join("");
    if (!filas) return "";
    return `<div class="cl-tabla-scroll"><table class="cl-tabla cl-tabla-obs">
      <thead><tr><th>Serie observada</th><th>Años</th><th title="Días con dato sobre el periodo">Compl.</th>
      <th>Récord máx (día)</th><th>Récord mín (día)</th></tr></thead><tbody>${filas}</tbody></table>
      <p class="cl-nota" style="margin-top:6px">Serie histórica diaria de la estación: récords absolutos con su fecha
      y percentiles mensuales P10–P90 en la tabla. El detalle día a día está en la pestaña «Récords».</p></div>`;
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
    if (p.error) return vacio("⚠️", esc(p.error));
    const fuera = p.fuera_dominio || !(p.vars && p.vars.precip && p.vars.precip.anual != null);
    if (fuera) return `<div class="cl-card">${titulo ? `<p class="cl-maptit">${esc(titulo)}</p>` : ""}
      <div class="cl-aviso"><span class="ic">🌐</span><p><b>Fuera del dominio continental.</b> La climatología grillada
      cubre Ecuador continental (0.05°); Galápagos y el océano quedan fuera. Si es una estación insular,
      abajo tienes su serie observada.</p></div>
      ${resumenObs(p.resumen_obs)}</div>`;
    const V = p.vars;
    const kpi = (e, v, u, d, c) => `<div class="cl-kpi" style="--kc:${c}"><div class="v">${num(v, d)} <small>${esc(u)}</small></div><div class="e">${esc(e)}</div></div>`;
    return `<div class="cl-card">
      ${titulo ? `<p class="cl-maptit">${esc(titulo)}</p>` : ""}
      <div class="cl-kpis">
        ${kpi("Lluvia anual", V.precip && V.precip.anual, "mm", 0, COL.precip)}
        ${kpi("PET anual", V.pet && V.pet.anual, "mm", 0, COL.pet)}
        ${kpi("Tmáx media", V.tmax && V.tmax.anual, "°C", 1, COL.tmax)}
        ${kpi("Tmín media", V.tmin && V.tmin.anual, "°C", 1, COL.tmin)}
      </div>
      ${chipConfianza(p.confianza)}
      <div class="cl-tabla-scroll">${tablaMensual(p)}</div>
      ${resumenObs(p.resumen_obs)}
      ${p.observado ? `<p class="cl-nota">Marcadores = normales <b>observadas</b> de la estación. Como el producto está
        corregido con observaciones, sobre la estación coinciden casi exactamente con la Climatología.</p>` : ""}
    </div>`;
  }

  // PESTAÑA 1 — MAPAS ---------------------------------------------------------
  const E = { mapVar: "precip", mapEsc: "anual", mapEst: true, mapaCache: {}, estCache: {},
    tabs: null, estSel: null };
  // Los colores de los gráficos se eligen AL PINTAR (App.tema()): al cambiar de tema
  // hay que redibujar el panel visible (patrón sngr.js). Cada pestaña registra su redibujo.
  let _alTema = null;
  document.addEventListener("temacambiado", () => { try { if (_alTema) _alTema(); } catch (e) {} });

  async function tabMapas(c) {
    inyectarCSS(); _alTema = null; await cargarGeo();
    c.innerHTML = `<div class="cl-wrap">
      <div class="cl-toolbar">
        <div class="cl-grupo"><span>Variable</span><div class="cl-pills" data-rol="vars">
          ${VARS.map(v => `<button class="cl-pill ${v.id === E.mapVar ? "on" : ""}" data-v="${v.id}" style="--pc:${v.c}">${esc(v.et)}</button>`).join("")}
        </div></div>
        <div class="cl-grupo"><span>Escala</span><div class="cl-meses" data-rol="meses">
          ${MESES.map((m, i) => `<button class="cl-mes ${(i === 0 ? "anual" : i) == E.mapEsc ? "on" : ""}" data-e="${i === 0 ? "anual" : i}">${esc(m)}</button>`).join("")}
        </div></div>
        <div class="cl-grupo"><span>Capa</span>
          <label class="cl-chk"><input type="checkbox" data-rol="chk-est" ${E.mapEst ? "checked" : ""}> estaciones (valor)</label></div>
      </div>
      <div class="cl-mapgrid">
        <div class="cl-card cl-mapa-card"><h3 class="cl-maptit" data-rol="tit">Cargando…</h3><div class="cl-plot cl-plot-mapa" data-rol="plot"></div>
          <div class="ct-leyenda-carta cl-leyenda" data-rol="leyenda"></div>
          <p class="cl-nota">Normales 1991–2020 (~5 km) construidas con CHIRPS satelital corregido con estaciones. Pasa el cursor para leer lat/lon y valor; los puntos son estaciones (clic → su climograma abajo).</p></div>
        <div class="cl-lado">
          <div class="cl-card"><h3 class="cl-maptit">Estadísticas del campo</h3><div class="cl-kpis-mapa" data-rol="kpis">${cargando()}</div></div>
          <div class="cl-card"><h3 class="cl-maptit">Extremos por estación <span class="cl-sutil">· toca una barra</span></h3><div class="cl-plot" data-rol="rank"></div></div>
        </div>
        <div class="cl-card cl-mini-card"><h3 class="cl-maptit" data-rol="mini-tit">Estación</h3>
          <div class="cl-mini-sel">
            <input class="cl-buscar" data-rol="mini-buscar" type="search" placeholder="Buscar por nombre, código o región…" autocomplete="off">
            <select data-rol="mini-est" class="cl-mini-select"></select>
          </div>
          <div data-rol="mini"><p class="cl-nota">Elige una estación (buscador, mapa o barras de extremos) para ver aquí su climograma y su ficha completa.</p></div></div>
      </div>
    </div>`;
    const plot = c.querySelector('[data-rol="plot"]'), tit = c.querySelector('[data-rol="tit"]');
    const meses = c.querySelector('[data-rol="meses"]'), chkEst = c.querySelector('[data-rol="chk-est"]');
    const kpisEl = c.querySelector('[data-rol="kpis"]'), rankEl = c.querySelector('[data-rol="rank"]');
    const miniEl = c.querySelector('[data-rol="mini"]'), miniTit = c.querySelector('[data-rol="mini-tit"]');
    let miniUlt = null;   // {p, nom, cod} del último climograma lateral (redibujo al cambiar tema)

    // KPIs del campo visible (media/máx/mín con su ubicación) — calculados del propio grid.
    function pintarKpis(d) {
      const dec = (d.variable === "tmax" || d.variable === "tmin") ? 1 : (d.variable === "aridez" ? 2 : 0);
      let n = 0, suma = 0, vmax = -Infinity, vmin = Infinity, pmax = null, pmin = null;
      (d.campo || []).forEach((fila, i) => (fila || []).forEach((v, j) => {
        if (v == null || !isFinite(v)) return;
        n++; suma += v;
        if (v > vmax) { vmax = v; pmax = [d.lat[i], d.lon[j]]; }
        if (v < vmin) { vmin = v; pmin = [d.lat[i], d.lon[j]]; }
      }));
      if (!n) { kpisEl.innerHTML = `<p class="cl-nota">Sin datos.</p>`; return; }
      const u = d.unidad || "", f = v => `${(+v.toFixed(dec)).toLocaleString("es-EC")}`;
      const geo = p => p ? `${Math.abs(p[0]).toFixed(1)}°${p[0] < 0 ? "S" : "N"} ${Math.abs(p[1]).toFixed(1)}°O` : "";
      // Dato de IMPACTO (pedido del dueño): el contraste del país — para temp el rango
      // en °C entre el punto más cálido y el más frío; para el resto la razón máx/mín.
      const esTemp = d.variable === "tmax" || d.variable === "tmin";
      const contraste = esTemp
        ? `${f(vmax - vmin)} <span class="s">°C de rango</span>`
        : (vmin > 0 ? `${(vmax / vmin).toFixed(1)}<span class="s">× máx/mín</span>` : `${f(vmax - vmin)} <span class="s">${esc(u)} de rango</span>`);
      kpisEl.innerHTML = `
        <div class="cl-kpi-m"><div class="k">Media del campo</div><div class="v">${f(suma / n)} <span class="s">${esc(u)}</span></div></div>
        <div class="cl-kpi-m"><div class="k">Máximo</div><div class="v">${f(vmax)} <span class="s">${esc(u)}</span></div><div class="s">${geo(pmax)}</div></div>
        <div class="cl-kpi-m"><div class="k">Mínimo</div><div class="v">${f(vmin)} <span class="s">${esc(u)}</span></div><div class="s">${geo(pmin)}</div></div>
        <div class="cl-kpi-m"><div class="k">Contraste</div><div class="v">${contraste}</div><div class="s">entre extremos del país</div></div>`;
    }

    // Extremos por estación como GRÁFICO de barras horizontales (pedido del dueño:
    // gráficos de impacto, no listas de texto). Top-5 y bottom-5, coloreados con la
    // MISMA paleta del mapa (lectura inmediata); tocar una barra abre su ficha.
    function pintarRank(ce, d) {
      const pts = ((ce && ce.estaciones) || []).filter(e => e.valor != null && isFinite(e.valor));
      if (!pts.length || !window.Plotly) { rankEl.innerHTML = `<div class="cl-nota">Sin estaciones con dato para esta variable.</div>`; return; }
      const orden = [...pts].sort((a, b) => b.valor - a.valor);
      const sel = [...orden.slice(0, 5), ...orden.slice(-5)].filter((e, i, arr) => arr.findIndex(x => x.codigo === e.codigo) === i);
      sel.reverse();   // barras horizontales: el mayor arriba
      const oscuro = App.tema && App.tema() === "oscuro";
      const txt = oscuro ? "#c6d0e0" : "#46597A";
      const dec = (d.variable === "tmax" || d.variable === "tmin") ? 1 : 0;
      const tr = {
        type: "bar", orientation: "h",
        y: sel.map(e => e.nombre || String(e.codigo)),
        x: sel.map(e => e.valor),
        text: sel.map(e => `${(+Number(e.valor).toFixed(dec)).toLocaleString("es-EC")}`),
        textposition: "outside", cliponaxis: false,
        textfont: { family: "IBM Plex Mono, monospace", size: 10, color: txt },
        marker: { color: sel.map(e => e.valor), colorscale: d.colorscale, cmin: d.vmin, cmax: d.vmax,
                  line: { color: oscuro ? "rgba(255,255,255,.25)" : "rgba(15,27,45,.25)", width: 1 } },
        customdata: sel.map(e => [e.nombre || e.codigo, String(e.codigo)]),
        hovertemplate: `<b>%{customdata[0]}</b> (%{customdata[1]})<br>%{x} ${esc(d.unidad || "")} · toca → ficha<extra></extra>`,
      };
      const layout = App.plotlyLayoutBase({
        height: Math.max(300, sel.length * 30 + 40), margin: { l: 4, r: 34, t: 4, b: 22 },
        xaxis: { tickfont: { size: 9, color: txt }, showgrid: true, zeroline: false, fixedrange: true },
        yaxis: { tickfont: { size: 10.5, color: txt }, automargin: true, fixedrange: true },
        showlegend: false, bargap: .28,
      });
      Plotly.react(rankEl, [tr], layout, App.plotlyConfig({ displayModeBar: false })).then(() => {
        if (!rankEl._clickRank && typeof rankEl.on === "function") {
          rankEl._clickRank = true;
          rankEl.on("plotly_click", ev => {
            const pt = ev.points && ev.points[0];
            if (pt && pt.customdata) miniFicha(pt.customdata[1], pt.customdata[0]);
          });
        }
      });
    }

    // FICHA COMPLETA de la estación, inline (v14: reemplaza a la pestaña "Por estación"):
    // climograma + tarjeta de normales/récords lado a lado (móvil: apilados).
    async function miniFicha(cod, nom) {
      miniTit.textContent = `Estación — ${nom || cod}`;
      const selEst = c.querySelector('[data-rol="mini-est"]');
      if (selEst && selEst.value !== String(cod)) selEst.value = String(cod);
      miniEl.innerHTML = cargando();
      let p;
      try { p = await App.api(`/clima/estacion?codigo=${encodeURIComponent(cod)}`); }
      catch (e) { miniEl.innerHTML = vacio("⚠️", esc(e.message)); return; }
      const ficha = tarjetaPunto(p, `${nom || cod} (${cod})`);
      if (p.error || p.fuera_dominio || !(p.vars && p.vars.precip && p.vars.precip.anual != null)) {
        miniEl.innerHTML = `<div class="cl-mini-grid"><div><p class="cl-nota">Sin climatología grillada aquí (fuera del dominio continental); la ficha muestra su serie observada.</p></div><div>${ficha}</div></div>`;
      } else {
        miniEl.innerHTML = `<div class="cl-mini-grid"><div class="cl-plot" data-rol="mini-climo"></div><div>${ficha}</div></div>`;
        pintarClimograma(miniEl.querySelector('[data-rol="mini-climo"]'), p);
      }
      miniUlt = { p, nom, cod };
    }
    // Selector de estación del panel (buscador + lista agrupada por región).
    (async () => {
      let ests = [];
      try { ests = (await App.api("/clima/estaciones")).estaciones || []; } catch (e) {}
      const selEst = c.querySelector('[data-rol="mini-est"]'), busc = c.querySelector('[data-rol="mini-buscar"]');
      if (!selEst || !ests.length) return;
      const opciones = lista => {
        const grupos = new Map();
        for (const e of lista) {
          const rg = e.region || "Sin región";
          if (!grupos.has(rg)) grupos.set(rg, []);
          grupos.get(rg).push(e);
        }
        return `<option value="" disabled selected>Elige una estación…</option>` +
          [...grupos.keys()].sort((a, b) => a.localeCompare(b, "es")).map(rg =>
            `<optgroup label="${esc(rg)}">${grupos.get(rg).map(e =>
              `<option value="${esc(String(e.codigo))}">${esc(e.nombre || e.codigo)} (${esc(String(e.codigo))})</option>`).join("")}</optgroup>`).join("");
      };
      selEst.innerHTML = opciones(ests);
      const nomDe = cod => (ests.find(e => String(e.codigo) === String(cod)) || {}).nombre || cod;
      selEst.onchange = () => { if (selEst.value) miniFicha(selEst.value, nomDe(selEst.value)); };
      if (busc) busc.oninput = () => {
        const q = busc.value.trim().toLowerCase();
        const lista = !q ? ests : ests.filter(e =>
          `${e.codigo} ${e.nombre || ""} ${e.region || ""}`.toLowerCase().includes(q));
        const previa = selEst.value;
        selEst.innerHTML = opciones(lista);
        if (lista.some(e => String(e.codigo) === String(previa))) selEst.value = previa;
        else if (lista.length === 1) { selEst.value = String(lista[0].codigo); selEst.onchange(); }
      };
    })();
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
        catch (e) { limpiarPlot(plot); tit.textContent = "Error"; plot.innerHTML = vacio("⚠️", esc(e.message)); return; }
      }
      // Las estaciones se piden SIEMPRE (alimentan el ranking lateral); la capa del
      // mapa solo las dibuja si el checkbox está activo.
      let ce = E.estCache[key];
      if (!ce) {
        try { ce = await App.api(`/clima/estaciones?mes=${E.mapEsc}&variable=${E.mapVar}`); E.estCache[key] = ce; }
        catch (e) { ce = null; }
      }
      tit.textContent = d.titulo || "";
      pintarMapa(plot, d, E.mapEst ? ce : null);
      pintarKpis(d);
      pintarRank(ce, d);
      // Clic en una estación → su climograma AL LADO del mapa (rediseño 2026-07-09);
      // la ficha completa queda a un botón.
      if (typeof plot.on === "function" && !plot._clickEst) {
        plot._clickEst = true;
        plot.on("plotly_click", ev => {
          const pt = ev.points && ev.points[0];
          if (!pt || !pt.data || pt.data.meta !== "estaciones" || !pt.customdata) return;
          miniFicha(String(pt.customdata[1]), pt.customdata[0]);
        });
      }
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
    chkEst.onchange = () => { E.mapEst = chkEst.checked; dibujar(); };
    _alTema = () => {
      if (!c.isConnected) return;
      dibujar();
      // el climograma lateral también se redibuja con los colores del tema nuevo
      if (miniUlt) {
        const host = miniEl.querySelector('[data-rol="mini-climo"]');
        if (host) pintarClimograma(host, miniUlt.p);
      }
    };
    dibujar();
  }

  // PESTAÑA 2 — POR ESTACIÓN --------------------------------------------------
  async function tabEstacion(c) {
    inyectarCSS(); _alTema = null;
    c.innerHTML = cargando("Cargando estaciones…");
    let ests = [];
    try { ests = (await App.api("/clima/estaciones")).estaciones || []; } catch (e) {}
    if (!ests.length) { c.innerHTML = vacio("📭", "No hay estaciones disponibles."); return; }
    // Opciones agrupadas por región; las insulares van etiquetadas (hay récords
    // observados pero no climatología grillada).
    const opciones = lista => {
      const grupos = new Map();
      for (const e of lista) {
        const rg = e.region || "Sin región";
        if (!grupos.has(rg)) grupos.set(rg, []);
        grupos.get(rg).push(e);
      }
      return [...grupos.keys()].sort((a, b) => a.localeCompare(b, "es")).map(rg =>
        `<optgroup label="${esc(rg)}">${grupos.get(rg).map(e =>
          `<option value="${esc(e.codigo)}">${esc(e.nombre || e.codigo)} (${esc(e.codigo)})${e.fuera_dominio ? " · sin climatología grillada" : ""}</option>`).join("")}</optgroup>`).join("");
    };
    c.innerHTML = `<div class="cl-wrap">
      <div class="cl-toolbar">
        <div class="cl-grupo" style="flex:1;min-width:340px"><span>Estación</span>
          <input class="cl-buscar" data-rol="buscar" type="search" placeholder="Filtrar por nombre, código o región…" autocomplete="off">
          <select data-rol="est" style="flex:1;border:1px solid var(--line,#d7dde6);border-radius:9px;padding:8px 11px;font:500 13px var(--fuente,sans-serif);background:var(--surface,#fff);color:var(--ink,#1f2a3a)">${opciones(ests)}</select></div>
      </div>
      <div class="cl-grid2">
        <div class="cl-card"><h3 class="cl-maptit" data-rol="tit">Climograma</h3><div class="cl-plot" data-rol="climo"></div>
          <p class="cl-nota">Barras = precipitación y PET (eje izq., mm); líneas = temperaturas (eje der., °C); marcadores = normales observadas.</p></div>
        <div data-rol="ficha"></div>
      </div>
    </div>`;
    const sel = c.querySelector('[data-rol="est"]'), climo = c.querySelector('[data-rol="climo"]');
    const ficha = c.querySelector('[data-rol="ficha"]'), tit = c.querySelector('[data-rol="tit"]');
    const buscar = c.querySelector('[data-rol="buscar"]');
    // Estación pre-seleccionada desde el mapa (clic en un marcador).
    if (E.estSel) {
      if (ests.some(e => String(e.codigo) === String(E.estSel))) sel.value = String(E.estSel);
      E.estSel = null;
    }
    let ultimo = null;   // último payload con climograma pintado (redibujo al cambiar tema)
    async function cargar() {
      const cod = sel.value;
      if (!cod) return;
      const nom = (ests.find(e => String(e.codigo) === String(cod)) || {}).nombre || cod;
      tit.textContent = `Climograma — ${nom}`;
      limpiarPlot(climo); climo.innerHTML = cargando(); ficha.innerHTML = ""; ultimo = null;
      let p;
      try { p = await App.api(`/clima/estacion?codigo=${encodeURIComponent(cod)}`); }
      catch (e) { climo.innerHTML = vacio("⚠️", esc(e.message)); return; }
      ficha.innerHTML = tarjetaPunto(p, `${nom} (${cod})`);
      if (p.error || p.fuera_dominio || !(p.vars && p.vars.precip && p.vars.precip.anual != null)) {
        climo.innerHTML = vacio("🌐", "Sin climatología grillada aquí (fuera del dominio continental). La ficha muestra su serie observada.");
      } else { climo.innerHTML = ""; pintarClimograma(climo, p); ultimo = p; }
    }
    // Buscador en vivo: filtra las opciones sin perder la selección (patrón datos.js).
    buscar.oninput = () => {
      const q = buscar.value.trim().toLowerCase();
      const lista = !q ? ests : ests.filter(e =>
        `${e.codigo} ${e.nombre || ""} ${e.region || ""}`.toLowerCase().includes(q));
      const previa = sel.value;
      sel.innerHTML = opciones(lista);
      if (lista.some(e => String(e.codigo) === String(previa))) sel.value = previa;
      else if (lista.length) cargar();
    };
    sel.onchange = cargar;
    _alTema = () => { if (c.isConnected && ultimo) pintarClimograma(climo, ultimo); };
    cargar();
  }

  // PESTAÑA 3 — POR COORDENADA ------------------------------------------------
  async function tabPunto(c) {
    inyectarCSS(); _alTema = null;
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
    let ultimo = null;
    async function consultar() {
      const la = parseFloat(lat.value), lo = parseFloat(lon.value);
      if (isNaN(la) || isNaN(lo)) { App.aviso("Ingresa latitud y longitud válidas.", "error"); return; }
      tit.textContent = `Climograma — ${la.toFixed(2)}, ${lo.toFixed(2)}`;
      limpiarPlot(climo); climo.innerHTML = cargando(); ficha.innerHTML = ""; ultimo = null;
      let p;
      try { p = await App.api(`/clima/punto?lat=${la}&lon=${lo}`); }
      catch (e) { climo.innerHTML = vacio("⚠️", esc(e.message)); return; }
      ficha.innerHTML = tarjetaPunto(p, `Punto ${la.toFixed(3)}, ${lo.toFixed(3)}`);
      if (p.error || p.fuera_dominio || !(p.vars && p.vars.precip && p.vars.precip.anual != null)) {
        climo.innerHTML = vacio("🌐", "Fuera del dominio continental.");
      } else { climo.innerHTML = ""; pintarClimograma(climo, p); ultimo = p; }
    }
    c.querySelector('[data-rol="ir"]').onclick = consultar;
    _alTema = () => { if (c.isConnected && ultimo) pintarClimograma(climo, ultimo); };
    [lat, lon].forEach(i => i.onkeydown = e => { if (e.key === "Enter") consultar(); });
    consultar();
  }

  // PESTAÑA 4 — METODOLOGÍA ---------------------------------------------------
  async function tabGlosario(c) {
    inyectarCSS(); _alTema = null;
    c.innerHTML = cargando();
    let g;
    try { g = await App.api("/clima/glosario"); } catch (e) { c.innerHTML = vacio("⚠️", esc(e.message)); return; }
    c.innerHTML = `
      <div class="cl-glo-intro"><h3>${esc(g.titulo || "Metodología")}</h3><p>${esc(g.intro || "")}</p></div>
      <div class="cl-glo">
        ${(g.secciones || []).map(s => `<div class="cl-glo-card"><h4>${esc(s.titulo)}</h4><p>${esc(s.texto)}</p></div>`).join("")}
      </div>`;
  }

  // PESTAÑA 5 — RÉCORDS (series históricas con envolvente máx/mín) ------------
  const VARREC = { precip: { et: "Precipitación", u: "mm", c: "#2f7fc1" }, Tmax: { et: "T. máxima", u: "°C", c: "#e0562d" }, Tmin: { et: "T. mínima", u: "°C", c: "#2e8bc0" } };

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
    traces.push({ type: "scatter", mode: "lines", x, y: e.p50, line: { width: 1.3, dash: "dot", color: faint }, connectgaps: false, hovertemplate: `mediana %{y} ${u}<extra></extra>`, showlegend: false });
    traces.push({ type: "scatter", mode: "lines+markers", x, y: d.actual.valores, line: { width: 2, color: ink }, marker: { size: 2.8, color: ink }, connectgaps: false, hovertemplate: `%{x|%d %b}: <b>%{y} ${u}</b><extra>${d.anio}</extra>`, showlegend: false });
    const brdStar = oscuroTema() ? "#0B1322" : "#ffffff";     // borde de estrella = fondo del tema
    const rmx = d.records.max || [];
    if (rmx.length) traces.push({ type: "scatter", mode: "markers", x: rmx.map(r => r.fecha), y: rmx.map(r => r.valor), marker: { symbol: "star", size: 12, color: "#c43c28", line: { color: brdStar, width: 1 } }, customdata: rmx.map(r => [r.anterior, r.anio_anterior]), hovertemplate: `¡Récord MÁX! %{y} ${u}<br>supera ${"%{customdata[0]}"} de ${"%{customdata[1]}"}<extra></extra>`, showlegend: false });
    const rmn = d.records.min || [];
    if (rmn.length) traces.push({ type: "scatter", mode: "markers", x: rmn.map(r => r.fecha), y: rmn.map(r => r.valor), marker: { symbol: "star-triangle-down", size: 12, color: "#1b6fae", line: { color: brdStar, width: 1 } }, customdata: rmn.map(r => [r.anterior, r.anio_anterior]), hovertemplate: `¡Récord MÍN! %{y} ${u}<br>bajo ${"%{customdata[0]}"} de ${"%{customdata[1]}"}<extra></extra>`, showlegend: false });
    const layout = App.plotlyLayoutSerie("", {
      xaxis: { type: "date", tickformat: "%d %b", nticks: 12, hoverformat: "%d %b" },
      yaxis: { title: { text: u }, rangemode: d.es_precip ? "tozero" : "normal" },
      showlegend: false, height: 380, margin: { l: 56, r: 18, t: 12, b: 40 },
    });
    Plotly.react(host, traces, layout, App.plotlyConfig());
  }

  function kpisRecords(d) {
    const u = d.unidad, ext = d.resumen.extremo_max;
    const k = (e, v, c) => `<div class="cl-kpi" style="--kc:${c}"><div class="v">${v}</div><div class="e">${e}</div></div>`;
    return `<div class="cl-kpis" style="grid-template-columns:repeat(auto-fit,minmax(150px,1fr))">
      ${k("Récords máx " + d.anio, `<span style="color:#c43c28">${d.resumen.n_record_max}</span>`, "#c43c28")}
      ${k("Récords mín " + d.anio, d.es_precip ? "<small>n/a precip</small>" : `<span style="color:#1b6fae">${d.resumen.n_record_min}</span>`, "#1b6fae")}
      ${k("Máx del año", ext ? `${num(ext.valor, 1)} <small>${u}</small>` : "—", d.es_precip ? COL.precip : COL.tmax)}
      ${k("Años de referencia", `${d.periodo.desde}–${d.periodo.hasta}`, "var(--cyan)")}
    </div>`;
  }

  function leyendaRecords(d) {
    const rgb = d.es_precip ? "47,127,193" : "224,86,45";
    const ink = oscuroTema() ? "#e8edf6" : "#0f1b2d";
    const it = (sw, t) => `<span style="display:inline-flex;align-items:center;gap:6px;font-size:11.5px;color:var(--muted,#5b6678)">${sw}<span>${t}</span></span>`;
    // Sin histórico multianual: solo hay serie del año → no anunciar envolvente ni récords.
    if (d.sin_historico)
      return `<div style="display:flex;flex-wrap:wrap;gap:15px;align-items:center">${
        it(`<span style="width:16px;height:0;border-top:2.4px solid ${ink}"></span>`, `${d.anio} observado`)}</div>`;
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
      <div class="cl-tabla-scroll"><table class="cl-tabla"><thead><tr><th>Fecha</th><th style="text-align:left">Tipo</th><th>Valor</th><th>Récord previo</th><th>Año</th></tr></thead>
      <tbody>${filas}</tbody></table></div></div>`;
  }

  async function tabRecords(c) {
    inyectarCSS(); _alTema = null;
    c.innerHTML = cargando("Cargando estaciones…");
    let ests = [];
    try { ests = (await App.api("/clima/records_estaciones")).estaciones || []; } catch (e) {}
    if (!ests.length) { c.innerHTML = vacio("📭", "No hay base de observaciones unificada disponible."); return; }
    const anioActual = new Date().getFullYear();
    // En el visor solo hay récords congelados de los últimos VISOR_RECORDS_ANIOS=10 años
    // (exportar_web.py; mantener ambos números iguales) → capar el input para no ofrecer
    // años sin producto ("no publicado").
    const minAnio = window.HIDROMET_VISOR ? (anioActual - 9) : 1990;
    const inp = "border:1px solid var(--line,#d7dde6);border-radius:9px;padding:8px 11px;background:var(--surface,#fff);color:var(--ink,#1f2a3a)";
    c.innerHTML = `<div class="cl-wrap">
      <div class="cl-toolbar">
        <div class="cl-grupo" style="flex:1;min-width:240px"><span>Estación</span>
          <select data-rol="est" style="${inp};font:500 13px var(--fuente,sans-serif)"></select></div>
        <div class="cl-grupo"><span>Variable</span><div class="cl-pills" data-rol="vars"></div></div>
        <div class="cl-grupo"><span>Año</span>
          <input data-rol="anio" type="number" value="${anioActual}" min="${minAnio}" max="${anioActual}" style="${inp};width:92px;font:600 13px var(--mono,monospace)"></div>
        <div class="cl-grupo"><span>Bandas</span>
          <label style="display:inline-flex;align-items:center;gap:7px;font-size:12.5px;color:var(--muted,#5b6678);cursor:pointer">
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
    const mide = (e, v) => (e.variables || []).includes(v);
    function pintarVars() {
      // Pills = variables con al menos UNA estación en la base (no dependen de la estación).
      const disp = ["precip", "Tmax", "Tmin"].filter(v => ests.some(e => mide(e, v)));
      if (disp.length && !disp.includes(estVar)) estVar = disp[0];
      varsBox.innerHTML = disp
        .map(v => `<button class="cl-pill ${v === estVar ? "on" : ""}" data-v="${v}" style="--pc:${VARREC[v].c}">${VARREC[v].et}</button>`).join("");
    }
    function pintarEstaciones() {
      // El selector SOLO ofrece estaciones que midan la variable activa; conserva la
      // selección si sigue siendo válida y, si no, cae a la primera válida.
      const previa = sel.value;
      const validas = ests.filter(e => mide(e, estVar));
      sel.innerHTML = validas.map(e =>
        `<option value="${esc(e.codigo)}">${esc(e.nombre || e.codigo)} (${esc(e.codigo)})${e.region ? " · " + esc(e.region) : ""}</option>`).join("");
      if (validas.some(e => String(e.codigo) === String(previa))) sel.value = previa;
    }
    let ultimo = null;   // último payload pintado (redibujo al cambiar tema)
    async function cargar() {
      const cod = sel.value, anio = parseInt(anioIn.value) || anioActual;
      limpiarPlot(plot); tit.textContent = "Cargando…"; plot.innerHTML = cargando();
      kpis.innerHTML = ""; tabla.innerHTML = ""; ley.innerHTML = ""; pie.textContent = ""; ultimo = null;
      let d;
      try { d = await App.api(`/clima/records?codigo=${encodeURIComponent(cod)}&variable=${estVar}&anio=${anio}`); }
      catch (e) { tit.textContent = "Error"; plot.innerHTML = vacio("⚠️", esc(e.message)); return; }
      if (d.error) { tit.textContent = "Sin datos"; plot.innerHTML = vacio("📊", esc(d.error)); return; }
      // textContent: sin esc() (escaparía doble y mostraría entidades literales).
      tit.textContent = d.sin_historico
        ? `${VARREC[estVar].et} — ${d.nombre} (${d.codigo}) · serie ${d.anio}`
        : `${VARREC[estVar].et} — ${d.nombre} (${d.codigo}) · ${d.anio} vs ${d.periodo.desde}–${d.periodo.hasta}`;
      ley.innerHTML = leyendaRecords(d);
      plot.innerHTML = ""; pintarRecords(plot, d, pct.checked);
      kpis.innerHTML = kpisRecords(d);
      tabla.innerHTML = tablaRecords(d);
      // Estación nueva sin años previos: no hay envolvente ni récords todavía; se explica
      // en vez de dejar la pestaña con un error (antes toda estación de 2026 fallaba).
      pie.textContent = d.sin_historico
        ? `Estación nueva: solo hay datos desde ${d.periodo.desde}. Se muestra la serie observada del año; aún no hay envolvente histórica ni detección de récords (se necesitan varios años).`
        : `Envolvente sobre ${d.n_anios_rango} años con datos; se exige ≥${d.umbral_n} años por día para declarar récord. Precipitación mayormente de la Climatología (ventana ${d.agregacion}); temperatura observada.`;
      ultimo = d;
    }
    sel.onchange = cargar;
    _alTema = () => {
      if (!c.isConnected || !ultimo) return;
      ley.innerHTML = leyendaRecords(ultimo);
      pintarRecords(plot, ultimo, pct.checked);
    };
    varsBox.onclick = e => {
      const b = e.target.closest("[data-v]"); if (!b) return;
      estVar = b.dataset.v; pintarVars(); pintarEstaciones(); cargar();
    };
    anioIn.onchange = cargar;
    pct.onchange = cargar;
    pintarVars(); pintarEstaciones(); cargar();
  }

  App.registrar("clima", {
    titulo: "Climatología", orden: 2.5,
    // Al salir del módulo: purgar TODOS los Plotly vivos (mapa, ranking, climogramas,
    // récords) — cada instancia deja listeners de window si no se purga.
    alDejar() {
      if (!window.Plotly) return;
      document.querySelectorAll("#vista .js-plotly-plot").forEach(el => { try { Plotly.purge(el); } catch (e) { /* ya purgado */ } });
    },
    async render(vista) {
      vista.dataset.screenLabel = "Climatología";
      vista.classList.add("vista-clima");
      E.tabs = App.vistaPestanas(vista, {
        kicker: "Normales 1991–2020 · grilla 0.05° de Ecuador",
        titulo: "Climatología",
        sub: "Climatologías grilladas de Ecuador (~5 km) corregidas con observaciones",
        acento: "var(--cyan)",
        inicial: "mapas",
        pestanas: [
          // v14 (pedido del dueño): MENOS pestañas — "Por estación" vive DENTRO de
          // Explorar (selector + clic en mapa/ranking → climograma y ficha ahí mismo).
          { id: "mapas", etiqueta: "Explorar", render: tabMapas },
          { id: "records", etiqueta: "Récords", render: tabRecords },
          // "Por coordenada" consulta lat/lon libres (imposible de congelar) → oculta en el visor.
          window.HIDROMET_VISOR ? null : { id: "punto", etiqueta: "Por coordenada", render: tabPunto },
          { id: "glosario", etiqueta: "Metodología", render: tabGlosario },
        ],
      });
    },
  });
})();
