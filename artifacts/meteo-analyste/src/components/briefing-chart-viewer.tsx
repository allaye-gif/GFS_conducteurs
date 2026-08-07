import React, { useState, useRef, useEffect } from "react";
import { BriefingSection } from "@workspace/api-client-react";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  ExternalLink, ImageOff, PenLine, Monitor, Upload, X, Plus,
  Pen, Circle, ArrowRight, Undo2, Check, Pencil, Type,
} from "lucide-react";

type BriefingSectionX = BriefingSection & {
  iframeAlternatives?: { label: string; url: string }[];
};

/* ── Proxy ─────────────────────────────────────────────────── */
function proxyUrl(raw: string): string {
  if (!raw) return raw;
  if (raw.startsWith("/api/")) return raw;
  if (raw.startsWith("data:")) return raw;
  return `/api/noaa/proxy?url=${encodeURIComponent(raw)}`;
}

/* ── AutoTextarea ──────────────────────────────────────────── */
function AutoTextarea({ noteKey, value, onChange, placeholder, readOnly }: {
  noteKey: string; value: string;
  onChange?: (key: string, val: string) => void;
  placeholder?: string; readOnly?: boolean;
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
      <div className="rounded-xl border border-border bg-muted/20 px-4 py-3 text-sm text-foreground whitespace-pre-wrap leading-relaxed min-h-[80px]">
        {value || <span className="text-muted-foreground/40 italic">—</span>}
      </div>
    );
  }
  return (
    <textarea
      ref={ref}
      value={value}
      onChange={(e) => onChange?.(noteKey, e.target.value)}
      placeholder={placeholder}
      rows={4}
      style={{ overflow: "hidden", resize: "none" }}
      className={cn(
        "w-full rounded-xl border border-border bg-background px-4 py-3 text-sm text-foreground",
        "placeholder:text-muted-foreground/40 focus:outline-none focus:ring-2 focus:ring-ring/30",
        "leading-relaxed min-h-[100px] transition-all"
      )}
    />
  );
}

/* ── Image Annotator ───────────────────────────────────────── */
type Pt = { x: number; y: number };
type AnnotTool = "arrow" | "ellipse" | "pen" | "text";
type Stroke =
  | { type: "arrow"; a: Pt; b: Pt; color: string }
  | { type: "ellipse"; a: Pt; b: Pt; color: string }
  | { type: "pen"; pts: Pt[]; color: string }
  | { type: "text"; pt: Pt; text: string; color: string; fontSize: number };

const COLORS = ["#ef4444", "#fbbf24", "#3b82f6", "#ffffff"];

function applyStroke(ctx: CanvasRenderingContext2D, s: Stroke) {
  ctx.save();
  ctx.strokeStyle = s.color;
  ctx.lineWidth = s.color === "#ffffff" ? 5 : 3;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (s.type === "arrow") {
    const { a, b } = s;
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 2) { ctx.restore(); return; }
    const head = Math.max(16, Math.min(40, len * 0.28));
    const angle = Math.atan2(dy, dx);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.lineWidth = (s.color === "#ffffff" ? 5 : 3);
    ctx.beginPath();
    ctx.moveTo(b.x, b.y);
    ctx.lineTo(b.x - head * Math.cos(angle - Math.PI / 6), b.y - head * Math.sin(angle - Math.PI / 6));
    ctx.moveTo(b.x, b.y);
    ctx.lineTo(b.x - head * Math.cos(angle + Math.PI / 6), b.y - head * Math.sin(angle + Math.PI / 6));
    ctx.stroke();
  } else if (s.type === "ellipse") {
    const cx = (s.a.x + s.b.x) / 2, cy = (s.a.y + s.b.y) / 2;
    const rx = Math.abs(s.b.x - s.a.x) / 2, ry = Math.abs(s.b.y - s.a.y) / 2;
    if (rx < 2 || ry < 2) { ctx.restore(); return; }
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    ctx.stroke();
  } else if (s.type === "pen" && s.pts.length > 1) {
    ctx.beginPath();
    ctx.moveTo(s.pts[0].x, s.pts[0].y);
    for (const p of s.pts) ctx.lineTo(p.x, p.y);
    ctx.stroke();
  } else if (s.type === "text") {
    ctx.fillStyle = s.color;
    ctx.font = `bold ${s.fontSize}px Arial`;
    ctx.shadowColor = "rgba(0,0,0,0.65)";
    ctx.shadowBlur = 4;
    ctx.fillText(s.text, s.pt.x, s.pt.y);
    ctx.shadowBlur = 0;
  }
  ctx.restore();
}

