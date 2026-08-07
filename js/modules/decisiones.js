/* ============================================================
   DECISIONES OPERATIVAS — pestaña del módulo Pronóstico.
   REDISEÑO v18 (pedido del dueño 2026-07-10): panel claro y bello,
   sin chips "+N días" ni párrafos sueltos.

   Jerarquía de la vista:
     0) Barra superior: navegación de FECHA con flechas ◀ vie 11/07 ▶
        (una fecha visible a la vez; rango = mañana .. +5 días) y el
        buscador de estación.
     1) VEREDICTO del día (tarjeta protagonista): lluvia SÍ/NO con
        probabilidad, Tmax/Tmin puntuales y la
        tendencia térmica — todo como KPIs con iconografía sobria.
     2) MAPA nacional con el veredicto de lluvia DEL DÍA ELEGIDO por
        estación (si está acreditado: color = decisión y tamaño = distancia
        al corte del 50 %; los provisionales quedan neutrales;
        tooltip rico;
        pinch-zoom vía App.pinchZoomMapa).
     3) EVIDENCIA strict-as-issued del MISMO producto, cuando existe,
        como contexto secundario COLAPSABLE.

   Datos: reúsa los productos congelados del visor — /mlnwp/veredicto
   (?codigo=X para mañana; &dia=2..5 para el resto del horizonte) y
   /mlnwp/validacion_estacion (solo tmax/tmin, ventana 30). No sustituye
   la validación ausente del veredicto probabilístico con métricas de
   precip_det, que corresponde a otra regla y otros modelos. Los
   veredictos del mapa se cargan por LOTES y se cachean por
   (estación, día).

   Expone window.DECISIONES = { render(cont), alDejar() }; cartas.js
   la monta como pestaña de Pronóstico (patrón lazy/alSalir).
   ============================================================ */
"use strict";

