#!/usr/bin/env node
/**
 * Récupère la position de MIC Odyssey sur la cartographie officielle (Geovoile) et met à jour data/course.json.
 *
 *   node outils/positions.mjs                 une récupération, écrit data/course.json si quelque chose a changé
 *   node outils/positions.mjs --test          affiche ce qui serait écrit, sans rien écrire
 *   node outils/positions.mjs --boucle 15     recommence toutes les 15 minutes (laisser tourner pendant la course)
 *   node outils/positions.mjs --apres "rsync -az data/course.json moi@serveur:/var/www/mic-odyssey/data/"
 *                                             commande lancée après chaque mise à jour (mise en ligne du fichier)
 *
 * Autres options : --url <adresse du suivi>  --fichier <course.json>  --bateau <motif du nom>  --chrome <chemin>
 *
 * Fonctionnement : les fichiers de données Geovoile sont chiffrés et décodés par leur visualiseur. Le script ne touche
 * pas à ce chiffrement : il ouvre la carte officielle dans Chrome sans interface, comme un visiteur, attend qu'elle ait
 * chargé ses données, puis lit l'objet public `tracker` de la page (dernier classement, position, trace, arrivée).
 * Une seule ouverture de page par passage ; un intervalle de 15 minutes ou plus reste léger pour le serveur Geovoile.
 *
 * Relais AIS (aisstream.io, gratuit) : tant que la cartographie officielle ne donne rien (pas en ligne, course pas lancée,
 * panne), le script écoute la balise AIS du bateau (MMSI 228110450, confirmé par le skipper, encore nommé « DIATOMA SOLO SAILOR ») et
 * écrit sa dernière position. L'AIS terrestre ne porte qu'à une quarantaine de milles des récepteurs : mesuré le 28.10.2026,
 * aisstream.io capte la baie de Saint-Malo au large, la Manche, Ouessant et le golfe de Gascogne, mais ni l'intérieur du port
 * de Saint-Malo, ni la Guadeloupe, ni le milieu de l'Atlantique (là, seule la cartographie officielle suit le bateau). Clé gratuite sur aisstream.io, dans la variable AISSTREAM_KEY ou le fichier ~/.config/mic-odyssey/aisstream.key
 * (hors du dossier du site, pour qu'elle ne soit jamais publiée). Options : --mmsi <numéro>  --ais-minutes <écoute max>  --sans-ais
 *
 * Codes de sortie : 0 mis à jour ou inchangé · 2 rien à lire (ni cartographie, ni AIS) · 1 erreur.
 * Nécessite Node 22 ou plus (fetch et WebSocket intégrés) et Google Chrome.
 */
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RACINE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARGS = process.argv.slice(2);
const opt = (nom, defaut) => { const i = ARGS.indexOf('--' + nom); return i < 0 ? defaut : (ARGS[i + 1] ?? true); };
const drapeau = nom => ARGS.includes('--' + nom);

const URL_SUIVI = opt('url', 'https://routedurhum.geovoile.com/2026/');
const FICHIER = path.resolve(opt('fichier', path.join(RACINE, 'data/course.json')));
const MOTIF_BATEAU = opt('bateau', 'mic\\s*odyssey|diatoma');
const NOM_SKIPPER = 'ternon';
const CLASSE = 'Class40';
const TEST = drapeau('test');
const BOUCLE_MIN = Number(opt('boucle', 0)) || 0;
const APRES = opt('apres', '');
const PAS_TRACE_S = 3600; // un point de trace par heure dans course.json
const MMSI = String(opt('mmsi', '228110450'));
const AIS_MIN = Number(opt('ais-minutes', 8)) || 8; // un AIS classe B émet toutes les 30 s en route, toutes les 3 min à quai
const SANS_AIS = drapeau('sans-ais');
const FICHIER_CLE_AIS = path.join(os.homedir(), '.config/mic-odyssey/aisstream.key');
const cleAIS = () => process.env.AISSTREAM_KEY?.trim() || (fs.existsSync(FICHIER_CLE_AIS) ? fs.readFileSync(FICHIER_CLE_AIS, 'utf8').trim() : '');
const CHROME = opt('chrome', process.env.CHROME_PATH || [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium',
].find(p => fs.existsSync(p)));

