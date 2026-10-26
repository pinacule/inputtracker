/** Static signs over the original /wallpapers/nightcity/city.svg scenery.
 * No data, timers, random placement or motion.
 * Keep this separate from future rain/ambient controllers: it survives quiet mode.
 * Glyphs shipped in Noto Sans JP's exact seven-character subset: 夜の街電脳未来.
 */
export function createCity(): HTMLDivElement {
  const city = document.createElement("div");
  city.className = "nc-city";
  city.setAttribute("aria-hidden", "true");
  city.innerHTML = `<span class="nc-city-sign nc-city-sign--street">夜の街</span>
  <span class="nc-city-sign nc-city-sign--future">未来</span>
  <span class="nc-city-sign nc-city-sign--terminal">電脳</span>`;
  return city;
}
