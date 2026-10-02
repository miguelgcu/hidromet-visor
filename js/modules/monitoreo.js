/* ============================================================
   Monitoreo — productos satelitales en vivo sobre un mapa Leaflet:
   GOES-19 cada 10 min, lluvia GPM IMERG, inundación Sentinel-1 (GFM) y
   VIIRS, incendios, temperatura del mar, humedad del suelo e imagen diaria,
   más lo que calcula HidroMet (lluvia acumulada GOES, sondeos, rayos, focos).
   Catálogo: /api/monitoreo/catalogo (app/modulos/monitoreo/catalogo.py).
   Las imágenes en vivo NO pasan por HidroMet: el navegador las pide al
   proveedor (NASA GIBS, Copernicus), igual en el escritorio y en el visor.

   UNA ANIMACIÓN, NO UNA SUCESIÓN DE FOTOS (2026-10-02)
     La primera versión cambiaba los mosaicos cada 650 ms y se veían fotos una
     detrás de otra. Ahora, como en el monitor hidrometeorológico, la capa que
     se anima (GOES-19 o IMERG) tiene UN lienzo: cada cuadro es una sola imagen
     de toda la caja (WMS de GIBS, resolución nativa), todos se decodifican antes
     de empezar y un bucle a la frecuencia de la pantalla funde cada cuadro con
     el siguiente: se sostiene un instante y se disuelve, y las nubes se ven
     desplazarse. Una pausa en el último, que es el que importa.
   ============================================================ */
"use strict";

