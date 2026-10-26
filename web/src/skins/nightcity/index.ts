import type { SkinEffects } from "../types.ts";
import { createCity } from "./city.ts";
import { mountRain } from './rain.ts';
import { mountMotion } from './motion.ts';
import { mountAmbient } from './ambient.ts';
import { mountCursor } from './cursor.ts';

const effects: SkinEffects = {
  mount(ctx) {
    const city = createCity();
    ctx.bg.append(city);
    const cleanups=[mountRain(ctx),mountMotion(ctx),mountAmbient(ctx),mountCursor(ctx)];
    return () => { cleanups.reverse().forEach(cleanup=>cleanup()); city.remove(); };
  },
};

export default effects;
