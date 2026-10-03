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
  const MS_VUELTA = 900;        // el último se funde con el primero al reiniciar: nunca un salto
  const MS_CAMBIO = 450;        // fundido entre la capa que sale y la que entra
  // GIBS anuncia el instante antes de tener la imagen y entrega un cuadro NEGRO (2026-10-03:
  // 15:10 y 15:30 UTC vacíos, y la animación se detenía justo en ellos). Un cuadro opaco con
  // menos de esta fracción de píxeles con señal no entra en la animación.
  const CONTENIDO_MIN = 0.05;
  const REFRESCO = 5 * MS.M;    // cada cuánto se mira si el proveedor tiene un cuadro nuevo
  const ANCHO_MAX = 2600;       // tope de píxeles por cuadro (la caja a 1 km mide ≈ 2.500)
  const R_TIERRA = 6378137;

  const E = {
    cat: null, mapa: null, base: null, etiquetas: null, limites: null, baseId: null,
    anim: null,           // la capa animada: {p, capa, cuadros, pos, raf, ultimo, pausa, dibujado, ...}
    capas: new Map(),     // capas superpuestas: id -> {p, capa, instantes, i, opacidad, errores}
    variante: {},         // familia del menú -> variante elegida (lluvia 1–24 h, LHASA hoy/mañana)
    area: null, areaLimites: null,
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
        capa: a ? a.p.id : "", variantes: E.variante,
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

  const horaLocal = d => d.toLocaleString((App.locale ? App.locale() : "es-EC"), { timeZone: ZONA, weekday: "short", day: "2-digit", month: "short",
                                                     hour: "2-digit", minute: "2-digit", hour12: false });
  const soloHora = d => d.toLocaleTimeString((App.locale ? App.locale() : "es-EC"), { timeZone: ZONA, hour: "2-digit", minute: "2-digit", hour12: false });
  function hace(d) {
    const min = Math.round((Date.now() - d.getTime()) / MS.M);
    return min < 120 ? `hace ${min} min` : min < 2880 ? `hace ${Math.round(min / 60)} h` : `hace ${Math.round(min / 1440)} días`;
  }
  // Producto calculado por HidroMet: periodo que cubre y edad (se calcula en cada actualización).
  const diaCorto = d => d.toLocaleDateString((App.locale ? App.locale() : "es-EC"), { timeZone: ZONA, weekday: "short", day: "numeric", month: "short" });
  function rotuloCalculado(p) {
    if (!p.instante_utc) return "";
    const fin = new Date(p.instante_utc);
    if (!p.desde_utc) return `${diaCorto(fin)}, ${soloHora(fin)} · ${hace(fin)}`;
    const ini = new Date(p.desde_utc);
    return diaCorto(ini) === diaCorto(fin)
      ? `${diaCorto(fin)}, ${soloHora(ini)}–${soloHora(fin)} · ${hace(fin)}`
      : `${diaCorto(ini)} → ${diaCorto(fin)}, ${soloHora(fin)} · ${hace(fin)}`;
  }
  // Antigüedad de un producto diario (fecha de calendario): hoy, ayer o hace N días.
  function haceDias(t) {
    if (!t) return "";
    const dia = x => Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate());
    const loc = new Date(new Date().toLocaleString("en-US", { timeZone: ZONA }));
    const n = Math.round((Date.UTC(loc.getFullYear(), loc.getMonth(), loc.getDate()) - dia(t)) / MS.D);
    return n <= 0 ? "dato de hoy" : n === 1 ? "dato de ayer" : `dato de hace ${n} días`;
  }
  const esCalculado = p => p.tipo === "imagen" || p.tipo === "puntos";
  const esAnimable = p => !!p.animable;

  function rotuloTiempo(p, t) {
    if (esCalculado(p)) return rotuloCalculado(p);
    if (p.tiempo === "rango30") return "últimos 30 días";
    if (!t) return "lo más reciente del proveedor";
    if (p.tipo === "gibs" && !esDiario(p)) return `${horaLocal(t)} · ${hace(t)}`;
    return t.toLocaleDateString((App.locale ? App.locale() : "es-EC"), { timeZone: "UTC", weekday: "short", day: "2-digit", month: "short", year: "numeric" });
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
  // «vuelta» (0 a 1, o null): el bucle se está cerrando y el último cuadro se funde con el primero,
  // en vez de saltar de golpe al reiniciar.
  function fundido(pos, listos, animando, vuelta = null) {
    const n = listos.length;
    if (!n) return null;
    if (vuelta != null) {
      let ult = n - 1;
      while (ult > 0 && !listos[ult]) ult--;
      let pri = 0;
      while (pri < n - 1 && !listos[pri]) pri++;
      if (!listos[ult]) return null;
      if (pri === ult || !listos[pri]) return { k: ult, j: null, f: 0 };
      const u = Math.max(0, Math.min(1, vuelta));
      return { k: ult, j: pri, f: u * u * (3 - 2 * u) };
    }
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
    const d = fundido(A.pos, listos, !!A.raf, A.vuelta ? A.fVuelta : null);
    if (!d) { pintarControl(); return; }
    const clave = (A.vuelta ? "v" : "") + d.k + "|" + (d.j != null ? Math.round(d.f * 40) : 0);
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
    // la capa nueva entra fundiéndose con su primera imagen real; la que sale espera hasta aquí
    if (!A.mostrada) {
      A.mostrada = true;
      fundirOpacidad(A.capa, 0, A.opacidad, MS_CAMBIO);
      A.avisarPrimera();
    }
    pintarHora();
  }

  function pararAnim() {
    const A = E.anim;
    if (!A) return;
    if (A.raf) cancelAnimationFrame(A.raf);
    A.raf = null;
    A.vuelta = 0; A.fVuelta = 0;
    A.dibujado = null;
    pintarBotonPlay();
  }

  function animar() {
    const A = E.anim;
    if (!A || A.raf || A.cuadros.filter(c => c.listo).length < 2) return;
    A.ultimo = 0; A.pausa = 0; A.vuelta = 0; A.fVuelta = 0;
    if (A.pos >= A.cuadros.length - 1) A.pos = 0;
    const paso = ts => {
      if (!E.anim || E.anim !== A || !A.raf) return;
      const dt = A.ultimo ? Math.min(100, ts - A.ultimo) : 0;
      A.ultimo = ts;
      const fin = A.cuadros.length - 1;
      if (A.pausa) {
        // tras la pausa en el último, el bucle se cierra fundiéndose con el primero
        if (ts >= A.pausa) { A.pausa = 0; A.vuelta = ts; A.fVuelta = 0; }
      } else if (A.vuelta) {
        A.fVuelta = Math.min(1, (ts - A.vuelta) / MS_VUELTA);
        if (A.fVuelta >= 1) { A.vuelta = 0; A.fVuelta = 0; A.pos = 0; }
      } else {
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

  // Fracción de píxeles con señal (no negros ni transparentes) en una muestra pequeña del cuadro.
  function contenidoCuadro(img) {
    try {
      const cv = document.createElement("canvas");
      cv.width = 64; cv.height = 32;
      const g = cv.getContext("2d", { willReadFrequently: true });
      g.drawImage(img, 0, 0, 64, 32);
      const d = g.getImageData(0, 0, 64, 32).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 8 && d[i] + d[i + 1] + d[i + 2] > 30) n++;
      return n / 2048;
    } catch (e) { return null; }
  }

  function cargarCuadro(A, c) {
    return new Promise(res => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        const listo = () => {
          c.img = img;
          // un cuadro opaco sin señal es una imagen que el proveedor todavía no tenía:
          // no entra en el bucle y se vuelve a pedir en el próximo refresco
          const v = A.p.opaco ? contenidoCuadro(img) : null;
          c.vacio = v !== null && v < CONTENIDO_MIN;
          c.listo = !c.vacio;
          res();
        };
        (img.decode ? img.decode() : Promise.resolve()).then(listo, listo);
      };
      img.onerror = () => { c.fallo = true; res(); };
      img.src = urlCuadro(A.p, c.t, A.caja);
    });
  }

  // Activa la capa animada y devuelve una promesa que se cumple cuando su primera imagen REAL ya
  // está en pantalla: hasta entonces la capa anterior sigue visible (ver elegir y fundirSalida).
  function activarAnim(id, opacidad) {
    const p = E.cat.productos.find(x => x.id === id && esAnimable(x));
    if (!p || !E.mapa) { pintarPanel(); pintarControl(); guardarPrefs(); return Promise.resolve(); }
    const caja = cajaMercator(E.cat.limites_animacion || E.cat.limites, p.res_m || 1000);
    const [o, s, e, n] = E.cat.limites_animacion || E.cat.limites;
    let avisar = null;
    const primera = new Promise(r => { avisar = r; });
    const A = E.anim = {
      p, caja, cuadros: [], pos: 0, raf: null, ultimo: 0, pausa: 0, vuelta: 0, fVuelta: 0, dibujado: null,
      visible: 0, opacidad: opacidad ?? p.opacidad ?? 0.9, cargando: true, aviso: "", mostrada: false,
      avisarPrimera: () => { if (avisar) { avisar(); avisar = null; } },
    };
    A.capa = new CapaLienzo("", [[s, o], [n, e]], {
      pane: "mon-anim", opacity: 0, interactive: false, zIndex: 1,
      attribution: esc(p.atribucion || ""),
    }).addTo(E.mapa);
    if (p.suavizar_m) {
      A.alZoom = () => suavizarLienzo(A);
      E.mapa.on("zoomend", A.alZoom);
      suavizarLienzo(A);
    }
    pintarPanel(); pintarControl(); guardarPrefs();
    cargarAnim(A);
    return primera;
  }

  async function cargarAnim(A) {
    const p = A.p;
    let instantes = [];
    try { instantes = await instantesGibs(p); } catch (err) { instantes = []; }
    if (E.anim !== A) return;
    if (!instantes.length) {
      A.cargando = false;
      A.aviso = "el proveedor no tiene imágenes en esta ventana o no respondió";
      A.avisarPrimera();
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
    const total = A.cuadros.length;
    const fallidos = A.cuadros.filter(c => c.fallo).length;
    // El bucle recorre solo imágenes reales: fuera las vacías y las que no llegaron, sin mover
    // el cuadro que se está viendo (los vacíos suelen ser los más recientes, al final).
    const quedan = [];
    let nuevaPos = 0;
    A.cuadros.forEach((c, i) => {
      if (!c.listo) return;
      if (i <= Math.floor(A.pos)) nuevaPos = quedan.length;
      quedan.push(c);
    });
    if (quedan.length && quedan.length < total) {
      A.cuadros = quedan;
      A.pos = Math.min(nuevaPos + (A.pos % 1), quedan.length - 1);
      A.dibujado = null;
    }
    if (!quedan.length) A.avisarPrimera();
    // solo se avisa si falta una parte importante: un par de imágenes que tardan no es noticia
    A.aviso = fallidos > total * 0.3 ? `${fallidos} de ${total} imágenes no llegaron` : "";
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
    // siempre entra desde transparente: la primera vez también se funde, sin aparecer de golpe
    const nueva = crearCapa(a.p, a.instantes[a.i], 0);
    a.errores = 0;
    nueva.on("tileerror", () => { a.errores++; pintarLeyendas(); });
    a.capa = nueva;
    nueva.addTo(E.mapa);
    pintarLeyendas();
    return new Promise(res => {
      let hecho = false;
      const fin = async () => {
        if (hecho) return; hecho = true;
        await fundirOpacidad(nueva, 0, a.opacidad, vieja ? 350 : MS_CAMBIO);
        if (vieja && E.mapa) E.mapa.removeLayer(vieja);
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
    suavizarPanel();
    const listo = ponerInstante(a, k);
    pintarPanel(); pintarReproductor(); guardarPrefs();
    await listo;
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
  // Suelta las capas activas SIN quitarlas del mapa: siguen visibles (quietas) hasta que la
  // nueva tenga imagen. Nunca queda el mapa vacío entre una capa y otra.
  function soltarTodo() {
    const viejas = [];
    const A = E.anim;
    if (A) {
      if (A.raf) cancelAnimationFrame(A.raf);
      if (A.refresco) clearInterval(A.refresco);
      if (A.alZoom && E.mapa) E.mapa.off("zoomend", A.alZoom);
      if (A.capa) viejas.push(A.capa);
      E.anim = null;
    }
    for (const [id, a] of [...E.capas]) {
      if (a.capa) viejas.push(a.capa);
      E.capas.delete(id);
    }
    return viejas;
  }
  function fundirSalida(viejas) {
    for (const capa of viejas) {
      const desde = capa.options && capa.options.opacity != null ? capa.options.opacity : 1;
      fundirOpacidad(capa, desde, 0, MS_CAMBIO).then(() => {
        if (E.mapa && E.mapa.hasLayer(capa)) E.mapa.removeLayer(capa);
      });
    }
  }
  function elegir(id, opacidad) {
    const p = E.cat && E.cat.productos.find(x => x.id === id);
    const yaActiva = (E.anim && E.anim.p.id === id) || E.capas.has(id);
    const viejas = soltarTodo();
    if (!p || yaActiva) { fundirSalida(viejas); pintarPanel(); pintarControl(); pintarLeyendas(); guardarPrefs(); return; }
    const lista = esAnimable(p) ? activarAnim(id, opacidad) : activarCapa(id, opacidad);
    if (!esAnimable(p)) pintarControl();
    // la que sale se funde cuando la nueva ya se ve (o a los 6 s, si el proveedor no responde)
    Promise.race([lista, new Promise(r => setTimeout(r, 6000))]).then(() => fundirSalida(viejas));
  }

  /* ---------------- cobertura de un día de GIBS ---------------- */
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

  /* ---------------- menú: un tema por grupo, una fila por producto o familia ---------------- */
  // Fila del menú que contiene el producto «id» (y su variante, si la fila es una familia).
  function filaDe(id) {
    for (const m of (E.cat && E.cat.menu) || []) {
      for (const it of m.items) {
        if (it.id === id) return { it, grupo: m.grupo, variante: null };
        if (it.variantes && it.variantes.some(v => v[0] === id)) return { it, grupo: m.grupo, variante: id };
      }
    }
    return null;
  }
  function idActivo() {
    if (E.anim) return E.anim.p.id;
    return E.capas.size ? [...E.capas.keys()][0] : "";
  }
  function nombreDe(id) {
    const f = filaDe(id);
    const p = E.cat && E.cat.productos.find(x => x.id === id);
    return (f && f.it.nombre) || (p && p.nombre) || id;
  }
  function rotuloVariante(id) {
    const f = filaDe(id);
    if (!f || !f.variante) return "";
    const v = f.it.variantes.find(x => x[0] === id);
    return v ? v[1] : "";
  }
  function metaDe(p) {
    if (!p) return "";
    const frec = String(p.frecuencia || "").replace(/^cada actualización de HidroMet$/, "cada actualización");
    return [p.resolucion, frec].filter(Boolean).join(" · ");
  }
  // Variante que muestra una familia: la que eligió el usuario, si no la inicial.
  function varianteDe(it, presentes) {
    const pedida = E.variante[it.familia];
    if (pedida && presentes.includes(pedida)) return pedida;
    return presentes.includes(it.inicial) ? it.inicial : presentes[0];
  }

  function pintarPanel() {
    const caja = document.getElementById("mon-capas");
    if (!caja || !E.cat) return;
    const activo = idActivo();
    const grupos = Object.fromEntries(E.cat.grupos.map(g => [g.id, g]));
    const existe = id => E.cat.productos.some(p => p.id === id);
    caja.innerHTML = (E.cat.menu || []).map(m => {
      const g = grupos[m.grupo] || { nombre: m.grupo };
      const filas = m.items.map(it => {
        const ids = it.variantes ? it.variantes.map(v => v[0]) : [it.id];
        const presentes = ids.filter(existe);
        if (!presentes.length) return "";           // calculado que aún no existe en esta corrida
        const elegido = it.variantes ? varianteDe(it, presentes) : it.id;
        const p = E.cat.productos.find(x => x.id === elegido);
        const activa = ids.includes(activo);
        const nombre = it.nombre || p.nombre;
        const chips = it.variantes
          ? `<div class="mon-variantes" role="group" aria-label="${esc(nombre)}">${it.variantes.filter(v => presentes.includes(v[0])).map(([vid, et]) =>
              `<button type="button" class="mon-var${(activa ? activo : elegido) === vid ? " activa" : ""}" data-variante="${esc(vid)}"
                 data-familia="${esc(it.familia)}" aria-pressed="${(activa ? activo : elegido) === vid}">${esc(et)}</button>`).join("")}</div>`
          : "";
        return `<div class="mon-item${activa ? " activa" : ""}">
            <button type="button" class="mon-item-b" data-elegir="${esc(elegido)}" aria-pressed="${activa}">
              <span class="mon-radio" aria-hidden="true"></span>
              <span class="mon-item-txt"><span class="mon-item-nom">${esc(nombre)}</span>
                <span class="mon-item-meta">${esc(metaDe(p))}${esAnimable(p)
                  ? ` <span class="mon-anim-etq" title="Se anima con las imágenes de las últimas horas">animado</span>` : ""}</span></span>
            </button>
            <button type="button" class="mon-info" data-info="${esc(elegido)}" title="Qué es y cómo leerlo"
                    aria-label="Ficha de ${esc(nombre)}">i</button>
            ${chips}
          </div>`;
      }).join("");
      return filas.trim() ? `<section class="mon-grupo"><h3>${esc(g.nombre)}</h3>${filas}</section>` : "";
    }).join("");
    // una sola capa: tocar otra la cambia; tocar la activa la apaga
    caja.querySelectorAll("[data-elegir]").forEach(b => b.onclick = () => elegir(b.dataset.elegir));
    caja.querySelectorAll("[data-info]").forEach(b => b.onclick = () => mostrarFicha(b.dataset.info));
    caja.querySelectorAll("[data-variante]").forEach(b => b.onclick = () => {
      E.variante[b.dataset.familia] = b.dataset.variante;
      if (idActivo() !== b.dataset.variante) elegir(b.dataset.variante);
      else pintarPanel();
      guardarPrefs();
    });
    const etq = document.getElementById("mon-activa");
    if (etq) {
      const a = idActivo();
      etq.textContent = a ? nombreDe(a) + (rotuloVariante(a) ? ` · ${rotuloVariante(a)}` : "") : "ninguna";
    }
  }

  function fichaHTML(p) {
    const cob = p.cobertura ? `${p.cobertura.archivos} de ${p.cobertura.esperados} archivos` : "";
    const filas = [
      ["Satélite o fuente", p.satelite], ["Resolución", p.resolucion], ["Frecuencia", p.frecuencia],
      ["Llega con", p.latencia], ["Unidad", p.unidad],
      ["Periodo", esCalculado(p) ? rotuloCalculado(p) : ""], ["Cobertura", cob],
      ["Puntos", p.cantidad != null ? App.fmtNum(p.cantidad, 0) : ""],
      ["Máximo", p.estadisticas && p.estadisticas.max != null ? `${App.fmtNum(p.estadisticas.max, 1)} ${p.unidad || ""}` : ""],
    ].filter(f => f[1]);
    return `<div class="mon-ficha-tit">${esc(nombreDe(p.id))}</div>
      <p>${esc(p.que)}</p>
      <p class="mon-lectura"><b>Cómo leerlo.</b> ${esc(p.lectura)}</p>
      <dl>${filas.map(f => `<dt>${esc(f[0])}</dt><dd>${esc(f[1])}</dd>`).join("")}</dl>
      <a href="${esc(p.enlace)}" target="_blank" rel="noopener">Fuente del producto ↗</a>`;
  }

  function mostrarFicha(id) {
    const p = E.cat.productos.find(x => x.id === id);
    const caja = document.getElementById("mon-ficha");
    if (!p || !caja) return;
    caja.innerHTML = `<button type="button" class="mon-cerrar" aria-label="Cerrar">×</button>${fichaHTML(p)}`;
    caja.hidden = false;
    caja.querySelector(".mon-cerrar").onclick = () => { caja.hidden = true; };
  }

  /* ---------------- leyendas propias (español, unidades legibles) ---------------- */
  function numCorto(v) {
    const a = Math.abs(v);
    return App.fmtNum(v, a > 0 && a < 1 ? 1 : 0);
  }
  // Escala continua: los colores de la paleta oficial a la misma distancia y su valor debajo.
  function leyendaEscala(e) {
    const n = e.paradas.length;
    const conSigno = /respecto/.test(e.unidad || "");
    const pos = i => (100 * i / (n - 1)).toFixed(2);
    const grad = e.paradas.map(([, c], i) => `${c} ${pos(i)}%`).join(", ");
    const marcas = e.paradas.map(([v], i) =>
      `<span style="left:${pos(i)}%">${esc((conSigno && v > 0 ? "+" : "") + numCorto(v))}</span>`).join("");
    return `<div class="mon-escala">
        <div class="mon-escala-barra" style="background:linear-gradient(90deg, ${grad})"></div>
        <div class="mon-escala-marcas">${marcas}</div>
        <div class="mon-escala-pie"><span>${esc((e.extremos || [])[0] || "")}</span><span class="mon-escala-u">${esc(e.unidad || "")}</span>
          <span>${esc((e.extremos || [])[1] || "")}</span></div>
      </div>`;
  }
  // Tramos de los productos calculados: bloques de color con el valor donde empieza cada uno.
  function leyendaTramos(p) {
    const t = p.tramos;
    const n = t.length;
    const cada = n > 12 ? 3 : n > 7 ? 2 : 1;
    const seg = t.map(([, , c]) => `<i style="background:${esc(c)}"></i>`).join("");
    const marcas = t.map(([d], i) => (i % cada === 0
      ? `<span style="left:${(100 * i / n).toFixed(2)}%">${esc(numCorto(d))}</span>` : "")).join("");
    return `<div class="mon-escala mon-escala-tramos">
        <div class="mon-escala-barra mon-escala-seg">${seg}</div>
        <div class="mon-escala-marcas">${marcas}</div>
        <div class="mon-escala-pie"><span></span><span class="mon-escala-u">${esc(p.unidad || "")}</span><span></span></div>
      </div>`;
  }
  function leyendaClaves(claves) {
    return `<div class="mon-claves">${claves.map(([c, t]) => `<span><i style="background:${esc(c)}"></i>${esc(t)}</span>`).join("")}</div>`;
  }
  function leyendaEdad(p) {
    const minutos = p.estilo && p.estilo.por === "minutos";
    const tramos = minutos
      ? [["#FFFFFF", "hace menos de 10 min"], ["#FFE14D", "10 a 30 min"], ["#FF9E2C", "30 a 60 min"]]
      : [["#FF2D1F", "últimas 24 h"], ["#FF9E2C", "1 a 3 días"], ["#FFD84D", "3 a 7 días"]];
    const ec = p.cantidad_ecuador != null ? ` · ${App.fmtNum(p.cantidad_ecuador, 0)} en Ecuador` : "";
    const n = p.cantidad != null
      ? `<div class="mon-rep-n">${App.fmtNum(p.cantidad, 0)} ${minutos ? "destellos" : "focos"} en el mapa${ec}</div>` : "";
    return n + `<div class="mon-claves mon-claves-puntos">${tramos.map(([c, e]) => `<span><i style="background:${c}"></i>${e}</span>`).join("")}</div>`;
  }
  function leyendaDe(p) {
    if (p.escala) return leyendaEscala(p.escala);
    // clases con nombre (susceptibilidad): una muestra de color por clase, no una escala numérica
    if (p.clases && p.tramos) return leyendaClaves(p.tramos.map((t, i) => [t[2], p.clases[i] || ""]));
    if (p.tramos) return leyendaTramos(p);
    if (p.tipo === "puntos") return leyendaEdad(p);
    if (p.claves) return leyendaClaves(p.claves);
    return "";
  }

  /* ---------------- reproductor: la capa activa, su hora, sus controles y su leyenda ---------------- */
  const ICONO_PLAY = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l11-6.5z"/></svg>';
  const ICONO_PAUSA = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z"/></svg>';

  function pintarReproductor() {
    const caja = document.getElementById("mon-reproductor");
    if (!caja || !E.cat) return;
    const A = E.anim;
    const a = A ? null : ([...E.capas.values()][0] || null);
    const p = A ? A.p : a ? a.p : null;
    if (!p) { caja.hidden = true; return; }
    caja.hidden = false;
    const variante = rotuloVariante(p.id);
    const conFechas = !!(a && a.instantes.length > 1 && a.instantes[0]);
    const tInst = a && a.instantes.length ? a.instantes[a.i] : null;
    let control = "";
    if (A) {
      const n = A.cuadros.length;
      control = `<div class="mon-rep-ctl">
          <button type="button" id="mon-play" class="mon-rep-b mon-rep-play"></button>
          <button type="button" id="mon-prev" class="mon-rep-b" aria-label="Imagen anterior">‹</button>
          <input type="range" id="mon-linea" class="mon-linea" min="0" max="${Math.max(0, n - 1)}" step="1"
                 value="${Math.round(A.visible ?? A.pos)}" aria-label="Línea de tiempo" ${n < 2 ? "disabled" : ""}>
          <button type="button" id="mon-next" class="mon-rep-b" aria-label="Imagen siguiente">›</button>
        </div>`;
    } else if (conFechas) {
      control = `<div class="mon-rep-ctl mon-rep-dias">
          <button type="button" class="mon-rep-b" data-dia="-1" ${a.i <= 0 ? "disabled" : ""} aria-label="Fecha anterior">‹</button>
          <span class="mon-rep-fecha">${esc(rotuloTiempo(p, a.instantes[a.i]))}</span>
          <button type="button" class="mon-rep-b" data-dia="1" ${a.i >= a.instantes.length - 1 ? "disabled" : ""} aria-label="Fecha siguiente">›</button>
        </div>`;
    }
    // con selector de fecha, la fecha va en el selector y aquí solo su antigüedad: nunca dos veces
    const tiempo = A ? "…" : (a && a.cargando ? "…" : conFechas ? haceDias(tInst) : rotuloTiempo(p, tInst));
    const nota = (a && a.nota) || p.nota || "";
    const avisos = [];
    if (A && A.aviso) avisos.push(A.aviso);
    if (a && a.avisoTiempo) avisos.push(a.avisoTiempo);
    if (a && a.errores > 3) avisos.push("El proveedor no entregó parte de la imagen.");
    if (p.cobertura && p.cobertura.archivos < p.cobertura.esperados) {
      avisos.push(`Faltan ${p.cobertura.esperados - p.cobertura.archivos} de ${p.cobertura.esperados} archivos del periodo.`);
    }
    caja.innerHTML = `<div class="mon-rep-cab">
        <div class="mon-rep-tit"><b>${esc(nombreDe(p.id))}</b>${variante ? `<span class="mon-rep-var">${esc(variante)}</span>` : ""}</div>
        <button type="button" class="mon-rep-info" data-info="${esc(p.id)}" title="Qué es y cómo leerlo" aria-label="Qué es y cómo leerlo">i</button>
      </div>
      <div class="mon-rep-t" id="mon-hora">${esc(tiempo || "")}</div>
      ${control}
      ${leyendaDe(p)}
      ${nota ? `<div class="mon-rep-nota">${esc(nota)}</div>` : ""}
      ${avisos.length ? `<div class="mon-rep-aviso">${avisos.map(esc).join(" · ")}</div>` : ""}`;
    caja.querySelector(".mon-rep-info").onclick = () => mostrarFicha(p.id);
    if (A) {
      caja.querySelector("#mon-play").onclick = () => { if (E.anim && E.anim.raf) pararAnim(); else animar(); };
      caja.querySelector("#mon-prev").onclick = () => irA(Math.round(E.anim.visible ?? E.anim.pos) - 1);
      caja.querySelector("#mon-next").onclick = () => irA(Math.round(E.anim.visible ?? E.anim.pos) + 1);
      const linea = caja.querySelector("#mon-linea");
      linea.oninput = () => irA(Number(linea.value));
      pintarBotonPlay();
      pintarHora();
    }
    caja.querySelectorAll("[data-dia]").forEach(b => b.onclick = () => {
      if (!a) return;
      a.nota = "";
      ponerInstante(a, a.i + Number(b.dataset.dia)).then(() => pintarReproductor());
      pintarReproductor();
    });
  }
  function pintarControl() { pintarReproductor(); }
  function pintarLeyendas() { pintarReproductor(); }

  function pintarBotonPlay() {
    const b = document.getElementById("mon-play");
    if (!b || !E.anim) return;
    const anima = !!E.anim.raf;
    if (b.dataset.estado === String(anima)) return;
    b.dataset.estado = String(anima);
    b.innerHTML = anima ? ICONO_PAUSA : ICONO_PLAY;
    b.title = anima ? "Detener" : "Animar";
    b.setAttribute("aria-label", b.title);
  }

  // Se llama en cada cuadro de la animación: solo toca el texto de la hora y la línea de tiempo.
  function pintarHora() {
    const A = E.anim;
    if (!A) return;
    const n = A.cuadros.length;
    const k = Math.max(0, Math.min(n - 1, A.visible ?? Math.round(A.pos)));
    const c = n ? A.cuadros[k] : null;
    const h = document.getElementById("mon-hora");
    if (h) {
      let txt;
      if (c && c.listo) txt = `${soloHora(c.t)} · ${hace(c.t)}`;
      else if (A.cargando) txt = n ? `cargando ${A.cuadros.filter(x => x.listo).length} de ${n} imágenes…` : "consultando imágenes…";
      else txt = A.aviso || "—";
      if (h.textContent !== txt) h.textContent = txt;
    }
    const linea = document.getElementById("mon-linea");
    if (linea) {
      const max = Math.max(0, n - 1);
      if (+linea.max !== max) linea.max = max;
      if (document.activeElement !== linea && +linea.value !== k) linea.value = k;
      linea.style.setProperty("--avance", max ? `${(100 * k / max).toFixed(1)}%` : "0%");
    }
  }

  // Difuminado de las capas no animadas (mosaicos e imágenes) proporcional a su píxel: se aplica
  // al panel entero, así no aparecen costuras entre mosaicos. Ver suavizarLienzo para la animada.
  function suavizarPanel() {
    const pane = E.mapa && E.mapa.getPane("mon-productos");
    if (!pane) return;
    const a = [...E.capas.values()][0];
    const res = a && a.p.suavizar_m;
    if (!res) { pane.style.filter = ""; return; }
    const mPorPx = 156543.03 / Math.pow(2, E.mapa.getZoom());
    const px = Math.min(30, 0.45 * res / mPorPx);
    pane.style.filter = px >= 0.8 ? `blur(${px.toFixed(1)}px)` : "";
  }

  /* ---------------- mapa ---------------- */
  function ponerBase(id) {
    const b = E.cat.mapas_base.find(x => x.id === id) || E.cat.mapas_base[0];
    if (E.base && E.baseId === b.id) return;
    if (E.base) E.mapa.removeLayer(E.base);
    if (E.etiquetas) E.mapa.removeLayer(E.etiquetas);
    E.baseId = b.id;
    E.base = L.tileLayer(b.url, { attribution: b.atribucion, maxZoom: 18, maxNativeZoom: b.max, pane: "mon-base" })
      .addTo(E.mapa);
    E.etiquetas = b.etiquetas
      ? L.tileLayer(b.etiquetas, { maxZoom: 18, maxNativeZoom: Math.min(b.max, 16), pane: "mon-etiquetas" }).addTo(E.mapa)
      : null;
  }
  function baseSegunTema() {
    return document.documentElement.dataset.tema === "claro" ? "claro" : "oscuro";
  }

  const normalizar = s => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toUpperCase();
  function nombreProvincia(f) {
    const pr = (f && f.properties) || {};
    for (const k of ["DPA_DESPRO", "PROVINCIA", "provincia", "NOMBRE", "Nombre", "nombre", "NAME_1"]) if (pr[k]) return pr[k];
    return "";
  }

  // Ecuador SIEMPRE a la vista, por encima de cualquier capa: provincias finas, la del foco
  // (El Oro) resaltada y el borde nacional grueso, todo con halo oscuro para leerse sobre
  // cualquier color.
  async function ponerLimites() {
    let geo = null;
    try { geo = await App.api("/datos/capas/provincias.geojson"); } catch (e) { geo = null; }
    if (!E.mapa) return;
    const grupo = L.layerGroup().addTo(E.mapa);
    E.limites = grupo;
    if (geo) {
      const foco = E.cat.foco ? normalizar(E.cat.foco.nombre) : "";
      const esFoco = f => foco && normalizar(nombreProvincia(f)) === foco;
      L.geoJSON(geo, { pane: "mon-limites", interactive: false,
        style: f => ({ color: "#0A1220", weight: esFoco(f) ? 5.5 : 2.6, opacity: esFoco(f) ? 0.55 : 0.4, fill: false }) }).addTo(grupo);
      L.geoJSON(geo, { pane: "mon-limites", interactive: false,
        style: f => ({ color: "#FFFFFF", weight: esFoco(f) ? 2.2 : 0.9, opacity: esFoco(f) ? 1 : 0.7, fill: false }) }).addTo(grupo);
    }
    const c = E.calc && (E.calc.productos || []).find(p => p.tipo === "contorno");
    if (!c) return;
    let pais = null;
    try { pais = await (await fetch(urlArchivo(c.archivo))).json(); } catch (e) { pais = null; }
    if (!pais || !E.mapa || E.limites !== grupo) return;
    L.geoJSON(pais, { pane: "mon-limites", interactive: false,
      style: { color: "#0A1220", weight: 5.5, opacity: 0.55, fill: false, lineJoin: "round" } }).addTo(grupo);
    L.geoJSON(pais, { pane: "mon-limites", interactive: false,
      style: { color: "#FFFFFF", weight: 2, opacity: 1, fill: false, lineJoin: "round" } }).addTo(grupo);
  }

  // Área de operación del cliente: privada (config/cliente/, /api/monitoreo/area). En el visor
  // publicado no existe y el mapa queda solo con El Oro.
  async function ponerArea() {
    let geo = null;
    try { geo = await App.api("/monitoreo/area"); } catch (e) { geo = null; }
    if (!E.mapa || !geo || !(geo.features || []).length) return;
    const g = L.layerGroup().addTo(E.mapa);
    E.area = g;
    L.geoJSON(geo, { pane: "mon-area", interactive: false,
      style: { color: "#06101D", weight: 8, opacity: 0.5, fill: false, lineJoin: "round" } }).addTo(g);
    const capa = L.geoJSON(geo, { pane: "mon-area", interactive: false,
      style: { color: "#FFC93C", weight: 2.6, opacity: 1, fillColor: "#FFC93C", fillOpacity: 0.14, lineJoin: "round",
               className: "mon-area-linea" } }).addTo(g);
    E.areaLimites = capa.getBounds();
    const arriba = L.latLng(E.areaLimites.getNorth(), E.areaLimites.getCenter().lng);
    L.marker(arriba, { pane: "mon-area", interactive: false, keyboard: false,
      icon: L.divIcon({ className: "mon-area-etq", html: "<span>Área de operación</span>", iconSize: null }) }).addTo(g);
    const b = document.getElementById("mon-ir-area");
    if (b) b.hidden = false;
  }

  // Encuadre de la zona de interés, dejando libre lo que tapan el panel de capas y el reproductor.
  function margenes() {
    const panel = document.getElementById("mon-panel");
    const rep = document.getElementById("mon-reproductor");
    const ancho = window.innerWidth > 900;
    const izq = ancho && panel && !panel.classList.contains("plegado") ? panel.offsetWidth + 28 : 20;
    const abajo = rep && !rep.hidden ? Math.min(rep.offsetHeight + 24, 240) : 24;
    return { paddingTopLeft: [izq, 24], paddingBottomRight: [24, ancho ? 24 : abajo] };
  }
  function irA_limites(limites, animado = true, zMax = 12) {
    if (!E.mapa || !limites) return;
    E.mapa.fitBounds(limites, { ...margenes(), animate: animado, maxZoom: zMax });
  }
  function vistaFoco(animado = true) {
    const f = E.cat && E.cat.foco;
    if (!E.mapa) return;
    if (f) {
      const [o, s, e, n] = f.limites;
      irA_limites(L.latLngBounds([s, o], [n, e]), animado, 10);
    } else {
      E.mapa.setView(E.cat.vista_inicial.centro, E.cat.vista_inicial.zoom, { animate: animado });
    }
  }

  // Productos que calcula HidroMet en cada actualización: entran SOLO los que el menú nombra,
  // con el grupo del menú (los demás —y los que quedaron de corridas viejas— no se muestran).
  async function cargarCalculados() {
    if (E.calc) return;
    let indice = null;
    try { indice = await App.api("/monitoreo/calculados"); } catch (e) { indice = null; }
    E.calc = indice && Array.isArray(indice.productos) ? indice : { productos: [] };
    E.calcVersion = E.calc.generado_utc || "";
    const ids = new Set(E.cat.productos.map(p => p.id));
    for (const p of E.calc.productos) {
      const f = filaDe(p.id);
      if (ids.has(p.id) || !f) continue;
      const km = /(\d+(?:[.,]\d+)?)\s*km/.exec(String(p.resolucion || ""));
      E.cat.productos.push({ ...p, grupo: f.grupo, calculado: true, opacidad: p.tipo === "puntos" ? 0.95 : 0.8,
                             suavizar_m: p.tipo === "imagen" && km ? Math.round(parseFloat(km[1].replace(",", ".")) * 1000) : undefined,
                             latencia: "se calcula en cada actualización" });
    }
  }

  // Botones del mapa: volver a El Oro y acercarse al área de operación.
  const ControlFoco = (typeof L === "object" && L.Control) ? L.Control.extend({
    options: { position: "topright" },
    onAdd() {
      const div = L.DomUtil.create("div", "leaflet-bar mon-foco");
      div.innerHTML = `<button type="button" id="mon-ir-foco" title="Ver toda la provincia" aria-label="Ver toda la provincia">${esc((E.cat.foco || {}).nombre || "Ecuador")}</button>
        <button type="button" id="mon-ir-area" title="Acercarse al área de operación" aria-label="Acercarse al área de operación" hidden>Área</button>`;
      L.DomEvent.disableClickPropagation(div);
      div.querySelector("#mon-ir-foco").onclick = () => vistaFoco(true);
      div.querySelector("#mon-ir-area").onclick = () => irA_limites(E.areaLimites, true, 11.5);
      return div;
    },
  }) : null;

  async function tabMapa(cuerpo) {
    E.cat = E.cat || await App.api("/monitoreo/catalogo");
    await cargarCalculados();
    cuerpo.innerHTML = `<div class="mon">
      <div class="mon-mapa-caja">
        <div id="mon-mapa" class="mon-mapa" role="region" aria-label="Mapa de monitoreo"></div>
        <aside class="mon-panel" id="mon-panel" aria-label="Capas">
          <button type="button" class="mon-panel-cab" id="mon-plegar" aria-expanded="true" aria-controls="mon-capas">
            <span class="mon-panel-tit">Capas</span>
            <span class="mon-panel-activa" id="mon-activa"></span>
            <svg class="mon-chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>
          </button>
          <div id="mon-capas" class="mon-capas"></div>
        </aside>
        <div id="mon-reproductor" class="mon-reproductor" hidden></div>
        <div id="mon-ficha" class="mon-ficha" hidden></div>
      </div>
    </div>`;
    const [o, s, e, n] = E.cat.limites;
    E.mapa = L.map("mon-mapa", { zoomControl: false, worldCopyJump: false, minZoom: 5, maxZoom: 12,
                                 zoomSnap: 0.25, zoomDelta: 0.5, wheelPxPerZoomLevel: 100,
                                 maxBounds: L.latLngBounds([s - 15, o - 25], [n + 15, e + 25]) });
    for (const [nombre, z] of [["mon-base", 200], ["mon-anim", 300], ["mon-productos", 350], ["mon-limites", 420],
                               ["mon-area", 430], ["mon-etiquetas", 440], ["mon-puntos", 450]]) {
      const pane = E.mapa.createPane(nombre);
      pane.style.zIndex = z;
      if (nombre !== "mon-puntos") pane.style.pointerEvents = "none";
    }
    L.control.zoom({ position: "topright" }).addTo(E.mapa);
    if (ControlFoco) new ControlFoco().addTo(E.mapa);
    L.control.scale({ imperial: false, position: "bottomleft" }).addTo(E.mapa);
    E.mapa.on("zoomend", () => suavizarPanel());
    ponerBase(baseSegunTema());
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
    };
    vistaFoco(false);
    pintarPanel();
    pintarReproductor();
    ponerLimites();
    ponerArea();
    // preferencia guardada: UNA capa y la variante elegida de cada familia
    const prefs = leerPrefs();
    E.variante = Object.assign({}, prefs.variantes || {});
    let capa = prefs.capa;
    if (capa === undefined || (capa && !filaDe(capa))) capa = ANIM_INICIAL;
    if (capa && E.cat.productos.some(p => p.id === capa)) elegir(capa);
    setTimeout(() => { if (E.mapa) { E.mapa.invalidateSize(); vistaFoco(false); } }, 60);
  }

  function tabProductos(cuerpo) {
    const grupos = Object.fromEntries(E.cat.grupos.map(g => [g.id, g.nombre]));
    const filas = [];
    for (const m of E.cat.menu || []) {
      for (const it of m.items) {
        const id = it.variantes ? (it.inicial || it.variantes[0][0]) : it.id;
        const p = E.cat.productos.find(x => x.id === id);
        if (!p) continue;
        filas.push({ tema: grupos[m.grupo] || m.grupo, nombre: it.nombre || p.nombre, p, variantes: it.variantes });
      }
    }
    cuerpo.innerHTML = `<div class="mon-tabla-caja">
      <p class="mon-intro">Cada producto se pide directo a su fuente, con la resolución más fina que publica. La tabla dice qué
        mide, cada cuánto se actualiza y con cuánto retraso llega.</p>
      <div class="tabla-scroll"><table class="tabla mon-tabla"><thead><tr>
        <th>Tema</th><th>Producto</th><th>Satélite o fuente</th><th>Resolución</th><th>Frecuencia</th><th>Llega con</th><th>Qué mide</th>
      </tr></thead><tbody>${filas.map(f => `<tr>
        <td>${esc(f.tema)}</td>
        <td><a href="${esc(f.p.enlace)}" target="_blank" rel="noopener">${esc(f.nombre)}</a>${f.variantes
          ? `<div class="mon-tabla-var">${esc(f.variantes.map(v => v[1]).join(" · "))}</div>` : ""}</td>
        <td>${esc(f.p.satelite)}</td><td>${esc(f.p.resolucion)}</td><td>${esc(f.p.frecuencia)}</td>
        <td>${esc(f.p.latencia)}</td><td>${esc(f.p.que)}</td></tr>`).join("")}</tbody></table></div>
    </div>`;
  }

  function limpiar() {
    desactivarAnim();
    if (E.mapa) { try { E.mapa.remove(); } catch (e) { /* ya retirado */ } }
    E.mapa = null; E.base = null; E.baseId = null; E.etiquetas = null; E.limites = null; E.area = null; E.areaLimites = null;
    E.capas.clear();
  }
  // al salir del módulo se olvida el índice calculado: al volver se lee el de la última actualización
  function salirModulo() { limpiar(); E.calc = null; E.cat = null; }

  document.addEventListener("temacambiado", () => {
    if (E.mapa && E.cat) ponerBase(baseSegunTema());
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
        sub: "Lo que está pasando ahora en El Oro, en vivo desde los satélites",
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