function ImageAnnotatorModal({ src, onSave, onClose }: {
  src: string;
  onSave: (dataUrl: string) => void;
  onClose: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const strokesRef = useRef<Stroke[]>([]);
  const isDown = useRef(false);
  const originRef = useRef<Pt>({ x: 0, y: 0 });
  const penPts = useRef<Pt[]>([]);
  const [tool, setTool] = useState<AnnotTool>("arrow");
  const [color, setColor] = useState("#ef4444");
  const [strokeCount, setStrokeCount] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [pendingText, setPendingText] = useState<{ pt: Pt; sx: number; sy: number; value: string } | null>(null);

  useEffect(() => {
    const img = new Image();
    img.onload = () => {
      imgRef.current = img;
      redrawAll([]);
      setLoaded(true);
    };
    img.onerror = () => setLoaded(true);
    img.src = src;
  }, [src]);

  function redrawAll(strokes: Stroke[], preview?: Stroke) {
    const canvas = canvasRef.current;
    const img = imgRef.current;
    if (!canvas || !img) return;
    if (canvas.width !== img.naturalWidth || canvas.height !== img.naturalHeight) {
      canvas.width = img.naturalWidth || 800;
      canvas.height = img.naturalHeight || 600;
    }
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0);
    strokes.forEach((s) => applyStroke(ctx, s));
    if (preview) applyStroke(ctx, preview);
  }

  function coords(e: React.MouseEvent<HTMLCanvasElement>): Pt {
    const canvas = canvasRef.current!;
    const r = canvas.getBoundingClientRect();
    return {
      x: (e.clientX - r.left) * (canvas.width / r.width),
      y: (e.clientY - r.top) * (canvas.height / r.height),
    };
  }

  function onMouseDown(e: React.MouseEvent<HTMLCanvasElement>) {
    if (tool === "text") {
      const p = coords(e);
      setPendingText({ pt: p, sx: e.clientX, sy: e.clientY, value: "" });
      return;
    }
    isDown.current = true;
    const p = coords(e);
    originRef.current = p;
    if (tool === "pen") penPts.current = [p];
  }

  function onMouseMove(e: React.MouseEvent<HTMLCanvasElement>) {
    if (!isDown.current) return;
    const p = coords(e);
    if (tool === "pen") {
      penPts.current = [...penPts.current, p];
      redrawAll(strokesRef.current, { type: "pen", pts: penPts.current, color });
    } else if (tool === "arrow") {
      redrawAll(strokesRef.current, { type: "arrow", a: originRef.current, b: p, color });
    } else if (tool === "ellipse") {
      redrawAll(strokesRef.current, { type: "ellipse", a: originRef.current, b: p, color });
    }
  }

  function onMouseUp(e: React.MouseEvent<HTMLCanvasElement>) {
    if (!isDown.current) return;
    isDown.current = false;
    const p = coords(e);
    let s: Stroke;
    if (tool === "pen") s = { type: "pen", pts: [...penPts.current, p], color };
    else if (tool === "arrow") s = { type: "arrow", a: originRef.current, b: p, color };
    else s = { type: "ellipse", a: originRef.current, b: p, color };
    strokesRef.current = [...strokesRef.current, s];
    setStrokeCount((c) => c + 1);
    redrawAll(strokesRef.current);
    penPts.current = [];
  }

  function commitPendingText() {
    if (!pendingText?.value.trim()) { setPendingText(null); return; }
    const canvas = canvasRef.current;
    const fontSize = canvas ? Math.round(canvas.width * 0.028) : 28;
    strokesRef.current = [...strokesRef.current, { type: "text", pt: pendingText.pt, text: pendingText.value.trim(), color, fontSize }];
    setStrokeCount((c) => c + 1);
    redrawAll(strokesRef.current);
    setPendingText(null);
  }

  function undo() {
    strokesRef.current = strokesRef.current.slice(0, -1);
    setStrokeCount((c) => Math.max(0, c - 1));
    redrawAll(strokesRef.current);
  }

  function save() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    onSave(canvas.toDataURL("image/png"));
    onClose();
  }

  const TOOLS: [AnnotTool, React.ReactNode, string][] = [
    ["arrow", <ArrowRight className="h-3.5 w-3.5" />, "Flèche"],
    ["ellipse", <Circle className="h-3.5 w-3.5" />, "Cercle"],
    ["pen", <Pen className="h-3.5 w-3.5" />, "Crayon"],
    ["text", <Type className="h-3.5 w-3.5" />, "Texte"],
  ];

  return (
    <div className="fixed inset-0 z-50 bg-black/85 flex items-center justify-center p-3">
      <div className="bg-background rounded-2xl overflow-hidden flex flex-col w-full max-w-5xl shadow-2xl border border-border" style={{ maxHeight: "96vh" }}>
        {/* Toolbar */}
        <div className="flex items-center gap-2 p-3 border-b border-border bg-card flex-wrap shrink-0">
          <span className="text-xs font-semibold text-muted-foreground">Outil :</span>
          {TOOLS.map(([t, icon, label]) => (
            <button
              key={t}
              onClick={() => setTool(t)}
              className={cn(
                "flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-lg border font-medium transition-colors",
                tool === t ? "bg-primary text-primary-foreground border-primary" : "border-border bg-background hover:bg-muted"
              )}
            >
              {icon} {label}
            </button>
          ))}
          <div className="h-4 w-px bg-border mx-1" />
          <span className="text-xs font-semibold text-muted-foreground">Couleur :</span>
          {COLORS.map((c) => (
            <button
              key={c}
              onClick={() => setColor(c)}
              title={c}
              className={cn(
                "w-6 h-6 rounded-full border-2 transition-all shrink-0",
                color === c ? "border-foreground scale-125 shadow" : "border-border hover:scale-110"
              )}
              style={{ background: c }}
            />
          ))}
          <div className="h-4 w-px bg-border mx-1" />
          <button
            onClick={undo}
            disabled={strokeCount === 0}
            className="flex items-center gap-1 px-2.5 py-1.5 text-xs rounded-lg border border-border bg-background hover:bg-muted disabled:opacity-40 font-medium"
          >
            <Undo2 className="h-3.5 w-3.5" /> Annuler
          </button>
          <div className="flex-1" />
          <button
            onClick={save}
            disabled={!loaded}
            className="flex items-center gap-1.5 px-4 py-1.5 text-xs rounded-lg bg-primary text-primary-foreground font-medium hover:bg-primary/90 disabled:opacity-50"
          >
            <Check className="h-3.5 w-3.5" /> Enregistrer
          </button>
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-xs rounded-lg border border-border bg-background hover:bg-muted font-medium"
          >
            Annuler
          </button>
        </div>

        {/* Canvas area */}
        <div className="flex-1 overflow-auto bg-zinc-900 flex items-center justify-center p-4 min-h-0 relative">
          {!loaded && (
            <div className="text-muted-foreground text-sm animate-pulse">Chargement de l'image…</div>
          )}
          <canvas
            ref={canvasRef}
            className={cn("max-w-full max-h-full rounded-lg shadow-xl object-contain", !loaded && "hidden")}
            style={{ cursor: tool === "text" ? "text" : "crosshair", touchAction: "none", display: loaded ? undefined : "none" }}
            onMouseDown={onMouseDown}
            onMouseMove={(e) => e.buttons === 1 && onMouseMove(e)}
            onMouseUp={onMouseUp}
            onMouseLeave={(e) => e.buttons === 1 && onMouseUp(e)}
          />
          {/* Overlay input pour l'outil texte */}
          {pendingText && (
            <div
              className="fixed z-[200] flex items-center gap-1"
              style={{ left: pendingText.sx, top: pendingText.sy, transform: "translate(-4px, -50%)" }}
            >
              <input
                autoFocus
                value={pendingText.value}
                onChange={(e) => setPendingText((prev) => prev ? { ...prev, value: e.target.value } : null)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") { e.preventDefault(); commitPendingText(); }
                  if (e.key === "Escape") { e.preventDefault(); setPendingText(null); }
                }}
                onBlur={commitPendingText}
                placeholder="Texte… (Entrée)"
                className="bg-black/80 text-white text-sm px-2 py-1 rounded border border-white/40 outline-none min-w-[160px] max-w-[320px]"
                style={{ color: pendingText.value ? color : undefined }}
              />
              <button
                onMouseDown={(e) => { e.preventDefault(); commitPendingText(); }}
                className="bg-primary text-primary-foreground rounded px-2 py-1 text-xs font-medium"
              >✓</button>
            </div>
          )}
        </div>

        <p className="text-[10px] text-muted-foreground/50 text-center py-1.5 shrink-0">
          Flèche · Cercle · Crayon · Texte (clic pour placer) · Blanc pour effacer
        </p>
      </div>
    </div>
  );
}

