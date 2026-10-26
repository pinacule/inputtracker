import type { SkinEffects } from "../types.ts";
import { createCity } from "./city.ts";

const effects: SkinEffects = {
  mount(ctx) {
    const city = createCity();
    ctx.bg.append(city);
    return () => city.remove();
  },
};

export default effects;
