import type { SkinEffects } from "../types.ts";
import { mountLive } from "./live.ts";

/** The static foundation is also exercised independently of browser motion APIs. */
export const foundation: SkinEffects = {
  mount(ctx) {
    const root = document.documentElement;
    const connection = (globalThis.navigator as Navigator & { connection?: { saveData?: boolean } } | undefined)?.connection;
    if (connection?.saveData) root.dataset.rewindSaveData = "";
    ctx.bg.classList.add("rewind-room");
    ctx.fx.classList.add("rewind-screen");

    // Preload only the regular body and counter Latin faces.
    const preloads = ["ibm-plex-sans-latin", "share-tech-mono-latin"].map((font) => {
      const link = document.createElement("link");
      link.rel = "preload";
      link.as = "font";
      link.type = "font/woff2";
      link.crossOrigin = "anonymous";
      link.href = `/fonts/rewind/${font}.woff2`;
      document.head.append(link);
      return link;
    });
    return () => {
      delete root.dataset.rewindSaveData;
      ctx.bg.classList.remove("rewind-room");
      ctx.fx.classList.remove("rewind-screen");
      preloads.forEach((link) => link.remove());
    };
  },
};

const effects: SkinEffects = {
  mount(ctx) {
    const staticCleanup = foundation.mount(ctx);
    const liveCleanup = mountLive(ctx);
    return () => { liveCleanup(); staticCleanup(); };
  },
};
export default effects;
