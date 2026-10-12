/*! Scalp Analyzer — module « Plan de trading hebdomadaire » (plan.js)
 *  Sections : 1 Sauvegarde · 2 Données de marché · 3 Calculs techniques · 4 Analyse IA · 5 Interface
 *  Aucune dépendance. Ne modifie pas le fonctionnement de l'onglet Analyse. */
(function (root) {
'use strict';
const P = {};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fp = (p, ref) => { if (p == null || !isFinite(p)) return 'n/d'; const r = Math.abs(ref == null ? p : ref); return p.toFixed(r >= 10000 ? 0 : r >= 1000 ? 1 : r >= 100 ? 2 : r >= 10 ? 3 : 5); };
const dfmt = (t, o) => new Date(t).toLocaleString('fr-FR', o || { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const dday = t => new Date(t).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' });
const DAY = 86400e3;

/* ============ 1. SAUVEGARDE PERSISTANTE ============
 * Adaptateur : IndexedDB (principal), localStorage (secours). Pour passer à une base distante,
 * fournir un objet avec init/put/get/all/del et l'activer avec ScalpPlan.Store.use(monBackend). */
const DB_NAME = 'scalp_plan_v1';
const IDBBackend = {
  name: 'indexedDB',
  init() { return new Promise((res, rej) => { const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => { const db = r.result; db.createObjectStore('plans', { keyPath: 'id' }); db.createObjectStore('kv', { keyPath: 'k' }); };
    r.onsuccess = () => { this.db = r.result; res(); }; r.onerror = () => rej(r.error); }); },
  _tx(store, mode, fn) { return new Promise((res, rej) => { const tx = this.db.transaction(store, mode), os = tx.objectStore(store); const rq = fn(os);
    tx.oncomplete = () => res(rq ? rq.result : undefined); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); }); },
  put(store, val) { return this._tx(store, 'readwrite', os => os.put(val)); },
  get(store, key) { return this._tx(store, 'readonly', os => os.get(key)); },
  all(store) { return this._tx(store, 'readonly', os => os.getAll()); },
  del(store, key) { return this._tx(store, 'readwrite', os => os.delete(key)); }
};
const LSBackend = {
  name: 'localStorage', pre: 'scalp_plan:',
  async init() { localStorage.setItem(this.pre + 'test', '1'); localStorage.removeItem(this.pre + 'test'); },
  _k(store, key) { return this.pre + store + ':' + key; },
  async put(store, val) { localStorage.setItem(this._k(store, val.id || val.k), JSON.stringify(val)); },
  async get(store, key) { const v = localStorage.getItem(this._k(store, key)); return v ? JSON.parse(v) : undefined; },
  async all(store) { const out = [], p = this.pre + store + ':'; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k.startsWith(p)) out.push(JSON.parse(localStorage.getItem(k))); } return out; },
  async del(store, key) { localStorage.removeItem(this._k(store, key)); }
};
const Store = {
  backend: null, ready: null,
  init() { if (!this.ready) this.ready = (async () => {
      try { if (typeof indexedDB !== 'undefined' && indexedDB) { await IDBBackend.init(); this.backend = IDBBackend; } else throw new Error('pas d\'IndexedDB'); }
      catch (e) { await LSBackend.init(); this.backend = LSBackend; }
      try { if (root.navigator && navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) {}
      return this.backend.name; })(); return this.ready; },
  use(backend) { this.backend = backend; this.ready = Promise.resolve(backend.name); },
  async savePlan(plan) { await this.init(); plan.updatedAt = Date.now(); await this.backend.put('plans', plan); return plan; },
  async getPlan(id) { await this.init(); return this.backend.get('plans', id); },
  async listPlans() { await this.init(); return (await this.backend.all('plans')).sort((a, b) => a.id < b.id ? 1 : -1); },
  async delPlan(id) { await this.init(); return this.backend.del('plans', id); },
  async setKV(k, v) { await this.init(); return this.backend.put('kv', { k, v }); },
  async getKV(k, d) { await this.init(); const r = await this.backend.get('kv', k); return r ? r.v : d; },
  async exportAll() { await this.init(); return { format: 'scalp-plan-backup', version: 1, at: Date.now(), plans: await this.listPlans(), kv: await this.backend.all('kv') }; },
  async importAll(o) { if (!o || o.format !== 'scalp-plan-backup') throw new Error('Fichier de sauvegarde invalide.'); await this.init(); for (const p of o.plans || []) await this.backend.put('plans', p); for (const k of o.kv || []) await this.backend.put('kv', k); return (o.plans || []).length; }
};
P.Store = Store;

/* ============ 2. DONNÉES DE MARCHÉ (Twelve Data) ET CALENDRIER ============ */
const MD = {
  stamps: [],
  async limit(say) { // 8 requêtes / minute sur le plan gratuit
    const now = Date.now(); this.stamps = this.stamps.filter(t => now - t < 61000);
    if (this.stamps.length >= 8) { const w = 61500 - (now - this.stamps[0]); if (say) say(`Limite de requêtes Twelve Data : pause de ${Math.ceil(w / 1000)} s…`); await sleep(w); }
    this.stamps.push(Date.now());
  },
  async series(sym, interval, key, size, extra, say) {
    await this.limit(say);
    const u = 'https://api.twelvedata.com/time_series?symbol=' + encodeURIComponent(sym) + '&interval=' + interval + '&outputsize=' + size +
              '&order=asc&timezone=UTC' + (extra || '') + '&apikey=' + encodeURIComponent(key);
    let j;
    for (let a = 0; a < 2; a++) {
      let r; try { r = await fetch(u); j = await r.json(); } catch (e) { throw new Error('Connexion impossible à Twelve Data. Reste sur l\'app et réessaie.'); }
      if (j && j.status === 'error' && /minute|credits|limit/i.test(j.message || '') && a === 0) { if (say) say('Limite de requêtes atteinte : nouvelle tentative dans une minute…'); await sleep(62000); this.stamps = []; continue; }
      break;
    }
    if (!j || j.status === 'error' || !Array.isArray(j.values)) {
      const m = (j && j.message) || 'Réponse invalide';
      throw new Error(/\b(grow|pro|enterprise|upgrade)\b|available starting|your plan|current plan/i.test(m) ? `${sym} n'est pas inclus dans ton plan Twelve Data (${m})` : /symbol|figi|not found|invalid/i.test(m) ? `Symbole « ${sym} » refusé par Twelve Data (introuvable ou non pris en charge). Utilise « Tester les symboles » ou change de symbole.` : m);
    }
    const bars = j.values.map(v => { const s = String(v.datetime); return { t: Date.parse(s.length <= 10 ? s + 'T00:00:00Z' : s.replace(' ', 'T') + 'Z'), o: +v.open, h: +v.high, l: +v.low, c: +v.close }; })
      .filter(b => isFinite(b.t) && [b.o, b.h, b.l, b.c].every(isFinite) && b.h >= b.l);
    bars.sort((a, b) => a.t - b.t);
    return bars;
  },
  complete(bars, tfMs, now) { now = now || Date.now(); return bars.filter(b => b.t + tfMs <= now); },
  async asset(sym, key, say) {
    const S = {}, info = { symbol: sym, fetchedAt: Date.now() };
    const plan = [['D1', '1day', 220, DAY], ['H4', '4h', 320, 4 * 3600e3], ['H1', '1h', 420, 3600e3]];
    for (const [nm, iv, n, ms] of plan) {
      if (say) say(`${sym} : bougies ${nm}…`);
      const raw = await this.series(sym, iv, key, n, '', say);
      S[nm] = this.complete(raw, ms);
      if (S[nm].length < 60) throw new Error(`${sym} : seulement ${S[nm].length} bougies ${nm} (60 minimum). Données manquantes ou symbole trop récent.`);
      info[nm] = { count: S[nm].length, first: S[nm][0].t, last: S[nm][S[nm].length - 1].t };
    }
    info.stale = Date.now() - S.H1[S.H1.length - 1].t > 4 * DAY;
    return { S, info };
  },
  currencies(sym) {
    const s = String(sym).toUpperCase(), K = ['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD', 'CNY'];
    if (s.includes('/')) { const c = s.split('/').filter(x => K.includes(x)); return c.length ? c : ['USD']; }
    if (/DAX|GER|DE40|FRA|CAC/.test(s)) return ['EUR']; if (/FTSE|UK100/.test(s)) return ['GBP']; if (/N225|JP225|NIKKEI/.test(s)) return ['JPY'];
    return ['USD'];
  },
  async calendar(startMs, endMs, currencies) {
    const urls = ['https://nfs.faireconomy.media/ff_calendar_thisweek.json', 'https://nfs.faireconomy.media/ff_calendar_nextweek.json'];
    const ev = [], seen = new Set(); let ok = 0, err = null;
    for (const u of urls) {
      try {
        const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), 9000);
        const r = await fetch(u, { signal: ctl.signal }); clearTimeout(to);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const j = await r.json(); if (!Array.isArray(j)) throw new Error('format inattendu');
        ok++;
        for (const e of j) {
          const t = Date.parse(e.date), cur = String(e.country || '').toUpperCase();
          if (!isFinite(t) || t < startMs || t > endMs || !['High', 'Medium', 'Holiday'].includes(e.impact)) continue;
          if (currencies.length && !currencies.includes(cur)) continue;
          const id = t + '|' + cur + '|' + e.title; if (seen.has(id)) continue; seen.add(id);
          ev.push({ t, title: String(e.title || ''), cur, impact: e.impact, forecast: e.forecast || '', previous: e.previous || '' });
        }
      } catch (e) { err = e.name === 'AbortError' ? 'délai dépassé' : (e.message || String(e)); }
    }
    ev.sort((a, b) => a.t - b.t);
    return { events: ev, ok: ok > 0, error: ok > 0 ? null : `Calendrier indisponible (${err}). La source est injoignable ou bloquée par le navigateur : aucun événement n'est inventé.`,
             source: 'ForexFactory (flux gratuit : prévision et valeur précédente, résultat publié non fourni)', fetchedAt: Date.now() };
  }
};
P.MD = MD;
/* ============ 3. CALCULS TECHNIQUES (fonctions pures, testables) ============ */
const T = {};
const tr_ = (b, i) => Math.max(b[i].h - b[i].l, Math.abs(b[i].h - b[i-1].c), Math.abs(b[i].l - b[i-1].c));
T.atr = (b, p = 14) => {
  if (b.length < p + 2) return NaN;
  let a = 0; for (let i = 1; i <= p; i++) a += tr_(b, i); a /= p;
  for (let i = p + 1; i < b.length; i++) a = (a * (p - 1) + tr_(b, i)) / p;
  return a;
};
// pivots confirmés k bougies plus tard
T.pivots = (b, k) => {
  const H = [], L = [];
  for (let i = k; i < b.length - k; i++) {
    let hh = true, ll = true;
    for (let j = 1; j <= k; j++) {
      if (!(b[i].h >= b[i-j].h && b[i].h > b[i+j].h)) hh = false;
      if (!(b[i].l <= b[i-j].l && b[i].l < b[i+j].l)) ll = false;
    }
    if (hh) H.push({ i, p: b[i].h, t: b[i].t });
    if (ll) L.push({ i, p: b[i].l, t: b[i].t });
  }
  return { H, L };
};
// structure : BOS (cassure dans le sens de la tendance) / CHoCH (cassure contre la tendance)
T.structure = (b, k = 3) => {
  const { H, L } = T.pivots(b, k);
  let ih = 0, il = 0, sh = null, sl = null, trend = 0; const ev = [];
  for (let i = 0; i < b.length; i++) {
    while (ih < H.length && H[ih].i + k <= i) { sh = { ...H[ih], used: false }; ih++; }
    while (il < L.length && L[il].i + k <= i) { sl = { ...L[il], used: false }; il++; }
    const c = b[i].c;
    if (sh && !sh.used && c > sh.p) { ev.push({ type: trend === -1 ? 'CHoCH' : 'BOS', dir: 'up', level: sh.p, i, t: b[i].t }); trend = 1; sh.used = true; }
    if (sl && !sl.used && c < sl.p) { ev.push({ type: trend === 1 ? 'CHoCH' : 'BOS', dir: 'down', level: sl.p, i, t: b[i].t }); trend = -1; sl.used = true; }
  }
  return { trend, events: ev, H, L };
};
const wkKey = t => { const d = new Date(t + 2*3600e3); const dow = (d.getUTCDay() + 6) % 7; return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow); };
const dayKey = t => { const d = new Date(t + 2*3600e3); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); };
// niveaux de la semaine et du jour précédents, calculés sur les bougies H1
T.keyLevels = (H1) => {
  const agg = (keyf) => { const m = new Map(); for (const x of H1) { const k = keyf(x.t); const g = m.get(k); if (!g) m.set(k, { k, h: x.h, l: x.l, c: x.c, n: 1 }); else { g.h = Math.max(g.h, x.h); g.l = Math.min(g.l, x.l); g.c = x.c; g.n++; } } return [...m.values()].sort((a, b) => a.k - b.k); };
  const W = agg(wkKey), Dd = agg(dayKey);
  let pw = W[W.length - 1]; if (pw && pw.n < 100 && W.length > 1) pw = W[W.length - 2];
  let pd = Dd[Dd.length - 1]; if (pd && pd.n < 22 && Dd.length > 1) pd = Dd[Dd.length - 2];
  return { PWH: pw && pw.h, PWL: pw && pw.l, PWC: pw && pw.c, PDH: pd && pd.h, PDL: pd && pd.l, weekOf: pw && pw.k, dayOf: pd && pd.k };
};
// sommets / creux égaux = liquidité
T.equalLevels = (b, atr, k, tolMult, lookback, tf) => {
  const { H, L } = T.pivots(b, k), n = b.length, tol = tolMult * atr, out = [];
  const grp = (P, side) => {
    const pts = P.filter(p => p.i >= n - lookback).sort((a, c) => a.p - c.p);
    let cur = [];
    const flush = () => {
      if (cur.length >= 2) {
        const lvl = side === 'H' ? Math.max(...cur.map(c => c.p)) : Math.min(...cur.map(c => c.p));
        const last = Math.max(...cur.map(c => c.i));
        let swept = false;
        for (let j = last + 1; j < n; j++) { if (side === 'H' ? b[j].h > lvl + tol : b[j].l < lvl - tol) { swept = true; break; } }
        out.push({ kind: side === 'H' ? 'EQH' : 'EQL', tf, level: lvl, count: cur.length, swept, t: b[last].t });
      }
      cur = [];
    };
    for (const p of pts) { if (cur.length && p.p - cur[cur.length-1].p > tol) flush(); cur.push(p); }
    flush();
  };
  grp(H, 'H'); grp(L, 'L');
  return out;
};
// Fair Value Gaps non comblés (la partie déjà comblée est retirée)
T.fvgs = (b, atr, lookback, tf, minMult = 0.2) => {
  const out = [], n = b.length;
  for (let i = Math.max(2, n - lookback); i < n; i++) {
    const a = b[i-2], c = b[i];
    if (c.l > a.h) {
      let lo = a.h, hi = c.l; if (hi - lo < minMult * atr) continue;
      let mn = Infinity; for (let j = i + 1; j < n; j++) mn = Math.min(mn, b[j].l);
      if (mn <= lo) continue; const fresh = mn >= c.l; if (mn < hi) hi = mn; if (hi - lo < 0.1 * atr) continue;
      out.push({ kind: 'FVG', tf, dir: 'demand', lo, hi, t: b[i-1].t, fresh });
    } else if (c.h < a.l) {
      let lo = c.h, hi = a.l; if (hi - lo < minMult * atr) continue;
      let mx = -Infinity; for (let j = i + 1; j < n; j++) mx = Math.max(mx, b[j].h);
      if (mx >= hi) continue; const fresh = mx <= c.h; if (mx > lo) lo = mx; if (hi - lo < 0.1 * atr) continue;
      out.push({ kind: 'FVG', tf, dir: 'supply', lo, hi, t: b[i-1].t, fresh });
    }
  }
  return out;
};
// Order Blocks : dernière bougie opposée avant un déplacement qui casse la structure locale
T.orderBlocks = (b, atr, lookback, tf) => {
  const out = [], n = b.length, seen = new Set();
  for (let i = Math.max(6, n - lookback); i < n; i++) {
    const x = b[i], rg = x.h - x.l;
    if (rg < 1.4 * atr || Math.abs(x.c - x.o) < 0.55 * rg) continue;
    const prev = b.slice(i - 5, i), pH = Math.max(...prev.map(z => z.h)), pL = Math.min(...prev.map(z => z.l));
    const bull = x.c > x.o;
    if (bull && x.c > pH) {
      for (let j = i - 1; j >= i - 4; j--) if (b[j].c < b[j].o && !seen.has(j)) {
        const ob = { kind: 'OB', tf, dir: 'demand', lo: b[j].l, hi: b[j].h, t: b[j].t };
        let broken = false, touched = false;
        for (let m = i + 1; m < n; m++) { if (b[m].c < ob.lo) broken = true; if (b[m].l <= ob.hi) touched = true; }
        if (!broken) { ob.fresh = !touched; out.push(ob); } seen.add(j); break;
      }
    } else if (!bull && x.c < pL) {
      for (let j = i - 1; j >= i - 4; j--) if (b[j].c > b[j].o && !seen.has(j)) {
        const ob = { kind: 'OB', tf, dir: 'supply', lo: b[j].l, hi: b[j].h, t: b[j].t };
        let broken = false, touched = false;
        for (let m = i + 1; m < n; m++) { if (b[m].c > ob.hi) broken = true; if (b[m].h >= ob.lo) touched = true; }
        if (!broken) { ob.fresh = !touched; out.push(ob); } seen.add(j); break;
      }
    }
  }
  return out;
};
// supports / résistances : regroupement de pivots D1 (poids 2) et H4 (poids 1)
T.srZones = (D, H4, atrD, atrH4) => {
  const pts = [];
  const pd = T.pivots(D.slice(-150), 3), ph = T.pivots(H4.slice(-240), 3);
  [...pd.H, ...pd.L].forEach(p => pts.push({ p: p.p, w: 2, t: p.t }));
  [...ph.H, ...ph.L].forEach(p => pts.push({ p: p.p, w: 1, t: p.t }));
  pts.sort((a, b) => a.p - b.p);
  const tol = 0.25 * atrD, out = []; let cur = [];
  const flush = () => { if (!cur.length) return; const w = cur.reduce((s, c) => s + c.w, 0); if (w >= 3) { const lo = Math.min(...cur.map(c => c.p)), hi = Math.max(...cur.map(c => c.p)); const pad = 0.04 * atrH4; out.push({ kind: 'SR', tf: 'D1/H4', lo: lo - pad, hi: hi + pad, touches: cur.length, w }); } cur = []; };
  for (const p of pts) { if (cur.length && p.p - cur[cur.length-1].p > tol) flush(); cur.push(p); }
  flush();
  return out;
};
// regroupement d'éléments qui se superposent = confluence
T.cluster = (els, tolC, cap) => {
  const sorted = [...els].sort((a, b) => b.w - a.w), used = new Set(), out = [];
  for (const e of sorted) {
    if (used.has(e)) continue;
    let lo = e.lo, hi = e.hi; const mem = [e]; used.add(e);
    let grew = true;
    while (grew) {
      grew = false;
      for (const f of els) {
        if (used.has(f)) continue;
        if (f.hi >= lo - tolC && f.lo <= hi + tolC) {
          const nlo = Math.min(lo, f.lo), nhi = Math.max(hi, f.hi);
          if (nhi - nlo <= cap) { lo = nlo; hi = nhi; mem.push(f); used.add(f); grew = true; }
        }
      }
    }
    const kinds = [...new Set(mem.map(m => m.kind))];
    out.push({ lo, hi, mid: (lo + hi) / 2, els: mem, kinds, w: mem.reduce((s, m) => s + m.w, 0), rank: mem.reduce((s, m) => s + m.w, 0) + 2 * kinds.length });
  }
  return out;
};
const KIND_FR = { OB: 'Order Block', FVG: 'FVG', SR: 'Support/Résistance', EQL: 'Creux égaux (liquidité)', EQH: 'Sommets égaux (liquidité)', PWH: 'Plus haut semaine préc.', PWL: 'Plus bas semaine préc.', PDH: 'Plus haut jour préc.', PDL: 'Plus bas jour préc.' };
T.kindFr = k => KIND_FR[k] || k;