const dormir = ms => new Promise(r => setTimeout(r, ms));
const journal = (...m) => console.log(new Date().toISOString().slice(0, 19).replace('T', ' '), ...m);
const iso = s => new Date(s * 1000).toISOString().replace('.000Z', 'Z');

/* —— Lecture de la carte officielle dans Chrome sans interface —— */

// Exécutée dans la page Geovoile : extrait ce qui concerne notre bateau depuis l'objet public `tracker`.
function extraire(motifBateau, nomSkipper, classe) {
  const t = window.tracker;
  if (!t || !Array.isArray(t._boats) || !t._boats.length) return { pret: false, raison: 'données du suivi absentes' };
  const motif = new RegExp(motifBateau, 'i');
  const bateau = t._boats.find(b => motif.test(b.name || '') || motif.test(b.shortName || ''))
    || t._boats.find(b => (b.sailors || []).some(s => (s.lname || '').toLowerCase() === nomSkipper));
  if (!bateau) return { pret: false, raison: 'bateau introuvable', bateaux: t._boats.map(b => b.name).slice(0, 200) };
  const rapports = t.reports || [];
  const dernier = rapports[rapports.length - 1];
  const ligne = dernier && dernier.linesByBoatId ? dernier.linesByBoatId[bateau.id] : null;
  const loc = bateau.track && (bateau.track.lastLocation || bateau.track.currentLocation);
  const locs = (bateau.track && bateau.track.locations) || [];
  const classeBateau = t._boatClassesByBoatIds ? t._boatClassesByBoatIds[bateau.id] : null;
  return {
    pret: true,
    etat: t._eventState || null,
    departOfficiel: t.timecodeOfficialStart || null,
    bateau: { id: bateau.id, nom: bateau.name, skipper: (bateau.sailors || []).map(s => `${s.fname} ${s.lname}`).join(', ') },
    classe: classeBateau ? classeBateau.name : null,
    flotteClasse: classeBateau ? t._boats.filter(b => t._boatClassesByBoatIds[b.id] === classeBateau).length : null,
    flotteClass40: t._boats.filter(b => (t._boatClassesByBoatIds[b.id] || {}).name === classe).length,
    position: loc ? { t: loc.timecode, lat: loc.lat, lon: loc.lng, cap: loc.heading } : null,
    classement: ligne ? {
      t: ligne.timecode || dernier.timecode, rapport: dernier.timecode, rang: ligne.rank, statut: ligne.racestatus,
      distanceAuBut: ligne.dtf, vitesse: ligne.speed, cap: ligne.heading, ecartAuPremier: ligne.dtl,
    } : null,
    arrivee: bateau.arrival && bateau.arrival.timecode ? { t: bateau.arrival.timecode, tempsS: bateau.arrival.racetime, rang: bateau.arrival.rank } : null,
    trace: locs.map(l => [l.timecode, Math.round(l.lat * 1e4) / 1e4, Math.round(l.lng * 1e4) / 1e4]),
  };
}

