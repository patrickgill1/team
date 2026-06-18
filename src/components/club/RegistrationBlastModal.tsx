import React, { useEffect, useMemo, useState } from 'react';
import { collection, getDocs, query, where } from 'firebase/firestore';
import { db } from '../../utils/firebase';
import { sendEmailBatch, tplRegistrationOpen, type CoachSignature, type NotifyMessage } from '../../utils/notify';
import { logActivity } from '../../utils/activityLog';
import { getShareOrigin } from '../../utils/origin';

// Blast modal for the Registrations admin page. Resolves recipients by
// walking active players in the club, grouping by family (dedupe by
// parent email across multi-kid households), and firing one email per
// family with a pre-filled /register link. Each send writes an
// `email_sent` activity for the CRM timeline.

interface Family {
  // Stable key — first parent email lowercase. We dedupe on this so a
  // family with two kids gets one email, not two.
  key: string;
  parentEmail: string;
  parentName: string;
  // Each child their parents have; we pick the first to fill the
  // ?return= link (the parent can register the others from the form).
  children: Array<{ playerId: string; playerName: string; ageGroup?: string }>;
}

interface Props {
  clubId: string;
  seasons: Array<{ id: string; name: string; ageGroup?: string }>;
  defaultSeasonId?: string;
  signature?: CoachSignature;
  onClose: () => void;
  onSent: (count: number) => void;
}

