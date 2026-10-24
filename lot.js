/* Scalp Analyzer — calculateur de lot (tailles de contrat FundedNext). À charger après le script principal et plan.js. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const g = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; } };
  const s = (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} };
  const num = v => { const t = String(v ?? '').trim().replace(',', '.'); if (t === '') return null; const n = Number(t); return Number.isFinite(n) ? n : null; };
  if (!$('res')) { console.error('[Scalp Lot] App introuvable, calculateur non chargé.'); return; }

  // Tailles de contrat officielles FundedNext : forex 100 000, indices 10, matières premières 100 (argent 5 000), crypto 1 / 100 / 1 000 selon la paire.
  const SY = {};
  const add = (grp, list, fn) => list.split(' ').forEach(k => { SY[k] = Object.assign({ grp, key: k }, fn(k)); });
  add('Crypto', 'BTCUSD', () => ({ pv: 1, txt: 'BTCUSD : 1 lot = 1 BTC (FundedNext).' }));
  add('Crypto', 'ETHUSD LTCUSD XRPUSD ADAUSD DOGUSD XLMUSD LNKUSD XMRUSD', k => ({ pv: null, txt: k + ' : contrat de 1, 100 ou 1 000 selon la paire. Ouvre « Spécification » dans MT5 et saisis la valeur ci-dessus.' }));
  add('Matières premières', 'XAUUSD XPTUSD UKOUSD USOUSD', () => ({ pv: 100, txt: 'Matières premières : contrat 100.' }));
  add('Matières premières', 'XAGUSD', () => ({ pv: 5000, txt: 'Argent : contrat 5 000.' }));
  add('Indices', 'US30 SPX500 NDX100 US2000', () => ({ pv: 10, txt: 'Indice en $ : contrat 10 = 10 $ par point et par lot.' }));
  add('Indices (devise locale)', 'AUS200 EUSTX50 FRA40 GER30 HK50 NTH25 SWI20 UK100 JP225', () => ({ pv: 10, warn: true, txt: 'Indice : contrat 10, mais valeur dans la devise de l’indice (pas en $). Saisis la valeur convertie en $ pour un calcul exact.' }));
  add('Forex', 'AUDCAD AUDCHF AUDJPY AUDNZD AUDSGD AUDUSD CADCHF CADJPY CHFJPY EURAUD EURCAD EURCHF EURGBP EURHKD EURJPY EURNOK EURNZD EURSGD EURUSD GBPAUD GBPCAD GBPCHF GBPJPY GBPNZD GBPSGD GBPUSD NZDCAD NZDCHF NZDJPY NZDSGD SGDJPY USDCAD USDCHF USDCNH USDDKK USDHUF USDJPY USDMXN USDNOK USDSGD USDZAR NZDUSD USDSEK', k => {
    const b = k.slice(0, 3), q = k.slice(3);
    if (q === 'USD') return { pv: 100000, txt: 'Forex : 1 lot = 100 000 unités.' };
    if (b === 'USD') return { dyn: true, txt: 'Forex : 100 000 unités, converti en $ au prix d’entrée.' };
    return { pv: null, txt: 'Paire croisée : saisis la valeur d’un mouvement de 1,00 pour 1 lot, en $ (100 000 × valeur de ' + q + ' en $).' };
  });
  const ALIAS = [[/XAU|GOLD/, 'XAUUSD'], [/XAG|SILVER/, 'XAGUSD'], [/XPT/, 'XPTUSD'], [/US30|DJ30|DJI|WS30/, 'US30'], [/NAS100|US100|USTEC|NDX/, 'NDX100'], [/SPX|US500|SP500/, 'SPX500'], [/GER30|GER40|DE40|DE30|DAX/, 'GER30'], [/UK100|FTSE/, 'UK100'], [/JP225|JPN225|NIKKEI/, 'JP225'], [/BTC/, 'BTCUSD'], [/ETH/, 'ETHUSD']];
  function match(txt) {
    const a = String(txt || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    for (const [r, k] of ALIAS) if (r.test(a)) return k;
    for (const x of (a.match(/[A-Z]{6}/g) || [])) if (SY[x]) return x;
    return null;
  }

  const pan = document.createElement('div'); pan.className = 'pan'; pan.id = 'lotPan';
  const groups = {}; Object.values(SY).forEach(o => (groups[o.grp] = groups[o.grp] || []).push(o.key));
  const opts = Object.entries(groups).map(([gr, ks]) => '<optgroup label="' + gr + '">' + ks.map(k => '<option>' + k + '</option>').join('') + '</optgroup>').join('');
  pan.innerHTML = '<h2>Calculateur de lot</h2>' +
    '<div class="row"><div><label for="lcSym">Actif</label><select id="lcSym">' + opts + '</select></div><div><label for="lcAcc">Compte</label><input id="lcAcc" inputmode="decimal" placeholder="10000"></div></div>' +
    '<div class="row"><div><label for="lcRisk">Risque par trade</label><input id="lcRisk" inputmode="decimal" placeholder="1"></div><div><label for="lcMode">Unité</label><select id="lcMode"><option value="pct">% du compte</option><option value="usd">Montant fixe</option></select></div><div><label for="lcStep">Pas du lot</label><input id="lcStep" inputmode="decimal" placeholder="0.01"></div></div>' +
    '<div class="row"><div><label for="lcE">Entrée</label><input id="lcE" inputmode="decimal"></div><div><label for="lcS">SL</label><input id="lcS" inputmode="decimal"></div><div><label for="lcT">TP (option)</label><input id="lcT" inputmode="decimal"></div></div>' +
    '<div class="row" style="margin-top:8px"><button type="button" class="sec" data-p="0.5" style="margin:0">0,5 %</button><button type="button" class="sec" data-p="1" style="margin:0">1 %</button></div>' +
    '<div id="lcOut" class="valbox" style="margin-top:10px"></div>' +
    '<div class="row" style="margin-top:6px;align-items:center"><label for="lcPv" style="margin:0">$ pour 1,00 de prix / lot</label><input id="lcPv" inputmode="decimal"></div>' +
    '<p class="note" id="lcTxt"></p>';
  $('res').after(pan);

  $('lcSym').value = g('lc_sym', 'XAUUSD'); $('lcAcc').value = g('lc_acc', ''); $('lcRisk').value = g('lc_risk', '1'); $('lcMode').value = g('lc_mode', 'pct'); $('lcStep').value = g('lc_step', '0.01');

  let src = '';
  const dec = st => { const t = String(st); return t.includes('.') ? t.split('.')[1].length : 0; };
  const money = v => (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2)) + ' $';
  const line = (out, t, strong, css) => { const el = document.createElement(strong ? 'b' : 'div'); el.textContent = t; el.style.cssText = (strong ? 'display:block;' : 'font-size:13px;color:var(--mut);margin-top:3px;') + (css || ''); out.appendChild(el); };

  function calc() {
    const sy = SY[$('lcSym').value]; if (!sy) return;
    const acc = num($('lcAcc').value), rv = num($('lcRisk').value), mode = $('lcMode').value, step = num($('lcStep').value) || 0.01;
    const e = num($('lcE').value), sl = num($('lcS').value), tp = num($('lcT').value), out = $('lcOut');
    out.replaceChildren(); $('lcTxt').textContent = sy.txt;
    const ov = num(g('lc_pv_' + sy.key, '')), pvDef = sy.dyn ? (e > 0 ? 100000 / e : null) : sy.pv, pv = ov > 0 ? ov : pvDef;
    if (document.activeElement !== $('lcPv')) $('lcPv').value = pv > 0 ? String(+pv.toFixed(4)) : '';
    const risk = mode === 'pct' ? (acc > 0 && rv > 0 ? acc * rv / 100 : null) : (rv > 0 ? rv : null);
    if (!(risk > 0)) { line(out, mode === 'pct' ? 'Renseigne la taille de ton compte et le risque pour calculer le lot.' : 'Renseigne le montant à risquer.'); return; }
    if (!(e > 0) || !(sl > 0)) { line(out, 'Saisis l’entrée et le SL (remplis tout seuls après une analyse).'); return; }
    if (e === sl) { line(out, 'SL identique à l’entrée : calcul impossible.'); return; }
    if (!(pv > 0)) { line(out, 'Taille de contrat inconnue : saisis la valeur dans le champ ci-dessous.', true, 'color:var(--sell)'); return; }
    const dist = Math.abs(e - sl), lots = Math.floor(risk / (dist * pv) / step + 1e-9) * step, d = dec(step);
    if (lots < step) {
      const mr = step * dist * pv;
      line(out, 'Lot : trop risqué', true, 'color:var(--sell);font-size:16px');
      line(out, 'Même ' + step.toFixed(d) + ' lot risque ' + money(mr) + (acc > 0 ? ' (' + (mr / acc * 100).toFixed(2) + ' % du compte)' : '') + ', au-dessus de ton risque de ' + money(risk) + '. SL trop large.');
    } else {
      const real = lots * dist * pv;
      line(out, 'Lot à prendre : ' + lots.toFixed(d), true, 'font-size:18px;color:var(--brass)');
      line(out, 'Risque réel ' + money(real) + (acc > 0 ? ' (' + (real / acc * 100).toFixed(2) + ' % du compte)' : '') + ' · SL à ' + +dist.toFixed(5) + ' du prix' + (tp > 0 ? ' · gain au TP ≈ ' + money(lots * Math.abs(tp - e) * pv) : ''));
    }
    if (src) line(out, 'Niveaux : ' + src + '.');
    if (sy.warn && !(ov > 0)) line(out, '⚠ Valeur en devise locale : résultat approximatif.', false, 'color:var(--sell)');
  }

  [['lcSym', 'lc_sym'], ['lcAcc', 'lc_acc'], ['lcRisk', 'lc_risk'], ['lcMode', 'lc_mode'], ['lcStep', 'lc_step']].forEach(([id, k]) => $(id).addEventListener('input', () => { s(k, $(id).value); calc(); }));
  ['lcE', 'lcS', 'lcT'].forEach(id => $(id).addEventListener('input', () => { src = 'saisis à la main'; calc(); }));
  $('lcPv').addEventListener('change', () => { const sy = SY[$('lcSym').value], n = num($('lcPv').value); s('lc_pv_' + sy.key, n > 0 ? String(n) : ''); calc(); });
  pan.querySelectorAll('button[data-p]').forEach(b => b.addEventListener('click', () => { $('lcMode').value = 'pct'; $('lcRisk').value = b.dataset.p; s('lc_mode', 'pct'); s('lc_risk', b.dataset.p); calc(); }));

  // Remplissage automatique après chaque analyse (le calcul d'analyse n'est pas modifié).
  const orig = window.show;
  if (typeof orig === 'function') {
    window.show = function (d) {
      orig.apply(this, arguments);
      try {
        const v = String(d?.verdict || '').toUpperCase(), pc = d?.plan_conditionnel;
        // Même logique que le journal : niveaux du signal, sinon ceux du setup conditionnel (cas NO_TRADE avec ordre limite).
        const own = +d?.entree > 0 && +d?.sl > 0, plan = !own && pc && +pc.entree > 0 && +pc.sl > 0;
        const T = own ? d : (plan ? pc : null);
        const k = match(d?.actif_lu || ($('asset') && $('asset').value));
        if (k) { $('lcSym').value = k; s('lc_sym', k); }
        // Toujours vider les anciens niveaux : jamais de lot calculé sur l'analyse précédente.
        $('lcE').value = T ? (T.entree ?? '') : ''; $('lcS').value = T ? (T.sl ?? '') : ''; $('lcT').value = T ? (T.tp ?? '') : '';
        src = !T ? 'aucun dans cette analyse, saisis l’entrée et le SL' : (plan ? 'setup conditionnel (' + (String(pc.sens || '').toUpperCase() || 'ordre limite') + ')' : (v === 'NO_TRADE' ? 'NO_TRADE avec niveaux' : 'signal ' + v));
        calc();
      } catch (err) { console.warn('[Scalp Lot] Remplissage impossible :', err); }
    };
  }
  calc();
})();
