import { getWaffgsLatestTime } from "./waffgs-proxy";
import { computeSynergieReseau } from "./synergie-sftp.js";

export type BriefingContentType = "images" | "iframe" | "external" | "upload";

export interface BriefingChartItem {
  id: string;
  label: string;
  url: string;
  description: string | null;
}

export interface BriefingSubsection {
  label: string;
  charts: BriefingChartItem[];
}

export interface IframeModel {
  label: string;
  url: string;
}

export interface BriefingSection {
  id: string;
  name: string;
  contentType: BriefingContentType;
  subsections: BriefingSubsection[];
  iframeUrl?: string;
  iframeAlternatives?: IframeModel[];
  externalUrl?: string;
  externalLabel?: string;
  externalDescription?: string;
}

export interface BriefingCatalogResult {
  sections: BriefingSection[];
  gfsCycle: string;
  ecmwfBaseTime: string | null;
  fetchedAt: string;
}

// ─── Briefing time (snap 09:30 UTC) ───────────────────────────────────────────
function getMorningBriefingTime(): string {
  const now = new Date();
  const today930 = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 9, 30, 0, 0
  ));
  const briefingTime = now < today930
    ? new Date(today930.getTime() - 24 * 60 * 60 * 1000)
    : today930;
  return briefingTime.toISOString();
}

// ─── GFS Cycle detection ───────────────────────────────────────────────────────
const CYCLES = ["00", "06", "12", "18"] as const;
type Cycle = (typeof CYCLES)[number];
let gfsCycleCache: { cycle: Cycle; expiresAt: number } | null = null;

async function detectGfsCycle(): Promise<Cycle> {
  const now = Date.now();
  if (gfsCycleCache && now < gfsCycleCache.expiresAt) return gfsCycleCache.cycle;
  const results = await Promise.all(
    CYCLES.map(async (c) => {
      const url = `https://www.cpc.ncep.noaa.gov/products/international/cpci/data/${c}/gfs.t${c}z.mslp_6h_totp.f006.wafrica.gif`;
      try {
        const res = await fetch(url, {
          method: "HEAD",
          headers: { "User-Agent": "Mozilla/5.0", Referer: "https://www.cpc.ncep.noaa.gov/" },
          signal: AbortSignal.timeout(8000),
        });
        const lm = res.ok ? new Date(res.headers.get("last-modified") ?? "").getTime() : 0;
        return { cycle: c, ts: isNaN(lm) ? 0 : lm };
      } catch { return { cycle: c, ts: 0 }; }
    })
  );
  const best = results.reduce((a, b) => (b.ts > a.ts ? b : a));
  const chosen = best.ts > 0 ? best.cycle : "06";
  gfsCycleCache = { cycle: chosen, expiresAt: now + 20 * 60 * 1000 };
  return chosen;
}

function cpcUrl(cycle: string, param: string, fhr: string): string {
  return `https://www.cpc.ncep.noaa.gov/products/international/cpci/data/${cycle}/gfs.t${cycle}z.${param}.f${String(fhr).padStart(3, "0")}.wafrica.gif`;
}

function cpcCharts(cycle: string, param: string, baseLabel: string, baseId: string, desc: string | null = null): BriefingChartItem[] {
  return [
    { id: `${baseId}-06`, label: `${baseLabel} +6h`, url: cpcUrl(cycle, param, "006"), description: desc },
    { id: `${baseId}-12`, label: `${baseLabel} +12h`, url: cpcUrl(cycle, param, "012"), description: null },
    { id: `${baseId}-18`, label: `${baseLabel} +18h`, url: cpcUrl(cycle, param, "018"), description: null },
    { id: `${baseId}-24`, label: `${baseLabel} +24h`, url: cpcUrl(cycle, param, "024"), description: null },
  ];
}

// ─── ECMWF Base Time detection ─────────────────────────────────────────────────
interface EcmwfCacheEntry { baseTime: string | null; expiresAt: number }
let ecmwfCache: EcmwfCacheEntry | null = null;

interface EcmwfApiResponse {
  data?: { link?: { href?: string } };
}

