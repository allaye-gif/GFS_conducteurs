import { useState, useEffect, useRef, useCallback } from "react";
import { useLocation } from "wouter";
import { useGetNoaaCharts, useCreateAnalysis } from "@workspace/api-client-react";
import { NoaaChartViewer } from "@/components/noaa-chart-viewer";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { format, getDate, getDaysInMonth } from "date-fns";
import { fr } from "date-fns/locale";
import { Save, Loader2, RefreshCw, Satellite, PenLine, Cloud } from "lucide-react";
import { cn } from "@/lib/utils";

const DRAFT_LS_KEY = "meteo-analyste-draft-v1";

function getDefaultPeriod() {
  const today = new Date();
  const day = getDate(today);
  const y = today.getFullYear();
  const m = today.getMonth();
  if (day <= 15) {
    return {
      start: format(new Date(y, m, 1), "yyyy-MM-dd"),
      end: format(new Date(y, m, 15), "yyyy-MM-dd"),
    };
  }
  return {
    start: format(new Date(y, m, 16), "yyyy-MM-dd"),
    end: format(new Date(y, m, getDaysInMonth(today)), "yyyy-MM-dd"),
  };
}

function formatRunLabel(gfsCycle: string | undefined, fetchedAt: string | undefined): string | null {
  if (!gfsCycle) return null;
  const base = fetchedAt ? new Date(fetchedAt) : new Date();
  return `Run GFS de ${gfsCycle}Z · ${format(base, "d MMMM yyyy", { locale: fr })}`;
}

type DraftData = {
  title: string;
  periodStart: string;
  periodEnd: string;
  notes: string;
  sectionNotes: Record<string, string>;
};

async function fetchServerDraft(): Promise<DraftData | null> {
  try {
    const res = await fetch("/api/draft");
    if (!res.ok) return null;
    const json = await res.json() as { data: DraftData | null };
    return json.data;
  } catch {
    return null;
  }
}

