// Détection des axes de dorsale (ridge) et de thalweg (trough) sur un champ de
// pression — la définition météorologique standard (une dorsale prolonge un
// anticyclone, un thalweg prolonge une dépression, cf. Futura-Sciences/
// ScienceGuys/NOAA jetstream) correspond mathématiquement à la définition
// "height ridge/valley" utilisée en analyse de terrain : l'axe est le lieu des
// points où la dérivée directionnelle du champ, prise selon la direction de
// courbure principale, s'annule — et cette courbure principale (valeur propre
// du Hessien) doit être suffisamment marquée (concave pour une dorsale,
// convexe pour un thalweg). On réutilise le traceur d'isolignes existant en
// lui donnant le champ dérivé "dérivée directionnelle" et en masquant les
// points où la courbure n'est pas assez marquée.
//
// Le calcul se fait sur une grille fortement degradee (~1.5° au lieu des 0.25°
// natifs) : le Hessien (derivee seconde) amplifie enormement le bruit residuel,
// et calcule sur la grille fine, il produit des lignes en dents de scie
// illisibles ("confetti" du meme genre que les isobares avant lissage, en pire
// car on derive deux fois). Sur une grille grossiere, deja quasi plate a cette
// echelle apres lissage, les lignes ressortent naturellement longues et
// propres sans post-traitement de simplification.

import { smoothField, traceContours, type ContourPath } from "./grib-contour.js";

interface Deriv2D {
  fx: number; fy: number; fxx: number; fyy: number; fxy: number;
}

// Derivees en unite "par degre" / "par degre^2" (pas par cellule de grille) —
// rend le seuil de courbure independant de la resolution de la grille utilisee.
function computeDerivatives(field: number[], ni: number, nj: number, row: number, col: number, dLon: number, dLat: number): Deriv2D {
  const at = (r: number, c: number) => field[Math.min(nj - 1, Math.max(0, r)) * ni + Math.min(ni - 1, Math.max(0, c))]!;
  const c0 = at(row, col);
  const fx = (at(row, col + 1) - at(row, col - 1)) / (2 * dLon);
  const fy = (at(row + 1, col) - at(row - 1, col)) / (2 * dLat);
  const fxx = (at(row, col + 1) - 2 * c0 + at(row, col - 1)) / (dLon * dLon);
  const fyy = (at(row + 1, col) - 2 * c0 + at(row - 1, col)) / (dLat * dLat);
  const fxy = (at(row + 1, col + 1) - at(row + 1, col - 1) - at(row - 1, col + 1) + at(row - 1, col - 1)) / (4 * dLon * dLat);
  return { fx, fy, fxx, fyy, fxy };
}

// Valeurs propres + vecteur propre du Hessien 2x2 [[fxx,fxy],[fxy,fyy]].
function eigen(fxx: number, fxy: number, fyy: number) {
  const mean = (fxx + fyy) / 2;
  const diff = (fxx - fyy) / 2;
  const r = Math.sqrt(diff * diff + fxy * fxy);
  const lambdaMax = mean + r; // valeur propre la plus positive (convexe -> creux/thalweg)
  const lambdaMin = mean - r; // valeur propre la plus negative (concave -> crete/dorsale)

  function vecFor(lambda: number): { x: number; y: number } {
    if (Math.abs(fxy) > 1e-9) {
      const vx = fxy;
      const vy = lambda - fxx;
      const norm = Math.hypot(vx, vy) || 1;
      return { x: vx / norm, y: vy / norm };
    }
    // Hessien deja diagonal : les axes propres sont les axes x/y.
    return Math.abs(fxx - lambda) < Math.abs(fyy - lambda) ? { x: 0, y: 1 } : { x: 1, y: 0 };
  }

  return { lambdaMin, lambdaMax, vecMin: vecFor(lambdaMin), vecMax: vecFor(lambdaMax) };
}

