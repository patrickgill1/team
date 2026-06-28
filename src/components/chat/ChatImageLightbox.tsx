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
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onClose(); }}
          aria-label="Close"
          className="w-9 h-9 rounded-full bg-line-default/10 hover:bg-line-default/20 flex items-center justify-center"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
        </button>
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
