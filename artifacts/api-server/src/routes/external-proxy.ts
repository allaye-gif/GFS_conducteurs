import { Router, type IRouter } from "express";
import { getWaffgsLatestTime, fetchWaffgsImage } from "../lib/waffgs-proxy";
import { fetchUkMetImage, invalidateUkMetToken } from "../lib/ukmet-proxy";
import { logger } from "../lib/logger";

const router: IRouter = Router();

// ─── WAFFGS proxy ─────────────────────────────────────────────────────────────

router.get("/briefing/waffgs/latest-time", async (_req, res): Promise<void> => {
  const time = await getWaffgsLatestTime();
  if (!time) {
    res.status(503).json({ error: "Données WAFFGS temporairement indisponibles" });
    return;
  }
  res.json(time);
});

router.get("/briefing/waffgs/image", async (req, res): Promise<void> => {
  const { product, year, month, day, hour } = req.query as Record<string, string>;

  if (!product || !["ASM", "FFR"].includes(product)) {
    res.status(400).json({ error: "product doit être ASM ou FFR" });
    return;
  }
  if (!year || !month || !day || !hour) {
    res.status(400).json({ error: "year, month, day, hour requis" });
    return;
  }

  try {
    const result = await fetchWaffgsImage({
      product: product as "ASM" | "FFR",
      year, month, day, hour,
    });

    res.setHeader("Content-Type", result.contentType);
    res.setHeader("Cache-Control", "public, max-age=900");
    res.setHeader("X-Has-Data", result.hasData ? "true" : "false");
    res.send(result.data);
  } catch (err) {
    req.log.warn({ err }, "WAFFGS image fetch error");
    res.status(502).json({
      error: err instanceof Error ? err.message : "Erreur WAFFGS",
    });
  }
});

// ─── UK Met proxy ─────────────────────────────────────────────────────────────

const UKMET_ALLOWED_HOSTS = [
  "africawebviewer.metoffice.gov.uk",
];

router.get("/briefing/ukmet/image", async (req, res): Promise<void> => {
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

  if (!UKMET_ALLOWED_HOSTS.includes(targetUrl.hostname)) {
    res.status(403).json({ error: "Hôte UK Met non autorisé" });
    return;
  }

  try {
    const { data, contentType } = await fetchUkMetImage(rawUrl);
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=900");
    res.send(data);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Erreur UK Met";
    req.log.warn({ err }, "UK Met image fetch error");

    if (msg.includes("token invalidé")) {
      res.status(401).json({ error: msg });
    } else if (msg.includes("login") || msg.includes("csrf") || msg.includes("token introuvable")) {
      logger.error({ err }, "UK Met: échec du login B2C");
      res.status(503).json({ error: "Authentification UK Met échouée" });
    } else {
      res.status(502).json({ error: msg });
    }
  }
});

router.post("/briefing/ukmet/invalidate-token", (_req, res): void => {
  invalidateUkMetToken();
  res.json({ ok: true });
});

// ─── EUMETSAT WMS proxy (public, no auth) ─────────────────────────────────────

const EUMETSAT_WMS_BASE = "https://view.eumetsat.int/geoserver/wms";

const EUMETSAT_ALLOWED_LAYERS = new Set([
  "msg_fes:ir108",
  "msg_fes:ir039",
  "msg_fes:rgb_natural",
  "msg_rss:rgb_natural_nrt",
  "msg_fes:rgb_convection",
  "msg_iodc:rgb_convection",
  "msg_fes:rgb_airmass",
  "msg_iodc:rgb_airmass",
  "msg_fes:rgb_dust",
  "msg_iodc:rgb_dust",
  "msg_fes:rgb_microphysics",
  "msg_rss:rgb_microphysics_nrt",
  "msg_fes:wv062",
  "msg_iodc:wv062",
  "msg_fes:rgb_fog",
  "msg_iodc:rgb_fog",
  "mtg_fd:rgb_truecolour",
  "mtg_fd:rgb_geocolour",
]);

// Bbox West Africa / Sahel — centré Mali : lon -20→20, lat 0→30
const EUMETSAT_BBOX = "-30,-5,30,35";
const EUMETSAT_WIDTH = "800";
const EUMETSAT_HEIGHT = "600";

