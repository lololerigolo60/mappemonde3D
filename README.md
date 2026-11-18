# 🌍 Mappemonde 3D

[![CI](https://github.com/lololerigolo60/mappemonde/actions/workflows/ci.yml/badge.svg)](https://github.com/TON-USER/mappemonde/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/Node.js-%3E%3D18-brightgreen)](https://nodejs.org)
[![Three.js](https://img.shields.io/badge/Three.js-0.160-blue)](https://threejs.org)
[![Docker](https://img.shields.io/badge/Docker-ready-blue)](https://docker.com)
[![Licence](https://img.shields.io/badge/Licence-MIT-blue)](LICENSE)
[![Port](https://img.shields.io/badge/Port-3456-orange)](http://127.0.0.1:3456)

> Un globe terrestre interactif, 100 % local, dans votre navigateur.

**Aucune dépendance. Aucune inscription. Aucune pub.**
Juste un double-clic et votre navigateur s'ouvre sur la planète Terre, vivante.

<!-- Ajoutez ici une capture d'écran du globe -->
<!-- ![Capture](docs/screenshot.png) -->

---

## ✨ Ce que fait l'application

Mappemonde 3D regroupe **9 couches de données en temps réel** sur un globe 3D rendu en WebGL (Three.js) :

| # | Couche | Source |
|---|--------|--------|
| 1 | ✈️ **Avions en vol** — compagnie, altitude, vitesse, destination, suivi caméra | OpenSky Network |
| 2 | 🚢 **Navires** (cargos, croisières, tankers…) — catégorie, position, vitesse | aisstream.io (AIS) |
| 3 | 🛰️ **Satellites** — 11 constellations (GPS, Galileo, GLONASS, BeiDou, Starlink, ISS, Tiangong…), orbites calculées, bouton « Aller à l'ISS » | CelesTrak (TLE) |
| 4 | 🌋 **Séismes** — magnitude, profondeur, heure, filtre par période | USGS |
| 5 | 🌪️ **Événements naturels** — incendies, volcans, inondations, tempêtes, avec filtres | NASA EONET |
| 6 | 📊 **Choroplèthe par pays** — ~110 indicateurs (PIB, population, Gini, CO₂, corruption, santé, éducation, numérique…) colorés directement sur le globe | Banque mondiale |
| 7 | 🌤️ **Météo des grandes villes** — température, vent, précipitations, AQI | Open-Meteo |
| 8 | 🌌 **Aurores polaires** — tracé de l'ovale auroral, index Kp en direct | NOAA SWPC |
| 9 | ☀️ **Jour / nuit** — ombre solaire calculée en temps réel | calcul local |

### Fond de carte & calques satellite

- **Carte politique** (défaut) — frontières, noms de pays
- **Relief NASA** (Blue Marble Shaded Relief)
- **Vue satellite du jour** — MODIS Terra ou VIIRS SNPP
- **Recul dans le temps** — sélecteur de date sur l'historique GIBS (jusqu'à 30 jours)
- **Calques superposables** : nuages, précipitations IMERG, température de la mer, aérosols, neige
- **Lumières des villes** (VIIRS Black Marble) côté nuit

### Outils

- 🔍 **Recherche universelle** — pays, ville, vol (ex. `AFR123`), satellite, navire
- 📏 **Mesure de distance** entre deux points du globe (2 clics)
- 🎥 **Suivi d'objet** — la caméra suit un avion, un navire ou un satellite
- 📸 **Capture d'écran** (touche `P`)
- 🖥️ **Plein écran** (touche `F`)
- 📋 **Fiche pays** — stats Banque mondiale, capitale, langue, météo, article Wikipédia
- ⚡ **Onglet « Direct »** — suivi live d'un objet sélectionné avec détails (équipage ISS, position en temps réel…)

### Panneau « Direct »

Cliquez sur n'importe quel objet (avion, navire, satellite, séisme, ville) → une carte détaillée s'ouvre → bouton **« Suivre »** → le globe pivote automatiquement pour garder l'objet au centre.

---

## 🧱 Technique

- **Front** : Three.js 0.160 (chargé via CDN, zéro `npm install`)
- **Back** : Serveur Node.js minimaliste (zéro dépendance npm) — sert les fichiers statiques, proxy et cache les API externes, gère le WebSocket AIS
- **Données** : TopoJSON 110m (Natural Earth), Wikidata, API publiques
- **Cache** : disque (`cache/`) + mémoire (TTL) pour éviter les appels répétés
- **Port** : `127.0.0.1:3456`

```
server.js     →  serveur HTTP + WS, proxy/cache, clés API à chaud
globe.js      →  rendu 3D, couches, caméras, sélection
ui.js         →  panneaux, cartes d'info, recherche, réglages
extras.js     →  fond de carte GIBS, aurores, mesure, jour/nuit
countries-data.json / data/countries-110m.json → données pays
```

---

## ⌨️ Raccourcis

| Touche | Action |
|--------|--------|
| `/` | Recherche |
| `1` – `9` | Activer / couper les couches |
| `←` `→` `↑` `↓` | Tourner le globe |
| `+` / `−` / molette | Zoom |
| `Espace` | Pause / reprise de la rotation |
| `Échap` | Recentrer / arrêter le suivi |
| `M` | Mesurer une distance (2 clics) |
| `P` | Capture d'écran |
| `F` | Plein écran |
| `K` | Réglages (clés API) |
| `L` | Ouvrir / fermer le panneau Couches |
| `?` | Aide & raccourcis |

---

## 🔑 Clés API (optionnelles)

L'application fonctionne **sans aucune clé** (quota anonyme). Pour débloquer du débit supplémentaire :

| Service | À quoi sert | Où l'obtenir |
|---------|------------|-------------|
| **aisstream.io** | Flux navires AIS (gratuit) | https://aisstream.io |
| **OpenSky Network** | Avions — lever la limite 400 req/jour (gratuit) | https://opensky-network.org |

### 3 façons de les configurer

1. **Via l'interface** : bouton **⚙** (touche `K`) → coller la clé → *Enregistrer*. Persisté dans `.api_keys.json`, **appliqué à chaud**, sans redémarrage.
2. **Fichier** `.api_keys.json` dans le dossier de l'app :
   ```json
   {
     "aisKey": "votre-cle-aisstream",
     "openSkyClientId": "votre-client-id",
     "openSkyClientSecret": "votre-secret"
   }
   ```
3. **Variables d'environnement** : `AISSTREAM_API_KEY`, `OPENSKY_CLIENT_ID`, `OPENSKY_CLIENT_SECRET`.

> ⚠️ Ajoutez `.api_keys.json` à votre `.gitignore` si vous publiez le dépôt.

---

## 📦 Installation & lancement

### Prérequis

- **Node.js** ≥ 18 LTS → https://nodejs.org
- **Un navigateur récent** (Chrome, Edge, Firefox, Safari) avec WebGL2
- Une **connexion Internet** (les données sont fetchées en direct)

> Aucune dépendance npm. Pas de `package.json`. Pas de build.

### Windows

```bat
:: 1. Installer Node.js si ce n'est pas déjà fait
:: 2. Copier / cloner le dossier mappemonde
:: 3. Double-clic sur :
lancer-mappemonde.bat
```

Le navigateur s'ouvre automatiquement sur `http://127.0.0.1:3456`.

Pour arrêter : `fermer-mappemonde.bat` (ou `Ctrl+C` dans la console).

### Linux / macOS

```bash
# 1. Vérifier Node.js
node -v   # >= 18

# 2. Lancer le serveur
cd mappemonde
node server.js

# 3. Ouvrir dans le navigateur
# http://127.0.0.1:3456

# Arrêter : Ctrl+C
```

### Docker (optionnel)

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY . .
EXPOSE 3456
CMD ["node", "server.js"]
```

```bash
docker build -t mappemonde .
docker run -p 3456:3456 mappemonde
```

---

## 📁 Structure du dépôt

```
mappemonde/
├── index.html          # page principale
├── style.css           # styles
├── globe.js            # moteur 3D + couches
├── ui.js               # UI, panneaux, recherche
├── extras.js           # fond de carte, aurores, mesure
├── server.js           # serveur Node + proxy API
├── countries-data.json # données pays (noms, capital, code)
├── data/
│   └── countries-110m.json   # TopoJSON frontières
├── cache/              # cache disque images GIBS (généré)
├── lancer-mappemonde.bat   # launcher Windows
├── fermer-mappemonde.bat   # arrêt Windows
└── README.md
```

---

## 📄 Sources de données

| Donnée | API | Gratuit ? |
|--------|-----|-----------|
| Avions | [OpenSky Network](https://opensky-network.org) | ✅ (400 req/j sans clé) |
| Navires | [aisstream.io](https://aisstream.io) | ✅ (clé gratuite) |
| Satellites / TLE | [CelesTrak](https://celestrak.org) | ✅ |
| Séismes | [USGS](https://earthquake.usgs.gov) | ✅ |
| Événements naturels | [NASA EONET](https://eonet.gsfc.nasa.gov) | ✅ |
| Météo | [Open-Meteo](https://open-meteo.com) | ✅ |
| Aurores / Kp | [NOAA SWPC](https://www.swpc.noaa.gov) | ✅ |
| Stats pays | [Banque mondiale](https://data.worldbank.org) | ✅ |
| Fond satellite | [NASA GIBS](https://gibs.earthdata.nasa.gov) | ✅ |
| Infos pays / villes | [Wikidata](https://wikidata.org) | ✅ |

**Toutes les sources sont gratuites et publiques.** Aucune donnée personnelle n'est collectée.

---

## 📜 Licence

MIT — voir [LICENSE](LICENSE)
