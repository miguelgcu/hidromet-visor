/* ============================================================
   HidroMet · Caudales GEOGLOWS — módulo del frontend (pestaña de Hidrología).
   Identidad PROPIA (clases gg-*, css/geoglows.css) — NO reutiliza el estilo de SNGR.
   Pronóstico de caudal por tramo de río (GEOGLOWS ECMWF v2): LISTA de ríos con nombre
   (elige claro) + mapa con la red de ríos y clic-en-punto + hidrograma Plotly.
   Arquitectura intacta: App.panel / App.api / App.tarea / App.modalTarea.
   ============================================================ */
"use strict";

(() => {
  const esc = v => String(v ?? "").replace(/[&<>"']/g,
    c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // Encuadre ECUADOR CONTINENTAL (mismo bbox que clima.js): [lat, lon] SW → NE.
  const LIMITES_EC = [[-5.1, -81.2], [1.6, -75.1]];
  const COLOR_ALERTA = { 0: "#2EA043", 2: "#C5B11B", 5: "#C5B11B", 10: "#E08A1E",
    25: "#D2691E", 50: "#CF362B", 100: "#7A1FA2" };
  const COLOR_SCREENING_SENAL = "#0E94A4";
  const COLOR_SCREENING_ESCENARIO = "#1763B6";
  const PASO_SCREENING_MS = 3 * 60 * 60 * 1000;
  const UMBRAL_PROBABILIDAD_ESCENARIO = 0.5;
  const colorNivel = na => (na && COLOR_ALERTA[na.anios] != null) ? COLOR_ALERTA[na.anios]
    : (na && na.color) ? na.color : "#6B7785";
  const fmt = n => (n == null ? "—" : Number(n).toLocaleString("es-EC", { maximumFractionDigits: 0 }));
  const fmt1 = n => (n == null ? "—" : Number(n).toLocaleString("es-EC", { maximumFractionDigits: 1 }));
  const NOM_MES = ["enero", "febrero", "marzo", "abril", "mayo", "junio",
    "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
  // La librería de gráficos viene solo con inglés ("Aug 22"): registrar un español
  // mínimo para los ejes de fecha (mismo patrón que clima.js) y pedirlo en la config.
  let _locEs = false;
  function configEs() {
    if (!_locEs && window.Plotly && typeof Plotly.register === "function") {
      try {
        Plotly.register({ moduleType: "locale", name: "es", dictionary: {}, format: {
          days: ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"],
          shortDays: ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"],
          months: NOM_MES.slice(),
          shortMonths: ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"],
          date: "%d/%m/%Y" } });
      } catch (e) { /* sin registro: ejes en inglés, nada se rompe */ }
      _locEs = true;
    }
    return Object.assign({}, App.plotlyConfig(), { locale: "es" });
  }
  // Los tiempos GEOGLOWS llegan en UTC ("...T00:00:00Z"): convertirlos a hora de
  // Ecuador (UTC−5 fija) para que el eje no vaya cinco horas adelantado.
  const aHoraEC = t => {
    const d = new Date(t);
    return isNaN(d) ? t : new Date(d.getTime() - 5 * 3600 * 1000).toISOString().slice(0, 19);
  };
  // "2026-08-22..." → "22 de agosto" (fecha en llano para la tarjeta del cribado)
  const fechaLlano = iso => {
    const m = String(iso || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m && NOM_MES[Number(m[2]) - 1] ? `${Number(m[3])} de ${NOM_MES[Number(m[2]) - 1]}` : null;
  };
  const primerValor = s => { if (!s) return null;
    for (const v of s) if (v != null && isFinite(v)) return v; return null; };
  const encuadrar = m => m && m.fitBounds(LIMITES_EC, { padding: [8, 8] });
  const numeroFinito = valor => valor !== null && valor !== undefined
    && valor !== "" && Number.isFinite(Number(valor));
  const probabilidadExplicita = item => {
    const bruto = item && (item.prob_exceedance ?? item.probabilidad);
    if (!numeroFinito(bruto)) return null;
    const valor = Number(bruto);
    if (valor < 0 || valor > 100) return null;
    return valor > 1 ? valor / 100 : valor;
  };

  function tipoItemScreening(item) {
    if (!item || item.excluido === true || item.excluded === true
      || /^(excluid[oa]|excluded)$/i.test(String(item.estado || item.status || "")))
      return "excluida";
    const probabilidad = probabilidadExplicita(item);
    return probabilidad !== null && probabilidad < UMBRAL_PROBABILIDAD_ESCENARIO
      ? "posible_escenario" : "senal_cribado";
  }

  function normalizarScreening(payload) {
    const bruto = payload && typeof payload === "object" ? payload : {};
    const resumenBruto = bruto.resumen && typeof bruto.resumen === "object"
      ? bruto.resumen : {};
    const items = (Array.isArray(bruto.items) ? bruto.items : []).map(item => ({
      ...item,
      river_id: item && item.river_id != null ? String(item.river_id) : "",
      lat: numeroFinito(item && item.lat) ? Number(item.lat) : null,
      lon: numeroFinito(item && item.lon) ? Number(item.lon) : null,
      return_period: numeroFinito(item && item.return_period)
        ? Number(item.return_period) : null,
      upstream_area_km2: numeroFinito(item && item.upstream_area_km2)
        ? Number(item.upstream_area_km2) : null,
      stream_order: numeroFinito(item && item.stream_order)
        ? Number(item.stream_order) : null,
      _tipo: tipoItemScreening(item),
    })).filter(item => item.lat !== null && item.lon !== null);
    const visibles = items.filter(item => item._tipo !== "excluida");
    const excluidasLocales = items.length - visibles.length;
    const senales = visibles.filter(item => item._tipo === "senal_cribado");
    const escenarios = visibles.filter(item => item._tipo === "posible_escenario");
    const pasos = [...new Set((Array.isArray(bruto.pasos_tiempo)
      ? bruto.pasos_tiempo : []).filter(numeroFinito).map(Number))].sort((a, b) => a - b);
    const numeroResumen = (clave, respaldo = 0) => numeroFinito(resumenBruto[clave])
      ? Math.max(0, Number(resumenBruto[clave])) : respaldo;
    return {
      ok: bruto.ok !== false && bruto.disponible !== false
        && !bruto.error && !bruto.construyendo,
      resumen: {
        catalogo_total: numeroResumen("catalogo_total"),
        base_detalle: numeroResumen("base_detalle"),
        senales_credibles: numeroResumen("senales_credibles", visibles.length),
        senales_excluidas: numeroResumen("senales_excluidas", excluidasLocales),
        inicio: resumenBruto.inicio || null,
        fin: resumenBruto.fin || null,
        generado: resumenBruto.generado || null,
      },
      items, visibles, senales, escenarios, pasos_tiempo: pasos,
      mapserver_url: String(
        (bruto.arcgis && bruto.arcgis.mapserver_url) || "").trim(),
    };
  }

  function servicioExportArcGIS(mapserverUrl) {
    const limpio = String(mapserverUrl || "").trim().replace(/\/+$/, "");
    const capa = limpio.match(/\/MapServer\/(\d+)$/i);
    if (capa) return {
      exportUrl: `${limpio.replace(/\/\d+$/, "")}/export`,
      layerId: Number(capa[1]),
    };
    if (/\/MapServer$/i.test(limpio))
      return { exportUrl: `${limpio}/export`, layerId: null };
    return { exportUrl: "", layerId: null };
  }

  function urlExportArcGIS(
    mapserverUrl, paso, bbox, size = { x: 256, y: 256 }, spatialReference = 4326,
  ) {
    const servicio = servicioExportArcGIS(mapserverUrl);
    if (!servicio.exportUrl || !numeroFinito(paso) || !Array.isArray(bbox)
      || bbox.length !== 4) return "";
    const params = new URLSearchParams({
      bbox: bbox.map(Number).join(","),
      bboxSR: String(spatialReference), imageSR: String(spatialReference),
      size: `${Math.round(Number(size.x) || 256)},${Math.round(Number(size.y) || 256)}`,
      format: "png32", transparent: "true", f: "image",
      time: `${Number(paso)},${Number(paso) + PASO_SCREENING_MS - 1}`,
    });
    if (servicio.layerId !== null) params.set("layers", `show:${servicio.layerId}`);
    return `${servicio.exportUrl}?${params.toString()}`;
  }

  function fechaPasoScreening(epoch) {
    if (!numeroFinito(epoch)) return "—";
    return new Intl.DateTimeFormat("es-EC", {
      timeZone: "America/Guayaquil", day: "2-digit", month: "short",
      hour: "2-digit", minute: "2-digit", hour12: false,
    }).format(new Date(Number(epoch))).replace(",", " ·");
  }
  // Dispositivo táctil (móvil/tablet): activa el área táctil ampliada y el bottom-sheet.
  const TOUCH = !!(window.matchMedia && window.matchMedia("(pointer: coarse)").matches);

  // Métricas clave del pronóstico (compartidas por la tarjeta de detalle y el sheet).
  function metricasDe(r) {
    const f = r.forecast || {};
    const actual = primerValor(f.high_res) != null ? primerValor(f.high_res) : primerValor(f.med);
    const rets = r.retornos || [];
    let cercano = null;
    if (r.pico != null && rets.length)
      cercano = rets.reduce((a, b) => Math.abs(b.caudal - r.pico) < Math.abs(a.caudal - r.pico) ? b : a);
    return { actual, cercano };
  }

  // Fecha de la corrida del modelo: el fichero YA la trae (source_run_date /
  // inicio_pronostico / emitido). Manda sobre la palabra "actual" para que el
  // número no se lea como el de hoy cuando la corrida es de días atrás.
  function fechaCorrida(r) {
    const bruto = String((r && (r.source_run_date || r.inicio_pronostico || r.emitido)) || "");
    const m = bruto.match(/^(\d{4})-(\d{2})-(\d{2})/);
    const mes = m ? NOM_MES[Number(m[2]) - 1] : null;
    if (!m || !mes) return null;
    return { corta: `${m[3]}/${m[2]}`, larga: `${Number(m[3])} de ${mes} de ${m[1]}` };
  }

  let estado, epocaGlobal = 0, _onTema = null;
  function crear() {
    estado = { mapa: null, tiles: null, capaRios: null, lienzoRios: null,
               marcadores: null, marcadoresScreening: null, capaScreening: null,
               screening: null, overlayActivo: false, overlayFallos: 0,
               items: [], selRid: null, detActual: null,
               ultimoHidro: null, retroDatos: null, epoca: ++epocaGlobal };
  }
  function vigente(E) { return estado === E && E.epoca >= 0; }

  // Teselas TEMÁTICAS: light_all en claro, dark_all en oscuro (pedido del dueño: el
  // exterior de Ecuador no puede quedar blanco en modo oscuro). Re-tileo al conmutar.
  function urlTiles() {
    const osc = App.tema && App.tema() === "oscuro";
    return "https://{s}.basemaps.cartocdn.com/" + (osc ? "dark_all" : "light_all") + "/{z}/{x}/{y}{r}.png";
  }

  // Estilo de la red de ríos — DINÁMICO por tema (claro: azules del papel; oscuro:
  // los azules claros del tema, como --rio-mayor/--rio-menor oscuros de base.css).
  function estiloRios(f) {
    const osc = App.tema && App.tema() === "oscuro";
    const pri = String((f.properties || {}).prioridad || "").trim();
    const mayor = pri === "1" || pri === "2";
    return { color: mayor ? (osc ? "#5AA9E6" : "#1763B6") : (osc ? "#37557A" : "#7FA8D4"),
             weight: mayor ? 1.6 : 0.7, opacity: mayor ? 0.95 : 0.75 };
  }

  /* ---------------- maquetado (propio) ---------------- */
  function cuerpoHTML() {
    return `
      <div class="gg" data-screen-label="Caudales GEOGLOWS">
        <div class="gg-head">
          <div>
            <div class="gg-kicker">Hidrología · caudales modelados</div>
            <h2 class="gg-title">Caudales de ríos — GEOGLOWS</h2>
            <p class="gg-sub">Cribado de la red fluvial nacional y pronóstico de caudal a 15 días
              (GEOGLOWS ECMWF v2). <b>Las señales nacionales no sustituyen el detalle local</b>:
              busca un río disponible o pulsa uno de sus marcadores.</p>
          </div>
          <div class="gg-actions">
            <button class="gg-btn" data-rol="glosario">📖 Guía</button>
            <button class="gg-btn primario" data-rol="actualizar">⟳ Actualizar</button>
          </div>
        </div>
        <section class="gg-card gg-screening" data-rol="screening" aria-live="polite">
          <div class="gg-screening-carga"><span class="spin"></span>
            Examinando la red nacional…</div>
        </section>
        <section class="gg-card gg-selector">
          <label class="gg-sel-lbl" for="gg-sel-input">Río</label>
          <div class="gg-sel-field" data-rol="combo">
            <span class="gg-sel-ic" aria-hidden="true">🔍</span>
            <input id="gg-sel-input" type="text" class="gg-sel-input" data-rol="combo-input"
                   placeholder="Cargando ríos…" autocomplete="off" role="combobox"
                   aria-autocomplete="list" aria-expanded="false" aria-controls="gg-sel-pop" disabled>
            <button class="gg-sel-caret" data-rol="combo-toggle" aria-label="Ver todos los ríos" tabindex="-1">▾</button>
            <div class="gg-sel-pop" id="gg-sel-pop" data-rol="combo-pop" role="listbox" hidden></div>
          </div>
          <span class="gg-sel-count" data-rol="combo-count"></span>
        </section>
        <div class="gg-main">
          <section class="gg-card gg-mapwrap">
            <div class="gg-map" data-rol="mapa"></div>
            <div class="gg-map-hint">Pulsa uno de los puntos de colores (la red azul es solo de fondo)</div>
            <div class="gg-overlay" data-rol="screening-overlay" hidden>
              <div class="gg-overlay-head">
                <button type="button" class="gg-overlay-toggle"
                        data-rol="screening-overlay-toggle" aria-pressed="false">
                  Capa oficial
                </button>
                <span class="gg-overlay-step">intervalo 3 h</span>
              </div>
              <label class="gg-overlay-label" for="gg-screening-time">
                Hora del escenario <output data-rol="screening-time-label">—</output>
              </label>
              <input id="gg-screening-time" data-rol="screening-time" type="range"
                     min="0" max="0" step="1" value="0" disabled>
              <span class="gg-overlay-status" data-rol="screening-overlay-status">
                Superposición desactivada
              </span>
            </div>
            <div class="gg-zoom">
              <button data-rol="zoom+" title="Acercar">+</button>
              <button data-rol="zoom-" title="Alejar">−</button>
              <button data-rol="reset" title="Vista completa">⤢</button>
            </div>
            <div class="gg-leyenda" data-rol="leyenda"></div>
          </section>
          <section class="gg-card gg-hidro">
            <div class="gg-hidro-head"><h3 data-rol="hg-tit">Hidrograma</h3></div>
            <div class="gg-alerta" data-rol="hg-badge"></div>
            <div class="gg-plot" data-rol="hg-plot">
              <div class="gg-empty"><span>Selecciona un río en la lista o pulsa el mapa.</span></div>
            </div>
            <p class="gg-plot-nota" data-rol="hg-nota" hidden>La franja azul es la horquilla
              de escenarios posibles: la clara cubre el rango completo (mín–máx) y la oscura
              la mitad central (25–75 %), la más probable.</p>
          </section>
        </div>
        <section class="gg-card gg-detalle" data-rol="detalle">
          <div class="gg-empty"><span>Selecciona un río para ver sus detalles: métricas del
            pronóstico, umbrales de crecida y contexto histórico.</span></div>
        </section>
        <div class="gg-sheet" data-rol="sheet" hidden></div>
      </div>`;
  }

  function resumenScreeningHTML(screening, detalleDisponible = 0) {
    if (!screening || !screening.ok) return `
      <div class="gg-screening-fallback">
        <b>Cribado nacional no disponible</b>
        <span>El detalle de ${fmt(detalleDisponible)} ríos permanece operativo; no se
          infieren señales nacionales sin el producto oficial.</span>
      </div>`;
    const r = screening.resumen;
    const detalle = r.base_detalle || detalleDisponible;
    const nSenales = screening.senales.length;
    const nEscenarios = screening.escenarios.length;
    const nExcluidas = r.senales_excluidas;
    // Fechas en llano ("del 22 de agosto al 1 de septiembre"), nunca el ISO crudo con T y Z.
    const ini = fechaLlano(r.inicio), fin = fechaLlano(r.fin);
    const ventana = ini && fin ? `del ${ini} al ${fin}` : (ini || fin || "");
    const generadoMs = r.generado ? Date.parse(r.generado) : NaN;
    const generado = Number.isFinite(generadoMs) ? fechaPasoScreening(generadoMs) : null;
    return `
      <div class="gg-screening-grid" role="group" aria-label="Resumen del cribado nacional">
        <div class="gg-screening-metrica">
          <span>Red nacional examinada</span><strong>${fmt(r.catalogo_total)}</strong>
          <small>tramos del catálogo oficial</small>
        </div>
        <div class="gg-screening-metrica">
          <span>Señales creíbles</span><strong>${fmt(r.senales_credibles)}</strong>
          <small>${ventana ? esc(ventana) : "ventana oficial disponible"}</small>
        </div>
        <div class="gg-screening-metrica">
          <span>Ríos con detalle</span><strong>${fmt(detalle)}</strong>
          <small>hidrograma y métricas locales</small>
        </div>
      </div>
      <div class="gg-screening-estados">
        <span class="gg-screening-badge senal"><i></i>
          ${fmt(nSenales)} ${nSenales === 1
            ? "señal oficial RP" : "señales oficiales RP"}</span>
        <span class="gg-screening-badge escenario"><i></i>
          ${fmt(nEscenarios)} ${nEscenarios === 1
            ? "posible escenario" : "posibles escenarios"}</span>
        <span class="gg-screening-excluidas">
          ${fmt(nExcluidas)} ${nExcluidas === 1
            ? "señal excluida" : "señales excluidas"} por control de calidad;
          diagnóstico del paso inicial, no se dibujan como señal</span>
        ${generado ? `<span class="gg-screening-generado">Generado ${esc(generado)}</span>` : ""}
      </div>`;
  }

  function pintarResumenScreening(screening, detalleDisponible = 0) {
    const cont = document.querySelector('[data-rol="screening"]');
    if (cont) cont.innerHTML = resumenScreeningHTML(screening, detalleDisponible);
  }

  /* ---------------- bottom-sheet táctil (P15): valores del río al tap ---------------- */
  function abrirSheet(html) {
    const s = document.querySelector('[data-rol="sheet"]');
    if (!s) return;
    s.innerHTML = html; s.hidden = false;
    const x = s.querySelector('[data-rol="sheet-cerrar"]');
    if (x) x.onclick = () => { s.hidden = true; };
    const v = s.querySelector('[data-rol="sheet-ver"]');
    if (v) v.onclick = () => {
      s.hidden = true;
      const d = document.querySelector(".gg-hidro");
      if (d) d.scrollIntoView({ behavior: "smooth", block: "start" });
    };
  }
  function sheetCabHTML(nombre) {
    return `<div class="gg-sheet-head"><span class="gg-sheet-nom">${esc(nombre)}</span>
      <button class="gg-sheet-x" data-rol="sheet-cerrar" aria-label="Cerrar">✕</button></div>`;
  }
  function sheetHTML(r, nombre) {
    const na = r.nivel_alerta || {};
    const m = metricasDe(r);
    const corrida = fechaCorrida(r);
    return `
      <div class="gg-sheet-head">
        <span class="gg-sheet-nom">${esc(nombre || ("Tramo " + r.river_id))}</span>
        <span class="gg-chip" style="--c:${colorNivel(na)}">${esc(na.etiqueta || "—")}</span>
        <button class="gg-sheet-x" data-rol="sheet-cerrar" aria-label="Cerrar">✕</button>
      </div>
      <div class="gg-sheet-stats">
        <div><span class="lbl">Caudal inicial</span><span class="val">${fmt1(m.actual)}</span><span class="u">m³/s${corrida ? " · corrida " + esc(corrida.corta) : ""}</span></div>
        <div><span class="lbl">Pico probable</span><span class="val">${fmt1(r.pico)}</span><span class="u">m³/s · p75</span></div>
        <div><span class="lbl">RP cercano</span><span class="val">${m.cercano ? "RP " + m.cercano.anios : "—"}</span>
          <span class="u">${m.cercano ? "umbral " + fmt(m.cercano.caudal) + " m³/s" : "sin umbrales"}</span></div>
      </div>
      <button class="gg-btn primario gg-sheet-ver" data-rol="sheet-ver">Ver hidrograma y detalle ↓</button>`;
  }

  function leyendaHTML() {
    const it = (c, t) => `<span><i style="background:${c}"></i>${esc(t)}</span>`;
    return `<b class="gg-leyenda-titulo">Detalle local</b>`
      + it(COLOR_ALERTA[0], "Normal") + it(COLOR_ALERTA[2], "RP 2–5") +
           it(COLOR_ALERTA[10], "RP 10–25") + it(COLOR_ALERTA[50], "RP 50") +
           it(COLOR_ALERTA[100], "RP 100") + it("#6B7785", "Sin dato")
      + `<span class="gg-leyenda-separa" aria-hidden="true"></span>`
      + `<b class="gg-leyenda-titulo">Cribado nacional</b>`
      + `<span><i class="gg-leyenda-screening senal"></i>Señal oficial RP</span>`
      + `<span><i class="gg-leyenda-screening escenario"></i>Posible escenario</span>`;
  }

  /* ---------------- SELECTOR de río con búsqueda por nombre (reemplaza las pastillas) ----
     Combo accesible: un campo con lupa que filtra los ríos vigilados por nombre y despliega
     una lista con su estado (color de alerta), nombre y caudal pico. Al elegir uno, carga su
     hidrograma y detalle. Soporta teclado (↑↓/Enter/Esc) y clic fuera para cerrar. */
  const _norm = s => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

  function montarSelector(items) {
    const campo = document.querySelector('[data-rol="combo"]');
    const input = document.querySelector('[data-rol="combo-input"]');
    const pop = document.querySelector('[data-rol="combo-pop"]');
    const caret = document.querySelector('[data-rol="combo-toggle"]');
    const cuenta = document.querySelector('[data-rol="combo-count"]');
    if (!campo || !input || !pop) return;
    if (!items.length) {
      // En el visor publicado NO existe el botón Actualizar: no pedir una acción imposible.
      input.placeholder = window.HIDROMET_VISOR
        ? "Todavía no hay ríos publicados; se actualizan desde la aplicación de escritorio"
        : "Sin ríos con detalle — pulsa ⟳ Actualizar";
      return;
    }
    input.disabled = false;
    input.placeholder = "Busca un río por nombre…";
    const enAlerta = items.filter(it => it.nivel_alerta && it.nivel_alerta.anios).length;
    if (cuenta) cuenta.innerHTML = `${items.length} ríos con detalle`
      + (enAlerta ? ` · <b style="color:${COLOR_ALERTA[50]}">${enAlerta} con señal local</b>` : "");

    let resaltado = -1, visibles = items.slice();

    const optHTML = (it) => {
      const na = it.nivel_alerta, et = na ? na.etiqueta : "sin pronóstico";
      const sel = estado.selRid && String(estado.selRid) === String(it.river_id);
      return `<div class="gg-opt${sel ? " activo" : ""}" role="option" aria-selected="${sel}">
        <span class="gg-opt-dot" style="background:${colorNivel(na)}"></span>
        <span class="gg-opt-main"><span class="gg-opt-nom">${esc(it.nombre)}</span>
          <span class="gg-opt-sub">${esc(et)}</span></span>
        <span class="gg-opt-pico">${fmt(it.pico)}<i>m³/s</i></span></div>`;
    };
    function pintar() {
      const q = _norm(input.value);
      visibles = q ? items.filter(it => _norm(it.nombre).includes(q)) : items.slice();
      resaltado = -1;
      if (!visibles.length) {
        pop.innerHTML = `<div class="gg-opt-vacio">Ningún río coincide con «${esc(input.value)}»</div>`;
        return;
      }
      pop.innerHTML = visibles.map(optHTML).join("");
      Array.from(pop.querySelectorAll(".gg-opt")).forEach((o, i) => {
        o.onmousedown = (e) => { e.preventDefault(); elegir(visibles[i]); };
        o.onmousemove = () => marcar(i);
      });
    }
    function abrir() { if (pop.hidden) { pop.hidden = false; input.setAttribute("aria-expanded", "true"); } pintar(); }
    function cerrar() { pop.hidden = true; input.setAttribute("aria-expanded", "false"); }
    function marcar(i) {
      resaltado = i;
      pop.querySelectorAll(".gg-opt").forEach((o, k) => o.classList.toggle("resaltado", k === i));
    }
    function verResaltado() { const o = pop.querySelectorAll(".gg-opt")[resaltado]; if (o) o.scrollIntoView({ block: "nearest" }); }
    function elegir(it) {
      if (!it) return;
      input.value = it.nombre; cerrar();
      if (estado.mapa && typeof it.lat === "number") estado.mapa.setView([it.lat, it.lon], 9);
      if (it.river_id) cargarHidrograma(it.river_id, it.nombre, it.lat, it.lon);
      else consultarPunto(it.lat, it.lon);
    }

    input.oninput = abrir;
    input.onfocus = () => { input.select(); abrir(); };
    input.onkeydown = (e) => {
      if (e.key === "ArrowDown") { e.preventDefault(); if (pop.hidden) abrir(); marcar(Math.min(resaltado + 1, visibles.length - 1)); verResaltado(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); marcar(Math.max(resaltado - 1, 0)); verResaltado(); }
      else if (e.key === "Enter") { e.preventDefault(); if (resaltado >= 0 && visibles[resaltado]) elegir(visibles[resaltado]); else if (visibles.length === 1) elegir(visibles[0]); }
      else if (e.key === "Escape") { cerrar(); input.blur(); }
    };
    if (caret) caret.onclick = (e) => { e.preventDefault(); if (pop.hidden) { input.focus(); abrir(); } else cerrar(); };
    // cerrar al hacer clic fuera del combo (listener global; se retira en limpiar()).
    estado._cerrarFuera = (e) => { if (campo && !campo.contains(e.target)) cerrar(); };
    document.addEventListener("mousedown", estado._cerrarFuera);
  }

  // Refleja en el campo del selector el río elegido desde el mapa/marcador.
  function sincronizarSelector(nombre) {
    const input = document.querySelector('[data-rol="combo-input"]');
    if (input) input.value = nombre || "";
  }

  /* ---------------- mapa (propio) ---------------- */
  function iniciarMapa(div) {
    const E = estado;
    const map = L.map(div, { zoomControl: false, attributionControl: false,
      minZoom: 5, maxZoom: 16, maxBoundsViscosity: 0.7 });
    encuadrar(map);   // Ecuador continental centrado desde el arranque
    estado.mapa = map;
    // El contenedor puede terminar de medirse DESPUÉS de crear el mapa (grid recién
    // maquetado) → el encuadre inicial quedaba descentrado. Re-medir y re-encuadrar.
    setTimeout(() => { if (vigente(E) && E.mapa) { E.mapa.invalidateSize(); encuadrar(E.mapa); } }, 80);
    estado.tiles = L.tileLayer(urlTiles(), { subdomains: "abcd", maxZoom: 19, crossOrigin: true }).addTo(map);
    map.createPane("pScreeningRaster").style.zIndex = 350;
    map.getPane("pScreeningRaster").style.pointerEvents = "none";
    map.createPane("pRios").style.zIndex = 370;
    map.createPane("pScreeningSignals").style.zIndex = 390;
    estado.lienzoRios = L.canvas({ padding: 0.5, pane: "pRios" });
    // Clic libre = consulta por lat/lon (on-demand, requiere backend). En el visor (sin
    // backend) solo se navegan los tramos vigilados con river_id congelado: el tap/clic
    // sobre el mapa selecciona el río VIGILADO más cercano (P15: antes el tap sobre la
    // red de ríos no hacía nada en móvil).
    if (!window.HIDROMET_VISOR) map.on("click", (e) => consultarPunto(e.latlng.lat, e.latlng.lng));
    else map.on("click", (e) => elegirEnPunto(e.latlng, TOUCH ? 36 : 22));
    cargarRios();
  }

  // Ríos vigilados cercanos al punto (en PÍXELES de pantalla, no grados) — área
  // táctil generosa e independiente del nivel de zoom, ordenados por distancia.
  function itemsCercanos(latlng, maxPx) {
    if (!estado.mapa) return [];
    const p0 = estado.mapa.latLngToContainerPoint(latlng);
    const cerca = [];
    for (const it of (estado.items || [])) {
      if (typeof it.lat !== "number" || typeof it.lon !== "number") continue;
      const p = estado.mapa.latLngToContainerPoint([it.lat, it.lon]);
      const d = Math.hypot(p.x - p0.x, p.y - p0.y);
      if (d <= maxPx) cerca.push({ it, d });
    }
    return cerca.sort((a, b) => a.d - b.d).map(c => c.it);
  }
  function itemCercano(latlng, maxPx) { return itemsCercanos(latlng, maxPx)[0] || null; }
  // Clic/tap en el mapa del visor: si hay VARIOS ríos casi superpuestos (Babahoyo y
  // Catarama caen a <1 px), preguntar cuál en vez de decidir por el usuario; si no
  // hay ninguno cerca, decir por qué no pasa nada (la red azul no es pulsable).
  function elegirEnPunto(latlng, maxPx) {
    const cerca = itemsCercanos(latlng, maxPx).filter(it => it.river_id);
    if (!cerca.length) {
      App.aviso("Ese tramo no tiene pronóstico detallado; los ríos con detalle son los puntos de colores.", "info", 5000);
      return;
    }
    if (cerca.length === 1) return seleccionarItem(cerca[0]);
    const div = document.createElement("div");
    div.className = "gg-elige";
    div.innerHTML = `<b>Hay varios ríos en este punto:</b>` + cerca.slice(0, 6).map((it, i) =>
      `<button type="button" data-i="${i}"><i style="background:${colorNivel(it.nivel_alerta)}"></i>${esc(it.nombre)}</button>`).join("");
    const pop = L.popup({ closeButton: true, autoClose: true, className: "gg-elige-pop" })
      .setLatLng(latlng).setContent(div).openOn(estado.mapa);
    div.querySelectorAll("button").forEach(b => b.onclick = () => {
      estado.mapa.closePopup(pop);
      seleccionarItem(cerca[Number(b.dataset.i)]);
    });
  }

  function seleccionarItem(it) {
    sincronizarSelector(it && it.nombre);       // refleja la elección del mapa en el selector
    if (it.river_id) cargarHidrograma(it.river_id, it.nombre, it.lat, it.lon);
    else if (!window.HIDROMET_VISOR) consultarPunto(it.lat, it.lon);
  }

  async function cargarRios() {
    const E = estado;
    let gj;
    try { gj = await App.api("/datos/capas/hidrografia.geojson"); }
    catch (e) {
      // Sin la red de fondo el mapa parecería "sin ríos": avisar en vez de callar.
      App.aviso("No se pudo cargar la red de ríos de fondo; los puntos de detalle siguen funcionando.", "info", 6000);
      return;
    }
    if (!vigente(E) || !estado.mapa || (gj && gj.construyendo)) return;
    // Ríos PROMINENTES para que se vea claro dónde hay red seleccionable.
    // Estilo temático (estiloRios); el listener de tema lo re-aplica al conmutar.
    estado.capaRios = L.geoJSON(gj, {
      pane: "pRios", renderer: estado.lienzoRios, interactive: false,
      style: estiloRios,
    }).addTo(estado.mapa);
  }

  function pintarMarcadores(items) {
    if (!estado.mapa) return;
    if (estado.marcadores) estado.mapa.removeLayer(estado.marcadores);
    // TÁCTIL: marcador MÁS GRANDE (objetivo cómodo al dedo) y SIN tooltip sticky. En iOS el
    // tooltip roba el primer toque (muestra el globo en vez de accionar) → el usuario sentía que
    // "no pasa nada". Sin tooltip, el primer tap va directo a cargar el hidrograma.
    const grupo = L.layerGroup();
    for (const it of items) {
      if (typeof it.lat !== "number" || typeof it.lon !== "number") continue;
      // Aro del marcador temático: negro sobre teselas claras, claro sobre las oscuras.
      // El río ELEGIDO se marca con un aro más grueso y un punto mayor, para no
      // perderlo de vista al mover el mapa.
      const sel = estado.selRid != null && String(estado.selRid) === String(it.river_id);
      const m = L.circleMarker([it.lat, it.lon], {
        radius: (TOUCH ? 11 : 8) + (sel ? 3 : 0),
        color: sel ? "#0E94A4" : ((App.tema && App.tema() === "oscuro") ? "#E8EDF6" : "#000000"),
        weight: sel ? 3.2 : 1.5, fillColor: colorNivel(it.nivel_alerta), fillOpacity: 0.95, bubblingMouseEvents: false });
      const na = it.nivel_alerta ? it.nivel_alerta.etiqueta
        : (window.HIDROMET_VISOR ? "sin pronóstico publicado" : "sin pronóstico (pulsa Actualizar)");
      if (!TOUCH) m.bindTooltip(`<b>${esc(it.nombre)}</b><br>${esc(na)}`, { direction: "top", sticky: true });
      const _sel = (e) => {
        if (e) L.DomEvent.stopPropagation(e);
        // Con ríos casi superpuestos (19 parejas a <20 px), el clic sobre el marcador
        // también pregunta cuál si hay más de un candidato bajo el mismo punto.
        if (window.HIDROMET_VISOR) elegirEnPunto(L.latLng(it.lat, it.lon), 12);
        else seleccionarItem(it);
      };
      m.on("click", _sel);           // ratón + tap normalizado por Leaflet
      grupo.addLayer(m);
      if (TOUCH) {
        // P15: ÁREA TÁCTIL ampliada — aro invisible de 24 px de radio con el mismo
        // handler; el dedo ya no necesita acertar a los 11 px visibles.
        const buf = L.circleMarker([it.lat, it.lon], { radius: 24, stroke: false,
          fillColor: "#000", fillOpacity: 0, bubblingMouseEvents: false });
        buf.on("click", _sel);
        grupo.addLayer(buf);
      }
    }
    grupo.addTo(estado.mapa);
    estado.marcadores = grupo;
  }

  function pintarMarcadoresScreening(screening) {
    if (!estado.mapa) return;
    if (estado.marcadoresScreening)
      estado.mapa.removeLayer(estado.marcadoresScreening);
    const grupo = L.layerGroup();
    for (const item of ((screening && screening.ok && screening.visibles) || [])) {
      // Los elementos excluidos se filtran en ``normalizarScreening`` y nunca
      // llegan a esta capa: no pueden adquirir semántica ni color de alerta.
      if (item._tipo === "excluida") continue;
      const senal = item._tipo === "senal_cribado";
      const marcador = L.circleMarker([item.lat, item.lon], {
        pane: "pScreeningSignals", radius: senal ? 9 : 7,
        color: senal ? COLOR_SCREENING_SENAL : COLOR_SCREENING_ESCENARIO,
        weight: senal ? 2.0 : 1.8,
        dashArray: senal ? null : "4 3",
        fillColor: senal ? COLOR_SCREENING_SENAL : COLOR_SCREENING_ESCENARIO,
        fillOpacity: senal ? 0.13 : 0.05,
        bubblingMouseEvents: false,
      });
      const picoMs = numeroFinito(item.peak_time)
        ? Number(item.peak_time) : (item.peak_time ? Date.parse(item.peak_time) : NaN);
      const pico = Number.isFinite(picoMs) ? fechaPasoScreening(picoMs) : "hora no informada";
      const tipo = senal ? "Señal oficial RP" : "Posible escenario";
      marcador.bindTooltip(
        `<b>${esc(tipo)}</b><br>COMID ${esc(item.river_id || "—")}`
        + `<br>Periodo de retorno: ${item.return_period == null ? "—"
          : "RP " + esc(fmt1(item.return_period))}`
        + `<br>Pico: ${esc(pico)}`,
        { direction: "top", sticky: true },
      );
      grupo.addLayer(marcador);
    }
    grupo.addTo(estado.mapa);
    estado.marcadoresScreening = grupo;
  }

  function marcarFalloOverlay(E, mensaje) {
    if (!vigente(E) || !E.mapa) return;
    E.overlayFallos += 1;
    if (E.overlayFallos < 4) return;
    if (E.capaScreening && E.mapa.hasLayer(E.capaScreening))
      E.mapa.removeLayer(E.capaScreening);
    E.overlayActivo = false;
    const panel = document.querySelector('[data-rol="screening-overlay"]');
    const boton = document.querySelector('[data-rol="screening-overlay-toggle"]');
    const rango = document.querySelector('[data-rol="screening-time"]');
    const status = document.querySelector('[data-rol="screening-overlay-status"]');
    if (panel) panel.classList.add("fallo");
    if (boton) {
      boton.setAttribute("aria-pressed", "false");
      boton.disabled = true;
    }
    if (rango) rango.disabled = true;
    if (status) status.textContent = mensaje
      || "La capa oficial no respondió; el mapa y el detalle siguen disponibles.";
  }

  function crearGridLayerScreening(mapserverUrl, obtenerPaso, E) {
    const GridOficial = L.GridLayer.extend({
      createTile(coords, done) {
        const tile = document.createElement("img");
        tile.alt = "";
        tile.setAttribute("role", "presentation");
        tile.crossOrigin = "anonymous";
        const size = this.getTileSize();
        tile.width = size.x; tile.height = size.y;
        const limites = this._tileCoordsToBounds(coords);
        // La tesela Leaflet vive en Web Mercator: pedir la imagen en EPSG:3857
        // evita deformar un bbox geográfico dentro del cuadrado de la tesela.
        const so = L.CRS.EPSG3857.project(limites.getSouthWest());
        const ne = L.CRS.EPSG3857.project(limites.getNorthEast());
        const url = urlExportArcGIS(
          mapserverUrl, obtenerPaso(), [so.x, so.y, ne.x, ne.y], size, 3857);
        L.DomEvent.on(tile, "load", () => done(null, tile));
        L.DomEvent.on(tile, "error", () => {
          const error = new Error("MapServer /export no devolvió una tesela válida.");
          marcarFalloOverlay(E, error.message);
          done(error, tile);
        });
        if (url) tile.src = url;
        else {
          setTimeout(() => {
            const error = new Error("MapServer oficial sin URL /export válida.");
            marcarFalloOverlay(E, error.message);
            done(error, tile);
          }, 0);
        }
        return tile;
      },
    });
    return new GridOficial({
      pane: "pScreeningRaster", tileSize: 256, opacity: 0.68,
      updateWhenIdle: true, keepBuffer: 1, zIndex: 350,
    });
  }

  function montarOverlayTemporal(screening) {
    const panel = document.querySelector('[data-rol="screening-overlay"]');
    const boton = document.querySelector('[data-rol="screening-overlay-toggle"]');
    const rango = document.querySelector('[data-rol="screening-time"]');
    const etiqueta = document.querySelector('[data-rol="screening-time-label"]');
    const status = document.querySelector('[data-rol="screening-overlay-status"]');
    const E = estado;
    if (!panel || !boton || !rango || !etiqueta || !status || !E.mapa) return;
    const pasos = (screening && screening.ok && screening.pasos_tiempo) || [];
    const servicio = servicioExportArcGIS(screening && screening.mapserver_url);
    if (!pasos.length || !servicio.exportUrl) {
      panel.hidden = true;
      return;
    }
    panel.hidden = false;
    panel.classList.remove("fallo");
    rango.min = "0"; rango.max = String(pasos.length - 1);
    rango.value = String(pasos.length - 1);
    const pasoActual = () => pasos[Math.max(0, Math.min(
      pasos.length - 1, Number(rango.value) || 0))];
    const actualizarEtiqueta = () => {
      etiqueta.value = fechaPasoScreening(pasoActual());
      etiqueta.textContent = etiqueta.value;
    };
    actualizarEtiqueta();
    E.overlayFallos = 0;
    E.capaScreening = crearGridLayerScreening(
      screening.mapserver_url, pasoActual, E);
    const activar = activo => {
      if (!vigente(E) || !E.mapa || !E.capaScreening) return;
      E.overlayActivo = activo;
      boton.setAttribute("aria-pressed", String(activo));
      rango.disabled = !activo;
      if (activo) {
        E.overlayFallos = 0;
        E.capaScreening.addTo(E.mapa);
        status.textContent = "Capa oficial activa · producto temporal de 3 h";
      } else {
        if (E.mapa.hasLayer(E.capaScreening))
          E.mapa.removeLayer(E.capaScreening);
        status.textContent = "Superposición desactivada";
      }
    };
    boton.onclick = () => activar(boton.getAttribute("aria-pressed") !== "true");
    rango.oninput = () => {
      actualizarEtiqueta();
      if (vigente(E) && E.capaScreening && E.overlayActivo)
        E.capaScreening.redraw();
    };
  }

  /* ---------------- hidrograma ---------------- */
  async function consultarPunto(lat, lon) {
    sincronizarSelector("");     // un punto libre del mapa no es un río vigilado con nombre
    await cargarHidrograma(null, null, lat, lon);
  }

  async function cargarHidrograma(riverId, nombre, lat, lon) {
    const E = estado;
    const plot = document.querySelector('[data-rol="hg-plot"]');
    const tit = document.querySelector('[data-rol="hg-tit"]');
    const badge = document.querySelector('[data-rol="hg-badge"]');
    const retro = document.querySelector('[data-rol="hg-retro"]');
    if (badge) badge.innerHTML = ""; if (retro) retro.innerHTML = "";
    if (plot) plot.innerHTML = `<div class="gg-empty"><span class="spin"></span><span>Consultando GEOGLOWS… (la primera vez de un tramo puede tardar)</span></div>`;
    if (tit) tit.textContent = nombre ? `Hidrograma — ${nombre}` : "Hidrograma";
    // Móvil (P15): feedback INMEDIATO al tap — el sheet aparece cargando, sin que el
    // usuario tenga que descubrir que el detalle se pintó fuera de pantalla.
    if (TOUCH) abrirSheet(sheetCabHTML(nombre || "Consultando río…") +
      `<div class="gg-sub" style="padding:2px 2px 6px"><span class="spin"></span> Consultando GEOGLOWS…</div>`);
    const q = riverId ? ("river_id=" + encodeURIComponent(riverId)) : (`lat=${lat}&lon=${lon}`);
    let r;
    try { r = await App.api("/geoglows/hidrograma?" + q); }
    catch (e) {
      if (plot) plot.innerHTML = `<div class="gg-empty"><span>${esc(e.message)}</span></div>`;
      if (TOUCH) abrirSheet(sheetCabHTML(nombre || "Río") +
        `<div class="gg-sub" style="padding:2px 2px 6px">${esc(e.message)}</div>`);
      return;
    }
    if (!vigente(E)) return;
    if (r.error) {
      if (plot) plot.innerHTML = `<div class="gg-empty"><span>${esc(r.error)}</span></div>`;
      if (TOUCH) abrirSheet(sheetCabHTML(nombre || "Río") +
        `<div class="gg-sub" style="padding:2px 2px 6px">${esc(r.error)}</div>`);
      return;
    }
    estado.selRid = r.river_id;
    estado.ultimoHidro = { r, nombre };            // para repintar al cambiar de tema
    if (tit) tit.textContent = `Hidrograma — ${nombre || ("tramo " + r.river_id)}`;
    pintarHidrograma(plot, r, nombre);
    pintarBadge(badge, r);
    pintarDetalle(r, nombre);
    pintarMarcadores(estado.items || []);          // resalta el punto del río elegido
    if (TOUCH) abrirSheet(sheetHTML(r, nombre));   // valores del río en el bottom-sheet
    const vr = document.querySelector('[data-rol="ver-retro"]');
    if (vr) vr.onclick = () => cargarRetro(r.river_id);
    // Contexto histórico AUTOMÁTICO: la cifra "Vs. media del mes" no debe quedar en
    // blanco esperando un botón escondido; el dato ya está publicado.
    if (r.river_id) cargarRetro(r.river_id);
  }

  /* ---------------- detalle del río seleccionado (tarjeta bajo el mapa) ---------------- */
  function pintarDetalle(r, nombre) {
    const det = document.querySelector('[data-rol="detalle"]');
    if (!det) return;
    const na = r.nivel_alerta || {};
    // "Caudal al inicio" = primer valor del pronóstico (alta resolución si existe; si no, mediana).
    const { actual, cercano } = metricasDe(r);
    const corrida = fechaCorrida(r);
    estado.detActual = actual;   // lo usa cargarRetro para el % vs. media histórica del mes
    const rets = r.retornos || [];
    const pico = r.pico;
    const filas = rets.map(rp => {
      const sup = pico != null && pico >= rp.caudal;
      return `<tr${sup ? ` class="sup" style="--c:${rp.color}"` : ""}>
        <td><i class="pt" style="background:${rp.color}"></i>RP ${rp.anios} años</td>
        <td class="num">${fmt1(rp.caudal)}</td>
        <td class="est">${sup ? "⚠ superado por el pico" : "—"}</td></tr>`;
    }).join("");
    det.innerHTML = `
      <div class="gg-det-head">
        <div>
          <div class="gg-det-nom">${esc(nombre || ("Tramo " + r.river_id))}</div>
          <div class="gg-det-meta">
            <span class="gg-tag">COMID <b>${esc(r.river_id)}</b></span>
            ${(typeof r.lat === "number" && typeof r.lon === "number")
              ? `<span class="gg-tag">${r.lat.toFixed(3)}°, ${r.lon.toFixed(3)}°</span>` : ""}
            <span class="gg-tag">${esc(r.fuente || "GEOGLOWS ECMWF v2")}</span>
            ${(r.inicio_pronostico || r.emitido)
              ? `<span class="gg-tag">inicio <b>${esc(String(r.inicio_pronostico || r.emitido).slice(0, 10))}</b></span>`
              : ""}
          </div>
        </div>
        <span class="gg-chip" style="--c:${colorNivel(na)}">${esc(na.etiqueta || "—")}</span>
      </div>
      <div class="gg-stats">
        <div class="gg-stat"><span class="lbl">Caudal al inicio del pronóstico</span>
          <span class="val">${fmt1(actual)} <i>m³/s</i></span>
          <span class="sub">${corrida ? `corrida del modelo del ${esc(corrida.larga)}` : "fecha de la corrida no informada"}</span></div>
        <div class="gg-stat"><span class="lbl">Pico probable</span>
          <span class="val">${fmt1(pico)} <i>m³/s</i></span>
          <span class="sub">percentil 75 · 15 días${r.pico_max != null ? ` · peor caso ${fmt(r.pico_max)} m³/s` : ""}</span></div>
        <div class="gg-stat"><span class="lbl">RP más cercano</span>
          <span class="val">${cercano ? `RP ${cercano.anios} <i>años</i>` : "—"}</span>
          <span class="sub">${cercano ? `umbral ${fmt(cercano.caudal)} m³/s` : "sin umbrales"}</span></div>
        <div class="gg-stat"><span class="lbl">Vs. media del mes</span>
          <span class="val" data-rol="stat-hist">—</span>
          <span class="sub" data-rol="stat-hist-sub">calculando con el histórico…</span></div>
      </div>
      ${rets.length ? `
      <div class="gg-tablawrap"><table class="gg-tabla">
        <thead><tr><th>Periodo de retorno</th><th class="num">Umbral (m³/s)</th><th>Estado</th></tr></thead>
        <tbody>${filas}</tbody>
      </table></div>` : ""}
      <div class="gg-retro" data-rol="hg-retro">
        <button class="gg-btn mini" data-rol="ver-retro">📈 Ver contexto histórico (1940→)</button>
      </div>`;
  }

  function pintarBadge(cont, r) {
    if (!cont) return;
    const na = r.nivel_alerta || {};
    cont.innerHTML = `
      <span class="gg-chip" style="--c:${colorNivel(na)}">${esc(na.etiqueta || "—")}</span>
      ${r.pico != null ? `<span class="gg-sub">Pico probable (p75): <b>${r.pico.toLocaleString("es-EC")}</b> ${esc(r.unidad || "m³/s")}</span>` : ""}
      ${r.aviso ? `<span class="gg-sub" style="color:var(--warn,#C5781B)">${esc(r.aviso)}</span>` : ""}`;
  }

  function pintarHidrograma(el, r, nombre) {
    if (!el) return;
    el.innerHTML = "";
    const osc = (App.tema && App.tema() === "oscuro");
    const f = r.forecast || {};
    const x = (f.tiempo || []).map(aHoraEC);   // eje en hora de Ecuador, no UTC
    const linea = (y, nombre, color, dash, width) => ({
      x, y, name: nombre, type: "scatter", mode: "lines", connectgaps: true,
      line: { color, width: width || 2, dash: dash || "solid" },
      hovertemplate: `${nombre}: %{y:.1f} m³/s<extra></extra>` });
    // Las franjas AHORA sí se leen al pasar el ratón ("hasta X / desde Y m³/s").
    const banda = (ylo, yhi, color, nombre) => ([
      { x, y: yhi, type: "scatter", mode: "lines", line: { width: 0 }, name: nombre,
        connectgaps: true, showlegend: false,
        hovertemplate: `${nombre} · hasta %{y:.1f} m³/s<extra></extra>` },
      { x, y: ylo, type: "scatter", mode: "lines", line: { width: 0 }, name: nombre,
        connectgaps: true, fill: "tonexty", fillcolor: color, showlegend: true,
        hovertemplate: `${nombre} · desde %{y:.1f} m³/s<extra></extra>` },
    ]);
    const traces = [];
    if (f.min && f.max) traces.push(...banda(f.min, f.max, osc ? "rgba(93,169,230,0.18)" : "rgba(23,99,182,0.20)", "Rango mín–máx"));
    if (f.p25 && f.p75) traces.push(...banda(f.p25, f.p75, osc ? "rgba(93,169,230,0.34)" : "rgba(23,99,182,0.30)", "Rango 25–75 %"));
    if (f.med) traces.push(linea(f.med, "Mediana", osc ? "#5AA9E6" : "#1763B6", "solid", 2.4));
    if (f.high_res) traces.push(linea(f.high_res, "Alta resolución", osc ? "#2FC2D4" : "#0E94A4", "dot", 1.6));
    // Eje vertical MANDADO por el caudal pronosticado, no por los umbrales de crecida:
    // antes el umbral de 100 años (p. ej. 624 m³/s) entraba como serie y estiraba la
    // escala → la curva real quedaba aplastada abajo en los 50 ríos. Ahora el rango sale
    // del propio pronóstico (+30 % de aire), los umbrales que caben se dibujan como
    // líneas de referencia del fondo, y los que quedan fuera se anotan arriba SIN
    // estirar el eje.
    const valores = [];
    for (const s of [f.min, f.max, f.p25, f.p75, f.med, f.high_res])
      if (Array.isArray(s)) for (const v of s) if (v != null && isFinite(v)) valores.push(Number(v));
    const vMax = valores.length ? Math.max(...valores) : null;
    const vMin = valores.length ? Math.min(...valores) : null;
    const yTope = vMax != null ? vMax * 1.3 : null;
    // Sin forzar a cero cuando el caudal mínimo queda muy lejos de cero (curva plana).
    const yBase = (vMin != null && vMax != null && vMin > 0.35 * vMax) ? vMin * 0.85 : 0;
    const refUmbral = [], notaUmbral = [], fueraEscala = [];
    for (const rp of (r.retornos || [])) {
      if (!numeroFinito(rp && rp.caudal)) continue;
      if (yTope != null && rp.caudal > yTope) { fueraEscala.push(rp); continue; }
      refUmbral.push({ type: "line", xref: "paper", x0: 0, x1: 1, yref: "y", layer: "below",
        y0: rp.caudal, y1: rp.caudal, line: { color: rp.color, width: 1.2, dash: "dash" } });
      notaUmbral.push({ xref: "paper", x: 1, xanchor: "right", yref: "y", y: rp.caudal,
        yanchor: "bottom", showarrow: false, font: { size: 9, color: rp.color },
        text: `crecida de ${rp.anios} años · ${fmt(rp.caudal)} m³/s` });
    }
    if (fueraEscala.length) notaUmbral.push({ xref: "paper", x: 0, xanchor: "left",
      yref: "paper", y: 1, yanchor: "bottom", showarrow: false, align: "left",
      font: { size: 9.5, color: osc ? "#9AA7B8" : "#5B6775" },
      text: "Umbrales muy por encima de lo previsto: " + fueraEscala.map(rp =>
        `crecida de ${rp.anios} años (${fmt(rp.caudal)} m³/s)`).join(" · ") });
    // Marca de HOY: media curva ya es pasado y nada lo señalaba.
    const ahora = aHoraEC(new Date().toISOString());
    if (x.length && ahora >= x[0] && ahora <= x[x.length - 1]) {
      refUmbral.push({ type: "line", xref: "x", x0: ahora, x1: ahora, yref: "paper",
        y0: 0, y1: 1, line: { color: osc ? "#9AA7B8" : "#5B6775", width: 1.3, dash: "dot" } });
      notaUmbral.push({ xref: "x", x: ahora, xanchor: "left", yref: "paper", y: 0.985,
        yanchor: "top", showarrow: false, font: { size: 9.5, color: osc ? "#9AA7B8" : "#5B6775" },
        text: " hoy" });
    }
    // Título propio: la imagen descargada dice de qué río es (antes salía sin nada).
    const titulo = `Caudal pronosticado — ${nombre || ("tramo " + (r.river_id || ""))}`;
    const layout = App.plotlyLayoutSerie(esc(titulo), {
      height: 420, showlegend: true,
      legend: { orientation: "h", y: -0.16, font: { size: 10 } },
      margin: { l: 54, r: 12, t: 40, b: 28 },
      shapes: refUmbral, annotations: notaUmbral,
      yaxis: yTope != null ? { title: "Caudal (m³/s)", range: [yBase, yTope] }
        : { title: "Caudal (m³/s)", rangemode: "tozero" },
      xaxis: { type: "date" },
    });
    Plotly.newPlot(el, traces, layout, configEs());
    // Lector de pantalla: describir qué muestra el gráfico y de cuándo es.
    el.setAttribute("role", "img");
    el.setAttribute("aria-label", `${titulo}: pronóstico de caudal a 15 días en metros cúbicos por segundo, con franjas de escenarios posibles.`);
    // Nota fija que explica las franjas (antes solo vivía en la guía).
    const nota = document.querySelector('[data-rol="hg-nota"]');
    if (nota) nota.hidden = false;
  }

  // Barras del promedio mensual histórico (separado para poder repintarlas al
  // conmutar el tema sin volver a bajar el dato).
  function pintarRetroBarra(el, r) {
    if (!el) return;
    const MES = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];
    const trace = { x: MES, y: r.promedio_mensual || [], type: "bar",
      marker: { color: (App.tema && App.tema() === "oscuro") ? "#5AA9E6" : "#1763B6" }, hovertemplate: "%{x}: %{y:.0f} m³/s<extra></extra>" };
    const layout = App.plotlyLayoutSerie("", { height: 200, showlegend: false,
      margin: { l: 50, r: 10, t: 6, b: 24 }, yaxis: { title: "m³/s", rangemode: "tozero" } });
    Plotly.newPlot(el, [trace], layout, configEs());
    el.setAttribute("role", "img");
    el.setAttribute("aria-label", "Caudal medio mensual histórico desde 1940, en metros cúbicos por segundo.");
  }
  async function cargarRetro(riverId) {
    const E = estado;
    const cont = document.querySelector('[data-rol="hg-retro"]');
    if (cont) cont.innerHTML = `<div class="gg-sub"><span class="spin"></span> Bajando retrospectiva (1940→), una sola vez…</div>`;
    let r;
    const reintento = (msj) => {   // fallo: mensaje + botón para volver a intentarlo
      if (!cont) return;
      cont.innerHTML = `<div class="gg-sub">${esc(msj)}</div>
        <button class="gg-btn mini" data-rol="ver-retro">📈 Reintentar contexto histórico</button>`;
      const b = cont.querySelector('[data-rol="ver-retro"]');
      if (b) b.onclick = () => cargarRetro(riverId);
    };
    try { r = await App.api("/geoglows/retro?river_id=" + encodeURIComponent(riverId)); }
    catch (e) { reintento(e.message); return; }
    if (!vigente(E) || String(estado.selRid) !== String(riverId)) return;   // ya se eligió otro río
    if (r.error) { reintento(r.error); return; }
    estado.retroDatos = r;   // para repintar las barras al conmutar el tema
    // Rellena la métrica "Vs. media del mes" de la fila de stats (caudal actual / promedio
    // histórico del mes en curso, retrospectiva 1940→).
    const prom = (r.promedio_mensual || [])[new Date().getMonth()];
    const stv = document.querySelector('[data-rol="stat-hist"]');
    const sts = document.querySelector('[data-rol="stat-hist-sub"]');
    if (stv && estado.detActual != null && prom > 0) {
      stv.innerHTML = `${fmt(100 * estado.detActual / prom)} <i>%</i>`;
      if (sts) sts.textContent = `media histórica de ${NOM_MES[new Date().getMonth()]}: ${fmt(prom)} m³/s`;
    } else if (sts) { sts.textContent = "sin datos históricos para comparar"; }
    cont.innerHTML = `<div class="gg-hidro-head" style="margin-top:6px"><h3 style="font-size:.95rem">Caudal medio mensual histórico</h3></div>
      <div class="gg-plot" data-rol="retro-plot" style="min-height:200px;height:200px"></div>`;
    pintarRetroBarra(document.querySelector('[data-rol="retro-plot"]'), r);
  }

  /* ---------------- acciones ---------------- */
  async function actualizar() {
    try {
      const id = await App.tarea("/geoglows/actualizar", {});
      App.modalTarea("Actualizar caudales GEOGLOWS", id);
    } catch (e) { App.aviso(e.message, "error"); }
  }

  async function verGlosario() {
    let g;
    try { g = await App.api("/geoglows/glosario"); }
    catch (e) { App.aviso(e.message, "error"); return; }
    const secs = (g.secciones || []).map(s =>
      `<div class="gloss-sec"><b>${esc(s.titulo)}</b><div class="gg-sub">${esc(s.texto)}</div></div>`).join("");
    // Ventana NORMAL (mismo marco .modal del resto de la aplicación): con botón de
    // cerrar, con scroll y SIN temporizador — antes era un aviso de esquina que se
    // borraba solo a los 16 segundos con el texto cortado.
    const fondo = document.createElement("div");
    fondo.className = "modal-fondo";
    fondo.innerHTML = `<div class="modal gg-guia" role="dialog" aria-modal="true" aria-label="${esc(g.titulo || "Guía")}">
      <header><span>${esc(g.titulo || "Guía de caudales")}</span>
        <button class="gg-btn" data-rol="guia-cerrar" aria-label="Cerrar la guía">✕ Cerrar</button></header>
      <div class="cuerpo"><div class="gg-sub" style="margin-bottom:8px">${esc(g.intro || "")}</div>${secs}</div>
    </div>`;
    const cerrar = () => fondo.remove();
    fondo.addEventListener("click", (e) => { if (e.target === fondo) cerrar(); });
    fondo.querySelector('[data-rol="guia-cerrar"]').onclick = cerrar;
    document.addEventListener("keydown", function escGuia(e) {
      if (e.key === "Escape") { cerrar(); document.removeEventListener("keydown", escGuia); }
    });
    document.body.appendChild(fondo);
  }

  /* ---------------- ciclo de vida ---------------- */
  async function render(cont) {
    crear();
    cont.innerHTML = cuerpoHTML();
    document.querySelector('[data-rol="leyenda"]').innerHTML = leyendaHTML();
    cont.querySelector('[data-rol="actualizar"]').onclick = actualizar;
    cont.querySelector('[data-rol="glosario"]').onclick = verGlosario;
    cont.querySelector('[data-rol="zoom+"]').onclick = () => estado.mapa && estado.mapa.zoomIn();
    cont.querySelector('[data-rol="zoom-"]').onclick = () => estado.mapa && estado.mapa.zoomOut();
    cont.querySelector('[data-rol="reset"]').onclick = () => encuadrar(estado.mapa);
    iniciarMapa(cont.querySelector('[data-rol="mapa"]'));

    if (_onTema) document.removeEventListener("temacambiado", _onTema);
    // Cambio de tema DINÁMICO sin re-navegar: re-tilea (light_all/dark_all), re-estila
    // la red de ríos y repinta los marcadores con el aro del tema nuevo.
    _onTema = () => {
      if (!estado) return;
      if (estado.tiles) estado.tiles.setUrl(urlTiles());
      if (estado.capaRios) estado.capaRios.setStyle(estiloRios);
      pintarMarcadores(estado.items || []);
      pintarMarcadoresScreening(estado.screening);
      // Los gráficos también siguen al tema (antes quedaban ilegibles hasta re-elegir el río).
      if (estado.ultimoHidro) {
        const plot = document.querySelector('[data-rol="hg-plot"]');
        if (plot) pintarHidrograma(plot, estado.ultimoHidro.r, estado.ultimoHidro.nombre);
      }
      if (estado.retroDatos) {
        const rp = document.querySelector('[data-rol="retro-plot"]');
        if (rp) pintarRetroBarra(rp, estado.retroDatos);
      }
    };
    document.addEventListener("temacambiado", _onTema);

    const E = estado;
    const [watchlistReq, screeningReq] = await Promise.allSettled([
      App.api("/geoglows/watchlist"),
      App.api("/geoglows/screening"),
    ]);
    if (!vigente(E)) return;
    const w = watchlistReq.status === "fulfilled" ? watchlistReq.value : null;
    if (watchlistReq.status === "rejected")
      App.aviso("GEOGLOWS (detalle): " + watchlistReq.reason.message, "error");
    else if (w && w.disponible === false)
      App.aviso(w.error || "Detalle GEOGLOWS no disponible.", "error", 8000);
    estado.items = (w && Array.isArray(w.items)) ? w.items : [];
    montarSelector(estado.items);
    pintarMarcadores(estado.items);
    if (screeningReq.status === "fulfilled") {
      const screening = normalizarScreening(screeningReq.value);
      estado.screening = screening;
      pintarResumenScreening(screening, estado.items.length);
      pintarMarcadoresScreening(screening);
      montarOverlayTemporal(screening);
    } else {
      estado.screening = null;
      pintarResumenScreening(null, estado.items.length);
    }
  }

  function limpiar() {
    if (_onTema) { document.removeEventListener("temacambiado", _onTema); _onTema = null; }
    if (estado && estado._cerrarFuera) { document.removeEventListener("mousedown", estado._cerrarFuera); estado._cerrarFuera = null; }
    if (estado) estado.epoca = -1;
    if (estado && estado.mapa) { try { estado.mapa.remove(); } catch (e) {} estado.mapa = null; }
    // También los Plotly propios (hidrograma/retrospectiva) — dejan listeners de window.
    if (window.Plotly) document.querySelectorAll("#vista .js-plotly-plot").forEach(el => { try { Plotly.purge(el); } catch (e) { /* ya purgado */ } });
  }

  window.GEOGLOWS_SCREENING_UI = Object.freeze({
    _tipoItemScreening: tipoItemScreening,
    _normalizarScreening: normalizarScreening,
    _servicioExportArcGIS: servicioExportArcGIS,
    _urlExportArcGIS: urlExportArcGIS,
    _resumenScreeningHTML: resumenScreeningHTML,
  });

  App.panel("geoglows", render);
  App.panel("geoglows:purgar", limpiar);
})();
