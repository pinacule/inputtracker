import { useEffect, useRef, useState } from "preact/hooks";
import type { WorkArtImage } from "../../../src/core/contract";
import { getWorkArt } from "../api";
import { artworkAlt, featuredArtIndex, localArtImages, localArtListUrl, nextArtIndex } from "../lib/work-art";
import "../styles/work-art.css";

/** Only mounted on the work page; no network artwork during library listing. */
export function WorkArt({ url, title }: { url: string | null | undefined; title: string }) {
  const [images, setImages] = useState<WorkArtImage[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const listUrl = localArtListUrl(url);
  useEffect(() => {
    let cancelled = false;
    setImages([]);
    setSelected(null);
    setOpen(false);
    if (listUrl) void getWorkArt(listUrl).then((result) => {
      if (!cancelled) setImages(localArtImages(result.images, listUrl));
    }).catch(() => { /* Art is optional; hide an unavailable gallery. */ });
    return () => { cancelled = true; };
  }, [listUrl]);

  const selectedIndex = images.findIndex((image) => image.url === selected);
  const index = selectedIndex >= 0 ? selectedIndex : featuredArtIndex(images);
  const image = images[index];
  const failed = (url: string) => setImages((current) => current.filter((image) => image.url !== url));
  if (!image) return null;
  const navigate = (delta: number) => setSelected(images[nextArtIndex(index, images.length, delta)]!.url);

  return (
    <section class="work-art" aria-label={`Art for ${title}`}>
      {/* Faint full-page backdrop from the featured image; decorative only. */}
      <div class="work-art-backdrop" aria-hidden="true" style={{ backgroundImage: `url("${image.url}")` }} />
      <header class="work-art-header">
        <h2>Art</h2>
        <span>{images.length} {images.length === 1 ? "image" : "images"} · Select to explore</span>
      </header>
      <button type="button" class="work-art-feature" aria-label={`Open artwork for ${title} in full screen`} onClick={() => setOpen(true)}>
        <img key={image.url} src={image.url} alt={artworkAlt(title, image, index)} loading="lazy" decoding="async" onError={() => failed(image.url)} />
        <span class="work-art-expand" aria-hidden="true">View full screen ↗</span>
      </button>
      {images.length > 1 && (
        <div class="work-art-thumbnails" aria-label="Choose featured artwork">
          {images.map((thumb, n) => (
            <button type="button" key={thumb.url} class="work-art-thumbnail" aria-pressed={thumb.url === image.url} aria-label={`Feature ${artworkAlt(title, thumb, n)}`} onClick={() => setSelected(thumb.url)}>
              <img src={thumb.url} alt={artworkAlt(title, thumb, n)} loading="lazy" decoding="async" onError={() => failed(thumb.url)} />
            </button>
          ))}
        </div>
      )}
      {open && <ArtLightbox title={title} image={image} index={index} count={images.length} onClose={() => setOpen(false)} onNavigate={navigate} onError={() => failed(image.url)} />}
    </section>
  );
}

/** Native modal top layer makes the rest of the document inert, including the shell. */
function ArtLightbox({ title, image, index, count, onClose, onNavigate, onError }: {
  title: string; image: WorkArtImage; index: number; count: number;
  onClose: () => void; onNavigate: (delta: number) => void; onError: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const modal = dialog.current;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflow = document.body.style.overflow;
    modal?.showModal();
    close.current?.focus();
    document.body.style.overflow = "hidden";
    return () => {
      modal?.close();
      document.body.style.overflow = overflow;
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return (
    <dialog ref={dialog} class="work-art-lightbox" aria-label={`Art for ${title}`} aria-modal="true" onCancel={(event) => { event.preventDefault(); onClose(); }} onKeyDown={(event) => {
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault(); onNavigate(event.key === "ArrowLeft" ? -1 : 1);
      }
      if (event.key === "Tab") {
        const buttons = Array.from(dialog.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
        const first = buttons[0]; const last = buttons.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    }}>
      <header class="work-art-lightbox-header">
        <div><strong>{title}</strong><span aria-live="polite">{index + 1} / {count}</span></div>
        <button ref={close} type="button" onClick={onClose} aria-label="Close artwork">Close ×</button>
      </header>
      <div class="work-art-lightbox-image"><img key={image.url} src={image.url} alt={artworkAlt(title, image, index)} decoding="async" onError={onError} /></div>
      <footer>
        <button type="button" disabled={count < 2} onClick={() => onNavigate(-1)} aria-label="Previous artwork">← Previous</button>
        <span>Esc to close · ← → to explore</span>
        <button type="button" disabled={count < 2} onClick={() => onNavigate(1)} aria-label="Next artwork">Next →</button>
      </footer>
    </dialog>
  );
}
