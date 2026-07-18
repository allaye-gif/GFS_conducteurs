import { useState, useCallback, useEffect, useRef } from "react";
import { useLocation } from "wouter";
import { useGetBriefingCatalog, useCreateBriefing } from "@workspace/api-client-react";
import { BriefingChartViewer } from "@/components/briefing-chart-viewer";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { format } from "date-fns";
import { fr } from "date-fns/locale";
import { Save, Loader2, RefreshCw, CloudCheck, RotateCcw, Wifi } from "lucide-react";

function todayStr() {
  return format(new Date(), "yyyy-MM-dd");
}

const TEMPLATE_KEY = "briefing-template-v1";

type DraftData = { sectionNotes?: Record<string, string>; notes?: string };

function parseDraft(key: string): DraftData {
  try {
    const raw = localStorage.getItem(key);
    if (raw) return JSON.parse(raw) as DraftData;
  } catch {}
  return {};
}

function filterTemplateKeys(sn: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(sn)) {
    if (k.startsWith("__img__") || k.startsWith("__ann__")) continue;
    if (/^__custom_\d+_img_\d+__$/.test(k)) continue;
    result[k] = v;
  }
  return result;
}

function loadInitialSectionNotes(draftKey: string): Record<string, string> {
  const draft = parseDraft(draftKey);
  if (draft.sectionNotes && Object.keys(draft.sectionNotes).length > 0) return draft.sectionNotes;
  const tpl = parseDraft(TEMPLATE_KEY);
  return tpl.sectionNotes ?? {};
}

function loadInitialNotes(draftKey: string): string {
  const draft = parseDraft(draftKey);
  if (draft.notes !== undefined && draft.notes !== "") return draft.notes;
  const tpl = parseDraft(TEMPLATE_KEY);
  return tpl.notes ?? "";
}

// ── DB helpers ────────────────────────────────────────────────────────────────

