/* Scalp Analyzer — journal complet. À charger après le script principal ET plan.js. */
(() => {
  'use strict';
  const DB_NAME = 'scalp-analyzer-journal-v1', STORE = 'records', MAX_RECORDS = 250;
  const $ = id => document.getElementById(id);
  const originalSave = window.save, originalRenderHist = window.renderHist;
  if (typeof originalSave !== 'function' || typeof originalRenderHist !== 'function' || !$('hl') || !$('hp')) {
    console.error('[Scalp Journal] Non chargé : fonctions/éléments de l’application introuvables. Vérifie l’ordre des scripts.');
    return;
  }
  let dbPromise;
  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) return reject(new Error('IndexedDB indisponible'));
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'id' });
          store.createIndex('createdAt', 'createdAt');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('Ouverture IndexedDB impossible'));
    });
    return dbPromise;
  }
  function request(mode, fn) {
    return openDB().then(db => new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode), store = tx.objectStore(STORE);
      let req;
      try { req = fn(store); } catch (e) { reject(e); return; }
      let result;
      if (req && 'result' in req) req.onsuccess = () => { result = req.result; };
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error || new Error('Transaction IndexedDB échouée'));
      tx.onabort = () => reject(tx.error || new Error('Transaction IndexedDB annulée'));
    }));
  }
  const getAll = () => request('readonly', s => s.getAll());
  const put = r => request('readwrite', s => s.put(r));
  const remove = id => request('readwrite', s => s.delete(id));
  const num = v => { if (v === '' || v == null) return null; const n = Number(String(v).replace(',', '.')); return Number.isFinite(n) ? n : null; };
  const fmt = (v, n=2) => Number.isFinite(v) ? v.toFixed(n) : '—';
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const id = () => (crypto?.randomUUID ? crypto.randomUUID() : 'rec-'+Date.now()+'-'+Math.random().toString(36).slice(2));
  function levels(d) {
    const verdict = String(d?.verdict || '').toUpperCase();
    const entry = num(d?.entree), sl = num(d?.sl), tp = num(d?.tp);
    if (entry == null || sl == null || tp == null) return null;
    if (entry === sl || entry === tp || sl === tp) return null;

    // BUY/SELL garde son sens explicite. Pour NO_TRADE, on n'invente rien :
    // le sens n'est déduit que si l'ordre réel des niveaux entrée/SL/TP est univoque.
    let side = verdict;
    if (verdict === 'NO_TRADE') {
      if (sl < entry && entry < tp) side = 'BUY';
      else if (tp < entry && entry < sl) side = 'SELL';
      else return null;
    }
    if (!['BUY','SELL'].includes(side)) return null;
    if (side === 'BUY' ? !(sl < entry && entry < tp) : !(tp < entry && entry < sl)) return null;
    return { side, entry, sl, tp, risk: Math.abs(entry-sl), reward: Math.abs(tp-entry) };
  }
  function snapshotCanvases() {
    const out = {};
    ['cv','cv2','cv3'].forEach(cid => {
      const c = $(cid);
      if (!c || !c.width || !c.height) return;
      try {
        // JPEG réduit la taille de stockage tout en gardant les annotations lisibles.
        out[cid] = c.toDataURL('image/jpeg', 0.76);
      } catch (e) { console.warn('[Scalp Journal] Capture non sauvegardée:', cid, e); }
    });
    return out;
  }
  function style() {
    if ($('scalpJournalStyles')) return;
    const s = document.createElement('style'); s.id = 'scalpJournalStyles';
    s.textContent = `
      #journalStats{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px;margin:10px 0}
      .js-stat{background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:9px;font-size:12px;color:var(--mut)}
      .js-stat strong{display:block;color:var(--tx);font-size:18px;margin-top:2px}
      .js-record{border:1px solid var(--line);border-radius:9px;padding:10px;margin:9px 0;background:var(--bg)}
      .js-head{display:flex;justify-content:space-between;gap:8px;align-items:flex-start}
      .js-meta{font-size:12px;color:var(--mut);margin:5px 0;overflow-wrap:anywhere}
      .js-actions{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:5px;margin-top:8px}
      .js-actions button{margin:0;padding:8px 3px;font-size:12px;min-width:0}
      .js-actions .js-secondary{background:transparent;border:1px solid var(--line);color:var(--tx)}
      .js-actions .js-active{outline:2px solid var(--brass);outline-offset:1px}
      .js-open{background:transparent!important;color:var(--tx)!important;border:1px solid var(--line)!important;padding:8px!important;font-size:12px!important;margin:0!important;width:auto!important}
      #jsDetail{border:1px solid var(--brass);border-radius:9px;padding:12px;margin:10px 0;overflow-wrap:anywhere}
      #jsDetail img{width:100%;height:auto;border-radius:7px;margin-top:8px;border:1px solid var(--line)}
      #jsDetail pre{white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.45 ui-monospace,monospace;background:var(--bg);padding:8px;border-radius:7px;max-height:360px;overflow:auto}
      #jsRawData{margin-top:12px} #jsRawData summary{cursor:pointer;color:var(--mut);padding:8px 0}
      .js-positive{color:var(--buy)!important}.js-negative{color:var(--sell)!important}
      .js-week{font-size:13px;color:var(--brass);margin:14px 0 5px;border-bottom:1px solid var(--line);padding-bottom:5px}
      @media(min-width:500px){#journalStats{grid-template-columns:repeat(4,minmax(0,1fr))}}
    `; document.head.appendChild(s);
  }
  function ensureUI() {
    style();
    if (!$('journalStats')) { const el=document.createElement('div'); el.id='journalStats'; el.setAttribute('aria-live','polite'); $('hp').insertBefore(el,$('hl')); }
    if (!$('jsDetail')) {
      const el=document.createElement('section'); el.id='jsDetail'; el.className='hide';
      const h=document.createElement('h2'); h.textContent='Détail de l’analyse';
      const body=document.createElement('div'); body.id='jsDetailBody';
      const close=document.createElement('button'); close.type='button'; close.className='sec'; close.textContent='Fermer le détail'; close.addEventListener('click',()=>el.classList.add('hide'));
      el.append(h,body,close); $('hp').insertBefore(el,$('hl'));
    }
  }
  function weekKey(ms) {
    const d=new Date(ms), day=(d.getDay()+6)%7; d.setDate(d.getDate()-day); d.setHours(0,0,0,0);
    return d.toLocaleDateString('fr-FR',{day:'2-digit',month:'2-digit',year:'numeric'});
  }
  async function saveRecord(rec) {
    // Purge avant l'ajout pour réduire le risque de quota saturé par les images.
    const all=(await getAll()).sort((a,b)=>b.createdAt-a.createdAt);
    if (all.length >= MAX_RECORDS) await Promise.all(all.slice(MAX_RECORDS-1).map(r=>remove(r.id)));
    await put(rec); await render();
  }
  let storageWarning=false;
  function warnStorage() {
    if(storageWarning)return; storageWarning=true;
    const p=document.createElement('p'); p.className='note'; p.style.color='var(--sell)';
    p.textContent='Le journal complet n’a pas pu être sauvegardé sur cet appareil. L’analyse Gemini reste affichée, mais vérifie l’espace de stockage du navigateur.';
    $('hp')?.prepend(p);
  }
  window.save = function(data, asset) {
    // Le comportement historique est conservé ; une erreur du journal ne bloque jamais l'analyse.
    try { originalSave(data, asset); } catch (e) { console.error('[Scalp Journal] Historique classique:', e); }
    let copy;
    try { copy = JSON.parse(JSON.stringify(data || {})); } catch (_) { copy = {}; }
    const rec = {
      id:id(), createdAt:Date.now(), time:new Date().toLocaleString('fr-FR',{dateStyle:'short',timeStyle:'short'}),
      asset:String(asset || data?.actif_lu || '?'), data:copy, charts:snapshotCanvases(), status:'not_taken', outcome:{status:'not_taken',label:'Non pris',exitPrice:null,points:null,r:null},
      opportunityType:String(copy.verdict||'').toUpperCase()==='NO_TRADE'?'confirmation_or_no_setup':(['BUY','SELL'].includes(String(copy.verdict||'').toUpperCase())?'trade_signal':'analysis')
    };
    saveRecord(rec).catch(e=>{console.error('[Scalp Journal] Sauvegarde complète impossible:',e);warnStorage();});
  };
  function button(label, cls, fn) { const b=document.createElement('button'); b.type='button'; b.textContent=label; if(cls)b.className=cls; b.addEventListener('click',fn); return b; }
  function outcome(rec,status,manualExit=null) {
    if(status==='not_taken') return {status, label:'Non pris', exitPrice:null, points:null, r:null};
    const lv=levels(rec.data);
    // NO_TRADE reste une opportunité comptabilisable : son résultat peut être marqué
    // manuellement, mais aucun P&L/R n'est inventé sans direction et niveaux valides.
    if(!lv && String(rec.data?.verdict||'').toUpperCase()==='NO_TRADE') {
      return {status, exitPrice:null, points:null, r:null, label:status==='win'?'Gagnant (résultat manuel, sans P&L)':status==='loss'?'Perdant (résultat manuel, sans P&L)':'À l’équilibre'};
    }
    if(!lv)return null;
    const exit=manualExit==null ? (status==='win'?lv.tp:lv.sl) : num(manualExit);
    if(exit==null)return null;
    const points=lv.side==='BUY'?exit-lv.entry:lv.entry-exit;
    if(points === 0) return {status:'not_taken',exitPrice:exit,points:null,r:null,label:'Non pris (sortie au prix d’entrée)'};
    return {status, exitPrice:exit, points, r:points/lv.risk, label:status==='win'?(manualExit==null?'Gagnant (TP théorique)':'Gagnant (sortie saisie)'):(manualExit==null?'Perdant (SL théorique)':'Perdant (sortie saisie)')};
  }
  async function setStatus(recId,status,manualExit=null) {
    const all=await getAll(), rec=all.find(r=>r.id===recId); if(!rec)return;
    const result=outcome(rec,status,manualExit);
    if(!result){alert('Calcul impossible : vérifie le verdict BUY/SELL et les niveaux entrée, SL et TP.');return;}
    rec.status=status; rec.outcome=result; rec.updatedAt=Date.now(); await put(rec); await render();
  }
  function addText(parent,tag,text,cls) { const e=document.createElement(tag); e.textContent=String(text??''); if(cls)e.className=cls; parent.appendChild(e); return e; }
  function openDetail(rec) {
    const d=rec.data||{};
    // Réaffiche aussi le panneau natif de Scalp Analyzer à partir des données archivées.
    // Cela réutilise le rendu original au lieu de ne montrer que le JSON brut.
    try { if (typeof window.show === 'function') window.show(JSON.parse(JSON.stringify(d))); }
    catch (e) { console.warn('[Scalp Journal] Restauration du rendu original impossible:', e); }
    const box=$('jsDetail'), body=$('jsDetailBody'); body.replaceChildren(); const lv=levels(d);
    addText(body,'p',`${rec.asset} · ${rec.time} · ${d.verdict||'—'} · ${d.action||'—'}`);
    addText(body,'p',lv?`Entrée ${lv.entry} · SL ${lv.sl} · TP ${lv.tp} · RR ${fmt(lv.reward/lv.risk)}`:`Entrée ${d.entree??'—'} · SL ${d.sl??'—'} · TP ${d.tp??'—'} · niveaux non validés`);
    if(rec.outcome) addText(body,'p',rec.status==='not_taken'?'Signal non pris : exclu du taux de réussite.':`${rec.outcome.label} · ${fmt(rec.outcome.r)} R · ${fmt(rec.outcome.points)} points. Résultat calculé, pas un relevé broker.`);
    [['raisons','Raisons'],['invalidation','Invalidation'],['attente','À surveiller']].forEach(([k,label])=>{if(d[k])addText(body,'p',`${label} : ${d[k]}`)});
    if(d.scenario && typeof d.scenario==='object') {
      addText(body,'h3',d.scenario.titre||'Scénario'); if(d.scenario.description)addText(body,'p',d.scenario.description);
      if(Array.isArray(d.scenario.etapes)){const ol=document.createElement('ol');d.scenario.etapes.forEach(x=>addText(ol,'li',x));body.appendChild(ol)}
      if(d.scenario.alternatif)addText(body,'p','Alternatif : '+d.scenario.alternatif);
    }
    if(Array.isArray(d.confluences)&&d.confluences.length){addText(body,'h3','Confluences');const ul=document.createElement('ul');d.confluences.forEach(x=>addText(ul,'li',x));body.appendChild(ul)}
    if(Array.isArray(d.indicateurs)&&d.indicateurs.length){addText(body,'h3','Indicateurs');const ul=document.createElement('ul');d.indicateurs.forEach(x=>addText(ul,'li',`${x.nom||''} ${x.valeur||''} — ${x.etat||''}`));body.appendChild(ul)}
    if(lv && rec.status!=='not_taken') {
      addText(body,'h3','Sortie manuelle (facultatif)');
      const label=document.createElement('label');label.textContent='Prix de sortie réel';label.htmlFor='jsManualExit';body.appendChild(label);
      const input=document.createElement('input');input.id='jsManualExit';input.inputMode='decimal';input.placeholder='Ex. '+lv.tp;input.value=rec.outcome?.exitPrice!=null?String(rec.outcome.exitPrice):'';body.appendChild(input);
      body.appendChild(button('Enregistrer sortie réelle','js-open',()=>{
        const exit=num(input.value); if(exit==null){alert('Saisis un prix de sortie valide.');return;}
        const status=exit===lv.entry?'not_taken':((lv.side==='BUY' ? exit>lv.entry : exit<lv.entry)?'win':'loss');
        setStatus(rec.id,status,exit).catch(e=>{console.error(e);alert('Impossible d’enregistrer la sortie.');});
      }));
      addText(body,'p','La sortie manuelle est évaluée par rapport à l’entrée et au sens BUY/SELL. Vérifie le résultat affiché avant de l’utiliser dans tes statistiques.','js-meta');
    }
    // Afficher d'abord les visuels sauvegardés, puis garder la réponse brute Gemini
    // disponible seulement sur demande, dans une section repliée par défaut.
    Object.entries(rec.charts||{}).forEach(([cid,src])=>{if(typeof src!=='string'||!src.startsWith('data:image/'))return;addText(body,'p',({cv:'Graphique annoté principal',cv2:'Plan conditionnel',cv3:'Scénario visuel'})[cid]||cid);const img=document.createElement('img');img.alt=cid;img.loading='lazy';img.src=src;body.appendChild(img)});
    const raw=document.createElement('details'); raw.id='jsRawData';
    const summary=document.createElement('summary'); summary.textContent='Afficher les données brutes de Gemini (technique)'; raw.appendChild(summary);
    const pre=document.createElement('pre'); pre.textContent=typeof d==='string'?d:JSON.stringify(d,null,2); raw.appendChild(pre); body.appendChild(raw);
    box.classList.remove('hide'); box.scrollIntoView({behavior:'smooth',block:'start'});
  }
  async function render() {
    ensureUI(); const records=await getAll();
    // Migration : les anciens statuts d’attente et d’équilibre deviennent « Non pris » pour ne garder que 3 statuts.
    for(const r of records){if(r.status==='pending'||r.status==='flat'||!r.status){r.status='not_taken';r.outcome={status:'not_taken',label:'Non pris',exitPrice:null,points:null,r:null};await put(r);}}
    const all=records.sort((a,b)=>b.createdAt-a.createdAt), done=all.filter(r=>['win','loss'].includes(r.status)&&Number.isFinite(r.outcome?.r));
    const wins=all.filter(r=>r.status==='win').length, losses=all.filter(r=>r.status==='loss').length;
    const netR=done.reduce((s,r)=>s+r.outcome.r,0), points=done.reduce((s,r)=>s+r.outcome.points,0), taken=wins+losses;
    const noTrade=all.filter(r=>String(r.data?.verdict||'').toUpperCase()==='NO_TRADE').length;
    const executable=all.filter(r=>['BUY','SELL'].includes(String(r.data?.verdict||'').toUpperCase())).length;
    const currentWeek=weekKey(Date.now()), week=done.filter(r=>weekKey(r.createdAt)===currentWeek), weekWins=week.filter(r=>r.status==='win').length, weekR=week.reduce((s,r)=>s+r.outcome.r,0);
    const weekSetups=all.filter(r=>weekKey(r.createdAt)===currentWeek).length;
    const stats=$('journalStats');stats.replaceChildren();
    [['Total des analyses',all.length],['NO_TRADE',noTrade],['BUY / SELL proposés',executable],['Gagnants',wins],['Perdants',losses],['Non pris',all.filter(r=>r.status==='not_taken').length],['Réussite',taken?Math.round(wins/taken*100)+' %':'—'],['Résultat net',`${netR>=0?'+':''}${fmt(netR)} R`],['Points nets',`${points>=0?'+':''}${fmt(points)}`],['Cette semaine',`${weekSetups} signaux · ${week.length} clôturés · ${weekR>=0?'+':''}${fmt(weekR)} R`]].forEach(([label,value])=>{const el=document.createElement('div');el.className='js-stat';addText(el,'span',label);const strong=addText(el,'strong',value);if(label==='Résultat net'||label==='Cette semaine')strong.classList.add((label==='Cette semaine'?weekR:netR)>=0?'js-positive':'js-negative');stats.appendChild(el)});
    const list=$('hl');
    if(!all.length){
      // Ne pas effacer l'ancien historique court (localStorage) si aucune analyse complète n'existe encore.
      const legacy=(()=>{try{return JSON.parse(localStorage.getItem('hist')||'[]')}catch(_){return []}})();
      if(!legacy.length){list.replaceChildren();addText(list,'p','Aucune analyse sauvegardée pour le moment.','note');$('hp').classList.add('hide')}
      else $('hp').classList.remove('hide');
      return;
    }
    $('hp').classList.remove('hide');
    list.replaceChildren();
    let lastWeek='';
    all.forEach(rec=>{
      const wk=weekKey(rec.createdAt);if(wk!==lastWeek){addText(list,'h3','Semaine du '+wk,'js-week');lastWeek=wk;}
      const d=rec.data||{},lv=levels(d),card=document.createElement('article');card.className='js-record';
      const head=document.createElement('div');head.className='js-head';const left=document.createElement('div');addText(left,'strong',`${rec.asset} · ${d.verdict||'—'}`);addText(left,'div',`${rec.time} · ${d.action||'—'} · ${rec.outcome?.label||'Non pris'}`,'js-meta');head.appendChild(left);head.appendChild(button('Ouvrir','js-open',()=>openDetail(rec)));card.appendChild(head);
      addText(card,'p',lv?`Entrée ${lv.entry} · SL ${lv.sl} · TP ${lv.tp} · RR ${fmt(lv.reward/lv.risk)}`:'Pas de niveaux BUY/SELL cohérents pour calculer le résultat.','js-meta');
      const actions=document.createElement('div');actions.className='js-actions';
      [['Non pris','not_taken'],['Gagnant','win'],['Perdant','loss']].forEach(([label,status])=>{
        const b=button(label,'js-secondary',async()=>{
          const noTrade=String(d.verdict||'').toUpperCase()==='NO_TRADE';
          if(status!=='not_taken'&&!lv&&!noTrade){alert('Ce signal ne contient pas de niveaux BUY/SELL cohérents.');return;}
          if(status!=='not_taken'&&!confirm(noTrade
            ? (lv ? `Confirmer « ${label} » pour cette opportunité NO_TRADE ? Les points et le RR seront calculés théoriquement à partir de l’entrée, du SL et du TP enregistrés.`
                 : `Confirmer « ${label} » pour cette opportunité NO_TRADE ? Elle sera comptée comme résultat manuel, sans points ni RR car les niveaux ne permettent pas de calcul fiable.`)
            : `Confirmer « ${label} » ? Le calcul utilise le ${status==='win'?'TP':'SL'} enregistré. Ce résultat est théorique, sauf si tu saisis une sortie réelle.`))return;
          try{await setStatus(rec.id,status)}catch(e){console.error(e);alert('Enregistrement impossible.');}
        });if(rec.status===status)b.classList.add('js-active');if(status!=='not_taken'&&!lv&&String(d.verdict||'').toUpperCase()!=='NO_TRADE')b.disabled=true;actions.appendChild(b);
      });card.appendChild(actions);
      if(rec.outcome&&['win','loss'].includes(rec.status))addText(card,'p',`Résultat : ${rec.outcome.r>=0?'+':''}${fmt(rec.outcome.r)} R · ${rec.outcome.points>=0?'+':''}${fmt(rec.outcome.points)} points. ${rec.outcome.label}.`,'js-meta');
      list.appendChild(card);
    });
  }
  window.renderHist=function(){try{originalRenderHist()}catch(e){console.warn('[Scalp Journal] Ancien rendu:',e)}render().catch(e=>{console.error('[Scalp Journal] Rendu impossible:',e);warnStorage()});};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',()=>render().catch(e=>{console.error(e);warnStorage()}),{once:true});
  else render().catch(e=>{console.error(e);warnStorage()});
})();
