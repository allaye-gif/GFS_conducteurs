import { useState, useRef, useEffect } from "react";
import { NoaaSection } from "@workspace/api-client-react";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { ExternalLink, ImageOff, Info, PenLine } from "lucide-react";

/* ── Textarea auto-extensible ────────────────────────────── */
function AutoTextarea({
  noteKey,
  value,
  onChange,
  placeholder,
  readOnly,
}: {
  noteKey: string;
  value: string;
  onChange?: (key: string, val: string) => void;
  placeholder?: string;
  readOnly?: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);

  if (readOnly) {
    return (
      <div className="rounded-xl border border-border bg-muted/20 px-4 py-3 text-sm text-foreground whitespace-pre-wrap leading-relaxed min-h-[110px]">
        {value || <span className="text-muted-foreground/40 italic">—</span>}
      </div>
    );
  }

  return (
    <textarea
      ref={ref}
      id={`note-${noteKey}`}
      value={value}
      onChange={(e) => onChange?.(noteKey, e.target.value)}
      placeholder={placeholder}
      rows={5}
      style={{ overflow: "hidden", resize: "none" }}
      className={cn(
        "w-full rounded-xl border border-border bg-background px-4 py-3 text-sm text-foreground",
        "placeholder:text-muted-foreground/40 focus:outline-none focus:ring-2 focus:ring-ring/30",
        "leading-relaxed min-h-[120px] transition-all"
      )}
    />
  );
}

/* ── Deux zones d'analyse côte à côte ────────────────────── */
function TwoColumnObservation({
  sectionId,
  label,
  sectionNotes,
  onChange,
  readOnly,
}: {
  sectionId: string;
  label: string;
  sectionNotes: Record<string, string>;
  onChange?: (key: string, val: string) => void;
  readOnly?: boolean;
}) {
  const keyLeft = sectionId;
  const keyRight = `${sectionId}-suite`;
  const valLeft = sectionNotes[keyLeft] ?? "";
  const valRight = sectionNotes[keyRight] ?? "";

  if (readOnly && !valLeft && !valRight) return null;

  return (
    <div className="mt-6 space-y-2">
      <div className="flex items-center gap-2">
        <PenLine className="h-3.5 w-3.5 text-primary/70 shrink-0" />
        <span className="text-xs font-bold text-muted-foreground uppercase tracking-widest">{label}</span>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="space-y-1">
          <span className="text-xs text-muted-foreground/60 font-medium">Début</span>
          <AutoTextarea
            noteKey={keyLeft}
            value={valLeft}
            onChange={onChange}
            placeholder="Début de l'analyse…"
            readOnly={readOnly}
          />
        </div>
        <div className="space-y-1">
          <span className="text-xs text-muted-foreground/60 font-medium">Suite</span>
          <AutoTextarea
            noteKey={keyRight}
            value={valRight}
            onChange={onChange}
            placeholder="Suite de l'analyse…"
            readOnly={readOnly}
          />
        </div>
      </div>
    </div>
  );
}

/* ── Image d'une carte ───────────────────────────────────── */
function isMagNcep(url: string): boolean {
  try { return new URL(url).hostname === "mag.ncep.noaa.gov"; } catch { return false; }
}

function ChartImage({
  url,
  label,
  description,
}: {
  url: string;
  label: string;
  description?: string | null;
}) {
  const [status, setStatus] = useState<"loading" | "loaded" | "error">("loading");
  const direct = isMagNcep(url);
  const src = direct ? url : `/api/noaa/proxy?url=${encodeURIComponent(url)}`;

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1">
          <p className="text-sm font-semibold text-foreground leading-snug">{label}</p>
          {description && (
            <p className="flex items-center gap-1 text-xs text-muted-foreground mt-0.5 leading-relaxed">
              <Info className="h-3 w-3 shrink-0 mt-px" />
              {description}
            </p>
          )}
        </div>
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="shrink-0 p-1.5 rounded-md text-muted-foreground/40 hover:text-primary hover:bg-primary/10 transition-all"
          title="Ouvrir sur NOAA"
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </a>
      </div>

      <div
        className="relative rounded-xl overflow-hidden border border-border bg-slate-50 shadow-sm"
        style={{ minHeight: "200px" }}
      >
        {status === "loading" && (
          <div className="absolute inset-0 flex items-center justify-center bg-slate-50">
            <Skeleton className="absolute inset-0 rounded-xl" />
            <div className="z-10 w-6 h-6 rounded-full border-2 border-primary border-t-transparent animate-spin opacity-50" />
          </div>
        )}
        {status === "error" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-slate-50/80 p-4">
            <ImageOff className="h-6 w-6 text-slate-400" />
            <div className="text-center space-y-1">
              <p className="text-xs font-medium text-slate-500">Image temporairement indisponible</p>
              <a
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-primary hover:text-primary/80 underline underline-offset-2"
              >
                Ouvrir sur NOAA →
              </a>
            </div>
          </div>
        )}
        <img
          src={src}
          alt={label}
          className={cn(
            "object-contain w-full h-full transition-opacity duration-500",
            status === "loaded" ? "opacity-100" : "opacity-0 absolute inset-0"
          )}
          onLoad={() => setStatus("loaded")}
          onError={() => setStatus("error")}
          loading="lazy"
        />
      </div>
    </div>
  );
}

