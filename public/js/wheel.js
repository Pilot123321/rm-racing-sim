(function(){
'use strict';
const $=id=>document.getElementById(id), clamp=(x,a,b)=>x<a?a:x>b?b:x;
const angd=(a,b)=>{let d=a-b;while(d>180)d-=360;while(d<-180)d+=360;return d;};
const iOS=/iP(hone|ad|od)/.test(navigator.userAgent)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);
let lockSaved=45,invSaved=false,ffbSaved=true;try{lockSaved=+localStorage.getItem('rw.lock')||45;invSaved=localStorage.getItem('rw.inv3')==='1';ffbSaved=localStorage.getItem('rw.ffb')!=='0';}catch(e){}
// each phone (tab) has its own id, so the game knows which wheel left
// pairing key from the QR code / link (kept for this tab, so a reload without it still works)
let PAIR=new URLSearchParams(location.search).get('k')||'';try{if(PAIR)sessionStorage.setItem('rw.k',PAIR);else PAIR=sessionStorage.getItem('rw.k')||'';}catch(e){}
let PID='';try{PID=sessionStorage.getItem('rw.id')||'';}catch(e){}
if(!PID){PID=Math.random().toString(36).slice(2,10);try{sessionStorage.setItem('rw.id',PID);}catch(e){}}
const S={gas:0,brake:0,steer:0,angle:0,neutral:null,gx:0,gy:0,hasMotion:false,quarter:null,trim:0,farSince:0,lock:lockSaved,inv:invSaved,ffb:ffbSaved,touchSteer:null,games:0,running:false,alert:0};

// ---- connection
let ws=null;
// On the website the relay runs on several server instances and (without Redis) only relays within one; if this
// phone lands on another instance than the game it sees no game. It then reconnects after a moment, which soon
// lands it next to the game. The local server (a port in the address, or a LAN/loopback host) is one process.
const CLOUD=location.port===''&&!/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[)/.test(location.hostname);
let lonely=0;
function connect(){
  ws=new WebSocket((location.protocol==='https:'?'wss://':'ws://')+location.host+'/ws?role=wheel&id='+PID+'&k='+encodeURIComponent(PAIR));
  ws.onopen=()=>{resetWorld();S.unpaired=false;status();hello();};
  ws.onmessage=e=>{if(typeof e.data!=='string')return;let m;try{m=JSON.parse(e.data);}catch(_){return;}
    if(m.t==='track'){onTrack(m);return;} if(m.t==='w'){onState(m);return;}
    // reset only when the game is gone (a reload): a second sim tab joining the room must not take over
    if(m.t==='games'){if(!m.n)resetWorld();S.games=m.n;status();hello();
      clearTimeout(lonely);if(CLOUD&&!m.n)lonely=setTimeout(()=>{if(ws&&ws.readyState===1&&!S.games)ws.close(4000,'find the game');},2000+Math.random()*1500);}
    else if(m.t==='st'){S.running=m.r;S.ap=!!m.ap;S.wh=m.wh||0;$('bRun').textContent=m.r?'Stop':'Start';
      if(m.a===2&&S.alert!==2&&navigator.vibrate){navigator.vibrate([90,60,90]);FFB.hold=performance.now()+260;}
      if(m.w&&!S.wall&&!S.ffb&&navigator.vibrate)navigator.vibrate(40);S.wall=m.w;
      // hysteresis: red holds for 0.8 s so the glow does not flicker around the threshold
      const nowT=performance.now();if(m.a===2)S.redUntil=nowT+800;const lvl=m.a===2||nowT<(S.redUntil||0)?2:m.a;
      if(lvl!==S.shownLvl){S.shownLvl=lvl;const g=$('glow');g.style.setProperty('--gc',lvl===2?'var(--brake)':'var(--amb)');g.style.opacity=lvl?(lvl===2?0.9:0.45):0;}
      S.alert=m.a;}};
  ws.onclose=e=>{S.games=0;S.unpaired=e.code===4001;resetWorld();status();setTimeout(connect,S.unpaired?5000:1000);};
  ws.onerror=()=>{};
}
let sent=0;
function hello(){send({t:'hello',w:innerWidth,h:innerHeight,dpr:devicePixelRatio||1});}
addEventListener('resize',()=>setTimeout(hello,200));
function status(){const open=ws&&ws.readyState===1,ok=open&&S.games>0;$('dot').classList.toggle('ok',ok);
  $('conn').textContent=S.unpaired?'Not paired: scan the QR code on the computer again':!open?'Cannot reach '+location.host:!S.games?'Server OK, open the game on the computer':`Linked · Wheel · HUD ${fps} fps`;
  $('hudwait').hidden=!!(trackOk&&W);
  if(open&&S.games&&!trackOk)$('hudwait').textContent='Linked, waiting for the track. Reload the game page on the computer.';
  if(!HUD)$('hudwait').textContent='Could not load the HUD code. Reload this page.';}
setInterval(status,500);
// ---- native HUD: same drawing code as the game, fed by track + state messages
const HUD=window.makeHUD?window.makeHUD():null;if(HUD)HUD.setCalm(true);
const cv=$('hudcv'), cx=cv.getContext('2d');
let frames=0,fps=0,msgs=0,W=null,Wt=0,trackOk=false;setInterval(()=>{fps=frames;frames=0;},1000);
function fitCanvas(){const d=Math.min(devicePixelRatio||1,1.5);   // 1.5x is sharp enough and much cheaper to fill every frame
  cv.width=Math.round(innerWidth*d);cv.height=Math.round(innerHeight*d);}
addEventListener('resize',fitCanvas);fitCanvas();
let trackSource=null,trackRevision=null,worldRevision=null;
function resetWorld(){SNAP.length=0;OFFS.length=0;clockOff=null;W=null;trackOk=false;trackSource=null;trackRevision=null;worldRevision=null;}
// One game at a time: if two sim tabs share the room (e.g. an old tab left open), the phone keeps following the one
// it is on and only switches when that one has been silent for 1.5 s. Mixing them put another race's cars and
// camera on the HUD.
let srcSeen=0,srcAsk=0;
function onTrack(t){if(!HUD)return;
  if(trackOk&&t.src!==trackSource&&performance.now()-srcSeen<1500)return;
  if(!trackOk||t.src!==trackSource||t.trackRev!==trackRevision){SNAP.length=0;OFFS.length=0;clockOff=null;W=null;worldRevision=null;}
  HUD.setTrack(t);trackSource=t.src;trackRevision=t.trackRev;trackOk=true;}
const SNAP=[],OFFS=[];let clockOff=null;
function onState(m){
  if(trackOk&&m.src!==trackSource){const now=performance.now();if(now-srcSeen>1500&&now-srcAsk>1000){srcAsk=now;hello();}return;}   // ask the other game for its track
  if(!trackOk||m.trackRev!==trackRevision)return;
  srcSeen=performance.now();
  if(worldRevision!==m.worldRev){SNAP.length=0;worldRevision=m.worldRev;}
  if(SNAP.length&&m.tw!=null&&m.tw/1000<SNAP[SNAP.length-1].tm){SNAP.length=0;OFFS.length=0;clockOff=null;}
  msgs++;const hz=m.hz.map(h=>({type:h[0],s:h[1],lat:h[2],yaw:h[3],halfLen:h[4],halfW:h[5],vis:!!h[6],gone:!!h[7],avoid:h[8],vpass:h[9],label:h[10]}));
  const p=m.p,rd=m.rd;let radar=null;
  if(rd){const dets=[],tracks=[];for(let i=0;i<rd.d.length;i+=3)dets.push({x:rd.d[i],z:rd.d[i+1],st:!!rd.d[i+2]});
    for(let i=0;i<rd.k.length;i+=3)tracks.push({x:rd.k[i],z:rd.k[i+1],conf:true,barrier:false,obj:!!rd.k[i+2]});radar={ox:rd.o[0],oz:rd.o[1],rng:rd.g,att:rd.a,dets,tracks};}
  if(m.ffb){FFB.v=m.ffb;FFB.t=performance.now();}
  // impacts arrive numbered, so a short knock is never lost between packets: play each new one once
  if(m.hk){if(FFB.hitN==null)FFB.hitN=m.hk[0];else if(m.hk[0]!==FFB.hitN){FFB.hitN=m.hk[0];crashBuzz(m.hk[1]);}}if(m.scr)S.scr=m.scr;
  const behind=m.bh?{d:m.bh[0],side:m.bh[1],cl:m.bh[2]}:null;
  if(behind&&!S.behind&&S.running&&navigator.vibrate){navigator.vibrate([30,70,30]);FFB.hold=performance.now()+160;}S.behind=behind;rearGlow($('rearfx'),REAR,S.running?behind:null);
  W={tc:m.tc||null,player:{s:p[0],lat:p[1],psi:p[2],latV:p[3],slideV:p[4],v:p[5],vx:m.dr?p[6]:null,lapc:p[7]||0,brk:p[8]||0,thr:p[9]||0,gear:p[10]>=0?p[10]:p[10]===-2?0:null,rev:p[10]===-2,rpm:p[11]||0,beta:p[12]||0,steer:p[13]||0},radar,behind,mk:m.mk||null,mx:m.mx||null,scr:m.scr||null,fov:m.fov||60,cm:m.cm||null,spray:m.sp||0,flags:m.fg?Uint8Array.from(m.fg.slice(1)):null,secLen:m.fg?m.fg[0]:0,
    traffic:m.tr.map(c=>({s:c[0],lat:c[1],latV:c[2],v:c[3],vis:!!c[4],closing:!!c[5],lapc:c[6]||0})),hazards:hz,alert:m.a,near:m.ni>=0?hz[m.ni]:null,dNear:m.dn,
    vis:m.vis,flagOn:!!m.fo,sc:{flag:m.fl||null},opts:{driver:m.dr?'drive':'model',hud:m.hd!==0},t:m.tm};
  Wt=performance.now();if(HUD)HUD.NAV.zoom=m.z||1;
  // sync on real time, not the game's sim clock (that runs slow whenever a frame is slow, which made the phone drift
  // against the monitor). The game stamps each update with its wall clock; the smallest arrival delay seen over the
  // last few seconds gives the offset between the two clocks without network jitter.
  const tk=m.tw!=null?m.tw/1000:m.tm;OFFS.push(Wt/1000-tk);while(OFFS.length>150)OFFS.shift();clockOff=Math.min(...OFFS);
  SNAP.push({tm:tk,w:W,fc:m.fc==null?null:m.fc});while(SNAP.length>90)SNAP.shift();}
function sampleWorld(now){
  // shown 60 ms behind the latest update, so there is always a pair to interpolate between
  if(!SNAP.length||clockOff==null)return W;const rt=now/1000-clockOff-0.06,L=HUD.wrapS,dS=HUD.dSigned;
  let i=SNAP.length-1;while(i>0&&SNAP[i-1].tm>rt)i--;
  const B=SNAP[i],A=i>0?SNAP[i-1]:null;
  if(!A||rt>=B.tm){const e=Math.min(0.15,Math.max(0,rt-B.tm)),P=B.w.player;
    return Object.assign({},B.w,{player:Object.assign({},P,{s:L(P.s+P.v*e),lat:P.lat+(P.latV||0)*e}),traffic:B.w.traffic.map(c=>Object.assign({},c,{s:L(c.s+c.v*e)})),dNear:B.w.dNear-P.v*e});}
  if(rt<=A.tm)return A.w;
  if(JSON.stringify(A.w.scr)!==JSON.stringify(B.w.scr)||JSON.stringify(A.w.mk)!==JSON.stringify(B.w.mk))return A.w;
  const k=(rt-A.tm)/Math.max(1e-3,B.tm-A.tm),lp=(a,b)=>a+(b-a)*k,ls=(a,b)=>L(a+dS(a,b)*k);
  const pa=A.w.player,pb=B.w.player;
  return Object.assign({},B.w,{
    player:Object.assign({},pb,{s:ls(pa.s,pb.s),lat:lp(pa.lat,pb.lat),psi:lp(pa.psi||0,pb.psi||0),v:lp(pa.v,pb.v),latV:lp(pa.latV||0,pb.latV||0)}),
    traffic:B.w.traffic.map((c,j)=>{const ca=A.w.traffic[j];return ca?Object.assign({},c,{s:ls(ca.s,c.s),lat:lp(ca.lat,c.lat),v:lp(ca.v,c.v)}):c;}),
    hazards:B.w.hazards.map((h,j)=>{const ha=A.w.hazards[j];return ha?Object.assign({},h,{lat:lp(ha.lat,h.lat)}):h;}),
    cm:A.w.cm&&B.w.cm?(()=>{const a=A.w.cm,b=B.w.cm,d=a[3]*b[3]+a[4]*b[4]+a[5]*b[5]+a[6]*b[6]>=0?1:-1,q=[3,4,5,6].map(i=>a[i]+(b[i]*d-a[i])*k),n=Math.hypot(...q)||1;
      return [lp(a[0],b[0]),lp(a[1],b[1]),lp(a[2],b[2]),...q.map(v=>v/n)];})():B.w.cm,
    dNear:lp(A.w.dNear,B.w.dNear)});}
function drawHud(now){
  cx.setTransform(1,0,0,1,0,0);cx.fillStyle='#000';cx.fillRect(0,0,cv.width,cv.height);
  if(!HUD||!trackOk||!W)return;
  const dt=Math.min(0.1,(now-(drawHud.last||now))/1000);drawHud.last=now;
  // smooth playback: interpolate between buffered updates instead of snapping to each one
  const view=sampleWorld(now);
  if(view.hazards&&view.near)view.near=view.hazards[view.hazards.indexOf(view.near)]||view.near;
  HUD.setWorld(view);window.__view=view;   // for debugging from the browser console
  const H=cv.height,Wd=cv.width;
  // the game screen's HUD layout (same camera, same positions), scaled to fit; no 3D picture behind it
  const gw=S.scr?S.scr[0]:1280,gh=S.scr?S.scr[1]:720,k=Math.min(Wd/gw,H/gh),ox=(Wd-gw*k)/2,oy=(H-gh*k)/2;
  cx.setTransform(k,0,0,k,ox,oy);HUD.setSize(gw,gh);HUD.drawScreen(cx,view,now/1000,dt);
  cx.setTransform(1,0,0,1,0,0);cx.strokeStyle='rgba(196,248,255,.18)';cx.lineWidth=1;cx.strokeRect(ox+0.5,oy+0.5,gw*k-1,gh*k-1);
  frames++;
}
function send(o){if(ws&&ws.readyState===1){ws.send(typeof o==='string'?o:JSON.stringify(Object.assign({id:PID},o)));sent++;}}

const REAR={k:'',was:false};
/* ================= REAR GLOW (shared by the game page and the phone) ================= */
function rearGlow(el,st,b){
  let l=0,r=0,bt=0,col='196 248 255',closing=false;
  if(b){const k=clamp((52-b.d)/40,0.35,1),cl=b.cl*3.6;col=b.d<12&&cl>5?'255 75 58':(cl>8||b.d<20)?'255 194 71':'196 248 255';
    if(b.side<0)l=k;else if(b.side>0)r=k;else{bt=k;l=r=k*0.3;}closing=cl>8;}
  const key=[l,r,bt].map(v=>v.toFixed(2)).join()+col+closing;
  el.classList.toggle('on',!!b);
  if(key!==st.k){st.k=key;el.style.setProperty('--l',l);el.style.setProperty('--r',r);el.style.setProperty('--b',bt);el.style.setProperty('--rc',col);el.classList.toggle('closing',closing);}
  if(b&&!st.was){el.classList.remove('arrive');void el.offsetWidth;el.classList.add('arrive');}
  st.was=!!b;}

// ---- steering from gravity: the angle of "up" in the phone's screen plane
function onMotion(e){
  const a=e.accelerationIncludingGravity;if(!a||a.x==null)return;
  let ax=a.x,ay=a.y,az=a.z||0;if(iOS){ax=-ax;ay=-ay;az=-az;}

  S.gx+=(ax-S.gx)*0.35;S.gy+=(ay-S.gy)*0.35;
  if(Math.hypot(S.gx,S.gy)<2.5)return;           // phone lying flat: hold last angle
  S.hasMotion=true;
  const ang=Math.atan2(S.gx,S.gy)*180/Math.PI;
  // Straight ahead = the phone held level in the way the screen is shown: gravity angle = screen rotation. The
  // quarter-turn offset absorbs axis-sign differences between browsers (iOS vs Android) and a locked rotation, and
  // the trim is the user's own "centre" (small). Taking the first reading as centre broke on iPhones: it was often
  // taken while the phone was still upright, so every tilt landed near +-90..180 degrees (full lock, reversed).
  if(S.quarter==null)recenter();
  let d=angd(ang,screenRot()+S.quarter+S.trim);
  // held far past full lock for a while: the reference is a quarter turn off (e.g. the page did not rotate); re-take it
  if(Math.abs(d)>80){if(!S.farSince)S.farSince=performance.now();else if(performance.now()-S.farSince>1200){recenter();d=0;}}else S.farSince=0;
  // Turning the phone clockwise (to the right, as seen by the driver) turns "up" the other way in the phone's own
  // frame, so the gravity angle decreases: negate to make a right turn positive, as the game expects.
  d=-d;
  if(S.inv)d=-d;
  S.angle=d;
}
function screenRot(){const o=screen.orientation&&screen.orientation.angle!=null?screen.orientation.angle:(window.orientation||0);return +o||0;}
function recenter(){S.farSince=0;
  if(S.hasMotion){const ang=Math.atan2(S.gx,S.gy)*180/Math.PI,base=screenRot();let best=0;
    for(const q of [0,90,180,270])if(Math.abs(angd(ang,base+q))<Math.abs(angd(ang,base+best)))best=q;
    S.quarter=best;S.trim=clamp(angd(ang,base+best),-30,30);}
  S.touchSteer=S.touchSteer==null?null:0;}
addEventListener('orientationchange',()=>{S.trim=0;});

// ---- pedals (multi-touch)
function pedal(el,key){
  const on=v=>{S[key]=v;el.classList.toggle('on',!!v);if(v&&navigator.vibrate)navigator.vibrate(12);};
  el.addEventListener('pointerdown',e=>{e.preventDefault();el.setPointerCapture(e.pointerId);on(1);});
  for(const ev of ['pointerup','pointercancel','lostpointercapture'])el.addEventListener(ev,()=>on(0));
}
// gas and brake: vertical slides for fine control. The thumb's height in the strip sets the pedal (a dead band at
// the bottom 10 %, full at 10 % + travel), and it springs back to 0 when the thumb lifts, like a pedal. The gas
// has a long travel for fine throttle; the brake a short one (full braking at ~47 % of the height), easy to reach and
// stamp on. A short buzz marks each quarter so it can be felt without looking.
function slide(el,key,travel){const pct=el.querySelector?el.querySelector('b'):null;
  if(el.style&&el.style.setProperty)el.style.setProperty('--tr',travel*100+'%');
  if(el.appendChild&&document.createElement)for(let k=1;k<=4;k++){const t=document.createElement('i');t.className='tick'+(k===4?' full':'');
    if(t.style)t.style.bottom=(10+travel*100*k/4)+'%';el.appendChild(t);}
  const set=v=>{S[key]=Math.round(v*100)/100;el.style.setProperty('--g',S[key]);el.classList.toggle('on',S[key]>0);el.setAttribute('aria-valuenow',Math.round(S[key]*100));
    if(pct)pct.textContent=S[key]>0?Math.round(S[key]*100)+'%':'';};
  const at=e=>{const r=el.getBoundingClientRect(),f=(r.bottom-e.clientY)/r.height;return clamp((f-0.1)/travel,0,1);};
  let id=null;
  el.addEventListener('pointerdown',e=>{e.preventDefault();el.setPointerCapture(e.pointerId);id=e.pointerId;set(at(e));if(navigator.vibrate)navigator.vibrate(12);});
  el.addEventListener('pointermove',e=>{if(e.pointerId!==id)return;const v=at(e);if(navigator.vibrate&&Math.floor(v*4.001)!==Math.floor(S[key]*4.001))navigator.vibrate(6);set(v);});
  for(const ev of ['pointerup','pointercancel','lostpointercapture'])el.addEventListener(ev,e=>{if(e.pointerId===id){id=null;set(0);}});}
slide($('gas'),'gas',0.75);slide($('brake'),'brake',0.368);

// ---- touch steering fallback: drag sideways on the wheel
const wb=document.body;let dragX=null;
wb.addEventListener('pointerdown',e=>{if(S.hasMotion||e.target.closest('.pedal,.bar,.sheet'))return;dragX=e.clientX;wb.setPointerCapture(e.pointerId);S.touchSteer=0;});
wb.addEventListener('pointermove',e=>{if(dragX==null)return;S.touchSteer=clamp((e.clientX-dragX)/(innerWidth*0.25),-1,1);});
for(const ev of ['pointerup','pointercancel'])wb.addEventListener(ev,()=>{dragX=null;S.touchSteer=0;});

// ---- buttons
$('bRun').onclick=()=>send({t:'cmd',c:S.running?'stop':'start'});
$('bDrop').onclick=()=>send({t:'cmd',c:'drop'});
$('bCam').onclick=()=>send({t:'cmd',c:'cam'});
$('bSetup').onclick=()=>{const open=$('bLock').hidden;document.querySelectorAll('.more').forEach(b=>b.hidden=!open);$('bSetup').setAttribute('aria-pressed',open?'true':'false');};
// Calibrate: the way the phone is held now is straight ahead (steering centre)
function calibrate(){recenter();recFlash('Centred');}
$('bCal').onclick=calibrate;
function syncOpts(){$('bLock').textContent='Lock '+S.lock+'°';$('bInv').setAttribute('aria-pressed',S.inv?'true':'false');$('bFfb').setAttribute('aria-pressed',S.ffb?'true':'false');
  try{localStorage.setItem('rw.lock',S.lock);localStorage.setItem('rw.inv3',S.inv?'1':'0');localStorage.setItem('rw.ffb',S.ffb?'1':'0');}catch(e){}}
$('bLock').onclick=()=>{S.lock=S.lock===30?45:S.lock===45?70:30;syncOpts();};
$('bFfb').onclick=()=>{S.ffb=!S.ffb;if(!S.ffb&&navigator.vibrate)navigator.vibrate(0);syncOpts();};
window.__wheel={get src(){return trackSource;},get trackOk(){return trackOk;},get seenAgo(){return Math.round(performance.now()-srcSeen);},get snaps(){return SNAP.length;},get games(){return S.games;}};
function recFlash(text){const el=$('recenter');el.textContent=text||'Centred';el.classList.remove('show');void el.offsetWidth;el.classList.add('show');}
// ---- force feedback from the tyres. A phone motor is only on or off, so each channel is a rhythm and its
// strength a duty cycle inside each 60 ms window, highest priority first:
//   impact: one long pulse · lock-up: fast ABS-like chatter · kerb: stripe-rate pulses · wheelspin / rear slide:
//   a long buzz · front scrub (understeer, past the tyre peak): a stutter · steering weight (self-aligning torque):
//   a faint hum that fades as the front goes light before it lets go · aquaplaning: the hum drops out entirely.
const FFB={v:[0,0,0,0,0,0,0,0,0],t:0,hold:0,lastHit:0,buzz:false,tick:0,hitN:null};
// an impact: a scrape is a short tap, a hard hit a strong jolt with a rebound, a crash a long hit followed by
// the aftershocks of the car coming to rest. Length and pattern scale with the severity (0..1).
function crashBuzz(sev){if(!S.ffb||!navigator.vibrate)return;let pat;
  if(sev<0.2)pat=[Math.round(30+120*sev)];
  else if(sev<0.6)pat=[Math.round(90+220*sev),45,Math.round(40+80*sev)];
  else pat=[Math.round(260+240*sev),70,Math.round(140+80*sev),60,90,60,50];
  navigator.vibrate(pat);FFB.buzz=true;FFB.lastHit=performance.now();FFB.hold=FFB.lastHit+pat.reduce((a,b)=>a+b,0);}
setInterval(()=>{if(!S.ffb||!navigator.vibrate)return;const now=performance.now();if(now<FFB.hold)return;FFB.tick++;
  const [kerb,hit,weight,scrub,slide,lock,spin,spray,aqua]=now-FFB.t<300&&S.running?FFB.v:[0,0,0,0,0,0,0,0,0];let pat=null;
  if(hit>0.5&&now-FFB.lastHit>300){pat=[110];FFB.lastHit=now;FFB.hold=now+110;}
  else if(lock>0.1)pat=[7,9,7,9,7];
  else if(kerb>0.05){const on=Math.round(7+9*kerb);pat=[on,Math.max(6,20-on),on];}
  else if(Math.max(spin,slide)>0.1)pat=[Math.round(16+38*Math.max(spin,slide))];
  else if(scrub>0.1)pat=[Math.round(8+14*scrub),14,Math.round(8+14*scrub)];
  else{const hum=weight*(1-Math.min(1,aqua*1.5))*0.5+spray*0.2;if(hum>=0.08&&FFB.tick%2===0)pat=[Math.round(5+22*Math.min(1,hum))];}
  if(pat){navigator.vibrate(pat);FFB.buzz=true;}else if(FFB.buzz){navigator.vibrate(0);FFB.buzz=false;}},60);
$('bInv').onclick=()=>{S.inv=!S.inv;syncOpts();};syncOpts();
document.addEventListener('contextmenu',e=>e.preventDefault());

// ---- start: permissions, fullscreen, landscape, keep screen awake
let wake=null;
async function keepAwake(){try{wake=await navigator.wakeLock.request('screen');}catch(e){}}
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'){keepAwake();if(!ws||ws.readyState>1)connect();}});
$('go').onclick=async()=>{
  try{if(typeof DeviceOrientationEvent!=='undefined'&&DeviceOrientationEvent.requestPermission)await DeviceOrientationEvent.requestPermission();}catch(e){}
  try{if(typeof DeviceMotionEvent!=='undefined'&&DeviceMotionEvent.requestPermission){const r=await DeviceMotionEvent.requestPermission();if(r!=='granted')throw new Error('denied');}}catch(e){$('sheetMsg').textContent='Motion access was refused. Drag on the wheel to steer instead.';}
  if(!window.isSecureContext){$('sheetMsg').className='warn';$('sheetMsg').textContent='This page is not a secure connection, so the gyro is off. Use the https:// address or the USB address from the computer.';}
  window.addEventListener('devicemotion',onMotion);
  try{await document.documentElement.requestFullscreen({navigationUI:'hide'});}catch(e){}
  try{await screen.orientation.lock('landscape');}catch(e){}
  keepAwake();
  $('sheet').hidden=true;
  setTimeout(()=>{if(!S.hasMotion){$('conn').textContent='No gyro: drag the wheel';}},1800);
};

// ---- send loop + wheel drawing
let last='',lastT=0;
function loop(now){
  requestAnimationFrame(loop);
  drawHud(now);
  const deg=S.hasMotion?S.angle:(S.touchSteer||0)*S.lock;
  const s=S.steer;
  $('ang').textContent=`${deg>0?'R':deg<0?'L':''} ${Math.abs(Math.round(deg))}°`;
}
function curDeg(){return S.hasMotion?S.angle:(S.touchSteer||0)*S.lock;}
setInterval(()=>{const deg=curDeg();let s=clamp(deg/S.lock,-1,1);if(Math.abs(deg)<1.5)s=0;S.steer=s;
  const now=performance.now(),msg=JSON.stringify({t:'in',id:PID,s:+s.toFixed(3),a:+curDeg().toFixed(1),g:S.gas,b:S.brake});
  if(msg!==last||now-lastT>100){send(msg);last=msg;lastT=now;}},25);
connect();requestAnimationFrame(loop);
})();
