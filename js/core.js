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
  // familia salvo en el resumen de validación). 'drop' añade
  // parámetros volátiles a ignorar para el fallback difuso.
  function _slugProducto(ruta, drop) {
    const [path, query] = String(ruta).split("?");
    const base = path.replace(/^\//, "");
    if (/\.(geojson|json|png|csv)$/i.test(base) && !query) return "productos/" + base;
    let pares = query ? query.split("&").filter(Boolean) : [];
    const quita = new Set(drop || []);
    if (base === "cartas/carta_datos") { quita.add("fin"); quita.add("corrido"); }
    // La referencia certifica el ciclo pedido al endpoint vivo, pero el artefacto
      if (base.indexOf("mlnwp/") === 0) { quita.add("deps"); if (base !== "mlnwp/validacion") quita.add("familia"); }
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
      const pct = progreso == null ? "" : ` ${fmtNum(progreso, 0)} %`;
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
  const GRUPO_NAV = { pronostico: "MÓDULOS", validacion: "MÓDULOS",
                      advertencias: "MÓDULOS", clima: "MÓDULOS", glosario: "MÓDULOS",
                      cartas: "MÓDULOS", mlnwp: "MÓDULOS",
                      datos: "SISTEMA", configuracion: "SISTEMA", config: "SISTEMA" };

  // Iconos SVG de línea del nav (rediseño v9, stroke:currentColor) — sustituyen a los emojis.
  const ICONOS_NAV = {
    cartas: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"><path d="M3 7l6-3 6 3 6-3v13l-6 3-6-3-6 3z"/><path d="M9 4v13M15 7v13"/></svg>',
    mlnwp: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M3 21h18"/><rect x="4" y="12" width="3.6" height="6" rx="1"/><rect x="10.2" y="7" width="3.6" height="11" rx="1"/><rect x="16.4" y="4" width="3.6" height="14" rx="1"/></svg>',
    datos: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><ellipse cx="12" cy="5.5" rx="7.5" ry="2.8"/><path d="M4.5 5.5v6c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8v-6"/><path d="M4.5 11.5v6c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8v-6"/></svg>',
    configuracion: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><circle cx="7" cy="8" r="2.2"/><circle cx="16" cy="16" r="2.2"/><path d="M3 8h2M9.2 8H21M3 16h10.8M18.2 16H21"/></svg>',
  };
  // Nuevos módulos (reestructura de menús): reutilizan/derivan iconos coherentes.
  ICONOS_NAV.pronostico = ICONOS_NAV.cartas;
  ICONOS_NAV.validacion = ICONOS_NAV.mlnwp;
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

  // Nombres de pantalla de las áreas internas del programa (mlnwp:F2, cartas:F1…):
  // al público nunca se le enseñan los códigos crudos ni las notas internas.
  const NOMBRES_AREA = {
    mlnwp: "Pronóstico por aprendizaje automático",
    cartas: "Mapas de pronóstico y alertas",
    observaciones: "Observaciones de estaciones",
    clima: "Climatología",
    // El parte de degradación no solo trae áreas de CONTENIDO: también trae el
    // área de la ETAPA que anotó el aviso ("qc-fisico", "gate", "export"…).
    // Sin traducción salían crudas al tooltip público —"Secciones afectadas:
    // …, qc-fisico, gate"—, justo los códigos internos que este bloque promete
    // no enseñar. Están TODAS las que registran actualizador.py y
    // estado_actualizacion.py (lo verifica hidromet/tests).
    "qc-fisico": "Control físico del dato",
    gate: "Control de publicación",
    calidad: "Control de calidad",
    "pre-export": "Preparación de la publicación",
    export: "Publicación del visor",
    "post-export": "Cierre de la publicación",
    outbox: "Envío de la publicación",
    sla: "Tiempos de la actualización",
    ml: "Pronóstico por aprendizaje automático",
    "bases-nuevas": "Bases de datos del sistema",
  };
  function nombreArea(cod) {
    const base = String(cod == null ? "" : cod).split(":")[0].trim().toLowerCase();
    return NOMBRES_AREA[base] || String(cod);
  }

  // "hace 6 días" a partir del instante del dato (ms desde época).
  function textoAntiguedad(t) {
    if (!isFinite(t)) return "";
    const h = (Date.now() - t) / 3.6e6;
    if (h < 0) return "";
    if (h < 1) return "hace menos de 1 hora";
    if (h < 24) { const n = Math.round(h); return `hace ${n} hora${n === 1 ? "" : "s"}`; }
    const d = Math.floor(h / 24);
    return `hace ${d} día${d === 1 ? "" : "s"}`;
  }

  // Banda de aviso fija bajo la barra superior (frescura/estado); sin líneas se quita.
  function bandaEstadoDatos(lineas) {
    let banda = document.getElementById("banda-estado-datos");
    if (!lineas || !lineas.length) { if (banda) banda.remove(); return; }
    if (!banda) {
      banda = document.createElement("div");
      banda.id = "banda-estado-datos";
      banda.setAttribute("role", "status");
      const topbar = document.getElementById("topbar");
      if (topbar) topbar.insertAdjacentElement("afterend", banda);
      else document.body.prepend(banda);
    }
    banda.textContent = lineas.join(" ");
  }

  // Última actualización SIEMPRE visible en la cabecera ("Datos al DD/MM/AAAA · HH:MM ·
  // hace N días"). En la app la lee de /actualizar/ultima; en el visor, de manifest.json
  // (lo escribe el publicador) más el parte detallado productos/estado_degradado.json.
  async function mostrarUltima() {
    const el = document.getElementById("topbar-sync");
    if (!el) return;
    let fecha = null, estadoOk = true, fallosEstado = [], areasDegradadas = [];
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
        // (m.aviso_degradacion es una nota interna del programa: NO se muestra al público.)
        // El parte DETALLADO de áreas caídas manda sobre el resumen del manifest:
        // si enumera áreas, el visor no puede decir "todo correcto". Puede no estar
        // publicado: se tolera y se sigue solo con el manifest.
        try {
          const rd = await fetch("productos/estado_degradado.json", { cache: "no-cache" });
          if (rd.ok) {
            const deg = await rd.json();
            for (const d of ((deg && deg.degradado) || []))
              if (d && d.area && !areasDegradadas.includes(d.area)) areasDegradadas.push(d.area);
          }
        } catch (e) { /* sin parte detallado */ }
      } else {
        const u = await api("/actualizar/ultima");
        fecha = u && u.fecha;
        estadoOk = !u || u.ok !== false;
        fallosEstado = (u && u.fallos) || [];
      }
    } catch (e) { /* aún sin marca */ }
    const chip = document.querySelector("#topbar .sync");
    if (chip) chip.classList.toggle("fallo", !estadoOk);
    if (chip) chip.classList.toggle("desconocido", !fecha && !!window.HIDROMET_VISOR);
    if (!fecha) {
      // Estado DESCONOCIDO en el visor: sin marca de publicación no se puede decir
      // que todo va bien — punto gris sin latido y texto honesto, nunca el verde.
      if (chip) chip.classList.remove("viejo");
      el.textContent = window.HIDROMET_VISOR ? "No se pudo comprobar la fecha de los datos" : "Datos locales";
      if (window.HIDROMET_VISOR)
        el.title = "No se pudo leer el estado de la publicación; se desconoce de cuándo son los datos.";
      bandaEstadoDatos([]);
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
    // Con AÑO: parado un año entero, "22/08" se leería como si fuera de este año.
    const marca = m ? `${m[3]}/${m[2]}/${m[1]} · ${m[4]}:${m[5]}` : String(fecha).slice(0, 16);
    // `fecha` es string ISO → Date.parse; con ella se calcula la ANTIGÜEDAD visible.
    const t = Date.parse(m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}` : String(fecha).replace(" ", "T"));
    const antig = textoAntiguedad(t);
    const nombresDeg = [...new Set(areasDegradadas.map(nombreArea))];
    el.textContent = (estadoOk ? `Datos al ${marca}` : `Actualización incompleta · ${marca}`)
      + (antig ? ` · ${antig}` : "") + (nombresDeg.length ? " · con avisos" : "");
    // Explicación en LLANO: nada de códigos internos ni notas del programa
    // (el "DEGRADADO POR ORDEN DEL DUEÑO…" del manifest no se enseña tal cual).
    if (!estadoOk) el.title = `La última actualización quedó incompleta${fallosEstado.length ? ": " + fallosEstado.join(", ") : ""}`;
    else if (nombresDeg.length) {
      el.title = "Parte del contenido se muestra como respaldo provisional, sin verificación completa. "
        + "Secciones afectadas: " + nombresDeg.join(", ");
    } else el.removeAttribute("title");
    if (chip) chip.classList.toggle("degradado", nombresDeg.length > 0);
    // Semántica de FRESCURA: si los datos tienen >36 h, el punto del chip pasa a ámbar
    // (aviso silencioso al operador de guardia); por encima de 48 h, además, aparece
    // una banda fija bajo la barra superior con la frase completa.
    if (chip) chip.classList.toggle("viejo", estadoOk && isFinite(t) && (Date.now() - t) > 36 * 3.6e6);
    const lineas = [];
    if (isFinite(t) && (Date.now() - t) > 48 * 3.6e6) {
      const fLarga = new Date(t).toLocaleDateString("es-EC", { day: "numeric", month: "long", year: "numeric" });
      lineas.push(`Estos datos no se actualizan desde el ${fLarga} (${antig}).`);
    }
    if (!estadoOk) lineas.push("La última actualización quedó incompleta.");
    if (nombresDeg.length)
      lineas.push(`Secciones con datos provisionales o incompletos: ${nombresDeg.join(", ")}.`);
    bandaEstadoDatos(lineas);
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
      @keyframes girar-tarea { to { transform: rotate(360deg); } }
      /* Estado de los datos: banda fija bajo la barra superior + chip "desconocido" */
      #banda-estado-datos {
        flex: none; background: #8a4b00; color: #fff; padding: 7px 18px;
        font-size: 13px; line-height: 1.45; font-weight: 600;
      }
      #topbar .sync.desconocido .punto {
        background: #98A2B3 !important; box-shadow: none !important; animation: none !important;
      }`;
    document.head.appendChild(st);
  }


  /* v17: ZOOM DE DOS DEDOS en los mapas Plotly (pedido del dueño): la pinza hace zoom
     DEL MAPA (no de la página) alrededor del centro del gesto; un dedo sigue
     desplazando la página. Funciona
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

  /* Fechas de los GRÁFICOS en español: se registra de inmediato un idioma "es"
     mínimo (meses y días en español, formato de fecha manual) para que el primer
     gráfico ya salga traducido; si el fichero de idioma oficial está publicado en
     lib/plotly/, se carga encima (trae además la barra de herramientas traducida).
     Si no existe, el fallo de carga se ignora y queda el idioma mínimo. */
  function idiomaGraficos() {
    if (!window.Plotly || typeof Plotly.register !== "function") return;
    try {
      Plotly.register({
        moduleType: "locale", name: "es", dictionary: {},
        format: {
          days: ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"],
          shortDays: ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"],
          months: ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio",
                   "agosto", "septiembre", "octubre", "noviembre", "diciembre"],
          shortMonths: ["ene", "feb", "mar", "abr", "may", "jun",
                        "jul", "ago", "sep", "oct", "nov", "dic"],
          date: "%d/%m/%Y",
          // Los números DENTRO del gráfico (globos de datos, rótulos de eje)
          // los escribe la propia librería: sin esto salían con el punto
          // decimal del inglés («2.3») en toda la aplicación.
          decimal: ",",
          thousands: ".",
          grouping: [3],
          currency: ["", " $"],
        },
      });
      Plotly.setPlotConfig({ locale: "es" });
    } catch (e) { return; /* la librería seguirá en inglés */ }
    const s = document.createElement("script");
    s.src = "lib/plotly/plotly-locale-es.js";
    s.onload = () => { try { Plotly.setPlotConfig({ locale: "es" }); } catch (e) {} };
    s.onerror = () => { try { s.remove(); } catch (e) {} };
    document.head.appendChild(s);
  }

  async function iniciar() {
    inyectarEstilosBloqueo();
    idiomaGraficos();
    const guardado = localStorage.getItem("hidromet-tema");
    if (guardado) document.documentElement.dataset.tema = guardado;
    document.getElementById("btn-tema").onclick = () =>
      tema(tema() === "claro" ? "oscuro" : "claro");
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

  /* ---------------- números en castellano ----------------
     En castellano la COMA separa los decimales y el PUNTO los millares; las
     cifras de cuatro dígitos —un año, una altitud— se escriben de corrido, sin
     separador (2026, 2800 m). El punto del código («2.3») era el de la máquina.

     Este es el ÚNICO sitio donde la aplicación convierte un número en texto de
     PANTALLA. Todo lo que no se lee —una posición en CSS, un parámetro de la
     API, una clave de caché, un valor que viaja a otro sitio— sigue usando el
     punto decimal del lenguaje y NO debe pasar por aquí.

     opciones: {minimos} decimales que se conservan aunque sean ceros (por
     defecto, todos); {agrupar:false} nunca agrupa millares; {signo:true}
     escribe también el «+»; {vacio} qué devolver sin número (por defecto «—»). */
  function fmtNum(valor, decimales = 0, opciones = {}) {
    const n = typeof valor === "number" ? valor : Number(valor);
    if (valor === null || valor === undefined || valor === "" || !Number.isFinite(n))
      return opciones.vacio === undefined ? "—" : opciones.vacio;
    const max = Math.max(0, Math.min(20, Math.trunc(Number(decimales) || 0)));
    const min = opciones.minimos === undefined ? max
      : Math.max(0, Math.min(max, Math.trunc(Number(opciones.minimos) || 0)));
    let cuerpo = Math.abs(n).toFixed(max);
    if (min < max && cuerpo.indexOf(".") >= 0)
      cuerpo = cuerpo.replace(/0+$/, "").replace(/\.$/, "");
    const partes = cuerpo.split(".");
    let entero = partes[0];
    let decimal = partes[1] || "";
    while (decimal.length < min) decimal += "0";
    // Millares solo a partir de CINCO cifras: así un año nunca sale «2.026».
    if (opciones.agrupar !== false && entero.length > 4)
      entero = entero.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
    const cero = Number(cuerpo) === 0;
    const signo = (n < 0 && !cero) ? "−" : (opciones.signo === true && !cero ? "+" : "");
    return signo + entero + (decimal ? "," + decimal : "");
  }

  // Mismo formato con el signo SIEMPRE delante (+ / −): un sesgo se lee sabiendo
  // hacia qué lado se desvía, sin ir a buscarlo a la leyenda. El cero no lleva signo.
  function fmtSigno(valor, decimales = 1, opciones = {}) {
    return fmtNum(valor, decimales, Object.assign({}, opciones, { signo: true }));
  }

  /* ---------------- texto que ESCRIBE EL SERVIDOR ----------------
     Algunos productos traen un campo de texto libre —un diagnóstico, un aviso—
     que la pantalla imprimía tal cual. Hoy llegan limpios, pero por ese mismo
     campo viajan mensajes internos: códigos en mayúsculas, nombres de módulo,
     rutas de fichero, el texto de una excepción. Nada de eso significa nada
     para quien mira el tiempo.

     La puerta se cierra en dos tiempos: lo CONOCIDO se traduce a una frase del
     usuario; lo desconocido pasa solo si está escrito en castellano llano y se
     descarta si trae rastro técnico. Ningún dato se retiene por esto: se
     descarta una FRASE, nunca una fila ni un modelo. */
  const TRADUCCION_SERVIDOR = [
    [/NO_CAMS_AUTHORITY|no existe una partici[oó]n CAMS/i,
      "Todavía no hay campos de índice UV para esta emisión."],
    [/base \d+ vac[ií]a/i, "Todavía no hay índice UV publicado."],
    [/sin pron[oó]stico UV para/i,
      "No hay pronóstico de índice UV para la fecha pedida."],
    [/modelos no reconocidos/i,
      "Se omitieron campos que esta versión no reconoce."],
    [/fuera del cat[aá]logo/i,
      "Hay estaciones con pronóstico que todavía no están en el catálogo: se omiten."],
    [/estado del puente UV/i,
      "Sin el parte del día: no hay hora de captura ni medición de control de Jipijapa."],
    [/shapefile|sin regiones/i, "Las estaciones se muestran sin su región."],
    [/residual medio obs|walk-?forward/i,
      "Corrección local experimental y no acreditada: sale de los últimos pares medidos "
      + "en Jipijapa y pierde fuerza con la distancia."],
    [/PARTIAL_PENDING|esperan referencia corregida/i,
      "Faltan por comprobar los días más recientes: su referencia todavía no está corregida."],
    [/pendientes en otros\s+productos|no tiene pendientes\s+atribuidos/i,
      "Otras variables tienen días por comprobar; esta no."],
    [/no desglosa el [aá]mbito/i,
      "Quedan días por comprobar, sin poder atribuirlos a esta variable."],
    [/El resumen (estricto )?declara|discrepan en filas|no se puede leer el Parquet/i,
      "La comprobación publicada no se pudo leer entera."],
    [/No se puede agregar la evidencia/i,
      "No se pudo resumir la comprobación de estas advertencias."],
  ];
  // Rastro de máquina: si aparece, la frase no se enseña.
  const RASTRO_TECNICO = [
    /[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]+/,                 // clave_interna, NO_CAMS_AUTHORITY
    /\b[\w.]+\.(py|js|json|parquet|csv|yaml|yml|log|txt|zip|db|sqlite|shp|shx|dbf|nc|tif|tiff|npz|pkl|grib2?)\b/i,
    /\b(exp|log|ln|sqrt|abs|round)\s*\(|\b\w\s*\/\s*\(\s*\w/i,  // una fórmula suelta
    /\b(walk[- ]?forward|out[- ]?of[- ]?sample|cross[- ]?validation|shrink|smearing|lookback|backfill|shapefile|rolling|threshold)\b/i,
    /\b(hidromet|app|ui|scripts|modulos|nucleo|rutas|motores)\.[a-z]/i,
    /[\\/][\w.-]+[\\/]/,                                   // una ruta de fichero
    /\b(traceback|exception|stacktrace|stderr|stdout|parquet|dataframe|schema|payload|endpoint|sha256|commit|nan|null|none|true|false)\b/i,
    /\b(PASS|FAIL|WARN|WARNING|ERROR|PENDING|SKIP|TODO|DEBUG|INFO|TRACE)\b/,
    /\bbase \d\b/i,                                        // numeración interna de las bases
    /[{}<>[\]]|=\s*\S/,                                    // plantillas y asignaciones
  ];
  function textoServidor(bruto) {
    const s = String(bruto === null || bruto === undefined ? "" : bruto)
      .replace(/\s+/g, " ").trim();
    if (!s) return "";
    for (const [re, texto] of TRADUCCION_SERVIDOR) if (re.test(s)) return texto;
    for (const re of RASTRO_TECNICO) if (re.test(s)) return "";
    return s;
  }
  // Varias frases a la vez: traduce, descarta las técnicas y quita repetidas.
  function textosServidor(lista) {
    const arr = Array.isArray(lista) ? lista : (lista === null || lista === undefined ? [] : [lista]);
    const vistos = new Set();
    const salida = [];
    for (const item of arr) {
      const t = textoServidor(item);
      if (t && !vistos.has(t)) { vistos.add(t); salida.push(t); }
    }
    return salida;
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
     Los módulos registran sus paneles con
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
           rutaAProducto, leerJsonGzip, hoyEC, redEtiqueta, nombreEstacion,
           fmtNum, fmtSigno, textoServidor, textosServidor };
})();

/* Superficie pura para las pruebas en Node (formateo de números en castellano y
   filtro del texto que escribe el servidor). En el navegador no se expone
   ningún global adicional: `module` no existe. */
if (typeof module === "object" && module.exports) module.exports = Object.freeze({
  fmtNum: App.fmtNum, fmtSigno: App.fmtSigno,
  textoServidor: App.textoServidor, textosServidor: App.textosServidor,
});

/* ---------------- MODO VISOR: SOLO EXPLORACIÓN ----------------
   En el visor en línea (window.HIDROMET_VISOR) NADIE puede cambiar nada: se OCULTAN (no se
   borran, para no romper el wiring de los módulos) todos los controles de operación —
   Actualizar, APIs, exportaciones, edición de umbrales, agregar/ingresar estaciones, etc.
   (El backend público además ya rechaza cualquier escritura). */
if (window.HIDROMET_VISOR && typeof document !== "undefined"
    && typeof document.createElement === "function"
    && typeof MutationObserver === "function") {
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
