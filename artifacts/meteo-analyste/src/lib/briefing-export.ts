import { format, parseISO } from "date-fns";
import { fr } from "date-fns/locale";
import type { BriefingSection } from "@workspace/api-client-react";

type BriefingSectionExt = BriefingSection & {
  contentType: "images" | "iframe" | "external" | "upload";
  iframeUrl?: string;
  externalUrl?: string;
  externalLabel?: string;
};

export type BriefingForExport = {
  id: number;
  title: string;
  date: string;
  notes: string;
  createdAt: string;
  sections: BriefingSectionExt[];
  sectionNotes: Record<string, string>;
};

// ── Image helpers ─────────────────────────────────────────────────────────────

async function fetchAsDataUrl(url: string): Promise<string | null> {
  if (!url) return null;
  if (url.startsWith("data:")) return url;
  const fetchUrl = url.startsWith("/") ? url : `/api/noaa/proxy?url=${encodeURIComponent(url)}`;
  try {
    const resp = await fetch(fetchUrl, { signal: AbortSignal.timeout(12000) });
    if (!resp.ok) return null;
    const blob = await resp.blob();
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result as string);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

function getCapture(chartId: string, sn: Record<string, string>): string | null {
  const v = sn[`__img__${chartId}`];
  return v?.startsWith("data:") ? v : null;
}

function getAnnotation(chartId: string, sn: Record<string, string>): string | null {
  const v = sn[`__ann__${chartId}`];
  return v?.startsWith("data:") ? v : null;
}

function getExtraImages(sectionId: string, sn: Record<string, string>): string[] {
  const count = parseInt(sn[`__extra_count__${sectionId}`] ?? "0", 10);
  const result: string[] = [];
  for (let n = 0; n < count; n++) {
    const v = sn[`__img__extra__${sectionId}__${n}`];
    if (v?.startsWith("data:")) result.push(v);
  }
  return result;
}

async function resolveChartImage(
  chartId: string, chartUrl: string, sn: Record<string, string>, tick?: () => void
): Promise<string | null> {
  const ann = getAnnotation(chartId, sn);
  if (ann) { tick?.(); return ann; }
  const cap = getCapture(chartId, sn);
  if (cap) { tick?.(); return cap; }
  if (!chartUrl) { tick?.(); return null; }
  const r = await fetchAsDataUrl(chartUrl);
  tick?.();
  return r;
}

async function fetchLogoAsDataUrl(): Promise<string | null> {
  try {
    const resp = await fetch("/logo-mali-meteo.png", { signal: AbortSignal.timeout(3000) });
    if (!resp.ok) return null;
    const blob = await resp.blob();
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result as string);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  } catch { return null; }
}

