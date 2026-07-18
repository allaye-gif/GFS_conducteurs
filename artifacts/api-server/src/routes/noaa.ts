import { Router, type IRouter } from "express";
import { GetNoaaChartsResponse } from "@workspace/api-zod";
import { getNoaaCatalog } from "../lib/noaa-catalog";

const router: IRouter = Router();

const ANALYSIS_PROMPTS: Record<string, string> = {
  mjo: `Tu es météorologue expert en Afrique de l'Ouest (ASECNA/Mali). Analyse ces diagrammes de phase RMM de l'Oscillation de Madden-Julian (MJO) fournis par le CPC NOAA. Décris : la phase actuelle (1-8), l'amplitude du signal (actif si >1), la trajectoire observée et prévue, et les implications concrètes pour la convection et les précipitations au Mali et au Sahel. Sois concis (3-5 phrases), en français, style bulletin opérationnel.`,
  olr: `Tu es météorologue expert en Afrique de l'Ouest (ASECNA/Mali). Analyse ces cartes OLR (Rayonnement Sortant Grande Longueur d'Onde) et de Vitesse Potentielle à 200 hPa du CPC NOAA. Décris : les anomalies OLR significatives (négatif = convection active, positif = supprimée), les centres de convection sur l'Afrique de l'Ouest, et les implications pour les précipitations au Mali. Sois concis (3-5 phrases), en français, style bulletin opérationnel.`,
  nao: `Tu es météorologue expert. Analyse ces graphiques de l'Oscillation Atlantique Nord (NAO) du CPC NOAA. Décris : la phase actuelle (positive/négative), l'amplitude et la persistance, la tendance prévue sur 2 semaines, et les implications pour la circulation de grande échelle influençant l'Afrique de l'Ouest. Sois concis (2-4 phrases), en français, style bulletin opérationnel.`,
  fit: `Tu es météorologue expert en Afrique de l'Ouest (ASECNA/Mali). Analyse ces cartes de position de la FIT (Front Intertropical) sur l'Afrique. Décris : la position actuelle de la FIT en latitude sur l'Afrique de l'Ouest (en degrés Nord), sa progression nord/sud par rapport à la normale saisonnière, les zones d'activité convective associées, et les implications pour la saison des pluies au Mali/Sahel. Sois concis (3-5 phrases), en français, style bulletin opérationnel.`,
  "gfs-mslp": `Tu es météorologue expert en Afrique de l'Ouest. Analyse ces 4 échéances GFS de pression au niveau de la mer (MSLP) et précipitations sur l'Afrique de l'Ouest. Décris : les systèmes de pression dominants (dépression saharienne, anticyclones), les zones de convergence, et les zones de précipitations prévues sur le Mali et le Sahel pour les prochaines 24h. Sois concis (3-4 phrases), en français, style bulletin opérationnel.`,
  "gfs-pw": `Tu es météorologue expert en Afrique de l'Ouest. Analyse ces 4 échéances GFS d'Eau Précipitable (PWAT) sur l'Afrique de l'Ouest. Décris : les zones d'humidité élevée (>40mm), les corridors d'humidité, les zones d'air sec intrusif, et les implications pour le potentiel de précipitations au Mali. Sois concis (2-3 phrases), en français, style bulletin opérationnel.`,
  "gfs-wind925": `Tu es météorologue expert en Afrique de l'Ouest. Analyse ces 4 échéances GFS de vents à 925 hPa (basse couche). Décris : la structure du flux de mousson de SW, les zones de convergence basse couche (CILB), l'intensité et la limite nord de pénétration de la mousson vers le Sahel/Mali, et les flux de NE (harmattan) éventuels. Sois concis (3-4 phrases), en français, style bulletin opérationnel.`,
  "gfs-wind850": `Tu es météorologue expert en Afrique de l'Ouest. Analyse ces 4 échéances GFS de vents à 850 hPa. Décris : la position en latitude et l'intensité du Jet d'Est Africain (AEJ, nœud autour de 10-15°N), les zones de cisaillement horizontal, et les implications pour le développement d'ondes d'est africaines (AEW) et la convection profonde au Mali. Sois concis (3-4 phrases), en français, style bulletin opérationnel.`,
  "gfs-wind700": `Tu es météorologue expert en Afrique de l'Ouest. Analyse ces 4 échéances GFS de vents à 700 hPa. Décris : les flux d'humidité en moyenne troposphère, la présence d'ondes d'est africaines (AEW) éventuelles (creux/dorsales), et les implications pour l'activité convective et les systèmes convectifs de méso-échelle (MCS) sur le Mali. Sois concis (2-3 phrases), en français, style bulletin opérationnel.`,
  "gfs-wind200": `Tu es météorologue expert en Afrique de l'Ouest. Analyse ces 4 échéances GFS de vents à 200 hPa. Décris : la position et l'intensité du Jet d'Est Tropical (TEJ, normalement 5-10°N en été), les zones de divergence en haute troposphère qui favorisent la convection profonde, et les implications pour la convection organisée au Mali/Sahel. Sois concis (2-3 phrases), en français, style bulletin opérationnel.`,
  "gfs-hr850": `Tu es météorologue expert en Afrique de l'Ouest. Analyse ces 4 échéances GFS d'Humidité Relative à 850 hPa. Décris : les zones d'air humide (>70%) et sec (<40%), les intrusions d'air sec saharien, et les implications pour l'inhibition ou le développement de la convection au Mali et Sahel occidental. Sois concis (2-3 phrases), en français, style bulletin opérationnel.`,
  "gfs-instab": `Tu es météorologue expert en Afrique de l'Ouest. Analyse ces 4 échéances GFS d'instabilité (K-Index et/ou CAPE) sur l'Afrique de l'Ouest. Décris : les zones à fort potentiel convectif (K-Index >35, CAPE >500 J/kg), les régions à risque d'orages violents et de systèmes convectifs (MCS) au Mali et Sahel dans les prochaines 24h. Sois concis (3-4 phrases), en français, style bulletin opérationnel.`,
};

