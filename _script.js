
const TID=/(?<![A-Za-z0-9])(CUSA|PPSA)(\d{5})(?!\d)/gi;
const CID=/([A-Z]{2}\d{4})-((?:CUSA|PPSA)\d{5})_(\d{2})-([A-Z0-9]{16})/i;
const CIDX=new RegExp('^'+CID.source+'$','i');
const APPV=/(?<![A-Za-z0-9])A(\d{2})(\d{2})(?!\d)/, VERR=/(?<![A-Za-z0-9])(?:v|ver\.?\s?)(\d{1,2}\.\d{2})(?!\d)/i;
const REG={UP:'US',EP:'EU',JP:'JP',HP:'Asia',KP:'Korea',IP:'Other',XP:'Other'};
const PKT={0x1A:'Base Game',0x1B:'DLC/Add-on',0x1C:'DLC/Add-on',0x1D:'Update'};
const HINTS=[[/(?<![a-z])(update|patch|upd)(?![a-z])/i,'Update'],[/(?<![a-z])(dlc|add-?on|season.?pass|expansion)(?![a-z])/i,'DLC/Add-on'],[/(?<![a-z])(base|game|app)(?![a-z])/i,'Base Game']];
const SITES={CUSA:['ORBISPatches','https://orbispatches.com/'],PPSA:['PROSPEROPatches','https://prosperopatches.com/']};
const EXT=/\.(pkg|zip|rar|7z|iso|bin|exfat)$/i;
const COLS=[['tid','Title ID'],['name','اسم بازی'],['region','ریجن'],['platform','پلتفرم'],['type','نوع'],['ver','نسخه آپدیت'],['upd','وضعیت آپدیت'],['parent','بازی مادر'],['site','منبع'],['status','وضعیت بررسی']];
const FA={auto_ok:'خودکار',needs_review:'نیاز به بررسی',confirmed:'تأیید شده'};
const $=id=>document.getElementById(id);
const CFG_DEFAULT={provider:'auto',autoSwitch:true,serperApiKey:'',googleApiKey:'',googleCx:''};
let CFG=Object.assign({},CFG_DEFAULT);
function loadCFG(){try{return Object.assign({},CFG_DEFAULT,JSON.parse(localStorage.getItem('psa-search-config')||'{}'))}catch(e){return Object.assign({},CFG_DEFAULT)}}
function saveCFG(){try{localStorage.setItem('psa-search-config',JSON.stringify(CFG))}catch(e){}}
function cfgSerperOk(){return !!String(CFG.serperApiKey||'').trim()}
function cfgGoogleOk(){return !!String(CFG.googleApiKey||'').trim() && !!String(CFG.googleCx||'').trim()}
function cfgReady(){return CFG.provider==='google' ? cfgGoogleOk() : (CFG.provider==='serper' ? cfgSerperOk() : (cfgSerperOk() || cfgGoogleOk()))}
function updateCfgBadge(){const providerLabel={serper:'Serper',google:'Google',auto:'خودکار'}[CFG.provider]||'خودکار';const parts=[`حالت: ${providerLabel}`];if(CFG.provider==='serper')parts.push(cfgSerperOk()?'Serper ذخیره شد':'Serper تنظیم نشده');if(CFG.provider==='google')parts.push(cfgGoogleOk()?'Google ذخیره شد':'Google تنظیم نشده');if(CFG.provider==='auto')parts.push(`Serper ${cfgSerperOk()?'✓':'✗'} · Google ${cfgGoogleOk()?'✓':'✗'}`);$('cfgst').textContent=parts.join(' · ')}
function syncCfgForm(){const modal=$('cfgModal');if(!modal)return;$('cfg-provider').value=CFG.provider;$('cfg-serper').value=CFG.serperApiKey||'';$('cfg-google').value=CFG.googleApiKey||'';$('cfg-cx').value=CFG.googleCx||'';$('cfg-autoswitch').checked=!!CFG.autoSwitch;updateCfgBadge()}
function readCfgForm(){CFG.provider=$('cfg-provider').value||'auto';CFG.serperApiKey=$('cfg-serper').value.trim();CFG.googleApiKey=$('cfg-google').value.trim();CFG.googleCx=$('cfg-cx').value.trim();CFG.autoSwitch=$('cfg-autoswitch').checked;saveCFG();syncCfgForm()}
function openCfgModal(){const m=$('cfgModal');if(!m)return;m.classList.add('show');m.setAttribute('aria-hidden','false');syncCfgForm();setTimeout(()=>{$('cfg-provider').focus()},0)}
function closeCfgModal(){const m=$('cfgModal');if(!m)return;m.classList.remove('show');m.setAttribute('aria-hidden','true')}
function ensureCfgPrompt(){if(!cfgReady())openCfgModal();}
function apiSearchQuery(tid){const site=tid.startsWith('CUSA')?'orbispatches.com':'prosperopatches.com';return `${tid} site:${site}`}
function extractNameFromSearchTitle(title, tid){let s=String(title||'').trim();if(!s)return'';if(tid&&s.toUpperCase().startsWith(tid.toUpperCase()))s=s.slice(tid.length).replace(/^[\s:\-–—|]+/,'');s=s.replace(/\s*[-|]\s*(ORBIS|PROSPERO)Patches.*$/i,'').replace(/\s*\|\s*.*$/,'');return s.trim()}
function normalizeSearchHit(hit, tid){const title=String(hit&&hit.title||'').trim();const link=String(hit&&hit.link||'').trim();const snippet=String(hit&&hit.snippet||'').trim();return {title,link,snippet,name:extractNameFromSearchTitle(title, tid)}}
function parseSerperResponse(data, tid){const items=Array.isArray(data&&data.organic)?data.organic:[];const hit=items.find(x=>x&&x.title&&x.link)||items[0];if(!hit)throw new Error('هیچ نتیجه‌ای از Serper برنگشت');return normalizeSearchHit(hit, tid)}
function parseGoogleResponse(data, tid){const items=Array.isArray(data&&data.items)?data.items:[];const hit=items.find(x=>x&&x.title&&x.link)||items[0];if(!hit)throw new Error('هیچ نتیجه‌ای از Google برنگشت');return normalizeSearchHit(hit, tid)}
function isQuotaError(text){return /quota|credit|limit|insufficient|balance|payment|402|403/i.test(String(text||''))}
async function serperLookup(tid){if(!cfgSerperOk())throw new Error('Serper API Key تنظیم نشده');const q=apiSearchQuery(tid);const resp=await fetch('https://google.serper.dev/search',{method:'POST',headers:{'Content-Type':'application/json','X-API-KEY':CFG.serperApiKey},body:JSON.stringify({q,hl:'en',gl:'us'})});const text=await resp.text();let data={};try{data=text?JSON.parse(text):{}}catch(e){data={raw:text}};if(!resp.ok)throw new Error(data.error?.message||data.message||text||`Serper HTTP ${resp.status}`);return parseSerperResponse(data, tid)}
async function googleLookup(tid){if(!cfgGoogleOk())throw new Error('Google API Key / cx تنظیم نشده');const q=apiSearchQuery(tid);const url='https://www.googleapis.com/customsearch/v1?'+new URLSearchParams({key:CFG.googleApiKey,cx:CFG.googleCx,q,num:'5'}).toString();const resp=await fetch(url);const text=await resp.text();let data={};try{data=text?JSON.parse(text):{}}catch(e){data={raw:text}};if(!resp.ok)throw new Error(data.error?.message||data.message||text||`Google HTTP ${resp.status}`);return parseGoogleResponse(data, tid)}
async function lookupTitleSmart(tid){const mode=CFG.provider||'auto';if(mode==='google')return await googleLookup(tid);if(mode==='serper'){
  try{return await serperLookup(tid)}catch(err){if(CFG.autoSwitch&&isQuotaError(err)&&cfgGoogleOk()){$('lkst').textContent='سهمیه Serper تمام شده؛ در حال استفاده از Google…';CFG.provider='google';saveCFG();syncCfgForm();return await googleLookup(tid)}throw err}
}
try{return await serperLookup(tid)}catch(err){if(CFG.autoSwitch&&isQuotaError(err)&&cfgGoogleOk()){CFG.provider='google';saveCFG();syncCfgForm();$('lkst').textContent='سهمیه Serper تمام شده؛ در حال استفاده از Google…';return await googleLookup(tid)}if(cfgGoogleOk())try{CFG.provider='google';saveCFG();syncCfgForm();$('lkst').textContent='Serper ناموفق بود؛ در حال استفاده از Google…';return await googleLookup(tid)}catch(err2){throw err2}throw err}}
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

