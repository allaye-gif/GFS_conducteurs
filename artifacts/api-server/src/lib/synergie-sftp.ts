import { Client, type SFTPWrapper, type ConnectConfig } from "ssh2";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const HOST    = () => process.env.SYABAN02_HOST    ?? "192.168.0.37";
const USER    = () => process.env.SYABAN02_USER    ?? "synergie";
const PASS    = () => process.env.SYABAN02_PASS    ?? "synergie";
const ARCHIVE  = () => process.env.SYABAN02_ARCHIVE  ?? "/home/synergie/ARCHIVE";
const ARCHIVE2 = () => process.env.SYABAN02_ARCHIVE2 ?? "/home/syndocs/images/Maps";

export type SynergieFile = {
  name: string; relPath: string; subdir: string;
  size: number; mtime: number; url: string;
};

const IMG_EXT  = /\.(png|jpg|jpeg|gif)$/i;
const MIN_SIZE = 10_000;

// ─── Cache disque ─────────────────────────────────────────────────────────────
const CACHE_DIR = path.join(os.tmpdir(), "synergie-img-cache");
const CACHE_TTL = 30 * 60 * 1000;

try { fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch { /* ignore */ }

function cacheKey(r: string) { return r.replace(/[/\\]/g, "__").replace(/[^a-zA-Z0-9._-]/g, "_"); }
export function localCachePath(r: string) { return path.join(CACHE_DIR, cacheKey(r)); }
function isCacheValid(f: string): boolean {
  try { return (Date.now() - fs.statSync(f).mtimeMs) < CACHE_TTL; } catch { return false; }
}

// ─── Options SSH — algos legacy pour serveurs OpenSSH anciens (CentOS 6) ──────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const SSH_ALGOS: ConnectConfig["algorithms"] = {
  serverHostKey: ["ssh-rsa", "ssh-dss"] as any,
  kex: [
    "diffie-hellman-group14-sha256", "diffie-hellman-group14-sha1",
    "diffie-hellman-group1-sha1", "ecdh-sha2-nistp256",
    "ecdh-sha2-nistp384", "ecdh-sha2-nistp521",
    "diffie-hellman-group-exchange-sha256", "diffie-hellman-group-exchange-sha1",
  ] as any,
  cipher: [
    "aes128-ctr", "aes192-ctr", "aes256-ctr",
    "aes128-cbc", "aes192-cbc", "aes256-cbc", "3des-cbc",
  ] as any,
  hmac: ["hmac-sha2-256", "hmac-sha2-512", "hmac-sha1", "hmac-md5"] as any,
  compress: ["none"] as any,
};

function sshOptions(): ConnectConfig {
  return {
    host: HOST(), port: 22, username: USER(), password: PASS(),
    readyTimeout: 30_000, keepaliveInterval: 15_000, keepaliveCountMax: 5,
    algorithms: SSH_ALGOS,
  };
}

// ─── Connexion SFTP partagée (singleton) ──────────────────────────────────────
type SharedConn = { client: Client; sftp: SFTPWrapper };
let _shared: SharedConn | null = null;
let _connecting: Promise<SharedConn> | null = null;

function createSharedConn(): Promise<SharedConn> {
  if (_connecting) return _connecting;
  _connecting = new Promise<SharedConn>((resolve, reject) => {
    const client = new Client();
    client.on("ready", () => {
      client.sftp((err, sftp) => {
        _connecting = null;
        if (err) { client.end(); _shared = null; reject(err); return; }
        const conn: SharedConn = { client, sftp };
        _shared = conn;
        resolve(conn);
      });
    });
    client.on("error", (err) => { _connecting = null; _shared = null; reject(err); });
    client.on("close", () => { _shared = null; _connecting = null; });
    client.on("end",   () => { _shared = null; _connecting = null; });
    client.connect(sshOptions());
  });
  return _connecting;
}

export function getSharedConn(): Promise<SharedConn> {
  if (_shared) return Promise.resolve(_shared);
  return createSharedConn();
}

/** Connexion SFTP dédiée (pour syncs longs — ne bloque pas la connexion partagée) */
export function openSFTP(): Promise<{ conn: Client; sftp: SFTPWrapper; archivePath: string }> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    client.on("ready", () => {
      client.sftp((err, sftp) => {
        if (err) { client.end(); reject(err); return; }
        resolve({ conn: client, sftp, archivePath: ARCHIVE() });
      });
    });
    client.on("error", reject);
    client.connect(sshOptions());
  });
}

/** Exécute une commande SSH via la connexion partagée */
export function runSSHCommand(cmd: string): Promise<{ stdout: string; stderr: string }> {
  return getSharedConn().then(({ client }) =>
    new Promise((resolve, reject) => {
      client.exec(cmd, (err, stream) => {
        if (err) { reject(err); return; }
        let stdout = "", stderr = "";
        stream.on("data", (d: Buffer) => { stdout += d.toString(); });
        stream.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
        stream.on("close", () => resolve({ stdout, stderr }));
        stream.on("error", reject);
      });
    })
  );
}

