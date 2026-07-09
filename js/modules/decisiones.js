/* ============================================================
   DECISIONES OPERATIVAS — pestaña del módulo Pronóstico (pedido
   textual del dueño: "un submenú con el mapa de ecuador y en cada
   estación poder desplegar los resultados y al lado la validación
   de esas decisiones operativas").

   Layout 2 columnas: IZQUIERDA mapa Plotly de Ecuador continental
   (papel blanco FIJO en ambos temas — es Pronóstico; contorno negro,
   patrón de mlnwp.js/clima.js) con las estaciones coloreadas por el
   VEREDICTO de lluvia de mañana (SÍ azul / NO gris) y tamaño por la
   confianza de esa decisión. DERECHA panel de la estación elegida:
   (a) el veredicto desplegado (Tmax/Tmin más probables ± Q25-Q75,
   lluvia SÍ/NO con probabilidad y rango, tendencia térmica) y
   (b) la VALIDACIÓN de esas decisiones (MAE del modelo que emite la
   temperatura + POD/FAR/CSI de la detección de lluvia, calificación
   1-10 y confianza muestral).

   Datos: REÚSA los productos ya CONGELADOS por estación en el visor
   (/mlnwp/veredicto?codigo=X y /mlnwp/validacion_estacion con bloques
   tmax/tmin/precip_det, ventana 30) — sin endpoints nuevos. Los 101
   veredictos del mapa se cargan por LOTES (el mapa se colorea
   progresivamente) y quedan cacheados en memoria hasta la próxima
   actualización de datos.

   Expone window.DECISIONES = { render(cont), alDejar() }; cartas.js
   la monta como pestaña de Pronóstico con el MISMO patrón lazy/alSalir
   que "Series, validación e IA" (window.MLNWP).
   ============================================================ */
"use strict";

