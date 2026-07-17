/* ============================================================
   Climatología — campos 1991–2020 y observaciones disponibles.
   Referencias 1991–2020 a 0.05° (precip/Tmáx/Tmín/PET) y soporte observacional.
   Cuatro pestañas: Mapas · Por estación · Por coordenada · Metodología.
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
      `<span class="ct-leyenda-sub mono">${esc(d.leyenda_sub || "normal 1991–2020")}</span></div>` +
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
      ${p.observado ? `<p class="cl-nota">Los marcadores resumen las observaciones disponibles para la estación.
        Su periodo y escala espacial pueden diferir de la malla 1991–2020, por lo que no se espera coincidencia exacta.</p>` : ""}
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
          <p class="cl-nota">Referencia mensual 1991–2020 (~5 km) de la generación climática activa. Pasa el cursor para leer lat/lon y valor; los puntos muestran observaciones disponibles (clic → su ficha).</p></div>
        <div class="cl-card cl-est-card"><h3 class="cl-maptit" data-rol="mini-tit">Ficha de estación</h3>
          <div class="cl-mini-sel">
            <input class="cl-buscar" data-rol="mini-buscar" type="search" placeholder="Buscar por nombre, código o región…" autocomplete="off">
            <select data-rol="mini-est" class="cl-mini-select"></select>
          </div>
          <div class="cl-est-cuerpo" data-rol="mini">${vacio("📍", "Toca una estación en el mapa (o búscala aquí) para ver su climograma, sus normales mensuales y su serie observada.")}</div></div>
      </div>
    </div>`;
    const plot = c.querySelector('[data-rol="plot"]'), tit = c.querySelector('[data-rol="tit"]');
    const meses = c.querySelector('[data-rol="meses"]'), chkEst = c.querySelector('[data-rol="chk-est"]');
    const miniEl = c.querySelector('[data-rol="mini"]'), miniTit = c.querySelector('[data-rol="mini-tit"]');
    let miniUlt = null;   // {p, nom, cod} del último climograma lateral (redibujo al cambiar tema)

    // FICHA COMPLETA de la estación en el LATERAL del mapa (v16, pedido del dueño:
    // los KPIs de campo y el ranking top/bottom eran irrelevantes — el lateral es
    // ahora la ficha: climograma + normales mensuales + serie observada, apilados).
    async function miniFicha(cod, nom) {
      miniTit.textContent = `Ficha — ${nom || cod}`;
      const selEst = c.querySelector('[data-rol="mini-est"]');
      if (selEst && selEst.value !== String(cod)) selEst.value = String(cod);
      miniEl.innerHTML = cargando();
      let p;
      try { p = await App.api(`/clima/estacion?codigo=${encodeURIComponent(cod)}`); }
      catch (e) { miniEl.innerHTML = vacio("⚠️", esc(e.message)); return; }
      const ficha = tarjetaPunto(p, `${nom || cod} (${cod})`);
      if (p.error || p.fuera_dominio || !(p.vars && p.vars.precip && p.vars.precip.anual != null)) {
        // La propia tarjeta explica el fuera-de-dominio y trae la serie observada.
        miniEl.innerHTML = `<div class="cl-ficha-pila">${ficha}</div>`;
      } else {
        miniEl.innerHTML = `<div class="cl-ficha-pila"><div class="cl-plot" data-rol="mini-climo"></div>${ficha}</div>`;
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
            `<optgroup label="${esc(App.redEtiqueta(rg))}">${grupos.get(rg).map(e =>
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
      // Capa de estaciones (valor muestreado): solo se pide si el checkbox está activo
      // (v16: ya no alimenta ningún ranking lateral).
      let ce = null;
      if (E.mapEst) {
        ce = E.estCache[key];
        if (!ce) {
          try { ce = await App.api(`/clima/estaciones?mes=${E.mapEsc}&variable=${E.mapVar}`); E.estCache[key] = ce; }
          catch (e) { ce = null; }
        }
      }
      tit.textContent = d.titulo || "";
      pintarMapa(plot, d, ce);
      // Clic en una estación → su ficha completa AL LADO del mapa (v16).
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
        `<optgroup label="${esc(App.redEtiqueta(rg))}">${grupos.get(rg).map(e =>
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
    // El histórico diario completo vive en el equipo. El visor solo publica el tramo
    // reciente del año actual; las normales/envolventes agregadas siguen disponibles.
    const minAnio = window.HIDROMET_VISOR ? anioActual : 1990;
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
        `<option value="${esc(e.codigo)}">${esc(e.nombre || e.codigo)} (${esc(e.codigo)})${e.region ? " · " + esc(App.redEtiqueta(e.region)) : ""}</option>`).join("");
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

  // PESTAÑA — SERIES, RELLENO Y MAPA POR RANGO ------------------------------
  function pintarSerieRelleno(host, d) {
    if (!window.Plotly || !host) return;
    if (!d || d.error) { limpiarPlot(host); host.innerHTML = vacio("⚠️", esc(d && d.error || "Sin datos")); return; }
    const u = esc(d.unidad || ""), fechas = d.fechas || [];
    const traces = [
      { type: "scatter", mode: "lines", x: fechas, y: d.estimado_grillado, name: "Grilla corregida",
        line: { color: "#2f7fc1", width: 1.5 }, opacity: .75,
        hovertemplate: `%{x}<br>%{y:.1f} ${u}<extra>Estimación grillada</extra>` },
      { type: "scatter", mode: "lines", x: fechas, y: d.completado, name: "Serie completada",
        line: { color: "#26a69a", width: 2.2 },
        customdata: d.procedencia || [],
        hovertemplate: `%{x}<br><b>%{y:.1f} ${u}</b><br>%{customdata}<extra>Completada</extra>` },
      { type: "scatter", mode: "markers", x: fechas, y: d.observado, name: "Observación QC",
        marker: { color: "#10243f", size: 5, line: { color: "#fff", width: .7 } },
        hovertemplate: `%{x}<br><b>%{y:.1f} ${u}</b><extra>Observado</extra>` },
    ];
    const layout = App.plotlyLayoutBase({ height: 410, margin: { l: 52, r: 18, t: 10, b: 45 },
      hovermode: "x unified", legend: { orientation: "h", y: 1.12, x: .5, xanchor: "center" },
      xaxis: { type: "date", rangeslider: { visible: true, thickness: .08 }, gridcolor: "rgba(120,130,150,.12)" },
      yaxis: { title: d.unidad || "", rangemode: d.variable === "precip" ? "tozero" : "normal",
        gridcolor: "rgba(120,130,150,.14)", zeroline: false },
    });
    Plotly.react(host, traces, layout, App.plotlyConfig());
  }

  function metricasRelleno(d) {
    const c = d.cobertura || {}, fm = (d.metricas || {}).fuera_muestra || {},
      dg = (d.metricas || {}).diagnostica || {};
    const met = (et, v, sub) => `<div class="cl-kpi"><div class="v">${v == null ? "—" : esc(v)}</div>` +
      `<div class="e">${esc(et)}</div>${sub ? `<small class="cl-sutil">${esc(sub)}</small>` : ""}</div>`;
    return `<div class="cl-kpis cl-kpis-diario">
      ${met("Observados", c.observados, `${c.dias || 0} días`)}
      ${met("Rellenados", c.rellenados, "estimación trazable")}
      ${met("Vacíos", c.vacios, "sin estimación compatible")}
      ${met("MAE fuera de muestra", fm.mae, fm.n ? `n=${fm.n}` : "no disponible en el rango")}
      ${met("RMSE fuera de muestra", fm.rmse, fm.n ? `n=${fm.n}` : "validación espacial")}
      ${met("Correlación fuera de muestra", fm.correlacion, fm.n ? `n=${fm.n}` : "validación espacial")}
    </div>
    <details class="cl-metricas-det"><summary>Comparación diagnóstica de la grilla</summary>
      <p>n=${num(dg.n)} · MAE=${num(dg.mae, 2)} · RMSE=${num(dg.rmse, 2)} · sesgo=${num(dg.bias, 2)} · r=${num(dg.correlacion, 2)}.</p>
      <p>${esc(dg.nota || "")}</p></details>`;
  }

  const _dailyChunks = new Map();
  async function leerBinGzip(url) {
    if (_dailyChunks.has(url)) return _dailyChunks.get(url);
    const promise = (async () => {
      const response = await fetch(url, { cache: "no-cache" });
      if (!response.ok) throw new Error(`Chunk climático no publicado (HTTP ${response.status})`);
      let bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
        if (typeof DecompressionStream !== "function") throw new Error("El navegador no admite gzip.");
        const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
        bytes = new Uint8Array(await new Response(stream).arrayBuffer());
      }
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    })();
    _dailyChunks.set(url, promise); return promise;
  }
  const fechaUTC = s => new Date(`${s}T00:00:00Z`);
  const diaMs = 86400000;
  function metricasCliente(obs, pred) {
    const pares = obs.map((v, i) => [v, pred[i]]).filter(p => p[0] != null && p[1] != null && isFinite(p[0]) && isFinite(p[1]));
    if (!pares.length) return { n: 0, mae: null, rmse: null, bias: null, correlacion: null, kge: null };
    const O = pares.map(p => p[0]), P = pares.map(p => p[1]), n = O.length;
    const mo = O.reduce((a, b) => a + b, 0) / n, mp = P.reduce((a, b) => a + b, 0) / n;
    const err = P.map((v, i) => v - O[i]);
    const so = Math.sqrt(O.reduce((a, v) => a + (v - mo) ** 2, 0) / n), sp = Math.sqrt(P.reduce((a, v) => a + (v - mp) ** 2, 0) / n);
    const corr = n >= 3 && so > 0 && sp > 0 ? O.reduce((a, v, i) => a + (v - mo) * (P[i] - mp), 0) / n / so / sp : null;
    const kge = corr != null && Math.abs(mo) > 1e-12 ? 1 - Math.sqrt((corr - 1) ** 2 + (sp / so - 1) ** 2 + (mp / mo - 1) ** 2) : null;
    const r = v => v == null || !isFinite(v) ? null : Math.round(v * 1000) / 1000;
    return { n, mae: r(err.reduce((a, v) => a + Math.abs(v), 0) / n),
      rmse: r(Math.sqrt(err.reduce((a, v) => a + v * v, 0) / n)),
      bias: r(err.reduce((a, v) => a + v, 0) / n), correlacion: r(corr), kge: r(kge) };
  }
  async function serieDesdeChunks(manifest, code, variable, desde, hasta) {
    const stationIndex = manifest.stations.findIndex(s => String(s.codigo) === String(code));
    if (stationIndex < 0) throw new Error("Estación no incluida en el producto diario publicado.");
    const station = manifest.stations[stationIndex], nStations = manifest.stations.length, scale = Number(manifest.scale || 10);
    const start = fechaUTC(desde), end = fechaUTC(hasta), fechas = [], observed = [], grid = [], cv = [];
    const mobile = manifest.schema === "hidromet.clima-diario.v2";
    const chunks = [];
    if (mobile) {
      const windowStart = fechaUTC(manifest.window.desde), windowEnd = fechaUTC(manifest.window.hasta);
      if (start < windowStart || end > windowEnd || start > end) throw new Error("Rango fuera de la ventana móvil publicada.");
      chunks.push({ desde: windowStart, hasta: windowEnd, file: manifest.series.files[variable] });
    } else {
      for (let y = start.getUTCFullYear(); y <= end.getUTCFullYear(); y++) chunks.push({
        desde: new Date(Date.UTC(y, 0, 1)), hasta: new Date(Date.UTC(y, 11, 31)),
        file: `series_${variable}_${y}.bin.gz`, year: y,
      });
    }
    const buffers = await Promise.all(chunks.map(c => leerBinGzip(`productos/clima/diario/${c.file}`)));
    chunks.forEach((chunk, yi) => {
      const days = Math.round((chunk.hasta - chunk.desde) / diaMs) + 1, plane = days * nStations;
      const values = new Int16Array(buffers[yi]);
      if (values.length !== plane * 3) throw new Error(`Chunk de serie ${chunk.year || "móvil"} inconsistente.`);
      const a = Math.max(start.getTime(), chunk.desde.getTime()), b = Math.min(end.getTime(), chunk.hasta.getTime());
      for (let time = a; time <= b; time += diaMs) {
        const day = Math.round((time - chunk.desde.getTime()) / diaMs), pos = day * nStations + stationIndex;
        const decode = raw => raw === manifest.missing_i16 ? null : raw / scale;
        fechas.push(new Date(time).toISOString().slice(0, 10)); observed.push(decode(values[pos]));
        grid.push(decode(values[plane + pos])); cv.push(decode(values[2 * plane + pos]));
      }
    });
    const completed = [], provenance = [];
    observed.forEach((v, i) => {
      if (v != null) { completed.push(v); provenance.push("observado"); }
      else if (grid[i] != null) { completed.push(grid[i]); provenance.push("estimado_grillado"); }
      else { completed.push(null); provenance.push("vacio"); }
    });
    const formal = metricasCliente(observed, cv), diagnostic = metricasCliente(observed, grid);
    formal.tipo = "validacion_espacial_fuera_muestra"; formal.disponible = !!formal.n;
    formal.nota = "La estación se excluye del ajuste al estimar su valor.";
    diagnostic.tipo = "comparacion_diagnostica";
    diagnostic.nota = "No mide habilidad independiente: la estación pudo participar en la corrección diaria.";
    const count = kind => provenance.filter(x => x === kind).length;
    return { codigo: code, nombre: station.nombre || code, variable, unidad: variable === "precip" ? "mm" : "°C",
      desde, hasta, agregacion_observada: variable === "precip" ? station.precipitation_aggregation : (variable === "tmax" ? "max" : "min"),
      grilla_compatible: variable !== "precip" || station.precip_grid_compatible,
      contrato_grilla: variable !== "precip" || station.precip_grid_compatible ? "misma ventana diaria" : "ventana incompatible; no se rellena",
      fechas, observado: observed, estimado_grillado: grid, completado: completed, procedencia: provenance,
      qc_observacion: observed.map(v => v == null ? "SIN_VALOR_QC" : "PASS"),
      cobertura: { dias: fechas.length, observados: count("observado"), rellenados: count("estimado_grillado"), vacios: count("vacio") },
      metricas: { fuera_muestra: formal, diagnostica: diagnostic },
      metodologia: manifest.method || "Observación QC > estimación grillada compatible > vacío; nunca se sobrescribe una observación." };
  }
  async function mapaDesdeChunks(manifest, desde, hasta, operation) {
    const start = fechaUTC(desde), end = fechaUTC(hasta), chunks = [];
    if (manifest.schema === "hidromet.clima-diario.v2") {
      const windowStart = fechaUTC(manifest.window.desde), windowEnd = fechaUTC(manifest.window.hasta);
      if (start < windowStart || end > windowEnd || start > end) throw new Error("Rango fuera de la ventana móvil publicada.");
      chunks.push({ desde: windowStart, hasta: windowEnd, file: manifest.grid.file });
    } else {
      for (let y = start.getUTCFullYear(); y <= end.getUTCFullYear(); y++) chunks.push({
        desde: new Date(Date.UTC(y, 0, 1)), hasta: new Date(Date.UTC(y, 11, 31)),
        file: `grid_precip_${y}.bin.gz`, year: y,
      });
    }
    const buffers = await Promise.all(chunks.map(c => leerBinGzip(`productos/clima/diario/${c.file}`)));
    const cells = manifest.grid.ny * manifest.grid.nx, totalDays = Math.round((end - start) / diaMs) + 1;
    const sum = new Float64Array(cells), count = new Uint32Array(cells), selected = [];
    chunks.forEach((chunk, yi) => {
      const days = Math.round((chunk.hasta - chunk.desde) / diaMs) + 1, values = new Uint16Array(buffers[yi]);
      if (values.length !== days * cells) throw new Error(`Chunk cartográfico ${chunk.year || "móvil"} inconsistente.`);
      const a = Math.max(start.getTime(), chunk.desde.getTime()), b = Math.min(end.getTime(), chunk.hasta.getTime());
      for (let time = a; time <= b; time += diaMs) {
        const day = Math.round((time - chunk.desde.getTime()) / diaMs), base = day * cells;
        selected.push([values, base]);
        for (let i = 0; i < cells; i++) if (values[base + i] !== manifest.missing_u16) { sum[i] += values[base + i] / manifest.scale; count[i]++; }
      }
    });
    if (selected.length !== totalDays) throw new Error(`Cobertura incompleta: ${selected.length} de ${totalDays} días.`);
    if (operation === "mediana" && totalDays > 3660) throw new Error("La mediana exacta admite hasta 10 años.");
    const field = new Array(cells).fill(null), finite = [], scratch = operation === "mediana" ? new Float32Array(totalDays) : null;
    for (let i = 0; i < cells; i++) {
      if (count[i] !== totalDays) continue;
      let value;
      if (operation === "acumulado") value = sum[i];
      else if (operation === "media") value = sum[i] / totalDays;
      else {
        for (let d = 0; d < selected.length; d++) scratch[d] = selected[d][0][selected[d][1] + i] / manifest.scale;
        scratch.sort(); const mid = Math.floor(totalDays / 2);
        value = totalDays % 2 ? scratch[mid] : (scratch[mid - 1] + scratch[mid]) / 2;
      }
      field[i] = Math.round(value * 10) / 10; finite.push(value);
    }
    finite.sort((a, b) => a - b); const vmax = Math.max(1, finite[Math.floor((finite.length - 1) * .98)] || 1);
    const palette = ["#ffffd9", "#edf8b1", "#c7e9b4", "#7fcdbb", "#41b6c4", "#1d91c0", "#225ea8", "#0c2c84"];
    const colorscale = []; palette.forEach((color, i) => { colorscale.push([i / palette.length, color], [(i + 1) / palette.length, color]); });
    const rows = []; for (let y = 0; y < manifest.grid.ny; y++) rows.push(field.slice(y * manifest.grid.nx, (y + 1) * manifest.grid.nx));
    const label = { acumulado: "Lluvia acumulada", media: "Lluvia media diaria", mediana: "Mediana diaria de lluvia" }[operation];
    return { lon: manifest.grid.lon, lat: manifest.grid.lat, campo: rows, colorscale, vmin: 0, vmax: Math.round(vmax * 10) / 10,
      unidad: "mm", variable: "precip", operacion: operation, desde, hasta, dias: totalDays,
      cobertura: { dias_solicitados: totalDays, dias_usados: totalDays, completa: true },
      titulo: `${label} — ${desde} a ${hasta}`, leyenda_sub: `${totalDays} días · ${desde} a ${hasta}` };
  }

  async function tabDiario(c) {
    inyectarCSS(); _alTema = null; await cargarGeo();
    c.innerHTML = cargando("Preparando series y grillas diarias…");
    let availability, stations = [], dailyManifest = null;
    try {
      if (window.HIDROMET_VISOR) {
        const response = await fetch("productos/clima/diario/manifest.json", { cache: "no-cache" });
        if (!response.ok) throw new Error(`Producto diario no publicado (HTTP ${response.status})`);
        dailyManifest = await response.json();
        availability = { mapa_precip: dailyManifest.grid }; stations = dailyManifest.stations || [];
      } else {
        [availability, stations] = await Promise.all([
          App.api("/clima/diario_disponible"),
          App.api("/clima/estaciones").then(x => x.estaciones || []),
        ]);
      }
    } catch (e) { c.innerHTML = vacio("⚠️", esc(e.message)); return; }
    const mapInv = availability.mapa_precip || {};
    const end0 = mapInv.hasta || new Date().toISOString().slice(0, 10);
    const startDate = new Date(`${end0}T12:00:00`); startDate.setDate(startDate.getDate() - 10);
    const start0 = mapInv.desde || startDate.toISOString().slice(0, 10);
    const options = stations.map(e => `<option value="${esc(e.codigo)}">${esc(e.nombre || e.codigo)} (${esc(e.codigo)}) · ${esc(App.redEtiqueta(e.dependencia || e.region || ""))}</option>`).join("");
    c.innerHTML = `<div class="cl-wrap cl-diario-wrap">
      <div class="cl-toolbar cl-diario-toolbar">
        <div class="cl-grupo"><span>Desde</span><input type="date" data-rol="desde" min="${esc(mapInv.desde || "1990-01-01")}" max="${esc(end0)}" value="${esc(start0)}"></div>
        <div class="cl-grupo"><span>Hasta</span><input type="date" data-rol="hasta" min="${esc(mapInv.desde || "1990-01-01")}" max="${esc(end0)}" value="${esc(end0)}"></div>
        <div class="cl-grupo"><span>Mapa de lluvia</span><select data-rol="operacion"><option value="acumulado">Acumulado</option><option value="media">Promedio diario</option><option value="mediana">Mediana diaria</option></select></div>
        <div class="cl-grupo"><button class="cl-btn" data-rol="actualizar">Actualizar producto</button></div>
      </div>
      <div class="cl-card cl-rango-card"><h3 class="cl-maptit" data-rol="map-tit">Mapa de lluvia por rango</h3>
        <div class="cl-plot cl-plot-mapa cl-rango-mapa" data-rol="mapa"></div><div class="ct-leyenda-carta cl-leyenda" data-rol="leyenda"></div>
        <p class="cl-nota" data-rol="map-nota">Se exige cobertura completa en cada píxel para el período seleccionado.</p></div>
      <div class="cl-card"><div class="cl-serie-head"><h3 class="cl-maptit">Cruce y relleno por estación</h3>
        <div class="cl-serie-controles"><input class="cl-buscar" data-rol="buscar" type="search" placeholder="Buscar estación…">
          <select data-rol="est">${options}</select><select data-rol="variable"><option value="precip">Precipitación</option><option value="tmax">T. máxima</option><option value="tmin">T. mínima</option></select></div></div>
        <div class="cl-plot" data-rol="serie"></div><div data-rol="metricas"></div>
        <div class="cl-aviso"><span class="ic">ⓘ</span><p data-rol="metodo">Los huecos se rellenan únicamente con una grilla de ventana temporal compatible. Cada valor conserva su procedencia y QC.</p></div></div>
    </div>`;
    const desde = c.querySelector('[data-rol="desde"]'), hasta = c.querySelector('[data-rol="hasta"]'),
      operation = c.querySelector('[data-rol="operacion"]'), mapHost = c.querySelector('[data-rol="mapa"]'),
      mapTitle = c.querySelector('[data-rol="map-tit"]'), station = c.querySelector('[data-rol="est"]'),
      variable = c.querySelector('[data-rol="variable"]'), seriesHost = c.querySelector('[data-rol="serie"]'),
      metricsHost = c.querySelector('[data-rol="metricas"]'), method = c.querySelector('[data-rol="metodo"]'),
      search = c.querySelector('[data-rol="buscar"]');
    let lastMap = null, lastSeries = null;
    async function loadMap() {
      limpiarPlot(mapHost); mapHost.innerHTML = cargando("Agregando grillas diarias…");
      try {
        const d = dailyManifest
          ? await mapaDesdeChunks(dailyManifest, desde.value, hasta.value, operation.value)
          : await App.api(`/clima/mapa_rango?desde=${desde.value}&hasta=${hasta.value}&operacion=${operation.value}`);
        if (d.error) throw new Error(d.error);
        d.leyenda_sub = `${d.dias} días · ${d.desde} a ${d.hasta}`;
        mapTitle.textContent = d.titulo || "Mapa por rango"; lastMap = d; pintarMapa(mapHost, d, null);
      } catch (e) { limpiarPlot(mapHost); mapHost.innerHTML = vacio("⚠️", esc(e.message)); }
    }
    async function loadSeries() {
      if (!station.value) return;
      limpiarPlot(seriesHost); seriesHost.innerHTML = cargando("Cruzando observación y grilla…"); metricsHost.innerHTML = "";
      try {
        const d = dailyManifest
          ? await serieDesdeChunks(dailyManifest, station.value, variable.value, desde.value, hasta.value)
          : await App.api(`/clima/serie_relleno?codigo=${encodeURIComponent(station.value)}&variable=${variable.value}&desde=${desde.value}&hasta=${hasta.value}`);
        if (d.error) throw new Error(d.error);
        lastSeries = d; pintarSerieRelleno(seriesHost, d); metricsHost.innerHTML = metricasRelleno(d);
        method.textContent = `${d.metodologia} Contrato: ${d.contrato_grilla}.`;
      } catch (e) { limpiarPlot(seriesHost); seriesHost.innerHTML = vacio("⚠️", esc(e.message)); }
    }
    async function updateAll() { await Promise.all([loadMap(), loadSeries()]); }
    c.querySelector('[data-rol="actualizar"]').onclick = updateAll;
    station.onchange = loadSeries; variable.onchange = loadSeries; operation.onchange = loadMap;
    search.oninput = () => {
      const q = search.value.trim().toLowerCase(), selected = station.value;
      station.innerHTML = stations.filter(e => !q || `${e.codigo} ${e.nombre || ""} ${e.dependencia || ""}`.toLowerCase().includes(q))
        .map(e => `<option value="${esc(e.codigo)}">${esc(e.nombre || e.codigo)} (${esc(e.codigo)}) · ${esc(App.redEtiqueta(e.dependencia || e.region || ""))}</option>`).join("");
      if ([...station.options].some(o => o.value === selected)) station.value = selected;
      else if (station.value) loadSeries();
    };
    _alTema = () => { if (lastMap) pintarMapa(mapHost, lastMap, null); if (lastSeries) pintarSerieRelleno(seriesHost, lastSeries); };
    updateAll();
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
          { id: "diario", etiqueta: "Series y acumulados", render: tabDiario },
          { id: "records", etiqueta: "Récords", render: tabRecords },
          // "Por coordenada" consulta lat/lon libres (imposible de congelar) → oculta en el visor.
          window.HIDROMET_VISOR ? null : { id: "punto", etiqueta: "Por coordenada", render: tabPunto },
          { id: "glosario", etiqueta: "Metodología", render: tabGlosario },
        ],
      });
    },
  });
})();
