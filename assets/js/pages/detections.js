/* Detections hub — page module (assets/js/pages/detections.js).
 * Owner: wave-2 M10 detections agent
 * Absorbs legacy pages: incidents, fire, ppe, intr, behaviour, cleaning, forklift
 *
 * Contract (docs/plan/SPA_ARCHITECTURE.md):
 *   subs[k].legacy  → rendered by the dc template section for that legacy page
 *                     (app.applyPage(legacy) + this.enter(app, legacy) loaders).
 *   subs[k] without legacy → mount(el, route, app) renders into the page host.
 *   onFeed(data, app, route) runs on every 5 s feed.php poll while this hub is active.
 *   methods: class body mixed into the dc Component (this === app) — moved
 *            verbatim from app.js; wave 2 replaces them as the page is redesigned.
 *
 * M10 visual-first layer ("lead mount"):
 *   Every sub keeps `legacy` so state.page, the per-page loaders (enter), the
 *   feed ?report= param, the Highcharts module dashboards and every legacy
 *   feature (area rules, reviews, exports, schedules) keep working unchanged.
 *   On top of that, LEAD[sub] renders a visual-first lead into a module-owned
 *   container (#kjd-lead) placed in .c73 right after #kj-page-host, above the
 *   legacy section:
 *     incidents (overview) → filter bar · KPI tiles · type × hour timeline ·
 *                            proof-image gallery wall (table view secondary) ·
 *                            the legacy SLA register stays below as drill-down
 *     ppe / forklift / fire / restricted / cleaning / behaviour →
 *                            KPI tiles · trend + breakdown charts · event cards
 *                            with WebP proof thumbnails; legacy charts/rules below
 *   Everything clickable → KJModal ('event' is re-registered here with the big
 *   proof image, person, camera → camera modal, first→last timeline, severity,
 *   ack/resolve via app.js triage, and the auto-ticket badge from the M9
 *   pipeline (GET /api/tickets?category=ppe_forklift, matched client-side for list badges; the
 *   detail modal falls back to server-side ?event_id= / ?person_id= filters on a cache miss).
 *   Styles: assets/css/pages/detections.css (injected below; no dc.html edit).
 */
