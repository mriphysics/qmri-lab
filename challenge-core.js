(()=>{
  'use strict';

  const VERSION='QMR1';
  const W=64,H=64,PHASE_LINES=64,PRECISION_LIMIT=10,NOISE_SD=.02;

  const clamp=(value,low,high)=>Math.max(low,Math.min(high,value));

  function scanSeconds(plan){
    return plan.reduce((sum,m)=>sum+Math.max(0,+m.tr||0),0)*PHASE_LINES/1000;
  }

  function timingProblem(m){
    if(m.te<5||m.te>500)return'TE must be between 5 and 500 ms, inclusive.';
    if(m.tr>10000)return'TR must be no greater than 10,000 ms.';
    if(m.tr<m.te)return'TR must be at least as long as TE.';
    if(m.sequence==='ir'&&m.ti<0)return'TI must be zero or greater.';
    if(m.sequence==='ir'&&m.ti>m.tr-m.te)return'TI must be no greater than TR − TE.';
    return'';
  }

  function validateProtocol(plan,mode){
    const cannotConstrain=`Protocol cannot constrain ${mode.toUpperCase()}`;
    const invalidIndex=plan.findIndex(m=>timingProblem(m));
    if(invalidIndex>=0)return{ok:false,invalid:true,title:'Invalid protocol',message:`Image ${invalidIndex+1}: ${timingProblem(plan[invalidIndex])}`};
    const seqs=new Set(plan.map(m=>m.sequence));
    const mixed=seqs.size>1;
    const recovery=new Set(plan.map(m=>m.sequence==='ir'?`ir-${Math.round(m.ti)}-${Math.round(m.tr)}`:`se-${Math.round(m.tr)}`));
    const echoes=new Set(plan.map(m=>Math.round(m.te)));
    const targetVaries=mode==='t1'?recovery.size>=2:echoes.size>=2;
    if(mixed&&plan.length<3)return{ok:false,title:cannotConstrain,message:'A mixed spin-echo and inversion-recovery protocol needs at least three images.'};
    if(!mixed&&plan.length<2)return{ok:false,title:cannotConstrain,message:'A single sequence type needs at least two images with informative parameter choices.'};
    if(!targetVaries)return{ok:false,title:cannotConstrain,message:mode==='t1'?'The recovery weighting is unchanged. For spin echo, vary TR; for inversion recovery, vary TI or TR.':'The echo time is unchanged. Vary TE to create T2 sensitivity.'};
    if(!mixed&&plan.length===2){
      if(mode==='t1'&&echoes.size>1)return{ok:false,title:cannotConstrain,message:'With only two images for T1, keep TE fixed and vary TR (spin echo) or TI (inversion recovery).'};
      if(mode==='t2'&&recovery.size>1)return{ok:false,title:cannotConstrain,message:'With only two images for T2, keep the recovery settings fixed so T1 weighting is absorbed into the shared scale.'};
    }
    return{ok:true,title:'',message:''};
  }

  function buildSyntheticPhantom(){
    const t1=new Float32Array(W*H),t2=new Float32Array(W*H),rho=new Float32Array(W*H);
    const t1Values=[1300,800,800,400,2100],t2Values=[80,75,100,60,1500],rhoValues=[1.2,.7,1,.9,1];
    const groups=Array.from({length:5},()=>[]);
    for(let s=0;s<5;s++){
      const cx=.17+.66*s/4,cy=s%2===0?.7:.3;
      for(let y=0;y<H;y++)for(let x=0;x<W;x++){
        const dx=x/(W-1)-cx,dy=y/(H-1)-cy;
        if(Math.hypot(dx,dy)<.13){
          const i=y*W+x;
          t1[i]=t1Values[s];t2[i]=t2Values[s];rho[i]=rhoValues[s];groups[s].push(i);
        }
      }
    }
    return{t1,t2,rho,groups};
  }

  function sequenceSignal(m,t1,t2,rho){
    const recovery=m.sequence==='ir'?1-2*Math.exp(-m.ti/t1)+Math.exp(-m.tr/t1):1-Math.exp(-m.tr/t1);
    return Math.abs(rho*recovery*Math.exp(-m.te/t2));
  }

  function hashString(text){
    let hash=2166136261;
    for(let i=0;i<text.length;i++){
      hash^=text.charCodeAt(i);
      hash=Math.imul(hash,16777619);
    }
    hash+=hash<<13;hash^=hash>>>7;hash+=hash<<3;hash^=hash>>>17;hash+=hash<<5;
    return hash>>>0;
  }

  function randomFactory(seed){
    let value=seed>>>0;
    return()=>{
      value=(value+0x6d2b79f5)>>>0;
      let t=value;
      t=Math.imul(t^t>>>15,t|1);
      t^=t+Math.imul(t^t>>>7,t|61);
      return((t^t>>>14)>>>0)/4294967296;
    };
  }

  function gaussianFactory(seed){
    const random=randomFactory(seed);
    let spare=null;
    return()=>{
      if(spare!==null){const value=spare;spare=null;return value;}
      let u=0,v=0;
      while(!u)u=random();
      while(!v)v=random();
      const magnitude=Math.sqrt(-2*Math.log(u)),angle=2*Math.PI*v;
      spare=magnitude*Math.sin(angle);
      return magnitude*Math.cos(angle);
    };
  }

  function measurementKey(m){
    return`${m.sequence}|${m.sequence==='ir'?+m.ti:0}|${+m.tr}|${+m.te}`;
  }

  function simulateProtocol(plan,mode,phantom){
    const occurrences=new Map();
    return plan.map(m=>{
      const key=measurementKey(m),occurrence=occurrences.get(key)||0;
      occurrences.set(key,occurrence+1);
      const randn=gaussianFactory(hashString(`${VERSION}|${mode}|${key}|${occurrence}`));
      const out=new Float32Array(W*H);
      for(let i=0;i<W*H;i++){
        const clean=phantom.t1[i]&&phantom.t2[i]?sequenceSignal(m,phantom.t1[i],phantom.t2[i],phantom.rho[i]):0;
        out[i]=clean+randn()*NOISE_SD;
      }
      return out;
    });
  }

  function fitJoint(plan,ys){
    let best={err:Infinity,t1:120,t2:10,rho:0,pred:[]};
    const search=(a1,b1,n1,a2,b2,n2)=>{
      for(let i=0;i<n1;i++){
        const t1=a1+(b1-a1)*i/Math.max(1,n1-1);
        for(let j=0;j<n2;j++){
          const t2=a2+(b2-a2)*j/Math.max(1,n2-1),f=plan.map(m=>sequenceSignal(m,t1,t2,1));
          let num=0,den=0;
          for(let k=0;k<f.length;k++){num+=ys[k]*f[k];den+=f[k]*f[k];}
          const rho=num/(den||1);
          let err=0;
          for(let k=0;k<f.length;k++)err+=(ys[k]-rho*f[k])**2;
          if(err<best.err)best={err,t1,t2,rho,pred:f.map(v=>v*rho)};
        }
      }
    };
    search(120,3500,55,10,2500,75);
    search(clamp(best.t1-120,120,3500),clamp(best.t1+120,120,3500),13,clamp(best.t2-100,10,2500),clamp(best.t2+100,10,2500),21);
    best.rmse=Math.sqrt(best.err/ys.length);
    return best;
  }

  function analyseProtocol(plan,mode,phantom=buildSyntheticPhantom()){
    const validation=validateProtocol(plan,mode),seconds=scanSeconds(plan);
    if(!validation.ok)return{validation,seconds,images:[],rows:[],worst:Infinity,qualifies:false};
    const images=simulateProtocol(plan,mode,phantom),field=mode;
    const rows=phantom.groups.map(indices=>{
      const voxelFits=indices.map(index=>fitJoint(plan,images.map(image=>image[index]))[field]);
      const mean=voxelFits.reduce((sum,value)=>sum+value,0)/voxelFits.length;
      const sd=Math.sqrt(voxelFits.reduce((sum,value)=>sum+(value-mean)**2,0)/(voxelFits.length-1));
      const cv=sd/mean*100;
      const truth=indices.reduce((sum,index)=>sum+phantom[field][index],0)/indices.length;
      const error=(mean-truth)/truth*100;
      const meanSignals=images.map(image=>indices.reduce((sum,index)=>sum+image[index],0)/indices.length);
      const meanFit=fitJoint(plan,meanSignals),signalMean=meanSignals.reduce((a,b)=>a+b,0)/meanSignals.length;
      return{mean,cv,truth,error,nrmse:meanFit.rmse/(signalMean||1)*100,voxelFits};
    });
    const worst=Math.max(...rows.map(row=>row.cv));
    return{validation,seconds,images,rows,worst,qualifies:worst<PRECISION_LIMIT};
  }

  function normaliseMeasurement(m){
    return{sequence:m.sequence==='ir'?'ir':'se',ti:m.sequence==='ir'?+m.ti:0,tr:+m.tr,te:+m.te};
  }

  function canonicalPlan(plan){
    return plan.map(normaliseMeasurement).sort((a,b)=>a.sequence.localeCompare(b.sequence)||a.ti-b.ti||a.tr-b.tr||a.te-b.te);
  }

  function compactPlan(plan){
    return canonicalPlan(plan).map(m=>[m.sequence==='ir'?1:0,m.ti,m.tr,m.te]);
  }

  function expandPlan(rows){
    if(!Array.isArray(rows)||rows.length<2||rows.length>12)throw new Error('Protocol row count is invalid.');
    return rows.map(row=>{
      if(!Array.isArray(row)||row.length!==4)throw new Error('Protocol row is invalid.');
      const m={sequence:row[0]===1?'ir':'se',ti:+row[1],tr:+row[2],te:+row[3]};
      if(![m.ti,m.tr,m.te].every(Number.isFinite))throw new Error('Protocol contains a non-numeric value.');
      return m;
    });
  }

  function encodeBase64Url(text){
    const bytes=new TextEncoder().encode(text);
    let binary='';
    for(const byte of bytes)binary+=String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  }

  function decodeBase64Url(value){
    const padded=value.replace(/-/g,'+').replace(/_/g,'/')+'='.repeat((4-value.length%4)%4);
    const binary=atob(padded),bytes=Uint8Array.from(binary,char=>char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }

  async function digestTag(text){
    if(!globalThis.crypto?.subtle)throw new Error('Secure browser hashing is unavailable.');
    const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)));
    return[...digest.slice(0,16)].map(byte=>byte.toString(16).padStart(2,'0')).join('');
  }

  async function createSubmissionCode(plans){
    const t1=canonicalPlan(plans.t1),t2=canonicalPlan(plans.t2),phantom=buildSyntheticPhantom();
    const a1=analyseProtocol(t1,'t1',phantom),a2=analyseProtocol(t2,'t2',phantom);
    if(!a1.qualifies||!a2.qualifies)throw new Error('Both protocols must qualify before a submission code can be generated.');
    const payload={v:VERSION,p:{t1:compactPlan(t1),t2:compactPlan(t2)},r:{q:true,t:[a1.seconds,a2.seconds],w:[+a1.worst.toFixed(6),+a2.worst.toFixed(6)]}};
    const encoded=encodeBase64Url(JSON.stringify(payload)),tag=await digestTag(encoded);
    return{code:`${VERSION}.${encoded}.${tag}`,payload,analyses:{t1:a1,t2:a2}};
  }

  async function verifySubmissionCode(code){
    const parts=String(code||'').trim().split('.');
    if(parts.length!==3||parts[0]!==VERSION)throw new Error('This is not a supported qMRI submission code.');
    const expected=await digestTag(parts[1]);
    if(expected!==parts[2].toLowerCase())throw new Error('The code checksum is invalid. It may be incomplete or altered.');
    let payload;
    try{payload=JSON.parse(decodeBase64Url(parts[1]));}catch{throw new Error('The submission data could not be decoded.');}
    if(payload.v!==VERSION||!payload.p||!payload.r)throw new Error('The submission format is incomplete.');
    const plans={t1:expandPlan(payload.p.t1),t2:expandPlan(payload.p.t2)},phantom=buildSyntheticPhantom();
    for(const mode of ['t1','t2']){
      const problem=plans[mode].map(timingProblem).find(Boolean);
      if(problem)throw new Error(`${mode.toUpperCase()} protocol is invalid: ${problem}`);
    }
    const analyses={t1:analyseProtocol(plans.t1,'t1',phantom),t2:analyseProtocol(plans.t2,'t2',phantom)};
    const claimedTimes=payload.r.t||[],claimedWorst=payload.r.w||[];
    const resultMatches=payload.r.q===true&&Math.abs(claimedTimes[0]-analyses.t1.seconds)<.001&&Math.abs(claimedTimes[1]-analyses.t2.seconds)<.001&&Math.abs(claimedWorst[0]-analyses.t1.worst)<.01&&Math.abs(claimedWorst[1]-analyses.t2.worst)<.01;
    const qualifies=analyses.t1.qualifies&&analyses.t2.qualifies;
    return{valid:resultMatches&&qualifies,checksumValid:true,resultMatches,qualifies,payload,plans,analyses,totalSeconds:analyses.t1.seconds+analyses.t2.seconds};
  }

  window.QMRIChallenge={VERSION,W,H,PHASE_LINES,PRECISION_LIMIT,NOISE_SD,scanSeconds,timingProblem,validateProtocol,buildSyntheticPhantom,sequenceSignal,simulateProtocol,fitJoint,analyseProtocol,canonicalPlan,createSubmissionCode,verifySubmissionCode};
})();
