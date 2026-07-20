// Rendu du champ combiné "couplage dynamique" : superposition du tourbillon
// absolu à 850, 700 et 200 hPa sur une même carte — technique de diagnostic
// synoptique classique pour repérer où la convergence cyclonique de basse
// couche (850/700 hPa) coïncide avec la divergence anticyclonique en altitude
// (200 hPa), signature d'un forçage dynamique favorable à l'ascendance/la
// convection.
//
// Contrairement à PMER, la vraie carte Synergie ("TA") montre un maillage
// dense et texturé de petites boucles fermées dans les 3 couleurs — c'est la
// signature réelle et informative d'un champ de tourbillon (naturellement
// turbulent), pas du bruit à lisser/filtrer comme pour les isobares. On NE
// lisse PAS le champ, on NE filtre PAS les petits contours fermés, et on
// n'étiquette pas les lignes de valeurs — juste des isolignes denses en 3
// couleurs unies sur fond parchemin, comme la référence.

import { COASTLINE_WEST_AFRICA } from "./grib-coastline.js";
import { BORDERS_WEST_AFRICA } from "./grib-borders.js";
import { traceContours } from "./grib-contour.js";

const WIDTH = 900;
const HEIGHT = 675;
const MARGIN = { top: 10, right: 10, bottom: 10, left: 10 };
const PLOT_W = WIDTH - MARGIN.left - MARGIN.right;
const PLOT_H = HEIGHT - MARGIN.top - MARGIN.bottom;
const PARCHMENT = "#f5f1dc";

export interface VorticityLayer {
  label: string; // ex: "850 hPa (convergence)"
  color: [number, number, number];
  values: number[]; // tourbillon absolu x1e7, meme grille que ni/nj/emprise
  ni: number;
  nj: number;
  levels: number[]; // niveaux de contour a tracer, densement espaces
}

