import { useState } from "react";
import { useRoute, useLocation } from "wouter";
import {
  useGetAnalysis, useUpdateAnalysis, useDeleteAnalysis,
  getGetAnalysesSummaryQueryKey, getListAnalysesQueryKey,
} from "@workspace/api-client-react";
import { NoaaChartViewer } from "@/components/noaa-chart-viewer";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader,
  AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { format, parseISO } from "date-fns";
import { fr } from "date-fns/locale";
import { Loader2, Calendar, Edit3, Save, Trash2, X, Printer, FileText, Code } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";

type ChartItem = { id: string; label: string; url: string; description?: string | null; directLoad?: boolean };
type Subsection = { label: string; charts: ChartItem[] };
type Section = { id: string; name: string; subsections: Subsection[] };


function getProxyUrl(url: string, directLoad?: boolean) {
  return directLoad ? url : `/api/noaa/proxy?url=${encodeURIComponent(url)}`;
}
function imageTypeFromUrl(url: string): "gif" | "png" | "jpg" {
  if (url.endsWith(".gif")) return "gif";
  if (url.endsWith(".png")) return "png";
  return "jpg";
}

function fullNote(noteMap: Record<string, string>, key: string): string {
  const a = noteMap[key] ?? "";
  const b = noteMap[`${key}-suite`] ?? "";
  return [a, b].filter(Boolean).join("\n\n");
}

