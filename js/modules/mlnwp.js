/* ============================================================
   ML-NWP — Validación ML-NWP (v13: pestaña de Pronóstico).
   Ya NO es un módulo con entrada en la nav: expone window.MLNWP =
   { render(container), alDejar() } y cartas.js lo monta como la
   pestaña "Series, validación e IA" del módulo Pronóstico.
   Acento: púrpura (--ml-purple). data-screen-label="ML-NWP".
   Arquitectura: App.api / App.tarea. Mapas con Plotly.
   Campos JSON confirmados leyendo app/rutas/mlnwp.py y los módulos
   app/modulos/mlnwp/{productos,validacion,estilo,glosario}.py.
   ============================================================ */
"use strict";

(() => {
  const esc = v => String(v ?? "").replace(/[&<>"']/g,
    c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const num = (v, nd = 1) => (v === null || v === undefined || Number.isNaN(v)) ? "—" : Number(v).toFixed(nd);
  const sgn = v => (v === null || v === undefined || Number.isNaN(v)) ? "—"
    : (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(Number(v)).toFixed(1);
  // La fecha ya se lee en el eje X y en el hover unificado. Repetirla en cada
  // punto convertía el gráfico en una nube de recuadros; la etiqueta estática
  // muestra únicamente el valor. La unidad permanece en el eje Y y el hover.
  const etiquetaValor = valor => `<b>${num(valor, 1)}</b>`;
  // Halo blanco tenue, sin borde ni sombra: contraste suficiente sobre barras y
  // franja futura sin parecer una tarjeta superpuesta.
  const ETIQUETA_BG = "rgba(255,255,255,.82)";
  const ETIQUETA_TEXTO = "#071326";
  const OPACIDAD_SKILL_MIN = 0.28;
  const OPACIDAD_SKILL_MAX = 0.92;
  function opacidadPorSkill(rating, score = null, oscuro = false) {
    const r = Number(rating);
    const s = Number(score);
    // rating es 1–10; score alternativo es 0–1. La ausencia cae al piso visible,
    // nunca oculta una serie. La curva es estrictamente monótona con el skill.
    const t = Number.isFinite(r)
      ? Math.max(0, Math.min(1, (r - 1) / 9))
      : (Number.isFinite(s) ? Math.max(0, Math.min(1, s)) : 0);
    const base = OPACIDAD_SKILL_MIN
      + (OPACIDAD_SKILL_MAX - OPACIDAD_SKILL_MIN) * Math.pow(t, 0.82);
    // En oscuro se eleva todo el rango sin alterar el orden ni saturar al recomendado.
    return Number(Math.min(oscuro ? 0.97 : OPACIDAD_SKILL_MAX,
      base + (oscuro ? 0.10 : 0)).toFixed(3));
  }
  const indiceRecomendadoModelos = modelos =>
    (modelos || []).findIndex(modelo => modelo && modelo.operacional);

  // Orden objetivo de barras de lluvia. La calificación validada (1–10) es la
  // fuente primaria; score/skill solo cubre artefactos antiguos que aún no
  // publicaban rating. Sin ninguna métrica, el nombre da un fallback estable:
  // nunca se usa el orden accidental de llegada de la respuesta.
  function ordenarModelosPorDesempeno(modelos) {
    const metrica = modelo => {
      const ratingCrudo = modelo && modelo.rating;
      const rating = (ratingCrudo === null || ratingCrudo === undefined
        || ratingCrudo === "") ? NaN : Number(ratingCrudo);
      if (Number.isFinite(rating)) return { prioridad: 2, valor: rating };
      const scoreCrudo = modelo && (modelo.score ?? modelo.skill);
      const score = (scoreCrudo === null || scoreCrudo === undefined
        || scoreCrudo === "") ? NaN : Number(scoreCrudo);
      if (Number.isFinite(score)) return { prioridad: 1, valor: score };
      return { prioridad: 0, valor: -Infinity };
    };
    return [...(modelos || [])].sort((a, b) => {
      const ma = metrica(a), mb = metrica(b);
      if (ma.prioridad !== mb.prioridad) return mb.prioridad - ma.prioridad;
      if (ma.valor !== mb.valor) return mb.valor - ma.valor;
      const na = String((a && a.modelo) || "");
      const nb = String((b && b.modelo) || "");
      return na < nb ? -1 : (na > nb ? 1 : 0);
    });
  }

  // Convierte el ranking mejor→peor en posiciones físicas izquierda→derecha.
  // Para cinco modelos, por ejemplo, los puestos quedan [4, 2, 1, 3, 5]:
  // el mejor ocupa el centro y los demás se alejan de forma alternada.
  function distribuirModelosCentroAfuera(modelos) {
    const ranking = ordenarModelosPorDesempeno(modelos);
    const n = ranking.length;
    const posiciones = [];
    if (n % 2) {
      const centro = Math.floor(n / 2);
      posiciones.push(centro);
      for (let distancia = 1; posiciones.length < n; distancia += 1) {
        posiciones.push(centro - distancia);
        if (posiciones.length < n) posiciones.push(centro + distancia);
      }
    } else {
      const centroIzq = n / 2 - 1;
      const centroDer = n / 2;
      for (let distancia = 0; posiciones.length < n; distancia += 1) {
        posiciones.push(centroIzq - distancia);
        if (posiciones.length < n) posiciones.push(centroDer + distancia);
      }
    }
    const visual = ranking.map((modelo, ordenDesempeno) => ({
      modelo, ordenDesempeno, posicion: posiciones[ordenDesempeno],
    })).sort((a, b) => a.posicion - b.posicion);
    return { ranking, visual };
  }

  function distribuirRankingCentroAfuera(ranking) {
    const n = ranking.length;
    const posiciones = [];
    if (n % 2) {
      const centro = Math.floor(n / 2);
      posiciones.push(centro);
      for (let distancia = 1; posiciones.length < n; distancia += 1) {
        posiciones.push(centro - distancia);
        if (posiciones.length < n) posiciones.push(centro + distancia);
      }
    } else {
      const centroIzq = n / 2 - 1, centroDer = n / 2;
      for (let distancia = 0; posiciones.length < n; distancia += 1) {
        posiciones.push(centroIzq - distancia);
        if (posiciones.length < n) posiciones.push(centroDer + distancia);
      }
    }
    return ranking.map((modelo, ordenDesempeno) => ({
      modelo, ordenDesempeno, posicion: posiciones[ordenDesempeno],
    })).sort((a, b) => a.posicion - b.posicion);
  }

  // Acento del módulo y colores de modelos de la cabecera de la tabla/leyenda.
  /* ---------------- PNG portable de series por estación ----------------
     La figura descargable es un entregable de papel independiente del tema y
     del ancho del dispositivo. No se captura el DOM: se reconstruye en un
     lienzo Plotly exacto para que móvil y escritorio produzcan los mismos
     2310×1144 px, sin recorte automático ni padding externo. */
  const PNG_SERIE = Object.freeze({
    width: 2310, height: 1144, dpi: 220,
    paper: "#FFFFFF", title: "#1B3A6B", metadata: "#5F6B76",
    observation: "#303030", frame: "#555555", credit: "#A0A0A0",
    font: "Calibri, Carlito, Liberation Sans, DejaVu Sans, Arial, sans-serif",
    legendFont: "DejaVu Sans, Arial, sans-serif",
  });
  const PALETA_MODELOS_PNG = Object.freeze([
    "#0072B2", "#D55E00", "#009E73", "#CC79A7", "#E69F00",
    "#56B4E9", "#8A2BE2", "#DC267F", "#648FFF", "#785EF0",
    "#FE6100", "#00A9A5", "#A6761D", "#B33DC6", "#E41A1C",
    "#377EB8", "#4DAF4A", "#984EA3", "#FF7F00", "#F781BF",
  ]);
  const DIA_MS = 86400000;
  const pxDesdePt = puntos => Number((Number(puntos) * PNG_SERIE.dpi / 72).toFixed(3));
  const esFinito = valor => valor !== null && valor !== undefined
    && valor !== "" && Number.isFinite(Number(valor));
  const scoreModeloPNG = modelo => {
    const bruto = modelo && (modelo.model_score ?? modelo.rating);
    return esFinito(bruto) ? Math.max(1, Math.min(10, Number(bruto))) : null;
  };
  const claveModeloPNG = modelo => String(
    (modelo && (modelo.model_key ?? modelo.modelo)) || "").trim();

  function colorModeloPNG(modelo) {
    const clave = claveModeloPNG(modelo);
    let suma = 0;
    Array.from(clave).forEach((caracter, i) => {
      suma += (i + 1) * caracter.codePointAt(0);
    });
    return PALETA_MODELOS_PNG[
      ((suma % PALETA_MODELOS_PNG.length) + PALETA_MODELOS_PNG.length)
      % PALETA_MODELOS_PNG.length
    ];
  }

  function seleccionarModelosPNG(modelos, inicio, fin, maximo = 7) {
    const candidatos = (modelos || []).map((modelo, indice) => ({
      modelo, indice, clave: claveModeloPNG(modelo), score: scoreModeloPNG(modelo),
    })).filter(item => {
      if (!item.clave) return false;
      const fechas = item.modelo.fechas || [];
      const valores = item.modelo.valores || [];
      return fechas.some((fecha, i) => fecha >= inicio && fecha <= fin
        && esFinito(valores[i]));
    });
    // Membresía: calificados primero, score descendente, orden de entrada estable
    // y clave como último desempate reproducible.
    candidatos.sort((a, b) => {
      const ca = a.score !== null, cb = b.score !== null;
      if (ca !== cb) return ca ? -1 : 1;
      if (ca && a.score !== b.score) return b.score - a.score;
      if (a.indice !== b.indice) return a.indice - b.indice;
      return a.clave.localeCompare(b.clave);
    });
    const miembros = candidatos.slice(0, Math.max(0, maximo));
    // Presentación final: score descendente y clave estable; s/d siempre después.
    miembros.sort((a, b) => {
      const ca = a.score !== null, cb = b.score !== null;
      if (ca !== cb) return ca ? -1 : 1;
      if (ca && a.score !== b.score) return b.score - a.score;
      return a.clave.localeCompare(b.clave);
    });
    return miembros.map(item => item.modelo);
  }

  function opacidadModeloPNG(modelo, rango, total, temperatura = false) {
    const score = scoreModeloPNG(modelo);
    // Sin nota se usa únicamente la posición del modelo, como respaldo visual;
    // la leyenda conserva "s/d" y nunca fabrica una calificación.
    const calidad = score === null
      ? Math.max(0, Math.min(1, (Math.max(1, total) - rango) / (Math.max(1, total) + 1)))
      : Math.max(0, Math.min(1, (score - 1) / 9));
    const visual = Math.pow(calidad, 2.15);
    const alpha = temperatura
      ? Math.max(0.07, Math.min(0.92, 0.07 + 0.85 * visual))
      : Math.max(0.06, Math.min(0.92, 0.06 + 0.86 * visual));
    return Number(alpha.toFixed(4));
  }

  function fechaMs(fecha) {
    const valor = new Date(`${fecha}T00:00:00Z`).getTime();
    return Number.isFinite(valor) ? valor : null;
  }

  function nombreSeguroPNG(valor, respaldo, conservarGuion = false) {
    const normalizado = String(valor || "").normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");
    const patron = conservarGuion ? /[^A-Za-z0-9_-]+/g : /[^A-Za-z0-9]+/g;
    return normalizado.replace(patron, "_").replace(/^_+|_+$/g, "") || respaldo;
  }

  function nombreArchivoSeriePNG(meta, variable, probabilistico = false) {
    const codigo = nombreSeguroPNG(meta.codigo, "estacion", true);
    const nombre = nombreSeguroPNG(meta.nombre, "sin_nombre");
    const sufijo = probabilistico ? "probabilistico"
      : variable === "tmax" ? "tmax"
      : variable === "tmin" ? "tmin" : "precipitacion";
    return `${codigo}_${nombre}__${sufijo}.png`;
  }

  function metadatosFiguraPNG(meta, variableLabel, agregacionLabel) {
    const codigo = String(meta.codigo || "—");
    const complejo = String(
      meta.complex_name ?? meta.complejo ?? meta.nombre_complejo ?? "").trim();
    const identidad = [`Estación ${codigo}`];
    if (complejo && !/^(s\/?a|n\/?a|no asignado)$/i.test(complejo))
      identidad.push(`Complejo ${complejo}`);
    identidad.push([variableLabel, agregacionLabel].filter(Boolean).join(" · "));
    const geografia = [];
    if (esFinito(meta.lat)) geografia.push(`Lat. ${Number(meta.lat).toFixed(4)}°`);
    if (esFinito(meta.lon)) geografia.push(`Lon. ${Number(meta.lon).toFixed(4)}°`);
    if (esFinito(meta.altitud_m))
      geografia.push(`Alt. ${Math.round(Number(meta.altitud_m))} m`);
    return {
      titulo: String(meta.nombre || meta.codigo || "Estación"),
      identidad: identidad.filter(Boolean).join("  ·  "),
      geografia: geografia.join("  ·  "),
    };
  }

  function anotacionesCabeceraPNG(meta, variableLabel, agregacionLabel) {
    const texto = metadatosFiguraPNG(meta, variableLabel, agregacionLabel);
    const comun = { xref: "paper", yref: "paper", showarrow: false,
      xanchor: "center", align: "center" };
    const salida = [
      { ...comun, x: 0.5, y: 0.955, yanchor: "middle", text: `<b>${esc(texto.titulo)}</b>`,
        font: { family: PNG_SERIE.font, size: pxDesdePt(27.75), color: PNG_SERIE.title } },
      { ...comun, x: 0.5, y: 0.869, yanchor: "top", text: `<i>${esc(texto.identidad)}</i>`,
        font: { family: PNG_SERIE.font, size: pxDesdePt(14.4), color: PNG_SERIE.metadata } },
    ];
    if (texto.geografia) salida.push(
      { ...comun, x: 0.5, y: 0.803, yanchor: "top",
        text: `<i>${esc(texto.geografia)}</i>`,
        font: { family: PNG_SERIE.font, size: pxDesdePt(14.4), color: PNG_SERIE.metadata } },
    );
    salida.push({
      xref: "paper", yref: "paper", x: 0.014, y: 0.105, showarrow: false,
      xanchor: "left", yanchor: "bottom", text: "<i>Elaborado por M.G.</i>",
      font: { family: PNG_SERIE.font, size: pxDesdePt(10.2), color: PNG_SERIE.credit },
      opacity: 0.88,
    });
    return salida;
  }

  function figuraTemporalPNG(d, contexto) {
    const meta = contexto.meta || d;
    const hoy = contexto.hoyVisual || d.hoy;
    const fechasEje = [...(contexto.ejeFechas || [])];
    if (!hoy || !fechasEje.length) return null;
    const inicio = fechasEje[0], fin = fechasEje[fechasEje.length - 1];
    const esPrecip = !!d.es_precip;
    const modelos = seleccionarModelosPNG(d.modelos, inicio, fin, 7);
    if (!modelos.length) return null;
    const obsFechas = (d.observado && d.observado.fechas) || [];
    const obsValores = (d.observado && d.observado.valores) || [];
    const hayObs = obsFechas.some((fecha, i) => fecha >= inicio && fecha <= fin
      && esFinito(obsValores[i]));
    // Tmax/Tmin solo son exportables cuando existe observación local.
    if (!esPrecip && !hayObs) return null;
    const trazas = [];
    const anotaciones = anotacionesCabeceraPNG(
      meta, contexto.variableLabel, contexto.agregacionLabel);
    const valoresY = [];
    const recortarLluvia = valor => esPrecip && esFinito(valor)
      ? Math.max(0, Number(valor)) : (esFinito(valor) ? Number(valor) : null);
    const rangoModelo = new Map(modelos.map((modelo, i) => [modelo, i]));
    const visuales = esPrecip
      ? distribuirRankingCentroAfuera(modelos)
      : modelos.map((modelo, i) => ({ modelo, ordenDesempeno: i, posicion: i }));

    for (const item of visuales) {
      const modelo = item.modelo;
      const rango = rangoModelo.get(modelo);
      const color = colorModeloPNG(modelo);
      const alpha = opacidadModeloPNG(modelo, rango, modelos.length, !esPrecip);
      const fechas = [], valores = [];
      (modelo.fechas || []).forEach((fecha, i) => {
        if (fecha < inicio || fecha > fin) return;
        fechas.push(fecha);
        const valor = recortarLluvia((modelo.valores || [])[i]);
        valores.push(valor);
        if (valor !== null) valoresY.push(valor);
        // Presente/futuro: únicamente los tres mejores, nunca los primeros
        // accidentales de la respuesta.
        if (rango < 3 && fecha >= hoy && valor !== null) {
          anotaciones.push({
            xref: "x", yref: "y", x: fecha, y: valor, showarrow: false,
            text: `<b>${valor.toFixed(1)}</b>`, textangle: esPrecip ? 90 : 0,
            xanchor: "center", yanchor: "bottom",
            yshift: esPrecip
              ? [2, 4, 6].map(pxDesdePt)[rango]
              : [2, 7, 12].map(pxDesdePt)[rango],
            bgcolor: "rgba(255,255,255,.72)", bordercolor: color,
            borderwidth: pxDesdePt(0.22), borderpad: pxDesdePt(0.10),
            font: { family: PNG_SERIE.font,
              size: pxDesdePt(esPrecip ? 6.225 : 6.525),
              color: "#1B1B1B" },
          });
        }
      });
      if (esPrecip) {
        trazas.push({
          type: "bar", x: fechas, y: valores, name: claveModeloPNG(modelo),
          width: 0.070 * DIA_MS,
          marker: { color, line: { color: "#FFFFFF", width: pxDesdePt(0.16) } },
          opacity: alpha,
          offsetgroup: `png-lluvia-${String(item.posicion).padStart(2, "0")}`,
          alignmentgroup: "png-precipitacion-diaria",
          legendrank: rango + 1,
          zorder: 3 + 0.01 * (modelos.length - rango),
          hoverinfo: "skip",
        });
      } else {
        const score = scoreModeloPNG(modelo);
        const baseCalidad = score === null
          ? Math.max(0, (modelos.length - rango) / (modelos.length + 1))
          : Math.max(0, Math.min(1, (score - 1) / 9));
        const calidad = Math.pow(baseCalidad, 2.15);
        trazas.push({
          type: "scatter", mode: "lines+markers", x: fechas, y: valores,
          name: claveModeloPNG(modelo), opacity: alpha, connectgaps: false,
          line: { color, width: pxDesdePt(
            Math.max(0.45, Math.min(1.47, 0.45 + 1.02 * calidad))) },
          marker: { color, size: pxDesdePt(
            Math.max(1.05, Math.min(2.30, 1.05 + 1.25 * calidad))),
            symbol: "circle" },
          zorder: 3,
          hoverinfo: "skip",
        });
      }
    }

    if (hayObs) {
      const fechas = [], valores = [];
      obsFechas.forEach((fecha, i) => {
        if (fecha < inicio || fecha > fin) return;
        fechas.push(fecha);
        const valor = recortarLluvia(obsValores[i]);
        valores.push(valor);
        if (valor !== null) {
          valoresY.push(valor);
          anotaciones.push({
            xref: "x", yref: "y", x: fecha, y: valor, showarrow: false,
            text: `<b>${valor.toFixed(1)}</b>`, xanchor: "center", yanchor: "bottom",
            yshift: pxDesdePt(4), bgcolor: "rgba(255,255,255,.82)",
            bordercolor: "#CCCCCC", borderwidth: pxDesdePt(0.25),
            borderpad: pxDesdePt(0.12),
            font: { family: PNG_SERIE.font, size: pxDesdePt(7.2),
              color: PNG_SERIE.observation },
          });
        }
      });
      trazas.push({
        type: "scatter", mode: "lines+markers", x: fechas, y: valores,
        name: "Obs", connectgaps: false, opacity: 1,
        line: { color: PNG_SERIE.observation, width: pxDesdePt(1.05), dash: "dash" },
        marker: { color: PNG_SERIE.observation,
          size: pxDesdePt(esPrecip ? 2.7 : 2.8),
          symbol: "square" },
        zorder: 6,
        hoverinfo: "skip",
      });
    }

    const entradasLeyenda = [];
    if (hayObs) entradasLeyenda.push({ texto: "Obs", color: PNG_SERIE.observation,
      simbolo: "━" });
    modelos.forEach(modelo => {
      const score = scoreModeloPNG(modelo);
      entradasLeyenda.push({
        texto: `${claveModeloPNG(modelo)}\u2002${score === null ? "s/d" : score.toFixed(1)}`,
        color: colorModeloPNG(modelo), simbolo: esPrecip ? "■" : "━",
      });
    });
    const legendSize = pxDesdePt(entradasLeyenda.length >= 10 ? 8.45
      : entradasLeyenda.length >= 8 ? 8.75 : 9.05);
    entradasLeyenda.forEach((entrada, i) => {
      const x = 0.075 + ((i + 0.5) / entradasLeyenda.length) * (0.955 - 0.075);
      anotaciones.push({
        xref: "paper", yref: "paper", x, y: 0.727, showarrow: false,
        xanchor: "center", yanchor: "middle",
        text: `<span style="color:${entrada.color}">${entrada.simbolo}</span> ${esc(entrada.texto)}`,
        font: { family: PNG_SERIE.legendFont, size: legendSize, color: "#283550" },
      });
    });

    const min = valoresY.length ? Math.min(...valoresY) : 0;
    const max = valoresY.length ? Math.max(...valoresY) : (esPrecip ? 2 : 1);
    const extension = Math.max(0, max - min);
    const pad = esPrecip ? Math.max(2, extension * 0.14)
      : Math.max(1.2, extension * 0.16);
    const rangoY = esPrecip
      ? [Math.max(0, min - pad), max + pad]
      : [min - pad, max + pad];
    const inicioMs = fechaMs(inicio), finMs = fechaMs(fin);
    const xRange = [inicioMs - 0.62 * DIA_MS, finMs + 1.05 * DIA_MS];
    const shapes = [{
      type: "line", xref: "x", yref: "paper", x0: hoy, x1: hoy,
      y0: 0.190, y1: 0.700,
      line: { color: "#999999", width: pxDesdePt(0.8), dash: "dot" },
    }];
    const axisBase = {
      showline: true, mirror: true, linecolor: PNG_SERIE.frame,
      linewidth: pxDesdePt(0.68),
      ticks: "outside", tickcolor: PNG_SERIE.frame, tickwidth: pxDesdePt(0.68),
      zeroline: false, fixedrange: true, automargin: false,
    };
    return {
      width: PNG_SERIE.width, height: PNG_SERIE.height,
      filename: nombreArchivoSeriePNG(meta, d.variable, false),
      traces: trazas,
      layout: {
        width: PNG_SERIE.width, height: PNG_SERIE.height, autosize: false,
        paper_bgcolor: PNG_SERIE.paper, plot_bgcolor: PNG_SERIE.paper,
        margin: { l: 0, r: 0, t: 0, b: 0, pad: 0 },
        font: { family: PNG_SERIE.font, color: "#1B1B1B" },
        showlegend: false, hovermode: false,
        barmode: "group", bargap: 0.24, bargroupgap: 0.14,
        annotations: anotaciones, shapes,
        xaxis: { ...axisBase, domain: [0.075, 0.955], type: "date", range: xRange,
          tickmode: "array", tickvals: fechasEje,
          ticktext: fechasEje.map(fecha => `${fecha.slice(8, 10)}/${fecha.slice(5, 7)}`),
          tickfont: { family: PNG_SERIE.font, size: pxDesdePt(9.6), color: "#303030" },
          showgrid: !esPrecip, gridcolor: "rgba(80,80,80,.16)",
          gridwidth: pxDesdePt(0.45) },
        yaxis: { ...axisBase, domain: [0.190, 0.700], range: rangoY,
          title: { text: d.unidad || (esPrecip ? "mm" : "°C"),
            font: { family: PNG_SERIE.font, size: pxDesdePt(11.7), color: "#303030" },
            standoff: 10 },
          tickfont: { family: PNG_SERIE.font, size: pxDesdePt(9.75), color: "#303030" },
          showgrid: true, gridcolor: "rgba(80,80,80,.16)",
          gridwidth: pxDesdePt(0.45) },
      },
    };
  }

  function figuraProbabilidadesPNG(d, contexto) {
    const pu = d.probs_umbral;
    const meta = contexto.meta || d;
    const hoy = contexto.hoyVisual || d.hoy;
    const fechas = [...(contexto.ejeFechas || [])];
    if (!d.es_precip || !pu || !fechas.length || !hoy) return null;
    const obsFechas = (d.observado && d.observado.fechas) || [];
    const obsValores = (d.observado && d.observado.valores) || [];
    if (!obsFechas.some((fecha, i) => fechas.includes(fecha) && esFinito(obsValores[i])))
      return null;
    const indicesFecha = new Map(
      (pu.fechas || []).map((fecha, i) => [fecha, i]));
    const umbrales = (pu.umbrales || []).map(Number);
    const filasDef = [
      { valor: 0.1, label: "P(lluvia)" },
      { valor: 1, label: "P≥1mm" },
      { valor: 5, label: "P≥5mm" },
      { valor: 10, label: "P≥10mm" },
      { valor: 25, label: "P≥25mm" },
      { valor: 50, label: "P≥50mm" },
    ];
    const filas = filasDef.map(def => {
      const j = umbrales.findIndex(valor => Number.isFinite(valor)
        && Math.abs(valor - def.valor) <= 1e-9);
      const valores = fechas.map(fecha => {
        const i = indicesFecha.get(fecha);
        const bruto = i === undefined || j < 0 ? null : ((pu.probs || [])[i] || [])[j];
        return esFinito(bruto) ? Number(bruto) : null;
      });
      return { ...def, valores };
    }).filter(fila => fila.valores.some(esFinito));
    if (!filas.length) return null;

    const anotaciones = anotacionesCabeceraPNG(
      meta, "Precipitación probabilística", contexto.agregacionLabel);
    filas.forEach(fila => fila.valores.forEach((valor, i) => {
      if (!esFinito(valor)) return;
      const visible = Math.max(0, Math.min(100, Number(valor)));
      anotaciones.push({
        xref: "x", yref: "y", x: fechas[i], y: fila.label,
        showarrow: false, text: `<b>${visible.toFixed(0)}%</b>`,
        xanchor: "center", yanchor: "middle",
        font: { family: PNG_SERIE.font, size: pxDesdePt(7.875),
          color: visible >= 55 ? "#FFFFFF" : "#1B1B1B" },
      });
    }));
    const z = filas.map(fila => fila.valores);
    return {
      width: PNG_SERIE.width, height: PNG_SERIE.height,
      filename: nombreArchivoSeriePNG(meta, "precip", true),
      traces: [{
        type: "heatmap", x: fechas, y: filas.map(fila => fila.label), z,
        colorscale: "Blues", zmin: 0, zmax: 100, showscale: false,
        xgap: pxDesdePt(0.45), ygap: pxDesdePt(0.45),
        hoverinfo: "skip", connectgaps: false,
      }],
      layout: {
        width: PNG_SERIE.width, height: PNG_SERIE.height, autosize: false,
        paper_bgcolor: PNG_SERIE.paper,
        plot_bgcolor: "rgba(107,107,107,.85)",
        margin: { l: 0, r: 0, t: 0, b: 0, pad: 0 },
        font: { family: PNG_SERIE.font, color: "#1B1B1B" },
        showlegend: false, hovermode: false, annotations: anotaciones, shapes: [],
        xaxis: {
          domain: [0.095, 0.955], type: "date",
          range: [fechaMs(fechas[0]) - 0.5 * DIA_MS,
            fechaMs(fechas[fechas.length - 1]) + 0.5 * DIA_MS],
          tickmode: "array", tickvals: fechas,
          ticktext: fechas.map(fecha => `${fecha.slice(8, 10)}/${fecha.slice(5, 7)}`),
          tickfont: { family: PNG_SERIE.font, size: pxDesdePt(9.15), color: "#303030" },
          ticks: "outside", fixedrange: true, showgrid: false, zeroline: false,
          showline: true, mirror: true, linecolor: "#8A8A8A",
          linewidth: pxDesdePt(0.5),
        },
        yaxis: {
          domain: [0.190, 0.727], type: "category",
          categoryorder: "array", categoryarray: filas.map(fila => fila.label),
          autorange: "reversed",
          tickfont: { family: PNG_SERIE.font, size: pxDesdePt(9.45), color: "#303030" },
          ticks: "", fixedrange: true, showgrid: false, zeroline: false,
          showline: true, mirror: true, linecolor: "#8A8A8A",
          linewidth: pxDesdePt(0.5),
        },
      },
    };
  }

  async function descargarFiguraPNG(figura, boton) {
    if (!figura || !window.Plotly || typeof Plotly.toImage !== "function")
      throw new Error("La imagen no está disponible para esta selección.");
    const original = boton ? boton.textContent : "";
    if (boton) { boton.disabled = true; boton.textContent = "Preparando PNG…"; }
    const host = document.createElement("div");
    host.setAttribute("aria-hidden", "true");
    Object.assign(host.style, {
      position: "fixed", left: "-100000px", top: "0",
      width: `${figura.width}px`, height: `${figura.height}px`,
      opacity: "0", pointerEvents: "none", overflow: "hidden",
    });
    document.body.appendChild(host);
    try {
      await Plotly.newPlot(host, figura.traces, figura.layout, {
        staticPlot: true, displayModeBar: false, responsive: false,
      });
      const dataUrl = await Plotly.toImage(host, {
        format: "png", width: figura.width, height: figura.height, scale: 1,
      });
      const enlace = document.createElement("a");
      enlace.href = dataUrl;
      enlace.download = figura.filename;
      document.body.appendChild(enlace);
      enlace.click();
      enlace.remove();
      if (App.aviso) App.aviso(`PNG descargado: ${figura.filename}`, "ok", 5000);
    } finally {
      try { Plotly.purge(host); } catch (e) { /* figura temporal ya liberada */ }
      host.remove();
      if (boton) { boton.disabled = false; boton.textContent = original; }
    }
  }

  const MORADO = "#6A47CE", NAVY = "#0F2745";
  // Familia → clase visual del glosario.
  const FAM_CRUDO = ["GFS05", "ICON", "IFS025", "IFSHRES", "AIFS025", "METEOBLUE", "GEM15"];

  // VARIABLE (chip) → bloque de /validacion. Precipitación usa "cuantificación"
  // como bloque BASE (selector/serie); la tabla de clasificación añade ADEMÁS
  // la sección de DETECCIÓN (bloque precip_det: POD/FAR/CSI) — pedido del dueño.
  const VAR_A_BLOQUE = { precip: "precip_cua", tmax: "tmax", tmin: "tmin" };
  // Etiqueta de variable para Series (la ruta /series acepta precip|tmax|tmin).
  const VAR_SERIE = { precip: "precip", tmax: "tmax", tmin: "tmin" };
  // v18 (dueño 2026-07-10): el selector VENTANA se RETIRÓ de la UI.
  // - La serie temporal muestra SIEMPRE 10 días pasados + presente + todo el
  //   futuro disponible (lookback=10, producto ya congelado en el visor).
  // - La validación pública usa la misma ventana móvil de 10 fechas. El backtest
  //   completo se conserva únicamente en local.
  const LOOKBACK_SERIE = 10;
  const VENTANA_VALID = "10";

  // El eje visible es una ventana DIARIA continua. La base local puede conservar
  // historia probabilística anterior, pero mezclar esas fechas con los 10 días
  // operativos comprimía meses vacíos en la gráfica y desalineaba las columnas
  // de la tabla. Se conserva el archivo completo; solo se recorta su presentación.
  const FECHA_ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
  // Deben coincidir con --ml-axis-left/right de mlnwp.css: son también los
  // márgenes del área cartesiana de Plotly y las columnas de encaje de la tabla.
  const MARGEN_EJE_IZQ_PX = 58;
  const MARGEN_EJE_DER_PX = 20;
  function moverFechaISO(fecha, dias) {
    if (!FECHA_ISO_RE.test(String(fecha || ""))) return null;
    const d = new Date(`${fecha}T12:00:00Z`);
    if (!Number.isFinite(d.getTime())) return null;
    d.setUTCDate(d.getUTCDate() + Number(dias || 0));
    return d.toISOString().slice(0, 10);
  }
  function construirEjeDiarioVentana(fechas, hoy, lookback = LOOKBACK_SERIE) {
    const validas = [...new Set((fechas || [])
      .map(fecha => String(fecha || "").slice(0, 10))
      .filter(fecha => FECHA_ISO_RE.test(fecha)))].sort();
    const nPasado = Math.max(0, Number.isFinite(Number(lookback)) ? Number(lookback) : LOOKBACK_SERIE);
    const corte = moverFechaISO(hoy, -nPasado);
    const visibles = corte ? validas.filter(fecha => fecha >= corte) : validas;
    if (!visibles.length) return [];
    // Incluir el inicio exacto de la ventana hace visibles también los vacíos:
    // una fecha sin emisión ocupa su columna y muestra "—".
    const inicio = corte || visibles[0];
    const fin = visibles[visibles.length - 1];
    const salida = [];
    for (let fecha = inicio; fecha && fecha <= fin; fecha = moverFechaISO(fecha, 1)) {
      salida.push(fecha);
    }
    return salida;
  }
  function margenesEjeDesdeTicks(posiciones, ancho) {
    const xs = (posiciones || []).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
    const total = Number(ancho);
    if (xs.length < 2 || !Number.isFinite(total) || total <= 0) return null;
    const pasos = xs.slice(1).map((x, i) => x - xs[i]).filter(paso => paso > 0);
    if (!pasos.length) return null;
    pasos.sort((a, b) => a - b);
    const paso = pasos[Math.floor(pasos.length / 2)];
    const izquierda = xs[0] - paso / 2;
    const derecha = total - (xs[xs.length - 1] + paso / 2);
    if (![izquierda, derecha].every(v => Number.isFinite(v) && v >= 0)) return null;
    return { izquierda, derecha };
  }
  function sincronizarMargenesTabla(el, timeTrack) {
    if (!el || !timeTrack) return;
    const posiciones = [...el.querySelectorAll(".xtick")].map(tick => {
      const match = String(tick.getAttribute("transform") || "")
        .match(/translate\(([-+0-9.eE]+)/);
      return match ? Number(match[1]) : NaN;
    });
    const margenes = margenesEjeDesdeTicks(posiciones, el.clientWidth);
    if (!margenes) return;
    timeTrack.style.setProperty("--ml-axis-left", `${margenes.izquierda}px`);
    timeTrack.style.setProperty("--ml-axis-right", `${margenes.derecha}px`);
  }

  // Filtro de FAMILIA de modelo. valor = el que entiende el backend
  // (productos.FAMILIAS); etiqueta = texto del chip. "Todos" = sin filtro.
  const FAMILIAS_UI = [
    ["Todos", "Todo"], ["Convencionales", "Convencionales"], ["No convencionales", "No conv."],
    ["ML", "ML"], ["Postprocesamiento", "Post. estadístico"],
  ];
  const filtrarModelosFamilia = (modelos, familia) => {
    const lista = Array.isArray(modelos) ? modelos : [];
    if (!familia || familia === "Todos" || familia === "Mejor desempeño") return lista;
    return lista.filter(modelo => modelo && modelo.familia === familia);
  };
  // Tamaño del punto del MAPA por confianza (px de marcador Plotly). Borde blanco
  // UNIFORME (nunca color por confianza). Alta grande / Media medio / Baja pequeño.
  const TAM_CONF = { Alta: 15, Media: 11, Baja: 8, "Sin calificar": 6 };
  // Opacidad de la BARRA por confianza (Alta sólido / Media .72 / Baja .5).
  const OPACIDAD_CONF = { Alta: 1, Media: .72, Baja: .5, "Sin calificar": .35 };

  // Badge de calificación con color tipo semáforo (escala RdYlGn por nota 1-10).
  const RDYLGN = ["#D73027", "#F46D43", "#FDAE61", "#FEE08B", "#D9EF8B",
                  "#A6D96A", "#66BD63", "#1A9850"];
  function calColor(r) {
    if (r === null || r === undefined || Number.isNaN(r)) return (App.tema && App.tema() === "oscuro") ? ["#222F49", "#9DAABF"] : ["#F0F3F8", "#5A6678"];
    const t = Math.max(0, Math.min(1, (Number(r) - 1) / 9));
    const bg = RDYLGN[Math.min(RDYLGN.length - 1, Math.floor(t * RDYLGN.length))];
    // texto blanco solo en los extremos OSCUROS de la escala (rojo intenso y verde
    // intenso); en los tonos medios (amarillos/verdes claros) el blanco no contrasta.
    const fg = (bg === "#1A9850" || bg === "#D73027") ? "#fff" : "#1E1E1E";
    return [bg, fg];
  }
  const confClase = c => ({ Alta: "alta", Media: "media", Baja: "baja" }[c] || "sin");
  function pillConf(c) {
    return `<span class="ml-pill ${confClase(c)}">${esc(c || "Sin calificar")}</span>`;
  }

  // Riesgo → color (texto). Valores oficiales del diseño/escalas.
  const RIESGO_COLOR = { "Muy Alto": "#D62A23", "Alto": "#F08A24", "Medio": "#E0A91E", "No aplica": "#3DA4DD" };
  const riesgoColor = r => RIESGO_COLOR[r] || "var(--ink-2)";

  /* ---------------- estado del módulo ---------------- */
  // Redes SIEMPRE incluidas (los chips INAMHI/CELEC/Hidronación se retiraron a
  // pedido del dueño): el filtrado client-side por red se conserva internamente
  // para no romper los productos congelados, pero sin UI. La red de cada
  // estación sigue visible por fila en el combobox.
  const DEPS = ["INAMHI", "CELEC", "Hidronación"];

  const S = {
    ctx: null,
    variable: "precip",          // precip | tmax | tmin
    familia: "Todos",            // filtro de familia de modelo
    estacion: "",                // código de estación (v12: siempre por estación)
    valData: null,               // última respuesta de /validacion (alimenta el selector)
    geojson: null,
  };

  const depsQS = () => "deps=" + encodeURIComponent(DEPS.join(","));

  // Contador de generación: invalida respuestas async en vuelo cuando el usuario
  // cambia de ámbito/variable/ventana/familia/estación antes de que resuelvan
  // (App.api no cancela). El último cambio gana; los pares viejos se descartan.
  let gen = 0;

  /* ============================================================
     RENDER raíz: la vista vive como PESTAÑA dentro de Pronóstico —
     sin cabecera grande propia (kicker/h1) ni chips de dependencia;
     solo un sub-encabezado compacto.
     ============================================================ */
  function pintarRaiz(vista) {
    vista.innerHTML = `
      <div class="ml-raiz" data-screen-label="ML-NWP">
        <div class="ml-cab-mini">Validación NWP-ML · compara 41 modelos por estación · calificación 1–10 con confianza muestral</div>
        <div id="ml-cuerpo"></div>
      </div>`;
  }

  function cuerpo() { return document.getElementById("ml-cuerpo"); }
  const cargando = msg => `<div class="vacio"><div class="icono">⏳</div>${esc(msg || "Cargando…")}</div>`;
  const vacio = msg => `<div class="vacio"><div class="icono">∅</div>${esc(msg)}</div>`;

  // IDs de los gráficos Plotly del módulo. Plotly engancha un listener de window
  // 'resize' por gráfico (responsive:true) que SÓLO se libera con Plotly.purge,
  // nunca al quitar el div del DOM. Purgamos al salir del módulo y antes de cada
  // re-render de pestaña para no acumular instancias ni handlers en sesiones largas.
  const PLOTS = ["ml-plot-serie"];   // v12: ganador/mapas retirados con la vista Nacional
  function purgarPlots() {
    if (!window.Plotly) return;
    for (const id of PLOTS) {
      const el = document.getElementById(id);
      if (el) { try { Plotly.purge(el); } catch (e) { /* ya purgado */ } }
    }
  }

  function pintarTab() {
    purgarPlots();
    const c = cuerpo();
    if (!c) return;
    c.innerHTML = cargando();
    tabValidacion(c);   // v12: vista única (Mapas/Resumen retirados)
  }

  /* ============================================================
     PESTAÑA 1 — VALIDACIÓN
     ============================================================ */
  // v12: TODOS los selectores en UNA fila — variable (chips), ventana (desplegable),
  // estación y familia (desplegables). Sin telemetría de cobertura (retirada) y sin
  // ámbito Nacional (retirado): la vista es siempre por estación.
  function deckHTML() {
    const vars = [["precip", "Precipitación"], ["tmax", "T. máxima"], ["tmin", "T. mínima"]];
    // Las temperaturas solo existen en la red INAMHI: sin ella se deshabilitan
    // (con el motivo en el title) en vez de caer a otro bloque en silencio.
    // (Con DEPS fijas siempre está INAMHI; se conserva por robustez.)
    const sinTemp = !DEPS.includes("INAMHI");
    const optsVar = vars.map(([id, t]) => {
      const des = sinTemp && (id === "tmax" || id === "tmin");
      return `<option value="${id}" ${S.variable === id ? "selected" : ""}${des ? ` disabled title="Requiere la red meteorológica"` : ""}>${t}</option>`;
    }).join("");
    const optsFam = FAMILIAS_UI.map(([val, et]) =>
      `<option value="${esc(val)}" ${S.familia === val ? "selected" : ""}>${esc(et)}</option>`).join("");
    const chev = `<span class="ml-loc-chev"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#95A1B2" stroke-width="2.5"><path d="M6 9l6 6 6-6" stroke-linecap="round" stroke-linejoin="round"></path></svg></span>`;
    // v18: deck en UNA fila — VARIABLE · ESTACIÓN · FAMILIA (el selector Ventana se
    // retiró: la serie muestra 10 días pasados + presente + todo el futuro).
    return `
      <div class="ml-deck">
        <div class="ml-deck-rail"></div>
        <div class="ml-deck-cuerpo">
          <div class="ml-grupo">
            <span class="ml-grupo-lab">Variable</span>
            <div class="ml-loc"${sinTemp ? ` title="T. máxima y T. mínima requieren la red meteorológica"` : ""}>
              <select id="ml-sel-var">${optsVar}</select>
              ${chev}
            </div>
          </div>
          <div class="ml-deck-div"></div>
          <div class="ml-grupo ml-loc-grp">
            <span class="ml-grupo-lab">Estación</span>
            <div class="ml-loc ml-combo" id="ml-combo-est">
              <span class="ml-loc-mira"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#6A47CE" stroke-width="2"><circle cx="12" cy="12" r="6"></circle><path d="M12 1v4M12 19v4M1 12h4M19 12h4" stroke-linecap="round"></path></svg></span>
              <input id="ml-est-input" type="text" placeholder="Cargando…" autocomplete="off" spellcheck="false">
              ${chev}
              <div class="ml-combo-lista" id="ml-est-lista" tabindex="-1" hidden></div>
            </div>
          </div>
          <div class="ml-deck-div ml-deck-div-ancha"></div>
          <div class="ml-grupo ml-loc-grp">
            <span class="ml-grupo-lab">Familia de modelo</span>
            <div class="ml-loc">
              <select id="ml-sel-fam">${optsFam}</select>
              ${chev}
            </div>
          </div>
        </div>
      </div>
      <details class="hm-mas ml-nota-det">
        <summary>ℹ Cómo leer calificación y confianza</summary>
        <div class="ml-nota">
          <b>Calificación 1–10</b> = qué tan bueno es el modelo (skill). &nbsp;<b>Confianza</b> = cuántas <b>fechas</b> respaldan esa calificación:
          <span class="ml-pill alta">Alta ≥30</span>
          <span class="ml-pill media">Media 15–29</span>
          <span class="ml-pill baja">Baja 5–14</span>
          Elige una <b>estación</b> para ver su validación y su serie temporal.
        </div>
      </details>`;
  }

  async function tabValidacion(c) {
    // Sin INAMHI no existe el bloque de temperaturas: se fuerza precipitación
    // ANTES de pintar el deck (que además deshabilita tmax/tmin con el motivo),
    // en vez de dejar que el backend caiga a otro bloque en silencio.
    if (!DEPS.includes("INAMHI") && (S.variable === "tmax" || S.variable === "tmin")) {
      S.variable = "precip";
      App.aviso("Las temperaturas solo existen en la red meteorológica: se muestra precipitación.", "info");
    }
    c.innerHTML = deckHTML() + `<div id="ml-vista-est"></div>`;
    bindDeck(c);
    await cargarValidacion();
  }

  function bindDeck(c) {
    const selVar = c.querySelector("#ml-sel-var");
    if (selVar) selVar.onchange = () => { S.variable = selVar.value; cargarValidacion(); };
    const selFam = c.querySelector("#ml-sel-fam");
    if (selFam) selFam.onchange = () => { S.familia = selFam.value; cargarValidacion(); };
    const combo = c.querySelector("#ml-combo-est");
    if (combo) bindComboEst(combo);
  }

  /* ---------------- combobox de estación (búsqueda escrita) ---------------- */
  // Opciones vivas del combobox: estaciones con datos de /validacion, ya
  // filtradas por red y ordenadas por región → dependencia → nombre.
  let comboEsts = [];
  const normTxt = s => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const redEst = e => e ? (e.red_etiqueta || App.redEtiqueta(e.dependencia || e.red_id || "")) : "";

  function etiquetaEst() {
    const e = comboEsts.find(x => String(x.codigo) === String(S.estacion));
    return e ? `${e.codigo} · ${e.nombre} (${App.redEtiqueta(e.region)})` : "";
  }

  // Lista agrupada por REGIÓN (encabezados) con la dependencia visible por fila:
  // el catálogo queda identificado por región y red de cada estación.
  function opcionesComboHTML(q) {
    const nq = normTxt(q);
    const visibles = comboEsts.filter(e => !nq ||
      normTxt(`${e.codigo} ${e.nombre} ${e.region} ${redEst(e)}`).includes(nq));
    if (!visibles.length) return `<div class="ml-combo-vacia">Sin coincidencias.</div>`;
    let html = "", region = null;
    for (const e of visibles) {
      if (e.region !== region) {
        region = e.region;
        html += `<div class="ml-combo-grupo">${esc(App.redEtiqueta(region))}</div>`;
      }
      html += `<button type="button" class="ml-combo-op ${String(e.codigo) === String(S.estacion) ? "activa" : ""}" data-cod="${esc(e.codigo)}">
        <span class="cod">${esc(e.codigo)}</span><span class="nom">${esc(e.nombre)}</span>
        <span class="dep">${esc(redEst(e))}</span></button>`;
    }
    return html;
  }

  // Rellena el combobox tras cada /validacion (el deck NO se re-pinta entre cargas).
  function poblarComboEst(ests) {
    comboEsts = ests;
    const input = document.getElementById("ml-est-input");
    const lista = document.getElementById("ml-est-lista");
    if (!input || !lista) return;
    input.disabled = !ests.length;
    input.placeholder = ests.length ? "Buscar por código, nombre, región o red…" : "Sin estaciones";
    if (document.activeElement !== input) input.value = etiquetaEst();
    if (!lista.hidden) lista.innerHTML = opcionesComboHTML(input.value);
  }

  function bindComboEst(combo) {
    const input = combo.querySelector("#ml-est-input");
    const lista = combo.querySelector("#ml-est-lista");
    // Tras CADA re-render hay que resetear el scroll: la lista conserva el scrollTop
    // del estado anterior (p.ej. el salto a la estación activa al abrir) y las
    // opciones filtradas quedaban FUERA de la ventana visible — el usuario escribía
    // y veía la lista "vacía" sin nada que clicar.
    const refrescar = q => { lista.innerHTML = opcionesComboHTML(q); lista.scrollTop = 0; };
    // Al ABRIR se muestra la lista completa DESDE ARRIBA (refrescar ya resetea el
    // scroll): el viejo scrollIntoView a la estación activa confundía — parecía
    // que solo había una opción. La activa queda resaltada si se scrollea a ella.
    const abrir = () => {
      if (input.disabled) return;
      lista.hidden = false;
      refrescar("");
      input.select();
    };
    const cerrar = () => { lista.hidden = true; input.value = etiquetaEst(); };
    const elegir = cod => {
      S.estacion = String(cod);
      input.blur();   // blur → cerrar() repone la etiqueta de la selección nueva
      pintarVistaAmbito();
    };
    input.onfocus = abrir;
    // Si el foco cayó en la lista (arrastre del scrollbar en Firefox), se
    // devuelve al input en vez de cerrar; si salió del combo, se cierra.
    input.onblur = () => setTimeout(() => {
      if (combo.contains(document.activeElement)) { input.focus(); return; }
      cerrar();
    }, 0);
    input.oninput = () => { lista.hidden = false; refrescar(input.value); };
    input.onkeydown = ev => {
      if (ev.key === "Escape") { input.blur(); return; }
      if (lista.hidden && (ev.key === "ArrowDown" || ev.key === "Enter")) { ev.preventDefault(); abrir(); return; }
      const ops = [...lista.querySelectorAll(".ml-combo-op")];
      if (!ops.length) return;
      let i = ops.findIndex(o => o.classList.contains("sel"));
      if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
        ev.preventDefault();
        i = ev.key === "ArrowDown" ? Math.min(ops.length - 1, i + 1) : Math.max(0, Math.max(i, 0) - 1);
        ops.forEach((o, j) => o.classList.toggle("sel", j === i));
        ops[i].scrollIntoView({ block: "nearest" });
      } else if (ev.key === "Enter") {
        ev.preventDefault();
        const obj = i >= 0 ? ops[i] : ops[0];
        if (obj) elegir(obj.dataset.cod);
      }
    };
    // mousedown en una OPCIÓN no roba el foco (el click llega antes del blur);
    // en el resto de la lista (scrollbar) se deja pasar y el blur lo repone arriba.
    lista.onmousedown = ev => { if (ev.target.closest(".ml-combo-op")) ev.preventDefault(); };
    lista.onclick = ev => {
      const b = ev.target.closest(".ml-combo-op");
      if (b) elegir(b.dataset.cod);
    };
  }

  // Tipo legible de la familia de modelo (para la columna de la tabla).
  function famTipo(familia) {
    return { Convencionales: "convencional", "No convencionales": "no convencional",
      ML: "ML", Postprocesamiento: "post. estadístico" }[familia] || "crudo";
  }

  // Carga /validacion (datos del mapa nacional + lista para el selector) y
  // despacha la vista del ámbito activo (Nacional o una estación).
  async function cargarValidacion() {
    const cont = document.getElementById("ml-vista-est");
    if (!cont) return;
    const mi = ++gen;
    purgarPlots();
    cont.innerHTML = cargando("Calculando validación…");
    const bloque = VAR_A_BLOQUE[S.variable];
    const vent = VENTANA_VALID;
    const famQS = "&familia=" + encodeURIComponent(S.familia);
    let d;
    try {
      d = await App.api(`/mlnwp/validacion?bloque=${bloque}&ventana=${vent}&${depsQS()}${famQS}`);
    } catch (e) { if (mi === gen) cont.innerHTML = vacio("No se pudo cargar la validación: " + e.message); return; }
    if (mi !== gen) return;   // llegó una selección más nueva
    S.valData = d;

    // v12: sin ámbito Nacional — el selector lista SOLO estaciones con datos y la
    // vista es siempre por estación. Si la previa ya no tiene datos (cambió
    // variable/ventana/familia/deps), cae a la primera disponible.
    if (d.aviso) App.aviso(d.aviso, "info");

    // El visor incluye todas las estaciones. La procedencia se usa solo como
    // etiqueta secundaria; la agrupación y el orden visibles son por región
    // meteorológica real, nunca por entidad de origen.
    const depMap = {};
    for (const e of (S.ctx && S.ctx.estaciones) || []) depMap[String(e.codigo)] = redEst(e);
    const todas = d.estaciones || [];
    const ests = todas
      .map(e => ({ ...e, dependencia: depMap[String(e.codigo)] || "" }));
    ests.sort((a, b) => String(a.region).localeCompare(String(b.region))
      || String(a.nombre).localeCompare(String(b.nombre)));
    if (!ests.length) {
      poblarComboEst([]);
      const cont2 = document.getElementById("ml-vista-est");
      if (cont2) cont2.innerHTML = vacio("Sin estaciones con datos para esta combinación.");
      return;
    }
    if (!ests.some(e => String(e.codigo) === String(S.estacion)))
      S.estacion = String(ests[0].codigo);
    poblarComboEst(ests);
    pintarVistaAmbito();
  }

  // v12: la vista es siempre por estación (validación detallada + serie temporal).
  function pintarVistaAmbito() {
    purgarPlots();
    const cont = document.getElementById("ml-vista-est");
    if (!cont) return;
    cargarEstacion(cont);
  }

  // Vista de una estación: validación detallada (arriba) + serie temporal (abajo).
  async function cargarEstacion(cont) {
    if (!S.estacion) { cont.innerHTML = vacio("Selecciona una estación."); return; }
    const mi = ++gen;
    cont.innerHTML = cargando("Cargando validación y serie de la estación…");
    const bloque = VAR_A_BLOQUE[S.variable];
    const vent = VENTANA_VALID;
    const famQS = "&familia=" + encodeURIComponent(S.familia);
    const lookback = LOOKBACK_SERIE;   // contrato web: 10 días pasados + presente
    const esPrecip = S.variable === "precip";
    let det, ser, detDet;
    try {
      [det, ser, detDet] = await Promise.all([
        App.api(`/mlnwp/validacion_estacion?bloque=${bloque}&ventana=${vent}&${depsQS()}&codigo=${encodeURIComponent(S.estacion)}${famQS}`),
        App.api(`/mlnwp/series?${depsQS()}&codigo=${encodeURIComponent(S.estacion)}&variable=${VAR_SERIE[S.variable]}&lookback=${lookback}${famQS}`),
        // DETECCIÓN de precip (POD/FAR/CSI, bloque precip_det): segunda sección
        // de la tabla de clasificación. OPCIONAL — si el producto no está
        // publicado (visor viejo) o falla, la tabla muestra solo cuantificación.
        esPrecip
          ? App.api(`/mlnwp/validacion_estacion?bloque=precip_det&ventana=${vent}&${depsQS()}&codigo=${encodeURIComponent(S.estacion)}${famQS}`).catch(() => null)
          : Promise.resolve(null),
      ]);
    } catch (e) { if (mi === gen) cont.innerHTML = vacio("No se pudo cargar la estación: " + e.message); return; }
    // descarta si llegó una selección más nueva durante la carga
    if (mi !== gen || !S.estacion) return;
    purgarPlots();   // libera cualquier serie previa antes de reescribir el contenedor
    // Serie ARRIBA; tabla de clasificación DEBAJO. (La tarjeta 'Veredicto para
    // mañana' se RETIRÓ de esta pestaña a pedido del dueño; el endpoint
    // /mlnwp/veredicto sigue vivo — lo consume el submenú nuevo.)
    cont.innerHTML = `<div class="ml-card" id="ml-serie-card"></div>
      <div id="ml-detalle" style="margin-top:14px"></div>`;
    // En escritorio el backend ya filtra. El visor estático reutiliza el JSON
    // completo de "Todos" para evitar miles de artefactos y aplica aquí la misma
    // regla. Nunca se conserva una curva de la selección anterior.
    ser = { ...(ser || {}), familia_activa: S.familia,
      modelos: filtrarModelosFamilia(ser && ser.modelos, S.familia) };
    pintarSerie(document.getElementById("ml-serie-card"), ser);
    pintarDetalle(document.getElementById("ml-detalle"), det, detDet);
  }

  // UNA tabla de clasificación (un bloque de métricas: detección o cuantificación).
  // La usa pintarDetalle — para precip se pintan DOS (detección + cuantificación).
  function tablaClasifHTML(d) {
    // Filtro de familia: restringe los modelos mostrados (client-side, como el resumen).
    const modelos = filtrarModelosFamilia(d.modelos, S.familia);
    const esDet = d.modo === "detection";
    const esTemp = d.bloque === "tmax" || d.bloque === "tmin";

    // Cabeceras de métricas según el modo (detección vs continuo/cuantificación).
    const metHead = esDet
      ? [["pod", "POD"], ["far", "FAR"], ["csi", "CSI"]]
      : [["mae", "MAE"], ["rmse", "RMSE"], ["bias", "Sesgo"], ["corr", "Corr"],
         ...(esTemp ? [["mae_delta", "MAE ΔT"], ["corr_delta", "Corr ΔT"],
           ["sign_hit_active", "Acierto ΔT"], ["flat_miss_rate", "Fallo plano"]] : [])];
    const metHeadHTML = metHead.map(([, t]) => `<th class="der">${t}</th>`).join("");
    const nCols = 5 + metHead.length;

    const fmtMet = (m, k) => {
      const v = m[k];
      if (v === null || v === undefined || Number.isNaN(v)) return "—";
      if (k === "bias") return sgn(v);
      if (["corr", "corr_delta", "sign_hit_active", "flat_miss_rate",
        "pod", "far", "csi"].includes(k)) return Number(v).toFixed(2);
      return Number(v).toFixed(1);
    };

    // GANADOR del bloque = mayor calificación entre los que califican (con muestra suficiente).
    // El mejor DETECTOR (POD/FAR/CSI) puede no ser el mejor CUANTIFICADOR (MAE) → por eso el
    // ganador y el banner son POR BLOQUE, no uno global: es más honesto.
    let mejorIdx = -1, mejorRating = -Infinity;
    modelos.forEach((m, i) => {
      if (m.califica && m.rating != null && m.rating > mejorRating) { mejorRating = m.rating; mejorIdx = i; }
    });

    const filas = modelos.map((m, i) => {
      const sinCal = !m.califica || m.rating == null;
      const [bg, fg] = calColor(m.rating);
      const tipoFam = { Convencionales: "grillado", "No convencionales": "grillado",
        ML: "calibrado", Postprocesamiento: "combinación" }[m.familia] || "crudo";
      const metTds = metHead.map(([k]) =>
        `<td class="num">${sinCal ? "—" : fmtMet(m, k)}</td>`).join("");
      const esMejor = i === mejorIdx;
      return `<tr class="${sinCal ? "sin-calif" : ""}${esMejor ? " ml-best" : ""}">
        <td class="idx">${sinCal ? "—" : i + 1}</td>
        <td><span class="ml-mod-punto" style="background:${esc(m.color)}"></span>${esc(m.modelo)}${esMejor ? " ★" : ""}<span class="ml-mod-tipo"> · ${tipoFam}</span></td>
        <td>${sinCal ? `<span style="color:var(--muted-2)">sin calif.</span>`
          : `<span class="ml-calif-badge" style="background:${bg};color:${fg}">${num(m.rating, 1)}</span>`}</td>
        <td class="num">${m.n}</td>
        <td>${pillConf(m.confianza)}</td>
        ${metTds}
      </tr>`;
    }).join("");

    // Banner del ganador con su n (evita coronar a un modelo con muestra diminuta).
    const mg = mejorIdx >= 0 ? modelos[mejorIdx] : null;
    const banner = mg
      ? `<div class="ml-mejor-banner"><span class="ml-mejor-estrella">★</span> Mejor en ${esDet ? "detección de eventos" : "cuantificación"}:
         <b>${esc(mg.modelo)}</b> — calif. ${num(mg.rating, 1)}/10 · confianza ${esc(String(mg.confianza || "—")).toLowerCase()} · <b>${mg.n}</b> fechas</div>`
      : "";

    return `${banner}
      <table class="ml-tabla-modelos">
        <thead><tr>
          <th>#</th><th>Modelo</th><th>Calif.</th><th class="der">Fechas</th><th>Confianza</th>
          ${metHeadHTML}
        </tr></thead>
        <tbody>${filas || `<tr><td colspan="${nCols}" class="suave" style="padding:14px">Sin modelos para esta estación.</td></tr>`}</tbody>
      </table>`;
  }

  // UNA SOLA tabla para precip (pedido del dueño 2026-07-09): detección Y cuantificación
  // en la misma fila por modelo — la columna del MODELO queda FIJA (sticky) y las
  // métricas se deslizan en X. Aplica a escritorio y móvil.
  function tablaUnificadaHTML(dCua, dDet) {
    const fil = ms => filtrarModelosFamilia(ms, S.familia);
    const cua = fil(dCua.modelos), det = fil(dDet.modelos);
    const dmap = new Map(det.map(m => [m.modelo, m]));
    // Orden = el del bloque base (cuantificación, ya viene por calificación); los
    // modelos solo-detección se anexan al final.
    const orden = [...cua];
    det.forEach(m => { if (!cua.some(x => x.modelo === m.modelo)) orden.push({ ...m, _soloDet: true }); });
    const mejorDe = ms => { let bn = null, br = -Infinity;
      ms.forEach(m => { if (m.califica && m.rating != null && m.rating > br) { br = m.rating; bn = m.modelo; } }); return bn; };
    const bestCua = mejorDe(cua), bestDet = mejorDe(det);
    const sinC = m => !m || !m.califica || m.rating == null;
    const f2 = v => (v == null || Number.isNaN(v)) ? "—" : Number(v).toFixed(2);
    const f1 = v => (v == null || Number.isNaN(v)) ? "—" : Number(v).toFixed(1);
    const badge = (m, best) => sinC(m)
      ? `<span style="color:var(--muted-2)">—</span>`
      : (([bg, fg]) => `<span class="ml-calif-badge" style="background:${bg};color:${fg}">${num(m.rating, 1)}</span>${m.modelo === best ? " ★" : ""}`)(calColor(m.rating));
    const filas = orden.map((base, i) => {
      const mc = base._soloDet ? null : base;
      const md = dmap.get(base.modelo) || (base._soloDet ? base : null);
      const tipoFam = { Convencionales: "grillado", "No convencionales": "grillado",
        ML: "calibrado", Postprocesamiento: "combinación" }[base.familia] || "crudo";
      return `<tr>
        <td class="ml-uni-mod"><span class="ml-uni-idx">${i + 1}</span><span class="ml-mod-punto" style="background:${esc(base.color)}"></span>${esc(base.modelo)}<span class="ml-mod-tipo"> · ${tipoFam}</span></td>
        <td>${badge(md, bestDet)}</td>
        <td class="num">${sinC(md) ? "—" : f2(md.pod)}</td>
        <td class="num">${sinC(md) ? "—" : f2(md.far)}</td>
        <td class="num">${sinC(md) ? "—" : f2(md.csi)}</td>
        <td>${badge(mc, bestCua)}</td>
        <td class="num">${sinC(mc) ? "—" : f1(mc.mae)}</td>
        <td class="num">${sinC(mc) ? "—" : f1(mc.rmse)}</td>
        <td class="num">${sinC(mc) ? "—" : sgn(mc.bias)}</td>
        <td class="num">${sinC(mc) ? "—" : f2(mc.corr)}</td>
        <td class="num">${(mc && mc.n) ?? (md && md.n) ?? "—"}</td>
        <td>${pillConf((mc || md || {}).confianza)}</td>
      </tr>`;
    }).join("");
    const ban = (ms, best, etq) => {
      const mg = ms.find(m => m.modelo === best);
      return mg ? `<div class="ml-mejor-banner"><span class="ml-mejor-estrella">★</span> Mejor en ${etq}:
        <b>${esc(mg.modelo)}</b> — calif. ${num(mg.rating, 1)}/10 · <b>${mg.n}</b> fechas</div>` : "";
    };
    return `${ban(det, bestDet, "detección de eventos")}${ban(cua, bestCua, "cuantificación")}
      <div class="ml-uni-wrap">
      <table class="ml-tabla-modelos ml-uni">
        <thead>
          <tr><th class="ml-uni-mod" rowspan="2">Modelo</th>
              <th colspan="4" class="ml-uni-grp">Detección · ¿llueve sí/no?</th>
              <th colspan="4" class="ml-uni-grp">Cuantificación · ¿cuánto?</th>
              <th colspan="3" class="ml-uni-grp">Muestra</th></tr>
          <tr><th>Calif.</th><th class="der">POD</th><th class="der">FAR</th><th class="der">CSI</th>
              <th>Calif.</th><th class="der">MAE</th><th class="der">RMSE</th><th class="der">Sesgo</th>
              <th class="der">Corr</th><th class="der">Fechas</th><th>Conf.</th></tr>
        </thead>
        <tbody>${filas || `<tr><td colspan="12" class="suave" style="padding:14px">Sin modelos para esta estación.</td></tr>`}</tbody>
      </table></div>
      <div class="ml-pb-nota">Detección: POD acierto · FAR falsa alarma · CSI global. Cuantificación: MAE/RMSE error en mm · Sesgo · Corr. Desliza la tabla para ver todas las métricas; el modelo y su calificación quedan fijos.</div>`;
  }

  // Tarjeta 'Clasificación de modelos'. d = bloque principal (cuantificación en
  // precip; continuo en temperaturas). dDet = bloque precip_det (POD/FAR/CSI) —
  // solo en precip: UNA tabla unificada (detección + cuantificación por fila).
  function pintarDetalle(cont, d, dDet) {
    const nom = d.nombre || S.estacion;
    const dosSecciones = !!(dDet && (dDet.modelos || []).length);
    const cuerpo = dosSecciones ? tablaUnificadaHTML(d, dDet) : tablaClasifHTML(d);
    cont.innerHTML = `
      <div class="ml-card">
        <h3 class="ml-titulo">Clasificación de modelos en ${esc(nom)}
          <span class="ml-sutil">· ${esc(d.codigo)} · ${esc(App.redEtiqueta(d.region))} · ordenados por calificación</span></h3>
        ${cuerpo}
      </div>`;
  }

  /* ============================================================
     MAPA Plotly (puntos sobre fondo "continental"): usado por
     Validación (ganador) y Mapas (campo). Sin tiles: lon/lat como
     x/y dentro de los límites de Ecuador, con relieve provincial
     dibujado en líneas tenues si /geojson/provincias está disponible.
     ============================================================ */
  const ECU = { W: -81.3, E: -75.0, S: -5.1, N: 1.6 };

  // Contorno de Ecuador con ENCASILLADO (blanca ancha debajo + negra más fina encima).
  // wNegro parametrizado (spec de anchos): mini-mapas/grillas 1.5 (defecto) ·
  // MAPA GRANDE (ganador) 2.0 — el llamador del mapa grande pasa opts.outlineW = 2.
  function outlineTrace(wNegro = 1.5) {
    if (!S.geojson || !S.geojson.features) return [];
    const xs = [], ys = [];
    const empuja = ring => {
      for (const [lon, lat] of ring) { xs.push(lon); ys.push(lat); }
      xs.push(null); ys.push(null);
    };
    for (const f of S.geojson.features) {
      const g = f.geometry; if (!g) continue;
      if (g.type === "Polygon") g.coordinates.forEach(empuja);
      else if (g.type === "MultiPolygon") g.coordinates.forEach(p => p.forEach(empuja));
    }
    if (!xs.length) return [];
    const base = { type: "scatter", mode: "lines", x: xs, y: ys, hoverinfo: "skip", showlegend: false };
    // Lienzo de mapa = papel blanco en ambos temas → halo blanco + línea negra SIEMPRE.
    return [
      Object.assign({}, base, { line: { color: "#ffffff", width: 3.4 } }),
      Object.assign({}, base, { line: { color: "#000000", width: wNegro } }),
    ];
  }

  // Relieve continental RELLENO (mapa base): que el mapa no sean puntos pelados.
  function landTrace() {
    if (!S.geojson || !S.geojson.features) return null;
    const xs = [], ys = [];
    const empuja = ring => { for (const [lo, la] of ring) { xs.push(lo); ys.push(la); } xs.push(null); ys.push(null); };
    for (const f of S.geojson.features) {
      const g = f.geometry; if (!g) continue;
      if (g.type === "Polygon") g.coordinates.forEach(empuja);
      else if (g.type === "MultiPolygon") g.coordinates.forEach(p => p.forEach(empuja));
    }
    if (!xs.length) return null;
    // Lienzo de mapa = papel blanco en ambos temas → continente blanco casi opaco.
    return { type: "scatter", mode: "lines", x: xs, y: ys, fill: "toself", hoverinfo: "skip",
      fillcolor: "rgba(255,255,255,.95)",
      line: { color: "rgba(0,0,0,0)", width: 0 }, showlegend: false };
  }

  async function asegurarGeo() {
    if (S.geojson !== null) return;
    try { S.geojson = await App.api("/mlnwp/geojson/provincias"); }
    catch (e) { S.geojson = false; }
  }

  function ejeGeo() {
    return {
      xaxis: { range: [ECU.W, ECU.E], showgrid: false, zeroline: false, visible: false, fixedrange: false },
      yaxis: { range: [ECU.S, ECU.N], showgrid: false, zeroline: false, visible: false,
               scaleanchor: "x", scaleratio: 1, fixedrange: false },
    };
  }

  function plotMapaPuntos(divId, puntos, opts) {
    const el = document.getElementById(divId);
    if (!el) return;
    asegurarGeo().then(() => construirMapa(el, puntos, opts));
  }

  function construirMapa(el, puntos, opts) {
    if (!window.Plotly) { el.innerHTML = `<div class="vacio">Plotly no disponible</div>`; return; }
    const traces = [];
    const land = landTrace();        // relieve relleno de base
    if (land) traces.push(land);
    // Contorno de Ecuador con encasillado (negro + halo blanco). Ancho por tipo de
    // mapa: mini-mapas por modelo 1.5 (defecto) · MAPA GRANDE ganador 2.0 (opts.outlineW).
    traces.push(...outlineTrace(opts.outlineW || 1.5));

    if (!puntos.length) {
      Plotly.purge(el);
      el.innerHTML = `<div class="vacio" style="height:100%"><div class="icono">∅</div>Sin estaciones para mostrar</div>`;
      return;
    }
    el.innerHTML = "";

    const x = puntos.map(p => p.lon), y = puntos.map(p => p.lat);
    const text = puntos.map(opts.hover);
    const marker = { line: { color: "#fff", width: 2 } };

    if (opts.colorPorModelo) {
      marker.color = puntos.map(p => p.color);
      marker.size = puntos.map(opts.tamano);
    } else if (opts.colorRiesgo) {
      // "Por riesgo": recolorea el marcador con el color de nivel de riesgo del dato.
      marker.color = puntos.map(p => RIESGO_COLOR[p.riesgo] || "#3DA4DD");
      marker.size = opts.size || 11;
    } else {
      marker.color = puntos.map(p => p.valor);
      marker.colorscale = opts.colorscale;
      marker.cmin = opts.cmin; marker.cmax = opts.cmax;
      marker.size = opts.size || 11;
      marker.showscale = false;
    }

    const trace = { type: "scatter", mode: opts.etiquetas ? "markers+text" : "markers",
      x, y, text, hoverinfo: "text", marker };
    if (opts.etiquetas) {
      trace.text = puntos.map(p => num(p.valor, 0));
      trace.hovertext = puntos.map(opts.hover);
      trace.hoverinfo = "text";
      trace.textposition = "top center";
      trace.textfont = { family: "IBM Plex Mono, monospace", size: 9, color: "#0F1B2D" };
    }
    traces.push(trace);

    const geo = ejeGeo();
    const layout = App.plotlyLayoutBase({
      showlegend: false, margin: { l: 0, r: 0, t: 0, b: 0 },
      xaxis: geo.xaxis, yaxis: geo.yaxis, dragmode: "pan",
    });
    Plotly.newPlot(el, traces, layout, App.plotlyConfig({ scrollZoom: true })).then(() => {
      if (App.pinchZoomMapa) App.pinchZoomMapa(el);   // v17: pinza = zoom del mapa
      if (opts.onClick) {
        el.on("plotly_click", ev => {
          const idx = ev.points && ev.points[0] && ev.points[0].pointNumber;
          if (idx == null) return;
          // el primer trace puede ser el outline; localizar el punto por curva.
          const curva = ev.points[0].curveNumber;
          const tr = traces[curva];
          if (tr !== trace) return;
          opts.onClick(puntos[idx]);
        });
      }
    });
  }

  /* ============================================================
     SERIE TEMPORAL (dentro de la vista de estación de Validación)
     pintarSerie la invoca cargarEstacion() con la respuesta de /series.
     ============================================================ */
  function pintarSerie(card, d) {
    const unidad = d.unidad || "mm";
    const esPrecip = !!d.es_precip;
    // Colores TEMA-CONSCIENTES para trazas y franja. Las etiquetas conservan un
    // halo blanco único en ambos temas para no perder contraste en el futuro.
    const oscuro = (App.tema && App.tema() === "oscuro");
    const C = oscuro
      ? { obs: "#FFFFFF", p50: "#6BB1EE", fan80: "rgba(120,165,225,.14)", fan50: "rgba(120,165,225,.30)", anot: "#E8F0FF" }
      : { obs: "#0F1B2D", p50: "#0052A3", fan80: "rgba(27,58,107,.10)", fan50: "rgba(27,58,107,.24)", anot: "#5A6678" };
    const metaCtx = ((S.ctx && S.ctx.estaciones) || []).find(
      e => String(e.codigo) === String(d.codigo));
    const meta = { ...(metaCtx || {}), ...d };
    const regionCruda = String(meta.region || "—");
    const region = /inamhi|celec|hidronaci[oó]n|pisco/i.test(regionCruda)
      ? "Región meteorológica no registrada" : regionCruda;
    const coord = (v, etiqueta) => (v === null || v === undefined || !Number.isFinite(Number(v)))
      ? null : `${etiqueta} ${Number(v).toFixed(5)}°`;
    const altitud = (meta.altitud_m === null || meta.altitud_m === undefined
      || !Number.isFinite(Number(meta.altitud_m)))
      ? null : `${Math.round(Number(meta.altitud_m))} m s. n. m.`;
    const varMet = d.variable === "precip" ? "Precipitación"
      : (d.variable === "tmax" ? "Temperatura máxima" : "Temperatura mínima");
    const aggMet = ({ sum_07_07: "acumulación 07:00–07:00",
      sum_00_24: "acumulación 00:00–24:00", max: "máxima diaria",
      min: "mínima diaria" })[d.agregacion] || String(d.agregacion || "");
    const chips = [
      `Código ${meta.codigo || d.codigo || "—"}`,
      coord(meta.lat, "Lat"), coord(meta.lon, "Lon"), altitud, region,
    ].filter(Boolean).map(x => `<span class="ml-serie-chip">${esc(x)}</span>`).join("");
    const cabecera = `<header class="ml-serie-cabecera">
      <h2>${esc(meta.nombre || d.nombre || d.codigo || "Estación")}</h2>
      <div class="ml-serie-chips">${chips}</div>
      <div class="ml-serie-subtitulo">${esc(varMet)}<span aria-hidden="true"> · </span>${esc(aggMet)}</div>
    </header>`;
    const modelosRespuesta = Array.isArray(d.modelos) ? d.modelos : [];
    if (!modelosRespuesta.length) {
      const fam = d.familia_activa || d.familia || "seleccionada";
      card.innerHTML = `${cabecera}<div class="ml-serie-vacia" role="status">
        <div class="icono">∅</div>
        <b>Sin curvas para esta selección.</b>
        <span>No hay modelos de ${esc(fam)} con datos en esta estación y variable.</span>
      </div>`;
      return;
    }
    card.innerHTML = `
      ${cabecera}
      <div class="ml-serie-acciones" aria-label="Descargas de la estación">
        <button type="button" class="boton chico ml-descarga-png"
                data-descarga-png="serie">↓ Descargar serie PNG</button>
        ${esPrecip ? `<button type="button" class="boton chico ml-descarga-png"
                data-descarga-png="probabilidades">↓ Descargar probabilidades PNG</button>` : ""}
        <span>PNG formal · 2310 × 1144 px · 220 dpi</span>
      </div>
      <div class="ml-time-scroll" role="region" tabindex="0"
           aria-label="Serie y probabilidades alineadas por fecha">
        <div class="ml-time-track">
          <div class="ml-serie-plot" id="ml-plot-serie"></div>
          <div class="ml-serie-probs" id="ml-serie-probs"></div>
        </div>
      </div>
      <div class="ml-serie-leyenda" id="ml-serie-leyenda"></div>
      <p class="ml-serie-pie">Observado vs. pronóstico (la franja sombreada de la derecha es el horizonte futuro). Los modelos se atenúan según su calificación.${esPrecip ? " En cada día, las barras se leen del centro hacia afuera por desempeño; detalle probabilístico por umbral en la tabla inferior." : ""}</p>`;

    const el = document.getElementById("ml-plot-serie");
    if (!window.Plotly || !el) return;
    const timeScroll = card.querySelector(".ml-time-scroll");
    if (timeScroll) timeScroll.onkeydown = ev => {
      const delta = ({ ArrowLeft: -56, ArrowRight: 56,
        PageUp: -timeScroll.clientWidth, PageDown: timeScroll.clientWidth })[ev.key];
      if (delta !== undefined) {
        ev.preventDefault();
        timeScroll.scrollLeft += delta;
      } else if (ev.key === "Home" || ev.key === "End") {
        ev.preventDefault();
        timeScroll.scrollLeft = ev.key === "Home" ? 0 : timeScroll.scrollWidth;
      }
    };
    // Escritorio muestra todo el eje sin scroll. Solo el teléfono usa un carril
    // temporal horizontal compartido por gráfico y probabilidades.
    // Debe usar exactamente el mismo breakpoint que la hoja de estilos; medir la
    // tarjeta podía activar el modo móvil dentro de un escritorio angosto sin que
    // existiera el carril desplazable correspondiente.
    const angosto = !!(window.matchMedia && window.matchMedia("(max-width: 560px)").matches);
    const hoyVisual = (App.hoyEC ? App.hoyEC() : d.hoy);
    const lookbackVisual = Number.isFinite(Number(d.lookback)) ? Number(d.lookback) : LOOKBACK_SERIE;
    const desdeVisual = moverFechaISO(hoyVisual, -Math.max(0, lookbackVisual));

    const traces = [];
    const opacidadesTrazas = [];
    const etiquetasPuntos = [];
    const fechasGrafico = new Set();
    const turnosPorFecha = new Map();
    const fx = arr => (arr || []).map(s => s);
    // Carriles alternados por fecha. Cada punto mantiene su coordenada real, pero la
    // caja se desplaza unos píxeles para reducir colisiones entre observado y modelos.
    const carrilesPrecip = [
      [0, 12], [-38, 22], [38, 22], [-25, 40], [25, 40],
      [-45, 58], [45, 58], [-12, 64], [12, 64],
    ];
    const carrilesTemp = [
      [0, 13], [-36, 26], [36, 26], [-24, -18], [24, -18],
      [-42, 48], [42, 48], [-12, -38], [12, -38],
    ];
    const registrarFecha = fecha => {
      if (!fecha || (desdeVisual && fecha < desdeVisual)) return false;
      fechasGrafico.add(fecha);
      return true;
    };
    const agregarEtiquetaPunto = (fecha, valor) => {
      if (!fecha || valor === null || valor === undefined || !Number.isFinite(Number(valor))) return;
      if (!registrarFecha(fecha)) return;
      const turno = turnosPorFecha.get(fecha) || 0;
      turnosPorFecha.set(fecha, turno + 1);
      const carriles = esPrecip ? carrilesPrecip : carrilesTemp;
      const [xshift, yshiftBase] = carriles[turno % carriles.length];
      const vuelta = Math.floor(turno / carriles.length);
      const signo = yshiftBase < 0 ? -1 : 1;
      const yshift = yshiftBase + signo * vuelta * 18;
      etiquetasPuntos.push({
        x: fecha, y: Number(valor), xref: "x", yref: "y",
        text: etiquetaValor(valor), showarrow: false,
        xanchor: "center", yanchor: yshift >= 0 ? "bottom" : "top",
        xshift, yshift, align: "center", captureevents: false,
        bgcolor: ETIQUETA_BG, borderwidth: 0, borderpad: 1, opacity: 1,
        font: { family: "IBM Plex Mono, monospace", size: 9.5, color: ETIQUETA_TEXTO },
      });
    };

    // El observado reserva el primer carril y etiqueta cada valor, incluido 0 mm.
    if (d.observado && d.observado.fechas && d.observado.fechas.length) {
      d.observado.fechas.forEach((fecha, i) =>
        agregarEtiquetaPunto(fecha, (d.observado.valores || [])[i]));
    }

    // BANDA INTERCUARTIL RETIRADA (pedido del dueño 2026-07-11): el abanico P25–P75 /
    // P10–P90 y la mediana P50 se distorsionaban en el pronóstico a futuro. Se conserva el
    // pronóstico puntual (líneas/barras de modelos + observado) y, para precip, la tabla de
    // probabilidad por umbral. d.banda sigue llegando del backend pero ya no se dibuja (solo
    // se usa más abajo para fijar el tope del horizonte 'futuro' de la franja sombreada).

    // Modelos atenuados por calificación verificada. En oscuro la misma escala
    // monótona recibe +0.10 de contraste (sin piso arbitrario ni inversión de skill).
    // Todas las curvas siguen disponibles y el hover muestra fecha+valor. Para no
    // tapar la serie, las etiquetas estáticas futuras se reservan a los productos
    // operativos; los comparadores se consultan mediante hover/clic.
    const leyenda = [];
    const _hoyEt = hoyVisual;
    // El backend antepone los productos operativos que alimentan alertas/cartas;
    // el cupo restante muestra los comparadores con mayor skill.
    const modelosVisibles = modelosRespuesta.slice(0, 8);
    const iRecomendado = indiceRecomendadoModelos(modelosVisibles);
    const distribucionLluvia = distribuirModelosCentroAfuera(modelosVisibles);
    const modelosTrazado = esPrecip
      ? distribucionLluvia.visual
      : modelosVisibles.map((modelo, ordenDesempeno) => ({
        modelo, ordenDesempeno, posicion: ordenDesempeno,
      }));
    const nBarrasLluvia = esPrecip
      ? modelosTrazado.filter(item => !item.modelo.dash).length : 0;
    for (const item of modelosTrazado) {
      const original = item.modelo;
      const iModelo = modelosVisibles.indexOf(original);
      const ordenDesempeno = item.ordenDesempeno;
      let m = original;   // el respaldo se re-etiqueta abajo
      const color = m.color;
      const esRecomendado = iRecomendado >= 0 && iModelo === iRecomendado;
      const op = opacidadPorSkill(m.rating, m.score ?? m.skill, oscuro);
      const wLin = esRecomendado ? Math.max(3, m.width ?? 1.5)
        : (oscuro ? Math.max(2, m.width ?? 1.5) : (m.width ?? 1.5));
      // 'Sin entrenamiento' (m.dash/m.sin_entrenar) = tramo pasado-sin-obs con el fallback
      // colapsado: UNA línea punteada gris SIN rating (aunque sea precip), en vez de ~26
      // líneas/barras idénticas superpuestas ("todos los modelos iguales / plano").
      // v14: nombre CLARO para el usuario (el crudo "Sin entrenamiento" confundía).
      if (m.sin_entrenar) m = { ...m, modelo: "Respaldo (sin obs para entrenar)" };
      const rtxt = m.sin_entrenar ? "" : ` (${num(m.rating, 1)})`;
      const otxt = esRecomendado ? " · recomendado" : (m.operacional ? " · operativo" : "");
      (m.fechas || []).forEach((fecha, i) => {
        registrarFecha(fecha);
        // 0 es válido: solo se excluyen nulos y fechas estrictamente pasadas.
        if ((m.operacional || esRecomendado) && _hoyEt && fecha >= _hoyEt) {
          agregarEtiquetaPunto(fecha, (m.valores || [])[i]);
        }
      });
      if (esPrecip && !m.dash) {
        traces.push({ type: "bar", x: fx(m.fechas), y: m.valores, name: `${m.modelo}${otxt}${rtxt}`,
          marker: { color, line: {
            color: oscuro ? "rgba(255,255,255,.58)" : "rgba(15,39,69,.48)",
            width: ordenDesempeno === 0 ? 1.15 : 0.35,
          } },
          opacity: op, offsetgroup: `lluvia-${String(item.posicion).padStart(2, "0")}`,
          alignmentgroup: "precipitacion-diaria", legendrank: ordenDesempeno + 1,
          hovertemplate: `${esc(m.modelo)} · desempeño #${ordenDesempeno + 1}<br>%{x|%d/%m/%Y}: %{y:.1f} ${esc(unidad)}<extra></extra>` });
      } else {
        // connectgaps:false + eje completo con null (series.py): un hueco de fechas
        // se ve como hueco, NO como diagonal fantasma (queja La Argelia 84270 03/07).
        traces.push({ type: "scatter", mode: "lines", x: fx(m.fechas), y: m.valores, name: `${m.modelo}${otxt}${rtxt}`,
          line: { color, width: wLin, ...(m.dash ? { dash: m.dash } : {}) }, opacity: op, connectgaps: false,
          hovertemplate: `${esc(m.modelo)}<br>%{x|%d/%m/%Y}: %{y:.1f} ${esc(unidad)}<extra></extra>` });
      }
      opacidadesTrazas.push(op);
      const swStyle = m.dash ? `border-top:2px dotted ${esc(color)};height:0`
                             : `background:${esc(color)};opacity:${op}`;
      leyenda.push({ orden: ordenDesempeno,
        html: `<span class="it"><span class="sw-caja" style="${swStyle}"></span>${esc(m.modelo)}${esc(otxt)}${rtxt}</span>` });
    }

    // Observado: línea con marcadores. Sus etiquetas son anotaciones con fondo
    // translúcido, creadas arriba para reservar el primer carril de cada fecha.
    if (d.observado && d.observado.fechas && d.observado.fechas.length) {
      d.observado.fechas.forEach(registrarFecha);
      traces.push({ type: "scatter", mode: "lines+markers", x: d.observado.fechas, y: d.observado.valores,
        name: "Observado", opacity: 1, line: { color: C.obs, width: 3.2 }, connectgaps: false,
        marker: { color: C.obs, size: 8, symbol: "circle" },
        hovertemplate: `Observado<br>%{x|%d/%m/%Y}: %{y:.1f} ${esc(unidad)}<extra></extra>` });
      opacidadesTrazas.push(1);
    }

    // Eje canónico compartido. Las probabilidades se reindexan más abajo a estas
    // mismas fechas, por lo que una fecha faltante queda como “—” y no desplaza
    // todas las columnas siguientes.
    const pu = d.probs_umbral;
    if (esPrecip && pu && Array.isArray(pu.fechas)) {
      pu.fechas.forEach(registrarFecha);
    }
    const ejeFechas = construirEjeDiarioVentana(
      [...fechasGrafico], hoyVisual, lookbackVisual);
    const timeTrack = card.querySelector(".ml-time-track");
    if (timeTrack) {
      // Ocho barras caben sin solaparse en escritorio; en teléfono se ensancha
      // cada día y el carril temporal ya existente permite recorrerlas con el dedo.
      const anchoDia = esPrecip ? Math.max(68, nBarrasLluvia * 10) : 56;
      timeTrack.style.setProperty("--ml-time-track-width",
        `${Math.max(720, MARGEN_EJE_IZQ_PX + MARGEN_EJE_DER_PX
          + ejeFechas.length * anchoDia)}px`);
    }
    el.style.minWidth = "0";
    const rangoX = ejeFechas.length ? [
      new Date(`${ejeFechas[0]}T00:00:00Z`).getTime() - 43200000,
      new Date(`${ejeFechas[ejeFechas.length - 1]}T00:00:00Z`).getTime() + 43200000,
    ] : null;

    const layout = App.plotlyLayoutSerie("", {
      // Cada fecha es un grupo: ninguna barra tapa a otra. El orden de trazas ya
      // ubica al mejor modelo en el centro y desplaza los siguientes hacia afuera.
      // El eje X sigue siendo temporal para alinear observado y probabilidades.
      barmode: "group", bargap: 0.14, bargroupgap: 0.06,
      showlegend: false,   // única leyenda = la HTML (ml-serie-leyenda); evita leyenda doble
      annotations: etiquetasPuntos,
      margin: { l: MARGEN_EJE_IZQ_PX, r: MARGEN_EJE_DER_PX, t: 50, b: 56 },
      yaxis: { title: { text: unidad, font: { size: 11 } }, rangemode: esPrecip ? "tozero" : "normal",
               ...(angosto ? { fixedrange: true } : {}) },
      // Eje X: TODAS las fechas (un tick por día, rotadas -45°) — el lienzo tiene ancho
      // mínimo 680px en angosto (scroll), así que siguen legibles. En angosto los ejes
      // van FIJOS: el gesto táctil desliza el contenedor y el tap abre el popup.
      xaxis: { type: "date", tickformat: "%d/%m", tickmode: "linear", dtick: 86400000,
               tickangle: -45, tickfont: { size: 9 }, automargin: true,
               ...(rangoX ? { range: rangoX } : {}),
               ...(angosto ? { fixedrange: true } : {}) },
    });
    // Distinción HISTORIA vs PRONÓSTICO: franja de fondo desde HOY hasta el final +
    // línea divisoria. F5: "hoy" se calcula en el CLIENTE (TZ Ecuador) — el visor
    // congela los JSON y el 'hoy' del backend envejece; d.hoy queda de fallback.
    const _hoy = hoyVisual;
    if (_hoy) {
      // finX = la fecha MÁS TARDÍA entre banda y modelos (no solo la banda): banda y
      // líneas salen de bases distintas y solo comparten el 'desde'; tomar el máximo
      // hace que la franja de 'futuro' cubra TODO el pronóstico dibujado, sin importar
      // cuál se extienda más (coherente con el pie 'mismo horizonte que las líneas').
      const _fins = [];
      if (d.banda && d.banda.fechas && d.banda.fechas.length) _fins.push(d.banda.fechas[d.banda.fechas.length - 1]);
      const _modFechas = (d.modelos || []).flatMap(m => m.fechas || []);
      if (_modFechas.length) _fins.push(_modFechas.slice().sort().slice(-1)[0]);
      const finX = _fins.length ? _fins.sort().slice(-1)[0] : _hoy;
      layout.shapes = [
        { type: "rect", x0: _hoy, x1: finX, yref: "paper", y0: 0, y1: 1, layer: "below",
          fillcolor: "rgba(107,140,180,.07)", line: { width: 0 } },
        { type: "line", x0: _hoy, x1: _hoy, yref: "paper", y0: 0, y1: 1,
          line: { color: "#6B8CB4", width: 1.8, dash: "dot" } },
      ];
      layout.annotations = [...(layout.annotations || []), { x: _hoy, yref: "paper", y: 1, yanchor: "bottom", xanchor: "left",
        text: "Pronóstico", showarrow: false,
        font: { family: "IBM Plex Mono", size: 10, color: C.anot } }];
    }
    Plotly.newPlot(el, traces, layout, App.plotlyConfig(angosto ? { displayModeBar: false } : {})).then(() => {
      // Plotly puede redistribuir l/r para acomodar el título del eje Y. La tabla
      // lee el dominio efectivamente renderizado, no el margen solicitado, y así
      // cada centro de columna coincide con su tick incluso tras un resize.
      sincronizarMargenesTabla(el, timeTrack);
      // En móvil, ubica el presente con dos días de contexto histórico. Escritorio
      // no tiene desplazamiento horizontal y siempre muestra el eje completo.
      const sc = el.closest(".ml-time-scroll");
      if (sc && angosto && ejeFechas.length) {
        const iHoyMovil = _hoy ? Math.max(0, ejeFechas.findIndex(f => f >= _hoy)) : 0;
        const anchoFecha = Math.max(1, ((timeTrack && timeTrack.scrollWidth) || 720) - 78) / ejeFechas.length;
        sc.scrollLeft = Math.max(0, 58 + Math.max(0, iHoyMovil - 2) * anchoFecha);
      } else if (sc) {
        sc.scrollLeft = 0;
      }
      // Hover y selección solo realzan temporalmente la curva elegida; al salir se
      // restaura la jerarquía objetiva determinada por skill.
      if (typeof el.on === "function" && window.Plotly && typeof Plotly.restyle === "function") {
        let seleccionada = null;
        const curva = ev => (ev && ev.points && ev.points.length)
          ? Number(ev.points[0].curveNumber) : null;
        const aplicarRealce = indice => Plotly.restyle(el, {
          opacity: opacidadesTrazas.map((alpha, i) => i === indice ? 1 : alpha),
        });
        el.on("plotly_hover", ev => aplicarRealce(curva(ev)));
        el.on("plotly_unhover", () => aplicarRealce(seleccionada));
        el.on("plotly_click", ev => {
          const i = curva(ev);
          seleccionada = seleccionada === i ? null : i;
          aplicarRealce(seleccionada);
        });
        el.on("plotly_doubleclick", () => {
          seleccionada = null;
          aplicarRealce(null);
          return false;
        });
      }
    });

    const leyEl = document.getElementById("ml-serie-leyenda");
    if (leyEl) leyEl.innerHTML =
      `<span class="it"><span class="sw-linea"></span>Observado</span>`
      + leyenda.sort((a, b) => a.orden - b.orden).map(item => item.html).join("");

    // Tabla de probabilidades por umbral: los porcentajes por nivel de lluvia (antes
    // solo se veía la 'sombra' de la banda y no estos números).
    const probsEl = document.getElementById("ml-serie-probs");
    if (probsEl) {
      const pu = d.probs_umbral;
      if (esPrecip && pu && pu.fechas && pu.fechas.length) {
        // Reindexación explícita al eje del gráfico. Si el probabilístico no trae
        // una fecha intermedia, se conserva la columna y se pinta “—”; nunca se
        // corre el resto de la tabla respecto de la precipitación diaria.
        const probabilidadesPorFecha = new Map(
          pu.fechas.map((fecha, i) => [fecha, (pu.probs || [])[i] || []]));
        const fechasTabla = ejeFechas;
        const iHoy = _hoy ? fechasTabla.findIndex(fecha => fecha >= _hoy) : -1;
        const alfa = p => p < 20 ? 0.08 : p < 50 ? 0.20 : p < 75 ? 0.38 : 0.58;
        const celStyle = p => p == null
          ? "color:var(--faint)"
          : `background:rgba(43,93,170,${alfa(p).toFixed(2)});color:${p >= 75 ? "#fff" : "var(--ink)"}`;
        const dd = f => `${f.slice(8, 10)}/${f.slice(5, 7)}`;
        const sep = i => i === iHoy ? " ml-pb-hoy" : "";   // borde que marca el inicio del pronóstico
        const cabFechas = fechasTabla.map((fecha, i) =>
          `<th class="ml-pb-f${sep(i)}" data-fecha="${esc(fecha)}" aria-label="${esc(fecha)}">${dd(fecha)}</th>`).join("");
        const filasU = (pu.umbrales || []).map((u, j) => {
          const celdas = fechasTabla.map((fecha, i) => {
            const p = (probabilidadesPorFecha.get(fecha) || [])[j];
            return `<td class="ml-pb-c${sep(i)}" data-fecha="${esc(fecha)}" style="${celStyle(p)}">${p == null ? "—" : p + "%"}</td>`;
          }).join("");
          const etiqueta = Math.abs(Number(u) - 0.1) <= 1e-9
            ? "P(lluvia)" : `≥${u} mm`;
          return `<tr><th class="ml-pb-u">${etiqueta}</th>${celdas}<td class="ml-pb-spacer" aria-hidden="true"></td></tr>`;
        }).join("");
        const columnas = `<col class="ml-pb-col-umbral">${fechasTabla.map(() =>
          '<col class="ml-pb-col-fecha">').join("")}<col class="ml-pb-col-spacer">`;
        probsEl.innerHTML =
          `<div class="ml-pb-tit">Probabilidad de lluvia por umbral · ventana móvil</div>
           <div class="ml-pb-wrap"><table class="ml-pb-tabla"><colgroup>${columnas}</colgroup><thead><tr><th class="ml-pb-esq">Umbral</th>${cabFechas}<th class="ml-pb-spacer" aria-hidden="true"></th></tr></thead>
           <tbody>${filasU}</tbody></table></div>
           <div class="ml-pb-nota">Mismo eje diario de la serie; “—” identifica una fecha sin probabilidad emitida. La línea vertical marca el inicio del pronóstico. Ej.: “≥25 mm = 30 %” significa 30 % de probabilidad de superar 25 mm ese día.</div>`;
      } else {
        probsEl.innerHTML = "";
      }
    }

    // Las descargas se construyen desde los datos ya normalizados de la tarjeta,
    // nunca desde una captura del viewport. Por ello el mismo botón produce bytes
    // con geometría idéntica en escritorio y teléfono.
    const contextoPNG = {
      meta, hoyVisual, ejeFechas, variableLabel: varMet, agregacionLabel: aggMet,
    };
    const figuraSerie = figuraTemporalPNG(d, contextoPNG);
    const figuraProb = figuraProbabilidadesPNG(d, contextoPNG);
    const conectarDescarga = (rol, figura) => {
      const boton = card.querySelector(`[data-descarga-png="${rol}"]`);
      if (!boton) return;
      if (!figura) {
        boton.disabled = true;
        boton.title = rol === "probabilidades"
          ? "Requiere observación local y al menos una probabilidad finita."
          : "Tmax/Tmin requieren observación local y modelos disponibles.";
        return;
      }
      boton.onclick = async () => {
        try {
          await descargarFiguraPNG(figura, boton);
        } catch (error) {
          if (App.aviso) App.aviso(
            error && error.message ? error.message : "No se pudo generar el PNG.",
            "error", 7000);
        }
      };
    };
    conectarDescarga("serie", figuraSerie);
    conectarDescarga("probabilidades", figuraProb);
  }

  /* ============================================================
     PESTAÑA 5 — GLOSARIO (3 tarjetas: modelos · métricas · calif+conf)
     ============================================================ */
  async function tabGlosario(c) {
    c.innerHTML = cargando("Cargando glosario…");
    let g;
    try { g = await App.api("/mlnwp/glosario"); } catch (e) { c.innerHTML = vacio("No se pudo cargar el glosario: " + e.message); return; }
    pintarGlosario(c, g);
  }

  function famClase(grupo) {
    const s = (grupo || "").toLowerCase();
    if (s.includes("crudo") || s.includes("nwp")) return "fam-crudo";
    if (s.includes("consenso") || s.includes("postproc")) return "fam-cons";
    return "fam-ml";
  }

  function pintarGlosario(c, g) {
    const modelos = g.modelos || [];
    const metricas = g.metricas || [];
    const cal = g.calificacion || {};
    const conf = g.confianza || {};

    // Tarjeta 1 — ¿Qué es cada modelo? (un bloque por familia, borde de color)
    const modelosHTML = modelos.map(grp => {
      const items = (grp.items || []).map(it =>
        `<div class="ml-gloss-modelo ${famClase(grp.grupo)}">
          <div class="top"><code>${esc(it.clave)}</code> <b>${esc(it.nombre)}</b></div>
          <div class="desc">${esc(it.detalle)}</div>
        </div>`).join("");
      return `<div class="ml-gloss-modelo ${famClase(grp.grupo)}" style="border-left-width:0;padding-left:0">
          <div class="top"><b>${esc(grp.grupo)}</b></div>
          <div class="desc">${esc(grp.intro)}</div>
        </div>${items}`;
    }).join("");

    // Tarjeta 2 — ¿Qué mide cada métrica? (grid 2×2, badge mono)
    const metHTML = metricas.map(m =>
      `<div class="ml-gloss-metrica">
        <div><span class="badge">${esc(m.clave)}</span> <b style="font-size:13px">${esc(m.nombre)}</b></div>
        <div class="def">${esc(m.definicion)}</div>
        <div class="lec">📖 ${esc(m.lectura)}</div>
      </div>`).join("");

    // Tarjeta 3 — Calificación 1–10 y confianza
    const niveles = (conf.niveles || []).map(n => {
      const k = confClase(n.etiqueta);
      return `<li><span class="ml-pill ${k}">${esc(n.etiqueta)}</span> ${esc(n.regla)}.</li>`;
    }).join("");

    c.innerHTML = `
      <div class="ml-glosario">
        <div class="tarjeta ml-gloss-card">
          <h3>¿Qué es cada modelo?</h3>
          <p class="ml-gloss-intro">El sistema compara muchos pronósticos distintos. Estos son sus tipos.</p>
          <div class="ml-gloss-modelos">${modelosHTML}</div>
        </div>
        <div class="tarjeta ml-gloss-card">
          <h3>¿Qué mide cada métrica?</h3>
          <div class="ml-gloss-metricas">${metHTML}</div>
        </div>
        <div class="tarjeta">
          <h3>${esc(cal.titulo || "Calificación 1–10 y confianza")}</h3>
          <p style="font-size:13px;color:var(--ink-2);line-height:1.6;margin:0 0 10px">${esc(cal.intro || "")}</p>
          ${cal.auditoria ? `<div class="ml-gloss-conf"><b>Auditoría v4:</b> ${esc(cal.auditoria)}</div>` : ""}
          <p style="font-size:13px;color:var(--ink-2);line-height:1.6;margin:12px 0 0">${esc(conf.intro || "")}</p>
          <ul class="ml-gloss-niveles">${niveles}</ul>
          ${conf.nota ? `<p class="suave" style="font-size:12px;margin:10px 0 0">${esc(conf.nota)}</p>` : ""}
        </div>
      </div>`;
  }

  /* ============================================================
     Exposición de la vista: PESTAÑA "Series, validación e IA" del
     módulo Pronóstico. cartas.js invoca window.MLNWP.render(container)
     al activarla y window.MLNWP.alDejar() al salir de la pestaña (o del
     módulo). Ya NO se registra entrada propia en la nav.
     ============================================================ */
  // El glosario de MODELOS NWP/ML sale a su propio menú "Glosario" (lo reusa glosario.js).
  App.panel("glosario:modelos", (cont) => tabGlosario(cont));

  window.MLNWP = {
    _opacidadPorSkill: opacidadPorSkill,
    _indiceRecomendadoModelos: indiceRecomendadoModelos,
    _ordenarModelosPorDesempeno: ordenarModelosPorDesempeno,
    _distribuirModelosCentroAfuera: distribuirModelosCentroAfuera,
    _filtrarModelosFamilia: filtrarModelosFamilia,
    _construirEjeDiarioVentana: construirEjeDiarioVentana,
    _margenesEjeDesdeTicks: margenesEjeDesdeTicks,
    _configPNGSerie: PNG_SERIE,
    _colorModeloPNG: colorModeloPNG,
    _seleccionarModelosPNG: seleccionarModelosPNG,
    _nombreArchivoSeriePNG: nombreArchivoSeriePNG,
    _figuraTemporalPNG: figuraTemporalPNG,
    _figuraProbabilidadesPNG: figuraProbabilidadesPNG,
    async render(vista) {
      // La cabecera global ya la gestiona el módulo anfitrión (Pronóstico):
      // aquí no se toca #cabecera-vista.
      pintarRaiz(vista);
      const c = cuerpo();
      if (c) c.innerHTML = cargando("Cargando contexto…");
      try {
        // El contexto trae el catálogo de estaciones (codigo→dependencia) para el
        // filtrado interno por red; las DEPS son fijas (los chips se retiraron).
        S.ctx = await App.api("/mlnwp/contexto");
      } catch (e) {
        if (c) c.innerHTML = vacio("No se pudo cargar el contexto ML-NWP: " + e.message);
        return;
      }
      pintarTab();
    },
    alDejar() {
      purgarPlots();   // libera las instancias Plotly y sus listeners de window
    },
  };

  // Deep-links antiguos a la entrada de nav retirada (#/validacion o #/mlnwp):
  // redirigen al módulo Pronóstico, donde vive ahora la pestaña.
  const redirigirLegado = () => {
    if (/^#\/(validacion|mlnwp)$/.test(location.hash || "")) location.hash = "#/pronostico";
  };
  redirigirLegado();
  window.addEventListener("hashchange", redirigirLegado);

  // Bus de refresco: tras CUALQUIER actualización, invalida el mapa cacheado (el
  // resumen/validación ya re-fetchean al pintar) y, si la vista está montada,
  // re-pinta la pestaña activa con datos frescos.
  document.addEventListener("datos-actualizados", () => {
    if (typeof cuerpo === "function" && cuerpo()) { try { pintarTab(); } catch (e) {} }
  });
})();
