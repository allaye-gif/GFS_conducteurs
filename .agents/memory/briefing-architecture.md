---
name: Briefing Quotidien — architecture
description: Architecture du module briefing quotidien — catalogue, sections, DB, frontend
---

## Structure

- **Catalogue** : `artifacts/api-server/src/lib/briefing-catalog.ts`
  - Détection GFS cycle : HEAD requests sur CPC (cache 20 min)
  - Détection ECMWF base time : essaie 12Z→06Z→00Z via `charts.ecmwf.int/opencharts-api/v1/products/medium-mslp-rain/` (cache 30 min)
  - 11 sections : satellite, pmer-pluie, vent-10m, rh-850, rh-700, tmax-gfs, cape, asm-waffgs, ffr-icon-waffgs, pluie-ecmwf, pluie-icon

- **Section contentType** : `images` | `iframe` | `external`
  - `images` : subsections[].charts[].url → proxy via `/api/noaa/proxy`
  - `iframe` : iframeUrl (Windy embed)
  - `external` : externalUrl + externalLabel (UK Met, WAFFGS)

- **DB** : table `briefings` (date, title, notes, sections JSONB, sectionNotes JSONB)

- **Proxy NOAA** : `charts.ecmwf.int` ajouté à ALLOWED_HOSTS dans `noaa.ts`

- **GFS Tmax** : utilise `tmp_2m` (peut être 404 selon run) — à vérifier si besoin, possible fallback `2m_tmax`

## ECMWF API format
```
GET https://charts.ecmwf.int/opencharts-api/v1/products/medium-mslp-rain/?base_time={ISO}&valid_time={ISO}&projection=opencharts_africa
→ { data: { link: { href: "https://charts.ecmwf.int/content/....png" } } }
```

**Why:** ECMWF fournit des images publiques via une API JSON — pas d'auth requise, mais les URLs changent à chaque run. Doit être fetchée côté serveur pour éviter CORS et mettre en cache.
