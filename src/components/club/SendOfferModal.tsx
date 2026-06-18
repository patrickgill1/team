import React, { useEffect, useMemo, useState } from 'react';
import { collection, doc, getDocs, query, serverTimestamp, setDoc, updateDoc, where } from 'firebase/firestore';
import { db } from '../../utils/firebase';
import { sendEmail, sendPushToParentEmails, type CoachSignature } from '../../utils/notify';
import { logActivity } from '../../utils/activityLog';
import { getShareOrigin } from '../../utils/origin';
import type { OfferLetter, OfferTemplate, Registration } from '../../types';
import { uploadToStream, streamIframeUrl } from '../../utils/streamUpload';

// Coach-facing "Offer a roster spot" modal. Composes the offer text +
// position + jersey, picks a team the coach owns, generates a unique
// OfferLetter doc, emails the parent a /offer/<id> link, and logs the
// activity. Acceptance happens on the public page; this just sends.

interface Team {
  id: string;
  name: string;
  ageGroup?: string;
  clubId?: string;
}

interface Props {
  registration: Registration;
  myUid: string;
  myName: string;
  signature?: CoachSignature;
  onClose: () => void;
  onSent: (offerId: string) => void;
}

const DEFAULT_TEMPLATE = (playerName: string, teamName: string) =>
  `Hi! On behalf of ${teamName}, we'd love to offer ${playerName} a spot on the team for the upcoming season.\n\n` +
  `You'll find acceptance details below. If you have any questions, just reply to this email.\n\n` +
  `Looking forward to a great season.`;

