import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

// Full-screen image lightbox for chat. Telegram-style:
// - Tap any image in a thread → opens here with all thread images
//   collected so the user can swipe left/right to navigate.
// - Tap to dismiss; swipe down also dismisses; ESC on desktop.
// - Each image fits the viewport (object-contain) — no awkward
//   cropping or upscaling.
// - Sender name + timestamp under the image as a caption so the
//   context isn't lost when zoomed in.

export interface LightboxImage {
  url: string;
  caption?: string;
  senderName?: string;
  timestamp?: Date;
}

interface Props {
  images: LightboxImage[];
  startIndex: number;
  onClose: () => void;
}

const ChatImageLightbox: React.FC<Props> = ({ images, startIndex, onClose }) => {
  const [index, setIndex] = useState(Math.max(0, Math.min(startIndex, images.length - 1)));
  // Swipe / drag-to-dismiss state.
  const [touchStart, setTouchStart] = useState<{ x: number; y: number } | null>(null);
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowRight') setIndex(i => Math.min(i + 1, images.length - 1));
      if (e.key === 'ArrowLeft') setIndex(i => Math.max(i - 1, 0));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [images.length, onClose]);

  const handleTouchStart = (e: React.TouchEvent) => {
    const t = e.touches[0];
    setTouchStart({ x: t.clientX, y: t.clientY });
    setDrag({ x: 0, y: 0 });
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (!touchStart) return;
    const t = e.touches[0];
    setDrag({ x: t.clientX - touchStart.x, y: t.clientY - touchStart.y });
  };

  const handleTouchEnd = () => {
    if (!touchStart || !drag) { setTouchStart(null); setDrag(null); return; }
    const { x, y } = drag;
    const absX = Math.abs(x);
    const absY = Math.abs(y);
    // Vertical drag > 100px → dismiss.
    if (absY > 100 && absY > absX) {
      onClose();
    } else if (absX > 60 && absX > absY) {
      // Horizontal swipe → next / prev image.
      if (x < 0 && index < images.length - 1) setIndex(index + 1);
      else if (x > 0 && index > 0) setIndex(index - 1);
    }
    setTouchStart(null);
    setDrag(null);
  };

  const current = images[index];

  // Save the current image. On iOS/Android Capacitor WebView + modern
  // mobile browsers, navigator.share(files) opens the system share
  // sheet — user picks "Save Image" to land it in Photos. On desktop
  // where share-files isn't supported, fall back to a download link.
  const saveCurrent = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!current || saving) return;
    setSaving(true);
    try {
      const res = await fetch(current.url, { credentials: 'omit' });
      if (!res.ok) throw new Error(`fetch-${res.status}`);
      const blob = await res.blob();
      // Best-effort filename from the URL or a sensible default. Some
      // Firebase Storage URLs end with a query string, so strip that.
      const urlPath = current.url.split('?')[0];
      const inferred = urlPath.split('/').pop() || '';
      const filename = inferred && /\.(jpe?g|png|webp|heic|gif)$/i.test(inferred)
        ? inferred
        : `photo-${Date.now()}.${(blob.type.split('/')[1] || 'jpg').replace('jpeg', 'jpg')}`;
      const file = typeof File !== 'undefined'
        ? new File([blob], filename, { type: blob.type || 'image/jpeg' })
        : null;
      // Prefer the system share sheet — it's the only path that offers
      // "Save Image" -> Photos on iOS without a native plugin.
      const nav = navigator as any;
      if (file && nav.share && nav.canShare?.({ files: [file] })) {
        try {
          await nav.share({ files: [file], title: current.caption || 'Photo' });
        } catch (err: any) {
          // User canceled the share sheet — not an error we surface.
          if (err?.name === 'AbortError') return;
          throw err;
        }
      } else {
        // Desktop / older browsers: trigger a download.
        const objectUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = objectUrl;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
      }
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1600);
    } catch (err) {
      console.warn('[chat-lightbox] save failed', err);
      alert('Could not save the photo. Try again or long-press the image and use your browser\'s save option.');
    } finally {
      setSaving(false);
    }
  };

  if (!current) return null;

  // Drag-to-dismiss transform — gives the user visual feedback that
  // the image is following their finger.
  const dragStyle: React.CSSProperties = drag
    ? { transform: `translate(${drag.x}px, ${drag.y}px)`, opacity: 1 - Math.min(Math.abs(drag.y) / 500, 0.5) }
    : {};

  // Portal to document.body so the lightbox escapes ANY stacking
  // context the chat thread might be trapped inside. Patrick
  // 2026-06-22 logs showed the activation chain firing + state
  // updating, but the lightbox never appeared visually. Suspect:
  // the chat conversation's slide-in transform creates a stacking
  // context that traps z-[60] beneath the bottom nav (z-50). Portal
  // pulls the lightbox to the root of <body> where nothing can trap
  // it.
  if (typeof document === 'undefined') return null;
  return createPortal(
    <div
      className="fixed inset-0 z-[9999] bg-black/95 flex flex-col animate-fade-in"
      onClick={onClose}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
    >
      <div className="flex items-center justify-between px-4 py-3 text-white">
        <div className="text-xs text-white/60">{images.length > 1 ? `${index + 1} / ${images.length}` : ''}</div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={saveCurrent}
            disabled={saving}
            aria-label="Save photo"
            className={`h-9 px-3 rounded-full flex items-center gap-1.5 text-sm font-semibold transition ${
              savedFlash
                ? 'bg-emerald-500/25 text-emerald-200'
                : 'bg-line-default/10 hover:bg-line-default/20 disabled:opacity-50'
            }`}
          >
            {savedFlash ? (
              <>
                <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12" /></svg>
                <span>Saved</span>
              </>
            ) : saving ? (
              <>
                <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" className="opacity-25" /><path fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" className="opacity-75" /></svg>
                <span>Saving</span>
              </>
            ) : (
              <>
                <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></svg>
                <span>Save</span>
              </>
            )}
          </button>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onClose(); }}
            aria-label="Close"
            className="w-9 h-9 rounded-full bg-line-default/10 hover:bg-line-default/20 flex items-center justify-center"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
          </button>
        </div>
      </div>
      <div className="flex-1 flex items-center justify-center px-4 overflow-hidden">
        <img
          src={current.url}
          alt={current.caption || ''}
          className="max-w-full max-h-full object-contain transition-transform"
          style={dragStyle}
          onClick={(e) => e.stopPropagation()}
          draggable={false}
        />
      </div>
      <div className="px-4 py-3 text-white">
        {(current.senderName || current.timestamp) && (
          <div className="text-[11px] text-white/60 text-center">
            {current.senderName}
            {current.senderName && current.timestamp ? ' · ' : ''}
            {current.timestamp ? current.timestamp.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : ''}
          </div>
        )}
        {current.caption && (
          <div className="text-sm text-white text-center mt-1 max-w-xl mx-auto break-words">{current.caption}</div>
        )}
        {images.length > 1 && (
          <div className="mt-3 flex items-center justify-center gap-3">
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); setIndex(i => Math.max(i - 1, 0)); }}
              disabled={index === 0}
              className="w-9 h-9 rounded-full bg-line-default/10 hover:bg-line-default/20 disabled:opacity-30 flex items-center justify-center"
              aria-label="Previous"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><polyline points="15 18 9 12 15 6" /></svg>
            </button>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); setIndex(i => Math.min(i + 1, images.length - 1)); }}
              disabled={index === images.length - 1}
              className="w-9 h-9 rounded-full bg-line-default/10 hover:bg-line-default/20 disabled:opacity-30 flex items-center justify-center"
              aria-label="Next"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><polyline points="9 18 15 12 9 6" /></svg>
            </button>
          </div>
        )}
      </div>
    </div>,
    document.body
  );
};

export default ChatImageLightbox;
