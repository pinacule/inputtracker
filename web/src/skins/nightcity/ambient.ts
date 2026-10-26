import type { SkinContext } from '../types.ts';
import { overlaps } from './geometry.ts';

/** Six street loops plus the short page-arrival sign; rain has its own budget. */
export function mountAmbient(ctx: SkinContext) {
  let registrations: (()=>void)[]=[];
  let arrivalOff: (()=>void)|undefined;
  let arrivalTimer: ReturnType<typeof setTimeout>|undefined;
  const stopArrival=()=> { clearTimeout(arrivalTimer); arrivalOff?.(); arrivalOff=undefined; };
  const sprite=(kind:string,layer:HTMLElement,duration:number)=> {
    layer.classList.add('nc-ambient',`nc-ambient--${kind}`);
    layer.style.setProperty('--nc-steps',String(Math.floor(duration/1000*(ctx.isPhone?20:30))));
    layer.innerHTML= kind==='buzz' || kind==='ad' || kind==='online'
      ? '<span class="nc-sprite nc-ambient-sign">電脳</span>'
      : kind==='train' ? '<span class="nc-sprite nc-train">▮ ▮ ▮ ▮ ▮ ▮</span>'
      : kind==='drone' ? '<span class="nc-sprite nc-drone"><i></i><i></i></span>'
      : kind==='ripple' ? '<span class="nc-sprite nc-ripple"></span><span class="nc-sprite nc-ripple nc-ripple--second"></span>'
      : '<span class="nc-sprite nc-beacon"></span>';
    return duration;
  };
  const addLoops=()=> {
    registrations.forEach(off=>off()); registrations=[];
    const phone=ctx.isPhone;
    const effects=[
      {id:'buzz',min:24000,max:40000,duration:1400,w:phone?8:18,h:phone?32:64},
      {id:'drone',min:35000,max:60000,duration:3200,w:phone?96:160,h:12},
      {id:'train',min:45000,max:75000,duration:4000,w:phone?100:220,h:12},
      {id:'ripple',min:18000,max:32000,duration:1800,w:phone?36:64,h:phone?16:26},
      {id:'ad',min:40000,max:65000,duration:600,w:phone?8:18,h:phone?30:60},
      {id:'beacon',min:28000,max:48000,duration:2400,w:phone?8:12,h:phone?8:12},
    ];
    for(const effect of effects) registrations.push(ctx.ambient.add({
      id:`nc-${effect.id}`, minDelay:effect.min,maxDelay:effect.max,
      size:{width:effect.w,height:effect.h},prefer:'edges',margin:phone?12:20,maxConcurrent:phone?1:2,
      run:(_spot,layer)=>sprite(effect.id,layer,effect.duration),
    }));
  };
  const arrival=()=> {
    stopArrival();
    if(ctx.reducedMotion || document.hidden) return;
    arrivalOff=ctx.ambient.add({id:'nc-online',minDelay:420,maxDelay:420,maxConcurrent:ctx.isPhone?1:2,
      size:{width:ctx.isPhone?8:18,height:ctx.isPhone?32:58},prefer:'edges',margin:ctx.isPhone?12:20,
      run:(_spot,layer)=>sprite('online',layer,240)});
    // One attempt, through the same slot accounting as all other signs.
    arrivalTimer=setTimeout(stopArrival,670);
  };
  const offPage=ctx.on('page-change',arrival);
  const pause=()=> { stopArrival(); ctx.ambient.stop(); if(!ctx.reducedMotion&&!document.hidden) ctx.ambient.start(); };
  const offVisibility=ctx.onVisibility(pause),offMotion=ctx.onMotionChange(pause);
  // Revalidate the complete swept bounds whenever content/viewport geometry moves.
  // The scheduler validates again at launch; ongoing sprites disappear immediately.
  window.addEventListener('scroll',pause,{signal:ctx.signal,passive:true,capture:true});
  window.addEventListener('resize',()=>{pause();addLoops();},{signal:ctx.signal});
  const mutations=new MutationObserver(()=> {
    const obstacles=ctx.obstacles(),margin=ctx.isPhone?12:20;
    ctx.fx.querySelectorAll<HTMLElement>('.nc-ambient').forEach(node=> {
      const r=node.getBoundingClientRect();
      if(obstacles.some(o=>overlaps(r,o,margin))) node.style.visibility='hidden';
    });
  });
  const app=document.getElementById('app');
  if(app) mutations.observe(app,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:['open','hidden','class','style','aria-expanded']});
  addLoops(); ctx.ambient.start(); arrival();
  return ()=> {stopArrival();registrations.forEach(off=>off());ctx.ambient.stop();mutations.disconnect();offPage();offVisibility();offMotion();};
}