async function detectEcmwfBaseTime(): Promise<string | null> {
  const now = Date.now();
  if (ecmwfCache && now < ecmwfCache.expiresAt) return ecmwfCache.baseTime;

  const today = new Date();
  const ymd = today.toISOString().slice(0, 10);
  const yesterday = new Date(today.getTime() - 86400000).toISOString().slice(0, 10);

  const candidates: { date: string; hh: string }[] = [
    { date: ymd, hh: "12" },
    { date: ymd, hh: "06" },
    { date: ymd, hh: "00" },
    { date: yesterday, hh: "12" },
    { date: yesterday, hh: "06" },
  ];

  for (const { date, hh } of candidates) {
    const baseTime = `${date}T${hh}:00:00Z`;
    const validH = String((parseInt(hh) + 6) % 24).padStart(2, "0");
    const validDate = parseInt(hh) + 6 >= 24
      ? new Date(new Date(date).getTime() + 86400000).toISOString().slice(0, 10)
      : date;
    const validTime = `${validDate}T${validH}:00:00Z`;
    try {
      const url = `https://charts.ecmwf.int/opencharts-api/v1/products/medium-mslp-rain/?base_time=${encodeURIComponent(baseTime)}&valid_time=${encodeURIComponent(validTime)}&projection=opencharts_africa`;
      const res = await fetch(url, { signal: AbortSignal.timeout(8000), headers: { Accept: "application/json" } });
      if (!res.ok) continue;
      const json = await res.json() as EcmwfApiResponse;
      if (json?.data?.link?.href) {
        ecmwfCache = { baseTime, expiresAt: now + 30 * 60 * 1000 };
        return baseTime;
      }
    } catch { continue; }
  }

  ecmwfCache = { baseTime: null, expiresAt: now + 3 * 60 * 1000 };
  return null;
}

async function fetchEcmwfImageUrl(baseTime: string, validTime: string): Promise<string | null> {
  try {
    const url = `https://charts.ecmwf.int/opencharts-api/v1/products/medium-mslp-rain/?base_time=${encodeURIComponent(baseTime)}&valid_time=${encodeURIComponent(validTime)}&projection=opencharts_africa`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10000), headers: { Accept: "application/json" } });
    if (!res.ok) return null;
    const json = await res.json() as EcmwfApiResponse;
    return json?.data?.link?.href ?? null;
  } catch { return null; }
}