/* ── BriefingImageCard ─────────────────────────────────────── */
function BriefingImageCard({
  id, label, url, description, sectionNotes, onNoteChange, readOnly,
}: {
  id: string; label: string; url: string; description?: string | null;
  sectionNotes?: Record<string, string>;
  onNoteChange?: (key: string, val: string) => void;
  readOnly?: boolean;
}) {
  const [status, setStatus] = useState<"loading" | "ok" | "error">("loading");
  const [annotating, setAnnotating] = useState(false);
  const annKey = `__ann__${id}`;
  const annotated = sectionNotes?.[annKey];
  const displaySrc = annotated || proxyUrl(url);

  return (
    <div className="flex flex-col gap-1 group/card">
      {description && <p className="text-xs text-muted-foreground/60 italic">{description}</p>}
      <div className={cn("relative rounded-xl overflow-hidden border border-border bg-muted/20", status !== "ok" && !annotated && "min-h-[180px]")}>
        {!annotated && status === "loading" && <Skeleton className="absolute inset-0 h-full w-full rounded-xl" />}
        {!annotated && status === "error" && (
          <div className="flex flex-col items-center justify-center gap-2 p-8 text-muted-foreground/40 min-h-[140px]">
            <ImageOff className="h-7 w-7" />
            <p className="text-xs">Carte indisponible</p>
          </div>
        )}
        <img
          id={id}
          src={displaySrc}
          alt={label}
          className={cn(
            "w-full object-contain transition-opacity",
            (!annotated && status !== "ok") ? "opacity-0 absolute inset-0 h-0" : "opacity-100"
          )}
          onLoad={() => setStatus("ok")}
          onError={() => setStatus("error")}
        />
        {/* Label produit — overlay top-left */}
        {label && (
          <div className="absolute top-2 left-2 z-10 bg-black/60 text-white text-[10px] font-bold px-2 py-[2px] rounded backdrop-blur-sm pointer-events-none leading-4 max-w-[75%] truncate">
            {label}
          </div>
        )}
        {/* Bouton Annoter — top-right, visible au hover */}
        {!readOnly && (status === "ok" || annotated) && !annotated && (
          <button
            onClick={() => setAnnotating(true)}
            className="absolute top-2 right-2 z-10 flex items-center gap-1 text-[10px] text-white/80 hover:text-white bg-black/40 hover:bg-black/65 rounded px-1.5 py-[2px] opacity-0 group-hover/card:opacity-100 transition-all backdrop-blur-sm"
          >
            <Pencil className="h-3 w-3" /> Annoter
          </button>
        )}
        {annotated && !readOnly && (
          <button
            type="button"
            onClick={() => { onNoteChange?.(annKey, ""); setStatus("loading"); }}
            className="absolute top-2 right-2 z-10 bg-background/90 backdrop-blur rounded-full p-1.5 text-muted-foreground hover:text-destructive border border-border opacity-0 group-hover/card:opacity-100 transition-opacity shadow-sm"
            title="Supprimer l'annotation"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {annotating && (
        <ImageAnnotatorModal
          src={displaySrc}
          onSave={(dataUrl) => { onNoteChange?.(annKey, dataUrl); }}
          onClose={() => setAnnotating(false)}
        />
      )}
    </div>
  );
}

/* ── ImageUploadZone ───────────────────────────────────────── */
function ImageUploadZone({
  noteKey, label, value, onChange, readOnly, onRemoveZone, onLabelChange,
}: {
  noteKey: string; label: string; value: string;
  onChange?: (key: string, val: string) => void;
  readOnly?: boolean;
  onRemoveZone?: () => void;
  onLabelChange?: (val: string) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [annotating, setAnnotating] = useState(false);
  const pasteHandlerRef = useRef<((e: ClipboardEvent) => void) | null>(null);

  function loadFile(file: File) {
    const reader = new FileReader();
    reader.onload = (e) => onChange?.(noteKey, e.target?.result as string);
    reader.readAsDataURL(file);
  }

  useEffect(() => {
    return () => {
      if (pasteHandlerRef.current) {
        document.removeEventListener("paste", pasteHandlerRef.current);
      }
    };
  }, []);

  function onMouseEnter() {
    if (pasteHandlerRef.current) {
      document.removeEventListener("paste", pasteHandlerRef.current);
    }
    const handler = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (let i = 0; i < items.length; i++) {
        if (items[i].type.startsWith("image/")) {
          const file = items[i].getAsFile();
          if (file) { loadFile(file); e.preventDefault(); return; }
        }
      }
    };
    pasteHandlerRef.current = handler;
    document.addEventListener("paste", handler);
  }

  function onMouseLeave() {
    if (pasteHandlerRef.current) {
      document.removeEventListener("paste", pasteHandlerRef.current);
      pasteHandlerRef.current = null;
    }
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file?.type.startsWith("image/")) loadFile(file);
  }

  if (readOnly) {
    return (
      <div className="flex flex-col gap-1.5">
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
        {value ? (
          <img src={value} alt={label} className="w-full rounded-xl border border-border object-contain max-h-96" />
        ) : (
          <div className="rounded-xl border border-border bg-muted/20 flex items-center justify-center min-h-[120px]">
            <p className="text-xs text-muted-foreground/40 italic">Aucune image</p>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1.5 group/up">
      <div className="flex items-center justify-between gap-2">
        {onLabelChange ? (
          <input
            value={label}
            onChange={(e) => onLabelChange(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            placeholder="Nom de la capture…"
            className="text-xs font-medium text-muted-foreground bg-transparent border-b border-dashed border-muted-foreground/30 outline-none focus:border-primary focus:text-foreground flex-1 min-w-0 py-0.5 transition-colors"
          />
        ) : (
          <p className="text-xs font-medium text-muted-foreground truncate flex-1">{label}</p>
        )}
        <div className="flex items-center gap-2 opacity-0 group-hover/up:opacity-100 transition-opacity shrink-0">
          {value && (
            <button
              onClick={() => setAnnotating(true)}
              className="flex items-center gap-1 text-[10px] text-muted-foreground/50 hover:text-primary transition-colors"
            >
              <Pencil className="h-3 w-3" /> Annoter
            </button>
          )}
          {onRemoveZone && (
            <button
              type="button"
              onClick={onRemoveZone}
              className="flex items-center gap-1 text-[10px] text-muted-foreground/40 hover:text-destructive transition-colors"
              title="Supprimer cette zone"
            >
              <X className="h-3 w-3" /> Supprimer la zone
            </button>
          )}
        </div>
      </div>
      <div
        className={cn(
          "relative rounded-xl border-2 border-dashed transition-all outline-none",
          dragging ? "border-primary bg-primary/5 scale-[1.01]" :
          value ? "border-border bg-transparent" :
          "border-muted-foreground/25 hover:border-muted-foreground/50 bg-muted/10 cursor-pointer"
        )}
        tabIndex={0}
        onDrop={handleDrop}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
        onClick={() => !value && fileRef.current?.click()}
        onKeyDown={(e) => e.key === "Enter" && !value && fileRef.current?.click()}
      >
        {value ? (
          <div className="relative group/img">
            <img src={value} alt={label} className="w-full rounded-xl object-contain max-h-96" />
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onChange?.(noteKey, ""); }}
              className="absolute top-2 right-2 bg-background/90 backdrop-blur rounded-full p-1.5 text-muted-foreground hover:text-destructive border border-border opacity-0 group-hover/img:opacity-100 transition-opacity shadow-sm"
              title="Supprimer"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center gap-2.5 p-8 min-h-[130px] text-muted-foreground/50 select-none">
            <Upload className="h-6 w-6" />
            <div className="text-center">
              <p className="text-xs font-medium">Glisser-déposer · Survoler + Ctrl+V</p>
              <p className="text-[10px] mt-0.5 text-muted-foreground/40">ou cliquer pour charger depuis le disque</p>
            </div>
          </div>
        )}
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="sr-only"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) loadFile(file);
            e.target.value = "";
          }}
        />
      </div>

      {annotating && value && (
        <ImageAnnotatorModal
          src={value}
          onSave={(dataUrl) => onChange?.(noteKey, dataUrl)}
          onClose={() => setAnnotating(false)}
        />
      )}
    </div>
  );
}

/* ── Extra upload zones per section ────────────────────────── */
function ExtraUploads({
  sectionId, sectionNotes, onNoteChange, readOnly,
}: {
  sectionId: string;
  sectionNotes: Record<string, string>;
  onNoteChange?: (key: string, val: string) => void;
  readOnly?: boolean;
}) {
  const countKey = `__extra_count__${sectionId}`;
  const count = parseInt(sectionNotes[countKey] ?? "0", 10);

  function addSlot() {
    onNoteChange?.(countKey, String(count + 1));
  }

  function removeSlot(m: number) {
    for (let i = m; i < count - 1; i++) {
      const curr = `__img__extra__${sectionId}__${i}`;
      const next = `__img__extra__${sectionId}__${i + 1}`;
      onNoteChange?.(curr, sectionNotes[next] ?? "");
    }
    onNoteChange?.(`__img__extra__${sectionId}__${count - 1}`, "");
    onNoteChange?.(countKey, String(count - 1));
  }

  if (count === 0 && readOnly) return null;

  return (
    <div className="space-y-3">
      {count > 0 && (
        <div className="grid gap-3 grid-cols-2">
          {Array.from({ length: count }).map((_, n) => {
            const imgKey = `__img__extra__${sectionId}__${n}`;
            const lblKey = `__extra_lbl__${sectionId}__${n}`;
            const lbl = sectionNotes[lblKey] || `Capture ${n + 1}`;
            return (
              <ImageUploadZone
                key={n}
                noteKey={imgKey}
                label={lbl}
                value={sectionNotes[imgKey] ?? ""}
                onChange={onNoteChange}
                readOnly={readOnly}
                onLabelChange={readOnly ? undefined : (val) => onNoteChange?.(lblKey, val)}
                onRemoveZone={readOnly ? undefined : () => removeSlot(n)}
              />
            );
          })}
        </div>
      )}
      {!readOnly && (
        <button
          type="button"
          onClick={addSlot}
          className="flex items-center gap-1.5 text-xs text-muted-foreground/50 hover:text-primary transition-colors mt-1"
        >
          <Plus className="h-3.5 w-3.5" />
          Ajouter une capture
        </button>
      )}
    </div>
  );
}

/* ── gridClass ─────────────────────────────────────────────── */
function gridClass(count: number): string {
  return count === 1 ? "grid-cols-1" : "grid-cols-2";
}

/* ── ImageCrop ─────────────────────────────────────────────── */
/**
 * Affiche une région rectangulaire d'une image via background-image CSS.
 * cropL/cropT : coin haut-gauche de la zone (fraction 0–1 de l'image naturelle)
 * cropW/cropH : largeur/hauteur de la zone (fraction 0–1)
 *
 * Technique : background-size + background-position sur un div avec padding-top
 * pour l'aspect-ratio. Évite toute dépendance sur overflow:hidden d'enfants abs.
 *
 * background-position formula :
 *   posX% = cropL / (1 - cropW) × 100
 *   posY% = cropT / (1 - cropH) × 100
 * (déduit de : posX/100 × (containerW - bgW) = -cropL × bgW/cropW × containerW)
 */
function ImageCrop({
  id, label, url, description, sectionNotes, readOnly,
  cropL, cropT, cropW, cropH, cropNote,
}: {
  id: string; label: string; url: string; description?: string | null;
  sectionNotes?: Record<string, string>;
  onNoteChange?: (key: string, val: string) => void;
  readOnly?: boolean;
  cropL: number; cropT: number; cropW: number; cropH: number;
  cropNote?: string;
}) {
  const [naturalAr, setNaturalAr] = useState<number | null>(null);
  const [status, setStatus] = useState<"loading" | "ok" | "error">("loading");
  const annKey = `__ann__${id}`;
  const annotated = sectionNotes?.[annKey];
  const imgSrc = annotated || proxyUrl(url);

  // Aspect ratio of the visible crop region (width/height)
  const containerAr = naturalAr != null
    ? (cropW * naturalAr) / cropH
    : cropW / cropH;          // approx avant chargement

  // padding-top trick : donne une hauteur définie = width / containerAr
  const paddingTopPct = (1 / containerAr) * 100;

  // background-size : agrandir l'image pour que cropW remplisse toute la largeur
  const bgSizeW = (1 / cropW) * 100; // %

  // background-position en % : formule exacte derivée du spec CSS
  // posX% : le point X% de l'image s'aligne avec le point X% du conteneur
  // Résolution : posX = cropL / (1 - cropW) × 100
  // Résolution : posY = cropT / (1 - cropH) × 100
  const bgPosX = cropW >= 1 ? 0 : (cropL / (1 - cropW)) * 100;
  const bgPosY = cropH >= 1 ? 0 : (cropT / (1 - cropH)) * 100;

  return (
    <div className="flex flex-col gap-1">
      {description && <p className="text-xs text-muted-foreground/60 italic">{description}</p>}
      {/* Outer wrapper : padding-top fixe la hauteur proportionnellement à la largeur */}
      <div
        className="rounded-xl border border-border bg-muted/20"
        style={{ position: "relative", width: "100%", paddingTop: `${paddingTopPct}%` }}
      >
        {/* Couche de contenu : remplit exactement le wrapper */}
        <div className="absolute inset-0 rounded-xl overflow-hidden">
          {status === "loading" && <Skeleton className="h-full w-full rounded-xl" />}
          {status === "error" && (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground/40">
              <ImageOff className="h-6 w-6" />
              <p className="text-xs">Carte indisponible</p>
            </div>
          )}
          {status === "ok" && (
            <div
              className="absolute inset-0"
              style={{
                backgroundImage: `url('${imgSrc}')`,
                backgroundSize: `${bgSizeW}% auto`,
                backgroundPosition: `${bgPosX}% ${bgPosY}%`,
                backgroundRepeat: "no-repeat",
              }}
            />
          )}
          {/* Label produit overlay — top-left */}
          {label && status === "ok" && (
            <div className="absolute top-2 left-2 z-10 bg-black/60 text-white text-[10px] font-bold px-2 py-[2px] rounded backdrop-blur-sm pointer-events-none leading-4 max-w-[75%] truncate">
              {label}
            </div>
          )}
        </div>
        {/* img caché : détection dimensions naturelles + événement de chargement */}
        <img
          src={imgSrc}
          alt=""
          style={{ display: "none", position: "absolute" }}
          onLoad={(e) => {
            const img = e.currentTarget;
            setNaturalAr(img.naturalWidth / img.naturalHeight);
            setStatus("ok");
          }}
          onError={() => setStatus("error")}
        />
      </div>
      {cropNote && !readOnly && (
        <p className="text-[10px] text-muted-foreground/40 italic">{cropNote}</p>
      )}
    </div>
  );
}

/* ── MisvaTopRightCrop ─────────────────────────────────────── */
/**
 * Affiche uniquement le quadrant haut-droit d'une image composite 2×2.
 * Utilisé pour l'image MISVA LowLev-Diag (Monsoon Equivalent Water Depth).
 * Technique : scale(2) ancré en haut-droit → le conteneur overflow:hidden
 * révèle exactement le quart supérieur-droit de l'image originale.
 */
function MisvaTopRightCrop({
  id, label, url, description, sectionNotes, onNoteChange, readOnly,
}: {
  id: string; label: string; url: string; description?: string | null;
  sectionNotes?: Record<string, string>;
  onNoteChange?: (key: string, val: string) => void;
  readOnly?: boolean;
}) {
  const [ar, setAr] = useState<number | null>(null);
  const [status, setStatus] = useState<"loading" | "ok" | "error">("loading");
  const annKey = `__ann__${id}`;
  const annotated = sectionNotes?.[annKey];
  const src = proxyUrl(url);

  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      {description && <p className="text-xs text-muted-foreground/60 italic">{description}</p>}
      <div
        className="rounded-xl overflow-hidden border border-border bg-muted/20"
        style={{ width: "100%", aspectRatio: ar ?? 2 }}
      >
        {status === "loading" && <Skeleton className="h-full w-full rounded-xl" />}
        {status === "error" && (
          <div className="flex flex-col items-center justify-center gap-2 p-8 text-muted-foreground/40 min-h-[100px]">
            <ImageOff className="h-6 w-6" />
            <p className="text-xs">Carte indisponible</p>
          </div>
        )}
        {status !== "error" && (
          <img
            src={annotated || src}
            alt={label}
            style={{
              display: "block",
              width: "100%",
              transform: "scale(2)",
              transformOrigin: "top right",
              imageRendering: "crisp-edges",
            }}
            onLoad={(e) => {
              const img = e.currentTarget;
              setAr(img.naturalWidth / img.naturalHeight);
              setStatus("ok");
            }}
            onError={() => setStatus("error")}
          />
        )}
      </div>
      {!readOnly && !annotated && (
        <p className="text-[10px] text-muted-foreground/40 italic">
          Quadrant haut-droit — Monsoon Equivalent Water Depth (950-600 hPa)
        </p>
      )}
    </div>
  );
}

