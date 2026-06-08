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

  const canSubmit = !!(
    firstName.trim() && lastName.trim() && dob && ageGroup
    && parents[0]?.firstName?.trim()
    && parents[0]?.email?.trim()
    && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(parents[0]?.email || '')
    && season && clubId
    && customAnswersValid
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

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-black px-4 py-8 sm:py-14">
      <div className="max-w-2xl mx-auto">
        <div className="text-center mb-6">
          <div className="inline-flex p-3 rounded-2xl bg-white/5 ring-1 ring-white/10 backdrop-blur mb-4">
            <Logo size="lg" variant="full" />
          </div>
          <h1 className="text-3xl sm:text-4xl font-black text-white">
            {returnPlayerId ? `Welcome back, ${userData?.name?.split(' ')[0] || 'family'}!` : `Welcome, ${userData?.name?.split(' ')[0] || 'family'}!`}
          </h1>
          <p className="text-slate-300 mt-2 text-sm leading-relaxed max-w-md mx-auto">
            {returnPlayerId
              ? `Let's get your player signed up for ${season.name}.`
              : `One last step and you're in. Tell us about your player and you'll join the ${season.name} pool.`}
          </p>
          {(baseFee > 0 || effectiveFee > 0) && (
            <div className="mt-4 inline-flex flex-wrap items-center justify-center gap-2 px-4 py-2 rounded-full bg-cyan-500/10 ring-1 ring-cyan-500/30 text-cyan-200 text-sm">
              <span className="font-bold">${(effectiveFee / 100).toFixed(2)}</span>
              {quote.tier?.label && (
                <span className="text-[11px] uppercase tracking-widest font-extrabold bg-white/10 text-cyan-100 ring-1 ring-white/15 px-2 py-0.5 rounded">
                  {quote.tier.label}
                </span>
              )}
              {quote.discountCents > 0 && (
                <span className="text-[11px] uppercase tracking-widest font-extrabold bg-emerald-500/20 text-emerald-200 ring-1 ring-emerald-400/40 px-2 py-0.5 rounded">
                  Save ${(quote.discountCents / 100).toFixed(2)}
                </span>
              )}
              {quote.surchargeCents > 0 && (
                <span className="text-[11px] text-slate-300/80">
                  incl. ${(quote.surchargeCents / 100).toFixed(2)} processing
                </span>
              )}
            </div>
          )}
        </div>

        <div className="bg-white/[0.04] backdrop-blur-2xl ring-1 ring-white/10 rounded-3xl p-5 sm:p-8 space-y-6">
          {/* Player section */}
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
              <Checkbox label="Has played with Fire FC before" checked={playedBefore} onChange={setPlayedBefore} />
            </Row>
            <TextArea label="Medical notes (optional)" value={medicalNotes} onChange={setMedicalNotes} placeholder="Allergies, conditions, anything coaches should know." />
          </Section>

          {/* Parents section */}
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
                className="text-sm font-bold text-cyan-300 hover:text-cyan-200"
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

          {activeProduct && (activeProduct.coupons || []).length > 0 && (
            <Section title="Promo code (optional)">
              <div className="flex gap-2">
                <input
                  type="text"
                  value={couponCode}
                  onChange={(e) => setCouponCode(e.target.value.toUpperCase())}
                  placeholder="EARLYBIRD"
                  className="flex-1 px-3 py-2.5 rounded-lg bg-white/5 text-white placeholder-slate-500 ring-1 ring-white/10 focus:outline-none focus:ring-2 focus:ring-cyan-400/60 text-sm uppercase tracking-wider"
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
            </Section>
          )}

          {error && (
            <div className="rounded-xl px-4 py-3 bg-rose-500/10 ring-1 ring-rose-500/40 text-rose-200 text-sm">
              {error}
            </div>
          )}

          <button
            type="button"
            onClick={handleSubmit}
            disabled={!canSubmit}
            className="w-full py-4 rounded-xl font-bold text-base text-white bg-gradient-to-r from-cyan-500 via-violet-500 to-fuchsia-500 hover:from-cyan-400 hover:via-violet-400 hover:to-fuchsia-400 disabled:opacity-50 disabled:cursor-not-allowed shadow-lg transition-all"
          >
            {submitting ? 'Submitting…' : effectiveFee > 0 ? `Submit & pay $${(effectiveFee / 100).toFixed(2)}` : 'Submit registration'}
          </button>

          <p className="text-center text-[11px] text-slate-500">
            By registering you agree to our{' '}
            <Link to="/privacy" className="underline hover:text-slate-300">Privacy Policy</Link>.
          </p>
        </div>
      </div>
    </div>
  );
};

