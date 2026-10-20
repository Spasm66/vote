'use strict';
/*
 * Test de charge : simule N votants qui se connectent et votent tous en même temps.
 *   node test-charge.js http://localhost:3000 800 MOT-DE-PASSE           (local)
 *   node test-charge.js https://xxx.trycloudflare.com 800 MOT-DE-PASSE   (à travers le tunnel)
 * Le mot de passe est celui affiché dans la fenêtre du serveur.
 * Crée un groupe de test, le fait voter, vérifie le décompte, puis le supprime.
 */
const base = (process.argv[2] || 'http://localhost:3000').replace(/\/+$/, '');
const N = Number(process.argv[3] || 800);
const motDePasse = process.argv[4] || process.env.VOTE_MDP;
if (!motDePasse) {
  console.error('Indiquez le mot de passe admin : node test-charge.js <adresse> <nombre> <mot-de-passe>');
  process.exit(1);
}

let cookie = '';
async function admin(method, url, body) {
  const r = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: body ? JSON.stringify(body) : undefined,
  });
  const set = r.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${url} → ${r.status} ${text.slice(0, 200)}`);
  return url.endsWith('.txt') ? text : JSON.parse(text || '{}');
}

async function voter(slug, code, pollId, choix, stats) {
  const t0 = Date.now();
  const post = async (url, body) => {
    for (let attempt = 0; attempt < 6; attempt++) {
      if (attempt) { stats.retries++; await new Promise((r) => setTimeout(r, 500 * attempt + Math.random() * 500)); }
      try {
        const r = await fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        stats.status[r.status] = (stats.status[r.status] || 0) + 1;
        if (r.status >= 500 || r.status === 429) continue;
        return r;
      } catch { stats.network++; }
    }
    return null;
  };
  const etat = await fetch(`${base}/api/v/${slug}/etat`).catch(() => null);
  if (etat) stats.status[etat.status] = (stats.status[etat.status] || 0) + 1;
  const c = await post(`/api/v/${slug}/code`, { code });
  if (!c || c.status !== 200) { stats.failed++; return; }
  const jeton = Math.random().toString(36).slice(2);
  const v = await post(`/api/v/${slug}/vote`, { code, vote: pollId, choix, jeton });
  if (v && v.status === 200) stats.ok++; else stats.failed++;
  stats.times.push(Date.now() - t0);
}

(async () => {
  console.log(`Test de charge sur ${base} avec ${N} votants simultanés…`);
  await admin('POST', '/api/admin/connexion', { motDePasse });
  const g = await admin('POST', '/api/admin/groupes', { nom: `Test de charge ${new Date().toLocaleTimeString('fr-FR')}` });
  try {
    await admin('POST', `/api/admin/groupes/${g.id}/codes`, { nombre: N });
    const codes = (await admin('GET', `/api/admin/groupes/${g.id}/codes.txt`)).trim().split(/\r?\n/);
    const poll = await admin('POST', `/api/admin/groupes/${g.id}/votes`, { question: 'Test', options: ['Pour', 'Contre', 'Abstention'], lancer: true });

    const stats = { ok: 0, failed: 0, retries: 0, network: 0, status: {}, times: [] };
    const expected = [0, 0, 0];
    const t0 = Date.now();
    await Promise.all(codes.map((code, i) => { expected[i % 3]++; return voter(g.slug, code, poll.id, i % 3, stats); }));
    const elapsed = Date.now() - t0;

    // Double vote : doit être refusé
    const dbl = await fetch(`${base}/api/v/${g.slug}/vote`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: codes[0], vote: poll.id, choix: 1, jeton: 'autre' }),
    });

    await admin('POST', `/api/admin/votes/${poll.id}/clore`);
    const detail = await admin('GET', `/api/admin/groupes/${g.id}`);
    const res = detail.votes.find((v) => v.id === poll.id);
    const times = stats.times.sort((a, b) => a - b);
    const pct = (q) => times[Math.min(times.length - 1, Math.floor(q * times.length))] || 0;

    console.log(`\nTerminé en ${(elapsed / 1000).toFixed(1)} s`);
    console.log(`Votes réussis : ${stats.ok}/${N}   échecs : ${stats.failed}   nouvelles tentatives : ${stats.retries}   coupures réseau : ${stats.network}`);
    console.log('Réponses HTTP :', stats.status);
    console.log(`Temps par votant (connexion + vote) : médian ${pct(0.5)} ms, 95 % ${pct(0.95)} ms, max ${pct(1)} ms`);
    console.log(`Décompte serveur : ${JSON.stringify(res.resultats)} (attendu ${JSON.stringify(expected)}), total ${res.nbVotes}`);
    console.log(`Double vote refusé : ${dbl.status === 409 ? 'oui' : `NON (${dbl.status})`}`);
    const good = stats.ok === N && JSON.stringify(res.resultats) === JSON.stringify(expected) && dbl.status === 409;
    console.log(good ? '\n✓ Tout est bon.' : '\n✗ Problème détecté, voir ci-dessus.');
    process.exitCode = good ? 0 : 1;
  } finally {
    await admin('DELETE', `/api/admin/groupes/${g.id}`).catch(() => {});
  }
})().catch((e) => { console.error('Erreur :', e.message); process.exit(1); });
