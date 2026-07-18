import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, draftsTable } from "@workspace/db";

const LEGACY_KEY = "analysis_draft";
const router: IRouter = Router();

// ── Routes génériques avec clé arbitraire ────────────────────────────────────

router.get("/draft/:key", async (req, res): Promise<void> => {
  const key = req.params.key;
  const rows = await db.select().from(draftsTable).where(eq(draftsTable.key, key)).limit(1);
  res.json({ data: rows[0]?.data ?? null });
});

router.put("/draft/:key", async (req, res): Promise<void> => {
  const key = req.params.key;
  const data = req.body as Record<string, unknown>;
  await db
    .insert(draftsTable)
    .values({ key, data, updatedAt: new Date() })
    .onConflictDoUpdate({ target: draftsTable.key, set: { data, updatedAt: new Date() } });
  res.json({ ok: true });
});

router.delete("/draft/:key", async (req, res): Promise<void> => {
  await db.delete(draftsTable).where(eq(draftsTable.key, req.params.key));
  res.json({ ok: true });
});

// ── Legacy routes (backward compat) ──────────────────────────────────────────

router.get("/draft", async (req, res): Promise<void> => {
  const rows = await db.select().from(draftsTable).where(eq(draftsTable.key, LEGACY_KEY)).limit(1);
  res.json({ data: rows[0]?.data ?? null });
});

router.put("/draft", async (req, res): Promise<void> => {
  const data = req.body as Record<string, unknown>;
  await db
    .insert(draftsTable)
    .values({ key: LEGACY_KEY, data, updatedAt: new Date() })
    .onConflictDoUpdate({ target: draftsTable.key, set: { data, updatedAt: new Date() } });
  res.json({ ok: true });
});

router.delete("/draft", async (req, res): Promise<void> => {
  await db.delete(draftsTable).where(eq(draftsTable.key, LEGACY_KEY));
  res.json({ ok: true });
});

export default router;
