import { useState } from "react";
import { Link } from "wouter";
import { useListBriefings } from "@workspace/api-client-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { format, parseISO } from "date-fns";
import { fr } from "date-fns/locale";
import { Search, Loader2, ArrowRight, Plus } from "lucide-react";

export default function BriefingsArchives() {
  const [page] = useState(1);
  const { data, isLoading } = useListBriefings({ page, limit: 100 });
  const [search, setSearch] = useState("");

  const items = (data?.items ?? []).filter((b) =>
    b.title.toLowerCase().includes(search.toLowerCase()) ||
    b.date.includes(search)
  );

  return (
    <div className="space-y-8">

      {/* En-tête */}
      <div className="pt-4 pb-8 border-b border-border flex items-start justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground mb-5">
            Briefings Quotidiens
          </p>
          <h1 className="text-5xl font-bold text-foreground">
            Archives<br />Briefings
          </h1>
          <p className="text-muted-foreground mt-4 text-sm">
            Tous les briefings quotidiens archivés.
          </p>
        </div>
        <div className="pt-8">
          <Button asChild size="sm" className="gap-2">
            <Link href="/briefings/new">
              <Plus className="h-4 w-4" />
              Nouveau briefing
            </Link>
          </Button>
        </div>
      </div>

      {/* Recherche */}
      <div className="flex items-center gap-3 bg-card border border-border rounded-xl px-4 py-2.5">
        <Search className="h-4 w-4 text-muted-foreground/40 shrink-0" />
        <Input
          placeholder="Rechercher par titre ou date…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="border-0 shadow-none bg-transparent p-0 h-auto text-sm focus-visible:ring-0 placeholder:text-muted-foreground/40"
        />
        {!isLoading && (
          <span className="shrink-0 text-xs bg-muted text-muted-foreground rounded-full px-2 py-0.5 tabular-nums">
            {items.length}
          </span>
        )}
      </div>

      {/* Liste */}
      {isLoading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="h-7 w-7 animate-spin text-muted-foreground" />
        </div>
      ) : items.length === 0 ? (
        <div className="flex flex-col items-center gap-4 py-16 text-center">
          <p className="text-muted-foreground text-sm">Aucun briefing archivé.</p>
          <Button asChild variant="outline">
            <Link href="/briefings/new">Créer un briefing</Link>
          </Button>
        </div>
      ) : (
        <div className="space-y-2">
          {items.map((b) => {
            const dateLabel = format(parseISO(b.date + "T00:00:00"), "EEEE d MMMM yyyy", { locale: fr });
            const archivedAt = format(new Date(b.createdAt), "d MMM yyyy", { locale: fr });
            const sectionCount = Array.isArray(b.sections) ? b.sections.length : 0;

            return (
              <Link key={b.id} href={`/briefings/${b.id}`}>
                <div className="group flex items-center justify-between gap-4 rounded-2xl border border-border bg-card px-6 py-4 hover:border-foreground/30 hover:shadow-sm transition-all cursor-pointer">
                  <div className="space-y-0.5 min-w-0">
                    <p className="text-sm font-semibold text-foreground leading-tight truncate">{b.title}</p>
                    <p className="text-xs text-muted-foreground capitalize">{dateLabel}</p>
                    <p className="text-xs text-muted-foreground/50">
                      Archivé le {archivedAt} · {sectionCount} section{sectionCount > 1 ? "s" : ""}
                    </p>
                  </div>
                  <ArrowRight className="h-4 w-4 text-muted-foreground/30 group-hover:text-foreground/50 shrink-0 transition-colors" />
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
