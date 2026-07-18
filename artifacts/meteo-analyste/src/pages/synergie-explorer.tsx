import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { RefreshCw, AlertCircle, Terminal, CheckCircle2, FileImage, FolderOpen, Settings, Clock, Cpu } from "lucide-react";
import { cn } from "@/lib/utils";

type DiagResult = {
  label: string;
  stdout: string;
  stderr: string;
  error?: string;
};

type DiagResponse = {
  host: string;
  results: Record<string, DiagResult>;
};

function lines(s: string) {
  return s ? s.split("\n").filter(Boolean) : [];
}

function ResultBlock({ title, icon, result, highlight }: {
  title: string;
  icon: React.ReactNode;
  result?: DiagResult;
  highlight?: (line: string) => string;
}) {
  const [expanded, setExpanded] = useState(true);
  if (!result) return null;

  const out = result.error
    ? `ERREUR: ${result.error}`
    : (result.stdout || result.stderr || "(vide)");

  const lineList = lines(out);
  const hasContent = lineList.length > 0;

  return (
    <Card className={cn("border", result.error ? "border-destructive/40" : "border-border")}>
      <CardHeader className="py-3 px-4 cursor-pointer" onClick={() => setExpanded(v => !v)}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm font-medium">
            {icon}
            {title}
            <Badge variant="secondary" className="text-[10px] h-4 px-1.5">
              {result.error ? "ERR" : `${lineList.length} ligne${lineList.length > 1 ? "s" : ""}`}
            </Badge>
          </div>
          <span className="text-xs text-muted-foreground">{expanded ? "▲" : "▼"}</span>
        </div>
      </CardHeader>
      {expanded && hasContent && (
        <CardContent className="px-0 pb-0">
          <div className="bg-zinc-950 text-zinc-100 font-mono text-xs overflow-auto max-h-72 rounded-b-lg">
            {lineList.map((line, i) => {
              const color = highlight ? highlight(line) : "";
              return (
                <div key={i} className={cn("px-4 py-0.5 hover:bg-white/5", color)}>
                  {line}
                </div>
              );
            })}
          </div>
        </CardContent>
      )}
    </Card>
  );
}

