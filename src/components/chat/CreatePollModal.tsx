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
        className="bg-white rounded-t-2xl sm:rounded-2xl shadow-2xl w-full sm:max-w-lg max-h-full flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between bg-gradient-to-r from-cyan-50 to-white">
          <div>
            <h3 className="text-lg font-bold text-gray-900">📊 New poll</h3>
            <p className="text-xs text-gray-500">Ask the thread a quick question.</p>
          </div>
          <button onClick={handleClose} className="p-2 rounded-lg hover:bg-gray-100 text-gray-500" aria-label="Close">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="p-5 space-y-4 overflow-y-auto">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Question</label>
            <input
              type="text"
              autoFocus
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="Practice Friday or Saturday?"
              className="w-full border border-gray-300 rounded-xl px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-cyan-500 text-base"
              style={{ fontSize: '16px' }}
              maxLength={140}
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Options</label>
            <div className="space-y-2">
              {options.map((o, i) => (
                <div key={i} className="flex items-center gap-2">
                  <input
                    type="text"
                    value={o}
                    onChange={(e) => setOption(i, e.target.value)}
                    placeholder={`Option ${i + 1}`}
                    className="flex-1 border border-gray-300 rounded-xl px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-cyan-500 text-base"
                    style={{ fontSize: '16px' }}
                    maxLength={60}
                  />
                  {options.length > 2 && (
                    <button
                      onClick={() => removeOption(i)}
                      className="text-gray-400 hover:text-rose-600 p-1"
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
                  className="text-sm font-semibold text-cyan-700 hover:text-cyan-900"
                >
                  + Add option
                </button>
              )}
            </div>
          </div>

          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input
              type="checkbox"
              checked={multi}
              onChange={(e) => setMulti(e.target.checked)}
              className="w-4 h-4 accent-cyan-600"
            />
            Allow picking multiple options
          </label>
        </div>

        <div className="border-t border-gray-100 p-4 flex items-center justify-end gap-2 bg-gray-50">
          <button onClick={handleClose} className="px-4 py-2 text-sm font-semibold text-gray-700 hover:text-gray-900">
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={!canSubmit}
            className="bg-gradient-to-br from-cyan-500 to-cyan-600 hover:from-cyan-600 hover:to-cyan-700 disabled:from-gray-300 disabled:to-gray-300 text-white font-semibold rounded-xl px-5 py-2 text-sm transition active:scale-95"
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
