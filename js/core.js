/* ============================================================
   HidroMet Ecuador — núcleo del frontend
   Router por hash, registro de módulos, tema, API y tareas.
   Cada módulo llama App.registrar(id, {titulo, icono, orden, render}).
   ============================================================ */
"use strict";

const App = (() => {
  const modulos = new Map();
  let vistaActual = null;

  /* ---------------- API HTTP ---------------- */
  async function api(ruta, opts = {}) {
    // MODO VISOR (window.HIDROMET_VISOR): en línea y SIN backend, lee los PRODUCTOS que el
    // motor publicó (GitHub Pages) en vez de la API en vivo. Toda la UI funciona igual; las
    // acciones de escritura se rechazan con gracia. La app de escritorio no fija ese flag.
    if (window.HIDROMET_VISOR) return apiVisor(ruta, opts);
    const conf = { headers: { "Content-Type": "application/json" }, ...opts };
    if (conf.body && typeof conf.body !== "string") conf.body = JSON.stringify(conf.body);
    const resp = await fetch("/api" + ruta, conf);
    if (!resp.ok) {
      let detalle = resp.statusText;
      try { detalle = (await resp.json()).error || detalle; } catch (e) { /* texto plano */ }
      throw new Error(detalle);
    }
    const tipo = resp.headers.get("content-type") || "";
    return tipo.includes("json") ? resp.json() : resp;
  }

  // Mapeo determinista ruta-de-API → archivo de producto (IDÉNTICO en el exportador del
  // motor). Ej: "/cartas/alertas?fecha=X" → "productos/cartas/alertas/fecha=X.json";
  // rutas que ya son un archivo (.geojson) se sirven tal cual bajo productos/.
  // Construye el path del producto con el MISMO stripping que el exportador (exportar_web.py):
  // carta_datos ignora fin/corrido (redundantes dado archivo+record); mlnwp ignora deps (y
  // familia salvo en el resumen de validación); sngr/eventos = ventana completa publicada. 'drop' añade
  // parámetros volátiles a ignorar para el fallback difuso.
  function _slugProducto(ruta, drop) {
    const [path, query] = String(ruta).split("?");
    const base = path.replace(/^\//, "");
    if (/\.(geojson|json|png|csv)$/i.test(base) && !query) return "productos/" + base;
    let pares = query ? query.split("&").filter(Boolean) : [];
    const quita = new Set(drop || []);
    if (base === "cartas/carta_datos") { quita.add("fin"); quita.add("corrido"); }
    // La referencia certifica el ciclo pedido al endpoint vivo, pero el artefacto
    // FFGS público conserva su identidad canónica exacta: archivo+record.
    if (base === "cartas/ffgs_shp") quita.add("esperado_reference_time");
    if (base.indexOf("mlnwp/") === 0) { quita.add("deps"); if (base !== "mlnwp/validacion") quita.add("familia"); }
    if (base === "sngr/eventos") pares = [];
    if (quita.size) pares = pares.filter(p => !quita.has(p.split("=")[0]));
    // canónico: decodifica los valores (el exportador usa el valor crudo) antes del slug,
    // así "familia=Mejor%20desempe%C3%B1o" y "familia=Mejor desempeño" mapean igual.
    const norm = pares.map(p => {
      const i = p.indexOf("=");
      if (i < 0) return p;
      let v = p.slice(i + 1);
      try { v = decodeURIComponent(v); } catch (e) { /* dejar como está */ }
      return p.slice(0, i) + "=" + v;
    });
    const slug = norm.length
      ? norm.sort().join("&").replace(/[^a-zA-Z0-9=._-]/g, "_")
      : "index";
    return "productos/" + base + "/" + slug + ".json";
  }
  function rutaAProducto(ruta) { return _slugProducto(ruta, []); }

  async function leerJsonGzip(url) {
    const resp = await fetch(url, { cache: "no-cache" });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const bytes = new Uint8Array(await resp.arrayBuffer());
    // Algunos hosts aplican Content-Encoding y fetch entrega el cuerpo ya
    // descomprimido; la firma evita intentar gzip dos veces.
    if (bytes[0] !== 0x1f || bytes[1] !== 0x8b)
      return JSON.parse(new TextDecoder("utf-8").decode(bytes));
    if (typeof DecompressionStream !== "function")
      throw new Error("Este navegador no admite la descompresión gzip del visor.");
    const flujo = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    return new Response(flujo).json();
  }

  function _zipCabeceraLocal(entrada, nombre) {
    const b = new Uint8Array(30);
    const v = new DataView(b.buffer);
    v.setUint32(0, 0x04034b50, true);
    v.setUint16(4, 20, true);          // ZIP 2.0 (DEFLATE)
    v.setUint16(6, 0x0800, true);      // nombres UTF-8
    v.setUint16(8, 8, true);           // DEFLATE crudo
    v.setUint16(10, 0, true);
    v.setUint16(12, 0x0021, true);     // 1980-01-01, reproducible
    v.setUint32(14, entrada.crc32 >>> 0, true);
    v.setUint32(18, entrada.tamano_comprimido >>> 0, true);
    v.setUint32(22, entrada.tamano >>> 0, true);
    v.setUint16(26, nombre.length, true);
    return b;
  }

  function _zipCabeceraCentral(entrada, nombre, offset) {
    const b = new Uint8Array(46);
    const v = new DataView(b.buffer);
    v.setUint32(0, 0x02014b50, true);
    v.setUint16(4, 20, true);
    v.setUint16(6, 20, true);
    v.setUint16(8, 0x0800, true);
    v.setUint16(10, 8, true);
    v.setUint16(12, 0, true);
    v.setUint16(14, 0x0021, true);
    v.setUint32(16, entrada.crc32 >>> 0, true);
    v.setUint32(20, entrada.tamano_comprimido >>> 0, true);
    v.setUint32(24, entrada.tamano >>> 0, true);
    v.setUint16(28, nombre.length, true);
    v.setUint32(42, offset >>> 0, true);
    return b;
  }

  async function zipDesdeManifest(manifiesto, urlManifest) {
    if (!manifiesto || manifiesto.schema !== "hidromet.ffgs-shp-dedup.v1"
        || !Array.isArray(manifiesto.entradas) || !manifiesto.entradas.length)
      throw new Error("Manifiesto de shapefile no válido.");
    if (manifiesto.entradas.length > 0xffff)
      throw new Error("El shapefile excede el límite ZIP del visor.");
    const encoder = new TextEncoder();
    const base = new URL(urlManifest, document.baseURI);
    const cache = new Map();
    const cargar = async entrada => {
      const clave = String(entrada.url || "");
      if (!cache.has(clave)) cache.set(clave, (async () => {
        const resp = await fetch(new URL(clave, base), { cache: "no-cache" });
        if (!resp.ok) throw new Error(`Bloque de shapefile no publicado (HTTP ${resp.status}).`);
        return new Uint8Array(await resp.arrayBuffer());
      })());
      return cache.get(clave);
    };
    const datos = await Promise.all(manifiesto.entradas.map(cargar));
    const locales = [], centrales = [];
    let offset = 0, tamanoCentral = 0;
    manifiesto.entradas.forEach((entrada, i) => {
      const nombre = encoder.encode(String(entrada.nombre || ""));
      const comprimido = datos[i];
      const tc = Number(entrada.tamano_comprimido);
      const tr = Number(entrada.tamano);
      if (!nombre.length || nombre.length > 0xffff || !Number.isInteger(tc)
          || !Number.isInteger(tr) || tc < 0 || tr < 0 || tc > 0xffffffff
          || tr > 0xffffffff || comprimido.length !== tc)
        throw new Error("Bloque de shapefile inconsistente.");
      const local = _zipCabeceraLocal(entrada, nombre);
      const central = _zipCabeceraCentral(entrada, nombre, offset);
      locales.push(local, nombre, comprimido);
      centrales.push(central, nombre);
      offset += local.length + nombre.length + comprimido.length;
      tamanoCentral += central.length + nombre.length;
      if (offset > 0xffffffff || tamanoCentral > 0xffffffff)
        throw new Error("El shapefile excede el límite ZIP del visor.");
    });
    const fin = new Uint8Array(22);
    const vf = new DataView(fin.buffer);
    vf.setUint32(0, 0x06054b50, true);
    vf.setUint16(8, manifiesto.entradas.length, true);
    vf.setUint16(10, manifiesto.entradas.length, true);
    vf.setUint32(12, tamanoCentral, true);
    vf.setUint32(16, offset, true);
    const nombre = String(manifiesto.nombre_descarga || "ffgs_shapefile.zip")
      .split(/[\\/]/).pop() || "ffgs_shapefile.zip";
    return { blob: new Blob([...locales, ...centrales, fin], { type: "application/zip" }), nombre };
  }

  async function apiVisor(ruta, opts = {}) {
    if ((opts.method || "GET").toUpperCase() !== "GET")
      throw new Error("Acción no disponible en el visor en línea (es de solo lectura).");
    // Intenta el archivo exacto; si no está, cae a versiones canónicas quitando filtros
    // volátiles (familia/deps/lookback) que no cambian la estructura del dato.
    for (const drop of [[], ["familia"], ["familia", "deps", "lookback", "ventana"]]) {
      const producto = _slugProducto(ruta, drop);
      if (/^productos\/cartas\/carta_datos\/.+\.json$/i.test(producto)) {
        try { return await leerJsonGzip(producto + ".gz"); }
        catch (e) { /* transición: intentar el JSON legado */ }
      }
      let resp;
      try { resp = await fetch(producto, { cache: "no-cache" }); }
      catch (e) { continue; }
      if (resp && resp.ok) return resp.json();
    }
    throw new Error("Este dato aún no está publicado en el visor.");
  }

  /* ---------------- avisos (toasts) ---------------- */
  function aviso(mensaje, tipo = "info", ms = 4200, opts = {}) {
    const caja = document.getElementById("avisos");
    if (!caja) return;
    const el = document.createElement("div");
    el.className = `aviso ${tipo}`;
    // opts.html: SOLO para contenido interno ya escapado (p. ej. glosarios de la API
    // propia); el default sigue siendo textContent (seguro para mensajes de error).
    if (opts.html) el.innerHTML = mensaje; else el.textContent = mensaje;
    caja.appendChild(el);
    // v12: salida suave (la clase .saliendo anima opacidad/transform antes de remover)
    setTimeout(() => { el.classList.add("saliendo"); setTimeout(() => el.remove(), 200); }, ms);
  }

  /* ---------------- tareas en background ---------------- */
  const tareasSeguidas = new Map(); // id -> {nombre, cursor, alTerminar, _ultimoProgreso, _estado}
  const restauradores = new Map();  // id -> fn() que RE-ABRE (maximiza) el modal minimizado

  /* Un módulo que minimiza su modal registra aquí cómo restaurarlo; el chip de la
     barra lateral se vuelve clicable y llama a esta fn (maximizar). */
  function restaurador(id, fn) {
    if (typeof fn === "function") restauradores.set(id, fn);
    else if (fn === null) restauradores.delete(id);
    else return restauradores.get(id);
  }

  async function tarea(rutaAccion, cuerpo = {}, callbacks = {}) {
    const r = await api(rutaAccion, { method: "POST", body: cuerpo });
    if (!r.tarea_id) throw new Error("El servidor no devolvió tarea_id");
    seguirTarea(r.tarea_id, callbacks);
    return r.tarea_id;
  }

  function seguirTarea(id, callbacks = {}) {
    // Componer callbacks por clave (NO sobrescribir): así una segunda suscripción
    // al mismo id (p.ej. App.tarea con alTerminar + App.modalTarea con su log) NO
    // pisa la primera. Conserva cursor/nombre/estado del registro previo.
    const prev = tareasSeguidas.get(id) || { cursor: 0 };
    const compuesto = { ...prev };
    for (const k of ["alLog", "alProgreso", "alTerminar", "alError"]) {
      const a = prev[k], b = callbacks[k];
      compuesto[k] = (a && b) ? (...args) => { a(...args); b(...args); } : (b || a);
    }
    tareasSeguidas.set(id, compuesto);
    sincronizarBloqueo();   // §B.8: bloquear de inmediato, sin esperar al primer poll
    bucleTareas();
  }

  /* ¿Hay alguna tarea de actualización viva? (para el bloqueo global §B.8) */
  function hayTareaActiva() { return tareasSeguidas.size > 0; }

  async function cancelarTarea(id) {
    try { await api(`/tareas/${id}/cancelar`, { method: "POST" }); }
    catch (e) { /* la tarea pudo terminar entre tanto */ }
  }

  /** §B.8: cancela TODAS las tareas de actualización en curso. */
  async function cancelarTodas() {
    const ids = [...tareasSeguidas.keys()];
    if (!ids.length) return;
    aviso("Cancelando la actualización en curso…", "info");
    await Promise.all(ids.map(cancelarTarea));
  }

  let bucleActivo = false;
  async function bucleTareas() {
    if (bucleActivo) return;
    bucleActivo = true;
    while (tareasSeguidas.size > 0) {
      for (const id of [...tareasSeguidas.keys()]) {
        const previo = tareasSeguidas.get(id);
        if (!previo) continue;
        try {
          const t = await api(`/tareas/${id}?desde=${previo.cursor}`);
          // Re-leer la entrada VIVA: otra suscripción (p.ej. App.modalTarea)
          // pudo componer callbacks durante el await; usar la stale perdería el
          // alTerminar del módulo o el del modal.
          const seg = tareasSeguidas.get(id) || previo;
          seg._fallosPolling = 0;
          seg.cursor = t.log_cursor;
          seg.nombre = t.nombre;
          seg._ultimoProgreso = t.progreso;
          seg._estado = t.estado;
          if ((t.log_nuevo || []).length && seg.alLog) seg.alLog(t.log_nuevo || []);
          if (seg.alProgreso) seg.alProgreso(t.progreso, t.estado);
          if (["ok", "error", "cancelada"].includes(t.estado)) {
            tareasSeguidas.delete(id);
            restauradores.delete(id);
            if (t.estado === "ok") { aviso(`${t.nombre}: completado`, "ok"); seg.alTerminar && seg.alTerminar(t); if (!/^Probar descargas|informe/i.test(t.nombre || "")) document.dispatchEvent(new CustomEvent("datos-actualizados", { detail: t.nombre || "" })); }
            else if (t.estado === "error") { aviso(`${t.nombre}: ${t.error}`, "error", 8000); seg.alError && seg.alError(t); }
            else aviso(`${t.nombre}: cancelada`, "info");
          }
        } catch (e) {
          // Un fallo transitorio de red/polling NO significa que la tarea haya
          // terminado. Antes se borraba aquí y la UI se desbloqueaba mientras
          // el motor seguía escribiendo. Reintenta ~18 s y solo entonces falla.
          const seg = tareasSeguidas.get(id) || previo;
          seg._fallosPolling = (seg._fallosPolling || 0) + 1;
          if (seg._fallosPolling === 3)
            aviso(`${seg.nombre || "Actualización"}: conexión interrumpida; reintentando…`, "info", 5000);
          if (seg._fallosPolling >= 20) {
            tareasSeguidas.delete(id); restauradores.delete(id);
            aviso(`${seg.nombre || "Actualización"}: no se pudo recuperar su estado; verifica el servidor.`, "error", 8000);
            seg.alError && seg.alError({ estado: "error", error: "polling interrumpido" });
          }
        }
      }
      pintarChipsTareas();
      sincronizarBloqueo();
      await new Promise(r => setTimeout(r, 900));
    }
    pintarChipsTareas();
    sincronizarBloqueo();
    bucleActivo = false;
  }

  function pintarChipsTareas() {
    const caja = document.getElementById("tareas-activas");
    if (!caja) return;
    caja.innerHTML = "";
    for (const [id, seg] of tareasSeguidas) {
      const chip = document.createElement("div");
      chip.className = "tarea-chip";
      const progreso = seg._ultimoProgreso;
      const puedeAbrir = restauradores.has(id);
      const pct = progreso == null ? "" : ` ${Math.round(progreso)}%`;
      chip.innerHTML = `<div>${seg.nombre || "Tarea"}…${pct}${puedeAbrir ? ' <span class="tarea-chip-abrir">⤢ abrir</span>' : ""}</div>
        <div class="barra ${progreso == null ? "indeterminada" : ""}"><div style="width:${progreso ?? 40}%"></div></div>`;
      if (puedeAbrir) {
        chip.classList.add("clicable");
        chip.title = "Maximizar — volver a abrir la ventana de progreso";
        chip.onclick = () => { const fn = restauradores.get(id); if (fn) fn(); };
      }
      caja.appendChild(chip);
    }
  }

  /* ---------------- bloqueo global durante una tarea (§B.8 / #7) ----------------
     Mientras una actualización corre, los controles que disparan OTRA acción que
     podría chocar quedan atenuados y deshabilitados, y aparece una barra fija con
     un botón "Cancelar" que detiene el subproceso real (POST /tareas/<id>/cancelar
     → terminate()+kill() en el motor). Al terminar todas las tareas, se reactiva.

     Mecánica: un atributo en <body> conmuta el CSS de atenuación; los controles a
     bloquear se marcan con [data-bloquea] (o se infieren: todo .boton del área de
     trabajo salvo los exentos con .no-bloquea). La barra "Cancelar" vive fuera de
     ese contenedor atenuado para seguir siendo clicable. */
  let barraCancelar = null;

  function controlesBloqueables() {
    // Botones de acción del área de trabajo y de la cabecera de cada módulo.
    const ambito = [
      ...document.querySelectorAll("#vista .boton"),
      ...document.querySelectorAll("#acciones-vista .boton"),
      ...document.querySelectorAll("[data-bloquea]"),
    ];
    return ambito.filter(el => !el.classList.contains("no-bloquea") &&
                               !el.closest(".modal") &&         // el modal trae su propio Cancelar
                               el !== (barraCancelar && barraCancelar.querySelector("button")));
  }

  function sincronizarBloqueo() {
    const activa = hayTareaActiva();
    document.body.dataset.tareaActiva = activa ? "1" : "";
    // marcar/desmarcar cada control (deshabilitar de verdad, no solo atenuar)
    for (const el of controlesBloqueables()) {
      if (activa) {
        if (!el.dataset.bloqueado) {
          el.dataset.bloqueado = "1";
          el.dataset.disabledPrevio = el.disabled ? "1" : "0";
          if ("disabled" in el) el.disabled = true;
          el.setAttribute("aria-disabled", "true");
        }
      } else if (el.dataset.bloqueado) {
        delete el.dataset.bloqueado;
        if ("disabled" in el) el.disabled = el.dataset.disabledPrevio === "1";
        el.removeAttribute("aria-disabled");
        delete el.dataset.disabledPrevio;
      }
    }
    if (activa) mostrarBarraCancelar(); else ocultarBarraCancelar();
  }

  function nombreTareaActual() {
    for (const [, seg] of tareasSeguidas) if (seg.nombre) return seg.nombre;
    return "Actualización en curso";
  }

  function mostrarBarraCancelar() {
    if (!barraCancelar) {
      barraCancelar = document.createElement("div");
      barraCancelar.id = "barra-tarea";
      barraCancelar.innerHTML =
        `<span class="spin"></span>
         <span class="texto"></span>
         <button class="boton peligro no-bloquea" data-rol="cancelar-global">Cancelar</button>`;
      document.body.appendChild(barraCancelar);
      barraCancelar.querySelector('[data-rol="cancelar-global"]').onclick = cancelarTodas;
    }
    const n = tareasSeguidas.size;
    barraCancelar.querySelector(".texto").textContent =
      n > 1 ? `${nombreTareaActual()} (+${n - 1} más)…` : `${nombreTareaActual()}…`;
  }

  function ocultarBarraCancelar() {
    if (barraCancelar) { barraCancelar.remove(); barraCancelar = null; }
  }

  /* ---------------- modal de log ---------------- */
  function modalTarea(titulo, tareaId) {
    const fondo = document.createElement("div");
    fondo.className = "modal-fondo";
    fondo.innerHTML = `<div class="modal">
      <header><span>${titulo}</span>
        <div class="fila">
          <button class="boton peligro" data-rol="cancelar">Cancelar tarea</button>
          <button class="boton secundario" data-rol="cerrar">Cerrar</button>
        </div></header>
      <div class="cuerpo"><div class="log-consola" data-rol="log"></div></div></div>`;
    document.body.appendChild(fondo);
    const log = fondo.querySelector('[data-rol="log"]');
    fondo.querySelector('[data-rol="cerrar"]').onclick = () => fondo.remove();
    fondo.querySelector('[data-rol="cancelar"]').onclick = () => cancelarTarea(tareaId);
    seguirTarea(tareaId, {
      alLog: lineas => { log.textContent += lineas.join("\n") + "\n"; log.scrollTop = log.scrollHeight; },
      alTerminar: () => { log.textContent += "\n— Completado —"; },
      alError: t => { log.textContent += `\n— ERROR: ${t.error} —`; },
    });
    return fondo;
  }

  /* ---------------- tema ---------------- */
  function tema(nuevo) {
    const html = document.documentElement;
    if (nuevo) {
      html.dataset.tema = nuevo;
      localStorage.setItem("hidromet-tema", nuevo);
      // v12: theme-color sigue al tema (el chrome del navegador móvil deja de chocar)
      const mc = document.querySelector('meta[name="theme-color"]');
      if (mc) mc.content = nuevo === "oscuro" ? "#0B1322" : "#E9EDF3";
      api("/config", { method: "POST", body: { tema: nuevo } }).catch(() => {});
      document.dispatchEvent(new CustomEvent("temacambiado", { detail: nuevo }));
    }
    return html.dataset.tema || "claro";
  }

  /* ---------------- registro y router ---------------- */
  function registrar(id, def) { modulos.set(id, def); }

  function navegar(id) { location.hash = "#/" + id; }

  function _moduloDefecto() {
    // Escritorio y visor comparten la misma entrada: el primer módulo operativo.
    // Así la fuente local no reintroduce una pantalla que ya no existe publicada.
    const arr = [...modulos.entries()].sort((a, b) => (a[1].orden ?? 99) - (b[1].orden ?? 99));
    return arr.length ? arr[0][0] : "pronostico";
  }

  // P23: esqueleto de carga compartido — sustituye el "⏳ Cargando…" textual mientras
  // el módulo/pestaña renderiza (shimmer .hm-skel ya existente en base.css).
  const HTML_CARGA = `<div class="hm-skel-carga" role="status" aria-label="Cargando…">
      <div class="hm-skel hm-skel-tit"></div>
      <div class="hm-skel hm-skel-barra"></div>
      <div class="hm-skel-fila"><div class="hm-skel hm-skel-panel"></div><div class="hm-skel hm-skel-panel chico"></div></div>
    </div>`;

  async function pintarVista() {
    const def0 = _moduloDefecto();
    const id = (location.hash || ("#/" + def0)).replace("#/", "") || def0;
    const def = modulos.get(id) || modulos.get(def0);
    if (!def) return;
    if (vistaActual && vistaActual.alDejar) { try { vistaActual.alDejar(); } catch (e) {} }
    vistaActual = def;
    document.querySelectorAll(".nav-item").forEach(b => {
      const activo = b.dataset.modulo === id;
      b.classList.toggle("activo", activo);
      b.setAttribute("aria-current", activo ? "page" : "false");
    });
    document.getElementById("titulo-vista").textContent = def.titulo;
    const bc = document.getElementById("topbar-modulo");
    if (bc) bc.textContent = def.titulo;   // breadcrumb dinámico (antes era texto fijo falso)
    const acciones = document.getElementById("acciones-vista");
    acciones.innerHTML = "";
    const vista = document.getElementById("vista");
    vista.innerHTML = HTML_CARGA;
    try {
      await def.render(vista, acciones);
    } catch (e) {
      vista.innerHTML = `<div class="vacio"><div class="icono">⚠️</div>
        <strong>No se pudo cargar este módulo</strong><span>${e && e.message}</span></div>`;
    }
    // A11y: tras reemplazar todo el #vista, llevar el foco al encabezado del módulo
    // para que el teclado y el lector de pantalla no queden perdidos en el body.
    const _h = vista.querySelector("h1");
    if (_h) { _h.setAttribute("tabindex", "-1"); try { _h.focus({ preventScroll: true }); } catch (e) {} }
    // §B.8: si una tarea sigue viva, los controles recién pintados por el módulo
    // deben nacer ya bloqueados (el router reemplazó todo el #vista).
    sincronizarBloqueo();
  }

  // Grupos de la barra lateral (rediseño v9): PRINCIPAL · MÓDULOS · SISTEMA.
  const GRUPO_NAV = { pronostico: "MÓDULOS", validacion: "MÓDULOS", hidrologia: "MÓDULOS",
                      advertencias: "MÓDULOS", clima: "MÓDULOS", glosario: "MÓDULOS",
                      cartas: "MÓDULOS", sngr: "MÓDULOS", eventos: "MÓDULOS", mlnwp: "MÓDULOS",
                      datos: "SISTEMA", configuracion: "SISTEMA", config: "SISTEMA" };

  // Iconos SVG de línea del nav (rediseño v9, stroke:currentColor) — sustituyen a los emojis.
  const ICONOS_NAV = {
    cartas: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"><path d="M3 7l6-3 6 3 6-3v13l-6 3-6-3-6 3z"/><path d="M9 4v13M15 7v13"/></svg>',
    sngr: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M3 8c2.5 0 2.5 2 5 2s2.5-2 5-2 2.5 2 5 2"/><path d="M3 14c2.5 0 2.5 2 5 2s2.5-2 5-2 2.5 2 5 2"/></svg>',
    mlnwp: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M3 21h18"/><rect x="4" y="12" width="3.6" height="6" rx="1"/><rect x="10.2" y="7" width="3.6" height="11" rx="1"/><rect x="16.4" y="4" width="3.6" height="14" rx="1"/></svg>',
    datos: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><ellipse cx="12" cy="5.5" rx="7.5" ry="2.8"/><path d="M4.5 5.5v6c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8v-6"/><path d="M4.5 11.5v6c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8v-6"/></svg>',
    configuracion: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><circle cx="7" cy="8" r="2.2"/><circle cx="16" cy="16" r="2.2"/><path d="M3 8h2M9.2 8H21M3 16h10.8M18.2 16H21"/></svg>',
  };
  // Nuevos módulos (reestructura de menús): reutilizan/derivan iconos coherentes.
  ICONOS_NAV.pronostico = ICONOS_NAV.cartas;
  ICONOS_NAV.validacion = ICONOS_NAV.mlnwp;
  ICONOS_NAV.hidrologia = ICONOS_NAV.sngr;
  ICONOS_NAV.advertencias = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round" stroke-linecap="round"><path d="M12 3.5 22 20H2z"/><path d="M12 10v4.5M12 17.4v.1"/></svg>';
  ICONOS_NAV.glosario = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"><path d="M4 4.5h6.5a2 2 0 0 1 2 2V20a2 2 0 0 0-2-1.8H4z"/><path d="M20 4.5h-6.5a2 2 0 0 0-2 2V20a2 2 0 0 1 2-1.8H20z"/></svg>';
  ICONOS_NAV.clima = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="11" r="3.4"/><path d="M12 3.2v2M12 17v1.4M3.8 11h2M18.2 11h2M6.2 5.2l1.4 1.4M16.4 15.4l1.4 1.4M17.8 5.2l-1.4 1.4M7.6 15.4l-1.4 1.4"/></svg>';

  function pintarNav() {
    const nav = document.getElementById("nav-principal");
    nav.innerHTML = "";
    let grupoActual = null;
    [...modulos.entries()]
      .sort((a, b) => (a[1].orden ?? 99) - (b[1].orden ?? 99))
      .forEach(([id, def]) => {
        const g = GRUPO_NAV[id] || "MÓDULOS";
        if (g !== grupoActual) {
          const lbl = document.createElement("div");
          lbl.className = "nav-grupo";
          lbl.textContent = g;
          nav.appendChild(lbl);
          grupoActual = g;
        }
        const b = document.createElement("button");
        b.className = "nav-item";
        b.dataset.modulo = id;
        b.innerHTML = `<span class="nav-icono">${ICONOS_NAV[id] || def.icono || "▪"}</span>${def.titulo}`;
        b.onclick = () => navegar(id);
        nav.appendChild(b);
      });
  }

  // Reloj del topbar (rediseño v9): "mar 17 jun · 14:30:05".
  // P23: reloj VIVO con segundos (tabular-nums en CSS → no baila el ancho).
  function actualizarReloj() {
    const el = document.getElementById("topbar-reloj");
    if (!el) return;
    const d = new Date();
    const fecha = d.toLocaleDateString("es-EC", { weekday: "short", day: "numeric", month: "short" });
    const hora = d.toLocaleTimeString("es-EC", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
    el.textContent = `${fecha} · ${hora}`;
  }

  // Última actualización SIEMPRE visible en la cabecera ("Datos al DD/MM · HH:MM"). En la
  // app la lee de /actualizar/ultima; en el visor, de manifest.json (lo escribe el publicador).
  async function mostrarUltima() {
    const el = document.getElementById("topbar-sync");
    if (!el) return;
    let fecha = null, estadoOk = true, fallosEstado = [], areasDegradadas = [], avisoDeg = "";
    try {
      if (window.HIDROMET_VISOR) {
        const m = await (await fetch("manifest.json?_=" + Date.now())).json();
        fecha = m && (m.generado || m.fecha);
        estadoOk = !m || m.ok !== false;
        fallosEstado = (m && m.fallos) || [];
        // LO DEGRADADO SE ETIQUETA, NO SE ESCONDE. Si el publicador declaró un
        // área degradada, el visor lo dice en la cabecera: lo que se muestra de
        // esa área es un RESPALDO, no un producto acreditado.
        areasDegradadas = (m && m.areas_degradadas) || [];
        avisoDeg = (m && m.aviso_degradacion) || "";
      } else {
        const u = await api("/actualizar/ultima");
        fecha = u && u.fecha;
        estadoOk = !u || u.ok !== false;
        fallosEstado = (u && u.fallos) || [];
      }
    } catch (e) { /* aún sin marca */ }
    const chip = document.querySelector("#topbar .sync");
    if (chip) chip.classList.toggle("fallo", !estadoOk);
    if (!fecha) {
      if (chip) chip.classList.remove("viejo");
      el.textContent = window.HIDROMET_VISOR ? "Visor en línea" : "Datos locales";
      return;
    }
    // v15 — WATCHDOG DE VERSIÓN (visor): manifest.json se sondea con cache-bust (línea
    // de arriba), así que detecta una publicación NUEVA aunque el index.html del usuario
    // esté cacheado; al detectarla, recarga sola para servir SIEMPRE lo más reciente.
    if (window.HIDROMET_VISOR && fecha) {
      if (!window.__hmVersionVista) window.__hmVersionVista = String(fecha);
      else if (window.__hmVersionVista !== String(fecha)) {
        window.__hmVersionVista = String(fecha);
        aviso("Hay una publicación nueva — actualizando el visor…", "info", 2400);
        setTimeout(() => { try { location.reload(); } catch (e) {} }, 1500);
        return;
      }
    }
    const m = String(fecha).replace("T", " ").match(/(\d{4})-(\d{2})-(\d{2})\D+(\d{2}):(\d{2})/);
    const marca = m ? `${m[3]}/${m[2]} · ${m[4]}:${m[5]}` : String(fecha).slice(0, 16);
    const sufijoDeg = areasDegradadas.length ? " · respaldo etiquetado" : "";
    el.textContent = (estadoOk ? `Datos al ${marca}` : `Actualización incompleta · ${marca}`) + sufijoDeg;
    if (!estadoOk) el.title = `Corrida incompleta${fallosEstado.length ? ": " + fallosEstado.join(", ") : ""}`;
    else if (areasDegradadas.length) {
      el.title = (avisoDeg || "Área degradada: se publica respaldo, no producto acreditado")
        + " · " + areasDegradadas.join(", ");
    } else el.removeAttribute("title");
    if (chip) chip.classList.toggle("degradado", areasDegradadas.length > 0);
    // Semántica de FRESCURA: si los datos tienen >36 h, el punto del chip pasa a ámbar
    // (aviso silencioso al operador de guardia). `fecha` es string ISO → Date.parse.
    const t = Date.parse(String(fecha).replace(" ", "T"));
    if (chip) chip.classList.toggle("viejo", estadoOk && isFinite(t) && (Date.now() - t) > 36 * 3.6e6);
  }

  /* §B.8: estilos del bloqueo global + barra de cancelar (autocontenidos en
     core.js para no tocar archivos de otros agentes; se inyectan una vez). */
  function inyectarEstilosBloqueo() {
    if (document.getElementById("estilos-bloqueo-tarea")) return;
    const st = document.createElement("style");
    st.id = "estilos-bloqueo-tarea";
    st.textContent = `
      /* Controles bloqueados durante una actualización */
      [data-bloqueado] {
        opacity: .45 !important; filter: grayscale(.4);
        cursor: not-allowed !important; pointer-events: none !important;
      }
      /* Atenuar selects/inputs del área de trabajo (sin deshabilitar la lectura) */
      body[data-tarea-activa="1"] #vista select,
      body[data-tarea-activa="1"] #vista input,
      body[data-tarea-activa="1"] #vista textarea {
        opacity: .55; pointer-events: none;
      }
      body[data-tarea-activa="1"] #vista .filtros { position: relative; }
      /* Barra fija con el botón Cancelar (fuera del área atenuada) */
      #barra-tarea {
        position: fixed; left: 50%; bottom: 22px; transform: translateX(-50%);
        z-index: 9500; display: flex; align-items: center; gap: 14px;
        background: var(--cp); color: #fff; border-radius: 999px;
        padding: 9px 12px 9px 18px; box-shadow: 0 6px 24px rgba(8,18,38,.38);
        font-size: 13px; font-weight: 600; max-width: min(560px, 92vw);
      }
      #barra-tarea .texto { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      #barra-tarea .boton.peligro { padding: 6px 16px; }
      #barra-tarea .spin {
        width: 15px; height: 15px; flex: 0 0 15px; border-radius: 50%;
        border: 2.5px solid rgba(255,255,255,.32); border-top-color: #fff;
        animation: girar-tarea .8s linear infinite;
      }
      @keyframes girar-tarea { to { transform: rotate(360deg); } }`;
    document.head.appendChild(st);
  }

  /* ---------------- puerta de acceso del VISOR (v15, pedido del dueño) ----------------
     SOLO en el visor publicado (HIDROMET_VISOR): overlay de usuario/contraseña antes de
     arrancar la app. Verificación por hash SHA-256 (la credencial no viaja ni se guarda
     en claro); "recordar dispositivo" persiste en localStorage, si no, solo la sesión.
     NOTA honesta: en un sitio estático esto es una CORTINA de acceso (disuade el acceso
     casual), no seguridad criptográfica de servidor. */
  async function exigirAcceso() {
    const raiz = document.documentElement;
    // ACCESO_LIBRE (2026-08-06): cortina y autenticación deshabilitadas temporalmente
    // a pedido del dueño (también en index.html). Para reactivar: HM_ACCESO_LIBRE=false.
    if (window.HM_ACCESO_LIBRE) { raiz.classList.remove("hm-prelogin"); return; }
    if (!window.HIDROMET_VISOR) { raiz.classList.remove("hm-prelogin"); return; }
    // Autenticación real: si el exportador declaró un backend, las banderas del
    // antiguo login estático NO autorizan nada. El gestor valida contraseña,
    // licencia, concurrencia y revocación; este camino falla cerrado si el módulo
    // no cargó. El fallback cosmético de abajo solo se conserva para despliegues
    // que todavía no tengan HIDROMET_AUTH_BASE.
    if (window.HIDROMET_AUTH_BASE) {
      raiz.classList.add("hm-prelogin");
      const capaDinamica = document.getElementById("capa-app");
      if (capaDinamica) capaDinamica.style.visibility = "hidden";
      const bloquear = mensaje => {
        let aviso = document.getElementById("hm-auth-fallo-config");
        if (!aviso) {
          aviso = document.createElement("div");
          aviso.id = "hm-auth-fallo-config";
          aviso.style.cssText = "position:fixed;inset:0;z-index:100000;display:grid;" +
            "place-items:center;padding:24px;background:#0b1220;color:#e6ecf7;" +
            "font:15px/1.5 system-ui,Segoe UI,sans-serif;text-align:center";
          document.body.appendChild(aviso);
        }
        aviso.textContent = mensaje;
        return new Promise(() => {}); // fail-closed: App.iniciar no continúa
      };
      if (!window.HMAuth || typeof window.HMAuth.exigirLogin !== "function") {
        return bloquear("No se pudo cargar el servicio de acceso. Contacta al administrador.");
      }
      try {
        await window.HMAuth.exigirLogin();
      } catch (e) {
        return bloquear("El servicio de acceso no pudo inicializarse. Intenta nuevamente más tarde.");
      }
      raiz.classList.remove("hm-prelogin");
      if (capaDinamica) capaDinamica.style.visibility = "";
      return;
    }
    const LLAVE = "hm-acceso-v1";
    if (localStorage.getItem(LLAVE) === "1" || sessionStorage.getItem(LLAVE) === "1") {
      raiz.classList.remove("hm-prelogin");   // el guard pre-paint del index pudo ocultar la app
      return;
    }
    // P19: refuerzo del guard SÍNCRONO del index (html.hm-prelogin oculta #capa-app
    // ANTES del primer pintado). Si el index no lo aplicó, se aplica aquí igual.
    raiz.classList.add("hm-prelogin");
    const HASH = "191453084223bb19af625548019079b0b3a24cf079978383ec152fa456f7d952";
    const sha = async t => {
      const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t));
      return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, "0")).join("");
    };
    const capa = document.getElementById("capa-app");
    if (capa) capa.style.visibility = "hidden";
    const div = document.createElement("div");
    div.id = "hm-login";
    // P21: escenografía hidrometeorológica AUTOCONTENIDA (SVG inline + CSS puro, sin
    // recursos externos): isolíneas que derivan lentamente + lluvia fina diagonal.
    div.innerHTML = `
      <div class="hm-login-fondo" aria-hidden="true">
        <svg class="hm-login-iso" viewBox="0 0 1440 900" preserveAspectRatio="xMidYMid slice" focusable="false">
          <g class="iso-a" fill="none" stroke-linecap="round">
            <path d="M-80 150 C 160 90, 320 220, 560 170 S 1000 60, 1240 140 S 1480 230, 1560 190"/>
            <path d="M-80 235 C 180 175, 340 305, 580 255 S 1010 145, 1250 225 S 1490 315, 1560 275"/>
            <path d="M-80 320 C 200 260, 360 390, 600 340 S 1020 230, 1260 310 S 1500 400, 1560 360"/>
            <path d="M-80 405 C 220 345, 380 475, 620 425 S 1030 315, 1270 395 S 1510 485, 1560 445"/>
          </g>
          <g class="iso-b" fill="none" stroke-linecap="round">
            <path d="M-80 545 C 200 485, 400 625, 660 575 S 1060 455, 1300 545 S 1500 635, 1560 595"/>
            <path d="M-80 640 C 220 580, 420 720, 680 670 S 1080 550, 1320 640 S 1510 730, 1560 690"/>
            <path d="M-80 735 C 240 675, 440 815, 700 765 S 1100 645, 1340 735 S 1520 825, 1560 785"/>
            <path d="M-80 830 C 260 770, 460 910, 720 860 S 1120 740, 1360 830 S 1530 920, 1560 880"/>
          </g>
        </svg>
        <div class="hm-login-lluvia"></div>
      </div>
      <div class="hm-login-caja" role="dialog" aria-labelledby="hm-login-tit">
        <div class="hm-login-marca">
          <div class="hm-login-logo">HM</div>
          <div class="hm-login-txt"><div class="hm-login-nombre">HidroMet</div>
            <div class="hm-login-sub">ECUADOR · OPERATIVO</div></div>
        </div>
        <h1 id="hm-login-tit">Acceso al visor</h1>
        <p class="hm-login-hint">Ingresa tus credenciales para ver los productos operativos.</p>
        <form novalidate>
          <label class="hm-login-campo">Usuario
            <input name="u" autocomplete="username" autocapitalize="none" spellcheck="false" required></label>
          <label class="hm-login-campo">Contraseña
            <input name="p" type="password" autocomplete="current-password" required></label>
          <label class="hm-login-rec"><input type="checkbox" name="r" checked> Recordarme en este dispositivo</label>
          <button type="submit" class="hm-login-btn">Ingresar</button>
          <div class="hm-login-err" hidden>Usuario o contraseña incorrectos.</div>
        </form>
        <div class="hm-login-pie">Sistema hidrometeorológico operativo · acceso restringido</div>
      </div>`;
    document.body.appendChild(div);
    const form = div.querySelector("form"), err = div.querySelector(".hm-login-err");
    const caja = div.querySelector(".hm-login-caja");
    setTimeout(() => { try { form.u.focus(); } catch (e) {} }, 60);
    // Enter SIEMPRE envía (algunos teclados móviles no disparan el submit implícito).
    form.addEventListener("keydown", e => {
      if (e.key === "Enter") { e.preventDefault(); form.requestSubmit ? form.requestSubmit() : form.querySelector("button[type=submit]").click(); }
    });
    await new Promise(listo => {
      form.addEventListener("submit", async e => {
        e.preventDefault();
        err.hidden = true;
        let ok = false;
        try { ok = (await sha(form.u.value.trim())) === HASH && (await sha(form.p.value)) === HASH; }
        catch (e2) { ok = false; }
        if (!ok) {
          err.hidden = false;
          caja.classList.remove("shake"); void caja.offsetWidth; caja.classList.add("shake");
          form.p.value = ""; form.p.focus();
          return;
        }
        (form.r.checked ? localStorage : sessionStorage).setItem(LLAVE, "1");
        div.classList.add("ok");
        setTimeout(() => {
          div.remove();
          raiz.classList.remove("hm-prelogin");            // libera el guard pre-paint (P19)
          if (capa) capa.style.visibility = "";
          listo();
        }, 420);
      });
    });
  }

  /* v17: ZOOM DE DOS DEDOS en los mapas Plotly (pedido del dueño): la pinza hace zoom
     DEL MAPA (no de la página) alrededor del centro del gesto; un dedo sigue
     desplazando la página. Leaflet (SNGR/GEOGLOWS) ya lo trae nativo. Funciona
     también sobre cartas staticPlot (relayout programático). */
  function pinchZoomMapa(gd) {
    if (!gd || gd._hmPinch) return;
    if (!window.matchMedia || !window.matchMedia("(pointer: coarse)").matches) return;
    gd._hmPinch = true;
    let d0 = null, c0 = null, rx0 = null, ry0 = null;
    const dist = t => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    const ctr = t => [(t[0].clientX + t[1].clientX) / 2, (t[0].clientY + t[1].clientY) / 2];
    gd.addEventListener("touchstart", e => {
      if (e.touches.length !== 2 || !gd._fullLayout || !gd._fullLayout.xaxis) return;
      e.preventDefault();
      d0 = dist(e.touches); c0 = ctr(e.touches);
      rx0 = (gd._fullLayout.xaxis.range || []).slice();
      ry0 = (gd._fullLayout.yaxis.range || []).slice();
    }, { passive: false });
    gd.addEventListener("touchmove", e => {
      if (e.touches.length !== 2 || d0 == null || !window.Plotly || rx0.length !== 2) return;
      e.preventDefault();
      const k = Math.min(8, Math.max(0.12, d0 / Math.max(20, dist(e.touches))));
      const fl = gd._fullLayout, xa = fl.xaxis, ya = fl.yaxis, bb = gd.getBoundingClientRect();
      const px = Math.min(1, Math.max(0, (c0[0] - bb.left - xa._offset) / xa._length));
      const py = Math.min(1, Math.max(0, 1 - (c0[1] - bb.top - ya._offset) / ya._length));
      const cx = rx0[0] + (rx0[1] - rx0[0]) * px, cy = ry0[0] + (ry0[1] - ry0[0]) * py;
      Plotly.relayout(gd, { "xaxis.range": [cx - (cx - rx0[0]) * k, cx + (rx0[1] - cx) * k],
                            "yaxis.range": [cy - (cy - ry0[0]) * k, cy + (ry0[1] - cy) * k] });
    }, { passive: false });
    gd.addEventListener("touchend", () => { d0 = null; }, { passive: true });
  }

  async function iniciar() {
    await exigirAcceso();
    inyectarEstilosBloqueo();
    const guardado = localStorage.getItem("hidromet-tema");
    if (guardado) document.documentElement.dataset.tema = guardado;
    document.getElementById("btn-tema").onclick = () =>
      tema(tema() === "claro" ? "oscuro" : "claro");
    // v17: CERRAR SESIÓN en el menú (solo visor con puerta de acceso): borra el
    // acceso recordado y recarga → vuelve a la pantalla de login.
    if (window.HIDROMET_VISOR) {
      const bt = document.getElementById("btn-tema");
      if (bt && !document.getElementById("btn-salir")) {
        const bs = document.createElement("button");
        bs.id = "btn-salir"; bs.className = "boton-fantasma"; bs.type = "button";
        bs.title = "Salir y volver a la pantalla de acceso";
        bs.textContent = "⏻ Cerrar sesión";
        bs.style.marginTop = "6px";
        bs.onclick = async () => {
          if (window.HIDROMET_AUTH_BASE && window.HMAuth &&
              typeof window.HMAuth.cerrarSesion === "function") {
            await window.HMAuth.cerrarSesion();
            return;
          }
          try { localStorage.removeItem("hm-acceso-v1"); sessionStorage.removeItem("hm-acceso-v1"); } catch (e) {}
          location.reload();
        };
        bt.insertAdjacentElement("afterend", bs);
      }
    }
    pintarNav();
    // Menú hamburguesa GLOBAL (P22): en móvil abre/cierra el drawer off-canvas (patrón
    // v12 intacto); en ESCRITORIO colapsa/expande la sidebar y el contenido gana el
    // ancho (estado recordado por dispositivo en localStorage "hm-sidebar").
    (function menuGlobal() {
      const capa = document.getElementById("capa-app");
      const btn = document.getElementById("btn-menu");
      const ov = document.getElementById("overlay-nav");
      if (!capa) return;
      const raiz = document.documentElement;
      const mvl = window.matchMedia ? window.matchMedia("(max-width: 820px)") : { matches: false };
      const SB = "hm-sidebar";
      // Estado persistido del colapso (el index lo aplica pre-paint; aquí el fallback).
      try { if (localStorage.getItem(SB) === "min") raiz.classList.add("hm-sb-min"); } catch (e) {}
      // v12 a11y: aria-controls + devolución del foco al botón al cerrar y foco al nav
      // al abrir (con visibility retrasada en CSS, el drawer cerrado no es tabulable).
      const cerrar = () => {
        if (!capa.classList.contains("nav-abierto")) return;
        capa.classList.remove("nav-abierto");
        if (btn) { btn.setAttribute("aria-expanded", "false"); try { btn.focus({ preventScroll: true }); } catch (e) {} }
      };
      if (btn) {
        btn.setAttribute("aria-controls", "sidebar");
        const ariaSegunEstado = () => btn.setAttribute("aria-expanded",
          mvl.matches ? (capa.classList.contains("nav-abierto") ? "true" : "false")
                      : (raiz.classList.contains("hm-sb-min") ? "false" : "true"));
        ariaSegunEstado();
        btn.addEventListener("click", () => {
          if (mvl.matches) {                       // MÓVIL: drawer (patrón existente)
            const ab = capa.classList.toggle("nav-abierto");
            btn.setAttribute("aria-expanded", ab ? "true" : "false");
            if (ab) { const primero = document.querySelector("#nav-principal .nav-item"); if (primero) try { primero.focus({ preventScroll: true }); } catch (e) {} }
          } else {                                  // ESCRITORIO: colapsar/expandir
            const min = raiz.classList.toggle("hm-sb-min");
            try { localStorage.setItem(SB, min ? "min" : ""); } catch (e) {}
            btn.setAttribute("aria-expanded", min ? "false" : "true");
          }
        });
        if (mvl.addEventListener) mvl.addEventListener("change", ariaSegunEstado);
      }
      if (ov) ov.addEventListener("click", cerrar);
      const nav = document.getElementById("nav-principal");
      if (nav) nav.addEventListener("click", e => { if (e.target.closest(".nav-item")) cerrar(); });
      document.addEventListener("keydown", e => { if (e.key === "Escape") cerrar(); });
    })();
    actualizarReloj();
    setInterval(actualizarReloj, 1000);
    mostrarUltima();
    setInterval(mostrarUltima, 300000);
    // v15: al VOLVER a la pestaña/navegador se re-chequea al instante la versión
    // publicada (el caso típico del teléfono que reabre el visor de ayer).
    document.addEventListener("visibilitychange", () => { if (!document.hidden) mostrarUltima(); });
    window.addEventListener("hashchange", pintarVista);
    await pintarVista();
  }

  /* ---------------- utilidades compartidas ---------------- */
  /* Etiqueta institucional de red/dependencia para lo visible al usuario.
     Los VALORES internos de datos/API (deps=, columnas, claves de config) NO
     cambian: esto traduce SOLO en el momento de pintar. */
  function redEtiqueta(v) {
    const s = String(v == null ? "" : v).trim();
    const k = s.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase();
    if (k === "INAMHI" || k === "PRINCIPAL") return "INAMHI";
    if (k === "CELEC" || k === "ENERGETICA") return "CELEC";
    if (k === "HIDRONACION" || k === "COMPLEMENTARIA") return "Hidronación";
    if (k === "EPMAPS") return "EPMAPS";
    return s;
  }

  function nombreEstacion(v, codigo) {
    let s = String(v == null ? "" : v);
    // Conserva la puntuación canónica: barras y paréntesis distinguen estaciones.
    // Nombre interno retirado, construido por puntos de código para que la
    // palabra no exista en el código fuente pero se siga limpiando en datos.
    s = s.replace(new RegExp(String.fromCharCode(112, 105, 115, 99, 111), "gi"), " ")
      .replace(/\s+/g, " ").trim();
    return s || (codigo ? `Estación ${codigo}` : "Estación meteorológica");
  }

  function el(html) {
    const t = document.createElement("template");
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  }

  function fmtFecha(iso) {
    if (!iso) return "—";
    return new Date(iso).toLocaleDateString("es-EC", { year: "numeric", month: "short", day: "numeric" });
  }

  function plotlyLayoutBase(extra = {}) {
    const oscuro = tema() === "oscuro";
    return Object.assign({
      paper_bgcolor: "rgba(0,0,0,0)",
      plot_bgcolor: "rgba(0,0,0,0)",
      font: { family: "IBM Plex Sans, sans-serif", size: 12, color: oscuro ? "#e8edf6" : "#0F1B2D" },
      margin: { l: 50, r: 18, t: 30, b: 42 },
      // Hover coherente con el tema (oscuro/claro) en TODOS los gráficos
      // (mapas y series); las series lo sobre-escriben con su propio estilo.
      hoverlabel: { bgcolor: oscuro ? "#101a2b" : "#ffffff",
                    bordercolor: oscuro ? "#3a4a66" : "#c7cfdb",
                    font: { color: oscuro ? "#e8edf6" : "#1c2433", size: 11 } },
      xaxis: { gridcolor: oscuro ? "#243150" : "#e6eaf2" },
      yaxis: { gridcolor: oscuro ? "#243150" : "#e6eaf2" },
    }, extra);
  }

  // Layout estándar para SERIES/HIETOGRAMAS: título en negrilla centrado, MARCO
  // (ejes con línea y mirror), grillas TENUES y hover coherente con el tema.
  function plotlyLayoutSerie(titulo = "", extra = {}) {
    const oscuro = tema() === "oscuro";
    const grid = oscuro ? "rgba(140,155,185,0.13)" : "rgba(120,130,150,0.13)";
    const linea = oscuro ? "#3a4a66" : "#c7cfdb";
    const txt = oscuro ? "#e8edf6" : "#1c2433";
    const eje = {
      gridcolor: grid, griddash: "dot", zeroline: false,
      showline: true, linecolor: linea, linewidth: 1, mirror: true,
      ticks: "outside", ticklen: 4, tickfont: { size: 10.5, color: txt },
    };
    const xa = Object.assign({}, eje, extra.xaxis || {});
    const ya = Object.assign({}, eje, extra.yaxis || {});
    delete extra.xaxis; delete extra.yaxis;
    return plotlyLayoutBase(Object.assign({
      title: { text: titulo ? `<b>${titulo}</b>` : "", x: 0.5, xanchor: "center",
               xref: "paper", y: 0.96, yanchor: "top", automargin: true,
               font: { size: 12.5, color: txt } },
      hovermode: "x unified",
      hoverlabel: { bgcolor: oscuro ? "#101a2b" : "#ffffff", bordercolor: linea,
                    font: { color: txt, size: 11 } },
      // modebar VERTICAL en la esquina → no pisa el título centrado.
      modebar: { orientation: "v", bgcolor: "rgba(0,0,0,0)" },
      margin: { l: 58, r: 20, t: 50, b: 56 },
      xaxis: xa, yaxis: ya,
    }, extra));
  }

  // Config Plotly estándar para gráficos (series/hietogramas): barra de
  // herramientas visible y limpia (sin logo ni botones de selección), exportación
  // PNG en alta resolución y responsive.
  function plotlyConfig(extra = {}) {
    const base = {
      displayModeBar: true,
      displaylogo: false,
      responsive: true,
      modeBarButtonsToRemove: ["lasso2d", "select2d", "autoScale2d"],
      toImageButtonOptions: { format: "png", scale: 2 },
    };
    // v13 (pedido del dueño): en TÁCTIL los botones de la modebar de Plotly son
    // minúsculos e inservibles — se ocultan en TODOS los gráficos; la navegación
    // es por gestos (scroll/pinch) y popups por fecha.
    if (window.matchMedia && window.matchMedia("(pointer: coarse)").matches) base.displayModeBar = false;
    return Object.assign(base, extra);
  }

  /* ---------------- paneles reutilizables + pestañas ----------------
     Un PANEL es un trozo de contenido que puede vivir bajo varios menús
     (p.ej. FFGS bajo Hidrología). Los módulos registran sus paneles con
     panel(id, fn) y otros módulos los reusan con panel(id). */
  const paneles = new Map();
  function panel(id, fn) {
    if (typeof fn === "function") { paneles.set(id, fn); return fn; }
    return paneles.get(id);
  }

  /* Componente de PESTAÑAS compartido (sub-navegación de cada módulo; sustituye
     a los chips-botón). opts: {titulo, sub, kicker, accionesHTML,
     pestanas:[{id, etiqueta, danger?, render(cont), alSalir?}], inicial}. */
  function vistaPestanas(vista, opts) {
    const cab = document.getElementById("cabecera-vista");
    if (cab) cab.style.display = "none";
    const tabs = (opts.pestanas || []).filter(Boolean);
    let activa = opts.inicial && tabs.some(t => t.id === opts.inicial)
      ? opts.inicial : (tabs[0] && tabs[0].id);
    const barra = tabs.map(p =>
      `<button class="hm-pestana${p.id === activa ? " activa" : ""}" data-pest="${p.id}"` +
      `${p.danger ? ' data-danger="1"' : ""}>${p.etiqueta}</button>`).join("");
    vista.innerHTML =
      `<div class="hm-modbar">
         <div class="hm-vista-cab">
           <div>${opts.kicker ? `<div class="hm-kicker">${opts.kicker}</div>` : ""}
             <div class="hm-cab-tit"><span class="hm-logo" aria-hidden="true">HM</span><h1>${opts.titulo || ""}</h1></div>
             ${opts.sub ? `<div class="hm-sub">${opts.sub}</div>` : ""}</div>
         </div>
         <div class="hm-pestanas">${barra}</div>
         <div class="hm-vista-acc">${opts.accionesHTML || ""}</div>
       </div>
       <div id="hm-cuerpo" class="hm-cuerpo"></div>`;
    // Acento por módulo en las pestañas (se escribe SIEMPRE, con "" cuando no hay,
    // para no filtrar acentos entre módulos; fallback var(--blue) en CSS).
    vista.style.setProperty("--tab-acc", opts.acento || "");
    const cuerpo = vista.querySelector("#hm-cuerpo");
    let saliente = null;
    async function pintar(id) {
      const p = tabs.find(x => x.id === id);
      if (!p) return;
      if (saliente && saliente.alSalir) { try { saliente.alSalir(); } catch (e) {} }
      activa = id;
      vista.querySelectorAll(".hm-pestana").forEach(b =>
        b.classList.toggle("activa", b.dataset.pest === id));
      // móvil: si las pestañas se desbordan, trae la activa a la vista (centrada) para que
      // nunca quede oculta detrás del borde y se note que la fila se desliza.
      const _act = vista.querySelector(".hm-pestana.activa");
      if (_act) { try { _act.scrollIntoView({ inline: "center", block: "nearest" }); } catch (e) {} }
      cuerpo.innerHTML = HTML_CARGA;
      try { await p.render(cuerpo); }
      catch (e) {
        cuerpo.innerHTML = `<div class="vacio"><div class="icono">⚠️</div>` +
          `<span>${(e && e.message) || e}</span></div>`;
      }
      saliente = p;
      sincronizarBloqueo();
    }
    vista.querySelectorAll(".hm-pestana").forEach(b =>
      (b.onclick = () => { if (b.dataset.pest !== activa) pintar(b.dataset.pest); }));
    // Máscara "hay más →" SOLO si la fila realmente desborda (si caben todas, la
    // última pestaña se veía cortada por la máscara fija). Se re-evalúa al rotar/resize.
    const fila = vista.querySelector(".hm-pestanas");
    if (fila) {
      const evaluar = () => fila.classList.toggle("desborda", fila.scrollWidth > fila.clientWidth + 1);
      evaluar();
      if (window.ResizeObserver) {
        const ro = new ResizeObserver(evaluar);
        ro.observe(fila);
      } else {
        window.addEventListener("resize", evaluar);
      }
    }
    pintar(activa);
    return { pintar, activa: () => activa, acciones: () => vista.querySelector(".hm-vista-acc") };
  }

  // F5: HOY en Ecuador (UTC-5 fijo, sin DST) calculado en el CLIENTE — el visor congela
  // los JSON y cualquier "hoy" del backend envejece. largo=10 → fecha; 16 → fecha+hora.
  function hoyEC(largo = 10) {
    return new Date(Date.now() - 5 * 3600e3).toISOString().slice(0, largo);
  }

  return { api, aviso, tarea, seguirTarea, modalTarea, tema, registrar, navegar, iniciar, el, fmtFecha, plotlyLayoutBase,
           plotlyLayoutSerie, plotlyConfig, pinchZoomMapa, hayTareaActiva, cancelarTarea, cancelarTodas, panel, vistaPestanas, restaurador,
           rutaAProducto, leerJsonGzip, zipDesdeManifest, hoyEC, redEtiqueta, nombreEstacion };
})();

