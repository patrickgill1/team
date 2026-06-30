// Chat affordance in the mobile chrome — mirrors WallHeaderButton.
// Tap → /chat. A small red dot rides on the bubble when the team
// has any unread messages for the current user. Patrick: "can we
// add a little chat icon with unread message next to the wall
// icon?"

import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { collection, onSnapshot, query, where } from 'firebase/firestore';
import { db } from '../../utils/firebase';
import { useTeam } from '../../contexts/TeamContext';
import { useAuth } from '../../hooks/useAuth';

const ChatHeaderButton: React.FC = () => {
  const { selectedTeamId } = useTeam();
  const { userData } = useAuth();
  const [unreadCount, setUnreadCount] = useState(0);

  useEffect(() => {
    if (!selectedTeamId || !userData?.uid) { setUnreadCount(0); return; }
    const q = query(
      collection(db, 'chat_threads'),
      where('teamId', '==', selectedTeamId),
    );
    const uid = userData.uid;
    const unsub = onSnapshot(q, (snap) => {
      let sum = 0;
      snap.docs.forEach(d => {
        const data: any = d.data();
        const u = data?.unreadCount?.[uid];
        if (typeof u === 'number') sum += u;
      });
      setUnreadCount(sum);
    });
    return () => unsub();
  }, [selectedTeamId, userData?.uid]);

  return (
    <Link
      to="/chat"
      aria-label={unreadCount > 0 ? `Chat — ${unreadCount} unread` : 'Chat'}
      title={unreadCount > 0 ? `${unreadCount} unread` : 'Chat'}
      className="relative inline-flex items-center justify-center w-9 h-9 rounded-full text-ink-primary/65 hover:text-ink-primary hover:bg-line-default/10 transition"
    >
      {/* Chat bubble glyph — same monoline weight as the news/feed
          icon in WallHeaderButton so the two affordances read as a
          paired set in the chrome. */}
      <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
      {unreadCount > 0 && (
        unreadCount <= 9 ? (
          // Tiny count chip when manageable.
          <span
            className="absolute -top-0.5 -right-0.5 min-w-[16px] h-[16px] px-1 rounded-full bg-rose-500 ring-2 ring-surface-input text-[10px] font-extrabold text-white flex items-center justify-center tabular-nums"
            aria-hidden
          >
            {unreadCount}
          </span>
        ) : (
          // Cap at 9+ so a heavy chat day doesn't blow out the chrome layout.
          <span
            className="absolute -top-0.5 -right-0.5 px-1 h-[16px] min-w-[20px] rounded-full bg-rose-500 ring-2 ring-surface-input text-[10px] font-extrabold text-white flex items-center justify-center tabular-nums"
            aria-hidden
          >
            9+
          </span>
        )
      )}
    </Link>
  );
};

export default ChatHeaderButton;
