import { Router } from "express";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as http from "http";
import {
  listSynergieArchive, syncArchiveToCache,
  getCachedFile, localCachePath, resolveArchivePath,
  openSFTP, runSSHCommand, readRemoteFile, computeSynergieReseau,
} from "../lib/synergie-sftp.js";

const MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
};

const WEBSERV_HOST = () => process.env.SYABAN02_HOST ?? "192.168.0.37";
const WEBSERV_PORT = () => parseInt(process.env.SYABAN02_WEBSERV_PORT ?? "8080");

const router = Router();

// ─── Cache disque pour render-grib ───────────────────────────────────────────
// Chaque rendu pilote une vraie session X11 + GUI sur SYABAN02 (10-60s, un
// seul display partagé). Les données GFS extraites sur SYABAN02 (tmp_modele)
// se comportent comme un tampon transitoire : une carte qui rend correctement
// à un instant T peut redevenir vide 30 min plus tard si la fenêtre de
// disponibilité est passée. Le cache est donc volontairement long (~7h, plus
// d'un cycle GFS) et n'est écrasé QUE par un rendu qui contient vraiment des
// données (voir MIN_VALID_GRIB_SIZE) — un rendu vide/échoué ne remplace jamais
// un dernier bon rendu en cache. Un job d'arrière-plan (voir
// startSynergieWarmScheduler) tente de le rafraîchir toutes les 20 min pour
// maximiser les chances de capturer la fenêtre utile de chaque cycle.
const GRIB_CACHE_DIR = path.join(os.tmpdir(), "synergie-grib-cache");
const GRIB_CACHE_TTL = 7 * 60 * 60 * 1000;
// En dessous de ce seuil, la carte est très probablement un fond de carte vide
// (pas de données) plutôt qu'un vrai rendu — observé empiriquement : les rendus
// vides font ~19-20 Ko, les rendus avec données réelles 44-112 Ko.
const MIN_VALID_GRIB_SIZE = 25_000;
try { fs.mkdirSync(GRIB_CACHE_DIR, { recursive: true }); } catch { /* ignore */ }

function gribCacheKey(key: string, synDate: string, echeance: string, duree: string): string {
  return path.join(GRIB_CACHE_DIR, `${key}_${synDate}_${echeance}_${duree}.png`.replace(/[^a-zA-Z0-9._-]/g, "_"));
}
function gribCacheValid(f: string): boolean {
  try { return (Date.now() - fs.statSync(f).mtimeMs) < GRIB_CACHE_TTL; } catch { return false; }
}

