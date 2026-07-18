import { Router, type IRouter } from "express";
import { eq, desc, count } from "drizzle-orm";
import { db, analysesTable } from "@workspace/db";
import {
  ListAnalysesQueryParams,
  ListAnalysesResponse,
  CreateAnalysisBody,
  GetAnalysisParams,
  GetAnalysisResponse,
  UpdateAnalysisParams,
  UpdateAnalysisBody,
  UpdateAnalysisResponse,
  DeleteAnalysisParams,
  GetAnalysesSummaryResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/analyses/summary", async (req, res): Promise<void> => {
  const [totalResult] = await db
    .select({ value: count() })
    .from(analysesTable);

  const recentRows = await db
    .select()
    .from(analysesTable)
    .orderBy(desc(analysesTable.createdAt))
    .limit(3);

  const recent = recentRows.map((row) => ({
    ...row,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    sections: (row.sections as unknown[]) ?? [],
    sectionNotes: row.sectionNotes ?? undefined,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }));

  const lastAnalysisDate =
    recentRows.length > 0 ? recentRows[0].createdAt.toISOString() : null;

  res.json(
    GetAnalysesSummaryResponse.parse({
      total: totalResult?.value ?? 0,
      recentAnalyses: recent,
      lastAnalysisDate,
    }),
  );
});

router.get("/analyses", async (req, res): Promise<void> => {
  const parsed = ListAnalysesQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { page, limit } = parsed.data;
  const safePage = page ?? 1;
  const safeLimit = limit ?? 20;
  const offset = (safePage - 1) * safeLimit;

  const [rows, [totalResult]] = await Promise.all([
    db
      .select()
      .from(analysesTable)
      .orderBy(desc(analysesTable.createdAt))
      .limit(safeLimit)
      .offset(offset),
    db.select({ value: count() }).from(analysesTable),
  ]);

  const items = rows.map((row) => ({
    ...row,
    sections: (row.sections as unknown[]) ?? [],
    sectionNotes: row.sectionNotes ?? undefined,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }));

  res.json(
    ListAnalysesResponse.parse({
      items,
      total: totalResult?.value ?? 0,
      page: safePage,
      limit: safeLimit,
    }),
  );
});

router.post("/analyses", async (req, res): Promise<void> => {
  const parsed = CreateAnalysisBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [row] = await db
    .insert(analysesTable)
    .values({
      title: parsed.data.title,
      periodStart: parsed.data.periodStart,
      periodEnd: parsed.data.periodEnd,
      notes: parsed.data.notes ?? null,
      sections: parsed.data.sections as unknown[],
      sectionNotes: (parsed.data.sectionNotes as Record<string, string>) ?? null,
    })
    .returning();

  res.status(201).json(
    GetAnalysisResponse.parse({
      ...row,
      sections: (row.sections as unknown[]) ?? [],
      sectionNotes: row.sectionNotes ?? undefined,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }),
  );
});

router.get("/analyses/:id", async (req, res): Promise<void> => {
  const params = GetAnalysisParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [row] = await db
    .select()
    .from(analysesTable)
    .where(eq(analysesTable.id, params.data.id));

  if (!row) {
    res.status(404).json({ error: "Analyse non trouvée" });
    return;
  }

  res.json(
    GetAnalysisResponse.parse({
      ...row,
      sections: (row.sections as unknown[]) ?? [],
      sectionNotes: row.sectionNotes ?? undefined,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }),
  );
});

router.patch("/analyses/:id", async (req, res): Promise<void> => {
  const params = UpdateAnalysisParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = UpdateAnalysisBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const updateData: Record<string, unknown> = {
    updatedAt: new Date(),
  };
  if (parsed.data.title !== undefined) updateData.title = parsed.data.title;
  if (parsed.data.notes !== undefined) updateData.notes = parsed.data.notes;
  if (parsed.data.sectionNotes !== undefined) updateData.sectionNotes = parsed.data.sectionNotes;

  const [row] = await db
    .update(analysesTable)
    .set(updateData)
    .where(eq(analysesTable.id, params.data.id))
    .returning();

  if (!row) {
    res.status(404).json({ error: "Analyse non trouvée" });
    return;
  }

  res.json(
    UpdateAnalysisResponse.parse({
      ...row,
      sections: (row.sections as unknown[]) ?? [],
      sectionNotes: row.sectionNotes ?? undefined,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }),
  );
});

router.delete("/analyses/:id", async (req, res): Promise<void> => {
  const params = DeleteAnalysisParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [row] = await db
    .delete(analysesTable)
    .where(eq(analysesTable.id, params.data.id))
    .returning();

  if (!row) {
    res.status(404).json({ error: "Analyse non trouvée" });
    return;
  }

  res.sendStatus(204);
});

export default router;
