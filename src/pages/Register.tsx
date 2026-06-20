import React, { useEffect, useMemo, useState } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { addDoc, collection, doc, getDoc, getDocs, query, where, orderBy, limit, serverTimestamp } from 'firebase/firestore';
import { db } from '../utils/firebase';
import { logActivity } from '../utils/activityLog';
import Logo from '../components/common/Logo';
import RegisterAuthGate from './RegisterAuthGate';
import { useAuth } from '../contexts/AuthContext';
import type { Product, RegistrationFormConfig, RegistrationQuestion } from '../types';
import { quotePrice } from '../utils/pricing';

// Public registration form. No auth required — a parent lands here
// from an email blast or a posted link, fills it out, pays. We create
// a Registration doc (NOT a Player) and walk it through the funnel via
// admin/coach moves later. For returning players, the parent comes in
// via ?return=<playerId>&season=<seasonId> which pre-fills everything
// from the existing Player doc.
//
// Payment isn't wired in this commit — the form submits with status
// 'pending_payment' and admin can mark paid manually, OR the next
// commit adds the Stripe Checkout step.

const AGE_GROUPS = ['U6', 'U7', 'U8', 'U9', 'U10', 'U11', 'U12', 'U13', 'U14', 'U15', 'U16', 'U17', 'U18'] as const;

interface ParentDraft {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  relationship: 'mother' | 'father' | 'guardian' | 'other';
}

const Register: React.FC = () => {
  // Auth gate split — Register itself has ONE hook (useAuth) and
  // decides which sub-component to render. The actual form is
  // RegisterForm below, and ALL its hooks run together every render
  // it's mounted. This avoids the "rendered fewer hooks than expected"
  // (React #310) we hit when the conditional return sat in the same
  // component as 20+ other hooks declared below it.
  const { currentUser } = useAuth();
  if (!currentUser) {
    return <RegisterAuthGate onAuthed={() => { /* AuthContext re-render flips us into the form */ }} />;
  }
  return <RegisterForm />;
};