// ─── Verrou de rendu ──────────────────────────────────────────────────────────
// SYABAN02 n'a qu'un seul display X11 partage — deux rendus en parallele se
// marchent dessus (le nettoyage pre-lancement de l'un tue le rendu en cours de
// l'autre), produisant des captures vides/corrompues ou le bureau entier. Le
// briefing charge plusieurs cartes en parallele (une <img> par graphique), donc
// on serialise ici : un seul rendu X11 a la fois sur SYABAN02, les autres
// attendent leur tour au lieu de se percuter.
let gribRenderChain: Promise<unknown> = Promise.resolve();
function withGribLock<T>(fn: () => Promise<T>): Promise<T> {
  const result = gribRenderChain.then(fn, fn);
  gribRenderChain = result.then(() => undefined, () => undefined);
  return result;
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
const GFS_PARAMS: Record<string, { param: string; combinaison: string; niveau: string; duree?: string; label: string }> = {
  PMER:     { param: "PMER", combinaison: "P", niveau: "SOL", label: "Pression réduite mer (hPa)" },
  // Niveaux 2m/10m = coordonnee verticale "H" (Hauteur), pas "P" (Pression).
  // "T2M"/"FF10" ne sont pas des codes Combinaison Synergie valides — ce sont
  // "T" et "FF" (confirme dans grib_modele.sh: H_superposition traite T|R|VV et FLUX|FF).
  T2M:      { param: "T",    combinaison: "H", niveau: "2M",  label: "Température 2m (°C)" },
  FF10:     { param: "FF",   combinaison: "H", niveau: "10M", label: "Vent 10m (m/s)" },
  // Humidite relative = code "R" (param.cfg: "R;R;...;Humidite relative = HU"),
  // niveau pression = coordonnee "P" (comme PMER), pas "HR". Niveaux de pression
  // portent le suffixe HPA (confirme grib_modele.sh: case "...-850HPA-...").
  HU850:    { param: "R",    combinaison: "P", niveau: "850HPA", label: "Humidité relative 850 hPa (%)" },
  HU700:    { param: "R",    combinaison: "P", niveau: "700HPA", label: "Humidité relative 700 hPa (%)" },
  // Precipitations = code "PLUIE" (param.cfg: "Somme des precipitations liquides"),
  // pas "RR3H"/"RR". La duree de cumul (3H/6H) est un argument separe du script.
  RR3H:     { param: "PLUIE", combinaison: "P", niveau: "SOL", duree: "3H", label: "Précipitations 3h (mm)" },
  RR6H:     { param: "PLUIE", combinaison: "P", niveau: "SOL", duree: "6H", label: "Précipitations 6h (mm)" },
  // CAPE = code "CAPE_I" (param.cfg: "Energie potentielle instantanee convective"),
  // pas "CAPE"/"CP" qui ne sont pas des codenames Synergie valides.
  CAPE:     { param: "CAPE_I", combinaison: "P", niveau: "SOL", label: "CAPE (J/kg)" },
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
async function renderGribToLocalFile(
  key: string, reseau: string, echeance: string, dateArg: string | undefined, log: RenderLogger
): Promise<{ localPath: string; cfg: (typeof GFS_PARAMS)[string]; fromCache: boolean; size: number }> {
  const cfg = GFS_PARAMS[key];
  if (!cfg) {
    throw new Error(`Paramètre inconnu: ${key}. Valides: ${Object.keys(GFS_PARAMS).join(", ")}`);
  }

  // Date réseau Synergie (YYYYMMDDHHMMSS)
  const now = new Date();
  const rHH = reseau.replace("H", "").padStart(2, "0");
  const defDate = `${now.getUTCFullYear()}${String(now.getUTCMonth()+1).padStart(2,"0")}${String(now.getUTCDate()).padStart(2,"0")}${rHH}0000`;
  const synDate = dateArg ?? defDate;
  const duree = cfg.duree ?? echeance;

  const cached = gribCacheKey(key, synDate, echeance, duree);
  if (gribCacheValid(cached)) {
    return { localPath: cached, cfg, fromCache: true, size: fs.statSync(cached).size };
  }

  return withGribLock(async () => {
    // Un autre appel a peut-etre deja rempli le cache pendant qu'on attendait le verrou
    if (gribCacheValid(cached)) {
      return { localPath: cached, cfg, fromCache: true, size: fs.statSync(cached).size };
    }

    const ts = Date.now();
  const remotePng = `/tmp/synergie_grib_${key}_${ts}.png`;

  // Script bash multi-lignes — XAUTHORITY auto-discovery pour SSH sans cookie X11
  const script = [
    `export HOME=/home/synergie`,
    `export LOGNAME=synergie`,
    `for prof in /home/synergie/client4.7.0/etc/profile /home/synergie/client/etc/profile /home/synergie/.bash_profile /home/synergie/.profile; do [ -f "$prof" ] && . "$prof" 2>/dev/null && break; done`,
    `export PATH=$PATH:/home/synergie/client4.7.0/bin.i686:/home/synergie/client4.7.0/bin:/home/synergie/client/bin`,
    // Trouver le fichier -auth d'Xorg depuis /proc
    `XORG_PID=$(ps aux 2>/dev/null | grep -v grep | grep -E '[X]org|[X]11' | awk '{print $2}' | head -1)`,
    `XORG_AUTH=""`,
    `if [ -n "$XORG_PID" ] && [ -f /proc/$XORG_PID/cmdline ]; then`,
    `  XORG_AUTH=$(tr '\\0' '\\n' < /proc/$XORG_PID/cmdline | grep -A1 '^-auth$' | grep -v '^-auth$' | head -1)`,
    `fi`,
    `[ -n "$XORG_AUTH" ] && export XAUTHORITY=$XORG_AUTH`,
    `[ -z "$XORG_AUTH" ] && [ -f /home/synergie/.Xauthority ] && export XAUTHORITY=/home/synergie/.Xauthority`,
    // Extraire le numéro de display réel depuis xauth list
    `REAL_DISPLAY=$(XAUTHORITY=$XAUTHORITY /usr/bin/xauth list 2>/dev/null | awk '{print $1}' | grep -oE ':[0-9]+' | head -1)`,
    `[ -z "$REAL_DISPLAY" ] && REAL_DISPLAY=:5`,
    `DISPNUM=$(echo "$REAL_DISPLAY" | tr -d ':')`,
    // Le cookie est stocké sous "HOSTNAME/unix:N" mais DISPLAY=:N cherche ":N" → pas de match
    // Fix : ajouter une entrée sans hostname avec le même cookie (":N MIT-MAGIC-COOKIE-1 <hash>")
    `COOKIE=$(XAUTHORITY=$XAUTHORITY /usr/bin/xauth list 2>/dev/null | grep "unix:$DISPNUM" | awk '{print $3}' | head -1)`,
    `[ -z "$COOKIE" ] && COOKIE=$(XAUTHORITY=$XAUTHORITY /usr/bin/xauth list 2>/dev/null | grep ":$DISPNUM" | awk '{print $3}' | head -1)`,
    `if [ -n "$COOKIE" ]; then`,
    `  /usr/bin/xauth -f $XAUTHORITY add :$DISPNUM MIT-MAGIC-COOKIE-1 $COOKIE 2>/dev/null`,
    `  echo "XAUTH_ADDED=:$DISPNUM cookie=$COOKIE"`,
    `fi`,
    `export DISPLAY=:$DISPNUM`,
    `echo "DISPLAY=$DISPLAY XAUTHORITY=$XAUTHORITY"`,
    `MY_PID=$$`,
    // Nettoyage : tuer tout visu_modele/grib_modele.sh laissé par un rendu precedent.
    // Sans ca, la capture ci-dessous peut recuperer une fenetre perimee (rendu passe
    // jamais ferme) au lieu du rendu qu'on vient de demander — c'est la cause du bug
    // "donnees anciennes" : le process precedent ne se termine jamais tout seul.
    // On exclut explicitement notre propre PID ($MY_PID) : pkill -f matcherait aussi
    // CE script lui-meme (son texte contient litteralement "grib_modele.sh"/"visu_modele"
    // dans les commandes which/grep ci-dessous), ce qui le tuerait en plein milieu.
    `ps aux 2>/dev/null | grep -iE 'grib_modele\\.sh|visu_modele' | grep -v grep | awk -v me="$MY_PID" '$2 != me {print $2}' | xargs -r kill -9 2>/dev/null`,
    `sleep 1`,
    // Lancer grib_modele.sh (ouvre visu_modele sur :0)
    `GRIB_SCRIPT=$(which grib_modele.sh 2>/dev/null || find /home/synergie -name 'grib_modele.sh' 2>/dev/null | head -1)`,
    `[ -z "$GRIB_SCRIPT" ] && echo "__ERROR__ grib_modele.sh introuvable" && exit 1`,
    `echo "SCRIPT=$GRIB_SCRIPT"`,
    // grib_modele.sh lit positionnellement : Modele Domaine_grib Combinaison
    // CoordonneeVerticale Niveau Reseau(=DATE complete) Echeance Duree Domaine.
    // Echeance (pos.7, $ECH) est passe a extr_grib_modele.sh pour choisir la
    // bonne heure de prevision — l'inverser avec Duree affiche la mauvaise echeance.
    `"$GRIB_SCRIPT" US2 GFSAFR025 ${cfg.param} ${cfg.combinaison} ${cfg.niveau} ${synDate} ${echeance} ${duree} West_Africa 2>&1 &`,
    // Certains parametres (ex: T2M, FF10) passent par eclate_grib_modele pour
    // decompresser le grib avant que visu_modele n'ouvre sa fenetre — ca peut
    // prendre bien plus que quelques secondes. On sonde directement la vraie
    // fenetre (pas juste la presence du process) jusqu'a 60s, plutot qu'un
    // delai fixe trop court qui retombe sur une capture root inutilisable.
    `WAITED=0`,
    `WIN_ID=""`,
    `while [ $WAITED -lt 60 ]; do`,
    `  WIN_ID=$(/usr/bin/xwininfo -root -tree 2>/dev/null | grep -i 'visu_modele' | grep -v '1x1+0+0' | awk '{print $1}' | head -1)`,
    `  [ -n "$WIN_ID" ] && echo "window_found waited=$WAITED id=$WIN_ID" && break`,
    `  sleep 1`,
    `  WAITED=$(expr $WAITED + 1)`,
    `done`,
    `sleep 2`,
    // Re-verifie apres le settle (la fenetre a pu changer/se redessiner)
    `WIN_ID=$(/usr/bin/xwininfo -root -tree 2>/dev/null | grep -i 'visu_modele' | grep -v '1x1+0+0' | awk '{print $1}' | head -1)`,
    `if [ -n "$WIN_ID" ]; then`,
    `  echo "WINDOW=$WIN_ID"`,
    `  /usr/bin/import -window "$WIN_ID" "${remotePng}" 2>&1`,
    `else`,
    `  echo "WINDOW=root"`,
    `  /usr/bin/import -window root "${remotePng}" 2>&1`,
    `fi`,
    `echo "__RENDER_OK__"`,
    // Nettoyage post-capture : ne pas laisser trainer ce rendu pour l'appel suivant
    `ps aux 2>/dev/null | grep -iE 'grib_modele\\.sh|visu_modele' | grep -v grep | awk -v me="$MY_PID" '$2 != me {print $2}' | xargs -r kill -9 2>/dev/null`,
  ].join("\n");

    log.info({ key, synDate, reseau, echeance }, "render-grib: démarrage");
    const { stdout, stderr } = await runSSHCommand(script.trim().replace(/\n/g, "\n"));

    if (stdout.includes("__ERROR__")) {
      throw new Error(`Environnement Synergie: ${stdout}${stderr}`);
    }
    if (!stdout.includes("__RENDER_OK__")) {
      throw new Error(`Rendu échoué: ${stdout}${stderr}`);
    }

    // Vérifier taille PNG
    const { stdout: sz } = await runSSHCommand(`stat -c %s "${remotePng}" 2>/dev/null || echo 0`);
    const size = parseInt(sz.trim()) || 0;
    if (size < 2000) {
      throw new Error(`PNG trop petit ou absent (${size} octets)`);
    }

    const localPath = await downloadRemoteFile(remotePng);
    runSSHCommand(`rm -f "${remotePng}"`).catch(() => {});

    if (size >= MIN_VALID_GRIB_SIZE) {
      fs.copyFile(localPath, cached, () => {});
    } else {
      log.warn({ key, reseau, echeance, size }, "render-grib: carte probablement vide (pas de données) — pas mise en cache long terme");
    }

    return { localPath, cfg, fromCache: false, size };
  });
}

// ─── Helper commun render-grib (GET + POST) ──────────────────────────────────
async function handleRenderGrib(
  key: string, reseau: string, echeance: string, dateArg: string | undefined,
  log: RenderLogger,
  res: import("express").Response
) {
  try {
    const { localPath, cfg, fromCache } = await renderGribToLocalFile(key, reseau, echeance, dateArg, log);
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "public, max-age=300");
    res.setHeader("X-Grib-Key", key);
    res.setHeader("X-Grib-Label", cfg.label);
    res.setHeader("X-Cache", fromCache ? "HIT" : "MISS");
    const stream = fs.createReadStream(localPath);
    stream.pipe(res);
    if (!fromCache) stream.on("end", () => fs.unlink(localPath, () => {}));
    stream.on("error", (e) => { if (!res.headersSent) res.status(500).json({ error: String(e) }); });
  } catch (err) {
    log.warn({ err }, "render-grib: error");
    if (!res.headersSent) res.status(503).json({ error: String(err) });
  }
}

// GET /api/synergie/render-grib?key=PMER&reseau=00H&echeance=06H  (testable depuis le navigateur)
router.get("/synergie/render-grib", async (req, res) => {
  const key     = String(req.query["key"]      ?? "PMER");
  const reseau  = String(req.query["reseau"]   ?? "00H");
  const echeance = String(req.query["echeance"] ?? "06H");
  const dateArg = req.query["date"] ? String(req.query["date"]) : undefined;
  await handleRenderGrib(key, reseau, echeance, dateArg, req.log, res);
});

// ─── Warmer d'arrière-plan ────────────────────────────────────────────────────
// Pré-génère les cartes Synergie a intervalle regulier plutot que d'attendre
// qu'un utilisateur ouvre le briefing. Ca augmente les chances de tomber dans
// la fenetre ou les donnees GFS sont reellement extraites sur SYABAN02, et
// alimente le cache long terme (7h) consulte par la route HTTP ci-dessus.
const WARM_ECHEANCE = "00H";
let warmTimer: ReturnType<typeof setInterval> | null = null;

async function warmSynergieCache(log: RenderLogger): Promise<void> {
  const reseau = computeSynergieReseau();
  for (const key of Object.keys(GFS_PARAMS)) {
    try {
      const { fromCache, size } = await renderGribToLocalFile(key, reseau, WARM_ECHEANCE, undefined, log);
      log.info({ key, reseau, fromCache, size }, "synergie warm: ok");
    } catch (err) {
      log.warn({ key, reseau, err }, "synergie warm: échoué");
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
  const { key = "PMER", reseau = "00H", echeance = "06H", date: dateArg } = req.body as Record<string, string>;
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
