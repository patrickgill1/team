import React, { useState } from 'react';
import { useSwipeable } from 'react-swipeable';

// Swipeable wrapper around a chat-thread list row.
//
// Right-swipe → reveal Pin/Unpin (amber). Tap the revealed button
// OR continue the swipe past the threshold to commit immediately.
//
// Left-swipe → reveal Delete (rose). Same behavior. The row snaps
// back when the touch releases below the threshold.
//
// Distinguishes horizontal-intent from a vertical scroll by deferring
// drag until movement exceeds 12px horizontally AND horizontal beats
// vertical 2:1 — so a normal scroll never trips the action panel.

interface Props {
  children: React.ReactNode;
  onPinToggle?: () => void;
  isPinned?: boolean;
  onDelete?: () => void;
  /** Threshold to auto-commit the action when the user swipes past it
   *  without releasing on the revealed button. */
  commitThreshold?: number;
}

const ACTION_WIDTH = 88; // px of revealed action panel
const DEFAULT_COMMIT = 160;

const SwipeableThreadRow: React.FC<Props> = ({ children, onPinToggle, isPinned, onDelete, commitThreshold = DEFAULT_COMMIT }) => {
  const [dx, setDx] = useState(0);
  const [settling, setSettling] = useState(false);

  const reset = () => {
    setSettling(true);
    setDx(0);
    window.setTimeout(() => setSettling(false), 220);
  };

  const handlers = useSwipeable({
    onSwiping: (e) => {
      // Reject vertical-dominant gestures so list scrolling still works.
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX) * 0.5) return;
      // Clamp the visual offset so the row can't be flung off the edge.
      const limit = ACTION_WIDTH * 1.5;
      const clamped = Math.max(-limit, Math.min(limit, e.deltaX));
      setDx(clamped);
    },
    onSwipedLeft: (e) => {
      if (onDelete && Math.abs(e.deltaX) > commitThreshold) {
        onDelete();
        reset();
      } else if (Math.abs(e.deltaX) > ACTION_WIDTH / 2) {
        // Park the row in the open position so the user can tap Delete.
        setDx(-ACTION_WIDTH);
      } else {
        reset();
      }
    },
    onSwipedRight: (e) => {
      if (onPinToggle && e.deltaX > commitThreshold) {
        onPinToggle();
        reset();
      } else if (e.deltaX > ACTION_WIDTH / 2) {
        setDx(ACTION_WIDTH);
      } else {
        reset();
      }
    },
    onSwiped: () => {
      // Any other terminal event collapses back to neutral.
      if (Math.abs(dx) < ACTION_WIDTH / 2) reset();
    },
    trackTouch: true,
    trackMouse: false,
    delta: { left: 12, right: 12, up: 9999, down: 9999 },
  });

  const showPin = dx > 8 && !!onPinToggle;
  const showDelete = dx < -8 && !!onDelete;

  return (
    <div className="relative overflow-hidden">
      {/* Pin action panel (right swipe) */}
      {showPin && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onPinToggle?.(); reset(); }}
          className="absolute inset-y-0 left-0 flex items-center justify-center bg-amber-500 text-white font-bold text-xs uppercase tracking-widest"
          style={{ width: ACTION_WIDTH }}
        >
          <div className="flex flex-col items-center gap-1">
            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
              <path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2z" />
            </svg>
            {isPinned ? 'Unpin' : 'Pin'}
          </div>
        </button>
      )}
      {/* Delete action panel (left swipe) */}
      {showDelete && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onDelete?.(); reset(); }}
          className="absolute inset-y-0 right-0 flex items-center justify-center bg-rose-600 text-white font-bold text-xs uppercase tracking-widest"
          style={{ width: ACTION_WIDTH }}
        >
          <div className="flex flex-col items-center gap-1">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
              <path d="M10 11v6M14 11v6" />
            </svg>
            Delete
          </div>
        </button>
      )}

      {/* Foreground row — translates with the swipe. */}
      <div
        {...handlers}
        style={{
          transform: `translateX(${dx}px)`,
          transition: settling ? 'transform 220ms cubic-bezier(0.32, 0.72, 0, 1)' : undefined,
        }}
        className="bg-white relative z-10"
      >
        {children}
      </div>
    </div>
  );
};

export default SwipeableThreadRow;