async function dbGet(key: string): Promise<DraftData | null> {
  try {
    const r = await fetch(`/api/draft/${encodeURIComponent(key)}`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const { data } = await r.json() as { data: DraftData | null };
    return data ?? null;
  } catch { return null; }
}

async function dbPut(key: string, data: DraftData): Promise<void> {
  try {
    await fetch(`/api/draft/${encodeURIComponent(key)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
      signal: AbortSignal.timeout(8000),
    });
  } catch { /* silent */ }
}

async function dbDel(key: string): Promise<void> {
  try {
    await fetch(`/api/draft/${encodeURIComponent(key)}`, { method: "DELETE", signal: AbortSignal.timeout(5000) });
  } catch { /* silent */ }
}

// ─────────────────────────────────────────────────────────────────────────────

export default function NewBriefing() {
  const [, navigate] = useLocation();
  const { toast } = useToast();

  const today = todayStr();
  const DRAFT_KEY = `briefing-draft-new-${today}`;
  const DB_DRAFT_KEY = `briefing-${today}`;
  const DB_TPL_KEY = `briefing-template`;

  const [date] = useState(today);
  const [title] = useState(
    `Briefing Quotidien du ${format(new Date(), "d MMMM yyyy", { locale: fr })}`
  );

  const [sectionNotes, setSectionNotes] = useState<Record<string, string>>(
    () => loadInitialSectionNotes(DRAFT_KEY)
  );
  const [notes, setNotes] = useState<string>(
    () => loadInitialNotes(DRAFT_KEY)
  );

  // Banner states
  const [draftRestored] = useState<boolean>(() => {
    try { return !!localStorage.getItem(DRAFT_KEY); } catch { return false; }
  });
  const [templateLoaded] = useState<boolean>(() => {
    try {
      if (localStorage.getItem(DRAFT_KEY)) return false;
      const tpl = parseDraft(TEMPLATE_KEY);
      return !!(tpl.sectionNotes && Object.keys(tpl.sectionNotes).length > 0);
    } catch { return false; }
  });
  const [dbRestored, setDbRestored] = useState(false);
  const [dbTemplateLoaded, setDbTemplateLoaded] = useState(false);

  const [draftSavedAt, setDraftSavedAt] = useState<Date | null>(null);
  const [draftSaveFailed, setDraftSaveFailed] = useState(false);

  // dbReady = true when it's safe to start saving to DB
  // (prevents overwriting DB data before we've had a chance to read it)
  const [dbReady, setDbReady] = useState(false);
  const dbReadyRef = useRef(false);

  const { data: catalog, isLoading: catalogLoading, refetch, isFetching } = useGetBriefingCatalog();

  const { mutate: createBriefing, isPending: saving } = useCreateBriefing({
    mutation: {
      onSuccess: (created) => {
        // Clear local draft
        try { localStorage.removeItem(DRAFT_KEY); } catch {}
        // Save template locally
        try {
          const tpl = filterTemplateKeys(sectionNotes);
          localStorage.setItem(TEMPLATE_KEY, JSON.stringify({ sectionNotes: tpl, notes }));
        } catch {}
        // Sync to DB: delete draft, save template
        void dbDel(DB_DRAFT_KEY);
        void dbPut(DB_TPL_KEY, { sectionNotes: filterTemplateKeys(sectionNotes), notes });
        toast({ title: "Briefing archivé", description: `"${created.title}" sauvegardé.` });
        navigate(`/briefings/${created.id}`);
      },
      onError: () => {
        toast({
          title: "Erreur d'archivage",
          description: "Impossible d'archiver. Votre brouillon reste sauvegardé — réessayez.",
          variant: "destructive",
        });
      },
    },
  });

  // ── On mount : load from DB if no local data ────────────────────────────────
  useEffect(() => {
    const hasLocalDraft = !!localStorage.getItem(DRAFT_KEY);
    const hasLocalTemplate = !!localStorage.getItem(TEMPLATE_KEY);

    if (hasLocalDraft || hasLocalTemplate) {
      // Local data takes priority — DB sync can start immediately
      dbReadyRef.current = true;
      setDbReady(true);
      return;
    }

    // No local data — fetch from DB before enabling DB save
    (async () => {
      const draft = await dbGet(DB_DRAFT_KEY);
      if (draft?.sectionNotes && Object.keys(draft.sectionNotes).length > 0) {
        setSectionNotes(draft.sectionNotes);
        if (draft.notes) setNotes(draft.notes);
        setDbRestored(true);
        dbReadyRef.current = true;
        setDbReady(true);
        return;
      }
      const tpl = await dbGet(DB_TPL_KEY);
      if (tpl?.sectionNotes && Object.keys(tpl.sectionNotes).length > 0) {
        setSectionNotes(tpl.sectionNotes);
        if (tpl.notes) setNotes(tpl.notes);
        setDbTemplateLoaded(true);
      }
      dbReadyRef.current = true;
      setDbReady(true);
    })();
  }, []);

  // ── Auto-save to localStorage (debounced 800ms) ─────────────────────────────
  useEffect(() => {
    const t = setTimeout(() => {
      try {
        const draftSN = filterTemplateKeys(sectionNotes);
        localStorage.setItem(DRAFT_KEY, JSON.stringify({ sectionNotes: draftSN, notes }));
        setDraftSavedAt(new Date());
        setDraftSaveFailed(false);
      } catch {
        setDraftSaveFailed(true);
      }
    }, 800);
    return () => clearTimeout(t);
  }, [sectionNotes, notes, DRAFT_KEY]);

  // ── Auto-save to DB (debounced 3s, text only, after DB is ready) ────────────
  useEffect(() => {
    if (!dbReady) return;
    const t = setTimeout(() => {
      const data = filterTemplateKeys(sectionNotes);
      void dbPut(DB_DRAFT_KEY, { sectionNotes: data, notes });
    }, 3000);
    return () => clearTimeout(t);
  }, [sectionNotes, notes, dbReady, DB_DRAFT_KEY]);

  const handleNoteChange = useCallback((key: string, val: string) => {
    setSectionNotes((prev) => ({ ...prev, [key]: val }));
  }, []);

  function handleSave() {
    if (!catalog) return;
    createBriefing({
      data: {
        date,
        title,
        notes: notes || undefined,
        sections: catalog.sections,
        sectionNotes,
      },
    });
  }

  function handleResetDraft() {
    if (!confirm("Effacer le brouillon et recommencer à zéro ?")) return;
    try { localStorage.removeItem(DRAFT_KEY); } catch {}
    void dbDel(DB_DRAFT_KEY);
    setSectionNotes({});
    setNotes("");
  }

  function handleClearTemplate() {
    if (!confirm("Effacer le modèle du dernier briefing ? Le formulaire sera vide au prochain briefing.")) return;
    try { localStorage.removeItem(TEMPLATE_KEY); } catch {}
    void dbDel(DB_TPL_KEY);
    setSectionNotes({});
    setNotes("");
  }

  const runLabel = catalog?.gfsCycle
    ? `Run GFS ${catalog.gfsCycle}Z · ${format(new Date(), "d MMMM yyyy", { locale: fr })}`
    : null;

  const ecmwfLabel = catalog?.ecmwfBaseTime
    ? `ECMWF base ${catalog.ecmwfBaseTime.slice(11, 16)} UTC`
    : "ECMWF indisponible";

  return (
    <div className="space-y-10">

      {/* ── En-tête ──────────────────────────────────────── */}
      <div className="pt-4 pb-6 border-b border-border">
        <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground mb-4">
          Nouveau Briefing
        </p>
        <h1 className="text-4xl font-bold text-foreground leading-tight">{title}</h1>
        <div className="flex items-center gap-4 mt-3 flex-wrap">
          {runLabel && (
            <span className="text-xs text-muted-foreground bg-muted px-3 py-1 rounded-full">{runLabel}</span>
          )}
          <span className="text-xs text-muted-foreground bg-muted px-3 py-1 rounded-full">{ecmwfLabel}</span>
          <button
            onClick={() => void refetch()}
            disabled={isFetching}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${isFetching ? "animate-spin" : ""}`} />
            {isFetching ? "Chargement…" : "Actualiser les cartes"}
          </button>
        </div>
      </div>

      {/* ── Bannière brouillon localStorage récupéré ──────── */}
      {draftRestored && !dbRestored && (
        <div className="flex items-start justify-between gap-4 rounded-xl border border-amber-200 bg-amber-50 dark:border-amber-900/60 dark:bg-amber-950/30 px-4 py-3">
          <div className="flex items-center gap-2 text-sm text-amber-800 dark:text-amber-300">
            <RotateCcw className="h-4 w-4 shrink-0" />
            <span>
              <strong>Brouillon récupéré</strong> — vos modifications non archivées ont été restaurées automatiquement.
            </span>
          </div>
          <button
            onClick={handleResetDraft}
            className="text-xs text-amber-600 dark:text-amber-400 hover:underline shrink-0 mt-0.5"
          >
            Effacer
          </button>
        </div>
      )}

      {/* ── Bannière brouillon DB récupéré ───────────────── */}
      {dbRestored && (
        <div className="flex items-start justify-between gap-4 rounded-xl border border-emerald-200 bg-emerald-50 dark:border-emerald-900/60 dark:bg-emerald-950/30 px-4 py-3">
          <div className="flex items-center gap-2 text-sm text-emerald-800 dark:text-emerald-300">
            <Wifi className="h-4 w-4 shrink-0" />
            <span>
              <strong>Brouillon synchronisé</strong> — notes du serveur restaurées (disponibles sur tous les postes).
            </span>
          </div>
          <button
            onClick={handleResetDraft}
            className="text-xs text-emerald-600 dark:text-emerald-400 hover:underline shrink-0 mt-0.5"
          >
            Effacer
          </button>
        </div>
      )}

      {/* ── Bannière modèle précédent chargé ─────────────── */}
      {!draftRestored && !dbRestored && (templateLoaded || dbTemplateLoaded) && (
        <div className="flex items-start justify-between gap-4 rounded-xl border border-sky-200 bg-sky-50 dark:border-sky-900/60 dark:bg-sky-950/30 px-4 py-3">
          <div className="flex items-center gap-2 text-sm text-sky-800 dark:text-sky-300">
            <RotateCcw className="h-4 w-4 shrink-0" />
            <span>
              <strong>Modèle chargé</strong> — notes et sections du dernier briefing pré-remplies. Les images sont à charger.
            </span>
          </div>
          <button
            onClick={handleClearTemplate}
            className="text-xs text-sky-600 dark:text-sky-400 hover:underline shrink-0 mt-0.5"
          >
            Effacer modèle
          </button>
        </div>
      )}

      {/* ── Sections du catalogue ─────────────────────────── */}
      {catalogLoading ? (
        <div className="flex flex-col items-center gap-4 py-16 text-muted-foreground/60">
          <Loader2 className="h-8 w-8 animate-spin" />
          <p className="text-sm">Chargement des cartes (GFS + ECMWF)…</p>
        </div>
      ) : catalog ? (
        <BriefingChartViewer
          sections={catalog.sections}
          sectionNotes={sectionNotes}
          onNoteChange={handleNoteChange}
        />
      ) : (
        <div className="py-10 text-center text-sm text-muted-foreground/60">
          Impossible de charger le catalogue. Vérifiez la connexion réseau.
        </div>
      )}

      {/* ── RÉSUMÉ ───────────────────────────────────────── */}
      {catalog && (
        <div className="rounded-2xl border-2 border-foreground/80 bg-card overflow-hidden shadow-sm">
          <div className="border-b-2 border-foreground/80 py-3 px-6 text-center">
            <span className="text-base font-bold tracking-widest uppercase text-foreground">Résumé</span>
          </div>
          <div className="p-6">
            <Textarea
              id="notes-resume"
              placeholder={"• L'image satellitaire de 09H30 montre…\n• Le Front Intertropical (FIT) se situe…\n• La dépression thermique saharienne…\n• Les valeurs de l'eau précipitable…\n• Les conditions sont favorables à…"}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={10}
              className="resize-none border-0 bg-transparent p-0 text-sm leading-relaxed focus-visible:ring-0 focus-visible:ring-offset-0 placeholder:text-muted-foreground/40 placeholder:italic"
            />
          </div>
        </div>
      )}

      {/* ── Bouton Archiver ──────────────────────────────── */}
      {catalog && (
        <div className="sticky bottom-0 bg-background/95 backdrop-blur border-t border-border py-4 flex items-center justify-between gap-3 -mx-8 px-8">
          <div className="flex items-center gap-2">
            {draftSaveFailed ? (
              <span className="text-[11px] text-destructive/70">⚠ Stockage local plein — sauvegarde auto indisponible</span>
            ) : draftSavedAt ? (
              <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground/60">
                <CloudCheck className="h-3.5 w-3.5 text-emerald-500" />
                Brouillon sauvegardé (local + serveur)
              </span>
            ) : null}
          </div>
          <div className="flex items-center gap-3">
            <Button variant="ghost" onClick={() => navigate("/")} disabled={saving}>
              Annuler
            </Button>
            <Button onClick={handleSave} disabled={saving} className="gap-2">
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              {saving ? "Archivage…" : "Archiver le briefing"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