let rows=[],sortK='tid',sortD=1,S={names:{},confirmed:{},edits:{}},L={},selectedRoot=null;
try{L=JSON.parse(localStorage.getItem('psa-l1')||'{}')}catch(e){}
const saveL=()=>{try{localStorage.setItem('psa-l1',JSON.stringify(L))}catch(e){}};
const inv=window.__TAURI__&&window.__TAURI__.core?window.__TAURI__.core.invoke:null;
if(inv)$('lk').hidden=false;
try{S=Object.assign(S,JSON.parse(localStorage.getItem('psa1')||'{}'))}catch(e){}
const save=()=>{try{localStorage.setItem('psa1',JSON.stringify(S))}catch(e){}};

async function classify(f){
  const path=f.relativePath||f.name,parts=path.replace(/\\/g,'/').split('/'),fname=f.name;
  const h={cid:f.cid||null,type:f.fileType||null},ids=new Set(),nameIds=new Set(),why=[];
  let cid=null,hint=null,ver=null,hTid=null;
  if(h.cid&&CIDX.test(h.cid)){cid=h.cid.toUpperCase();hTid=cid.match(CIDX)[2].toUpperCase();ids.add(hTid)}
  // The native scanner returns paths relative to the selected archive root,
  // so every component here is a real file/folder name and can be inspected.
  parts.slice().reverse().forEach(t=>{
    for(const m of t.matchAll(TID)){const id=(m[1]+m[2]).toUpperCase();nameIds.add(id);ids.add(id)}
    if(!cid){const m=t.match(CID);if(m)cid=m[0].toUpperCase()}
    if(!hint)for(const[rx,l]of HINTS){if(l==='Base Game'&&t!==fname)continue;if(rx.test(t)){hint=l;break}}
    if(!ver){let m=t.match(APPV);if(m)ver=m[1]+'.'+m[2];else if(m=t.match(VERR))ver=m[1]}
  });
  const idl=[...ids],tid=idl.length===1?idl[0]:null;
  if(!idl.length)why.push('Title ID پیدا نشد');
  else if(idl.length>1)why.push('چند Title ID: '+idl.join(', '));
  if(hTid&&nameIds.size&&!nameIds.has(hTid))why.push('Title ID هدر PKG با نام فایل فرق دارد');
  const type=h.type||hint||null;
  if(h.type&&hint&&h.type!==hint)why.push('تعارض نوع: هدر='+h.type+' / نام='+hint);
  if(!type)why.push('نوع محتوا نامشخص');
  if(type==='Update'&&!ver)why.push('نسخه آپدیت نامشخص');
  const site=tid?SITES[tid.slice(0,4)]:null;
  return{path,absolutePath:f.path,size:f.size,mtime:new Date(f.mtimeMs||0).toISOString().slice(0,10),
    tid,tids:idl,cid,region:cid?(REG[cid.slice(0,2)]||''):'',platform:tid?(tid[0]==='C'?'PS4':'PS5'):'',
    type,ver:type==='Update'?ver:null,site:site?site[0]:'',url:site?site[1]+tid:'',why,why0:why.slice(),status:'auto_ok'};
}

