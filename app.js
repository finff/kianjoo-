class Component extends DCLogic {
  constructor(props){
    super(props);
    const now = Date.now();
    this.MODS = {
      fire: {tag:'FIRE', tagBg:'var(--high)'},
      ppe:  {tag:'PPE',  tagBg:'var(--gold)'},
      intr: {tag:'INTR', tagBg:'var(--crit)'},
      face: {tag:'FACE', tagBg:'var(--low)'},
      forklift: {tag:'FORKLIFT', tagBg:'var(--high)'},
    };
    this.SEV = {critical:'var(--crit)', high:'var(--high)', medium:'var(--med)', low:'var(--low)'};
    // Theme survives refresh via localStorage (falls back to prop/light).
    let savedTheme=null; try{ savedTheme=localStorage.getItem('tmns-theme'); }catch(e){}
    // Sidebar collapse survives refresh too; first visit on a narrow window starts collapsed.
    let savedSide=null; try{ savedSide=localStorage.getItem('tmns-side'); }catch(e){}
    this.state = {
      theme: (savedTheme==='light'||savedTheme==='dark') ? savedTheme : (props.defaultTheme || 'light'),
      sideCollapsed: savedSide==='1' || (savedSide===null && typeof window!=='undefined' && window.innerWidth<1100),
      now,
      filter: 'all',
      paused: false,
      selectedId: null,
      infLoad: 72,
      gridCols: 2,
      page: 'overview',                               // default page: AI Factory Monitoring overview
      incFilter: 'all',
      incSel: 1,
      camFilter: 'all',
      camQuery: '',
      aRange: '24h',
      live: {},              // KPI meta from the live feed
      trend: [],             // 24h hourly detection buckets
      byType: {}, byCam: {}, // analytics breakdowns
      ai: null,              // weststar-ai LLM analytics summary
      ppe: null, gpu: [], fleet: [], liveBase: '', liveToken: '', liveHidden: [],
      lightbox: null,        // {url,label} when an image is expanded
      modal: null,           // {type, data} active modal
      search: '',            // topbar search query
      ppeFilter: 'both',     // both | ppe | non
      addCam: {name:'', rtsp:'', busy:false, msg:''},
      events: [],            // incidents — populated live from /feed.php
      faceR: null,           // Face & Body 24h attribute report (feed.face)
      metrics: null,         // incident response-time metrics (feed.metrics)
      report: null,          // per-module dashboard report (feed.report)
      incSev: 'all',         // incidents severity filter
      camSel: '',            // camera detail page: selected stream label
      camEdit: {},           // camera detail edit drafts
      camMsg: '',            // camera detail save status
      armed: null,           // intrusion armed-window state (feed.armed)
      mail: null,            // email-alert channel config (feed.mail)
      notifOpen: false,      // bell dropdown visibility
      notifSeen: {},         // event ids the user has seen (bell mark-read)
      find: {gender:'', age:'', tops_color:'', mask:'', vest:'', hours:24,
             busy:false, ran:false, results:null},   // find-people search
      alertCfg: null,        // /api/alerts settings (Alert Rules page)
      alertMsg: '',          // save-status line on Alert Rules
      arMailDraft: null,     // recipients input draft
      appCfg: null,          // /api/settings (Settings page)
      appDraft: {},          // Settings input drafts
      appMsg: '',            // save-status line on Settings
      policies: [],          // per-camera policy matrix (feed.policies)
      camMsg: '',            // status line for the Live-view camera toggle
      purgeArmed: false,     // danger zone: purge button awaiting confirmation
      purgeBusy: false,
      purgeMsg: '',
      spRepDraft: null,      // report recipients draft
      fcData: null, fcBusy: false, fcDays: 14,   // Forecast page
      incEl: 'all', incCam: 'all',               // incidents: elapsed + camera filters
      sla: null,                                 // SLA targets from feed
      tktTab: 'comm', tktLog: null, tktFiles: null, tktNear: null,   // incident-ticket modal
      tktNote: '', tktRemark: '', tktMsg: '',
      tktCloseType: 'Issue resolved',                 // closure classification
      tktCommPage: 0, tktHistPage: 0, incPage: 0,     // pagination
      incQ: '', incSort: {k:'tsMs', d:-1},            // incidents table search + sort
      incPS: 10,                                      // incidents rows per page
      evGalTab: 'faces',                              // face modal gallery tab: faces | scenes
      evPerson: null,                                 // {id, loading, rows[]} — all captures of the person in the open face event
      people: {rows:[], profiles:{}, loading:false, msg:''},   // unique tracked people + enrolled profiles
      searchPid: null,                                // global search: person id resolved from the server
      pf: null,                                       // person-profile form {personId, name, age, gender, about, photo, shots[], msg}
      pplTab: 'unknown',                              // People roster tab: unknown | registered
      // Floating assistant (Weststar AI agent — RAG docs + live /api/ai data)
      asOpen: false, asBusy: false, asDraft: '', asErr: '',
      asMsgs: [],                                     // [{role:'user'|'bot', text, cites:[]}]
      tktHistQ: '', tktHistSort: {k:'created', d:1},  // history table filter + sort
      umUsers: null, umRoles: null, umPerms: {},      // user & role management
      umMsg: '', umDraft: {}, umNewRole: {name:'', desc:''},
      umTab: 'users',                                 // users | roles sub-tab
      spTab: 'sense',                                 // settings tab: sense|api|notify|ai|reports|models|poc
      // Attendance & movement (POC Use Case 1 — via /api/attendance)
      att: null,                                      // {known[], unknown[], days, inactivity_min, …}
      attBusy: false, attDays: 1, attQ: '', attErr: '',
      jn: null,                                       // journey modal {personId, loading, data, name, staffId, photo}
      attView: 'register',                            // register | employees | live | reports
      reg: {date:'', plant:'', dept:'', q:'', status:'', busy:false, err:'', data:null},   // official register (/api/attendance/daily)
      rep: {from:'', to:'', person:''},               // Reports tab range + employee
      empQ: '', empMsg: '', empBusy: false,           // Employees tab
      attShiftDraft: null, attListDraft: {},          // Settings → Attendance drafts
      ppeF: {from:'', to:'', plant:'', location:'', camera:'', item:'', busy:false, err:''},   // PPE compliance filters
      ppeD: null,                                     // /api/ppe/summary result
      raF: {from:'', to:'', plant:'', camera:'', verdict:'', status:'', busy:false, err:''},   // restricted-area filters
      raD: null, raMsg: '', raDraft: {},              // /api/restricted/summary result · review msg · zone drafts
      clF: {from:'', to:'', plant:'', location:'', item:'', busy:false, err:''},   // cleaning filters
      clD: null, clMsg: '', clDraft: null, clTab: 'overview',   // /api/cleaning/summary · status · schedule editor draft · tab
      plant: '', plants: [],                          // global plant filter ('' = all) · feed.plants [{name, online, total}]
      ov: null, ovBusy: false, ovErr: '',             // /api/overview result (Overview page)
      fkF: {from:'', to:'', plant:'', camera:'', verdict:'', status:'', busy:false, err:''},   // forklift filters
      fkD: null, fkMsg: '', fkDraft: {},              // /api/forklift/summary result · review msg · zone drafts
    };
    this._over = {};         // local triage overrides (ack/assign) keyed by id
    this.API = (window.TMNS && window.TMNS.api) || '/api';
    this.TOK = (window.TMNS && window.TMNS.token) || '';
    // Logged-in user (injected by index.php after login) → audit-log actor.
    this.ME    = (window.TMNS && window.TMNS.user) || null;
    this.UNAME = (this.ME && this.ME.name) || 'Operator';
    this.PERMS = (this.ME && this.ME.perms) || {};
    // Demo mode (localStorage): show dummy sample data instead of live feed.
    try { this.state.demo = localStorage.getItem('tmns_demo')==='1'; } catch(e){ this.state.demo=false; }
    this.camPool = this.buildCamPool();  // placeholder tiles until live cams arrive
  }

  // ── Demo mode ────────────────────────────────────────────
  toggleDemo(){
    const on=!this.state.demo;
    try{ localStorage.setItem('tmns_demo', on?'1':'0'); }catch(e){}
    if(on){ this.applyDemo(); }
    else { this._reportJson=null; this._faceJson=null; this._over={};
      this.setState({demo:false, events:[], faceR:null, report:null, metrics:null, ppe:null});
      this.camPool=this.buildCamPool(); this.fetchFeed(); }
  }
  applyDemo(){
    const now=Date.now();
    this.camPool=this.buildCamPool();
    this.setState({demo:true, events:this.seedEvents(now),
      faceR:this.demoFace(), report:null, metrics:this.demoMetrics(),
      ppe:this.demoPpe(), gpu:this.demoTrend().map((b,i)=>36+ (b.intr+b.fire+b.ppe+b.face)*7),
      trend:this.demoTrend(), byType:{intr:14,ppe:9,fire:5,face:22}, byCam:{'CAM-02':11,'CAM-11':8,'CAM-04':7,'CAM-15':5},
      live:{camsOnline:6,camsTotal:6,ppePct:88,ppeOpen:3,openHour:3,avgAck:'1:24'}});
    this.scheduleCharts();
  }
  demoTrend(){ const s=[1,0,1,0,2,1,3,2,4,3,5,4,6,5,4,6,7,5,4,3,2,4,5,6];
    return s.map(v=>({intr:Math.round(v*0.4), ppe:Math.round(v*0.25), fire:Math.round(v*0.12), face:Math.round(v*0.6)})); }
  demoMetrics(){ return {mtta:84, mttr:372, resolved24h:71, matrix:[
    {severity:'Severe',count:4,open:1,ack:1,resolved:2,mtta:42,mttr:210},
    {severity:'High',count:12,open:3,ack:4,resolved:5,mtta:66,mttr:330},
    {severity:'Medium',count:23,open:5,ack:8,resolved:10,mtta:96,mttr:402},
    {severity:'Low',count:31,open:6,ack:10,resolved:15,mtta:128,mttr:540}]}; }
  demoPpe(){ return {wearing:34,missing:6,total:40,pct:85,list:[
    {person:'Adult Male',device:'CAM-04',time:'2026-07-07 09:12:03',vest:false,tops:'jacket',image:null},
    {person:'Adult Male',device:'CAM-09',time:'2026-07-07 09:05:41',vest:true,tops:'shirt',image:null},
    {person:'Old Female',device:'CAM-04',time:'2026-07-07 08:58:20',vest:false,tops:'coat',image:null}]}; }
  demoFace(){ return {total:184, hourly:this.demoTrend().map(b=>b.face),
    byCam:{'CAM-07':52,'CAM-02':41,'CAM-11':33,'CAM-04':28}, gender:{Male:118,Female:66}, age:{Adult:132,Old:34,Child:18},
    topsColor:{Black:44,White:31,Blue:27,Gray:22,Red:14}, topsType:{'T-Shirt':40,Jacket:28,Shirt:22},
    mask:{NoMask:150,WithMask:34}, vest:{NoReflectiveVest:158,ReflectiveVest:26}, hats:{NoHat:120,Cap:38,Helmet:26}}; }
  demoReport(mod){ const t=this.demoTrend();
    const H={fire:t.map(b=>b.fire), ppe:t.map(b=>b.ppe), intr:t.map(b=>b.intr)}[mod]||t.map(b=>b.intr);
    const attr={fire:{Smoking:{IsSmoking:4,NoSmoking:38,Unknown:2}},
      ppe:{WithReflectiveVest:{ReflectiveVest:26,NoReflectiveVest:14},HatsType:{NoHat:22,Cap:12,Helmet:6},WithMask:{WithMask:18,NoMask:22}},
      intr:{Gender:{Male:31,Female:12},Angle:{Front:20,Side:15,Back:8}}}[mod]||{};
    return {mod, total:H.reduce((a,b)=>a+b,0), open:Math.round(H.reduce((a,b)=>a+b,0)*0.3), avgConf:0.91,
      hourly:H, byCam:{'CAM-02':11,'CAM-11':8,'CAM-04':6,'CAM-15':4}, bySeverity:{Low:12,Medium:9,High:6,Severe:2}, attr}; }

  // Apply live-stream URLs to <video data-src> only when visible (avoids the
  // pre-hydration {{…}} fetch, and stops hidden streams from playing).
  mountVideos(){
    try{
      const play=(v)=>{ const p=v.play&&v.play(); if(p&&p.catch)p.catch(()=>{}); };
      // Tiles that other tiles mirror must be fetched in CORS mode, or
      // captureStream() throws SecurityError on the cross-origin bridge.
      // (go2rtc answers with Access-Control-Allow-Origin: *.)
      const sources={};
      document.querySelectorAll('video[data-mirror]').forEach(v=>{
        const m=v.getAttribute('data-mirror')||'';
        if(m && m.indexOf('{{')<0) sources[m]=1;
      });
      document.querySelectorAll('video[data-src]').forEach(v=>{
        const cam=v.getAttribute('data-cam')||'';
        if(sources[cam] && v.crossOrigin!=='anonymous'){
          v.crossOrigin='anonymous';                 // must precede src assignment
          if(v.src){ v._src=''; v.removeAttribute('src'); if(v.load)v.load(); }
        }
        const s=v.getAttribute('data-src')||'';
        const visible = v.offsetParent!==null && s && s.indexOf('{{')<0;
        // A tile that shares its camera with an earlier tile mirrors that
        // element's decoded frames (captureStream) instead of opening a second
        // connection to the bridge. Falls back to its own URL where the browser
        // has no captureStream, or while the source tile is still buffering.
        const mid = v.getAttribute('data-mirror')||'';
        if(visible && mid && mid.indexOf('{{')<0){
          const src=document.querySelector('video[data-cam="'+mid+'"]');
          if(src && typeof src.captureStream==='function'){
            const live = v.srcObject && v.srcObject.active!==false && v._mirror===mid;
            if(!live && src.readyState>=2){
              try{
                if(v.src){ v._src=''; v.removeAttribute('src'); if(v.load)v.load(); }
                v.srcObject=src.captureStream(); v._mirror=mid; play(v);
              }catch(e){ v._mirror=''; }
            }
            if(v._mirror===mid) return;              // mirrored — nothing else to do
          }
        } else if(v.srcObject){                      // no longer a mirror
          v.srcObject=null; v._mirror='';
        }
        if(visible){
          if(v._src!==s){ v._src=s; v._stall=0; v._lastCt=-1; v.src=s; play(v); return; }
          if(document.hidden) return;
          // Stall watchdog: mp4-over-http streams die silently — the element
          // keeps showing the last frame while currentTime stops advancing.
          // Reconnect after ~6s of no progress.
          const ct=v.currentTime||0;
          if(ct===v._lastCt){ v._stall=(v._stall||0)+1; } else { v._stall=0; v._lastCt=ct; }
          if(v._stall>=6){ v._stall=0; v._lastCt=-1;
            v.src=s+(s.indexOf('?')>=0?'&':'?')+'_r='+Date.now(); play(v); }
        }
        else if(v.src){ v._src=''; v.removeAttribute('src'); if(v.load)v.load(); }
      });
    }catch(e){}
  }

  buildCamPool(){
    const featured=[
      {id:'CAM-02', name:'North Perimeter', zone:'ZONE-N · Exterior', mod:'intr', res:'1080p', fps:25,
       scene:'linear-gradient(160deg,#0b1512,#132018 60%,#0a110d), radial-gradient(120% 90% at 70% 10%, rgba(77,166,255,.08), transparent 55%)',
       boxes:[{top:'30%',left:'52%',w:'15%',h:'44%',sev:'critical',label:'PERSON 0.94'}]},
      {id:'CAM-11', name:'Boiler Room', zone:'ZONE-B · Level 1', mod:'fire', res:'1080p', fps:25,
       scene:'linear-gradient(160deg,#1a120a,#241608 55%,#120c05), radial-gradient(90% 80% at 40% 70%, rgba(255,138,61,.16), transparent 55%)',
       boxes:[{top:'40%',left:'26%',w:'34%',h:'40%',sev:'high',label:'SMOKE 0.88'}]},
      {id:'CAM-04', name:'Loading Bay', zone:'ZONE-L · Dock 3', mod:'ppe', res:'1440p', fps:30,
       scene:'linear-gradient(160deg,#0f1420,#161d2c 55%,#0b0f18), radial-gradient(100% 80% at 60% 20%, rgba(253,191,87,.08), transparent 55%)',
       boxes:[{top:'26%',left:'40%',w:'16%',h:'50%',sev:'medium',label:'NO-HELMET 0.91'}]},
      {id:'CAM-07', name:'Main Entrance', zone:'ZONE-E · Lobby', mod:'face', res:'1080p', fps:30,
       scene:'linear-gradient(160deg,#0e1119,#151824 55%,#0a0d14), radial-gradient(110% 90% at 30% 15%, rgba(77,166,255,.07), transparent 55%)',
       boxes:[{top:'32%',left:'22%',w:'13%',h:'42%',sev:'low',label:'FACE 0.86'},{top:'34%',left:'58%',w:'13%',h:'40%',sev:'low',label:'FACE 0.79'}]},
    ];
    const names=['Welding Bay','Fuel Store','Yard Gate B','Paint Store','Server Room','Cold Store','Assembly Line','Car Park P2','Rooftop HVAC','Waste Dock','Corridor C','Substation'];
    const zones=['ZONE-W','ZONE-F','ZONE-Y','ZONE-P','ZONE-S','ZONE-C','ZONE-A','ZONE-K','ZONE-R','ZONE-D','ZONE-H','ZONE-G'];
    const mods=['ppe','intr','fire','face'];
    const scenes=[
      'linear-gradient(160deg,#0f1420,#161d2c 55%,#0b0f18)',
      'linear-gradient(160deg,#12110e,#1d1a14 55%,#0d0c09)',
      'linear-gradient(160deg,#0b1512,#132018 60%,#0a110d)',
      'linear-gradient(160deg,#0e1119,#151824 55%,#0a0d14)',
    ];
    const extra=[];
    for(let i=0;i<12;i++){
      const mod=mods[i%4];
      const hasBox=i%3===0;
      const sev=mod==='intr'?'high':mod==='fire'?'high':mod==='ppe'?'medium':'low';
      extra.push({
        id:'CAM-'+String(20+i).padStart(2,'0'), name:names[i], zone:zones[i]+' · Sector '+(1+i%4),
        mod, res:'1080p', fps:i%2?25:30, scene:scenes[i%4],
        boxes: hasBox?[{top:'34%',left:(28+i%3*18)+'%',w:'15%',h:'42%',sev,label:mod.toUpperCase()+' 0.8'+(i%9)}]:[],
      });
    }
    return [...featured, ...extra];
  }

  // Live Feeds tiles = the VisionAI device registry (st.fleet), so every
  // registered camera gets a tile even when it has produced no detections yet.
  // Where a camera does have a recent detection (this.camPool, keyed by stream
  // /serial) we reuse its frame, module and bounding box. Online cameras first.
  livePool(){
    const st=this.state;
    const pool=Array.isArray(this.camPool)?this.camPool:[];
    const fleet=Array.isArray(st.fleet)?st.fleet:[];
    if(!fleet.length) return pool;              // demo mode / registry unavailable
    const up=v=>String(v||'').toUpperCase();
    const byKey={};
    pool.forEach(c=>{ if(c.stream) byKey[up(c.stream)]=c; if(c.serial) byKey[up(c.serial)]=c; if(c.id) byKey[up(c.id)]=c; });
    const tiles=fleet.map(f=>{
      const cp=byKey[up(f.stream)]||byKey[up(f.serial)]||null;
      const img=f.image||(cp?cp.img:null);
      // Boxes only make sense over the frame they were drawn on.
      const boxes=(cp && img && cp.img===img)?(cp.boxes||[]):[];
      return {
        id:up(f.stream||f.serial||'CAM'), stream:f.stream||'', serial:f.serial||'',
        // Two VisionAI devices can share one physical camera (a face policy and
        // a body-attribute policy on the same NVR channel). Carrying the RTSP
        // URL lets the grid decode that camera once and mirror it.
        rtsp:f.rtsp||'',
        name:f.name||f.serial||'Camera', zone:(cp&&cp.zone)||f.type||'—',
        mod:(cp&&cp.mod)||'intr', res:(cp&&cp.res)||'1440p',
        fps: f.online?((cp&&cp.fps)||25):0, online:!!f.online,
        scene: img?("url('"+img+"') center/cover no-repeat"):'linear-gradient(160deg,#0e1119,#151824 55%,#0a0d14)',
        img, boxes,
      };
    });
    // Cameras that push detections but aren't in the registry listing (e.g.
    // tmlab1) still deserve a tile — append whatever the fleet didn't cover.
    const covered={};
    fleet.forEach(f=>{ if(f.stream) covered[up(f.stream)]=1; if(f.serial) covered[up(f.serial)]=1; });
    pool.forEach(c=>{
      if(!c.stream && !c.serial) return;           // seeded demo cams have neither
      if(covered[up(c.stream)]||covered[up(c.serial)]||covered[up(c.id)]) return;
      tiles.push({id:up(c.id||c.stream), stream:c.stream||'', serial:c.serial||'',
        name:c.name, zone:c.zone, mod:c.mod, res:c.res, fps:c.fps, online:true,
        scene:c.scene, img:c.img, boxes:c.boxes||[]});
    });
    tiles.sort((a,b)=>(b.online-a.online)||((b.img?1:0)-(a.img?1:0)));
    return tiles.filter(t=>!this.isLiveHidden(t));
  }

  // ── Per-camera "show on Live Monitoring" toggle (server-persisted) ──
  liveKey(c){ return String((c&&(c.stream||c.serial||c.id))||'').toLowerCase(); }
  isLiveHidden(c){
    const k=this.liveKey(c);
    return !!k && (this.state.liveHidden||[]).indexOf(k)>=0;
  }
  toggleLiveCam(c, ev){
    if(ev&&ev.stopPropagation) ev.stopPropagation();
    const k=this.liveKey(c);
    if(!k) return;
    const prev=(this.state.liveHidden||[]).slice();
    const i=prev.indexOf(k);
    const hiding=i<0;
    const cur=hiding?prev.concat([k]):prev.filter(x=>x!==k);
    const fail=()=>{ this._hidePending=false; this.setState({liveHidden:prev, camMsg:'Save failed'}); };
    this._hidePending=true;                       // poll must not overwrite this
    this.setState({liveHidden:cur, camMsg:(hiding?'Hidden from Live Monitoring':'Shown on Live Monitoring')});
    fetch(`${this.API}/settings?token=${this.TOK}`, {method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({live_hidden:cur})})
      .then(r=>r.json())
      .then(d=>{ if(d&&d.ok){ this._hidePending=false; } else fail(); })
      .catch(fail);
    if(this._cmT) clearTimeout(this._cmT);
    this._cmT=setTimeout(()=>this.setState({camMsg:''}), 2500);
  }

  seedEvents(now){
    const s=1000;
    return [
      {id:1, mod:'intr', sev:'critical', camera:'CAM-02', zone:'North Perimeter', title:'Unauthorized entry in restricted zone', ts:now-14*s, status:'open', assignee:'Aidil R.'},
      {id:2, mod:'fire', sev:'high', camera:'CAM-11', zone:'Boiler Room', title:'Smoke density rising above threshold', ts:now-48*s, status:'open', assignee:'Aidil R.'},
      {id:3, mod:'ppe', sev:'medium', camera:'CAM-04', zone:'Loading Bay', title:'Worker without hard hat detected', ts:now-95*s, status:'open', assignee:'Aidil R.'},
      {id:4, mod:'face', sev:'low', camera:'CAM-07', zone:'Main Entrance', title:'Unrecognized individual · loitering 2m+', ts:now-180*s, status:'ack', assignee:'Aidil R.'},
      {id:5, mod:'ppe', sev:'medium', camera:'CAM-09', zone:'Welding Bay', title:'Missing safety vest — 2 personnel', ts:now-320*s, status:'ack', assignee:'Nadia K.'},
      {id:6, mod:'intr', sev:'high', camera:'CAM-15', zone:'Fuel Store', title:'Perimeter breach after hours', ts:now-540*s, status:'resolved', assignee:'Nadia K.'},
    ];
  }

  componentDidMount(){
    this.clockT = setInterval(()=>{ this.setState({now:Date.now()}); this.mountVideos(); }, 1000);
    if(this.state.demo){ this.applyDemo(); } else { this.fetchFeed(); }
    this._tick = 0;
    this.pollT = setInterval(()=>{
      if(!this.state.paused && !this.state.demo) this.fetchFeed();
      this._tick++;
      if(this._tick%6===0 && this.state.page==='overview' && !this.state.paused) this.loadOverview();   // every 30 s
    }, 5000);
    // ⌘K / Ctrl-K focuses search; Esc closes modal/lightbox.
    this._keys = (e)=>{
      if((e.metaKey||e.ctrlKey) && (e.key==='k'||e.key==='K')){ e.preventDefault(); const el=document.getElementById('tmns-search'); if(el) el.focus(); }
      if(e.key==='Escape'){ if(this.state.lightbox) this.closeLightbox(); else if(this.state.modal) this.closeModal(); else if(this.state.search) this.setSearch(''); }
    };
    document.addEventListener('keydown', this._keys);
    // ── Hash routing: restore page on load + refresh; sync Back/Forward ──
    const initial=this.pageFromHash();
    if(initial==='camera'){ const cs=this.camSelFromHash(); if(cs){ this.setState({camSel:cs}); this.applyPage('camera'); } }
    else if(initial && initial!==this.state.page){ this.applyPage(initial); }
    if((initial||this.state.page)==='overview') this.loadOverview();   // default page has no applyPage call
    try{ history.replaceState({page:initial||this.state.page}, '', location.hash||('#'+(initial||this.state.page))); }catch(e){}
    this._pop=()=>{ const p=this.pageFromHash()||'overview';
      if(p==='camera'){ const cs=this.camSelFromHash(); this.setState({camSel:cs}); this.applyPage('camera'); }
      else if(p!==this.state.page){ this.applyPage(p); } };
    window.addEventListener('popstate', this._pop);
  }
  componentWillUnmount(){ clearInterval(this.clockT); clearInterval(this.pollT); if(this._keys) document.removeEventListener('keydown', this._keys); if(this._pop) window.removeEventListener('popstate', this._pop); }

  // Pull live SenseTime detections from the same-origin feed and map them into
  // the incident + camera-tile shapes the UI already renders.
  fetchFeed(){
    if(this.state.demo) return;   // demo mode shows dummy data, not the live feed
    let url = (window.TMNS && window.TMNS.feed) || '/feed.php';
    // Ask for the per-module report when on a Fire/PPE/Intrusion page.
    const p = this.state.page;
    if(p==='fire'||p==='ppe'||p==='intr'){ url += (url.indexOf('?')>=0?'&':'?') + 'report=' + p; }
    fetch(url, {cache:'no-store'})
      .then(r => r.json())
      .then(d => {
        if(!d || !d.ok) return;
        // Server↔client clock offset — box expiry compares server event times.
        if(typeof d.server_now==='number') this._skew = d.server_now - Date.now();
        // A deploy changed the app files → offer a reload (this tab runs old code).
        if(d.build && window.TMNS && window.TMNS.build && d.build!==window.TMNS.build && !this.state.newBuild)
          this.setState({newBuild:true});
        // Live mode owns the pool outright — an empty list means "no camera has
        // reported a detection", not "keep the seeded demo cameras".
        if(Array.isArray(d.cams)) this.camPool = d.cams;
        // Re-apply local triage actions on top of freshly fetched incidents.
        const events = (Array.isArray(d.events)?d.events:[]).map(e =>
          this._over[e.id] ? {...e, ...this._over[e.id]} : e);
        this.setState({
          events, live: d.meta || {},
          trend: Array.isArray(d.trend)?d.trend:[],
          byType: d.byType || {}, byCam: d.byCam || {}, ai: d.ai || null,
          ppe: d.ppe || null, gpu: Array.isArray(d.gpu)?d.gpu:[],
          fleet: Array.isArray(d.fleet)?d.fleet:[], liveBase: d.liveBase || '', liveToken: d.liveToken || '',
          // Don't clobber an in-flight local toggle with a stale poll response.
          liveHidden: this._hidePending ? this.state.liveHidden : (Array.isArray(d.liveHidden)?d.liveHidden:[]),
          policies: Array.isArray(d.policies)?d.policies:[],
          people: {...this.state.people, profiles: (d.profiles && typeof d.profiles==='object') ? d.profiles : this.state.people.profiles},
          faceR: d.face || null, armed: d.armed || null, mail: d.mail || null,
          metrics: d.metrics || null, report: d.report || null,
          sla: d.sla || null,
          plants: Array.isArray(d.plants)?d.plants:[],
          // Inference load = server-derived from detection throughput (feed.gpu),
          // not a random number. VisionAI's API exposes no true GPU metric.
          infLoad: (Array.isArray(d.gpu)&&d.gpu.length)?d.gpu[d.gpu.length-1]:this.state.infLoad,
        });
        // Redraw the Face & Body report only when its data actually changed.
        const fj = JSON.stringify(d.face || null);
        if(this.state.page==='face' && fj !== this._faceJson){ this._faceJson = fj; this.scheduleCharts(); }
        // Redraw a module dashboard (fire/ppe/intr) when its report changes.
        const rj = JSON.stringify(d.report || null);
        if((p==='fire'||p==='ppe'||p==='intr') && rj !== this._reportJson){ this._reportJson = rj; this.scheduleCharts(); }
      })
      .catch(()=>{});
  }

  toggleSide(){
    const v=!this.state.sideCollapsed;
    try{ localStorage.setItem('tmns-side', v?'1':'0'); }catch(e){}
    this.setState({sideCollapsed:v}); }
  toggleTheme(){
    const next=this.state.theme==='dark'?'light':'dark';
    try{ localStorage.setItem('tmns-theme', next); }catch(e){}
    this.setState({theme:next}); this.scheduleCharts(); this.scheduleFcCharts(); }
  setFilter(f){ this.setState({filter:f}); }
  setGrid(n){ this.setState({gridCols:n}); }
  // Switch page + run its side effects (no history push — used by nav & Back/Forward).
  applyPage(p){ this.setState({page:p});
    if(this.state.demo && (p==='fire'||p==='ppe'||p==='intr')){ this.setState({report:this.demoReport(p)}); }
    else if(p==='fire'||p==='ppe'||p==='intr'){ this._reportJson=null; this.fetchFeed(); }  // pull that module's report now
    if(p==='face'||p==='fire'||p==='ppe'||p==='intr') this.scheduleCharts();
    if(p==='face') this.loadPeople();
    if(p==='attendance'){ this.loadAttendance(); this.loadPeople(); this.loadRegister(); }
    if(p==='overview') this.loadOverview();
    if(p==='employees'){ this.loadPeople(); if(!this.state.reg.data) this.loadRegister(); }
    if(p==='faces') this.loadPeople();                // unknown / registered people roster
    if(p==='forklift'){ this.loadFk(); this.loadApp(); }
    if(p==='ppe'){ this.loadApp(); this.loadPpe(); }   // area rules + violation history
    if(p==='intr'){ this.loadRa(); }                   // restricted zones + entry review
    if(p==='cleaning'){ this.loadCl(); }               // cleaning schedules + PPE during cleaning
    if(p==='rules') this.loadAlerts();
    if(p==='settings'){ this.loadApp(); this.loadAlerts(); }
    if(p==='forecast') this.loadForecast();
    if(p==='users'){ this.loadUsers(); this.loadRoles(); } }
  // Nav click → navigate + push a browser history entry (URL hash) so refresh + Back work.
  setPage(p){ if(p===this.state.page) return; this.applyPage(p); try{ history.pushState({page:p}, '', '#'+p); }catch(e){} }
  pageFromHash(){ const P=['overview','live','attendance','employees','faces','forklift','incidents','cameras','analytics','forecast','fire','ppe','cleaning','intr','face','rules','settings','users','camera'];
    const raw=(location.hash||'').replace(/^#\/?/,''); const h=raw.split('/')[0]; return P.indexOf(h)>=0?h:null; }
  camSelFromHash(){ const raw=(location.hash||'').replace(/^#\/?/,''); const s=raw.split('/'); return s[0]==='camera'?decodeURIComponent(s[1]||''):''; }
  // Open a camera's detail page (live stream + VisionAI config + edit).
  openCamera(stream){ if(!stream) return;
    const f=(this.state.fleet||[]).find(x=>x.stream===stream)||{};
    this.setState({page:'camera', camSel:stream, camMsg:'', camEdit:{name:f.name||'', rtsp:f.rtsp||'', tag:'', desc:''}});
    try{ history.pushState({page:'camera'}, '', '#camera/'+encodeURIComponent(stream)); }catch(e){} }
  setCamEdit(patch){ this.setState(s=>({camEdit:{...s.camEdit, ...patch}})); }
  saveCamera(){ const stream=this.state.camSel;
    const f=(this.state.fleet||[]).find(x=>x.stream===stream);
    if(!f || !f.did){ this.setState({camMsg:'✗ No VisionAI device id for this camera — cannot update.'}); return; }
    const e=this.state.camEdit||{}; this.setState({camMsg:'Saving to VisionAI…'});
    fetch(`${this.API}/cameras/${encodeURIComponent(f.did)}?token=${this.TOK}`,{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({name:e.name, rtsp:e.rtsp, tag:e.tag, desc:e.desc})})
      .then(r=>r.json()).then(d=>{ this.setState({camMsg: d&&d.ok?'✓ Updated in VisionAI':'✗ '+((d&&(d.msg||d.error))||'Update failed')});
        if(d&&d.ok) this.fetchFeed(); })
      .catch(()=>this.setState({camMsg:'✗ Network error'})); }
  setIncFilter(f){ this.setState({incFilter:f, incPage:0}); }
  setIncSev(s){ this.setState({incSev:s, incPage:0}); }
  selectInc(id){ this.setState({incSel:id}); }
  setCamFilter(f){ this.setState({camFilter:f}); }
  setRange(r){ this.setState({aRange:r}); }
  togglePaused(){ this.setState(s=>({paused:!s.paused})); }
  select(id){ this.setState({selectedId:id}); }
  // Triage actions persist locally (this._over) so they survive the 5s refetch.
  override(id, patch){ this._over[id] = {...(this._over[id]||{}), ...patch};
    this.setState(s=>({events:s.events.map(v=>v.id===id?{...v,...patch}:v)})); }
  // Persist triage to the server (records ack time → real avg-time-to-ack).
  postStatus(id, body){
    if(!this.TOK) return;
    fetch(`${this.API}/events/${encodeURIComponent(id)}/status?token=${this.TOK}`,
      {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)}).catch(()=>{});
  }
  ack(id,e){ if(e)e.stopPropagation(); this.override(id,{status:'ack'}); this.postStatus(id,{status:'ack'}); }
  resolve(id,e){ if(e)e.stopPropagation(); this.override(id,{status:'resolved'}); this.postStatus(id,{status:'resolved'}); }
  assign(id,e){ if(e)e.stopPropagation(); this.override(id,{status:'ack',assignee:'You'}); this.postStatus(id,{status:'ack',assignee:'You'}); }
  openLightbox(url,label){ if(url) this.setState({lightbox:{url,label:label||''}}); }

  // ── Floating assistant ───────────────────────────────────
  // Chat with the Weststar AI agent. The key stays server-side: the browser
  // posts to /api/assistant, which forwards to the agent. The agent answers
  // from its ingested docs and pulls live numbers from /api/ai/* itself.
  asToggle(){
    this.setState(st=>({asOpen:!st.asOpen, asErr:''}));
    setTimeout(()=>{ const i=document.getElementById('as-input'); if(i) i.focus();
      this.asBindDrop(); this.asScroll(); }, 60);
  }
  asSet(v){ this.setState({asDraft:v}); }
  asKey(e){ if(e && e.key==='Enter' && !e.shiftKey){ e.preventDefault(); this.asSend(); } }
  asScroll(){ const b=document.getElementById('as-body'); if(b) b.scrollTop=b.scrollHeight; }
  asAsk(q){ this.asSend(q); }                       // suggestion chips
  asSend(preset){
    const st=this.state;
    const text=String(preset!=null?preset:st.asDraft||'').trim();
    if(!text || st.asBusy) return;
    const msgs=[...st.asMsgs, {role:'user', text, cites:[]}];
    this.setState({asMsgs:msgs, asDraft:'', asBusy:true, asErr:''});
    setTimeout(()=>this.asScroll(), 30);
    // Only the turns themselves go upstream — the agent keeps its own context.
    const payload={messages: msgs.slice(-8).map(m=>({role:m.role==='bot'?'assistant':'user', content:m.text}))};
    fetch(`${this.API}/assistant?token=${this.TOK}`, {method:'POST',
      headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload)})
      .then(r=>r.json())
      .then(d=>{
        if(!(d && d.ok && d.answer)) throw new Error((d && d.error) || 'No answer came back.');
        this.setState(s=>({asMsgs:[...s.asMsgs, {role:'bot', text:d.answer, cites:d.citations||[]}], asBusy:false}));
        setTimeout(()=>this.asScroll(), 30);
      })
      .catch(e=>{ this.setState({asBusy:false, asErr:(e&&e.message)||'Could not reach the assistant.'});
        setTimeout(()=>this.asScroll(), 30); });
  }
  asClear(){ this.setState({asMsgs:[], asErr:'', asDraft:''}); }

  // Drag a photo onto the panel (or paste, or use the clip) → 1:N face search
  // in VisionAI. Native listeners bind once per node; dc-runtime keeps the
  // nodes across re-renders, same as the ticket drop zone.
  asBindDrop(){
    const p=document.getElementById('as-drop'), inp=document.getElementById('as-file'),
          box=document.getElementById('as-input');
    if(p && !p._tmns){ p._tmns=1;
      ['dragenter','dragover'].forEach(ev=>p.addEventListener(ev, e=>{ e.preventDefault(); e.stopPropagation();
        p.classList.add('as-dragging'); }));
      ['dragleave','drop'].forEach(ev=>p.addEventListener(ev, e=>{ e.preventDefault(); e.stopPropagation();
        p.classList.remove('as-dragging'); }));
      p.addEventListener('drop', e=>{ const f=e.dataTransfer&&e.dataTransfer.files&&e.dataTransfer.files[0];
        if(f) this.asSearchFace(f); });
    }
    if(inp && !inp._tmns){ inp._tmns=1;
      inp.addEventListener('change', ()=>{ const f=inp.files&&inp.files[0]; if(f) this.asSearchFace(f); inp.value=''; });
    }
    if(box && !box._tmns){ box._tmns=1;
      box.addEventListener('paste', e=>{ const it=[...((e.clipboardData&&e.clipboardData.files)||[])][0];
        if(it){ e.preventDefault(); this.asSearchFace(it); } });
    }
  }
  asBrowseShot(){ this.asBindDrop(); const el=document.getElementById('as-file'); if(el) el.click(); }
  asSearchFace(file){
    if(!file || this.state.asBusy) return;
    if(!/^image\/(jpeg|png|webp)$/.test(file.type||'')){
      this.setState({asErr:'Drop a JPG, PNG or WEBP photo of a face.'}); return; }
    if(file.size>6*1024*1024){ this.setState({asErr:'Image is larger than 6 MB.'}); return; }
    const shot=URL.createObjectURL(file);
    this.setState(st=>({asMsgs:[...st.asMsgs, {role:'user', text:'Search this face', img:shot, cites:[]}],
      asBusy:true, asErr:''}));
    setTimeout(()=>this.asScroll(), 30);
    const fd=new FormData(); fd.append('file', file);
    fetch(`${this.API}/face/search?token=${this.TOK}`, {method:'POST', body:fd})
      .then(r=>r.json())
      .then(d=>{
        if(!(d && d.ok)) throw new Error((d && d.error) || 'Face search failed.');
        const ms=d.matches||[];
        this.setState(st=>({asBusy:false, asMsgs:[...st.asMsgs, ms.length
          ? {role:'bot', kind:'faces', matches:ms, cites:[],
             text:'Found '+ms.length+' matching person'+(ms.length===1?'':'s')+' in the VisionAI libraries:'}
          : {role:'bot', text:'No face in the VisionAI libraries matched that photo. The person may not have been detected by these cameras yet.', cites:[]}]}));
        setTimeout(()=>this.asScroll(), 30);
      })
      .catch(e=>{ this.setState({asBusy:false, asErr:(e&&e.message)||'Face search failed.'});
        setTimeout(()=>this.asScroll(), 30); });
  }
  // Card actions: open the person's FR profile, or their full capture gallery.
  asOpenProfile(m){
    this.setPage('face');
    this.openProfile({personId:m.personId, image:m.photo});
  }
  asOpenCaptures(m){
    this.openModal('event', {
      id:m.eventUuid||('person-'+m.personId), mod:'face', feed:'face', sev:'low',
      camera:(m.cameras&&m.cameras[0])||'—', zone:'Face recognition',
      title:m.name?('Face match — '+m.name):('Person #'+m.personId),
      ts:Date.parse(String(m.lastSeen||'').replace(' ','T'))||Date.now(),
      status:'open', assignee:'Unassigned', image:m.photo, imageBk:null,
      imageMatch:m.registered?m.photo:null, person:m.name||'', personId:m.personId,
      similarity:String((m.score||0)/100), device:'', serial:'', policy:'Face recognition',
      triggerType:'', eventType:'', alertLevel:'', triggerTime:m.lastSeen||'',
      received:m.lastSeen||'', decoded:{}, ticket:null,
    });
  }

  // Unique tracked people (grouped by personId) for the People roster.
  loadPeople(){
    this.setState(st=>({people:{...st.people, loading:true}}));
    fetch(`${this.API}/persons?token=${this.TOK}&days=7&limit=200`, {cache:'no-store'})
      .then(r=>r.json())
      .then(d=>{ if(!(d&&d.ok)) throw new Error('bad');
        this.setState({people:{rows:d.people||[], profiles:d.profiles||{}, loading:false, msg:''}}); })
      .catch(()=>this.setState(st=>({people:{...st.people, loading:false, msg:'Could not load people'}})));
  }

  // Open the profile editor for a tracked person, pre-filled when one exists.
  // Capture thumbnails are pulled so the operator can pick the profile picture.
  openProfile(person){
    const existing=(this.state.people.profiles||{})[person.personId]||null;
    this.setState({modal:{type:'profile', data:null}, pf:{
      personId:person.personId,
      name: existing?existing.name:'',
      staff: existing?(existing.staffId||''):'',
      age: existing?(existing.age||''):'',
      gender: existing?(existing.gender||''):'',
      about: existing?(existing.about||existing.notes||''):'',
      photo: (existing&&existing.photo)||person.image||'',
      shots: person.image?[person.image]:[],
      department: existing?(existing.department||''):'',
      plant: existing?(existing.plant||''):'',
      shift: existing?(existing.shift||''):'',
      active: existing?existing.active!==false:true,
      isEdit: !!existing, msg:'', saving:false,
    }});
    if(!this.state.reg.data) this.loadRegister();   // plant / department / shift options
    fetch(`${this.API}/events?token=${this.TOK}&person_id=${encodeURIComponent(person.personId)}&limit=60`, {cache:'no-store'})
      .then(r=>r.json())
      .then(d=>{ if(!(d&&d.ok)) return;
        const shots=[...new Set((d.events||[]).map(e=>(e.images&&e.images.trigger)||null).filter(Boolean))];
        this.setState(st=>(st.pf && st.pf.personId===person.personId)
          ? {pf:{...st.pf, shots:shots.length?shots:st.pf.shots, photo:st.pf.photo||shots[0]||''}} : {});
      }).catch(()=>{});
  }
  pfSet(k,v){ this.setState(st=>({pf:{...st.pf, [k]:v, msg:''}})); }
  // Attach (or phone-camera capture) a profile picture. VisionAI capture URLs
  // expire, so an operator-supplied photo is uploaded to /uploads/profiles and
  // the stored URL points at our own host.
  pfBrowse(){
    const inp=document.getElementById('pf-file'); if(!inp) return;
    if(!inp._tmns){ inp._tmns=1;
      inp.addEventListener('change', ()=>{ const f=inp.files&&inp.files[0]; if(f) this.pfUploadPhoto(f); });
    }
    inp.click();
  }
  pfUploadPhoto(file){
    const f=this.state.pf; if(!f||!file) return;
    if(!/^image\//.test(file.type||'')){ this.setState(st=>({pf:{...st.pf, msg:'Pick an image file (JPG/PNG/WEBP)'}})); return; }
    if(file.size>6*1024*1024){ this.setState(st=>({pf:{...st.pf, msg:'Image is larger than 6 MB'}})); return; }
    this.setState(st=>({pf:{...st.pf, uploading:true, msg:'Uploading photo…'}}));
    const fd=new FormData(); fd.append('file', file); fd.append('person_id', f.personId||'new');
    fetch(`${this.API}/persons/photo?token=${this.TOK}`, {method:'POST', body:fd})
      .then(r=>r.json())
      .then(d=>{ if(!(d&&d.ok&&d.url)) throw new Error((d&&(d.error||d.msg))||'upload failed');
        this.setState(st=>{ if(!st.pf) return {};
          const shots=[d.url, ...(st.pf.shots||[]).filter(u=>u!==d.url)];
          return {pf:{...st.pf, photo:d.url, shots, uploading:false, msg:'Photo attached ✓ — save to apply'}}; });
        const inp=document.getElementById('pf-file'); if(inp) inp.value=''; })
      .catch(e=>this.setState(st=>({pf:{...st.pf, uploading:false, msg:'Upload failed — '+(e&&e.message||'error')}})));
  }
  pfSave(){
    const f=this.state.pf; if(!f) return;
    const name=String(f.name||'').trim();
    if(!name){ this.setState(st=>({pf:{...st.pf, msg:'Full name is required'}})); return; }
    if(f.isNew && !String(f.staff||'').trim()){ this.setState(st=>({pf:{...st.pf, msg:'Staff / employee ID is required'}})); return; }
    this.setState(st=>({pf:{...st.pf, saving:true, msg:'Saving…'}}));
    fetch(`${this.API}/persons?token=${this.TOK}`, {method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({person_id:f.personId, new_employee:!!f.isNew, name, staff_id:f.staff||'', age:f.age, gender:f.gender, about:f.about,
        department:f.department||'', plant:f.plant||'', shift:f.shift||'', active:f.active!==false,
        photo_url:f.photo||'', actor:this.UNAME})})
      .then(r=>r.json())
      .then(d=>{ if(!(d&&d.ok)) throw new Error((d&&(d.error||d.msg))||'Save failed');
        this.setState(st=>({people:{...st.people, profiles:d.profiles||st.people.profiles, msg:'Profile saved ✓'}, modal:null, pf:null}));
        this.loadPeople(); this.fetchFeed();
        if(this.state.page==='attendance'||this.state.page==='employees') this.loadRegister();
        // Keep SenseStudio's employee library in step: sync when there is a
        // staff ID and a photo (or when deactivating an already-synced person).
        const prof=(d.profiles||{})[d.person_id]||{};
        if(this.PERMS.settings && (prof.ssUid || (prof.staffId && prof.photo))) this.syncEmployee(d.person_id, true); })
      .catch(e=>this.setState(st=>({pf:{...st.pf, saving:false, msg:(e&&e.message&&e.message!=='bad')?e.message:'Save failed'}})));
  }

  // Enrol (or rename) a tracked person. The latest capture becomes the profile
  // photo, so every later detection of this personId renders with it.
  saveProfile(person){
    const existing=(this.state.people.profiles||{})[person.personId];
    const name=window.prompt(
      existing ? ('Rename person #'+person.personId) : ('Create a profile for person #'+person.personId+'\n\nThis name and photo will be shown on every future detection of this person.'),
      existing ? existing.name : '');
    if(name===null) return;                       // cancelled
    const clean=String(name).trim();
    if(!clean){ this.setState(st=>({people:{...st.people, msg:'Name cannot be empty'}})); return; }
    const notes=window.prompt('Optional note (role, department, watchlist reason…)', existing?existing.notes:'')||'';
    this.setState(st=>({people:{...st.people, msg:'Saving…'}}));
    fetch(`${this.API}/persons?token=${this.TOK}`, {method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({person_id:person.personId, name:clean, notes, photo_url:person.image||'', actor:this.UNAME})})
      .then(r=>r.json())
      .then(d=>{ if(!(d&&d.ok)) throw new Error('bad');
        this.setState(st=>({people:{...st.people, profiles:d.profiles||st.people.profiles, msg:'Profile saved ✓'}}));
        this.loadPeople(); this.fetchFeed();
        if(this._pfT) clearTimeout(this._pfT);
        this._pfT=setTimeout(()=>this.setState(st=>({people:{...st.people, msg:''}})), 2500); })
      .catch(()=>this.setState(st=>({people:{...st.people, msg:'Save failed'}})));
  }

  removeProfile(person){
    if(!window.confirm('Remove the profile for '+(person.name||('#'+person.personId))+'?\n\nDetections stay; they just go back to showing as an unidentified person.')) return;
    fetch(`${this.API}/persons/delete?token=${this.TOK}`, {method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({person_id:person.personId})})
      .then(()=>{ this.loadPeople(); this.fetchFeed(); })
      .catch(()=>{});
  }

  // Every stored capture of one tracked person (VisionAI personId — set even
  // for strangers). The dashboard feed only holds the recent window, so the
  // face gallery reads the full record straight from the events API.
  loadPersonCaptures(personId){
    if(!personId) return;
    if(this.state.evPerson && this.state.evPerson.id===personId) return;   // already loaded/loading
    this.setState({evPerson:{id:personId, loading:true, rows:[]}});
    fetch(`${this.API}/events?token=${this.TOK}&person_id=${encodeURIComponent(personId)}&limit=300`, {cache:'no-store'})
      .then(r=>r.json())
      .then(d=>{
        if(!(d&&d.ok)) throw new Error('bad response');
        if(!this.state.evPerson || this.state.evPerson.id!==personId) return;  // modal moved on
        const rows=(Array.isArray(d.events)?d.events:[]).map(e=>({
          id:e.uuid||String(e.id), trig:(e.images&&e.images.trigger)||null, bk:(e.images&&e.images.background)||null,
          camera:String(e.stream||e.device_serial||'').toUpperCase(),
          sim:e.similarity||'', match:e.match_image_url||(e.images&&e.images.match)||null,
          time:e.trigger_time||e.received_at||'', ts:Date.parse((e.trigger_time||e.received_at||'').replace(' ','T'))||0,
        })).filter(r=>r.trig||r.bk);
        this.setState({evPerson:{id:personId, loading:false, rows}});
      })
      .catch(()=>{ if(this.state.evPerson && this.state.evPerson.id===personId)
        this.setState({evPerson:{id:personId, loading:false, rows:[], failed:true}}); });
  }
  // Open the live player in a new top-level tab — works through Cloudflare Access
  // (the embedded iframe can't, being cross-site third-party).
  openLiveTab(url){ if(url) window.open(url, '_blank', 'noopener,noreferrer'); }
  closeLightbox(){ this.setState({lightbox:null}); }

  // ── Modals ───────────────────────────────────────────────
  openModal(type,data){
    this.setState({modal:{type,data:data||null}, evShowRaw:false, evGalTab:'faces', evGalPage:0, evGalRange:'all', evPerson:null});
    if(type==='event'){ this.loadEvCharts(); if(data&&data.personId) this.loadPersonCaptures(data.personId); }
  }
  // Alert modal mini-charts: 7-day module trend (forecast agg, cached 5 min)
  // + last-24h hourly profile from the live feed trend.
  loadEvCharts(){
    const draw=()=>{ if(this._evT) clearTimeout(this._evT); this._evT=setTimeout(()=>this.drawEvCharts(), 140); };
    if(this._evAgg && (Date.now()-(this._evAggAt||0))<300e3){ draw(); return; }
    fetch(`${this.API}/forecast?token=${this.TOK}&days=7`, {cache:'no-store'}).then(r=>r.json())
      .then(d=>{ if(d&&d.ok){ this._evAgg=d.agg; this._evAggAt=Date.now(); } draw(); }).catch(draw);
  }
  drawEvCharts(){
    const md=this.state.modal;
    if(!md||md.type!=='event'||!window.Highcharts) return;
    const ev=md.data||{}; const mod=ev.mod;
    const dark=this.state.theme==='dark';
    const BLUE=dark?'#3987e5':'#2a78d6';
    const host=document.querySelector('[data-theme]')||document.documentElement;
    const css=getComputedStyle(host);
    const cv=(n,fb)=>((css.getPropertyValue(n)||'').trim()||fb);
    const text=cv('--text','#E9ECF6'), muted=cv('--text3','#616989'), line=cv('--line','#232847');
    const base={chart:{backgroundColor:'transparent', style:{fontFamily:"'IBM Plex Sans',system-ui,sans-serif"}, spacing:[6,2,2,2]},
      title:{text:undefined}, credits:{enabled:false}, exporting:{enabled:false}, legend:{enabled:false},
      xAxis:{labels:{style:{color:muted, fontSize:'9.5px'}}, lineColor:line, tickColor:line},
      yAxis:{title:{text:null}, labels:{style:{color:muted, fontSize:'9.5px'}}, gridLineColor:line, allowDecimals:false},
      tooltip:{backgroundColor:dark?'#1A1F3D':'#ffffff', borderColor:line, style:{color:text}}};
    this._hc=this._hc||{};
    const mk=(id,cfg)=>{ const el=document.getElementById(id); if(!el) return;
      if(this._hc[id]){ try{ this._hc[id].destroy(); }catch(e){} }
      this._hc[id]=Highcharts.chart(el, Highcharts.merge({}, base, cfg)); };
    if(this._evAgg&&this._evAgg.daily){
      const cats=this._evAgg.daily.map(d=>d.day.slice(5));
      const data=this._evAgg.daily.map(d=>(d[mod]!=null?d[mod]:d.total));
      mk('evTrend',{chart:{type:'areaspline', height:168}, xAxis:{categories:cats},
        plotOptions:{areaspline:{marker:{enabled:false}, lineWidth:2, fillOpacity:0.25}},
        series:[{name:'Incidents', data, color:BLUE}]});
    }
    const tr=this.state.trend||[];
    const hours=tr.map(b=>b[mod]||0);
    const hcats=[...Array(24)].map((_,i)=>{ const h=new Date(Date.now()-(23-i)*3600e3).getHours(); return String(h).padStart(2,'0'); });
    mk('evHours',{chart:{type:'column', height:168}, xAxis:{categories:hcats, tickInterval:4},
      plotOptions:{column:{borderWidth:0, borderRadius:2, color:BLUE}},
      series:[{name:'Detections', data:hours}]});
  }
  closeModal(){ this.setState({modal:null, addCam:{name:'',rtsp:'',busy:false,msg:''}}); }
  setPpeFilter(f){ this.setState({ppeFilter:f}); }
  setSearch(v){
    this.setState({search:v});
    const q=String(v||'').trim();
    // The roster only loads when the Face page is opened — pull it in on first
    // use so global search can find people from anywhere.
    if(q && !(this.state.people.rows||[]).length && !this.state.people.loading) this.loadPeople();
    // A person id that has aged out of the live window still exists in the
    // record: ask the server rather than reporting "no matches".
    if(this._pidT) clearTimeout(this._pidT);
    const pid=q.replace(/^#/,'');
    if(/^\d{3,}$/.test(pid)){
      this._pidT=setTimeout(()=>this.lookupPerson(pid), 350);
    } else if(this.state.searchPid){ this.setState({searchPid:null}); }
  }
  // Server-side person lookup for the global search bar.
  lookupPerson(pid){
    if(this.state.searchPid && this.state.searchPid.id===pid) return;
    fetch(`${this.API}/events?token=${this.TOK}&person_id=${encodeURIComponent(pid)}&limit=200`, {cache:'no-store'})
      .then(r=>r.json())
      .then(d=>{
        if(!(d&&d.ok)) throw new Error('bad');
        if(String(this.state.search||'').trim().replace(/^#/,'')!==pid) return;   // typed on
        const rows=Array.isArray(d.events)?d.events:[];
        const cams=[...new Set(rows.map(e=>String(e.stream||e.device_serial||'').toUpperCase()).filter(Boolean))];
        this.setState({searchPid:{id:pid, count:rows.length, cameras:cams,
          image:(rows[0]&&rows[0].images&&rows[0].images.trigger)||null,
          lastSeen:(rows[0]&&(rows[0].trigger_time||rows[0].received_at))||''}});
      })
      .catch(()=>{});
  }

  // ── Notifications (bell) — driven by live detections ─────
  toggleNotif(){ this.setState(s=>({notifOpen:!s.notifOpen})); }
  markAllRead(){ const seen={...this.state.notifSeen}; this.state.events.forEach(e=>{seen[e.id]=1;}); this.setState({notifSeen:seen}); }
  openFromNotif(e){ this.setState(s=>({notifOpen:false, page:'incidents', incSel:e.id, notifSeen:{...s.notifSeen, [e.id]:1}})); }

  // ── Find people in records (attribute search on the feed) ─
  setFind(k,v){ this.setState(s=>({find:{...s.find, [k]:v}})); }
  runFind(){
    const f=this.state.find;
    const base=(window.TMNS && window.TMNS.feed) || '/feed.php';
    const sep=base.includes('?')?'&':'?';
    const qs=['find=1','hours='+(f.hours||24),'limit=24'];
    [['gender',f.gender],['age',f.age],['tops_color',f.tops_color],['mask',f.mask],['vest',f.vest]]
      .forEach(([k,v])=>{ if(v) qs.push(k+'='+encodeURIComponent(v)); });
    this.setState(s=>({find:{...s.find, busy:true}}));
    fetch(base+sep+qs.join('&'), {cache:'no-store'}).then(r=>r.json())
      .then(d=>this.setState(s=>({find:{...s.find, busy:false, ran:true, results:(d&&d.ok&&Array.isArray(d.results))?d.results:[]}})))
      .catch(()=>this.setState(s=>({find:{...s.find, busy:false, ran:true, results:[]}})));
  }

  // ── Report charts (Highcharts) ───────────────────────────
  scheduleCharts(){ if(this._hcT) clearTimeout(this._hcT); this._hcT=setTimeout(()=>this.drawCharts(), 90); }
  drawCharts(){ const p=this.state.page; if(p==='face') this.drawFaceCharts(); else if(p==='fire'||p==='ppe'||p==='intr') this.drawModCharts(); }
  hcBase(){
    const dark=this.state.theme==='dark';
    const host=document.querySelector('[data-theme]')||document.documentElement;
    const css=getComputedStyle(host); const cv=(n,fb)=>((css.getPropertyValue(n)||'').trim()||fb);
    const text=cv('--text','#E9ECF6'), muted=cv('--text3','#616989'), line=cv('--line','#232847');
    return { dark, text, muted, line, base:{
      chart:{backgroundColor:'transparent', style:{fontFamily:"'IBM Plex Sans',system-ui,sans-serif"}, spacing:[8,4,4,4]},
      title:{text:undefined}, credits:{enabled:false}, exporting:{enabled:false}, legend:{enabled:false},
      xAxis:{labels:{style:{color:muted, fontSize:'10px'}}, lineColor:line, tickColor:line},
      yAxis:{title:{text:null}, labels:{style:{color:muted, fontSize:'10px'}}, gridLineColor:line, allowDecimals:false},
      tooltip:{backgroundColor:dark?'#1A1F3D':'#ffffff', borderColor:line, style:{color:text}},
    }};
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
  // ── Face & Body report charts (Highcharts, official demo configs) ─
  scheduleFaceCharts(){ if(this._hcT) clearTimeout(this._hcT); this._hcT=setTimeout(()=>this.drawFaceCharts(), 90); }
  drawFaceCharts(){
    if(this.state.page!=='face' || !window.Highcharts) return;
    const f=this.state.faceR; if(!f) return;
    const dark=this.state.theme==='dark';
    // Dark/light categorical steps validated against the dashboard surfaces.
    const BLUE=dark?'#3987e5':'#2a78d6', ORANGE=dark?'#d95926':'#eb6834', VIOLET=dark?'#9085e9':'#4a3aa7';
    const host=document.querySelector('[data-theme]')||document.documentElement;
    const css=getComputedStyle(host);
    const cv=(n,fb)=>((css.getPropertyValue(n)||'').trim()||fb);
    const text=cv('--text','#E9ECF6'), text2=cv('--text2','#9AA1BD'), muted=cv('--text3','#616989'), line=cv('--line','#232847');
    const base={
      chart:{backgroundColor:'transparent', style:{fontFamily:"'IBM Plex Sans',system-ui,sans-serif"}, spacing:[8,4,4,4]},
      title:{text:undefined}, credits:{enabled:false}, exporting:{enabled:false}, legend:{enabled:false},
      xAxis:{labels:{style:{color:muted, fontSize:'10px'}}, lineColor:line, tickColor:line},
      yAxis:{title:{text:null}, labels:{style:{color:muted, fontSize:'10px'}}, gridLineColor:line, allowDecimals:false},
      tooltip:{backgroundColor:dark?'#1A1F3D':'#ffffff', borderColor:line, style:{color:text}},
    };
    this._hc=this._hc||{};
    const mk=(id,cfg)=>{ const el=document.getElementById(id); if(!el) return;
      if(this._hc[id]){ try{ this._hc[id].destroy(); }catch(e){} }
      this._hc[id]=Highcharts.chart(el, Highcharts.merge({}, base, cfg)); };
    const hrs=[...Array(24)].map((_,i)=>{ const h=new Date(Date.now()-(23-i)*3600e3).getHours(); return String(h).padStart(2,'0')+':00'; });
    mk('fbTrend',{chart:{type:'areaspline', height:215}, xAxis:{categories:hrs, tickInterval:3},
      plotOptions:{areaspline:{marker:{enabled:false}, lineWidth:2, fillOpacity:0.18}},
      series:[{name:'Person detections', data:f.hourly||[], color:BLUE}]});
    const gData=Object.entries(f.gender||{}).map(([name,y],i)=>({name, y, color:[BLUE,ORANGE,VIOLET][i%3]}));
    mk('fbGender',{chart:{type:'pie', height:215},
      tooltip:{pointFormat:'<b>{point.y}</b> ({point.percentage:.0f}%)'},
      plotOptions:{pie:{innerSize:'58%', borderColor:dark?'#0E1122':'#ffffff', borderWidth:2,
        dataLabels:{enabled:true, format:'{point.name}: {point.y}', style:{color:text2, textOutline:'none', fontSize:'11px', fontWeight:'500'}}}},
      series:[{name:'Gender', data:gData}]});
    mk('fbAge',{chart:{type:'column', height:215}, xAxis:{categories:Object.keys(f.age||{})},
      plotOptions:{column:{borderWidth:0, borderRadius:4, color:BLUE, pointPadding:0.12, groupPadding:0.12,
        dataLabels:{enabled:true, style:{color:text2, textOutline:'none'}}}},
      series:[{name:'Age band', data:Object.values(f.age||{})}]});
    const tc=Object.entries(f.topsColor||{}).sort((a,b)=>b[1]-a[1]).slice(0,8);
    mk('fbTops',{chart:{type:'bar', height:215}, xAxis:{categories:tc.map(x=>x[0])},
      plotOptions:{bar:{borderWidth:0, borderRadius:4, color:BLUE, dataLabels:{enabled:true, style:{color:text2, textOutline:'none'}}}},
      series:[{name:'Tops colour', data:tc.map(x=>x[1])}]});
    const bc=Object.entries(f.byCam||{}).sort((a,b)=>b[1]-a[1]).slice(0,8);
    mk('fbCams',{chart:{type:'bar', height:215}, xAxis:{categories:bc.map(x=>x[0])},
      plotOptions:{bar:{borderWidth:0, borderRadius:4, color:BLUE, dataLabels:{enabled:true, style:{color:text2, textOutline:'none'}}}},
      series:[{name:'Detections', data:bc.map(x=>x[1])}]});
  }

  // Onboard a camera to VisionAI via our API (§3.3.1 device/create).
  submitCamera(){
    const a=this.state.addCam;
    if(!a.name || !a.rtsp){ this.setState({addCam:{...a,msg:'Name and RTSP URL are required.'}}); return; }
    this.setState({addCam:{...a,busy:true,msg:'Onboarding to VisionAI…'}});
    fetch(`${this.API}/cameras?token=${this.TOK}`,{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({name:a.name, rtsp:a.rtsp})})
      .then(r=>r.json()).then(d=>{
        if(d && d.ok){ this.setState({addCam:{name:'',rtsp:'',busy:false,msg:'✓ Camera onboarded (device '+(d.data||'created')+'). It will appear once VisionAI activates it.'}}); }
        else { this.setState(s=>({addCam:{...s.addCam,busy:false,msg:'✗ '+((d&&(d.msg||d.error))||'Failed')}})); }
      }).catch(()=>this.setState(s=>({addCam:{...s.addCam,busy:false,msg:'✗ Network error'}})));
  }
  updAddCam(patch){ this.setState(s=>({addCam:{...s.addCam,...patch}})); }

  // ── Incident tickets ──────────────────────────────────────
  setIncEl(v){ this.setState({incEl:v, incPage:0}); }
  setIncCam(v){ this.setState({incCam:v, incPage:0}); }
  fmtDur(ms){ if(ms==null||isNaN(ms)||ms<0) return '—'; const m=Math.floor(ms/60000); if(m<1) return '<1m';
    if(m<60) return m+'m'; const h=Math.floor(m/60); if(h<24) return h+'h '+String(m%60).padStart(2,'0')+'m';
    return Math.floor(h/24)+'d '+(h%24)+'h'; }
  openTicket(e){ this.setState({modal:{type:'ticket', data:e}, tktTab:'comm', tktLog:null, tktFiles:null, tktNear:null,
    tktNote:'', tktRemark:'', tktMsg:'', tktCommPage:0, tktHistPage:0}); this.loadTicket(e.id); this.fetchNear(e); this.scheduleComm(); }
  // Same-camera detections in the minute leading up to this one (context tab).
  fetchNear(tk){
    const stream=String(tk.camera||'').toLowerCase();
    const base=String(tk.received||tk.triggerTime||'').replace(' ','T');
    const t=Date.parse(base)||tk.ts||Date.now();
    const p=(n)=>String(n).padStart(2,'0');
    const fmt=(ms)=>{ const d=new Date(ms);
      return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate())+' '+p(d.getHours())+':'+p(d.getMinutes())+':'+p(d.getSeconds()); };
    fetch(`${this.API}/events?token=${this.TOK}&stream=${encodeURIComponent(stream)}&from=${encodeURIComponent(fmt(t-60000))}&to=${encodeURIComponent(fmt(t+1000))}&limit=60`, {cache:'no-store'})
      .then(r=>r.json()).then(d=>{ this.setState({tktNear:(d&&d.ok&&d.events)||[]}); })
      .catch(()=>this.setState({tktNear:[]}));
  }
  loadTicket(id){
    fetch(`${this.API}/events/${encodeURIComponent(id)}/log?token=${this.TOK}`, {cache:'no-store'})
      .then(r=>r.json()).then(d=>{ if(d&&d.ok){ this.setState({tktLog:d.log||[]}); this.scheduleComm(); } }).catch(()=>{});
    fetch(`${this.API}/events/${encodeURIComponent(id)}/attachments?token=${this.TOK}`, {cache:'no-store'})
      .then(r=>r.json()).then(d=>{ if(d&&d.ok) this.setState({tktFiles:d.files||[]}); }).catch(()=>{});
  }
  // Communication tab: rich-text toolbar + imperatively rendered, paginated
  // comment list (comments are a sanitized HTML subset from the editor).
  scheduleComm(){ if(this._cmT) clearTimeout(this._cmT); this._cmT=setTimeout(()=>{ this.bindComm(); this.renderComments(); }, 90); }
  bindComm(){
    const tb=document.getElementById('tkt-toolbar'), ed=document.getElementById('tkt-editor');
    if(tb && !tb._tmns){ tb._tmns=1;
      tb.querySelectorAll('button[data-cmd]').forEach(b=>{
        b.addEventListener('mousedown', e=>{ e.preventDefault();
          const c=b.getAttribute('data-cmd');
          if(c==='createLink'){ const u=window.prompt('Link URL (https://…)'); if(u) document.execCommand('createLink', false, u); }
          else document.execCommand(c, false, null);
          if(ed) ed.focus();
        });
      });
    }
  }
  renderComments(){
    if(this.state.tktTab!=='comm') return;
    const box=document.getElementById('tkt-comm-list'); if(!box) return;
    const esc=(s)=>String(s==null?'':s).replace(/[&<>"']/g, ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
    const kindCol={comment:'var(--low)', notify:'var(--brand)', tmforce:'var(--crit)', remark:'var(--ok)'};
    const isHtml=(s)=>/<([a-z]+)(\s|\/?>)/i.test(s||'');
    const all=(this.state.tktLog||[]).filter(l=>['comment','notify','tmforce','remark'].indexOf(l.kind)>=0);
    const PS=8, pages=Math.max(1, Math.ceil(all.length/PS));
    const p=Math.min(this.state.tktCommPage||0, pages-1);
    const slice=all.slice(p*PS, p*PS+PS);
    let h='';
    if(!all.length) h='<div class="tkt-c-empty">No communications yet — add the first note below.</div>';
    slice.forEach(l=>{ const col=kindCol[l.kind]||'var(--low)';
      const body=isHtml(l.note)? l.note : esc(l.note||'').replace(/\n/g,'<br>');
      const initial=esc(String(l.actor||'—').charAt(0).toUpperCase());
      h+='<div class="tkt-c-row">'
        +'<span class="tkt-c-dot" style="background:'+col+';box-shadow:0 0 9px '+col+'"></span>'
        +'<div class="tkt-c-card">'
        +'<div class="tkt-c-head">'
        +'<span class="tkt-c-avatar">'+initial+'</span>'
        +'<b class="tkt-c-actor">'+esc(l.actor||'—')+'</b>'
        +'<span class="tkt-c-time">'+esc(l.created_at||'')+'</span>'
        +'<span class="tkt-c-kind" style="color:'+col+'">'+esc(l.kind)+'</span></div>'
        +'<div class="tkt-note tkt-c-body">'+body+'</div></div></div>';
    });
    if(pages>1){
      h+='<div class="tkt-c-pager">'
        +'<button id="tkt-cprev" class="tkt-c-btn"'+(p===0?' disabled':'')+'>‹ Prev</button>'
        +'<span class="tkt-c-time">Page '+(p+1)+' / '+pages+'</span>'
        +'<button id="tkt-cnext" class="tkt-c-btn"'+(p>=pages-1?' disabled':'')+'>Next ›</button></div>';
    }
    box.innerHTML=h;
    const pv=document.getElementById('tkt-cprev'), nx=document.getElementById('tkt-cnext');
    if(pv) pv.addEventListener('click', ()=>{ this.setState({tktCommPage:Math.max(0, p-1)}); this.scheduleComm(); });
    if(nx) nx.addEventListener('click', ()=>{ this.setState({tktCommPage:Math.min(pages-1, p+1)}); this.scheduleComm(); });
  }
  tktPost(id, path, payload, msg){
    this.setState({tktMsg:'Working…'});
    fetch(`${this.API}/events/${encodeURIComponent(id)}/${path}?token=${this.TOK}`,
      {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload||{})})
      .then(r=>r.json()).then(d=>{
        this.setState({tktMsg:(d&&d.ok)?(msg||'Done ✓'):'Failed'});
        this.loadTicket(id); this.fetchFeed();
        if(this._tkT) clearTimeout(this._tkT); this._tkT=setTimeout(()=>this.setState({tktMsg:''}), 2500);
      }).catch(()=>this.setState({tktMsg:'Failed'}));
  }
  makeTicket(id, ev){ if(ev&&ev.stopPropagation) ev.stopPropagation(); this.tktPost(id, 'ticket', {actor:this.UNAME}, 'Ticket created'); }
  // Drag-and-drop multi-file upload for the ticket Attachments tab.
  // Native listeners bind once per DOM node (dc-runtime keeps nodes across
  // re-renders, same as the Highcharts containers).
  bindDrop(){
    const dz=document.getElementById('tkt-drop'), inp=document.getElementById('tkt-file');
    if(!dz||!inp) return;
    const idOf=()=> (this.state.modal&&this.state.modal.data)?this.state.modal.data.id:null;
    if(!inp._tmns){ inp._tmns=1;
      inp.addEventListener('change', ()=>{ if(inp.files&&inp.files.length) this.tktUploadFiles(idOf(), inp.files); });
    }
    if(!dz._tmns){ dz._tmns=1;
      ['dragenter','dragover'].forEach(ev=>dz.addEventListener(ev, e=>{ e.preventDefault(); e.stopPropagation();
        dz.style.borderColor='var(--brand)'; dz.style.background='var(--bg4)'; }));
      ['dragleave','drop'].forEach(ev=>dz.addEventListener(ev, e=>{ e.preventDefault(); e.stopPropagation();
        dz.style.borderColor=''; dz.style.background=''; }));
      dz.addEventListener('drop', e=>{ const fs=e.dataTransfer&&e.dataTransfer.files; if(fs&&fs.length) this.tktUploadFiles(idOf(), fs); });
    }
  }
  tktUploadFiles(id, fileList){
    if(!id||!fileList||!fileList.length) return;
    const files=[...fileList]; const total=files.length;
    let done=0, fail=0;
    const next=()=>{
      if(!files.length){
        this.setState({tktMsg: fail? (done+' uploaded · '+fail+' failed') : (done+' file'+(done===1?'':'s')+' uploaded ✓')});
        const inp=document.getElementById('tkt-file'); if(inp) inp.value='';
        this.loadTicket(id);
        if(this._tkT) clearTimeout(this._tkT); this._tkT=setTimeout(()=>this.setState({tktMsg:''}), 3000);
        return;
      }
      const f=files.shift();
      if(f.size>10*1024*1024){ fail++; next(); return; }
      this.setState({tktMsg:'Uploading '+f.name+' ('+(done+fail+1)+'/'+total+')…'});
      const fd=new FormData(); fd.append('file', f); fd.append('actor', this.UNAME);
      fetch(`${this.API}/events/${encodeURIComponent(id)}/attach?token=${this.TOK}`, {method:'POST', body:fd})
        .then(r=>r.json()).then(d=>{ (d&&d.ok)?done++:fail++; next(); })
        .catch(()=>{ fail++; next(); });
    };
    next();
  }
  repIncidents(period){
    this.setState({tktMsg:'Sending '+period+' report…'});
    fetch(`${this.API}/report/incidents?token=${this.TOK}&period=${period}`, {cache:'no-store'}).then(r=>r.json())
      .then(d=>{ this.setState({tktMsg:(d&&d.ok)?(period+' incident report sent ✓'):'Report failed — check SMTP'});
        if(this._tkT) clearTimeout(this._tkT); this._tkT=setTimeout(()=>this.setState({tktMsg:''}), 3000); })
      .catch(()=>this.setState({tktMsg:'Report failed'}));
  }

  // ── User & role management (session-gated /api/users, /api/roles) ──
  loadUsers(){ fetch(`${this.API}/users`, {cache:'no-store'}).then(r=>r.json())
      .then(d=>{ if(d&&d.ok) this.setState({umUsers:d.users||[]}); }).catch(()=>{}); }
  loadRoles(){ fetch(`${this.API}/roles`, {cache:'no-store'}).then(r=>r.json())
      .then(d=>{ if(d&&d.ok) this.setState({umRoles:d.roles||[], umPerms:d.permLabels||{}}); }).catch(()=>{}); }
  umPost(path, body, okMsg){
    this.setState({umMsg:'Working…'});
    fetch(`${this.API}/${path}`, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body||{})})
      .then(r=>r.json()).then(d=>{
        if(d&&d.ok){
          this.setState({umMsg:okMsg||'Saved ✓'});
          if(d.users) this.setState({umUsers:d.users});
          if(d.roles) this.setState({umRoles:d.roles});
          if(!d.users) this.loadUsers();
          if(!d.roles) this.loadRoles();
        } else this.setState({umMsg:'✗ '+((d&&d.error)||'Failed')});
        if(this._umT) clearTimeout(this._umT); this._umT=setTimeout(()=>this.setState({umMsg:''}), 3500);
      }).catch(()=>this.setState({umMsg:'✗ Network error'}));
  }
  umSet(k,v){ this.setState(s=>({umDraft:{...s.umDraft, [k]:v}})); }
  umAddUser(){
    const d=this.state.umDraft||{};
    if(!d.username||!d.password||String(d.password).length<8){ this.setState({umMsg:'✗ Username + password (8+ chars) required'}); return; }
    this.umPost('users', {username:d.username, display_name:d.display_name||'', email:d.email||'',
      role:d.role||'operator', password:d.password}, 'User created ✓');
    this.setState({umDraft:{}});
  }
  umResetPw(u){
    const p=window.prompt('New password for '+u.username+' (min 8 characters):');
    if(p===null) return;
    if(String(p).length<8){ this.setState({umMsg:'✗ Password too short'}); return; }
    this.umPost('users/'+u.id, {password:p}, 'Password reset ✓');
  }
  umDelUser(u){
    if(window.confirm('Delete user "'+u.username+'" permanently?')) this.umPost('users/'+u.id, {action:'delete'}, 'User deleted ✓');
  }
  umDelRole(name){
    if(window.confirm('Delete role "'+name+'"?')) this.umPost('roles', {action:'delete', name}, 'Role deleted ✓');
  }

  // ── Alert Rules (live settings via /api/alerts) ───────────
  loadAlerts(){ fetch(`${this.API}/alerts?token=${this.TOK}`, {cache:'no-store'}).then(r=>r.json())
      .then(d=>{ if(d&&d.ok) this.setState({alertCfg:d.settings}); }).catch(()=>{}); }
  saveAlerts(patch, opts){
    const cfg={...(this.state.alertCfg||{}), ...patch};
    this.setState({alertCfg:cfg, alertMsg:'Saving…'});
    const body={...patch}; if(opts&&opts.test) body.send_test=true;
    fetch(`${this.API}/alerts?token=${this.TOK}`, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)})
      .then(r=>r.json()).then(d=>{
        const ok=d&&d.ok;
        // Resync with the server-sanitized values (arrays normalized there).
        if(ok && d.settings) this.setState(s=>({alertCfg:{...(s.alertCfg||{}), ...d.settings}}));
        this.setState({alertMsg: ok?((opts&&opts.test)?(d.test_sent?'Saved ✓ · test email sent':'Saved ✓ · test email FAILED'):'Saved ✓'):'Save failed'});
        if(this._amT) clearTimeout(this._amT); this._amT=setTimeout(()=>this.setState({alertMsg:''}), 3000);
      }).catch(()=>this.setState({alertMsg:'Save failed'})); }

  // ── Danger zone: wipe every stored detection ──────────────
  // Two-step: the first click arms the button, the second one purges.
  purgeEvents(){
    if(!this.state.purgeArmed){
      this.setState({purgeArmed:true, purgeMsg:'Click again to permanently delete all event data.'});
      if(this._pgT) clearTimeout(this._pgT);
      this._pgT=setTimeout(()=>this.setState({purgeArmed:false, purgeMsg:''}), 8000);
      return;
    }
    if(this._pgT) clearTimeout(this._pgT);
    this.setState({purgeArmed:false, purgeBusy:true, purgeMsg:'Purging…'});
    fetch(`${this.API}/events/purge?token=${this.TOK}`, {method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({confirm:'PURGE'})})
      .then(r=>r.json()).then(d=>{
        if(d&&d.ok){
          this._over={};                              // local triage overrides are moot now
          this.setState({purgeBusy:false, purgeMsg:(d.purged||0)+' event(s) deleted ✓',
            events:[], trend:[], byType:{}, byCam:{}, ai:null, ppe:null, policies:[]});
          this.camPool=[];
          this.fetchFeed();
        } else this.setState({purgeBusy:false, purgeMsg:(d&&d.error)||'Purge failed'});
      })
      .catch(()=>this.setState({purgeBusy:false, purgeMsg:'Purge failed'}));
  }
  purgeCancel(ev){ if(ev&&ev.stopPropagation) ev.stopPropagation();
    if(this._pgT) clearTimeout(this._pgT);
    this.setState({purgeArmed:false, purgeMsg:''}); }

  // ── Attendance & movement (POC Use Case 1 · /api/attendance) ──
  loadAttendance(force){
    if(this.state.attBusy && !force) return;
    this.setState({attBusy:true, attErr:''});
    fetch(`${this.API}/attendance?token=${this.TOK}&days=${this.state.attDays||1}`, {cache:'no-store'})
      .then(r=>r.json())
      .then(d=>{ if(!(d&&d.ok)) throw new Error('bad');
        this.setState({att:d, attBusy:false}); })
      .catch(()=>this.setState({attBusy:false, attErr:'Could not load attendance records'}));
  }
  setAttDays(n){ this.setState({attDays:n, attBusy:false}); setTimeout(()=>this.loadAttendance(true), 0); }
  // Chronological movement journey of one person across the predefined camera
  // points (Plant 1 / Plant 2 Guard Posts, Lobby, 8 Color, Conventional …).
  openJourney(p){
    if(!p || !p.personId) return;
    this.setState({modal:{type:'journey', data:null},
      jn:{personId:p.personId, name:p.name||'', staffId:p.staffId||'', photo:p.photo||p.lastImage||'', loading:true, data:null}});
    fetch(`${this.API}/attendance/person?token=${this.TOK}&person_id=${encodeURIComponent(p.personId)}&days=${this.state.attDays||1}`, {cache:'no-store'})
      .then(r=>r.json())
      .then(d=>{ if(!(d&&d.ok)) throw new Error('bad');
        this.setState(st=>(st.jn && st.jn.personId===p.personId)
          ? {jn:{...st.jn, loading:false, data:d.journey||{steps:[],visits:[]},
              name:st.jn.name||((d.profile&&d.profile.name)||''), staffId:st.jn.staffId||((d.profile&&d.profile.staffId)||''),
              photo:st.jn.photo||((d.profile&&d.profile.photo)||'')}} : {}); })
      .catch(()=>this.setState(st=>st.jn?{jn:{...st.jn, loading:false, failed:true}}:{}));
  }

  // ── Official attendance register (/api/attendance/daily) ──
  // Shift rules decide Present / Late / Absent; the Live sightings view above
  // stays the raw detection log.
  todayStr(){ const d=new Date(); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }
  loadRegister(){
    const r=this.state.reg;
    const qs=new URLSearchParams({token:this.TOK, date:r.date||this.todayStr(), plant:r.plant||'', department:r.dept||'', q:r.q||'', status:r.status||''});
    this.setState(st=>({reg:{...st.reg, busy:true, err:''}}));
    fetch(`${this.API}/attendance/daily?${qs}`, {cache:'no-store'})
      .then(x=>x.json())
      .then(d=>{ if(!(d&&d.ok)) throw new Error('bad'); this.setState(st=>({reg:{...st.reg, busy:false, data:d}})); })
      .catch(()=>this.setState(st=>({reg:{...st.reg, busy:false, err:'Could not load the attendance register'}})));
  }
  setReg(patch){
    this.setState(st=>({reg:{...st.reg, ...patch}}));
    if(this._regT) clearTimeout(this._regT);
    this._regT=setTimeout(()=>this.loadRegister(), patch.q!=null?350:0);
  }
  setAttView(v){
    this.setState({attView:v});
    if(v==='register') this.loadRegister();
    if(v==='live') this.loadAttendance(true);
    if(v==='employees'||v==='reports'){ this.loadPeople(); if(!this.state.reg.data) this.loadRegister(); }
  }
  // CSV download: daily register, a date range, or the movement report.
  exportAtt(report){
    const r=this.state.reg, rp=this.state.rep, day=r.date||this.todayStr();
    const from=report==='daily'?day:(rp.from||day), to=report==='daily'?day:(rp.to||from);
    const qs=new URLSearchParams({token:this.TOK, report, date:day, from, to,
      plant:r.plant||'', department:r.dept||'', person_id:report==='movement'?(rp.person||''):''});
    if(report==='daily'){ qs.set('q', r.q||''); qs.set('status', r.status||''); }
    window.open(`${this.API}/attendance/export?${qs}`, '_blank');
  }
  // Register a new employee (no tracked face yet — keyed on the staff ID).
  newEmployee(){
    if(!this.state.reg.data) this.loadRegister();
    this.setState({modal:{type:'profile', data:null}, pf:{personId:'', isNew:true, name:'', staff:'', age:'', gender:'', about:'',
      department:'', plant:this.state.reg.plant||'', shift:'', active:true, photo:'', shots:[], isEdit:false, msg:'', saving:false}});
  }
  // Push employees to the SenseStudio person library (one group per plant).
  syncEmployee(pid, quiet){
    if(!this.PERMS.settings){ if(!quiet) this.setState({empMsg:'Syncing needs the settings permission'}); return; }
    this.setState({empMsg:pid?'Syncing to SenseStudio…':'Syncing all employees to SenseStudio…', empBusy:true});
    fetch(`${this.API}/employees/sync`, {method:'POST', headers:{'Content-Type':'application/json'}, credentials:'same-origin',
      body:JSON.stringify(pid?{person_id:pid}:{all:true})})
      .then(x=>x.json())
      .then(d=>{
        const msg=!(d&&d.ok) ? ('✗ '+((d&&(d.error||d.msg))||'Sync failed'))
          : (pid ? (d.error?('✗ '+d.error):(d.warning?('⚠ '+d.warning):'Synced to SenseStudio ✓'))
                 : ('Synced '+(d.synced||0)+' · failed '+(d.failed||0)+((d.errors&&d.errors.length)?(' — '+d.errors.slice(0,3).join(' | ')):'')));
        this.setState(st=>({empBusy:false, empMsg:msg,
          people:{...st.people, profiles:(d&&d.profiles)||st.people.profiles}}));
      })
      .catch(()=>this.setState({empBusy:false, empMsg:'✗ Sync failed — network error'}));
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
    const qs=new URLSearchParams({token:this.TOK, from:f.from||'', to:f.to||'', plant:f.plant||'', camera:f.camera||'', verdict:f.verdict||'', status:f.status||''});
    this.setState(st=>({fkF:{...st.fkF, busy:true, err:''}}));
    fetch(`${this.API}/forklift/summary?${qs}`, {cache:'no-store'})
      .then(x=>x.json())
      .then(d=>{ if(!(d&&d.ok)) throw new Error('bad'); this.setState(st=>({fkD:d, fkF:{...st.fkF, busy:false}})); })
      .catch(()=>this.setState(st=>({fkF:{...st.fkF, busy:false, err:'Could not load forklift data'}})));
  }
  setFkF(patch){ this.setState(st=>({fkF:{...st.fkF, ...patch}})); if(this._fkT) clearTimeout(this._fkT); this._fkT=setTimeout(()=>this.loadFk(), 0); }
  exportFk(report){
    const f=this.state.fkF, d=this.state.fkD||{};
    const qs=new URLSearchParams({token:this.TOK, report, from:f.from||d.from||'', to:f.to||d.to||'', plant:f.plant||'', camera:f.camera||'', verdict:f.verdict||'', status:f.status||''});
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

  // ── Overview dashboard (/api/overview) ─────────────────────
  // Stale responses (an older plant filter) are dropped via a sequence number.
  loadOverview(){
    const seq=(this._ovSeq=(this._ovSeq||0)+1);
    this.setState({ovBusy:true, ovErr:''});
    const qs=new URLSearchParams({token:this.TOK, plant:this.state.plant||''});
    fetch(`${this.API}/overview?${qs}`, {cache:'no-store'})
      .then(x=>x.json())
      .then(d=>{ if(seq!==this._ovSeq) return; if(!(d&&d.ok)) throw new Error('bad'); this.setState({ov:d, ovBusy:false, ovErr:''}); })
      .catch(()=>{ if(seq===this._ovSeq) this.setState({ovBusy:false, ovErr:'Could not load the overview'}); });
  }
  // Global plant filter (topbar select + sidebar PLANTS rows) — mirrored into
  // every use-case page's own filter, then the current page reloads.
  setPlant(p){
    const plant=p||'';
    this.setState(st=>({plant, reg:{...st.reg, plant}, ppeF:{...st.ppeF, plant}, raF:{...st.raF, plant},
      clF:{...st.clF, plant}, fkF:{...st.fkF, plant}}));
    setTimeout(()=>{ const pg=this.state.page;
      if(pg==='overview') this.loadOverview();
      if(pg==='attendance'||pg==='employees') this.loadRegister();
      if(pg==='ppe') this.loadPpe();
      if(pg==='intr') this.loadRa();
      if(pg==='cleaning') this.loadCl();
      if(pg==='forklift') this.loadFk();
    }, 0);
  }

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

  // ── Settings page (via /api/settings) ─────────────────────
  loadApp(){ fetch(`${this.API}/settings?token=${this.TOK}`, {cache:'no-store'}).then(r=>r.json())
      .then(d=>{ if(d&&d.ok) this.setState({appCfg:d.settings, appDraft:{}}); }).catch(()=>{}); }
  setDraft(k,v){ this.setState(s=>({appDraft:{...s.appDraft, [k]:v}})); }
  saveApp(patch, okMsg){
    this.setState({appMsg:'Saving…'});
    fetch(`${this.API}/settings?token=${this.TOK}`, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(patch)})
      .then(r=>r.json()).then(d=>{
        if(d&&d.ok){
          if(d.rotated&&d.rotated.read_token){ this.setState({appMsg:'Read token rotated — reloading…'}); setTimeout(()=>location.reload(), 1200); return; }
          this.setState({appMsg: okMsg||'Saved ✓'}); this.loadApp();
        } else this.setState({appMsg:'Save failed'});
        if(this._apT) clearTimeout(this._apT); this._apT=setTimeout(()=>this.setState({appMsg:''}), 3000);
      }).catch(()=>this.setState({appMsg:'Save failed'})); }
  regenToken(kind){
    const warn = kind==='ingest'
      ? 'Regenerate the INGEST token?\n\nEvery VisionAI policy Push URL must be updated afterwards or pushes will be rejected.'
      : 'Regenerate the READ token?\n\nThe dashboard will reload with the new token.';
    if(!window.confirm(warn)) return;
    this.saveApp(kind==='ingest'?{regen_ingest:true}:{regen_read:true}, 'Token rotated ✓ — update VisionAI push URLs'); }
  sendReportNow(){ this.setState({appMsg:'Sending report…'});
    fetch(`${this.API}/report/run?token=${this.TOK}`, {cache:'no-store'}).then(r=>r.json())
      .then(d=>this.setState({appMsg:(d&&d.ok)?'Report sent ✓ — check inbox':'Report failed — check SMTP / recipients'}))
      .catch(()=>this.setState({appMsg:'Report failed'})); }

  // ── Forecast page (via /api/forecast) ─────────────────────
  loadForecast(){
    if(this.state.fcBusy) return;
    this.setState({fcBusy:true});
    fetch(`${this.API}/forecast?token=${this.TOK}&days=${this.state.fcDays||14}`, {cache:'no-store'})
      .then(r=>r.json()).then(d=>{ this.setState({fcBusy:false, fcData:(d&&d.ok)?d:null}); this.scheduleFcCharts(); })
      .catch(()=>this.setState({fcBusy:false})); }
  setFcDays(n){ this.setState({fcDays:n, fcData:null}); setTimeout(()=>this.loadForecast(), 0); }
  scheduleFcCharts(){ if(this._fcT) clearTimeout(this._fcT); this._fcT=setTimeout(()=>this.drawFcCharts(), 90); }
  drawFcCharts(){
    if(this.state.page!=='forecast' || !window.Highcharts) return;
    const fd=this.state.fcData; if(!fd||!fd.forecast) return;
    const f=fd.forecast, ag=fd.agg;
    const dark=this.state.theme==='dark';
    const BLUE=dark?'#3987e5':'#2a78d6', ORANGE=dark?'#d95926':'#eb6834';
    const host=document.querySelector('[data-theme]')||document.documentElement;
    const css=getComputedStyle(host);
    const cv=(n,fb)=>((css.getPropertyValue(n)||'').trim()||fb);
    const text=cv('--text','#E9ECF6'), text2=cv('--text2','#9AA1BD'), muted=cv('--text3','#616989'), line=cv('--line','#232847');
    const base={
      chart:{backgroundColor:'transparent', style:{fontFamily:"'IBM Plex Sans',system-ui,sans-serif"}, spacing:[8,4,4,4]},
      title:{text:undefined}, credits:{enabled:false}, exporting:{enabled:false},
      legend:{itemStyle:{color:text2, fontSize:'10.5px'}, itemHoverStyle:{color:text}},
      xAxis:{labels:{style:{color:muted, fontSize:'10px'}}, lineColor:line, tickColor:line},
      yAxis:{title:{text:null}, labels:{style:{color:muted, fontSize:'10px'}}, gridLineColor:line, allowDecimals:false},
      tooltip:{backgroundColor:dark?'#1A1F3D':'#ffffff', borderColor:line, style:{color:text}, shared:true},
    };
    this._hc=this._hc||{};
    const mk=(id,cfg)=>{ const el=document.getElementById(id); if(!el) return;
      if(this._hc[id]){ try{ this._hc[id].destroy(); }catch(e){} }
      this._hc[id]=Highcharts.chart(el, Highcharts.merge({}, base, cfg)); };
    // Daily history + dashed 7-day prediction (forecast band shaded).
    const histDays=ag.daily.map(d=>d.day.slice(5));
    const predDays=f.next7.map(d=>d.day.slice(5));
    const histData=ag.daily.map(d=>d.total);
    const n=histData.length;
    const histSeries=histData.concat(new Array(predDays.length).fill(null));
    const predSeries=new Array(Math.max(0,n-1)).fill(null).concat([histData[n-1]]).concat(f.next7.map(d=>d.predicted));
    mk('fcTrend',{chart:{type:'spline', height:250},
      xAxis:{categories:histDays.concat(predDays), tickInterval:Math.max(1, Math.floor((n+7)/10)),
        plotBands:[{from:n-0.5, to:n+6.5, color:dark?'rgba(217,89,38,.07)':'rgba(235,104,52,.07)',
          label:{text:'FORECAST', style:{color:muted, fontSize:'9px', fontWeight:'700'}}}]},
      plotOptions:{spline:{marker:{enabled:false}, lineWidth:2}},
      series:[{name:'Detections / day', data:histSeries, color:BLUE},
              {name:'Predicted', data:predSeries, color:ORANGE, dashStyle:'Dash'}]});
    // Hour-of-day profile + expected next 24h.
    const hrs=[...Array(24)].map((_,i)=>String(i).padStart(2,'0'));
    mk('fcHours',{chart:{height:250}, xAxis:{categories:hrs, tickInterval:3},
      plotOptions:{column:{borderWidth:0, borderRadius:3}},
      series:[{type:'column', name:'Observed (window)', data:ag.hours, color:BLUE},
              {type:'spline', name:'Expected next 24h', data:f.next24, color:ORANGE, dashStyle:'Dash', marker:{enabled:false}, lineWidth:2}]});
  }

  ago(ts){ const d=Math.max(0,Math.floor((this.state.now-ts)/1000)); if(d<60)return d+'s ago'; const m=Math.floor(d/60); if(m<60)return m+'m ago'; return Math.floor(m/60)+'h ago'; }
  // VisionAI sends the face-match score as a 0…1 float (0.9551 = 95.5 %).
  // Anything already on a 0…100 scale is passed through untouched.
  matchPct(v){ const n=parseFloat(v); if(!isFinite(n)||n<=0) return null;
    return Math.round((n<=1?n*100:n)*10)/10; }
  matchLabel(v){ const p=this.matchPct(v); return p==null?'':(p+'% match'); }
  matchCol(v){ const p=this.matchPct(v);
    return p==null?'var(--text3)':(p>=90?'var(--ok)':(p>=75?'var(--gold)':'var(--crit)')); }

  renderVals(){
    const st=this.state;
    const showBoxes = this.props.showOverlays !== false;
    const d=new Date(st.now);
    const pad=n=>String(n).padStart(2,'0');
    const clock=`${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    const dateStr=d.toLocaleDateString('en-GB',{day:'2-digit',month:'short'});
    const dateLong=d.toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'});

    const openCount = st.events.filter(e=>e.status==='open').length;

    // KPIs
    const camsTotalN = st.live.camsTotal!=null ? st.live.camsTotal : this.camPool.length;
    const camsN = st.live.camsOnline!=null ? st.live.camsOnline : camsTotalN;
    const openHr = st.live.openHour!=null ? st.live.openHour : 0;
    const kpis=[
      {label:'Active Incidents', value:String(openCount), unit:'open', tone:'var(--crit)', valTone:'var(--text)', delta:openHr+' in last hour', deltaTone:'var(--crit)', onClick:()=>this.openModal('incidents'), hint:'View incident log'},
      {label:'Cameras Online', value:String(camsN), unit:'live', tone:'var(--ok)', valTone:'var(--text)', delta:camsTotalN+' VisionAI streams', deltaTone:'var(--text3)', onClick:()=>this.openModal('cameras'), hint:'View & add cameras'},
      {label:'Inference Load', value:String(st.infLoad), unit:'%', tone:'var(--gold)', valTone:'var(--gold)', delta:'GPU · click for graph', deltaTone:'var(--text3)', onClick:()=>this.openModal('gpu'), hint:'GPU utilization graph'},
      {label:'Avg Time to Ack', value:(st.live.avgAck||'—'), unit:'min', tone:'var(--low)', valTone:'var(--text)', delta:'recorded response time', deltaTone:'var(--ok)', onClick:()=>this.openModal('incidents'), hint:'Incident log'},
    ];

    // Filters
    const fdefs=[['all','All'],['fire','Fire'],['ppe','PPE'],['intr','Intrusion'],['face','Face'],['forklift','Forklift']];
    const filters=fdefs.map(([k,label])=>{
      const active=st.filter===k;
      return {label, onClick:()=>this.setFilter(k),
        bg: active?'var(--brand)':'var(--bg3)',
        color: active?'#fff':'var(--text2)',
        border: active?'var(--brand)':'var(--line)'};
    });

    // Cameras — the registered fleet, scaled with grid density
    const cols=st.gridCols;
    const livePool=this.livePool();
    const shownCount=Math.min(cols*cols, livePool.length);
    const compact=cols>=3;
    // Live video straight in the tile when the go2rtc bridge is configured.
    const _liveTok = st.liveToken ? ('&token='+encodeURIComponent(st.liveToken)) : '';
    // Cameras that resolve to the same RTSP URL are one physical feed: the
    // first tile pulls it, the rest mirror that tile's decoded frames, so the
    // browser holds one connection and decodes one video instead of N.
    const _primary = {};
    const cameras=livePool.slice(0, cols*cols).map(c=>{
      const m=this.MODS[c.mod]||this.MODS.intr;
      const on=c.online!==false;
      const vsrc = (st.liveBase && c.stream && on && !st.demo)
        ? (st.liveBase+'/api/stream.mp4?src='+encodeURIComponent(c.stream)+_liveTok) : '';
      const rkey=String(c.rtsp||'').trim().toLowerCase();
      let mirrorOf='';
      if(rkey && vsrc){
        if(_primary[rkey] && _primary[rkey]!==c.stream) mirrorOf=_primary[rkey];
        else _primary[rkey]=c.stream;
      }
      const match=(st.filter==='all'||st.filter===c.mod);
      const dim = match?(on?1:0.62):0.34;
      return {
        id:c.id, name:c.name, zone:c.zone, res:c.res, fps:c.fps, scene:c.scene, dim,
        liveLabel: on?'LIVE':'OFFLINE', liveCol: on?'var(--crit)':'var(--text3)',
        liveAnim: on?'blink 1.6s infinite':'none',
        hasVideo: !!vsrc, videoUrl: vsrc,
        camKey: c.stream || String(c.id).toLowerCase(), mirrorOf,
        showPlaceholder: !c.img,
        placeholder: !on ? 'CAMERA OFFLINE' : (vsrc?'CONNECTING TO STREAM…':'NO STREAM BRIDGE CONFIGURED'),
        tag:m.tag, tagBg:m.tagBg, canExpand: !!c.img,
        onOpen: ()=>this.openCamera(c.stream||String(c.id).toLowerCase()),
        showMeta: !compact, showBoxLabel: cols<=3, nameSize: compact?'11px':'12px',
        // Expire boxes a few seconds after their event so they don't sit at a
        // stale position over the live video once the target has moved on.
        boxes: (showBoxes && Array.isArray(c.boxes)) ? c.boxes
          .filter(b=>!b.ts || (st.now+(this._skew||0))-b.ts<=3000)
          .map(b=>({top:b.top,left:b.left,w:b.w,h:b.h,label:b.label,col:this.SEV[b.sev],glow:this.SEV[b.sev]})) : [],
      };
    });
    const gridOpts=[[2,'2×2','4-up view'],[3,'3×3','9-up view'],[4,'4×4','16-up wall']].map(([n,label,title])=>{
      const active=cols===n;
      return {label, title, onClick:()=>this.setGrid(n),
        bg: active?'var(--brand)':'transparent', color: active?'#fff':'var(--text2)'};
    });

    // Events
    // Live Events rail — event-type filter (dropdown in the rail header).
    const evType=st.evType||'all';
    const evTypeSel={value:evType, onChange:(ev)=>this.setState({evType:(ev&&ev.target)?ev.target.value:'all'}),
      options:[['all','All types'],['fire','Fire'],['ppe','PPE'],['intr','Intrusion'],['face','Face'],['forklift','Forklift']].map(([v,label])=>({v,label}))};
    const events=st.events.filter(e=>evType==='all'||e.mod===evType).map(e=>{
      const m=this.MODS[e.mod];
      const sel=st.selectedId===e.id;
      // Enrolled face → show who it is, how sure the engine was, and the photo
      // on file next to the capture so the operator can eyeball the match.
      const evProf=((st.people&&st.people.profiles)||{})[e.personId||''];
      const refImg=(evProf&&evProf.photo)||e.imageMatch||'';
      const mp=this.matchPct(e.similarity);
      return {
        tag:m.tag, tagBg:m.tagBg, sev:e.sev, sevColor:this.SEV[e.sev],
        title:((evProf&&evProf.name)? ('Face match — '+evProf.name) : e.title),
        camera:e.camera, zone:e.zone, ago:this.ago(e.ts), assignee:e.assignee,
        hasMatch: !!(refImg||mp!=null) && (e.mod==='face'||e.feed==='face'),
        matchName:(evProf&&evProf.name)||e.person||('Person #'+(e.personId||'—')),
        matchPct: mp==null?'—':(mp+'%'), matchCol:this.matchCol(e.similarity),
        hasRef: !!refImg, refBg: refImg?("url('"+refImg+"') center/cover no-repeat"):'',
        onExpandRef:(ev)=>{ if(ev&&ev.stopPropagation)ev.stopPropagation(); if(refImg) this.openLightbox(refImg,
          ((evProf&&evProf.name)||'Person #'+(e.personId||''))+' · profile photo on file'); },
        isOpen:e.status==='open', isAck:e.status==='ack', isResolved:e.status==='resolved',
        op: e.status==='resolved'?0.55:1,
        cardBg: sel?'var(--bg4)':'var(--bg3)',
        cardBorder: sel?'var(--line2)':'var(--line)',
        hasImg: !!e.image, thumbBg: e.image?("url('"+e.image+"') center/cover no-repeat"):'',
        remark: e.remark||'', hasRemark: !!e.remark,
        onExpand:(ev)=>{ if(ev&&ev.stopPropagation)ev.stopPropagation(); if(e.image) this.openLightbox(e.image, e.title); },
        onSelect:()=>this.select(e.id),
        onOpen:()=>this.openModal('event', e),
        onAck:(ev)=>this.ack(e.id,ev),
        onResolve:(ev)=>this.resolve(e.id,ev),
        onAssign:(ev)=>this.assign(e.id,ev),
      };
    });

    // Chart bars — 24 stacked, from the live hourly trend (fire/ppe/intr/face)
    const trend = (st.trend && st.trend.length===24) ? st.trend
                : Array.from({length:24},()=>({fire:0,ppe:0,intr:0,face:0}));
    const totals = trend.map(b=>(b.fire||0)+(b.ppe||0)+(b.intr||0)+(b.face||0));
    const maxT = Math.max(1, ...totals);
    const trendTotal = totals.reduce((a,b)=>a+b,0);
    const bars = trend.map(b=>{
      const s = 100/maxT;
      return { h1:((b.fire||0)*s)+'%', h2:((b.ppe||0)*s)+'%', h3:((b.intr||0)*s)+'%', h4:((b.face||0)*s)+'%' };
    });

    // ===== NAV =====
    // Sidebar items highlight by group: Cameras = live/cameras/camera, Reports =
    // incidents/analytics/forecast/fire/face, Settings = settings/rules/users.
    const navGroup={live:'cameras',cameras:'cameras',camera:'cameras',incidents:'reports',analytics:'reports',forecast:'reports',fire:'reports',face:'reports',
      settings:'settings',rules:'settings',users:'settings'}[st.page]||st.page;
    const navStyle=(key,target)=>({go:()=>this.setPage(target||key), cls:navGroup===key?'nav-on':''});
    const navExact=(p)=>({go:()=>this.setPage(p), cls:st.page===p?'nav-on':''});
    const nav={overview:navStyle('overview'), attendance:navStyle('attendance'), employees:navStyle('employees'), faces:navStyle('faces'),
      ppe:navStyle('ppe'), intr:navStyle('intr'), cleaning:navStyle('cleaning'), forklift:navStyle('forklift'),
      cameras:navStyle('cameras'), reports:navStyle('reports','incidents'), settings:navStyle('settings'),
      // per-page entries kept for any direct link
      live:navExact('live'), incidents:navExact('incidents'), analytics:navExact('analytics'), forecast:navExact('forecast'),
      fire:navExact('fire'), face:navExact('face'), rules:navExact('rules'), users:navExact('users')};
    const modMeta={
      fire:{name:'Fire & Smoke Detection', desc:'Thermal and visual smoke/flame recognition', tag:'FIRE', col:'var(--high)', model:'YOLOv8-fire · v2.4', classes:['Flame','Smoke — light','Smoke — dense','Thermal anomaly']},
      ppe:{name:'PPE Compliance', desc:'Hard hat, vest, gloves and face-shield checks', tag:'PPE', col:'var(--gold)', model:'PPE-Net · v3.1', classes:['Hard hat','Hi-vis vest','Safety gloves','Face shield']},
      intr:{name:'Intrusion Detection', desc:'Zone breach, loitering and tailgating', tag:'INTR', col:'var(--crit)', model:'Tracker-XR · v1.9', classes:['Person','Zone breach','Loitering','Tailgating']},
      face:{name:'Face & Body Attribute', desc:'Identity match and body-attribute analysis', tag:'FACE', col:'var(--low)', model:'FaceAttr · v4.0', classes:['Face match','Gender','Age band','Clothing color']},
    };
    const titles={
      overview:['AI Factory Monitoring Dashboard','Real-time monitoring of people, safety and operations across all plants'],
      live:['Live Feeds','Live camera wall with real-time detections'],
      employees:['Employees','Employee directory, registration and SenseStudio sync'],
      faces:['Face Registration','Enrol faces so CCTV can recognise employees'],
      forklift:['Forklift Monitoring','Forklift detections, zone rules and incident review'],
      cleaning:['Cleaning Monitoring','Cleaning schedules and PPE compliance during cleaning'],
      ppe:['PPE Compliance','PPE rules by area, violation history and reports'],
      intr:['Restricted Area Monitoring','Zone access rules, entry review and reports'],
      attendance:['Attendance & Movement','Facial-recognition entry, latest location and movement journey'],
      incidents:['Incident Management','Track, triage and resolve detection events'],
      cameras:['Camera Fleet','Manage RTSP streams and detection assignments'],
      analytics:['Analytics','Detection trends and operational performance'],
      forecast:['Forecast & Prediction','Future trend prediction from collected detections'],
      rules:['Alert Rules','Live alert routing — email rules, interval, armed window'],
      settings:['Settings','SenseTime API, tokens, notifications, AI source, auto reports'],
      users:['Users & Roles','Accounts, role assignment and permission management'],
    };
    const isDet=!!modMeta[st.page];
    const dm = isDet ? modMeta[st.page] : null;
    const _camName = st.page==='camera' ? ((((st.fleet||[]).find(f=>f.stream===st.camSel)||{}).name) || st.camSel || 'Camera') : '';
    const pageTitle = st.page==='camera' ? _camName : (titles[st.page] ? titles[st.page][0] : (isDet ? dm.name : '—'));
    const pageSub = st.page==='camera' ? 'Live stream · VisionAI device configuration' : (titles[st.page] ? titles[st.page][1] : (isDet ? dm.desc : ''));

    // ===== INCIDENTS =====
    const statusMeta={open:{label:'Open',col:'var(--crit)'},ack:{label:'Acknowledged',col:'var(--low)'},resolved:{label:'Resolved',col:'var(--ok)'}};
    // SLA targets (from feed; server constants) + per-row status computation.
    const slaCfg = st.sla || {critical:{ack:5,resolve:60}, high:{ack:15,resolve:240}, medium:{ack:60,resolve:480}, low:{ack:240,resolve:1440}};
    const slaOf=(e)=>{ const cfg=slaCfg[e.sev]||slaCfg.low; const lim=(cfg.resolve||60)*60000;
      if(e.status==='resolved'){ const took=(e.resolvedTs||st.now)-e.ts;
        return took<=lim?{label:'SLA MET',col:'var(--ok)'}:{label:'SLA BREACHED',col:'var(--crit)'}; }
      const rem=lim-(st.now-e.ts);
      if(rem<0) return {label:'BREACHED '+this.fmtDur(-rem), col:'var(--crit)'};
      if(rem<lim*0.2) return {label:'AT RISK · '+this.fmtDur(rem), col:'var(--gold)'};
      return {label:this.fmtDur(rem)+' LEFT', col:'var(--ok)'}; };
    const progOf=(e)=> e.status==='resolved'?{p:100,col:'var(--ok)',label:'Resolved'}
      :(e.status==='ack'?{p:55,col:'var(--gold)',label:'In progress'}:{p:15,col:'var(--crit)',label:'Open'});
    const allInc=st.events.map(e=>{
      const m=this.MODS[e.mod]; const sm=statusMeta[e.status];
      const sla=slaOf(e); const pr=progOf(e);
      const elapsedMs=(e.status==='resolved'&&e.resolvedTs)?(e.resolvedTs-e.ts):(st.now-e.ts);
      // A face that matches an enrolled profile is shown by name.
      const prof=((st.people&&st.people.profiles)||{})[e.personId||''];
      const detTs=String(e.triggerTime||'').trim() || (e.received||'');
      return {raw:e, id:e.id, code:e.ticket||('DET-'+String(e.id).slice(-6)), codeCol:e.ticket?'var(--brand)':'var(--text3)',
        detDate:detTs.slice(0,10), detTime:detTs.slice(11,19)||'—',
        person:(prof&&prof.name)||e.person||'', hasPerson:!!((prof&&prof.name)||e.person),
        isTicket:!!e.ticket, notTicket:!e.ticket, ticket:e.ticket||'',
        tag:m.tag, tagBg:m.tagBg, sev:e.sev, sevColor:this.SEV[e.sev],
        title:((prof&&prof.name)? ('Face match — '+prof.name) : e.title),
        camera:e.camera, zone:e.zone, device:e.device, ago:this.ago(e.ts), assignee:e.assignee,
        status:e.status, statusLabel:sm.label, statusCol:sm.col,
        slaLabel:sla.label, slaCol:sla.col, prog:pr.p, progW:pr.p+'%', progCol:pr.col, progLabel:pr.label,
        elapsedMs, elapsed:this.fmtDur(elapsedMs),
        // sort ranks
        sevRank:({critical:3,high:2,medium:1,low:0})[e.sev]||0,
        statusRank:({open:0,ack:1,resolved:2})[e.status]||0,
        slaRank: sla.col==='var(--crit)'?0:(sla.col==='var(--gold)'?1:2),
        tsMs:e.ts, tickRank:e.ticket?1:0,
        onOpen:()=>this.openTicket(e), onTicket:(ev)=>this.makeTicket(e.id, ev)};
    });
    const elOk=(x)=> st.incEl==='all'?true : st.incEl==='1h'?x.elapsedMs<3600e3
      : st.incEl==='12h'?(x.elapsedMs>=3600e3&&x.elapsedMs<12*3600e3) : x.elapsedMs>=12*3600e3;
    const incQ=(st.incQ||'').trim().toLowerCase();
    const iSort=st.incSort||{k:'tsMs',d:-1};
    const cmp=(dir)=>(a,b)=>{ const va=a[iSort.k], vb=b[iSort.k];
      return ((typeof va==='number'&&typeof vb==='number')? va-vb : String(va??'').localeCompare(String(vb??'')))*dir; };
    const incMod=st.incMod||'all';
    const incFiltered=allInc.filter(x=>
      (st.incFilter==='all' ? true : x.status===st.incFilter) &&
      (incMod==='all' ? true : (x.raw&&x.raw.mod)===incMod) &&
      (st.incSev==='all' ? true : x.sev===st.incSev) &&
      elOk(x) &&
      (st.incCam==='all' ? true : x.camera===st.incCam) &&
      (!incQ || (x.title+' '+x.camera+' '+x.zone+' '+x.ticket+' '+x.code).toLowerCase().includes(incQ)))
      .sort(cmp(iSort.d));
    const incHead=[['sevRank','SEVERITY'],['title','TICKET / INCIDENT'],['camera','CAMERA'],['tsMs','DETECTED'],['slaRank','SLA'],
      ['prog','PROGRESS'],['elapsedMs','ELAPSED'],['statusRank','STATUS'],['tickRank','TICKET']].map(([k,label])=>({
        label:label+(iSort.k===k?(iSort.d>0?' ▲':' ▼'):''),
        onClick:()=>this.setState({incSort:{k, d:(iSort.k===k? -iSort.d : 1)}, incPage:0})}));
    // Compact dropdown filters (status · type · criticality · elapsed · camera · report)
    const mkSel=(opts,cur,cb)=>({value:String(cur), onChange:(e)=>cb(e&&e.target?e.target.value:'all'),
      options:opts.map(([v,label])=>({v:String(v), label}))});
    const nStatus=(k)=> k==='all'?allInc.length:allInc.filter(x=>x.status===k).length;
    const incStatusSel=mkSel([['all','All ('+nStatus('all')+')'],['open','Open ('+nStatus('open')+')'],
      ['ack','Ack ('+nStatus('ack')+')'],['resolved','Resolved ('+nStatus('resolved')+')']], st.incFilter, v=>this.setIncFilter(v));
    const incTypeSel=mkSel([['all','All types'],['fire','Fire & Smoke'],['ppe','PPE'],['intr','Intrusion'],['face','Face & Body'],['forklift','Forklift']],
      incMod, v=>this.setState({incMod:v, incPage:0}));
    const incSevSel=mkSel([['all','All'],['critical','Critical'],['high','High'],['medium','Medium'],['low','Low']], st.incSev, v=>this.setIncSev(v));
    const incElSel=mkSel([['all','Any'],['1h','< 1h'],['12h','1–12h'],['12h+','> 12h']], st.incEl, v=>this.setIncEl(v));
    const camsSeen=[...new Set(allInc.map(x=>x.camera))].slice(0,30);
    const incCamSel=mkSel([['all','All']].concat(camsSeen.map(c=>[c,c])), st.incCam, v=>this.setIncCam(v));
    // Report is an action, not a filter — the select resets to its placeholder after firing.
    const incRepSel={value:'', onChange:(e)=>{ const v=e&&e.target?e.target.value:'';
      if(v) this.repIncidents(v); },
      options:[['','Send report…'],['daily','Daily'],['weekly','Weekly'],['monthly','Monthly']].map(([v,label])=>({v, label}))};
    // active severity filter chip (set by the Critical stat card)
    const incSevChip = st.incSev!=='all' ? {label:st.incSev, onClear:()=>this.setIncSev('all')} : null;
    // Incidents pagination (10 rows/page)
    const incPS=st.incPS||10, incPages=Math.max(1, Math.ceil(incFiltered.length/incPS));
    const ip=Math.min(st.incPage||0, incPages-1);
    const incRows=incFiltered.slice(ip*incPS, ip*incPS+incPS);
    const incPager={has:incPages>1, label:'Page '+(ip+1)+' / '+incPages+' · '+incFiltered.length+' incidents',
      prev:()=>this.setState({incPage:Math.max(0, ip-1)}), next:()=>this.setState({incPage:Math.min(incPages-1, ip+1)})};
    // Rows-per-page chips + "showing x–y of n" line above the table.
    const incSizeTabs=[10,25,50,100].map(n=>({label:String(n), cls:(incPS===n?'chip on':'chip'),
      onClick:()=>this.setState({incPS:n, incPage:0})}));
    const incFrom=incFiltered.length ? ip*incPS+1 : 0;
    const incTo=Math.min(incFiltered.length, ip*incPS+incPS);
    const incRangeLabel=incFiltered.length
      ? ('SHOWING '+incFrom+'–'+incTo+' OF '+incFiltered.length+(incQ?' · FILTERED':''))
      : 'NO INCIDENTS MATCH THESE FILTERS';
    const mtx=st.metrics||{};
    const fmtSec=(s)=> s==null?'—':(Math.floor(s/60)+':'+String(s%60).padStart(2,'0'));
    const bd=(a)=> a?'var(--brand)':'var(--line)';
    const incStats=[
      {label:'Open', value:String(allInc.filter(x=>x.status==='open').length), tone:'var(--crit)',
        hint:'Filter to open', border:bd(st.incFilter==='open'), onClick:()=>this.setIncFilter('open')},
      {label:'Critical', value:String(allInc.filter(x=>x.sev==='critical'&&x.status!=='resolved').length), tone:'var(--crit)',
        hint:'Filter to critical severity', border:bd(st.incSev==='critical'), onClick:()=>this.setIncSev(st.incSev==='critical'?'all':'critical')},
      {label:'Avg MTTA', value:fmtSec(mtx.mtta), tone:'var(--low)',
        hint:'Response-time matrix', border:bd(false), onClick:()=>this.openModal('metrics')},
      {label:'Avg MTTR', value:fmtSec(mtx.mttr), tone:'var(--gold)',
        hint:'Response-time matrix', border:bd(false), onClick:()=>this.openModal('metrics')},
      {label:'Resolved 24h', value:String(mtx.resolved24h!=null?mtx.resolved24h:0), tone:'var(--ok)',
        hint:'Filter to resolved', border:bd(st.incFilter==='resolved'), onClick:()=>this.setIncFilter('resolved')},
    ];
    // Response-time matrix (for the metrics modal)
    const mMetrics=(mtx.matrix||[]).map(r=>({severity:r.severity, count:r.count, open:r.open, ack:r.ack, resolved:r.resolved,
      mtta:fmtSec(r.mtta), mttr:fmtSec(r.mttr),
      sevCol:{Severe:'var(--crit)',High:'var(--high)',Medium:'var(--gold)',Low:'var(--low)'}[r.severity]||'var(--text2)'}));

    // ===== INCIDENT TICKET MODAL =====
    const mtType=st.modal?st.modal.type:'';
    const tk=(mtType==='ticket' && st.modal.data)? (st.events.find(x=>x.id===st.modal.data.id)||st.modal.data) : null;
    let mTicket=null, tktTabs=[], tktComments=[], tktHistory=[], tktFilesV=[], tktRemarks=[], tktMatrix=[];
    let tktNearV=[], tktNearLoading=false, tktNearEmpty=false;
    let tktStageAck='—', tktStageRes='—';
    if(tk){
      const m=this.MODS[tk.mod]||{}; const sm=statusMeta[tk.status]||{label:tk.status,col:'var(--text2)'};
      const sla=slaOf(tk); const pr=progOf(tk);
      const elapsedMs=(tk.status==='resolved'&&tk.resolvedTs)?(tk.resolvedTs-tk.ts):(st.now-tk.ts);
      const sevOrder=['low','medium','high','critical']; const si=sevOrder.indexOf(tk.sev);
      mTicket={tag:m.tag||'EVT', tagBg:m.tagBg||'var(--low)',
        code:tk.ticket||('DETECTION · '+String(tk.id).slice(-6)), codeCol:tk.ticket?'var(--brand)':'var(--text3)',
        notTicket:!tk.ticket, onTicket:()=>this.makeTicket(tk.id),
        title:tk.title, sev:tk.sev, sevColor:this.SEV[tk.sev], statusLabel:sm.label, statusCol:sm.col,
        slaLabel:sla.label, slaCol:sla.col, prog:pr.p, progW:pr.p+'%', progCol:pr.col,
        elapsed:this.fmtDur(elapsedMs), camera:tk.camera, device:tk.device||tk.zone,
        received:tk.received||'', assignee:tk.assignee||'—',
        // evidence — link back to the source detection
        thumb: tk.image? ("url('"+tk.image+"') center/cover no-repeat") : 'linear-gradient(160deg,#141830,#0c0f1d)',
        onExpand:()=>{ if(tk.image) this.openLightbox(tk.image, (tk.ticket||'Detection')+' · '+tk.camera+' · '+(tk.received||'')); },
        onViewDetection:()=>this.openModal('event', tk),
        escUp:()=>{ if(si<3) this.tktPost(tk.id,'severity',{severity:sevOrder[si+1], actor:this.UNAME, note:st.tktNote||null},'Escalated ▲'); },
        escDown:()=>{ if(si>0) this.tktPost(tk.id,'severity',{severity:sevOrder[si-1], actor:this.UNAME, note:st.tktNote||null},'De-escalated ▼'); }};
      tktTabs=[['comm','Communication'],['near','Nearby detections'],['esc','Escalation'],['att','Attachments'],['hist','Change history'],['close','Closing']].map(([k,label])=>{
        const a=st.tktTab===k;
        return {label, onClick:()=>{ this.setState({tktTab:k});
            if(k==='att') setTimeout(()=>this.bindDrop(), 90);
            if(k==='comm') this.scheduleComm(); },
          bar:a?'var(--brand)':'transparent', color:a?'var(--text)':'var(--text3)'};});
      // Nearby detections: same camera, minute leading up to this event.
      tktNearLoading = st.tktNear===null;
      const nearSorted=(st.tktNear||[]).slice().sort((a,b)=>String(a.trigger_time||a.received_at||'').localeCompare(String(b.trigger_time||b.received_at||'')));
      tktNearV=nearSorted.map(e=>{
        const img=(e.images&&e.images.trigger)||null;
        const cur=String(e.uuid||e.id)===String(tk.id);
        return {cur, hasImg:!!img,
          cls: cur?'tkt-n-card cur':'tkt-n-card',
          thumb: img?("url('"+img+"') center/cover no-repeat"):'linear-gradient(160deg,var(--bg4),var(--bg2))',
          time:String(e.trigger_time||e.received_at||'').slice(11,19)||'—',
          kind:e.trigger_image_type||e.event_type||'detection',
          onClick:()=>{ if(img) this.openLightbox(img,(e.trigger_image_type||'Detection')+' · '+tk.camera+' · '+(e.trigger_time||e.received_at||'')); }};
      });
      tktNearEmpty = !tktNearLoading && tktNearV.length===0;
      const log=st.tktLog||[];
      const kindCol={comment:'var(--low)', status:'var(--gold)', severity:'var(--high)', ticketed:'var(--brand)',
        notify:'var(--brand)', tmforce:'var(--crit)', attachment:'var(--text2)', remark:'var(--ok)', system:'var(--text3)', detected:'var(--crit)'};
      tktComments=log.filter(l=>['comment','notify','tmforce','remark'].indexOf(l.kind)>=0).map(l=>({
        actor:l.actor||'—', when:l.created_at||'', kind:l.kind, col:kindCol[l.kind]||'var(--low)',
        text:l.note||((l.from_val||'')+' → '+(l.to_val||''))}));
      // change history with per-step elapsed time
      const parseTs=(s)=> s?(Date.parse(String(s).replace(' ','T'))||null):null;
      const entries=[{kind:'detected', actor:'inference engine', created:tk.ts, when:this.ago(tk.ts),
          text:'Detection received from VisionAI · '+tk.camera, col:kindCol.detected}]
        .concat(log.map(l=>({kind:l.kind, actor:l.actor||'—', created:parseTs(l.created_at)||tk.ts, when:l.created_at||'',
          text: l.kind==='status'?('Status '+(l.from_val||'?')+' → '+(l.to_val||'?'))
              : l.kind==='severity'?('Level '+(l.from_val||'auto')+' → '+(l.to_val||''))
              : (l.note||l.to_val||l.kind), col:kindCol[l.kind]||'var(--text2)'})));
      tktHistory=entries.map((en,i)=>({kind:en.kind, actor:en.actor, when:en.when, col:en.col, text:en.text,
        created:en.created, deltaMs:i===0?0:Math.max(0, en.created-entries[i-1].created),
        delta:i===0?'0m':this.fmtDur(Math.max(0, en.created-entries[i-1].created))}));
      tktFilesV=(st.tktFiles||[]).map(f=>({name:f.name, url:f.url,
        by:f.by||'—', at:f.at||'',
        size:f.size>1048576?(f.size/1048576).toFixed(1)+' MB':Math.max(1,Math.round((f.size||0)/1024))+' KB'}));
      tktRemarks=tktComments.filter(c=>c.kind==='remark').map(c=>({actor:c.actor, when:c.when, text:c.text}));
      tktMatrix=[['critical','ERT + SOC + email all recipients','ack 5m · resolve 1h'],
                 ['high','SOC + email recipients','ack 15m · resolve 4h'],
                 ['medium','Supervisor email','ack 1h · resolve 8h'],
                 ['low','Dashboard + bell only','ack 4h · resolve 24h']].map(([lv,inform,target])=>({
        level:lv, inform, target, col:this.SEV[lv],
        isCur:lv===tk.sev, notCur:lv!==tk.sev, bg:lv===tk.sev?'var(--bg4)':'transparent'}));
      tktStageAck=tk.ackedTs?this.fmtDur(tk.ackedTs-tk.ts):'pending';
      tktStageRes=(tk.ackedTs&&tk.resolvedTs)?this.fmtDur(tk.resolvedTs-tk.ackedTs):'pending';
    }
    // Change-history: filter + sort + pagination (12 rows/page)
    const hq=(st.tktHistQ||'').trim().toLowerCase();
    const hSort=st.tktHistSort||{k:'created',d:1};
    const histList=tktHistory
      .filter(h=>!hq || (h.kind+' '+h.actor+' '+h.text+' '+h.when).toLowerCase().includes(hq))
      .sort((a,b)=>{ const va=a[hSort.k], vb=b[hSort.k];
        return ((typeof va==='number'&&typeof vb==='number')? va-vb : String(va??'').localeCompare(String(vb??'')))*hSort.d; });
    const histPS=12, tktHistPages=Math.max(1, Math.ceil(histList.length/histPS));
    const hp=Math.min(st.tktHistPage||0, tktHistPages-1);
    const tktHistRows=histList.slice(hp*histPS, hp*histPS+histPS);
    const tktHistPager={has:tktHistPages>1, label:'Page '+(hp+1)+' / '+tktHistPages+' · '+histList.length+' entries',
      prev:()=>this.setState({tktHistPage:Math.max(0, hp-1)}), next:()=>this.setState({tktHistPage:Math.min(tktHistPages-1, hp+1)})};
    const tktHistHead=[['created','TIME'],['kind','TYPE'],['actor','ACTOR'],['text','CHANGE'],['deltaMs','TIME SPENT']].map(([k,label])=>({
      label:label+(hSort.k===k?(hSort.d>0?' ▲':' ▼'):''),
      onClick:()=>this.setState({tktHistSort:{k, d:(hSort.k===k? -hSort.d : 1)}, tktHistPage:0})}));
    // ===== USERS & ROLES =====
    const umU=st.umUsers||[], umR=st.umRoles||[], umD=st.umDraft||{};
    const umRoleNames=umR.length?umR.map(r=>r.name):['admin','supervisor','operator','viewer'];
    const umRoleChips=umRoleNames.map(n=>{ const a=(umD.role||'operator')===n;
      return {label:n, onClick:()=>this.umSet('role',n), cls:a?'chip on':'chip'}; });
    const umRows=umU.map(u=>({
      id:u.id, name:u.name, username:'@'+u.username, email:u.email||'—', lastLogin:u.lastLogin, isMe:!!u.isMe,
      initials:String(u.name||u.username).split(/\s+/).map(w=>w.charAt(0)).slice(0,2).join('').toUpperCase(),
      roleOpts:umRoleNames.map(n=>{ const a=u.role===n;
        return {label:n, onClick:()=>{ if(!a) this.umPost('users/'+u.id, {role:n}, 'Role updated ✓'); },
          cls:a?'chip on':'chip'}; }),
      activeBg:u.active?'var(--ok)':'var(--line2)', activeKnob:u.active?'18px':'2px',
      onToggle:()=>this.umPost('users/'+u.id, {active:!u.active}, u.active?'User deactivated':'User activated ✓'),
      onReset:()=>this.umResetPw(u), onDelete:()=>this.umDelUser(u)}));
    const umRoleCards=umR.map(r=>({name:r.name, desc:r.desc||'—',
      users:r.users+' user'+(r.users===1?'':'s'), builtin:!!r.builtin, canDelete:!r.builtin&&r.users===0,
      perms:Object.keys(st.umPerms||{}).map(p=>{ const on=!!(r.perms||{})[p];
        const locked=r.name==='admin'&&(p==='users'||p==='view');
        return {label:p, title:(st.umPerms||{})[p]||p, dot:on?'var(--ok)':'var(--text3)',
          bg:on?'color-mix(in srgb, var(--ok) 10%, var(--bg3))':'var(--bg3)',
          border:on?'var(--ok)':'var(--line)', color:on?'var(--text)':'var(--text3)',
          onClick:()=>{ if(locked){ this.setState({umMsg:'admin always keeps '+p}); return; }
            this.umPost('roles', {name:r.name, desc:r.desc, perms:{...(r.perms||{}), [p]:!on}}, 'Role saved ✓'); }}; }),
      onDelete:()=>this.umDelRole(r.name)}));

    const tktCloseTabs=['False alarm','Issue resolved','Under monitoring','Fix scheduled','Duplicate','No action required']
      .map(t=>{ const a=st.tktCloseType===t;
        return {label:(a?'✓ ':'')+t, onClick:()=>this.setState({tktCloseType:t}),
          cls:a?'chip on':'chip'}; });
    const tktRemarkLen=String((st.tktRemark||'').length);
    const tktRawFiles=st.tktFiles||[];
    const tktBytes=tktRawFiles.reduce((a,f)=>a+(f.size||0),0);
    const tktFileSummary=tktRawFiles.length? (tktRawFiles.length+' file'+(tktRawFiles.length===1?'':'s')+' · '
      +(tktBytes>1048576?(tktBytes/1048576).toFixed(1)+' MB':Math.max(1,Math.round(tktBytes/1024))+' KB')) : 'no files yet';

    // ===== CAMERAS =====
    // The fleet page lists the full VisionAI device registry (st.fleet) —
    // merged with the detection frame/module from camPool where a camera has
    // recent detections. Falls back to camPool if the registry is unavailable.
    const _scene=(img)=> img ? `url('${img}') center/cover no-repeat` : 'linear-gradient(160deg,#141830,#0c0f1d)';
    const _fleet=st.fleet||[];
    const camSource = _fleet.length
      ? _fleet.map(f=>{ const cp=this.camPool.find(c=>c.stream===f.stream)||null;
          return {id:(f.stream||f.serial||'CAM').toUpperCase(), stream:f.stream||'', name:f.name, zone:f.zone||f.type||'', serial:f.serial||'',
            res:'1440p', fps:25, scene: cp?cp.scene:_scene(f.image), mod: cp?cp.mod:'intr', online:!!f.online, image:f.image}; })
      : this.camPool.map(c=>({id:c.id, stream:c.stream||'', name:c.name, zone:c.zone, serial:c.serial||'',
            res:c.res, fps:c.fps, scene:c.scene, mod:c.mod, online:true, image:c.img}));
    const camAll=camSource.map((c,i)=>{
      const m=this.MODS[c.mod]||this.MODS.intr;
      return {id:c.id, stream:c.stream, name:c.name, zone:c.zone, res:c.res, fps: c.online?c.fps:0, scene:c.scene,
        tag:m.tag, tagBg:m.tagBg, modName:{fire:'Fire & Smoke',ppe:'PPE',intr:'Intrusion',face:'Face & Body'}[c.mod]||'—',
        online:c.online, statusLabel: c.online?'Online':'Offline', statusCol: c.online?'var(--ok)':'var(--text3)',
        health: c.online?(84+(i*7)%13):0, healthW:(c.online?(84+(i*7)%13):0)+'%', healthCol: c.online?'var(--ok)':'var(--text3)',
        rec: c.online, recLabel: c.online?'REC':'—',
        // Live Monitoring visibility toggle (persisted in app settings).
        liveViewLabel: this.isLiveHidden(c)?'HIDDEN':'SHOWN',
        liveColor: this.isLiveHidden(c)?'var(--text3)':'var(--ok)',
        liveBg: this.isLiveHidden(c)?'var(--bg3)':'rgba(45,190,120,.12)',
        liveBorder: this.isLiveHidden(c)?'var(--line)':'rgba(45,190,120,.4)',
        liveHint: this.isLiveHidden(c)?'Click to show this camera on Live Monitoring':'Click to hide this camera from Live Monitoring',
        onToggleLive:(ev)=>this.toggleLiveCam(c, ev),
        onOpen:()=>this.openCamera(c.stream||String(c.id).toLowerCase())};
    });
    const camFiltered=camAll.filter(c=> st.camFilter==='all'?true: st.camFilter==='online'?c.online: st.camFilter==='offline'?!c.online: c.tag.toLowerCase()===st.camFilter);
    const camTabs=[['all','All'],['online','Online'],['offline','Offline']].map(([k,label])=>{
      const a=st.camFilter===k; const n=k==='all'?camAll.length:k==='online'?camAll.filter(c=>c.online).length:camAll.filter(c=>!c.online).length;
      return {label, count:n, onClick:()=>this.setCamFilter(k), cls:a?'chip on':'chip'};
    });
    const camStats=[
      {label:'Total cameras', value:String(camAll.length), tone:'var(--text)'},
      {label:'Online', value:String(camAll.filter(c=>c.online).length), tone:'var(--ok)'},
      {label:'Offline', value:String(camAll.filter(c=>!c.online).length), tone:'var(--crit)'},
      {label:'Recording', value:String(camAll.filter(c=>c.rec).length), tone:'var(--low)'},
      {label:'Avg FPS', value:'27', tone:'var(--gold)'},
    ];

    // ===== ANALYTICS =====
    const rangeTabs=[['24h','24 hours'],['7d','7 days'],['30d','30 days']].map(([k,label])=>{
      const a=st.aRange===k; return {label, onClick:()=>this.setRange(k), cls:a?'chip on':'chip'};
    });
    const bt=st.byType||{}; const totalDet=(bt.fire||0)+(bt.ppe||0)+(bt.intr||0)+(bt.face||0);
    const aKpis=[
      {label:'Total detections', value:totalDet.toLocaleString(), delta:'live · 24h window', tone:'var(--ok)'},
      {label:'Incidents raised', value:String(openCount), delta:openCount+' open now', tone:'var(--crit)'},
      {label:'Avg time to ack', value:'1:48', delta:'rolling avg', tone:'var(--ok)'},
      {label:'PPE compliance', value:(st.live.ppePct!=null?st.live.ppePct:100)+'%', delta:(st.live.ppeOpen||0)+' violations', tone:'var(--ok)'},
      {label:'Cameras online', value:String(st.live.camsTotal!=null?st.live.camsTotal:this.camPool.length), delta:'VisionAI streams', tone:'var(--ok)'},
    ];
    const byTypeRaw=[['Intrusion',bt.intr||0,'var(--crit)'],['PPE',bt.ppe||0,'var(--gold)'],['Fire & Smoke',bt.fire||0,'var(--high)'],['Face & Body',bt.face||0,'var(--low)']];
    const byTypeMax=Math.max(1,...byTypeRaw.map(r=>r[1]));
    const byType=byTypeRaw.map(([label,v,col])=>({label, value:v.toLocaleString(), w:Math.round(v/byTypeMax*100)+'%', col}));
    const bcEntries=Object.entries(st.byCam||{}).sort((a,b)=>b[1]-a[1]).slice(0,8);
    const byCamMax=Math.max(1,...bcEntries.map(e=>e[1]));
    const byCam=bcEntries.map(([label,v])=>({label, value:String(v), w:Math.round(v/byCamMax*100)+'%'}));
    const sevCount={critical:0,high:0,medium:0,low:0};
    st.events.forEach(e=>{ sevCount[e.sev]=(sevCount[e.sev]||0)+1; });
    const sevTot=Math.max(1, st.events.length);
    const pC=Math.round(sevCount.critical/sevTot*100), pH=Math.round(sevCount.high/sevTot*100), pM=Math.round(sevCount.medium/sevTot*100);
    const pL=Math.max(0,100-pC-pH-pM);
    const donut={style:`conic-gradient(var(--crit) 0 ${pC}%, var(--high) ${pC}% ${pC+pH}%, var(--gold) ${pC+pH}% ${pC+pH+pM}%, var(--low) ${pC+pH+pM}% 100%)`};
    const donutLegend=[['Critical',pC,'var(--crit)'],['High',pH,'var(--high)'],['Medium',pM,'var(--gold)'],['Low',pL,'var(--low)']].map(([l,p,c])=>({label:l, pct:p+'%', col:c}));
    const compTrend=[88,90,89,92,91,93,92].map((v,i)=>({h:v+'%', label:['M','T','W','T','F','S','S'][i], val:v}));

    // ===== DETECTION MODULE PAGE =====
    const mailOn=!!(st.mail && st.mail.enabled);
    const mailTo=mailOn?(st.mail.to||[]).join(', '):'';
    const armedInfo=st.armed||{window:'always', active:true};
    let det=null;
    if(isDet){
      const key=st.page;
      const cams=this.camPool.filter(c=>c.mod===key).map(c=>({id:c.id, name:c.name, zone:c.zone, scene:c.scene,
        canExpand:!!c.img, onExpand:()=>this.openLightbox(c.img, c.name+' · '+c.id)}));
      const modEvents=st.events.filter(e=>e.mod===key);
      const thumbOf=(img)=> img?`url('${img}') center/cover no-repeat`:'linear-gradient(160deg,var(--bg4),var(--bg2))';
      let recent=modEvents.map(e=>({title:e.title, camera:e.camera, ago:this.ago(e.ts), sevColor:this.SEV[e.sev], sev:e.sev,
        conf:(e.conf!=null?Number(e.conf).toFixed(2):'—'), image:e.image, canExpand:!!e.image,
        thumb:thumbOf(e.image), hasImg:!!e.image, cursor:e.image?'zoom-in':'default', rowCursor:'pointer',
        thumbTitle:e.image?'Click to enlarge':'No detection frame', rowTitle:'Open detection details',
        onExpand:(ev)=>{ if(ev&&ev.stopPropagation)ev.stopPropagation(); if(e.image) this.openLightbox(e.image, e.title); },
        onView:()=>this.openModal('event', e)}));
      const nDet=String(modEvents.length);
      const nOpen=String(modEvents.filter(e=>e.status==='open').length);
      // Real average confidence over this module's live detections.
      const confs=modEvents.map(e=>e.conf).filter(v=>v!=null).map(Number);
      const avgConf=confs.length?(confs.reduce((a,b)=>a+b,0)/confs.length).toFixed(2):'—';
      const pp=st.ppe||{total:0, pct:100, missing:0, wearing:0, list:[]};
      const fb2=st.faceR;
      const kpiSets={
        fire:[['Detections · 24h',nDet,'var(--high)'],['Active cameras',String(cams.length),'var(--text)'],['Avg confidence',avgConf,'var(--ok)'],['Open incidents',nOpen,'var(--crit)']],
        ppe:[['PPE checks · 24h',String(pp.total),'var(--gold)'],['Wearing vest',String(pp.wearing),'var(--ok)'],['Compliance rate',(pp.total>0?pp.pct:100)+'%','var(--ok)'],['Violations · no vest',String(pp.missing),'var(--high)']],
        intr:[['Detections · 24h',nDet,'var(--crit)'],['Active cameras',String(cams.length),'var(--text)'],['Avg confidence',avgConf,'var(--ok)'],['Open incidents',nOpen,'var(--crit)']],
        face:[['Person detections · 24h',String(fb2?fb2.total:modEvents.length),'var(--low)'],['Cameras seeing people',String(fb2?Object.keys(fb2.byCam||{}).length:cams.length),'var(--text)'],['Male / Female',fb2?(((fb2.gender||{}).Male||0)+' / '+((fb2.gender||{}).Female||0)):'—','var(--ok)'],['Strangers flagged',nOpen,'var(--high)']],
      };
      // PPE page: recent list = real body-attribute vest checks from the feed.
      if(key==='ppe' && pp.list && pp.list.length){
        recent=pp.list.slice(0,8).map(r=>{ const lbl=(r.vest?'PPE OK':'No vest')+' · '+(r.device||'');
          const open=()=>{ if(r.image) this.openLightbox(r.image, lbl); };
          return {title:(r.vest?'PPE OK — ':'No vest — ')+(r.person||'person')+(r.tops?' · '+String(r.tops).toLowerCase():''),
            camera:String(r.device||r.stream||'').toUpperCase(), ago:String(r.time||'').replace(/\.\d+$/,''),
            sevColor:r.vest?'var(--ok)':'var(--high)', sev:r.vest?'low':'high', conf:'—', image:r.image, canExpand:!!r.image,
            thumb:thumbOf(r.image), hasImg:!!r.image, cursor:r.image?'zoom-in':'default', rowCursor:r.image?'zoom-in':'default',
            thumbTitle:r.image?'Click to enlarge':'No detection frame', rowTitle:r.image?'Click to enlarge':'',
            onExpand:(ev)=>{ if(ev&&ev.stopPropagation)ev.stopPropagation(); open(); }, onView:open}; });
      }
      const kpis2=kpiSets[key].map(([label,value,tone])=>({label,value,tone}));
      let cls=dm.classes.map((c,i)=>({label:c, acc:(94-i*2)+'%', w:(94-i*2)+'%', col:dm.col}));
      // PPE detection classes: real observed wear-rates from body attributes.
      if(key==='ppe' && fb2){
        const rate=(o,good)=>{ const t=Object.values(o||{}).reduce((a,b)=>a+b,0); return t?Math.round((o[good]||0)/t*100):null; };
        const hatRate=(()=>{ const o=fb2.hats||{}; const t=Object.values(o).reduce((a,b)=>a+b,0); return t?Math.round((t-(o.NoHat||0))/t*100):null; })();
        const real=[['Hi-vis vest · worn',rate(fb2.vest,'ReflectiveVest')],['Head cover · worn',hatRate],['Face mask · worn',rate(fb2.mask,'WithMask')]]
          .filter(r=>r[1]!=null).map(([label,p])=>({label, acc:p+'%', w:p+'%', col:dm.col}));
        if(real.length) cls=real;
      }
      const extraDefs={
        intr:[['Armed window', armedInfo.window==='always'?'Always armed':(armedInfo.window==='off'?'Disarmed':armedInfo.window)],
              ['Alert state', armedInfo.active?'ARMED — alerts firing':'Standby — outside window'],
              ['Email alerts', mailOn?('On → '+mailTo):'Off']],
        fire:[['Push source','VisionAI X-model · smoke/flame'],
              ['Email alerts', mailOn?('Immediate → '+mailTo):'Off']],
        ppe: [['Detection source','SenseTime body attributes'],
              ['Email alerts', mailOn?('On → '+mailTo):'Off']],
        face:[['Stranger rule','Person Group −99 → HIGH'],
              ['Email alerts', mailOn?('On → '+mailTo):'Off']],
      };
      const rep=st.report;
      const attrTitle={fire:'Smoking vs no-smoking', ppe:'PPE compliance by item', intr:'Intruders by gender / angle'}[key]||'Attribute breakdown';
      det={key, isFace:key==='face', isMod:(key==='fire'||key==='ppe'||key==='intr'), name:dm.name, desc:dm.desc, tag:dm.tag, col:dm.col, model:dm.model,
        kpis:kpis2, cams, recent, hasRecent:recent.length>0, classes:cls,
        reportTotal:String(rep?rep.total:modEvents.length), avgConf:(rep&&rep.avgConf!=null?Number(rep.avgConf).toFixed(2):avgConf), attrTitle,
        extra:(extraDefs[key]||[]).map(([k2,v2])=>({k:k2, v:v2})),
        threshold:key==='face'?'0.75':'0.80', thresholdW:key==='face'?'75%':'80%',
        cooldown:(st.mail && st.mail.cooldownMin)?(st.mail.cooldownMin+'m email'):'30s', minSize:'2.5%'};
    }

    // ===== ALERT RULES (live settings from /api/alerts) =====
    const chipRow=(opts, cur, cb)=>opts.map(([val,label])=>{ const a=String(cur)===String(val);
      return {label, onClick:()=>cb(val), cls:a?'chip on':'chip'}; });
    const ac=st.alertCfg;
    const arModDefs=[
      ['fire','FIRE','var(--high)','Fire & smoke → email', 'Any smoke/flame push from VisionAI', 'critical','var(--crit)'],
      ['ppe','PPE','var(--gold)','PPE violation → email', 'Missing vest / helmet body attribute', 'medium','var(--med)'],
      ['intr','INTR','var(--crit)','Intrusion detection', 'Person in monitored zone · armed window applies', 'high','var(--high)'],
      ['face','FACE','var(--low)','Face & body / stranger', 'Stranger (Person Group −99) escalates HIGH', 'high','var(--high)'],
    ];
    const arRules = ac? arModDefs.map(([mod,tag,tagBg,name,cond,sevL,sevC])=>{
      const on = ac.mods_enabled ? (ac.mods_enabled[mod]!==false) : true;
      const always = (ac.always_mods||[]).includes(mod);
      return {tag, tagBg, name, cond, sev:sevL, sevCol:sevC,
        toggleBg:on?'var(--ok)':'var(--line2)', knobX:on?'18px':'2px',
        onToggle:()=>{ const me={fire:true,ppe:true,intr:true,face:true,...(ac.mods_enabled||{})}; me[mod]=!on; this.saveAlerts({mods_enabled:me}); },
        alwaysLabel: always?'Always':'Severity-based',
        alwaysBg:always?'var(--brand)':'var(--bg3)', alwaysCol:always?'#fff':'var(--text2)', alwaysBorder:always?'var(--brand)':'var(--line)',
        onAlways:()=>{ const am=(ac.always_mods||[]).slice(); const i=am.indexOf(mod); i>=0?am.splice(i,1):am.push(mod); this.saveAlerts({always_mods:am}); }};
    }) : [];
    const arActive = arRules.filter(r=>r.knobX==='18px').length;
    const arSev = ac? chipRow([['low','Every detection'],['medium','Medium +'],['high','High +'],['critical','Critical only'],['off','Off']], ac.min_severity, v=>this.saveAlerts({min_severity:v})) : [];
    const arArmed = ac? chipRow([['always','Always armed'],['22:00-06:00','After hours 22:00–06:00'],['06:00-22:00','Working hours 06:00–22:00'],['off','Disarmed']], ac.intr_armed, v=>this.saveAlerts({intr_armed:v})) : [];
    const arCool = ac? chipRow([[1,'1 min'],[5,'5 min'],[15,'15 min'],[30,'30 min'],[60,'60 min']], ac.cooldown_min, v=>this.saveAlerts({cooldown_min:v})) : [];
    const arMasterOn = ac? (ac.email_enabled!==false) : true;
    const arMailList = ac? (Array.isArray(ac.mail_to)?ac.mail_to:String(ac.mail_to||'').split(',').map(s=>s.trim()).filter(Boolean)) : [];
    const arMailVal = st.arMailDraft!=null ? st.arMailDraft : arMailList.join(', ');
    const arArmedActive = ac? (ac.armed_now!==false) : (armedInfo.active!==false);

    // ===== SETTINGS (live config from /api/settings) =====
    const ap=st.appCfg, ad=st.appDraft||{};
    const spV=(k)=>ad[k]!=null?ad[k]:((ap&&ap[k]!=null)?ap[k]:'');
    const spIn=(k)=>(e)=>this.setDraft(k, e&&e.target?e.target.value:'');
    const spAiCur=spV('ai_source')||'weststar';
    const spAiChips = chipRow([['weststar','weststar-ai'],['anthropic','Anthropic API'],['off','Off']], spAiCur, v=>{ this.setDraft('ai_source',v); this.saveApp({ai_source:v}); });
    const spFreq = chipRow([['off','Off'],['daily','Daily'],['weekly','Weekly'],['monthly','Monthly'],['yearly','Yearly']], spV('report_frequency')||'off', v=>{ this.setDraft('report_frequency',v); this.saveApp({report_frequency:v}); });
    const spHour = chipRow([[7,'07:00'],[8,'08:00'],[12,'12:00'],[18,'18:00'],[20,'20:00']], spV('report_hour')===''?8:spV('report_hour'), v=>{ this.setDraft('report_hour',v); this.saveApp({report_hour:v}); });
    const spRepTo = st.spRepDraft!=null ? st.spRepDraft : (ap? (ap.report_recipients||[]).join(', ') : '');
    const spEp = (ap&&ap.endpoints)||{};

    // ===== FORECAST (prediction from /api/forecast) =====
    const fd=st.fcData;
    const fcHas=!!(fd&&fd.forecast&&fd.agg);
    const ff=fcHas?fd.forecast:null, fa=fcHas?fd.agg:null;
    const fcDaysTabs = chipRow([[7,'7 days'],[14,'14 days'],[30,'30 days'],[90,'90 days']], st.fcDays, v=>this.setFcDays(v));
    const fcKpis = fcHas? [
      {label:'Detections · '+fa.days+'d', value:String(fa.total), tone:'var(--text)'},
      {label:'Avg / day', value:String(ff.avgPerDay), tone:'var(--low)'},
      {label:'Momentum', value:(ff.trend.total.pct>=0?'+':'')+ff.trend.total.pct+'%', tone:ff.trend.total.pct>0?'var(--high)':(ff.trend.total.pct<0?'var(--ok)':'var(--text2)')},
      {label:'Predicted tomorrow', value:String(ff.next7[0].predicted), tone:'var(--gold)'},
      {label:'Peak hour', value:String(ff.peakHour).padStart(2,'0')+':00', tone:'var(--low)'},
    ] : [];
    const fcTrends = fcHas? [['Fire & Smoke','fire','var(--high)'],['PPE','ppe','var(--gold)'],['Intrusion','intr','var(--crit)'],['Face & Body','face','var(--low)']].map(([label,k,col])=>{
      const p=ff.trend[k].pct;
      return {label, col, pct:(p>0?'+':'')+p+'%', dir:p>0?'▲':(p<0?'▼':'—'),
        tone:p>0?'var(--high)':(p<0?'var(--ok)':'var(--text3)'), sub:ff.trend[k].first+' → '+ff.trend[k].second};
    }) : [];
    const fcAi = (fd&&fd.ai)||null;
    const fcOutlook = fcAi? (fcAi.outlook||'stable') : 'stable';

    // ===== SETTINGS =====
    const kv=(arr)=>arr.map(([k,v])=>({k,v}));
    const setInference=kv([
      ['Inference endpoint','rtsp-infer.cpbrand.local:8501'],['GPU allocation','4 × NVIDIA A10 · 72% avg'],
      ['Batch size','8 frames'],['Max latency budget','40 ms'],
    ]);
    // Detection models — policy counts are scoped to the cameras currently
    // shown on Live Monitoring (hidden cameras don't count).
    const _lowKeys=(o)=>[o.stream,o.serial,o.id].filter(Boolean).map(v=>String(v).toLowerCase());
    const liveShown=this.livePool();
    const liveKeys={};
    liveShown.forEach(t=>_lowKeys(t).forEach(k=>{ liveKeys[k]=1; }));
    const polSeen={fire:{},ppe:{},intr:{},face:{}}, polCams={fire:{},ppe:{},intr:{},face:{}}, polCamAll={};
    (st.policies||[]).forEach(p=>{
      const camKey=String(p.stream||p.serial||'').toLowerCase();
      if(!camKey || !liveKeys[camKey]) return;
      const m=polSeen[p.mod]?p.mod:'intr';
      polSeen[m][p.policy]=1; polCams[m][camKey]=1; polCamAll[camKey]=1;
    });
    const setModels=[
      ['fire','Fire & Smoke','YOLOv8-fire · v2.4'],['ppe','PPE','PPE-Net · v3.1'],
      ['intr','Intrusion','Tracker-XR · v1.9'],['face','Face & Body','FaceAttr · v4.0'],
    ].map(([mod,label,model])=>{
      const n=Object.keys(polSeen[mod]).length, c=Object.keys(polCams[mod]).length;
      return {k:label, model, v: n+' polic'+(n===1?'y':'ies')+' · '+c+' cam'+(c===1?'':'s'),
        tone: n?'var(--ok)':'var(--text3)', dot: n?'var(--ok)':'var(--line2)'};
    });
    const setModelsNote='Enabled policies seen in the last 30 days across the '
      +liveShown.length+' camera'+(liveShown.length===1?'':'s')+' shown on Live Monitoring · '
      +Object.keys(polCamAll).length+' of them reporting detections';
    const setStream=kv([
      ['Default protocol','RTSP / H.264'],['Ingest resolution','1080p @ 25fps'],['Clip retention','30 days'],['Snapshot storage','S3 · cp-evidence'],
    ]);
    const setNotify=[
      ['SOC dashboard','Enabled',true],['SMS gateway','Enabled · Twilio',true],['Email digest','Daily 07:00',true],['Siren relay','Critical only',true],['Slack / Teams','Disabled',false],
    ].map(([label,val,on])=>({label,val,on,dot:on?'var(--ok)':'var(--text3)'}));

    // ===== MODALS + SEARCH =====
    const fmtTs=(ms)=>{ const dt=new Date(ms); const p=n=>String(n).padStart(2,'0');
      return `${dt.getFullYear()}-${p(dt.getMonth()+1)}-${p(dt.getDate())} ${p(dt.getHours())}:${p(dt.getMinutes())}:${p(dt.getSeconds())}`; };
    const sevLabel={critical:'Critical',high:'High',medium:'Medium',low:'Low'};
    const alertName={'0':'Low','1':'Medium','2':'High','3':'Severe'};
    const grad='linear-gradient(160deg,#141830,#0c0f1d)';
    const bgOf=(img)=> img? `url('${img}') center/cover no-repeat` : grad;
    const maskRtsp=(u)=> (u||'').replace(/\/\/([^:]+):[^@]+@/, '//$1:••••@');
    const modal=st.modal; const mt=modal?modal.type:'';

    // ===== CAMERA DETAIL PAGE =====
    let camDetail=null;
    if(st.page==='camera'){
      const key=st.camSel;
      const f=(st.fleet||[]).find(x=>x.stream===key) || null;
      const cam=this.camPool.find(c=>c.stream===key) || null;
      const stream = f?f.stream : (cam?cam.stream:key);
      const _tokq = st.liveToken ? ('&token='+encodeURIComponent(st.liveToken)) : '';
      const live = !!st.liveBase && !!stream && !st.demo;
      const ed=st.camEdit||{};
      camDetail={
        name: (f&&f.name) || (cam&&cam.name) || key || 'Camera',
        stream, did: f?f.did:'', serial: (f&&f.serial) || (cam&&cam.serial) || '',
        type: f?(f.type||'—'):'—', online: f?f.online:(cam?true:false),
        statusLabel: f?(f.online?'Online':'Offline'):(cam?'Detecting':'Unknown'),
        statusCol: (f&&f.online)||cam ? 'var(--ok)':'var(--text3)',
        rtspMask: maskRtsp(f?f.rtsp:'') || 'not set',
        hasLive: live, noLive: !live,
        mp4Url: live ? (st.liveBase+'/api/stream.mp4?src='+encodeURIComponent(stream)+_tokq) : '',
        streamUrl: (st.liveBase&&stream) ? (st.liveBase+'/stream.html?src='+encodeURIComponent(stream)+_tokq) : '',
        popUrl: (st.liveBase&&stream) ? (st.liveBase+'/stream.html?src='+encodeURIComponent(stream)+_tokq) : '',
        frameBg: bgOf(cam?cam.img:null), noFrame: !(cam&&cam.img),
        canEdit: !!(f&&f.did),
        editName: ed.name!=null?ed.name:(f?f.name:''), editRtsp: ed.rtsp!=null?ed.rtsp:(f?f.rtsp:''),
        editTag: ed.tag||'', editDesc: ed.desc||'', saveMsg: st.camMsg||'',
        onEditName:(e)=>this.setCamEdit({name:e&&e.target?e.target.value:''}),
        onEditRtsp:(e)=>this.setCamEdit({rtsp:e&&e.target?e.target.value:''}),
        onEditTag:(e)=>this.setCamEdit({tag:e&&e.target?e.target.value:''}),
        onEditDesc:(e)=>this.setCamEdit({desc:e&&e.target?e.target.value:''}),
        onSave:()=>this.saveCamera(),
        onBack:()=>this.setPage('cameras'), onExpand:()=> (cam&&cam.img)?this.openLightbox(cam.img, (f?f.name:key)):null,
      };
    }

    // Incidents modal — every incident with full details
    const mIncidents=st.events.map((e,i)=>{ const m=this.MODS[e.mod];
      return {id:e.id, code:'INC-'+(1042-i), tag:m.tag, tagBg:m.tagBg, sev:sevLabel[e.sev]||e.sev, sevColor:this.SEV[e.sev],
        title:e.title, camera:e.camera, zone:e.zone, device:e.device, when:fmtTs(e.ts), ago:this.ago(e.ts),
        status:e.status, thumb:bgOf(e.image), onView:()=>this.openModal('event',e)}; });

    // Event detail modal (alert view) — from modal.data
    const ev=(mt==='event' && modal.data)?modal.data:null;
    const mEvent = ev ? (()=>{
      const dec=ev.decoded||{};
      const val=(k)=>dec[k];
      const conf=ev.conf!=null?Math.round(Number(ev.conf)*100):null;
      const confCol=conf==null?'var(--text3)':(conf>=70?'var(--ok)':(conf>=40?'var(--gold)':'var(--crit)'));
      const modNames={fire:'Fire / Smoke Detected', ppe:'PPE Violation Detected', intr:'Intrusion Detected', face:'Person Detected'};
      const tag=(this.MODS[ev.mod]||{}).tag||'EVT';
      const idStr=ev.ticket||(tag+'-'+String(ev.received||'').slice(0,10)+'-'+String(ev.id).slice(-4).toUpperCase());
      const sevRank={low:1, medium:1, high:2, critical:3}[ev.sev]||1;
      const dots=[1,2,3].map(i=>({bg:i<=sevRank?this.SEV[ev.sev]:'var(--bg4)'}));
      const row=(k,v)=>(v!=null&&v!=='')?{k, v:String(v)}:null;
      const join=(a,b)=>[a,b].filter(Boolean).join(' ');
      const cards=[];
      const push=(title,rows)=>{ const rr=rows.filter(Boolean); if(rr.length) cards.push({title, rows:rr}); };
      push('Identity',[row('Gender',val('Gender')),
        row('Age Range',(val('AgeLowerLimit')&&val('AgeUpperLimit'))?(val('AgeLowerLimit')+' – '+val('AgeUpperLimit')):null),
        row('Age Group',val('Age'))]);
      push('Clothing',[row('Tops',join(val('TopsColor'),val('TopsType'))),
        row('Bottoms',join(val('BottomsColor'),val('BottomsType'))),
        row('Shoes',join(val('ShoesColor'),val('ShoesType'))),
        row('Sleeves',val('SleevesType'))]);
      push('Appearance',[row('Hair',val('HairStyle')), row('Hair Color',val('HairColor')),
        row('Build',val('BodyShape')||val('Figure')), row('Uniform',val('UniformType'))]);
      push('Behavior / Posture',[row('Pose',val('Pose')), row('Direction',val('Angle')),
        row('Behavior',val('PedestrianBehavior')), row('Holding items',val('HoldingThings')),
        row('Bag',val('BagType'))]);
      const accDefs=[['Mask','WithMask','WithMask'],['Hat','HatsType',null],['Umbrella','WithUmbrella','WithUnbrella'],
                     ['Reflective Vest','WithReflectiveVest','ReflectiveVest'],['Smoking','Smoking','IsSmoking']];
      const acc=accDefs.map(([label,key,yesVal])=>{ const v=val(key); if(v==null||v===''||v==='Unknown') return null;
        const yes=yesVal?(v===yesVal):!(String(v).toLowerCase().indexOf('no')===0);
        return {label, val:yes?'Yes':'No', icon:yes?'✓':'○', col:yes?'var(--ok)':'var(--text3)'}; }).filter(Boolean);
      const detSummary=[row('Trigger Type',ev.triggerType||'—'), row('Policy',ev.policy||ev.zone),
        row('Analytics Engine','VisionAI · TMLab AI'), row('Event Type',ev.eventType||'—'),
        row('Last Updated',ev.received||'—')].filter(Boolean);
      const sm2=statusMeta[ev.status]||{label:ev.status, col:'var(--text2)'};

      // ── Face view: enrolled profile photo + every capture of this person ──
      // VisionAI sends three frames per face push: the cropped face
      // (triggerImgUrl), the full scene it was cut from (bkImageUrl) and, when
      // the face matched a person group, the enrolled photo (matchImageUrl).
      // Strangers have no enrolled photo, so the newest crop stands in for it.
      const isFace = ev.mod === 'face' || ev.feed === 'face';
      const person = (ev.person || '').trim();
      const personId = (ev.personId || '').trim();
      // Prefer the full record for this personId (fetched from the events API);
      // fall back to whatever the live feed holds until it lands.
      const fetched = (st.evPerson && st.evPerson.id === personId) ? st.evPerson : null;
      // Photo on file for this person: operator profile first, then the photo
      // VisionAI matched against, then the newest capture as a stand-in.
      const enrolled = ((st.people && st.people.profiles) || {})[personId] || null;
      const profileImg = (enrolled && enrolled.photo) || ev.imageMatch || ev.image || ev.imageBk;
      const refImg = (enrolled && enrolled.photo) || ev.imageMatch || '';
      const source = (fetched && fetched.rows.length)
        ? fetched.rows.map(r => ({id:r.id, image:r.trig, imageBk:r.bk, camera:r.camera,
            similarity:r.sim, imageMatch:r.match, triggerTime:r.time, ts:r.ts, title:'Face capture'}))
        : (isFace ? (st.events || []).filter(x =>
            (x.mod === 'face' || x.feed === 'face') && (x.image || x.imageBk) &&
            (personId ? (x.personId || '') === personId
                      : (person ? (x.person || '').trim() === person : x.camera === ev.camera))) : []);
      const related = source.slice();
      // Newest first; the capture that opened this modal keeps its highlight.
      related.sort((a, b) => (b.ts || 0) - (a.ts || 0));
      // Timestamp-range filter (dropdown above the collection).
      const galRange = st.evGalRange || 'all';
      const rangeMs = {'15m':15*60e3, '1h':3600e3, '24h':86400e3, '7d':7*86400e3}[galRange] || 0;
      const inRange = rangeMs ? related.filter(x => (st.now - (x.ts || 0)) <= rangeMs) : related;
      const galItems = inRange.slice(0, 300).map(x => ({
        trigBg: bgOf(x.image || x.imageBk),
        bkBg: bgOf(x.imageBk || x.image),
        thumbBg: bgOf(x.image),
        hasThumb: !!x.image,
        // Trigger clock time — VisionAI appends milliseconds, drop them.
        time: String(x.triggerTime || fmtTs(x.ts) || '').replace(/\.\d+$/, '').slice(-8),
        camera: x.camera,
        // Match score for this capture + the photo on file, side by side.
        hasSim: this.matchPct(x.similarity) != null,
        sim: (this.matchPct(x.similarity) == null ? '' : this.matchPct(x.similarity) + '%'),
        simCol: this.matchCol(x.similarity),
        hasRef: !!(x.imageMatch || refImg),
        refBg: bgOf(x.imageMatch || refImg),
        isCurrent: String(x.id) === String(ev.id),
        ring: String(x.id) === String(ev.id) ? 'var(--brand)' : 'transparent',
        onOpen: () => this.openLightbox(x.image || x.imageBk, (x.title || 'Detection') + ' · ' + x.camera + ' · ' + (x.triggerTime || '')),
        onOpenScene: () => this.openLightbox(x.imageBk || x.image, 'Scene · ' + x.camera + ' · ' + (x.triggerTime || '')),
      }));
      const galTab = st.evGalTab === 'scenes' ? 'scenes' : 'faces';
      // Paged collection: big, fully visible cards instead of one long scroll.
      const galPS = galTab === 'scenes' ? 8 : 18;
      const galPages = Math.max(1, Math.ceil(galItems.length / galPS));
      const galPage = Math.min(st.evGalPage || 0, galPages - 1);
      const galSlice = galItems.slice(galPage * galPS, galPage * galPS + galPS);
      const gal = {
        show: isFace && related.length > 0,
        items: galSlice,
        count: String(galItems.length),
        showFaces: galTab === 'faces',
        showScenes: galTab === 'scenes',
        tabs: [['faces', 'Detections'], ['scenes', 'Scenes']].map(([k, label]) => ({
          label, cls: galTab === k ? 'chip on' : 'chip', onClick: () => this.setState({ evGalTab: k, evGalPage: 0 }),
        })),
        rangeSel: {value: galRange,
          onChange: (e2) => this.setState({evGalRange: (e2 && e2.target) ? e2.target.value : 'all', evGalPage: 0}),
          options: [['all','All time'],['15m','Last 15 min'],['1h','Last hour'],['24h','Last 24h'],['7d','Last 7 days']].map(([v,label])=>({v,label}))},
        pager: {has: galPages > 1, label: 'Page ' + (galPage + 1) + ' / ' + galPages,
          prevOff: galPage === 0, nextOff: galPage >= galPages - 1,
          prev: () => this.setState({evGalPage: Math.max(0, galPage - 1)}),
          next: () => this.setState({evGalPage: Math.min(galPages - 1, galPage + 1)})},
        empty: galItems.length === 0,
        scopeLabel: (fetched && fetched.loading)
          ? ('Loading every capture of person #' + personId + '…')
          : (personId
              ? ((((enrolled && enrolled.name) || person)
                    ? ('All captures of ' + ((enrolled && enrolled.name) || person))
                    : ('All captures of unidentified person #' + personId))
                 + ' · ' + galItems.length + ' in record'
                 + ((fetched && fetched.rows.length) ? '' : ' (recent window)'))
              : ('Recent face captures on ' + ev.camera + ' — no person id on this event')),
      };
      return {
        tag, tagBg:(this.MODS[ev.mod]||{}).tagBg,
        heading:modNames[ev.mod]||'Detection Alert', subtitle:ev.title,
        idStr, sev:ev.sev, sevColor:this.SEV[ev.sev], dots,
        conf:conf==null?'—':conf+'%', confLabel:conf==null?'n/a':(conf>=70?'High':(conf>=40?'Medium':'Low')),
        confCol, confDash:(((conf||0)/100)*157).toFixed(0)+' 157',
        hasImg:!!ev.image, noImg:!ev.image, frameBg:bgOf(ev.image), onExpand:()=>this.openLightbox(ev.image, ev.title),
        // Face events lead with the identity photo instead of the raw crop.
        isFace, gal,
        profileBg: bgOf(profileImg),
        hasProfileImg: !!profileImg,
        profileName: (enrolled && enrolled.name) || person || 'Unidentified person',
        profileKind: enrolled ? 'PROFILE · ' + (enrolled.notes ? enrolled.notes.slice(0, 40) : 'enrolled')
                    : (ev.imageMatch ? 'ENROLLED PROFILE' : 'NO PROFILE ON FILE · LATEST CAPTURE'),
        profileKindCol: (enrolled || ev.imageMatch) ? 'var(--ok)' : 'var(--gold)',
        // Engine match score for the capture that opened this modal, shown
        // against the profile photo it was compared with.
        hasProfileSim: this.matchPct(ev.similarity) != null,
        profileSim: this.matchLabel(ev.similarity),
        profileSimCol: this.matchCol(ev.similarity),
        hasRefThumb: !!refImg,
        refThumbBg: bgOf(refImg),
        onExpandRef: (e2)=>{ if(e2&&e2.stopPropagation)e2.stopPropagation();
          if(refImg) this.openLightbox(refImg, ((enrolled&&enrolled.name)||person||('Person #'+personId))+' · photo on file'); },
        onExpandProfile: ()=>this.openLightbox(profileImg, person || ev.title),
        trigTime:(ev.triggerTime||fmtTs(ev.ts)), camera:ev.camera,
        rows:[
          {k:'Camera', v:ev.camera, plain:true},
          {k:'Device', v:ev.device||'—', plain:true},
          {k:'Zone / Policy', v:ev.zone, plain:true},
          ...(ev.personId ? [{k:'Person ID', v:ev.personId + (person? ' · '+person : ' · stranger'), plain:true}] : []),
          ...(this.matchPct(ev.similarity)!=null
            ? [{k:'Match Score', v:this.matchLabel(ev.similarity), plain:true, col:this.matchCol(ev.similarity)}] : []),
          {k:'Trigger Type', v:ev.triggerType||'—', plain:true},
          {k:'Alert Level', v:alertName[ev.alertLevel]||ev.alertLevel||'—', chip:true, col:this.SEV[ev.sev]},
          {k:'Trigger Time', v:ev.triggerTime||fmtTs(ev.ts), plain:true},
          {k:'Received Time', v:ev.received||'—', plain:true},
          {k:'Confidence', v:conf==null?'—':conf+'%', plain:true, col:confCol},
          {k:'Status', v:sm2.label, chip:true, col:sm2.col},
        ].map(r=>({col:'var(--text)', ...r, plain:!r.chip})),
        onAck:()=>{ if(window.confirm('Acknowledge this incident?\n\n'+ev.title)) this.ack(ev.id); },
        onResolve:()=>{ if(window.confirm('Mark this incident as RESOLVED?\n\n'+ev.title)){ this.resolve(ev.id); this.closeModal(); } },
        onFalse:()=>{ if(window.confirm('Mark as FALSE ALARM?\n\nThis records a closing remark and resolves the detection.\n\n'+ev.title)){
          this.tktPost(ev.id,'log',{kind:'remark', note:'[False alarm] Marked as false alarm from alert view', actor:this.UNAME},'Marked false alarm ✓'); this.resolve(ev.id); } },
        onEscalate:()=>{ if(window.confirm('Escalate this detection into an INCIDENT TICKET?\n\nIt will get a ticket number, SLA tracking and a change log.\n\n'+ev.title)){
          this.makeTicket(ev.id); this.openTicket(ev); } },
        copySummary:()=>{ try{ navigator.clipboard.writeText([ev.title,'ID '+idStr,'Camera '+ev.camera+' · '+(ev.device||''),
          'Severity '+ev.sev,'Trigger '+(ev.triggerTime||''),'Status '+ev.status].join('\n')); this.setState({tktMsg:'Copied ✓'}); }catch(e){} },
        cards, hasProfile:cards.length>0||acc.length>0, acc, hasAcc:acc.length>0, detSummary,
        attrs:Object.entries(dec).map(([k,v])=>({k, v:String(v)})),
        hasAttrs:Object.keys(dec).length>0,
        showRaw:!!st.evShowRaw && Object.keys(dec).length>0,
        rawBtnBg:st.evShowRaw?'var(--brand)':'var(--bg2)', rawBtnCol:st.evShowRaw?'#fff':'var(--text3)',
        toggleRaw:()=>this.setState(s=>({evShowRaw:!s.evShowRaw})),
      };})() : null;

    // Cameras modal — VisionAI fleet with live view
    const liveOn=!!st.liveBase;
    const mFleet=(st.fleet||[]).map(c=>({name:c.name, serial:c.serial, type:c.type||'', online:c.online,
      statusLabel:c.online?'Online':'Offline', statusCol:c.online?'var(--ok)':'var(--text3)',
      rtspMask:maskRtsp(c.rtsp)||'no RTSP', thumb:bgOf(c.image),
      onView:()=>{ this.closeModal(); this.openCamera(c.stream); }}));

    // Video modal — go2rtc embed when a bridge is configured, else latest frame
    const vc=(mt==='video' && modal.data)?modal.data:null;
    const _tokq = st.liveToken ? ('&token='+encodeURIComponent(st.liveToken)) : '';
    const _live = (vc && liveOn && vc.stream);
    // Inline player uses go2rtc's fragmented-MP4 endpoint: token rides in the URL
    // (no cross-site cookie), so <video> plays natively on Chrome/Safari/Firefox.
    const _mp4  = _live ? (st.liveBase+'/api/stream.mp4?src='+encodeURIComponent(vc.stream)+_tokq) : '';
    const _vurl = _live ? (st.liveBase+'/stream.html?src='+encodeURIComponent(vc.stream)+_tokq) : '';
    const mVideo = vc ? { name:vc.name, stream:vc.stream||'', rtsp:vc.rtsp||'', rtspMask:maskRtsp(vc.rtsp)||'no RTSP', online:vc.online,
      hasLive: !!_live, noLive: !_live, frameBg:bgOf(vc.image),
      noFrame: !vc.image, frameLabel: vc.image?'Latest detection frame':'No recent detection frame',
      mp4Url: _mp4, url: _vurl, onOpenTab: ()=>this.openLiveTab(_vurl) } : null;

    // GPU utilization — detection-driven (bar chart; rises when detections occur)
    const gpu=(st.gpu&&st.gpu.length)?st.gpu:new Array(24).fill(38);
    const gpuBars=gpu.map((v,i)=>({h:Math.max(2,v)+'%', op:(0.4+0.6*v/100).toFixed(2), now:i===gpu.length-1}));
    const gpuNow=gpu[gpu.length-1], gpuPeak=Math.max(...gpu), gpuAvg=Math.round(gpu.reduce((a,b)=>a+b,0)/gpu.length);

    // PPE modal — wearing vs not, filterable
    const ppe=st.ppe||{wearing:0,missing:0,total:0,pct:100,list:[]};
    const ppeRowsAll=(ppe.list||[]).map(r=>({person:r.person||'person', device:r.device||r.stream, when:r.time,
      vest:r.vest, vestLabel:r.vest?'Wearing PPE':'No PPE', vestCol:r.vest?'var(--ok)':'var(--crit)',
      thumb:bgOf(r.image), cursor:r.image?'zoom-in':'default',
      onExpand:()=>this.openLightbox(r.image, (r.vest?'PPE OK':'No PPE')+' · '+(r.device||''))}));
    const ppeRows=ppeRowsAll.filter(r=> st.ppeFilter==='both'?true : st.ppeFilter==='ppe'?r.vest : !r.vest);
    const ppeTabs=[['both','Both'],['ppe','Wearing PPE'],['non','No PPE']].map(([k,label])=>{ const a=st.ppeFilter===k;
      return {label, onClick:()=>this.setPpeFilter(k), cls:a?'chip on':'chip'}; });

    // Search — filter incidents + cameras
    const q=(st.search||'').trim().toLowerCase();
    // Global search covers detections (by text, person id, person name, ticket
    // or event id), tracked people, and cameras.
    const qid = q.replace(/^#/,'');
    const searchInc = q? st.events.filter(e=>(
        e.title+' '+e.camera+' '+e.zone+' '+(e.device||'')+' '+(e.person||'')+' '+
        (e.personId||'')+' '+(e.ticket||'')+' '+(e.id||'')+' '+(e.policy||'')+' '+e.sev+' '+e.status
      ).toLowerCase().includes(q)).slice(0,6)
      .map(e=>({label:e.title, sub:e.camera+' · '+this.ago(e.ts), col:this.SEV[e.sev], onClick:()=>this.openModal('event',e)})) : [];
    // People — tracked persons and strangers, by id or (profile) name.
    const _prof=(st.people&&st.people.profiles)||{};
    const searchPpl = q? ((st.people&&st.people.rows)||[]).filter(p=>{
        const pr=_prof[p.personId]||null;
        return (String(p.personId)+' '+((pr&&pr.name)||'')+' '+(p.senseName||'')+' '+(p.cameras||[]).join(' '))
          .toLowerCase().includes(q);
      }).slice(0,5).map(p=>{
        const pr=_prof[p.personId]||null;
        return {label:(pr&&pr.name)||p.senseName||('Person #'+p.personId),
          sub:'#'+p.personId+' · '+p.captures+' captures · '+((p.cameras||[]).join(', ')||'—'),
          col: pr?'var(--ok)':'var(--gold)',
          onClick:()=>{ this.setSearch(''); this.setPage('face');
            this.asOpenCaptures({personId:p.personId, photo:(pr&&pr.photo)||p.image,
              name:(pr&&pr.name)||'', registered:!!pr, cameras:p.cameras||[], lastSeen:p.lastSeen, score:0}); }};
      }) : [];
    // Enrolled profiles match too, even when their captures have aged out or
    // been purged — the person is still on file.
    const _seenP={}; searchPpl.forEach(x=>{ const m=/^#(\d+)/.exec(x.sub); if(m) _seenP[m[1]]=1; });
    const searchProf = q? Object.keys(_prof).filter(pid=>{
        const pr=_prof[pid];
        return !_seenP[pid] && (pid+' '+(pr.name||'')+' '+(pr.about||pr.notes||'')).toLowerCase().includes(q);
      }).slice(0,4).map(pid=>{ const pr=_prof[pid];
        return {label:pr.name||('Person #'+pid), col:'var(--ok)',
          sub:'#'+pid+' · enrolled profile'+(pr.since?' · since '+String(pr.since).slice(0,10):''),
          onClick:()=>{ this.setSearch(''); this.setPage('face');
            this.openProfile({personId:pid, image:pr.photo}); }};
      }) : [];
    // A person id outside the live window, resolved from the server.
    const _pid=st.searchPid;
    const searchPidRow = (_pid && _pid.id===qid && _pid.count>0
        && !searchPpl.some(x=>x.sub.startsWith('#'+_pid.id+' ')))
      ? [{label:'Person #'+_pid.id, col:'var(--brand)',
          sub:_pid.count+' captures on record · '+((_pid.cameras||[]).join(', ')||'—')
              +(_pid.lastSeen?' · last '+String(_pid.lastSeen).slice(5,16):''),
          onClick:()=>{ this.setSearch(''); this.setPage('face');
            this.asOpenCaptures({personId:_pid.id, photo:_pid.image, name:'', registered:false,
              cameras:_pid.cameras||[], lastSeen:_pid.lastSeen, score:0}); }}]
      : [];
    const searchCam = q? (st.fleet||[]).filter(c=>(c.name+' '+c.serial+' '+(c.stream||'')).toLowerCase().includes(q)).slice(0,6)
      .map(c=>({label:c.name, sub:(c.online?'Online':'Offline')+' · '+c.serial, col:c.online?'var(--ok)':'var(--text3)', onClick:()=>{ this.setSearch(''); this.openCamera(c.stream); }})) : [];
    const searchPeople = [...searchPidRow, ...searchPpl, ...searchProf];
    const searchHas = q.length>0;
    const searchEmpty = searchHas && searchInc.length===0 && searchCam.length===0 && searchPeople.length===0;

    // ===== NOTIFICATIONS (bell — live detections + email channel) =====
    const notifCount=st.events.filter(e=>e.status==='open' && !st.notifSeen[e.id]).length;
    const notifItems=st.events.slice(0,10).map(e=>{ const m=this.MODS[e.mod]||{};
      const unread=e.status==='open' && !st.notifSeen[e.id];
      return {tag:m.tag||'EVT', tagBg:m.tagBg||'var(--low)', title:e.title, sub:e.camera+' · '+this.ago(e.ts),
        dotCol:this.SEV[e.sev]||'var(--low)', weight:unread?'700':'500',
        bg:unread?'rgba(56,38,242,.10)':'transparent', onClick:()=>this.openFromNotif(e)}; });
    const mailLine=mailOn?('Email alerts on → '+mailTo):'Email alerts off — configure MAIL_* in .env';
    const mailDot=mailOn?'var(--ok)':'var(--crit)';

    // ===== FACE & BODY REPORT + FIND PEOPLE =====
    const fbTotal=st.faceR?st.faceR.total:0;
    const findDefs=[
      ['gender','Gender',[['','Any'],['Male','Male'],['Female','Female']]],
      ['age','Age',[['','Any'],['Adult','Adult'],['Old','Elderly'],['Child','Child']]],
      ['tops_color','Tops colour',[['','Any'],['Black','Black'],['White','White'],['Gray','Gray'],['Red','Red'],['Yellow','Yellow'],['Blue','Blue'],['Green','Green'],['Orange','Orange'],['Pink','Pink']]],
      ['mask','Mask',[['','Any'],['WithMask','With mask'],['NoMask','No mask']]],
      ['vest','Vest',[['','Any'],['ReflectiveVest','Wearing vest'],['NoReflectiveVest','No vest']]],
      ['hours','Lookback',[['24','24 h'],['72','3 days'],['168','7 days'],['720','30 days']]],
    ];
    const findGroups=findDefs.map(([k,label,opts])=>({label, opts:opts.map(([val,lab])=>{
      const active = k==='hours' ? String(st.find.hours)===val : String(st.find[k]||'')===val;
      return {label:lab, cls:active?'chip on':'chip', onClick:()=>this.setFind(k, k==='hours'?parseInt(val,10):val),
        bg:active?'var(--brand)':'var(--bg3)', color:active?'#fff':'var(--text2)', border:active?'var(--brand)':'var(--line)'};
    })}));
    const frs=st.find.results||[];
    const findResults=frs.map(r=>({person:r.person||'person', camera:r.camera||'', time:String(r.time||'').replace(/\.\d+$/,''),
      attrs:Object.values(r.attrs||{}).slice(0,4).join(' · ')||'—',
      thumb:r.image?`url('${r.image}') center/cover no-repeat`:grad, cursor:r.image?'zoom-in':'default',
      onExpand:()=>{ if(r.image) this.openLightbox(r.image, (r.person||'person')+' · '+(r.camera||'')+' · '+(r.time||'')); }}));
    // ── People roster: one row per tracked person, enrolled or not ──
    const pplState=st.people||{rows:[],profiles:{}};
    const pplProfiles=pplState.profiles||{};
    const shortTime=(t)=>String(t||'').replace('T',' ').slice(5,16);
    const pplTab=st.pplTab==='registered'?'registered':'unknown';
    const allPeople=(pplState.rows||[]).map(p=>{
      const pr=pplProfiles[p.personId]||null;
      // Registered = VisionAI recognised the face (person-group match) or an
      // operator enrolled it here; everyone else is an unidentified passer-by.
      const inSense=!!p.inSense, isReg=inSense||!!pr;
      const refPhoto=(pr&&pr.photo)||p.senseMatch||'';
      return {
        personId:p.personId, isReg, sortKey:p.lastSeen||'',
        thumb:bgOf(refPhoto||p.image),
        // Best face-match score the engine recorded for this person, next to a
        // thumbnail of the photo on file it was matched against.
        hasSim:this.matchPct(p.similarity)!=null, sim:this.matchLabel(p.similarity), simCol:this.matchCol(p.similarity),
        hasRef:!!refPhoto, refBg:bgOf(refPhoto),
        onRef:(e)=>{ if(e&&e.stopPropagation)e.stopPropagation();
          if(refPhoto) this.openLightbox(refPhoto, ((pr&&pr.name)||('Person #'+p.personId))+' · photo on file'); },
        name: (pr && pr.name) || p.senseName || 'Unidentified',
        idLabel:'#'+p.personId,
        known:!!pr, unknown:!pr,
        badge: inSense ? (pr?'REGISTERED · PROFILED':'REGISTERED · SENSESTUDIO') : (pr ? 'PROFILED' : 'NO PROFILE'),
        badgeCol: isReg ? 'var(--ok)' : 'var(--text3)',
        notes: pr ? (pr.notes||'') : '',
        captures:String(p.captures),
        cameras:(p.cameras||[]).join(' · ')||'—',
        lastSeen:shortTime(p.lastSeen),
        firstSeen:shortTime(p.firstSeen),
        btnLabel: pr ? 'Edit profile' : '+ Create profile',
        btnCls: pr ? 'chip' : 'chip on',
        onSave:(e)=>{ if(e&&e.stopPropagation)e.stopPropagation(); this.openProfile({personId:p.personId, image:p.image}); },
        onRemove:(e)=>{ if(e&&e.stopPropagation)e.stopPropagation(); this.removeProfile({personId:p.personId, name:pr?pr.name:''}); },
        onOpen:()=>{ if(p.image) this.openLightbox(p.image, (pr?pr.name:'Person #'+p.personId)+' · last seen '+shortTime(p.lastSeen)); },
      };
    });
    const regCount=allPeople.filter(p=>p.isReg).length;
    const peopleRows=allPeople.filter(p=>pplTab==='registered'?p.isReg:!p.isReg);
    const peopleTabs=[['unknown','Unidentified',allPeople.length-regCount],['registered','Registered',regCount]]
      .map(([k,label,n])=>({label:label+' ('+n+')', cls:pplTab===k?'chip on':'chip',
        onClick:()=>this.setState({pplTab:k})}));
    const peopleMsg=pplState.loading?'Loading…':(pplState.msg||'');
    const peopleSummary=allPeople.length
      ? (allPeople.length+' unique '+(allPeople.length===1?'person':'people')+' · '
         +regCount+' registered · last 7 days')
      : (pplState.loading?'':'No tracked people yet — face detections create them automatically');
    const peopleEmpty=!pplState.loading && peopleRows.length===0 && allPeople.length>0
      ? (pplTab==='registered'
          ? 'No registered faces yet — create a profile, or enrol the person in a VisionAI person group.'
          : 'Every tracked person here is registered.')
      : '';

    const findStatus=st.find.busy?'Searching…':(st.find.ran?(frs.length+' record'+(frs.length===1?'':'s')+' found — click a card to expand the frame'):'');

    // ===== ATTENDANCE & MOVEMENT (POC Use Case 1 · /api/attendance) =====
    const att=st.att;
    const attQ=(st.attQ||'').trim().toLowerCase();
    const fmtT=(t)=>String(t||'').slice(5,16);
    const inactMin=(att&&att.inactivity_min)||45;
    const agoLabel=(m)=>m<60?(m+' min ago'):(Math.floor(m/60)+' h '+(m%60)+' m ago');
    const attKnownAll=(att&&att.known)||[];
    const attUnknownAll=(att&&att.unknown)||[];
    const attKnown=attKnownAll.filter(r=>!attQ
      || String(r.staffId||'').toLowerCase().indexOf(attQ)>=0
      || String(r.name||'').toLowerCase().indexOf(attQ)>=0
      || String(r.personId||'').indexOf(attQ)>=0);
    // Captured attributes: kiosk estimates (gender, ~age, expression) or the
    // SenseStudio-decoded ones (gender, age band, mask).
    const attrTxt=(a)=>{ if(!a) return ''; const age=a.age==null?'':(typeof a.age==='number'?('~'+a.age+' yrs'):String(a.age));
      return [a.gender, age, a.expression, a.mask].filter(Boolean).join(' · '); };
    const attRows=attKnown.map(r=>({
      photoBg: r.photo?`url('${r.photo}') center/cover no-repeat`:(r.lastImage?`url('${r.lastImage}') center/cover no-repeat`:grad),
      name:r.name||'—',
      staff:r.staffId?('Staff ID '+r.staffId):('#'+r.personId),
      attrs:attrTxt(r.lastAttrs),
      entrySrc:r.firstSource==='kiosk'?'via check-in kiosk':'via CCTV camera',
      entry:fmtT(r.firstSeen), entryLoc:r.firstLoc||'—',
      latest:fmtT(r.lastSeen), latestLoc:r.lastLoc||'—',
      route:(r.route||[]).slice(-6).join('  →  ')||'—',
      captures:String(r.captures||0),
      // The last detection is only the latest KNOWN location — never an
      // automatic exit event (the person may leave by vehicle unseen).
      statusLabel: r.onSite?'● ON-SITE':('LAST KNOWN · '+agoLabel(r.minsAgo||0)),
      statusCol: r.onSite?'var(--ok)':'var(--text3)',
      onJourney:()=>this.openJourney(r),
      onExpand:()=>{ if(r.lastImage) this.openLightbox(r.lastImage,(r.name||r.personId)+' · '+(r.lastLoc||'')+' · '+fmtT(r.lastSeen)); },
    }));
    const attUnknown=attUnknownAll.slice(0,24).map(r=>({
      thumb:r.lastImage?`url('${r.lastImage}') center/cover no-repeat`:grad,
      id:'#'+r.personId,
      meta:(r.captures||0)+'× · '+(r.lastLoc||'—')+' · '+fmtT(r.lastSeen)+(attrTxt(r.lastAttrs)?' · '+attrTxt(r.lastAttrs):''),
      onEnrol:(e)=>{ if(e&&e.stopPropagation)e.stopPropagation(); this.openProfile({personId:r.personId, image:r.lastImage||''}); },
      onJourney:()=>this.openJourney({personId:r.personId, lastImage:r.lastImage}),
      onOpen:()=>{ if(r.lastImage) this.openLightbox(r.lastImage,'Unknown personnel #'+r.personId+' · '+(r.lastLoc||'')+' · '+fmtT(r.lastSeen)); },
    }));
    const attOnSite=attKnownAll.filter(r=>r.onSite).length;
    const attKpis=[
      {label:'ON-SITE NOW', value:String(attOnSite), tone:'var(--ok)', sub:'within '+inactMin+' min inactivity interval'},
      {label:'EMPLOYEES DETECTED', value:String(attKnownAll.length), tone:'var(--low)', sub:'enrolled faces seen in window'},
      {label:'UNKNOWN PERSONNEL', value:String(attUnknownAll.length), tone:'var(--high)', sub:'detected but not enrolled'},
      {label:'ENROLLED PROFILES', value:String((att&&att.enrolled)||0), tone:'var(--text)', sub:'POC sample target: 10'},
    ];
    const attDaysTabs=chipRow([[1,'Last 24 h'],[7,'7 days'],[30,'30 days']], st.attDays, v=>this.setAttDays(v));
    const attStatus= st.attBusy?'Loading records…':(st.attErr||'');
    const attMappedLine= att
      ? ((att.mapped_cams||0)+' camera'+(att.mapped_cams===1?'':'s')+' mapped to POC points · movement is captured only at mapped camera points — not continuous GPS-style tracking')
      : '';
    const attNeedsMap= !!att && (att.mapped_cams||0)===0 && (att.kiosk_checkins||0)===0;
    const attEmpty= !!att && !st.attBusy && attRows.length===0;

    // Journey modal (chronological camera-point detections + dwell)
    const jnS=st.jn;
    const jnV= jnS? (()=>{ const visits=((jnS.data&&jnS.data.visits)||[]);
      return {
        title: jnS.name||('Person #'+jnS.personId),
        sub: (jnS.staffId?('Staff ID '+jnS.staffId+' · '):'')+'tracked #'+jnS.personId+' · '+(st.attDays||1)+'-day window',
        photoBg: jnS.photo?`url('${jnS.photo}') center/cover no-repeat`:grad,
        loading: !!jnS.loading,
        status: jnS.loading?'Loading journey…':(jnS.failed?'Could not load the journey':''),
        visits: visits.map((v,i)=>({
          n:String(i+1), location:v.location||'—',
          span: fmtT(v.arrive)+(v.depart&&v.depart!==v.arrive?('  →  '+fmtT(v.depart)):''),
          dwell: v.dwellMin>=1?('Dwell '+v.dwellMin+' min'):'Passing detection',
          dwellCol: v.dwellMin>=10?'var(--gold)':'var(--text3)',
          caps:(v.captures||1)+' capture'+(v.captures===1?'':'s'),
          thumb: v.image?`url('${v.image}') center/cover no-repeat`:grad,
          onOpen:()=>{ if(v.image) this.openLightbox(v.image,(v.location||'')+' · '+fmtT(v.arrive)); },
          isLast:i===visits.length-1,
        })),
        hasVisits: visits.length>0,
        empty: !jnS.loading && visits.length===0,
        summary: visits.length
          ? (visits.length+' camera-point visit'+(visits.length===1?'':'s')+' · '+(((jnS.data&&jnS.data.steps)||[]).length)+' detections · latest known location: '+(visits[visits.length-1].location||'—'))
          : '',
      }; })() : {visits:[]};

    // ===== OFFICIAL ATTENDANCE — register · employees · reports =====
    const reg=st.reg, regD=reg.data||{};
    const hm=(t)=>t?String(t).slice(11,16):'—';
    const attViews=[['register','Daily register'],['live','Live sightings'],['reports','Reports']]
      .map(([k,label])=>({label, cls:st.attView===k?'chip on':'chip', onClick:()=>this.setAttView(k)}));
    const optList=(list,blank)=>[{v:'',label:blank}, ...(list||[]).map(x=>({v:x,label:x}))];
    const regPlantSel={value:reg.plant, options:optList(regD.plants,'All plants'),
      onChange:(e)=>this.setReg({plant:(e&&e.target)?e.target.value:''})};
    const regDeptSel={value:reg.dept, options:optList(regD.departments,'All departments'),
      onChange:(e)=>this.setReg({dept:(e&&e.target)?e.target.value:''})};
    const regStatusSel={value:reg.status, onChange:(e)=>this.setReg({status:(e&&e.target)?e.target.value:''}),
      options:[['','All statuses'],['present','Present (incl. late)'],['late','Late'],['absent','Absent'],['pending','Not yet in'],['missing_out','Missing clock-out'],['off','Off day']]
        .map(([v,label])=>({v,label}))};
    const STATUS={present:['PRESENT','var(--ok)'], late:['LATE','var(--gold)'], absent:['ABSENT','var(--crit)'],
      pending:['NOT YET IN','var(--text3)'], off:['OFF DAY','var(--text3)']};
    const FLAG={missing_out:'Missing clock-out', early_out:'Early clock-out', off_day:'Worked on off day'};
    const rk=regD.kpi||{};
    const regKpis=[
      ['','SCHEDULED','total','var(--text)','active employees on shift today'],
      ['present','PRESENT','present','var(--ok)','clocked in (on time or late)'],
      ['late','LATE','late','var(--gold)','clock-in after start + grace'],
      ['absent','ABSENT','absent','var(--crit)','no clock-in by absent threshold'],
      ['pending','NOT YET IN','pending','var(--text3)','shift not started / within threshold'],
      ['missing_out','MISSING CLOCK-OUT','missingOut','var(--high)','clocked in, no clock-out'],
    ].map(([f,label,key,tone,sub])=>({label, value:String(rk[key]||0), tone, sub,
      cls:'att-kpi att-kpi-btn'+(reg.status===f&&f?' on':''), onClick:()=>this.setReg({status:reg.status===f?'':f})}));
    const regRows=(regD.rows||[]).map(r=>{ const s=STATUS[r.status]||[r.status,'var(--text3)'];
      return {
        photoBg:r.photo?`url('${r.photo}') center/cover no-repeat`:grad,
        name:r.name||'—', staff:r.staffId?('Staff ID '+r.staffId):'',
        org:[r.department,r.plant].filter(Boolean).join(' · ')||'—',
        shift:r.shift+' '+r.shiftStart+'–'+r.shiftEnd,
        clockIn:hm(r.clockIn), inLoc:r.clockIn?((r.clockInLoc||'')+(r.clockInSrc==='kiosk'?' · kiosk':'')):'',
        clockOut:hm(r.clockOut), outLoc:r.clockOutLoc||'',
        hours:r.hours!=null?(r.hours+' h'):'—',
        status:s[0]+(r.status==='late'?(' · '+r.lateMin+' MIN'):''), statusCol:s[1],
        flags:(r.flags||[]).map(x=>FLAG[x]||x).join(' · '),
        route:(r.plants||[]).join(' → '),
        onJourney:()=>this.openJourney({personId:r.personId, name:r.name, staffId:r.staffId, photo:r.photo}),
      }; });
    const regRecent=(regD.recent||[]).slice(0,14).map(e=>({
      time:hm(e.time), who:e.known?(e.name+(e.staffId?(' · '+e.staffId):'')):('Unknown #'+e.personId),
      whoCol:e.known?'var(--text)':'var(--high)',
      where:[e.plant,e.location].filter(Boolean).join(' · ')+' · '+(e.source==='kiosk'?'kiosk':'CCTV'),
      conf:e.similarity?(String(e.similarity).indexOf('.')>=0&&Number(e.similarity)<=1?Math.round(Number(e.similarity)*100)+'%':e.similarity):'',
      tag:e.role==='movement'?'movement':'clock point',
      thumb:e.image?`url('${e.image}') center/cover no-repeat`:grad,
      onOpen:()=>{ if(e.image) this.openLightbox(e.image,(e.name||('#'+e.personId))+' · '+e.location+' · '+hm(e.time)); },
    }));
    const regStatusLine=reg.busy?'Loading register…':(reg.err||'');
    const regNoRoles=!!regD.date && !regD.rolesSet;
    const regEmpty=!!regD.date && !reg.busy && regRows.length===0;
    const regSummary=regD.date?((regD.enrolled||0)+' employee profiles · '+((regD.kpi&&regD.kpi.unknown)||0)+' unknown faces seen today'):'';

    // Employees directory (person_profiles = employee records)
    const profs=Object.values((st.people&&st.people.profiles)||{});
    const eq=(st.empQ||'').trim().toLowerCase();
    const SYNC={synced:['SYNCED','var(--ok)'], partial:['PARTIAL','var(--gold)'], failed:['FAILED','var(--crit)'], inactive:['DEACTIVATED','var(--text3)']};
    const shiftName=(id)=>{ const s=(regD.shifts||[]).find(x=>x.id===id)||(regD.shifts||[])[0]; return s?(s.name+' '+s.start+'–'+s.end):'Default'; };
    const empRows=profs
      .filter(p=>(!reg.plant||p.plant===reg.plant) && (!reg.dept||p.department===reg.dept)
        && (!eq || (p.name+' '+(p.staffId||'')).toLowerCase().indexOf(eq)>=0))
      .sort((a,b)=>String(a.name).localeCompare(String(b.name)))
      .map(p=>{ const s=SYNC[p.ssSync]||['NOT SYNCED','var(--text3)'];
        return {
          photoBg:p.photo?`url('${p.photo}') center/cover no-repeat`:grad,
          name:p.name, staff:p.staffId||'— no staff ID',
          dept:p.department||'—', plant:p.plant||'—', shift:shiftName(p.shift),
          active:p.active!==false?'Active':'Inactive', activeCol:p.active!==false?'var(--ok)':'var(--text3)',
          sync:s[0], syncCol:s[1], syncTip:p.ssError||(p.ssUid?('SenseStudio uid '+p.ssUid+(p.ssSynced?(' · '+p.ssSynced):'')):'Not in the SenseStudio library yet'),
          onEdit:()=>this.openProfile({personId:p.personId, image:p.photo}),
          onSync:()=>this.syncEmployee(p.personId),
          onJourney:()=>this.openJourney({personId:p.personId, name:p.name, staffId:p.staffId, photo:p.photo}),
        }; });
    const empCount=profs.length+' employee'+(profs.length===1?'':'s')+' · '+profs.filter(p=>p.ssSync==='synced').length+' synced to SenseStudio';

    // Reports
    const rp=st.rep, today=this.todayStr();
    const repPersonSel={value:rp.person, onChange:(e)=>this.setState(s=>({rep:{...s.rep, person:(e&&e.target)?e.target.value:''}})),
      options:[{v:'',label:'All employees'}, ...profs.slice().sort((a,b)=>String(a.name).localeCompare(String(b.name)))
        .map(p=>({v:p.personId, label:p.name+(p.staffId?(' · '+p.staffId):'')}))]};
    const repCards=[
      {title:'Daily attendance', desc:'One row per employee for the register date: shift, clock-in / clock-out with location, hours, status, late minutes, exceptions and plants visited.',
        scope:'Date '+(reg.date||today)+' · register filters', onClick:()=>this.exportAtt('daily')},
      {title:'Attendance by date range', desc:'The daily register for every day in the range (max 62 days) — use for monthly attendance, late arrivals and absentee summaries.',
        scope:(rp.from||reg.date||today)+' → '+(rp.to||rp.from||reg.date||today), onClick:()=>this.exportAtt('range')},
      {title:'Employee movement', desc:'Every detection grouped into visits: plant, location, camera, source, arrive / depart, dwell and whether the camera counts for attendance.',
        scope:(rp.person?'One employee':'All employees')+' · '+(rp.from||reg.date||today)+' → '+(rp.to||rp.from||reg.date||today), onClick:()=>this.exportAtt('movement')},
    ];

    // ===== POC SETTINGS — camera points + PPE requirement matrix =====
    const spLocOpts=((ap&&ap.poc_locations&&ap.poc_locations.length)?ap.poc_locations
      :['Plant 1 Guard Post','Plant 2 Guard Post','Lobby Entrance','8 Color Entrance','Conventional Entrance','Line 5','Waste Area — Spot 9']);
    const spCamLocCur={...((ap&&ap.cam_locations)||{}), ...((ad.cam_locations)||{})};
    const pocStreams=(()=>{ const seen={}; const out=[];
      (st.fleet||[]).forEach(f=>{ const k=String(f.stream||'').toLowerCase(); if(k&&!seen[k]){ seen[k]=1; out.push({key:k, name:f.name||k}); }});
      (st.events||[]).forEach(e=>{ const k=String(e.camera||'').toLowerCase(); if(k&&!seen[k]){ seen[k]=1; out.push({key:k, name:e.device||e.camera}); }});
      Object.keys(spCamLocCur).forEach(k=>{ if(k&&!seen[k]){ seen[k]=1; out.push({key:k, name:k}); }});
      return out; })();
    const saveCamLoc=(key,val)=>{ const next={...spCamLocCur, [key]:val};
      this.setDraft('cam_locations', next); this.saveApp({cam_locations:next}, val?'Camera point saved ✓':'Mapping cleared ✓'); };
    const pocRows=pocStreams.map(c=>{ const cur=spCamLocCur[c.key]||'';
      return {name:c.name, key:String(c.key).toUpperCase(),
        cur:cur||'Not mapped', curCol:cur?'var(--ok)':'var(--text3)',
        chips:[...spLocOpts.map(L=>({label:L, cls:cur===L?'chip on':'chip', onClick:()=>saveCamLoc(c.key,L)})),
               {label:'✕ none', cls:'chip', onClick:()=>saveCamLoc(c.key,'')}]};
    });
    const spInact=chipRow([[15,'15 min'],[30,'30 min'],[45,'45 min'],[60,'60 min'],[120,'2 hours']],
      (ad.poc_inactivity_min!=null?ad.poc_inactivity_min:((ap&&ap.poc_inactivity_min)||45)),
      v=>{ this.setDraft('poc_inactivity_min',v); this.saveApp({poc_inactivity_min:v}, 'Inactivity interval saved ✓'); });

    // ===== SETTINGS → ATTENDANCE RULES =====
    const attLists=st.attListDraft||{};
    const attPlantsCur=(ap&&ap.att_plants)||[], attDeptsCur=(ap&&ap.att_departments)||[];
    const attPlantsVal=attLists.plants!=null?attLists.plants:attPlantsCur.join(', ');
    const attDeptsVal=attLists.depts!=null?attLists.depts:attDeptsCur.join(', ');
    const splitList=(s)=>String(s||'').split(',').map(x=>x.trim()).filter(Boolean);
    const saveAttLists=()=>{ this.saveApp({att_plants:splitList(attPlantsVal), att_departments:splitList(attDeptsVal)}, 'Plants & departments saved ✓');
      this.setState({attListDraft:{}}); };
    // Shifts editor
    const shiftsCur=st.attShiftDraft||((ap&&ap.att_shifts)||[]);
    const DAYS=[[1,'Mon'],[2,'Tue'],[3,'Wed'],[4,'Thu'],[5,'Fri'],[6,'Sat'],[7,'Sun']];
    const setShift=(i,patch)=>this.setState(s=>{ const base=(s.attShiftDraft||((s.appCfg&&s.appCfg.att_shifts)||[])).map(x=>({...x}));
      base[i]={...base[i], ...patch}; return {attShiftDraft:base}; });
    const attShiftRows=shiftsCur.map((s,i)=>({
      name:s.name, start:s.start, end:s.end, grace:String(s.grace), absent:String(s.absent_after),
      onName:(e)=>setShift(i,{name:(e&&e.target)?e.target.value:''}),
      onStart:(e)=>setShift(i,{start:(e&&e.target)?e.target.value:''}),
      onEnd:(e)=>setShift(i,{end:(e&&e.target)?e.target.value:''}),
      onGrace:(e)=>setShift(i,{grace:parseInt((e&&e.target)?e.target.value:'0',10)||0}),
      onAbsent:(e)=>setShift(i,{absent_after:parseInt((e&&e.target)?e.target.value:'0',10)||0}),
      days:DAYS.map(([d,label])=>{ const on=(s.days||[]).indexOf(d)>=0;
        return {label, cls:on?'chip on':'chip', onClick:()=>setShift(i,{days:on?(s.days||[]).filter(x=>x!==d):[...(s.days||[]),d].sort()})}; }),
      canRemove:shiftsCur.length>1,
      onRemove:()=>this.setState(s=>({attShiftDraft:shiftsCur.filter((_,j)=>j!==i)})),
    }));
    const addShift=()=>this.setState({attShiftDraft:[...shiftsCur.map(x=>({...x})),
      {id:'shift'+(shiftsCur.length+1), name:'Night shift', start:'20:00', end:'05:00', grace:10, absent_after:120, days:[1,2,3,4,5]}]});
    const saveShifts=()=>{ const ids={}; const out=shiftsCur.map((s,i)=>{ let id=String(s.id||s.name||('shift'+(i+1))).toLowerCase().replace(/[^a-z0-9_-]+/g,'')||('shift'+(i+1));
        while(ids[id]) id+='x'; ids[id]=1; return {...s, id}; });
      this.saveApp({att_shifts:out}, 'Shift rules saved ✓'); this.setState({attShiftDraft:null}); };
    // Camera roles: which detections count as clock-in / clock-out
    const rolesCur=(ap&&ap.att_cam_roles)||{};
    const ROLES=[['clock_in','Clock-in'],['clock_out','Clock-out'],['both','Clock-in + out'],['movement','Movement only']];
    const attCamRows=pocStreams.map(c=>{ const cur=rolesCur[c.key]||'';
      const setRole=(v)=>{ const next={...rolesCur}; if(v) next[c.key]=v; else delete next[c.key];
        this.saveApp({att_cam_roles:next}, 'Camera role saved ✓'); };
      return {name:c.name, key:String(c.key).toUpperCase(), loc:spCamLocCur[c.key]||'not mapped to a camera point',
        cur:cur?(ROLES.find(r=>r[0]===cur)||[0,cur])[1]:'No role', curCol:cur&&cur!=='movement'?'var(--ok)':'var(--text3)',
        chips:ROLES.map(([v,label])=>({label, cls:cur===v?'chip on':'chip', onClick:()=>setRole(cur===v?'':v)}))}; });
    const attRolesSet=Object.values(rolesCur).some(v=>v!=='movement');
    // Location → plant
    const locPlantsCur=(ap&&ap.att_loc_plants)||{};
    const locNames=[...new Set([...spLocOpts, ...Object.values(spCamLocCur)])];
    const guessPlant=(L)=>{ const m=/\bplant\s*([a-z0-9]+)/i.exec(L); return m?('Plant '+m[1].toUpperCase()):''; };
    const attLocRows=locNames.map(L=>{ const cur=locPlantsCur[L]||'';
      return {name:L, cur:cur||(guessPlant(L)?('auto: '+guessPlant(L)):'No plant'), curCol:cur?'var(--ok)':'var(--text3)',
        chips:attPlantsCur.map(P=>({label:P, cls:cur===P?'chip on':'chip',
          onClick:()=>{ const next={...locPlantsCur}; if(cur===P) delete next[L]; else next[L]=P;
            this.saveApp({att_loc_plants:next}, 'Location plant saved ✓'); }}))}; });
    const attKioskChips=chipRow([[1,'Kiosk check-ins count as clock-in / out'],[0,'Kiosk = movement only']],
      (ap&&ap.att_kiosk_clock===false)?0:1, v=>this.saveApp({att_kiosk_clock:!!v}, 'Kiosk rule saved ✓'));

    // ===== CLEANING ACTIVITY MONITORING (/api/cleaning/summary) =====
    const cd=st.clD||{}, cf=st.clF, ck=cd.kpi||{};
    const CL_ITEMS=cd.items||{helmet:'Safety helmet', vest:'Safety vest', goggles:'Safety goggles', gloves:'Safety gloves'};
    const clItem=(i)=>CL_ITEMS[i]||i;
    const clSel=(key,list,blank)=>({value:cf[key]||'', options:[{v:'',label:blank}, ...list],
      onChange:(e)=>this.setClF({[key]:(e&&e.target)?e.target.value:''})});
    const clPlantSel=clSel('plant', (cd.plants||[]).map(x=>({v:x,label:x})), 'All plants');
    const clLocSel=clSel('location', [...new Set((cd.schedules||[]).map(s=>s.location))].map(x=>({v:x,label:x})), 'All cleaning areas');
    const clItemSel=clSel('item', Object.keys(CL_ITEMS).map(k=>({v:k,label:CL_ITEMS[k]})), 'All violation types');
    const clKpis=[
      ['SCHEDULED SESSIONS', ck.sessions||0, 'var(--text)', 'cleaning windows in range'],
      ['IN PROGRESS NOW', ck.inProgress||0, ck.inProgress?'var(--gold)':'var(--text3)', 'scheduled window running'],
      ['PEOPLE CHECKED', ck.checks||0, 'var(--text)', 'PPE checks during cleaning windows'],
      ['PPE VIOLATIONS', ck.violations||0, ck.violations?'var(--crit)':'var(--ok)', 'missing required PPE while cleaning'],
      ['COMPLIANCE', ck.compliance==null?'—':(ck.compliance+'%'), ck.compliance==null?'var(--text3)':(ck.compliance>=95?'var(--ok)':(ck.compliance>=80?'var(--gold)':'var(--crit)')), 'checks with all required PPE'],
      ['NO ACTIVITY SEEN', ck.noActivity||0, ck.noActivity?'var(--high)':'var(--ok)', 'ended sessions with nobody detected'],
    ].map(([label,value,tone,sub])=>({label, value:String(value), tone, sub}));
    const CL_STATE={upcoming:['UPCOMING','var(--text3)'], in_progress:['IN PROGRESS','var(--gold)'], ended:['ENDED','var(--text2)']};
    const clSessions=(cd.sessions||[]).map(s=>{ const stt=CL_STATE[s.state]||[s.state,'var(--text3)'];
      const comp=s.checks?Math.round(100*(s.checks-s.violations)/s.checks):null;
      return {
        name:s.name, when:s.date+' · '+String(s.start).slice(11,16)+'–'+String(s.end).slice(11,16),
        where:[s.plant, s.location].filter(Boolean).join(' · '), req:'Requires '+s.items.map(clItem).join(', '),
        state:stt[0], stateCol:stt[1],
        observed:s.cameras?(s.detections+' detection'+(s.detections===1?'':'s')+' at the area'):'no camera mapped to this area',
        observedCol:!s.cameras?'var(--high)':(s.state==='ended'&&!s.detections?'var(--high)':'var(--text2)'),
        ppe:s.checks?(s.checks+' checked · '+s.violations+' violation'+(s.violations===1?'':'s')+' · '+comp+'%'):'no PPE checks',
        ppeCol:s.violations?'var(--crit)':(s.checks?'var(--ok)':'var(--text3)'),
        conf:s.confirmed==='done'?('✓ Cleaning done · '+(s.confirmedBy||'')):(s.confirmed==='not_done'?('✗ Not performed · '+(s.confirmedBy||'')):'Not confirmed'),
        confCol:s.confirmed==='done'?'var(--ok)':(s.confirmed==='not_done'?'var(--crit)':'var(--text3)'),
        note:s.note||'', canConfirm:s.state!=='upcoming',
        onDone:()=>this.confirmCl(s,'done'), onNotDone:()=>this.confirmCl(s,'not_done'),
      }; });
    const clViol=(cd.violations||[]).map(v=>({
      thumb:v.image?`url('${v.image}') center/cover no-repeat`:grad,
      missing:'No '+v.missing.map(i=>clItem(i).replace('Safety ','').toLowerCase()).join(', '),
      session:v.schedule||'', where:[v.plant, v.location].filter(Boolean).join(' · '), cam:v.camera,
      time:String(v.time).slice(0,16),
      onOpen:()=>{ if(v.image) this.openLightbox(v.image, 'PPE violation during cleaning · '+v.location+' · '+String(v.time).slice(0,16)); },
    }));
    const clByItem=Object.keys(CL_ITEMS).map(k=>{ const b=(cd.byItem||{})[k]||{required:0,missing:0};
      const pct=b.required?Math.round(100*b.missing/b.required):0;
      return {label:CL_ITEMS[k], value:b.required?(b.missing+' missed / '+b.required+' required'):'not required in range',
        w:pct+'%', col:pct>20?'var(--crit)':(pct>5?'var(--gold)':'var(--ok)')}; });
    // Schedule editor rows
    const clLocOpts=(cd.locations||[]);
    const clMapped=cd.mappedLocations||[];
    const clDays=[[1,'Mon'],[2,'Tue'],[3,'Wed'],[4,'Thu'],[5,'Fri'],[6,'Sat'],[7,'Sun']];
    const clEdit=this.clSched().map((s,i)=>({
      name:s.name, start:s.start, end:s.end, dates:s.dates||'',
      onName:(e)=>this.clSet(i,{name:(e&&e.target)?e.target.value:''}),
      onStart:(e)=>this.clSet(i,{start:(e&&e.target)?e.target.value:''}),
      onEnd:(e)=>this.clSet(i,{end:(e&&e.target)?e.target.value:''}),
      onDates:(e)=>this.clSet(i,{dates:(e&&e.target)?e.target.value:''}),
      locSel:{value:s.location||'', onChange:(e)=>this.clSet(i,{location:(e&&e.target)?e.target.value:''}),
        options:[{v:'',label:'— Cleaning area —'}, ...clLocOpts.map(L=>({v:L, label:L+(clMapped.indexOf(L)>=0?'':' (no camera mapped)')}))]},
      days:clDays.map(([d,label])=>{ const on=(s.days||[]).indexOf(d)>=0;
        return {label, cls:on?'chip on':'chip', onClick:()=>this.clSet(i,{days:on?s.days.filter(x=>x!==d):[...(s.days||[]),d].sort()})}; }),
      items:Object.keys(CL_ITEMS).map(k=>{ const on=(s.items||[]).indexOf(k)>=0;
        return {label:CL_ITEMS[k], cls:on?'chip on':'chip', onClick:()=>this.clSet(i,{items:on?s.items.filter(x=>x!==k):[...(s.items||[]),k]})}; }),
      enabled:[[true,'Active'],[false,'Paused']].map(([v,label])=>({label, cls:(s.enabled!==false)===v?'chip on':'chip', onClick:()=>this.clSet(i,{enabled:v})})),
      onRemove:()=>this.clRemove(i),
      warn:s.location&&clMapped.indexOf(s.location)<0?'No camera is mapped to this area (Settings → POC Camera Points), so nobody can be checked during it.':'',
    }));
    // ===== RESTRICTED AREA MONITORING (/api/restricted/summary) =====
    const rd=st.raD||{}, rf=st.raF, rk2=rd.kpi||{};
    const VERD={violation:['UNAUTHORIZED','var(--crit)'], review:['NEEDS REVIEW','var(--gold)'],
      authorized:['AUTHORIZED','var(--ok)'], outside_hours:['OUTSIDE HOURS','var(--text3)']};
    const raSel=(key,list,blank)=>({value:rf[key]||'', options:[{v:'',label:blank}, ...list],
      onChange:(e)=>this.setRaF({[key]:(e&&e.target)?e.target.value:''})});
    const raPlantSel=raSel('plant', (rd.plants||[]).map(x=>({v:x,label:x})), 'All plants');
    const raCamSel=raSel('camera', (rd.zones||[]).map(z=>({v:z.key, label:z.name+' · '+z.key})), 'All zones / cameras');
    const raVerdictSel=raSel('verdict', Object.keys(VERD).map(k=>({v:k, label:(rd.verdicts||{})[k]||k})), 'All verdicts');
    const raStatusSel=raSel('status', [{v:'open',label:'Open'},{v:'ack',label:'Acknowledged'},{v:'resolved',label:'Resolved'}], 'Any alert status');
    const raKpis=[
      ['ENTRIES', rk2.entries||0, 'var(--text)', 'detections in restricted zones'],
      ['UNAUTHORIZED', rk2.violation||0, (rk2.violation?'var(--crit)':'var(--ok)'), 'confirmed violations'],
      ['NEEDS REVIEW', rk2.review||0, (rk2.review?'var(--gold)':'var(--ok)'), 'authorization not verifiable'],
      ['OPEN ALERTS', rk2.open||0, (rk2.open?'var(--high)':'var(--ok)'), 'unauthorized / review not yet handled'],
      ['TODAY', rk2.today||0, (rk2.today?'var(--high)':'var(--ok)'), 'unauthorized + review since midnight'],
      ['AUTHORIZED', (rk2.authorized||0)+(rk2.outside_hours||0), 'var(--text3)', 'cleared by access rules / hours'],
    ].map(([label,value,tone,sub])=>({label, value:String(value), tone, sub}));
    const raMax=Math.max(1, ...(rd.daily||[]).map(d=>d.violation+d.review+d.authorized+d.outside_hours));
    const raDaily=(rd.daily||[]).map(d=>({label:String(d.date).slice(5),
      title:d.date+' · '+d.violation+' unauthorized · '+d.review+' review · '+(d.authorized+d.outside_hours)+' cleared',
      vH:Math.round(100*d.violation/raMax)+'%', rH:Math.round(100*d.review/raMax)+'%', aH:Math.round(100*(d.authorized+d.outside_hours)/raMax)+'%',
      v:(d.violation+d.review)?String(d.violation+d.review):''}));
    const raByZone=(rd.byZone||[]).map(z=>({zone:z.zone, sub:[z.plant, z.camera].filter(Boolean).join(' · '),
      line:z.violation+' unauthorized · '+z.review+' review · '+(z.authorized+z.outside_hours)+' cleared',
      col:z.violation?'var(--crit)':(z.review?'var(--gold)':'var(--ok)'),
      onClick:()=>this.setRaF({camera:rf.camera===z.camera?'':z.camera})}));
    const raInc=(rd.incidents||[]).map(i=>{ const vv=VERD[i.verdict]||[i.verdict,'var(--text3)'];
      const open=(i.status||'open')==='open'||i.status==='ack';
      return {
        thumb:i.image?`url('${i.image}') center/cover no-repeat`:grad,
        verdict:vv[0], vCol:vv[1], zone:i.zone||i.camera,
        where:[i.plant, i.location].filter(Boolean).join(' · '), cam:i.camera+(i.policy?(' · '+i.policy):''),
        time:String(i.time).slice(0,16), who:i.name?(i.name+(i.staffId?(' · '+i.staffId):'')):(i.personId?('Unknown #'+i.personId):'Unidentified person'),
        reason:i.reason, status:'Alert: '+(i.status||'open')+(i.reviewedBy?(' · reviewed by '+i.reviewedBy):'')+(i.note?(' — '+i.note):''),
        canConfirm:open && i.verdict==='review', canClear:open && (i.verdict==='review'||i.verdict==='violation'),
        onConfirm:()=>this.reviewRa(i,'violation'), onClear:()=>this.reviewRa(i,'authorized'),
        onOpen:()=>{ if(i.image) this.openLightbox(i.image, (i.zone||i.camera)+' · '+String(i.time).slice(0,16)); },
      }; });
    const raNoZones=!!rd.from && !(rd.zones||[]).some(z=>z.enabled);
    // Settings → Restricted Zones (one row per camera)
    const raZonesCur=(ap&&ap.ra_zones)||{};
    const raDeptOpts=(ap&&ap.att_departments)||[];
    const raCamPolicies=(key)=>[...new Set((st.policies||[]).filter(p=>String(p.stream).toLowerCase()===key && p.mod==='intr').map(p=>p.policy))];
    const raZoneRows=[...new Set([...pocStreams.map(c=>c.key), ...Object.keys(raZonesCur)])].map(key=>{
      const z={enabled:false, name:'', hours:'always', staff:[], depts:[], ...(raZonesCur[key]||{})};
      const dr=(st.raDraft||{})[key]||{};
      const cam=pocStreams.find(c=>c.key===key);
      const pols=raCamPolicies(key);
      const custom=z.hours!=='always';
      return {
        key:key.toUpperCase(), camName:cam?cam.name:key.toUpperCase(), loc:spCamLocCur[key]||'not mapped to a camera point',
        pols:pols.length?('SenseStudio boundary / zone policies: '+pols.join(', ')):'No intrusion (boundary / zone) policy has fired on this camera yet — draw one in SenseStudio',
        polsCol:pols.length?'var(--text3)':'var(--high)',
        state:z.enabled?'RESTRICTED ZONE':'Not restricted', stateCol:z.enabled?'var(--crit)':'var(--text3)',
        enableChips:[[true,'Restricted'],[false,'Off']].map(([v,label])=>({label, cls:z.enabled===v?'chip on':'chip',
          onClick:()=>this.saveRaZone(key,{enabled:v, name:z.name||((spCamLocCur[key]||key.toUpperCase())+' restricted zone')})})),
        name:dr.name!=null?dr.name:z.name, onName:(e)=>this.raDraftSet(key,'name',(e&&e.target)?e.target.value:''),
        hours:dr.hours!=null?dr.hours:(custom?z.hours:''), onHours:(e)=>this.raDraftSet(key,'hours',(e&&e.target)?e.target.value:''),
        hoursChips:[['always','Restricted 24 h'],['custom','Only during hours ↓']].map(([v,label])=>({label,
          cls:(v==='always')===!custom?'chip on':'chip',
          onClick:()=>v==='always'?this.saveRaZone(key,{hours:'always'}):this.raDraftSet(key,'hours',custom?z.hours:'18:00-07:00')})),
        staff:dr.staff!=null?dr.staff:(z.staff||[]).join(', '), onStaff:(e)=>this.raDraftSet(key,'staff',(e&&e.target)?e.target.value:''),
        deptChips:raDeptOpts.map(d=>{ const on=(z.depts||[]).indexOf(d)>=0;
          return {label:d, cls:on?'chip on':'chip', onClick:()=>this.saveRaZone(key,{depts:on?z.depts.filter(x=>x!==d):[...(z.depts||[]),d]})}; }),
        dirty:Object.keys(dr).length>0,
        onSave:()=>this.saveRaZone(key,{
          name:String(dr.name!=null?dr.name:z.name).trim(),
          hours:dr.hours!=null?(String(dr.hours).trim()||'always'):z.hours,
          staff:String(dr.staff!=null?dr.staff:(z.staff||[]).join(',')).split(',').map(s=>s.trim()).filter(Boolean)}),
      }; });
    // ===== PPE COMPLIANCE BY AREA (/api/ppe/summary) =====
    const pd=st.ppeD||{}, pf=st.ppeF, pk=pd.kpi||{};
    const PPE_ITEMS=pd.items||{helmet:'Safety helmet', vest:'Safety vest', goggles:'Safety goggles', gloves:'Safety gloves'};
    const itemLabel=(i)=>PPE_ITEMS[i]||i;
    const ppeSel=(key,list,blank)=>({value:pf[key]||'', options:[{v:'',label:blank}, ...list],
      onChange:(e)=>this.setPpeF({[key]:(e&&e.target)?e.target.value:''})});
    const ppePlantSel=ppeSel('plant', (pd.plants||[]).map(x=>({v:x,label:x})), 'All plants');
    const ppeLocSel=ppeSel('location', (pd.locations||[]).map(x=>({v:x,label:x})), 'All areas');
    const ppeCamSel=ppeSel('camera', (pd.cameras||[]).map(x=>({v:x,label:x})), 'All cameras');
    const ppeItemSel=ppeSel('item', Object.keys(PPE_ITEMS).map(k=>({v:k,label:PPE_ITEMS[k]})), 'All PPE types');
    const topItem=Object.entries(pd.byItem||{}).sort((a,b)=>b[1].missing-a[1].missing)[0];
    const ppeKpis=[
      ['PEOPLE CHECKED', String(pk.checks||0), 'var(--text)', 'detections at areas with PPE rules'],
      ['VIOLATIONS', String(pk.violations||0), (pk.violations?'var(--crit)':'var(--ok)'), 'missing required PPE in range'],
      ['TODAY', String(pk.today||0), (pk.today?'var(--high)':'var(--ok)'), 'violations since midnight'],
      ['COMPLIANCE', pk.compliance==null?'—':(pk.compliance+'%'), pk.compliance==null?'var(--text3)':(pk.compliance>=95?'var(--ok)':(pk.compliance>=80?'var(--gold)':'var(--crit)')), 'checks with all required PPE'],
      ['MOST MISSED', topItem&&topItem[1].missing?itemLabel(topItem[0]):'—', 'var(--gold)', topItem&&topItem[1].missing?(topItem[1].missing+' times'):'no misses'],
    ].map(([label,value,tone,sub])=>({label,value,tone,sub}));
    const dailyMax=Math.max(1, ...(pd.daily||[]).map(d=>d.checks));
    const ppeDaily=(pd.daily||[]).map(d=>({
      label:String(d.date).slice(5), title:d.date+' · '+d.violations+' violations / '+d.checks+' checks',
      okH:Math.round(100*(d.checks-d.violations)/dailyMax)+'%', badH:Math.round(100*d.violations/dailyMax)+'%',
      v:d.violations?String(d.violations):''}));
    const ppeByItem=Object.keys(PPE_ITEMS).map(k=>{ const b=(pd.byItem||{})[k]||{required:0,missing:0};
      const pct=b.required?Math.round(100*b.missing/b.required):0;
      return {label:PPE_ITEMS[k], value:b.required?(b.missing+' missed / '+b.required+' required'):'not required in range',
        w:pct+'%', col:pct>20?'var(--crit)':(pct>5?'var(--gold)':'var(--ok)')}; });
    const ppeByLoc=(pd.byLocation||[]).map(l=>{ const c=l.checks?Math.round(100*(l.checks-l.violations)/l.checks):100;
      return {loc:l.location, plant:l.plant||'', req:(l.required||[]).map(itemLabel).join(' · '),
        value:c+'% compliant · '+l.violations+' / '+l.checks, w:c+'%', col:c>=95?'var(--ok)':(c>=80?'var(--gold)':'var(--crit)'),
        onClick:()=>this.setPpeF({location:pf.location===l.location?'':l.location})}; });
    const ppeViol=(pd.violations||[]).map(v=>({
      thumb:v.image?`url('${v.image}') center/cover no-repeat`:grad,
      missing:'No '+v.missing.map(i=>itemLabel(i).replace('Safety ','').toLowerCase()).join(', '),
      where:[v.plant, v.location].filter(Boolean).join(' · '), cam:v.camera+(v.device&&v.device.toUpperCase()!==v.camera?(' · '+v.device):''),
      time:String(v.time).slice(0,16).replace('T',' '),
      unchecked:v.unchecked&&v.unchecked.length?('not checked: '+v.unchecked.map(i=>itemLabel(i).replace('Safety ','').toLowerCase()).join(', ')):'',
      onOpen:()=>{ if(v.image) this.openLightbox(v.image, 'PPE violation · '+v.location+' · '+String(v.time).slice(0,16)); },
    }));
    // Rule cards (what each area requires) — live from the server rules.
    const pocPpe=Object.entries(pd.rules||((ap&&ap.ppe_rules)||{})).map(([loc,items])=>{
      const l=(pd.byLocation||[]).find(x=>x.location===loc);
      return {loc, tag:'REQUIRED PPE', note:l?(l.checks+' people checked · '+l.violations+' violations in range'):'No checks in range',
        items:items.map(i=>({label:itemLabel(i)+(i==='goggles'?' (glasses estimate)':''), value:'required', col:'var(--ok)'}))}; });
    const ppeStatus=pf.busy?'Loading…':(pf.err||'');
    // Settings → PPE Area Rules
    const ppeRulesCur=(ap&&ap.ppe_rules)||{};
    const ppeRuleRows=[...new Set([...spLocOpts, ...Object.values(spCamLocCur), ...Object.keys(ppeRulesCur)])].map(L=>{
      const cur=ppeRulesCur[L]||[];
      const cams=Object.keys(spCamLocCur).filter(k=>spCamLocCur[k]===L).map(k=>k.toUpperCase());
      return {name:L, cams:cams.length?cams.join(', '):'no camera mapped', camsCol:cams.length?'var(--text3)':'var(--high)',
        cur:cur.length?(cur.length+' item'+(cur.length===1?'':'s')+' required'):'Not monitored', curCol:cur.length?'var(--ok)':'var(--text3)',
        chips:Object.keys(PPE_ITEMS).map(i=>({label:PPE_ITEMS[i], cls:cur.indexOf(i)>=0?'chip on':'chip', onClick:()=>this.togglePpeRule(L,i)}))}; });

    // ===== GLOBAL PLANT FILTER (topbar select + sidebar PLANTS) =====
    const plantNames=(()=>{
      const a=(st.plants||[]).map(p=>p&&p.name).filter(Boolean); if(a.length) return a;
      const o=((st.ov&&st.ov.plants)||[]).map(p=>p&&p.name).filter(Boolean); if(o.length) return o;
      const r=(st.reg.data&&st.reg.data.plants)||[]; if(r.length) return r;
      const c=(st.appCfg&&st.appCfg.att_plants); return Array.isArray(c)?c:[]; })();
    const plantSel={value:st.plant||'', onChange:(e)=>this.setPlant((e&&e.target)?e.target.value:''),
      options:[{v:'',label:'All Plants'}, ...plantNames.map(n=>({v:n,label:n}))]};
    const plantRows=((st.plants&&st.plants.length)?st.plants:plantNames.map(n=>({name:n}))).filter(p=>p&&p.name).map(p=>{
      const has=p.total!=null, tot=Number(p.total)||0, on=Number(p.online)||0;
      const dot=!has||!tot?'var(--side-text2)':(on>=tot?'var(--ok)':(on>0?'var(--gold)':'var(--crit)'));
      return {name:p.name, cls:st.plant===p.name?'on':'', dot,
        state:has?(on+'/'+tot):'', title:has?(on+' of '+tot+' cameras online'+(st.plant===p.name?' · click to show all plants':' · click to filter')):'Click to filter',
        onClick:()=>this.setPlant(st.plant===p.name?'':p.name)}; });

    // ===== SUB-TAB STRIP for grouped pages =====
    const SUBTABS={
      cameras:[['live','Live Feeds'],['cameras','Camera Fleet']],
      reports:[['incidents','Incidents'],['analytics','Analytics'],['forecast','Forecast'],['fire','Fire & Smoke'],['face','Face & Body']],
      settings:[['settings','Settings'],['rules','Alert Rules']].concat(this.PERMS.users?[['users','Users & Roles']]:[]),
    };
    const subTabs=(SUBTABS[navGroup]||[]).map(([k,label])=>({label, cls:st.page===k?'on':'', onClick:()=>this.setPage(k)}));

    // ===== OVERVIEW (/api/overview) =====
    const ov=st.ov||{};
    const N=(v)=>Number(v)||0;
    const fmtN=(v)=>N(v).toLocaleString('en-US');
    const tint={crit:'var(--tint-red)', high:'var(--tint-orange)', gold:'var(--tint-amber)', ok:'var(--tint-green)', low:'var(--tint-blue)', muted:'var(--bg4)'};
    const pill=(sev)=>({high:['High','var(--crit)',tint.crit], critical:['Critical','var(--crit)',tint.crit], medium:['Medium','#B45309',tint.gold],
      low:['Low','var(--brand)',tint.low]}[sev]||['—','var(--text3)',tint.muted]);
    const thumbOf=(img)=>img?`url('${img}') center/cover no-repeat`:grad;
    const hms=(t)=>{ const s=String(t||''); return s.length>=19?s.slice(11,16):s.slice(0,5); };
    const cntDelta=(today,yest,suffix)=>{ const d=N(today)-N(yest);
      return {delta:(d>0?'▲ +'+d:(d<0?'▼ '+d:'0'))+' '+suffix, col:d>0?'var(--crit)':'var(--ok)'}; };
    const pctDelta=(today,yest,suffix)=>{ const t=N(today), y=N(yest);
      if(!y) return t?{delta:'▲ +'+t+' '+suffix, col:'var(--crit)'}:{delta:'0% '+suffix, col:'var(--ok)'};
      const p=Math.round(100*(t-y)/y);
      return {delta:(p>0?'▲ +'+p:(p<0?'▼ '+p:'0'))+'% '+suffix, col:p>0?'var(--crit)':'var(--ok)'}; };
    // Employees today. The register's kpi.present counts late arrivals too;
    // detect that from the totals so the donut never double-counts.
    const oe=ov.employees||{};
    const eTot=N(oe.total), eLate=N(oe.late), eAbs=N(oe.absent), ePend=N(oe.pending);
    const presInclLate=Math.abs(N(oe.present)+eAbs+ePend-eTot) <= Math.abs(N(oe.present)+eLate+eAbs+ePend-eTot);
    const eOnTime=oe.onTime!=null?Math.max(0,N(oe.onTime)):Math.max(0, presInclLate?N(oe.present)-eLate:N(oe.present));
    const eIn=eOnTime+eLate;
    const presentPct=oe.presentPct!=null?Number(oe.presentPct):(eTot?Math.round(1000*eIn/eTot)/10:0);
    const ovPresentRing=`conic-gradient(var(--ok) 0 ${Math.max(0,Math.min(100,presentPct))}%, var(--line2) 0)`;
    const opp=ov.ppe||{}, ora=ov.restricted||{}, ocl=ov.cleaning||{}, ofk=ov.forklift||{};
    const clSess=N(ocl.sessionsToday), clDone=N(ocl.done);
    const clPct=clSess?Math.round(100*clDone/clSess):null;
    const ppeD=cntDelta(opp.today, opp.yesterday, 'vs. yesterday');
    const raD2=pctDelta(ora.today, ora.yesterday, 'vs. yesterday');
    const fkD2=cntDelta(ofk.violationsToday, ofk.violationsYesterday!=null?ofk.violationsYesterday:ofk.yesterday, 'vs. yesterday');
    const ovLoading=st.ovBusy && !st.ov;
    const ovKpi={
      emp:{value:fmtN(eTot), delta:ovLoading?'Loading…':('+'+N(oe.newThisMonth)+' this month'), col:ovLoading?'var(--text3)':'var(--ok)', onClick:()=>this.setPage('employees')},
      pres:{value:fmtN(eIn), delta:presentPct+'% attendance', col:'var(--text2)', onClick:()=>this.setPage('attendance')},
      ppe:{value:fmtN(opp.today), delta:ppeD.delta, col:ppeD.col, onClick:()=>this.setPage('ppe')},
      ra:{value:fmtN(ora.today), delta:raD2.delta, col:raD2.col, onClick:()=>this.setPage('intr')},
      cl:{value:clPct==null?'—':(clPct+'%'), delta:clDone+' of '+clSess+' done today', col:clPct==null?'var(--text3)':(clPct>=90?'var(--ok)':(clPct>=60?'var(--gold)':'var(--crit)')), onClick:()=>this.setPage('cleaning')},
      fk:{value:fmtN(ofk.violationsToday), delta:fkD2.delta, col:fkD2.col, onClick:()=>this.setPage('forklift')},
    };
    // Week bars (present excludes late on the server side)
    const PEND_COL='#C9D1E0';
    const week=Array.isArray(ov.week)?ov.week:[];
    const wkMax=Math.max(1, ...week.map(w=>N(w.present)+N(w.late)+N(w.absent)+N(w.pending)));
    const yMax=(()=>{ const p=Math.pow(10, Math.floor(Math.log10(wkMax))); for(const m of [1,2,2.5,5,10]) if(m*p>=wkMax) return m*p; return 10*p; })();
    const ovYAxis=[1,0.75,0.5,0.25,0].map(f=>({label:fmtN(Math.round(yMax*f))}));
    const hPct=(v)=>(Math.round(1000*N(v)/yMax)/10)+'%';
    const ovWeek=week.map(w=>({label:w.label||'', day:w.day||String(w.date||'').slice(5),
      pH:hPct(w.present), lH:hPct(w.late), aH:hPct(w.absent), nH:hPct(w.pending),
      title:(w.day||w.date||'')+' · present '+N(w.present)+' · late '+N(w.late)+' · absent '+N(w.absent)+' · not clocked in '+N(w.pending)}));
    // Donut — status today
    const dParts=[['Present',eOnTime,'var(--ok)'],['Late',eLate,'var(--gold)'],['Absent',eAbs,'var(--crit)'],['Not Clocked In',ePend,PEND_COL]];
    const dSum=dParts.reduce((a,p)=>a+p[1],0);
    let acc=0;
    const ovDonut=dSum?('conic-gradient('+dParts.map(p=>{ const a=acc; acc+=100*p[1]/dSum; return p[2]+' '+a.toFixed(2)+'% '+acc.toFixed(2)+'%'; }).join(', ')+')')
      :'conic-gradient(var(--line2) 0 100%)';
    const ovDonutLegend=dParts.map(([label,n,dot])=>({label, dot, val:fmtN(n), pct:'('+(dSum?(Math.round(1000*n/dSum)/10):0)+'%)'}));
    // Multi-plant cards
    const PLANT_IMG=['linear-gradient(135deg,#2F6BFF,#8B5CF6)','linear-gradient(135deg,#22C55E,#0EA5E9)','linear-gradient(135deg,#F97316,#F59E0B)','linear-gradient(135deg,#EF4444,#8B5CF6)'];
    const ovPlants=(Array.isArray(ov.plants)?ov.plants:[]).map((p,i)=>({
      name:p.name, sub:(p.camsTotal!=null?(N(p.camsOnline)+'/'+N(p.camsTotal)+' cameras online'):'')+(st.plant===p.name?' · filtered':''),
      img:PLANT_IMG[i%PLANT_IMG.length],
      rows:[
        {k:'Employees', v:fmtN(p.employees), col:'var(--text)'},
        {k:'Present', v:fmtN(p.present)+(p.presentPct!=null?(' ('+p.presentPct+'%)'):''), col:'var(--ok)'},
        {k:'PPE Violations', v:fmtN(p.ppe), col:N(p.ppe)?'var(--crit)':'var(--text)'},
        {k:'Restricted Alerts', v:fmtN(p.restricted), col:N(p.restricted)?'var(--crit)':'var(--text)'},
        {k:'Forklift Alerts', v:fmtN(p.forklift), col:N(p.forklift)?'var(--high)':'var(--text)'},
      ],
      onClick:()=>this.setPlant(st.plant===p.name?'':p.name)}));
    // Recently recognised employees
    const FSTAT={present:['PRESENT','var(--ok)',tint.ok], late:['LATE','#B45309',tint.gold], pending:['SEEN','var(--brand)',tint.low],
      absent:['ABSENT','var(--crit)',tint.crit], off:['OFF DAY','var(--text3)',tint.muted]};
    const ovFaces=(Array.isArray(ov.recognized)?ov.recognized:[]).slice(0,6).map(r=>{ const s=FSTAT[r.status]||FSTAT.present;
      return {bg:thumbOf(r.image), time:hms(r.time), name:r.name||('#'+r.personId),
        loc:[r.plant, r.location].filter(Boolean).join(' · ')||'—', status:s[0], statusCol:s[1], statusBg:s[2],
        onOpen:()=>{ if(r.image) this.openLightbox(r.image, (r.name||'')+' · '+(r.location||'')+' · '+hms(r.time)); }}; });
    // PPE tiles (today's violations per missing item)
    const pb=opp.byItem||{};
    const pcol=(v)=>N(v)?'var(--crit)':'var(--ok)';
    const ovPpe={helmet:fmtN(pb.helmet), vest:fmtN(pb.vest), goggles:fmtN(pb.goggles), gloves:fmtN(pb.gloves),
      helmetCol:pcol(pb.helmet), vestCol:pcol(pb.vest), gogglesCol:pcol(pb.goggles), glovesCol:pcol(pb.gloves),
      note:opp.compliance!=null?('7-day compliance '+opp.compliance+'% · '+N(opp.today)+' violations today'):(N(opp.today)+' violations today')};
    // Restricted / forklift recent lists
    const ovRa=(Array.isArray(ora.recent)?ora.recent:[]).slice(0,3).map(r=>{ const pl=pill(r.severity);
      return {thumb:thumbOf(r.image), title:r.verdictLabel||(r.verdict==='review'?'Needs review':'Unauthorized entry'),
        sub:[r.plant, r.zone||r.location].filter(Boolean).join(' – ')||r.camera||'', time:String(r.time||'').slice(0,16),
        pill:pl[0], pillCol:pl[1], pillBg:pl[2], onOpen:()=>this.setPage('intr')}; });
    const ovFk=(Array.isArray(ofk.recent)?ofk.recent:[]).slice(0,3).map(r=>{ const pl=pill(r.severity);
      return {thumb:thumbOf(r.image), title:r.verdictLabel||({violation:'Zone violation', logged:'Forklift detected', cleared:'Cleared'}[r.verdict]||'Forklift event'),
        sub:[r.plant, r.zone||r.location].filter(Boolean).join(' – ')||r.camera||'', time:String(r.time||'').slice(0,16),
        pill:pl[0], pillCol:pl[1], pillBg:pl[2], onOpen:()=>this.setPage('forklift')}; });
    const ovFkStats={today:fmtN(ofk.today), violations:fmtN(ofk.violationsToday), violCol:N(ofk.violationsToday)?'var(--crit)':'var(--text)'};
    // Cleaning card
    const cb=ocl.byItem||{};
    const OV_CL_ITEMS=[['helmet','Helmet'],['vest','Safety Vest'],['goggles','Goggles'],['gloves','Gloves']];
    const ovClean={
      ring:`conic-gradient(var(--ok) 0 ${clPct||0}%, var(--line2) 0)`, pct:clPct==null?'—':(clPct+'%'),
      total:fmtN(clSess), done:fmtN(clDone), pending:fmtN(ocl.pending),
      ppeLine:ocl.compliance!=null?('· '+ocl.compliance+'% (7 d)'):'',
      items:OV_CL_ITEMS.map(([k,label])=>{ const b=cb[k]||{}; const req=N(b.required), miss=N(b.missing);
        const p=req?Math.round(100*(req-miss)/req):null;
        return {label, val:p==null?'—':(p+'%'), col:p==null?'var(--text3)':(p>=95?'var(--ok)':(p>=80?'var(--gold)':'var(--crit)'))}; }),
    };
    // Live camera tiles — online first, one tile per physical feed
    const ovPool=livePool.slice().sort((a,b)=>(b.online!==false)-(a.online!==false));
    const ovSeen={};
    const ovCams=ovPool.filter(c=>{ const k=String(c.rtsp||c.stream||c.id||'').trim().toLowerCase(); if(!k||ovSeen[k]) return !k; ovSeen[k]=1; return true; })
      .slice(0,3).map(c=>{ const on=c.online!==false;
        const vsrc=(st.liveBase && c.stream && on && !st.demo) ? (st.liveBase+'/api/stream.mp4?src='+encodeURIComponent(c.stream)+_liveTok) : '';
        return {name:c.name||c.stream||c.id, hasVideo:!!vsrc, videoUrl:vsrc, camKey:'ov-'+(c.stream||String(c.id).toLowerCase()),
          bg:c.img?`url('${c.img}') center/cover no-repeat, ${c.scene||'#0c0f1d'}`:(c.scene||'linear-gradient(160deg,#141830,#0c0f1d)'),
          liveLabel:on?'Live':'Offline', liveBg:on?'var(--crit)':'var(--text3)',
          onOpen:()=>this.openCamera(c.stream||String(c.id).toLowerCase())}; });
    // Recent events table
    const EVT={face:['var(--brand)',tint.low], ppe:['#B45309',tint.gold], intr:['var(--crit)',tint.crit], forklift:['var(--high)',tint.high],
      fire:['var(--crit)',tint.crit], cleaning:['var(--ok)',tint.ok]};
    const EST={open:['Open','var(--crit)',tint.crit], ack:['Acknowledged','#B45309',tint.gold], resolved:['Resolved','var(--ok)',tint.ok]};
    const MODPAGE={face:'attendance', ppe:'ppe', intr:'intr', forklift:'forklift', cleaning:'cleaning', fire:'fire'};
    const ovEvents=(Array.isArray(ov.events)?ov.events:[]).slice(0,8).map(e=>{ const t=EVT[e.mod]||['var(--text2)',tint.muted];
      const s=(e.mod==='face'&&e.type==='Attendance')?['Present','var(--ok)',tint.ok]:(EST[e.status]||EST.open);
      const ts=String(e.time||'');
      return {type:e.type||e.mod, typeCol:t[0], typeBg:t[1], who:e.who||'—', location:e.location||'—',
        time:ts.slice(0,10)===this.todayStr()?ts.slice(11,19):ts.slice(5,16),
        status:s[0], statusCol:s[1], statusBg:s[2],
        onOpen:()=>{ const ev=(st.events||[]).find(x=>String(x.id)===String(e.id));
          if(ev) this.openModal('event', ev); else if(MODPAGE[e.mod]) this.setPage(MODPAGE[e.mod]); else if(e.image) this.openLightbox(e.image, e.type||''); }}; });
    const ovUpdated=st.ovBusy?'Refreshing…':(ov.generated_at?('Updated '+String(ov.generated_at).slice(11,19)+(st.plant?(' · '+st.plant):' · all plants')):'');

    // ===== FORKLIFT MONITORING (/api/forklift/summary) =====
    const fkd=st.fkD||{}, fkf=st.fkF, fkk=fkd.kpi||{};
    const FKV={violation:['ZONE VIOLATION','var(--crit)'], logged:['FORKLIFT DETECTED','var(--low)'], cleared:['CLEARED — FALSE ALARM','var(--ok)']};
    const fkSel=(key,list,blank)=>({value:fkf[key]||'', options:[{v:'',label:blank}, ...list],
      onChange:(e)=>this.setFkF({[key]:(e&&e.target)?e.target.value:''})});
    const fkPlantSel=fkSel('plant', ((fkd.plants&&fkd.plants.length)?fkd.plants:plantNames).map(x=>({v:x,label:x})), 'All plants');
    const fkCamSel=fkSel('camera', (fkd.zones||[]).map(z=>({v:z.key, label:(z.name||z.key)+' · '+z.key})), 'All zones / cameras');
    const fkVerdictSel=fkSel('verdict', Object.keys(FKV).map(k=>({v:k, label:(fkd.verdicts||{})[k]||k})), 'All verdicts');
    const fkStatusSel=fkSel('status', [{v:'open',label:'Open'},{v:'ack',label:'Acknowledged'},{v:'resolved',label:'Resolved'}], 'Any alert status');
    const fkKpis=[
      ['DETECTIONS', fkk.detections||0, 'var(--text)', 'forklift / vehicle events in range'],
      ['ZONE VIOLATIONS', fkk.violations||0, (fkk.violations?'var(--crit)':'var(--ok)'), 'prohibited zone or restricted hours'],
      ['LOGGED', fkk.logged||0, 'var(--low)', 'detected, no rule broken'],
      ['CLEARED', fkk.cleared||0, 'var(--text3)', 'false alarms cleared by a reviewer'],
      ['TODAY', fkk.today||0, (fkk.today?'var(--high)':'var(--ok)'), 'violations since midnight'],
      ['OPEN ALERTS', fkk.open||0, (fkk.open?'var(--high)':'var(--ok)'), 'violations not yet handled'],
    ].map(([label,value,tone,sub])=>({label, value:String(value), tone, sub}));
    const fkMax=Math.max(1, ...(fkd.daily||[]).map(x=>N(x.detections)));
    const fkDaily=(fkd.daily||[]).map(x=>{ const v=N(x.violations), l=Math.max(0, N(x.detections)-v);
      return {label:String(x.date).slice(5), title:x.date+' · '+N(x.detections)+' detections · '+v+' violations',
        vH:Math.round(100*v/fkMax)+'%', lH:Math.round(100*l/fkMax)+'%', v:N(x.detections)?String(N(x.detections)):''}; });
    const fkZMax=Math.max(1, ...(fkd.byZone||[]).map(z=>N(z.detections)));
    const FKRULE={prohibited:'prohibited', restricted:'restricted hours'};
    const fkByZone=(fkd.byZone||[]).map(z=>({zone:z.zone||z.camera, sub:[z.plant, z.camera, FKRULE[z.rule]].filter(Boolean).join(' · '),
      line:N(z.violations)+' violations · '+N(z.detections)+' detections', w:Math.round(100*N(z.detections)/fkZMax)+'%',
      col:N(z.violations)?'var(--crit)':'var(--low)',
      onClick:()=>this.setFkF({camera:fkf.camera===z.camera?'':z.camera})}));
    const fkInc=(fkd.incidents||[]).map(i=>{ const vv=FKV[i.verdict]||[String(i.verdict||'').toUpperCase(),'var(--text3)'];
      return {
        thumb:thumbOf(i.image), verdict:vv[0], vCol:vv[1], zone:i.zone||i.camera,
        where:[i.plant, i.location].filter(Boolean).join(' · '), cam:(i.camera||'')+(i.policy?(' · '+i.policy):'')+(i.rule?(' · '+(FKRULE[i.rule]||i.rule)):''),
        time:String(i.time||'').slice(0,16), reason:i.reason||'',
        status:'Alert: '+(i.status||'open')+(i.reviewedBy?(' · reviewed by '+i.reviewedBy):'')+(i.note?(' — '+i.note):''),
        canConfirm:i.verdict==='logged'||i.verdict==='cleared', canClear:i.verdict==='violation'||i.verdict==='logged',
        onConfirm:()=>this.reviewFk(i,'violation'), onClear:()=>this.reviewFk(i,'cleared'),
        onOpen:()=>{ if(i.image) this.openLightbox(i.image, (i.zone||i.camera)+' · '+String(i.time).slice(0,16)); },
      }; });
    const fkModelNote=fkd.modelNote||ofk.modelNote||'SenseStudio V2.13 has no dedicated forklift class — detections come from vehicle / non-motor-vehicle attributes on forklift-zone cameras, or a SenseStudio policy named "forklift". Pedestrian proximity and unsafe operation need a trained forklift model.';
    // Settings → Forklift Zones (one row per camera)
    const fkZonesCur=(ap&&ap.fk_zones)||{};
    const fkCamPolicies=(key)=>[...new Set((st.policies||[]).filter(p=>String(p.stream).toLowerCase()===key && (p.mod==='forklift'||/forklift|vehicle/i.test(String(p.policy||'')))).map(p=>p.policy))];
    const fkZoneRows=[...new Set([...pocStreams.map(c=>c.key), ...Object.keys(fkZonesCur)])].map(key=>{
      const z={enabled:false, name:'', rule:'prohibited', hours:'always', note:'', ...(fkZonesCur[key]||{})};
      const dr=(st.fkDraft||{})[key]||{};
      const cam=pocStreams.find(c=>c.key===key);
      const pols=fkCamPolicies(key);
      return {
        key:key.toUpperCase(), camName:cam?cam.name:key.toUpperCase(), loc:spCamLocCur[key]||'not mapped to a camera point',
        pols:pols.length?('SenseStudio vehicle / forklift policies: '+pols.join(', ')):'No vehicle or forklift policy has fired on this camera yet — set one up in SenseStudio',
        polsCol:pols.length?'var(--text3)':'var(--high)',
        state:z.enabled?(z.rule==='restricted'?'FORKLIFT ZONE · RESTRICTED HOURS':'FORKLIFT ZONE · PROHIBITED'):'Not a forklift zone',
        stateCol:z.enabled?'var(--high)':'var(--text3)',
        enableChips:[[true,'Forklift zone'],[false,'Off']].map(([v,label])=>({label, cls:z.enabled===v?'chip on':'chip',
          onClick:()=>this.saveFkZone(key,{enabled:v, name:z.name||((spCamLocCur[key]||key.toUpperCase())+' forklift zone')})})),
        ruleChips:[['prohibited','Prohibited'],['restricted','Restricted hours']].map(([v,label])=>({label, cls:z.rule===v?'chip on':'chip',
          onClick:()=>this.saveFkZone(key,{rule:v})})),
        name:dr.name!=null?dr.name:z.name, onName:(e)=>this.fkDraftSet(key,'name',(e&&e.target)?e.target.value:''),
        hours:dr.hours!=null?dr.hours:(z.hours==='always'?'':z.hours), onHours:(e)=>this.fkDraftSet(key,'hours',(e&&e.target)?e.target.value:''),
        note:dr.note!=null?dr.note:(z.note||''), onNote:(e)=>this.fkDraftSet(key,'note',(e&&e.target)?e.target.value:''),
        onSave:()=>this.saveFkZone(key,{
          name:String(dr.name!=null?dr.name:z.name).trim(),
          hours:dr.hours!=null?(String(dr.hours).trim()||'always'):z.hours,
          note:String(dr.note!=null?dr.note:(z.note||'')).trim()}),
      }; });

    return {
      theme:st.theme, clock, dateStr, dateLong, infLoad:st.infLoad,
      sideMode:st.sideCollapsed?'collapsed':'open', toggleSide:()=>this.toggleSide(),
      sideToggleTitle:st.sideCollapsed?'Expand navigation':'Collapse navigation',
      // global plant filter + sidebar plants + grouped sub-tabs
      plantSel, plantRows, hasPlants:plantRows.length>0, subTabs, hasSubTabs:subTabs.length>0,
      // overview
      isOverview:st.page==='overview', ovKpi, ovPresentRing, ovYAxis, ovWeek, ovDonut, ovDonutTotal:fmtN(eTot), ovDonutLegend,
      ovPlants, ovPlantsEmpty:!!st.ov && ovPlants.length===0, ovFaces, ovFacesEmpty:ovFaces.length===0,
      ovPpe, ovRa, ovRaEmpty:ovRa.length===0, ovClean, ovFk, ovFkEmpty:ovFk.length===0, ovFkStats,
      ovCams, ovCamsEmpty:ovCams.length===0, ovCamsCount:String(livePool.length),
      ovEvents, ovEventsHas:ovEvents.length>0, ovEventsEmpty:ovEvents.length===0, ovUpdated,
      ovErr:st.ovErr||'', ovHasErr:!!st.ovErr, reloadOv:()=>this.loadOverview(),
      goAttendance:()=>this.setPage('attendance'), goPpe:()=>this.setPage('ppe'), goIntr:()=>this.setPage('intr'),
      goCleaning:()=>this.setPage('cleaning'), goForklift:()=>this.setPage('forklift'), goLive:()=>this.setPage('live'),
      goIncidents:()=>this.setPage('incidents'), goEmployees:()=>this.setPage('employees'),
      // employees + face registration pages
      isEmployees:st.page==='employees', isFaces:st.page==='faces',
      // forklift monitoring
      isForklift:st.page==='forklift', fkKpis, fkDaily, fkByZone, fkNoZoneRows:!!fkd.from && fkByZone.length===0, fkInc,
      fkNoInc:!!fkd.from && fkInc.length===0, fkNoZones:!!fkd.from && !(fkd.zones||[]).some(z=>z.enabled),
      fkPlantSel, fkCamSel, fkVerdictSel, fkStatusSel, fkMsg:st.fkMsg||'', fkModelNote,
      fkStatus:fkf.busy?'Loading…':(fkf.err||''),
      fkFrom:fkf.from||fkd.from||'', fkTo:fkf.to||fkd.to||'',
      onFkFrom:(e)=>this.setFkF({from:(e&&e.target)?e.target.value:''}),
      onFkTo:(e)=>this.setFkF({to:(e&&e.target)?e.target.value:''}),
      reloadFk:()=>this.loadFk(), exportFkInc:()=>this.exportFk('incidents'), exportFkSum:()=>this.exportFk('summary'),
      goSettingsFk:()=>{ this.setState({spTab:'fk'}); this.setPage('settings'); },
      spTabFk:st.spTab==='fk', fkZoneRows,
      camsOnline:(st.live.camsOnline!=null?st.live.camsOnline:this.camPool.length),
      camsTotal:(st.live.camsTotal!=null?st.live.camsTotal:this.camPool.length),
      ppePct:(st.live.ppePct!=null?st.live.ppePct:100),
      openCount, kpis, filters, cameras, events, bars, trendTotal:trendTotal.toLocaleString(), gridOpts,
      gridCols:cols, shownCount, gridGap: compact?'9px':'13px',
      // Live Feeds counter reflects the tiles actually in the grid (hidden
      // cameras excluded), not the whole registry.
      feedTotal: livePool.length, feedOnline: livePool.filter(c=>c.online!==false).length,
      isDarkTheme: st.theme==='dark', isLightTheme: st.theme!=='dark',
      pauseLabel: st.paused?'Resume':'Pause', pauseIcon: st.paused?'▶':'❚❚', evTypeSel,
      newBuild: !!st.newBuild, doReload: ()=>{ try{ location.reload(); }catch(e){} },
      toggleTheme:()=>this.toggleTheme(),
      togglePaused:()=>this.togglePaused(),
      avgAck:(st.live.avgAck||'—'),
      // clickable KPIs → modals
      openIncidents:()=>this.openModal('incidents'), openGpu:()=>this.openModal('gpu'),
      openPpe:()=>this.openModal('ppe'), openCameras:()=>this.openModal('cameras'),
      openAddCam:()=>this.openModal('addcam'),
      // AI (weststar-ai LLM analytics)
      aiHas: !!(st.ai && st.ai.summary), aiSummary: (st.ai && st.ai.summary) || '',
      // lightbox
      hasLightbox: !!st.lightbox,
      lightboxBg: st.lightbox?`url('${st.lightbox.url}') center/contain no-repeat`:'none',
      lightboxLabel: st.lightbox?st.lightbox.label:'',
      closeLightbox:()=>this.closeLightbox(),
      // search
      search:st.search, onSearch:(e)=>this.setSearch(e&&e.target?e.target.value:''), searchHas, searchEmpty, searchInc, searchCam, searchPeople,
      clearSearch:()=>this.setSearch(''),
      // modals
      hasModal:!!st.modal, modalType:mt, closeModal:()=>this.closeModal(),
      noop:(e)=>{ if(e&&e.stopPropagation)e.stopPropagation(); },
      isMIncidents:mt==='incidents', isMEvent:mt==='event', isMCameras:mt==='cameras',
      isMVideo:mt==='video', isMGpu:mt==='gpu', isMPpe:mt==='ppe', isMAddCam:mt==='addcam',
      isMProfile:mt==='profile', pf:(()=>{ const f=st.pf; if(!f) return {shots:[], genders:[], activeChips:[],
          deptSel:{options:[]}, plantSel:{options:[]}, shiftSel:{options:[]}};
        const gval=(f.gender||'').toLowerCase();
        return {
          personId:f.personId, title:f.isNew?'Register employee':(f.isEdit?'Edit person profile':'Create person profile'),
          idLine: f.isNew?'new employee · add a clear face photo so SenseStudio can recognise them':('person #'+f.personId+' · shown on every future detection'),
          ...(()=>{ const o=st.reg.data||{};
            const sel=(key,list,blank)=>({value:f[key]||'', onChange:(e)=>this.pfSet(key,(e&&e.target)?e.target.value:''),
              options:[{v:'',label:blank}, ...list]});
            return {
              deptSel: sel('department', (o.departments||[]).map(x=>({v:x,label:x})), '— Department —'),
              plantSel: sel('plant', (o.plants||[]).map(x=>({v:x,label:x})), '— Plant —'),
              shiftSel: sel('shift', (o.shifts||[]).map(s=>({v:s.id,label:s.name+' · '+s.start+'–'+s.end})), 'Default shift'),
              activeChips:[[true,'Active'],[false,'Inactive']].map(([v,label])=>({label,
                cls:(f.active!==false)===v?'chip on':'chip', onClick:()=>this.pfSet('active',v)})),
            }; })(),
          name:f.name, staff:f.staff||'', age:f.age, about:f.about, msg:f.msg||'',
          photoBg: f.photo? `url('${f.photo}') center/cover no-repeat` : 'linear-gradient(160deg,#141830,#0c0f1d)',
          hasPhoto:!!f.photo, saveLabel:f.saving?'Saving…':(f.isEdit?'Save changes':'Create profile'),
          genders:[['male','Male'],['female','Female'],['other','Other']].map(([v,label])=>({
            label, cls: gval===v?'chip on':'chip', onClick:()=>this.pfSet('gender',v)})),
          shots:(f.shots||[]).slice(0,24).map(u=>({
            bg:`url('${u}') center/cover no-repeat`,
            ring: u===f.photo?'var(--brand)':'transparent',
            onPick:()=>this.pfSet('photo',u)})),
          hasShots:(f.shots||[]).length>0,
          uploadLabel: f.uploading?'Uploading…':'⇪ Attach / capture photo',
          onBrowse:()=>this.pfBrowse(),
          onName:(e)=>this.pfSet('name',(e&&e.target)?e.target.value:''),
          onStaff:(e)=>this.pfSet('staff',(e&&e.target)?e.target.value:''),
          onAge:(e)=>this.pfSet('age',(e&&e.target)?e.target.value:''),
          onAbout:(e)=>this.pfSet('about',(e&&e.target)?e.target.value:''),
          onSave:()=>this.pfSave(),
        }; })(),
      // ── Floating assistant ──
      asOpen: st.asOpen, asClosed: !st.asOpen,
      asBusy: st.asBusy, asIdle: !st.asBusy,
      asDraft: st.asDraft, asErr: st.asErr, asHasErr: !!st.asErr,
      asEmpty: st.asMsgs.length===0, asHasMsgs: st.asMsgs.length>0,
      asMsgs: st.asMsgs.map((m,i)=>({
        isUser: m.role==='user', isBot: m.role!=='user', text: m.text,
        cls: m.role==='user' ? 'as-msg as-me' : 'as-msg as-bot',
        // A dropped photo shows as a thumbnail on the operator's own bubble.
        hasImg: !!m.img, imgBg: m.img?`url('${m.img}') center/cover no-repeat`:'',
        // Face-search results render as openable person cards.
        isCards: m.kind==='faces' && !!(m.matches && m.matches.length),
        cards: (m.matches||[]).map(fm=>{
          const col = fm.score>=90?'var(--ok)':(fm.score>=75?'var(--gold)':'var(--crit)');
          return {
            photo: fm.photo?`url('${fm.photo}') center/cover no-repeat`:grad,
            name: fm.name || ('Person #'+fm.personId),
            score: fm.score+'%', scoreCol: col,
            sub: '#'+fm.personId+' · '+fm.library+(fm.registered?' · profiled':''),
            meta: fm.captures
              ? (fm.captures+' capture'+(fm.captures===1?'':'s')
                 +((fm.cameras&&fm.cameras.length)?' · '+fm.cameras.join(', '):'')
                 +(fm.lastSeen?' · last seen '+String(fm.lastSeen).slice(5,16):''))
              : 'No captures stored on this dashboard yet',
            hasCaptures: !!fm.captures,
            profLabel: fm.registered?'Open FR profile':'Create FR profile',
            onProfile: ()=>this.asOpenProfile(fm),
            onCaptures: ()=>this.asOpenCaptures(fm),
            onPhoto: ()=>{ if(fm.photo) this.openLightbox(fm.photo, (fm.name||('Person #'+fm.personId))+' · '+fm.score+'% match'); },
          };
        }),
        hasCites: !!(m.cites && m.cites.length),
        cites: (m.cites||[]).slice(0,4).map(c=>({
          label: '['+(c.n||'?')+'] '+(c.title||c.source||'source'),
          onOpen: ()=>{ if(c.source && /^https?:/.test(c.source)) window.open(c.source,'_blank','noopener,noreferrer'); }})),
        key: 'm'+i,
      })),
      asSuggest: [
        'What is happening in the last 24 hours?',
        'Any detections past their SLA?',
        'Who has been detected today?',
        'Which cameras are reporting?',
      ].map(q=>({label:q, onClick:()=>this.asAsk(q)})),
      asToggle: ()=>this.asToggle(),
      asClear: ()=>this.asClear(),
      asBrowseShot: ()=>this.asBrowseShot(),
      asSend: ()=>this.asSend(),
      asOnInput: (e)=>this.asSet((e&&e.target)?e.target.value:''),
      asOnKey: (e)=>this.asKey(e),
      isMTicket:mt==='ticket',
      mIncidents, mEvent, mFleet, mVideo, liveOn,
      gpuBars, gpuNow, gpuPeak, gpuAvg,
      ppeRows, ppeTabs, ppeWearing:ppe.wearing, ppeMissing:ppe.missing, ppeTotal:ppe.total, ppePctBig:ppe.total>0?ppe.pct:100,
      addName:st.addCam.name, addRtsp:st.addCam.rtsp, addBusy:st.addCam.busy, addMsg:st.addCam.msg,
      onAddName:(e)=>this.updAddCam({name:e&&e.target?e.target.value:''}), onAddRtsp:(e)=>this.updAddCam({rtsp:e&&e.target?e.target.value:''}), submitCamera:()=>this.submitCamera(),
      // routing
      page:st.page, nav, pageTitle, pageSub,
      isLive:st.page==='live', isIncidents:st.page==='incidents', isCameras:st.page==='cameras', isAnalytics:st.page==='analytics',
      isDet, det, isRules:st.page==='rules', isSettings:st.page==='settings', isForecast:st.page==='forecast',
      isUsers:st.page==='users', isCamera:st.page==='camera', camDetail,
      // attendance & movement (POC Use Case 1)
      isAttendance:st.page==='attendance',
      attKpis, attRows, attHasRows:attRows.length>0, attDaysTabs, attStatus, attMappedLine, attNeedsMap, attEmpty,
      attQVal:st.attQ, onAttQ:(e)=>this.setState({attQ:(e&&e.target)?e.target.value:''}),
      attUnknown, attHasUnknown:attUnknown.length>0,
      reloadAtt:()=>this.loadAttendance(true),
      goSettingsPoc:()=>{ this.setState({spTab:'poc'}); this.setPage('settings'); },
      isMJourney:mt==='journey', jn:jnV,
      attViews, attViewRegister:st.attView==='register',
      attViewLive:st.attView==='live', attViewReports:st.attView==='reports',
      regDate:reg.date||this.todayStr(), onRegDate:(e)=>this.setReg({date:(e&&e.target)?e.target.value:''}),
      regPrevDay:()=>{ const d=new Date((reg.date||this.todayStr())+'T12:00:00'); d.setDate(d.getDate()-1); this.setReg({date:d.toISOString().slice(0,10)}); },
      regNextDay:()=>{ const d=new Date((reg.date||this.todayStr())+'T12:00:00'); d.setDate(d.getDate()+1); this.setReg({date:d.toISOString().slice(0,10)}); },
      regToday:()=>this.setReg({date:''}),
      regQ:reg.q, onRegQ:(e)=>this.setReg({q:(e&&e.target)?e.target.value:''}),
      regPlantSel, regDeptSel, regStatusSel, regKpis, regRows, regRecent, regNoRecent:!!regD.date && regRecent.length===0,
      regStatusLine, regNoRoles, regEmpty, regSummary,
      reloadReg:()=>this.loadRegister(), exportDaily:()=>this.exportAtt('daily'),
      goSettingsAtt:()=>{ this.setState({spTab:'att'}); this.setPage('settings'); },
      empRows, empEmpty:empRows.length===0, empCount, empMsg:st.empMsg, empQ:st.empQ,
      onEmpQ:(e)=>this.setState({empQ:(e&&e.target)?e.target.value:''}),
      newEmployee:()=>this.newEmployee(), syncAll:()=>this.syncEmployee(null),
      canSync:!!this.PERMS.settings, syncAllLabel:st.empBusy?'Syncing…':'⇅ Sync all to SenseStudio',
      repFrom:rp.from||reg.date||today, repTo:rp.to||rp.from||reg.date||today,
      onRepFrom:(e)=>this.setState(s=>({rep:{...s.rep, from:(e&&e.target)?e.target.value:''}})),
      onRepTo:(e)=>this.setState(s=>({rep:{...s.rep, to:(e&&e.target)?e.target.value:''}})),
      repPersonSel, repCards,
      spTabAtt:st.spTab==='att', attPlantsVal, attDeptsVal,
      onAttPlants:(e)=>this.setState(s=>({attListDraft:{...s.attListDraft, plants:(e&&e.target)?e.target.value:''}})),
      onAttDepts:(e)=>this.setState(s=>({attListDraft:{...s.attListDraft, depts:(e&&e.target)?e.target.value:''}})),
      saveAttLists, attShiftRows, addShift, saveShifts, shiftsDirty:!!st.attShiftDraft,
      attCamRows, attHasCams:attCamRows.length>0, attRolesLine:attRolesSet
        ? 'Only detections at clock cameras (and the kiosk, if enabled) count as clock-in / clock-out. All cameras still record movement.'
        : 'No clock cameras set yet — every detection currently counts as a clock point. Give the entrance / guard-post cameras a clock role.',
      attLocRows, attKioskChips,
      // POC settings + per-location PPE requirement matrix
      spTabPoc:st.spTab==='poc', pocRows, pocHasCams:pocRows.length>0, spInact,
      isPpePage:st.page==='ppe', pocPpe, ppeKpis, ppeDaily, ppeByItem, ppeByLoc, ppeViol,
      ppeHasViol:ppeViol.length>0, ppeNoViol:!!pd.from && ppeViol.length===0, ppeStatus,
      ppeFrom:pf.from||pd.from||'', ppeTo:pf.to||pd.to||'',
      onPpeFrom:(e)=>this.setPpeF({from:(e&&e.target)?e.target.value:''}),
      onPpeTo:(e)=>this.setPpeF({to:(e&&e.target)?e.target.value:''}),
      ppePlantSel, ppeLocSel, ppeCamSel, ppeItemSel,
      reloadPpe:()=>this.loadPpe(), exportPpeViol:()=>this.exportPpe('violations'), exportPpeComp:()=>this.exportPpe('compliance'),
      goSettingsPpe:()=>{ this.setState({spTab:'ppe'}); this.setPage('settings'); },
      ppeNoRules:!!pd.from && !Object.keys(pd.rules||{}).length,
      spTabPpe:st.spTab==='ppe', ppeRuleRows,
      isCleaning:st.page==='cleaning', clKpis, clSessions, clViol, clByItem, clEdit,
      clNoSessions:!!cd.from && clSessions.length===0, clNoViol:!!cd.from && clViol.length===0,
      clNoSchedules:!!cd.from && !(cd.schedules||[]).length,
      clPlantSel, clLocSel, clItemSel, clMsg:st.clMsg||'', clStatus:cf.busy?'Loading…':(cf.err||''),
      clFrom:cf.from||cd.from||'', clTo:cf.to||cd.to||'',
      onClFrom:(e)=>this.setClF({from:(e&&e.target)?e.target.value:''}),
      onClTo:(e)=>this.setClF({to:(e&&e.target)?e.target.value:''}),
      reloadCl:()=>this.loadCl(), exportClSess:()=>this.exportCl('sessions'), exportClViol:()=>this.exportCl('violations'),
      clTabOverview:st.clTab!=='schedules', clTabSchedules:st.clTab==='schedules',
      clTabs:[['overview','Monitoring'],['schedules','Cleaning schedules']].map(([k,label])=>({label,
        cls:(st.clTab||'overview')===k?'chip on':'chip', onClick:()=>this.setState({clTab:k})})),
      goClSchedules:()=>this.setState({clTab:'schedules'}),
      clAdd:()=>this.clAdd(), clSave:()=>this.clSave(),
      isIntrPage:st.page==='intr', raKpis, raDaily, raByZone, raInc, raNoInc:!!rd.from && raInc.length===0, raNoZones,
      raPlantSel, raCamSel, raVerdictSel, raStatusSel, raMsg:st.raMsg||'',
      raStatus:rf.busy?'Loading…':(rf.err||''),
      raFrom:rf.from||rd.from||'', raTo:rf.to||rd.to||'',
      onRaFrom:(e)=>this.setRaF({from:(e&&e.target)?e.target.value:''}),
      onRaTo:(e)=>this.setRaF({to:(e&&e.target)?e.target.value:''}),
      reloadRa:()=>this.loadRa(), exportRaInc:()=>this.exportRa('incidents'), exportRaSum:()=>this.exportRa('summary'),
      goSettingsRa:()=>{ this.setState({spTab:'ra'}); this.setPage('settings'); },
      spTabRa:st.spTab==='ra', raZoneRows,
      gotoCameras:()=>this.setPage('cameras'), openCamera:(s)=>this.openCamera(s),
      // logged-in user + user management
      meName:this.UNAME, meRole:(this.ME&&this.ME.role)||'operator',
      meRoleLabel:(()=>{ const r=String((this.ME&&this.ME.role)||'operator').replace(/[_-]+/g,' '); return r.charAt(0).toUpperCase()+r.slice(1); })(),
      meInitials:String(this.UNAME).split(/\s+/).map(w=>w.charAt(0)).slice(0,2).join('').toUpperCase(),
      navUsersVisible:!!this.PERMS.users,
      umMsg:st.umMsg, umRows, umRoleChips, umRoleCards, umUserCount:String(umU.length),
      umTabUsers:st.umTab==='users', umTabRoles:st.umTab==='roles',
      umTabs:[['users','User Management'],['roles','Role Management']].map(([k,label])=>{ const a=st.umTab===k;
        return {label, onClick:()=>this.setState({umTab:k}),
          cls:a?'chip on':'chip'}; }),
      umDUsername:umD.username||'', onUmUsername:(e)=>this.umSet('username',(e&&e.target)?e.target.value:''),
      umDName:umD.display_name||'', onUmName:(e)=>this.umSet('display_name',(e&&e.target)?e.target.value:''),
      umDEmail:umD.email||'', onUmEmail:(e)=>this.umSet('email',(e&&e.target)?e.target.value:''),
      umDPass:umD.password||'', onUmPass:(e)=>this.umSet('password',(e&&e.target)?e.target.value:''),
      umAddUser:()=>this.umAddUser(),
      umNRName:st.umNewRole.name, onUmNRName:(e)=>this.setState(s=>({umNewRole:{...s.umNewRole, name:(e&&e.target)?e.target.value:''}})),
      umNRDesc:st.umNewRole.desc, onUmNRDesc:(e)=>this.setState(s=>({umNewRole:{...s.umNewRole, desc:(e&&e.target)?e.target.value:''}})),
      umCreateRole:()=>{ const n=st.umNewRole.name.trim(); if(!n){ this.setState({umMsg:'✗ Role name required'}); return; }
        this.umPost('roles', {name:n, desc:st.umNewRole.desc, perms:{view:true}}, 'Role created ✓');
        this.setState({umNewRole:{name:'', desc:''}}); },
      setModels, setModelsNote, camMsg: st.camMsg||'',
      // danger zone — purge all stored detections
      purgeArmed: !!st.purgeArmed,
      purgeLabel: st.purgeBusy?'Purging…':(st.purgeArmed?'Confirm — delete everything':'Purge all event data'),
      purgeColor: st.purgeArmed?'#fff':'var(--crit)',
      purgeBg: st.purgeArmed?'var(--crit)':'transparent',
      purgeMsg: st.purgeMsg||'',
      purgeCount: st.events.length ? (st.events.length+' incidents loaded') : 'no incidents loaded',
      purgeEvents:()=>this.purgeEvents(),
      purgeCancel:(ev)=>this.purgeCancel(ev),
      // alert rules (live settings)
      arRules, arActive:String(arActive), arSev, arArmed, arCool, alertMsg:st.alertMsg,
      arMasterToggle:()=>this.saveAlerts({email_enabled:!arMasterOn}),
      arMasterBg:arMasterOn?'var(--ok)':'var(--line2)', arMasterKnob:arMasterOn?'18px':'2px',
      arMailVal, onArMail:(e)=>this.setState({arMailDraft:(e&&e.target)?e.target.value:''}),
      applyArMail:()=>{ this.saveAlerts({mail_to:String(arMailVal).split(',').map(s=>s.trim()).filter(Boolean)}); this.setState({arMailDraft:null}); },
      testAlertEmail:()=>this.saveAlerts({}, {test:true}),
      arArmedDot:arArmedActive?'var(--crit)':'var(--text3)',
      arArmedState:arArmedActive?'● ARMED':'○ STANDBY',
      // settings page (live config)
      appMsg:st.appMsg,
      spTabs:[['sense','SenseTime API'],['api','Endpoints & Tokens'],['poc','POC Camera Points'],['att','Attendance Rules'],['ppe','PPE Area Rules'],['ra','Restricted Zones'],['fk','Forklift Zones'],['notify','Notifications'],['ai','AI Source'],['reports','Auto Reports'],['models','Models']].map(([k,label])=>{ const a=st.spTab===k;
        return {label, onClick:()=>this.setState({spTab:k}),
          cls:a?'chip on':'chip'}; }),
      spTabSense:st.spTab==='sense', spTabApi:st.spTab==='api', spTabNotify:st.spTab==='notify',
      spTabAi:st.spTab==='ai', spTabReports:st.spTab==='reports', spTabModels:st.spTab==='models',
      spTmforce:spV('email_tmforce'), onSpTmforce:spIn('email_tmforce'),
      spSoc:spV('email_soc'), onSpSoc:spIn('email_soc'),
      spSupervisor:spV('email_supervisor'), onSpSupervisor:spIn('email_supervisor'),
      spAdmin:spV('email_admin'), onSpAdmin:spIn('email_admin'),
      saveRouting:()=>this.saveApp({email_tmforce:spV('email_tmforce'), email_soc:spV('email_soc'),
        email_supervisor:spV('email_supervisor'), email_admin:spV('email_admin')}, 'Routing saved ✓'),
      spMatrix:[
        {k:'CRITICAL detection', v:'ERT + SOC + Admin + base recipients', col:'var(--crit)'},
        {k:'HIGH detection', v:'SOC + base recipients', col:'var(--high)'},
        {k:'MEDIUM detection', v:'Supervisor + base recipients', col:'var(--gold)'},
        {k:'LOW detection', v:'Dashboard only — emails only when the module is set to always-alert', col:'var(--low)'},
        {k:'Ticket · Inform ERT', v:'ERT + Admin (falls back to base recipients)', col:'var(--crit)'},
        {k:'Ticket · Send email', v:'SOC + Supervisor (falls back to base recipients)', col:'var(--low)'},
      ],
      spSenseBase:spV('sense_api_base'), onSpSenseBase:spIn('sense_api_base'),
      spSenseAcc:spV('sense_account'), onSpSenseAcc:spIn('sense_account'),
      spSensePass:ad.sense_password!=null?ad.sense_password:'', onSpSensePass:spIn('sense_password'),
      spImageBase:spV('image_base'), onSpImageBase:spIn('image_base'),
      spLiveBase:spV('live_stream_base'), onSpLiveBase:spIn('live_stream_base'),
      spLiveToken: ad.live_stream_token!=null?ad.live_stream_token:'', onSpLiveToken:spIn('live_stream_token'),
      liveStatus: spV('live_stream_base') ? 'configured' : 'not set — using frames',
      saveSense:()=>this.saveApp({sense_api_base:spV('sense_api_base'), sense_account:spV('sense_account'),
        sense_password:ad.sense_password||'', image_base:spV('image_base'),
        live_stream_base:spV('live_stream_base'), live_stream_token:ad.live_stream_token||''}),
      spFleetLine:(st.fleet&&st.fleet.length)?(st.fleet.filter(c=>c.online).length+'/'+st.fleet.length+' devices online'):'—',
      spPushUrl:spEp.push||'—', spEventsUrl:spEp.events||'—',
      spPushFaceUrl:spEp.push_face||'—', spPushBodyUrl:spEp.push_body||'—',
      regenIngest:()=>this.regenToken('ingest'), regenRead:()=>this.regenToken('read'),
      spAiChips, spIsAnthropic:spAiCur==='anthropic', spIsWeststar:spAiCur==='weststar',
      spAiBase:(ap&&ap.ai_base)||'',
      spAnthKey:ad.anthropic_key!=null?ad.anthropic_key:((ap&&ap.anthropic_key)||''), onSpAnthKey:spIn('anthropic_key'),
      spAnthModel:spV('anthropic_model')||'claude-opus-4-8', onSpAnthModel:spIn('anthropic_model'),
      saveAi:()=>this.saveApp({anthropic_key:(ad.anthropic_key&&!ad.anthropic_key.includes('•'))?ad.anthropic_key:'', anthropic_model:spV('anthropic_model')}),
      // ── Assistant LLM: one active provider, a key per provider ──
      llmRows:(()=>{
        const cur=spV('llm_provider')||'weststar';
        return [
          ['weststar','Weststar-AI Agent','agent_key','Bearer token — wsk_…','RAG over VisionAI docs + live detections'],
          ['anthropic','Anthropic (Claude)','anthropic_key','sk-ant-…','Direct API · live snapshot, no document search'],
          ['gemini','Google Gemini','gemini_key','AIza…','Direct API · live snapshot, no document search'],
          ['openai','ChatGPT (OpenAI)','openai_key','sk-…','Direct API · live snapshot, no document search'],
        ].map(([id,label,field,ph,note])=>{
          const on=cur===id;
          const val=ad[field]!=null?ad[field]:((ap&&ap[field])||'');
          return {id, label, note, on, off:!on,
            boxCls:on?'llm-box on':'llm-box', rowCls:on?'llm-row on':'llm-row',
            tick:on?'✓':'', placeholder:ph, value:val,
            hasKey:!!String(val||'').trim(),
            keyState:String(val||'').trim()?'KEY SET':'NO KEY',
            keyCol:String(val||'').trim()?'var(--ok)':'var(--text3)',
            onPick:()=>{ this.setDraft('llm_provider',id); this.saveApp({llm_provider:id}); },
            onKey:spIn(field)};
        });
      })(),
      saveLlm:()=>this.saveApp({
        llm_provider:spV('llm_provider')||'weststar',
        ...['agent_key','anthropic_key','gemini_key','openai_key'].reduce((o,f)=>{
          if(ad[f] && !ad[f].includes('•')) o[f]=ad[f]; return o; }, {}),
      }),
      spFreq, spHour, spRepTo,
      onSpRepTo:(e)=>this.setState({spRepDraft:(e&&e.target)?e.target.value:''}),
      applySpRepTo:()=>{ this.saveApp({report_recipients:spRepTo}); this.setState({spRepDraft:null}); },
      sendReportNow:()=>this.sendReportNow(),
      goRules:()=>this.setPage('rules'),
      // forecast page
      fcHas, fcEmpty:!fcHas, fcKpis, fcTrends, fcDaysTabs,
      fcStatus: st.fcBusy?'crunching collected data…':(fcHas?('window '+fa.days+' days · confidence: '+ff.confidence):''),
      fcAiHas:!!fcAi, fcAiSource:fcAi?(fcAi.source||''):'',
      fcAiSummary:fcAi?(fcAi.summary||''):'',
      fcAiRisks:fcAi?(fcAi.risks||[]).map(r=>({text:r})):[],
      fcAiHasRisks:!!(fcAi&&fcAi.risks&&fcAi.risks.length),
      fcAiRec:fcAi?(fcAi.recommendation||''):'', fcAiHasRec:!!(fcAi&&fcAi.recommendation),
      fcOutlook, fcOutlookCol: fcOutlook==='rising'?'var(--high)':(fcOutlook==='falling'?'var(--ok)':'var(--low)'),
      // demo mode
      demoOn:!!st.demo, toggleDemo:()=>this.toggleDemo(),
      demoLabel: st.demo?'Demo data (dummy)':'Live data',
      demoBtnLabel: st.demo?'Switch to live data':'Switch to demo data',
      demoTrackBg: st.demo?'var(--gold)':'var(--line2)', demoKnobX: st.demo?'20px':'2px',
      // incidents
      incStatusSel, incTypeSel, incSevSel, incElSel, incCamSel, incRepSel,
      incRows, incPager, incHead, incStats, incCount:incFiltered.length,
      incSizeTabs, incRangeLabel,
      incQVal:st.incQ, onIncQ:(e)=>this.setState({incQ:(e&&e.target)?e.target.value:'', incPage:0}),
      incSevChip, isMMetrics:mt==='metrics', mMetrics,
      repDaily:()=>this.repIncidents('daily'), repWeekly:()=>this.repIncidents('weekly'), repMonthly:()=>this.repIncidents('monthly'),
      // incident-ticket modal
      mTicket, tktTabs, tktMsg:st.tktMsg,
      tktIsComm:st.tktTab==='comm', tktIsEsc:st.tktTab==='esc', tktIsAtt:st.tktTab==='att',
      tktIsHist:st.tktTab==='hist', tktIsClose:st.tktTab==='close',
      tktIsNear:st.tktTab==='near', tktNearV, tktNearLoading, tktNearEmpty,
      tktComments, tktNoComments:tktComments.length===0,
      tktHistory, tktHistRows, tktHistPager, tktHistHead,
      tktHistQVal:st.tktHistQ, onTktHistQ:(e)=>this.setState({tktHistQ:(e&&e.target)?e.target.value:'', tktHistPage:0}),
      tktFiles:tktFilesV, tktNoFiles:tktFilesV.length===0,
      tktRemarks, tktMatrix, tktStageAck, tktStageRes, tktRemarkLen, tktFileSummary,
      tktNoteVal:st.tktNote, onTktNote:(e)=>this.setState({tktNote:(e&&e.target)?e.target.value:''}),
      tktAddComment:()=>{ if(!tk) return;
        const ed=document.getElementById('tkt-editor');
        const html=ed?ed.innerHTML:''; const plain=ed?(ed.textContent||'').trim():'';
        if(!plain) return;
        this.tktPost(tk.id,'log',{kind:'comment',note:html,actor:this.UNAME},'Comment added ✓');
        if(ed) ed.innerHTML=''; },
      tktEscUp:()=>{ if(mTicket) mTicket.escUp(); }, tktEscDown:()=>{ if(mTicket) mTicket.escDown(); },
      tktSendEmail:()=>{ if(tk) this.tktPost(tk.id,'notify',{channel:'email',note:st.tktNote,actor:this.UNAME},'Escalation email sent ✓'); },
      tktTmForce:()=>{ if(tk) this.tktPost(tk.id,'notify',{channel:'tmforce',note:st.tktNote,actor:this.UNAME},'Emergency Response Team informed'); },
      tktBrowse:()=>{ this.bindDrop(); const el=document.getElementById('tkt-file'); if(el) el.click(); },
      tktCloseTabs, tktCloseTypeLabel:st.tktCloseType,
      tktRemarkVal:st.tktRemark, onTktRemark:(e)=>this.setState({tktRemark:(e&&e.target)?e.target.value:''}),
      tktResolve:()=>{ if(tk&&st.tktRemark.trim()){
        this.tktPost(tk.id,'log',{kind:'remark',note:'['+st.tktCloseType+'] '+st.tktRemark,actor:this.UNAME},'Closed as '+st.tktCloseType+' ✓');
        this.setState({tktRemark:''}); } },
      // cameras
      camTabs, camAll:camFiltered, camStats, camCount:camFiltered.length,
      // analytics
      rangeTabs, aKpis, byType, byCam, donut, donutLegend, compTrend,
      // notifications (bell)
      notifOpen:st.notifOpen, toggleNotif:()=>this.toggleNotif(), markAllRead:()=>this.markAllRead(),
      notifItems, notifBadge:String(notifCount), notifBadgeBg:notifCount>0?'var(--crit)':'var(--brand)',
      mailLine, mailDot,
      // face & body report + find-people
      fbTotal:String(fbTotal), findGroups, findResults, findStatus,
      peopleRows, peopleMsg, peopleSummary, peopleHas:peopleRows.length>0, reloadPeople:()=>this.loadPeople(),
      peopleTabs, peopleEmpty, peopleHasEmpty:!!peopleEmpty,
      runFind:()=>this.runFind(), findHas:findResults.length>0,
    };
  }
}
