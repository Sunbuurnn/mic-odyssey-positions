# Position de MIC Odyssey · Route du Rhum 2026

Toutes les 20 minutes, GitHub Actions relève la position du Class40 MIC Odyssey (FRA 177, Jean-Baptiste Ternon) sur la
[cartographie officielle Class40](https://carto.routedurhum.com/fr/index.html?cl=1) et l'enregistre dans
[`data/course.json`](data/course.json).

L'extension WordPress « MIC Odyssey · position en direct », installée sur micodyssey.com, vient chercher ce fichier et
l'affiche sur la page d'accueil. Les visiteurs du site ne contactent jamais GitHub.

- Relève : `outils/positions.mjs` (Chrome sans affichage lit la cartographie), lancé par `.github/workflows/positions.yml`.
- Relancer à la main : onglet **Actions** → « Position MIC Odyssey » → **Run workflow**.
- Après la course : désactiver le workflow (onglet Actions → « … » → Disable workflow).