async function lireSuivi() {
  if (!CHROME) throw new Error('Google Chrome introuvable : préciser son chemin avec --chrome ou CHROME_PATH.');
  const port = 9300 + Math.floor(Math.random() * 600);
  const profil = fs.mkdtempSync(path.join(os.tmpdir(), 'mic-positions-'));
  // Sur un serveur Linux : pas de GPU, /dev/shm souvent petit, et Chrome refuse de tourner en root sans --no-sandbox
  // (de même sur les machines GitHub Actions, variable CI, où Ubuntu bloque le bac à sable de Chrome)
  const optionsServeur = process.platform === 'linux' ? ['--disable-gpu', '--disable-dev-shm-usage', ...((process.getuid && process.getuid() === 0) || process.env.CI ? ['--no-sandbox'] : [])] : [];
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profil}`, '--no-first-run', '--disable-extensions', ...optionsServeur, 'about:blank'], { stdio: 'ignore' });
  let ws;
  try {
    for (let i = 0; i < 60 && !ws; i++) {
      try { const p = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(x => x.type === 'page'); if (p) ws = new WebSocket(p.webSocketDebuggerUrl); } catch {}
      if (!ws) await dormir(250);
    }
    if (!ws) throw new Error('Chrome n’a pas démarré.');
    await new Promise((ok, ko) => { ws.onopen = ok; ws.onerror = ko; });
    let id = 0; const attente = new Map();
    ws.onmessage = m => { const d = JSON.parse(m.data); if (d.id && attente.has(d.id)) { attente.get(d.id)(d); attente.delete(d.id); } };
    const envoyer = (method, params = {}) => new Promise(r => { const i = ++id; attente.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
    const evaluer = async expr => (await envoyer('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;

    await envoyer('Page.enable');
    await envoyer('Page.navigate', { url: URL_SUIVI });
    const appel = `(${extraire})(${JSON.stringify(MOTIF_BATEAU)}, ${JSON.stringify(NOM_SKIPPER)}, ${JSON.stringify(CLASSE)})`;
    // La page Geovoile redirige vers son visualiseur puis charge config, positions, trace et classements : on attend.
    let res = null;
    for (let s = 0; s < 75; s++) {
      await dormir(1000);
      res = await evaluer(`(() => { try { return ${appel}; } catch (e) { return { pret: false, raison: String(e) }; } })()`);
      const page = await evaluer('document.body ? document.body.innerText.slice(0, 200) : ""');
      if (/mise en ligne à venir/i.test(page || '')) return { pret: false, raison: 'cartographie pas encore en ligne (« Mise en ligne à venir »)' };
      const complet = res && res.pret && ((res.classement && res.trace.length) || ['STANDBY', 'PRERACE', 'CONVOY'].includes(res.etat));
      if (complet && s >= 3) break;
    }
    return res || { pret: false, raison: 'pas de réponse de la page' };
  } finally {
    try { ws && ws.close(); } catch {}
    chrome.kill();
    await dormir(300);
    try { fs.rmSync(profil, { recursive: true, force: true }); } catch {}
  }
}

/* —— Relais AIS : aisstream.io (flux en direct, pas d'historique : on attend le prochain message du bateau) —— */

async function lireAIS() {
  const cle = cleAIS();
  if (!cle) return { pret: false, raison: `pas de clé aisstream.io (variable AISSTREAM_KEY ou ${FICHIER_CLE_AIS})` };
  const ws = new WebSocket('wss://stream.aisstream.io/v0/stream');
  return await new Promise(fin => {
    const minuterie = setTimeout(() => { ws.close(); fin({ pret: false, raison: `aucun message AIS du MMSI ${MMSI} en ${AIS_MIN} min (balise éteinte, ou bateau hors de portée des récepteurs côtiers)` }); }, AIS_MIN * 60000);
    let ouvert = false, recu = false;
    const finir = r => { clearTimeout(minuterie); try { ws.close(); } catch {} fin(r); };
    // Une clé refusée ne renvoie pas toujours de message : le serveur coupe juste après l'abonnement
    const coupure = () => finir({ pret: false, raison: !ouvert ? 'connexion à aisstream.io impossible'
      : recu ? 'aisstream.io a coupé la connexion' : 'aisstream.io a coupé la connexion juste après l’abonnement : clé refusée ?' });
    ws.onopen = () => { ouvert = true; ws.send(JSON.stringify({ // à envoyer dans les 3 s qui suivent la connexion
      APIKey: cle, BoundingBoxes: [[[-90, -180], [90, 180]]], FiltersShipMMSI: [MMSI],
      FilterMessageTypes: ['PositionReport', 'StandardClassBPositionReport', 'ExtendedClassBPositionReport'],
    })); };
    ws.onerror = coupure;
    ws.onclose = coupure;
    ws.onmessage = async m => {
      recu = true;
      const d = JSON.parse(typeof m.data === 'string' ? m.data : Buffer.from(await m.data.arrayBuffer?.() ?? m.data).toString());
      if (d.error) return finir({ pret: false, raison: `aisstream.io : ${d.error}` });
      const r = d.Message && d.Message[d.MessageType];
      if (!r || r.Valid === false || Math.abs(r.Latitude) > 90) return;
      const t = Date.parse((d.MetaData?.time_utc || '').slice(0, 19).replace(' ', 'T') + 'Z') / 1000 || Date.now() / 1000;
      finir({
        pret: true, nom: (d.MetaData?.ShipName || '').trim(), t: Math.round(t),
        lat: r.Latitude, lon: r.Longitude,
        vitesse: r.Sog != null && r.Sog < 102.3 ? Math.round(r.Sog * 10) / 10 : null, // 102,3 = non disponible
        cap: r.Cog != null && r.Cog < 360 ? Math.round(r.Cog) : (r.TrueHeading != null && r.TrueHeading < 360 ? r.TrueHeading : null),
      });
    };
  });
}

/* —— Mise à jour de data/course.json —— */

function dureeTexte(s) {
  const j = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60), sec = Math.floor(s % 60);
  const d = n => String(n).padStart(2, '0');
  return `${j} j ${d(h)} h ${d(m)} min ${d(sec)} s`;
}

function alleger(trace) {
  // Un point par heure, plus toujours le dernier
  const out = []; let dernierT = -Infinity;
  for (const [t, lat, lon] of trace) if (t - dernierT >= PAS_TRACE_S) { out.push({ t: iso(t), lat, lon }); dernierT = t; }
  const fin = trace[trace.length - 1];
  if (fin && out.length && out[out.length - 1].t !== iso(fin[0])) out.push({ t: iso(fin[0]), lat: fin[1], lon: fin[2] });
  return out;
}

function appliquer(course, s) {
  const c = structuredClone(course);
  const k = s.classement, p = s.position;
  const arrive = k && k.statut === 'ARV'; // à quai : ni vitesse ni cap
  c.direct = {
    ...c.direct,
    miseAJour: iso(Math.max(k ? k.t : 0, p ? p.t : 0)),
    lat: p ? Math.round(p.lat * 1e4) / 1e4 : c.direct?.lat ?? null,
    lon: p ? Math.round(p.lon * 1e4) / 1e4 : c.direct?.lon ?? null,
    classementClass40: k && k.rang ? k.rang : null,
    vitesseNoeuds: !arrive && k && k.vitesse != null ? k.vitesse : null,
    capDegres: arrive ? null : k && k.cap != null ? k.cap : (p ? p.cap : null),
    distanceAuButMilles: k && k.distanceAuBut != null ? k.distanceAuBut : null,
    statut: k ? k.statut : null,
    _statut: 'Code officiel : RAC en course, ARV arrivé, RET ou ABD abandon.',
  };
  c.trace = alleger(s.trace);
  if (s.flotteClass40) c.course = { ...c.course, flotteClass40: s.flotteClass40 };
  if (s.arrivee && k && k.statut === 'ARV') {
    c.arrivee = { ...c.arrivee, heure: iso(s.arrivee.t), classementFinalClass40: s.arrivee.rang, tempsDeCourse: s.arrivee.tempsS ? dureeTexte(s.arrivee.tempsS) : null };
  }
  c.source = { fournisseur: 'Geovoile, cartographie officielle', url: URL_SUIVI, bateau: `${s.bateau.nom} (${s.bateau.skipper})`, recupereLe: new Date().toISOString().slice(0, 19) + 'Z' };
  return c;
}

// Position AIS seule : pas de classement ni de distance officielle (le site calcule l'orthodromie jusqu'à Pointe-à-Pitre)
function appliquerAIS(course, a) {
  const c = structuredClone(course);
  const enCourse = a.t * 1000 >= Date.parse(c.course?.depart);
  c.direct = {
    ...c.direct,
    miseAJour: iso(a.t),
    lat: Math.round(a.lat * 1e4) / 1e4, lon: Math.round(a.lon * 1e4) / 1e4,
    vitesseNoeuds: enCourse ? a.vitesse : null, capDegres: enCourse ? a.cap : null,
  };
  // Trace : un point par heure, seulement après le départ (pas de points au ponton)
  const derniere = (c.trace || []).at(-1);
  if (enCourse && (!derniere || a.t - Date.parse(derniere.t) / 1000 >= PAS_TRACE_S)) c.trace = [...(c.trace || []), { t: iso(a.t), lat: c.direct.lat, lon: c.direct.lon }];
  c.source = { fournisseur: 'AIS (aisstream.io), relais en attendant la cartographie officielle', mmsi: MMSI, bateau: a.nom || null, recupereLe: new Date().toISOString().slice(0, 19) + 'Z' };
  return c;
}

const sansHorodatage = c => JSON.stringify({ ...c, source: { ...c.source, recupereLe: null } });

function ecrire(avant, apres, detail) {
  if (TEST) { console.log(JSON.stringify({ direct: apres.direct, arrivee: apres.arrivee, pointsDeTrace: apres.trace.length, source: apres.source }, null, 2)); return 0; }
  if (sansHorodatage(apres) === sansHorodatage(avant)) { journal('Rien de nouveau, course.json inchangé.'); return 0; }
  const tmp = FICHIER + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(apres, null, 2) + '\n');
  fs.renameSync(tmp, FICHIER); // écriture atomique : le site ne lit jamais un fichier à moitié écrit
  journal(`course.json mis à jour (${detail}).`);
  if (APRES) { journal('Commande après mise à jour :', APRES); execSync(APRES, { stdio: 'inherit', cwd: RACINE }); }
  return 0;
}

async function relaisAIS(raison) {
  if (SANS_AIS) { journal(raison); return 2; }
  journal(`${raison} → relais AIS, MMSI ${MMSI} (écoute ${AIS_MIN} min au plus)`);
  const a = await lireAIS();
  if (!a.pret) { journal('AIS :', a.raison); return 2; }
  journal(`AIS ${a.nom || MMSI} : ${a.lat.toFixed(4)}, ${a.lon.toFixed(4)} · ${a.vitesse ?? '—'} nœuds · cap ${a.cap ?? '—'}° · ${iso(a.t)}`);
  const avant = JSON.parse(fs.readFileSync(FICHIER, 'utf8'));
  if (!TEST && avant.direct?.miseAJour && Date.parse(avant.direct.miseAJour) >= a.t * 1000) { journal('Position AIS pas plus récente que celle du fichier, course.json inchangé.'); return 0; }
  return ecrire(avant, appliquerAIS(avant, a), 'position AIS');
}

async function passage() {
  const s = await lireSuivi().catch(e => ({ pret: false, raison: e.message }));
  if (!s.pret) return relaisAIS(`Cartographie : ${s.raison}${s.bateaux ? `\n  bateaux vus : ${s.bateaux.join(' · ')}` : ''}`);
  journal(`Suivi lu : ${s.bateau.nom} (${s.bateau.skipper}), ${s.classe}, état ${s.etat}`);
  if (!s.classement) return relaisAIS('Course pas commencée sur la cartographie (pas de classement)');
  const k = s.classement;
  journal(`Classement du ${iso(k.rapport)} : ${k.rang}e / ${s.flotteClass40} ${CLASSE} · ${k.distanceAuBut} milles au but · ${k.vitesse} nœuds · cap ${k.cap}° · statut ${k.statut}`);

  const avant = JSON.parse(fs.readFileSync(FICHIER, 'utf8'));
  const apres = appliquer(avant, s);
  return ecrire(avant, apres, `${apres.trace.length} points de trace`);
}

async function principal() {
  if (!BOUCLE_MIN) { process.exitCode = await passage().catch(e => { journal('Erreur :', e.message); return 1; }); return; }
  journal(`Boucle toutes les ${BOUCLE_MIN} min sur ${URL_SUIVI}. Ctrl+C pour arrêter.`);
  for (;;) {
    await passage().catch(e => journal('Erreur :', e.message));
    await dormir(BOUCLE_MIN * 60000);
  }
}

principal();
