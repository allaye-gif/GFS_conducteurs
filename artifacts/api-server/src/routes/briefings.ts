import { Router, type IRouter } from "express";
import { eq, desc, count } from "drizzle-orm";
import { db, briefingsTable } from "@workspace/db";
import { getBriefingCatalog } from "../lib/briefing-catalog";
import {
  CreateBriefingBody,
  UpdateBriefingBody,
  ListBriefingsQueryParams,
} from "@workspace/api-zod";

const router: IRouter = Router();

function mapRow(row: typeof briefingsTable.$inferSelect) {
  return {
    id: row.id,
    date: row.date,
    title: row.title,
    notes: row.notes ?? null,
    sections: (row.sections as unknown[]) ?? [],
    sectionNotes: row.sectionNotes ?? undefined,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

router.get("/briefing/catalog", async (_req, res): Promise<void> => {
  const catalog = await getBriefingCatalog();
  res.json(catalog);
});

router.get("/briefings", async (req, res): Promise<void> => {
  const parsed = ListBriefingsQueryParams.safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: "Paramètres invalides" }); return; }
  const { page, limit } = parsed.data;
  const offset = (page - 1) * limit;

  const [rows, [totalResult]] = await Promise.all([
    db.select().from(briefingsTable).orderBy(desc(briefingsTable.createdAt)).limit(limit).offset(offset),
    db.select({ value: count() }).from(briefingsTable),
  ]);

  res.json({ items: rows.map(mapRow), total: totalResult?.value ?? 0, page, limit });
});

router.post("/briefings", async (req, res): Promise<void> => {
  const parsed = CreateBriefingBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const { date, title, notes, sections, sectionNotes } = parsed.data;

  const [row] = await db.insert(briefingsTable).values({
    date,
    title,
    notes: notes ?? null,
    sections: sections as unknown[],
    sectionNotes: sectionNotes ?? null,
  }).returning();

  res.status(201).json(mapRow(row!));
});

router.get("/briefings/:id", async (req, res): Promise<void> => {
  const id = parseInt(req.params["id"] ?? "", 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID invalide" }); return; }

  const [row] = await db.select().from(briefingsTable).where(eq(briefingsTable.id, id));
  if (!row) { res.status(404).json({ error: "Briefing introuvable" }); return; }

  res.json(mapRow(row));
});

router.patch("/briefings/:id", async (req, res): Promise<void> => {
  const id = parseInt(req.params["id"] ?? "", 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID invalide" }); return; }

  const parsed = UpdateBriefingBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const updates: Partial<{ notes: string | null; sectionNotes: Record<string, string>; updatedAt: Date }> = {
    updatedAt: new Date(),
  };
  if (parsed.data.notes !== undefined) updates.notes = parsed.data.notes;
  if (parsed.data.sectionNotes !== undefined) updates.sectionNotes = parsed.data.sectionNotes;

  const [row] = await db.update(briefingsTable).set(updates).where(eq(briefingsTable.id, id)).returning();
  if (!row) { res.status(404).json({ error: "Briefing introuvable" }); return; }

  res.json(mapRow(row));
});

router.delete("/briefings/:id", async (req, res): Promise<void> => {
  const id = parseInt(req.params["id"] ?? "", 10);
  if (isNaN(id)) { res.status(400).json({ error: "ID invalide" }); return; }

  const [row] = await db.delete(briefingsTable).where(eq(briefingsTable.id, id)).returning();
  if (!row) { res.status(404).json({ error: "Briefing introuvable" }); return; }

  res.status(204).send();
});

export default router;
