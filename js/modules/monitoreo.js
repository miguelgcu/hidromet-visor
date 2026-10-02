/* ============================================================
   Monitoreo — productos satelitales en vivo sobre un mapa Leaflet:
   GOES-19 cada 10 min, lluvia GPM IMERG, inundación Sentinel-1 (GFM) y
   VIIRS, incendios, temperatura del mar, humedad del suelo e imagen diaria.
   Catálogo: /api/monitoreo/catalogo (app/modulos/monitoreo/catalogo.py).
   Las imágenes NO pasan por HidroMet: el navegador las pide al proveedor
   (NASA GIBS, Copernicus), igual en el escritorio y en el visor publicado,
   así que siempre se ve lo último que el proveedor tiene.
   ============================================================ */
"use strict";

(() => {
  const esc = v => String(v ?? "").replace(/[&<>"']/g,
    c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const CLAVE_LOCAL = "hm-monitoreo";
  const ZONA = "America/Guayaquil";
  const MS = { M: 60e3, H: 3600e3, D: 86400e3 };
  const PRODUCTO_INICIAL = "goes_geocolor";

  const E = {
    cat: null, mapa: null, base: null, etiquetas: null, limites: null,
    activas: new Map(),   // id -> {p, capa, instantes, i, opacidad, errores}
    foco: null,           // id de la capa que gobierna la barra de tiempo
    juego: null,          // temporizador de la animación
    z: 10,
  };

  /* ---------------- preferencias del usuario (opcionales) ---------------- */
  function leerPrefs() {
    try { return JSON.parse(localStorage.getItem(CLAVE_LOCAL) || "{}") || {}; } catch (e) { return {}; }
  }
  function guardarPrefs() {
    try {
      localStorage.setItem(CLAVE_LOCAL, JSON.stringify({
        base: E.baseId,
        activas: [...E.activas.values()].map(a => ({ id: a.p.id, opacidad: a.opacidad })),
      }));
    } catch (e) { /* sin almacenamiento: no pasa nada */ }
  }

  /* ---------------- tiempo ---------------- */
  // Duración ISO 8601 sencilla (PT10M, PT3H, P1D, P10D) → milisegundos.
  function duracionMs(iso) {
    const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/.exec(String(iso || ""));
    if (!m) return 0;
    return (+(m[1] || 0)) * MS.D + (+(m[2] || 0)) * MS.H + (+(m[3] || 0)) * MS.M;
  }
  const esDiario = p => String(p.paso || "").startsWith("P") && !String(p.paso || "").startsWith("PT");
  const isoMin = d => d.toISOString().slice(0, 19) + "Z";
  const isoDia = d => d.toISOString().slice(0, 10);

  // "a/b/PT10M,c" → lista de Date (los extremos incluidos).
  function expandirDominio(texto) {
    const salida = [];
    for (const tramo of String(texto || "").split(",").map(s => s.trim()).filter(Boolean)) {
      const partes = tramo.split("/");
      const ini = new Date(partes[0].length === 10 ? partes[0] + "T00:00:00Z" : partes[0]);
      if (isNaN(ini)) continue;
      if (partes.length < 3) { salida.push(ini); continue; }
      const fin = new Date(partes[1].length === 10 ? partes[1] + "T00:00:00Z" : partes[1]);
      const paso = duracionMs(partes[2]);
      if (isNaN(fin) || !paso) { salida.push(ini); continue; }
      for (let t = ini.getTime(); t <= fin.getTime() && salida.length < 400; t += paso) salida.push(new Date(t));
    }
    return salida.sort((a, b) => a - b);
  }

  // Instantes que de verdad existen en GIBS para la ventana del producto (DescribeDomains, CORS abierto).
  async function instantesGibs(p) {
    const fin = new Date();
    const ini = new Date(fin.getTime() - duracionMs(p.ventana));
    const url = `${p.url}/1.0.0/${p.capa}/default/GoogleMapsCompatible_Level${p.nivel}/all/${isoMin(ini)}--${isoMin(fin)}.xml`;
    const resp = await fetch(url, { cache: "no-cache" });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const xml = await resp.text();
    const dom = /<Domain>([^<]*)<\/Domain>/.exec(xml);
    return expandirDominio(dom ? dom[1] : "").filter(t => t >= ini && t <= fin);
  }

  // Los WMS no publican su lista: días UTC hacia atrás (el más reciente al final).
  function instantesWms(p) {
    if (!p.tiempo || p.tiempo === "rango30") return [null];
    const dias = Math.max(1, Math.round(duracionMs(p.ventana) / MS.D) || 1);
    const hoy = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()));
    const lista = [];
    for (let k = dias - 1; k >= 0; k--) lista.push(new Date(hoy.getTime() - k * MS.D));
    return lista;
  }

  function parametroTiempo(p, t) {
    if (p.tipo === "gibs") return t ? (esDiario(p) ? isoDia(t) : isoMin(t)) : "default";
    if (p.tiempo === "rango30") {
      const hoy = new Date();
      return `${isoDia(new Date(hoy.getTime() - 30 * MS.D))}/${isoDia(hoy)}`;
    }
    if (!t || !p.tiempo) return "";
    return p.tiempo === "dia_hora" ? isoDia(t) + "T00:00:00Z" : isoDia(t);
  }

  const horaLocal = d => d.toLocaleString("es-EC", { timeZone: ZONA, weekday: "short", day: "2-digit", month: "short",
                                                     hour: "2-digit", minute: "2-digit", hour12: false });
  function hace(d) {
    const min = Math.round((Date.now() - d.getTime()) / MS.M);
    return min < 120 ? `hace ${min} min` : min < 2880 ? `hace ${Math.round(min / 60)} h` : `hace ${Math.round(min / 1440)} días`;
  }
  // Producto calculado por HidroMet: periodo que cubre y edad (se calcula en cada actualización).
  function rotuloCalculado(p) {
    if (!p.instante_utc) return "";
    const fin = new Date(p.instante_utc);
    return p.desde_utc ? `${horaLocal(new Date(p.desde_utc))} → ${horaLocal(fin)} · ${hace(fin)}` : `${horaLocal(fin)} · ${hace(fin)}`;
  }
  const esCalculado = p => p.tipo === "imagen" || p.tipo === "puntos";

  function rotuloTiempo(p, t) {
    if (esCalculado(p)) return rotuloCalculado(p);
    if (p.tiempo === "rango30") return "últimos 30 días";
    if (!t) return "lo más reciente del proveedor";
    if (p.tipo === "gibs" && !esDiario(p)) {
      const local = t.toLocaleString("es-EC", { timeZone: ZONA, weekday: "short", day: "2-digit", month: "short",
                                                hour: "2-digit", minute: "2-digit", hour12: false });
      const utc = t.toISOString().slice(11, 16);
      const minutos = Math.round((Date.now() - t.getTime()) / MS.M);
      const hace = minutos < 120 ? `hace ${minutos} min` : `hace ${Math.round(minutos / 60)} h`;
      return `${local} (${utc} UTC) · ${hace}`;
    }
    return t.toLocaleDateString("es-EC", { timeZone: "UTC", weekday: "short", day: "2-digit", month: "short", year: "numeric" });
  }

  /* ---------------- capas ---------------- */
  // Archivos que calcula HidroMet: en el escritorio los sirve la API; en el visor, productos/.
  function urlArchivo(nombre) {
    const base = window.HIDROMET_VISOR ? "productos/monitoreo/archivo/" : "/api/monitoreo/archivo/";
    return base + nombre + (E.calcVersion ? `?v=${encodeURIComponent(E.calcVersion)}` : "");
  }

  // Color por edad: lo reciente resalta (rayos en minutos, focos en horas).
  function colorEdad(p, t) {
    const edad = (Date.now() - new Date(t).getTime()) / (p.estilo && p.estilo.por === "minutos" ? MS.M : MS.H);
    if (p.estilo && p.estilo.por === "minutos") return edad < 10 ? "#FFFFFF" : edad < 30 ? "#FFE14D" : "#FF9E2C";
    return edad < 24 ? "#FF2D1F" : edad < 72 ? "#FF9E2C" : "#FFD84D";
  }

  function popupPunto(p, x) {
    const t = new Date(x.t);
    const filas = [[`${horaLocal(t)}`, hace(t)]];
    if (x.sensor) filas.push(["Sensor", x.sensor]);
    if (x.confianza) filas.push(["Confianza", x.confianza]);
    if (x.frp_MW != null) filas.push(["Potencia (FRP)", `${App.fmtNum(x.frp_MW, 1)} MW`]);
    if (x.dia_noche) filas.push(["Paso", x.dia_noche === "D" ? "de día" : "de noche"]);
    if (x.energia_fJ != null) filas.push(["Energía", `${App.fmtNum(x.energia_fJ, 0)} fJ`]);
    if (x.ec === false) filas.push(["Ubicación", "fuera de Ecuador"]);
    return `<b>${esc(p.nombre)}</b><table class="mon-pop">${filas.map(f => `<tr><td>${esc(f[0])}</td><td>${esc(f[1])}</td></tr>`).join("")}</table>`;
  }

  function capaPuntos(p, opacidad) {
    const grupo = L.layerGroup();
    const radio = f => {
      const base = (p.estilo && p.estilo.radio) || 4;
      const frp = Number(f.properties.frp_MW);
      return isFinite(frp) && frp > 0 ? base + Math.min(5, Math.log10(1 + frp) * 2.5) : base;
    };
    grupo.setOpacity = op => grupo.eachLayer(g => g.eachLayer && g.eachLayer(m => m.setStyle({ opacity: op, fillOpacity: op * 0.85 })));
    App.api(`/monitoreo/archivo/${p.archivo}`).then(geo => {
      L.geoJSON(geo, {
        pointToLayer: (f, ll) => L.circleMarker(ll, {
          pane: "mon-puntos", radius: radio(f), color: "#1a1a1a", weight: 0.6, opacity: opacidad,
          fillColor: colorEdad(p, f.properties.t), fillOpacity: opacidad * 0.85,
        }),
        onEachFeature: (f, capa) => capa.bindPopup(popupPunto(p, f.properties)),
      }).addTo(grupo);
      grupo.fire("load");
    }).catch(e => {
      console.error("Monitoreo: no se pudieron dibujar los puntos de", p.id, e);
      App.aviso(`No se pudieron dibujar los puntos de «${p.nombre}».`, "error");
      grupo.fire("load");
    });
    return grupo;
  }

  function crearCapa(p, t, opacidad) {
    if (p.tipo === "imagen") {
      const [o, s, e, n] = p.limites;
      // pixelado: cada celda es un píxel del satélite; suavizarlo inventaría detalle
      return L.imageOverlay(urlArchivo(p.archivo), [[s, o], [n, e]], {
        opacity: opacidad, pane: "mon-productos", zIndex: ++E.z, interactive: false, className: "mon-img",
        attribution: "Calculado por HidroMet con NOAA GOES-19" });
    }
    if (p.tipo === "puntos") return capaPuntos(p, opacidad);
    const comun = { opacity: opacidad, attribution: esc(p.atribucion || ""), pane: "mon-productos",
                    zIndex: ++E.z, maxZoom: 18, crossOrigin: false };
    if (p.tipo === "gibs") {
      const url = `${p.url}/${p.capa}/default/${parametroTiempo(p, t)}/GoogleMapsCompatible_Level${p.nivel}/{z}/{y}/{x}.${p.ext || "png"}`;
      return L.tileLayer(url, { ...comun, maxNativeZoom: p.nivel });
    }
    const extra = {};
    const tt = parametroTiempo(p, t);
    if (tt) extra.TIME = tt;
    // uppercase: el WMS de GDO responde 400 a «request=GetMap» en minúscula (la norma no distingue; ese servidor sí)
    return L.tileLayer.wms(p.url, { ...comun, layers: p.capa, styles: "", format: "image/png", transparent: true,
                                    version: "1.1.1", uppercase: true, ...extra });
  }

  function vigilarErrores(a, capa) {
    a.errores = 0;
    capa.on("tileerror", () => { a.errores++; pintarLeyenda(); });
  }

  // Cambia el instante sin parpadeo: la capa nueva se monta encima y la vieja se retira al cargar.
  function ponerInstante(a, i) {
    if (!a.instantes.length) return Promise.resolve();
    a.i = Math.max(0, Math.min(a.instantes.length - 1, i));
    const vieja = a.capa;
    const nueva = crearCapa(a.p, a.instantes[a.i], a.opacidad);
    vigilarErrores(a, nueva);
    a.capa = nueva;
    nueva.addTo(E.mapa);
    pintarTiempo(); pintarLeyenda();
    return new Promise(res => {
      let hecho = false;
      const fin = () => { if (hecho) return; hecho = true; if (vieja) E.mapa.removeLayer(vieja); res(); };
      nueva.once("load", fin);
      setTimeout(fin, 6000);   // un mosaico que no llega no congela la animación
    });
  }

  async function activar(id, opacidad) {
    const p = E.cat.productos.find(x => x.id === id);
    if (!p || E.activas.has(id)) return;
    const a = { p, capa: null, instantes: [], i: 0, opacidad: opacidad ?? p.opacidad ?? 0.85, errores: 0, cargando: true };
    E.activas.set(id, a);
    E.foco = id;
    pintarPanel(); pintarTiempo();
    try {
      a.instantes = p.tipo === "gibs" ? await instantesGibs(p) : p.tipo === "wms" ? instantesWms(p) : [null];
    } catch (e) {
      a.instantes = [];
      a.avisoTiempo = "no se pudo consultar la lista de instantes; se muestra lo más reciente";
    }
    if (!E.activas.has(id)) return;   // la desactivaron mientras llegaba la lista
    if (!a.instantes.length) a.instantes = [null];
    a.cargando = false;
    await ponerInstante(a, a.instantes.length - 1);
    pintarPanel(); guardarPrefs();
  }

  function desactivar(id) {
    const a = E.activas.get(id);
    if (!a) return;
    if (E.foco === id) parar();
    if (a.capa) E.mapa.removeLayer(a.capa);
    E.activas.delete(id);
    if (E.foco === id) E.foco = [...E.activas.keys()].pop() || null;
    pintarPanel(); pintarTiempo(); pintarLeyenda(); guardarPrefs();
  }

  /* ---------------- animación ---------------- */
  function parar() {
    if (E.juego) { clearTimeout(E.juego); E.juego = null; }
    const b = document.getElementById("mon-play");
    if (b) b.textContent = "▶";
  }
  function reproducir() {
    const a = E.activas.get(E.foco);
    if (!a || a.instantes.length < 2) return;
    if (E.juego) { parar(); return; }
    const b = document.getElementById("mon-play");
    if (b) b.textContent = "❚❚";
    const paso = async () => {
      const t0 = performance.now();
      await ponerInstante(a, a.i + 1 < a.instantes.length ? a.i + 1 : 0);
      if (!E.juego) return;
      const pausa = a.i === a.instantes.length - 1 ? 1500 : 650;   // se detiene un poco en el último
      E.juego = setTimeout(paso, Math.max(0, pausa - (performance.now() - t0)));
    };
    E.juego = setTimeout(paso, 0);
  }

  /* ---------------- pintado ---------------- */
  function fichaHTML(p) {
    const cob = p.cobertura ? `${p.cobertura.archivos} de ${p.cobertura.esperados} archivos` : "";
    const filas = [
      ["Satélite / fuente", p.satelite], ["Resolución", p.resolucion], ["Frecuencia", p.frecuencia],
      ["Llega con", p.latencia], ["Unidad", p.unidad],
      ["Periodo", esCalculado(p) ? rotuloCalculado(p) : ""], ["Cobertura", cob],
      ["Puntos", p.cantidad != null ? App.fmtNum(p.cantidad, 0) : ""],
      ["Máximo", p.estadisticas && p.estadisticas.max != null ? `${App.fmtNum(p.estadisticas.max, 1)} ${p.unidad || ""}` : ""],
    ].filter(f => f[1]);
    return `<div class="mon-ficha-tit">${esc(p.nombre)}</div>
      <p>${esc(p.que)}</p>
      <p class="mon-lectura"><b>Cómo leerlo.</b> ${esc(p.lectura)}</p>
      <dl>${filas.map(f => `<dt>${esc(f[0])}</dt><dd>${esc(f[1])}</dd>`).join("")}</dl>
      <a href="${esc(p.enlace)}" target="_blank" rel="noopener">Documentación del producto ↗</a>`;
  }

  function pintarPanel() {
    const caja = document.getElementById("mon-capas");
    if (!caja || !E.cat) return;
    caja.innerHTML = E.cat.grupos.map(g => {
      const prods = E.cat.productos.filter(p => p.grupo === g.id);
      return `<section class="mon-grupo"><h3>${esc(g.nombre)}<small>${esc(g.sub)}</small></h3>${prods.map(p => {
        const a = E.activas.get(p.id);
        return `<div class="mon-prod${a ? " activa" : ""}${E.foco === p.id ? " foco" : ""}" data-id="${p.id}">
          <label><input type="checkbox" ${a ? "checked" : ""} data-act="${p.id}">
            <span class="nom">${esc(p.nombre)}</span><span class="res">${esc(p.resolucion)}</span></label>
          <button class="mon-info" data-info="${p.id}" title="Qué es y cómo leerlo" aria-label="Ficha de ${esc(p.nombre)}">i</button>
          ${a ? `<div class="mon-op"><input type="range" min="10" max="100" step="5" value="${Math.round(a.opacidad * 100)}"
                   data-op="${p.id}" aria-label="Opacidad de ${esc(p.nombre)}"><span>${Math.round(a.opacidad * 100)} %</span>
                 ${a.cargando ? `<em>consultando instantes…</em>` : ""}</div>` : ""}
        </div>`;
      }).join("")}</section>`;
    }).join("");
    caja.querySelectorAll("[data-act]").forEach(c => c.onchange = () => {
      const id = c.dataset.act;
      if (c.checked) activar(id); else desactivar(id);
    });
    caja.querySelectorAll("[data-info]").forEach(b => b.onclick = () => mostrarFicha(b.dataset.info));
    caja.querySelectorAll("[data-op]").forEach(r => r.oninput = () => {
      const a = E.activas.get(r.dataset.op);
      if (!a) return;
      a.opacidad = Number(r.value) / 100;
      if (a.capa) a.capa.setOpacity(a.opacidad);
      r.nextElementSibling.textContent = `${r.value} %`;
      guardarPrefs();
    });
    caja.querySelectorAll(".mon-prod.activa .nom").forEach(n => n.onclick = ev => {
      ev.preventDefault();
      parar();
      E.foco = n.closest(".mon-prod").dataset.id;
      pintarPanel(); pintarTiempo();
    });
  }

  function mostrarFicha(id) {
    const p = E.cat.productos.find(x => x.id === id);
    const caja = document.getElementById("mon-ficha");
    if (!p || !caja) return;
    caja.innerHTML = `<button class="mon-cerrar" aria-label="Cerrar">×</button>${fichaHTML(p)}`;
    caja.hidden = false;
    caja.querySelector(".mon-cerrar").onclick = () => { caja.hidden = true; };
  }

  function pintarTiempo() {
    const caja = document.getElementById("mon-tiempo");
    if (!caja) return;
    const a = E.activas.get(E.foco);
    if (!a) { caja.hidden = true; return; }
    caja.hidden = false;
    const n = a.instantes.length;
    const t = n ? a.instantes[a.i] : null;
    const movible = n > 1;
    caja.innerHTML = `<div class="mon-t-cab"><b>${esc(a.p.nombre)}</b>
        <span>${a.cargando ? "consultando instantes disponibles…" : esc(rotuloTiempo(a.p, t))}</span></div>
      ${movible ? `<div class="mon-t-ctl">
        <button id="mon-prev" title="Anterior" aria-label="Instante anterior">◀</button>
        <button id="mon-play" title="Animar" aria-label="Animar">${E.juego ? "❚❚" : "▶"}</button>
        <button id="mon-next" title="Siguiente" aria-label="Instante siguiente">▶︎▶︎</button>
        <input id="mon-slider" type="range" min="0" max="${n - 1}" value="${a.i}" aria-label="Instante">
        <span class="mon-t-n">${a.i + 1}/${n}</span></div>` : ""}
      ${a.avisoTiempo ? `<div class="mon-t-aviso">${esc(a.avisoTiempo)}</div>` : ""}`;
    if (!movible) return;
    caja.querySelector("#mon-prev").onclick = () => { parar(); ponerInstante(a, a.i - 1); };
    caja.querySelector("#mon-next").onclick = () => { parar(); ponerInstante(a, a.i + 1); };
    caja.querySelector("#mon-play").onclick = reproducir;
    caja.querySelector("#mon-slider").oninput = ev => { parar(); ponerInstante(a, Number(ev.target.value)); };
  }

  function pintarLeyenda() {
    const caja = document.getElementById("mon-leyenda");
    if (!caja) return;
    const activas = [...E.activas.values()].reverse();
    if (!activas.length) { caja.hidden = true; return; }
    caja.hidden = false;
    caja.innerHTML = activas.map(a => {
      const p = a.p;
      const t = a.instantes.length ? a.instantes[a.i] : null;
      const ley = p.tramos
        ? leyendaTramos(p)
        : p.tipo === "puntos"
          ? leyendaEdad(p)
        : p.leyenda
        ? `<img src="${esc(p.leyenda)}" alt="Leyenda de ${esc(p.nombre)}" loading="lazy">`
        : p.color_leyenda
          ? `<div class="mon-sw"><i style="background:${esc(p.color_leyenda)}"></i>${esc(p.nombre)}</div>`
          : `<div class="mon-rgb">Composición de color: ver «Cómo leerlo» en la ficha (i).</div>`;
      const cob = p.cobertura && p.cobertura.archivos < p.cobertura.esperados
        ? `<div class="mon-fallo">Faltan ${p.cobertura.esperados - p.cobertura.archivos} de ${p.cobertura.esperados} archivos del periodo.</div>` : "";
      const fallos = (a.errores > 3 ? `<div class="mon-fallo">El proveedor no entregó parte de la imagen de este instante.</div>` : "") + cob;
      return `<div class="mon-ley-item"><div class="mon-ley-tit">${esc(p.nombre)}${p.unidad ? ` <small>(${esc(p.unidad)})</small>` : ""}</div>
        <div class="mon-ley-t">${a.cargando ? "…" : esc(rotuloTiempo(p, t))}</div>${ley}${fallos}</div>`;
    }).join("");
  }

  // Leyenda por tramos [desde, hasta, color] del índice: una caja por tramo, rótulos espaciados.
  function leyendaTramos(p) {
    const t = p.tramos;
    const cada = t.length > 14 ? 3 : t.length > 8 ? 2 : 1;
    const num = v => App.fmtNum(v, Math.abs(v) < 10 && v % 1 ? 1 : 0);
    return `<div class="mon-tramos">${t.map(([d, h, c], i) =>
      `<span class="mon-tramo" title="${esc(num(d))}${h == null ? " o más" : " a " + esc(num(h))} ${esc(p.unidad || "")}">
         <i style="background:${esc(c)}"></i><em>${i % cada === 0 ? esc(num(d)) + (h == null ? "+" : "") : ""}</em></span>`).join("")}</div>`;
  }
  function leyendaEdad(p) {
    const minutos = p.estilo && p.estilo.por === "minutos";
    const tramos = minutos
      ? [["#FFFFFF", "< 10 min"], ["#FFE14D", "10–30 min"], ["#FF9E2C", "30–60 min"]]
      : [["#FF2D1F", "< 24 h"], ["#FF9E2C", "1–3 días"], ["#FFD84D", "3–7 días"]];
    const ec = p.cantidad_ecuador != null ? ` (${App.fmtNum(p.cantidad_ecuador, 0)} en Ecuador)` : "";
    const n = p.cantidad != null
      ? `<div class="mon-ley-n">${App.fmtNum(p.cantidad, 0)} ${minutos ? "destellos" : "focos"} en el mapa${ec}</div>` : "";
    return n + tramos.map(([c, e]) => `<div class="mon-sw"><i style="background:${c};border-radius:50%"></i>${e}</div>`).join("");
  }

  /* ---------------- mapa ---------------- */
  function ponerBase(id) {
    const b = E.cat.mapas_base.find(x => x.id === id) || E.cat.mapas_base[0];
    if (E.base) E.mapa.removeLayer(E.base);
    if (E.etiquetas) E.mapa.removeLayer(E.etiquetas);
    E.baseId = b.id;
    E.base = L.tileLayer(b.url, { attribution: b.atribucion, maxZoom: 18, maxNativeZoom: b.max, pane: "mon-base" })
      .addTo(E.mapa);
    E.etiquetas = b.etiquetas
      ? L.tileLayer(b.etiquetas, { maxZoom: 18, maxNativeZoom: Math.min(b.max, 16), pane: "mon-etiquetas" }).addTo(E.mapa)
      : null;
    const sel = document.getElementById("mon-base");
    if (sel) sel.value = b.id;
    guardarPrefs();
  }

  async function ponerLimites() {
    let geo = null;
    try { geo = await App.api("/datos/capas/provincias.geojson"); } catch (e) { geo = null; }
    if (!geo || !E.mapa) return;
    E.limites = L.geoJSON(geo, {
      pane: "mon-limites", interactive: false,
      style: { color: "#FFFFFF", weight: 0.9, opacity: 0.75, fill: false },
    }).addTo(E.mapa);
  }

  function baseSegunTema() {
    return document.documentElement.dataset.tema === "claro" ? "claro" : "oscuro";
  }

  // Productos que calcula HidroMet en cada actualización: se suman al catálogo en su grupo.
  async function cargarCalculados() {
    if (E.calc) return;
    let indice = null;
    try { indice = await App.api("/monitoreo/calculados"); } catch (e) { indice = null; }
    E.calc = indice && Array.isArray(indice.productos) ? indice : { productos: [] };
    E.calcVersion = E.calc.generado_utc || "";
    const grupos = new Set(E.cat.grupos.map(g => g.id));
    const ids = new Set(E.cat.productos.map(p => p.id));
    for (const p of E.calc.productos) {
      if (ids.has(p.id) || !grupos.has(p.grupo)) continue;
      E.cat.productos.push({ ...p, calculado: true, opacidad: p.tipo === "puntos" ? 0.95 : 0.8,
                             latencia: "se calcula en cada actualización de HidroMet" });
    }
  }

  async function tabMapa(cuerpo) {
    E.cat = E.cat || await App.api("/monitoreo/catalogo");
    await cargarCalculados();
    cuerpo.innerHTML = `<div class="mon">
      <aside class="mon-panel" id="mon-panel">
        <div class="mon-panel-cab">
          <label>Mapa base <select id="mon-base">${E.cat.mapas_base.map(b => `<option value="${b.id}">${esc(b.nombre)}</option>`).join("")}</select></label>
          <button id="mon-plegar" class="boton-fantasma" aria-expanded="true">Capas</button>
        </div>
        <div id="mon-capas" class="mon-capas"></div>
        <p class="mon-nota">Las imágenes se piden en vivo a NASA y Copernicus: muestran lo último que cada proveedor tiene, con su resolución nativa.</p>
      </aside>
      <div class="mon-mapa-caja">
        <div id="mon-mapa" class="mon-mapa" role="region" aria-label="Mapa de monitoreo"></div>
        <div id="mon-tiempo" class="mon-tiempo" hidden></div>
        <div id="mon-leyenda" class="mon-leyenda" hidden></div>
        <div id="mon-ficha" class="mon-ficha" hidden></div>
      </div>
    </div>`;
    const [o, s, e, n] = E.cat.limites;
    E.mapa = L.map("mon-mapa", { zoomControl: true, worldCopyJump: false, minZoom: 4, maxZoom: 18,
                                 maxBounds: L.latLngBounds([s - 15, o - 25], [n + 15, e + 25]) })
      .setView(E.cat.vista_inicial.centro, E.cat.vista_inicial.zoom);
    for (const [nombre, z] of [["mon-base", 200], ["mon-productos", 350], ["mon-limites", 420], ["mon-etiquetas", 440],
                               ["mon-puntos", 450]]) {
      const pane = E.mapa.createPane(nombre);
      pane.style.zIndex = z;
      if (nombre === "mon-etiquetas" || nombre === "mon-limites") pane.style.pointerEvents = "none";
    }
    L.control.scale({ imperial: false }).addTo(E.mapa);
    const prefs = leerPrefs();
    ponerBase(prefs.base || baseSegunTema());
    document.getElementById("mon-base").onchange = ev => ponerBase(ev.target.value);
    const plegar = document.getElementById("mon-plegar");
    // en el celular el mapa va primero: el panel de capas arranca plegado
    if (window.matchMedia && window.matchMedia("(max-width: 900px)").matches) {
      document.getElementById("mon-panel").classList.add("plegado");
      plegar.setAttribute("aria-expanded", "false");
    }
    plegar.onclick = () => {
      const panel = document.getElementById("mon-panel");
      const abierto = !panel.classList.toggle("plegado");
      plegar.setAttribute("aria-expanded", String(abierto));
      setTimeout(() => E.mapa && E.mapa.invalidateSize(), 220);
    };
    pintarPanel();
    ponerLimites();
    const iniciales = (prefs.activas && prefs.activas.length ? prefs.activas : [{ id: PRODUCTO_INICIAL }])
      .filter(x => E.cat.productos.some(p => p.id === x.id));
    for (const x of iniciales) activar(x.id, x.opacidad);
    setTimeout(() => E.mapa && E.mapa.invalidateSize(), 50);
  }

  function tabProductos(cuerpo) {
    const grupos = Object.fromEntries(E.cat.grupos.map(g => [g.id, g.nombre]));
    cuerpo.innerHTML = `<div class="mon-tabla-caja">
      <p class="mon-intro">Cada producto se pide directo al proveedor, en la resolución más fina que publica.
        La tabla dice qué mide, cada cuánto se actualiza y con cuánto retraso llega.</p>
      <div class="tabla-scroll"><table class="tabla mon-tabla"><thead><tr>
        <th>Tema</th><th>Producto</th><th>Origen</th><th>Satélite / fuente</th><th>Resolución</th><th>Frecuencia</th><th>Llega con</th><th>Qué mide</th>
      </tr></thead><tbody>${E.cat.productos.map(p => `<tr>
        <td>${esc(grupos[p.grupo] || p.grupo)}</td>
        <td><a href="${esc(p.enlace)}" target="_blank" rel="noopener">${esc(p.nombre)}</a></td>
        <td>${p.calculado ? "calculado por HidroMet" : "en vivo del proveedor"}</td>
        <td>${esc(p.satelite)}</td><td>${esc(p.resolucion)}</td><td>${esc(p.frecuencia)}</td>
        <td>${esc(p.latencia)}</td><td>${esc(p.que)}</td></tr>`).join("")}</tbody></table></div>
      <h3>En preparación</h3>
      <ul class="mon-pendientes">${(E.cat.pendientes || []).map(x => `<li><b>${esc(x.nombre)}</b> — ${esc(x.motivo)}</li>`).join("")}</ul>
    </div>`;
  }

  function limpiar() {
    parar();
    if (E.mapa) { try { E.mapa.remove(); } catch (e) { /* ya retirado */ } }
    E.mapa = null; E.base = null; E.etiquetas = null; E.limites = null;
    E.activas.clear(); E.foco = null;
  }
  // al salir del módulo se olvida el índice calculado: al volver se lee el de la última actualización
  function salirModulo() { limpiar(); E.calc = null; E.cat = null; }

  document.addEventListener("temacambiado", () => {
    if (!E.mapa || !E.cat) return;
    const prefs = leerPrefs();
    if (!prefs.base || prefs.base === "oscuro" || prefs.base === "claro") ponerBase(baseSegunTema());
  });

  App.registrar("monitoreo", {
    titulo: "Monitoreo", orden: 0.5,
    alDejar: salirModulo,
    async render(vista) {
      vista.dataset.screenLabel = "Monitoreo";
      vista.classList.add("vista-monitoreo");
      App.vistaPestanas(vista, {
        kicker: "Satélites en vivo · GOES-19, GPM, VIIRS, Sentinel-1 y Copernicus",
        titulo: "Monitoreo",
        sub: "Lo que está pasando ahora sobre Ecuador, con la resolución nativa de cada producto",
        acento: "var(--cyan)",
        inicial: "mapa",
        pestanas: [
          { id: "mapa", etiqueta: "Mapa en vivo", render: tabMapa, alSalir: limpiar },
          { id: "productos", etiqueta: "Productos y fuentes", render: async c => {
            E.cat = E.cat || await App.api("/monitoreo/catalogo"); await cargarCalculados(); tabProductos(c); } },
        ],
      });
    },
  });

  // Superficie pura para las pruebas Node (tiempo y parámetros de cada proveedor).
  if (typeof module === "object" && module.exports) module.exports = Object.freeze({
    duracionMs, expandirDominio, parametroTiempo, instantesWms,
  });
})();
