---
name: NOAA sources et proxy
description: Leçons sur les URLs NOAA réelles et le comportement du proxy serveur face aux différents domaines NOAA.
---

## Règle centrale
**MAG NCEP (`mag.ncep.noaa.gov`) bloque toutes les requêtes provenant d'IPs datacenter avec 403.** Le proxy serveur ne peut pas récupérer ces images. Elles se chargent normalement dans un navigateur (IP résidentielle). Solution : `directLoad: true` dans le catalogue, le frontend charge directement via `<img>` sans passer par `/api/noaa/proxy`.

**Why:** MAG NCEP a une protection anti-hotlinking basée sur l'IP (datacenter vs résidentielle), pas sur le Referer.

**How to apply:** Dans `noaa-catalog.ts`, toute entrée avec `url` sur `mag.ncep.noaa.gov` doit avoir `directLoad: true`. Dans `noaa-chart-viewer.tsx`, détecter le hostname pour bypasser le proxy.

## URLs CPC réelles (confirmées 200)
Les URLs correctes s'obtiennent en scrapant les pages NOAA, pas en devinant. Pattern de scraping : `curl -s [page] | grep -oE 'src="[^"]*\.(gif|png|jpg)"'`

### MJO (www.cpc.ncep.noaa.gov)
- `/products/precip/CWlink/daily_mjo_index/tm_order_2.gif`
- `/products/intraseasonal/tlon_vpot_web_2.gif`
- `/products/intraseasonal/tlon_vpot_web_850_2.gif`
- `/products/precip/CWlink/MJO/olra_last30days-3plots_2.gif`
- `/products/intraseasonal/irtempanim.gif`
- `/products/intraseasonal/z200anim.gif`
- `/products/intraseasonal/z500_nh_30d_anim.gif`
- `/products/intraseasonal/z500_sh_30d_anim.gif`
- `/products/precip/CWlink/MJO/hov_u850_2.gif`, `hov_u200_2.gif`
- `/products/precip/CWlink/MJO/current_total_850wind_small.gif` etc.
- `/products/people/wd52qz/mjo/chi/ewp.gif`, `gfs.gif`, `cfs.gif`

### ENSO (www.cpc.ncep.noaa.gov)
- `/products/analysis_monitoring/enso_update/sstanim.gif`
- `/products/analysis_monitoring/enso_update/sstaanim.gif`
- `/products/analysis_monitoring/enso_update/olra-30d.gif`
- `/products/analysis_monitoring/enso_update/uv850-30d.gif`, `uv200-30d.gif`
- `/products/analysis_monitoring/enso_update/ssta-week.gif`
- `/products/analysis_monitoring/enso_update/ssta_c.gif`
- `/products/analysis_monitoring/enso_update/ssttlon5_c.gif`
- `/products/analysis_monitoring/ocean/anim/wkxzteq_anm.gif`

### SST (GODAS + PSL)
- `www.cpc.ncep.noaa.gov/products/GODAS/pent_gif/xy/movie.oisst.gif`
- `www.cpc.ncep.noaa.gov/products/GODAS/pent_gif/xy/pent.anom.xy.oisst.30d.gif`
- `psl.noaa.gov/map/images/sst/sst.anom.gif` (nécessite psl.noaa.gov dans proxy allowedHosts)
- `psl.noaa.gov/map/images/sst/sst.anom.month.gif`
- `psl.noaa.gov/map/images/sst/sst.month.gif`

### NAO
- `www.cpc.ncep.noaa.gov/products/precip/CWlink/pna/nao.gefs.fcst.png`

## MAG NCEP GFS Africa — format URL
- Cycle GFS : `YYYYMMDDCC` (00, 06, 12, 18 UTC) — disponible ~5h après le run
- Pattern : `https://mag.ncep.noaa.gov/data/gfs/{cycle}/gfs_africa_{param}_{fhr}.png`
- Paramètres suspectés (non vérifiables depuis datacenter) : `1000-500_thick_slp`, `925_wnd`, `850_wnd`, `700_wnd`, `500_wnd`, `300_wnd`, `200_wnd`, `925_rh`, `850_rh`, etc.
- Area code sur MAG : `AFRICA` (pas `AFR`)

## Proxy serveur — hosts autorisés
Liste à maintenir dans `artifacts/api-server/src/routes/noaa.ts` :
- `www.cpc.ncep.noaa.gov`, `cpc.ncep.noaa.gov`
- `psl.noaa.gov`, `www.psl.noaa.gov`
- `mag.ncep.noaa.gov` (restera 403 mais gardé pour cohérence)

## EUMETSAT `view.eumetsat.int` — WMS public, sans auth (juin 2026)
**Accès public confirmé depuis datacenter.** Retourne des images PNG 300KB–1MB.

**URL de base :** `https://view.eumetsat.int/geoserver/wms?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&CRS=CRS:84&FORMAT=image%2Fpng`
**Bbox Afrique de l'Ouest :** `-25,-10,35,40` (couvre du Sénégal au Tchad, du Golfe de Guinée au Maroc)