function post(){
  const bases=new Set(rows.filter(r=>r.type==='Base Game').map(r=>r.tid)),seen={};
  for(const r of rows){
    r.why=r.why0.slice();
    const e=S.edits[r.path];if(e){if(e.type)r.type=e.type;if('ver' in e)r.ver=e.ver||null}
    if(r.type==='Update'||r.type==='DLC/Add-on')if(!bases.has(r.tid))r.why.push('بازی اصلی در آرشیو نیست');
    const l=r.tid&&L[r.tid];
    if(l&&l.status!=='ok')r.why.push('بررسی آنلاین: '+l.status);
    if(r.type==='Update'&&r.ver&&l&&l.status==='ok'&&!latest(r))r.why.push('آخرین نسخه از سایت خوانده نشد');
    const k=[r.tid,r.type,r.ver].join('|');
    if(r.type){if(seen[k])r.why.push('احتمال تکراری: '+seen[k]);else seen[k]=r.path}
    r.status=S.confirmed[r.path]?'confirmed':(r.why.length?'needs_review':'auto_ok');
  }
}

const nm=r=>(r.tid&&(S.names[r.tid]||(L[r.tid]&&L[r.tid].status==='ok'&&L[r.tid].name)))||'';
const vk=v=>String(v||'').split('.').map(Number);
const cmp=(a,b)=>{const x=vk(a),y=vk(b);for(let i=0;i<Math.max(x.length,y.length);i++){const d=(x[i]||0)-(y[i]||0);if(d)return d}return 0};
const latest=r=>{const l=r.tid&&L[r.tid];if(!l||l.status!=='ok'||!l.versions||!l.versions.length)return null;return l.versions.reduce((a,b)=>cmp(a,b)>=0?a:b)};
const updText=r=>{if(r.type!=='Update'||!r.ver)return'';const lt=latest(r);if(!lt)return L[r.tid]?'نامشخص':'';return cmp(r.ver,lt)>=0?'آخرین نسخه':'نسخه جدیدتر: '+lt};
const isNewer=r=>updText(r).startsWith('نسخه جدیدتر');
const parent=r=>(r.type==='Update'||r.type==='DLC/Add-on')&&r.tid?((nm(r)||'؟')+' ['+r.tid+']'):'';

