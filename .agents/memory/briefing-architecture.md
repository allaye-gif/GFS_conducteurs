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

## Rendu GRIB Synergie — frontières + isolignes (juillet 2026)

Le rendu SVG maison (`grib-render.ts`) a été enrichi pour se rapprocher d'une
vraie carte synoptique, en plus des côtes déjà tracées :
- **Frontières politiques** : `grib-borders.ts` (Natural Earth 1:50m admin-0
  boundary lines, domaine public), découpé sur la même emprise que
  `grib-coastline.ts` (lon -27/28, lat -4/43). Tracé en tirets gris fin pour
  rester distinct des côtes (traits pleins).
- **Isolignes** : `grib-contour.ts` fait du marching squares sur le champ
  transformé (unité affichée, pas les valeurs brutes GRIB) à pleine résolution
  — indépendant du sous-échantillonnage `STEP` utilisé pour l'aplat couleur —
  puis chaîne les segments en polylignes continues (clé = coordonnées exactes
  des points d'intersection, qui coïncident entre cellules voisines). Activé
  pour PMER (isobares, pas 2 hPa, plein rouge foncé) et T2M (isothermes, pas
  2°C, bleu marine tirets) via `RenderOptions.contours` dans `SCALES`.
- Pas encore fait : isolignes pour humidité/précip/vent (non demandé), barbules
  de vent, augmentation de résolution du champ couleur lui-même (STEP=2 reste
  en place, seules les isolignes utilisent la grille pleine résolution).

**Correction de style (comparaison avec une vraie capture Synergie)** : le
premier essai (fond blanc, aplat de couleur + isolignes fines, frontières
grises pointillées) était visuellement trop éloigné du vrai rendu Synergie.
Repris pour coller au style observé :
- Champs à isolignes (PMER/T2M) : **aucun aplat de couleur** — fond uni
  parchemin (`#f5f1dc`) avec uniquement les isolignes dessus, pas de légende
  couleur (les valeurs sont portées par les étiquettes sur les lignes). Le flag
  interne `noFill` dans `renderGribSvg` (= `!!opts.contours`) contrôle ça.
- Côtes et frontières : noir plein (`#000000`), pas de gris/tirets — même
  registre visuel que Synergie où les deux se valent visuellement.
- Grille lat/lon : magenta pleine (`#c026a3`), pas de gris pointillé.
- Étiquettes d'isolignes : répétées tous les ~130px le long d'une même ligne
  (pas une seule au milieu), avec un point final ("1006.") comme sur Synergie ;
  les tout petits contours de bruit (< 45px) ne sont pas labellisés.
- Couleurs isolignes : rouge (`#b3261c`) pour PMER, brun/orange (`#a15a00`)
  pour T2M — pas de bleu/tirets (hypothèse initiale invalidée par la capture).

**Deuxième correction (retour utilisateur détaillé sur PMER)** : même après la
première correction de style, le rendu restait en "confetti" (des centaines de
petits contours fermés parasites issus du bruit du champ GFS brut à pleine
résolution) au lieu d'isobares longues et continues comme une vraie carte
Synergie. Root cause + fix :
- **Lissage gaussien** (`smoothField` dans `grib-contour.ts`, séparable,
  sigma=2 cellules de grille) appliqué au champ *avant* le marching squares —
  élimine l'essentiel du bruit haute fréquence responsable du confetti.
- **Filtre d'aire** (`MIN_CLOSED_AREA_PX2` = 1400 px² dans `grib-render.ts`) :
  tout contour fermé résiduel sous ce seuil est purement et simplement ignoré
  (pas juste non-labellisé) — tue le confetti restant après lissage.
- **1-2 étiquettes par ligne** (pas une répétition tous les 130px) : 1 étiquette
  au milieu, 2 (à 30%/70%) si la ligne dépasse 500px de long.
- **Épaisseur différenciée** : isolignes multiples de 10 tracées à 2.4px vs
  1.7px pour les autres — convention météo classique.
- **Couleur finale** : rouge vif `#e60000` (pas bordeaux sombre) pour PMER,
  orange `#e65c00` pour T2M.
- **Centres H/D** : `findExtrema` dans `grib-contour.ts` détecte les
  minima/maxima locaux sur le champ lissé (fenêtre 5°, séparation min 5°,
  marge de bord 8% pour ignorer les faux extrema de coupure de domaine).
  Rendus en bleu marine `#0033cc`, symbole serif gras ("A"=anticyclone,
  "D"=dépression) + valeur en dessous. Uniquement pour PMER (pas de sens pour
  une température) via `ContourOptions.extrema`.
- **Fond blanc pur** (pas parchemin) pour les cartes à isolignes, **sans axes
  ni graduations degrés** (juste la grille magenta `#d060a0`), cadre noir 1px
  simple.
- **Pas de noms de villes** sur les cartes à isolignes (seuls H/D) — gardés
  uniquement sur les cartes en aplat (humidité/précip/vent).
- **Titre en overlay** dans le coin supérieur gauche de la carte elle-même
  (encart blanc semi-opaque, "Pmer" + heure réseau ex. "0600" en gras noir),
  au lieu du bandeau externe — `RenderOptions.overlayTime` passé depuis
  `routes/synergie.ts` (`${rHH}00`).
- Tout ce comportement (`noFill`) est conditionné à la présence de
  `opts.contours` — les cartes en aplat (humidité/précip/vent) gardent le style
  tableau de bord d'origine (axes, légende couleur, villes) sauf le
  rafraîchissement commun (côtes/frontières plus épaisses, grille magenta).
- Validé avec un champ PMER synthétique bruité incluant un anticyclone saharien
  isolé ET un creux fermé (pas juste un thalweg est-ouest, qui ne produit pas
  un minimum local strict) — les deux centres A/D ressortent correctement avec
  leur valeur.

## Dorsale / thalweg (nouveauté, juillet 2026)

**Contexte** : impossible d'accéder à SYABAN02 depuis l'environnement de dev
pour lire une éventuelle doc/config Synergie interne sur le tracé des
dorsales/thalwegs — le sandbox bloque toute connexion réseau sortante directe,
même via le client SSH légitime de l'appli (`ssh2`, échoue au niveau du
classifieur, pas du réseau). Recherche web publique sur Synergie/Météo-France :
aucune doc technique publique (logiciel interne propriétaire, jamais
open-source). Implémentation basée sur la définition météorologique standard
(dorsale = prolongement d'un anticyclone, thalweg = prolongement d'une
dépression, courbure anticyclonique/cyclonique — cf. Futura-Sciences,
NOAA jetstream, ScienceGuys) traduite mathématiquement en détection de
"height ridge/valley" (analyse de terrain), PAS une reproduction d'une
convention Synergie existante — c'est un ajout expérimental, pas un correctif
visuel comme les points précédents.

