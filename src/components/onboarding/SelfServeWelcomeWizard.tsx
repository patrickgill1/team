import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { collection, doc, getDocs, query, updateDoc, where } from 'firebase/firestore';
import { db } from '../../utils/firebase';
import { uploadProfilePhoto } from '../../utils/storage';
import type { Player } from '../../types';

// Post-join welcome flow for team_self_serve_adult joiners. Fires
// once on landing (URL ?welcome=self-serve), then the parent page
// clears the param so a refresh doesn't re-open the modal.
//
// Three steps:
//   1. Set up the kit (photo, jersey #, foot, position)
//   2. Quick tour of Events / Chat / Team Wall
//   3. First match: RSVP inline if there's an upcoming one, else a
//      "you're set" card that points at the calendar.
//
// Every step is skippable and every field is optional. The goal is
// "you landed and here's what to do next," not a data-collection wall.

interface Props {
  player: Player;
  teamId: string;
  uid: string;
  onClose: () => void;
}

type Foot = 'right' | 'left' | 'both' | '';
type RsvpStatus = 'going' | 'maybe' | 'no';

interface NextEvent {
  id: string;
  title: string;
  date: Date;
  type?: string;
}

export default function SelfServeWelcomeWizard({ player, teamId, uid, onClose }: Props) {
  const [step, setStep] = useState<1 | 2 | 3>(1);

  // Step 1 state — kit
  const [photoUrl, setPhotoUrl] = useState<string>(player.profilePhotoUrl || '');
  const [photoUploading, setPhotoUploading] = useState(false);
  const [jerseyNumber, setJerseyNumber] = useState<string>(
    player.jerseyNumber !== undefined && player.jerseyNumber !== null
      ? String(player.jerseyNumber)
      : ''
  );
  const [preferredFoot, setPreferredFoot] = useState<Foot>(
    ((player as any).preferredFoot as Foot) || ''
  );
  const [position, setPosition] = useState<string>((player as any).position || '');
  const [savingKit, setSavingKit] = useState(false);

  // Step 3 state — next event
  const [nextEvent, setNextEvent] = useState<NextEvent | null>(null);
  const [loadingEvent, setLoadingEvent] = useState(true);
  const [rsvpStatus, setRsvpStatus] = useState<RsvpStatus | null>(null);
  const [savingRsvp, setSavingRsvp] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const now = new Date();
        const in30 = new Date(Date.now() + 30 * 24 * 3600 * 1000);
        const q = query(
          collection(db, 'events'),
          where('teamId', '==', teamId),
          where('date', '>=', now),
          where('date', '<=', in30),
        );
        const snap = await getDocs(q);
        const rows = snap.docs
          .map((d) => {
            const data: any = d.data();
            const date: Date = data.date?.toDate ? data.date.toDate() : new Date(data.date);
            return {
              id: d.id,
              title: String(data.title || 'Match'),
              date,
              type: data.type,
              isActive: data.isActive !== false,
            };
          })
          .filter((r) => r.isActive)
          .sort((a, b) => a.date.getTime() - b.date.getTime());
        setNextEvent(rows[0] || null);
      } catch (err) {
        console.warn('[welcome] next-event lookup failed', err);
      } finally {
        setLoadingEvent(false);
      }
    })();
  }, [teamId]);

  const firstName = useMemo(() => (player.name || 'you').split(' ')[0], [player.name]);

  const handlePhotoPick = async (file: File) => {
    if (!file || !player.id) return;
    setPhotoUploading(true);
    try {
      const url = await uploadProfilePhoto(file, player.id, 'player');
      setPhotoUrl(url);
    } catch (err) {
      console.error('[welcome] photo upload failed', err);
      alert("Couldn't upload that photo. Try a different one?");
    } finally {
      setPhotoUploading(false);
    }
  };

  const saveKit = async () => {
    if (!player.id) { setStep(2); return; }
    setSavingKit(true);
    try {
      const patch: Record<string, any> = {};
      if (photoUrl && photoUrl !== player.profilePhotoUrl) patch.profilePhotoUrl = photoUrl;
      const jn = jerseyNumber.trim();
      if (jn !== '') {
        const parsed = parseInt(jn, 10);
        if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 999) patch.jerseyNumber = parsed;
      }
      if (preferredFoot) patch.preferredFoot = preferredFoot;
      if (position.trim()) patch.position = position.trim();
      if (Object.keys(patch).length > 0) {
        await updateDoc(doc(db, 'players', player.id), patch);
      }
      setStep(2);
    } catch (err) {
      console.error('[welcome] save kit failed', err);
      alert("Couldn't save. Skipping ahead — you can update these on your profile later.");
      setStep(2);
    } finally {
      setSavingKit(false);
    }
  };

  const setRsvp = async (status: RsvpStatus) => {
    if (!nextEvent || savingRsvp) return;
    setSavingRsvp(true);
    const prev = rsvpStatus;
    setRsvpStatus(status);
    try {
      await updateDoc(doc(db, 'events', nextEvent.id), {
        [`rsvps.${uid}`]: {
          status,
          respondedAt: new Date(),
          playerId: player.id,
          playerName: player.name,
          role: 'parent',
        },
      });
    } catch (err) {
      console.error('[welcome] rsvp failed', err);
      setRsvpStatus(prev);
      alert("Couldn't save your RSVP. You can do it from the event page.");
    } finally {
      setSavingRsvp(false);
    }
  };

  const finish = () => onClose();

  return (
    <div
      className="fixed inset-0 z-[80] flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm animate-fade-in" /* theme-ok: modal backdrop scrim, dims regardless of theme */
      role="dialog"
      aria-modal="true"
    >
      <div className="w-full sm:max-w-md bg-surface-elevated rounded-t-3xl sm:rounded-3xl ring-1 ring-line-default/15 shadow-2xl overflow-hidden animate-slide-up">
        {/* Progress + step counter */}
        <div className="px-5 pt-5">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[10px] font-black uppercase tracking-widest text-ink-primary/55">
              Welcome, {firstName}
            </span>
            <span className="text-[10px] font-bold tracking-wider text-ink-primary/45">
              {step} of 3
            </span>
          </div>
          <div className="h-1 rounded-full bg-line-default/15 overflow-hidden">
            <div
              className="h-full bg-brand-primary transition-all duration-300"
              style={{ width: `${(step / 3) * 100}%` }}
            />
          </div>
        </div>

        <div className="px-5 pt-4 pb-5 max-h-[80vh] overflow-y-auto">
          {step === 1 && (
            <div>
              <h2 className="text-xl font-black text-ink-primary leading-tight">Set up your kit</h2>
              <p className="text-sm text-ink-primary/65 mt-1 leading-snug">
                Takes about thirty seconds. All optional, all editable later.
              </p>

              <div className="mt-4 flex items-center gap-4">
                <div className="relative shrink-0">
                  {photoUrl ? (
                    <img src={photoUrl} alt="" className="w-20 h-20 rounded-full object-cover ring-2 ring-line-default/25" />
                  ) : (
                    <div className="w-20 h-20 rounded-full bg-line-default/10 ring-2 ring-line-default/25 flex items-center justify-center text-3xl font-black text-ink-primary/50">
                      {firstName.charAt(0)}
                    </div>
                  )}
                  {photoUploading && (
                    <div className="absolute inset-0 rounded-full bg-black/40 flex items-center justify-center"> {/* theme-ok: photo-upload spinner overlay, dims regardless of theme */}
                      <svg className="w-5 h-5 animate-spin text-white" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" strokeDasharray="60" strokeDashoffset="20" strokeLinecap="round" /></svg> {/* theme-ok: on dark overlay */}
                    </div>
                  )}
                </div>
                <label className="inline-flex items-center gap-1.5 px-3 py-2 rounded-full bg-brand-primary/15 ring-1 ring-brand-primary-soft/40 text-brand-primary hover:bg-brand-primary/25 text-xs font-bold cursor-pointer transition">
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                    <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                    <circle cx="12" cy="13" r="4" />
                  </svg>
                  {photoUrl ? 'Change photo' : 'Add photo'}
                  <input
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(e) => e.target.files?.[0] && handlePhotoPick(e.target.files[0])}
                  />
                </label>
              </div>

              <div className="mt-5 grid grid-cols-2 gap-3">
                <label className="block">
                  <span className="text-[10px] font-black uppercase tracking-widest text-ink-primary/55">Jersey #</span>
                  <input
                    type="number"
                    inputMode="numeric"
                    min={0}
                    max={999}
                    value={jerseyNumber}
                    onChange={(e) => setJerseyNumber(e.target.value)}
                    className="mt-1 w-full px-3 py-2 rounded-xl bg-line-default/[0.06] ring-1 ring-line-default/15 focus:ring-brand-primary-soft outline-none text-ink-primary text-base font-bold"
                    placeholder="7"
                  />
                </label>
                <label className="block">
                  <span className="text-[10px] font-black uppercase tracking-widest text-ink-primary/55">Preferred foot</span>
                  <select
                    value={preferredFoot}
                    onChange={(e) => setPreferredFoot(e.target.value as Foot)}
                    className="mt-1 w-full px-3 py-2 rounded-xl bg-line-default/[0.06] ring-1 ring-line-default/15 focus:ring-brand-primary-soft outline-none text-ink-primary text-base font-bold"
                  >
                    <option value=""></option>
                    <option value="right">Right</option>
                    <option value="left">Left</option>
                    <option value="both">Both</option>
                  </select>
                </label>
              </div>

              <label className="block mt-3">
                <span className="text-[10px] font-black uppercase tracking-widest text-ink-primary/55">Position</span>
                <input
                  type="text"
                  value={position}
                  onChange={(e) => setPosition(e.target.value)}
                  className="mt-1 w-full px-3 py-2 rounded-xl bg-line-default/[0.06] ring-1 ring-line-default/15 focus:ring-brand-primary-soft outline-none text-ink-primary text-base"
                  placeholder="Center back, midfielder, striker..."
                />
              </label>

              <div className="mt-5 flex items-center justify-between gap-3">
                <button
                  type="button"
                  onClick={() => setStep(2)}
                  className="text-xs font-bold text-ink-primary/55 hover:text-ink-primary"
                >
                  Skip for now
                </button>
                <button
                  type="button"
                  onClick={saveKit}
                  disabled={savingKit || photoUploading}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full bg-brand-primary text-white text-sm font-bold hover:bg-brand-primary/90 disabled:opacity-50 transition" /* theme-ok: text-white on brand-primary CTA, red in both themes */
                >
                  {savingKit ? 'Saving...' : 'Next'}
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24"><polyline points="9 6 15 12 9 18" /></svg>
                </button>
              </div>
            </div>
          )}

          {step === 2 && (
            <div>
              <h2 className="text-xl font-black text-ink-primary leading-tight">How the app works</h2>
              <p className="text-sm text-ink-primary/65 mt-1 leading-snug">
                Three tabs do the heavy lifting.
              </p>

              <ul className="mt-4 space-y-3">
                <li className="flex items-start gap-3 p-3 rounded-2xl bg-line-default/[0.05] ring-1 ring-line-default/10">
                  <span className="shrink-0 mt-0.5 inline-flex items-center justify-center w-9 h-9 rounded-xl bg-brand-primary/15 text-brand-primary ring-1 ring-brand-primary-soft/30">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="18" rx="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" /></svg>
                  </span>
                  <div className="min-w-0">
                    <div className="text-sm font-bold text-ink-primary">Events</div>
                    <div className="text-xs text-ink-primary/65 leading-snug">Tap Going, Maybe, or No so the coach knows who to expect.</div>
                  </div>
                </li>
                <li className="flex items-start gap-3 p-3 rounded-2xl bg-line-default/[0.05] ring-1 ring-line-default/10">
                  <span className="shrink-0 mt-0.5 inline-flex items-center justify-center w-9 h-9 rounded-xl bg-brand-primary/15 text-brand-primary ring-1 ring-brand-primary-soft/30">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
                  </span>
                  <div className="min-w-0">
                    <div className="text-sm font-bold text-ink-primary">Chat</div>
                    <div className="text-xs text-ink-primary/65 leading-snug">Team-wide thread, plus DMs. The coach uses this for last-minute stuff.</div>
                  </div>
                </li>
                <li className="flex items-start gap-3 p-3 rounded-2xl bg-line-default/[0.05] ring-1 ring-line-default/10">
                  <span className="shrink-0 mt-0.5 inline-flex items-center justify-center w-9 h-9 rounded-xl bg-brand-primary/15 text-brand-primary ring-1 ring-brand-primary-soft/30">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><path d="M4 22V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v16" /><line x1="4" y1="10" x2="20" y2="10" /><line x1="10" y1="4" x2="10" y2="22" /></svg>
                  </span>
                  <div className="min-w-0">
                    <div className="text-sm font-bold text-ink-primary">Team Wall</div>
                    <div className="text-xs text-ink-primary/65 leading-snug">Goals, clips, and shoutouts land here. Drop yours in too.</div>
                  </div>
                </li>
              </ul>

              <div className="mt-5 flex items-center justify-between gap-3">
                <button
                  type="button"
                  onClick={() => setStep(1)}
                  className="text-xs font-bold text-ink-primary/55 hover:text-ink-primary inline-flex items-center gap-1"
                >
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24"><polyline points="15 18 9 12 15 6" /></svg>
                  Back
                </button>
                <button
                  type="button"
                  onClick={() => setStep(3)}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full bg-brand-primary text-white text-sm font-bold hover:bg-brand-primary/90 transition" /* theme-ok: text-white on brand-primary CTA, red in both themes */
                >
                  Next
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24"><polyline points="9 6 15 12 9 18" /></svg>
                </button>
              </div>
            </div>
          )}

          {step === 3 && (
            <div>
              <h2 className="text-xl font-black text-ink-primary leading-tight">
                {nextEvent ? "Your next match" : "You're all set"}
              </h2>
              <p className="text-sm text-ink-primary/65 mt-1 leading-snug">
                {nextEvent
                  ? "Tap what you know. Change it any time from the event page."
                  : "Nothing on the schedule yet. It'll show up on your home tab as soon as the coach posts one."}
              </p>

              {loadingEvent && (
                <div className="mt-4 p-4 rounded-2xl bg-line-default/[0.05] ring-1 ring-line-default/10">
                  <div className="h-3 w-24 rounded bg-line-default/15 mb-2" />
                  <div className="h-4 w-40 rounded bg-line-default/15" />
                </div>
              )}

              {!loadingEvent && nextEvent && (
                <div className="mt-4 p-4 rounded-2xl bg-line-default/[0.05] ring-1 ring-line-default/10">
                  <div className="text-[10px] font-black uppercase tracking-widest text-ink-primary/55">
                    {nextEvent.type === 'match' || nextEvent.type === 'game' ? 'Match' : nextEvent.type === 'practice' ? 'Practice' : 'Event'}
                  </div>
                  <div className="text-base font-bold text-ink-primary mt-0.5">{nextEvent.title}</div>
                  <div className="text-xs text-ink-primary/65 mt-0.5">
                    {nextEvent.date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}
                    {' at '}
                    {nextEvent.date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
                  </div>

                  <div className="mt-4 grid grid-cols-3 gap-2">
                    {(['going', 'maybe', 'no'] as RsvpStatus[]).map((s) => {
                      const isActive = rsvpStatus === s;
                      const label = s === 'going' ? "I'm in" : s === 'maybe' ? 'Maybe' : "Can't make it";
                      const activeClass = s === 'going'
                        ? 'bg-emerald-600 text-white ring-emerald-500' /* theme-ok: RSVP semantic pill */
                        : s === 'maybe'
                        ? 'bg-amber-500 text-charcoal-950 ring-amber-400' /* theme-ok: RSVP semantic pill */
                        : 'bg-brand-primary text-white ring-brand-primary'; /* theme-ok: RSVP semantic pill */
                      return (
                        <button
                          key={s}
                          type="button"
                          onClick={() => setRsvp(s)}
                          disabled={savingRsvp}
                          className={`py-2 rounded-xl text-xs font-bold ring-1 transition disabled:opacity-50 ${
                            isActive
                              ? activeClass
                              : 'bg-line-default/[0.05] ring-line-default/15 text-ink-primary hover:bg-line-default/10'
                          }`}
                        >
                          {label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {!loadingEvent && !nextEvent && (
                <div className="mt-4 p-4 rounded-2xl bg-line-default/[0.05] ring-1 ring-line-default/10 text-sm text-ink-primary/75 leading-snug">
                  <Link to="/calendar" className="text-brand-primary-soft font-bold" onClick={finish}>
                    Peek at the calendar &rarr;
                  </Link>
                </div>
              )}

              <div className="mt-5 flex items-center justify-between gap-3">
                <button
                  type="button"
                  onClick={() => setStep(2)}
                  className="text-xs font-bold text-ink-primary/55 hover:text-ink-primary inline-flex items-center gap-1"
                >
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24"><polyline points="15 18 9 12 15 6" /></svg>
                  Back
                </button>
                <button
                  type="button"
                  onClick={finish}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full bg-brand-primary text-white text-sm font-bold hover:bg-brand-primary/90 transition" /* theme-ok: text-white on brand-primary CTA, red in both themes */
                >
                  Let's go
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
