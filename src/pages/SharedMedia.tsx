import React, { useState, useEffect } from 'react';
import { Link, useParams, useLocation } from 'react-router-dom';
import { doc, getDoc } from 'firebase/firestore';
import { db } from '../utils/firebase';
import { useAuth } from '../hooks/useAuth';
import CloudflareStreamIframe from '../components/common/CloudflareStreamIframe';

// The load path distinguishes three failure modes so the recipient
// sees a real answer instead of the same "Media Not Found" for every
// case. `permission` fires when Firestore rules deny the read (visitor
// isn't on the team the media belongs to — or isn't signed in at all).
// `not-found` fires when the doc genuinely doesn't exist. `unknown` is
// the everything-else bucket.
type LoadError = { kind: 'permission' | 'not-found' | 'unknown'; message: string };

const SharedMedia: React.FC = () => {
  const { mediaId } = useParams<{ mediaId: string }>();
  const location = useLocation();
  const { currentUser, loading: authLoading } = useAuth();
  const [media, setMedia] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<LoadError | null>(null);

  useEffect(() => {
    if (!mediaId) {
      setError({ kind: 'not-found', message: 'Invalid link.' });
      setLoading(false);
      return;
    }
    // Wait for auth to resolve before the read attempt. Otherwise
    // Firestore reads fire while request.auth is still null and
    // return permission-denied for every signed-in team member on
    // the first render.
    if (authLoading) return;

    const load = async () => {
      setLoading(true);
      setError(null);
      // Some share targets append the share text to the URL, so extract
      // just the doc ID. Firestore auto-IDs are alphanumeric.
      const cleanId = decodeURIComponent(mediaId).split(/[\s,]/)[0].trim();

      // Try player_media, then gallery. A permission-denied on either
      // is treated as "you can't see this" — surface a sign-in prompt
      // if not authed, or a wrong-team message if authed.
      const attempts = [
        { col: 'player_media', ref: doc(db, 'player_media', cleanId) },
        { col: 'gallery', ref: doc(db, 'gallery', cleanId) },
      ];
      let foundMedia: any = null;
      let sawPermissionDenied = false;
      for (const a of attempts) {
        try {
          const snap = await getDoc(a.ref);
          if (snap.exists()) {
            foundMedia = { id: snap.id, ...snap.data() };
            break;
          }
        } catch (err: any) {
          if (err?.code === 'permission-denied') {
            sawPermissionDenied = true;
          } else {
            console.error('Error loading shared media:', err);
          }
        }
      }
      if (foundMedia) {
        setMedia(foundMedia);
      } else if (sawPermissionDenied) {
        setError({
          kind: 'permission',
          message: currentUser
            ? "This photo is only visible to members of the team it belongs to."
            : "Sign in to view this shared media.",
        });
      } else {
        setError({
          kind: 'not-found',
          message: 'This media could not be found or may have been removed.',
        });
      }
      setLoading(false);
    };

    load();
  }, [mediaId, currentUser, authLoading]);

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center">
        <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-white"></div>
      </div>
    );
  }

  if (error || !media) {
    const isSignInPrompt = error?.kind === 'permission' && !currentUser;
    const headline = error?.kind === 'permission'
      ? (isSignInPrompt ? 'Sign in to view' : "You don't have access")
      : 'Media not found';
    const body = error?.message || 'This link may have expired or been removed.';
    // Stash the current path so we can bring the user back after auth
    // (Dashboard doesn't return-URL yet; add sessionStorage as a soft
    // hint that Auth can consume when it does).
    if (isSignInPrompt && typeof window !== 'undefined') {
      try { sessionStorage.setItem('postAuthReturnTo', location.pathname + location.search); } catch { /* ignore */ }
    }
    // SharedMedia stays dark in both themes on purpose (fullscreen
    // media viewer aesthetic — matches Instagram / YouTube). Classes
    // below are tagged theme-ok inline for the pre-commit hook.
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center p-4"> {/* theme-ok: dark media viewer */}
        <div className="text-center max-w-sm">
          <div className="text-5xl mb-4">⚽</div>
          <h1 className="text-xl font-bold text-white mb-2">{headline}</h1> {/* theme-ok */}
          <p className="text-gray-400">{body}</p> {/* theme-ok: on gray-900 ground */}
          {isSignInPrompt && (
            <Link
              to="/auth"
              className="mt-5 inline-flex items-center justify-center bg-brand-primary hover:bg-brand-primary/90 text-white text-sm font-semibold px-4 py-2 rounded-lg transition-colors" /* theme-ok: brand CTA */
            >
              Sign in
            </Link>
          )}
        </div>
      </div>
    );
  }

  const isVideo = media.type === 'video' || media.contentType?.startsWith('video/');
  const title = media.caption || `${media.playerName || 'Team'} — ${isVideo ? 'Video' : 'Photo'}`;

  return (
    <div className="min-h-screen bg-gray-900 flex flex-col">
      {/* Header */}
      <div className="bg-gray-800 border-b border-gray-700 px-4 py-3">
        <div className="max-w-4xl mx-auto flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <span className="text-2xl">⚽</span>
            <div>
              <h1 className="text-white font-semibold text-sm sm:text-base truncate max-w-[200px] sm:max-w-none">
                {title}
              </h1>
              {media.playerName && (
                <p className="text-gray-400 text-xs sm:text-sm">{media.playerName}</p>
              )}
            </div>
          </div>
          {/* Download button removed 2026-08-24. Anonymous viewers
              (grandparents, friends without the app) can't call
              /api/stream-enable-download without an auth token, and
              a "Not signed in" error on a share link is worse than
              no button. Signed-in team members can still save via
              the chat lightbox or the app's own media page. */}
        </div>
      </div>

      {/* Media */}
      <div className="flex-1 flex items-center justify-center p-4">
        <div className="max-w-4xl w-full">
          {isVideo ? (
            media.streamUid ? (
              <div className="w-full aspect-video rounded-lg overflow-hidden bg-black">
                {/* Share links are typically opened well after upload.
                    Trust the persisted streamReady flag; if the doc was
                    written before the flag existed (backfilled clips)
                    the video is definitely ready by now. */}
                <CloudflareStreamIframe
                  key={media.streamUid}
                  uid={media.streamUid}
                  streamReady={media.streamReady !== false}
                  title={media.caption || 'Video'}
                  iframeClassName="w-full h-full block border-0"
                />
              </div>
            ) : (
              <video
                src={media.url}
                controls
                playsInline
                preload="metadata"
                className="w-full max-h-[80vh] rounded-lg bg-black"
              />
            )
          ) : (
            <img
              src={media.url}
              alt={media.caption || ''}
              className="w-full max-h-[80vh] object-contain rounded-lg"
            />
          )}

          {/* Caption & metadata */}
          {(media.caption || media.uploadedByName) && (
            <div className="mt-3 px-1">
              {media.caption && (
                <p className="text-white text-sm sm:text-base">{media.caption}</p>
              )}
              {media.uploadedByName && (
                <p className="text-gray-500 text-xs mt-1">
                  Shared by {media.uploadedByName}
                  {media.createdAt?.toDate && (
                    <> · {media.createdAt.toDate().toLocaleDateString()}</>
                  )}
                </p>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Footer */}
      <div className="bg-gray-800 border-t border-gray-700 px-4 py-3 text-center">
        <a
          href="/"
          className="text-gray-400 hover:text-white text-xs transition-colors"
        >
          GoalKickr
        </a>
      </div>
    </div>
  );
};

export default SharedMedia;