async function cropImageForPptx(
  dataUrl: string, cropL: number, cropT: number, cropW: number, cropH: number
): Promise<string> {
  if (cropL <= 0 && cropT <= 0 && cropW >= 1 && cropH >= 1) return dataUrl;
  return new Promise<string>((resolve) => {
    const img = new Image();
    img.onload = () => {
      const natW = img.naturalWidth, natH = img.naturalHeight;
      const sx = Math.round(cropL * natW);
      const sy = Math.round(cropT * natH);
      const sw = Math.round(Math.min(cropW, 1 - cropL) * natW);
      const sh = Math.round(Math.min(cropH, 1 - cropT) * natH);
      if (sw <= 0 || sh <= 0) { resolve(dataUrl); return; }
      const canvas = document.createElement("canvas");
      canvas.width = sw; canvas.height = sh;
      const ctx = canvas.getContext("2d");
      if (!ctx) { resolve(dataUrl); return; }
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
      resolve(canvas.toDataURL("image/png"));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

type CropConfig = { cropL: number; cropT: number; cropW: number; cropH: number };

const SECTION_CROPS: Record<string, CropConfig> = {
  "misva-pw":     { cropL: 0.5,  cropT: 0,    cropW: 0.5,  cropH: 1    },
  "misva-lowlev": { cropL: 0.5,  cropT: 0,    cropW: 0.5,  cropH: 0.5  },
  "pluie-ecmwf":  { cropL: 0.22, cropT: 0.06, cropW: 0.42, cropH: 0.50 },
};

const SECTION_MAX_CHUNK: Record<string, number> = {};

const SECTION_WITH_LEGEND = new Set(["pluie-ecmwf"]);

type FlatChart = { id: string; label: string; url: string };

function flatCharts(section: BriefingSectionExt): FlatChart[] {
  if (section.contentType === "images" || section.contentType === "upload") {
    return section.subsections.flatMap((sub) =>
      sub.charts.map((c) => ({ id: c.id, label: c.label, url: c.url ?? "" }))
    );
  }
  return [];
}

type CustomSection = { n: number; name: string; note: string; images: string[] };

function getCustomSections(sn: Record<string, string>): CustomSection[] {
  const count = parseInt(sn["__custom_count__"] ?? "0", 10);
  const result: CustomSection[] = [];
  for (let n = 0; n < count; n++) {
    const name = sn[`__custom_${n}_name__`] ?? "";
    const note = sn[`__custom_${n}_note__`] ?? "";
    const imgCount = parseInt(sn[`__custom_${n}_img_count__`] ?? "0", 10);
    const images: string[] = [];
    for (let m = 0; m < imgCount; m++) {
      const v = sn[`__custom_${n}_img_${m}__`];
      if (v?.startsWith("data:")) images.push(v);
    }
    if (name.trim() || note.trim() || images.length) result.push({ n, name, note, images });
  }
  return result;
}

/** Build ordered list of items respecting __order__ key from the viewer */
type OrderedItem =
  | { type: "catalog"; section: BriefingSectionExt }
  | { type: "custom"; cs: CustomSection };

function buildOrderedItems(
  sections: BriefingSectionExt[],
  customSections: CustomSection[],
  sn: Record<string, string>
): OrderedItem[] {
  const orderStr = sn["__order__"];
  const sectionMap = new Map(sections.map((s) => [s.id, s]));
  const customMap = new Map(customSections.map((cs) => [`custom:${cs.n}`, cs]));
  const result: OrderedItem[] = [];
  const usedSections = new Set<string>();
  const usedCustom = new Set<number>();

  if (orderStr) {
    for (const id of orderStr.split(",").filter(Boolean)) {
      if (sectionMap.has(id)) {
        result.push({ type: "catalog", section: sectionMap.get(id)! });
        usedSections.add(id);
      } else if (customMap.has(id)) {
        const cs = customMap.get(id)!;
        result.push({ type: "custom", cs });
        usedCustom.add(cs.n);
      }
    }
  }
  // Append anything not referenced in __order__
  for (const s of sections) {
    if (!usedSections.has(s.id)) result.push({ type: "catalog", section: s });
  }
  for (const cs of customSections) {
    if (!usedCustom.has(cs.n)) result.push({ type: "custom", cs });
  }
  return result;
}

function countImages(briefing: BriefingForExport): number {
  let n = 0;
  for (const sec of briefing.sections) {
    n += flatCharts(sec).length;
    n += getExtraImages(sec.id, briefing.sectionNotes).length;
  }
  const customs = getCustomSections(briefing.sectionNotes);
  for (const cs of customs) n += cs.images.length;
  return Math.max(n, 1);
}

// ─────────────────────────────────────────────────────────────────────────────
// HTML EXPORT
// ─────────────────────────────────────────────────────────────────────────────

export async function exportBriefingAsHtml(
  briefing: BriefingForExport,
  onProgress?: (pct: number) => void
): Promise<void> {
  const total = countImages(briefing);
  let done = 0;
  const tick = () => { done++; onProgress?.(Math.round((done / total) * 95)); };

  const imageMap = new Map<string, string>();
  await Promise.allSettled(
    briefing.sections.flatMap((sec) =>
      flatCharts(sec).map(async (c) => {
        const img = await resolveChartImage(c.id, c.url, briefing.sectionNotes, tick);
        if (img) imageMap.set(c.id, img);
      })
    )
  );

  const extraMap = new Map<string, string[]>();
  for (const sec of briefing.sections) {
    const extras = getExtraImages(sec.id, briefing.sectionNotes);
    extras.forEach(tick);
    if (extras.length) extraMap.set(sec.id, extras);
  }

  onProgress?.(96);

  const dateLabel = format(parseISO(briefing.date + "T00:00:00"), "d MMMM yyyy", { locale: fr });
  const archivedLabel = format(new Date(briefing.createdAt), "d MMMM yyyy 'à' HH:mm", { locale: fr });

  function renderImageGrid(imgs: { src: string; label: string }[]): string {
    if (!imgs.length) return "";
    const n = imgs.length;
    const cols = n === 1 ? "1fr" : n <= 4 ? "1fr 1fr" : n <= 6 ? "1fr 1fr 1fr" : "1fr 1fr 1fr 1fr";
    return `<div class="img-grid" style="grid-template-columns:${cols}">${
      imgs.map(({ src, label }) =>
        `<div class="img-item"><p class="img-lbl">${esc(label)}</p><img src="${src}" alt="${esc(label)}"/></div>`
      ).join("")
    }</div>`;
  }

  function renderCatalogSection(section: BriefingSectionExt): string | null {
    const note = briefing.sectionNotes[section.id] ?? "";
    const extras = extraMap.get(section.id) ?? [];
    const extraImgs = extras.map((src, i) => ({ src, label: `Capture ${i + 1}` }));
    let bodyHtml = "";

    if (section.contentType === "images" || section.contentType === "upload") {
      for (const sub of section.subsections) {
        const imgs = sub.charts
          .map((c) => { const src = imageMap.get(c.id); return src ? { src, label: c.label } : null; })
          .filter(Boolean) as { src: string; label: string }[];
        if (sub.label && imgs.length) bodyHtml += `<p class="sub-lbl">${esc(sub.label)}</p>`;
        bodyHtml += renderImageGrid(imgs);
      }
    } else if (section.contentType === "iframe" || section.contentType === "external") {
      if (!extraImgs.length && !note.trim()) return null;
      if (section.externalUrl) {
        bodyHtml += `<p class="ext-link">🔗 <a href="${section.externalUrl}" target="_blank">${esc((section as { externalLabel?: string }).externalLabel ?? section.name)} ↗</a></p>`;
      }
    }

    if (extraImgs.length) bodyHtml += renderImageGrid(extraImgs);
    if (!bodyHtml.trim() && !note.trim()) return null;

    const noteHtml = note.trim()
      ? `<div class="obs"><span class="obs-lbl">Analyse :</span><p>${note.replace(/\n/g, "<br>")}</p></div>`
      : "";

    return `<section>\n  <h2>${esc(section.name)}</h2>\n  ${bodyHtml}${noteHtml}\n</section>`;
  }

  function renderCustomSection(cs: CustomSection): string | null {
    const imgs = cs.images.map((src, i) => ({ src, label: `Image ${i + 1}` }));
    const bodyHtml = renderImageGrid(imgs);
    const noteHtml = cs.note.trim()
      ? `<div class="obs"><span class="obs-lbl">Analyse :</span><p>${cs.note.replace(/\n/g, "<br>")}</p></div>`
      : "";
    if (!bodyHtml.trim() && !noteHtml.trim()) return null;
    return `<section class="custom-sec">\n  <h2>${esc(cs.name || "Section personnalisée")}</h2>\n  ${bodyHtml}${noteHtml}\n</section>`;
  }

  const customSections = getCustomSections(briefing.sectionNotes);
  customSections.forEach((cs) => cs.images.forEach(tick));

  const orderedItems = buildOrderedItems(briefing.sections, customSections, briefing.sectionNotes);

  const allSectionsHtml = orderedItems
    .map((item) =>
      item.type === "catalog"
        ? renderCatalogSection(item.section)
        : renderCustomSection(item.cs)
    )
    .filter(Boolean)
    .join("\n");

  const tocItems = orderedItems
    .map((item) => {
      if (item.type === "catalog") {
        const rendered = renderCatalogSection(item.section);
        if (!rendered) return null;
        return `<span class="toc-item">${esc(item.section.name)}</span>`;
      } else {
        const rendered = renderCustomSection(item.cs);
        if (!rendered) return null;
        return `<span class="toc-item toc-custom">${esc(item.cs.name || "Section personnalisée")}</span>`;
      }
    })
    .filter(Boolean)
    .join("");

  const resumeNote = briefing.notes?.trim();

  const html = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Briefing du ${esc(dateLabel)}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Segoe UI',Calibri,Arial,sans-serif;background:#f5f5f0;color:#1a2234;font-size:13px;line-height:1.5}
.page{max-width:1140px;margin:0 auto;padding:24px 20px}

/* ── Header ── */
.header{background:#1b3d28;color:#fff;border-radius:10px 10px 0 0;padding:22px 28px 18px}
.header-type{font-size:9px;font-weight:700;letter-spacing:2.5px;text-transform:uppercase;opacity:.55;margin-bottom:6px}
.header-title{font-size:24px;font-weight:700;letter-spacing:-.3px;margin-bottom:5px}
.header-meta{font-size:11px;opacity:.55}

/* ── TOC ── */
.toc{background:#fff;border:1px solid #dde3ec;border-top:none;padding:10px 20px;margin-bottom:16px;border-radius:0 0 8px 8px}
.toc-title{font-size:9px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#6b7a99;margin-bottom:6px}
.toc-items{display:flex;flex-wrap:wrap;gap:5px}
.toc-item{font-size:11px;color:#1b3d28;font-weight:500;padding:2px 9px;border:1px solid #c8e0d0;border-radius:20px;background:#f0f8f3}
.toc-custom{color:#7a5c00;border-color:#dbc87a;background:#fffdf4}
.toc-resume{color:#7a5c00;border-color:#dbc87a;background:#fffdf4}

/* ── Sections ── */
section{background:#fff;border:1px solid #dde3ec;border-radius:8px;padding:14px 18px;margin-bottom:10px;page-break-inside:avoid}
h2{font-size:12px;font-weight:700;color:#1b3d28;text-transform:uppercase;letter-spacing:.8px;padding-bottom:7px;margin-bottom:12px;border-bottom:2px solid #e5efea;display:flex;align-items:center;gap:6px}
h2::before{content:'';display:inline-block;width:3px;height:13px;background:#1b3d28;border-radius:2px;flex-shrink:0}

/* ── Section personnalisée ── */
.custom-sec{border-color:#e8d98a;border-left:3px solid #c8a000}
.custom-sec h2{color:#7a5c00;border-bottom-color:#f0e0a0}
.custom-sec h2::before{background:#c8a000}

/* ── Image grids ── */
.img-grid{display:grid;gap:8px;margin-bottom:10px}
.img-lbl{font-size:9px;font-weight:600;color:#5b6e8b;letter-spacing:.5px;margin-bottom:3px;text-transform:uppercase}
.img-item img{width:100%;height:auto;border-radius:4px;border:1px solid #e0e7ef;display:block}
.sub-lbl{font-size:9px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#8b9ab5;margin:8px 0 5px}

/* ── Obs / note ── */
.obs{background:#f0f7f3;border-left:3px solid #1b3d28;border-radius:0 5px 5px 0;padding:8px 12px;margin-top:10px}
.obs-lbl{font-size:8px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#1b3d28;display:block;margin-bottom:3px}
.obs p{color:#1a2234;line-height:1.6;white-space:pre-wrap;font-size:12px}
.custom-sec .obs{background:#fffdf4;border-left-color:#c8a000}
.custom-sec .obs-lbl{color:#7a5c00}
.ext-link{margin-bottom:8px;font-size:12px}
.ext-link a{color:#1b3d28;font-weight:600;text-decoration:none}

/* ── Résumé ── */
.resume{background:#fffdf4;border:1px solid #e8d98a;border-left:3px solid #c8a000}
.resume h2{color:#7a5c00;border-bottom-color:#f0e0a0}
.resume h2::before{background:#c8a000}
.resume .obs{background:#fff8e6;border-left-color:#c8a000}

/* ── Print ── */
@media print{
  body{background:#fff;font-size:10.5pt}
  .page{padding:0;max-width:100%}
  .header{border-radius:0}
  section{page-break-inside:avoid}
}
</style>
</head>
<body>
<div class="page">

<div class="header">
  <div class="header-type">Briefing Météorologique Quotidien</div>
  <div class="header-title">Briefing du ${esc(dateLabel)}</div>
  <div class="header-meta">Archivé le ${esc(archivedLabel)}</div>
</div>

${allSectionsHtml.trim() ? `<div class="toc">
  <div class="toc-title">Sommaire</div>
  <div class="toc-items">
    ${tocItems}
    ${resumeNote ? '<span class="toc-item toc-resume">Résumé</span>' : ""}
  </div>
</div>` : ""}

${allSectionsHtml}

${resumeNote ? `<section class="resume">
  <h2>Résumé — Situation générale</h2>
  <div class="obs"><p>${resumeNote.replace(/\n/g, "<br>")}</p></div>
</section>` : ""}

</div>
</body>
</html>`;

  const blob = new Blob([html], { type: "text/html;charset=utf-8" });
  const blobUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = blobUrl;
  a.download = `Briefing_${briefing.date}.html`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(blobUrl);
  onProgress?.(100);
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ─────────────────────────────────────────────────────────────────────────────
// PPTX EXPORT
// ─────────────────────────────────────────────────────────────────────────────

const W = 13.33, H = 7.5, PAD = 0.3, TITLE_H = 0.7;
const GREEN = "1b3d28", LIGHT = "f4f1ea", GOLD = "c8a000", WHITE = "FFFFFF";
const CONTENT_TOP = TITLE_H + 0.15;
const CONTENT_H = H - CONTENT_TOP - PAD;

type PptxImg = { dataUrl: string; label: string; legendStrip?: string };

function layoutImgs(imgs: PptxImg[], availH: number) {
  const innerW = W - 2 * PAD, sp = 0.1;
  if (!imgs.length) return [];
  const n = imgs.length;
  if (n === 1) return [{ x: PAD, y: CONTENT_TOP, w: innerW, h: availH, ...imgs[0] }];
  if (n === 2) {
    const w = (innerW - sp) / 2;
    return imgs.map((img, i) => ({ x: PAD + i * (w + sp), y: CONTENT_TOP, w, h: availH, ...img }));
  }
  if (n === 3) {
    const w = (innerW - 2 * sp) / 3;
    return imgs.map((img, i) => ({ x: PAD + i * (w + sp), y: CONTENT_TOP, w, h: availH, ...img }));
  }
  if (n === 4) {
    const cw = (innerW - sp) / 2, rh = (availH - sp) / 2;
    return imgs.map((img, i) => ({
      x: PAD + (i % 2) * (cw + sp),
      y: CONTENT_TOP + Math.floor(i / 2) * (rh + sp),
      w: cw, h: rh, ...img,
    }));
  }
  // 5-6 images : grille 3×2
  const cols = 3, rows = Math.ceil(Math.min(n, 6) / cols);
  const cw = (innerW - (cols - 1) * sp) / cols;
  const rh = (availH - (rows - 1) * sp) / rows;
  return imgs.slice(0, cols * rows).map((img, i) => ({
    x: PAD + (i % cols) * (cw + sp),
    y: CONTENT_TOP + Math.floor(i / cols) * (rh + sp),
    w: cw, h: rh, ...img,
  }));
}

async function resolveAllImages(
  section: BriefingSectionExt, sn: Record<string, string>, tick?: () => void
): Promise<PptxImg[]> {
  const crop = SECTION_CROPS[section.id];
  const withLegend = SECTION_WITH_LEGEND.has(section.id);
  const results: PptxImg[] = [];
  for (const c of flatCharts(section)) {
    let d = await resolveChartImage(c.id, c.url, sn, tick);
    if (d) {
      let legendStrip: string | undefined;
      if (withLegend) {
        legendStrip = await cropImageForPptx(d, 0, 0.85, 1, 0.15);
      }
      if (crop) d = await cropImageForPptx(d, crop.cropL, crop.cropT, crop.cropW, crop.cropH);
      results.push({ dataUrl: d, label: c.label, legendStrip });
    } else tick?.();
  }
  const count = parseInt(sn[`__extra_count__${section.id}`] ?? "0", 10);
  for (let i = 0; i < count; i++) {
    const d = sn[`__img__extra__${section.id}__${i}`];
    if (d?.startsWith("data:")) {
      const lbl = sn[`__extra_lbl__${section.id}__${i}`] || `Capture ${i + 1}`;
      results.push({ dataUrl: d, label: lbl });
      tick?.();
    }
  }
  return results;
}

function addSectionSlides(
  pptx: InstanceType<typeof import("pptxgenjs").default>,
  sectionName: string,
  images: PptxImg[],
  note: string,
  bgColor = LIGHT,
  titleBg = GREEN,
  accentColor = GOLD,
  maxChunk = 4
) {
  const chunks: PptxImg[][] = images.length > 0
    ? Array.from({ length: Math.ceil(images.length / maxChunk) }, (_, i) => images.slice(i * maxChunk, (i + 1) * maxChunk))
    : [[]];

  chunks.forEach((chunk, ci) => {
    const isLast = ci === chunks.length - 1;
    const hasNote = isLast && note.trim().length > 0;
    const NOTE_H = hasNote ? 0.95 : 0;
    const hasLegend = chunk.some((img) => img.legendStrip);
    const LEGEND_H = hasLegend ? 0.32 : 0;
    const imgAreaH = CONTENT_H - NOTE_H - (hasNote ? 0.1 : 0) - LEGEND_H - (hasLegend ? 0.06 : 0);
    const slideLabel = chunks.length > 1 ? `${sectionName} (${ci + 1}/${chunks.length})` : sectionName;

    const slide = pptx.addSlide();
    slide.background = { color: bgColor };
    slide.addShape("rect" as never, { x: 0, y: 0, w: 0.06, h: TITLE_H, fill: { color: accentColor } });
    slide.addText(slideLabel.toUpperCase(), {
      x: 0, y: 0, w: W, h: TITLE_H,
      fontSize: 12, bold: true, color: WHITE,
      fill: { color: titleBg }, valign: "middle", margin: [0, 0, 0, 28],
    });

    if (chunk.length) {
      const LBL = 0.22; // hauteur bande titre au-dessus de chaque image
      const layout = layoutImgs(chunk, imgAreaH);
      for (const img of layout) {
        try {
          // Bande colorée avec le nom du produit, AU-DESSUS de l'image
          slide.addShape("rect" as never, {
            x: img.x, y: img.y, w: img.w, h: LBL,
            fill: { color: titleBg === GREEN ? "1b3d28" : "7a5c00" },
          });
          slide.addText(img.label.toUpperCase(), {
            x: img.x + 0.08, y: img.y, w: img.w - 0.08, h: LBL,
            fontSize: 7.5, bold: true, color: WHITE, valign: "middle", align: "left",
          });
          // Image sous la bande
          slide.addImage({
            data: img.dataUrl,
            x: img.x, y: img.y + LBL,
            w: img.w, h: img.h - LBL,
            sizing: { type: "contain", w: img.w, h: img.h - LBL },
          });
        } catch { /* skip */ }
      }

      if (hasLegend) {
        const legendY = CONTENT_TOP + imgAreaH + 0.06;
        const firstLegend = chunk.find((img) => img.legendStrip);
        if (firstLegend?.legendStrip) {
          try {
            slide.addImage({ data: firstLegend.legendStrip, x: PAD, y: legendY, w: W - 2 * PAD, h: LEGEND_H, sizing: { type: "contain", w: W - 2 * PAD, h: LEGEND_H } });
          } catch { /* skip */ }
        }
      }
    }

    if (hasNote) {
      const noteY = H - NOTE_H - PAD * 0.4;
      slide.addShape("rect" as never, { x: PAD, y: noteY, w: 0.04, h: NOTE_H - PAD * 0.4, fill: { color: titleBg } });
      slide.addText([
        { text: "Analyse :  ", options: { bold: true, color: titleBg } },
        { text: note.slice(0, 450) + (note.length > 450 ? "…" : ""), options: { color: "222222" } },
      ], {
        x: PAD + 0.12, y: noteY, w: W - 2 * PAD - 0.12, h: NOTE_H - PAD * 0.4,
        fontSize: 9, fill: { color: bgColor === LIGHT ? "edf7f0" : "fffdf4" }, wrap: true, valign: "middle",
      });
    }
  });
}

export async function exportBriefingAsPptx(
  briefing: BriefingForExport,
  onProgress?: (pct: number) => void
): Promise<void> {
  const PptxGenJS = (await import("pptxgenjs")).default;
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_WIDE";
  pptx.title = `Briefing du ${format(parseISO(briefing.date + "T00:00:00"), "d MMMM yyyy", { locale: fr })}`;

  const dateLabel = format(parseISO(briefing.date + "T00:00:00"), "d MMMM yyyy", { locale: fr });
  const archivedLabel = format(new Date(briefing.createdAt), "d MMMM yyyy 'à' HH:mm", { locale: fr });

  const total = countImages(briefing);
  let done = 0;
  const tick = () => { done++; onProgress?.(Math.round((done / total) * 88)); };

  // ── Slide 1 : Couverture ───────────────────────────────────────────────────
  const coverDateLabel = format(parseISO(briefing.date + "T00:00:00"), "dd/MM/yyyy");
  const logoDataUrl = await fetchLogoAsDataUrl();
  const titleSlide = pptx.addSlide();
  titleSlide.background = { color: WHITE };

  // Triangle jaune coin bas-droite
  titleSlide.addShape("rtTriangle" as never, {
    x: W - 3.6, y: H - 2.9, w: 3.6, h: 2.9,
    flipH: true, fill: { color: "F5C518" }, line: { color: "F5C518" },
  });

  // ── Logos : image réelle si logo-mali-meteo.png présent, sinon cercle texte
  const LX1 = 0.28, LX2 = W - 1.63, LY = 0.22, LS = 1.35;
  if (logoDataUrl) {
    titleSlide.addImage({ data: logoDataUrl, x: LX1, y: LY, w: LS, h: LS, rounding: true });
    titleSlide.addImage({ data: logoDataUrl, x: LX2, y: LY, w: LS, h: LS, rounding: true });
  } else {
    for (const lx of [LX1, LX2]) {
      titleSlide.addShape("ellipse" as never, { x: lx, y: LY, w: LS, h: LS, line: { color: "cccccc", width: 1 }, fill: { color: WHITE } });
      titleSlide.addText("Mali\nMétéo", { x: lx, y: LY + 0.08, w: LS, h: LS - 0.10, fontSize: 11, bold: true, color: "cc2222", align: "center", valign: "middle" });
    }
  }

  // Icônes météo centre-haut
  titleSlide.addText("🌬  🌧⚡  ☁", {
    x: (W - 4) / 2, y: 0.28, w: 4, h: 0.85,
    fontSize: 28, align: "center", valign: "middle",
  });

  // Cadre jaune autour du titre
  titleSlide.addShape("rect" as never, {
    x: 1.6, y: 2.55, w: W - 3.2, h: 2.0,
    fill: { color: WHITE }, line: { color: "F5C518", width: 3 },
  });

  // Titre "Briefing du DD/MM/YYYY"
  titleSlide.addText(`Briefing du ${coverDateLabel}`, {
    x: 1.7, y: 2.6, w: W - 3.4, h: 1.9,
    fontSize: 36, bold: true, color: "111111", align: "center", valign: "middle",
  });

  // ── Slides : sections dans l'ordre de l'UI ────────────────────────────────
  const customSections = getCustomSections(briefing.sectionNotes);
  const orderedItems = buildOrderedItems(briefing.sections, customSections, briefing.sectionNotes);

  for (const item of orderedItems) {
    if (item.type === "catalog") {
      const section = item.section;
      const note = briefing.sectionNotes[section.id] ?? "";
      let images: PptxImg[] = [];
      if (section.contentType === "images" || section.contentType === "upload") {
        images = await resolveAllImages(section, briefing.sectionNotes, tick);
      } else {
        const extras = getExtraImages(section.id, briefing.sectionNotes);
        extras.forEach(tick);
        images = extras.map((d, i) => ({ dataUrl: d, label: `Capture ${i + 1}` }));
      }
      if (!images.length && !note.trim()) continue;
      const maxChunk = SECTION_MAX_CHUNK[section.id] ?? 4;
      addSectionSlides(pptx, section.name, images, note, LIGHT, GREEN, GOLD, maxChunk);
    } else {
      const cs = item.cs;
      const images: PptxImg[] = cs.images.map((d, i) => { tick(); return { dataUrl: d, label: `Image ${i + 1}` }; });
      if (!images.length && !cs.note.trim()) continue;
      addSectionSlides(pptx, cs.name || "Section personnalisée", images, cs.note, "fffdf4", "9a7600", GOLD);
    }
  }

  // ── Dernière diapo : Résumé ────────────────────────────────────────────────
  if (briefing.notes?.trim()) {
    const rslide = pptx.addSlide();
    rslide.background = { color: "fffdf4" };
    rslide.addShape("rect" as never, { x: 0, y: 0, w: 0.06, h: TITLE_H, fill: { color: GOLD } });
    rslide.addText("RÉSUMÉ — SITUATION GÉNÉRALE", {
      x: 0, y: 0, w: W, h: TITLE_H,
      fontSize: 12, bold: true, color: WHITE,
      fill: { color: "9a7600" }, valign: "middle", margin: [0, 0, 0, 28],
    });
    rslide.addText(briefing.notes.slice(0, 2000), {
      x: PAD, y: CONTENT_TOP, w: W - 2 * PAD, h: CONTENT_H,
      fontSize: 12, color: "1a2234", wrap: true, valign: "top",
    });
  }

  onProgress?.(96);
  await pptx.writeFile({ fileName: `Briefing_${briefing.date}.pptx` });
  onProgress?.(100);
}

// ─────────────────────────────────────────────────────────────────────────────
// PRINT / PDF
// ─────────────────────────────────────────────────────────────────────────────

export function printBriefing(): void {
  window.print();
}
