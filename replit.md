# Météo Analyste

Application d'analyse météorologique bihedomadaire NOAA — automatise la collecte de cartes NOAA (MJO, ENSO, SST, NAO, GFS Afrique de l'Ouest) et archive les analyses dans une base de données PostgreSQL.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 8080)
- `pnpm --filter @workspace/meteo-analyste run dev` — run the frontend (port 20168)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)
- Frontend: React + Vite + TailwindCSS + shadcn/ui

## Where things live

- `lib/api-spec/openapi.yaml` — OpenAPI spec (source of truth for all contracts)
- `lib/db/src/schema/analyses.ts` — Drizzle schema for analyses table
- `artifacts/api-server/src/routes/analyses.ts` — CRUD analyses routes
- `artifacts/api-server/src/routes/noaa.ts` — NOAA proxy + catalog routes
- `artifacts/api-server/src/lib/noaa-catalog.ts` — catalogue des URLs NOAA par section
- `artifacts/meteo-analyste/src/` — React frontend
- `lib/api-client-react/src/generated/` — generated React Query hooks (do not edit)
- `lib/api-zod/src/generated/` — generated Zod schemas (do not edit)

## Architecture decisions

- **NOAA proxy côté serveur** : toutes les images NOAA passent par `/api/noaa/proxy?url=...` pour contourner CORS et permettre la mise en cache côté serveur (Cache-Control: 30 min).
- **Catalogue NOAA statique** : les URLs NOAA sont hardcodées dans `noaa-catalog.ts` — les pages NOAA changent rarement. Si une URL ne charge pas, mettre à jour ce fichier.
- **sections JSON dans PostgreSQL** : les sections d'une analyse sont stockées comme `jsonb` pour capturer l'état exact des cartes NOAA au moment de l'archivage (snapshot point-in-time).
- **Contract-first** : OpenAPI spec → codegen → types TypeScript partagés frontend/backend, jamais d'écriture manuelle de types dupliqués.

## Product

- **Tableau de bord** (`/`) : résumé des analyses archivées, analyses récentes, bouton "Nouvelle Analyse"
- **Nouvelle Analyse** (`/new`) : sélection de période, chargement automatique des cartes NOAA en sections accordéon (MJO, ENSO, SST, NAO, GFS Afrique de l'Ouest), notes libres, sauvegarde en base
- **Archives** (`/archives`) : liste paginée et filtrable de toutes les analyses archivées
- **Détail Analyse** (`/analyses/:id`) : vue complète avec toutes les cartes, notes éditables, suppression

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

- Après toute modification du spec OpenAPI, relancer `pnpm --filter @workspace/api-spec run codegen` avant d'utiliser les nouveaux types.
- Les URLs NOAA (CPC, MAG) peuvent changer ou retourner des 404 temporaires — le proxy retourne le status code NOAA tel quel, géré côté frontend avec un fallback visuel.
- Le tableau `analyses` utilise `jsonb` pour `sections` — Drizzle retourne ce champ tel quel depuis PostgreSQL, caster en `unknown[]` suffit.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
- NOAA CPC charts: https://www.cpc.ncep.noaa.gov/products/precip/CWlink/MJO/
- NOAA MAG charts: https://mag.ncep.noaa.gov/
