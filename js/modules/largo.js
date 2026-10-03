/* ============================================================
   Largo plazo — pronóstico estacional y pluma de El Niño.
   Backend: /api/largo/* (app/rutas/largo.py ← hidromet/largo_plazo).

   Es un producto: la vista no nombra centros, modelos ni fuentes (pedido del
   dueño, 2026-10-03: «Quita el apartado de metodología. Esto es un producto. no
   quiero poner esas cosas»). El visor publicado recibe además el índice y la
   pluma ya limpios (exportar_web.largo_publico).

   Dibujo de los campos: la malla publicada es de 0,1° (interpolada de la nativa
   de 1°). Aquí se refina ×4 con interpolación bicúbica y se pinta con CLASES de
   color: el campo sale suave y cada clase con su borde nítido. El contorno del
   país es una máscara de polígono (la costa exacta, sin escalones de celda).

   «Valor esperado» (2026-10-03): lluvia en mm y temperatura en °C calibradas con
   la normal local y el DEM de 30 m (hidromet/largo_plazo/calibrado.py). El mapa
   grande usa su malla de 0,025°, que trae el detalle del relieve; los pequeños,
   el promedio a 0,1° del archivo del periodo.
   ============================================================ */
"use strict";

(() => {
  const esc = v => String(v ?? "").replace(/[&<>"']/g,
    c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const num = (v, d = 0) => App.fmtNum(v, d);
  const sig = (v, d = 1) => (App.fmtSigno ? App.fmtSigno(v, d) : num(v, d));
  const oscuro = () => (App.tema ? App.tema() === "oscuro" : true);

  const E = {
    indice: null, periodo: null, variable: "lluvia", producto: "esperado",
    archivos: new Map(), geo: null, nino: null, provincias: null, tabs: null, _alTema: null,
  };
  document.addEventListener("temacambiado", () => { if (E._alTema) try { E._alTema(); } catch (e) { /* vista cerrada */ } });

  /* ---------------- escalas de color: clases con borde nítido ----------------
     Divergentes y centradas en «normal». Lluvia: marrón (seco) → verde-azul (húmedo);
     temperatura: azul (frío) → rojo (cálido); probabilidad: la categoría más
     probable con la intensidad de su probabilidad (gris = sin señal clara). */
  const ESCALAS = {
    lluvia_esp: {
      titulo: "Lluvia esperada", unidad: "mm", dec: 0, campo: "lluvia_esperada",
      bordes: [10, 25, 50, 75, 100, 150, 200, 250, 300, 400, 500, 700],
      colores: ["#f3e7c6", "#e8e2a4", "#cde39f", "#a5d699", "#74c39a", "#47ab9c", "#2a8f9e", "#23729b",
                "#2a5797", "#33408d", "#3b2c80", "#45206f", "#4f1460"],
    },
    t2m_esp: {
      titulo: "Temperatura media esperada", unidad: "°C", dec: 1, campo: "t2m_esperada",
      bordes: [2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28],
      colores: ["#3f1d6b", "#3b3d99", "#2f62b3", "#2c86c1", "#3aa6c4", "#5fbfb6", "#8fd3a0", "#bfe08a",
                "#e6e57d", "#f7d26a", "#f9b457", "#f39046", "#e4683a", "#cc4030", "#a3202a"],
    },
    lluvia_pct: {
      titulo: "Anomalía de lluvia", unidad: "% de lo normal", dec: 0, signo: true,
      bordes: [-75, -50, -30, -15, -5, 5, 15, 30, 50, 75, 100, 150],
      colores: ["#7a3f0a", "#a8641e", "#d09a4e", "#ead2a0", "#f6ecd5", "#eef1f4", "#cfe9e1", "#93d1c0",
                "#4fae9c", "#1f8a7f", "#11667a", "#1e4b8f", "#3d2c8d"],
    },
    t2m: {
      titulo: "Anomalía de temperatura", unidad: "°C", dec: 1, signo: true,
      bordes: [-3, -2, -1.5, -1, -0.5, -0.2, 0.2, 0.5, 1, 1.5, 2, 3, 4],
      colores: ["#08306b", "#1f5aa8", "#4a8bc9", "#86b8de", "#bcd7ec", "#e1ecf6", "#f1f1f1", "#fde0c5",
                "#fbb98a", "#f68b5a", "#e0533a", "#b8252a", "#86101e", "#4f0613"],
    },
    prob_lluvia: {
      titulo: "Categoría más probable · lluvia", unidad: "% de probabilidad", dec: 0, prob: true,
      bordes: [-80, -70, -60, -50, -40, 40, 50, 60, 70, 80],
      colores: ["#7f2704", "#c2510b", "#ec7c27", "#f9a85a", "#fdd2a0", "#e3e6ea", "#c2e6b9", "#7cc77d",
                "#319a58", "#0f7038", "#04441f"],
      bajo: "Bajo lo normal", sobre: "Sobre lo normal",
    },
    prob_t2m: {
      titulo: "Categoría más probable · temperatura", unidad: "% de probabilidad", dec: 0, prob: true,
      bordes: [-80, -70, -60, -50, -40, 40, 50, 60, 70, 80],
      colores: ["#08306b", "#1a5aa6", "#3d86c6", "#79b2dc", "#bcd8ee", "#e3e6ea", "#fcc5ad", "#f99071",
                "#e5502f", "#b81c1f", "#6d0a12"],
      bajo: "Más frío que lo normal", sobre: "Más cálido que lo normal",
    },
  };
  function claveEscala() {
    if (E.producto === "probabilidad") return E.variable === "lluvia" ? "prob_lluvia" : "prob_t2m";
    if (E.producto === "esperado") return E.variable === "lluvia" ? "lluvia_esp" : "t2m_esp";
    return E.variable === "lluvia" ? "lluvia_pct" : "t2m";
  }
  // Rango de dibujo: una clase más allá de cada borde extremo.
  function rangoEscala(es) {
    const b = es.bordes, n = b.length;
    return [b[0] - (b[1] - b[0]), b[n - 1] + (b[n - 1] - b[n - 2])];
  }
  function colorscaleDiscreta(es) {
    const [z0, z1] = rangoEscala(es), span = z1 - z0;
    const cortes = [z0, ...es.bordes, z1];
    const stops = [];
    es.colores.forEach((c, i) => {
      stops.push([(cortes[i] - z0) / span, c], [(cortes[i + 1] - z0) / span, c]);
    });
    return stops;
  }
  function claseDe(es, v) {
    if (v == null || !isFinite(v)) return null;
    let i = 0;
    while (i < es.bordes.length && v >= es.bordes[i]) i++;
    return i;
  }

  /* ---------------- refinado bicúbico (Catmull-Rom) ---------------- */
  function refinar(z, f) {
    const ny = z.length, nx = z[0].length;
    const NY = (ny - 1) * f + 1, NX = (nx - 1) * f + 1;
    const at = (j, i) => {
      j = j < 0 ? 0 : (j > ny - 1 ? ny - 1 : j);
      i = i < 0 ? 0 : (i > nx - 1 ? nx - 1 : i);
      const v = z[j][i];
      return v == null || !isFinite(v) ? NaN : v;
    };
    const cr = (a, b, c, d, t) => 0.5 * ((2 * b) + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t * t
      + (-a + 3 * b - 3 * c + d) * t * t * t);
    const out = new Array(NY);
    for (let J = 0; J < NY; J++) {
      const j = Math.min(Math.floor(J / f), ny - 2), ty = J / f - j;
      const fila = new Array(NX);
      for (let I = 0; I < NX; I++) {
        const i = Math.min(Math.floor(I / f), nx - 2), tx = I / f - i;
        const r = [];
        for (let m = -1; m <= 2; m++)
          r.push(cr(at(j + m, i - 1), at(j + m, i), at(j + m, i + 1), at(j + m, i + 2), tx));
        let v = cr(r[0], r[1], r[2], r[3], ty);
        if (!isFinite(v)) {   // borde con huecos: bilineal de los cuatro vecinos válidos
          const q = [at(j, i), at(j, i + 1), at(j + 1, i), at(j + 1, i + 1)];
          const w = [(1 - tx) * (1 - ty), tx * (1 - ty), (1 - tx) * ty, tx * ty];
          let s = 0, ws = 0;
          q.forEach((x, k) => { if (isFinite(x)) { s += x * w[k]; ws += w[k]; } });
          v = ws > 0.5 ? s / ws : NaN;
        }
        fila[I] = isFinite(v) ? v : null;
      }
      out[J] = fila;
    }
    return out;
  }
  function ejes(m, f) {
    const xs = [], ys = [];
    for (let i = 0; i <= (m.nx - 1) * f; i++) xs.push(m.lon0 + (m.paso / f) * i);
    for (let j = 0; j <= (m.ny - 1) * f; j++) ys.push(m.lat0 + (m.paso / f) * j);
    return { xs, ys };
  }

  /* ---------------- datos ---------------- */
  async function indice() {
    if (!E.indice) E.indice = await App.api("/largo/indice");
    return E.indice;
  }
  async function archivo(nombre) {
    if (!E.archivos.has(nombre)) E.archivos.set(nombre, App.api(`/largo/archivo/${nombre}`));
    try { return await E.archivos.get(nombre); }
    catch (e) { E.archivos.delete(nombre); throw e; }
  }
  async function geo() {
    if (E.geo === null) E.geo = App.geoProvincias ? await App.geoProvincias() : false;
    return E.geo;
  }

  // Campo del producto activo en una malla: anomalía tal cual; probabilidad como
  // «categoría más probable con signo» (+ sobre, − bajo, 0 si la normal domina o
  // ninguna pasa del 40 %).
  function campoActivo(dat, malla) {
    const c = dat.campos || {};
    if (E.producto === "esperado") {
      const k = ESCALAS[claveEscala()].campo;
      return c[k] ? c[k][malla] : null;
    }
    if (E.producto !== "probabilidad") {
      const k = E.variable === "lluvia" ? "lluvia_pct" : "t2m";
      return c[k] ? c[k][malla] : null;
    }
    const s = E.variable === "lluvia" ? "lluvia" : "t2m";
    const pb = c[`p_bajo_${s}`], pn = c[`p_normal_${s}`], ps = c[`p_sobre_${s}`];
    if (!pb || !ps || !pn) return null;
    const B = pb[malla], N = pn[malla], S = ps[malla];
    return B.map((fila, j) => fila.map((b, i) => {
      const n = N[j][i], s2 = S[j][i];
      if (b == null || n == null || s2 == null) return null;
      if (s2 >= b && s2 >= n && s2 >= 40) return s2;
      if (b > s2 && b >= n && b >= 40) return -b;
      return 0;
    }));
  }
  function textoValor(es, v) {
    if (v == null || !isFinite(v)) return "sin dato";
    if (es.campo) return `${num(v, es.dec)} ${es.unidad}`;
    if (es.prob) {
      if (v === 0 || Math.abs(v) < 40) return "Sin señal clara (normal o empate)";
      return `${v > 0 ? es.sobre : es.bajo}: ${num(Math.abs(v), 0)} %`;
    }
    return `${es.signo ? sig(v, es.dec) : num(v, es.dec)} ${es.unidad}`;
  }

  /* ---------------- mapa ---------------- */
  // Máscara: rectángulo con TODOS los anillos de las provincias como huecos (regla
  // par-impar de Plotly): fuera de Ecuador se pinta el color del mar, dentro queda
  // el campo. Contorno exacto, sin escalones de celda.
  function anillosProvincias(g) {
    const xs = [], ys = [];
    for (const f of ((g && g.features) || [])) {
      const geom = f && f.geometry; if (!geom) continue;
      const polys = geom.type === "Polygon" ? [geom.coordinates] : geom.type === "MultiPolygon" ? geom.coordinates : [];
      for (const poly of polys) for (const ring of poly) {
        for (const [x, y] of ring) { xs.push(x); ys.push(y); }
        xs.push(null); ys.push(null);
      }
    }
    return { xs, ys };
  }
  function trazaMascara(g, caja, ejeX, ejeY, colorMar) {
    const a = anillosProvincias(g);
    const [x0, x1, y0, y1] = caja;
    const xs = [x0, x1, x1, x0, x0, null, ...a.xs];
    const ys = [y0, y0, y1, y1, y0, null, ...a.ys];
    return { type: "scatter", mode: "lines", x: xs, y: ys, xaxis: ejeX, yaxis: ejeY, fill: "toself",
      fillcolor: colorMar, line: { width: 0 }, hoverinfo: "skip", showlegend: false };
  }
  function trazasBordes(g, ejeX, ejeY) {
    const t = App.trazasContornoProvincias ? App.trazasContornoProvincias(g) : [];
    return t.map(x => Object.assign({}, x, { xaxis: ejeX, yaxis: ejeY }));
  }
  const CAJA_C = [-81.25, -75.05, -5.15, 1.65];
  const CAJA_G = [-92.15, -89.05, -1.6, 0.8];

  async function pintarMapa(host, dat, opts = {}) {
    if (!host || !window.Plotly) return;
    const es = ESCALAS[claveEscala()];
    const g = await geo();
    const f = opts.mini ? 2 : 4;
    // Valor esperado en el mapa grande: el continente sale de la malla fina (0,025°), que ya
    // trae el detalle del relieve; se refina ×2 solo para suavizar los bordes de clase.
    const det = !opts.mini && opts.detalle && opts.detalle.malla ? opts.detalle : null;
    const colorMar = getComputedStyle(document.documentElement).getPropertyValue("--sea-bottom").trim() || (oscuro() ? "#0C1526" : "#EEF3F8");
    const [zmin, zmax] = rangoEscala(es);
    const cs = colorscaleDiscreta(es);
    const trazas = [];
    // La normal local es solo continental: con el valor esperado no hay recuadro de Galápagos.
    const conGalapagos = E.producto !== "esperado";
    for (const [malla, ejeX, ejeY] of [["continente", "x", "y"], ...(conGalapagos ? [["galapagos", "x2", "y2"]] : [])]) {
      const fino = det && malla === "continente";
      const z0 = fino ? det.valores : campoActivo(dat, malla);
      const m = fino ? det.malla : (dat.mallas && dat.mallas[malla]);
      if (!z0 || !m) continue;
      const ff = fino ? 2 : f;
      const z = refinar(z0, ff);
      const { xs, ys } = ejes(m, ff);
      const t = { type: "heatmap", x: xs, y: ys, z, xaxis: ejeX, yaxis: ejeY, zmin, zmax, colorscale: cs,
        zsmooth: "best", showscale: false, hoverongaps: false };
      if (opts.mini) t.hoverinfo = "skip";
      else {
        t.customdata = z.map(fila => fila.map(v => textoValor(es, v)));
        t.hovertemplate = `%{y:.2f}°, %{x:.2f}°<br><b>%{customdata}</b><extra></extra>`;
      }
      trazas.push(t);
      trazas.push(trazaMascara(g, malla === "continente" ? CAJA_C : CAJA_G, ejeX, ejeY, colorMar));
      trazas.push(...trazasBordes(g, ejeX, ejeY));
    }
    const ink = oscuro() ? "#95A3BB" : "#56647C";
    const layout = App.plotlyLayoutBase({
      margin: { l: 0, r: 0, t: 0, b: 0 }, hovermode: "closest", dragmode: opts.mini ? false : "pan",
      xaxis: { visible: false, range: [CAJA_C[0], CAJA_C[1]], domain: [0, 1], fixedrange: !!opts.mini },
      yaxis: { visible: false, range: [CAJA_C[2], CAJA_C[3]], scaleanchor: "x", scaleratio: 1, domain: [0, 1], fixedrange: !!opts.mini },
      // Galápagos abajo a la DERECHA: esa esquina del recuadro cae sobre Perú (0 % de territorio
      // ecuatoriano medido con el contorno oficial); abajo a la izquierda tapaba El Oro y Guayas.
      xaxis2: { visible: false, range: [CAJA_G[0], CAJA_G[1]], domain: [0.70, 0.98], anchor: "y2", fixedrange: true },
      yaxis2: { visible: false, range: [CAJA_G[2], CAJA_G[3]], domain: [0.03, 0.3], anchor: "x2", scaleanchor: "x2", fixedrange: true },
      shapes: !conGalapagos ? [] : [{ type: "rect", xref: "paper", yref: "paper", x0: 0.70, x1: 0.98, y0: 0.03, y1: 0.3,
        line: { color: oscuro() ? "#33435F" : "#C9D3E1", width: 1 }, fillcolor: "rgba(0,0,0,0)" }],
      annotations: opts.mini || !conGalapagos ? [] : [{ xref: "paper", yref: "paper", x: 0.98, y: 0.305, xanchor: "right", yanchor: "bottom",
        text: "Galápagos", showarrow: false, font: { size: 10, color: ink } }],
    });
    // Relieve sombreado del DEM de 30 m sobre el color, recortado a Ecuador (fuera va el mar).
    // Los mapas pequeños de «Mes a mes» no lo llevan: a ese tamaño no se lee y pesa.
    if (!opts.mini && App.imagenesRelieve) layout.images = await App.imagenesRelieve("x", "y", { soloEcuador: true });
    // Sin zoom con la rueda: la rueda desplaza la página (atraparla sobre un mapa grande
    // deja al usuario sin poder bajar). Se acerca arrastrando o pellizcando; doble clic vuelve.
    const cfg = App.plotlyConfig({ displayModeBar: false, scrollZoom: false, staticPlot: !!opts.mini });
    await Plotly.react(host, trazas, layout, cfg);
  }

  function leyendaHTML(es) {
    const n = es.colores.length;
    const celdas = es.colores.map(c => `<span style="background:${c}"></span>`).join("");
    const rot = es.bordes.map((b, i) => {
      const pos = ((i + 1) / n) * 100;
      const txt = es.prob ? num(Math.abs(b), 0) : (es.signo && b > 0 ? "+" : "") + num(b, es.dec);
      return `<span class="t" style="left:${pos.toFixed(2)}%">${esc(txt)}</span>`;
    }).join("");
    const lados = es.prob
      ? `<div class="lp-ley-lados"><span>← ${esc(es.bajo)}</span><span>${esc(es.sobre)} →</span></div>` : "";
    return `<div class="lp-ley" role="img" aria-label="${esc(es.titulo)}">
      <div class="lp-ley-cab"><b>${esc(es.titulo)}</b><span>${esc(es.unidad)}</span></div>
      <div class="lp-ley-barra">${celdas}</div><div class="lp-ley-ticks">${rot}</div>${lados}</div>`;
  }

  /* ---------------- resumen por provincia ---------------- */
  function filasProvincias(per) {
    const P = (E.provincias && E.provincias.provincias) || [];
    const s = E.variable === "lluvia" ? "lluvia" : "t2m";
    return P.map(p => {
      const v = (p.valores || {})[per] || {};
      return { nombre: p.nombre, region: p.region, anom: E.variable === "lluvia" ? v.lluvia_pct : v.t2m,
               esp: E.variable === "lluvia" ? v.lluvia_esperada : v.t2m_esperada,
               mm: v.lluvia_mm, pb: v[`p_bajo_${s}`], pn: v[`p_normal_${s}`], ps: v[`p_sobre_${s}`] };
    }).filter(r => r.nombre);
  }
  function htmlProvincias(per) {
    const es = ESCALAS[claveEscala()];
    const filas = filasProvincias(per);
    if (!filas.length) return `<p class="lp-nota">Sin resumen por provincia.</p>`;
    if (E.producto === "probabilidad") {
      filas.sort((a, b) => (b.ps ?? -1) - (a.ps ?? -1));
      const col = es.colores;
      return `<div class="lp-prov-lista">${filas.map(r => {
        const pb = r.pb ?? 0, pn = r.pn ?? 0, ps = r.ps ?? 0;
        return `<div class="lp-prov"><div class="lp-prov-n"><b>${esc(r.nombre)}</b><small>${esc(r.region || "")}</small></div>
          <div class="lp-terc" title="Bajo ${num(pb)} % · normal ${num(pn)} % · sobre ${num(ps)} %">
            <i style="width:${pb}%;background:${col[2]}"></i><i style="width:${pn}%;background:${col[5]}"></i><i style="width:${ps}%;background:${col[col.length - 3]}"></i></div>
          <div class="lp-prov-v">${num(ps)} %</div></div>`;
      }).join("")}</div>
      <div class="lp-terc-ley"><span><i style="background:${col[2]}"></i>${esc(es.bajo)}</span><span><i style="background:${col[5]}"></i>Normal</span><span><i style="background:${col[col.length - 3]}"></i>${esc(es.sobre)}</span></div>`;
    }
    if (E.producto === "esperado") {
      // Valor esperado: barra desde cero con el color de su clase y, debajo, la anomalía.
      filas.sort((a, b) => (b.esp ?? -1e9) - (a.esp ?? -1e9));
      const max = Math.max(1e-9, ...filas.map(r => Math.abs(r.esp ?? 0)));
      return `<div class="lp-prov-lista">${filas.map(r => {
        const v = r.esp, k = claseDe(es, v), c = k == null ? "transparent" : es.colores[k];
        const ancho = v == null ? 0 : Math.max(0, v) / max * 100;
        const anom = r.anom == null ? "" : `<small>${E.variable === "lluvia" ? sig(r.anom, 0) + " %" : sig(r.anom, 1) + " °C"}</small>`;
        return `<div class="lp-prov"><div class="lp-prov-n"><b>${esc(r.nombre)}</b><small>${esc(r.region || "")}</small></div>
          <div class="lp-esp"><i style="width:${ancho}%;background:${c}"></i></div>
          <div class="lp-prov-v">${v == null ? "—" : num(v, es.dec) + " " + es.unidad}${anom}</div></div>`;
      }).join("")}</div>`;
    }
    filas.sort((a, b) => (b.anom ?? -1e9) - (a.anom ?? -1e9));
    const maxAbs = Math.max(1e-9, ...filas.map(r => Math.abs(r.anom ?? 0)));
    return `<div class="lp-prov-lista">${filas.map(r => {
      const v = r.anom, k = claseDe(es, v), c = k == null ? "transparent" : es.colores[k];
      const ancho = v == null ? 0 : Math.abs(v) / maxAbs * 50;
      const lado = v >= 0 ? `left:50%;width:${ancho}%` : `left:${50 - ancho}%;width:${ancho}%`;
      const extra = E.variable === "lluvia" && r.mm != null ? `<small>${sig(r.mm, 0)} mm</small>` : "";
      return `<div class="lp-prov"><div class="lp-prov-n"><b>${esc(r.nombre)}</b><small>${esc(r.region || "")}</small></div>
        <div class="lp-div"><i style="${lado};background:${c}"></i></div>
        <div class="lp-prov-v">${v == null ? "—" : (es.signo ? sig(v, es.dec) : num(v, es.dec))}${E.variable === "lluvia" ? " %" : " °C"}${extra}</div></div>`;
    }).join("")}</div>`;
  }

  /* ---------------- pestaña Estacional ---------------- */
  function kpisHTML(ind, per) {
    const k = (ind.kpis || {})[per] || {};
    const n = ind.nino || {};
    const t = (cls, et, v, sub) => `<div class="hm-kpi ${cls}"><span class="hm-kpi-et">${esc(et)}</span>` +
      `<span class="hm-kpi-v">${v}</span><span class="hm-kpi-s">${esc(sub || "")}</span></div>`;
    const tonoLl = k.lluvia_pct == null ? "" : k.lluvia_pct >= 15 ? "info" : k.lluvia_pct <= -15 ? "aviso" : "";
    const tonoT = k.t2m == null ? "" : k.t2m >= 1 ? "peligro" : k.t2m >= 0.5 ? "aviso" : "";
    const nino = (clave, et) => {
      const x = n[clave];
      if (!x) return t("", et, "—", "sin pluma");
      const tono = Math.abs(x.pico_valor) >= 1.5 ? "peligro" : Math.abs(x.pico_valor) >= 0.5 ? "aviso" : "";
      return t(tono, `${et} · pico ${etMes(x.pico_mes)}`, `${sig(x.pico_valor, 1)}<small>°C</small>`, x.pico_categoria || "");
    };
    return `<div class="hm-kpis lp-kpis">
      ${t(tonoLl, "Lluvia · promedio nacional", k.lluvia_pct == null ? "—" : `${sig(k.lluvia_pct, 0)}<small>%</small>`, "frente a lo normal del modelo")}
      ${t(tonoT, "Temperatura · promedio nacional", k.t2m == null ? "—" : `${sig(k.t2m, 1)}<small>°C</small>`, "anomalía de la temperatura a 2 m")}
      ${ind.terciles && k.pct_area_lluvia_sobre != null ? t("info", "Área con lluvia sobre lo normal", `${num(k.pct_area_lluvia_sobre)}<small>%</small>`, "como categoría más probable") : ""}
      ${nino("nino12", "Niño 1+2")}
      ${nino("nino34", "Niño 3.4")}
    </div>`;
  }
  const MESES_C = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
  function etMes(iso) {
    const m = /^(\d{4})-(\d{2})/.exec(String(iso || ""));
    return m ? `${MESES_C[+m[2] - 1]} ${m[1]}` : String(iso || "");
  }

  async function tabEstacional(c) {
    E._alTema = null;
    let ind;
    try { ind = await indice(); }
    catch (e) { c.innerHTML = vacio("Todavía no hay pronóstico estacional publicado.", e.message); return; }
    if (!ind || !ind.disponible || !(ind.periodos || []).length) {
      c.innerHTML = vacio("Todavía no hay pronóstico estacional publicado.", (App.textosServidor(ind && ind.avisos) || []).join(" "));
      return;
    }
    if (!E.periodo || !ind.periodos.some(p => p.id === E.periodo)) E.periodo = ind.periodos[0].id;
    try { E.provincias = await archivo(ind.archivos.provincias); } catch (e) { E.provincias = null; }
    const meses = ind.periodos.filter(p => p.tipo === "mes");
    const trims = ind.periodos.filter(p => p.tipo === "trimestre");
    const avisos = App.textosServidor(ind.avisos || []);
    c.innerHTML = `<div class="lp">
      <div data-rol="kpis"></div>
      <div class="hm-controles lp-barra">
        <div class="campo-inline"><span class="lp-et">Periodo</span>
          <div class="segmentado lp-seg" data-rol="periodo">
            ${meses.map(p => `<button type="button" data-per="${esc(p.id)}" title="${esc(p.etiqueta_larga)}">${esc(p.etiqueta)}</button>`).join("")}
          </div>
          ${trims.length ? `<div class="segmentado lp-seg" data-rol="periodo">${trims.map(p => `<button type="button" data-per="${esc(p.id)}" title="${esc(p.etiqueta_larga)}">${esc(p.etiqueta)}</button>`).join("")}</div>` : ""}
        </div>
        <span class="sep"></span>
        <div class="campo-inline"><span class="lp-et">Variable</span>
          <div class="segmentado lp-seg" data-rol="variable">
            <button type="button" data-var="lluvia">Lluvia</button><button type="button" data-var="t2m">Temperatura</button></div></div>
        <div class="campo-inline"><span class="lp-et">Producto</span>
          <div class="segmentado lp-seg" data-rol="producto">
            <button type="button" data-prod="esperado">Valor esperado</button>
            <button type="button" data-prod="anomalia">Anomalía</button>
            <button type="button" data-prod="probabilidad" ${ind.terciles ? "" : "disabled title='Sin terciles en esta emisión'"}>Probabilidad</button></div></div>
      </div>
      <div class="lp-grid">
        <section class="lp-card lp-mapa-card">
          <header class="lp-card-cab"><h2 data-rol="tit"></h2><span data-rol="sub"></span></header>
          <div class="lp-mapa" data-rol="mapa"></div>
          <div data-rol="ley"></div>
        </section>
        <section class="lp-card lp-prov-card">
          <header class="lp-card-cab"><h2>Por provincia</h2><span data-rol="prov-sub"></span></header>
          <div data-rol="prov"></div>
        </section>
      </div>
      <section class="lp-card lp-evol">
        <header class="lp-card-cab"><h2>Mes a mes</h2><span>La misma escala en todos: toca un mes para verlo en grande</span></header>
        <div class="lp-minis" data-rol="minis"></div>
      </section>
      ${avisos.length ? `<div class="lp-avisos">${avisos.map(a => `<p>${esc(a)}</p>`).join("")}</div>` : ""}
    </div>`;

    const $ = s => c.querySelector(s);
    const marcar = () => {
      c.querySelectorAll('[data-rol="periodo"] button').forEach(b => b.classList.toggle("activo", b.dataset.per === E.periodo));
      c.querySelectorAll('[data-rol="variable"] button').forEach(b => b.classList.toggle("activo", b.dataset.var === E.variable));
      c.querySelectorAll('[data-rol="producto"] button').forEach(b => b.classList.toggle("activo", b.dataset.prod === E.producto));
    };
    const dibujar = async () => {
      marcar();
      const per = ind.periodos.find(p => p.id === E.periodo) || ind.periodos[0];
      const es = ESCALAS[claveEscala()];
      $('[data-rol="kpis"]').innerHTML = kpisHTML(ind, per.id);
      $('[data-rol="tit"]').textContent = `${es.titulo} · ${per.etiqueta_larga}`;
      $('[data-rol="sub"]').textContent = E.producto === "probabilidad"
        ? "Probabilidad de quedar bajo, en o sobre lo normal (terciles 1993-2016)"
        : E.producto === "esperado"
          ? (E.variable === "lluvia"
            ? (per.tipo === "trimestre" ? "Milímetros por mes, promedio del trimestre" : "Milímetros en el mes")
            : "Promedio del periodo, con el detalle del relieve")
          : (E.variable === "lluvia" ? "Diferencia con la lluvia normal del modelo" : "Diferencia con la temperatura normal del modelo");
      $('[data-rol="ley"]').innerHTML = leyendaHTML(es);
      $('[data-rol="prov-sub"]').textContent = E.producto === "probabilidad" ? "bajo · normal · sobre lo normal" : per.etiqueta;
      $('[data-rol="prov"]').innerHTML = htmlProvincias(per.id);
      const mapa = $('[data-rol="mapa"]');
      // Valor esperado: el mapa grande usa la malla fina del periodo (si no llega, la de 0,1°).
      let detalle = null;
      const rutaDet = E.producto === "esperado" && per.detalle && per.detalle[es.campo];
      if (rutaDet) { try { detalle = await archivo(rutaDet); } catch (e) { detalle = null; } }
      try { await pintarMapa(mapa, await archivo(per.archivo), { detalle }); }
      catch (e) { mapa.innerHTML = vacio("No se pudo leer este periodo.", e.message); }
      // mes a mes (solo meses), con el periodo activo resaltado
      const minis = $('[data-rol="minis"]');
      minis.innerHTML = meses.map(p => `<button type="button" class="lp-mini${p.id === per.id ? " activo" : ""}" data-per="${esc(p.id)}">
        <div class="lp-mini-mapa"></div><span>${esc(p.etiqueta)}</span></button>`).join("");
      minis.querySelectorAll(".lp-mini").forEach(b => { b.onclick = () => { E.periodo = b.dataset.per; dibujar(); }; });
      for (const b of minis.querySelectorAll(".lp-mini")) {
        const p = meses.find(x => x.id === b.dataset.per);
        try { await pintarMapa(b.querySelector(".lp-mini-mapa"), await archivo(p.archivo), { mini: true }); }
        catch (e) { /* un mes sin archivo deja su hueco */ }
      }
    };
    c.querySelectorAll('[data-rol="periodo"] button').forEach(b => { b.onclick = () => { E.periodo = b.dataset.per; dibujar(); }; });
    c.querySelectorAll('[data-rol="variable"] button').forEach(b => { b.onclick = () => { E.variable = b.dataset.var; dibujar(); }; });
    c.querySelectorAll('[data-rol="producto"] button').forEach(b => { b.onclick = () => { if (!b.disabled) { E.producto = b.dataset.prod; dibujar(); } }; });
    E._alTema = () => { if (c.isConnected) dibujar(); };
    await dibujar();
  }

  /* ---------------- pestaña El Niño ---------------- */
  const COLOR_PRINCIPAL = "#4C8DFF";
  function colorCategoria(nombre) {
    const s = String(nombre || "").toLowerCase();
    if (/extraordinaria|muy fuerte/.test(s)) return "rgba(185,28,28,.16)";
    if (/fuerte/.test(s) && !/fría|niña/.test(s)) return "rgba(234,88,12,.13)";
    if (/moderad/.test(s) && !/fría|niña/.test(s)) return "rgba(245,158,11,.11)";
    if (/débil/.test(s) && !/fría|niña/.test(s)) return "rgba(250,204,21,.09)";
    if (/fría|niña/.test(s)) return "rgba(59,130,246,.10)";
    return "rgba(148,163,184,.06)";
  }
  async function pintarPluma(host, clave, nino) {
    const idx = nino.indices[clave];
    const meses = nino.meses || [];
    const trazas = [];
    const obs = (idx.observado || []).filter(o => o && o.mes && o.valor != null);
    const osc = oscuro();
    // miembros del modelo principal (tenues) y su banda P10–P90. En el visor publicado
    // el centro llega como «principal»; en la aplicación, con su código.
    const esPrincipal = s => s.centro === "principal" || s.centro === "ecmwf";
    const ec = (nino.sistemas || []).find(esPrincipal);
    if (ec && ec.indices[clave]) {
      const r = ec.indices[clave].resumen;
      trazas.push({ x: meses, y: r.p90, mode: "lines", line: { width: 0 }, hoverinfo: "skip", showlegend: false });
      trazas.push({ x: meses, y: r.p10, mode: "lines", line: { width: 0 }, fill: "tonexty",
        fillcolor: "rgba(76,141,255,.18)", name: "Modelo principal · banda 10–90 %", hoverinfo: "skip" });
      (ec.indices[clave].miembros || []).slice(0, 51).forEach(m => trazas.push({ x: meses, y: m, mode: "lines",
        line: { width: 0.6, color: "rgba(76,141,255,.22)" }, hoverinfo: "skip", showlegend: false }));
    }
    // Los demás modelos, en UN color y con UNA entrada de leyenda: se leen como la
    // dispersión entre modelos. Sin nombres: la vista no dice de dónde sale cada uno.
    let primeroOtro = true;
    for (const s of (nino.sistemas || [])) {
      const r = s.indices[clave] && s.indices[clave].resumen;
      if (!r || esPrincipal(s)) continue;
      trazas.push({ x: meses, y: r.p50, mode: "lines", name: "Otros modelos · mediana", legendgroup: "otros",
        showlegend: primeroOtro, line: { width: 1.6, color: osc ? "rgba(203,213,225,.55)" : "rgba(71,85,105,.55)" },
        hovertemplate: `Otro modelo (${s.miembros} miembros): %{y:+.1f} °C<extra></extra>` });
      primeroOtro = false;
    }
    if (ec && ec.indices[clave]) {
      trazas.push({ x: meses, y: ec.indices[clave].resumen.p50, mode: "lines+markers", name: "Modelo principal · mediana",
        line: { width: 3.2, color: COLOR_PRINCIPAL }, marker: { size: 6 },
        hovertemplate: `<b>Modelo principal</b> (${ec.miembros} miembros): %{y:+.1f} °C<extra></extra>` });
    }
    if (obs.length) {
      trazas.push({ x: obs.map(o => o.mes), y: obs.map(o => o.valor), mode: "lines+markers", name: "Observado",
        line: { width: 2.6, color: osc ? "#E9EFF8" : "#0B1426" }, marker: { size: 6 },
        hovertemplate: `<b>Observado</b> %{x|%b %Y}: %{y:+.2f} °C<extra></extra>` });
    }
    const todos = trazas.flatMap(t => (t.y || [])).filter(v => v != null && isFinite(v));
    const ymin = Math.min(-1, ...todos) - 0.4, ymax = Math.max(1.5, ...todos) + 0.4;
    const shapes = (idx.categorias || []).map(cat => ({ type: "rect", xref: "paper", x0: 0, x1: 1, yref: "y",
      y0: Math.max(cat.desde, ymin), y1: Math.min(cat.hasta, ymax), fillcolor: colorCategoria(cat.nombre),
      line: { width: 0 }, layer: "below" })).filter(s => s.y1 > s.y0);
    // Rótulos de categoría FUERA del área de datos (margen derecho): no tapan curvas.
    const anots = (idx.categorias || []).filter(cat => cat.hasta > ymin && cat.desde < ymax
        && (Math.min(cat.hasta, ymax) - Math.max(cat.desde, ymin)) >= (ymax - ymin) * 0.045).map(cat => ({
      xref: "paper", x: 1.012, xanchor: "left", yref: "y", y: (Math.max(cat.desde, ymin) + Math.min(cat.hasta, ymax)) / 2,
      text: cat.nombre, showarrow: false, font: { size: 10, color: osc ? "#95A3BB" : "#56647C" } }));
    if (meses.length) shapes.push({ type: "line", xref: "x", x0: meses[0], x1: meses[0], yref: "paper", y0: 0, y1: 1,
      line: { color: osc ? "#6F7E98" : "#8592A8", width: 1.4, dash: "dot" } });
    shapes.push({ type: "line", xref: "paper", x0: 0, x1: 1, yref: "y", y0: 0, y1: 0, line: { color: osc ? "#33435F" : "#C9D3E1", width: 1 } });
    const layout = App.plotlyLayoutSerie("", {
      height: 420, hovermode: "x unified", shapes, annotations: anots,
      margin: { l: 52, r: 128, t: 14, b: 40 },
      legend: { orientation: "h", y: -0.13, x: 0, font: { size: 11 } }, showlegend: true,
      xaxis: { type: "date", tickformat: "%b %y" }, yaxis: { title: { text: "anomalía °C", font: { size: 11 } }, range: [ymin, ymax], zeroline: false },
    });
    await Plotly.react(host, trazas, layout, App.plotlyConfig({ displayModeBar: false }));
  }

  async function tabNino(c) {
    E._alTema = null;
    let ind, nino;
    try { ind = await indice(); nino = await archivo((ind.archivos || {}).nino || "nino.json"); }
    catch (e) { c.innerHTML = vacio("Todavía no hay pluma de El Niño publicada.", e.message); return; }
    const n = ind.nino || {};
    const tarjeta = (clave) => {
      const x = n[clave], idx = nino.indices[clave];
      const obs = (idx.observado || []).slice(-1)[0];
      return `<div class="lp-nino-dato">
        <div class="lp-nino-tit">${esc(idx.nombre)}</div>
        <div class="lp-nino-fila"><span>Último observado${obs ? ` (${esc(etMes(obs.mes))})` : ""}</span><b>${obs ? sig(obs.valor, 1) + " °C" : "—"}</b></div>
        <div class="lp-nino-fila"><span>Pico pronosticado${x ? ` (${esc(etMes(x.pico_mes))})` : ""}</span><b>${x ? sig(x.pico_valor, 1) + " °C" : "—"}</b></div>
        <div class="lp-nino-cat">${esc((x && x.pico_categoria) || "")}</div></div>`;
    };
    c.innerHTML = `<div class="lp">
      <div class="lp-nino-cab">${tarjeta("nino12")}${tarjeta("nino34")}
        <p class="lp-nota">La mediana de cada modelo, la banda 10–90 % y los miembros del modelo principal, y la
        temperatura del mar observada. El Niño 1+2, frente a Ecuador y Perú, manda en la lluvia de la costa; el 3.4, en
        el Pacífico central, define el evento a escala global. Las franjas de color son categorías de referencia.</p></div>
      <div class="lp-grid2">
        <section class="lp-card"><header class="lp-card-cab"><h2>Niño 1+2</h2><span>0–10°S, 90–80°O</span></header><div class="lp-pluma" data-rol="n12"></div></section>
        <section class="lp-card"><header class="lp-card-cab"><h2>Niño 3.4</h2><span>5°N–5°S, 170–120°O</span></header><div class="lp-pluma" data-rol="n34"></div></section>
      </div>
    </div>`;
    const dibujar = async () => {
      await pintarPluma(c.querySelector('[data-rol="n12"]'), "nino12", nino);
      await pintarPluma(c.querySelector('[data-rol="n34"]'), "nino34", nino);
    };
    E._alTema = () => { if (c.isConnected) dibujar(); };
    await dibujar();
  }

  function vacio(titulo, detalle) {
    return `<div class="vacio"><div class="icono" aria-hidden="true">◌</div><strong>${esc(titulo)}</strong>` +
      (detalle ? `<span>${esc(detalle)}</span>` : "") + `</div>`;
  }

  if (typeof App === "object" && App && App.registrar) App.registrar("largo", {
    titulo: "Largo plazo", orden: 2,
    alDejar() {
      E._alTema = null;
      if (!window.Plotly) return;
      document.querySelectorAll("#vista .js-plotly-plot").forEach(el => { try { Plotly.purge(el); } catch (e) { /* ya purgado */ } });
    },
    async render(vista) {
      vista.dataset.screenLabel = "Largo plazo";
      E.indice = null; E.archivos.clear();
      let sub = "Pronóstico estacional y El Niño";
      try {
        const ind = await indice();
        if (ind && ind.disponible && ind.emision) sub = `Pronóstico estacional y El Niño · emisión ${ind.emision.etiqueta}`;
      } catch (e) { /* la pestaña lo explica */ }
      E.tabs = App.vistaPestanas(vista, {
        titulo: "Largo plazo", sub, inicial: "estacional",
        pestanas: [
          { id: "estacional", etiqueta: "Estacional", render: tabEstacional },
          { id: "nino", etiqueta: "El Niño", render: tabNino },
        ],
      });
    },
  });

  // Superficie pura para las pruebas en Node.
  if (typeof module === "object" && module.exports) module.exports = Object.freeze({
    ESCALAS, rangoEscala, colorscaleDiscreta, claseDe, refinar,
  });
})();