function DiagReport({ data }: { data: DiagResponse }) {
  const r = data.results;

  // Analyse des résultats pour tirer des conclusions
  const gifFiles  = lines(r["gif_files"]?.stdout ?? "");
  const gribFiles = lines(r["grib_files"]?.stdout ?? "");
  const scripts   = lines(r["scripts"]?.stdout ?? "");
  const configs   = lines(r["configs"]?.stdout ?? "");
  const crontab   = r["crontab"]?.stdout ?? "";
  const hasCron   = crontab && !crontab.includes("no crontab") && crontab.trim().length > 0;
  const allDirs   = lines(r["all_dirs"]?.stdout ?? "");
  const recent    = lines(r["recent"]?.stdout ?? "");

  return (
    <div className="space-y-4">
      {/* Résumé exécutif */}
      <Card className="border-blue-300 dark:border-blue-700 bg-blue-50 dark:bg-blue-950/30">
        <CardContent className="pt-4 pb-4">
          <p className="font-semibold text-blue-900 dark:text-blue-200 mb-3">
            📋 Résumé — SYABAN02 ({data.host})
          </p>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              { label: "Fichiers GIF",   value: gifFiles.length,  icon: <FileImage className="h-4 w-4 text-blue-500" />,   good: gifFiles.length > 0 },
              { label: "Fichiers GRIB",  value: gribFiles.length, icon: <FolderOpen className="h-4 w-4 text-green-500" />, good: gribFiles.length > 0 },
              { label: "Scripts",        value: scripts.length,   icon: <Terminal className="h-4 w-4 text-purple-500" />,  good: scripts.length > 0 },
              { label: "Tâches cron",    value: hasCron ? "OUI" : "non", icon: <Clock className="h-4 w-4 text-orange-500" />, good: !!hasCron },
            ].map(item => (
              <div key={item.label} className="bg-white dark:bg-zinc-900 rounded-lg p-3 border border-blue-200 dark:border-blue-800">
                <div className="flex items-center gap-1.5 mb-1">
                  {item.icon}
                  <span className="text-xs text-muted-foreground">{item.label}</span>
                </div>
                <div className={cn("text-xl font-bold", item.good ? "text-foreground" : "text-muted-foreground")}>
                  {item.value}
                </div>
              </div>
            ))}
          </div>
          {/* Conclusions */}
          <div className="mt-3 space-y-1.5 text-xs">
            {gribFiles.length > 0 && (
              <div className="flex items-start gap-2 text-green-700 dark:text-green-400">
                <CheckCircle2 className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                <span><strong>Données GRIB trouvées</strong> — on peut générer les cartes directement depuis l'API sans passer par l'interface Synergie</span>
              </div>
            )}
            {scripts.length > 0 && (
              <div className="flex items-start gap-2 text-purple-700 dark:text-purple-400">
                <CheckCircle2 className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                <span><strong>{scripts.length} script(s) trouvé(s)</strong> — il existe peut-être un script d'export Synergie qu'on peut appeler</span>
              </div>
            )}
            {hasCron && (
              <div className="flex items-start gap-2 text-orange-700 dark:text-orange-400">
                <CheckCircle2 className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                <span><strong>Tâches cron actives</strong> — Synergie génère automatiquement des fichiers selon un planning</span>
              </div>
            )}
            {recent.length > 0 && (
              <div className="flex items-start gap-2 text-blue-700 dark:text-blue-400">
                <CheckCircle2 className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                <span><strong>{recent.length} fichier(s) modifié(s) ces 7 derniers jours</strong> — le serveur est actif</span>
              </div>
            )}
            {allDirs.length > 0 && (
              <div className="flex items-start gap-2 text-muted-foreground">
                <FolderOpen className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                <span>{allDirs.length} dossier(s) dans /home/synergie : {allDirs.slice(0, 5).join(", ")}{allDirs.length > 5 ? "…" : ""}</span>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Blocs détaillés */}
      <ResultBlock
        title="Fichiers modifiés récemment (7 jours)"
        icon={<Clock className="h-4 w-4 text-orange-500" />}
        result={r["recent"]}
        highlight={(line) => line.includes(".gif") ? "text-blue-300" : line.includes(".grib") || line.includes(".grb") ? "text-green-300" : ""}
      />
      <ResultBlock
        title="Tous les fichiers GIF (cartes Synergie)"
        icon={<FileImage className="h-4 w-4 text-blue-400" />}
        result={r["gif_files"]}
        highlight={() => "text-blue-300"}
      />
      <ResultBlock
        title="Fichiers GRIB / netCDF (données brutes NWP)"
        icon={<FolderOpen className="h-4 w-4 text-green-400" />}
        result={r["grib_files"]}
        highlight={() => "text-green-300"}
      />
      <ResultBlock
        title="Scripts (.sh, .py, .pl, .tcl)"
        icon={<Terminal className="h-4 w-4 text-purple-400" />}
        result={r["scripts"]}
        highlight={() => "text-purple-300"}
      />
      <ResultBlock
        title="Fichiers de configuration (.conf, .cfg, .xml…)"
        icon={<Settings className="h-4 w-4 text-yellow-400" />}
        result={r["configs"]}
        highlight={() => "text-yellow-300"}
      />
      <ResultBlock
        title="Tâches planifiées (crontab)"
        icon={<Clock className="h-4 w-4 text-orange-400" />}
        result={r["crontab"]}
        highlight={(line) => line.startsWith("#") ? "text-zinc-500" : line.trim() ? "text-orange-300 font-medium" : ""}
      />
      <ResultBlock
        title="Processus en cours"
        icon={<Cpu className="h-4 w-4 text-red-400" />}
        result={r["processes"]}
        highlight={(line) => line.toLowerCase().includes("synergie") ? "text-red-300 font-bold bg-red-950/30" : ""}
      />
      <ResultBlock
        title="Tous les dossiers"
        icon={<FolderOpen className="h-4 w-4 text-muted-foreground" />}
        result={r["all_dirs"]}
      />
    </div>
  );
}