T.bias = (sD, s4) => {
  const d = sD.trend, h = s4.trend, score = 2 * d + h;
  const label = score >= 2 ? 'haussier' : score <= -2 ? 'baissier' : 'neutre';
  const nm = x => x === 1 ? 'haussière' : x === -1 ? 'baissière' : 'indéterminée';
  const lastD = sD.events[sD.events.length - 1], last4 = s4.events[s4.events.length - 1];
  const args = [`Structure D1 ${nm(d)}${lastD ? ` (dernier signal : ${lastD.type} ${lastD.dir === 'up' ? 'haussier' : 'baissier'})` : ''}`,
                `Structure H4 ${nm(h)}${last4 ? ` (dernier signal : ${last4.type} ${last4.dir === 'up' ? 'haussier' : 'baissier'})` : ''}`];
  if (label === 'neutre' && d !== 0 && h !== 0 && d !== h) args.push('D1 et H4 divergent : probable retracement ou changement de tendance en cours');
  return { label, score, args };
};

// ---- construction d'un scénario conditionnel (haussier "bull" ou baissier "bear")
T.buildScenario = (dir, X) => {
  const bull = dir === 'bull', { price, atrD, atrH4, bias, pos } = X;
  const clusters = bull ? X.demand : X.supply;
  const cand = clusters.filter(c => bull ? (c.hi <= price + 0.15 * atrH4 && (price - c.hi) / atrD <= 3.2)
                                         : (c.lo >= price - 0.15 * atrH4 && (c.lo - price) / atrD <= 3.2));
  const sc = { id: dir, dir, label: bull ? 'Scénario haussier' : 'Scénario baissier' };
  if (!cand.length) return { ...sc, ok: false, reason: `Aucune zone ${bull ? 'd\'achat' : 'de vente'} avec confluence exploitable à portée du prix.` };
  const dist = c => bull ? Math.max(0, price - c.hi) / atrD : Math.max(0, c.lo - price) / atrD;
  const z = [...cand].sort((a, b) => (b.rank - 1.5 * dist(b)) - (a.rank - 1.5 * dist(a)))[0];
  const entry = z.mid; let inv = bull ? z.lo - 0.25 * atrH4 : z.hi + 0.25 * atrH4;
  if (Math.abs(entry - inv) < 0.5 * atrH4) inv = bull ? entry - 0.5 * atrH4 : entry + 0.5 * atrH4;   // risque minimal : évite les stops de bruit
  const risk = Math.abs(entry - inv);
  // objectifs : prochaines liquidités / zones opposées
  const tg = (bull ? X.targetsUp : X.targetsDown).filter(t => bull ? t.price > z.hi + 0.1 * atrH4 : t.price < z.lo - 0.1 * atrH4)
                .sort((a, b) => bull ? a.price - b.price : b.price - a.price);
  let t1 = null, t2 = null;
  for (let i = 0; i < tg.length; i++) {
    const r = Math.abs(tg[i].price - entry) / risk;
    if (!t1 && r >= 1.5 && r <= 8) { t1 = tg[i]; continue; }
    if (t1 && !t2 && Math.abs(tg[i].price - t1.price) >= 0.5 * risk) { t2 = tg[i]; break; }
  }
  const rr = t1 ? Math.abs(t1.price - entry) / risk : null;
  // score de confiance argumenté (jamais une probabilité)
  const arg = []; let s = 0;
  const bs = bull ? bias.score : -bias.score;
  const pb = bs >= 2 ? 25 : bs === 1 ? 15 : bs === 0 ? 8 : bs === -1 ? 3 : 0;
  s += pb; arg.push({ ok: pb >= 15 ? 1 : pb >= 8 ? .5 : 0, pts: pb, max: 25, txt: pb >= 15 ? `Biais ${bull ? 'haussier' : 'baissier'} sur D1/H4` : pb >= 8 ? 'Biais neutre : pas de tendance claire' : 'Scénario contre la tendance D1/H4' });
  const nk = z.kinds.length, pc = nk >= 3 ? 25 : nk === 2 ? 17 : 8;
  s += pc; arg.push({ ok: nk >= 3 ? 1 : nk === 2 ? .5 : 0, pts: pc, max: 25, txt: `${nk} confluence${nk > 1 ? 's' : ''} : ${z.kinds.map(T.kindFr).join(', ')}` });
  const fr = z.els.filter(e => e.fresh !== undefined); const allFresh = fr.length && fr.every(e => e.fresh), someFresh = fr.some(e => e.fresh);
  const pf = allFresh ? 15 : someFresh ? 9 : fr.length ? 4 : 7;
  s += pf; arg.push({ ok: allFresh ? 1 : someFresh ? .5 : 0, pts: pf, max: 15, txt: allFresh ? 'Zone fraîche (jamais retestée)' : someFresh ? 'Zone partiellement retestée' : fr.length ? 'Zone déjà retestée : moins fiable' : 'Zone de niveau (fraîcheur non mesurable)' });
  const eq = (bull ? X.eqLow : X.eqHigh).some(e => Math.abs(e.level - (bull ? z.lo : z.hi)) <= 1.2 * atrH4 && (bull ? e.level <= z.lo + 0.2 * atrH4 : e.level >= z.hi - 0.2 * atrH4));
  const tLiq = t1 && ['EQH', 'EQL', 'PWH', 'PWL', 'PDH', 'PDL'].includes(t1.kind);
  const pl = (eq ? 8 : 0) + (tLiq ? 7 : 0); s += pl;
  arg.push({ ok: pl >= 15 ? 1 : pl > 0 ? .5 : 0, pts: pl, max: 15, txt: [eq ? 'Liquidité à balayer près de la zone' : null, tLiq ? `Objectif sur une liquidité (${T.kindFr(t1.kind)})` : null].filter(Boolean).join(' · ') || 'Pas de liquidité identifiée autour de la zone' });
  const pp = bull ? (pos < 0.4 ? 10 : pos < 0.6 ? 5 : 0) : (pos > 0.6 ? 10 : pos > 0.4 ? 5 : 0);
  s += pp; arg.push({ ok: pp >= 10 ? 1 : pp > 0 ? .5 : 0, pts: pp, max: 10, txt: `Prix à ${Math.round(pos * 100)} % de la fourchette D1 (${bull ? 'achat en décote' : 'vente en prime'} ${pp >= 10 ? 'favorable' : pp > 0 ? 'neutre' : 'défavorable'})` });
  const pr = rr == null ? 0 : rr >= 2 ? 10 : 6;
  s += pr; arg.push({ ok: rr == null ? 0 : rr >= 2 ? 1 : .5, pts: pr, max: 10, txt: rr == null ? 'Aucun objectif à 1,5 R ou plus : objectif non déterminable' : `Objectif T1 à ${rr.toFixed(2)} R` });
  const score = Math.round(s);
  const conf = [
    `Contact de la zone ${z.lo.toFixed(2)} – ${z.hi.toFixed(2)}`,
    bull ? `Bougie M5 qui clôture au-dessus de ${z.mid.toFixed(2)} (clôture haussière) après le contact`
         : `Bougie M5 qui clôture sous ${z.mid.toFixed(2)} (clôture baissière) après le contact`,
    bull ? 'Alternative : balayage d\'un creux M5 sous la zone puis clôture M5 de retour au-dessus'
         : 'Alternative : balayage d\'un sommet M5 au-dessus de la zone puis clôture M5 de retour en dessous',
    `Scénario annulé si une bougie M5 clôture ${bull ? 'sous' : 'au-dessus de'} ${inv.toFixed(2)}`
  ];
  return { ...sc, ok: score >= 35, weak: score < 35, zoneId: null, zone: { lo: z.lo, hi: z.hi, mid: z.mid, kinds: z.kinds }, _cluster: z,
           entry, inv, risk, targets: [t1, t2].filter(Boolean).map(t => ({ price: t.price, kind: t.kind })), rr, score,
           niveau: score >= 70 ? 'Solide' : score >= 50 ? 'Correct' : 'Faible', arguments: arg, confirmation: conf,
           reason: score >= 35 ? null : 'Confluences insuffisantes : scénario trop faible pour être proposé.' };
};

// ---- analyse complète d'un actif à partir de bougies D1/H4/H1 terminées
T.analyze = (S) => {
  const { D, H4, H1 } = S;
  const atrD = T.atr(D), atrH4 = T.atr(H4), atrH1 = T.atr(H1);
  if (![atrD, atrH4, atrH1].every(isFinite)) throw new Error('Pas assez de bougies pour calculer les niveaux (D1, H4 et H1 requis).');
  const price = H1[H1.length - 1].c;
  const sD = T.structure(D, 3), s4 = T.structure(H4, 3), bias = T.bias(sD, s4);
  const lv = T.keyLevels(H1);
  const rng = D.slice(-30), hi30 = Math.max(...rng.map(x => x.h)), lo30 = Math.min(...rng.map(x => x.l));
  const pos = hi30 > lo30 ? (price - lo30) / (hi30 - lo30) : 0.5;
  const raw = [];
  T.orderBlocks(H4, atrH4, 120, 'H4').forEach(e => raw.push({ ...e, w: 3 }));
  T.orderBlocks(D, atrD, 40, 'D1').forEach(e => raw.push({ ...e, w: 4 }));
  T.fvgs(H4, atrH4, 120, 'H4').forEach(e => raw.push({ ...e, w: 2 }));
  T.fvgs(D, atrD, 40, 'D1', 0.3).forEach(e => raw.push({ ...e, w: 3 }));
  T.srZones(D, H4, atrD, atrH4).forEach(e => raw.push({ ...e, dir: e.hi <= price ? 'demand' : e.lo >= price ? 'supply' : null, w: Math.min(3, e.w) }));
  const eqAll = [...T.equalLevels(H4, atrH4, 3, 0.12, 160, 'H4'), ...T.equalLevels(H1, atrH1, 3, 0.15, 240, 'H1')];
  const eqLow = eqAll.filter(e => e.kind === 'EQL' && !e.swept && e.level < price), eqHigh = eqAll.filter(e => e.kind === 'EQH' && !e.swept && e.level > price);
  const th = 0.04 * atrH4;
  eqLow.forEach(e => raw.push({ kind: 'EQL', tf: e.tf, dir: 'demand', lo: e.level - th, hi: e.level + th, w: e.tf === 'H4' ? 2 : 1 }));
  eqHigh.forEach(e => raw.push({ kind: 'EQH', tf: e.tf, dir: 'supply', lo: e.level - th, hi: e.level + th, w: e.tf === 'H4' ? 2 : 1 }));
  const lines = [['PWH', lv.PWH], ['PWL', lv.PWL], ['PDH', lv.PDH], ['PDL', lv.PDL]];
  lines.forEach(([k, v]) => { if (v == null) return; raw.push({ kind: k, tf: k.startsWith('PW') ? 'Semaine' : 'Jour', dir: v < price ? 'demand' : 'supply', lo: v - th, hi: v + th, w: k.startsWith('PW') ? 2 : 1.5, level: v }); });
  const demand = raw.filter(e => e.dir === 'demand' && e.hi <= price + 0.15 * atrH4);
  const supply = raw.filter(e => e.dir === 'supply' && e.lo >= price - 0.15 * atrH4);
  const cap = 1.6 * atrH4, tolC = 0.3 * atrH4;
  const cD = T.cluster(demand, tolC, cap), cS = T.cluster(supply, tolC, cap);
  const near = (c, up) => (up ? c.lo - price : price - c.hi) / atrD <= 4;
  const watchD = cD.filter(c => near(c, false)).sort((a, b) => b.rank - a.rank).slice(0, 3);
  const watchS = cS.filter(c => near(c, true)).sort((a, b) => b.rank - a.rank).slice(0, 3);
  const targetsUp = [...cS.map(c => ({ price: c.lo, kind: c.kinds.includes('EQH') ? 'EQH' : c.kinds[0] })),
                     ...eqHigh.map(e => ({ price: e.level, kind: 'EQH' })), ...(lv.PWH > price ? [{ price: lv.PWH, kind: 'PWH' }] : []), ...(lv.PDH > price ? [{ price: lv.PDH, kind: 'PDH' }] : [])];
  const targetsDown = [...cD.map(c => ({ price: c.hi, kind: c.kinds.includes('EQL') ? 'EQL' : c.kinds[0] })),
                       ...eqLow.map(e => ({ price: e.level, kind: 'EQL' })), ...(lv.PWL < price ? [{ price: lv.PWL, kind: 'PWL' }] : []), ...(lv.PDL < price ? [{ price: lv.PDL, kind: 'PDL' }] : [])];
  const X = { price, atrD, atrH4, bias, pos, demand: cD, supply: cS, targetsUp, targetsDown, eqLow, eqHigh };
  const bull = T.buildScenario('bull', X), bear = T.buildScenario('bear', X);
  // zones à surveiller (identifiants stables Z1..Zn) ; les scénarios pointent vers leur zone
  const zones = []; let n = 1;
  const mk = (c, side) => ({ id: 'Z' + (n++), side, lo: c.lo, hi: c.hi, mid: c.mid, kinds: c.kinds, tfs: [...new Set(c.els.map(e => e.tf))], rank: c.rank,
                             fresh: c.els.filter(e => e.fresh !== undefined).every(e => e.fresh), status: 'attente',
                             t0: (ts => ts.length ? Math.min(...ts) : null)(c.els.map(e => e.t).filter(Boolean)) });
  const wz = [...watchS.map(c => ({ c, side: 'offre' })), ...watchD.map(c => ({ c, side: 'demande' }))];
  for (const sc of [bull, bear]) if (sc.zone && !wz.some(w => w.c === sc._cluster)) wz.push({ c: sc._cluster, side: sc.dir === 'bull' ? 'demande' : 'offre' });
  wz.forEach(w => { const z = mk(w.c, w.side); zones.push(z); [bull, bear].forEach(sc => { if (sc._cluster === w.c) sc.zoneId = z.id; }); });
  [bull, bear].forEach(sc => delete sc._cluster);
  const lastEv = (s) => s.events.slice(-3).map(e => ({ type: e.type, dir: e.dir, level: e.level, t: e.t }));
  return { price, priceT: H1[H1.length - 1].t, atr: { D: atrD, H4: atrH4, H1: atrH1 }, bias, pos, range30: { hi: hi30, lo: lo30 },
           structure: { D1: { trend: sD.trend, events: lastEv(sD) }, H4: { trend: s4.trend, events: lastEv(s4) } },
           levels: { PWH: lv.PWH, PWL: lv.PWL, PWC: lv.PWC, PDH: lv.PDH, PDL: lv.PDL },
           eq: [...eqHigh, ...eqLow].map(e => ({ kind: e.kind, tf: e.tf, level: e.level, count: e.count })),
           zones, scenarios: { bull, bear } };
};
// snapshot compact des bougies pour re-dessiner le graphique plus tard
T.snap = (b, n) => b.slice(-n).map(x => [x.t, x.o, x.h, x.l, x.c]);
T.unsnap = a => a.map(x => ({ t: x[0], o: x[1], h: x[2], l: x[3], c: x[4] }));

