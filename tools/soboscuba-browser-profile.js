(function(){
 'use strict';
 const $=id=>document.getElementById(id),canvas=$('canvas'),R=new SB.Renderer(canvas),style={...SB.STYLES[0]};
 style.uiColors=Object.fromEntries(SB.UI_KEYS.map((k,i)=>[k,style.ui[i]]));
 R.resize(390,600,Math.min(2,devicePixelRatio),[0,0,0,0],'mobile');
 let mode,first,last,acc=0,elapsed=0,steps=0,status='idle',scene,rafs=[],costs=[],renders=[],stepCosts=[],recoveries=[],dropped=0,seed=1,shots=0,merges=0;
 const round=x=>+x.toFixed(4),rnd=()=>((seed=seed*16807%2147483647)/2147483647);
 function stats(a){const s=a.slice().sort((a,b)=>a-b);return{n:s.length,mean:round(s.reduce((a,b)=>a+b,0)/Math.max(1,s.length)),p50:round(s[Math.floor(s.length*.5)]||0),p95:round(s[Math.floor(s.length*.95)]||0),p99:round(s[Math.floor(s.length*.99)]||0),max:round(s.at(-1)||0)};}
 function publish(){const report={status,scene,sourceHash:ENGINE_HASH,wallSeconds:round(elapsed),simulationSeconds:round(steps/60),steps,shots,merges,bodies:mode?.world.sobos.length,subas:mode?.world.count,droppedSeconds:round(dropped),rafMs:stats(rafs),physicsFrameMs:stats(costs),physicsStepMs:stats(stepCosts),renderMs:stats(renders),recoveries:recoveries.length,visibility:document.visibilityState};$('stats').textContent=JSON.stringify(report,null,2);$('status').textContent=status+' '+elapsed.toFixed(1)+'s';if(status!=='running')$('raw').value=JSON.stringify({...report,rafIntervals:rafs,physicsStepTimes:stepCosts,recoveryTimeline:recoveries,hostThrottling:rafs.some(x=>x>500)},null,2);}
 function frame(t){if(status!=='running')return;if(document.hidden){status='interrupted-hidden';$('start').disabled=false;publish();return;}if(first===null)first=t;const raw=last===null?0:t-last;last=t;elapsed=(t-first)/1000;if(raw){rafs.push(raw);acc+=Math.min(.1,raw/1000);if(raw>100)dropped+=raw/1000-.1;}
  const begin=performance.now();let count=0;
  while(acc>=1/60&&count<4){
   if(scene==='shots'&&steps%40===0&&mode.selectable.length){const s=mode.selectable[Math.floor(rnd()*mode.selectable.length)],a=(rnd()-.5)*1.5+(shots%6===5?Math.PI:0);mode.pointerDown(s.cx,s.cy,'mouse');mode.pointerMove(s.cx+Math.sin(a)*160,s.cy+Math.cos(a)*160,'mouse');mode.pointerUp();shots++;}
   const st=performance.now();if(scene==='shots')mode.tick();else mode.world.step();stepCosts.push(performance.now()-st);steps++;count++;acc-=1/60;
   if(mode.world.recoveries.length)recoveries.push({time:round(steps/60),active:mode.world.recoveries.length});
  }
  if(count===4){dropped+=acc;acc=0;}costs.push(performance.now()-begin);
  const draw=performance.now();mode.frame(Math.min(.1,raw/1000));R.update(Math.min(.1,raw/1000),false);R.draw(mode,style,{dt:Math.min(.1,raw/1000),device:'mouse',inGame:true,menuIcon:false,hidePanels:false,instructions:false,sideTitle:'soboscuba'});renders.push(performance.now()-draw);
  if(elapsed>=30){status='complete';$('start').disabled=false;publish();return;}if(rafs.length%30===0)publish();requestAnimationFrame(frame);
 }
 $('start').onclick=()=>{seed=1;shots=0;merges=0;scene=$('scene').value;mode=new SB.Classic('mobile',{merge:()=>merges++});if(scene!=='shots'){const n=scene==='pile60'?60:40;for(let k=0;k<n;k++){const s=mode.world.add(new SB.Sobo(Math.floor(rnd()*5),-150+rnd()*300,-250+(k%8)*60));s.setVelocity((rnd()-.5)*400,0);mode.stack.push(s);}}
  R.fit(mode);R.snap();first=null;last=null;acc=0;elapsed=0;steps=0;dropped=0;rafs=[];costs=[];renders=[];stepCosts=[];recoveries=[];status='running';$('raw').value='';$('start').disabled=true;publish();requestAnimationFrame(frame);
 };
})();
