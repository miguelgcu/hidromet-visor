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

  const CENTRO_EC = [-1.6, -78.6];
  const ZOOM_INI = 6;
  const COLOR_ALERTA = { 0: "#2EA043", 2: "#C5B11B", 5: "#C5B11B", 10: "#E08A1E",
    25: "#D2691E", 50: "#CF362B", 100: "#7A1FA2" };
  const colorNivel = na => (na && COLOR_ALERTA[na.anios] != null) ? COLOR_ALERTA[na.anios]
    : (na && na.color) ? na.color : "#6B7785";
  const fmt = n => (n == null ? "—" : Number(n).toLocaleString("es-EC", { maximumFractionDigits: 0 }));

  let estado, epocaGlobal = 0, _onTema = null;
  function crear() {
    estado = { mapa: null, tiles: null, capaRios: null, lienzoRios: null,
               marcadores: null, items: [], selRid: null, epoca: ++epocaGlobal };
  }
  function vigente(E) { return estado === E && E.epoca >= 0; }

  function urlTiles() {
    const oscuro = (App.tema && App.tema() === "oscuro");
    return "https://{s}.basemaps.cartocdn.com/" + (oscuro ? "dark_all" : "light_all") + "/{z}/{x}/{y}{r}.png";
  }

  /* ---------------- maquetado (propio) ---------------- */
  function cuerpoHTML() {
    return `
      <div class="gg" data-screen-label="Caudales GEOGLOWS">
        <div class="gg-head">
          <div>
            <div class="gg-kicker">Hidrología · caudales modelados</div>
            <h2 class="gg-title">Caudales de ríos — GEOGLOWS</h2>
            <p class="gg-sub">Pronóstico de caudal a 15 días por tramo de río (GEOGLOWS ECMWF v2).
              Elige un <b>río de la lista</b> o pulsa cualquier punto del mapa.</p>
          </div>
          <div class="gg-actions">
            <button class="gg-btn" data-rol="glosario">📖 Guía</button>
            <button class="gg-btn primario" data-rol="actualizar">⟳ Actualizar</button>
          </div>
        </div>
        <div class="gg-cols">
          <aside class="gg-card gg-picks">
            <div class="gg-picks-tit">Ríos vigilados</div>
            <div class="gg-picks-list" data-rol="picks">
              <div class="gg-empty"><span class="spin"></span><span>Cargando ríos…</span></div>
            </div>
          </aside>
          <section class="gg-card gg-mapwrap">
            <div class="gg-map" data-rol="mapa"></div>
            <div class="gg-map-hint">Pulsa un río o un punto del mapa</div>
            <div class="gg-zoom">
              <button data-rol="zoom+" title="Acercar">+</button>
              <button data-rol="zoom-" title="Alejar">−</button>
              <button data-rol="reset" title="Vista completa">⤢</button>
            </div>
            <div class="gg-leyenda" data-rol="leyenda"></div>
          </section>
        </div>
        <section class="gg-card gg-hidro">
          <div class="gg-hidro-head"><h3 data-rol="hg-tit">Hidrograma</h3></div>
          <div class="gg-alerta" data-rol="hg-badge"></div>
          <div class="gg-plot" data-rol="hg-plot">
            <div class="gg-empty"><span>Selecciona un río en la lista o pulsa el mapa.</span></div>
          </div>
          <div class="gg-retro" data-rol="hg-retro"></div>
        </section>
      </div>`;
  }

  function leyendaHTML() {
    const it = (c, t) => `<span><i style="background:${c}"></i>${esc(t)}</span>`;
    return it(COLOR_ALERTA[0], "Normal") + it(COLOR_ALERTA[2], "RP 2–5") +
           it(COLOR_ALERTA[10], "RP 10–25") + it(COLOR_ALERTA[50], "RP 50") +
           it(COLOR_ALERTA[100], "RP 100") + it("#6B7785", "Sin dato");
  }

  /* ---------------- lista de ríos (quick-picks): "cuáles puedo escoger" ---------------- */
  function pintarPicks(items) {
    const cont = document.querySelector('[data-rol="picks"]');
    if (!cont) return;
    if (!items.length) {
      cont.innerHTML = `<div class="gg-empty"><span>Sin ríos vigilados. Pulsa ⟳ Actualizar.</span></div>`;
      return;
    }
    cont.innerHTML = items.map((it, i) => {
      const na = it.nivel_alerta;
      const et = na ? na.etiqueta : "sin pronóstico";
      const act = (estado.selRid && String(estado.selRid) === String(it.river_id)) ? " activo" : "";
      return `<button class="gg-rio${act}" data-i="${i}">
        <span class="dot" style="background:${colorNivel(na)}"></span>
        <span><span class="nom">${esc(it.nombre)}</span><span class="sub">${esc(et)}</span></span>
        <span class="pico">${fmt(it.pico)}<br><span style="font-weight:400;opacity:.65">m³/s</span></span>
      </button>`;
    }).join("");
    cont.querySelectorAll(".gg-rio").forEach(b => b.onclick = () => {
      const it = items[+b.dataset.i];
      cont.querySelectorAll(".gg-rio").forEach(x => x.classList.remove("activo"));
      b.classList.add("activo");
      if (estado.mapa && typeof it.lat === "number") estado.mapa.setView([it.lat, it.lon], 9);
      if (it.river_id) cargarHidrograma(it.river_id, it.nombre, it.lat, it.lon);
      else consultarPunto(it.lat, it.lon);
    });
  }

  /* ---------------- mapa (propio) ---------------- */
  function iniciarMapa(div) {
    const map = L.map(div, { zoomControl: false, attributionControl: false,
      minZoom: 5, maxZoom: 16, maxBoundsViscosity: 0.7 }).setView(CENTRO_EC, ZOOM_INI);
    estado.mapa = map;
    estado.tiles = L.tileLayer(urlTiles(), { subdomains: "abcd", maxZoom: 19, crossOrigin: true }).addTo(map);
    map.createPane("pRios").style.zIndex = 370;
    estado.lienzoRios = L.canvas({ padding: 0.5, pane: "pRios" });
    // Clic libre = consulta por lat/lon (on-demand, requiere backend). En el visor (sin backend)
    // solo se navegan los tramos vigilados con river_id congelado → se omite el clic libre.
    if (!window.HIDROMET_VISOR) map.on("click", (e) => consultarPunto(e.latlng.lat, e.latlng.lng));
    cargarRios();
  }

  async function cargarRios() {
    const E = estado;
    let gj;
    try { gj = await App.api("/datos/capas/hidrografia.geojson"); }
    catch (e) { return; }
    if (!vigente(E) || !estado.mapa || (gj && gj.construyendo)) return;
    const oscuro = (App.tema && App.tema() === "oscuro");
    // Ríos PROMINENTES para que se vea claro dónde hay red seleccionable.
    estado.capaRios = L.geoJSON(gj, {
      pane: "pRios", renderer: estado.lienzoRios, interactive: false,
      style: (f) => {
        const pri = String((f.properties || {}).prioridad || "").trim();
        const mayor = pri === "1" || pri === "2";
        return { color: mayor ? (oscuro ? "#5AA9E6" : "#1763B6") : (oscuro ? "#3C5A80" : "#7FA8D4"),
                 weight: mayor ? 1.6 : 0.7, opacity: mayor ? 0.95 : 0.75 };
      },
    }).addTo(estado.mapa);
  }

  function pintarMarcadores(items) {
    if (!estado.mapa) return;
    if (estado.marcadores) estado.mapa.removeLayer(estado.marcadores);
    const grupo = L.layerGroup();
    for (const it of items) {
      if (typeof it.lat !== "number" || typeof it.lon !== "number") continue;
      const m = L.circleMarker([it.lat, it.lon], {
        radius: 8, color: (App.tema && App.tema() === "oscuro") ? "#AEBBD0" : "#000000", weight: 1.5, fillColor: colorNivel(it.nivel_alerta), fillOpacity: 0.95 });
      const na = it.nivel_alerta ? it.nivel_alerta.etiqueta : "sin pronóstico (pulsa Actualizar)";
      m.bindTooltip(`<b>${esc(it.nombre)}</b><br>${esc(na)}`, { direction: "top", sticky: true });
      m.on("click", (e) => { L.DomEvent.stopPropagation(e);
        if (it.river_id) cargarHidrograma(it.river_id, it.nombre, it.lat, it.lon);
        else if (!window.HIDROMET_VISOR) consultarPunto(it.lat, it.lon); });
      grupo.addLayer(m);
    }
    grupo.addTo(estado.mapa);
    estado.marcadores = grupo;
  }

  /* ---------------- hidrograma ---------------- */
  async function consultarPunto(lat, lon) {
    document.querySelectorAll('.gg-rio').forEach(x => x.classList.remove("activo"));
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
    const q = riverId ? ("river_id=" + encodeURIComponent(riverId)) : (`lat=${lat}&lon=${lon}`);
    let r;
    try { r = await App.api("/geoglows/hidrograma?" + q); }
    catch (e) { if (plot) plot.innerHTML = `<div class="gg-empty"><span>${esc(e.message)}</span></div>`; return; }
    if (!vigente(E)) return;
    if (r.error) { if (plot) plot.innerHTML = `<div class="gg-empty"><span>${esc(r.error)}</span></div>`; return; }
    estado.selRid = r.river_id;
    if (tit) tit.textContent = `Hidrograma — ${nombre || ("tramo " + r.river_id)}`;
    pintarHidrograma(plot, r);
    pintarBadge(badge, r);
    if (retro) retro.innerHTML = `<button class="gg-btn mini" data-rol="ver-retro">📈 Ver contexto histórico (1940→)</button>`;
    const vr = document.querySelector('[data-rol="ver-retro"]');
    if (vr) vr.onclick = () => cargarRetro(r.river_id);
  }

  function pintarBadge(cont, r) {
    if (!cont) return;
    const na = r.nivel_alerta || {};
    cont.innerHTML = `
      <span class="gg-chip" style="--c:${colorNivel(na)}">${esc(na.etiqueta || "—")}</span>
      ${r.pico != null ? `<span class="gg-sub">Pico previsto: <b>${r.pico.toLocaleString("es-EC")}</b> ${esc(r.unidad || "m³/s")}</span>` : ""}
      ${r.aviso ? `<span class="gg-sub" style="color:var(--warn,#C5781B)">${esc(r.aviso)}</span>` : ""}`;
  }

  function pintarHidrograma(el, r) {
    if (!el) return;
    el.innerHTML = "";
    const osc = (App.tema && App.tema() === "oscuro");
    const f = r.forecast || {};
    const x = f.tiempo || [];
    const linea = (y, nombre, color, dash, width) => ({
      x, y, name: nombre, type: "scatter", mode: "lines", connectgaps: true,
      line: { color, width: width || 2, dash: dash || "solid" },
      hovertemplate: `${nombre}: %{y:.1f} m³/s<extra></extra>` });
    const banda = (ylo, yhi, color, nombre) => ([
      { x, y: yhi, type: "scatter", mode: "lines", line: { width: 0 }, name: nombre,
        connectgaps: true, showlegend: false, hoverinfo: "skip" },
      { x, y: ylo, type: "scatter", mode: "lines", line: { width: 0 }, name: nombre,
        connectgaps: true, fill: "tonexty", fillcolor: color, hoverinfo: "skip", showlegend: true },
    ]);
    const traces = [];
    if (f.min && f.max) traces.push(...banda(f.min, f.max, osc ? "rgba(93,169,230,0.18)" : "rgba(23,99,182,0.12)", "Rango mín–máx"));
    if (f.p25 && f.p75) traces.push(...banda(f.p25, f.p75, osc ? "rgba(93,169,230,0.34)" : "rgba(23,99,182,0.28)", "Rango 25–75 %"));
    if (f.med) traces.push(linea(f.med, "Mediana", osc ? "#5AA9E6" : "#1763B6", "solid", 2.4));
    if (f.high_res) traces.push(linea(f.high_res, "Alta resolución", osc ? "#2FC2D4" : "#0E94A4", "dot", 1.6));
    for (const rp of (r.retornos || [])) {
      traces.push({ x: [x[0], x[x.length - 1]], y: [rp.caudal, rp.caudal], type: "scatter",
        mode: "lines", name: `RP ${rp.anios} a`, line: { color: rp.color, width: 1.2, dash: "dash" },
        hovertemplate: `RP ${rp.anios} años: ${rp.caudal.toLocaleString("es-EC")} m³/s<extra></extra>` });
    }
    const layout = App.plotlyLayoutSerie("", {
      height: 340, showlegend: true,
      legend: { orientation: "h", y: -0.18, font: { size: 10 } },
      margin: { l: 54, r: 12, t: 8, b: 28 },
      yaxis: { title: "Caudal (m³/s)", rangemode: "tozero" }, xaxis: { type: "date" },
    });
    Plotly.newPlot(el, traces, layout, App.plotlyConfig());
  }

  async function cargarRetro(riverId) {
    const cont = document.querySelector('[data-rol="hg-retro"]');
    if (cont) cont.innerHTML = `<div class="gg-sub"><span class="spin"></span> Bajando retrospectiva (1940→), una sola vez…</div>`;
    let r;
    try { r = await App.api("/geoglows/retro?river_id=" + encodeURIComponent(riverId)); }
    catch (e) { if (cont) cont.innerHTML = `<div class="gg-sub">${esc(e.message)}</div>`; return; }
    if (r.error) { if (cont) cont.innerHTML = `<div class="gg-sub">${esc(r.error)}</div>`; return; }
    const MES = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];
    cont.innerHTML = `<div class="gg-hidro-head" style="margin-top:6px"><h3 style="font-size:.95rem">Caudal medio mensual histórico</h3></div>
      <div class="gg-plot" data-rol="retro-plot" style="min-height:200px;height:200px"></div>`;
    const el = document.querySelector('[data-rol="retro-plot"]');
    const trace = { x: MES, y: r.promedio_mensual || [], type: "bar",
      marker: { color: (App.tema && App.tema() === "oscuro") ? "#5AA9E6" : "#1763B6" }, hovertemplate: "%{x}: %{y:.0f} m³/s<extra></extra>" };
    const layout = App.plotlyLayoutSerie("", { height: 200, showlegend: false,
      margin: { l: 50, r: 10, t: 6, b: 24 }, yaxis: { title: "m³/s", rangemode: "tozero" } });
    Plotly.newPlot(el, [trace], layout, App.plotlyConfig());
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
    App.aviso(`<div style="max-width:62ch"><b>${esc(g.titulo)}</b><div class="gg-sub" style="margin:6px 0">${esc(g.intro)}</div>${secs}</div>`, "info", 16000);
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
    cont.querySelector('[data-rol="reset"]').onclick = () => estado.mapa && estado.mapa.setView(CENTRO_EC, ZOOM_INI);
    iniciarMapa(cont.querySelector('[data-rol="mapa"]'));

    if (_onTema) document.removeEventListener("temacambiado", _onTema);
    _onTema = () => {
      if (!estado) return;
      const oscuro = (App.tema && App.tema() === "oscuro");
      if (estado.tiles) estado.tiles.setUrl(urlTiles());
      if (estado.capaRios) estado.capaRios.setStyle(f => {
        const pri = String((f.properties || {}).prioridad || "").trim();
        const mayor = pri === "1" || pri === "2";
        return { color: mayor ? (oscuro ? "#5AA9E6" : "#1763B6") : (oscuro ? "#3C5A80" : "#7FA8D4") };
      });
      pintarMarcadores(estado.items || []);
    };
    document.addEventListener("temacambiado", _onTema);

    let w;
    try { w = await App.api("/geoglows/watchlist"); }
    catch (e) { App.aviso("GEOGLOWS: " + e.message, "error"); return; }
    if (!vigente(estado)) return;
    if (w && w.disponible === false) App.aviso(w.error || "GEOGLOWS no disponible.", "error", 8000);
    estado.items = (w && w.items) || [];
    pintarPicks(estado.items);
    pintarMarcadores(estado.items);
  }

  function limpiar() {
    if (_onTema) { document.removeEventListener("temacambiado", _onTema); _onTema = null; }
    if (estado) estado.epoca = -1;
    if (estado && estado.mapa) { try { estado.mapa.remove(); } catch (e) {} estado.mapa = null; }
  }

  App.panel("geoglows", render);
  App.panel("geoglows:purgar", limpiar);
})();
