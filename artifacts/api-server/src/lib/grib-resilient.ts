// Extraction "resiliente" : au lieu de fixer un seul cycle (reseau) et
// d'echouer si le champ precis n'a pas encore ete ecrit sur SYABAN02 (fichier
// present mais vide — confirme par inspection directe : ingestion progressive,
// pas instantanee), on essaie le cycle le plus recent capable d'atteindre
// l'heure cible, et si CE champ precis echoue, on recule automatiquement au
// cycle precedent (12h plus tot), jusqu'a `maxCycles` tentatives. Deux champs
// differents (ex: T2M vs vent) peuvent ainsi finir sur des cycles differents
// pour une meme requete — c'est le but explicite : ne jamais renvoyer
// "aucune donnee" tant qu'un cycle plus ancien est deja complet.
import { extractGribGrid, type GribGrid } from "./grib-extract.js";

function dateStr(d: Date): string {
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
}

// Point de depart du balayage : le cycle le plus recent avec >=2h de marge
// (meme heuristique que resolveSynergieReseau, dupliquee ici volontairement —
// ce module descend ensuite plus loin dans le passe que resolveSynergieReseau,
// qui ne regarde qu'un seul repli).
function mostRecentCandidate(): { date: Date; hour: number } {
  const now = new Date();
  const nowHour = now.getUTCHours();
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (nowHour - 12 >= 2) return { date, hour: 12 };
  if (nowHour - 0 >= 2) return { date, hour: 0 };
  date.setUTCDate(date.getUTCDate() - 1);
  return { date, hour: 12 };
}

function stepBack(c: { date: Date; hour: number }): { date: Date; hour: number } {
  if (c.hour === 12) return { date: c.date, hour: 0 };
  const prevDay = new Date(c.date);
  prevDay.setUTCDate(prevDay.getUTCDate() - 1);
  return { date: prevDay, hour: 12 };
}

export interface ResilientResult { grid: GribGrid; reseau: string; synDate: string; echeance: string; }

export async function extractResilient(
  param: string, niveau: string, coordv: string,
  targetDate: Date, targetHour: number, maxCycles = 6
): Promise<ResilientResult> {
  let cursor = mostRecentCandidate();
  let lastErr: unknown;
  for (let i = 0; i < maxCycles; i++) {
    const dayOffset = Math.round((targetDate.getTime() - cursor.date.getTime()) / 86_400_000);
    const echeanceNum = dayOffset * 24 + targetHour - cursor.hour;
    if (echeanceNum >= 3) {
      const synDate = `${dateStr(cursor.date)}${String(cursor.hour).padStart(2, "0")}0000`;
      try {
        const grid = await extractGribGrid(param, niveau, `${echeanceNum}H`, synDate, coordv);
        return { grid, reseau: `${String(cursor.hour).padStart(2, "0")}H`, synDate, echeance: `${echeanceNum}H` };
      } catch (e) {
        lastErr = e;
      }
    }
    cursor = stepBack(cursor);
  }
  throw lastErr ?? new Error(`Aucun cycle disponible pour ${param}.${niveau} (cible ${targetHour}h)`);
}

export interface ResilientPairResult { gridA: GribGrid; gridB: GribGrid; reseau: string; synDate: string; echeance: string; }

// Variante pour un couple de champs qui doivent venir du MEME cycle/echeance
// (ex: U/V du vent — les melanger entre deux cycles differents produirait un
// vecteur vent qui n'a pas de sens physique).
export async function extractResilientPair(
  paramA: string, paramB: string, niveau: string, coordv: string,
  targetDate: Date, targetHour: number, maxCycles = 6
): Promise<ResilientPairResult> {
  let cursor = mostRecentCandidate();
  let lastErr: unknown;
  for (let i = 0; i < maxCycles; i++) {
    const dayOffset = Math.round((targetDate.getTime() - cursor.date.getTime()) / 86_400_000);
    const echeanceNum = dayOffset * 24 + targetHour - cursor.hour;
    if (echeanceNum >= 3) {
      const synDate = `${dateStr(cursor.date)}${String(cursor.hour).padStart(2, "0")}0000`;
      try {
        const [gridA, gridB] = await Promise.all([
          extractGribGrid(paramA, niveau, `${echeanceNum}H`, synDate, coordv),
          extractGribGrid(paramB, niveau, `${echeanceNum}H`, synDate, coordv),
        ]);
        return { gridA, gridB, reseau: `${String(cursor.hour).padStart(2, "0")}H`, synDate, echeance: `${echeanceNum}H` };
      } catch (e) {
        lastErr = e;
      }
    }
    cursor = stepBack(cursor);
  }
  throw lastErr ?? new Error(`Aucun cycle disponible pour ${paramA}/${paramB}.${niveau} (cible ${targetHour}h)`);
}