(() => {
  const esc = v => String(v ?? "").replace(/[&<>"']/g,
    c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const CLAVE_LOCAL = "hm-monitoreo";
  const ZONA = "America/Guayaquil";
  const MS = { M: 60e3, H: 3600e3, D: 86400e3 };
  const ANIM_INICIAL = "goes_geocolor";
  // Ritmo de la animación (los mismos del monitor hidrometeorológico)
  const MS_CUADRO = 280;        // lo que dura cada cuadro, fundido incluido
  const SOSTEN = 0.4;           // parte del cuadro que se ve quieto antes de fundirse
  const PAUSA_FIN = 1400;       // se detiene en el último cuadro
  const REFRESCO = 5 * MS.M;    // cada cuánto se mira si el proveedor tiene un cuadro nuevo
  const ANCHO_MAX = 2600;       // tope de píxeles por cuadro (la caja a 1 km mide ≈ 2.500)
  const R_TIERRA = 6378137;

  const E = {
    cat: null, mapa: null, base: null, etiquetas: null, limites: null, baseId: null,
    anim: null,           // la capa animada: {p, capa, cuadros, pos, raf, ultimo, pausa, dibujado, ...}
    capas: new Map(),     // capas superpuestas: id -> {p, capa, instantes, i, opacidad, errores}
    leyendaAbierta: true,
    z: 10,
  };

  /* ---------------- preferencias del usuario (opcionales) ---------------- */
  function leerPrefs() {
    try { return JSON.parse(localStorage.getItem(CLAVE_LOCAL) || "{}") || {}; } catch (e) { return {}; }
  }
  // Una sola capa a la vez: se guarda cuál y con qué opacidad ("" = solo el mapa base).
  function guardarPrefs() {
    try {
      const a = E.anim || [...E.capas.values()][0] || null;
      localStorage.setItem(CLAVE_LOCAL, JSON.stringify({
        base: E.baseId, capa: a ? a.p.id : "", opacidad: a ? a.opacidad : undefined,
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
  const soloHora = d => d.toLocaleTimeString("es-EC", { timeZone: ZONA, hour: "2-digit", minute: "2-digit", hour12: false });
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
  const esAnimable = p => !!p.animable;

  function rotuloTiempo(p, t) {
    if (esCalculado(p)) return rotuloCalculado(p);
    if (p.tiempo === "rango30") return "últimos 30 días";
    if (!t) return "lo más reciente del proveedor";
    if (p.tipo === "gibs" && !esDiario(p)) return `${horaLocal(t)} · ${hace(t)}`;
    return t.toLocaleDateString("es-EC", { timeZone: "UTC", weekday: "short", day: "2-digit", month: "short", year: "numeric" });
  }

  /* ---------------- animación: cuadros de una caja en Web Mercator ---------------- */
  const mercX = lon => R_TIERRA * lon * Math.PI / 180;
  const mercY = lat => R_TIERRA * Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360));

  // Caja de la animación en metros Mercator y su tamaño en píxeles a la resolución del producto.
  function cajaMercator(limites, resM, anchoMax = ANCHO_MAX) {
    const [o, s, e, n] = limites;
    const x0 = mercX(o), x1 = mercX(e), y0 = mercY(s), y1 = mercY(n);
    const ancho = Math.min(anchoMax, Math.max(64, Math.round((x1 - x0) / resM)));
    const alto = Math.max(32, Math.round(ancho * (y1 - y0) / (x1 - x0)));
    return { x0, y0, x1, y1, ancho, alto };
  }

  function urlCuadro(p, t, caja) {
    const q = [
      "SERVICE=WMS", "VERSION=1.1.1", "REQUEST=GetMap", `LAYERS=${encodeURIComponent(p.capa)}`, "STYLES=",
      "SRS=EPSG:3857", `BBOX=${caja.x0.toFixed(0)},${caja.y0.toFixed(0)},${caja.x1.toFixed(0)},${caja.y1.toFixed(0)}`,
      `WIDTH=${caja.ancho}`, `HEIGHT=${caja.alto}`, `FORMAT=${encodeURIComponent(p.formato || "image/png")}`,
      `TRANSPARENT=${p.opaco ? "FALSE" : "TRUE"}`, `TIME=${isoMin(t)}`,
    ];
    return `${p.wms}?${q.join("&")}`;
  }

  // Posición del bucle → cuadro de abajo (k), el de encima (j) y su opacidad (suavizado smoothstep).
  function fundido(pos, listos, animando) {
    const n = listos.length;
    if (!n) return null;
    let k = Math.min(n - 1, Math.max(0, Math.floor(pos)));
    while (k > 0 && !listos[k]) k--;
    if (!listos[k]) return null;
    let j = null, f = 0;
    if (animando) {
      const r = pos - Math.floor(pos);
      if (r > SOSTEN) {
        let jj = k + 1;
        while (jj < n && !listos[jj]) jj++;
        if (jj < n) { j = jj; const u = (r - SOSTEN) / (1 - SOSTEN); f = u * u * (3 - 2 * u); }
      }
    }
    return { k, j, f };
  }

  // Capa Leaflet con un <canvas> en lugar de un <img>: se posiciona y escala con el mapa como
  // cualquier imagen georreferenciada, y el navegador la suaviza al acercar (no se pixela).
  const CapaLienzo = (typeof L === "object" && L.ImageOverlay) ? L.ImageOverlay.extend({
    _initImage() {
      const cv = this._image = L.DomUtil.create("canvas",
        "leaflet-image-layer mon-lienzo" + (this._zoomAnimated ? " leaflet-zoom-animated" : ""));
      cv.width = 2; cv.height = 2;
      cv.onselectstart = L.Util.falseFn;
      cv.onmousemove = L.Util.falseFn;
      if (this.options.zIndex != null) this._updateZIndex();
      this.fire("load");
    },
  }) : null;

  function dibujar() {
    const A = E.anim;
    if (!A || !A.capa) return;
    const listos = A.cuadros.map(c => c.listo);
    const d = fundido(A.pos, listos, !!A.raf);
    if (!d) { pintarControl(); return; }
    const clave = d.k + "|" + (d.j != null ? Math.round(d.f * 40) : 0);
    if (clave === A.dibujado) return;
    A.dibujado = clave;
    const cv = A.capa.getElement && A.capa.getElement();
    const ia = A.cuadros[d.k].img;
    if (!cv || !ia) return;
    if (cv.width !== ia.naturalWidth || cv.height !== ia.naturalHeight) { cv.width = ia.naturalWidth; cv.height = ia.naturalHeight; }
    const ctx = cv.getContext("2d");
    ctx.clearRect(0, 0, cv.width, cv.height);   // la lluvia es transparente: sin borrar, cada cuadro se sumaría al anterior
    ctx.globalAlpha = 1;
    ctx.drawImage(ia, 0, 0, cv.width, cv.height);
    if (d.j != null && d.f > 0) {
      ctx.globalAlpha = d.f;
      ctx.drawImage(A.cuadros[d.j].img, 0, 0, cv.width, cv.height);
      ctx.globalAlpha = 1;
    }
    A.visible = d.f > 0.5 && d.j != null ? d.j : d.k;
    pintarHora();
  }

  function pararAnim() {
    const A = E.anim;
    if (!A) return;
    if (A.raf) cancelAnimationFrame(A.raf);
    A.raf = null;
    A.dibujado = null;
    pintarBotonPlay();
  }

  function animar() {
    const A = E.anim;
    if (!A || A.raf || A.cuadros.filter(c => c.listo).length < 2) return;
    A.ultimo = 0; A.pausa = 0;
    if (A.pos >= A.cuadros.length - 1) A.pos = 0;
    const paso = ts => {
      if (!E.anim || E.anim !== A || !A.raf) return;
      const dt = A.ultimo ? Math.min(100, ts - A.ultimo) : 0;
      A.ultimo = ts;
      const fin = A.cuadros.length - 1;
      if (A.pausa) { if (ts >= A.pausa) { A.pausa = 0; A.pos = 0; } }
      else {
        A.pos += dt / MS_CUADRO;
        if (A.pos >= fin) { A.pos = fin; A.pausa = ts + PAUSA_FIN; }
      }
      dibujar();
      A.raf = requestAnimationFrame(paso);
    };
    A.raf = requestAnimationFrame(paso);
    pintarBotonPlay();
  }

  function irA(k) {
    const A = E.anim;
    if (!A || !A.cuadros.length) return;
    pararAnim();
    A.pos = Math.max(0, Math.min(A.cuadros.length - 1, k));
    dibujar();
  }

  function cargarCuadro(A, c) {
    return new Promise(res => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        const listo = () => { c.img = img; c.listo = true; res(); };
        (img.decode ? img.decode() : Promise.resolve()).then(listo, listo);
      };
      img.onerror = () => { c.fallo = true; res(); };
      img.src = urlCuadro(A.p, c.t, A.caja);
    });
  }

  async function activarAnim(id, opacidad) {
    desactivarAnim();
    const p = E.cat.productos.find(x => x.id === id && esAnimable(x));
    if (!p || !E.mapa) { pintarPanel(); pintarControl(); guardarPrefs(); return; }
    const caja = cajaMercator(E.cat.limites_animacion || E.cat.limites, p.res_m || 1000);
    const [o, s, e, n] = E.cat.limites_animacion || E.cat.limites;
    const A = E.anim = {
      p, caja, cuadros: [], pos: 0, raf: null, ultimo: 0, pausa: 0, dibujado: null, visible: 0,
      opacidad: opacidad ?? p.opacidad ?? 0.9, cargando: true, aviso: "",
    };
    A.capa = new CapaLienzo("", [[s, o], [n, e]], {
      pane: "mon-anim", opacity: A.opacidad, interactive: false, zIndex: 1,
      attribution: esc(p.atribucion || ""),
    }).addTo(E.mapa);
    if (p.suavizar_m) {
      A.alZoom = () => suavizarLienzo(A);
      E.mapa.on("zoomend", A.alZoom);
      suavizarLienzo(A);
    }
    pintarPanel(); pintarControl(); guardarPrefs();
    let instantes = [];
    try { instantes = await instantesGibs(p); } catch (err) { instantes = []; }
    if (E.anim !== A) return;
    if (!instantes.length) {
      A.cargando = false;
      A.aviso = "el proveedor no tiene imágenes en esta ventana o no respondió";
      pintarControl();
      return;
    }
    A.cuadros = instantes.map(t => ({ t, img: null, listo: false, fallo: false }));
    A.pos = A.cuadros.length - 1;
    pintarControl();
    // el último primero: es el que se ve mientras llegan los demás
    const orden = [A.cuadros.length - 1, ...A.cuadros.map((_, i) => i).slice(0, -1)];
    let arrancada = false;
    await Promise.all(orden.map(async i => {
      await cargarCuadro(A, A.cuadros[i]);
      if (E.anim !== A) return;
      A.dibujado = null;
      dibujar();
      pintarControl();
      // arranca en cuanto hay casi todo: esperar al último cuadro no aporta
      const listos = A.cuadros.filter(c => c.listo).length;
      if (!arrancada && listos >= Math.max(2, Math.ceil(A.cuadros.length * 0.7))) { arrancada = true; animar(); }
    }));
    if (E.anim !== A) return;
    A.cargando = false;
    const fallidos = A.cuadros.filter(c => c.fallo).length;
    A.aviso = fallidos ? `${fallidos} de ${A.cuadros.length} imágenes no llegaron` : "";
    if (!arrancada) animar();
    pintarControl();
    A.refresco = setInterval(() => refrescarAnim(A), REFRESCO);
  }

  // Cuadro nuevo en el proveedor: se suma al final y sale el más viejo (la ventana se mantiene).
  async function refrescarAnim(A) {
    if (E.anim !== A || document.hidden) return;
    let instantes = [];
    try { instantes = await instantesGibs(A.p); } catch (e) { return; }
    const ultimo = A.cuadros.length ? A.cuadros[A.cuadros.length - 1].t.getTime() : 0;
    const nuevos = instantes.filter(t => t.getTime() > ultimo);
    for (const t of nuevos) {
      const c = { t, img: null, listo: false, fallo: false };
      await cargarCuadro(A, c);
      if (E.anim !== A) return;
      if (!c.listo) continue;
      const enElUltimo = A.pos >= A.cuadros.length - 1;
      A.cuadros.push(c);
      while (A.cuadros.length > instantes.length && A.cuadros.length > 2) { A.cuadros.shift(); A.pos = Math.max(0, A.pos - 1); }
      if (enElUltimo && !A.raf) A.pos = A.cuadros.length - 1;
      A.dibujado = null;
      dibujar();
    }
    pintarControl();
  }

  // Productos de píxel grueso (IMERG, 11 km): difuminado en pantalla proporcional a ese píxel, para que
  // la lluvia se vea como un campo y no como cuadros. Solo cambia el dibujo, no el dato.
  function suavizarLienzo(A) {
    const cv = A.capa && A.capa.getElement && A.capa.getElement();
    if (!cv || !E.mapa) return;
    const mPorPx = 156543.03 / Math.pow(2, E.mapa.getZoom());          // en el ecuador, Web Mercator
    const px = Math.min(40, 0.45 * A.p.suavizar_m / mPorPx);
    cv.style.filter = px >= 0.8 ? `blur(${px.toFixed(1)}px)` : "";
  }

  function desactivarAnim() {
    const A = E.anim;
    if (!A) return;
    if (A.alZoom && E.mapa) E.mapa.off("zoomend", A.alZoom);
    if (A.raf) cancelAnimationFrame(A.raf);
    if (A.refresco) clearInterval(A.refresco);
    if (A.capa && E.mapa) E.mapa.removeLayer(A.capa);
    E.anim = null;
  }

  /* ---------------- capas superpuestas ---------------- */
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

  // Funde la opacidad de una capa hacia «hasta» en «ms» (cambio de día sin salto).
  function fundirOpacidad(capa, desde, hasta, ms) {
    return new Promise(res => {
      if (!capa || !capa.setOpacity) { res(); return; }
      const t0 = performance.now();
      const paso = ts => {
        const u = Math.min(1, (ts - t0) / ms);
        capa.setOpacity(desde + (hasta - desde) * u * u * (3 - 2 * u));
        if (u < 1) requestAnimationFrame(paso); else res();
      };
      requestAnimationFrame(paso);
    });
  }

  // Cambia el día/instante de una capa superpuesta: la nueva entra fundiéndose y la vieja sale.
  function ponerInstante(a, i) {
    if (!a.instantes.length) return Promise.resolve();
    a.i = Math.max(0, Math.min(a.instantes.length - 1, i));
    const vieja = a.capa;
    const nueva = crearCapa(a.p, a.instantes[a.i], vieja ? 0 : a.opacidad);
    a.errores = 0;
    nueva.on("tileerror", () => { a.errores++; pintarLeyendas(); });
    a.capa = nueva;
    nueva.addTo(E.mapa);
    pintarLeyendas();
    return new Promise(res => {
      let hecho = false;
      const fin = async () => {
        if (hecho) return; hecho = true;
        if (vieja) {
          await fundirOpacidad(nueva, 0, a.opacidad, 350);
          if (E.mapa) E.mapa.removeLayer(vieja);
        }
        res();
      };
      nueva.once("load", fin);
      setTimeout(fin, 8000);   // un mosaico que no llega no deja la capa a medias
    });
  }

  async function activarCapa(id, opacidad) {
    const p = E.cat.productos.find(x => x.id === id);
    if (!p || E.capas.has(id) || esAnimable(p)) return;
    const a = { p, capa: null, instantes: [], i: 0, opacidad: opacidad ?? p.opacidad ?? 0.85, errores: 0, cargando: true };
    E.capas.set(id, a);
    pintarPanel(); pintarLeyendas();
    try {
      a.instantes = p.tipo === "gibs" ? await instantesGibs(p) : p.tipo === "wms" ? instantesWms(p) : [null];
    } catch (e) {
      a.instantes = [];
      a.avisoTiempo = "no se pudo consultar la lista de fechas; se muestra lo más reciente";
    }
    if (!E.capas.has(id)) return;   // la desactivaron mientras llegaba la lista
    if (!a.instantes.length) a.instantes = [null];
    let k = a.instantes.length - 1;
    // NASA pone el día de hoy en la lista antes de que el satélite pase sobre Ecuador
    // (2026-10-02: VIIRS de hoy 0 % lleno, ayer 100 %): se mide y, si no cubre, se usa el anterior.
    if (p.tipo === "gibs" && esDiario(p) && k >= 1) {
      const [cu, ca] = await Promise.all([coberturaGibs(p, a.instantes[k]), coberturaGibs(p, a.instantes[k - 1])]);
      if (!E.capas.has(id)) return;
      if (cu !== null && ca !== null && ca > 0.02 && cu < 0.5 * ca) {
        k -= 1;
        a.nota = "La imagen del día más reciente todavía no cubre Ecuador: se muestra la del día anterior.";
      }
    }
    a.cargando = false;
    await ponerInstante(a, k);
    pintarPanel(); guardarPrefs();
  }

  function desactivarCapa(id) {
    const a = E.capas.get(id);
    if (!a) return;
    if (a.capa && E.mapa) E.mapa.removeLayer(a.capa);
    E.capas.delete(id);
    pintarPanel(); pintarLeyendas(); guardarPrefs();
  }

  // UNA capa a la vez (pedido del dueño, 2026-10-02: «no quiero bandas sobre otras
  // bandas; es una u otra»). Elegir un producto apaga el que hubiera, animado o no;
  // tocar el que ya está activo lo apaga y deja solo el mapa base con Ecuador.
  function apagarTodo() {
    desactivarAnim();
    for (const [id, a] of [...E.capas]) {
      if (a.capa && E.mapa) E.mapa.removeLayer(a.capa);
      E.capas.delete(id);
    }
  }
  function elegir(id, opacidad) {
    const p = E.cat && E.cat.productos.find(x => x.id === id);
    const yaActiva = (E.anim && E.anim.p.id === id) || E.capas.has(id);
    apagarTodo();
    if (!p || yaActiva) { pintarPanel(); pintarControl(); pintarLeyendas(); guardarPrefs(); return; }
    if (esAnimable(p)) activarAnim(id, opacidad);
    else { pintarControl(); activarCapa(id, opacidad); }
  }

  /* ---------------- paneles flotantes en la esquina libre ---------------- */
  function anillosDe(geo) {
    const out = [];
    for (const f of (geo.features || [geo])) {
      const g = f.geometry || f;
      // el contorno que publica el motor es un MultiLineString (cada borde, una línea cerrada):
      // cada línea sirve de anillo para la prueba par-impar
      const polys = g.type === "Polygon" || g.type === "MultiLineString" ? [g.coordinates]
        : g.type === "MultiPolygon" ? g.coordinates : g.type === "LineString" ? [[g.coordinates]] : [];
      for (const poly of polys) for (const r of poly) out.push(r);
    }
    return out;
  }
  function dentroDe(anillos, x, y) {   // par-impar sobre todos los anillos: respeta los huecos
    let dentro = false;
    for (const r of anillos) {
      for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
        const xi = r[i][0], yi = r[i][1], xj = r[j][0], yj = r[j][1];
        if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) dentro = !dentro;
      }
    }
    return dentro;
  }
  const ESQUINAS = ["ii", "si", "sd", "id"];
  function rectEsquina(esq, w, h, W, H) {
    if (esq === "ii") return [10, H - 24 - h, 10 + w, H - 24];
    if (esq === "si") return [52, 10, 52 + w, 10 + h];
    if (esq === "sd") return [W - 10 - w, 40, W - 10, 40 + h];
    return [W - 10 - w, H - 24 - h, W - 10, H - 24];
  }
  function paisBajo(r) {
    if (!E.contorno || !E.mapa) return 0;
    let n = 0;
    for (let i = 0; i < 12; i++) for (let j = 0; j < 8; j++) {
      const ll = E.mapa.containerPointToLatLng([r[0] + (r[2] - r[0]) * (i + 0.5) / 12, r[1] + (r[3] - r[1]) * (j + 0.5) / 8]);
      if (dentroDe(E.contorno, ll.lng, ll.lat)) n++;
    }
    return n / 96;
  }
  function ubicarControles() {
    if (E.ubicando) return;
    E.ubicando = requestAnimationFrame(() => {
      E.ubicando = 0;
      const caja = document.querySelector(".mon-mapa-caja");
      if (!caja || !E.mapa) return;
      const W = caja.clientWidth, H = caja.clientHeight, usadas = new Set();
      for (const id of ["mon-ctl", "mon-leyenda"]) {
        const el = document.getElementById(id);
        if (!el || el.hidden || !el.offsetWidth) continue;
        let mejor = null;
        for (const esq of ESQUINAS) {
          if (usadas.has(esq)) continue;
          const t = paisBajo(rectEsquina(esq, el.offsetWidth, el.offsetHeight, W, H));
          if (!mejor || t < mejor.t - 0.005) mejor = { esq, t };
        }
        if (mejor) { usadas.add(mejor.esq); el.dataset.esq = mejor.esq; }
      }
    });
  }
  // Fracción de píxeles con dato en las dos teselas (z ≤ 5) que cubren Ecuador; null si no se pudo medir.
  function coberturaGibs(p, t) {
    const z = Math.min(5, p.nivel || 5), n = 2 ** z;
    const tx = (lon) => Math.floor(((lon + 180) / 360) * n);
    const ty = (lat) => Math.floor((1 - Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) / Math.PI) / 2 * n);
    const teselas = [...new Set([tx(-80.5), tx(-77)])].map(x => [x, ty(-1.5)]);
    const una = ([x, y]) => new Promise(res => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      const fin = v => { clearTimeout(reloj); res(v); };
      const reloj = setTimeout(() => fin(null), 7000);
      img.onload = () => {
        try {
          const cv = document.createElement("canvas"); cv.width = cv.height = 64;
          const g = cv.getContext("2d"); g.drawImage(img, 0, 0, 64, 64);
          const d = g.getImageData(0, 0, 64, 64).data; let lleno = 0;
          for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 8 && d[i] + d[i + 1] + d[i + 2] > 6) lleno++;
          fin(lleno / 4096);
        } catch (e) { fin(null); }
      };
      img.onerror = () => fin(0);
      img.src = `${p.url}/${p.capa}/default/${parametroTiempo(p, t)}/GoogleMapsCompatible_Level${p.nivel}/${z}/${y}/${x}.${p.ext || "png"}`;
    });
    return Promise.all(teselas.map(una)).then(v => (v.some(x => x === null) ? null : v.reduce((a, b) => a + b, 0) / v.length));
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
    const animId = E.anim ? E.anim.p.id : "";
    caja.innerHTML = E.cat.grupos.map(g => {
      const prods = E.cat.productos.filter(p => p.grupo === g.id);
      return `<section class="mon-grupo"><h3>${esc(g.nombre)}<small>${esc(g.sub)}</small></h3>${prods.map(p => {
        const anim = esAnimable(p);
        const a = anim ? (animId === p.id ? E.anim : null) : E.capas.get(p.id);
        return `<div class="mon-prod${a ? " activa" : ""}" data-id="${p.id}">
          <label><input type="radio" name="mon-capa" ${a ? "checked" : ""} data-elegir="${p.id}">
            <span class="nom">${esc(p.nombre)}${anim ? ` <i class="mon-anima" title="Se anima">▶</i>` : ""}</span>
            <span class="res">${esc(p.resolucion)}</span></label>
          <button class="mon-info" data-info="${p.id}" title="Qué es y cómo leerlo" aria-label="Ficha de ${esc(p.nombre)}">i</button>
        </div>`;
      }).join("")}</section>`;
    }).join("");
    // una sola capa: tocar otra la cambia; tocar la activa la apaga
    caja.querySelectorAll("[data-elegir]").forEach(c => c.onclick = () => elegir(c.dataset.elegir));
    caja.querySelectorAll("[data-info]").forEach(b => b.onclick = () => mostrarFicha(b.dataset.info));
  }

  function mostrarFicha(id) {
    const p = E.cat.productos.find(x => x.id === id);
    const caja = document.getElementById("mon-ficha");
    if (!p || !caja) return;
    caja.innerHTML = `<button class="mon-cerrar" aria-label="Cerrar">×</button>${fichaHTML(p)}`;
    caja.hidden = false;
    caja.querySelector(".mon-cerrar").onclick = () => { caja.hidden = true; };
  }

  /* --- control compacto de la animación (en la esquina libre del mapa, ver ubicarControles) --- */
  // Leyenda de GIBS; «leyenda_recorte» deja solo la parte de arriba (IMERG trae también la escala de nieve).
  function imgLeyenda(p, clase) {
    const img = `<img class="${clase}" src="${esc(p.leyenda)}" alt="Escala de ${esc(p.nombre)}" loading="lazy">`;
    return p.leyenda_recorte
      ? `<div class="mon-ley-recorte" style="aspect-ratio:378/${Math.round(176 * p.leyenda_recorte)}">${img}</div>` : img;
  }

  function escalaAnim(p) {
    if (p.leyenda) return imgLeyenda(p, "mon-ctl-ley");
    if (p.claves) return `<div class="mon-ctl-claves">${p.claves.map(([c, t]) =>
      `<span><i style="background:${esc(c)}"></i>${esc(t)}</span>`).join("")}</div>`;
    return "";
  }

  function pintarControl() {
    const caja = document.getElementById("mon-ctl");
    if (!caja || !E.cat) return;
    const A = E.anim;
    const opciones = E.cat.productos.filter(esAnimable)
      .map(p => `<option value="${p.id}" ${A && A.p.id === p.id ? "selected" : ""}>${esc(p.nombre)}</option>`).join("");
    if (E.ctlPlegado === undefined) E.ctlPlegado = !!(window.matchMedia && window.matchMedia("(max-width: 900px)").matches);
    caja.innerHTML = `<div class="mon-ctl-fila">
        <select id="mon-anim-sel" aria-label="Producto animado"><option value="">Sin animación</option>${opciones}</select>
        ${A ? `<button id="mon-play" class="mon-ctl-b" aria-label="Animar o detener"></button>
               <button id="mon-prev" class="mon-ctl-b" title="Anterior" aria-label="Imagen anterior">◀</button>
               <button id="mon-next" class="mon-ctl-b" title="Siguiente" aria-label="Imagen siguiente">▶</button>
               <b id="mon-hora" class="mon-ctl-hora">—</b>
               <button id="mon-ctl-mas" class="mon-ctl-b mon-ctl-mas" aria-expanded="${!E.ctlPlegado}" aria-label="Mostrar u ocultar el detalle">${E.ctlPlegado ? "▸" : "▾"}</button>` : ""}
      </div>
      ${A ? `<div id="mon-sub" class="mon-ctl-sub" ${E.ctlPlegado ? "hidden" : ""}></div>${E.ctlPlegado ? "" : escalaAnim(A.p)}` : ""}`;
    const mas = caja.querySelector("#mon-ctl-mas");
    if (mas) mas.onclick = () => { E.ctlPlegado = !E.ctlPlegado; pintarControl(); };
    ubicarControles();
    caja.querySelector("#mon-anim-sel").onchange = ev => {
      const id = ev.target.value;
      if (id) elegir(id); else { apagarTodo(); pintarPanel(); pintarControl(); pintarLeyendas(); guardarPrefs(); }
    };
    if (!A) return;
    caja.querySelector("#mon-play").onclick = () => { if (E.anim && E.anim.raf) pararAnim(); else animar(); };
    caja.querySelector("#mon-prev").onclick = () => irA(Math.round(E.anim.pos) - 1);
    caja.querySelector("#mon-next").onclick = () => irA(Math.round(E.anim.pos) + 1);
    pintarBotonPlay();
    pintarHora();
  }

  function pintarBotonPlay() {
    const b = document.getElementById("mon-play");
    if (!b || !E.anim) return;
    b.textContent = E.anim.raf ? "⏸" : "▶";
    b.title = E.anim.raf ? "Detener" : "Animar";
  }

  function pintarHora() {
    const A = E.anim;
    const h = document.getElementById("mon-hora");
    const sub = document.getElementById("mon-sub");
    if (!A) return;
    const n = A.cuadros.length;
    const listos = A.cuadros.filter(c => c.listo).length;
    const c = n ? A.cuadros[Math.max(0, Math.min(n - 1, A.visible ?? Math.round(A.pos)))] : null;
    if (h) h.textContent = c ? soloHora(c.t) : "—";
    if (!sub) return;
    const partes = [];
    if (c) partes.push(hace(c.t), `${(A.visible ?? 0) + 1}/${n}`);
    if (A.cargando && n) partes.push(`cargando ${listos} de ${n} imágenes`);
    else if (A.cargando) partes.push("consultando imágenes disponibles…");
    partes.push(A.p.resolucion, A.p.satelite);
    if (A.aviso) partes.push(A.aviso);
    sub.textContent = partes.filter(Boolean).join(" · ");
  }

  /* --- leyendas de las capas superpuestas (abajo a la derecha, plegables) --- */
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
    return n + `<div class="mon-sws">${tramos.map(([c, e]) => `<span class="mon-sw"><i style="background:${c};border-radius:50%"></i>${e}</span>`).join("")}</div>`;
  }

  function pintarLeyendas() {
    const caja = document.getElementById("mon-leyenda");
    if (!caja) return;
    const capas = [...E.capas.values()].reverse();
    if (!capas.length) { caja.hidden = true; ubicarControles(); return; }
    caja.hidden = false;
    const cuerpo = capas.map(a => {
      const p = a.p;
      const t = a.instantes.length ? a.instantes[a.i] : null;
      const ley = p.tramos ? leyendaTramos(p)
        : p.tipo === "puntos" ? leyendaEdad(p)
        : p.leyenda ? imgLeyenda(p, "")
        : p.color_leyenda ? `<div class="mon-sw"><i style="background:${esc(p.color_leyenda)}"></i>${esc(p.nombre)}</div>`
        : `<div class="mon-rgb">Ver «Cómo leerlo» en la ficha (i).</div>`;
      const cob = p.cobertura && p.cobertura.archivos < p.cobertura.esperados
        ? `<div class="mon-fallo">Faltan ${p.cobertura.esperados - p.cobertura.archivos} de ${p.cobertura.esperados} archivos del periodo.</div>` : "";
      const fallos = (a.errores > 3 ? `<div class="mon-fallo">El proveedor no entregó parte de la imagen.</div>` : "") + cob;
      const dias = a.instantes.length > 1
        ? `<span class="mon-dias"><button data-dia="${p.id}" data-d="-1" ${a.i <= 0 ? "disabled" : ""} aria-label="Fecha anterior">◀</button>
           <button data-dia="${p.id}" data-d="1" ${a.i >= a.instantes.length - 1 ? "disabled" : ""} aria-label="Fecha siguiente">▶</button></span>` : "";
      return `<div class="mon-ley-item"><div class="mon-ley-tit">${esc(p.nombre)}${p.unidad ? ` <small>(${esc(p.unidad)})</small>` : ""}</div>
        <div class="mon-ley-t"><span>${a.cargando ? "…" : esc(rotuloTiempo(p, t))}</span>${dias}</div>${a.nota ? `<div class="mon-nota-capa">${esc(a.nota)}</div>` : ""}${ley}${fallos}</div>`;
    }).join("");
    caja.innerHTML = `<button class="mon-ley-cab" aria-expanded="${E.leyendaAbierta}">Capas (${capas.length}) ${E.leyendaAbierta ? "▾" : "▸"}</button>
      ${E.leyendaAbierta ? `<div class="mon-ley-cuerpo">${cuerpo}</div>` : ""}`;
    caja.querySelector(".mon-ley-cab").onclick = () => { E.leyendaAbierta = !E.leyendaAbierta; pintarLeyendas(); };
    caja.querySelectorAll("[data-dia]").forEach(b => b.onclick = () => {
      const a = E.capas.get(b.dataset.dia);
      if (a) { a.nota = ""; ponerInstante(a, a.i + Number(b.dataset.d)); }
    });
    ubicarControles();
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

  // Ecuador SIEMPRE a la vista, por encima de cualquier capa: provincias finas y el
  // borde nacional grueso, ambos con halo oscuro para leerse sobre cualquier color
  // (antes, una línea blanca de 0,9 px desaparecía bajo un campo intenso).
  async function ponerLimites() {
    let geo = null;
    try { geo = await App.api("/datos/capas/provincias.geojson"); } catch (e) { geo = null; }
    if (!E.mapa) return;
    const grupo = L.layerGroup().addTo(E.mapa);
    E.limites = grupo;
    if (geo) {
      L.geoJSON(geo, { pane: "mon-limites", interactive: false,
        style: { color: "#0A1220", weight: 2.6, opacity: 0.45, fill: false } }).addTo(grupo);
      L.geoJSON(geo, { pane: "mon-limites", interactive: false,
        style: { color: "#FFFFFF", weight: 0.9, opacity: 0.85, fill: false } }).addTo(grupo);
    }
    const c = E.calc && (E.calc.productos || []).find(p => p.tipo === "contorno");
    if (!c) return;
    let pais = null;
    try { pais = await (await fetch(urlArchivo(c.archivo))).json(); } catch (e) { pais = null; }
    if (!pais || !E.mapa || E.limites !== grupo) return;
    E.contorno = anillosDe(pais);
    ubicarControles();
    L.geoJSON(pais, { pane: "mon-limites", interactive: false,
      style: { color: "#0A1220", weight: 5.5, opacity: 0.55, fill: false, lineJoin: "round" } }).addTo(grupo);
    L.geoJSON(pais, { pane: "mon-limites", interactive: false,
      style: { color: "#FFFFFF", weight: 2, opacity: 1, fill: false, lineJoin: "round" } }).addTo(grupo);
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
        <p class="mon-nota">Una capa a la vez: elegir otra cambia la vista. ▶ = se anima. Las imágenes se piden en vivo a NASA y Copernicus, con su resolución nativa.</p>
      </aside>
      <div class="mon-mapa-caja">
        <div id="mon-mapa" class="mon-mapa" role="region" aria-label="Mapa de monitoreo"></div>
        <div id="mon-ctl" class="mon-ctl"></div>
        <div id="mon-leyenda" class="mon-leyenda" hidden></div>
        <div id="mon-ficha" class="mon-ficha" hidden></div>
      </div>
    </div>`;
    const [o, s, e, n] = E.cat.limites;
    E.mapa = L.map("mon-mapa", { zoomControl: true, worldCopyJump: false, minZoom: 4, maxZoom: 18,
                                 maxBounds: L.latLngBounds([s - 15, o - 25], [n + 15, e + 25]) })
      .setView(E.cat.vista_inicial.centro, E.cat.vista_inicial.zoom);
    for (const [nombre, z] of [["mon-base", 200], ["mon-anim", 300], ["mon-productos", 350], ["mon-limites", 420],
                               ["mon-etiquetas", 440], ["mon-puntos", 450]]) {
      const pane = E.mapa.createPane(nombre);
      pane.style.zIndex = z;
      if (nombre !== "mon-puntos") pane.style.pointerEvents = "none";
    }
    L.control.scale({ imperial: false, position: "topright" }).addTo(E.mapa);
    E.mapa.on("moveend zoomend resize", () => ubicarControles());
    const prefs = leerPrefs();
    ponerBase(prefs.base || baseSegunTema());
    document.getElementById("mon-base").onchange = ev => ponerBase(ev.target.value);
    const plegar = document.getElementById("mon-plegar");
    // en el celular el mapa va primero: el panel de capas y las leyendas arrancan plegados
    if (window.matchMedia && window.matchMedia("(max-width: 900px)").matches) {
      document.getElementById("mon-panel").classList.add("plegado");
      plegar.setAttribute("aria-expanded", "false");
      E.leyendaAbierta = false;
    }
    plegar.onclick = () => {
      const panel = document.getElementById("mon-panel");
      const abierto = !panel.classList.toggle("plegado");
      plegar.setAttribute("aria-expanded", String(abierto));
      setTimeout(() => E.mapa && E.mapa.invalidateSize(), 220);
    };
    pintarPanel();
    pintarControl();
    ponerLimites();
    // preferencia guardada: UNA capa. Las de versiones anteriores (animada + superpuestas)
    // se reducen a una: la animada si había, si no la primera superpuesta.
    let capa = prefs.capa, opacidad = prefs.opacidad;
    if (capa === undefined) {
      const viejas = Array.isArray(prefs.capas) ? prefs.capas : (Array.isArray(prefs.activas) ? prefs.activas : []);
      if (prefs.anim) { capa = prefs.anim; opacidad = prefs.animOpacidad; }
      else if (prefs.anim === undefined && !viejas.length) capa = ANIM_INICIAL;
      else if (viejas.length) { capa = viejas[0].id; opacidad = viejas[0].opacidad; }
    }
    if (capa && E.cat.productos.some(p => p.id === capa)) elegir(capa, opacidad);
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
        <td>${p.calculado ? "calculado por HidroMet" : esAnimable(p) ? "en vivo, animado" : "en vivo del proveedor"}</td>
        <td>${esc(p.satelite)}</td><td>${esc(p.resolucion)}</td><td>${esc(p.frecuencia)}</td>
        <td>${esc(p.latencia)}</td><td>${esc(p.que)}</td></tr>`).join("")}</tbody></table></div>
      <h3>En preparación</h3>
      <ul class="mon-pendientes">${(E.cat.pendientes || []).map(x => `<li><b>${esc(x.nombre)}</b> — ${esc(x.motivo)}</li>`).join("")}</ul>
    </div>`;
  }

  function limpiar() {
    desactivarAnim();
    if (E.mapa) { try { E.mapa.remove(); } catch (e) { /* ya retirado */ } }
    E.mapa = null; E.base = null; E.etiquetas = null; E.limites = null;
    E.capas.clear();
  }
  // al salir del módulo se olvida el índice calculado: al volver se lee el de la última actualización
  function salirModulo() { limpiar(); E.calc = null; E.cat = null; }

  document.addEventListener("temacambiado", () => {
    if (!E.mapa || !E.cat) return;
    const prefs = leerPrefs();
    if (!prefs.base || prefs.base === "oscuro" || prefs.base === "claro") ponerBase(baseSegunTema());
  });

  if (typeof App === "object" && App && App.registrar) App.registrar("monitoreo", {
    titulo: "Monitoreo", orden: 0.5,
    alDejar: salirModulo,
    async render(vista) {
      vista.dataset.screenLabel = "Monitoreo";
      vista.classList.add("vista-monitoreo");
      App.vistaPestanas(vista, {
        kicker: "Satélites en vivo · GOES-19, GPM, VIIRS, Sentinel-1 y Copernicus",
        titulo: "Monitoreo",
        sub: "Lo que está pasando ahora sobre Ecuador, con la resolución nativa de cada producto",
        inicial: "mapa",
        pestanas: [
          { id: "mapa", etiqueta: "Mapa en vivo", render: tabMapa, alSalir: limpiar },
          { id: "productos", etiqueta: "Productos y fuentes", render: async c => {
            E.cat = E.cat || await App.api("/monitoreo/catalogo"); await cargarCalculados(); tabProductos(c); } },
        ],
      });
    },
  });

  // Superficie pura para las pruebas Node (tiempo, cuadros y fundido).
  if (typeof module === "object" && module.exports) module.exports = Object.freeze({
    duracionMs, expandirDominio, parametroTiempo, instantesWms, cajaMercator, urlCuadro, fundido,
    MS_CUADRO, SOSTEN, PAUSA_FIN,
  });
})();