/* ── Images section ────────────────────────────────────────── */
/* ── SynergiePicker ────────────────────────────────────────── */
// Affiche directement tous les champs Synergie disponibles, sans zone de
// sélection — l'ancien picker ("Choisir les champs") obligeait a cocher
// chaque champ un par un avant de rien voir, juge inutile.
function SynergiePicker({
  section, sectionNotes, onNoteChange, readOnly,
}: {
  section: BriefingSection;
  sectionNotes: Record<string, string>;
  onNoteChange?: (key: string, val: string) => void;
  readOnly?: boolean;
}) {
  const allCharts = section.subsections.flatMap((s) => s.charts);

  if (allCharts.length === 0) {
    return (
      <div className="py-4 text-center text-sm text-muted-foreground/60 italic">
        Aucun fichier disponible sur SYABAN02.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className={cn("grid gap-3", gridClass(allCharts.length))}>
        {allCharts.map((chart) => (
          <BriefingImageCard key={chart.id} {...chart}
            sectionNotes={sectionNotes} onNoteChange={onNoteChange} readOnly={readOnly} />
        ))}
      </div>
      <ExtraUploads sectionId={section.id} sectionNotes={sectionNotes}
        onNoteChange={onNoteChange} readOnly={readOnly} />
    </div>
  );
}

function ImagesContent({
  section, sectionNotes, onNoteChange, readOnly,
}: {
  section: BriefingSection;
  sectionNotes: Record<string, string>;
  onNoteChange?: (key: string, val: string) => void;
  readOnly?: boolean;
}) {
  if (section.subsections.length === 0 || section.subsections.every((s) => s.charts.length === 0)) {
    return (
      <div className="py-4 text-center text-sm text-muted-foreground/60 italic">
        Aucune carte disponible pour ce cycle.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {section.subsections.map((sub, si) => (
        <div key={si} className="space-y-3">
          <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground/70">{sub.label}</p>
          <div className={cn("grid gap-3", gridClass(sub.charts.length))}>
            {sub.charts.map((chart) => {
              if (section.id === "misva-lowlev") {
                return (
                  <MisvaTopRightCrop
                    key={chart.id}
                    {...chart}
                    sectionNotes={sectionNotes}
                    onNoteChange={onNoteChange}
                    readOnly={readOnly}
                  />
                );
              }
              if (section.id === "misva-pw") {
                // Composite gauche=champ / droite=anomalie → afficher droite uniquement
                return (
                  <ImageCrop
                    key={chart.id}
                    {...chart}
                    cropL={0.5} cropT={0} cropW={0.5} cropH={1}
                    cropNote="Anomalie PW — panneau droit de l'image composite"
                    sectionNotes={sectionNotes}
                    onNoteChange={onNoteChange}
                    readOnly={readOnly}
                  />
                );
              }
              if (section.id === "pluie-ecmwf") {
                // Zoom Afrique de l'Ouest — carte centrée sur Mali/Sahel
                // opencharts_africa : -40°W→70°E, -40°S→45°N
                // cropL=0.22 → -18°W (côte Sénégal) ; cropW=0.42 → fin à 28°E
                // cropT=0.06 ; cropH=0.50 → de ~38°N jusqu'à ~2°S
                // Légende (barre couleurs + MSLP) = div CSS background bottom
                const legUrl = proxyUrl(chart.url);
                return (
                  <div key={chart.id} className="flex flex-col gap-0">
                    <ImageCrop
                      id={chart.id}
                      label={chart.label}
                      url={chart.url}
                      description={chart.description}
                      cropL={0.22} cropT={0.06} cropW={0.42} cropH={0.50}
                      sectionNotes={sectionNotes}
                      onNoteChange={onNoteChange}
                      readOnly={readOnly}
                    />
                    {/* Bande légende : montre le bas de l'image (barre couleurs + MSLP) */}
                    {chart.url && (
                      <div
                        className="w-full rounded-b-xl border border-t-0 border-border bg-white overflow-hidden"
                        style={{
                          height: 72,
                          backgroundImage: `url('${legUrl}')`,
                          backgroundPosition: "center bottom",
                          backgroundRepeat: "no-repeat",
                          backgroundSize: "100% auto",
                        }}
                      />
                    )}
                  </div>
                );
              }
              return (
                <BriefingImageCard
                  key={chart.id}
                  {...chart}
                  sectionNotes={sectionNotes}
                  onNoteChange={onNoteChange}
                  readOnly={readOnly}
                />
              );
            })}
          </div>
        </div>
      ))}
      <ExtraUploads
        sectionId={section.id}
        sectionNotes={sectionNotes}
        onNoteChange={onNoteChange}
        readOnly={readOnly}
      />
    </div>
  );
}

/* ── Upload section ────────────────────────────────────────── */
function UploadContent({
  section, sectionNotes, onNoteChange, readOnly,
}: {
  section: BriefingSection;
  sectionNotes: Record<string, string>;
  onNoteChange?: (key: string, val: string) => void;
  readOnly?: boolean;
}) {
  if (section.subsections.length === 0) return (
    <ExtraUploads sectionId={section.id} sectionNotes={sectionNotes} onNoteChange={onNoteChange} readOnly={readOnly} />
  );

  return (
    <div className="space-y-6">
      {section.subsections.map((sub, si) => (
        <div key={si} className="space-y-3">
          <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground/70">{sub.label}</p>
          <div className={cn("grid gap-3", gridClass(sub.charts.length))}>
            {sub.charts.map((chart) => {
              const imgKey = `__img__${chart.id}`;
              return (
                <ImageUploadZone
                  key={chart.id}
                  noteKey={imgKey}
                  label={chart.label}
                  value={sectionNotes[imgKey] ?? ""}
                  onChange={onNoteChange}
                  readOnly={readOnly}
                />
              );
            })}
          </div>
        </div>
      ))}
      <ExtraUploads
        sectionId={section.id}
        sectionNotes={sectionNotes}
        onNoteChange={onNoteChange}
        readOnly={readOnly}
      />
    </div>
  );
}

/* ── Iframe section ────────────────────────────────────────── */
function IframeWithTabs({
  section, sectionNotes, onNoteChange, readOnly,
}: {
  section: BriefingSectionX;
  sectionNotes: Record<string, string>;
  onNoteChange?: (key: string, val: string) => void;
  readOnly?: boolean;
}) {
  const alts = section.iframeAlternatives;
  const defaultUrl = alts?.[0]?.url ?? section.iframeUrl ?? "";
  const [activeUrl, setActiveUrl] = useState(defaultUrl);

  if (!activeUrl && !section.iframeUrl) return null;

  const url = activeUrl || section.iframeUrl || "";

  return (
    <div className="space-y-3">
      {alts && alts.length > 1 && (
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-muted-foreground flex items-center gap-1.5">
            <Monitor className="h-3.5 w-3.5" /> Modèle :
          </span>
          {alts.map((alt) => (
            <button
              key={alt.label}
              type="button"
              onClick={() => setActiveUrl(alt.url)}
              className={cn(
                "px-3 py-1 text-xs rounded-lg border transition-colors font-medium",
                activeUrl === alt.url
                  ? "bg-primary text-primary-foreground border-primary"
                  : "border-border bg-background hover:bg-muted text-foreground"
              )}
            >{alt.label}</button>
          ))}
        </div>
      )}
      {!alts && (
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Monitor className="h-3.5 w-3.5" />
            <span>Vue intégrée — live</span>
          </div>
          {section.externalUrl && (
            <a
              href={(section as any).externalUrl}
              target="_blank" rel="noopener noreferrer"
              className="flex items-center gap-1.5 text-xs text-primary hover:underline font-medium"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              {(section as any).externalLabel ?? "Ouvrir en plein écran"}
            </a>
          )}
        </div>
      )}
      <div className="rounded-xl overflow-hidden border border-border bg-muted/10" style={{ height: 520 }}>
        <iframe
          key={url}
          src={url}
          title={section.name}
          className="w-full h-full border-0"
          loading="lazy"
          allowFullScreen
          allow="geolocation; fullscreen"
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads allow-presentation"
        />
      </div>
      <ExtraUploads
        sectionId={section.id}
        sectionNotes={sectionNotes}
        onNoteChange={onNoteChange}
        readOnly={readOnly}
      />
    </div>
  );
}

/* ── External link section ─────────────────────────────────── */
function ExternalContent({
  section, sectionNotes, onNoteChange, readOnly,
}: {
  section: BriefingSection;
  sectionNotes: Record<string, string>;
  onNoteChange?: (key: string, val: string) => void;
  readOnly?: boolean;
}) {
  return (
    <div className="space-y-4">
      <div className="py-4 flex flex-col items-center gap-4 text-center">
        <div className="w-12 h-12 rounded-full bg-muted/40 flex items-center justify-center">
          <ExternalLink className="h-5 w-5 text-muted-foreground" />
        </div>
        <p className="text-sm text-muted-foreground max-w-sm">
          {section.externalDescription ?? "Ce produit est accessible via un portail externe."}
        </p>
        {section.externalUrl && (
          <Button variant="outline" size="sm" asChild>
            <a href={section.externalUrl} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2">
              <ExternalLink className="h-4 w-4" />
              {section.externalLabel ?? "Ouvrir"}
            </a>
          </Button>
        )}
      </div>
      <ExtraUploads
        sectionId={section.id}
        sectionNotes={sectionNotes}
        onNoteChange={onNoteChange}
        readOnly={readOnly}
      />
    </div>
  );
}

/* ── Insert section separator ─────────────────────────────── */
function InsertSectionButton({ onInsert }: { onInsert: () => void }) {
  return (
    <button
      type="button"
      onClick={onInsert}
      className="w-full flex items-center gap-0 py-0.5 group/ins focus-visible:outline-none"
    >
      <div className="flex-1 h-px bg-muted-foreground/15 group-hover/ins:bg-primary/35 transition-colors" />
      <span className={cn(
        "flex items-center gap-1 text-[10px] font-medium px-3 py-0.5 rounded-full mx-1.5 shrink-0",
        "text-muted-foreground/35 group-hover/ins:text-primary transition-all duration-150",
        "border border-transparent group-hover/ins:border-primary/25 group-hover/ins:bg-primary/5"
      )}>
        <Plus className="h-2.5 w-2.5" />
        insérer une section
      </span>
      <div className="flex-1 h-px bg-muted-foreground/15 group-hover/ins:bg-primary/35 transition-colors" />
    </button>
  );
}

/* ── Custom section item ───────────────────────────────────── */
function CustomSectionItem({
  idx, sectionNotes, onNoteChange, readOnly, onDelete,
}: {
  idx: number;
  sectionNotes: Record<string, string>;
  onNoteChange?: (key: string, val: string) => void;
  readOnly?: boolean;
  onDelete?: () => void;
}) {
  const nameKey = `__custom_${idx}_name__`;
  const noteKey = `__custom_${idx}_note__`;
  const imgCountKey = `__custom_${idx}_img_count__`;
  const sectionId = `__custom_${idx}__`;

  const name = sectionNotes[nameKey] ?? "";
  const note = sectionNotes[noteKey] ?? "";
  const imgCount = parseInt(sectionNotes[imgCountKey] ?? "0", 10);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!readOnly && name === "") nameRef.current?.focus();
  }, []);

  return (
    <AccordionItem
      value={sectionId}
      className="rounded-2xl border border-dashed border-primary/40 bg-card overflow-hidden shadow-sm"
    >
      <AccordionTrigger className="px-6 py-4 hover:no-underline [&[data-state=open]>svg]:rotate-180">
        <div className="flex items-center gap-3 flex-1 min-w-0 text-left">
          {readOnly ? (
            <span className="font-semibold text-sm text-foreground leading-tight">
              {name || "Section personnalisée"}
            </span>
          ) : (
            <input
              ref={nameRef}
              value={name}
              onChange={(e) => onNoteChange?.(nameKey, e.target.value)}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => e.stopPropagation()}
              placeholder="Nom de la section (ex: Vent à 10m)…"
              className={cn(
                "font-semibold text-sm bg-transparent border-0 border-b border-dashed min-w-0 flex-1 max-w-xs",
                "border-muted-foreground/30 focus:border-primary focus:outline-none px-0 leading-tight",
                "placeholder:font-normal placeholder:text-muted-foreground/40"
              )}
            />
          )}
          <Badge variant="outline" className="text-[10px] px-1.5 py-0 text-primary/70 border-primary/30 shrink-0">
            Personnalisé
          </Badge>
          {!readOnly && note.trim() && <PenLine className="h-3.5 w-3.5 text-primary/70 shrink-0" />}
          {!readOnly && imgCount > 0 && <Upload className="h-3.5 w-3.5 text-primary/70 shrink-0" />}
        </div>
      </AccordionTrigger>

      <AccordionContent className="px-6 pb-6 pt-2">
        <div className="space-y-5">
          {imgCount > 0 && (
            <div className={cn("grid gap-3", imgCount === 1 ? "grid-cols-1" : "grid-cols-2")}>
              {Array.from({ length: imgCount }, (_, m) => {
                const imgKey = `__custom_${idx}_img_${m}__`;
                function removeZone() {
                  for (let i = m; i < imgCount - 1; i++) {
                    const curr = `__custom_${idx}_img_${i}__`;
                    const next = `__custom_${idx}_img_${i + 1}__`;
                    onNoteChange?.(curr, sectionNotes[next] ?? "");
                  }
                  onNoteChange?.(`__custom_${idx}_img_${imgCount - 1}__`, "");
                  onNoteChange?.(imgCountKey, String(imgCount - 1));
                }
                return (
                  <ImageUploadZone
                    key={m}
                    noteKey={imgKey}
                    label={`Image ${m + 1}`}
                    value={sectionNotes[imgKey] ?? ""}
                    onChange={onNoteChange}
                    readOnly={readOnly}
                    onRemoveZone={readOnly ? undefined : removeZone}
                  />
                );
              })}
            </div>
          )}

          {!readOnly && (
            <button
              type="button"
              onClick={() => onNoteChange?.(imgCountKey, String(imgCount + 1))}
              className="flex items-center gap-1.5 text-xs text-muted-foreground/50 hover:text-primary transition-colors"
            >
              <Plus className="h-3.5 w-3.5" /> Ajouter une image
            </button>
          )}

          <div className="space-y-2 pt-2 border-t border-border">
            <label className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
              <PenLine className="h-3.5 w-3.5" />
              Observations / Analyse
            </label>
            <AutoTextarea
              noteKey={noteKey}
              value={note}
              onChange={onNoteChange}
              placeholder={`Notes d'analyse pour "${name || "cette section"}"…`}
              readOnly={readOnly}
            />
          </div>

          {!readOnly && onDelete && (
            <button
              type="button"
              onClick={onDelete}
              className="flex items-center gap-1.5 text-xs text-destructive/50 hover:text-destructive transition-colors mt-1"
            >
              <X className="h-3.5 w-3.5" /> Supprimer cette section
            </button>
          )}
        </div>
      </AccordionContent>
    </AccordionItem>
  );
}

