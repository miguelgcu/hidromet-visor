/* ============================================================
   HidroMet — Glosario. Referencia TEÓRICA: una pestaña por tipo de glosario.
   Reutiliza el glosario de modelos (App.panel "glosario:modelos", de mlnwp) y
   sirve el resto desde /cartas/glosario?familia=ffgs|metricas|hydro, más los
   glosarios ya publicados de caudales (/geoglows/glosario) y climatología
   (/clima/glosario), y una pestaña propia de eventos y avisos en lenguaje llano.

   ✔ UNIFICACIÓN APLICADA (HALLAZGO 7): los dos patrones comparten ahora el
     MARCO .tarjeta del sistema de diseño.
     · Pestaña "Modelos NWP y ML": LISTA con borde de familia, en 3 .tarjeta
       (App.panel "glosario:modelos" → mlnwp.js pintarGlosario; clases ml-gloss y fam).
       Datos anidados de /mlnwp/glosario; panel REUTILIZADO por ML-NWP (intacto).
     · Pestañas FFGS / Métricas / Hidroestimadores: TABLA dentro de una .tarjeta
       (.glo-vista > .tarjeta.glo-card, ver tablaGlosario). Datos planos de
       /cartas/glosario?familia=...
     Se CONSERVA la tabla donde el dato es tabular (FFGS = 5 columnas
     Sigla/Carta/Descripción/Unidad/Tipo); NO se fuerza a "lista con borde de
     familia" (esas familias solo existen en los modelos). Cohesión por marco +
     tipografía compartidos, SIN tocar el backend ni pintarGlosario.

   ✔ ACCESO DESDE OTROS MÓDULOS: App.abrirGlosario(pestana, termino) navega al
     Glosario, abre la pestaña pedida y deja el término en el buscador. La
     última pestaña visitada se recuerda para no abrir siempre en "modelos".
   ============================================================ */
"use strict";

