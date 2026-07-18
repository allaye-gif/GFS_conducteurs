export interface ChartItem {
  id: string;
  label: string;
  url: string;
  description: string | null;
  directLoad?: boolean;
}

export interface ChartSubsection {
  label: string;
  charts: ChartItem[];
}

export interface NoaaSection {
  id: string;
  name: string;
  subsections: ChartSubsection[];
}

const PROBE_PARAM = "mslp_6h_totp";
const PROBE_FHR = "f006";
const CYCLES = ["00", "06", "12", "18"] as const;
type Cycle = (typeof CYCLES)[number];

let cycleCache: { cycle: Cycle; expiresAt: number } | null = null;

async function detectLatestCpcCycle(): Promise<Cycle> {
  const now = Date.now();
  if (cycleCache && now < cycleCache.expiresAt) {
    return cycleCache.cycle;
  }

  const results = await Promise.all(
    CYCLES.map(async (c) => {
      const url = `https://www.cpc.ncep.noaa.gov/products/international/cpci/data/${c}/gfs.t${c}z.${PROBE_PARAM}.${PROBE_FHR}.wafrica.gif`;
      try {
        const res = await fetch(url, {
          method: "HEAD",
          headers: {
            "User-Agent": "Mozilla/5.0 (compatible; MeteoAnalyste/1.0)",
            Referer: "https://www.cpc.ncep.noaa.gov/",
          },
          signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) return { cycle: c, lastModified: 0 };
        const lm = res.headers.get("last-modified");
        const ts = lm ? new Date(lm).getTime() : 0;
        return { cycle: c, lastModified: ts };
      } catch {
        return { cycle: c, lastModified: 0 };
      }
    })
  );

  const best = results.reduce((a, b) => (b.lastModified > a.lastModified ? b : a));
  const chosen = best.lastModified > 0 ? best.cycle : "12";

  cycleCache = { cycle: chosen, expiresAt: now + 20 * 60 * 1000 };
  return chosen;
}

function validTimeLabel(cycle: string, fhr: string): string {
  const cycleH = parseInt(cycle, 10);
  const fhrH = parseInt(fhr, 10);
  const validH = (cycleH + fhrH) % 24;
  const dayOffset = Math.floor((cycleH + fhrH) / 24);
  const validStr = String(validH).padStart(2, "0") + "Z";
  return dayOffset > 0 ? `${validStr} J+${dayOffset}` : validStr;
}

function cpcGfs(
  cycle: string,
  param: string,
  fhr: string,
  baseLabel: string,
  id: string,
  description: string | null = null
): ChartItem {
  const fhrNum = parseInt(fhr, 10);
  const label = `${baseLabel} — +${fhrNum}h`;
  return {
    id,
    label,
    url: `https://www.cpc.ncep.noaa.gov/products/international/cpci/data/${cycle}/gfs.t${cycle}z.${param}.f${fhr}.wafrica.gif`,
    description,
  };
}

export interface NoaaCatalogResult {
  sections: NoaaSection[];
  gfsCycle: string;
}

export async function getNoaaCatalog(): Promise<NoaaCatalogResult> {
  const cycle = await detectLatestCpcCycle();

  const sections: NoaaSection[] = [
    // ─── MJO ───────────────────────────────────────────────────────────────────
    {
      id: "mjo",
      name: "MJO — Madden-Julian Oscillation",
      subsections: [
        {
          label: "Indices RMM — Observations (40 et 90 jours)",
          charts: [
            {
              id: "mjo-rmm-obs40",
              label: "Diagramme de phase RMM — 40 jours",
              url: "https://www.cpc.ncep.noaa.gov/products/precip/mjo/img/rmm_obs40.png",
              description: "Wheeler-Hendon (WH2004) — 40 derniers jours d'observations",
            },
            {
              id: "mjo-rmm-obs90",
              label: "Diagramme de phase RMM — 90 jours",
              url: "https://www.cpc.ncep.noaa.gov/products/precip/mjo/img/rmm_obs90.png",
              description: "Wheeler-Hendon (WH2004) — 90 derniers jours d'observations",
            },
          ],
        },
        {
          label: "Prévisions — GFS Opérationnel & Modèles Statistiques",
          charts: [
            {
              id: "mjo-gfs-phase",
              label: "Diagramme de phase — GFS Opérationnel (15j)",
              url: "https://www.cpc.ncep.noaa.gov/products/precip/mjo/img/NGFS.png",
              description: "GFSv16 — Observation des 40 derniers jours + prévision 15 jours",
            },
            {
              id: "mjo-stat-phase",
              label: "Diagramme de phase — Modèles Statistiques (CA / ARM / PCL)",
              url: "https://www.cpc.ncep.noaa.gov/products/precip/mjo/img/rmm_stat.png",
              description: "Constructed Analogue (CA), ARM, PCL — Prévision statistique 15 jours",
            },
          ],
        },
      ],
    },

    // ─── OLR ───────────────────────────────────────────────────────────────────
    {
      id: "olr",
      name: "OLR — Rayonnement Sortant Grande Longueur d'Onde",
      subsections: [
        {
          label: "IR / Vitesse Potentielle 200 hPa",
          charts: [
            {
              id: "olr-ir-vp200-global",
              label: "IR / VP 200 hPa — Vue Globale",
              url: "https://www.cpc.ncep.noaa.gov/products/precip/CWlink/vpotgifs/am_ir_monthly_1.gif",
              description: "Image IR overlayée avec les contours de VP 200 hPa — vue mondiale (frame le plus récent)",
            },
            {
              id: "olr-ir-vp200-60e",
              label: "IR / VP 200 hPa — Zoom Afrique / Océan Indien (60E)",
              url: "https://www.cpc.ncep.noaa.gov/products/precip/CWlink/vpotgifs/am_ir_monthly_60E_1.gif",
              description: "Centré sur l'Afrique, l'océan Indien et le continent Maritime (frame le plus récent)",
            },
          ],
        },
      ],
    },

    // ─── NAO ───────────────────────────────────────────────────────────────────
    {
      id: "nao",
      name: "NAO — Oscillation Nord-Atlantique",
      subsections: [
        {
          label: "Indice NAO — Prévisions & Observations",
          charts: [
            {
              id: "nao-gfs-fcst",
              label: "Indice NAO — Prévision GFS Ensemble",
              url: "https://www.cpc.ncep.noaa.gov/products/precip/CWlink/pna/nao.gfs.fcst.png",
              description: "Indice NAO observé (120 derniers jours) + prévision ensemble GFS",
            },
          ],
        },
      ],
    },

    // ─── FIT ───────────────────────────────────────────────────────────────────
    {
      id: "fit",
      name: "FIT — Front Inter-Tropical",
      subsections: [
        {
          label: "Position FIT — Actuelle vs Normale (Afrique)",
          charts: [
            {
              id: "fit-itcz-main",
              label: "FIT — Position Actuelle vs Normale Décadaire + Précip RFE",
              url: "https://www.cpc.ncep.noaa.gov/products/international/itf/itcz.jpg",
              description: "Position actuelle (rose), normale (noir) et précédente (violet) du FIT sur 10 jours — Accumulation RFE en fond",
            },
            {
              id: "fit-west",
              label: "FIT — Zoom Afrique de l'Ouest",
              url: "https://www.cpc.ncep.noaa.gov/products/international/itf/west.gif",
              description: "Détail position FIT sur l'Afrique de l'Ouest",
            },
          ],
        },
      ],
    },

    // ─── GFS AFRIQUE (CPC) ─────────────────────────────────────────────────────
    {
      id: "gfs-africa",
      name: "GFS — Afrique de l'Ouest & Mali",
      subsections: [
        {
          label: "Surface — MSLP & Précipitations",
          charts: [
            cpcGfs(cycle, "mslp_6h_totp", "006", "MSLP + Précip", "gfs-mslp-06", "Pression au niveau de la mer + précipitations totales 6h"),
            cpcGfs(cycle, "mslp_6h_totp", "012", "MSLP + Précip", "gfs-mslp-12"),
            cpcGfs(cycle, "mslp_6h_totp", "018", "MSLP + Précip", "gfs-mslp-18"),
            cpcGfs(cycle, "mslp_6h_totp", "024", "MSLP + Précip", "gfs-mslp-24"),
          ],
        },
        {
          label: "Eau Précipitable (PWAT)",
          charts: [
            cpcGfs(cycle, "6h_pwatr", "006", "PWAT", "gfs-pwat-06", "Eau précipitable totale dans la colonne atmosphérique"),
            cpcGfs(cycle, "6h_pwatr", "012", "PWAT", "gfs-pwat-12"),
            cpcGfs(cycle, "6h_pwatr", "018", "PWAT", "gfs-pwat-18"),
            cpcGfs(cycle, "6h_pwatr", "024", "PWAT", "gfs-pwat-24"),
          ],
        },
        {
          label: "Vents 925 hPa — Flux de Mousson",
          charts: [
            cpcGfs(cycle, "925mb_wind", "006", "Vents 925 hPa", "gfs-wind925-06", "Flux de mousson bas niveau — analyse + prévision"),
            cpcGfs(cycle, "925mb_wind", "012", "Vents 925 hPa", "gfs-wind925-12"),
            cpcGfs(cycle, "925mb_wind", "018", "Vents 925 hPa", "gfs-wind925-18"),
            cpcGfs(cycle, "925mb_wind", "024", "Vents 925 hPa", "gfs-wind925-24"),
          ],
        },
        {
          label: "Vents 850 hPa — Jet d'Est Africain (AEJ)",
          charts: [
            cpcGfs(cycle, "850mb_wind", "006", "Vents 850 hPa", "gfs-wind850-06", "African Easterly Jet — niveau principal de l'AEJ"),
            cpcGfs(cycle, "850mb_wind", "012", "Vents 850 hPa", "gfs-wind850-12"),
            cpcGfs(cycle, "850mb_wind", "018", "Vents 850 hPa", "gfs-wind850-18"),
            cpcGfs(cycle, "850mb_wind", "024", "Vents 850 hPa", "gfs-wind850-24"),
          ],
        },
        {
          label: "Vents 700 hPa",
          charts: [
            cpcGfs(cycle, "700mb_wind", "006", "Vents 700 hPa", "gfs-wind700-06"),
            cpcGfs(cycle, "700mb_wind", "012", "Vents 700 hPa", "gfs-wind700-12"),
            cpcGfs(cycle, "700mb_wind", "018", "Vents 700 hPa", "gfs-wind700-18"),
            cpcGfs(cycle, "700mb_wind", "024", "Vents 700 hPa", "gfs-wind700-24"),
          ],
        },
        {
          label: "Humidité Relative 850 hPa",
          charts: [
            cpcGfs(cycle, "850mb_rh", "006", "HR 850 hPa", "gfs-rh850-06", "Humidité relative à 850 hPa — couche de mousson"),
            cpcGfs(cycle, "850mb_rh", "012", "HR 850 hPa", "gfs-rh850-12"),
            cpcGfs(cycle, "850mb_rh", "018", "HR 850 hPa", "gfs-rh850-18"),
            cpcGfs(cycle, "850mb_rh", "024", "HR 850 hPa", "gfs-rh850-24"),
          ],
        },
        {
          label: "Instabilité — K-Index & CAPE",
          charts: [
            cpcGfs(cycle, "kindex", "006", "K-Index", "gfs-kindex-06", "Indice K — potentiel d'orage convectif (>35 = fort)"),
            cpcGfs(cycle, "kindex", "012", "K-Index", "gfs-kindex-12"),
            cpcGfs(cycle, "kindex", "018", "K-Index", "gfs-kindex-18"),
            cpcGfs(cycle, "kindex", "024", "K-Index", "gfs-kindex-24"),
            cpcGfs(cycle, "cape", "006", "CAPE", "gfs-cape-06", "Énergie potentielle convective disponible"),
            cpcGfs(cycle, "cape", "012", "CAPE", "gfs-cape-12"),
            cpcGfs(cycle, "cape", "018", "CAPE", "gfs-cape-18"),
            cpcGfs(cycle, "cape", "024", "CAPE", "gfs-cape-24"),
          ],
        },
      ],
    },
  ];

  return { sections, gfsCycle: cycle };
}