(function () {
  'use strict';

  /* ── assets: stylesheet injected next to this script (cache-busted with its ?v=) ── */
  var ASSET = (function () {
    var s = (document.currentScript && document.currentScript.src) || '';
    var m = /^(.*\/)js\/pages\/detections\.js(\?[^#]*)?/.exec(s);
    return { base: m ? m[1] : 'assets/', q: (m && m[2]) || '' };
  })();
  (function injectCss() {
    if (document.getElementById('kjd-css')) return;
    var l = document.createElement('link');
    l.id = 'kjd-css'; l.rel = 'stylesheet'; l.href = ASSET.base + 'css/pages/detections.css' + ASSET.q;
    (document.head || document.documentElement).appendChild(l);
  })();

  window.KJPages.register('detections', {
    title: 'Detections',
    perm: 'view',
    defaultSub: 'incidents',
    subs: {
      incidents: { label: 'All detections', legacy: 'incidents' },
      ppe:       { label: 'PPE',            legacy: 'ppe' },
      restricted:{ label: 'Restricted area', legacy: 'intr' },
      forklift:  { label: 'Forklift',       legacy: 'forklift' },
      cleaning:  { label: 'Cleaning',       legacy: 'cleaning' },
      behaviour: { label: 'Behaviour',      legacy: 'behaviour' },
      fire:      { label: 'Fire & smoke',   legacy: 'fire' }
    },

    enter: function (app, page) {
      if (app.state.demo && (page === 'fire' || page === 'ppe' || page === 'intr')) { app.setState({ report: app.demoReport(page) }); }
      else if (page === 'fire' || page === 'ppe' || page === 'intr') { app._reportJson = null; app.fetchFeed(); }  // pull that module's report now
      if (page === 'fire' || page === 'ppe' || page === 'intr') app.scheduleCharts();
      if (page === 'forklift') { app.loadFk(); app.loadApp(); }
      if (page === 'ppe') { app.loadApp(); app.loadPpe(); }          // area rules + violation history
      if (page === 'intr') { app.loadRa(); }                         // restricted zones + entry review
      if (page === 'cleaning') { app.loadCl(); }                     // cleaning schedules + PPE during cleaning
      if (page === 'behaviour') { app.loadBeh(); }                   // Workstream C: Line 5 behaviour analytics
    },

    // Feed tick: the lead layer's watcher diffs app.state slices itself; this only
    // flags a repaint so a fresh poll shows up immediately (cheap, idempotent).
    onFeed: function () { Lead.dirty = true; },

    // ── Legacy Component methods (verbatim from app.js; `this` is the dc app) ──
    methods: class {
  setIncFilter(f){ this.setState({incFilter:f, incPage:0}); }
  setIncSev(s){ this.setState({incSev:s, incPage:0}); }
  selectInc(id){ this.setState({incSel:id}); }
  // ── Incident tickets ──────────────────────────────────────
  setIncEl(v){ this.setState({incEl:v, incPage:0}); }
  setIncCam(v){ this.setState({incCam:v, incPage:0}); }
  repIncidents(period){
    this.setState({tktMsg:'Sending '+period+' report…'});
    fetch(`${this.API}/report/incidents?token=${this.TOK}&period=${period}`, {cache:'no-store'}).then(r=>r.json())
      .then(d=>{ this.setState({tktMsg:(d&&d.ok)?(period+' incident report sent ✓'):'Report failed — check SMTP'});
        if(this._tkT) clearTimeout(this._tkT); this._tkT=setTimeout(()=>this.setState({tktMsg:''}), 3000); })
      .catch(()=>this.setState({tktMsg:'Report failed'}));
  }
  // Fire / PPE / Intrusion dashboards — same chart language as Face & Body.
  drawModCharts(){
    const p=this.state.page, r=this.state.report;
    if(!(p==='fire'||p==='ppe'||p==='intr') || !window.Highcharts || !r) return;
    const {dark, muted, base}=this.hcBase();
    const text2=(getComputedStyle(document.querySelector('[data-theme]')||document.documentElement).getPropertyValue('--text2')||'').trim()||'#9AA1BD';
    const MOD = {fire:dark?'#FF8A3D':'#E77320', ppe:dark?'#FDBF57':'#D89A16', intr:dark?'#FF4D4D':'#E23434'}[p];
    const SEVCOL={Low:dark?'#4DA6FF':'#2E7FD6', Medium:dark?'#FDBF57':'#D89A16', High:dark?'#FF8A3D':'#E77320', Severe:dark?'#FF4D4D':'#E23434'};
    this._hc=this._hc||{};
    const mk=(id,cfg)=>{ const el=document.getElementById(id); if(!el) return;
      if(this._hc[id]){ try{ this._hc[id].destroy(); }catch(e){} }
      this._hc[id]=Highcharts.chart(el, Highcharts.merge({}, base, cfg)); };
    const hrs=[...Array(24)].map((_,i)=>{ const h=new Date(Date.now()-(23-i)*3600e3).getHours(); return String(h).padStart(2,'0')+':00'; });
    mk('mdTrend',{chart:{type:'areaspline', height:215}, xAxis:{categories:hrs, tickInterval:3},
      plotOptions:{areaspline:{marker:{enabled:false}, lineWidth:2, fillOpacity:0.18, color:MOD}},
      series:[{name:'Detections', data:r.hourly||[]}]});
    const sev=r.bySeverity||{}; const sevCats=['Low','Medium','High','Severe'];
    mk('mdSev',{chart:{type:'column', height:215}, xAxis:{categories:sevCats},
      plotOptions:{column:{borderWidth:0, borderRadius:4, pointPadding:0.1, groupPadding:0.12, colorByPoint:true,
        dataLabels:{enabled:true, style:{color:text2, textOutline:'none'}}}},
      colors:sevCats.map(s=>SEVCOL[s]),
      series:[{name:'Detections', data:sevCats.map(s=>sev[s]||0)}]});
    const bc=Object.entries(r.byCam||{}).sort((a,b)=>b[1]-a[1]).slice(0,8);
    mk('mdCams',{chart:{type:'bar', height:215}, xAxis:{categories:bc.map(x=>x[0])},
      plotOptions:{bar:{borderWidth:0, borderRadius:4, color:MOD, dataLabels:{enabled:true, style:{color:text2, textOutline:'none'}}}},
      series:[{name:'Detections', data:bc.map(x=>x[1])}]});
    // Module-specific breakdown (4th chart).
    const attr=r.attr||{};
    if(p==='fire'){
      const sm=attr.Smoking||{}; const d=Object.entries(sm).map(([name,y])=>({name,y}));
      mk('mdAttr',{chart:{type:'pie', height:215},
        tooltip:{pointFormat:'<b>{point.y}</b> ({point.percentage:.0f}%)'},
        plotOptions:{pie:{innerSize:'58%', borderColor:dark?'#0E1122':'#fff', borderWidth:2,
          dataLabels:{enabled:true, format:'{point.name}: {point.y}', style:{color:text2, textOutline:'none', fontSize:'11px'}}}},
        colors:[dark?'#FF4D4D':'#E23434', dark?'#33C08A':'#199468', muted],
        series:[{name:'Smoking', data:d.length?d:[{name:'None',y:0}]}]});
    } else if(p==='ppe'){
      const vest=attr.WithReflectiveVest||{}, hat=attr.HatsType||{}, mask=attr.WithMask||{};
      const wearing=(vest.ReflectiveVest||0), noVest=(vest.NoReflectiveVest||0);
      const noHat=(hat.NoHat||0), hasHat=Object.entries(hat).reduce((s,[k,v])=>s+(k==='NoHat'?0:v),0);
      const masked=(mask.WithMask||0), noMask=(mask.NoMask||0);
      mk('mdAttr',{chart:{type:'column', height:215}, xAxis:{categories:['Vest','Helmet/Hat','Mask']},
        plotOptions:{column:{borderWidth:0, borderRadius:3, stacking:'normal',
          dataLabels:{enabled:true, style:{color:text2, textOutline:'none', fontSize:'10px'}}}},
        legend:{enabled:true, itemStyle:{color:text2, fontSize:'10px'}},
        colors:[dark?'#33C08A':'#199468', dark?'#FF4D4D':'#E23434'],
        series:[{name:'Compliant', data:[wearing, hasHat, masked]},{name:'Non-compliant', data:[noVest, noHat, noMask]}]});
    } else {
      const g=attr.Gender||{}, ang=attr.Angle||{};
      const cats=Object.keys(g).length?Object.keys(g):Object.keys(ang);
      const vals=Object.keys(g).length?Object.values(g):Object.values(ang);
      mk('mdAttr',{chart:{type:'column', height:215}, xAxis:{categories:cats},
        plotOptions:{column:{borderWidth:0, borderRadius:4, color:MOD, pointPadding:0.12,
          dataLabels:{enabled:true, style:{color:text2, textOutline:'none'}}}},
        series:[{name:'Intruders', data:vals}]});
    }
  }
  // ── Cleaning activity monitoring (/api/cleaning/*) ─────────
  loadCl(){
    const f=this.state.clF;
    const qs=new URLSearchParams({token:this.TOK, from:f.from||'', to:f.to||'', plant:f.plant||'', location:f.location||'', item:f.item||''});
    this.setState(st=>({clF:{...st.clF, busy:true, err:''}}));
    fetch(`${this.API}/cleaning/summary?${qs}`, {cache:'no-store'})
      .then(x=>x.json())
      .then(d=>{ if(!(d&&d.ok)) throw new Error('bad'); this.setState(st=>({clD:d, clF:{...st.clF, busy:false}})); })
      .catch(()=>this.setState(st=>({clF:{...st.clF, busy:false, err:'Could not load cleaning data'}})));
  }
  setClF(patch){ this.setState(st=>({clF:{...st.clF, ...patch}})); if(this._clT) clearTimeout(this._clT); this._clT=setTimeout(()=>this.loadCl(), 0); }
  exportCl(report){
    const f=this.state.clF, d=this.state.clD||{};
    const qs=new URLSearchParams({token:this.TOK, report, from:f.from||d.from||'', to:f.to||d.to||'', plant:f.plant||'', location:f.location||'', item:f.item||''});
    window.open(`${this.API}/cleaning/export?${qs}`, '_blank');
  }
  // Supervisor confirmation that a scheduled session was actually performed.
  confirmCl(sess, status){
    const note=window.prompt((status==='done'?'Confirm cleaning was done':'Record cleaning NOT performed')+' — '+sess.name+' · '+sess.date+'\n\nOptional note:', '');
    if(note===null) return;
    this.setState({clMsg:'Saving…'});
    fetch(`${this.API}/cleaning/confirm`, {method:'POST', headers:{'Content-Type':'application/json'}, credentials:'same-origin',
      body:JSON.stringify({schedule_id:sess.scheduleId, date:sess.date, status, note})})
      .then(x=>x.json())
      .then(d=>{ if(!(d&&d.ok)) throw new Error((d&&d.error)||'Save failed');
        this.setState({clMsg:status==='done'?'Session confirmed as cleaned ✓':'Recorded as not performed ✓'}); this.loadCl(); })
      .catch(e=>this.setState({clMsg:'✗ '+(e&&e.message||'Save failed')}));
  }
  // Schedule editor: a local draft of the whole list, saved through /api/settings.
  clSched(){ return this.state.clDraft || ((this.state.clD&&this.state.clD.schedules)||[]).map(s=>({...s, dates:(s.dates||[]).join(', ')})); }
  clSet(i, patch){ const l=this.clSched().map(x=>({...x})); l[i]={...l[i], ...patch}; this.setState({clDraft:l, clMsg:''}); }
  clAdd(){ const l=this.clSched().map(x=>({...x}));
    l.push({id:'clean'+Date.now().toString(36), name:'Cleaning', location:'', start:'14:00', end:'15:00', days:[1,2,3,4,5], dates:'', items:['gloves'], enabled:true});
    this.setState({clDraft:l, clMsg:''}); }
  clRemove(i){ const l=this.clSched().filter((_,j)=>j!==i); this.setState({clDraft:l, clMsg:''}); }
  clSave(){
    const l=this.clSched();
    const bad=l.find(s=>!s.location||!/^\d{2}:\d{2}$/.test(s.start||'')||!/^\d{2}:\d{2}$/.test(s.end||'')||(!(s.days||[]).length&&!String(s.dates||'').trim()));
    if(bad){ this.setState({clMsg:'✗ "'+(bad.name||'Cleaning')+'" needs an area, start / end time and days or dates'}); return; }
    const out=l.map(s=>({...s, dates:String(s.dates||'').split(',').map(x=>x.trim()).filter(Boolean)}));
    this.setState({clMsg:'Saving schedules…'});
    fetch(`${this.API}/settings?token=${this.TOK}`, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({cleaning_schedules:out})})
      .then(x=>x.json())
      .then(d=>{ if(!(d&&d.ok)) throw new Error('bad'); this.setState({clDraft:null, clMsg:'Schedules saved ✓'}); this.loadCl(); })
      .catch(()=>this.setState({clMsg:'✗ Save failed'}));
  }
  // ── Restricted area monitoring (/api/restricted/*) ─────────
  loadRa(){
    const f=this.state.raF;
    const qs=new URLSearchParams({token:this.TOK, from:f.from||'', to:f.to||'', plant:f.plant||'', camera:f.camera||'', verdict:f.verdict||'', status:f.status||''});
    this.setState(st=>({raF:{...st.raF, busy:true, err:''}}));
    fetch(`${this.API}/restricted/summary?${qs}`, {cache:'no-store'})
      .then(x=>x.json())
      .then(d=>{ if(!(d&&d.ok)) throw new Error('bad'); this.setState(st=>({raD:d, raF:{...st.raF, busy:false}})); })
      .catch(()=>this.setState(st=>({raF:{...st.raF, busy:false, err:'Could not load restricted-area data'}})));
  }
  setRaF(patch){ this.setState(st=>({raF:{...st.raF, ...patch}})); if(this._raT) clearTimeout(this._raT); this._raT=setTimeout(()=>this.loadRa(), 0); }
  exportRa(report){
    const f=this.state.raF, d=this.state.raD||{};
    const qs=new URLSearchParams({token:this.TOK, report, from:f.from||d.from||'', to:f.to||d.to||'', plant:f.plant||'', camera:f.camera||'', verdict:f.verdict||'', status:f.status||''});
    window.open(`${this.API}/restricted/export?${qs}`, '_blank');
  }
  // Reviewer decision on an entry: confirm the violation or clear it as authorized.
  reviewRa(item, verdict){
    const note=window.prompt((verdict==='violation'?'Confirm unauthorized entry':'Clear as authorized')+' — '+(item.zone||'zone')+'\n\nOptional note (who it was, why):', '');
    if(note===null) return;
    this.setState({raMsg:'Saving review…'});
    fetch(`${this.API}/restricted/review`, {method:'POST', headers:{'Content-Type':'application/json'}, credentials:'same-origin',
      body:JSON.stringify({id:item.id, verdict, note})})
      .then(x=>x.json())
      .then(d=>{ if(!(d&&d.ok)) throw new Error((d&&d.error)||'Review failed');
        this.setState({raMsg:verdict==='violation'?'Confirmed as unauthorized entry ✓':'Cleared as authorized ✓'});
        this.loadRa(); this.fetchFeed(); })
      .catch(e=>this.setState({raMsg:'✗ '+(e&&e.message||'Review failed')}));
  }
  // Settings → Restricted Zones: save one camera's zone (merged over the stored set).
  saveRaZone(key, patch){
    const all={...(((this.state.appCfg||{}).ra_zones)||{})};
    const cur=all[key]||{enabled:false, name:'', hours:'always', staff:[], depts:[]};
    all[key]={...cur, ...patch};
    this.saveApp({ra_zones:all}, 'Restricted zone saved ✓');
    this.setState(st=>{ const d={...st.raDraft}; delete d[key]; return {raDraft:d}; });
  }
  raDraftSet(key, k, v){ this.setState(st=>({raDraft:{...st.raDraft, [key]:{...(st.raDraft[key]||{}), [k]:v}}})); }
  // ── Forklift monitoring (/api/forklift/*) ─────────────────
  loadFk(){
    const f=this.state.fkF;
    const qs=new URLSearchParams({token:this.TOK, from:f.from||'', to:f.to||'', plant:f.plant||'', camera:f.camera||'', verdict:f.verdict||'', status:f.status||'', kind:f.kind||''});
    this.setState(st=>({fkF:{...st.fkF, busy:true, err:''}}));
    fetch(`${this.API}/forklift/summary?${qs}`, {cache:'no-store'})
      .then(x=>x.json())
      .then(d=>{ if(!(d&&d.ok)) throw new Error('bad'); this.setState(st=>({fkD:d, fkF:{...st.fkF, busy:false}})); })
      .catch(()=>this.setState(st=>({fkF:{...st.fkF, busy:false, err:'Could not load forklift data'}})));
  }
  setFkF(patch){ this.setState(st=>({fkF:{...st.fkF, ...patch}})); if(this._fkT) clearTimeout(this._fkT); this._fkT=setTimeout(()=>this.loadFk(), 0); }
  exportFk(report){
    const f=this.state.fkF, d=this.state.fkD||{};
    const qs=new URLSearchParams({token:this.TOK, report, from:f.from||d.from||'', to:f.to||d.to||'', plant:f.plant||'', camera:f.camera||'', verdict:f.verdict||'', status:f.status||'', kind:f.kind||''});
    window.open(`${this.API}/forklift/export?${qs}`, '_blank');
  }
  // Reviewer decision on a forklift event: confirm it as a zone violation or clear it as a false alarm.
  reviewFk(item, verdict){
    const note=window.prompt((verdict==='violation'?'Confirm forklift zone violation':'Clear as false alarm')+' — '+(item.zone||item.camera||'zone')+'\n\nOptional note:', '');
    if(note===null) return;
    this.setState({fkMsg:'Saving review…'});
    fetch(`${this.API}/forklift/review`, {method:'POST', headers:{'Content-Type':'application/json'}, credentials:'same-origin',
      body:JSON.stringify({id:item.id, verdict, note})})
      .then(x=>x.json())
      .then(d=>{ if(!(d&&d.ok)) throw new Error((d&&d.error)||'Review failed');
        this.setState({fkMsg:verdict==='violation'?'Confirmed as zone violation ✓':'Cleared as false alarm ✓'});
        this.loadFk(); this.fetchFeed(); })
      .catch(e=>this.setState({fkMsg:'✗ '+(e&&e.message||'Review failed')}));
  }
  // Settings → Forklift Zones: save one camera's zone (merged over the stored set).
  saveFkZone(key, patch){
    const all={...(((this.state.appCfg||{}).fk_zones)||{})};
    const cur=all[key]||{enabled:false, name:'', rule:'prohibited', hours:'always', note:''};
    all[key]={...cur, ...patch};
    this.saveApp({fk_zones:all}, 'Forklift zone saved ✓');
    this.setState(st=>{ const d={...st.fkDraft}; delete d[key]; return {fkDraft:d}; });
  }
  fkDraftSet(key, k, v){ this.setState(st=>({fkDraft:{...st.fkDraft, [key]:{...(st.fkDraft[key]||{}), [k]:v}}})); }
  // ── Workstream C: Behaviour analytics (/api/behaviour/*) ────
  loadBeh(){
    const f=this.state.behF;
    const qs=new URLSearchParams({token:this.TOK, from:f.from||'', to:f.to||'', day:f.day||'', camera:f.camera||'', kind:f.kind||'', verdict:f.verdict||''});
    this.setState(st=>({behF:{...st.behF, busy:true, err:''}}));
    fetch(`${this.API}/behaviour/summary?${qs}`, {cache:'no-store'})
      .then(x=>x.json())
      .then(d=>{ if(!(d&&d.ok)) throw new Error('bad'); this.setState(st=>({behD:d, behF:{...st.behF, busy:false}})); })
      .catch(()=>this.setState(st=>({behF:{...st.behF, busy:false, err:'Could not load behaviour analytics'}})));
  }
  setBehF(patch){ this.setState(st=>({behF:{...st.behF, ...patch}})); if(this._behT) clearTimeout(this._behT); this._behT=setTimeout(()=>this.loadBeh(), 0); }
  // Trend range shortcut: last N days ending today.
  setBehRange(days){ const d=new Date(), p=(n)=>String(n).padStart(2,'0'), iso=(x)=>x.getFullYear()+'-'+p(x.getMonth()+1)+'-'+p(x.getDate());
    const from=new Date(d.getTime()-(days-1)*86400000); this.setBehF({from:iso(from), to:iso(d), day:''}); }
  exportBeh(report){
    const f=this.state.behF, d=this.state.behD||{};
    const qs=new URLSearchParams({token:this.TOK, report, from:f.from||d.from||'', to:f.to||d.to||'', camera:f.camera||'', kind:f.kind||'', verdict:f.verdict||''});
    window.open(`${this.API}/behaviour/export?${qs}`, '_blank');
  }
  reviewBeh(item, verdict){
    const note=window.prompt((verdict==='confirmed'?'Confirm behaviour event':'Clear as false alarm')+' — '+(item.reason||item.camera||'')+'\n\nOptional note:', '');
    if(note===null) return;
    this.setState({behMsg:'Saving review…'});
    fetch(`${this.API}/behaviour/review`, {method:'POST', headers:{'Content-Type':'application/json'}, credentials:'same-origin',
      body:JSON.stringify({id:item.id, verdict, note})})
      .then(x=>x.json())
      .then(d=>{ if(!(d&&d.ok)) throw new Error((d&&d.error)||'Review failed');
        this.setState({behMsg:verdict==='confirmed'?'Confirmed ✓':'Cleared as false alarm ✓'}); this.loadBeh(); this.fetchFeed(); })
      .catch(e=>this.setState({behMsg:'✗ '+(e&&e.message||'Review failed')}));
  }
  rescanBeh(){
    this.setState({behMsg:'Re-scanning the last 7 days with the current thresholds…', appMsg:'Re-scanning…'});
    fetch(`${this.API}/behaviour/rescan`, {method:'POST', headers:{'Content-Type':'application/json'}, credentials:'same-origin', body:JSON.stringify({days:7})})
      .then(x=>x.json())
      .then(d=>{ if(!(d&&d.ok)) throw new Error((d&&d.error)||'Re-scan failed');
        const m='Re-scan done — '+(d.created||0)+' derived event(s) ✓'; this.setState({behMsg:m, appMsg:m}); if(this.state.page==='behaviour') this.loadBeh(); })
      .catch(e=>this.setState({behMsg:'✗ '+(e&&e.message||'Re-scan failed'), appMsg:'✗ '+(e&&e.message||'Re-scan failed')}));
  }
  // Settings → Behaviour Rules: local draft over the stored settings, saved through /api/settings.
  behCfg(){ const s=((this.state.appCfg||{}).behaviour)||{}; return {enabled:true, cameras:[], locations:['Line 5'], group_min:2, dwell_min:3, idle_min:10, gap_sec:120, clean_items:['gloves','goggles'], ...s, ...(this.state.behDraft||{})}; }
  behSet(patch){ this.setState(st=>({behDraft:{...(st.behDraft||{}), ...patch}})); }
  behSave(){ const c=this.behCfg();
    this.saveApp({beh_enabled:!!c.enabled, beh_cameras:c.cameras, beh_locations:c.locations, beh_group_min:c.group_min, beh_dwell_min:c.dwell_min,
      beh_idle_min:c.idle_min, beh_gap_sec:c.gap_sec, beh_clean_items:c.clean_items}, 'Behaviour rules saved ✓');
    this.setState({behDraft:null}); }
  // ── PPE compliance by area (/api/ppe/summary) ─────────────
  loadPpe(){
    const f=this.state.ppeF;
    const qs=new URLSearchParams({token:this.TOK, from:f.from||'', to:f.to||'', plant:f.plant||'', location:f.location||'', camera:f.camera||'', item:f.item||''});
    this.setState(st=>({ppeF:{...st.ppeF, busy:true, err:''}}));
    fetch(`${this.API}/ppe/summary?${qs}`, {cache:'no-store'})
      .then(x=>x.json())
      .then(d=>{ if(!(d&&d.ok)) throw new Error('bad'); this.setState(st=>({ppeD:d, ppeF:{...st.ppeF, busy:false}})); })
      .catch(()=>this.setState(st=>({ppeF:{...st.ppeF, busy:false, err:'Could not load PPE compliance'}})));
  }
  setPpeF(patch){ this.setState(st=>({ppeF:{...st.ppeF, ...patch}})); if(this._ppeT) clearTimeout(this._ppeT); this._ppeT=setTimeout(()=>this.loadPpe(), 0); }
  exportPpe(report){
    const f=this.state.ppeF, d=this.state.ppeD||{};
    const qs=new URLSearchParams({token:this.TOK, report, from:f.from||d.from||'', to:f.to||d.to||'', plant:f.plant||'', location:f.location||'', camera:f.camera||'', item:f.item||''});
    window.open(`${this.API}/ppe/export?${qs}`, '_blank');
  }
  // Settings → PPE Area Rules: toggle one item for one location (saves immediately).
  togglePpeRule(loc, item){
    const cur={...(((this.state.appCfg||{}).ppe_rules)||{})};
    const items=(cur[loc]||[]).slice(); const i=items.indexOf(item);
    if(i>=0) items.splice(i,1); else items.push(item);
    if(items.length) cur[loc]=items; else delete cur[loc];
    this.saveApp({ppe_rules:cur}, items.length?('PPE rule saved for '+loc+' ✓'):('PPE rule removed for '+loc));
  }
  // Workstream B: HatsType values counted as "hair covered" by the hair-net proxy.
  togglePpeHairHat(v){
    const cur=((this.state.appCfg||{}).ppe_hair_hats||['Bonnet']).slice(); const i=cur.indexOf(v);
    if(i>=0) cur.splice(i,1); else cur.push(v);
    this.saveApp({ppe_hair_hats:cur.length?cur:['Bonnet']}, 'Hair-net proxy saved ✓');
  }
  // Workstream B: forklift operator PPE per zone, and the operator correlation window.
  toggleFkOpPpe(key, item){
    const z=(((this.state.appCfg||{}).fk_zones)||{})[key]||{};
    const cur=(Array.isArray(z.op_ppe)?z.op_ppe:['helmet','vest']).slice(); const i=cur.indexOf(item);
    if(i>=0) cur.splice(i,1); else cur.push(item);
    this.saveFkZone(key, {op_ppe:cur});
  }
  setFkOpWindow(s){ this.saveApp({fk_operator_window:s}, 'Operator window set to ±'+s+' s ✓'); }
    }
  });

  /* ======================================================================
   * M10 lead layer — shared helpers
   * ==================================================================== */
  var ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function esc(v) { return v == null ? '' : String(v).replace(/[&<>"']/g, function (c) { return ESC_MAP[c]; }); }
  function ico(name, cls) { return (window.KJIcon && window.KJIcon.svg) ? window.KJIcon.svg(name, cls) : ''; }
  function N(v) { return Number(v) || 0; }
  function fmtN(v) { return N(v).toLocaleString('en-US'); }
  function pad(n) { return String(n).padStart(2, '0'); }
  function ymd(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function today() { return ymd(new Date()); }
  function toMs(v) {
    if (v == null || v === '') return 0;
    if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
    var s = String(v);
    if (/^\d{10,13}$/.test(s)) return s.length === 10 ? N(s) * 1000 : N(s);
    var d = new Date(s.replace(' ', 'T').replace(/\.\d+$/, ''));
    return isNaN(d) ? 0 : d.getTime();
  }
  function hm(ms) { if (!ms) return '—'; var d = new Date(ms); return pad(d.getHours()) + ':' + pad(d.getMinutes()); }
  function hms(ms) { if (!ms) return '—'; var d = new Date(ms); return hm(ms) + ':' + pad(d.getSeconds()); }
  function when(ms) {
    if (!ms) return '—';
    var d = new Date(ms);
    return ymd(d) === today() ? 'Today ' + hms(ms) : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) + ' ' + hms(ms);
  }
  function ago(ms) {
    if (!ms) return '';
    var m = Math.round((Date.now() - ms) / 60000);
    if (m < 1) return 'just now'; if (m < 60) return m + ' min ago';
    var h = Math.round(m / 60); if (h < 24) return h + ' h ago';
    return Math.round(h / 24) + ' d ago';
  }
  function dur(ms) {
    if (!(ms > 0)) return '<1 min';
    var m = Math.round(ms / 60000); if (m < 1) return '<1 min'; if (m < 60) return m + ' min';
    var h = Math.floor(m / 60); return h + ' h ' + pad(m % 60) + ' min';
  }
  function step5(p) { return Math.max(0, Math.min(100, Math.round(N(p) / 5) * 5)); }
  function up(v) { return String(v || '').trim().toUpperCase(); }
  function spec(type, id) { return type + ':' + encodeURIComponent(String(id == null ? '' : id)); }
  function seedAttr(o) { return o ? " data-kj-seed='" + esc(JSON.stringify(o)) + "'" : ''; }
  function appRef() { return window.KJApp || (window.KJPages && window.KJPages.app && window.KJPages.app()) || null; }
  function st() { var a = appRef(); return (a && a.state) || {}; }
  function can(p) { return !window.KJPages || window.KJPages.can(p); }
  function toast(msg, tone) { if (window.KJModal && window.KJModal.toast) window.KJModal.toast(msg, tone); }
  function isWebp(u) { return /\.webp(\?|#|$)/i.test(String(u || '')); }

  /* Quiet same-origin API helper (null on any failure — no console noise). */
  function api(path, params) {
    var base = (window.TMNS && window.TMNS.api) || '/api';
    var q = new URLSearchParams(params || {});
    var tok = (window.TMNS && window.TMNS.token) || '';
    if (tok) q.set('token', tok);
    try {
      return fetch(base + path + '?' + q, { cache: 'no-store', credentials: 'same-origin' })
        .then(function (r) { return r.json(); })
        .then(function (d) { return d && d.ok !== false ? d : null; })
        .catch(function () { return null; });
    } catch (e) { return Promise.resolve(null); }
  }

  /* ── domain ──────────────────────────────────────────────────────────── */
  // mod → [label, lucide icon, tone, hub sub]
  var MOD = {
    ppe: ['PPE', 'hard-hat', 'warn', 'ppe'], forklift: ['Forklift', 'forklift', 'orange', 'forklift'],
    intr: ['Restricted area', 'shield-alert', 'danger', 'restricted'], fire: ['Fire & smoke', 'flame', 'danger', 'fire'],
    cleaning: ['Cleaning', 'sparkles', 'success', 'cleaning'], behaviour: ['Behaviour', 'activity', 'purple', 'behaviour'],
    face: ['Face & body', 'scan-face', 'primary', '']
  };
  var MOD_ORDER = ['ppe', 'forklift', 'intr', 'fire', 'cleaning', 'behaviour', 'face'];
  var SEV = { critical: ['Critical', 'danger', 4], high: ['High', 'danger', 3], medium: ['Medium', 'warn', 2], low: ['Low', 'info', 1] };
  var EST = { open: ['Open', 'danger'], ack: ['Acknowledged', 'warn'], resolved: ['Resolved', 'success'], closed: ['Closed', 'success'] };
  function modOf(m) { return MOD[m] || ['Detection', 'radar', 'primary', '']; }
  function sevChip(sev) {
    var s = SEV[sev]; if (!s) return '';
    return '<span class="kj-chip is-' + s[1] + (sev === 'critical' ? ' kjd-sev-crit' : '') + '">' + esc(s[0]) + '</span>';
  }
  function statusChip(status) { var s = EST[status]; return s ? '<span class="kj-chip kj-chip-dot is-' + s[1] + '">' + esc(s[0]) + '</span>' : ''; }
  function camName(cam) {
    var k = up(cam); if (!k) return '';
    var f = (st().fleet || []).find(function (c) { return up(c.stream) === k || up(c.serial) === k || up(c.did) === k; });
    return f && f.name ? f.name : '';
  }

  /* Normalise a feed incident / module row / raw /events record into one shape. */
  function norm(e, extra) {
    if (!e) return null;
    var img = e.images || {};
    var o = {
      id: String(e.uuid || e.id || ''), uuid: e.uuid || (/[a-z]/i.test(String(e.id || '')) ? String(e.id) : ''),
      mod: e.mod || e.feed_kind || '', sev: e.sev || e.severity || '',
      title: e.title || e.verdictLabel || e.type || e.event_type || e.policy_name || 'Detection',
      camera: up(e.camera || e.stream || e.device_serial || ''), device: e.device || e.device_name || '',
      zone: e.zone || e.location || e.policy || e.policy_name || '', ts: toMs(e.ts || e.time || e.trigger_time || e.received_at || e.received || e.start),
      status: e.status || '', image: e.image || img.trigger || null, imageBk: e.imageBk || img.background || null,
      imageMatch: e.imageMatch || img.match || null,
      person: e.person || e.name || e.person_name || e.who || '', personId: String(e.personId || e.person_id || ''),
      ticket: e.ticket || e.ticket_no || null, conf: e.conf || '', finding: '', raw: e
    };
    if (extra) Object.keys(extra).forEach(function (k) { if (extra[k] != null && extra[k] !== '') o[k] = extra[k]; });
    return o;
  }
  /* /api/events rows (other days) carry no mod/sev — approximate DashboardMapper::modOf. */
  function classify(r) {
    var t = String([r.trigger_image_type, r.event_type, r.policy_name, r.policy_desc].join(' ')).toLowerCase();
    var dec = r.decoded || {};
    var mod = /fire|smoke|flame|thermal/.test(t) || dec.Smoking === 'IsSmoking' ? 'fire'
      : dec.BehKind ? 'behaviour'
      : (dec.FkVerdict || /forklift|fork.?lift/.test(t)) ? 'forklift'
      : /roi|intrusion|intrude|crossline|tripwire|perimeter|restricted|breach/.test(t) ? 'intr'
      : /clean/.test(t) ? 'cleaning'
      : /ppe|helmet|vest|hard.?hat|mask|glove/.test(t) ? 'ppe' : 'face';
    var al = String(r.alert_level || '').toLowerCase();
    var sev = r.severity_override || (/crit|4/.test(al) ? 'critical' : /high|3/.test(al) ? 'high' : /med|2/.test(al) ? 'medium' : (mod === 'fire' ? 'high' : 'low'));
    return norm(r, { mod: mod, sev: sev, title: r.policy_name || r.event_type || MOD[mod][0] + ' detection', status: r.status || 'open' });
  }
  function appEvent(id) {
    var s = String(id);
    return (st().events || []).find(function (e) { return String(e.id) === s || String(e.uuid || '') === s; }) || null;
  }

  /* ── M9 pipeline tickets (category ppe_forklift), cached 60 s ─────────── */
  var TK = { at: 0, rows: [], busy: false, ver: 0, p: null };
  function loadTickets(force) {
    if (!can('tickets')) return Promise.resolve(TK.rows);
    if (TK.p && (TK.busy || (!force && Date.now() - TK.at < 60000))) return TK.p;
    TK.busy = true;
    TK.p = api('/tickets', { category: 'ppe_forklift', limit: 200 }).then(function (d) {
      TK.busy = false; TK.at = Date.now();
      var rows = (d && Array.isArray(d.tickets)) ? d.tickets : [];
      if (JSON.stringify(rows.map(function (t) { return t.ticket_no + t.status + t.event_last_at; })) !==
          JSON.stringify(TK.rows.map(function (t) { return t.ticket_no + t.status + t.event_last_at; }))) { TK.rows = rows; TK.ver++; }
      return TK.rows;
    });
    return TK.p;
  }
  /* Which auto-ticket covers this detection: same DB event id, or same person
   * (+camera) inside the ticket's first→last window (pipeline gap = 10 min). */
  function rawIdOf(ev) {
    return ev && ev.raw && /^\d+$/.test(String(ev.raw.id || '')) ? N(ev.raw.id) : (ev && ev.raw && N(ev.raw.eventId)) || 0;
  }
  function ticketFor(ev, rows) {
    rows = rows || TK.rows;
    if (!ev || !rows.length) return null;
    var rawId = rawIdOf(ev);
    return rows.find(function (t) {
      if (rawId && t.event_id && N(t.event_id) === rawId) return true;
      if (!ev.personId || String(t.person_id || '') !== ev.personId) return false;
      if (t.camera && ev.camera && up(t.camera) !== ev.camera) return false;
      var a = toMs(t.event_first_at), b = toMs(t.event_last_at) || a;
      return ev.ts && a && ev.ts >= a - 120000 && ev.ts <= b + 600000;
    }) || null;
  }
  /* Modal path: the cached list only holds the latest 200 pipeline tickets, so on a miss ask the
   * server directly (GET /tickets?event_id= then ?person_id=) and apply the same window match. */
  function ticketForRemote(ev) {
    var hit = ticketFor(ev);
    if (hit || !ev || !can('tickets')) return Promise.resolve(hit);
    var rawId = rawIdOf(ev);
    var byEvent = rawId ? api('/tickets', { event_id: rawId, limit: 5 }) : Promise.resolve(null);
    return byEvent.then(function (d) {
      var t = d && d.tickets && d.tickets[0];
      if (t && N(t.event_id) === rawId) return t;
      if (!ev.personId) return null;
      return api('/tickets', { person_id: ev.personId, category: 'ppe_forklift', limit: 50 }).then(function (d2) {
        return ticketFor(ev, (d2 && d2.tickets) || []);
      });
    }).catch(function () { return null; });
  }
  function ticketBadge(ev) {
    var t = ticketFor(ev);
    if (t) return '<button type="button" class="kjd-tk is-ai" title="Auto-ticket raised by the AI pipeline" data-kj-modal="' + esc(spec('ticket', t.ticket_no)) + '">' + ico('bot') + esc(t.ticket_no) + '</button>';
    if (ev.ticket) return '<button type="button" class="kjd-tk" title="Incident ticket" data-kj-modal="' + esc(spec('ticket', ev.ticket)) + '">' + ico('ticket') + esc(ev.ticket) + '</button>';
    return '';
  }

  /* Detections of the same person (or same camera + type) chained by ≤ 10 min gaps. */
  function episodeOf(ev) {
    var all = (st().events || []).map(function (e) { return norm(e); }).filter(function (e) {
      return e.ts && (ev.personId ? e.personId === ev.personId : (e.camera === ev.camera && e.mod === ev.mod));
    }).sort(function (a, b) { return a.ts - b.ts; });
    if (!all.some(function (e) { return e.id === ev.id; })) {
      all.push(ev);
      all.sort(function (a, b) { return a.ts - b.ts; });
    }
    var i = all.findIndex(function (e) { return e.id === ev.id; }), lo = i, hi = i, GAP = 600000;
    while (lo > 0 && all[lo].ts - all[lo - 1].ts <= GAP) lo--;
    while (hi < all.length - 1 && all[hi + 1].ts - all[hi].ts <= GAP) hi++;
    var items = all.slice(lo, hi + 1);
    return { first: items[0].ts, last: items[items.length - 1].ts, count: items.length, items: items };
  }

  /* ── Lottie (vendored player, lazy) with an icon fallback ─────────────── */
  var lottieP = null;
  function lottieLib() {
    if (window.lottie) return Promise.resolve(window.lottie);
    if (!lottieP) {
      lottieP = new Promise(function (res) {
        var s = document.createElement('script');
        s.src = ASSET.base + 'vendor/lottie/lottie_light.min.js';
        s.async = true;
        s.onload = function () { if (window.lottie) res(window.lottie); };
        (document.head || document.documentElement).appendChild(s);
      });
    }
    return lottieP;
  }
  function lottieBox(name, icon, muted) {
    return '<div class="kjd-lottie' + (muted ? ' is-muted' : '') + '" data-kjd-lottie="' + esc(name) + '"><span class="kjd-lottie-fallback">' + ico(icon) + '</span></div>';
  }
  function hydrateLottie(root, store) {
    var els = Array.prototype.slice.call(root.querySelectorAll('[data-kjd-lottie]:not([data-kjd-on])'));
    if (!els.length) return;
    els.forEach(function (el) { el.setAttribute('data-kjd-on', '1'); });
    lottieLib().then(function (L) {
      els.forEach(function (el) {
        if (!document.contains(el)) return;
        var name = el.getAttribute('data-kjd-lottie');
        var stage = document.createElement('div'); stage.className = 'kjd-lottie-stage'; el.appendChild(stage);
        try {
          var a = L.loadAnimation({ container: stage, renderer: 'svg', loop: name !== 'success-check', autoplay: true, path: ASSET.base + 'lottie/' + name + '.json' });
          a.addEventListener('DOMLoaded', function () { el.classList.add('is-anim'); });
          a.addEventListener('data_failed', function () { el.classList.remove('is-anim'); });
          store.push(a);
        } catch (e) { /* keep the icon fallback */ }
      });
    });
  }
  function goodNews(title, text, actions) {
    return '<div class="kjd-good">' + lottieBox('success-check', 'shield-check') +
      '<div class="kjd-good-title">' + esc(title) + '</div><div class="kjd-good-text">' + esc(text) + '</div>' +
      (actions ? '<div class="kj-row-wrap">' + actions + '</div>' : '') + '</div>';
  }
  function noMatch(text) {
    return '<div class="kjd-good">' + lottieBox('empty-box', 'search-x', true) +
      '<div class="kjd-good-title">No detections match these filters</div><div class="kjd-good-text">' + esc(text || 'Try another type, camera or date.') + '</div>' +
      '<div class="kj-row-wrap"><button type="button" class="kj-btn kj-btn-secondary" data-kjd-act="reset">' + ico('rotate-ccw') + '<span>Reset filters</span></button></div></div>';
  }

  /* ── render pieces ───────────────────────────────────────────────────── */
  function evSeed(ev) {
    // Module rows not in the live feed carry their own fields into the modal.
    if (appEvent(ev.id)) return null;
    return { mod: ev.mod, sev: ev.sev, title: ev.title, camera: ev.camera, device: ev.device, zone: ev.zone, ts: ev.ts,
      image: ev.image, personId: ev.personId, person: ev.person, status: ev.status, finding: ev.finding, verdict: ev.verdict || '', uuid: ev.uuid || undefined };
  }
  function evCard(ev) {
    var m = modOf(ev.mod);
    var cam = ev.camera ? '<button type="button" class="kjd-cam" title="Open camera ' + esc(camName(ev.camera) || ev.camera) + '" data-kj-modal="' + esc(spec('camera', ev.camera)) + '">' + ico('cctv') + esc(ev.camera) + '</button>' : '';
    var who = ev.personId ? '<button type="button" class="kj-link" data-kj-modal="' + esc(spec('person', ev.personId)) + '"' + seedAttr({ name: ev.person }) + '>' + esc(ev.person || ('#' + ev.personId)) + '</button>'
      : '<span>' + esc(ev.person || 'Unidentified') + '</span>';
    return '<article class="kjd-ev' + (ev.sev ? ' is-sev-' + esc(ev.sev) : '') + '" data-kj-modal="' + esc(spec('event', ev.id)) + '"' + seedAttr(evSeed(ev)) + ' aria-label="' + esc(m[0] + ': ' + ev.title) + '">' +
      '<div class="kjd-ev-media">' + (ev.image ? '<img src="' + esc(ev.image) + '" alt="" loading="lazy" decoding="async">' : '<span class="kjd-ev-noimg">' + ico('image-off') + '</span>') +
        '<span class="kjd-ev-type">' + ico(m[1]) + esc(m[0]) + '</span>' +
        (ev.sev ? '<span class="kjd-ev-sev">' + sevChip(ev.sev) + '</span>' : '') +
        (isWebp(ev.image) ? '<span class="kjd-ev-webp">.webp</span>' : '') +
        '<span class="kjd-ev-time">' + esc(hm(ev.ts)) + '</span></div>' +
      '<div class="kjd-ev-body"><div class="kjd-ev-title" title="' + esc(ev.title) + '">' + esc(ev.title) + '</div>' +
        '<div class="kjd-ev-meta">' + ico('user-round') + who + '</div>' +
        '<div class="kjd-ev-meta">' + cam + (ev.zone ? '<span>· ' + esc(ev.zone) + '</span>' : '') + '</div>' +
        '<div class="kjd-ev-foot">' + statusChip(ev.status) + '<span class="kjd-spacer"></span>' + ticketBadge(ev) + '</div></div></article>';
  }
  function evTable(list) {
    return '<div class="kj-table-wrap"><table class="kj-table"><thead><tr><th>Proof</th><th>Type</th><th>Person</th><th>Camera</th><th>Zone</th><th>Time</th><th>Severity</th><th>Status</th><th>Ticket</th></tr></thead><tbody>' +
      list.map(function (ev) {
        var m = modOf(ev.mod);
        return '<tr data-kj-modal="' + esc(spec('event', ev.id)) + '"' + seedAttr(evSeed(ev)) + '>' +
          '<td>' + (ev.image ? '<img class="kjd-tbl-thumb" src="' + esc(ev.image) + '" alt="" loading="lazy">' : '<span class="kjd-tbl-thumb"></span>') + '</td>' +
          '<td><span class="kjd-tbl-type"><span class="kjd-ico-' + m[2] + '">' + ico(m[1]) + '</span>' + esc(m[0]) + '</span></td>' +
          '<td>' + (ev.personId ? '<button type="button" class="kj-link" data-kj-modal="' + esc(spec('person', ev.personId)) + '"' + seedAttr({ name: ev.person }) + '>' + esc(ev.person || ('#' + ev.personId)) + '</button>' : esc(ev.person || 'Unidentified')) + '</td>' +
          '<td>' + (ev.camera ? '<button type="button" class="kjd-cam" data-kj-modal="' + esc(spec('camera', ev.camera)) + '">' + ico('cctv') + esc(ev.camera) + '</button>' : '—') + '</td>' +
          '<td>' + esc(ev.zone || '—') + '</td><td class="kj-mono">' + esc(hms(ev.ts)) + '</td>' +
          '<td>' + sevChip(ev.sev) + '</td><td>' + statusChip(ev.status) + '</td><td>' + (ticketBadge(ev) || '—') + '</td></tr>';
      }).join('') + '</tbody></table></div>';
  }
  /* KPI tile: o = {icon, val, lbl, tone, act, arg, modal, on} */
  function tile(o) {
    var attrs = o.modal ? ' data-kj-modal="' + esc(o.modal) + '"' : ' data-kjd-act="' + esc(o.act || '') + '" data-arg="' + esc(o.arg || '') + '"';
    return '<button type="button" class="kj-stat' + (o.tone ? ' is-' + o.tone : '') + (o.on ? ' is-on' : '') + '"' + attrs + ' title="' + esc(o.tip || o.lbl) + '">' +
      '<span class="kj-stat-ico">' + ico(o.icon) + '</span><span><span class="kj-stat-val">' + esc(o.val) + '</span><span class="kj-stat-lbl">' + esc(o.lbl) + '</span></span></button>';
  }
  /* Column bars: items [{lbl, v, tip, modal | act+arg}] */
  function bars(items, tone) {
    var mx = Math.max(1, Math.max.apply(null, items.map(function (i) { return N(i.v); })));
    return '<div class="kj-minibars kjd-bars">' + items.map(function (i) {
      var attrs = i.modal ? ' data-kj-modal="' + esc(i.modal) + '"' : (i.act ? ' data-kjd-act="' + esc(i.act) + '" data-arg="' + esc(i.arg || '') + '"' : '');
      return '<button type="button" class="kj-minibar"' + attrs + ' title="' + esc(i.tip || (i.lbl + ': ' + i.v)) + '"><span class="kj-minibar-val">' + esc(fmtN(i.v)) + '</span>' +
        '<span class="kj-minibar-track"><span class="kj-minibar-fill kj-h-' + step5(100 * N(i.v) / mx) + ' kj-fill-' + (i.tone || tone || 'muted') + '"></span></span>' +
        '<span class="kj-minibar-lbl">' + esc(i.lbl) + '</span></button>';
    }).join('') + '</div>';
  }
  /* Horizontal bars: rows [{label, n, val, pct, tone, modal | act+arg}] */
  function hbars(rows, tone) {
    var mx = Math.max(1, Math.max.apply(null, rows.map(function (r) { return N(r.n); })));
    return '<div class="kj-stack">' + rows.map(function (r) {
      var attrs = r.modal ? ' data-kj-modal="' + esc(r.modal) + '"' : (r.act ? ' data-kjd-act="' + esc(r.act) + '" data-arg="' + esc(r.arg || '') + '"' : '');
      return '<button type="button" class="kjd-hrow"' + attrs + '><div class="kj-row"><span class="kj-truncate kj-text-2">' + esc(r.label) + '</span><span class="kj-spacer"></span><b>' + esc(r.val != null ? r.val : fmtN(r.n)) + '</b></div>' +
        '<div class="kj-progress"><div class="kj-progress-fill kj-w-' + step5(r.pct != null ? r.pct : 100 * N(r.n) / mx) + ' kj-fill-' + (r.tone || tone || 'muted') + '"></div></div></button>';
    }).join('') + '</div>';
  }
  function card(title, sub, body, extra) {
    return '<section class="kjd-card"><div class="kjd-card-head"><h3 class="kjd-card-title">' + esc(title) + '</h3>' +
      (sub ? '<span class="kjd-card-sub">' + esc(sub) + '</span>' : '') + (extra || '') + '</div>' + body + '</section>';
  }
  function skelTiles(n) { var s = ''; for (var i = 0; i < n; i++) s += '<span class="kj-skel kj-skel-tile"></span>'; return '<div class="kjd-kpis' + (n === 4 ? ' is-4' : '') + '">' + s + '</div>'; }
  function skelGal(n) { var s = ''; for (var i = 0; i < n; i++) s += '<span class="kj-skel"></span>'; return '<div class="kjd-skel-gal">' + s + '</div>'; }
  function dayLbl(d) { var x = new Date(String(d) + 'T00:00:00'); return isNaN(x) ? String(d).slice(5) : x.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }); }

  /* ======================================================================
   * Lead state + lifecycle (route listener, 500 ms state watcher)
   * ==================================================================== */
  var PAGE = 24;
  var Lead = {
    el: null, sub: '', dirty: true, timer: null, anims: [], refs: [],
    f: { date: '', cam: '', mod: '', sev: '', status: '', q: '', hour: -1 },
    page: 1, view: 'gallery', tabMore: 0,
    ext: { date: '', rows: null, busy: false, ver: 0 }
  };

  function ensureEl() {
    var host = document.getElementById('kj-page-host');
    if (!host || !host.parentNode) return null;
    if (!Lead.el) {
      Lead.el = document.createElement('section');
      Lead.el.id = 'kjd-lead';
      Lead.el.className = 'kjd kj-root';
      Lead.el.setAttribute('aria-label', 'Detections');
      Lead.el.addEventListener('click', onClick);
      Lead.el.addEventListener('change', onChange);
      Lead.el.addEventListener('input', onInput);
    }
    if (Lead.el.parentNode !== host.parentNode || Lead.el.previousElementSibling !== host) host.insertAdjacentElement('afterend', Lead.el);
    return Lead.el;
  }
  function destroyAnims() { Lead.anims.forEach(function (a) { try { a.destroy(); } catch (e) { /* ignore */ } }); Lead.anims = []; }

  function activate(r) {
    var el = ensureEl(); if (!el) return;
    document.documentElement.classList.add('kjd-active');
    el.hidden = false;
    if (!Lead.f.date) Lead.f.date = today();
    if (Lead.sub !== r.sub || !el.firstChild) {
      Lead.sub = r.sub; Lead.page = 1; Lead.tabMore = 0;
      destroyAnims();
      el.innerHTML = frame(r.sub);
      Lead.refs = []; Lead.dirty = true;
      if (el.parentNode) el.parentNode.scrollTop = 0;
    }
    loadTickets(false).then(function () { Lead.dirty = true; });
    paintIfNeeded();
    if (!Lead.timer) Lead.timer = setInterval(tick, 500);
  }
  function deactivate() {
    document.documentElement.classList.remove('kjd-active');
    if (Lead.timer) { clearInterval(Lead.timer); Lead.timer = null; }
    if (Lead.el) { destroyAnims(); Lead.el.hidden = true; Lead.el.innerHTML = ''; }
    Lead.sub = '';
  }
  function tick() {
    if (!Lead.sub) return;
    if (!Lead.el || !document.contains(Lead.el) || Lead.el.previousElementSibling !== document.getElementById('kj-page-host')) {
      var cur = window.KJPages && window.KJPages.current();
      if (cur && cur.hub === 'detections') { Lead.sub = ''; activate(cur); }
      return;
    }
    if (Date.now() - TK.at > 60000 && !TK.busy) loadTickets(false).then(function () { Lead.dirty = true; });
    paintIfNeeded();
  }
  /* Repaint only when an app.state slice this tab reads changed (reference diff). */
  function paintIfNeeded() {
    var s = st(), L = LEAD[Lead.sub] || LEAD.incidents;
    var refs = L.refs(s).concat([TK.ver, Lead.ext.ver, !!window.KJIcon]);
    var same = !Lead.dirty && refs.length === Lead.refs.length && refs.every(function (x, i) { return x === Lead.refs[i]; });
    if (same) return;
    Lead.refs = refs; Lead.dirty = false;
    paint();
  }
  function paint() {
    var body = Lead.el && Lead.el.querySelector('[data-kjd-body]');
    if (!body) return;
    var L = LEAD[Lead.sub] || LEAD.incidents;
    destroyAnims();
    var html;
    try { html = L.body(st()); } catch (e) { html = '<div class="kjd-err">' + ico('circle-alert') + 'Could not render this view.</div>'; try { console.error('[detections]', e); } catch (x) { /* ignore */ } }
    body.innerHTML = html;
    syncControls();
    hydrateLottie(body, Lead.anims);
  }
  function repaint() { Lead.dirty = true; paintIfNeeded(); }

  /* ── event handlers (delegated on #kjd-lead) ─────────────────────────── */
  function setF(patch) { Object.keys(patch).forEach(function (k) { Lead.f[k] = patch[k]; }); Lead.page = 1; repaint(); }
  function onClick(ev) {
    var t = ev.target instanceof Element ? ev.target.closest('[data-kjd-act]') : null;
    if (!t || !Lead.el.contains(t)) return;
    // A modal trigger nested inside the action element wins (KJModal's document listener handles it).
    var mt = ev.target.closest('[data-kj-modal]');
    if (mt && mt !== t && t.contains(mt)) return;
    var act = t.getAttribute('data-kjd-act'), arg = t.getAttribute('data-arg') || '';
    if (!act) return;
    ev.preventDefault();
    var a = appRef();
    switch (act) {
      case 'type': setF({ mod: arg === Lead.f.mod ? '' : arg, hour: -1 }); break;
      case 'cell': { var p = arg.split('@'); if (Lead.f.mod === p[0] && Lead.f.hour === N(p[1])) setF({ mod: '', hour: -1 }); else setF({ mod: p[0], hour: N(p[1]) }); break; }
      case 'sev': setF({ sev: Lead.f.sev === arg ? '' : arg }); break;
      case 'status': setF({ status: Lead.f.status === arg ? '' : arg }); break;
      case 'clear': { var o = {}; o[arg] = arg === 'hour' ? -1 : ''; setF(o); break; }
      case 'reset': Lead.f = { date: Lead.f.date || today(), cam: '', mod: '', sev: '', status: '', q: '', hour: -1 }; Lead.page = 1;
        if (Lead.el.querySelector('[data-kjd-f="q"]')) Lead.el.querySelector('[data-kjd-f="q"]').value = ''; repaint(); break;
      case 'day': setDate(arg === 'yesterday' ? ymd(new Date(Date.now() - 86400000)) : today()); break;
      case 'more': Lead.page++; repaint(); break;
      case 'tabmore': Lead.tabMore++; repaint(); break;
      case 'view': Lead.view = arg === 'table' ? 'table' : 'gallery'; repaint(); break;
      // Jump from a type tab into the overview gallery with a filter applied.
      case 'jump': { var j = arg.split('@'); Lead.f.mod = j[0] || ''; Lead.f.hour = j[1] != null && j[1] !== '' ? N(j[1]) : -1; Lead.f.sev = j[2] || '';
        Lead.f.date = today(); Lead.page = 1; if (window.KJPages) window.KJPages.go('detections'); break; }
      case 'reload': {
        var fn = (LEAD[Lead.sub] || {}).loader;
        if (a && fn && typeof a[fn] === 'function') { a[fn](); toast('Refreshing…'); }
        loadTickets(true).then(function () { Lead.dirty = true; });
        break;
      }
      default: break;
    }
  }
  function setDate(d) {
    d = d || today();
    Lead.f.date = d; Lead.f.hour = -1; Lead.page = 1;
    var inp = Lead.el && Lead.el.querySelector('[data-kjd-f="date"]'); if (inp && inp.value !== d) inp.value = d;
    if (d !== today()) fetchDay(d);
    repaint();
  }
  function onChange(ev) {
    var t = ev.target, k = t && t.getAttribute && t.getAttribute('data-kjd-f');
    if (!k || k === 'q') return;
    if (k === 'date') { setDate(t.value); return; }
    var o = {}; o[k] = t.value; setF(o);
  }
  var qT = null;
  function onInput(ev) {
    var t = ev.target;
    if (!t || !t.getAttribute || t.getAttribute('data-kjd-f') !== 'q') return;
    if (qT) clearTimeout(qT);
    qT = setTimeout(function () { setF({ q: t.value }); }, 180);
  }
  function fetchDay(d) {
    if (Lead.ext.date === d && (Lead.ext.rows || Lead.ext.busy)) return;
    Lead.ext = { date: d, rows: null, busy: true, ver: Lead.ext.ver + 1 };
    api('/events', { from: d + ' 00:00:00', to: d + ' 23:59:59', limit: 500 }).then(function (r) {
      if (Lead.ext.date !== d) return;
      Lead.ext = { date: d, rows: ((r && r.events) || []).map(classify), busy: false, ver: Lead.ext.ver + 1, err: !r };
    });
  }
  /* Keep the static filter controls in step with the filter state + data. */
  function syncControls() {
    var el = Lead.el; if (!el) return;
    var set = function (k, v) { var x = el.querySelector('[data-kjd-f="' + k + '"]'); if (x && x.value !== v) x.value = v; };
    var cs = el.querySelector('[data-kjd-f="cam"]');
    if (cs) {
      var cams = {}; dayEvents(st()).forEach(function (e) { if (e.camera) cams[e.camera] = 1; });
      if (Lead.f.cam) cams[Lead.f.cam] = 1;
      var keys = Object.keys(cams).sort();
      var sig = keys.join('|');
      if (cs.getAttribute('data-sig') !== sig) {
        cs.setAttribute('data-sig', sig);
        cs.innerHTML = '<option value="">All cameras</option>' + keys.map(function (k) { var n = camName(k); return '<option value="' + esc(k) + '">' + esc(k + (n ? ' · ' + n : '')) + '</option>'; }).join('');
      }
    }
    set('cam', Lead.f.cam); set('sev', Lead.f.sev); set('status', Lead.f.status); set('date', Lead.f.date);
  }

  /* ======================================================================
   * Tab leads
   * ==================================================================== */
  function frame(sub) {
    var L = LEAD[sub] || LEAD.incidents;
    return L.head() + (L.filters ? L.filters() : '') + '<div class="kjd-stack" data-kjd-body></div>' +
      '<div class="kjd-divider">' + ico('arrow-down') + '<span>' + esc(L.below) + '</span></div>';
  }
  function headHtml(icon, tone, title, sub, actions) {
    return '<header class="kjd-head"><div class="kjd-head-main"><span class="kjd-head-ico is-' + tone + '">' + ico(icon) + '</span>' +
      '<div><h2 class="kjd-title">' + esc(title) + '</h2><p class="kjd-sub">' + esc(sub) + '</p></div></div>' +
      '<div class="kjd-head-actions">' + (actions || '') + '</div></header>';
  }
  function liveChip() { return '<span class="kjd-live" title="Live feed — refreshes every 5 s"><span class="kjd-live-dot"></span>Live</span>'; }

  /* ── overview (incidents sub) ────────────────────────────────────────── */
  function dayEvents(s) {
    var d = Lead.f.date || today();
    if (d !== today()) return Lead.ext.date === d && Lead.ext.rows ? Lead.ext.rows : [];
    var t0 = new Date(d + 'T00:00:00').getTime(), t1 = t0 + 86400000;
    return (s.events || []).map(function (e) { return norm(e); }).filter(function (e) { return e.ts >= t0 && e.ts < t1; });
  }
  function baseFilter(list) {
    var f = Lead.f, q = String(f.q || '').trim().toLowerCase();
    return list.filter(function (e) {
      if (f.cam && e.camera !== f.cam) return false;
      if (f.sev && e.sev !== f.sev) return false;
      if (f.status === 'ticket') { if (!(e.ticket || ticketFor(e))) return false; }
      else if (f.status && e.status !== f.status) return false;
      if (q && [e.person, e.personId, e.title, e.zone, e.camera, camName(e.camera)].join(' ').toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
  }
  function overviewFilters() {
    return '<div class="kjd-filters" role="search">' +
      '<label class="kjd-fld" title="Date">' + ico('calendar-days') + '<input type="date" data-kjd-f="date" aria-label="Date" max="' + today() + '"></label>' +
      '<span class="kjd-quick"><button type="button" class="kj-btn kj-btn-ghost kj-btn-sm" data-kjd-act="day" data-arg="today">Today</button>' +
      '<button type="button" class="kj-btn kj-btn-ghost kj-btn-sm" data-kjd-act="day" data-arg="yesterday">Yesterday</button></span>' +
      '<label class="kjd-fld" title="Camera">' + ico('cctv') + '<select data-kjd-f="cam" aria-label="Camera"><option value="">All cameras</option></select></label>' +
      '<label class="kjd-fld" title="Severity">' + ico('triangle-alert') + '<select data-kjd-f="sev" aria-label="Severity"><option value="">Any severity</option>' +
        ['critical', 'high', 'medium', 'low'].map(function (k) { return '<option value="' + k + '">' + SEV[k][0] + '</option>'; }).join('') + '</select></label>' +
      '<label class="kjd-fld" title="Status">' + ico('list-checks') + '<select data-kjd-f="status" aria-label="Status"><option value="">Any status</option>' +
        '<option value="open">Open</option><option value="ack">Acknowledged</option><option value="resolved">Resolved</option><option value="ticket">Has a ticket</option></select></label>' +
      '<label class="kjd-fld kjd-search">' + ico('search') + '<input type="search" data-kjd-f="q" placeholder="Search person, zone or camera" aria-label="Search person"></label>' +
      '</div>';
  }
  function overviewBody(s) {
    var f = Lead.f, isToday = (f.date || today()) === today();
    if (isToday && !Array.isArray(s.events)) return skelTiles(5) + '<span class="kj-skel kjd-skel-tl"></span>' + skelGal(8);
    if (!isToday && Lead.ext.busy) return skelTiles(5) + '<span class="kj-skel kjd-skel-tl"></span>' + skelGal(8);
    var day = dayEvents(s);
    var base = baseFilter(day);
    var list = base.filter(function (e) {
      if (f.mod && e.mod !== f.mod) return false;
      if (f.hour >= 0 && new Date(e.ts).getHours() !== f.hour) return false;
      return true;
    }).sort(function (a, b) { return b.ts - a.ts; });

    // type chips
    var byMod = {}; base.forEach(function (e) { byMod[e.mod] = (byMod[e.mod] || 0) + 1; });
    var types = '<div class="kjd-types" role="toolbar" aria-label="Detection type">' +
      '<button type="button" class="kjd-type' + (!f.mod ? ' is-on' : '') + '" data-kjd-act="type" data-arg="">' + ico('layers') + 'All types<span class="kjd-type-n">' + fmtN(base.length) + '</span></button>' +
      MOD_ORDER.filter(function (k) { return byMod[k] || f.mod === k || k !== 'face'; }).map(function (k) {
        var m = MOD[k];
        return '<button type="button" class="kjd-type' + (f.mod === k ? ' is-on' : '') + '" data-kjd-act="type" data-arg="' + k + '">' + ico(m[1]) + esc(m[0]) + '<span class="kjd-type-n">' + fmtN(byMod[k] || 0) + '</span></button>';
      }).join('') +
      (f.hour >= 0 ? '<button type="button" class="kjd-x" data-kjd-act="clear" data-arg="hour" title="Clear hour filter">' + pad(f.hour) + ':00–' + pad((f.hour + 1) % 24) + ':00' + ico('x') + '</button>' : '') +
      (f.cam ? '<button type="button" class="kjd-x" data-kjd-act="clear" data-arg="cam">' + esc(f.cam) + ico('x') + '</button>' : '') +
      (f.q ? '<button type="button" class="kjd-x" data-kjd-act="clear" data-arg="q">“' + esc(f.q) + '”' + ico('x') + '</button>' : '') +
      '</div>';

    // KPI tiles (each one filters the wall)
    var open = day.filter(function (e) { return e.status === 'open'; }).length;
    var hi = day.filter(function (e) { return e.sev === 'critical' || e.sev === 'high'; }).length;
    var tk = day.filter(function (e) { return e.ticket || ticketFor(e); }).length;
    var proof = day.filter(function (e) { return e.image; }).length;
    var kpis = '<div class="kjd-kpis">' +
      tile({ icon: 'radar', val: fmtN(day.length), lbl: (isToday ? 'Detections today' : 'Detections on ' + dayLbl(f.date)), act: 'reset', tip: 'Show everything' }) +
      tile({ icon: 'siren', val: fmtN(open), lbl: 'Open — need action', tone: open ? 'danger' : 'success', act: 'status', arg: 'open', on: f.status === 'open' }) +
      tile({ icon: 'triangle-alert', val: fmtN(hi), lbl: 'High / critical', tone: hi ? 'orange' : 'success', act: 'sev', arg: 'high', on: f.sev === 'high' }) +
      tile({ icon: 'ticket', val: fmtN(tk), lbl: 'With a ticket', tone: 'purple', act: 'status', arg: 'ticket', on: f.status === 'ticket' }) +
      tile({ icon: 'images', val: fmtN(proof), lbl: 'Proof images', tone: 'success', act: 'view', arg: 'gallery' }) + '</div>';

    if (!day.length) {
      var msg = isToday ? 'Nothing has been detected yet today. Cameras are watching — new events appear here within seconds.' : 'No detections were recorded on ' + dayLbl(f.date) + '.';
      return kpis + card('Today’s timeline', '', goodNews('No detections — all clear', msg,
        '<button type="button" class="kj-btn kj-btn-secondary" data-kj-nav="cameras/wall">' + ico('cctv') + '<span>Camera wall</span></button>' +
        (isToday ? '<button type="button" class="kj-btn kj-btn-secondary" data-kjd-act="day" data-arg="yesterday">' + ico('history') + '<span>See yesterday</span></button>' : '')));
    }

    // timeline: type lanes × 24 hours
    var lanes = MOD_ORDER.filter(function (k) { return byMod[k]; });
    var nowH = isToday ? new Date().getHours() : -1;
    var grid = '<div class="kjd-tl-wrap"><div class="kjd-tl" role="grid" aria-label="Detections per type and hour"><span></span>';
    for (var h = 0; h < 24; h++) grid += '<span class="kjd-tl-h' + (h === nowH ? ' is-now' : '') + '">' + (h % 3 === 0 ? pad(h) : '') + '</span>';
    lanes.forEach(function (k) {
      var m = MOD[k], cnt = [], hiC = [];
      for (var i = 0; i < 24; i++) { cnt.push(0); hiC.push(0); }
      base.forEach(function (e) { if (e.mod !== k) return; var hh = new Date(e.ts).getHours(); cnt[hh]++; if (e.sev === 'critical' || e.sev === 'high') hiC[hh]++; });
      grid += '<span class="kjd-tl-lab"><span class="kjd-ico-' + m[2] + '">' + ico(m[1]) + '</span><span>' + esc(m[0]) + '</span></span>';
      for (var j = 0; j < 24; j++) {
        var n = cnt[j], heat = n === 0 ? 0 : n === 1 ? 1 : n <= 3 ? 2 : n <= 7 ? 3 : 4;
        var sel = f.mod === k && f.hour === j;
        grid += n ? '<button type="button" class="kjd-cell kjd-t-' + m[2] + ' kjd-heat-' + heat + (j === nowH ? ' is-now' : '') + (sel ? ' is-sel' : '') + (hiC[j] ? ' has-hi' : '') + '" data-kjd-act="cell" data-arg="' + k + '@' + j + '" title="' + esc(m[0] + ' · ' + pad(j) + ':00–' + pad((j + 1) % 24) + ':00 · ' + n + ' detection' + (n === 1 ? '' : 's') + (hiC[j] ? ' (' + hiC[j] + ' high/critical)' : '')) + '">' + n + '</button>'
          : '<span class="kjd-cell kjd-heat-0' + (j === nowH ? ' is-now' : '') + '"></span>';
      }
    });
    grid += '</div></div>';
    var legend = '<span class="kjd-legend"><span><i class="l1"></i>few</span><span><i class="l4"></i>many</span><span><i class="lhi"></i>high / critical inside</span><span>Click a cell to filter</span></span>';
    var timeline = card(isToday ? 'Today’s timeline' : 'Timeline · ' + dayLbl(f.date), fmtN(base.length) + ' events', grid, legend);

    // gallery wall (table view secondary)
    var shown = list.slice(0, Lead.page * PAGE);
    var seg = '<span class="kjd-legend"><span class="kjd-seg" role="group" aria-label="View">' +
      '<button type="button" class="' + (Lead.view === 'gallery' ? 'is-on' : '') + '" data-kjd-act="view" data-arg="gallery" aria-pressed="' + (Lead.view === 'gallery') + '">' + ico('layout-grid') + 'Gallery</button>' +
      '<button type="button" class="' + (Lead.view === 'table' ? 'is-on' : '') + '" data-kjd-act="view" data-arg="table" aria-pressed="' + (Lead.view === 'table') + '">' + ico('table-2') + 'Table</button></span></span>';
    var wall = !list.length ? noMatch() :
      (Lead.view === 'table' ? evTable(shown) : '<div class="kjd-gal">' + shown.map(evCard).join('') + '</div>') +
      (list.length > shown.length ? '<div class="kjd-more"><button type="button" class="kj-btn kj-btn-secondary" data-kjd-act="more">' + ico('chevron-down') + '<span>Show ' + Math.min(PAGE, list.length - shown.length) + ' more of ' + fmtN(list.length - shown.length) + '</span></button></div>' : '');
    var galTitle = (f.mod ? MOD[f.mod][0] + ' · ' : '') + (Lead.view === 'table' ? 'Event list' : 'Proof gallery');
    var note = !isToday && Lead.ext.err ? '<div class="kjd-note">Could not load that day from the event log.</div>' : (!isToday ? '<div class="kjd-note">Historical day from the event log — type is inferred from the detection policy.</div>' : '');
    return types + kpis + timeline + card(galTitle, fmtN(list.length) + ' shown newest first', wall + note, seg);
  }

  /* ── per-type leads ──────────────────────────────────────────────────── */
  function feedOf(s, mod) { return (s.events || []).map(function (e) { return norm(e); }).filter(function (e) { return e.mod === mod; }).sort(function (a, b) { return b.ts - a.ts; }); }
  function tabActions(mod) {
    return liveChip() + '<button type="button" class="kj-btn kj-btn-secondary kj-btn-sm" data-kjd-act="reload">' + ico('refresh-cw') + '<span>Refresh</span></button>' +
      '<button type="button" class="kj-btn kj-btn-secondary kj-btn-sm" data-kjd-act="jump" data-arg="' + mod + '">' + ico('layout-grid') + '<span>Open in gallery</span></button>';
  }
  /* Common tab body: { kpis[], trend{title,sub,items,tone}, side{title,sub,rows,tone}, list[], listTitle, busy, err, emptyText } */
  function tabBody(o) {
    if (o.busy && !o.list.length && !o.kpis.length) return skelTiles(4) + '<span class="kj-skel kjd-skel-tl"></span>' + skelGal(4);
    var out = '';
    if (o.err) out += '<div class="kjd-err">' + ico('cloud-off') + esc(o.err) + ' <button type="button" class="kj-btn kj-btn-ghost kj-btn-sm" data-kjd-act="reload">Retry</button></div>';
    out += '<div class="kjd-kpis is-4">' + o.kpis.map(tile).join('') + '</div>';
    var tr = o.trend && o.trend.items.length ? card(o.trend.title, o.trend.sub, bars(o.trend.items, o.trend.tone)) : '';
    var sd = o.side && o.side.rows.length ? card(o.side.title, o.side.sub, hbars(o.side.rows, o.side.tone)) : '';
    if (tr || sd) out += '<div class="kjd-split">' + (tr || sd) + (tr && sd ? sd : '') + '</div>';
    var n = 12 * (Lead.tabMore + 1), shown = o.list.slice(0, n);
    var listHtml = o.list.length ? '<div class="kjd-gal is-compact">' + shown.map(evCard).join('') + '</div>' +
      (o.list.length > n ? '<div class="kjd-more"><button type="button" class="kj-btn kj-btn-secondary" data-kjd-act="tabmore">' + ico('chevron-down') + '<span>Show more (' + fmtN(o.list.length - n) + ')</span></button></div>' : '')
      : goodNews(o.emptyTitle || 'No violations — good news', o.emptyText || 'Nothing to review in this window.', '');
    out += card(o.listTitle, o.list.length ? fmtN(o.list.length) + ' events · newest first' : '', listHtml);
    return out;
  }
  function dailyItems(daily, key, statKey, tone) {
    return (daily || []).slice(-14).map(function (d) {
      return { lbl: dayLbl(d.date), v: N(d[key]), tip: dayLbl(d.date) + ': ' + N(d[key]) + ' ' + key, modal: statKey ? spec('stat', statKey + '@' + d.date) : '', tone: tone };
    });
  }
  function itemLabel(k) { return { helmet: 'Helmet', vest: 'Hi-vis vest', mask: 'Mask', gloves: 'Gloves', goggles: 'Goggles', boots: 'Safety boots', hairnet: 'Hair net', ear: 'Ear protection' }[k] || k; }

  var LEAD = {
    incidents: {
      below: 'Incident register — SLA, escalation and reports',
      head: function () { return headHtml('triangle-alert', 'danger', 'Detections & Alerts', 'Review events, verify the proof image and resolve incidents.', liveChip()); },
      filters: overviewFilters,
      refs: function (s) { return [s.events, s.fleet, Lead.f.date]; },
      body: overviewBody
    },
    ppe: {
      loader: 'loadPpe', below: 'Live model charts, area rules and full violation history',
      head: function () { return headHtml('hard-hat', 'warn', 'PPE compliance', 'Every person at an area with a PPE rule is checked; missing items raise an incident.', tabActions('ppe')); },
      refs: function (s) { return [s.ppeD, s.ppeF, s.events]; },
      body: function (s) {
        var d = s.ppeD, k = (d && d.kpi) || {}, busy = !!(s.ppeF && s.ppeF.busy);
        var list = d && Array.isArray(d.violations) ? d.violations.map(function (v) {
          var miss = (v.missing || []).map(itemLabel);
          return norm(v, { id: v.uuid || ('ppe-' + v.id), mod: 'ppe', sev: miss.length > 1 ? 'high' : 'medium', title: miss.length ? 'Missing ' + miss.join(', ').toLowerCase() : 'PPE violation',
            zone: v.location, ts: toMs(v.time), finding: miss.length ? 'Missing: ' + miss.join(', ') : '', status: (appEvent(v.uuid) || {}).status || '' });
        }) : feedOf(s, 'ppe');
        var items = d && d.byItem ? Object.keys(d.byItem).map(function (key) { var it = d.byItem[key]; return { key: key, req: N(it.required), miss: N(it.missing) }; })
          .filter(function (x) { return x.req; }).sort(function (a, b) { return b.miss - a.miss; }) : [];
        return tabBody({
          busy: busy, err: s.ppeF && s.ppeF.err, list: list, listTitle: 'Recent PPE violations',
          kpis: d ? [
            { icon: 'shield-check', val: k.compliance == null ? '—' : k.compliance + '%', lbl: 'Compliance', tone: k.compliance == null ? '' : (k.compliance >= 95 ? 'success' : k.compliance >= 85 ? 'warn' : 'danger'), modal: 'stat:ppe' },
            { icon: 'scan-face', val: fmtN(k.checks), lbl: 'People checked', modal: 'stat:ppe' },
            { icon: 'hard-hat', val: fmtN(k.violations), lbl: 'Violations in range', tone: k.violations ? 'warn' : 'success', act: 'jump', arg: 'ppe' },
            { icon: 'siren', val: fmtN(k.today), lbl: 'Violations today', tone: k.today ? 'danger' : 'success', act: 'jump', arg: 'ppe' }] : [],
          trend: d ? { title: 'Violations per day', sub: (d.from || '') + ' → ' + (d.to || ''), items: dailyItems(d.daily, 'violations', 'ppe', 'warn') } : null,
          side: { title: 'Most-missed PPE', sub: 'missing / required', tone: 'warn', rows: items.map(function (x) {
            return { label: itemLabel(x.key), n: x.miss, val: fmtN(x.miss) + ' / ' + fmtN(x.req), pct: x.req ? 100 * x.miss / x.req : 0, modal: 'stat:ppe' }; }) },
          emptyText: 'No PPE violations in this window — everyone checked was wearing the required gear.'
        });
      }
    },
    forklift: {
      loader: 'loadFk', below: 'Zone review queue, operator PPE and exports',
      head: function () { return headHtml('forklift', 'orange', 'Forklift safety', 'Forklift and pedestrian detections judged against each zone’s rule; operator PPE checked by the AI pipeline.', tabActions('forklift')); },
      refs: function (s) { return [s.fkD, s.fkF, s.events]; },
      body: function (s) {
        var d = s.fkD, k = (d && d.kpi) || {}, busy = !!(s.fkF && s.fkF.busy);
        var V = { violation: 'high', logged: 'medium', cleared: 'low' };
        var list = d && Array.isArray(d.incidents) ? d.incidents.map(function (i) {
          var kind = i.kind === 'pedestrian' ? 'Pedestrian in forklift zone' : i.kind === 'operator' ? 'Forklift operator' : 'Forklift';
          var op = i.opViolation ? 'operator missing ' + (i.opMissing || []).map(itemLabel).join(', ').toLowerCase() : '';
          return norm(i, { id: i.uuid || ('fk-' + i.id), mod: 'forklift', sev: i.opViolation ? 'high' : (V[i.verdict] || 'low'),
            title: kind + (i.verdict ? ' · ' + i.verdict : '') + (op ? ' · ' + op : ''), zone: i.zone || i.location, ts: toMs(i.time),
            finding: [i.reason, op].filter(Boolean).join(' — '), verdict: i.verdict, status: i.status === 'open' && i.verdict !== 'violation' ? '' : i.status });
        }) : feedOf(s, 'forklift');
        var opPct = k.opChecked ? Math.round(100 * N(k.opCompliant) / N(k.opChecked)) : null;
        return tabBody({
          busy: busy, err: s.fkF && s.fkF.err, list: list, listTitle: 'Recent forklift events',
          kpis: d ? [
            { icon: 'forklift', val: fmtN(k.detections), lbl: 'Detections in range', modal: 'stat:fk' },
            { icon: 'triangle-alert', val: fmtN(k.violations), lbl: 'Zone violations', tone: k.violations ? 'orange' : 'success', act: 'jump', arg: 'forklift' },
            { icon: 'siren', val: fmtN(k.open), lbl: 'Open — awaiting review', tone: k.open ? 'danger' : 'success', act: 'jump', arg: 'forklift@@high' },
            { icon: 'hard-hat', val: opPct == null ? '—' : opPct + '%', lbl: 'Operator PPE compliance', tone: opPct == null ? '' : (opPct >= 95 ? 'success' : 'warn'), tip: fmtN(k.opViolations) + ' operator PPE violations', modal: 'stat:fk' }] : [],
          trend: d ? { title: 'Violations per day', sub: (d.from || '') + ' → ' + (d.to || ''), items: dailyItems(d.daily, 'violations', 'fk', 'orange') } : null,
          side: { title: 'Busiest zones', sub: 'violations / detections', tone: 'orange', rows: ((d && d.byZone) || []).slice().sort(function (a, b) { return N(b.violations) - N(a.violations) || N(b.detections) - N(a.detections); }).slice(0, 8).map(function (z) {
            return { label: z.zone + (z.camera && z.camera !== z.zone ? ' · ' + z.camera : ''), n: N(z.violations), val: fmtN(z.violations) + ' / ' + fmtN(z.detections), pct: N(z.detections) ? 100 * N(z.violations) / N(z.detections) : 0, modal: z.camera ? spec('camera', z.camera) : 'stat:fk' }; }) },
          emptyTitle: 'No forklift events — good news', emptyText: 'No forklift or pedestrian activity was flagged in this window.'
        });
      }
    },
    fire: {
      below: 'Model charts, assigned cameras and model configuration',
      head: function () { return headHtml('flame', 'danger', 'Fire & smoke', 'Flame, smoke and smoking detections across all cameras — rolling 24 h.', tabActions('fire')); },
      refs: function (s) { return [s.report, s.events]; },
      body: function (s) {
        var r = s.report || null, list = feedOf(s, 'fire');
        var since = Date.now() - 86400000, last24 = list.filter(function (e) { return e.ts >= since; });
        var open = list.filter(function (e) { return e.status === 'open'; }).length;
        var hi = last24.filter(function (e) { return e.sev === 'critical' || e.sev === 'high'; }).length;
        var hourly = (r && Array.isArray(r.hourly)) ? r.hourly : null;
        var hrs = [];
        for (var i = 0; i < 24; i++) { var hh = new Date(Date.now() - (23 - i) * 3600e3).getHours(); hrs.push(hh); }
        if (!hourly) { hourly = hrs.map(function (h) { return last24.filter(function (e) { return new Date(e.ts).getHours() === h; }).length; }); }
        var sev = (r && r.bySeverity) || {};
        var sevRows = ['Severe', 'High', 'Medium', 'Low'].map(function (k) { return { label: k, n: N(sev[k]), tone: k === 'Severe' || k === 'High' ? 'danger' : k === 'Medium' ? 'warn' : 'muted',
          act: 'jump', arg: 'fire@@' + ({ Severe: 'critical', High: 'high', Medium: 'medium', Low: 'low' })[k] }; }).filter(function (x) { return x.n; });
        return tabBody({
          busy: false, list: list, listTitle: 'Fire & smoke events',
          kpis: [
            { icon: 'flame', val: fmtN(r && r.total != null ? r.total : last24.length), lbl: 'Detections · 24 h', tone: last24.length ? 'danger' : 'success', act: 'jump', arg: 'fire' },
            { icon: 'siren', val: fmtN(open), lbl: 'Open alerts', tone: open ? 'danger' : 'success', act: 'jump', arg: 'fire' },
            { icon: 'triangle-alert', val: fmtN(hi), lbl: 'High / critical · 24 h', tone: hi ? 'orange' : 'success', act: 'jump', arg: 'fire@@high' },
            { icon: 'gauge', val: r && r.avgConf != null ? String(r.avgConf) : '—', lbl: 'Average confidence', modal: list[0] ? spec('event', list[0].id) : 'stat:ev' }],
          trend: { title: 'Detections per hour', sub: 'rolling 24 h — click an hour', tone: 'danger', items: hourly.map(function (v, i) {
            return { lbl: i % 3 === 0 ? pad(hrs[i]) : '', v: N(v), tip: pad(hrs[i]) + ':00 · ' + N(v) + ' detections', act: 'jump', arg: 'fire@' + hrs[i] }; }) },
          side: { title: 'By severity', sub: '24 h', rows: sevRows },
          emptyTitle: 'No fire or smoke detected — all clear', emptyText: 'No flame, smoke or smoking events are in the live feed.'
        });
      }
    },
    restricted: {
      loader: 'loadRa', below: 'Zone settings, entry review queue and exports',
      head: function () { return headHtml('shield-alert', 'danger', 'Restricted areas', 'Entries into restricted zones, matched against each zone’s authorised staff and hours.', tabActions('intr')); },
      refs: function (s) { return [s.raD, s.raF, s.events]; },
      body: function (s) { return genericTab(s, s.raD, s.raF, 'intr', 'incidents', 'ra', 'Recent restricted-area entries', 'No unauthorised entries — good news'); }
    },
    cleaning: {
      loader: 'loadCl', below: 'Cleaning schedules, sessions and supervisor confirmation',
      head: function () { return headHtml('sparkles', 'success', 'Cleaning activity', 'Scheduled cleaning sessions and PPE worn while cleaning.', tabActions('cleaning')); },
      refs: function (s) { return [s.clD, s.clF, s.events]; },
      body: function (s) { return genericTab(s, s.clD, s.clF, 'cleaning', 'violations', 'cl', 'PPE missed during cleaning', 'Cleaning crews wore the required PPE'); }
    },
    behaviour: {
      loader: 'loadBeh', below: 'Behaviour timeline, exceptions table and rules',
      head: function () { return headHtml('activity', 'purple', 'Behaviour analytics', 'Dwell, grouping, idle and cleaning-proxy events derived on Line 5.', tabActions('behaviour')); },
      refs: function (s) { return [s.behD, s.behF, s.events]; },
      body: function (s) { return genericTab(s, s.behD, s.behF, 'behaviour', 'exceptions', '', 'Behaviour exceptions', 'No behaviour exceptions — normal operation'); }
    }
  };
  /* Restricted / cleaning / behaviour: module list (with WebP proof) + generic KPIs. */
  function genericTab(s, d, f, mod, listKey, statKey, listTitle, emptyTitle) {
    var rows = d && Array.isArray(d[listKey]) ? d[listKey] : null;
    var list = rows ? rows.map(function (i) {
      var miss = (i.missing || []).map(itemLabel);
      var title = i.reason || (miss.length ? 'Missing ' + miss.join(', ').toLowerCase() : '') || (i.kind ? String(i.kind).replace(/_/g, ' ') : '') || MOD[mod][0];
      var v = String(i.verdict || '');
      return norm(i, { id: i.uuid || (mod + '-' + i.id), mod: mod, title: title.charAt(0).toUpperCase() + title.slice(1),
        sev: v === 'violation' || v === 'confirmed' ? 'high' : (miss.length ? 'medium' : 'low'), zone: i.zone || i.location,
        ts: toMs(i.time || i.start), finding: [i.reason, miss.length ? 'Missing: ' + miss.join(', ') : ''].filter(Boolean).join(' — '), verdict: v });
    }) : feedOf(s, mod);
    var t0 = new Date(today() + 'T00:00:00').getTime();
    var todayN = list.filter(function (e) { return e.ts >= t0; }).length;
    var viol = list.filter(function (e) { return e.sev === 'high'; }).length;
    var open = list.filter(function (e) { return e.status === 'open'; }).length;
    var key = d && d.daily && d.daily[0] ? (('violations' in d.daily[0]) ? 'violations' : Object.keys(d.daily[0]).filter(function (x) { return x !== 'date'; })[0]) : '';
    var byCam = {}; list.forEach(function (e) { if (e.camera) byCam[e.camera] = (byCam[e.camera] || 0) + 1; });
    return tabBody({
      busy: !!(f && f.busy), err: f && f.err, list: list, listTitle: listTitle, emptyTitle: emptyTitle,
      kpis: [
        { icon: MOD[mod][1], val: fmtN(list.length), lbl: rows ? 'Events in range' : 'Events in live feed', modal: statKey ? 'stat:' + statKey : '', act: statKey ? '' : 'jump', arg: mod },
        { icon: 'triangle-alert', val: fmtN(viol), lbl: 'Confirmed / high', tone: viol ? 'danger' : 'success', act: 'jump', arg: mod + '@@high' },
        { icon: 'siren', val: fmtN(open), lbl: 'Open', tone: open ? 'warn' : 'success', act: 'jump', arg: mod },
        { icon: 'calendar-days', val: fmtN(todayN), lbl: 'Today', tone: MOD[mod][2], act: 'jump', arg: mod }],
      trend: d && key ? { title: 'Per day', sub: (d.from || '') + ' → ' + (d.to || ''), items: dailyItems(d.daily, key, statKey, MOD[mod][2] === 'primary' ? '' : MOD[mod][2]) } : null,
      side: { title: 'By camera', sub: 'events', tone: MOD[mod][2], rows: Object.keys(byCam).sort(function (a, b) { return byCam[b] - byCam[a]; }).slice(0, 8).map(function (c) {
        return { label: c + (camName(c) ? ' · ' + camName(c) : ''), n: byCam[c], modal: spec('camera', c) }; }) }
    });
  }

  /* ── route wiring ────────────────────────────────────────────────────── */
  if (window.KJPages && window.KJPages.on) {
    window.KJPages.on('route', function (r) { if (r && r.hub === 'detections') activate(r); else if (Lead.sub) deactivate(); });
  }

  /* ======================================================================
   * KJModal 'event' — richer detection detail (replaces the M2 default)
   * kj-modal.js is deferred (loads after this file), so register once it exists.
   * ==================================================================== */
  function registerEventModal() {
    var M = window.KJModal;
    if (!M || !M.register || !M.h) return false;
    var h = M.h;
    function row(icon, k, v, raw) { return '<div class="kjd-m-row">' + ico(icon) + '<span class="kjd-m-k">' + esc(k) + '</span><span class="kjd-m-v">' + (raw ? v : esc(v == null || v === '' ? '—' : v)) + '</span></div>'; }
    M.register('event', {
      kicker: 'Detection details', icon: 'radar', size: 'lg', skeleton: 'media',
      load: function (ctx) {
        var id = String(ctx.id), seed = ctx.data || {};
        var hit = appEvent(id);
        var ovRow = !hit && ((st().ov && st().ov.events) || []).find(function (e) { return String(e.id) === id; });
        var uuid = hit ? String(hit.id) : (seed.uuid || (/[a-z]/i.test(id) && !/^(ppe|fk|intr|cleaning|behaviour)-\d+$/.test(id) ? id : ''));
        var raw = (!hit && uuid) ? api('/events/' + encodeURIComponent(uuid)) : Promise.resolve(null);
        return Promise.all([raw, loadTickets(false)]).then(function (res) {
          var r = res[0];
          var ev = hit ? norm(hit) : (r && r.event ? classify(r.event) : null);
          if (ev && !hit && seed && Object.keys(seed).length) {     // module row: keep its richer verdict/severity
            ['mod', 'sev', 'title', 'finding', 'verdict', 'status', 'zone'].forEach(function (k) { if (seed[k]) ev[k] = seed[k]; });
          }
          if (!ev && ovRow) ev = norm(ovRow);
          if (!ev && seed && Object.keys(seed).length) ev = norm(Object.assign({ id: id }, seed), { id: id, finding: seed.finding, verdict: seed.verdict });
          if (!ev) throw new Error('Event ' + id + ' was not found (it may have been purged)');
          ev.uuid = uuid || ev.uuid; ev.inApp = !!hit;
          return (ev.uuid ? api('/events/' + encodeURIComponent(ev.uuid) + '/log') : Promise.resolve(null)).then(function (lg) {
            ev.log = (lg && lg.log) || [];
            ev.ep = episodeOf(ev);
            return ticketForRemote(ev).then(function (tk) { ev.tk = tk; return ev; });
          });
        });
      },
      render: function (ctx, e) {
        var m = modOf(e.mod), s = SEV[e.sev], es = EST[e.status];
        var camId = e.camera || '';
        var tk = e.tk, tkNo = tk ? tk.ticket_no : e.ticket;
        var first = tk && tk.event_first_at ? toMs(tk.event_first_at) : e.ep.first;
        var last = tk && tk.event_last_at ? toMs(tk.event_last_at) : e.ep.last;
        var count = tk && tk.detection_count ? N(tk.detection_count) : e.ep.count;
        var tagTxt = e.finding || e.title;
        var conf = e.conf ? ' · ' + String(e.conf).replace(/^0?\.(\d\d).*/, '$1%') : '';

        var proof = e.image
          ? '<figure class="kjd-m-proof" data-kj-modal="' + esc(spec('image', e.image)) + '"' + seedAttr({ label: e.title }) + ' title="Open full-size proof">' +
              '<img src="' + esc(e.image) + '" alt="' + esc('Proof: ' + e.title) + '">' +
              '<span class="kjd-m-tag is-' + (s ? s[1] : m[2]) + '">' + esc(tagTxt + conf) + '</span>' +
              (camId ? '<span class="kjd-m-cap is-l">' + ico('cctv') + esc(camId + (e.zone ? ' · ' + e.zone : '')) + '</span>' : '') +
              '<span class="kjd-m-cap is-r">' + esc(e.ts ? new Date(e.ts).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) + ' ' + hms(e.ts) : '—') + '</span></figure>'
          : '<div class="kjd-m-proof is-empty">' + ico('image-off') + '</div>';
        var imgs = [[e.image, 'Trigger'], [e.imageBk, 'Scene'], [e.imageMatch, 'Enrolled']].filter(function (x) { return x[0]; });
        var thumbs = imgs.length > 1 ? '<div class="kjd-m-thumbs">' + imgs.map(function (x) {
          return '<button type="button" data-kj-modal="' + esc(spec('image', x[0])) + '"' + seedAttr({ label: e.title + ' · ' + x[1] }) + '><img src="' + esc(x[0]) + '" alt="' + esc(x[1]) + '" loading="lazy"><span>' + esc(x[1]) + (isWebp(x[0]) ? ' · webp' : '') + '</span></button>';
        }).join('') + '</div>' : '';

        var who = e.personId ? h.link('person', e.personId, e.person || ('#' + e.personId), { name: e.person }) : esc(e.person || 'Unidentified');
        var kind = '<div class="kjd-m-kind"><span class="kj-chip is-' + m[2] + '">' + ico(m[1]) + esc(m[0] + (e.verdict ? ' · ' + e.verdict : (e.mod && e.mod !== 'face' ? ' violation' : ''))) + '</span>' +
          (s ? sevChip(e.sev) : '') + (es ? statusChip(e.status) : '') + (tk ? '<span class="kj-chip is-purple">' + ico('bot') + 'AI pipeline ticket</span>' : '') + '</div>';
        var grid = '<div class="kjd-m-grid">' +
          row('user-round', 'Person', who, true) +
          row('cctv', 'Camera', camId ? h.link('camera', camId, camId + (camName(camId) ? ' · ' + camName(camId) : '')) : '—', !!camId) +
          row('map-pin', 'Zone', [e.zone, e.raw && e.raw.plant].filter(Boolean).join(' · ')) +
          row('clock', 'First detected', first ? when(first) : '—') +
          row('history', 'Last detected', last ? when(last) : '—') +
          row('triangle-alert', 'Severity', s ? sevChip(e.sev) : '—', !!s) +
          row('list-checks', 'Status', es ? statusChip(e.status) + (e.raw && e.raw.assignee && e.raw.assignee !== 'Unassigned' ? ' <span class="kj-muted">· ' + esc(e.raw.assignee) + '</span>' : '') : (e.verdict || '—'), !!es) +
          row('ticket', 'Linked ticket', tkNo ? h.link('ticket', tkNo, tkNo) : '—', !!tkNo) +
          row('fingerprint', 'Event ID', String(e.uuid || e.id)) +
          (e.finding ? row('search', 'Finding', e.finding) : '') +
          '</div>';

        var strip = e.ep.items.length > 1 ? '<div class="kjd-m-strip">' + e.ep.items.slice(-12).map(function (x) {
          return '<button type="button" class="' + (x.id === e.id ? 'is-cur' : '') + '" data-kj-modal="' + esc(spec('event', x.id)) + '" title="' + esc(x.title + ' · ' + hms(x.ts)) + '">' +
            (x.image ? '<img src="' + esc(x.image) + '" alt="" loading="lazy">' : '<span class="kjd-m-noimg">' + ico(modOf(x.mod)[1]) + '</span>') + '<span>' + esc(hm(x.ts)) + '</span></button>';
        }).join('') + '</div>' : '';
        var span = '<div class="kjd-m-span"><div class="kjd-m-span-bar">' +
          '<span class="kjd-m-span-pt"><span>First</span><b>' + esc(hms(first)) + '</b></span>' +
          '<span class="kjd-m-span-line' + (count > 1 ? '' : ' is-single') + '"></span>' +
          '<span class="kjd-m-span-pt is-end"><span>Last</span><b>' + esc(hms(last)) + '</b></span></div>' +
          '<div class="kjd-m-span-meta"><span>' + ico('timer') + ' ' + esc(dur(last - first)) + '</span><span>· ' + fmtN(count) + ' detection' + (count === 1 ? '' : 's') + '</span>' +
          '<span>· ' + esc(e.personId ? 'same person, ≤10 min gaps' : 'same camera + type, ≤10 min gaps') + '</span>' + (tk ? '<span>· span from ' + esc(tk.ticket_no) + '</span>' : '') + '</div>' + strip + '</div>';

        var ai = tk ? '<div class="kjd-m-ai">' + ico('bot') + '<div><b>Auto-ticket ' + esc(tk.ticket_no) + '</b> raised by the PPE-forklift review pipeline — ' + esc(tk.priority || '') + ' priority, ' + esc(String(tk.status || '').replace('_', ' ')) +
          (tk.sla && tk.sla.resolution && tk.sla.resolution.state ? ', resolution SLA ' + esc(tk.sla.resolution.state) : '') + '. ' + h.link('ticket', tk.ticket_no, 'Open ticket') + '</div></div>' : '';

        var log = e.log.length ? '<ol class="kj-timeline">' + e.log.slice(-12).reverse().map(function (l) {
          var txt = l.note ? String(l.note).replace(/<[^>]+>/g, ' ') : ((l.kind || 'update') + (l.to ? ': ' + l.to : ''));
          return '<li>' + esc(txt) + '<div class="kj-timeline-time">' + esc([l.actor, when(toMs(l.at || l.created_at || l.ts))].filter(Boolean).join(' · ')) + '</div></li>';
        }).join('') + '</ol>' : h.empty('history', 'No activity yet', 'Acknowledgements, comments and escalations appear here.');

        var canTri = e.inApp && can('triage');
        var foot = '';
        if (canTri && e.status === 'open') foot += h.btn('ack', 'Acknowledge', 'check');
        if (canTri && e.status !== 'resolved' && e.status !== 'closed') foot += h.btn('resolve', 'Resolve', 'check-check');
        if (canTri && e.status !== 'resolved' && (!e.raw.assignee || e.raw.assignee === 'Unassigned')) foot += h.btn('assign', 'Assign to me', 'user-check');
        if (camId) foot += h.btn('cam', 'Camera', 'cctv');
        if (e.uuid) foot += '<button type="button" class="kj-btn kj-btn-ghost kj-btn-sm" data-kj-playback="' + esc(e.uuid) + '">' + ico('film') + 'Playback</button>';   // agent B: assets/js/kj-playback.js
        if (e.inApp) foot += h.btn('full', 'Incident workspace', 'external-link');
        if (tkNo) foot += h.btn('ticket', 'Open ticket', 'ticket', 'kj-btn-primary');
        else if (e.inApp && can('tickets') && appRef() && typeof appRef().makeTicket === 'function') foot += h.btn('raise', 'Raise ticket', 'ticket', 'kj-btn-primary');
        foot += '<button type="button" class="kj-btn kj-btn-secondary" data-kj-close>Close</button>';

        var triage = function (fnName, msg) {
          return function (c) {
            var a = appRef(); if (!a || typeof a[fnName] !== 'function') { toast('Dashboard is still loading — try again.', 'warn'); return; }
            a[fnName](e.uuid || e.id); toast(msg, 'success'); Lead.dirty = true; c.reload();
          };
        };
        return {
          title: e.title, kicker: m[0] + ' · detection details', icon: m[1], tone: s ? s[1] : m[2],
          body: kind + proof + thumbs + grid + h.section('Timeline · first → last', span) + ai + (e.raw && e.raw.policyDesc ? h.section('Policy', '<div class="kj-card-flat kj-text-2">' + esc(e.raw.policyDesc) + '</div>') : '') + h.section('Activity', log),
          foot: foot,
          actions: {
            ack: triage('ack', 'Acknowledged'), resolve: triage('resolve', 'Marked resolved'), assign: triage('assign', 'Assigned to you'),
            cam: function () { M.open('camera', camId); },
            ticket: function () { M.open('ticket', tkNo); },
            raise: function (c) { var a = appRef(); if (a && typeof a.makeTicket === 'function') { a.makeTicket(e.uuid || e.id); toast('Ticket requested', 'success'); setTimeout(function () { c.reload(); }, 1200); } },
            full: h.viaApp(function (a) { var ev = appEvent(e.uuid || e.id); if (!ev) return; if (ev.ticket) a.openTicket(ev); else a.openModal('event', ev); })
          }
        };
      }
    });
    return true;
  }
  if (!registerEventModal()) {
    var tries = 0;
    var later = function () { if (!registerEventModal() && tries++ < 40) setTimeout(later, 100); };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', later); else setTimeout(later, 0);
  }
})();
