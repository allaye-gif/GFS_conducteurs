// Trace des lignes de courant (streamlines) suivant le champ de vent (u,v) —
// style "Flux 850" de Synergie : des filets continus qui suivent la direction
// du vent sur toute la carte, plutot que des barbules ponctuelles. Chaque
// ligne est integree pas a pas (Euler) dans les deux sens depuis un point de
// depart, en interpolant u/v bilineairement sur la grille — puis on seme des
// points de depart sur une grille reguliere en sautant ceux trop proches
// d'une ligne deja tracee, pour obtenir une couverture dense mais sans
// empiler des lignes les unes sur les autres.

export interface StreamlinePath {
  points: [number, number][]; // [lon, lat][], dans l'ordre du trace (suit le vent)
}

function bilinear(
  values: number[], ni: number, nj: number, col: number, row: number
): number | undefined {
  if (col < 0 || row < 0 || col > ni - 1 || row > nj - 1) return undefined;
  const c0 = Math.floor(col), r0 = Math.floor(row);
  const c1 = Math.min(c0 + 1, ni - 1), r1 = Math.min(r0 + 1, nj - 1);
  const tc = col - c0, tr = row - r0;
  const v00 = values[r0 * ni + c0];
  const v10 = values[r0 * ni + c1];
  const v01 = values[r1 * ni + c0];
  const v11 = values[r1 * ni + c1];
  if (v00 === undefined || v10 === undefined || v01 === undefined || v11 === undefined) return undefined;
  const top = v00 + (v10 - v00) * tc;
  const bottom = v01 + (v11 - v01) * tc;
  return top + (bottom - top) * tr;
}

interface TraceOptions {
  u: number[]; v: number[]; ni: number; nj: number;
  lon0: number; lon1: number; lat0: number; lat1: number;
  stepDeg: number; // longueur de pas d'integration, en degres (constante — seule la direction vient de u/v)
  maxSteps: number; // par sens (avant/arriere) — longueur max d'une ligne
  minSpeed: number; // vent en dessous duquel on arrete de tracer (evite les boucles sur du calme plat)
}

// Integre une ligne de courant a partir d'un point (lon,lat), dans un sens
// donne (+1 = suit le vent, -1 = remonte le vent) — Euler simple (pas de RK4 :
// le pas est deja petit devant la maille, et c'est un rendu, pas une
// simulation physique).
function traceOneWay(opts: TraceOptions, startLon: number, startLat: number, dir: 1 | -1): [number, number][] {
  const { u, v, ni, nj, lon0, lon1, lat0, lat1, stepDeg, maxSteps, minSpeed } = opts;
  const lonSpan = lon1 - lon0 || 1;
  const latSpan = lat1 - lat0 || 1;
  const points: [number, number][] = [];
  let lon = startLon, lat = startLat;

  for (let i = 0; i < maxSteps; i++) {
    const col = ((lon - lon0) / lonSpan) * (ni - 1);
    const row = ((lat - lat0) / latSpan) * (nj - 1);
    const uu = bilinear(u, ni, nj, col, row);
    const vv = bilinear(v, ni, nj, col, row);
    if (uu === undefined || vv === undefined) break;
    const speed = Math.hypot(uu, vv);
    if (speed < minSpeed) break;
    points.push([lon, lat]);
    // Direction normalisee (u,v) -> pas de longueur constante en degres, pas
    // proportionnel a la vitesse — sinon les zones de vent fort produiraient
    // des lignes hachees (pas trop grands) et les zones calmes des lignes
    // en accordeon (pas minuscules).
    lon += dir * (uu / speed) * stepDeg;
    lat += dir * (vv / speed) * stepDeg;
    if (lon < lon0 || lon > lon1 || lat < lat0 || lat > lat1) break;
  }
  return points;
}

export function traceStreamlines(
  u: number[], v: number[], ni: number, nj: number,
  lon0: number, lon1: number, lat0: number, lat1: number,
  seedSpacingDeg: number,
  // Region ou semer les points de depart — par defaut toute l'emprise de la
  // grille, mais peut etre restreinte a une sous-region (ex: Mali zoome) pour
  // ne pas gaspiller des semis hors du cadre affiche : sans ca, semer sur
  // toute l'Afrique de l'Ouest puis zoomer sur le Mali ne laisse qu'une
  // poignee de lignes eparses dans la vue finale.
  seedRegion?: { lon0: number; lon1: number; lat0: number; lat1: number }
): StreamlinePath[] {
  const lonSpan = lon1 - lon0 || 1;
  const latSpan = lat1 - lat0 || 1;
  const stepDeg = seedSpacingDeg / 6; // plusieurs pas par maille de semis, pour des courbes lisses
  const opts: TraceOptions = { u, v, ni, nj, lon0, lon1, lat0, lat1, stepDeg, maxSteps: 90, minSpeed: 0.5 };

  const sLon0 = seedRegion?.lon0 ?? lon0;
  const sLon1 = seedRegion?.lon1 ?? lon1;
  const sLat0 = seedRegion?.lat0 ?? lat0;
  const sLat1 = seedRegion?.lat1 ?? lat1;
  const sLonSpan = sLon1 - sLon0 || 1;
  const sLatSpan = sLat1 - sLat0 || 1;

  // Grille d'occupation grossiere (memes pas que le semis) : marque les
  // cellules deja traversees par une ligne pour ne pas re-semer juste a cote
  // et empiler les traces — c'est ce qui donne un espacement regulier plutot
  // qu'un fouillis.
  const occCols = Math.max(1, Math.round(sLonSpan / seedSpacingDeg)) + 1;
  const occRows = Math.max(1, Math.round(sLatSpan / seedSpacingDeg)) + 1;
  const occupied = new Uint8Array(occCols * occRows);
  const occIndex = (lon: number, lat: number) => {
    const c = Math.min(occCols - 1, Math.max(0, Math.round(((lon - sLon0) / sLonSpan) * (occCols - 1))));
    const r = Math.min(occRows - 1, Math.max(0, Math.round(((lat - sLat0) / sLatSpan) * (occRows - 1))));
    return r * occCols + c;
  };

  const paths: StreamlinePath[] = [];

  for (let row = 0; row < occRows; row++) {
    const lat = sLat0 + (row / (occRows - 1 || 1)) * sLatSpan;
    for (let col = 0; col < occCols; col++) {
      const lon = sLon0 + (col / (occCols - 1 || 1)) * sLonSpan;
      if (occupied[row * occCols + col]) continue;

      const back = traceOneWay(opts, lon, lat, -1).reverse();
      const fwd = traceOneWay(opts, lon, lat, 1);
      const full = [...back, ...(back.length ? fwd.slice(1) : fwd)];
      if (full.length < 6) continue; // trop court pour etre visible/utile

      for (const [plon, plat] of full) occupied[occIndex(plon, plat)] = 1;
      paths.push({ points: full });
    }
  }

  return paths;
}