router.get("/briefing/eumetsat/image", async (req, res): Promise<void> => {
  const layer = req.query.layer;
  if (typeof layer !== "string" || !EUMETSAT_ALLOWED_LAYERS.has(layer)) {
    res.status(400).json({ error: "Layer EUMETSAT non autorisé" });
    return;
  }

  const bbox = typeof req.query.bbox === "string" ? req.query.bbox : EUMETSAT_BBOX;
  const width = typeof req.query.width === "string" ? req.query.width : EUMETSAT_WIDTH;
  const height = typeof req.query.height === "string" ? req.query.height : EUMETSAT_HEIGHT;
  const time = typeof req.query.time === "string" && req.query.time ? req.query.time : null;

  let url =
    `${EUMETSAT_WMS_BASE}?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap` +
    `&LAYERS=${encodeURIComponent(layer)}&STYLES=` +
    `&CRS=CRS:84&BBOX=${bbox}` +
    `&WIDTH=${width}&HEIGHT=${height}` +
    `&FORMAT=image%2Fpng`;

  if (time) {
    url += `&TIME=${encodeURIComponent(time)}`;
  }

  try {
    const upstream = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0", Accept: "image/png,image/*" },
      signal: AbortSignal.timeout(25000),
    });

    if (!upstream.ok) {
      req.log.warn({ layer, status: upstream.status }, "EUMETSAT WMS erreur");
      res.status(502).json({ error: `EUMETSAT: HTTP ${upstream.status}` });
      return;
    }

    const ct = upstream.headers.get("content-type") ?? "image/png";
    const data = Buffer.from(await upstream.arrayBuffer());

    res.setHeader("Content-Type", ct);
    // Images pinned à une heure précise (TIME param) → cache 24h ; sinon 15 min
    const cacheMaxAge = time ? 86400 : 900;
    res.setHeader("Cache-Control", `public, max-age=${cacheMaxAge}`);
    res.send(data);
  } catch (err) {
    req.log.warn({ err, layer }, "EUMETSAT proxy erreur");
    res.status(502).json({ error: err instanceof Error ? err.message : "Erreur EUMETSAT" });
  }
});

// ─── MISVA proxy (api.sedoo.fr/sedoo-campaigns-rest-fats) ─────────────────────

const MISVA_API_BASE =
  "https://api.sedoo.fr/sedoo-campaigns-rest-fats/data/v1_0";

const MISVA_ALLOWED_PRODUCTS = new Set([
  "Anasyg",
  "Synopt_Cartes_Prevues",
  "synopt_series_prevues",
  "Obs_Series",
  "Obs_Cartes",
]);

router.get("/briefing/misva/image", async (req, res): Promise<void> => {
  const { product, day, file } = req.query;
  if (
    typeof product !== "string" ||
    !MISVA_ALLOWED_PRODUCTS.has(product) ||
    typeof day !== "string" ||
    !day.match(/^\d{4}-\d{2}-\d{2}$/) ||
    typeof file !== "string" ||
    !file
  ) {
    res.status(400).json({ error: "Paramètres MISVA invalides" });
    return;
  }

  const url =
    `${MISVA_API_BASE}/getimage` +
    `?product=${encodeURIComponent(product)}` +
    `&day=${encodeURIComponent(day)}` +
    `&file=${encodeURIComponent(file)}` +
    `&campaign=MISVA`;

  try {
    const upstream = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0", Accept: "image/*" },
      signal: AbortSignal.timeout(15000),
    });

    if (!upstream.ok) {
      req.log.warn({ product, day, file, status: upstream.status }, "MISVA proxy erreur");
      res.status(502).json({ error: `MISVA: HTTP ${upstream.status}` });
      return;
    }

    const ct = upstream.headers.get("content-type") ?? "image/gif";
    const data = Buffer.from(await upstream.arrayBuffer());

    res.setHeader("Content-Type", ct);
    res.setHeader("Cache-Control", "public, max-age=86400"); // 24h — images MISVA archivées par jour
    res.send(data);
  } catch (err) {
    req.log.warn({ err, product }, "MISVA proxy erreur");
    res.status(502).json({ error: err instanceof Error ? err.message : "Erreur MISVA" });
  }
});

export default router;