export interface VorticityComboOptions {
  title: string;
  overlayTime?: string;
  lon0: number; lon1: number; lat0: number; lat1: number;
  layers: VorticityLayer[];
  // Zoome l'affichage sur une sous-region (ex: Mali) — lon0/lon1/lat0/lat1
  // ci-dessus restent l'emprise reelle de la grille (necessaires a traceContours
  // pour placer correctement chaque point), viewBounds ne change que la
  // projection ecran, comme dans grib-render.ts.
  viewBounds?: { lon0: number; lon1: number; lat0: number; lat1: number };
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function renderVorticityComboSvg(opts: VorticityComboOptions): string {
  const { lon0, lon1, lat0, lat1, layers } = opts;
  const viewLon0 = opts.viewBounds?.lon0 ?? lon0;
  const viewLon1 = opts.viewBounds?.lon1 ?? lon1;
  const viewLat0 = opts.viewBounds?.lat0 ?? lat0;
  const viewLat1 = opts.viewBounds?.lat1 ?? lat1;
  const viewLonSpan = viewLon1 - viewLon0 || 1;
  const viewLatSpan = viewLat1 - viewLat0 || 1;
  const xFor = (lon: number) => MARGIN.left + ((lon - viewLon0) / viewLonSpan) * PLOT_W;
  const yFor = (lat: number) => MARGIN.top + (1 - (lat - viewLat0) / viewLatSpan) * PLOT_H;

  const layerPaths: string[] = [];
  for (const layer of layers) {
    const traced = traceContours(layer.values, layer.ni, layer.nj, lon0, lon1, lat0, lat1, layer.levels);
    const [r, g, b] = layer.color;

    for (const path of traced) {
      if (path.points.length < 2) continue;
      const d = path.points
        .map(([lon, lat], i) => `${i === 0 ? "M" : "L"}${xFor(lon).toFixed(1)},${yFor(lat).toFixed(1)}`)
        .join(" ");
      layerPaths.push(`<path d="${d}" fill="none" stroke="rgb(${r},${g},${b})" stroke-opacity="0.85" stroke-width="1" stroke-linejoin="round" clip-path="url(#plotClip)"/>`);
    }
  }

  const coastPaths: string[] = [];
  for (const line of COASTLINE_WEST_AFRICA) {
    const d = line.map(([lon, lat], i) => `${i === 0 ? "M" : "L"}${xFor(lon).toFixed(1)},${yFor(lat).toFixed(1)}`).join(" ");
    coastPaths.push(`<path d="${d}" fill="none" stroke="#000000" stroke-width="1.1" stroke-linejoin="round" clip-path="url(#plotClip)"/>`);
  }
  const borderPaths: string[] = [];
  for (const line of BORDERS_WEST_AFRICA) {
    const d = line.map(([lon, lat], i) => `${i === 0 ? "M" : "L"}${xFor(lon).toFixed(1)},${yFor(lat).toFixed(1)}`).join(" ");
    borderPaths.push(`<path d="${d}" fill="none" stroke="#000000" stroke-width="1.1" stroke-linejoin="round" clip-path="url(#plotClip)"/>`);
  }

  const gridLines: string[] = [];
  const lonStep = viewLonSpan > 40 ? 10 : viewLonSpan > 15 ? 5 : 2;
  const latStep = viewLatSpan > 30 ? 10 : viewLatSpan > 15 ? 5 : 2;
  for (let lon = Math.ceil(viewLon0 / lonStep) * lonStep; lon <= viewLon1; lon += lonStep) {
    const x = xFor(lon);
    gridLines.push(`<line x1="${x.toFixed(1)}" y1="${MARGIN.top}" x2="${x.toFixed(1)}" y2="${MARGIN.top + PLOT_H}" stroke="#d8a0c0" stroke-width="0.3"/>`);
  }
  for (let lat = Math.ceil(viewLat0 / latStep) * latStep; lat <= viewLat1; lat += latStep) {
    const y = yFor(lat);
    gridLines.push(`<line x1="${MARGIN.left}" y1="${y.toFixed(1)}" x2="${MARGIN.left + PLOT_W}" y2="${y.toFixed(1)}" stroke="#d8a0c0" stroke-width="0.3"/>`);
  }

  // Legende : un trait de couleur + libelle (avec plage de valeurs) par
  // niveau, empile en haut a droite — les seuils numeriques rendent la
  // legende exploitable sans deviner ce que chaque couleur veut dire.
  const legendX = MARGIN.left + PLOT_W - 205;
  const legendYStart = MARGIN.top + 8;
  const legendItems = layers.map((layer, i) => {
    const y = legendYStart + i * 18;
    const [r, g, b] = layer.color;
    return `<line x1="${legendX}" y1="${y + 6}" x2="${legendX + 16}" y2="${y + 6}" stroke="rgb(${r},${g},${b})" stroke-width="2.5"/>` +
      `<text x="${legendX + 21}" y="${y + 10}" font-size="10.5" font-weight="600" fill="#111111" font-family="Arial, sans-serif">${escapeXml(layer.label)}</text>`;
  }).join("");
  const legendBoxH = layers.length * 18 + 6;
  const legendBg = `<rect x="${legendX - 6}" y="${legendYStart - 6}" width="203" height="${legendBoxH}" fill="#ffffff" fill-opacity="0.85" stroke="#000000" stroke-width="0.6"/>`;

  const header = `<rect x="${MARGIN.left + 4}" y="${MARGIN.top + 4}" width="86" height="46" fill="#ffffff" fill-opacity="0.85" stroke="#000000" stroke-width="0.6"/>
  <text x="${MARGIN.left + 47}" y="${MARGIN.top + 22}" font-size="17" font-weight="700" fill="#000000" text-anchor="middle" font-family="Arial, sans-serif">${escapeXml(opts.title)}</text>
  <text x="${MARGIN.left + 47}" y="${MARGIN.top + 41}" font-size="15" font-weight="700" fill="#000000" text-anchor="middle" font-family="Arial, sans-serif">${escapeXml(opts.overlayTime ?? "")}</text>`;

  return `<svg viewBox="0 0 ${WIDTH} ${HEIGHT}" xmlns="http://www.w3.org/2000/svg" font-family="system-ui, sans-serif">
  <defs>
    <clipPath id="plotClip"><rect x="${MARGIN.left}" y="${MARGIN.top}" width="${PLOT_W}" height="${PLOT_H}"/></clipPath>
  </defs>
  <rect x="0" y="0" width="${WIDTH}" height="${HEIGHT}" fill="#ffffff"/>
  <rect x="${MARGIN.left}" y="${MARGIN.top}" width="${PLOT_W}" height="${PLOT_H}" fill="${PARCHMENT}"/>
  <g clip-path="url(#plotClip)">${gridLines.join("")}</g>
  <g>${layerPaths.join("")}</g>
  <g>${borderPaths.join("")}</g>
  <g>${coastPaths.join("")}</g>
  <rect x="${MARGIN.left}" y="${MARGIN.top}" width="${PLOT_W}" height="${PLOT_H}" fill="none" stroke="#000000" stroke-width="1"/>
  ${legendBg}
  ${legendItems}
  ${header}
</svg>`;
}
