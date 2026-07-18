/* ============================================================
   HidroMet — Cartas y Alertas. Acento azul (--blue).
   Arquitectura intacta: App.registrar / App.api / App.tarea / App.aviso /
   App.modalTarea. Reconstruido FIEL al bloque data-screen-label="Cartas y
   Alertas" del diseño (Diseño/HANDOFF/diseno/HidroMet.dc.html) con DATOS REALES:
   · /cartas/productos            → árbol tipo→variable→período→{fuentes,instantes}
   · /cartas/carta.png            → imagen real (matplotlib) por archivo+capa+record
   · /cartas/alertas_programa     → métricas y series de desempeño causal
   · /cartas/umbrales_fijos       → editor Fijos/ZPH (GET/POST)
   · /cartas/actualizar           → tarea de regeneración (botón oscuro)
   Las cartas NO se dibujan a mano: son <img src="/api/cartas/carta.png?...">.
   ============================================================ */
"use strict";

(() => {
  const esc = v => String(v ?? "").replace(/[&<>"']/g,
    c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const api = (r) => "/api" + r;                       // ruta directa para <img src>
  // TÁCTIL: en pantallas de puntero grueso (teléfonos/tablets) las cartas se renderizan
  // ESTÁTICAS (Plotly no captura el toque) → un dedo NO hace pan/deforma el mapa (la página se
  // desplaza normal) y el zoom es el PELLIZCO NATIVO del navegador (dos dedos, sin deformar).
  const TOUCH_COARSE = !!(window.matchMedia && window.matchMedia("(pointer: coarse)").matches);
  const qs = (o) => Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");

  /* ---------- TIPOS (orden EXACTO del diseño) ----------
     id  = id del tipo en /cartas/productos (alertas mapeado).
     cuerpo: "alertas" | "grid". */
  const TIPOS = [
    { id: "pronostico",   etiqueta: "Pronóstico",            cuerpo: "grid" },
    { id: "calibrado",    etiqueta: "Calibrado",             cuerpo: "grid" },
    { id: "hidro",        etiqueta: "Hidroestimadores",      cuerpo: "grid" },
    { id: "alertas",      etiqueta: "⚠ Alertas", danger: true, cuerpo: "alertas" },
    { id: "heladas",      etiqueta: "Heladas / Calor",       cuerpo: "grid" },
    { id: "ffgs",         etiqueta: "FFGS",                  cuerpo: "grid" },
  ];

  /* ---------- ETIQUETAS HUMANAS (centralizado) ----------
     El árbol de productos trae `etiqueta` humana para casi todo, pero algunas
     variables nuevas del escaneo (p.ej. temperatura_2m_max nativa de pronóstico)
     caen al ID crudo — y el dueño lo vio en el selector de Variable, en la
     cabecera de las cartas y en el título de la serie. Diccionario ÚNICO:
     cualquier sitio que muestre un nombre de variable pasa por aquí. */
  const ETIQUETAS_VAR = {
    lluvia: "Precipitación (mm)",
    lluvia_acumulada: "Lluvia acumulada 7-7 (mm)",
    lluvia_acumulada_corrida: "Precipitación acumulada (mm)",
    temperatura_2m: "Temperatura 2 m (°C)",
    temperatura_2m_max: "Temperatura máxima (°C)",
    temperatura_2m_min: "Temperatura mínima (°C)",
    temperatura_2m_mean: "Temperatura media (°C)",
    cape: "CAPE (J/kg)",
    cape_max: "CAPE máximo (J/kg)",
  };
  // Etiqueta para un ID de variable. Prefiere la del árbol SI no es el propio ID
  // crudo; luego el diccionario; luego humedad_*hPa*; último recurso: sin "_".
  function etiquetaVar(id, etiquetaArbol) {
    const cruda = String(id || "");
    if (etiquetaArbol && etiquetaArbol !== cruda) return etiquetaArbol;
    if (ETIQUETAS_VAR[cruda]) return ETIQUETAS_VAR[cruda];
    const m = /^humedad_(\d+)hPa(_max)?$/.exec(cruda);
    if (m) return `Humedad ${m[1]} hPa${m[2] ? " máxima" : ""} (%)`;
    return cruda.replace(/_/g, " ");
  }
  // Versión CORTA (sin unidades) para cabeceras compactas de carta.
  const etiquetaVarCorta = (id, et) => etiquetaVar(id, et).replace(/\s*\([^)]*\)\s*$/, "");
  // Reemplaza IDs crudos incrustados en un texto ya compuesto (p.ej. el figcap
  // "temperatura_2m_max · 6 h" que arma el backend) por su etiqueta corta.
  function humanizarTexto(s) {
    let t = String(s || "");
    // claves más LARGAS primero (temperatura_2m_max antes que temperatura_2m) y
    // con borde de palabra: no toca prosa que contenga la clave como fragmento.
    const claves = Object.keys(ETIQUETAS_VAR).sort((a, b) => b.length - a.length);
    for (const k of claves)
      t = t.replace(new RegExp(`\\b${k}\\b`, "g"), etiquetaVarCorta(k));
    return t.replace(/\bhumedad_(\d+)hPa(_max)?\b/g, (_, p, mx) => `Humedad ${p} hPa${mx ? " máxima" : ""}`);
  }

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
  const ALERTA_FUENTE_OCULTA = new Set(["Confianza", "Modelo de referencia", "Cobertura (n.º modelos)"]);

  // Toggles de capa: id (param de carta.png) + etiqueta + valor inicial (1=on).
  // §P4: Grilla/Isolíneas/Galápagos/Estaciones arrancan ACTIVOS en todas las cartas.
  const TOGGLES = [
    { id: "titulo", et: "Título", on: 1 }, { id: "escala", et: "Escala", on: 1 },
    { id: "galapagos", et: "Galápagos", on: 1 }, { id: "interpolar", et: "Interpolar", on: 1 },
    { id: "isolineas", et: "Isolíneas", on: 1 }, { id: "grilla", et: "Grilla", on: 1 },
    { id: "estaciones", et: "Estaciones", on: 1 },
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

  /* §P14 — la "dinámica" (◀ ▶ / cambio rápido de instante) se trababa por DOS causas:
     (1) CARRERA de requests: cada re-render lanzaba su tanda de carta_datos y las
         respuestas tardías de un render VIEJO seguían pintando (o compitiendo) sobre
         el DOM nuevo; (2) SIN caché: volver a un instante ya visto re-pedía y
         re-montaba todo. Remedios: token de GENERACIÓN por tanda de montaje (una
         tanda nueva invalida las anteriores), caché LRU de las respuestas de
         carta_datos (records ya vistos pintan al instante) y botones de navegación
         DESHABILITADOS mientras la tanda carga. */
  let _genMapas = 0;                          // generación vigente del montaje de mapas
  const _cacheDatos = new Map();              // url -> respuesta de carta_datos (LRU)
  const _CACHE_DATOS_MAX = 60;
  function limpiarCacheDatos() {
    _cacheDatos.clear();
    _ffrFechas = null; _ffrEstado = "desconocido"; _ffrZonas.clear();
    _hvDatos = null;                          // §P9: resumen de validación hidro
  }
  async function apiDatosCarta(url) {
    if (_cacheDatos.has(url)) {
      const v = _cacheDatos.get(url);
      _cacheDatos.delete(url); _cacheDatos.set(url, v);   // refresca posición LRU
      return v;
    }
    const d = await App.api(url);
    _cacheDatos.set(url, d);
    while (_cacheDatos.size > _CACHE_DATOS_MAX) _cacheDatos.delete(_cacheDatos.keys().next().value);
    return d;
  }
  // Tipos cuyo lienzo es PAPEL FIJO (blanco SIEMPRE): las pestañas grilladas del
  // módulo Pronóstico. El resto (alertas de Advertencias, FFGS bajo Hidrología y
  // los mapas de cruce/FFR/crecida) TEMATIZA: claro = papel blanco + contorno negro;
  // oscuro = fondo del tema + contorno claro con halo oscuro.
  // Papel BLANCO fijo SOLO para pronóstico / calibrado / hidroestimadores (mapas de campo
  // denso). El resto —heladas/calor, alertas, FFGS, cruce/FFR— TEMATIZA: en oscuro el mar
  // fuera de Ecuador toma el fondo del tema, no blanco (pedido del usuario).
  const TIPOS_PAPEL_FIJO = new Set(["pronostico", "calibrado", "hidro"]);
  const papelFijo = () => !!(E && TIPOS_PAPEL_FIJO.has(E.tipo));
  const temaOscuro = () => !!(App.tema && App.tema() === "oscuro");

  // Contorno de Ecuador (provincias) con ENCASILLADO: halo ancho debajo + línea más
  // fina encima → resalta y se identifica sobre cualquier carta. `bbox` opcional
  // filtra features por extensión (p.ej. solo Galápagos para el inset).
  function trazasOutline(ejeX, ejeY, bbox, wBlack, wWhite, fijo) {
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
    // fijo=true (módulo Pronóstico): halo blanco + línea NEGRA SIEMPRE (papel de carta).
    // fijo=false (resto): en claro igual; en OSCURO halo del fondo + línea clara para
    // que el contorno se lea sobre el mar oscuro del tema. Los meta permiten forzar
    // la paleta de papel al exportar el PNG (ver _trazasAPapel).
    const osc = !fijo && temaOscuro();
    return [
      Object.assign({}, base, { meta: "outline-halo",
        line: { color: osc ? "#0B1322" : "#ffffff", width: wWhite || 3.4 } }),
      Object.assign({}, base, { meta: "outline-linea",
        line: { color: osc ? "#AEBBD0" : "#000000", width: wBlack || 2 } }),
    ];
  }

  // MÁSCARA al polígono de Ecuador: recorta el campo ráster (celdas 0.1° dentadas) al
  // contorno del país. Antes, con las cartas TEMATIZADAS (fondo oscuro), el ráster sobresalía
  // del contorno en bloques cuadrados feos; recortándolo al polígono el campo queda limpio y
  // el mar del tema se ve suave alrededor. Se cachea por firma de la malla (constante) → el
  // point-in-polygon (ray casting) corre UNA vez por resolución.
  let _mascaraCache = { sig: null, mask: null };
  function mascaraEcuador(lon, lat) {
    if (!geoCartas || !geoCartas.features || !lon || !lat) return null;
    const sig = `${lon.length}x${lat.length}:${lon[0]},${lat[0]},${lon[lon.length - 1]},${lat[lat.length - 1]}`;
    if (_mascaraCache.sig === sig) return _mascaraCache.mask;
    const anillos = [];
    for (const f of geoCartas.features) {
      const g = f.geometry; if (!g) continue;
      if (g.type === "Polygon") anillos.push(g.coordinates[0]);
      else if (g.type === "MultiPolygon") g.coordinates.forEach(p => anillos.push(p[0]));
    }
    const dentro = (x, y) => {
      for (const r of anillos) {
        let c = false;
        for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
          const yi = r[i][1], yj = r[j][1];
          if (((yi > y) !== (yj > y)) && (x < (r[j][0] - r[i][0]) * (y - yi) / (yj - yi) + r[i][0])) c = !c;
        }
        if (c) return true;
      }
      return false;
    };
    const mask = lat.map(y => lon.map(x => dentro(x, y)));
    _mascaraCache = { sig, mask };
    return mask;
  }

  /* §P18a — INDICADOR DE SUSCEPTIBILIDAD FFR como overlay sobre las cartas de alerta
     de PRECIPITACIÓN (nunca temperatura). Ya no son una carta aparte: se dibujan
     punteadas y discretas sobre cada mapa de alerta de lluvia cuya FECHA tenga
     zona FFR. Fechas y anillos se cachean (una petición por sesión / por record). */
  const FFR_BUFFER = "ambos";
  let _ffrFechas = null;                      // [{record, fecha}] | false
  let _ffrEstado = "desconocido";             // disponible | sin_dato | error
  const _ffrZonas = new Map();                // record -> {anillos, color} | false
  async function asegurarFFRFechas() {
    if (_ffrFechas !== null) return;
    try {
      const r = await App.api("/cartas/riesgo_ffr/fechas");
      _ffrFechas = Array.isArray(r.fechas) ? r.fechas : [];
      _ffrEstado = r.estado_dato || (_ffrFechas.length ? "disponible" : "sin_dato");
    } catch (e) { _ffrFechas = false; _ffrEstado = "error"; }
  }
  // Fecha local (GMT-5) ISO de un epoch en segundos — para casar carta ↔ zona FFR.
  const fechaLocalISO = ts => new Date((ts - 5 * 3600) * 1000).toISOString().slice(0, 10);
  async function trazasFFRSobreCarta(fecha) {
    await asegurarFFRFechas();
    if (!_ffrFechas || !_ffrFechas.length) return null;
    const hit = _ffrFechas.find(f => String(f.fecha) === String(fecha));
    if (!hit) return null;                    // el FFR no cubre esta fecha → sin overlay (honesto)
    const rec = hit.record;
    if (!_ffrZonas.has(rec)) {
      try {
        const d = await App.api("/cartas/riesgo_ffr/datos?" + qs({ buffer: FFR_BUFFER, record: rec }));
        _ffrZonas.set(rec, (d && d.anillos && d.anillos.length) ? d : false);
      } catch (e) { _ffrZonas.set(rec, false); }
    }
    const d = _ffrZonas.get(rec);
    if (!d) return null;
    const xs = [], ys = [];
    for (const an of d.anillos) { for (const [lo, la] of an) { xs.push(lo); ys.push(la); } xs.push(null); ys.push(null); }
    if (!xs.length) return null;
    const col = d.color || "#009AF2";
    const c = _hexRgb(col);
    return [{
      type: "scatter", mode: "lines", x: xs, y: ys, fill: "toself", meta: "ffr-overlay",
      fillcolor: `rgba(${c[0]},${c[1]},${c[2]},.14)`,
      line: { color: col, width: 1.2, dash: "dot" },
      name: "Indicador de susceptibilidad FFR", hoverinfo: "skip", showlegend: false,
    }];
  }

  // Microcuencas operativas del FFGS (NWSAFFGS, 1682 subcuencas): contorno que se
  // dibuja sobre las cartas FFGS para ver el dato por subcuenca.
  let geoMicro = null;                         // FeatureCollection microcuencas (cache)
  async function asegurarMicrocuencas() {
    if (geoMicro !== null) return;
    try { geoMicro = await App.api("/datos/capas/ffgs_microcuencas.geojson"); }
    catch (e) { geoMicro = false; }
  }
  function trazaMicrocuencas(osc) {
    if (!geoMicro || !geoMicro.features) return null;
    const xs = [], ys = [];
    const empuja = ring => { for (const [lo, la] of ring) { xs.push(lo); ys.push(la); } xs.push(null); ys.push(null); };
    for (const f of geoMicro.features) {
      const g = f.geometry; if (!g) continue;
      if (g.type === "Polygon") g.coordinates.forEach(empuja);
      else if (g.type === "MultiPolygon") g.coordinates.forEach(p => p.forEach(empuja));
    }
    if (!xs.length) return null;
    // scatter SVG, NO scattergl: Plotly pinta los trazos WebGL en un canvas que queda
    // SIEMPRE DEBAJO de la capa SVG (fills por banda, heatmap, contorno), así que con
    // scattergl las microcuencas quedaban tapadas por el campo opaco y no se veían.
    // Son ~39k vértices en una sola traza de líneas: SVG las dibuja sin lag y respeta
    // el orden del array (sobre el campo, bajo el contorno provincial). Línea fina
    // y tenue para que el COLOR del campo siga siendo lo dominante. FFGS es TEMÁTICO:
    // trazo oscuro sobre papel claro, claro sobre el fondo oscuro del tema.
    return { type: "scatter", mode: "lines", x: xs, y: ys, hoverinfo: "skip", meta: "microcuencas",
      line: { color: osc ? "rgba(174,187,208,.38)" : "rgba(35,49,77,.32)", width: 0.6 },
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
  // §P4: índice del valor más cercano en un eje (lat o lon) — para muestrear el campo.
  function _idxCercano(eje, v) {
    let best = 0, bd = Infinity;
    for (let i = 0; i < eje.length; i++) { const d = Math.abs(eje[i] - v); if (d < bd) { bd = d; best = i; } }
    return best;
  }
  // §P4 hover RICO: "CÓDIGO · Nombre · valor unidad". `muestra` = {lon, lat, campo, fmt}
  // (la malla YA cargada de la carta); el valor se toma de la celda más cercana a la
  // estación en el CLIENTE (sin peticiones extra) y fmt lo formatea con su unidad (o la
  // etiqueta de nivel en cartas categóricas).
  function trazaEstaciones(bbox, ejeX, ejeY, osc, muestra) {
    if (!Array.isArray(_estaciones) || !_estaciones.length) return null;
    const conMalla = !!(muestra && Array.isArray(muestra.lon) && muestra.lon.length
      && Array.isArray(muestra.lat) && muestra.lat.length
      && Array.isArray(muestra.campo) && muestra.campo.length);
    const xs = [], ys = [], cd = [];
    for (const e of _estaciones) {
      if (e.lon == null || e.lat == null) continue;
      if (e.lon < bbox[0] || e.lon > bbox[1] || e.lat < bbox[2] || e.lat > bbox[3]) continue;
      let val = "sin dato";
      if (conMalla) {
        const j = _idxCercano(muestra.lat, e.lat), i = _idxCercano(muestra.lon, e.lon);
        const v = (muestra.campo[j] || [])[i];
        if (v != null && isFinite(v)) val = muestra.fmt ? muestra.fmt(v) : String(v);
      }
      xs.push(e.lon); ys.push(e.lat);
      cd.push([String(e.codigo || e.cod || e.id || ""), String(e.nombre || ""), val]);
    }
    if (!xs.length) return null;
    // osc solo en mapas TEMÁTICOS en tema oscuro (punto claro con halo oscuro).
    return { type: "scatter", mode: "markers", x: xs, y: ys, customdata: cd, xaxis: ejeX, yaxis: ejeY, meta: "estaciones-ct",
      marker: { size: 5, color: osc ? "#E8EDF6" : "#10233F", line: { width: 1, color: osc ? "#0B1322" : "#fff" } },
      hovertemplate: "<b>%{customdata[0]}</b> · %{customdata[1]} · <b>%{customdata[2]}</b><extra></extra>", showlegend: false };
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
      traces.push({ type: "scatter", mode: "lines", x: grisX, y: grisY, fill: "toself",
        fillcolor: "rgba(176,186,201,.55)",
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
    // scatter SVG (markers transparentes, solo hover): sin trazas WebGL en las cartas.
    // Con scattergl cada panel abría un contexto WebGL y el navegador los limita (~16):
    // en la grilla FFGS los contextos viejos se perdían y esas trazas desaparecían.
    return { type: "scatter", mode: "markers", x: hx, y: hy, text: ht,
      marker: { size: 13, color: "rgba(0,0,0,0)" },
      hovertemplate: "%{text}<extra></extra>",
      hoverlabel: { bgcolor: oscuro ? "#0B1322" : "#ffffff", bordercolor: oscuro ? "#46597A" : "#c7cfdb",
        font: { color: oscuro ? "#fff" : "#1c2433", size: 11 } },
      showlegend: false };
  }

  // Parámetros de DATOS de carta_datos (lo que carta.png necesita salvo toggles).
  function baseParams(params) {
    const b = { archivo: params.archivo, capa: params.capa, record: params.record };
    if (params.corrido) b.corrido = params.corrido;
    if (params.fin !== undefined && params.fin !== null && params.fin !== "") b.fin = params.fin;
    for (const k of ["esperado_inicio", "esperado_fin",
                     "esperado_registro_inicio", "esperado_registro_fin"]) {
      if (params[k] !== undefined && params[k] !== null && params[k] !== "") b[k] = params[k];
    }
    // Variante ZPH en el VISOR: el exportador congela las capas de alerta de lluvia
    // también con &modo=zph; con modo fija se pide SIN el parámetro (compatibilidad
    // con los productos ya congelados sin modo).
    if (params.modo && params.modo !== "fija") b.modo = params.modo;
    return b;
  }

  const FFGS_SHP_AVAILABILITY_SCHEMA = "hidromet.ffgs-shp-availability.v1";

  // Contrato de artefactos FFGS congelados en el visor. La presencia del schema
  // nuevo cambia el comportamiento a fail-closed: un contrato mal formado no
  // puede habilitar por accidente un ZIP distinto del (archivo, record) mostrado.
  // Los catálogos antiguos (sin este schema) conservan el fallback histórico.
  function contratoShpFFGS(productos) {
    const raw = productos && productos.disponibilidad && productos.disponibilidad.ffgs_shp;
    if (!raw || raw.schema !== FFGS_SHP_AVAILABILITY_SCHEMA) return null;
    const identidad = raw.identity;
    const valido = (raw.mode === "all" || raw.mode === "selected")
      && Array.isArray(identidad) && identidad.length === 2
      && identidad[0] === "archivo" && identidad[1] === "record"
      && raw.available_by_file && typeof raw.available_by_file === "object"
      && !Array.isArray(raw.available_by_file);
    return { raw, valido };
  }

  function shpFFGSDisponible(productos, archivo, record, esVisor) {
    // En escritorio el backend genera el SHP dinámicamente. En un build legacy
    // del visor no existe inventario y se conserva el intento al ZIP histórico.
    if (!esVisor) return true;
    const contrato = contratoShpFFGS(productos);
    if (!contrato) return true;
    if (!contrato.valido || !Number.isSafeInteger(record)) return false;
    const entrada = contrato.raw.available_by_file[String(archivo || "")];
    return !!(entrada && Array.isArray(entrada.records)
      && entrada.records.some(r => Number.isSafeInteger(r) && r === record));
  }

  function botonShpFFGS(params, productos, esVisor) {
    const record = params && params.record;
    const archivo = params && params.archivo;
    const disponible = shpFFGSDisponible(productos, archivo, record, esVisor);
    if (!disponible) {
      return `<a class="ct-dl ct-dl-shp" role="button" tabindex="-1" aria-disabled="true"
        title="Shapefile no publicado para este producto y ciclo" aria-label="Shapefile no disponible">SHP</a>`;
    }
    const query = { archivo, record };
    // La referencia esperada permite verificar el ciclo en el endpoint vivo. El
    // mapeo del visor la elimina del slug, por lo que el artefacto público sigue
    // identificado exclusivamente por archivo+record.
    if (Number.isSafeInteger(params.reference_time))
      query.esperado_reference_time = params.reference_time;
    const ruta = "/cartas/ffgs_shp?" + qs(query);
    return `<a class="ct-dl ct-dl-shp" role="button" tabindex="0" data-shp="${esc(ruta)}"
      title="Descargar en formato shapefile" aria-label="Descargar en formato shapefile">SHP</a>`;
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
      : "";
    const shpBtn = esFFGS
      ? botonShpFFGS(params, E && E.productos, !!window.HIDROMET_VISOR)
      : esAlertaNivel
      ? `<a class="ct-dl ct-dl-shp" role="button" tabindex="0" data-shp="${esc(shpRuta)}"
           title="Descargar en formato shapefile" aria-label="Descargar en formato shapefile">SHP</a>`
      : "";
    // §P18a: data-ffr = fecha (ISO) de la carta cuando es ALERTA DE LLUVIA → el
    // overlay del indicador de susceptibilidad FFR se dibuja encima en pintarMapaCarta.
    const ffrAttr = params.ffr ? ` data-ffr="${esc(params.ffr)}"` : "";
    return `
      <div class="ct-lienzo${papelFijo() ? " ct-lienzo-fijo" : ""}" data-datos="${esc(datosUrl)}"${ffrAttr}>
        <a class="ct-dl ct-dl-jpg" role="button" tabindex="0" data-jpg="${esc(jpgRuta)}" data-nombre="${esc(slugNombre)}"
           title="Descargar carta (imagen)" aria-label="Descargar carta">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/></svg>
        </a>${shpBtn}
        <div class="cargando mono">Cargando mapa…</div>
        <div class="ct-mapa-plot"></div>
        <div class="ct-zoomhint mono">Pellizca o Ctrl + rueda para acercar</div>
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
    // §P14: cada tanda de montaje toma una GENERACIÓN nueva; las tandas anteriores
    // (aún esperando red) quedan invalidadas y no pisan el estado. Mientras la
    // tanda carga, los botones ◀ ▶ del contenedor se deshabilitan (el selector de
    // instante sigue activo: elegir en él re-renderiza y abre otra generación).
    const gen = ++_genMapas;
    const navs = [...cont.querySelectorAll(".ct-nav")];
    const previos = navs.map(b => b.disabled);
    navs.forEach(b => { b.disabled = true; });
    try {
      for (const div of [...cont.querySelectorAll(".ct-lienzo[data-datos]")]) {
        if (gen !== _genMapas) return;        // llegó una tanda más nueva: abortar
        if (div._montado) continue;
        div._montado = true;
        await pintarMapaCarta(div, div.dataset.datos, gen);
        await new Promise(r => setTimeout(r));
      }
    } finally {
      if (gen === _genMapas) navs.forEach((b, i) => { if (b.isConnected) b.disabled = previos[i]; });
    }
  }

  // §pixelado (2026-07): el VISOR congela la malla DECIMADA ×2 (71×66 ≈ 0.1°) para
  // no disparar el peso (DEC=1 cuadruplica los ~500 MB de cartas congeladas: medido
  // 48→179 KB por carta). A ese paso, el suavizado del heatmap (zsmooth "best"
  // mezcla colores SOLO entre celdas vecinas) deja escalones cuadrados visibles en
  // los bordes de banda. Antes de pintar se REFINA la malla EN EL CLIENTE (bilineal
  // ×2/×3 hasta paso ≤0.06°): recupera la suavidad de la app viva (0.05°, refinado
  // bicúbico ×5 del backend en carta_datos) sin aumentar un KB el peso publicado.
  // En la app viva el paso ya es fino → factor 1 (no toca nada). No aplica a mallas
  // por celda (FFGS, d.malla) ni a campos vacíos. Las esquinas null (máscara del
  // contorno) entran como promedio ponderado de las finitas → el borde queda suave.
  function refinarMalla(P) {
    const lon = P && P.lon, lat = P && P.lat, z = P && P.campo;
    if (!Array.isArray(lon) || lon.length < 2 || !Array.isArray(lat) || lat.length < 2
        || !Array.isArray(z) || z.length < 2 || !Array.isArray(z[0]) || z[0].length < 2) return P;
    const paso = Math.abs(lon[1] - lon[0]);
    // Visor: malla decimada ×2 (~0.10°). Se re-refina a ~0.033° (f≈3) con interpolación
    // BICÚBICA (Catmull-Rom), no bilineal: recupera la curvatura del bicúbico ×5 del
    // backend que la decimación descartó → sin escalones en los bordes de banda, +0 KB
    // de peso. App viva (paso ya ~0.05°) → f=1: no toca nada.
    const f = paso > 0.06 ? Math.min(4, Math.max(2, Math.round(paso / 0.03))) : 1;
    if (f <= 1) return P;
    const eje = (a) => {
      const out = new Array((a.length - 1) * f + 1);
      for (let i = 0; i < a.length - 1; i++)
        for (let k = 0; k < f; k++) out[i * f + k] = a[i] + (a[i + 1] - a[i]) * (k / f);
      out[out.length - 1] = a[a.length - 1];
      return out;
    };
    const ny = z.length, nx = z[0].length;
    const NY = (ny - 1) * f + 1, NX = (nx - 1) * f + 1;
    const at = (j, i) => {                    // acceso con índices recortados al borde
      j = j < 0 ? 0 : (j > ny - 1 ? ny - 1 : j);
      i = i < 0 ? 0 : (i > nx - 1 ? nx - 1 : i);
      const v = z[j][i]; return (v == null || !isFinite(v)) ? NaN : v;
    };
    const cr = (a, b, c, d, t) =>             // núcleo Catmull-Rom 1D
      0.5 * ((2 * b) + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t * t
             + (-a + 3 * b - 3 * c + d) * t * t * t);
    const campo = new Array(NY);
    for (let J = 0; J < NY; J++) {
      const j = Math.min(Math.floor(J / f), ny - 2), ty = J / f - j;
      const fila = new Array(NX);
      for (let I = 0; I < NX; I++) {
        const i = Math.min(Math.floor(I / f), nx - 2), tx = I / f - i;
        // Un solo barrido del entorno 4×4: detecta máscara (NaN) y toma min/max locales.
        let hueco = false, lmin = Infinity, lmax = -Infinity;
        for (let dj = -1; dj <= 2; dj++)
          for (let di = -1; di <= 2; di++) {
            const v = at(j + dj, i + di);
            if (isNaN(v)) { hueco = true; }
            else { if (v < lmin) lmin = v; if (v > lmax) lmax = v; }
          }
        if (hueco) {                          // borde tierra-mar: bilineal de las 4 esquinas
          let s = 0, w = 0, v;                // (conserva la máscara, sin ringing hacia el mar)
          v = at(j, i);         if (!isNaN(v)) { const k = (1 - tx) * (1 - ty); s += v * k; w += k; }
          v = at(j, i + 1);     if (!isNaN(v)) { const k = tx * (1 - ty);       s += v * k; w += k; }
          v = at(j + 1, i);     if (!isNaN(v)) { const k = (1 - tx) * ty;       s += v * k; w += k; }
          v = at(j + 1, i + 1); if (!isNaN(v)) { const k = tx * ty;             s += v * k; w += k; }
          fila[I] = w > 0.05 ? s / w : null;
        } else {                              // interior liso: bicúbico Catmull-Rom 2D
          const c0 = cr(at(j - 1, i - 1), at(j - 1, i), at(j - 1, i + 1), at(j - 1, i + 2), tx);
          const c1 = cr(at(j,     i - 1), at(j,     i), at(j,     i + 1), at(j,     i + 2), tx);
          const c2 = cr(at(j + 1, i - 1), at(j + 1, i), at(j + 1, i + 1), at(j + 1, i + 2), tx);
          const c3 = cr(at(j + 2, i - 1), at(j + 2, i), at(j + 2, i + 1), at(j + 2, i + 2), tx);
          let v = cr(c0, c1, c2, c3, ty);
          fila[I] = v < lmin ? lmin : (v > lmax ? lmax : v);   // clamp anti-ringing
        }
      }
      campo[J] = fila;
    }
    return { lon: eje(lon), lat: eje(lat), campo: campo };
  }

  // §P2 (franja blanca): el range de los ejes NUNCA debe rebasar la cobertura REAL del
  // heatmap (centro de celda extremo ± media celda). En el visor, la malla decimada ×2
  // podía perder la última columna/fila y la "extensión" oficial (bordes de celda de la
  // malla COMPLETA) dejaba una franja sin datos en el borde derecho/inferior. Se recorta
  // el marco a la INTERSECCIÓN extensión ∩ cobertura → el campo toca siempre el lienzo.
  function rangoCubierto(ext, malla) {
    const lon = malla && malla.lon, lat = malla && malla.lat;
    if (!Array.isArray(lon) || lon.length < 2 || !Array.isArray(lat) || lat.length < 2) return ext.slice();
    const cob = a => {                       // [min, max] cubiertos por las celdas (admite eje descendente)
      const n = a.length, asc = a[0] <= a[n - 1];
      const dIni = Math.abs(a[1] - a[0]) / 2, dFin = Math.abs(a[n - 1] - a[n - 2]) / 2;
      const lo = Math.min(a[0], a[n - 1]), hi = Math.max(a[0], a[n - 1]);
      return [lo - (asc ? dIni : dFin), hi + (asc ? dFin : dIni)];
    };
    const cx = cob(lon), cy = cob(lat);
    const x0 = Math.max(ext[0], cx[0]), x1 = Math.min(ext[1], cx[1]);
    const y0 = Math.max(ext[2], cy[0]), y1 = Math.min(ext[3], cy[1]);
    return (x0 < x1 && y0 < y1) ? [x0, x1, y0, y1] : ext.slice();
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

  async function pintarMapaCarta(div, datosUrl, gen) {
    // §P14: la traza solo sigue viva si el div sigue en el DOM y NINGUNA tanda de
    // montaje más nueva ha arrancado (gen === _genMapas). Sin el token, respuestas
    // tardías de un render viejo pintaban sobre el nuevo (la "dinámica se traba").
    const vivo = () => div.isConnected && (gen === undefined || gen === _genMapas);
    let d;
    try { d = await apiDatosCarta(datosUrl); }
    catch (e) { if (vivo()) falloLienzo(div, "Sin carta para este instante"); return; }
    if (!vivo()) return;
    const P = d.principal || d;
    const hayCuencas = !!(d.cuencas && d.cuencas.ids && d.cuencas.ids.length);
    if ((!P || !P.campo || !P.campo.length) && !hayCuencas) { falloLienzo(div, "Sin datos para este instante"); return; }
    await asegurarGeoCartas();
    if (!window.Plotly) { falloLienzo(div, "Plotly no disponible"); return; }
    if (!vivo()) return;

    const ext = P.extension || d.extension || [-81.3, -75.0, -5.1, 1.6];
    const cap = (E && E.capas) || {};
    // Módulo Pronóstico = papel blanco SIEMPRE (fijo); alertas y FFGS tematizan.
    const fijo = papelFijo();
    const oscuro = !fijo && temaOscuro();
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
    // Malla refinada en cliente (§pixelado): en el visor sube 71×66 → 141×131;
    // en la app viva ya viene fina (0.05°) y refinarMalla devuelve la misma.
    const PR = (!d.malla && P && P.campo && P.campo.length) ? refinarMalla(P) : P;
    // §P4: etiqueta de nivel (cartas categóricas) y formateador "valor unidad" — se usan
    // en el hover del heatmap (principal y Galápagos) y en el de las ESTACIONES.
    const etiq = etiquetasCarta(d);
    const _fmtVal = v => etiq
      ? (etiq(v) || "")
      : `${Math.abs(v) < 10 ? (+v).toFixed(2) : (+v).toFixed(1)} ${d.unidad || ""}`.trim();
    if (!cuencasOk) {
      // Raster: cartas INTERPOLADAS (precip/temp/ALERTAS) suavizadas.
      // Continuo (precip/temp/HR/CAPE) Y alertas/heladas (campo YA refinado en backend
      // y re-refinado aquí si venía decimado, escala de color en degradado) → suavizado
      // de ALTA CALIDAD ("best": suave, sin bloques).
      // FFGS (d.malla): lo NÍTIDO es el relleno vectorial por subcuenca de arriba; si ese
      // falló (cuencasOk=false) llegamos a este raster de RESPALDO → también lo suavizamos,
      // porque pintarlo con zsmooth:false son los cuadrados duros 0.10° (el pixelado real).
      const suavizar = "best";
      const hov = etiq                  // alertas/riesgo → etiqueta de nivel en el popup
        ? { text: PR.campo.map(row => (row || []).map(v => etiq(v) || "")),
            hovertemplate: `%{y:.2f}°, %{x:.2f}°<br><b>%{text}</b><extra></extra>` }
        : { hovertemplate: `%{y:.2f}°, %{x:.2f}°<br><b>%{z:.2f} ${esc(d.unidad || "")}</b><extra></extra>` };
      // Recorte al polígono de Ecuador SOLO en cartas TEMATIZADAS (heladas/alertas): sin esto
      // el ráster 0.1° sobresale del contorno en bloques cuadrados feos sobre el fondo oscuro.
      let _zCampo = PR.campo;
      if (!fijo) {
        const _mk = mascaraEcuador(PR.lon, PR.lat);
        if (_mk) _zCampo = PR.campo.map((row, i) => (row || []).map((v, j) => (_mk[i] && _mk[i][j]) ? v : null));
      }
      traces.push(Object.assign({
        type: "heatmap", x: PR.lon, y: PR.lat, z: _zCampo,
        colorscale: d.colorscale, zmin: d.vmin, zmax: d.vmax,
        zsmooth: suavizar, hoverongaps: false, showscale: false,
      }, hov));
    }
    // TOGGLE Isolíneas: contornos sobre el campo (aplican a las cartas raster CONTINUAS:
    // pronóstico, calibrado, hidroestimadores, heladas/calor). Traza encima del relleno,
    // sin color (solo líneas) y con etiqueta de valor. §P16: en cartas CATEGÓRICAS
    // (alertas por nivel) los contornos no tienen sentido → nunca se dibujan.
    if (cap.isolineas && !d.categorico && PR && PR.campo && PR.campo.length) {
      traces.push({
        type: "contour", x: PR.lon, y: PR.lat, z: PR.campo,
        contours: { coloring: "none", showlabels: true,
          labelfont: { size: 9, color: oscuro ? "#E2E8F7" : "#283550" } },
        line: { color: oscuro ? "rgba(226,232,247,.72)" : "rgba(40,53,80,.7)", width: 0.9, smoothing: 1 },
        ncontours: 12, showscale: false, hoverinfo: "skip",
      });
    }
    // Contorno de las MICROCUENCAS encima (define los bordes de subcuenca, FFGS).
    if (d.malla) {
      await asegurarMicrocuencas();
      const mc = trazaMicrocuencas(oscuro);
      if (mc) traces.push(mc);
    }
    // §P10: en Heladas/Calor el contorno provincial iba MUY GRUESO y tapaba los
    // colores del riesgo (pedido del dueño) → grosor por-tipo: fino en heladas,
    // el spec de grillas (1.5/3.4) intacto para el resto.
    const esHeladas = !!(E && E.tipo === "heladas");
    traces.push(...trazasOutline("x", "y", null, esHeladas ? 0.8 : 1.5, esHeladas ? 1.8 : 3.4, fijo));
    // §P18a: INDICADOR DE SUSCEPTIBILIDAD FFR sobre alertas de PRECIPITACIÓN
    // (solo lluvia, nunca temperatura): overlay discreto punteado, si el FFR tiene
    // zona para la FECHA de la carta. data-ffr la pone cuerpoAlertas.
    if (div.dataset.ffr) {
      const zf = await trazasFFRSobreCarta(div.dataset.ffr);
      if (!vivo()) return;
      if (zf) traces.push(...zf);
    }

    // §P4: muestra para el hover de estaciones (malla ya cargada + formateador).
    const _muestra = (PR && PR.campo && PR.campo.length)
      ? { lon: PR.lon, lat: PR.lat, campo: PR.campo, fmt: _fmtVal } : null;
    // TOGGLE Estaciones: puntos de las estaciones dentro del recuadro principal.
    if (cap.estaciones) { await asegurarEstaciones(); const te = trazaEstaciones(ext, "x", "y", oscuro, _muestra); if (te) traces.push(te); }

    // §P2: marco = extensión oficial recortada a la cobertura real del heatmap (sin
    // franja blanca en el borde). FFGS vectorial (cuencasOk) conserva la extensión.
    const marco = (!cuencasOk && PR && PR.campo && PR.campo.length) ? rangoCubierto(ext, PR) : ext.slice();
    // Zoom SOLO de acercamiento: minallowed/maxallowed fijan el extent como tope.
    // TOGGLE Grilla: rejilla lat/lon punteada y tenue (ejes ocultos si está apagada).
    const _ejeGr = cap.grilla
      ? { showticklabels: false, showline: false, zeroline: false, ticks: "", showgrid: true,
          gridcolor: oscuro ? "rgba(223,230,247,.13)" : "rgba(70,89,122,.16)", griddash: "dot", dtick: 1 }
      : { visible: false };
    const layout = App.plotlyLayoutBase({
      showlegend: false, margin: { l: 0, r: 0, t: 0, b: 0 },
      xaxis: Object.assign({ range: [marco[0], marco[1]], minallowed: marco[0], maxallowed: marco[1], fixedrange: false }, _ejeGr),
      yaxis: Object.assign({ range: [marco[2], marco[3]], minallowed: marco[2], maxallowed: marco[3], scaleanchor: "x", scaleratio: 1, fixedrange: false }, _ejeGr),
      dragmode: "pan",
    });
    layout.hovermode = "closest";   // hover por cuenca FFGS (y por celda en raster): muestra el valor más cercano

    // TOGGLE Galápagos: inset en la esquina inferior izquierda. Los modelos globales
    // traen d.galapagos (recorte del archipiélago); los regionales no → se omite.
    const _G0 = d.galapagos, _gb = d.bbox_galapagos;
    const _G = (_G0 && _G0.campo && _G0.campo.length && !d.malla) ? refinarMalla(_G0) : _G0;
    if (cap.galapagos && _G && _G.campo && _G.campo.length && _gb) {
      // inset en la ESQUINA INFERIOR DERECHA, separado ~0.5 cm de los márgenes der./inf.
      // §P17: recuadro y título corridos ~2 mm a la DERECHA y ~2 mm hacia ABAJO
      // (paper coords: +0.012 en x, −0.015 en y).
      const gx0 = 0.664, gx1 = 0.964, gy0 = 0.028, gy1 = 0.301;
      // §P2: rango del inset recortado a la cobertura real de SU malla (sin franja).
      const gMarco = rangoCubierto(_gb, _G);
      // §P17: grilla PROPIA del inset — dtick adecuado a la extensión de Galápagos
      // (no heredado del continente). Solo si el toggle Grilla está activo.
      const _gspan = Math.max(gMarco[1] - gMarco[0], gMarco[3] - gMarco[2]);
      const _gdt = _gspan >= 3 ? 1 : (_gspan >= 1.2 ? 0.5 : 0.25);
      const _ejeGrG = cap.grilla
        ? { showticklabels: false, showline: false, zeroline: false, ticks: "", showgrid: true,
            gridcolor: oscuro ? "rgba(223,230,247,.13)" : "rgba(70,89,122,.16)", griddash: "dot", dtick: _gdt }
        : { visible: false };
      layout.xaxis2 = Object.assign({ domain: [gx0, gx1], anchor: "y2", range: [gMarco[0], gMarco[1]], fixedrange: true }, _ejeGrG);
      layout.yaxis2 = Object.assign({ domain: [gy0, gy1], anchor: "x2", range: [gMarco[2], gMarco[3]], scaleanchor: "x2", scaleratio: 1, fixedrange: true }, _ejeGrG);
      // borde del recuadro (rect por encima de todo, siempre visible)
      layout.shapes = (layout.shapes || []).concat([{ type: "rect", xref: "paper", yref: "paper", x0: gx0, y0: gy0, x1: gx1, y1: gy1,
        line: { color: oscuro ? "#B6C0CD" : "#46597A", width: 1.4 }, fillcolor: "rgba(0,0,0,0)", layer: "above" }]);
      layout.annotations = (layout.annotations || []).concat([{ xref: "paper", yref: "paper", x: gx0, y: gy1 + 0.006, xanchor: "left", yanchor: "bottom",
        text: "Galápagos", showarrow: false, font: { size: 9, color: oscuro ? "#9DAABF" : "#58667A" } }]);
      // §P4: hover del inset con la MISMA regla que el principal — etiqueta de nivel en
      // categóricas y "valor unidad" en continuas (la unidad SIEMPRE presente).
      const hovG = etiq
        ? { text: _G.campo.map(row => (row || []).map(v => etiq(v) || "")),
            hovertemplate: `%{y:.2f}°, %{x:.2f}°<br><b>%{text}</b><extra></extra>` }
        : { hovertemplate: `%{y:.2f}°, %{x:.2f}°<br><b>%{z:.2f} ${esc(d.unidad || "")}</b><extra></extra>` };
      traces.push(Object.assign({ type: "heatmap", x: _G.lon, y: _G.lat, z: _G.campo, xaxis: "x2", yaxis: "y2",
        colorscale: d.colorscale, zmin: d.vmin, zmax: d.vmax, zsmooth: d.malla ? false : "best",
        hoverongaps: false, showscale: false }, hovG));
      traces.push(...trazasOutline("x2", "y2", _gb, esHeladas ? 0.6 : 0.9, esHeladas ? 1.2 : 2, fijo));   // contorno de las islas con encasillado (§P10: fino en heladas)
      const _muestraG = { lon: _G.lon, lat: _G.lat, campo: _G.campo, fmt: _fmtVal };
      if (cap.estaciones) { await asegurarEstaciones(); const teg = trazaEstaciones(_gb, "x2", "y2", oscuro, _muestraG); if (teg) traces.push(teg); }
    }
    // Panel VACÍO: rótulo claro en vez de un mapa en blanco. "sin_datos" = el modelo
    // no llega a esta fecha (su corrida no la cubre); "sin_alerta" = sí hay pronóstico
    // pero ninguna celda alcanza nivel Medio.
    if (d.vacio) {
      layout.annotations = (layout.annotations || []).concat([{
        xref: "paper", yref: "paper", x: 0.5, y: 0.5, xanchor: "center", yanchor: "middle",
        text: d.vacio === "sin_datos"
          ? "Fuera del horizonte de este modelo:<br>su corrida aún no cubre esta ventana.<br><i>Se completará con la próxima actualización.</i>"
          : "Con pronóstico, pero sin alertas:<br>ningún punto alcanza el nivel Medio.",
        showarrow: false, align: "center", font: { size: 13, color: oscuro ? "#9DAABF" : "#64748b" },
        bgcolor: oscuro ? "rgba(20,28,45,.78)" : "rgba(255,255,255,.82)", borderpad: 8,
        bordercolor: oscuro ? "rgba(182,192,205,.40)" : "rgba(100,116,139,.32)", borderwidth: 1 }]);
    }
    if (!vivo()) return;                       // §P14: no pintar sobre un render más nuevo
    const c = div.querySelector(".cargando"); if (c) c.remove();
    const plot = div.querySelector(".ct-mapa-plot");
    Plotly.newPlot(plot, traces, layout, App.plotlyConfig({ scrollZoom: !TOUCH_COARSE, staticPlot: TOUCH_COARSE, displayModeBar: false, doubleClick: "reset" }));
    if (App.pinchZoomMapa) App.pinchZoomMapa(plot);   // v17: pinza = zoom del mapa
    // Datos para reconstruir la carta FORMAL al descargar en el VISOR (título + leyenda/
    // colorbar), ya que ahí no hay backend que renderice el PNG formal. En la app se usa
    // el render del servidor. Se guardan en el propio div del plot.
    plot._carta = { titulo: d.titulo, subtitulo: d.subtitulo, unidad: d.unidad,
                    tick_labels: d.tick_labels, tickvals: d.tickvals, vmin: d.vmin, vmax: d.vmax };
    // Zoom con rueda SOLO con Ctrl: sin Ctrl, el evento no llega a Plotly (lo paramos
    // en captura) y la PÁGINA hace scroll normal; con Ctrl, Plotly recibe la rueda y hace zoom.
    // Flag anti-duplicado: el re-montaje por cambio de tema reusa el MISMO nodo.
    if (!plot._wheelHook) {
      plot._wheelHook = true;
      plot.addEventListener("wheel", (e) => { if (!e.ctrlKey && !e.metaKey) e.stopPropagation(); },
        { capture: true, passive: true });
    }

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

  // Purga TODAS las instancias Plotly vivas de la vista (no solo .ct-mapa-plot:
  // también series, cruces, crecidas, FFR y mini-mapas — Plotly engancha listeners
  // de window por instancia y sin purge se acumulan al navegar).
  function purgarCartas() {
    if (!window.Plotly) return;
    document.querySelectorAll("#vista .js-plotly-plot").forEach(el => { try { Plotly.purge(el); } catch (e) { /* ya purgado */ } });
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
    // (1) máxima cobertura de fuentes. (2) Entre los de cobertura máxima, el MÁS CERCANO A
    // HOY: el primero cuya ventana aún no terminó (fin>=ahora), y si todos ya pasaron, el
    // último pasado. Antes, el desempate 'n>=bestN' elegía el ÚLTIMO índice = el más FUTURO
    // (D+3..D+5), lo que abría Pronóstico/Calibrado/Heladas/⚠Alertas en el día equivocado
    // (auditoría 2026-07-10). inst.fin es epoch en segundos.
    let bestN = -1;
    for (const it of insts) {
      const n = Object.keys(it.descriptores || it.registros || {}).length;
      if (n > bestN) bestN = n;
    }
    const ahora = Date.now() / 1000;
    let ultimoConDato = -1;
    for (let i = 0; i < insts.length; i++) {
      if (Object.keys(insts[i].descriptores || insts[i].registros || {}).length < bestN) continue;
      ultimoConDato = i;
      if ((insts[i].fin || 0) >= ahora) return i;   // ventana que cubre ahora o la próxima
    }
    return ultimoConDato >= 0 ? ultimoConDato : insts.length - 1;
  }

  // §menús dinámicos: fuentes ÚNICAS del período (el escaneo puede DUPLICAR una
  // fuente cuando una variable existe nativa Y derivada, p.ej. temperatura_2m_max
  // a 24 h traía GFS/ICON/... dos veces) y DISPONIBILIDAD real por instante:
  // cuántas de las fuentes MOSTRADAS tienen registro en cada instante. Con eso el
  // selector de instantes deshabilita (option disabled + title) las fechas sin
  // ningún dato y anota "n/m" en las incompletas — nadie cae en pantallas vacías.
  function fuentesVista(p, n) {
    const vistos = new Set(), out = [];
    for (const f of (p && p.fuentes) || []) {
      if (!f || !f.fuente || vistos.has(f.fuente)) continue;
      vistos.add(f.fuente); out.push(f);
      if (n && out.length >= n) break;
    }
    return out;
  }

  // Contrato v2: archivo+capa+record+tiempos son una sola unidad por
  // fuente/instante. El fallback al catálogo antiguo se permite únicamente si
  // esa fuente tiene una sola variante; TX/TN 24 h (nativa + agg::) falla
  // cerrado en vez de combinar el descriptor de una con el record de la otra.
  function descriptorCarta(p, it, f) {
    if (!p || !it || !f || !f.fuente) return null;
    const d = it.descriptores && it.descriptores[f.fuente];
    if (d && d.archivo && d.capa && Number.isInteger(Number(d.record)) &&
        d.inicio !== undefined && d.fin !== undefined) return d;
    const variantes = new Set((p.fuentes || [])
      .filter(x => x && x.fuente === f.fuente)
      .map(x => `${x.archivo || ""}\u0000${x.capa || ""}\u0000${x.corrido ? 1 : 0}`));
    if (variantes.size !== 1 || !it.registros || it.registros[f.fuente] === undefined) return null;
    return {
      archivo: (it.archivos && it.archivos[f.fuente]) || f.archivo,
      capa: f.capa, record: it.registros[f.fuente],
      inicio: it.inicio, fin: it.fin,
      corrido: !!f.corrido, objetivo_fin: f.corrido ? it.fin : undefined,
    };
  }

  function paramsDescriptor(d, extra) {
    if (!d) return null;
    const out = Object.assign({
      archivo: d.archivo, capa: d.capa, record: d.record,
      esperado_inicio: d.inicio, esperado_fin: d.fin,
      esperado_registro_inicio: d.registro_inicio,
      esperado_registro_fin: d.registro_fin,
      reference_time: d.reference_time,
    }, extra || {});
    if (d.corrido) {
      out.corrido = 1;
      out.fin = d.objetivo_fin !== undefined ? d.objetivo_fin : d.fin;
    }
    return out;
  }

  const conteoInst = (p, fuentes) =>
    ((p && p.instantes) || []).map(it =>
      fuentes.reduce((s, f) => s + (descriptorCarta(p, it, f) ? 1 : 0), 0));

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

  // Toggles de capa (Grilla/Isolíneas/Galápagos/Estaciones), compartidos por todas las
  // cartas interactivas. El estado vive en E.capas y lo lee pintarMapaCarta.
  // §P16: `sinIsolineas` oculta el toggle Isolíneas en ADVERTENCIAS (niveles categóricos:
  // los contornos no aplican); el resto de toggles se conserva.
  function capasHTML(sinIsolineas) {
    const c = (E && E.capas) || {};
    const b = (id, et) => `<button class="ct-toggle ${c[id] ? "activo" : ""}" data-capa="${id}">${et}</button>`;
    return `<div class="ct-capas">${b("grilla", "Grilla")}${sinIsolineas ? "" : b("isolineas", "Isolíneas")}${b("galapagos", "Galápagos")}${b("estaciones", "Estaciones")}</div>`;
  }

  // §P1: la serie temporal que vivía BAJO la grilla de cartas (pintarSeriePron) se
  // ELIMINÓ por redundante: la pestaña "Series, validación e IA" ya ofrece la
  // comparativa multimodelo por estación. Sus endpoints exclusivos
  // (/cartas/series/estacion y /cartas/series/grilla) se retiraron del backend.
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

    // §menús dinámicos: disponibilidad real por instante sobre las fuentes MOSTRADAS.
    // Si el instante activo quedó sin ninguna (instanteDefecto cuenta TODOS los
    // registros, incluidos los de fuentes fuera del 2×2), salta al mejor con dato.
    const fuentes4 = fuentesVista(p, 4);
    const conteo = conteoInst(p, fuentes4);
    if (!conteo[g.inst]) {
      let best = -1, bn = 0;
      for (let i = 0; i < conteo.length; i++) if (conteo[i] >= bn && conteo[i] > 0) { bn = conteo[i]; best = i; }
      if (best >= 0) g.inst = best;
    }
    const inst = p.instantes[g.inst];
    const figcap = humanizarTexto(p.figcap || "");

    const optsVar = t.variables.map(x => {
      const nInst = (x.periodos || []).reduce((s, pp) => s + ((pp.instantes || []).length), 0);
      const des = nInst === 0 ? ' disabled title="Sin cartas en disco para esta variable"' : "";
      return `<option value="${esc(x.id)}" ${x.id === g.varId ? "selected" : ""}${des}>${esc(etiquetaVar(x.id, x.etiqueta))}</option>`;
    }).join("");
    const optsPer = v.periodos.map(x => {
      const des = !(x.instantes || []).length ? ' disabled title="Sin cartas en disco para este período"' : "";
      return `<option value="${x.horas}" ${x.horas === g.horas ? "selected" : ""}${des}>${esc(x.etiqueta)}</option>`;
    }).join("");
    const optsInst = p.instantes.map((x, i) => {
      const n = conteo[i];
      const des = n === 0 ? ' disabled title="Ningún modelo mostrado tiene dato en este instante"' : "";
      const sufijo = n > 0 && n < fuentes4.length ? ` · ${n}/${fuentes4.length}` : "";
      return `<option value="${i}" ${i === g.inst ? "selected" : ""}${des}>${esc(x.etiqueta)}${sufijo}</option>`;
    }).join("");

    // Grilla 2×2: hasta 4 fuentes ÚNICAS del período (cada una con su capa/archivo).
    const cartas = fuentes4.map(f => {
      const rotuloFuente = tipoId === "hidro"
        ? ({ PDIR: "PERSIANN-PDIR", CCS: "PERSIANN-CCS" }[f.fuente] || f.fuente)
        : f.fuente;
      const metaFuente = tipoId === "hidro" && f.fuente === "CCS"
        ? "Diagnóstico · fuera del consenso"
        : figcap;
      const descriptor = descriptorCarta(p, inst, f);
      if (!descriptor) {
        return `<figure class="ct-carta"><div class="ct-carta-cab"><span class="titulo">${esc(rotuloFuente)}</span>
          <span class="meta">${esc(metaFuente)}</span></div>
          <div class="ct-lienzo"><div class="fallo"><div class="icono">🗺️</div>Sin dato en este instante</div></div></figure>`;
      }
      const params = paramsDescriptor(descriptor);
      // §P3: el nombre de descarga lleva la FECHA del instante (fuente_fecha_producto).
      return `<figure class="ct-carta">
        <div class="ct-carta-cab"><span class="titulo">${esc(rotuloFuente)}</span>
          <span class="meta">${esc(metaFuente)}</span></div>
        ${lienzoCarta(params, rotuloFuente + " · " + fechaLocalISO(inst.inicio) + " · " + figcap)}
        <div class="ct-ley-card" data-rol="ley-card"></div>
      </figure>`;
    }).join("");

    // ◀ ▶ se deshabilitan si NO queda ningún instante CON dato en esa dirección.
    const hayAntes = conteo.slice(0, g.inst).some(n => n > 0);
    const hayDespues = conteo.slice(g.inst + 1).some(n => n > 0);
    return `
      <div class="ct-barra cols compacta">
        <label class="bloque"><span class="et">Variable</span>
          <select data-rol="var">${optsVar}</select></label>
        <label class="bloque"><span class="et">Período</span>
          <select data-rol="per">${optsPer}</select></label>
        <div class="ct-inst-nav">
          <button class="ct-nav" data-rol="prev" ${hayAntes ? "" : "disabled"}>◀</button>
          <select class="ct-instante" data-rol="inst">${optsInst}</select>
          <button class="ct-nav" data-rol="next" ${hayDespues ? "" : "disabled"}>▶</button>
        </div>
        ${capasHTML()}
      </div>
      <div class="ct-grid">${cartas}</div>
      ${tipoId === "hidro" ? htmlValidacionHidro() : ""}`;
  }

  /* ============================================================
     §P9 — VALIDACIÓN DE HIDROESTIMADORES. Una sola figura comparable,
     selector de estación y tabla fuente×ventana. Solo usa estaciones 7-7;
     las 0-24 quedan fuera hasta disponer de un producto con esa ventana.
     ============================================================ */
  const _hvCache = new Map();
  const _hvEstado = { dias: 14, codigo: "" };
  const HV_COLOR = { IMERG: "#4c78a8", PDIR: "#f58518", CCS: "#54a24b" };
  function htmlValidacionHidro() {
    return `
      <div class="ct-panel ct-hv">
        <div class="ct-panel-cab">
          <h3>Validación de hidroestimadores <span class="suave">· estimado grillado vs observación canónica 7-7</span></h3>
          <div class="ct-hv-controles">
            <label><span>Estación</span><select data-rol="hv-estacion"><option value="">Promedio de la red 7-7</option></select></label>
            <label><span>Ventana</span><select data-rol="hv-ventana">
              ${[7, 14, 30, 60].map(d => `<option value="${d}" ${d === _hvEstado.dias ? "selected" : ""}>${d} días</option>`).join("")}
            </select></label>
          </div>
        </div>
        <div class="ct-hv-grid" data-rol="hv-grid"><span class="suave" style="font-size:12px">Cargando validación…</span></div>
        <p class="ct-nota">La serie y las métricas usan la misma ventana física <b>07:00–07:00</b> y la intersección exacta
          de pares estación×día común a todas las fuentes. <b>PERSIANN-CCS es diagnóstico no acreditado</b>: su mapa se
          puede inspeccionar, pero todavía no participa en el consenso ni en alertas. GMAP no aparece porque es lluvia
          media areal por cuenca, no un píxel independiente.</p>
      </div>`;
  }
  const _hvFmt = (v, suf = "") => (v == null ? "—" : (+v).toLocaleString("es-EC", { maximumFractionDigits: 2 }) + suf);
  async function cargarValidacionHidro(cont) {
    const host = cont.querySelector('[data-rol="hv-grid"]');
    if (!host) return;
    const selEst = cont.querySelector('[data-rol="hv-estacion"]');
    const selVen = cont.querySelector('[data-rol="hv-ventana"]');
    const query = `?dias=${_hvEstado.dias}${_hvEstado.codigo ? `&codigo=${encodeURIComponent(_hvEstado.codigo)}` : ""}`;
    const url = "/cartas/validacion/hidro_resumen" + query;
    let datos;
    try {
      if (!_hvCache.has(url)) _hvCache.set(url, App.api(url));
      datos = await _hvCache.get(url);
    } catch (e) {
      if (host.isConnected) host.innerHTML = `<span class="suave" style="font-size:12px">Validación de hidroestimadores no disponible${window.HIDROMET_VISOR ? " en el visor" : ""}.</span>`;
      return;
    }
    if (!host.isConnected) return;
    const estaciones = (datos && datos.estaciones) || [];
    if (selEst && selEst.options.length <= 1) {
      selEst.innerHTML = `<option value="">Promedio de la red 7-7 (${fmtNum(estaciones.length)})</option>` +
        estaciones.map(e => `<option value="${esc(e.codigo)}">${esc(e.codigo)} · ${esc(e.nombre || e.codigo)}</option>`).join("");
      selEst.value = _hvEstado.codigo;
      selEst.onchange = () => {
        _hvEstado.codigo = selEst.value;
        host.innerHTML = `<span class="suave" style="font-size:12px">Actualizando comparación…</span>`;
        cargarValidacionHidro(cont);
      };
    }
    if (selVen) {
      selVen.value = String(_hvEstado.dias);
      selVen.onchange = () => {
        _hvEstado.dias = +selVen.value;
        host.innerHTML = `<span class="suave" style="font-size:12px">Actualizando ventana…</span>`;
        cargarValidacionHidro(cont);
      };
    }
    const prods = (datos && datos.productos) || [];
    if (!prods.length) {
      host.innerHTML = `<span class="suave" style="font-size:12px">Aún no hay pares estimado↔observación (se llenan con la actualización diaria).</span>`;
      return;
    }
    const ventanas = (datos.ventanas || [7, 14, 30, 60]);
    const filas = prods.flatMap(p => ventanas.map(ventana => {
      const m = (p.metricas_ventanas || {})[String(ventana)];
      const d = (m && m.deteccion) || {};
      const estado = p.fuente === "CCS" ? "Diagnóstico" : ((p.motor || {}).apto_ponderacion ? "Apto" : "Muestra insuficiente");
      const rotulo = ({ PDIR: "PERSIANN-PDIR", CCS: "PERSIANN-CCS" }[p.fuente] || p.fuente);
      return `<tr class="${ventana === _hvEstado.dias ? "activa" : ""}">
        <td><span class="ct-hv-fuente" style="--hv-color:${esc(HV_COLOR[p.fuente] || "#4c78a8")}">${esc(rotulo)}</span></td>
        <td class="mono">${ventana} d</td><td class="mono">${_hvFmt(m && m.mae)}</td>
        <td class="mono">${_hvFmt(m && m.rmse)}</td><td class="mono">${_hvFmt(m && m.bias)}</td>
        <td class="mono">${_hvFmt(m && m.corr)}</td>
        <td class="mono">${_hvFmt(d.pod)}</td><td class="mono">${_hvFmt(d.far)}</td>
        <td class="mono">${_hvFmt(d.csi)}</td><td class="mono">${m ? fmtNum(m.n) : "—"}</td>
        <td class="mono">${m ? fmtNum(m.dias) : "—"}</td><td>${esc(estado)}</td></tr>`;
    }));
    const comun = datos.muestra_comun || {};
    host.innerHTML = `<div class="ct-hv-plot" data-hv-plot="comparacion"></div>
      <div class="ct-hv-tabla-wrap"><table class="ct-hv-met"><thead><tr>
        <th>Fuente</th><th>Ventana</th><th>MAE</th><th>RMSE</th><th>Sesgo</th><th>r</th><th>POD</th><th>FAR</th><th>CSI</th><th>Pares</th><th>Días</th><th>Estado</th>
      </tr></thead><tbody>${filas.join("")}</tbody></table>
      <div class="ct-hv-muestra">Muestra común: ${fmtNum(comun.pares || 0)} pares estación×día · ${(comun.fuentes || []).map(esc).join(" / ")}</div></div>`;
    if (!window.Plotly) return;
    const oscuro = temaOscuro();
    const tinta = oscuro ? "#9DAABF" : "#58667A", rejilla = oscuro ? "rgba(223,230,247,.10)" : "rgba(70,89,122,.12)";
    const div = host.querySelector('[data-hv-plot="comparacion"]');
    if (!div) return;
    const obs = new Map();
    prods.forEach(p => {
      const s = p.serie || {};
      (s.fechas || []).forEach((fecha, i) => {
        if (s.observado && s.observado[i] != null && !obs.has(fecha)) obs.set(fecha, s.observado[i]);
      });
    });
    const fechasObs = [...obs.keys()].sort();
    const trazas = [{ type: "bar", name: "Observado", x: fechasObs, y: fechasObs.map(f => obs.get(f)),
      marker: { color: oscuro ? "rgba(174,187,208,.50)" : "rgba(70,89,122,.38)" },
      hovertemplate: "%{x} · observado <b>%{y:.2f} mm</b><extra></extra>" }];
    prods.forEach(p => {
      const s = p.serie || {};
      const col = HV_COLOR[p.fuente] || "#4c78a8";
      const rotulo = ({ PDIR: "PERSIANN-PDIR", CCS: "PERSIANN-CCS" }[p.fuente] || p.fuente);
      trazas.push({ type: "scatter", mode: "lines+markers", name: rotulo,
        x: s.fechas, y: s.estimado, connectgaps: false,
        line: { color: col, width: 2.2, dash: p.fuente === "CCS" ? "dot" : "solid" },
        marker: { size: 5, color: col }, customdata: s.n_pares,
        hovertemplate: "%{x} · " + rotulo + " <b>%{y:.2f} mm</b> · %{customdata} pares comunes<extra></extra>" });
    });
    Plotly.newPlot(div, trazas, {
      height: 325, margin: { l: 42, r: 10, t: 12, b: 48 },
      paper_bgcolor: "rgba(0,0,0,0)", plot_bgcolor: "rgba(0,0,0,0)", barmode: "overlay",
      showlegend: true, legend: { orientation: "h", y: -0.20, font: { size: 10, color: tinta } },
      xaxis: { type: "category", nticks: 10, tickfont: { size: 9, color: tinta }, showgrid: false },
      yaxis: { title: { text: "Precipitación (mm)", font: { size: 10, color: tinta } },
        tickfont: { size: 9, color: tinta }, gridcolor: rejilla, zeroline: false, rangemode: "tozero" },
      font: { color: tinta }, barcornerradius: 3,
    }, { displayModeBar: false, responsive: true });
  }

  function conectarGrid(cont, tipoId) {
    const g = gridState(tipoId);
    const t = tipoNodo(tipoId);
    if (!t || !(t.variables || []).length) return;
    const v = t.variables.find(x => x.id === g.varId);
    const p = v.periodos.find(x => x.horas === g.horas);
    const re = () => pintarCuerpo();
    // ◀ ▶ SALTAN los instantes deshabilitados (sin dato de ninguna fuente mostrada).
    const conteo = conteoInst(p, fuentesVista(p, 4));
    const salta = (dir) => {
      let i = g.inst + dir;
      while (i >= 0 && i < p.instantes.length && conteo[i] === 0) i += dir;
      if (i >= 0 && i < p.instantes.length) { g.inst = i; re(); }
    };
    cont.querySelector('[data-rol="var"]').onchange = (e) => { g.varId = e.target.value; g.horas = null; g.inst = null; re(); };
    cont.querySelector('[data-rol="per"]').onchange = (e) => { g.horas = +e.target.value; g.inst = null; re(); };
    cont.querySelector('[data-rol="inst"]').onchange = (e) => { g.inst = +e.target.value; re(); };
    cont.querySelector('[data-rol="prev"]').onclick = () => salta(-1);
    cont.querySelector('[data-rol="next"]').onclick = () => salta(1);
    cont.querySelectorAll('.ct-toggle[data-capa]').forEach(b => b.onclick = () => { E.capas[b.dataset.capa] = !E.capas[b.dataset.capa]; re(); });
    if (tipoId === "hidro") cargarValidacionHidro(cont);   // §P9: panel de validación
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

  function ffgsProductosPeriodo(t, horas) {
    return ((t && t.variables) || []).filter(v =>
      (v.periodos || []).some(p => p.horas === horas));
  }

  // Resuelve el descriptor por la identidad meteorológica del ciclo. Nunca usa
  // la posición de otro producto: si ese producto no tiene el ciclo, devuelve
  // null y su tarjeta muestra «Sin dato».
  function descriptorFFGSPorReferencia(p, referenceTime) {
    if (!p || !Number.isSafeInteger(referenceTime)) return null;
    let encontrada = null;
    for (const it of (p.instantes || [])) {
      for (const f of fuentesVista(p)) {
        const descriptor = descriptorCarta(p, it, f);
        if (!descriptor || !Number.isSafeInteger(descriptor.reference_time)
            || descriptor.reference_time !== referenceTime) continue;
        if (encontrada) {
          const anterior = encontrada.descriptor;
          if (anterior.archivo !== descriptor.archivo || anterior.capa !== descriptor.capa
              || anterior.record !== descriptor.record)
            return null; // referencia ambigua: nunca escoger el primer record al azar
          continue;
        }
        encontrada = { instante: it, descriptor };
      }
    }
    return encontrada;
  }

  function ciclosReferenciaFFGS(t, horas) {
    const refs = new Set();
    for (const v of ffgsProductosPeriodo(t, horas)) {
      const p = v.periodos.find(pp => pp.horas === horas);
      for (const it of (p && p.instantes) || []) {
        for (const f of fuentesVista(p)) {
          const d = descriptorCarta(p, it, f);
          if (d && Number.isSafeInteger(d.reference_time)) refs.add(d.reference_time);
        }
      }
    }
    return [...refs].sort((a, b) => a - b);
  }

  function ffgsUsaReferencia(t, horas, productos) {
    // Un contrato v1 reconocido prohíbe volver a índices aunque estuviera
    // incompleto: mezclar posiciones sería peor que mostrar «Sin dato».
    return !!contratoShpFFGS(productos) || ciclosReferenciaFFGS(t, horas).length > 0;
  }

  function coberturaCicloFFGS(t, horas, referenceTime) {
    return ffgsProductosPeriodo(t, horas).reduce((n, v) => {
      const p = v.periodos.find(pp => pp.horas === horas);
      return n + (descriptorFFGSPorReferencia(p, referenceTime) ? 1 : 0);
    }, 0);
  }

  function referenciaDefectoFFGS(t, horas, productos, ciclos) {
    if (!ciclos.length) return null;
    const contrato = contratoShpFFGS(productos);
    const porPeriodo = contrato && contrato.raw.default_by_period;
    const entrada = porPeriodo && porPeriodo[String(horas)];
    const propuesta = entrada && entrada.reference_time;
    if (Number.isSafeInteger(propuesta) && ciclos.includes(propuesta)) return propuesta;
    // Mismo criterio del contrato: máxima cobertura y, en empate, ciclo más
    // reciente. No depende de Date.now ni de la ventana particular del producto.
    let mejor = ciclos[0], cobertura = -1;
    for (const ref of ciclos) {
      const n = coberturaCicloFFGS(t, horas, ref);
      if (n > cobertura || (n === cobertura && ref > mejor)) {
        mejor = ref; cobertura = n;
      }
    }
    return mejor;
  }

  function etiquetaCicloFFGS(referenceTime) {
    if (!Number.isSafeInteger(referenceTime)) return "Ciclo sin referencia";
    const iso = new Date((referenceTime - 5 * 3600) * 1000).toISOString();
    return `${iso.slice(0, 10)} · ${iso.slice(11, 16)} GMT-5`;
  }

  function ffgsState() {
    const t = tipoNodo("ffgs");
    const g = (E.grid.ffgs = E.grid.ffgs || {});
    if (!t || !(t.variables || []).length) return g;
    const pers = ffgsPeriodos(t);
    if (g.horas == null || !pers.includes(g.horas)) g.horas = pers.includes(6) ? 6 : pers[0];
    if (ffgsUsaReferencia(t, g.horas, E.productos)) {
      const ciclos = ciclosReferenciaFFGS(t, g.horas);
      if (!ciclos.includes(g.referenceTime))
        g.referenceTime = referenciaDefectoFFGS(t, g.horas, E.productos, ciclos);
      g.inst = ciclos.indexOf(g.referenceTime);
    } else {
      const rep = t.variables.find(v => v.periodos.some(p => p.horas === g.horas));
      const pr = rep && rep.periodos.find(p => p.horas === g.horas);
      const nInst = pr ? pr.instantes.length : 0;
      if (g.inst == null || g.inst >= nInst) g.inst = pr ? instanteDefecto(pr.instantes) : nInst - 1;
      if (g.inst < 0) g.inst = 0;
    }
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
    const prods = ffgsProductosPeriodo(t, g.horas);
    const rep = prods[0];
    const pr = rep && rep.periodos.find(p => p.horas === g.horas);
    const porReferencia = ffgsUsaReferencia(t, g.horas, E.productos);
    const ciclos = porReferencia ? ciclosReferenciaFFGS(t, g.horas) : [];
    const posicion = porReferencia ? ciclos.indexOf(g.referenceTime) : g.inst;
    const totalCiclos = porReferencia ? ciclos.length : ((pr && pr.instantes) || []).length;
    const optsPer = pers.map(h =>
      `<option value="${h}" ${h === g.horas ? "selected" : ""}>${String(h).padStart(2, "0")} h</option>`).join("");
    const optsInst = porReferencia
      ? (ciclos.length ? ciclos.map(ref => {
          const n = coberturaCicloFFGS(t, g.horas, ref);
          const parcial = n < prods.length ? ` · ${n}/${prods.length}` : "";
          return `<option value="${ref}" ${ref === g.referenceTime ? "selected" : ""}>${esc(etiquetaCicloFFGS(ref))}${parcial}</option>`;
        }).join("") : `<option disabled selected>Sin ciclos con referencia válida</option>`)
      : ((pr && pr.instantes) || []).map((x, i) =>
          `<option value="${i}" ${i === g.inst ? "selected" : ""}>${esc(x.etiqueta)}</option>`).join("");
    const cartas = prods.map(v => {
      const p = v.periodos.find(pp => pp.horas === g.horas);
      const resuelta = porReferencia ? descriptorFFGSPorReferencia(p, g.referenceTime) : null;
      const it = porReferencia
        ? resuelta && resuelta.instante
        : p.instantes[Math.min(g.inst, p.instantes.length - 1)];
      const f = (p.fuentes || [])[0] || {};
      const descriptor = porReferencia
        ? resuelta && resuelta.descriptor
        : descriptorCarta(p, it, f);
      const partes = (v.etiqueta || "").split(" — ");
      const sigla = partes[0] || v.id;
      const desc = partes[1] || "";
      if (!it || !descriptor) {
        return `<figure class="ct-carta"><div class="ct-carta-cab"><span class="titulo">${esc(sigla)}</span>
          <span class="meta">${esc(p.figcap || "")}</span></div>
          <div class="ct-lienzo"><div class="fallo"><div class="icono">🗺️</div>Sin dato</div></div></figure>`;
      }
      const params = paramsDescriptor(descriptor);
      return `<figure class="ct-carta">
        <div class="ct-carta-cab"><span class="titulo">${esc(sigla)}</span>
          <span class="meta" title="${esc(desc)}">${esc(desc)}</span></div>
        ${lienzoCarta(params, sigla + " · " + fechaLocalISO(it.inicio) + (desc ? " · " + desc : ""))}
        <div class="ct-ley-card" data-rol="ley-card"></div>
      </figure>`;
    }).join("");
    return `
      <div class="ct-barra cols compacta">
        <label class="bloque"><span class="et">Período</span>
          <select data-rol="fper">${optsPer}</select></label>
        <div class="ct-inst-nav">
          <button class="ct-nav" data-rol="fprev" ${posicion <= 0 ? "disabled" : ""}>◀</button>
          <select class="ct-instante" data-rol="finst">${optsInst}</select>
          <button class="ct-nav" data-rol="fnext" ${posicion < 0 || posicion >= totalCiclos - 1 ? "disabled" : ""}>▶</button>
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
    const porReferencia = ffgsUsaReferencia(t, g.horas, E.productos);
    const ciclos = porReferencia ? ciclosReferenciaFFGS(t, g.horas) : [];
    const nInst = porReferencia ? ciclos.length : (pr ? pr.instantes.length : 0);
    const posicion = porReferencia ? ciclos.indexOf(g.referenceTime) : g.inst;
    const re = () => pintarCuerpo();
    const q = s => cont.querySelector(s);
    if (q('[data-rol="fper"]')) q('[data-rol="fper"]').onchange = e => {
      g.horas = +e.target.value; g.inst = null; g.referenceTime = null; re();
    };
    if (q('[data-rol="finst"]')) q('[data-rol="finst"]').onchange = e => {
      if (porReferencia) g.referenceTime = +e.target.value;
      else g.inst = +e.target.value;
      re();
    };
    if (q('[data-rol="fprev"]')) q('[data-rol="fprev"]').onclick = () => {
      if (posicion <= 0) return;
      if (porReferencia) g.referenceTime = ciclos[posicion - 1]; else g.inst--;
      re();
    };
    if (q('[data-rol="fnext"]')) q('[data-rol="fnext"]').onclick = () => {
      if (posicion < 0 || posicion >= nInst - 1) return;
      if (porReferencia) g.referenceTime = ciclos[posicion + 1]; else g.inst++;
      re();
    };
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
    // §P10: el TÍTULO de cada carta es el PRODUCTO ("Riesgo de helada", "Riesgo de
    // ola de calor", anomalías) — nada de fuentes técnicas en lo visible; el meta
    // lleva la ventana ("Día 00-24 vs normal local").
    const cartas = vars.flatMap(v => {
      const p = v.periodos.find(pp => pp.horas === g.horas);
      const it = p.instantes[Math.min(g.inst, p.instantes.length - 1)];
      const rotulo = v.etiqueta || v.id;
      return (p.fuentes || []).slice(0, 4).map(f => {
        const descriptor = descriptorCarta(p, it, f);
        if (!it || !descriptor) {
          return `<figure class="ct-carta"><div class="ct-carta-cab"><span class="titulo">${esc(rotulo)}</span>
            <span class="meta">${esc(p.figcap || "")}</span></div>
            <div class="ct-lienzo"><div class="fallo"><div class="icono">🗺️</div>Sin dato</div></div></figure>`;
        }
        const params = paramsDescriptor(descriptor);
        return `<figure class="ct-carta">
          <div class="ct-carta-cab"><span class="titulo">${esc(rotulo)}</span>
            <span class="meta" title="${esc(p.figcap || "")}">${esc(p.figcap || "")}</span></div>
          ${lienzoCarta(params, rotulo + " · " + fechaLocalISO(it.inicio))}
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
    let _fdisp = p ? (p.fuentes || []).map(f => f.fuente).filter(s => !ALERTA_FUENTE_OCULTA.has(s)) : [];
    // Cada modo adjunta su inventario REAL de capas. Una calibrada no acreditada
    // permanece visible como diagnóstico; disponibilidad no implica consenso.
    const _porModo = E.productos && E.productos.fuentes_alerta_por_modo;
    const _permitidas = _porModo && _porModo[a.modo] && _porModo[a.modo][a.varId];
    if (window.HIDROMET_VISOR && Array.isArray(_permitidas))
      _fdisp = _fdisp.filter(s => _permitidas.includes(s));
    let _lista = ALERTA_FUENTES.filter(s => _fdisp.includes(s)).concat(_fdisp.filter(s => !ALERTA_FUENTES.includes(s)));
    if (!_lista.length) _lista = ALERTA_FUENTES.slice(0, 4);
    const _estados = (((E.productos || {}).alertas_meta || {}).estados_fuente || {})[a.varId] || {};
    const cartas = _lista.map(fuente => {
      const rotulo = ALERTA_FUENTE_ROTULO[fuente] || fuente;
      const estado = _estados[fuente] || {};
      const badge = estado.estado === "diagnostica_no_acreditada"
        ? `<span class="ct-fuente-estado diagnostico" title="${esc(estado.motivo || "Muestra causal insuficiente")}">Diagnóstico · no acreditado</span>`
        : estado.estado === "acreditada"
          ? `<span class="ct-fuente-estado acreditada">Acreditada</span>` : "";
      // localizar la fuente real dentro del período (los nombres del árbol son
      // CONSENSO/GFS/ICON/IFS, "IFS" se rotula "IFS HRES").
      let f = null, descriptor = null;
      if (p) {
        f = (p.fuentes || []).find(x => x.fuente === fuente)
          || (p.fuentes || []).find(x => x.fuente.toUpperCase() === fuente);
        if (f && inst) descriptor = descriptorCarta(p, inst, f);
      }
      const meta = `Riesgo 24 h${inst ? " · " + esc(inst.rango || inst.etiqueta) : ""}`;
      if (!f || !descriptor) {
        return `<figure class="ct-carta">
          <div class="ct-carta-cab"><span class="titulo">${esc(rotulo)}${badge}</span><span class="meta">${meta}</span></div>
          <div class="ct-lienzo"><div class="fallo"><div class="icono">⚠️</div>Sin producto disponible para ${esc(rotulo)}</div></div></figure>`;
      }
      const params = paramsDescriptor(descriptor);
      // VISOR en modo ZPH: pedir la variante congelada &modo=zph (solo capas de
      // alerta de lluvia; en la app el POST ya intercambió el .nc y no hace falta).
      if (window.HIDROMET_VISOR && a.modo === "zph" && a.varId === "alerta_lluvia") params.modo = "zph";
      // §P18a: SOLO en precipitación (nunca temperatura) el indicador FFR
      // (FFR) se dibujan SOBRE la carta si el FFR cubre la fecha de este instante.
      if (a.varId === "alerta_lluvia" && inst) params.ffr = fechaLocalISO(inst.inicio);
      return `<figure class="ct-carta">
        <div class="ct-carta-cab"><span class="titulo">${esc(rotulo)}${badge}</span><span class="meta">${meta}</span></div>
        ${lienzoCarta(params, "Alerta " + rotulo + " · " + fechaLocalISO(inst.inicio))}
        <div class="ct-ley-card" data-rol="ley-card"></div>
      </figure>`;
    }).join("");

    const sinArbol = tieneArbol ? "" :
      `<div class="vacio" style="padding:24px"><span class="suave">No hay alertas vigentes en disco; el panel muestra el desempeño causal de emisiones realmente realizadas.</span></div>`;

    // §P18a: la nota del overlay FFR SOLO aplica a precipitación.
    const esLluvia = a.varId === "alerta_lluvia";
    const notaFFR = esLluvia
      ? `<p class="ct-nota" style="margin:-4px 0 14px">El <b>indicador FFR de susceptibilidad a crecida</b> se dibuja
           <span style="color:#009AF2;font-weight:700">punteado</span> SOBRE las cartas cuando F1FFR24 cubre esa fecha.
           Los cortes 0.10/0.30/0.50 son <b>operativos provisionales y no calibrados</b>: no predicen por sí solos un
           desbordamiento. Si F1FFR24 falta, el estado es «Sin dato», nunca «Sin riesgo».</p>`
      : "";

    return `
      <div class="ct-barra compacta">
        <label><span class="et">Variable</span><select data-rol="avar">${optsVar}</select></label>
        <span class="ct-div"></span>
        ${a.varId === "alerta_lluvia" ? `
        <span class="et" title="Umbrales fijos regionales o por Zonas de Pronóstico Homogéneo (ZPH: solo precipitación)">Umbrales</span>
        <div class="segmentado" data-rol="umbral" style="--seg-color:var(--blue)">${segFijos}${segZph}</div>` : ""}
        <button class="boton azulclaro chico" data-rol="editar">✎ Editar umbrales</button>
        <div class="ct-inst-nav">
          <button class="ct-nav" data-rol="aprev" ${a.inst <= 0 ? "disabled" : ""}>◀</button>
          <select class="ct-instante" data-rol="ainst">${optsInst}</select>
          <button class="ct-nav" data-rol="anext" ${(!p || a.inst >= p.instantes.length - 1) ? "disabled" : ""}>▶</button>
        </div>
        ${capasHTML(true)}
      </div>
      ${sinArbol}
      <div class="ct-grid">${cartas}</div>
      ${notaFFR}
      <div class="ct-panel" id="ct-desempeno">
        <div class="ct-panel-cab">
          <h3>Desempeño causal de las advertencias <span class="suave" data-rol="dsub">· cargando…</span></h3>
        </div>
        <p class="ct-nota ct-evidencia-causal" data-rol="evidencia-causal">Verificando emisiones previas contra observaciones de la misma ventana…</p>
        <div class="ct-serie ct-desempeno-comparativo" data-rol="comparativa"></div>
        <div class="ct-serie ct-desempeno-temporal" data-rol="serie"></div>
        <p class="ct-nota" data-rol="dnota"></p>
      </div>`;
  }

  function conectarAlertas(cont) {
    const a = E.alerta;
    const re = () => pintarCuerpo();
    // No llamamos cargarDesempeno() aquí: re()→pintarCuerpo()→conectarAlertas ya
    cont.querySelector('[data-rol="avar"]').onchange = (e) => { a.varId = e.target.value; a.inst = null; re(); };
    cont.querySelectorAll('[data-rol="umbral"] button').forEach(b =>
      b.onclick = async () => {
        a.modo = b.dataset.modo;
        // Cambiar de modo COPIA la variante pre-calculada sobre alertas_diarias.nc; sin
        // esto el toggle no cambiaba el archivo y fija/zph se veían idénticos. En el visor
        // (solo lectura) se omite SOLO el POST: re() re-pinta igualmente y las cartas de
        // alerta de lluvia piden la variante congelada &modo=zph (cuerpoAlertas), así el
        // toggle deja de ser cosmético en el visor.
        if (!window.HIDROMET_VISOR) {
          try { await App.api("/cartas/umbrales_modo", { method: "POST", body: { modo: a.modo } }); }
          catch (e) { App.aviso(e.message, "error"); }
        }
        limpiarCacheDatos();   // §P14: el swap fija/zph cambió el .nc → la caché de mallas caduca
        re();
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
  }

  // Datos de desempeño causal cacheados por variable+modo.
  async function datosDesempeno() {
    const a = E.alerta;
    const varVal = (VAR_ALERTA.find(x => x.id === a.varId) || VAR_ALERTA[0]).val;
    const clave = varVal + "|" + a.modo;
    if (a._desClave === clave && a._desDatos) return a._desDatos;
    const r = await App.api("/cartas/alertas_programa?" + qs({ variable: varVal, modo: a.modo }));
    a._desClave = clave; a._desDatos = r;
    return r;
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
        pintarCuerpo();
      });
  }

  /* ============================================================
     Carga del árbol de productos + (re)pintado
     ============================================================ */
  async function recargar() {
    if (!E) return;                                   // la vista pudo desmontarse
    if (E.alerta) E.alerta._desClave = null;          // invalida la caché de desempeño
    limpiarCacheDatos();                              // §P14/§P9: mallas y resúmenes caducan
    try { E.productos = await App.api("/cartas/productos"); }
    catch (e) { /* mantiene el árbol previo */ }
    if (vp) { try { vp.pintar(vp.activa()); } catch (e) {} }   // re-pinta la pestaña activa
  }

  /* ---- Estado compartido entre los módulos Pronóstico/Advertencias y el panel
     FFGS (que vive bajo Hidrología). Idempotente: carga el árbol una vez. ---- */
  async function asegurarEstado() {
    if (!E) {
      E = { tipo: "pronostico", productos: { tipos: [] }, grid: {},
            // §P4: los cuatro toggles de capa inician ACTIVOS en todas las cartas.
            capas: { grilla: true, isolineas: true, galapagos: true, estaciones: true },
            alerta: { varId: "alerta_lluvia", modo: "fija", inst: null,
                      opts: Object.fromEntries(TOGGLES.map(t => [t.id, t.on])) } };
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
    cont.innerHTML = cuerpoAlertas(); conectarAlertas(cont); montarMapasCarta(cont);
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
    limpiarCacheDatos();   // §P14/§P9/§P18: mallas, resumen hidro y zonas FFR caducan
    if (vp) recargar();
    else E._stale = true;   // NO destruir E.productos: rompería un panel FFGS montado bajo Hidrología; re-fetch perezoso en asegurarEstado
  });

  // Cambio de tema: los mapas Plotly eligen sus colores AL DIBUJAR (contornos,
  // tooltip, grilla), así que hay que redibujar. Con vp se re-pinta la pestaña
  // visible; sin vp (p.ej. panel FFGS montado bajo Hidrología) se re-montan los
  // lienzos ya dibujados con la paleta del tema nuevo.
  document.addEventListener("temacambiado", () => {
    if (!E) return;
    if (vp) { try { vp.pintar(vp.activa()); } catch (e) {} return; }
    const montados = [...document.querySelectorAll(".ct-lienzo[data-datos]")]
      .filter(d => d._montado && d.isConnected);
    if (!montados.length) return;
    montados.forEach(d => { d._montado = false; });
    montarMapasCarta(document);
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
      // IMAGEN del mapa: FFR (data-dlimg) siempre, y las cartas (data-jpg) cuando
      // estamos en el VISOR en línea (sin backend que renderice la carta formal).
      if (b.dataset.dlimg || (b.dataset.jpg && window.HIDROMET_VISOR)) {
        await descargarImagenMapa(b);
      } else if (b.dataset.jpg) {
        const r = await App.api(b.dataset.jpg);   // app: carta FORMAL renderizada por el servidor
        App.aviso(`Carta guardada en Descargas: ${r.archivo}`, "ok", 6000);
      } else if (b.dataset.shp) {
        if (window.HIDROMET_VISOR) {
          await _descargarShpVisor(b.dataset.shp);   // ZIP directo o FFGS reconstruido
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

  // VISOR: descarga un ZIP directo (alertas/FFR) o recompone FFGS desde bloques
  // compartidos. No hay motor que genere el shapefile en vivo.
  async function _descargarShpVisor(rutaApi) {
    const prod = App.rutaAProducto(rutaApi).replace(/\.json$/, ".zip");
    let blob = null, nombre = prod.split("/").pop() || "shapefile.zip";
    // Los FFGS comparten una geometría grande entre variables/records. El visor
    // publica una sola copia de cada bloque y recompone localmente el mismo ZIP.
    // El fallback mantiene compatibles builds anteriores durante la transición.
    if (/^\/cartas\/ffgs_shp(?:\?|$)/.test(String(rutaApi))) {
      const manifestProd = App.rutaAProducto(rutaApi).replace(/\.json$/, ".manifest.json");
      try {
        const mr = await fetch(manifestProd, { cache: "no-cache" });
        if (mr.ok) {
          const reconstruido = await App.zipDesdeManifest(await mr.json(), manifestProd);
          blob = reconstruido.blob;
          nombre = reconstruido.nombre;
        }
      } catch (e) { /* intentar el ZIP legado debajo */ }
    }
    if (!blob) {
      const resp = await fetch(prod, { cache: "no-cache" });
      if (!resp.ok) throw new Error("El shapefile de esta advertencia aún no está publicado en el visor");
      blob = await resp.blob();
    }
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
    const plot = cont && (cont.querySelector(".ct-mapa-plot")
      || cont.querySelector(".js-plotly-plot"));
    if (!plot || !window.Plotly) throw new Error("El mapa aún no está listo");
    const nombre = String(b.dataset.nombre || "carta").replace(/[^\w\-]+/g, "_").slice(0, 60) || "carta";
    const bb = plot.getBoundingClientRect();
    const w = Math.max(1000, Math.round((bb.width || 520) * 2));
    const h = Math.max(680, Math.round((bb.height || 360) * 2));
    // Carta de pronóstico/alerta (tiene datos guardados) → imagen FORMAL con título + leyenda.
    // Los mapas FFR ya llevan su leyenda dentro de la figura → se capturan tal cual.
    const dataUrl = plot._carta
      ? await _imagenCartaFormal(plot, w, h)
      : await _imagenMapaBlanco(plot, w, h);
    if (window.HIDROMET_VISOR) {
      const a = document.createElement("a"); a.href = dataUrl; a.download = nombre + ".png";
      document.body.appendChild(a); a.click(); a.remove();
      App.aviso("Carta descargada (PNG con leyenda)", "ok", 4000);
    } else {
      const r = await App.api("/cartas/guardar_imagen", { method: "POST", body: { imagen: dataUrl, nombre } });
      App.aviso(`Carta guardada en Descargas: ${r.archivo}`, "ok", 6000);
    }
  }

  // Guarda los colores/fondos TEMÁTICOS actuales del layout para poder revertirlos tras
  // el toImage (el PNG exportado usa papel blanco y tinta fija, independientes del tema:
  // el "mar" blanco lo pone el CSS del contenedor, no el layout, así que sin esto el PNG
  // salía transparente y con fuente del tema — ilegible en oscuro sobre fondo blanco).
  function _fondoPrevio(plot) {
    const L = plot.layout || {};
    return {
      "paper_bgcolor": L.paper_bgcolor || "rgba(0,0,0,0)",
      "plot_bgcolor": L.plot_bgcolor || "rgba(0,0,0,0)",
      "font.color": (L.font && L.font.color) || null,
      "legend.font.color": (L.legend && L.legend.font && L.legend.font.color) || null,
    };
  }
  const _FONDO_PNG = { "paper_bgcolor": "#ffffff", "plot_bgcolor": "#ffffff", "font.color": "#0F1B2D",
                       "legend.font.color": "#283550" };

  // Los mapas TEMÁTICOS dibujan contorno/microcuencas/estaciones con la paleta del
  // tema; el PNG de descarga es SIEMPRE la carta blanca (entregable externo). Antes
  // del toImage se fuerzan esos trazos (por su meta) a la paleta de PAPEL y se
  // devuelve una función que restituye los colores que tenían en pantalla.
  const _PAPEL_TRAZA = {
    "outline-halo":   { "line.color": "#ffffff" },
    "outline-linea":  { "line.color": "#000000" },
    "microcuencas":   { "line.color": "rgba(35,49,77,.32)" },
    "estaciones-ct":  { "marker.color": "#10233F", "marker.line.color": "#fff" },
  };
  async function _trazasAPapel(plot) {
    const data = plot.data || [];
    const revertir = [];
    for (let i = 0; i < data.length; i++) {
      const fix = _PAPEL_TRAZA[data[i].meta];
      if (!fix) continue;
      const prev = {};
      for (const clave of Object.keys(fix)) {
        let v = data[i];
        for (const p of clave.split(".")) v = v ? v[p] : undefined;
        prev[clave] = v === undefined ? null : v;
      }
      revertir.push([i, prev]);
      await window.Plotly.restyle(plot, fix, [i]);
    }
    return async () => { for (const [i, prev] of revertir) await window.Plotly.restyle(plot, prev, [i]); };
  }

  // PNG (dataURL) de un mapa FFR (leyenda ya incluida en la figura):
  // se captura tal cual pero con papel blanco y tinta fija, revertidos después.
  async function _imagenMapaBlanco(plot, w, h) {
    const prev = _fondoPrevio(plot);
    const restituir = await _trazasAPapel(plot);
    await window.Plotly.relayout(plot, Object.assign({}, _FONDO_PNG));
    try { return await window.Plotly.toImage(plot, { format: "png", width: w, height: h, scale: 1 }); }
    finally { await window.Plotly.relayout(plot, prev); await restituir(); }
  }

  // PNG (dataURL) de una carta CON su título y su leyenda (colorbar), reconstruidos
  // TEMPORALMENTE sobre el propio plot y revertidos después (el visor no tiene backend que
  // renderice el PNG formal del servidor, así que la carta se compone en el navegador).
  async function _imagenCartaFormal(plot, w, h) {
    const c = plot._carta || {};
    const data = plot.data || [];
    const idx = data.findIndex(t => t.type === "heatmap" && (!t.xaxis || t.xaxis === "x"));
    const prev = _fondoPrevio(plot);
    const restituir = await _trazasAPapel(plot);
    const relOn = Object.assign({ "margin.t": (c.titulo ? 54 : 12), "margin.r": 96, "margin.b": 14 }, _FONDO_PNG);
    if (c.titulo) {
      relOn["title.text"] = esc(c.titulo) + (c.subtitulo ? `<br><span style="font-size:12px;font-weight:400">${esc(c.subtitulo)}</span>` : "");
      relOn["title.x"] = 0.5; relOn["title.xanchor"] = "center"; relOn["title.y"] = 0.98; relOn["title.font.size"] = 16;
      relOn["title.font.color"] = "#0F1B2D";
    }
    await window.Plotly.relayout(plot, relOn);
    const conBarra = idx >= 0 && c.tickvals && c.tick_labels && c.tickvals.length === c.tick_labels.length;
    if (conBarra) {
      await window.Plotly.restyle(plot, {
        showscale: true,
        colorbar: [{ thickness: 13, len: 0.86, y: 0.5, x: 1.0, xpad: 4, outlinewidth: 0,
          tickvals: c.tickvals, ticktext: c.tick_labels, tickfont: { size: 9, color: "#283550" },
          title: { text: c.unidad || "", side: "right", font: { size: 10, color: "#283550" } } }],
      }, [idx]);
    }
    let url;
    try { url = await window.Plotly.toImage(plot, { format: "png", width: w, height: h, scale: 1 }); }
    finally {
      await window.Plotly.relayout(plot, Object.assign({ "title.text": "", "margin.t": 0, "margin.r": 0, "margin.b": 0 }, prev));
      if (conBarra) await window.Plotly.restyle(plot, { showscale: false }, [idx]);
      await restituir();
    }
    return url;
  }

  /* ============================================================
     REGISTRO de la vista
     ============================================================ */
  const ACC_ACTUALIZAR = '<button class="boton oscuro" id="ct-actualizar">⟳ Actualizar</button>';
  function _alDejarCartas() {
    purgarCartas();
    salirMLNWP();       // si la pestaña ML-NWP estaba montada, purga su serie Plotly
    salirDecisiones();  // ídem la pestaña Decisiones operativas (su mapa Plotly)
    const cab = document.getElementById("cabecera-vista");
    if (cab) cab.style.display = "";            // restaurar la cabecera global
    vp = null;
  }
  function _wireActualizar(vista) {
    const b = vista.querySelector("#ct-actualizar");
    if (b) b.onclick = abrirActualizar;
  }

  /* ============================================================
     PESTAÑA "Series, validación e IA" — el módulo "Validación NWP-ML"
     migrado como pestaña de Pronóstico: delega en window.MLNWP
     (ui/js/modules/mlnwp.js). Todos los scripts se cargan al inicio
     (index.html), así que al CLICAR la pestaña window.MLNWP ya existe
     aunque mlnwp.js se cargue antes que cartas.js; el guard cubre un
     fallo de carga. Lazy: solo se renderiza al activar la pestaña
     (vistaPestanas re-renderiza al volver) y alSalir purga sus Plotly.
     ============================================================ */
  async function panelMLNWP(cont) {
    if (!window.MLNWP || typeof window.MLNWP.render !== "function") {
      cont.innerHTML = `<div class="vacio"><div class="icono">⚠️</div>No se pudo cargar el módulo de validación (mlnwp.js).</div>`;
      return;
    }
    await window.MLNWP.render(cont);
  }
  function salirMLNWP() {
    if (window.MLNWP && typeof window.MLNWP.alDejar === "function") window.MLNWP.alDejar();
  }

  /* ============================================================
     PESTAÑA "Decisiones operativas" — mapa de Ecuador con el veredicto
     de lluvia de mañana por estación + panel con el veredicto desplegado
     y la VALIDACIÓN de esas decisiones. Delega en window.DECISIONES
     (ui/js/modules/decisiones.js) con el MISMO patrón lazy/alSalir que
     la pestaña ML-NWP: solo se renderiza al activarla y alSalir purga
     su mapa Plotly.
     ============================================================ */
  async function panelDecisiones(cont) {
    if (!window.DECISIONES || typeof window.DECISIONES.render !== "function") {
      cont.innerHTML = `<div class="vacio"><div class="icono">⚠️</div>No se pudo cargar el módulo de decisiones operativas (decisiones.js).</div>`;
      return;
    }
    await window.DECISIONES.render(cont);
  }
  function salirDecisiones() {
    if (window.DECISIONES && typeof window.DECISIONES.alDejar === "function") window.DECISIONES.alDejar();
  }

  // MENÚ "Pronóstico": pronóstico · series/validación/IA · calibrado · hidroestimadores · heladas/calor.
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
          { id: "mlnwp", etiqueta: "Series, validación e IA", render: panelMLNWP, alSalir: salirMLNWP },
          { id: "decisiones", etiqueta: "Decisiones operativas", render: panelDecisiones, alSalir: salirDecisiones },
          { id: "calibrado", etiqueta: "Pronóstico calibrado", render: panelGrid("calibrado"), alSalir: purgarCartas },
          { id: "hidro", etiqueta: "Hidroestimadores", render: panelGrid("hidro"), alSalir: purgarCartas },
          { id: "heladas", etiqueta: "Heladas / Calor", render: panelHeladas, alSalir: purgarCartas },
        ],
      });
      _wireActualizar(vista);
    },
    alDejar: _alDejarCartas,
  });

  // MENÚ "Advertencias": SOLO las advertencias del programa (panel único, sin
  // barra de pestañas). Se mantiene App.vistaPestanas con una única pestaña para
  // conservar la cabecera (kicker/título/sub/acciones) idéntica a los demás
  // módulos y el controlador vp (recargar tras Actualizar / cambio de tema);
  // la barra .hm-pestanas se oculta porque con una sola pestaña no aporta.
  App.registrar("advertencias", {
    titulo: "Advertencias", orden: 4,
    async render(vista) {
      vista.dataset.screenLabel = "Advertencias";
      await asegurarEstado();
      vp = App.vistaPestanas(vista, {
        kicker: "Alertas y advertencias", titulo: "Advertencias",
        sub: "Alertas por consenso con validación de desempeño",
        accionesHTML: ACC_ACTUALIZAR, inicial: "alertas",
        pestanas: [
          { id: "alertas", etiqueta: "Advertencias", danger: true, render: panelAlertas, alSalir: purgarCartas },
        ],
      });
      const fila = vista.querySelector(".hm-pestanas");
      if (fila) fila.style.display = "none";
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
        <div class="suave" style="font-size:12.5px;margin-bottom:12px">Descarga los últimos pronósticos y rehace cartas y alertas.</div>
        <label class="campo" style="margin-bottom:12px"><span>Alcance</span>
          <select data-rol="alcance">
            <option value="cartas">Todo cartas (pronóstico + alertas)</option>
            <option value="modelos">Solo pronóstico</option>
            <option value="alertas">Solo alertas</option>
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

  // Dos gráficos y una nota metodológica: sin mapas, cruces ni rankings cuando
  // la muestra causal todavía no supera las puertas operativas.
  async function cargarDesempeno() {
    const panel = document.getElementById("ct-desempeno");
    if (!panel) return;
    const a = E.alerta;
    const comparativa = panel.querySelector('[data-rol="comparativa"]');
    const temporal = panel.querySelector('[data-rol="serie"]');
    const evidenciaHost = panel.querySelector('[data-rol="evidencia-causal"]');
    const nota = panel.querySelector('[data-rol="dnota"]');
    try {
      const r = await datosDesempeno();
      if (!panel.isConnected) return;
      const evidencia = r.evidencia || {};
      const suficiente = r.muestra_suficiente === true;
      const avisos = (r.advertencias || []).map(esc).join(" ");
      evidenciaHost.className = "ct-nota ct-evidencia-causal " + (suficiente ? "suficiente" : "insuficiente");
      evidenciaHost.innerHTML = `<b>${suficiente ? "Evidencia causal suficiente" : "Muestra causal insuficiente"}</b> · ` +
        `${fmtNum(evidencia.casos_estacion_fecha || 0)} casos estación×día · ` +
        `${fmtNum(evidencia.fechas_validas || 0)} fechas válidas · ` +
        `${fmtNum(evidencia.fechas_emision || 0)} emisiones. ${avisos}`;

      const filas = (r.filas || []).filter(f => f.tot);
      const oscuro = !!(App.tema && App.tema() === "oscuro");
      const tinta = oscuro ? "#9DAABF" : "#58667A";
      const rejilla = oscuro ? "rgba(223,230,247,.10)" : "rgba(70,89,122,.12)";
      const fuentes = filas.map(f => ALERTA_FUENTE_ROTULO[f.fuente] || f.fuente);
      const colores = { CSI: "#4c78a8", POD: "#54a24b", FAR: "#e45756", HSS: "#b279a2" };
      if (comparativa && filas.length && window.Plotly) {
        const traces = ["CSI", "POD", "FAR", "HSS"].map(metrica => ({
          type: "bar", name: metrica, x: fuentes,
          y: filas.map(f => f.tot[metrica] == null ? null : +f.tot[metrica]),
          marker: { color: colores[metrica] },
          text: filas.map(f => f.tot[metrica] == null ? "" : (+f.tot[metrica]).toFixed(2)),
          textposition: "outside", cliponaxis: false,
          hovertemplate: `%{x}<br>${metrica}: %{y:.3f}<extra></extra>`,
        }));
        Plotly.react(comparativa, traces, {
          height: 390, barmode: "group", margin: { l: 42, r: 14, t: 48, b: 72 },
          paper_bgcolor: "rgba(0,0,0,0)", plot_bgcolor: "rgba(0,0,0,0)",
          title: { text: suficiente ? "Métricas causales por fuente" : "Métricas causales descriptivas · evidencia aún insuficiente", font: { size: 13, color: tinta } },
          legend: { orientation: "h", y: 1.12, font: { size: 10, color: tinta } },
          xaxis: { tickfont: { size: 10, color: tinta }, showgrid: false },
          yaxis: { range: [-1, 1], tickfont: { size: 9, color: tinta }, gridcolor: rejilla, zeroline: true },
          font: { color: tinta },
        }, { displayModeBar: false, responsive: true });
      } else if (comparativa) {
        comparativa.innerHTML = `<span class="suave">Aún no hay emisiones verificables para comparar.</span>`;
      }

      const serie = (r.serie || []).filter(s => (s.puntos || []).length);
      if (temporal && serie.length && window.Plotly) {
        const paleta = { CONSENSO: "#e45756", GFS: "#4c78a8", ICON: "#f58518", IFS: "#54a24b",
          BIAS: "#b279a2", RF: "#9d755d", GB: "#72b7b2", CAT: "#eeca3b", LSTM: "#bab0ac" };
        const metricas = ["CSI", "POD", "FAR"];
        const traces = [];
        metricas.forEach((metrica, mi) => serie.forEach(s => traces.push({
          type: "scatter", mode: "lines+markers", name: ALERTA_FUENTE_ROTULO[s.fuente] || s.fuente,
          legendgroup: s.fuente, showlegend: mi === 0,
          x: s.puntos.map(p => p.fecha), y: s.puntos.map(p => p[metrica]),
          xaxis: `x${mi + 1}`, yaxis: `y${mi + 1}`, connectgaps: false,
          marker: { size: 4 }, line: { width: s.fuente === "CONSENSO" ? 2.8 : 1.3, color: paleta[s.fuente] || "#888" },
          hovertemplate: `%{x} · ${metrica} %{y:.3f}<extra>${esc(ALERTA_FUENTE_ROTULO[s.fuente] || s.fuente)}</extra>`,
        })));
        Plotly.react(temporal, traces, {
          height: 690, margin: { l: 44, r: 14, t: 54, b: 92 },
          paper_bgcolor: "rgba(0,0,0,0)", plot_bgcolor: "rgba(0,0,0,0)",
          title: { text: "Evolución temporal causal · CSI / POD / FAR", font: { size: 13, color: tinta } },
          grid: { rows: 3, columns: 1, pattern: "independent" },
          // Nueve fuentes no caben junto al título sin solaparse. La leyenda va
          // debajo de los tres paneles: mantiene todos los modelos visibles y el
          // encabezado queda legible tanto en escritorio como en el visor.
          legend: { orientation: "h", x: 0, xanchor: "left", y: -0.12,
            yanchor: "top", font: { size: 9, color: tinta } },
          xaxis: { type: "category", showticklabels: false, showgrid: false },
          xaxis2: { type: "category", showticklabels: false, showgrid: false },
          xaxis3: { type: "category", tickfont: { size: 9, color: tinta }, showgrid: false },
          yaxis: { title: "CSI", range: [0, 1], gridcolor: rejilla },
          yaxis2: { title: "POD", range: [0, 1], gridcolor: rejilla },
          yaxis3: { title: "FAR", range: [0, 1], gridcolor: rejilla },
          font: { color: tinta },
        }, { displayModeBar: false, responsive: true });
      } else if (temporal) {
        temporal.innerHTML = `<span class="suave">La serie causal crecerá con cada nueva emisión verificada.</span>`;
      }

      const varEt = (VAR_ALERTA.find(x => x.id === a.varId) || VAR_ALERTA[0]).etiqueta.toLowerCase();
      panel.querySelector('[data-rol="dsub"]').textContent =
        `· ${varEt} · ${fmtNum(r.n_eval || 0)} evaluaciones causales`;
      nota.innerHTML = `Referencia: <b>observación canónica con QC y ventana exacta</b>. ` +
        `Solo se verifica si la fecha válida es posterior a la emisión; la reconstrucción retrospectiva no se usa como habilidad operativa.`;
    } catch (e) {
      panel.querySelector('[data-rol="dsub"]').textContent = "· sin evidencia causal verificable";
      if (comparativa) comparativa.innerHTML = "";
      if (temporal) temporal.innerHTML = "";
      evidenciaHost.textContent = "No fue posible leer las emisiones causales verificadas.";
      nota.textContent = "";
    }
  }

  // Superficie pura para las pruebas Node del contrato FFGS. En navegador no se
  // expone ningún global adicional; la UI consume exactamente estas funciones.
  if (typeof module === "object" && module.exports) module.exports = Object.freeze({
    FFGS_SHP_AVAILABILITY_SCHEMA,
    contratoShpFFGS,
    shpFFGSDisponible,
    botonShpFFGS,
    descriptorFFGSPorReferencia,
    ciclosReferenciaFFGS,
    coberturaCicloFFGS,
    referenciaDefectoFFGS,
    ffgsUsaReferencia,
  });
})();
