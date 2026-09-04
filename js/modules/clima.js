/* ============================================================
   Climatología — campos 1991–2020 y observaciones disponibles.
   Referencias 1991–2020 a 0.05° (precip/Tmáx/Tmín/PET) y soporte observacional.
   Cuatro pestañas: Mapas · Por estación · Por coordenada · Metodología.
   Backend: /api/clima/* (app/modulos/clima/datos.py).
   ============================================================ */
"use strict";

(() => {
  const esc = v => String(v ?? "").replace(/[&<>"']/g,
    c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const num = (v, d = 0) => (v == null || isNaN(v) ? "—" : Number(v).toLocaleString("es-EC",
    { minimumFractionDigits: d, maximumFractionDigits: d }));
  // Estados con voz propia: icono + texto centrado (usa .cl-vacio de clima.css).
  const vacio = (ic, txt) => `<div class="cl-vacio"><span class="ic">${ic}</span><span>${txt}</span></div>`;
  const cargando = txt => vacio("⏳", txt || "Cargando…");
  // Tarjeta de cifra. Estaba definida SOLO dentro de tarjetaPunto y tarjetaArea,
  // asi que la pestana "IUV experimental" (que la usa en tabIuv) reventaba con
  // "kpi is not defined" y le mostraba ese error de programador al ciudadano.
  // Se sube al ambito del modulo; las dos copias locales la tapan sin cambiar nada.
  const kpi = (e, v, u, d, c) => `<div class="cl-kpi" style="--kc:${c}"><div class="v">${num(v, d)} <small>${esc(u)}</small></div><div class="e">${esc(e)}</div></div>`;
  // Sobre un host que YA es un plot de Plotly, hacer host.innerHTML=... deja estado
  // interno huérfano y el siguiente Plotly.react renderiza a 0px de alto. Purga primero.
  function limpiarPlot(host) {
    try { if (window.Plotly && host && host.classList && host.classList.contains("js-plotly-plot")) Plotly.purge(host); }
    catch (e) {}
    // El purge elimina los handlers plotly_click pero los flags _clickEst/_clickRank
    // persisten en el nodo → sin esto, tras un error transitorio el clic quedaba muerto.
    if (host) { delete host._clickEst; delete host._clickRank; }
  }

  function quitarPlaceholder(host) {
    if (!host) return;
    Array.from(host.children || []).forEach(child => {
      if (child.classList && child.classList.contains("cl-vacio")) child.remove();
    });
  }

  // La librería de gráficos viene solo con inglés ("Aug 13", "Jan 1998") y el proyecto
  // no carga su fichero de idioma: se registra aquí un español mínimo (meses y días para
  // los ejes de fecha) y todos los gráficos del módulo lo piden en su configuración.
  let _locEs = false;
  function configEs() {
    if (!_locEs && window.Plotly && typeof Plotly.register === "function") {
      try {
        Plotly.register({ moduleType: "locale", name: "es", dictionary: {}, format: {
          days: ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"],
          shortDays: ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"],
          months: ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"],
          shortMonths: ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"],
          date: "%d/%m/%Y" } });
      } catch (e) { /* sin registro: los ejes quedan en inglés, nada se rompe */ }
      _locEs = true;
    }
    return Object.assign({}, App.plotlyConfig(), { locale: "es" });
  }

  // c = color representativo de la variable (≈ su paleta en el mapa); alimenta el
  // swatch del pill (--pc) para que el control enseñe el color del campo.
  // t = explicación en llano (texto emergente del pill: PET/Balance/Aridez son fórmulas)
  const VARS = [
    { id: "precip", et: "Precipitación", u: "mm", c: "#2f7fc1", t: "Lluvia acumulada" },
    { id: "tmax", et: "T. máxima", u: "°C", c: "#e0562d", t: "Temperatura máxima" },
    { id: "tmin", et: "T. mínima", u: "°C", c: "#2e8bc0", t: "Temperatura mínima" },
    { id: "pet", et: "PET", u: "mm", c: "#d08a2e", t: "Evaporación potencial: el agua que se evaporaría con el calor disponible" },
    { id: "balance", et: "Balance P−PET", u: "mm/año", soloAnual: true, c: "#2f9e8f", t: "Agua sobrante: lluvia menos evaporación potencial" },
    { id: "aridez", et: "Aridez P/PET", u: "", soloAnual: true, c: "#b07a2e", t: "Sequedad: lluvia dividida entre evaporación potencial (menos de 1 = zona seca)" },
  ];
  const MESES = ["Anual", "Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];
  const COL = { precip: "#2f7fc1", pet: "#d08a2e", tmax: "#e0562d", tmin: "#2e8bc0", obs: "#10243f" };

  function dependenciaEstacion(estacion) {
    const value = estacion && (estacion.red_etiqueta || estacion.dependencia || estacion.Dependencia);
    return App.redEtiqueta(value || "Sin dependencia");
  }

  function regionEstacion(estacion) {
    return String(estacion && (estacion.region || estacion.Region) || "Sin región");
  }

  function opcionEstacion(estacion, sufijo = "") {
    const codigo = String(estacion.codigo || estacion.Codigo || "");
    const nombre = estacion.nombre || estacion.Nombre || codigo;
    return `${esc(nombre)} (${esc(codigo)}) · ${esc(regionEstacion(estacion))} · ${esc(dependenciaEstacion(estacion))}${sufijo}`;
  }

  function coincideEstacion(estacion, consulta) {
    const codigo = estacion.codigo || estacion.Codigo || "";
    const nombre = estacion.nombre || estacion.Nombre || "";
    return `${codigo} ${nombre} ${regionEstacion(estacion)} ${dependenciaEstacion(estacion)}`
      .toLowerCase().includes(String(consulta || "").trim().toLowerCase());
  }

  // Estilos del módulo: viven en ui/css/clima.css (cargado desde index.html).
  // Se conserva la función como no-op para no tocar los call-sites de cada pestaña.
  function inyectarCSS() {}

  // Contorno provincial (geojson) reutilizable -------------------------------
  let geo = null;
  async function cargarGeo() {
    if (geo !== null) return;
    try { geo = await App.api("/datos/capas/provincias.geojson"); } catch (e) { geo = false; }
  }
  function contorno() {
    if (!geo || !geo.features) return [];
    const xs = [], ys = [];
    for (const f of geo.features) {
      const g = f.geometry; if (!g) continue;
      const polys = g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : [];
      for (const poly of polys) for (const ring of poly) {
        for (const [x, y] of ring) { xs.push(x); ys.push(y); } xs.push(null); ys.push(null);
      }
    }
    // Mapa TEMÁTICO (Climatología no es Pronóstico): claro = halo blanco + línea negra
    // (papel); oscuro = halo del fondo del tema + línea clara, para que el contorno se
    // lea sobre el mar oscuro. Se redibuja al conmutar el tema (_alTema → dibujar).
    const osc = App.tema && App.tema() === "oscuro";
    return [
      { type: "scatter", mode: "lines", x: xs, y: ys, hoverinfo: "skip", showlegend: false,
        line: { color: osc ? "#0B1322" : "#ffffff", width: 2.8 } },
      { type: "scatter", mode: "lines", x: xs, y: ys, hoverinfo: "skip", showlegend: false,
        line: { color: osc ? "#AEBBD0" : "#000000", width: 1.2 } },
    ];
  }

  // Capa de estaciones sobre el mapa: valor de la normal activa muestreado en cada
  // estación (endpoint /clima/estaciones?mes=&variable=), coloreado con la MISMA
  // escala del heatmap para leerse como parte del campo.
  function trazaEstaciones(ce, d) {
    const pts = ((ce && ce.estaciones) || []).filter(e => e.valor != null && e.lat != null && e.lon != null);
    if (!pts.length) return [];
    const dec = ce.dec != null ? ce.dec : 1;
    return [{
      type: "scatter", mode: "markers", meta: "estaciones", showlegend: false,
      x: pts.map(e => e.lon), y: pts.map(e => e.lat),
      customdata: pts.map(e => [e.nombre || e.codigo, e.codigo, num(e.valor, dec)]),
      // Marcador pequeño y, con muchos puntos (>200), sin aro blanco: con 8.5 px + aro
      // los 1.061 círculos se apilaban y cubrían media superficie del país dibujada.
      marker: { size: 4.5, color: pts.map(e => e.valor), colorscale: d.colorscale,
        cmin: d.vmin, cmax: d.vmax, showscale: false,
        line: { color: "#ffffff", width: pts.length > 200 ? 0 : 1.5 } },
      hovertemplate: `<b>%{customdata[0]}</b> (%{customdata[1]})<br>` +
        `<b>%{customdata[2]} ${esc(ce.unidad || "")}</b> · clic → ficha de la estación<extra></extra>`,
    }];
  }

  // Leyenda HORIZONTAL bajo el mapa — mismo componente visual que las cartas
  // (ct-leyenda-*: barra de gradiente + ticks mono). Pedido del dueño 2026-07-09:
  // la barra vertical de Plotly robaba media pantalla en móvil y desentonaba.
  function leyendaMapa(d, dec) {
    const cs = d.colorscale || [];
    if (!cs.length || d.vmin == null || d.vmax == null) return "";
    const stops = cs.map(p => `${p[1]} ${(p[0] * 100).toFixed(2)}%`).join(", ");
    const rango = (d.vmax - d.vmin) || 1;
    let tk = "";
    const niv = Array.isArray(d.niveles) ? d.niveles.filter(v => v != null && isFinite(v)) : [];
    if (niv.length >= 2) {
      // Fronteras REALES de las franjas (campo "niveles" del producto): cada número cae
      // exactamente en el borde de color al que corresponde. Antes se inventaban cifras
      // redondas que caían en mitad de una franja y la leyenda no describía el mapa.
      // Si no caben todas, se rotula una sí y una no, siempre sobre fronteras reales.
      const salto = Math.max(1, Math.ceil(niv.length / 9));
      niv.forEach((v, i) => {
        if (i % salto !== 0 && i !== niv.length - 1) return;
        const pos = Math.max(0, Math.min(100, ((v - d.vmin) / rango) * 100));
        tk += `<span class="t" style="left:${pos.toFixed(2)}%">${esc(String(+v.toFixed(dec)))}</span>`;
      });
    } else {
      // Respaldo (mapas generados en el navegador, sin "niveles"): ticks "bonitos"
      // (múltiplos de 1/2/2.5/5×10^k), posicionados por su valor real.
      const crudo = rango / 6, pot = Math.pow(10, Math.floor(Math.log10(crudo)));
      const paso = [1, 2, 2.5, 5, 10].map(m => m * pot).find(s => rango / s <= 7) || crudo;
      for (let v = Math.ceil(d.vmin / paso) * paso; v <= d.vmax + 1e-9; v += paso) {
        const pos = ((v - d.vmin) / rango) * 100;
        tk += `<span class="t" style="left:${pos.toFixed(2)}%">${esc(String(+v.toFixed(dec)))}</span>`;
      }
    }
    return `<div class="ct-leyenda-cab"><span class="ct-leyenda-unidad mono">${esc(d.unidad || "")}</span>` +
      `<span class="ct-leyenda-sub mono">${esc(d.leyenda_sub || "normal 1991–2020")}</span></div>` +
      `<div class="ct-leyenda-barra" style="background:linear-gradient(to right, ${stops})"></div>` +
      `<div class="ct-leyenda-ticks">${tk}</div>`;
  }

  function observarTamanoMapa(host) {
    if (!host || host._clResizeObserver || typeof ResizeObserver !== "function") return;
    let timer = null, lastWidth = Math.round(host.clientWidth || 0);
    host._clResizeObserver = new ResizeObserver(entries => {
      const width = Math.round((entries[0] && entries[0].contentRect.width) || host.clientWidth || 0);
      if (!width || Math.abs(width - lastWidth) < 3) return;
      lastWidth = width;
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (!host.isConnected || !window.Plotly || !host.classList.contains("js-plotly-plot")) return;
        const height = Math.max(380, Math.min(640, Math.round(width * 1.08)));
        try { Plotly.relayout(host, { height }); Plotly.Plots.resize(host); } catch (e) {}
      }, 90);
    });
    host._clResizeObserver.observe(host);
  }

  // Mapa de una normal --------------------------------------------------------
  // Aridez P/PET: el producto congelado trae una rampa marrón→crema donde lo MÁS húmedo
  // sale casi blanco (se lee como "sin dato") y el corte físico en 1 (P = PET) cae en
  // mitad de una franja. Mientras el generador no regenere el producto, se sustituye en
  // cliente por una escala de dos colores anclada en 1: marrones = falta agua, crema en
  // el equilibrio y verde-azulados = sobra agua. Los valores no se tocan.
  function escalaAridez(d) {
    const p = Math.max(0.02, Math.min(0.98, (1 - d.vmin) / (d.vmax - d.vmin)));
    return [
      [0, "#5c3305"], [p * 0.5, "#b07a2e"], [p, "#f3eede"],
      [p + (1 - p) * 0.45, "#5fa8a0"], [1, "#0b4f6c"],
    ];
  }

  function pintarMapa(host, d, ce) {
    if (!window.Plotly || !host) return;
    if (!d || d.error) { limpiarPlot(host); host.innerHTML = vacio("🗺️", esc(d && d.error || "Sin datos")); return; }
    if (d.variable === "aridez" && d.vmin != null && d.vmax != null && d.vmax > d.vmin)
      d = Object.assign({}, d, { colorscale: escalaAridez(d) });
    const dec = (d.variable === "tmax" || d.variable === "tmin" || d.operacion === "anomalia_mm")
      ? 1 : (d.variable === "aridez" ? 2 : 0);
    const heat = {
      type: "heatmap", x: d.lon, y: d.lat, z: d.campo, colorscale: d.colorscale,
      zmin: d.vmin, zmax: d.vmax, zsmooth: "best", hoverongaps: false,
      showscale: false,   // v12: la escala vive en la leyenda horizontal bajo el mapa
      hovertemplate: `lat %{y:.2f}, lon %{x:.2f}<br><b>%{z:.${dec}f} ${esc(d.unidad || "")}</b><extra></extra>`,
    };
    // Encuadre ECUADOR CONTINENTAL: la grilla es continental, pero el contorno
    // provincial incluye Galápagos y el autorange alejaba el mapa hacia el oeste.
    // Rango fijo del render (bbox continental); los datos NO se filtran.
    // Altura ajustada al ASPECTO de Ecuador (lat 6.7° / lon 6.1° ≈ 1.1): el mapa
    // estrecho queda ceñido al país, sin franjas de mar muertas (pedido del dueño).
    const alto = Math.max(380, Math.min(640, Math.round((host.clientWidth || 520) * 1.08)));
    const layout = App.plotlyLayoutBase({
      height: alto, margin: { l: 6, r: 6, t: 6, b: 6 },
      xaxis: { visible: false, scaleanchor: "y", constrain: "domain", fixedrange: false,
        range: [-81.2, -75.1] },
      yaxis: { visible: false, fixedrange: false, range: [-5.1, 1.6] },
    });
    quitarPlaceholder(host);
    Plotly.react(host, [heat, ...contorno(), ...trazaEstaciones(ce, d)], layout, configEs());
    observarTamanoMapa(host);
    if (App.pinchZoomMapa) App.pinchZoomMapa(host);   // v17: pinza = zoom del mapa
    const ley = host.parentElement && host.parentElement.querySelector('[data-rol="leyenda"]');
    if (ley) ley.innerHTML = leyendaMapa(d, dec);
  }

  // Climograma (barras precip + líneas temp + PET + obs) ----------------------
  function pintarClimograma(host, p) {
    if (!window.Plotly || !host) return;
    const osc = App.tema && App.tema() === "oscuro";
    const obsCol = osc ? "#AEBBD0" : "#64748B";                    // observado, discreto (no compite)
    const grid = osc ? "rgba(140,155,185,.12)" : "rgba(120,130,150,.14)";
    const linea = osc ? "#3a4a66" : "#d3dbe6";
    const txt = osc ? "#c6d0e0" : "#46597A";
    const brdM = osc ? "#101a2b" : "#ffffff";                      // borde de marcador (separa del fondo)
    const meses = p.meses || MESES.slice(1);
    const V = p.vars || {};
    const traces = [];
    if (V.precip) traces.push({ type: "bar", x: meses, y: V.precip.valores, name: "Precipitación",
      marker: { color: COL.precip, opacity: .85 }, yaxis: "y", hovertemplate: "%{y} mm<extra>Precip</extra>" });
    if (V.pet) traces.push({ type: "scatter", mode: "lines", x: meses, y: V.pet.valores, name: "PET",
      line: { color: COL.pet, width: 1.8, dash: "dot", shape: "spline" }, yaxis: "y", hovertemplate: "%{y} mm<extra>PET</extra>" });
    if (V.tmax) traces.push({ type: "scatter", mode: "lines+markers", x: meses, y: V.tmax.valores, name: "T. máx",
      line: { color: COL.tmax, width: 2.6, shape: "spline" }, marker: { size: 5.5, color: COL.tmax, line: { color: brdM, width: 1 } },
      yaxis: "y2", hovertemplate: "%{y} °C<extra>Tmáx</extra>" });
    if (V.tmin) traces.push({ type: "scatter", mode: "lines+markers", x: meses, y: V.tmin.valores, name: "T. mín",
      line: { color: COL.tmin, width: 2.6, shape: "spline" }, marker: { size: 5.5, color: COL.tmin, line: { color: brdM, width: 1 } },
      yaxis: "y2", hovertemplate: "%{y} °C<extra>Tmín</extra>" });
    const o = p.observado;
    if (o) {
      if (o.precip) traces.push({ type: "scatter", mode: "markers", x: meses, y: o.precip, name: "Precip. observada",
        marker: { color: obsCol, symbol: "circle", size: 5, opacity: .9 }, yaxis: "y",
        hovertemplate: "%{y} mm<extra>Obs</extra>" });
      if (o.tmax) traces.push({ type: "scatter", mode: "markers", x: meses, y: o.tmax, name: "Tmáx observada",
        marker: { color: obsCol, symbol: "diamond", size: 5, opacity: .9 }, yaxis: "y2", showlegend: false,
        hovertemplate: "%{y} °C<extra>Obs</extra>" });
      if (o.tmin) traces.push({ type: "scatter", mode: "markers", x: meses, y: o.tmin, name: "Tmín observada",
        marker: { color: obsCol, symbol: "diamond", size: 5, opacity: .9 }, yaxis: "y2", showlegend: false,
        hovertemplate: "%{y} °C<extra>Obs</extra>" });
    }
    const layout = App.plotlyLayoutBase({
      height: 360, margin: { l: 52, r: 52, t: 16, b: 36 }, barmode: "overlay",
      legend: { orientation: "h", y: 1.15, x: 0.5, xanchor: "center", font: { size: 11 }, bgcolor: "rgba(0,0,0,0)" },
      xaxis: { tickfont: { size: 11, color: txt }, fixedrange: true, showgrid: false, showline: true,
        linecolor: linea, ticks: "outside", ticklen: 4, tickcolor: linea },
      yaxis: { title: { text: "Precipitación / PET (mm)", font: { size: 10.5, color: txt } }, tickfont: { size: 10, color: txt },
        rangemode: "tozero", fixedrange: true, gridcolor: grid, griddash: "dot", zeroline: false, showline: false },
      yaxis2: { title: { text: "Temperatura (°C)", font: { size: 10.5, color: txt } }, tickfont: { size: 10, color: txt },
        overlaying: "y", side: "right", fixedrange: true, showgrid: false, zeroline: false },
    });
    Plotly.react(host, traces, layout, configEs());
    host.setAttribute("role", "img");
    host.setAttribute("aria-label", `Climograma${p.nombre ? " de " + p.nombre : ""}: lluvia y evaporación mensuales en milímetros y temperaturas máxima y mínima en grados.`);
  }

  function tablaMensual(p) {
    const meses = p.meses || MESES.slice(1);
    const fila = (et, arr, cls) => `<tr${cls ? ` class="${cls}"` : ""}><td>${esc(et)}</td>${meses.map((_, i) =>
      `<td>${arr && arr[i] != null ? esc(arr[i]) : "—"}</td>`).join("")}</tr>`;
    const V = p.vars || {};
    // Percentiles mensuales OBSERVADOS (resumen_obs, solo estaciones): rango P10–P90.
    const R = p.resumen_obs || {};
    const banda = (o, d) => (o && o.p10 && o.p90)
      ? meses.map((_, i) => (o.p10[i] != null && o.p90[i] != null
        ? `${num(o.p10[i], d)}–${num(o.p90[i], d)}` : null))
      : null;
    const bp = banda(R.precip, 0), bx = banda(R.tmax, 1), bn = banda(R.tmin, 1);
    return `<table class="cl-tabla"><thead><tr><th>Variable</th>${meses.map(m => `<th>${esc(m)}</th>`).join("")}</tr></thead>
      <tbody>
        ${V.precip ? fila("Precip (mm)", V.precip.valores) : ""}
        ${bp ? fila("Precip P10–P90 obs.", bp, "cl-pct") : ""}
        ${V.tmax ? fila("Tmáx (°C)", V.tmax.valores) : ""}
        ${bx ? fila("Tmáx P10–P90 obs.", bx, "cl-pct") : ""}
        ${V.tmin ? fila("Tmín (°C)", V.tmin.valores) : ""}
        ${bn ? fila("Tmín P10–P90 obs.", bn, "cl-pct") : ""}
        ${V.pet ? fila("PET (mm)", V.pet.valores) : ""}
      </tbody></table>`;
  }

  // Resumen de la serie observada de la estación: años, completitud, récords con fecha.
  function resumenObs(r) {
    if (!r) return "";
    const filas = [["precip", "Precipitación", "mm"], ["tmax", "T. máxima", "°C"], ["tmin", "T. mínima", "°C"]]
      .filter(([k]) => r[k]).map(([k, et, u]) => {
        const o = r[k];
        const rec = x => x ? `${num(x.valor, 1)} <small>${esc(u)}</small> <span class="cl-fecha">${esc(x.fecha)}</span>` : "—";
        return `<tr><td>${esc(et)}</td><td>${o.n_anios != null ? num(o.n_anios) : "—"} <small>${o.desde}–${o.hasta}</small></td>
          <td>${num(o.completitud, 0)}%</td><td>${rec(o.record_max)}</td><td>${k === "precip" ? "—" : rec(o.record_min)}</td></tr>`;
      }).join("");
    if (!filas) return "";
    return `<div class="cl-tabla-scroll"><table class="cl-tabla cl-tabla-obs">
      <thead><tr><th>Serie observada</th><th>Años</th><th title="Días con dato sobre el periodo">Compl.</th>
      <th>Récord máx (día)</th><th>Récord mín (día)</th></tr></thead><tbody>${filas}</tbody></table>
      <p class="cl-nota" style="margin-top:6px">Serie histórica diaria de la estación: récords absolutos con su fecha
      y percentiles mensuales P10–P90 en la tabla.</p></div>`;
  }

  function chipConfianza(c) {
    if (!c || c.dist_estacion_km == null) return "";
    const d = c.dist_estacion_km;
    const cls = c.fuera_calibracion ? "baja" : d <= 10 ? "ok" : d <= 30 ? "med" : "baja";
    const txt = c.fuera_calibracion ? "Fuera de calibración (>4000 m)"
      : `Estación más cercana a ${num(d, 1)} km · ${d <= 10 ? "alta" : d <= 30 ? "media" : "baja"} confianza`;
    return `<div class="cl-conf ${cls}">● ${esc(txt)}</div>`;
  }

  function tarjetaPunto(p, titulo) {
    if (p.error) return vacio("⚠️", esc(p.error));
    const fuera = p.fuera_dominio || !(p.vars && p.vars.precip && p.vars.precip.anual != null);
    if (fuera) return `<div class="cl-card">${titulo ? `<p class="cl-maptit">${esc(titulo)}</p>` : ""}
      <div class="cl-aviso"><span class="ic">🌐</span><p><b>Fuera del dominio continental.</b> La climatología grillada
      cubre Ecuador continental (0.05°); Galápagos y el océano quedan fuera. Si es una estación insular,
      abajo tienes su serie observada.</p></div>
      ${resumenObs(p.resumen_obs)}</div>`;
    const V = p.vars;
    const kpi = (e, v, u, d, c) => `<div class="cl-kpi" style="--kc:${c}"><div class="v">${num(v, d)} <small>${esc(u)}</small></div><div class="e">${esc(e)}</div></div>`;
    return `<div class="cl-card">
      ${titulo ? `<p class="cl-maptit">${esc(titulo)}</p>` : ""}
      <div class="cl-kpis">
        ${kpi("Lluvia anual", V.precip && V.precip.anual, "mm", 0, COL.precip)}
        ${kpi("PET anual", V.pet && V.pet.anual, "mm", 0, COL.pet)}
        ${kpi("Tmáx media", V.tmax && V.tmax.anual, "°C", 1, COL.tmax)}
        ${kpi("Tmín media", V.tmin && V.tmin.anual, "°C", 1, COL.tmin)}
      </div>
      ${chipConfianza(p.confianza)}
      <div class="cl-tabla-scroll">${tablaMensual(p)}</div>
      ${resumenObs(p.resumen_obs)}
      ${p.observado ? `<p class="cl-nota">Los marcadores resumen las observaciones disponibles para la estación.
        Su periodo y escala espacial pueden diferir de la malla 1991–2020, por lo que no se espera coincidencia exacta.</p>` : ""}
    </div>`;
  }

  function tarjetaArea(p) {
    if (!p || p.error) return vacio("⚠️", esc(p && p.error || "Sin datos areales"));
    const V = p.vars || {};
    const kpi = (e, v, u, d, c) => `<div class="cl-kpi" style="--kc:${c}"><div class="v">${num(v, d)} <small>${esc(u)}</small></div><div class="e">${esc(e)}</div></div>`;
    const cobertura = ["precip", "tmax", "tmin", "pet"].filter(k => V[k]).map(k =>
      `${V[k].etiqueta}: ${num(V[k].cobertura_pct, 1)}% (${num(V[k].pixeles_validos)} píxeles)`).join(" · ");
    return `<div class="cl-card">
      <p class="cl-maptit">${esc(p.nombre)}${p.region ? ` · ${esc(App.redEtiqueta(p.region))}` : ""}</p>
      <div class="cl-kpis">
        ${kpi("Lluvia media areal anual", V.precip && V.precip.anual, "mm", 0, COL.precip)}
        ${kpi("PET media areal anual", V.pet && V.pet.anual, "mm", 0, COL.pet)}
        ${kpi("Tmáx media areal", V.tmax && V.tmax.anual, "°C", 1, COL.tmax)}
        ${kpi("Tmín media areal", V.tmin && V.tmin.anual, "°C", 1, COL.tmin)}
      </div>
      <div class="cl-tabla-scroll">${tablaMensual(p)}</div>
      <p class="cl-nota">Promedio por superficie de los centros de píxel dentro del polígono (${num(p.area_malla_km2, 0)} km² de malla). Los faltantes no valen cero. Cobertura anual completa: ${esc(cobertura || "no disponible")}.</p>
    </div>`;
  }

  // PESTAÑA 1 — MAPAS ---------------------------------------------------------
  // mapEst arranca APAGADO: los 1.061 puntos de estación tapaban el campo de colores
  // al entrar (y descargaban ~236 KB por combinación). La capa es una elección consciente.
  const E = { mapVar: "precip", mapEsc: "anual", mapEst: false, mapaCache: {}, estCache: {},
    tabs: null, estSel: null };
  // Los colores de los gráficos se eligen AL PINTAR (App.tema()): al cambiar de tema
  // hay que redibujar el panel visible (patrón sngr.js). Cada pestaña registra su redibujo.
  let _alTema = null;
  document.addEventListener("temacambiado", () => { try { if (_alTema) _alTema(); } catch (e) {} });

  async function tabMapas(c) {
    inyectarCSS(); _alTema = null; await cargarGeo();
    c.innerHTML = `<div class="cl-wrap">
      <div class="cl-toolbar">
        <div class="cl-grupo"><span>Variable</span><div class="cl-pills" data-rol="vars">
          ${VARS.map(v => `<button class="cl-pill ${v.id === E.mapVar ? "on" : ""}" data-v="${v.id}" style="--pc:${v.c}" title="${esc(v.t || v.et)}">${esc(v.et)}</button>`).join("")}
        </div></div>
        <div class="cl-grupo"><span>Escala</span><div class="cl-meses" data-rol="meses">
          ${MESES.map((m, i) => `<button class="cl-mes ${(i === 0 ? "anual" : i) == E.mapEsc ? "on" : ""}" data-e="${i === 0 ? "anual" : i}">${esc(m)}</button>`).join("")}
        </div></div>
        <div class="cl-grupo"><span>Capa</span>
          <label class="cl-chk"><input type="checkbox" data-rol="chk-est" ${E.mapEst ? "checked" : ""}> estaciones (valor)</label></div>
      </div>
      <div class="cl-mapgrid">
        <div class="cl-card cl-mapa-card"><h3 class="cl-maptit" data-rol="tit">Cargando…</h3><div class="cl-plot cl-plot-mapa" data-rol="plot"></div>
          <div class="ct-leyenda-carta cl-leyenda" data-rol="leyenda"></div>
          <p class="cl-nota">Referencia mensual 1991–2020 (~5 km) de la generación climática activa. Pasa el cursor para leer lat/lon y valor; los puntos muestran observaciones disponibles (clic → su ficha).</p></div>
        <div class="cl-card cl-est-card"><h3 class="cl-maptit" data-rol="mini-tit">Resumen por área o estación</h3>
          <div class="cl-mini-sel">
            <select data-rol="mini-area" class="cl-mini-select"><option value="">Provincia (promedio areal)…</option></select>
          </div>
          <div class="cl-mini-sel">
            <input class="cl-buscar" data-rol="mini-buscar" type="search" placeholder="Buscar nombre, código, región o dependencia…" autocomplete="off">
            <select data-rol="mini-est" class="cl-mini-select"></select>
          </div>
          <div class="cl-est-cuerpo" data-rol="mini">${vacio("📍", "Elige una provincia para su climatología ponderada por superficie, o toca una estación para consultar su punto y observaciones.")}</div></div>
      </div>
    </div>`;
    const plot = c.querySelector('[data-rol="plot"]'), tit = c.querySelector('[data-rol="tit"]');
    const meses = c.querySelector('[data-rol="meses"]'), chkEst = c.querySelector('[data-rol="chk-est"]');
    const miniEl = c.querySelector('[data-rol="mini"]'), miniTit = c.querySelector('[data-rol="mini-tit"]');
    let miniUlt = null;   // {p, nom, cod} del último climograma lateral (redibujo al cambiar tema)

    // FICHA COMPLETA de la estación en el LATERAL del mapa (v16, pedido del dueño:
    // los KPIs de campo y el ranking top/bottom eran irrelevantes — el lateral es
    // ahora la ficha: climograma + normales mensuales + serie observada, apilados).
    async function miniFicha(cod, nom) {
      miniTit.textContent = `Ficha — ${nom || cod}`;
      const selArea = c.querySelector('[data-rol="mini-area"]');
      if (selArea) selArea.value = "";
      const selEst = c.querySelector('[data-rol="mini-est"]');
      if (selEst && selEst.value !== String(cod)) selEst.value = String(cod);
      miniEl.innerHTML = cargando();
      let p;
      try { p = await App.api(`/clima/estacion?codigo=${encodeURIComponent(cod)}`); }
      catch (e) { miniEl.innerHTML = vacio("⚠️", esc(e.message)); return; }
      const ficha = tarjetaPunto(p, `${nom || cod} (${cod})`);
      if (p.error || p.fuera_dominio || !(p.vars && p.vars.precip && p.vars.precip.anual != null)) {
        // La propia tarjeta explica el fuera-de-dominio y trae la serie observada.
        miniEl.innerHTML = `<div class="cl-ficha-pila">${ficha}</div>`;
      } else {
        miniEl.innerHTML = `<div class="cl-ficha-pila"><div class="cl-plot" data-rol="mini-climo"></div>${ficha}</div>`;
        pintarClimograma(miniEl.querySelector('[data-rol="mini-climo"]'), p);
      }
      miniUlt = { p, nom, cod };
    }
    async function miniArea(nombre) {
      if (!nombre) return;
      miniTit.textContent = `Climatología areal — ${nombre}`;
      const selEst = c.querySelector('[data-rol="mini-est"]');
      if (selEst) selEst.value = "";
      miniEl.innerHTML = cargando("Calculando promedio por superficie…");
      let p;
      try { p = await App.api(`/clima/area?nombre=${encodeURIComponent(nombre)}`); }
      catch (e) { miniEl.innerHTML = vacio("⚠️", esc(e.message)); return; }
      if (p.error) { miniEl.innerHTML = vacio("⚠️", esc(p.error)); return; }
      miniEl.innerHTML = `<div class="cl-ficha-pila"><div class="cl-plot" data-rol="mini-climo"></div>${tarjetaArea(p)}</div>`;
      pintarClimograma(miniEl.querySelector('[data-rol="mini-climo"]'), p);
      miniUlt = { p, area: nombre };
    }
    // Selector de estación del panel (buscador + lista agrupada por región).
    (async () => {
      let ests = [];
      try { ests = (await App.api("/clima/estaciones")).estaciones || []; } catch (e) {}
      const selEst = c.querySelector('[data-rol="mini-est"]'), busc = c.querySelector('[data-rol="mini-buscar"]');
      if (!selEst || !ests.length) return;
      const opciones = lista => {
        const grupos = new Map();
        for (const e of lista) {
          const rg = e.region || "Sin región";
          if (!grupos.has(rg)) grupos.set(rg, []);
          grupos.get(rg).push(e);
        }
        return `<option value="" disabled selected>Elige una estación…</option>` +
          [...grupos.keys()].sort((a, b) => a.localeCompare(b, "es")).map(rg =>
            `<optgroup label="${esc(App.redEtiqueta(rg))}">${grupos.get(rg).map(e =>
              `<option value="${esc(String(e.codigo))}">${opcionEstacion(e)}</option>`).join("")}</optgroup>`).join("");
      };
      selEst.innerHTML = opciones(ests);
      const nomDe = cod => (ests.find(e => String(e.codigo) === String(cod)) || {}).nombre || cod;
      selEst.onchange = () => { if (selEst.value) miniFicha(selEst.value, nomDe(selEst.value)); };
      if (busc) busc.oninput = () => {
        const q = busc.value.trim().toLowerCase();
        const lista = !q ? ests : ests.filter(e => coincideEstacion(e, q));
        const previa = selEst.value;
        selEst.innerHTML = opciones(lista);
        if (lista.some(e => String(e.codigo) === String(previa))) selEst.value = previa;
        else if (lista.length === 1) { selEst.value = String(lista[0].codigo); selEst.onchange(); }
      };
    })();
    (async () => {
      const selArea = c.querySelector('[data-rol="mini-area"]');
      if (!selArea) return;
      let lista = [];
      try { lista = (await App.api("/clima/areas")).areas || []; } catch (e) {}
      selArea.innerHTML = `<option value="">Provincia (promedio areal)…</option>` + lista.map(a =>
        `<option value="${esc(a.nombre)}">${esc(a.nombre)}${a.region ? " · " + esc(App.redEtiqueta(a.region)) : ""}</option>`).join("");
      selArea.onchange = () => miniArea(selArea.value);
    })();
    async function dibujar() {
      const v = VARS.find(x => x.id === E.mapVar);
      if (v && v.soloAnual) E.mapEsc = "anual";
      // las variables solo-anual deshabilitan los meses
      meses.querySelectorAll(".cl-mes").forEach(b => {
        const anual = b.dataset.e === "anual";
        b.style.opacity = (v && v.soloAnual && !anual) ? .35 : "";
        b.style.pointerEvents = (v && v.soloAnual && !anual) ? "none" : "";
        b.classList.toggle("on", b.dataset.e == String(E.mapEsc));
      });
      tit.textContent = "Cargando…";
      const key = `${E.mapVar}|${E.mapEsc}`;
      let d = E.mapaCache[key];
      if (!d) {
        try { d = await App.api(`/clima/mapa?variable=${E.mapVar}&escala=${E.mapEsc}`); E.mapaCache[key] = d; }
        catch (e) { limpiarPlot(plot); tit.textContent = "Error"; plot.innerHTML = vacio("⚠️", esc(e.message)); return; }
      }
      // Capa de estaciones (valor muestreado): solo se pide si el checkbox está activo
      // (v16: ya no alimenta ningún ranking lateral).
      let ce = null;
      if (E.mapEst) {
        ce = E.estCache[key];
        if (!ce) {
          try { ce = await App.api(`/clima/estaciones?mes=${E.mapEsc}&variable=${E.mapVar}`); E.estCache[key] = ce; }
          catch (e) { ce = null; }
        }
      }
      tit.textContent = d.titulo || "";
      pintarMapa(plot, d, ce);
      // Clic en una estación → su ficha completa AL LADO del mapa (v16).
      if (typeof plot.on === "function" && !plot._clickEst) {
        plot._clickEst = true;
        plot.on("plotly_click", ev => {
          const pt = ev.points && ev.points[0];
          if (!pt || !pt.data || pt.data.meta !== "estaciones" || !pt.customdata) return;
          miniFicha(String(pt.customdata[1]), pt.customdata[0]);
        });
      }
    }
    c.querySelector('[data-rol="vars"]').onclick = e => {
      const b = e.target.closest("[data-v]"); if (!b) return;
      E.mapVar = b.dataset.v;
      c.querySelectorAll('[data-rol="vars"] .cl-pill').forEach(x => x.classList.toggle("on", x.dataset.v === E.mapVar));
      dibujar();
    };
    meses.onclick = e => {
      const b = e.target.closest("[data-e]"); if (!b) return;
      E.mapEsc = b.dataset.e === "anual" ? "anual" : Number(b.dataset.e);
      dibujar();
    };
    chkEst.onchange = () => { E.mapEst = chkEst.checked; dibujar(); };
    _alTema = () => {
      if (!c.isConnected) return;
      dibujar();
      // el climograma lateral también se redibuja con los colores del tema nuevo
      if (miniUlt) {
        const host = miniEl.querySelector('[data-rol="mini-climo"]');
        if (host) pintarClimograma(host, miniUlt.p);
      }
    };
    dibujar();
  }

  // PESTAÑA 2 — POR ESTACIÓN --------------------------------------------------
  async function tabEstacion(c) {
    inyectarCSS(); _alTema = null;
    c.innerHTML = cargando("Cargando estaciones…");
    let ests = [];
    try { ests = (await App.api("/clima/estaciones")).estaciones || []; } catch (e) {}
    if (!ests.length) { c.innerHTML = vacio("📭", "No hay estaciones disponibles."); return; }
    // Opciones agrupadas por región; las insulares van etiquetadas (hay récords
    // observados pero no climatología grillada).
    const opciones = lista => {
      const grupos = new Map();
      for (const e of lista) {
        const rg = e.region || "Sin región";
        if (!grupos.has(rg)) grupos.set(rg, []);
        grupos.get(rg).push(e);
      }
      return [...grupos.keys()].sort((a, b) => a.localeCompare(b, "es")).map(rg =>
        `<optgroup label="${esc(App.redEtiqueta(rg))}">${grupos.get(rg).map(e =>
          `<option value="${esc(e.codigo)}">${opcionEstacion(e, e.fuera_dominio ? " · sin climatología grillada" : "")}</option>`).join("")}</optgroup>`).join("");
    };
    c.innerHTML = `<div class="cl-wrap">
      <div class="cl-toolbar">
        <div class="cl-grupo" style="flex:1;min-width:340px"><span>Estación</span>
          <input class="cl-buscar" data-rol="buscar" type="search" placeholder="Filtrar nombre, código, región o dependencia…" autocomplete="off">
          <select data-rol="est" style="flex:1;border:1px solid var(--line,#d7dde6);border-radius:9px;padding:8px 11px;font:500 13px var(--fuente,sans-serif);background:var(--surface,#fff);color:var(--ink,#1f2a3a)">${opciones(ests)}</select></div>
      </div>
      <div class="cl-grid2">
        <div class="cl-card"><h3 class="cl-maptit" data-rol="tit">Climograma</h3><div class="cl-plot" data-rol="climo"></div>
          <p class="cl-nota">Barras = precipitación y PET (eje izq., mm); líneas = temperaturas (eje der., °C); marcadores = normales observadas.</p></div>
        <div data-rol="ficha"></div>
      </div>
    </div>`;
    const sel = c.querySelector('[data-rol="est"]'), climo = c.querySelector('[data-rol="climo"]');
    const ficha = c.querySelector('[data-rol="ficha"]'), tit = c.querySelector('[data-rol="tit"]');
    const buscar = c.querySelector('[data-rol="buscar"]');
    // Estación pre-seleccionada desde el mapa (clic en un marcador).
    if (E.estSel) {
      if (ests.some(e => String(e.codigo) === String(E.estSel))) sel.value = String(E.estSel);
      E.estSel = null;
    }
    let ultimo = null;   // último payload con climograma pintado (redibujo al cambiar tema)
    async function cargar() {
      const cod = sel.value;
      if (!cod) return;
      const nom = (ests.find(e => String(e.codigo) === String(cod)) || {}).nombre || cod;
      tit.textContent = `Climograma — ${nom}`;
      limpiarPlot(climo); climo.innerHTML = cargando(); ficha.innerHTML = ""; ultimo = null;
      let p;
      try { p = await App.api(`/clima/estacion?codigo=${encodeURIComponent(cod)}`); }
      catch (e) { climo.innerHTML = vacio("⚠️", esc(e.message)); return; }
      ficha.innerHTML = tarjetaPunto(p, `${nom} (${cod})`);
      if (p.error || p.fuera_dominio || !(p.vars && p.vars.precip && p.vars.precip.anual != null)) {
        climo.innerHTML = vacio("🌐", "Sin climatología grillada aquí (fuera del dominio continental). La ficha muestra su serie observada.");
      } else { climo.innerHTML = ""; pintarClimograma(climo, p); ultimo = p; }
    }
    // Buscador en vivo: filtra las opciones sin perder la selección (patrón datos.js).
    buscar.oninput = () => {
      const q = buscar.value.trim().toLowerCase();
      const lista = !q ? ests : ests.filter(e => coincideEstacion(e, q));
      const previa = sel.value;
      sel.innerHTML = opciones(lista);
      if (lista.some(e => String(e.codigo) === String(previa))) sel.value = previa;
      else if (lista.length) cargar();
    };
    sel.onchange = cargar;
    _alTema = () => { if (c.isConnected && ultimo) pintarClimograma(climo, ultimo); };
    cargar();
  }

  // PESTAÑA 3 — POR COORDENADA ------------------------------------------------
  async function tabPunto(c) {
    inyectarCSS(); _alTema = null;
    c.innerHTML = `<div class="cl-wrap">
      <div class="cl-toolbar">
        <div class="cl-coords">
          <div class="cl-campo"><span>Latitud</span><input data-rol="lat" type="number" step="0.01" value="-0.18" placeholder="-0.18"></div>
          <div class="cl-campo"><span>Longitud</span><input data-rol="lon" type="number" step="0.01" value="-78.47" placeholder="-78.47"></div>
          <button class="cl-btn" data-rol="ir">Consultar</button>
        </div>
        <div class="cl-hint">Ecuador continental: latitud −5.0 a 1.4 · longitud −81.1 a −75.2. Ej.: Quito −0.18, −78.47.</div>
      </div>
      <div class="cl-grid2">
        <div class="cl-card"><h3 class="cl-maptit" data-rol="tit">Climograma del punto</h3><div class="cl-plot" data-rol="climo"></div></div>
        <div data-rol="ficha"></div>
      </div>
    </div>`;
    const lat = c.querySelector('[data-rol="lat"]'), lon = c.querySelector('[data-rol="lon"]');
    const climo = c.querySelector('[data-rol="climo"]'), ficha = c.querySelector('[data-rol="ficha"]');
    const tit = c.querySelector('[data-rol="tit"]');
    let ultimo = null;
    async function consultar() {
      const la = parseFloat(lat.value), lo = parseFloat(lon.value);
      if (isNaN(la) || isNaN(lo)) { App.aviso("Ingresa latitud y longitud válidas.", "error"); return; }
      tit.textContent = `Climograma — ${la.toFixed(2)}, ${lo.toFixed(2)}`;
      limpiarPlot(climo); climo.innerHTML = cargando(); ficha.innerHTML = ""; ultimo = null;
      let p;
      try { p = await App.api(`/clima/punto?lat=${la}&lon=${lo}`); }
      catch (e) { climo.innerHTML = vacio("⚠️", esc(e.message)); return; }
      ficha.innerHTML = tarjetaPunto(p, `Punto ${la.toFixed(3)}, ${lo.toFixed(3)}`);
      if (p.error || p.fuera_dominio || !(p.vars && p.vars.precip && p.vars.precip.anual != null)) {
        climo.innerHTML = vacio("🌐", "Fuera del dominio continental.");
      } else { climo.innerHTML = ""; pintarClimograma(climo, p); ultimo = p; }
    }
    c.querySelector('[data-rol="ir"]').onclick = consultar;
    _alTema = () => { if (c.isConnected && ultimo) pintarClimograma(climo, ultimo); };
    [lat, lon].forEach(i => i.onkeydown = e => { if (e.key === "Enter") consultar(); });
    consultar();
  }

  // PESTAÑA 4 — METODOLOGÍA ---------------------------------------------------
  async function tabGlosario(c) {
    inyectarCSS(); _alTema = null;
    c.innerHTML = cargando();
    let g;
    try { g = await App.api("/clima/glosario"); } catch (e) { c.innerHTML = vacio("⚠️", esc(e.message)); return; }
    c.innerHTML = `
      <div class="cl-glo-intro"><h3>${esc(g.titulo || "Metodología")}</h3><p>${esc(g.intro || "")}</p></div>
      <div class="cl-glo">
        ${(g.secciones || []).map(s => `<div class="cl-glo-card"><h4>${esc(s.titulo)}</h4><p>${esc(s.texto)}</p></div>`).join("")}
      </div>`;
  }

  // PESTAÑA 5 — RÉCORDS (series históricas con envolvente máx/mín) ------------
  const VARREC = { precip: { et: "Precipitación", u: "mm", c: "#2f7fc1" }, Tmax: { et: "T. máxima", u: "°C", c: "#e0562d" }, Tmin: { et: "T. mínima", u: "°C", c: "#2e8bc0" } };

  function oscuroTema() { return document.documentElement.getAttribute("data-tema") === "oscuro"; }

  function pintarRecords(host, d, mostrarPct) {
    const rgb = d.es_precip ? "47,127,193" : "224,86,45";
    const ink = oscuroTema() ? "#e8edf6" : "#0f1b2d";
    const faint = oscuroTema() ? "rgba(200,210,225,.55)" : "rgba(60,70,90,.5)";
    const x = d.fechas, e = d.env, u = d.unidad;
    const banda = (lo, hi, op) => ([
      { type: "scatter", mode: "lines", x, y: lo, line: { width: 0 }, hoverinfo: "skip", showlegend: false, connectgaps: false },
      { type: "scatter", mode: "lines", x, y: hi, line: { width: 0 }, fill: "tonexty", fillcolor: `rgba(${rgb},${op})`, hoverinfo: "skip", showlegend: false, connectgaps: false },
    ]);
    let traces = [...banda(e.min, e.max, 0.09)];
    if (mostrarPct) traces.push(...banda(e.p10, e.p90, 0.14), ...banda(e.p25, e.p75, 0.22));
    traces.push({ type: "scatter", mode: "lines", x, y: e.p50, line: { width: 1.3, dash: "dot", color: faint }, connectgaps: false, hovertemplate: `mediana %{y} ${u}<extra></extra>`, showlegend: false });
    traces.push({ type: "scatter", mode: "lines+markers", x, y: d.actual.valores, line: { width: 2, color: ink }, marker: { size: 2.8, color: ink }, connectgaps: false, hovertemplate: `%{x|%d %b}: <b>%{y} ${u}</b><extra>${d.anio}</extra>`, showlegend: false });
    const brdStar = oscuroTema() ? "#0B1322" : "#ffffff";     // borde de estrella = fondo del tema
    const rmx = d.records.max || [];
    if (rmx.length) traces.push({ type: "scatter", mode: "markers", x: rmx.map(r => r.fecha), y: rmx.map(r => r.valor), marker: { symbol: "star", size: 12, color: "#c43c28", line: { color: brdStar, width: 1 } }, customdata: rmx.map(r => [r.anterior, r.anio_anterior]), hovertemplate: `¡Récord MÁX! %{y} ${u}<br>supera ${"%{customdata[0]}"} de ${"%{customdata[1]}"}<extra></extra>`, showlegend: false });
    const rmn = d.records.min || [];
    if (rmn.length) traces.push({ type: "scatter", mode: "markers", x: rmn.map(r => r.fecha), y: rmn.map(r => r.valor), marker: { symbol: "star-triangle-down", size: 12, color: "#1b6fae", line: { color: brdStar, width: 1 } }, customdata: rmn.map(r => [r.anterior, r.anio_anterior]), hovertemplate: `¡Récord MÍN! %{y} ${u}<br>bajo ${"%{customdata[0]}"} de ${"%{customdata[1]}"}<extra></extra>`, showlegend: false });
    const layout = App.plotlyLayoutSerie("", {
      xaxis: { type: "date", tickformat: "%d %b", nticks: 12, hoverformat: "%d %b" },
      yaxis: { title: { text: u }, rangemode: d.es_precip ? "tozero" : "normal" },
      showlegend: false, height: 380, margin: { l: 56, r: 18, t: 12, b: 40 },
    });
    Plotly.react(host, traces, layout, configEs());
  }

  function kpisRecords(d) {
    const u = d.unidad, ext = d.resumen.extremo_max;
    const k = (e, v, c) => `<div class="cl-kpi" style="--kc:${c}"><div class="v">${v}</div><div class="e">${e}</div></div>`;
    return `<div class="cl-kpis" style="grid-template-columns:repeat(auto-fit,minmax(150px,1fr))">
      ${k("Récords máx " + d.anio, `<span style="color:#c43c28">${d.resumen.n_record_max}</span>`, "#c43c28")}
      ${k("Récords mín " + d.anio, d.es_precip ? "<small>n/a precip</small>" : `<span style="color:#1b6fae">${d.resumen.n_record_min}</span>`, "#1b6fae")}
      ${k("Máx del año", ext ? `${num(ext.valor, 1)} <small>${u}</small>` : "—", d.es_precip ? COL.precip : COL.tmax)}
      ${k("Años de referencia", `${d.periodo.desde}–${d.periodo.hasta}`, "var(--cyan)")}
    </div>`;
  }

  function leyendaRecords(d) {
    const rgb = d.es_precip ? "47,127,193" : "224,86,45";
    const ink = oscuroTema() ? "#e8edf6" : "#0f1b2d";
    const it = (sw, t) => `<span style="display:inline-flex;align-items:center;gap:6px;font-size:11.5px;color:var(--muted,#5b6678)">${sw}<span>${t}</span></span>`;
    // Sin histórico multianual: solo hay serie del año → no anunciar envolvente ni récords.
    if (d.sin_historico)
      return `<div style="display:flex;flex-wrap:wrap;gap:15px;align-items:center">${
        it(`<span style="width:16px;height:0;border-top:2.4px solid ${ink}"></span>`, `${d.anio} observado`)}</div>`;
    let items = [
      it(`<span style="width:15px;height:10px;border-radius:2px;background:rgba(${rgb},.18);border:1px solid rgba(${rgb},.4)"></span>`, "máx–mín histórico"),
      it(`<span style="width:16px;height:0;border-top:2.4px solid ${ink}"></span>`, `${d.anio} observado`),
      it(`<span style="color:#c43c28;font-size:13px">★</span>`, "récord máximo"),
    ];
    if (!d.es_precip) items.push(it(`<span style="color:#1b6fae;font-size:12px">▼</span>`, "récord mínimo"));
    return `<div style="display:flex;flex-wrap:wrap;gap:15px;align-items:center">${items.join("")}</div>`;
  }

  function tablaRecords(d) {
    const recs = [...(d.records.max || []).map(r => ({ ...r, t: "máx" })),
      ...(d.es_precip ? [] : (d.records.min || []).map(r => ({ ...r, t: "mín" })))]
      .sort((a, b) => (a.fecha < b.fecha ? -1 : 1));
    if (!recs.length) return `<div class="cl-card"><p class="cl-nota" style="margin:0">Sin récords en ${d.anio}: ningún día superó el extremo histórico (con ≥${d.umbral_n} años de referencia).</p></div>`;
    const u = d.unidad;
    const filas = recs.map(r => `<tr>
      <td>${esc(r.fecha)}</td>
      <td style="text-align:left"><b style="color:${r.t === "máx" ? "#c43c28" : "#1b6fae"}">${r.t}</b></td>
      <td>${num(r.valor, 1)} ${u}</td>
      <td>${num(r.anterior, 1)} ${u}</td>
      <td>${r.anio_anterior ?? "—"}</td></tr>`).join("");
    return `<div class="cl-card"><h3 class="cl-maptit">Récords de ${d.anio} (${recs.length})</h3>
      <div class="cl-tabla-scroll"><table class="cl-tabla"><thead><tr><th>Fecha</th><th style="text-align:left">Tipo</th><th>Valor</th><th>Récord previo</th><th>Año</th></tr></thead>
      <tbody>${filas}</tbody></table></div></div>`;
  }

  async function tabRecords(c) {
    inyectarCSS(); _alTema = null;
    c.innerHTML = cargando("Cargando estaciones…");
    let ests = [];
    try { ests = (await App.api("/clima/records_estaciones")).estaciones || []; } catch (e) {}
    if (!ests.length) { c.innerHTML = vacio("📭", "No hay base de observaciones unificada disponible."); return; }
    const anioActual = new Date().getFullYear();
    // El histórico diario completo vive en el equipo. El visor solo publica el tramo
    // reciente del año actual; las normales/envolventes agregadas siguen disponibles.
    const minAnio = window.HIDROMET_VISOR ? anioActual : 1990;
    const inp = "border:1px solid var(--line,#d7dde6);border-radius:9px;padding:8px 11px;background:var(--surface,#fff);color:var(--ink,#1f2a3a)";
    c.innerHTML = `<div class="cl-wrap">
      <div class="cl-toolbar">
        <div class="cl-grupo" style="flex:1;min-width:240px"><span>Estación</span>
          <select data-rol="est" style="${inp};font:500 13px var(--fuente,sans-serif)"></select></div>
        <div class="cl-grupo"><span>Variable</span><div class="cl-pills" data-rol="vars"></div></div>
        <div class="cl-grupo"><span>Año</span>
          <input data-rol="anio" type="number" value="${anioActual}" min="${minAnio}" max="${anioActual}" style="${inp};width:92px;font:600 13px var(--mono,monospace)"></div>
        <div class="cl-grupo"><span>Bandas</span>
          <label style="display:inline-flex;align-items:center;gap:7px;font-size:12.5px;color:var(--muted,#5b6678);cursor:pointer">
            <input type="checkbox" data-rol="pct" checked> percentiles P10–P90 · P25–P75</label></div>
      </div>
      <div data-rol="kpis"></div>
      <div class="cl-card"><h3 class="cl-maptit" data-rol="tit">Serie histórica</h3>
        <div data-rol="leyenda" style="margin:0 0 8px"></div>
        <div class="cl-plot" data-rol="plot"></div>
        <p class="cl-nota" data-rol="pie"></p></div>
      <div data-rol="tabla"></div>
    </div>`;
    const sel = c.querySelector('[data-rol="est"]'), varsBox = c.querySelector('[data-rol="vars"]');
    const anioIn = c.querySelector('[data-rol="anio"]'), pct = c.querySelector('[data-rol="pct"]');
    const kpis = c.querySelector('[data-rol="kpis"]'), tit = c.querySelector('[data-rol="tit"]');
    const plot = c.querySelector('[data-rol="plot"]'), pie = c.querySelector('[data-rol="pie"]');
    const tabla = c.querySelector('[data-rol="tabla"]'), ley = c.querySelector('[data-rol="leyenda"]');
    let estVar = "precip";
    const mide = (e, v) => (e.variables || []).includes(v);
    function pintarVars() {
      // Pills = variables con al menos UNA estación en la base (no dependen de la estación).
      const disp = ["precip", "Tmax", "Tmin"].filter(v => ests.some(e => mide(e, v)));
      if (disp.length && !disp.includes(estVar)) estVar = disp[0];
      varsBox.innerHTML = disp
        .map(v => `<button class="cl-pill ${v === estVar ? "on" : ""}" data-v="${v}" style="--pc:${VARREC[v].c}">${VARREC[v].et}</button>`).join("");
    }
    function pintarEstaciones() {
      // El selector SOLO ofrece estaciones que midan la variable activa; conserva la
      // selección si sigue siendo válida y, si no, cae a la primera válida.
      const previa = sel.value;
      const validas = ests.filter(e => mide(e, estVar));
      sel.innerHTML = validas.map(e =>
        `<option value="${esc(e.codigo)}">${opcionEstacion(e)}</option>`).join("");
      if (validas.some(e => String(e.codigo) === String(previa))) sel.value = previa;
    }
    let ultimo = null;   // último payload pintado (redibujo al cambiar tema)
    async function cargar() {
      const cod = sel.value, anio = parseInt(anioIn.value) || anioActual;
      limpiarPlot(plot); tit.textContent = "Cargando…"; plot.innerHTML = cargando();
      kpis.innerHTML = ""; tabla.innerHTML = ""; ley.innerHTML = ""; pie.textContent = ""; ultimo = null;
      let d;
      try { d = await App.api(`/clima/records?codigo=${encodeURIComponent(cod)}&variable=${estVar}&anio=${anio}`); }
      catch (e) { tit.textContent = "Error"; plot.innerHTML = vacio("⚠️", esc(e.message)); return; }
      if (d.error) { tit.textContent = "Sin datos"; plot.innerHTML = vacio("📊", esc(d.error)); return; }
      // textContent: sin esc() (escaparía doble y mostraría entidades literales).
      tit.textContent = d.sin_historico
        ? `${VARREC[estVar].et} — ${d.nombre} (${d.codigo}) · serie ${d.anio}`
        : `${VARREC[estVar].et} — ${d.nombre} (${d.codigo}) · ${d.anio} vs ${d.periodo.desde}–${d.periodo.hasta}`;
      ley.innerHTML = leyendaRecords(d);
      plot.innerHTML = ""; pintarRecords(plot, d, pct.checked);
      kpis.innerHTML = kpisRecords(d);
      tabla.innerHTML = tablaRecords(d);
      // Estación nueva sin años previos: no hay envolvente ni récords todavía; se explica
      // en vez de dejar la pestaña con un error (antes toda estación de 2026 fallaba).
      pie.textContent = d.sin_historico
        ? `Estación nueva: solo hay datos desde ${d.periodo.desde}. Se muestra la serie observada del año; aún no hay envolvente histórica ni detección de récords (se necesitan varios años).`
        : `Envolvente sobre ${d.n_anios_rango} años con datos; se exige ≥${d.umbral_n} años por día para declarar récord. Precipitación mayormente de la Climatología (ventana ${d.agregacion}); temperatura observada.`;
      ultimo = d;
    }
    sel.onchange = cargar;
    _alTema = () => {
      if (!c.isConnected || !ultimo) return;
      ley.innerHTML = leyendaRecords(ultimo);
      pintarRecords(plot, ultimo, pct.checked);
    };
    varsBox.onclick = e => {
      const b = e.target.closest("[data-v]"); if (!b) return;
      estVar = b.dataset.v; pintarVars(); pintarEstaciones(); cargar();
    };
    anioIn.onchange = cargar;
    pct.onchange = cargar;
    pintarVars(); pintarEstaciones(); cargar();
  }

  // PESTAÑA — EL NIÑO: RONI CPC + impacto mensual observado -----------------
  function ensoFmt(value, dec = 1, suffix = "") {
    return value == null || !Number.isFinite(Number(value))
      ? "—" : `${num(Number(value), dec)}${suffix}`;
  }

  function ensoKpis(evento) {
    const r = evento.resumen || {};
    const k = (label, value, color) => `<div class="cl-kpi" style="--kc:${color}">
      <div class="v">${value}</div><div class="e">${label}</div></div>`;
    return `<div class="cl-kpis cl-enso-kpis">
      ${k("Cobertura de lluvia", `${ensoFmt(r.precip_cobertura_pct, 0, "%")}`, "#2f7fc1")}
      ${k("Acumulado del episodio", `${ensoFmt(r.precip_total_mm, 1)} <small>mm</small>`, "#0b6e4f")}
      ${k("Anomalía vs 1991–2020", `${ensoFmt(r.precip_anomalia_total_mm, 1)} <small>mm</small>`, "#d97706")}
      ${k("Pico RONI", `${ensoFmt(evento.pico_c, 2)} <small>°C</small>`, "#b91c1c")}
      ${k("Δ Tmax media", `${ensoFmt(r.tmax_anomalia_media_c, 1)} <small>°C</small>`, "#e0562d")}
      ${k("Δ Tmin media", `${ensoFmt(r.tmin_anomalia_media_c, 1)} <small>°C</small>`, "#2e8bc0")}
    </div>`;
  }

  function pintarEnsoLluvia(host, evento) {
    if (!window.Plotly || !host) return;
    const rows = evento.meses || [], x = rows.map(row => row.fecha);
    const observed = rows.map(row => row.precip && row.precip.valor);
    const normal = rows.map(row => row.precip && row.precip.normal);
    const cumulative = rows.map(row => row.precip && row.precip.acumulado);
    const cumulativeNormal = rows.map(row => row.precip && row.precip.acumulado_normal);
    const traces = [
      { type: "bar", x, y: normal, name: "Normal 1991–2020", marker: { color: "rgba(126,138,156,.42)", line: { color: "rgba(126,138,156,.8)", width: .5 } },
        hovertemplate: "%{x}<br>Normal: <b>%{y:.1f} mm</b><extra></extra>" },
      { type: "bar", x, y: observed, name: "Lluvia observada", marker: { color: "#2f7fc1", line: { color: "#175b91", width: .7 } },
        hovertemplate: "%{x}<br>Observado: <b>%{y:.1f} mm</b><extra></extra>" },
      { type: "scatter", mode: "lines+markers", x, y: cumulativeNormal, yaxis: "y2", name: "Acumulado normal",
        line: { color: "#7e8a9c", width: 1.5, dash: "dot" }, marker: { size: 4 },
        hovertemplate: "%{x}<br>Acumulado normal: %{y:.1f} mm<extra></extra>" },
      { type: "scatter", mode: "lines+markers", x, y: cumulative, yaxis: "y2", name: "Acumulado observado",
        line: { color: "#0b6e4f", width: 2.4 }, marker: { size: 5 },
        hovertemplate: "%{x}<br>Acumulado observado: <b>%{y:.1f} mm</b><extra></extra>" },
    ];
    const layout = App.plotlyLayoutBase({
      height: 430, barmode: "group", bargap: .18, bargroupgap: .05,
      margin: { l: 54, r: 62, t: 18, b: 54 }, hovermode: "x unified",
      legend: { orientation: "h", y: 1.11, x: .5, xanchor: "center" },
      xaxis: { type: "date", tickformat: "%b<br>%Y", gridcolor: "rgba(120,130,150,.10)" },
      yaxis: { title: "Lluvia mensual (mm)", rangemode: "tozero", gridcolor: "rgba(120,130,150,.14)", zeroline: false },
      yaxis2: { title: "Acumulado (mm)", overlaying: "y", side: "right", rangemode: "tozero", showgrid: false },
    });
    quitarPlaceholder(host);
    Plotly.react(host, traces, layout, configEs());
  }

  function pintarEnsoTemperatura(host, evento) {
    if (!window.Plotly || !host) return;
    const rows = evento.meses || [], x = rows.map(row => row.fecha);
    const tmax = rows.map(row => row.tmax && row.tmax.anomalia);
    const tmin = rows.map(row => row.tmin && row.tmin.anomalia);
    if (![...tmax, ...tmin].some(value => value != null)) {
      limpiarPlot(host);
      host.innerHTML = vacio("🌡️", "Sin temperatura mensual con normal formal 1991–2020 para este episodio.");
      return;
    }
    const traces = [
      { type: "scatter", mode: "lines+markers", x, y: tmax, name: "Anomalía Tmax",
        line: { color: "#e0562d", width: 2.2 }, marker: { size: 5 },
        hovertemplate: "%{x}<br>Δ Tmax: <b>%{y:+.1f} °C</b><extra></extra>" },
      { type: "scatter", mode: "lines+markers", x, y: tmin, name: "Anomalía Tmin",
        line: { color: "#2e8bc0", width: 2.2 }, marker: { size: 5 },
        hovertemplate: "%{x}<br>Δ Tmin: <b>%{y:+.1f} °C</b><extra></extra>" },
    ];
    const layout = App.plotlyLayoutBase({
      height: 300, margin: { l: 54, r: 18, t: 10, b: 48 }, hovermode: "x unified",
      legend: { orientation: "h", y: 1.14, x: .5, xanchor: "center" },
      xaxis: { type: "date", tickformat: "%b<br>%Y", gridcolor: "rgba(120,130,150,.10)" },
      yaxis: { title: "Anomalía (°C)", gridcolor: "rgba(120,130,150,.14)", zeroline: true,
        zerolinecolor: "rgba(90,100,120,.65)", zerolinewidth: 1 },
    });
    quitarPlaceholder(host);
    Plotly.react(host, traces, layout, configEs());
  }

  function tablaEnsoMeses(evento) {
    const rows = (evento.meses || []).map(row => {
      const p = row.precip || {}, tx = row.tmax || {}, tn = row.tmin || {};
      return `<tr>
        <td>${esc(row.fecha)} · ${esc(row.temporada_roni || "")}</td>
        <td>${ensoFmt(row.roni_c, 2)}</td>
        <td>${ensoFmt(p.valor, 1)}</td><td>${ensoFmt(p.normal, 1)}</td>
        <td>${ensoFmt(p.anomalia, 1)}</td><td>${ensoFmt(p.anomalia_pct, 0, "%")}</td>
        <td>${ensoFmt(p.acumulado, 1)}</td>
        <td>${ensoFmt(tx.anomalia, 1)}</td><td>${ensoFmt(tn.anomalia, 1)}</td>
        <td>${p.valor == null ? esc(p.motivo_faltante || "sin dato") : `${p.dias_observados}/${p.dias_esperados}`}</td>
      </tr>`;
    }).join("");
    return `<div class="cl-tabla-scroll"><table class="cl-tabla cl-enso-tabla">
      <thead><tr><th>Mes · temporada</th><th>RONI °C</th><th>Lluvia mm</th><th>Normal mm</th>
      <th>Anom. mm</th><th>Anom. %</th><th>Acum. mm</th><th>Δ Tmax °C</th><th>Δ Tmin °C</th><th>Cobertura</th></tr></thead>
      <tbody>${rows}</tbody></table></div>`;
  }

  function tablaEnsoEventos(payload) {
    const rows = (payload.eventos || []).map(evento => {
      const r = evento.resumen || {};
      return `<tr data-evento="${esc(evento.id)}" tabindex="0">
        <td>${esc(evento.desde)} → ${esc(evento.hasta)}</td><td>${ensoFmt(evento.pico_c, 2)}</td>
        <td>${ensoFmt(r.precip_cobertura_pct, 0, "%")}</td><td>${ensoFmt(r.precip_total_mm, 1)}</td>
        <td>${ensoFmt(r.precip_anomalia_total_mm, 1)}</td><td>${ensoFmt(r.precip_anomalia_total_pct, 0, "%")}</td>
        <td>${ensoFmt(r.tmax_anomalia_media_c, 1)}</td><td>${ensoFmt(r.tmin_anomalia_media_c, 1)}</td>
      </tr>`;
    }).join("");
    return `<div class="cl-tabla-scroll"><table class="cl-tabla cl-enso-tabla cl-enso-eventos">
      <thead><tr><th>Episodio</th><th>Pico RONI °C</th><th>Cobertura</th><th>Lluvia mm</th>
      <th>Anom. mm</th><th>Anom. %</th><th>Δ Tmax °C</th><th>Δ Tmin °C</th></tr></thead>
      <tbody>${rows}</tbody></table></div>`;
  }

  async function tabEnso(c) {
    inyectarCSS(); _alTema = null;
    c.innerHTML = cargando("Leyendo RONI oficial y cobertura observacional…");
    let catalog;
    try { catalog = await App.api("/clima/enso_catalogo"); }
    catch (e) { c.innerHTML = vacio("⚠️", esc(e.message)); return; }
    const stations = (catalog.estaciones || []).filter(s => Number(s.episodios_posibles || 0) > 0);
    if (!stations.length) {
      c.innerHTML = vacio("📭", "No hay estaciones con historia que se solape con episodios El Niño clasificados.");
      return;
    }
    const controlStyle = "border:1px solid var(--line);border-radius:9px;padding:8px 11px;background:var(--surface);color:var(--ink)";
    c.innerHTML = `<div class="cl-wrap cl-enso">
      <div class="cl-glo-intro cl-enso-intro">
        <h3>El Niño histórico · impacto local observado</h3>
        <p>Los episodios se clasifican con <b>RONI de NOAA CPC</b> (≥ +0.5 °C durante al menos cinco temporadas solapadas).
        Cada estación se compara mes a mes contra su normal observada 1991–2020. RONI describe el Pacífico; el gráfico mide
        el impacto local y no presupone que todas las regiones respondan igual.</p>
      </div>
      <div class="cl-toolbar cl-enso-toolbar">
        <div class="cl-grupo"><span>Buscar</span><input class="cl-buscar" data-rol="buscar" placeholder="Estación, código, región o dependencia"></div>
        <div class="cl-grupo cl-enso-est"><span>Estación</span><select data-rol="est" style="${controlStyle}"></select></div>
        <div class="cl-grupo cl-enso-evt"><span>Episodio</span><select data-rol="evento" style="${controlStyle}"></select></div>
      </div>
      <div data-rol="estado" class="cl-enso-estado"></div>
      <div data-rol="kpis"></div>
      <div class="cl-card"><h3 class="cl-maptit" data-rol="titulo">Lluvia mensual y acumulada</h3>
        <div class="cl-plot" data-rol="lluvia"></div>
        <p class="cl-nota">Un acumulado solo continúa mientras todos los meses previos del episodio sean válidos. Un mes ausente nunca se convierte en cero.</p>
      </div>
      <div class="cl-card"><h3 class="cl-maptit">Respuesta térmica local</h3><div class="cl-plot" data-rol="temp"></div></div>
      <div class="cl-card"><h3 class="cl-maptit">Detalle mes a mes</h3><div data-rol="meses"></div></div>
      <div class="cl-card"><h3 class="cl-maptit">Comparación de episodios en esta estación</h3>
        <p class="cl-nota" style="margin-top:0">Totales y anomalías solo aparecen cuando el episodio está completo y existe una normal formal para cada mes.</p>
        <div data-rol="eventos"></div></div>
      <div class="cl-aviso"><span class="ic">🔬</span><p data-rol="metodo"></p></div>
    </div>`;
    const search = c.querySelector('[data-rol="buscar"]');
    const station = c.querySelector('[data-rol="est"]');
    const eventSelect = c.querySelector('[data-rol="evento"]');
    const status = c.querySelector('[data-rol="estado"]');
    const kpis = c.querySelector('[data-rol="kpis"]');
    const title = c.querySelector('[data-rol="titulo"]');
    const rain = c.querySelector('[data-rol="lluvia"]');
    const temperature = c.querySelector('[data-rol="temp"]');
    const months = c.querySelector('[data-rol="meses"]');
    const events = c.querySelector('[data-rol="eventos"]');
    const method = c.querySelector('[data-rol="metodo"]');
    let payload = null, currentEvent = null;

    function fillStations() {
      const previous = station.value;
      const query = search.value.trim().toLowerCase();
      const filtered = stations.filter(s => !query || coincideEstacion(s, query));
      station.innerHTML = filtered.map(s =>
        `<option value="${esc(s.codigo)}">${opcionEstacion(s, ` · ${s.episodios_posibles} episodios posibles`)}</option>`
      ).join("");
      if ([...station.options].some(o => o.value === previous)) station.value = previous;
    }

    function renderEvent(id) {
      if (!payload) return;
      currentEvent = (payload.eventos || []).find(event => event.id === id) || payload.eventos[0];
      if (!currentEvent) {
        status.innerHTML = vacio("📭", "La estación no tiene meses coincidentes con el catálogo RONI.");
        return;
      }
      eventSelect.value = currentEvent.id;
      const meta = payload.estacion || {};
      const r = currentEvent.resumen || {};
      title.textContent = `${meta.nombre || meta.codigo} · ${currentEvent.desde} a ${currentEvent.hasta}`;
      status.innerHTML = `<div class="cl-enso-badges">
        <span>RONI ${ensoFmt(currentEvent.pico_c, 2)} °C</span>
        <span>${r.precip_meses_validos}/${r.precip_meses_esperados} meses de lluvia válidos</span>
        <span>${payload.agregacion_precip ? esc(payload.agregacion_precip.replace("sum_", "").replaceAll("_", "–")) : "sin lluvia"}</span>
      </div>`;
      kpis.innerHTML = ensoKpis(currentEvent);
      pintarEnsoLluvia(rain, currentEvent);
      pintarEnsoTemperatura(temperature, currentEvent);
      months.innerHTML = tablaEnsoMeses(currentEvent);
      events.querySelectorAll("[data-evento]").forEach(row => row.classList.toggle("on", row.dataset.evento === currentEvent.id));
    }

    async function loadStation() {
      if (!station.value) return;
      limpiarPlot(rain); limpiarPlot(temperature);
      status.innerHTML = cargando("Agregando meses desde la observación canónica…");
      kpis.innerHTML = ""; months.innerHTML = ""; events.innerHTML = "";
      try { payload = await App.api(`/clima/enso?codigo=${encodeURIComponent(station.value)}`); }
      catch (e) { status.innerHTML = vacio("⚠️", esc(e.message)); payload = null; return; }
      const available = (payload.eventos || []).filter(event =>
        ((event.resumen || {}).precip_meses_validos || 0)
        + ((event.resumen || {}).tmax_meses_validos || 0)
        + ((event.resumen || {}).tmin_meses_validos || 0) > 0);
      const selectable = available.length ? available : (payload.eventos || []);
      eventSelect.innerHTML = selectable.slice().reverse().map(event => {
        const r = event.resumen || {};
        return `<option value="${esc(event.id)}">${esc(event.desde)} → ${esc(event.hasta)} · lluvia ${r.precip_meses_validos}/${r.precip_meses_esperados}</option>`;
      }).join("");
      events.innerHTML = tablaEnsoEventos(payload);
      const best = available.slice().sort((a, b) =>
        ((b.resumen || {}).precip_cobertura_pct || 0) - ((a.resumen || {}).precip_cobertura_pct || 0)
        || Math.abs(Number(b.pico_c || 0)) - Math.abs(Number(a.pico_c || 0)))[0] || selectable[0];
      method.innerHTML = `<b>Cobertura honesta.</b> ${esc(payload.nota || "")}
        Fuente ENSO: <a href="${esc((payload.fuente_roni || {}).url || "#")}" target="_blank" rel="noopener">NOAA CPC RONI</a>,
        caché SHA-256 <code>${esc(String((payload.fuente_roni || {}).sha256 || "").slice(0, 12))}…</code>.
        La temperatura se muestra únicamente donde también existe normal formal observada.`;
      renderEvent(best && best.id);
    }

    station.onchange = loadStation;
    eventSelect.onchange = () => renderEvent(eventSelect.value);
    search.oninput = () => { fillStations(); };
    events.onclick = event => {
      const row = event.target.closest("[data-evento]");
      if (row) renderEvent(row.dataset.evento);
    };
    events.onkeydown = event => {
      const row = event.target.closest("[data-evento]");
      if (row && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); renderEvent(row.dataset.evento); }
    };
    _alTema = () => {
      if (currentEvent) {
        pintarEnsoLluvia(rain, currentEvent);
        pintarEnsoTemperatura(temperature, currentEvent);
      }
    };
    fillStations();
    loadStation();
  }

  // PESTAÑA — SERIES, RELLENO Y MAPA POR RANGO ------------------------------
  function pintarSerieRelleno(host, d) {
    if (!window.Plotly || !host) return;
    if (!d || d.error) { limpiarPlot(host); host.innerHTML = vacio("⚠️", esc(d && d.error || "Sin datos")); return; }
    const u = esc(d.unidad || ""), fechas = d.fechas || [];
    const traces = [
      { type: "scatter", mode: "lines", x: fechas, y: d.estimado_grillado, name: "Grilla corregida",
        line: { color: "#2f7fc1", width: 1.5 }, opacity: .75,
        hovertemplate: `%{x}<br>%{y:.1f} ${u}<extra>Estimación grillada</extra>` },
      { type: "scatter", mode: "lines", x: fechas, y: d.completado, name: "Serie completada",
        line: { color: "#26a69a", width: 2.2 },
        customdata: d.procedencia || [],
        hovertemplate: `%{x}<br><b>%{y:.1f} ${u}</b><br>%{customdata}<extra>Completada</extra>` },
      // "Dato medido" en llano (antes "Observación QC"); color por TEMA: el azul
      // marino fijo desaparecía sobre la tarjeta oscura.
      { type: "scatter", mode: "markers", x: fechas, y: d.observado, name: "Dato medido",
        marker: { color: oscuroTema() ? "#9CC3EA" : "#10243f", size: 5,
          line: { color: oscuroTema() ? "#0B1322" : "#fff", width: .7 } },
        hovertemplate: `%{x}<br><b>%{y:.1f} ${u}</b><extra>Medido</extra>` },
    ];
    const layout = App.plotlyLayoutBase({ height: 410, margin: { l: 52, r: 18, t: 10, b: 45 },
      hovermode: "x unified", legend: { orientation: "h", y: 1.12, x: .5, xanchor: "center" },
      xaxis: { type: "date", rangeslider: { visible: true, thickness: .08 }, gridcolor: "rgba(120,130,150,.12)" },
      yaxis: { title: d.unidad || "", rangemode: d.variable === "precip" ? "tozero" : "normal",
        gridcolor: "rgba(120,130,150,.14)", zeroline: false },
    });
    quitarPlaceholder(host);
    Plotly.react(host, traces, layout, configEs());
    // Descripción para lector de pantalla: qué estación, qué variable y qué periodo.
    host.setAttribute("role", "img");
    host.setAttribute("aria-label", `Serie diaria de ${d.nombre || d.codigo || "la estación"}`
      + `${d.variable ? " · " + d.variable : ""}${d.unidad ? " (" + d.unidad + ")" : ""}`
      + `${d.desde && d.hasta ? ` del ${d.desde} al ${d.hasta}` : ""}: datos medidos, estimación grillada y serie completada.`);
  }

  function metricasRelleno(d) {
    const c = d.cobertura || {}, fm = (d.metricas || {}).fuera_muestra || {},
      dg = (d.metricas || {}).diagnostica || {};
    const met = (et, v, sub) => `<div class="cl-kpi"><div class="v">${v == null ? "—" : esc(v)}</div>` +
      `<div class="e">${esc(et)}</div>${sub ? `<small class="cl-sutil">${esc(sub)}</small>` : ""}</div>`;
    // Rótulos en LLANO (pedido del dueño: nada de siglas): la jerga técnica
    // (MAE/RMSE/r) queda en el desplegable diagnóstico de abajo.
    const u = d.unidad || "";
    return `<div class="cl-kpis cl-kpis-diario">
      ${met("Días medidos", c.observados, `de ${c.dias || 0} días del rango`)}
      ${met("Días rellenados", c.rellenados, "estimación trazable")}
      ${met("Días vacíos", c.vacios, "sin estimación compatible")}
      ${met(`Error medio${u ? ` (${u})` : ""}`, fm.mae, fm.n ? `sobre ${fm.n} comparaciones` : "no disponible en el rango")}
      ${met(`Error típico${u ? ` (${u})` : ""}`, fm.rmse, fm.n ? "pesa más los fallos grandes" : "comparado con estaciones no usadas")}
      ${met("Parecido con lo medido", fm.correlacion, fm.n ? "1 = coincidencia perfecta" : "comparado con estaciones no usadas")}
    </div>
    <details class="cl-metricas-det"><summary>Detalle técnico de la comparación de la grilla</summary>
      <p>n=${num(dg.n)} · MAE=${num(dg.mae, 2)} · RMSE=${num(dg.rmse, 2)} · sesgo=${num(dg.bias, 2)} · r=${num(dg.correlacion, 2)}.</p>
      <p>${esc(dg.nota || "")}</p></details>`;
  }

  const _dailyChunks = new Map();
  async function leerBinGzip(url) {
    if (_dailyChunks.has(url)) return _dailyChunks.get(url);
    const promise = (async () => {
      const response = await fetch(url, { cache: "no-cache" });
      if (!response.ok) throw new Error(`Chunk climático no publicado (HTTP ${response.status})`);
      let bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
        if (typeof DecompressionStream !== "function") throw new Error("El navegador no admite gzip.");
        const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
        bytes = new Uint8Array(await new Response(stream).arrayBuffer());
      }
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    })();
    _dailyChunks.set(url, promise); return promise;
  }
  const fechaUTC = s => new Date(`${s}T00:00:00Z`);
  const diaMs = 86400000;
  function metricasCliente(obs, pred) {
    const pares = obs.map((v, i) => [v, pred[i]]).filter(p => p[0] != null && p[1] != null && isFinite(p[0]) && isFinite(p[1]));
    if (!pares.length) return { n: 0, mae: null, rmse: null, bias: null, correlacion: null, kge: null };
    const O = pares.map(p => p[0]), P = pares.map(p => p[1]), n = O.length;
    const mo = O.reduce((a, b) => a + b, 0) / n, mp = P.reduce((a, b) => a + b, 0) / n;
    const err = P.map((v, i) => v - O[i]);
    const so = Math.sqrt(O.reduce((a, v) => a + (v - mo) ** 2, 0) / n), sp = Math.sqrt(P.reduce((a, v) => a + (v - mp) ** 2, 0) / n);
    const corr = n >= 3 && so > 0 && sp > 0 ? O.reduce((a, v, i) => a + (v - mo) * (P[i] - mp), 0) / n / so / sp : null;
    const kge = corr != null && Math.abs(mo) > 1e-12 ? 1 - Math.sqrt((corr - 1) ** 2 + (sp / so - 1) ** 2 + (mp / mo - 1) ** 2) : null;
    const r = v => v == null || !isFinite(v) ? null : Math.round(v * 1000) / 1000;
    return { n, mae: r(err.reduce((a, v) => a + Math.abs(v), 0) / n),
      rmse: r(Math.sqrt(err.reduce((a, v) => a + v * v, 0) / n)),
      bias: r(err.reduce((a, v) => a + v, 0) / n), correlacion: r(corr), kge: r(kge) };
  }
  async function serieDesdeChunks(manifest, code, variable, desde, hasta) {
    const stationIndex = manifest.stations.findIndex(s => String(s.codigo) === String(code));
    if (stationIndex < 0) throw new Error("Estación no incluida en el producto diario publicado.");
    const station = manifest.stations[stationIndex], nStations = manifest.stations.length, scale = Number(manifest.scale || 10);
    const start = fechaUTC(desde), end = fechaUTC(hasta), fechas = [], observed = [], grid = [], cv = [];
    const mobile = manifest.schema === "hidromet.clima-diario.v2";
    const chunks = [];
    if (mobile) {
      const windowStart = fechaUTC(manifest.window.desde), windowEnd = fechaUTC(manifest.window.hasta);
      if (start < windowStart || end > windowEnd || start > end) throw new Error("Rango fuera de la ventana móvil publicada.");
      chunks.push({ desde: windowStart, hasta: windowEnd, file: manifest.series.files[variable] });
    } else {
      for (let y = start.getUTCFullYear(); y <= end.getUTCFullYear(); y++) chunks.push({
        desde: new Date(Date.UTC(y, 0, 1)), hasta: new Date(Date.UTC(y, 11, 31)),
        file: `series_${variable}_${y}.bin.gz`, year: y,
      });
    }
    const buffers = await Promise.all(chunks.map(c => leerBinGzip(`productos/clima/diario/${c.file}`)));
    chunks.forEach((chunk, yi) => {
      const days = Math.round((chunk.hasta - chunk.desde) / diaMs) + 1, plane = days * nStations;
      const values = new Int16Array(buffers[yi]);
      if (values.length !== plane * 3) throw new Error(`Chunk de serie ${chunk.year || "móvil"} inconsistente.`);
      const a = Math.max(start.getTime(), chunk.desde.getTime()), b = Math.min(end.getTime(), chunk.hasta.getTime());
      for (let time = a; time <= b; time += diaMs) {
        const day = Math.round((time - chunk.desde.getTime()) / diaMs), pos = day * nStations + stationIndex;
        const decode = raw => raw === manifest.missing_i16 ? null : raw / scale;
        fechas.push(new Date(time).toISOString().slice(0, 10)); observed.push(decode(values[pos]));
        grid.push(decode(values[plane + pos])); cv.push(decode(values[2 * plane + pos]));
      }
    });
    const completed = [], provenance = [];
    observed.forEach((v, i) => {
      if (v != null) { completed.push(v); provenance.push("observado"); }
      else if (grid[i] != null) { completed.push(grid[i]); provenance.push("estimado_grillado"); }
      else { completed.push(null); provenance.push("vacio"); }
    });
    const formal = metricasCliente(observed, cv), diagnostic = metricasCliente(observed, grid);
    formal.tipo = "validacion_espacial_fuera_muestra"; formal.disponible = !!formal.n;
    formal.nota = "La estación se excluye del ajuste al estimar su valor.";
    diagnostic.tipo = "comparacion_diagnostica";
    diagnostic.nota = "No mide habilidad independiente: la estación pudo participar en la corrección diaria.";
    const count = kind => provenance.filter(x => x === kind).length;
    return { codigo: code, nombre: station.nombre || code, variable, unidad: variable === "precip" ? "mm" : "°C",
      desde, hasta, agregacion_observada: variable === "precip" ? station.precipitation_aggregation : (variable === "tmax" ? "max" : "min"),
      grilla_compatible: variable !== "precip" || station.precip_grid_compatible,
      contrato_grilla: variable !== "precip" || station.precip_grid_compatible ? "misma ventana diaria" : "ventana incompatible; no se rellena",
      fechas, observado: observed, estimado_grillado: grid, completado: completed, procedencia: provenance,
      qc_observacion: observed.map(v => v == null ? "SIN_VALOR_QC" : "PASS"),
      cobertura: { dias: fechas.length, observados: count("observado"), rellenados: count("estimado_grillado"), vacios: count("vacio") },
      metricas: { fuera_muestra: formal, diagnostica: diagnostic },
      metodologia: manifest.method || "Dato medido con control de calidad > estimación grillada compatible > vacío; nunca se sobrescribe un dato medido." };
  }
  /* Rango de fechas que el MAPA de lluvia puede pintar.
     El mapa solo existe donde hay malla finita, y eso lo dice manifest.grid;
     manifest.window llega más lejos porque incluye días con serie por estación
     pero sin malla (el binario los trae rellenos de «missing»).
     2026-09-03: tomar `window` abría «Mapa de lluvia por rango» EN BLANCO
     —mapaDesdeChunks exige cobertura completa del rango y el último día tenía
     0 de 15340 píxeles válidos—, y el usuario tenía que retroceder «Hasta» a
     mano para ver algo. */
  function rangoMapaDiario(manifest) {
    const win = (manifest && manifest.window) || {};
    const malla = (manifest && manifest.grid) || {};
    return { desde: malla.desde || win.desde, hasta: malla.hasta || win.hasta };
  }

  async function mapaDesdeChunks(manifest, desde, hasta, operation) {
    const start = fechaUTC(desde), end = fechaUTC(hasta), chunks = [];
    const anomaly = operation === "anomalia_mm" || operation === "anomalia_pct";
    if (manifest.schema === "hidromet.clima-diario.v2") {
      const windowStart = fechaUTC(manifest.window.desde), windowEnd = fechaUTC(manifest.window.hasta);
      if (start < windowStart || end > windowEnd || start > end) throw new Error("Rango fuera de la ventana móvil publicada.");
      chunks.push({ desde: windowStart, hasta: windowEnd, file: manifest.grid.file });
    } else {
      for (let y = start.getUTCFullYear(); y <= end.getUTCFullYear(); y++) chunks.push({
        desde: new Date(Date.UTC(y, 0, 1)), hasta: new Date(Date.UTC(y, 11, 31)),
        file: `grid_precip_${y}.bin.gz`, year: y,
      });
    }
    const buffers = await Promise.all(chunks.map(c => leerBinGzip(`productos/clima/diario/${c.file}`)));
    const cells = manifest.grid.ny * manifest.grid.nx, totalDays = Math.round((end - start) / diaMs) + 1;
    const sum = new Float64Array(cells), count = new Uint32Array(cells), selected = [];
    let climateValues = null, climateSum = null, climateCount = null, climateStart = null;
    if (anomaly) {
      if (!(manifest.climatology && manifest.climatology.file))
        throw new Error("La normal diaria 1991–2020 aún no está publicada.");
      climateValues = new Uint16Array(await leerBinGzip(`productos/clima/diario/${manifest.climatology.file}`));
      climateStart = fechaUTC(manifest.window.desde);
      const climateDays = Number(manifest.window.dias || (Math.round((fechaUTC(manifest.window.hasta) - climateStart) / diaMs) + 1));
      if (climateValues.length !== climateDays * cells) throw new Error("Chunk climatológico inconsistente.");
      climateSum = new Float64Array(cells); climateCount = new Uint32Array(cells);
    }
    chunks.forEach((chunk, yi) => {
      const days = Math.round((chunk.hasta - chunk.desde) / diaMs) + 1, values = new Uint16Array(buffers[yi]);
      if (values.length !== days * cells) throw new Error(`Chunk cartográfico ${chunk.year || "móvil"} inconsistente.`);
      const a = Math.max(start.getTime(), chunk.desde.getTime()), b = Math.min(end.getTime(), chunk.hasta.getTime());
      for (let time = a; time <= b; time += diaMs) {
        const day = Math.round((time - chunk.desde.getTime()) / diaMs), base = day * cells;
        const climateBase = anomaly ? Math.round((time - climateStart.getTime()) / diaMs) * cells : 0;
        selected.push([values, base]);
        for (let i = 0; i < cells; i++) {
          if (values[base + i] !== manifest.missing_u16) { sum[i] += values[base + i] / manifest.scale; count[i]++; }
          if (anomaly && climateValues[climateBase + i] !== manifest.missing_u16) {
            climateSum[i] += climateValues[climateBase + i] / manifest.scale; climateCount[i]++;
          }
        }
      }
    });
    if (selected.length !== totalDays) throw new Error(`Cobertura incompleta: ${selected.length} de ${totalDays} días.`);
    if (operation === "mediana" && totalDays > 3660) throw new Error("La mediana exacta admite hasta 10 años.");
    const field = new Array(cells).fill(null), finite = [], scratch = operation === "mediana" ? new Float32Array(totalDays) : null;
    for (let i = 0; i < cells; i++) {
      if (count[i] !== totalDays || (anomaly && climateCount[i] !== totalDays)) continue;
      let value;
      if (operation === "anomalia_mm") value = sum[i] - climateSum[i];
      else if (operation === "anomalia_pct") {
        if (climateSum[i] < 1) continue;
        value = 100 * (sum[i] - climateSum[i]) / climateSum[i];
      }
      else if (operation === "acumulado") value = sum[i];
      else if (operation === "media") value = sum[i] / totalDays;
      else {
        for (let d = 0; d < selected.length; d++) scratch[d] = selected[d][0][selected[d][1] + i] / manifest.scale;
        scratch.sort(); const mid = Math.floor(totalDays / 2);
        value = totalDays % 2 ? scratch[mid] : (scratch[mid - 1] + scratch[mid]) / 2;
      }
      field[i] = Math.round(value * 10) / 10; finite.push(value);
    }
    const extentValues = anomaly ? finite.map(Math.abs) : finite.slice();
    extentValues.sort((a, b) => a - b); const vmax = Math.max(1, extentValues[Math.floor((extentValues.length - 1) * .98)] || 1);
    const palette = anomaly
      ? ["#543005", "#8c510a", "#bf812d", "#dfc27d", "#f5f5f5", "#80cdc1", "#35978f", "#01665e", "#003c30"]
      : ["#ffffd9", "#edf8b1", "#c7e9b4", "#7fcdbb", "#41b6c4", "#1d91c0", "#225ea8", "#0c2c84"];
    const colorscale = []; palette.forEach((color, i) => { colorscale.push([i / palette.length, color], [(i + 1) / palette.length, color]); });
    const rows = []; for (let y = 0; y < manifest.grid.ny; y++) rows.push(field.slice(y * manifest.grid.nx, (y + 1) * manifest.grid.nx));
    const label = { acumulado: "Lluvia acumulada", media: "Lluvia media diaria", mediana: "Mediana diaria de lluvia",
      anomalia_mm: "Anomalía de lluvia vs 1991–2020", anomalia_pct: "Anomalía relativa de lluvia vs 1991–2020" }[operation];
    return { lon: manifest.grid.lon, lat: manifest.grid.lat, campo: rows, colorscale,
      vmin: anomaly ? -Math.round(vmax * 10) / 10 : 0, vmax: Math.round(vmax * 10) / 10,
      unidad: operation === "anomalia_pct" ? "%" : "mm", variable: "precip", operacion: operation, desde, hasta, dias: totalDays,
      cobertura: { dias_solicitados: totalDays, dias_usados: totalDays, completa: true },
      titulo: `${label} — ${desde} a ${hasta}`, referencia: anomaly ? "1991-2020" : null,
      metodologia: anomaly ? "Mismos días calendario de 1991–2020; ≥24 años válidos por día y píxel." : null,
      leyenda_sub: anomaly ? `vs 1991–2020 · ${totalDays} días` : `${totalDays} días · ${desde} a ${hasta}` };
  }

  async function tabDiario(c) {
    inyectarCSS(); _alTema = null; await cargarGeo();
    c.innerHTML = cargando("Preparando series y grillas diarias…");
    let availability, stations = [], dailyManifest = null;
    try {
      if (window.HIDROMET_VISOR) {
        const response = await fetch("productos/clima/diario/manifest.json", { cache: "no-cache" });
        if (!response.ok) throw new Error(`Producto diario no publicado (HTTP ${response.status})`);
        dailyManifest = await response.json();
        availability = { mapa_precip: rangoMapaDiario(dailyManifest) };
        stations = dailyManifest.stations || [];
      } else {
        [availability, stations] = await Promise.all([
          App.api("/clima/diario_disponible"),
          App.api("/clima/estaciones").then(x => x.estaciones || []),
        ]);
      }
    } catch (e) { c.innerHTML = vacio("⚠️", esc(e.message)); return; }
    const mapInv = availability.mapa_precip || {};
    const end0 = mapInv.hasta || new Date().toISOString().slice(0, 10);
    const startDate = new Date(`${end0}T12:00:00`); startDate.setDate(startDate.getDate() - 10);
    const recentStart = startDate.toISOString().slice(0, 10);
    // El histórico completo permanece consultable en local, pero abrir la pestaña
    // nunca debe agregar de oficio varias décadas ni dibujar una serie ilegible.
    const start0 = mapInv.desde && mapInv.desde > recentStart ? mapInv.desde : recentStart;
    const options = stations.map(e =>
      `<option value="${esc(e.codigo)}">${opcionEstacion(e)}</option>`
    ).join("");
    c.innerHTML = `<div class="cl-wrap cl-diario-wrap">
      <div class="cl-toolbar cl-diario-toolbar">
        <div class="cl-grupo"><span>Desde</span><input type="date" data-rol="desde" min="${esc(mapInv.desde || "1990-01-01")}" max="${esc(end0)}" value="${esc(start0)}"></div>
        <div class="cl-grupo"><span>Hasta</span><input type="date" data-rol="hasta" min="${esc(mapInv.desde || "1990-01-01")}" max="${esc(end0)}" value="${esc(end0)}"></div>
        <div class="cl-grupo"><span>Mapa de lluvia</span><select data-rol="operacion"><option value="acumulado">Acumulado</option><option value="media">Promedio diario</option><option value="mediana">Mediana diaria</option><option value="anomalia_mm">Anomalía (mm)</option><option value="anomalia_pct">Anomalía (%)</option></select></div>
        <div class="cl-grupo"><button class="cl-btn" data-rol="actualizar">Actualizar producto</button></div>
      </div>
      ${dailyManifest ? `<div class="cl-hint">En el visor publicado solo está disponible la ventana
        del ${esc(mapInv.desde || "?")} al ${esc(mapInv.hasta || "?")}; el histórico completo se consulta
        en la aplicación de escritorio.</div>` : ""}
      <div class="cl-card cl-rango-card"><h3 class="cl-maptit" data-rol="map-tit">Mapa de lluvia por rango</h3>
        <div class="cl-plot cl-plot-mapa cl-rango-mapa" data-rol="mapa"></div><div class="ct-leyenda-carta cl-leyenda" data-rol="leyenda"></div>
        <p class="cl-nota" data-rol="map-nota">Se exige cobertura completa en cada píxel para el período seleccionado.</p></div>
      <div class="cl-card"><div class="cl-serie-head"><h3 class="cl-maptit">Cruce y relleno por estación</h3>
        <div class="cl-serie-controles"><input class="cl-buscar" data-rol="buscar" type="search" placeholder="Buscar nombre, región o dependencia…">
          <select data-rol="est">${options}</select><select data-rol="variable"><option value="precip">Precipitación</option><option value="tmax">T. máxima</option><option value="tmin">T. mínima</option></select></div></div>
        <div class="cl-plot" data-rol="serie"></div><div data-rol="metricas"></div>
        <div class="cl-aviso"><span class="ic">ⓘ</span><p data-rol="metodo">Los huecos se rellenan únicamente con una grilla de ventana temporal compatible. Cada valor conserva su procedencia y QC.</p></div></div>
    </div>`;
    const desde = c.querySelector('[data-rol="desde"]'), hasta = c.querySelector('[data-rol="hasta"]'),
      operation = c.querySelector('[data-rol="operacion"]'), mapHost = c.querySelector('[data-rol="mapa"]'),
      mapTitle = c.querySelector('[data-rol="map-tit"]'), station = c.querySelector('[data-rol="est"]'),
      variable = c.querySelector('[data-rol="variable"]'), seriesHost = c.querySelector('[data-rol="serie"]'),
      metricsHost = c.querySelector('[data-rol="metricas"]'), method = c.querySelector('[data-rol="metodo"]'),
      search = c.querySelector('[data-rol="buscar"]'), mapNote = c.querySelector('[data-rol="map-nota"]');
    let lastMap = null, lastSeries = null;
    async function loadMap() {
      limpiarPlot(mapHost); mapHost.innerHTML = cargando("Agregando grillas diarias…");
      try {
        const isAnomaly = operation.value === "anomalia_mm" || operation.value === "anomalia_pct";
        const d = dailyManifest
          ? await mapaDesdeChunks(dailyManifest, desde.value, hasta.value, operation.value)
          : await App.api(isAnomaly
            ? `/clima/mapa_anomalia?desde=${desde.value}&hasta=${hasta.value}&modo=${operation.value}`
            : `/clima/mapa_rango?desde=${desde.value}&hasta=${hasta.value}&operacion=${operation.value}`);
        if (d.error) throw new Error(d.error);
        d.leyenda_sub = isAnomaly ? `vs 1991–2020 · ${d.dias} días` : `${d.dias} días · ${d.desde} a ${d.hasta}`;
        mapNote.textContent = d.metodologia || "Se exige cobertura completa en cada píxel para el período seleccionado.";
        mapTitle.textContent = d.titulo || "Mapa por rango"; lastMap = d; pintarMapa(mapHost, d, null);
      } catch (e) { limpiarPlot(mapHost); mapHost.innerHTML = vacio("⚠️", esc(e.message)); }
    }
    async function loadSeries() {
      if (!station.value) return;
      limpiarPlot(seriesHost); seriesHost.innerHTML = cargando("Cruzando observación y grilla…"); metricsHost.innerHTML = "";
      try {
        const d = dailyManifest
          ? await serieDesdeChunks(dailyManifest, station.value, variable.value, desde.value, hasta.value)
          : await App.api(`/clima/serie_relleno?codigo=${encodeURIComponent(station.value)}&variable=${variable.value}&desde=${desde.value}&hasta=${hasta.value}`);
        if (d.error) throw new Error(d.error);
        lastSeries = d; pintarSerieRelleno(seriesHost, d); metricsHost.innerHTML = metricasRelleno(d);
        // Si la metodología llega como identificador interno de algoritmo (un slug con
        // guiones, sin espacios), traducirla a una frase y dejar el código como apunte.
        const metTxt = /^[a-z0-9_-]+$/i.test(String(d.metodologia || "")) && String(d.metodologia).includes("-")
          ? `Relleno con la grilla corregida por las estaciones vecinas (método técnico: ${d.metodologia}).`
          : d.metodologia;
        method.textContent = `${metTxt} Contrato: ${d.contrato_grilla}.`;
      } catch (e) { limpiarPlot(seriesHost); seriesHost.innerHTML = vacio("⚠️", esc(e.message)); }
    }
    async function updateAll() { await Promise.all([loadMap(), loadSeries()]); }
    c.querySelector('[data-rol="actualizar"]').onclick = updateAll;
    station.onchange = loadSeries; variable.onchange = loadSeries; operation.onchange = loadMap;
    search.oninput = () => {
      const q = search.value.trim().toLowerCase(), selected = station.value;
      station.innerHTML = stations.filter(e => !q || coincideEstacion(e, q))
        .map(e => `<option value="${esc(e.codigo)}">${opcionEstacion(e)}</option>`).join("");
      if ([...station.options].some(o => o.value === selected)) station.value = selected;
      else if (station.value) loadSeries();
    };
    _alTema = () => { if (lastMap) pintarMapa(mapHost, lastMap, null); if (lastSeries) pintarSerieRelleno(seriesHost, lastSeries); };
    updateAll();
  }

  // IUV POR ESTACIÓN — índice UV máximo diario CAMS en el punto de cada estación ----
  // Fuente: /clima/iuv_estaciones (base 5, hidromet.puente_uv). Por estación con
  // coordenadas, el valor de la celda CAMS Global de 0,4° MÁS CERCANA, sin interpolar,
  // para D0..D5 de la última captura; tres campos: CAMS crudo, corregido Jipijapa
  // (experimental, no acreditado) y CAMS cielo despejado. Nada se rellena: una
  // estación sin valor no se dibuja (nunca se pinta un cero).
  //
  // Escala OFICIAL de salud del índice UV (OMS): la que la gente ya conoce.
  const ESCALA_IUV = Object.freeze([
    { min: 0, max: 2, rotulo: "bajo", color: "#3EA72D" },
    { min: 3, max: 5, rotulo: "moderado", color: "#FFF300" },
    { min: 6, max: 7, rotulo: "alto", color: "#F18B00" },
    { min: 8, max: 10, rotulo: "muy alto", color: "#E53210" },
    { min: 11, max: null, rotulo: "extremo", color: "#B54CFF" },
  ]);
  const TOPE_IUV = 12;   // tope de la escala de color: 11+ (extremo) satura
  const CAMPOS_IUV = Object.freeze([
    { id: "cams", et: "CAMS crudo", corto: "CAMS crudo",
      t: "Índice UV máximo diario de CAMS Global en la celda de 0,4° (~44 km) más cercana a la estación, sin interpolar." },
    { id: "corr", et: "Corregido Jipijapa (experimental)", corto: "corregido Jipijapa",
      t: "CAMS crudo más el residual observado en Jipijapa, atenuado con la distancia: exp(−d/75 km). Una sola estación, coordenadas aproximadas: no acreditado." },
    { id: "cs", et: "CAMS cielo despejado", corto: "cielo despejado",
      t: "Índice UV máximo diario que CAMS daría sin nubes: el tope físico del día." },
  ]);
  const DIAS_CORTOS = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];

  // Escala del producto si viene bien formada (min numérico + color); si no, la oficial.
  function escalaIuv(payload) {
    const lista = payload && Array.isArray(payload.escala) ? payload.escala : null;
    if (!lista || !lista.length) return ESCALA_IUV;
    const ok = lista.every(b => b && isFinite(Number(b.min)) && typeof b.color === "string" && b.color);
    if (!ok) return ESCALA_IUV;
    return lista.map(b => ({ min: Number(b.min), max: b.max == null ? null : Number(b.max),
      rotulo: String(b.rotulo || ""), color: b.color })).sort((a, b) => a.min - b.min);
  }
  // Banda oficial de un valor: {indice, rotulo, color}. Sin dato → índice −1 y color null.
  function bandaIuv(v, escala) {
    const bandas = escala && escala.length ? escala : ESCALA_IUV;
    const x = v == null || v === "" ? NaN : Number(v);
    if (!isFinite(x)) return { indice: -1, rotulo: "sin dato", color: null };
    let i = 0;
    for (let k = 1; k < bandas.length; k++) if (x >= bandas[k].min) i = k;
    return { indice: i, rotulo: bandas[i].rotulo, color: bandas[i].color };
  }
  // Escala de color DISCRETA para Plotly: escalones en 0/3/6/8/11 sobre 0..12.
  function colorscaleIuv(escala, tope) {
    const bandas = escala && escala.length ? escala : ESCALA_IUV, top = tope || TOPE_IUV;
    const stops = [];
    bandas.forEach((b, i) => {
      const a = i === 0 ? 0 : Math.min(1, b.min / top);
      const z = i + 1 < bandas.length ? Math.min(1, bandas[i + 1].min / top) : 1;
      stops.push([a, b.color], [z, b.color]);
    });
    return stops;
  }
  function rotuloBanda(b) { return b.max == null ? `${b.min}+ ${b.rotulo}` : `${b.min}–${b.max} ${b.rotulo}`; }
  // Valor de un campo (cams|corr|cs|aod) en un lead; null si falta (jamás 0 por defecto).
  function valorIuv(e, campo, lead) {
    const v = e && e.valores && e.valores[String(lead)] ? e.valores[String(lead)][campo] : null;
    const x = v == null || v === "" ? NaN : Number(v);
    return isFinite(x) ? x : null;
  }
  // Puntos ALINEADOS (x=lon, y=lat, valor, estaciones) del campo en el lead. Omite las
  // estaciones sin valor o sin coordenadas y las cuenta en `omitidas`; `total` es el
  // tamaño del subconjunto pedido (todas o solo activas).
  function puntosIuv(payload, campo, lead, soloActivas) {
    const out = { x: [], y: [], valor: [], estaciones: [], omitidas: 0, total: 0 };
    for (const e of (payload && payload.estaciones) || []) {
      if (!e || (soloActivas && !e.activa)) continue;
      out.total++;
      const lat = Number(e.lat), lon = Number(e.lon), v = valorIuv(e, campo, lead);
      if (e.lat == null || e.lon == null || !isFinite(lat) || !isFinite(lon) || v == null) { out.omitidas++; continue; }
      out.x.push(lon); out.y.push(lat); out.valor.push(v); out.estaciones.push(e);
    }
    return out;
  }
  // Último observado válido de Jipijapa ({fecha, valor}) o null.
  function ultimoObservado(jip) {
    const obs = ((jip && jip.obs) || []).filter(o => o && o.fecha && o.valor != null && isFinite(Number(o.valor)));
    if (!obs.length) return null;
    obs.sort((a, b) => String(a.fecha).localeCompare(String(b.fecha)));
    const u = obs[obs.length - 1];
    return { fecha: String(u.fecha), valor: Number(u.valor) };
  }
  function distanciaKm(lat1, lon1, lat2, lon2) {
    const r = Math.PI / 180, R = 6371.0088;
    const dLat = (lat2 - lat1) * r, dLon = (lon2 - lon1) * r;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
  }
  // Peso de la corrección Jipijapa con la distancia: exp(−d/75 km) (decisión D-B5).
  function pesoJipijapa(dKm, escalaKm) { return Math.exp(-Math.max(0, Number(dKm) || 0) / (escalaKm || 75)); }
  // "2026-09-03" → "jue 03/09" sin pasar por la zona horaria del navegador.
  function rotuloFechaCorta(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ""));
    if (!m) return "";
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    if (isNaN(d.getTime()) || d.getUTCDate() !== +m[3]) return "";
    return `${DIAS_CORTOS[d.getUTCDay()]} ${m[3]}/${m[2]}`;
  }
  function fechaLead(payload, lead) {
    const l = ((payload && payload.leads) || []).find(x => x && String(x.lead) === String(lead));
    return l && l.fecha ? String(l.fecha) : "";
  }

  // Mapa de PUNTOS: una traza scatter por estación coloreada con la escala oficial y,
  // encima, la estrella de Jipijapa con su último observado. Devuelve los puntos
  // dibujados (para el conteo honesto bajo el mapa).
  function pintarIuv(host, payload, campo, lead, soloActivas) {
    if (!window.Plotly || !host) return null;
    const escala = escalaIuv(payload), pts = puntosIuv(payload, campo, lead, soloActivas);
    const cf = CAMPOS_IUV.find(x => x.id === campo) || CAMPOS_IUV[0];
    const jip = (payload && payload.jipijapa) || {}, hayJip = jip.lat != null && jip.lon != null;
    const fecha = fechaLead(payload, lead), osc = App.tema && App.tema() === "oscuro";
    if (!pts.x.length && !hayJip) {
      limpiarPlot(host); host.innerHTML = vacio("☀", `Sin ${cf.corto} para D${esc(lead)}: ninguna estación trae valor.`);
      return pts;
    }
    const muchos = pts.x.length > 400;
    const red = v => (App.redEtiqueta ? App.redEtiqueta(v || "") : String(v || ""));
    const puntos = {
      type: "scatter", mode: "markers", meta: "estaciones", showlegend: false, name: cf.corto,
      x: pts.x, y: pts.y,
      customdata: pts.estaciones.map((e, i) => {
        const dJ = hayJip ? distanciaKm(Number(e.lat), Number(e.lon), Number(jip.lat), Number(jip.lon)) : null;
        const celda = e.dist_celda_km != null ? ` · celda CAMS a ${num(e.dist_celda_km, 0)} km` : "";
        return [e.nombre || e.codigo, e.codigo, [red(e.red), e.region].filter(Boolean).join(" · "),
          num(pts.valor[i], 1), bandaIuv(pts.valor[i], escala).rotulo,
          num(valorIuv(e, "cams", lead), 1), num(valorIuv(e, "corr", lead), 1), num(valorIuv(e, "cs", lead), 1),
          num(valorIuv(e, "aod", lead), 2),
          dJ == null ? celda.replace(/^ · /, "") : `Jipijapa a ${num(dJ, 0)} km · peso de la corrección ${num(pesoJipijapa(dJ), 2)}${celda}`];
      }),
      marker: { size: muchos ? 5 : 7, color: pts.valor, colorscale: colorscaleIuv(escala), cmin: 0, cmax: TOPE_IUV,
        showscale: false, line: { color: "#ffffff", width: muchos ? 0.6 : 1.2 } },
      hovertemplate: `<b>%{customdata[0]}</b> (%{customdata[1]})<br>%{customdata[2]}<br>` +
        `<b>IUV ${esc(cf.corto)}: %{customdata[3]}</b> · %{customdata[4]}<br>` +
        `CAMS crudo %{customdata[5]} · corregido %{customdata[6]} · cielo despejado %{customdata[7]}<br>` +
        `AOD %{customdata[8]}${fecha ? " · " + esc(fecha) : ""}<br>%{customdata[9]}<extra></extra>`,
    };
    const trazas = [puntos];
    if (hayJip) {
      const obs = ultimoObservado(jip), bObs = bandaIuv(obs && obs.valor, escala);
      const estJip = jip.valores ? jip
        : ((payload && payload.estaciones) || []).find(e => e && String(e.codigo) === String(jip.codigo || "IUVJIP")) || null;
      trazas.push({
        type: "scatter", mode: "markers", meta: "jipijapa", showlegend: false, name: "Jipijapa",
        x: [Number(jip.lon)], y: [Number(jip.lat)],
        marker: { symbol: "star", size: 15, color: bObs.color || "#9aa4b5",
          line: { color: osc ? "#ffffff" : "#000000", width: 1.4 } },
        customdata: [[obs ? num(obs.valor, 1) : "—", obs ? (rotuloFechaCorta(obs.fecha) || obs.fecha) : "sin observación reciente",
          bObs.rotulo, num(valorIuv(estJip, "cams", lead), 1), num(valorIuv(estJip, "corr", lead), 1)]],
        hovertemplate: `<b>★ Jipijapa</b> (${esc(jip.codigo || "IUVJIP")})<br>` +
          `<b>Observado: %{customdata[0]}</b> · %{customdata[2]} · %{customdata[1]}<br>` +
          `CAMS crudo D${esc(lead)} %{customdata[3]} · corregido %{customdata[4]}<br>` +
          `coordenadas aproximadas · corrección no acreditada<extra></extra>`,
      });
    }
    const layout = App.plotlyLayoutBase({
      height: Math.max(410, Math.min(620, Math.round((host.clientWidth || 620) * .78))),
      margin: { l: 8, r: 8, t: 8, b: 8 }, hovermode: "closest",
      xaxis: { visible: false, scaleanchor: "y", constrain: "domain", range: [-92.5, -75.0] },
      yaxis: { visible: false, range: [-5.5, 2.0] },
    });
    quitarPlaceholder(host);
    Plotly.react(host, [...contorno(), ...trazas], layout, configEs());
    observarTamanoMapa(host);
    if (App.pinchZoomMapa) App.pinchZoomMapa(host);
    return pts;
  }

  function tablaObsJipijapa(jip, escala) {
    const obs = ((jip && jip.obs) || []).filter(o => o && o.fecha)
      .sort((a, b) => String(b.fecha).localeCompare(String(a.fecha))).slice(0, 7);
    if (!obs.length) return `<p class="cl-nota">Sin observación de Jipijapa en los últimos días.</p>`;
    return `<div class="cl-tabla-scroll"><table class="cl-tabla cl-tabla-obs cl-iuv-obs"><thead><tr>
      <th>Fecha</th><th>Observado</th><th>Banda</th></tr></thead><tbody>${obs.map(o => {
        const b = bandaIuv(o.valor, escala);
        return `<tr><td><span class="cl-fecha">${esc(rotuloFechaCorta(o.fecha) || o.fecha)}</span></td>` +
          `<td>${num(o.valor, 1)}</td><td>${b.color ? `<span class="cl-iuv-banda" style="--bc:${esc(b.color)}"><i></i>${esc(b.rotulo)}</span>` : "sin dato"}</td></tr>`;
      }).join("")}</tbody></table></div>`;
  }

  async function tabIuv(c) {
    inyectarCSS(); _alTema = null; await cargarGeo();
    c.innerHTML = cargando("Leyendo el índice UV por estación…");
    let p;
    try { p = await App.api("/clima/iuv_estaciones"); }
    catch (e) { c.innerHTML = vacio("⚠", esc(e.message)); return; }
    if (!p || p.error || !p.available) {
      c.innerHTML = `<div class="cl-wrap"><div class="cl-glo-intro cl-iuv-intro"><h3>IUV por estación</h3>
        <p>${esc((p && (p.diagnostic || p.error)) || "Sin base de índice UV: no se muestra un campo anterior ni se infieren valores.")}</p></div></div>`;
      return;
    }
    const escala = escalaIuv(p);
    const leads = Array.isArray(p.leads) && p.leads.length ? p.leads.filter(l => l && l.lead != null)
      : [0, 1, 2, 3, 4, 5].map(l => ({ lead: l, fecha: "" }));
    const ests = Array.isArray(p.estaciones) ? p.estaciones : [];
    const nTot = ests.length, nAct = ests.filter(e => e && e.activa).length;
    const jip = p.jipijapa || {}, obs = ultimoObservado(jip);
    const estJip = jip.valores ? jip : ests.find(e => e && String(e.codigo) === String(jip.codigo || "IUVJIP")) || null;
    // D-B3: por defecto solo las estaciones activas; el toggle enseña todas las que tienen coordenadas.
    const st = { lead: String(leads[0].lead), campo: "cams", activas: nAct > 0 };
    const etiquetas = Array.isArray(p.etiquetas) ? p.etiquetas.map(String)
      : (p.etiquetas && typeof p.etiquetas === "object" ? Object.entries(p.etiquetas).map(([k, v]) => `${k}: ${v}`) : []);
    const captura = String(p.captura_utc || "").replace("T", " ").slice(0, 16);
    c.innerHTML = `<div class="cl-wrap cl-iuv-wrap">
      <div class="cl-glo-intro cl-iuv-intro"><h3>IUV por estación · emisión ${esc(p.fecha_emision || "")}</h3>
        <p>Índice UV máximo diario en el punto de cada estación: el valor de la celda CAMS Global de 0,4° (~44 km)
        más cercana, <b>sin interpolar</b>. La corrección local Jipijapa es <b>experimental</b> (una sola estación,
        coordenadas aproximadas) y <b>no está acreditada</b>. Una estación sin valor no se dibuja: nunca se infiere cero.</p>
        <div class="cl-iuv-badges"><span>CAMS Global${captura ? ` · captura ${esc(captura)} UTC` : ""}</span>
          <span>${num(nTot)} estaciones con pronóstico UV · ${num(nAct)} activas</span>
          <span class="no">Corrección Jipijapa no acreditada</span>
          ${etiquetas.filter(Boolean).map(t => `<span>${esc(t)}</span>`).join("")}</div></div>
      <div class="cl-toolbar cl-iuv-toolbar">
        <div class="cl-grupo"><span>Día</span><div class="cl-meses cl-iuv-leads" data-rol="leads">
          ${leads.map(l => `<button class="cl-mes ${String(l.lead) === st.lead ? "on" : ""}" data-lead="${esc(l.lead)}" title="${esc(l.fecha || "")}">D${esc(l.lead)}<small>${esc(rotuloFechaCorta(l.fecha) || l.fecha || "sin fecha")}</small></button>`).join("")}
        </div></div>
        <div class="cl-grupo"><span>Campo</span><select data-rol="campo">
          ${CAMPOS_IUV.map(f => `<option value="${f.id}" title="${esc(f.t)}">${esc(f.et)}</option>`).join("")}</select></div>
        <div class="cl-grupo"><span>Estaciones</span>
          <label class="cl-chk"><input type="checkbox" data-rol="activas" ${st.activas ? "checked" : ""}> solo activas (${num(nAct)} de ${num(nTot)})</label></div>
      </div>
      <div class="cl-iuv-grid"><div class="cl-card"><h3 class="cl-maptit" data-rol="iuv-tit">IUV</h3>
        <div class="cl-plot cl-plot-mapa cl-iuv-map" data-rol="iuv-map"></div>
        <div class="cl-iuv-leyenda" aria-label="Escala oficial del índice UV (OMS)">
          ${escala.map(b => `<span class="cl-iuv-banda" style="--bc:${esc(b.color)}"><i></i>${esc(rotuloBanda(b))}</span>`).join("")}
          <span class="cl-iuv-banda estrella"><i>★</i>Jipijapa: último observado</span>
          <span class="cl-iuv-banda sin"><i></i>sin valor: sin punto</span></div>
        <p class="cl-nota" data-rol="iuv-conteo"></p>
        <p class="cl-nota" data-rol="iuv-campo"></p></div>
        <div class="cl-card cl-iuv-local"><h3 class="cl-maptit">Jipijapa · control observacional</h3>
          <div class="cl-kpis">
            ${kpi(obs ? `Observado · ${rotuloFechaCorta(obs.fecha) || obs.fecha}` : "Observado", obs && obs.valor, "IUV", 1, "#10243f")}
            ${kpi("CAMS crudo D0", valorIuv(estJip, "cams", 0), "IUV", 1, "#e89a28")}
            ${kpi("Corregido D0", valorIuv(estJip, "corr", 0), "IUV", 1, "#2f9e8f")}
            ${kpi(`Residual obs − CAMS · ${num(jip.n_pares, 0)} pares`, jip.residual, "IUV", 2, "#7b61a8")}
          </div>
          <div class="cl-aviso"><span class="ic">ⓘ</span><p><b>${esc(jip.codigo || "IUVJIP")}</b> ·
            coordenadas ${jip.coords_aproximadas === false ? "verificadas" : "aproximadas"} ·
            acreditado: <b>${jip.acreditado === true ? "sí" : "no"}</b>${jip.shrink != null ? ` · factor de encogimiento ${num(jip.shrink, 2)}` : ""}.<br>
            ${esc(jip.nota || "La corrección se atenúa con la distancia, exp(−d/75 km): a más de ~200 km es prácticamente CAMS crudo.")}</p></div>
          ${tablaObsJipijapa(jip, escala)}
          <p class="cl-nota">Observado = máximo diario del sensor UV de Jipijapa (base 1). El residual es la media de
            observado − CAMS en los últimos pares, encogida según el número de pares.</p></div></div>
    </div>`;
    const map = c.querySelector('[data-rol="iuv-map"]'), tit = c.querySelector('[data-rol="iuv-tit"]'),
      conteo = c.querySelector('[data-rol="iuv-conteo"]'), notaCampo = c.querySelector('[data-rol="iuv-campo"]'),
      leadsEl = c.querySelector('[data-rol="leads"]'), selCampo = c.querySelector('[data-rol="campo"]'),
      chkAct = c.querySelector('[data-rol="activas"]');
    const draw = () => {
      const cf = CAMPOS_IUV.find(f => f.id === st.campo) || CAMPOS_IUV[0], fecha = fechaLead(p, st.lead);
      tit.textContent = `${cf.et} · D${st.lead}${fecha ? " · " + (rotuloFechaCorta(fecha) || fecha) : ""}`;
      notaCampo.textContent = cf.t;
      const pts = pintarIuv(map, p, st.campo, st.lead, st.activas);
      conteo.textContent = !pts ? "" :
        `${num(pts.x.length)} puntos con valor de ${num(pts.total)} estaciones ${st.activas ? "activas" : "con pronóstico UV"}` +
        (pts.omitidas ? ` · ${num(pts.omitidas)} sin valor en D${st.lead} (no se dibujan)` : "") + ".";
    };
    leadsEl.querySelectorAll(".cl-mes").forEach(b => { b.onclick = () => {
      st.lead = String(b.dataset.lead);
      leadsEl.querySelectorAll(".cl-mes").forEach(x => x.classList.toggle("on", x === b));
      draw();
    }; });
    selCampo.onchange = () => { st.campo = selCampo.value; draw(); };
    chkAct.onchange = () => { st.activas = chkAct.checked; draw(); };
    _alTema = () => { if (c.isConnected) draw(); };
    draw();
  }

  App.registrar("clima", {
    titulo: "Climatología", orden: 2.5,
    // Al salir del módulo: purgar TODOS los Plotly vivos (mapa, ranking, climogramas,
    // récords) — cada instancia deja listeners de window si no se purga.
    alDejar() {
      if (!window.Plotly) return;
      document.querySelectorAll("#vista .js-plotly-plot").forEach(el => { try { Plotly.purge(el); } catch (e) { /* ya purgado */ } });
    },
    async render(vista) {
      vista.dataset.screenLabel = "Climatología";
      vista.classList.add("vista-clima");
      E.tabs = App.vistaPestanas(vista, {
        kicker: "Normales 1991–2020 · grilla 0.05° de Ecuador",
        titulo: "Climatología",
        sub: "Mallas climáticas calibradas (~5 km) · Ecuador",
        acento: "var(--cyan)",
        inicial: "mapas",
        pestanas: [
          // v14 (pedido del dueño): MENOS pestañas — "Por estación" vive DENTRO de
          // Explorar (selector + clic en mapa/ranking → climograma y ficha ahí mismo).
          { id: "mapas", etiqueta: "Explorar", render: tabMapas },
          { id: "diario", etiqueta: "Series y acumulados", render: tabDiario },
          { id: "enso", etiqueta: "El Niño histórico", render: tabEnso },
          { id: "iuv", etiqueta: "IUV por estación", render: tabIuv },
          // "Por coordenada" consulta lat/lon libres (imposible de congelar) → oculta en el visor.
          window.HIDROMET_VISOR ? null : { id: "punto", etiqueta: "Por coordenada", render: tabPunto },
          { id: "glosario", etiqueta: "Metodología", render: tabGlosario },
        ],
      });
    },
  });

  // Superficie pura para las pruebas Node de la pestaña IUV (mismo patrón que
  // cartas.js). En navegador no se expone ningún global adicional.
  if (typeof module === "object" && module.exports) module.exports = Object.freeze({
    ESCALA_IUV, TOPE_IUV, CAMPOS_IUV, escalaIuv, bandaIuv, colorscaleIuv, rotuloBanda, valorIuv,
    puntosIuv, ultimoObservado, distanciaKm, pesoJipijapa, rotuloFechaCorta, fechaLead,
    rangoMapaDiario,
  });
})();
