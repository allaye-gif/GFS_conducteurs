import type { GribGrid } from "./grib-extract.js";
import { COASTLINE_WEST_AFRICA } from "./grib-coastline.js";
import { BORDERS_WEST_AFRICA } from "./grib-borders.js";
import { traceContours, smoothField, findExtrema, type ContourPath } from "./grib-contour.js";
import { findRidgesAndTroughs } from "./grib-ridge.js";

// Reperes visuels : quelques capitales/grandes villes d'Afrique de l'Ouest pour
// s'orienter sur la carte sans avoir a deviner a partir du seul quadrillage.
// N'est affiche que pour les cartes en aplat de couleur (humidite/precip/vent) —
// les cartes a isolignes suivent le style Synergie ou seuls les centres de
// pression H/D sont marques, pas les villes.
const CITIES: { name: string; lon: number; lat: number }[] = [
  { name: "Bamako", lon: -7.99, lat: 12.65 },
  { name: "Dakar", lon: -17.45, lat: 14.72 },
  { name: "Nouakchott", lon: -15.98, lat: 18.09 },
  { name: "Conakry", lon: -13.71, lat: 9.64 },
  { name: "Abidjan", lon: -4.02, lat: 5.32 },
  { name: "Ouagadougou", lon: -1.53, lat: 12.37 },
  { name: "Niamey", lon: 2.11, lat: 13.51 },
  { name: "Accra", lon: -0.19, lat: 5.56 },
  { name: "Lagos", lon: 3.38, lat: 6.52 },
  { name: "Alger", lon: 3.06, lat: 36.75 },
];

export type ColorStop = { at: number; color: [number, number, number] };

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function colorAt(stops: ColorStop[], t: number): string {
  const clamped = Math.max(0, Math.min(1, t));
  let lo = stops[0]!;
  let hi = stops[stops.length - 1]!;
  for (let i = 0; i < stops.length - 1; i++) {
    if (clamped >= stops[i]!.at && clamped <= stops[i + 1]!.at) {
      lo = stops[i]!;
      hi = stops[i + 1]!;
      break;
    }
  }
  const span = hi.at - lo.at || 1;
  const localT = (clamped - lo.at) / span;
  const r = Math.round(lerp(lo.color[0], hi.color[0], localT));
  const g = Math.round(lerp(lo.color[1], hi.color[1], localT));
  const b = Math.round(lerp(lo.color[2], hi.color[2], localT));
  return `rgb(${r},${g},${b})`;
}

export interface ContourOptions {
  step: number; // ecart entre isolignes, dans l'unite affichee (apres transform)
  decimals?: number; // decimales pour les etiquettes de valeur
  color: string;
  extrema?: { highLabel: string; lowLabel: string; color: string }; // centres H/D (pression uniquement)
  ridgeTrough?: { ridgeColor: string; troughColor: string }; // axes de dorsale/thalweg (pression uniquement)
}

export interface RenderOptions {
  title: string;
  subtitle: string;
  unit: string;
  min: number;
  max: number;
  stops: ColorStop[];
  transform: (raw: number) => number; // ex: Pa -> hPa, K -> C
  legendTicks?: number;
  contours?: ContourOptions;
  overlayTime?: string; // ex: "0600" — affiche en overlay sous le titre pour les cartes a isolignes
}

// Ratio 4:3 fixe.
const WIDTH = 900;
const HEIGHT = 675;

// Sous-echantillonnage pour garder un SVG raisonnable (grille source ~221x161).
const STEP = 2;

// En-dessous de cette fraction de l'aire de la carte, un contour ferme est
// considere comme du bruit residuel ("confetti") et n'est pas trace du tout —
// cf. capture Synergie de reference, ou les isobares sont continues.
const MIN_CLOSED_AREA_FRAC = 0.005;

function polygonAreaPx(points: [number, number][]): number {
  let area = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const [x0, y0] = points[i]!;
    const [x1, y1] = points[i + 1]!;
    area += x0 * y1 - x1 * y0;
  }
  return Math.abs(area) / 2;
}

