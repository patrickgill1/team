import React, { useState } from 'react';
import { doc, serverTimestamp, updateDoc } from 'firebase/firestore';
import { db } from '../../utils/firebase';
import type { Player } from '../../types';
import ProfileCard from './ProfileCard';

// Tiny editable bio card. Matches the mockup's "Player Info" panel:
// preferred foot / favorite position / favorite player / favorite team /
// favorite number / nickname / joined date. All optional — empty fields
// render as "—" so the card stays clean even on brand-new players.
//
// 2026-07-15: adopts the ProfileCard shell (Card Contract) + adds the
// three personalization fields (nickname, favoriteTeam, favoriteNumber).
// When the viewer can edit AND ≥3 of the personalization slots are
// empty, the header "Edit" text button swaps for a soft "Personalize"
// pill — same modal on the other side, warmer entry point.

// Which fields count toward the "Personalize" prompt (per plan). Kept
// as a top-level constant so both the count logic + the "Add first"
// hint in the empty modal share the same list.
const PERSONALIZATION_KEYS = ['nickname', 'favoritePlayer', 'favoriteTeam', 'favoritePosition', 'favoriteNumber'] as const;

function countMissingPersonalization(player: Player): number {
  let missing = 0;
  for (const k of PERSONALIZATION_KEYS) {
    const v: any = (player as any)[k];
    if (v === undefined || v === null || v === '' || (typeof v === 'number' && !Number.isFinite(v))) missing++;
  }
  return missing;
}

interface Props {
  player: Player;
  canEdit: boolean;
  onUpdated?: () => void;
  /** Adult teams: hide the "Favorite Player" row (kid-fandom
   *  vitals don't fit an adult roster). */
  isAdultTeam?: boolean;
}

const PlayerInfoCard: React.FC<Props> = ({ player, canEdit, onUpdated, isAdultTeam }) => {
  const [editing, setEditing] = useState(false);
  const joined = player.joinedAt
    ? (player.joinedAt instanceof Date ? player.joinedAt : new Date(player.joinedAt as any))
    : (player.createdAt instanceof Date ? player.createdAt : (player.createdAt ? new Date(player.createdAt as any) : null));

  // "Personalize" pill swap. Only surfaces when the viewer can edit
  // AND at least 3 of the 5 personalization slots are empty. Same
  // modal, warmer copy — never framed as a completion metric.
  const personalizeMode = canEdit && countMissingPersonalization(player) >= 3;

  const favoriteNumberDisplay = typeof player.favoriteNumber === 'number' && Number.isFinite(player.favoriteNumber)
    ? String(player.favoriteNumber)
    : undefined;

  return (
    <>
      <ProfileCard
        eyebrow="Player Info"
        action={canEdit ? (
          personalizeMode ? (
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="inline-flex items-center gap-1 px-3 py-1 rounded-full text-[11px] font-black uppercase tracking-widest bg-brand-primary/10 text-brand-primary-soft ring-1 ring-brand-primary/25 hover:bg-brand-primary/15 transition"
              title="Add a nickname, favorite team, favorite player, and more"
            >
              <StarIcon />
              Personalize
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="text-xs font-bold text-ink-primary/65 hover:text-ink-primary"
            >
              Edit
            </button>
          )
        ) : null}
      >
        <dl className="divide-y divide-line-default/10 -mt-1">
          <Row icon={<QuoteIcon />} label="Nickname" value={player.nickname ? `"${player.nickname}"` : undefined} />
          <Row icon={<FootIcon />} label="Preferred Foot" value={player.preferredFoot} />
          <Row icon={<PinIcon />} label="Favorite Position" value={player.favoritePosition} />
          {!isAdultTeam && (
            <Row icon={<StarIcon />} label="Favorite Player" value={player.favoritePlayer} />
          )}
          <Row icon={<ShieldIcon />} label="Favorite Team" value={player.favoriteTeam} />
          <Row icon={<HashIcon />} label="Favorite Number" value={favoriteNumberDisplay} />
          <Row icon={<CalendarIcon />} label="Joined" value={joined ? joined.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }) : undefined} />
        </dl>
      </ProfileCard>

      {editing && canEdit && (
        <PlayerInfoEditModal
          player={player}
          onClose={() => setEditing(false)}
          onSaved={() => { setEditing(false); onUpdated?.(); }}
        />
      )}
    </>
  );
};

