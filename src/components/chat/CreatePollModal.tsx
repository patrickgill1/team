import React, { useState } from 'react';
import { createPortal } from 'react-dom';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (poll: { question: string; options: string[]; multi: boolean }) => void;
}

const CreatePollModal: React.FC<Props> = ({ isOpen, onClose, onSubmit }) => {
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState<string[]>(['', '']);
  const [multi, setMulti] = useState(false);

  if (!isOpen) return null;

  const reset = () => {
    setQuestion('');
    setOptions(['', '']);
    setMulti(false);
  };
  const handleClose = () => { reset(); onClose(); };

  const setOption = (i: number, v: string) => {
    setOptions((prev) => prev.map((o, j) => (j === i ? v : o)));
  };
  const addOption = () => {
    if (options.length >= 6) return;
    setOptions((prev) => [...prev, '']);
  };
  const removeOption = (i: number) => {
    if (options.length <= 2) return;
    setOptions((prev) => prev.filter((_, j) => j !== i));
  };

  const cleaned = options.map((o) => o.trim()).filter(Boolean);
  const canSubmit = question.trim().length > 0 && cleaned.length >= 2;

  const handleSubmit = () => {
    if (!canSubmit) return;
    onSubmit({ question: question.trim(), options: cleaned, multi });
    reset();
    onClose();
  };

  return createPortal(
    <div
      className="fixed inset-0 flex items-center justify-center px-4 bg-black/60 backdrop-blur-sm"
      style={{
        zIndex: 200,
        paddingTop: 'calc(4rem + env(safe-area-inset-top))',
        paddingBottom: 'calc(4rem + env(safe-area-inset-bottom))',
      }}
      onClick={handleClose}
    >
      <div
        className="bg-white rounded-t-2xl sm:rounded-2xl shadow-2xl w-full sm:max-w-lg max-h-full flex flex-col theme-ok"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="relative px-5 py-4 border-b border-line-default/10 flex items-center justify-between bg-surface-elevated overflow-hidden">
          {/* Subtle brand wash behind the icon — anchors the header
              without shouting. Sits behind the icon column only. */}
          <div aria-hidden className="absolute -left-8 top-1/2 -translate-y-1/2 w-24 h-24 rounded-full bg-brand-primary/15 blur-2xl pointer-events-none" />
          <div className="relative flex items-center gap-3 min-w-0">
            {/* Ascending-bars glyph, rounded strokes, brand color.
                Replaces the shipped 📊 per feedback_no_emojis. */}
            <span className="shrink-0 inline-flex items-center justify-center w-10 h-10 rounded-xl bg-brand-primary/15 ring-1 ring-brand-primary/25 text-brand-primary">
              <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.25} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <line x1="7"  y1="20" x2="7"  y2="14" />
                <line x1="12" y1="20" x2="12" y2="9" />
                <line x1="17" y1="20" x2="17" y2="4" />
              </svg>
            </span>
            <div className="min-w-0">
              <h3 className="text-base font-black tracking-tight text-ink-primary leading-tight">New poll</h3>
              <p className="text-[11px] font-semibold text-ink-secondary leading-tight mt-0.5">Ask the thread a quick question.</p>
            </div>
          </div>
          <button
            onClick={handleClose}
            className="relative shrink-0 w-9 h-9 flex items-center justify-center rounded-full text-ink-primary/60 hover:text-ink-primary hover:bg-line-default/[0.08] transition"
            aria-label="Close"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="p-5 space-y-4 overflow-y-auto">
          <div>
            <label className="block text-sm font-medium text-slate-800 mb-1 theme-ok">Question</label>
            <input
              type="text"
              autoFocus
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="Practice Friday or Saturday?"
              className="w-full border border-gray-300 rounded-xl px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-brand-primary text-base"
              style={{ fontSize: '16px' }}
              maxLength={140}
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-800 mb-1 theme-ok">Options</label>
            <div className="space-y-2">
              {options.map((o, i) => (
                <div key={i} className="flex items-center gap-2">
                  <input
                    type="text"
                    value={o}
                    onChange={(e) => setOption(i, e.target.value)}
                    placeholder={`Option ${i + 1}`}
                    className="flex-1 border border-gray-300 rounded-xl px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-brand-primary text-base"
                    style={{ fontSize: '16px' }}
                    maxLength={60}
                  />
                  {options.length > 2 && (
                    <button
                      onClick={() => removeOption(i)}
                      className="text-slate-500 hover:text-rose-600 p-1 theme-ok"
                      aria-label="Remove option"
                    >
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  )}
                </div>
              ))}
              {options.length < 6 && (
                <button
                  onClick={addOption}
                  className="text-sm font-semibold text-brand-primary hover:text-brand-primary-dim"
                >
                  + Add option
                </button>
              )}
            </div>
          </div>

          <label className="flex items-center gap-2 text-sm text-slate-800 theme-ok">
            <input
              type="checkbox"
              checked={multi}
              onChange={(e) => setMulti(e.target.checked)}
              className="w-4 h-4 accent-brand-primary"
            />
            Allow picking multiple options
          </label>
        </div>

        <div className="border-t border-gray-100 p-4 flex items-center justify-end gap-2 bg-gray-50 theme-ok">
          <button onClick={handleClose} className="px-4 py-2 text-sm font-semibold text-slate-800 hover:text-slate-900 theme-ok">
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={!canSubmit}
            className="bg-brand-primary hover:brightness-110 disabled:bg-gray-300 text-white font-semibold rounded-xl px-5 py-2 text-sm transition active:scale-95 theme-ok"
          >
            Send poll
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};

export default CreatePollModal;
