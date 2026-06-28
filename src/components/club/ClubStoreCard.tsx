// @ts-nocheck
import React, { useState } from 'react';
import { doc, updateDoc } from 'firebase/firestore';
import { db } from '../../utils/firebase';

// Admin card for the club's team-store config. Lives next to
// ClubBrandingCard on the /club/branding page. Three editable
// fields:
//   - storeUrl              (the external retailer link)
//   - storeDiscountCode     (optional member code shown on the page)
//   - storeLabel            (optional one-line tagline under the
//                            'Team Store' header)
//
// Patrick 2026-06-25: 'how do i make my team store?' Until now the
// only way to set storeUrl was a Firestore Console edit. The nav
// entry hides itself when storeUrl is empty, so clearing the field
// here removes the Team Store tab for every member of the club.

interface Props {
  club: { id: string; storeUrl?: string; storeDiscountCode?: string; storeLabel?: string };
}

const ClubStoreCard: React.FC<Props> = ({ club }) => {
  const [storeUrl, setStoreUrl] = useState(club.storeUrl || '');
  const [discountCode, setDiscountCode] = useState(club.storeDiscountCode || '');
  const [storeLabel, setStoreLabel] = useState(club.storeLabel || '');
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const dirty =
    storeUrl !== (club.storeUrl || '') ||
    discountCode !== (club.storeDiscountCode || '') ||
    storeLabel !== (club.storeLabel || '');

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const trimmedUrl = storeUrl.trim();
      const trimmedCode = discountCode.trim();
      const trimmedLabel = storeLabel.trim();
      if (trimmedUrl && !/^https?:\/\//i.test(trimmedUrl)) {
        setError('Store URL must start with https:// or http://');
        setSaving(false);
        return;
      }
      await updateDoc(doc(db, 'clubs', club.id), {
        storeUrl: trimmedUrl || null,
        storeDiscountCode: trimmedCode || null,
        storeLabel: trimmedLabel || null,
      });
      setSavedAt(Date.now());
    } catch (err: any) {
      setError(err?.message || 'Save failed.');
    } finally {
      setSaving(false);
    }
  };

  const handleClear = async () => {
    if (!window.confirm('Remove the team store from every team in this club?')) return;
    setSaving(true);
    setError(null);
    try {
      await updateDoc(doc(db, 'clubs', club.id), {
        storeUrl: null,
        storeDiscountCode: null,
        storeLabel: null,
      });
      setStoreUrl('');
      setDiscountCode('');
      setStoreLabel('');
      setSavedAt(Date.now());
    } catch (err: any) {
      setError(err?.message || 'Clear failed.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bg-surface-elevated rounded-2xl ring-1 ring-line-default/10 overflow-hidden">
      <div className="px-5 py-4 border-b border-line-default/5">
        <p className="text-[10px] font-extrabold tracking-widest uppercase text-brand-primary-soft mb-1">Team Store</p>
        <h2 className="text-ink-primary font-bold">External gear shop link</h2>
        <p className="text-ink-primary/55 text-xs mt-1 leading-snug">
          Point this at your retailer (gotsoccer, Soccer.com, your own site). The Team Store tab appears in every team&apos;s nav once a URL is set. Leave blank to hide the tab.
        </p>
      </div>
      <div className="p-5 space-y-3">
        <label className="block">
          <span className="text-[10px] font-extrabold tracking-widest uppercase text-ink-primary/55">Store URL</span>
          <input
            type="url"
            value={storeUrl}
            onChange={(e) => setStoreUrl(e.target.value)}
            placeholder="https://team.wegotsoccer.com/yourclub"
            className="mt-1 w-full rounded-md bg-surface-base ring-1 ring-line-default/10 focus:ring-brand-primary focus:outline-none px-3 py-2.5 text-ink-primary placeholder-charcoal-500 text-sm"
          />
        </label>
        <label className="block">
          <span className="text-[10px] font-extrabold tracking-widest uppercase text-ink-primary/55">Discount code (optional)</span>
          <input
            type="text"
            value={discountCode}
            onChange={(e) => setDiscountCode(e.target.value.toUpperCase())}
            placeholder="FIREFCREWARDS"
            className="mt-1 w-full rounded-md bg-surface-base ring-1 ring-line-default/10 focus:ring-brand-primary focus:outline-none px-3 py-2.5 text-ink-primary placeholder-charcoal-500 text-sm font-mono tracking-wider"
          />
        </label>
        <label className="block">
          <span className="text-[10px] font-extrabold tracking-widest uppercase text-ink-primary/55">Page subtitle (optional)</span>
          <input
            type="text"
            value={storeLabel}
            onChange={(e) => setStoreLabel(e.target.value)}
            placeholder="Official gear, member pricing."
            className="mt-1 w-full rounded-md bg-surface-base ring-1 ring-line-default/10 focus:ring-brand-primary focus:outline-none px-3 py-2.5 text-ink-primary placeholder-charcoal-500 text-sm"
          />
        </label>
        {error && (
          <div className="rounded-md bg-brand-primary-deep/40 ring-1 ring-brand-primary/40 px-3 py-2 text-brand-primary-soft text-xs">
            {error}
          </div>
        )}
        <div className="flex items-center justify-between gap-2 pt-1">
          <button
            type="button"
            onClick={handleClear}
            disabled={saving || (!club.storeUrl && !storeUrl)}
            className="text-[11px] font-extrabold tracking-widest uppercase text-ink-primary/45 hover:text-brand-primary-soft disabled:opacity-30"
          >
            Remove store
          </button>
          <div className="flex items-center gap-3">
            {savedAt && !dirty && (
              <span className="text-[11px] font-bold text-emerald-300">Saved</span>
            )}
            <button
              type="button"
              onClick={handleSave}
              disabled={saving || !dirty}
              className="px-4 py-2 rounded-md font-bold text-sm bg-brand-primary hover:bg-brand-primary text-white disabled:opacity-50 transition"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ClubStoreCard;
