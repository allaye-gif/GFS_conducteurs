import { useGetAnalysesSummary } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Link } from "wouter";
import { ArrowUpRight, ArrowRight, Loader2 } from "lucide-react";
import { format, parseISO, getDate, getDaysInMonth } from "date-fns";
import { fr } from "date-fns/locale";

function nextBiweeklyPeriod(): { start: Date; end: Date } {
  const today = new Date();
  const day = getDate(today);
  if (day <= 15) {
    return {
      start: new Date(today.getFullYear(), today.getMonth(), 16),
      end: new Date(today.getFullYear(), today.getMonth(), getDaysInMonth(today)),
    };
  }
  const next = new Date(today.getFullYear(), today.getMonth() + 1, 1);
  return { start: next, end: new Date(next.getFullYear(), next.getMonth(), 15) };
}

export default function Dashboard() {
  const { data: summary, isLoading } = useGetAnalysesSummary();
  const next = nextBiweeklyPeriod();

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[40vh]">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="space-y-12">

      {/* Hero */}
      <div className="pt-4 pb-8 border-b border-border">
        <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground mb-5">
          Tableau de bord
        </p>
        <div className="flex items-end justify-between gap-6 flex-wrap">
          <h1 className="text-5xl font-bold leading-tight text-foreground">
            Analyses<br />bi-hebdomadaires
          </h1>
          <Button asChild className="bg-primary text-primary-foreground hover:bg-primary/90 gap-2 shrink-0"
            data-testid="button-new-analysis">
            <Link href="/new">
              Nouvelle analyse <ArrowUpRight className="h-4 w-4" />
            </Link>
          </Button>
        </div>
        <p className="text-muted-foreground mt-4 text-sm">
          Surveillance météorologique — Afrique de l'Ouest
        </p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-5">
        <div className="bg-card border border-border rounded-xl p-6">
          <p className="text-xs font-semibold text-muted-foreground/60 uppercase tracking-widest mb-4">01</p>
          <p className="text-6xl font-bold text-foreground tabular-nums leading-none mb-2">
            {summary?.total ?? 0}
          </p>
          <p className="text-sm text-muted-foreground">Analyses archivées</p>
        </div>

        <div className="bg-card border border-border rounded-xl p-6">
          <p className="text-xs font-semibold text-muted-foreground/60 uppercase tracking-widest mb-4">02</p>
          <p className="text-3xl font-bold text-foreground leading-tight mb-2">
            {summary?.lastAnalysisDate
              ? format(parseISO(summary.lastAnalysisDate), "dd MMM yyyy", { locale: fr })
              : "—"}
          </p>
          <p className="text-sm text-muted-foreground">Dernière analyse</p>
        </div>

        <div className="bg-card border border-border rounded-xl p-6">
          <p className="text-xs font-semibold text-muted-foreground/60 uppercase tracking-widest mb-4">03</p>
          <p className="text-2xl font-bold text-foreground leading-tight mb-2">
            {format(next.start, "d MMM", { locale: fr })}
            <span className="text-muted-foreground/50 mx-2 font-normal">→</span>
            {format(next.end, "d MMM", { locale: fr })}
          </p>
          <p className="text-sm text-muted-foreground">Prochaine période</p>
        </div>
      </div>

      {/* Récentes */}
      {summary?.recentAnalyses?.length ? (
        <div>
          <div className="flex items-center justify-between mb-5">
            <h2 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
              Analyses récentes
            </h2>
            <Link href="/archives"
              className="text-sm text-primary hover:underline underline-offset-4 flex items-center gap-1">
              Voir tout <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </div>
          <div className="border-t border-b border-border divide-y divide-border">
            {summary.recentAnalyses.map((a) => (
              <Link key={a.id} href={`/analyses/${a.id}`}>
                <div className="flex items-center justify-between py-4 hover:bg-muted/50 -mx-3 px-3 rounded transition-colors cursor-pointer group">
                  <div>
                    <p className="text-sm font-semibold text-foreground group-hover:text-primary transition-colors">
                      {a.title}
                    </p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {format(parseISO(a.periodStart), "dd/MM/yyyy")}
                      {" "}<span className="opacity-40">→</span>{" "}
                      {format(parseISO(a.periodEnd), "dd/MM/yyyy")}
                    </p>
                  </div>
                  <ArrowRight className="h-4 w-4 text-muted-foreground/25 group-hover:text-primary/60 transition-colors shrink-0" />
                </div>
              </Link>
            ))}
          </div>
        </div>
      ) : (
        <div className="text-center py-16 border-2 border-dashed border-border rounded-xl">
          <p className="text-muted-foreground text-sm">Aucune analyse enregistrée.</p>
          <Button asChild variant="outline" className="mt-4">
            <Link href="/new">Créer la première analyse</Link>
          </Button>
        </div>
      )}
    </div>
  );
}
