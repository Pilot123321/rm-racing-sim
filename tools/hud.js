// Builds the phone's HUD bundle: every /*HUD>*/ ... /*<HUD*/ block of public/js/game.js wrapped in window.makeHUD, so
// the phone draws with the game's own code. server.js serves it live as /hud.js; for the Vercel site it is written
// to public/hud.js at build time:  node tools/hud.js public/hud.js
const fs = require('fs');
const path = require('path');

function buildHud() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'game.js'), 'utf8');
  const parts = [...src.matchAll(/\/\*HUD>\*\/([\s\S]*?)\/\*<HUD\*\//g)].map(m => m[1]);
  return `window.makeHUD=function(){
let N=1,L=1,DS=1,PX,PZ,TX,TZ,H,SL,LATRL=null,VPROF=null,WGL=null,WGR=null,CORNERS=[],world=null,cw=800,ch=400;
const HW=6,WALL=16,RANGE=700,TAU=Math.PI*2;let RM=false;
const clamp=(x,a,b)=>x<a?a:x>b?b:x, lerp=(a,b,t)=>a+(b-a)*t;
const angd=(a,b)=>{let d=a-b;while(d>Math.PI)d-=TAU;while(d<-Math.PI)d+=TAU;return d;};
${parts.join('\n')}
return {setCalm(v){RM=!!v;},drawNav,NAV,dSigned,wrapS,drawTracker,drawFlagChip,drawScreen,
  setSize(w,h){cw=w;ch=h;},
  setTrack(t){N=t.N;L=t.L;DS=t.DS;PX=Float64Array.from(t.PX);PZ=Float64Array.from(t.PZ);TX=Float64Array.from(t.TX);TZ=Float64Array.from(t.TZ);H=Float64Array.from(t.H);SL=Float64Array.from(t.SL);LATRL=t.LAT?Float64Array.from(t.LAT):null;VPROF=t.VP?Float64Array.from(t.VP):null;CORNERS=t.C;},
  setWorld(w){world=w;}, ready(){return !!PX;}};
};`;
}

if (require.main === module) fs.writeFileSync(process.argv[2] || 'public/hud.js', buildHud());
module.exports = buildHud;
