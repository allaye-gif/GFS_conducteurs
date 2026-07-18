import { pgTable, text, jsonb, timestamp } from "drizzle-orm/pg-core";

export const draftsTable = pgTable("drafts", {
  key: text("key").primaryKey(),
  data: jsonb("data").notNull().$type<Record<string, unknown>>(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type Draft = typeof draftsTable.$inferSelect;
