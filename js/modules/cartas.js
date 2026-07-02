/* ============================================================
   HidroMet — Cartas y Alertas. Acento azul (--blue).
   Arquitectura intacta: App.registrar / App.api / App.tarea / App.aviso /
   App.modalTarea. Reconstruido FIEL al bloque data-screen-label="Cartas y
   Alertas" del diseño (Diseño/HANDOFF/diseno/HidroMet.dc.html) con DATOS REALES:
   · /cartas/productos            → árbol tipo→variable→período→{fuentes,instantes}
   · /cartas/carta.png            → imagen real (matplotlib) por archivo+capa+record
   · /cartas/alertas_programa     → desenlaces (5 lecturas) de la validación
   · /cartas/alertas_programa/fechas + /validacion.png
   · /cartas/umbrales_fijos       → editor Fijos/ZPH (GET/POST)
   · /cartas/advertencias/resumen → tarjetas + buscador
   · /cartas/advertencias/detalle → panel de detalle
   · /cartas/advertencias/cruce.png → mini-mapa y mapa del polígono
   · /cartas/actualizar           → tarea de regeneración (botón oscuro)
   Las cartas NO se dibujan a mano: son <img src="/api/cartas/carta.png?...">.
   ============================================================ */
"use strict";

(() => {
  const esc = v => String(v ?? "").replace(/[&<>"']/g,
    c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const api = (r) => "/api" + r;                       // ruta directa para <img src>
  const qs = (o) => Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");

  /* ---------- TIPOS (orden EXACTO del diseño) ----------
     id  = id del tipo en /cartas/productos (advertencias y alertas mapeados).
     cuerpo: "alertas" | "advertencias" | "grid". */
  const TIPOS = [
    { id: "pronostico",   etiqueta: "Pronóstico",            cuerpo: "grid" },
    { id: "calibrado",    etiqueta: "Calibrado",             cuerpo: "grid" },
    { id: "hidro",        etiqueta: "Hidroestimadores",      cuerpo: "grid" },
    { id: "alertas",      etiqueta: "⚠ Alertas", danger: true, cuerpo: "alertas" },
    { id: "heladas",      etiqueta: "Heladas / Calor",       cuerpo: "grid" },
    { id: "ffgs",         etiqueta: "FFGS",                  cuerpo: "grid" },
    { id: "advertencias", etiqueta: "Advertencias oficiales", cuerpo: "advertencias" },
  ];

  // Variable de alerta (UI) → {capa base del .nc, variable de validación}.
  const VAR_ALERTA = [
    { id: "alerta_lluvia", etiqueta: "Alerta de lluvia", val: "precip" },
    { id: "alerta_tmin",   etiqueta: "Alerta T. mínima", val: "Tmin" },
    { id: "alerta_tmax",   etiqueta: "Alerta T. máxima", val: "Tmax" },
  ];
  // Fuentes de la grilla de Alertas, en orden de preferencia: pronóstico (Consenso +
  // crudos GFS/ICON/IFS) y luego CALIBRADOS (BIAS/RF/GB/CAT/LSTM). La grilla pinta las
  // realmente presentes en el .nc; oculta capas meta (Confianza / Modelo de referencia).
  const ALERTA_FUENTES = ["CONSENSO", "GFS", "ICON", "IFS", "BIAS", "RF", "GB", "CAT", "LSTM"];
  const ALERTA_FUENTE_ROTULO = { CONSENSO: "Consenso", GFS: "GFS", ICON: "ICON", IFS: "IFS HRES",
    BIAS: "Calibrado · BIAS", RF: "Calibrado · RF", GB: "Calibrado · GB", CAT: "Calibrado · CAT", LSTM: "Calibrado · LSTM" };
  const ALERTA_FUENTE_OCULTA = new Set(["Confianza", "Modelo de referencia"]);

  // Toggles de capa: id (param de carta.png) + etiqueta + valor inicial (1=on).
  const TOGGLES = [
    { id: "titulo", et: "Título", on: 1 }, { id: "escala", et: "Escala", on: 1 },
    { id: "galapagos", et: "Galápagos", on: 1 }, { id: "interpolar", et: "Interpolar", on: 1 },
    { id: "isolineas", et: "Isolíneas", on: 0 }, { id: "grilla", et: "Grilla", on: 1 },
    { id: "estaciones", et: "Estaciones", on: 0 },
  ];

  // Desenlaces de la validación de alertas (clave del backend → tono de tarjeta).
  // Los 4 primeros son sobre CASOS ACTIVOS (evento o alerta); el último es la línea
  // base sobre el total. "Acierto exacto" = nivel justo (estricto); el resumen real
  // del desempeño es el Puntaje graduado del titular.
  const DESENLACES = [
    { clave: "aciertos",           etiqueta: "Acierto exacto",     tono: "ok",     nota: "al nivel justo" },
    { clave: "no_alertados",       etiqueta: "Evento no alertado", tono: "danger", nota: "no detectado" },
    { clave: "insuficientes",      etiqueta: "Nivel insuficiente", tono: "warn",   nota: "subestimado" },
    { clave: "sobredimensionadas", etiqueta: "Sobredimensionada",  tono: "warn",   nota: "sobre-aviso" },
    { clave: "correcto_sin_alerta",etiqueta: "Correcto sin alerta",tono: "slate",  nota: "días sin evento" },
  ];

  const fmtNum = (n) => (n == null ? "—" : Number(n).toLocaleString("es-EC"));
  const fmtPct = (n) => (n == null ? "—" : Number(n).toLocaleString("es-EC", { maximumFractionDigits: 1 }));

  /* ============================================================
     ESTADO del módulo (vive mientras la vista está montada)
     ============================================================ */
  let E = null;
  let vp = null;     // controlador de App.vistaPestanas activo (para recargar tras Actualizar)

  /* ============================================================
     Lienzo de carta = MAPA INTERACTIVO (Plotly heatmap) alimentado por
     /cartas/carta_datos (malla cruda lat/lon/valor + escala del motor).
     Más dinámico/estético que la imagen estática: hover con el valor de
     cada celda, zoom y pan. La DESCARGA (botón ⤓) entrega la carta FORMAL
     (PNG del motor matplotlib con todas las capas de presentación).
     ============================================================ */
  let geoCartas = null;                       // FeatureCollection provincias (cache)
  async function asegurarGeoCartas() {
    if (geoCartas !== null) return;
    try { geoCartas = await App.api("/datos/capas/provincias.geojson"); }
    catch (e) { geoCartas = false; }
  }
  // Contorno de Ecuador (provincias) con ENCASILLADO: línea BLANCA ancha debajo +
  // NEGRA más fina encima → resalta y se identifica sobre cualquier carta. `bbox`
  // opcional filtra features por extensión (p.ej. solo Galápagos para el inset).
  function trazasOutline(ejeX, ejeY, bbox, wBlack, wWhite) {
    if (!geoCartas || !geoCartas.features) return [];
    const xs = [], ys = [];
    const dentro = (lo, la) => !bbox || (lo >= bbox[0] && lo <= bbox[1] && la >= bbox[2] && la <= bbox[3]);
    const empuja = ring => {
      let any = false;
      for (const [lo, la] of ring) { if (!dentro(lo, la)) continue; xs.push(lo); ys.push(la); any = true; }
      if (any) { xs.push(null); ys.push(null); }
    };
    for (const f of geoCartas.features) {
      const g = f.geometry; if (!g) continue;
      if (g.type === "Polygon") g.coordinates.forEach(empuja);
      else if (g.type === "MultiPolygon") g.coordinates.forEach(p => p.forEach(empuja));
    }
    if (!xs.length) return [];
    const base = { type: "scatter", mode: "lines", x: xs, y: ys, hoverinfo: "skip", showlegend: false, xaxis: ejeX, yaxis: ejeY };
    // Outline geográfico = halo + línea. En OSCURO se invierte (halo oscuro + línea clara) para
    // que el contorno no desaparezca sobre el mar oscuro.
    const _osc = (App.tema && App.tema() === "oscuro");
    return [
      Object.assign({}, base, { line: { color: _osc ? "#0B1322" : "#ffffff", width: wWhite || 4.5 } }),
      Object.assign({}, base, { line: { color: _osc ? "#AEBBD0" : "#0b0d12", width: wBlack || 2 } }),
    ];
  }

  // Microcuencas operativas del FFGS (NWSAFFGS, 1682 subcuencas): contorno que se
  // dibuja sobre las cartas FFGS para ver el dato por subcuenca.
  let geoMicro = null;                         // FeatureCollection microcuencas (cache)
  async function asegurarMicrocuencas() {
    if (geoMicro !== null) return;
    try { geoMicro = await App.api("/datos/capas/ffgs_microcuencas.geojson"); }
    catch (e) { geoMicro = false; }
  }
  function trazaMicrocuencas() {
    if (!geoMicro || !geoMicro.features) return null;
    const xs = [], ys = [];
    const empuja = ring => { for (const [lo, la] of ring) { xs.push(lo); ys.push(la); } xs.push(null); ys.push(null); };
    for (const f of geoMicro.features) {
      const g = f.geometry; if (!g) continue;
      if (g.type === "Polygon") g.coordinates.forEach(empuja);
      else if (g.type === "MultiPolygon") g.coordinates.forEach(p => p.forEach(empuja));
    }
    if (!xs.length) return null;
    const dark = !!(App.tema && App.tema() === "oscuro");
    // scattergl: 1682 cuencas = muchos puntos; WebGL las dibuja sin lag. Línea fina
    // y tenue para que el COLOR del campo siga siendo lo dominante.
    return { type: "scattergl", mode: "lines", x: xs, y: ys, hoverinfo: "skip",
      line: { color: dark ? "rgba(223,230,247,.30)" : "rgba(35,49,77,.32)", width: 0.6 },
      showlegend: false };
  }

  // Estaciones (toggle "Estaciones"): catálogo cacheado + traza de puntos dentro de un bbox.
  let _estaciones = null;
  async function asegurarEstaciones() {
    if (_estaciones !== null) return;
    try {
      const r = await App.api("/cartas/estaciones");
      _estaciones = Array.isArray(r) ? r : (r && Array.isArray(r.estaciones) ? r.estaciones : false);
    } catch (e) { _estaciones = false; }
  }
  function trazaEstaciones(bbox, ejeX, ejeY) {
    if (!Array.isArray(_estaciones) || !_estaciones.length) return null;
    const xs = [], ys = [], tx = [];
    for (const e of _estaciones) {
      if (e.lon == null || e.lat == null) continue;
      if (e.lon < bbox[0] || e.lon > bbox[1] || e.lat < bbox[2] || e.lat > bbox[3]) continue;
      xs.push(e.lon); ys.push(e.lat); tx.push(e.nombre || e.codigo || "");
    }
    if (!xs.length) return null;
    const oscuro = !!(App.tema && App.tema() === "oscuro");
    return { type: "scatter", mode: "markers", x: xs, y: ys, text: tx, xaxis: ejeX, yaxis: ejeY,
      marker: { size: 5, color: oscuro ? "#E8EDF6" : "#10233F", line: { width: 1, color: oscuro ? "#0B1322" : "#fff" } },
      hovertemplate: "%{text}<extra></extra>", showlegend: false };
  }

  // Color (rgb) en una posición pos∈[0,1] interpolando el colorscale de Plotly
  // ([[pos,"#hex"],...]). Para pintar cada cuenca con el color exacto de su valor.
  function _hexRgb(h) {
    h = String(h).replace("#", "");
    if (h.length === 3) h = h.split("").map(c => c + c).join("");
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  function _colorEn(pos, cs) {
    pos = Math.max(0, Math.min(1, pos));
    let a = cs[0], b = cs[cs.length - 1];
    for (let i = 0; i < cs.length - 1; i++) { if (pos >= cs[i][0] && pos <= cs[i + 1][0]) { a = cs[i]; b = cs[i + 1]; break; } }
    const span = (b[0] - a[0]) || 1, t = (pos - a[0]) / span;
    const ca = _hexRgb(a[1]), cb = _hexRgb(b[1]);
    return `rgb(${ca.map((c, k) => Math.round(c + (cb[k] - c) * t)).join(",")})`;
  }
  // RELLENO VECTORIAL FFGS: agrupa las microcuencas por BANDA de la escala (niveles)
  // y devuelve una traza de relleno por banda (fill:"toself", subpolígonos separados
  // por null). Cuencas por debajo del primer umbral quedan SIN pintar (transparentes,
  // p.ej. FFT sin amenaza). Pocas trazas (≈nº de bandas) → rápido y nítido.
  function trazasCuencasFFGS(d) {
    if (!d.cuencas || !geoMicro || !geoMicro.features) return null;
    const niv = d.niveles || [], cs = d.colorscale || [];
    const vmin = d.vmin, vmax = d.vmax;
    if (niv.length < 2 || !cs.length || vmin == null || vmax == null) return null;
    const val = new Map();
    const ids = d.cuencas.ids, vals = d.cuencas.valores;
    for (let i = 0; i < ids.length; i++) val.set(ids[i], vals[i]);
    const nb = niv.length - 1, span = (vmax - vmin) || 1;
    const colorBanda = [];
    for (let k = 0; k < nb; k++) colorBanda.push(_colorEn(((niv[k] + niv[k + 1]) / 2 - vmin) / span, cs));
    const binDe = v => { if (v < niv[0]) return -1; for (let k = nb - 1; k >= 0; k--) if (v >= niv[k]) return k; return 0; };
    const xs = Array.from({ length: nb }, () => []), ys = Array.from({ length: nb }, () => []);
    const grisX = [], grisY = [];                 // cuencas CON dato pero sin amenaza (v < primer umbral)
    const empuja = (X, Y, ring) => { for (const [lo, la] of ring) { X.push(lo); Y.push(la); } X.push(null); Y.push(null); };
    for (const f of geoMicro.features) {
      const cod = f.properties && f.properties.codigo; if (cod == null) continue;
      const v = val.get(cod); if (v == null) continue;
      const k = binDe(v);
      const g = f.geometry; if (!g) continue;
      const X = k < 0 ? grisX : xs[k], Y = k < 0 ? grisY : ys[k];
      if (g.type === "Polygon") empuja(X, Y, g.coordinates[0]);
      else if (g.type === "MultiPolygon") g.coordinates.forEach(p => empuja(X, Y, p[0]));
    }
    const traces = [];
    // Sin amenaza pero CON dato → relleno GRIS (contraste con el fondo; antes salían transparentes).
    if (grisX.length) {
      const oscuro = !!(App.tema && App.tema() === "oscuro");
      traces.push({ type: "scatter", mode: "lines", x: grisX, y: grisY, fill: "toself",
        fillcolor: oscuro ? "rgba(120,133,157,.42)" : "rgba(176,186,201,.55)",
        line: { width: 0 }, hoverinfo: "skip", showlegend: false });
    }
    for (let k = 0; k < nb; k++) {
      if (!xs[k].length) continue;
      traces.push({ type: "scatter", mode: "lines", x: xs[k], y: ys[k], fill: "toself",
        fillcolor: colorBanda[k], line: { width: 0, color: colorBanda[k] },
        hoverinfo: "skip", showlegend: false });
    }
    return traces;
  }

  // VISTA DINÁMICA FFGS: marcadores INVISIBLES en el centroide de cada microcuenca con
  // su valor exacto, para que al pasar el cursor (hovermode "closest") se vea el valor
  // de la cuenca — como un popup. Una sola traza (rápido) y no tapa el relleno.
  function trazaHoverCuencasFFGS(d) {
    if (!d.cuencas || !geoMicro || !geoMicro.features) return null;
    const val = new Map();
    const ids = d.cuencas.ids, vals = d.cuencas.valores;
    for (let i = 0; i < ids.length; i++) val.set(ids[i], vals[i]);
    const unidad = d.unidad || "";
    const fmt = v => (Math.abs(v) < 10 ? v.toFixed(2) : v.toFixed(1));
    const centroide = ring => {
      let sx = 0, sy = 0, n = 0;
      for (const [lo, la] of ring) { sx += lo; sy += la; n++; }
      return n ? [sx / n, sy / n] : null;
    };
    const hx = [], hy = [], ht = [];
    for (const f of geoMicro.features) {
      const cod = f.properties && f.properties.codigo; if (cod == null) continue;
      const v = val.get(cod); if (v == null) continue;
      const g = f.geometry; if (!g) continue;
      let ring = null;
      if (g.type === "Polygon") ring = g.coordinates[0];
      else if (g.type === "MultiPolygon") {
        let bn = -1; for (const p of g.coordinates) if (p[0] && p[0].length > bn) { bn = p[0].length; ring = p[0]; }
      }
      if (!ring) continue;
      const c = centroide(ring); if (!c) continue;
      hx.push(c[0]); hy.push(c[1]);
      ht.push(`Microcuenca ${esc(String(cod))}<br><b>${fmt(v)} ${esc(unidad)}</b>`);
    }
    if (!hx.length) return null;
    const oscuro = !!(App.tema && App.tema() === "oscuro");
    return { type: "scattergl", mode: "markers", x: hx, y: hy, text: ht,
      marker: { size: 13, color: "rgba(0,0,0,0)" },
      hovertemplate: "%{text}<extra></extra>",
      hoverlabel: { bgcolor: oscuro ? "#0B1322" : "#10233F", bordercolor: "#46597A",
        font: { color: "#fff", size: 11 } },
      showlegend: false };
  }

  // Parámetros de DATOS de carta_datos (lo que carta.png necesita salvo toggles).
  function baseParams(params) {
    const b = { archivo: params.archivo, capa: params.capa, record: params.record };
    if (params.corrido) b.corrido = params.corrido;
    if (params.fin !== undefined && params.fin !== null && params.fin !== "") b.fin = params.fin;
    return b;
  }

  function lienzoCarta(params, alt) {
    const base = baseParams(params);
    const datosUrl = "/cartas/carta_datos?" + qs(base);
    // Descarga = carta FORMAL: todas las capas de presentación activas.
    const pngParams = Object.assign({}, base,
      { titulo: 1, escala: 1, galapagos: 1, interpolar: 1, grilla: 1, isolineas: 0, estaciones: 0 });
    // Descarga = JPG GUARDADO en Descargas por el servidor (el <a download> del PNG NO descarga en
    // WebView2). Se reusa carta_descargar (renderiza el PNG formal → JPG). nombre = de la carta.
    const slugNombre = String(alt || "carta").replace(/[^\w\-]+/g, "_").slice(0, 55) || "carta";
    const jpgRuta = "/cartas/carta_descargar?" + qs(Object.assign({}, pngParams, { nombre: slugNombre }));
    // Botón SHP: SOLO en cartas de alerta por nivel → zip con .shp + .qml de QGIS de la
    // advertencia EXACTA mostrada (misma variable, modelo y instante).
    const esAlertaNivel = /^alerta_(lluvia|tmin|tmax)_/.test(String(params.capa || ""));
    const esFFGS = /^ffgs_/.test(String(params.archivo || ""));
    const shpRuta = esAlertaNivel
      ? "/cartas/alerta_shp?" + qs({ capa: params.capa, record: params.record,
                                     modo: (E && E.alerta && E.alerta.modo) || "fija" })
      : esFFGS
      ? "/cartas/ffgs_shp?" + qs({ archivo: params.archivo, record: params.record })
      : "";
    const shpBtn = (esAlertaNivel || esFFGS) ? `<a class="ct-dl ct-dl-shp" role="button" tabindex="0" data-shp="${esc(shpRuta)}"
           title="Descargar en formato shapefile" aria-label="Descargar en formato shapefile">SHP</a>` : "";
    return `
      <div class="ct-lienzo" data-datos="${esc(datosUrl)}">
        <a class="ct-dl ct-dl-jpg" role="button" tabindex="0" data-jpg="${esc(jpgRuta)}" data-nombre="${esc(slugNombre)}"
           title="Descargar carta (imagen)" aria-label="Descargar carta">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/></svg>
        </a>${shpBtn}
        <div class="cargando mono">Cargando mapa…</div>
        <div class="ct-mapa-plot"></div>
        <div class="ct-zoomhint mono">Ctrl + rueda para zoom</div>
      </div>`;
  }

  function falloLienzo(div, msg) {
    const c = div.querySelector(".cargando"); if (c) c.remove();
    const plot = div.querySelector(".ct-mapa-plot"); if (plot) plot.style.display = "none";
    if (!div.querySelector(".fallo")) {
      const d = document.createElement("div");
      d.className = "fallo";
      d.innerHTML = `<div class="icono">🗺️</div>${esc(msg || "Sin carta para este instante")}`;
      div.appendChild(d);
    }
  }

  // Colores de banda (distintos consecutivos) de una colorscale Plotly escalonada.
  function coloresBanda(colorscale) {
    const cols = [];
    for (const par of (colorscale || [])) { const c = par[1]; if (cols[cols.length - 1] !== c) cols.push(c); }
    return cols;
  }
  // Fracciones [0,1] donde cambia el color = bordes de banda (longitud = nBandas+1).
  function bordesBanda(colorscale) {
    const fr = [];
    for (const par of (colorscale || [])) { const t = par[0]; if (!fr.length || fr[fr.length - 1] !== t) fr.push(t); }
    return fr;
  }

  // Leyenda COMPARTIDA (una por grilla). Distingue escala DISCRETA (bandas iguales,
  // tick en su frontera real derivada del colorscale) de CONTINUA (gradiente, tick
  // por valor normalizado). Así no amontona ni desborda las etiquetas.
  function leyendaCarta(d) {
    const ticks = d.tickvals || [];
    const tlabels = d.tick_labels || [];
    const rango = (d.vmax - d.vmin) || 1;
    // máx. 2 decimales en las etiquetas numéricas de la leyenda (respeta etiquetas tipo "≥30").
    const fmt2 = v => { if (v == null) return ""; const s = String(v).trim(); return /^-?\d+(\.\d+)?$/.test(s) ? String(parseFloat(Number(s).toFixed(2))) : s; };
    // Decima las etiquetas para que no se solapen en la barra (más estrecha) por carta:
    // muestra ~6 como máximo, conservando la primera y la última.
    const _paso = ticks.length > 7 ? Math.ceil(ticks.length / 6) : 1;
    const _mostrar = k => k % _paso === 0 || k === ticks.length - 1;
    const cab = `<div class="ct-leyenda-cab"><span class="ct-leyenda-unidad mono">${esc(d.unidad || "")}</span>${d.subtitulo ? `<span class="ct-leyenda-sub mono">${esc(d.subtitulo)}</span>` : ""}</div>`;

    // CATEGÓRICO (alertas): una banda por categoría con la etiqueta CENTRADA en su
    // banda; se OMITE "Sin alerta"/nivel 0 (solo Medio/Alto/Muy alto).
    if (d.categorico) {
      const colores = coloresBanda(d.colorscale);
      let items = colores.map((c, i) => ({ c, et: tlabels[i] }));
      if (d.omitir_cero) items = items.slice(1);   // alertas: omite "Sin alerta" (nivel 0)
      items = items.filter(it => it.et != null && String(it.et) !== "");
      if (!items.length) return "";
      const n = items.length;
      const barra = items.map(it => `<span style="background:${esc(it.c)}"></span>`).join("");
      const tk = items.map((it, i) =>
        `<span class="t" style="left:${((i + 0.5) / n) * 100}%;transform:translateX(-50%)">${esc(it.et)}</span>`).join("");
      return `${cab}<div class="ct-leyenda-barra">${barra}</div><div class="ct-leyenda-ticks">${tk}</div>`;
    }

    // "pasos" o "discreto" → bandas de ancho igual (como la carta formal);
    // si no, campo continuo → gradiente.
    if (!d.discreto && !d.pasos) {
      // CONTINUO: barra de gradiente; etiquetas posicionadas por valor real.
      const stops = (d.colorscale || []).map(([t, c]) => `${esc(c)} ${(t * 100).toFixed(2)}%`).join(", ");
      if (!stops) return "";
      const tk = ticks.map((tv, k) => {
        if (!_mostrar(k)) return "";
        const pos = Math.max(0, Math.min(100, ((tv - d.vmin) / rango) * 100));
        return `<span class="t" style="left:${pos}%">${esc(fmt2(tlabels[k] ?? tv))}</span>`;
      }).join("");
      return `${cab}<div class="ct-leyenda-barra" style="background:linear-gradient(to right, ${stops})"></div>
        <div class="ct-leyenda-ticks">${tk}</div>`;
    }

    // DISCRETO: bandas de ancho igual; el tick va en la FRONTERA de banda más
    // cercana a su valor (derivada del propio colorscale, no de un índice ciego).
    const colores = coloresBanda(d.colorscale);
    const nB = colores.length;
    if (nB < 2) return "";
    const bordes = bordesBanda(d.colorscale);   // nB+1 fracciones en [0,1]
    const idxBorde = frac => {
      let best = 0, bd = Infinity;
      for (let i = 0; i < bordes.length; i++) { const dd = Math.abs(bordes[i] - frac); if (dd < bd) { bd = dd; best = i; } }
      return best;
    };
    const barra = colores.map(c => `<span style="background:${esc(c)}"></span>`).join("");
    const tk = ticks.map((tv, k) => {
      if (!_mostrar(k)) return "";
      const pos = (idxBorde((tv - d.vmin) / rango) / nB) * 100;
      return `<span class="t" style="left:${Math.max(0, Math.min(100, pos))}%">${esc(fmt2(tlabels[k] ?? tv))}</span>`;
    }).join("");
    return `${cab}<div class="ct-leyenda-barra">${barra}</div>
      <div class="ct-leyenda-ticks">${tk}</div>`;
  }

  // Monta los mapas interactivos UNO A UNO, cediendo al navegador entre cada uno:
  // Plotly.newPlot es síncrono (~140ms c/u con zsmooth "fast"), así que renderizar
  // los 4 paneles de golpe congelaba el hilo ~1.6s en cada cambio de
  // variable/período/instante. Secuencial + yield mantiene la UI respondiendo y
  // hace que los paneles aparezcan progresivamente.
  async function montarMapasCarta(cont) {
    if (!cont) return;
    for (const div of [...cont.querySelectorAll(".ct-lienzo[data-datos]")]) {
      if (div._montado) continue;
      div._montado = true;
      await pintarMapaCarta(div, div.dataset.datos);
      await new Promise(r => setTimeout(r));
    }
  }

  // Mapa valor→ETIQUETA para cartas CATEGÓRICAS (alertas/riesgo por nivel): el popup
  // debe decir "Medio/Alto/Muy alto", no "1/2/3". Devuelve una función v→etiqueta o null.
  function etiquetasCarta(d) {
    if (!d || !d.categorico) return null;
    const labs = d.tick_labels, vals = d.tickvals, niv = d.niveles;
    if (!Array.isArray(labs) || !labs.length) return null;
    return v => {
      if (v == null || !isFinite(v)) return null;
      if (Array.isArray(vals) && vals.length === labs.length) {   // banda: etiqueta del tickval más cercano
        let best = 0, bd = Infinity;
        for (let i = 0; i < vals.length; i++) { const dd = Math.abs(vals[i] - v); if (dd < bd) { bd = dd; best = i; } }
        return labs[best];
      }
      const idx = Math.round(v);                                  // índice directo (z = nivel 0/1/2/3)
      if (idx >= 0 && idx < labs.length) return labs[idx];
      if (Array.isArray(niv) && niv.length) {                     // banda por límites
        let b = 0; for (let i = 0; i < niv.length - 1; i++) if (v >= niv[i]) b = i;
        return labs[Math.min(b, labs.length - 1)];
      }
      return labs[Math.min(Math.max(idx, 0), labs.length - 1)];
    };
  }

  async function pintarMapaCarta(div, datosUrl) {
    let d;
    try { d = await App.api(datosUrl); }
    catch (e) { falloLienzo(div, "Sin carta para este instante"); return; }
    if (!div.isConnected) return;
    const P = d.principal || d;
    const hayCuencas = !!(d.cuencas && d.cuencas.ids && d.cuencas.ids.length);
    if ((!P || !P.campo || !P.campo.length) && !hayCuencas) { falloLienzo(div, "Sin datos para este instante"); return; }
    await asegurarGeoCartas();
    if (!window.Plotly) { falloLienzo(div, "Plotly no disponible"); return; }
    if (!div.isConnected) return;

    const ext = P.extension || d.extension || [-81.3, -75.0, -5.1, 1.6];
    const cap = (E && E.capas) || {};
    const oscuro = !!(App.tema && App.tema() === "oscuro");
    const traces = [];
    // FFGS: RELLENO VECTORIAL POR SUBCUENCA. Cada microcuenca se pinta con su valor
    // exacto (d.cuencas), igual que el MAPSERVER oficial — NÍTIDO, sin el pixelado
    // del raster 0.05°. Se agrupan las cuencas por banda de la escala (pocas trazas).
    let cuencasOk = false;
    if (hayCuencas && d.malla) {
      await asegurarMicrocuencas();
      const fills = trazasCuencasFFGS(d);
      if (fills && fills.length) {
        traces.push(...fills); cuencasOk = true;
        const hov = trazaHoverCuencasFFGS(d);   // hover por cuenca: valor exacto al pasar el cursor
        if (hov) traces.push(hov);
      }
    }
    if (!cuencasOk) {
      // Raster: cartas INTERPOLADAS (precip/temp/ALERTAS) con zsmooth:"fast"
      // (bilineal: ~3x más rápido en el render que "best" y visualmente equivalente
      // sobre la malla ya interpolada del backend); las de malla nativa (FFGS sin
      // dato por cuenca) sin suavizar.
      // Continuo (precip/temp/HR/CAPE) Y alertas/heladas (campo YA refinado en backend,
      // escala de color en degradado) → suavizado de ALTA CALIDAD ("best": suave, sin
      // bloques). Solo la malla nativa por cuenca (FFGS) va SIN suavizar (no mezclar
      // celdas por microcuenca).
      const suavizar = d.malla ? false : "best";
      const etiq = etiquetasCarta(d);   // alertas/riesgo → etiqueta de nivel en el popup
      const hov = etiq
        ? { text: P.campo.map(row => (row || []).map(v => etiq(v) || "")),
            hovertemplate: `%{y:.2f}°, %{x:.2f}°<br><b>%{text}</b><extra></extra>` }
        : { hovertemplate: `%{y:.2f}°, %{x:.2f}°<br><b>%{z:.2f} ${esc(d.unidad || "")}</b><extra></extra>` };
      traces.push(Object.assign({
        type: "heatmap", x: P.lon, y: P.lat, z: P.campo,
        colorscale: d.colorscale, zmin: d.vmin, zmax: d.vmax,
        zsmooth: suavizar, hoverongaps: false, showscale: false,
      }, hov));
    }
    // TOGGLE Isolíneas: contornos sobre el campo (aplican a TODAS las cartas raster:
    // pronóstico, calibrado, hidroestimadores, heladas/calor). Traza encima del relleno,
    // sin color (solo líneas) y con etiqueta de valor.
    if (cap.isolineas && P && P.campo && P.campo.length) {
      traces.push({
        type: "contour", x: P.lon, y: P.lat, z: P.campo,
        contours: { coloring: "none", showlabels: true,
          labelfont: { size: 9, color: oscuro ? "#E2E8F7" : "#283550" } },
        line: { color: oscuro ? "rgba(226,232,247,.72)" : "rgba(40,53,80,.7)", width: 0.9, smoothing: 1 },
        ncontours: 12, showscale: false, hoverinfo: "skip",
      });
    }
    // Contorno de las MICROCUENCAS encima (define los bordes de subcuenca, FFGS).
    if (d.malla) {
      await asegurarMicrocuencas();
      const mc = trazaMicrocuencas();
      if (mc) traces.push(mc);
    }
    traces.push(...trazasOutline("x", "y", null, 1.5, 3.4));

    // TOGGLE Estaciones: puntos de las estaciones dentro del recuadro principal.
    if (cap.estaciones) { await asegurarEstaciones(); const te = trazaEstaciones(ext, "x", "y"); if (te) traces.push(te); }

    // Zoom SOLO de acercamiento: minallowed/maxallowed fijan el extent como tope.
    // TOGGLE Grilla: rejilla lat/lon punteada y tenue (ejes ocultos si está apagada).
    const _ejeGr = cap.grilla
      ? { showticklabels: false, showline: false, zeroline: false, ticks: "", showgrid: true,
          gridcolor: oscuro ? "rgba(223,230,247,.13)" : "rgba(70,89,122,.16)", griddash: "dot", dtick: 1 }
      : { visible: false };
    const layout = App.plotlyLayoutBase({
      showlegend: false, margin: { l: 0, r: 0, t: 0, b: 0 },
      xaxis: Object.assign({ range: [ext[0], ext[1]], minallowed: ext[0], maxallowed: ext[1], fixedrange: false }, _ejeGr),
      yaxis: Object.assign({ range: [ext[2], ext[3]], minallowed: ext[2], maxallowed: ext[3], scaleanchor: "x", scaleratio: 1, fixedrange: false }, _ejeGr),
      dragmode: "pan",
    });
    layout.hovermode = "closest";   // hover por cuenca FFGS (y por celda en raster): muestra el valor más cercano

    // TOGGLE Galápagos: inset en la esquina inferior izquierda. Los modelos globales
    // traen d.galapagos (recorte del archipiélago); los regionales no → se omite.
    const _G = d.galapagos, _gb = d.bbox_galapagos;
    if (cap.galapagos && _G && _G.campo && _G.campo.length && _gb) {
      // inset en la ESQUINA INFERIOR DERECHA, separado ~0.5 cm de los márgenes der./inf.
      const gx0 = 0.652, gx1 = 0.952, gy0 = 0.043, gy1 = 0.316;
      layout.xaxis2 = { domain: [gx0, gx1], anchor: "y2", range: [_gb[0], _gb[1]], visible: false, fixedrange: true };
      layout.yaxis2 = { domain: [gy0, gy1], anchor: "x2", range: [_gb[2], _gb[3]], scaleanchor: "x2", scaleratio: 1, visible: false, fixedrange: true };
      // borde del recuadro (rect por encima de todo, siempre visible)
      layout.shapes = (layout.shapes || []).concat([{ type: "rect", xref: "paper", yref: "paper", x0: gx0, y0: gy0, x1: gx1, y1: gy1,
        line: { color: oscuro ? "#B6C0CD" : "#46597A", width: 1.4 }, fillcolor: "rgba(0,0,0,0)", layer: "above" }]);
      layout.annotations = (layout.annotations || []).concat([{ xref: "paper", yref: "paper", x: gx0, y: gy1 + 0.006, xanchor: "left", yanchor: "bottom",
        text: "Galápagos", showarrow: false, font: { size: 9, color: oscuro ? "#9DAABF" : "#58667A" } }]);
      traces.push({ type: "heatmap", x: _G.lon, y: _G.lat, z: _G.campo, xaxis: "x2", yaxis: "y2",
        colorscale: d.colorscale, zmin: d.vmin, zmax: d.vmax, zsmooth: d.malla ? false : "best",
        hoverongaps: false, showscale: false,
        hovertemplate: `%{y:.2f}°, %{x:.2f}°<br><b>%{z:.2f} ${esc(d.unidad || "")}</b><extra></extra>` });
      traces.push(...trazasOutline("x2", "y2", _gb, 0.9, 2));   // contorno de las islas con encasillado
      if (cap.estaciones) { await asegurarEstaciones(); const teg = trazaEstaciones(_gb, "x2", "y2"); if (teg) traces.push(teg); }
    }
    // Panel VACÍO: rótulo claro en vez de un mapa en blanco. "sin_datos" = el modelo
    // no llega a esta fecha (su corrida no la cubre); "sin_alerta" = sí hay pronóstico
    // pero ninguna celda alcanza nivel Medio.
    if (d.vacio) {
      layout.annotations = (layout.annotations || []).concat([{
        xref: "paper", yref: "paper", x: 0.5, y: 0.5, xanchor: "center", yanchor: "middle",
        text: d.vacio === "sin_datos" ? "Sin pronóstico<br>para esta fecha" : "Sin alertas<br>para esta fecha",
        showarrow: false, align: "center", font: { size: 13, color: oscuro ? "#9DAABF" : "#64748b" },
        bgcolor: oscuro ? "rgba(20,28,45,.78)" : "rgba(255,255,255,.82)", borderpad: 8,
        bordercolor: oscuro ? "rgba(182,192,205,.40)" : "rgba(100,116,139,.32)", borderwidth: 1 }]);
    }
    const c = div.querySelector(".cargando"); if (c) c.remove();
    const plot = div.querySelector(".ct-mapa-plot");
    Plotly.newPlot(plot, traces, layout, App.plotlyConfig({ scrollZoom: true, displayModeBar: false, doubleClick: "reset" }));
    // Datos para reconstruir la carta FORMAL al descargar en el VISOR (título + leyenda/
    // colorbar), ya que ahí no hay backend que renderice el PNG formal. En la app se usa
    // el render del servidor. Se guardan en el propio div del plot.
    plot._carta = { titulo: d.titulo, subtitulo: d.subtitulo, unidad: d.unidad,
                    tick_labels: d.tick_labels, tickvals: d.tickvals, vmin: d.vmin, vmax: d.vmax };
    // Zoom con rueda SOLO con Ctrl: sin Ctrl, el evento no llega a Plotly (lo paramos
    // en captura) y la PÁGINA hace scroll normal; con Ctrl, Plotly recibe la rueda y hace zoom.
    plot.addEventListener("wheel", (e) => { if (!e.ctrlKey && !e.metaKey) e.stopPropagation(); },
      { capture: true, passive: true });

    // Leyenda: POR CARTA si la figura tiene su propio hueco (FFGS: cada producto su
    // escala); si no, una COMPARTIDA para toda la grilla (mismo producto × fuentes).
    const carta = div.closest(".ct-carta");
    const leyCard = carta && carta.querySelector('[data-rol="ley-card"]');
    if (leyCard) {
      leyCard.innerHTML = leyendaCarta(d);
    } else {
      const ley = document.querySelector('[data-rol="leyenda-carta"]');
      if (ley && !ley.dataset.built) { ley.dataset.built = "1"; ley.innerHTML = leyendaCarta(d); }
    }
  }

  // Purga las instancias Plotly de cartas (Plotly engancha listeners de window).
  function purgarCartas() {
    if (!window.Plotly) return;
    document.querySelectorAll(".ct-mapa-plot").forEach(el => { try { Plotly.purge(el); } catch (e) { /* ya purgado */ } });
  }

  /* ============================================================
     CABECERA + chips de TIPO
     ============================================================ */
  function chipsTipos() {
    return TIPOS.map(t => {
      const activo = t.id === E.tipo;
      // ⚠ Alertas activo = ROJO (--danger); el resto = navy (--navy-700).
      const color = t.danger ? "var(--danger)" : "var(--navy-700)";
      return `<button class="chip ${activo ? "activo" : ""}" data-tipo="${t.id}"
                style="--chip-activo:${color}">${esc(t.etiqueta)}</button>`;
    }).join("");
  }

  function cabeceraHTML() {
    return `
      <div class="ct-cabecera">
        <div>
          <div class="kicker">Módulos · productos grillados</div>
          <h1>Cartas y Alertas</h1>
          <div class="sub">Cartas interpoladas sobre Ecuador · alertas por consenso con validación de desempeño</div>
        </div>
        <button class="boton oscuro" id="ct-actualizar">⟳ Actualizar</button>
      </div>
      <div class="ct-tipos" id="ct-tipos">${chipsTipos()}</div>
      <div id="ct-cuerpo"></div>`;
  }

  /* ============================================================
     Utilidades del árbol de productos
     ============================================================ */
  const tipoNodo = (id) => (E.productos.tipos || []).find(t => t.id === id) || null;

  // Período seleccionable de un tipo+variable (devuelve nodo período o null).
  function periodoNodo(tipoId, varId, horas) {
    const t = tipoNodo(tipoId);
    if (!t) return null;
    const v = (t.variables || []).find(x => x.id === varId) || (t.variables || [])[0];
    if (!v) return null;
    const p = (v.periodos || []).find(x => x.horas === horas) || (v.periodos || [])[0];
    return p ? { variable: v, periodo: p } : null;
  }

  /* ============================================================
     CUERPO C — TIPOS GRILLADOS (Pronóstico/Calibrado/Hidro/Heladas/FFGS)
     Barra: Variable · Período · navegador. Grilla 2×2 con las primeras
     4 fuentes del período (cada una su carta.png real).
     ============================================================ */
  // Instante por DEFECTO: el que tiene MÁS fuentes (registros) y, entre empates, el más
  // reciente. Antes se usaba el ÚLTIMO instante; cuando un modelo pronostica más lejos que los
  // demás (p.ej. ICON), ese último instante solo trae 1 fuente y los otros paneles arrancan en
  // "Sin dato". Así el primer pintado muestra todas las fuentes disponibles; el usuario navega
  // a horizontes más lejanos con ◀ ▶.
  function instanteDefecto(insts) {
    if (!insts || !insts.length) return 0;
    let best = insts.length - 1, bestN = -1;
    for (let i = 0; i < insts.length; i++) {
      const n = Object.keys(insts[i].registros || {}).length;
      if (n >= bestN) { bestN = n; best = i; }
    }
    return best;
  }

  function gridState(tipoId) {
    const t = tipoNodo(tipoId);
    const g = (E.grid[tipoId] = E.grid[tipoId] || {});
    if (!t || !(t.variables || []).length) return g;
    if (!g.varId || !t.variables.some(v => v.id === g.varId)) g.varId = t.variables[0].id;
    const v = t.variables.find(x => x.id === g.varId);
    if (g.horas == null || !v.periodos.some(p => p.horas === g.horas)) g.horas = v.periodos[0].horas;
    const p = v.periodos.find(x => x.horas === g.horas);
    if (g.inst == null || g.inst >= p.instantes.length) g.inst = instanteDefecto(p.instantes);
    return g;
  }

  // Toggles de capa (Grilla/Galápagos/Estaciones), compartidos por todas las cartas
  // interactivas. El estado vive en E.capas y lo lee pintarMapaCarta.
  function capasHTML() {
    const c = (E && E.capas) || {};
    const b = (id, et) => `<button class="ct-toggle ${c[id] ? "activo" : ""}" data-capa="${id}">${et}</button>`;
    return `<div class="ct-capas">${b("grilla", "Grilla")}${b("isolineas", "Isolíneas")}${b("galapagos", "Galápagos")}${b("estaciones", "Estaciones")}</div>`;
  }

  // Variables de carta que TIENEN observación (para la serie a 24 h): id de carta → variable de serie.
  const _SERIE_OBS = { lluvia: "precip", temperatura_2m_max: "Tmax", temperatura_2m_min: "Tmin" };

  // SERIE TEMPORAL multimodelo BAJO la carta — sigue la variable y la frecuencia ELEGIDAS
  // en la carta (p.ej. CAPE a 6 h = máximo de 6 h). A 24 h, las variables con observación
  // (lluvia/temp) muestran además el observado con etiqueta de valor.
  async function pintarSeriePron(cont, tipoId) {
    const host = cont.querySelector('[data-rol="serie-pron"]');
    if (!host) return;
    const t = tipoNodo(tipoId); if (!t) { host.innerHTML = ""; return; }
    const g = gridState(tipoId);
    const v = (t.variables || []).find(x => x.id === g.varId) || {};
    const etiqV = v.etiqueta || g.varId;
    await asegurarEstaciones();
    const ests = Array.isArray(_estaciones) ? _estaciones : [];
    if (!ests.length) { host.innerHTML = ""; return; }
    const valEst = e => String(e.codigo || e.cod || e.id || "");
    const nomEst = e => String(e.nombre || e.nombre_estacion || e.name || valEst(e));
    if (!E.serieEst || !ests.some(e => valEst(e) === E.serieEst)) E.serieEst = valEst(ests[0]);
    const optEst = ests.map(e => `<option value="${esc(valEst(e))}" ${valEst(e) === E.serieEst ? "selected" : ""}>${esc(nomEst(e))} (${esc(valEst(e))})</option>`).join("");
    host.innerHTML = `
      <div class="ct-serie-cab">
        <h3 style="margin:0;font-size:14px">Serie temporal — ${esc(etiqV)} · ${g.horas} h</h3>
        <label class="bloque"><span class="et">Estación</span><select data-rol="serie-est">${optEst}</select></label>
      </div>
      <div data-rol="serie-plot" style="min-height:340px"></div>
      <p class="ct-nota" data-rol="serie-nota"></p>`;
    const selEst = host.querySelector('[data-rol="serie-est"]');
    selEst.onchange = () => { E.serieEst = selEst.value; cargar(); };

    async function cargar() {
      const cod = E.serieEst;
      const plot = host.querySelector('[data-rol="serie-plot"]'), nota = host.querySelector('[data-rol="serie-nota"]');
      const obsVar = _SERIE_OBS[g.varId];
      const con24obs = (g.horas === 24 && !!obsVar);
      const key = `${tipoId}|${g.varId}|${g.horas}|${cod}|${con24obs ? 1 : 0}`;
      E.serieCache = E.serieCache || {};
      plot.innerHTML = `<p class="suave" style="padding:16px">Cargando serie…</p>`; nota.textContent = "";
      let r = E.serieCache[key];
      if (!r) {
        try {
          r = con24obs
            ? await App.api(`/cartas/series/estacion?codigo=${encodeURIComponent(cod)}&variable=${obsVar}&dias=20&tipo=${encodeURIComponent(tipoId)}`)
            : await App.api(`/cartas/series/grilla?codigo=${encodeURIComponent(cod)}&variable=${encodeURIComponent(g.varId)}&periodo=${g.horas}&tipo=${encodeURIComponent(tipoId)}`);
          E.serieCache[key] = r;
        } catch (e) { plot.innerHTML = `<p class="suave" style="padding:16px;color:var(--danger)">No se pudo cargar la serie.</p>`; return; }
      }
      if (!host.isConnected) return;
      if (!r || r.error || !(r.trazas && r.trazas.length)) {
        plot.innerHTML = `<p class="suave" style="padding:16px">Sin serie para ${esc(etiqV)} a ${g.horas} h en esta estación.</p>`; return;
      }
      plot.innerHTML = ""; if (!window.Plotly) return;
      const esPrecip = (r.es_precip != null) ? r.es_precip : String(g.varId).startsWith("lluvia");
      const layout = App.plotlyLayoutSerie("", {
        barmode: "overlay",
        yaxis: { title: { text: r.unidad || "", font: { size: 11 } }, rangemode: esPrecip ? "tozero" : "normal" },
        xaxis: { type: "date", tickformat: "%d/%m", tickangle: 0, nticks: 12 },
      });
      if (r.hoy) {
        layout.shapes = [{ type: "line", x0: r.hoy, x1: r.hoy, yref: "paper", y0: 0, y1: 1, line: { color: (App.tema && App.tema() === "oscuro") ? "#75859D" : "#95A1B2", width: 1.2, dash: "dot" } }];
        layout.annotations = [{ x: r.hoy, yref: "paper", y: 1, yanchor: "bottom", text: "presente", showarrow: false, font: { family: "IBM Plex Mono", size: 10, color: (App.tema && App.tema() === "oscuro") ? "#9DAABF" : "#5A6678" } }];
      }
      window.Plotly.newPlot(plot, r.trazas, layout, App.plotlyConfig());
      nota.textContent = `Comparativa multimodelo — ${etiqV} a ${g.horas} h.` +
        (con24obs ? " Observado (negro) con etiqueta de valor." : " Sin observación para esta variable/frecuencia.") +
        " Incluye historia reciente + horizonte de pronóstico.";
    }
    cargar();
  }

  function cuerpoGrid(tipoId) {
    const t = tipoNodo(tipoId);
    if (!t || !(t.variables || []).length) {
      return `<div class="vacio"><div class="icono">🗺️</div>
        <strong>Sin productos en disco para este tipo</strong>
        <span>El motor todavía no ha generado cartas de "${esc((TIPOS.find(x=>x.id===tipoId)||{}).etiqueta || tipoId)}".</span></div>`;
    }
    const g = gridState(tipoId);
    const v = t.variables.find(x => x.id === g.varId);
    const p = v.periodos.find(x => x.horas === g.horas);
    const inst = p.instantes[g.inst];

    const optsVar = t.variables.map(x =>
      `<option value="${esc(x.id)}" ${x.id === g.varId ? "selected" : ""}>${esc(x.etiqueta)}</option>`).join("");
    const optsPer = v.periodos.map(x =>
      `<option value="${x.horas}" ${x.horas === g.horas ? "selected" : ""}>${esc(x.etiqueta)}</option>`).join("");
    const optsInst = p.instantes.map((x, i) =>
      `<option value="${i}" ${i === g.inst ? "selected" : ""}>${esc(x.etiqueta)}</option>`).join("");

    // Grilla 2×2: hasta 4 fuentes del período (cada una con su capa/archivo).
    const cartas = (p.fuentes || []).slice(0, 4).map(f => {
      const record = inst.registros ? inst.registros[f.fuente] : undefined;
      const archivo = (inst.archivos && inst.archivos[f.fuente]) || f.archivo;
      if (record === undefined) {
        return `<figure class="ct-carta"><div class="ct-carta-cab"><span class="titulo">${esc(f.fuente)}</span>
          <span class="meta">${esc(p.figcap || "")}</span></div>
          <div class="ct-lienzo"><div class="fallo"><div class="icono">🗺️</div>Sin dato en este instante</div></div></figure>`;
      }
      const params = { archivo, capa: f.capa, record,
        corrido: f.corrido || p.corrido ? 1 : 0, fin: inst.fin };
      return `<figure class="ct-carta">
        <div class="ct-carta-cab"><span class="titulo">${esc(f.fuente)}</span>
          <span class="meta">${esc(p.figcap || "")}</span></div>
        ${lienzoCarta(params, f.fuente + " · " + (p.figcap || ""))}
        <div class="ct-ley-card" data-rol="ley-card"></div>
      </figure>`;
    }).join("");

    return `
      <div class="ct-barra cols compacta">
        <label class="bloque"><span class="et">Variable</span>
          <select data-rol="var">${optsVar}</select></label>
        <label class="bloque"><span class="et">Período</span>
          <select data-rol="per">${optsPer}</select></label>
        <div class="ct-inst-nav">
          <button class="ct-nav" data-rol="prev" ${g.inst <= 0 ? "disabled" : ""}>◀</button>
          <select class="ct-instante" data-rol="inst">${optsInst}</select>
          <button class="ct-nav" data-rol="next" ${g.inst >= p.instantes.length - 1 ? "disabled" : ""}>▶</button>
        </div>
        ${capasHTML()}
      </div>
      <div class="ct-grid">${cartas}</div>
      <div class="ct-serie-pron" data-rol="serie-pron"></div>`;
  }

  function conectarGrid(cont, tipoId) {
    const g = gridState(tipoId);
    const t = tipoNodo(tipoId);
    if (!t || !(t.variables || []).length) return;
    const v = t.variables.find(x => x.id === g.varId);
    const p = v.periodos.find(x => x.horas === g.horas);
    const re = () => pintarCuerpo();
    cont.querySelector('[data-rol="var"]').onchange = (e) => { g.varId = e.target.value; g.horas = null; g.inst = null; re(); };
    cont.querySelector('[data-rol="per"]').onchange = (e) => { g.horas = +e.target.value; g.inst = null; re(); };
    cont.querySelector('[data-rol="inst"]').onchange = (e) => { g.inst = +e.target.value; re(); };
    cont.querySelector('[data-rol="prev"]').onclick = () => { if (g.inst > 0) { g.inst--; re(); } };
    cont.querySelector('[data-rol="next"]').onclick = () => { if (g.inst < p.instantes.length - 1) { g.inst++; re(); } };
    cont.querySelectorAll('.ct-toggle[data-capa]').forEach(b => b.onclick = () => { E.capas[b.dataset.capa] = !E.capas[b.dataset.capa]; re(); });
    pintarSeriePron(cont, tipoId);
  }

  /* ============================================================
     CUERPO C-FFGS — TODOS los productos del PASO HORARIO elegido
     A diferencia del grid normal (una variable × fuentes), FFGS muestra TODAS
     las cartas disponibles para el período+instante elegido (cada producto su
     carta y su leyenda). Selector: Período + Instante (sin Variable).
     ============================================================ */
  function ffgsPeriodos(t) {
    const s = new Set();
    (t.variables || []).forEach(v => (v.periodos || []).forEach(p => s.add(p.horas)));
    return [...s].sort((a, b) => a - b);
  }
  function ffgsState() {
    const t = tipoNodo("ffgs");
    const g = (E.grid.ffgs = E.grid.ffgs || {});
    if (!t || !(t.variables || []).length) return g;
    const pers = ffgsPeriodos(t);
    if (g.horas == null || !pers.includes(g.horas)) g.horas = pers.includes(6) ? 6 : pers[0];
    const rep = t.variables.find(v => v.periodos.some(p => p.horas === g.horas));
    const pr = rep && rep.periodos.find(p => p.horas === g.horas);
    const nInst = pr ? pr.instantes.length : 0;
    if (g.inst == null || g.inst >= nInst) g.inst = pr ? instanteDefecto(pr.instantes) : nInst - 1;
    if (g.inst < 0) g.inst = 0;
    return g;
  }
  function cuerpoGridFFGS() {
    const t = tipoNodo("ffgs");
    if (!t || !(t.variables || []).length) {
      return `<div class="vacio"><div class="icono">🗺️</div>
        <strong>Sin productos FFGS en disco</strong>
        <span>El motor todavía no ha generado cartas FFGS.</span></div>`;
    }
    const g = ffgsState();
    const pers = ffgsPeriodos(t);
    const prods = t.variables.filter(v => v.periodos.some(p => p.horas === g.horas));
    const rep = prods[0];
    const pr = rep.periodos.find(p => p.horas === g.horas);
    const optsPer = pers.map(h =>
      `<option value="${h}" ${h === g.horas ? "selected" : ""}>${String(h).padStart(2, "0")} h</option>`).join("");
    const optsInst = pr.instantes.map((x, i) =>
      `<option value="${i}" ${i === g.inst ? "selected" : ""}>${esc(x.etiqueta)}</option>`).join("");
    const cartas = prods.map(v => {
      const p = v.periodos.find(pp => pp.horas === g.horas);
      const it = p.instantes[Math.min(g.inst, p.instantes.length - 1)];
      const f = (p.fuentes || [])[0] || {};
      const record = it && it.registros ? it.registros[f.fuente] : undefined;
      const archivo = (it && it.archivos && it.archivos[f.fuente]) || f.archivo;
      const partes = (v.etiqueta || "").split(" — ");
      const sigla = partes[0] || v.id;
      const desc = partes[1] || "";
      if (!it || record === undefined || archivo == null) {
        return `<figure class="ct-carta"><div class="ct-carta-cab"><span class="titulo">${esc(sigla)}</span>
          <span class="meta">${esc(p.figcap || "")}</span></div>
          <div class="ct-lienzo"><div class="fallo"><div class="icono">🗺️</div>Sin dato</div></div></figure>`;
      }
      const params = { archivo, capa: f.capa, record };
      return `<figure class="ct-carta">
        <div class="ct-carta-cab"><span class="titulo">${esc(sigla)}</span>
          <span class="meta" title="${esc(desc)}">${esc(desc)}</span></div>
        ${lienzoCarta(params, sigla + (desc ? " · " + desc : ""))}
        <div class="ct-ley-card" data-rol="ley-card"></div>
      </figure>`;
    }).join("");
    return `
      <div class="ct-barra cols compacta">
        <label class="bloque"><span class="et">Período</span>
          <select data-rol="fper">${optsPer}</select></label>
        <div class="ct-inst-nav">
          <button class="ct-nav" data-rol="fprev" ${g.inst <= 0 ? "disabled" : ""}>◀</button>
          <select class="ct-instante" data-rol="finst">${optsInst}</select>
          <button class="ct-nav" data-rol="fnext" ${g.inst >= pr.instantes.length - 1 ? "disabled" : ""}>▶</button>
        </div>
        ${capasHTML()}
      </div>
      <div class="ct-grid cuencas">${cartas}</div>`;
  }
  function conectarGridFFGS(cont) {
    const g = ffgsState();
    const t = tipoNodo("ffgs");
    if (!t || !(t.variables || []).length) return;
    const rep = t.variables.find(v => v.periodos.some(p => p.horas === g.horas));
    const pr = rep && rep.periodos.find(p => p.horas === g.horas);
    const nInst = pr ? pr.instantes.length : 0;
    const re = () => pintarCuerpo();
    const q = s => cont.querySelector(s);
    if (q('[data-rol="fper"]')) q('[data-rol="fper"]').onchange = e => { g.horas = +e.target.value; g.inst = null; re(); };
    if (q('[data-rol="finst"]')) q('[data-rol="finst"]').onchange = e => { g.inst = +e.target.value; re(); };
    if (q('[data-rol="fprev"]')) q('[data-rol="fprev"]').onclick = () => { if (g.inst > 0) { g.inst--; re(); } };
    if (q('[data-rol="fnext"]')) q('[data-rol="fnext"]').onclick = () => { if (g.inst < nInst - 1) { g.inst++; re(); } };
    cont.querySelectorAll('.ct-toggle[data-capa]').forEach(b => b.onclick = () => { E.capas[b.dataset.capa] = !E.capas[b.dataset.capa]; re(); });
  }

  /* ============================================================
     CUERPO HELADAS/CALOR — TODAS las variables × fuentes por fecha
     (sin selector de variable; selector de Período + Instante, como FFGS).
     ============================================================ */
  function heladasPeriodos(t) {
    const s = new Set();
    (t.variables || []).forEach(v => (v.periodos || []).forEach(p => s.add(p.horas)));
    return [...s].sort((a, b) => a - b);
  }
  function heladasState() {
    const t = tipoNodo("heladas");
    const g = (E.grid.heladas = E.grid.heladas || {});
    if (!t || !(t.variables || []).length) return g;
    const pers = heladasPeriodos(t);
    if (g.horas == null || !pers.includes(g.horas)) g.horas = pers[0];
    const rep = t.variables.find(v => v.periodos.some(p => p.horas === g.horas));
    const pr = rep && rep.periodos.find(p => p.horas === g.horas);
    const nInst = pr ? pr.instantes.length : 0;
    if (g.inst == null || g.inst >= nInst) g.inst = pr ? instanteDefecto(pr.instantes) : 0;
    if (g.inst < 0) g.inst = 0;
    return g;
  }
  function cuerpoGridHeladas() {
    const t = tipoNodo("heladas");
    if (!t || !(t.variables || []).length) {
      return `<div class="vacio"><div class="icono">🗺️</div>
        <strong>Sin productos de heladas/calor en disco</strong>
        <span>El motor todavía no ha generado estas cartas.</span></div>`;
    }
    const g = heladasState();
    const pers = heladasPeriodos(t);
    const vars = t.variables.filter(v => v.periodos.some(p => p.horas === g.horas));
    const rep = vars[0];
    const pr = rep.periodos.find(p => p.horas === g.horas);
    const optsPer = pers.map(h =>
      `<option value="${h}" ${h === g.horas ? "selected" : ""}>${String(h).padStart(2, "0")} h</option>`).join("");
    const optsInst = pr.instantes.map((x, i) =>
      `<option value="${i}" ${i === g.inst ? "selected" : ""}>${esc(x.etiqueta)}</option>`).join("");
    const cartas = vars.flatMap(v => {
      const p = v.periodos.find(pp => pp.horas === g.horas);
      const it = p.instantes[Math.min(g.inst, p.instantes.length - 1)];
      return (p.fuentes || []).slice(0, 4).map(f => {
        const record = it && it.registros ? it.registros[f.fuente] : undefined;
        const archivo = (it && it.archivos && it.archivos[f.fuente]) || f.archivo;
        if (!it || record === undefined || archivo == null) {
          return `<figure class="ct-carta"><div class="ct-carta-cab"><span class="titulo">${esc(f.fuente)}</span>
            <span class="meta">${esc(v.etiqueta)}</span></div>
            <div class="ct-lienzo"><div class="fallo"><div class="icono">🗺️</div>Sin dato</div></div></figure>`;
        }
        const params = { archivo, capa: f.capa, record, corrido: f.corrido || p.corrido ? 1 : 0, fin: it.fin };
        return `<figure class="ct-carta">
          <div class="ct-carta-cab"><span class="titulo">${esc(f.fuente)}</span>
            <span class="meta" title="${esc(v.etiqueta)}">${esc(v.etiqueta)}</span></div>
          ${lienzoCarta(params, f.fuente + " · " + (v.etiqueta || ""))}
          <div class="ct-ley-card" data-rol="ley-card"></div>
        </figure>`;
      });
    }).join("");
    return `
      <div class="ct-barra cols compacta">
        <label class="bloque"><span class="et">Período</span>
          <select data-rol="hper">${optsPer}</select></label>
        <div class="ct-inst-nav">
          <button class="ct-nav" data-rol="hprev" ${g.inst <= 0 ? "disabled" : ""}>◀</button>
          <select class="ct-instante" data-rol="hinst">${optsInst}</select>
          <button class="ct-nav" data-rol="hnext" ${g.inst >= pr.instantes.length - 1 ? "disabled" : ""}>▶</button>
        </div>
        ${capasHTML()}
      </div>
      <div class="ct-grid cuencas">${cartas}</div>`;
  }
  function conectarGridHeladas(cont) {
    const g = heladasState();
    const t = tipoNodo("heladas");
    if (!t || !(t.variables || []).length) return;
    const rep = t.variables.find(v => v.periodos.some(p => p.horas === g.horas));
    const pr = rep && rep.periodos.find(p => p.horas === g.horas);
    const nInst = pr ? pr.instantes.length : 0;
    const re = () => pintarCuerpo();
    const q = s => cont.querySelector(s);
    if (q('[data-rol="hper"]')) q('[data-rol="hper"]').onchange = e => { g.horas = +e.target.value; g.inst = null; re(); };
    if (q('[data-rol="hinst"]')) q('[data-rol="hinst"]').onchange = e => { g.inst = +e.target.value; re(); };
    if (q('[data-rol="hprev"]')) q('[data-rol="hprev"]').onclick = () => { if (g.inst > 0) { g.inst--; re(); } };
    if (q('[data-rol="hnext"]')) q('[data-rol="hnext"]').onclick = () => { if (g.inst < nInst - 1) { g.inst++; re(); } };
    cont.querySelectorAll('.ct-toggle[data-capa]').forEach(b => b.onclick = () => { E.capas[b.dataset.capa] = !E.capas[b.dataset.capa]; re(); });
  }

  /* ============================================================
     CUERPO A — ALERTAS
     ============================================================ */
  function alertaState() {
    const a = E.alerta;
    const t = tipoNodo("alertas");
    if (t && t.variables.length) {
      if (!a.varId || !t.variables.some(v => v.id === a.varId)) a.varId = t.variables[0].id;
      const v = t.variables.find(x => x.id === a.varId);
      const p = (v.periodos || [])[0];
      if (p && (a.inst == null || a.inst >= p.instantes.length)) a.inst = instanteDefecto(p.instantes);
    }
    return a;
  }

  function cuerpoAlertas() {
    const a = alertaState();
    const t = tipoNodo("alertas");
    const tieneArbol = t && t.variables.length;
    const v = tieneArbol ? t.variables.find(x => x.id === a.varId) : null;
    const p = v ? v.periodos[0] : null;
    const inst = p ? p.instantes[a.inst] : null;

    const optsVar = VAR_ALERTA.map(x =>
      `<option value="${esc(x.id)}" ${x.id === a.varId ? "selected" : ""}>${esc(x.etiqueta)}</option>`).join("");

    const optsInst = p ? p.instantes.map((x, i) =>
      `<option value="${i}" ${i === a.inst ? "selected" : ""}>${esc(x.etiqueta)}</option>`).join("")
      : `<option>Sin instantes</option>`;

    const segFijos = `<button class="${a.modo === "fija" ? "activo" : ""}" data-modo="fija">Fijos</button>`;
    const segZph = `<button class="${a.modo === "zph" ? "activo" : ""}" data-modo="zph">ZPH</button>`;

    // Grilla: una carta por fuente PRESENTE (Consenso + pronóstico + CALIBRADOS),
    // ordenada según ALERTA_FUENTES; oculta las capas meta (Confianza/Referencia).
    const _fdisp = p ? (p.fuentes || []).map(f => f.fuente).filter(s => !ALERTA_FUENTE_OCULTA.has(s)) : [];
    let _lista = ALERTA_FUENTES.filter(s => _fdisp.includes(s)).concat(_fdisp.filter(s => !ALERTA_FUENTES.includes(s)));
    if (!_lista.length) _lista = ALERTA_FUENTES.slice(0, 4);
    const cartas = _lista.map(fuente => {
      const rotulo = ALERTA_FUENTE_ROTULO[fuente] || fuente;
      // localizar la fuente real dentro del período (los nombres del árbol son
      // CONSENSO/GFS/ICON/IFS, "IFS" se rotula "IFS HRES").
      let f = null, record;
      if (p) {
        f = (p.fuentes || []).find(x => x.fuente === fuente)
          || (p.fuentes || []).find(x => x.fuente.toUpperCase() === fuente);
        if (f && inst && inst.registros) record = inst.registros[f.fuente];
      }
      const meta = `Riesgo 24 h${inst ? " · " + esc(inst.rango || inst.etiqueta) : ""}`;
      if (!f || record === undefined) {
        return `<figure class="ct-carta">
          <div class="ct-carta-cab"><span class="titulo">${esc(rotulo)}</span><span class="meta">${meta}</span></div>
          <div class="ct-lienzo"><div class="fallo"><div class="icono">⚠️</div>Sin alerta para ${esc(rotulo)}</div></div></figure>`;
      }
      const archivo = (inst.archivos && inst.archivos[f.fuente]) || f.archivo;
      const params = { archivo, capa: f.capa, record };
      return `<figure class="ct-carta">
        <div class="ct-carta-cab"><span class="titulo">${esc(rotulo)}</span><span class="meta">${meta}</span></div>
        ${lienzoCarta(params, "Alerta " + rotulo)}
        <div class="ct-ley-card" data-rol="ley-card"></div>
      </figure>`;
    }).join("");

    const sinArbol = tieneArbol ? "" :
      `<div class="vacio" style="padding:24px"><span class="suave">No hay alertas vigentes en disco; el panel de desempeño usa la validación histórica del programa.</span></div>`;

    return `
      <div class="ct-barra compacta">
        <label><span class="et">Variable</span><select data-rol="avar">${optsVar}</select></label>
        <span class="ct-div"></span>
        <span class="et" title="Umbrales fijos regionales o por Zonas de Pronóstico Homogéneo">Umbrales</span>
        <div class="segmentado" data-rol="umbral" style="--seg-color:var(--blue)">${segFijos}${segZph}</div>
        <button class="boton azulclaro chico" data-rol="editar">✎ Editar umbrales</button>
        <div class="ct-inst-nav">
          <button class="ct-nav" data-rol="aprev" ${a.inst <= 0 ? "disabled" : ""}>◀</button>
          <select class="ct-instante" data-rol="ainst">${optsInst}</select>
          <button class="ct-nav" data-rol="anext" ${(!p || a.inst >= p.instantes.length - 1) ? "disabled" : ""}>▶</button>
        </div>
        ${capasHTML()}
      </div>
      ${sinArbol}
      <div class="ct-grid">${cartas}</div>
      <div class="ct-panel" id="ct-desempeno">
        <div class="ct-panel-cab">
          <h3>Validación de desempeño <span class="suave" data-rol="dsub">· cargando…</span></h3>
        </div>
        <div class="ct-puntaje-headline" data-rol="puntaje-headline"></div>
        <div class="ct-desenlaces" data-rol="desenlaces">
          ${DESENLACES.map(d => `<div class="ct-des ${d.tono}"><div class="pct mono">—</div>
            <div class="et">${esc(d.etiqueta)}<br><span>—</span></div></div>`).join("")}
        </div>
        <div class="ct-ranking-modelos" data-rol="ranking-modelos"></div>
        <div class="ct-serie" data-rol="serie"></div>
        <p class="ct-nota" data-rol="dnota">Las alertas se construyen por <b>consenso de modelos</b> y traen su desempeño documentado contra lo observado (ventana 24 h, 7-7).</p>
      </div>
      ${htmlRiesgoFFR()}`;
  }

  // Parámetros de los 7 toggles para carta.png (1/0 cada uno).
  function optsParams(opts) {
    const o = {};
    for (const tg of TOGGLES) o[tg.id] = opts[tg.id] ? 1 : 0;
    return o;
  }

  function conectarAlertas(cont) {
    const a = E.alerta;
    const re = () => pintarCuerpo();
    // No llamamos cargarDesempeno() aquí: re()→pintarCuerpo()→conectarAlertas ya
    // lo invoca (línea final). Sólo encadenamos cargarFechas() (otro endpoint).
    cont.querySelector('[data-rol="avar"]').onchange = (e) => { a.varId = e.target.value; a.inst = null; re(); cargarFechas(); };
    cont.querySelectorAll('[data-rol="umbral"] button').forEach(b =>
      b.onclick = async () => {
        a.modo = b.dataset.modo;
        // Cambiar de modo COPIA la variante pre-calculada sobre alertas_diarias.nc; sin
        // esto el toggle no cambiaba el archivo y fija/zph se veían idénticos. En el visor
        // (solo lectura) se omite el POST: re() re-lee los productos ya congelados.
        if (!window.HIDROMET_VISOR) {
          try { await App.api("/cartas/umbrales_modo", { method: "POST", body: { modo: a.modo } }); }
          catch (e) { App.aviso(e.message, "error"); }
        }
        re(); cargarFechas();
      });
    cont.querySelector('[data-rol="editar"]').onclick = abrirEditorUmbrales;

    const t = tipoNodo("alertas");
    const v = t && t.variables.length ? t.variables.find(x => x.id === a.varId) : null;
    const p = v ? v.periodos[0] : null;
    cont.querySelector('[data-rol="ainst"]').onchange = (e) => { a.inst = +e.target.value; re(); };
    cont.querySelector('[data-rol="aprev"]').onclick = () => { if (a.inst > 0) { a.inst--; re(); } };
    cont.querySelector('[data-rol="anext"]').onclick = () => { if (p && a.inst < p.instantes.length - 1) { a.inst++; re(); } };
    cont.querySelectorAll('.ct-toggle[data-capa]').forEach(b => b.onclick = () => { E.capas[b.dataset.capa] = !E.capas[b.dataset.capa]; re(); });

    cargarDesempeno();
    conectarRiesgoFFR(cont);
  }

  // Validación de desempeño real del programa (5 desenlaces de consenso).
  async function cargarDesempeno() {
    const panel = document.getElementById("ct-desempeno");
    if (!panel) return;
    const a = E.alerta;
    const varVal = (VAR_ALERTA.find(x => x.id === a.varId) || VAR_ALERTA[0]).val;
    // El desempeño SÓLO depende de variable+modo (no del instante ni de los
    // toggles). Cacheamos la respuesta por esa clave: cada toggle/navegación de
    // instante re-pinta el panel desde caché sin repetir la petición de red. La
    // caché se invalida tras una actualización (recargar() la limpia).
    const clave = varVal + "|" + a.modo;
    try {
      let r = (a._desClave === clave) ? a._desDatos : null;
      if (!r) {
        r = await App.api("/cartas/alertas_programa?" + qs({ variable: varVal, modo: a.modo }));
        a._desClave = clave; a._desDatos = r;
      }
      if (!document.getElementById("ct-desempeno")) return;
      const porClave = {};
      (r.lecturas || []).forEach(l => { porClave[l.clave] = l; });
      const cont = panel.querySelector('[data-rol="desenlaces"]');
      cont.innerHTML = DESENLACES.map(d => {
        const l = porClave[d.clave] || {};
        const pct = l.pct == null ? "—" : `${fmtPct(l.pct)}<small> %</small>`;
        const n = l.n == null ? "—" : `${fmtNum(l.n)} ${d.nota}`;
        return `<div class="ct-des ${d.tono}"><div class="pct mono">${pct}</div>
          <div class="et">${esc(d.etiqueta)}<br><span>${esc(n)}</span></div></div>`;
      }).join("");
      // Tabla de DESEMPEÑO POR MODELO: puntaje graduado + habilidad (CSI/POD/HSS).
      // Mayor CSI = mejor (balancea fallos y falsas alarmas). Intensidad = estación.
      const rk = panel.querySelector('[data-rol="ranking-modelos"]');
      const filas = (r.filas || []).filter(f => f.tot);
      if (rk && filas.length) {
        let mejor = 0;
        filas.forEach((f, i) => { if ((f.tot.CSI ?? -1) > (filas[mejor].tot.CSI ?? -1)) mejor = i; });
        const fmt = (v, d = 2) => (v == null ? "—" : (+v).toFixed(d));
        rk.innerHTML = `
          <div class="rm-tit mono">Desempeño por modelo · habilidad de alerta (mayor CSI = mejor)</div>
          <table class="rm-tabla"><thead><tr>
            <th>Modelo</th><th>Puntaje</th><th>CSI</th><th>POD</th><th>HSS</th><th>n</th>
          </tr></thead><tbody>${filas.map((f, i) => {
            const t = f.tot;
            return `<tr${i === mejor ? ' class="rm-best"' : ""}><td>${esc(f.fuente)}${i === mejor ? " ★" : ""}</td>
              <td class="mono">${t.puntaje_pct == null ? "—" : fmtPct(t.puntaje_pct) + "%"}</td>
              <td class="mono">${fmt(t.CSI)}</td><td class="mono">${fmt(t.POD)}</td>
              <td class="mono">${fmt(t.HSS)}</td><td class="mono suave">${fmtNum(t.n_eval || 0)}</td></tr>`;
          }).join("")}</tbody></table>
          <div class="rm-pie mono">Mayor CSI = mejor (balancea fallos y falsas alarmas). POD = detección de eventos · HSS = habilidad frente al azar · Puntaje = calificación graduada.</div>`;
      } else if (rk) { rk.innerHTML = ""; }
      // §serie: GRÁFICO TEMPORAL de habilidad (CSI) por modelo — ver cuál va mejor en el tiempo.
      const sdiv = panel.querySelector('[data-rol="serie"]');
      const serie = (r.serie || []).filter(s => (s.puntos || []).some(p => p.CSI != null));
      if (sdiv && serie.length && window.Plotly) {
        const oscuro = !!(App.tema && App.tema() === "oscuro");
        const COL = { CONSENSO: "#e45756", GFS: "#4c78a8", ICON: "#f58518", IFS: "#54a24b",
                      BIAS: "#b279a2", RF: "#9d755d", GB: "#72b7b2", CAT: "#eeca3b", LSTM: "#bab0ac" };
        const trazas = serie.map(s => ({
          type: "scatter", mode: "lines+markers", name: ALERTA_FUENTE_ROTULO[s.fuente] || s.fuente,
          x: s.puntos.map(p => p.fecha), y: s.puntos.map(p => p.CSI), connectgaps: true, marker: { size: 4 },
          line: { width: s.fuente === "CONSENSO" ? 3 : 1.4, color: COL[s.fuente] || "#888" },
          hovertemplate: `%{x} · CSI %{y:.2f}<extra>${esc(ALERTA_FUENTE_ROTULO[s.fuente] || s.fuente)}</extra>`,
        }));
        const tinta = oscuro ? "#9DAABF" : "#58667A", rejilla = oscuro ? "rgba(223,230,247,.10)" : "rgba(70,89,122,.12)";
        Plotly.react(sdiv, trazas, {
          height: 250, margin: { l: 38, r: 12, t: 28, b: 42 }, paper_bgcolor: "rgba(0,0,0,0)", plot_bgcolor: "rgba(0,0,0,0)",
          title: { text: "Habilidad (CSI) por fecha — mayor es mejor", font: { size: 12, color: tinta } },
          showlegend: true, legend: { orientation: "h", y: -0.22, font: { size: 10, color: tinta } },
          xaxis: { type: "category", nticks: 8, tickfont: { size: 9, color: tinta }, showgrid: false },
          yaxis: { range: [0, 1], tickfont: { size: 9, color: tinta }, gridcolor: rejilla, zeroline: false },
          font: { color: tinta },
        }, { displayModeBar: false, responsive: true });
      } else if (sdiv) { sdiv.innerHTML = ""; }
      const ph = panel.querySelector('[data-rol="puntaje-headline"]');
      if (ph) ph.innerHTML = (r.puntaje_global == null) ? "" :
        `<div class="pg-num mono">${fmtPct(r.puntaje_global)}<small>%</small></div>
         <div class="pg-txt"><b>Puntaje global del consenso</b> — calificación graduada, el resumen real del desempeño.
         Los desenlaces de abajo se miden sobre <b>${fmtNum(r.activos || 0)} casos con evento o alerta</b>; aparte,
         <b>${fmtNum(r.correcto_sin_alerta_n || 0)}</b> días sin evento se resolvieron correctamente sin alerta.</div>`;
      const varEt = (VAR_ALERTA.find(x => x.id === a.varId) || VAR_ALERTA[0]).etiqueta.toLowerCase();
      const fuente = r.fuente_lecturas || "consenso";
      panel.querySelector('[data-rol="dsub"]').textContent =
        `· ${varEt} · ${fuente} · ${fmtNum(r.n_eval || 0)} evaluaciones (estación × día)`;
      // Nota canónica del MÉTODO (una sola vez; la base 'casos activos' va en el titular).
      panel.querySelector('[data-rol="dnota"]').innerHTML =
        `<b>Acierto exacto</b> = el nivel emitido coincide justo con el observado (estricto); el <b>Puntaje</b> da crédito parcial ` +
        `(pasarse penaliza menos que quedarse corto). Intensidad por <b>estación</b>, área por <b>hidroestimador</b>; ventana 24 h (7-7).`;
    } catch (e) {
      const sub = panel.querySelector('[data-rol="dsub"]');
      if (sub) sub.textContent = "· sin datos de validación";
    }
  }

  // Refresca los instantes de Alertas con SOLO las fechas que emitieron alerta.
  async function cargarFechas() {
    const a = E.alerta;
    const varVal = (VAR_ALERTA.find(x => x.id === a.varId) || VAR_ALERTA[0]).val;
    try {
      const r = await App.api("/cartas/alertas_programa/fechas?" + qs({ variable: varVal, modo: a.modo }));
      a.fechasEmitidas = r.fechas || [];
    } catch (e) { /* el navegador sigue usando los instantes del árbol */ }
  }

  /* ============================================================
     Editor de umbrales (modal) — GET/POST /cartas/umbrales_fijos
     ============================================================ */
  async function abrirEditorUmbrales() {
    let data;
    try { data = await App.api("/cartas/umbrales_fijos"); }
    catch (e) { return App.aviso("No se pudo cargar el editor: " + e.message, "error"); }

    const fondo = document.createElement("div");
    fondo.className = "modal-fondo";
    const secciones = Object.entries(data.variables).map(([varId, meta]) => {
      const filas = data.regiones.map(reg => {
        const t = ((data.vigentes_editados || data.vigentes)[varId] || {})[reg] || [0, 0, 0];
        const inputs = data.niveles.map((nv, i) =>
          `<td><input type="number" step="0.1" data-var="${esc(varId)}" data-region="${esc(reg)}"
             data-i="${i}" value="${esc(t[i])}"></td>`).join("");
        return `<tr><td><b>${esc(reg)}</b></td>${inputs}</tr>`;
      }).join("");
      return `<h3 style="margin:14px 0 4px;font-size:14px">${esc(meta.etiqueta)}</h3>
        <div class="ct-umbrales-regla">${esc(meta.regla)}</div>
        <div class="tabla-caja"><table class="ct-umbrales-tabla">
          <thead><tr><th>Región</th>${data.niveles.map(n => `<th>${esc(n)}</th>`).join("")}</tr></thead>
          <tbody>${filas}</tbody></table></div>`;
    }).join("");

    fondo.innerHTML = `<div class="modal">
      <header><span>Editar umbrales de alerta (Fijos)${data.hay_edicion ? " · previsualizando" : ""}</span>
        <button class="boton chico" data-rol="cerrar">Cerrar</button></header>
      <div class="cuerpo">
        <div class="suave" style="font-size:12.5px;margin-bottom:6px">Umbrales regionales que disparan cada nivel.
          <b>Previsualizar</b> reclasifica las alertas en el visor sin tocar las guardadas;
          <b>Aplicar y regenerar</b> sí reescribe las alertas guardadas (acción explícita).</div>
        ${secciones}
        <div class="fila separada" style="margin-top:18px;gap:8px;flex-wrap:wrap">
          <button class="boton" data-rol="restaurar">↺ Restaurar preestablecidos</button>
          <button class="boton" data-rol="descargar">⤓ Descargar con estos umbrales</button>
          <button class="boton" data-rol="aplicar">⟳ Aplicar y regenerar</button>
          <button class="boton primario" data-rol="guardar">👁 Previsualizar</button>
        </div>
      </div></div>`;
    document.body.appendChild(fondo);
    const cerrar = () => fondo.remove();
    fondo.querySelector('[data-rol="cerrar"]').onclick = cerrar;
    fondo.onclick = (e) => { if (e.target === fondo) cerrar(); };

    const recolectar = () => {
      const valores = {};
      fondo.querySelectorAll("input[data-var]").forEach(inp => {
        const v = inp.dataset.var, r = inp.dataset.region, i = +inp.dataset.i;
        (valores[v] = valores[v] || {});
        (valores[v][r] = valores[v][r] || [0, 0, 0])[i] = parseFloat(inp.value);
      });
      return valores;
    };
    const guardarEditados = () => App.api("/cartas/umbrales_fijos", { method: "POST", body: { valores: recolectar() } });

    // PREVISUALIZAR: guarda los editados (NO toca el netcdf) y re-renderiza el visor;
    // las alertas se reclasifican en vivo con estos umbrales.
    fondo.querySelector('[data-rol="guardar"]').onclick = async () => {
      try {
        await guardarEditados(); cerrar(); recargar();
        App.aviso("Previsualizando alertas con los umbrales editados (las guardadas no se tocaron).", "ok");
      } catch (e) { App.aviso(e.message, "error"); }
    };
    // RESTAURAR: descarta los editados → vuelve a mostrar las alertas guardadas.
    fondo.querySelector('[data-rol="restaurar"]').onclick = async () => {
      try {
        await App.api("/cartas/umbrales_fijos", { method: "POST", body: { restaurar: true } });
        cerrar(); recargar();
        App.aviso("Umbrales editados descartados; se muestran las alertas guardadas.", "info");
      } catch (e) { App.aviso(e.message, "error"); }
    };
    // DESCARGAR: guarda los editados y baja las alertas reclasificadas con ellos (sin netcdf).
    fondo.querySelector('[data-rol="descargar"]').onclick = async () => {
      try {
        await guardarEditados();
        window.location.href = "/api/cartas/umbrales_fijos/descarga?variable=lluvia";
        App.aviso("Descargando alertas (consenso) con los umbrales editados…", "info");
      } catch (e) { App.aviso(e.message, "error"); }
    };
    // APLICAR Y REGENERAR: acción EXPLÍCITA — reescribe las alertas guardadas (netcdf).
    fondo.querySelector('[data-rol="aplicar"]').onclick = async () => {
      if (!confirm("Esto REESCRIBE las alertas guardadas (netcdf) con los umbrales editados. ¿Continuar?")) return;
      try {
        await guardarEditados();
        const id = await App.tarea("/cartas/umbrales_fijos/aplicar", {}, { alTerminar: () => recargar() });
        cerrar(); App.modalTarea("Regenerar alertas con umbrales aplicados", id);
      } catch (e) { App.aviso(e.message, "error"); }
    };
  }

  /* ============================================================
     CUERPO B — ADVERTENCIAS OFICIALES
     ============================================================ */
  const advVarClase = (v) => ({ RR: "rr", TX: "tx", TN: "tn", TMIN: "tn", TMAX: "tx" }[String(v).toUpperCase()] || "rr");
  const advVarEt = (v) => ({ RR: "RR · Precipitación", TX: "TX · T. máxima", TN: "TN · T. mínima",
    TMIN: "TN · T. mínima", TMAX: "TX · T. máxima" }[String(v).toUpperCase()] || String(v));

  // Panel de VALIDACIÓN AGREGADA de las advertencias oficiales — datos que el backend
  // ya calcula en /advertencias/resumen y que antes NO se pintaban: 5 lecturas (acierto /
  // no alertado / insuficiente / sobredimensionada) + día crítico + totales de cobertura.
  function panelValidacionOficial(r) {
    const t = r.totales || {}, L = r.lecturas || {};
    const cel = (k, et, tono) => {
      const o = L[k] || {};
      const pct = o.pct != null ? fmtPct(o.pct) + " %" : "—";
      const n = o.n != null ? fmtNum(o.n) + " pts" : "—";
      return `<div class="ct-des ${tono}"><div class="pct mono">${pct}</div><div class="et">${esc(et)}<br><span>${n}</span></div></div>`;
    };
    const dc = L.dia_critico || {};
    const dcPct = dc.pct != null ? fmtPct(dc.pct) + " %" : "—";
    const cuerpo = !L.total_puntos
      ? `<div class="vacio" style="padding:18px"><span class="suave">El motor aún no ha cruzado puntos estación-día de las advertencias oficiales.</span></div>`
      : `<div class="ct-desenlaces">${cel("acierto", "Acierto", "ok")}${cel("no_alertado", "No alertado", "danger")}${cel("insuficiente", "Insuficiente", "warn")}${cel("sobredimensionada", "Sobredimensionada", "warn")}<div class="ct-des"><div class="pct mono">${dcPct}</div><div class="et">Día crítico<br><span>${fmtNum(dc.acertadas || 0)}/${fmtNum(dc.evaluadas || 0)}</span></div></div></div>`;
    return `
      <div class="ct-panel">
        <div class="ct-panel-cab">
          <h3>Validación de las advertencias oficiales</h3>
          <span class="suave">${fmtNum(t.n || 0)} advertencias · cobertura media ${fmtPct(t.eventos_prom)} % eventos · ${fmtPct(t.area_prom)} % área</span>
        </div>
        ${cuerpo}
        <div class="ct-serie" data-rol="serie-oficial"></div>
        <p class="ct-nota">Cruce de nivel emitido vs. observado (estación + hidroestimador 7-7) sobre los puntos dentro de cada polígono advertido. «Correcto sin alerta» no es derivable de las oficiales (solo se validan puntos dentro de los polígonos).</p>
      </div>`;
  }

  // §serie oficial: GRÁFICO TEMPORAL del acierto (% eventos cubiertos) de cada
  // advertencia oficial, por variable — "cómo van las oficiales en el tiempo".
  function graficarSerieOficial(r) {
    const div = document.querySelector('[data-rol="serie-oficial"]');
    const s = ((r && r.serie_oficial) || []).filter(x => x.eventos_pct != null);
    if (!div || !s.length || !window.Plotly) { if (div) div.innerHTML = ""; return; }
    const oscuro = !!(App.tema && App.tema() === "oscuro");
    const COLV = { RR: "#3D7BE8", TX: "#E07A3F", TN: "#2AAFBE" };
    const ETV = { RR: "Lluvia", TX: "T. máxima", TN: "T. mínima" };
    const vars = [...new Set(s.map(x => x.variable))];
    const trazas = vars.map(v => {
      const ss = s.filter(x => x.variable === v);
      return { type: "scatter", mode: "markers", name: ETV[v] || v,
        x: ss.map(x => x.fecha), y: ss.map(x => x.eventos_pct), customdata: ss.map(x => x.no),
        marker: { size: 9, color: COLV[v] || "#888", line: { width: 1, color: (App.tema && App.tema() === "oscuro") ? "rgba(20,31,56,.6)" : "rgba(255,255,255,.5)" } },
        hovertemplate: `N.º %{customdata} · %{x}<br>%{y:.0f}% eventos cubiertos<extra>${esc(ETV[v] || v)}</extra>` };
    });
    const tinta = oscuro ? "#9DAABF" : "#58667A", rejilla = oscuro ? "rgba(223,230,247,.10)" : "rgba(70,89,122,.12)";
    Plotly.react(div, trazas, {
      height: 240, margin: { l: 42, r: 12, t: 28, b: 40 }, paper_bgcolor: "rgba(0,0,0,0)", plot_bgcolor: "rgba(0,0,0,0)",
      title: { text: "Acierto de advertencias oficiales en el tiempo (% eventos cubiertos)", font: { size: 12, color: tinta } },
      showlegend: true, legend: { orientation: "h", y: -0.22, font: { size: 10, color: tinta } },
      xaxis: { type: "date", tickfont: { size: 9, color: tinta }, showgrid: false },
      yaxis: { range: [0, 100], ticksuffix: "%", tickfont: { size: 9, color: tinta }, gridcolor: rejilla, zeroline: false },
      font: { color: tinta },
    }, { displayModeBar: false, responsive: true });
  }

  async function cuerpoAdvertencias(cont) {
    cont.innerHTML = `<div class="vacio"><div class="icono">⏳</div>Cargando advertencias…</div>`;
    let r;
    try { r = await App.api("/cartas/advertencias/resumen"); }
    catch (e) {
      cont.innerHTML = `<div class="vacio"><div class="icono">⚠️</div>
        <strong>No se pudieron cargar las advertencias</strong><span>${esc(e.message)}</span></div>`;
      return;
    }
    E.adv.resumen = r;
    const lista = (r.advertencias || []).slice();        // {No, Variable, puntos, con_obs, eventos_pct, area_cumple_pct, area_falla_pct, misses}
    if (!lista.length) {
      cont.innerHTML = `<div class="vacio"><div class="icono">📋</div>
        <strong>Sin advertencias validadas</strong><span>El motor aún no ha cruzado advertencias oficiales contra lo observado.</span></div>`;
      return;
    }
    // selección por defecto = última (mayor No).
    lista.sort((a, b) => a.No - b.No);
    // §dinámico: filtro por variable (RR/TX/TN); el día global (D1/D2) va en E.adv.dia.
    const vf = E.adv.varFiltro || "";
    const listaF = vf ? lista.filter(a => String(a.Variable).toUpperCase() === vf) : lista;
    if (E.adv.sel == null || !listaF.some(a => a.No === E.adv.sel)) E.adv.sel = listaF.length ? listaF[listaF.length - 1].No : null;
    const ultimas = listaF.slice(-8);

    const periodo = r.fechas_programa ? `programa ${esc(r.fechas_programa.desde)} → ${esc(r.fechas_programa.hasta)}`
      : `${(r.totales && r.totales.n) || lista.length} en el histórico`;
    const optsBuscar = listaF.slice().reverse().map(adv =>
      `<option value="${adv.No}" ${adv.No === E.adv.sel ? "selected" : ""}>N.º ${adv.No} · ${esc(adv.Variable)} · ${fmtNum(adv.puntos)} pts · ${fmtPct(adv.eventos_pct)} % eventos</option>`).join("");

    const tarjetas = ultimas.map(adv => tarjetaAdvertencia(adv)).join("");

    cont.innerHTML = `
      <div class="ct-buscador">
        <label><span class="et">Variable</span>
          <div class="segmentado" data-rol="adv-var" style="--seg-color:var(--blue)">
            <button class="${!vf ? "activo" : ""}" data-v="">Todas</button>
            <button class="${vf === "RR" ? "activo" : ""}" data-v="RR">Lluvia</button>
            <button class="${vf === "TX" ? "activo" : ""}" data-v="TX">T. máx</button>
            <button class="${vf === "TN" ? "activo" : ""}" data-v="TN">T. mín</button>
          </div></label>
        <label><span class="et">Buscar</span><select data-rol="buscar">${optsBuscar}</select></label>
        <label><span class="et">Día</span>
          <div class="segmentado" data-rol="adv-dia-g" style="--seg-color:var(--blue)">
            <button class="${(E.adv.dia || "D1") === "D1" ? "activo" : ""}" data-d="D1">D1</button>
            <button class="${E.adv.dia === "D2" ? "activo" : ""}" data-d="D2">D2</button>
          </div></label>
        <span class="conteo">${fmtNum(listaF.length)} de ${fmtNum((r.totales && r.totales.n) || lista.length)} · ${periodo}</span>
      </div>
      ${panelValidacionOficial(r)}
      <div data-rol="adv-chirps"></div>
      <h3 class="ct-subtitulo">Últimas 8 advertencias oficiales <span class="suave">(clic para ver su validación abajo)</span></h3>
      <div class="ct-adv-grid" data-rol="cards">${tarjetas}</div>
      <div class="ct-panel" id="ct-adv-detalle"><div class="vacio"><div class="icono">⏳</div>Cargando detalle…</div></div>
      ${htmlCrecidasOficial(r)}`;

    cont.querySelector('[data-rol="buscar"]').onchange = (e) => { E.adv.sel = +e.target.value; refrescarAdvSeleccion(cont); };
    cont.querySelectorAll(".ct-adv").forEach(c =>
      c.onclick = () => { E.adv.sel = +c.dataset.no; refrescarAdvSeleccion(cont); });
    cont.querySelectorAll('[data-rol="adv-var"] button').forEach(b =>
      b.onclick = () => { E.adv.varFiltro = b.dataset.v; E.adv.sel = null; cuerpoAdvertencias(cont); });
    cont.querySelectorAll('[data-rol="adv-dia-g"] button').forEach(b =>
      b.onclick = () => { E.adv.dia = b.dataset.d; cuerpoAdvertencias(cont); });

    cargarDetalleAdv();
    graficarSerieOficial(r);
    pintarMapasTarjetas(cont);
    cargarAdvChirps(cont);
  }

  // Validación de advertencias con CHIRPS CORREGIDO (insumo ADICIONAL): mide la lluvia
  // observada (CHIRPS corregido con estaciones) sobre TODA la zona advertida, no solo en
  // las pocas estaciones dentro. Se calcula al vuelo (/clima/advertencias, ~7 s, cacheado);
  // si el insumo no está disponible, la sección se omite en silencio.
  async function cargarAdvChirps(cont) {
    const host = cont.querySelector('[data-rol="adv-chirps"]');
    if (!host) return;
    host.innerHTML = `<div class="tarjeta" style="padding:12px 16px;margin:12px 0"><span class="suave" style="font-size:12px">Midiendo la lluvia observada (Climatología) sobre cada zona advertida…</span></div>`;
    let r;
    try { r = await App.api("/clima/advertencias"); } catch (e) { host.innerHTML = ""; return; }
    if (!r || !r.disponible || !(r.advertencias || []).length) { host.innerHTML = ""; return; }
    const s = r.resumen;
    const bg = ok => ok ? "background:var(--ok-bg);color:var(--ok)" : "background:var(--surface-3);color:var(--muted)";
    const pill = (ok, t) => `<span style="margin-left:auto;font:600 11px var(--mono,monospace);border-radius:999px;padding:3px 10px;white-space:nowrap;${bg(ok)}">${esc(t)}</span>`;
    const filas = r.advertencias.map(a => {
      const dias = a.dias.map(d =>
        `<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:6px 0;border-top:1px solid var(--line-3)">
          <span style="font:600 12px var(--mono);color:var(--muted);min-width:130px">${esc(d.dia)} · ${esc(d.fecha)}</span>
          <span style="font-size:12px;flex:1;min-width:210px"><b>${fmtNum(d.max)} mm</b> máx · ${fmtNum(d.media)} mm medio · ${Math.round(d.frac_umbral * 100)} % del área ≥ ${s.umbral_mm} mm</span>
          ${pill(d.confirma, d.confirma ? "Confirmada" : "Sin lluvia")}</div>`).join("");
      return `<div style="padding:8px 0;border-top:1px solid var(--line)">
        <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><b style="font-size:13px">Advertencia N.º ${a.no}</b>
        ${pill(a.confirma, a.confirma ? "✓ Confirmada" : "✗ No confirmada")}</div>${dias}</div>`;
    }).join("");
    host.innerHTML = `<div class="tarjeta" style="padding:14px 16px;margin:12px 0">
      <h3 style="margin:0 0 4px;font-size:14px">Validación con <b>Climatología</b> <span class="suave" style="font-weight:400">· insumo adicional</span></h3>
      <p class="suave" style="margin:0 0 10px;font-size:12px">Precipitación observada (climatología grillada corregida con estaciones) sobre <b>toda la zona advertida</b>, no solo en las estaciones dentro de ella. Confirma si ≥ ${s.frac_confirma_pct} % del área superó ${s.umbral_mm} mm.</p>
      <div style="display:flex;gap:20px;flex-wrap:wrap;margin-bottom:4px">
        <span><b style="font:700 18px var(--mono,monospace)">${fmtNum(s.n_advertencias)}</b> <span class="suave" style="font-size:11px">advertencias</span></span>
        <span><b style="font:700 18px var(--mono,monospace)">${fmtNum(s.confirmados)}/${fmtNum(s.n_dias)}</b> <span class="suave" style="font-size:11px">días confirmados</span></span>
        <span><b style="font:700 18px var(--mono,monospace)">${fmtPct(s.confirmados_pct)} %</b> <span class="suave" style="font-size:11px">confirmación</span></span>
      </div>
      ${filas}
    </div>`;
  }

  /* ---- Zonas de riesgo de crecida (FFR): consenso de modelos → polígonos
     bufferados, exportables en formato oficial. El buffer se elige aquí. ---- */
  // Producto FFR del PROGRAMA (riesgo de crecida pronosticado). Va en la pestaña
  // "Advertencias" (catálogo del programa), NO en las oficiales. Se valida POR FECHA
  // contra los desbordamientos/crecidas observados ese día.
  function htmlRiesgoFFR() {
    return `
      <div class="ct-panel ct-ffr">
        <div class="ct-ffr-cab">
          <div>
            <h3 class="ct-subtitulo" style="margin:0">Zonas de riesgo de crecida (FFR · programa)</h3>
            <span class="suave">Riesgo de crecida repentina pronosticado · consenso MÁX de los 4 modelos FFGS · validado vs desbordamientos/crecidas observados de la fecha</span>
          </div>
          <div class="ct-ffr-ctrl">
            <label><span class="et">Fecha</span><select data-rol="ffr-fecha"><option value="-1">vigente</option></select></label>
            <label><span class="et">Buffer</span>
              <select data-rol="ffr-buffer">
                <option value="ninguno">Sin buffer (cuencas exactas)</option>
                <option value="cuencas">Margen sobre cuencas</option>
                <option value="rios">Corredor fluvial</option>
                <option value="ambos" selected>Ambos</option>
              </select></label>
          </div>
        </div>
        <figure class="ct-ffr-mapa ct-det-mapa" style="position:relative;margin:0">
          <a class="ct-dl ct-dl-jpg" role="button" tabindex="0" data-dlimg="1" data-nombre="zonas_riesgo_crecida_FFR"
             title="Descargar mapa (imagen)" aria-label="Descargar mapa"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/></svg></a>
          <a class="ct-dl ct-dl-shp" role="button" tabindex="0" data-rol="ffr-shp" title="Descargar shapefile (.shp + .qml QGIS)" aria-label="Descargar shapefile">SHP</a>
          <div data-rol="ffr-plot" style="width:100%;height:460px"></div>
        </figure>
        <div class="ct-ffr-valida" data-rol="ffr-valida"></div>
        <p class="ct-nota">El polígono encierra las microcuencas en riesgo. Se valida cruzándolo con los
          <b>desbordamientos/crecidas</b> observados de esa fecha (eventos de río dentro de la zona).</p>
      </div>`;
  }

  // Validación de las ZONAS DE CRECIDA OFICIALES (Zonas_riesgo_crecidas.shp por variable,
  // emitidos por el pronosticador) cruzadas vs desbordamientos/crecidas observados. Va en
  // "Advertencias oficiales" (resumen.crecidas = validate_flood_zones de los shapes oficiales).
  function htmlCrecidasOficial(r) {
    const cr = (r && r.crecidas) || {};
    const hay = !!(cr.eventos_periodo || cr.alertas_con_zonas);
    const cuerpo = hay
      ? `<div class="ct-stats" style="margin-top:8px">
          <div class="ct-stat"><div class="v">${fmtNum(cr.alertas_con_zonas || 0)}</div><div class="k">Advertencias con zona de crecida</div></div>
          <div class="ct-stat"><div class="v">${fmtNum(cr.eventos_periodo || 0)}</div><div class="k">Desbordes/crecidas en el periodo</div></div>
          <div class="ct-stat"><div class="v ok">${cr.cubiertos_pct != null ? fmtPct(cr.cubiertos_pct) + " %" : fmtNum(cr.cubiertos || 0)}</div><div class="k">Cubiertos (${fmtNum(cr.cubiertos || 0)})</div></div>
          <div class="ct-stat"><div class="v danger">${fmtNum(cr.no_cubiertos || 0)}</div><div class="k">No cubiertos</div></div>
        </div>`
      : `<p class="ct-nota" style="margin-top:8px">Aún sin cruce de zonas de crecida (se computa al validar las advertencias oficiales contra los desbordamientos/crecidas observados).</p>`;
    return `
      <div class="ct-panel">
        <div class="ct-panel-cab"><h3>Validación de zonas de crecida oficiales</h3>
          <span class="suave">Shapes <b>Zonas_riesgo_crecidas.shp</b> emitidos × desbordamientos/crecidas observados</span></div>
        ${cuerpo}
      </div>`;
  }

  function conectarRiesgoFFR(cont) {
    const plot = cont.querySelector('[data-rol="ffr-plot"]');
    const sel = cont.querySelector('[data-rol="ffr-buffer"]');
    const selF = cont.querySelector('[data-rol="ffr-fecha"]');
    const valida = cont.querySelector('[data-rol="ffr-valida"]');
    const shpBtn = cont.querySelector('[data-rol="ffr-shp"]');
    if (!plot || !sel) return;
    const rec = () => (selF && selF.value) || "-1";
    const cargarValida = async () => {
      if (!valida) return;
      valida.innerHTML = `<span class="suave" style="font-size:12px">Validando vs eventos de río…</span>`;
      try {
        const v = await App.api("/cartas/riesgo_ffr/validacion?" + qs({ buffer: sel.value, record: rec() }));
        valida.innerHTML = `<div class="ct-stats" style="margin-top:8px">
          <div class="ct-stat"><div class="v">${fmtNum(v.n_cuencas || 0)}</div><div class="k">Microcuencas en riesgo</div></div>
          <div class="ct-stat"><div class="v">${fmtNum(v.eventos || 0)}</div><div class="k">Desbordes/crecidas ese día</div></div>
          <div class="ct-stat"><div class="v ok">${v.pct != null ? fmtPct(v.pct) + " %" : "—"}</div><div class="k">Cubiertos (${fmtNum(v.cubiertos || 0)})</div></div>
          <div class="ct-stat"><div class="v danger">${fmtNum(v.no_cubiertos || 0)}</div><div class="k">No cubiertos</div></div>
        </div>`;
      } catch (e) { valida.innerHTML = `<span class="suave" style="font-size:12px">Validación no disponible.</span>`; }
    };
    const pinta = () => {
      renderFFRZona(plot, { buffer: sel.value, record: rec() });
      // El botón SHP (esquina, al lado del de imagen) usa el handler genérico [data-shp]:
      // app = lo guarda el servidor; visor = baja el .zip PRE-CONGELADO. SIN fecha, para que
      // la ruta calce con el .zip congelado por (buffer+record).
      if (shpBtn) shpBtn.dataset.shp = "/cartas/riesgo_ffr/descarga?" + qs({ buffer: sel.value, record: rec() });
      cargarValida();
    };
    sel.onchange = pinta;
    if (selF) selF.onchange = pinta;
    // Poblar el selector con las fechas FFR disponibles y pintar la última.
    (async () => {
      try {
        const r = await App.api("/cartas/riesgo_ffr/fechas");
        const fs = r.fechas || [];
        if (selF && fs.length) selF.innerHTML = fs.map((f, i) =>
          `<option value="${f.record}" ${i === fs.length - 1 ? "selected" : ""}>${esc(f.fecha)}</option>`).join("");
      } catch (e) { /* deja "vigente" */ }
      pinta();
    })();
  }

  // Mapa INTERACTIVO de las zonas de riesgo de crecida (FFR): zona RELLENA translúcida
  // (formas reales de las microcuencas en riesgo, bufferadas — sin casco convexo que las
  // infle) sobre el contorno de Ecuador. Reemplaza el PNG estático; funciona en el visor.
  async function renderFFRZona(div, params) {
    if (!div) return;
    await asegurarGeoCartas();
    let d;
    try { d = await App.api("/cartas/riesgo_ffr/datos?" + qs(params)); }
    catch (e) {
      div.innerHTML = `<div class="vacio" style="padding:22px">${window.HIDROMET_VISOR ? "Zonas FFR no publicadas en el visor" : "Zonas FFR no disponibles"}</div>`;
      return;
    }
    if (!div.isConnected) return;
    const ext = d.bbox || [-81.3, -75.0, -5.1, 1.6];
    const col = d.color || "#009AF2";
    const rgba = (h, a) => { const c = _hexRgb(h); return `rgba(${c[0]},${c[1]},${c[2]},${a})`; };
    const traces = trazasOutline("x", "y", null, 1.4, 3.0);
    const anillos = d.anillos || [];
    if (anillos.length) {
      const xs = [], ys = [];
      for (const an of anillos) { for (const [lo, la] of an) { xs.push(lo); ys.push(la); } xs.push(null); ys.push(null); }
      traces.push({
        type: "scatter", x: xs, y: ys, fill: "toself", mode: "lines",
        line: { color: col, width: 1.7 }, fillcolor: rgba(col, .35),
        name: `Riesgo de crecida (${d.n_cuencas || 0} microcuencas)`, hoverinfo: "skip",
        showlegend: true, xaxis: "x", yaxis: "y",
      });
    }
    const layout = App.plotlyLayoutBase({
      showlegend: anillos.length > 0,
      legend: { orientation: "h", x: 0, y: -0.03, xanchor: "left", font: { size: 10.5 } },
      margin: { l: 0, r: 0, t: 0, b: anillos.length ? 40 : 6 },
      xaxis: { range: [ext[0], ext[1]], visible: false, fixedrange: false },
      yaxis: { range: [ext[2], ext[3]], scaleanchor: "x", scaleratio: 1, visible: false, fixedrange: false },
      dragmode: "pan",
    });
    Plotly.newPlot(div, traces, layout, App.plotlyConfig({ scrollZoom: true, displayModeBar: false, doubleClick: "reset" }));
  }

  function tarjetaAdvertencia(adv) {
    return `
      <div class="ct-adv ${adv.No === E.adv.sel ? "activa" : ""}" data-no="${adv.No}">
        <div class="ct-adv-cab">
          <span class="no">N.º ${adv.No}</span>
          <span class="ct-adv-var ${advVarClase(adv.Variable)}">${esc(String(adv.Variable).toUpperCase())}</span>
        </div>
        <div class="ct-adv-mapa">
          <div class="ct-adv-plot" style="width:100%;height:176px"
               data-no="${adv.No}" data-var="${esc(adv.Variable)}" data-dia="${esc(E.adv.dia || "D1")}"></div>
        </div>
        <div class="ct-adv-pie">
          <span class="ct-adv-chip">${fmtNum(adv.puntos)} pts</span>
          <span class="ct-adv-chip">${fmtPct(adv.eventos_pct)} ev%</span>
          <span class="ct-adv-chip">${fmtPct(adv.area_cumple_pct)} ár%</span>
          <span class="ct-adv-chip">${fmtNum(adv.misses)} miss</span>
        </div>
      </div>`;
  }

  function refrescarAdvSeleccion(cont) {
    E.adv.dia = null;   // al cambiar de advertencia, vuelve al primer día disponible
    cont.querySelectorAll(".ct-adv").forEach(c =>
      c.classList.toggle("activa", +c.dataset.no === E.adv.sel));
    const sel = cont.querySelector('[data-rol="buscar"]');
    if (sel) sel.value = String(E.adv.sel);
    cargarDetalleAdv();
  }

  // Veredicto a partir de eventos_pct (cobertura) — escala del diseño.
  function veredicto(ev) {
    if (ev == null) return { txt: "Sin datos", clase: "warn", final: "warn" };
    if (ev >= 40) return { txt: "Bueno", clase: "ok", final: "ok" };
    if (ev >= 20) return { txt: "Aceptable", clase: "warn", final: "warn" };
    return { txt: "Mejorable", clase: "danger", final: "danger" };
  }

  // ── Mapa de cruce INTERACTIVO (Plotly) — sustituye al cruce.png estático ──────
  // Polígono OFICIAL (envolvente única = "solo el más grande") + estaciones por las
  // 5 lecturas (mismos colores/símbolos que el motor), con zoom/pan/hover.
  const CRUCE_SIMBOLO = { acierto: "circle", no_alertado: "x", insuficiente: "triangle-up",
                          sobredimensionada: "triangle-down", correcto_sin_alerta: "square" };
  const CRUCE_NIVEL = ["Sin alerta", "Medio", "Alto", "Muy alto"];

  function trazasCruce(datos, mini) {
    const traces = trazasOutline("x", "y", null, mini ? 0.8 : 1.4, mini ? 1.8 : 3.0);
    const rgba = (h, a) => { const c = _hexRgb(h); return `rgba(${c[0]},${c[1]},${c[2]},${a})`; };
    const nm = datos.niveles_meta || {};
    // Polígonos POR NIVEL (Medio→Alto→Muy alto): cada uno con SU color (relleno tenue +
    // borde sólido) → se distingue cada polígono por su nivel de riesgo.
    for (const blk of (datos.niveles || [])) {
      const meta = nm[String(blk.nivel)] || { color: "#2563eb", etq: "N" + blk.nivel };
      const xs = [], ys = [];
      for (const an of (blk.anillos || [])) {
        for (const [lo, la] of an) { xs.push(lo); ys.push(la); }
        xs.push(null); ys.push(null);
      }
      if (!xs.length) continue;
      traces.push({ type: "scatter", mode: "lines", x: xs, y: ys, fill: "toself",
        fillcolor: rgba(meta.color, mini ? 0.12 : 0.16), line: { color: meta.color, width: mini ? 1.4 : 2.4 },
        name: `Polígono ${meta.etq}`, hoverinfo: "skip", showlegend: !mini, xaxis: "x", yaxis: "y" });
    }
    const L = datos.lecturas || { orden: [], color: {}, etiqueta: {} };
    for (const lect of L.orden) {
      const pts = (datos.estaciones || []).filter(e => e.lectura === lect);
      if (!pts.length) continue;
      traces.push({ type: "scatter", mode: "markers",
        x: pts.map(p => p.lon), y: pts.map(p => p.lat),
        name: `${L.etiqueta[lect] || lect} (${pts.length})`,
        marker: { size: mini ? 6.5 : 10, color: L.color[lect] || "#64748b", symbol: CRUCE_SIMBOLO[lect] || "circle",
                  line: { width: mini ? 0.8 : 1.4, color: "#fff" } },
        customdata: pts.map(p => [CRUCE_NIVEL[p.nivel_emitido] || p.nivel_emitido,
                                  CRUCE_NIVEL[p.nivel_observado] || p.nivel_observado, p.codigo || ""]),
        hovertemplate: `<b>%{customdata[2]}</b><br>Emitido: %{customdata[0]} · Observado: %{customdata[1]}`
                       + `<extra>${esc(L.etiqueta[lect] || lect)}</extra>`,
        showlegend: !mini, xaxis: "x", yaxis: "y" });
    }
    return traces;
  }

  async function renderCruceMapa(div, params, mini) {
    if (!div) return;
    await asegurarGeoCartas();
    let datos;
    try { datos = await App.api("/cartas/advertencias/cruce_datos?" + qs(params)); }
    catch (e) { div.innerHTML = `<div class="vacio" style="padding:24px">Mapa no disponible</div>`; return; }
    if (!div.isConnected) return;
    if (!datos || datos.error) {
      div.innerHTML = `<div class="vacio" style="padding:24px">${esc((datos && datos.error) || "Mapa no disponible")}</div>`; return; }
    const ext = datos.bbox || [-81.2, -75, -5.2, 1.6];
    const layout = App.plotlyLayoutBase({
      showlegend: !mini,
      legend: { orientation: "h", x: 0, y: -0.03, xanchor: "left", yanchor: "top", font: { size: 10.5 } },
      margin: mini ? { l: 0, r: 0, t: 0, b: 0 } : { l: 0, r: 0, t: 0, b: 48 },
      xaxis: { range: [ext[0], ext[1]], visible: false, fixedrange: mini },
      yaxis: { range: [ext[2], ext[3]], scaleanchor: "x", scaleratio: 1, visible: false, fixedrange: mini },
      dragmode: mini ? false : "pan",
    });
    Plotly.newPlot(div, trazasCruce(datos, mini), layout,
      App.plotlyConfig({ scrollZoom: !mini, displayModeBar: false, doubleClick: mini ? false : "reset" }));
  }

  // Pinta los mini-mapas de las tarjetas en SECUENCIA (yield entre cada uno para no
  // congelar el hilo con 8 Plotly de golpe).
  async function pintarMapasTarjetas(cont) {
    for (const div of cont.querySelectorAll(".ct-adv-plot")) {
      if (!div.isConnected) continue;
      await renderCruceMapa(div, { no: div.dataset.no, variable: div.dataset.var, dia: div.dataset.dia || "D1" }, true);
      await new Promise(r => requestAnimationFrame(r));
    }
  }

  async function cargarDetalleAdv() {
    const panel = document.getElementById("ct-adv-detalle");
    if (!panel) return;
    const no = E.adv.sel;
    const meta = (E.adv.resumen.advertencias || []).find(a => a.No === no) || {};
    const variable = meta.Variable;
    let det;
    try { det = await App.api("/cartas/advertencias/detalle?" + qs({ no, variable })); }
    catch (e) { panel.innerHTML = `<div class="vacio"><span class="suave">Detalle no disponible: ${esc(e.message)}</span></div>`; return; }
    if (!document.getElementById("ct-adv-detalle")) return;

    const ev = meta.eventos_pct, area = meta.area_cumple_pct;
    const puntos = meta.puntos != null ? meta.puntos : (det.puntos || []).length;
    const misses = meta.misses != null ? meta.misses : (det.misses || []).length;
    const ver = veredicto(ev);
    const dias = [...new Set((det.puntos || []).map(p => p.Dia).filter(Boolean))].sort();
    const dia = (E.adv.dia && dias.includes(E.adv.dia)) ? E.adv.dia : (dias[0] || "D1");
    const navDia = dias.length > 1
      ? `<div class="segmentado" data-rol="advdia" style="--seg-color:var(--blue)">${dias.map(dd =>
          `<button class="${dd === dia ? "activo" : ""}" data-dia="${esc(dd)}">${esc(dd)}</button>`).join("")}</div>`
      : "";

    panel.innerHTML = `
      <div class="ct-det-cab">
        <h3>Advertencia N.º ${esc(no)}</h3>
        <span class="ct-adv-var ${advVarClase(variable)}">${esc(advVarEt(variable))}</span>
        <span class="meta">validada contra observado · ventana 24 h · ${fmtNum(puntos)} puntos estación-día</span>
        ${navDia ? `<span class="ct-det-dia" style="margin-left:auto;display:flex;align-items:center;gap:6px"><span class="et">Día</span>${navDia}</span>` : ""}
      </div>
      <p class="ct-det-intro">Cruce real del polígono emitido contra lo observado (datos de validación oficiales).</p>
      <div class="ct-stats">
        <div class="ct-stat"><div class="v ok">${fmtPct(ev)}<small> %</small></div><div class="k">Eventos cubiertos</div></div>
        <div class="ct-stat"><div class="v warn">${fmtPct(area)}<small> %</small></div><div class="k">Cumple área</div></div>
        <div class="ct-stat"><div class="v">${fmtNum(puntos)}</div><div class="k">Puntos con obs.</div></div>
        <div class="ct-stat"><div class="v danger">${fmtNum(misses)}</div><div class="k">Fuera del polígono</div></div>
        <div class="ct-stat"><div class="ct-veredicto ${ver.clase}">${esc(ver.txt)}</div><div class="k" style="margin-top:8px">Veredicto</div></div>
      </div>
      <div class="ct-det-cuerpo">
        <figure class="ct-det-mapa" style="position:relative">
          <a class="ct-dl ct-dl-jpg" role="button" tabindex="0" data-dlimg="1" data-nombre="advertencia_${esc(no)}_${esc(String(variable))}_${esc(dia)}"
             title="Descargar mapa (imagen)" aria-label="Descargar mapa de la advertencia">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/></svg>
          </a>
          <div data-rol="cruce-plot" style="width:100%;height:460px"></div></figure>
        <div class="ct-lecturas">
          <div class="micro">Cinco lecturas ejecutivas</div>
          <div class="ct-lectura"><span class="n">1</span><div class="tx"><b>Cobertura.</b> ${fmtPct(ev)} % de los eventos observados cayeron dentro del polígono.</div></div>
          <div class="ct-lectura"><span class="n">2</span><div class="tx"><b>Área.</b> El ${fmtPct(area)} % del polígono coincidió con zonas que reportaron el evento.</div></div>
          <div class="ct-lectura"><span class="n">3</span><div class="tx"><b>Muestra.</b> ${fmtNum(puntos)} puntos estación-día con observación disponible.</div></div>
          <div class="ct-lectura miss"><span class="n">4</span><div class="tx"><b>Fugas.</b> ${fmtNum(misses)} eventos quedaron fuera del polígono advertido.</div></div>
          <div class="ct-lectura final ${ver.final === "ok" ? "ok" : ""}"><span class="n">!</span><div class="tx"><b>Veredicto: ${esc(ver.txt.toLowerCase())}.</b> Cobertura ${fmtPct(ev)} % de los eventos; ${ev != null && ev < 40 ? "margen para ajustar el área del polígono." : "buen cierre del polígono advertido."}</div></div>
        </div>
      </div>
      ${String(variable).toUpperCase() === "RR" ? `<div class="ct-panel" style="margin-top:14px">
        <div class="ct-panel-cab"><h3>Validación de la zona de crecida (oficial)</h3>
          <span class="suave">Zona <b>Zonas_riesgo_crecidas.shp</b> × desbordes/crecidas observados del periodo</span></div>
        <figure class="ct-det-mapa" style="position:relative">
          <a class="ct-dl ct-dl-jpg" role="button" tabindex="0" data-dlimg="1" data-nombre="advertencia_${esc(no)}_crecida_${esc(dia)}"
             title="Descargar mapa (imagen)" aria-label="Descargar mapa de la zona de crecida">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/></svg>
          </a>
          <div data-rol="crecida-plot" style="width:100%;height:380px"></div></figure>
      </div>` : ""}`;
    panel.querySelectorAll('[data-rol="advdia"] button').forEach(b =>
      b.onclick = () => { E.adv.dia = b.dataset.dia; cargarDetalleAdv(); });
    renderCruceMapa(panel.querySelector('[data-rol="cruce-plot"]'), { no, variable, dia }, false);
    if (String(variable).toUpperCase() === "RR")
      renderCrecidaMapa(panel.querySelector('[data-rol="crecida-plot"]'), no, variable);
  }

  // Mapa de validación de la ZONA DE CRECIDA oficial: polígono emitido + desbordes/
  // crecidas observados, marcados cubierto (dentro, verde) / no cubierto (fuera, rojo).
  async function renderCrecidaMapa(div, no, variable) {
    if (!div) return;
    await asegurarGeoCartas();
    let d;
    try { d = await App.api("/cartas/advertencias/crecida_datos?" + qs({ no, variable })); }
    catch (e) { div.innerHTML = `<div class="vacio" style="padding:20px">Validación no disponible</div>`; return; }
    if (!div.isConnected) return;
    if (!d || !d.hay_zona) {
      div.innerHTML = `<div class="vacio" style="padding:22px">Esta advertencia no tiene zona de crecida emitida (Zonas_riesgo_crecidas.shp).</div>`;
      return;
    }
    const rgba = (h, a) => { const c = _hexRgb(h); return `rgba(${c[0]},${c[1]},${c[2]},${a})`; };
    const ext = d.bbox || [-81.2, -75, -5.2, 1.6];
    const traces = trazasOutline("x", "y", null, 1.4, 3.0);
    const xs = [], ys = [];
    for (const an of (d.anillos || [])) { for (const [lo, la] of an) { xs.push(lo); ys.push(la); } xs.push(null); ys.push(null); }
    if (xs.length) traces.push({ type: "scatter", mode: "lines", x: xs, y: ys, fill: "toself",
      fillcolor: rgba("#009AF2", 0.14), line: { color: "#009AF2", width: 2.4 }, name: "Zona de crecida",
      hoverinfo: "skip", showlegend: true, xaxis: "x", yaxis: "y" });
    for (const [key, color, etq, sym] of [[true, "#15803d", "Cubierto", "circle"], [false, "#b91c1c", "No cubierto", "x"]]) {
      const pts = (d.eventos || []).filter(e => e.cubierto === key);
      if (!pts.length) continue;
      traces.push({ type: "scatter", mode: "markers", x: pts.map(p => p.lon), y: pts.map(p => p.lat),
        name: `${etq} (${pts.length})`,
        marker: { size: 9, color, symbol: sym, line: { width: 1.3, color: "#fff" } },
        customdata: pts.map(p => [p.tipo || "", p.fecha || ""]),
        hovertemplate: `<b>%{customdata[0]}</b><br>%{customdata[1]}<extra>${etq}</extra>`,
        showlegend: true, xaxis: "x", yaxis: "y" });
    }
    const layout = App.plotlyLayoutBase({
      showlegend: true, legend: { orientation: "h", x: 0, y: -0.03, xanchor: "left", font: { size: 10.5 } },
      margin: { l: 0, r: 0, t: 0, b: 46 },
      xaxis: { range: [ext[0], ext[1]], visible: false, fixedrange: false },
      yaxis: { range: [ext[2], ext[3]], scaleanchor: "x", scaleratio: 1, visible: false, fixedrange: false },
      dragmode: "pan",
    });
    Plotly.newPlot(div, traces, layout, App.plotlyConfig({ scrollZoom: true, displayModeBar: false, doubleClick: "reset" }));
  }

  /* ============================================================
     Render del cuerpo según el tipo activo
     ============================================================ */
  function pintarCuerpo() {
    // Tras la migración a App.vistaPestanas, el cuerpo se rinde en el contenedor
    // de la pestaña activa (.hm-cuerpo), no en el viejo #ct-cuerpo. Sin este
    // fallback, re()=pintarCuerpo() no encontraba contenedor y NINGÚN control
    // (variable/período/instante/◀▶) actualizaba las cartas.
    const cont = document.getElementById("ct-cuerpo") || document.querySelector(".hm-cuerpo");
    if (!cont) return;
    purgarCartas();                       // libera los mapas Plotly del render anterior
    const def = TIPOS.find(t => t.id === E.tipo) || TIPOS[0];

    if (def.cuerpo === "advertencias") { cuerpoAdvertencias(cont); return; }
    if (def.cuerpo === "alertas") {
      cont.innerHTML = cuerpoAlertas();
      conectarAlertas(cont);
      montarMapasCarta(cont);
      return;
    }
    // FFGS: rejilla propia (TODOS los productos del paso horario, leyenda por carta).
    if (E.tipo === "ffgs") {
      cont.innerHTML = cuerpoGridFFGS();
      conectarGridFFGS(cont);
      montarMapasCarta(cont);
      return;
    }
    if (E.tipo === "heladas") {
      cont.innerHTML = cuerpoGridHeladas();
      conectarGridHeladas(cont);
      montarMapasCarta(cont);
      return;
    }
    // grid (pronóstico/calibrado/hidro)
    cont.innerHTML = cuerpoGrid(E.tipo);
    conectarGrid(cont, E.tipo);
    montarMapasCarta(cont);
  }

  function conectarTipos() {
    document.querySelectorAll("#ct-tipos .chip").forEach(b =>
      b.onclick = () => {
        E.tipo = b.dataset.tipo;
        document.getElementById("ct-tipos").innerHTML = chipsTipos();
        conectarTipos();
        if (E.tipo === "alertas") cargarFechas();
        pintarCuerpo();
      });
  }

  /* ============================================================
     Carga del árbol de productos + (re)pintado
     ============================================================ */
  async function recargar() {
    if (!E) return;                                   // la vista pudo desmontarse
    if (E.alerta) E.alerta._desClave = null;          // invalida la caché de desempeño
    try { E.productos = await App.api("/cartas/productos"); }
    catch (e) { /* mantiene el árbol previo */ }
    if (vp) { try { vp.pintar(vp.activa()); } catch (e) {} }   // re-pinta la pestaña activa
  }

  /* ---- Estado compartido entre los módulos Pronóstico/Advertencias y el panel
     FFGS (que vive bajo Hidrología). Idempotente: carga el árbol una vez. ---- */
  async function asegurarEstado() {
    if (!E) {
      E = { tipo: "pronostico", productos: { tipos: [] }, grid: {},
            capas: { grilla: true, galapagos: true, estaciones: false },
            alerta: { varId: "alerta_lluvia", modo: "fija", inst: null,
                      opts: Object.fromEntries(TOGGLES.map(t => [t.id, t.on])), fechasEmitidas: [] },
            adv: { sel: null, resumen: null, dia: null, varFiltro: "" } };
    }
    if (!(E.productos.tipos || []).length || E._stale) {
      try {
        E.productos = await App.api("/cartas/productos");
        E._stale = false;
        if (E.productos.umbrales_modo) E.alerta.modo = E.productos.umbrales_modo;
      } catch (e) { App.aviso("No se pudo cargar el catálogo de cartas: " + e.message, "error"); }
    }
  }

  // Paneles reutilizables (cada uno asegura el estado + libera Plotly previo).
  function panelGrid(tipoId) {
    return async (cont) => {
      await asegurarEstado(); purgarCartas(); E.tipo = tipoId;
      cont.innerHTML = cuerpoGrid(tipoId); conectarGrid(cont, tipoId); montarMapasCarta(cont);
    };
  }
  async function panelAlertas(cont) {
    await asegurarEstado(); purgarCartas(); E.tipo = "alertas";
    cont.innerHTML = cuerpoAlertas(); conectarAlertas(cont); montarMapasCarta(cont); cargarFechas();
  }
  async function panelAdvertencias(cont) {
    await asegurarEstado(); purgarCartas(); E.tipo = "advertencias"; cuerpoAdvertencias(cont);
  }
  async function panelFFGS(cont) {
    await asegurarEstado(); purgarCartas(); E.tipo = "ffgs";
    cont.innerHTML = cuerpoGridFFGS(); conectarGridFFGS(cont); montarMapasCarta(cont);
  }
  async function panelHeladas(cont) {
    await asegurarEstado(); purgarCartas(); E.tipo = "heladas";
    cont.innerHTML = cuerpoGridHeladas(); conectarGridHeladas(cont); montarMapasCarta(cont);
  }
  App.panel("ffgs", panelFFGS);   // lo reusa el módulo Hidrología
  App.panel("cartas:purgar", purgarCartas);   // para que Hidrología libere los Plotly de FFGS

  // Bus de refresco: al terminar CUALQUIER actualización, invalida el catálogo
  // cacheado (no más cartas/alertas viejas tras "Actualizar"). Si la vista está
  // montada, repinta ya; si no, asegurarEstado re-fetchea al volver a entrar.
  document.addEventListener("datos-actualizados", () => {
    if (!E) return;
    if (E.alerta) E.alerta._desClave = null;
    if (vp) recargar();
    else E._stale = true;   // NO destruir E.productos: rompería un panel FFGS montado bajo Hidrología; re-fetch perezoso en asegurarEstado
  });

  // Descarga de shapefile (alertas / FFGS) O carta JPG: se GUARDA en la carpeta Descargas desde el
  // servidor (el <a download> de WebView2 no descarga) y se avisa, como el resto de exports.
  document.addEventListener("click", async (ev) => {
    const b = ev.target && ev.target.closest && ev.target.closest("[data-shp],[data-jpg],[data-dlimg]");
    if (!b) return;
    ev.preventDefault();
    if (b.dataset.busy) return;
    b.dataset.busy = "1"; b.style.opacity = ".45";
    try {
      // IMAGEN del mapa: advertencias (data-dlimg) siempre, y las cartas (data-jpg) cuando
      // estamos en el VISOR en línea (sin backend que renderice la carta formal).
      if (b.dataset.dlimg || (b.dataset.jpg && window.HIDROMET_VISOR)) {
        await descargarImagenMapa(b);
      } else if (b.dataset.jpg) {
        const r = await App.api(b.dataset.jpg);   // app: carta FORMAL renderizada por el servidor
        App.aviso(`Carta guardada en Descargas: ${r.archivo}`, "ok", 6000);
      } else if (b.dataset.shp) {
        if (window.HIDROMET_VISOR) {
          await _descargarShpVisor(b.dataset.shp);   // baja el .zip PRE-CONGELADO
        } else {
          const r = await App.api(b.dataset.shp);
          App.aviso(`Shapefile guardado en Descargas: ${r.archivo}`, "ok", 6000);
        }
      }
    } catch (e) {
      App.aviso(e.message || "No se pudo descargar", "error", 7000);
    } finally {
      delete b.dataset.busy; b.style.opacity = "";
    }
  });

  // VISOR: descarga el shapefile de una advertencia del PROGRAMA desde el .zip PRE-CONGELADO
  // (misma ruta que el exportador, con extensión .zip). No hay motor que lo genere en vivo.
  async function _descargarShpVisor(rutaApi) {
    const prod = App.rutaAProducto(rutaApi).replace(/\.json$/, ".zip");
    const resp = await fetch(prod, { cache: "no-cache" });
    if (!resp.ok) throw new Error("El shapefile de esta advertencia aún no está publicado en el visor");
    const blob = await resp.blob();
    const nombre = prod.split("/").pop() || "shapefile.zip";
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = nombre;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 8000);
    App.aviso("Shapefile descargado", "ok", 4000);
  }

  // Descarga el mapa Plotly vecino al botón como una CARTA (con su título y leyenda). VISOR
  // (navegador real): compone el PNG con Plotly y lo baja con <a download>. APP (WebView2 no
  // dispara <a download>): manda el PNG al servidor, que lo guarda en Descargas.
  async function descargarImagenMapa(b) {
    const cont = b.closest(".ct-lienzo") || b.closest("figure") || b.parentElement;
    const plot = cont && (cont.querySelector(".ct-mapa-plot") || cont.querySelector('[data-rol="cruce-plot"]')
      || cont.querySelector('[data-rol="ffr-plot"]') || cont.querySelector('[data-rol="crecida-plot"]')
      || cont.querySelector(".js-plotly-plot"));
    if (!plot || !window.Plotly) throw new Error("El mapa aún no está listo");
    const nombre = String(b.dataset.nombre || "carta").replace(/[^\w\-]+/g, "_").slice(0, 60) || "carta";
    const bb = plot.getBoundingClientRect();
    const w = Math.max(1000, Math.round((bb.width || 520) * 2));
    const h = Math.max(680, Math.round((bb.height || 360) * 2));
    // Carta de pronóstico/alerta (tiene datos guardados) → imagen FORMAL con título + leyenda.
    // Advertencias/FFR ya llevan su leyenda dentro de la figura → se capturan tal cual.
    const dataUrl = plot._carta
      ? await _imagenCartaFormal(plot, w, h)
      : await window.Plotly.toImage(plot, { format: "png", width: w, height: h, scale: 1 });
    if (window.HIDROMET_VISOR) {
      const a = document.createElement("a"); a.href = dataUrl; a.download = nombre + ".png";
      document.body.appendChild(a); a.click(); a.remove();
      App.aviso("Carta descargada (PNG con leyenda)", "ok", 4000);
    } else {
      const r = await App.api("/cartas/guardar_imagen", { method: "POST", body: { imagen: dataUrl, nombre } });
      App.aviso(`Carta guardada en Descargas: ${r.archivo}`, "ok", 6000);
    }
  }

  // PNG (dataURL) de una carta CON su título y su leyenda (colorbar), reconstruidos
  // TEMPORALMENTE sobre el propio plot y revertidos después (el visor no tiene backend que
  // renderice el PNG formal del servidor, así que la carta se compone en el navegador).
  async function _imagenCartaFormal(plot, w, h) {
    const c = plot._carta || {};
    const data = plot.data || [];
    const idx = data.findIndex(t => t.type === "heatmap" && (!t.xaxis || t.xaxis === "x"));
    const relOn = { "margin.t": (c.titulo ? 54 : 12), "margin.r": 96, "margin.b": 14 };
    if (c.titulo) {
      relOn["title.text"] = esc(c.titulo) + (c.subtitulo ? `<br><span style="font-size:12px;font-weight:400">${esc(c.subtitulo)}</span>` : "");
      relOn["title.x"] = 0.5; relOn["title.xanchor"] = "center"; relOn["title.y"] = 0.98; relOn["title.font.size"] = 16;
    }
    await window.Plotly.relayout(plot, relOn);
    const conBarra = idx >= 0 && c.tickvals && c.tick_labels && c.tickvals.length === c.tick_labels.length;
    if (conBarra) {
      await window.Plotly.restyle(plot, {
        showscale: true,
        colorbar: [{ thickness: 13, len: 0.86, y: 0.5, x: 1.0, xpad: 4, outlinewidth: 0,
          tickvals: c.tickvals, ticktext: c.tick_labels, tickfont: { size: 9 },
          title: { text: c.unidad || "", side: "right", font: { size: 10 } } }],
      }, [idx]);
    }
    let url;
    try { url = await window.Plotly.toImage(plot, { format: "png", width: w, height: h, scale: 1 }); }
    finally {
      await window.Plotly.relayout(plot, { "title.text": "", "margin.t": 0, "margin.r": 0, "margin.b": 0 });
      if (conBarra) await window.Plotly.restyle(plot, { showscale: false }, [idx]);
    }
    return url;
  }

  /* ============================================================
     REGISTRO de la vista
     ============================================================ */
  const ACC_ACTUALIZAR = '<button class="boton oscuro" id="ct-actualizar">⟳ Actualizar</button>';
  function _alDejarCartas() {
    purgarCartas();
    const cab = document.getElementById("cabecera-vista");
    if (cab) cab.style.display = "";            // restaurar la cabecera global
    vp = null;
  }
  function _wireActualizar(vista) {
    const b = vista.querySelector("#ct-actualizar");
    if (b) b.onclick = abrirActualizar;
  }

  /* ============================================================
     PESTAÑA "Series temporales" — comparativa multimodelo por estación,
     según la variable y la frecuencia: ≥15 días pasados + presente + horizonte
     futuro. A 24 h se incluyen las observaciones con etiquetas de valor.
     ============================================================ */
  async function panelSeries(cont) {
    await asegurarEstaciones();
    const ests = Array.isArray(_estaciones) ? _estaciones : [];
    const valEst = e => String(e.codigo || e.cod || e.id || "");
    const nomEst = e => String(e.nombre || e.nombre_estacion || e.name || valEst(e));
    const optEst = ests.map(e => `<option value="${esc(valEst(e))}">${esc(nomEst(e))} (${esc(valEst(e))})</option>`).join("");
    cont.innerHTML = `
      <div class="filtros">
        <label class="campo"><span>Variable</span><select data-rol="s-var">
          <option value="precip">Precipitación</option>
          <option value="Tmax">Temperatura máxima</option>
          <option value="Tmin">Temperatura mínima</option></select></label>
        <label class="campo"><span>Frecuencia</span><select data-rol="s-freq">
          <option value="24">24 h (diario)</option>
          <option value="12">12 h</option><option value="6">6 h</option>
          <option value="3">3 h</option><option value="1">1 h</option></select></label>
        <label class="campo" style="min-width:230px"><span>Estación</span><select data-rol="s-est">${optEst}</select></label>
      </div>
      <div data-rol="s-plot" style="min-height:400px"></div>
      <p class="ml-serie-pie" data-rol="s-pie"></p>`;
    const sel = r => cont.querySelector(`[data-rol="${r}"]`);
    if (!ests.length) { sel("s-plot").innerHTML = `<p style="padding:20px;color:var(--muted)">No hay estaciones disponibles. Actualiza las cartas primero.</p>`; return; }

    async function pintar() {
      const v = sel("s-var").value, cod = sel("s-est").value;
      const plot = sel("s-plot"), pie = sel("s-pie");
      const esTemp = v !== "precip";
      sel("s-freq").disabled = esTemp;            // la temperatura solo es diaria (Tmax/Tmin)
      if (esTemp) sel("s-freq").value = "24";
      const f = sel("s-freq").value;
      plot.innerHTML = `<p style="padding:20px;color:var(--muted)">Cargando serie…</p>`; pie.textContent = "";
      let r;
      try {
        r = (f === "24")
          ? await App.api(`/cartas/series/estacion?codigo=${encodeURIComponent(cod)}&variable=${v}&dias=20&tipo=pronostico`)
          : await App.api(`/cartas/series/grilla?codigo=${encodeURIComponent(cod)}&variable=${v}&periodo=${f}&tipo=pronostico`);
      } catch (e) { plot.innerHTML = `<p style="padding:20px;color:var(--danger)">No se pudo cargar la serie.</p>`; return; }
      if (!r || r.error || !(r.trazas && r.trazas.length)) {
        plot.innerHTML = `<p style="padding:20px;color:var(--muted)">Sin datos para ${esc(v)} a ${esc(f)} h en esta estación (las series sub-diarias requieren cartas cargadas de ese período).</p>`;
        return;
      }
      plot.innerHTML = "";
      if (!window.Plotly) return;
      const esPrecip = (r.es_precip != null) ? r.es_precip : (v === "precip");
      const layout = App.plotlyLayoutSerie("", {
        barmode: "overlay",
        yaxis: { title: { text: r.unidad || (esPrecip ? "mm" : "°C"), font: { size: 11 } }, rangemode: esPrecip ? "tozero" : "normal" },
        xaxis: { type: "date", tickformat: "%d/%m", tickangle: 0, nticks: 12 },
      });
      if (r.hoy) {
        layout.shapes = [{ type: "line", x0: r.hoy, x1: r.hoy, yref: "paper", y0: 0, y1: 1, line: { color: (App.tema && App.tema() === "oscuro") ? "#75859D" : "#95A1B2", width: 1.2, dash: "dot" } }];
        layout.annotations = [{ x: r.hoy, yref: "paper", y: 1, yanchor: "bottom", text: "presente", showarrow: false, font: { family: "IBM Plex Mono", size: 10, color: (App.tema && App.tema() === "oscuro") ? "#9DAABF" : "#5A6678" } }];
      }
      window.Plotly.newPlot(plot, r.trazas, layout, App.plotlyConfig());
      pie.innerHTML = `Comparativa multimodelo — ${f === "24" ? "diario (24 h)" : f + " h"}.` +
        (esPrecip && f === "24" ? " Las observaciones (negro) llevan etiqueta de valor." : (esTemp ? " Temperatura diaria por modelo." : " Modelos (sin observación sub-diaria).")) +
        " Cubre los últimos ~20 días + el horizonte de pronóstico.";
    }
    ["s-var", "s-freq", "s-est"].forEach(rr => sel(rr).addEventListener("change", pintar));
    pintar();
  }

  // MENÚ "Pronóstico": pronóstico · calibrado · hidroestimadores · heladas/calor.
  App.registrar("pronostico", {
    titulo: "Pronóstico", orden: 1,
    async render(vista) {
      vista.dataset.screenLabel = "Pronóstico";
      await asegurarEstado();
      vp = App.vistaPestanas(vista, {
        kicker: "Productos grillados", titulo: "Pronóstico",
        sub: "Cartas interpoladas sobre Ecuador", accionesHTML: ACC_ACTUALIZAR,
        inicial: "pronostico",
        pestanas: [
          { id: "pronostico", etiqueta: "Pronóstico", render: panelGrid("pronostico"), alSalir: purgarCartas },
          { id: "calibrado", etiqueta: "Pronóstico calibrado", render: panelGrid("calibrado"), alSalir: purgarCartas },
          { id: "hidro", etiqueta: "Hidroestimadores", render: panelGrid("hidro"), alSalir: purgarCartas },
          { id: "heladas", etiqueta: "Heladas / Calor", render: panelHeladas, alSalir: purgarCartas },
        ],
      });
      _wireActualizar(vista);
    },
    alDejar: _alDejarCartas,
  });

  // MENÚ "Advertencias": Advertencias (alertas del programa) · Advertencias oficiales.
  App.registrar("advertencias", {
    titulo: "Advertencias", orden: 4,
    async render(vista) {
      vista.dataset.screenLabel = "Advertencias";
      await asegurarEstado();
      vp = App.vistaPestanas(vista, {
        kicker: "Alertas y advertencias", titulo: "Advertencias",
        sub: "Alertas por consenso con validación de desempeño · advertencias oficiales",
        accionesHTML: ACC_ACTUALIZAR, inicial: "alertas",
        pestanas: [
          { id: "alertas", etiqueta: "Advertencias", danger: true, render: panelAlertas, alSalir: purgarCartas },
          { id: "advertencias", etiqueta: "Advertencias oficiales", render: panelAdvertencias, alSalir: purgarCartas },
        ],
      });
      _wireActualizar(vista);
    },
    alDejar: _alDejarCartas,
  });

  /* ---------- Actualizar (botón oscuro) → tarea /cartas/actualizar ---------- */
  function abrirActualizar() {
    const fondo = document.createElement("div");
    fondo.className = "modal-fondo";
    const modelos = ["GFS", "ICON", "IFS"];
    fondo.innerHTML = `<div class="modal">
      <header><span>Actualizar cartas y alertas</span>
        <button class="boton chico" data-rol="cerrar">Cerrar</button></header>
      <div class="cuerpo">
        <div class="suave" style="font-size:12.5px;margin-bottom:12px">Descarga los últimos pronósticos y rehace cartas, alertas y advertencias.</div>
        <label class="campo" style="margin-bottom:12px"><span>Alcance</span>
          <select data-rol="alcance">
            <option value="cartas">Todo cartas (pronóstico + alertas + advertencias)</option>
            <option value="modelos">Solo pronóstico</option>
            <option value="alertas">Solo alertas</option>
            <option value="advertencias">Solo advertencias</option>
          </select></label>
        <div class="micro" style="margin-bottom:6px">Modelos</div>
        <div class="segmentado" data-rol="modelos" style="--seg-color:var(--blue)">
          ${modelos.map(m => `<button class="activo" data-modelo="${m}">${m}</button>`).join("")}
        </div>
        <div class="fila separada" style="margin-top:18px">
          <span class="suave" style="font-size:12px">Se ejecuta en segundo plano.</span>
          <button class="boton oscuro" data-rol="ejecutar">⟳ Ejecutar</button>
        </div>
      </div></div>`;
    document.body.appendChild(fondo);
    const cerrar = () => fondo.remove();
    fondo.querySelector('[data-rol="cerrar"]').onclick = cerrar;
    fondo.onclick = (e) => { if (e.target === fondo) cerrar(); };
    fondo.querySelectorAll('[data-rol="modelos"] button').forEach(b =>
      b.onclick = () => b.classList.toggle("activo"));
    fondo.querySelector('[data-rol="ejecutar"]').onclick = async () => {
      const alcance = fondo.querySelector('[data-rol="alcance"]').value;
      const modelos = [...fondo.querySelectorAll('[data-rol="modelos"] button.activo')].map(b => b.dataset.modelo);
      try {
        const id = await App.tarea("/cartas/actualizar", { alcance, modelos });
        cerrar(); App.modalTarea("Actualizar cartas y alertas", id);
      } catch (e) { App.aviso(e.message, "error"); }
    };
  }
})();