const RegistrationBlastModal: React.FC<Props> = ({ clubId, seasons, defaultSeasonId, signature, onClose, onSent }) => {
  const [seasonId, setSeasonId] = useState(defaultSeasonId || seasons[0]?.id || '');
  const [ageFilter, setAgeFilter] = useState<string[]>([]);
  const [allFamilies, setAllFamilies] = useState<Family[]>([]);
  const [allAgeGroups, setAllAgeGroups] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [customIntro, setCustomIntro] = useState('');
  const [customSignoff, setCustomSignoff] = useState('');
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Pull all teams in the club + all active players, build family list.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        // Teams in the club — give us the teamId → ageGroup map.
        const teamsSnap = await getDocs(query(collection(db, 'teams'), where('clubId', '==', clubId)));
        const teamAge = new Map<string, string>();
        teamsSnap.forEach(d => {
          const data = d.data() as any;
          if (data.ageGroup) teamAge.set(d.id, data.ageGroup);
        });

        // Active players in the club. We query by teamId IN [...] but
        // Firestore caps that at 30 — for clubs with more than 30 teams
        // we'd batch. Fire FC scale: handful of teams, fine.
        const teamIds = Array.from(teamAge.keys());
        if (teamIds.length === 0) {
          if (!cancelled) { setAllFamilies([]); setAllAgeGroups([]); }
          return;
        }
        const players: any[] = [];
        for (let i = 0; i < teamIds.length; i += 30) {
          const chunk = teamIds.slice(i, i + 30);
          const snap = await getDocs(query(
            collection(db, 'players'),
            where('teamId', 'in', chunk),
            where('isActive', '==', true),
          ));
          snap.forEach(d => players.push({ id: d.id, ...(d.data() as any) }));
        }

        // Build family map.
        const families = new Map<string, Family>();
        for (const p of players) {
          const emails: string[] = Array.isArray(p.parentEmails) ? p.parentEmails : [];
          if (emails.length === 0) continue;
          const primary = String(emails[0] || '').trim().toLowerCase();
          if (!primary) continue;
          const child = {
            playerId: p.id,
            playerName: p.name || `${p.firstName || ''} ${p.lastName || ''}`.trim() || 'Player',
            ageGroup: teamAge.get(p.teamId),
          };
          const existing = families.get(primary);
          if (existing) {
            existing.children.push(child);
          } else {
            families.set(primary, {
              key: primary,
              parentEmail: primary,
              parentName: p.parentNames?.[0] || '',
              children: [child],
            });
          }
        }

        const ages = Array.from(new Set(Array.from(teamAge.values()))).sort();
        if (!cancelled) {
          setAllFamilies(Array.from(families.values()));
          setAllAgeGroups(ages);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [clubId]);

  // Apply the age-group filter — a family is included if ANY of its
  // children's teams match. Empty filter = everyone.
  const recipients = useMemo(() => {
    if (ageFilter.length === 0) return allFamilies;
    const ages = new Set(ageFilter);
    return allFamilies.filter(f => f.children.some(c => c.ageGroup && ages.has(c.ageGroup)));
  }, [allFamilies, ageFilter]);

  const handleSend = async () => {
    if (recipients.length === 0 || !seasonId) return;
    setSending(true);
    setError(null);
    setResult(null);
    try {
      const season = seasons.find(s => s.id === seasonId);
      const seasonName = season?.name || 'the new season';
      const baseOrigin = getShareOrigin();

      const messages: NotifyMessage[] = recipients.map(f => {
        const firstChild = f.children[0];
        const registerUrl = `${baseOrigin}/register?return=${encodeURIComponent(firstChild.playerId)}&season=${encodeURIComponent(seasonId)}`;
        const { subject, html } = tplRegistrationOpen({
          playerName: f.children.length > 1 ? `${firstChild.playerName} and family` : firstChild.playerName,
          seasonName,
          registerUrl,
          customIntro: customIntro.trim() || undefined,
          customSignoff: customSignoff.trim() || undefined,
          signature,
        });
        return { to: f.parentEmail, subject, html };
      });

      const ok = await sendEmailBatch(messages);
      if (!ok) {
        setError('Send failed. Check the worker logs.');
        return;
      }

      // Log one activity per family so the CRM timeline shows the touch.
      await Promise.all(recipients.map(f => logActivity({
        clubId,
        kind: 'email_sent',
        parentEmail: f.parentEmail,
        seasonId,
        payload: {
          subject: `Registration is open for ${seasons.find(s => s.id === seasonId)?.name || ''}`,
          channel: 'registration_blast',
          childCount: f.children.length,
        },
      })));

      setResult(`Sent to ${recipients.length} famil${recipients.length === 1 ? 'y' : 'ies'}.`);
      onSent(recipients.length);
    } catch (err: any) {
      console.error('blast failed', err);
      setError(err?.message || 'Send failed.');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-end sm:items-center justify-center p-0 sm:p-6 overflow-y-auto">
      <div className="bg-white w-full sm:max-w-2xl sm:rounded-2xl overflow-hidden flex flex-col max-h-[100vh]">
        <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
          <h2 className="font-black text-charcoal-950">Push registration email</h2>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-700 text-2xl leading-none">×</button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          <label className="block">
            <span className="block text-[10px] font-extrabold uppercase tracking-widest text-slate-600 mb-1">Season</span>
            <select
              value={seasonId}
              onChange={(e) => setSeasonId(e.target.value)}
              className="w-full px-3 py-2 rounded-lg ring-1 ring-slate-200 focus:ring-2 focus:ring-crimson-400 text-sm"
            >
              {seasons.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>

          {loading ? (
            <p className="text-sm text-slate-500">Loading families…</p>
          ) : (
            <>
              <div>
                <div className="text-[10px] font-extrabold uppercase tracking-widest text-slate-600 mb-1">
                  Age groups <span className="text-slate-400 normal-case font-normal">(none = all)</span>
                </div>
                {allAgeGroups.length === 0 ? (
                  <p className="text-[11px] text-slate-500">No teams have age groups set yet.</p>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {allAgeGroups.map(ag => {
                      const on = ageFilter.includes(ag);
                      return (
                        <button
                          key={ag}
                          type="button"
                          onClick={() => setAgeFilter(on ? ageFilter.filter(x => x !== ag) : [...ageFilter, ag])}
                          className={`px-2.5 py-1 rounded text-[11px] font-bold ring-1 ${
                            on
                              ? 'bg-crimson-600 text-white ring-crimson-600'
                              : 'bg-white text-slate-600 ring-slate-200 hover:ring-crimson-400'
                          }`}
                        >
                          {ag}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

              <label className="block">
                <span className="block text-[10px] font-extrabold uppercase tracking-widest text-slate-600 mb-1">
                  Custom intro (optional)
                </span>
                <textarea
                  value={customIntro}
                  onChange={(e) => setCustomIntro(e.target.value)}
                  rows={3}
                  placeholder="e.g. Hey families! Spring tryouts are May 14–15..."
                  className="w-full px-3 py-2 rounded-lg ring-1 ring-slate-200 focus:ring-2 focus:ring-crimson-400 text-sm"
                />
              </label>

              <label className="block">
                <span className="block text-[10px] font-extrabold uppercase tracking-widest text-slate-600 mb-1">
                  Signoff (optional)
                </span>
                <input
                  value={customSignoff}
                  onChange={(e) => setCustomSignoff(e.target.value)}
                  placeholder="See you on the pitch — Coach Ollie"
                  className="w-full px-3 py-2 rounded-lg ring-1 ring-slate-200 focus:ring-2 focus:ring-crimson-400 text-sm"
                />
              </label>

              <div className="rounded-xl bg-crimson-50 ring-1 ring-crimson-200 p-3 text-sm flex items-center justify-between">
                <div>
                  <div className="text-[10px] font-extrabold uppercase tracking-widest text-crimson-800">Recipients</div>
                  <div className="text-charcoal-950 font-black text-lg">
                    {recipients.length} famil{recipients.length === 1 ? 'y' : 'ies'}
                  </div>
                </div>
                <div className="text-[11px] text-slate-600 text-right">
                  {recipients.reduce((a, f) => a + f.children.length, 0)} players covered
                </div>
              </div>

              {result && <div className="rounded-lg bg-emerald-50 ring-1 ring-emerald-300 px-3 py-2 text-sm text-emerald-700">{result}</div>}
              {error && <div className="rounded-lg bg-rose-50 ring-1 ring-rose-300 px-3 py-2 text-sm text-rose-700">{error}</div>}
            </>
          )}
        </div>

        <div className="px-5 py-3 border-t border-gray-100 flex items-center justify-end gap-2">
          <button type="button" onClick={onClose} className="px-3 py-2 rounded-lg text-sm font-bold text-slate-600 hover:text-slate-900">
            {result ? 'Done' : 'Cancel'}
          </button>
          {!result && (
            <button
              type="button"
              disabled={sending || recipients.length === 0 || !seasonId}
              onClick={handleSend}
              className="px-4 py-2 rounded-lg bg-crimson-600 hover:bg-crimson-500 disabled:opacity-50 text-white text-sm font-bold"
            >
              {sending ? 'Sending…' : `Send to ${recipients.length}`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export default RegistrationBlastModal;
