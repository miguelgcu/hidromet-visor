/* ============================================================
   HidroMet — Módulo INICIO (Dashboard + Centro de actualización)
   Rediseño v9. Fiel a Diseño/HANDOFF/diseno/HidroMet.dc.html
   (bloque vInicio). Arquitectura intacta: App.registrar / App.api /
   App.tarea / App.aviso / App.navegar.
   Datos reales (verificados en app/rutas/*.py):
     - /estado            → {modulos:{cartas,sngr,mlnwp,datos}} con
                            {disponible,titulo,detalle,metricas:[{etiqueta,valor}],
                             frescura(ISO|null),alerta(str|null)}
     - /actualizar/global → App.tarea("/actualizar/global",{areas,modelos})
                            (areas ∈ observaciones|cartas|sngr|mlnwp; el log emite
                             el marcador "——— Etapa i/N: <etiqueta> ———")
     - /datos/credenciales→ {resumen:{cartas_ok,meteoblue_ok,sngr_ok},
                             meteoblue:{activas,...}, sngr:{...}}
     - /mlnwp/resumen?dia=0→ {filas:[{region,riesgo_precip,riesgo_tmax,riesgo_tmin}],...}
                            (niveles: "No aplica"|"Medio"|"Alto"|"Muy Alto")
   ============================================================ */
"use strict";

