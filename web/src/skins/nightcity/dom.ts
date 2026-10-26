export const cards = '.home-topbar,.home-category-index,.home-day-overview,.home-day-entries,.home-week-card,.home-rhythm-card,.ui-card,.library-work-card,.library-work-list-row,.review-poster,.theme-tile';
export const controls = 'a,button,input,textarea,select,label,summary,[role="button"],[role="tab"],[contenteditable],:focus-visible';
export const visible = (r: DOMRect) => r.width > 2 && r.height > 2 && r.bottom > 0
  && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
/** Glyph bounds (not broad parent boxes), plus whole control and focus bounds. */
export function protectedRects(root: Element): DOMRect[] {
  const rects = [...root.querySelectorAll(controls)].map(el => el.getBoundingClientRect());
  if (root.matches(controls)) rects.push(root.getBoundingClientRect());
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (!node.textContent?.trim() || node.parentElement?.closest('script,style,svg title,svg desc')) continue;
    range.selectNodeContents(node);
    rects.push(...range.getClientRects());
  }
  return rects.filter(visible);
}
export function svgElement(markup: string, rect: DOMRect, className: string): SVGSVGElement {
  const node = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  node.setAttribute('width', String(rect.width));
  node.setAttribute('height', String(rect.height));
  node.setAttribute('viewBox', `0 0 ${rect.width} ${rect.height}`);
  node.setAttribute('aria-hidden', 'true');
  node.classList.add(className);
  Object.assign(node.style, { position: 'absolute', left: `${rect.left}px`, top: `${rect.top}px`, pointerEvents: 'none' });
  node.innerHTML = markup;
  return node;
}
let maskId = 0;
export function safeMask(rect: DOMRect, protectedBounds: DOMRect[], frameOnly = false) {
  const id = `nc-mask-${++maskId}`;
  const { width: w, height: h } = rect;
  const white = frameOnly
    ? `<path d="M1 1H${w-1}V${h-1}H1Z" fill="none" stroke="white" stroke-width="2"/>`
    : `<rect width="${w}" height="${h}" fill="white"/>`;
  const holes = protectedBounds.map(r => `<rect x="${r.left-rect.left-8}" y="${r.top-rect.top-8}" width="${r.width+16}" height="${r.height+16}" fill="black"/>`).join('');
  return { id, markup: `<defs><mask id="${id}" maskUnits="userSpaceOnUse" maskContentUnits="userSpaceOnUse" x="0" y="0" width="${w}" height="${h}" style="mask-type:luminance">${white}${holes}</mask></defs>` };
}
