import { Router } from "express";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as http from "http";
import {
  listSynergieArchive, syncArchiveToCache,
  getCachedFile, localCachePath, resolveArchivePath,
  openSFTP, runSSHCommand, readRemoteFile, resolveSynergieReseau,
} from "../lib/synergie-sftp.js";
import { extractGribGrid, sampleGridAt, type GribGrid } from "../lib/grib-extract.js";
import { renderGribSvg, SCALES, type ColorStop } from "../lib/grib-render.js";
import { computeAbsoluteVorticityX1e7 } from "../lib/grib-vorticity.js";
import { renderVorticityComboSvg, type VorticityLayer } from "../lib/grib-vorticity-render.js";

const MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
};

const WEBSERV_HOST = () => process.env.SYABAN02_HOST ?? "192.168.0.37";
const WEBSERV_PORT = () => parseInt(process.env.SYABAN02_WEBSERV_PORT ?? "8080");

// Emprise Mali (avec marge) utilisee pour zoomer l'affichage des cartes vent
// et TA — la grille extraite garde toute l'emprise GFSAFR025 (Afrique de
// l'Ouest), seule la projection ecran est recadree (cf. `viewBounds` dans
// grib-render.ts/grib-vorticity-render.ts), ce qui densifie visuellement les
// barbules de vent/isolignes sans extraction supplementaire.
const MALI_BBOX = { lon0: -13, lon1: 5, lat0: 9, lat1: 26 };

const router = Router();

// ─── Cache disque pour render-grib ───────────────────────────────────────────
// On extrait les donnees brutes (extr_grib_modele.sh + grib_get_data, voir
// lib/grib-extract.ts) et on dessine la carte nous-memes (lib/grib-render.ts)
// plutot que de piloter visu_modele/X11 par capture d'ecran — ce dernier
// n'affichait pas les donnees malgre une extraction confirmee correcte (voir
// l'historique dans le commit precedent). Cache long (~7h, plus d'un cycle
// GFS) : une extraction reussie reste valable jusqu'au prochain cycle.
const GRIB_CACHE_DIR = path.join(os.tmpdir(), "synergie-grib-cache");
const GRIB_CACHE_TTL = 7 * 60 * 60 * 1000;
try { fs.mkdirSync(GRIB_CACHE_DIR, { recursive: true }); } catch { /* ignore */ }

function gribCacheKey(key: string, synDate: string, echeance: string, duree: string): string {
  return path.join(GRIB_CACHE_DIR, `${key}_${synDate}_${echeance}_${duree}.svg`.replace(/[^a-zA-Z0-9._-]/g, "_"));
}
function gribCacheValid(f: string): boolean {
  try { return (Date.now() - fs.statSync(f).mtimeMs) < GRIB_CACHE_TTL; } catch { return false; }
}

// GET /api/synergie/archive — liste + synchro cache en arrière-plan
router.get("/synergie/archive", async (req, res) => {
  try {
    const files = await listSynergieArchive();
    syncArchiveToCache(files).catch((e) =>
      req.log.warn({ err: e }, "synergie: sync cache failed")
    );
    res.json({ files });
  } catch (err) {
    req.log.warn({ err }, "synergie/archive: SFTP error");
    res.status(503).json({ error: "SYABAN02 inaccessible", detail: String(err) });
  }
});

// GET /api/synergie/archive/file?path=sous-dossier/fichier.gif
router.get("/synergie/archive/file", async (req, res) => {
  const rawPath = String(req.query["path"] ?? req.query["name"] ?? "").replace(/\\/g, "/");
  if (!rawPath) { res.status(400).json({ error: "Paramètre manquant" }); return; }
  if (rawPath.includes("..") || rawPath.startsWith("/") || rawPath.includes("\0")) {
    res.status(400).json({ error: "Chemin invalide" }); return;
  }

  const ext = (rawPath.split(".").pop() ?? "").toLowerCase();
  const contentType = MIME[ext] ?? "application/octet-stream";

  const cached = localCachePath(rawPath);
  if (fs.existsSync(cached)) {
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=1800");
    res.setHeader("X-Cache", "HIT");
    fs.createReadStream(cached).pipe(res);
    return;
  }

  try {
    const localFile = await getCachedFile(rawPath);
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=1800");
    res.setHeader("X-Cache", "MISS");
    fs.createReadStream(localFile).pipe(res);
  } catch (err) {
    req.log.warn({ err, rawPath }, "synergie/file: SFTP error");
    if (!res.headersSent) res.status(503).json({ error: "Fichier non disponible", detail: String(err) });
  }
});

// POST /api/synergie/sync — force re-synchro de tout l'archive
router.post("/synergie/sync", async (req, res) => {
  try {
    const files = await listSynergieArchive();
    await syncArchiveToCache(files);
    res.json({ ok: true, synced: files.length });
  } catch (err) {
    res.status(503).json({ error: String(err) });
  }
});

// GET /api/synergie/probe-ports — teste quels ports HTTP répondent sur SYABAN02
// (ne nécessite PAS SSH — utile quand SSH timeout)
router.get("/synergie/probe-ports", async (_req, res) => {
  const host = WEBSERV_HOST();
  const ports = [80, 8080, 8081, 8000, 8888, 443, 8443];
  const paths = ["/", "/wms?SERVICE=WMS&REQUEST=GetCapabilities", "/soap/", "/soap/?wsdl", "/appl/", "/wms/", "/ows"];

  const results: Array<{ port: number; path: string; status: number | null; contentType: string; snippet: string; error?: string }> = [];

  const probe = (port: number, urlPath: string) =>
    new Promise<void>((resolve) => {
      const chunks: Buffer[] = [];
      const req = http.get({ host, port, path: urlPath, timeout: 4_000 }, (r) => {
        r.on("data", (d: Buffer) => { if (chunks.reduce((s, c) => s + c.length, 0) < 2_000) chunks.push(d); });
        r.on("end", () => {
          const snippet = Buffer.concat(chunks).toString("utf8").slice(0, 500).replace(/\s+/g, " ").trim();
          results.push({ port, path: urlPath, status: r.statusCode ?? null, contentType: String(r.headers["content-type"] ?? ""), snippet });
          resolve();
        });
        r.on("error", () => resolve());
      });
      req.on("timeout", () => { req.destroy(); results.push({ port, path: urlPath, status: null, contentType: "", snippet: "", error: "timeout" }); resolve(); });
      req.on("error", (e) => { results.push({ port, path: urlPath, status: null, contentType: "", snippet: "", error: (e as NodeJS.ErrnoException).code ?? String(e) }); resolve(); });
    });

  // Teste d'abord si le port répond, puis les chemins WMS/SOAP
  const portOpen: number[] = [];
  await Promise.all(ports.map(port => probe(port, "/")));
  for (const r of results) {
    if (r.status !== null && !portOpen.includes(r.port)) portOpen.push(r.port);
  }

  // Sur les ports ouverts, teste les chemins WMS/SOAP
  await Promise.all(portOpen.flatMap(port => paths.slice(1).map(p => probe(port, p))));

  res.json({ host, portOpen, results: results.filter(r => r.status !== null || r.error !== "timeout") });
});

