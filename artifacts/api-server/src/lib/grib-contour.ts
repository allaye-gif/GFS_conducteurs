// Traçage d'isolignes (isobares/isothermes) par marching squares sur la grille
// GRIB pleine résolution — c'est ce qui rapproche le rendu d'une vraie carte
// synoptique (Synergie/aviation) au lieu d'un simple aplat de couleur.

export interface ContourPath {
  level: number;
  points: [number, number][]; // [lon, lat][]
}

interface Point {
  x: number;
  y: number;
}

// Interpole la position d'un croisement de niveau le long d'une arête dont les
// deux extrémités valent va (en a) et vb (en b).
function interp(level: number, va: number, a: Point, vb: number, b: Point): Point {
  const t = (level - va) / (vb - va || 1e-9);
  return { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) };
}

/**
 * Trace les isolignes d'un champ scalaire `field` (grille row-major ni x nj,
 * row 0 = sud) pour chaque niveau de `levels`, dans l'espace lon/lat. Fusionne
 * les segments de marching squares contigus en polylignes continues (plutôt
 * que des milliers de petits traits déconnectés) via chaînage par extrémités.
 */
export function traceContours(
  field: number[], ni: number, nj: number,
  lon0: number, lon1: number, lat0: number, lat1: number,
  levels: number[]
): ContourPath[] {
  const lonSpan = lon1 - lon0 || 1;
  const latSpan = lat1 - lat0 || 1;
  const lonAt = (col: number) => lon0 + (col / (ni - 1)) * lonSpan;
  const latAt = (row: number) => lat0 + (row / (nj - 1)) * latSpan;

  const results: ContourPath[] = [];

  for (const level of levels) {
    const segments: [Point, Point][] = [];

    for (let row = 0; row < nj - 1; row++) {
      for (let col = 0; col < ni - 1; col++) {
        const vbl = field[row * ni + col];
        const vbr = field[row * ni + col + 1];
        const vtl = field[(row + 1) * ni + col];
        const vtr = field[(row + 1) * ni + col + 1];
        if (vbl === undefined || vbr === undefined || vtl === undefined || vtr === undefined) continue;

        const bl: Point = { x: lonAt(col), y: latAt(row) };
        const br: Point = { x: lonAt(col + 1), y: latAt(row) };
        const tl: Point = { x: lonAt(col), y: latAt(row + 1) };
        const tr: Point = { x: lonAt(col + 1), y: latAt(row + 1) };

        // Croisements sur chacune des 4 arêtes (bas, droite, haut, gauche).
        const crossings: Point[] = [];
        if ((vbl < level) !== (vbr < level)) crossings.push(interp(level, vbl, bl, vbr, br));
        if ((vbr < level) !== (vtr < level)) crossings.push(interp(level, vbr, br, vtr, tr));
        if ((vtl < level) !== (vtr < level)) crossings.push(interp(level, vtl, tl, vtr, tr));
        if ((vbl < level) !== (vtl < level)) crossings.push(interp(level, vbl, bl, vtl, tl));

        if (crossings.length === 2) {
          segments.push([crossings[0]!, crossings[1]!]);
        } else if (crossings.length === 4) {
          // Cas de selle (diagonales opposées de part et d'autre du niveau) —
          // on apparie via la moyenne des 4 coins pour choisir la connexion
          // qui ne traverse pas la diagonale "haute".
          const avg = (vbl + vbr + vtl + vtr) / 4;
          if (avg < level) {
            segments.push([crossings[0]!, crossings[3]!]);
            segments.push([crossings[1]!, crossings[2]!]);
          } else {
            segments.push([crossings[0]!, crossings[1]!]);
            segments.push([crossings[2]!, crossings[3]!]);
          }
        }
      }
    }

    results.push(...chainSegments(segments, level));
  }

  return results;
}

/**
 * Lissage gaussien separable du champ avant contourage. Sans ca, le champ GFS
 * a pleine resolution (0.25°) produit des isolignes fragmentees en centaines
 * de petits contours fermes paras (aspect "confetti") au lieu de lignes
 * synoptiques continues traversant tout le domaine — cf. capture Synergie de
 * reference, dont les isobares sont longues et lisses.
 */
export function smoothField(field: number[], ni: number, nj: number, sigma: number): number[] {
  const radius = Math.max(1, Math.ceil(sigma * 3));
  const kernel: number[] = [];
  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    const w = Math.exp(-(i * i) / (2 * sigma * sigma));
    kernel.push(w);
    sum += w;
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] = kernel[i]! / sum;

  const temp = new Array<number>(field.length);
  for (let row = 0; row < nj; row++) {
    for (let col = 0; col < ni; col++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) {
        const c = Math.min(ni - 1, Math.max(0, col + k));
        acc += field[row * ni + c]! * kernel[k + radius]!;
      }
      temp[row * ni + col] = acc;
    }
  }

  const out = new Array<number>(field.length);
  for (let row = 0; row < nj; row++) {
    for (let col = 0; col < ni; col++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) {
        const r = Math.min(nj - 1, Math.max(0, row + k));
        acc += temp[r * ni + col]! * kernel[k + radius]!;
      }
      out[row * ni + col] = acc;
    }
  }
  return out;
}