/* ── BriefingChartViewer ───────────────────────────────────── */
export function BriefingChartViewer({
  sections,
  sectionNotes,
  onNoteChange,
  readOnly = false,
}: {
  sections: BriefingSection[];
  sectionNotes: Record<string, string>;
  onNoteChange?: (key: string, val: string) => void;
  readOnly?: boolean;
}) {
  const [openItems, setOpenItems] = useState<string[]>(sections.slice(0, 3).map((s) => s.id));

  // ── Order list ─────────────────────────────────────────────
  // "__order__" stores the full interleaved sequence as comma-separated IDs.
  // Predefined sections use their catalog ID; custom sections use "custom:N".
  // Falls back to predefined-first + existing custom sections when not yet set.
  const customCount = parseInt(sectionNotes["__custom_count__"] ?? "0", 10);
  const sectionsById = React.useMemo(
    () => Object.fromEntries(sections.map((s) => [s.id, s])),
    [sections]
  );

  const order: string[] = React.useMemo(() => {
    const predefinedIds = sections.map((s) => s.id);
    const customIds = Array.from({ length: customCount }, (_, n) => `custom:${n}`);
    const currentIds = [...predefinedIds, ...customIds];
    const stored = sectionNotes["__order__"];
    if (!stored) return currentIds;

    // Drop stale IDs no longer in the catalog (e.g. a since-removed/renamed
    // section). Any predefined ID missing from the stored order — e.g. a
    // catalog change like splitting one section into several, whose new IDs
    // were never part of an order saved before they existed — is reinserted
    // next to its nearest surviving catalog neighbour, so it reappears where
    // the catalog places it instead of getting silently dropped or dumped at
    // the very end where nobody would notice it.
    const currentIdSet = new Set(currentIds);
    const kept = stored.split(",").filter((id) => currentIdSet.has(id));
    const keptSet = new Set(kept);
    const result = [...kept];
    for (const id of predefinedIds) {
      if (keptSet.has(id)) continue;
      const catIdx = predefinedIds.indexOf(id);
      let insertPos = -1;
      for (let i = catIdx - 1; i >= 0; i--) {
        const p = result.indexOf(predefinedIds[i]);
        if (p !== -1) { insertPos = p + 1; break; }
      }
      if (insertPos === -1) {
        for (let i = catIdx + 1; i < predefinedIds.length; i++) {
          const p = result.indexOf(predefinedIds[i]);
          if (p !== -1) { insertPos = p; break; }
        }
      }
      result.splice(insertPos === -1 ? result.length : insertPos, 0, id);
    }
    for (const id of customIds) {
      if (!keptSet.has(id)) result.push(id);
    }
    return result;
  }, [sectionNotes, sections, customCount]);

  // ── Insert at any position ──────────────────────────────────
  function insertAt(pos: number) {
    const n = customCount;
    const newOrder = [...order.slice(0, pos), `custom:${n}`, ...order.slice(pos)];
    onNoteChange?.(`__custom_${n}_name__`, "");
    onNoteChange?.(`__custom_${n}_note__`, "");
    onNoteChange?.(`__custom_${n}_img_count__`, "2");
    onNoteChange?.("__custom_count__", String(n + 1));
    onNoteChange?.("__order__", newOrder.join(","));
    setOpenItems((prev) => [...prev, `__custom_${n}__`]);
  }

  // ── Delete custom section by index ─────────────────────────
  function deleteCustomSection(n: number) {
    // Compact data (shift n+1..last down to n..last-1)
    for (let i = n; i < customCount - 1; i++) {
      const nextImgCount = parseInt(sectionNotes[`__custom_${i + 1}_img_count__`] ?? "0", 10);
      onNoteChange?.(`__custom_${i}_name__`, sectionNotes[`__custom_${i + 1}_name__`] ?? "");
      onNoteChange?.(`__custom_${i}_note__`, sectionNotes[`__custom_${i + 1}_note__`] ?? "");
      onNoteChange?.(`__custom_${i}_img_count__`, String(nextImgCount));
      for (let m = 0; m < nextImgCount; m++) {
        onNoteChange?.(`__custom_${i}_img_${m}__`, sectionNotes[`__custom_${i + 1}_img_${m}__`] ?? "");
      }
    }
    const last = customCount - 1;
    const lastImgCount = parseInt(sectionNotes[`__custom_${last}_img_count__`] ?? "0", 10);
    onNoteChange?.(`__custom_${last}_name__`, "");
    onNoteChange?.(`__custom_${last}_note__`, "");
    onNoteChange?.(`__custom_${last}_img_count__`, "0");
    for (let m = 0; m < lastImgCount; m++) {
      onNoteChange?.(`__custom_${last}_img_${m}__`, "");
    }
    onNoteChange?.("__custom_count__", String(customCount - 1));
    // Update order: remove custom:n, shift higher indices down
    const newOrder = order
      .filter((id) => id !== `custom:${n}`)
      .map((id) => {
        const mx = id.match(/^custom:(\d+)$/);
        if (mx && parseInt(mx[1], 10) > n) return `custom:${parseInt(mx[1], 10) - 1}`;
        return id;
      });
    onNoteChange?.("__order__", newOrder.join(","));
    setOpenItems((prev) =>
      prev
        .filter((id) => id !== `__custom_${n}__`)
        .map((id) => {
          const mx = id.match(/^__custom_(\d+)__$/);
          if (mx && parseInt(mx[1], 10) > n) return `__custom_${parseInt(mx[1], 10) - 1}__`;
          return id;
        })
    );
  }

  // ── Render predefined section ───────────────────────────────
  function renderPredefined(section: BriefingSection) {
    const sx = section as BriefingSectionX;
    const note = sectionNotes[section.id] ?? "";
    const hasNote = note.trim().length > 0;
    const hasUploadedImages =
      (section.contentType === "upload" &&
        section.subsections.some((sub) =>
          sub.charts.some((c) => (sectionNotes[`__img__${c.id}`] ?? "").length > 0)
        )) ||
      Object.keys(sectionNotes).some(
        (k) => k.startsWith(`__img__extra__${section.id}__`) && sectionNotes[k]
      ) ||
      Object.keys(sectionNotes).some((k) => k.startsWith(`__ann__`) && sectionNotes[k]);

    return (
      <AccordionItem
        value={section.id}
        className="rounded-2xl border border-border bg-card overflow-hidden shadow-sm"
      >
        <AccordionTrigger className="px-6 py-4 hover:no-underline [&[data-state=open]>svg]:rotate-180">
          <div className="flex items-center gap-3 text-left">
            <span className="font-semibold text-sm text-foreground leading-tight">{section.name}</span>
            <div className="flex items-center gap-1.5">
              {(section.id === "synergie" || section.contentType === "images") && (
                <Badge variant="outline" className="text-[10px] px-1.5 py-0 text-muted-foreground border-border">Auto</Badge>
              )}
              {section.contentType === "external" && (
                <Badge variant="outline" className="text-[10px] px-1.5 py-0 text-muted-foreground border-border">Externe</Badge>
              )}
              {section.contentType === "iframe" && (
                <Badge variant="outline" className="text-[10px] px-1.5 py-0 text-muted-foreground border-border">Live</Badge>
              )}
              {section.id !== "synergie" && section.contentType === "upload" && (
                <Badge variant="outline" className="text-[10px] px-1.5 py-0 text-muted-foreground border-border">Capture</Badge>
              )}
              {!readOnly && hasNote && <PenLine className="h-3.5 w-3.5 text-primary/70" />}
              {!readOnly && hasUploadedImages && <Upload className="h-3.5 w-3.5 text-primary/70" />}
            </div>
          </div>
        </AccordionTrigger>
        <AccordionContent className="px-6 pb-6 pt-2">
          <div className="space-y-5">
            {section.id === "synergie" && (
              <SynergiePicker section={section} sectionNotes={sectionNotes} onNoteChange={onNoteChange} readOnly={readOnly} />
            )}
            {section.id !== "synergie" && section.contentType === "images" && (
              <ImagesContent section={section} sectionNotes={sectionNotes} onNoteChange={onNoteChange} readOnly={readOnly} />
            )}
            {section.contentType === "iframe" && (
              <IframeWithTabs section={sx} sectionNotes={sectionNotes} onNoteChange={onNoteChange} readOnly={readOnly} />
            )}
            {section.contentType === "external" && (
              <ExternalContent section={section} sectionNotes={sectionNotes} onNoteChange={onNoteChange} readOnly={readOnly} />
            )}
            {section.contentType === "upload" && (
              <UploadContent section={section} sectionNotes={sectionNotes} onNoteChange={onNoteChange} readOnly={readOnly} />
            )}
            <div className="space-y-2 pt-2 border-t border-border">
              <label className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                <PenLine className="h-3.5 w-3.5" />
                Observations / Analyse
              </label>
              <AutoTextarea
                noteKey={section.id}
                value={note}
                onChange={onNoteChange}
                placeholder={`Notes d'analyse pour ${section.name}…`}
                readOnly={readOnly}
              />
            </div>
          </div>
        </AccordionContent>
      </AccordionItem>
    );
  }

  return (
    <Accordion type="multiple" value={openItems} onValueChange={setOpenItems} className="space-y-0">
      {/* Insert button before very first section */}
      {!readOnly && <InsertSectionButton onInsert={() => insertAt(0)} />}

      {order.map((itemId, orderIdx) => {
        const customMatch = itemId.match(/^custom:(\d+)$/);
        const customIdx = customMatch ? parseInt(customMatch[1], 10) : -1;
        const predefined = customIdx === -1 ? sectionsById[itemId] : null;
        if (customIdx === -1 && !predefined) return null;

        return (
          <React.Fragment key={itemId}>
            <div className="py-1.5">
              {customIdx >= 0 ? (
                <CustomSectionItem
                  idx={customIdx}
                  sectionNotes={sectionNotes}
                  onNoteChange={onNoteChange}
                  readOnly={readOnly}
                  onDelete={() => deleteCustomSection(customIdx)}
                />
              ) : (
                renderPredefined(predefined!)
              )}
            </div>
            {!readOnly && <InsertSectionButton onInsert={() => insertAt(orderIdx + 1)} />}
          </React.Fragment>
        );
      })}
    </Accordion>
  );
}
