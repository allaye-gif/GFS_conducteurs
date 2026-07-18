import { pgTable, serial, text, timestamp, jsonb, date } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const briefingsTable = pgTable("briefings", {
  id: serial("id").primaryKey(),
  date: date("date").notNull(),
  title: text("title").notNull(),
  notes: text("notes"),
  sections: jsonb("sections").notNull().$type<unknown[]>(),
  sectionNotes: jsonb("section_notes").$type<Record<string, string>>(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertBriefingSchema = createInsertSchema(briefingsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertBriefing = z.infer<typeof insertBriefingSchema>;
export type Briefing = typeof briefingsTable.$inferSelect;