(() => {
  const esc = v => String(v ?? "").replace(/[&<>"']/g,
    c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const num = (v, nd = 1) => (v === null || v === undefined || Number.isNaN(v)) ? "—" : Number(v).toFixed(nd);
  const num2 = v => (v === null || v === undefined || Number.isNaN(v)) ? "—" : Number(v).toFixed(2);
  const sgn = v => (v === null || v === undefined || Number.isNaN(v)) ? "—"
    : (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(Number(v)).toFixed(1);
  const normTxt = s => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

  // Redes fijas (mismo contrato que mlnwp.js). En el visor el slug de mlnwp/*
  // descarta 'deps' (core.js/rutaAProducto = exportar_web), así que este QS es
  // inocuo allí y correcto contra el backend vivo.
  const DEPS_QS = "deps=" + encodeURIComponent("INAMHI,CELEC,Hidronación");
  // Ventana de la VALIDACIÓN de las decisiones (nº de fechas). El producto
  // validacion_estacion está congelado para las ventanas {7,15,30,todo}: 30 es
  // el equilibrio robustez/actualidad que usa mlnwp.js por defecto.
  const VENTANA = "30";

  // Colores del veredicto en el MAPA. El lienzo es papel BLANCO fijo en ambos
  // temas (es Pronóstico) → colores fijos, sin tokens.
  const C_SI = "#1B6ACB", C_NO = "#9AA6B6", C_SIN = "#D7DDE6";
  // Tamaño del marcador por CONFIANZA de la decisión de lluvia = qué tan lejos
  // de 50 % quedó la probabilidad calibrada (decisión firme vs dudosa). Mismo
  // patrón de tamaños que TAM_CONF de mlnwp.js (Alta grande / Baja pequeño).
  function confDecision(prob) {
    if (prob === null || prob === undefined || Number.isNaN(prob)) return ["Sin dato", 6];
    const d = Math.abs(Number(prob) - 50);
    if (d >= 30) return ["Alta", 15];
    if (d >= 15) return ["Media", 11];
    return ["Baja", 8];
  }

  // Nombre legible de los modelos que emiten el veredicto de temperatura.
  const MODELO_ET = { BEST_OP_CV: "BEST_OP (selector IA)", CONSENSO_OP_TOP5: "Consenso top-5" };
  const etModelo = m => MODELO_ET[m] || m || "—";

  // Badge de calificación 1-10 (misma escala RdYlGn que la tabla de mlnwp.js).
  const RDYLGN = ["#D73027", "#F46D43", "#FDAE61", "#FEE08B", "#D9EF8B",
                  "#A6D96A", "#66BD63", "#1A9850"];
  function calBadge(r) {
    if (r === null || r === undefined || Number.isNaN(r))
      return `<span class="ml-calif-badge" style="background:var(--surface-3);color:var(--muted)">—</span>`;
    const t = Math.max(0, Math.min(1, (Number(r) - 1) / 9));
    const bg = RDYLGN[Math.min(RDYLGN.length - 1, Math.floor(t * RDYLGN.length))];
    const fg = (Number(r) >= 7.5) ? "#fff" : "#1E1E1E";
    return `<span class="ml-calif-badge" title="Calificación 1–10 del modelo en esta estación" style="background:${bg};color:${fg}">${num(r, 1)}</span>`;
  }
  const confClase = c => ({ Alta: "alta", Media: "media", Baja: "baja" }[c] || "sin");
  const pillConf = c => `<span class="ml-pill ${confClase(c)}">${esc(c || "Sin calificar")}</span>`;

  /* ---------------- estado del módulo ---------------- */
  const S = {
    cont: null,          // contenedor de la pestaña (para re-render tras actualizar)
    ests: [],            // estaciones del contexto (codigo, nombre, lat, lon, region, dependencia)
    geojson: null,       // provincias (null = sin pedir, false = no disponible)
    cache: new Map(),    // codigo -> veredicto | false (sin producto / falló)
    cacheDia: new Map(), // "codigo|dia" -> veredicto multi-día (v16)
    dia: 1,              // horizonte del panel: 1=mañana .. 5 (v16, pedido del dueño)
    sel: "",             // estación seleccionada
    idxMark: -1,         // índice del trace de marcadores dentro del plot
  };
  // Contadores de generación: invalidan respuestas async en vuelo cuando el
  // usuario sale de la pestaña o re-renderiza (App.api no cancela).
  let gen = 0, genPanel = 0;

  const cargando = msg => `<div class="vacio"><div class="icono">⏳</div>${esc(msg || "Cargando…")}</div>`;
  const vacio = msg => `<div class="vacio"><div class="icono">∅</div>${esc(msg)}</div>`;
  const ddmm = f => (f && f.length >= 10) ? `${f.slice(8, 10)}/${f.slice(5, 7)}` : "—";

  function purgarPlots() {
    if (!window.Plotly) return;
    const el = document.getElementById("dec-mapa");
    if (el) { try { Plotly.purge(el); } catch (e) { /* ya purgado */ } }
  }

  /* ============================================================
     MAPA base (mismo patrón "continental" de mlnwp.js: lon/lat como
     x/y, relieve blanco + contorno negro con halo blanco).
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
    // Papel blanco fijo → halo blanco + línea negra SIEMPRE (ambos temas).
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

  // Arrays de estilo de los marcadores según el veredicto cacheado de cada
  // estación (se recalculan por lote y se aplican con Plotly.restyle).
  function marcadores() {
    const color = [], size = [], lineColor = [], lineWidth = [], hover = [];
    for (const e of S.ests) {
      const cod = String(e.codigo);
      const v = S.cache.get(cod);           // undefined = aún cargando
      const ll = (v && v.lluvia) || null;
      const [conf, tam] = confDecision(ll ? ll.prob : null);
      let col = C_SIN;
      if (ll && ll.llueve === true) col = C_SI;
      else if (ll && ll.llueve === false) col = C_NO;
      const selec = cod === String(S.sel);
      color.push(col);
      size.push(v === undefined ? 7 : tam);
      lineColor.push(selec ? "#0F1B2D" : "#ffffff");
      lineWidth.push(selec ? 3 : 1.6);
      let h = `<b>${esc(e.nombre)}</b> · ${esc(cod)}<br>${esc(e.region || "—")}`;
      if (v === undefined) h += `<br>Cargando veredicto…`;
      else if (!v) h += `<br>Sin veredicto publicado`;
      else {
        if (ll) h += `<br>Lluvia mañana: <b>${esc(ll.texto || "—")}</b>${ll.prob != null ? ` (${ll.prob} %)` : ""} · confianza ${conf}`;
        else h += `<br>Lluvia mañana: sin dato`;
        if (v.tmax && v.tmax.valor != null)
          h += `<br>Tmax ${num(v.tmax.valor)} °C${(v.tmin && v.tmin.valor != null) ? ` · Tmin ${num(v.tmin.valor)} °C` : ""}`;
      }
      h += `<br><span style="color:#8794A5">clic → veredicto y validación</span>`;
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
      marker: { color: m.color, size: m.size, line: { color: m.lineColor, width: m.lineWidth } } });
    S.idxMark = traces.length - 1;
    const layout = App.plotlyLayoutBase({
      showlegend: false, margin: { l: 0, r: 0, t: 0, b: 0 },
      // Lienzo de mapa = papel BLANCO en ambos temas (regla de Pronóstico).
      paper_bgcolor: "#ffffff", plot_bgcolor: "#ffffff",
      xaxis: { range: [ECU.W, ECU.E], showgrid: false, zeroline: false, visible: false, fixedrange: false },
      yaxis: { range: [ECU.S, ECU.N], showgrid: false, zeroline: false, visible: false,
               scaleanchor: "x", scaleratio: 1, fixedrange: false },
      dragmode: "pan",
    });
    Plotly.newPlot(el, traces, layout, App.plotlyConfig({ scrollZoom: true })).then(() => {
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

  function pintarProgreso(hechas, total) {
    const el = document.getElementById("dec-prog");
    if (!el) return;
    if (hechas < total) { el.textContent = `cargando veredictos… ${hechas}/${total}`; return; }
    let si = 0, no = 0, sin = 0;
    for (const e of S.ests) {
      const v = S.cache.get(String(e.codigo));
      const ll = v && v.lluvia;
      if (ll && ll.llueve === true) si++;
      else if (ll && ll.llueve === false) no++;
      else sin++;
    }
    el.textContent = `lluvia SÍ en ${si} · NO en ${no}${sin ? ` · sin veredicto ${sin}` : ""}`;
  }

  // Carga los veredictos de TODAS las estaciones por lotes de 8 (el navegador
  // limita las conexiones y el backend vivo calcula por estación); el mapa se
  // colorea progresivamente por lote. Cache en memoria: re-entrar a la pestaña
  // es instantáneo hasta la próxima actualización de datos.
  async function cargarVeredictos(mi) {
    const cods = S.ests.map(e => String(e.codigo));
    const pend = cods.filter(c => !S.cache.has(c));
    let hechas = cods.length - pend.length;
    pintarProgreso(hechas, cods.length);
    const LOTE = 8;
    for (let i = 0; i < pend.length; i += LOTE) {
      if (mi !== gen) return;
      await Promise.all(pend.slice(i, i + LOTE).map(async cod => {
        try { S.cache.set(cod, await App.api(`/mlnwp/veredicto?codigo=${encodeURIComponent(cod)}`)); }
        catch (e) { S.cache.set(cod, false); }
      }));
      if (mi !== gen) return;
      hechas += Math.min(LOTE, pend.length - i);
      refrescarMapa();
      pintarProgreso(hechas, cods.length);
    }
  }

  /* ============================================================
     BUSCADOR de estación (mismo patrón combobox de mlnwp.js, con el
     reset de scroll al filtrar; catálogo fijo = las 101 del contexto).
     ============================================================ */
  function etiquetaEst() {
    const e = S.ests.find(x => String(x.codigo) === String(S.sel));
    return e ? `${e.codigo} · ${e.nombre} (${e.region})` : "";
  }

  function opcionesComboHTML(q) {
    const nq = normTxt(q);
    const visibles = S.ests.filter(e => !nq ||
      normTxt(`${e.codigo} ${e.nombre} ${e.region} ${e.dependencia || ""}`).includes(nq));
    if (!visibles.length) return `<div class="ml-combo-vacia">Sin coincidencias.</div>`;
    let html = "", region = null;
    for (const e of visibles) {
      if (e.region !== region) {
        region = e.region;
        html += `<div class="ml-combo-grupo">${esc(region)}</div>`;
      }
      html += `<button type="button" class="ml-combo-op ${String(e.codigo) === String(S.sel) ? "activa" : ""}" data-cod="${esc(e.codigo)}">
        <span class="cod">${esc(e.codigo)}</span><span class="nom">${esc(e.nombre)}</span>
        <span class="dep">${esc(e.dependencia || "")}</span></button>`;
    }
    return html;
  }

  function bindCombo(combo) {
    const input = combo.querySelector("#dec-est-input");
    const lista = combo.querySelector("#dec-est-lista");
    // Reset de scroll en CADA re-render (mismo fix que el combobox de mlnwp.js:
    // sin él, las opciones filtradas caían fuera de la ventana visible).
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
     PANEL derecho: veredicto desplegado + validación de la decisión.
     ============================================================ */
  async function pintarPanel() {
    const cont = document.getElementById("dec-panel");
    if (!cont) return;
    if (!S.sel) {
      cont.innerHTML = `<div class="ml-card dec-hint"><div class="vacio"><div class="icono">🗺️</div>
        <strong>Selecciona una estación</strong>
        <span>Haz clic en un punto del mapa (o búscala arriba) para desplegar su veredicto de mañana y la validación de esas decisiones.</span></div></div>`;
      return;
    }
    const mi = ++genPanel;
    cont.innerHTML = `<div class="ml-card">${cargando("Cargando veredicto y validación…")}</div>`;
    // Veredicto: para MAÑANA sale del cache del mapa; para +2..+5 días (v16) se pide
    // su producto congelado propio (&dia=N) con cache aparte.
    let v;
    if (S.dia === 1) {
      v = S.cache.get(S.sel);
      if (v === undefined) {
        try { v = await App.api(`/mlnwp/veredicto?codigo=${encodeURIComponent(S.sel)}`); }
        catch (e) { v = false; }
        S.cache.set(S.sel, v);
        refrescarMapa();
      }
    } else {
      const k = `${S.sel}|${S.dia}`;
      v = S.cacheDia.get(k);
      if (v === undefined) {
        try { v = await App.api(`/mlnwp/veredicto?codigo=${encodeURIComponent(S.sel)}&dia=${S.dia}`); }
        catch (e) { v = false; }
        S.cacheDia.set(k, v);
      }
    }
    // Validación de la decisión: MAE de temperatura (bloques tmax/tmin) +
    // detección de lluvia (bloque precip_det: POD/FAR/CSI). Cada bloque es
    // OPCIONAL: si un producto no está publicado, la fila lo dice.
    const val = b => App.api(`/mlnwp/validacion_estacion?bloque=${b}&ventana=${VENTANA}&${DEPS_QS}&codigo=${encodeURIComponent(S.sel)}`).catch(() => null);
    const [vtx, vtn, vdet] = await Promise.all([val("tmax"), val("tmin"), val("precip_det")]);
    if (mi !== genPanel || !cont.isConnected) return;   // llegó una selección más nueva
    cont.innerHTML = tarjetaVeredictoHTML(v) + tarjetaValidacionHTML(v, vtx, vtn, vdet);
    // v16: chips de horizonte (Mañana · +2 … +5 días) — recargan solo el panel.
    cont.querySelectorAll("[data-dia]").forEach(b => b.onclick = () => {
      const n = +b.dataset.dia;
      if (n !== S.dia) { S.dia = n; pintarPanel(); }
    });
  }

  function tarjetaVeredictoHTML(v) {
    const e = S.ests.find(x => String(x.codigo) === String(S.sel)) || {};
    // v16: horizonte seleccionable (la decisión operativa cubre mañana a +5 días).
    const chips = [1, 2, 3, 4, 5].map(n =>
      `<button class="dec-dia ${S.dia === n ? "activo" : ""}" data-dia="${n}">${n === 1 ? "Mañana" : `+${n} días`}</button>`).join("");
    const fTxt = (v && v.fecha) ? ` · ${v.fecha.slice(8, 10)}/${v.fecha.slice(5, 7)}` : "";
    const cab = `<h3 class="ml-titulo">Veredicto ${S.dia === 1 ? "para mañana" : `a +${S.dia} días`}${fTxt}
      <span class="ml-sutil">· ${esc(e.nombre || S.sel)} (${esc(S.sel)}) · ${esc(e.region || "—")}</span></h3>
      <div class="dec-dias">${chips}</div>`;
    if (!v || v.sin_datos) {
      return `<div class="ml-card dec-verd">${cab}${vacio("Sin veredicto para esta estación (sin pronóstico vigente o producto no publicado).")}</div>`;
    }
    const ll = v.lluvia, tx = v.tmax, tn = v.tmin, td = v.tendencia;
    // En el visor los productos envejecen: si la fecha del veredicto ya no es
    // "mañana" (TZ Ecuador, calculado en el CLIENTE), se avisa en ámbar.
    const hoy = App.hoyEC ? App.hoyEC() : null;
    const viejo = hoy && v.fecha && v.fecha <= hoy;
    const kpiTemp = (lab, t) => {
      if (!t || t.valor == null) return `<div class="dec-kpi"><div class="lab"><span>${lab}</span></div>
        <div class="valor dec-sin">—</div><div class="rango">sin dato</div></div>`;
      return `<div class="dec-kpi">
        <div class="lab"><span>${lab}</span><span class="mod" title="Modelo que emite el valor">${esc(etModelo(t.modelo))}</span></div>
        <div class="valor">${num(t.valor)}<small>°C</small></div>
        <div class="rango">${(t.q25 != null && t.q75 != null) ? `50 % probable: ${num(t.q25)}–${num(t.q75)} °C` : "sin rango probabilístico"}</div>
      </div>`;
    };
    let kpiLluvia;
    if (!ll) {
      kpiLluvia = `<div class="dec-kpi dec-kpi-lluvia"><div class="lab"><span>Lluvia mañana (P ≥ 1 mm)</span></div>
        <div class="valor dec-sin">—</div><div class="rango">sin dato probabilístico</div></div>`;
    } else {
      const cls = ll.llueve === true ? "si" : (ll.llueve === false ? "no" : "");
      const [conf] = confDecision(ll.prob);
      const partes = [];
      if (ll.q25 != null && ll.q75 != null) partes.push(`rango probable ${num(ll.q25)}–${num(ll.q75)} mm`);
      if (ll.prob_fuerte != null) partes.push(`lluvia fuerte (≥10 mm): ${ll.prob_fuerte} %`);
      kpiLluvia = `<div class="dec-kpi dec-kpi-lluvia ${cls}">
        <div class="lab"><span>Lluvia mañana (P ≥ 1 mm)</span><span class="mod">confianza de la decisión: ${conf}</span></div>
        <div class="valor">${esc(ll.texto || "—")}${ll.prob != null ? `<small>${ll.prob} % de probabilidad</small>` : ""}</div>
        <div class="rango">${partes.join(" · ") || "&nbsp;"}</div>
      </div>`;
    }
    let kpiTend = `<div class="dec-kpi"><div class="lab"><span>Tendencia térmica</span></div>
      <div class="valor dec-sin">—</div><div class="rango">sin referencia de hoy</div></div>`;
    if (td) {
      const flecha = td.texto === "más cálido" ? "↑" : (td.texto === "más frío" ? "↓" : "→");
      kpiTend = `<div class="dec-kpi">
        <div class="lab"><span>Tendencia térmica</span><span class="mod">vs ${esc(td.referencia || "hoy")}</span></div>
        <div class="valor">${flecha} <span style="font-size:17px">${esc(td.texto)}</span></div>
        <div class="rango">${sgn(td.delta)} °C respecto a hoy (${num(td.tmax_hoy)} °C)</div>
      </div>`;
    }
    return `<div class="ml-card dec-verd">
      ${cab}
      <div class="ml-sutil" style="font-size:12px;color:var(--muted-2)">Fecha del veredicto: <b>${ddmm(v.fecha)}</b> · agregación de lluvia ${esc(v.agg_precip || "07-07")}</div>
      ${viejo ? `<div class="dec-stale">⚠ Este veredicto se emitió para el ${ddmm(v.fecha)}: los productos publicados envejecen hasta la próxima actualización.</div>` : ""}
      <div class="dec-verd-grid">
        ${kpiLluvia}
        ${kpiTemp("T. máxima", tx)}
        ${kpiTemp("T. mínima", tn)}
        ${kpiTend}
      </div>
      <p class="ml-pie">Tmax/Tmin = valor "más adecuado" del selector operativo con su rango Q25–Q75 del pronóstico probabilístico. Lluvia = probabilidad calibrada (promedio de clasificadores); la decisión es SÍ cuando P(≥1 mm) ≥ 50 %.</p>
    </div>`;
  }

  // Fila de validación: elige la fila del MODELO QUE EMITE la decisión (el del
  // veredicto para tmax/tmin; el mejor detector calificado para lluvia).
  function filaVal(etiqueta, d, modeloPref, metHTML) {
    if (!d || !(d.modelos || []).length) {
      return `<div class="dec-val-fila"><span class="var">${etiqueta}</span>
        <span class="suave" style="font-size:12px">Sin validación publicada para esta estación.</span></div>`;
    }
    let fila = modeloPref ? d.modelos.find(m => m.modelo === modeloPref) : null;
    if (!fila) fila = d.modelos.find(m => m.califica && m.rating != null) || d.modelos[0];
    return `<div class="dec-val-fila">
      <span class="var">${etiqueta}</span>
      <span class="mod"><span class="ml-mod-punto" style="background:${esc(fila.color || "#888")}"></span>${esc(fila.modelo)}</span>
      <span class="met">${metHTML(fila)}</span>
      ${calBadge(fila.rating)}
      ${pillConf(fila.confianza)}
      <span class="n">${fila.n} fechas</span>
    </div>`;
  }

  function tarjetaValidacionHTML(v, vtx, vtn, vdet) {
    const modTx = (v && v.tmax && v.tmax.modelo) || "BEST_OP_CV";
    const modTn = (v && v.tmin && v.tmin.modelo) || "BEST_OP_CV";
    // Para la detección de lluvia el veredicto promedia clasificadores: se
    // muestra el MEJOR detector calificado de la estación (resumen.mejor).
    const modDet = (vdet && vdet.resumen && vdet.resumen.mejor && vdet.resumen.mejor !== "—")
      ? vdet.resumen.mejor : null;
    return `<div class="ml-card dec-val">
      <h3 class="ml-titulo">Validación de estas decisiones
        <span class="ml-sutil">· últimas ${VENTANA} fechas con observación en esta estación</span></h3>
      <div class="dec-val-filas">
        ${filaVal("T. máxima", vtx, modTx, m => `MAE ${num(m.mae)} °C`)}
        ${filaVal("T. mínima", vtn, modTn, m => `MAE ${num(m.mae)} °C`)}
        ${filaVal("Lluvia (detección)", vdet, modDet, m => `POD ${num2(m.pod)} · FAR ${num2(m.far)} · CSI ${num2(m.csi)}`)}
      </div>
      <p class="ml-pie">MAE = error medio del modelo que emite la temperatura del veredicto (°C; menor es mejor). Detección de lluvia del mejor modelo calificado: POD acierto cuando SÍ llueve · FAR falsas alarmas · CSI acierto global (0–1; POD/CSI altos y FAR bajo es mejor). Badge = calificación 1–10; la píldora, la confianza muestral.</p>
    </div>`;
  }

  /* ============================================================
     RENDER raíz (pestaña de Pronóstico — sin cabecera grande propia).
     ============================================================ */
  const CHEV = `<span class="ml-loc-chev"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#95A1B2" stroke-width="2.5"><path d="M6 9l6 6 6-6" stroke-linecap="round" stroke-linejoin="round"></path></svg></span>`;
  const MIRA = `<span class="ml-loc-mira"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#1B6ACB" stroke-width="2"><circle cx="12" cy="12" r="6"></circle><path d="M12 1v4M12 19v4M1 12h4M19 12h4" stroke-linecap="round"></path></svg></span>`;

  function raizHTML() {
    return `
      <div class="dec-raiz" data-screen-label="Decisiones operativas">
        <div class="ml-cab-mini">Decisiones operativas · veredicto de MAÑANA por estación (¿llueve?, Tmax/Tmin más probables) y la validación de esas decisiones</div>
        <div class="dec-layout">
          <div class="ml-card dec-mapa-card">
            <div class="dec-buscador">
              <div class="ml-loc ml-combo" id="dec-combo-est">
                ${MIRA}
                <input id="dec-est-input" type="text" placeholder="Buscar estación por código, nombre, región o red…" autocomplete="off" spellcheck="false">
                ${CHEV}
                <div class="ml-combo-lista" id="dec-est-lista" tabindex="-1" hidden></div>
              </div>
            </div>
            <div class="dec-mapa" id="dec-mapa"></div>
            <div class="dec-leyenda">
              <span class="it"><span class="pt" style="background:${C_SI}"></span>Lluvia mañana: SÍ</span>
              <span class="it"><span class="pt" style="background:${C_NO}"></span>NO</span>
              <span class="it"><span class="pt chico" style="background:${C_SIN}"></span>Sin veredicto</span>
              <span class="it dec-ley-tam">tamaño = confianza de la decisión</span>
              <span class="dec-prog" id="dec-prog"></span>
            </div>
          </div>
          <div class="dec-panel" id="dec-panel"></div>
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
      dibujarMapa();
      pintarPanel();
      await cargarVeredictos(mi);
    },
    alDejar() {
      gen++; genPanel++;   // invalida lotes y panel en vuelo
      purgarPlots();       // libera la instancia Plotly y su listener de resize
    },
  };

  // Tras CUALQUIER actualización de datos: el cache de veredictos queda viejo →
  // se vacía; si la pestaña está montada, se re-renderiza con datos frescos.
  document.addEventListener("datos-actualizados", () => {
    S.cache.clear();
    S.geojson = null;
    if (S.cont && S.cont.isConnected && S.cont.querySelector(".dec-raiz")) {
      try { window.DECISIONES.render(S.cont); } catch (e) { /* re-render best effort */ }
    }
  });
})();