export function renderGribSvg(grid: GribGrid, opts: RenderOptions): string {
  const { ni, nj, lat0, lon0, lat1, lon1, values } = grid;
  const lonSpan = lon1 - lon0 || 1;
  const latSpan = lat1 - lat0 || 1;

  // Champs a isolignes (pression, temperature) : pas d'aplat de couleur, pas
  // d'axes/graduations — fond blanc et rendu "carte synoptique" epure, comme
  // le vrai rendu Synergie. Les champs en aplat (humidite/precip/vent) gardent
  // le style tableau de bord avec axes et legende couleur.
  const noFill = !!opts.contours;

  const MARGIN = noFill
    ? { top: 10, right: 10, bottom: 10, left: 10 }
    : { top: 56, right: 40, bottom: 90, left: 56 };
  const PLOT_W = WIDTH - MARGIN.left - MARGIN.right;
  const PLOT_H = HEIGHT - MARGIN.top - MARGIN.bottom;

  const xFor = (lon: number) => MARGIN.left + ((lon - lon0) / lonSpan) * PLOT_W;
  const yFor = (lat: number) => MARGIN.top + (1 - (lat - lat0) / latSpan) * PLOT_H;

  const cellW = (PLOT_W / ni) * STEP;
  const cellH = (PLOT_H / nj) * STEP;
  const minClosedAreaPx2 = PLOT_W * PLOT_H * MIN_CLOSED_AREA_FRAC;

  const rects: string[] = [];
  if (!noFill) {
    for (let row = 0; row < nj; row += STEP) {
      const lat = lat0 + (row / (nj - 1)) * latSpan;
      for (let col = 0; col < ni; col += STEP) {
        const lon = lon0 + (col / (ni - 1)) * lonSpan;
        const raw = values[row * ni + col];
        if (raw === undefined) continue;
        const value = opts.transform(raw);
        const t = (value - opts.min) / (opts.max - opts.min || 1);
        const color = colorAt(opts.stops, t);
        const x = xFor(lon);
        const y = yFor(lat) - cellH; // le rect couvre vers le nord depuis ce point
        rects.push(`<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(cellW + 0.6).toFixed(1)}" height="${(cellH + 0.6).toFixed(1)}" fill="${color}"/>`);
      }
    }
  }

  // Traits de côte — noirs pleins et epais, comme sur les cartes Synergie.
  const coastPaths: string[] = [];
  for (const line of COASTLINE_WEST_AFRICA) {
    const d = line
      .map(([lon, lat], i) => `${i === 0 ? "M" : "L"}${xFor(lon).toFixed(1)},${yFor(lat).toFixed(1)}`)
      .join(" ");
    coastPaths.push(`<path d="${d}" fill="none" stroke="#000000" stroke-width="1.2" stroke-linejoin="round" clip-path="url(#plotClip)"/>`);
  }

  // Frontieres politiques — meme registre noir plein et epais que le littoral.
  const borderPaths: string[] = [];
  for (const line of BORDERS_WEST_AFRICA) {
    const d = line
      .map(([lon, lat], i) => `${i === 0 ? "M" : "L"}${xFor(lon).toFixed(1)},${yFor(lat).toFixed(1)}`)
      .join(" ");
    borderPaths.push(`<path d="${d}" fill="none" stroke="#000000" stroke-width="1.2" stroke-linejoin="round" clip-path="url(#plotClip)"/>`);
  }

  // Isolignes (isobares/isothermes) — champ lisse (gaussien) avant contourage
  // par marching squares, pour obtenir de longues lignes synoptiques continues
  // au lieu du "confetti" d'un champ brut a pleine resolution : cf. capture
  // Synergie de reference. Les petits contours fermes residuels sont encore
  // filtres par aire ; chaque ligne ne porte qu'une seule etiquette, posee sur
  // le segment le plus "droit" (courbure minimale) plutot qu'au milieu brut,
  // pour eviter de tomber dans un coude. Hierarchie visuelle : une isobare sur
  // deux (multiples de 4) est tracee en trait plein epais, les intermediaires
  // en trait fin — l'œil accroche la structure sans etre noye.
  const contourPaths: string[] = [];
  const contourLabels: string[] = [];
  const extremaMarkers: string[] = [];
  const ridgeTroughPaths: string[] = [];
  const ridgeTroughLabels: string[] = [];
  if (opts.contours) {
    const { step, color, decimals = 0, extrema } = opts.contours;
    const rawField = values.map(v => (v === undefined ? undefined : opts.transform(v))) as number[];
    const field = smoothField(rawField, ni, nj, 1.5);

    const levelStart = Math.ceil(opts.min / step) * step;
    const levels: number[] = [];
    for (let lvl = levelStart; lvl <= opts.max; lvl += step) levels.push(lvl);

    const traced = traceContours(field, ni, nj, lon0, lon1, lat0, lat1, levels);

    for (const path of traced) {
      if (path.points.length < 2) continue;
      const px = path.points.map(([lon, lat]) => [xFor(lon), yFor(lat)] as [number, number]);

      const isClosed = Math.hypot(px[0]![0] - px[px.length - 1]![0], px[0]![1] - px[px.length - 1]![1]) < 0.6;
      if (isClosed && polygonAreaPx(px) < minClosedAreaPx2) continue; // confetti — on ignore entierement

      const isMajor = Math.abs(((path.level % 4) + 4) % 4) < 1e-6;
      const strokeWidth = isMajor ? 2 : 0.8;
      const dashAttr = isMajor ? "" : ` stroke-dasharray="1,2.5"`;

      const d = px.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
      contourPaths.push(`<path d="${d}" fill="none" stroke="${color}" stroke-width="${strokeWidth}"${dashAttr} stroke-linejoin="round" stroke-linecap="round" clip-path="url(#plotClip)"/>`);

      let totalLen = 0;
      for (let i = 1; i < px.length; i++) totalLen += Math.hypot(px[i]![0] - px[i - 1]![0], px[i]![1] - px[i - 1]![1]);
      if (totalLen < 60) continue; // trop court pour porter une etiquette lisible

      // Place l'etiquette sur le point le plus "droit" du tiers central du
      // trace (pas tout au bord) : on evite ainsi les coudes ou le chiffre
      // serait coupe par un virage serre.
      const lo = Math.floor(px.length * 0.3);
      const hi = Math.ceil(px.length * 0.7);
      let bestIdx = Math.floor(px.length / 2);
      let bestScore = Infinity;
      for (let i = Math.max(1, lo); i < Math.min(px.length - 1, hi); i++) {
        const [ax, ay] = px[i - 1]!;
        const [bx, by] = px[i]!;
        const [cx, cy] = px[i + 1]!;
        const v1x = bx - ax, v1y = by - ay;
        const v2x = cx - bx, v2y = cy - by;
        const n1 = Math.hypot(v1x, v1y) || 1;
        const n2 = Math.hypot(v2x, v2y) || 1;
        const cosAngle = (v1x * v2x + v1y * v2y) / (n1 * n2);
        const curviness = 1 - cosAngle; // 0 = parfaitement droit
        if (curviness < bestScore) { bestScore = curviness; bestIdx = i; }
      }
      const [x, y] = px[bestIdx]!;
      const labelText = `${path.level.toFixed(decimals)}`;
      const labelW = 8 + labelText.length * 6.2;
      contourLabels.push(
        `<rect x="${(x - labelW / 2).toFixed(1)}" y="${(y - 7).toFixed(1)}" width="${labelW.toFixed(1)}" height="13" fill="#ffffff" fill-opacity="0.78" clip-path="url(#plotClip)"/>` +
        `<text x="${x.toFixed(1)}" y="${(y + 3.5).toFixed(1)}" font-size="9.5" font-weight="700" font-family="Arial, Helvetica, sans-serif" fill="#111111" text-anchor="middle" clip-path="url(#plotClip)">${labelText}</text>`
      );
    }

    // Centres de haute/basse pression (H/A et D), detectes sur le meme champ
    // lisse que le contourage — uniquement pour la pression (pas de sens pour
    // une temperature).
    if (extrema) {
      const found = findExtrema(field, ni, nj, lon0, lon1, lat0, lat1, {});
      for (const e of found) {
        const x = xFor(e.lon);
        const y = yFor(e.lat);
        const label = e.kind === "max" ? extrema.highLabel : extrema.lowLabel;
        extremaMarkers.push(
          `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-size="16" font-weight="700" font-family="Georgia, 'Times New Roman', serif" fill="${extrema.color}" text-anchor="middle" clip-path="url(#plotClip)">${label}</text>` +
          `<text x="${x.toFixed(1)}" y="${(y + 14).toFixed(1)}" font-size="10" font-weight="700" fill="${extrema.color}" text-anchor="middle" clip-path="url(#plotClip)">${e.value.toFixed(decimals)}</text>`
        );
      }
    }

    // Axes de dorsale (prolongement d'un anticyclone) et de thalweg
    // (prolongement d'une depression) — detectes via la courbure principale du
    // champ (Hessien) : l'axe est le lieu ou la derivee directionnelle
    // s'annule dans la direction "en travers" de la crete/du creux (cf.
    // grib-ridge.ts pour le detail mathematique). Uniquement pour la pression.
    if (opts.contours.ridgeTrough) {
      const { ridgeColor, troughColor } = opts.contours.ridgeTrough;
      const { ridges, troughs } = findRidgesAndTroughs(rawField, ni, nj, lon0, lon1, lat0, lat1);

      // On ne garde que les axes assez longs pour etre significatifs (le
      // calcul sur grille degradee produit deja des lignes propres, mais un
      // court residu isole reste possible pres d'un col) et on ne pose qu'une
      // seule etiquette par type sur toute la carte — plusieurs "Dorsale"/
      // "Thalweg" repetes a cote de chaque isobare rendait la carte illisible.
      const renderAxis = (paths: ContourPath[], color: string, dash: string, label: string) => {
        const candidates: { px: [number, number][]; totalLen: number }[] = [];
        for (const path of paths) {
          if (path.points.length < 2) continue;
          const px = path.points.map(([lon, lat]) => [xFor(lon), yFor(lat)] as [number, number]);
          const isClosed = Math.hypot(px[0]![0] - px[px.length - 1]![0], px[0]![1] - px[px.length - 1]![1]) < 0.6;
          if (isClosed) continue; // un axe de dorsale/thalweg est une ligne ouverte, pas une boucle

          let totalLen = 0;
          for (let i = 1; i < px.length; i++) totalLen += Math.hypot(px[i]![0] - px[i - 1]![0], px[i]![1] - px[i - 1]![1]);
          if (totalLen < 55) continue; // trop court pour etre un axe significatif
          candidates.push({ px, totalLen });
        }

        candidates.sort((a, b) => b.totalLen - a.totalLen);
        let labelled = false;
        for (const { px, totalLen } of candidates) {
          const d = px.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
          ridgeTroughPaths.push(`<path d="${d}" fill="none" stroke="${color}" stroke-width="1.4" stroke-dasharray="${dash}" stroke-linecap="round" stroke-linejoin="round" clip-path="url(#plotClip)"/>`);

          if (!labelled && totalLen > 70) {
            labelled = true;
            const [mx, my] = px[Math.floor(px.length / 2)]!;
            ridgeTroughLabels.push(
              `<text x="${mx.toFixed(1)}" y="${(my - 5).toFixed(1)}" font-size="9.5" font-weight="700" font-style="italic" fill="${color}" text-anchor="middle" paint-order="stroke" stroke="#ffffff" stroke-width="2.5" clip-path="url(#plotClip)">${escapeXml(label)}</text>`
            );
          }
        }
      };

      renderAxis(ridges, ridgeColor, "9,3,2,3", "Dorsale");
      renderAxis(troughs, troughColor, "1.5,3", "Thalweg");
    }
  }

  // Villes de repère — uniquement pour les cartes en aplat de couleur.
  const cityMarkers: string[] = [];
  if (!noFill) {
    for (const city of CITIES) {
      if (city.lon < lon0 || city.lon > lon1 || city.lat < lat0 || city.lat > lat1) continue;
      const x = xFor(city.lon);
      const y = yFor(city.lat);
      cityMarkers.push(
        `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.5" fill="#0f172a" stroke="#ffffff" stroke-width="0.8"/>` +
        `<text x="${(x + 5).toFixed(1)}" y="${(y + 3.5).toFixed(1)}" font-size="10.5" fill="#0f172a" paint-order="stroke" stroke="#ffffff" stroke-width="3">${escapeXml(city.name)}</text>`
      );
    }
  }

  // Grille lat/lon — magenta soutenu, comme sur les cartes Synergie. Les
  // graduations en degres ne sont affichees que pour les cartes en aplat
  // (les cartes a isolignes n'ont pas d'axes, comme une vraie capture logiciel).
  const gridLines: string[] = [];
  const lonStep = lonSpan > 40 ? 10 : 5;
  const latStep = latSpan > 30 ? 10 : 5;
  for (let lon = Math.ceil(lon0 / lonStep) * lonStep; lon <= lon1; lon += lonStep) {
    const x = xFor(lon);
    gridLines.push(`<line x1="${x.toFixed(1)}" y1="${MARGIN.top}" x2="${x.toFixed(1)}" y2="${MARGIN.top + PLOT_H}" stroke="#d8a0c0" stroke-width="0.3"/>`);
    if (!noFill) {
      gridLines.push(`<text x="${x.toFixed(1)}" y="${MARGIN.top + PLOT_H + 18}" font-size="11" fill="#334155" text-anchor="middle">${lon}°</text>`);
    }
  }
  for (let lat = Math.ceil(lat0 / latStep) * latStep; lat <= lat1; lat += latStep) {
    const y = yFor(lat);
    gridLines.push(`<line x1="${MARGIN.left}" y1="${y.toFixed(1)}" x2="${MARGIN.left + PLOT_W}" y2="${y.toFixed(1)}" stroke="#d8a0c0" stroke-width="0.3"/>`);
    if (!noFill) {
      gridLines.push(`<text x="${MARGIN.left - 8}" y="${(y + 4).toFixed(1)}" font-size="11" fill="#334155" text-anchor="end">${lat}°N</text>`);
    }
  }

  // Legende (barre de couleur horizontale) — uniquement pour les champs en
  // aplat de couleur ; les champs a isolignes n'en ont pas (les valeurs sont
  // deja portees par les etiquettes sur les lignes, comme sur Synergie).
  const legendX = MARGIN.left;
  const legendY = HEIGHT - 42;
  const legendW = PLOT_W;
  const legendH = 16;
  const legendStops = 40;
  const legendRects: string[] = [];
  const legendLabels: string[] = [];
  if (!noFill) {
    for (let i = 0; i < legendStops; i++) {
      const t0 = i / legendStops;
      const x = legendX + t0 * legendW;
      const w = legendW / legendStops;
      legendRects.push(`<rect x="${x.toFixed(1)}" y="${legendY}" width="${(w + 0.5).toFixed(1)}" height="${legendH}" fill="${colorAt(opts.stops, t0)}"/>`);
    }
    const ticks = opts.legendTicks ?? 5;
    for (let i = 0; i <= ticks; i++) {
      const t = i / ticks;
      const val = opts.min + t * (opts.max - opts.min);
      const x = legendX + t * legendW;
      legendLabels.push(`<text x="${x.toFixed(1)}" y="${legendY + legendH + 16}" font-size="11" fill="#334155" text-anchor="middle">${val.toFixed(0)}</text>`);
    }
  }
  const legendBox = !noFill
    ? `<g>${legendRects.join("")}</g><rect x="${legendX}" y="${legendY}" width="${legendW}" height="${legendH}" fill="none" stroke="#1e293b" stroke-width="1"/><g>${legendLabels.join("")}</g><text x="${legendX + legendW}" y="${legendY - 6}" font-size="11" fill="#334155" text-anchor="end">${escapeXml(opts.unit)}</text>`
    : "";

  // Titre — bandeau externe discret pour les cartes en aplat (avec metadonnees
  // completes) ; encart overlay en haut a gauche de la carte pour les cartes a
  // isolignes, comme sur une vraie capture Synergie ("Pmer" + heure du reseau).
  const header = !noFill
    ? `<text x="${MARGIN.left}" y="26" font-size="18" font-weight="600" fill="#0f172a">${escapeXml(opts.title)}</text>
  <text x="${MARGIN.left}" y="44" font-size="12" fill="#64748b">${escapeXml(opts.subtitle)}</text>`
    : `<rect x="${MARGIN.left + 4}" y="${MARGIN.top + 4}" width="86" height="46" fill="#ffffff" fill-opacity="0.82" stroke="#000000" stroke-width="0.6"/>
  <text x="${MARGIN.left + 47}" y="${MARGIN.top + 22}" font-size="17" font-weight="700" fill="#000000" text-anchor="middle" font-family="Arial, sans-serif">${escapeXml(opts.title)}</text>
  <text x="${MARGIN.left + 47}" y="${MARGIN.top + 41}" font-size="15" font-weight="700" fill="#000000" text-anchor="middle" font-family="Arial, sans-serif">${escapeXml(opts.overlayTime ?? "")}</text>`;

  return `<svg viewBox="0 0 ${WIDTH} ${HEIGHT}" xmlns="http://www.w3.org/2000/svg" font-family="system-ui, sans-serif">
  <defs>
    <clipPath id="plotClip"><rect x="${MARGIN.left}" y="${MARGIN.top}" width="${PLOT_W}" height="${PLOT_H}"/></clipPath>
  </defs>
  <rect x="0" y="0" width="${WIDTH}" height="${HEIGHT}" fill="#ffffff"/>
  <rect x="${MARGIN.left}" y="${MARGIN.top}" width="${PLOT_W}" height="${PLOT_H}" fill="#ffffff"/>
  <g>${rects.join("")}</g>
  <g>${gridLines.join("")}</g>
  <g>${borderPaths.join("")}</g>
  <g>${coastPaths.join("")}</g>
  <g>${contourPaths.join("")}</g>
  <g>${contourLabels.join("")}</g>
  <g>${ridgeTroughPaths.join("")}</g>
  <g>${ridgeTroughLabels.join("")}</g>
  <g>${extremaMarkers.join("")}</g>
  <g>${cityMarkers.join("")}</g>
  <rect x="${MARGIN.left}" y="${MARGIN.top}" width="${PLOT_W}" height="${PLOT_H}" fill="none" stroke="#000000" stroke-width="1"/>
  ${header}
  ${legendBox}
</svg>`;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ─── Echelles de couleur par type de champ ───────────────────────────────────
export const SCALES = {
  pmer: {
    min: 995, max: 1020,
    stops: [
      { at: 0,   color: [33, 102, 172] as [number, number, number] },
      { at: 0.5, color: [247, 247, 247] as [number, number, number] },
      { at: 1,   color: [178, 24, 43] as [number, number, number] },
    ],
    transform: (pa: number) => pa / 100,
    unit: "hPa",
    contours: {
      step: 2, decimals: 0, color: "#e60000",
      extrema: { highLabel: "A", lowLabel: "D", color: "#0033cc" },
      ridgeTrough: { ridgeColor: "#b45309", troughColor: "#4338ca" },
    },
  },
  temp: {
    min: 15, max: 42,
    stops: [
      { at: 0,    color: [49, 54, 149] as [number, number, number] },
      { at: 0.25, color: [69, 117, 180] as [number, number, number] },
      { at: 0.5,  color: [255, 255, 191] as [number, number, number] },
      { at: 0.75, color: [253, 141, 60] as [number, number, number] },
      { at: 1,    color: [165, 0, 38] as [number, number, number] },
    ],
    transform: (k: number) => k - 273.15,
    unit: "°C",
    contours: { step: 2, decimals: 0, color: "#e65c00" },
  },
  humidity: {
    min: 0, max: 100,
    stops: [
      { at: 0,   color: [166, 97, 26] as [number, number, number] },
      { at: 0.5, color: [247, 247, 247] as [number, number, number] },
      { at: 1,   color: [1, 133, 113] as [number, number, number] },
    ],
    transform: (v: number) => v,
    unit: "%",
  },
  precip: {
    min: 0, max: 40,
    stops: [
      { at: 0,    color: [255, 255, 255] as [number, number, number] },
      { at: 0.15, color: [199, 233, 192] as [number, number, number] },
      { at: 0.4,  color: [65, 171, 93] as [number, number, number] },
      { at: 0.7,  color: [33, 113, 181] as [number, number, number] },
      { at: 1,    color: [84, 39, 143] as [number, number, number] },
    ],
    transform: (v: number) => v,
    unit: "mm",
  },
  wind: {
    min: 0, max: 15,
    stops: [
      { at: 0,   color: [255, 255, 255] as [number, number, number] },
      { at: 0.3, color: [199, 233, 180] as [number, number, number] },
      { at: 0.6, color: [255, 237, 160] as [number, number, number] },
      { at: 0.8, color: [252, 141, 89] as [number, number, number] },
      { at: 1,   color: [179, 0, 0] as [number, number, number] },
    ],
    transform: (v: number) => v,
    unit: "m/s",
  },
  // Vent en altitude (ex: flux 850 hPa) : plage plus large que le vent 10m
  // (le flux d'est africain vers 850 hPa peut depasser 15-20 m/s).
  windUpper: {
    min: 0, max: 25,
    stops: [
      { at: 0,   color: [255, 255, 255] as [number, number, number] },
      { at: 0.3, color: [199, 233, 180] as [number, number, number] },
      { at: 0.6, color: [255, 237, 160] as [number, number, number] },
      { at: 0.8, color: [252, 141, 89] as [number, number, number] },
      { at: 1,   color: [179, 0, 0] as [number, number, number] },
    ],
    transform: (v: number) => v,
    unit: "m/s",
  },
} as const;
