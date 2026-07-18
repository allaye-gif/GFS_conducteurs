import { Link, useLocation } from "wouter";
import { cn } from "@/lib/utils";

const NAV = [
  { name: "Tableau de bord", href: "/" },
  { name: "Nouvelle analyse", href: "/new" },
  { name: "Archives", href: "/archives" },
  { name: "Briefing Quotidien", href: "/briefings/new" },
  { name: "Archives Briefings", href: "/briefings/archives" },
  { name: "🔍 SYABAN02", href: "/synergie/explorer" },
];

export default function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">

      {/* ── Barre de navigation simple ── */}
      <header className="border-b border-border bg-background sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-8 h-14 flex items-center justify-between">
          <Link href="/" className="text-sm font-semibold text-foreground tracking-tight shrink-0">
            Météo Analyste
          </Link>
          <nav className="flex items-center gap-0.5 overflow-x-auto">
            {NAV.map((item) => {
              const active =
                location === item.href ||
                (item.href !== "/" && item.href !== "/new" && location.startsWith(item.href.split("/")[1] ? "/" + item.href.split("/")[1] : "__"));
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    "px-3 py-1.5 rounded-md text-sm transition-colors whitespace-nowrap",
                    active
                      ? "bg-primary text-primary-foreground font-medium"
                      : "text-muted-foreground hover:text-foreground hover:bg-muted"
                  )}
                  data-testid={`nav-${item.name.toLowerCase().replace(/\s+/g, "-")}`}
                >
                  {item.name}
                </Link>
              );
            })}
          </nav>
        </div>
      </header>

      {/* ── Contenu ── */}
      <main className="flex-1 max-w-6xl mx-auto w-full px-8 py-10">
        {children}
      </main>
    </div>
  );
}
