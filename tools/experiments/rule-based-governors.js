const G=require("../../engine.js");
const SEEDS=40, ROUNDS=120;
const TYPES={
  ai:{label:"Selfless AI", gov:()=>({type:"aligned_ai",goal:"welfare"})},
  human:{label:"Typical human", gov:()=>({type:"human_persona",goal:"welfare"})},
  selfish:{label:"Selfish human", gov:()=>({type:"human_persona",goal:"stay_in_power",traits:{greed:0.85,ambition:0.75,honesty:0.2,fairness:0.3}})},
};
const SAFE={strong:{charter:true,constitution:true,auditor:true,elections:true,freePress:true,termLimits:true},
            none:{charter:false,constitution:false,auditor:false,elections:false,freePress:false,termLimits:false}};
const EV=["bribe_accepted","bribe_rejected","bribe_reported","skim","misreport","power_grab","surveillance","protest_suppressed","safeguard_dismantled","refused_to_leave","coup","collapse"];
const out=[];
for(const t in TYPES) for(const s in SAFE) for(const p of ["calm","crisis"]){
  const acc={n:0,corruption:0,welfare:0,trust:0,lies:0,power:0,alive:0,anyBribe:0,anyAbuse:0}; EV.forEach(e=>acc[e]=0);
  for(let seed=1;seed<=SEEDS;seed++){
    const cfg={seed,maxRounds:ROUNDS,world:{escalation:false,randomShocks:p==="crisis",scarcityShockRound:p==="crisis"?15:null},
      nations:["n1","n2","n3"].map(id=>({id,system:"free_market",governor:TYPES[t].gov(),safeguards:{...SAFE[s]}}))};
    const w=G.createWorld(cfg);
    for(let r=0;r<ROUNDS;r++){ if(p==="crisis"&&r>0&&r%30===0){w.injectShock("scarcity");} const res=w.step(); if(res.status==="over")break; }
    for(const n of w.state.nations){
      acc.n++; const h=n.history; const mean=a=>a&&a.length?a.reduce((x,y)=>x+y,0)/a.length:0;
      acc.corruption+=mean(h.corruption); acc.welfare+=mean(h.welfare); acc.trust+=mean(h.trust); acc.lies+=mean(h.honestyGap); acc.power+=mean(h.powerIndex); acc.alive+=n.alive?1:0;
      const evs=w.state.events.filter(e=>e.nationId===n.id); const c={}; EV.forEach(e=>c[e]=0);
      // events capped at 500 in state; count via listener instead
    }
    acc._worlds=(acc._worlds||0)+1;
  }
  out.push({t,s,p,acc});
}
// second pass with listeners for exact event counts
for(const row of out){
  const {t,s,p}=row; const c={}; EV.forEach(e=>c[e]=0); let nat=0, anyBribe=0, anyAbuse=0, firstAbuse=[];
  for(let seed=1;seed<=SEEDS;seed++){
    const cfg={seed,maxRounds:ROUNDS,world:{escalation:false,randomShocks:p==="crisis",scarcityShockRound:p==="crisis"?15:null},
      nations:["n1","n2","n3"].map(id=>({id,system:"free_market",governor:TYPES[t].gov(),safeguards:{...SAFE[s]}}))};
    const w=G.createWorld(cfg); const per={n1:{},n2:{},n3:{}};
    w.on(e=>{ if(e.nationId&&per[e.nationId]&&EV.includes(e.type)){ c[e.type]++; per[e.nationId][e.type]=(per[e.nationId][e.type]||0)+1; if(["misreport","power_grab","surveillance","protest_suppressed","safeguard_dismantled","skim","bribe_accepted"].includes(e.type)&&per[e.nationId]._first==null) per[e.nationId]._first=e.round; }});
    for(let r=0;r<ROUNDS;r++){ if(p==="crisis"&&r>0&&r%30===0){w.injectShock("scarcity");} const res=w.step(); if(res.status==="over")break; }
    for(const id in per){ nat++; if(per[id].bribe_accepted||per[id].skim) anyBribe++; if(per[id].misreport||per[id].power_grab||per[id].surveillance||per[id].protest_suppressed||per[id].safeguard_dismantled) anyAbuse++; if(per[id]._first!=null) firstAbuse.push(per[id]._first); }
  }
  row.c=c; row.nat=nat; row.anyBribe=anyBribe; row.anyAbuse=anyAbuse; row.first=firstAbuse.length?(firstAbuse.sort((a,b)=>a-b)[Math.floor(firstAbuse.length/2)]):null;
}
const f=(x,d=1)=>x.toFixed(d);
console.log("type | safeguards | pressure | corruption | wellbeing | trust | lies | power | bribes taken/run | bribes refused+reported/run | stole/run | lied/run | powergrab+spy+crackdown+rules/run | % runs took money | % runs abused power | median first misdeed round | alive%");
const res=[];
for(const r of out){const a=r.acc,n=a.n,c=r.c,N=r.nat;
  const o={type:TYPES[r.t].label,safeguards:r.s,pressure:r.p,corruption:+f(a.corruption/n),wellbeing:+f(a.welfare/n),trust:+f(a.trust/n),lies:+f(a.lies/n),power:+f(a.power/n),
   bribesTaken:+f(c.bribe_accepted/N,2),bribesRefused:+f((c.bribe_rejected+c.bribe_reported)/N,2),stole:+f(c.skim/N,2),lied:+f(c.misreport/N,2),
   abuse:+f((c.power_grab+c.surveillance+c.protest_suppressed+c.safeguard_dismantled)/N,2),pctMoney:Math.round(100*r.anyBribe/N),pctAbuse:Math.round(100*r.anyAbuse/N),firstMisdeed:r.first,alivePct:Math.round(100*a.alive/n),runs:N};
  res.push(o); console.log(Object.values(o).join(" | "));}
require("fs").writeFileSync(require("path").join(__dirname,"../../docs/results/rule-based-governors.json"),JSON.stringify({seeds:SEEDS,rounds:ROUNDS,system:"free_market",nationsPerWorld:3,results:res},null,1));
