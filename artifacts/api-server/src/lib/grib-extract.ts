import { runSSHCommand } from "./synergie-sftp.js";

export interface GribGrid {
  ni: number;
  nj: number;
  lat0: number;
  lon0: number;
  lat1: number;
  lon1: number;
  values: number[]; // row-major: row 0 = lat0 (sud), col 0 = lon0 (ouest)
}

// Preambule fiable : sourcer le profil Synergie puis forcer la lecture directe
// des fichiers locaux (SYNERGIE_DEMO=ON) au lieu du webservice distant, qui
// s'est revele instable depuis notre automatisation SSH (voir routes/synergie.ts
// pour l'historique complet de ce diagnostic).
const PROFILE_PREAMBLE = [
  `export HOME=/home/synergie`,
  `export LOGNAME=synergie`,
  `for prof in /home/synergie/client4.7.0/etc/profile /home/synergie/client/etc/profile /home/synergie/.bash_profile /home/synergie/.profile; do [ -f "$prof" ] && . "$prof" 2>/dev/null && break; done`,
  `export PATH=$PATH:/home/synergie/client4.7.0/bin.i686:/home/synergie/client4.7.0/bin:/home/synergie/client/bin`,
  `export SYNERGIE_DEMO=ON`,
  `export GRIB_HOME=/data-space/data/grib`,
  // Si $TYPE_CHARGEMENT vaut ECHEANCE/NIVEAU/ECHEANCE_NIVEAU (heritage de
  // l'environnement du poste), extr_grib_modele.sh bascule en mode "pre-chargement"
  // et renvoie TOUTES les echeances/niveaux standards concatenes (13+ messages
  // GRIB dans un seul fichier) au lieu de la seule valeur demandee — c'est ce qui
  // produisait des grilles "incoherentes" (un multiple exact du nombre de points
  // attendu). On force une extraction a valeur unique.
  `export TYPE_CHARGEMENT=`,
].join("\n");

const GRIB_API_BIN = "/home/synergie/server4.7.0/gribtools/grib_api-1.10.0/bin";

// ─── Serialisation des extractions ───────────────────────────────────────────
// Plusieurs extractions concurrentes (page du briefing chargeant plusieurs
// cartes en parallele + warmer d'arriere-plan) sur la connexion SSH partagee
// ont produit des grilles corrompues (un multiple exact du nombre attendu de
// valeurs, signe d'une interference cote scripts ksh distants qui ne sont pas
// concus pour du concurrent). On serialise donc les extractions ici : chacune
// termine avant que la suivante ne demarre.
let extractChain: Promise<unknown> = Promise.resolve();
function withExtractLock<T>(fn: () => Promise<T>): Promise<T> {
  const result = extractChain.then(fn, fn);
  extractChain = result.then(() => undefined, () => undefined);
  return result;
}

let extractCounter = 0;

// ─── Filtre de message ────────────────────────────────────────────────────────
// extr_grib.sh elargit certaines requetes a plusieurs champs lies (ex: niveau
// 2M/10M/SOL/MER sont toujours demandes ensemble ; PRECIP tire aussi PLUIE,
// NEIGE, PREC_CV, PREC_GE...), donc le fichier extrait contient souvent
// plusieurs messages GRIB concatenes — et pas forcement dans l'ordre attendu
// (confirme empiriquement : pour T.2M, le message "2m" arrive APRES un message
// "heightAboveSea" sans rapport). On filtre donc explicitement par cle GRIB
// pour recuperer le bon message, plutot que de supposer que c'est le premier.
function whereClauseFor(param: string, niveau: string): string | null {
  if (param === "PRECIP") return "shortName=tp";
  if (niveau === "2M") return "typeOfLevel=heightAboveGround,level:l=2";
  if (niveau === "10M") return "typeOfLevel=heightAboveGround,level:l=10";
  const hpa = niveau.match(/^(\d+)HPA$/i);
  if (hpa) return `typeOfLevel=isobaricInhPa,level:l=${hpa[1]}`;
  return null;
}

/**
 * Extrait un champ GRIB (param/niveau/echeance) via extr_grib_modele.sh puis le
 * decode en grille lat/lon/valeur via grib_get_data — contourne entierement
 * visu_modele/X11, qui n'affiche pas les donnees malgre une extraction correcte
 * (voir routes/synergie.ts).
 */
