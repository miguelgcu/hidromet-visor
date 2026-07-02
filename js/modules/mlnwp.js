/* ============================================================
   ML-NWP — Validación ML-NWP (v12: vista única por estación).
   Sin pestañas: Mapas/Resumen retirados; el Glosario vive en su módulo.
   Acento: púrpura (--ml-purple). data-screen-label="ML-NWP".
   Arquitectura: App.registrar / App.api / App.tarea. Mapas con Plotly.
   Campos JSON confirmados leyendo app/rutas/mlnwp.py y los módulos
   app/modulos/mlnwp/{productos,validacion,estilo,glosario}.py.
   ============================================================ */
"use strict";

(() => {
  const esc = v => String(v ?? "").replace(/[&<>"']/g,
    c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const num = (v, nd = 1) => (v === null || v === undefined || Number.isNaN(v)) ? "—" : Number(v).toFixed(nd);
  const sgn = v => (v === null || v === undefined || Number.isNaN(v)) ? "—"
    : (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(Number(v)).toFixed(1);

  // Acento del módulo y colores de modelos de la cabecera de la tabla/leyenda.
  const MORADO = "#6A47CE", NAVY = "#0F2745";
  // Familia → clase visual del glosario.
  const FAM_CRUDO = ["GFS05", "ICON", "IFS025", "IFSHRES", "AIFS025", "METEOBLUE", "GEM15"];

  // VARIABLE (chip) → bloque de /validacion. Precipitación usa "cuantificación"
  // (columnas MAE/RMSE/Sesgo/Corr, como en el diseño).
  const VAR_A_BLOQUE = { precip: "precip_cua", tmax: "tmax", tmin: "tmin" };
  // Etiqueta de variable para Series (la ruta /series acepta precip|tmax|tmin).
  const VAR_SERIE = { precip: "precip", tmax: "tmax", tmin: "tmin" };
  // VENTANA (chip del diseño: 15/30/45/60) → clave real de validacion.VENTANAS
  // ({"7","15","30","todo"}). 45/60 no existen como cubo exacto → al más cercano.
  const VENT_A_API = { "15": "15", "30": "30", "45": "30", "60": "todo" };

  // Filtro de FAMILIA de modelo. valor = el que entiende el backend
  // (productos.FAMILIAS); etiqueta = texto del chip. "Todos" = sin filtro.
  const FAMILIAS_UI = [
    ["Todos", "Todo"], ["Convencionales", "Convencionales"], ["No convencionales", "No conv."],
    ["ML", "ML"], ["Postprocesamiento", "Post. estadístico"],
  ];
  // Tamaño del punto del MAPA por confianza (px de marcador Plotly). Borde blanco
  // UNIFORME (nunca color por confianza). Alta grande / Media medio / Baja pequeño.
  const TAM_CONF = { Alta: 15, Media: 11, Baja: 8, "Sin calificar": 6 };
  // Opacidad de la BARRA por confianza (Alta sólido / Media .72 / Baja .5).
  const OPACIDAD_CONF = { Alta: 1, Media: .72, Baja: .5, "Sin calificar": .35 };

  // Badge de calificación con color tipo semáforo (escala RdYlGn por nota 1-10).
  const RDYLGN = ["#D73027", "#F46D43", "#FDAE61", "#FEE08B", "#D9EF8B",
                  "#A6D96A", "#66BD63", "#1A9850"];
  function calColor(r) {
    if (r === null || r === undefined || Number.isNaN(r)) return (App.tema && App.tema() === "oscuro") ? ["#222F49", "#9DAABF"] : ["#F0F3F8", "#5A6678"];
    const t = Math.max(0, Math.min(1, (Number(r) - 1) / 9));
    const bg = RDYLGN[Math.min(RDYLGN.length - 1, Math.floor(t * RDYLGN.length))];
    // texto blanco solo en el verde oscuro (notas altas); oscuro en el resto.
    const fg = (Number(r) >= 7.5) ? "#fff" : "#1E1E1E";
    return [bg, fg];
  }
  const confClase = c => ({ Alta: "alta", Media: "media", Baja: "baja" }[c] || "sin");
  function pillConf(c) {
    return `<span class="ml-pill ${confClase(c)}">${esc(c || "Sin calificar")}</span>`;
  }

  // Riesgo → color (texto). Valores oficiales del diseño/escalas.
  const RIESGO_COLOR = { "Muy Alto": "#D62A23", "Alto": "#F08A24", "Medio": "#E0A91E", "No aplica": "#3DA4DD" };
  const riesgoColor = r => RIESGO_COLOR[r] || "var(--ink-2)";

  /* ---------------- estado del módulo ---------------- */
  const S = {
    ctx: null,
    deps: ["INAMHI"],
    tab: "validacion",
    variable: "precip",          // precip | tmax | tmin
    ventana: "30",               // desplegable Ventana (nº de fechas)
    familia: "Todos",            // filtro de familia de modelo
    estacion: "",                // código de estación (v12: siempre por estación)
    valData: null,               // última respuesta de /validacion (alimenta el selector)
    geojson: null,
  };

  const depsQS = () => "deps=" + encodeURIComponent(S.deps.join(","));

  // Contador de generación: invalida respuestas async en vuelo cuando el usuario
  // cambia de ámbito/variable/ventana/familia/estación antes de que resuelvan
  // (App.api no cancela). El último cambio gana; los pares viejos se descartan.
  let gen = 0;

  async function guardarDeps() {
    try { await App.api("/config", { method: "POST", body: { dependencias_mlnwp: S.deps } }); }
    catch (e) { /* no bloquear la UI por esto */ }
  }

  /* ============================================================
     RENDER raíz: cabecera propia + chips de dependencia + tabs.
     ============================================================ */
  function chipsDepsHTML() {
    const def = [
      { id: "INAMHI", label: "INAMHI", punto: true },
      { id: "CELEC", label: "CELEC" },
      { id: "Hidronación", label: "Hidronación" },
    ];
    return def.map(d => {
      const on = S.deps.includes(d.id);
      return `<button class="chip ${on ? "activo" : ""}" data-dep="${esc(d.id)}">
        ${d.punto ? `<span class="punto-dep"></span>` : ""}${esc(d.label)}</button>`;
    }).join("");
  }

  // v12: sin pestañas — Mapas y Resumen se retiraron (pedido del dueño); queda la
  // vista única de Validación por estación.
  function pintarRaiz(vista) {
    vista.innerHTML = `
      <div class="ml-raiz" data-screen-label="ML-NWP">
        <div class="ml-cab">
          <div>
            <div class="kicker">Módulos · Núcleo analítico</div>
            <h1>Validación NWP-ML</h1>
            <div class="ml-sub">Compara 41 modelos por estación · calificación 1–10 con confianza muestral</div>
          </div>
          <div class="ml-deps">${chipsDepsHTML()}</div>
        </div>
        <div id="ml-cuerpo"></div>
      </div>`;

    vista.querySelectorAll(".ml-deps .chip").forEach(b => b.onclick = () => {
      const id = b.dataset.dep;
      const next = S.deps.includes(id) ? S.deps.filter(d => d !== id) : [...S.deps, id];
      if (!next.length) return App.aviso("Selecciona al menos una dependencia.", "error");
      S.deps = next;
      vista.querySelector(".ml-deps").innerHTML = chipsDepsHTML();
      vista.querySelectorAll(".ml-deps .chip").forEach(reBindDep);
      guardarDeps();
      pintarTab();
    });
  }

  function reBindDep(b) {
    b.onclick = () => {
      const id = b.dataset.dep;
      const next = S.deps.includes(id) ? S.deps.filter(d => d !== id) : [...S.deps, id];
      if (!next.length) return App.aviso("Selecciona al menos una dependencia.", "error");
      S.deps = next;
      const cab = document.querySelector(".ml-deps");
      cab.innerHTML = chipsDepsHTML();
      cab.querySelectorAll(".chip").forEach(reBindDep);
      guardarDeps();
      pintarTab();
    };
  }

  function cuerpo() { return document.getElementById("ml-cuerpo"); }
  const cargando = msg => `<div class="vacio"><div class="icono">⏳</div>${esc(msg || "Cargando…")}</div>`;
  const vacio = msg => `<div class="vacio"><div class="icono">∅</div>${esc(msg)}</div>`;

  // IDs de los gráficos Plotly del módulo. Plotly engancha un listener de window
  // 'resize' por gráfico (responsive:true) que SÓLO se libera con Plotly.purge,
  // nunca al quitar el div del DOM. Purgamos al salir del módulo y antes de cada
  // re-render de pestaña para no acumular instancias ni handlers en sesiones largas.
  const PLOTS = ["ml-plot-serie"];   // v12: ganador/mapas retirados con la vista Nacional
  function purgarPlots() {
    if (!window.Plotly) return;
    for (const id of PLOTS) {
      const el = document.getElementById(id);
      if (el) { try { Plotly.purge(el); } catch (e) { /* ya purgado */ } }
    }
  }

  function pintarTab() {
    purgarPlots();
    const c = cuerpo();
    if (!c) return;
    c.innerHTML = cargando();
    tabValidacion(c);   // v12: vista única (Mapas/Resumen retirados)
  }

  /* ============================================================
     PESTAÑA 1 — VALIDACIÓN
     ============================================================ */
  // v12: TODOS los selectores en UNA fila — variable (chips), ventana (desplegable),
  // estación y familia (desplegables). Sin telemetría de cobertura (retirada) y sin
  // ámbito Nacional (retirado): la vista es siempre por estación.
  function deckHTML() {
    const vars = [["precip", "Precipitación"], ["tmax", "T. máxima"], ["tmin", "T. mínima"]];
    const vents = ["15", "30", "45", "60"];
    const chipsVar = vars.map(([id, t]) =>
      `<button class="chip ml-var ${S.variable === id ? "activo" : ""}" data-var="${id}">${t}</button>`).join("");
    const optsVent = vents.map(v =>
      `<option value="${v}" ${S.ventana === v ? "selected" : ""}>${v} fechas</option>`).join("");
    const optsFam = FAMILIAS_UI.map(([val, et]) =>
      `<option value="${esc(val)}" ${S.familia === val ? "selected" : ""}>${esc(et)}</option>`).join("");
    const chev = `<span class="ml-loc-chev"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#95A1B2" stroke-width="2.5"><path d="M6 9l6 6 6-6" stroke-linecap="round" stroke-linejoin="round"></path></svg></span>`;
    return `
      <div class="ml-deck">
        <div class="ml-deck-rail"></div>
        <div class="ml-deck-cuerpo">
          <div class="ml-grupo">
            <span class="ml-grupo-lab">Variable</span>
            <div class="fila" style="gap:7px">${chipsVar}</div>
          </div>
          <div class="ml-deck-div"></div>
          <div class="ml-grupo">
            <span class="ml-grupo-lab" title="Número de fechas con par modelo-observación">Ventana</span>
            <div class="ml-loc">
              <select id="ml-sel-vent">${optsVent}</select>
              ${chev}
            </div>
          </div>
          <div class="ml-deck-div"></div>
          <div class="ml-grupo ml-loc-grp">
            <span class="ml-grupo-lab">Estación</span>
            <div class="ml-loc">
              <span class="ml-loc-mira"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#6A47CE" stroke-width="2"><circle cx="12" cy="12" r="6"></circle><path d="M12 1v4M12 19v4M1 12h4M19 12h4" stroke-linecap="round"></path></svg></span>
              <select id="ml-sel-est"><option>Cargando…</option></select>
              ${chev}
            </div>
          </div>
          <div class="ml-grupo ml-loc-grp">
            <span class="ml-grupo-lab">Familia de modelo</span>
            <div class="ml-loc">
              <select id="ml-sel-fam">${optsFam}</select>
              ${chev}
            </div>
          </div>
        </div>
      </div>
      <details class="hm-mas ml-nota-det">
        <summary>ℹ Cómo leer calificación y confianza</summary>
        <div class="ml-nota">
          <b>Calificación 1–10</b> = qué tan bueno es el modelo (skill). &nbsp;<b>Confianza</b> = cuántas <b>fechas</b> respaldan esa calificación:
          <span class="ml-pill alta">Alta ≥30</span>
          <span class="ml-pill media">Media 15–29</span>
          <span class="ml-pill baja">Baja 5–14</span>
          Elige una <b>estación</b> para ver su validación y su serie temporal.
        </div>
      </details>`;
  }

  async function tabValidacion(c) {
    c.innerHTML = deckHTML() + `<div id="ml-vista-est"></div>`;
    bindDeck(c);
    await cargarValidacion();
  }

  function bindDeck(c) {
    c.querySelectorAll(".ml-var").forEach(b => b.onclick = () => {
      S.variable = b.dataset.var;
      c.querySelectorAll(".ml-var").forEach(x => x.classList.toggle("activo", x.dataset.var === S.variable));
      cargarValidacion();
    });
    const selVent = c.querySelector("#ml-sel-vent");
    if (selVent) selVent.onchange = () => { S.ventana = selVent.value; cargarValidacion(); };
    const selFam = c.querySelector("#ml-sel-fam");
    if (selFam) selFam.onchange = () => { S.familia = selFam.value; cargarValidacion(); };
    const sel = c.querySelector("#ml-sel-est");
    if (sel) sel.onchange = () => { S.estacion = sel.value; pintarVistaAmbito(); };
  }

  // Tipo legible de la familia de modelo (para la columna de la tabla).
  function famTipo(familia) {
    return { Convencionales: "convencional", "No convencionales": "no convencional",
      ML: "ML", Postprocesamiento: "post. estadístico" }[familia] || "crudo";
  }

  // Carga /validacion (datos del mapa nacional + lista para el selector) y
  // despacha la vista del ámbito activo (Nacional o una estación).
  async function cargarValidacion() {
    const cont = document.getElementById("ml-vista-est");
    if (!cont) return;
    const mi = ++gen;
    cont.innerHTML = cargando("Calculando validación…");
    const bloque = VAR_A_BLOQUE[S.variable];
    const vent = VENT_A_API[S.ventana];
    const famQS = "&familia=" + encodeURIComponent(S.familia);
    let d;
    try {
      d = await App.api(`/mlnwp/validacion?bloque=${bloque}&ventana=${vent}&${depsQS()}${famQS}`);
    } catch (e) { if (mi === gen) cont.innerHTML = vacio("No se pudo cargar la validación: " + e.message); return; }
    if (mi !== gen) return;   // llegó una selección más nueva
    S.valData = d;

    // v12: sin ámbito Nacional — el selector lista SOLO estaciones con datos y la
    // vista es siempre por estación. Si la previa ya no tiene datos (cambió
    // variable/ventana/familia/deps), cae a la primera disponible.
    const sel = document.getElementById("ml-sel-est");
    const ests = d.estaciones || [];
    if (!ests.length) {
      const cont2 = document.getElementById("ml-vista-est");
      if (cont2) cont2.innerHTML = vacio("Sin estaciones con datos para esta combinación.");
      return;
    }
    if (!ests.some(e => String(e.codigo) === String(S.estacion)))
      S.estacion = String(ests[0].codigo);
    if (sel) {
      sel.innerHTML = ests.map(e =>
        `<option value="${esc(e.codigo)}">${esc(e.codigo)} · ${esc(e.nombre)} (${esc(e.region)})</option>`).join("");
      sel.value = S.estacion;
    }
    pintarVistaAmbito();
  }

  // v12: la vista es siempre por estación (validación detallada + serie temporal).
  function pintarVistaAmbito() {
    purgarPlots();
    const cont = document.getElementById("ml-vista-est");
    if (!cont) return;
    cargarEstacion(cont);
  }

  // Vista de una estación: validación detallada (arriba) + serie temporal (abajo).
  async function cargarEstacion(cont) {
    if (!S.estacion) { cont.innerHTML = vacio("Selecciona una estación."); return; }
    const mi = ++gen;
    cont.innerHTML = cargando("Cargando validación y serie de la estación…");
    const bloque = VAR_A_BLOQUE[S.variable];
    const vent = VENT_A_API[S.ventana];
    const famQS = "&familia=" + encodeURIComponent(S.familia);
    const lookback = parseInt(S.ventana, 10) || 45;
    let det, ser;
    try {
      [det, ser] = await Promise.all([
        App.api(`/mlnwp/validacion_estacion?bloque=${bloque}&ventana=${vent}&${depsQS()}&codigo=${encodeURIComponent(S.estacion)}`),
        App.api(`/mlnwp/series?${depsQS()}&codigo=${encodeURIComponent(S.estacion)}&variable=${VAR_SERIE[S.variable]}&lookback=${lookback}${famQS}`),
      ]);
    } catch (e) { if (mi === gen) cont.innerHTML = vacio("No se pudo cargar la estación: " + e.message); return; }
    // descarta si llegó una selección más nueva durante la carga
    if (mi !== gen || !S.estacion) return;
    purgarPlots();   // libera cualquier serie previa antes de reescribir el contenedor
    // Serie temporal ARRIBA, tabla de clasificación DEBAJO.
    cont.innerHTML = `<div class="ml-card" id="ml-serie-card"></div>
      <div id="ml-detalle" style="margin-top:14px"></div>`;
    pintarSerie(document.getElementById("ml-serie-card"), ser);
    pintarDetalle(document.getElementById("ml-detalle"), det);
  }

  function pintarDetalle(cont, d) {
    // Filtro de familia: restringe los modelos mostrados y recalcula el resumen.
    const filtrarFam = S.familia && S.familia !== "Todos" && S.familia !== "Mejor desempeño";
    let modelos = d.modelos || [];
    if (filtrarFam) modelos = modelos.filter(m => m.familia === S.familia);
    let r = d.resumen || {};
    if (filtrarFam) {
      const cal = modelos.filter(m => m.califica && m.rating != null);
      const mejorM = cal.slice().sort((a, b) => (b.rating || 0) - (a.rating || 0))[0];
      r = {
        n_modelos: modelos.length, n_califican: cal.length,
        mejor: mejorM ? mejorM.modelo : "—",
        mejor_rating: mejorM ? mejorM.rating : null,
        mejor_confianza: mejorM ? mejorM.confianza : null,
        calif_media: cal.length ? cal.reduce((s, m) => s + (m.rating || 0), 0) / cal.length : null,
        fechas_max: r.fechas_max,
      };
    }
    const metCols = d.met_cols || ["mae", "rmse", "bias", "corr"];
    const esDet = d.modo === "detection";

    // Barras: una por modelo (las que califican, hasta 12), altura = calif, opacidad = confianza.
    const califican = modelos.filter(m => m.califica && m.rating != null);
    const ratings = califican.map(m => m.rating);
    const maxR = Math.max(10, ...ratings, 1);
    const barras = califican.slice(0, 12).map(m => {
      const h = Math.round((m.rating / maxR) * 158);
      const op = OPACIDAD_CONF[m.confianza] ?? .5;
      return `<div class="ml-barra" title="${esc(m.modelo)} · calif. ${num(m.rating, 1)} · ${esc(m.confianza)}">
        <span class="v">${num(m.rating, 1)}</span>
        <div class="col" style="height:${h}px;background:${esc(m.color)};opacity:${op}"></div></div>`;
    }).join("") || `<div class="suave" style="margin:auto;font-size:12px">Sin modelos calificados</div>`;

    const confBadge = c => {
      const k = confClase(c);
      return `<span class="v-conf ml-pill ${k}">${esc(c || "—")}</span>`;
    };

    // Cabeceras de métricas según el modo (detección vs continuo).
    const metHead = esDet
      ? [["pod", "POD"], ["far", "FAR"], ["csi", "CSI"]]
      : [["mae", "MAE"], ["rmse", "RMSE"], ["bias", "Sesgo"], ["corr", "Corr"]];
    const metHeadHTML = metHead.map(([, t]) => `<th class="der">${t}</th>`).join("");

    const fmtMet = (m, k) => {
      const v = m[k];
      if (v === null || v === undefined || Number.isNaN(v)) return "—";
      if (k === "bias") return sgn(v);
      if (k === "corr" || k === "pod" || k === "far" || k === "csi") return Number(v).toFixed(2);
      return Number(v).toFixed(1);
    };

    const filas = modelos.map((m, i) => {
      const sinCal = !m.califica || m.rating == null;
      const [bg, fg] = calColor(m.rating);
      const tipoFam = { Convencionales: "grillado", "No convencionales": "grillado",
        ML: "calibrado", Postprocesamiento: "combinación" }[m.familia] || "crudo";
      const metTds = metHead.map(([k]) =>
        `<td class="num">${sinCal ? "—" : fmtMet(m, k)}</td>`).join("");
      return `<tr class="${sinCal ? "sin-calif" : ""}">
        <td class="idx">${sinCal ? "—" : i + 1}</td>
        <td><span class="ml-mod-punto" style="background:${esc(m.color)}"></span>${esc(m.modelo)}<span class="ml-mod-tipo"> · ${tipoFam}</span></td>
        <td>${sinCal ? `<span style="color:var(--muted-2)">sin calif.</span>`
          : `<span class="ml-calif-badge" style="background:${bg};color:${fg}">${num(m.rating, 1)}</span>`}</td>
        <td class="num">${m.n}</td>
        <td>${pillConf(m.confianza)}</td>
        ${metTds}
      </tr>`;
    }).join("");

    const nom = d.nombre || S.estacion;
    cont.innerHTML = `
      <div class="ml-card">
        <h3 class="ml-titulo">Clasificación de modelos en ${esc(nom)}
          <span class="ml-sutil">· ${esc(d.codigo)} · ${esc(d.region)} · ordenados por calificación</span></h3>
        <table class="ml-tabla-modelos">
          <thead><tr>
            <th>#</th><th>Modelo</th><th>Calif.</th><th class="der">Fechas</th><th>Confianza</th>
            ${metHeadHTML}
          </tr></thead>
          <tbody>${filas || `<tr><td colspan="9" class="suave" style="padding:14px">Sin modelos para esta estación.</td></tr>`}</tbody>
        </table>
      </div>`;
  }

  /* ============================================================
     MAPA Plotly (puntos sobre fondo "continental"): usado por
     Validación (ganador) y Mapas (campo). Sin tiles: lon/lat como
     x/y dentro de los límites de Ecuador, con relieve provincial
     dibujado en líneas tenues si /geojson/provincias está disponible.
     ============================================================ */
  const ECU = { W: -81.3, E: -75.0, S: -5.1, N: 1.6 };

  // Contorno de Ecuador con ENCASILLADO (blanca ancha debajo + negra más fina encima).
  function outlineTrace() {
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
    // Outline geográfico: en OSCURO se invierte (halo oscuro + línea clara) para no desaparecer.
    const _osc = (App.tema && App.tema() === "oscuro");
    return [
      Object.assign({}, base, { line: { color: _osc ? "#0B1322" : "#ffffff", width: 3.4 } }),
      Object.assign({}, base, { line: { color: _osc ? "#AEBBD0" : "#0b0d12", width: 1.5 } }),
    ];
  }

  // Relieve continental RELLENO (mapa base): que el mapa no sean puntos pelados.
  function landTrace() {
    if (!S.geojson || !S.geojson.features) return null;
    const oscuro = (App.tema && App.tema() === "oscuro");
    const xs = [], ys = [];
    const empuja = ring => { for (const [lo, la] of ring) { xs.push(lo); ys.push(la); } xs.push(null); ys.push(null); };
    for (const f of S.geojson.features) {
      const g = f.geometry; if (!g) continue;
      if (g.type === "Polygon") g.coordinates.forEach(empuja);
      else if (g.type === "MultiPolygon") g.coordinates.forEach(p => p.forEach(empuja));
    }
    if (!xs.length) return null;
    return { type: "scatter", mode: "lines", x: xs, y: ys, fill: "toself", hoverinfo: "skip",
      fillcolor: oscuro ? "rgba(26,38,62,.88)" : "rgba(236,241,234,.92)",
      line: { color: "rgba(0,0,0,0)", width: 0 }, showlegend: false };
  }

  async function asegurarGeo() {
    if (S.geojson !== null) return;
    try { S.geojson = await App.api("/mlnwp/geojson/provincias"); }
    catch (e) { S.geojson = false; }
  }

  function ejeGeo() {
    return {
      xaxis: { range: [ECU.W, ECU.E], showgrid: false, zeroline: false, visible: false, fixedrange: false },
      yaxis: { range: [ECU.S, ECU.N], showgrid: false, zeroline: false, visible: false,
               scaleanchor: "x", scaleratio: 1, fixedrange: false },
    };
  }

  function plotMapaPuntos(divId, puntos, opts) {
    const el = document.getElementById(divId);
    if (!el) return;
    asegurarGeo().then(() => construirMapa(el, puntos, opts));
  }

  function construirMapa(el, puntos, opts) {
    if (!window.Plotly) { el.innerHTML = `<div class="vacio">Plotly no disponible</div>`; return; }
    const traces = [];
    const land = landTrace();        // relieve relleno de base
    if (land) traces.push(land);
    traces.push(...outlineTrace());  // contorno de Ecuador con encasillado (negro + halo blanco)

    if (!puntos.length) {
      Plotly.purge(el);
      el.innerHTML = `<div class="vacio" style="height:100%"><div class="icono">∅</div>Sin estaciones para mostrar</div>`;
      return;
    }
    el.innerHTML = "";

    const x = puntos.map(p => p.lon), y = puntos.map(p => p.lat);
    const text = puntos.map(opts.hover);
    const marker = { line: { color: "#fff", width: 2 } };

    if (opts.colorPorModelo) {
      marker.color = puntos.map(p => p.color);
      marker.size = puntos.map(opts.tamano);
    } else if (opts.colorRiesgo) {
      // "Por riesgo": recolorea el marcador con el color de nivel de riesgo del dato.
      marker.color = puntos.map(p => RIESGO_COLOR[p.riesgo] || "#3DA4DD");
      marker.size = opts.size || 11;
    } else {
      marker.color = puntos.map(p => p.valor);
      marker.colorscale = opts.colorscale;
      marker.cmin = opts.cmin; marker.cmax = opts.cmax;
      marker.size = opts.size || 11;
      marker.showscale = false;
    }

    const trace = { type: "scatter", mode: opts.etiquetas ? "markers+text" : "markers",
      x, y, text, hoverinfo: "text", marker };
    if (opts.etiquetas) {
      trace.text = puntos.map(p => num(p.valor, 0));
      trace.hovertext = puntos.map(opts.hover);
      trace.hoverinfo = "text";
      trace.textposition = "top center";
      trace.textfont = { family: "IBM Plex Mono, monospace", size: 9, color: "#0F1B2D" };
    }
    traces.push(trace);

    const geo = ejeGeo();
    const layout = App.plotlyLayoutBase({
      showlegend: false, margin: { l: 0, r: 0, t: 0, b: 0 },
      xaxis: geo.xaxis, yaxis: geo.yaxis, dragmode: "pan",
    });
    Plotly.newPlot(el, traces, layout, App.plotlyConfig({ scrollZoom: true })).then(() => {
      if (opts.onClick) {
        el.on("plotly_click", ev => {
          const idx = ev.points && ev.points[0] && ev.points[0].pointNumber;
          if (idx == null) return;
          // el primer trace puede ser el outline; localizar el punto por curva.
          const curva = ev.points[0].curveNumber;
          const tr = traces[curva];
          if (tr !== trace) return;
          opts.onClick(puntos[idx]);
        });
      }
    });
  }

  /* ============================================================
     SERIE TEMPORAL (dentro de la vista de estación de Validación)
     pintarSerie la invoca cargarEstacion() con la respuesta de /series.
     ============================================================ */
  function pintarSerie(card, d) {
    const unidad = d.unidad || "mm";
    const esPrecip = !!d.es_precip;
    // Colores TEMA-CONSCIENTES (modo oscuro): observado, mediana, abanico y anotación. Sin esto,
    // el negro del observado y el azul oscuro del abanico quedaban invisibles sobre fondo oscuro.
    const oscuro = (App.tema && App.tema() === "oscuro");
    const C = oscuro
      ? { obs: "#E8EDF6", p50: "#6BB1EE", fan80: "rgba(120,165,225,.14)", fan50: "rgba(120,165,225,.30)", anot: "#9DAABF" }
      : { obs: "#0F1B2D", p50: "#0052A3", fan80: "rgba(27,58,107,.10)", fan50: "rgba(27,58,107,.24)", anot: "#5A6678" };
    const tit = `${esc(d.variable === "precip" ? "Precipitación 7-7" : (d.variable === "tmax" ? "T. máxima" : "T. mínima"))} — ${esc(d.nombre || "")} (${esc(d.codigo)})`;
    card.innerHTML = `
      <div class="ml-serie-tit">${tit}</div>
      <div class="ml-serie-plot" id="ml-plot-serie"></div>
      <div class="ml-serie-leyenda" id="ml-serie-leyenda"></div>
      <div class="ml-serie-probs" id="ml-serie-probs"></div>
      <p class="ml-serie-pie">Observado vs. pronóstico (la franja sombreada de la derecha es el horizonte futuro). Los modelos se atenúan según su calificación.${esPrecip ? " Abanico azul = pronóstico probabilístico: franja oscura 50 % probable (P25–P75), clara 80 % (P10–P90); detalle por umbral en la tabla." : ""}</p>`;

    const el = document.getElementById("ml-plot-serie");
    if (!window.Plotly || !el) return;

    const traces = [];
    const fx = arr => (arr || []).map(s => s);

    // ABANICO probabilístico (precip): banda EXTERNA 80 % (P10–P90, clara) + banda
    // INTERNA 50 % (P25–P75, más oscura) + mediana P50 destacada. Comunica la
    // incertidumbre con jerarquía (rango probable vs extremos), no una sola sombra.
    if (esPrecip && d.banda && d.banda.fechas && d.banda.fechas.length) {
      const b = d.banda;
      const poligono = (lo, hi, color) => {
        const xs = [], ys = [];
        for (let i = 0; i < b.fechas.length; i++) if (lo[i] != null && hi[i] != null) { xs.push(b.fechas[i]); ys.push(hi[i]); }
        for (let i = b.fechas.length - 1; i >= 0; i--) if (lo[i] != null && hi[i] != null) { xs.push(b.fechas[i]); ys.push(lo[i]); }
        if (xs.length < 3) return;
        traces.push({ type: "scatter", mode: "lines", x: xs, y: ys, fill: "toself",
          fillcolor: color, line: { width: 0 }, hoverinfo: "skip", showlegend: false });
      };
      poligono(b.p10 || b.bajo || [], b.p90 || b.alto || [], C.fan80);   // 80 %
      if (b.p25 && b.p75) poligono(b.p25, b.p75, C.fan50);                // 50 %
      if (b.p50) {
        const intr = !!(b.p25 && b.p75);
        traces.push({ type: "scatter", mode: "lines", x: b.fechas, y: b.p50,
          line: { color: C.p50, width: 2.4 }, name: "P50 (mediana)", showlegend: false,
          customdata: b.fechas.map((_, i) => [b.p10[i], b.p90[i], intr ? b.p25[i] : null, intr ? b.p75[i] : null]),
          hovertemplate: `Mediana P50: %{y} mm`
            + (intr ? `<br>50 % probable: %{customdata[2]}–%{customdata[3]} mm` : ``)
            + `<br>80 % probable: %{customdata[0]}–%{customdata[1]} mm<extra></extra>` });
      }
    }

    // Modelos (atenuados por calificación: opacity ya viene de /series).
    const leyenda = [];
    for (const m of (d.modelos || []).slice(0, 8)) {
      const color = m.color;
      if (esPrecip) {
        traces.push({ type: "bar", x: fx(m.fechas), y: m.valores, name: `${m.modelo} (${num(m.rating, 1)})`,
          marker: { color, opacity: m.opacity ?? .7 }, hovertemplate: `${esc(m.modelo)}: %{y} ${unidad}<extra></extra>` });
      } else {
        traces.push({ type: "scatter", mode: "lines", x: fx(m.fechas), y: m.valores, name: `${m.modelo} (${num(m.rating, 1)})`,
          line: { color, width: m.width ?? 1.5 }, opacity: m.opacity ?? .7,
          hovertemplate: `${esc(m.modelo)}: %{y} ${unidad}<extra></extra>` });
      }
      leyenda.push(`<span class="it"><span class="sw-caja" style="background:${esc(color)};opacity:${m.opacity ?? .7}"></span>${esc(m.modelo)} (${num(m.rating, 1)})</span>`);
    }

    // Observado: línea punteada negra con marcadores cuadrados.
    if (d.observado && d.observado.fechas && d.observado.fechas.length) {
      traces.push({ type: "scatter", mode: "lines+markers+text", x: d.observado.fechas, y: d.observado.valores,
        text: d.observado.valores.map(v => (v == null ? "" : (esPrecip && Number(v) === 0 ? "" : num(v, 1)))),
        textposition: "top center", textfont: { size: 9, color: C.obs }, cliponaxis: false,
        name: "Observado", line: { color: C.obs, width: 2.8 },
        marker: { color: C.obs, size: 8, symbol: "circle" },
        hovertemplate: `Observado: %{y} ${unidad}<extra></extra>` });
    }

    const layout = App.plotlyLayoutSerie("", {
      // barmode "overlay": los hietogramas de modelos se superponen y se atenúan por
      // calificación (opacity); el mejor queda más nítido. El eje X es de FECHA (no
      // categoría) para que banda P10–P90, P50, barras y observado se alineen en el
      // tiempo aunque tengan distinta cantidad de fechas.
      barmode: "overlay",
      showlegend: false,   // única leyenda = la HTML (ml-serie-leyenda); evita leyenda doble
      yaxis: { title: { text: unidad, font: { size: 11 } }, rangemode: esPrecip ? "tozero" : "normal" },
      // Eje X: TODAS las fechas (un tick por día), no solo algunas. Rotadas -45° y fuente pequeña
      // para que entre el periodo completo (lookback + pronóstico).
      xaxis: { type: "date", tickformat: "%d/%m", tickmode: "linear", dtick: 86400000,
               tickangle: -45, tickfont: { size: 9 }, automargin: true },
    });
    // Distinción HISTORIA vs PRONÓSTICO: franja de fondo desde HOY hasta el final +
    // línea divisoria. F5: "hoy" se calcula en el CLIENTE (TZ Ecuador) — el visor
    // congela los JSON y el 'hoy' del backend envejece; d.hoy queda de fallback.
    const _hoy = (App.hoyEC ? App.hoyEC() : d.hoy);
    if (_hoy) {
      const finX = (d.banda && d.banda.fechas && d.banda.fechas.length ? d.banda.fechas[d.banda.fechas.length - 1] : null)
        || ((d.modelos || []).flatMap(m => m.fechas || []).sort().slice(-1)[0]) || _hoy;
      layout.shapes = [
        { type: "rect", x0: _hoy, x1: finX, yref: "paper", y0: 0, y1: 1, layer: "below",
          fillcolor: "rgba(107,140,180,.07)", line: { width: 0 } },
        { type: "line", x0: _hoy, x1: _hoy, yref: "paper", y0: 0, y1: 1,
          line: { color: "#6B8CB4", width: 1.8, dash: "dot" } },
      ];
      layout.annotations = [{ x: _hoy, yref: "paper", y: 1, yanchor: "bottom", xanchor: "left",
        text: "inicio pronóstico →", showarrow: false,
        font: { family: "IBM Plex Mono", size: 10, color: C.anot } }];
    }
    Plotly.newPlot(el, traces, layout, App.plotlyConfig());

    const leyEl = document.getElementById("ml-serie-leyenda");
    if (leyEl) leyEl.innerHTML =
      `<span class="it"><span class="sw-linea"></span>Observado</span>` + leyenda.join("") +
      (esPrecip ? `<span class="it"><span class="sw-banda"></span>Pronóstico probabilístico (50 % / 80 %)</span>` : "");

    // Tabla de probabilidades por umbral: los porcentajes por nivel de lluvia (antes
    // solo se veía la 'sombra' de la banda y no estos números).
    const probsEl = document.getElementById("ml-serie-probs");
    if (probsEl) {
      const pu = d.probs_umbral;
      if (esPrecip && pu && pu.fechas && pu.fechas.length) {
        // SOLO fechas de pronóstico (>= hoy), TODAS (sin tope de 14). Tabla TRANSPUESTA: una
        // COLUMNA por fecha y una FILA por umbral → se extiende a TODO el ancho de la serie,
        // fecha por fecha, alineada con el eje temporal del gráfico.
        let idx = pu.fechas.map((_, i) => i).filter(i => !_hoy || pu.fechas[i] >= _hoy);   // F5: sin días pasados
        if (!idx.length) idx = pu.fechas.map((_, i) => i).slice(-10);
        const alfa = p => p < 20 ? 0.08 : p < 50 ? 0.20 : p < 75 ? 0.38 : 0.58;
        const celStyle = p => p == null
          ? "color:var(--faint)"
          : `background:rgba(43,93,170,${alfa(p).toFixed(2)});color:${p >= 50 ? "#fff" : "var(--ink)"}`;
        const dd = f => `${f.slice(8, 10)}/${f.slice(5, 7)}`;
        const cabFechas = idx.map(i => `<th class="ml-pb-f">${dd(pu.fechas[i])}</th>`).join("");
        const filasU = (pu.umbrales || []).map((u, j) => {
          const celdas = idx.map(i => {
            const p = (pu.probs[i] || [])[j];
            return `<td class="ml-pb-c" style="${celStyle(p)}">${p == null ? "—" : p + "%"}</td>`;
          }).join("");
          return `<tr><th class="ml-pb-u">≥${u} mm</th>${celdas}</tr>`;
        }).join("");
        probsEl.innerHTML =
          `<div class="ml-pb-tit">Probabilidad de lluvia por umbral (pronóstico)</div>
           <table class="ml-pb-tabla"><thead><tr><th class="ml-pb-esq">Umbral</th>${cabFechas}</tr></thead>
           <tbody>${filasU}</tbody></table>
           <div class="ml-pb-nota">Probabilidad calibrada (promedio de clasificadores). Ej.: “≥25 mm = 30 %” = 30 % de probabilidad de que llueva más de 25 mm ese día.</div>`;
      } else {
        probsEl.innerHTML = "";
      }
    }
  }

  /* ============================================================
     PESTAÑA 5 — GLOSARIO (3 tarjetas: modelos · métricas · calif+conf)
     ============================================================ */
  async function tabGlosario(c) {
    c.innerHTML = cargando("Cargando glosario…");
    let g;
    try { g = await App.api("/mlnwp/glosario"); } catch (e) { c.innerHTML = vacio("No se pudo cargar el glosario: " + e.message); return; }
    pintarGlosario(c, g);
  }

  function famClase(grupo) {
    const s = (grupo || "").toLowerCase();
    if (s.includes("crudo") || s.includes("nwp")) return "fam-crudo";
    if (s.includes("consenso") || s.includes("postproc")) return "fam-cons";
    return "fam-ml";
  }

  function pintarGlosario(c, g) {
    const modelos = g.modelos || [];
    const metricas = g.metricas || [];
    const cal = g.calificacion || {};
    const conf = g.confianza || {};

    // Tarjeta 1 — ¿Qué es cada modelo? (un bloque por familia, borde de color)
    const modelosHTML = modelos.map(grp => {
      const items = (grp.items || []).map(it =>
        `<div class="ml-gloss-modelo ${famClase(grp.grupo)}">
          <div class="top"><code>${esc(it.clave)}</code> <b>${esc(it.nombre)}</b></div>
          <div class="desc">${esc(it.detalle)}</div>
        </div>`).join("");
      return `<div class="ml-gloss-modelo ${famClase(grp.grupo)}" style="border-left-width:0;padding-left:0">
          <div class="top"><b>${esc(grp.grupo)}</b></div>
          <div class="desc">${esc(grp.intro)}</div>
        </div>${items}`;
    }).join("");

    // Tarjeta 2 — ¿Qué mide cada métrica? (grid 2×2, badge mono)
    const metHTML = metricas.map(m =>
      `<div class="ml-gloss-metrica">
        <div><span class="badge">${esc(m.clave)}</span> <b style="font-size:13px">${esc(m.nombre)}</b></div>
        <div class="def">${esc(m.definicion)}</div>
        <div class="lec">📖 ${esc(m.lectura)}</div>
      </div>`).join("");

    // Tarjeta 3 — Calificación 1–10 y confianza
    const niveles = (conf.niveles || []).map(n => {
      const k = confClase(n.etiqueta);
      return `<li><span class="ml-pill ${k}">${esc(n.etiqueta)}</span> ${esc(n.regla)}.</li>`;
    }).join("");

    c.innerHTML = `
      <div class="ml-glosario">
        <div class="tarjeta ml-gloss-card">
          <h3>¿Qué es cada modelo?</h3>
          <p class="ml-gloss-intro">El sistema compara muchos pronósticos distintos. Estos son sus tipos.</p>
          <div class="ml-gloss-modelos">${modelosHTML}</div>
        </div>
        <div class="tarjeta ml-gloss-card">
          <h3>¿Qué mide cada métrica?</h3>
          <div class="ml-gloss-metricas">${metHTML}</div>
        </div>
        <div class="tarjeta">
          <h3>${esc(cal.titulo || "Calificación 1–10 y confianza")}</h3>
          <p style="font-size:13px;color:var(--ink-2);line-height:1.6;margin:0 0 10px">${esc(cal.intro || "")}</p>
          ${cal.auditoria ? `<div class="ml-gloss-conf"><b>Auditoría v4:</b> ${esc(cal.auditoria)}</div>` : ""}
          <p style="font-size:13px;color:var(--ink-2);line-height:1.6;margin:12px 0 0">${esc(conf.intro || "")}</p>
          <ul class="ml-gloss-niveles">${niveles}</ul>
          ${conf.nota ? `<p class="suave" style="font-size:12px;margin:10px 0 0">${esc(conf.nota)}</p>` : ""}
        </div>
      </div>`;
  }

  /* ---------------- utilidades ---------------- */
  function fmtFechaCorta(iso) {
    if (!iso) return "—";
    const s = String(iso).slice(0, 10);
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${m[3]}/${m[2]}/${m[1]}`;
    return esc(s);
  }

  /* ============================================================
     Registro de la vista
     ============================================================ */
  // El glosario de MODELOS NWP/ML sale a su propio menú "Glosario" (lo reusa glosario.js).
  App.panel("glosario:modelos", (cont) => tabGlosario(cont));

  App.registrar("validacion", {
    titulo: "Validación NWP-ML", icono: "📈", orden: 2,
    async render(vista) {
      // Cada módulo OCULTA #cabecera-vista y pinta su propia cabecera.
      const cab = document.getElementById("cabecera-vista");
      if (cab) cab.style.display = "none";
      if (S.tab === "glosario") S.tab = "validacion";   // pestaña heredada → ya no existe aquí

      pintarRaiz(vista);
      const c = cuerpo();
      if (c) c.innerHTML = cargando("Cargando contexto…");

      try {
        S.ctx = await App.api("/mlnwp/contexto");
        const sel = S.ctx.deps_seleccionadas;
        if (Array.isArray(sel) && sel.length) S.deps = sel;
        const cabDeps = vista.querySelector(".ml-deps");
        if (cabDeps) { cabDeps.innerHTML = chipsDepsHTML(); cabDeps.querySelectorAll(".chip").forEach(reBindDep); }
      } catch (e) {
        if (c) c.innerHTML = vacio("No se pudo cargar el contexto ML-NWP: " + e.message);
        return;
      }
      pintarTab();
    },
    alDejar() {
      purgarPlots();   // libera las instancias Plotly y sus listeners de window
      const cab = document.getElementById("cabecera-vista");
      if (cab) cab.style.display = "";
    },
  });

  // Bus de refresco: tras CUALQUIER actualización, invalida el mapa cacheado (el
  // resumen/validación ya re-fetchean al pintar) y, si la vista está montada,
  // re-pinta la pestaña activa con datos frescos.
  document.addEventListener("datos-actualizados", () => {
    if (typeof cuerpo === "function" && cuerpo()) { try { pintarTab(); } catch (e) {} }
  });
})();
