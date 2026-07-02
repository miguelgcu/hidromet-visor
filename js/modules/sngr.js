/* ============================================================
   HidroMet · Eventos de Ríos (SNGR) — módulo del frontend.
   Reconstruido FIEL a Diseño/HANDOFF/diseno/HidroMet.dc.html
   (data-screen-label="Eventos de Ríos"). Acento: cian (--cyan).

   Arquitectura intacta: App.registrar / App.api / App.tarea / App.aviso.
   Mapa explorable con LEAFLET + MarkerCluster (globales: L, L.markerClusterGroup).
   Capa base real de /datos/capas/<nivel>.geojson; toggle de ríos con
   /datos/capas/hidrografia.geojson. Eventos y conteos de /sngr/eventos;
   cascada de filtros de /sngr/filtros (campos verificados en
   app/modulos/sngr/datos.py y app/rutas/sngr.py).
   ============================================================ */
"use strict";

(() => {
  const esc = v => String(v ?? "").replace(/[&<>"']/g,
    c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  /* ---- Tipos de evento: valores REALES de classify_event (pipeline.py) ----
     Mapeo a color/etiqueta/badge según el diseño (5 tarjetas de conteo). */
  const TIPOS = [
    { clave: "Monitoreo normal",                   etq: "Monitoreo",      badge: "Monitoreo", color: "var(--blue)",   bg: "var(--blue-50)"   },
    { clave: "Desbordamiento / posible inundacion", etq: "Desbordamiento", badge: "Desbord.",  color: "var(--danger)", bg: "var(--danger-bg)" },
    { clave: "Crecida / aumento de caudal",         etq: "Crecida",        badge: "Crecida",   color: "var(--warn)",   bg: "var(--warn-bg)"   },
    { clave: "Estiaje / bajo caudal",               etq: "Estiaje",        badge: "Estiaje",   color: "var(--warn)",   bg: "var(--warn-bg)"   },
    { clave: "Alerta GEOGLOWS",                     etq: "GEOGLOWS",       badge: "GEOGLOWS",  color: "var(--ml-purple)", bg: "var(--ml-purple-bg)" },
  ];
  const PORCLAVE = Object.fromEntries(TIPOS.map(t => [t.clave, t]));
  // Color absoluto (no token CSS) para Leaflet/canvas, por clave de tipo.
  const COLOR_HEX = {
    "Monitoreo normal": "#2C68DE",
    "Desbordamiento / posible inundacion": "#CF362B",
    "Crecida / aumento de caudal": "#C5781B",
    "Estiaje / bajo caudal": "#C99A2E",
    "Alerta GEOGLOWS": "#6A47CE",
  };
  const colorDe = clave => COLOR_HEX[clave] || "#0E94A4";
  const badgeDe = clave => PORCLAVE[clave] || { badge: clave || "—", color: "var(--muted)", bg: "var(--surface-3)" };

  // Capas seleccionables del mapa temático: límites administrativos
  // (provincias/cantones/parroquias) y cuencas hidrográficas Pfafstetter N1–N4.
  const CAPAS = [
    { id: "provincias", etq: "Provincias", nivel: "provincias", tipo: "admin"  },
    { id: "cantones",   etq: "Cantones",   nivel: "cantones",   tipo: "admin"  },
    { id: "parroquias", etq: "Parroquias", nivel: "parroquias", tipo: "admin"  },
    { id: "cuencas1",   etq: "Cuencas · nivel 1", nivel: "cuencas1", tipo: "cuenca" },
    { id: "cuencas2",   etq: "Cuencas · nivel 2", nivel: "cuencas2", tipo: "cuenca" },
    { id: "cuencas3",   etq: "Cuencas · nivel 3", nivel: "cuencas3", tipo: "cuenca" },
    { id: "cuencas4",   etq: "Cuencas · nivel 4", nivel: "cuencas4", tipo: "cuenca" },
  ];

  // Colores del mapa temático (claro/oscuro). El fondo de mar lo da el CSS.
  function paletaMapa() {
    const oscuro = (App.tema && App.tema() === "oscuro");
    return {
      tierra:      oscuro ? "#16223B" : "#EAF0EA",   // relleno del continente (mapa base)
      tierraBorde: oscuro ? "#2C3A57" : "#C2CEBE",
      adminBorde:  oscuro ? "#5E7390" : "#5A6E86",
      rioMayor:    oscuro ? "#5AA9E6" : "#2B6FB0",
      rioMenor:    oscuro ? "#37557A" : "#A9C7E2",
    };
  }
  // Paleta categórica suave para las cuencas (se cicla por índice de polígono).
  const PALETA_CUENCA = ["#A8D5BA", "#F4C7AB", "#B5C7E8", "#E8C7DD", "#C9E4CA",
    "#F0D9A8", "#BFD8D8", "#D8C2E0", "#F2B5A0", "#AEC9E3", "#CFE0A8", "#E7C3C3"];
  const colorCuenca = i => PALETA_CUENCA[((i % PALETA_CUENCA.length) + PALETA_CUENCA.length) % PALETA_CUENCA.length];

  // Vista inicial de Ecuador continental.
  const CENTRO_EC = [-1.6, -78.6];
  const ZOOM_INI = 6;

  /* ---------------- estado del módulo ---------------- */
  let estado;            // ver crear()
  let epocaGlobal = 0;   // identidad de montaje (anti-aliasing entre renders)
  let _onTemaEventos = null;   // listener de tema del panel Eventos (vive bajo Hidrología)
  function crear() {
    estado = {
      filtros: null,        // respuesta de /sngr/filtros
      sel: { tipo: "", provincia: "", canton: "", parroquia: "", desde: "", hasta: "" },
      mapa: null,           // L.map
      capaTiles: null,      // L.tileLayer OSM/CARTO (base, theme-aware)
      boundsEC: null,       // límites del país (para reset/maxBounds)
      capaBase: null,       // L.geoJSON de la capa temática seleccionada
      capaBaseCasing: null, // casing blanco bajo el borde admin (encasillado)
      capaRios: null,       // L.geoJSON hidrografía (red completa rio_l)
      lienzoRios: null,     // L.canvas() para los ~4700 ríos (rendimiento)
      cluster: null,        // L.markerClusterGroup
      capaActual: "provincias",
      rios: true,           // los ríos vienen activos: el mapa NO debe verse en blanco
      cacheCapas: {},       // nivel -> geojson
      pidiendo: 0,          // token de carrera para recargas de eventos
      pidiendoCascada: 0,   // token de carrera independiente para la cascada
      epoca: ++epocaGlobal, // sello del montaje; alDejar lo invalida a -1
    };
  }
  // ¿La respuesta async pertenece todavía al montaje vigente? Tras navegar
  // (alDejar pone epoca=-1) o remontar (estado pasa a ser otro objeto), las
  // respuestas en vuelo del montaje anterior NO deben tocar el estado/DOM nuevos.
  function vigente(E) { return estado === E && E.epoca >= 0; }

  /* ---------------- cabecera ---------------- */
  function cabeceraHTML() {
    return `
      <div class="sngr-cabecera">
        <div>
          <div class="kicker">Módulos · gestión de riesgos</div>
          <h1>Eventos de Ríos</h1>
          <div class="sub">Catálogo histórico georreferenciado · API SITREP-SNGR</div>
        </div>
        <div class="sngr-acciones">
          <button class="boton" data-rol="exportar">⤓ Exportar ZIP</button>
          <button class="boton oscuro" data-rol="actualizar">⟳ Actualizar</button>
        </div>
      </div>`;
  }

  /* ---------------- conteos (pills compactas, clicables y dinámicas por filtro) ----
     Reemplazan a las 5 tarjetas grandes: una fila slim que ADEMÁS filtra al hacer clic.
     Como el backend ya devuelve los conteos del filtro vigente, al elegir un tipo solo
     esa pill queda con valor y el resto en 0. */
  function conteosHTML() {
    const sel = estado.sel.tipo || "";
    const pill = (clave, etq, color) =>
      `<button class="sngr-pill${clave === sel ? " activa" : ""}" data-rol="pill" data-tipo="${esc(clave)}">
        ${color ? `<span class="punto" style="background:${color}"></span>` : `<span class="punto todos"></span>`}
        <span class="et">${esc(etq)}</span><span class="num" data-rol="num">—</span>
      </button>`;
    return `<div class="sngr-pills" data-rol="conteos">
      ${pill("", "Todos", "")}${TIPOS.map(t => pill(t.clave, t.etq, t.color)).join("")}
    </div>`;
  }
  function pintarConteos(conteos) {
    const fmt = n => Number(n || 0).toLocaleString("es-EC");
    const total = Object.values(conteos || {}).reduce((a, b) => a + (Number(b) || 0), 0);
    const sel = estado.sel.tipo || "";
    document.querySelectorAll('.sngr-pill[data-rol="pill"]').forEach(c => {
      const tipo = c.dataset.tipo || "";
      const num = c.querySelector('[data-rol="num"]');
      if (num) num.textContent = fmt(tipo ? (conteos[tipo] || 0) : total);
      c.classList.toggle("activa", tipo === sel);
    });
  }
  function conectarConteos() {
    document.querySelectorAll('.sngr-pill[data-rol="pill"]').forEach(c =>
      c.onclick = () => {
        estado.sel.tipo = c.dataset.tipo || "";
        const drop = document.querySelector('.sngr-filtros [data-rol="tipo"]');
        if (drop) drop.value = estado.sel.tipo;     // mantener el desplegable en sincronía
        recargarEventos();
      });
  }

  /* ---------------- filtros en cascada ---------------- */
  function selectHTML(rol, titulo, todos, opciones, valor, deshab) {
    const ops = [`<option value="">${esc(todos)}</option>`]
      .concat((opciones || []).map(o =>
        `<option value="${esc(o)}"${o === valor ? " selected" : ""}>${esc(o)}</option>`)).join("");
    return `<label><div class="tit">${esc(titulo)}</div>
      <select data-rol="${rol}"${deshab ? " disabled" : ""}>${ops}</select></label>`;
  }
  function filtrosHTML(f) {
    const s = estado.sel;
    const desde = s.desde || f.fecha_min || "";
    const hasta = s.hasta || f.fecha_max || "";
    // v11: acciones DENTRO de la fila de filtros (una sola fila compacta). Deben vivir
    // aquí y ligarse en conectarFiltros(): recargarCascada() regenera este wrapper por
    // outerHTML en cada cambio de provincia/cantón y borraría botones externos.
    return `
      <div class="sngr-filtros compacta">
        ${selectHTML("tipo", "Tipo", "Todos", f.tipos, s.tipo, false)}
        ${selectHTML("provincia", "Provincia", "Todas", f.provincias, s.provincia, false)}
        ${selectHTML("canton", "Cantón", "Todos", f.cantones, s.canton, !s.provincia)}
        ${selectHTML("parroquia", "Parroquia", "Todas", f.parroquias, s.parroquia, !s.canton)}
        <label><div class="tit">Desde</div>
          <input type="date" data-rol="desde" value="${esc(desde)}"></label>
        <label><div class="tit">Hasta</div>
          <input type="date" data-rol="hasta" value="${esc(hasta)}"></label>
        <span class="empuje"></span>
        <button class="boton chico" data-rol="exportar">⤓ Exportar ZIP</button>
        <button class="boton oscuro chico" data-rol="actualizar">⟳ Actualizar</button>
      </div>`;
  }

  /* ---------------- mapa + tabla ---------------- */
  function mapaTablaHTML() {
    const opts = CAPAS.map(c =>
      `<option value="${c.id}" ${c.id === estado.capaActual ? "selected" : ""}>${esc(c.etq)}</option>`).join("");
    return `
      <div class="sngr-grid">
        <div class="sngr-mapa-tarjeta">
          <div class="sngr-mapa-cab">
            <strong>Mapa temático de eventos</strong>
            <div class="sngr-mapa-controles">
              <label class="sngr-capa-sel"><span class="micro">Capa base</span>
                <select data-rol="capa">${opts}</select></label>
              <button class="sngr-rios activo" data-rol="rios" title="Mostrar/ocultar la red de ríos">≈ Ríos</button>
              <div class="sngr-zoom">
                <button class="zb mas" data-rol="zoom+" title="Acercar">+</button>
                <button class="zb menos" data-rol="zoom-" title="Alejar">−</button>
                <button class="zb reset" data-rol="reset" title="Vista completa">⤢</button>
              </div>
            </div>
          </div>
          <div class="sngr-mapa" data-rol="mapa">
            <div class="sello arriba" data-rol="sello-capa">EVENTOS</div>
            <div class="sello abajo" data-rol="sello-abajo">Arrastra · rueda para acercar</div>
            <div class="sngr-leyenda-mapa" data-rol="leyenda-rios">
              <span><i class="rio-may"></i>Ríos principales</span>
              <span><i class="rio-men"></i>Secundarios</span>
            </div>
          </div>
        </div>
        <div class="sngr-tabla-tarjeta">
          <div class="tit">Eventos recientes</div>
          <div class="sngr-tabla-scroll">
            <table class="sngr-tabla">
              <thead><tr><th>Fecha</th><th>Tipo</th><th>Lugar</th></tr></thead>
              <tbody data-rol="tbody">
                <tr><td colspan="3" style="padding:14px 6px;color:var(--muted)">Cargando…</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>`;
  }

  // dd/mm a partir de YYYY-MM-DD
  function fechaCorta(iso) {
    if (!iso || iso.length < 10) return "—";
    return iso.slice(8, 10) + "/" + iso.slice(5, 7);
  }
  function lugarDe(p) {
    const partes = [p.canton, p.provincia].map(x => (x || "").trim()).filter(Boolean);
    return partes.length ? partes.join(" · ") : (p.parroquia || p.sector || "—");
  }
  function pintarTabla(eventos) {
    const tbody = document.querySelector('[data-rol="tbody"]');
    if (!tbody) return;
    if (!eventos.length) {
      tbody.innerHTML = `<tr><td colspan="3" style="padding:18px 6px;color:var(--muted)">Sin eventos para el filtro.</td></tr>`;
      return;
    }
    // Recientes primero (la BD no garantiza orden) — top 60 para la lista lateral.
    const orden = [...eventos].sort((a, b) => (b.fecha || "").localeCompare(a.fecha || "")).slice(0, 60);
    tbody.innerHTML = orden.map(ev => {
      const b = badgeDe(ev.tipo_evento);
      const p = ev.popup || {};
      return `<tr>
        <td class="fecha">${esc(fechaCorta(ev.fecha))}</td>
        <td><span class="sngr-badge" style="--c:${b.color};--bg:${b.bg}">${esc(b.badge)}</span></td>
        <td>${esc(lugarDe(p))}</td>
      </tr>`;
    }).join("");
  }

  // Mapa base OSM (CARTO) que CAMBIA con el tema: claro / oscuro.
  function urlTiles() {
    const oscuro = (App.tema && App.tema() === "oscuro");
    return "https://{s}.basemaps.cartocdn.com/" + (oscuro ? "dark_all" : "light_all") + "/{z}/{x}/{y}{r}.png";
  }

  /* ---------------- Leaflet ---------------- */
  function iniciarMapa(div) {
    // Mapa base OSM/CARTO (teselas en línea, claras u oscuras según el tema) +
    // capas temáticas locales (límites/cuencas), red de ríos y eventos por encima.
    const map = L.map(div, {
      zoomControl: false, attributionControl: false,
      minZoom: 5, maxZoom: 17, maxBoundsViscosity: 0.7,
    }).setView(CENTRO_EC, ZOOM_INI);
    estado.mapa = map;
    estado.capaTiles = L.tileLayer(urlTiles(), {
      attribution: "© OpenStreetMap · © CARTO", subdomains: "abcd", maxZoom: 19, crossOrigin: true,
    }).addTo(map);
    // Apilado por panes: temática < ríos < marcadores (markerPane 600). Las teselas
    // van en el tilePane (z 200), por debajo de todo.
    map.createPane("pTematica").style.zIndex = 360;
    map.createPane("pRios").style.zIndex = 370;
    estado.lienzoRios = L.canvas({ padding: 0.5, pane: "pRios" });   // canvas: ~4700 ríos sin frenar
    map.on("zoomend moveend", actualizarSello);
    actualizarSello();
    cargarTierra();                                   // solo fija el límite de paneo
  }

  // Carga provincias SOLO para fijar el límite de paneo al país (sobre las teselas OSM).
  async function cargarTierra() {
    const E = estado;
    let gj;
    try { gj = await cargarCapa("provincias"); }
    catch (e) { return; }
    if (!vigente(E) || !estado.mapa) return;
    try {
      const b = L.geoJSON(gj).getBounds();
      if (b.isValid()) { estado.boundsEC = b; estado.mapa.setMaxBounds(b.pad(0.3)); }
    } catch (e) { /* sin límites válidos */ }
  }

  // Color estable de cuenca a partir de su código/nombre (no cambia entre redibujos).
  function hashColor(s) {
    s = String(s || ""); let h = 0;
    for (let k = 0; k < s.length; k++) h = (h * 31 + s.charCodeAt(k)) >>> 0;
    return colorCuenca(h);
  }
  async function cargarCapa(nivel) {
    if (estado.cacheCapas[nivel]) return estado.cacheCapas[nivel];
    const gj = await App.api("/datos/capas/" + nivel + ".geojson");
    // parroquias puede responder 202 {construyendo} — no se usa aquí.
    if (gj && gj.construyendo) throw new Error("La capa se está construyendo, intenta luego.");
    estado.cacheCapas[nivel] = gj;
    return gj;
  }
  async function pintarCapaBase(id) {
    const E = estado;
    const cfg = CAPAS.find(c => c.id === id) || CAPAS[0];
    estado.capaActual = id;
    const selCapa = document.querySelector('[data-rol="capa"]');
    if (selCapa && selCapa.value !== id) selCapa.value = id;
    const selloCapa = document.querySelector('[data-rol="sello-capa"]');
    if (selloCapa) selloCapa.textContent = cfg.etq.toUpperCase();
    let gj;
    try { gj = await cargarCapa(cfg.nivel); }
    catch (e) { App.aviso("Capa " + cfg.etq + ": " + e.message, "error"); return; }
    if (!vigente(E) || !estado.mapa) return;
    if (estado.capaBaseCasing) { estado.mapa.removeLayer(estado.capaBaseCasing); estado.capaBaseCasing = null; }
    if (estado.capaBase) { estado.mapa.removeLayer(estado.capaBase); estado.capaBase = null; }
    const P = paletaMapa();
    const esCuenca = cfg.tipo === "cuenca";
    // Cuencas = mapa temático coloreado por cuenca (relleno categórico estable);
    // admin = límites sobre el relieve, con ENCASILLADO (borde negro grueso + casing
    // blanco debajo) para que el shape de Ecuador resalte sobre cualquier tesela.
    const estilo = esCuenca
      ? (f) => ({ color: "#FFFFFF", weight: 0.7, opacity: 0.65,
          fillColor: hashColor((f.properties || {}).codigo || (f.properties || {}).nombre),
          fillOpacity: 0.5 })
      : () => ({ color: (App.tema && App.tema() === "oscuro") ? "#AEBBD0" : "#0b0d12", weight: 1.3, opacity: 0.95, fillOpacity: 0, fill: false });
    if (!esCuenca) {
      estado.capaBaseCasing = L.geoJSON(gj, { pane: "pTematica", interactive: false,
        style: () => ({ color: "#ffffff", weight: 3.4, opacity: 0.9, fillOpacity: 0, fill: false }) }).addTo(estado.mapa);
    }
    estado.capaBase = L.geoJSON(gj, {
      pane: "pTematica", style: estilo,
      onEachFeature: (f, layer) => {
        const n = (f.properties || {}).nombre;
        if (n) layer.bindTooltip(String(n), { sticky: true, direction: "top", className: "sngr-tt" });
      },
    }).addTo(estado.mapa);
    // (El límite de paneo lo fija cargarTierra una sola vez desde el continente.)
  }

  async function alternarRios(activar) {
    const E = estado;
    estado.rios = activar;
    const btn = document.querySelector('[data-rol="rios"]');
    if (btn) btn.classList.toggle("activo", activar);
    const ley = document.querySelector('[data-rol="leyenda-rios"]');
    if (ley) ley.classList.toggle("oculto", !activar);
    if (!activar) {
      if (estado.capaRios) { estado.mapa.removeLayer(estado.capaRios); estado.capaRios = null; }
      return;
    }
    if (estado.capaRios) return;   // ya cargada
    let gj;
    try { gj = await cargarCapa("hidrografia"); }
    catch (e) { App.aviso("Ríos: " + e.message, "error"); estado.rios = false; if (btn) btn.classList.remove("activo"); return; }
    if (!vigente(E) || !estado.mapa || !estado.rios) return;
    const P = paletaMapa();
    // Red COMPLETA (rio_l): los principales (prioridad 1/2) gruesos y oscuros, el
    // resto finos y claros. Sobre canvas para no frenar con ~4700 polilíneas.
    estado.capaRios = L.geoJSON(gj, {
      pane: "pRios", renderer: estado.lienzoRios, interactive: false,
      style: (f) => {
        const pri = String((f.properties || {}).prioridad || "").trim();
        const mayor = pri === "1" || pri === "2";
        return { color: mayor ? P.rioMayor : P.rioMenor,
                 weight: mayor ? 1.3 : 0.5, opacity: mayor ? 0.95 : 0.7 };
      },
    }).addTo(estado.mapa);
  }

  // Crea el grupo de clúster coloreando cada burbuja por el tipo dominante.
  function nuevoCluster() {
    return L.markerClusterGroup({
      chunkedLoading: true,
      maxClusterRadius: 48,
      iconCreateFunction: cl => {
        const hijos = cl.getAllChildMarkers();
        const cuenta = {};
        for (const m of hijos) {
          const t = m.options._tipo;
          cuenta[t] = (cuenta[t] || 0) + 1;
        }
        let dom = hijos[0] && hijos[0].options._tipo, max = -1;
        for (const k in cuenta) if (cuenta[k] > max) { max = cuenta[k]; dom = k; }
        const n = cl.getChildCount();
        const d = n < 10 ? 30 : n < 100 ? 38 : n < 1000 ? 46 : 54;
        return L.divIcon({
          html: `<div class="sngr-cluster" style="--c:${colorDe(dom)};width:${d}px;height:${d}px">${n}</div>`,
          className: "", iconSize: [d, d],
        });
      },
    });
  }
  function pintarMarcadores(eventos) {
    if (!estado.mapa) return;
    if (estado.cluster) { estado.mapa.removeLayer(estado.cluster); estado.cluster = null; }
    const cl = nuevoCluster();
    for (const ev of eventos) {
      if (typeof ev.lat !== "number" || typeof ev.lon !== "number") continue;
      const col = colorDe(ev.tipo_evento);
      const m = L.marker([ev.lat, ev.lon], {
        _tipo: ev.tipo_evento,
        icon: L.divIcon({
          html: `<div class="sngr-punto" style="--c:${col};width:11px;height:11px"></div>`,
          className: "", iconSize: [11, 11], iconAnchor: [5.5, 5.5],
        }),
      });
      m.bindPopup(popupHTML(ev));
      cl.addLayer(m);
    }
    estado.cluster = cl;
    estado.mapa.addLayer(cl);
  }
  function popupHTML(ev) {
    const p = ev.popup || {};
    const b = badgeDe(ev.tipo_evento);
    const linea = (et, v) => (v !== undefined && v !== null && v !== "")
      ? `<div><b>${esc(et)}:</b> ${esc(v)}</div>` : "";
    const np = parseFloat(p.afectados_personas) || 0, nf = parseFloat(p.afectados_familias) || 0;
    const afect = [];
    if (np > 0) afect.push(`${np.toLocaleString("es-EC")} personas`);
    if (nf > 0) afect.push(`${nf.toLocaleString("es-EC")} familias`);
    return `<div class="sngr-popup">
      <span class="tt" style="color:${b.color};background:${b.bg}">${esc(b.badge)}</span>
      ${linea("Fecha", p.fecha || ev.fecha)}
      ${linea("Lugar", lugarDe(p))}
      ${linea("Parroquia", p.parroquia)}
      ${linea("Sector", p.sector)}
      ${linea("Río", p.rio)}
      ${linea("Cuerpo", p.cuerpo)}
      ${linea("Estado", p.estado)}
      ${linea("Desbordó", p.desbordado)}
      ${linea("Causa", p.causa)}
      ${afect.length ? linea("Afectados", afect.join(" · ")) : ""}
      ${p.observaciones ? `<div class="sngr-popup-desc"><b>Descripción:</b> ${esc(p.observaciones)}</div>` : ""}
      ${p.novedad ? `<div class="sngr-popup-desc"><b>Novedad:</b> ${esc(p.novedad)}</div>` : ""}
      ${p.precision ? `<div class="suave" style="margin-top:4px">${esc(p.precision)}</div>` : ""}
    </div>`;
  }

  function actualizarSello() {
    const sel = document.querySelector('[data-rol="sello-abajo"]');
    if (!sel || !estado.mapa) return;
    const n = estado.cluster ? estado.cluster.getLayers().length : 0;
    sel.textContent = `Arrastra · +/− zoom · ×${n.toLocaleString("es-EC")}`;
  }

  /* ---------------- carga de datos ---------------- */
  function queryFiltros() {
    const s = estado.sel, q = new URLSearchParams();
    if (s.tipo) q.set("tipo", s.tipo);
    if (s.provincia) q.set("provincia", s.provincia);
    if (s.canton) q.set("canton", s.canton);
    if (s.parroquia) q.set("parroquia", s.parroquia);
    if (s.desde) q.set("desde", s.desde);
    if (s.hasta) q.set("hasta", s.hasta);
    const str = q.toString();
    return str ? "?" + str : "";
  }
  async function recargarEventos() {
    const E = estado;
    const token = ++estado.pidiendo;
    let r;
    try { r = await App.api("/sngr/eventos" + queryFiltros()); }
    catch (e) { App.aviso("Eventos: " + e.message, "error"); return; }
    if (!vigente(E) || token !== estado.pidiendo) return;  // recarga más nueva o montaje obsoleto
    pintarConteos(r.conteos_por_tipo || {});
    pintarTabla(r.eventos || []);
    pintarMarcadores(r.eventos || []);
    actualizarSello();
  }

  // Recarga la cascada (cantones/parroquias dependientes) preservando el resto.
  async function recargarCascada() {
    const E = estado;
    const token = ++estado.pidiendoCascada;   // token propio: no cancela recargarEventos
    let f;
    try {
      const q = new URLSearchParams();
      if (estado.sel.provincia) q.set("provincia", estado.sel.provincia);
      if (estado.sel.canton) q.set("canton", estado.sel.canton);
      const suf = q.toString() ? "?" + q.toString() : "";
      f = await App.api("/sngr/filtros" + suf);
    } catch (e) { App.aviso("Filtros: " + e.message, "error"); return; }
    if (!vigente(E) || token !== estado.pidiendoCascada) return;  // respuesta stale fuera de orden
    estado.filtros = f;
    const wrap = document.querySelector(".sngr-filtros");
    if (wrap) wrap.outerHTML = filtrosHTML(f);
    conectarFiltros();
  }

  function conectarFiltros() {
    const wrap = document.querySelector(".sngr-filtros");
    if (!wrap) return;
    const get = rol => wrap.querySelector(`[data-rol="${rol}"]`);
    get("tipo").onchange = e => { estado.sel.tipo = e.target.value; recargarEventos(); };
    get("provincia").onchange = async e => {
      estado.sel.provincia = e.target.value;
      estado.sel.canton = ""; estado.sel.parroquia = "";
      await recargarCascada();
      recargarEventos();
    };
    get("canton").onchange = async e => {
      estado.sel.canton = e.target.value;
      estado.sel.parroquia = "";
      await recargarCascada();
      recargarEventos();
    };
    get("parroquia").onchange = e => { estado.sel.parroquia = e.target.value; recargarEventos(); };
    get("desde").onchange = e => { estado.sel.desde = e.target.value; recargarEventos(); };
    get("hasta").onchange = e => { estado.sel.hasta = e.target.value; recargarEventos(); };
    // v11: los botones viven en la fila de filtros → religarlos en cada regeneración.
    const bExp = get("exportar"), bAct = get("actualizar");
    if (bExp) bExp.onclick = e => exportarZip(e.currentTarget);
    if (bAct) bAct.onclick = actualizar;
  }

  /* ---------------- acciones de cabecera ---------------- */
  async function exportarZip(btn) {
    btn.disabled = true;
    try {
      const r = await App.api("/sngr/exportar" + queryFiltros());
      App.aviso(`ZIP guardado en Descargas: ${r.archivo}`, "ok", 6000);
    } catch (e) {
      App.aviso("Exportar: " + e.message, "error");
    } finally { btn.disabled = false; }
  }
  async function actualizar() {
    try {
      // Hidrología = SNGR (eventos ríos) + FFGS, en una sola tarea (áreas en paralelo).
      const id = await App.tarea("/actualizar/global", { areas: ["sngr", "ffgs"] });
      App.modalTarea("Actualizar Hidrología (SNGR + FFGS)", id);
    } catch (e) { App.aviso(e.message, "error"); }
  }

  /* ---------------- registro de la vista ---------------- */
  // PANEL "Eventos de Ríos" (se monta en un contenedor; vive bajo Hidrología).
  async function renderEventos(cont) {
    crear();
    let f;
    try { f = await App.api("/sngr/filtros"); }
    catch (e) {
      cont.innerHTML = `<div class="vacio"><div class="icono">⚠️</div>
        <strong>No se pudieron cargar los eventos</strong><span>${esc(e.message)}</span></div>`;
      return;
    }
    estado.filtros = f;
    estado.sel.desde = f.fecha_min || "";
    estado.sel.hasta = f.fecha_max || "";

    // v11: sin fila de acciones aparte — los botones van dentro de la fila de filtros
    // (filtrosHTML) y se ligan en conectarFiltros(), sobreviviendo la cascada.
    cont.innerHTML = `<div data-screen-label="Eventos de Ríos">
      ${conteosHTML()}
      ${filtrosHTML(f)}
      ${mapaTablaHTML()}
    </div>`;

    conectarFiltros();
    conectarConteos();

    iniciarMapa(cont.querySelector('[data-rol="mapa"]'));
    cont.querySelector('[data-rol="capa"]').onchange = (e) => pintarCapaBase(e.target.value);
    cont.querySelector('[data-rol="rios"]').onclick = () => alternarRios(!estado.rios);
    cont.querySelector('[data-rol="zoom+"]').onclick = () => estado.mapa.zoomIn();
    cont.querySelector('[data-rol="zoom-"]').onclick = () => estado.mapa.zoomOut();
    cont.querySelector('[data-rol="reset"]').onclick = () => {
      if (estado.boundsEC && estado.boundsEC.isValid()) return estado.mapa.fitBounds(estado.boundsEC.pad(0.05));
      estado.mapa.setView(CENTRO_EC, ZOOM_INI);
    };

    if (_onTemaEventos) document.removeEventListener("temacambiado", _onTemaEventos);
    _onTemaEventos = () => {
      if (!estado || !estado.mapa) return;
      const P = paletaMapa();
      if (estado.capaTiles) estado.capaTiles.setUrl(urlTiles());
      const cfg = CAPAS.find(c => c.id === estado.capaActual);
      if (estado.capaBase && cfg && cfg.tipo !== "cuenca") estado.capaBase.setStyle({ color: P.adminBorde });
      if (estado.capaRios) estado.capaRios.setStyle(f2 => {
        const pri = String((f2.properties || {}).prioridad || "").trim();
        const mayor = pri === "1" || pri === "2";
        return { color: mayor ? P.rioMayor : P.rioMenor };
      });
    };
    document.addEventListener("temacambiado", _onTemaEventos);

    await pintarCapaBase("provincias");
    await recargarEventos();
    alternarRios(true);
    if (estado.boundsEC && estado.boundsEC.isValid()) { try { estado.mapa.fitBounds(estado.boundsEC.pad(0.05)); } catch (e) {} }
  }

  function limpiarEventos() {
    if (_onTemaEventos) { document.removeEventListener("temacambiado", _onTemaEventos); _onTemaEventos = null; }
    if (estado) estado.epoca = -1;
    if (estado && estado.mapa) { try { estado.mapa.remove(); } catch (e) {} estado.mapa = null; }
  }

  App.panel("eventos_rios", renderEventos);

  // MENÚ "Hidrología": Eventos Ríos · FFGS (panel reutilizado de Cartas).
  App.registrar("hidrologia", {
    titulo: "Hidrología", orden: 3,
    async render(vista) {
      vista.dataset.screenLabel = "Hidrología";
      App.vistaPestanas(vista, {
        kicker: "Gestión de riesgos", titulo: "Hidrología",
        sub: "Eventos de ríos · guía de crecidas (FFGS) · caudales modelados (GEOGLOWS)",
        inicial: "eventos_rios",
        pestanas: [
          { id: "eventos_rios", etiqueta: "Eventos Ríos", render: renderEventos, alSalir: limpiarEventos },
          { id: "ffgs", etiqueta: "FFGS",
            render: (c) => { const p = App.panel("ffgs"); return p ? p(c) : (c.innerHTML = "FFGS no disponible"); },
            alSalir: () => { const p = App.panel("cartas:purgar"); if (p) p(); } },
          { id: "geoglows", etiqueta: "Caudales GEOGLOWS",
            render: (c) => { const p = App.panel("geoglows"); return p ? p(c) : (c.innerHTML = "GEOGLOWS no disponible"); },
            alSalir: () => { const p = App.panel("geoglows:purgar"); if (p) p(); } },
        ],
      });
    },
    alDejar() {
      limpiarEventos();
      const cab = document.getElementById("cabecera-vista");
      if (cab) cab.style.display = "";
      const p = App.panel("cartas:purgar"); if (p) p();
    },
  });

  // Bus de refresco: tras CUALQUIER actualización, si el panel Eventos está montado y
  // vigente, recarga cascada + eventos (lo mismo que el botón Actualizar de Hidrología).
  document.addEventListener("datos-actualizados", () => {
    if (estado && estado.epoca >= 0) { estado.cacheCapas = {}; recargarCascada(); recargarEventos(); }
  });
})();