(() => {
  const esc = v => String(v ?? "").replace(/[&<>"']/g,
    c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  /* ---------- iconos SVG de línea (stroke:currentColor) — NO emojis ---------- */
  const ICO = {
    refrescar: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v5h-5"/></svg>',
    reloj: '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
    cartas: '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"><path d="M3 7l6-3 6 3 6-3v13l-6 3-6-3-6 3z"/><path d="M9 4v13M15 7v13"/></svg>',
    sngr: '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M3 8c2.5 0 2.5 2 5 2s2.5-2 5-2 2.5 2 5 2"/><path d="M3 14c2.5 0 2.5 2 5 2s2.5-2 5-2 2.5 2 5 2"/></svg>',
    mlnwp: '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21h18"/><rect x="4" y="12" width="3.6" height="6" rx="1"/><rect x="10.2" y="7" width="3.6" height="11" rx="1"/><rect x="16.4" y="4" width="3.6" height="14" rx="1"/></svg>',
    datos: '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><ellipse cx="12" cy="5.5" rx="7.5" ry="2.8"/><path d="M4.5 5.5v6c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8v-6"/><path d="M4.5 11.5v6c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8v-6"/></svg>',
    // iconos de área (centro de actualización)
    aCartas: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"><path d="M9 3 3 5v16l6-2 6 2 6-2V3l-6 2-6-2z"/><path d="M9 3v16M15 5v16"/></svg>',
    aSngr: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M3 9c2.5 0 2.5 2 5 2s2.5-2 5-2 2.5 2 5 2"/><path d="M3 15c2.5 0 2.5 2 5 2s2.5-2 5-2 2.5 2 5 2"/></svg>',
    aObs: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/></svg>',
    aMl: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><path d="m7 14 3.5-4 3 3L21 7"/></svg>',
    flecha: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
  };

  /* ---------- tinte del cuadro de icono por módulo (fondo, color) ---------- */
  const TINTE = {
    cartas: ["var(--blue-50)", "var(--blue)"],
    sngr:   ["var(--cyan-50)", "var(--cyan)"],
    mlnwp:  ["var(--ml-purple-bg)", "var(--ml-purple)"],
    datos:  ["var(--surface-3)", "var(--slate)"],
  };
  // En la dc.html el cuadro de icono de ML usa #F0ECFB; aquí se usa el token
  // --ml-purple-bg (equivalente claro) para que el tinte respete el tema oscuro.

  const ORDEN = ["cartas", "sngr", "mlnwp", "datos"];
  // Las tarjetas del dashboard son por ÁREA de datos; navegan al menú nuevo más afín.
  // ML-NWP ya no es módulo propio: su vista es la pestaña "Series, validación e IA"
  // dentro de Pronóstico, así que la tarjeta navega a "pronostico".
  const RUTA_NAV = { cartas: "pronostico", sngr: "hidrologia", mlnwp: "pronostico", datos: "datos" };
  const ETIQUETA_CARD = { cartas: "Pronóstico y advertencias", sngr: "Hidrología", mlnwp: "Validación NWP-ML" };

  const saludo = () => {
    const h = new Date().getHours();
    return h < 12 ? "Buenos días" : h < 19 ? "Buenas tardes" : "Buenas noches";
  };

  /* Frescura legible a partir del ISO de /estado (o del texto si ya viene formado). */
  function frescuraTexto(m) {
    const f = m.frescura;
    if (!f) return null;
    // SNGR ya entrega una frase ("Último evento: …"); cartas/ml entregan ISO.
    if (/[A-Za-z]/.test(f) && !/\dT\d/.test(f)) return f;
    const d = new Date(f);
    if (isNaN(d)) return f;
    const horas = Math.max(0, Math.round((Date.now() - d.getTime()) / 3.6e6));
    if (horas < 1) return "actualizado hace minutos";
    if (horas < 48) return `actualizado hace ${horas} h`;
    return "actualizado el " + d.toLocaleDateString("es-EC", { day: "numeric", month: "short" });
  }

  /* Badge de estado de la tarjeta: ACTIVO (ok) / N AVISO (warn) / No disponible. */
  function badgeModulo(m) {
    if (!m.disponible) return `<span class="etiqueta peligro">No disponible</span>`;
    if (m.alerta) return `<span class="etiqueta aviso">1 aviso</span>`;
    return `<span class="etiqueta ok">Activo</span>`;
  }

  /* Las métricas del backend son [{etiqueta,valor}]. Mostramos las 2 primeras.
     La primera (recuento principal) en tono normal; si la etiqueta sugiere
     alertas/avisos se tiñe en danger (paridad con la dc.html). */
  function metricasModulo(m) {
    const metr = (m.metricas || []).slice(0, 2);
    if (!metr.length) return "";
    return `<div class="ini-card-metricas">${metr.map(x => {
      const peligro = /alerta|aviso/i.test(x.etiqueta);
      return `<div class="metrica${peligro ? " peligro" : ""}">
          <span class="valor">${esc(x.valor)}</span>
          <span class="etiqueta-metrica">${esc(x.etiqueta)}</span>
        </div>`;
    }).join("")}</div>`;
  }

  function tarjetaModulo(id, m) {
    const [bg, col] = TINTE[id] || ["var(--surface-3)", "var(--slate)"];
    const fresca = frescuraTexto(m);
    const titulo = ETIQUETA_CARD[id] || m.titulo || id;
    return `
    <article class="ini-card-mod" data-modulo="${id}" tabindex="0" role="button"
             title="Abrir ${esc(titulo)}">
      <div class="ini-card-top">
        <span class="ini-card-ico" style="background:${bg};color:${col}">${ICO[id] || ""}</span>
        ${badgeModulo(m)}
      </div>
      <h4 class="ini-card-titulo">${esc(titulo)}</h4>
      <div class="ini-card-detalle">${esc(m.detalle || "")}</div>
      ${metricasModulo(m)}
      ${fresca ? `<div class="ini-card-pie">${ICO.reloj} ${esc(fresca)}</div>` : ""}
    </article>`;
  }

  /* ============ Centro de actualización ============ */
  // Modelos de pronóstico seleccionables. id = clave del backend (CARTAS_DIRECT_MODELS /
  // MODELOS_VALIDOS), label = nombre legible. GFS/ICON/IFS HRES arrancan ON; IFS ENS y AIFS
  // son OPT-IN (ECMWF, más pesados/lentos) → arrancan OFF, el usuario los enciende si quiere.
  const MODELOS_ACT = [
    { id: "GFS",     label: "GFS" },
    { id: "ICON",    label: "ICON" },
    { id: "IFS",     label: "IFS HRES" },
    { id: "IFS-ENS", label: "IFS ENS", opt: true },
    { id: "AIFS",    label: "AIFS", opt: true },
  ];
  const AREAS = [
    { id: "cartas", titulo: "Cartas y alertas", ico: ICO.aCartas,
      desc: "Descarga pronósticos y rehace cartas y alertas.", modelos: MODELOS_ACT },
    { id: "sngr", titulo: "Eventos de ríos", ico: ICO.aSngr,
      desc: "Trae los reportes nuevos y los comparte con las cartas." },
    { id: "observaciones", titulo: "Observaciones", ico: ICO.aObs,
      desc: "Lee los Excel de la bandeja y los suma a las bases." },
    { id: "mlnwp", titulo: "Validación ML", ico: ICO.aMl,
      desc: "Recalifica los modelos y actualiza la validación." },
  ];

  function tarjetaArea(a) {
    const chips = (a.modelos || []).map(m =>
      `<span class="ini-act-chip${m.opt ? " opcional" : ""}" data-modelo="${esc(m.id)}"${
        m.opt ? ' title="Opcional (ECMWF · más pesado y lento)"' : ""}>${esc(m.label)}</span>`).join("");
    return `
    <div class="ini-act-tarjeta" data-area="${a.id}">
      <div class="ini-act-cab">
        <span class="ini-act-nombre">${a.ico}${esc(a.titulo)}</span>
        <button type="button" class="ini-switch activo" role="switch" aria-checked="true"
                title="Incluir en la actualización"><span class="ini-switch-bola"></span></button>
      </div>
      <div class="ini-act-desc">${esc(a.desc)}</div>
      ${chips ? `<div class="ini-act-chips">${chips}</div>` : ""}
    </div>`;
  }

  function centroHTML() {
    return `
    <div class="tarjeta ini-centro">
      <div class="ini-centro-cab">
        <div>
          <h3>Centro de actualización</h3>
          <div class="ini-centro-sub">Pon al día toda la información con un clic. Apaga lo que no necesites.</div>
        </div>
        <div class="ini-centro-acc">
          <button type="button" class="boton azulclaro" id="ini-probar"
                  title="Prueba que cada modelo elegido descargue, sin tocar los datos actuales">⤓ Probar descargas</button>
          <button type="button" class="boton oscuro" id="ini-ejecutar">${ICO.refrescar} Ejecutar selección</button>
        </div>
      </div>
      <div class="ini-act-grid">${AREAS.map(tarjetaArea).join("")}</div>
    </div>`;
  }

  function elegidas(centro) {
    const areas = [], modelos = [];
    for (const t of centro.querySelectorAll(".ini-act-tarjeta")) {
      const sw = t.querySelector(".ini-switch");
      if (sw.getAttribute("aria-checked") !== "true") continue;
      areas.push(t.dataset.area);
      for (const c of t.querySelectorAll(".ini-act-chip.activo")) modelos.push(c.dataset.modelo);
    }
    return { areas, modelos };
  }

  function conectarCentro(centro) {
    // toggles por área
    for (const t of centro.querySelectorAll(".ini-act-tarjeta")) {
      const sw = t.querySelector(".ini-switch");
      sw.onclick = () => {
        const on = sw.getAttribute("aria-checked") !== "true";
        sw.setAttribute("aria-checked", on ? "true" : "false");
        sw.classList.toggle("activo", on);
        t.classList.toggle("apagada", !on);
      };
    }
    // chips de modelo (sólo en Cartas): los base (GFS/ICON/IFS HRES) activos; los
    // OPCIONALES (IFS ENS / AIFS, ECMWF pesados) arrancan APAGADOS — opt-in del usuario.
    for (const c of centro.querySelectorAll(".ini-act-chip")) {
      if (!c.classList.contains("opcional")) c.classList.add("activo");
      c.onclick = () => c.classList.toggle("activo");
    }
  }

  async function ejecutarActualizacion(centro) {
    const { areas, modelos } = elegidas(centro);
    if (!areas.length) return App.aviso("Enciende al menos una tarjeta para actualizar.", "error");
    if (areas.includes("cartas") && !modelos.length)
      return App.aviso("Elige al menos un modelo para las cartas (GFS, ICON, IFS HRES, IFS ENS o AIFS).", "error");
    abrirModalProgreso(areas, modelos);
  }

  // "Actualizar todo" = acción global de un clic: TODAS las áreas + modelos BASE
  // (GFS/ICON/IFS), IGNORANDO los switches del Centro (esos son para "Ejecutar selección").
  // Antes este botón respetaba los switches → no actualizaba "todo" de verdad.
  function actualizarTodo() {
    abrirModalProgreso(AREAS.map(a => a.id), MODELOS_ACT.filter(m => !m.opt).map(m => m.id));
  }

  /* ============ Probar descargas (smoke test por modelo, sin tocar producción) ============ */
  function probarDescargas(centro) {
    const { modelos } = elegidas(centro);
    const mods = modelos.length ? modelos : ["GFS", "ICON", "IFS"];
    abrirModalPrueba(mods);
  }
  function abrirModalPrueba(modelos) {
    const fondo = document.createElement("div");
    fondo.className = "modal-fondo ini-modal-fondo";
    fondo.innerHTML = `
      <div class="modal ini-modal" role="dialog" aria-label="Probar descargas">
        <header>
          <div class="ini-modal-tit">
            <span>Probar descargas</span>
            <span class="ini-modal-sub">${modelos.length} modelo${modelos.length === 1 ? "" : "s"} · sin tocar los datos vigentes</span>
          </div>
          <div class="ini-modal-acc">
            <button type="button" class="ini-modal-min" data-rol="minimizar" title="Minimizar — sigue en segundo plano">▾ Minimizar</button>
            <button type="button" class="ini-modal-x" data-rol="cerrar" title="Cancelar y cerrar">×</button>
          </div>
        </header>
        <div class="cuerpo">
          <div class="ini-prog">
            <div class="ini-prog-fila"><span class="ini-prog-et">Probando descarga…</span>
              <span class="ini-prog-pct mono" data-rol="pct">0%</span></div>
            <div class="ini-prog-pista"><div class="ini-prog-barra" data-rol="barra"></div></div>
          </div>
          <div class="ini-modelos-estado" data-rol="modelos-estado"></div>
          <div class="ini-log-cab"><span>Bitácora del motor</span><span class="ini-log-vivo" data-rol="log-vivo">● en vivo</span></div>
          <pre class="ini-log mono" data-rol="log"></pre>
          <p class="ini-nota">Descarga cada modelo a un espacio temporal con horizonte corto y reporta si responde. <b>No modifica</b> las cartas ni alertas actuales.</p>
        </div>
      </div>`;
    document.body.appendChild(fondo);
    modalActivo = fondo; modalTareaId = null; modalProm = null; modalMinimizado = false;
    const $ = s => fondo.querySelector(s);
    const barra = $('[data-rol="barra"]'), pct = $('[data-rol="pct"]');
    const logEl = $('[data-rol="log"]');
    let terminado = false;
    const reResumen = /Resumen proveedores directos:\s*(.+)/i;
    function badges(txt) {
      const cont = $('[data-rol="modelos-estado"]'); if (!cont) return;
      const pares = [...txt.matchAll(/([\w-]+)\s*=\s*(OK|SIN ACTUALIZAR)/gi)];
      if (!pares.length) return;
      cont.innerHTML = `<div class="ime-tit mono">Resultado por modelo</div>` +
        pares.map(p => { const ok = /OK/i.test(p[2]);
          return `<span class="ime-badge ${ok ? "ok" : "fail"}">${esc(p[1])} ${ok ? "✓ baja bien" : "✗ sin respuesta"}</span>`; }).join("");
    }
    $('[data-rol="cerrar"]').onclick = () => { if (!terminado) cancelarModalActual(); cerrarModal(); };
    $('[data-rol="minimizar"]').onclick = () => { if (terminado) { cerrarModal(); return; }
      minimizarModal("Prueba en segundo plano — clic en el chip del panel izquierdo para volver a abrirla."); };
    modalProm = App.tarea("/cartas/probar_descargas", { modelos }, {
      alLog: lineas => {
        if (logEl && lineas.length) { logEl.textContent += (logEl.textContent ? "\n" : "") + lineas.join("\n"); logEl.scrollTop = logEl.scrollHeight; }
        for (const l of lineas) { const r = reResumen.exec(l); if (r) badges(r[1]); }
      },
      alProgreso: p => { if (p == null) return; const v = Math.max(0, Math.min(100, Math.round(p))); barra.style.width = v + "%"; pct.textContent = v + "%"; },
      alTerminar: t => {
        terminado = true; barra.style.width = "100%"; pct.textContent = "100%";
        if (modalMinimizado) restaurarModal();   // muestra el resultado al terminar
        if (modalTareaId != null) App.restaurador(modalTareaId, null);
        const ok = t && t.resultado && t.resultado.ok;
        App.aviso(ok ? "Prueba de descargas terminada." : "Prueba terminada con avisos — revisa los modelos en rojo.", ok ? "ok" : "error", 6000);
      },
    }).then(id => { modalTareaId = id; });
  }

  /* ============ Modal de progreso a medida (barra + 4 pasos encadenados) ============
     Lee el marcador "Etapa i/N" del log de la tarea global para marcar pasos
     En espera → En curso → Listo. No inventa el avance: usa el progreso real. */
  const PASOS = [
    { area: "observaciones", n: "Observaciones" },
    { area: "cartas",        n: "Cartas y alertas" },
    { area: "sngr",          n: "Eventos de ríos" },
    { area: "mlnwp",         n: "Validación ML-NWP" },
  ];
  // Etiquetas EXACTAS que el backend (actualizar.py ETIQUETAS) mete en
  // resultado.fallos cuando una etapa termina con problemas. Emparejamos por
  // ÁREA (no por el texto del paso) para no depender de la rotulación visual.
  const ETIQUETA_BACKEND = {
    observaciones: "Observaciones de la bandeja",
    cartas: "Cartas y alertas",
    sngr: "Eventos de ríos",
    mlnwp: "Validación ML-NWP",
  };

  // Ciclo del modal de progreso/prueba (vive en document.body → persiste entre vistas).
  // MINIMIZAR = ocultar (no borrar) + registrar restaurador → el chip del panel lo reabre
  // (MAXIMIZAR). CERRAR = borrar. CANCELAR = detener la tarea (por id, esperando la promesa
  // si aún no resolvió; respaldo: cancelarTodas).
  let modalActivo = null;
  let modalTareaId = null;     // id de la tarea del modal activo
  let modalProm = null;        // promesa de App.tarea (id aún no resuelto)
  let modalMinimizado = false;

  function cerrarModal() {
    if (modalTareaId != null) App.restaurador(modalTareaId, null);
    if (modalActivo) { modalActivo.remove(); modalActivo = null; }
    modalTareaId = null; modalProm = null; modalMinimizado = false;
  }
  function minimizarModal(mensaje) {
    if (!modalActivo) return;
    modalActivo.style.display = "none";
    modalMinimizado = true;
    if (modalTareaId != null) App.restaurador(modalTareaId, restaurarModal);
    if (mensaje) App.aviso(mensaje, "ok", 5000);
  }
  function restaurarModal() {     // MAXIMIZAR (lo llama el clic en el chip)
    if (modalActivo) { modalActivo.style.display = ""; modalMinimizado = false; }
  }
  async function cancelarModalActual() {
    let id = modalTareaId;
    if (id == null && modalProm) { try { id = await modalProm; } catch (e) { id = null; } }
    if (id != null) App.cancelarTarea(id); else App.cancelarTodas();
    App.aviso("Cancelando la actualización…", "info");
  }

  function abrirModalProgreso(areas, modelos) {
    // Sólo se muestran los pasos de las áreas elegidas, en orden seguro.
    const pasos = PASOS.filter(p => areas.includes(p.area));
    const total = pasos.length;

    const fondo = document.createElement("div");
    fondo.className = "modal-fondo ini-modal-fondo";
    fondo.innerHTML = `
      <div class="modal ini-modal" role="dialog" aria-label="Actualizar datos">
        <header>
          <div class="ini-modal-tit">
            <span>Actualizar datos</span>
            <span class="ini-modal-sub">${total} etapa${total === 1 ? "" : "s"} encadenada${total === 1 ? "" : "s"} en orden seguro</span>
          </div>
          <div class="ini-modal-acc">
            <button type="button" class="ini-modal-min" data-rol="minimizar"
                    title="Minimizar — la actualización sigue en segundo plano (chip del panel izquierdo)">▾ Minimizar</button>
            <button type="button" class="ini-modal-x" data-rol="cerrar" title="Cancelar y cerrar">×</button>
          </div>
        </header>
        <div class="cuerpo">
          <div class="ini-prog">
            <div class="ini-prog-fila">
              <span class="ini-prog-et">Progreso global</span>
              <span class="ini-prog-pct mono" data-rol="pct">0%</span>
            </div>
            <div class="ini-prog-pista"><div class="ini-prog-barra" data-rol="barra"></div></div>
          </div>
          <div class="ini-pasos" data-rol="pasos">
            ${pasos.map((p, i) => `
              <div class="ini-paso en-espera" data-area="${p.area}">
                <span class="ini-paso-num">${i + 1}</span>
                <span class="ini-paso-nombre">${esc(p.n)}</span>
                <span class="ini-paso-estado" data-rol="estado">En espera</span>
              </div>`).join("")}
          </div>
          <div class="ini-modelos-estado" data-rol="modelos-estado"></div>
          <div class="ini-log-cab"><span>Bitácora del motor</span><span class="ini-log-vivo" data-rol="log-vivo">● en vivo</span></div>
          <pre class="ini-log mono" data-rol="log"></pre>
        </div>
      </div>`;
    document.body.appendChild(fondo);
    modalActivo = fondo; modalTareaId = null; modalProm = null; modalMinimizado = false;

    const $ = s => fondo.querySelector(s);
    const barra = $('[data-rol="barra"]');
    const pct = $('[data-rol="pct"]');
    const filasPaso = [...fondo.querySelectorAll(".ini-paso")];
    const btnX = $('[data-rol="cerrar"]');

    let terminado = false;
    // La X cancela la tarea (de forma fiable: espera la promesa si el id aún no
    // resolvió) y cierra el modal.
    btnX.onclick = () => { if (!terminado) cancelarModalActual(); cerrarModal(); };
    // MINIMIZAR: OCULTA el modal SIN cancelar — la tarea sigue y aparece un chip clicable
    // en el panel izquierdo que la vuelve a abrir (MAXIMIZAR). Persiste entre vistas.
    const btnMin = $('[data-rol="minimizar"]');
    if (btnMin) btnMin.onclick = () => { if (terminado) { cerrarModal(); return; }
      minimizarModal("Actualización en segundo plano — clic en el chip del panel izquierdo para volver a abrirla."); };
    fondo.onclick = e => { if (e.target === fondo && terminado) cerrarModal(); };

    let etapaActual = 0; // 1..N a partir del log "Etapa i/N"

    function marcarPaso(i, clase, txt) {
      const f = filasPaso[i - 1];
      if (!f) return;
      f.classList.remove("en-espera", "en-curso", "listo", "con-error");
      f.classList.add(clase);
      const e = f.querySelector('[data-rol="estado"]');
      if (clase === "en-curso")
        e.innerHTML = `<span class="ini-spin"></span>En curso`;
      else e.textContent = txt;
    }

    const reEtapa = /Etapa\s+(\d+)\s*\/\s*(\d+)/i;
    // El motor reporta el estado de DESCARGA POR MODELO: "Resumen proveedores directos:
    // GFS=OK, ICON=OK, IFS=SIN ACTUALIZAR, ...". Lo mostramos como badges (✓/✗) para que
    // se vea de un vistazo qué modelo bajó bien y cuál no — la validación de cada descarga.
    const reResumen = /Resumen proveedores directos:\s*(.+)/i;
    function pintarModelosEstado(txt) {
      const cont = $('[data-rol="modelos-estado"]'); if (!cont) return;
      const pares = [...txt.matchAll(/([\w-]+)\s*=\s*(OK|SIN ACTUALIZAR)/gi)];
      if (!pares.length) return;
      cont.innerHTML = `<div class="ime-tit mono">Descarga por modelo</div>` +
        pares.map(p => { const ok = /OK/i.test(p[2]);
          return `<span class="ime-badge ${ok ? "ok" : "fail"}">${esc(p[1])} ${ok ? "✓" : "✗ sin actualizar"}</span>`; }).join("");
    }

    const logEl = $('[data-rol="log"]');
    function volcarLog(lineas) {
      if (!logEl || !lineas.length) return;
      const fin = logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 24; // estaba abajo
      logEl.textContent += (logEl.textContent ? "\n" : "") + lineas.join("\n");
      if (fin) logEl.scrollTop = logEl.scrollHeight;   // auto-scroll si seguía el final
    }

    function alLog(lineas) {
      volcarLog(lineas);
      for (const linea of lineas) {
        const m = reEtapa.exec(linea);
        if (m) {
          const i = parseInt(m[1], 10);
          // cierra los anteriores como listos, abre el actual
          for (let k = 1; k < i; k++) marcarPaso(k, "listo", "Listo");
          etapaActual = i;
          marcarPaso(i, "en-curso");
        }
        const rs = reResumen.exec(linea);
        if (rs) pintarModelosEstado(rs[1]);
      }
    }

    function alProgreso(p) {
      if (p == null) return;
      const v = Math.max(0, Math.min(100, Math.round(p)));
      barra.style.width = v + "%";
      pct.textContent = v + "%";
    }

    function cerrarTodos(clase, txt) {
      for (let k = 1; k <= filasPaso.length; k++) marcarPaso(k, clase, txt);
    }

    const cuerpo = { areas };
    if (modelos.length) cuerpo.modelos = modelos;

    modalProm = App.tarea("/actualizar/global", cuerpo, {
      alLog,
      alProgreso,
      alTerminar: t => {
        terminado = true;
        if (modalMinimizado) restaurarModal();   // muestra el resultado al terminar
        if (modalTareaId != null) App.restaurador(modalTareaId, null);
        cerrarTodos("listo", "Listo");
        alProgreso(100);
        btnX.title = "Cerrar";
        // El backend NO corta ante el fallo de una etapa: termina "ok" pero
        // anota las áreas con problemas en resultado.fallos. Marcamos esos pasos
        // como "Con avisos" y sólo damos el visto bueno verde si no hubo fallos.
        const fallos = (t && t.resultado && t.resultado.fallos) || [];
        for (const f of filasPaso) {
          if (fallos.includes(ETIQUETA_BACKEND[f.dataset.area])) {
            f.classList.remove("en-espera", "en-curso", "listo");
            f.classList.add("con-error");
            const e = f.querySelector('[data-rol="estado"]');
            if (e) e.textContent = "Con avisos";
          }
        }
        if (fallos.length)
          App.aviso("Terminó con avisos en: " + fallos.join(", "), "error", 8000);
        else
          fondo.querySelector(".ini-modal").classList.add("ini-modal-ok");
        // refresca las tarjetas de estado con los datos recién actualizados
        pintarEstadoModulos();
        pintarRiesgo(document.getElementById("ini-riesgo"));
      },
      alError: () => {
        terminado = true;
        if (modalMinimizado) restaurarModal();
        if (modalTareaId != null) App.restaurador(modalTareaId, null);
        // el paso en curso queda con error; los previos quedan listos
        if (etapaActual) marcarPaso(etapaActual, "con-error", "Con avisos");
        btnX.title = "Cerrar";
      },
    }).then(id => { modalTareaId = id; }).catch(e => {
      terminado = true;
      App.aviso(e.message, "error");
      cerrarModal();
    });
  }

  /* ============ Riesgo de hoy (agrega /mlnwp/resumen?dia=0) ============
     Mapea cada estación a su región natural y toma el peor nivel de riesgo de
     sus variables. Por región: nivel dominante + nº de estaciones en él. */
  const REGIONES = [
    { clave: "Litoral", nombre: "Litoral" },
    { clave: "Interandina", nombre: "Interandina" },
    { clave: "Amazonia", nombre: "Amazonía" },
    { clave: "Insular", nombre: "Insular" },
  ];
  const NIVEL_ORDEN = { "No aplica": 0, "Medio": 1, "Alto": 2, "Muy Alto": 3 };
  // color de riesgo (tokens del sistema) + etiqueta corta
  const NIVEL_INFO = {
    0: { color: "var(--risk-0)", fondo: "color-mix(in srgb, var(--risk-0) 16%, transparent)", txt: "sin alerta", frac: 0.10 },
    1: { color: "var(--risk-2)", fondo: "color-mix(in srgb, var(--risk-2) 16%, transparent)", txt: "medio", frac: 0.40 },
    2: { color: "var(--risk-3)", fondo: "color-mix(in srgb, var(--risk-3) 16%, transparent)", txt: "alto", frac: 0.62 },
    3: { color: "var(--risk-3)", fondo: "color-mix(in srgb, var(--risk-3) 16%, transparent)", txt: "muy alto", frac: 0.85 },
  };

  function peorNivelFila(f) {
    let peor = 0;
    for (const k of ["riesgo_precip", "riesgo_tmax", "riesgo_tmin"]) {
      const n = NIVEL_ORDEN[f[k]];
      if (n != null && n > peor) peor = n;
    }
    return peor;
  }

  function filaRiesgo(reg, nivel, cuenta) {
    const info = NIVEL_INFO[nivel];
    const etq = nivel === 0 ? "sin alerta" : `${cuenta} ${info.txt}`;
    const pct = Math.round(info.frac * 100);
    return `
    <div class="ini-riesgo-fila">
      <span class="ini-riesgo-reg">${esc(reg)}</span>
      <span class="ini-riesgo-der">
        <span class="ini-riesgo-nivel mono" style="color:${info.color}">${esc(etq)}</span>
        <span class="ini-riesgo-pista" style="background:${info.fondo}">
          <span class="ini-riesgo-barra" style="width:${pct}%;background:${info.color}"></span>
        </span>
      </span>
    </div>`;
  }

  async function pintarRiesgo(caja) {
    if (!caja) return;
    try {
      const r = await App.api("/mlnwp/resumen?dia=0");
      const filas = r.filas || [];
      const acc = {}; // region → {peor, cuenta}
      for (const f of filas) {
        const reg = f.region;
        const nivel = peorNivelFila(f);
        const a = acc[reg] || (acc[reg] = { peor: 0, cuenta: 0 });
        if (nivel > a.peor) { a.peor = nivel; a.cuenta = 1; }
        else if (nivel === a.peor && nivel > 0) a.cuenta++;
      }
      caja.innerHTML = REGIONES.map(({ clave, nombre }) => {
        const a = acc[clave] || { peor: 0, cuenta: 0 };
        return filaRiesgo(nombre, a.peor, a.cuenta);
      }).join("");
    } catch (e) {
      caja.innerHTML = `<div class="suave ini-msg">Riesgo no disponible: ${esc(e.message)}</div>`;
    }
  }

  /* ============ Credenciales (/datos/credenciales) ============ */
  function credLinea(nombre, ok, texto) {
    return `<div class="ini-cred-linea">
      <span class="ini-cred-nombre">${esc(nombre)}</span>
      <span class="etiqueta ${ok ? "ok" : "aviso"}">${ok ? "✓" : "⚠"} ${esc(texto)}</span>
    </div>`;
  }

  async function pintarCredenciales(caja) {
    if (!caja) return;
    try {
      const c = await App.api("/datos/credenciales");
      const res = c.resumen || {};
      const mbAct = (c.meteoblue && c.meteoblue.activas) || 0;
      caja.innerHTML = `
        <div class="ini-cred-lista">
          ${credLinea("FFGS · Earthdata · CDS", !!res.cartas_ok, res.cartas_ok ? "completas" : "incompletas")}
          ${credLinea("Meteoblue (ML-NWP)", !!res.meteoblue_ok, res.meteoblue_ok ? `${mbAct} activa${mbAct === 1 ? "" : "s"}` : "sin clave")}
          ${credLinea("API SITREP-SNGR", !!res.sngr_ok, res.sngr_ok ? "detectada" : "por rotar")}
        </div>`;
    } catch (e) {
      caja.innerHTML = `<div class="suave ini-msg">No disponible: ${esc(e.message)}</div>`;
    }
  }

  /* ============ Estado de módulos (/estado) ============ */
  async function pintarEstadoModulos() {
    const caja = document.getElementById("ini-modulos");
    if (!caja) return;
    try {
      const r = await App.api("/estado");
      const mods = r.modulos || {};
      caja.innerHTML = ORDEN.map(id =>
        tarjetaModulo(id, mods[id] || { titulo: id, disponible: false, detalle: "Sin estado" })).join("");
      caja.querySelectorAll(".ini-card-mod").forEach(t => {
        const ir = () => App.navegar(RUTA_NAV[t.dataset.modulo] || t.dataset.modulo);
        t.onclick = ir;
        t.onkeydown = e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); ir(); } };
      });
    } catch (e) {
      caja.innerHTML = `<div class="vacio ini-vacio-full"><div class="icono">⚠️</div>
        <strong>No se pudo leer el estado</strong><span>${esc(e.message)}</span></div>`;
    }
  }

  /* ============ Registro de la vista ============ */
  // Redibujo al cambiar tema (patrón de sngr.js): repinta las cajas dinámicas
  // si Inicio sigue montado, sin tocar el Centro (conserva switches y chips).
  let _onTema = null;

  App.registrar("inicio", {
    titulo: "Inicio", icono: "🏠", orden: 0,

    async render(vista) {
      // La cabecera propia vive dentro de #vista; ocultamos la del shell.
      const cab = document.getElementById("cabecera-vista");
      if (cab) cab.style.display = "none";

      vista.innerHTML = `
      <div class="ini-raiz" data-screen-label="Inicio">
        <header class="ini-cabecera">
          <div>
            <div class="kicker">Panel general</div>
            <h1 class="ini-saludo">${saludo()}, pronosticador</h1>
            <div class="ini-subtitulo">Plataforma Hidrometeorológica Integrada del Ecuador</div>
          </div>
          <button type="button" class="boton primario" id="ini-actualizar-todo">${ICO.refrescar} Actualizar todo</button>
        </header>

        <div class="ini-modulos" id="ini-modulos">
          ${ORDEN.map(id => `<article class="ini-card-mod ini-card-skel" data-modulo="${id}">
            <div class="ini-card-top"><span class="ini-card-ico">${ICO[id] || ""}</span></div>
            <h4 class="ini-card-titulo">…</h4>
            <div class="ini-card-detalle suave">Cargando estado…</div>
          </article>`).join("")}
        </div>

        <div class="ini-inferior">
          ${centroHTML()}
          <div class="ini-columna">
            <div class="tarjeta ini-riesgo-tarjeta">
              <div class="ini-mini-cab">
                <h3>Riesgo de hoy</h3>
                <span class="ini-mini-fecha mono">${new Date().toLocaleDateString("es-EC", { day: "numeric", month: "short" })}</span>
              </div>
              <div id="ini-riesgo"><div class="suave ini-msg">Cargando…</div></div>
            </div>
            <div class="tarjeta ini-cred-tarjeta">
              <h3>Credenciales</h3>
              <div id="ini-cred"><div class="suave ini-msg">Cargando…</div></div>
              <button type="button" class="boton ini-cred-boton" id="ini-cred-detalle">
                Ver detalle en Datos ${ICO.flecha}</button>
            </div>
          </div>
        </div>
      </div>`;

      const centro = vista.querySelector(".ini-centro");
      conectarCentro(centro);

      vista.querySelector("#ini-ejecutar").onclick = () => ejecutarActualizacion(centro);
      vista.querySelector("#ini-actualizar-todo").onclick = () => actualizarTodo();
      const btnProbar = vista.querySelector("#ini-probar");
      if (btnProbar) btnProbar.onclick = () => probarDescargas(centro);
      vista.querySelector("#ini-cred-detalle").onclick = () => App.navegar("datos");

      if (_onTema) document.removeEventListener("temacambiado", _onTema);
      _onTema = () => {
        if (!document.getElementById("ini-modulos")) return;
        pintarEstadoModulos();
        pintarRiesgo(document.getElementById("ini-riesgo"));
        pintarCredenciales(document.getElementById("ini-cred"));
      };
      document.addEventListener("temacambiado", _onTema);

      pintarCredenciales(document.getElementById("ini-cred"));
      pintarRiesgo(document.getElementById("ini-riesgo"));
      await pintarEstadoModulos();
    },

    alDejar() {
      if (_onTema) { document.removeEventListener("temacambiado", _onTema); _onTema = null; }
      // restaura la cabecera del shell para los demás módulos
      const cab = document.getElementById("cabecera-vista");
      if (cab) cab.style.display = "";
      // Si hay una tarea viva con su modal abierto, lo MINIMIZA (lo oculta pero lo
      // conserva en el body): así no queda pegado sobre otra vista y el chip clicable
      // del panel lo vuelve a abrir. Si ya terminó / no hay tarea, lo cierra.
      if (modalActivo && App.hayTareaActiva() && modalTareaId != null) minimizarModal();
      else cerrarModal();
    },
  });
})();