(() => {
  const esc = v => String(v ?? "").replace(/[&<>"']/g,
    c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const num = (v, nd = 1) => (v === null || v === undefined || Number.isNaN(v)) ? "—" : Number(v).toFixed(nd);
  const sgn = v => (v === null || v === undefined || Number.isNaN(v)) ? "—"
    : (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(Number(v)).toFixed(1);
  const normTxt = s => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

  // Redes fijas (mismo contrato que mlnwp.js). En el visor el slug de mlnwp/*
  // descarta 'deps' (core.js/rutaAProducto = exportar_web): QS inocuo allí y
  // correcto contra el backend vivo.
  const DEPS_QS = "deps=" + encodeURIComponent(
    "INAMHI,CELEC,Hidronación,EPMAPS");
  // Ventana de la VALIDACIÓN de las decisiones (nº de fechas; producto congelado).
  const VENTANA = "30";
  const DIA_MIN = 1, DIA_MAX = 5;   // horizonte navegable: mañana .. +5 días

  // Colores del veredicto en el MAPA (lienzo = papel blanco fijo, regla de
  // Pronóstico → colores fijos, sin tokens de tema).
  const C_SI = "#1B6ACB", C_NO = "#93A1B4", C_SIN = "#E3E9F1";
  const C_SIN_BORDE = "#B9C3D0";

  // Distancia de la probabilidad emitida al corte operativo del 50 %. Esto mide
  // únicamente cuán lejos queda la regla de decisión de su frontera; NO es
  // confianza, calibración ni habilidad verificada.
  // Devuelve [categoría descriptiva, tamaño de marcador px, distancia en pp].
  function distanciaDecision(prob) {
    if (prob === null || prob === undefined || Number.isNaN(prob))
      return ["Sin dato", 6.5, null];
    const d = Math.abs(Number(prob) - 50);
    if (d >= 30) return ["Lejos del corte", 16, d];
    if (d >= 15) return ["Distancia intermedia", 12, d];
    return ["Cerca del corte", 9, d];
  }

  // Nombre legible de los modelos que emiten el veredicto de temperatura.
  const MODELO_ET = { BEST_OP_CV: "Selector operativo", CONSENSO_OP_TOP5: "Consenso top-5" };
  const etModelo = m => MODELO_ET[m] || m || "—";

  // Badge de calificación 1-10 (misma escala RdYlGn que la tabla de mlnwp.js).
  const RDYLGN = ["#D73027", "#F46D43", "#FDAE61", "#FEE08B", "#D9EF8B",
                  "#A6D96A", "#66BD63", "#1A9850"];
  function calBadge(r) {
    if (r === null || r === undefined || Number.isNaN(r))
      return `<span class="ml-calif-badge" style="background:var(--surface-3);color:var(--muted)">—</span>`;
    const t = Math.max(0, Math.min(1, (Number(r) - 1) / 9));
    const bg = RDYLGN[Math.min(RDYLGN.length - 1, Math.floor(t * RDYLGN.length))];
    const fg = (bg === "#1A9850" || bg === "#D73027") ? "#fff" : "#1E1E1E";
    return `<span class="ml-calif-badge" title="Calificación 1–10 del modelo en esta estación" style="background:${bg};color:${fg}">${num(r, 1)}</span>`;
  }
  const confClase = c => ({ Alta: "alta", Media: "media", Baja: "baja" }[c] || "sin");
  const pillConf = c => `<span class="ml-pill ${confClase(c)}">${esc(c || "Sin calificar")}</span>`;

  // Iconografía SOBRIA (SVG stroke, hereda currentColor).
  const ICO_GOTA = `<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M12 3.2s6.3 7 6.3 11.1a6.3 6.3 0 1 1-12.6 0C5.7 10.2 12 3.2 12 3.2z"/></svg>`;
  const ICO_TERMO = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M10.5 4.5a1.8 1.8 0 0 1 3.6 0v8.6a4 4 0 1 1-3.6 0z"/></svg>`;

  /* ---------------- estado del módulo ---------------- */
  const S = {
    cont: null,          // contenedor de la pestaña (re-render tras actualizar)
    ests: [],            // estaciones del contexto (codigo, nombre, lat, lon, region, dependencia)
    geojson: null,       // provincias (null = sin pedir, false = no disponible)
    cache: new Map(),    // "codigo|dia" -> veredicto | false (sin producto / falló)
    valCache: new Map(), // codigo -> {vtx, vtn, vdet} (validación: no depende del día)
    dia: 1,              // día visible: 1 = mañana .. 5
    sel: "",             // estación seleccionada
    idxMark: -1,         // índice del trace de marcadores dentro del plot
  };
  // Contadores de generación: invalidan lotes/panel en vuelo al salir de la
  // pestaña, re-renderizar o cambiar de día (App.api no cancela).
  let gen = 0, genPanel = 0;

  const cargando = msg => `<div class="vacio"><div class="icono">⏳</div>${esc(msg || "Cargando…")}</div>`;
  const vacio = msg => `<div class="vacio"><div class="icono">∅</div>${esc(msg)}</div>`;
  const ddmm = f => (f && f.length >= 10) ? `${f.slice(8, 10)}/${f.slice(5, 7)}` : "—";

  /* ---------------- fechas del horizonte ---------------- */
  const DIAS_SEM = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];

  // ISO (YYYY-MM-DD) de hoy+n en TZ Ecuador — el MISMO criterio del backend.
  function fechaISO(n) {
    const hoy = App.hoyEC ? App.hoyEC() : new Date().toISOString().slice(0, 10);
    const d = new Date(`${hoy}T12:00:00`);   // mediodía: inmune a DST
    d.setDate(d.getDate() + n);
    const p = x => String(x).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }
  // 'vie 11/07' a partir de una fecha ISO.
  function fmtFecha(iso) {
    if (!iso || iso.length < 10) return "—";
    const d = new Date(`${iso}T12:00:00`);
    return `${DIAS_SEM[d.getDay()]} ${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
  }
  const etiquetaDia = n => (n === 1 ? "mañana" : `dentro de ${n} días`);

  function purgarPlots() {
    if (!window.Plotly) return;
    const el = document.getElementById("dec-mapa");
    if (el) { try { Plotly.purge(el); } catch (e) { /* ya purgado */ } }
  }

  /* ============================================================
     Veredictos: cache por (estación, día). Día 1 usa la URL base sin
     '&dia' (el producto congelado histórico); 2..5 llevan '&dia=N'.
     ============================================================ */
  const kDia = (cod, dia) => `${cod}|${dia}`;
  const vDe = (cod, dia) => S.cache.get(kDia(String(cod), dia ?? S.dia));

  async function pedirVeredicto(cod, dia) {
    const url = dia === 1
      ? `/mlnwp/veredicto?codigo=${encodeURIComponent(cod)}`
      : `/mlnwp/veredicto?codigo=${encodeURIComponent(cod)}&dia=${dia}`;
    let v;
    try { v = await App.api(url); } catch (e) { v = false; }
    S.cache.set(kDia(cod, dia), v);
    return v;
  }

  // Carga los veredictos del DÍA VISIBLE para todas las estaciones, por lotes
  // de 8 (límite de conexiones del navegador; backend vivo calcula por
  // estación). El mapa se colorea progresivamente por lote.
  async function cargarVeredictosDia(mi) {
    const dia = S.dia;
    const pend = S.ests.map(e => String(e.codigo)).filter(c => !S.cache.has(kDia(c, dia)));
    let hechas = S.ests.length - pend.length;
    pintarResumenMapa(hechas, S.ests.length);
    const LOTE = 8;
    for (let i = 0; i < pend.length; i += LOTE) {
      if (mi !== gen || dia !== S.dia) return;
      await Promise.all(pend.slice(i, i + LOTE).map(c => pedirVeredicto(c, dia)));
      if (mi !== gen || dia !== S.dia) return;
      hechas += Math.min(LOTE, pend.length - i);
      refrescarMapa();
      pintarResumenMapa(hechas, S.ests.length);
    }
  }

  /* ============================================================
     MAPA (patrón "continental" de mlnwp.js: lon/lat como x/y, relieve
     blanco + contorno negro con halo blanco; papel blanco en ambos temas).
     ============================================================ */
  const ECU = { W: -81.3, E: -75.0, S: -5.1, N: 1.6 };

  function outlineTrace(wNegro = 2) {
    if (!S.geojson || !S.geojson.features) return [];
    const xs = [], ys = [];
    const empuja = ring => {
      for (const [lon, lat] of ring) { xs.push(lon); ys.push(lat); }
      xs.push(null); ys.push(null);
    };
    for (const f of S.geojson.features) {
      const g = f.geometry; if (!g) continue;
      if (g.type === "Polygon") g.coordinates.forEach(empuja);
      else if (g.type === "MultiPolygon") g.coordinates.forEach(p => p.forEach(empuja));
    }
    if (!xs.length) return [];
    const base = { type: "scatter", mode: "lines", x: xs, y: ys, hoverinfo: "skip", showlegend: false };
    return [
      Object.assign({}, base, { line: { color: "#ffffff", width: 3.4 } }),
      Object.assign({}, base, { line: { color: "#000000", width: wNegro } }),
    ];
  }

  function landTrace() {
    if (!S.geojson || !S.geojson.features) return null;
    const xs = [], ys = [];
    const empuja = ring => { for (const [lo, la] of ring) { xs.push(lo); ys.push(la); } xs.push(null); ys.push(null); };
    for (const f of S.geojson.features) {
      const g = f.geometry; if (!g) continue;
      if (g.type === "Polygon") g.coordinates.forEach(empuja);
      else if (g.type === "MultiPolygon") g.coordinates.forEach(p => p.forEach(empuja));
    }
    if (!xs.length) return null;
    return { type: "scatter", mode: "lines", x: xs, y: ys, fill: "toself", hoverinfo: "skip",
      fillcolor: "rgba(255,255,255,.95)", line: { color: "rgba(0,0,0,0)", width: 0 }, showlegend: false };
  }

  // Estilo + tooltip RICO de cada marcador según el veredicto del día visible.
  function marcadores() {
    const fTxt = fmtFecha(fechaISO(S.dia));
    const color = [], size = [], lineColor = [], lineWidth = [], hover = [];
    for (const e of S.ests) {
      const cod = String(e.codigo);
      const v = vDe(cod);                    // undefined = aún cargando
      const ll = (v && v.lluvia) || null;
      const operativa = !!(ll && ll.operacional === true
        && ll.estado_promocion === "ACCREDITED");
      const [, tam, distanciaPp] = distanciaDecision(
        operativa ? ll.prob : null);
      let col = C_SIN, borde = C_SIN_BORDE;
      if (operativa && ll.llueve === true) { col = C_SI; borde = "#ffffff"; }
      else if (operativa && ll.llueve === false) { col = C_NO; borde = "#ffffff"; }
      const selec = cod === String(S.sel);
      color.push(col);
      size.push(v === undefined ? 7 : tam);
      lineColor.push(selec ? "#0F1B2D" : borde);
      lineWidth.push(selec ? 3 : 1.6);

      const red = redEst(e);
      let h = `<b>${esc(e.nombre)}</b> · ${esc(cod)}<br><span style="color:#5A6678">${esc(App.redEtiqueta(e.region) || "—")}${red ? ` · ${esc(red)}` : ""}</span>`;
      if (v === undefined) h += `<br>Cargando veredicto…`;
      else if (!v || v.sin_datos) h += `<br>Sin veredicto publicado`;
      else {
        if (ll) {
          h += operativa
            ? `<br>Lluvia ${fTxt}: <b>${esc(ll.texto || "—")}</b>${ll.prob != null ? ` · ${ll.prob} %` : ""}`
            : `<br>Probabilidad provisional no calibrada: ${ll.prob != null ? `${ll.prob} %` : "—"} · sin veredicto`;
          if (operativa && distanciaPp != null)
            h += ` · a ${distanciaPp.toFixed(0)} pp del corte`;
          const extra = [];
          if (ll.prob_fuerte != null) extra.push(`≥10 mm: ${ll.prob_fuerte} %`);
          if (extra.length) h += `<br>${extra.join(" · ")}`;
        } else h += `<br>Lluvia ${fTxt}: sin dato`;
        if (v.tmax && v.tmax.valor != null)
          h += `<br>Tmax ${num(v.tmax.valor)} °C${(v.tmin && v.tmin.valor != null) ? ` · Tmin ${num(v.tmin.valor)} °C` : ""}`;
        if (v.tendencia) h += `<br>Tendencia: ${esc(v.tendencia.texto)} (${sgn(v.tendencia.delta)} °C)`;
      }
      h += `<br><span style="color:#8794A5">clic → veredicto completo</span>`;
      hover.push(h);
    }
    return { color, size, lineColor, lineWidth, hover };
  }

  function dibujarMapa() {
    const el = document.getElementById("dec-mapa");
    if (!el) return;
    if (!window.Plotly) { el.innerHTML = `<div class="vacio">Plotly no disponible</div>`; return; }
    const traces = [];
    const land = landTrace();
    if (land) traces.push(land);
    traces.push(...outlineTrace(2));
    const m = marcadores();
    traces.push({ type: "scatter", mode: "markers",
      x: S.ests.map(e => e.lon), y: S.ests.map(e => e.lat),
      text: m.hover, hoverinfo: "text",
      hoverlabel: { bgcolor: "#ffffff", bordercolor: "#C6CFDB", align: "left",
        font: { family: "IBM Plex Sans, sans-serif", size: 12, color: "#0F1B2D" } },
      marker: { color: m.color, size: m.size, line: { color: m.lineColor, width: m.lineWidth } } });
    S.idxMark = traces.length - 1;
    const layout = App.plotlyLayoutBase({
      showlegend: false, margin: { l: 0, r: 0, t: 0, b: 0 },
      paper_bgcolor: "#ffffff", plot_bgcolor: "#ffffff",
      xaxis: { range: [ECU.W, ECU.E], showgrid: false, zeroline: false, visible: false, fixedrange: false },
      yaxis: { range: [ECU.S, ECU.N], showgrid: false, zeroline: false, visible: false,
               scaleanchor: "x", scaleratio: 1, fixedrange: false },
      dragmode: "pan",
    });
    Plotly.newPlot(el, traces, layout, App.plotlyConfig({ scrollZoom: true })).then(() => {
      if (App.pinchZoomMapa) App.pinchZoomMapa(el);   // pinza = zoom del mapa
      el.on("plotly_click", ev => {
        const p = ev.points && ev.points[0];
        if (!p || p.curveNumber !== S.idxMark) return;
        const e = S.ests[p.pointNumber];
        if (e) elegir(e.codigo);
      });
    });
  }

  // Recolorea los marcadores SIN redibujar el mapa (restyle del trace).
  function refrescarMapa() {
    const el = document.getElementById("dec-mapa");
    if (!el || !el.data || S.idxMark < 0 || !window.Plotly) return;
    const m = marcadores();
    Plotly.restyle(el, {
      "marker.color": [m.color], "marker.size": [m.size],
      "marker.line.color": [m.lineColor], "marker.line.width": [m.lineWidth],
      text: [m.hover],
    }, [S.idxMark]);
  }

  // Resumen bajo el mapa: progreso de carga o conteo SÍ/NO del día visible.
  function pintarResumenMapa(hechas, total) {
    const el = document.getElementById("dec-prog");
    if (!el) return;
    if (hechas < total) { el.textContent = `cargando… ${hechas}/${total}`; return; }
    let si = 0, no = 0, sin = 0;
    for (const e of S.ests) {
      const v = vDe(String(e.codigo));
      const ll = v && v.lluvia;
      if (ll && ll.llueve === true) si++;
      else if (ll && ll.llueve === false) no++;
      else sin++;
    }
    el.textContent = `SÍ en ${si} · NO en ${no}${sin ? ` · sin dato ${sin}` : ""}`;
  }

  /* ============================================================
     NAVEGACIÓN DE FECHA — ◀ vie 11/07 ▶ (una fecha a la vez).
     ============================================================ */
  function pintarNav() {
    const f = document.getElementById("dec-fecha");
    const sub = document.getElementById("dec-fecha-sub");
    if (f) f.textContent = fmtFecha(fechaISO(S.dia));
    if (sub) sub.textContent = etiquetaDia(S.dia);
    const bA = document.getElementById("dec-nav-prev"), bS = document.getElementById("dec-nav-next");
    if (bA) bA.disabled = S.dia <= DIA_MIN;
    if (bS) bS.disabled = S.dia >= DIA_MAX;
    const tit = document.getElementById("dec-mapa-tit");
    if (tit) tit.textContent = `¿Dónde llueve el ${fmtFecha(fechaISO(S.dia))}?`;
  }

  function cambiarDia(delta) {
    const n = Math.max(DIA_MIN, Math.min(DIA_MAX, S.dia + delta));
    if (n === S.dia) return;
    S.dia = n;
    pintarNav();
    refrescarMapa();                       // pinta lo cacheado del nuevo día ya
    pintarPanel();
    const mi = ++gen;                      // cancela el lote del día anterior
    cargarVeredictosDia(mi);
  }

  /* ============================================================
     BUSCADOR de estación (combobox de mlnwp.js, catálogo = contexto).
     ============================================================ */
  function etiquetaEst() {
    const e = S.ests.find(x => String(x.codigo) === String(S.sel));
    return e ? `${e.codigo} · ${e.nombre} · ${redEst(e)}` : "";
  }

  const redEst = e => e ? (e.red_etiqueta || App.redEtiqueta(e.dependencia || e.red_id || "")) : "";

  function opcionesComboHTML(q) {
    const nq = normTxt(q);
    const visibles = S.ests.filter(e => !nq ||
      normTxt(`${e.codigo} ${e.nombre} ${e.region} ${redEst(e)}`).includes(nq));
    if (!visibles.length) return `<div class="ml-combo-vacia">Sin coincidencias.</div>`;
    let html = "", region = null;
    for (const e of visibles) {
      if (e.region !== region) {
        region = e.region;
        html += `<div class="ml-combo-grupo">${esc(App.redEtiqueta(region))}</div>`;
      }
      html += `<button type="button" class="ml-combo-op ${String(e.codigo) === String(S.sel) ? "activa" : ""}" data-cod="${esc(e.codigo)}">
        <span class="cod">${esc(e.codigo)}</span><span class="nom">${esc(e.nombre)}</span>
        <span class="dep">${esc(redEst(e))}</span></button>`;
    }
    return html;
  }

  function bindCombo(combo) {
    const input = combo.querySelector("#dec-est-input");
    const lista = combo.querySelector("#dec-est-lista");
    // Reset de scroll en CADA re-render (mismo fix que el combobox de mlnwp.js).
    const refrescar = q => { lista.innerHTML = opcionesComboHTML(q); lista.scrollTop = 0; };
    const abrir = () => { lista.hidden = false; refrescar(""); input.select(); };
    const cerrar = () => { lista.hidden = true; input.value = etiquetaEst(); };
    input.onfocus = abrir;
    input.onblur = () => setTimeout(() => {
      if (combo.contains(document.activeElement)) { input.focus(); return; }
      cerrar();
    }, 0);
    input.oninput = () => { lista.hidden = false; refrescar(input.value); };
    input.onkeydown = ev => {
      if (ev.key === "Escape") { input.blur(); return; }
      if (lista.hidden && (ev.key === "ArrowDown" || ev.key === "Enter")) { ev.preventDefault(); abrir(); return; }
      const ops = [...lista.querySelectorAll(".ml-combo-op")];
      if (!ops.length) return;
      let i = ops.findIndex(o => o.classList.contains("sel"));
      if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
        ev.preventDefault();
        i = ev.key === "ArrowDown" ? Math.min(ops.length - 1, i + 1) : Math.max(0, Math.max(i, 0) - 1);
        ops.forEach((o, j) => o.classList.toggle("sel", j === i));
        ops[i].scrollIntoView({ block: "nearest" });
      } else if (ev.key === "Enter") {
        ev.preventDefault();
        const obj = i >= 0 ? ops[i] : ops[0];
        if (obj) { input.blur(); elegir(obj.dataset.cod); }
      }
    };
    lista.onmousedown = ev => { if (ev.target.closest(".ml-combo-op")) ev.preventDefault(); };
    lista.onclick = ev => {
      const b = ev.target.closest(".ml-combo-op");
      if (b) { input.blur(); elegir(b.dataset.cod); }
    };
  }

  function elegir(cod) {
    S.sel = String(cod);
    const input = document.getElementById("dec-est-input");
    if (input) input.value = etiquetaEst();
    refrescarMapa();   // resalta el marcador seleccionado (aro oscuro)
    pintarPanel();
  }

  /* ============================================================
     TARJETA 1 — VEREDICTO del día (protagonista).
     ============================================================ */
  async function pintarPanel() {
    const cont = document.getElementById("dec-panel");
    const contV = document.getElementById("dec-desemp");
    if (!cont) return;
    if (!S.sel) {
      cont.innerHTML = `<div class="ml-card dec-hint"><div class="vacio"><div class="icono">🗺️</div>
        <strong>Elige una estación</strong>
        <span>Toca un punto del mapa o búscala arriba: verás el veredicto del día y la evidencia disponible del mismo producto.</span></div></div>`;
      if (contV) contV.innerHTML = "";
      return;
    }
    const mi = ++genPanel;
    cont.innerHTML = `<div class="ml-card dec-verd">${cargando("Cargando veredicto…")}</div>`;
    let v = vDe(S.sel);
    if (v === undefined) {
      v = await pedirVeredicto(S.sel, S.dia);
      refrescarMapa();
    }
    if (mi !== genPanel || !cont.isConnected) return;
    cont.innerHTML = tarjetaVeredictoHTML(v);

    // Evidencia del mismo producto (colapsable): no depende del día → cache.
    // No se consulta precip_det: sus POD/FAR/CSI pertenecen a decisiones
    // deterministas por valor, no al promedio probabilístico de este veredicto.
    if (!contV) return;
    const abierto = !!contV.querySelector("details[open]");
    contV.innerHTML = "";
    let val = S.valCache.get(S.sel);
    if (!val) {
      const pide = b => App.api(`/mlnwp/validacion_estacion?bloque=${b}&ventana=${VENTANA}&${DEPS_QS}&codigo=${encodeURIComponent(S.sel)}`).catch(() => null);
      const [vtx, vtn] = await Promise.all([pide("tmax"), pide("tmin")]);
      val = { vtx, vtn };
      S.valCache.set(S.sel, val);
    }
    if (mi !== genPanel || !contV.isConnected) return;
    contV.innerHTML = tarjetaDesempenoHTML(v, val, abierto);
  }

  // KPI de temperatura: valor grande + intervalo Q25–Q75 + modelo emisor.
  function kpiTemp(lab, t) {
    if (!t || t.valor == null) {
      return `<div class="dec-kpi"><div class="lab"><span class="ico">${ICO_TERMO}</span>${lab}</div>
        <div class="valor dec-sin">—</div><div class="rango">sin dato</div></div>`;
    }
    return `<div class="dec-kpi">
      <div class="lab"><span class="ico">${ICO_TERMO}</span>${lab}</div>
      <div class="valor">${num(t.valor)}<small>°C</small></div>
      <div class="fuente" title="Modelo que emite el valor">${esc(etModelo(t.modelo))}</div>
    </div>`;
  }

  function tarjetaVeredictoHTML(v) {
    const e = S.ests.find(x => String(x.codigo) === String(S.sel)) || {};
    const fEsp = fechaISO(S.dia);              // fecha que el usuario está viendo
    const cab = `<div class="dec-verd-cab">
      <div class="dec-verd-est"><b>${esc(e.nombre || S.sel)}</b>
        <span>${esc(S.sel)} · ${esc(App.redEtiqueta(e.region) || "—")}${redEst(e) ? ` · ${esc(redEst(e))}` : ""}</span></div>
      <div class="dec-verd-fecha">${esc(fmtFecha((v && v.fecha) || fEsp))}</div>
    </div>`;
    if (!v || v.sin_datos) {
      return `<div class="ml-card dec-verd">${cab}${vacio("Sin veredicto para esta estación (sin pronóstico vigente o producto no publicado).")}</div>`;
    }
    const ll = v.lluvia, tx = v.tmax, tn = v.tmin, td = v.tendencia;
    // En el visor los productos envejecen: si la fecha emitida no coincide con la
    // fecha navegada (calculada en el CLIENTE, TZ Ecuador), se avisa en ámbar.
    const viejo = v.fecha && v.fecha !== fEsp;

    // HERO lluvia: la decisión del día en una franja protagonista.
    let hero;
    if (!ll) {
      hero = `<div class="dec-hero sin">
        <span class="dec-hero-ico">${ICO_GOTA}</span>
        <div class="dec-hero-main"><div class="k">Lluvia (P ≥ 1 mm)</div>
          <div class="v dec-sin">sin dato</div></div>
      </div>`;
    } else {
      const operativa = ll.operacional === true
        && ll.estado_promocion === "ACCREDITED";
      const cls = operativa && ll.llueve === true
        ? "si" : (operativa && ll.llueve === false ? "no" : "sin");
      const [distanciaTxt, , distanciaPp] = distanciaDecision(
        operativa ? ll.prob : null);
      const prob = ll.prob != null ? Math.max(0, Math.min(100, ll.prob)) : null;
      hero = `<div class="dec-hero ${cls}">
        <span class="dec-hero-ico">${ICO_GOTA}</span>
        <div class="dec-hero-main">
          <div class="k">${operativa ? "Lluvia (P ≥ 1 mm)" : "Probabilidad provisional (≥ 1 mm)"}</div>
          <div class="v">${esc(ll.texto || "—")}${prob != null ? `<small>${prob} %</small>` : ""}</div>
          ${prob != null ? `<div class="dec-prob-barra" role="img" aria-label="Probabilidad ${prob} %"><i style="width:${prob}%"></i><u style="left:50%"></u></div>` : ""}
        </div>
        <div class="dec-hero-lado">
          <div class="mini"><span class="k">Lluvia fuerte ≥ 10 mm</span><span class="v">${ll.prob_fuerte != null ? `${ll.prob_fuerte} %` : "—"}</span></div>
          ${operativa
            ? `<div class="mini" title="${esc(distanciaTxt)}; no representa confianza ni skill"><span class="k">Distancia al corte</span><span class="v">${distanciaPp == null ? "—" : `${distanciaPp.toFixed(0)} pp`}</span></div>`
            : '<div class="mini"><span class="k">Uso</span><span class="v">No calibrada</span></div>'}
        </div>
      </div>`;
    }
    const pieLluvia = ll && ll.operacional === true
      && ll.estado_promocion === "ACCREDITED"
      ? "Lluvia: curva acreditada strict-as-issued; SÍ cuando P(≥1 mm) ≥ 50 %."
      : "Lluvia: producto provisional no calibrado, visible solo como información y sin decisión.";

    // KPI de tendencia térmica (vs hoy).
    let kpiTend = `<div class="dec-kpi"><div class="lab"><span class="ico">→</span>Tendencia</div>
      <div class="valor dec-sin">—</div><div class="rango">sin referencia de hoy</div></div>`;
    if (td) {
      const flecha = td.texto === "más cálido" ? "↑" : (td.texto === "más frío" ? "↓" : "→");
      const cls = td.texto === "más cálido" ? "calido" : (td.texto === "más frío" ? "frio" : "");
      kpiTend = `<div class="dec-kpi dec-kpi-tend ${cls}">
        <div class="lab"><span class="ico">${flecha}</span>Tendencia</div>
        <div class="valor" style="font-size:19px">${esc(td.texto)}</div>
        <div class="rango">${sgn(td.delta)} °C vs hoy (${num(td.tmax_hoy)} °C)</div>
        <div class="fuente">${esc(td.referencia || "hoy")}</div>
      </div>`;
    }

    return `<div class="ml-card dec-verd">
      ${cab}
      ${viejo ? `<div class="dec-stale">⚠ Veredicto emitido para el ${ddmm(v.fecha)} — los productos publicados envejecen hasta la próxima actualización.</div>` : ""}
      ${hero}
      <div class="dec-kpis">
        ${kpiTemp("T. máxima", tx)}
        ${kpiTemp("T. mínima", tn)}
        ${kpiTend}
      </div>
      <p class="ml-pie">Tmax/Tmin = valor puntual del selector operativo. ${pieLluvia} Agregación ${esc(v.agg_precip || "07-07")}.</p>
    </div>`;
  }

  /* ============================================================
     TARJETA 2 — EVIDENCIA del mismo producto (colapsable, secundaria).
     ============================================================ */
  function filaSinEvidencia(etiqueta, motivo) {
    return `<div class="dec-val-fila"><span class="var">${etiqueta}</span>
      <span class="suave" style="font-size:12px">${esc(motivo)}</span></div>`;
  }

  function filaMismoProducto(etiqueta, d, modeloPref, metHTML) {
    if (!modeloPref)
      return filaSinEvidencia(
        etiqueta, "El veredicto no identifica un modelo emisor verificable.");
    const fila = d && (d.modelos || []).find(m =>
      m.modelo === modeloPref && m.estandar === "A_AS_ISSUED"
      && Number(m.n) > 0);
    if (!fila)
      return filaSinEvidencia(
        etiqueta,
        `Sin métricas strict-as-issued del modelo emisor ${modeloPref}.`,
      );
    return `<div class="dec-val-fila">
      <span class="var">${etiqueta}</span>
      <span class="mod"><span class="ml-mod-punto" style="background:${esc(fila.color || "#888")}"></span>${esc(fila.modelo)}</span>
      <span class="met">${metHTML(fila)}</span>
      ${calBadge(fila.rating)}
      ${pillConf(fila.confianza)}
      <span class="n">${fila.n} fechas</span>
    </div>`;
  }

  function tarjetaDesempenoHTML(v, val, abierto) {
    const { vtx, vtn } = val || {};
    const modTx = v && v.tmax && v.tmax.modelo;
    const modTn = v && v.tmin && v.tmin.modelo;
    return `<details class="ml-card dec-desemp-card"${abierto ? " open" : ""}>
      <summary><span class="dec-desemp-tit">Evidencia del mismo veredicto</span>
        <span class="ml-sutil">strict-as-issued · hasta ${VENTANA} fechas</span>
        <span class="dec-desemp-chev">▾</span></summary>
      <div class="dec-val-filas">
        ${filaMismoProducto("T. máxima", vtx, modTx, m => `MAE ${num(m.mae)} °C`)}
        ${filaMismoProducto("T. mínima", vtn, modTn, m => `MAE ${num(m.mae)} °C`)}
        ${filaSinEvidencia("Lluvia sí/no", "Sin métricas strict-as-issued del mismo veredicto probabilístico.")}
      </div>
      <p class="ml-pie">Temperatura muestra solo el modelo que emitió el valor y su validación A as-issued. La lluvia no reutiliza POD/FAR/CSI de un detector determinista distinto: hasta validar esta misma cohorte y regla, se declara sin evidencia.</p>
    </details>`;
  }

  /* ============================================================
     RENDER raíz.
     ============================================================ */
  const CHEV = `<span class="ml-loc-chev"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#95A1B2" stroke-width="2.5"><path d="M6 9l6 6 6-6" stroke-linecap="round" stroke-linejoin="round"></path></svg></span>`;
  const MIRA = `<span class="ml-loc-mira"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#1B6ACB" stroke-width="2"><circle cx="12" cy="12" r="6"></circle><path d="M12 1v4M12 19v4M1 12h4M19 12h4" stroke-linecap="round"></path></svg></span>`;
  const FLECHA_I = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 6l-6 6 6 6"/></svg>`;
  const FLECHA_D = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>`;

  function raizHTML() {
    return `
      <div class="dec-raiz" data-screen-label="Decisiones operativas">
        <div class="dec-top">
          <div class="dec-fecha-nav" role="group" aria-label="Día del veredicto">
            <button type="button" class="dec-nav-btn" id="dec-nav-prev" title="Día anterior" aria-label="Día anterior">${FLECHA_I}</button>
            <div class="dec-fecha-caja">
              <span class="dec-fecha-txt" id="dec-fecha"></span>
              <span class="dec-fecha-sub" id="dec-fecha-sub"></span>
            </div>
            <button type="button" class="dec-nav-btn" id="dec-nav-next" title="Día siguiente" aria-label="Día siguiente">${FLECHA_D}</button>
          </div>
          <div class="dec-buscador">
            <div class="ml-loc ml-combo" id="dec-combo-est">
              ${MIRA}
              <input id="dec-est-input" type="text" placeholder="Buscar estación por código, nombre, región o dependencia…" autocomplete="off" spellcheck="false">
              ${CHEV}
              <div class="ml-combo-lista" id="dec-est-lista" tabindex="-1" hidden></div>
            </div>
          </div>
        </div>
        <div class="dec-layout">
          <div class="dec-panel" id="dec-panel"></div>
          <div class="ml-card dec-mapa-card">
            <div class="dec-mapa-cab"><span id="dec-mapa-tit"></span><span class="dec-prog" id="dec-prog"></span></div>
            <div class="dec-mapa" id="dec-mapa"></div>
            <div class="dec-leyenda">
              <span class="it"><span class="pt" style="background:${C_SI}"></span>Sí llueve</span>
              <span class="it"><span class="pt" style="background:${C_NO}"></span>No llueve</span>
              <span class="it"><span class="pt chico" style="background:${C_SIN};box-shadow:inset 0 0 0 1.5px ${C_SIN_BORDE}"></span>Sin dato</span>
              <span class="it dec-ley-tam">● tamaño = distancia al corte 50 %</span>
            </div>
          </div>
          <div class="dec-desemp" id="dec-desemp"></div>
        </div>
      </div>`;
  }

  window.DECISIONES = {
    async render(vista) {
      S.cont = vista;
      const mi = ++gen;
      vista.innerHTML = `<div class="dec-raiz">${cargando("Cargando estaciones…")}</div>`;
      let ctx;
      try {
        [ctx] = await Promise.all([
          App.api("/mlnwp/contexto"),
          (async () => {
            if (S.geojson !== null) return;
            try { S.geojson = await App.api("/mlnwp/geojson/provincias"); }
            catch (e) { S.geojson = false; }
          })(),
        ]);
      } catch (e) {
        if (mi === gen) vista.innerHTML = `<div class="dec-raiz">${vacio("No se pudo cargar el contexto de estaciones: " + e.message)}</div>`;
        return;
      }
      if (mi !== gen) return;
      S.ests = ((ctx && ctx.estaciones) || [])
        .filter(e => e.lat != null && e.lon != null)
        .sort((a, b) => String(a.region).localeCompare(String(b.region))
          || String(a.nombre).localeCompare(String(b.nombre)));
      if (!S.ests.length) {
        vista.innerHTML = `<div class="dec-raiz">${vacio("No hay estaciones en el catálogo ML-NWP.")}</div>`;
        return;
      }
      if (S.sel && !S.ests.some(e => String(e.codigo) === String(S.sel))) S.sel = "";
      vista.innerHTML = raizHTML();
      const combo = vista.querySelector("#dec-combo-est");
      if (combo) bindCombo(combo);
      const input = vista.querySelector("#dec-est-input");
      if (input) input.value = etiquetaEst();
      const bA = vista.querySelector("#dec-nav-prev"), bS = vista.querySelector("#dec-nav-next");
      if (bA) bA.onclick = () => cambiarDia(-1);
      if (bS) bS.onclick = () => cambiarDia(+1);
      pintarNav();
      dibujarMapa();
      pintarPanel();
      await cargarVeredictosDia(mi);
    },
    alDejar() {
      gen++; genPanel++;   // invalida lotes y panel en vuelo
      purgarPlots();       // libera la instancia Plotly y su listener de resize
    },
  };

  // Tras CUALQUIER actualización de datos: los caches quedan viejos → se vacían;
  // si la pestaña está montada, se re-renderiza con datos frescos.
  document.addEventListener("datos-actualizados", () => {
    S.cache.clear();
    S.valCache.clear();
    S.geojson = null;
    if (S.cont && S.cont.isConnected && S.cont.querySelector(".dec-raiz")) {
      try { window.DECISIONES.render(S.cont); } catch (e) { /* re-render best effort */ }
    }
  });
})();