// GET /api/synergie/soap-explore?service=Sympo2
// Essaie plusieurs chemins WSDL connus (CodeIgniter/Synergie) et retourne JSON lisible
router.get("/synergie/soap-explore", async (req, res) => {
  const service = String(req.query["service"] ?? "Sympo2").replace(/[^a-zA-Z0-9_-]/g, "");
  const host = WEBSERV_HOST();
  const port = WEBSERV_PORT();

  const candidates = [
    `/soap/wsdl/${service}`,           // chemin réel confirmé : /soap/wsdl/[service]
    `/soap/wsdl/index.php/${service}`,
    `/soap/wsdl/${service}/wsdl`,
    `/soap/${service}?wsdl`,
    `/soap/${service}/WSDL`,
    `/soap/WSDL`,
    `/soap/wsdl/`,                     // intro page de la section WSDL
    `/soap/`,
  ];

  const fetchText = (urlPath: string): Promise<{ url: string; status: number; ct: string; body: string; error?: string }> =>
    new Promise((resolve) => {
      const chunks: Buffer[] = [];
      const r = http.get({ host, port, path: urlPath, timeout: 6_000 }, (res2) => {
        res2.on("data", (d: Buffer) => { if (chunks.reduce((s, c) => s + c.length, 0) < 50_000) chunks.push(d); });
        res2.on("end", () => resolve({ url: `http://${host}:${port}${urlPath}`, status: res2.statusCode ?? 0, ct: String(res2.headers["content-type"] ?? ""), body: Buffer.concat(chunks).toString("utf8") }));
        res2.on("error", () => resolve({ url: `http://${host}:${port}${urlPath}`, status: 0, ct: "", body: "", error: "stream error" }));
      });
      r.on("timeout", () => { r.destroy(); resolve({ url: `http://${host}:${port}${urlPath}`, status: 0, ct: "", body: "", error: "timeout" }); });
      r.on("error", (e) => resolve({ url: `http://${host}:${port}${urlPath}`, status: 0, ct: "", body: "", error: (e as NodeJS.ErrnoException).code ?? String(e) }));
    });

  const results = await Promise.all(candidates.map(fetchText));
  const successful = results.filter(r => r.status >= 200 && r.status < 400 && r.body.length > 10);
  res.json({ service, host, port, successful, all: results.map(r => ({ url: r.url, status: r.status, ct: r.ct, bytes: r.body.length, error: r.error, preview: r.body.slice(0, 300) })) });
});

// ─── Proxy HTTP vers le webserv SYABAN02 (SOAP/WMS) ─────────────────────────
// GET /api/synergie/webserv?path=/wms?SERVICE=WMS&REQUEST=GetCapabilities
router.get("/synergie/webserv", (req, res) => {
  const rawPath = String(req.query["path"] ?? "/").trim();
  const port    = parseInt(String(req.query["port"] ?? "")) || WEBSERV_PORT();
  if (!rawPath.startsWith("/")) { res.status(400).json({ error: "Chemin invalide" }); return; }

  const host = WEBSERV_HOST();
  const fullUrl = `http://${host}:${port}${rawPath}`;

  const proxyReq = http.get({ host, port, path: rawPath, timeout: 15_000 }, (proxyRes) => {
    const ct = proxyRes.headers["content-type"] ?? "application/octet-stream";
    res.setHeader("Content-Type", ct);
    res.setHeader("Cache-Control", "public, max-age=300");
    res.setHeader("X-Synergie-Webserv-URL", fullUrl);
    res.status(proxyRes.statusCode ?? 200);
    proxyRes.pipe(res);
  });
  proxyReq.on("timeout", () => {
    proxyReq.destroy();
    if (!res.headersSent) res.status(504).json({ error: "Timeout", url: fullUrl });
  });
  proxyReq.on("error", (e) => {
    if (!res.headersSent) res.status(503).json({ error: `Webserv inaccessible: ${String(e)}`, url: fullUrl });
  });
});

// GET /api/synergie/read-file?path=/home/synergie/webserv/config/httpd.conf
// Lit un fichier texte via la connexion SFTP partagée (pas de nouvelle connexion SSH)
router.get("/synergie/read-file", async (req, res) => {
  const filePath = String(req.query["path"] ?? "").trim();
  if (!filePath.startsWith("/home/synergie") || filePath.includes("..") || filePath.includes("\0")) {
    res.status(400).json({ error: "Chemin invalide (doit commencer par /home/synergie)" }); return;
  }
  try {
    const { content, truncated } = await readRemoteFile(filePath);
    res.json({ path: filePath, content, truncated });
  } catch (err) {
    const msg = String(err);
    const status = msg.includes("non trouvé") ? 404 : 503;
    res.status(status).json({ error: msg, path: filePath });
  }
});