// ---- suivi : compare le plan aux bougies récentes (M5 de préférence)
T.track = (asset, bars, fromT) => {
  const an = asset.analysis, atrH4 = an.atr.H4, atrD = an.atr.D, B = bars.filter(x => x.t >= fromT);
  const out = { zones: {}, scenarios: {}, lastPrice: B.length ? B[B.length-1].c : an.price, lastT: B.length ? B[B.length-1].t : an.priceT, bars: B.length };
  const z0 = {}; an.zones.forEach(z => { z0[z.id] = z; });
  // zones
  for (const z of an.zones) {
    let touched = false, passed = false;
    for (const x of B) {
      if (x.l <= z.hi && x.h >= z.lo) touched = true;
      if (z.side === 'demande' ? x.c < z.lo - 0.25 * atrH4 : x.c > z.hi + 0.25 * atrH4) passed = true;
    }
    const last = out.lastPrice, dist = last > z.hi ? last - z.hi : last < z.lo ? z.lo - last : 0;
    out.zones[z.id] = passed ? 'depassee' : touched ? 'touchee' : dist <= 0.6 * atrH4 ? 'approchee' : 'attente';
  }
  // scénarios
  for (const k of ['bull', 'bear']) {
    const sc = an.scenarios[k]; if (!sc || !sc.ok) continue;
    const bull = sc.dir === 'bull', t1 = sc.targets[0] && sc.targets[0].price;
    let st = 'attente', conf = null, res = null, entryPx = null;
    for (const x of B) {
      if (st === 'attente') {
        const touch = x.l <= sc.zone.hi && x.h >= sc.zone.lo;
        if (touch) st = 'touchee';
        else if (t1 != null && (bull ? x.h >= t1 : x.l <= t1)) { st = 'manque'; break; }
      }
      if (st === 'touchee') {
        if (bull ? x.c < sc.inv : x.c > sc.inv) { st = 'invalide'; break; }
        if (bull ? (x.c > sc.zone.mid && x.c > x.o) : (x.c < sc.zone.mid && x.c < x.o)) { st = 'confirme'; conf = x.t; entryPx = x.c; continue; }
      }
      if (st === 'confirme') {
        if (bull ? x.l <= sc.inv : x.h >= sc.inv) { st = 'invalide'; res = -1; break; }
        if (t1 != null && (bull ? x.h >= t1 : x.l <= t1)) { st = 'objectif'; const rk = Math.abs(entryPx - sc.inv); res = rk > 0 ? Math.abs(t1 - entryPx) / rk : null; break; }
      }
    }
    if (st === 'attente') { const d = bull ? out.lastPrice - sc.zone.hi : sc.zone.lo - out.lastPrice; if (d >= 0 && d <= 0.6 * atrH4) st = 'approchee'; }
    out.scenarios[k] = { status: st, confirmedAt: conf, entry: entryPx, r: res };
  }
  // statut final des zones liées à un scénario confirmé / invalidé
  for (const k of ['bull', 'bear']) { const s = out.scenarios[k], sc = an.scenarios[k]; if (s && sc && sc.zoneId && ['confirme', 'invalide', 'objectif'].includes(s.status)) out.zones[sc.zoneId] = s.status === 'invalide' ? 'scenario_invalide' : 'scenario_confirme'; }
  // le plan doit-il être actualisé ?
  const reasons = [];
  if (Math.abs(out.lastPrice - an.price) > 2 * atrD) reasons.push('Le prix s\'est éloigné de plus de 2 ATR journaliers du prix de création du plan.');
  const alive = ['bull', 'bear'].filter(k => an.scenarios[k] && an.scenarios[k].ok && !['invalide', 'manque', 'objectif'].includes((out.scenarios[k] || {}).status));
  if (!alive.length && ['bull', 'bear'].some(k => an.scenarios[k] && an.scenarios[k].ok)) reasons.push('Tous les scénarios sont invalidés, manqués ou terminés.');
  out.needsRefresh = reasons.length > 0; out.reasons = reasons;
  return out;
};

/* ============ 4. ANALYSE IA (Gemini) ============
 * Gemini reçoit uniquement des niveaux calculés à partir des données réelles. Il explique, il n'invente aucun prix.
 * Tout nombre « de type prix » cité par l'IA qui ne correspond à aucun niveau fourni est signalé. */
const AI = {
  compact(plan) {
    const r2 = x => x == null ? null : +(+x).toFixed(Math.abs(x) >= 100 ? 2 : 5);
    return { semaine: plan.id, assets: plan.assets.filter(a => a.analysis).map(a => { const an = a.analysis;
      return { symbole: a.symbol, prix: r2(an.price), biais: an.bias.label, arguments_biais: an.bias.args, structure: an.structure,
        niveaux: Object.fromEntries(Object.entries(an.levels).map(([k, v]) => [k, r2(v)])),
        liquidite: an.eq.map(e => ({ type: e.kind, tf: e.tf, niveau: r2(e.level) })),
        zones: an.zones.map(z => ({ id: z.id, cote: z.side, bas: r2(z.lo), haut: r2(z.hi), confluences: z.kinds.map(T.kindFr), tf: z.tfs, fraiche: z.fresh })),
        scenarios: ['bull', 'bear'].map(k => { const s = an.scenarios[k]; return s.zone ? { id: k, zone: s.zoneId, entree: r2(s.entry), invalidation: r2(s.inv), objectifs: s.targets.map(t => ({ niveau: r2(t.price), type: t.kind })), rr: s.rr && +s.rr.toFixed(2), score: s.score, niveau: s.niveau, arguments: s.arguments.map(x => x.txt), faible: !s.ok } : { id: k, aucun: true, raison: s.reason }; }) }; }),
      calendrier: plan.calendar.ok ? plan.calendar.events.map(e => ({ date: new Date(e.t).toISOString(), titre: e.title, devise: e.cur, impact: e.impact, prevision: e.forecast, precedent: e.previous })) : 'indisponible' };
  },
  prompt(plan) {
    return `Tu es un analyste de marché prudent. Tu rédiges en français le commentaire d'un plan de trading hebdomadaire (scalping M5).
Les données ci-dessous ont été calculées à partir de VRAIES bougies de marché. Les scénarios, zones, niveaux et scores sont déjà calculés : tu ne les modifies pas.

RÈGLES STRICTES
- N'utilise QUE les prix fournis. N'invente aucun prix, niveau, annonce, horaire ni résultat. Désigne les zones par leur identifiant (Z1, Z2…).
- Ne prétends jamais avoir vérifié une donnée que tu n'as pas reçue. Aucun scénario n'est garanti : mentionne les incertitudes.
- Si un scénario est faible ("faible": true, "aucun": true ou score < 50), dis-le franchement au lieu de le vendre.
- Un contact avec une zone n'est PAS un signal d'entrée : la confirmation M5 est une condition distincte.
- Pas de listes de promesses ni de conseils financiers : c'est une aide à la lecture.
- explication : 2 à 4 phrases techniques. confirmation_m5 : 2 à 3 conditions concrètes reprenant les niveaux fournis. incertitudes : 1 à 3 points. calendrier : 1 à 2 phrases sur les événements fournis qui peuvent perturber les scénarios (si le calendrier est indisponible ou vide, dis-le).

DONNÉES
${JSON.stringify(this.compact(plan))}

RÉPONDS UNIQUEMENT EN JSON :
{"resume":"vue d'ensemble de la semaine en 2-3 phrases","actifs":[{"symbole":"","contexte":"2-3 phrases","scenarios":[{"id":"bull","explication":"","confirmation_m5":[""],"incertitudes":[""]},{"id":"bear","explication":"","confirmation_m5":[""],"incertitudes":[""]}],"calendrier":""}],"limites":"limites de cette analyse en 1-2 phrases"}`;
  },
  async call(prompt, say, opt) {
    opt = opt || {}; const parts = opt.parts || [{ text: prompt }], level = opt.thinking || 'low';
    const key = (document.getElementById('key') || {}).value, model = ((document.getElementById('model') || {}).value || '').trim() || 'gemini-3.8-flash';
    if (!key || !key.trim()) throw new Error('Clé Gemini absente');
    const models = [model, ...['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.5-flash'].filter(m => m !== model)];
    let think = true, last = '';
    const body = () => JSON.stringify({ contents: [{ parts }], generationConfig: Object.assign({ responseMimeType: 'application/json', temperature: .3 }, think ? { thinkingConfig: { thinkingLevel: level } } : {}) });
    for (let mi = 0; mi < models.length; mi++) for (let t = 0; t < 2; t++) {
      if (mi || t) say && say('Gemini surchargé, nouvel essai…');
      try {
        const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(models[mi]) + ':generateContent?key=' + encodeURIComponent(key.trim()), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body() });
        const x = await r.json();
        if (r.ok) { const txt = x.candidates[0].content.parts.map(p => p.text || '').join('').replace(/```json|```/g, '').trim(); return JSON.parse(txt); }
        last = (x.error && x.error.message) || 'Erreur ' + r.status;
        if (r.status === 400 && think && /thinking/i.test(last)) { think = false; t--; continue; }
        if (r.status === 404) break;
        if (![429, 500, 503, 504].includes(r.status)) throw new Error(last);
      } catch (e) { if (e instanceof TypeError) last = 'Connexion interrompue'; else if (e instanceof SyntaxError) last = 'Réponse IA illisible'; else throw e; }
      await sleep(2500);
    }
    throw new Error(last || 'Gemini indisponible');
  },
  // nombres « de type prix » cités par l'IA qui ne correspondent à aucun niveau fourni
  unverified(text, price, allowed) {
    const out = [], re = /(\d{1,3}(?:[\s\u00a0\u202f]\d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)?)(\s*(?:R\b|ATR|%|x\b|fois|bougies?|heures?|h\b|jours?|pts?|points?))?/g;
    let m;
    while ((m = re.exec(String(text || '')))) {
      if (m[2]) continue;
      const raw = m[1].replace(/[\s\u00a0\u202f]/g, '').replace(',', '.'), v = parseFloat(raw), dec = (raw.split('.')[1] || '').length;
      if (!isFinite(v) || Math.abs(v - price) / price > 0.4 || !(v >= 100 || dec >= 3)) continue;
      if (/^Z\d/.test(m[0])) continue;
      if (!allowed.some(a => Math.abs(a - v) <= Math.max(0.0006 * price, 1e-9))) out.push(m[1]);
    }
    return [...new Set(out)];
  },
  allowedPrices(an) {
    const a = [an.price]; Object.values(an.levels).forEach(v => v != null && a.push(v)); an.eq.forEach(e => a.push(e.level));
    an.zones.forEach(z => a.push(z.lo, z.hi, z.mid)); ['bull', 'bear'].forEach(k => { const s = an.scenarios[k]; if (s && s.zone) { a.push(s.zone.lo, s.zone.hi, s.zone.mid, s.entry, s.inv); s.targets.forEach(t => a.push(t.price)); } });
    an.structure.D1.events.concat(an.structure.H4.events).forEach(e => a.push(e.level)); a.push(an.range30.hi, an.range30.lo);
    return a.filter(x => x != null && isFinite(x));
  },
  // intègre la réponse de l'IA dans le plan et signale tout niveau non vérifié
  merge(plan, resp) {
    plan.ai = { resume: String(resp.resume || ''), limites: String(resp.limites || ''), at: Date.now() };
    for (const a of plan.assets) {
      if (!a.analysis) continue;
      const r = (resp.actifs || []).find(x => String(x.symbole).toUpperCase() === String(a.symbol).toUpperCase()) || (resp.actifs || [])[plan.assets.filter(q => q.analysis).indexOf(a)];
      if (!r) continue;
      const allowed = this.allowedPrices(a.analysis), flagged = [];
      const clean = s => { const t = String(s || ''); this.unverified(t, a.analysis.price, allowed).forEach(x => flagged.push(x)); return t; };
      a.ai = { contexte: clean(r.contexte), calendrier: clean(r.calendrier), scenarios: {} };
      (r.scenarios || []).forEach(s => { if (s && (s.id === 'bull' || s.id === 'bear')) a.ai.scenarios[s.id] = { explication: clean(s.explication), confirmation: (s.confirmation_m5 || []).map(clean), incertitudes: (s.incertitudes || []).map(clean) }; });
      a.ai.flagged = [...new Set(flagged)];
    }
    return plan;
  },
  // ---- mode captures : Gemini lit les graphiques ; l'app valide, calcule le score et dessine
  shotPrompt(a, tfs) {
    return `Tu es un analyste ICT/SMC prudent. Voici des captures de graphique NU de ${a.label} (${a.symbol}), étiquetées ${tfs.join(', ')}. Tu prépares le PLAN DE LA SEMAINE À VENIR pour du scalping M5.

RÈGLES STRICTES
- Tout prix doit être LU sur l'axe des prix des captures. N'invente aucun prix. Si l'axe est illisible sur une capture, mets "lisible": false pour elle.
- Pour CHAQUE capture, donne "echelle" : au moins 3 étiquettes de prix bien lisibles et espacées (une en haut, une au milieu, une en bas, plus l'étiquette du prix actuel si visible), chacune avec son "prix" et sa position verticale "y" (entier 0 à 1000, 0 = haut de l'image, 1000 = bas). Donne aussi "trace" : x_min et x_max de la zone des bougies (0 à 1000, hors axe des prix). L'app place ensuite tout à partir de ces repères : lis les y avec le plus grand soin.
- Retiens peu de zones, mais nettes : 4 à 7 maximum. Pour chacune : id (Z1, Z2…), cote ("demande" sous le prix, "offre" au-dessus), type (liste parmi OB, FVG, SR, EQL, EQH, PWH, PWL, PDH, PDL), tf, bas et haut (prix), x_debut (position horizontale de son origine, 0 à 1000), fraiche (true si jamais retestée), raison (courte). Pas de zone dont tu n'es pas sûr de lire les prix.
- Identifie le biais (haussier, baissier ou neutre) avec des arguments (structure, BOS/CHoCH visibles), la liquidité visible (sommets/creux égaux) et le plus haut/bas de la semaine ou du jour précédents s'ils sont lisibles.
- Deux scénarios CONDITIONNELS : "bull" (zone d'achat potentielle) et "bear" (zone de vente potentielle). Chacun : zone (id), entree (dans la zone), invalidation (au-delà de la zone), objectifs (1 à 2 prix lus sur le graphique, avec type), explication (2-3 phrases), confirmation_m5 (2 à 3 conditions concrètes), incertitudes, criteres. S'il n'y a pas de scénario net, mets "aucun": true et explique pourquoi : N'INVENTE PAS une opportunité.
- criteres : 5 clés (biais = D1/H4 alignés avec le scénario ; confluences = au moins 2 éléments dans la zone ; fraicheur = zone jamais retestée ; liquidite = liquidité visible à balayer ou à viser ; position = achat en décote / vente en prime de la fourchette). Pour chacune : v = "oui", "partiel" ou "non" et c = commentaire de 12 mots maximum. Sois sévère : "oui" seulement si c'est visible. Ne donne PAS de score : l'app le calcule.
- Un contact avec une zone n'est pas un signal d'entrée. Aucun scénario n'est garanti. Ne cite aucune annonce économique.
- amplitude_bougie_h4 : amplitude typique d'une bougie H4, en prix, lue sur le graphique (0 si impossible).

RÉPONDS UNIQUEMENT EN JSON :
{"actif_lu":"","prix_lu":0,"amplitude_bougie_h4":0,
"images":[{"tf":"H4","lisible":true,"echelle":[{"prix":0,"y":0}],"trace":{"x_min":0,"x_max":880}}],
"biais":{"label":"haussier|baissier|neutre","arguments":[""]},
"niveaux":{"pwh":0,"pwl":0,"pdh":0,"pdl":0},
"liquidite":[{"type":"EQH","prix":0,"tf":"H4"}],
"zones":[{"id":"Z1","cote":"demande","type":["OB","FVG"],"tf":"H4","bas":0,"haut":0,"x_debut":0,"fraiche":true,"raison":""}],
"scenarios":{"bull":{"aucun":false,"raison_aucun":"","zone":"Z1","entree":0,"invalidation":0,"objectifs":[{"prix":0,"type":"EQH"}],"explication":"","confirmation_m5":[""],"incertitudes":[""],"criteres":{"biais":{"v":"oui","c":""},"confluences":{"v":"oui","c":""},"fraicheur":{"v":"oui","c":""},"liquidite":{"v":"oui","c":""},"position":{"v":"oui","c":""}}},"bear":{}},
"contexte":"2-3 phrases","resume":"1-2 phrases","limites":"1 phrase"}`;
  },
  updatePrompt(a) {
    const an = a.analysis, z = an.zones.map(q => ({ id: q.id, cote: q.side, bas: q.lo, haut: q.hi })), sc = ['bull', 'bear'].map(k => { const s = an.scenarios[k]; return s.zone ? { id: k, zone: s.zoneId, entree: s.entry, invalidation: s.inv, objectifs: s.targets.map(t => t.price) } : { id: k, aucun: true }; });
    return `Voici le PLAN de la semaine pour ${a.label} (prix à la création : ${an.price}) et une NOUVELLE capture du graphique. Compare la situation actuelle au plan.
PLAN : ${JSON.stringify({ zones: z, scenarios: sc })}

RÈGLES : lis le prix actuel et l'échelle sur la capture (au moins 3 repères prix/y). N'invente aucun prix. Un contact avec une zone n'est pas une confirmation : un scénario n'est "confirme" que si la bougie de confirmation M5 décrite est visible. Si tu n'es pas sûr, garde "attente".
Statuts zone : attente | approchee | touchee | depassee. Statuts scénario : attente | approchee | touchee | confirme | invalide | objectif | manque (manque = objectif atteint sans retour sur la zone).
actualiser.besoin = true si le marché a fortement évolué (prix très loin des zones, scénarios invalidés ou manqués).
RÉPONDS UNIQUEMENT EN JSON : {"prix_lu":0,"echelle":[{"prix":0,"y":0}],"zones":[{"id":"Z1","statut":"attente"}],"scenarios":{"bull":{"statut":"attente","note":""},"bear":{"statut":"attente","note":""}},"actualiser":{"besoin":false,"raisons":[""]},"commentaire":""}`;
  },
  // explication de secours, 100 % déterministe, si Gemini est indisponible
  fallback(a, k) {
    const s = a.analysis.scenarios[k];
    if (!s || !s.zone) return { explication: s ? s.reason : '', confirmation: [], incertitudes: [] };
    return { explication: `Zone ${s.zoneId} (${fp(s.zone.lo, a.analysis.price)} – ${fp(s.zone.hi, a.analysis.price)}) : ${s.zone.kinds.map(T.kindFr).join(' + ')}. Score ${s.score}/100 (${s.niveau}).`, confirmation: s.confirmation, incertitudes: ['Explication IA indisponible : texte généré à partir des seuls calculs.'] };
  }
};
P.AI = AI;

