import { useState } from "react";
import { Link } from "wouter";
import { useListAnalyses } from "@workspace/api-client-react";
import { Input } from "@/components/ui/input";
import { format, parseISO } from "date-fns";
import { fr } from "date-fns/locale";
import { Search, Loader2, ArrowRight } from "lucide-react";

export default function Archives() {
  const [page] = useState(1);
  const { data, isLoading } = useListAnalyses({ page, limit: 100 });
  const [search, setSearch] = useState("");

  const items = data?.items?.filter((a) =>
    a.title.toLowerCase().includes(search.toLowerCase())
  ) ?? [];

  return (
    <div className="space-y-8">

      {/* En-tête */}
      <div className="pt-4 pb-8 border-b border-border">
        <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground mb-5">
          Archives
        </p>
        <h1 className="text-5xl font-bold text-foreground">
          Registre<br />historique
        </h1>
        <p className="text-muted-foreground mt-4 text-sm">
          Toutes les analyses bi-hebdomadaires archivées.
        </p>
      </div>

      {/* Recherche */}
      <div className="flex items-center gap-3 bg-card border border-border rounded-xl px-4 py-2.5">
        <Search className="h-4 w-4 text-muted-foreground/40 shrink-0" />
        <Input
          placeholder="Rechercher par titre…"
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
        <div className="flex items-center justify-center py-20 gap-3">
          <Loader2 className="h-5 w-5 animate-spin text-primary" />
          <p className="text-sm text-muted-foreground">Chargement…</p>
        </div>
      ) : items.length === 0 ? (
        <div className="text-center py-16 border-2 border-dashed border-border rounded-xl">
          <p className="text-sm text-muted-foreground">
            {search ? "Aucun résultat pour cette recherche." : "Aucune analyse archivée."}
          </p>
        </div>
      ) : (
        <div className="border-t border-b border-border divide-y divide-border">
          {items.map((a) => (
            <Link key={a.id} href={`/analyses/${a.id}`}>
              <div className="flex items-center justify-between py-5 hover:bg-muted/50 -mx-3 px-3 rounded transition-colors cursor-pointer group">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-foreground group-hover:text-primary transition-colors truncate">
                    {a.title}
                  </p>
                  <div className="flex items-center gap-4 mt-1 text-xs text-muted-foreground">
                    <span>
                      {format(parseISO(a.periodStart), "dd/MM/yyyy")}
                      {" "}<span className="opacity-40">→</span>{" "}
                      {format(parseISO(a.periodEnd), "dd/MM/yyyy")}
                    </span>
                    <span className="hidden sm:inline">
                      Archivé le {format(parseISO(a.createdAt), "dd MMM yyyy", { locale: fr })}
                    </span>
                  </div>
                </div>
                <ArrowRight className="h-4 w-4 text-muted-foreground/25 group-hover:text-primary/60 transition-colors shrink-0 ml-4" />
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
