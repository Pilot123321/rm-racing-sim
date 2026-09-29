(function(){
'use strict';
const $=id=>document.getElementById(id);
if(typeof THREE==='undefined'){ $('stage').insertAdjacentHTML('beforeend','<div class="noscript">The 3D view needs three.js from cdnjs, which did not load.</div>'); return; }
/* Fog renders physically: contrast falls as Beer-Lambert exp(-beta d) (light scattered out of the ray by droplets),
   with fog.far as the meteorological optical range, where a dark object's contrast is down to 5 % (beta = 3/far). */
if(typeof THREE!=='undefined')THREE.ShaderChunk.fog_fragment=THREE.ShaderChunk.fog_fragment.replace('float fogFactor = smoothstep( fogNear, fogFar, fogDepth );',
  'float fogFactor = 1.0 - exp( -3.0 * max( fogDepth - fogNear, 0.0 ) / max( fogFar - fogNear, 1.0 ) );');
const RM = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
const clamp=(x,a,b)=>x<a?a:x>b?b:x, lerp=(a,b,t)=>a+(b-a)*t, TAU=Math.PI*2;
function mulberry(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;}}
const angd=(a,b)=>{let d=a-b; while(d>Math.PI)d-=TAU; while(d<-Math.PI)d+=TAU; return d;};

/* ================= TRACK (rebuildable) ================= */
const HW=6, WALL=16, GRIP=22;   // road half-width; guardrail behind the grass run-off (as physics/track.cpp)
// A reloaded game has a new performance clock. Revisions keep the phone from blending across circuit/run resets.
const SOURCE_ID=Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,10);
let trackRev=0,worldRev=0;
let N,L,DS,PX,PZ,TX,TZ,H,SL,KC,LATRL,VPROF,WLX,WLZ,WRX,WRZ,WGL,WGR,CORNERS=[],STRAIGHTS=[],SPOTS={},TRACK_NAME='Grand Prix circuit';
/*HUD>*/
const wrapS=s=>((s%L)+L)%L;
const dSigned=(a,b)=>{let d=wrapS(b-a); if(d>L/2) d-=L; return d;};
function sampleArr(A,s){const x=wrapS(s)/DS, i=Math.floor(x)%N, j=(i+1)%N, f=x-Math.floor(x); return A[i]+(A[j]-A[i])*f;}
function trackFrame(s){
  const x=wrapS(s)/DS, i=Math.floor(x)%N, j=(i+1)%N, f=x-Math.floor(x);
  let tx=lerp(TX[i],TX[j],f), tz=lerp(TZ[i],TZ[j],f); const tl=Math.hypot(tx,tz)||1;
  return {px:lerp(PX[i],PX[j],f), pz:lerp(PZ[i],PZ[j],f), h:lerp(H[i],H[j],f), tx:tx/tl, tz:tz/tl, sl:lerp(SL[i],SL[j],f)};
}
function worldPos(s,lat){const F=trackFrame(s); return {x:F.px-F.tz*lat, z:F.pz+F.tx*lat, y:F.h, F};}
/*<HUD*/

function polyLen(p){let l=0;for(let i=0;i<p.length;i++){const a=p[i],b=p[(i+1)%p.length];l+=Math.hypot(b[0]-a[0],b[1]-a[1]);}return l;}
/* The track itself is built in C++ (physics/track.cpp): smoothing, curvature, corners, elevation, barriers with
   gaps, racing line and speed profile. Here the arrays are typed-array views on wasm memory, and the corners
   become objects for the HUD and the scenario spots. */
function defaultLoop(){return 'default';}
function trackViews(){const X=PHYS.x,b=X.memory.buffer,F=p=>new Float64Array(b,p,N),U=p=>new Uint8Array(b,p,N);
  PX=F(X.track_px());PZ=F(X.track_pz());TX=F(X.track_tx());TZ=F(X.track_tz());H=F(X.track_h());SL=F(X.track_sl());KC=F(X.track_kc());
  LATRL=F(X.track_lat());VPROF=F(X.track_vprof());WLX=F(X.track_wlx());WLZ=F(X.track_wlz());WRX=F(X.track_wrx());WRZ=F(X.track_wrz());
  WGL=U(X.track_wgl());WGR=U(X.track_wgr());}
function buildTrack(raw,name){
  trackRev++;
  TRACK_NAME=name||'Circuit';const X=PHYS.x;let n;
  if(raw==='default')n=X.track_default();
  else{n=Math.min(raw.length,65536);const R=new Float64Array(X.memory.buffer,X.track_raw(),n*2);for(let i=0;i<n;i++){R[2*i]=raw[i][0];R[2*i+1]=raw[i][1];}}
  N=X.track_build(n);L=X.track_len();DS=X.track_ds();trackViews();
  const CB=new Float64Array(X.memory.buffer,X.track_corners(),X.track_ncorners()*4);CORNERS=[];
  for(let i=0;i<CB.length;i+=4)CORNERS.push({s0:CB[i],s1:CB[i+1],sg:CB[i+2],angle:CB[i+3]});
  CORNERS.forEach((c,i)=>{c.n=i+1;c.apex=wrapS(c.s0+wrapS(c.s1-c.s0)/2);});
  STRAIGHTS=CORNERS.map((c,i)=>{const nx=CORNERS[(i+1)%CORNERS.length];return {s0:c.s1,s1:nx.s0,len:wrapS(nx.s0-c.s1)||L,after:c};});
  if(!CORNERS.length) STRAIGHTS=[{s0:0,s1:0,len:L,after:null}];
  const longest=STRAIGHTS.reduce((a,b)=>b.len>a.len?b:a,STRAIGHTS[0]);
  SPOTS.crestStraight=longest;SPOTS.crest=X.track_crest();
  // scenario spots: the fastest corner with room after it hides the stopped car, another fast one gets the tractor
  const minV=c=>{let m=99;for(let s=c.s0;dSigned(s,c.s1)>0;s+=4)m=Math.min(m,sampleArr(VPROF,s));return m;};
  CORNERS.forEach((c,i)=>{c.minV=minV(c);c.exitLen=STRAIGHTS[i].len;});
  const cand=CORNERS.filter(c=>Math.abs(c.angle)>0.55&&c.exitLen>70).sort((a,b)=>b.minV-a.minV);
  const pool=cand.length?cand:CORNERS.slice().sort((a,b)=>b.exitLen-a.exitLen);
  const blindC=pool[0]||null;
  let recC=pool.find(c=>c!==blindC&&Math.abs(dSigned(c.s1,blindC?blindC.s1:0))>400)||pool.find(c=>c!==blindC)||null;
  SPOTS.blind=blindC?wrapS(blindC.s1+Math.min(40,blindC.exitLen*0.45)):wrapS(L*0.3);
  SPOTS.blindC=blindC;
  SPOTS.rec=recC?wrapS(recC.s1+Math.min(35,recC.exitLen*0.45)):wrapS(L*0.7);
  SPOTS.recC=recC;
  SPOTS.marsh=wrapS(SPOTS.crest+45);
  SPOTS.freeStart=wrapS(longest.s0+20);
}
const nearTrack=(x,z,r,self,far)=>PHYS.x.track_near(x,z,r,self,far)!==0;
const lineOfSight=(sA,latA,hA,sB,latB,hB)=>PHYS.x.track_los(sA,latA,hA,sB,latB,hB)!==0;
const waterDepth=(s,lat,rain)=>PHYS.x.track_water(s,lat,rain);


/* ================= ON-BOARD RADAR: scene side =================
   The sensor physics and the tracker are in physics/radar.c (77 GHz link budget, rain, multipath, Swerling-1
   detection, measurement noise, resolution, Kalman tracking). This part decides what the beam can reach:
   line of sight past barriers and crests, cars in the way, spray plumes between the radar and a target,
   barrier patches at grazing incidence. Then it matches confirmed tracks to the position feed. */
const RADAR={h:0.35,nose:2.9,scan:1/15,rmax:250,half:9*Math.PI/180};
const RCS={car:10,tractor:40,marshal:0.7,traffic:7}, SCAT_H={car:[0.25,0.5,0.8],tractor:[0.5,1.3,2.2],marshal:[0.5,1.0,1.5],traffic:[0.2,0.45,0.75]};
// track coordinates (s, lat) of a world point, searching near a guess of s
function toTrack(x,z,sHint){let best=1e18,bi=0;const i0=Math.floor(wrapS(sHint)/DS),span=Math.ceil(60/DS);
  for(let k=-span;k<=span;k++){const i=((i0+k)%N+N)%N,d=(PX[i]-x)**2+(PZ[i]-z)**2;if(d<best){best=d;bi=i;}}
  return {s:bi*DS,lat:(x-PX[bi])*-TZ[bi]+(z-PZ[bi])*TX[bi]};}
function radarScan(w){
  const X=PHYS.x;if(!X)return;
  if(!w.radar){w.radar={dets:[],tracks:[],t:w.t,rng:0,att:0};X.radar_seed(w.t+1+Math.random());}
  const R=w.radar,P=w.player,dtS=Math.max(0.02,w.t-R.t);R.t=w.t;
  const hd=headingAt(P.s,carYaw(P,true)),pc=worldPos(P.s,P.lat),ox=pc.x+hd[0]*RADAR.nose,oz=pc.z+hd[1]*RADAR.nose,vex=hd[0]*fwdSpeed(w),vez=hd[1]*fwdSpeed(w),sR=P.s+RADAR.nose;
  R.ox=ox;R.oz=oz;
  const polar=(x,z)=>{const dx=x-ox,dz=z-oz;return [Math.hypot(dx,dz),Math.atan2(dx*-hd[1]+dz*hd[0],dx*hd[0]+dz*hd[1]),dx,dz];};
  const cars=w.traffic.map((c,i)=>{const p=worldPos(c.s,c.lat),q=polar(p.x,p.z);return {c,i,p,r:q[0],az:q[1],d:dSigned(sR,c.s)};});
  // extra two-way loss on the way to (r, az): a car in the beam (F1 floors leave no gap under) or its spray
  const pathLoss=(r,az,self)=>{let L=0;for(const q of cars){if(q.c===self||q.r>=r-2||q.r<3)continue;const da=Math.abs(q.az-az);
    if(da<Math.atan2(1.0,q.r))L+=25;else if(da<Math.atan2(1.4+0.05*Math.min(40,r-q.r),q.r))L+=4*w.rain*w.rain*clamp(q.c.v/45,0,1.3);}return L;};
  const ret=(x,z,vx,vz,sigma,hts,ref,st,self)=>{const [r,az,dx,dz]=polar(x,z);if(r<1.5||r>RADAR.rmax*1.15)return;
    const vr=((vx-vex)*dx+(vz-vez)*dz)/r;X.radar_return(r,az,vr,sigma,hts[0],hts[1],hts[2],pathLoss(r,az,self),w.rain,ref,st?1:0);};
  X.radar_begin();
  for(const q of cars){if(q.d<=0||q.r>RADAR.rmax*1.1||!lineOfSight(sR,P.lat,RADAR.h,q.c.s,q.c.lat,0.5))continue;
    const h2=headingAt(q.c.s,carYaw(q.c));ret(q.p.x,q.p.z,h2[0]*q.c.v,h2[1]*q.c.v,RCS.traffic,SCAT_H.traffic,q.i,false,q.c);}
  w.hazards.forEach((h,i)=>{if(h.gone)return;const d=dSigned(sR,h.s);if(d<=0||d>RADAR.rmax*1.1||!lineOfSight(sR,P.lat,RADAR.h,h.s,h.lat,Math.min(0.6,h.height*0.5)))return;
    const p=worldPos(h.s,h.lat),vl=h.moving?h.dir*h.speed:0,F=trackFrame(h.s);ret(p.x,p.z,-F.tz*vl,F.tx*vl,RCS[h.type]||5,SCAT_H[h.type]||[0.5,0.5,0.5],1000+i,true,null);});
  // barrier returns: 4 m × 1.2 m patches, σ0 = γc·sinψ with γc ≈ -10 dB for rough concrete
  for(let d=6;d<170;d+=4)for(const sg of [-1,1]){const i=Math.floor(wrapS(sR+d)/DS)%N;if(sg<0?WGL[i]:WGR[i])continue;
    const p=worldPos(sR+d,sg*(WALL-0.05)),[r,az,dx,dz]=polar(p.x,p.z);if(Math.abs(az)>RADAR.half*6)continue;
    if(!lineOfSight(sR,P.lat,RADAR.h,sR+d,sg*(WALL-0.4),0.5))continue;const sinpsi=Math.abs(dx/r*p.F.tz-dz/r*p.F.tx);
    ret(p.x,p.z,0,0,0.1*Math.max(0.02,sinpsi)*4.8,[0.3,0.7,1.0],-1,true,null);}
  X.radar_false_alarms();
  const nd=X.radar_resolve(ox,oz,hd[0],hd[1],vex,vez),D=PHYS.det;R.dets=[];
  for(let j=0;j<nd;j++){const o=j*12;R.dets.push({x:D[o+10],z:D[o+11],st:D[o+9]>0.5,snr:D[o+3],ref:D[o+8]});}
  const nt=X.radar_track(dtS,vex,vez,ox,oz),T0=PHYS.trk,old=new Map(R.tracks.map(T=>[T.id,T]));R.tracks=[];
  for(let k=0;k<nt;k++){const o=k*12,id=T0[o];R.tracks.push({id,x:T0[o+1],z:T0[o+2],vx:T0[o+3],vz:T0[o+4],conf:T0[o+5]>0.5,snr:T0[o+9]});}
  // classify (barrier or on the road) and fuse with the position feed
  for(const T of R.tracks){const tt=toTrack(T.x,T.z,sR+Math.hypot(T.x-ox,T.z-oz));T.s=tt.s;T.lat=tt.lat;T.spd=Math.hypot(T.vx,T.vz);T.barrier=Math.abs(tt.lat)>HW+0.3&&T.spd<3;T.obj=null;}
  for(const T of R.tracks){if(!T.conf||T.barrier)continue;let bo=null,bd=16;
    for(const o of w.traffic.concat(w.hazards.filter(h=>!h.gone))){const p=worldPos(o.s,o.lat),e=(p.x-T.x)**2+(p.z-T.z)**2;if(e<bd){bd=e;bo=o;}}
    if(bo){T.obj=bo;bo.rdrT=w.t;if(bo.rdrD==null)bo.rdrD=dSigned(P.s,bo.s);}}
  X.radar_set_fog(fogLWC(fogMOR(w.fog||0)),15);R.rng=X.radar_range90(w.rain);R.att=2*(X.radar_rain_db(w.rain)+X.radar_fog_db())*R.rng/1000+4*w.rain;}

/* ================= SCENARIOS & SIM ================= */
const RANGE=700, A_MAX=24, A_PLAN=11, EYE=0.95, REACT_EYES=0.7, REACT_VISOR=0.9, REACT_HUD=1.6, TRAFFIC_SEE=125;
const accel=v=>Math.max(1.2, 9.5*(1-v/95));
const LABEL={car:'Stopped car', tractor:'Recovery vehicle', marshal:'Marshal on track'};
function onLine(s){return clamp(sampleArr(LATRL,s),-(HW-1.8),HW-1.8);}
function avoidOf(l){return l>0?Math.max(-(HW-1.3),l-4.4):Math.min(HW-1.3,l+4.4);}
function mkHaz(type,s,o){
  const lat=o&&o.lat!=null?o.lat:onLine(s);
  const base={car:{halfLen:2.8,halfW:1.0,height:0.9,vpass:16.7}, tractor:{halfLen:3.2,halfW:1.5,height:2.6,vpass:13.9}, marshal:{halfLen:0.4,halfW:0.35,height:1.7,vpass:12.5}}[type];
  const h=Object.assign({type,s,lat,avoid:avoidOf(lat),avoidT:avoidOf(lat),yaw:0,label:LABEL[type]},base,o||{});
  return Object.assign(h,{seenAcc:0,firstSeenD:null,vis:false,aware:false,knows:false,src:null,reactD:null,warnT:null,warnD:null,passed:false,passV:null,clear:null,tArrive:null,gone:false});
}
const cname=c=>c?'T'+c.n:'the corner';
const SCN={
  blind:{key:'blind', title:'Blind corner, spray', ref:'Paletti · Montréal 1982', short:'Paletti · 1982',
    blurb:()=>`A car has stopped just past ${cname(SPOTS.blindC)}, a fast corner. Two cars ahead throw spray and swerve round it at the last moment.`,
    rain:0.6, flag:null, startBack:900, traffic:[42,96],
    hazards:()=>[mkHaz('car',SPOTS.blind,{yaw:0.45})]},
  crest:{key:'crest', title:'Marshal behind the car ahead', ref:'Pryce · Kyalami 1977', short:'Pryce · 1977',
    blurb:()=>'A marshal runs across the longest straight toward a stopped car. The car ahead dodges him at the last moment; tucked in behind it, you see neither until it pulls out.',
    rain:0.12, flag:'yellow', startBack:1000, traffic:[38],
    hazards:()=>{
      const S=SPOTS.marsh, rl=sampleArr(LATRL,S), rs=rl>=0?1:-1;
      const start=rs*(HW+0.8), spd=3.4, trig=Math.max(45,sampleArr(VPROF,S)*Math.abs(rl-start)/spd);
      const m=mkHaz('marshal',S,{lat:start,dir:-rs,speed:spd,latEnd:-rs*(HW-3.2),trigger:trig,go:false,avoid:rs*3.3,avoidT:rs*3.9,tvpass:70});
      const c=mkHaz('car',wrapS(S+16),{lat:-rs*(HW-1.4),yaw:rs*0.3,avoid:rs*3.3,avoidT:rs*3.9,tvpass:70});
      return [m,c];}},
  rec:{key:'rec', title:'Recovery vehicle in rain', ref:'Bianchi · Suzuka 2014 · Gasly · 2022', short:'Bianchi · Gasly',
    blurb:()=>`A tractor is lifting a crashed car at the exit of ${cname(SPOTS.recC)}. Heavy rain, double yellow, and the tractor sits right on the line out of the corner.`,
    rain:0.88, flag:'double', startBack:950, traffic:[],
    hazards:()=>{const t=mkHaz('tractor',SPOTS.rec,{yaw:0.5}); const side=Math.sign(t.lat)||1;
      return [t, mkHaz('car',wrapS(SPOTS.rec+9),{lat:side*(HW-1.2),yaw:-0.8,avoid:t.avoid,avoidT:t.avoid})];}},
  free:{key:'free', free:true, title:'Free drive', ref:'Any circuit · traffic', short:'Free drive',
    blurb:()=>'No script. Race a pack of cars wheel to wheel and watch them on the radar. Press X to hide a stopped car or tractor past the next blind corner and see if you catch it in time.',
    rain:0, flag:null, startBack:0,
    traffic:[{gap:-60,lane:1.8,fac:0.97},{gap:30,lane:-1.9,fac:0.93},{gap:75,lane:1.6,fac:0.95},{gap:140,lane:0,fac:0.9},{gap:230,lane:-2,fac:0.94},{gap:330,lane:1.2,fac:0.92}],
    hazards:()=>[]}
};
const SCN_ORDER=['free','blind','crest','rec'];
const TCOL=[0xd6dce2,0xff7a2a,0x18c08f,0xa970ff,0xffd02a,0x4a9cff,0xff4f8e,0x5fd068,0xff9a3a,0x9fb4c0,0xc46cff,0x22d0e0];
function genTraffic(n){const r=mulberry(n*7+1),out=[];
  for(let i=0;i<n;i++){const gap=-150+i*(820/n)+r()*18;if(Math.abs(gap)<14)continue;
    out.push({gap,lane:[-2.3,1.9,-0.8,2.4,0.6,-1.8][i%6]+(r()-0.5)*0.6,fac:0.86+r()*0.13});}
  return out;}

function carFrom(g,s0,lap0,i){const T=typeof g==='number'?{gap:g,lane:0,fac:1}:g, s=wrapS(s0+T.gap);
  return {lapc:lap0+Math.floor((s0+T.gap)/L),s,lat:clamp(sampleArr(LATRL,s)+T.lane,-(HW-1.2),HW-1.2),latV:0,v:sampleArr(VPROF,s)*T.fac,lane:T.lane,fac:T.fac,vis:true,closing:false,col:TCOL[i%TCOL.length],braking:0,followT:0,touch:false};}
function makeWorld(key,opts){
  const sc=SCN[key], hz=sc.hazards();
  const s0=sc.free?SPOTS.freeStart:wrapS(hz[0].s-sc.startBack), tlist=sc.free?genTraffic(opts.traffic||12):sc.traffic;
  return {sc,opts:Object.assign({},opts),rain:opts.rain,fog:opts.fog||0,t:0,done:false,losT:0,vis:400,alert:0,near:null,dNear:1e9,flagOn:false,
    stopT:0,impact:null,crash:null,result:null,touches:0,scrapes:0,events:[],
    player:(()=>{const v0=sampleArr(VPROF,s0)*(sc.free?0.8:1);return {lapc:0,s:s0,lat:sampleArr(LATRL,s0),latV:0,slideV:0,psi:0,steer:0,v:v0,vx:v0,vy:0,r:0,ax:0,ay:0,delta:0,braking:0,thr:0,brk:0,onWall:false};})(),
    traffic:tlist.map((g,i)=>carFrom(g,s0,0,i)),
    hazards:hz};
}
// forward speed with its sign (negative while reversing); in autopilot the car only goes forward
const fwdSpeed=w=>{const P=w.player;return w.opts.driver==='drive'&&P.vx!=null?P.vx:P.v;};
function vSafe(h,d){return Math.sqrt(h.vpass*h.vpass+2*A_PLAN*Math.max(0,d-h.halfLen-8));}
function steerTo(c,target,dt){
  const maxLat=Math.min(6.5,0.6+c.v*0.12), want=clamp((target-c.lat)*2.0,-maxLat,maxLat);
  c.latV+=clamp(want-c.latV,-16*dt,16*dt);
  c.lat=clamp(c.lat+c.latV*dt,-HW+0.9,HW-0.9);
}
/* Player car in "You drive": the physics is physics/vehicle.c (dynamic bicycle model in track coordinates,
   combined-slip Magic Formula tyres, drivetrain, aero, barrier impulses). Here: car constants the driver model
   needs, and the lane assist, a pure-pursuit steering controller (Coulter 1992). Signs: +y, +r, +delta = right. */
const CAR={m:798,Iz:1150,lf:1.95,lr:1.65,h:0.3,ClA:5.0,CdA:1.35,aeroF:0.42,P:760e3,Fmax:13000,Fbrake:5.5*798*9.81,bb:0.57,B:10,Bf:9,Br:11,C:1.9,E:0.97,rearMu:1.08,dmax:0.34,rho:1.2};
/* Fog: the slider sets the meteorological optical range (MOR), from clear (0) to 30 m (100 %), on a log scale.
   Liquid water content from MOR through ITU-R P.840's pairs (0.05 g/m³ at ~300 m, 0.5 g/m³ at ~50 m):
   M = 76 MOR^-1.285 g/m³, which sets the radar's fog attenuation in physics/radar.c. */
function fogMOR(f){return f<=0.005?Infinity:2000*Math.pow(30/2000,f);}
function fogLWC(V){return isFinite(V)?76*Math.pow(V,-1.285):0;}
/* Visibility (meteorological optical range). Extinction coefficients add (Beer-Lambert):
   - clear night air: ~12 km of visibility
   - falling rain: 1.076 R^0.67 dB/km for a rain rate R in mm/h (optical rain attenuation, Carbonneau et al. 1998)
   - the spray mist that hangs over a wet track, which scales with the water the cars throw up (~rain²): ~75 m in a
     downpour on its own
   - fog, from the fog slider */
function weatherVis(rain,fog){const R=50*rain*rain+8*rain,bR=R>0?1.076*Math.pow(R,0.67)/4.343/1000:0;return 3/(3/12000+bR+0.04*rain*rain+3/fogMOR(fog));}
/* What each axle is running on (the car can straddle two surfaces). Values from measurements:
   - kerb: painted concrete, slippery in the wet, and ridged (roughness)
   - grass: locked-wheel skid tests on mown rye-grass (Cenek, Jamieson & McLarin) give ~0.38 dry and 0.21-0.24
     wet for a treaded tyre; a slick has no grooves to clear the wet leaves and falls to ~0.13. The force-slip
     curve on turf is nearly flat and peaks at larger slip than on asphalt. A rolling tyre sinks in a little
     (rolling resistance 0.06 dry, 0.09 on soft wet ground).
   - gravel: a tyre on loose stones grips ~0.35 (Noon's gravel road); a rolling tyre sinks into the bed and a
     sliding one ploughs a bow wave of stones. Tests in a circuit gravel bed (16-32 mm round gravel, 0.5 m deep)
     measured ~0.3 g coasting and up to ~0.9 g braking, and less deceleration at higher entry speed as the car
     skims the bed: here the sinkage resistance is 0.30 up to 50 km/h, falling as 1/sqrt(v) above it.
   Grip is returned relative to the track's (mu) and to the fitted tyre's own factor (tf), since the rubber
   compound matters little on grass or stones. */
const ROAD={mu:1,crr:0,off:0,rough:0,kind:0,floor:0.74,bk:1,pl:0};
function surfaceAt(w,s,lat,v,muRoad,tf,evac){const al=Math.abs(lat);
  if(al<HW-1.1||(al>HW+0.25&&al<=HW+0.6))return ROAD;
  if(al<=HW+0.25)return {mu:w.rain>0.3?0.8:1,crr:0.01,off:0,rough:0.25,kind:1,floor:0.74,bk:1,pl:0};
  const i=Math.floor(wrapS(s)/DS)%N,gr=GRAV[lat<0?0:1],gv=gr&&al>HW+1.6&&al<WALL-1.2?clamp(gr[i]*1.5,0,1):0,k=muRoad*Math.max(tf,0.3);
  if(gv>0.5)return {mu:0.35/0.95/k,crr:0.30*Math.min(1,Math.sqrt(14/Math.max(v,1))),off:1,rough:0.7,kind:3,floor:0.95,bk:0.5,pl:0.35};
  const wetG=clamp(w.rain*3,0,1),muG=lerp(0.32,lerp(0.11,0.19,evac),wetG)/0.95;   // calibrated so this car's locked-wheel stops match the measured 0.38 g dry / ~0.23 g wet
  return {mu:muG/k,crr:lerp(0.06,0.09,wetG),off:1,rough:0.35,kind:2,floor:0.95,bk:0.6,pl:0};}
// traction control and ABS levels (0 off, 1 lightest .. 12 heaviest): target slip ratios, as in physics/vehicle.c
const tcTarget=l=>l>0?0.20-0.14*(l-1)/11:0, absTarget=l=>l>0?0.16-0.09*(l-1)/11:0, levelGain=l=>0.5+l/12;
/* Impacts, for force feedback: each new hit is numbered, with a severity from the speed going into it (the
   barrier's normal speed, or the closing speed on another car): ~2 m/s is a scrape, ~10 m/s a hard hit, and
   24 m/s+ ends the run. The phone plays it as a vibration and a gamepad rumbles. */
function impact(P,v,crash){P.hitN=(P.hitN||0)+1;P.hitSev=crash?1:clamp(v/20,0.06,1);rumble(P.hitSev);}
function rumble(sev){try{const gps=navigator.getGamepads?navigator.getGamepads():[];for(const gp of gps){const a=gp&&gp.vibrationActuator;
  if(a&&a.playEffect)a.playEffect('dual-rumble',{duration:Math.round(80+420*sev),strongMagnitude:clamp(0.3+0.7*sev,0,1),weakMagnitude:clamp(0.2+0.8*sev,0,1)});}}catch(e){}}
function tyreMu(w){return 1.5-0.5*w.rain;}   // a full wet in its window; the compound, heat and wear scale it in vehicle.c
// Auto: the tyre a team would call for this much rain (slicks below ~20 %, intermediates to ~55 %, then full wets)
function autoTyre(rain){return rain>0.55?4:rain>0.2?3:1;}
function tyreFor(o){return o.tyre==null||o.tyre==='auto'?autoTyre(o.rain):o.tyre;}
// gearbox ratios (kept here for the HUD; the drivetrain itself is in physics/vehicle.c)
const GEARS=[18.1,14.98,12.4,10.27,8.5,7.04,5.83,4.81], RW=0.36;
/* ================= PHYSICS CORE: C compiled to WebAssembly (physics/*.c, build with tools/build.py) =================
   vehicle.c  — tyres, drivetrain, aero, barrier impulses (integrated between frames)
   radar.c    — 77 GHz link budget, detection, measurement noise, resolution, Kalman tracker
   spray.c    — tyre spray droplets in the car's wake (render buffers live in wasm memory)
   JavaScript keeps the driver model, the scene geometry and the drawing. */
const VEH_FIELDS=['s','lat','psi','vx','vy','r','wf','wr','kf','kr','af','ar','FyfS','FyrS','ax','ay','thr','brk','delta','gear','cut','rpm','hitV','latV','v','sliding','beta','satF','satR','mz','gripF','gripR','aqua','rev','tempF','tempR','wearF','wearR','tyreF','tyreR','brakeT','pbF','pbR','tcCut','tcI','absF','absR','padMu','brakeTR','bCoreF','bCoreR','regen','dirtF','dirtR','flatF','flatR','bump'];
const PHYS={ok:false,x:null};
PHYS.ready=fetch('/physics.wasm').then(r=>{if(!r.ok)throw new Error('physics.wasm '+r.status);return r.arrayBuffer();}).then(b=>WebAssembly.instantiate(b,{})).then(({instance})=>{
  const x=instance.exports,buf=x.memory.buffer;if(x._initialize)x._initialize();PHYS.x=x;
  PHYS.veh=new Float64Array(buf,x.veh_state(),VEH_FIELDS.length);PHYS.curv=new Float64Array(buf,x.veh_curv(),16384);
  PHYS.det=new Float64Array(buf,x.radar_det(),160*12);PHYS.trk=new Float64Array(buf,x.radar_tracks(),96*12);
  const n=x.spray_count();x.spray_clear();
  spG.setAttribute('position',new THREE.BufferAttribute(new Float32Array(buf,x.spray_pos(),n*3),3));
  spG.setAttribute('aSize',new THREE.BufferAttribute(new Float32Array(buf,x.spray_size(),n),1));
  spG.setAttribute('aAlpha',new THREE.BufferAttribute(new Float32Array(buf,x.spray_alpha(),n),1));
  PHYS.ok=true;physTrack();}).catch(e=>{PHYS.err=e;console.error(e);});
// hand the track curvature to the C integrator (called after every track build)
function physTrack(){if(!PHYS.ok||!KC)return;PHYS.curv.set(KC.length>16384?KC.subarray(0,16384):KC);PHYS.x.veh_set_track(Math.min(N,16384),DS);}
function driveDynamics(P,w,inp,dt,assist){
  const L=CAR.lf+CAR.lr, g=9.81, x=PHYS.x, V=PHYS.veh, o=w.opts;
  if(o.tcT!=null)x.veh_set_aids(o.tcT,o.tcG,o.absT,o.absG);else x.veh_set_control(6,6);
  x.veh_set_bias(o.bb||0.57);
  // wet painted kerbs; aquaplaning comes from the water depth, in physics/vehicle.c
  const mu=tyreMu(w);x.veh_set_water(waterDepth(P.s,P.lat,w.rain));
  // each axle's own surface (the axles sit LF ahead / LR behind the centre, along the car's heading)
  {const sp=Math.sin(P.psi||0),cp=Math.cos(P.psi||0),ev=[0,0,0,0.5,1][P.comp|0]||0,
      sf=surfaceAt(w,P.s+CAR.lf*cp,P.lat+CAR.lf*sp,P.v||0,mu,P.tyreF||1,ev),sr=surfaceAt(w,P.s-CAR.lr*cp,P.lat-CAR.lr*sp,P.v||0,mu,P.tyreR||1,ev);
    x.veh_set_surface(sf.mu,sf.crr,sf.off,sr.mu,sr.crr,sr.off,Math.max(sf.rough,sr.rough));x.veh_set_loose(sf.floor,sf.bk,sf.pl,sr.floor,sr.bk,sr.pl);P.surfF=sf.kind;P.surfR=sr.kind;}
  P.wheelDeg=inp.wheelDeg;
  if(P.wf==null){VEH_FIELDS.forEach((f,i)=>V[i]=P[f]||0);x.veh_reset();VEH_FIELDS.forEach((f,i)=>P[f]=V[i]);}
  // a fresh set of the chosen compound, straight out of the blankets (Auto picks for the rain once, at the start)
  const want=P.comp==null||w.opts.tyre!=='auto'?tyreFor(w.opts):P.comp;
  if(P.comp!==want){VEH_FIELDS.forEach((f,i)=>V[i]=P[f]||0);x.veh_set_compound(want);VEH_FIELDS.forEach((f,i)=>P[f]=V[i]);P.comp=want;}
  // reverse: hold brake at a standstill to select it; then the brake pedal drives backwards and gas brakes.
  // Gas at a standstill selects first gear again.
  const stopped=Math.abs(P.vx)<0.6&&Math.abs(P.vy)<0.6;
  if(!P.rev){if(stopped&&inp.brake>0.5&&inp.throttle<0.1){P.revT=(P.revT||0)+dt;if(P.revT>0.35){P.rev=1;P.revT=0;}}else P.revT=0;}
  else if(stopped&&inp.throttle>0.3&&inp.brake<0.1)P.rev=0;
  const thrIn=P.rev?inp.brake:inp.throttle,brkIn=P.rev?inp.throttle:inp.brake;
  // driver inputs through actuator rates
  /* a key or button is all-or-nothing, but a driver's foot is not: it feels a wheel start to lock (the car stops
     turning, the tyre scrubs) after ~0.15 s and eases the pedal, then squeezes it back as the grip returns. With
     "Driver's foot" on, digital brake inputs get that human modulation; analog pedals (phone slide, triggers) and
     the car's own ABS setting are untouched. */
  let bIn=brkIn;
  if(inp.brakeDigital&&!P.rev&&w.opts.kbFoot!==false){const lock=Math.max(-(P.kf||0),-(P.kr||0));
    // anticipation, as drivers brake: hardest at top speed where downforce gives the most grip, easing the pedal as
    // the car slows. The front tyres' grip = mu x (static load + downforce share + load moved forward by braking);
    // press just short of the torque that would lock them.
    {const v=P.v||0,DF=0.5*CAR.rho*CAR.ClA*(P.aeroK||1)*v*v,Lw=CAR.lf+CAR.lr,mu=tyreMu(w)*(P.tyreF||1)*0.92,a=mu*(9.81+DF/CAR.m),
       Fzf=CAR.m*9.81*CAR.lr/Lw+DF*CAR.aeroF+CAR.m*a*CAR.h/Lw,full=CAR.Fbrake*(w.opts.bb||0.57)*Math.max(0.3,P.padMu||1);
     bIn=Math.min(bIn,clamp(0.97*mu*Fzf/full,0.12,1));}
    P.feel=(P.feel||0)+(lock-(P.feel||0))*Math.min(1,dt/0.15);                    // what the driver notices, ~0.15 s late
    P.ease=clamp((P.ease||0)+(P.feel>0.15?6:-1.5)*dt,0,0.85);bIn*=1-P.ease;}   // back off fast, squeeze back slowly else P.ease=0;
  P.thr+=clamp(thrIn-P.thr,-5*dt,3.2*dt); P.brk+=clamp(bIn-P.brk,-8*dt,7*dt); P.braking=P.brk>0.1?1:0;
  P.steer+=clamp(inp.steer-P.steer,-5*dt,5*dt);
  // steering angle target at the wheels
  let dTarget;
  if(P.rev) dTarget=P.steer*CAR.dmax*0.8;                        // reversing: plain steering, no lane assist
  else if(assist){
    const edge=HW-1.15, Ld=clamp(7+0.42*P.vx,8,42);
    const tl=P.steer<0?lerp(sampleArr(LATRL,P.s+Ld),-edge,-P.steer):lerp(sampleArr(LATRL,P.s+Ld),edge,P.steer);
    const me=worldPos(P.s,P.lat), tg=worldPos(P.s+Ld,tl), hd=headingAt(P.s,P.psi);
    const dx=tg.x-me.x, dz=tg.z-me.z, fw=dx*hd[0]+dz*hd[1], rt=dx*(-hd[1])+dz*hd[0];
    const kpp=2*Math.sin(Math.atan2(rt,fw))/Math.hypot(dx,dz);
    dTarget=Math.atan(L*kpp)+0.06*(kpp*P.vx-P.r);                 // pure pursuit + yaw-rate tracking
  } else {
    // full steering: the input's travel spans about 1.6x the lock the front tyres can use at this speed (enough to
    // overdrive them or countersteer a slide), so a keyboard or a tilted phone is not all-or-nothing at 300 km/h
    const vv=Math.max(P.vx,6), ayMax=mu*(P.tyreF||1)*(g+0.5*CAR.rho*CAR.ClA*(P.aeroK||1)*vv*vv/CAR.m);
    dTarget=P.steer*clamp(1.6*L*ayMax/(vv*vv)+0.1,0.05,CAR.dmax);
  }
  dTarget=clamp(dTarget,-CAR.dmax,CAR.dmax);
  // physics: physics/vehicle.c
  VEH_FIELDS.forEach((f,i)=>V[i]=P[f]||0);
  x.veh_step(dt,mu,dTarget,P.aeroK||1,WALL);
  VEH_FIELDS.forEach((f,i)=>P[f]=V[i]);
  P.sliding=P.sliding>0.5; P.slideV=0;
}
function planLat(w,s){
  let l=sampleArr(LATRL,s);
  for(const h of w.hazards){if(h.gone)continue;const d=dSigned(s,h.s);if(d>-h.halfLen-10&&d<150){const k=d<30?1:1-(d-30)/120;l=lerp(l,h.avoid,clamp(k,0,1));}}
  return l;
}
function step(w,dt,inp){
  if(w.done) return;
  w.t+=dt;mpTick(w,dt);
  const P=w.player, o=w.opts, drive=o.driver==='drive', live=w.hazards.filter(h=>!h.gone), h0=w.hazards[0];
  // extinction coefficients add: rain and its hanging spray mist, plus fog
  let vis=weatherVis(w.rain,w.fog||0);
  // spray from the car ahead: a wall of mist just behind it, but only once there is water on the track to throw up
  if(w.rain>0.08)for(const c of w.traffic){const d=dSigned(P.s,c.s); if(d>0&&d<170) vis=Math.min(vis,(d+14+36*(1-w.rain))/clamp((w.rain-0.08)*3,0.02,1));}
  w.vis=vis;
  // spray and dirty air from the cars ahead: each car leaves a plume that widens behind it and is densest close up
  // and at speed; its water volume scales with the water on the track (~rain squared). Following closely also costs
  // downforce (2022-rules cars lose roughly a fifth at one to two car lengths).
  let spray=0,wake=0;
  for(const c of w.traffic){const d=dSigned(P.s,c.s);if(d<=1||d>70)continue;const half=1.1+d*0.05,ov=clamp(1-(Math.abs(c.lat-P.lat)-half*0.5)/half,0,1);if(!ov)continue;
    spray+=ov*clamp(c.v/45,0,1.3)*Math.exp(-d/22);wake+=ov*clamp(c.v/50,0,1.2)*Math.exp(-d/25);}
  spray=clamp(spray*w.rain*w.rain*1.7+0.08*clamp(P.v/70,0,1.2)*waterDepth(P.s,P.lat,w.rain)/2,0,1);   // + your own front wheels
  w.spray=w.spray==null?spray:w.spray+(spray-w.spray)*Math.min(1,dt*6);
  P.aeroK=1-clamp(wake,0,1)*0.22;
  // the nearest car behind you inside 50 m: distance, which side it is coming, how fast it is closing
  {let b=null;for(const c of w.traffic){const d=-dSigned(P.s,c.s);if(d>2&&d<=50&&(!b||d<b.d))b={c,d};}
    if(b){const dl=b.c.lat-P.lat;b.side=Math.abs(dl)<1.6?0:Math.sign(dl);b.cl=b.c.v-P.v;b.fresh=!w.behind;}
    w.behind=b;}
  w.radT=(w.radT||0)-dt;if(w.radT<=0){w.radT+=RADAR.scan;radarScan(w);}
  for(const h of live) if(h.type==='marshal'){
    const d=dSigned(P.s,h.s); if(!h.go&&d>0&&d<h.trigger) h.go=true;
    if(h.go){const nl=h.lat+h.dir*h.speed*dt; h.moving=h.dir>0?nl<h.latEnd:nl>h.latEnd; if(h.moving) h.lat=nl;}
  }
  w.losT-=dt;
  if(w.losT<=0){w.losT=1/30;
    for(const h of live){const d=dSigned(P.s,h.s); h.vis=d>0&&d<vis&&lineOfSight(P.s,P.lat,EYE,h.s,h.lat,h.height);}
    for(const c of w.traffic){const d=dSigned(P.s,c.s); c.vis=d<=0?true:(d<vis+4&&lineOfSight(P.s,P.lat,EYE,c.s,c.lat,0.8));}
  }
  for(const h of live) if(h.vis){h.seenAcc+=dt; if(h.firstSeenD==null) h.firstSeenD=dSigned(P.s,h.s);}
  let near=null, dn=1e9;
  for(const h of live){const d=dSigned(P.s,h.s); if(d>-h.halfLen&&d<dn){dn=d;near=h;}}
  w.near=near; w.dNear=dn;
  w.flagOn=!!(w.sc.flag&&near&&dn<360);
  // marshal sectors (~200 m): yellow where a hazard sits and on the approach to it; red where it blocks the track
  // (less than ~3.2 m left to get by) or a person is running across it
  {const n=Math.max(8,Math.round(L/200)),sl=L/n;if(!w.flags||w.flags.length!==n)w.flags=new Uint8Array(n);else w.flags.fill(0);w.secLen=sl;
    for(const h of live){const k=Math.floor(wrapS(h.s)/sl)%n,free=Math.max(h.lat-h.halfW+HW,HW-(h.lat+h.halfW)),red=free<3.2||(h.type==='marshal'&&h.moving);
      w.flags[k]=Math.max(w.flags[k],red?2:1);const kp=(k-1+n)%n;w.flags[kp]=Math.max(w.flags[kp],1);}}
  const assist=o.hud||o.visor;
  for(const h of live){const d=dSigned(P.s,h.s); if(assist&&d>0&&d<RANGE&&h.warnT==null){h.warnT=w.t;h.warnD=d;}}
  let alert=0;
  if(assist&&near&&dn<RANGE){alert=1; if(P.v>vSafe(near,dn)+1.5&&dn/Math.max(P.v,1)<5) alert=2;}
  for(const c of w.traffic){const d=dSigned(P.s,c.s), cl=P.v-c.v; c.closing=d>0&&d<140&&cl>5&&d/cl<3.2; if(assist&&c.closing&&d/cl<1.6) alert=Math.max(alert,2);}
  w.alert=alert;
  // awareness, per hazard
  for(const h of live){ if(h.aware) continue; const d=dSigned(P.s,h.s); if(d<=0) continue; let src=null;
    if(!drive){ if(h.seenAcc>=REACT_EYES) src='eyes'; else if(h.warnT!=null&&w.t-h.warnT>=(o.visor?REACT_VISOR:REACT_HUD)) src=o.hud?'hud':'visor'; }
    else if(inp.brake>0.3&&d<560&&(h.warnT!=null||h.seenAcc>0)) src='you';
    if(src){h.aware=true;h.src=src;h.reactD=d;} }
  for(const h of live) h.knows=h.aware&&(o.hud||h.src==='eyes'||h.src==='you'||h.seenAcc>0.3);
  const prof=sampleArr(VPROF,P.s), kap=sampleArr(KC,P.s);
  const prevD=live.map(h=>dSigned(P.s,h.s)), sBefore=P.s;
  if(!drive){
    let vt=prof;
    if(w.flagOn) vt*=0.93;
    {const nf=nextFlag(w,P.s,300);if(nf&&nf.f===2)vt=Math.min(vt,Math.sqrt(23.5*23.5+2*9*Math.max(0,nf.d-10)));}
    for(const c of w.traffic){const d=dSigned(P.s,c.s); if(d>0&&d<70&&Math.abs(c.lat-P.lat)<2.6) vt=Math.min(vt,Math.max(0,c.v+(d-22)*0.8));}
    for(const h of live){ if(!h.aware) continue; const d=dSigned(P.s,h.s); if(d>-h.halfLen&&d<600) vt=Math.min(vt,h.knows?vSafe(h,d):0.62*prof); }
    if(P.v>vt){P.braking=(P.v-vt)>0.3?1:0;P.brk=P.braking;P.thr=0;P.v=Math.max(vt,P.v-A_MAX*dt);}
    else {P.braking=0;P.brk=0;P.thr=P.v<vt-0.5?1:0.3;P.v=Math.min(vt,P.v+accel(P.v)*dt);}
    let lt=sampleArr(LATRL,P.s);
    if(near&&near.knows&&dn<260) lt=near.avoid;
    steerTo(P,lt,dt); P.psi=0;
  } else {
    driveDynamics(P,w,inp,dt,o.steer==='assist');
  }
  // walls. You drive: rigid-body impulses at the car's corners (bounce, scrape, yaw) are applied inside
  // driveDynamics; here we only count hits and end the run on a heavy impact. Autopilot: simple clamp.
  if(drive){
    if(P.hitV>0){if(!P.onWall||P.hitV>(P.lastHitV||0)+3){impact(P,P.hitV,P.hitV>24);P.lastHitV=P.hitV;}if(!P.onWall&&w.t-(P.lastHitT||-9)>0.4){w.scrapes++;}P.onWall=true;P.lastHitT=w.t;
      if(P.hitV>24){w.crash={what:'the wall',v:P.v};w.tArrive=w.t;finish(w,'crash');return;}}
    else if(w.t-(P.lastHitT||-9)>0.25){P.onWall=false;P.lastHitV=0;}
    P.hitV=0;
  }
  const lim=HW-0.45;
  if(!drive&&Math.abs(P.lat)>lim){
    const sg=Math.sign(P.lat), vl=Math.abs(P.latV); P.lat=sg*lim;
    if(!P.onWall){P.onWall=true;w.scrapes++;
      if(vl>9&&P.v>20){w.crash={what:'the wall',v:P.v};w.tArrive=w.t;finish(w,'crash');return;}
      if(drive)P.vx*=1-Math.min(0.45,vl*0.04); else P.v*=1-Math.min(0.45,vl*0.04);}
    if(drive){P.vx=Math.max(0,P.vx-9*dt);if(Math.sign(P.psi)===sg)P.psi*=-0.2;P.vy*=0.3;P.r*=0.3;P.v=Math.hypot(P.vx,P.vy);P.latV=-sg*0.5;}
    else {P.v=Math.max(0,P.v-9*dt);P.latV=-sg*0.6;P.slideV=0;P.psi*=-0.3;}
  } else P.onWall=false;
  if(!drive) P.s=wrapS(P.s+P.v*dt);
  if(P.s<sBefore-L/2)P.lapc++; else if(P.s>sBefore+L/2)P.lapc--;
  // traffic
  const all=[P].concat(w.traffic);
  for(const c of w.traffic){if(c.remote)continue;   // another driver: moved by their own game (mpTick)
    let vtc=sampleArr(VPROF,c.s)*c.fac, ltc=clamp(sampleArr(LATRL,c.s)+c.lane,-(HW-1.2),HW-1.2), hn=null, dh=1e9;
    for(const h of live){const d=dSigned(c.s,h.s); if(d>-h.halfLen-3&&d<dh){dh=d;hn=h;}}
    if(hn&&dh<TRAFFIC_SEE){ltc=hn.avoidT; const tv=hn.tvpass||26; vtc=Math.min(vtc,Math.sqrt(tv*tv+2*18*Math.max(0,dh-6)));}
    let blocked=false;
    for(const o2 of all){if(o2===c)continue;const d=dSigned(c.s,o2.s);if(d>0&&d<55&&Math.abs(o2.lat-c.lat)<2.3){vtc=Math.min(vtc,Math.max(0,o2.v+(d-14)*0.7));blocked=true;}}
    c.followT=blocked?c.followT+dt:0;
    if(c.followT>2.5&&w.sc.free){c.lane=c.lane>=0?-2.4:2.4;c.followT=0;}
    const dp=dSigned(c.s,P.s); if(Math.abs(dp)<8&&Math.abs(P.lat-c.lat)<3) ltc=clamp(c.lat+(c.lat>=P.lat?1.4:-1.4),-(HW-1.2),HW-1.2);
    if(c.v>vtc){c.braking=1;c.v=Math.max(vtc,c.v-A_MAX*dt);} else {c.braking=0;c.v=Math.min(vtc,c.v+accel(c.v)*dt);}
    steerTo(c,ltc,dt);
    {const sb=c.s;c.s=wrapS(c.s+c.v*dt);if(c.s<sb-L/2)c.lapc++;}
  }
  // car-to-car contact
  for(const c of w.traffic){if(c.remote){if(drive)mpCollide(w,P,c);if(w.done)return;continue;}
    const d=dSigned(P.s,c.s), dl=c.lat-P.lat;
    if(Math.abs(d)<5&&Math.abs(dl)<1.95){
      const pv=fwdSpeed(w),rel=d>0?pv-c.v:c.v-pv;   // closing speed; reversing into a car behind adds up
      if(rel>16){impact(P,rel,true);w.crash={what:'a car',v:P.v};w.tArrive=w.t;finish(w,'crash');return;}
      const ov=(1.95-Math.abs(dl))/2, sg=dl>=0?1:-1; P.lat-=sg*ov; c.lat+=sg*ov; P.latV*=0.3;
      if(d>0&&P.v>c.v){P.v=Math.max(0,c.v-0.5);P.vx=P.v;P.vy*=0.5;} else if(d<0&&c.v>P.v)c.v=Math.max(0,P.v-0.5);
      if(!c.touch){c.touch=true;w.touches++;impact(P,Math.abs(rel)+Math.abs(P.latV||0),false);}
    } else c.touch=false;
  }
  // hazard contact
  for(const h of live){
    const d=dSigned(P.s,h.s);
    if(Math.abs(d)<h.halfLen+2.7&&Math.abs(P.lat-h.lat)<h.halfW+0.95&&P.v>0.5){w.impact={v:P.v,label:h.label,h};h.tArrive=w.t;finish(w,'impact');return;}
  }
  live.forEach((h,k)=>{const d=dSigned(P.s,h.s);
    if(!h.passed&&prevD[k]>0&&d<=0){h.passed=true;h.passV=P.v;h.clear=Math.abs(P.lat-h.lat)-h.halfW-0.95;h.tArrive=w.t;if(w.sc.free)w.events.push(h);}
    if(w.sc.free&&h.passed&&d<-60)h.gone=true;});
  if(!w.sc.free){
    if(w.hazards.every(h=>dSigned(P.s,h.s)<-50)){finish(w,'pass');return;}
    const d0=dSigned(P.s,h0.s);
    if(P.v<0.3&&!h0.passed&&d0<260){w.stopT+=dt; if(w.stopT>1.4){finish(w,'stopped');return;}} else w.stopT=0;
    if(w.t>150) finish(w,'pass');
  }
}
function hazVerdict(h){const v=h.passV||0;return (v*3.6<=95&&(h.clear==null||h.clear>0.6))?'safe':'near';}
function finish(w,kind){
  w.done=true;
  const P=w.player, h0=w.impact?w.impact.h:(w.hazards[0]||null);
  let verdict, v=null;
  if(kind==='impact'){verdict='contact'; v=w.impact.v;}
  else if(kind==='crash'){verdict='crash'; v=w.crash.v;}
  else if(kind==='stopped'){verdict='stopped';}
  else {v=h0&&h0.passV!=null?h0.passV:P.v; verdict=h0?hazVerdict(h0):'safe';}
  w.result={verdict,kmh:v!=null?Math.round(v*3.6):null,
    shortM:kind==='stopped'?Math.max(0,Math.round(dSigned(P.s,h0.s)-h0.halfLen)):null,
    warnD:h0?h0.warnD:null, lead:(h0&&h0.warnT!=null&&h0.tArrive!=null)?h0.tArrive-h0.warnT:null,
    seenD:h0?h0.firstSeenD:null, radarD:h0&&h0.rdrD!=null?h0.rdrD:null, reactD:h0?h0.reactD:null, src:h0?h0.src:null,
    what:w.crash?w.crash.what:(h0?h0.label:''), opts:Object.assign({},w.opts), scn:w.sc.key, track:TRACK_NAME};
}
function verdictText(r){
  if(r.verdict==='contact') return 'Contact at '+r.kmh+' km/h';
  if(r.verdict==='crash') return 'Hit '+r.what+' at '+r.kmh+' km/h';
  if(r.verdict==='stopped') return 'Stopped '+r.shortM+' m short';
  if(r.verdict==='near') return 'Near miss at '+r.kmh+' km/h';
  return 'Safe pass at '+r.kmh+' km/h';
}
function chipText(r){
  if(r.verdict==='contact') return 'Contact '+r.kmh+' km/h';
  if(r.verdict==='crash') return 'Hit '+r.what.replace('the ','')+' '+r.kmh;
  if(r.verdict==='stopped') return 'Stopped '+r.shortM+' m short';
  if(r.verdict==='near') return 'Near miss '+r.kmh+' km/h';
  return 'Safe '+r.kmh+' km/h';
}

/* ================= RENDERER & SCENE ================= */
const stage=$('stage'), glc=$('gl');
const renderer=new THREE.WebGLRenderer({canvas:glc,antialias:true,powerPreference:'high-performance'});
renderer.outputEncoding=THREE.sRGBEncoding;
renderer.toneMapping=THREE.ACESFilmicToneMapping; renderer.toneMappingExposure=0.95;
renderer.shadowMap.enabled=true; renderer.shadowMap.type=THREE.PCFSoftShadowMap;
let curRain=0.6, curFog=0;
const scene=new THREE.Scene();
const FOV=60;
const camera=new THREE.PerspectiveCamera(FOV,16/9,0.04,4000);
scene.fog=new THREE.Fog(0x1e2833,10,400);
scene.background=new THREE.Color(0xb7c5d2);
// twilight sky dome that follows the camera (so it sits at infinity): deep blue overhead, the last of the sunset
// low in one direction, and the fog colour at the horizon so fogged scenery melts into it. Rain turns it overcast.
const FOG_BASE=new THREE.Color(), SPRAY_C=new THREE.Color(0x8d969f), SUN_AZ=-0.6, SKY_R=3500, skyGeo=new THREE.SphereGeometry(SKY_R,48,24);
skyGeo.setAttribute('color',new THREE.BufferAttribute(new Float32Array(skyGeo.attributes.position.count*3),3));
const skyMat=new THREE.MeshBasicMaterial({vertexColors:true,side:THREE.BackSide,fog:false,depthWrite:false});
const sky=new THREE.Mesh(skyGeo,skyMat);sky.renderOrder=-10;sky.frustumCulled=false;scene.add(sky);
// distant hills and a tree line as silhouettes on the horizon (children of the sky, so also at infinity)
const HILLS=[[3200,0x6f8599,55,190,0.55],[2900,0x3f5240,18,46,0.3]].map(([r,col,h0,h1,haze],k)=>{
  const rnd=mulberry(21+k),ph=[0,1,2,3,4].map(()=>rnd()*TAU),M=360,pos=[],idx=[];
  for(let j=0;j<=M;j++){const a=j/M*TAU,n=0.5+0.22*Math.sin(a*2+ph[0])+0.14*Math.sin(a*5+ph[1])+0.08*Math.sin(a*11+ph[2])+(k?0.18*Math.abs(Math.sin(a*63+ph[3]))+0.1*Math.sin(a*140+ph[4]):0);
    const y=h0+(h1-h0)*clamp(n,0,1);pos.push(Math.cos(a)*r,y,Math.sin(a)*r,Math.cos(a)*r,-400,Math.sin(a)*r);if(j){const o=2*(j-1);idx.push(o,o+1,o+2,o+1,o+3,o+2);}}
  const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(pos,3));g.setIndex(idx);
  const m=new THREE.Mesh(g,new THREE.MeshBasicMaterial({color:col,side:THREE.DoubleSide,fog:false,depthWrite:false}));m.renderOrder=-9+k;m.frustumCulled=false;m.userData={base:new THREE.Color(col),haze};sky.add(m);return m;});
/* Daytime. The sun is the key light (it casts the shadows), the sky a blue hemisphere light over green ground.
   The sky dome: deep blue at the zenith, paler towards the horizon where the path through the air is longest
   (Rayleigh scattering), and a white-hazed horizon that the fog colour matches (aerial perspective). A bright
   disc and halo mark the sun. Rain turns it overcast: a flat grey sky, a dimmer and diffuse sun. Fog whitens it. */
const SUN_DIR=new THREE.Vector3(-18,42,12).normalize();
const SM={tex:null,box:new THREE.Vector4(0,0,1,1),k:{value:0.62}};   // baked sun-shadow mask (see bakeShadows)
function paintSky(rain){
  curRain=rain;if(MATS&&MATS.road)wetRoad(rain);
  // fog droplets scatter sunlight in every direction: a bright white-grey veil that, ~300 m thick, hides the sky
  const fg=curFog,V=fogMOR(fg),veil=isFinite(V)?1-Math.exp(-3*300/V):0;
  const fogc=new THREE.Color(0xaec3d8).lerp(new THREE.Color(0x98a1a9),rain).lerp(new THREE.Color(0xc4c9cd),clamp(fg*1.2,0,0.85));
  scene.fog.color.copy(fogc);FOG_BASE.copy(fogc);scene.background.copy(fogc);
  const top=new THREE.Color(0x1d56b0).lerp(new THREE.Color(0x7c848c),rain), mid=new THREE.Color(0x4f8fd6).lerp(new THREE.Color(0x8e959c),rain),
    sunc=new THREE.Color(0xfff4dc).multiplyScalar(1-0.85*rain), P=skyGeo.attributes.position, C=skyGeo.attributes.color, c=new THREE.Color(), d=new THREE.Vector3();
  for(let i=0;i<P.count;i++){d.set(P.getX(i),P.getY(i),P.getZ(i)).normalize();const e=d.y;
    if(e<=0)c.copy(fogc);else c.copy(fogc).lerp(mid,Math.min(1,e*9)).lerp(top,Math.pow(clamp((e-0.08)/0.92,0,1),0.5));
    const cs=Math.max(0,d.dot(SUN_DIR)),g=Math.pow(cs,600)*3+Math.pow(cs,40)*0.35+Math.pow(cs,6)*0.12;   // disc, halo, glare
    c.r+=sunc.r*g;c.g+=sunc.g*g;c.b+=sunc.b*g;c.lerp(fogc,veil);C.setXYZ(i,c.r,c.g,c.b);}
  C.needsUpdate=true;
  for(const m of HILLS)m.material.color.copy(m.userData.base).lerp(fogc,clamp(m.userData.haze+rain*0.4+veil,0,0.98));
  // light: full sun on a clear day; under rain clouds or in fog the direct sun fades and the sky light greys. The
  // environment map already lights every surface with the sky, so the hemisphere light only adds a little bounce.
  const sunK=(1-0.8*rain)*(1-0.85*veil);key.intensity=2.6*sunK;SM.k.value=0.62*sunK;
  hemi.intensity=0.3+0.35*(1-sunK);hemi.color.set(0xbcd4ec).lerp(new THREE.Color(0xc2c7cc),Math.max(rain,veil));
}
const hemi=new THREE.HemisphereLight(0xbcd4ec,0x56603f,0.3);scene.add(hemi);
// the sun: a key light that follows the car (so its shadow map stays sharp around it) and casts the shadows you
// see under cars and in the cockpit
const key=new THREE.DirectionalLight(0xfff4e5,2.3);key.castShadow=true;key.shadow.mapSize.set(2048,2048);
{const c=key.shadow.camera;c.left=-32;c.right=32;c.top=32;c.bottom=-32;c.near=1;c.far=140;}key.shadow.bias=-0.0004;key.shadow.normalBias=0.03;
scene.add(key,key.target);
// reflections: an environment map rendered from the same twilight sky plus a ring of floodlight panels, so cars
// and the wet road reflect the circuit's lights (no city)
const pmrem=new THREE.PMREMGenerator(renderer);
let ENV=null;const ENVK=0.85;
const ENV_MATS=new Set();   // every material lit by the environment, so a new reflection capture can be swapped in
function applyEnv(root){if(!ENV||!root)return;root.traverse(o=>{const ms=o.material?(Array.isArray(o.material)?o.material:[o.material]):[];
  for(const m of ms){if(!m.isMeshStandardMaterial||m.userData.envDone||m.userData.noEnv)continue;m.userData.envDone=true;m.envMap=ENV;m.envMapIntensity=(m.envMapIntensity||1)*ENVK;m.needsUpdate=true;ENV_MATS.add(m);}});}
/* Reflection probe: a cube camera ~1.3 m above the car renders the real surroundings (grandstands, trees, rails,
   other cars, the sky) every ~20 frames, without tone mapping (the materials tone-map once, on screen) and
   without the car itself. PMREM prefilters it by roughness, so glossy paint mirrors the grandstands sharply and
   rough concrete gets a soft blur of the same light, with the Fresnel rise at grazing angles from the BRDF. */
const probeRT=new THREE.WebGLCubeRenderTarget(128,{format:THREE.RGBAFormat,generateMipmaps:false}),probeCam=new THREE.CubeCamera(0.5,1500,probeRT);scene.add(probeCam);
let probeN=0,probeOld=null;
function updateProbe(){if((probeN++)%20||!ENV_MATS.size)return;
  player.getWorldPosition(probeCam.position);probeCam.position.y+=1.3;
  const tm=renderer.toneMapping,sh=renderer.shadowMap.autoUpdate,vis=[player.visible,playerGLB&&playerGLB.visible,debPts.visible,rainL.visible];
  renderer.toneMapping=THREE.NoToneMapping;renderer.shadowMap.autoUpdate=false;player.visible=false;if(playerGLB)playerGLB.visible=false;debPts.visible=false;rainL.visible=false;
  probeCam.update(renderer,scene);
  renderer.toneMapping=tm;renderer.shadowMap.autoUpdate=sh;player.visible=vis[0];if(playerGLB)playerGLB.visible=vis[1];debPts.visible=vis[2];rainL.visible=vis[3];
  const rt=pmrem.fromCubemap(probeRT.texture);for(const m of ENV_MATS)m.envMap=rt.texture;
  if(probeOld)probeOld.dispose();probeOld=rt;}
function buildEnv(){
  const es=new THREE.Scene(),s2=new THREE.Mesh(skyGeo,skyMat);s2.scale.setScalar(60/SKY_R);es.add(s2);
  const gd=new THREE.Mesh(new THREE.CircleGeometry(58,32),new THREE.MeshBasicMaterial({color:0x4d5a3c}));gd.rotation.x=-Math.PI/2;gd.position.y=-1.2;es.add(gd);
  ENV=pmrem.fromScene(es,0.02,0.1,200).texture;
}
let composer=null,bloom=null,lensPass=null;
try{if(THREE.EffectComposer&&THREE.UnrealBloomPass){
  const rt=THREE.WebGLMultisampleRenderTarget&&renderer.capabilities.isWebGL2?new THREE.WebGLMultisampleRenderTarget(960,540,{format:THREE.RGBAFormat}):undefined;
  composer=new THREE.EffectComposer(renderer,rt);composer.addPass(new THREE.RenderPass(scene,camera));
  bloom=new THREE.UnrealBloomPass(new THREE.Vector2(960,540),0.22,0.4,0.97);composer.addPass(bloom);
  /* what a real camera adds: lateral chromatic aberration growing towards the edges (a lens bends blue more than
     red), cos^4-like vignetting, a restrained grade (a little less saturation, cooler shadows, warmer floodlit
     highlights, a gentle toe). No grain or other noise. Runs on the tone-mapped linear image, before gamma. */
  lensPass=new THREE.ShaderPass({uniforms:{tDiffuse:{value:null},uTime:{value:0},uRes:{value:new THREE.Vector2(960,540)}},
    vertexShader:'varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
    fragmentShader:`uniform sampler2D tDiffuse;uniform float uTime;uniform vec2 uRes;varying vec2 vUv;
      void main(){vec2 d=vUv-0.5;float r2=dot(d,d);vec2 o=d*r2*0.010;
        vec3 c=vec3(texture2D(tDiffuse,vUv+o).r,texture2D(tDiffuse,vUv).g,texture2D(tDiffuse,vUv-o).b);
        float l=dot(c,vec3(0.2126,0.7152,0.0722));c=mix(vec3(l),c,0.86);
        c*=mix(vec3(0.95,0.99,1.05),vec3(1.04,1.0,0.95),smoothstep(0.03,0.5,l));
        c=c*c*(3.0-2.0*c)*0.18+c*0.82;
        float cs=cos(clamp(length(d*vec2(uRes.x/uRes.y,1.0))*0.62,0.0,1.5));c*=mix(1.0,cs*cs*cs*cs,0.55);
        gl_FragColor=vec4(max(c,0.0),1.0);}`});
  composer.addPass(lensPass);
  composer.addPass(new THREE.ShaderPass(THREE.GammaCorrectionShader));}}catch(e){composer=null;}

function canvasTex(w,h,draw){const cv=document.createElement('canvas');cv.width=w;cv.height=h;draw(cv.getContext('2d'),w,h);
  const t=new THREE.CanvasTexture(cv);t.encoding=THREE.sRGBEncoding;t.wrapS=t.wrapT=THREE.RepeatWrapping;t.anisotropy=Math.min(8,renderer.capabilities.getMaxAnisotropy());return t;}
function noise(c,w,h,amt,rnd){const im=c.getImageData(0,0,w,h),d=im.data;for(let i=0;i<d.length;i+=4){const n=(rnd()-0.5)*amt;d[i]+=n;d[i+1]+=n;d[i+2]+=n;}c.putImageData(im,0,0);}
const R0=mulberry(11);
const roadTex=canvasTex(256,512,(c,w,h)=>{
  c.fillStyle='#3a3e44';c.fillRect(0,0,w,h);noise(c,w,h,30,R0);
  const g=c.createLinearGradient(0,0,w,0);g.addColorStop(0.2,'rgba(0,0,0,0)');g.addColorStop(0.5,'rgba(8,8,10,.35)');g.addColorStop(0.8,'rgba(0,0,0,0)');c.fillStyle=g;c.fillRect(0,0,w,h);
  for(let k=0;k<16;k++){c.fillStyle='rgba(150,170,190,.07)';c.beginPath();c.ellipse(R0()*w,R0()*h,10+R0()*40,20+R0()*80,0,0,TAU);c.fill();}
  c.fillStyle='#e8ecef';c.fillRect(w*0.035,0,w*0.022,h);c.fillRect(w*0.943,0,w*0.022,h);
});
/* Grass: blades drawn one by one in a spread of greens and lengths, darker between the tufts, so the verge reads
   as turf up close; a matching normal map from the same blade field. Mowing stripes come from the vertex colours. */
const GRASS=(()=>{const W=512,r=mulberry(23),hgt=new Float32Array(W*W),cv=document.createElement('canvas');cv.width=cv.height=W;const c=cv.getContext('2d');
  c.fillStyle="#2a3f20";c.fillRect(0,0,W,W);
  for(let k=0;k<26000;k++){const x=r()*W,y=r()*W,len=3+r()*9,a=-Math.PI/2+(r()-0.5)*0.9,g=70+r()*55,rr=38+r()*32,bb=24+r()*22,ex=x+Math.cos(a)*len,ey=y+Math.sin(a)*len;
    c.strokeStyle=`rgba(${rr|0},${g|0},${bb|0},${0.55+r()*0.4})`;c.lineWidth=0.7+r()*0.9;c.beginPath();c.moveTo(x,y);c.lineTo(ex,ey);c.stroke();
    for(let t=0;t<=1;t+=0.25){const px=((x+(ex-x)*t)|0+W)%W,py=((y+(ey-y)*t)|0+W)%W;hgt[py*W+px]=Math.max(hgt[py*W+px],t);}}
  for(let k=0;k<400;k++){c.fillStyle=`rgba(${20+r()*30|0},${40+r()*40|0},15,.35)`;c.beginPath();c.ellipse(r()*W,r()*W,2+r()*6,2+r()*6,0,0,TAU);c.fill();}
  const map=new THREE.CanvasTexture(cv);map.encoding=THREE.sRGBEncoding;map.wrapS=map.wrapT=THREE.RepeatWrapping;map.anisotropy=Math.min(8,renderer.capabilities.getMaxAnisotropy());
  const nc=document.createElement('canvas');nc.width=nc.height=W;const nx=nc.getContext('2d'),img=nx.createImageData(W,W);
  for(let y=0;y<W;y++)for(let x=0;x<W;x++){const i=y*W+x,dx=(hgt[y*W+(x+1)%W]-hgt[y*W+(x-1+W)%W])*1.5,dy=(hgt[((y+1)%W)*W+x]-hgt[((y-1+W)%W)*W+x])*1.5,l=Math.hypot(dx,dy,1);
    img.data[i*4]=(-dx/l*0.5+0.5)*255;img.data[i*4+1]=(-dy/l*0.5+0.5)*255;img.data[i*4+2]=(1/l*0.5+0.5)*255;img.data[i*4+3]=255;}
  nx.putImageData(img,0,0);const nrm=new THREE.CanvasTexture(nc);nrm.wrapS=nrm.wrapT=THREE.RepeatWrapping;return {map,nrm};})();
// gravel trap: rounded river stones in greys and ochres, each with a lit top and a shadowed underside
const gravelTex=canvasTex(256,256,(c,w,h)=>{const r=mulberry(29);c.fillStyle='#6f6352';c.fillRect(0,0,w,h);
  for(let k=0;k<2600;k++){const x=r()*w,y=r()*h,rad=1+r()*2.6,t=150+r()*70,col=`rgb(${t|0},${(t*0.92)|0},${(t*0.78)|0})`;
    c.fillStyle='rgba(30,26,20,.45)';c.beginPath();c.ellipse(x+0.6,y+0.9,rad,rad*0.8,0,0,TAU);c.fill();
    c.fillStyle=col;c.beginPath();c.ellipse(x,y,rad,rad*0.8,r()*3,0,TAU);c.fill();}
  noise(c,w,h,16,r);});
// grandstand crowd: one row of spectators per tier, lit by the floodlights
// grandstand crowd: one seat row per tier. Small figures (heads ~9 px on a 1.15 m row), mostly dark and muted
// clothes with a few team colours, some empty seats, all a little soft, like people 30-80 m away at night
const crowdTex=canvasTex(1024,64,(c,w,h)=>{const r=mulberry(17),shirts=['#2b2f36','#3a3f47','#1f2329','#4a4e55','#5b2a2a','#1d3557','#6b6f75','#8a1c1c','#d4552a','#e8e4da','#20456b','#3d5a3a'],
    skin=['#c99b7a','#a8775a','#7a5238','#4f3322','#dcb495'],seat=['#23303f','#2a3a4c'];
  c.fillStyle='#14171c';c.fillRect(0,0,w,h);for(let x=0;x<w;x+=11){c.fillStyle=seat[(x/11)%2|0];c.fillRect(x,34,9,26);}
  for(let x=4;x<w;x+=7+r()*4){if(r()<0.14)continue;const y=14+r()*5,sh=shirts[(r()*shirts.length)|0];
    c.fillStyle=sh;c.beginPath();c.moveTo(x-5,64);c.lineTo(x-4.5,y+9);c.quadraticCurveTo(x,y+6,x+4.5,y+9);c.lineTo(x+5,64);c.fill();
    c.fillStyle='rgba(0,0,0,.25)';c.fillRect(x+1,y+10,4,54-y);
    c.fillStyle=skin[(r()*skin.length)|0];c.beginPath();c.ellipse(x,y+3,2.6,3.1,0,0,TAU);c.fill();
    c.fillStyle=r()<0.5?'#1a1410':'#3b2a1c';c.beginPath();c.ellipse(x,y+1.2,2.7,1.8,0,Math.PI,TAU);c.fill();
    if(r()<0.06){c.strokeStyle=sh;c.lineWidth=2;c.beginPath();c.moveTo(x+3,y+10);c.lineTo(x+6,y-6);c.stroke();}}
  c.filter='blur(0.6px)';c.drawImage(c.canvas,0,0);c.filter='none';
  const g=c.createLinearGradient(0,0,0,h);g.addColorStop(0,'rgba(0,0,0,.35)');g.addColorStop(0.5,'rgba(0,0,0,0)');c.fillStyle=g;c.fillRect(0,0,w,h);});
// corrugated steel for the roofs: ribs every 20 cm, lit on one flank
const roofTex=canvasTex(256,64,(c,w,h)=>{for(let x=0;x<w;x++){const t=Math.sin(x/w*TAU*16),v=150+50*t;c.fillStyle=`rgb(${v|0},${(v+4)|0},${(v+8)|0})`;c.fillRect(x,0,1,h);}noise(c,w,h,10,mulberry(31));});
// trees: a canopy of leaf clusters (dark greens, lit from above) on a thin trunk, drawn on a cut-out card
const treeTex=(()=>{const cv=document.createElement('canvas');cv.width=256;cv.height=512;const c=cv.getContext('2d'),r=mulberry(41);
  c.fillStyle='#2a2119';c.beginPath();c.moveTo(122,512);c.lineTo(126,250);c.lineTo(130,250);c.lineTo(134,512);c.fill();
  for(let k=0;k<7;k++){c.strokeStyle='#2a2119';c.lineWidth=3-k*0.3;c.beginPath();c.moveTo(128,380-k*28);c.lineTo(128+(r()-0.5)*150,300-k*34);c.stroke();}
  for(let k=0;k<900;k++){const a=r()*TAU,rr=Math.sqrt(r()),x=128+Math.cos(a)*rr*108,y=200+Math.sin(a)*rr*170-(1-rr)*10,s=6+r()*12,top=1-(y-30)/340;
    const g=c.createRadialGradient(x-s*0.3,y-s*0.4,0,x,y,s),b=18+top*38+r()*18;
    g.addColorStop(0,`rgba(${(b*0.8)|0},${(b*1.45)|0},${(b*0.55)|0},1)`);g.addColorStop(1,`rgba(${(b*0.35)|0},${(b*0.7)|0},${(b*0.3)|0},0)`);
    c.fillStyle=g;c.beginPath();c.arc(x,y,s,0,TAU);c.fill();}
  const t=new THREE.CanvasTexture(cv);t.encoding=THREE.sRGBEncoding;t.anisotropy=4;return t;})();
// timing tower: running order as a column of tracker codes
const towerTex=canvasTex(64,256,(c,w,h)=>{c.fillStyle='#07090c';c.fillRect(0,0,w,h);const codes=['ALP','BRV','CHL','DLT','ECH','FOX','GLF','HTL','IND','JLT'];
  c.font='700 13px "B612 Mono",monospace';c.textBaseline='middle';codes.forEach((cd,i)=>{const y=14+i*24;c.fillStyle='#ffd02a';c.fillText(String(i+1),5,y);c.fillStyle='#eef2f5';c.fillText(cd,24,y);});});
const glowTex=canvasTex(64,64,(c,w,h)=>{const g=c.createRadialGradient(32,32,0,32,32,32);g.addColorStop(0,'rgba(255,255,255,1)');g.addColorStop(0.25,'rgba(255,255,255,.45)');g.addColorStop(1,'rgba(255,255,255,0)');c.fillStyle=g;c.fillRect(0,0,w,h);});
const streakTex=canvasTex(32,256,(c,w,h)=>{for(let y=0;y<h;y++){const a=Math.pow(y/h,1.6);const g=c.createLinearGradient(0,0,w,0);g.addColorStop(0,'rgba(255,255,255,0)');g.addColorStop(0.5,'rgba(255,255,255,'+a+')');g.addColorStop(1,'rgba(255,255,255,0)');c.fillStyle=g;c.fillRect(0,y,w,1);}});
streakTex.wrapS=streakTex.wrapT=THREE.ClampToEdgeWrapping;
const roadNormal=canvasTex(256,512,(c,w,h)=>{const img=c.createImageData(w,h),hgt=new Float32Array(w*h),r=mulberry(9);
  for(let i=0;i<w*h;i++)hgt[i]=r();for(let k=0;k<2;k++)for(let y=1;y<h-1;y++)for(let x=1;x<w-1;x++){const i=y*w+x;hgt[i]=(hgt[i]*2+hgt[i-1]+hgt[i+1]+hgt[i-w]+hgt[i+w])/6;}
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){const i=y*w+x,dx=(hgt[y*w+(x+1)%w]-hgt[y*w+(x-1+w)%w])*6,dy=(hgt[((y+1)%h)*w+x]-hgt[((y-1+h)%h)*w+x])*6,l=Math.hypot(dx,dy,1);
    img.data[i*4]=(-dx/l*0.5+0.5)*255;img.data[i*4+1]=(-dy/l*0.5+0.5)*255;img.data[i*4+2]=(1/l*0.5+0.5)*255;img.data[i*4+3]=255;}c.putImageData(img,0,0);});
roadNormal.encoding=THREE.LinearEncoding;
const roadRough=canvasTex(256,512,(c,w,h)=>{c.fillStyle='rgb(185,185,185)';c.fillRect(0,0,w,h);const r=mulberry(4);
  for(let k=0;k<40;k++){const x=r()*w,y=r()*h,rx=8+r()*40,ry=20+r()*90,g=c.createRadialGradient(x,y,0,x,y,Math.max(rx,ry));g.addColorStop(0,'rgba(70,70,70,.9)');g.addColorStop(1,'rgba(70,70,70,0)');c.fillStyle=g;c.beginPath();c.ellipse(x,y,rx,ry,0,0,TAU);c.fill();}
  const g2=c.createLinearGradient(0,0,w,0);g2.addColorStop(0.3,'rgba(60,60,60,0)');g2.addColorStop(0.5,'rgba(60,60,60,.5)');g2.addColorStop(0.7,'rgba(60,60,60,0)');c.fillStyle=g2;c.fillRect(0,0,w,h);});
roadRough.encoding=THREE.LinearEncoding;
/* Hot-dip galvanised steel: the zinc sets in "spangle" crystals ~1-3 cm across, each a flat facet at its own angle,
   so neighbouring crystals reflect a little differently. A Voronoi tiling (fixed seeds, 0.6 m tile, ~4.5 cm crystals) gives each
   crystal its own roughness (0.25-0.5) and a barely different brightness. */
const SPANGLE=(()=>{const W=256,r=mulberry(53),seeds=[];for(let k=0;k<180;k++)seeds.push([r()*W,r()*W,0.25+0.25*r(),0.9+0.1*r()]);
  const rc=document.createElement('canvas'),mc=document.createElement('canvas');rc.width=rc.height=mc.width=mc.height=W;
  const ri=rc.getContext('2d').createImageData(W,W),mi=mc.getContext('2d').createImageData(W,W);
  for(let y=0;y<W;y++)for(let x=0;x<W;x++){let best=1e9,b=null;for(const q of seeds){let dx=Math.abs(x-q[0]),dy=Math.abs(y-q[1]);dx=Math.min(dx,W-dx);dy=Math.min(dy,W-dy);const d=dx*dx+dy*dy;if(d<best){best=d;b=q;}}
    const o=(y*W+x)*4,rv=b[2]*255,mv=b[3]*255;ri.data[o]=ri.data[o+1]=ri.data[o+2]=rv;ri.data[o+3]=255;mi.data[o]=mi.data[o+1]=mi.data[o+2]=mv;mi.data[o+3]=255;}
  rc.getContext('2d').putImageData(ri,0,0);mc.getContext('2d').putImageData(mi,0,0);
  const mk=(c,srgb)=>{const t=new THREE.CanvasTexture(c);t.wrapS=t.wrapT=THREE.RepeatWrapping;t.anisotropy=8;if(srgb)t.encoding=THREE.sRGBEncoding;return t;};
  return {rough:mk(rc,false),map:mk(mc,true)};})();
const texL=new THREE.TextureLoader();
function pbrTex(url,srgb,rx,ry,cb){return texL.load(url,t=>{t.wrapS=t.wrapT=THREE.RepeatWrapping;t.repeat.set(rx,ry);t.anisotropy=Math.min(8,renderer.capabilities.getMaxAnisotropy());if(srgb)t.encoding=THREE.sRGBEncoding;if(cb)cb(t);});}
const MATS={
  road:new THREE.MeshPhysicalMaterial({map:roadTex,color:0x8a9098,roughness:1,roughnessMap:roadRough,normalMap:roadNormal,normalScale:new THREE.Vector2(0.12,0.12),metalness:0.0,vertexColors:true,envMapIntensity:0.35,clearcoat:0,clearcoatRoughness:0.3,clearcoatRoughnessMap:roadRough}),
  line:new THREE.MeshStandardMaterial({color:0xd9dde0,roughness:0.8,vertexColors:true,polygonOffset:true,polygonOffsetFactor:-3}),
  // galvanised steel guardrail (W-beam rails on posts): a bright, fairly smooth metal that mirrors the floodlights
  rail:new THREE.MeshStandardMaterial({color:0xc4c9ce,metalness:0.85,roughness:1,roughnessMap:SPANGLE.rough,map:SPANGLE.map,vertexColors:true,side:THREE.DoubleSide,envMapIntensity:1.0}),
  post:new THREE.MeshStandardMaterial({color:0x8e959c,metalness:0.8,roughness:0.5,envMapIntensity:0.8}),
  steel:new THREE.MeshStandardMaterial({color:0x6d747b,metalness:0.75,roughness:0.45,envMapIntensity:0.7}),
  aisle:new THREE.MeshStandardMaterial({color:0xb7bbc0,roughness:0.85,envMapIntensity:0.2}),
  // occlusion falloff across the strip (v = 1 at the rail's foot): opacity ~ (v)^1.5, black, over the grass
  contact:new THREE.MeshBasicMaterial({color:0x000000,transparent:true,opacity:0.55,depthWrite:false,polygonOffset:true,polygonOffsetFactor:-3,
    alphaMap:(()=>{const t=canvasTex(4,64,(c,w,h)=>{for(let y=0;y<h;y++){const v=1-y/(h-1),a=Math.pow(v,1.5);c.fillStyle=`rgb(${a*255|0},${a*255|0},${a*255|0})`;c.fillRect(0,y,w,1);}});t.encoding=THREE.LinearEncoding;t.wrapS=t.wrapT=THREE.ClampToEdgeWrapping;return t;})()}),
  gravel:new THREE.MeshStandardMaterial({map:gravelTex,vertexColors:true,roughness:0.95,envMapIntensity:0.15,polygonOffset:true,polygonOffsetFactor:-2}),
  kerb:new THREE.MeshStandardMaterial({vertexColors:true,roughness:0.45,side:THREE.DoubleSide,polygonOffset:true,polygonOffsetFactor:-2}),
  ground:new THREE.MeshStandardMaterial({color:0x3a4a33,map:GRASS.map,roughness:1,envMapIntensity:0.1}),
  stand:new THREE.MeshStandardMaterial({color:0xd6d9dc,roughness:0.9,side:THREE.DoubleSide,envMapIntensity:0.3,map:pbrTex('/assets/concrete_diff.jpg',true,1,1)}),
  crowd:new THREE.MeshStandardMaterial({map:crowdTex,emissive:0xffffff,emissiveMap:crowdTex,emissiveIntensity:0.02,roughness:0.95,side:THREE.DoubleSide}),
  roof:new THREE.MeshStandardMaterial({color:0xaeb3b8,map:roofTex,roughness:0.5,metalness:0.7,side:THREE.DoubleSide}),
  lit:new THREE.MeshStandardMaterial({color:0x40505e,roughness:0.15,metalness:0.6,side:THREE.DoubleSide}),
  glass:new THREE.MeshStandardMaterial({color:0x0c1520,emissive:0x5f86b0,emissiveIntensity:0.04,roughness:0.1,metalness:0.8,side:THREE.DoubleSide}),
  tower:new THREE.MeshBasicMaterial({map:towerTex}),
  verge:new THREE.MeshStandardMaterial({vertexColors:true,map:GRASS.map,normalMap:GRASS.nrm,normalScale:new THREE.Vector2(0.9,0.9),roughness:0.92,envMapIntensity:0.12,side:THREE.DoubleSide}),
  mast:new THREE.MeshStandardMaterial({color:0x3a4048,roughness:0.6,metalness:0.5}),
  flood:new THREE.MeshStandardMaterial({color:0x9aa1a8,metalness:0.5,roughness:0.4}),
  tree:new THREE.MeshStandardMaterial({color:0xffffff,map:treeTex,alphaTest:0.42,side:THREE.DoubleSide,roughness:0.95,envMapIntensity:0.1}),
  trunk:new THREE.MeshStandardMaterial({color:0x2a2119,roughness:1}),
  pit:new THREE.MeshStandardMaterial({color:0x2b2e33,roughness:0.7,envMapIntensity:0.4}),
  grn:new THREE.MeshBasicMaterial({color:0x22ff77}),
  glow:new THREE.SpriteMaterial({map:glowTex,color:0xffeed6,blending:THREE.AdditiveBlending,depthWrite:false,transparent:true,opacity:0.5,fog:true}),
  streak:new THREE.MeshBasicMaterial({map:streakTex,color:0xffe4c0,blending:THREE.AdditiveBlending,depthWrite:false,transparent:true,opacity:0.32,fog:true,polygonOffset:true,polygonOffsetFactor:-4})
};
let trackGroup=null, STREAKS=[], FOOT=[], GRAV=[null,null], CASTERS=[];   // CASTERS: outlines of static structures for the baked sun shadows   // gravel-trap weight per sample, left / right
paintSky(0.6);buildEnv();
// swap in the real scanned asphalt once it has loaded (one tile ~ 4 m); puddle roughness stays from our own map
pbrTex('/assets/asphalt_diff.jpg',true,3.3,10,t=>{MATS.road.map=t;MATS.road.userData.dry=0x9aa0a6;wetRoad(curRain);MATS.road.needsUpdate=true;});
pbrTex('/assets/asphalt_nor.jpg',false,3.3,10,t=>{MATS.road.normalMap=t;MATS.road.normalScale.set(0.9,0.9);MATS.road.needsUpdate=true;});
pbrTex('/assets/asphalt_rough.jpg',false,3.3,10,t=>{MATS.road.roughnessMap=t;wetRoad(curRain);MATS.road.needsUpdate=true;});
/* wet track: water darkens asphalt (less diffuse light escapes a wet surface), fills the texture so the base goes
   smoother, and lies on top as a film that mirrors the floodlights: a clear coat whose strength follows the rain,
   glossiest where the puddle map says water stands. Kerbs and paint get slippery-shiny too. */
/* Standing water, in the road's shader (world space, so it never repeats with the 4 m asphalt tile): puddles from
   two octaves of noise, deeper towards the edges where the camber drains the water, thinner on the rubbered racing
   line that the cars keep squeegeeing. Puddles go dark and mirror-smooth (clear coat), and rain drops ring on them. */
MATS.road.onBeforeCompile=sh=>{
  sh.uniforms.uRain={value:curRain};sh.uniforms.uTime={value:0};MATS.road.userData.shader=sh;
  sh.vertexShader=sh.vertexShader.replace('#include <common>','#include <common>\nattribute float aRl;varying vec3 vWPos;varying float vRoadU;varying float vRl;')
    .replace('#include <project_vertex>','#include <project_vertex>\nvWPos=(modelMatrix*vec4(transformed,1.0)).xyz;vRoadU=uv.x;vRl=aRl;');
  sh.fragmentShader=sh.fragmentShader.replace('#include <common>',`#include <common>
uniform float uRain;uniform float uTime;varying vec3 vWPos;varying float vRoadU;varying float vRl;
float wHash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
float wNoise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.0-2.0*f);
  return mix(mix(wHash(i),wHash(i+vec2(1,0)),f.x),mix(wHash(i+vec2(0,1)),wHash(i+vec2(1,1)),f.x),f.y);}
float wFbm(vec2 p){return 0.55*wNoise(p)+0.3*wNoise(p*2.03+5.1)+0.15*wNoise(p*4.1+9.7);}
float gPuddle=0.0,gLine=0.0;
vec2 wRipple(vec2 p,float t){vec2 c=floor(p),f=fract(p)-0.5,o=vec2(wHash(c+3.1),wHash(c+7.7))-0.5,d=f-o*0.6;
  float ph=fract(t*0.8+wHash(c)),r=ph*0.42,dist=length(d),w=sin((dist-r)*48.0)*exp(-abs(dist-r)*22.0)*(1.0-ph);
  return dist>0.001?d/dist*w:vec2(0.0);}`)
    .replace('#include <color_fragment>',`#include <color_fragment>
{float lat=(vRoadU-0.5)*13.2,rl=(vRl-0.5)*13.2,wet=smoothstep(0.12,0.7,uRain);
  gLine=exp(-pow((lat-rl)/1.3,2.0));
  float edge=smoothstep(4.2,6.5,abs(lat)),n=wFbm(vWPos.xz*0.06)*0.7+wFbm(vWPos.xz*0.31+7.0)*0.3;
  gPuddle=smoothstep(0.5,0.64,n+edge*0.3-gLine*0.22+(uRain-0.6)*0.25)*wet;
  diffuseColor.rgb*=(1.0-0.1*gLine)*(1.0-0.42*gPuddle);}`)
    .replace('#include <roughnessmap_fragment>','#include <roughnessmap_fragment>\nroughnessFactor=mix(roughnessFactor,0.03,gPuddle);')
    .replace('#include <normal_fragment_maps>',`#include <normal_fragment_maps>
vec3 wPert=vec3(0.0);if(gPuddle>0.01&&uRain>0.2){vec2 rp=wRipple(vWPos.xz*1.6,uTime)+wRipple(vWPos.xz*2.3+vec2(5.3,1.7),uTime*1.13);
  wPert=(viewMatrix*vec4(rp.x,0.0,rp.y,0.0)).xyz*0.35*gPuddle*uRain;normal=normalize(normal+wPert);}`)
    .replace('#include <clearcoat_normal_fragment_begin>','#include <clearcoat_normal_fragment_begin>\nclearcoatNormal=normalize(clearcoatNormal+wPert);')
    .replace('#include <lights_physical_fragment>',`#include <lights_physical_fragment>
material.clearcoat=mix(material.clearcoat*(1.0-0.35*gLine),1.0,gPuddle);material.clearcoatRoughness=mix(material.clearcoatRoughness,0.02,gPuddle);`);
};
function wetRoad(rain){const m=MATS.road,w=clamp(rain,0,1);if(m.userData.shader)m.userData.shader.uniforms.uRain.value=w;
  m.color.set(m.userData.dry||0x8a9098).multiplyScalar(1-0.5*w);
  m.roughness=1-0.45*w;m.clearcoat=clamp(w*0.9,0,1);m.clearcoatRoughness=0.4-0.3*w;m.envMapIntensity=(0.3+0.25*w)*ENVK;
  MATS.line.roughness=0.8-0.55*w;MATS.kerb.roughness=0.45-0.3*w;MATS.verge.roughness=0.92-0.45*w;MATS.verge.color.setScalar(1-0.35*w);MATS.gravel.color.setScalar(1-0.4*w);MATS.gravel.roughness=0.95-0.5*w;MATS.rail.roughness=1-0.5*w;}
// floodlight masts behind the barrier, alternating sides; lampLight is the light pool they leave on the ground
function lampList(){const out=[];for(let s=10,k=0;s<L-20;s+=64,k++)out.push([s,k%2?1:-1]);return out;}
function lampLight(s,lat){return 1;   // daytime: the floodlights are off and the sun lights everything evenly
  let b=0.42;for(const [ls,sd] of LAMPS){let d=s-ls;if(d>L/2)d-=L;if(d<-L/2)d+=L;if(Math.abs(d)>90)continue;const dl=lat-sd*(WALL+5);b+=0.8*Math.exp(-(d*d+dl*dl*0.5)/(2*26*26));}return Math.min(1.45,b);}
let LAMPS=[];
/* Baked sun shadows of the static structures. The track is flat and the sun fixed, so a structure's shadow on the
   ground is its outline projected along the sun direction: p - SUN_DIR * (p.y - ground) / SUN_DIR.y. The 2D
   convex hulls are painted into a mask over the whole circuit (~0.8 m per texel; the sun's 0.5° disc makes
   penumbrae of 0.1-0.3 m, so the bilinear edge is about right). Ground materials read the mask by world position
   and lose their direct-sun share where it is set (skylight still reaches the shade); rain clouds fade it. */
function hull2(P){P=P.slice().sort((a,b)=>a[0]-b[0]||a[1]-b[1]);const cr=(o,a,b)=>(a[0]-o[0])*(b[1]-o[1])-(a[1]-o[1])*(b[0]-o[0]),lo=[],up=[];
  for(const p of P){while(lo.length>=2&&cr(lo[lo.length-2],lo[lo.length-1],p)<=0)lo.pop();lo.push(p);}
  for(let i=P.length-1;i>=0;i--){const p=P[i];while(up.length>=2&&cr(up[up.length-2],up[up.length-1],p)<=0)up.pop();up.push(p);}
  return lo.slice(0,-1).concat(up.slice(0,-1));}
function bakeShadows(){let x0=1e9,x1=-1e9,z0=1e9,z1=-1e9;for(let i=0;i<N;i+=4){x0=Math.min(x0,PX[i]);x1=Math.max(x1,PX[i]);z0=Math.min(z0,PZ[i]);z1=Math.max(z1,PZ[i]);}
  x0-=420;x1+=420;z0-=420;z1+=420;const S=2048,cv=document.createElement('canvas');cv.width=cv.height=S;const c=cv.getContext('2d');c.fillStyle='#000';c.fillRect(0,0,S,S);
  const sx=S/(x1-x0),sz=S/(z1-z0),kx=SUN_DIR.x/SUN_DIR.y,kz=SUN_DIR.z/SUN_DIR.y;
  // shadow of a solid = hull of its footprint and of every point projected down the sun's rays onto the ground (y 0)
  for(const cs of CASTERS){const g=cs.pts.map(([x,y,z])=>{const h=Math.max(0,y);return [(x-h*kx-x0)*sx,(z-h*kz-z0)*sz];}).concat(cs.pts.map(([x,y,z])=>[(x-x0)*sx,(z-z0)*sz]));
    const hl=hull2(g);if(hl.length<3)continue;c.fillStyle=`rgba(255,255,255,${cs.a})`;c.beginPath();hl.forEach((p,i)=>i?c.lineTo(p[0],p[1]):c.moveTo(p[0],p[1]));c.closePath();c.fill();}
  if(SM.tex)SM.tex.dispose();SM.tex=new THREE.CanvasTexture(cv);SM.tex.flipY=false;SM.tex.wrapS=SM.tex.wrapT=THREE.ClampToEdgeWrapping;SM.box.set(x0,z0,x1-x0,z1-z0);
  for(const m of [MATS.verge,MATS.ground,MATS.road,MATS.gravel,MATS.kerb,MATS.line,MATS.pit,MATS.post])shadowMask(m);}
function shadowMask(m){if(m.userData.sm){m.userData.sm.uSmTex.value=SM.tex;return;}
  const u={uSmTex:{value:SM.tex},uSmBox:{value:SM.box},uSmK:SM.k};m.userData.sm=u;const prev=m.onBeforeCompile;
  m.onBeforeCompile=(sh,r)=>{if(prev)prev.call(m,sh,r);Object.assign(sh.uniforms,u);
    sh.vertexShader='varying vec3 vSmW;\n'+sh.vertexShader.replace('#include <worldpos_vertex>','#include <worldpos_vertex>\nvSmW=(modelMatrix*vec4(transformed,1.0)).xyz;');
    sh.fragmentShader='varying vec3 vSmW;uniform sampler2D uSmTex;uniform vec4 uSmBox;uniform float uSmK;\n'+sh.fragmentShader.replace('#include <map_fragment>',
      '#include <map_fragment>\n{vec2 q=(vSmW.xz-uSmBox.xy)/uSmBox.zw;if(q.x>0.0&&q.x<1.0&&q.y>0.0&&q.y<1.0)diffuseColor.rgb*=1.0-uSmK*texture2D(uSmTex,q).r;}');};
  const key0=m.customProgramCacheKey;m.customProgramCacheKey=()=>(key0?key0.call(m):'')+'|sm';m.needsUpdate=true;}
function buildTrackMeshes(){
  LAMPS=lampList();
  if(trackGroup){scene.remove(trackGroup);trackGroup.traverse(o=>{if(o.geometry)o.geometry.dispose();});}
  trackGroup=new THREE.Group(); scene.add(trackGroup); STREAKS=[]; FOOT=[]; CASTERS=[];
  const step=2, cnt=Math.floor(N/step)+1;
  {const pos=[],uv=[],idx=[],col=[],rl=[];
    for(let k=0;k<=cnt;k++){const ii=Math.min(k*step,N),i=ii%N,s=ii*DS,rx=-TZ[i],rz=TX[i],y=H[i],e=HW+0.6;
      pos.push(PX[i]-rx*e,y,PZ[i]-rz*e,PX[i]+rx*e,y,PZ[i]+rz*e);uv.push(0,s/40,1,s/40);{const r=(LATRL?LATRL[i]:0)/e*0.5+0.5;rl.push(r,r);}
      {const a=lampLight(s,-e),b=lampLight(s,e);col.push(a,a,a*0.95,b,b,b*0.95);}
      if(k>0){const a=2*(k-1),b=a+1,c=2*k,d=c+1;idx.push(a,b,c,b,d,c);}}
    const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(pos,3));g.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));g.setAttribute('color',new THREE.Float32BufferAttribute(col,3));g.setAttribute('aRl',new THREE.Float32BufferAttribute(rl,1));g.setIndex(idx);g.computeVertexNormals();
    const rm=new THREE.Mesh(g,MATS.road);rm.receiveShadow=true;trackGroup.add(rm);}
  /* guardrail: three W-beam rails (0.31 m tall, 83 mm deep, the two ridges facing the track) on posts every 4 m,
     top edge 1.1 m above the ground; gaps where another part of the circuit comes close */
  {const rails=[0.33,0.645,0.955],prof=[];for(let q=0;q<=8;q++){const y=-0.155+q*0.31/8;prof.push([0.04*(1-Math.cos(4*Math.PI*(y+0.155)/0.31)),y]);}
    const p=[],cl=[],ix=[],uv=[],np=prof.length;
    for(const sg of [-1,1]){const G=sg<0?WGL:WGR;
      for(const hc of rails){const base=p.length/3;
        for(let k=0;k<=cnt;k++){const ii=Math.min(k*step,N),i=ii%N,s=ii*DS,b=lampLight(s,sg*WALL);
          for(const [d,y] of prof){const q=worldPos(s,sg*(WALL-d));p.push(q.x,H[i]+hc+y,q.z);cl.push(b*0.85,b*0.85,b*0.85);uv.push(s/0.6,(hc+y)/0.6);}
          const ip=(Math.min((k-1)*step,N))%N;
          if(k>0&&!G[i]&&!G[ip])for(let j=0;j<np-1;j++){const a=base+(k-1)*np+j,c=base+k*np+j;ix.push(a,c,a+1,a+1,c,c+1);}}}}
    const gr=new THREE.BufferGeometry();gr.setAttribute('position',new THREE.Float32BufferAttribute(p,3));gr.setAttribute('color',new THREE.Float32BufferAttribute(cl,3));gr.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));gr.setIndex(ix);gr.computeVertexNormals();
    const rm2=new THREE.Mesh(gr,MATS.rail);rm2.castShadow=true;rm2.receiveShadow=true;trackGroup.add(rm2);
    // contact shadow (ambient occlusion): the rail hides part of the sky and the floodlit surroundings from the
    // ground at its foot, so the grass darkens towards the rail over ~0.6 m on the track side and ~0.4 m behind it
    const sp=[],su=[],si=[];
    for(const sg of [-1,1]){const G=sg<0?WGL:WGR,base=sp.length/3;
      for(let k=0;k<=cnt;k++){const ii=Math.min(k*step,N),i=ii%N,s=ii*DS;
        for(const [o,v] of [[WALL-0.65,0],[WALL,1],[WALL+0.45,0]]){const q=worldPos(s,sg*o);sp.push(q.x,H[i]-0.02,q.z);su.push(0.5,v);}
        const ip=(Math.min((k-1)*step,N))%N;
        if(k>0&&!G[i]&&!G[ip])for(let j=0;j<2;j++){const a=base+3*(k-1)+j,c=base+3*k+j;si.push(a,c,a+1,a+1,c,c+1);}}}
    const gs=new THREE.BufferGeometry();gs.setAttribute('position',new THREE.Float32BufferAttribute(sp,3));gs.setAttribute('uv',new THREE.Float32BufferAttribute(su,2));gs.setIndex(si);
    trackGroup.add(new THREE.Mesh(gs,MATS.contact));}
  {const lp=[],lc=[],li=[];for(const sg of [-1,1]){const base=lp.length/3;
      for(let k=0;k<=cnt;k++){const ii=Math.min(k*step,N),i=ii%N,s=ii*DS;const A=worldPos(s,sg*(HW-0.42)),B=worldPos(s,sg*(HW-0.26));lp.push(A.x,A.y+0.01,A.z,B.x,B.y+0.01,B.z);const b=lampLight(s,sg*HW);lc.push(b,b,b,b,b,b);
        if(k>0){const a=base+2*(k-1),bb=a+1,c2=base+2*k,d=c2+1;li.push(a,bb,c2,bb,d,c2);}}}
    const gl2=new THREE.BufferGeometry();gl2.setAttribute('position',new THREE.Float32BufferAttribute(lp,3));gl2.setAttribute('color',new THREE.Float32BufferAttribute(lc,3));gl2.setIndex(li);gl2.computeVertexNormals();
    const lm=new THREE.Mesh(gl2,MATS.line);lm.receiveShadow=true;trackGroup.add(lm);}
  {const kp=[],kc=[],ki=[],red=new THREE.Color(0xc0262b),wht=new THREE.Color(0xdde2e6);
    for(const cn of CORNERS){const len=wrapS(cn.s1-cn.s0)+24;for(let q=0;q<len;q+=1.5){const s=cn.s0-12+q,n=Math.round(s/1.5);
      for(const sg of [-1,1]){const A=worldPos(s,sg*(HW-1.1)),B=worldPos(s,sg*(HW+0.25)),C=worldPos(s+1.5,sg*(HW-1.1)),D=worldPos(s+1.5,sg*(HW+0.25));
        const b=kp.length/3;kp.push(A.x,A.y+0.03,A.z,B.x,B.y+0.03,B.z,C.x,C.y+0.03,C.z,D.x,D.y+0.03,D.z);
        const col=(n%2)?red:wht;for(let t=0;t<4;t++)kc.push(col.r,col.g,col.b);ki.push(b,b+1,b+2,b+1,b+3,b+2);}}}
    const gk=new THREE.BufferGeometry();gk.setAttribute('position',new THREE.Float32BufferAttribute(kp,3));gk.setAttribute('color',new THREE.Float32BufferAttribute(kc,3));gk.setIndex(ki);gk.computeVertexNormals();
    trackGroup.add(new THREE.Mesh(gk,MATS.kerb));}
  // ---------- Grand Prix surroundings: verges, gravel, pit building, grandstands, floodlights, start gantry, trees ----------
  let minH=1e9;for(let i=0;i<N;i++)minH=Math.min(minH,H[i]);const G0=minH-1.2, far=Math.round(60/DS);
  const gp=new THREE.Mesh(new THREE.PlaneGeometry(9000,9000),MATS.ground);gp.rotation.x=-Math.PI/2;gp.position.y=G0;gp.receiveShadow=true;trackGroup.add(gp);
  // verges: mown grass from the edge of the track, past the guardrail, out to 45 m (less where another part of the
  // circuit is close), then a skirt down to the ground. Gravel traps on the outside of corners, in the run-off.
  {const pos=[],col=[],uvs=[],idx=[],grass=new THREE.Color(0x6f7a62),c=new THREE.Color(),gp2=[],gc=[],gu=[],gi=[];
    for(const sg of [-1,1]){
      const grav=GRAV[sg<0?0:1]=new Float32Array(N);
      for(const cn of CORNERS){if(cn.sg!==-sg)continue;const a=cn.s0-8,b=cn.s1+30+Math.abs(cn.angle)*12;
        for(let q=a;q<=b;q+=DS){const i=Math.floor(wrapS(q)/DS)%N;grav[i]=Math.max(grav[i],clamp(Math.min((q-a)/10,(b-q)/14),0,1));}}
      const base=pos.length/3;
      for(let k=0;k<=cnt;k++){const ii=Math.min(k*step,N),i=ii%N,s=ii*DS;
        let W=45;for(const r of [8,16,26,36,45]){const q=worldPos(s,sg*(WALL+r));if(nearTrack(q.x,q.z,WALL+2,i,far)){W=Math.max(1.5,r-8);break;}}
        const offs=[HW+0.6,WALL,WALL+Math.min(W,20),WALL+W,WALL+W+14],ys=[H[i]-0.03,H[i]-0.05,H[i]-0.12-Math.min(W,20)*0.02,Math.max(G0+0.3,H[i]-0.6-W*0.05),G0];
        const stripe=Math.floor(s/12)%2?1:0.8;
        offs.forEach((o,j)=>{const q=worldPos(s,sg*o),lt=lampLight(s,sg*o);pos.push(q.x,ys[j],q.z);uvs.push(sg*o/2.5,s/2.5);c.copy(grass).multiplyScalar(stripe*lt*(j===4?0.6:1));col.push(c.r,c.g,c.b);});
        if(k>0){const o0=base+5*(k-1),o1=base+5*k;for(let j=0;j<4;j++)idx.push(o0+j,o1+j,o0+j+1,o0+j+1,o1+j,o1+j+1);}
        // gravel: from a metre off the kerb to just short of the rail, tapering in and out with the trap
        const gv=grav[i],gb=gp2.length/3;for(const o of [HW+1.6,lerp(HW+1.6,WALL-1.2,Math.min(1,gv*1.5))]){const q=worldPos(s,sg*o),lt=lampLight(s,sg*o);gp2.push(q.x,H[i]-0.01,q.z);gu.push(sg*o/3,s/3);gc.push(lt,lt,lt);}
        if(k>0&&gv>0.02&&grav[(Math.min((k-1)*step,N))%N]>0.02){const a=gb-2;gi.push(a,gb,a+1,a+1,gb,gb+1);}}}
    const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(pos,3));g.setAttribute('color',new THREE.Float32BufferAttribute(col,3));g.setAttribute('uv',new THREE.Float32BufferAttribute(uvs,2));g.setIndex(idx);g.computeVertexNormals();
    const m=new THREE.Mesh(g,MATS.verge);m.receiveShadow=true;trackGroup.add(m);
    const g2=new THREE.BufferGeometry();g2.setAttribute('position',new THREE.Float32BufferAttribute(gp2,3));g2.setAttribute('color',new THREE.Float32BufferAttribute(gc,3));g2.setAttribute('uv',new THREE.Float32BufferAttribute(gu,2));g2.setIndex(gi);g2.computeVertexNormals();
    const m2=new THREE.Mesh(g2,MATS.gravel);m2.receiveShadow=true;trackGroup.add(m2);}
  // simple geometry batches, one mesh per material
  const GB={},quad=(k,a,b,c,d,uw=1,vh=1)=>{const g=GB[k]||(GB[k]={p:[],u:[],i:[]}),o=g.p.length/3;g.p.push(...a,...b,...c,...d);g.u.push(0,0,uw,0,uw,vh,0,vh);g.i.push(o,o+1,o+2,o,o+2,o+3);};
  // local frame beside the track at s on side sd: x along the track, y up, z away from the track
  const frame=(s,sd,z0,y0)=>{const F=trackFrame(s),ox=-F.tz*sd,oz=F.tx*sd,bx=F.px+ox*z0,bz=F.pz+oz*z0;return (x,y,z)=>[bx+F.tx*x+ox*z,y0+y,bz+F.tz*x+oz*z];};
  const box=(k,P,x0,x1,y0,y1,z0,z1)=>{const U=(x1-x0)/8,V=(y1-y0)/8,Z=(z1-z0)/8;
    quad(k,P(x0,y0,z0),P(x1,y0,z0),P(x1,y1,z0),P(x0,y1,z0),U,V);quad(k,P(x0,y0,z1),P(x1,y0,z1),P(x1,y1,z1),P(x0,y1,z1),U,V);
    quad(k,P(x0,y0,z0),P(x0,y0,z1),P(x0,y1,z1),P(x0,y1,z0),Z,V);quad(k,P(x1,y0,z0),P(x1,y0,z1),P(x1,y1,z1),P(x1,y1,z0),Z,V);
    quad(k,P(x0,y1,z0),P(x1,y1,z0),P(x1,y1,z1),P(x0,y1,z1),U,Z);};
  const taken=[];
  const fits=(P,x0,x1,z0,z1)=>{for(let x=x0;x<=x1+0.01;x+=Math.max(6,(x1-x0)/8))for(const z of [z0,z1]){const q=P(x,0,z);if(nearTrackAny(q[0],q[2],WALL+2.5))return false;}
    const c=P((x0+x1)/2,0,(z0+z1)/2),r=Math.hypot(x1-x0,z1-z0)/2;if(taken.some(t=>Math.hypot(t[0]-c[0],t[1]-c[2])<t[2]+r))return false;
    taken.push([c[0],c[2],r]);FOOT.push({pts:[[x0,z0],[x1,z0],[x1,z1],[x0,z1]].map(([x,z])=>{const q=P(x,0,z);return [q[0],q[2]];})});return true;};
  const hAt=s=>H[Math.floor(wrapS(s)/DS)%N];
  // the eight corners of a box in a local frame (for the baked shadows' outlines)
  const boxPts=(P,x0,x1,y0,y1,z0,z1)=>{const o=[];for(const x of [x0,x1])for(const y of [y0,y1])for(const z of [z0,z1])o.push(P(x,y,z));return o;};
  // guardrail posts every 4 m, just behind the rails
  for(const sg of [-1,1]){const G=sg<0?WGL:WGR;for(let s=0;s<L;s+=4){const i=Math.floor(s/DS)%N;if(G[i])continue;const P=frame(s,sg,WALL+0.08,hAt(s));box('post',P,-0.06,0.06,-0.4,1.02,0,0.1);}}
  // pit lane and pit building along the start straight, timing tower by the line
  let pit=null;
  for(const sd of [1,-1]){for(let len=200;len>=70&&!pit;len-=26){const sc=wrapS(len/2-50),P=frame(sc,sd,WALL,hAt(sc)-0.05);if(!fits(P,-len/2,len/2,3,36))continue;pit={sc,len,sd};
      quad('pit',P(-len/2,0.03,0.4),P(len/2,0.03,0.4),P(len/2,0.03,12.5),P(-len/2,0.03,12.5));
      box('stand',P,-len/2,len/2,0,11,13,29);box('roof',P,-len/2-1,len/2+1,11,11.6,11.5,30);CASTERS.push({pts:boxPts(P,-len/2-1,len/2+1,0,11.6,11.5,30),a:1});
      for(let x=-len/2+3;x<len/2-8;x+=9)quad('lit',P(x,0.2,12.94),P(x+6.6,0.2,12.94),P(x+6.6,4.3,12.94),P(x,4.3,12.94));
      quad('glass',P(-len/2+1,5.4,12.93),P(len/2-1,5.4,12.93),P(len/2-1,9.6,12.93),P(-len/2+1,9.6,12.93));
      const tx=50-len/2-10;box('stand',P,tx-2.2,tx+2.2,0,34,31,35.4);CASTERS.push({pts:boxPts(P,tx-2.2,tx+2.2,0,34,31,35.4),a:1});quad('tower',P(tx-2,9,30.95),P(tx+2,9,30.95),P(tx+2,33,30.95),P(tx-2,33,30.95));}if(pit)break;}
  // start gantry over the line, lights out and the green LEDs on
  {const P=frame(0,1,0,hAt(0)),e=WALL+0.4;for(const z of [-e,e])box('mast',P,-0.3,0.3,0,7.4,z-0.3,z+0.3);box('mast',P,-0.4,0.4,6.4,7.4,-e,e);
    for(let k=-2;k<=2;k++)box('grn',P,-0.45,-0.41,5.7,6.3,k*1.3-0.35,k*1.3+0.35);}
  // grandstands: tiers of spectators behind the barrier, cantilever roof with a lit fascia
  const stand=(P,len,n,run,rise)=>{const x0=-len/2,x1=len/2,y0=2.4,top=y0+n*rise,D=n*run;
    CASTERS.push({pts:boxPts(P,x0-1,x1+1,0,top+5.4,-1.5,D+0.3),a:1});
    quad('stand',P(x0,0,0),P(x1,0,0),P(x1,y0,0),P(x0,y0,0),len/8,1);
    for(let k=0;k<n;k++){const z=k*run,y=y0+k*rise;quad('crowd',P(x0,y,z),P(x1,y,z),P(x1,y+rise,z),P(x0,y+rise,z),len/48,1);
      quad('stand',P(x0,y+rise,z),P(x1,y+rise,z),P(x1,y+rise,z+run),P(x0,y+rise,z+run),len/8,0.2);}
    quad('stand',P(x0,0,D),P(x1,0,D),P(x1,top+4.2,D),P(x0,top+4.2,D),len/8,2);
    for(const x of [x0,x1])quad('stand',P(x,0,0),P(x,0,D),P(x,top+4.2,D),P(x,y0,0));
    quad('roof',P(x0-1,top+4.2,D+0.3),P(x1+1,top+4.2,D+0.3),P(x1+1,top+5.4,-1.5),P(x0-1,top+5.4,-1.5));
    quad('lit',P(x0,top+4.85,-1.45),P(x1,top+4.85,-1.45),P(x1,top+5.25,-1.45),P(x0,top+5.25,-1.45),len/8,1);
    // structure: steel columns carrying the roof at the back and at the front edge, roof beams between them,
    // stair aisles cutting through the tiers, and a railing along the front of the lowest tier
    const bays=Math.max(1,Math.round((len-8)/12));
    for(let b=0;b<=bays;b++){const x=x0+4+(len-8)*b/bays;
      box('steel',P,x-0.18,x+0.18,0,top+4.3,D-0.4,D);
      box('steel',P,x-0.12,x+0.12,y0+n*rise*0.35,top+4.4,-0.6,-0.36);
      box('steel',P,x-0.08,x+0.08,top+4.2,top+4.5,-0.6,D);}
    for(let x=x0+len/6;x<x1-2;x+=len/3)for(let k=0;k<n;k++){const z=k*run,y=y0+k*rise;box('aisle',P,x-0.7,x+0.7,y,y+rise+0.02,z-0.02,z+run);}
    box('steel',P,x0,x1,y0+1.0,y0+1.06,-0.08,-0.02);for(let x=x0;x<=x1;x+=2.5)box('steel',P,x-0.025,x+0.025,y0,y0+1.03,-0.08,-0.02);};
  const rnd=mulberry(3);
  for(let s0=pit?pit.len+30:60;s0<L-(pit?80:60);s0+=64+rnd()*56){const sd=rnd()<0.5?1:-1,n=8+((rnd()*5)|0);let ok=false;
    for(const sd2 of [sd,-sd]){for(const len of [96,72,52]){const P=frame(s0,sd2,WALL+7,hAt(s0)-0.1);if(fits(P,-len/2,len/2,0,n*1.15+1.5)){stand(P,len,n,1.15,0.72);ok=true;break;}}if(ok)break;}}
  {const MK={steel:MATS.steel,aisle:MATS.aisle,post:MATS.post,stand:MATS.stand,crowd:MATS.crowd,roof:MATS.roof,lit:MATS.lit,glass:MATS.glass,tower:MATS.tower,pit:MATS.pit,mast:MATS.mast,grn:MATS.grn};
    for(const k in GB){const g=GB[k],geo=new THREE.BufferGeometry();geo.setAttribute('position',new THREE.Float32BufferAttribute(g.p,3));geo.setAttribute('uv',new THREE.Float32BufferAttribute(g.u,2));geo.setIndex(g.i);geo.computeVertexNormals();
      const m=new THREE.Mesh(geo,MK[k]);m.receiveShadow=true;trackGroup.add(m);}}
  // floodlight masts: 26 m lattice-grey poles, LED heads aimed down the track, glare sprites
  /* lattice towers: four legs tapering from 2.4 m to 0.9 m apart, cross-bracing every 3 m, a platform under the
     LED head (one merged geometry, instanced) */
  const mastG=(()=>{const parts=[],bar=(a,b,r)=>{const A=new THREE.Vector3(...a),B=new THREE.Vector3(...b),g=new THREE.CylinderGeometry(r,r,A.distanceTo(B),4,1,true);
      g.applyMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0,1,0),B.clone().sub(A).normalize())));g.translate((A.x+B.x)/2,(A.y+B.y)/2,(A.z+B.z)/2);parts.push(g);};
    const hw=y=>1.2-0.75*y/26,cn=[[1,1],[1,-1],[-1,-1],[-1,1]],at=(k,y)=>[cn[k][0]*hw(y),y,cn[k][1]*hw(y)];
    for(let k=0;k<4;k++)bar(at(k,0),at(k,26),0.07);
    for(let y=0;y<26;y+=3)for(let k=0;k<4;k++){const j=(k+1)%4;bar(at(k,y),at(j,Math.min(26,y+3)),0.03);bar(at(k,Math.min(26,y+3)),at(j,Math.min(26,y+3)),0.03);}
    const pl=new THREE.BoxGeometry(3,0.15,2);pl.translate(0,26,0);parts.push(pl.toNonIndexed());
    return THREE.BufferGeometryUtils.mergeBufferGeometries(parts.map(g=>g.index?g.toNonIndexed():g));})();
  {
    const masts=new THREE.InstancedMesh(mastG,MATS.mast,LAMPS.length),heads=new THREE.InstancedMesh(new THREE.BoxGeometry(5.2,2.4,0.35),MATS.flood,LAMPS.length),dm=new THREE.Object3D();
    LAMPS.forEach(([s,sd],i)=>{const p=worldPos(s,sd*(WALL+5)),y=hAt(s);
      {const q=[];for(const [dx,dz] of [[-1.2,-1.2],[1.2,-1.2],[1.2,1.2],[-1.2,1.2]])q.push([p.x+dx,y,p.z+dz]);for(const [dx,dz] of [[-0.5,-0.5],[0.5,-0.5],[0.5,0.5],[-0.5,0.5]])q.push([p.x+dx,y+26,p.z+dz]);CASTERS.push({pts:q,a:0.45});
       const h=[];for(const [dx,dz] of [[-2.6,-1.2],[2.6,-1.2],[2.6,1.2],[-2.6,1.2]])for(const dy of [25.8,28])h.push([p.x+dx,y+dy,p.z+dz]);CASTERS.push({pts:h,a:1});}
      dm.position.set(p.x,y,p.z);dm.rotation.set(0,0,0);dm.updateMatrix();masts.setMatrixAt(i,dm.matrix);
      const c=worldPos(s+14,-sd*2);dm.position.set(p.x,y+26.5,p.z);dm.lookAt(c.x,y,c.z);dm.updateMatrix();heads.setMatrixAt(i,dm.matrix);
      });
    trackGroup.add(masts,heads);}
  // trees on the ground plane beyond the verges
  {let mnx=1e9,mxx=-1e9,mnz=1e9,mxz=-1e9;for(let i=0;i<N;i+=4){mnx=Math.min(mnx,PX[i]);mxx=Math.max(mxx,PX[i]);mnz=Math.min(mnz,PZ[i]);mxz=Math.max(mxz,PZ[i]);}
    const r=mulberry(5),pts=[];
    for(let t=0;t<3000&&pts.length<420;t++){const x=mnx-300+r()*(mxx-mnx+600),z=mnz-300+r()*(mxz-mnz+600);
      if(nearTrackAny(x,z,WALL+62)||taken.some(q=>Math.hypot(q[0]-x,q[1]-z)<q[2]+6))continue;pts.push([x,z,6+r()*7,r()]);}
    // two crossed cut-out cards per tree (reads as a full canopy from any side), random turn, size and tint
    const a=new THREE.PlaneGeometry(0.5,1),b=a.clone();a.translate(0,0.5,0);b.translate(0,0.5,0);b.rotateY(Math.PI/2);
    const cross=THREE.BufferGeometryUtils.mergeBufferGeometries([a,b]);
    const crowns=new THREE.InstancedMesh(cross,MATS.tree,pts.length),dm=new THREE.Object3D(),tc=new THREE.Color();
    pts.forEach(([x,z,h,q],i)=>{{const c=[];for(let k=0;k<12;k++){const a=k/12*TAU;for(const hy of [0.35,0.75,1.15])c.push([x+Math.cos(a)*h*0.42*(hy===0.75?1:0.7),G0+h*hy,z+Math.sin(a)*h*0.42*(hy===0.75?1:0.7)]);}
        CASTERS.push({pts:c,a:0.8});CASTERS.push({pts:[[x-0.2,G0,z],[x+0.2,G0,z],[x-0.15,G0+h*0.4,z],[x+0.15,G0+h*0.4,z]],a:1});}
      dm.position.set(x,G0-0.2,z);dm.rotation.set(0,q*TAU,0);dm.scale.set(h*1.1,h*1.25,h*1.1);dm.updateMatrix();crowns.setMatrixAt(i,dm.matrix);
      crowns.setColorAt(i,tc.setHSL(0.22+q*0.08,0.25+q*0.2,0.55+q*0.3));});
    if(pts.length)trackGroup.add(crowns);}
  bakeShadows();
  applyEnv(trackGroup);
}
function nearTrackAny(x,z,r){return PHYS.x.track_near(x,z,r,-1,0)!==0;}

// rain
/* Each drop has a size and falls at its terminal speed. Sizes follow Marshall-Palmer, N(D) ~ exp(-Lambda D) with
   Lambda = 4.1 R^-0.21 per mm for a rain rate R in mm/h, weighted by D^2 because the eye sees a drop's cross-section
   (so D ~ Gamma(3, Lambda)); terminal speed v(D) = 9.65 - 10.3 exp(-0.6 D) m/s (Atlas et al. 1973), 2-9 m/s.
   A streak is the drop's path relative to the eye over one exposure (~1/30 s), so from a car at speed the streaks
   stretch along the direction of travel and grow with speed; falling drops alone make short vertical dashes. */
const RAIN_N=2600, rainPos=new Float32Array(RAIN_N*6), rainBase=new Float32Array(RAIN_N*3), rainV=new Float32Array(RAIN_N), EXPO=1/30;
const rainG=new THREE.BufferGeometry();rainG.setAttribute('position',new THREE.BufferAttribute(rainPos,3));
const rainMat=new THREE.LineBasicMaterial({color:0xa9bfd2,transparent:true,opacity:0.32,fog:true});
const rainL=new THREE.LineSegments(rainG,rainMat);rainL.frustumCulled=false;scene.add(rainL);
let rainInit=false, rainSized=-1;
const rainRate=rain=>1+60*rain*rain;                       // mm/h: drizzle to a tropical downpour
function sizeDrops(rain){const Lm=4.1*Math.pow(rainRate(rain),-0.21),r=mulberry(11);rainSized=rain;
  for(let i=0;i<RAIN_N;i++){const D=clamp(-(Math.log(1-r())+Math.log(1-r())+Math.log(1-r()))/Lm,0.3,6);rainV[i]=9.65-10.3*Math.exp(-0.6*D);}}
function updateRain(dt,cam,vel,rain){
  const n=Math.floor(RAIN_N*clamp(rain*1.1,0.05,1)), B=34, BY=18;
  if(!rainInit){rainInit=true;const r=mulberry(5);for(let i=0;i<RAIN_N;i++){rainBase[i*3]=cam.x+(r()*2-1)*B;rainBase[i*3+1]=cam.y+(r()*2-1)*BY;rainBase[i*3+2]=cam.z+(r()*2-1)*B;}}
  if(Math.abs(rain-rainSized)>0.04)sizeDrops(rain);
  const sx=vel.x*EXPO, sy=vel.y*EXPO, sz=vel.z*EXPO;       // tail = where the drop was, relative to the eye, one exposure ago
  for(let i=0;i<n;i++){const vt=rainV[i];let x=rainBase[i*3],y=rainBase[i*3+1]-vt*dt,z=rainBase[i*3+2];
    if(x-cam.x>B)x-=2*B;else if(x-cam.x<-B)x+=2*B; if(z-cam.z>B)z-=2*B;else if(z-cam.z<-B)z+=2*B; if(y-cam.y<-BY)y+=2*BY;else if(y-cam.y>BY)y-=2*BY;
    rainBase[i*3]=x;rainBase[i*3+1]=y;rainBase[i*3+2]=z;const j=i*6;rainPos[j]=x;rainPos[j+1]=y;rainPos[j+2]=z;rainPos[j+3]=x+sx;rainPos[j+4]=y+sy+vt*EXPO;rainPos[j+5]=z+sz;}
  rainG.setDrawRange(0,n*2);rainG.attributes.position.needsUpdate=true;rainMat.opacity=0.05+0.12*rain;
}
/* Debris off the road: the tyres fling turf and earth (grass) or stones (gravel) up and back. Each piece is
   ballistic: launched at the tread's sliding speed with a random spread, then gravity and air drag. */
const DEB_N=600, debPos=new Float32Array(DEB_N*3), debCol=new Float32Array(DEB_N*3), debVel=new Float32Array(DEB_N*3), debLife=new Float32Array(DEB_N);
const debG=new THREE.BufferGeometry();debG.setAttribute('position',new THREE.BufferAttribute(debPos,3));debG.setAttribute('color',new THREE.BufferAttribute(debCol,3));
const debPts=new THREE.Points(debG,new THREE.PointsMaterial({size:0.07,vertexColors:true,sizeAttenuation:true,fog:true}));debPts.frustumCulled=false;scene.add(debPts);
let debNext=0;const _dw=new THREE.Vector3(),_dc=new THREE.Color(),DEB_COL={2:[0x3f5a2a,0x5a4430,0x2e4520],3:[0x8d8478,0x6e665c,0xa39a8c]};
function updateDebris(dt,w){if(!(dt>0))return;const P=w.player,v=P.v||0,kinds=[P.surfR,P.surfF];
  if(w.opts.driver==='drive'&&v>4)[[1.62,kinds[0]],[-1.8,kinds[1]]].forEach(([z,k])=>{if(k!==2&&k!==3)return;
    const n=Math.min(40,Math.round(dt*v*(k===3?5:3)));
    for(let j=0;j<n;j++){const i=debNext;debNext=(debNext+1)%DEB_N;const sx=Math.random()<0.5?-0.78:0.78;
      _dw.set(sx+(Math.random()-0.5)*0.3,0.05,z+0.3);player.localToWorld(_dw);debPos[i*3]=_dw.x;debPos[i*3+1]=_dw.y;debPos[i*3+2]=_dw.z;
      const back=0.25+0.35*Math.random(),F=player.matrixWorld.elements;   // car's forward is -z: launch backwards and up
      debVel[i*3]=vel.x*(1-back)+F[8]*v*back*0.3+(Math.random()-0.5)*3;debVel[i*3+1]=1.5+Math.random()*(k===3?4:3);debVel[i*3+2]=vel.z*(1-back)+F[10]*v*back*0.3+(Math.random()-0.5)*3;
      const cs=DEB_COL[k];_dc.setHex(cs[(Math.random()*cs.length)|0]).multiplyScalar(0.6+0.5*Math.random());debCol[i*3]=_dc.r;debCol[i*3+1]=_dc.g;debCol[i*3+2]=_dc.b;debLife[i]=1.2+Math.random();}});
  const kd=Math.exp(-dt*0.8);
  for(let i=0;i<DEB_N;i++){if(debLife[i]<=0)continue;debLife[i]-=dt;const b=i*3;debVel[b+1]-=9.81*dt;debVel[b]*=kd;debVel[b+2]*=kd;
    debPos[b]+=debVel[b]*dt;debPos[b+1]+=debVel[b+1]*dt;debPos[b+2]+=debVel[b+2]*dt;if(debPos[b+1]<-50||debLife[i]<=0){debLife[i]=0;debPos[b+1]=-1e4;}}
  debG.attributes.position.needsUpdate=true;debG.attributes.color.needsUpdate=true;}
for(let i=0;i<DEB_N;i++)debPos[i*3+1]=-1e4;
// spray
// tyre spray: particles simulated in physics/spray.c; three.js draws its buffers straight from wasm memory
const spG=new THREE.BufferGeometry();
const sprayMat=new THREE.ShaderMaterial({transparent:true,depthWrite:false,fog:true,
  uniforms:THREE.UniformsUtils.merge([THREE.UniformsLib.fog,{uColor:{value:new THREE.Color(0x8a96a2)},uScale:{value:600}}]),
  vertexShader:'attribute float aSize;attribute float aAlpha;varying float vA;uniform float uScale;\n#include <fog_pars_vertex>\nvoid main(){vec4 mvPosition=modelViewMatrix*vec4(position,1.0);gl_Position=projectionMatrix*mvPosition;gl_PointSize=min(900.0,aSize*uScale/max(0.1,-mvPosition.z));vA=aAlpha;\n#include <fog_vertex>\n}',
  fragmentShader:'uniform vec3 uColor;varying float vA;\n#include <fog_pars_fragment>\nvoid main(){vec2 c=gl_PointCoord-0.5;float d=length(c);float a=smoothstep(0.5,0.05,d)*vA;if(a<0.003)discard;gl_FragColor=vec4(uColor,a);\n#include <fog_fragment>\n}'});
const sprayPts=new THREE.Points(spG,sprayMat);sprayPts.frustumCulled=false;scene.add(sprayPts);
const _v=new THREE.Vector3();
// count droplets from a point on a car (local offset), thrown into the wake of a car moving at vel
function emitSpray(obj,off,vel,count){if(!PHYS.ok||count<=0)return;
  _v.set(off[0],off[1],off[2]);obj.localToWorld(_v);PHYS.x.spray_emit(count,_v.x,_v.y,_v.z,vel.x,vel.z,obj.position.y);}
// a front tyre rolling through the water under it: tread pick-up, a sideways bow wave and mist (physics/spray.c)
const _o=new THREE.Vector3();
function emitTyreSpray(obj,side,vel,count){if(!PHYS.ok||count<=0)return;
  _v.set(side*0.8,0.3,-1.95);obj.localToWorld(_v);_o.set(side,0,0).transformDirection(obj.matrixWorld);
  PHYS.x.spray_emit_tyre(count,_v.x,_v.y,_v.z,vel.x,vel.z,_o.x,_o.z,obj.position.y);}
function updateSpray(dt,rain){if(!PHYS.ok||dt<=0)return;PHYS.x.spray_update(dt,rain);
  for(const k of ['position','aSize','aAlpha'])spG.attributes[k].needsUpdate=true;}

// models
const MAT={carbon:new THREE.MeshStandardMaterial({color:0x14171b,roughness:0.55,metalness:0.2}),tyre:new THREE.MeshStandardMaterial({color:0x0b0b0c,roughness:0.95}),
  rain:new THREE.MeshBasicMaterial({color:0xff2a1f}),glowR:new THREE.SpriteMaterial({map:glowTex,color:0xff3322,blending:THREE.AdditiveBlending,depthWrite:false,transparent:true,fog:true}),
  glowO:new THREE.SpriteMaterial({map:glowTex,color:0xffa21a,blending:THREE.AdditiveBlending,depthWrite:false,transparent:true,fog:true})};
const wheelG=new THREE.CylinderGeometry(0.35,0.35,0.38,18);wheelG.rotateZ(Math.PI/2);
let CAR_GLB=null, playerGLB=null;
function makeCar(col,cockpit){
  if(CAR_GLB&&!cockpit)return addWheelFX(cloneGLBCar(col));
  return addWheelFX(window.buildF1Car({color:col,accent:cockpit?0xff7a2a:0xe8ecef,cockpit,glowTex}));
}
function cloneGLBCar(col){
  const g=new THREE.Group();
  for(const part of CAR_GLB.parts){const mat=part.paint?part.mat.clone():part.mat;if(part.paint){mat.color.set(col);mat.userData={};}
    const m=new THREE.Mesh(part.geo,mat);m.castShadow=true;m.receiveShadow=true;m.userData.keep=true;g.add(m);}
  const rl=new THREE.Mesh(new THREE.BoxGeometry(0.16,0.08,0.03),MAT.rain);rl.position.set(0,CAR_GLB.rearY,CAR_GLB.rearZ);g.add(rl);
  const rg=new THREE.Sprite(MAT.glowR);rg.position.set(0,CAR_GLB.rearY,CAR_GLB.rearZ+0.05);rg.scale.set(0.35,0.35,1);g.add(rg);
  g.userData.rain=[rl,rg];g.userData.front=[];g.userData.wheels=[];
  return g;
}
/* Wheel effects on every car: the compound's band on the tyre sidewalls, and the carbon brake discs glowing
   through the inboard side of the wheels. The glow's colour and brightness come from Planck's law (Wien limit)
   sampled at red, green and blue wavelengths: dull red at ~650 °C, orange towards 1000 °C, and about 30x brighter
   per 100 °C, scaled so a disc at 1000 °C is bright enough for the bloom. Wheel centres match both car models. */
const WHEEL_AT=[[-0.8,-1.8,0.3],[0.8,-1.8,0.3],[-0.78,1.62,0.4],[0.78,1.62,0.4]], WHEEL_R=0.36, BB_L=[0.61,0.55,0.465], BB_C2=14388,
  BB_REF=Math.exp(-BB_C2/(0.61*1273.15))/0.61**5, ringG=new THREE.RingGeometry(WHEEL_R*0.7,WHEEL_R*0.83,48), discG=new THREE.CircleGeometry(WHEEL_R*0.5,28);
function glowColor(Tc,out){const T=Tc+273.15,e=BB_L.map(l=>Math.exp(-BB_C2/(l*T))/l**5),k=4*e[0]/BB_REF;return out.setRGB(k,k*e[1]/e[0],k*e[2]/e[0]);}
let TYRE_MAT=null;
function tyreMat(k){if(!TYRE_MAT)TYRE_MAT=TYRES.map(t=>new THREE.MeshStandardMaterial({color:t.col,roughness:0.6,emissive:t.col,emissiveIntensity:0.06}));return TYRE_MAT[k];}
function addWheelFX(g){
  const fx={rings:[],glow:[],comp:-1},ringBase=new THREE.MeshStandardMaterial({color:0x333333,roughness:0.6}),wl=g.userData.wheels||[];
  WHEEL_AT.forEach(([x,z,wd],i)=>{const sg=Math.sign(x),host=wl[i]?wl[i].roll.parent:g,at=host===g?[x,WHEEL_R,z]:[0,0,0];
    for(const side of [1,-1]){const ring=new THREE.Mesh(ringG,ringBase);ring.rotation.y=side*sg*Math.PI/2;ring.position.set(at[0]+side*sg*(wd/2+0.004),at[1],at[2]);
      ring.userData.keep=true;host.add(ring);fx.rings.push(ring);}           // both sidewalls carry the band
    const mat=new THREE.MeshBasicMaterial({color:0,side:THREE.DoubleSide});mat.userData.noWet=true;
    const disc=new THREE.Mesh(discG,mat);disc.rotation.y=-sg*Math.PI/2;disc.position.set(at[0]-sg*(wd/2+0.012),at[1],at[2]);disc.userData.keep=true;host.add(disc);
    const spr=new THREE.Sprite(new THREE.SpriteMaterial({map:glowTex,color:0,blending:THREE.AdditiveBlending,depthWrite:false,transparent:true,fog:true}));
    spr.position.set(at[0]-sg*(wd/2+0.08),at[1],at[2]);spr.scale.set(0.75,0.75,1);spr.visible=false;host.add(spr);
    fx.glow.push({mat,spr,front:i<2});});
  g.userData.fx=fx;return g;}
const _gc=new THREE.Color();
// per frame: compound band, and the disc glow (rears run ~25 % cooler: they take the smaller share of the braking)
function wheelFX(m,comp,Tf){const fx=m&&m.userData.fx;if(!fx)return;
  if(comp!==fx.comp&&comp!=null){fx.comp=comp;const mt=tyreMat(comp);fx.rings.forEach(r=>r.material=mt);}
  for(const q of fx.glow){const T=q.front?Tf:22+(Tf-22)*0.75;glowColor(T,_gc);q.mat.color.copy(_gc);
    const k=_gc.r;q.spr.visible=k>0.02;if(q.spr.visible)q.spr.material.color.copy(_gc).multiplyScalar(0.35);}}
// traffic has no drivetrain model: the same disc thermal balance as physics/vehicle.c, driven by the car's deceleration
// less its aero drag (braking power into one front disc: share bb, half the axle, 90 % into the carbon)
function discHeat(o,v,dt){let T=o.bT==null?300:o.bT;if(!(dt>0))return T;
  const a=o._bv==null?0:clamp((o._bv-v)/dt,0,60);o._bv=v;
  const drag=0.5*CAR.rho*CAR.CdA*v*v/CAR.m,P=Math.max(0,a-drag)*CAR.m*v*CAR.bb*0.5*0.9,Tk=T+273.15,rad=5.67e-8*0.85*0.12*(Tk**4-295**4);
  T+=(P-(8+1.6*v)*(T-22)-rad)/900*dt;return o.bT=Math.max(22,T);}
/* Cockpit: the steering wheel turns with the steering (about 1.4 rad of wheel for the full lock at the tyres),
   its screen shows gear, speed, shift lights, tyre and brake temperatures, and the mirrors show the view behind.
   The mirrors come from one rear-facing camera over the airbox, drawn into a small target at half the frame rate;
   each mirror shows its side of that image, flipped left to right as a mirror is. */
const mirrorRT=new THREE.WebGLRenderTarget(512,128,{format:THREE.RGBAFormat}), mirrorCam=new THREE.PerspectiveCamera(22,4,0.5,500), _mv=new THREE.Vector3();
let mirrorFrame=0,wheelDrawn=0;
function setupCockpit(g){for(const m of g.userData.mirrors||[]){const left=m.userData.side<0,uv=m.geometry.attributes.uv;
    for(let i=0;i<uv.count;i++){const u=uv.getX(i);uv.setX(i,left?1-0.5*u:0.5-0.5*u);}uv.needsUpdate=true;
    m.material=new THREE.MeshBasicMaterial({map:mirrorRT.texture,toneMapped:false,color:0xb8c0c8});m.material.userData.noWet=true;}}
function drawMirrors(){if(ui.cam!=='cockpit'||!player.userData.mirrors||(mirrorFrame++)%2)return;
  _mv.set(0,1.3,0.4);player.localToWorld(_mv);mirrorCam.position.copy(_mv);_mv.set(0,0.9,40);player.localToWorld(_mv);mirrorCam.lookAt(_mv);mirrorCam.updateMatrixWorld();
  const sh=renderer.shadowMap.autoUpdate;renderer.shadowMap.autoUpdate=false;renderer.setRenderTarget(mirrorRT);renderer.render(scene,mirrorCam);renderer.setRenderTarget(null);renderer.shadowMap.autoUpdate=sh;}
function drawWheelScreen(P,t){const ck=player.userData.cockpit;if(!ck)return;
  // with a phone as the wheel the sim's wheel turns exactly as far as the phone does; otherwise it follows the car
  ck.wheel.rotation.z=P.wheelDeg!=null?-P.wheelDeg*Math.PI/180:-clamp((P.delta||0)/CAR.dmax,-1,1)*1.4;
  if(t-wheelDrawn<0.05)return;wheelDrawn=t;const c=ck.canvas.getContext('2d'),W=320,H=160;
  c.fillStyle='#050608';c.fillRect(0,0,W,H);
  const f=clamp(((P.rpm||0)-9000)/2800,0,1),lit=Math.round(f*15),blink=(P.rpm||0)>11600&&((t*14)|0)%2;
  for(let i=0;i<15;i++){c.fillStyle=i<lit&&!blink?(i<5?'#35D98A':i<10?'#FF3B2A':'#4A9CFF'):'#16181c';c.beginPath();c.arc(22+i*19.7,14,6.5,0,TAU);c.fill();}
  c.fillStyle='#0c1116';c.fillRect(8,30,W-16,H-38);
  c.textAlign='center';c.textBaseline='middle';c.fillStyle='#F4F7FA';c.font='700 72px "B612 Mono", monospace';c.fillText(P.rev?'R':String((P.gear|0)+1),W/2,86);
  c.font='700 28px "B612 Mono", monospace';c.fillText(String(Math.round((P.v||0)*3.6)),62,80);c.font='12px "B612 Mono", monospace';c.fillStyle='#8a96a3';c.fillText('KM/H',62,102);
  const k=TYRES[P.comp];if(k&&P.tempF!=null){c.fillStyle=k.col;c.font='700 16px "B612 Mono", monospace';c.fillText(k.k,W-62,46);
    [[P.tempF,0,0],[P.tempF,1,0],[P.tempR,0,1],[P.tempR,1,1]].forEach(([T,x,y])=>{c.fillStyle=tyreTempCol(T,k);c.fillRect(W-94+x*36,60+y*38,30,32);
      c.fillStyle='#050608';c.font='700 13px "B612 Mono", monospace';c.fillText(String(Math.round(T)),W-79+x*36,77+y*38);});}
  const o=world&&world.opts||{};c.font='700 13px "B612 Mono", monospace';c.textAlign='center';
  [['TC',o.tcT===0?0:o.tcC?'C':o.tc,P.tcCut>0.04,44],['ABS',o.absT===0?0:o.absC?'C':o.abs,(P.absF||P.absR)>0,112]].forEach(([n,l,on,xx])=>{c.fillStyle=on&&l?'#FFB547':l?'#33404c':'#1a1f25';c.fillRect(xx-31,34,62,18);
    c.fillStyle=on&&l?'#050608':'#cfd8e0';c.fillText(n+' '+(l||'OFF'),xx,44);});
  const bt=P.brakeT||0;c.fillStyle='#8a96a3';c.font='12px "B612 Mono", monospace';c.textAlign='left';c.fillText('BRK',18,132);
  c.fillStyle=bt>900?'#FF3B2A':bt>550?'#FFB547':'#35D98A';c.fillRect(52,127,clamp(bt/1100,0,1)*70,10);
  c.textAlign='center';c.fillStyle='#8a96a3';c.fillText(Math.round((1-Math.max(P.wearF||0,P.wearR||0))*100)+'% TREAD',W/2,136);
  c.fillStyle='#cfd8e0';c.font='700 13px "B612 Mono", monospace';c.fillText('BB '+((o.bb||0.57)*100).toFixed(1),W/2,150);
  if((P.regen||0)>5){c.fillStyle='#35D98A';c.textAlign='left';c.fillText('K '+Math.round(P.regen),18,150);}
  ck.tex.needsUpdate=true;}
/* Wet cars: rain lays a thin water film over everything. Water (n = 1.33) is a smooth dielectric layer, so it is
   rendered as a clear coat whose roughness drops towards a mirror, while it fills the micro-roughness of rubber and
   matte carbon underneath. */
let wetApplied=-1;
function wetLook(root,rain){const wv=clamp(rain*1.4,0,1);if(!root)return;
  root.traverse(o=>{const ms=o.material?(Array.isArray(o.material)?o.material:[o.material]):[];
    for(const m of ms){if(!m.isMeshStandardMaterial||m.userData.noWet)continue;const u=m.userData;
      if(u.r0==null){u.r0=m.roughness;u.cc0=m.clearcoat||0;u.ccr0=m.clearcoatRoughness||0;}
      if(m.isMeshPhysicalMaterial){m.clearcoat=lerp(u.cc0,1,wv);m.clearcoatRoughness=lerp(u.ccr0,0.03,wv);m.roughness=lerp(u.r0,u.r0*0.8,wv);}
      else m.roughness=lerp(u.r0,u.r0*0.55,wv);}});}
// genuine model: "F1 2022" by Blender458 (sketchfab.com/Blender458), CC BY 4.0, via FetchCFD. Any licensed glb at this path works.
if(THREE.GLTFLoader)fetch('/assets/f1.glb',{method:'HEAD'}).then(r=>{if(!r.ok)return;
  fetch('/assets/f1.json').then(x=>x.ok?x.json():{}).catch(()=>({})).then(cfg=>{
    new THREE.GLTFLoader().load('/assets/f1.glb',gl=>{
      gl.scene.updateMatrixWorld(true);
      const groups=new Map();
      gl.scene.traverse(o=>{if(!o.isMesh)return;let g=o.geometry.clone();g.applyMatrix4(o.matrixWorld);if(g.index)g=g.toNonIndexed();
        for(const k of Object.keys(g.attributes))if(k!=='position'&&k!=='normal')g.deleteAttribute(k);if(!g.attributes.normal)g.computeVertexNormals();
        const m=o.material,key=m.color.getHexString()+'|'+(m.metalness||0).toFixed(2)+'|'+(m.roughness||0).toFixed(2);
        if(!groups.has(key))groups.set(key,{mat:m,geos:[]});groups.get(key).geos.push(g);});
      const parts=[];for(const {mat,geos} of groups.values()){const geo=THREE.BufferGeometryUtils.mergeBufferGeometries(geos,false);if(!geo)continue;
        const mm=new THREE.MeshPhysicalMaterial({color:mat.color,metalness:Math.min(0.7,mat.metalness||0.2),roughness:Math.max(0.25,mat.roughness==null?0.5:mat.roughness),clearcoat:0.6,clearcoatRoughness:0.1,side:THREE.DoubleSide});
        parts.push({geo,mat:mm});}
      // orient: long axis along z, nose to -z (the rear wing is the tallest part, so it marks the back)
      const all=new THREE.Box3();parts.forEach(p=>{p.geo.computeBoundingBox();all.union(p.geo.boundingBox);});
      const sz=all.getSize(new THREE.Vector3()),rot=new THREE.Matrix4();
      if(sz.x>sz.z){rot.makeRotationY(Math.PI/2);parts.forEach(p=>p.geo.applyMatrix4(rot));}
      let top=0,cnt=0,maxY=-1e9;parts.forEach(p=>{const a=p.geo.attributes.position;for(let i=0;i<a.count;i++)maxY=Math.max(maxY,a.getY(i));});
      const b0=new THREE.Box3();parts.forEach(p=>{p.geo.computeBoundingBox();b0.union(p.geo.boundingBox);});const cz=(b0.min.z+b0.max.z)/2,minY=b0.min.y;
      parts.forEach(p=>{const a=p.geo.attributes.position;for(let i=0;i<a.count;i++)if(a.getY(i)>minY+(maxY-minY)*0.8){top+=a.getZ(i)-cz;cnt++;}});
      if(cnt&&top/cnt<0){rot.makeRotationY(Math.PI);parts.forEach(p=>p.geo.applyMatrix4(rot));}
      if(cfg.yaw){rot.makeRotationY(cfg.yaw*Math.PI/180);parts.forEach(p=>p.geo.applyMatrix4(rot));}
      const b1=new THREE.Box3();parts.forEach(p=>{p.geo.computeBoundingBox();b1.union(p.geo.boundingBox);});
      const s1=b1.getSize(new THREE.Vector3()),c1=b1.getCenter(new THREE.Vector3()),k=(cfg.scale||1)*5.6/s1.z;
      const fit=new THREE.Matrix4().makeScale(k,k,k).multiply(new THREE.Matrix4().makeTranslation(-c1.x,-b1.min.y+(cfg.y||0)/k,-c1.z));
      parts.forEach(p=>{p.geo.applyMatrix4(fit);p.geo.computeBoundingSphere();});
      // the paint is the most-used saturated colour
      let best=null,bestN=0;for(const p of parts){const hsl={};p.mat.color.getHSL(hsl);const n=p.geo.attributes.position.count;if(hsl.s>0.25&&hsl.l>0.015&&n>bestN){best=p;bestN=n;}}
      if(best)best.paint=true;
      CAR_GLB={parts,rearZ:s1.z*k/2-0.1,rearY:0.45};
      playerGLB=addWheelFX(cloneGLBCar(0x152a55));playerGLB.visible=false;scene.add(playerGLB);applyEnv(playerGLB);
      if(typeof world!=='undefined'&&world)buildDynamic(world);});});}).catch(()=>{});
function makeTractor(){
  const g=new THREE.Group(), y=new THREE.MeshStandardMaterial({color:0xd9a31a,roughness:0.5}), gl=new THREE.MeshStandardMaterial({color:0x1b2530,roughness:0.2,metalness:0.4});
  const box=(w,h,l,x,yy,z,m,rx)=>{const me=new THREE.Mesh(new THREE.BoxGeometry(w,h,l),m);me.position.set(x,yy,z);if(rx)me.rotation.x=rx;g.add(me);return me;};
  box(2.3,1.1,4.4,0,1.1,0,y); box(1.9,1.5,1.7,0,2.4,0.7,y); box(1.95,1.0,1.5,0,2.5,0.7,gl);
  const bw=new THREE.CylinderGeometry(0.8,0.8,0.6,18);bw.rotateZ(Math.PI/2);
  for(const [x,z] of [[-1.2,1.4],[1.2,1.4],[-1.2,-1.5],[1.2,-1.5]]){const w=new THREE.Mesh(bw,MAT.tyre);w.position.set(x,0.8,z);g.add(w);}
  box(0.4,0.4,5.2,0,3.3,-1.2,y,0.42); box(0.05,2.2,0.05,0,2.9,-3.6,MAT.carbon);
  box(0.25,0.22,0.25,0,3.28,0.9,new THREE.MeshBasicMaterial({color:0xff9a10}));
  const bg=new THREE.Sprite(MAT.glowO.clone());bg.position.set(0,3.3,0.9);bg.scale.set(4,4,1);g.add(bg);
  g.userData.beacon=bg; return g;
}
function makeMarshal(){
  const g=new THREE.Group(), o=new THREE.MeshStandardMaterial({color:0xff6a10,roughness:0.6,emissive:0x5a1a00,emissiveIntensity:0.6}), w=new THREE.MeshBasicMaterial({color:0xdfe8ee});
  const add=(geo,m,x,y,z)=>{const me=new THREE.Mesh(geo,m);me.position.set(x,y,z);g.add(me);return me;};
  add(new THREE.CylinderGeometry(0.2,0.24,0.72,10),o,0,1.2,0); add(new THREE.CylinderGeometry(0.245,0.245,0.07,10),w,0,1.1,0);
  add(new THREE.SphereGeometry(0.13,12,10),o,0,1.7,0);
  const lg=new THREE.BoxGeometry(0.13,0.85,0.15);lg.translate(0,-0.42,0);
  const l1=add(lg,o,-0.1,0.86,0), l2=add(lg,o,0.1,0.86,0);
  const ag=new THREE.BoxGeometry(0.1,0.6,0.1);ag.translate(0,-0.3,0);
  const a1=add(ag,o,-0.29,1.5,0), a2=add(ag,o,0.29,1.5,0);
  g.userData.limbs=[l1,l2,a1,a2]; return g;
}
function makeFlagPost(double){
  const g=new THREE.Group(); const pole=new THREE.Mesh(new THREE.CylinderGeometry(0.03,0.03,2.2,6),MAT.carbon);pole.position.y=1.1;g.add(pole);
  const fg=new THREE.PlaneGeometry(0.95,0.65,6,1);fg.translate(0.48,0,0);
  const fm=new THREE.MeshStandardMaterial({color:0xffd21a,emissive:0x6a5200,side:THREE.DoubleSide,roughness:0.8});
  const flags=[];for(let k=0;k<(double?2:1);k++){const f=new THREE.Mesh(fg,fm);f.position.set(0,1.85-k*0.05,k*0.3);g.add(f);flags.push(f);}
  const led=new THREE.Mesh(new THREE.BoxGeometry(1.3,0.8,0.1),new THREE.MeshBasicMaterial({color:0xffcc00}));led.position.set(0,0.5,-1.2);g.add(led);
  const m=makeMarshal();m.position.set(-0.5,0,0.4);m.scale.setScalar(0.95);g.add(m);
  g.userData={flags,led};return g;
}
const _m4=new THREE.Matrix4(),_f=new THREE.Vector3(),_r=new THREE.Vector3(),_u=new THREE.Vector3(),_b=new THREE.Vector3();
function placeObj(o,s,lat,yaw,lift){
  const F=trackFrame(s), cy=Math.cos(yaw||0), sy=Math.sin(yaw||0), rx=-F.tz, rz=F.tx;
  _f.set(F.tx*cy+rx*sy,F.sl,F.tz*cy+rz*sy).normalize(); _r.set(-_f.z,0,_f.x).normalize(); _u.crossVectors(_r,_f); _b.copy(_f).negate();
  _m4.makeBasis(_r,_u,_b); o.quaternion.setFromRotationMatrix(_m4);
  o.position.set(F.px+rx*lat,F.h+(lift||0),F.pz+rz*lat);
}
const player=makeCar(0x152a55,true); scene.add(player); setupCockpit(player);
setTimeout(()=>applyEnv(player),0);
let dyn=new THREE.Group(); scene.add(dyn);
let trafficMeshes=[], hazardMeshes=[], flagPosts=[];
function hazMesh(h){return h.type==='tractor'?makeTractor():h.type==='marshal'?makeMarshal():makeCar(0xb3202b,false);}
// a driver's name floating above their car, readable at any distance
function nameTag(name,col){const c=document.createElement('canvas');c.width=256;c.height=64;const g=c.getContext('2d');g.fillStyle='rgba(8,10,14,.72)';g.fillRect(0,8,256,48);
  g.fillStyle='#'+col.toString(16).padStart(6,'0');g.fillRect(0,8,8,48);g.fillStyle='#fff';g.font='700 30px "Titillium Web",sans-serif';g.textBaseline='middle';g.fillText(name.slice(0,14),20,33);
  const t=new THREE.CanvasTexture(c);t.encoding=THREE.sRGBEncoding;const sp=new THREE.Sprite(new THREE.SpriteMaterial({map:t,depthWrite:false,transparent:true,sizeAttenuation:false}));sp.position.set(0,1.9,0);sp.scale.set(0.22,0.055,1);/* same size on screen at any distance */sp.userData.keep=true;return sp;}
function buildDynamic(w){
  scene.remove(dyn); dyn.traverse(o=>{if(o.geometry&&o.geometry!==wheelG&&!o.userData.keep) o.geometry.dispose();});
  dyn=new THREE.Group(); scene.add(dyn);
  trafficMeshes=w.traffic.map(c=>{const m=makeCar(c.col,false);dyn.add(m);if(c.remote)m.add(nameTag(c.name||'Driver',c.col));return m;});
  hazardMeshes=w.hazards.map(h=>{const m=hazMesh(h);dyn.add(m);return m;});
  flagPosts=[];
  applyEnv(dyn);wetApplied=-1;
  if(w.sc.flag){for(const back of [330,170]){const p=makeFlagPost(w.sc.flag==='double');placeObj(p,wrapS(w.hazards[0].s-back),-(WALL+0.7),Math.PI/2,3.4);dyn.add(p);flagPosts.push(p);}}
}

/* ================= HUD: conformal outlines + nav radar ================= */
const hud=$('hud'), hc=hud.getContext('2d');
const HUDC='#CFF6FF', CAU='#FFC247', DAN='#FF4B3A';
let cw=960,ch=540,dpr=1;
/*HUD>*/
function rr(c,x,y,w,h,r){r=Math.min(r,w/2,h/2);c.beginPath();c.moveTo(x+r,y);c.arcTo(x+w,y,x+w,y+h,r);c.arcTo(x+w,y+h,x,y+h,r);c.arcTo(x,y+h,x,y,r);c.arcTo(x,y,x+w,y,r);c.closePath();}
function hazIcon(c,type,x,y,s,col,solid,ink){
  c.save();c.translate(x,y);c.lineJoin='round';c.lineWidth=Math.max(1.4,s*0.09);c.strokeStyle=col;c.fillStyle=col;
  c.beginPath();c.moveTo(0,-s*0.62);c.lineTo(s*0.62,s*0.46);c.lineTo(-s*0.62,s*0.46);c.closePath();
  if(solid)c.fill();else c.stroke();
  const k2=ink||(solid?'#061016':col);c.fillStyle=k2;c.strokeStyle=k2;c.lineWidth=Math.max(1.2,s*0.07);const k=s*0.2;
  c.translate(0,s*0.1);
  if(type==='car'){c.fillRect(-k*1.1,-k*0.35,k*2.2,k*0.7);c.fillRect(-k*1.3,-k*0.75,k*0.45,k*0.4);c.fillRect(k*0.85,-k*0.75,k*0.45,k*0.4);c.fillRect(-k*1.3,k*0.35,k*0.45,k*0.4);c.fillRect(k*0.85,k*0.35,k*0.45,k*0.4);}
  else if(type==='tractor'){c.beginPath();c.moveTo(-k*0.9,k*0.9);c.lineTo(-k*0.9,-k*0.9);c.lineTo(k*0.9,-k*0.9);c.lineTo(k*0.9,k*0.1);c.stroke();c.beginPath();c.arc(k*0.9,k*0.45,k*0.35,-Math.PI/2,Math.PI*0.9);c.stroke();}
  else {c.beginPath();c.arc(0,-k*0.75,k*0.32,0,TAU);c.fill();c.beginPath();c.moveTo(0,-k*0.35);c.lineTo(0,k*0.4);c.moveTo(-k*0.7,-k*0.05);c.lineTo(k*0.7,-k*0.25);c.moveTo(0,k*0.4);c.lineTo(-k*0.55,k*1.05);c.moveTo(0,k*0.4);c.lineTo(k*0.6,k*0.95);c.stroke();}
  c.restore();
}
/*<HUD*/
/*HUD>*/
function carYaw(c,isP){if(c.remote)return c.psi||0;return isP&&c.vx!=null&&world&&world.opts.driver==='drive'?c.psi:isP&&c.psi?c.psi:Math.atan2(c.latV+(c.slideV||0),Math.max(c.v,2));}
function headingAt(s,yaw){const F=trackFrame(s),cy=Math.cos(yaw),sy=Math.sin(yaw);return [F.tx*cy-F.tz*sy,F.tz*cy+F.tx*sy];}
function egoPose(w,raw){const P=w.player,yaw=carYaw(P,true),now=performance.now(),k=1-Math.exp(-Math.min(0.1,(now-(NAV.yawT||now))/1000)*5);NAV.yawT=now;
  NAV.yawS=NAV.yawS==null||Math.abs(yaw-NAV.yawS)>1?yaw:NAV.yawS+(yaw-NAV.yawS)*k;if(raw){const hd=headingAt(P.s,yaw),p=worldPos(P.s,P.lat);return {x:p.x,z:p.z,fx:hd[0],fz:hd[1]};}NAV.yawD=yaw-NAV.yawS;const hd=headingAt(P.s,NAV.yawS),p=worldPos(P.s,P.lat);return {x:p.x,z:p.z,fx:hd[0],fz:hd[1]};}
/*<HUD*/
const _p=new THREE.Vector3(),_pc=new THREE.Vector3();
// project a point on the track into the 3D driver view: [x, y, depth]
function projCam(s,lat,yOff){const p=worldPos(s,lat);_p.set(p.x,p.y+yOff,p.z);_pc.copy(_p).applyMatrix4(camera.matrixWorldInverse);if(_pc.z>-1.2)return null;_p.project(camera);return [(_p.x*0.5+0.5)*cw,(-_p.y*0.5+0.5)*ch,-_pc.z];}
/*HUD>*/
function bracket(c,x,y,s,col,dashed,u){
  c.strokeStyle=col;c.lineWidth=1.8*u;if(dashed)c.setLineDash([4*u,3*u]);const k=s*0.32;
  c.beginPath();
  c.moveTo(x-s,y-s+k);c.lineTo(x-s,y-s);c.lineTo(x-s+k,y-s);
  c.moveTo(x+s-k,y-s);c.lineTo(x+s,y-s);c.lineTo(x+s,y-s+k);
  c.moveTo(x+s,y+s-k);c.lineTo(x+s,y+s);c.lineTo(x+s-k,y+s);
  c.moveTo(x-s+k,y+s);c.lineTo(x-s,y+s);c.lineTo(x-s,y+s-k);c.stroke();c.setLineDash([]);
}
// conformal hazard brackets (and car target boxes in the driver's view); proj(s,lat,y) -> [x,y,depth]
function drawConformal(c,w,u,proj,targets){
  const P=w.player, items=[], f=ch/(2*Math.tan(60*Math.PI/360));
  if(targets)drawTargets(c,w,proj,u);
  for(const h of w.hazards){if(h.gone)continue;const d=dSigned(P.s,h.s);if(d>2&&d<460)items.push({s:h.s,lat:h.lat,y:h.height*0.55,d,hid:!h.vis,col:(w.alert===2&&h===w.near)?THREAT_COL.red:THREAT_COL.amber,sz:h.type==='marshal'?0.9:h.type==='tractor'?2.2:1.4});}
  c.save();
  for(const it of items){const q=proj(it.s,it.lat,it.y);if(!q)continue;const x=q[0],y=q[1];if(x<-40||x>cw+40||y<-40||y>ch+40)continue;
    const s=clamp(it.sz*f/q[2],7*u,70*u);
    bracket(c,x,y,s,it.col,it.hid,u);
    c.font=`700 ${10.5*u}px "B612 Mono", monospace`;c.fillStyle=it.col;c.textAlign='center';c.fillText(Math.round(it.d)+' M',x,y+s+13*u);}
  c.restore();
}
/*<HUD*/

// --- Projected nav HUD: light only, so everything is outline and glow (the HUD canvas is screen-blended) ---
/*HUD>*/
const NAV={zoom:1,cur:160,lz:1,big:false,rects:null};
const NC={map:'#F1F0EA',bld:'#E2E1D9',wall:'#9EA4AB',roadEdge:'#E09E36',road:'#F8CE66',route:'#C4238E',shield:'#2F5FAE',ink:'#15181C'};
const HC={pri:'#C4F8FF',mid:'rgba(196,248,255,.62)',dim:'rgba(196,248,255,.34)',faint:'rgba(196,248,255,.14)',amb:'#FFC247',red:'#FF5A48',glow:'rgba(110,225,255,.65)'};
function headerInfo(w){
  const P=w.player;
  if(w.near&&w.dNear<RANGE){const h=w.near;return {kind:'haz',dist:Math.max(0,w.dNear),text:h.label,col:w.alert===2?HC.red:HC.amb,h};}
  let best=null,bd=1e9;
  for(const c of CORNERS){const inC=dSigned(c.s0,P.s)>=0&&dSigned(P.s,c.s1)>0;const d=inC?0:dSigned(P.s,c.s0);if(d>=0&&d<bd){bd=d;best=c;}}
  if(!best) return {kind:'none',dist:0,text:'Straight',col:HC.pri};
  const a=Math.abs(best.angle)*180/Math.PI, side=best.sg>0?'right':'left', word=a>120?'Hairpin':a>70?'Sharp':a>35?'':'Kink';
  return {kind:'corner',dist:bd,text:word?word+' '+side:side,corner:best,col:HC.pri};
}
function shield(c,x,y,txt,u){
  c.save();c.font=`700 ${9.5*u}px "B612", sans-serif`;const tw=c.measureText(txt).width+9*u,th=14*u;
  rr(c,x-tw/2,y-th/2,tw,th,3*u);c.fillStyle=NC.shield;c.fill();c.lineWidth=1.2*u;c.strokeStyle='#fff';c.stroke();
  c.fillStyle='#fff';c.textAlign='center';c.textBaseline='middle';c.fillText(txt,x,y+0.5*u);c.restore();
}
function hudTag(c,x,y,txt,col,u,size){
  c.save();c.font=`700 ${(size||9.5)*u}px "B612 Mono", monospace`;const tw=c.measureText(txt).width+8*u,th=(size||9.5)*1.5*u;
  rr(c,x-tw/2,y-th/2,tw,th,2*u);c.strokeStyle=col;c.lineWidth=1.1*u;c.stroke();
  c.fillStyle=col;c.textAlign='center';c.textBaseline='middle';c.fillText(txt,x,y+0.5*u);c.restore();
}
// --- lap tracker: the whole lap as one line, every car a dot at its place on it (TV-graphics style)
const TRK_CODES=['ALP','BRV','CHL','DLT','ECH','FOX','GLF','HTL','IND','JLT','KLO','LIM','MKE','NOV','OSC','PAP','QUE','ROM','SRA','TNG'];
const TRK_COLS=['#d6dce2','#ff7a2a','#18c08f','#a970ff','#ffd02a','#4a9cff','#ff4f8e','#5fd068','#ff9a3a','#9fb4c0','#c46cff','#22d0e0'];
// call sign on a car's box: the tracker code on a dark tag with the driver's colour as a stripe
function callSign(w,car){const i=w.traffic.indexOf(car);return i<0?null:{code:TRK_CODES[i%TRK_CODES.length],col:TRK_COLS[i%TRK_COLS.length]};}
function drawCallSign(c,x,y,fs,cs){if(!cs||fs<6)return;c.save();c.font=`700 ${fs}px "B612 Mono", monospace`;
  const tw=c.measureText(cs.code).width,pw=fs*0.35,bw=tw+pw*2+fs*0.3,bh=fs*1.35,x0=x-bw/2,y0=y-bh/2;
  c.fillStyle='rgba(0,0,0,.62)';c.fillRect(x0,y0,bw,bh);c.fillStyle=cs.col;c.fillRect(x0,y0,fs*0.3,bh);
  c.fillStyle='#fff';c.textAlign='center';c.textBaseline='middle';c.fillText(cs.code,x+fs*0.15,y+fs*0.05);c.restore();}
function raceInfo(w){const P=w.player,pp=(P.lapc||0)*L+P.s;let pos=1,ahead=null,behind=null;
  for(const c of w.traffic){const pr=(c.lapc||0)*L+c.s;if(pr>pp){pos++;if(ahead==null||pr<ahead)ahead=pr;}else if(behind==null||pr>behind)behind=pr;}
  const v=Math.max(P.v,10);return {pos,n:w.traffic.length+1,lap:Math.max(1,Math.floor(pp/L)+1),ga:ahead==null?null:(ahead-pp)/v,gb:behind==null?null:(pp-behind)/v};}
function drawTracker(c,w,x,y,W,H,u,flash){
  const ri=raceInfo(w), mono=f=>`700 ${f}px "B612 Mono", monospace`;
  c.save();c.textBaseline='alphabetic';c.textAlign='left';
  // position block
  c.fillStyle=HC.pri;c.font=mono(H*0.44);const ptxt='P'+ri.pos;c.fillText(ptxt,x+4*u,y+H*0.52);
  const pw=c.measureText(ptxt).width;c.fillStyle=HC.mid;c.font=mono(H*0.2);c.fillText('/'+ri.n,x+6*u+pw,y+H*0.52);
  const nw=c.measureText('/'+ri.n).width;c.fillText('LAP '+ri.lap,x+4*u,y+H*0.86);
  const gx=x+10*u+pw+nw+8*u;c.font=mono(H*0.19);const bw=gx-x+c.measureText('▲ 10.0s').width+4*u;
  if(ri.ga!=null){c.fillStyle=ri.ga<1?HC.amb:HC.mid;c.fillText('▲ '+ri.ga.toFixed(1)+'s',gx,y+H*0.4);}
  if(ri.gb!=null){c.fillStyle=ri.gb<1?HC.amb:HC.mid;c.fillText('▼ '+ri.gb.toFixed(1)+'s',gx,y+H*0.74);}
  // the lap line
  const sx=x+bw+8*u, sw=W-bw-14*u, ly=y+H*0.52, X=s=>sx+(wrapS(s)/L)*sw;
  c.strokeStyle=HC.mid;c.lineWidth=2.2*u;c.lineCap='round';c.beginPath();c.moveTo(sx,ly);c.lineTo(sx+sw,ly);c.stroke();
  c.fillStyle=HC.pri;for(let k=0;k<4;k++){c.globalAlpha=k%2?0.35:1;c.fillRect(sx-1.5*u,ly-8*u+k*4*u,3*u,4*u);}c.globalAlpha=1;
  c.strokeStyle=HC.dim;c.lineWidth=1*u;for(const cn of CORNERS){const cx=X(cn.apex);c.beginPath();c.moveTo(cx,ly-3*u);c.lineTo(cx,ly+3*u);c.stroke();}
  for(const h of w.hazards){if(h.gone)continue;const hc2=w.alert===2&&h===w.near?HC.red:HC.amb;hazIcon(c,h.type,X(h.s),ly-11*u,11*u,hc2,flash);}
  // cars: dots, codes alternate above and below, labels that would collide are dropped
  const items=w.traffic.map((t,i)=>({x:X(t.s),col:TRK_COLS[i%TRK_COLS.length],code:TRK_CODES[i%TRK_CODES.length],hid:!t.vis,red:t.closing}));
  items.sort((a,b)=>a.x-b.x);
  const last=[-1e9,-1e9],pxY=X(w.player.s);c.font=mono(9*u);c.textAlign='center';
  items.forEach((it,k)=>{const r=4.2*u;c.beginPath();c.arc(it.x,ly,r,0,Math.PI*2);
    if(it.hid){c.strokeStyle=it.col;c.lineWidth=1.6*u;c.stroke();}else{c.fillStyle=it.col;c.fill();}
    if(it.red){c.strokeStyle=HC.red;c.lineWidth=1.6*u;c.beginPath();c.arc(it.x,ly,r+2.5*u,0,Math.PI*2);c.stroke();}
    const side=k%2, tw=c.measureText(it.code).width+3*u;
    if(it.x-tw/2>last[side]&&!(side===0&&Math.abs(it.x-pxY)<tw)){c.fillStyle=it.col;c.fillText(it.code,it.x,side?ly+r+11*u:ly-r-5*u);last[side]=it.x+tw/2;}});
  const px=X(w.player.s);c.fillStyle=HC.pri;c.beginPath();c.arc(px,ly,6*u,0,Math.PI*2);c.fill();
  c.strokeStyle='#000';c.lineWidth=1.5*u;c.stroke();c.strokeStyle=HC.pri;c.lineWidth=1.4*u;c.beginPath();c.arc(px,ly,9*u,0,Math.PI*2);c.stroke();
  c.fillStyle=HC.pri;c.font=mono(10*u);c.fillText('YOU',px,ly-13*u);
  c.restore();
}
// --- AR overlay pieces (conformal: drawn where things are in the view)
const THREAT_COL={red:'#FF4B3A',amber:'#FFC247',green:'#4BE37F',teal:'#39E6B4'};
function threatOf(w,c){const P=w.player,d=dSigned(P.s,c.s),dl=Math.abs(c.lat-P.lat),cl=P.v-c.v;
  if(d>0&&d<140&&dl<2.4&&((cl>3&&d/cl<3.2)||d<22))return 'red';
  if((d>0&&d<220&&dl<3.4)||Math.abs(d)<10||(!c.vis&&d>0&&d<220))return 'amber';
  return 'green';}
function laneLead(w){const P=w.player;let best=null,bd=1e9;for(const c of w.traffic){const d=dSigned(P.s,c.s);if(d>4&&d<220&&Math.abs(c.lat-P.lat)<2.6&&d<bd){bd=d;best=c;}}return best?{c:best,d:bd}:null;}
function drawLadder(c,w,proj,u){
  const P=w.player,lead=laneLead(w);if(!lead)return;const end=lead.d-5;if(end<8)return;
  const th=threatOf(w,lead.c),col=th==='red'?THREAT_COL.red:th==='amber'&&lead.d<60?THREAT_COL.amber:THREAT_COL.teal;
  c.save();c.fillStyle=col;
  for(let d=4;d<end;d+=4.5){const k=d/end,lat=lerp(P.lat,lead.c.lat,k),s0=P.s+d;
    const a=proj(s0,lat-0.95,0.03),b=proj(s0,lat+0.95,0.03),a2=proj(s0+1.5,lat-0.8,0.03),b2=proj(s0+1.5,lat+0.8,0.03),m=proj(s0+2.1,lat,0.03);
    if(!a||!b||!a2||!b2||!m)continue;c.globalAlpha=0.82*(1-k*0.55);
    c.beginPath();c.moveTo(a[0],a[1]);c.lineTo(b[0],b[1]);c.lineTo(b2[0],b2[1]);c.lineTo(m[0],m[1]);c.lineTo(a2[0],a2[1]);c.closePath();c.fill();}
  c.globalAlpha=1;
  const q=proj(P.s+end*0.42,lerp(P.lat,lead.c.lat,0.42)+1.1,0.03);
  if(q){const tx=q[0]+26*u,ty=q[1]-22*u,lab=Math.round(lead.d)+' m';c.strokeStyle=col;c.lineWidth=1.6*u;c.beginPath();c.moveTo(q[0]+4*u,q[1]);c.lineTo(q[0]+14*u,q[1]);c.lineTo(tx,ty);c.lineTo(tx+56*u,ty);c.stroke();
    c.fillStyle=col;c.font=`700 ${15*u}px "B612 Mono", monospace`;c.textAlign='left';c.textBaseline='bottom';c.fillText(lab,tx+4*u,ty-3*u);}
  c.restore();}
function arBracket(c,x0,y0,x1,y1,col,dashed,u,tri){
  const k=Math.max(5*u,Math.min((x1-x0),(y1-y0))*0.3);c.strokeStyle=col;c.lineWidth=2*u;if(dashed)c.setLineDash([4*u,3*u]);
  c.beginPath();c.moveTo(x0,y0+k);c.lineTo(x0,y0);c.lineTo(x0+k,y0);c.moveTo(x1-k,y0);c.lineTo(x1,y0);c.lineTo(x1,y0+k);
  c.moveTo(x1,y1-k);c.lineTo(x1,y1);c.lineTo(x1-k,y1);c.moveTo(x0+k,y1);c.lineTo(x0,y1);c.lineTo(x0,y1-k);c.stroke();c.setLineDash([]);
  if(tri){const cx=(x0+x1)/2,s=Math.max(7*u,Math.min(13*u,(x1-x0)*0.22));c.fillStyle=col;c.beginPath();c.moveTo(cx-s,y0-s*1.7);c.lineTo(cx+s,y0-s*1.7);c.lineTo(cx,y0-s*0.4);c.closePath();c.fill();}}
// hit boxes on other cars only within this straight-line radius of the player
const BOX_R=150;
function inBoxRange(P,t){const a=worldPos(P.s,P.lat),b=worldPos(t.s,t.lat);return Math.hypot(b.x-a.x,b.z-a.z)<=BOX_R;}
function drawTargets(c,w,proj,u){
  const P=w.player,labels=[];c.save();
  const order=w.traffic.map(t=>[dSigned(P.s,t.s),t]).filter(([d,t])=>d>=4&&inBoxRange(P,t)).sort((a,b)=>a[0]-b[0]);
  for(const [d,t] of order){
    const l=proj(t.s,t.lat-1.15,0),r=proj(t.s,t.lat+1.15,0),tp=proj(t.s,t.lat,1.25);if(!l||!r||!tp)continue;
    let x0=Math.min(l[0],r[0]),x1=Math.max(l[0],r[0]),y1=Math.max(l[1],r[1]),y0=tp[1];const minW=12*u;if(x1-x0<minW){const m=(x0+x1)/2;x0=m-minW/2;x1=m+minW/2;}if(y1-y0<minW*0.6)y0=y1-minW*0.6;
    const pad=(x1-x0)*0.12,col=THREAT_COL[threatOf(w,t)];arBracket(c,x0-pad,y0-pad,x1+pad,y1+pad*0.5,col,!t.vis,u,true);
    drawCallSign(c,(x0+x1)/2,(y0+y1)/2,clamp((x1-x0)*0.22,8*u,15*u),callSign(w,t));
    // distance sits on top of the box, above the marker
    const tri=Math.max(7*u,Math.min(13*u,(x1-x0+2*pad)*0.22)),lab=Math.round(d)+' m',fs=Math.round(clamp(13*u*(1.2-d/400),10*u,15*u));
    c.font=`700 ${fs}px "B612 Mono", monospace`;c.textAlign='center';c.textBaseline='bottom';const lx=(x0+x1)/2,ly=y0-pad-tri*1.7-3*u,lw=c.measureText(lab).width+4*u,box=[lx-lw/2,ly-fs,lx+lw/2,ly];
    if(!labels.some(b=>box[0]<b[2]&&box[2]>b[0]&&box[1]<b[3]&&box[3]>b[1])){labels.push(box);c.fillStyle=col;c.fillText(lab,lx,ly);}}
  c.restore();}
// phone AR and phone screen mirror: pinhole camera at driver eye height
// cam: {pitch (rad, tilted down +), roll (rad, + turns the picture clockwise; the phone passes the horizon angle it
//       measures), hfov (deg, of the video), vw, vh (video size), camH (m), yawOff (rad), eyeX (m, stereo eye offset
//       to the right), rawYaw (follow the car's
//       heading exactly like the game's cockpit camera, instead of the smoothed heading)}
// AR through the sim's own camera: the pose the game rendered this frame (position, heading, the pitch dip under
// braking, kerb shake), turned by how far the phone points away from the screen (relYaw right +, relPitch down +).
// Looking at the sim, AR then follows every corner and dip of the sim picture, not a separate model of the head.
function simArCamera(w,Wd,Hd,cam){
  const c=cam.cm,px=c[0],py=c[1],pz=c[2],n=Math.hypot(c[3],c[4],c[5],c[6])||1,qx=c[3]/n,qy=c[4]/n,qz=c[5]/n,qw=c[6]/n;
  const rq=v=>{const tx=2*(qy*v[2]-qz*v[1]),ty=2*(qz*v[0]-qx*v[2]),tz=2*(qx*v[1]-qy*v[0]);return [v[0]+qw*tx+(qy*tz-qz*ty),v[1]+qw*ty+(qz*tx-qx*tz),v[2]+qw*tz+(qx*ty-qy*tx)];};
  const F0=rq([0,0,-1]),U0=rq([0,1,0]),R0=rq([1,0,0]),y=cam.relYaw||0,p=cam.relPitch||0,cy=Math.cos(y),sy=Math.sin(y),cp=Math.cos(p),sp=Math.sin(p);
  const F1=F0.map((v,i)=>v*cy+R0[i]*sy),R=R0.map((v,i)=>v*cy-F0[i]*sy),F=F1.map((v,i)=>v*cp-U0[i]*sp),U=U0.map((v,i)=>v*cp+F1[i]*sp);
  const sc=cam.vw?Math.max(Wd/cam.vw,Hd/cam.vh):1,f=((cam.vw||Wd)/2)/Math.tan(cam.hfov*Math.PI/360)*sc,cx=Wd/2,cyy=Hd/2,cr=Math.cos(cam.roll||0),sr=Math.sin(cam.roll||0),NEAR=0.8;
  const gy=worldPos(w.player.s,w.player.lat).y;
  const toCam3=(x,yy,z)=>{const dx=x-px,dy=yy-py,dz=z-pz;return [dx*R[0]+dy*R[1]+dz*R[2],dx*U[0]+dy*U[1]+dz*U[2],dx*F[0]+dy*F[1]+dz*F[2]];};
  const toCam=(x,z,yOff)=>toCam3(x,gy+yOff,z);
  const toScr=q=>{const X=f*q[0]/q[2],Y=-f*q[1]/q[2];return [cx+X*cr-Y*sr,cyy+X*sr+Y*cr,q[2]];};
  const projXZ=(x,z,yOff)=>{const q=toCam(x,z,yOff);return q[2]<NEAR?null:toScr(q);};
  const seg=(a,b)=>{if(a[2]<NEAR&&b[2]<NEAR)return null;
    if(a[2]<NEAR){const k=(NEAR-a[2])/(b[2]-a[2]);a=[a[0]+(b[0]-a[0])*k,a[1]+(b[1]-a[1])*k,NEAR];}
    else if(b[2]<NEAR){const k=(NEAR-b[2])/(a[2]-b[2]);b=[b[0]+(a[0]-b[0])*k,b[1]+(a[1]-b[1])*k,NEAR];}
    return [toScr(a),toScr(b)];};
  const hy=f*F[1]/Math.max(1e-6,Math.hypot(F[0],F[2])),hl=Math.hypot(Wd,Hd),horizon=[[cx-hl*cr-hy*sr,cyy-hl*sr+hy*cr],[cx+hl*cr-hy*sr,cyy+hl*sr+hy*cr]];
  return {E:{x:px,z:pz,fx:F[0],fz:F[2]},f,toCam,toScr,seg,projXZ,proj:(s2,lat,yOff)=>{const q=worldPos(s2,lat),v=toCam3(q.x,q.y+yOff,q.z);return v[2]<NEAR?null:toScr(v);},horizonY:cyy+hy,horizon};
}
function arCamera(w,Wd,Hd,cam){
  if(cam.cm)return simArCamera(w,Wd,Hd,cam);
  const E0=egoPose(w,cam.rawYaw),ex=cam.eyeX||0,E={x:E0.x-E0.fz*ex,z:E0.z+E0.fx*ex,fx:E0.fx,fz:E0.fz},rx=-E.fz,rz=E.fx,sc=cam.vw?Math.max(Wd/cam.vw,Hd/cam.vh):1,fv=((cam.vw||Wd)/2)/Math.tan(cam.hfov*Math.PI/360),f=fv*sc;
  const ct=Math.cos(cam.pitch),st=Math.sin(cam.pitch),cy2=Math.cos(cam.yawOff||0),sy2=Math.sin(cam.yawOff||0),cr=Math.cos(cam.roll||0),sr=Math.sin(cam.roll||0),cx=Wd/2,cy=Hd/2,camH=cam.camH,NEAR=0.8;
  // camera coordinates [right, up, depth]
  const toCam=(x,z,yOff)=>{const dx=x-E.x,dz=z-E.z;let rt=dx*rx+dz*rz,fw=dx*E.fx+dz*E.fz;const r2=rt*cy2-fw*sy2;fw=fw*cy2+rt*sy2;rt=r2;const y=yOff-camH;return [rt,y*ct+fw*st,fw*ct-y*st];};
  const toScr=q=>{const X=f*q[0]/q[2],Y=-f*q[1]/q[2];return [cx+X*cr-Y*sr,cy+X*sr+Y*cr,q[2]];};
  const projXZ=(x,z,yOff)=>{const q=toCam(x,z,yOff);return q[2]<NEAR?null:toScr(q);};
  // a 3D segment cut at the near plane, so boxes right beside you stay drawn instead of vanishing
  const seg=(a,b)=>{if(a[2]<NEAR&&b[2]<NEAR)return null;
    if(a[2]<NEAR){const k=(NEAR-a[2])/(b[2]-a[2]);a=[a[0]+(b[0]-a[0])*k,a[1]+(b[1]-a[1])*k,NEAR];}
    else if(b[2]<NEAR){const k=(NEAR-b[2])/(a[2]-b[2]);b=[b[0]+(a[0]-b[0])*k,b[1]+(a[1]-b[1])*k,NEAR];}
    return [toScr(a),toScr(b)];};
  const hy=-f*Math.tan(cam.pitch),hl=Math.hypot(Wd,Hd),horizon=[[cx-hl*cr-hy*sr,cy-hl*sr+hy*cr],[cx+hl*cr-hy*sr,cy+hl*sr+hy*cr]];
  return {E,f,toCam,toScr,seg,projXZ,proj:(s,lat,yOff)=>{const p=worldPos(s,lat);return projXZ(p.x,p.z,yOff);},horizonY:cy+hy,horizon};
}
// drivable surface, track edges, walls and kerbs on the ground plane
// The road as the driver would read it through AR: a dark asphalt surface, barriers as low panels,
// dashes along the middle that stream past with speed, bright edges, red/white kerbs, chevron boards before corners.
function arGround(c,A,P0,u,fill){
  const proj=A.proj,s0=P0.s,ds=[];for(let d=1;d<=240;d+=d<30?1.5:d<90?3:6)ds.push(d);
  const fa=d=>Math.max(0.1,1-d/255),quad=(p,q,r,t)=>{c.beginPath();c.moveTo(p[0],p[1]);c.lineTo(q[0],q[1]);c.lineTo(r[0],r[1]);c.lineTo(t[0],t[1]);c.closePath();};
  const lw=(base,d)=>Math.max(1*u,base*u*14/(Math.max(d,2)+10));
  c.save();c.lineCap='round';
  // asphalt
  if(fill)for(let i=1;i<ds.length;i++){const d0=ds[i-1],d1=ds[i],a=proj(s0+d0,-HW,0),b=proj(s0+d0,HW,0),e=proj(s0+d1,HW,0),f=proj(s0+d1,-HW,0);if(!a||!b||!e||!f)continue;
    c.fillStyle=`rgba(18,24,32,${0.5*fa(d0)})`;quad(a,b,e,f);c.fill();}
  // barriers: a 1 m panel on each side (gaps where the track opens up are left out)
  for(const sg of [-1,1])for(let i=1;i<ds.length;i++){const d0=ds[i-1],d1=ds[i],idx=Math.floor(wrapS(s0+d0)/DS)%N;if(WGL&&WGR&&(sg<0?WGL[idx]:WGR[idx]))continue;
    const a=proj(s0+d0,sg*WALL,0),b=proj(s0+d0,sg*WALL,1),e=proj(s0+d1,sg*WALL,1),f=proj(s0+d1,sg*WALL,0);if(!a||!b||!e||!f)continue;
    c.fillStyle=`rgba(150,185,210,${0.16*fa(d0)})`;quad(a,b,e,f);c.fill();c.strokeStyle=`rgba(190,215,235,${0.7*fa(d0)})`;c.lineWidth=lw(3,d0);c.beginPath();c.moveTo(b[0],b[1]);c.lineTo(e[0],e[1]);c.stroke();}
  // centre dashes, fixed to the road so they stream past: 3 m on, 6 m off
  c.strokeStyle='rgba(235,248,255,.55)';
  for(let sd=Math.ceil((s0+2)/9)*9;sd<s0+200;sd+=9){const d=sd-s0,a=proj(sd,0,0.01),b=proj(sd+3,0,0.01);if(!a||!b)continue;c.globalAlpha=fa(d);c.lineWidth=lw(5,d);c.beginPath();c.moveTo(a[0],a[1]);c.lineTo(b[0],b[1]);c.stroke();}
  c.globalAlpha=1;
  // track edges
  for(const sg of [-1,1]){let prev=null;c.strokeStyle='rgba(240,250,255,.95)';
    for(let d=-4;d<=240;d+=d<40?2:5){const q=proj(s0+d,sg*HW,0);if(!q){prev=null;continue;}
      if(prev){c.globalAlpha=fa(d);c.lineWidth=lw(10,d);c.beginPath();c.moveTo(prev[0],prev[1]);c.lineTo(q[0],q[1]);c.stroke();}prev=q;}}
  c.globalAlpha=1;
  // kerbs, and chevron boards on the outside barrier before each corner
  for(const cn of CORNERS){const d0=dSigned(s0,cn.s0),d1=dSigned(s0,cn.s1);if(d1<0||d0>240)continue;const lat=cn.sg*(HW-0.55);
    for(let d=Math.max(2,d0-10),k=Math.round(Math.max(2,d0-10)/1.5);d<=Math.min(240,d1+10);d+=1.5,k++){const a=proj(s0+d,lat,0),b=proj(s0+d+1.5,lat,0);if(!a||!b)continue;
      c.strokeStyle=k%2?'rgba(255,70,60,.9)':'rgba(255,255,255,.9)';c.lineWidth=Math.max(1.5*u,14*u*14/(d+10));c.globalAlpha=fa(d);c.beginPath();c.moveTo(a[0],a[1]);c.lineTo(b[0],b[1]);c.stroke();}
    c.globalAlpha=1;
    for(let j=0;j<3;j++){const sb=cn.s0-8+j*9,d=dSigned(s0,sb);if(d<6||d>200)continue;const lo=-cn.sg*(WALL-0.25);
      const bl=proj(sb,lo,0.5),tl=proj(sb,lo,1.7),br=proj(sb+4,lo,0.5),tr=proj(sb+4,lo,1.7);if(!bl||!tl||!br||!tr)continue;
      c.globalAlpha=fa(d);c.fillStyle='rgba(20,20,24,.85)';quad(bl,br,tr,tl);c.fill();
      const cx=(bl[0]+br[0]+tl[0]+tr[0])/4,cy=(bl[1]+br[1]+tl[1]+tr[1])/4,h=Math.abs(bl[1]-tl[1])*0.32,sgn=cn.sg>0?1:-1;
      c.strokeStyle='#FFC247';c.lineWidth=Math.max(1.5*u,h*0.35);c.lineJoin='miter';
      for(const off of [-0.55,0.55]){c.beginPath();c.moveTo(cx+(off-0.3*sgn)*h,cy-h);c.lineTo(cx+(off+0.3*sgn)*h,cy);c.lineTo(cx+(off-0.3*sgn)*h,cy+h);c.stroke();}
      c.globalAlpha=1;}}
  c.restore();
}
function radarMarks(c,w,A,u){
  // what the on-board radar is tracking, as small diamonds on the road at the radar's own position estimate
  const RD=w.radar;if(!RD)return;c.save();c.strokeStyle='#39E6B4';c.lineWidth=1.5*u;
  for(const T of RD.tracks){if(!T.conf||T.barrier)continue;const q=A.projXZ(T.x,T.z,0.05);if(!q)continue;const r=clamp(A.f*0.8/q[2],3.5*u,12*u);
    c.globalAlpha=T.obj?0.95:0.6;c.beginPath();c.moveTo(q[0],q[1]-r*0.6);c.lineTo(q[0]+r,q[1]);c.lineTo(q[0],q[1]+r*0.6);c.lineTo(q[0]-r,q[1]);c.closePath();c.stroke();}
  c.restore();}
// phone screen mirror: the game screen's HUD layout (target boxes, hazard brackets, nav panel, lap tracker,
// pedals) plus the track edges, drawn from the same camera as the game's driver view, with no 3D picture
// the game's actual render camera (position and quaternion from three.js, 60 degree vertical FOV): used when the
// phone draws over the sim picture, so the overlay matches the 3D view exactly (slope, braking dip, eye offset, chase)
function gameCamera(cm,Wd,Hd,fov=60){const [px,py,pz]=cm,n=Math.hypot(...cm.slice(3,7))||1,[qx,qy,qz,qw]=cm.slice(3,7).map(v=>v/n),f=(Hd/2)/Math.tan(fov*Math.PI/360),cx=Wd/2,cy=Hd/2;
  const toCam=(x,y,z)=>{const dx=x-px,dy=y-py,dz=z-pz,ix=qw*dx-qy*dz+qz*dy,iy=qw*dy-qz*dx+qx*dz,iz=qw*dz-qx*dy+qy*dx,iw=qx*dx+qy*dy+qz*dz;   // rotate by the inverse quaternion
    return [ix*qw+iw*qx+iy*qz-iz*qy,iy*qw+iw*qy+iz*qx-ix*qz,iz*qw+iw*qz+ix*qy-iy*qx];};
  const projXYZ=(x,y,z)=>{const c=toCam(x,y,z),dep=-c[2];if(dep<0.3)return null;return [cx+f*c[0]/dep,cy-f*c[1]/dep,dep];};
  return {f,proj:(s,lat,yOff)=>{const p=worldPos(s,lat);return projXYZ(p.x,p.y+yOff,p.z);}};}
function drawScreen(c,w,t,dt,overlay){
  const u=clamp(Math.min(cw/1100,ch/620),0.55,1.4),A=w.cm?gameCamera(w.cm,cw,ch,w.fov||60):arCamera(w,cw,ch,{pitch:0.035,hfov:2*Math.atan(Math.tan(30*Math.PI/180)*cw/ch)*180/Math.PI,camH:1.0,yawOff:0,rawYaw:true});
  c.save();arGround(c,A,w.player,u,false);arFlags(c,w,A,w.player,u);c.restore();
  if(w.opts.hud!==false){
    const R=navRegion(u),pd=22*u;if(!overlay){c.save();c.translate(R.x+R.w/2,R.y+R.h/2);c.scale(R.w/2+pd,R.h/2+pd);
    const g=c.createRadialGradient(0,0,0,0,0,1);g.addColorStop(0,'rgba(3,9,13,.5)');g.addColorStop(0.7,'rgba(3,9,13,.34)');g.addColorStop(1,'rgba(3,9,13,0)');c.fillStyle=g;c.fillRect(-1,-1,2,2);c.restore();}
    drawConformal(c,w,u,A.proj,true);drawNav(c,w,t,dt,u);
    {const th=clamp(ch*0.09,40,90);c.save();c.globalAlpha=0.95;drawTracker(c,w,cw*0.05,Math.max(ch*0.1,60*u),Math.min(cw*0.56,cw-R.w-cw*0.1),th,u,RM?true:((t*3)%1)<0.6);c.restore();}}
  if(!overlay)drawPedals(c,w,u);
}
function navRegion(u){
  const w=Math.round(clamp(cw*(NAV.big?0.5:0.34),190,NAV.big?640:450)), h=Math.round(Math.min(w*1.0,ch*0.84));
  return {x:cw-w-Math.max(12,cw*0.045), y:Math.max(12,ch*0.1), w, h:Math.min(h,ch*0.78)};
}
function drawNav(c,w,t,dt,u,Rin,fixedRange){
  const P=w.player, R=Rin||navRegion(u), hi=headerInfo(w), flash=RM?true:((t*3)%1)<0.6;
  if(!Rin)NAV.rects={panel:[R.x,R.y,R.w,R.h]};
  c.save();c.lineCap='round';c.lineJoin='round';
  const col=hi.col;
  // --- flat top-down radar, heading up, like a sim-racing proximity radar: your car low in the frame so more of the
  // road ahead fits, range rings from your car, everything drawn to scale, side bars when a car is alongside.
  // The range zooms in when cars are close and out at speed.
  const bb=fixedRange?0:Math.round(R.h*0.13), mx=R.x, my=R.y, mw=R.w, mh=R.h-bb;
  let ahead=clamp(60+P.v*2.2,90,300);
  if(w.near&&w.dNear<300) ahead=clamp(w.dNear+40,80,320);
  let side=false; for(const tc of w.traffic){const d=dSigned(P.s,tc.s); if(d>-25&&d<40){side=true;break;}}
  if(side) ahead=Math.min(ahead,55);
  ahead*=NAV.zoom; const kk=dt>0?1-Math.exp(-dt*2.4):0;
  if(!fixedRange)NAV.cur=lerp(NAV.cur,ahead,kk);
  const A=fixedRange||NAV.cur, cx=mx+mw/2, ye=my+mh*0.7, K=(ye-(my+mh*0.03))/A, minFw=-(my+mh-ye)/K, dmax=A*1.05;
  const E=egoPose(w), rx=-E.fz, rz=E.fx;
  const loc=(x,z)=>{const dx=x-E.x,dz=z-E.z;return [dx*rx+dz*rz,dx*E.fx+dz*E.fz];};
  const pr=(rt,fw)=>[cx+rt*K,ye-fw*K];
  const fade=fw=>1-0.7*clamp((fw-A*0.6)/(A*0.5),0,1);
  // radar face: a dark rounded square with range rings centred on your car
  c.save();rr(c,mx,my,mw,mh,12*u);c.fillStyle='rgba(4,8,12,.55)';c.fill();c.strokeStyle=HC.faint;c.lineWidth=1*u;c.stroke();c.clip();
  const ring=[10,25,50,100,200].find(v=>v*K>=mh*0.2)||200;
  c.font=`${8.5*u}px "B612 Mono", monospace`;c.textAlign='left';c.textBaseline='bottom';c.lineWidth=1*u;
  for(let r=ring;r<A*1.25;r+=ring){c.strokeStyle='rgba(196,248,255,.1)';c.beginPath();c.arc(cx,ye,r*K,0,TAU);c.stroke();c.fillStyle=HC.dim;c.fillText(r+' M',cx+4*u,ye-r*K-2*u);}
  c.strokeStyle='rgba(196,248,255,.07)';c.beginPath();c.moveTo(cx,my);c.lineTo(cx,my+mh);c.moveTo(mx,ye);c.lineTo(mx+mw,ye);c.stroke();
  const st=Math.max(1,A/120);
  // flag sections: marshal sectors under a yellow or red flag, shaded across the track, flag at each sector start
  if(w.flags&&w.secLen){const n=w.flags.length,sl=w.secLen;
    for(let k=0;k<n;k++){const f=w.flags[k];if(!f)continue;const d0=dSigned(P.s,k*sl),d1=d0+sl;if(d1<minFw-10||d0>dmax)continue;
      const Lp=[],Rp=[];for(let d=Math.max(d0,minFw-10);d<=Math.min(d1,dmax)+0.01;d+=st){const a=worldPos(P.s+d,-HW),b=worldPos(P.s+d,HW),la=loc(a.x,a.z),lb=loc(b.x,b.z);Lp.push(pr(la[0],la[1]));Rp.push(pr(lb[0],lb[1]));}
      if(Lp.length>1){c.fillStyle=f===2?'rgba(255,59,47,.4)':'rgba(255,194,71,.32)';c.beginPath();Lp.forEach((q,i)=>i?c.lineTo(q[0],q[1]):c.moveTo(q[0],q[1]));for(let i=Rp.length-1;i>=0;i--)c.lineTo(Rp[i][0],Rp[i][1]);c.closePath();c.fill();}
      if(d0>=minFw&&d0<=dmax){const p=worldPos(k*sl,HW+2.5),l=loc(p.x,p.z),q=pr(l[0],l[1]);flagIcon(c,q[0],q[1],f,7*u);}}}
  const strip=(latF,colr,lw,dash,glow)=>{
    const bands=[[],[],[],[]];let prev=null;
    for(let d=minFw-8;d<=dmax;d+=st){const p=worldPos(P.s+d,latF(d)),l=loc(p.x,p.z);if(l[1]<minFw){prev=null;continue;}const q=pr(l[0],l[1]);
      if(prev){const b=Math.min(3,Math.floor((1-fade(l[1]))*4));bands[b].push(prev[0],prev[1],q[0],q[1]);}prev=q;}
    if(dash)c.setLineDash(dash);
    for(const pass of glow?[0,1]:[1]){c.strokeStyle=colr;c.lineWidth=pass?lw:lw*3.2;
      bands.forEach((seg,b)=>{if(!seg.length)return;c.globalAlpha=(1-b*0.26)*(pass?1:0.18);c.beginPath();
        for(let i=0;i<seg.length;i+=4){c.moveTo(seg[i],seg[i+1]);c.lineTo(seg[i+2],seg[i+3]);}c.stroke();});}
    c.globalAlpha=1;c.setLineDash([]);};
  strip(()=>-WALL,HC.faint,1*u); strip(()=>WALL,HC.faint,1*u);
  strip(()=>-HW,HC.mid,1.8*u,null,true); strip(()=>HW,HC.mid,1.8*u,null,true);
  // on-board radar: field-of-view edges, this scan's raw returns (barrier returns faint), confirmed tracks as diamonds
  const RD=w.radar;
  if(RD&&RD.ox!=null){const O=loc(RD.ox,RD.oz),RT='57,230,180';c.lineWidth=1*u;c.setLineDash([2*u,4*u]);
    for(const [hf,rm] of [[9,Math.min(250,RD.rng||250)],[45,80]])for(const sg of [-1,1]){const a=sg*hf*Math.PI/180+(NAV.yawD||0),seg=[];
      for(let r=2;r<=rm;r+=Math.max(2,rm/40)){const fw=O[1]+r*Math.cos(a);if(fw>dmax)break;seg.push(pr(O[0]+r*Math.sin(a),fw));}
      if(seg.length>1){c.strokeStyle=`rgba(${RT},.32)`;c.beginPath();seg.forEach((q,k)=>k?c.lineTo(q[0],q[1]):c.moveTo(q[0],q[1]));c.stroke();}}
    c.setLineDash([]);
    for(const d of RD.dets){const l=loc(d.x,d.z);if(l[1]<minFw||l[1]>dmax)continue;const q=pr(l[0],l[1]),r=(d.st?1.3:2)*u;
      c.fillStyle=d.st?`rgba(${RT},.35)`:`rgba(${RT},.9)`;c.fillRect(q[0]-r,q[1]-r,2*r,2*r);}
    for(const T of RD.tracks){if(!T.conf||T.barrier)continue;const l=loc(T.x,T.z);if(l[1]<minFw||l[1]>dmax)continue;const q=pr(l[0],l[1]),r=4.5*u;
      c.strokeStyle=T.obj?`rgb(${RT})`:HC.amb;c.lineWidth=1.5*u;c.beginPath();c.moveTo(q[0],q[1]-r);c.lineTo(q[0]+r,q[1]);c.lineTo(q[0],q[1]+r);c.lineTo(q[0]-r,q[1]);c.closePath();c.stroke();}}

  // corner labels
  for(const cn of CORNERS){const d=dSigned(P.s,cn.apex);if(d<0||d>dmax)continue;const p=worldPos(cn.apex,-cn.sg*(WALL+5)),l=loc(p.x,p.z);if(l[1]<minFw)continue;const q=pr(l[0],l[1]);c.globalAlpha=fade(l[1]);hudTag(c,q[0],q[1],'T'+cn.n,HC.mid,u,8.5);c.globalAlpha=1;}
  // footprints in perspective
  const poly=(rt0,fw0,hr,hf,aL,aW,oa,ob)=>{const pts=[];for(const [a,b] of [[aL,aW],[aL,-aW],[-aL,-aW],[-aL,aW]]){const A2=a+(oa||0),B2=b+(ob||0);const rt=rt0+hr*A2+hf*B2,fw=fw0+hf*A2-hr*B2;if(fw<minFw)return null;pts.push(pr(rt,fw));}return pts;};
  const shape=(pts,stroke,fill,lw,dash)=>{if(!pts)return;c.beginPath();pts.forEach((q,k)=>k?c.lineTo(q[0],q[1]):c.moveTo(q[0],q[1]));c.closePath();if(fill){c.fillStyle=fill;c.fill();}if(stroke){c.strokeStyle=stroke;c.lineWidth=lw;if(dash)c.setLineDash(dash);c.stroke();c.setLineDash([]);}};
  // car icons keep a readable minimum size at long range (positions stay to scale)
  const cs=Math.max(1,16*u/(5.4*K)),pc=(rt0,fw0,hr,hf,aL,aW,oa,ob)=>poly(rt0,fw0,hr,hf,aL*cs,aW*cs,(oa||0)*cs,(ob||0)*cs);
  const car=(rt0,fw0,hr,hf,colr,mode)=>{
    if(mode!=='hidden'){for(const [a,b] of [[1.75,0.84],[1.75,-0.84],[-1.6,0.84],[-1.6,-0.84]])shape(pc(rt0,fw0,hr,hf,0.36,0.2,a,b),null,colr,0);
      shape(pc(rt0,fw0,hr,hf,0.05,0.95,2.7,0),null,colr,0);}
    shape(pc(rt0,fw0,hr,hf,2.55,0.5),colr,mode==='hidden'?null:(mode==='ego'?'rgba(196,248,255,.3)':'rgba(196,248,255,.14)'),1.6*u,mode==='hidden'?[3*u,2.5*u]:null);
    if(mode==='ego')shape(pc(rt0,fw0,hr,hf,0.5,0.28,1.5,0),null,colr,0);};
  const lh2=(x,z,hx,hz)=>{const l=loc(x,z);return [l[0],l[1],hx*rx+hz*rz,hx*E.fx+hz*E.fz];};
  for(const h of w.hazards){if(h.gone)continue;const d=dSigned(P.s,h.s);if(d<-20||d>RANGE)continue;
    const p=worldPos(h.s,h.lat),hd=headingAt(h.s,h.yaw||0),L2=lh2(p.x,p.z,hd[0],hd[1]),hcol=w.alert===2&&h===w.near?HC.red:HC.amb;
    if(L2[1]<=dmax){shape(poly(L2[0],L2[1],L2[2],L2[3],h.halfLen,h.halfW),hcol,flash?'rgba(255,194,71,.28)':null,1.8*u);
      const q=pr(L2[0],L2[1]),s=clamp(K*5,12*u,24*u);hazIcon(c,h.type,q[0],q[1]-s*0.9,s,hcol,flash);
      c.fillStyle=hcol;c.font=`700 ${9.5*u}px "B612 Mono", monospace`;c.textAlign='center';c.textBaseline='alphabetic';c.fillText(Math.round(d)+' M',q[0],q[1]-s*1.75);}
    else{const txt=`▲ ${h.label.toUpperCase()} ${Math.round(d)} M`;hudTag(c,cx,my+12*u,txt,hcol,u,9.5);}}
  for(const tc of w.traffic){const d=dSigned(P.s,tc.s);if(d<minFw-6||d>dmax)continue;const p=worldPos(tc.s,tc.lat),hd=headingAt(tc.s,carYaw(tc)),L2=lh2(p.x,p.z,hd[0],hd[1]);
    c.globalAlpha=fade(L2[1]);car(L2[0],L2[1],L2[2],L2[3],tc.closing?HC.red:HC.pri,tc.vis?'solid':'hidden');
    {const q=pr(L2[0],L2[1]);drawCallSign(c,q[0],q[1],clamp(5.4*K*cs*0.3,7*u,11*u),callSign(w,tc));}c.globalAlpha=1;}
  car(0,0,Math.sin(NAV.yawD||0),Math.cos(NAV.yawD||0),HC.pri,'ego');
  drawFlagChip(c,w,P.s,mx+8*u,my+8*u,u);
  // side bars: a car overlapping you lights the bar on its side, amber, red when there is little room
  for(const sg of [-1,1]){let gap=null;
    for(const tc of w.traffic){const d=dSigned(P.s,tc.s),dl=tc.lat-P.lat;if(Math.abs(d)<6&&Math.sign(dl)===sg&&Math.abs(dl)<5){const g=Math.abs(dl)-2;if(gap==null||g<gap)gap=g;}}
    if(gap==null)continue;const bh2=mh*0.34;c.fillStyle=gap<0.6?HC.red:HC.amb;c.globalAlpha=0.9;rr(c,sg<0?mx+6*u:mx+mw-12*u,ye-bh2/2,6*u,bh2,3*u);c.fill();c.globalAlpha=1;}
  // wheel-to-wheel gap
  for(const tc of w.traffic){const d=dSigned(P.s,tc.s);if(Math.abs(d)>6.5)continue;const dl=tc.lat-P.lat,sg=Math.sign(dl)||1,gap=Math.max(0,Math.abs(dl)-2.0);
    const fw=d*0.5,a=pr(sg*1.0,fw),b=pr(dl-sg*1.0,fw),colr=gap<0.6?HC.red:HC.amb;
    c.strokeStyle=colr;c.lineWidth=1.6*u;c.beginPath();c.moveTo(a[0],a[1]);c.lineTo(b[0],b[1]);c.moveTo(a[0],a[1]-5*u);c.lineTo(a[0],a[1]+5*u);c.moveTo(b[0],b[1]-5*u);c.lineTo(b[0],b[1]+5*u);c.stroke();
    c.fillStyle=colr;c.font=`700 ${11*u}px "B612 Mono", monospace`;c.textAlign='center';c.textBaseline='alphabetic';c.fillText(gap.toFixed(1)+' M',(a[0]+b[0])/2,a[1]-9*u);}
  c.restore();
  // --- bottom row: pass sign, visibility, radar status (not on the compact AR radar)
  if(!fixedRange){
  const by=R.y+R.h-bb, bh=bb*0.86, bw=Math.max(80*u,R.w*0.3);
  if(hi.kind==='haz'&&P.v>hi.h.vpass+2){const px=R.x+4*u,s=bh;c.strokeStyle=col;c.lineWidth=1.8*u;rr(c,px,by,s*0.9,s,4*u);c.stroke();
    c.fillStyle=col;c.textAlign='center';c.font=`700 ${s*0.18}px "B612 Mono", monospace`;c.fillText('PASS',px+s*0.45,by+s*0.24);c.font=`700 ${s*0.42}px "B612 Mono", monospace`;c.fillText(String(Math.round(hi.h.vpass*3.6)),px+s*0.45,by+s*0.64);}
  c.fillStyle=w.vis<120?HC.amb:HC.mid;c.textAlign='right';c.font=`700 ${10.5*u}px "B612 Mono", monospace`;c.fillText(`VIS ${Math.round(w.vis)} M`,R.x+R.w-4*u,by+bh*0.72);
  c.fillStyle=HC.dim;c.font=`${9*u}px "B612 Mono", monospace`;c.fillText(NAV.zoom===1?'AUTO RANGE':'RANGE ×'+(1/NAV.zoom).toFixed(1),R.x+R.w-4*u,by+bh*0.28);
  if(RD&&RD.rng){c.textAlign='center';c.fillStyle='rgba(57,230,180,.85)';c.font=`700 ${10*u}px "B612 Mono", monospace`;c.fillText(`RADAR ${Math.round(RD.rng)} M`,R.x+R.w*0.55,by+bh*0.72);
    c.fillStyle=HC.dim;c.font=`${9*u}px "B612 Mono", monospace`;c.fillText(`77 GHZ · −${RD.att.toFixed(1)} DB · ${RD.tracks.filter(T=>T.conf&&!T.barrier).length} TRK`,R.x+R.w*0.55,by+bh*0.28);}
  }
  c.textBaseline='alphabetic';
  c.restore();
}
// flags: the next flagged marshal sector within `range` m ahead ({f: 1 yellow / 2 red, d: metres, k: sector})
function nextFlag(w,s,range){if(!w.flags||!w.secLen)return null;const n=w.flags.length,sl=w.secLen,k0=Math.floor(wrapS(s)/sl)%n;
  for(let i=0;i<n;i++){const k=(k0+i)%n,f=w.flags[k];if(!f)continue;const d=i?dSigned(s,k*sl):0;if(d>range)return null;return {f,d:Math.max(0,d),k};}return null;}
const FLAG_COL=['','#FFC247','#FF3B2F'];
function flagIcon(c,x,y,f,s){c.save();c.strokeStyle='#E8EEF2';c.lineWidth=Math.max(1,s*0.1);c.beginPath();c.moveTo(x,y);c.lineTo(x,y-s*1.6);c.stroke();
  c.fillStyle=FLAG_COL[f];c.beginPath();c.moveTo(x,y-s*1.6);c.quadraticCurveTo(x+s*0.6,y-s*1.75,x+s*1.2,y-s*1.55);c.lineTo(x+s*1.2,y-s*0.85);c.quadraticCurveTo(x+s*0.6,y-s*1.05,x,y-s*0.9);c.closePath();c.fill();c.restore();}
function drawFlagChip(c,w,s,x,y,u){const nf=nextFlag(w,s,700);if(!nf)return;
  const txt=`${nf.f===2?'RED':'YELLOW'} · S${nf.k+1}${nf.d>1?' · '+Math.round(nf.d)+' M':''}`;c.save();c.font=`700 ${10.5*u}px "B612 Mono", monospace`;
  const tw=c.measureText(txt).width,bw=tw+30*u,bh=20*u;c.fillStyle='rgba(0,0,0,.55)';rr(c,x,y,bw,bh,4*u);c.fill();c.strokeStyle=FLAG_COL[nf.f];c.lineWidth=1.5*u;c.stroke();
  flagIcon(c,x+9*u,y+bh-4*u,nf.f,8*u);c.fillStyle=FLAG_COL[nf.f];c.textAlign='left';c.textBaseline='middle';c.fillText(txt,x+22*u,y+bh/2+0.5*u);c.restore();return bw;}
// AR / screen view: flagged sectors tinted on the road, flag posts on both barriers at the start of each sector
function arFlags(c,w,A,P0,u){if(!w.flags||!w.secLen)return;const n=w.flags.length,sl=w.secLen;c.save();
  for(let k=0;k<n;k++){const f=w.flags[k];if(!f)continue;const d0=dSigned(P0.s,k*sl),d1=d0+sl;if(d1<2||d0>240)continue;
    const L1=[],R1=[];for(let d=Math.max(d0,2);d<=Math.min(d1,240)+0.01;d+=d<40?2:4){const a=A.proj(P0.s+d,-HW,0.02),b=A.proj(P0.s+d,HW,0.02);if(a&&b){L1.push(a);R1.push(b);}}
    if(L1.length>1){c.fillStyle=f===2?'rgba(255,59,47,.26)':'rgba(255,194,71,.2)';c.beginPath();L1.forEach((p,i)=>i?c.lineTo(p[0],p[1]):c.moveTo(p[0],p[1]));for(let i=R1.length-1;i>=0;i--)c.lineTo(R1[i][0],R1[i][1]);c.closePath();c.fill();}
    if(d0>=2&&d0<=240)for(const sg of [-1,1]){const b=A.proj(P0.s+d0,sg*(WALL-0.2),0),t=A.proj(P0.s+d0,sg*(WALL-0.2),2.4);if(!b||!t)continue;
      flagIcon(c,t[0],b[1],f,clamp((b[1]-t[1])/1.6,4*u,40*u));}}
  c.restore();}
// tyre compounds (physics in physics/vehicle.c): sidewall colour and the tread's working window, deg C
const TYRES=[{n:'Soft',k:'S',col:'#E8202A',t:95,win:22},{n:'Medium',k:'M',col:'#F5C518',t:105,win:25},{n:'Hard',k:'H',col:'#EDEDED',t:115,win:28},
  {n:'Intermediate',k:'I',col:'#35B14A',t:75,win:30},{n:'Wet',k:'W',col:'#1E7BD8',t:60,win:35}];
// tread temperature against the compound's window: blue cold, green in the window, red overheating
function tyreTempCol(T,c){const x=(T-c.t)/c.win;return x<-0.6?'#4A9CFF':x>0.6?'#FF4B3A':x<-0.3?'#7FD0E8':x>0.3?'#FFB547':'#35D98A';}
// badge: compound ring, a car-shaped plan of the four tyres coloured by temperature, and what is left of the tread
function drawTyres(c,P,x,y,u){const k=TYRES[P.comp];if(!k||P.tempF==null)return;
  c.save();c.textBaseline='middle';
  c.lineWidth=2.6*u;c.strokeStyle=k.col;c.beginPath();c.arc(x,y,11*u,0,TAU);c.stroke();
  c.fillStyle=k.col;c.textAlign='center';c.font=`700 ${11*u}px "B612 Mono", monospace`;c.fillText(k.k,x,y+0.5*u);
  const tw=6*u,th=10*u,gx=x+22*u;
  [[P.tempF,-1],[P.tempF,1],[P.tempR,-1],[P.tempR,1]].forEach(([T,sx],i)=>{c.fillStyle=tyreTempCol(T,k);rr(c,gx+(sx>0?9*u:0),y-12*u+(i>1?14*u:0),tw,th,1.5*u);c.fill();});
  c.fillStyle=HC.pri;c.textAlign='left';c.font=`${9*u}px "B612 Mono", monospace`;
  c.fillText(Math.round(P.tempF)+'°',gx+22*u,y-6*u);c.fillText(Math.round(P.tempR)+'°',gx+22*u,y+8*u);
  const wear=Math.max(P.wearF||0,P.wearR||0);c.fillStyle=wear>0.6?HC.red:wear>0.35?HC.amb:HC.dim;c.fillText(Math.round((1-wear)*100)+'%',gx+48*u,y+1*u);
  c.restore();}
// TC and ABS lamps, lit amber while the system is cutting torque / modulating the brakes, with the set levels
function drawAids(c,P,o,x,y,u){if(P.tcCut==null)return;c.save();c.textAlign='right';c.textBaseline='middle';c.font=`700 ${10*u}px "B612 Mono", monospace`;
  [['TC',o.tcT===0?0:o.tcC?'C':o.tc,P.tcCut>0.04],['ABS',o.absT===0?0:o.absC?'C':o.abs,(P.absF||P.absR)>0]].forEach(([n,l,on],i)=>{const yy=y-7*u+i*15*u;
    c.fillStyle=!l?HC.faint:on?HC.amb:HC.dim;c.fillText(n+' '+(l?l:'OFF'),x,yy);if(on&&l){c.beginPath();c.arc(x+6*u,yy,3*u,0,TAU);c.fill();}});
  c.restore();}
function drawPedals(c,w,u,speed){
  const P=w.player, x=cw/2, y=ch*(w.lift?0.76:0.93), showSpeed=speed||!w.opts.hud, drive=w.opts.driver==='drive';
  if(!showSpeed&&!drive)return;
  c.save();
  const bh=34*u, bw=5*u;
  if(drive){c.strokeStyle=HC.dim;c.lineWidth=1*u;c.strokeRect(x-38*u,y-bh,bw,bh);c.strokeRect(x+33*u,y-bh,bw,bh);
    c.fillStyle=HC.red;c.fillRect(x-38*u,y-bh*P.brk,bw,bh*P.brk);c.fillStyle='#7DFFB8';c.fillRect(x+33*u,y-bh*P.thr,bw,bh*P.thr);
    const st=P.steer||0;c.strokeStyle=HC.dim;c.lineWidth=1.6*u;c.beginPath();c.arc(x,y-bh+6*u,22*u,-Math.PI*0.8,-Math.PI*0.2);c.stroke();
    const a=-Math.PI/2+st*Math.PI*0.3;c.fillStyle=HC.pri;c.beginPath();c.arc(x+Math.cos(a)*22*u,y-bh+6*u+Math.sin(a)*22*u,3.2*u,0,TAU);c.fill();
    if(P.beta!=null&&Math.abs(P.beta)>0.1&&P.v>5){c.fillStyle=HC.amb;c.textAlign='center';c.font=`700 ${13*u}px "B612 Mono", monospace`;c.fillText('DRIFT '+Math.round(Math.abs(P.beta)*57.3)+'°',x,y-bh-62*u);}
    if(P.gear!=null){c.fillStyle=HC.pri;c.textAlign='center';c.font=`700 ${22*u}px "B612 Mono", monospace`;c.fillText(P.rev?'R':String(P.gear+1),x,y-bh-24*u);
      const f=clamp((P.rpm-9000)/2800,0,1),lit=Math.round(f*15),blink=P.rpm>11600&&((performance.now()/70)|0)%2;
      for(let i=0;i<15;i++){const lx=x+(i-7)*7.5*u,ly=y-bh-48*u,col=i<5?'#35D98A':i<10?'#FF4B3A':'#4A9CFF';
        c.fillStyle=i<lit&&!blink?col:'rgba(196,248,255,.12)';c.beginPath();c.arc(lx,ly,2.6*u,0,TAU);c.fill();}}}
  if(drive){drawTyres(c,P,x+62*u,y-bh*0.5,u);drawAids(c,P,w.opts,x-66*u,y-bh*0.5,u);}
  if(showSpeed){c.fillStyle=HC.pri;c.textAlign='center';c.font=`700 ${20*u}px "B612 Mono", monospace`;c.fillText(String(Math.round(P.v*3.6)),x,y-12*u);
    c.font=`${8.5*u}px "B612 Mono", monospace`;c.fillText('KM/H',x,y-1*u);}
  c.restore();
}
/*<HUD*/
function drawHUD(w,t,dt){
  hc.setTransform(dpr,0,0,dpr,0,0);hc.clearRect(0,0,cw,ch);
  const u=clamp(Math.min(cw/1100,ch/620),0.55,1.4), o=w.opts;
  // the game screen stays clean: no boxes, no radar panel and no position tracker (the phone HUD and the PC
  // visor carry those); only gear and speed remain
  NAV.rects=null;$('combiner').hidden=true;
  // PC visor (toggle): the full visor HUD drawn through this frame's own camera
  if(ui.pcVisor){const q=camera.quaternion,p=camera.position;
    drawScreen(hc,Object.assign({},w,{cm:[p.x,p.y,p.z,q.x,q.y,q.z,q.w],fov:camera.fov}),t,dt,true);}
  drawPedals(hc,Object.assign({},w,{lift:ui.cam==='cockpit'&&!!player.userData.cockpit}),u,true);   // cockpit: above the wheel's own screen
}
function setPcVisor(on){ui.pcVisor=!!on;const b=$('pcVisor');b.setAttribute('aria-pressed',on?'true':'false');b.querySelector('b').textContent=on?'On':'Off';
  try{localStorage.setItem('lar.pcvisor',on?'1':'0');}catch(e){}}

/* ================= AUDIO (optional) ================= */
/* ================= SOUND: a real V8 =================
   The engine is built from recordings of real V8s (tools/engine_samples.py cuts them into seamless loops, each at
   one exact rpm; credits in assets/engine/CREDITS.txt): idle and low revs and free revving from a Maserati V8,
   full load from the Bentley Speed 8 Le Mans car. Each loop plays at playbackRate = rpm / its recorded rpm and the
   loops crossfade by rpm and throttle (equal power). On top: a throttle-driven tone filter, a hard cut on each
   upshift, crackle on the overrun, wind and rain, and the nearest other car (panned, with Doppler). */
let AC=null,eng=null;
const ENG_LOOPS=['idle','low','high','load'];
function audioStart(){
  try{AC=AC||new (window.AudioContext||window.webkitAudioContext)();soundGate();
    if(eng)return;
    const master=AC.createGain();master.gain.value=0.9;
    const comp=AC.createDynamicsCompressor();comp.threshold.value=-16;comp.knee.value=12;comp.ratio.value=4;comp.attack.value=0.004;comp.release.value=0.12;
    comp.connect(master);master.connect(AC.destination);
    // engine bus: voices -> tone filter -> slight saturation -> level
    const tone=AC.createBiquadFilter();tone.type='lowpass';tone.frequency.value=4000;tone.Q.value=0.6;
    const sat=AC.createWaveShaper(),cv=new Float32Array(1024);for(let i=0;i<1024;i++){const x=i/511.5-1;cv[i]=Math.tanh(1.6*x)/Math.tanh(1.6);}sat.curve=cv;
    const lvl=AC.createGain();lvl.gain.value=0;tone.connect(sat);sat.connect(lvl);lvl.connect(comp);
    // wind + rain: looped noise, band-shaped
    const nb=AC.createBuffer(1,AC.sampleRate*2,AC.sampleRate),d=nb.getChannelData(0);for(let i=0;i<d.length;i++)d[i]=Math.random()*2-1;
    const ns=AC.createBufferSource();ns.buffer=nb;ns.loop=true;const nf=AC.createBiquadFilter();nf.type='bandpass';nf.frequency.value=900;nf.Q.value=0.4;
    const ng=AC.createGain();ng.gain.value=0;ns.connect(nf);nf.connect(ng);ng.connect(comp);ns.start();
    eng={master,comp,tone,lvl,ng,nf,nb,voices:null,other:null,cut:0,gear:null,thrPrev:0,crackleUntil:0,nextPop:0};
    // tyres: the squeal loop (credits in assets/tyres/CREDITS.txt), a low rumble over grass, kerbs and gravel, and
    // the gritty crunch of stones in a gravel trap (band-passed noise, randomly modulated)
    {const tf=AC.createBiquadFilter();tf.type='peaking';tf.frequency.value=1800;tf.Q.value=0.8;tf.gain.value=3;const tg=AC.createGain();tg.gain.value=0;tf.connect(tg);tg.connect(comp);
      const loop=(rate,type,f,q)=>{const s=AC.createBufferSource();s.buffer=nb;s.loop=true;s.playbackRate.value=rate;const fl=AC.createBiquadFilter();fl.type=type;fl.frequency.value=f;fl.Q.value=q;const g=AC.createGain();g.gain.value=0;s.connect(fl);fl.connect(g);g.connect(comp);s.start();return g;};
      eng.tyre={f:tf,g:tg,src:null,rg:loop(0.5,'lowpass',160,0.7),cg:loop(1,'bandpass',2600,1.2)};
      fetch('/assets/tyres/squeal.wav').then(r=>r.arrayBuffer()).then(b=>new Promise((ok,no)=>AC.decodeAudioData(b,ok,no)))
        .then(buf=>{const s=AC.createBufferSource();s.buffer=buf;s.loop=true;s.connect(tf);s.start(0,Math.random()*buf.duration);eng.tyre.src=s;}).catch(e=>console.warn('tyre sound unavailable',e));}
    Promise.all([fetch('/assets/engine/loops.json').then(r=>r.json()),
      ...ENG_LOOPS.map(n=>fetch('/assets/engine/'+n+'.wav').then(r=>r.arrayBuffer()).then(b=>new Promise((ok,no)=>AC.decodeAudioData(b,ok,no))))])
    .then(([meta,...bufs])=>{
      const voice=(buf,rpm,dest)=>{const src=AC.createBufferSource();src.buffer=buf;src.loop=true;const g=AC.createGain();g.gain.value=0;src.connect(g);g.connect(dest);
        src.start(0,Math.random()*buf.duration);return {src,g,rpm};};
      eng.voices={};ENG_LOOPS.forEach((n,i)=>{eng.voices[n]=voice(bufs[i],meta[n].rpm,tone);});
      // the nearest other car: its own load loop, filtered by distance, panned
      const pan=AC.createStereoPanner?AC.createStereoPanner():null,of=AC.createBiquadFilter();of.type='lowpass';of.frequency.value=2500;
      const ov=voice(bufs[3],meta.load.rpm,of);if(pan){of.connect(pan);pan.connect(comp);}else of.connect(comp);
      eng.other={v:ov,pan,f:of};
    }).catch(e=>{console.warn('engine sound unavailable',e);});
  }catch(e){AC=null;}
}
function beep(){if(!AC||!ui.sound)return;const t=AC.currentTime;for(let k=0;k<2;k++){const o=AC.createOscillator(),g=AC.createGain();o.type='sine';o.frequency.value=1250;g.gain.setValueAtTime(0,t+k*0.14);g.gain.linearRampToValueAtTime(0.09,t+k*0.14+0.01);g.gain.linearRampToValueAtTime(0,t+k*0.14+0.1);o.connect(g);g.connect(AC.destination);o.start(t+k*0.14);o.stop(t+k*0.14+0.12);}}
// engine speed for cars without the full drivetrain model (autopilot, traffic): the gear from speed, rpm within it
const GEAR_V=[0,22,33,43,52,61,70,78,99];
function rpmFromSpeed(v){let gi=1;while(gi<GEAR_V.length-1&&v>GEAR_V[gi])gi++;const f=clamp((v-GEAR_V[gi-1])/(GEAR_V[gi]-GEAR_V[gi-1]),0,1);return {rpm:4200+(gi===1?f*7000:3600+f*3800),gear:gi};}
// one short exhaust pop (unburnt fuel on the overrun): a burst of band-passed noise
function pop(t,amp){const s=AC.createBufferSource();s.buffer=eng.nb;const f=AC.createBiquadFilter();f.type='bandpass';f.frequency.value=500+Math.random()*1400;f.Q.value=1.2;
  const g=AC.createGain();g.gain.setValueAtTime(0,t);g.gain.linearRampToValueAtTime(amp,t+0.004);g.gain.exponentialRampToValueAtTime(0.001,t+0.05+Math.random()*0.04);
  s.connect(f);f.connect(g);g.connect(eng.comp);s.start(t,Math.random()*1.5);s.stop(t+0.12);}
/* The audio engine runs only while it should be heard: sound switched on and the page visible. Loops keep playing
   by themselves in Web Audio, so a hidden tab (no animation frames, no updates) used to leave the last engine and
   other-car sound droning on, even after sound was switched off elsewhere. Suspending the context stops every
   voice at once; a watchdog also mutes the output if the game loop stalls for any other reason. */
let audioSeen=0;
function soundGate(){if(!AC)return;const want=ui.sound&&document.visibilityState==='visible';
  if(want&&AC.state==='suspended')AC.resume();else if(!want&&AC.state==='running')AC.suspend();}
document.addEventListener('visibilitychange',()=>{soundGate();if(!document.hidden)sendTrack();});
setInterval(()=>{if(eng&&AC&&performance.now()-audioSeen>400)eng.master.gain.setTargetAtTime(0,AC.currentTime,0.02);},200);
function audioUpdate(w,running){
  if(!eng||!AC)return;const now=AC.currentTime,on=ui.sound&&running&&!w.done,P=w.player;
  audioSeen=performance.now();eng.master.gain.setTargetAtTime(ui.sound?0.9:0,now,0.02);
  eng.ng.gain.setTargetAtTime(ui.sound?Math.min(0.12,0.01+0.03*w.rain+0.0009*P.v*(ui.cam==='cockpit'?1:0.6)):0,now,0.2);eng.nf.frequency.setTargetAtTime(500+P.v*14,now,0.3);
  /* Tyre squeal is stick-slip of the tread against the road: it starts as the tyre nears its grip peak (slip
     utilisation ~0.65), is strongest around and a little past the peak, and settles to a lower, duller skid as the
     tyre locks or spins right up. Water lubricates the contact (no squeal in the wet) and there is none on grass
     or gravel. */
  if(eng.tyre){const T=eng.tyre,on=ui.sound&&w.opts.driver==='drive',sq=x=>clamp((x-0.65)/0.35,0,1)*(1-0.4*clamp((x-1.6)/2,0,1));
    const sF=(P.surfF||0)<2?sq(P.satF||0):0,sR=(P.surfR||0)<2?sq(P.satR||0):0,sqk=Math.max(sF,sR),wetK=1-clamp(w.rain*1.6,0,0.92);
    T.g.gain.setTargetAtTime(on?0.26*sqk*wetK*clamp((P.v||0)/12,0,1):0,now,0.05);
    const sm=Math.max(P.satF||0,P.satR||0);
    if(T.src)T.src.playbackRate.setTargetAtTime(0.85+0.2*clamp(sm-0.8,0,1)-0.18*clamp((sm-1.6)/2,0,1)+(P.v||0)*0.0012,now,0.08);
    const rough=Math.max(P.surfF||0,P.surfR||0)>=1,grav=P.surfF===3||P.surfR===3;
    T.rg.gain.setTargetAtTime(on&&rough?clamp((P.v||0)/25,0,1)*(0.2+1.6*(P.bump||0)):0,now,0.05);
    T.cg.gain.setTargetAtTime(on&&grav?clamp((P.v||0)/20,0,1)*(0.04+0.14*Math.random()):0,now,0.02);}
  const V=eng.voices;if(!V){eng.lvl.gain.setTargetAtTime(0,now,0.1);return;}
  let rpm=P.rpm,gear=P.gear;if(!rpm){const e=rpmFromSpeed(P.v);rpm=e.rpm;gear=e.gear;}
  const thr=clamp(P.thr!=null?P.thr:0.5,0,1),cut=(P.cut||0)>0;
  // upshift: the ignition cut drops the sound for a moment, then it comes back lower
  if(gear!=null&&eng.gear!=null&&gear>eng.gear)eng.cut=now+0.07;eng.gear=gear;
  // crossfade weights: idle -> low -> (load | high), load by throttle
  const R=[V.idle.rpm,V.low.rpm,(V.load.rpm+V.high.rpm)/2],ep=x=>Math.sqrt(clamp(x,0,1));
  let wi=0,wl=0,wu=0;if(rpm<=R[0])wi=1;else if(rpm<R[1]){const k=(rpm-R[0])/(R[1]-R[0]);wi=ep(1-k);wl=ep(k);}else if(rpm<R[2]){const k=(rpm-R[1])/(R[2]-R[1]);wl=ep(1-k);wu=ep(k);}else wu=1;
  const load=Math.pow(thr,0.7),mix={idle:wi,low:wl,load:wu*ep(load),high:wu*ep(1-load)*0.9};
  for(const n of ENG_LOOPS){const vo=V[n];vo.src.playbackRate.setTargetAtTime(clamp(rpm/vo.rpm,0.25,3.4),now,0.025);vo.g.gain.setTargetAtTime(mix[n],now,0.05);}
  const muted=cut||now<eng.cut;
  eng.lvl.gain.setTargetAtTime(on?(muted?0.05:0.16+0.2*thr+0.08*clamp((rpm-4000)/7000,0,1))*(ui.cam==='cockpit'?1:0.75):0,now,muted?0.008:0.03);
  eng.tone.frequency.setTargetAtTime(1800+thr*6500+rpm*0.25,now,0.05);
  // overrun crackle: lifting off at high revs pops the exhaust for a while
  if(on&&eng.thrPrev>0.5&&thr<0.1&&rpm>7000)eng.crackleUntil=now+0.5+Math.random()*0.5;
  eng.thrPrev=thr;
  if(on&&now<eng.crackleUntil&&thr<0.15&&now>eng.nextPop){pop(now+0.01,0.12+Math.random()*0.18);eng.nextPop=now+0.03+Math.random()*0.11;}
  // the nearest other car within 120 m
  const O=eng.other;if(O){let best=null,bd=121;for(const c of w.traffic){const d=dSigned(P.s,c.s),r=Math.hypot(d,c.lat-P.lat);if(r<bd){bd=r;best={c,d};}}
    if(on&&best){const c=best.c,e=rpmFromSpeed(c.v),closing=(best.d>0?P.v-c.v:c.v-P.v),dop=clamp(1+closing/343,0.8,1.25);
      O.v.src.playbackRate.setTargetAtTime(clamp(e.rpm/O.v.rpm*dop,0.25,3.4),now,0.05);O.v.g.gain.setTargetAtTime(0.3/(1+(bd/8)*(bd/8)),now,0.08);   // inverse square with distance
      O.f.frequency.setTargetAtTime(900+9000/(1+bd/10),now,0.1);if(O.pan)O.pan.pan.setTargetAtTime(clamp((c.lat-P.lat)/(Math.abs(best.d)+4),-0.9,0.9),now,0.08);}
    else O.v.g.gain.setTargetAtTime(0,now,0.1);}
}

/* ================= MULTIPLAYER ================= */
/* Racers in the same room code see each other's cars. Each game sends its own car about 20 times a second (track
   position, heading, velocity and yaw rate in the track frame) and dead-reckons the others between messages, easing
   out the small corrections. In a room the AI traffic stays off, so everyone races the same cars. Remote cars go
   into the world's traffic list, so the radar, the HUD, spray and line of sight treat them like any car.
   Crashes: see mpCollide. */
const MP={ws:null,on:false,room:'',id:Math.random().toString(36).slice(2,10),name:'',peers:new Map(),sendT:0,retry:0};
const MP_COLS=[0xd8202a,0xf2c230,0x2f7de0,0x33b35a,0xff7a2a,0xe8e8e8,0x9b4de0,0x14b8c8];
const mpCol=id=>MP_COLS[[...id].reduce((a,ch)=>a*31+ch.charCodeAt(0)>>>0,7)%MP_COLS.length];
const trackSig=()=>Math.round(L)+'/'+N;
try{MP.name=localStorage.getItem('lar.mpName')||'';MP.room=localStorage.getItem('lar.mpRoom')||'';}catch(e){}
function mpStatus(txt){$('mpStatus').textContent=txt;const ul=$('mpList');ul.innerHTML='';
  const me=document.createElement('li');me.innerHTML=`<i style="background:#${mpCol(MP.id).toString(16).padStart(6,'0')}"></i>${(MP.name||'You').replace(/</g,'')} <small>you</small>`;if(MP.on)ul.appendChild(me);
  for(const p of MP.peers.values()){const li=document.createElement('li');li.innerHTML=`<i style="background:#${p.car.col.toString(16).padStart(6,'0')}"></i>${p.name.replace(/</g,'')} <small>${p.ok?Math.round(p.ping||0)+' ms':'other circuit'}</small>`;ul.appendChild(li);}
  $('mpJoin').hidden=MP.on;$('mpNew').hidden=MP.on;$('mpLeave').hidden=!MP.on;$('mpRoom').disabled=MP.on;}
function mpJoin(){const code=($('mpRoom').value||'').trim().toUpperCase().replace(/[^A-Z0-9_-]/g,'');if(code.length<4){mpStatus('Enter a room code of 4-12 letters or digits, or make a new room.');return;}
  MP.room=code;$('mpRoom').value=code;MP.name=($('mpName').value||'').trim().slice(0,14)||'Driver';try{localStorage.setItem('lar.mpName',MP.name);localStorage.setItem('lar.mpRoom',code);}catch(e){}
  mpLeave(true);MP.on=true;ui.scn='free';
  const ws=new WebSocket((location.protocol==='https:'?'wss://':'ws://')+location.host+'/ws?role=race&r='+encodeURIComponent(code));MP.ws=ws;
  ws.onopen=()=>{mpStatus(`In room ${code}. Waiting for other drivers…`);mpSend(true);};
  ws.onmessage=e=>{let m;try{m=JSON.parse(e.data);}catch(_){return;}mpRecv(m);};
  ws.onclose=()=>{if(MP.ws!==ws||!MP.on)return;mpStatus(`Connection to room ${code} lost, reconnecting…`);clearTimeout(MP.retry);MP.retry=setTimeout(()=>{if(MP.on)mpJoin();},2000);};
  if(!running)resetWorld();}
function mpLeave(quiet){const ws=MP.ws;MP.ws=null;clearTimeout(MP.retry);
  if(ws){try{if(ws.readyState===1)ws.send(JSON.stringify({t:'bye',id:MP.id}));ws.close();}catch(e){}}
  if(!quiet){MP.on=false;for(const id of [...MP.peers.keys()])mpDrop(id);mpStatus('Not in a room. AI traffic drives with you.');if(!running)resetWorld();}}
function mpDrop(id){const p=MP.peers.get(id);if(!p)return;MP.peers.delete(id);
  if(world){const i=world.traffic.indexOf(p.car);if(i>=0){world.traffic.splice(i,1);buildDynamic(world);}}mpStatus(MP.on?`In room ${MP.room}.`:'');}
function mpRecv(m){const now=performance.now();
  if(m.t==='car'&&m.id&&m.id!==MP.id){let p=MP.peers.get(m.id);
    if(!p){p={id:m.id,name:String(m.n||'Driver').slice(0,14),car:{remote:true,id:m.id,s:m.s,lat:m.l,v:0,latV:0,psi:m.p,r:0,vs:0,vn:0,vis:true,closing:false,touch:false,lapc:0,followT:0,lane:0,fac:1,braking:0,col:mpCol(m.id)},snap:null,ok:false};
      MP.peers.set(m.id,p);p.car.name=p.name;}
    p.snap={s:+m.s,l:+m.l,p:+m.p,vs:+m.vs,vn:+m.vn,r:+m.r,b:+m.b||0,t:now};p.last=now;if(m.tm)p.ping=Math.max(0,Date.now()-m.tm);
    const ok=m.tr===trackSig();if(ok&&!p.ok){p.ok=true;p.car.s=m.s;p.car.lat=m.l;if(world&&!world.traffic.includes(p.car)&&world.sc.free){world.traffic.push(p.car);buildDynamic(world);}
      mpStatus(`In room ${MP.room}. ${MP.peers.size+1} drivers.`);toast(`<b class="info">${p.name.replace(/</g,'')} joined</b>Room ${MP.room}`);}
    p.ok=ok;}
  else if(m.t==='bye'&&m.id){const p=MP.peers.get(m.id);if(p)toast(`<b class="info">${p.name.replace(/</g,'')} left</b>`);mpDrop(m.id);}
  else if(m.t==='hit'&&m.to===MP.id){const p=MP.peers.get(m.id);toast(`<b class="${m.v>10?'crash':'near'}">${p?p.name.replace(/</g,''):'A driver'} hit you · ${Math.round(m.v*3.6)} km/h</b>`);if(world)impact(world.player,m.v,false);}}
// this car's state, ~20 per second (and a first one straight away)
function mpSend(now){if(!MP.ws||MP.ws.readyState!==1||!world)return;const t=performance.now();if(!now&&t-MP.sendT<50)return;MP.sendT=t;
  const P=world.player,ps=P.psi||0,vx=P.vx!=null?P.vx:P.v,vy=P.vy||0,r4=v=>Math.round(v*1e4)/1e4;
  MP.ws.send(JSON.stringify({t:'car',id:MP.id,n:MP.name,tr:trackSig(),tm:Date.now(),s:r4(P.s),l:r4(P.lat),p:r4(ps),vs:r4(vx*Math.cos(ps)-vy*Math.sin(ps)),vn:r4(vx*Math.sin(ps)+vy*Math.cos(ps)),r:r4(P.r||0),b:r4(P.brk||0)}));}
// dead reckoning: extrapolate each remote car from its last message (at most 0.35 s), then ease towards it
function mpTick(w,dt){if(!MP.on)return;mpSend();const now=performance.now(),k=1-Math.exp(-dt*12);
  for(const p of [...MP.peers.values()]){if(now-p.last>4000){mpDrop(p.id);continue;}const S=p.snap,c=p.car;if(!S||!p.ok)continue;
    const a=Math.min(0.35,(now-S.t)/1000),ts=wrapS(S.s+S.vs*a),tl=S.l+S.vn*a,tp=S.p+S.r*a,ds=dSigned(c.s,ts);
    if(Math.abs(ds)>30||Math.abs(tl-c.lat)>8){c.s=ts;c.lat=tl;c.psi=tp;}else{c.s=wrapS(c.s+ds*k);c.lat+=(tl-c.lat)*k;c.psi+=(tp-c.psi)*k;}
    c.vs=S.vs;c.vn=S.vn;c.r=S.r;c.v=Math.hypot(S.vs,S.vn);c.latV=S.vn;c.braking=S.b>0.1?1:0;}}
// in a room, the grid is the drivers: no AI traffic, and each driver starts in their own slot (ordered by id)
function mpAttach(w){if(!MP.on||!w.sc.free)return w;w.traffic=[...MP.peers.values()].filter(p=>p.ok).map(p=>p.car);
  const ids=[MP.id,...MP.peers.keys()].sort(),i=ids.indexOf(MP.id),P=w.player;P.s=wrapS(P.s-i*9);P.lat=i%2?2.4:-2.4;return w;}
/* Crash between two drivers. Each car is its real footprint, a rectangle 5.25 m x 2 m around its centre, rotated to
   its heading in the track plane. Separating-axis test for overlap; the axis of least overlap is the contact normal.
   At the contact point the relative velocity includes each car's spin (v + w x r). If the cars are closing, a
   normal impulse j = -(1+e) v_n / (1/m1 + 1/m2 + (r1 x n)^2/I1 + (r2 x n)^2/I2) with restitution e = 0.25 (carbon
   crash structures crush and absorb most of the energy), and a friction impulse along the contact up to mu j
   (mu 0.5, bodywork on bodywork). An off-centre hit spins the car through the (r x n) terms. Each game applies the
   impulse to its own car only; the other driver's game sees the same contact and applies the other half. */
const CM=798,CI=1150,CHL=2.625,CHW=1.0,COFF=0.075;
function mpCollide(w,P,c){const d=dSigned(P.s,c.s);if(Math.abs(d)>8||Math.abs(c.lat-P.lat)>6)return;
  const A={x:COFF*Math.cos(P.psi||0),y:P.lat+COFF*Math.sin(P.psi||0),a:P.psi||0},B={x:d+COFF*Math.cos(c.psi||0),y:c.lat+COFF*Math.sin(c.psi||0),a:c.psi||0};
  const ax=b=>[[Math.cos(b.a),Math.sin(b.a)],[-Math.sin(b.a),Math.cos(b.a)]],corners=b=>{const [u,v]=ax(b);return [[1,1],[1,-1],[-1,-1],[-1,1]].map(([i,j])=>[b.x+u[0]*CHL*i+v[0]*CHW*j,b.y+u[1]*CHL*i+v[1]*CHW*j]);};
  const ca=corners(A),cb=corners(B);let best=1e9,nrm=null;
  for(const [nx,ny] of [...ax(A),...ax(B)]){let a0=1e9,a1=-1e9,b0=1e9,b1=-1e9;for(const [x,y] of ca){const q=x*nx+y*ny;a0=Math.min(a0,q);a1=Math.max(a1,q);}
    for(const [x,y] of cb){const q=x*nx+y*ny;b0=Math.min(b0,q);b1=Math.max(b1,q);}const ov=Math.min(a1,b1)-Math.max(a0,b0);if(ov<=0)return;
    if(ov<best){best=ov;const sgn=((A.x-B.x)*nx+(A.y-B.y)*ny)>=0?1:-1;nrm=[nx*sgn,ny*sgn];}}   // n points from the other car to this one
  const inside=(p,b)=>{const [u,v]=ax(b),dx=p[0]-b.x,dy=p[1]-b.y;return Math.abs(dx*u[0]+dy*u[1])<=CHL&&Math.abs(dx*v[0]+dy*v[1])<=CHW;};
  const pts=ca.filter(p=>inside(p,B)).concat(cb.filter(p=>inside(p,A)));const cp=pts.length?pts.reduce((m,p)=>[m[0]+p[0]/pts.length,m[1]+p[1]/pts.length],[0,0]):[(A.x+B.x)/2,(A.y+B.y)/2];
  const ps=P.psi||0,vx=P.vx!=null?P.vx:P.v,vy=P.vy||0,V1=[vx*Math.cos(ps)-vy*Math.sin(ps),vx*Math.sin(ps)+vy*Math.cos(ps)],w1=P.r||0,w2=c.r||0;
  const r1=[cp[0]-A.x,cp[1]-A.y],r2=[cp[0]-B.x,cp[1]-B.y];
  const v1=[V1[0]-w1*r1[1],V1[1]+w1*r1[0]],v2=[(c.vs||c.v)-w2*r2[1],(c.vn||0)+w2*r2[0]],vr=[v1[0]-v2[0],v1[1]-v2[1]],vn=vr[0]*nrm[0]+vr[1]*nrm[1];
  // push apart: each car takes half the overlap
  P.s=wrapS(P.s+nrm[0]*best/2);P.lat+=nrm[1]*best/2;
  if(vn>=0)return;
  const cr=(a,b)=>a[0]*b[1]-a[1]*b[0],rn1=cr(r1,nrm),rn2=cr(r2,nrm),j=-(1+0.25)*vn/(2/CM+rn1*rn1/CI+rn2*rn2/CI);
  const t=[-nrm[1],nrm[0]],vt=vr[0]*t[0]+vr[1]*t[1],rt1=cr(r1,t),rt2=cr(r2,t),jt=clamp(-vt/(2/CM+rt1*rt1/CI+rt2*rt2/CI),-0.5*j,0.5*j);
  const J=[j*nrm[0]+jt*t[0],j*nrm[1]+jt*t[1]],V=[V1[0]+J[0]/CM,V1[1]+J[1]/CM];
  P.vx=V[0]*Math.cos(ps)+V[1]*Math.sin(ps);P.vy=-V[0]*Math.sin(ps)+V[1]*Math.cos(ps);P.r=w1+cr(r1,J)/CI;P.v=Math.hypot(P.vx,P.vy);
  const sev=-vn;if(!c.touch){c.touch=true;w.touches++;}
  if(MP.ws&&MP.ws.readyState===1&&(!c.hitT||w.t-c.hitT>0.4)){MP.ws.send(JSON.stringify({t:'hit',id:MP.id,to:c.id,v:Math.round(sev*10)/10}));c.hitT=w.t;}
  if(sev>18){impact(P,sev,true);w.crash={what:c.name||'another driver',v:P.v};w.tArrive=w.t;finish(w,'crash');return;}
  impact(P,sev,false);}
$('mpName').value=MP.name;$('mpRoom').value=MP.room;
$('mpNew').addEventListener('click',()=>{const a='ABCDEFGHJKLMNPQRSTUVWXYZ23456789',b=crypto.getRandomValues(new Uint8Array(6));$('mpRoom').value=[...b].map(x=>a[x%a.length]).join('');mpJoin();});
$('mpJoin').addEventListener('click',mpJoin);$('mpLeave').addEventListener('click',()=>mpLeave(false));
$('mpRoom').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();mpJoin();}});
addEventListener('pagehide',()=>{if(MP.ws&&MP.ws.readyState===1)MP.ws.send(JSON.stringify({t:'bye',id:MP.id}));});

/* ================= UI ================= */
// defaults when the game opens: you drive with full steering, TC 6, ABS off, 57 % brake balance, softs, dry and clear, sound on
const ui={kbFoot:true,tc:6,abs:0,tcT:tcTarget(6),tcG:levelGain(6),absT:0,absG:levelGain(0),tcC:false,absC:false,bb:0.57,fog:0,traffic:12,scn:'free',hud:true,visor:true,driver:'drive',steer:'full',cam:'cockpit',rain:SCN.free.rain,sound:true,tyre:0};
// browsers only let audio start from a click or a key press: the first one starts the sound when it is on
{const first=()=>{removeEventListener('pointerdown',first,true);removeEventListener('keydown',first,true);if(ui.sound){audioStart();soundGate();}};
  addEventListener('pointerdown',first,true);addEventListener('keydown',first,true);}
$('pcVisor').addEventListener('click',e=>{setPcVisor(!ui.pcVisor);e.currentTarget.blur();});
try{setPcVisor(localStorage.getItem('lar.pcvisor')==='1');}catch(e){setPcVisor(false);}
let world=null, running=false, doneShownAt=null, runCount=0, lastAlert=0, shake=0, touchUsed=false;
const LOG=[];
function optsFromUI(){return {hud:ui.hud,visor:ui.visor,driver:ui.driver,steer:ui.steer,rain:ui.rain,fog:ui.fog,traffic:ui.traffic,kbFoot:ui.kbFoot,tc:ui.tc,abs:ui.abs,tcT:ui.tcT,tcG:ui.tcG,absT:ui.absT,absG:ui.absG,tcC:ui.tcC,absC:ui.absC,bb:ui.bb,tyre:ui.tyre};}
function resetWorld(){curFog=ui.fog;world=mpAttach(makeWorld(ui.scn,optsFromUI()));worldRev++;buildDynamic(world);paintSky(ui.rain);rainInit=false;camInit=false;NAV.cur=160;syncScene(world,0,0);renderIntro();}
function seg(onId,offId,key,onVal,offVal){
  $(onId).addEventListener('click',()=>{ui[key]=onVal;syncControls();applyLive();});
  $(offId).addEventListener('click',()=>{ui[key]=offVal;syncControls();applyLive();});
}
seg('hudOn','hudOff','hud',true,false); seg('kbFoot','kbFull','kbFoot',true,false); seg('visOn','visOff','visor',true,false); seg('drvYou','drvModel','driver','drive','model'); seg('stAssist','stFull','steer','assist','full');
[6,12,20].forEach(n=>$('tr'+n).addEventListener('click',()=>{ui.traffic=n;syncControls();if(running)liveTraffic();else resetWorld();}));
$('tyAuto').addEventListener('click',()=>{ui.tyre='auto';syncControls();applyLive();});
for(let k=0;k<5;k++)$('ty'+k).addEventListener('click',()=>{ui.tyre=k;syncControls();applyLive();});   // mid-run: a pit stop
$('camCock').addEventListener('click',()=>{ui.cam='cockpit';syncControls();});
$('camChase').addEventListener('click',()=>{ui.cam='chase';syncControls();});
$('sndOn').addEventListener('click',()=>{ui.sound=true;audioStart();soundGate();syncControls();});
$('sndOff').addEventListener('click',()=>{ui.sound=false;soundGate();syncControls();});
// TC / ABS: a level loads a preset (slip target and response); the Custom sliders set either one directly
function setLevel(k,l){l=clamp(l,0,12);ui[k]=l;ui[k+'T']=k==='tc'?tcTarget(l):absTarget(l);ui[k+'G']=levelGain(l);ui[k+'C']=false;syncControls();applyLive();}
$('tc').addEventListener('input',e=>setLevel('tc',+e.target.value));
$('abs').addEventListener('input',e=>setLevel('abs',+e.target.value));
for(const k of ['tc','abs']){
  $(k+'T').addEventListener('input',e=>{ui[k+'T']=e.target.value/100;ui[k+'C']=true;if(!ui[k])ui[k]=6;syncControls();applyLive();});
  $(k+'G').addEventListener('input',e=>{ui[k+'G']=+e.target.value;ui[k+'C']=true;if(!ui[k])ui[k]=6;syncControls();applyLive();});}
$('bb').addEventListener('input',e=>{ui.bb=e.target.value/100;syncControls();applyLive();});
// on the move, as drivers do on the wheel's rotaries: [ ] traction control, ; ' ABS, , . brake balance
function nudge(code){
  if(code==='BracketLeft'||code==='BracketRight')setLevel('tc',ui.tc+(code==='BracketRight'?1:-1));
  else if(code==='Semicolon'||code==='Quote')setLevel('abs',ui.abs+(code==='Quote'?1:-1));
  else if(code==='Comma'||code==='Period'){ui.bb=clamp(Math.round((ui.bb+(code==='Period'?0.005:-0.005))*1000)/1000,0.5,0.65);syncControls();applyLive();}
  else return false;
  toast(`<b class="info">${code.includes('Bracket')?'TC '+(ui.tc||'off'):code==='Semicolon'||code==='Quote'?'ABS '+(ui.abs||'off'):'Brake balance '+(ui.bb*100).toFixed(1)+'% front'}</b>`);return true;}
$('fog').addEventListener('input',e=>{ui.fog=e.target.value/100;syncControls();world.fog=ui.fog;world.opts.fog=ui.fog;curFog=ui.fog;paintSky(ui.rain);if(!running)renderIntro();});
$('rain').addEventListener('input',e=>{ui.rain=e.target.value/100;syncControls();world.rain=ui.rain;world.opts.rain=ui.rain;paintSky(ui.rain);if(!running)renderIntro();});
// settings apply straight away, also in the middle of a run
function applyLive(){
  if(!running){world.opts=optsFromUI();renderIntro();return;}
  const w=world,was=w.opts.driver;Object.assign(w.opts,optsFromUI());
  if(was==='model'&&w.opts.driver==='drive'){const P=w.player;Object.assign(P,{vx:P.v,vy:0,r:0,psi:0,delta:0,steer:0,wf:null,rev:0});}
  $('touch').hidden=!(w.opts.driver==='drive'&&(touchUsed||matchMedia('(pointer: coarse)').matches));}
// a new field of cars around you when the traffic setting changes mid-run
function liveTraffic(){const w=world,P=w.player;
  w.traffic=genTraffic(ui.traffic).map((T,i)=>carFrom(T,P.s,P.lapc||0,i));w.opts.traffic=ui.traffic;buildDynamic(w);}
function syncControls(){
  const set=(id,v)=>$(id).setAttribute('aria-pressed',v?'true':'false');
  set('hudOn',ui.hud);set('hudOff',!ui.hud);set('visOn',ui.visor);set('visOff',!ui.visor);set('drvYou',ui.driver==='drive');set('drvModel',ui.driver==='model');
  set('stAssist',ui.steer==='assist');set('stFull',ui.steer==='full');set('kbFoot',ui.kbFoot);set('kbFull',!ui.kbFoot);
  [6,12,20].forEach(n=>set('tr'+n,ui.traffic===n));
  set('camCock',ui.cam==='cockpit');set('camChase',ui.cam==='chase');set('sndOn',ui.sound);set('sndOff',!ui.sound);
  $('rainOut').textContent=Math.round(ui.rain*100)+'%';
  const V=fogMOR(ui.fog);$('fogOut').textContent=isFinite(V)?Math.round(V)+' m':'Clear';
  for(const k of ['tc','abs']){const T=ui[k+'T'],G=ui[k+'G'];
    $(k+'Out').textContent=!T?'Off':(ui[k+'C']?'Custom':ui[k])+' · '+(T*100).toFixed(1)+'% slip';$(k).value=ui[k];
    $(k+'T').value=Math.round((T||0)*1000)/10;$(k+'G').value=G;$(k+'TOut').textContent=(T*100).toFixed(1)+'%';$(k+'GOut').textContent=G.toFixed(2)+'×';}
  $('bb').value=ui.bb*100;$('bbOut').textContent=(ui.bb*100).toFixed(1)+'% front';
  set('tyAuto',ui.tyre==='auto');for(let k=0;k<5;k++)set('ty'+k,ui.tyre===k);
  $('tyAuto').title='Auto fits '+TYRES[autoTyre(ui.rain)].n.toLowerCase()+'s for '+Math.round(ui.rain*100)+'% rain';
  if($('scenSet'))$('scenSet').classList.toggle('locked',running);
  $('stAssist').disabled=$('stFull').disabled=ui.driver!=='drive';
  $('runBtn').textContent=running?'Stop run':'Start run';
  ['drawBtn','defBtn'].forEach(id=>$(id).disabled=running);
}
function metaLine(o){return `Radar ${o.hud?'on':'off'} · Visor ${o.visor?'on':'off'} · ${o.driver==='model'?'Autopilot':'You drive'+(o.steer==='full'?' (full steering)':'')} · Rain ${Math.round(o.rain*100)}%${o.fog?' · Fog '+Math.round(fogMOR(o.fog))+' m':''} · ${TYRES[tyreFor(o)].n} tyres · TC ${o.tcT?(o.tcC?'custom':o.tc):'off'} · ABS ${o.absT?(o.absC?'custom':o.abs):'off'} · BB ${((o.bb||0.57)*100).toFixed(1)}%`;}
function renderIntro(){const s=SCN[ui.scn];$('iRef').textContent=s.ref+' · '+TRACK_NAME;$('iTitle').textContent=s.title;$('iBlurb').textContent=s.blurb();
  const how=ui.driver==='drive'?(ui.steer==='assist'?'<kbd>W</kbd> gas · <kbd>S</kbd>/<kbd>Space</kbd> brake · hold <kbd>A</kbd>/<kbd>D</kbd> to move across the track, let go to rejoin the racing line.':'<kbd>W</kbd> gas · <kbd>S</kbd> brake · <kbd>A</kbd>/<kbd>D</kbd> steer. Too fast in a corner and you run wide into the wall.'):'Autopilot drives. Watch how early it reacts.';
  const howRev=ui.driver==='drive'?' Stopped? Hold <kbd>S</kbd> to reverse, <kbd>W</kbd> to go forward again.':'';
  $('iMeta').innerHTML=metaLine(optsFromUI())+'<br>'+how+howRev+(s.free?' <kbd>X</kbd> drops a hazard.':'');}
// ---- views: Drive is the full-screen sim; Setup, Phone and Circuit open as sheets over it (the sim keeps running)
function showView(v){document.body.dataset.view=v;
  document.querySelectorAll('.tabs [role=tab]').forEach(b=>b.setAttribute('aria-selected',b.dataset.view===v?'true':'false'));
  if(v==='drive')stage.focus({preventScroll:true});else if(v==='circuit'&&typeof drawMini==='function'&&N)drawMini();}
document.querySelectorAll('.tabs [role=tab]').forEach(b=>b.addEventListener('click',()=>showView(b.dataset.view)));
showView('drive');
function startRun(){
  showView('drive');
  if(!PHYS.ok){if(PHYS.err)toast('<b class="info">Physics core did not load</b>Run <code>npm run build:physics</code> and reload.');else PHYS.ready.then(()=>{if(PHYS.ok&&!running)startRun();});return;}
  if(ui.sound)audioStart();
  world=mpAttach(makeWorld(ui.scn,optsFromUI()));worldRev++;buildDynamic(world);paintSky(ui.rain);camInit=false;NAV.cur=160;
  running=true;doneShownAt=null;lastAlert=0;shake=0;
  $('introCard').hidden=true;$('resultCard').hidden=true;$('dropBtn').hidden=!world.sc.free;
  $('touch').hidden=!(ui.driver==='drive'&&(touchUsed||matchMedia('(pointer: coarse)').matches));
  syncControls();stage.focus({preventScroll:true});
}
function stopRun(){running=false;resetWorld();$('introCard').hidden=false;$('resultCard').hidden=true;$('dropBtn').hidden=true;$('touch').hidden=true;syncControls();}
function fmtM(d){return d==null?'—':Math.round(d)+' m';}
function srcText(s){return s==='hud'?'HUD':s==='visor'?'visor light':s==='eyes'?'saw it':s==='you'?'you braked':'';}
function showResult(){
  const r=world.result;runCount++;
  LOG.unshift(Object.assign({n:runCount},r));renderLog();
  $('rRef').textContent=`Run ${runCount} · ${SCN[r.scn].title} · ${metaLine(r.opts)}`;
  const v=$('rVerdict');v.className='verdict '+r.verdict;v.textContent=verdictText(r);
  const warn=r.opts.hud||r.opts.visor?(r.warnD!=null?`${fmtM(r.warnD)}<small>${r.lead!=null?r.lead.toFixed(1)+' s before':'before the hazard'}</small>`:'—'):'—<small>Radar off</small>';
  $('rMetrics').innerHTML=`<div><dt>Warned</dt><dd>${warn}</dd></div><div><dt>In sight</dt><dd>${fmtM(r.seenD)}<small>eyes only</small></dd></div><div><dt>On-board radar</dt><dd>${fmtM(r.radarD)}<small>77 GHz, first track</small></dd></div><div><dt>Reacted</dt><dd>${r.reactD!=null?fmtM(Math.max(0,r.reactD)):'never'}<small>${r.reactD!=null?srcText(r.src):'no reaction'}</small></dd></div>`;
  const flip=!(r.opts.hud||r.opts.visor);$('rFlip').textContent=flip?'Again with radar on':'Again with radar off';$('rFlip').dataset.flip=flip?'on':'off';
  $('resultCard').hidden=false;$('dropBtn').hidden=true;$('touch').hidden=true;running=false;syncControls();
}
$('rFlip').addEventListener('click',()=>{const on=$('rFlip').dataset.flip==='on';ui.hud=on;ui.visor=on;syncControls();startRun();});
$('rSame').addEventListener('click',()=>startRun());
$('iStart').addEventListener('click',()=>startRun());
$('runBtn').addEventListener('click',()=>{running?stopRun():startRun();});
function renderLog(){
  if(!LOG.length||!$('logBody'))return;
  $('logBody').innerHTML=LOG.map(r=>`<tr><td class="n">${r.n}</td><td>${SCN[r.scn].title}</td><td>${esc(r.track)}</td><td>${r.opts.hud?'On':'Off'}</td><td>${r.opts.driver==='model'?'Autopilot':'You'}</td><td>${r.opts.hud||r.opts.visor?fmtM(r.warnD):'—'}</td><td>${fmtM(r.seenD)}</td><td>${r.reactD!=null?fmtM(Math.max(0,r.reactD)):'—'}</td><td><span class="chip ${r.verdict}">${chipText(r)}</span></td></tr>`).join('');
}
function esc(s){return String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));}
let toastT=0;
function toast(html){const t=$('toast');t.innerHTML=html;t.hidden=false;toastT=3.6;}
function dropHazard(){
  const w=world;if(!running||!w.sc.free||w.done)return;
  const P=w.player;let best=null;
  for(const c of CORNERS){const d=dSigned(P.s,c.s1);if(d>220&&d<Math.min(900,L/2-10)&&(!best||d<best.d))best={c,d};}
  const s=best?wrapS(best.c.s1+Math.min(35,best.c.exitLen*0.45)):wrapS(P.s+Math.min(450,L/3));
  const type=Math.random()<0.6?'car':'tractor';
  const h=mkHaz(type,s,{yaw:type==='car'?0.4:0.5});w.hazards.push(h);const m=hazMesh(h);dyn.add(m);hazardMeshes.push(m);
  toast(`<b class="info">${h.label} placed</b>Hidden just past ${best?'T'+best.c.n:'the road ahead'}, ${Math.round(dSigned(P.s,s))} m ahead. Will you see it in time?`);
}
$('dropBtn').addEventListener('click',e=>{e.stopPropagation();dropHazard();stage.focus({preventScroll:true});});

// input
const K={up:0,down:0,left:0,right:0}, TOUCH={gas:0,brake:0,left:0,right:0};
const KEYMAP={KeyW:'up',ArrowUp:'up',KeyS:'down',ArrowDown:'down',Space:'down',KeyA:'left',ArrowLeft:'left',KeyD:'right',ArrowRight:'right'};
addEventListener('keydown',e=>{
  const tag=e.target&&e.target.tagName;if(tag==='INPUT'&&e.target.type==='text')return;
  if(!$('builder').hidden){if(e.code==='Escape')closeBuilder();return;}
  if(KEYMAP[e.code]&&running){e.preventDefault();K[KEYMAP[e.code]]=1;return;}
  if(nudge(e.code)){e.preventDefault();return;}
  if(e.code==='Enter'&&tag!=='BUTTON'){e.preventDefault();if(!running)startRun();}
  else if(e.code==='Escape'&&document.body.dataset.view!=='drive'){showView('drive');}
  else if(e.code==='Escape'&&running){stopRun();}
  else if(e.code==='KeyC'){ui.cam=ui.cam==='cockpit'?'chase':'cockpit';syncControls();}
  else if(e.code==='KeyN'){NAV.big=!NAV.big;}
  else if(e.code==='KeyV'){setPcVisor(!ui.pcVisor);}
  else if(e.code==='KeyX'){dropHazard();}
  else if(e.code==='Equal'||e.code==='NumpadAdd'){NAV.zoom=clamp(NAV.zoom/1.3,0.4,3);}
  else if(e.code==='Minus'||e.code==='NumpadSubtract'){NAV.zoom=clamp(NAV.zoom*1.3,0.4,3);}
  else if(e.code==='KeyH'&&!running){ui.hud=!ui.hud;ui.visor=ui.hud;syncControls();applyLive();}
  else if(e.code==='KeyR'&&running){startRun();}
});
addEventListener('keyup',e=>{if(KEYMAP[e.code])K[KEYMAP[e.code]]=0;});
addEventListener('blur',()=>{for(const k in K)K[k]=0;});
function inRect(x,y,r){return r&&x>=r[0]&&x<=r[0]+r[2]&&y>=r[1]&&y<=r[1]+r[3];}
stage.addEventListener('pointerdown',e=>{
  if(e.target.closest('.card,.drop,.touch'))return;
  const r=stage.getBoundingClientRect(),x=e.clientX-r.left,y=e.clientY-r.top;
  if(NAV.rects){if(inRect(x,y,NAV.rects.plus)){NAV.zoom=clamp(NAV.zoom/1.3,0.4,3);return;} if(inRect(x,y,NAV.rects.minus)){NAV.zoom=clamp(NAV.zoom*1.3,0.4,3);return;}
    if(inRect(x,y,NAV.rects.panel)){NAV.big=!NAV.big;return;}}
  if(e.pointerType==='touch'){touchUsed=true;if(running&&ui.driver==='drive')$('touch').hidden=false;}
});
document.querySelectorAll('.touch button').forEach(b=>{
  const k=b.dataset.k,on=v=>{TOUCH[k]=v;b.classList.toggle('on',!!v);};
  b.addEventListener('pointerdown',e=>{e.preventDefault();b.setPointerCapture(e.pointerId);on(1);});
  b.addEventListener('pointerup',()=>on(0));b.addEventListener('pointercancel',()=>on(0));b.addEventListener('lostpointercapture',()=>on(0));
});
function readInput(){
  let thr=Math.max(K.up,TOUCH.gas), brk=Math.max(K.down,TOUCH.brake), st=(K.right+TOUCH.right)-(K.left+TOUCH.left), dig=!!(K.down||TOUCH.brake);
  try{const gps=navigator.getGamepads?navigator.getGamepads():[];for(const gp of gps){if(!gp)continue;const ax=gp.axes[0]||0;if(Math.abs(ax)>0.08)st+=ax;
    if(gp.buttons[7])thr=Math.max(thr,gp.buttons[7].value);if(gp.buttons[6])brk=Math.max(brk,gp.buttons[6].value);if(gp.buttons[0]&&gp.buttons[0].pressed)thr=1;if(gp.buttons[1]&&gp.buttons[1].pressed){brk=1;dig=true;}break;}}catch(e){}
  const pw=activeWheel();let wd=null;if(REMOTE.phones>0&&pw){st+=pw.steer;thr=Math.max(thr,pw.gas);brk=Math.max(brk,pw.brake);if(pw.angle!=null)wd=pw.angle;}
  if(pw&&REMOTE.phones>0&&pw.brake>0.02)dig=false;   // the phone's brake is an analog slide
  return {throttle:clamp(thr,0,1),brake:clamp(brk,0,1),steer:clamp(st,-1,1),wheelDeg:wd,brakeDigital:dig&&brk>0.98};
}

/* ================= PHONE WHEEL (only when served by the local server) ================= */
const REMOTE={phones:0,steer:0,gas:0,brake:0,t:0,ws:null,live:false};
// The phone draws the HUD itself, from ~30 updates a second.
const r2=v=>Math.round(v*100)/100, r4=v=>Math.round(v*1e4)/1e4;
// a hidden sim tab stays quiet towards phones: only the tab on screen drives the phone's HUD
function sendTrack(){if(!REMOTE.live||!REMOTE.phones||document.hidden)return;
  remoteSend({t:'track',src:SOURCE_ID,trackRev,name:TRACK_NAME,N,L,DS,PX:Array.from(PX,r2),PZ:Array.from(PZ,r2),TX:Array.from(TX,r4),TZ:Array.from(TZ,r4),H:Array.from(H,r2),SL:Array.from(SL,r4),LAT:Array.from(LATRL,r2),VP:Array.from(VPROF,r2),
    C:CORNERS.map(c=>({s0:r2(c.s0),s1:r2(c.s1),sg:c.sg,angle:r4(c.angle),n:c.n,apex:r2(c.apex)}))});}
let stateLast=0;
function phoneFrame(w,t,dt,now){
  if(document.hidden)return;
  if(!REMOTE.live||!REMOTE.phones||now-stateLast<22)return;const ws=REMOTE.ws;if(!ws||ws.readyState!==1||ws.bufferedAmount>64000)return;
  stateLast=now;const P=w.player,RD=w.radar;
  // radar picture for the phone: origin, reach, loss, this scan's returns [x,z,static] and tracks [x,z,flags]
  let rd=null;if(RD&&RD.ox!=null){const d=[],k=[];for(const q of RD.dets.slice(0,90))d.push(r2(q.x),r2(q.z),q.st?1:0);
    for(const T of RD.tracks)if(T.conf&&!T.barrier)k.push(r2(T.x),r2(T.z),T.obj?1:0);rd={o:[r2(RD.ox),r2(RD.oz)],g:Math.round(RD.rng),a:r2(RD.att),d,k};}
  // force feedback for the phone's vibration motor: kerb rumble, tyre slip, impacts, cornering load, spray
  const inCorner=CORNERS.some(cn=>dSigned(cn.s0-12,P.s)>=0&&dSigned(P.s,cn.s1+12)>0),drive=w.opts.driver==='drive';
  // tyre channels from physics/vehicle.c: aligning torque (steering weight), front/rear saturation past the peak
  // (understeer scrub / oversteer slide), lock-up, wheelspin; plus kerbs, impacts, spray and aquaplaning
  const ffb=[Math.abs(P.lat)>HW-1.1&&inCorner&&P.v>3?clamp(P.v/40,0.3,1):0,
    (w.t-(P.lastHitT||-9)<0.15||w.traffic.some(c=>c.touch))?1:0,
    drive?clamp(Math.abs(P.mz||0)*2.2,0,1):0,
    drive?clamp(((P.satF||0)-0.95)*2.5,0,1):0,
    drive?clamp(((P.satR||0)-0.95)*2.5,0,1):0,
    drive?clamp((-Math.min(P.kf||0,P.kr||0)-0.1)*3,0,1):0,
    drive?clamp(((P.kr||0)-0.12)*3,0,1):0,
    w.spray||0, drive?(P.aqua||0):0].map(r2);
  remoteSend({t:'w',hk:[P.hitN||0,r2(P.hitSev||0)],src:SOURCE_ID,trackRev,worldRev,tm:r2(t),tw:Math.round(now),cm:[r4(camera.position.x),r4(camera.position.y),r4(camera.position.z),r4(camera.quaternion.x),r4(camera.quaternion.y),r4(camera.quaternion.z),r4(camera.quaternion.w)],fov:camera.fov,fg:w.flags?[r2(w.secLen)].concat(Array.from(w.flags)):null,dr:drive?1:0,hd:w.opts.hud?1:0,bh:w.behind?[r2(w.behind.d),w.behind.side,r2(w.behind.cl)]:null,scr:[Math.round(cw),Math.round(ch)],sp:r2(w.spray||0),rd,ffb,
    p:[r2(P.s),r2(P.lat),r4(P.psi||0),r2(P.latV||0),r2(P.slideV||0),r2(P.v),r2(P.vx==null?P.v:P.vx),P.lapc||0,r2(P.brk||0),r2(P.thr||0),P.rev?-2:P.gear==null?-1:P.gear,Math.round(P.rpm||0),r4(P.beta||0),r4(P.steer||0)],
    tr:w.traffic.map(c=>[r2(c.s),r2(c.lat),r2(c.latV),r2(c.v),c.vis?1:0,c.closing?1:0,c.lapc||0]),
    hz:w.hazards.map(h=>[h.type,r2(h.s),r2(h.lat),r2(h.yaw||0),h.halfLen,h.halfW,h.vis?1:0,h.gone?1:0,r2(h.avoid),h.vpass,h.label]),
    a:w.alert,ni:w.near?w.hazards.indexOf(w.near):-1,dn:r2(w.dNear),vis:Math.round(w.vis),fo:w.flagOn?1:0,fl:w.sc.flag||'',z:r4(NAV.zoom)});
}
// Several phones can be linked, each with its own id. Only the freshest one steers.
REMOTE.dev=new Map();
function phoneDev(id){id=id||'phone';let d=REMOTE.dev.get(id);if(!d){d={id,steer:0,gas:0,brake:0,t:0};REMOTE.dev.set(id,d);}return d;}
function activeWheel(){const now=performance.now();let b=null;for(const d of REMOTE.dev.values())if(now-d.t<500&&(!b||d.t>b.t))b=d;return b;}
function phoneRoles(){REMOTE.wheels=REMOTE.phones;remotePanel();}
function remoteSend(o){const ws=REMOTE.ws;if(ws&&ws.readyState===1)ws.send(JSON.stringify(o));}
function remotePanel(){
  if(!REMOTE.live)return;
  const n=REMOTE.phones,ok=n>0,st=$('phStatus'),fresh=performance.now()-REMOTE.t<600;
  st.textContent=!ok?'Waiting for a phone':fresh?`${n>1?n+' phones':'Phone'} linked · ${REMOTE.rate||0} inputs/s`:'Wheel phone linked but sending nothing. Reload the wheel page and keep it in front';
  st.classList.toggle('ok',ok&&fresh);
}
async function remoteInit(){
  // retried: right after a deploy the first request can hit a cold or switching function, and giving up then hid
  // the Phone tab for the whole visit. Any non-local host is the website, which always pairs through the cloud relay.
  let info=null;
  for(let i=0;i<5&&!info;i++){try{const r=await fetch('/info',{cache:'no-store'});if(r.ok)info=await r.json();}catch(e){}if(!info)await new Promise(r=>setTimeout(r,600*(i+1)));}
  const local=/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  if(!info&&!local)info={app:'rm-racing-sim',cloud:true};
  if(!info)return;
  if(!info||info.app!=='rm-racing-sim'||info.remote)return;   // opened from another computer: no phone link
  REMOTE.live=true;$('phonePanel').hidden=false;$('tabPhone').hidden=false;
  // cloud site: a private room code instead of the LAN address. It stays in this browser so the phone stays paired.
  let room='';if(info.cloud){try{room=localStorage.getItem('lar.room')||'';}catch(e){}
    if(!/^[A-Za-z0-9_-]{16}$/.test(room)){const b=crypto.getRandomValues(new Uint8Array(12));room=btoa(String.fromCharCode(...b)).replace(/\+/g,'-').replace(/\//g,'_');try{localStorage.setItem('lar.room',room);}catch(e){}}
    info.lan=location.origin+'/wheel?k='+room;$('lanH').textContent='Open on the phone (any network)';
    $('lanNote').textContent='The link holds a private room code. Anyone with it can join your session, so keep it to yourself.';$('usbRow').hidden=true;}
  $('qr').src='/qr.svg?u='+encodeURIComponent(info.lan);$('urlLan').textContent=info.lan;$('urlUsb').textContent=info.usb||'';
  const adb=()=>fetch('/info',{cache:'no-store'}).then(r=>r.json()).then(i=>{$('usbState').textContent=i.adb==='ready'?'USB link is ready. Open the address above in Chrome on the phone.':i.adb==='no device'?'No phone on USB. Turn on USB debugging and plug it in, or use Wi-Fi.':i.adb==='not found'?'adb is not installed, so use Wi-Fi.':'adb reverse failed. Unplug and replug the phone.';}).catch(()=>{});
  if(!info.cloud){adb();setInterval(adb,4000);}
  let lost=0;
  const connect=()=>{const ws=new WebSocket((location.protocol==='https:'?'wss://':'ws://')+location.host+'/ws?role=game'+(room?'&k='+room:''));REMOTE.ws=ws;
    ws.onopen=()=>clearTimeout(lost);
    ws.onmessage=e=>{let m;try{m=JSON.parse(e.data);}catch(_){return;}
      if(m.t==='hello'){phoneDev(m.id);phoneRoles();sendTrack();}
      else if(m.t==='in'){const d=phoneDev(m.id);d.steer=+m.s||0;d.gas=+m.g||0;d.brake=+m.b||0;d.angle=m.a!=null?+m.a:null;d.t=performance.now();
        REMOTE.steer=d.steer;REMOTE.gas=d.gas;REMOTE.brake=d.brake;REMOTE.t=d.t;REMOTE.n=(REMOTE.n||0)+1;}
      else if(m.t==='bye'){REMOTE.dev.delete(m.id);phoneRoles();}
      else if(m.t==='phones'){const was=REMOTE.phones;REMOTE.phones=m.n;
        if(m.ids)for(const id of [...REMOTE.dev.keys()])if(!m.ids.includes(id))REMOTE.dev.delete(id);phoneRoles();
        if(m.n>was)sendTrack();
        if(m.n>0&&was===0&&REMOTE.gone){clearTimeout(REMOTE.gone);REMOTE.gone=0;}  // quick reconnect: nothing to announce
        else if(m.n>0&&was===0){if(!running){ui.driver='drive';ui.steer='full';syncControls();applyLive();}toast('<b class="info">Phone wheel linked</b>Full steering: tilt to turn the wheels. Traction control, ABS and brake balance keep their Setup settings.');}
        if(m.n===0&&was>0){clearTimeout(REMOTE.gone);REMOTE.gone=setTimeout(()=>{REMOTE.gone=0;if(!REMOTE.phones)toast('<b class="info">Phone wheel disconnected</b>Keyboard controls still work.');},4000);}}
      else if(m.t==='cmd'){if(m.c==='start'&&!running)startRun();else if(m.c==='stop'&&running)stopRun();else if(m.c==='drop')dropHazard();else if(m.c==='cam'){ui.cam=ui.cam==='cockpit'?'chase':'cockpit';syncControls();}}};
    // the cloud relay recycles connections every few minutes: only count the phones as gone if it stays down
    ws.onclose=()=>{clearTimeout(lost);lost=setTimeout(()=>{REMOTE.phones=0;REMOTE.dev.clear();phoneRoles();},info.cloud?5000:0);setTimeout(connect,info.cloud?300:1000);};};
  connect();
  setInterval(()=>{REMOTE.rate=(REMOTE.n||0);REMOTE.n=0;remotePanel();},1000);
  setInterval(()=>{const w=world;if(!w||!REMOTE.phones||document.hidden)return;const P=w.player,nh=w.near&&w.dNear<RANGE&&w.opts.hud?w.near:null;
    remoteSend({t:'st',ap:0,wh:REMOTE.wheels||0,a:w.alert,k:Math.round(P.v*3.6),r:running&&!w.done,w:!!P.onWall,h:nh?nh.label:'',d:nh?Math.round(w.dNear):0});
    const deg=REMOTE.steer*45;$('mSteerV').textContent=(deg>0?'R ':deg<0?'L ':'')+Math.abs(Math.round(REMOTE.steer*100))+'%';
    const f=$('mSteer').querySelector('.fill'),v=REMOTE.steer;f.style.left=(v<0?50+v*50:50)+'%';f.style.width=Math.abs(v)*50+'%';
    $('mGas').querySelector('.fill').style.width=REMOTE.gas*100+'%';$('mBrake').querySelector('.fill').style.width=REMOTE.brake*100+'%';},80);
}

/* ================= CIRCUIT PANEL & BUILDER ================= */
const MINI={bg:null,T:null,sc:1,t:0};
function drawMini(){
  const cv=$('miniMap'),W=cv.width,Hh=cv.height,bg=document.createElement('canvas');bg.width=W;bg.height=Hh;const c=bg.getContext('2d');
  c.fillStyle='#070B10';c.fillRect(0,0,W,Hh);
  c.strokeStyle='rgba(120,160,190,.06)';c.lineWidth=1;for(let x=0;x<W;x+=40){c.beginPath();c.moveTo(x,0);c.lineTo(x,Hh);c.stroke();}for(let y=0;y<Hh;y+=40){c.beginPath();c.moveTo(0,y);c.lineTo(W,y);c.stroke();}
  let minx=1e9,maxx=-1e9,minz=1e9,maxz=-1e9;for(let i=0;i<N;i+=4){minx=Math.min(minx,PX[i]);maxx=Math.max(maxx,PX[i]);minz=Math.min(minz,PZ[i]);maxz=Math.max(maxz,PZ[i]);}
  const s=Math.min((W-120)/(maxx-minx),(Hh-120)/(maxz-minz)),ox=(W-(maxx-minx)*s)/2-minx*s,oz=(Hh-(maxz-minz)*s)/2-minz*s,T=(x,z)=>[ox+x*s,oz+z*s];
  MINI.T=T;MINI.sc=s;
  c.fillStyle='#111922';c.strokeStyle='#18222d';for(const bf of FOOT){c.beginPath();bf.pts.forEach((p,k)=>{const q=T(p[0],p[1]);k?c.lineTo(q[0],q[1]):c.moveTo(q[0],q[1]);});c.closePath();c.fill();c.stroke();}
  const path=new Path2D();for(let i=0;i<=N;i+=3){const q=T(PX[i%N],PZ[i%N]);i?path.lineTo(q[0],q[1]):path.moveTo(q[0],q[1]);}path.closePath();
  c.lineJoin='round';c.lineCap='round';c.strokeStyle='#2c3a47';c.lineWidth=Math.max(9,2*WALL*s);c.stroke(path);c.strokeStyle='#4a5b69';c.lineWidth=Math.max(6,2*HW*s);c.stroke(path);
  // corners
  c.font='700 13px "B612 Mono", monospace';c.textAlign='center';c.textBaseline='middle';
  CORNERS.forEach(cn=>{const p=worldPos(cn.apex,-cn.sg*(WALL+30)),q=T(p.x,p.z);c.fillStyle='rgba(196,248,255,.55)';c.fillText('T'+cn.n,q[0],q[1]);});
  // start/finish and direction
  const sf=T(PX[0],PZ[0]);c.save();c.translate(sf[0],sf[1]);c.rotate(Math.atan2(TZ[0],TX[0])+Math.PI/2);for(let k=-3;k<3;k++)for(let r=0;r<2;r++){c.fillStyle=(k+r)%2?'#111':'#fff';c.fillRect(k*4,-4+r*4,4,4);}c.restore();
  const d0=worldPos(14,0),d1=worldPos(60,0),a0=T(d0.x,d0.z),a1=T(d1.x,d1.z),ang=Math.atan2(a1[1]-a0[1],a1[0]-a0[0]);
  c.strokeStyle='rgba(196,248,255,.5)';c.lineWidth=2;c.beginPath();c.moveTo(a0[0],a0[1]);c.lineTo(a1[0],a1[1]);c.stroke();c.fillStyle='rgba(196,248,255,.5)';c.beginPath();c.moveTo(a1[0]+Math.cos(ang)*9,a1[1]+Math.sin(ang)*9);c.lineTo(a1[0]+Math.cos(ang+2.4)*8,a1[1]+Math.sin(ang+2.4)*8);c.lineTo(a1[0]+Math.cos(ang-2.4)*8,a1[1]+Math.sin(ang-2.4)*8);c.fill();
  // where each scenario's hazard is
  c.font='700 10px "B612 Mono", monospace';
  MINI.bg=bg;
  $('cName').textContent=TRACK_NAME;$('cLen').textContent=(L/1000).toFixed(2)+' km';$('cCorners').textContent=CORNERS.length;
  $('cStraight').textContent=Math.round(SPOTS.crestStraight.len)+' m';
  drawMiniLive(world);
}
function drawMiniLive(w){
  const cv=$('miniMap');if(!MINI.bg||!w)return;const c=cv.getContext('2d'),T=MINI.T,P=w.player;
  c.drawImage(MINI.bg,0,0);
  // the stretch of track the radar is covering right now
  if(w.opts.hud){c.lineCap='round';c.lineJoin='round';
    for(let d=0;d<RANGE;d+=6){const a=worldPos(P.s+d,0),b=worldPos(P.s+d+6,0),qa=T(a.x,a.z),qb=T(b.x,b.z);c.strokeStyle=`rgba(57,230,180,${0.75*(1-d/RANGE*0.7)})`;c.lineWidth=Math.max(4,2*HW*MINI.sc*0.55);c.beginPath();c.moveTo(qa[0],qa[1]);c.lineTo(qb[0],qb[1]);c.stroke();}}
  // hazards
  for(const h of w.hazards){if(h.gone)continue;const p=worldPos(h.s,h.lat),q=T(p.x,p.z),col=w.alert===2&&h===w.near?'#FF4B3A':'#FFC247';hazIcon(c,h.type,q[0],q[1]-4,18,col,true,'#0A0E13');}
  // cars, in tracker colours; hollow if spray, walls or a crest hide them from you
  c.font='700 10px "B612 Mono", monospace';c.textAlign='center';c.textBaseline='bottom';
  w.traffic.forEach((t,i)=>{const p=worldPos(t.s,t.lat),q=T(p.x,p.z),col=TRK_COLS[i%TRK_COLS.length];
    c.beginPath();c.arc(q[0],q[1],5.5,0,TAU);if(t.vis){c.fillStyle=col;c.fill();}else{c.setLineDash([2.5,2]);c.strokeStyle=col;c.lineWidth=1.8;c.stroke();c.setLineDash([]);}
    if(t.closing){c.strokeStyle='#FF4B3A';c.lineWidth=2;c.beginPath();c.arc(q[0],q[1],9,0,TAU);c.stroke();}
    c.fillStyle=col;c.fillText(TRK_CODES[i%TRK_CODES.length],q[0],q[1]-8);});
  // you: an arrow pointing where the car is heading
  const hd=headingAt(P.s,carYaw(P,true)),pp=worldPos(P.s,P.lat),q=T(pp.x,pp.z),ang=Math.atan2(hd[1],hd[0]);
  c.save();c.translate(q[0],q[1]);c.rotate(ang);c.fillStyle='#C4F8FF';c.strokeStyle='#0A0E13';c.lineWidth=2;
  c.beginPath();c.moveTo(11,0);c.lineTo(-7,-7);c.lineTo(-3,0);c.lineTo(-7,7);c.closePath();c.fill();c.stroke();c.restore();
  c.strokeStyle='rgba(196,248,255,.5)';c.lineWidth=1.5;c.beginPath();c.arc(q[0],q[1],15,0,TAU);c.stroke();
  // position readout
  const ri=raceInfo(w);c.textAlign='left';c.textBaseline='bottom';c.fillStyle='#C4F8FF';c.font='700 26px "B612 Mono", monospace';const by=cv.height-18;c.fillText('P'+ri.pos,22,by);
  const pw=c.measureText('P'+ri.pos).width;c.font='700 13px "B612 Mono", monospace';c.fillStyle='rgba(196,248,255,.6)';c.fillText('/'+ri.n+'   LAP '+ri.lap+'   '+Math.round(P.v*3.6)+' KM/H',26+pw,by-4);
}
function applyTrack(raw,name){
  if(running)stopRun();
  buildTrack(raw,name);physTrack();buildTrackMeshes();drawMini();resetWorld();sendTrack();
}

const B={mode:'upload',img:null,proc:null,pick:null,tol:60,km:4.5,rev:false,loop:null,drawing:false,draw:[]};
const bc=$('bCanvas'),bx=bc.getContext('2d'),BW=bc.width,BH=bc.height;
function openBuilder(mode){B.mode=mode;$('builder').hidden=false;syncBuilder();redrawBuilder();}
function closeBuilder(){$('builder').hidden=true;}
function syncBuilder(){
  $('bTabUp').setAttribute('aria-pressed',B.mode==='upload'?'true':'false');$('bTabDraw').setAttribute('aria-pressed',B.mode==='draw'?'true':'false');
  $('bUpActions').hidden=B.mode!=='upload';$('bDrawActions').hidden=B.mode!=='draw';$('bPickWrap').hidden=B.mode!=='upload';
  $('bHint').textContent=B.mode==='upload'?'Click the track line in the image to match its colour. Magenta is the lap the builder found.':'Draw one lap in a single stroke. It closes itself when you let go.';
  $('bKmOut').textContent=B.km.toFixed(1)+' km';$('bTolOut').textContent=B.tol;
  $('bSwatch').style.background=B.pick?`rgb(${B.pick.join(',')})`:'';$('bPickTxt').textContent=B.pick?'Matching the colour you clicked':'Auto: everything that is not background';
  $('bBuild').disabled=!B.loop;
}
function status(msg,kind){const s=$('bStatus');s.textContent=msg;s.className='b-status '+(kind||'');}
function fitRect(iw,ih){const s=Math.min(BW/iw,BH/ih);return {s,x:(BW-iw*s)/2,y:(BH-ih*s)/2};}
function redrawBuilder(){
  bx.fillStyle='#F1F0EA';bx.fillRect(0,0,BW,BH);
  if(B.mode==='upload'){
    if(B.img){const F=fitRect(B.img.width,B.img.height);bx.drawImage(B.img,F.x,F.y,B.img.width*F.s,B.img.height*F.s);bx.fillStyle='rgba(241,240,234,.35)';bx.fillRect(0,0,BW,BH);}
    else{bx.fillStyle='#8B8F93';bx.font='600 18px "B612", sans-serif';bx.textAlign='center';bx.fillText('Drop a screenshot here, or paste it with ⌘V',BW/2,BH/2);}
  } else {
    bx.strokeStyle='#E2E1D9';bx.lineWidth=1;for(let x=0;x<BW;x+=40){bx.beginPath();bx.moveTo(x,0);bx.lineTo(x,BH);bx.stroke();}for(let y=0;y<BH;y+=40){bx.beginPath();bx.moveTo(0,y);bx.lineTo(BW,y);bx.stroke();}
    if(B.drawing&&B.draw.length>1){bx.strokeStyle='#2B3542';bx.lineWidth=5;bx.lineJoin='round';bx.lineCap='round';bx.beginPath();B.draw.forEach((p,k)=>k?bx.lineTo(p[0],p[1]):bx.moveTo(p[0],p[1]));bx.stroke();}
    else if(!B.loop){bx.fillStyle='#8B8F93';bx.font='600 18px "B612", sans-serif';bx.textAlign='center';bx.fillText('Draw one lap here',BW/2,BH/2);}
  }
  if(B.loop&&!B.drawing){const pts=B.rev?B.loop.slice().reverse():B.loop;
    bx.strokeStyle='rgba(255,255,255,.9)';bx.lineWidth=9;bx.lineJoin='round';bx.beginPath();pts.forEach((p,k)=>k?bx.lineTo(p[0],p[1]):bx.moveTo(p[0],p[1]));bx.closePath();bx.stroke();
    bx.strokeStyle=NC.route;bx.lineWidth=5;bx.stroke();
    const a=pts[0],b=pts[Math.min(pts.length-1,8)],ang=Math.atan2(b[1]-a[1],b[0]-a[0]);
    bx.fillStyle='#1F5FD6';bx.beginPath();bx.arc(a[0],a[1],8,0,TAU);bx.fill();bx.save();bx.translate(a[0],a[1]);bx.rotate(ang);bx.fillStyle='#1F5FD6';bx.beginPath();bx.moveTo(26,0);bx.lineTo(12,-8);bx.lineTo(12,8);bx.fill();bx.restore();
    bx.fillStyle='#15181C';bx.font='700 13px "B612 Mono", monospace';bx.textAlign='left';bx.fillText('START',a[0]+12,a[1]-12);}
}
function loadFile(file){
  if(!file||!/^image\//.test(file.type)){status('That is not an image. Use a PNG, JPG or WebP of a circuit map.','err');return;}
  const url=URL.createObjectURL(file),im=new Image();
  im.onload=()=>{URL.revokeObjectURL(url);B.img=im;B.pick=null;B.rev=false;const nm=file.name.replace(/\.[^.]+$/,'').replace(/[_-]+/g,' ').trim();$('bName').value=!nm||/^(screen ?shot|image|clipboard|스크린샷|화면)/i.test(nm)?'My circuit':nm.slice(0,40);prepProc();detect();};
  im.onerror=()=>{URL.revokeObjectURL(url);status('That image could not be read. Try a PNG or JPG.','err');};
  im.src=url;
}
function prepProc(){const im=B.img,k=Math.min(1,380/Math.max(im.width,im.height)),w=Math.max(16,Math.round(im.width*k)),h=Math.max(16,Math.round(im.height*k));
  const cv=document.createElement('canvas');cv.width=w;cv.height=h;const ctx=cv.getContext('2d',{willReadFrequently:true});ctx.fillStyle='#fff';ctx.fillRect(0,0,w,h);ctx.drawImage(im,0,0,w,h);B.proc={cv,ctx,w,h};}
function detect(){
  if(!B.proc)return;
  const r=detectLoop(B.proc.ctx,B.proc.w,B.proc.h,B.pick,B.tol);
  if(!r.ok){B.loop=null;status(r.msg,'err');}
  else{const F=fitRect(B.proc.w,B.proc.h);B.loop=r.pts.map(([x,y])=>[F.x+(x+0.5)*F.s,F.y+(y+0.5)*F.s]);
    status(`Found a closed lap (${r.method}, ${r.pts.length} points). Check the magenta line follows the track, then build.`,'ok');}
  syncBuilder();redrawBuilder();
}
// image -> closed lap, in C++ (physics/trace.cpp): colour mask, close gaps, largest blob, thin to a centreline,
// drop dead ends, walk the loop (or trace the outline)
function detectLoop(ctx,W,H,pick,tol){
  const X=PHYS.x;if(!X)return {ok:false,msg:'The tracer is still loading. Try again in a moment.'};
  new Uint8Array(X.memory.buffer,X.trace_rgba(),W*H*4).set(ctx.getImageData(0,0,W,H).data);
  const n=X.trace_run(W,H,pick?1:0,pick?pick[0]:0,pick?pick[1]:0,pick?pick[2]:0,tol);
  if(n===-1)return {ok:false,msg:'No track line found. Click on the track in the image to pick its colour, or raise the colour match.'};
  if(n===-2)return {ok:false,msg:'Most of the image matched, so the track could not be separated. Click on the track line to pick its colour, or lower the colour match.'};
  if(n<0)return {ok:false,msg:'Found the track but could not follow it all the way round. Make sure the lap is one closed line, or try Draw.'};
  const P=new Int32Array(X.memory.buffer,X.trace_points(),n*2),pts=[];for(let i=0;i<n;i++)pts.push([P[2*i],P[2*i+1]]);
  return {ok:true,pts,method:X.trace_method()?'outline':'centreline'};
}
function sampleMap(){
  const cv=document.createElement('canvas');cv.width=900;cv.height=600;const c=cv.getContext('2d');
  c.fillStyle='#EEF0EA';c.fillRect(0,0,900,600);
  c.fillStyle='#CFE0EA';c.beginPath();c.moveTo(560,600);c.bezierCurveTo(640,520,820,540,900,470);c.lineTo(900,600);c.fill();
  c.strokeStyle='#D9DBD3';c.lineWidth=6;for(let x=40;x<900;x+=95){c.beginPath();c.moveTo(x,0);c.lineTo(x+40,600);c.stroke();}for(let y=30;y<600;y+=90){c.beginPath();c.moveTo(0,y);c.lineTo(900,y-30);c.stroke();}
  const P=[[150,470],[520,480],[700,470],[770,415],[745,330],[640,300],[600,230],[680,165],[800,140],[830,90],[760,58],[520,70],[420,130],[330,108],[230,150],[170,240],[118,330],[110,420]];
  c.strokeStyle='#B8232B';c.lineWidth=11;c.lineJoin='round';c.lineCap='round';c.beginPath();
  for(let i=0;i<P.length;i++){const a=P[i],b=P[(i+1)%P.length],mx=(a[0]+b[0])/2,my=(a[1]+b[1])/2;if(i===0){const z=P[P.length-1];c.moveTo((z[0]+a[0])/2,(z[1]+a[1])/2);}c.quadraticCurveTo(a[0],a[1],mx,my);}
  c.closePath();c.stroke();
  c.lineWidth=4;c.beginPath();c.moveTo(190,474);c.quadraticCurveTo(230,500,300,501);c.lineTo(440,503);c.quadraticCurveTo(495,502,515,481);c.stroke();
  c.fillStyle='#111';c.fillRect(300,462,3,24);
  c.font='700 15px sans-serif';c.fillStyle='#4A4F55';c.fillText('HARBOUR',640,560);c.fillText('OLD TOWN',300,300);c.fillText('TUNNEL',540,40);
  [[560,445,'1'],[800,440,'2'],[610,330,'3'],[860,160,'4'],[520,108,'5'],[210,120,'6'],[80,300,'7']].forEach(([x,y,t])=>{c.fillStyle='#1B1E22';c.beginPath();c.arc(x,y,11,0,TAU);c.fill();c.fillStyle='#fff';c.font='700 12px sans-serif';c.textAlign='center';c.fillText(t,x,y+4);c.textAlign='left';});
  c.fillStyle='#1B1E22';c.font='700 22px sans-serif';c.fillText('Harbour Street Circuit',30,40);
  return cv;
}
$('drawBtn').addEventListener('click',()=>{B.loop=null;B.draw=[];openBuilder('draw');status('');});
$('defBtn').addEventListener('click',()=>applyTrack(defaultLoop(),'Grand Prix circuit'));
$('bChoose').addEventListener('click',()=>$('fileIn').click());
$('fileIn').addEventListener('change',e=>{const f=e.target.files&&e.target.files[0];if(f){if($('builder').hidden)openBuilder('upload');loadFile(f);}e.target.value='';});
$('bSample').addEventListener('click',()=>{B.img=sampleMap();B.pick=null;B.rev=false;$('bName').value='Harbour Street Circuit';B.km=3.4;$('bKm').value=34;prepProc();detect();});
$('bTabUp').addEventListener('click',()=>{B.mode='upload';B.loop=null;if(B.proc)detect();syncBuilder();redrawBuilder();});
$('bTabDraw').addEventListener('click',()=>{B.mode='draw';B.loop=null;status('');syncBuilder();redrawBuilder();});
$('bClose').addEventListener('click',closeBuilder);
$('builder').addEventListener('click',e=>{if(e.target===$('builder'))closeBuilder();});
$('bKm').addEventListener('input',e=>{B.km=e.target.value/10;syncBuilder();});
$('bTol').addEventListener('input',e=>{B.tol=+e.target.value;syncBuilder();});
$('bTol').addEventListener('change',()=>detect());
$('bAuto').addEventListener('click',()=>{B.pick=null;B.tol=60;$('bTol').value=60;detect();});
$('bRev').addEventListener('click',()=>{B.rev=!B.rev;redrawBuilder();});
$('bClear').addEventListener('click',()=>{B.loop=null;B.draw=[];status('');syncBuilder();redrawBuilder();});
$('bBuild').addEventListener('click',()=>{
  if(!B.loop)return;let pts=B.rev?B.loop.slice().reverse():B.loop.slice();
  const k=B.km*1000/polyLen(pts);pts=pts.map(p=>[p[0]*k,p[1]*k]);
  closeBuilder();applyTrack(pts,($('bName').value||'My circuit').trim());
  $('circH').scrollIntoView({behavior:RM?'auto':'smooth',block:'nearest'});
});
const bpos=e=>{const r=bc.getBoundingClientRect();return [(e.clientX-r.left)*BW/r.width,(e.clientY-r.top)*BH/r.height];};
bc.addEventListener('pointerdown',e=>{
  const p=bpos(e);
  if(B.mode==='upload'){if(!B.proc)return;const F=fitRect(B.proc.w,B.proc.h),x=Math.floor((p[0]-F.x)/F.s),y=Math.floor((p[1]-F.y)/F.s);
    if(x<1||y<1||x>=B.proc.w-1||y>=B.proc.h-1)return;const d=B.proc.ctx.getImageData(x-1,y-1,3,3).data;let r=0,g=0,b=0;for(let i=0;i<9;i++){r+=d[i*4];g+=d[i*4+1];b+=d[i*4+2];}
    B.pick=[Math.round(r/9),Math.round(g/9),Math.round(b/9)];B.tol=Math.max(B.tol,55);$('bTol').value=B.tol;detect();return;}
  bc.setPointerCapture(e.pointerId);B.drawing=true;B.draw=[p];B.loop=null;redrawBuilder();
});
bc.addEventListener('pointermove',e=>{if(!B.drawing)return;const p=bpos(e),l=B.draw[B.draw.length-1];if(Math.hypot(p[0]-l[0],p[1]-l[1])>3){B.draw.push(p);redrawBuilder();}});
const endDraw=()=>{if(!B.drawing)return;B.drawing=false;
  if(B.draw.length<30||polyLen(B.draw)<600){B.loop=null;status('That lap is too short. Draw a bigger loop.','err');}
  else{B.loop=B.draw.slice();status('Lap drawn. It closes from where you let go back to the start.','ok');}
  syncBuilder();redrawBuilder();};
bc.addEventListener('pointerup',endDraw);bc.addEventListener('pointercancel',endDraw);
// circuit from a screenshot: drop it anywhere on the page, paste it (⌘V), or click the drop area to browse
function takeImage(f){if(!f)return;if($('builder').hidden)openBuilder('upload');B.mode='upload';syncBuilder();loadFile(f);}
{const all=$('dropAll'),zone=$('dropzone');let depth=0;
  const files=e=>e.dataTransfer&&[...e.dataTransfer.types].includes('Files');
  addEventListener('dragenter',e=>{if(!files(e))return;e.preventDefault();depth++;all.hidden=false;zone.classList.add('over');});
  addEventListener('dragover',e=>{if(!files(e))return;e.preventDefault();e.dataTransfer.dropEffect='copy';});
  addEventListener('dragleave',e=>{if(!files(e))return;depth=Math.max(0,depth-1);if(!depth){all.hidden=true;zone.classList.remove('over');}});
  addEventListener('drop',e=>{if(!files(e))return;e.preventDefault();depth=0;all.hidden=true;zone.classList.remove('over');
    const fs=[...e.dataTransfer.files];takeImage(fs.find(f=>/^image\//.test(f.type))||fs[0]);});
  addEventListener('paste',e=>{if(e.target.closest&&e.target.closest('input,textarea'))return;
    const it=[...((e.clipboardData&&e.clipboardData.items)||[])].find(i=>i.type.startsWith('image/'));if(it){e.preventDefault();takeImage(it.getAsFile());}});
  zone.addEventListener('click',()=>$('fileIn').click());
  zone.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();$('fileIn').click();}});}

/* ================= FRAME ================= */
let camInit=false;
const camPos=new THREE.Vector3(), camLook=new THREE.Vector3(), eye=new THREE.Vector3(), vel=new THREE.Vector3(), lastCam=new THREE.Vector3();
function setRain(m,on){const r=m.userData.rain;if(r){r[0].visible=on;r[1].visible=on;}}
function syncScene(w,t,dt){
  const P=w.player;
  placeObj(player,P.s,P.lat,carYaw(P,true),0);player.updateMatrixWorld();
  if(playerGLB){const chase=ui.cam==='chase';playerGLB.visible=chase;player.visible=!chase;if(chase){playerGLB.position.copy(player.position);playerGLB.quaternion.copy(player.quaternion);setRain(playerGLB,(t*4)%1<0.5&&w.rain>0.15);}}
  key.position.set(player.position.x-18,player.position.y+42,player.position.z+12);key.target.position.copy(player.position);key.target.updateMatrixWorld();
  const roll=(m,v)=>{const wl=m.userData&&m.userData.wheels;if(wl)for(const q of wl)q.roll.rotation.x-=v*dt/q.r;};roll(player,P.v);
  const fs=P.delta!=null&&w.opts.driver==='drive'?P.delta*1.4:(P.steer||0)*0.35; player.userData.front.forEach(wh=>wh.rotation.y=-fs);
  const blink=(t*4)%1<0.5&&w.rain>0.15;
  setRain(player,blink);
  w.traffic.forEach((c,i)=>{const m=trafficMeshes[i];placeObj(m,c.s,c.lat,carYaw(c),0);setRain(m,blink||!!c.braking);roll(m,c.v);
    wheelFX(m,autoTyre(w.rain),discHeat(c,c.v,dt));m.updateMatrixWorld();});
  const Tb=P.brakeT!=null&&P.comp!=null?P.brakeT:discHeat(P,P.v,dt),pc=P.comp!=null?P.comp:tyreFor(w.opts);
  wheelFX(player,pc,Tb);if(playerGLB)wheelFX(playerGLB,pc,Tb);
  if(wetApplied!==w.rain){wetApplied=w.rain;wetLook(player,w.rain);wetLook(playerGLB,w.rain);wetLook(dyn,w.rain);}
  w.hazards.forEach((h,i)=>{const m=hazardMeshes[i];if(!m)return;m.visible=!h.gone;if(h.gone)return;
    if(h.type==='marshal'){const run=h.moving;placeObj(m,h.s,h.lat,run?(h.dir>0?Math.PI/2:-Math.PI/2):0,0);const ph=run?Math.sin(t*14)*0.7:0;const l=m.userData.limbs;l[0].rotation.x=ph;l[1].rotation.x=-ph;l[2].rotation.x=-ph;l[3].rotation.x=ph;m.position.y+=run?Math.abs(Math.sin(t*14))*0.06:0;}
    else placeObj(m,h.s,h.lat,h.yaw,0);
    if(m.userData.rain)setRain(m,(t*2.2)%1<0.5);
    if(m.userData.beacon)m.userData.beacon.material.opacity=0.35+0.65*Math.max(0,Math.sin(t*9));});
  for(const f of flagPosts){f.userData.flags.forEach((fl,k)=>fl.rotation.y=Math.sin(t*6+k)*0.7+0.2);f.userData.led.material.color.setHex((t*2)%1<0.55?0xffcc00:0x221c00);}
  const v=P.v;
  if(ui.cam==='cockpit'){
    // off-road bumps shake the cockpit; a flat-spotted tyre thumps once per wheel revolution
    const sh=RM?0:(0.004+v*0.00007)+shake+(P.onWall?0.02:0)+(P.bump||0)*0.09, thump=RM?0:Math.max(P.flatF||0,P.flatR||0)*0.012*Math.sin(performance.now()/1000*TAU*v/(TAU*RW));
    // smooth, band-limited vibration (a few engine- and road-rate sines), not per-frame random jitter
    const tt=performance.now()/1000,vx=Math.sin(tt*31.7)*0.5+Math.sin(tt*47.3+1.1)*0.3+Math.sin(tt*73.9+2.3)*0.2,vy=Math.sin(tt*37.1+0.7)*0.5+Math.sin(tt*59.3+1.9)*0.3+Math.sin(tt*83.1+0.4)*0.2;
    eye.set(vx*sh*0.5-clamp((P.ay||0)*0.0022,-0.06,0.06),1.0+vy*sh*0.5+thump,0.1+clamp((P.ax||0)*0.0016,-0.05,0.05));player.localToWorld(eye);camera.position.copy(eye);
    camera.quaternion.copy(player.quaternion);camera.rotateX(-0.07+(P.braking?-0.018:0.006));   // ~4° down, as a driver's eyes and a helmet camera look
    camInit=false;
  } else {
    eye.set(0,2.5,8.2);player.localToWorld(eye);camLook.set(0,0.9,-9);player.localToWorld(camLook);
    if(!camInit){camPos.copy(eye);camInit=true;}else camPos.lerp(eye,1-Math.exp(-dt*7));
    camera.position.copy(camPos);camera.lookAt(camLook);
  }
  camera.updateMatrixWorld();sky.position.copy(camera.position);
  if(ui.cam==="cockpit"){drawWheelScreen(P,performance.now()/1000);drawMirrors();}
  if(dt>0){vel.copy(camera.position).sub(lastCam).divideScalar(dt);if(vel.length()>120)vel.set(0,0,0);}
  lastCam.copy(camera.position);
  // fog: a little denser than the visibility figure, plus a floodlit white-out inside another car's spray
  const sp=w.spray||0, farT=lerp(Math.min(w.vis,12000),20,sp*0.92);
  scene.fog.far=lerp(scene.fog.far,farT,dt>0?1-Math.exp(-dt*(sp>0.05?7:3)):1);scene.fog.near=0;
  scene.fog.color.copy(FOG_BASE).lerp(SPRAY_C,sp*0.65);
  for(const st of STREAKS){const dx=camera.position.x-st.position.x,dz=camera.position.z-st.position.z;if(dx*dx+dz*dz<250*250)st.rotation.y=Math.atan2(-dx,-dz);}
}
function resize(){
  const r=stage.getBoundingClientRect();cw=Math.max(1,r.width);ch=Math.max(1,r.height);dpr=Math.min(window.devicePixelRatio||1,2);
  if(!resize.done){renderer.setPixelRatio(Math.min(dpr,1.75));resize.done=true;}renderer.setSize(cw,ch,false);if(composer){composer.setPixelRatio(renderer.getPixelRatio());composer.setSize(cw,ch);}resizeDrops();camera.aspect=cw/ch;camera.updateProjectionMatrix();
  dpr=Math.min(dpr,1.5);hud.width=Math.round(cw*dpr);hud.height=Math.round(ch*dpr);
  sprayMat.uniforms.uScale.value=(ch*renderer.getPixelRatio())/(2*Math.tan(FOV*Math.PI/360));
}
const visorEl=$('visor'), flashEl=$('flash'), statusEl=$('status');
const sprayFx={el:$('sprayfx'),v:-1}, rearFx={el:$('rearfx'),k:'',was:false};
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

const dropsCv=$('drops'), dctx=dropsCv.getContext('2d'), DROPS=[];
function resizeDrops(){dropsCv.width=Math.round(cw*0.6);dropsCv.height=Math.round(ch*0.6);}
function drawDrops(dt,w){
  const W=dropsCv.width,H=dropsCv.height,v=w.player.v,rain=w.rain,sp=w.spray||0;dropsCv.style.opacity=1;
  const spawn=sp*(70+v*1.4)*dt;for(let k=0;k<spawn||Math.random()<spawn-k;k++){if(DROPS.length>160)break;DROPS.push({x:Math.random()*W,y:Math.random()*H,r:1+Math.random()*(2.5+rain*3),a:0,life:1.5+Math.random()*3});}
  dctx.clearRect(0,0,W,H);const cx=W/2,cy=H*0.55,push=Math.min(1.2,v/60);
  for(let i=DROPS.length-1;i>=0;i--){const d=DROPS[i];d.a+=dt;if(d.a>d.life){DROPS.splice(i,1);continue;}
    d.x+=(d.x-cx)/W*push*140*dt;d.y+=((d.y-cy)/H*push*90+(push<0.3?14:0))*dt;
    const f=Math.min(1,d.a*4)*(1-Math.max(0,(d.a-d.life+0.6)/0.6)),g=dctx.createRadialGradient(d.x-d.r*0.3,d.y-d.r*0.35,d.r*0.1,d.x,d.y,d.r);
    g.addColorStop(0,`rgba(255,255,255,${0.55*f})`);g.addColorStop(0.35,`rgba(200,215,230,${0.12*f})`);g.addColorStop(0.85,`rgba(10,14,20,${0.28*f})`);g.addColorStop(1,'rgba(10,14,20,0)');
    dctx.fillStyle=g;dctx.beginPath();dctx.arc(d.x,d.y,d.r,0,TAU);dctx.fill();
    if(push>0.5){dctx.strokeStyle=`rgba(210,225,240,${0.08*f})`;dctx.lineWidth=d.r*0.6;dctx.beginPath();dctx.moveTo(d.x,d.y);dctx.lineTo(d.x-(d.x-cx)*0.05,d.y-(d.y-cy)*0.05);dctx.stroke();}}
}
let tPrev=performance.now(), acc=0, simT=0, statusT=0;
function frame(now){
  requestAnimationFrame(frame);
  const dt=Math.min(0.05,(now-tPrev)/1000);tPrev=now;simT+=dt;
  const w=world, inp=readInput(), T0=performance.now();
  if(running&&!w.done){acc+=dt;const h=1/120;while(acc>=h){step(w,h,inp);acc-=h;if(w.done)break;}}
  else{acc=0;mpTick(w,dt);}   // between runs: keep sending this car and moving the other drivers' cars
  if(w.done&&running&&doneShownAt==null){doneShownAt=now;if(w.result.verdict==='contact'||w.result.verdict==='crash')shake=0.06;}
  if(doneShownAt!=null&&running&&now-doneShownAt>((w.result.verdict==='contact'||w.result.verdict==='crash')?1300:700))showResult();
  shake*=Math.exp(-dt*3);
  // free drive: report each hazard you pass
  while(w.events.length){const h=w.events.shift(),v=hazVerdict(h);runCount++;
    const r={n:runCount,verdict:v,kmh:Math.round(h.passV*3.6),warnD:h.warnD,seenD:h.firstSeenD,reactD:h.reactD,src:h.src,opts:Object.assign({},w.opts),scn:'free',track:TRACK_NAME,what:h.label};
    LOG.unshift(r);renderLog();
    toast(`<b class="${v}">${v==='safe'?'Safe pass':'Near miss'} · ${r.kmh} km/h</b>${h.label}. ${h.warnD!=null?'Radar warned '+Math.round(h.warnD)+' m out. ':''}${h.firstSeenD!=null?'In sight at '+Math.round(h.firstSeenD)+' m. ':''}${h.rdrD!=null?'On-board radar at '+Math.round(h.rdrD)+' m. ':''}${h.reactD!=null?'You braked '+Math.round(h.reactD)+' m before.':'You did not brake.'}`);}
  if(toastT>0){toastT-=dt;if(toastT<=0)$('toast').hidden=true;}
  if(running&&!w.done){const rate=w.rain*w.rain;
    w.traffic.forEach((c,i)=>{const n=Math.round(rate*clamp(c.v/50,0,1.6)*240*dt+Math.random()*0.6),m=trafficMeshes[i],vel=new THREE.Vector3(0,0,-1).applyQuaternion(m.quaternion).multiplyScalar(c.v);
      if(n>0){emitSpray(m,[-0.82,0.3,1.9],vel,n);emitSpray(m,[0.82,0.3,1.9],vel,n);emitSpray(m,[0,0.45,2.4],vel,Math.ceil(n/2));}
      const nf=Math.round(waterDepth(c.s,c.lat,w.rain)*clamp(c.v/50,0,1.6)*450*dt+Math.random()*0.5);if(nf>0&&c.v>3){emitTyreSpray(m,-1,vel,nf);emitTyreSpray(m,1,vel,nf);}});
    if(w.opts.driver==='drive'&&w.player.sliding){const sl=clamp(Math.abs(w.player.ar)*4+Math.max(0,w.player.kr)*2+Math.max(0,-w.player.kf),0,2),ns=Math.round(sl*60*dt+Math.random()*0.6);
      if(ns>0){const vel=new THREE.Vector3(0,0,-1).applyQuaternion(player.quaternion).multiplyScalar(w.player.v*0.3);emitSpray(player,[-0.8,0.35,1.6],vel,ns);emitSpray(player,[0.8,0.35,1.6],vel,ns);}}
    const n=Math.round(rate*clamp(w.player.v/50,0,1.6)*70*dt+Math.random()*0.4);if(n>0){const vel=new THREE.Vector3(0,0,-1).applyQuaternion(player.quaternion).multiplyScalar(fwdSpeed(w));emitSpray(player,[-0.82,0.3,1.9],vel,n);emitSpray(player,[0.82,0.3,1.9],vel,n);}
    {const P=w.player,nf=Math.round(waterDepth(P.s,P.lat,w.rain)*clamp(P.v/50,0,1.6)*1200*dt+Math.random()*0.5);
      if(nf>0&&P.v>3){const vel=new THREE.Vector3(0,0,-1).applyQuaternion(player.quaternion).multiplyScalar(fwdSpeed(w));emitTyreSpray(player,-1,vel,nf);emitTyreSpray(player,1,vel,nf);}}}
  const T1=performance.now();
  syncScene(w,simT,dt);
  updateSpray(dt,w.rain);updateRain(dt,camera.position,vel,w.rain);updateDebris(dt,w);
  MINI.t-=dt;if(MINI.t<=0&&MINI.visible!==false){MINI.t=0.066;drawMiniLive(w);}
  const T2=performance.now();
  if(MATS.road.userData.shader)MATS.road.userData.shader.uniforms.uTime.value=simT;
  updateProbe();
  if(lensPass){lensPass.uniforms.uTime.value=performance.now()/1000;lensPass.uniforms.uRes.value.set(cw,ch);}
  if(composer)composer.render();else renderer.render(scene,camera);
  {const sp=w.spray||0,v=Math.round((ui.cam==='cockpit'?sp:sp*0.5)*100)/100;if(v!==sprayFx.v){sprayFx.v=v;sprayFx.el.style.setProperty('--spray',v);}}
  if(ui.cam==='cockpit'&&((w.spray||0)>0.01||DROPS.length))drawDrops(dt,w);else{dropsCv.style.opacity=0;DROPS.length=0;}
  const T3=performance.now();
  drawHUD(w,simT,dt);
  rearGlow(rearFx.el,rearFx,running&&(w.opts.hud||w.opts.visor)?w.behind:null);
  const T4=performance.now();
  phoneFrame(w,simT,dt,now);
  const T5=performance.now();
  const PF=window.__perf||(window.__perf={sim:0,scene:0,gl:0,hud:0,phone:0,frame:0});const e=(k,v)=>PF[k]=PF[k]*0.95+v*0.05;
  e('sim',T1-T0);e('scene',T2-T1);e('gl',T3-T2);e('hud',T4-T3);e('phone',T5-T4);e('frame',dt*1000);
  // adaptive resolution: drop render scale when frames run long, recover when there is headroom
  PF.adapt=(PF.adapt||0)+dt;
  if(PF.adapt>2){PF.adapt=0;const pr=renderer.getPixelRatio(),cap=Math.min(window.devicePixelRatio||1,1.75);
    if(PF.frame>21&&pr>0.75){renderer.setPixelRatio(Math.max(0.75,pr-0.25));resize();}
    else if(PF.frame<15&&pr<cap){renderer.setPixelRatio(Math.min(cap,pr+0.25));resize();}}
  const o=w.opts;let va=0,vc=CAU;
  if(o.visor&&w.alert>0){if(w.alert===2){vc=DAN;va=RM?0.9:(0.35+0.65*((simT*6)%1<0.5?1:0));}else{va=0.55+(RM?0:0.12*Math.sin(simT*3));}}
  visorEl.style.setProperty('--vc',vc);visorEl.style.opacity=va.toFixed(3);
  if(w.alert===2&&lastAlert!==2&&running&&o.visor)beep();lastAlert=w.alert;
  flashEl.style.opacity=(w.done&&w.result&&(w.result.verdict==='contact'||w.result.verdict==='crash')&&running)?Math.min(1,shake*14).toFixed(2):'0';
  audioUpdate(w,running);
  statusT-=dt;if(statusT<=0){statusT=0.1;
    const P=w.player;let st;
    if(!running)st='Ready · press Start';else if(w.done)st='Run over';
    else if(o.driver==='drive')st=`${P.onWall?'On the wall! ':''}${w.touches?w.touches+' car touches · ':''}${w.scrapes?w.scrapes+' wall hits':'clean so far'}`;
    else {const a=w.hazards.find(h=>h.aware&&!h.passed);st=a?`Autopilot: ${a.src==='eyes'?'saw it, braking':a.src==='hud'?'warned by radar, slowing':'visor light, lifting'}`:'Autopilot: flat out';}
    statusEl.innerHTML=`<span><b>${SCN[w.sc.key].title}</b> · ${esc(TRACK_NAME)} · T ${w.t.toFixed(1)} s</span><span>${st}</span>`;}
}

/* ================= BOOT ================= */
new ResizeObserver(resize).observe(stage);resize();
new IntersectionObserver(es=>{MINI.visible=es[0].isIntersecting;}).observe($('miniMap'));
// everything below needs the track, which is built by the C++ core
PHYS.ready.then(()=>{
  if(!PHYS.ok){stage.insertAdjacentHTML('beforeend','<p class="noscript">The physics core (physics.wasm) did not load. Run npm run build:physics, then reload.</p>');return;}
  buildTrack(defaultLoop(),'Grand Prix circuit');physTrack();buildTrackMeshes();drawMini();
  $('rain').value=Math.round(ui.rain*100);syncControls();resetWorld();
  if(document.fonts&&document.fonts.ready)document.fonts.ready.then(()=>drawMini());
  requestAnimationFrame(frame);
  remoteInit();
});
window.__dbg={get src(){return SOURCE_ID;},get fc(){return FC;},get eng(){return eng;},get AC(){return AC;},get camera(){return camera;},worldPos,gameCamera,get cw(){return cw;},get ch(){return ch;},scene,renderer,sprayPts,PHYS,rainL,get tg(){return trackGroup;},hc,get world(){return world;},ui,REMOTE,kap:s=>sampleArr(KC,s),get streaks(){return STREAKS;},MATS,get pg(){return playerGLB;},get glb(){return CAR_GLB;}};
})();