function exportToHtml(analysis: {
  title: string; periodStart: string; periodEnd: string;
  createdAt: string; notes?: string | null; sections: unknown; sectionNotes?: unknown;
}) {
  const sections = analysis.sections as Section[];
  const noteMap = (analysis.sectionNotes as Record<string, string>) ?? {};
  const origin = window.location.origin;

  const sectionsHtml = sections.map((section) => {
    const subsHtml = section.subsections.map((sub) => {
      const chartsHtml = sub.charts.map((chart) => {
        const src = `${origin}/api/noaa/proxy?url=${encodeURIComponent(chart.url)}`;
        return `<div class="chart"><div class="chart-label">${chart.label}</div><img src="${src}" alt="${chart.label}" /></div>`;
      }).join("");
      return `<div class="subsection"><h3>${sub.label}</h3><div class="charts-grid">${chartsHtml}</div></div>`;
    }).join("");
    const sectionNote = fullNote(noteMap, section.id);
    return `<section><h2>${section.name}</h2>${subsHtml}${sectionNote ? `<div class="obs section-obs"><strong>Analyse :</strong><p>${sectionNote}</p></div>` : ""}</section>`;
  }).join("");

  const conclusion = noteMap["conclusion"] ?? "";
  const perspS1 = noteMap["perspectives-s1"] ?? "";
  const perspS2 = noteMap["perspectives-s2"] ?? "";
  const perspHtml = (perspS1 || perspS2) ? `<section><h2>Perspectives</h2><div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">${perspS1 ? `<div><h3>Semaine 1</h3><div class="obs"><p>${perspS1}</p></div></div>` : ""}${perspS2 ? `<div><h3>Semaine 2</h3><div class="obs"><p>${perspS2}</p></div></div>` : ""}</div></section>` : "";
  const html = `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><title>${analysis.title}</title>
<style>*{box-sizing:border-box}body{font-family:'Segoe UI',Arial,sans-serif;max-width:1100px;margin:0 auto;padding:24px;color:#1a2234;background:#f7f3ea}
.header{background:#1b3d28;color:#fff;padding:24px 28px;border-radius:10px;margin-bottom:20px}
.header h1{margin:0 0 8px;font-size:22px;font-weight:700}.header .meta{font-size:13px;opacity:.8;display:flex;gap:20px;flex-wrap:wrap}
section{background:#fff;border-radius:10px;padding:20px 24px;margin-bottom:14px;border:1px solid #dde3ec}
h2{font-size:16px;font-weight:700;color:#1b3d28;border-bottom:2px solid #e5efea;padding-bottom:8px;margin:0 0 16px}
h3{font-size:11px;text-transform:uppercase;letter-spacing:1.5px;color:#6b7a99;font-weight:600;margin:16px 0 10px}
.subsection{margin-bottom:20px}.charts-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.chart img{width:100%;height:auto;border-radius:6px;border:1px solid #dde3ec;display:block}
.chart-label{font-size:11px;font-weight:600;color:#3d5075;margin-bottom:5px}
.obs{background:#f0f6f2;border-left:3px solid #1b3d28;padding:10px 14px;border-radius:0 6px 6px 0;margin-top:10px;font-size:13px;white-space:pre-wrap}
.obs strong{display:block;font-size:10px;text-transform:uppercase;letter-spacing:.8px;color:#1b3d28;margin-bottom:4px}
.obs p{margin:0}.notes-block{background:#fffbf0;border:1px solid #f0e0a0;border-radius:8px;padding:14px 18px;margin-bottom:16px;font-size:13px;white-space:pre-wrap}
@media print{body{background:#fff}section{page-break-inside:avoid}}</style></head><body>
<div class="header"><h1>${analysis.title}</h1><div class="meta">
<span>📅 ${format(parseISO(analysis.periodStart), "dd MMMM yyyy", { locale: fr })} → ${format(parseISO(analysis.periodEnd), "dd MMMM yyyy", { locale: fr })}</span>
<span>Archivé le ${format(parseISO(analysis.createdAt), "dd MMM yyyy à HH:mm", { locale: fr })}</span></div></div>
${analysis.notes ? `<div class="notes-block"><strong>Notes préliminaires :</strong>\n${analysis.notes}</div>` : ""}
${sectionsHtml}
${conclusion ? `<section><h2>Conclusion générale</h2><div class="obs"><p>${conclusion}</p></div></section>` : ""}
${perspHtml}
</body></html>`;

  const blob = new Blob([html], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${analysis.title.replace(/[^a-z0-9_\-. ]/gi, "_")}.html`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

async function exportToWord(analysis: {
  title: string; periodStart: string; periodEnd: string;
  createdAt: string; notes?: string | null; sections: unknown; sectionNotes?: unknown;
}) {
  const { Document, Paragraph, TextRun, ImageRun, HeadingLevel, AlignmentType, Packer, BorderStyle } = await import("docx");
  const sections = analysis.sections as Section[];
  const noteMap = (analysis.sectionNotes as Record<string, string>) ?? {};
  const docChildren: InstanceType<typeof Paragraph>[] = [];

  docChildren.push(new Paragraph({ text: analysis.title, heading: HeadingLevel.HEADING_1, alignment: AlignmentType.CENTER }));
  docChildren.push(new Paragraph({ children: [new TextRun({ text: `Période : ${format(parseISO(analysis.periodStart), "dd MMM yyyy", { locale: fr })} → ${format(parseISO(analysis.periodEnd), "dd MMM yyyy", { locale: fr })}`, size: 22, color: "555555" })], alignment: AlignmentType.CENTER }));
  docChildren.push(new Paragraph({ children: [new TextRun({ text: `Archivé le ${format(parseISO(analysis.createdAt), "dd MMM yyyy à HH:mm", { locale: fr })}`, size: 20, color: "777777", italics: true })], alignment: AlignmentType.CENTER }));
  docChildren.push(new Paragraph({ text: "" }));

  if (analysis.notes) {
    docChildren.push(new Paragraph({ text: "Notes préliminaires", heading: HeadingLevel.HEADING_2, border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: "1b3d28" } } }));
    for (const line of analysis.notes.split("\n")) {
      docChildren.push(new Paragraph({ children: [new TextRun({ text: line, size: 22 })] }));
    }
    docChildren.push(new Paragraph({ text: "" }));
  }

  for (const section of sections) {
    docChildren.push(new Paragraph({ text: section.name, heading: HeadingLevel.HEADING_2, border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: "1b3d28" } }, pageBreakBefore: true }));
    for (const sub of section.subsections) {
      docChildren.push(new Paragraph({ text: sub.label.toUpperCase(), heading: HeadingLevel.HEADING_3 }));
      for (const chart of sub.charts) {
        docChildren.push(new Paragraph({ children: [new TextRun({ text: chart.label, bold: true, size: 22 })] }));
        if (chart.description) docChildren.push(new Paragraph({ children: [new TextRun({ text: chart.description, size: 20, color: "555555", italics: true })] }));
        try {
          const resp = await fetch(getProxyUrl(chart.url, chart.directLoad));
          if (resp.ok) {
            const buffer = await resp.arrayBuffer();
            docChildren.push(new Paragraph({ children: [new ImageRun({ data: buffer, transformation: { width: 480, height: 340 }, type: imageTypeFromUrl(chart.url) })] }));
          }
        } catch { /* skip */ }
        docChildren.push(new Paragraph({ text: "" }));
      }
    }
    const sectionNote = fullNote(noteMap, section.id);
    if (sectionNote) {
      docChildren.push(new Paragraph({ children: [new TextRun({ text: `Analyse ${section.name} :`, bold: true, size: 22, color: "1b3d28" })] }));
      for (const line of sectionNote.split("\n")) docChildren.push(new Paragraph({ children: [new TextRun({ text: line, size: 22 })] }));
      docChildren.push(new Paragraph({ text: "" }));
    }
  }

  if (noteMap["conclusion"]) {
    docChildren.push(new Paragraph({ text: "Conclusion générale", heading: HeadingLevel.HEADING_2, border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: "1b3d28" } }, pageBreakBefore: true }));
    for (const line of noteMap["conclusion"].split("\n")) docChildren.push(new Paragraph({ children: [new TextRun({ text: line, size: 22 })] }));
    docChildren.push(new Paragraph({ text: "" }));
  }

  if (noteMap["perspectives-s1"] || noteMap["perspectives-s2"]) {
    docChildren.push(new Paragraph({ text: "Perspectives", heading: HeadingLevel.HEADING_2, border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: "1b3d28" } }, pageBreakBefore: !noteMap["conclusion"] }));
    if (noteMap["perspectives-s1"]) {
      docChildren.push(new Paragraph({ text: "Semaine 1", heading: HeadingLevel.HEADING_3 }));
      for (const line of noteMap["perspectives-s1"].split("\n")) docChildren.push(new Paragraph({ children: [new TextRun({ text: line, size: 22 })] }));
      docChildren.push(new Paragraph({ text: "" }));
    }
    if (noteMap["perspectives-s2"]) {
      docChildren.push(new Paragraph({ text: "Semaine 2", heading: HeadingLevel.HEADING_3 }));
      for (const line of noteMap["perspectives-s2"].split("\n")) docChildren.push(new Paragraph({ children: [new TextRun({ text: line, size: 22 })] }));
    }
  }

  const doc = new Document({ title: analysis.title, sections: [{ children: docChildren }] });
  const blob = await Packer.toBlob(doc);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${analysis.title.replace(/[^a-z0-9_\-. ]/gi, "_")}.docx`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export default function AnalysisDetail() {
  const [, params] = useRoute("/analyses/:id");
  const id = params?.id ? parseInt(params.id, 10) : 0;
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: analysis, isLoading } = useGetAnalysis(id, { query: { enabled: !!id, queryKey: ["analysis", id] } });
  const updateMutation = useUpdateAnalysis();
  const deleteMutation = useDeleteAnalysis();

  const [isEditingNotes, setIsEditingNotes] = useState(false);
  const [editedNotes, setEditedNotes] = useState("");
  const [isExportingWord, setIsExportingWord] = useState(false);

  const handleSaveNotes = () => {
    updateMutation.mutate({ id, data: { notes: editedNotes } }, {
      onSuccess: () => {
        setIsEditingNotes(false);
        queryClient.invalidateQueries({ queryKey: getGetAnalysesSummaryQueryKey() });
        toast({ title: "Notes mises à jour." });
      },
      onError: () => toast({ title: "Erreur", variant: "destructive" }),
    });
  };

  const handleDelete = () => {
    deleteMutation.mutate({ id }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetAnalysesSummaryQueryKey() });
        queryClient.invalidateQueries({ queryKey: getListAnalysesQueryKey() });
        toast({ title: "Archive supprimée." });
        setLocation("/archives");
      },
      onError: () => toast({ title: "Erreur suppression", variant: "destructive" }),
    });
  };

  const handleExportWord = async () => {
    if (!analysis) return;
    setIsExportingWord(true);
    try {
      await exportToWord(analysis as Parameters<typeof exportToWord>[0]);
      toast({ title: "Fichier Word téléchargé." });
    } catch {
      toast({ title: "Erreur export Word", variant: "destructive" });
    } finally {
      setIsExportingWord(false);
    }
  };

  const handleExportHtml = () => {
    if (!analysis) return;
    try {
      exportToHtml(analysis as Parameters<typeof exportToHtml>[0]);
      toast({ title: "Fichier HTML téléchargé." });
    } catch {
      toast({ title: "Erreur export HTML", variant: "destructive" });
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[40vh]">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  if (!analysis) {
    return (
      <div className="flex items-center justify-center min-h-[40vh] text-muted-foreground">
        <p className="text-sm">Enregistrement introuvable.</p>
      </div>
    );
  }

  return (
    <div className="space-y-10">

      {/* En-tête */}
      <div className="pt-4 pb-8 border-b border-border">
        <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground mb-5">
          Archive
        </p>
        <h1 className="text-4xl font-bold text-foreground leading-tight mb-4">{analysis.title}</h1>
        <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <Calendar className="h-4 w-4" />
          {format(parseISO(analysis.periodStart), "d MMMM yyyy", { locale: fr })}
          <span className="opacity-40 mx-1">→</span>
          {format(parseISO(analysis.periodEnd), "d MMMM yyyy", { locale: fr })}
          <span className="mx-3 text-border">·</span>
          Archivé le {format(parseISO(analysis.createdAt), "dd MMM yyyy", { locale: fr })}
        </div>
      </div>

      {/* ── EXPORTS ── section très visible */}
      <div className="bg-card border border-border rounded-xl p-5 no-print">
        <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground mb-4">
          Exporter cette analyse
        </p>
        <div className="flex flex-wrap gap-3">
          <Button onClick={() => window.print()} variant="outline"
            className="gap-2 border-border hover:border-primary hover:text-primary">
            <Printer className="h-4 w-4" />
            Imprimer / PDF
          </Button>
          <Button onClick={handleExportWord} disabled={isExportingWord} variant="outline"
            className="gap-2 border-border hover:border-primary hover:text-primary">
            {isExportingWord ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />}
            {isExportingWord ? "Génération…" : "Télécharger Word (.docx)"}
          </Button>
          <Button onClick={handleExportHtml} variant="outline"
            className="gap-2 border-border hover:border-primary hover:text-primary">
            <Code className="h-4 w-4" />
            Télécharger HTML
          </Button>
          <div className="ml-auto">
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="ghost" size="sm"
                  className="text-destructive/70 hover:text-destructive hover:bg-destructive/8 gap-1.5 text-xs">
                  <Trash2 className="h-3.5 w-3.5" /> Supprimer
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent className="bg-card border-border">
                <AlertDialogHeader>
                  <AlertDialogTitle>Supprimer cette archive ?</AlertDialogTitle>
                  <AlertDialogDescription className="text-muted-foreground">
                    Action permanente et irréversible.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Annuler</AlertDialogCancel>
                  <AlertDialogAction onClick={handleDelete}
                    className="bg-destructive hover:bg-destructive/90 text-white">
                    Supprimer
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </div>
      </div>

      {/* Notes */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
            Notes préliminaires
          </h3>
          <div className="no-print">
            {!isEditingNotes ? (
              <Button variant="ghost" size="sm" onClick={() => { setEditedNotes(analysis.notes || ""); setIsEditingNotes(true); }}
                className="text-primary hover:text-primary gap-1.5 text-xs">
                <Edit3 className="h-3.5 w-3.5" /> Éditer
              </Button>
            ) : (
              <div className="flex gap-2">
                <Button variant="ghost" size="sm" onClick={() => setIsEditingNotes(false)} className="gap-1 text-xs">
                  <X className="h-3.5 w-3.5" /> Annuler
                </Button>
                <Button size="sm" onClick={handleSaveNotes} disabled={updateMutation.isPending} className="gap-1 text-xs">
                  {updateMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                  Enregistrer
                </Button>
              </div>
            )}
          </div>
        </div>
        {isEditingNotes ? (
          <Textarea value={editedNotes} onChange={(e) => setEditedNotes(e.target.value)}
            className="min-h-[100px] bg-card resize-y text-sm" placeholder="Notes préliminaires…" />
        ) : (
          <div className="bg-card border border-border rounded-xl p-4 min-h-[60px] text-sm text-foreground whitespace-pre-wrap leading-relaxed">
            {analysis.notes || <span className="text-muted-foreground italic">Aucune note.</span>}
          </div>
        )}
      </div>

      {/* Cartes archivées */}
      <div className="space-y-4">
        <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
          Cartes archivées
        </h3>
        <NoaaChartViewer
          sections={analysis.sections}
          sectionNotes={(analysis.sectionNotes as Record<string, string>) ?? {}}
          readOnly
        />
        {(analysis.sectionNotes as Record<string, string>)?.conclusion && (
          <div className="bg-card border border-border rounded-xl p-6 space-y-3 mt-2">
            <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
              Conclusion générale
            </h3>
            <p className="text-sm text-foreground whitespace-pre-wrap leading-relaxed">
              {(analysis.sectionNotes as Record<string, string>).conclusion}
            </p>
          </div>
        )}

        {/* Perspectives semaines */}
        {((analysis.sectionNotes as Record<string, string>)?.["perspectives-s1"] ||
          (analysis.sectionNotes as Record<string, string>)?.["perspectives-s2"]) && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-2">
            {(analysis.sectionNotes as Record<string, string>)?.["perspectives-s1"] && (
              <div className="bg-card border border-border rounded-xl p-6 space-y-3">
                <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                  Perspectives semaine 1
                </h3>
                <p className="text-sm text-foreground whitespace-pre-wrap leading-relaxed">
                  {(analysis.sectionNotes as Record<string, string>)["perspectives-s1"]}
                </p>
              </div>
            )}
            {(analysis.sectionNotes as Record<string, string>)?.["perspectives-s2"] && (
              <div className="bg-card border border-border rounded-xl p-6 space-y-3">
                <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                  Perspectives semaine 2
                </h3>
                <p className="text-sm text-foreground whitespace-pre-wrap leading-relaxed">
                  {(analysis.sectionNotes as Record<string, string>)["perspectives-s2"]}
                </p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