const SendOfferModal: React.FC<Props> = ({ registration, myUid, myName, signature, onClose, onSent }) => {
  const [teams, setTeams] = useState<Team[]>([]);
  const [teamId, setTeamId] = useState<string>('');
  const [position, setPosition] = useState(registration.player?.preferredPosition || '');
  const [jersey, setJersey] = useState<string>('');
  const [feeCents, setFeeCents] = useState<number>(0);
  const [message, setMessage] = useState('');
  const [messageTouched, setMessageTouched] = useState(false);
  const [expiresDays, setExpiresDays] = useState<number>(7);
  const [templates, setTemplates] = useState<OfferTemplate[]>([]);
  const [videoUid, setVideoUid] = useState<string>('');
  const [uploadingVideo, setUploadingVideo] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load teams + templates in the club.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [teamSnap, tplSnap] = await Promise.all([
          getDocs(query(collection(db, 'teams'), where('clubId', '==', registration.clubId))),
          getDocs(query(collection(db, 'offer_templates'), where('clubId', '==', registration.clubId), where('isActive', '==', true))),
        ]);
        if (cancelled) return;
        const list = teamSnap.docs.map(d => ({ id: d.id, ...(d.data() as any) } as Team));
        setTeams(list);
        setTemplates(tplSnap.docs.map(d => ({ id: d.id, ...(d.data() as any) } as OfferTemplate)));
        const ageMatch = list.find(t => t.ageGroup && registration.player?.ageGroup && t.ageGroup === registration.player.ageGroup);
        setTeamId(ageMatch?.id || list[0]?.id || '');
      } catch (err) {
        console.warn('teams/templates load failed', err);
      }
    })();
    return () => { cancelled = true; };
  }, [registration.clubId, registration.player?.ageGroup]);

  // Templates that match the current team + position. Empty scope on
  // the template means "any" so it always appears.
  const matchingTemplates = useMemo(() => {
    const pos = (position || '').toLowerCase().trim();
    return templates.filter(t => {
      if (t.teamId && t.teamId !== teamId) return false;
      if (t.position && t.position.toLowerCase().trim() !== pos) return false;
      return true;
    });
  }, [templates, teamId, position]);

  const applyTemplate = (id: string) => {
    const tpl = templates.find(t => t.id === id);
    if (!tpl) return;
    setMessage(tpl.message);
    setMessageTouched(true);
  };

  // Re-template the message when team changes (only if user hasn't typed yet).
  const selectedTeam = useMemo(() => teams.find(t => t.id === teamId), [teams, teamId]);
  useEffect(() => {
    if (!messageTouched && selectedTeam) {
      const fullName = `${registration.player?.firstName || ''} ${registration.player?.lastName || ''}`.trim();
      setMessage(DEFAULT_TEMPLATE(fullName, selectedTeam.name));
    }
  }, [selectedTeam]); // eslint-disable-line react-hooks/exhaustive-deps

  const canSend = !!(teamId && message.trim() && !sending);

  const handleSend = async () => {
    if (!canSend || !selectedTeam) return;
    setSending(true);
    setError(null);
    try {
      const parentEmail = registration.parents?.[0]?.email?.toLowerCase().trim();
      if (!parentEmail) throw new Error('no-parent-email');
      const fullName = `${registration.player?.firstName || ''} ${registration.player?.lastName || ''}`.trim();

      const id = `off_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const expiresAt = addDays(new Date(), Math.max(1, expiresDays));
      const offer: Omit<OfferLetter, 'id' | 'createdAt'> & { createdAt: any } = {
        clubId: registration.clubId,
        registrationId: registration.id,
        playerName: fullName,
        parentEmail,
        teamId,
        teamName: selectedTeam.name,
        coachUid: myUid,
        coachName: myName,
        message: message.trim(),
        offerPosition: position.trim() || undefined,
        offerJerseyNumber: jersey.trim() ? Number(jersey) : undefined,
        feeCents: feeCents > 0 ? Math.round(feeCents) : undefined,
        expiresAt,
        videoStreamUid: videoUid || undefined,
        videoStreamReady: videoUid ? true : undefined,
        status: 'sent',
        createdAt: serverTimestamp(),
      };
      await setDoc(doc(db, 'offers', id), offer);

      // Mark the registration so other coaches see "offer sent."
      try {
        await updateDoc(doc(db, 'registrations', registration.id), {
          status: 'offer_sent',
          updatedAt: serverTimestamp(),
        });
      } catch {/* fine — coach may not have write on Registration; offer is the source of truth */}

      // Email the parent the unique link.
      const origin = getShareOrigin();
      const offerUrl = `${origin}/offer/${id}`;
      const subject = `${selectedTeam.name} has offered ${fullName} a roster spot`;
      const safeMsg = message.trim().replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br/>');
      const html = `
        <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;padding:24px;background:#0f172a;color:#e2e8f0;">
          <div style="max-width:560px;margin:0 auto;background:#fff;color:#0f172a;border-radius:16px;overflow:hidden;">
            <div style="padding:24px;border-bottom:3px solid #06b6d4;text-align:center;background:#0f172a;color:#fff;">
              <div style="font-weight:900;letter-spacing:2.5px;font-size:18px;text-transform:uppercase;">Roster offer</div>
            </div>
            <div style="padding:24px;">
              <h2 style="margin:0 0 8px;font-size:22px;color:#0f172a;">${selectedTeam.name}</h2>
              <p style="margin:0 0 16px;color:#475569;">For <b>${fullName}</b></p>
              <div style="padding:14px 16px;background:#f0f9ff;border-left:3px solid #06b6d4;border-radius:8px;color:#0c4a6e;line-height:1.6;font-size:15px;">${safeMsg}</div>
              <p style="margin:20px 0 14px;">
                <a href="${offerUrl}" style="display:inline-block;background:#06b6d4;color:#fff;text-decoration:none;padding:12px 28px;border-radius:10px;font-weight:700;">Open offer</a>
              </p>
              <p style="font-size:11px;color:#94a3b8;margin:8px 0 0;">Offer expires ${expiresAt.toLocaleDateString()}.</p>
            </div>
          </div>
        </div>`;
      await sendEmail({ to: parentEmail, subject, html });

      // Push — most important transition in the whole funnel. The
      // family who hooked up a Fire FC account sees this on their
      // lock screen the moment the offer goes out.
      const allParentEmails = (registration.parents || [])
        .map(p => p.email)
        .filter(Boolean) as string[];
      void sendPushToParentEmails(
        allParentEmails.length > 0 ? allParentEmails : [parentEmail],
        {
          title: `${selectedTeam.name} just offered ${fullName} a spot!`,
          body: 'Tap to open the offer and respond.',
          url: `/offer/${id}`,
        }
      );

      // Activity log.
      await logActivity({
        clubId: registration.clubId,
        kind: 'offer_sent',
        registrationId: registration.id,
        seasonId: registration.seasonId,
        teamId,
        parentEmail,
        actorUid: myUid,
        actorName: myName,
        payload: {
          offerId: id,
          playerName: fullName,
          teamName: selectedTeam.name,
          position: position.trim() || undefined,
          jersey: jersey.trim() || undefined,
          feeCents: feeCents > 0 ? feeCents : undefined,
        },
      });

      onSent(id);
    } catch (err: any) {
      console.error('send offer failed', err);
      setError(err?.message || 'Send failed.');
    } finally {
      setSending(false);
    }
  };
  void signature;

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-end sm:items-center justify-center p-0 sm:p-6 overflow-y-auto">
      <div className="bg-white w-full sm:max-w-xl sm:rounded-2xl overflow-hidden flex flex-col max-h-[100vh]">
        <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
          <div>
            <h2 className="font-black text-charcoal-950">Send offer</h2>
            <p className="text-[11px] text-slate-500">{registration.player?.firstName} {registration.player?.lastName}</p>
          </div>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-700 text-2xl leading-none">×</button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          <label className="block">
            <span className="block text-[10px] font-extrabold uppercase tracking-widest text-slate-600 mb-1">Team</span>
            <select
              value={teamId}
              onChange={(e) => setTeamId(e.target.value)}
              className="w-full px-3 py-2 rounded-lg ring-1 ring-slate-200 focus:ring-2 focus:ring-crimson-400 text-sm"
            >
              {teams.map(t => <option key={t.id} value={t.id}>{t.name}{t.ageGroup ? ` (${t.ageGroup})` : ''}</option>)}
            </select>
          </label>

          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="block text-[10px] font-extrabold uppercase tracking-widest text-slate-600 mb-1">Position (optional)</span>
              <input value={position} onChange={(e) => setPosition(e.target.value)} placeholder="Forward" className="w-full px-3 py-2 rounded-lg ring-1 ring-slate-200 focus:ring-2 focus:ring-crimson-400 text-sm" />
            </label>
            <label className="block">
              <span className="block text-[10px] font-extrabold uppercase tracking-widest text-slate-600 mb-1">Jersey # (optional)</span>
              <input value={jersey} onChange={(e) => setJersey(e.target.value)} type="number" placeholder="10" className="w-full px-3 py-2 rounded-lg ring-1 ring-slate-200 focus:ring-2 focus:ring-crimson-400 text-sm" />
            </label>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="block text-[10px] font-extrabold uppercase tracking-widest text-slate-600 mb-1">Fee owed at accept (USD, optional)</span>
              <input
                value={feeCents === 0 ? '' : (feeCents / 100).toString()}
                onChange={(e) => setFeeCents(Math.round(Number(e.target.value) * 100))}
                type="number"
                step="0.01"
                min={0}
                placeholder="0.00"
                className="w-full px-3 py-2 rounded-lg ring-1 ring-slate-200 focus:ring-2 focus:ring-crimson-400 text-sm"
              />
            </label>
            <label className="block">
              <span className="block text-[10px] font-extrabold uppercase tracking-widest text-slate-600 mb-1">Expires in (days)</span>
              <input
                value={expiresDays}
                onChange={(e) => setExpiresDays(Math.max(1, Number(e.target.value) || 1))}
                type="number"
                min={1}
                max={60}
                className="w-full px-3 py-2 rounded-lg ring-1 ring-slate-200 focus:ring-2 focus:ring-crimson-400 text-sm"
              />
            </label>
          </div>

          {matchingTemplates.length > 0 && (
            <label className="block">
              <span className="block text-[10px] font-extrabold uppercase tracking-widest text-slate-600 mb-1">Template (optional)</span>
              <select
                value=""
                onChange={(e) => { if (e.target.value) applyTemplate(e.target.value); }}
                className="w-full px-3 py-2 rounded-lg ring-1 ring-slate-200 focus:ring-2 focus:ring-crimson-400 text-sm"
              >
                <option value="">— Pick a template to load —</option>
                {matchingTemplates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </label>
          )}

          <label className="block">
            <span className="block text-[10px] font-extrabold uppercase tracking-widest text-slate-600 mb-1">Message to the family</span>
            <textarea
              value={message}
              onChange={(e) => { setMessage(e.target.value); setMessageTouched(true); }}
              rows={8}
              className="w-full px-3 py-2 rounded-lg ring-1 ring-slate-200 focus:ring-2 focus:ring-crimson-400 text-sm leading-relaxed"
            />
          </label>

          <div>
            <span className="block text-[10px] font-extrabold uppercase tracking-widest text-slate-600 mb-1">Welcome video (optional)</span>
            {videoUid ? (
              <div className="rounded-lg bg-emerald-50 ring-1 ring-emerald-200 p-3 flex items-center justify-between">
                <div className="min-w-0">
                  <div className="text-xs font-bold text-emerald-800">Video attached</div>
                  <div className="text-[10px] text-emerald-700 truncate">Stream uid: {videoUid.slice(0, 16)}…</div>
                </div>
                <button type="button" onClick={() => setVideoUid('')} className="text-[11px] font-bold text-rose-600 hover:text-rose-800">
                  Remove
                </button>
              </div>
            ) : uploadingVideo ? (
              <div className="rounded-lg bg-crimson-50 ring-1 ring-crimson-200 p-3">
                <div className="text-xs text-crimson-800 font-bold mb-2">Uploading… {uploadProgress}%</div>
                <div className="h-1.5 rounded-full bg-crimson-100 overflow-hidden">
                  <div className="h-full bg-crimson-500" style={{ width: `${uploadProgress}%` }} />
                </div>
              </div>
            ) : (
              <label className="block">
                <input
                  type="file"
                  accept="video/*"
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    setUploadingVideo(true); setUploadProgress(0); setError(null);
                    try {
                      const res = await uploadToStream(file, { name: `Offer video — ${registration.player.firstName}` }, (pct) => setUploadProgress(pct));
                      setVideoUid(res.uid);
                    } catch (err: any) {
                      setError(err?.message || 'Upload failed.');
                    } finally {
                      setUploadingVideo(false);
                    }
                  }}
                  className="block w-full text-xs text-slate-600 file:mr-2 file:px-3 file:py-1.5 file:rounded file:ring-1 file:ring-slate-200 file:bg-white file:text-slate-700 file:font-bold file:hover:bg-slate-50 file:cursor-pointer"
                />
                <p className="text-[10px] text-slate-500 mt-1">A short clip from you welcoming the player. Renders on the offer page they open from the email.</p>
              </label>
            )}
          </div>

          {error && (
            <div className="rounded-lg bg-rose-50 ring-1 ring-rose-300 px-3 py-2 text-sm text-rose-700">{error}</div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-gray-100 flex items-center justify-end gap-2">
          <button type="button" onClick={onClose} className="px-3 py-2 rounded-lg text-sm font-bold text-slate-600 hover:text-slate-900">Cancel</button>
          <button
            type="button"
            disabled={!canSend}
            onClick={handleSend}
            className="px-4 py-2 rounded-lg bg-crimson-600 hover:bg-crimson-500 disabled:opacity-50 text-white text-sm font-bold"
          >
            {sending ? 'Sending…' : 'Send offer'}
          </button>
        </div>
      </div>
    </div>
  );
};

function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

export default SendOfferModal;
