import { useState, useCallback, useEffect } from "react";
import { useRoute, useLocation } from "wouter";
import { useGetBriefing, useUpdateBriefing, useDeleteBriefing } from "@workspace/api-client-react";
import type { BriefingSection } from "@workspace/api-client-react";
import { BriefingChartViewer } from "@/components/briefing-chart-viewer";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { useToast } from "@/hooks/use-toast";
import { format, parseISO } from "date-fns";
import { fr } from "date-fns/locale";
import { Loader2, ArrowLeft, Save, Trash2, Printer, FileText, Code, Presentation, CloudCheck, RotateCcw } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  exportBriefingAsHtml,
  exportBriefingAsPptx,
  printBriefing,
  type BriefingForExport,
} from "@/lib/briefing-export";

function filterImageKeys(sn: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(sn)) {
    if (k.startsWith("__img__") || k.startsWith("__ann__")) continue;
    if (/^__custom_\d+_img_\d+__$/.test(k)) continue;
    result[k] = v;
  }
  return result;
}

export default function BriefingDetail() {
  const [, params] = useRoute("/briefings/:id");
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const id = parseInt(params?.id ?? "", 10);
  const DRAFT_KEY = `briefing-draft-${id}`;

  const { data: briefing, isLoading, isError } = useGetBriefing(id);

  const [notes, setNotes] = useState<string | undefined>(undefined);
  const [sectionNotes, setSectionNotes] = useState<Record<string, string> | undefined>(undefined);
  const [dirty, setDirty] = useState(false);
  const [draftRestored, setDraftRestored] = useState(false);
  const [draftSavedAt, setDraftSavedAt] = useState<Date | null>(null);
  const [draftSaveFailed, setDraftSaveFailed] = useState(false);

  const [exportingHtml, setExportingHtml] = useState(false);
  const [exportingPptx, setExportingPptx] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);

  const effectiveNotes = notes !== undefined ? notes : (briefing?.notes ?? "");
  const effectiveSN = sectionNotes !== undefined ? sectionNotes : ((briefing?.sectionNotes ?? {}) as Record<string, string>);

  // Restore localStorage draft when briefing data arrives
  useEffect(() => {
    if (!briefing || sectionNotes !== undefined) return;
    try {
      const raw = localStorage.getItem(DRAFT_KEY);
      if (!raw) return;
      const draft = JSON.parse(raw) as { sectionNotes?: Record<string, string>; notes?: string };
      let restored = false;
      if (draft.sectionNotes && Object.keys(draft.sectionNotes).length > 0) {
        setSectionNotes(draft.sectionNotes);
        restored = true;
      }
      if (draft.notes !== undefined && draft.notes !== briefing.notes) {
        setNotes(draft.notes);
        restored = true;
      }
      if (restored) {
        setDirty(true);
        setDraftRestored(true);
      }
    } catch {}
  }, [briefing, sectionNotes, DRAFT_KEY]);

  // Auto-save to localStorage (debounced 800ms, only when dirty) — images stripped
  useEffect(() => {
    if (!dirty) return;
    const t = setTimeout(() => {
      try {
        const draftSN = filterImageKeys(effectiveSN);
        localStorage.setItem(DRAFT_KEY, JSON.stringify({ sectionNotes: draftSN, notes: effectiveNotes }));
        setDraftSavedAt(new Date());
        setDraftSaveFailed(false);
      } catch {
        setDraftSaveFailed(true);
      }
    }, 800);
    return () => clearTimeout(t);
  }, [dirty, effectiveSN, effectiveNotes, DRAFT_KEY]);

  const { mutate: updateBriefing, isPending: saving } = useUpdateBriefing({
    mutation: {
      onSuccess: () => {
        try { localStorage.removeItem(DRAFT_KEY); } catch {}
        toast({ title: "Briefing mis à jour" });
        void qc.invalidateQueries({ queryKey: ["/api/briefings"] });
        setDirty(false);
        setDraftRestored(false);
        setDraftSavedAt(null);
      },
      onError: () => {
        toast({
          title: "Erreur d'enregistrement",
          description: "Impossible de sauvegarder. Vos modifications restent dans le brouillon local.",
          variant: "destructive",
        });
      },
    },
  });

  const { mutate: deleteBriefing, isPending: deleting } = useDeleteBriefing({
    mutation: {
      onSuccess: () => {
        try { localStorage.removeItem(DRAFT_KEY); } catch {}
        toast({ title: "Briefing supprimé" });
        navigate("/briefings/archives");
      },
      onError: () => {
        toast({ title: "Erreur", description: "Suppression impossible.", variant: "destructive" });
      },
    },
  });

  const handleNoteChange = useCallback((key: string, val: string) => {
    setSectionNotes((prev) => {
      const base = prev ?? ((briefing?.sectionNotes ?? {}) as Record<string, string>);
      return { ...base, [key]: val };
    });
    setDirty(true);
  }, [briefing]);

  function handleNotesChange(val: string) {
    setNotes(val);
    setDirty(true);
  }

  function handleSave() {
    updateBriefing({ id, data: { notes: effectiveNotes, sectionNotes: effectiveSN } });
  }

  function handleDelete() {
    if (!confirm(`Supprimer définitivement ce briefing ?\nCette action est irréversible.`)) return;
    deleteBriefing({ id });
  }

  function handleDiscardDraft() {
    if (!confirm("Ignorer les modifications locales et revenir à la version archivée ?")) return;
    try { localStorage.removeItem(DRAFT_KEY); } catch {}
    setSectionNotes(undefined);
    setNotes(undefined);
    setDirty(false);
    setDraftRestored(false);
    setDraftSavedAt(null);
  }

  function getBriefingForExport(): BriefingForExport {
    return {
      id: briefing!.id,
      title: briefing!.title,
      date: briefing!.date,
      notes: effectiveNotes,
      createdAt: briefing!.createdAt,
      sections: briefing!.sections as BriefingSection[],
      sectionNotes: effectiveSN,
    };
  }

  async function handleExportHtml() {
    if (!briefing) return;
    setExportingHtml(true);
    setExportProgress(0);
    try {
      await exportBriefingAsHtml(getBriefingForExport(), (pct) => setExportProgress(pct));
      toast({ title: "HTML téléchargé ✓", description: "Fichier autonome avec images intégrées." });
    } catch {
      toast({ title: "Erreur export HTML", variant: "destructive" });
    } finally {
      setExportingHtml(false);
      setExportProgress(0);
    }
  }

  async function handleExportPptx() {
    if (!briefing) return;
    setExportingPptx(true);
    setExportProgress(0);
    try {
      await exportBriefingAsPptx(getBriefingForExport(), (pct) => setExportProgress(pct));
      toast({ title: "PowerPoint téléchargé ✓", description: "Fichier .pptx utilisable sur toutes les machines." });
    } catch (e) {
      console.error(e);
      toast({ title: "Erreur export PPTX", variant: "destructive" });
    } finally {
      setExportingPptx(false);
      setExportProgress(0);
    }
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="h-7 w-7 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (isError || !briefing) {
    return (
      <div className="flex flex-col items-center gap-4 py-24 text-center">
        <p className="text-muted-foreground">Briefing introuvable.</p>
        <Button variant="outline" onClick={() => navigate("/briefings/archives")}>
          Retour aux archives
        </Button>
      </div>
    );
  }

  const dateLabel = format(parseISO(briefing.date + "T00:00:00"), "EEEE d MMMM yyyy", { locale: fr });
  const isExporting = exportingHtml || exportingPptx;

  return (
    <div className="space-y-10">

      {/* ── En-tête ──────────────────────────────────────── */}
      <div className="pt-4 pb-6 border-b border-border">
        <button
          onClick={() => navigate("/briefings/archives")}
          className="flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground transition-colors mb-5 no-print"
        >
          <ArrowLeft className="h-4 w-4" />
          Briefings archivés
        </button>
        <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground mb-2">
          Briefing Quotidien
        </p>
        <h1 className="text-3xl font-bold text-foreground leading-tight">{briefing.title}</h1>
        <p className="text-muted-foreground text-sm mt-1 capitalize">{dateLabel}</p>
        <p className="text-xs text-muted-foreground/50 mt-1">
          Archivé le {format(new Date(briefing.createdAt), "d MMMM yyyy à HH:mm", { locale: fr })}
        </p>
      </div>

      {/* ── Bannière brouillon récupéré ───────────────────── */}
      {draftRestored && (
        <div className="flex items-start justify-between gap-4 rounded-xl border border-amber-200 bg-amber-50 dark:border-amber-900/60 dark:bg-amber-950/30 px-4 py-3 no-print">
          <div className="flex items-center gap-2 text-sm text-amber-800 dark:text-amber-300">
            <RotateCcw className="h-4 w-4 shrink-0" />
            <span>
              <strong>Modifications non enregistrées récupérées</strong> — cliquez sur "Enregistrer" pour les sauvegarder définitivement.
            </span>
          </div>
          <button
            onClick={handleDiscardDraft}
            className="text-xs text-amber-600 dark:text-amber-400 hover:underline shrink-0 mt-0.5"
          >
            Ignorer
          </button>
        </div>
      )}

      {/* ── EXPORT ───────────────────────────────────────── */}
      <div className="bg-card border border-border rounded-xl p-5 no-print">
        <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground mb-4">
          Exporter ce briefing
        </p>

        {isExporting && (
          <div className="mb-4 space-y-1.5">
            <p className="text-xs text-muted-foreground">
              {exportingHtml ? "Intégration des images…" : "Génération des diapositives…"} {exportProgress}%
            </p>
            <Progress value={exportProgress} className="h-1.5" />
          </div>
        )}

        <div className="flex flex-wrap gap-3">
          <Button
            onClick={printBriefing}
            variant="outline"
            disabled={isExporting}
            className="gap-2 border-border hover:border-primary hover:text-primary"
          >
            <Printer className="h-4 w-4" />
            Imprimer / PDF
          </Button>

          <Button
            onClick={() => void handleExportHtml()}
            disabled={isExporting}
            variant="outline"
            className="gap-2 border-border hover:border-primary hover:text-primary"
          >
            {exportingHtml
              ? <Loader2 className="h-4 w-4 animate-spin" />
              : <Code className="h-4 w-4" />}
            {exportingHtml ? `HTML… ${exportProgress}%` : "Télécharger HTML"}
          </Button>

          <Button
            onClick={() => void handleExportPptx()}
            disabled={isExporting}
            variant="outline"
            className="gap-2 border-border hover:border-primary hover:text-primary"
          >
            {exportingPptx
              ? <Loader2 className="h-4 w-4 animate-spin" />
              : <Presentation className="h-4 w-4" />}
            {exportingPptx ? `PowerPoint… ${exportProgress}%` : "Télécharger PowerPoint (.pptx)"}
          </Button>

          <Button
            asChild
            variant="outline"
            disabled={isExporting}
            className="gap-2 border-border hover:border-primary hover:text-primary"
          >
            <a
              href={`/api/briefings/${id}/export-pdf`}
              download
              onClick={(e) => {
                e.preventDefault();
                toast({ title: "Astuce PDF", description: "Utilisez 'Imprimer → Enregistrer en PDF' pour un PDF haute qualité avec toutes les images." });
              }}
            >
              <FileText className="h-4 w-4" />
              PDF (via impression)
            </a>
          </Button>
        </div>

        <p className="text-[11px] text-muted-foreground/60 mt-3 leading-relaxed">
          HTML et PPTX embarquent toutes les images — utilisables sans connexion et sur toutes les machines.
          Les sections live (Windy satellite, etc.) apparaissent comme captures si elles ont été sauvegardées, sinon comme lien.
        </p>
      </div>

      {/* ── Sections archivées ───────────────────────────── */}
      <BriefingChartViewer
        sections={briefing.sections as BriefingSection[]}
        sectionNotes={effectiveSN}
        onNoteChange={handleNoteChange}
      />

      {/* ── Résumé (toujours en fin) ──────────────────────── */}
      <div className="rounded-2xl border-2 border-foreground/80 bg-card overflow-hidden shadow-sm">
        <div className="border-b-2 border-foreground/80 py-3 px-6 text-center">
          <span className="text-base font-bold tracking-widest uppercase text-foreground">Résumé</span>
        </div>
        <div className="p-6">
          <Textarea
            id="notes-generales"
            value={effectiveNotes}
            onChange={(e) => handleNotesChange(e.target.value)}
            rows={8}
            className="resize-none border-0 bg-transparent p-0 text-sm leading-relaxed focus-visible:ring-0 focus-visible:ring-offset-0 placeholder:text-muted-foreground/40 placeholder:italic"
            placeholder={"• L'image satellitaire de 09H30 montre…\n• Le Front Intertropical (FIT) se situe…\n• La dépression thermique saharienne…\n• Les valeurs de l'eau précipitable…\n• Les conditions sont favorables à…"}
          />
        </div>
      </div>

      {/* ── Actions sticky ───────────────────────────────── */}
      <div className="sticky bottom-0 bg-background/95 backdrop-blur border-t border-border py-4 flex items-center justify-between -mx-8 px-8 no-print">
        <Button
          variant="ghost"
          size="sm"
          onClick={handleDelete}
          disabled={deleting || saving}
          className="text-destructive hover:text-destructive hover:bg-destructive/10 gap-2"
        >
          {deleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
          Supprimer
        </Button>

        <div className="flex items-center gap-4">
          {draftSaveFailed ? (
            <span className="text-[11px] text-destructive/70">⚠ Stockage local plein</span>
          ) : draftSavedAt && dirty ? (
            <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground/60">
              <CloudCheck className="h-3.5 w-3.5 text-emerald-500" />
              Brouillon local sauvegardé
            </span>
          ) : null}
          <Button onClick={handleSave} disabled={saving || !dirty} className="gap-2">
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            {saving ? "Enregistrement…" : "Enregistrer les notes"}
          </Button>
        </div>
      </div>
    </div>
  );
}