/** Lit un fichier texte via SFTP partagé (max 100 KB) */
export function readRemoteFile(filePath: string, maxBytes = 100_000): Promise<{ content: string; truncated: boolean }> {
  return getSharedConn().then(({ sftp }) =>
    new Promise((resolve, reject) => {
      sftp.stat(filePath, (statErr) => {
        if (statErr) { reject(new Error(`Fichier non trouvé: ${statErr.message}`)); return; }
        const chunks: Buffer[] = [];
        let bytesRead = 0;
        const stream = sftp.createReadStream(filePath);
        stream.on("data", (chunk: Buffer) => {
          if (bytesRead < maxBytes) {
            const rem = maxBytes - bytesRead;
            chunks.push(chunk.length <= rem ? chunk : chunk.slice(0, rem));
          }
          bytesRead += chunk.length;
          if (bytesRead >= maxBytes) stream.destroy();
        });
        stream.on("close", () => resolve({ content: Buffer.concat(chunks).toString("utf8"), truncated: bytesRead >= maxBytes }));
        stream.on("error", reject);
      });
    })
  );
}

// ─── In-flight tracker ────────────────────────────────────────────────────────
const inFlight = new Map<string, Promise<string>>();

export function getCachedFile(relPath: string): Promise<string> {
  const cached = localCachePath(relPath);
  if (isCacheValid(cached)) return Promise.resolve(cached);
  if (inFlight.has(relPath)) return inFlight.get(relPath)!;

  const download = getSharedConn().then(({ sftp }) => {
    // resolveArchivePath gère le préfixe a1/ ou a2/ (double archive)
    const remotePath = resolveArchivePath(relPath);
    return new Promise<string>((resolve, reject) => {
      sftp.fastGet(remotePath, cached, (err) => {
        inFlight.delete(relPath);
        if (err) reject(err);
        else resolve(cached);
      });
    });
  }).catch((err) => {
    inFlight.delete(relPath);
    _shared = null;
    throw err;
  });

  inFlight.set(relPath, download);
  return download;
}

// ─── Sync en lot (connexion dédiée pour ne pas bloquer la partagée) ───────────
let syncRunning = false;

export async function syncArchiveToCache(files: SynergieFile[]): Promise<void> {
  if (syncRunning) return;
  const toSync = files.filter(f => !isCacheValid(localCachePath(f.relPath)));
  if (toSync.length === 0) return;
  syncRunning = true;
  let dedicated: { conn: Client; sftp: SFTPWrapper; archivePath: string } | null = null;
  try {
    dedicated = await openSFTP();
    for (const f of toSync) {
      const cached = localCachePath(f.relPath);
      if (isCacheValid(cached)) continue;
      try {
        await new Promise<void>((resolve, reject) =>
          dedicated!.sftp.fastGet(`${dedicated!.archivePath}/${f.relPath}`, cached, (err) => err ? reject(err) : resolve())
        );
        inFlight.delete(f.relPath);
      } catch { /* skip failed */ }
    }
  } finally {
    dedicated?.conn.end();
    syncRunning = false;
  }
}

// ─── Listing récursif ─────────────────────────────────────────────────────────
type RawEntry = { filename: string; attrs: { size?: number; mtime?: number; mode?: number } };

function isDir(m?: number) { return !!(m && (m & 0o040000)); }

function readdirSftp(sftp: SFTPWrapper, dir: string): Promise<RawEntry[]> {
  return new Promise((res, rej) => sftp.readdir(dir, (err, list) => err ? rej(err) : res(list as RawEntry[])));
}

export async function listSynergieArchive(maxDepth = 2): Promise<SynergieFile[]> {
  const { sftp } = await getSharedConn();
  const files: SynergieFile[] = [];

  // Scanne un dossier racine ; prefix = "a1" | "a2" pour distinguer les deux archives
  async function scanDir(basePath: string, prefix: string, dir: string, relDir: string, depth: number) {
    let entries: RawEntry[];
    try { entries = await readdirSftp(sftp, dir); } catch { return; }
    for (const e of entries) {
      if (e.filename.startsWith(".")) continue;
      if (isDir(e.attrs.mode)) {
        if (depth < maxDepth) {
          const sub = relDir ? `${relDir}/${e.filename}` : e.filename;
          await scanDir(basePath, prefix, `${dir}/${e.filename}`, sub, depth + 1);
        }
      } else if (IMG_EXT.test(e.filename)) {
        const size = e.attrs.size ?? 0;
        if (size < MIN_SIZE) continue;
        const relPath = relDir ? `${relDir}/${e.filename}` : e.filename;
        // Encodage du prefixe dans l'URL pour que /archive/file sache quelle base utiliser
        const urlPath = `${prefix}/${relPath}`;
        files.push({ name: e.filename, relPath: urlPath, subdir: `[${prefix}] ${relDir}`, size, mtime: e.attrs.mtime ?? 0,
          url: `/api/synergie/archive/file?path=${encodeURIComponent(urlPath)}` });
      }
    }
  }

  await Promise.all([
    scanDir(ARCHIVE(),  "a1", ARCHIVE(),  "", 0),
    scanDir(ARCHIVE2(), "a2", ARCHIVE2(), "", 0),
  ]);
  files.sort((a, b) => b.mtime - a.mtime);  // plus récent en premier
  return files;
}

/** Résout le chemin réel sur SYABAN02 à partir du chemin encodé (a1/... ou a2/...) */
export function resolveArchivePath(encodedPath: string): string {
  if (encodedPath.startsWith("a2/")) return `${ARCHIVE2()}/${encodedPath.slice(3)}`;
  if (encodedPath.startsWith("a1/")) return `${ARCHIVE()}/${encodedPath.slice(3)}`;
  return `${ARCHIVE()}/${encodedPath}`; // compatibilité ascendante
}
