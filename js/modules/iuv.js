/* ============================================================
   Índice ultravioleta (IUV) — pronóstico CAMS D0..D5 por estación.
   Vivía como pestaña de Climatología; el 2026-09-17 pasó a Pronóstico, que es
   lo que de verdad es: un pronóstico a cinco días, no una normal climática.
   Se registra como panel (App.panel) y lo monta cartas.js, el mismo patrón con
   el que Hidrología montaba sus paneles.
   Backend: /api/iuv/* (app/modulos/iuv/).
   ============================================================ */
"use strict";

(() => {
  const esc = v => String(v ?? "").replace(/[&<>"']/g,
    c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const num = (v, d = 0) => App.fmtNum(v, d);
  const vacio = (ic, txt) => `<div class="cl-vacio"><span class="ic">${ic}</span><span>${txt}</span></div>`;
  const cargando = txt => vacio("⏳", txt || "Cargando…");
  const kpi = (e, v, u, d, c) => `<div class="cl-kpi" style="--kc:${c}"><div class="v">${num(v, d)} <small>${esc(u)}</small></div><div class="e">${esc(e)}</div></div>`;
  function limpiarPlot(host) {
    try { if (window.Plotly && host && host.classList && host.classList.contains("js-plotly-plot")) Plotly.purge(host); }
    catch (e) {}
    if (host) { delete host._clickEst; delete host._clickRank; }
  }
  let _alTema = null;
  document.addEventListener("temacambiado", () => { if (_alTema) try { _alTema(); } catch (e) {} });

  // IUV POR ESTACIÓN — índice UV máximo diario CAMS en el punto de cada estación ----
  // Fuente: /iuv/estaciones (base 5, hidromet.puente_uv). Por estación con
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
      t: "CAMS ajustado con la medición de Jipijapa; el ajuste pierde fuerza con la distancia. Una sola estación, de coordenadas aproximadas: no acreditado." },
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
    try { p = await App.api("/iuv/estaciones"); }
    catch (e) { c.innerHTML = vacio("⚠", esc(e.message)); return; }
    if (!p || p.error || !p.available) {
      const motivo = App.textosServidor([p && p.diagnostic, p && p.error])[0]
        || "Todavía no hay índice UV publicado.";
      c.innerHTML = `<div class="cl-wrap"><div class="cl-glo-intro cl-iuv-intro"><h3>IUV por estación</h3>
        <p>${esc(motivo)}</p></div></div>`;
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
    const etiquetas = App.textosServidor(Array.isArray(p.etiquetas) ? p.etiquetas
      : (p.etiquetas && typeof p.etiquetas === "object" ? Object.values(p.etiquetas) : []));
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
        <div class="cl-card cl-iuv-local"><h3 class="cl-maptit">Jipijapa · medición de control</h3>
          <div class="cl-kpis">
            ${kpi(obs ? `Observado · ${rotuloFechaCorta(obs.fecha) || obs.fecha}` : "Observado", obs && obs.valor, "IUV", 1, "#10243f")}
            ${kpi("CAMS crudo D0", valorIuv(estJip, "cams", 0), "IUV", 1, "#e89a28")}
            ${kpi("Corregido D0", valorIuv(estJip, "corr", 0), "IUV", 1, "#2f9e8f")}
            ${kpi(`Diferencia medido − CAMS · ${num(jip.n_pares, 0)} días`, jip.residual, "IUV", 2, "#7b61a8")}
          </div>
          <div class="cl-aviso"><span class="ic">ⓘ</span><p><b>${esc(jip.codigo || "IUVJIP")}</b> ·
            coordenadas ${jip.coords_aproximadas === false ? "verificadas" : "aproximadas"} ·
            acreditado: <b>${jip.acreditado === true ? "sí" : "no"}</b>.<br>
            ${esc(App.textoServidor(jip.nota) || "La corrección pierde fuerza con la distancia: más allá de unos 200 km el valor es prácticamente el de CAMS sin corregir.")}</p></div>
          ${tablaObsJipijapa(jip, escala)}
          <p class="cl-nota">Lo observado es el máximo diario del sensor de índice UV de Jipijapa. La diferencia
            es el promedio de lo medido menos CAMS en los días con ambos datos, atenuada cuando hay pocos.</p></div></div>
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
        (pts.omitidas ? ` · ${num(pts.omitidas)} sin valor en D${st.lead}` : "") + ".";
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


  App.panel("iuv", tabIuv);
  App.panel("iuv:purgar", () => {
    if (!window.Plotly) return;
    document.querySelectorAll("#vista .js-plotly-plot").forEach(el => {
      try { Plotly.purge(el); } catch (e) { /* ya purgado */ }
    });
  });

  // Superficie pura para las pruebas Node de este módulo. En navegador no se expone ningún global adicional.
  if (typeof module === "object" && module.exports) module.exports = Object.freeze({
    ESCALA_IUV, TOPE_IUV, CAMPOS_IUV, escalaIuv, bandaIuv, colorscaleIuv, rotuloBanda, valorIuv,
    puntosIuv, ultimoObservado, distanciaKm, pesoJipijapa, rotuloFechaCorta, fechaLead,
  });

})();
