/* ============================================================
   HidroMet — Glosario. Referencia TEÓRICA: una pestaña por tipo de glosario.
   Reutiliza el glosario de modelos (App.panel "glosario:modelos", de mlnwp) y
   sirve el resto desde /cartas/glosario?familia=ffgs|metricas|hydro.

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

  App.registrar("glosario", {
    titulo: "Glosario", orden: 5,
    async render(vista) {
      vista.dataset.screenLabel = "Glosario";
      App.vistaPestanas(vista, {
        kicker: "Referencia teórica", titulo: "Glosario",
        sub: "Qué significa cada modelo, producto, métrica y variable del sistema",
        inicial: "modelos",
        pestanas: [
          { id: "modelos", etiqueta: "Modelos NWP y ML",
            render: (c) => { const p = App.panel("glosario:modelos"); return p ? p(c) : tablaGlosario(c, "forecast"); } },
          { id: "ffgs", etiqueta: "FFGS", render: (c) => tablaGlosario(c, "ffgs") },
          { id: "metricas", etiqueta: "Métricas de validación", render: (c) => tablaGlosario(c, "metricas") },
          { id: "hidro", etiqueta: "Hidroestimadores y variables", render: (c) => tablaGlosario(c, "hydro") },
        ],
      });
    },
    alDejar() { const cab = document.getElementById("cabecera-vista"); if (cab) cab.style.display = ""; },
  });
})();