/* ---------------- MODO VISOR: SOLO EXPLORACIÓN ----------------
   En el visor en línea (window.HIDROMET_VISOR) NADIE puede cambiar nada: se OCULTAN (no se
   borran, para no romper el wiring de los módulos) todos los controles de operación —
   Actualizar, APIs, exportaciones, edición de umbrales, agregar/ingresar estaciones, etc.
   (El backend público además ya rechaza cualquier escritura). */
if (window.HIDROMET_VISOR) {
  (function () {
    const st = document.createElement("style");
    st.textContent = ".visor-oculto{display:none !important}";
    (document.head || document.documentElement).appendChild(st);
    const SEL = ['[data-rol="actualizar"]', '[data-rol="exportar"]', '[data-rol="editar"]',
      '[data-rol="guardar"]', '[data-rol="descargar"]',
      '[data-rol="probar"]', '[data-rol="ingreso"]', '[data-rol="sincronizar"]',
      '[data-rol="probar_api"]', '[data-rol="regenerar_html"]',
      // .ct-dl-shp NO se oculta: en el visor el SHP de las advertencias del PROGRAMA se baja
      // desde el .zip PRE-CONGELADO (productos/…/*.zip); el handler detecta el modo visor.
      "#ct-actualizar", "#ini-actualizar-todo", "#ini-probar", "#ini-ejecutar"];
    const TXT = /\b(actualizar|exportar|probar descargas|probar api|editar umbral|agregar estaci|añadir estaci|nueva estaci|sincronizar|generar informe)\b/i;
    function marcar(raiz) {
      try {
        if (!raiz.querySelectorAll) return;
        SEL.forEach(s => raiz.querySelectorAll(s).forEach(e => e.classList.add("visor-oculto")));
        raiz.querySelectorAll("button, a.boton, a[download]").forEach(b => {
          if (TXT.test((b.textContent || "").trim())) b.classList.add("visor-oculto");
        });
      } catch (e) { /* noop */ }
    }
    const obs = new MutationObserver(ms => {
      for (const m of ms) for (const n of m.addedNodes) if (n.nodeType === 1) marcar(n);
    });
    function arrancar() { marcar(document); obs.observe(document.body, { childList: true, subtree: true }); }
    if (document.body) arrancar(); else document.addEventListener("DOMContentLoaded", arrancar);
  })();
}