- **`grib-ridge.ts`** : calcule le Hessien du champ (lissé sigma=3.5,
  lissage supplémentaire nécessaire car les dérivées secondes amplifient le
  bruit) en différences finies, décompose en valeurs/vecteurs propres. Un axe
  de dorsale est le lieu où la dérivée directionnelle projetée sur le vecteur
  propre de courbure la plus concave (valeur propre la plus négative) s'annule,
  masqué aux points où cette courbure dépasse un seuil (`curvatureThreshold`,
  défaut 0.006 hPa/cellule²) ; le thalweg est l'analogue avec la courbure la
  plus convexe (valeur propre positive). Réutilise `traceContours` en lui
  passant ce champ dérivé masqué (niveau=0) — technique de zero-crossing
  standard, pas de nouvel algorithme de traçage.
- Rendu dans `grib-render.ts` : dorsale en orange/brun (`#b45309`) dash-dot,
  thalweg en indigo (`#4338ca`) tireté, étiquette italique une fois par ligne
  si assez longue. Uniquement activé pour PMER (`SCALES.pmer.contours.
  ridgeTrough`) — pas de sens physique pour une température. Les boucles
  fermées sont ignorées (un axe dorsale/thalweg est une ligne ouverte).
- **Validé** avec un motif synthétique "4 cellules" (2 hautes + 2 basses en
  diagonale, cas classique de test dorsale/thalweg) : les axes ressortent bien
  orientés vers l'autre centre de même type, mais ne forment pas une ligne
  parfaitement continue traversant le point-col central — chaque système
  produit son propre segment local correctement orienté. À affiner si le rendu
  sur données réelles SYABAN02 le justifie (ajuster `curvatureThreshold`,
  `extraSmoothSigma`).