export function extractGribGrid(
  param: string, niveau: string, echeance: string, synDate: string, coordv: string
): Promise<GribGrid> {
  return withExtractLock(() => doExtractGribGrid(param, niveau, echeance, synDate, coordv));
}

async function doExtractGribGrid(
  param: string, niveau: string, echeance: string, synDate: string, coordv: string
): Promise<GribGrid> {
  // Compteur + timestamp : deux appels dans la meme milliseconde (frequent en
  // rafale) ne doivent jamais produire le meme nom de fichier distant.
  const uniq = `${Date.now()}_${++extractCounter}`;
  const tmpFile = `/tmp/synextr_${param}_${uniq}.grib2`;
  const errFile = `/tmp/synextr_err_${uniq}.txt`;
  const where = whereClauseFor(param, niveau);
  const whereFlag = where ? `-w ${where}` : "";

  const script = [
    PROFILE_PREAMBLE,
    `extr_grib_modele.sh US2,${synDate},${param},${niveau},${echeance} GFSAFR025 ${coordv} > ${tmpFile} 2>${errFile}`,
    `SIZE=$(stat -c %s ${tmpFile} 2>/dev/null || echo 0)`,
    `if [ "$SIZE" -lt 100 ]; then echo "__NODATA__"; cat ${errFile} 2>/dev/null; rm -f ${tmpFile} ${errFile}; exit 0; fi`,
    `echo "__GRIDMETA__"`,
    // grib_ls affiche : nom-de-fichier / en-tetes colonnes / valeurs / resume
    // — la ligne 3 contient les valeurs (pas la 2, qui est l'en-tete).
    `${GRIB_API_BIN}/grib_ls ${whereFlag} -p Ni,Nj,latitudeOfFirstGridPointInDegrees,longitudeOfFirstGridPointInDegrees,latitudeOfLastGridPointInDegrees,longitudeOfLastGridPointInDegrees ${tmpFile} 2>/dev/null | sed -n 3p`,
    `echo "__DATA__"`,
    // -M : desactive le support multi-champs GRIB2 (un seul message compte pour
    // plusieurs champs) ; -w cible le message precis si plusieurs sont concatenes.
    `${GRIB_API_BIN}/grib_get_data -M ${whereFlag} ${tmpFile} 2>/dev/null`,
    `rm -f ${tmpFile} ${errFile}`,
  ].join("\n");

  const { stdout } = await runSSHCommand(script);

  if (stdout.includes("__NODATA__")) {
    // Le detail (stderr de extr_grib_modele.sh, ex: erreur SSH/webservice
    // distant, reseau introuvable, etc.) etait lu (`cat ${errFile}`) mais
    // jamais remonte — on ne voyait que "aucune donnee", jamais la vraie
    // cause. On l'inclut desormais dans le message d'erreur.
    const detail = stdout.split("__NODATA__")[1]?.trim();
    throw new Error(
      `Aucune donnée extraite pour ${param}.${niveau}.${echeance} (réseau ${synDate})` +
      (detail ? ` — detail SYABAN02: ${detail}` : "")
    );
  }

  const metaSection = stdout.split("__GRIDMETA__")[1]?.split("__DATA__")[0]?.trim() ?? "";
  const dataSection = stdout.split("__DATA__")[1]?.trim() ?? "";

  const metaParts = metaSection.split(/\s+/).map(Number);
  const [ni, nj, lat0, lon0, lat1, lon1] = metaParts;
  if (!ni || !nj || Number.isNaN(lat0) || Number.isNaN(lon0)) {
    throw new Error(`Métadonnées de grille invalides pour ${param}.${niveau}.${echeance}: "${metaSection}"`);
  }

  const values: number[] = [];
  for (const line of dataSection.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("Latitude")) continue;
    const parts = trimmed.split(/\s+/);
    const value = parseFloat(parts[2] ?? "");
    if (!Number.isNaN(value)) values.push(value);
  }

  if (Math.abs(values.length - ni * nj) > ni + nj) {
    throw new Error(`Grille incohérente pour ${param}.${niveau}.${echeance}: ${values.length} valeurs pour ${ni}x${nj} attendues`);
  }

  return { ni, nj, lat0, lon0, lat1, lon1, values };
}