const Row: React.FC<{ icon: React.ReactNode; label: string; value?: string }> = ({ icon, label, value }) => (
  <div className="flex items-center justify-between py-2.5 gap-2">
    <dt className="flex items-center gap-2 text-sm text-ink-primary/70">
      <span className="text-ink-primary/40">{icon}</span>
      <span className="font-medium">{label}</span>
    </dt>
    <dd className="text-sm font-bold text-ink-primary text-right truncate">{value || <span className="text-ink-primary/40">—</span>}</dd>
  </div>
);

const FootIcon: React.FC = () => (
  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
    <path d="M7 21c-1 0-2-1-2-2 0-2 2-3 2-5 0-3-3-5-3-8 0-3 3-5 5-5s4 2 4 5c0 4-2 6-2 9 0 3 1 4 1 5 0 1-1 1-2 1z" />
    <circle cx="14" cy="4" r="1" /><circle cx="16" cy="5.5" r="1" /><circle cx="17.5" cy="7.5" r="1" />
  </svg>
);
const PinIcon: React.FC = () => (
  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
    <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" /><circle cx="12" cy="10" r="3" />
  </svg>
);
const StarIcon: React.FC = () => (
  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
    <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
  </svg>
);
const CalendarIcon: React.FC = () => (
  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
    <rect x="3" y="4" width="18" height="18" rx="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" />
  </svg>
);
const QuoteIcon: React.FC = () => (
  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
    <path d="M7 7h4v6H7zM13 7h4v6h-4z" />
    <path d="M7 13a4 4 0 0 1-4 4M13 13a4 4 0 0 1-4 4" />
  </svg>
);
const ShieldIcon: React.FC = () => (
  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
  </svg>
);
const HashIcon: React.FC = () => (
  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
    <line x1="4" y1="9" x2="20" y2="9" />
    <line x1="4" y1="15" x2="20" y2="15" />
    <line x1="10" y1="3" x2="8" y2="21" />
    <line x1="16" y1="3" x2="14" y2="21" />
  </svg>
);