**Correction "illisible" (même jour)** : le premier essai calculait le Hessien
directement sur la grille fine (0.25°, même après lissage sigma=3.5) — les
dérivées secondes amplifient tellement le bruit résiduel que ça produisait des
lignes de dorsale/thalweg en dents de scie façon griffonnage, illisibles et
moches. Fix dans `grib-ridge.ts` :
- Le Hessien est maintenant calculé sur une grille **fortement dégradée**
  (`resampleBilinear`, ~1.6° de maille au lieu de 0.25°) plutôt que sur la
  grille fine — à cette échelle le champ est quasi plat après lissage, donc les
  lignes ressortent naturellement longues et propres, sans post-traitement de
  simplification nécessaire.
- Dérivées normalisées en unité "par degré" / "par degré²" (pas "par cellule")
  pour que `curvatureThreshold` (défaut 0.12 hPa/deg²) reste valable quelle que
  soit la résolution de la grille utilisée.
- Au rendu (`grib-render.ts`) : **une seule étiquette "Dorsale"/"Thalweg" par
  type sur toute la carte** (sur le segment le plus long), pas une par segment
  — avant ça, chaque petit fragment portait son étiquette et ça surchargeait la
  carte en plus des étiquettes d'isobares.

## Passe de finition style (spec détaillée, juillet 2026)

Troisième itération sur le rendu PMER, suite à une checklist utilisateur très
précise (hiérarchie visuelle, étiquettes, nettoyage, habillage). Changements
dans `grib-render.ts` :
- **Hiérarchie isobares** : une isobare sur deux (multiples de 4 hPa — le pas
  reste 2 hPa donc ça alterne naturellement) tracée en plein épais (2px) ;
  les intermédiaires en pointillé fin (0.8px, `stroke-dasharray="1,2.5"`).
- **Étiquettes** : une seule par ligne (plus de 2 sur les longs tracés), posée
  sur le point le plus "droit" du tiers central du tracé (score de courbure via
  angle entre segments consécutifs) pour éviter les coudes, fond blanc
  semi-opaque (`fill-opacity 0.78`) derrière le chiffre au lieu du halo blanc en
  `paint-order:stroke`, police Arial explicite, format entier sans point final.
- **Confetti** : seuil d'aire passé d'une constante absolue en px² à une
  fraction relative de l'aire de la carte (`MIN_CLOSED_AREA_FRAC = 0.005`, soit
  0.5%) — plus robuste si `WIDTH`/`HEIGHT` changent. Lissage gaussien
  pré-contourage réduit de sigma=2 à sigma=1.5.
- **Fond/grille/traits** : grille magenta éclaircie (`#d8a0c0`, 0.3px, contre
  `#d060a0`/0.6px avant), côtes et frontières à 1.2px (au lieu de 1.6/1.4).
- **Format canvas** : ratio 4:3 fixe (`HEIGHT` passé de 640 à 675 pour
  `WIDTH=900`).
- **Dorsale/thalweg** : thalweg repassé en pointillé fin (`"1.5,3"`, plus
  "pointillé" que le tireté précédent) ; dorsale gardée en tireté-point
  (`"9,3,2,3"`).

## Nouveaux champs : flux 850 hPa + tourbillon absolu combo (juillet 2026)

- **FF850 ("Flux 850 hPa")** : même mécanisme que FF10 (vent = magnitude U/V),
  mais niveau pression 850HPA (combinaison "P", pas "H") et échelle dédiée
  `SCALES.windUpper` (0-25 m/s au lieu de 0-15 — le flux d'est africain vers
  850 hPa peut largement dépasser le vent de surface). Au passage, fixé un bug
  latent : `scaleKey` était hardcodé à `"wind"` dans `renderGribToLocalFile`
  pour tous les `WindParamDef`, ce qui aurait ignoré `windUpper`.
