/* Scalp Analyzer — Communauté (version Nostr, sans compte ni serveur à créer)
   Ne modifie pas le moteur Gemini, le journal, le calculateur ni le plan hebdo.
   Les messages sont chiffrés avec le code de salon ; seuls ceux qui le connaissent les lisent. */
(() => {
  'use strict';
  if (window.__SCALP_COMMUNITY_LOADED__) return;
  window.__SCALP_COMMUNITY_LOADED__ = true;

  const CFG_KEY = 'scalp_community_nostr_v1';
  const RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net', 'wss://nostr.mom'];
  const KIND = 4242;
  const LIB = 'https://cdn.jsdelivr.net/npm/nostr-tools@2.7.2/lib/nostr.bundle.js';
  const $ = (s, r = document) => r.querySelector(s);
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = ts => { try { return new Date(ts * 1000).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); } catch (_) { return ''; } };
  const readCfg = () => { try { return JSON.parse(localStorage.getItem(CFG_KEY) || '{}'); } catch (_) { return {}; } };
  const saveCfg = c => localStorage.setItem(CFG_KEY, JSON.stringify(c));
  const toHex = u => [...u].map(b => b.toString(16).padStart(2, '0')).join('');
  const fromHex = h => Uint8Array.from(h.match(/../g).map(x => parseInt(x, 16)));
  const enc = new TextEncoder(), dec = new TextDecoder();
  const NICK_RE = /^[\p{L}\p{N}_ -]{3,24}$/u;

  let NT = null, aesKey = null, tag = '', sockets = [], items = new Map();
  let active = false, mode = 'chat', booted = false, retry = null;
  const KEEP_DAYS = 14, KEEP_MAX = 500;
  let cache = new Map(), saveTimer = null;
  const cacheKey = () => 'scalp_community_cache_v1_' + tag;
  function saveCacheNow() {
    try {
      const cutoff = Math.floor(Date.now() / 1000) - KEEP_DAYS * 86400;
      const arr = [...cache.values()].filter(e => e.created_at >= cutoff).sort((a, b) => a.created_at - b.created_at).slice(-KEEP_MAX);
      cache = new Map(arr.map(e => [e.id, e]));
      localStorage.setItem(cacheKey(), JSON.stringify(arr));
    } catch (_) {}
  }
  function scheduleSave() { clearTimeout(saveTimer); saveTimer = setTimeout(saveCacheNow, 800); }
  async function loadCache() {
    let arr = [];
    try { arr = JSON.parse(localStorage.getItem(cacheKey()) || '[]'); } catch (_) {}
    for (const ev of arr) await handleEvent(ev);
  }

  const css = `
  #tabCommunity{border:1px solid #36516a;background:#172635;color:#dce8f2;border-radius:10px;padding:9px 12px;font-weight:700}
  #tabCommunity.on{background:#25634f;border-color:#39866d;color:#fff}
  #viewCommunity{display:none;color:#e8eef5;background:#0e1721;border:1px solid #263747;border-radius:14px;padding:12px;margin-top:12px;min-height:55vh}
  #viewCommunity *{box-sizing:border-box}
  #viewCommunity .cm-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:12px}
  #viewCommunity .cm-title{font-size:20px;font-weight:800}
  #viewCommunity .cm-muted{color:#9fb0bf;font-size:12px}
  #viewCommunity .cm-tabs{display:flex;gap:8px;margin:10px 0}
  #viewCommunity button{cursor:pointer;border:0;border-radius:9px;padding:10px 12px;font-weight:700}
  #viewCommunity .cm-btn{background:#24445a;color:#fff}
  #viewCommunity .cm-btn.primary{background:#16815f}
  #viewCommunity .cm-input,#viewCommunity textarea,#viewCommunity select{width:100%;background:#172635;color:#fff;border:1px solid #354b5e;border-radius:9px;padding:11px;font:inherit;margin:5px 0}
  #viewCommunity textarea{min-height:76px;resize:vertical}
  #viewCommunity .cm-card{background:#172431;border:1px solid #2a3d4d;border-radius:12px;padding:12px;margin:9px 0}
  #viewCommunity .cm-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
  #viewCommunity .cm-row .spacer{flex:1}
  #viewCommunity .cm-msg{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.4;margin-top:7px}
  #viewCommunity .cm-feed{max-height:52vh;overflow:auto}
  #viewCommunity .cm-error{color:#ffb4b4;background:#492a30;padding:9px;border-radius:8px;margin:8px 0}
  #viewCommunity .cm-small{font-size:11px;color:#9fb0bf}
  #viewCommunity .cm-hidden{display:none!important}`;
  const style = document.createElement('style'); style.textContent = css; document.head.appendChild(style);

  function ensureUI() {
    const tabs = $('.pp-tabs');
    if (!tabs || !$('#viewA') || !$('#viewP')) return false;
    if (!$('#tabCommunity')) {
      const b = document.createElement('button');
      b.id = 'tabCommunity'; b.type = 'button'; b.textContent = 'Communauté';
      tabs.appendChild(b); b.addEventListener('click', openCommunity);
    }
    if (!$('#viewCommunity')) {
      const pane = document.createElement('section');
      pane.id = 'viewCommunity';
      pane.innerHTML = `
        <div class="cm-head"><div><div class="cm-title">Communauté</div><div class="cm-muted">Échanges entre traders · salon privé</div></div><button class="cm-btn" id="cmProfileBtn">Profil</button></div>
        <div id="cmSetup" class="cm-card cm-hidden">
          <b>Rejoindre le salon</b>
          <p class="cm-muted">À faire une seule fois. Tous les amis saisissent le même code de salon.</p>
          <label class="cm-muted">Code du salon (6 caractères min.)</label><input class="cm-input" id="cmRoom" placeholder="ex. scalp-team-2026" autocomplete="off" autocapitalize="off">
          <label class="cm-muted">Ton pseudonyme</label><input class="cm-input" id="cmNick" maxlength="24" placeholder="Ex. TraderMax">
          <button class="cm-btn primary" id="cmJoin">Entrer dans la communauté</button>
        </div>
        <div id="cmMain" class="cm-hidden">
          <div class="cm-row"><span class="cm-muted" id="cmWho"></span><span class="spacer"></span><button class="cm-btn" id="cmRefresh">Reconnecter</button></div>
          <div class="cm-tabs"><button class="cm-btn primary" id="cmChatTab">Tchat</button><button class="cm-btn" id="cmAnalysisTab">Analyses</button></div>
          <div id="cmChat">
            <div id="cmMessages" class="cm-feed" aria-live="polite"></div>
            <textarea id="cmMessage" maxlength="1000" placeholder="Écrire un message…"></textarea>
            <button class="cm-btn primary" id="cmSendMessage">Envoyer</button>
          </div>
          <div id="cmAnalyses" class="cm-hidden">
            <div class="cm-card">
              <b>Partager une analyse</b>
              <input class="cm-input" id="cmAsset" maxlength="30" placeholder="Actif (ex. XAUUSD)">
              <select class="cm-input" id="cmDirection"><option value="BUY">BUY</option><option value="SELL">SELL</option><option value="ATTENTE">ATTENTE</option></select>
              <input class="cm-input" id="cmTimeframe" maxlength="12" placeholder="Unité de temps (ex. M5)">
              <textarea id="cmAnalysisText" maxlength="2000" placeholder="Explique ton scénario, tes zones et tes confluences…"></textarea>
              <button class="cm-btn primary" id="cmPublish">Publier l'analyse</button>
            </div>
            <div id="cmPosts" class="cm-feed"></div>
          </div>
        </div>
        <div id="cmStatus" class="cm-muted" role="status"></div>`;
      $('#viewP').after(pane);
      $('#cmJoin').addEventListener('click', join);
      $('#cmProfileBtn').addEventListener('click', editProfile);
      $('#cmRefresh').addEventListener('click', () => connect(true));
      $('#cmChatTab').addEventListener('click', () => setMode('chat'));
      $('#cmAnalysisTab').addEventListener('click', () => setMode('analysis'));
      $('#cmSendMessage').addEventListener('click', sendMessage);
      $('#cmPublish').addEventListener('click', publishAnalysis);
      $('#cmMessage').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } });
    }
    ['tabA', 'tabP'].forEach(id => {
      const b = $('#' + id);
      if (b && !b.dataset.cmBound) { b.dataset.cmBound = '1'; b.addEventListener('click', closeCommunity); }
    });
    return true;
  }

  function status(msg, error = false) { const el = $('#cmStatus'); if (el) { el.className = error ? 'cm-error' : 'cm-muted'; el.textContent = msg || ''; } }
  function show(id, yes) { const el = $('#' + id); if (el) el.classList.toggle('cm-hidden', !yes); }
  function openCommunity() {
    if (!ensureUI()) return;
    active = true;
    $('#viewA').style.display = 'none'; $('#viewP').style.display = 'none';
    $('#viewCommunity').style.display = 'block';
    $('#tabA')?.classList.remove('on'); $('#tabP')?.classList.remove('on'); $('#tabCommunity')?.classList.add('on');
    boot();
  }
  function closeCommunity() {
    if (!active) return;
    active = false;
    $('#viewCommunity').style.display = 'none';
    $('#tabCommunity')?.classList.remove('on');
    $('#viewA').style.display = ''; $('#viewP').style.display = '';
  }
  function setMode(m) {
    mode = m;
    show('cmChat', m === 'chat'); show('cmAnalyses', m === 'analysis');
    $('#cmChatTab').classList.toggle('primary', m === 'chat');
    $('#cmAnalysisTab').classList.toggle('primary', m === 'analysis');
    render();
  }

  // ---------- Chiffrement (clé dérivée du code de salon) ----------
  const sha256hex = async s => toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s))));
  async function deriveKey(room) {
    const mat = await crypto.subtle.importKey('raw', enc.encode(room), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: enc.encode('scalp-community-v1'), iterations: 100000, hash: 'SHA-256' }, mat, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }
  async function encrypt(obj) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, enc.encode(JSON.stringify(obj))));
    const all = new Uint8Array(iv.length + ct.length); all.set(iv); all.set(ct, iv.length);
    return btoa(String.fromCharCode(...all));
  }
  async function decrypt(b64) {
    const all = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: all.slice(0, 12) }, aesKey, all.slice(12));
    return JSON.parse(dec.decode(pt));
  }

  async function loadLib() {
    if (window.NostrTools) { NT = window.NostrTools; return; }
    await new Promise((res, rej) => {
      const s = document.createElement('script'); s.src = LIB; s.onload = res;
      s.onerror = () => rej(new Error('Impossible de charger la bibliothèque (connexion ?).')); document.head.appendChild(s);
    });
    NT = window.NostrTools;
    if (!NT) throw new Error('Bibliothèque Nostr indisponible.');
  }

  // ---------- Connexion aux relais ----------
  async function handleEvent(ev) {
    if (!ev || ev.kind !== KIND || items.has(ev.id)) return;
    try {
      if (!NT.verifyEvent(ev)) return;
      const o = await decrypt(ev.content);
      if (!o || (o.t !== 'msg' && o.t !== 'post') || typeof o.b !== 'string') return;
      items.set(ev.id, {
        id: ev.id, ts: ev.created_at, type: o.t,
        n: String(o.n || 'Trader').slice(0, 24), b: o.b.slice(0, 2000),
        a: String(o.a || '').slice(0, 30), d: ['BUY', 'SELL', 'ATTENTE'].includes(o.d) ? o.d : '', tf: String(o.tf || '').slice(0, 12)
      });
      cache.set(ev.id, ev); scheduleSave();
      if (active) render();
    } catch (_) { /* message d'un autre salon ou illisible : ignoré */ }
  }
  function openCount() { return sockets.filter(s => s.readyState === 1).length; }
  function updateStatus() { status(openCount() ? `Connecté (${openCount()}/${RELAYS.length} relais).` : 'Connexion aux relais…'); }
  function connect(force = false) {
    if (force) { sockets.forEach(s => { try { s.onclose = null; s.close(); } catch (_) {} }); sockets = []; }
    clearTimeout(retry);
    RELAYS.forEach(url => {
      if (sockets.some(s => s.__url === url && s.readyState <= 1)) return;
      let ws;
      try { ws = new WebSocket(url); } catch (_) { return; }
      ws.__url = url; sockets.push(ws);
      ws.onopen = () => {
        ws.send(JSON.stringify(['REQ', 'scalp', { kinds: [KIND], '#t': [tag], since: Math.floor(Date.now() / 1000) - 30 * 86400, limit: 300 }]));
        // Remet l'historique local sur le relais (il peut l'avoir oublié) : les relais ignorent les doublons.
        const cutoff = Math.floor(Date.now() / 1000) - KEEP_DAYS * 86400;
        [...cache.values()].filter(e => e.created_at >= cutoff).slice(-200).forEach(e => { try { ws.send(JSON.stringify(['EVENT', e])); } catch (_) {} });
        updateStatus();
      };
      ws.onmessage = m => { try { const d = JSON.parse(m.data); if (d[0] === 'EVENT') handleEvent(d[2]); } catch (_) {} };
      ws.onclose = () => { sockets = sockets.filter(s => s !== ws); updateStatus(); clearTimeout(retry); retry = setTimeout(() => { if (booted) connect(); }, 6000); };
      ws.onerror = () => { try { ws.close(); } catch (_) {} };
    });
  }

  async function boot() {
    const c = readCfg();
    if (!c.room || !c.nick) {
      show('cmSetup', true); show('cmMain', false);
      $('#cmRoom').value = c.room || ''; $('#cmNick').value = c.nick || '';
      status('Saisis le code du salon et ton pseudonyme.'); return;
    }
    show('cmSetup', false); show('cmMain', true);
    $('#cmWho').textContent = 'Connecté sous ' + c.nick;
    if (booted) { setMode(mode); return; }
    try {
      status('Connexion…');
      await loadLib();
      if (!c.sk) { c.sk = toHex(NT.generateSecretKey()); saveCfg(c); }
      aesKey = await deriveKey(c.room);
      tag = (await sha256hex('scalp-room:' + c.room)).slice(0, 32);
      booted = true; items.clear(); cache.clear(); await loadCache(); setMode(mode); connect();
    } catch (e) { status('Connexion impossible : ' + (e.message || 'erreur') , true); }
  }

  async function join() {
    const room = $('#cmRoom').value.trim(), nick = $('#cmNick').value.trim();
    if (room.length < 6) return status('Le code du salon doit faire 6 caractères minimum.', true);
    if (!NICK_RE.test(nick)) return status('Pseudonyme : 3 à 24 caractères, lettres, chiffres, espaces, tiret ou _.', true);
    const old = readCfg(); const roomChanged = old.room !== room;
    saveCfg({ room, nick, sk: old.sk });
    if (roomChanged) { sockets.forEach(s => { try { s.onclose = null; s.close(); } catch (_) {} }); sockets = []; booted = false; items.clear(); cache.clear(); }
    await boot();
  }
  function editProfile() {
    const c = readCfg();
    const nick = prompt('Nouveau pseudonyme (3 à 24 caractères)', c.nick || '');
    if (nick === null) return;
    const v = nick.trim();
    if (!NICK_RE.test(v)) return status('Pseudonyme invalide.', true);
    c.nick = v; saveCfg(c); $('#cmWho').textContent = 'Connecté sous ' + v; status('Pseudonyme modifié.');
  }

  // ---------- Envoi ----------
  async function publish(obj) {
    if (!booted) throw new Error('Pas connecté.');
    if (!openCount()) throw new Error('Aucun relais connecté pour le moment. Touche « Reconnecter ».');
    const c = readCfg();
    const ev = NT.finalizeEvent({ kind: KIND, created_at: Math.floor(Date.now() / 1000), tags: [['t', tag]], content: await encrypt({ ...obj, n: c.nick }) }, fromHex(c.sk));
    sockets.forEach(s => { if (s.readyState === 1) s.send(JSON.stringify(['EVENT', ev])); });
    await handleEvent(ev);
  }
  async function sendMessage() {
    const b = $('#cmMessage').value.trim(); if (!b) return;
    try { await publish({ t: 'msg', b: b.slice(0, 1000) }); $('#cmMessage').value = ''; status('Message envoyé.'); }
    catch (e) { status('Envoi impossible : ' + e.message, true); }
  }
  async function publishAnalysis() {
    const a = $('#cmAsset').value.trim().toUpperCase(), d = $('#cmDirection').value;
    const tf = $('#cmTimeframe').value.trim().toUpperCase(), b = $('#cmAnalysisText').value.trim();
    if (!a || !b) return status('Indique au minimum un actif et ton scénario.', true);
    try { await publish({ t: 'post', a, d, tf, b: b.slice(0, 2000) }); $('#cmAnalysisText').value = ''; status('Analyse publiée.'); }
    catch (e) { status('Publication impossible : ' + e.message, true); }
  }

  // ---------- Affichage ----------
  function render() {
    const all = [...items.values()];
    if (mode === 'chat') {
      const list = all.filter(i => i.type === 'msg').sort((x, y) => x.ts - y.ts).slice(-150);
      $('#cmMessages').innerHTML = list.map(m => `<div class="cm-card"><div class="cm-row"><b>${esc(m.n)}</b><span class="spacer"></span><span class="cm-small">${fmt(m.ts)}</span></div><div class="cm-msg">${esc(m.b)}</div></div>`).join('') || '<p class="cm-muted">Aucun message pour le moment. Lance la discussion !</p>';
      const f = $('#cmMessages'); f.scrollTop = f.scrollHeight;
    } else {
      const list = all.filter(i => i.type === 'post').sort((x, y) => y.ts - x.ts).slice(0, 50);
      $('#cmPosts').innerHTML = list.map(p => `<div class="cm-card"><div class="cm-row"><b>${esc(p.n)}</b><span class="spacer"></span><span class="cm-small">${fmt(p.ts)}</span></div><div class="cm-row"><b>${esc(p.a)}</b><span>${esc(p.tf)}</span><strong>${esc(p.d)}</strong></div><div class="cm-msg">${esc(p.b)}</div></div>`).join('') || '<p class="cm-muted">Aucune analyse partagée pour le moment.</p>';
    }
  }

  function init() { ensureUI(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true }); else init();
})();