function CmdPanel() {
  const [cmd, setCmd] = useState("");
  const [runCmd, setRunCmd] = useState("");

  const { data, isLoading, error } = useQuery({
    queryKey: ["synergie-exec", runCmd],
    queryFn: async () => {
      if (!runCmd) return null;
      const r = await fetch(`/api/synergie/exec?cmd=${encodeURIComponent(runCmd)}`);
      if (!r.ok) throw new Error(await r.text());
      return r.json() as Promise<{ cmd: string; stdout: string; stderr: string }>;
    },
    enabled: !!runCmd,
    retry: false,
    staleTime: 0,
  });

  const presets = [
    "cat /home/synergie/ARCHIVE/Hmid-Vent_850-1.gif | file -",
    "ls -lah /home/synergie/ARCHIVE",
    "find / -name 'synergie.conf' 2>/dev/null | head -20",
    "find / -name '*.gif' -newer /tmp -type f 2>/dev/null | head -30",
    "grep -r 'ARCHIVE\\|export\\|gif' /home/synergie --include='*.sh' --include='*.conf' -l 2>/dev/null",
    "cat /home/synergie/*.conf 2>/dev/null || cat /home/synergie/*.cfg 2>/dev/null",
    "ls -la /",
    "env | grep -i synergie",
  ];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1.5">
        {presets.map((p) => (
          <button key={p} onClick={() => setCmd(p)}
            className="text-[11px] px-2 py-1 rounded border border-border bg-muted/40 hover:bg-muted text-muted-foreground hover:text-foreground transition-colors text-left">
            {p.length > 50 ? p.slice(0, 50) + "…" : p}
          </button>
        ))}
      </div>
      <div className="flex gap-2">
        <Input value={cmd} onChange={(e) => setCmd(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") setRunCmd(cmd); }}
          placeholder="Commande SSH (ls, find, cat, grep…)"
          className="font-mono text-xs" />
        <Button size="sm" onClick={() => setRunCmd(cmd)} disabled={isLoading}>
          <Terminal className="h-3.5 w-3.5 mr-1" />
          {isLoading ? "…" : "Lancer"}
        </Button>
      </div>
      {error && <div className="rounded bg-destructive/10 text-destructive text-xs p-3">{String(error)}</div>}
      {data && (
        <div className="rounded-lg border bg-zinc-950 text-green-400 font-mono text-xs p-4 overflow-auto max-h-96 whitespace-pre">
          {data.stdout || data.stderr || "(pas de sortie)"}
        </div>
      )}
    </div>
  );
}

export default function SynergieExplorer() {
  const [tab, setTab] = useState<"diag" | "cmd">("diag");

  const diag = useQuery({
    queryKey: ["synergie-diagnostic"],
    queryFn: async () => {
      const r = await fetch("/api/synergie/diagnostic");
      if (!r.ok) throw new Error(await r.text());
      return r.json() as Promise<DiagResponse>;
    },
    retry: false,
    staleTime: 60_000,
  });

  return (
    <div className="max-w-5xl mx-auto py-6 px-4 space-y-5">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold">Explorateur SYABAN02</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Diagnostic complet du serveur Synergie pour trouver comment récupérer tous les champs automatiquement.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => diag.refetch()} disabled={diag.isFetching}>
          <RefreshCw className={cn("h-3.5 w-3.5 mr-1", diag.isFetching && "animate-spin")} />
          Actualiser
        </Button>
      </div>

      <div className="flex gap-1 border-b">
        {([["diag", "📋 Diagnostic automatique"], ["cmd", "💻 Terminal SSH"]] as const).map(([t, label]) => (
          <button key={t} onClick={() => setTab(t)}
            className={cn(
              "px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors",
              tab === t ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"
            )}>
            {label}
          </button>
        ))}
      </div>

      {tab === "diag" && (
        <>
          {diag.isLoading && (
            <div className="flex flex-col items-center justify-center py-16 gap-3 text-muted-foreground">
              <RefreshCw className="h-6 w-6 animate-spin" />
              <p className="text-sm">Scan de SYABAN02 en cours…</p>
              <p className="text-xs opacity-60">Connexion SSH · exploration des fichiers · lecture du crontab…</p>
            </div>
          )}
          {diag.error && (
            <div className="flex items-center gap-3 py-6 px-4 rounded-lg bg-destructive/10 text-destructive">
              <AlertCircle className="h-5 w-5 shrink-0" />
              <div>
                <p className="font-medium text-sm">Impossible de contacter SYABAN02</p>
                <p className="text-xs mt-0.5 opacity-80">{String(diag.error)}</p>
                <p className="text-xs mt-1 opacity-60">Vérifie que l'API est bien lancée sur le serveur Windows et que SYABAN02 (192.168.0.37) est accessible.</p>
              </div>
            </div>
          )}
          {diag.data && <DiagReport data={diag.data} />}
        </>
      )}

      {tab === "cmd" && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Terminal className="h-4 w-4" /> Terminal SSH — SYABAN02
            </CardTitle>
          </CardHeader>
          <CardContent><CmdPanel /></CardContent>
        </Card>
      )}
    </div>
  );
}