// ── Small input components inline to keep this file self-contained ──

const Section: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div>
    <h2 className="text-[10px] font-extrabold uppercase tracking-widest text-cyan-300/90 mb-3">{title}</h2>
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
      className="w-full px-3 py-2.5 rounded-lg bg-white/5 text-white placeholder-slate-500 ring-1 ring-white/10 focus:outline-none focus:ring-2 focus:ring-cyan-400/60 text-sm"
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
      className="w-full px-3 py-2.5 rounded-lg bg-white/5 text-white placeholder-slate-500 ring-1 ring-white/10 focus:outline-none focus:ring-2 focus:ring-cyan-400/60 text-sm"
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
      className="w-full px-3 py-2.5 rounded-lg bg-white/5 text-white ring-1 ring-white/10 focus:outline-none focus:ring-2 focus:ring-cyan-400/60 text-sm"
      style={{ fontSize: '16px' }}
    >
      {options.map(o => <option key={o.value} value={o.value} className="bg-slate-900">{o.label}</option>)}
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
            className="w-full px-3 py-2.5 rounded-lg bg-white/5 text-white placeholder-slate-500 ring-1 ring-white/10 focus:outline-none focus:ring-2 focus:ring-cyan-400/60 text-sm"
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
            className="w-full px-3 py-2.5 rounded-lg bg-white/5 text-white ring-1 ring-white/10 focus:outline-none focus:ring-2 focus:ring-cyan-400/60 text-sm"
            style={{ fontSize: '16px' }}
          >
            <option value="" className="bg-slate-900">— Select —</option>
            {(question.options || []).map(o => (
              <option key={o} value={o} className="bg-slate-900">{o}</option>
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
                      ? 'bg-cyan-500 text-white ring-cyan-500'
                      : 'bg-white/5 text-slate-300 ring-white/10 hover:ring-cyan-400/40'
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
            className="w-full px-3 py-2.5 rounded-lg bg-white/5 text-white placeholder-slate-500 ring-1 ring-white/10 focus:outline-none focus:ring-2 focus:ring-cyan-400/60 text-sm"
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
            className="w-full px-3 py-2.5 rounded-lg bg-white/5 text-white placeholder-slate-500 ring-1 ring-white/10 focus:outline-none focus:ring-2 focus:ring-cyan-400/60 text-sm"
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
      className="w-4 h-4 rounded bg-white/10 border-white/20 text-cyan-500"
    />
    <span className="text-sm text-slate-300">{label}</span>
  </label>
);

const CenterMessage: React.FC<{ title: string; body?: string; success?: boolean }> = ({ title, body, success }) => (
  <div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-black flex items-center justify-center p-6">
    <div className="max-w-md w-full bg-white/[0.04] backdrop-blur ring-1 ring-white/10 rounded-3xl p-8 text-center">
      <div className={`w-14 h-14 mx-auto rounded-full flex items-center justify-center mb-4 ${
        success ? 'bg-emerald-500/20 ring-1 ring-emerald-400/40' : 'bg-white/5 ring-1 ring-white/10'
      }`}>
        {success ? (
          <svg className="w-6 h-6 text-emerald-300" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>
        ) : (
          <svg className="w-6 h-6 text-cyan-300" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        )}
      </div>
      <h1 className="text-xl font-black text-white mb-2">{title}</h1>
      {body && <p className="text-sm text-slate-400 leading-relaxed">{body}</p>}
    </div>
  </div>
);

export default Register;