**Layers MSG (Meteosat) confirmés 200 OK :**
- `msg_fes:ir108` — IR 10.8µm thermique (nuages, convection) ✓
- `msg_fes:rgb_natural` — RGB couleur naturelle ✓
- `msg_fes:rgb_convection` — RGB convection (ITCZ, MCS) ✓
- `msg_fes:rgb_airmass` — RGB masses d'air (jets, intrusions stratosphériques) ✓
- `msg_fes:rgb_dust` — RGB poussières sahariennes ✓
- `msg_fes:wv062` — Vapeur d'eau 6.2µm (dynamique haute atmosphère) ✓
- `msg_fes:rgb_microphysics`, `msg_fes:rgb_fog`, `mtg_fd:rgb_truecolour`, `mtg_fd:rgb_geocolour` — confirmés dans capabilities

**Pas de layer vent 10m :** EUMETSAT n'expose pas de barbes de vent NWP. Utiliser GFS/CPC pour vents.

**Proxy implémenté :** `/api/briefing/eumetsat/image?layer=...` avec liste blanche de layers.

## WAFFGS — état du serveur (juin 2026)
**Le MapServer PostgreSQL est cassé** : table `waffgs_basins_00_regional_operational` manquante → toutes les requêtes WMS avec layers bassin retournent un PNG 800×600 RGBA entièrement transparent (1941 bytes).

**Ce qui fonctionne :**
- Authentification HTTP Basic avec `WAFFGS_USER`/`WAFFGS_PASS` ✓
- Endpoint `get_latest_time_for_product.php` (POST) retourne `YYYY,MM,DD,HH,offset,` — attention : la réponse contient des warnings PHP HTML avant la ligne de données. Parser avec regex `/^\d{4},/` sur chaque ligne.
- Répertoire EXPORTS accessible en lecture (fichiers `.txt.gz`, `.grd.gz`)
- WMS GetMap retourne toujours HTTP 200 mais PNG transparent

**Proxy implémenté :** `/api/briefing/waffgs/image?product=ASM|FFR&year=YYYY&month=MM&day=DD&hour=HH`
- Header `X-Has-Data: false` quand l'image est transparente (taille < 5000 bytes)
- Le frontend lit ce header via `fetch()` pour décider d'afficher "données indisponibles"

## MISVA — API Sedoo FATS (juin 2026)
**API publique, sans authentification.** Toutes les images MISVA sont accessibles directement depuis un datacenter.

**Endpoint entries :** `https://api.sedoo.fr/sedoo-campaigns-rest-fats/data/v1_0/request?product=X&filter=YYYY-MM-DD&campaign=MISVA`
- Retourne `{ entries: [{ type, media: { content: getimage_url }, levels: [{ name, label, value }] }] }`
- Levels : Level1–Level4 (domaine, paramètre, réseau selon le produit)

**Endpoint image :** `https://api.sedoo.fr/sedoo-campaigns-rest-fats/data/v1_0/getimage?product=X&day=YYYY-MM-DD&file=FILENAME&campaign=MISVA`
- Retourne le GIF/PNG directement (172KB–422KB), HTTP 200

**Produits implémentés (campaign=MISVA) :**
- `Anasyg` — carte synoptique Afrique de l'Ouest (afoc) ; type=at06h (réseau 00), at18h (réseau 12) — 2 images/jour
- `Synopt_Cartes_Prevues` — cartes prévues ECMWF ; Level1=Model, Level2=Domain, Level3=Parameters, Level4=Level-hPa
  - Filtrer : Level1=ECMWF, Level2=WestAfrica, Level3=PW, types 000H/024H/048H/072H/096H
- `synopt_series_prevues` — séries temporelles PW villes ; Level1=Raw, Level2=PW, Level3=Domain, Level4=Ville
  - Villes maliennes : Bamako (CAPITALES), Gao/Kayes/Kidal/Mopti/Segou/Sikasso (MALI)

**Proxy implémenté :** `/api/briefing/misva/image?product=X&day=YYYY-MM-DD&file=FILENAME` (cache 24h)
- Liste blanche products dans `external-proxy.ts`
- Les 3 sections MISVA dans `briefing-catalog.ts` sont maintenant `contentType: "images"` avec fallback J-1 si J=vide

**Autres produits disponibles (non implémentés) :** `Obs_Series`, `Obs_Cartes`, `synopt_hov`, `synopt_lattime`, `synopt_series_eval`, `Cartes_prevues`, `Cartes_evaluees`, `Weekly_Briefings`

## UK Met Africa Viewer — OAuth B2C (juin 2026)
**Login B2C complet fonctionne** avec `UKMET_EMAIL`/`UKMET_PASS`.
- Tenant: `dce84ec6-ce0f-45d1-ba16-e36b817081eb`, Policy: `B2C_1A_warrior_susi`
- Client ID: `2d406bea-fa37-434f-ad84-c9532a8dd1a4`
- Cookie résultant: `AfricaWebViewer-auth_token` (JWT 1h) + `refresh-AfricaWebViewer-auth_token`
- Proxy implémenté dans `artifacts/api-server/src/lib/ukmet-proxy.ts`

**WMS endpoint non trouvé** : l'app AngularJS charge ses layers via `mapApiToken` (MapBox), pas via un WMS publiquement découvrable dans les JS statiques. Les sections Satellite et Vent 10m restent en mode "Externe" (lien vers africawebviewer.metoffice.gov.uk).