async function syncShortcutsFor(tids=null,force=false){
  if(!inv||!selectedRoot||(!$('mkshortcuts').checked&&!force))return;
  const allow=tids?new Set(tids):null;
  const items=rows.filter(r=>r.tid&&r.absolutePath&&nm(r)&&(!allow||allow.has(r.tid)))
    .map(r=>({sourcePath:r.absolutePath,relativePath:r.path,gameName:nm(r)}));
  if(!items.length)return;
  try{
    const rep=await inv('create_game_shortcuts',{root:selectedRoot,items});
    const parts=[];
    if(rep.created)parts.push(`${rep.created} شورتکات جدید`);
    if(rep.skipped)parts.push(`${rep.skipped} مورد از قبل موجود`);
    if(rep.errors&&rep.errors.length)parts.push(`${rep.errors.length} خطا`);
    $('sclst').textContent=(parts.join(' · ')||'شورتکات جدیدی لازم نبود')+' — '+rep.outputDir;
    if(rep.created||rep.skipped||(rep.errors&&rep.errors.length))$('open-shortcut-dir').disabled=false;
  }catch(err){$('sclst').textContent='خطا در ساخت شورتکات: '+String(err)}
}

async function scan(files){
  const list=[...files].filter(f=>EXT.test(f.name));
  rows=[];$('pg').hidden=false;$('pg').max=Math.max(list.length,1);
  for(let i=0;i<list.length;i++){
    rows.push(await classify(list[i]));
    if(i%25===0){$('pg').value=i;$('st').textContent=`در حال اسکن… ${i} / ${list.length}`;await new Promise(r=>setTimeout(r))}
  }
  $('pg').hidden=true;post();render();
  $('st').textContent=`اسکن کامل شد: ${rows.length} فایل`;$('exp').disabled=!rows.length;
  if($('mkshortcuts').checked)await syncShortcutsFor();
  if(inv&&$('auto').checked&&rows.length)runLookup();
}

function view(){
  const f=$('flt').value,q=$('q').value.trim().toLowerCase();
  let v=rows.filter(r=>{
    if(f==='needs_review'||f==='confirmed')if(r.status!==f)return false;
    if(f==='noname'&&(nm(r)||!r.tid))return false;
    if(f==='newer'&&!isNewer(r))return false;
    if(['Update','DLC/Add-on','Base Game'].includes(f)&&r.type!==f)return false;
    return !q||[r.tid,nm(r),r.path].join(' ').toLowerCase().includes(q);
  });
  const val=r=>sortK==='name'?nm(r):sortK==='parent'?parent(r):sortK==='upd'?updText(r):(r[sortK]??'');
  return v.sort((a,b)=>String(val(a)).localeCompare(String(val(b)),undefined,{numeric:true})*sortD);
}

