/** Inert, request-free presentation copy. No IDs, ARIA, handlers or interactive tags survive. */
export function presentationCopy(source: HTMLElement): HTMLElement {
  const copy = document.createElement("div");
  const style = getComputedStyle(source);
  // Freeze computed presentation so contextual grid/container selectors cannot reflow a copy.
  const properties = ["display", "box-sizing", "width", "height", "min-width", "max-width", "min-height", "max-height",
    "padding", "margin", "border", "border-radius", "background-color", "color", "font-family", "font-size", "font-weight",
    "font-style", "line-height", "letter-spacing", "font-variant-numeric", "text-align", "text-transform", "white-space",
    "overflow", "overflow-wrap", "position", "top", "left", "right", "bottom", "transform", "opacity", "visibility",
    "flex-direction", "flex-wrap", "flex-grow", "flex-shrink", "flex-basis", "align-items", "align-self", "justify-content",
    "gap", "grid-template-columns", "grid-template-rows", "grid-column", "grid-row", "box-shadow"];
  for (const property of properties) {
    const value = style.getPropertyValue(property);
    if (!/url\(/i.test(value) && property !== "content") copy.style.setProperty(property, value);
  }
  copy.style.animation = "none";
  copy.style.transition = "none";
  copy.style.pointerEvents = "none";
  const excluded = source.matches('img,picture,svg,canvas,video,audio,iframe,object,script,style,input,textarea,select,[contenteditable],.ui-cover,.home-work-thumb,.home-time,.ui-stat-value,.home-rhythm-readout,.home-map-tip,.ui-tooltip,.ui-icon-btn,.ui-btn,a:not(.home-map-cell)');
  if (excluded) {
    copy.style.visibility = "hidden";
    return copy;
  }
  for (const child of source.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) copy.append(document.createTextNode(child.textContent ?? ""));
    else if (child instanceof HTMLElement) copy.append(presentationCopy(child));
  }
  return copy;
}
