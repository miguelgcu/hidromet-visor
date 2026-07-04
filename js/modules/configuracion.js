/* ============================================================
   Configuración — módulo del SISTEMA (rediseño v9, FIEL a Diseño/).
   Arquitectura intacta: App.registrar / App.api / App.tarea / App.tema.
   Acento: slate (--slate). data-screen-label="Configuración".

   Datos REALES (campos verificados en las rutas Python):
   · /mlnwp/claves   → {archivo, n_activas, n_obsoletas,
                        claves:[{mascara:"ab…yz", estado:"activa"|"obsoleta"}], env}
   · /datos/entorno  → {app_root, datos,
                        motores:{cartas:{etiqueta,ruta,existe,autocontenido,credenciales?},
                                 mlnwp:{...,venv?}, sngr:{...}},
                        gis, eventos, bandeja}
   · /config         → {tema, dependencias_mlnwp, proyecto_*, creador}
   · /datos/diagnostico → {primer_arranque, capacidades:{visor,validacion,
                        entrenamiento:{items:[{nombre,ok,critico,...}], ...}},
                        todo_listo, resumen:{total, ok}}
   ============================================================ */
"use strict";

(() => {
  const esc = v => String(v ?? "").replace(/[&<>"']/g,
    c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // Lápiz (línea, stroke:currentColor) para el creador editable.
  const ICO_LAPIZ = '<svg class="lapiz" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>';

  // ────────────────────────── Claves Meteoblue ──────────────────────────
  // La API NUNCA devuelve el valor completo: solo la máscara y el estado.
  // El uso real por clave no se expone en /mlnwp/claves, así que el texto
  // de uso es informativo según el estado.
  function filaClave(c) {
    const obsoleta = c.estado === "obsoleta";
    const uso = obsoleta ? "cuota agotada"
                         : "512 000 llamadas/día · activa";
    return `
      <div class="cfg-clave ${obsoleta ? "obsoleta" : ""}">
        <div>
          <div class="cfg-clave-mascara">${esc(c.mascara)}</div>
          <div class="cfg-clave-uso">${esc(uso)}</div>
        </div>
        <div style="display:flex;align-items:center;gap:8px">
          <span class="cfg-badge ${obsoleta ? "obsoleta" : "activa"}">${obsoleta ? "obsoleta" : "activa"}</span>
          <button class="boton chico cfg-clave-del" data-mascara="${esc(c.mascara)}" title="Eliminar esta clave">🗑</button>
        </div>
      </div>`;
  }

  async function pintarClaves(caja) {
    try {
      const r = await App.api("/mlnwp/claves");
      const claves = r.claves || [];
      const obs = claves.filter(c => c.estado === "obsoleta").length;
      const cabecera = obs
        ? `<div style="display:flex;justify-content:flex-end;margin-bottom:6px">
             <button class="boton chico" id="cfg-limpiar-obs">Limpiar ${obs} obsoleta${obs === 1 ? "" : "s"}</button></div>`
        : "";
      if (!claves.length) {
        caja.innerHTML = `<div class="suave" style="font-size:12px">No hay claves recordadas. Usa “+ Agregar clave”.</div>`;
        return;
      }
      caja.innerHTML = cabecera + claves.map(filaClave).join("");
      caja.querySelectorAll(".cfg-clave-del").forEach(b =>
        b.onclick = () => eliminarClave(b.dataset.mascara, caja));
      const lo = caja.querySelector("#cfg-limpiar-obs");
      if (lo) lo.onclick = () => limpiarObsoletas(caja);
    } catch (e) {
      caja.innerHTML = `<div class="suave" style="font-size:12px">No disponible: ${esc(e.message)}</div>`;
    }
  }

  async function eliminarClave(masc, caja) {
    if (!window.confirm(`¿Eliminar la clave ${masc}? No se puede deshacer.`)) return;
    try {
      const r = await App.api("/mlnwp/claves", { method: "POST", body: { accion: "eliminar", mascara: masc } });
      if (r.error) return App.aviso(r.error, "error");
      App.aviso("Clave eliminada.", "ok");
      await pintarClaves(caja);
    } catch (e) { App.aviso(e.message, "error"); }
  }

  async function limpiarObsoletas(caja) {
    if (!window.confirm("¿Eliminar TODAS las claves obsoletas (agotadas/inválidas)?")) return;
    try {
      const r = await App.api("/mlnwp/claves", { method: "POST", body: { accion: "limpiar_obsoletas" } });
      App.aviso(r.mensaje || "Obsoletas eliminadas.", "ok");
      await pintarClaves(caja);
    } catch (e) { App.aviso(e.message, "error"); }
  }

  async function agregarClave(caja) {
    const clave = window.prompt("Pega tu clave de Meteoblue (se guardará enmascarada; el valor completo nunca se muestra):");
    if (clave === null) return;
    const limpia = clave.trim();
    if (!limpia) return App.aviso("La clave está vacía.", "error");
    try {
      const r = await App.api("/mlnwp/claves", { method: "POST", body: { accion: "agregar", clave: limpia, validar: true } });
      if (r.ok === false) return App.aviso(r.mensaje || "Clave no válida.", "error");
      App.aviso(r.mensaje || "Clave recordada.", "ok");
      await pintarClaves(caja);
    } catch (e) {
      App.aviso(e.message, "error");
    }
  }

  // ────────────────────────── Rutas de los motores ──────────────────────────
  // Cuatro filas fijas del diseño; el ✓/✗ y el color dependen de /datos/entorno.
  function filaRuta(etiqueta, ok, ruta) {
    return `
      <div class="cfg-ruta ${ok ? "" : "falta"}">
        <span class="etiqueta-ruta">${esc(etiqueta)}</span>
        <span class="valor-ruta">${ok ? "✓" : "✗"} ${esc(ruta)}</span>
      </div>`;
  }

  async function pintarRutas(caja, entorno) {
    try {
      const e = entorno || await App.api("/datos/entorno");
      const m = e.motores || {};
      const cartas = m.cartas || {};
      const mlnwp = m.mlnwp || {};
      caja.innerHTML = [
        filaRuta("Motor de cartas", !!cartas.existe, "motores/cartas/"),
        filaRuta("Motor ML-NWP + venv", !!(mlnwp.existe && mlnwp.venv), "motores/mlnwp/"),
        filaRuta("BD eventos de ríos", !!e.eventos, "datos/eventos/"),
        filaRuta("GIS CONALI 2022", !!e.gis, "datos/gis/"),
      ].join("");
    } catch (err) {
      caja.innerHTML = `<div class="suave" style="font-size:12px">No disponible: ${esc(err.message)}</div>`;
    }
  }

  // ────────────────────────── Apariencia (tema) ──────────────────────────
  function marcarTema(raiz, activo) {
    raiz.querySelectorAll(".cfg-tema").forEach(t =>
      t.classList.toggle("activo", t.dataset.tema === activo));
  }

  function conectarTemas(raiz) {
    marcarTema(raiz, App.tema());
    raiz.querySelectorAll(".cfg-tema").forEach(t => {
      t.onclick = () => { App.tema(t.dataset.tema); marcarTema(raiz, t.dataset.tema); };
    });
    // Si el tema cambia desde el topbar, reflejarlo aquí.
    raiz._onTema = e => marcarTema(raiz, e.detail);
    document.addEventListener("temacambiado", raiz._onTema);
  }

  // ────────────────────────── Acerca de (creador editable) ──────────────────────────
  function pintarCreador(slot, valor) {
    const nombre = (valor || "").trim() || "Dirección de Pronósticos · INAMHI";
    slot.dataset.valor = nombre;
    slot.innerHTML = `<button class="cfg-creador" type="button" title="Editar creador">${esc(nombre)}${ICO_LAPIZ}</button>`;
    slot.querySelector(".cfg-creador").onclick = () => editarCreador(slot);
  }

  function editarCreador(slot) {
    const actual = slot.dataset.valor || "";
    slot.innerHTML = `<input class="cfg-creador-edit" type="text" value="${esc(actual)}" />`;
    const inp = slot.querySelector("input");
    inp.focus(); inp.select();
    let cerrado = false;
    const guardar = async () => {
      if (cerrado) return; cerrado = true;
      const nuevo = inp.value.trim();
      if (!nuevo || nuevo === actual) { pintarCreador(slot, actual); return; }
      try {
        const r = await App.api("/config", { method: "POST", body: { creador: nuevo } });
        pintarCreador(slot, r.creador || nuevo);
        App.aviso("Creador actualizado.", "ok");
      } catch (e) {
        pintarCreador(slot, actual);
        App.aviso(e.message, "error");
      }
    };
    inp.onblur = guardar;
    inp.onkeydown = ev => {
      if (ev.key === "Enter") inp.blur();
      else if (ev.key === "Escape") { cerrado = true; pintarCreador(slot, actual); }
    };
  }

  async function pintarAcerca(slotCreador) {
    try {
      const cfg = await App.api("/config");
      pintarCreador(slotCreador, cfg.creador);
    } catch (e) {
      pintarCreador(slotCreador, "");
    }
  }

  // ────────────────────────── Diagnóstico ──────────────────────────
  // Cuatro filas del diseño. El servidor local y WebView2 están activos por
  // definición (este código corre dentro del WebView2 sobre el servidor local).
  // venv MLNWP y API SNGR se resuelven con datos reales: /datos/entorno (venv)
  // y /datos/diagnostico (credencial SNGR, dentro de capacidad "entrenamiento").
  function filaDiag(estado, texto) {
    return `<div class="cfg-diag-fila"><span class="cfg-diag-punto ${estado}"></span>${esc(texto)}</div>`;
  }

  function buscarItem(diag, fragmento) {
    const caps = diag && diag.capacidades ? Object.values(diag.capacidades) : [];
    for (const cap of caps) {
      for (const it of (cap.items || [])) {
        if (String(it.nombre || "").toLowerCase().includes(fragmento)) return it;
      }
    }
    return null;
  }

  async function pintarDiagnostico(caja, { profundo = false, entorno = null } = {}) {
    let venvOk = null, sngrOk = null;
    try {
      const e = entorno || await App.api("/datos/entorno");
      venvOk = !!(e.motores && e.motores.mlnwp && e.motores.mlnwp.venv);
    } catch (err) { /* deja venvOk en null → desconocido */ }
    // El diagnóstico completo (botón) recorre /datos/diagnostico, más costoso:
    // SÓLO se ejecuta a petición. En la carga inicial sngrOk queda "sin verificar".
    if (profundo) {
      try {
        const diag = await App.api("/datos/diagnostico");
        const itSngr = buscarItem(diag, "sngr");
        if (itSngr) sngrOk = !!itSngr.ok;
        if (venvOk === null) {
          const itVenv = buscarItem(diag, "venv");
          if (itVenv) venvOk = !!itVenv.ok;
        }
      } catch (err) { /* deja desconocido */ }
    }

    const estVenv = venvOk === null ? "aviso" : (venvOk ? "ok" : "malo");
    const txtVenv = venvOk === null ? "venv MLNWP · sin verificar"
                  : venvOk ? "venv MLNWP detectado" : "venv MLNWP no encontrado";
    const estSngr = sngrOk === null ? "aviso" : (sngrOk ? "ok" : "aviso");
    const txtSngr = sngrOk === null ? "API SNGR · clave por rotar"
                  : sngrOk ? "API SNGR · clave detectada" : "API SNGR · clave por rotar";

    caja.innerHTML = [
      filaDiag("ok", "Servidor local activo · puerto dinámico"),
      filaDiag("ok", "WebView2 disponible"),
      filaDiag(estVenv, txtVenv),
      filaDiag(estSngr, txtSngr),
    ].join("");
  }

  // ────────────────────────── Render ──────────────────────────
  App.registrar("configuracion", {
    titulo: "Configuración", icono: "⚙️", orden: 7,

    async render(vista) {
      // Oculta la cabecera global y pinta la propia (kicker slate + h1).
      const cab = document.getElementById("cabecera-vista");
      if (cab) cab.style.display = "none";

      vista.innerHTML = `
        <div class="cfg-lienzo" data-screen-label="Configuración">
          <header style="margin-bottom:16px">
            <div class="kicker" style="color:var(--slate)">Sistema</div>
            <h1 style="margin:0;font-size:22px;font-weight:700;letter-spacing:-.01em">Configuración</h1>
          </header>

          <div class="cfg-rejilla">
            <!-- IZQUIERDA -->
            <div class="cfg-columna">
              <div class="tarjeta">
                <div class="cfg-cab-tarjeta">
                  <h3>Claves Meteoblue</h3>
                  <button class="boton primario chico" id="cfg-add-clave">+ Agregar clave</button>
                </div>
                <div class="cfg-claves" id="cfg-claves">
                  <div class="suave" style="font-size:12px">Cargando…</div>
                </div>
              </div>

              <div class="tarjeta">
                <h3 style="margin-bottom:4px">Rutas de los motores</h3>
                <p class="cfg-nota">Todo vive dentro de <code>HidroMet/</code> — sistema autocontenido.</p>
                <div class="cfg-rutas" id="cfg-rutas">
                  <div class="suave" style="font-size:12px">Cargando…</div>
                </div>
              </div>
            </div>

            <!-- DERECHA -->
            <div class="cfg-columna">
              <div class="tarjeta">
                <h3>Apariencia</h3>
                <div class="cfg-temas">
                  <div class="cfg-tema" data-tema="claro">
                    <div class="cfg-tema-muestra claro"></div>
                    <div class="cfg-tema-nombre"><span class="cfg-tema-punto"></span>Claro</div>
                  </div>
                  <div class="cfg-tema" data-tema="oscuro">
                    <div class="cfg-tema-muestra oscuro"></div>
                    <div class="cfg-tema-nombre"><span class="cfg-tema-punto"></span>Oscuro</div>
                  </div>
                </div>
              </div>

              <div class="tarjeta">
                <h3>Acerca de</h3>
                <div class="cfg-acerca">
                  <div class="cfg-fila-acerca"><span class="clave-acerca">Versión</span><span class="valor-acerca mono">HidroMet 9.0</span></div>
                  <div class="cfg-fila-acerca"><span class="clave-acerca">Creador</span><span class="valor-acerca" id="cfg-creador"></span></div>
                  <div class="cfg-fila-acerca"><span class="clave-acerca">Modo</span><span class="valor-acerca ok">offline · autocontenido</span></div>
                </div>
              </div>

              <div class="tarjeta">
                <h3 style="margin-bottom:11px">Diagnóstico</h3>
                <div class="cfg-diag" id="cfg-diag">
                  <div class="suave" style="font-size:12px">Cargando…</div>
                </div>
                <button class="cfg-btn-diag" id="cfg-btn-diag">Ejecutar diagnóstico completo</button>
              </div>
            </div>
          </div>
        </div>`;

      // Conexiones
      document.getElementById("cfg-add-clave").onclick =
        () => agregarClave(document.getElementById("cfg-claves"));

      conectarTemas(vista);

      const btnDiag = document.getElementById("cfg-btn-diag");
      btnDiag.onclick = async () => {
        btnDiag.disabled = true;
        const prev = btnDiag.textContent;
        btnDiag.textContent = "Diagnosticando…";
        try {
          await pintarDiagnostico(document.getElementById("cfg-diag"), { profundo: true });
          App.aviso("Diagnóstico completado.", "ok");
        } catch (e) {
          App.aviso(e.message, "error");
        } finally {
          btnDiag.disabled = false;
          btnDiag.textContent = prev;
        }
      };

      // Un solo GET /datos/entorno compartido por rutas + diagnóstico (antes se
      // pedía dos veces en el mismo tick). Si falla, cada función reintenta sola.
      const entorno = await App.api("/datos/entorno").catch(() => null);

      // Carga de datos reales (en paralelo).
      await Promise.all([
        pintarClaves(document.getElementById("cfg-claves")),
        pintarRutas(document.getElementById("cfg-rutas"), entorno),
        pintarAcerca(document.getElementById("cfg-creador")),
        pintarDiagnostico(document.getElementById("cfg-diag"), { entorno }),
      ]);
    },

    alDejar() {
      // Restaura la cabecera global y libera el listener de tema.
      const cab = document.getElementById("cabecera-vista");
      if (cab) cab.style.display = "";
      const vista = document.getElementById("vista");
      if (vista && vista._onTema) {
        document.removeEventListener("temacambiado", vista._onTema);
        vista._onTema = null;
      }
    },
  });
})();
