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
  // familia salvo en el resumen de validación); sngr/eventos = lista completa. 'drop' añade
  // parámetros volátiles a ignorar para el fallback difuso.
  function _slugProducto(ruta, drop) {
    const [path, query] = String(ruta).split("?");
    const base = path.replace(/^\//, "");
    if (/\.(geojson|json|png|csv)$/i.test(base) && !query) return "productos/" + base;
    let pares = query ? query.split("&").filter(Boolean) : [];
    const quita = new Set(drop || []);
    if (base === "cartas/carta_datos") { quita.add("fin"); quita.add("corrido"); }
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

  async function apiVisor(ruta, opts = {}) {
    if ((opts.method || "GET").toUpperCase() !== "GET")
      throw new Error("Acción no disponible en el visor en línea (es de solo lectura).");
    // Intenta el archivo exacto; si no está, cae a versiones canónicas quitando filtros
    // volátiles (familia/deps/lookback) que no cambian la estructura del dato.
    for (const drop of [[], ["familia"], ["familia", "deps", "lookback", "ventana"]]) {
      let resp;
      try { resp = await fetch(_slugProducto(ruta, drop), { cache: "no-cache" }); }
      catch (e) { continue; }
      if (resp && resp.ok) return resp.json();
    }
    throw new Error("Este dato aún no está publicado en el visor.");
  }

  /* ---------------- avisos (toasts) ---------------- */
  function aviso(mensaje, tipo = "info", ms = 4200) {
    const caja = document.getElementById("avisos");
    if (!caja) return;
    const el = document.createElement("div");
    el.className = `aviso ${tipo}`;
    el.textContent = mensaje;
    caja.appendChild(el);
    setTimeout(() => el.remove(), ms);
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
        } catch (e) { tareasSeguidas.delete(id); restauradores.delete(id); }
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
      api("/config", { method: "POST", body: { tema: nuevo } }).catch(() => {});
      document.dispatchEvent(new CustomEvent("temacambiado", { detail: nuevo }));
    }
    return html.dataset.tema || "claro";
  }

  /* ---------------- registro y router ---------------- */
  function registrar(id, def) { modulos.set(id, def); }

  function navegar(id) { location.hash = "#/" + id; }

  function _moduloDefecto() {
    // En el VISOR no hay "inicio" (centro de operación): se aterriza en el primer
    // módulo de exploración registrado (menor orden).
    if (window.HIDROMET_VISOR) {
      const arr = [...modulos.entries()].sort((a, b) => (a[1].orden ?? 99) - (b[1].orden ?? 99));
      if (arr.length) return arr[0][0];
    }
    return "inicio";
  }

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
    vista.innerHTML = `<div class="vacio"><div class="icono">⏳</div>Cargando…</div>`;
    try {
      await def.render(vista, acciones);
    } catch (e) {
      vista.innerHTML = `<div class="vacio"><div class="icono">⚠️</div>
        <strong>No se pudo cargar este módulo</strong><span>${e && e.message}</span></div>`;
    }
    // §B.8: si una tarea sigue viva, los controles recién pintados por el módulo
    // deben nacer ya bloqueados (el router reemplazó todo el #vista).
    sincronizarBloqueo();
  }

  // Grupos de la barra lateral (rediseño v9): PRINCIPAL · MÓDULOS · SISTEMA.
  const GRUPO_NAV = { inicio: "PRINCIPAL",
                      pronostico: "MÓDULOS", validacion: "MÓDULOS", hidrologia: "MÓDULOS",
                      advertencias: "MÓDULOS", clima: "MÓDULOS", glosario: "MÓDULOS",
                      cartas: "MÓDULOS", sngr: "MÓDULOS", eventos: "MÓDULOS", mlnwp: "MÓDULOS",
                      datos: "SISTEMA", configuracion: "SISTEMA", config: "SISTEMA" };

  // Iconos SVG de línea del nav (rediseño v9, stroke:currentColor) — sustituyen a los emojis.
  const ICONOS_NAV = {
    inicio: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><rect x="3" y="3" width="7.5" height="7.5" rx="1.5"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="1.5"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.5"/></svg>',
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

  // Reloj del topbar (rediseño v9): "mar 17 jun · 14:30".
  function actualizarReloj() {
    const el = document.getElementById("topbar-reloj");
    if (!el) return;
    const d = new Date();
    const fecha = d.toLocaleDateString("es-EC", { weekday: "short", day: "numeric", month: "short" });
    const hora = d.toLocaleTimeString("es-EC", { hour: "2-digit", minute: "2-digit", hour12: false });
    el.textContent = `${fecha} · ${hora}`;
  }

  // Última actualización SIEMPRE visible en la cabecera ("Datos al DD/MM · HH:MM"). En la
  // app la lee de /actualizar/ultima; en el visor, de manifest.json (lo escribe el publicador).
  async function mostrarUltima() {
    const el = document.getElementById("topbar-sync");
    if (!el) return;
    let fecha = null;
    try {
      if (window.HIDROMET_VISOR) {
        const m = await (await fetch("manifest.json?_=" + Date.now())).json();
        fecha = m && (m.generado || m.fecha);
      } else {
        const u = await api("/actualizar/ultima");
        fecha = u && u.fecha;
      }
    } catch (e) { /* aún sin marca */ }
    const chip = document.querySelector("#topbar .sync");
    if (!fecha) {
      if (chip) chip.classList.remove("viejo");
      el.textContent = window.HIDROMET_VISOR ? "Visor en línea" : "Datos locales";
      return;
    }
    const m = String(fecha).replace("T", " ").match(/(\d{4})-(\d{2})-(\d{2})\D+(\d{2}):(\d{2})/);
    el.textContent = m ? `Datos al ${m[3]}/${m[2]} · ${m[4]}:${m[5]}` : ("Datos al " + String(fecha).slice(0, 16));
    // Semántica de FRESCURA: si los datos tienen >36 h, el punto del chip pasa a ámbar
    // (aviso silencioso al operador de guardia). `fecha` es string ISO → Date.parse.
    const t = Date.parse(String(fecha).replace(" ", "T"));
    if (chip) chip.classList.toggle("viejo", isFinite(t) && (Date.now() - t) > 36 * 3.6e6);
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

  async function iniciar() {
    inyectarEstilosBloqueo();
    const guardado = localStorage.getItem("hidromet-tema");
    if (guardado) document.documentElement.dataset.tema = guardado;
    document.getElementById("btn-tema").onclick = () =>
      tema(tema() === "claro" ? "oscuro" : "claro");
    pintarNav();
    actualizarReloj();
    setInterval(actualizarReloj, 30000);
    mostrarUltima();
    setInterval(mostrarUltima, 300000);
    window.addEventListener("hashchange", pintarVista);
    await pintarVista();
  }

  /* ---------------- utilidades compartidas ---------------- */
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
    return Object.assign({
      displayModeBar: true,
      displaylogo: false,
      responsive: true,
      modeBarButtonsToRemove: ["lasso2d", "select2d", "autoScale2d"],
      toImageButtonOptions: { format: "png", scale: 2 },
    }, extra);
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
             <h1>${opts.titulo || ""}</h1>
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
      cuerpo.innerHTML = `<div class="vacio"><div class="icono">⏳</div>Cargando…</div>`;
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
    pintar(activa);
    return { pintar, activa: () => activa, acciones: () => vista.querySelector(".hm-vista-acc") };
  }

  return { api, aviso, tarea, seguirTarea, modalTarea, tema, registrar, navegar, iniciar, el, fmtFecha, plotlyLayoutBase,
           plotlyLayoutSerie, plotlyConfig, hayTareaActiva, cancelarTarea, cancelarTodas, panel, vistaPestanas, restaurador,
           rutaAProducto };
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
      '[data-rol="guardar"]', '[data-rol="descargar"]', '[data-rol="ffr-exportar"]',
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