export interface Extremum {
  lon: number;
  lat: number;
  value: number;
  kind: "max" | "min";
}

/**
 * Detecte les centres de haute/basse pression (ou tout extremum local) sur le
 * champ lisse : un point est retenu s'il est strictement le plus fort/faible
 * de tous ses voisins dans un rayon de `windowDeg`/2. Deduplique ensuite les
 * candidats trop proches (`minSeparationDeg`) en gardant le plus extreme, et
 * ignore une marge en bord de domaine (un "extremum" sur le bord n'est souvent
 * qu'un artefact de coupure, pas un vrai systeme ferme).
 */
export function findExtrema(
  field: number[], ni: number, nj: number,
  lon0: number, lon1: number, lat0: number, lat1: number,
  opts: { marginFrac?: number; windowDeg?: number; minSeparationDeg?: number; maxCount?: number } = {}
): Extremum[] {
  const marginFrac = opts.marginFrac ?? 0.08;
  const windowDeg = opts.windowDeg ?? 5;
  const minSeparationDeg = opts.minSeparationDeg ?? 5;
  const maxCount = opts.maxCount ?? 6;

  const lonSpan = lon1 - lon0 || 1;
  const latSpan = lat1 - lat0 || 1;
  const dLon = lonSpan / (ni - 1);
  const dLat = latSpan / (nj - 1);
  const rCols = Math.max(1, Math.round(windowDeg / 2 / dLon));
  const rRows = Math.max(1, Math.round(windowDeg / 2 / dLat));

  const marginCols = Math.round(ni * marginFrac);
  const marginRows = Math.round(nj * marginFrac);

  type Candidate = { row: number; col: number; value: number; kind: "max" | "min" };
  const candidates: Candidate[] = [];

  for (let row = marginRows; row < nj - marginRows; row++) {
    for (let col = marginCols; col < ni - marginCols; col++) {
      const v = field[row * ni + col]!;
      let isMax = true;
      let isMin = true;
      for (let dr = -rRows; dr <= rRows && (isMax || isMin); dr++) {
        for (let dc = -rCols; dc <= rCols && (isMax || isMin); dc++) {
          if (dr === 0 && dc === 0) continue;
          const r = row + dr;
          const c = col + dc;
          if (r < 0 || r >= nj || c < 0 || c >= ni) continue;
          const nv = field[r * ni + c]!;
          if (nv > v) isMax = false;
          if (nv < v) isMin = false;
        }
      }
      if (isMax) candidates.push({ row, col, value: v, kind: "max" });
      if (isMin) candidates.push({ row, col, value: v, kind: "min" });
    }
  }

  const results: Extremum[] = [];
  for (const kind of ["max", "min"] as const) {
    const list = candidates
      .filter(c => c.kind === kind)
      .sort((a, b) => (kind === "max" ? b.value - a.value : a.value - b.value));
    const selected: Candidate[] = [];
    for (const cand of list) {
      const lon = lon0 + cand.col * dLon;
      const lat = lat0 + cand.row * dLat;
      const tooClose = selected.some(s => {
        const slon = lon0 + s.col * dLon;
        const slat = lat0 + s.row * dLat;
        return Math.hypot(lon - slon, lat - slat) < minSeparationDeg;
      });
      if (!tooClose) selected.push(cand);
      if (selected.length >= maxCount) break;
    }
    for (const s of selected) {
      results.push({ lon: lon0 + s.col * dLon, lat: lat0 + s.row * dLat, value: s.value, kind });
    }
  }
  return results;
}

// Chaîne des segments isolés bout-à-bout en polylignes continues en associant
// les extrémités qui coïncident exactement (les cellules voisines calculent le
// même point d'intersection sur une arête partagée).
function chainSegments(segments: [Point, Point][], level: number): ContourPath[] {
  const key = (p: Point) => `${p.x.toFixed(5)},${p.y.toFixed(5)}`;
  const byEndpoint = new Map<string, { seg: [Point, Point]; used: boolean }[]>();
  const entries = segments.map(seg => ({ seg, used: false }));
  for (const e of entries) {
    for (const p of [e.seg[0], e.seg[1]]) {
      const k = key(p);
      if (!byEndpoint.has(k)) byEndpoint.set(k, []);
      byEndpoint.get(k)!.push(e);
    }
  }

  const paths: ContourPath[] = [];
  for (const start of entries) {
    if (start.used) continue;
    start.used = true;
    const chain: Point[] = [start.seg[0], start.seg[1]];

    // Etend vers l'avant tant qu'on trouve un segment inutilise partageant l'extremite.
    let extended = true;
    while (extended) {
      extended = false;
      const tail = chain[chain.length - 1]!;
      const candidates = byEndpoint.get(key(tail)) ?? [];
      for (const cand of candidates) {
        if (cand.used) continue;
        const [a, b] = cand.seg;
        if (key(a) === key(tail)) {
          chain.push(b);
          cand.used = true;
          extended = true;
          break;
        } else if (key(b) === key(tail)) {
          chain.push(a);
          cand.used = true;
          extended = true;
          break;
        }
      }
    }

    if (chain.length >= 2) {
      paths.push({ level, points: chain.map(p => [p.x, p.y]) });
    }
  }
  return paths;
}
