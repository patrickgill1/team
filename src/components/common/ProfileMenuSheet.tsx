// @ts-nocheck
import React from 'react';
import { createPortal } from 'react-dom';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';
import { useViewMode } from '../../contexts/ViewModeContext';
import { isClubAdmin as isClubAdminFn } from '../../utils/helpers';

/**
 * Profile + view-mode sheet — opens from the top-right avatar in the
 * header. Replaces the old "avatar → straight to /settings" link.
 *
 * Patrick 2026-06-21: 'maybe i can click my profile, and it gives
 * me a modal of parent, coach, admin, profile.'
 *
 * Sheet contents (in order of importance):
 *   1. Avatar + name + email
 *   2. VIEW AS rows — radio-style selector when the user is
 *      multi-role (has both parent and coach affordances). Hidden
 *      when single-role since there's nothing to pick.
 *   3. Club section row — navigation entry (not a view-mode flip)
 *      for users with isClubAdmin === true. Per the architecture
 *      decision earlier today, admin lives at /club rather than
 *      modifying the dashboard surface.
 *   4. Account actions — Settings, Sign out
 *
 * Slides up from the bottom on mobile (matches the More menu's
 * bottom-sheet pattern), drops from the top on desktop.
 */

interface Props {
  open: boolean;
  onClose: () => void;
}

const ProfileMenuSheet: React.FC<Props> = ({ open, onClose }) => {
  const { userData, signOut } = useAuth() as any;
  const { viewMode, setViewMode, availableModes, isMultiRole } = useViewMode();
  const navigate = useNavigate();

  if (!open || typeof document === 'undefined') return null;

  const isAdmin = isClubAdminFn(userData);

  const handlePick = (mode: 'parent' | 'coach') => {
    setViewMode(mode);
    onClose();
  };

  const handleOpenClub = () => {
    onClose();
    navigate('/club');
  };

  const handleSignOut = async () => {
    onClose();
    try {
      await signOut?.();
    } catch { /* ignore */ }
    navigate('/auth');
  };

  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-end sm:items-center sm:justify-center" role="dialog" aria-modal>
      <div className="absolute inset-0 bg-charcoal-950/60 backdrop-blur-sm" onClick={onClose} />

      <div
        onClick={(e) => e.stopPropagation()}
        className="relative w-full sm:max-w-sm bg-charcoal-900 ring-1 ring-white/10 rounded-t-3xl sm:rounded-2xl shadow-2xl shadow-black/60 animate-slide-up sm:animate-fade-in overflow-hidden"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        {/* Drag handle (mobile only) */}
        <div className="sm:hidden flex justify-center pt-3 pb-1">
          <div className="w-10 h-1 rounded-full bg-white/20" />
        </div>

        {/* User block */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-white/5">
          <div className="w-12 h-12 rounded-full overflow-hidden bg-crimson-500 text-white flex items-center justify-center font-bold text-base shrink-0">
            {(userData as any)?.photoURL || (userData as any)?.profilePhotoUrl ? (
              <img src={(userData as any).photoURL || (userData as any).profilePhotoUrl} alt="" className="w-full h-full object-cover" />
            ) : (
              (userData as any)?.name?.charAt(0).toUpperCase() || '?'
            )}
          </div>
          <div className="min-w-0">
            <p className="text-[15px] font-black text-bone truncate">{(userData as any)?.name || 'Member'}</p>
            <p className="text-[11.5px] text-bone/55 truncate">{(userData as any)?.email}</p>
          </div>
        </div>

        {/* View-as rows — only when multi-role */}
        {isMultiRole && (
          <div className="px-3 py-2">
            <p className="px-2 py-1.5 text-[10px] font-extrabold tracking-widest uppercase text-bone/45">View as</p>
            <ul>
              {availableModes.map((mode) => {
                const selected = mode === viewMode;
                const label = mode === 'parent' ? 'Parent' : 'Coach';
                const blurb = mode === 'parent'
                  ? 'Your kid + family content'
                  : 'Team management + coach cards';
                return (
                  <li key={mode}>
                    <button
                      type="button"
                      onClick={() => handlePick(mode)}
                      className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-white/5 active:bg-white/10 transition text-left"
                    >
                      <span className={`shrink-0 w-4 h-4 rounded-full flex items-center justify-center ring-2 transition ${
                        selected ? 'bg-crimson-600 ring-crimson-500' : 'bg-charcoal-950 ring-white/15'
                      }`}>
                        {selected && <span className="w-1.5 h-1.5 rounded-full bg-white" />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-[14px] font-bold text-bone">{label}</span>
                        <span className="block text-[11.5px] text-bone/55 leading-snug">{blurb}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {/* Club section — navigation, not a view mode */}
        {isAdmin && (
          <div className="px-3 py-2 border-t border-white/5">
            <button
              type="button"
              onClick={handleOpenClub}
              className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-white/5 active:bg-white/10 transition text-left"
            >
              <span className="shrink-0 w-8 h-8 rounded-lg bg-crimson-500/15 ring-1 ring-crimson-400/30 text-crimson-300 flex items-center justify-center">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /></svg>
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[14px] font-bold text-bone">Club section</span>
                <span className="block text-[11.5px] text-bone/55 leading-snug">Pending registrations, payments, team activation</span>
              </span>
              <svg className="w-4 h-4 text-bone/40" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><polyline points="9 18 15 12 9 6" /></svg>
            </button>
          </div>
        )}

        {/* Account */}
        <div className="px-3 py-2 border-t border-white/5">
          <p className="px-2 py-1.5 text-[10px] font-extrabold tracking-widest uppercase text-bone/45">Account</p>
          <ul>
            <li>
              <Link
                to="/settings"
                onClick={onClose}
                className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-white/5 transition"
              >
                <span className="shrink-0 w-8 h-8 rounded-lg bg-bone/5 ring-1 ring-white/10 text-bone/70 flex items-center justify-center">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
                </span>
                <span className="text-[14px] font-bold text-bone">Profile &amp; settings</span>
              </Link>
            </li>
            <li>
              <button
                type="button"
                onClick={handleSignOut}
                className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-white/5 transition text-left"
              >
                <span className="shrink-0 w-8 h-8 rounded-lg bg-bone/5 ring-1 ring-white/10 text-bone/70 flex items-center justify-center">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><polyline points="16 17 21 12 16 7" /><line x1="21" y1="12" x2="9" y2="12" /></svg>
                </span>
                <span className="text-[14px] font-bold text-bone">Sign out</span>
              </button>
            </li>
          </ul>
        </div>
      </div>
    </div>,
    document.body
  );
};

export default ProfileMenuSheet;