// GET /api/synergie/diagnostic — scan complet de SYABAN02
router.get("/synergie/diagnostic", async (req, res) => {
  const cmds: { key: string; cmd: string; label: string }[] = [
    { key: "all_files",  label: "Tous les fichiers",         cmd: "find /home/synergie -type f 2>/dev/null | sort" },
    { key: "all_dirs",   label: "Tous les dossiers",         cmd: "find /home/synergie -type d 2>/dev/null | sort" },
    { key: "gif_files",  label: "Fichiers GIF/PNG/JPG",      cmd: "find /home/synergie -type f \\( -name '*.gif' -o -name '*.png' -o -name '*.jpg' \\) 2>/dev/null | sort" },
    { key: "grib_files", label: "Fichiers GRIB/netCDF",      cmd: "find /home/synergie -type f \\( -name '*.grib' -o -name '*.grib2' -o -name '*.grb' -o -name '*.grb2' -o -name '*.nc' \\) 2>/dev/null | sort | head -100" },
    { key: "scripts",    label: "Scripts (.sh .py .pl .tcl)", cmd: "find /home/synergie -type f \\( -name '*.sh' -o -name '*.py' -o -name '*.pl' -o -name '*.tcl' \\) 2>/dev/null | sort" },
    { key: "configs",    label: "Fichiers de configuration", cmd: "find /home/synergie -type f \\( -name '*.conf' -o -name '*.cfg' -o -name '*.ini' -o -name '*.xml' -o -name '*.json' -o -name '*.yaml' \\) 2>/dev/null | sort" },
    { key: "crontab",    label: "Tâches planifiées (cron)",  cmd: "crontab -l 2>&1; echo '---CRON.D---'; ls /etc/cron.d/ 2>/dev/null; cat /etc/cron.d/* 2>/dev/null" },
    { key: "processes",  label: "Processus en cours",        cmd: "ps aux 2>/dev/null" },
    { key: "recent",     label: "Fichiers modifiés (7j)",    cmd: "find /home/synergie -type f -mtime -7 2>/dev/null -printf '%TY-%Tm-%Td %TH:%TM  %p\\n' 2>/dev/null | sort -r | head -60; find /home/synergie -type f -newer /tmp -printf '%TY-%Tm-%Td %TH:%TM  %p\\n' 2>/dev/null | sort -r | head -20" },
    // Fichiers de config essentiels pour le webserv et les paramètres modèle
    { key: "httpd_conf",  label: "Config Apache webserv (port)",      cmd: "head -n 60 /home/synergie/webserv/config/httpd.conf 2>/dev/null || head -n 60 /home/synergie/webserv4.7.0/config/httpd.conf 2>/dev/null" },
    { key: "httpd_8081",  label: "Config Apache client (port 8081)",  cmd: "head -n 30 /home/synergie/client/apache/config_auto/httpd-8081.conf 2>/dev/null || head -n 30 /home/synergie/client4.7.0/apache/config_auto/httpd-8081.conf 2>/dev/null" },
    { key: "param_cfg",   label: "Paramètres modèle (param.cfg)",     cmd: "cat /home/synergie/adminkit/config-model/config/fr/param.cfg 2>/dev/null || cat /home/synergie/adminkit/config-model/config/en/param.cfg 2>/dev/null" },
    { key: "wms_layers",  label: "Couches WMS (layers.xml)",          cmd: "cat /home/synergie/webserv/www/wms/application/config/layers.xml 2>/dev/null || cat /home/synergie/webserv4.7.0/www/wms/application/config/layers.xml 2>/dev/null" },
    { key: "wms_config",  label: "Config WMS",                        cmd: "cat /home/synergie/webserv/config/wms_config.ini 2>/dev/null || cat /home/synergie/webserv4.7.0/config/wms_config.ini 2>/dev/null" },
    { key: "models_ini",  label: "Config modèles NWP",                cmd: "cat /home/synergie/adminkit/config-model/config/synergie-config-models.ini 2>/dev/null | head -100" },
    { key: "soap_config", label: "Config SOAP",                       cmd: "cat /home/synergie/webserv/config/soap_config.ini 2>/dev/null || cat /home/synergie/webserv4.7.0/config/soap_config.ini 2>/dev/null" },
  ];

  const results: Record<string, { label: string; stdout: string; stderr: string; error?: string }> = {};
  for (const { key, cmd, label } of cmds) {
    try {
      const { stdout, stderr } = await runSSHCommand(cmd);
      results[key] = { label, stdout: stdout.trim(), stderr: stderr.trim() };
    } catch (e) {
      results[key] = { label, stdout: "", stderr: "", error: String(e) };
    }
  }
  res.json({ host: process.env.SYABAN02_HOST ?? "192.168.0.37", results });
});

// GET /api/synergie/find-charts — cherche les vraies cartes GFS/modèle sur SYABAN02
router.get("/synergie/find-charts", async (req, res) => {
  const cmds = [
    // v5: focus sur la génération automatique de cartes

    // 1. Script make-archive complet
    { key: "make_archive",      cmd: "cat /home/synergie/adminkit/config-printers/tools/make-archive 2>/dev/null" },

    // 2. Contenu de cmd167111 — format de commande Synergie visu_modele
    { key: "cmd167111",         cmd: "strings /home/synergie/client/tmp/cmd167111 2>/dev/null" },

    // 3. Tâches fcron complètes pour modèle et briefing
    { key: "fcron_tasks",       cmd: "find /home/synergie/server/config/gest/taches -type f 2>/dev/null | sort; echo '---'; cat /home/synergie/server/config/gest/taches/modele/*.fcrontab 2>/dev/null; cat /home/synergie/server/config/gest/taches/modele/fcrontab 2>/dev/null" },

    // 4. Spy log complet — chaque appel à grib_modele.sh est loggué ici
    { key: "spy_log",           cmd: "ls /home/synergie/spy/ 2>/dev/null; echo '---'; cat /home/synergie/spy/007.* 2>/dev/null | tail -100" },

    // 5. Tools dispo pour rendu headless (Xvfb, xwd, scrot, import) et grib_modele.sh full
    { key: "headless_tools",    cmd: "which Xvfb xvfb-run xwd scrot xdpyinfo xwininfo 2>/dev/null; echo '---DISPLAY---'; echo $DISPLAY; echo '---ENV---'; env | grep -i 'DISPLAY\\|SYNERGIE\\|HOME' 2>/dev/null; echo '---PRINTERS---'; ls /home/synergie/client4.7.0/config/impr/printers/ 2>/dev/null" },

    // 6. Filtre du printer Archive (convert ImageMagick)
    { key: "archive_printer",   cmd: "cat /home/synergie/client4.7.0/config/impr/printers/Archive/filter 2>/dev/null; echo '---LocalArchive---'; cat /home/synergie/client4.7.0/config/impr/printers/LocalArchive/filter 2>/dev/null; echo '---CUPS---'; lpstat -v 2>/dev/null | head -20" },

    // 7. Script grib_modele.sh complet (pour comprendre comment le piloter)
    { key: "grib_modele_full",  cmd: "cat /home/synergie/client/bin/grib_modele.sh 2>/dev/null || cat /home/synergie/client4.7.0/bin/grib_modele.sh 2>/dev/null" },

    // 8. Variables d'environnement Synergie et DOMAINES.ascii (noms de domaines valides)
    { key: "synergie_env",      cmd: "cat /home/synergie/client4.7.0/etc/profile 2>/dev/null | head -60; echo '---DOMAINES---'; cat /home/synergie/server/config/gest/domaines/DOMAINES.ascii 2>/dev/null | head -30 || find /home/synergie -name 'DOMAINES.ascii' 2>/dev/null | head -5 | xargs cat 2>/dev/null | head -30" },
  ];
  const results: Record<string, string> = {};
  for (const { key, cmd } of cmds) {
    try {
      const { stdout } = await runSSHCommand(cmd);
      results[key] = stdout.trim();
    } catch (e) {
      results[key] = `ERREUR: ${String(e)}`;
    }
  }
  res.json(results);
});