/* ============ 5a. GRAPHIQUE ANNOTÉ (dessiné uniquement à partir des niveaux calculés) ============ */
const ABBR = { OB: 'OB', FVG: 'FVG', SR: 'S/R', EQL: 'EQL', EQH: 'EQH', PWH: 'PWH', PWL: 'PWL', PDH: 'PDH', PDL: 'PDL' };
const ST_FR = { attente: 'en attente', approchee: 'approchée', touchee: 'touchée', depassee: 'dépassée', scenario_confirme: 'scénario confirmé', scenario_invalide: 'scénario invalidé' };
const SC_FR = { attente: 'En attente', approchee: 'Zone approchée', touchee: 'Zone touchée : confirmation M5 attendue', confirme: 'Scénario confirmé (suivi en cours)', invalide: 'Scénario invalidé', objectif: 'Objectif 1 atteint', manque: 'Manqué : objectif atteint sans retour sur la zone' };
// modèle du graphique : tout ce qui sera dessiné, avec son prix source
function chartModel(a, tf, tracking) {
  const an = a.analysis, N = { D1: 70, H4: 100, H1: 120 }[tf] || 100;
  const bars = T.unsnap(a.bars[tf]).slice(-N); if (!bars.length) return null;
  let mn = Math.min(...bars.map(b => b.l)), mx = Math.max(...bars.map(b => b.h)); const R = mx - mn;
  const items = [], inR = (p, m) => p >= mn - (m || 0) * R && p <= mx + (m || 0) * R;
  // prix importants (scénarios) : on élargit le cadre s'ils sont proches
  const imp = []; ['bull', 'bear'].forEach(k => { const s = an.scenarios[k]; if (s && s.zone) { imp.push(s.zone.lo, s.zone.hi, s.inv); s.targets.forEach(t => imp.push(t.price)); } });
  imp.filter(p => inR(p, 0.9)).forEach(p => { mn = Math.min(mn, p); mx = Math.max(mx, p); });
  const pad = (mx - mn) * 0.05; mn -= pad; mx += pad;
  const ts = (tracking && tracking.zones) || {};
  an.zones.forEach(z => { if (z.hi < mn || z.lo > mx) return; items.push({ k: 'zone', lo: z.lo, hi: z.hi, side: z.side, t0: z.t0, label: z.id + ' ' + z.kinds.map(x => ABBR[x] || x).join('+') + (ts[z.id] && ts[z.id] !== 'attente' ? ' · ' + ST_FR[ts[z.id]] : '') }); });
  [['PWH', an.levels.PWH], ['PWL', an.levels.PWL], ['PDH', an.levels.PDH], ['PDL', an.levels.PDL]].forEach(([n, p]) => { if (p != null && p >= mn && p <= mx) items.push({ k: 'line', p, label: n, c: '#7f93ab' }); });
  an.eq.forEach(e => { if (e.level >= mn && e.level <= mx) items.push({ k: 'line', p: e.level, label: e.kind + ' ' + e.tf, c: '#ffa62b', dot: true }); });
  ['bull', 'bear'].forEach(k => { const s = an.scenarios[k]; if (!s || !s.zone) return; const bull = k === 'bull';
    if (s.zone.hi >= mn && s.zone.lo <= mx) items.push({ k: 'scn', lo: s.zone.lo, hi: s.zone.hi, bull, label: (bull ? 'Achat potentiel ' : 'Vente potentielle ') + s.zoneId });
    if (s.inv >= mn && s.inv <= mx) items.push({ k: 'line', p: s.inv, label: 'Inval. ' + (bull ? 'haussier' : 'baissier'), c: '#e5534b', dash: true });
    s.targets.forEach((t, i) => { if (t.price >= mn && t.price <= mx) items.push({ k: 'line', p: t.price, label: 'T' + (i + 1) + (bull ? ' ↑ ' : ' ↓ ') + (ABBR[t.kind] || t.kind), c: '#2fbf71', dash: true }); });
    if (s.ok) items.push({ k: 'path', bull, from: (tracking && tracking.lastPrice) || an.price, via: s.zone.mid, to: s.targets[0] ? s.targets[0].price : null });
  });
  items.push({ k: 'line', p: (tracking && tracking.lastPrice) || an.price, label: 'Prix', c: '#e9edf2', dot: true });
  return { bars, items, mn, mx, tf, title: `${a.label || a.symbol} · ${tf} · plan du ${dday(a.created || Date.now())}` };
}
function drawChart(cv, m) {
  const W = 1080, H = 1180, g = cv.getContext('2d'); cv.width = W; cv.height = H;
  const L = 16, Rm = 260, Tp = 74, Bt = 110, pw = W - L - Rm, ph = H - Tp - Bt;
  const y = p => Tp + (m.mx - p) / (m.mx - m.mn) * ph, n = m.bars.length, sp = pw / n, cw = Math.max(3, sp * .62);
  const xOf = t => { let i = m.bars.findIndex(b => b.t >= t); return i < 0 ? pw + L : L + (i < 0 ? 0 : i) * sp; };
  g.fillStyle = '#10151c'; g.fillRect(0, 0, W, H);
  g.font = 'bold 30px system-ui,sans-serif'; g.fillStyle = '#c9a24b'; g.textBaseline = 'middle'; g.fillText(m.title, L, 34);
  g.font = '22px system-ui,sans-serif';
  // grille de prix
  const step = (() => { const r = (m.mx - m.mn) / 6, e = Math.pow(10, Math.floor(Math.log10(r))), q = r / e; return (q < 1.5 ? 1 : q < 3.5 ? 2 : q < 7.5 ? 5 : 10) * e; })();
  const ref = m.bars[m.bars.length - 1].c;
  g.strokeStyle = '#1d2631'; g.lineWidth = 1; g.fillStyle = '#6f7d8c'; g.textAlign = 'left';
  for (let p = Math.ceil(m.mn / step) * step; p <= m.mx; p += step) { g.beginPath(); g.moveTo(L, y(p)); g.lineTo(L + pw, y(p)); g.stroke(); g.fillText(fp(p, ref), L + 6, y(p) - 12); }
  // zones (derrière les bougies)
  const chips = [];
  const scnKeys = new Set(m.items.filter(i => i.k === 'scn').map(i => i.lo + '|' + i.hi));
  m.items.filter(i => i.k === 'zone' || i.k === 'scn').forEach(i => {
    const x0 = i.t0 ? Math.max(L, Math.min(xOf(i.t0), L + pw - 10)) : L, y1 = y(i.hi), y2 = y(i.lo);
    const col = i.k === 'scn' ? (i.bull ? '47,191,113' : '229,83,75') : (i.side === 'demande' ? '47,191,113' : '229,83,75');
    g.fillStyle = `rgba(${col},${i.k === 'scn' ? .28 : .15})`; g.fillRect(x0, y1, L + pw - x0, Math.max(3, y2 - y1));
    g.strokeStyle = i.k === 'scn' ? '#c9a24b' : `rgba(${col},.8)`; g.lineWidth = i.k === 'scn' ? 3 : 1.5; g.strokeRect(x0, y1, L + pw - x0, Math.max(3, y2 - y1));
    if (!(i.k === 'zone' && scnKeys.has(i.lo + '|' + i.hi))) chips.push({ y: (y1 + y2) / 2, text: i.label, c: i.k === 'scn' ? '#c9a24b' : `rgb(${col})`, bold: i.k === 'scn' });
  });
  // bougies
  m.bars.forEach((b, i) => { const x = L + i * sp + sp / 2, up = b.c >= b.o, c = up ? '#2fbf71' : '#e5534b';
    g.strokeStyle = c; g.lineWidth = 2; g.beginPath(); g.moveTo(x, y(b.h)); g.lineTo(x, y(b.l)); g.stroke();
    g.fillStyle = c; const y1 = y(Math.max(b.o, b.c)), y2 = y(Math.min(b.o, b.c)); g.fillRect(x - cw / 2, y1, cw, Math.max(2, y2 - y1)); });
  // lignes de niveaux
  m.items.filter(i => i.k === 'line').forEach(i => { g.strokeStyle = i.c; g.lineWidth = 2; g.setLineDash(i.dot ? [3, 6] : i.dash ? [14, 8] : [2, 0]); g.beginPath(); g.moveTo(L, y(i.p)); g.lineTo(L + pw, y(i.p)); g.stroke(); g.setLineDash([]); chips.push({ y: y(i.p), text: i.label + ' ' + fp(i.p, ref), c: i.c }); });
  // trajet du scénario : prix actuel → zone → objectif 1
  m.items.filter(i => i.k === 'path').forEach(i => { const pts = [[L + pw - sp * 2, y(i.from)], [L + pw - sp * 1.2, y(i.via)]]; if (i.to != null && i.to >= m.mn && i.to <= m.mx) pts.push([L + pw - 6, y(i.to)]);
    if (pts.length < 2) return; g.strokeStyle = i.bull ? '#2fbf71' : '#e5534b'; g.lineWidth = 3; g.setLineDash([10, 7]); g.beginPath(); pts.forEach((q, j) => j ? g.lineTo(q[0], q[1]) : g.moveTo(q[0], q[1])); g.stroke(); g.setLineDash([]);
    const a = pts[pts.length - 2], b = pts[pts.length - 1], ang = Math.atan2(b[1] - a[1], b[0] - a[0]); g.fillStyle = g.strokeStyle; g.beginPath(); g.moveTo(b[0], b[1]); g.lineTo(b[0] - 18 * Math.cos(ang - .45), b[1] - 18 * Math.sin(ang - .45)); g.lineTo(b[0] - 18 * Math.cos(ang + .45), b[1] - 18 * Math.sin(ang + .45)); g.closePath(); g.fill(); });
  // pastilles à droite, sans chevauchement
  chips.sort((a, b) => a.y - b.y); let last = -99; g.font = '21px system-ui,sans-serif';
  chips.forEach(c => { c.y = Math.max(c.y, last + 28); last = c.y; });
  const over = last - (Tp + ph); if (over > 0) chips.forEach(c => { c.y -= over; });
  chips.forEach(c => { let t = c.text; while (g.measureText(t).width > Rm - 14 && t.length > 6) t = t.slice(0, -2); const w = g.measureText(t).width + 12;
    g.fillStyle = 'rgba(16,21,28,.92)'; g.fillRect(L + pw + 4, c.y - 13, w, 26); g.fillStyle = c.c; g.font = (c.bold ? 'bold ' : '') + '21px system-ui,sans-serif'; g.fillText(t, L + pw + 10, c.y); });
  // axe du temps + légende
  g.fillStyle = '#6f7d8c'; g.font = '21px system-ui,sans-serif'; g.textAlign = 'center';
  for (let k = 0; k <= 4; k++) { const i = Math.min(n - 1, Math.round(k * (n - 1) / 4)); g.fillText(new Date(m.bars[i].t).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' }), L + i * sp + sp / 2, Tp + ph + 22); }
  g.textAlign = 'left'; const lg = [['#2fbf71', 'Demande / achat'], ['#e5534b', 'Offre / vente'], ['#ffa62b', 'Liquidité'], ['#c9a24b', 'Scénario']];
  lg.forEach((q, i) => { g.fillStyle = q[0]; g.fillRect(L + i * 255, H - 64, 22, 16); g.fillStyle = '#9aa7b5'; g.fillText(q[1], L + 30 + i * 255, H - 56); });
  g.fillStyle = '#6f7d8c'; g.fillText('Niveaux calculés sur données de marché · aide à la lecture, aucune garantie', L, H - 20);
  return true;
}
P.chartModel = chartModel; P.drawChart = drawChart;

/* ============ 5b. INTERFACE : onglet « Plan hebdo » ============ */
const DEFAULT_ASSETS = [
  { id: 'xau', label: 'XAU/USD (Or)', symbol: 'XAU/USD', on: true },
  { id: 'us30', label: 'US30', symbol: 'DJI', on: false },
  { id: 'eur', label: 'EUR/USD', symbol: 'EUR/USD', on: false },
  { id: 'btc', label: 'BTC/USD', symbol: 'BTC/USD', on: false }];
const ymd = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
function weekIdFor(ms) { const d = new Date(ms), day = d.getDay(), m = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  if (day === 0) m.setDate(m.getDate() + 1); else if (day === 6) m.setDate(m.getDate() + 2); else m.setDate(m.getDate() - (day - 1)); return ymd(m); }
function weekRange(id) { const [y, m, d] = id.split('-').map(Number), start = Date.UTC(y, m - 1, d) - 2 * 3600e3; return { start, end: start + 5 * DAY + 4 * 3600e3, monday: Date.UTC(y, m - 1, d) }; }
const weekLabel = id => 'Semaine du ' + dday(weekRange(id).monday);
const clone = o => JSON.parse(JSON.stringify(o));
const g$ = id => document.getElementById(id);
const gv = id => ((g$(id) || {}).value || '').trim();
const norm = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const utcStr = t => new Date(t).toISOString().slice(0, 19).replace('T', ' ');

const UI = { st: { settings: null, plans: [], cur: null, busy: false, showInitial: false, tf: {}, log: '', err: '', tests: {}, shots: {} }, root: null };
const CSS = `
.pp-tabs{display:flex;gap:6px;margin:0 0 12px}.pp-tabs button{flex:1;margin:0;padding:10px;font-size:15px;background:var(--pan);color:var(--mut);border:1px solid var(--line);font-weight:600}
.pp-tabs button.on{background:var(--brass);color:#14181e;border-color:var(--brass)}
.pp .row2{display:flex;gap:8px;flex-wrap:wrap}.pp .row2>*{flex:1;min-width:130px}
.pp button.sm{width:auto;padding:8px 12px;font-size:13px;margin:0;font-weight:600}
.pp-card{background:var(--pan);border:1px solid var(--line);border-radius:12px;padding:12px;margin-bottom:14px}
.pp-h{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:6px;font-size:16px}
.pp-bias{padding:2px 10px;border-radius:12px;font-size:12px;font-weight:700}.pp-bias.up{background:#2fbf7122;color:var(--buy)}.pp-bias.down{background:#e5534b22;color:var(--sell)}.pp-bias.flat{background:#8996a622;color:var(--mut)}
.pp-zone{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap;border-top:1px solid var(--line);padding:7px 0;font-size:14px}
.pp-zone small{color:var(--mut)}.pp-pill{margin-left:auto;font-size:12px;padding:2px 9px;border-radius:12px;border:1px solid var(--line);color:var(--mut);white-space:nowrap}
.pp-pill.st-touchee,.pp-pill.st-approchee{color:var(--brass);border-color:#c9a24b66}.pp-pill.st-scenario_confirme,.pp-pill.st-confirme,.pp-pill.st-objectif{color:var(--buy);border-color:#2fbf7166}
.pp-pill.st-scenario_invalide,.pp-pill.st-invalide,.pp-pill.st-depassee{color:var(--sell);border-color:#e5534b66}
.pp-sc{border:1px solid var(--line);border-left:4px solid var(--mut);border-radius:10px;padding:10px;margin:10px 0;background:var(--bg)}
.pp-sc.bull{border-left-color:var(--buy)}.pp-sc.bear{border-left-color:var(--sell)}
.pp-sch{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:6px}.pp-score{font-weight:700;color:var(--brass)}
.pp-sc p{margin:5px 0;font-size:14px}.pp-sc details{margin:4px 0;font-size:13px}.pp-sc summary{cursor:pointer;color:var(--brass)}
.pp-sc ul{margin:4px 0;padding-left:18px}.pp-ck{display:flex;gap:6px;font-size:13px;padding:3px 0}.pp-ck b{min-width:14px}.pp-ck span.p{margin-left:auto;color:var(--mut);white-space:nowrap}
.pp-ban{background:#c9a24b18;border:1px solid #c9a24b66;border-radius:10px;padding:10px;margin-bottom:12px;font-size:14px}.pp-err{color:var(--sell);font-size:14px}
.pp-cv{width:100%;border-radius:8px;border:1px solid var(--line);margin-top:8px;background:#10151c}.pp-tf{display:flex;gap:6px;margin-top:8px}.pp-tf button{width:auto;margin:0;padding:6px 12px;font-size:13px;background:transparent;color:var(--mut);border:1px solid var(--line)}.pp-tf button.on{color:var(--brass);border-color:var(--brass)}
.pp-ev{display:flex;gap:8px;font-size:13px;border-top:1px solid var(--line);padding:6px 0;align-items:baseline}.pp-ev .imp{font-size:11px;padding:1px 7px;border-radius:10px}.pp-ev .High{background:#e5534b22;color:var(--sell)}.pp-ev .Medium{background:#c9a24b22;color:var(--brass)}.pp-ev .Holiday{background:#8996a622;color:var(--mut)}
.pp-as{display:flex;gap:6px;align-items:center;margin:6px 0}.pp-as input[type=text]{flex:1;min-width:0;padding:8px;font-size:14px}.pp-as input[type=checkbox]{width:22px;height:22px;flex:none}
.pp-hist{display:flex;gap:8px;align-items:center;flex-wrap:wrap;border-top:1px solid var(--line);padding:8px 0;font-size:13px}.pp-hist .t{flex:1;min-width:150px}
.pp-log{font-size:13px;color:var(--brass);margin:6px 0;min-height:18px}
.pp-upd{display:inline-block;margin-top:8px;cursor:pointer}.pp-upd .b{display:inline-block;padding:8px 12px;border:1px solid var(--brass);color:var(--brass);border-radius:9px;font-size:13px;font-weight:600}
.pp-sh{border-top:1px solid var(--line);padding:8px 0}.pp-slots{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:6px}
.pp-slot{position:relative;border:1px dashed var(--line);border-radius:8px;aspect-ratio:3/4;display:flex;align-items:center;justify-content:center;font-size:13px;color:var(--mut);overflow:hidden;background:var(--bg);cursor:pointer;text-align:center}
.pp-slot img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}.pp-slot .tg{position:absolute;left:4px;top:4px;background:#000a;color:#fff;font-size:12px;padding:1px 6px;border-radius:5px;z-index:2}
.pp-slot input{position:absolute;inset:0;opacity:0;cursor:pointer;width:100%;height:100%}`;

async function loadSettings() {
  const s = await Store.getKV('settings', null);
  UI.st.settings = s && Array.isArray(s.assets) ? s : { assets: clone(DEFAULT_ASSETS), auto: true };
  if (!UI.st.settings.source) UI.st.settings.source = 'captures';   // pour l'instant : le plan est construit à partir de captures
}
const saveSettings = () => Store.setKV('settings', UI.st.settings);
const say = m => { UI.st.log = m; const e = g$('ppLog'); if (e) e.textContent = m; };
const statusPill = (s, map) => `<span class="pp-pill st-${esc(s)}">${esc((map || ST_FR)[s] || s)}</span>`;

function biasCls(l) { return l === 'haussier' ? 'up' : l === 'baissier' ? 'down' : 'flat'; }
function scenarioHTML(a, k, view) {
  const an = a.analysis, s = an.scenarios[k], bull = k === 'bull', ai = (a.ai && a.ai.scenarios && a.ai.scenarios[k]) || AI.fallback(a, k);
  const tr = view.tracking, ts = tr && tr.scenarios && tr.scenarios[k];
  const head = `<div class="pp-sch"><b>${bull ? 'Scénario haussier' : 'Scénario baissier'}</b>${s.zone ? `<span class="pp-score">${s.score}/100 · ${esc(s.niveau)}</span>` : ''}${ts ? statusPill(ts.status, SC_FR) : ''}</div>`;
  if (!s.zone) return `<div class="pp-sc ${k}">${head}<p>${esc(s.reason)}</p><p class="note">Aucun scénario ${bull ? 'haussier' : 'baissier'} n'est proposé : mieux vaut ne rien forcer.</p></div>`;
  const f = x => fp(x, an.price), rr = s.rr != null ? ` · RR ${s.rr.toFixed(2)}` : '';
  const tg = s.targets.length ? s.targets.map((t, i) => `T${i + 1} ${f(t.price)} <small>(${esc(T.kindFr(t.kind))})</small>`).join(' · ') : '<i>objectif non déterminable avec les données</i>';
  const ck = s.arguments.map(x => `<div class="pp-ck"><b style="color:${x.ok === 1 ? 'var(--buy)' : x.ok === .5 ? 'var(--brass)' : 'var(--sell)'}">${x.ok === 1 ? '✓' : x.ok === .5 ? '◐' : '✗'}</b><span>${esc(x.txt)}</span><span class="p">${x.pts}/${x.max}</span></div>`).join('');
  const conf = (ai.confirmation && ai.confirmation.length ? ai.confirmation : s.confirmation).map(x => `<li>${esc(x)}</li>`).join('');
  const unc = (ai.incertitudes || []).map(x => `<li>${esc(x)}</li>`).join('');
  return `<div class="pp-sc ${k}">${head}
    ${s.ok ? '' : `<p class="pp-err">Scénario faible : ${esc(s.reason)}</p>`}
    <p><b>${bull ? 'Zone d\'achat potentielle' : 'Zone de vente potentielle'}</b> ${esc(s.zoneId)} : ${f(s.zone.lo)} – ${f(s.zone.hi)} <small>${s.zone.kinds.map(T.kindFr).map(esc).join(' + ')}</small></p>
    <p>Entrée de référence <b>${f(s.entry)}</b> · Invalidation <b>${f(s.inv)}</b>${rr}<br>Objectifs : ${tg}</p>
    ${ai.explication ? `<p>${esc(ai.explication)}</p>` : ''}
    <details><summary>Confirmation M5 attendue</summary><ul>${conf}</ul></details>
    <details><summary>Score de confiance argumenté</summary>${ck}<p class="note">Ce score mesure la qualité des confluences, pas une probabilité de gain.</p></details>
    ${unc ? `<details><summary>Incertitudes</summary><ul>${unc}</ul></details>` : ''}
    ${ts && ts.r != null ? `<p class="note">Résultat simulé sur le plan : ${ts.r >= 0 ? '+' : ''}${(+ts.r).toFixed(2)} R</p>` : ''}
    <p class="note">Un contact avec la zone n'est pas un signal d'entrée. Aucune garantie de réussite.</p></div>`;
}
function assetHTML(a, plan, view) {
  if (!a.ok) return `<div class="pp-card"><div class="pp-h"><b>${esc(a.label)}</b></div><p class="pp-err">${esc(a.error || 'Analyse impossible')}</p><p class="note">Vérifie le symbole dans les réglages des actifs (bouton « Tester »).</p></div>`;
  const an = a.analysis, tr = a.tracking, v = { tracking: view.live ? tr : null }, di = a.dataInfo || {};
  const ztxt = an.zones.map(z => { const st = (v.tracking && v.tracking.zones && v.tracking.zones[z.id]) || 'attente';
    return `<div class="pp-zone"><b>${esc(z.id)}</b><span>${z.side === 'demande' ? 'Demande' : 'Offre'} ${fp(z.lo, an.price)} – ${fp(z.hi, an.price)}</span><small>${z.kinds.map(T.kindFr).map(esc).join(' + ')} · ${esc(z.tfs.join('/'))}${z.fresh ? ' · fraîche' : ''}</small>${statusPill(st)}</div>`; }).join('');
  const isCap = a.source === 'captures', avail = isCap ? TFS.filter(x => a.shots && a.shots[x]) : ['D1', 'H4', 'H1'];
  const tf = UI.st.tf[a.id] || (avail.includes('H4') ? 'H4' : avail[0]);
  const keyLv = Object.entries(an.levels).filter(([, x]) => x != null).map(([k, x]) => `${k} ${fp(x, an.price)}`).join(' · ');
  const stale = di.stale ? '<p class="pp-err">Données anciennes (marché fermé ou flux en retard) : vérifie la date de la dernière bougie.</p>' : '';
  const dataTxt = isCap ? `Source : captures ${avail.join(', ')} lues par Gemini le ${dfmt(di.fetchedAt)} · niveaux lus sur l'échelle de prix, non calculés : vérifie-les sur ton graphique` : di.D1 ? `Données : D1 ${di.D1.count}, H4 ${di.H4.count}, H1 ${di.H1.count} bougies · dernière bougie H1 : ${dfmt(di.H1.last)} · récupérées le ${dfmt(di.fetchedAt)}` : '';
  const flag = a.ai && a.ai.flagged && a.ai.flagged.length ? `<p class="pp-err">⚠ Texte IA : niveau(x) cité(s) non vérifié(s) par les calculs : ${esc(a.ai.flagged.join(', '))}. Ne t'y fie pas.</p>` : '';
  const warnHTML = a.warnings && a.warnings.length ? '<p class="pp-err">' + a.warnings.map(esc).join('<br>') + '</p>' : '';
  const updHTML = isCap && view.live ? `<label class="pp-upd"><span class="b">Mettre à jour avec une nouvelle capture</span><input type="file" accept="image/*" data-upd="${esc(a.id)}" hidden></label>` : '';
  return `<div class="pp-card" data-asset="${esc(a.id)}">
    <div class="pp-h"><b>${esc(a.label)}</b><span class="pp-bias ${biasCls(an.bias.label)}">Biais ${esc(an.bias.label)}</span><span class="note">prix ${fp(an.price, an.price)} · ${dfmt(an.priceT)}</span></div>
    <p class="note">${an.bias.args.map(esc).join(' · ')}</p>
    ${a.ai && a.ai.contexte ? `<p>${esc(a.ai.contexte)}</p>` : ''}
    <p class="note">Niveaux clés : ${esc(keyLv)}${an.eq.length ? ' · liquidité : ' + an.eq.slice(0, 4).map(e => esc(e.kind + ' ' + fp(e.level, an.price))).join(', ') : ''}</p>
    <h2 style="margin:12px 0 4px">Zones à surveiller</h2>${ztxt || '<p class="note">Aucune zone avec confluence à portée.</p>'}
    ${scenarioHTML(a, 'bull', v)}${scenarioHTML(a, 'bear', v)}
    <div class="pp-tf">${avail.map(x => `<button data-act="tf" data-a="${esc(a.id)}" data-v="${x}" class="${x === tf ? 'on' : ''}">${x}</button>`).join('')}<button data-act="img" data-a="${esc(a.id)}" style="margin-left:auto">Enregistrer l'image</button></div>
    <canvas class="pp-cv" data-cv="${esc(a.id)}"></canvas>
    ${a.ai && a.ai.calendrier ? `<p class="note">${esc(a.ai.calendrier)}</p>` : ''}${flag}${stale}${warnHTML}${updHTML}
    <p class="note">${esc(dataTxt)}</p></div>`;
}
function calendarHTML(plan) {
  const c = plan.calendar; if (!c) return '';
  const rows = c.ok ? (c.events.length ? c.events.map(e => `<div class="pp-ev"><span style="min-width:96px">${esc(dfmt(e.t))}</span><span class="imp ${esc(e.impact)}">${e.impact === 'High' ? 'Fort' : e.impact === 'Medium' ? 'Moyen' : 'Férié'}</span><span><b>${esc(e.cur)}</b> ${esc(e.title)}${e.forecast || e.previous ? `<br><small style="color:var(--mut)">prév. ${esc(e.forecast || '—')} · préc. ${esc(e.previous || '—')}</small>` : ''}</span></div>`).join('') : '<p class="note">Aucun événement important pour les devises suivies.</p>') : `<p class="pp-err">${esc(c.error)}</p>`;
  return `<div class="pan"><h2>Calendrier économique</h2>${rows}<p class="note">Source : ${esc(c.source)}. Heures affichées dans le fuseau de ton téléphone.</p></div>`;
}
function summary(plan) {
  let z = 0, zt = 0, conf = 0, inv = 0, miss = 0, obj = 0, R = 0, nR = 0, sc = 0;
  for (const a of plan.assets) { if (!a.ok || !a.tracking) continue; Object.values(a.tracking.zones).forEach(s => { z++; if (s !== 'attente' && s !== 'approchee') zt++; });
    for (const k of ['bull', 'bear']) { const s = a.tracking.scenarios[k]; if (!s) continue; sc++; if (s.status === 'confirme') conf++; if (s.status === 'invalide') inv++; if (s.status === 'manque') miss++; if (s.status === 'objectif') { obj++; } if (s.r != null && (s.status === 'objectif' || s.status === 'invalide')) { R += s.r; nR++; } } }
  return { z, zt, conf, inv, miss, obj, R, nR, sc };
}
function historyHTML() {
  const L = UI.st.plans; if (!L.length) return '';
  let tot = { nR: 0, R: 0, obj: 0 };
  const rows = L.map(p => { const s = summary(p), ev = p.assets.some(a => a.tracking); tot.nR += s.nR; tot.R += s.R; tot.obj += s.obj;
    return `<div class="pp-hist"><span class="t"><b>${esc(weekLabel(p.id))}</b><br><small style="color:var(--mut)">créé le ${esc(dfmt(p.createdAt))} · v${p.version || 1} · ${p.assets.filter(a => a.ok).length} actif(s)</small></span>
      <span style="flex:2;min-width:180px">${ev ? `Zones touchées ${s.zt}/${s.z} · scénarios : objectif ${s.obj}, invalidés ${s.inv}, manqués ${s.miss}, en cours ${s.conf}` : '<small style="color:var(--mut)">pas encore évalué</small>'}</span>
      <button class="sm" data-act="open" data-w="${esc(p.id)}">Ouvrir</button>${p.source === 'captures' ? '' : `<button class="sm" data-act="eval" data-w="${esc(p.id)}">Évaluer</button>`}</div>`; }).join('');
  const q = tot.nR ? `<p>Qualité cumulée : ${tot.nR} scénario(s) déclenché(s) et terminé(s), résultat simulé <b>${tot.R >= 0 ? '+' : ''}${tot.R.toFixed(2)} R</b>. <span class="note">Échantillon petit : n'en tire aucune conclusion avant plusieurs semaines.</span></p>` : '<p class="note">Évalue les semaines passées pour mesurer la qualité des plans.</p>';
  return `<div class="pan"><h2>Historique des plans</h2>${q}${rows}</div>`;
}
function settingsHTML() {
  const S = UI.st.settings;
  const rows = S.assets.map((a, i) => `<div class="pp-as"><input type="checkbox" data-a="on" data-i="${i}" ${a.on ? 'checked' : ''} aria-label="Activer"><input type="text" data-a="label" data-i="${i}" value="${esc(a.label)}" placeholder="Nom"><input type="text" data-a="symbol" data-i="${i}" value="${esc(a.symbol)}" placeholder="Symbole Twelve Data"><button class="sm" data-act="rm" data-i="${i}" style="background:transparent;color:var(--sell);border:1px solid var(--line)">✕</button></div>${UI.st.tests[a.id] ? `<p class="note" style="margin:0 0 4px 28px">${esc(UI.st.tests[a.id])}</p>` : ''}`).join('');
  return `<details class="pan"><summary style="cursor:pointer;color:var(--brass);font-weight:700">Actifs à analyser (${S.assets.filter(a => a.on).length} activé${S.assets.filter(a => a.on).length > 1 ? 's' : ''})</summary>${rows}
    <div class="row2" style="margin-top:8px"><button class="sm" data-act="add">+ Ajouter un actif</button><button class="sm" data-act="test">Tester les symboles</button></div>
    <label style="margin-top:10px">Source du plan</label><select id="ppSource"><option value="captures" ${S.source === 'captures' ? 'selected' : ''}>Captures d'écran (Gemini lit tes graphiques)</option><option value="data" ${S.source === 'data' ? 'selected' : ''}>Données de marché Twelve Data (clé requise)</option></select>
    <label style="display:flex;gap:8px;align-items:center;margin-top:10px"><input type="checkbox" id="ppAuto" style="width:22px;height:22px" ${S.auto ? 'checked' : ''}> Créer le plan automatiquement quand j'ouvre l'onglet le dimanche (source « données » seulement)</label>
    <div class="row2" style="margin-top:10px"><button class="sm" data-act="export">Exporter les plans (JSON)</button><button class="sm" data-act="import">Importer</button></div>
    <p class="note">Stockage : ${esc(Store.backend ? Store.backend.name : '…')} sur ce téléphone. Le symbole de l'indice Dow Jones chez Twelve Data peut varier selon ton plan : utilise « Tester ».</p></details>`;
}
function bannerHTML() {
  const wid = weekIdFor(Date.now()), cur = UI.st.cur, have = UI.st.plans.find(p => p.id === wid), out = [];
  if (!have) out.push(`<div class="pp-ban"><b>Aucun plan pour la ${esc(weekLabel(wid).toLowerCase())}.</b><br>${UI.st.settings.source === 'captures' ? 'Ajoute tes captures D1, H4 et H1 ci-dessous (axe des prix visible, sans indicateur), puis crée le plan.' : 'Il faut ta clé Twelve Data (onglet Analyse › Réglages).'} <button class="sm" data-act="gen" style="margin-top:8px">Créer le plan maintenant</button></div>`);
  if (cur) { const need = cur.assets.filter(a => a.ok && a.tracking && a.tracking.needsRefresh);
    if (need.length) out.push(`<div class="pp-ban"><b>Le plan nécessite une actualisation.</b><br>${need.map(a => esc(a.label) + ' : ' + esc(a.tracking.reasons.join(' '))).join('<br>')}</div>`); }
  return out.join('');
}
function render() {
  const R = UI.root; if (!R) return; const st = UI.st, cur = st.cur, wid = weekIdFor(Date.now());
  const opts = [...new Set([wid, ...st.plans.map(p => p.id)])].sort().reverse().map(id => `<option value="${esc(id)}" ${cur && cur.id === id ? 'selected' : ''}>${esc(weekLabel(id))}${st.plans.some(p => p.id === id) ? '' : ' (non créé)'}</option>`).join('');
  const view = { live: !st.showInitial };
  let body = '';
  if (cur) {
    const src = st.showInitial && cur.initial ? { assets: cur.initial.assets, calendar: cur.initial.calendar, ai: cur.initial.ai, createdAt: cur.initial.createdAt } : cur;
    body = (st.showInitial ? `<div class="pp-ban">Plan <b>initial</b> du ${esc(dfmt(src.createdAt))} (référence, jamais modifié).</div>` : '') +
      (src.ai && src.ai.resume ? `<div class="pan"><h2>Résumé de la semaine</h2><p>${esc(src.ai.resume)}</p>${src.ai.limites ? `<p class="note">${esc(src.ai.limites)}</p>` : ''}</div>` : '') +
      (st.aiNote ? `<p class="note">${esc(st.aiNote)}</p>` : '') + calendarHTML(src) + src.assets.map(a => assetHTML(a, cur, view)).join('');
  }
  R.innerHTML = `<div class="pan"><h2>Plan de trading hebdomadaire</h2>
      <div class="row2"><select id="ppWeek" aria-label="Semaine">${opts}</select></div>
      <div class="row2" style="margin-top:8px"><button data-act="gen" ${st.busy ? 'disabled' : ''}>${cur && cur.id === wid ? 'Actualiser le plan' : 'Créer le plan'}</button>${st.settings.source === 'captures' ? '' : `<button data-act="track" class="sec" ${st.busy || !cur ? 'disabled' : ''}>Mettre à jour le suivi</button>`}</div>
      <div class="pp-log" id="ppLog">${esc(st.log)}</div><div id="ppErr" class="pp-err">${esc(st.err)}</div>
      ${cur ? `<p class="note">Version ${cur.version || 1} · créé le ${esc(dfmt(cur.createdAt))} · dernière mise à jour ${esc(dfmt(cur.updatedAt || cur.createdAt))}${cur.initial ? ` · <a href="#" data-act="initial" style="color:var(--brass)">${st.showInitial ? 'Revenir au plan actuel' : 'Voir le plan initial'}</a>` : ''}</p>` : ''}
    </div>${bannerHTML()}${shotsHTML()}${settingsHTML()}${body}${historyHTML()}
    <p class="note" style="margin-top:16px">Aide à la lecture du marché : aucun scénario n'est garanti et le score n'est pas une probabilité de gain.</p>`;
  paintCharts();
}
function paintCharts() {
  const cur = UI.st.cur; if (!cur) return; const src = UI.st.showInitial && cur.initial ? cur.initial : cur;
  UI.root.querySelectorAll('canvas[data-cv]').forEach(cv => { const a = src.assets.find(x => x.id === cv.dataset.cv); if (!a || !a.ok) return;
    if (a.source === 'captures') {
      const tfx = UI.st.tf[a.id] || (a.shots.H4 ? 'H4' : Object.keys(a.shots)[0]), m = shotModel(Object.assign({}, a, { created: src.createdAt }), tfx, UI.st.showInitial ? null : a.tracking);
      if (!m) { const d = document.createElement('div'); d.innerHTML = `<img class="pp-cv" src="${a.shots[tfx]}" alt="Capture ${esc(tfx)}"><p class="pp-err">Échelle de prix non lue de façon fiable sur la capture ${esc(tfx)} : image non annotée (aucun niveau n'est dessiné sans échelle).</p>`; cv.replaceWith(d); return; }
      withImage(a.shots[tfx], im => { try { drawShot(cv, im, m); } catch (e) {} }); return;
    }
    try { const m = chartModel(Object.assign({}, a, { created: src.createdAt }), UI.st.tf[a.id] || 'H4', UI.st.showInitial ? null : a.tracking); if (m) drawChart(cv, m); } catch (e) { cv.replaceWith(Object.assign(document.createElement('p'), { className: 'pp-err', textContent: 'Graphique indisponible : ' + e.message })); } });
}

/* ---- 5c. MODE CAPTURES : Gemini lit tes graphiques ; l'app valide les prix, calcule le score et dessine ---- */
const TFS = ['D1', 'H4', 'H1'];
const TYPE_OK = ['OB', 'FVG', 'SR', 'EQL', 'EQH', 'PWH', 'PWL', 'PDH', 'PDL'];
const num = (x, d) => { const v = Number(x); return isFinite(v) ? v : d; };
// droite prix -> position verticale, ajustée sur les repères lus sur l'axe (3 minimum pour pouvoir la contrôler)
function fitShot(pts) {
  const Pt = (Array.isArray(pts) ? pts : []).map(p => p ? { prix: Number(p.prix), y: Number(p.y) } : null).filter(p => p && isFinite(p.prix) && isFinite(p.y) && p.prix > 0 && p.y >= -20 && p.y <= 1020);
  if (Pt.length < 3) return null;
  const n = Pt.length, mx = Pt.reduce((s, p) => s + p.prix, 0) / n, my = Pt.reduce((s, p) => s + p.y, 0) / n;
  let sxx = 0, sxy = 0; Pt.forEach(p => { sxx += (p.prix - mx) ** 2; sxy += (p.prix - mx) * (p.y - my); });
  if (!sxx) return null;
  const b = sxy / sxx, a = my - b * mx; if (!(b < 0)) return null;
  let mr = 0; Pt.forEach(p => { mr = Math.max(mr, Math.abs(a + b * p.prix - p.y)); });
  return { a, b, maxres: mr, ok: mr <= 10, n, pmin: (1000 - a) / b, pmax: (0 - a) / b };
}
function shotScenario(dir, s, ctx) {
  const bull = dir === 'bull', base = { id: dir, dir, label: bull ? 'Scénario haussier' : 'Scénario baissier' };
  if (!s || s.aucun || !ctx.idMap[s.zone]) return { ...base, ok: false, reason: (s && s.raison_aucun) || `Aucune zone ${bull ? 'd\'achat' : 'de vente'} suffisamment nette n'a été retenue.` };
  const z = ctx.byId[ctx.idMap[s.zone]], price = ctx.price;
  let entry = num(s.entree, NaN); if (!(entry >= z.lo && entry <= z.hi)) entry = z.mid;
  const inv = num(s.invalidation, NaN), probs = [];
  if (!(inv > 0)) probs.push('invalidation illisible'); else if (bull ? !(inv < z.lo) : !(inv > z.hi)) probs.push('invalidation pas au-delà de la zone');
  const tg = (Array.isArray(s.objectifs) ? s.objectifs : []).map(t => ({ price: num(t && t.prix, NaN), kind: TYPE_OK.includes(String(t && t.type).toUpperCase()) ? String(t.type).toUpperCase() : 'SR' }))
    .filter(t => t.price > 0 && (bull ? t.price > z.hi : t.price < z.lo) && Math.abs(t.price - price) / price < 0.15 && t.price >= ctx.range.pmin && t.price <= ctx.range.pmax)
    .sort((a, b) => bull ? a.price - b.price : b.price - a.price).slice(0, 2);
  const risk = Math.abs(entry - inv), rr = (tg[0] && risk > 0) ? Math.abs(tg[0].price - entry) / risk : null;
  const Wt = { biais: 25, confluences: 25, fraicheur: 15, liquidite: 15, position: 10 }, LB = { biais: 'Biais D1/H4', confluences: 'Confluences dans la zone', fraicheur: 'Zone fraîche', liquidite: 'Liquidité', position: 'Position dans la fourchette' };
  const cr = (s.criteres && typeof s.criteres === 'object') ? s.criteres : {}, arg = []; let sc = 0;
  for (const k of Object.keys(Wt)) {
    const x = cr[k]; let v = x && typeof x === 'object' ? x.v : x; v = (v === 'oui' || v === 'partiel') ? v : 'non';
    let f = v === 'oui' ? 1 : v === 'partiel' ? .5 : 0; if (k === 'confluences' && probs.length) f = 0;
    const pts = Math.round(Wt[k] * f); sc += pts; arg.push({ ok: f, pts, max: Wt[k], txt: LB[k] + (x && x.c ? ' : ' + String(x.c).slice(0, 90) : '') });
  }
  const pr = rr == null ? 0 : rr >= 2 ? 10 : rr >= 1.5 ? 6 : 0; sc += pr;
  arg.push({ ok: rr == null ? 0 : rr >= 2 ? 1 : rr >= 1.5 ? .5 : 0, pts: pr, max: 10, txt: rr == null ? 'Aucun objectif lu sur le graphique : objectif non déterminable' : `Objectif T1 à ${rr.toFixed(2)} R` });
  probs.forEach(p => arg.push({ ok: 0, pts: 0, max: 0, txt: 'Incohérence : ' + p }));
  const score = Math.round(sc), ok = score >= 35 && !probs.length && risk > 0 && isFinite(risk);
  const dflt = [`Contact de la zone ${z.lo} – ${z.hi}`, bull ? `Bougie M5 qui clôture au-dessus de ${z.mid.toFixed(2)} après le contact` : `Bougie M5 qui clôture sous ${z.mid.toFixed(2)} après le contact`, `Scénario annulé si une bougie M5 clôture ${bull ? 'sous' : 'au-dessus de'} ${inv > 0 ? inv : 'l\'invalidation'}`];
  const conf = (Array.isArray(s.confirmation_m5) ? s.confirmation_m5 : []).map(x => String(x).slice(0, 200)).filter(Boolean);
  return { ...base, ok, weak: !ok, zoneId: z.id, zone: { lo: z.lo, hi: z.hi, mid: z.mid, kinds: z.kinds }, entry, inv: inv > 0 ? inv : null, risk: isFinite(risk) ? risk : null, targets: tg, rr, score,
           niveau: score >= 70 ? 'Solide' : score >= 50 ? 'Correct' : 'Faible', arguments: arg, confirmation: conf.length ? conf : dflt,
           reason: ok ? null : (probs.length ? 'Niveaux incohérents : ' + probs.join(', ') + '.' : 'Confluences insuffisantes : scénario trop faible pour être proposé.') };
}
// réponse de Gemini -> analyse validée (même format que le mode données de marché)
function analysisFromShots(a, resp) {
  const warn = [], scales = {}, trace = {};
  (Array.isArray(resp.images) ? resp.images : []).forEach(im => {
    const tf = String(im && im.tf || '').toUpperCase(); if (!TFS.includes(tf) || !a.shots[tf]) return;
    const f = fitShot(im.echelle);
    if (f && f.ok && im.lisible !== false) { scales[tf] = im.echelle.map(p => ({ prix: +p.prix, y: +p.y })); trace[tf] = { x0: num(im.trace && im.trace.x_min, 0), x1: num(im.trace && im.trace.x_max, 880) }; }
    else warn.push(`Échelle de prix non lue de façon fiable sur la capture ${tf} : elle ne sera pas annotée.`);
  });
  const fits = {}; Object.keys(scales).forEach(t => { fits[t] = fitShot(scales[t]); });
  const main = fits.H4 || fits.D1 || fits.H1;
  if (!main) throw new Error('Échelle de prix illisible sur toutes les captures : refais-les avec l\'axe des prix entièrement visible (sans vidéo flottante ni fenêtre qui le cache).');
  const price = num(resp.prix_lu, NaN);
  if (!(price > 0) || price < main.pmin * 0.97 || price > main.pmax * 1.03) throw new Error('Prix actuel non lu, ou hors de l\'échelle des captures : refais la capture avec le prix actuel visible.');
  const inRange = (lo, hi, tf) => { const f = fits[tf] || main; return lo >= f.pmin && hi <= f.pmax; };
  const zones = [], byId = {}, idMap = {};
  (Array.isArray(resp.zones) ? resp.zones : []).slice(0, 10).forEach((z, i) => {
    const oid = String(z && z.id || 'Z' + (i + 1)), lo = num(z && z.bas, NaN), hi = num(z && z.haut, NaN), tf = String(z && z.tf || 'H4').toUpperCase();
    if (!(lo > 0 && hi >= lo)) { warn.push(`Zone ${oid} ignorée : prix illisibles.`); return; }
    if (hi - lo > 0.06 * price) { warn.push(`Zone ${oid} ignorée : trop large pour être une zone exploitable.`); return; }
    if (!inRange(lo, hi, TFS.includes(tf) ? tf : 'H4')) { warn.push(`Zone ${oid} (${lo} – ${hi}) ignorée : hors de l'échelle de prix visible.`); return; }
    if (Math.abs((lo + hi) / 2 - price) / price > 0.15) { warn.push(`Zone ${oid} ignorée : trop éloignée du prix actuel.`); return; }
    const id = 'Z' + (zones.length + 1); idMap[oid] = id;
    const side = hi <= price ? 'demande' : lo >= price ? 'offre' : (String(z.cote).toLowerCase() === 'offre' ? 'offre' : 'demande');
    let kinds = [].concat(z.type || []).map(x => String(x).toUpperCase()).filter(x => TYPE_OK.includes(x)); if (!kinds.length) kinds = ['SR'];
    const zo = { id, side, lo, hi, mid: (lo + hi) / 2, kinds, tfs: [TFS.includes(tf) ? tf : 'H4'], rank: kinds.length * 2, fresh: !!z.fraiche, status: 'attente', t0: null, x0: num(z.x_debut, null), reason: String(z.raison || '').slice(0, 160) };
    zones.push(zo); byId[id] = zo;
  });
  const range = { pmin: main.pmin, pmax: main.pmax };
  const ctx = { price, byId, idMap, range };
  const bull = shotScenario('bull', resp.scenarios && resp.scenarios.bull, ctx), bear = shotScenario('bear', resp.scenarios && resp.scenarios.bear, ctx);
  const lv = resp.niveaux || {}, L = k => { const v = num(lv[k], NaN); return v >= main.pmin && v <= main.pmax ? v : null; };
  const eq = (Array.isArray(resp.liquidite) ? resp.liquidite : []).map(e => ({ kind: String(e && e.type).toUpperCase(), tf: String(e && e.tf || 'H4').toUpperCase(), level: num(e && e.prix, NaN), count: 2 }))
    .filter(e => (e.kind === 'EQH' || e.kind === 'EQL') && e.level >= main.pmin && e.level <= main.pmax).slice(0, 6);
  const lab = ['haussier', 'baissier'].includes(String(resp.biais && resp.biais.label).toLowerCase()) ? String(resp.biais.label).toLowerCase() : 'neutre';
  const h4 = num(resp.amplitude_bougie_h4, 0) > 0 && num(resp.amplitude_bougie_h4, 0) < 0.05 * price ? num(resp.amplitude_bougie_h4, 0) : 0.0035 * price;
  const an = { price, priceT: Date.now(), atr: { D: h4 * 2.4, H4: h4, H1: h4 * 0.5 }, bias: { label: lab, score: lab === 'haussier' ? 3 : lab === 'baissier' ? -3 : 0, args: [].concat((resp.biais && resp.biais.arguments) || []).map(x => String(x).slice(0, 160)).slice(0, 4) },
    pos: 0.5, range30: { hi: null, lo: null }, structure: { D1: { trend: 0, events: [] }, H4: { trend: 0, events: [] } },
    levels: { PWH: L('pwh'), PWL: L('pwl'), PDH: L('pdh'), PDL: L('pdl') }, eq, zones, scenarios: { bull, bear }, source: 'captures' };
  const allowed = AI.allowedPrices(an), flagged = [], clean = s => { const t = String(s || '').slice(0, 700); AI.unverified(t, price, allowed).forEach(x => flagged.push(x)); return t; };
  const sc = (resp.scenarios || {}), mk = k => { const s = sc[k] || {}; return { explication: clean(s.explication), confirmation: (Array.isArray(s.confirmation_m5) ? s.confirmation_m5 : []).slice(0, 4).map(clean), incertitudes: (Array.isArray(s.incertitudes) ? s.incertitudes : []).slice(0, 4).map(clean) }; };
  const ai = { contexte: clean(resp.contexte), calendrier: '', scenarios: { bull: mk('bull'), bear: mk('bear') } }; ai.flagged = [...new Set(flagged)];
  if (!zones.length) warn.push('Aucune zone valide n\'a pu être retenue sur ces captures.');
  return { an, scales, trace, warn, ai, resume: String(resp.resume || ''), limites: String(resp.limites || '') };
}
// modèle d'annotation sur une capture : tout est calculé à partir des prix et de l'échelle lue
function shotModel(a, tf, tracking) {
  const f = fitShot(a.scales && a.scales[tf]); if (!f || !f.ok) return null;
  const an = a.analysis, tr = (a.trace && a.trace[tf]) || { x0: 0, x1: 880 }, items = [], vis = (lo, hi) => hi >= f.pmin && lo <= f.pmax, ts = (tracking && tracking.zones) || {};
  const scn = new Set(); ['bull', 'bear'].forEach(k => { const s = an.scenarios[k]; if (s && s.zone) scn.add(s.zoneId); });
  an.zones.forEach(z => { if (!vis(z.lo, z.hi)) return; items.push({ k: scn.has(z.id) ? 'scn' : 'zone', lo: z.lo, hi: z.hi, side: z.side, x0: z.x0, label: z.id + ' ' + z.kinds.map(x => ABBR[x] || x).join('+') + (ts[z.id] && ts[z.id] !== 'attente' ? ' · ' + ST_FR[ts[z.id]] : ''), bull: z.side === 'demande' }); });
  [['PWH', an.levels.PWH], ['PWL', an.levels.PWL], ['PDH', an.levels.PDH], ['PDL', an.levels.PDL]].forEach(([n, p]) => { if (p != null && p >= f.pmin && p <= f.pmax) items.push({ k: 'line', p, label: n, c: '#7f93ab' }); });
  an.eq.forEach(e => { if (e.level >= f.pmin && e.level <= f.pmax) items.push({ k: 'line', p: e.level, label: e.kind + ' ' + e.tf, c: '#ffa62b', dot: true }); });
  ['bull', 'bear'].forEach(k => { const s = an.scenarios[k]; if (!s || !s.zone) return; const bull = k === 'bull';
    if (s.inv != null && s.inv >= f.pmin && s.inv <= f.pmax) items.push({ k: 'line', p: s.inv, label: 'Inval. ' + (bull ? 'haussier' : 'baissier'), c: '#e5534b', dash: true });
    s.targets.forEach((t, i) => { if (t.price >= f.pmin && t.price <= f.pmax) items.push({ k: 'line', p: t.price, label: 'T' + (i + 1) + (bull ? ' ↑ ' : ' ↓ ') + (ABBR[t.kind] || t.kind), c: '#2fbf71', dash: true }); }); });
  const px = (tracking && tracking.lastPrice) || an.price; if (px >= f.pmin && px <= f.pmax) items.push({ k: 'line', p: px, label: 'Prix', c: '#e9edf2', dot: true });
  return { f, tr, items, title: `${a.label} · ${tf} · plan du ${dday(a.created || Date.now())}` };
}
function drawShot(cv, img, m) {
  const w = img.width, h = img.height, g = cv.getContext('2d'); cv.width = w; cv.height = h; g.drawImage(img, 0, 0, w, h);
  const fs = Math.max(14, Math.round(w / 40)), Y = p => Math.max(0, Math.min(h, (m.f.a + m.f.b * p) / 1000 * h)), X = n => n / 1000 * w, x0 = X(m.tr.x0), x1 = X(m.tr.x1);
  g.font = `bold ${fs}px system-ui,sans-serif`; g.textBaseline = 'middle'; const chips = [];
  m.items.filter(i => i.k === 'zone' || i.k === 'scn').forEach(i => { const xs = Math.max(x0, Math.min(i.x0 != null ? X(i.x0) : x0, x1 - 20)), y1 = Y(i.hi), y2 = Y(i.lo);
    const col = i.bull ? '47,191,113' : '229,83,75'; g.fillStyle = `rgba(${col},${i.k === 'scn' ? .3 : .2})`; g.fillRect(xs, y1, x1 - xs, Math.max(3, y2 - y1));
    g.strokeStyle = i.k === 'scn' ? '#c9a24b' : `rgba(${col},.9)`; g.lineWidth = i.k === 'scn' ? 3 : 2; g.strokeRect(xs, y1, x1 - xs, Math.max(3, y2 - y1)); chips.push({ y: (y1 + y2) / 2, t: i.label, c: i.k === 'scn' ? '#c9a24b' : `rgb(${col})` }); });
  m.items.filter(i => i.k === 'line').forEach(i => { const y = Y(i.p); g.strokeStyle = i.c; g.lineWidth = 2.5; g.setLineDash(i.dot ? [3, 6] : i.dash ? [14, 8] : []); g.beginPath(); g.moveTo(x0, y); g.lineTo(x1, y); g.stroke(); g.setLineDash([]); chips.push({ y, t: i.label + ' ' + fp(i.p, m.f.pmax), c: i.c }); });
  chips.sort((p, q) => p.y - q.y); let last = -99; chips.forEach(c => { c.y = Math.max(c.y, last + fs * 1.35); last = c.y; });
  g.font = `bold ${Math.round(fs * .85)}px system-ui,sans-serif`;
  chips.forEach(c => { const tw = g.measureText(c.t).width + 12; g.fillStyle = 'rgba(16,21,28,.88)'; g.fillRect(x0 + 4, c.y - fs * .6, tw, fs * 1.2); g.fillStyle = c.c; g.fillText(c.t, x0 + 10, c.y); });
  g.fillStyle = 'rgba(16,21,28,.85)'; g.fillRect(0, h - fs * 1.7, w, fs * 1.7); g.fillStyle = '#c9a24b'; g.font = `${Math.round(fs * .8)}px system-ui,sans-serif`; g.fillText('Niveaux lus sur la capture par Gemini et placés d\'après l\'échelle de prix · aucune garantie', 10, h - fs * .85);
}
const imgCache = new Map();
function withImage(url, cb) { if (imgCache.has(url)) return cb(imgCache.get(url)); const im = new Image(); im.onload = () => { imgCache.set(url, im); cb(im); }; im.src = url; }
function loadShot(file) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onerror = () => rej(new Error('Lecture impossible')); r.onload = () => { const im = new Image(); im.onerror = () => rej(new Error('Image illisible')); im.onload = () => {
    const s = Math.min(1, 1600 / Math.max(im.width, im.height)), c = document.createElement('canvas'); c.width = Math.round(im.width * s); c.height = Math.round(im.height * s); c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
    res({ url: c.toDataURL('image/jpeg', .85), w: c.width, h: c.height }); }; im.src = r.result; }; r.readAsDataURL(file); });
}
P.loadShot = loadShot;
P._shot = { fitShot, analysisFromShots, shotModel, drawShot, shotScenario };