const ALLOWED_HOSTS = [
  "www.cpc.ncep.noaa.gov",
  "cpc.ncep.noaa.gov",
  "mag.ncep.noaa.gov",
  "www.wpc.ncep.noaa.gov",
  "wpc.ncep.noaa.gov",
  "weather.noaa.gov",
  "psl.noaa.gov",
  "www.psl.noaa.gov",
  "charts.ecmwf.int",
];

router.get("/noaa/charts", async (_req, res): Promise<void> => {
  const catalog = await getNoaaCatalog();
  res.json(
    GetNoaaChartsResponse.parse({
      sections: catalog.sections,
      gfsCycle: catalog.gfsCycle,
      fetchedAt: new Date().toISOString(),
    }),
  );
});

router.get("/noaa/proxy", async (req, res): Promise<void> => {
  const rawUrl = req.query.url;
  if (typeof rawUrl !== "string" || !rawUrl) {
    res.status(400).json({ error: "Paramètre 'url' requis" });
    return;
  }

  let targetUrl: URL;
  try {
    targetUrl = new URL(rawUrl);
  } catch {
    res.status(400).json({ error: "URL invalide" });
    return;
  }

  if (!ALLOWED_HOSTS.includes(targetUrl.hostname)) {
    res.status(403).json({ error: "Hôte non autorisé" });
    return;
  }

  const response = await fetch(targetUrl.toString(), {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (compatible; MeteoAnalyste/1.0; +https://replit.com)",
      Referer: "https://www.cpc.ncep.noaa.gov/",
    },
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    res
      .status(response.status)
      .json({ error: `Erreur NOAA: ${response.statusText}` });
    return;
  }

  const contentType = response.headers.get("content-type") ?? "image/png";
  res.setHeader("Content-Type", contentType);
  res.setHeader("Cache-Control", "public, max-age=1800");

  const buffer = Buffer.from(await response.arrayBuffer());
  res.send(buffer);
});

router.post("/noaa/analyze", async (req, res): Promise<void> => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.status(503).json({ error: "Clé API Gemini non configurée" });
    return;
  }

  const { chartUrls, noteKey, sectionLabel } = req.body as {
    chartUrls: string[];
    noteKey: string;
    sectionLabel: string;
  };

  if (!Array.isArray(chartUrls) || chartUrls.length === 0) {
    res.status(400).json({ error: "chartUrls requis" });
    return;
  }

  let imageParts: { inlineData: { data: string; mimeType: string } }[];
  try {
    imageParts = await Promise.all(
      chartUrls.slice(0, 8).map(async (url: string) => {
        let parsed: URL;
        try {
          parsed = new URL(url);
        } catch {
          throw new Error(`URL invalide: ${url}`);
        }
        if (!ALLOWED_HOSTS.includes(parsed.hostname)) {
          throw new Error(`Hôte non autorisé: ${parsed.hostname}`);
        }
        const resp = await fetch(url, {
          headers: {
            "User-Agent": "Mozilla/5.0 (compatible; MeteoAnalyste/1.0)",
            Referer: "https://www.cpc.ncep.noaa.gov/",
          },
          signal: AbortSignal.timeout(15000),
        });
        if (!resp.ok) throw new Error(`Image NOAA non disponible (${resp.status})`);
        const buffer = await resp.arrayBuffer();
        const base64 = Buffer.from(buffer).toString("base64");
        const mimeType = (resp.headers.get("content-type") ?? "image/gif").split(";")[0];
        return { inlineData: { data: base64, mimeType } };
      }),
    );
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : "Erreur lors du chargement des images" });
    return;
  }

  const prompt =
    ANALYSIS_PROMPTS[noteKey] ??
    `Tu es météorologue expert en Afrique de l'Ouest (ASECNA/Mali). Analyse ces cartes NOAA "${sectionLabel}". Décris les éléments météorologiques significatifs pour l'Afrique de l'Ouest et le Mali. Style bulletin opérationnel, 3-4 phrases max, en français.`;

  const geminiResp = await fetch(
    `https://generativelanguage.googleapis.com/v1/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }, ...imageParts] }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 600 },
      }),
      signal: AbortSignal.timeout(45000),
    },
  );

  if (!geminiResp.ok) {
    const errText = await geminiResp.text();
    res.status(502).json({ error: `Erreur Gemini: ${errText}` });
    return;
  }

  const data = (await geminiResp.json()) as {
    candidates?: Array<{ content: { parts: Array<{ text: string }> } }>;
  };
  const observation = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  res.json({ observation });
});

export default router;