/* ── Config ──────────────────────────────────────────────── */
const SECTION_COLORS: Record<string, string> = {
  mjo: "bg-violet-100 text-violet-700 border-violet-200",
  olr: "bg-orange-100 text-orange-700 border-orange-200",
  nao: "bg-emerald-100 text-emerald-700 border-emerald-200",
  fit: "bg-sky-100 text-sky-700 border-sky-200",
  "gfs-africa": "bg-amber-100 text-amber-700 border-amber-200",
};

const SECTION_NOTE_LABELS: Record<string, string> = {
  mjo: "Analyse MJO",
  olr: "Analyse OLR / VP 200 hPa",
  nao: "Analyse NAO",
  fit: "Analyse FIT",
  "gfs-africa": "Analyse GFS — Afrique de l'Ouest",
};

/* Exporté pour l'export Word/HTML (rétrocompatibilité) */
export const GFS_SUBSECTION_NOTE_KEYS: Record<string, string> = {
  "Surface — MSLP & Précipitations": "gfs-mslp",
  "Eau Précipitable (PWAT)": "gfs-pw",
  "Vents 925 hPa — Flux de Mousson": "gfs-wind925",
  "Vents 850 hPa — Jet d'Est Africain (AEJ)": "gfs-wind850",
  "Vents 700 hPa": "gfs-wind700",
  "Humidité Relative 850 hPa": "gfs-hr850",
  "Instabilité — K-Index & CAPE": "gfs-instab",
};

/* ── Composant principal ─────────────────────────────────── */
export function NoaaChartViewer({
  sections,
  isLoading,
  sectionNotes = {},
  onNoteChange,
  readOnly,
}: {
  sections?: NoaaSection[];
  isLoading?: boolean;
  sectionNotes?: Record<string, string>;
  onNoteChange?: (key: string, value: string) => void;
  readOnly?: boolean;
}) {
  if (isLoading) {
    return (
      <div className="space-y-4">
        {[1, 2, 3].map((i) => (
          <div key={i} className="border border-border bg-card rounded-xl p-6 space-y-6 shadow-sm">
            <div className="flex items-center gap-3">
              <Skeleton className="h-6 w-24 rounded-full" />
              <Skeleton className="h-5 w-48" />
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <Skeleton className="h-52 w-full rounded-xl" />
              <Skeleton className="h-52 w-full rounded-xl" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (!sections?.length) {
    return (
      <div className="text-center py-16 border-2 border-dashed border-border rounded-xl bg-card">
        <p className="text-muted-foreground">Aucune donnée disponible.</p>
      </div>
    );
  }

  return (
    <Accordion type="multiple" defaultValue={sections.map((s) => s.id)} className="space-y-3">
      {sections.map((section) => {
        const badgeClass = SECTION_COLORS[section.id] ?? "bg-primary/10 text-primary border-primary/20";
        const noteLabel = SECTION_NOTE_LABELS[section.id];

        return (
          <AccordionItem
            key={section.id}
            value={section.id}
            className="border border-border bg-card rounded-xl overflow-hidden shadow-sm data-[state=open]:shadow-md transition-shadow"
          >
            <AccordionTrigger className="px-6 py-4 hover:bg-muted/40 transition-colors">
              <div className="flex items-center gap-3">
                <Badge
                  variant="outline"
                  className={cn("font-mono text-xs font-bold tracking-wide border", badgeClass)}
                >
                  {section.id.toUpperCase()}
                </Badge>
                <span className="font-semibold text-base text-foreground">{section.name}</span>
              </div>
            </AccordionTrigger>

            <AccordionContent className="px-6 pb-8 pt-4 border-t border-border/50">
              {/* Cartes de référence */}
              <div className="space-y-8">
                {section.subsections.map((sub, idx) => (
                  <div key={idx} className="space-y-4">
                    <div className="flex items-center gap-2">
                      <div className="h-px flex-1 bg-border" />
                      <h4 className="text-xs font-bold text-muted-foreground uppercase tracking-widest whitespace-nowrap px-2">
                        {sub.label}
                      </h4>
                      <div className="h-px flex-1 bg-border" />
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                      {sub.charts.map((chart) => (
                        <ChartImage
                          key={chart.url}
                          url={chart.url}
                          label={chart.label}
                          description={chart.description}
                        />
                      ))}
                    </div>
                  </div>
                ))}
              </div>

              {/* Deux zones d'analyse côte à côte après les cartes */}
              {noteLabel && (
                <TwoColumnObservation
                  sectionId={section.id}
                  label={noteLabel}
                  sectionNotes={sectionNotes}
                  onChange={onNoteChange}
                  readOnly={readOnly}
                />
              )}
            </AccordionContent>
          </AccordionItem>
        );
      })}
    </Accordion>
  );
}
