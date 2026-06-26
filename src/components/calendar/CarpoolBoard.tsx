import React, { useState } from 'react';

export interface CarpoolPost {
  id: string;
  uid: string;
  name: string;
  type: 'offer' | 'request';
  seats?: number;
  location?: string;
  note?: string;
  createdAt: any;
  /** Claim metadata — for an OFFER, who's taking a seat; for a
   *  REQUEST, who's giving them a ride. Optional so existing posts
   *  stay readable. */
  claimedByUid?: string;
  claimedByName?: string;
  claimedAt?: any;
}

interface Props {
  posts: CarpoolPost[];
  currentUid?: string;
  currentName?: string;
  onAdd: (post: { type: 'offer' | 'request'; seats?: number; location?: string; note?: string }) => Promise<void> | void;
  onDelete: (postId: string) => Promise<void> | void;
  /** Toggle claim/unclaim on a post. Called with the post id; the
   *  parent decides whether to attribute or clear the claim based on
   *  current state. */
  onToggleClaim?: (postId: string) => Promise<void> | void;
}

const Icon: React.FC<{ name: string; className?: string }> = ({ name, className = 'w-3.5 h-3.5' }) => {
  const c = `${className} stroke-current`;
  const p = { fill: 'none' as const, strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  switch (name) {
    case 'car': return <svg className={c} {...p} viewBox="0 0 24 24"><path d="M3 17v-5l2-5h14l2 5v5h-3a2 2 0 0 1-4 0H10a2 2 0 0 1-4 0H3z"/><circle cx="7" cy="17" r="2"/><circle cx="17" cy="17" r="2"/></svg>;
    case 'help': return <svg className={c} {...p} viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>;
    case 'plus': return <svg className={c} {...p} viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>;
    case 'x': return <svg className={c} {...p} viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>;
  }
  return null;
};

const CarpoolBoard: React.FC<Props> = ({ posts, currentUid, currentName, onAdd, onDelete, onToggleClaim }) => {
  const [adding, setAdding] = useState<'offer' | 'request' | null>(null);
  const [seats, setSeats] = useState<string>('2');
  const [location, setLocation] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!adding || busy) return;
    setBusy(true);
    try {
      await onAdd({
        type: adding,
        seats: adding === 'offer' ? Math.max(1, Number(seats) || 1) : undefined,
        location: location.trim() || undefined,
        note: note.trim() || undefined,
      });
      setAdding(null);
      setSeats('2');
      setLocation('');
      setNote('');
    } finally {
      setBusy(false);
    }
  };

  const offers = posts.filter(p => p.type === 'offer');
  const requests = posts.filter(p => p.type === 'request');

  return (
    <section className="bg-charcoal-900 rounded-2xl ring-1 ring-white/10 shadow-xl shadow-black/40 mx-3 sm:mx-4 my-3 sm:my-4 px-4 sm:px-6 py-4">
      <div className="flex items-center justify-between mb-2">
        <div className="text-xs font-extrabold tracking-widest uppercase text-charcoal-400 flex items-center gap-1.5">
          <Icon name="car" className="w-3 h-3 text-brand-primary" />
          Carpool
        </div>
        {currentUid && !adding && (
          <div className="flex gap-1.5">
            <button
              onClick={() => setAdding('offer')}
              className="text-[10px] font-extrabold tracking-widest uppercase px-2 py-1 rounded bg-purple-50 text-purple-700 border border-purple-200 hover:bg-purple-100"
            >
              + Offer ride
            </button>
            <button
              onClick={() => setAdding('request')}
              className="text-[10px] font-extrabold tracking-widest uppercase px-2 py-1 rounded bg-brand-primary-soft text-brand-primary border border-brand-primary-soft hover:bg-brand-primary-soft"
            >
              + Need ride
            </button>
          </div>
        )}
      </div>

      {/* Add form */}
      {adding && (
        <div className="mb-3 p-3 rounded-lg bg-charcoal-800 ring-1 ring-white/10 space-y-2">
          <div className="text-[11px] font-bold text-charcoal-200">
            {adding === 'offer' ? 'Offer a ride' : 'Request a ride'}
          </div>
          {adding === 'offer' && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-charcoal-500">Seats</span>
              <input
                type="number"
                value={seats}
                onChange={(e) => setSeats(e.target.value)}
                min={1}
                max={9}
                className="w-16 px-2 py-1 border border-white/10 rounded text-sm text-center"
              />
            </div>
          )}
          <input
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            placeholder={adding === 'offer' ? 'Driving from (e.g. West side)' : 'Need ride from (e.g. North end)'}
            className="w-full px-2 py-1.5 border border-white/10 rounded text-sm"
          />
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Optional note"
            className="w-full px-2 py-1.5 border border-white/10 rounded text-sm"
          />
          <div className="flex gap-2 justify-end">
            <button
              onClick={() => setAdding(null)}
              className="text-[11px] font-bold text-charcoal-500 px-3 py-1"
            >Cancel</button>
            <button
              onClick={submit}
              disabled={busy}
              className="text-[11px] font-extrabold tracking-widest uppercase px-3 py-1 rounded bg-brand-primary text-white disabled:opacity-50"
            >
              Post
            </button>
          </div>
        </div>
      )}

      {/* Posts */}
      {posts.length === 0 && !adding ? (
        <p className="text-sm text-charcoal-500">No posts yet. Offer or request a ride to get the board going.</p>
      ) : (
        <div className="space-y-2">
          {offers.length > 0 && (
            <div>
              <div className="text-[10px] font-extrabold tracking-widest uppercase text-purple-700 mb-1">Offers</div>
              <div className="space-y-1.5">
                {offers.map(p => {
                  const mine = p.uid === currentUid;
                  const claimedByMe = p.claimedByUid === currentUid;
                  const claimed = !!p.claimedByUid;
                  return (
                    <div key={p.id} className="rounded-lg bg-purple-50/50 border border-purple-200 px-3 py-2">
                      <div className="flex items-start gap-2">
                        <Icon name="car" className="w-4 h-4 text-purple-600 mt-0.5" />
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-semibold text-purple-900">
                            {p.name} — {p.seats ? `${p.seats} seat${p.seats === 1 ? '' : 's'}` : 'driving'}
                            {p.location && <span className="font-normal text-purple-700"> from {p.location}</span>}
                          </div>
                          {p.note && <div className="text-xs text-purple-700">{p.note}</div>}
                          {claimed && (
                            <div className="text-[11px] font-bold text-emerald-300 mt-1">
                              {claimedByMe ? "You're taking a seat" : `${p.claimedByName} is taking a seat`}
                            </div>
                          )}
                        </div>
                        {mine && (
                          <button
                            onClick={() => onDelete(p.id)}
                            aria-label="Remove post"
                            className="text-purple-400 hover:text-purple-700 flex-shrink-0"
                          >
                            <Icon name="x" className="w-3 h-3" />
                          </button>
                        )}
                      </div>
                      {!mine && currentUid && onToggleClaim && (
                        <div className="mt-1.5 flex justify-end">
                          {(!claimed || claimedByMe) && (
                            <button
                              onClick={() => onToggleClaim(p.id)}
                              className={`text-[11px] font-extrabold tracking-widest uppercase px-2.5 py-1 rounded border ${
                                claimedByMe
                                  ? 'bg-emerald-50 text-emerald-300 border-emerald-200 hover:bg-emerald-100'
                                  : 'bg-white text-purple-700 border-purple-200 hover:bg-purple-100'
                              }`}
                            >
                              {claimedByMe ? '✓ Got a seat — release?' : "I'll take a seat"}
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
          {requests.length > 0 && (
            <div>
              <div className="text-[10px] font-extrabold tracking-widest uppercase text-brand-primary mb-1">Requests</div>
              <div className="space-y-1.5">
                {requests.map(p => {
                  const mine = p.uid === currentUid;
                  const claimedByMe = p.claimedByUid === currentUid;
                  const claimed = !!p.claimedByUid;
                  return (
                    <div key={p.id} className="rounded-lg bg-brand-primary-soft/50 border border-brand-primary-soft px-3 py-2">
                      <div className="flex items-start gap-2">
                        <Icon name="help" className="w-4 h-4 text-brand-primary mt-0.5" />
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-semibold text-brand-primary-dim">
                            {p.name} — needs a ride
                            {p.location && <span className="font-normal text-brand-primary"> from {p.location}</span>}
                          </div>
                          {p.note && <div className="text-xs text-brand-primary">{p.note}</div>}
                          {claimed && (
                            <div className="text-[11px] font-bold text-emerald-300 mt-1">
                              {claimedByMe ? "You're driving them" : `${p.claimedByName} is driving them`}
                            </div>
                          )}
                        </div>
                        {mine && (
                          <button
                            onClick={() => onDelete(p.id)}
                            aria-label="Remove post"
                            className="text-brand-primary-soft hover:text-brand-primary flex-shrink-0"
                          >
                            <Icon name="x" className="w-3 h-3" />
                          </button>
                        )}
                      </div>
                      {!mine && currentUid && onToggleClaim && (
                        <div className="mt-1.5 flex justify-end">
                          {(!claimed || claimedByMe) && (
                            <button
                              onClick={() => onToggleClaim(p.id)}
                              className={`text-[11px] font-extrabold tracking-widest uppercase px-2.5 py-1 rounded border ${
                                claimedByMe
                                  ? 'bg-emerald-50 text-emerald-300 border-emerald-200 hover:bg-emerald-100'
                                  : 'bg-white text-brand-primary border-brand-primary-soft hover:bg-brand-primary-soft'
                              }`}
                            >
                              {claimedByMe ? "✓ I'm driving — release?" : "I can drive them"}
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {!currentUid && (
        <p className="text-[11px] text-charcoal-500 mt-2">Sign in to offer or request a ride.</p>
      )}
    </section>
  );
};

export default CarpoolBoard;