const PlayerInfoEditModal: React.FC<{ player: Player; onClose: () => void; onSaved: () => void }> = ({ player, onClose, onSaved }) => {
  const [nickname, setNickname] = useState<string>(player.nickname || '');
  const [preferredFoot, setPreferredFoot] = useState<string>(player.preferredFoot || '');
  const [favoritePosition, setFavoritePosition] = useState<string>(player.favoritePosition || '');
  const [favoritePlayer, setFavoritePlayer] = useState<string>(player.favoritePlayer || '');
  const [favoriteTeam, setFavoriteTeam] = useState<string>(player.favoriteTeam || '');
  const [favoriteNumber, setFavoriteNumber] = useState<string>(
    typeof player.favoriteNumber === 'number' && Number.isFinite(player.favoriteNumber)
      ? String(player.favoriteNumber)
      : ''
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    // Number parsing: empty string = clear. Non-empty must parse to a
    // finite integer 0-999 (jersey conventions). Anything else is a
    // validation error, not a silent drop.
    let favoriteNumberValue: number | null = null;
    const trimmedNumber = favoriteNumber.trim();
    if (trimmedNumber !== '') {
      const parsed = parseInt(trimmedNumber, 10);
      if (!Number.isFinite(parsed) || parsed < 0 || parsed > 999) {
        setError('Favorite number must be between 0 and 999 (or leave blank).');
        setSaving(false);
        return;
      }
      favoriteNumberValue = parsed;
    }
    try {
      await updateDoc(doc(db, 'players', player.id), {
        nickname: nickname.trim() || null,
        preferredFoot: preferredFoot || null,
        favoritePosition: favoritePosition.trim() || null,
        favoritePlayer: favoritePlayer.trim() || null,
        favoriteTeam: favoriteTeam.trim() || null,
        favoriteNumber: favoriteNumberValue,
        updatedAt: serverTimestamp(),
      });
      onSaved();
    } catch (err: any) {
      setError(err?.message || 'Save failed.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-end sm:items-center justify-center p-0 sm:p-6 animate-fade-in">
      <div className="bg-white w-full sm:max-w-md sm:rounded-2xl overflow-hidden animate-sheet-up sm:animate-pop-in max-h-[92vh] flex flex-col">
        <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between shrink-0">
          <h2 className="font-black text-gray-900">Make it yours</h2>
          <button type="button" onClick={onClose} className="text-gray-400 hover:text-gray-700 text-2xl leading-none">×</button>
        </div>
        <div className="p-5 space-y-4 overflow-y-auto">
          <label className="block">
            <span className="block text-[10px] font-extrabold uppercase tracking-widest text-gray-600 mb-1">Nickname</span>
            <input value={nickname} onChange={(e) => setNickname(e.target.value)} placeholder="Hurricane" maxLength={40} className="w-full px-3 py-2 rounded-lg ring-1 ring-gray-200 focus:ring-2 focus:ring-brand-primary-soft text-sm" />
            <span className="mt-1 block text-[11px] text-gray-500">Shows under the name on the profile.</span>
          </label>
          <label className="block">
            <span className="block text-[10px] font-extrabold uppercase tracking-widest text-gray-600 mb-1">Preferred foot</span>
            <select value={preferredFoot} onChange={(e) => setPreferredFoot(e.target.value)} className="w-full px-3 py-2 rounded-lg ring-1 ring-gray-200 focus:ring-2 focus:ring-brand-primary-soft text-sm">
              <option value="">—</option>
              <option value="Left">Left</option>
              <option value="Right">Right</option>
              <option value="Both">Both</option>
            </select>
          </label>
          <label className="block">
            <span className="block text-[10px] font-extrabold uppercase tracking-widest text-gray-600 mb-1">Favorite position</span>
            <input value={favoritePosition} onChange={(e) => setFavoritePosition(e.target.value)} placeholder="Center Back" className="w-full px-3 py-2 rounded-lg ring-1 ring-gray-200 focus:ring-2 focus:ring-brand-primary-soft text-sm" />
          </label>
          <label className="block">
            <span className="block text-[10px] font-extrabold uppercase tracking-widest text-gray-600 mb-1">Favorite player</span>
            <input value={favoritePlayer} onChange={(e) => setFavoritePlayer(e.target.value)} placeholder="Virgil van Dijk" className="w-full px-3 py-2 rounded-lg ring-1 ring-gray-200 focus:ring-2 focus:ring-brand-primary-soft text-sm" />
          </label>
          <label className="block">
            <span className="block text-[10px] font-extrabold uppercase tracking-widest text-gray-600 mb-1">Favorite team</span>
            <input value={favoriteTeam} onChange={(e) => setFavoriteTeam(e.target.value)} placeholder="Barcelona" className="w-full px-3 py-2 rounded-lg ring-1 ring-gray-200 focus:ring-2 focus:ring-brand-primary-soft text-sm" />
          </label>
          <label className="block">
            <span className="block text-[10px] font-extrabold uppercase tracking-widest text-gray-600 mb-1">Favorite number</span>
            <input
              value={favoriteNumber}
              onChange={(e) => setFavoriteNumber(e.target.value)}
              placeholder="10"
              inputMode="numeric"
              type="number"
              min={0}
              max={999}
              className="w-full px-3 py-2 rounded-lg ring-1 ring-gray-200 focus:ring-2 focus:ring-brand-primary-soft text-sm"
            />
          </label>
          {error && <div className="rounded-lg bg-rose-50 ring-1 ring-rose-300 px-3 py-2 text-sm text-rose-700">{error}</div>}
        </div>
        <div className="px-5 py-3 border-t border-gray-100 flex items-center justify-end gap-2 shrink-0">
          <button type="button" onClick={onClose} className="px-3 py-2 rounded-lg text-sm font-bold text-gray-600 hover:text-gray-900">Cancel</button>
          <button type="button" disabled={saving} onClick={handleSave} className="px-4 py-2 rounded-lg bg-brand-primary hover:bg-brand-primary disabled:opacity-50 text-white text-sm font-bold">
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default PlayerInfoCard;