function shotsHTML() {
  if (UI.st.settings.source !== 'captures') return '';
  const on = UI.st.settings.assets.filter(a => a.on);
  const rows = on.map(a => { const sh = UI.st.shots[a.id] || {};
    return `<div class="pp-sh"><b>${esc(a.label)}</b><div class="pp-slots">${TFS.map(tf => `<label class="pp-slot"><span class="tg">${tf}</span>${sh[tf] ? `<img src="${sh[tf].url}" alt="${tf}">` : '<span>+ Ajouter</span>'}<input type="file" accept="image/*" data-shot="${esc(a.id)}|${tf}"></label>`).join('')}</div></div>`; }).join('');
  return `<div class="pan"><h2>Captures de la semaine</h2><p class="note">Pour chaque actif : un graphique NU (sans indicateur) en D1, H4 et H1, avec l'axe des prix entièrement visible et le prix actuel. H4 obligatoire, D1 et H1 recommandés. Ferme les vidéos flottantes avant de capturer.</p>${rows || '<p class="note">Active au moins un actif dans « Actifs à analyser ».</p>'}<p class="note">Les captures ne sont gardées que si le plan est créé ; ferme l'onglet avant de les envoyer et il faudra les rajouter.</p></div>`;
}
async function generateShots() {
  const st = UI.st; if (st.busy) return; st.err = '';
  if (!gv('key')) { st.err = 'Clé Gemini requise (onglet Analyse › Réglages) : c\'est elle qui lit tes captures.'; return render(); }
  const list = st.settings.assets.filter(a => a.on), ready = list.filter(a => st.shots[a.id] && st.shots[a.id].H4);
  if (!ready.length) { st.err = 'Ajoute au moins la capture H4 d\'un actif activé (D1 et H1 améliorent l\'analyse).'; return render(); }
  st.busy = true; st.aiNote = ''; render();
  try {
    const wid = weekIdFor(Date.now()), old = await Store.getPlan(wid), now = Date.now();
    const plan = old || { id: wid, week: weekRange(wid), createdAt: now, version: 0, revisions: [] };
    const out = [], resumes = [], limites = [];
    for (const a of list) {
      if (!ready.includes(a)) { out.push({ id: a.id, label: a.label, symbol: a.symbol, ok: false, error: 'Aucune capture H4 fournie pour cet actif.' }); continue; }
      try {
        say(`${a.label} : lecture des captures par Gemini…`);
        const sh = st.shots[a.id], tfs = TFS.filter(t => sh[t]), parts = [{ text: AI.shotPrompt(a, tfs) }];
        tfs.forEach(t => parts.push({ text: 'Capture ' + t + ' :' }, { inline_data: { mime_type: 'image/jpeg', data: sh[t].url.split(',')[1] } }));
        const resp = await AI.call('', say, { parts, thinking: 'medium' });
        const shots = {}; tfs.forEach(t => { shots[t] = sh[t].url; });
        const r = analysisFromShots({ shots }, resp);
        out.push({ id: a.id, label: a.label, symbol: a.symbol, ok: true, source: 'captures', created: now, shots, scales: r.scales, trace: r.trace, analysis: r.an, ai: r.ai, warnings: r.warn, dataInfo: { source: 'captures', tfs, fetchedAt: now } });
        if (r.resume) resumes.push(`${a.label} : ${r.resume}`); if (r.limites) limites.push(r.limites);
      } catch (e) { out.push({ id: a.id, label: a.label, symbol: a.symbol, ok: false, error: e.message || String(e) }); }
    }
    if (!out.some(a => a.ok)) throw new Error(out.map(a => a.label + ' : ' + a.error).join(' | '));
    plan.assets = out; plan.version++; plan.updatedAt = now; plan.source = 'captures';
    say('Calendrier économique…');
    const cur = [...new Set(out.filter(a => a.ok).flatMap(a => MD.currencies(a.symbol)))], wr = weekRange(wid);
    plan.calendar = await MD.calendar(wr.monday - 12 * 3600e3, wr.monday + 4.6 * DAY, cur);
    plan.ai = { resume: resumes.join(' '), limites: limites[0] || 'Niveaux lus sur des captures : précision limitée, à vérifier sur ton graphique.', at: now };
    if (!plan.initial) plan.initial = clone({ createdAt: now, assets: plan.assets, calendar: plan.calendar, ai: plan.ai }); else plan.revisions.push({ at: now, reason: 'Actualisation avec de nouvelles captures' });
    await Store.savePlan(plan); await refreshPlans(wid); say('Plan enregistré sur ce téléphone.');
  } catch (e) { st.err = 'Échec : ' + (e.message || e); say(''); }
  st.busy = false; render();
}
// suivi en mode captures : une nouvelle capture, comparée au plan par Gemini ; l'app valide les statuts et le prix
async function updateFromShot(id, file) {
  const st = UI.st, plan = st.cur; if (!plan || !file || st.busy) return;
  const a = plan.assets.find(x => x.id === id && x.ok && x.source === 'captures'); if (!a) return;
  st.busy = true; st.err = ''; render();
  try {
    say(`${a.label} : lecture de la nouvelle capture…`);
    const sh = await P.loadShot(file);
    const resp = await AI.call('', say, { parts: [{ text: AI.updatePrompt(a) }, { text: 'Nouvelle capture :' }, { inline_data: { mime_type: 'image/jpeg', data: sh.url.split(',')[1] } }], thinking: 'low' });
    const f = fitShot(resp.echelle); if (!f || !f.ok) throw new Error('Échelle de prix non lue de façon fiable sur la nouvelle capture : refais-la avec l\'axe des prix visible.');
    const price = num(resp.prix_lu, NaN); if (!(price >= f.pmin && price <= f.pmax)) throw new Error('Prix actuel non lu ou hors de l\'échelle : refais la capture.');
    const ZS = ['attente', 'approchee', 'touchee', 'depassee'], SS = ['attente', 'approchee', 'touchee', 'confirme', 'invalide', 'objectif', 'manque'], an = a.analysis, zones = {}, scn = {};
    an.zones.forEach(z => { const r = (Array.isArray(resp.zones) ? resp.zones : []).find(q => q && q.id === z.id); zones[z.id] = r && ZS.includes(r.statut) ? r.statut : 'attente'; });
    ['bull', 'bear'].forEach(k => { const s = an.scenarios[k]; if (!s || !s.ok) return; const r = resp.scenarios && resp.scenarios[k]; scn[k] = { status: r && SS.includes(r.statut) ? r.statut : 'attente', confirmedAt: null, entry: null, r: null, note: r && r.note ? String(r.note).slice(0, 200) : '' };
      if (scn[k].status === 'confirme' || scn[k].status === 'objectif') zones[s.zoneId] = 'scenario_confirme'; if (scn[k].status === 'invalide') zones[s.zoneId] = 'scenario_invalide'; });
    const reasons = [].concat((resp.actualiser && resp.actualiser.raisons) || []).map(String).filter(Boolean);
    if (Math.abs(price - an.price) > 2 * an.atr.D) reasons.push('Le prix s\'est éloigné de plus de 2 ATR journaliers (estimés) du prix de création du plan.');
    const need = !!(resp.actualiser && resp.actualiser.besoin) || reasons.length > 0 && Math.abs(price - an.price) > 2 * an.atr.D;
    a.tracking = { zones, scenarios: scn, lastPrice: price, lastT: Date.now(), bars: 0, needsRefresh: need, reasons: need ? reasons : [], updatedAt: Date.now(), source: 'capture', note: String(resp.commentaire || '').slice(0, 300) };
    await Store.savePlan(plan); await refreshPlans(plan.id); say('Suivi mis à jour d\'après ta capture.');
  } catch (e) { st.err = 'Échec : ' + (e.message || e); say(''); }
  st.busy = false; render();
}

