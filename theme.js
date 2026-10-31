/* Scalp Analyzer — thème pro : barre d'onglets Analyse · Plan · Journal · Lots · Communauté.
   Ne touche ni à l'analyse Gemini ni au graphique : il ne fait que masquer/afficher des panneaux existants. */
(() => {
  'use strict';
  if (window.__SCALP_THEME__) return; window.__SCALP_THEME__ = true;
  const $ = id => document.getElementById(id);
  const RANK = ['tabA', 'tabP', 'tabJ', 'tabL', 'tabN', 'tabCommunity'];
  function mark() {
    const v = $('viewA'); if (!v) return;
    [['lcAcc', 'th-lot'], ['hp', 'th-hp']].forEach(([id, cls]) => {
      let n = $(id); if (!n) return;
      while (n && n.parentElement !== v) n = n.parentElement;
      if (n) n.classList.add(cls);
    });
  }
  const mode = m => { document.body.classList.remove('th-journal', 'th-lots'); if (m) document.body.classList.add('th-' + m); };
  const setOn = id => document.querySelectorAll('.pp-tabs button').forEach(b => b.classList.toggle('on', b.id === id));
  function order() {
    const bar = document.querySelector('.pp-tabs'); if (!bar) return;
    RANK.forEach(id => { const b = $(id); if (b) bar.appendChild(b); });
  }
  function make(id, label, m) {
    const b = document.createElement('button');
    b.id = id; b.type = 'button'; b.textContent = label;
    b.addEventListener('click', () => {
      const a = $('tabA'); if (a) a.click();
      mark(); mode(m); setOn(id);
      try { window.scrollTo({ top: 0 }); } catch (_) {}
    });
    return b;
  }
  function init() {
    try {
      const bar = document.querySelector('.pp-tabs'); if (!bar) return;
      if (!$('tabJ')) bar.appendChild(make('tabJ', 'Journal', 'journal'));
      if (!$('tabL')) bar.appendChild(make('tabL', 'Lots', 'lots'));
      bar.addEventListener('click', e => {
        const b = e.target.closest && e.target.closest('button'); if (!b) return;
        if (['tabA', 'tabP', 'tabN', 'tabCommunity'].includes(b.id)) { mode(null); ['tabJ', 'tabL'].forEach(i => $(i) && $(i).classList.remove('on')); }
      }, true);
      mark(); order();
      [600, 1800].forEach(t => setTimeout(() => { try { mark(); order(); } catch (_) {} }, t));
    } catch (e) { console.error('[Scalp thème]', e); }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true }); else init();
})();