async function saveServerDraft(data: DraftData): Promise<void> {
  try {
    await fetch("/api/draft", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
  } catch { /* best-effort */ }
}

async function deleteServerDraft(): Promise<void> {
  try {
    await fetch("/api/draft", { method: "DELETE" });
  } catch { /* best-effort */ }
}

export default function NewAnalysis() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();

  const defaultPeriod = getDefaultPeriod();
  const defaultTitle = `Analyse Bi-hebdo — ${format(new Date(), "MMMM yyyy", { locale: fr })}`;

  const [title, setTitle] = useState(defaultTitle);
  const [periodStart, setPeriodStart] = useState(defaultPeriod.start);
  const [periodEnd, setPeriodEnd] = useState(defaultPeriod.end);
  const [notes, setNotes] = useState("");
  const [sectionNotes, setSectionNotes] = useState<Record<string, string>>({});
  const [draftRestored, setDraftRestored] = useState(false);
  const [saving, setSaving] = useState<"idle" | "saving" | "saved">("idle");
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load draft on mount: server first, then localStorage, then last archived analysis as default
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let draft: DraftData | null = await fetchServerDraft();
      if (!draft) {
        try {
          const ls = localStorage.getItem(DRAFT_LS_KEY);
          if (ls) draft = JSON.parse(ls) as DraftData;
        } catch { /* ignore */ }
      }
      if (cancelled) return;
      if (draft) {
        if (draft.title) setTitle(draft.title);
        if (draft.periodStart) setPeriodStart(draft.periodStart);
        if (draft.periodEnd) setPeriodEnd(draft.periodEnd);
        if (draft.notes) setNotes(draft.notes);
        if (draft.sectionNotes && Object.keys(draft.sectionNotes).length > 0) {
          setSectionNotes(draft.sectionNotes);
        }
        setDraftRestored(true);
      } else {
        // Pré-remplir depuis la dernière analyse archivée
        try {
          const res = await fetch("/api/analyses?page=1&limit=1");
          if (res.ok) {
            const json = await res.json() as { items: Array<{ notes?: string | null; sectionNotes?: Record<string, string> | null }> };
            const last = json.items?.[0];
            if (last && !cancelled) {
              if (last.notes) setNotes(last.notes);
              if (last.sectionNotes && Object.keys(last.sectionNotes).length > 0) {
                setSectionNotes(last.sectionNotes);
              }
            }
          }
        } catch { /* best-effort */ }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Debounced save: localStorage immediately + server with 800ms debounce
  const persistDraft = useCallback((updates: Partial<DraftData>) => {
    setSectionNotes((prevNotes) => {
      const currentDraft: DraftData = {
        title, periodStart, periodEnd, notes,
        sectionNotes: prevNotes,
        ...updates,
      };
      // Save to localStorage immediately
      try { localStorage.setItem(DRAFT_LS_KEY, JSON.stringify(currentDraft)); } catch { /* ignore */ }
      // Debounce server save
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      setSaving("saving");
      saveTimerRef.current = setTimeout(async () => {
        await saveServerDraft(currentDraft);
        setSaving("saved");
        setTimeout(() => setSaving("idle"), 1500);
      }, 800);
      return prevNotes;
    });
  }, [title, periodStart, periodEnd, notes]);

  const handleTitleChange = (v: string) => { setTitle(v); persistDraft({ title: v }); };
  const handlePeriodStartChange = (v: string) => { setPeriodStart(v); persistDraft({ periodStart: v }); };
  const handlePeriodEndChange = (v: string) => { setPeriodEnd(v); persistDraft({ periodEnd: v }); };
  const handleNotesChange = (v: string) => { setNotes(v); persistDraft({ notes: v }); };
  const handleNoteChange = (key: string, value: string) => {
    setSectionNotes((prev) => {
      const next = { ...prev, [key]: value };
      // Save with the updated notes map
      const currentDraft: DraftData = { title, periodStart, periodEnd, notes, sectionNotes: next };
      try { localStorage.setItem(DRAFT_LS_KEY, JSON.stringify(currentDraft)); } catch { /* ignore */ }
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      setSaving("saving");
      saveTimerRef.current = setTimeout(async () => {
        await saveServerDraft(currentDraft);
        setSaving("saved");
        setTimeout(() => setSaving("idle"), 1500);
      }, 800);
      return next;
    });
  };

  const { data: catalog, isLoading: isChartsLoading, refetch, isRefetching } = useGetNoaaCharts({
    query: { staleTime: 0, refetchOnMount: "always", queryKey: ["noaa", "charts"] },
  });
  const createMutation = useCreateAnalysis();

  const handleSave = () => {
    if (!catalog?.sections) return;
    createMutation.mutate(
      {
        data: {
          title, periodStart, periodEnd, notes,
          sections: catalog.sections,
          sectionNotes: Object.keys(sectionNotes).length > 0 ? sectionNotes : undefined,
        },
      },
      {
        onSuccess: (data) => {
          // Clear draft everywhere
          void deleteServerDraft();
          try { localStorage.removeItem(DRAFT_LS_KEY); } catch { /* ignore */ }
          toast({ title: "Analyse archivée", description: "L'analyse a été enregistrée avec succès." });
          setLocation(`/analyses/${data.id}`);
        },
        onError: () => {
          toast({ title: "Erreur", description: "Échec de l'archivage.", variant: "destructive" });
        },
      }
    );
  };

  const runLabel = formatRunLabel(catalog?.gfsCycle ?? undefined, catalog?.fetchedAt ?? undefined);

  return (
    <div className="space-y-8">

      {/* Header */}
      <div className="pt-4 pb-8 border-b border-border">
        <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground mb-5">
          Nouvelle analyse
        </p>
        <div className="flex items-end justify-between gap-6 flex-wrap">
          <h1 className="text-5xl font-bold leading-tight text-foreground">
            Saisie &amp;<br />archivage
          </h1>
          <div className="flex items-center gap-3 shrink-0">
            {saving !== "idle" && (
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                {saving === "saving"
                  ? <><Cloud className="h-3.5 w-3.5 animate-pulse" /> Sauvegarde…</>
                  : <><Cloud className="h-3.5 w-3.5 text-primary" /> Sauvegardé</>
                }
              </span>
            )}
            {draftRestored && saving === "idle" && (
              <span className="text-xs text-primary/70 font-medium">Brouillon restauré</span>
            )}
            <Button
              onClick={handleSave}
              disabled={!catalog?.sections || createMutation.isPending || isChartsLoading}
              className="gap-2 bg-primary text-primary-foreground hover:bg-primary/90"
            >
              {createMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              Archiver l'analyse
            </Button>
          </div>
        </div>
      </div>

      {/* Paramètres */}
      <div className="bg-card border border-border rounded-xl p-6 space-y-6">
        <div className="flex items-center gap-2 mb-1">
          <div className="h-4 w-1 bg-primary rounded-full" />
          <h2 className="text-xs font-bold text-foreground uppercase tracking-widest">Paramètres du rapport</h2>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
          <div className="space-y-1.5 md:col-span-1">
            <Label htmlFor="title" className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Titre</Label>
            <Input id="title" value={title} onChange={(e) => handleTitleChange(e.target.value)} className="bg-background" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="periodStart" className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Début période</Label>
            <Input id="periodStart" type="date" value={periodStart} onChange={(e) => handlePeriodStartChange(e.target.value)} className="bg-background" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="periodEnd" className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Fin période</Label>
            <Input id="periodEnd" type="date" value={periodEnd} onChange={(e) => handlePeriodEndChange(e.target.value)} className="bg-background" />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="notes" className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Notes préliminaires</Label>
          <Textarea id="notes" value={notes} onChange={(e) => handleNotesChange(e.target.value)}
            className="min-h-[90px] bg-background resize-y"
            placeholder="Anomalies SST, contexte général, remarques…" />
        </div>
      </div>

      {/* Cartes NOAA */}
      <div className="space-y-5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Satellite className="h-5 w-5 text-primary" />
            <div>
              <h2 className="text-base font-bold text-foreground">Cartes NOAA en direct</h2>
              {runLabel && <p className="text-xs text-muted-foreground mt-0.5">{runLabel}</p>}
            </div>
            {!isChartsLoading && catalog?.sections && (
              <span className="text-xs text-muted-foreground bg-muted px-2 py-0.5 rounded-full">
                {catalog.sections.length} sections
              </span>
            )}
          </div>
          <Button variant="outline" size="sm" onClick={() => refetch()}
            disabled={isChartsLoading || isRefetching} className="gap-2">
            <RefreshCw className={cn("h-4 w-4", isRefetching && "animate-spin")} />
            Actualiser
          </Button>
        </div>

        <NoaaChartViewer
          sections={catalog?.sections}
          isLoading={isChartsLoading}
          sectionNotes={sectionNotes}
          onNoteChange={handleNoteChange}
        />

        {/* Conclusion */}
        {!isChartsLoading && catalog?.sections && (
          <div className="border border-border bg-card rounded-xl p-6 space-y-3">
            <div className="flex items-center gap-2">
              <PenLine className="h-4 w-4 text-primary" />
              <h3 className="text-xs font-bold text-foreground uppercase tracking-widest">Conclusion générale</h3>
            </div>
            <Textarea
              value={sectionNotes["conclusion"] ?? ""}
              onChange={(e) => handleNoteChange("conclusion", e.target.value)}
              className="min-h-[120px] bg-background resize-y text-sm"
              placeholder="Synthèse de la situation météorologique, perspectives pour la période…"
            />
          </div>
        )}

        {/* Perspectives semaines */}
        {!isChartsLoading && catalog?.sections && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="border border-border bg-card rounded-xl p-6 space-y-3">
              <div className="flex items-center gap-2">
                <PenLine className="h-4 w-4 text-primary" />
                <h3 className="text-xs font-bold text-foreground uppercase tracking-widest">Perspectives semaine 1</h3>
              </div>
              <Textarea
                value={sectionNotes["perspectives-s1"] ?? ""}
                onChange={(e) => handleNoteChange("perspectives-s1", e.target.value)}
                className="min-h-[140px] bg-background resize-y text-sm"
                placeholder="Prévisions et tendances pour la semaine 1…"
              />
            </div>
            <div className="border border-border bg-card rounded-xl p-6 space-y-3">
              <div className="flex items-center gap-2">
                <PenLine className="h-4 w-4 text-primary" />
                <h3 className="text-xs font-bold text-foreground uppercase tracking-widest">Perspectives semaine 2</h3>
              </div>
              <Textarea
                value={sectionNotes["perspectives-s2"] ?? ""}
                onChange={(e) => handleNoteChange("perspectives-s2", e.target.value)}
                className="min-h-[140px] bg-background resize-y text-sm"
                placeholder="Prévisions et tendances pour la semaine 2…"
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