// GET /api/synergie/probe-report — rapport téléchargeable (texte brut, pas de copier-coller)
// Ouvrir dans le navigateur → télécharge automatiquement synergie-probe.txt
router.get("/synergie/probe-report", async (req, res) => {
  const cmds: Array<{ title: string; cmd: string }> = [
    {
      title: "=== 1. DISPLAY & ENV SYNERGIE ===",
      cmd: "echo DISPLAY=$DISPLAY; echo HOME=$HOME; echo LOGNAME=$LOGNAME; env | grep -iE 'SYNERGIE|SYNERGI|GRIB|VISU|DOMAINE' | sort",
    },
    {
      title: "=== 2. OUTILS HEADLESS (Xvfb, xwd, scrot) ===",
      cmd: "which Xvfb xvfb-run xwd scrot xdpyinfo import convert 2>&1; echo '---PRINTERS---'; ls /home/synergie/client4.7.0/config/impr/printers/ 2>/dev/null",
    },
    {
      title: "=== 3. cmd167111 (commande visu_modele en cours) ===",
      cmd: "strings /home/synergie/client/tmp/cmd167111 2>/dev/null",
    },
    {
      title: "=== 4. SPY LOG (historique grib_modele.sh) ===",
      cmd: "ls /home/synergie/spy/ 2>/dev/null; echo '---CONTENU---'; cat /home/synergie/spy/007.* 2>/dev/null | tail -80",
    },
    {
      title: "=== 5. FCRON TACHES MODELE ===",
      cmd: "find /home/synergie/server/config/gest/taches -type f 2>/dev/null | sort; echo '---FCRONTAB---'; cat /home/synergie/server/config/gest/taches/modele/fcrontab 2>/dev/null; cat /home/synergie/server/config/gest/taches/modele/*.fcrontab 2>/dev/null",
    },
    {
      title: "=== 6. ARCHIVE PRINTER FILTER (script shell) ===",
      cmd: "cat /home/synergie/client4.7.0/config/impr/printers/Archive/filter 2>/dev/null; echo '---LocalArchive FILTER---'; cat /home/synergie/client4.7.0/config/impr/printers/LocalArchive/filter 2>/dev/null",
    },
    {
      title: "=== 7. GRIB_MODELE.SH (script complet) ===",
      cmd: "cat /home/synergie/client/bin/grib_modele.sh 2>/dev/null || cat /home/synergie/client4.7.0/bin/grib_modele.sh 2>/dev/null",
    },
    {
      title: "=== 8. DOMAINES.ASCII (domaines valides) ===",
      cmd: "find /home/synergie -name 'DOMAINES.ascii' 2>/dev/null | head -3 | xargs cat 2>/dev/null | head -40",
    },
    {
      title: "=== 9. SYNERGIE PROFILE / ENV VARS ===",
      cmd: "cat /home/synergie/client4.7.0/etc/profile 2>/dev/null | head -80",
    },
    {
      title: "=== 10. XSESSIONS / XSTARTUP (X11 actif?) ===",
      cmd: "ps aux 2>/dev/null | grep -iE 'X|Xorg|xvfb|xinit|xfce|gnome|kde' | grep -v grep | head -20; echo '---XLSCLIENTS---'; xlsclients -display $DISPLAY 2>/dev/null | head -20; echo '---XWININFO visu_modele---'; xwininfo -root -tree 2>/dev/null | grep -i 'visu\\|modele\\|grib' | head -10",
    },
  ];

  const lines: string[] = [
    `SYABAN02 PROBE REPORT — ${new Date().toISOString()}`,
    `Host: ${process.env.SYABAN02_HOST ?? "192.168.0.37"}`,
    "",
  ];

  for (const { title, cmd } of cmds) {
    lines.push(title);
    try {
      const { stdout, stderr } = await runSSHCommand(cmd);
      const out = (stdout + (stderr ? `\n[stderr] ${stderr}` : "")).trim();
      lines.push(out || "(vide)");
    } catch (e) {
      lines.push(`ERREUR: ${String(e)}`);
    }
    lines.push("");
  }

  const body = lines.join("\n");
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="synergie-probe-${Date.now()}.txt"`);
  res.send(body);
});

// ─── Paramètres GFS connus pour GFSAFR025 ────────────────────────────────────
// Codes verifies contre /home/synergie/adminkit/config-model/config/fr/param.cfg
// (Codename;Synergie Name;...;Definition) et coord.cfg (coordonnees verticales
// valides : H, PV, MER, AERO, TH, P, IMMERSION, ISP — confirme dans le case
// $COORDV de grib_modele.sh). "duree" = argument Duree de cumul (ex: pluie sur
// 6H) ; laisser vide pour les champs instantanes (pas de cumul).
type ScalarParamDef = {
  kind: "scalar";
  param: string; combinaison: string; niveau: string; duree?: string;
  scale: keyof typeof SCALES; label: string;
};
type WindParamDef = {
  kind: "wind";
  combinaison: string; niveau: string;
  scale: "wind" | "windUpper"; label: string;
};
// Champ special : superposition du tourbillon absolu a 3 niveaux pour reperer
// le couplage convergence basse couche (850/700 hPa) / divergence en altitude
// (200 hPa) — cf. grib-vorticity.ts / grib-vorticity-render.ts pour le detail.
type VorticityComboParamDef = {
  kind: "vorticity-combo";
  label: string;
};
type ParamDef = ScalarParamDef | WindParamDef | VorticityComboParamDef;

const GFS_PARAMS: Record<string, ParamDef> = {
  PMER:  { kind: "scalar", param: "PMER",   combinaison: "P", niveau: "SOL",    scale: "pmer",     label: "Pression réduite mer (hPa)" },
  // Niveaux 2m/10m = coordonnee verticale "H" (Hauteur), pas "P" (Pression).
  T2M:   { kind: "scalar", param: "T",      combinaison: "H", niveau: "2M",     scale: "temp",     label: "Température 2m (°C)" },
  // Vent = magnitude calculee depuis U+V (pas de champ FF stocke tel quel).
  FF10:  { kind: "wind",                    combinaison: "H", niveau: "10M",    scale: "wind",      label: "Vent 10m (m/s)" },
  // Flux en altitude = meme calcul U/V mais niveau de pression (comme HU850) —
  // plage de vent plus large (scale "windUpper") car le flux d'est africain
  // vers 850 hPa peut depasser largement le vent de surface.
  FF850: { kind: "wind",                    combinaison: "P", niveau: "850HPA", scale: "windUpper", label: "Flux 850 hPa (m/s)" },
  // Humidite relative = code "R", niveau pression = coordonnee "P" (comme PMER).
  // Niveaux de pression portent le suffixe HPA.
  HU850: { kind: "scalar", param: "R",      combinaison: "P", niveau: "850HPA", scale: "humidity", label: "Humidité relative 850 hPa (%)" },
  HU700: { kind: "scalar", param: "R",      combinaison: "P", niveau: "700HPA", scale: "humidity", label: "Humidité relative 700 hPa (%)" },
  // Precipitations = code "PRECIP" (confirme par inspection directe du catalogue
  // GRIB persistant) — "PLUIE" est un codename valide dans param.cfg mais n'a
  // aucun fichier extrait pour ce domaine.
  RR3H:  { kind: "scalar", param: "PRECIP", combinaison: "P", niveau: "SOL", duree: "3H", scale: "precip", label: "Précipitations 3h (mm)" },
  RR6H:  { kind: "scalar", param: "PRECIP", combinaison: "P", niveau: "SOL", duree: "6H", scale: "precip", label: "Précipitations 6h (mm)" },
  // CAPE retire : "CAPE_I" sur ce domaine correspond a de l'humidite du sol par
  // couche de profondeur (M0_10cm, M10_40cm...), pas a de l'energie convective —
  // confirme par inspection directe du catalogue GRIB. Le CAPE n'est simplement
  // pas dans le flux recu sur cette station.
  TOURCOMBO: { kind: "vorticity-combo", label: "Tourbillon absolu 850/700/200 hPa (couplage)" },
};

// ─── Utilitaire : SFTP download d'un fichier arbitraire ──────────────────────
async function downloadRemoteFile(remotePath: string): Promise<string> {
  const { conn, sftp } = await openSFTP();
  const localPath = path.join(os.tmpdir(), `syn_dl_${Date.now()}_${path.basename(remotePath)}`);
  try {
    await new Promise<void>((resolve, reject) => {
      sftp.fastGet(remotePath, localPath, (err) => (err ? reject(err) : resolve()));
    });
  } finally {
    conn.end();
  }
  return localPath;
}

// GET /api/synergie/x11-capture — capture l'écran DISPLAY=:0 (poste Synergie)
// Retourne directement une image PNG
router.get("/synergie/x11-capture", async (req, res) => {
  const ts = Date.now();
  const remotePng = `/tmp/synergie_cap_${ts}.png`;

  try {
    // import ImageMagick capture l'écran DISPLAY=:0 (fenêtre physique du poste)
    const { stdout, stderr } = await runSSHCommand(
      `DISPLAY=:0 /usr/bin/import -window root "${remotePng}" 2>&1 && echo __CAPTURE_OK__`
    );
    if (!stdout.includes("__CAPTURE_OK__")) {
      res.status(500).json({ error: "Capture X11 échouée", detail: stdout + stderr });
      return;
    }

    const localPath = await downloadRemoteFile(remotePng);
    // Nettoyage distant (fire-and-forget)
    runSSHCommand(`rm -f "${remotePng}"`).catch(() => {});

    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Captured-At", new Date().toISOString());
    const stream = fs.createReadStream(localPath);
    stream.pipe(res);
    stream.on("end", () => fs.unlink(localPath, () => {}));
    stream.on("error", (e) => {
      if (!res.headersSent) res.status(500).json({ error: String(e) });
    });
  } catch (err) {
    req.log.warn({ err }, "x11-capture: error");
    if (!res.headersSent) res.status(503).json({ error: String(err) });
  }
});

// GET /api/synergie/x11-windows — liste les fenêtres X11 ouvertes sur DISPLAY=:0
router.get("/synergie/x11-windows", async (req, res) => {
  try {
    const { stdout } = await runSSHCommand([
      // Clients connectés à X11 avec leurs noms de fenêtres
      `DISPLAY=:0 /usr/bin/xlsclients -l 2>/dev/null || echo "(xlsclients indisponible)"`,
      `echo '---PS VISU---'`,
      `ps aux 2>/dev/null | grep -iE 'visu_modele|grib_modele' | grep -v grep`,
      `echo '---XWININFO ROOT---'`,
      // Arbre complet sans limite de lignes
      `DISPLAY=:0 /usr/bin/xwininfo -root -tree 2>/dev/null`,
    ].join("; "));
    res.json({ ok: true, output: stdout });
  } catch (err) {
    res.status(503).json({ error: String(err) });
  }
});

type RenderLogger = { info: (o: object, m: string) => void; warn: (o: object, m: string) => void };

// ─── Rendu GRIB pur (reutilise par la route HTTP et par le warmer d'arriere-plan) ──
// Extrait les donnees brutes (extr_grib_modele.sh + grib_get_data, en forcant
// SYNERGIE_DEMO=ON pour lire les fichiers locaux plutot que le webservice
// distant instable) puis dessine la carte nous-memes — on ne pilote plus
// visu_modele/X11 du tout, qui n'affichait pas les donnees malgre une
// extraction confirmee correcte.
async function renderGribToLocalFile(
  key: string, reseau: string, echeance: string, dateArg: string | undefined, log: RenderLogger
): Promise<{ localPath: string; cfg: ParamDef; fromCache: boolean; size: number }> {
  const cfg = GFS_PARAMS[key];
  if (!cfg) {
    throw new Error(`Paramètre inconnu: ${key}. Valides: ${Object.keys(GFS_PARAMS).join(", ")}`);
  }

  // Date réseau Synergie (YYYYMMDDHHMMSS)
  const now = new Date();
  const rHH = reseau.replace("H", "").padStart(2, "0");
  const defDate = `${now.getUTCFullYear()}${String(now.getUTCMonth()+1).padStart(2,"0")}${String(now.getUTCDate()).padStart(2,"0")}${rHH}0000`;
  const synDate = dateArg ?? defDate;
  const duree = cfg.kind === "scalar" ? (cfg.duree ?? echeance) : echeance;

  // Heure VALIDE (reseau + echeance), pas juste l'heure du reseau — le run ne
  // change qu'a 00H/12H sur SYABAN02, mais une echeance de +18H depuis le
  // reseau 00H est valide a 18H, pas a 00H. L'overlay affichait jusqu'ici
  // toujours l'heure du reseau, ce qui etiquetait mal les echeances > 0.
  const echeanceHours = parseInt(echeance.replace("H", ""), 10) || 0;
  const validHour = (parseInt(rHH, 10) + echeanceHours) % 24;
  const validTimeLabel = `${String(validHour).padStart(2, "0")}00`;

  const cached = gribCacheKey(key, synDate, echeance, duree);
  if (gribCacheValid(cached)) {
    return { localPath: cached, cfg, fromCache: true, size: fs.statSync(cached).size };
  }

  log.info({ key, synDate, reseau, echeance }, "render-grib: extraction");

  // Champ special : 3 niveaux x 2 composantes (U/V) -> 3 tourbillons absolus
  // superposes en isolignes denses (pas d'aplat, pas de lissage, pas de filtre
  // anti-confetti — cf. grib-vorticity-render.ts : contrairement a PMER, la
  // texture fine et turbulente EST le signal utile ici) — traite a part avant
  // le chemin scalar/wind commun.
  if (cfg.kind === "vorticity-combo") {
    const NIVEAUX = ["850HPA", "700HPA", "200HPA"] as const;
    const grids = await Promise.all(
      NIVEAUX.map(async (niveau) => {
        const [uGrid, vGrid] = await Promise.all([
          extractGribGrid("U", niveau, echeance, synDate, "P"),
          extractGribGrid("V", niveau, echeance, synDate, "P"),
        ]);
        return { niveau, grid: uGrid, values: computeAbsoluteVorticityX1e7(uGrid, vGrid) };
      })
    );
    const base = grids[0]!.grid;

    // 850/700 hPa : isolignes de tourbillon cyclonique (10 a 1000, en unites
    // x10^-7 s^-1 — cf. grib-vorticity.ts) qui signent la convergence de basse
    // couche. 200 hPa : isolignes de tourbillon anticyclonique (-1000 a 0) qui
    // signent la divergence en altitude. Pas espace ~100 unites sur la plage
    // (pas 2 seuils isoles) pour retrouver le maillage dense de la vraie carte.
    const range = (lo: number, hi: number, step: number) => {
      const out: number[] = [];
      for (let v = lo; v <= hi; v += step) out.push(v);
      return out;
    };
    const layerSpecs: { niveau: string; label: string; color: [number, number, number]; levels: number[] }[] = [
      { niveau: "850HPA", label: "850 hPa conv. (10 à 1000)",  color: [220, 38, 38],  levels: range(50, 950, 80) },
      { niveau: "700HPA", label: "700 hPa conv. (10 à 1000)",  color: [22, 163, 74],  levels: range(50, 950, 80) },
      { niveau: "200HPA", label: "200 hPa div. (-1000 à 0)",   color: [37, 99, 235],  levels: range(-950, -50, 80) },
    ];
    const layers: VorticityLayer[] = layerSpecs.map((spec) => {
      const found = grids.find((g) => g.niveau === spec.niveau)!;
      return {
        label: spec.label,
        color: spec.color,
        values: found.values,
        ni: found.grid.ni,
        nj: found.grid.nj,
        levels: spec.levels,
      };
    });

    const svg = renderVorticityComboSvg({
      title: cfg.label,
      overlayTime: validTimeLabel,
      lon0: base.lon0, lon1: base.lon1, lat0: base.lat0, lat1: base.lat1,
      layers,
      viewBounds: MALI_BBOX,
    });
    fs.writeFileSync(cached, svg, "utf8");
    return { localPath: cached, cfg, fromCache: false, size: Buffer.byteLength(svg) };
  }

  let grid: GribGrid;
  let scaleKey: keyof typeof SCALES;
  let windBarbs: { u: number[]; v: number[] } | undefined;
  let streamlines: { u: number[]; v: number[] } | undefined;

  if (cfg.kind === "wind") {
    const [uGrid, vGrid] = await Promise.all([
      extractGribGrid("U", cfg.niveau, echeance, synDate, cfg.combinaison),
      extractGribGrid("V", cfg.niveau, echeance, synDate, cfg.combinaison),
    ]);
    const values = uGrid.values.map((u, i) => Math.sqrt(u * u + (vGrid.values[i] ?? 0) ** 2));
    grid = { ...uGrid, values };
    scaleKey = cfg.scale;
    // Flux 850 (FF850) suit maintenant le style Synergie "lignes de courant"
    // (capture de reference fournie par l'utilisateur) au lieu des barbules —
    // uniquement ce champ, le vent 10m (FF10) garde ses barbules deja
    // validees. L'aplat couleur (magnitude) reste dans les deux cas.
    if (key === "FF850") {
      streamlines = { u: uGrid.values, v: vGrid.values };
    } else {
      windBarbs = { u: uGrid.values, v: vGrid.values };
    }
  } else {
    grid = await extractGribGrid(cfg.param, cfg.niveau, echeance, synDate, cfg.combinaison);
    scaleKey = cfg.scale;
  }

  const scale = SCALES[scaleKey];
  const svg = renderGribSvg(grid, {
    title: cfg.label,
    subtitle: `GFSAFR025 (SYABAN02) — réseau ${reseau} — échéance +${echeance}`,
    unit: scale.unit,
    min: scale.min,
    max: scale.max,
    stops: scale.stops as unknown as ColorStop[],
    transform: scale.transform,
    contours: "contours" in scale ? scale.contours : undefined,
    bandBoundaries: "bandBoundaries" in scale ? (scale.bandBoundaries as unknown as number[]) : undefined,
    bandColors: "bandColors" in scale ? (scale.bandColors as unknown as [number, number, number][]) : undefined,
    overlayTime: validTimeLabel,
    windBarbs,
    streamlines,
    viewBounds: cfg.kind === "wind" ? MALI_BBOX : undefined,
  });

  fs.writeFileSync(cached, svg, "utf8");
  return { localPath: cached, cfg, fromCache: false, size: Buffer.byteLength(svg) };
}

// ─── Helper commun render-grib (GET + POST) ──────────────────────────────────
async function handleRenderGrib(
  key: string, reseau: string, echeance: string, dateArg: string | undefined,
  log: RenderLogger,
  res: import("express").Response
) {
  try {
    // localPath est toujours le fichier de cache lui-meme (le rendu ecrit
    // directement dedans) — rien a nettoyer apres coup, contrairement a
    // l'ancienne approche qui telechargeait un fichier temporaire distinct.
    const { localPath, cfg, fromCache } = await renderGribToLocalFile(key, reseau, echeance, dateArg, log);
    res.setHeader("Content-Type", "image/svg+xml");
    res.setHeader("Cache-Control", "public, max-age=300");
    res.setHeader("X-Grib-Key", key);
    res.setHeader("X-Grib-Label", cfg.label);
    res.setHeader("X-Cache", fromCache ? "HIT" : "MISS");
    const stream = fs.createReadStream(localPath);
    stream.pipe(res);
    stream.on("error", (e) => { if (!res.headersSent) res.status(500).json({ error: String(e) }); });
  } catch (err) {
    log.warn({ err }, "render-grib: error");
    if (!res.headersSent) res.status(503).json({ error: String(err) });
  }
}

// GET /api/synergie/point?lat=12.65&lon=-8.00&date=2026-07-24 — valeur ponctuelle
// (pas une carte) pour une coordonnee donnee : alimente le generateur de
// bulletins mfy_Mali en donnees GFSAFR025, en plus/alternative a Open-Meteo.
// Tmax/Tmin approximes par convention (06h = creux nocturne, 15h = pic
// diurne) — GFS ne fournit que des instantanes, pas un vrai min/max
// journalier. Nebulosite non exploitee (champ NEBUL_T jamais verifie a ce
// jour) : cloudPct utilise une valeur neutre fixe, seule la pluie pilote
// vraiment le choix d'icone.
const DIRS8 = ["N", "NE", "E", "SE", "S", "SO", "O", "NO"];
function compassFromUV(u: number, v: number): string {
  const bearingTo = ((Math.atan2(u, v) * 180) / Math.PI + 360) % 360;
  const bearingFrom = (bearingTo + 180) % 360; // direction d'ou vient le vent, convention meteo standard
  return DIRS8[Math.round(bearingFrom / 45) % 8]!;
}

router.get("/synergie/point", async (req, res) => {
  const lat = parseFloat(String(req.query["lat"] ?? ""));
  const lon = parseFloat(String(req.query["lon"] ?? ""));
  const dateStr = String(req.query["date"] ?? "");
  if (Number.isNaN(lat) || Number.isNaN(lon) || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    res.status(400).json({ error: "Paramètres requis : lat, lon, date (YYYY-MM-DD)" });
    return;
  }

  try {
    const { reseau, synDate } = await resolveSynergieReseau();
    const reseauHour = parseInt(reseau.replace("H", ""), 10) || 0;
    const runDateStr = synDate.slice(0, 8);
    const runDateUTC = Date.UTC(
      parseInt(runDateStr.slice(0, 4), 10), parseInt(runDateStr.slice(4, 6), 10) - 1, parseInt(runDateStr.slice(6, 8), 10)
    );
    const targetDateUTC = Date.UTC(
      parseInt(dateStr.slice(0, 4), 10), parseInt(dateStr.slice(5, 7), 10) - 1, parseInt(dateStr.slice(8, 10), 10)
    );
    const dayOffset = Math.round((targetDateUTC - runDateUTC) / 86_400_000);
    const echeanceFor = (hour: number) => dayOffset * 24 + hour - reseauHour;
    const ech06 = echeanceFor(6), ech12 = echeanceFor(12), ech15 = echeanceFor(15), ech18 = echeanceFor(18);

    if (ech06 < 3) {
      res.status(422).json({ error: `Date trop ancienne pour le cycle disponible (réseau ${reseau} du ${runDateStr})` });
      return;
    }

    const [t06Grid, t15Grid, uGrid, vGrid, precipGrid] = await Promise.all([
      extractGribGrid("T", "2M", `${ech06}H`, synDate, "H"),
      extractGribGrid("T", "2M", `${ech15}H`, synDate, "H"),
      extractGribGrid("U", "10M", `${ech12}H`, synDate, "H"),
      extractGribGrid("V", "10M", `${ech12}H`, synDate, "H"),
      extractGribGrid("PRECIP", "SOL", `${ech18}H`, synDate, "P"),
    ]);

    const t06 = sampleGridAt(t06Grid, lat, lon);
    const t15 = sampleGridAt(t15Grid, lat, lon);
    const u = sampleGridAt(uGrid, lat, lon);
    const v = sampleGridAt(vGrid, lat, lon);
    const precip = sampleGridAt(precipGrid, lat, lon) ?? 0;

    if (t06 === undefined || t15 === undefined || u === undefined || v === undefined) {
      res.status(422).json({ error: "Coordonnée hors de l'emprise de la grille GFSAFR025" });
      return;
    }

    const speedMs = Math.hypot(u, v);
    res.json({
      tmin: Math.round(t06 - 273.15),
      tmax: Math.round(t15 - 273.15),
      precipMm: Math.round(precip * 10) / 10,
      dir: compassFromUV(u, v),
      speedKmh: Math.round(speedMs * 3.6),
      reseau, synDate,
    });
  } catch (err) {
    req.log.warn({ err }, "synergie/point: error");
    res.status(503).json({ error: String(err) });
  }
});

// GET /api/synergie/render-grib?key=PMER&reseau=12H&echeance=6H  (testable depuis le navigateur)
// Note echeance : le catalogue GRIB reel n'a jamais "0H" (echeance minimale "3H")
// et n'utilise pas de zero devant ("6H", "12H" — pas "06H"). Un format different
// ne matche aucun fichier reel.
router.get("/synergie/render-grib", async (req, res) => {
  const key      = String(req.query["key"] ?? "PMER");
  const echeance = String(req.query["echeance"] ?? "6H");
  let reseau  = req.query["reseau"] ? String(req.query["reseau"]) : undefined;
  let dateArg = req.query["date"] ? String(req.query["date"]) : undefined;
  if (!reseau) {
    // Pas de reseau explicite : resout le cycle le plus recent DONT le
    // dossier existe vraiment sur SYABAN02 (avec repli automatique si le
    // cycle attendu par l'heure n'a pas encore ete rattrape, ex: apres un
    // redemarrage de SYABAN02) — voir resolveSynergieReseau.
    const resolved = await resolveSynergieReseau();
    reseau = resolved.reseau;
    dateArg = dateArg ?? resolved.synDate;
  }
  await handleRenderGrib(key, reseau, echeance, dateArg, req.log, res);
});

// ─── Warmer d'arrière-plan ────────────────────────────────────────────────────
// Pré-génère les cartes Synergie a intervalle regulier plutot que d'attendre
// qu'un utilisateur ouvre le briefing. Ca augmente les chances de tomber dans
// la fenetre ou les donnees GFS sont reellement extraites sur SYABAN02, et
// alimente le cache long terme (7h) consulte par la route HTTP ci-dessus.
// 4 echeances par produit desormais (voir SYNERGIE_ECHEANCES dans
// briefing-catalog.ts — memes valeurs, dupliquees ici pour eviter une
// dependance croisee entre les deux fichiers).
const WARM_ECHEANCES = ["6H", "12H", "18H", "24H"];
// T2M a une disposition speciale (comparaison auj./demain a heures fixes),
// toujours ancree sur le run 00H — memes valeurs que T2M_RESEAU/T2M_SLOTS
// dans briefing-catalog.ts (dupliquees ici, meme raison que ci-dessus).
const T2M_WARM_RESEAU = "00H";
const T2M_WARM_ECHEANCES = ["6H", "30H", "15H", "39H", "18H", "24H"];
let warmTimer: ReturnType<typeof setInterval> | null = null;

async function warmSynergieCache(log: RenderLogger): Promise<void> {
  const { reseau, synDate } = await resolveSynergieReseau();
  for (const key of Object.keys(GFS_PARAMS)) {
    const isT2M = key === "T2M";
    const warmReseau = isT2M ? T2M_WARM_RESEAU : reseau;
    const warmDate = isT2M ? undefined : synDate;
    const echeances = isT2M ? T2M_WARM_ECHEANCES : WARM_ECHEANCES;
    for (const echeance of echeances) {
      try {
        const { fromCache, size } = await renderGribToLocalFile(key, warmReseau, echeance, warmDate, log);
        log.info({ key, reseau: warmReseau, echeance, fromCache, size }, "synergie warm: ok");
      } catch (err) {
        log.warn({ key, reseau: warmReseau, echeance, err }, "synergie warm: échoué");
      }
    }
  }
}

export function startSynergieWarmScheduler(log: RenderLogger, intervalMs = 20 * 60 * 1000): void {
  if (warmTimer) return;
  const run = () => { warmSynergieCache(log).catch(() => {}); };
  run();
  warmTimer = setInterval(run, intervalMs);
}

// POST /api/synergie/render-grib  (body JSON: { key, reseau, echeance, date? })
router.post("/synergie/render-grib", async (req, res) => {
  const { key = "PMER", reseau = "00H", echeance = "6H", date: dateArg } = req.body as Record<string, string>;
  await handleRenderGrib(key, reseau, echeance, dateArg, req.log, res);
});

// GET /api/synergie/grib-check — diagnostic env grib_modele.sh (sans rendu)
router.get("/synergie/grib-check", async (req, res) => {
  try {
    const { stdout, stderr } = await runSSHCommand([
      // Profil Synergie
      `for prof in /home/synergie/client4.7.0/etc/profile /home/synergie/client/etc/profile; do [ -f "$prof" ] && cat "$prof" | grep -E 'PATH|SYNERGIE|export' | head -20 && echo "PROFILE=$prof" && break; done`,
      `echo '---WHICH---'`,
      `which grib_modele.sh 2>/dev/null || find /home/synergie -name 'grib_modele.sh' 2>/dev/null | head -3`,
      `echo '---GRIB ARGS---'`,
      // Lire le script grib_modele.sh pour voir les arguments attendus
      `head -40 $(which grib_modele.sh 2>/dev/null || find /home/synergie -name 'grib_modele.sh' 2>/dev/null | head -1) 2>/dev/null`,
      `echo '---XAUTH---'`,
      `ls /home/synergie/.Xauthority 2>/dev/null && echo "Xauthority existe" || echo "Pas de .Xauthority"`,
      `echo '---DISPLAY ENV---'`,
      `cat /proc/$(pgrep visu_modele | head -1)/environ 2>/dev/null | tr '\\0' '\\n' | grep -i display || echo "visu_modele non trouvé"`,
    ].join("; "));
    res.json({ ok: true, output: stdout, stderr });
  } catch (err) {
    res.status(503).json({ error: String(err) });
  }
});

// GET /api/synergie/gfs-params — liste les paramètres GFS disponibles
router.get("/synergie/gfs-params", (_req, res) => {
  res.json({ params: Object.entries(GFS_PARAMS).map(([k, v]) => ({ key: k, ...v })) });
});

// GET /api/synergie/exec?cmd=... (lecture seulement)
router.get("/synergie/exec", async (req, res) => {
  const cmd = String(req.query["cmd"] ?? "").trim();
  if (!cmd) { res.status(400).json({ error: "Paramètre cmd requis" }); return; }
  const allowed = /^(ls|find|cat|echo|pwd|whoami|env|ps|df|du|stat|file|head|tail|grep|which|uname|hostname|crontab)(\s|$|-)/;
  if (!allowed.test(cmd)) {
    res.status(403).json({ error: "Commande non autorisée" }); return;
  }
  try {
    const result = await runSSHCommand(cmd);
    res.json({ cmd, ...result });
  } catch (err) {
    res.status(503).json({ error: String(err) });
  }
});

export default router;