/* ---- actions ---- */
async function refreshPlans(selectId) {
  UI.st.plans = await Store.listPlans();
  const id = selectId || (UI.st.cur && UI.st.cur.id) || weekIdFor(Date.now());
  UI.st.cur = UI.st.plans.find(p => p.id === id) || UI.st.plans[0] || null;
}
async function generate() {
  if (UI.st.settings.source === 'captures') return generateShots();
  const st = UI.st; if (st.busy) return; st.err = ''; const key = gv('tdkey');
  const list = st.settings.assets.filter(a => a.on);
  if (!key) { st.err = 'Clé Twelve Data requise : renseigne-la dans l\'onglet Analyse › Réglages.'; return render(); }
  if (!list.length) { st.err = 'Active au moins un actif dans « Actifs à analyser ».'; return render(); }
  st.busy = true; st.aiNote = ''; render();
  try {
    const wid = weekIdFor(Date.now()), old = await Store.getPlan(wid), now = Date.now();
    const plan = old || { id: wid, week: weekRange(wid), createdAt: now, version: 0, revisions: [] };
    const out = [];
    for (const a of list) {
      try { const { S, info } = await MD.asset(a.symbol, key, say); const an = T.analyze({ D: S.D1, H4: S.H4, H1: S.H1 });
        out.push({ id: a.id, label: a.label, symbol: a.symbol, ok: true, dataInfo: info, analysis: an, bars: { D1: T.snap(S.D1, 90), H4: T.snap(S.H4, 140), H1: T.snap(S.H1, 160) } }); }
      catch (e) { out.push({ id: a.id, label: a.label, symbol: a.symbol, ok: false, error: e.message || String(e) }); }
    }
    if (!out.some(a => a.ok)) throw new Error(out.map(a => a.label + ' : ' + a.error).join(' | '));
    plan.assets = out; plan.version++; plan.updatedAt = now;
    say('Calendrier économique…');
    const cur = [...new Set(out.filter(a => a.ok).flatMap(a => MD.currencies(a.symbol)))], wr = weekRange(wid);
    plan.calendar = await MD.calendar(wr.monday - 12 * 3600e3, wr.monday + 4.6 * DAY, cur);
    plan.ai = null;
    if (gv('key')) { say('Rédaction du plan par Gemini…'); try { AI.merge(plan, await AI.call(AI.prompt(plan), say)); } catch (e) { st.aiNote = 'Commentaire IA indisponible (' + e.message + ') : le plan affiché repose uniquement sur les calculs.'; } }
    else st.aiNote = 'Clé Gemini absente : le plan repose uniquement sur les calculs.';
    if (!plan.initial) plan.initial = clone({ createdAt: now, assets: plan.assets, calendar: plan.calendar, ai: plan.ai }); else plan.revisions.push({ at: now, reason: 'Actualisation manuelle' });
    await Store.savePlan(plan); await refreshPlans(wid); say('Plan enregistré sur ce téléphone.');
  } catch (e) { st.err = 'Échec : ' + (e.message || e); say(''); }
  st.busy = false; render();
}
async function trackCur(plan, from, to) {
  const key = gv('tdkey'); if (!key) throw new Error('Clé Twelve Data requise.');
  for (const a of plan.assets.filter(x => x.ok)) {
    say(`${a.symbol} : bougies M5…`);
    const t0 = from != null ? from : a.analysis.priceT, extra = '&start_date=' + encodeURIComponent(utcStr(t0)) + (to ? '&end_date=' + encodeURIComponent(utcStr(to)) : '');
    const bars = MD.complete(await MD.series(a.symbol, '5min', key, 1500, extra, say), 300000);
    a.tracking = Object.assign(T.track(a, bars, t0), { updatedAt: Date.now() });
  }
}
async function track() {
  const st = UI.st, plan = st.cur; if (!plan || st.busy) return; st.busy = true; st.err = ''; render();
  try { await trackCur(plan); await Store.savePlan(plan); await refreshPlans(plan.id); say('Suivi mis à jour.'); } catch (e) { st.err = 'Échec : ' + (e.message || e); say(''); }
  st.busy = false; render();
}
async function evalWeek(id) {
  const st = UI.st, plan = st.plans.find(p => p.id === id); if (!plan || st.busy) return; st.busy = true; st.err = ''; render();
  try { const wr = weekRange(id); await trackCur(plan, wr.start, wr.end); plan.evaluatedAt = Date.now(); await Store.savePlan(plan); await refreshPlans(id); say('Semaine évaluée.'); } catch (e) { st.err = 'Échec : ' + (e.message || e); say(''); }
  st.busy = false; render();
}
async function testSymbols() {
  const key = gv('tdkey'), st = UI.st; if (!key) { st.err = 'Clé Twelve Data requise.'; return render(); }
  st.busy = true; st.tests = {}; render();
  for (const a of st.settings.assets.filter(x => x.on)) { try { const b = await MD.series(a.symbol, '1day', key, 5, '', say); st.tests[a.id] = `✓ ${a.symbol} : disponible (dernière bougie ${dday(b[b.length - 1].t)})`; } catch (e) { st.tests[a.id] = '✗ ' + (e.message || e); } render(); }
  say(''); st.busy = false; render();
}
function saveImage(id) {
  const cv = UI.root.querySelector(`canvas[data-cv="${id}"]`); if (!cv) return;
  cv.toBlob(b => { const u = URL.createObjectURL(b), a = document.createElement('a'); a.href = u; a.download = `plan-${UI.st.cur.id}-${id}-${UI.st.tf[id] || 'H4'}.png`; a.click(); setTimeout(() => URL.revokeObjectURL(u), 4000); }, 'image/png');
}
function download(name, text) { const u = URL.createObjectURL(new Blob([text], { type: 'application/json' })), a = document.createElement('a'); a.href = u; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(u), 4000); }
async function onClick(e) {
  const b = e.target.closest('[data-act]'); if (!b) return; const act = b.dataset.act, st = UI.st;
  if (act === 'initial') { e.preventDefault(); st.showInitial = !st.showInitial; return render(); }
  if (act === 'gen') return generate(); if (act === 'track') return track();
  if (act === 'eval') return evalWeek(b.dataset.w);
  if (act === 'open') { await refreshPlans(b.dataset.w); st.showInitial = false; render(); return window.scrollTo(0, 0); }
  if (act === 'tf') { st.tf[b.dataset.a] = b.dataset.v; return render(); }
  if (act === 'img') return saveImage(b.dataset.a);
  if (act === 'add') { st.settings.assets.push({ id: 'a' + Date.now().toString(36), label: 'Nouvel actif', symbol: '', on: false }); await saveSettings(); return render(); }
  if (act === 'rm') { st.settings.assets.splice(+b.dataset.i, 1); await saveSettings(); return render(); }
  if (act === 'test') return testSymbols();
  if (act === 'export') { try { download('scalp-plans-' + ymd(new Date()) + '.json', JSON.stringify(await Store.exportAll())); } catch (x) { st.err = x.message; render(); } return; }
  if (act === 'import') { const f = document.createElement('input'); f.type = 'file'; f.accept = '.json,application/json'; f.onchange = async () => { try { const n = await Store.importAll(JSON.parse(await f.files[0].text())); await refreshPlans(); say(n + ' plan(s) importé(s).'); } catch (x) { st.err = 'Import impossible : ' + x.message; } render(); }; f.click(); }
}
async function onChange(e) {
  const t = e.target, st = UI.st;
  if (t.id === 'ppSource') { st.settings.source = t.value; await saveSettings(); return render(); }
  if (t.dataset && t.dataset.shot) { const [id, tf] = t.dataset.shot.split('|'); if (!t.files[0]) return; try { const sh = await P.loadShot(t.files[0]); (st.shots[id] = st.shots[id] || {})[tf] = sh; st.err = ''; } catch (x) { st.err = 'Capture illisible : ' + x.message; } return render(); }
  if (t.dataset && t.dataset.upd) { return updateFromShot(t.dataset.upd, t.files[0]); }
  if (t.id === 'ppWeek') { await refreshPlans(t.value); st.showInitial = false; return render(); }
  if (t.id === 'ppAuto') { st.settings.auto = t.checked; return saveSettings(); }
  if (t.dataset.a && t.dataset.i != null) { const a = st.settings.assets[+t.dataset.i]; if (!a) return; if (t.dataset.a === 'on') a.on = t.checked; else a[t.dataset.a] = t.value.trim(); await saveSettings(); if (t.dataset.a === 'on') render(); }
}
async function maybeAuto() {
  const st = UI.st, d = new Date().getDay(), wid = weekIdFor(Date.now());
  if (st.settings.source === 'data' && st.settings.auto && (d === 0 || d === 1) && !st.plans.some(p => p.id === wid) && gv('tdkey') && !st.busy && !st.autoTried) { st.autoTried = true; await generate(); }
}
function showTab(which) {
  const A = g$('viewA'), Pn = g$('viewP'); if (!A || !Pn) return;
  A.classList.toggle('hide', which !== 'A'); Pn.classList.toggle('hide', which !== 'P');
  g$('tabA').classList.toggle('on', which === 'A'); g$('tabP').classList.toggle('on', which === 'P');
  if (which === 'P') { render(); maybeAuto(); }
}
P.init = async function () {
  UI.root = g$('viewP'); if (!UI.root) return;
  UI.root.classList.add('pp'); const css = document.createElement('style'); css.textContent = CSS; document.head.appendChild(css);
  try { await Store.init(); await loadSettings(); await refreshPlans(); } catch (e) { UI.st.err = 'Sauvegarde indisponible : ' + e.message; UI.st.settings = UI.st.settings || { assets: clone(DEFAULT_ASSETS), auto: true }; }
  UI.root.addEventListener('click', onClick); UI.root.addEventListener('change', onChange);
  g$('tabA').addEventListener('click', () => showTab('A')); g$('tabP').addEventListener('click', () => showTab('P'));
  render();
};

