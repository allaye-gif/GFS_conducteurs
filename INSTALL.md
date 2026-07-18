# Météo Analyste — Installation locale

## Prérequis

- Node.js 20+ : https://nodejs.org
- pnpm 9+ : `npm install -g pnpm`
- PostgreSQL 14+ installé et démarré (pgAdmin ou ligne de commande)

## 1. Cloner le dépôt

```bash
git clone https://github.com/allaye-gif/GFS_conducteurs.git
cd GFS_conducteurs
```

## 2. Installer les dépendances

```bash
pnpm install
```

## 3. Configurer la base de données

Dans pgAdmin (ou psql), créer une base de données :

```sql
CREATE DATABASE meteo_analyste;
```

## 4. Créer le fichier .env

```bash
cp .env.example .env
```

Ouvrir `.env` et renseigner :

```
DATABASE_URL=postgresql://postgres:allaye@localhost:5432/meteo_analyste
SESSION_SECRET=une_chaine_secrete_longue_et_aleatoire
```

## 5. Appliquer le schéma de base de données

```bash
pnpm --filter @workspace/db run push
```

## 6. Lancer l'application

Ouvrir **deux terminaux** :

**Terminal 1 — API :**
```bash
pnpm --filter @workspace/api-server run dev
```

**Terminal 2 — Frontend :**
```bash
pnpm --filter @workspace/meteo-analyste run dev
```

L'app est disponible sur : http://localhost:5173 (ou le port affiché)
L'API tourne sur : http://localhost:8080

## Notes

- Les cartes NOAA sont chargées via un proxy côté serveur (`/api/noaa/proxy`) — nécessite une connexion internet.
- Le brouillon des analyses est sauvegardé en base de données (table `drafts`).