function render(){
  $('hd').innerHTML=COLS.map(([k,t])=>`<th data-k="${k}">${t}${sortK===k?(sortD>0?' ▲':' ▼'):''}</th>`).join('');
  const v=view(),show=v.slice(0,1500);
  $('tb').innerHTML=show.map(r=>{
    const i=rows.indexOf(r);
    const sel=`<select data-f="type" data-i="${i}"><option value="">—</option>${['Base Game','Update','DLC/Add-on'].map(t=>`<option ${r.type===t?'selected':''}>${t}</option>`).join('')}</select>`;
    return`<tr class="${isNewer(r)?'newer':r.status}" title="${esc(r.path)}&#10;${r.mtime} · ${(r.size/1048576).toFixed(1)} MB">
<td><span class="ltr">${esc(r.tid||r.tids.join(', '))}</span><div class="why ltr">${esc(r.cid||'')}</div></td>
<td>${r.tid?`<input type="text" data-f="name" data-i="${i}" value="${esc(nm(r))}" placeholder="اسم بازی…">`:'—'}</td>
<td>${esc(r.region)}</td><td>${r.platform}</td><td>${sel}</td>
<td>${r.type==='Update'?`<input type="text" data-f="ver" data-i="${i}" value="${esc(r.ver||'')}" size="6">`:''}</td>
<td>${esc(updText(r))}</td>
<td>${esc(parent(r))}</td>
<td>${r.url?`<a href="${r.url}" target="_blank" rel="noopener noreferrer">${r.site} ↗</a>`:''}</td>
<td>${FA[r.status]}<br><button class="alt" data-f="ok" data-i="${i}">${r.status==='confirmed'?'لغو تأیید':'✔ تأیید'}</button>
<div class="why">${esc(r.why.join('؛ '))}</div><div class="why ltr">${esc(r.path)}</div></td></tr>`}).join('');
  const c=s=>rows.filter(r=>r.status===s).length;
  $('sum').textContent=rows.length?`کل: ${rows.length} | نیاز به بررسی: ${c('needs_review')} | آپدیت جدیدتر: ${rows.filter(isNewer).length} | تأیید شده: ${c('confirmed')}${v.length>1500?' | فقط ۱۵۰۰ ردیف اول نمایش داده شد':''}`:'';
}

