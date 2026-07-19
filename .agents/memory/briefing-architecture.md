---
name: Briefing Quotidien — architecture
description: Architecture du module briefing quotidien — catalogue, sections, DB, rendu GRIB Synergie
---

## Structure générale

- **Catalogue** : `artifacts/api-server/src/lib/briefing-catalog.ts`
  - Détection GFS cycle : HEAD requests sur CPC (cache 20 min)
  - Détection ECMWF base time : essaie 12Z→06Z→00Z via `charts.ecmwf.int/opencharts-api/v1/products/medium-mslp-rain/` (cache 30 min)
  - Sections : satellite, pmer-pluie, vent-10m, rh-850, rh-700, tmax-gfs, asm-waffgs, ffr-icon-waffgs, pluie-ecmwf, pluie-icon, synergie
- **Section contentType** : `images` (proxy `/api/noaa/proxy`) | `iframe` (Windy) | `external` (UK Met, WAFFGS)
- **DB** : table `briefings` (date, title, notes, sections JSONB, sectionNotes JSONB)
- **Proxy NOAA** : hosts autorisés dans `noaa.ts` (dont `charts.ecmwf.int`)

## Rendu GRIB Synergie (SYABAN02, GFSAFR025)

Rendu SVG maison — pas de dépendance à `visu_modele`/X11. Fichiers :
- `grib-extract.ts` : extraction GRIB brute (SSH) → `GribGrid` (ni/nj/lat0/lon0/lat1/lon1/values)
- `grib-render.ts` : `renderGribSvg()`, point d'entrée principal, + `SCALES` (config par champ)
- `grib-coastline.ts` / `grib-borders.ts` : traits de côte / frontières politiques (Natural Earth, domaine public)
- `grib-contour.ts` : marching squares (`traceContours`), lissage gaussien (`smoothField`), détection d'extrema (`findExtrema`)
- `grib-ridge.ts` : axes de dorsale/thalweg par analyse du Hessien (courbure)
- `grib-vorticity.ts` / `grib-vorticity-render.ts` : tourbillon absolu combo (TA), rendu séparé (pas via `renderGribSvg`)
- `routes/synergie.ts` : `GFS_PARAMS` (catalogue param→config), dispatch extraction+rendu

**Contrainte d'environnement** : le sandbox dev bloque toute connexion réseau sortante vers SYABAN02 (même via le client SSH légitime de l'appli) — tout ce module est validé avec des grilles synthétiques, jamais de vraies données. À revalider sur le vrai flux dès que possible.

### Style par champ (état actuel)

Chaque champ suit sa propre référence visuelle Synergie — **ne pas généraliser le style d'un champ aux autres sans validation explicite**, c'est arrivé plusieurs fois et a dû être défait.

- **PMER** (`SCALES.pmer`) : isolignes rouges (`#e60000`) sur fond blanc pur, pas d'axes/villes, cartouche titre en overlay coin haut-gauche. Isobares tous les 2 hPa, épaisses/pleines tous les 4 hPa sinon fines pointillées. Centres A/D (`findExtrema`) en bleu marine. Axes dorsale/thalweg (`grib-ridge.ts`) en overlay, un seul label par axe sur toute la carte.
- **T2M** (`SCALES.temp`) : contrairement à PMER, garde un **aplat de couleur** sous les isothermes (`ContourOptions.withFill: true` — Synergie superpose aplat + isothermes noirs, pas des lignes seules). Isothermes en noir (`#1a1a1a`, pas une teinte du dégradé — contraste garanti sur n'importe quel fond). Aplat lissé (même champ gaussien que les isolignes, `sharedField`) pour éviter l'effet "blocky". Légende compacte en bas-à-gauche pour tout champ `hasIsolines && showFill` (contrairement à PMER/humidité qui n'ont pas d'aplat continu, donc pas de légende séparée).
  - **Couleur = bandes discrètes tous les 2°C** (`bandBoundaries`), pas un dégradé continu — même à fort contraste (essayé : ColorBrewer YlOrRd jaune pâle→rouge sombre), un dégradé lisse ne permet jamais de voir un écart de quelques degrés aussi nettement qu'un vrai changement de palier de couleur. Confirmé par les tables de couleur météo opérationnelles (NCL "temp_19lev", GEMPAK) qui utilisent toutes des bandes, pas des dégradés — l'utilisateur a explicitement demandé que "la moindre diff de temp soit décelable directement" (indicateur d'activité orageuse via chutes/hausses j+1). Bornes alignées exactement sur les niveaux d'isothermes (16,18,...,40) pour que bande et isotherme coïncident.
- **Humidité** (`SCALES.humidity`, HU850/HU700 partagent la même config) : isohumes sur fond parchemin (`#f5f1dc`), style Synergie. Chaque isoligne prend sa couleur sur un dégradé rose clair → magenta Synergie exact (`#c026a3`) selon la valeur (`gradientColor: true`) — plus c'est humide, plus foncé. Remplissage plein en `#c026a3` uniquement au-delà de 95% (quasi-saturation). Légende explicite en overlay (pastille + seuil + pas des isolignes).
- **Précip/Vent** (`SCALES.precip`/`wind`/`windUpper`) : aplat dégradé continu classique (axes, légende barre+graduations, villes) — style dashboard d'origine, inchangé. FF10/FF850 (vent) ont en plus des barbules météo (`windBarbSvg`) dessinées par-dessus le dégradé (échantillonnage plus lâche que l'aplat). FF850 utilise `windUpper` (0-25 m/s, flux d'altitude plus fort que le vent 10m).
- **TA / TOURCOMBO** (tourbillon absolu 850/700/200 hPa) : rendu séparé (`grib-vorticity-render.ts`), PAS de lissage ni de filtre anti-confetti (la texture dense et turbulente est le signal réel, contrairement à PMER) — fond parchemin, isolignes denses (pas ~80-100 unités) en rouge/vert/bleu (850/700/200), légende avec plages numériques dans le libellé.

### Mécanismes génériques disponibles (non branchés partout)

- `BandScale`/`deriveBands`/`bandColorAt` (`grib-render.ts`) : légende à bandes discrètes façon NOAA (blocs pleins + seuils écrits entre blocs). Codé mais pas utilisé actuellement sur aucun champ (tenté sur humidité/vent/précip, défait — l'utilisateur voulait garder les styles Synergie/dégradé déjà validés).
- `ContourOptions.highlightAbove?: { threshold, color, label }` : remplissage plein au-delà d'un seuil + légende (utilisé par l'humidité).
- `ContourOptions.gradientColor?: boolean` : couleur d'isoligne dérivée du dégradé continu du champ à sa valeur, au lieu d'une couleur fixe (utilisé par l'humidité, pas par T2M/PMER).
- Cartouche titre en overlay : largeur calculée dynamiquement selon la longueur du titre (bug fixé — une largeur fixe tronquait les titres longs comme "Humidité 850 hPa").

## ECMWF API format
```
GET https://charts.ecmwf.int/opencharts-api/v1/products/medium-mslp-rain/?base_time={ISO}&valid_time={ISO}&projection=opencharts_africa
→ { data: { link: { href: "https://charts.ecmwf.int/content/....png" } } }
```
**Why:** ECMWF fournit des images publiques via une API JSON — pas d'auth requise, mais les URLs changent à chaque run. Doit être fetchée côté serveur pour éviter CORS et mettre en cache.
