/* ============================================================
   HidroMet — módulo DATOS (rediseño v9, fuente: Diseño/HANDOFF/07_DATOS.md
   y data-screen-label="Datos" del HidroMet.dc.html).
   Punto de control único del catálogo maestro de estaciones.

   Arquitectura intacta: App.registrar / App.api / App.tarea / App.aviso /
   App.modalTarea. Nombres de campo verificados en:
     - app/rutas/datos.py + app/nucleo/datos.py        (estaciones, dependencias)
     - app/nucleo/credenciales.py  (estado)            (/credenciales)
     - app/nucleo/geo.py (estado_capas)                (/capas/estado)
     - app/nucleo/observaciones.py (listar_bandeja,    (/observaciones/bandeja,
       meta_matriz_ancha, validar/ingresar_ancho)       /observaciones/ancho/*)
     - app/rutas/ingreso.py + app/modulos/ingreso/*     (/cartografia/fuentes,
                                                          /diagnostico)
   ============================================================ */
"use strict";

(() => {
  const esc = v => String(v ?? "").replace(/[&<>"']/g,
    c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // Región → color del badge (tomado literal del dc.html).
  //   Interandina #138A56/#E6F4ED · Litoral #2C68DE/#EAF2FE
  //   Amazonía   #C5781B/#FBF1E0 · Insular #0E94A4/#E4F5F7
  const REGION_CLASE = {
    interandina: "interandina", litoral: "litoral",
    amazonia: "amazonia", insular: "insular",
  };
  // valor canónico que acepta el backend (REGIONES en app/nucleo/datos.py)
  const REGIONES = ["Litoral", "Interandina", "Amazonia", "Insular"];
  const AGREGACIONES = ["7-7", "0-24"];

  const norma = s => String(s ?? "").trim().toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "");

  const fmtCoord = v => (v == null || v === "" || Number.isNaN(+v))
    ? "—" : (+v).toFixed(2).replace("-", "−");      // 2 dec, signo menos tipográfico
  const fmtAlt = v => (v == null || v === "" || Number.isNaN(+v))
    ? "—" : String(Math.round(+v));

  // estado del módulo (vive mientras la vista está montada)
  const S = { estaciones: [], filtradas: [], q: "", pagina: 0, porPagina: 7,
              deps: [] };

  /* ------------------------------------------------ cabecera (kicker slate) */
  function cabeceraHTML() {
    return `
      <div class="datos-cabecera">
        <div>
          <div class="datos-kicker">Sistema · panel de administración</div>
          <h1 class="datos-h1">Datos</h1>
          <div class="datos-sub">Catálogo maestro de estaciones · punto de control único de todo el sistema</div>
        </div>
      </div>`;
  }

  /* ------------------------------------------------------ catálogo (tabla) */
  function badgeRegion(region) {
    const r = norma(region);
    const clase = REGION_CLASE[r] || "neutro";
    const txt = r === "amazonia" ? "Amazonía" : (region || "—");
    return `<span class="datos-region ${clase}">${esc(txt)}</span>`;
  }

  function filaEstacion(e) {
    return `
      <tr data-cod="${esc(e.Codigo)}">
        <td class="datos-cod">${esc(e.Codigo)}</td>
        <td>${esc(e.Nombre)}</td>
        <td class="datos-num">${fmtCoord(e.Latitud)}</td>
        <td class="datos-num">${fmtCoord(e.Longitud)}</td>
        <td class="datos-num">${fmtAlt(e.Altitud)}</td>
        <td>${esc(e.Dependencia)}</td>
        <td>${badgeRegion(e.Region)}</td>
        <td class="datos-acc"><button class="datos-editar" data-cod="${esc(e.Codigo)}" title="Editar estación">✎</button></td>
      </tr>`;
  }

  function pintarTabla(raiz) {
    const total = S.estaciones.length;
    const lista = S.filtradas;
    const desde = S.pagina * S.porPagina;
    const pagina = lista.slice(desde, desde + S.porPagina);
    const cuerpo = raiz.querySelector("[data-rol=tbody]");
    cuerpo.innerHTML = pagina.length
      ? pagina.map(filaEstacion).join("")
      : `<tr><td colspan="8" class="datos-vacio-fila">Sin estaciones que coincidan.</td></tr>`;

    const nota = raiz.querySelector("[data-rol=nota-catalogo]");
    if (nota) nota.innerHTML = `${total} estaciones · editar aquí cambia qué considera <b>todo</b> el sistema`;

    const pie = raiz.querySelector("[data-rol=paginacion]");
    const mostrando = pagina.length;
    pie.querySelector("[data-rol=conteo]").textContent =
      `Mostrando ${mostrando} de ${lista.length === total ? total : lista.length + " (de " + total + ")"}`;
    pie.querySelector("[data-rol=prev]").disabled = S.pagina <= 0;
    pie.querySelector("[data-rol=next]").disabled = desde + S.porPagina >= lista.length;

    cuerpo.querySelectorAll(".datos-editar").forEach(b =>
      b.onclick = () => abrirModalEstacion(raiz, b.dataset.cod));
  }

  function aplicarFiltro(raiz) {
    const q = norma(S.q);
    S.filtradas = !q ? S.estaciones.slice() : S.estaciones.filter(e =>
      norma(e.Codigo).includes(q) || norma(e.Nombre).includes(q) ||
      norma(e.Dependencia).includes(q) || norma(e.Region).includes(q));
    S.pagina = 0;
    pintarTabla(raiz);
  }

  async function cargarCatalogo(raiz) {
    const cuerpo = raiz.querySelector("[data-rol=tbody]");
    cuerpo.innerHTML = `<tr><td colspan="8" class="datos-vacio-fila">Cargando catálogo…</td></tr>`;
    try {
      const r = await App.api("/datos/estaciones");
      S.estaciones = r.estaciones || [];
      aplicarFiltro(raiz);
    } catch (e) {
      cuerpo.innerHTML = `<tr><td colspan="8" class="datos-vacio-fila">No se pudo cargar el catálogo: ${esc(e.message)}</td></tr>`;
    }
    // dependencias para sugerir en el modal (campo libre con datalist)
    App.api("/datos/dependencias").then(d => { S.deps = d.dependencias || []; }).catch(() => {});
  }

  /* ----------------------------------------- modal alta / edición (G.17) */
  function abrirModalEstacion(raiz, codigo) {
    const editando = !!codigo;
    const est = editando ? S.estaciones.find(e => String(e.Codigo) === String(codigo)) || {} : {};
    const opcsDep = (S.deps || []).map(d => `<option value="${esc(d)}">`).join("");
    const opcsReg = REGIONES.map(r =>
      `<option value="${r}"${norma(r) === norma(est.Region) ? " selected" : ""}>${r === "Amazonia" ? "Amazonía" : r}</option>`).join("");
    const opcsAgg = AGREGACIONES.map(a =>
      `<option value="${a}"${a === (est.Agregacion || "") ? " selected" : ""}>${a}</option>`).join("");

    const fondo = document.createElement("div");
    fondo.className = "modal-fondo";
    fondo.innerHTML = `
      <div class="modal datos-modal">
        <header>
          <span>${editando ? "Editar estación " + esc(codigo) : "Nueva estación"}</span>
          <button class="boton chico" data-rol="cerrar">Cerrar</button>
        </header>
        <div class="cuerpo">
          <p class="datos-modal-nota">El código es la clave que asocia observaciones y modelos en todo el sistema; debe ser único.</p>
          <div class="datos-form">
            <label class="campo"><span>Código</span>
              <input type="text" data-c="Codigo" value="${esc(est.Codigo ?? "")}" placeholder="M0024" maxlength="12"></label>
            <label class="campo datos-ancho2"><span>Nombre</span>
              <input type="text" data-c="Nombre" value="${esc(est.Nombre ?? "")}" placeholder="La Tola"></label>
            <label class="campo"><span>Latitud</span>
              <input type="number" step="any" data-c="Latitud" value="${esc(est.Latitud ?? "")}" placeholder="-0.23"></label>
            <label class="campo"><span>Longitud</span>
              <input type="number" step="any" data-c="Longitud" value="${esc(est.Longitud ?? "")}" placeholder="-78.37"></label>
            <label class="campo"><span>Altitud (msnm)</span>
              <input type="number" step="1" data-c="Altitud" value="${esc(est.Altitud ?? "")}" placeholder="2480"></label>
            <label class="campo"><span>Dependencia</span>
              <input type="text" list="datos-deps" data-c="Dependencia" value="${esc(est.Dependencia ?? "")}" placeholder="INAMHI">
              <datalist id="datos-deps">${opcsDep}</datalist></label>
            <label class="campo"><span>Región</span>
              <select data-c="Region"><option value="">—</option>${opcsReg}</select></label>
            <label class="campo"><span>Agregación precip.</span>
              <select data-c="Agregacion"><option value="">—</option>${opcsAgg}</select></label>
          </div>
        </div>
        <footer class="datos-modal-pie">
          <button class="boton" data-rol="cancelar">Cancelar</button>
          <button class="boton primario datos-guardar" data-rol="guardar">${editando ? "Guardar cambios" : "Crear estación"}</button>
        </footer>
      </div>`;
    document.body.appendChild(fondo);
    const cerrar = () => fondo.remove();
    fondo.querySelector("[data-rol=cerrar]").onclick = cerrar;
    fondo.querySelector("[data-rol=cancelar]").onclick = cerrar;
    fondo.addEventListener("click", ev => { if (ev.target === fondo) cerrar(); });

    fondo.querySelector("[data-rol=guardar]").onclick = async (ev) => {
      const btn = ev.currentTarget;
      const cuerpo = {};
      fondo.querySelectorAll("[data-c]").forEach(i => { cuerpo[i.dataset.c] = i.value.trim(); });
      btn.disabled = true;
      try {
        if (editando) await App.api("/datos/estaciones/" + encodeURIComponent(codigo),
          { method: "PUT", body: cuerpo });
        else await App.api("/datos/estaciones", { method: "POST", body: cuerpo });
        App.aviso(editando ? "Estación actualizada." : "Estación creada.", "ok");
        cerrar();
        await cargarCatalogo(raiz);
      } catch (e) {
        App.aviso(e.message, "error", 8000);
        btn.disabled = false;
      }
    };
  }

  /* ----------------------------------------------- bandeja de observaciones */
  async function pintarBandeja(caja) {
    try {
      const r = await App.api("/datos/observaciones/bandeja");
      const arch = r.archivos || [];
      const lista = arch.length
        ? arch.map(a => `
            <div class="datos-archivo">
              <span class="datos-archivo-ico">📄</span>
              <span class="datos-archivo-nombre mono">${esc(a.nombre)}</span>
            </div>`).join("")
        : `<div class="datos-bandeja-vacia">La bandeja está vacía.</div>`;
      caja.innerHTML = `
        <div class="datos-tarjeta-cab">
          <h3>Bandeja de observaciones</h3>
          <span class="datos-badge aviso">${arch.length} sin procesar</span>
        </div>
        <div class="datos-archivos">${lista}</div>
        <button class="boton oscuro datos-ingestar" data-rol="ingestar">Ingestar con control de calidad</button>`;
      caja.querySelector("[data-rol=ingestar]").onclick = async () => {
        try {
          const id = await App.tarea("/datos/ingerir_observaciones", {},
            { alTerminar: () => pintarBandeja(caja) });
          App.modalTarea("Ingestar observaciones", id);
        } catch (e) { App.aviso(e.message, "error"); }
      };
    } catch (e) {
      caja.innerHTML = `<div class="datos-tarjeta-cab"><h3>Bandeja de observaciones</h3></div>
        <div class="suave">No disponible: ${esc(e.message)}</div>`;
    }
  }

  /* ------------------------------------------------------------ credenciales */
  function credBadge(estado, texto) {
    // estado: "ok" | "aviso"
    const ico = estado === "ok" ? "✓" : "⚠";
    return `<span class="datos-badge ${estado}">${ico} ${esc(texto)}</span>`;
  }

  async function pintarCredenciales(caja) {
    try {
      const c = await App.api("/datos/credenciales");
      const r = c.resumen || {};
      const mbAct = (c.meteoblue && c.meteoblue.activas) || 0;
      caja.innerHTML = `
        <h3>Credenciales</h3>
        <div class="datos-cred">
          <div class="datos-cred-fila"><span>FFGS · Earthdata · CDS</span>
            ${credBadge(r.cartas_ok ? "ok" : "aviso", r.cartas_ok ? "completas" : "incompletas")}</div>
          <div class="datos-cred-fila"><span>Meteoblue (ML-NWP)</span>
            ${credBadge(r.meteoblue_ok ? "ok" : "aviso", mbAct ? mbAct + (mbAct === 1 ? " activa" : " activas") : "sin clave")}</div>
          <div class="datos-cred-fila"><span>API SITREP-SNGR</span>
            ${credBadge(r.sngr_ok ? "ok" : "aviso", r.sngr_ok ? "detectada" : "por rotar")}</div>
        </div>
        <p class="datos-cred-nota">El panel solo muestra presencia/estado, nunca los valores. La gestión vive en Configuración.</p>`;
    } catch (e) {
      caja.innerHTML = `<h3>Credenciales</h3><div class="suave">No disponible: ${esc(e.message)}</div>`;
    }
  }

  /* ------------------------------------------------------ cartografía común */
  // El conteo real de features vive en /capas/estado (geo.estado_capas):
  //   provincias/cantones/parroquias → {features, en_cache, fuente_disponible,…}
  const fmtMiles = n => (n == null) ? "—" : String(n).replace(/\B(?=(\d{3})+(?!\d))/g, " ");

  function filaCarto(etiqueta, info) {
    const f = info && info.features;
    const disp = info && (info.en_cache || info.fuente_disponible);
    const valor = f != null ? fmtMiles(f) : (disp ? "disponible" : "—");
    return `<div class="datos-carto-fila"><span>${esc(etiqueta)}</span>
      <span class="datos-carto-n mono">${esc(valor)}</span></div>`;
  }

  async function pintarCartografia(caja) {
    try {
      const e = await App.api("/datos/capas/estado");
      caja.innerHTML = `
        <h3>Cartografía común</h3>
        <div class="datos-carto">
          ${filaCarto("Provincias", e.provincias)}
          ${filaCarto("Cantones · CONALI 2022", e.cantones)}
          ${filaCarto("Parroquias · CONALI 2022", e.parroquias)}
        </div>`;
    } catch (err) {
      caja.innerHTML = `<h3>Cartografía común</h3><div class="suave">No disponible: ${esc(err.message)}</div>`;
    }
  }

  /* =====================================================================
     HERRAMIENTAS AVANZADAS — funciones que el diseño no muestra pero que
     no deben perderse (matriz manual de observaciones, fuentes de
     cartografía con detalle, diagnóstico del sistema). Viven plegadas en
     un <details> para no romper la composición del diseño.
     ===================================================================== */

  // ── matriz manual de observaciones (ancho/meta → validar → ingresar) ──
  function abrirModalMatriz() {
    const fondo = document.createElement("div");
    fondo.className = "modal-fondo";
    fondo.innerHTML = `
      <div class="modal datos-modal">
        <header><span>Ingreso manual de observaciones</span>
          <button class="boton chico" data-rol="cerrar">Cerrar</button></header>
        <div class="cuerpo" data-rol="cuerpo"><div class="suave">Cargando metadatos…</div></div>
      </div>`;
    document.body.appendChild(fondo);
    const cerrar = () => fondo.remove();
    fondo.querySelector("[data-rol=cerrar]").onclick = cerrar;
    fondo.addEventListener("click", ev => { if (ev.target === fondo) cerrar(); });
    const cuerpo = fondo.querySelector("[data-rol=cuerpo]");

    App.api("/datos/observaciones/ancho/meta").then(meta => {
      const vars = meta.variables || {};
      const claveVar = Object.keys(vars)[0] || "";
      // Sin recorte: el mapeo ancho→largo es POSICIONAL contra las casillas
      // marcadas; truncar el catálogo dejaría estaciones inseleccionables. Para
      // catálogos grandes (Ecuador: cientos) se añade un buscador en vivo.
      const ests = meta.estaciones || [];
      const optsVar = Object.entries(vars).map(([k, v]) =>
        `<option value="${esc(k)}">${esc(v.etiqueta || k)}</option>`).join("");
      const optsAnio = (meta.anios || []).map(a =>
        `<option value="${a}"${a === meta.anio_actual ? " selected" : ""}>${a}</option>`).join("");
      const optsMes = (meta.meses || []).map(m =>
        `<option value="${m.numero}"${m.numero === meta.mes_actual ? " selected" : ""}>${esc(m.nombre)}</option>`).join("");
      const optsEst = ests.map(e =>
        `<label class="datos-chk" data-busca="${esc(((e.codigo || "") + " " + (e.nombre || "")).toLowerCase())}"><input type="checkbox" value="${esc(e.codigo)}"> <span class="mono">${esc(e.codigo)}</span> ${esc(e.nombre)}</label>`).join("");

      cuerpo.innerHTML = `
        <p class="datos-modal-nota">Matriz ancha (formato Excel): fechas × estaciones. Convierte ancho→largo y hace upsert con respaldo .bak.</p>
        <div class="datos-form">
          <label class="campo"><span>Variable</span><select data-m="variable">${optsVar}</select></label>
          <label class="campo"><span>Agregación</span><select data-m="agregacion"></select></label>
          <label class="campo"><span>Año</span><select data-m="anio">${optsAnio}</select></label>
          <label class="campo"><span>Mes</span><select data-m="mes">${optsMes}</select></label>
        </div>
        <div class="datos-modal-nota" style="margin-top:12px">Estaciones (selecciona las de la columna · ${ests.length}):</div>
        <input type="search" data-rol="buscar-est" class="datos-buscar" placeholder="Filtrar por código o nombre…" autocomplete="off">
        <div class="datos-estaciones-chk">${optsEst || '<span class="suave">Sin estaciones.</span>'}</div>
        <label class="campo" style="margin-top:12px"><span>Valores diarios (una línea por día: día,v1,v2,… — vacío/NIL/T admitidos)</span>
          <textarea data-m="filas" rows="6" placeholder="1, 0, T, 5.2&#10;2, 1.1, 0, NIL"></textarea></label>
        <div class="datos-matriz-msg suave" data-rol="msg"></div>
        <div class="datos-modal-pie">
          <button class="boton" data-rol="validar">Validar</button>
          <button class="boton primario" data-rol="ingresar">Ingresar</button>
        </div>`;

      const selVar = cuerpo.querySelector("[data-m=variable]");
      const selAgg = cuerpo.querySelector("[data-m=agregacion]");
      const refrescarAgg = () => {
        const v = vars[selVar.value] || {};
        selAgg.innerHTML = (v.agregaciones || []).map(a =>
          `<option value="${esc(a.clave)}">${esc(a.etiqueta)}</option>`).join("");
      };
      selVar.onchange = refrescarAgg; refrescarAgg();

      // Buscador en vivo de estaciones (filtra las casillas sin perder marcas).
      const buscar = cuerpo.querySelector("[data-rol=buscar-est]");
      if (buscar) buscar.oninput = () => {
        const q = buscar.value.trim().toLowerCase();
        cuerpo.querySelectorAll(".datos-estaciones-chk .datos-chk").forEach(l => {
          l.style.display = (!q || (l.dataset.busca || "").includes(q)) ? "" : "none";
        });
      };

      const armar = () => {
        const codigos = [...cuerpo.querySelectorAll(".datos-estaciones-chk input:checked")].map(i => i.value);
        const filas = (cuerpo.querySelector("[data-m=filas]").value || "").trim().split("\n")
          .filter(l => l.trim()).map(l => l.split(/[,\t;]/).map(c => c.trim()));
        return {
          variable: selVar.value, agregacion: selAgg.value,
          anio: +cuerpo.querySelector("[data-m=anio]").value,
          mes: +cuerpo.querySelector("[data-m=mes]").value,
          codigos, filas,
        };
      };
      const msg = cuerpo.querySelector("[data-rol=msg]");
      cuerpo.querySelector("[data-rol=validar]").onclick = async () => {
        try {
          const r = await App.api("/datos/observaciones/ancho/validar", { method: "POST", body: armar() });
          msg.textContent = r.error_cabecera ? r.error_cabecera
            : `${r.valores_a_guardar ?? 0} valor(es) listos · ${(r.celdas_invalidas || []).length} celda(s) inválida(s).`;
        } catch (e) { msg.textContent = e.message; }
      };
      cuerpo.querySelector("[data-rol=ingresar]").onclick = async () => {
        try {
          const r = await App.api("/datos/observaciones/ingresar_ancho", { method: "POST", body: armar() });
          App.aviso(`Ingresadas ${r.ingresadas ?? 0} observación(es) · ${r.nuevas ?? 0} nuevas, ${r.reemplazadas ?? 0} reemplazadas.`, "ok");
          cerrar();
        } catch (e) { App.aviso(e.message, "error", 8000); }
      };
    }).catch(e => { cuerpo.innerHTML = `<div class="suave">No disponible: ${esc(e.message)}</div>`; });
  }

  async function pintarFuentesCarto(caja) {
    try {
      const f = await App.api("/datos/cartografia/fuentes");
      const inc = (f.incorporadas || []).map(c => `
        <tr><td>${esc(c.etiqueta || c.capa)}</td>
            <td>${esc(c.origen || "")}</td>
            <td>${c.disponible ? '<span class="etiqueta ok">✓</span>' : '<span class="etiqueta aviso">⚠</span>'}</td></tr>`).join("");
      const usr = (f.usuario || []).map(c => `
        <tr><td>${esc(c.etiqueta || c.capa)} · ${esc(c.nombre || "")}</td>
            <td>${esc(c.origen || "")}</td>
            <td><span class="etiqueta info">subida</span></td></tr>`).join("");
      caja.innerHTML = `
        <div class="tabla-caja"><table class="tabla">
          <thead><tr><th>Capa</th><th>Origen</th><th>Estado</th></tr></thead>
          <tbody>${inc}${usr || ""}</tbody>
        </table></div>`;
    } catch (e) {
      caja.innerHTML = `<div class="suave">No disponible: ${esc(e.message)}</div>`;
    }
  }

  async function pintarDiagnostico(caja) {
    caja.innerHTML = `<div class="suave">Cargando diagnóstico…</div>`;
    try {
      const d = await App.api("/datos/diagnostico");
      caja.innerHTML = `<pre class="datos-diag mono">${esc(JSON.stringify(d, null, 2))}</pre>`;
    } catch (e) {
      caja.innerHTML = `<div class="suave">No disponible: ${esc(e.message)}</div>`;
    }
  }

  function herramientasHTML() {
    return `
      <details class="datos-avanzadas">
        <summary>Herramientas avanzadas</summary>
        <div class="datos-avanzadas-cuerpo">
          <div class="rejilla c2">
            <div class="tarjeta">
              <h3>Ingreso manual de observaciones</h3>
              <p class="datos-cred-nota" style="margin-top:0">Matriz ancha (fechas × estaciones) con validación en vivo y respaldo .bak.</p>
              <button class="boton" data-rol="abrir-matriz">Abrir matriz manual</button>
            </div>
            <div class="tarjeta">
              <h3>Fuentes de cartografía</h3>
              <p class="datos-cred-nota" style="margin-top:0">Qué shapefile usa cada capa (programa vs. subidas por el usuario).</p>
              <div data-rol="fuentes-carto"><div class="suave">Cargando…</div></div>
            </div>
          </div>
          <div class="tarjeta mt">
            <div class="datos-tarjeta-cab">
              <h3>Diagnóstico del sistema</h3>
              <button class="boton chico" data-rol="recargar-diag">Recargar</button>
            </div>
            <div data-rol="diagnostico"><div class="suave">Despliega para cargar el diagnóstico.</div></div>
          </div>
        </div>
      </details>`;
  }

  /* ----------------------------------------------------------- render vista */
  // Redibujo al cambiar tema (patrón de sngr.js): repinta el catálogo visible
  // conservando búsqueda y página; el resto de tarjetas es 100 % tokens CSS.
  let _onTema = null;

  App.registrar("datos", {
    titulo: "Datos", icono: "🗄️", orden: 6,
    async render(vista) {
      const cab = document.getElementById("cabecera-vista");
      if (cab) cab.style.display = "none";

      // El estado S es singleton de módulo: al reentrar, el input nace vacío,
      // así que reseteamos la búsqueda/página para no arrastrar el filtro previo.
      S.q = ""; S.pagina = 0;

      vista.innerHTML = `
        <div data-screen-label="Datos" class="datos-raiz">
          ${cabeceraHTML()}

          <div class="datos-grid">
            <!-- IZQUIERDA: catálogo de estaciones -->
            <section class="tarjeta datos-catalogo">
              <div class="datos-catalogo-cab">
                <div>
                  <h3>Catálogo de estaciones</h3>
                  <div class="datos-catalogo-nota" data-rol="nota-catalogo">Cargando…</div>
                </div>
                <div class="datos-catalogo-acc">
                  <input type="text" class="datos-buscar" data-rol="buscar" placeholder="Buscar código o nombre…">
                  <button class="boton primario datos-nueva" data-rol="nueva">+ Nueva</button>
                </div>
              </div>
              <div class="datos-tabla-caja">
                <table class="datos-tabla">
                  <thead><tr>
                    <th>Código</th><th>Nombre</th>
                    <th class="datos-num">Lat</th><th class="datos-num">Lon</th><th class="datos-num">Alt</th>
                    <th>Dependencia</th><th>Región</th><th></th>
                  </tr></thead>
                  <tbody data-rol="tbody"></tbody>
                </table>
              </div>
              <div class="datos-paginacion" data-rol="paginacion">
                <span data-rol="conteo">Mostrando 0 de 0</span>
                <div class="datos-pag-botones">
                  <button class="datos-pag" data-rol="prev">‹</button>
                  <button class="datos-pag" data-rol="next">›</button>
                </div>
              </div>
            </section>

            <!-- DERECHA: bandeja + credenciales + cartografía -->
            <aside class="datos-lateral">
              <section class="tarjeta" data-rol="bandeja"></section>
              <section class="tarjeta" data-rol="credenciales"></section>
              <section class="tarjeta" data-rol="cartografia"></section>
            </aside>
          </div>

          ${herramientasHTML()}
        </div>`;

      const raiz = vista.querySelector(".datos-raiz");

      // catálogo
      const buscar = raiz.querySelector("[data-rol=buscar]");
      buscar.oninput = () => { S.q = buscar.value; aplicarFiltro(raiz); };
      raiz.querySelector("[data-rol=nueva]").onclick = () => abrirModalEstacion(raiz, null);
      raiz.querySelector("[data-rol=prev]").onclick = () => { if (S.pagina > 0) { S.pagina--; pintarTabla(raiz); } };
      raiz.querySelector("[data-rol=next]").onclick = () => {
        if ((S.pagina + 1) * S.porPagina < S.filtradas.length) { S.pagina++; pintarTabla(raiz); } };

      // herramientas avanzadas
      const det = raiz.querySelector(".datos-avanzadas");
      raiz.querySelector("[data-rol=abrir-matriz]").onclick = abrirModalMatriz;
      let cargadoAvanz = false;
      det.addEventListener("toggle", () => {
        if (det.open && !cargadoAvanz) {
          cargadoAvanz = true;
          pintarFuentesCarto(det.querySelector("[data-rol=fuentes-carto]"));
          pintarDiagnostico(det.querySelector("[data-rol=diagnostico]"));
        }
      });
      det.querySelector("[data-rol=recargar-diag]").onclick =
        () => pintarDiagnostico(det.querySelector("[data-rol=diagnostico]"));

      if (_onTema) document.removeEventListener("temacambiado", _onTema);
      _onTema = () => {
        const r = document.querySelector(".datos-raiz");
        if (r && S.estaciones.length) pintarTabla(r);
      };
      document.addEventListener("temacambiado", _onTema);

      // cargas paralelas (catálogo + 3 tarjetas laterales)
      await Promise.all([
        cargarCatalogo(raiz),
        pintarBandeja(raiz.querySelector("[data-rol=bandeja]")),
        pintarCredenciales(raiz.querySelector("[data-rol=credenciales]")),
        pintarCartografia(raiz.querySelector("[data-rol=cartografia]")),
      ]);
    },

    alDejar() {
      if (_onTema) { document.removeEventListener("temacambiado", _onTema); _onTema = null; }
      const cab = document.getElementById("cabecera-vista");
      if (cab) cab.style.display = "";
    },
  });
})();
