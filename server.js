'use strict';
/*
 * Vote AG — vote en ligne réservé aux présents, par codes à usage unique.
 * Aucune dépendance : lancer avec  node server.js   (ou  node server.js --tunnel)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { codesPdf } = require('./lib/pdf');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'donnees');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const DATA_FILE = path.join(DATA_DIR, 'votes.json');
const PUBLIC_DIR = path.join(ROOT, 'public');

// Lettres et chiffres sans les caractères ambigus (0/O, 1/I/L)
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LEN = 8;
const MAX_CODES_PAR_GROUPE = 20000;
const MAX_TENTATIVES_CODE = 300;      // codes faux par adresse IP et par fenêtre
const FENETRE_TENTATIVES = 10 * 60 * 1000;

fs.mkdirSync(DATA_DIR, { recursive: true });

function randomString(len, alphabet = ALPHABET) {
  let s = '';
  for (let i = 0; i < len; i++) s += alphabet[crypto.randomInt(alphabet.length)];
  return s;
}

function loadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    console.error(`\nImpossible de lire ${file} : ${e.message}`);
    console.error('Corrigez ou supprimez ce fichier, puis relancez.\n');
    process.exit(1);
  }
}

// ---------- Configuration ----------
let config = loadJson(CONFIG_FILE, null) || { port: 3000, adressePublique: '' };
// L'ancien mot de passe en clair des premières versions est effacé du disque.
delete config.motDePasseAdmin;
const PORT = Number(process.env.PORT || config.port || 3000);
let tunnelUrl = '';

function saveConfig() {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}
saveConfig();

// ---------- Mot de passe admin ----------
// Tiré au hasard à chaque lancement (16 caractères, ~79 bits d'entropie), affiché une seule
// fois dans la fenêtre du serveur et jamais écrit sur le disque. La vérification se fait
// uniquement contre une empreinte scrypt salée (lente à calculer, donc coûteuse à attaquer).
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const scryptAsync = (pwd, salt) => new Promise((resolve, reject) => {
  crypto.scrypt(pwd, salt, 32, SCRYPT, (err, key) => (err ? reject(err) : resolve(key)));
});
function makeAdminPassword() {
  const raw = randomString(16);
  const shown = raw.match(/.{4}/g).join('-');
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(raw, salt, 32, SCRYPT);
  return { shown, salt, hash };
}
const adminPwd = makeAdminPassword();
const PASSWORD_SHOWN_ONCE = adminPwd.shown;
delete adminPwd.shown;

async function checkAdminPassword(input) {
  // Tirets, espaces et minuscules acceptés : « abcd efgh… » = « ABCD-EFGH-… »
  const cleaned = normCode(input);
  const key = await scryptAsync(cleaned, adminPwd.salt);
  return crypto.timingSafeEqual(key, adminPwd.hash);
}

// ---------- Données ----------
const db = loadJson(DATA_FILE, { prochainId: 1, groupes: [], tentativesInvalides: 0 });
const groupsById = new Map();
const groupsBySlug = new Map();
const pollsById = new Map(); // id -> { group, poll }

function index() {
  groupsById.clear(); groupsBySlug.clear(); pollsById.clear();
  for (const g of db.groupes) {
    groupsById.set(g.id, g);
    groupsBySlug.set(g.slug, g);
    for (const p of g.votes) pollsById.set(p.id, { group: g, poll: p });
  }
}
index();

function nextId() { return db.prochainId++; }

// ---------- Version de l'état vu par les votants ----------
// Chaque changement visible sur les téléphones (vote lancé, clos, supprimé, partage des
// résultats) change la version. Tant qu'elle ne bouge pas, les téléphones reçoivent
// une réponse vide (204) : quelques octets au lieu de la question complète.
let revCounter = Date.now();
const revs = new Map();      // groupId -> version
const etatCache = new Map(); // groupId -> JSON déjà prêt
function rev(g) {
  if (!revs.has(g.id)) revs.set(g.id, ++revCounter);
  return revs.get(g.id);
}
function bump(g) {
  revs.set(g.id, ++revCounter);
  etatCache.delete(g.id);
}
function shareResults(g) { return g.partageResultats !== false; }
function voterEtat(g) {
  let s = etatCache.get(g.id);
  if (s) return s;
  const open = g.votes.find((v) => v.statut === 'ouvert');
  let resultat = null;
  if (!open && shareResults(g)) {
    const last = g.votes.filter((v) => v.statut === 'clos').sort((a, b) => (b.closLe || 0) - (a.closLe || 0))[0];
    if (last) resultat = { id: last.id, question: last.question, options: last.options, resultats: last.resultats, nbVotes: last.nbVotes };
  }
  s = JSON.stringify({
    rev: rev(g), groupe: g.nom,
    vote: open ? { id: open.id, question: open.question, options: open.options } : null,
    resultat,
  });
  etatCache.set(g.id, s);
  return s;
}

let saveTimer = null;
function save() {
  if (!saveTimer) saveTimer = setTimeout(flush, 300);
}
function flush() {
  clearTimeout(saveTimer);
  saveTimer = null;
  const json = JSON.stringify(db);
  const tmp = DATA_FILE + '.tmp';
  try {
    fs.writeFileSync(tmp, json);
    fs.renameSync(tmp, DATA_FILE);
  } catch (e) {
    try { fs.writeFileSync(DATA_FILE, json); } catch (e2) { console.error('Sauvegarde impossible :', e2.message); }
  }
}
process.on('SIGINT', () => { flush(); process.exit(0); });
process.on('SIGTERM', () => { flush(); process.exit(0); });

// ---------- Utilitaires HTTP ----------
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  res.end(body);
}
function json(res, status, obj) {
  send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
}
function fail(res, status, code, erreur) { json(res, status, { code, erreur }); }

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 32 * 1024) { reject(Object.assign(new Error('trop gros'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(Object.assign(new Error('JSON invalide'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function cookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return '';
}

function clientIp(req) {
  const remote = req.socket.remoteAddress || '';
  const isLocal = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
  if (isLocal) {
    const cf = req.headers['cf-connecting-ip'];
    if (cf) return String(cf);
    const xf = req.headers['x-forwarded-for'];
    if (xf) return String(xf).split(',')[0].trim();
  }
  return remote;
}

function isDirectLocal(req) {
  const remote = req.socket.remoteAddress || '';
  const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
  // Le tunnel arrive aussi depuis 127.0.0.1, mais il ajoute toujours ces en-têtes.
  return loopback && !req.headers['cf-connecting-ip'] && !req.headers['x-forwarded-for'] && !req.headers['cf-ray'];
}

function isHttps(req) {
  return String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

function requestOrigin(req) {
  return `${isHttps(req) ? 'https' : 'http'}://${req.headers.host || `localhost:${PORT}`}`;
}

function publicBase(req) {
  const fixed = String(config.adressePublique || '').trim().replace(/\/+$/, '');
  if (fixed) return { base: fixed, source: 'reglage' };
  if (tunnelUrl) return { base: tunnelUrl, source: 'tunnel' };
  return { base: requestOrigin(req), source: 'navigateur' };
}

// ---------- Limitation des tentatives ----------
const buckets = new Map();
function bucket(key, windowMs) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || b.reset < now) { b = { count: 0, reset: now + windowMs }; buckets.set(key, b); }
  return b;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (b.reset < now) buckets.delete(k);
}, 60 * 1000).unref();

// ---------- Session admin ----------
const sessions = new Map(); // jeton -> expiration
function isAdmin(req) {
  const t = cookie(req, 'vag_admin');
  const exp = t && sessions.get(t);
  if (!exp) return false;
  if (exp < Date.now()) { sessions.delete(t); return false; }
  return true;
}

// ---------- Fichiers statiques ----------
const STATIC = {
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/qr.js': ['qr.js', 'text/javascript; charset=utf-8'],
};
const fileCache = new Map();
function sendFile(res, name, type = 'text/html; charset=utf-8') {
  let body = fileCache.get(name);
  if (!body) { body = fs.readFileSync(path.join(PUBLIC_DIR, name)); fileCache.set(name, body); }
  send(res, 200, body, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
}

// ---------- Mise en forme ----------
function normCode(s) {
  return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 32);
}
function cleanText(s, max) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, max);
}
function pollView(p, withCounts) {
  const v = {
    id: p.id, question: p.question, options: p.options, statut: p.statut,
    nbVotes: p.nbVotes, creeLe: p.creeLe, ouvertLe: p.ouvertLe || null, closLe: p.closLe || null,
  };
  if (withCounts) v.resultats = p.resultats;
  return v;
}
function groupSummary(g) {
  const ouvert = g.votes.find((p) => p.statut === 'ouvert');
  return { id: g.id, nom: g.nom, slug: g.slug, nbCodes: Object.keys(g.codes).length, nbVotes: g.votes.length, voteOuvert: !!ouvert };
}
function groupDetail(g, req) {
  const { base, source } = publicBase(req);
  const codes = Object.values(g.codes);
  const order = { ouvert: 0, brouillon: 1, clos: 2 };
  const votes = [...g.votes].sort((a, b) => order[a.statut] - order[b.statut] ||
    (a.statut === 'clos' ? (b.closLe || 0) - (a.closLe || 0) : a.id - b.id));
  return {
    id: g.id, nom: g.nom, slug: g.slug,
    lien: `${base}/v/${g.slug}`, sourceLien: source,
    nbCodes: codes.length, nbDesactives: codes.filter((c) => c.off).length,
    lots: g.lots, ecran: g.ecran, partageResultats: shareResults(g),
    tentativesInvalides: g.tentativesInvalides || 0,
    votes: votes.map((p) => pollView(p, true)),
  };
}

// ---------- API votants ----------
async function voterApi(req, res, url) {
  const m = url.pathname.match(/^\/api\/v\/([a-z0-9]+)\/(etat|code|vote)$/);
  if (!m) return fail(res, 404, 'introuvable', 'Adresse inconnue.');
  const g = groupsBySlug.get(m[1]);
  if (!g) return fail(res, 404, 'groupe_inconnu', 'Ce lien de vote n\'existe pas.');
  const action = m[2];

  if (action === 'etat' && req.method === 'GET') {
    if (url.searchParams.get('rev') === String(rev(g))) {
      return send(res, 204, '', { 'Cache-Control': 'no-store' });
    }
    return send(res, 200, voterEtat(g), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  }
  if (req.method !== 'POST') return fail(res, 405, 'methode', 'Méthode non autorisée.');

  const body = await readJson(req);
  const ip = clientIp(req);
  const b = bucket(`code:${ip}`, FENETRE_TENTATIVES);
  if (b.count >= MAX_TENTATIVES_CODE) {
    return fail(res, 429, 'trop_de_tentatives', 'Trop de codes erronés depuis ce réseau. Réessayez dans quelques minutes.');
  }
  const code = normCode(body.code);
  const entry = g.codes[code];
  if (!entry) {
    b.count++;
    g.tentativesInvalides = (g.tentativesInvalides || 0) + 1;
    save();
    return fail(res, 403, 'code_invalide', 'Ce code n\'est pas valide. Vérifiez-le et réessayez.');
  }
  if (entry.off) return fail(res, 403, 'code_desactive', 'Ce code a été désactivé.');

  if (action === 'code') {
    const dejaVotes = g.votes.filter((p) => p.statut === 'ouvert' && p.votants[code] !== undefined).map((p) => p.id);
    return json(res, 200, { ok: true, dejaVotes });
  }

  // action === 'vote'
  const ref = pollsById.get(Number(body.vote));
  if (!ref || ref.group !== g || ref.poll.statut !== 'ouvert') {
    return fail(res, 409, 'vote_clos', 'Ce vote est clos.');
  }
  const p = ref.poll;
  const choix = Number(body.choix);
  if (!Number.isInteger(choix) || choix < 0 || choix >= p.options.length) {
    return fail(res, 400, 'choix_invalide', 'Choix invalide.');
  }
  const jeton = cleanText(body.jeton, 40) || 'x';
  if (p.votants[code] !== undefined) {
    // Même requête renvoyée après une coupure réseau : on confirme sans recompter.
    if (p.votants[code] === jeton && jeton !== 'x') return json(res, 200, { ok: true });
    return fail(res, 409, 'deja_vote', 'Ce code a déjà voté pour cette question.');
  }
  // On ne garde jamais le lien code → choix : seulement « ce code a voté » et les totaux.
  p.votants[code] = jeton;
  p.resultats[choix]++;
  p.nbVotes++;
  save();
  return json(res, 200, { ok: true });
}

// ---------- API admin ----------
async function adminApi(req, res, url) {
  const p = url.pathname.slice('/api/admin'.length);
  const method = req.method;

  if (p === '/connexion' && method === 'POST') {
    const ip = clientIp(req);
    // Depuis le PC du serveur lui-même (http://localhost), jamais de blocage : ainsi
    // personne ne peut empêcher l'organisateur de se connecter en saturant les essais.
    const local = isDirectLocal(req);
    const b = local ? { count: 0 } : bucket(`login:${ip}`, 10 * 60 * 1000);
    const all = local ? { count: 0 } : bucket('login:*', 10 * 60 * 1000); // plafond global, même si l'attaquant change d'adresse
    if (b.count >= 10 || all.count >= 100) {
      return fail(res, 429, 'trop_de_tentatives', 'Trop d\'essais. Réessayez dans 10 minutes, ou connectez-vous depuis le PC du serveur (http://localhost:3000/admin).');
    }
    const body = await readJson(req);
    b.count++; all.count++; // compté avant le calcul, pour bloquer les essais en rafale
    if (!(await checkAdminPassword(String(body.motDePasse || '').slice(0, 64)))) {
      return fail(res, 403, 'mot_de_passe', 'Mot de passe incorrect.');
    }
    b.count--; all.count--; // une connexion réussie ne compte pas comme un essai
    const token = crypto.randomBytes(24).toString('base64url');
    sessions.set(token, Date.now() + 24 * 3600 * 1000);
    const secure = isHttps(req) ? '; Secure' : '';
    res.setHeader('Set-Cookie', `vag_admin=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400${secure}`);
    return json(res, 200, { ok: true });
  }

  if (!isAdmin(req)) return fail(res, 401, 'non_connecte', 'Connexion requise.');

  if (p === '/deconnexion' && method === 'POST') {
    sessions.delete(cookie(req, 'vag_admin'));
    res.setHeader('Set-Cookie', 'vag_admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
    return json(res, 200, { ok: true });
  }

  if (p === '/reglages') {
    if (method === 'POST') {
      const body = await readJson(req);
      let adr = cleanText(body.adressePublique, 200).replace(/\/+$/, '');
      if (adr && !/^https?:\/\/[^\s/]+$/i.test(adr)) {
        return fail(res, 400, 'adresse', 'Adresse invalide. Exemple : https://vote.monsite.fr');
      }
      config.adressePublique = adr;
      saveConfig();
    }
    return json(res, 200, { adressePublique: config.adressePublique || '', tunnel: tunnelUrl, ...publicBase(req) });
  }

  if (p === '/groupes') {
    if (method === 'GET') return json(res, 200, db.groupes.map(groupSummary));
    if (method === 'POST') {
      const body = await readJson(req);
      const nom = cleanText(body.nom, 80);
      if (!nom) return fail(res, 400, 'nom', 'Donnez un nom au groupe.');
      let slug;
      do { slug = randomString(6).toLowerCase(); } while (groupsBySlug.has(slug));
      const g = { id: nextId(), nom, slug, creeLe: Date.now(), codes: {}, lots: [], votes: [], ecran: 'auto', tentativesInvalides: 0 };
      db.groupes.push(g);
      index(); save();
      return json(res, 200, groupSummary(g));
    }
  }

  let m = p.match(/^\/groupes\/(\d+)(\/.*)?$/);
  if (m) {
    const g = groupsById.get(Number(m[1]));
    if (!g) return fail(res, 404, 'groupe_inconnu', 'Groupe introuvable.');
    const sub = m[2] || '';

    if (sub === '' && method === 'GET') return json(res, 200, groupDetail(g, req));
    if (sub === '' && method === 'DELETE') {
      db.groupes = db.groupes.filter((x) => x !== g);
      index(); save();
      return json(res, 200, { ok: true });
    }

    if (sub === '/codes' && method === 'POST') {
      const body = await readJson(req);
      const n = Math.floor(Number(body.nombre));
      const existing = Object.keys(g.codes).length;
      if (!(n >= 1 && n <= 5000)) return fail(res, 400, 'nombre', 'Indiquez un nombre entre 1 et 5000.');
      if (existing + n > MAX_CODES_PAR_GROUPE) return fail(res, 400, 'nombre', `Maximum ${MAX_CODES_PAR_GROUPE} codes par groupe.`);
      const lot = g.lots.length + 1;
      let made = 0;
      while (made < n) {
        const c = randomString(CODE_LEN);
        if (g.codes[c]) continue;
        g.codes[c] = { lot };
        made++;
      }
      g.lots.push({ numero: lot, nombre: n, creeLe: Date.now() });
      save();
      return json(res, 200, { ok: true, lot });
    }

    const pdfMatch = sub.match(/^\/codes\.(pdf|txt)$/);
    if (pdfMatch && method === 'GET') {
      const lot = url.searchParams.get('lot');
      const list = Object.entries(g.codes)
        .filter(([, v]) => !v.off && (!lot || String(v.lot) === lot))
        .map(([c]) => c);
      const label = lot ? `lot-${lot}` : 'tous';
      const fileBase = `codes-${g.nom.normalize('NFD').replace(/[^\w-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'groupe'}-${label}`;
      if (pdfMatch[1] === 'txt') {
        return send(res, 200, list.join('\r\n') + '\r\n', {
          'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store',
          'Content-Disposition': `attachment; filename="${fileBase}.txt"`,
        });
      }
      const titre = `${g.nom}${lot ? ` — lot ${lot}` : ''}`;
      return send(res, 200, codesPdf({ titre, codes: list }), {
        'Content-Type': 'application/pdf', 'Cache-Control': 'no-store',
        'Content-Disposition': `inline; filename="${fileBase}.pdf"`,
      });
    }

    if (sub === '/codes/desactiver' && method === 'POST') {
      const body = await readJson(req);
      const code = normCode(body.code);
      if (!g.codes[code]) return fail(res, 404, 'code_inconnu', 'Ce code n\'existe pas dans ce groupe.');
      g.codes[code].off = !body.reactiver;
      save();
      return json(res, 200, { ok: true });
    }

    if (sub === '/votes' && method === 'POST') {
      const body = await readJson(req);
      const question = cleanText(body.question, 300);
      const options = (Array.isArray(body.options) ? body.options : []).map((o) => cleanText(o, 120)).filter(Boolean);
      if (!question) return fail(res, 400, 'question', 'Écrivez la question.');
      if (options.length < 2) return fail(res, 400, 'options', 'Il faut au moins deux réponses.');
      if (options.length > 12) return fail(res, 400, 'options', 'Douze réponses maximum.');
      if (new Set(options.map((o) => o.toLowerCase())).size !== options.length) {
        return fail(res, 400, 'options', 'Deux réponses sont identiques.');
      }
      const lancer = !!body.lancer;
      if (lancer && g.votes.some((v) => v.statut === 'ouvert')) {
        return fail(res, 409, 'deja_ouvert', 'Un vote est déjà ouvert. Clôturez-le d\'abord.');
      }
      const poll = {
        id: nextId(), question, options, resultats: options.map(() => 0), nbVotes: 0,
        votants: {}, statut: lancer ? 'ouvert' : 'brouillon', creeLe: Date.now(), ouvertLe: lancer ? Date.now() : null, closLe: null,
      };
      g.votes.push(poll);
      if (lancer) { g.ecran = 'auto'; bump(g); }
      index(); save();
      return json(res, 200, pollView(poll, true));
    }

    if (sub === '/partage' && method === 'POST') {
      const body = await readJson(req);
      g.partageResultats = !!body.actif;
      bump(g); save();
      return json(res, 200, { ok: true, partageResultats: g.partageResultats });
    }

    if (sub === '/ecran') {
      if (method === 'POST') {
        const body = await readJson(req);
        g.ecran = body.mode === 'qr' ? 'qr' : 'auto';
        save();
      }
      const { base } = publicBase(req);
      const open = g.votes.find((v) => v.statut === 'ouvert');
      let vote = null;
      if (g.ecran !== 'qr') {
        if (open) vote = { id: open.id, question: open.question, options: open.options, statut: 'ouvert', nbVotes: open.nbVotes };
        else {
          const last = g.votes.filter((v) => v.statut === 'clos').sort((a, b) => (b.closLe || 0) - (a.closLe || 0))[0];
          if (last) vote = pollView(last, true);
        }
      }
      return json(res, 200, { nom: g.nom, lien: `${base}/v/${g.slug}`, ecran: g.ecran, nbCodes: Object.keys(g.codes).length, vote });
    }
  }

  m = p.match(/^\/votes\/(\d+)\/(ouvrir|clore|supprimer)$/);
  if (m && method === 'POST') {
    const ref = pollsById.get(Number(m[1]));
    if (!ref) return fail(res, 404, 'vote_inconnu', 'Vote introuvable.');
    const { group: g, poll } = ref;
    if (m[2] === 'ouvrir') {
      if (poll.statut !== 'brouillon') return fail(res, 409, 'statut', 'Ce vote a déjà été lancé.');
      if (g.votes.some((v) => v.statut === 'ouvert')) return fail(res, 409, 'deja_ouvert', 'Un vote est déjà ouvert. Clôturez-le d\'abord.');
      poll.statut = 'ouvert';
      poll.ouvertLe = Date.now();
      g.ecran = 'auto';
    } else if (m[2] === 'clore') {
      if (poll.statut !== 'ouvert') return fail(res, 409, 'statut', 'Ce vote n\'est pas ouvert.');
      poll.statut = 'clos';
      poll.closLe = Date.now();
      g.ecran = 'auto';
    } else {
      if (poll.statut === 'ouvert') return fail(res, 409, 'statut', 'Clôturez le vote avant de le supprimer.');
      g.votes = g.votes.filter((v) => v !== poll);
      index();
    }
    bump(g);
    save();
    return json(res, 200, { ok: true });
  }

  return fail(res, 404, 'introuvable', 'Adresse inconnue.');
}

// ---------- Serveur ----------
async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  if (req.method === 'GET') {
    if (p === '/' || p === '/admin' || p === '/admin/') return sendFile(res, 'admin.html');
    if (/^\/v\/[a-z0-9]+\/?$/.test(p)) return sendFile(res, 'vote.html');
    if (/^\/ecran\/\d+\/?$/.test(p)) return sendFile(res, 'ecran.html');
    if (STATIC[p]) return sendFile(res, STATIC[p][0], STATIC[p][1]);
    if (p === '/favicon.ico') return send(res, 204, '');
  }
  if (p.startsWith('/api/v/')) return voterApi(req, res, url);
  if (p.startsWith('/api/admin/')) return adminApi(req, res, url);
  send(res, 404, 'Page introuvable', { 'Content-Type': 'text/plain; charset=utf-8' });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    if (e.status) return fail(res, e.status, 'requete', 'Requête invalide.');
    console.error(e);
    if (!res.headersSent) fail(res, 500, 'erreur', 'Erreur interne du serveur.');
    else res.end();
  });
});
server.keepAliveTimeout = 65 * 1000;
server.headersTimeout = 70 * 1000;

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.error(`\nLe port ${PORT} est déjà utilisé. Fermez l'autre fenêtre ou changez "port" dans donnees/config.json.\n`);
  else console.error(e);
  process.exit(1);
});

server.listen(PORT, () => {
  console.log('');
  console.log('  Vote AG est lancé.');
  console.log(`  Administration : http://localhost:${PORT}/admin`);
  console.log(`  Mot de passe   : ${PASSWORD_SHOWN_ONCE}`);
  console.log('                   (nouveau à chaque lancement, enregistré nulle part : notez-le)');
  if (config.adressePublique) console.log(`  Adresse publique : ${config.adressePublique}`);
  console.log('  Laissez cette fenêtre ouverte pendant toute l\'AG. Ctrl+C pour arrêter.');
  console.log('');
  if (process.argv.includes('--tunnel')) startTunnel();
});

function startTunnel() {
  console.log('  Démarrage du tunnel Cloudflare…');
  let child;
  try {
    child = spawn('cloudflared', ['tunnel', '--no-autoupdate', '--url', `http://localhost:${PORT}`], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    console.error('  Impossible de lancer cloudflared :', e.message);
    return;
  }
  const onData = (buf) => {
    const s = buf.toString();
    for (const match of s.matchAll(/https:\/\/([a-z0-9-]+)\.trycloudflare\.com/g)) {
      if (match[1] === 'api' || tunnelUrl) continue;
      tunnelUrl = match[0];
      console.log(`\n  Adresse publique (tunnel) : ${tunnelUrl}`);
      console.log('  Elle change à chaque lancement : le lien et le QR code dans l\'admin sont mis à jour tout seuls.\n');
    }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.on('error', (e) => {
    if (e.code === 'ENOENT') {
      console.error('\n  cloudflared est introuvable. Installez-le avec :');
      console.error('    winget install --id Cloudflare.cloudflared');
      console.error('  puis fermez et rouvrez la fenêtre.\n');
    } else console.error('  Erreur du tunnel :', e.message);
  });
  child.on('exit', (code) => {
    if (tunnelUrl) console.error(`\n  ATTENTION : le tunnel s'est arrêté (code ${code}). Le site n'est plus accessible de l'extérieur.\n`);
    tunnelUrl = '';
  });
  process.on('exit', () => { try { child.kill(); } catch { /* déjà arrêté */ } });
}
