// @ts-nocheck
import React, { useRef, useState } from 'react';
import { useFirestore } from '../../hooks/useFirestore';
import { uploadClubLogo } from '../../utils/storage';
import { brandColorIsTooLight } from '../../hooks/useApplyClubBrand';

// Club-admin tile for setting the club's brand: logo + brand color.
// Lives at the top of ClubOverview when the viewer is a club admin
// (caller controls visibility). Writes directly to clubs/{clubId};
// downstream surfaces (parent invite landing, club-public pages)
// read those two fields.
//
// Brand color: stored as a hex string on the club doc. Apply via
// inline style or via a CSS custom property at render time. Avoid
// the temptation to wire Tailwind-config-time theming — that
// requires a rebuild per club, which doesn't work for SaaS.

interface Props {
  club: any;
}

const PRESET_COLORS = [
  { id: 'crimson', hex: '#DC2626', label: 'Crimson' },
  { id: 'cyan', hex: '#0891B2', label: 'Cyan' },
  { id: 'amber', hex: '#D97706', label: 'Amber' },
  { id: 'emerald', hex: '#059669', label: 'Emerald' },
  { id: 'violet', hex: '#7C3AED', label: 'Violet' },
  { id: 'slate', hex: '#475569', label: 'Slate' },
];

const ClubBrandingCard: React.FC<Props> = ({ club }) => {
  const { updateDocument } = useFirestore();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !club?.id) return;
    setError(null);
    setUploading(true);
    try {
      const url = await uploadClubLogo(file, club.id);
      await updateDocument('clubs', club.id, { logoUrl: url, updatedAt: new Date() });
      setSavedAt(Date.now());
    } catch (err: any) {
      setError(String(err?.message || err));
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const handleColor = async (hex: string) => {
    if (!club?.id) return;
    setError(null);
    // Reject colors too light for the dark theme (white text on a
    // pastel yellow is invisible). Patrick: 'probably shouldn't do
    // any colors that would make it contrast the background, unless
    // we allowed a white background as well.' The picker still lets
    // you choose any color in the system swatch, we just refuse to
    // save the unreadable ones.
    if (brandColorIsTooLight(hex)) {
      setError("That color's too light for the dark theme — white text won't read on it. Try a deeper shade.");
      return;
    }
    setSaving(true);
    try {
      await updateDocument('clubs', club.id, { brandColor: hex, updatedAt: new Date() });
      setSavedAt(Date.now());
    } catch (err: any) {
      setError(String(err?.message || err));
    } finally {
      setSaving(false);
    }
  };

  const currentColor = club?.brandColor || '#DC2626';

  return (
    <div className="bg-charcoal-900 rounded-2xl ring-1 ring-white/10 p-5 sm:p-6">
      <div className="flex items-start justify-between gap-3 mb-4">
        <div>
          <p className="text-[10px] font-extrabold tracking-widest uppercase text-brand-primary-soft mb-1">Branding</p>
          <h2 className="text-bone font-bold text-lg">Club logo + color</h2>
          <p className="text-bone/60 text-xs mt-1">Shows on the parent invite page and your club&apos;s public surfaces.</p>
        </div>
        {savedAt && Date.now() - savedAt < 3000 && (
          <span className="inline-flex items-center gap-1 text-[11px] font-bold text-emerald-300">
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={3} viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12" /></svg>
            Saved
          </span>
        )}
      </div>

      <div className="flex items-center gap-4 mb-5">
        <div
          className="w-16 h-16 rounded-xl bg-charcoal-950 ring-1 ring-white/10 overflow-hidden flex items-center justify-center"
          style={{ boxShadow: `0 0 0 2px ${currentColor}` }}
        >
          {club?.logoUrl ? (
            <img src={club.logoUrl} alt={`${club.name || 'Club'} logo`} className="w-full h-full object-contain" />
          ) : (
            <span className="text-bone/30 text-xs font-bold">No logo</span>
          )}
        </div>
        <div className="flex-1 min-w-0">
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={uploading}
            className="px-4 py-2 rounded-md font-bold text-sm bg-charcoal-800 ring-1 ring-white/10 hover:ring-white/25 transition disabled:opacity-60"
          >
            {uploading ? 'Uploading…' : club?.logoUrl ? 'Replace logo' : 'Upload logo'}
          </button>
          <p className="text-bone/40 text-[11px] mt-2">PNG or SVG, max 2MB. Square works best.</p>
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/svg+xml,image/webp"
            onChange={handleFileChange}
            className="hidden"
          />
        </div>
      </div>

      <div>
        <p className="text-bone/70 text-[11px] font-bold uppercase tracking-widest mb-2">Brand color</p>
        <div className="flex flex-wrap gap-2">
          {PRESET_COLORS.map(c => {
            const selected = currentColor.toLowerCase() === c.hex.toLowerCase();
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => handleColor(c.hex)}
                disabled={saving}
                title={c.label}
                aria-label={c.label}
                className={`w-9 h-9 rounded-full transition ${selected ? 'ring-2 ring-bone scale-110' : 'ring-1 ring-white/15 hover:ring-white/40'}`}
                style={{ backgroundColor: c.hex }}
              />
            );
          })}
          <label className="inline-flex items-center gap-2 px-3 h-9 rounded-md bg-charcoal-800 ring-1 ring-white/10 hover:ring-white/25 cursor-pointer transition">
            <input
              type="color"
              value={currentColor}
              onChange={e => handleColor(e.target.value)}
              className="w-5 h-5 rounded cursor-pointer bg-transparent border-0 p-0"
              aria-label="Custom color"
            />
            <span className="text-bone/70 text-xs">Custom</span>
          </label>
        </div>
      </div>

      {error && (
        <div className="mt-4 rounded-md bg-amber-950/40 ring-1 ring-amber-700/40 px-3 py-2 text-amber-100 text-xs">
          {error}
        </div>
      )}
    </div>
  );
};

export default ClubBrandingCard;
