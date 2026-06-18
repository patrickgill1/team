import React from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import Logo from '../components/common/Logo';

// Tiny pair of pages parents land on after the Stripe Checkout
// redirect. Success = "payment confirmed, we'll be in touch." Cancel =
// "didn't go through — try again or contact us." The actual Registration
// status flip happens server-side via the Stripe webhook, so these
// screens are just acknowledgements; we don't poll or re-fetch the doc.

export const RegisterSuccess: React.FC = () => {
  const [params] = useSearchParams();
  const regId = params.get('registrationId');
  return (
    <Frame
      tone="success"
      title="Payment received"
      body="Your registration is locked in. Watch your inbox over the next few days — the coach will reach out with tryout details or next steps."
      regId={regId}
    />
  );
};

export const RegisterCancel: React.FC = () => {
  const [params] = useSearchParams();
  const regId = params.get('registrationId');
  return (
    <Frame
      tone="warning"
      title="Payment didn't go through"
      body="No charge was made. Your registration is saved as pending — you can try again later, or contact the club to pay another way."
      regId={regId}
    />
  );
};

const Frame: React.FC<{ tone: 'success' | 'warning'; title: string; body: string; regId: string | null }> = ({ tone, title, body, regId }) => (
  <div className="min-h-screen bg-gradient-to-br from-charcoal-950 via-charcoal-900 to-black flex items-center justify-center p-6">
    <div className="max-w-md w-full bg-white/[0.04] backdrop-blur ring-1 ring-white/10 rounded-3xl p-8 text-center">
      <div className="inline-flex p-3 rounded-2xl bg-white/5 ring-1 ring-white/10 backdrop-blur mb-4">
        <Logo size="lg" variant="full" />
      </div>
      <div className={`w-14 h-14 mx-auto rounded-full flex items-center justify-center mb-4 ${
        tone === 'success' ? 'bg-emerald-500/20 ring-1 ring-emerald-400/40' : 'bg-amber-500/20 ring-1 ring-amber-400/40'
      }`}>
        {tone === 'success' ? (
          <svg className="w-6 h-6 text-emerald-300" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>
        ) : (
          <svg className="w-6 h-6 text-amber-300" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/></svg>
        )}
      </div>
      <h1 className="text-xl font-black text-white mb-2">{title}</h1>
      <p className="text-sm text-slate-400 leading-relaxed mb-5">{body}</p>
      {regId && (
        <p className="text-[10px] text-slate-600 mb-3">Ref: {regId}</p>
      )}
      <Link to="/register" className="inline-block text-crimson-400 hover:text-bone text-sm font-bold">
        Back to registration
      </Link>
    </div>
  </div>
);
