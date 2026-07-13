/* ============================================================
   ML-NWP — Validación ML-NWP (v13: pestaña de Pronóstico).
   Ya NO es un módulo con entrada en la nav: expone window.MLNWP =
   { render(container), alDejar() } y cartas.js lo monta como la
   pestaña "Series, validación e IA" del módulo Pronóstico.
   Acento: púrpura (--ml-purple). data-screen-label="ML-NWP".
   Arquitectura: App.api / App.tarea. Mapas con Plotly.
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
  // como bloque BASE (selector/serie); la tabla de clasificación añade ADEMÁS
  // la sección de DETECCIÓN (bloque precip_det: POD/FAR/CSI) — pedido del dueño.
  const VAR_A_BLOQUE = { precip: "precip_cua", tmax: "tmax", tmin: "tmin" };
  // Etiqueta de variable para Series (la ruta /series acepta precip|tmax|tmin).
  const VAR_SERIE = { precip: "precip", tmax: "tmax", tmin: "tmin" };
  // v18 (dueño 2026-07-10): el selector VENTANA se RETIRÓ de la UI.
  // - La serie temporal muestra SIEMPRE 10 días pasados + presente + todo el
  //   futuro disponible (lookback=10, producto ya congelado en el visor).
  // - La validación usa la ventana fija de 30 fechas (equilibrio robustez/actualidad,
  //   la misma que usa "Decisiones operativas").
  const LOOKBACK_SERIE = 10;
  const VENTANA_VALID = "30";

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
    // texto blanco solo en los extremos OSCUROS de la escala (rojo intenso y verde
    // intenso); en los tonos medios (amarillos/verdes claros) el blanco no contrasta.
    const fg = (bg === "#1A9850" || bg === "#D73027") ? "#fff" : "#1E1E1E";
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
  // Redes SIEMPRE incluidas (los chips INAMHI/CELEC/Hidronación se retiraron a
  // pedido del dueño): el filtrado client-side por red se conserva internamente
  // para no romper los productos congelados, pero sin UI. La red de cada
  // estación sigue visible por fila en el combobox.
  const DEPS = ["INAMHI", "CELEC", "Hidronación"];

  const S = {
    ctx: null,
    variable: "precip",          // precip | tmax | tmin
    familia: "Todos",            // filtro de familia de modelo
    estacion: "",                // código de estación (v12: siempre por estación)
    valData: null,               // última respuesta de /validacion (alimenta el selector)
    geojson: null,
  };

  const depsQS = () => "deps=" + encodeURIComponent(DEPS.join(","));

  // Contador de generación: invalida respuestas async en vuelo cuando el usuario
  // cambia de ámbito/variable/ventana/familia/estación antes de que resuelvan
  // (App.api no cancela). El último cambio gana; los pares viejos se descartan.
  let gen = 0;

  /* ============================================================
     RENDER raíz: la vista vive como PESTAÑA dentro de Pronóstico —
     sin cabecera grande propia (kicker/h1) ni chips de dependencia;
     solo un sub-encabezado compacto.
     ============================================================ */
  function pintarRaiz(vista) {
    vista.innerHTML = `
      <div class="ml-raiz" data-screen-label="ML-NWP">
        <div class="ml-cab-mini">Validación NWP-ML · compara 41 modelos por estación · calificación 1–10 con confianza muestral</div>
        <div id="ml-cuerpo"></div>
      </div>`;
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
    // Las temperaturas solo existen en la red INAMHI: sin ella se deshabilitan
    // (con el motivo en el title) en vez de caer a otro bloque en silencio.
    // (Con DEPS fijas siempre está INAMHI; se conserva por robustez.)
    const sinTemp = !DEPS.includes("INAMHI");
    const optsVar = vars.map(([id, t]) => {
      const des = sinTemp && (id === "tmax" || id === "tmin");
      return `<option value="${id}" ${S.variable === id ? "selected" : ""}${des ? ` disabled title="Requiere la red meteorológica"` : ""}>${t}</option>`;
    }).join("");
    const optsFam = FAMILIAS_UI.map(([val, et]) =>
      `<option value="${esc(val)}" ${S.familia === val ? "selected" : ""}>${esc(et)}</option>`).join("");
    const chev = `<span class="ml-loc-chev"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#95A1B2" stroke-width="2.5"><path d="M6 9l6 6 6-6" stroke-linecap="round" stroke-linejoin="round"></path></svg></span>`;
    // v18: deck en UNA fila — VARIABLE · ESTACIÓN · FAMILIA (el selector Ventana se
    // retiró: la serie muestra 10 días pasados + presente + todo el futuro).
    return `
      <div class="ml-deck">
        <div class="ml-deck-rail"></div>
        <div class="ml-deck-cuerpo">
          <div class="ml-grupo">
            <span class="ml-grupo-lab">Variable</span>
            <div class="ml-loc"${sinTemp ? ` title="T. máxima y T. mínima requieren la red meteorológica"` : ""}>
              <select id="ml-sel-var">${optsVar}</select>
              ${chev}
            </div>
          </div>
          <div class="ml-deck-div"></div>
          <div class="ml-grupo ml-loc-grp">
            <span class="ml-grupo-lab">Estación</span>
            <div class="ml-loc ml-combo" id="ml-combo-est">
              <span class="ml-loc-mira"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#6A47CE" stroke-width="2"><circle cx="12" cy="12" r="6"></circle><path d="M12 1v4M12 19v4M1 12h4M19 12h4" stroke-linecap="round"></path></svg></span>
              <input id="ml-est-input" type="text" placeholder="Cargando…" autocomplete="off" spellcheck="false">
              ${chev}
              <div class="ml-combo-lista" id="ml-est-lista" tabindex="-1" hidden></div>
            </div>
          </div>
          <div class="ml-deck-div ml-deck-div-ancha"></div>
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
    // Sin INAMHI no existe el bloque de temperaturas: se fuerza precipitación
    // ANTES de pintar el deck (que además deshabilita tmax/tmin con el motivo),
    // en vez de dejar que el backend caiga a otro bloque en silencio.
    if (!DEPS.includes("INAMHI") && (S.variable === "tmax" || S.variable === "tmin")) {
      S.variable = "precip";
      App.aviso("Las temperaturas solo existen en la red meteorológica: se muestra precipitación.", "info");
    }
    c.innerHTML = deckHTML() + `<div id="ml-vista-est"></div>`;
    bindDeck(c);
    await cargarValidacion();
  }

  function bindDeck(c) {
    const selVar = c.querySelector("#ml-sel-var");
    if (selVar) selVar.onchange = () => { S.variable = selVar.value; cargarValidacion(); };
    const selFam = c.querySelector("#ml-sel-fam");
    if (selFam) selFam.onchange = () => { S.familia = selFam.value; cargarValidacion(); };
    const combo = c.querySelector("#ml-combo-est");
    if (combo) bindComboEst(combo);
  }

  /* ---------------- combobox de estación (búsqueda escrita) ---------------- */
  // Opciones vivas del combobox: estaciones con datos de /validacion, ya
  // filtradas por red y ordenadas por región → dependencia → nombre.
  let comboEsts = [];
  const normTxt = s => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

  function etiquetaEst() {
    const e = comboEsts.find(x => String(x.codigo) === String(S.estacion));
    return e ? `${e.codigo} · ${e.nombre} (${App.redEtiqueta(e.region)})` : "";
  }

  // Lista agrupada por REGIÓN (encabezados) con la dependencia visible por fila:
  // el catálogo queda identificado por región y red de cada estación.
  function opcionesComboHTML(q) {
    const nq = normTxt(q);
    const visibles = comboEsts.filter(e => !nq ||
      normTxt(`${e.codigo} ${e.nombre} ${e.region} ${e.dependencia || ""}`).includes(nq));
    if (!visibles.length) return `<div class="ml-combo-vacia">Sin coincidencias.</div>`;
    let html = "", region = null;
    for (const e of visibles) {
      if (e.region !== region) {
        region = e.region;
        html += `<div class="ml-combo-grupo">${esc(App.redEtiqueta(region))}</div>`;
      }
      html += `<button type="button" class="ml-combo-op ${String(e.codigo) === String(S.estacion) ? "activa" : ""}" data-cod="${esc(e.codigo)}">
        <span class="cod">${esc(e.codigo)}</span><span class="nom">${esc(e.nombre)}</span>
        <span class="dep">${esc(App.redEtiqueta(e.dependencia || ""))}</span></button>`;
    }
    return html;
  }

  // Rellena el combobox tras cada /validacion (el deck NO se re-pinta entre cargas).
  function poblarComboEst(ests) {
    comboEsts = ests;
    const input = document.getElementById("ml-est-input");
    const lista = document.getElementById("ml-est-lista");
    if (!input || !lista) return;
    input.disabled = !ests.length;
    input.placeholder = ests.length ? "Buscar por código, nombre, región o red…" : "Sin estaciones";
    if (document.activeElement !== input) input.value = etiquetaEst();
    if (!lista.hidden) lista.innerHTML = opcionesComboHTML(input.value);
  }

  function bindComboEst(combo) {
    const input = combo.querySelector("#ml-est-input");
    const lista = combo.querySelector("#ml-est-lista");
    // Tras CADA re-render hay que resetear el scroll: la lista conserva el scrollTop
    // del estado anterior (p.ej. el salto a la estación activa al abrir) y las
    // opciones filtradas quedaban FUERA de la ventana visible — el usuario escribía
    // y veía la lista "vacía" sin nada que clicar.
    const refrescar = q => { lista.innerHTML = opcionesComboHTML(q); lista.scrollTop = 0; };
    // Al ABRIR se muestra la lista completa DESDE ARRIBA (refrescar ya resetea el
    // scroll): el viejo scrollIntoView a la estación activa confundía — parecía
    // que solo había una opción. La activa queda resaltada si se scrollea a ella.
    const abrir = () => {
      if (input.disabled) return;
      lista.hidden = false;
      refrescar("");
      input.select();
    };
    const cerrar = () => { lista.hidden = true; input.value = etiquetaEst(); };
    const elegir = cod => {
      S.estacion = String(cod);
      input.blur();   // blur → cerrar() repone la etiqueta de la selección nueva
      pintarVistaAmbito();
    };
    input.onfocus = abrir;
    // Si el foco cayó en la lista (arrastre del scrollbar en Firefox), se
    // devuelve al input en vez de cerrar; si salió del combo, se cierra.
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
        if (obj) elegir(obj.dataset.cod);
      }
    };
    // mousedown en una OPCIÓN no roba el foco (el click llega antes del blur);
    // en el resto de la lista (scrollbar) se deja pasar y el blur lo repone arriba.
    lista.onmousedown = ev => { if (ev.target.closest(".ml-combo-op")) ev.preventDefault(); };
    lista.onclick = ev => {
      const b = ev.target.closest(".ml-combo-op");
      if (b) elegir(b.dataset.cod);
    };
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
    const vent = VENTANA_VALID;
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
    if (d.aviso) App.aviso(d.aviso, "info");

    // Filtro de dependencia CLIENT-SIDE: en el visor /validacion está congelado
    // con las 3 redes juntas (los chips no cambiaban nada); con backend vivo la
    // intersección es inocua. La red de cada estación sale del contexto
    // (depMap codigo→dependencia), que ya la trae.
    const depMap = {};
    for (const e of (S.ctx && S.ctx.estaciones) || []) depMap[String(e.codigo)] = e.dependencia || "";
    const todas = d.estaciones || [];
    const ests = todas
      .map(e => ({ ...e, dependencia: depMap[String(e.codigo)] || "" }))
      .filter(e => !e.dependencia || DEPS.includes(e.dependencia));
    ests.sort((a, b) => String(a.region).localeCompare(String(b.region))
      || String(a.dependencia).localeCompare(String(b.dependencia))
      || String(a.nombre).localeCompare(String(b.nombre)));
    if (!ests.length) {
      poblarComboEst([]);
      const cont2 = document.getElementById("ml-vista-est");
      if (cont2) cont2.innerHTML = vacio(todas.length
        ? `Ninguna estación de las redes (${DEPS.join(" + ")}) tiene datos para esta combinación.`
        : "Sin estaciones con datos para esta combinación.");
      return;
    }
    if (!ests.some(e => String(e.codigo) === String(S.estacion)))
      S.estacion = String(ests[0].codigo);
    poblarComboEst(ests);
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
    const vent = VENTANA_VALID;
    const famQS = "&familia=" + encodeURIComponent(S.familia);
    const lookback = LOOKBACK_SERIE;   // contrato web: 10 días pasados + presente
    const esPrecip = S.variable === "precip";
    let det, ser, detDet;
    try {
      [det, ser, detDet] = await Promise.all([
        App.api(`/mlnwp/validacion_estacion?bloque=${bloque}&ventana=${vent}&${depsQS()}&codigo=${encodeURIComponent(S.estacion)}`),
        App.api(`/mlnwp/series?${depsQS()}&codigo=${encodeURIComponent(S.estacion)}&variable=${VAR_SERIE[S.variable]}&lookback=${lookback}${famQS}`),
        // DETECCIÓN de precip (POD/FAR/CSI, bloque precip_det): segunda sección
        // de la tabla de clasificación. OPCIONAL — si el producto no está
        // publicado (visor viejo) o falla, la tabla muestra solo cuantificación.
        esPrecip
          ? App.api(`/mlnwp/validacion_estacion?bloque=precip_det&ventana=${vent}&${depsQS()}&codigo=${encodeURIComponent(S.estacion)}`).catch(() => null)
          : Promise.resolve(null),
      ]);
    } catch (e) { if (mi === gen) cont.innerHTML = vacio("No se pudo cargar la estación: " + e.message); return; }
    // descarta si llegó una selección más nueva durante la carga
    if (mi !== gen || !S.estacion) return;
    purgarPlots();   // libera cualquier serie previa antes de reescribir el contenedor
    // Serie ARRIBA; tabla de clasificación DEBAJO. (La tarjeta 'Veredicto para
    // mañana' se RETIRÓ de esta pestaña a pedido del dueño; el endpoint
    // /mlnwp/veredicto sigue vivo — lo consume el submenú nuevo.)
    cont.innerHTML = `<div class="ml-card" id="ml-serie-card"></div>
      <div id="ml-detalle" style="margin-top:14px"></div>`;
    pintarSerie(document.getElementById("ml-serie-card"), ser);
    pintarDetalle(document.getElementById("ml-detalle"), det, detDet);
  }

  // UNA tabla de clasificación (un bloque de métricas: detección o cuantificación).
  // La usa pintarDetalle — para precip se pintan DOS (detección + cuantificación).
  function tablaClasifHTML(d) {
    // Filtro de familia: restringe los modelos mostrados (client-side, como el resumen).
    const filtrarFam = S.familia && S.familia !== "Todos" && S.familia !== "Mejor desempeño";
    let modelos = d.modelos || [];
    if (filtrarFam) modelos = modelos.filter(m => m.familia === S.familia);
    const esDet = d.modo === "detection";

    // Cabeceras de métricas según el modo (detección vs continuo/cuantificación).
    const metHead = esDet
      ? [["pod", "POD"], ["far", "FAR"], ["csi", "CSI"]]
      : [["mae", "MAE"], ["rmse", "RMSE"], ["bias", "Sesgo"], ["corr", "Corr"]];
    const metHeadHTML = metHead.map(([, t]) => `<th class="der">${t}</th>`).join("");
    const nCols = 5 + metHead.length;

    const fmtMet = (m, k) => {
      const v = m[k];
      if (v === null || v === undefined || Number.isNaN(v)) return "—";
      if (k === "bias") return sgn(v);
      if (k === "corr" || k === "pod" || k === "far" || k === "csi") return Number(v).toFixed(2);
      return Number(v).toFixed(1);
    };

    // GANADOR del bloque = mayor calificación entre los que califican (con muestra suficiente).
    // El mejor DETECTOR (POD/FAR/CSI) puede no ser el mejor CUANTIFICADOR (MAE) → por eso el
    // ganador y el banner son POR BLOQUE, no uno global: es más honesto.
    let mejorIdx = -1, mejorRating = -Infinity;
    modelos.forEach((m, i) => {
      if (m.califica && m.rating != null && m.rating > mejorRating) { mejorRating = m.rating; mejorIdx = i; }
    });

    const filas = modelos.map((m, i) => {
      const sinCal = !m.califica || m.rating == null;
      const [bg, fg] = calColor(m.rating);
      const tipoFam = { Convencionales: "grillado", "No convencionales": "grillado",
        ML: "calibrado", Postprocesamiento: "combinación" }[m.familia] || "crudo";
      const metTds = metHead.map(([k]) =>
        `<td class="num">${sinCal ? "—" : fmtMet(m, k)}</td>`).join("");
      const esMejor = i === mejorIdx;
      return `<tr class="${sinCal ? "sin-calif" : ""}${esMejor ? " ml-best" : ""}">
        <td class="idx">${sinCal ? "—" : i + 1}</td>
        <td><span class="ml-mod-punto" style="background:${esc(m.color)}"></span>${esc(m.modelo)}${esMejor ? " ★" : ""}<span class="ml-mod-tipo"> · ${tipoFam}</span></td>
        <td>${sinCal ? `<span style="color:var(--muted-2)">sin calif.</span>`
          : `<span class="ml-calif-badge" style="background:${bg};color:${fg}">${num(m.rating, 1)}</span>`}</td>
        <td class="num">${m.n}</td>
        <td>${pillConf(m.confianza)}</td>
        ${metTds}
      </tr>`;
    }).join("");

    // Banner del ganador con su n (evita coronar a un modelo con muestra diminuta).
    const mg = mejorIdx >= 0 ? modelos[mejorIdx] : null;
    const banner = mg
      ? `<div class="ml-mejor-banner"><span class="ml-mejor-estrella">★</span> Mejor en ${esDet ? "detección de eventos" : "cuantificación"}:
         <b>${esc(mg.modelo)}</b> — calif. ${num(mg.rating, 1)}/10 · confianza ${esc(String(mg.confianza || "—")).toLowerCase()} · <b>${mg.n}</b> fechas</div>`
      : "";

    return `${banner}
      <table class="ml-tabla-modelos">
        <thead><tr>
          <th>#</th><th>Modelo</th><th>Calif.</th><th class="der">Fechas</th><th>Confianza</th>
          ${metHeadHTML}
        </tr></thead>
        <tbody>${filas || `<tr><td colspan="${nCols}" class="suave" style="padding:14px">Sin modelos para esta estación.</td></tr>`}</tbody>
      </table>`;
  }

  // UNA SOLA tabla para precip (pedido del dueño 2026-07-09): detección Y cuantificación
  // en la misma fila por modelo — la columna del MODELO queda FIJA (sticky) y las
  // métricas se deslizan en X. Aplica a escritorio y móvil.
  function tablaUnificadaHTML(dCua, dDet) {
    const filtrarFam = S.familia && S.familia !== "Todos" && S.familia !== "Mejor desempeño";
    const fil = ms => filtrarFam ? (ms || []).filter(m => m.familia === S.familia) : (ms || []);
    const cua = fil(dCua.modelos), det = fil(dDet.modelos);
    const dmap = new Map(det.map(m => [m.modelo, m]));
    // Orden = el del bloque base (cuantificación, ya viene por calificación); los
    // modelos solo-detección se anexan al final.
    const orden = [...cua];
    det.forEach(m => { if (!cua.some(x => x.modelo === m.modelo)) orden.push({ ...m, _soloDet: true }); });
    const mejorDe = ms => { let bn = null, br = -Infinity;
      ms.forEach(m => { if (m.califica && m.rating != null && m.rating > br) { br = m.rating; bn = m.modelo; } }); return bn; };
    const bestCua = mejorDe(cua), bestDet = mejorDe(det);
    const sinC = m => !m || !m.califica || m.rating == null;
    const f2 = v => (v == null || Number.isNaN(v)) ? "—" : Number(v).toFixed(2);
    const f1 = v => (v == null || Number.isNaN(v)) ? "—" : Number(v).toFixed(1);
    const badge = (m, best) => sinC(m)
      ? `<span style="color:var(--muted-2)">—</span>`
      : (([bg, fg]) => `<span class="ml-calif-badge" style="background:${bg};color:${fg}">${num(m.rating, 1)}</span>${m.modelo === best ? " ★" : ""}`)(calColor(m.rating));
    const filas = orden.map((base, i) => {
      const mc = base._soloDet ? null : base;
      const md = dmap.get(base.modelo) || (base._soloDet ? base : null);
      const tipoFam = { Convencionales: "grillado", "No convencionales": "grillado",
        ML: "calibrado", Postprocesamiento: "combinación" }[base.familia] || "crudo";
      return `<tr>
        <td class="ml-uni-mod"><span class="ml-uni-idx">${i + 1}</span><span class="ml-mod-punto" style="background:${esc(base.color)}"></span>${esc(base.modelo)}<span class="ml-mod-tipo"> · ${tipoFam}</span></td>
        <td>${badge(md, bestDet)}</td>
        <td class="num">${sinC(md) ? "—" : f2(md.pod)}</td>
        <td class="num">${sinC(md) ? "—" : f2(md.far)}</td>
        <td class="num">${sinC(md) ? "—" : f2(md.csi)}</td>
        <td>${badge(mc, bestCua)}</td>
        <td class="num">${sinC(mc) ? "—" : f1(mc.mae)}</td>
        <td class="num">${sinC(mc) ? "—" : f1(mc.rmse)}</td>
        <td class="num">${sinC(mc) ? "—" : sgn(mc.bias)}</td>
        <td class="num">${sinC(mc) ? "—" : f2(mc.corr)}</td>
        <td class="num">${(mc && mc.n) ?? (md && md.n) ?? "—"}</td>
        <td>${pillConf((mc || md || {}).confianza)}</td>
      </tr>`;
    }).join("");
    const ban = (ms, best, etq) => {
      const mg = ms.find(m => m.modelo === best);
      return mg ? `<div class="ml-mejor-banner"><span class="ml-mejor-estrella">★</span> Mejor en ${etq}:
        <b>${esc(mg.modelo)}</b> — calif. ${num(mg.rating, 1)}/10 · <b>${mg.n}</b> fechas</div>` : "";
    };
    return `${ban(det, bestDet, "detección de eventos")}${ban(cua, bestCua, "cuantificación")}
      <div class="ml-uni-wrap">
      <table class="ml-tabla-modelos ml-uni">
        <thead>
          <tr><th class="ml-uni-mod" rowspan="2">Modelo</th>
              <th colspan="4" class="ml-uni-grp">Detección · ¿llueve sí/no?</th>
              <th colspan="4" class="ml-uni-grp">Cuantificación · ¿cuánto?</th>
              <th colspan="3" class="ml-uni-grp">Muestra</th></tr>
          <tr><th>Calif.</th><th class="der">POD</th><th class="der">FAR</th><th class="der">CSI</th>
              <th>Calif.</th><th class="der">MAE</th><th class="der">RMSE</th><th class="der">Sesgo</th>
              <th class="der">Corr</th><th class="der">Fechas</th><th>Conf.</th></tr>
        </thead>
        <tbody>${filas || `<tr><td colspan="12" class="suave" style="padding:14px">Sin modelos para esta estación.</td></tr>`}</tbody>
      </table></div>
      <div class="ml-pb-nota">Detección: POD acierto · FAR falsa alarma · CSI global. Cuantificación: MAE/RMSE error en mm · Sesgo · Corr. Desliza la tabla para ver todas las métricas; el modelo y su calificación quedan fijos.</div>`;
  }

  // Tarjeta 'Clasificación de modelos'. d = bloque principal (cuantificación en
  // precip; continuo en temperaturas). dDet = bloque precip_det (POD/FAR/CSI) —
  // solo en precip: UNA tabla unificada (detección + cuantificación por fila).
  function pintarDetalle(cont, d, dDet) {
    const nom = d.nombre || S.estacion;
    const dosSecciones = !!(dDet && (dDet.modelos || []).length);
    const cuerpo = dosSecciones ? tablaUnificadaHTML(d, dDet) : tablaClasifHTML(d);
    cont.innerHTML = `
      <div class="ml-card">
        <h3 class="ml-titulo">Clasificación de modelos en ${esc(nom)}
          <span class="ml-sutil">· ${esc(d.codigo)} · ${esc(App.redEtiqueta(d.region))} · ordenados por calificación</span></h3>
        ${cuerpo}
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
  // wNegro parametrizado (spec de anchos): mini-mapas/grillas 1.5 (defecto) ·
  // MAPA GRANDE (ganador) 2.0 — el llamador del mapa grande pasa opts.outlineW = 2.
  function outlineTrace(wNegro = 1.5) {
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
    // Lienzo de mapa = papel blanco en ambos temas → halo blanco + línea negra SIEMPRE.
    return [
      Object.assign({}, base, { line: { color: "#ffffff", width: 3.4 } }),
      Object.assign({}, base, { line: { color: "#000000", width: wNegro } }),
    ];
  }

  // Relieve continental RELLENO (mapa base): que el mapa no sean puntos pelados.
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
    // Lienzo de mapa = papel blanco en ambos temas → continente blanco casi opaco.
    return { type: "scatter", mode: "lines", x: xs, y: ys, fill: "toself", hoverinfo: "skip",
      fillcolor: "rgba(255,255,255,.95)",
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
    // Contorno de Ecuador con encasillado (negro + halo blanco). Ancho por tipo de
    // mapa: mini-mapas por modelo 1.5 (defecto) · MAPA GRANDE ganador 2.0 (opts.outlineW).
    traces.push(...outlineTrace(opts.outlineW || 1.5));

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
      if (App.pinchZoomMapa) App.pinchZoomMapa(el);   // v17: pinza = zoom del mapa
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
    // Halo-contenedor de las etiquetas de valor (pedido del dueño): sombra apilada del
    // color del lienzo → el número "flota" legible sobre banda/líneas en ambos temas.
    C.halo = oscuro ? "0 0 3px #0E1930, 0 0 3px #0E1930, 0 0 4px #0E1930"
                    : "0 0 3px #FFFFFF, 0 0 3px #FFFFFF, 0 0 4px #FFFFFF";
    const tit = `${esc(d.variable === "precip" ? "Precipitación 7-7" : (d.variable === "tmax" ? "T. máxima" : "T. mínima"))} — ${esc(d.nombre || "")} (${esc(d.codigo)})`;
    card.innerHTML = `
      <div class="ml-serie-tit">${tit}</div>
      <div class="ml-plot-scroll"><div class="ml-serie-plot" id="ml-plot-serie"></div></div>
      <div class="ml-serie-leyenda" id="ml-serie-leyenda"></div>
      <div class="ml-serie-probs" id="ml-serie-probs"></div>
      <p class="ml-serie-pie">Observado vs. pronóstico (la franja sombreada de la derecha es el horizonte futuro). Los modelos se atenúan según su calificación.${esPrecip ? " Detalle probabilístico por umbral en la tabla inferior." : ""}</p>`;

    const el = document.getElementById("ml-plot-serie");
    if (!window.Plotly || !el) return;
    // v12 (pedido del dueño): en pantallas angostas la serie CABE en el ancho (sin
    // zoom/scroll); el detalle por fecha se lee con el popup unificado al TOCAR.
    // Ejes fijos → el gesto táctil no deforma; ticks automáticos → legibles a 390px.
    const angosto = (card.clientWidth || window.innerWidth || 999) < 560;

    const traces = [];
    const fx = arr => (arr || []).map(s => s);

    // BANDA INTERCUARTIL RETIRADA (pedido del dueño 2026-07-11): el abanico P25–P75 /
    // P10–P90 y la mediana P50 se distorsionaban en el pronóstico a futuro. Se conserva el
    // pronóstico puntual (líneas/barras de modelos + observado) y, para precip, la tabla de
    // probabilidad por umbral. d.banda sigue llegando del backend pero ya no se dibuja (solo
    // se usa más abajo para fijar el tope del horizonte 'futuro' de la franja sombreada).

    // Modelos (atenuados por calificación: opacity ya viene de /series). En OSCURO
    // los pasteles atenuados se fantasmagorizan sobre el fondo: piso de opacidad
    // 0.85 y grosor mínimo 2 conservando la atenuación relativa entre modelos.
    // v16 (pedido del dueño): los 3 MEJORES modelos muestran sus VALORES como
    // etiqueta en el presente y el futuro (fechas >= hoy); el pasado queda limpio
    // (ahí las etiquetas son del observado).
    const leyenda = [];
    const _hoyEt = (App.hoyEC ? App.hoyEC() : d.hoy);
    let _conEtiqueta = 0;
    // El backend antepone los productos operativos que alimentan alertas/cartas;
    // el cupo restante muestra los comparadores con mayor skill.
    for (let m of (d.modelos || []).slice(0, 8)) {   // let: el respaldo se re-etiqueta abajo
      const color = m.color;
      const opBase = m.opacity ?? .7;
      const op = oscuro ? Math.max(.85, opBase) : opBase;
      const wLin = oscuro ? Math.max(2, m.width ?? 1.5) : (m.width ?? 1.5);
      // 'Sin entrenamiento' (m.dash/m.sin_entrenar) = tramo pasado-sin-obs con el fallback
      // colapsado: UNA línea punteada gris SIN rating (aunque sea precip), en vez de ~26
      // líneas/barras idénticas superpuestas ("todos los modelos iguales / plano").
      // v14: nombre CLARO para el usuario (el crudo "Sin entrenamiento" confundía).
      if (m.sin_entrenar) m = { ...m, modelo: "Respaldo (sin obs para entrenar)" };
      const rtxt = m.sin_entrenar ? "" : ` (${num(m.rating, 1)})`;
      const otxt = m.operacional ? " · operativo" : "";
      // etiquetas de valor en fechas >= hoy, SOLO para los 3 mejores (d.modelos ya
      // viene ordenado por calificación descendente).
      const _etiquetar = !m.sin_entrenar && _hoyEt && _conEtiqueta < 3;
      const _texto = _etiquetar
        ? (m.fechas || []).map((f, i) => {
            const v = m.valores[i];
            if (v == null || f < _hoyEt) return "";
            // 0 mm ES un dato (pedido del dueño): se etiqueta como cualquier valor.
            return num(v, 1);
          })
        : null;
      if (_etiquetar) _conEtiqueta++;
      if (esPrecip && !m.dash) {
        traces.push({ type: "bar", x: fx(m.fechas), y: m.valores, name: `${m.modelo}${otxt}${rtxt}`,
          marker: { color, opacity: op },
          ...(_texto ? { text: _texto, textposition: "outside", cliponaxis: false,
            textfont: { size: 8.5, color, shadow: C.halo }, constraintext: "none" } : {}),
          hovertemplate: `${esc(m.modelo)}: %{y} ${unidad}<extra></extra>` });
      } else {
        // connectgaps:false + eje completo con null (series.py): un hueco de fechas
        // se ve como hueco, NO como diagonal fantasma (queja La Argelia 84270 03/07).
        traces.push({ type: "scatter", mode: _texto ? "lines+text" : "lines", x: fx(m.fechas), y: m.valores, name: `${m.modelo}${otxt}${rtxt}`,
          line: { color, width: wLin, ...(m.dash ? { dash: m.dash } : {}) }, opacity: op, connectgaps: false,
          ...(_texto ? { text: _texto, textposition: "top center", cliponaxis: false,
            textfont: { size: 8.5, color, shadow: C.halo } } : {}),
          hovertemplate: `${esc(m.modelo)}: %{y} ${unidad}<extra></extra>` });
      }
      const swStyle = m.dash ? `border-top:2px dotted ${esc(color)};height:0`
                             : `background:${esc(color)};opacity:${op}`;
      leyenda.push(`<span class="it"><span class="sw-caja" style="${swStyle}"></span>${esc(m.modelo)}${esc(otxt)}${rtxt}</span>`);
    }

    // Observado: línea punteada negra con marcadores + etiquetas SIEMPRE (v16: el
    // lienzo angosto es de 680px con scroll, caben; pedido del dueño).
    if (d.observado && d.observado.fechas && d.observado.fechas.length) {
      traces.push({ type: "scatter", mode: "lines+markers+text", x: d.observado.fechas, y: d.observado.valores,
        // 0 mm observado ES un dato (pedido del dueño): se etiqueta igual que el resto.
        text: d.observado.valores.map(v => (v == null ? "" : num(v, 1))),
        textposition: "top center", textfont: { size: 9, color: C.obs, shadow: C.halo }, cliponaxis: false,
        name: "Observado", line: { color: C.obs, width: 2.8 }, connectgaps: false,
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
      yaxis: { title: { text: unidad, font: { size: 11 } }, rangemode: esPrecip ? "tozero" : "normal",
               ...(angosto ? { fixedrange: true } : {}) },
      // Eje X: TODAS las fechas (un tick por día, rotadas -45°) — el lienzo tiene ancho
      // mínimo 680px en angosto (scroll), así que siguen legibles. En angosto los ejes
      // van FIJOS: el gesto táctil desliza el contenedor y el tap abre el popup.
      xaxis: { type: "date", tickformat: "%d/%m", tickmode: "linear", dtick: 86400000,
               tickangle: -45, tickfont: { size: 9 }, automargin: true,
               ...(angosto ? { fixedrange: true } : {}) },
    });
    // Distinción HISTORIA vs PRONÓSTICO: franja de fondo desde HOY hasta el final +
    // línea divisoria. F5: "hoy" se calcula en el CLIENTE (TZ Ecuador) — el visor
    // congela los JSON y el 'hoy' del backend envejece; d.hoy queda de fallback.
    const _hoy = (App.hoyEC ? App.hoyEC() : d.hoy);
    if (_hoy) {
      // finX = la fecha MÁS TARDÍA entre banda y modelos (no solo la banda): banda y
      // líneas salen de bases distintas y solo comparten el 'desde'; tomar el máximo
      // hace que la franja de 'futuro' cubra TODO el pronóstico dibujado, sin importar
      // cuál se extienda más (coherente con el pie 'mismo horizonte que las líneas').
      const _fins = [];
      if (d.banda && d.banda.fechas && d.banda.fechas.length) _fins.push(d.banda.fechas[d.banda.fechas.length - 1]);
      const _modFechas = (d.modelos || []).flatMap(m => m.fechas || []);
      if (_modFechas.length) _fins.push(_modFechas.slice().sort().slice(-1)[0]);
      const finX = _fins.length ? _fins.sort().slice(-1)[0] : _hoy;
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
    Plotly.newPlot(el, traces, layout, App.plotlyConfig(angosto ? { displayModeBar: false } : {})).then(() => {
      // v13: el scroll ARRANCA en el extremo derecho — lo más reciente + pronóstico
      // siempre visibles al entrar (pedido del dueño); inocuo si no hay overflow.
      const sc = el.closest(".ml-plot-scroll");
      if (sc) sc.scrollLeft = sc.scrollWidth;
    });

    const leyEl = document.getElementById("ml-serie-leyenda");
    if (leyEl) leyEl.innerHTML =
      `<span class="it"><span class="sw-linea"></span>Observado</span>` + leyenda.join("");

    // Tabla de probabilidades por umbral: los porcentajes por nivel de lluvia (antes
    // solo se veía la 'sombra' de la banda y no estos números).
    const probsEl = document.getElementById("ml-serie-probs");
    if (probsEl) {
      const pu = d.probs_umbral;
      if (esPrecip && pu && pu.fechas && pu.fechas.length) {
        // MISMO eje temporal que las líneas (v18): el backend re-expande la matriz a la
        // rejilla diaria completa [hoy−10, tope futuro] (_eje_comun) — una COLUMNA por
        // CADA fecha de la serie, con "—" donde no hay producto. Tabla TRANSPUESTA:
        // una fila por umbral, alineada 1:1 con el eje de la serie.
        let idx = pu.fechas.map((_, i) => i);
        // Índice de la 1ª columna de pronóstico (>= hoy) para separar visualmente pasado/futuro,
        // coherente con la línea divisoria 'inicio pronóstico →' del gráfico.
        const iHoy = _hoy ? idx.find(i => pu.fechas[i] >= _hoy) : undefined;
        const alfa = p => p < 20 ? 0.08 : p < 50 ? 0.20 : p < 75 ? 0.38 : 0.58;
        const celStyle = p => p == null
          ? "color:var(--faint)"
          : `background:rgba(43,93,170,${alfa(p).toFixed(2)});color:${p >= 75 ? "#fff" : "var(--ink)"}`;
        const dd = f => `${f.slice(8, 10)}/${f.slice(5, 7)}`;
        const sep = i => i === iHoy ? " ml-pb-hoy" : "";   // borde que marca el inicio del pronóstico
        const cabFechas = idx.map(i => `<th class="ml-pb-f${sep(i)}">${dd(pu.fechas[i])}</th>`).join("");
        const filasU = (pu.umbrales || []).map((u, j) => {
          const celdas = idx.map(i => {
            const p = (pu.probs[i] || [])[j];
            return `<td class="ml-pb-c${sep(i)}" style="${celStyle(p)}">${p == null ? "—" : p + "%"}</td>`;
          }).join("");
          return `<tr><th class="ml-pb-u">≥${u} mm</th>${celdas}</tr>`;
        }).join("");
        probsEl.innerHTML =
          `<div class="ml-pb-tit">Probabilidad de lluvia por umbral</div>
           <div class="ml-pb-wrap"><table class="ml-pb-tabla"><thead><tr><th class="ml-pb-esq">Umbral</th>${cabFechas}</tr></thead>
           <tbody>${filasU}</tbody></table></div>
           <div class="ml-pb-nota">Mismo horizonte que la serie (histórico + pronóstico); la línea vertical marca el inicio del pronóstico. Probabilidad calibrada (promedio de clasificadores). Ej.: “≥25 mm = 30 %” = 30 % de probabilidad de que llueva más de 25 mm ese día.</div>`;
        // v13: umbral FIJO (sticky) y el scroll de fechas arranca a la DERECHA (lo más reciente).
        const w = probsEl.querySelector(".ml-pb-wrap");
        if (w) w.scrollLeft = w.scrollWidth;
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

  /* ============================================================
     Exposición de la vista: PESTAÑA "Series, validación e IA" del
     módulo Pronóstico. cartas.js invoca window.MLNWP.render(container)
     al activarla y window.MLNWP.alDejar() al salir de la pestaña (o del
     módulo). Ya NO se registra entrada propia en la nav.
     ============================================================ */
  // El glosario de MODELOS NWP/ML sale a su propio menú "Glosario" (lo reusa glosario.js).
  App.panel("glosario:modelos", (cont) => tabGlosario(cont));

  window.MLNWP = {
    async render(vista) {
      // La cabecera global ya la gestiona el módulo anfitrión (Pronóstico):
      // aquí no se toca #cabecera-vista.
      pintarRaiz(vista);
      const c = cuerpo();
      if (c) c.innerHTML = cargando("Cargando contexto…");
      try {
        // El contexto trae el catálogo de estaciones (codigo→dependencia) para el
        // filtrado interno por red; las DEPS son fijas (los chips se retiraron).
        S.ctx = await App.api("/mlnwp/contexto");
      } catch (e) {
        if (c) c.innerHTML = vacio("No se pudo cargar el contexto ML-NWP: " + e.message);
        return;
      }
      pintarTab();
    },
    alDejar() {
      purgarPlots();   // libera las instancias Plotly y sus listeners de window
    },
  };

  // Deep-links antiguos a la entrada de nav retirada (#/validacion o #/mlnwp):
  // redirigen al módulo Pronóstico, donde vive ahora la pestaña.
  const redirigirLegado = () => {
    if (/^#\/(validacion|mlnwp)$/.test(location.hash || "")) location.hash = "#/pronostico";
  };
  redirigirLegado();
  window.addEventListener("hashchange", redirigirLegado);

  // Bus de refresco: tras CUALQUIER actualización, invalida el mapa cacheado (el
  // resumen/validación ya re-fetchean al pintar) y, si la vista está montada,
  // re-pinta la pestaña activa con datos frescos.
  document.addEventListener("datos-actualizados", () => {
    if (typeof cuerpo === "function" && cuerpo()) { try { pintarTab(); } catch (e) {} }
  });
})();