(() => {
  const esc = v => String(v ?? "").replace(/[&<>"']/g,
    c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  async function tablaGlosario(cont, familia) {
    cont.innerHTML = `<div class="vacio"><div class="icono">⏳</div>Cargando glosario…</div>`;
    let g;
    try { g = await App.api("/cartas/glosario?familia=" + encodeURIComponent(familia)); }
    catch (e) {
      cont.innerHTML = `<div class="vacio"><div class="icono">⚠️</div><span>${esc(e.message)}</span></div>`;
      return;
    }
    const cols = g.columnas || ["Elemento", "Descripción"];
    cont.innerHTML = `
      <div class="glo-vista">
        <div class="tarjeta glo-card">
          <div class="glo-cab">
            <h2>${esc(g.titulo || "")}</h2>
            ${g.subtitulo ? `<p>${esc(g.subtitulo)}</p>` : ""}
          </div>
          <div class="glo-tabla-wrap">
            <table class="glo-tabla">
              <thead><tr>${cols.map(c => `<th>${esc(c)}</th>`).join("")}</tr></thead>
              <tbody>${(g.filas || []).map(f =>
                `<tr>${f.map((v, i) => `<td${i === 0 ? ' class="glo-k"' : ""}>${esc(v)}</td>`).join("")}</tr>`).join("")}</tbody>
            </table>
          </div>
        </div>
      </div>`;
  }

  /* Glosarios ya publicados con forma {titulo, intro, secciones:[{titulo, texto}]}
     (caudales GEOGLOWS y metodología climática). Se pintan con el mismo marco
     de tabla que el resto de pestañas. Defensivo: si el dato no está publicado
     o llega sin secciones, se explica en llano en vez de romper. */
  async function tablaSecciones(cont, ruta, tituloDefecto) {
    cont.innerHTML = `<div class="vacio"><div class="icono">⏳</div>Cargando glosario…</div>`;
    let g;
    try { g = await App.api(ruta); }
    catch (e) {
      cont.innerHTML = `<div class="vacio"><div class="icono">⚠️</div>
        <span>Esta explicación aún no está publicada. ${esc(e.message)}</span></div>`;
      return;
    }
    const filas = (Array.isArray(g && g.secciones) ? g.secciones : [])
      .filter(s => s && (s.titulo || s.texto));
    if (!filas.length && !(g && g.intro)) {
      cont.innerHTML = `<div class="vacio"><div class="icono">📖</div>
        <span>Aún no hay explicación publicada para esta sección.</span></div>`;
      return;
    }
    cont.innerHTML = `
      <div class="glo-vista">
        <div class="tarjeta glo-card">
          <div class="glo-cab">
            <h2>${esc(g.titulo || tituloDefecto)}</h2>
            ${g.intro ? `<p>${esc(g.intro)}</p>` : ""}
          </div>
          <div class="glo-tabla-wrap">
            <table class="glo-tabla">
              <thead><tr><th>Tema</th><th>Qué significa</th></tr></thead>
              <tbody>${filas.map(s =>
                `<tr><td class="glo-k" style="white-space:normal">${esc(s.titulo || "—")}</td><td>${esc(s.texto || "")}</td></tr>`).join("")}</tbody>
            </table>
          </div>
        </div>
      </div>`;
  }

  /* Pestaña propia (texto local, en llano): tipos de evento de ríos y avisos
     del programa, que no tenían entrada en ningún glosario publicado. */
  const EVENTOS = [
    ["Desbordamiento / posible inundación", "El río se salió de su cauce o está a punto de hacerlo y el agua puede llegar a viviendas, vías o cultivos. Es el parte más grave."],
    ["Crecida", "El nivel o el caudal del río sube con fuerza, pero el agua sigue dentro del cauce. Conviene vigilar la evolución."],
    ["Estiaje", "Lo contrario de una crecida: el río lleva poca agua, por debajo de lo normal para la época. Afecta a captaciones y riego."],
    ["Monitoreo", "Seguimiento en terreno de un río, sin daño confirmado. Sirve para documentar la situación."],
    ["Aviso de caudal modelado", "Aviso automático que se genera cuando el caudal calculado por un modelo supera un umbral de crecida. No es una observación en terreno: es una estimación."],
    ["Crecida de 2, 10 o 100 años", "Forma de medir el tamaño de una crecida: una “crecida de 10 años” es un caudal que, en promedio, se alcanza una vez cada 10 años. No significa que falten 10 años para la próxima."],
    ["Advertencias del programa", "Avisos que el propio sistema muestra cuando un dato llega atrasado, incompleto o sin verificación. Indican que ese dato debe leerse con cautela, no que haya una emergencia."],
  ];

  function tablaEventos(cont) {
    cont.innerHTML = `
      <div class="glo-vista">
        <div class="tarjeta glo-card">
          <div class="glo-cab">
            <h2>Eventos de ríos y avisos</h2>
            <p>Qué significa cada tipo de parte de la Secretaría de Gestión de Riesgos y los avisos que muestra el propio sistema.</p>
          </div>
          <div class="glo-tabla-wrap">
            <table class="glo-tabla">
              <thead><tr><th>Término</th><th>Qué significa</th></tr></thead>
              <tbody>${EVENTOS.map(([k, v]) =>
                `<tr><td class="glo-k" style="white-space:normal">${esc(k)}</td><td>${esc(v)}</td></tr>`).join("")}</tbody>
            </table>
          </div>
        </div>
      </div>`;
  }

  /* --------- buscador + apertura desde otros módulos --------- */
  const CLAVE_PESTANA = "glosario.pestana";
  let _vp = null;        // controlador de pestañas mientras la vista está montada
  let _cuerpo = null;
  let _input = null;
  let _pendiente = null; // {pestana, termino} pedido por App.abrirGlosario

  const norma = s => String(s ?? "").toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "");

  function aplicarFiltro() {
    if (!_cuerpo || !_input) return;
    const q = norma(_input.value.trim());
    const items = _cuerpo.querySelectorAll(
      "tbody tr, .ml-gloss-modelo, .ml-gloss-metrica, .ml-gloss-niveles li");
    items.forEach(el => { el.hidden = !!q && !norma(el.textContent).includes(q); });
  }

  function guardarPestana(id) {
    try { sessionStorage.setItem(CLAVE_PESTANA, id); } catch (e) {}
  }
  function pestanaGuardada() {
    try { return sessionStorage.getItem(CLAVE_PESTANA) || ""; } catch (e) { return ""; }
  }

  /* Gancho público: otros módulos pueden llevar al usuario directo a una
     pestaña del Glosario, con el término ya puesto en el buscador. */
  App.abrirGlosario = (pestana, termino) => {
    _pendiente = { pestana: pestana || "", termino: termino || "" };
    if (pestana) guardarPestana(pestana);
    if (_vp) { // ya estamos en el Glosario: sin recarga
      if (pestana) _vp.pintar(pestana);
      if (_input) { _input.value = termino || ""; aplicarFiltro(); }
      _pendiente = null;
    } else {
      App.navegar("glosario");
    }
  };

  App.registrar("glosario", {
    titulo: "Glosario", orden: 5,
    async render(vista) {
      vista.dataset.screenLabel = "Glosario";
      const ids = ["modelos", "ffgs", "metricas", "hidro", "caudales", "clima", "eventos"];
      let inicial = (_pendiente && _pendiente.pestana) || pestanaGuardada();
      if (!ids.includes(inicial)) inicial = "modelos";
      // cada render guarda su pestaña y reaplica el filtro del buscador
      const con = (id, fn) => async (c) => {
        guardarPestana(id); _cuerpo = c;
        await fn(c); aplicarFiltro();
      };
      _vp = App.vistaPestanas(vista, {
        kicker: "Referencia teórica", titulo: "Glosario",
        sub: "Qué significa cada modelo, producto, métrica y variable del sistema",
        inicial,
        accionesHTML: `<input type="text" data-rol="glo-buscar" placeholder="Buscar término…"
          aria-label="Buscar término en la pestaña actual" style="min-width:190px">`,
        pestanas: [
          { id: "modelos", etiqueta: "Modelos NWP y ML",
            render: con("modelos", (c) => { const p = App.panel("glosario:modelos"); return p ? p(c) : tablaGlosario(c, "forecast"); }) },
          { id: "ffgs", etiqueta: "FFGS", render: con("ffgs", (c) => tablaGlosario(c, "ffgs")) },
          { id: "metricas", etiqueta: "Métricas de validación", render: con("metricas", (c) => tablaGlosario(c, "metricas")) },
          { id: "hidro", etiqueta: "Hidroestimadores y variables", render: con("hidro", (c) => tablaGlosario(c, "hydro")) },
          { id: "caudales", etiqueta: "Caudales y ríos",
            render: con("caudales", (c) => tablaSecciones(c, "/geoglows/glosario", "Caudales de ríos")) },
          { id: "clima", etiqueta: "Climatología",
            render: con("clima", (c) => tablaSecciones(c, "/clima/glosario", "Climatología")) },
          { id: "eventos", etiqueta: "Eventos y avisos", render: con("eventos", tablaEventos) },
        ],
      });
      _input = vista.querySelector("[data-rol=glo-buscar]");
      if (_input) {
        _input.oninput = aplicarFiltro;
        if (_pendiente && _pendiente.termino) { _input.value = _pendiente.termino; }
      }
      _pendiente = null;
    },
    alDejar() {
      _vp = null; _cuerpo = null; _input = null;
      const cab = document.getElementById("cabecera-vista"); if (cab) cab.style.display = "";
    },
  });
})();
