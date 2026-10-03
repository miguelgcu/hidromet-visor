/* ============================================================
   Deslizamientos — pestaña de Advertencias con el peligro LHASA 2.1 (NASA) de
   hoy y de mañana y la susceptibilidad del terreno. Los datos los calcula el
   motor de Monitoreo (hidromet/monitoreo/deslizamientos.py) y viajan en su
   índice: /monitoreo/calculados, grupo «deslizamientos».

   Mapa: el fondo del lienzo es el color de la tierra; encima, la imagen del
   peligro (transparente donde el modelo no aplica); encima, una máscara con el
   color del mar fuera de Ecuador y los contornos. Al pasar por una provincia se
   leen sus cifras.
   ============================================================ */
"use strict";

(() => {
  const esc = v => String(v ?? "").replace(/[&<>"']/g,
    c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const num = (v, d = 0) => App.fmtNum(v, d);
  const oscuro = () => (App.tema ? App.tema() === "oscuro" : true);
  const E = { capa: "lhasa_hoy", indice: null, geo: null, _alTema: null };
  document.addEventListener("temacambiado", () => { if (E._alTema) try { E._alTema(); } catch (e) { /* cerrada */ } });

  const CAPAS = [
    { id: "lhasa_hoy", et: "Hoy" },
    { id: "lhasa_manana", et: "Mañana" },
    { id: "lhasa_susceptibilidad", et: "Susceptibilidad" },
  ];
  const CAJA = [-81.25, -75.05, -5.15, 1.65];

  function urlArchivo(nombre, version) {
    const base = window.HIDROMET_VISOR ? "productos/monitoreo/archivo/" : "/api/monitoreo/archivo/";
    return base + nombre + (version ? `?v=${encodeURIComponent(version)}` : "");
  }
  const hora = iso => {
    const d = new Date(iso);
    return isNaN(d) ? "" : d.toLocaleString((App.locale ? App.locale() : "es-EC"), { timeZone: "America/Guayaquil", weekday: "short",
      day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });
  };
  function hace(iso) {
    const h = (Date.now() - new Date(iso).getTime()) / 3.6e6;
    if (!isFinite(h)) return "";
    return h < 1 ? "hace menos de 1 hora" : h < 48 ? `hace ${Math.round(h)} h` : `hace ${Math.round(h / 24)} días`;
  }

  function anillos(g) {
    const out = [];
    for (const f of ((g && g.features) || [])) {
      const geom = f && f.geometry; if (!geom) continue;
      const polys = geom.type === "Polygon" ? [geom.coordinates] : geom.type === "MultiPolygon" ? geom.coordinates : [];
      const xs = [], ys = [];
      for (const poly of polys) for (const ring of poly) {
        for (const [x, y] of ring) { xs.push(x); ys.push(y); }
        xs.push(null); ys.push(null);
      }
      out.push({ nombre: (f.properties && (f.properties.nombre || f.properties.Nombre)) || "", xs, ys });
    }
    return out;
  }
  const norm = s => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/^sta\.? /, "santa ").replace(/^sto\.? dmngo|^santo domingo.*/, "santo domingo").replace(/^morona.*/, "morona")
    .replace(/^zamora.*/, "zamora").trim();

  async function pintarMapa(host, p, version) {
    if (!window.Plotly || !host) return;
    const g = E.geo;
    const piezas = anillos(g);
    const css = getComputedStyle(document.documentElement);
    const mar = css.getPropertyValue("--sea-bottom").trim() || (oscuro() ? "#0C1526" : "#EEF3F8");
    const tierra = oscuro() ? "#1A2438" : "#E3E8EF";
    const todos = { xs: [], ys: [] };
    piezas.forEach(a => { todos.xs.push(...a.xs); todos.ys.push(...a.ys); });
    const [x0, x1, y0, y1] = CAJA;
    const trazas = [{ type: "scatter", mode: "lines", x: [x0, x1, x1, x0, x0, null, ...todos.xs],
      y: [y0, y0, y1, y1, y0, null, ...todos.ys], fill: "toself", fillcolor: mar, line: { width: 0 },
      hoverinfo: "skip", showlegend: false }];
    // provincias: relleno invisible para leer sus cifras al pasar el cursor
    const porNombre = new Map((p.provincias || []).map(f => [norm(f.nombre), f]));
    const esSusc = p.id === "lhasa_susceptibilidad";
    for (const a of piezas) {
      const f = porNombre.get(norm(a.nombre));
      const texto = esSusc ? `<b>${esc(a.nombre)}</b>`
        : f ? `<b>${esc(f.nombre)}</b><br>Peligro alto: ${num(f.pct_alto, 0)} % de su zona de montaña (${num(f.km2_alto)} km²)` +
              `<br>Moderado o más: ${num(f.pct_moderado, 0)} % · máximo ${num(f.maximo, 2)}`
            : `<b>${esc(a.nombre)}</b><br>Sin zonas donde aplique el modelo`;
      trazas.push({ type: "scatter", mode: "lines", x: a.xs, y: a.ys, fill: "toself", fillcolor: "rgba(0,0,0,0)",
        line: { width: 0 }, hoveron: "fills", text: texto, hovertemplate: "%{text}<extra></extra>", showlegend: false });
    }
    trazas.push(...(App.trazasContornoProvincias ? App.trazasContornoProvincias(g) : []));
    const [o, s, e, n] = p.limites;
    const layout = App.plotlyLayoutBase({
      margin: { l: 0, r: 0, t: 0, b: 0 }, hovermode: "closest", dragmode: "pan", plot_bgcolor: tierra,
      xaxis: { visible: false, range: [x0, x1] },
      yaxis: { visible: false, range: [y0, y1], scaleanchor: "x", scaleratio: 1 },
      images: [{ source: urlArchivo(p.archivo, version), xref: "x", yref: "y", x: o, y: n, sizex: e - o, sizey: n - s,
        sizing: "stretch", xanchor: "left", yanchor: "top", layer: "below", opacity: 1 }],
    });
    await Plotly.react(host, trazas, layout, App.plotlyConfig({ displayModeBar: false, scrollZoom: false }));
  }

  function leyendaHTML(p) {
    const tr = p.tramos || [];
    if (p.id === "lhasa_susceptibilidad") {
      const cl = p.clases || [];
      return `<div class="dz-ley">${tr.map((t, i) => `<span><i style="background:${t[2]}"></i>${esc(cl[i] || "")}</span>`).join("")}</div>`;
    }
    const nombres = ["Moderado", "Moderado", "Alto", "Alto", "Muy alto"];
    return `<div class="dz-ley">${tr.map((t, i) => `<span><i style="background:${t[2]}"></i>${esc(nombres[i] || "")} · ${num(t[0], 1)}–${t[1] >= 1 ? "1" : num(t[1], 1)}</span>`).join("")}
      <span class="dz-ley-sin"><i></i>Sin dato: llanura o pendiente suave</span></div>`;
  }

  function rankingHTML(p) {
    const filas = (p.provincias || []).filter(f => f.km2_con_dato >= 50).slice(0, 14);
    if (!filas.length) return `<p class="dz-nota">Sin resumen por provincia.</p>`;
    return `<div class="dz-rank">${filas.map(f => {
      const mm = Math.max(0, f.pct_muy_alto || 0), al = Math.max(0, (f.pct_alto || 0) - mm),
            mo = Math.max(0, (f.pct_moderado || 0) - (f.pct_alto || 0));
      return `<div class="dz-fila"><div class="dz-n"><b>${esc(f.nombre)}</b><small>${num(f.km2_con_dato)} km² de montaña</small></div>
        <div class="dz-barra" title="Muy alto ${num(f.pct_muy_alto, 0)} % · alto ${num(f.pct_alto, 0)} % · moderado o más ${num(f.pct_moderado, 0)} %">
          <i style="width:${mm}%;background:#7f1d4f"></i><i style="width:${al}%;background:#dc2626"></i><i style="width:${mo}%;background:#fbbf24"></i></div>
        <div class="dz-v">${num(f.pct_alto, 0)} %</div></div>`;
    }).join("")}</div>
    <p class="dz-nota">Porcentaje de la zona de montaña de cada provincia en peligro alto (≥ 0,5). La barra suma, de oscuro a claro,
    muy alto, alto y moderado.</p>`;
  }

  function kpisHTML(prods) {
    const hoy = prods.lhasa_hoy, man = prods.lhasa_manana;
    const t = (cls, et, v, sub, texto) => `<div class="hm-kpi ${cls}"><span class="hm-kpi-et">${esc(et)}</span>` +
      `<span class="hm-kpi-v${texto ? " txt" : ""}">${v}</span><span class="hm-kpi-s">${esc(sub || "")}</span></div>`;
    const tono = x => (x == null ? "" : x >= 15 ? "peligro" : x >= 5 ? "aviso" : "ok");
    const km2 = p => (p && p.provincias || []).reduce((a, f) => a + (f.km2_alto || 0), 0);
    const top = p => (p && p.provincias && p.provincias[0]) || null;
    return `<div class="hm-kpis">
      ${t(tono(hoy && hoy.pct_alto), "Peligro alto · hoy", hoy && hoy.pct_alto != null ? `${num(hoy.pct_alto, 0)}<small>% de la montaña</small>` : "—", hoy ? `${num(km2(hoy))} km²` : "sin dato")}
      ${t(tono(man && man.pct_alto), "Peligro alto · mañana", man && man.pct_alto != null ? `${num(man.pct_alto, 0)}<small>% de la montaña</small>` : "—", man ? `${num(km2(man))} km²` : "sin dato")}
      ${t(hoy && top(hoy) && top(hoy).pct_alto >= 30 ? "peligro" : "", "Más expuesta hoy", top(hoy) ? esc(top(hoy).nombre) : "—", top(hoy) ? `${num(top(hoy).pct_alto, 0)} % de su montaña en peligro alto` : "", true)}
      ${t(man && top(man) && top(man).pct_alto >= 30 ? "peligro" : "", "Más expuesta mañana", top(man) ? esc(top(man).nombre) : "—", top(man) ? `${num(top(man).pct_alto, 0)} % de su montaña en peligro alto` : "", true)}
    </div>`;
  }

  async function panel(c) {
    E._alTema = null;
    let ind;
    try { ind = await App.api("/monitoreo/calculados"); } catch (e) { ind = null; }
    const prods = {};
    for (const p of ((ind && ind.productos) || [])) if (p.grupo === "deslizamientos") prods[p.id] = p;
    if (!Object.keys(prods).length) {
      c.innerHTML = `<div class="vacio"><div class="icono" aria-hidden="true">◌</div><strong>Todavía no hay peligro de deslizamientos publicado.</strong>
        <span>Se calcula en cada actualización con los datos de la NASA (LHASA).</span></div>`;
      return;
    }
    if (!prods[E.capa]) E.capa = Object.keys(prods)[0];
    E.geo = E.geo || (App.geoProvincias ? await App.geoProvincias() : false);
    const version = (ind && ind.generado_utc) || "";
    c.innerHTML = `<div class="dz">
      <div data-rol="kpis">${kpisHTML(prods)}</div>
      <div class="hm-controles">
        <div class="campo-inline"><span class="dz-et">Capa</span>
          <div class="segmentado" data-rol="capa">${CAPAS.filter(x => prods[x.id]).map(x => `<button type="button" data-capa="${x.id}">${esc(x.et)}</button>`).join("")}</div></div>
        <span class="empuje dz-fecha" data-rol="fecha"></span>
      </div>
      <div class="dz-grid">
        <section class="dz-card"><header class="dz-cab"><h2 data-rol="tit"></h2><span data-rol="sub"></span></header>
          <div class="dz-mapa" data-rol="mapa"></div><div data-rol="ley"></div>
          <p class="dz-fuente">NASA LHASA 2.1 · probabilidad relativa a ~1 km · producto experimental: es una referencia, no un aviso oficial.
          Cita: Stanley et al. (2021).</p></section>
        <section class="dz-card"><header class="dz-cab"><h2>Por provincia</h2><span>zona de montaña en peligro alto</span></header>
          <div data-rol="rank"></div></section>
      </div>
      <section class="dz-card dz-que"><h2>Cómo leerlo</h2>
        <p>El modelo de la NASA cruza la lluvia de los últimos días (satélite GPM) y la pronosticada con la susceptibilidad del terreno:
        pendiente, geología, cobertura, fallas y vías. Solo opina donde la pendiente pasa de 10°: en la llanura costera y en la Amazonía
        baja no hay dato, lo que no quiere decir que no haya peligro de inundación. Para decidir, crúcelo con las advertencias de lluvia y
        con lo que se sabe en el terreno.</p></section>
    </div>`;
    const $ = s => c.querySelector(s);
    const dibujar = async () => {
      const p = prods[E.capa];
      c.querySelectorAll('[data-rol="capa"] button').forEach(b => b.classList.toggle("activo", b.dataset.capa === E.capa));
      $('[data-rol="tit"]').textContent = p.nombre;
      $('[data-rol="sub"]').textContent = p.id === "lhasa_susceptibilidad" ? "no cambia con la lluvia" : (p.que || "");
      $('[data-rol="fecha"]').textContent = p.id === "lhasa_susceptibilidad" ? "Mapa de 2017"
        : `Dato de la NASA: ${hora(p.instante_utc)} · ${hace(p.instante_utc)}`;
      $('[data-rol="ley"]').innerHTML = leyendaHTML(p);
      $('[data-rol="rank"]').innerHTML = p.id === "lhasa_susceptibilidad"
        ? `<p class="dz-nota">La susceptibilidad es fija; el ranking se calcula sobre el peligro de hoy o de mañana.</p>${rankingHTML(prods.lhasa_hoy || {})}`
        : rankingHTML(p);
      await pintarMapa($('[data-rol="mapa"]'), p, version);
    };
    c.querySelectorAll('[data-rol="capa"] button').forEach(b => { b.onclick = () => { E.capa = b.dataset.capa; dibujar(); }; });
    E._alTema = () => { if (c.isConnected) dibujar(); };
    await dibujar();
  }

  if (typeof App === "object" && App && App.panel) {
    App.panel("deslizamientos", panel);
    App.panel("deslizamientos:purgar", () => {
      E._alTema = null;
      if (!window.Plotly) return;
      document.querySelectorAll("#vista .dz-mapa.js-plotly-plot").forEach(el => { try { Plotly.purge(el); } catch (e) { /* ya */ } });
    });
  }
})();