// Ré-échantillonne un champ (bilineaire) vers une grille plus grossiere de
// dimensions cibles, sur la meme emprise geographique.
function resampleBilinear(field: number[], ni: number, nj: number, newNi: number, newNj: number): number[] {
  const out = new Array<number>(newNi * newNj);
  for (let r = 0; r < newNj; r++) {
    const fy = newNj === 1 ? 0 : (r / (newNj - 1)) * (nj - 1);
    const y0 = Math.floor(fy), y1 = Math.min(nj - 1, y0 + 1);
    const ty = fy - y0;
    for (let c = 0; c < newNi; c++) {
      const fx = newNi === 1 ? 0 : (c / (newNi - 1)) * (ni - 1);
      const x0 = Math.floor(fx), x1 = Math.min(ni - 1, x0 + 1);
      const tx = fx - x0;
      const v00 = field[y0 * ni + x0]!;
      const v10 = field[y0 * ni + x1]!;
      const v01 = field[y1 * ni + x0]!;
      const v11 = field[y1 * ni + x1]!;
      const top = v00 + (v10 - v00) * tx;
      const bot = v01 + (v11 - v01) * tx;
      out[r * newNi + c] = top + (bot - top) * ty;
    }
  }
  return out;
}

export interface RidgeTroughResult {
  ridges: ContourPath[]; // axes de dorsale
  troughs: ContourPath[]; // axes de thalweg
}

export interface RidgeTroughOptions {
  curvatureThreshold?: number; // seuil minimal de |valeur propre| en unite du champ / degre^2
  coarseSpacingDeg?: number; // maille de la grille degradee utilisee pour le calcul (degres)
}

/**
 * Calcule les axes de dorsale et de thalweg d'un champ scalaire (deja dans
 * l'unite affichee, ex: hPa) sur une grille lon/lat reguliere.
 */
export function findRidgesAndTroughs(
  field: number[], ni: number, nj: number,
  lon0: number, lon1: number, lat0: number, lat1: number,
  opts: RidgeTroughOptions = {}
): RidgeTroughResult {
  const curvatureThreshold = opts.curvatureThreshold ?? 0.12;
  const coarseSpacingDeg = opts.coarseSpacingDeg ?? 1.6;

  const lonSpan = lon1 - lon0 || 1;
  const latSpan = lat1 - lat0 || 1;

  // Champ deja lisse (meme lissage que les isobares) puis fortement degrade —
  // c'est la degradation de resolution, pas un lissage plus fort au meme pas,
  // qui elimine le jitter du Hessien.
  const smooth = smoothField(field, ni, nj, 2);
  const cNi = Math.max(10, Math.min(48, Math.round(lonSpan / coarseSpacingDeg) + 1));
  const cNj = Math.max(10, Math.min(48, Math.round(latSpan / coarseSpacingDeg) + 1));
  const coarse = resampleBilinear(smooth, ni, nj, cNi, cNj);

  const dLon = lonSpan / (cNi - 1);
  const dLat = latSpan / (cNj - 1);

  const ridgeDeriv: (number | undefined)[] = new Array(cNi * cNj).fill(undefined);
  const troughDeriv: (number | undefined)[] = new Array(cNi * cNj).fill(undefined);

  const margin = 1;
  for (let row = margin; row < cNj - margin; row++) {
    for (let col = margin; col < cNi - margin; col++) {
      const { fx, fy, fxx, fyy, fxy } = computeDerivatives(coarse, cNi, cNj, row, col, dLon, dLat);
      const { lambdaMin, lambdaMax, vecMin, vecMax } = eigen(fxx, fxy, fyy);
      const idx = row * cNi + col;

      // Dorsale : courbure concave marquee (valeur propre negative, direction
      // vecMin = direction "en travers" de la crete) — l'axe est le lieu ou la
      // derivee directionnelle projetee sur cette direction s'annule.
      if (lambdaMin < -curvatureThreshold) {
        ridgeDeriv[idx] = fx * vecMin.x + fy * vecMin.y;
      }
      // Thalweg : courbure convexe marquee (valeur propre positive, direction
      // vecMax = direction "en travers" du creux).
      if (lambdaMax > curvatureThreshold) {
        troughDeriv[idx] = fx * vecMax.x + fy * vecMax.y;
      }
    }
  }

  const ridges = traceContours(ridgeDeriv as number[], cNi, cNj, lon0, lon1, lat0, lat1, [0]);
  const troughs = traceContours(troughDeriv as number[], cNi, cNj, lon0, lon1, lat0, lat1, [0]);

  return { ridges, troughs };
}