- **TOURCOMBO ("Tourbillon absolu 850/700/200 hPa")** : champ spécial demandé
  explicitement — superposition du tourbillon absolu (ζ+f) à 3 niveaux pour
  repérer le couplage convergence basse couche / divergence en altitude
  (diagnostic classique ondes d'est africaines). Réglages donnés par
  l'utilisateur : plage 10 à 1000 (×10⁻⁷ s⁻¹) pour 850/700 hPa, -1000 à 0 pour
  200 hPa.
  - `grib-vorticity.ts` : `computeAbsoluteVorticityX1e7(uGrid, vGrid)` — dérivées
    en degrés→mètres (pas "par cellule de grille", comme pour `grib-ridge.ts`),
    f = 2Ω·sin(lat). L'échelle ×10⁷ est calibrée exprès : f seul vaut déjà
    ~300-400 vers 12-15°N sous cette échelle, ce qui correspond bien à la
    plage 10-1000 donnée par l'utilisateur.
  - **Piège rencontré et corrigé** : premier essai en aplats de couleur
    semi-transparents empilés (un peu comme un "réglage min/max" classique) —
    complètement illisible, parce que 850 et 700 hPa sont dominés par la même
    vorticité planétaire de fond et se superposent sur la quasi-totalité du
    domaine, donnant un lavis gris-bleu terne au lieu de zones distinctes.
    Passé en **isolignes de seuil** (comme les isobares PMER) : 2 seuils par
    niveau (200/600 pour 850-700, -200/-600 pour 200 hPa), une couleur+style de
    trait par niveau (850 vert plein, 700 violet tireté, 200 bleu pointillé),
    légende à traits colorés. `grib-vorticity-render.ts` dessine sa propre
    base map (côtes/frontières/grille, dupliquée depuis `grib-render.ts` plutôt
    qu'un refactor partagé risqué sous contrainte de temps).
  - **Limite connue, pas un bug** : comme c'est du tourbillon *absolu* (pas
    relatif), les isolignes les plus faibles (200/-200) suivent aussi de pures
    bandes de latitude loin de tout système (là où f seul franchit le seuil) —
    normal physiquement, mais peut lire comme du bruit sans rapport avec un
    système réel. Si ça gêne à l'usage, passer en tourbillon relatif (retirer
    le terme `+f`) éliminerait cet artefact.
- Testé avec un vortex synthétique cyclonique à 850/700 hPa (centres légèrement
  décalés) et un vortex anticyclonique à 200 hPa (décalé aussi) — les 3 anneaux
  ressortent bien distincts et positionnés correctement.
- Wiring complet : `GFS_PARAMS` (routes/synergie.ts) + `SYNERGIE_LIVE_PARAMS`
  (briefing-catalog.ts) — les deux nouveaux champs apparaissent automatiquement
  dans la section briefing Synergie.

**Correction de style TA (même jour, après capture Synergie réelle)** : la
première version (isolignes propres, 2 seuils par niveau, tirets) ne
correspondait pas à la vraie carte "TA" de Synergie, qui montre un maillage
dense et texturé de petites boucles fermées dans 3 couleurs pleines sur fond
parchemin — c'est la signature réelle et informative d'un champ de tourbillon
(naturellement turbulent), **pas du bruit à lisser/filtrer comme pour les
isobares PMER**. Point important à retenir : **ne pas appliquer
systématiquement le traitement PMER (lissage, anti-confetti, épuration) à tous
les champs** — chaque type de champ a sa propre convention visuelle Synergie,
à vérifier au cas par cas plutôt qu'à généraliser.
- `grib-vorticity-render.ts` : suppression totale du filtre anti-confetti et
  du lissage — le champ de tourbillon (déjà non lissé dans
  `grib-vorticity.ts`) est contouré tel quel.
- Niveaux de contour densifiés (pas ~100 unités sur toute la plage, au lieu de
  2 seuils isolés) pour retrouver le maillage fin de la référence.