function addHours(isoDate: string, hours: number): string {
  return new Date(new Date(isoDate).getTime() + hours * 3600 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

async function buildEcmwfSection(baseTime: string): Promise<BriefingSection> {
  const echeances = [6, 12, 18, 24];
  const charts = await Promise.all(
    echeances.map(async (h) => {
      const validTime = addHours(baseTime, h);
      const imgUrl = await fetchEcmwfImageUrl(baseTime, validTime);
      const validLabel = validTime.slice(11, 16) + " UTC";
      return {
        id: `ecmwf-rain-${h}h`,
        label: `Pluie ECMWF +${h}h (${validLabel})`,
        url: imgUrl ?? "",
        description: null,
      } as BriefingChartItem;
    })
  );

  const validCharts = charts.filter((c) => c.url);
  return {
    id: "pluie-ecmwf",
    name: "Pluie ECMWF — Pluie + MSLP",
    contentType: "images",
    subsections: validCharts.length > 0
      ? [{ label: "Précipitations cumulées + Pression (ECMWF)", charts: validCharts }]
      : [{ label: "ECMWF non disponible pour ce cycle", charts: [] }],
  };
}

// ─── EUMETSAT WMS section builder ─────────────────────────────────────────────

function eumetsatProxyUrl(layer: string, time: string): string {
  return `/api/briefing/eumetsat/image?layer=${encodeURIComponent(layer)}&time=${encodeURIComponent(time)}`;
}

function buildEumetsatSatelliteSection(briefingTime: string): BriefingSection {
  return {
    id: "satellite",
    name: "Imagerie Satellitaire — Meteosat IR (EUMETSAT)",
    contentType: "images",
    subsections: [
      {
        label: "Infrarouge 10.8µm — Température sommet des nuages — Afrique de l'Ouest (Meteosat)",
        charts: [
          {
            id: "eumetsat-ir108",
            label: "IR 10.8µm — Meteosat",
            url: eumetsatProxyUrl("msg_fes:ir108", briefingTime),
            description: "Canal infrarouge thermique — zones froides (blanc/gris) = convection profonde. Fond noir = nuit.",
          },
        ],
      },
    ],
  };
}

// ─── WAFFGS section builder ────────────────────────────────────────────────────

function waffgsProxyUrl(product: "ASM" | "FFR", year: string, month: string, day: string, hour: string): string {
  return `/api/briefing/waffgs/image?product=${product}&year=${year}&month=${month}&day=${day}&hour=${hour}`;
}

async function buildWaffgsSection(
  id: string,
  name: string,
  product: "ASM" | "FFR",
  chartLabel: string,
  description: string | null
): Promise<BriefingSection> {
  const time = await getWaffgsLatestTime();
  if (!time) {
    return {
      id,
      name,
      contentType: "external",
      subsections: [],
      externalUrl: "https://waffgs.hrcwater.org/WAFFGS_MAPSERVER/index.php",
      externalLabel: `Ouvrir WAFFGS — données temporairement indisponibles`,
    };
  }

  const { year, month, day, hour } = time;
  const dateLabel = `${year}-${month}-${day} ${hour}:00 UTC`;

  return {
    id,
    name,
    contentType: "images",
    subsections: [
      {
        label: `${chartLabel} — ${dateLabel}`,
        charts: [
          {
            id: `${id}-latest`,
            label: `${chartLabel} (dernière analyse)`,
            url: waffgsProxyUrl(product, year, month, day, hour),
            description,
          },
        ],
      },
    ],
  };
}

// ─── MISVA proxy helpers ────────────────────────────────────────────────────────

const MISVA_API_BASE =
  "https://api.sedoo.fr/sedoo-campaigns-rest-fats/data/v1_0";

interface MisvaEntry {
  type: string;
  media: { category: string; content: string } | null;
  levels: { name: string; label: string; value: string }[] | null;
}

function misvaProxyUrl(mediaContent: string): string {
  const u = new URL(mediaContent);
  const product = u.searchParams.get("product") ?? "";
  const day = u.searchParams.get("day") ?? "";
  const file = u.searchParams.get("file") ?? "";
  return (
    `/api/briefing/misva/image` +
    `?product=${encodeURIComponent(product)}` +
    `&day=${encodeURIComponent(day)}` +
    `&file=${encodeURIComponent(file)}`
  );
}

async function fetchMisvaEntries(product: string, date: string): Promise<MisvaEntry[]> {
  const url =
    `${MISVA_API_BASE}/request` +
    `?product=${encodeURIComponent(product)}` +
    `&filter=${encodeURIComponent(date)}` +
    `&campaign=MISVA`;
  try {
    const resp = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) return [];
    const data = (await resp.json()) as { entries?: MisvaEntry[] };
    return (data.entries ?? []).filter((e) => !!e.media?.content);
  } catch {
    return [];
  }
}

function getLevelValue(entry: MisvaEntry, levelName: string): string {
  return (entry.levels ?? []).find((l) => l.name === levelName)?.value ?? "";
}

/** Retourne la date d'aujourd'hui et d'hier en YYYY-MM-DD (UTC). */
function getMisvaDates(): [string, string] {
  const now = new Date();
  const fmt = (d: Date) => d.toISOString().split("T")[0]!;
  const yesterday = new Date(now.getTime() - 86400 * 1000);
  return [fmt(now), fmt(yesterday)];
}

/** Tente d'abord la date du jour, puis hier si pas de résultats. */
async function fetchMisvaEntriesFallback(product: string): Promise<{ entries: MisvaEntry[]; date: string }> {
  const [today, yesterday] = getMisvaDates();
  let entries = await fetchMisvaEntries(product, today);
  if (entries.length > 0) return { entries, date: today };
  entries = await fetchMisvaEntries(product, yesterday);
  return { entries, date: yesterday };
}

// ─── MISVA sections ────────────────────────────────────────────────────────────

async function buildMisvaAnasygSection(): Promise<BriefingSection> {
  const { entries, date } = await fetchMisvaEntriesFallback("Anasyg");

  if (entries.length === 0) {
    return {
      id: "misva-anasyg",
      name: "ANASYG — Carte Synoptique Afrique de l'Ouest (MISVA/CISMF)",
      contentType: "external",
      subsections: [],
      externalUrl: "https://misva.aeris-data.fr/products/anasyg/#/",
      externalLabel: "Ouvrir ANASYG sur MISVA",
      externalDescription: "Sélectionner : Région = afoc, Heure = 00 ou 06 UTC",
    };
  }

  const charts: BriefingChartItem[] = entries.map((e) => {
    const reseau = e.type === "at06h" ? "00" : e.type === "at18h" ? "12" : e.type;
    return {
      id: `anasyg-${e.type}`,
      label: `ANASYG ${reseau} UTC`,
      url: misvaProxyUrl(e.media!.content),
      description: `Carte synoptique ANASYG Afrique de l'Ouest — réseau ${reseau} UTC — ${date}`,
    };
  });

  return {
    id: "misva-anasyg",
    name: "ANASYG — Carte Synoptique Afrique de l'Ouest (MISVA/CISMF)",
    contentType: "images",
    subsections: [{ label: `ANASYG — ${date}`, charts }],
  };
}

// Échéances PW WestAfrica à afficher dans le briefing : 06h, 12h, 18h, 00h (réseau du jour)
const PW_ECHEANCES = new Set(["006H", "012H", "018H", "024H"]);

async function buildMisvaPwSection(): Promise<BriefingSection> {
  const { entries, date } = await fetchMisvaEntriesFallback("Synopt_Cartes_Prevues");

  const pwEntries = entries.filter(
    (e) =>
      getLevelValue(e, "Level1") === "ECMWF" &&
      getLevelValue(e, "Level2") === "WestAfrica" &&
      getLevelValue(e, "Level3") === "PW" &&
      PW_ECHEANCES.has(e.type)
  );

  if (pwEntries.length === 0) {
    return {
      id: "misva-pw",
      name: "Eau Précipitable — Cartes PW ECMWF Afrique de l'Ouest (MISVA)",
      contentType: "external",
      subsections: [],
      externalUrl: "https://misva.aeris-data.fr/products/synopt_cartes_prevues/#/",
      externalLabel: "Ouvrir Cartes PW sur MISVA",
      externalDescription:
        "Sélectionner : Domain = WestAfrica, Parameter = PW, Level = NONE — puis naviguer entre 000H, 024H, 048H, 072H",
    };
  }

  pwEntries.sort((a, b) => a.type.localeCompare(b.type));

  const charts: BriefingChartItem[] = pwEntries.map((e) => ({
    id: `pw-${e.type}`,
    label: `PW +${e.type}`,
    url: misvaProxyUrl(e.media!.content),
    description: `Eau Précipitable ECMWF — Afrique de l'Ouest — échéance +${e.type} — run ${date}`,
  }));

  return {
    id: "misva-pw",
    name: "Eau Précipitable — Cartes PW ECMWF Afrique de l'Ouest (MISVA)",
    contentType: "images",
    subsections: [{ label: `PW ECMWF — run ${date}`, charts }],
  };
}

// Villes maliennes disponibles dans synopt_series_prevues
const MALI_CITIES = new Set([
  "Bamako", "Gao", "Kayes", "Kidal", "Mopti", "Segou", "Sikasso",
]);

async function buildMisvaTimeSeriesSection(): Promise<BriefingSection> {
  const { entries, date } = await fetchMisvaEntriesFallback("synopt_series_prevues");

  const maliEntries = entries.filter(
    (e) =>
      getLevelValue(e, "Level2") === "PW" &&
      getLevelValue(e, "Level1") === "Raw" &&
      MALI_CITIES.has(getLevelValue(e, "Level4"))
  );

  if (maliEntries.length === 0) {
    return {
      id: "misva-timeseries",
      name: "Séries Temporelles PW — Villes du Mali (MISVA)",
      contentType: "external",
      subsections: [],
      externalUrl: "https://misva.aeris-data.fr/products/synopt_series_prevues/#/",
      externalLabel: "Ouvrir Séries Temporelles sur MISVA",
      externalDescription:
        "Sélectionner : Domain = MALI/CAPITALES, Parameter = PW, puis choisir la ville (Gao, Kayes, Kidal, Mopti, Ségou, Sikasso, Bamako)",
    };
  }

  maliEntries.sort((a, b) =>
    getLevelValue(a, "Level4").localeCompare(getLevelValue(b, "Level4"))
  );

  const charts: BriefingChartItem[] = maliEntries.map((e) => {
    const ville = getLevelValue(e, "Level4");
    return {
      id: `ts-${ville}`,
      label: ville,
      url: misvaProxyUrl(e.media!.content),
      description: `Série temporelle Eau Précipitable — ${ville} — run ${date}`,
    };
  });

  return {
    id: "misva-timeseries",
    name: "Séries Temporelles PW — Villes du Mali (MISVA)",
    contentType: "images",
    subsections: [{ label: `Séries PW Mali — ${date}`, charts }],
  };
}

// ─── MISVA Épaisseur de la Mousson (LowLev-Diag 925-600) ──────────────────────

const LOWLEV_ECHEANCES = new Set(["000H", "024H"]);

async function buildMisvaLowLevSection(): Promise<BriefingSection> {
  const { entries, date } = await fetchMisvaEntriesFallback("Synopt_Cartes_Prevues");

  const lowlevEntries = entries.filter(
    (e) =>
      getLevelValue(e, "Level2") === "WestAfrica" &&
      getLevelValue(e, "Level3") === "LowLev-Diag" &&
      getLevelValue(e, "Level4") === "925-600" &&
      LOWLEV_ECHEANCES.has(e.type)
  );

  if (lowlevEntries.length === 0) {
    return {
      id: "misva-lowlev",
      name: "Épaisseur de la Mousson — LowLev-Diag 925-600 (MISVA)",
      contentType: "external",
      subsections: [],
      externalUrl: "https://misva.aeris-data.fr/products/synopt_cartes_prevues/#/",
      externalLabel: "Ouvrir sur MISVA",
      externalDescription:
        "Sélectionner : Domain = WestAfrica, Parameter = LowLev-Diag, Level = 925-600 — puis 000H et 024H",
    };
  }

  lowlevEntries.sort((a, b) => a.type.localeCompare(b.type));

  const charts: BriefingChartItem[] = lowlevEntries.map((e) => ({
    id: `lowlev-${e.type}`,
    label: `Épaisseur Mousson +${e.type}`,
    url: misvaProxyUrl(e.media!.content),
    description: `LowLev-Diag 925-600 WestAfrica — Épaisseur de la mousson — échéance ${e.type} — run ${date}`,
  }));

  return {
    id: "misva-lowlev",
    name: "Épaisseur de la Mousson — LowLev-Diag 925-600 (MISVA)",
    contentType: "images",
    subsections: [{ label: `Épaisseur Mousson — run ${date}`, charts }],
  };
}

// ─── Section Synergie — rendu live GFSAFR025 via SYABAN02 ────────────────────
// L'ancienne version listait l'ARCHIVE SFTP statique (/home/synergie/ARCHIVE),
// qui ne contient que des captures manuelles de 2016-2023 — jamais rafraichie
// automatiquement, d'ou une section "toujours vide" en pratique. On construit
// desormais les cartes via /api/synergie/render-grib (rendu GFS a la demande,
// cache cote serveur 20 min — voir GRIB_CACHE_TTL dans routes/synergie.ts).
// CAPE retire : le catalogue GRIB reel de ce domaine n'a pas de champ CAPE
// exploitable (voir le commentaire sur CAPE_I dans routes/synergie.ts).
const SYNERGIE_LIVE_PARAMS: { key: string; label: string }[] = [
  { key: "PMER",  label: "Pression réduite mer" },
  { key: "T2M",   label: "Température 2m" },
  { key: "FF10",  label: "Vent 10m" },
  { key: "FF850", label: "Flux 850 hPa" },
  { key: "HU850", label: "Humidité relative 850 hPa" },
  { key: "HU700", label: "Humidité relative 700 hPa" },
  { key: "RR6H",  label: "Précipitations 6h" },
  { key: "TOURCOMBO", label: "Tourbillon absolu 850/700/200 hPa" },
];
// Le RUN (reseau) ne change qu'a 00H et 12H sur SYABAN02 (confirme par
// inspection directe de /data-space/data/grib/US2.GFSAFR025 : uniquement des
// dossiers ...000000/...120000) — mais chaque run produit des echeances a
// +6H/+12H/+18H/+24H, qui donnent bien une sortie valide a 06H/12H/18H/00H
// pour chaque produit. "6H" (pas "06H") : le catalogue GRIB reel n'a jamais
// "0H" et n'utilise pas de zero devant.
// Les 4 echeances sont possibles maintenant (contrairement a l'ancienne
// limitation "1 seule echeance") : le rendu passe par extraction GRIB directe
// + SVG maison (grib-render.ts), plus par une capture d'ecran GUI/X11 serialisee
// (visu_modele) qui prenait 10-60s par carte — cette contrainte de vitesse a
// disparu avec ce changement d'architecture.
const SYNERGIE_ECHEANCES = ["6H", "12H", "18H", "24H"];

function synergieGribUrl(key: string, reseau: string, echeance: string): string {
  return `/api/synergie/render-grib?key=${encodeURIComponent(key)}&reseau=${encodeURIComponent(reseau)}&echeance=${encodeURIComponent(echeance)}`;
}

// Heure valide = reseau + echeance (modulo 24h) — un run 00H a l'echeance
// +18H est valide a 18H, pas a 00H. Sert uniquement a etiqueter les cartes
// dans la liste du briefing ; le rendu lui-meme (routes/synergie.ts) fait le
// meme calcul pour l'overlay affiche sur l'image.
function validTimeLabel(reseau: string, echeance: string): string {
  const reseauHour = parseInt(reseau.replace("H", ""), 10) || 0;
  const echeanceHours = parseInt(echeance.replace("H", ""), 10) || 0;
  const validHour = (reseauHour + echeanceHours) % 24;
  return `${String(validHour).padStart(2, "0")}H`;
}

function buildSynergieSection(): BriefingSection {
  const reseau = computeSynergieReseau();
  const subsections = SYNERGIE_LIVE_PARAMS.map(({ key, label }) => ({
    label: `${label} — GFSAFR025 réseau ${reseau}`,
    charts: SYNERGIE_ECHEANCES.map((ech) => ({
      id: `synergie-${key}-${ech}`,
      label: `${label} — ${validTimeLabel(reseau, ech)}`,
      url: synergieGribUrl(key, reseau, ech),
      description: `${label} — modèle GFSAFR025 (SYABAN02) — réseau ${reseau} — échéance +${ech} (valide ${validTimeLabel(reseau, ech)})`,
    })),
  }));

  return {
    id: "synergie",
    name: "Champs Synergie — SYABAN02 (GFS live)",
    contentType: "images",
    subsections,
  };
}

// ─── Main catalog builder ──────────────────────────────────────────────────────
export async function getBriefingCatalog(): Promise<BriefingCatalogResult> {
  const [
    cycle,
    ecmwfBaseTime,
    anasygSection,
    pwSection,
    timeSeriesSection,
    lowLevSection,
  ] = await Promise.all([
    detectGfsCycle(),
    detectEcmwfBaseTime(),
    buildMisvaAnasygSection(),
    buildMisvaPwSection(),
    buildMisvaTimeSeriesSection(),
    buildMisvaLowLevSection(),
  ]);

  const synergieSection = buildSynergieSection();

  const ecmwfSection = ecmwfBaseTime
    ? await buildEcmwfSection(ecmwfBaseTime)
    : {
        id: "pluie-ecmwf",
        name: "Pluie ECMWF — Pluie + MSLP",
        contentType: "images" as const,
        subsections: [{ label: "ECMWF temporairement indisponible", charts: [] }],
      };

  const WINDY_BASE = "https://embed.windy.com/embed2.html?lat=17.842&lon=-1.933&detailLat=17.842&detailLon=-1.933&width=650&height=450&zoom=5&level=surface&overlay=rain&menu=&message=&marker=&calendar=now&pressure=&type=map&location=coordinates&detail=&metricWind=default&metricTemp=default&radarRange=-1";

  const sections: BriefingSection[] = [
    // ── 1. Imagerie Satellitaire Live — Windy ────────────────────────────────
    {
      id: "satellite",
      name: "Imagerie Satellitaire Live — Windy",
      contentType: "iframe" as const,
      iframeUrl: "https://embed.windy.com/embed2.html?lat=17.770&lon=-2.017&detailLat=17.770&detailLon=-2.017&zoom=5&level=surface&overlay=satellite&menu=&message=&marker=&calendar=now&pressure=&type=map&location=coordinates&detail=&metricWind=default&metricTemp=default&radarRange=-1",
      externalUrl: "https://www.windy.com/?satellite,17.770,-2.017,5",
      externalLabel: "Ouvrir dans Windy ↗",
      subsections: [],
    },

    // ── 2. Imagerie Satellitaire — UK Met Office (upload manuel) ──────────────
    {
      id: "satellite-ukmet",
      name: "Imagerie Satellitaire — UK Met Office (captures)",
      contentType: "upload",
      subsections: [
        {
          label: "Captures UK Met Office",
          charts: [
            { id: "ukmet-sat", label: "Image Satellite (visible/IR)", url: "", description: null },
            { id: "ukmet-dust", label: "Dust / Aérosols", url: "", description: null },
          ],
        },
      ],
    },

    // ── 3. Champs Synergie — SYABAN02 ────────────────────────────────────────
    synergieSection,

    // ── 4. ANASYG (MISVA/CISMF) ───────────────────────────────────────────────
    anasygSection,

    // ── 4. Champs de Pression — GFS ───────────────────────────────────────────
    {
      id: "pmer-pluie",
      name: "Champs de Pression — GFS (MSLP + Pluie 6h)",
      contentType: "images",
      subsections: [
        {
          label: "Pression au niveau de la mer + Précipitations 6h (GFS)",
          charts: cpcCharts(cycle, "mslp_6h_totp", "MSLP+Pluie", "pmer", "Pression au niveau de la mer et précipitations cumulées sur 6h"),
        },
      ],
    },

    // ── 5. Humidité et Vents — 850 hPa ────────────────────────────────────────
    {
      id: "rh-850",
      name: "Humidité et Vents — 850 hPa (GFS)",
      contentType: "images",
      subsections: [
        {
          label: "Humidité Relative 850 hPa (GFS)",
          charts: cpcCharts(cycle, "850mb_rh", "HR 850 hPa", "rh850", "Humidité relative à 850 hPa — couche de mousson"),
        },
        {
          label: "Vents 850 hPa — Jet d'Est Africain (GFS)",
          charts: cpcCharts(cycle, "850mb_wind", "Vent 850 hPa", "wind850", "African Easterly Jet"),
        },
      ],
    },

    // ── 6. Humidité et Vents — 700 hPa ────────────────────────────────────────
    {
      id: "rh-700",
      name: "Humidité et Vents — 700 hPa (GFS)",
      contentType: "images",
      subsections: [
        {
          label: "Humidité Relative 700 hPa (GFS)",
          charts: cpcCharts(cycle, "700mb_rh", "HR 700 hPa", "rh700", "Humidité relative à 700 hPa — moyenne troposphère"),
        },
        {
          label: "Vents 700 hPa (GFS)",
          charts: cpcCharts(cycle, "700mb_wind", "Vent 700 hPa", "wind700", "Flux à 700 hPa — ondes d'est africaines"),
        },
      ],
    },

    // ── 7. Températures 2m — GFS ──────────────────────────────────────────────
    {
      id: "tmax-gfs",
      name: "Températures 2m — GFS (CPC NCEP)",
      contentType: "images",
      subsections: [
        {
          label: "T Minimale — 06h UTC (Aujourd'hui vs J+1)",
          charts: [
            { id: "tmp-6h-j0", label: "T 06h UTC — Aujourd'hui", url: cpcUrl(cycle, "tmp2m", "006"), description: "Température 2m à 06h UTC (Tmin nocturne)" },
            { id: "tmp-6h-j1", label: "T 06h UTC — J+1", url: cpcUrl(cycle, "tmp2m", "030"), description: "Température 2m à 06h UTC J+1" },
          ],
        },
        {
          label: "T Maximale — 18h UTC (Aujourd'hui vs J+1)",
          charts: [
            { id: "tmp-18h-j0", label: "Tmax 18h UTC — Aujourd'hui", url: cpcUrl(cycle, "tmp2m", "018"), description: "Température max à 18h UTC (pic diurne)" },
            { id: "tmp-18h-j1", label: "Tmax 18h UTC — J+1", url: cpcUrl(cycle, "tmp2m", "042"), description: "Température max à 18h UTC J+1" },
          ],
        },
      ],
    },

    // ── 8. Eau Précipitable PW (MISVA ECMWF) ──────────────────────────────────
    pwSection,

    // ── 9. Séries Temporelles PW Mali (MISVA) ─────────────────────────────────
    timeSeriesSection,

    // ── 10. Épaisseur de la Mousson (MISVA LowLev) ────────────────────────────
    lowLevSection,

    // ── 11. CAPE — Énergie Convective ─────────────────────────────────────────
    {
      id: "cape",
      name: "CAPE — Énergie Convective (GFS)",
      contentType: "images",
      subsections: [
        {
          label: "CAPE — Potentiel convectif (GFS)",
          charts: cpcCharts(cycle, "cape", "CAPE", "cape", "Énergie potentielle convective disponible (J/kg)"),
        },
      ],
    },

    // ── 12. Champs de Pluie — ECMWF ───────────────────────────────────────────
    ecmwfSection,

    // ── 13. Champs de Pluie — UK Met Office (captures manuelles) ─────────────
    {
      id: "pluie-ukmet",
      name: "Champs de Pluie — UK Met Office (captures)",
      contentType: "upload",
      subsections: [
        {
          label: "Pluie modèle UK Met Office — Afrique de l'Ouest",
          charts: [
            { id: "ukmet-rain-1", label: "Pluie UK Met +6h", url: "", description: null },
            { id: "ukmet-rain-2", label: "Pluie UK Met +12h", url: "", description: null },
            { id: "ukmet-rain-3", label: "Pluie UK Met +24h", url: "", description: null },
            { id: "ukmet-rain-4", label: "Pluie UK Met +36h", url: "", description: null },
          ],
        },
      ],
    },

    // ── 14. Champs de Pluie — FFGS (Risque Crue Éclair) ──────────────────────
    {
      id: "ffgs-captures",
      name: "Champs de Pluie — FFGS (Risque Crue Éclair)",
      contentType: "upload",
      subsections: [
        {
          label: "Flash Flood Guidance System — Afrique de l'Ouest",
          charts: [
            { id: "ffgs-asm", label: "ASM — Humidité du Sol", url: "", description: null },
            { id: "ffgs-ffr", label: "FFR — Flash Flood Risk", url: "", description: null },
          ],
        },
      ],
    },

    // ── 15. Pluie — Windy (live avec sélecteur de modèle) ────────────────────
    {
      id: "pluie-windy",
      name: "Pluie — Windy (ICON / GFS / ECMWF)",
      contentType: "iframe",
      subsections: [],
      iframeUrl: `${WINDY_BASE}&product=icon`,
      iframeAlternatives: [
        { label: "ICON", url: `${WINDY_BASE}&product=icon` },
        { label: "GFS", url: `${WINDY_BASE}&product=gfs` },
        { label: "ECMWF", url: `${WINDY_BASE}&product=ecmwf` },
      ],
    },

    // ── 16. Captures Pluie — Windy (upload manuel) ────────────────────────────
    {
      id: "windy-captures",
      name: "Captures Pluie — Windy (manuel)",
      contentType: "upload",
      subsections: [
        {
          label: "Champs de pluie capturés depuis Windy",
          charts: [
            { id: "windy-cap-1", label: "Capture Pluie 1", url: "", description: null },
            { id: "windy-cap-2", label: "Capture Pluie 2", url: "", description: null },
            { id: "windy-cap-3", label: "Capture Pluie 3", url: "", description: null },
          ],
        },
      ],
    },
  ];

  return { sections, gfsCycle: cycle, ecmwfBaseTime, fetchedAt: new Date().toISOString() };
}
