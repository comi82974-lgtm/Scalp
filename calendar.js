/* Scalp Analyzer — onglet « Actus » : calendrier économique de la semaine (gratuit, sans clé).
   Source principale : flux public Forex Factory. Secours : widget TradingView. Ne touche à rien d'autre. */
(() => {
  'use strict';
  if (window.__SCALP_NEWS__) return; window.__SCALP_NEWS__ = true;
  const FEED = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';
  const KEY = 'scalp_news_v1';
  const $ = id => document.getElementById(id);
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let events = [], active = false, timer = null, impact = 'high', cur = 'ALL', lastFetch = 0, note = '', updated = 0;

  const css = `
  #viewNews{display:none;color:var(--tx,#e8eef4)}
  #viewNews *{box-sizing:border-box}
  #viewNews .nw-card{background:var(--pan,#121b25);border:1px solid var(--line,#1f2c3a);border-radius:16px;padding:14px;margin-bottom:12px}
  #viewNews .nw-title{font-size:20px;font-weight:700;margin:6px 0 4px}
  #viewNews .nw-muted{color:var(--mut,#8fa1b3);font-size:12px;line-height:1.4}
  #viewNews .nw-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
  #viewNews .nw-seg{display:flex;gap:6px;flex:1}
  #viewNews button,#viewNews select{font:inherit;min-height:44px;border-radius:10px;border:1px solid var(--line,#1f2c3a);background:transparent;color:var(--tx,#e8eef4);padding:0 12px;font-weight:600;font-size:13px}
  #viewNews .nw-seg button{flex:1}
  #viewNews button.on{background:rgba(45,212,160,.14);border-color:#2dd4a0;color:#2dd4a0}
  #viewNews select{background:var(--bg,#0b1118)}
  #viewNews .nw-next{border-color:#f2666b;background:rgba(242,102,107,.08)}
  #viewNews .nw-day{font-size:12px;font-weight:700;color:var(--mut,#8fa1b3);text-transform:capitalize;margin:14px 2px 6px}
  #viewNews .nw-ev{display:flex;gap:10px;align-items:flex-start;padding:10px 12px;border:1px solid var(--line,#1f2c3a);border-radius:12px;background:var(--pan,#121b25);margin-bottom:6px}
  #viewNews .nw-ev.past{opacity:.5}
  #viewNews .nw-time{width:46px;font-weight:700;font-size:14px;flex:none}
  #viewNews .nw-body{flex:1;min-width:0}
  #viewNews .nw-name{font-size:14px;line-height:1.35;overflow-wrap:anywhere}
  #viewNews .nw-cur{font-size:11px;font-weight:700;border:1px solid var(--line,#1f2c3a);border-radius:999px;padding:2px 8px;margin-right:6px}
  #viewNews .nw-dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:6px}
  #viewNews a{color:#f5b546}`;
  const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

  function ensureUI() {
    const bar = document.querySelector('.pp-tabs'), vp = $('viewP');
    if (!bar || !vp) return false;
    if (!$('tabN')) {
      const b = document.createElement('button'); b.id = 'tabN'; b.type = 'button'; b.textContent = 'Actus';
      bar.appendChild(b); b.addEventListener('click', open);
      bar.addEventListener('click', e => {
        const x = e.target.closest && e.target.closest('button'); if (!x || x.id === 'tabN' || !active) return;
        active = false; $('viewNews').style.display = 'none'; $('tabN').classList.remove('on'); stop();
        $('viewA').style.display = ''; $('viewP').style.display = '';
      }, true);
    }
    if (!$('viewNews')) {
      const p = document.createElement('section'); p.id = 'viewNews';
      p.innerHTML = `<div class="nw-title">Annonces à venir</div><div class="nw-muted">Calendrier économique de la semaine · heures dans ton fuseau horaire</div>
        <div id="nwNext"></div>
        <div class="nw-card" style="margin-top:10px"><div class="nw-row"><div class="nw-seg"><button id="nwHigh" type="button">Fortes</button><button id="nwMed" type="button">Fortes + moyennes</button></div></div>
        <div class="nw-row" style="margin-top:8px"><label for="nwCur" class="nw-muted">Devise</label><select id="nwCur"><option value="ALL">Toutes</option></select><span style="flex:1"></span><button id="nwRefresh" type="button">Actualiser</button></div></div>
        <div id="nwStatus" class="nw-muted"></div><div id="nwFresh" class="nw-muted" style="margin:4px 2px 0"></div><div id="nwList"></div><div id="nwWidget"></div>
        <div class="nw-muted" style="margin:14px 2px">Calendrier complet : <a href="https://www.investing.com/economic-calendar/" target="_blank" rel="noopener">Investing.com</a> · <a href="https://www.forexfactory.com/calendar" target="_blank" rel="noopener">Forex Factory</a></div>`;
      vp.after(p);
      $('nwHigh').addEventListener('click', () => { impact = 'high'; render(); });
      $('nwMed').addEventListener('click', () => { impact = 'med'; render(); });
      $('nwCur').addEventListener('change', e => { cur = e.target.value; render(); });
      $('nwRefresh').addEventListener('click', () => load(true));
    }
    return true;
  }
  function open() {
    if (!ensureUI()) return;
    const a = $('tabA'); if (a) a.click();
    $('viewA').style.display = 'none'; $('viewP').style.display = 'none'; $('viewNews').style.display = 'block';
    document.querySelectorAll('.pp-tabs button').forEach(b => b.classList.toggle('on', b.id === 'tabN'));
    active = true; load(false); stop(); timer = setInterval(() => active && render(), 30000);
    try { window.scrollTo({ top: 0 }); } catch (_) {}
  }
  function stop() { if (timer) { clearInterval(timer); timer = null; } }
  const readCache = () => { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (_) { return null; } };

  async function getJSON(url, ms) {
    const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), ms);
    try { const r = await fetch(url, { cache: 'no-store', signal: ctl.signal }); if (!r.ok) throw new Error('HTTP ' + r.status); return await r.json(); }
    finally { clearTimeout(to); }
  }
  const clean = a => Array.isArray(a) ? a.filter(e => e && e.title && e.date && e.impact) : [];
  async function load(force) {
    const c = readCache(), age = c ? Date.now() - c.t : Infinity;
    if (!force && age < 15 * 60000 && c.data && c.data.length) { events = c.data; updated = c.upd || c.t; note = ''; $('nwWidget').innerHTML = ''; render(); return; }
    if (force && Date.now() - lastFetch < 60000 && c) { note = 'Déjà actualisé il y a moins d’une minute.'; events = c.data; updated = c.upd || c.t; render(); return; }
    lastFetch = Date.now(); $('nwStatus').textContent = 'Chargement…';
    let data = null, upd = 0;
    try { const j = await getJSON('./news.json?t=' + Math.floor(Date.now() / 60000), 6000); const ev = clean(j && j.events); if (ev.length) { data = ev; upd = Date.parse(j.updated) || 0; } } catch (_) {}
    if (!data || Date.now() - upd > 3 * 3600000) {
      try { const ev = clean(await getJSON(FEED, 9000)); if (ev.length) { data = ev; upd = Date.now(); } } catch (_) {}
    }
    if (data) {
      try { localStorage.setItem(KEY, JSON.stringify({ t: Date.now(), upd, data })); } catch (_) {}
      events = data; updated = upd; note = ''; $('nwWidget').innerHTML = ''; render(); return;
    }
    if (c && c.data && c.data.length) { events = c.data; updated = c.upd || c.t; note = 'Flux indisponible : dernières données enregistrées.'; render(); return; }
    widgetFallback();
  }
  function widgetFallback() {
    $('nwList').innerHTML = ''; $('nwNext').innerHTML = '';
    $('nwStatus').textContent = 'Le flux gratuit n’a pas répondu : calendrier TradingView affiché à la place.';
    const box = $('nwWidget'); box.innerHTML = '';
    const wrap = document.createElement('div'); wrap.className = 'tradingview-widget-container';
    const inner = document.createElement('div'); inner.className = 'tradingview-widget-container__widget'; wrap.appendChild(inner);
    const s = document.createElement('script'); s.async = true; s.src = 'https://s3.tradingview.com/external-embedding/embed-widget-events.js';
    s.textContent = JSON.stringify({ width: '100%', height: '560', colorTheme: 'dark', isTransparent: true, locale: 'fr', importanceFilter: '0,1' });
    s.onerror = () => { $('nwStatus').textContent = 'Calendrier indisponible pour le moment. Utilise les liens ci-dessous.'; };
    wrap.appendChild(s); box.appendChild(wrap);
  }
  const fmtIn = ms => { const m = Math.round(ms / 60000); if (m <= 0) return 'maintenant'; if (m < 60) return 'dans ' + m + ' min'; const h = Math.floor(m / 60); if (h < 24) return 'dans ' + h + ' h ' + String(m % 60).padStart(2, '0'); return 'dans ' + Math.floor(h / 24) + ' j ' + (h % 24) + ' h'; };
  function render() {
    if (!$('nwList')) return;
    const now = Date.now();
    const all = events.map(e => ({ ...e, ts: Date.parse(e.date) })).filter(e => !isNaN(e.ts) && e.impact !== 'Holiday').sort((a, b) => a.ts - b.ts);
    const cs = [...new Set(all.map(e => e.country).filter(Boolean))].sort((a, b) => { const p = ['USD', 'EUR', 'GBP', 'JPY']; return (p.indexOf(a) < 0 ? 9 : p.indexOf(a)) - (p.indexOf(b) < 0 ? 9 : p.indexOf(b)) || a.localeCompare(b); });
    const sel = $('nwCur'); if (sel.options.length !== cs.length + 1) sel.innerHTML = '<option value="ALL">Toutes</option>' + cs.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
    sel.value = cs.includes(cur) ? cur : 'ALL'; if (sel.value === 'ALL') cur = 'ALL';
    $('nwHigh').classList.toggle('on', impact === 'high'); $('nwMed').classList.toggle('on', impact === 'med');
    const list = all.filter(e => (impact === 'high' ? e.impact === 'High' : e.impact === 'High' || e.impact === 'Medium') && (cur === 'ALL' || e.country === cur));
    const nx = list.find(e => e.impact === 'High' && e.ts >= now - 60000);
    $('nwNext').innerHTML = nx ? `<div class="nw-card nw-next"><div class="nw-muted">Prochaine annonce forte</div><div style="font-size:16px;font-weight:700;margin-top:4px">${esc(nx.country)} · ${esc(nx.title)}</div><div style="margin-top:4px;color:#f2666b;font-weight:700">${fmtIn(nx.ts - now)}</div></div>` : '';
    const upcoming = all.some(e => e.ts >= now);
    $('nwStatus').textContent = note || (!upcoming ? 'Toutes les annonces de cette semaine sont passées. La semaine suivante apparaîtra dès sa publication.' : (list.length ? '' : 'Aucune annonce avec ces filtres cette semaine.'));
    const ag = updated ? now - updated : -1;
    $('nwFresh').innerHTML = ag < 0 ? '' : (ag > 12 * 3600000 ? '<b style="color:#f2666b">Données de plus de 12 h : elles peuvent être dépassées.</b> ' : '') + 'Source : Forex Factory · mis à jour ' + (ag < 90000 ? 'à l’instant' : ag < 3600000 ? 'il y a ' + Math.round(ag / 60000) + ' min' : ag < 86400000 ? 'il y a ' + Math.round(ag / 3600000) + ' h' : 'il y a ' + Math.round(ag / 86400000) + ' j') + '. Prévisions uniquement (pas les résultats publiés).';
    const today = new Date().toDateString(); let day = '', html = '';
    list.forEach(e => {
      const d = new Date(e.ts), key = d.toDateString();
      if (key !== day) { day = key; html += `<div class="nw-day">${key === today ? 'Aujourd’hui · ' : ''}${esc(d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' }))}</div>`; }
      const col = e.impact === 'High' ? '#f2666b' : '#f5b546';
      const sub = [e.forecast ? 'Prévu : ' + esc(e.forecast) : '', e.previous ? 'Préc. : ' + esc(e.previous) : ''].filter(Boolean).join(' · ');
      html += `<div class="nw-ev${e.ts < now - 3600000 ? ' past' : ''}"><div class="nw-time">${d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}</div><div class="nw-body"><div class="nw-name"><span class="nw-dot" style="background:${col}"></span><span class="nw-cur">${esc(e.country)}</span>${esc(e.title)}</div>${sub ? `<div class="nw-muted" style="margin-top:3px">${sub}</div>` : ''}</div></div>`;
    });
    $('nwList').innerHTML = html;
  }
  const init = () => { try { ensureUI(); } catch (e) { console.error('[Scalp actus]', e); } };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true }); else init();
})();
