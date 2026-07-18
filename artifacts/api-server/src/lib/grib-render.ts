import type { GribGrid } from "./grib-extract.js";
import { COASTLINE_WEST_AFRICA } from "./grib-coastline.js";

// Reperes visuels : quelques capitales/grandes villes d'Afrique de l'Ouest pour
// s'orienter sur la carte sans avoir a deviner a partir du seul quadrillage.
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

export interface RenderOptions {
  title: string;
  subtitle: string;
  unit: string;
  min: number;
  max: number;
  stops: ColorStop[];
  transform: (raw: number) => number; // ex: Pa -> hPa, K -> C
  legendTicks?: number;
}

const WIDTH = 900;
const HEIGHT = 640;
const MARGIN = { top: 56, right: 40, bottom: 90, left: 56 };
const PLOT_W = WIDTH - MARGIN.left - MARGIN.right;
const PLOT_H = HEIGHT - MARGIN.top - MARGIN.bottom;

// Sous-echantillonnage pour garder un SVG raisonnable (grille source ~221x161).
const STEP = 2;

export function renderGribSvg(grid: GribGrid, opts: RenderOptions): string {
  const { ni, nj, lat0, lon0, lat1, lon1, values } = grid;
  const lonSpan = lon1 - lon0 || 1;
  const latSpan = lat1 - lat0 || 1;

  const xFor = (lon: number) => MARGIN.left + ((lon - lon0) / lonSpan) * PLOT_W;
  const yFor = (lat: number) => MARGIN.top + (1 - (lat - lat0) / latSpan) * PLOT_H;

  const cellW = (PLOT_W / ni) * STEP;
  const cellH = (PLOT_H / nj) * STEP;

  const rects: string[] = [];
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

  // Traits de côte — dessines par-dessus le remplissage couleur pour rester
  // visibles, avec un clip pour ne jamais deborder de la zone du graphique.
  const coastPaths: string[] = [];
  for (const line of COASTLINE_WEST_AFRICA) {
    const d = line
      .map(([lon, lat], i) => `${i === 0 ? "M" : "L"}${xFor(lon).toFixed(1)},${yFor(lat).toFixed(1)}`)
      .join(" ");
    coastPaths.push(`<path d="${d}" fill="none" stroke="#1e293b" stroke-width="1" stroke-linejoin="round" clip-path="url(#plotClip)"/>`);
  }

  // Villes de repère
  const cityMarkers: string[] = [];
  for (const city of CITIES) {
    if (city.lon < lon0 || city.lon > lon1 || city.lat < lat0 || city.lat > lat1) continue;
    const x = xFor(city.lon);
    const y = yFor(city.lat);
    cityMarkers.push(
      `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.5" fill="#0f172a" stroke="#ffffff" stroke-width="0.8"/>` +
      `<text x="${(x + 5).toFixed(1)}" y="${(y + 3.5).toFixed(1)}" font-size="10.5" fill="#0f172a" paint-order="stroke" stroke="#ffffff" stroke-width="3">${escapeXml(city.name)}</text>`
    );
  }

  // Grille lat/lon + labels
  const gridLines: string[] = [];
  const lonStep = lonSpan > 40 ? 10 : 5;
  const latStep = latSpan > 30 ? 10 : 5;
  for (let lon = Math.ceil(lon0 / lonStep) * lonStep; lon <= lon1; lon += lonStep) {
    const x = xFor(lon);
    gridLines.push(`<line x1="${x.toFixed(1)}" y1="${MARGIN.top}" x2="${x.toFixed(1)}" y2="${MARGIN.top + PLOT_H}" stroke="#94a3b8" stroke-width="0.5" stroke-dasharray="2,2"/>`);
    gridLines.push(`<text x="${x.toFixed(1)}" y="${MARGIN.top + PLOT_H + 18}" font-size="11" fill="#334155" text-anchor="middle">${lon}°</text>`);
  }
  for (let lat = Math.ceil(lat0 / latStep) * latStep; lat <= lat1; lat += latStep) {
    const y = yFor(lat);
    gridLines.push(`<line x1="${MARGIN.left}" y1="${y.toFixed(1)}" x2="${MARGIN.left + PLOT_W}" y2="${y.toFixed(1)}" stroke="#94a3b8" stroke-width="0.5" stroke-dasharray="2,2"/>`);
    gridLines.push(`<text x="${MARGIN.left - 8}" y="${(y + 4).toFixed(1)}" font-size="11" fill="#334155" text-anchor="end">${lat}°N</text>`);
  }

  // Legende (barre de couleur horizontale)
  const legendX = MARGIN.left;
  const legendY = HEIGHT - 42;
  const legendW = PLOT_W;
  const legendH = 16;
  const legendStops = 40;
  const legendRects: string[] = [];
  for (let i = 0; i < legendStops; i++) {
    const t0 = i / legendStops;
    const x = legendX + t0 * legendW;
    const w = legendW / legendStops;
    legendRects.push(`<rect x="${x.toFixed(1)}" y="${legendY}" width="${(w + 0.5).toFixed(1)}" height="${legendH}" fill="${colorAt(opts.stops, t0)}"/>`);
  }
  const ticks = opts.legendTicks ?? 5;
  const legendLabels: string[] = [];
  for (let i = 0; i <= ticks; i++) {
    const t = i / ticks;
    const val = opts.min + t * (opts.max - opts.min);
    const x = legendX + t * legendW;
    legendLabels.push(`<text x="${x.toFixed(1)}" y="${legendY + legendH + 16}" font-size="11" fill="#334155" text-anchor="middle">${val.toFixed(0)}</text>`);
  }

  return `<svg viewBox="0 0 ${WIDTH} ${HEIGHT}" xmlns="http://www.w3.org/2000/svg" font-family="system-ui, sans-serif">
  <defs>
    <clipPath id="plotClip"><rect x="${MARGIN.left}" y="${MARGIN.top}" width="${PLOT_W}" height="${PLOT_H}"/></clipPath>
  </defs>
  <rect x="0" y="0" width="${WIDTH}" height="${HEIGHT}" fill="#ffffff"/>
  <text x="${MARGIN.left}" y="26" font-size="18" font-weight="600" fill="#0f172a">${escapeXml(opts.title)}</text>
  <text x="${MARGIN.left}" y="44" font-size="12" fill="#64748b">${escapeXml(opts.subtitle)}</text>
  <g>${rects.join("")}</g>
  <g>${gridLines.join("")}</g>
  <g>${coastPaths.join("")}</g>
  <g>${cityMarkers.join("")}</g>
  <rect x="${MARGIN.left}" y="${MARGIN.top}" width="${PLOT_W}" height="${PLOT_H}" fill="none" stroke="#1e293b" stroke-width="1"/>
  <g>${legendRects.join("")}</g>
  <rect x="${legendX}" y="${legendY}" width="${legendW}" height="${legendH}" fill="none" stroke="#1e293b" stroke-width="1"/>
  <g>${legendLabels.join("")}</g>
  <text x="${legendX + legendW}" y="${legendY - 6}" font-size="11" fill="#334155" text-anchor="end">${escapeXml(opts.unit)}</text>
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
} as const;
