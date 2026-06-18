import React, { useState } from 'react';
import { Link } from 'react-router-dom';

// Hardcoded Fire FC store config. Lives in code (not Firestore) because
// it's a single shared link for every family — no per-team variation
// today. If we ever go multi-club, lift this into a `clubs/{clubId}`
// doc with the same shape.
const STORE_URL = 'https://team.wegotsoccer.com/firefc';
const DISCOUNT_CODE = 'FIREFCREWARDS';

const TeamStore: React.FC = () => {
  const [copied, setCopied] = useState(false);

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(DISCOUNT_CODE);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      // Fallback when clipboard API is blocked (older iOS WebView etc.):
      // surface the code in a prompt so the user can long-press-copy.
      window.prompt('Copy this code:', DISCOUNT_CODE);
    }
  };

  return (
    <div className="min-h-screen bg-slate-100">
      <section className="bg-gradient-to-b from-charcoal-950 to-charcoal-900 px-4 sm:px-6 py-5 border-b border-crimson-500/10">
        <div className="max-w-3xl mx-auto">
          <Link to="/dashboard" className="inline-flex items-center gap-1.5 text-xs font-bold tracking-widest uppercase text-crimson-300 hover:text-crimson-200 mb-2">
            <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>
            Dashboard
          </Link>
          <div className="flex items-center gap-3">
            <span className="flex-shrink-0 w-11 h-11 rounded-2xl bg-crimson-500/15 ring-1 ring-crimson-500/30 flex items-center justify-center">
              <svg className="w-5 h-5 text-crimson-300" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                <path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/>
                <line x1="3" y1="6" x2="21" y2="6"/>
                <path d="M16 10a4 4 0 0 1-8 0"/>
              </svg>
            </span>
            <div>
              <h1 className="text-2xl sm:text-3xl font-black text-white leading-tight">
                Team Store
              </h1>
              <p className="text-sm text-slate-400 mt-0.5">Official Fire FC gear, member pricing.</p>
            </div>
          </div>
        </div>
      </section>

      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-6">
        {/* Discount code card — the headline. Large, copyable, can't be
            missed. */}
        <div className="rounded-2xl bg-white ring-1 ring-crimson-200 overflow-hidden shadow-sm">
          <div className="bg-gradient-to-br from-crimson-500 to-crimson-600 px-5 py-3 text-white">
            <div className="text-[10px] font-extrabold tracking-widest uppercase opacity-90">Member discount code</div>
            <div className="text-[11px] opacity-90 mt-0.5">Apply at checkout for the team rate.</div>
          </div>
          <div className="px-5 py-5 flex flex-col sm:flex-row items-center gap-3">
            <div className="flex-1 w-full">
              <code className="block w-full text-center sm:text-left text-2xl font-black tracking-[0.15em] text-slate-900 font-mono">
                {DISCOUNT_CODE}
              </code>
            </div>
            <button
              type="button"
              onClick={copyCode}
              className={`flex-shrink-0 w-full sm:w-auto px-5 py-3 rounded-xl font-bold text-sm tracking-wider uppercase transition-all ${
                copied
                  ? 'bg-emerald-500 text-white'
                  : 'bg-charcoal-900 text-white hover:bg-charcoal-800 active:scale-95'
              }`}
            >
              {copied ? 'Copied!' : 'Copy code'}
            </button>
          </div>
        </div>

        {/* Shop CTA */}
        <a
          href={STORE_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-4 block rounded-2xl bg-gradient-to-br from-charcoal-950 to-charcoal-900 ring-1 ring-crimson-500/30 text-white px-5 py-5 hover:shadow-lg transition-shadow"
        >
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[10px] font-extrabold tracking-widest uppercase text-crimson-300">Shop now</div>
              <div className="text-base font-bold mt-0.5 truncate">team.wegotsoccer.com/firefc</div>
              <div className="text-[12px] text-slate-400 mt-0.5">Opens in your browser. Copy the code above first.</div>
            </div>
            <span className="flex-shrink-0 w-10 h-10 rounded-full bg-crimson-500/20 ring-1 ring-crimson-400/40 flex items-center justify-center">
              <svg className="w-4 h-4 text-crimson-200" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                <line x1="5" y1="12" x2="19" y2="12"/>
                <polyline points="12 5 19 12 12 19"/>
              </svg>
            </span>
          </div>
        </a>

        <p className="mt-5 text-[11px] text-slate-500 text-center px-4 leading-relaxed">
          Questions about an order? Contact the club, not the app — the team store is run by
          gotsoccer.
        </p>
      </div>
    </div>
  );
};

export default TeamStore;