async function chooseArchiveFolder(){
  if(!inv||!window.__TAURI__||!window.__TAURI__.dialog){$('st').textContent='انتخاب پوشه فقط در نسخه دسکتاپ فعال است';return}
  try{
    const root=await window.__TAURI__.dialog.open({directory:true,multiple:false,title:'انتخاب پوشه آرشیو PS4 / PS5'});
    if(!root)return;
    selectedRoot=root;
    $('open-shortcut-dir').disabled=true;
    $('st').textContent='در حال خواندن فهرست فایل‌ها…';
    const files=await inv('list_archive_files',{root:selectedRoot});
    await scan(files);
  }catch(err){$('st').textContent='خطا در خواندن پوشه: '+String(err)}
}
$('pick').onclick=chooseArchiveFolder;
$('flt').onchange=render;$('q').oninput=render;
$('hd').onclick=e=>{const k=e.target.dataset.k;if(!k)return;sortD=sortK===k?-sortD:1;sortK=k;render()};
$('tb').onchange=e=>{
  const t=e.target,r=rows[t.dataset.i],f=t.dataset.f;if(!r||!f)return;
  if(f==='name'){if(t.value.trim())S.names[r.tid]=t.value.trim();else delete S.names[r.tid];if(r.tid)syncShortcutsFor([r.tid])}
  else{const ed=S.edits[r.path]=S.edits[r.path]||{};ed[f]=t.value.trim()||null;if(f==='type')r.type=ed.type;if(f==='ver')r.ver=ed.ver}
  save();render();
};
$('tb').onclick=e=>{
  if(e.target.dataset.f!=='ok')return;
  const r=rows[e.target.dataset.i];
  if(S.confirmed[r.path]){delete S.confirmed[r.path];r.status=r.why.length?'needs_review':'auto_ok'}
  else{S.confirmed[r.path]=1;r.status='confirmed'}
  save();render();
};
$('exp').onclick=async()=>{
  const H=['title_id','name','region','platform','content_type','update_version','latest_version','update_status','parent_game','source_site','source_url','review_status','review_reasons','content_id','path','mtime'];
  const q=s=>'"'+String(s??'').replace(/"/g,'""')+'"';
  const csv='\ufeff'+[H.join(',')].concat(rows.map(r=>[r.tid||r.tids.join(' '),nm(r),r.region,r.platform,r.type,r.ver,latest(r),updText(r),parent(r),r.site,r.url,r.status,r.why.join('; '),r.cid,r.path,r.mtime].map(q).join(','))).join('\r\n');
  if(inv){try{const p=await inv('save_csv',{filename:'ps_archive_'+Date.now()+'.csv',contents:csv});$('st').textContent='ذخیره شد: '+p}catch(err){$('st').textContent='خطا در ذخیره: '+err}return}
  const blob=new Blob([csv],{type:'text/csv'});
  try{
    const d=window.claude&&claude.use?await claude.use('downloads'):null;
    if(d){await d.save({filename:'ps_archive.csv',data:blob});return}
  }catch(err){if(err&&err.code==='declined')return}
  const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='ps_archive.csv';a.click();
};

let running=false,stopReq=false;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function runLookup(){
  if(running)return;
  running=true;stopReq=false;$('lkgo').disabled=true;$('lkstop').disabled=false;
  const tids=[...new Set(rows.map(r=>r.tid).filter(Boolean))].filter(t=>!(L[t]&&L[t].status==='ok'));
  let msg='';
  if(!cfgReady())openCfgModal();
  for(let i=0;i<tids.length;i++){
    if(stopReq){msg='متوقف شد';break}
    const t=tids[i];$('lkst').textContent=`بررسی ${i+1} / ${tids.length}: ${t}`;
    try{
      const rep=await lookupTitleSmart(t);
      L[t]=Object.assign({status:'ok',versions:[]},rep,{at:Date.now()})
    }catch(e){
      const text=String(e?.message||e||'');
      L[t]={status: isQuotaError(text)?'quota_exhausted':'error', debug:text, at:Date.now()};
      if(L[t].status==='quota_exhausted'&&!cfgGoogleOk()){
        $('lkst').textContent='سهمیه API تمام شد؛ تنظیمات Google را وارد کنید.';
        openCfgModal();
      }
    }
    saveL();
    post();render();dbgFill();
    if(L[t].status==='ok'&&L[t].name)await syncShortcutsFor([t]);
    await sleep(250);
  }
  running=false;$('lkgo').disabled=false;$('lkstop').disabled=true;
  $('lkst').textContent=msg||'بررسی آنلاین کامل شد';
}
function dbgFill(){
  const bad=Object.entries(L).filter(([k,v])=>v.status!=='ok'&&v.debug).slice(0,3).map(([k,v])=>({tid:k,status:v.status,debug:v.debug}));
  $('dbg').hidden=!bad.length;$('dbgt').value=JSON.stringify(bad,null,1);
}
$('lkgo').onclick=runLookup;$('lkstop').onclick=()=>{stopReq=true};
$('mkshortcuts-now').onclick=()=>syncShortcutsFor(null,true);
$('mkshortcuts').onchange=()=>{if($('mkshortcuts').checked)syncShortcutsFor()};
$('open-shortcut-dir').onclick=()=>{if(inv&&selectedRoot)inv('open_shortcuts_folder',{root:selectedRoot}).catch(err=>$('sclst').textContent='خطا در باز کردن پوشه: '+String(err))};
$('search-settings').onclick=openCfgModal;
$('cfg-save').onclick=()=>{readCfgForm();closeCfgModal();$('st').textContent='تنظیمات ذخیره شد'};
$('cfg-cancel').onclick=()=>closeCfgModal();
$('cfgModal').addEventListener('click',e=>{if(e.target.id==='cfgModal')closeCfgModal()});
['cfg-provider','cfg-serper','cfg-google','cfg-cx','cfg-autoswitch'].forEach(id=>{$(id).addEventListener('input',()=>{readCfgForm();updateCfgBadge()})});
document.addEventListener('click',e=>{
  const a=e.target.closest&&e.target.closest('a[target=_blank]');
  if(a&&inv){e.preventDefault();inv('open_url',{url:a.href}).catch(()=>{})}
});
CFG=loadCFG();syncCfgForm();ensureCfgPrompt();render();dbgFill();