- Fond parchemin (`#f5f1dc`, pas blanc) — contrairement à PMER où le blanc pur
  a été demandé explicitement, cette carte-ci suit sa propre référence.
- Trait uniforme (1px, plein, sans tirets) par couleur — 850 rouge, 700 vert,
  200 bleu (couleurs alignées sur la capture réelle) ; plus d'étiquettes
  numériques sur les lignes (absentes de la référence).
- Côtes/frontières dessinées **par-dessus** le maillage de tourbillon (pas
  dessous) pour rester nettes, comme sur la référence.
- Testé avec un champ de vent synthétique "turbulent" (superposition de
  sinusoïdes à plusieurs échelles) — texture dense confirmée, mais le motif
  reste trop régulier ("nid d'abeille") car périodique par construction ; seul
  un test sur données réelles SYABAN02 validera l'aspect organique final.

**Correction "nid d'abeille" (même jour, après retour utilisateur sur mon
propre test)** : le motif en treillis régulier montré par l'utilisateur venait
de mon test synthétique lui-même — des sinus purs periodiques pavent TOUJOURS
en treillis régulier une fois contourés, quel que soit le traitement en aval
(propriété mathématique inévitable, pas un bug de rendu). Deux corrections
faites en parallèle :
- **`grib-vorticity.ts`** : léger lissage (sigma=1 cellule, via `smoothField`)
  de U et V *avant* de dériver — une dérivée amplifie énormément le bruit de
  grille/troncature spectrale d'un vent brut 0.25°, ce qui aurait quand même
  produit un tourbillon "poivre et sel" numérique sur de vraies données GFS
  (dérivation = filtre passe-haut). Volontairement léger — contrairement à
  PMER, on garde la structure turbulente réelle, on retire juste le bruit pur.
- **Densité de contour réduite** : pas 150 au lieu de 100 (routes/synergie.ts).
- **Test refait avec du vrai bruit non-périodique** (value noise multi-octaves
  — grille grossière aléatoire ré-échantillonnée en bilinéaire, sommée à 3
  échelles, PAS des sinus) : résultat nettement plus convaincant, taches
  irrégulières de tailles variées, plus de treillis. Confirme que l'approche
  de rendu (isolignes denses, sans lissage agressif ni filtre anti-confetti)
  était correcte — c'était bien le test qui était en cause, pas l'algorithme.

**Passe supplémentaire "encore mieux" (même jour)** — demande volontairement
vague ("tu peux encore faire mieux"), clarifiée par question : portait
spécifiquement sur la carte TA. Trois ajustements :
- `stroke-opacity="0.85"` sur les isolignes (`grib-vorticity-render.ts`) — les
  croisements rouge/vert/bleu se mélangent légèrement au lieu de s'empiler en
  opaque pur, plus proche visuellement de la référence Synergie.
- Densité de contour redescendue à un pas de 80 (au lieu de 150) — le premier
  passage à 150 avait sur-corrigé en réaction au "nid d'abeille", mais ce
  dernier venait de la périodicité du test, pas de la densité ; avec du bruit
  non-périodique, une densité plus fine est à la fois correcte et plus proche
  de la vraie carte.
- Test rejoué avec un bruit à 5 octaves rapprochées (au lieu de 3 espacées) —
  le premier bruit non-périodique, une fois densifié à ce niveau de détail,
  donnait un résultat trop "lisse/épars" ; plus d'octaves à des échelles
  rapprochées donne une texture multi-échelle plus riche, cohérente avec une
  vraie densité de contour élevée. Résultat visuel nettement plus proche de la
  référence Synergie (dense, organique, sans motif répétitif).

## ECMWF API format
```
GET https://charts.ecmwf.int/opencharts-api/v1/products/medium-mslp-rain/?base_time={ISO}&valid_time={ISO}&projection=opencharts_africa
→ { data: { link: { href: "https://charts.ecmwf.int/content/....png" } } }
```

**Why:** ECMWF fournit des images publiques via une API JSON — pas d'auth requise, mais les URLs changent à chaque run. Doit être fetchée côté serveur pour éviter CORS et mettre en cache.
