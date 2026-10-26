import type { ThemeId } from "../lib/theme.ts";
import type { SkinEffects } from "./types.ts";

/** Literal dynamic imports keep every skin in a separate lazy Vite chunk. */
export const SKIN_EFFECTS: Partial<Record<ThemeId, () => Promise<{ default: SkinEffects }>>> = {
  nightcity: () => import("./nightcity/index.ts"),
  rewind: () => import("./rewind/index.ts"),
  thinker: () => import("./thinker/index.ts"),
};
