// Tourbillon absolu (vorticité relative + planétaire) à partir des composantes
// de vent U/V d'un niveau — sert au "champ spécial" combinant 850/700/200 hPa
// pour repérer le couplage convergence basse couche / divergence en altitude,
// une technique classique de diagnostic synoptique (onde d'est africaine,
// zones favorables à la convection).

import type { GribGrid } from "./grib-extract.js";
import { smoothField } from "./grib-contour.js";

const EARTH_RADIUS_M = 6_371_000;
const OMEGA = 7.2921159e-5; // vitesse angulaire de rotation terrestre (rad/s)

/**
 * Calcule le tourbillon absolu ζ+f à partir de deux grilles U/V (memes
 * dimensions/emprise), en degres->metres pour rester en unites physiques
 * (s^-1) plutot qu'en "par cellule de grille". Retourne les valeurs a
 * l'echelle x10^7 (unite d'affichage usuelle : f vaut deja ~300-400 vers
 * 12-15°N sous cette echelle, ce qui calibre naturellement les plages
 * 10-1000 utilisees pour 850/700 hPa).
 *
 * U et V sont legerement lisses (sigma=1 cellule) avant de deriver — une
 * derivee amplifie enormement le bruit de grille/troncature spectrale d'un
 * champ de vent brut a 0.25°, ce qui produit sinon un tourbillon "poivre et
 * sel" sans rapport avec la structure atmospherique reelle (confirme par
 * comparaison avec une vraie carte Synergie "TA", dont la texture est fine
 * mais organique, pas un bruit de calcul). Ce lissage est volontairement
 * leger — contrairement a PMER, on veut garder la structure turbulente reelle,
 * juste retirer le bruit numerique pur.
 */
export function computeAbsoluteVorticityX1e7(uGrid: GribGrid, vGrid: GribGrid): number[] {
  const { ni, nj, lat0, lon0, lat1, lon1 } = uGrid;
  const lonSpan = lon1 - lon0 || 1;
  const latSpan = lat1 - lat0 || 1;
  const dLonRad = (lonSpan / (ni - 1)) * (Math.PI / 180);
  const dLatRad = (latSpan / (nj - 1)) * (Math.PI / 180);

  const U = smoothField(uGrid.values, ni, nj, 1);
  const V = smoothField(vGrid.values, ni, nj, 1);
  const at = (arr: number[], r: number, c: number) =>
    arr[Math.min(nj - 1, Math.max(0, r)) * ni + Math.min(ni - 1, Math.max(0, c))]!;

  const out = new Array<number>(ni * nj);
  for (let row = 0; row < nj; row++) {
    const lat = lat0 + (row / (nj - 1)) * latSpan;
    const latRad = (lat * Math.PI) / 180;
    const dx = dLonRad * EARTH_RADIUS_M * Math.max(0.05, Math.cos(latRad)); // garde-fou pres de l'equateur/poles
    const dy = dLatRad * EARTH_RADIUS_M;
    const f = 2 * OMEGA * Math.sin(latRad);

    for (let col = 0; col < ni; col++) {
      const dvdx = (at(V, row, col + 1) - at(V, row, col - 1)) / (2 * dx);
      const dudy = (at(U, row + 1, col) - at(U, row - 1, col)) / (2 * dy);
      const zetaAbs = dvdx - dudy + f;
      out[row * ni + col] = zetaAbs * 1e7;
    }
  }
  return out;
}