/* ---- liens avec l'onglet Analyse : contexte pour Gemini et note sous le résultat ---- */
async function planFor(sym, name) {
  await Store.init(); const p = await Store.getPlan(weekIdFor(Date.now())); if (!p) return null;
  const s = norm(sym), n = norm(name);
  const a = p.assets.find(x => x.ok && ((s && norm(x.symbol) === s) || (n && n.startsWith(norm(x.symbol)))));
  return a ? { p, a } : null;
}
P.contextText = async function (sym) {
  try { const r = await planFor(sym, ''); if (!r) return ''; const { p, a } = r, an = a.analysis, tr = a.tracking, z = an.zones;
    const zs = z.map(q => `${q.id} ${q.side} ${fp(q.lo, an.price)}-${fp(q.hi, an.price)} (${q.kinds.join('+')}${tr && tr.zones[q.id] ? ', statut ' + (ST_FR[tr.zones[q.id]] || tr.zones[q.id]) : ''})`).join(' ; ');
    const sc = ['bull', 'bear'].map(k => { const s = an.scenarios[k]; return s.zone ? `${k === 'bull' ? 'haussier' : 'baissier'} : zone ${s.zoneId}, invalidation ${fp(s.inv, an.price)}${tr && tr.scenarios[k] ? ', statut ' + tr.scenarios[k].status : ''}` : `${k === 'bull' ? 'haussier' : 'baissier'} : aucun`; }).join(' ; ');
    return `\n\nPLAN HEBDO (${weekLabel(p.id)}, calculé sur des données réelles) : biais ${an.bias.label}. Zones : ${zs}. Scénarios : ${sc}.\nUtilise ce plan comme CONTEXTE seulement : dis si le setup se trouve dans une zone du plan. Un contact avec une zone n'est pas un signal d'entrée et ne justifie jamais un trade à lui seul.`; } catch (e) { return ''; }
};
P.noteFor = async function (sym, name, price) {
  try { const r = await planFor(sym, name); if (!r || !(price > 0)) return ''; const an = r.a.analysis, tr = r.a.tracking;
    const inside = an.zones.find(z => price >= z.lo - 0.1 * an.atr.H4 && price <= z.hi + 0.1 * an.atr.H4);
    let t = inside ? `Plan hebdo : le prix est dans la zone ${inside.id} (${inside.side} ${fp(inside.lo, an.price)} – ${fp(inside.hi, an.price)})${tr && tr.zones[inside.id] ? ', statut ' + (ST_FR[tr.zones[inside.id]] || '') : ''}. Une zone touchée n'est pas un signal d'entrée.` : (() => { const n = [...an.zones].sort((a, b) => Math.min(Math.abs(price - a.lo), Math.abs(price - a.hi)) - Math.min(Math.abs(price - b.lo), Math.abs(price - b.hi)))[0]; return n ? `Plan hebdo : zone la plus proche ${n.id} (${n.side}) à ${fp(Math.min(Math.abs(price - n.lo), Math.abs(price - n.hi)), an.price)} points.` : ''; })();
    if (tr && tr.needsRefresh) t += ' Le plan nécessite une actualisation.'; return t; } catch (e) { return ''; }
};
P.T = T; P.chartModel = chartModel; P.weekIdFor = weekIdFor; P.weekRange = weekRange; P._UI = UI;
root.ScalpPlan = P;
if (typeof document !== 'undefined') { const go = () => { if (document.getElementById('viewP')) P.init(); }; if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go); else go(); }
})(typeof window !== 'undefined' ? window : globalThis);