const RegisterForm: React.FC = () => {
  const [searchParams] = useSearchParams();
  const returnPlayerId = searchParams.get('return') || null;
  const seasonIdParam = searchParams.get('season') || null;
  const { currentUser, userData } = useAuth();

  // Resolved season — either explicit (from email link) or the most
  // recent season with registrationOpen === true.
  const [seasonId, setSeasonId] = useState<string | null>(seasonIdParam);
  const [season, setSeason] = useState<any | null>(null);
  const [loadingSeason, setLoadingSeason] = useState(true);
  const [clubId, setClubId] = useState<string | null>(null);

  // Player fields
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [dob, setDob] = useState('');
  const [gender, setGender] = useState<'male' | 'female' | 'other'>('male');
  const [preferredPosition, setPreferredPosition] = useState('');
  const [ageGroup, setAgeGroup] = useState<string>('U10');
  const [playedBefore, setPlayedBefore] = useState(false);
  const [medicalNotes, setMedicalNotes] = useState('');
  const [jerseySize, setJerseySize] = useState('');

  // Parents — start with one, can add a second
  const [parents, setParents] = useState<ParentDraft[]>([
    { firstName: '', lastName: '', email: '', phone: '', relationship: 'mother' },
  ]);

  // Once authed, pre-fill the primary parent row from the user account
  // so the family doesn't have to retype their email/name.
  useEffect(() => {
    if (!userData?.email) return;
    setParents(prev => {
      const first = prev[0] || { firstName: '', lastName: '', email: '', phone: '', relationship: 'mother' };
      // Only patch when the row is still empty — don't clobber edits
      // the user has already made.
      if (first.email && first.firstName) return prev;
      const [fName = '', ...lRest] = (userData.name || '').split(' ');
      return [
        {
          ...first,
          email: first.email || userData.email,
          firstName: first.firstName || fName,
          lastName: first.lastName || lRest.join(' '),
          phone: first.phone || (userData as any)?.phoneNumber || '',
        },
        ...prev.slice(1),
      ];
    });
  }, [userData?.uid, userData?.email, userData?.name]);

  // Registration products for the resolved season. We pick one based on
  // the player's age group (see `activeProduct` below). If none exist
  // for the club, we fall back to the season's flat fee fields.
  const [products, setProducts] = useState<Product[]>([]);
  const [couponCode, setCouponCode] = useState('');
  const [couponError, setCouponError] = useState<string | null>(null);

  // Admin-defined custom questions for this club/season + the parent's
  // answers, keyed by question id.
  const [formConfig, setFormConfig] = useState<RegistrationFormConfig | null>(null);
  const [customAnswers, setCustomAnswers] = useState<Record<string, string | number | boolean>>({});

  const [submitting, setSubmitting] = useState(false);
  const [submittedRegId, setSubmittedRegId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 3-step wizard: 1 = branded splash, 2 = form, 3 = cart + pay.
  // Matches the 360Player flow Patrick showed — splash sets expectation,
  // form does the data work, cart is the explicit payment moment.
  const [step, setStep] = useState<1 | 2 | 3>(1);
  // Branded club shell — pulled once the clubId resolves. Used for the
  // splash card. Missing clubLogo is fine; we fall back to the GoalKickr
  // mark.
  const [clubShell, setClubShell] = useState<{ name?: string; logoUrl?: string } | null>(null);

  // Load the open season + pre-fill from returning player if applicable.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setLoadingSeason(true);
        // Resolve season.
        let seasonDoc: any = null;
        if (seasonId) {
          const snap = await getDoc(doc(db, 'seasons', seasonId));
          if (snap.exists()) seasonDoc = { id: snap.id, ...(snap.data() as any) };
        }
        if (!seasonDoc) {
          // Fall back to most-recent open registration.
          const q = query(
            collection(db, 'seasons'),
            where('registrationOpen', '==', true),
            orderBy('createdAt', 'desc'),
            limit(1),
          );
          const snap = await getDocs(q);
          if (!snap.empty) {
            const d = snap.docs[0];
            seasonDoc = { id: d.id, ...(d.data() as any) };
            if (!cancelled) setSeasonId(d.id);
          }
        }
        if (cancelled) return;
        setSeason(seasonDoc);
        if (seasonDoc?.clubId) setClubId(seasonDoc.clubId);

        // Pre-fill from existing player for returning families.
        if (returnPlayerId) {
          try {
            const pSnap = await getDoc(doc(db, 'players', returnPlayerId));
            if (pSnap.exists()) {
              const p: any = pSnap.data();
              const [pf, ...pl] = (p.name || '').split(' ');
              if (!cancelled) {
                setFirstName(p.firstName || pf || '');
                setLastName(p.lastName || pl.join(' ') || '');
                if (p.dateOfBirth) setDob(String(p.dateOfBirth).slice(0, 10));
                if (p.position) setPreferredPosition(p.position);
                setPlayedBefore(true);
                // Pre-fill parents from parentEmails / parentNames
                if (Array.isArray(p.parentEmails) && p.parentEmails.length > 0) {
                  const drafts: ParentDraft[] = (p.parentEmails as string[]).map((e, i) => ({
                    firstName: (p.parentNames?.[i] || '').split(' ')[0] || '',
                    lastName: (p.parentNames?.[i] || '').split(' ').slice(1).join(' ') || '',
                    email: e,
                    phone: p.parentPhones?.[i] || '',
                    relationship: 'guardian',
                  }));
                  setParents(drafts.length > 0 ? drafts : parents);
                }
              }
            }
          } catch (err) {
            console.warn('pre-fill from returning player failed', err);
          }
        }
      } finally {
        if (!cancelled) setLoadingSeason(false);
      }
    })();
    return () => { cancelled = true; };
  }, [seasonId, returnPlayerId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load active registration products for the season.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!clubId || !season?.id) return;
      try {
        const qProducts = query(
          collection(db, 'products'),
          where('clubId', '==', clubId),
          where('type', '==', 'registration'),
          where('isActive', '==', true),
        );
        const snap = await getDocs(qProducts);
        const list: Product[] = snap.docs
          .map(d => ({ id: d.id, ...(d.data() as any) } as Product))
          .filter(p => (p.metadata?.seasonId ? p.metadata.seasonId === season.id : true));
        if (!cancelled) setProducts(list);
      } catch (err) {
        console.warn('product load failed (fine — falling back to season fee)', err);
      }
    })();
    return () => { cancelled = true; };
  }, [clubId, season?.id]);

  // Load admin-defined custom questions. Prefer the season-specific
  // config (`${clubId}_${seasonId}`), fall back to club default
  // (`${clubId}_default`). If neither exists, no extra questions render.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!clubId || !season?.id) return;
      try {
        const tryIds = [`${clubId}_${season.id}`, `${clubId}_default`];
        for (const id of tryIds) {
          const snap = await getDoc(doc(db, 'registration_form_configs', id));
          if (snap.exists()) {
            if (!cancelled) setFormConfig({ id: snap.id, ...(snap.data() as any) });
            return;
          }
        }
      } catch (err) {
        console.warn('form config load failed (fine — no custom questions)', err);
      }
    })();
    return () => { cancelled = true; };
  }, [clubId, season?.id]);

  // Visible questions = config questions filtered for returningOnly +
  // sorted by order. Compute once per render.
  const visibleQuestions = useMemo<RegistrationQuestion[]>(() => {
    const all = formConfig?.questions || [];
    return all
      .filter(q => !q.returningOnly || !!returnPlayerId)
      .slice()
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  }, [formConfig, returnPlayerId]);

  // Pick the product that matches the player's age group. If none match
  // by age, fall back to a generic product (no ageGroups restriction).
  const activeProduct = useMemo<Product | null>(() => {
    if (products.length === 0) return null;
    const byAge = products.find(p => Array.isArray(p.metadata?.ageGroups) && p.metadata!.ageGroups.includes(ageGroup));
    if (byAge) return byAge;
    const generic = products.find(p => !p.metadata?.ageGroups || p.metadata.ageGroups.length === 0);
    return generic || products[0];
  }, [products, ageGroup]);

  // Quote either from the active product OR fall back to the season's
  // flat fee + early-bird fields (legacy path until products are set up).
  const quote = useMemo(() => {
    if (activeProduct) {
      return quotePrice(activeProduct, { couponCode: couponCode.trim() || undefined });
    }
    // Legacy season-fee path.
    const base = season?.registrationFeeCents || 0;
    let earlyBirdDiscount = 0;
    if (season?.earlyBirdDeadline && season.earlyBirdDiscountCents) {
      const deadline = (season.earlyBirdDeadline as any)?.toDate?.()
        || new Date(season.earlyBirdDeadline);
      if (Date.now() < deadline.getTime()) earlyBirdDiscount = season.earlyBirdDiscountCents;
    }
    return {
      tier: earlyBirdDiscount > 0
        ? { id: 'early', label: 'Early Bird', priceCents: base - earlyBirdDiscount }
        : { id: 'standard', label: 'Standard', priceCents: base },
      baseCents: base,
      discountCents: earlyBirdDiscount,
      surchargeCents: 0,
      totalCents: Math.max(0, base - earlyBirdDiscount),
      couponCode: undefined,
    } as ReturnType<typeof quotePrice>;
  }, [activeProduct, season, couponCode]);

  const baseFee = quote.baseCents;
  const effectiveFee = quote.totalCents;

  // Load the club shell (name + logo) for the branded splash card.
  // Falls back gracefully if missing — splash uses generic copy.
  useEffect(() => {
    let cancelled = false;
    if (!clubId) return;
    (async () => {
      try {
        const snap = await getDoc(doc(db, 'clubs', clubId));
        if (!cancelled && snap.exists()) {
          const c: any = snap.data();
          setClubShell({ name: c.name, logoUrl: c.logoUrl });
        }
      } catch {
        /* silent — splash shell stays generic */
      }
    })();
    return () => { cancelled = true; };
  }, [clubId]);

  // Surface coupon resolution status so parents know if a typo'd code
  // was silently ignored.
  useEffect(() => {
    if (!couponCode.trim()) { setCouponError(null); return; }
    if (!activeProduct) {
      setCouponError('Coupons not available for this registration.');
      return;
    }
    if (quote.couponCode) {
      setCouponError(null);
    } else {
      setCouponError("Code didn't apply — check spelling or expiration.");
    }
  }, [couponCode, quote.couponCode, activeProduct]);

  const updateParent = (i: number, patch: Partial<ParentDraft>) => {
    setParents(prev => prev.map((p, idx) => idx === i ? { ...p, ...patch } : p));
  };

  // Every required custom question must be answered before submit.
  const customAnswersValid = visibleQuestions.every(q => {
    if (!q.required) return true;
    const v = customAnswers[q.id];
    if (v === undefined || v === null) return false;
    if (typeof v === 'string') return v.trim().length > 0;
    return true;
  });

  // Step 2 ("Form") needs everything except the cart. Step 3 ("Cart")
  // is the only place where canSubmit kicks in — at submit time we
  // re-validate the full set so a fast-tapper can't skip a field by
  // hitting Submit while disabled props update.
  const playerValid = !!(firstName.trim() && lastName.trim() && dob && ageGroup);
  const guardianValid = !!(
    parents[0]?.firstName?.trim()
    && parents[0]?.email?.trim()
    && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(parents[0]?.email || '')
  );
  const canAdvanceForm = playerValid && guardianValid && customAnswersValid;

  const canSubmit = !!(
    canAdvanceForm
    && season && clubId
    && !submitting
  );

  const handleSubmit = async () => {
    if (!canSubmit || !season || !clubId) return;
    setSubmitting(true);
    setError(null);
    try {
      // Create a real Player doc immediately at registration time.
      // No more snapshot-then-promote dance — the Player exists from
      // the moment the family signs up. Offer acceptance later just
      // assigns Player.teamId; no new doc creation needed. Returning
      // families reuse their existing Player rather than create a new
      // one. teamId stays null until the kid is rostered.
      const fullName = `${firstName.trim()} ${lastName.trim()}`;
      const parentEmailsLower = parents
        .filter(p => p.email.trim())
        .map(p => p.email.trim().toLowerCase());
      let playerId = returnPlayerId;
      if (!playerId) {
        const playerData: any = {
          name: fullName,
          firstName: firstName.trim(),
          lastName: lastName.trim(),
          dateOfBirth: dob ? new Date(dob) : null,
          gender,
          position: preferredPosition.trim() || null,
          teamId: null,
          teamIds: [],
          clubId,
          parentIds: currentUser?.uid ? [currentUser.uid] : [],
          parentEmails: parentEmailsLower,
          medicalInfo: medicalNotes.trim() || null,
          isActive: true,
          registrationSeasonId: season.id,
          createdAt: serverTimestamp(),
        };
        const playerRef = await addDoc(collection(db, 'players'), playerData);
        playerId = playerRef.id;
      }

      const payload: any = {
        clubId,
        seasonId: season.id,
        playerId,
        player: {
          firstName: firstName.trim(),
          lastName: lastName.trim(),
          dateOfBirth: dob,
          gender,
          preferredPosition: preferredPosition.trim() || undefined,
          playedBefore,
          ageGroup,
          medicalNotes: medicalNotes.trim() || undefined,
          jerseySizeRequested: jerseySize.trim() || undefined,
        },
        parents: parents
          .filter(p => p.firstName.trim() && p.email.trim())
          .map(p => ({
            firstName: p.firstName.trim(),
            lastName: p.lastName.trim(),
            email: p.email.trim().toLowerCase(),
            phone: p.phone.trim() || undefined,
            relationship: p.relationship,
          })),
        status: 'pending_payment',
        productId: activeProduct?.id,
        productName: activeProduct?.name,
        pricingTierId: quote.tier?.id,
        pricingTierLabel: quote.tier?.label,
        registrationFeeCents: quote.baseCents,
        couponCode: quote.couponCode,
        couponDiscountCents: quote.discountCents || undefined,
        amountPaidCents: quote.totalCents,
        stripeSurchargeCents: quote.surchargeCents || undefined,
        earlyBirdApplied: (quote.tier?.label || '').toLowerCase().includes('early'),
        customAnswers: visibleQuestions.length > 0 ? customAnswers : undefined,
        customAnswerLabels: visibleQuestions.length > 0
          ? Object.fromEntries(visibleQuestions.map(q => [q.id, q.label]))
          : undefined,
        source: returnPlayerId ? 'returning' : 'cold',
        // The Player now exists from registration submit, so set this
        // immediately. UI surfaces (Tryouts, Registrations) use this
        // to render PROFILE links — they'll work from day one rather
        // than waiting until offer acceptance.
        promotedToPlayerId: playerId,
        createdAt: serverTimestamp(),
      };
      const ref = await addDoc(collection(db, 'registrations'), payload);
      // Log the activity for the admin timeline.
      void logActivity({
        clubId,
        kind: 'registration_submitted',
        registrationId: ref.id,
        playerId: playerId || undefined,
        parentEmail: parents[0]?.email?.trim().toLowerCase(),
        seasonId: season.id,
        actorUid: 'public',
        actorName: parents[0]?.firstName + ' ' + parents[0]?.lastName,
        payload: {
          ageGroup,
          gender,
          playedBefore,
          productId: activeProduct?.id,
          tierLabel: quote.tier?.label,
          baseCents: quote.baseCents,
          discountCents: quote.discountCents,
          totalCents: quote.totalCents,
          couponCode: quote.couponCode,
        },
      });
      if (quote.couponCode) {
        void logActivity({
          clubId,
          kind: 'coupon_redeemed',
          registrationId: ref.id,
          playerId: returnPlayerId || undefined,
          parentEmail: parents[0]?.email?.trim().toLowerCase(),
          seasonId: season.id,
          actorUid: 'public',
          payload: {
            code: quote.couponCode,
            productId: activeProduct?.id,
            discountCents: quote.discountCents,
          },
        });
      }

      // If the registration has a balance owing AND the club is Stripe-
      // ready, redirect to Checkout. Otherwise show the success screen
      // and admin marks paid manually (or it's a free registration).
      if (quote.totalCents > 0) {
        try {
          const NOTIFY_URL = process.env.REACT_APP_NOTIFY_URL;
          const NOTIFY_SECRET = process.env.REACT_APP_NOTIFY_SECRET;
          if (NOTIFY_URL && NOTIFY_SECRET) {
            const r = await fetch(`${NOTIFY_URL}/stripe/registration-checkout`, {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${NOTIFY_SECRET}`,
              },
              body: JSON.stringify({ registrationId: ref.id }),
            });
            const data: any = await r.json().catch(() => ({}));
            if (r.ok && data?.url) {
              window.location.assign(data.url);
              return;
            }
            // Soft fail — show success but leave a hint in the console
            // for the admin to follow up. The Registration is saved
            // either way; admin can mark paid manually.
            console.warn('checkout session not created — falling back to success screen', data);
          }
        } catch (err) {
          console.warn('checkout request threw — falling back to success screen', err);
        }
      }

      setSubmittedRegId(ref.id);
    } catch (err: any) {
      console.error('registration submit failed', err);
      setError(err?.message || 'Submission failed — try again.');
    } finally {
      setSubmitting(false);
    }
  };

  // ── Render states ──────────────────────────────────────────────

  if (loadingSeason) {
    return <CenterMessage title="Loading registration…" />;
  }

  if (!season || !season.registrationOpen) {
    return (
      <CenterMessage
        title="Registration isn't open right now"
        body="Check back later — or get in touch with the club for details."
      />
    );
  }

  if (submittedRegId) {
    return (
      <CenterMessage
        title="Registration received"
        body={
          baseFee > 0
            ? "We've recorded your registration. Payment instructions are coming next — keep an eye on your inbox."
            : "We've recorded your registration. The club will be in touch shortly with next steps."
        }
        success
      />
    );
  }

  const clubName = clubShell?.name || 'the club';
  const questionCount = visibleQuestions.length;
  const familyFirst = userData?.name?.split(' ')[0] || 'family';

  return (
    <div className="min-h-screen bg-gradient-to-br from-charcoal-950 via-charcoal-900 to-black px-4 py-6 sm:py-10">
      <div className="max-w-2xl mx-auto">
        {/* Progress dots — always visible so parents know where they
            are. On step 1 (splash) we hide them to keep the entry card
            clean; they appear once the parent commits to the flow. */}
        {step > 1 && (
          <div className="flex items-center justify-center gap-2 mb-5">
            {[1, 2, 3].map((s) => (
              <span
                key={s}
                aria-current={step === s ? 'step' : undefined}
                className={`h-1.5 rounded-full transition-all ${
                  step === s ? 'bg-crimson-500 w-10' :
                  step > s   ? 'bg-crimson-500/40 w-6' :
                               'bg-white/10 w-6'
                }`}
              />
            ))}
          </div>
        )}

        {/* ─── STEP 1: SPLASH ─────────────────────────────────────── */}
        {step === 1 && (
          <div className="bg-white/[0.04] backdrop-blur-2xl ring-1 ring-white/10 rounded-3xl overflow-hidden">
            {/* Hero band — club logo lives here. Falls back to the
                GoalKickr mark when the club has no logoUrl. */}
            <div className="relative bg-gradient-to-br from-crimson-700/30 via-crimson-900/20 to-charcoal-950 px-6 pt-8 pb-5">
              <div className="flex items-center gap-3">
                <div className="w-14 h-14 rounded-xl bg-charcoal-950 ring-1 ring-white/15 overflow-hidden flex items-center justify-center shrink-0">
                  {clubShell?.logoUrl ? (
                    <img src={clubShell.logoUrl} alt={clubName} className="w-full h-full object-cover" />
                  ) : (
                    <Logo size="md" variant="icon" />
                  )}
                </div>
                <div className="min-w-0">
                  <div className="text-[10px] font-extrabold tracking-widest uppercase text-crimson-300/85">Registration</div>
                  <h1 className="text-xl sm:text-2xl font-black text-bone leading-tight truncate">{season.name}</h1>
                </div>
              </div>
            </div>

            <div className="px-6 py-5 space-y-5">
              <div>
                <p className="text-[13px] text-bone/70 leading-relaxed">
                  Welcome{userData?.name ? `, ${familyFirst}` : ''}. Signing up for {season.name} with {clubName} takes about 3 minutes — answer a few questions, then check out.
                </p>
              </div>

              {/* Status chips — open + question count + fee preview */}
              <div className="flex flex-wrap gap-2">
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-500/15 ring-1 ring-emerald-400/30 text-emerald-200 text-[11px] font-extrabold tracking-widest uppercase">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                  Open
                </span>
                {questionCount > 0 && (
                  <span className="inline-flex items-center px-2.5 py-1 rounded-full bg-white/5 ring-1 ring-white/15 text-bone/80 text-[11px] font-extrabold tracking-widest uppercase">
                    {questionCount} question{questionCount === 1 ? '' : 's'}
                  </span>
                )}
                {effectiveFee > 0 && (
                  <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-crimson-500/15 ring-1 ring-crimson-400/30 text-crimson-200 text-[11px] font-extrabold tracking-widest uppercase">
                    ${(effectiveFee / 100).toFixed(2)} fee
                  </span>
                )}
              </div>

              {returnPlayerId && (
                <div className="rounded-lg bg-emerald-500/10 ring-1 ring-emerald-400/30 px-3 py-2.5 text-[12px] text-emerald-200">
                  Returning family — most of {firstName || 'your player'}'s info is already on file. You'll just confirm and check out.
                </div>
              )}

              <button
                type="button"
                onClick={() => setStep(2)}
                className="w-full py-3.5 rounded-xl font-bold text-base text-white bg-crimson-600 hover:bg-crimson-500 shadow-lg shadow-crimson-900/40 transition-all"
              >
                Register
              </button>
              <p className="text-center text-[11px] text-slate-500">
                By continuing you agree to our{' '}
                <Link to="/privacy" className="underline hover:text-slate-300">Privacy Policy</Link>.
              </p>
            </div>
          </div>
        )}

        {/* ─── STEP 2: FORM ───────────────────────────────────────── */}
        {step === 2 && (
          <div className="bg-white/[0.04] backdrop-blur-2xl ring-1 ring-white/10 rounded-3xl p-5 sm:p-8 space-y-6">
            <header>
              <div className="text-[10px] font-extrabold tracking-widest uppercase text-crimson-400/85 mb-1">Step 2 of 3</div>
              <h2 className="text-2xl font-black text-bone">Tell us about your player</h2>
              <p className="text-[13px] text-bone/65 mt-1">Required fields are marked with an asterisk.</p>
            </header>

            <Section title="Player">
              <Row>
                <Input label="First name" value={firstName} onChange={setFirstName} required />
                <Input label="Last name" value={lastName} onChange={setLastName} required />
              </Row>
              <Row>
                <Input label="Date of birth" type="date" value={dob} onChange={setDob} required />
                <Select label="Age group" value={ageGroup} onChange={setAgeGroup} options={AGE_GROUPS.map(a => ({ value: a, label: a }))} required />
              </Row>
              <Row>
                <Select label="Gender" value={gender} onChange={(v) => setGender(v as any)} options={[
                  { value: 'male', label: 'Male' },
                  { value: 'female', label: 'Female' },
                  { value: 'other', label: 'Other / Prefer not to say' },
                ]} required />
                <Input label="Preferred position (optional)" value={preferredPosition} onChange={setPreferredPosition} placeholder="e.g. Forward" />
              </Row>
              <Row>
                <Input label="Jersey size (optional)" value={jerseySize} onChange={setJerseySize} placeholder="YM, AS, etc." />
                <Checkbox label={`Has played with ${clubName} before`} checked={playedBefore} onChange={setPlayedBefore} />
              </Row>
              <TextArea label="Medical notes (optional)" value={medicalNotes} onChange={setMedicalNotes} placeholder="Allergies, conditions, anything coaches should know." />
            </Section>

            <Section title={parents.length > 1 ? 'Parents / guardians' : 'Parent / guardian'}>
              {parents.map((p, i) => (
                <div key={i} className={i > 0 ? 'pt-4 border-t border-white/10' : ''}>
                  <Row>
                    <Input label="First name" value={p.firstName} onChange={(v) => updateParent(i, { firstName: v })} required={i === 0} />
                    <Input label="Last name" value={p.lastName} onChange={(v) => updateParent(i, { lastName: v })} required={i === 0} />
                  </Row>
                  <Row>
                    <Input label="Email" type="email" value={p.email} onChange={(v) => updateParent(i, { email: v })} required={i === 0} />
                    <Input label="Phone (optional)" type="tel" value={p.phone} onChange={(v) => updateParent(i, { phone: v })} />
                  </Row>
                  <Select
                    label="Relationship"
                    value={p.relationship}
                    onChange={(v) => updateParent(i, { relationship: v as any })}
                    options={[
                      { value: 'mother', label: 'Mother' },
                      { value: 'father', label: 'Father' },
                      { value: 'guardian', label: 'Guardian' },
                      { value: 'other', label: 'Other' },
                    ]}
                  />
                  {i > 0 && (
                    <button
                      type="button"
                      onClick={() => setParents(parents.filter((_, idx) => idx !== i))}
                      className="mt-2 text-xs font-bold uppercase tracking-widest text-rose-300 hover:text-rose-200"
                    >
                      Remove parent
                    </button>
                  )}
                </div>
              ))}
              {parents.length < 2 && (
                <button
                  type="button"
                  onClick={() => setParents([...parents, { firstName: '', lastName: '', email: '', phone: '', relationship: 'father' }])}
                  className="text-sm font-bold text-crimson-400 hover:text-bone"
                >
                  + Add another parent / guardian
                </button>
              )}
            </Section>

            {visibleQuestions.length > 0 && (
              <Section title={(formConfig as any)?.title || 'A few more questions'}>
                {visibleQuestions.map(q => (
                  <CustomQuestion
                    key={q.id}
                    question={q}
                    value={customAnswers[q.id]}
                    onChange={(v) => setCustomAnswers(prev => ({ ...prev, [q.id]: v }))}
                  />
                ))}
              </Section>
            )}

            <NavRow>
              <BackButton onClick={() => setStep(1)} />
              <NextButton
                disabled={!canAdvanceForm}
                onClick={() => setStep(3)}
                label="Next"
              />
            </NavRow>
            {!canAdvanceForm && (
              <p className="text-[11px] text-amber-300/85 -mt-3 text-right">Fill the required fields to continue.</p>
            )}
          </div>
        )}

        {/* ─── STEP 3: CART ───────────────────────────────────────── */}
        {step === 3 && (
          <div className="bg-white/[0.04] backdrop-blur-2xl ring-1 ring-white/10 rounded-3xl p-5 sm:p-8 space-y-5">
            <header>
              <div className="text-[10px] font-extrabold tracking-widest uppercase text-crimson-400/85 mb-1">Step 3 of 3</div>
              <h2 className="text-2xl font-black text-bone">Your cart</h2>
              <p className="text-[13px] text-bone/65 mt-1">{firstName || 'Your player'} — {season.name}</p>
            </header>

            {/* Line item */}
            <div className="rounded-2xl bg-charcoal-950 ring-1 ring-white/10 p-4">
              <div className="flex items-start gap-3">
                <div className="w-10 h-10 rounded-lg bg-crimson-500/15 ring-1 ring-crimson-400/30 text-crimson-300 flex items-center justify-center shrink-0">
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-black text-bone truncate">
                    {activeProduct?.name || 'Registration'}
                  </div>
                  <div className="text-[12px] text-bone/60 mt-0.5">
                    {ageGroup} · {gender}
                  </div>
                </div>
                <div className="text-sm font-black text-bone shrink-0">
                  ${(baseFee / 100).toFixed(2)}
                </div>
              </div>
            </div>

            {/* Payment method — single option for now, mirror the 360Player
                visual so parents recognize the pattern. */}
            <div>
              <h3 className="text-[10px] font-extrabold tracking-widest uppercase text-bone/55 mb-2">How would you like to pay?</h3>
              <div className="rounded-2xl ring-2 ring-crimson-400/60 bg-crimson-500/10 px-4 py-3 flex items-center justify-between gap-3">
                <div className="flex items-center gap-2.5">
                  <span className="w-5 h-5 rounded-full bg-crimson-500 text-white flex items-center justify-center">
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>
                  </span>
                  <span className="text-sm font-bold text-bone">One time</span>
                </div>
                <div className="text-right">
                  <div className="text-sm font-black text-bone">Total ${(effectiveFee / 100).toFixed(2)}</div>
                  <div className="text-[11px] text-bone/55">Due today ${(effectiveFee / 100).toFixed(2)}</div>
                </div>
              </div>
            </div>

            {/* Discount code */}
            {activeProduct && (activeProduct.coupons || []).length > 0 && (
              <div>
                <h3 className="text-[10px] font-extrabold tracking-widest uppercase text-bone/55 mb-2">Discount code</h3>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={couponCode}
                    onChange={(e) => setCouponCode(e.target.value.toUpperCase())}
                    placeholder="EARLYBIRD"
                    className="flex-1 px-3 py-2.5 rounded-lg bg-charcoal-950 text-bone placeholder-bone/40 ring-1 ring-white/10 focus:outline-none focus:ring-2 focus:ring-crimson-400/60 text-sm uppercase tracking-wider"
                    style={{ fontSize: '16px' }}
                  />
                  {quote.couponCode && (
                    <div className="px-3 py-2 rounded-lg bg-emerald-500/15 ring-1 ring-emerald-400/40 text-emerald-200 text-xs font-bold flex items-center">
                      -${(quote.discountCents / 100).toFixed(2)}
                    </div>
                  )}
                </div>
                {couponError && (
                  <p className="text-[11px] text-amber-300 mt-1">{couponError}</p>
                )}
              </div>
            )}

            {/* Order summary */}
            <div className="rounded-2xl bg-charcoal-950 ring-1 ring-white/10 p-4">
              <h3 className="text-[10px] font-extrabold tracking-widest uppercase text-bone/55 mb-3">Order summary</h3>
              <div className="space-y-1.5 text-sm">
                <div className="flex items-center justify-between">
                  <span className="text-bone/75">1x {activeProduct?.name || 'Registration'}</span>
                  <span className="text-bone font-semibold">${(baseFee / 100).toFixed(2)}</span>
                </div>
                {quote.discountCents > 0 && (
                  <div className="flex items-center justify-between">
                    <span className="text-emerald-300/85">Discount {quote.couponCode ? `(${quote.couponCode})` : ''}</span>
                    <span className="text-emerald-300 font-semibold">-${(quote.discountCents / 100).toFixed(2)}</span>
                  </div>
                )}
                {quote.surchargeCents > 0 && (
                  <div className="flex items-center justify-between text-[12px]">
                    <span className="text-bone/55">Processing</span>
                    <span className="text-bone/65">${(quote.surchargeCents / 100).toFixed(2)}</span>
                  </div>
                )}
              </div>
              <div className="mt-3 pt-3 border-t border-white/10 flex items-center justify-between">
                <span className="text-sm font-bold text-bone">Due today</span>
                <span className="text-base font-black text-bone">${(effectiveFee / 100).toFixed(2)}</span>
              </div>
              {quote.surchargeCents > 0 && (
                <p className="text-[10px] text-bone/45 mt-1 text-right">incl. service fee</p>
              )}
            </div>

            {error && (
              <div className="rounded-xl px-4 py-3 bg-rose-500/10 ring-1 ring-rose-500/40 text-rose-200 text-sm">
                {error}
              </div>
            )}

            <NavRow>
              <BackButton onClick={() => setStep(2)} disabled={submitting} />
              <button
                type="button"
                onClick={handleSubmit}
                disabled={!canSubmit}
                className="flex-1 py-3.5 rounded-xl font-bold text-base text-white bg-crimson-600 hover:bg-crimson-500 disabled:opacity-50 disabled:cursor-not-allowed shadow-lg transition-all"
              >
                {submitting ? 'Submitting…' : effectiveFee > 0 ? 'Submit & pay' : 'Submit registration'}
              </button>
            </NavRow>
            <p className="text-center text-[11px] text-slate-500">
              By submitting you agree to our{' '}
              <Link to="/privacy" className="underline hover:text-slate-300">Privacy Policy</Link>.
            </p>
          </div>
        )}
      </div>
    </div>
  );
};

// ── Wizard nav helpers ───────────────────────────────────────────

const NavRow: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="flex items-center gap-3">{children}</div>
);

const BackButton: React.FC<{ onClick: () => void; disabled?: boolean }> = ({ onClick, disabled }) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    className="inline-flex items-center gap-1.5 px-4 py-3.5 rounded-xl bg-white/5 ring-1 ring-white/10 text-bone/85 hover:bg-white/10 disabled:opacity-50 text-sm font-bold"
  >
    <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><polyline points="15 18 9 12 15 6"/></svg>
    Back
  </button>
);

const NextButton: React.FC<{ onClick: () => void; disabled?: boolean; label: string }> = ({ onClick, disabled, label }) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    className="flex-1 inline-flex items-center justify-center gap-1.5 py-3.5 rounded-xl font-bold text-base text-white bg-crimson-600 hover:bg-crimson-500 disabled:opacity-50 disabled:cursor-not-allowed shadow-lg transition-all"
  >
    {label}
    <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><polyline points="9 18 15 12 9 6"/></svg>
  </button>
);

// ── Small input components inline to keep this file self-contained ──

const Section: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div>
    <h2 className="text-[10px] font-extrabold uppercase tracking-widest text-crimson-400/90 mb-3">{title}</h2>
    <div className="space-y-3">{children}</div>
  </div>
);

const Row: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">{children}</div>
);

const Input: React.FC<{ label: string; value: string; onChange: (v: string) => void; type?: string; required?: boolean; placeholder?: string }> = ({ label, value, onChange, type = 'text', required, placeholder }) => (
  <label className="block">
    <span className="block text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-1">
      {label}{required && <span className="text-rose-300 ml-0.5">*</span>}
    </span>
    <input
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      required={required}
      className="w-full px-3 py-2.5 rounded-lg bg-white/5 text-white placeholder-slate-500 ring-1 ring-white/10 focus:outline-none focus:ring-2 focus:ring-crimson-400/60 text-sm"
      style={{ fontSize: '16px' }}
    />
  </label>
);

const TextArea: React.FC<{ label: string; value: string; onChange: (v: string) => void; placeholder?: string }> = ({ label, value, onChange, placeholder }) => (
  <label className="block">
    <span className="block text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-1">{label}</span>
    <textarea
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      rows={3}
      className="w-full px-3 py-2.5 rounded-lg bg-white/5 text-white placeholder-slate-500 ring-1 ring-white/10 focus:outline-none focus:ring-2 focus:ring-crimson-400/60 text-sm"
      style={{ fontSize: '16px' }}
    />
  </label>
);

const Select: React.FC<{ label: string; value: string; onChange: (v: string) => void; options: { value: string; label: string }[]; required?: boolean }> = ({ label, value, onChange, options, required }) => (
  <label className="block">
    <span className="block text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-1">
      {label}{required && <span className="text-rose-300 ml-0.5">*</span>}
    </span>
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full px-3 py-2.5 rounded-lg bg-white/5 text-white ring-1 ring-white/10 focus:outline-none focus:ring-2 focus:ring-crimson-400/60 text-sm"
      style={{ fontSize: '16px' }}
    >
      {options.map(o => <option key={o.value} value={o.value} className="bg-charcoal-900">{o.label}</option>)}
    </select>
  </label>
);

const CustomQuestion: React.FC<{
  question: RegistrationQuestion;
  value: string | number | boolean | undefined;
  onChange: (v: string | number | boolean) => void;
}> = ({ question, value, onChange }) => {
  const required = !!question.required;
  const helpId = question.help ? `${question.id}-help` : undefined;
  const help = question.help ? (
    <p id={helpId} className="text-[11px] text-slate-500 mt-1">{question.help}</p>
  ) : null;

  const labelEl = (
    <span className="block text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-1">
      {question.label}{required && <span className="text-rose-300 ml-0.5">*</span>}
    </span>
  );

  switch (question.type) {
    case 'textarea':
      return (
        <label className="block">
          {labelEl}
          <textarea
            value={(value as string) || ''}
            onChange={(e) => onChange(e.target.value)}
            rows={3}
            required={required}
            className="w-full px-3 py-2.5 rounded-lg bg-white/5 text-white placeholder-slate-500 ring-1 ring-white/10 focus:outline-none focus:ring-2 focus:ring-crimson-400/60 text-sm"
            style={{ fontSize: '16px' }}
          />
          {help}
        </label>
      );
    case 'select':
      return (
        <label className="block">
          {labelEl}
          <select
            value={(value as string) || ''}
            onChange={(e) => onChange(e.target.value)}
            required={required}
            className="w-full px-3 py-2.5 rounded-lg bg-white/5 text-white ring-1 ring-white/10 focus:outline-none focus:ring-2 focus:ring-crimson-400/60 text-sm"
            style={{ fontSize: '16px' }}
          >
            <option value="" className="bg-charcoal-900">— Select —</option>
            {(question.options || []).map(o => (
              <option key={o} value={o} className="bg-charcoal-900">{o}</option>
            ))}
          </select>
          {help}
        </label>
      );
    case 'yes_no':
      return (
        <div>
          {labelEl}
          <div className="flex gap-2">
            {['Yes', 'No'].map(opt => {
              const selected = value === opt;
              return (
                <button
                  key={opt}
                  type="button"
                  onClick={() => onChange(opt)}
                  className={`flex-1 py-2 rounded-lg text-sm font-bold ring-1 transition ${
                    selected
                      ? 'bg-crimson-500 text-white ring-crimson-500'
                      : 'bg-white/5 text-slate-300 ring-white/10 hover:ring-crimson-400/40'
                  }`}
                >
                  {opt}
                </button>
              );
            })}
          </div>
          {help}
        </div>
      );
    case 'number':
      return (
        <label className="block">
          {labelEl}
          <input
            type="number"
            value={value == null ? '' : String(value)}
            onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
            required={required}
            className="w-full px-3 py-2.5 rounded-lg bg-white/5 text-white placeholder-slate-500 ring-1 ring-white/10 focus:outline-none focus:ring-2 focus:ring-crimson-400/60 text-sm"
            style={{ fontSize: '16px' }}
          />
          {help}
        </label>
      );
    case 'text':
    default:
      return (
        <label className="block">
          {labelEl}
          <input
            type="text"
            value={(value as string) || ''}
            onChange={(e) => onChange(e.target.value)}
            required={required}
            className="w-full px-3 py-2.5 rounded-lg bg-white/5 text-white placeholder-slate-500 ring-1 ring-white/10 focus:outline-none focus:ring-2 focus:ring-crimson-400/60 text-sm"
            style={{ fontSize: '16px' }}
          />
          {help}
        </label>
      );
  }
};

const Checkbox: React.FC<{ label: string; checked: boolean; onChange: (v: boolean) => void }> = ({ label, checked, onChange }) => (
  <label className="flex items-end h-full pb-2 gap-2 cursor-pointer">
    <input
      type="checkbox"
      checked={checked}
      onChange={(e) => onChange(e.target.checked)}
      className="w-4 h-4 rounded bg-white/10 border-white/20 text-crimson-500"
    />
    <span className="text-sm text-slate-300">{label}</span>
  </label>
);

const CenterMessage: React.FC<{ title: string; body?: string; success?: boolean }> = ({ title, body, success }) => (
  <div className="min-h-screen bg-gradient-to-br from-charcoal-950 via-charcoal-900 to-black flex items-center justify-center p-6">
    <div className="max-w-md w-full bg-white/[0.04] backdrop-blur ring-1 ring-white/10 rounded-3xl p-8 text-center">
      <div className={`w-14 h-14 mx-auto rounded-full flex items-center justify-center mb-4 ${
        success ? 'bg-emerald-500/20 ring-1 ring-emerald-400/40' : 'bg-white/5 ring-1 ring-white/10'
      }`}>
        {success ? (
          <svg className="w-6 h-6 text-emerald-300" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>
        ) : (
          <svg className="w-6 h-6 text-crimson-400" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        )}
      </div>
      <h1 className="text-xl font-black text-white mb-2">{title}</h1>
      {body && <p className="text-sm text-slate-400 leading-relaxed">{body}</p>}
    </div>
  </div>
);

export default Register;
