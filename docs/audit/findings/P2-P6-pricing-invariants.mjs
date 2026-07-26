const P = await import('/home/user/Polymarket-Mint-Bot/hypersignal-mcp/dist/polymarket/pricing.js');
const fail=[];const ok=(c,m)=>{if(!c)fail.push(m)};

// 1) normCdf vs reference values (differential vs known-good table)
const REF=[[-3,0.001349898],[-2,0.022750132],[-1,0.158655254],[0,0.5],[1,0.841344746],[2,0.977249868],[3,0.998650102],[1.96,0.975002105]];
let maxErr=0;
for(const [x,e] of REF){const g=P.normCdf(x);maxErr=Math.max(maxErr,Math.abs(g-e));}
console.log('normCdf max abs error vs reference:', maxErr.toExponential(3));
ok(maxErr<1e-6,`normCdf error ${maxErr}`);

// 2) above + below == 1  (complementary events)
for(const s of [0.3,1.0]) for(const t of [0.1,1]) for(const k of [0.8,1,1.3]){
  const a=P.probAboveAtExpiry(100,100*k,t,s), b=P.probBelowAtExpiry(100,100*k,t,s);
  ok(Math.abs(a+b-1)<1e-9, `above+below != 1 at k=${k} s=${s} t=${t}: ${a+b}`);
}

// 3) MONOTONICITY: higher threshold => lower P(above). Never increases.
for(const s of [0.2,0.6,1.5]) for(const t of [0.05,0.5,2]){
  let prev=Infinity;
  for(let k=0.5;k<=3;k+=0.1){
    const p=P.probAboveAtExpiry(100,100*k,t,s);
    ok(p<=prev+1e-12,`P(above) increased with K at s=${s} t=${t} k=${k.toFixed(1)}: ${p} > ${prev}`);
    prev=p;
  }
}

// 4) SCALE INVARIANCE (metamorphic): probability depends on S/K ratio, not units.
for(const s of [0.4,1.1]) for(const t of [0.2,1]){
  const base=P.probAboveAtExpiry(100,120,t,s);
  for(const m of [1e-3,1e3,1e6]){
    const scaled=P.probAboveAtExpiry(100*m,120*m,t,s);
    ok(Math.abs(base-scaled)<1e-9,`not scale-invariant x${m}: ${base} vs ${scaled}`);
  }
}

// 5) hostile inputs must not produce NaN / out-of-range probability
const HOSTILE=[0,-1,NaN,Infinity,-Infinity,Number.MAX_SAFE_INTEGER,1e-300];
let bad=0;
for(const S of HOSTILE) for(const K of HOSTILE) for(const t of HOSTILE) for(const sg of HOSTILE){
  for(const mode of ['above','below','touch','touch_below']){
    const p=P.impliedProbForMode(mode,S,K,t,sg,0);
    if(!Number.isFinite(p)||p<0||p>1){bad++; if(bad<=6)console.log('  BAD:',mode,{S,K,t,sg},'=>',p);}
  }
}
console.log('hostile-input combos producing NaN/out-of-range probability:', bad, '/', 7**4*4);

console.log('');
console.log(fail.length?('ПРОВАЛЫ: '+fail.length):'все инварианты 1-4 держатся');
fail.slice(0,10).forEach(f=>console.log('  -',f));
