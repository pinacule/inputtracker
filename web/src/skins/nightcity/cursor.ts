import type { SkinContext } from '../types.ts';
import { overlaps } from './geometry.ts';

export function mountCursor(ctx: SkinContext) {
  const dot=document.createElement('i');
  dot.className='nc-cursor-heel'; dot.hidden=true;
  ctx.fx.append(dot);
  let timer:ReturnType<typeof setTimeout>|undefined;
  let last=0;
  const hide=()=> {clearTimeout(timer);dot.hidden=true;};
  window.addEventListener('pointermove',event=> {
    if(performance.now()-last<34) return;
    last=performance.now(); hide();
    if(!ctx.finePointer || !matchMedia('(hover: hover)').matches || ctx.reducedMotion || document.hidden
      || event.pointerType==='touch' || event.buttons || !getSelection()?.isCollapsed
      || (event.target instanceof Element && event.target.closest('input,textarea,[contenteditable]'))) return;
    const x=event.clientX+9,y=event.clientY+9;
    if(ctx.obstacles().some(r=>overlaps({left:x,top:y,right:x+6,bottom:y+6},r,2))) return;
    dot.style.left=`${x}px`;dot.style.top=`${y}px`;dot.hidden=false;
    timer=setTimeout(hide,100);
  },{signal:ctx.signal,passive:true});
  window.addEventListener('pointerout',hide,{signal:ctx.signal});
  window.addEventListener('scroll',hide,{signal:ctx.signal,passive:true,capture:true});
  const offVisibility=ctx.onVisibility(hide),offMotion=ctx.onMotionChange(hide);
  return ()=>{hide();dot.remove();offVisibility();offMotion();};
}
