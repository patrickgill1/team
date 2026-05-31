import React from 'react';
import { Link } from 'react-router-dom';
import { CalendarEvent } from '../../types';
import { mapsUrl } from '../../utils/maps';

// Compact event card for the redesigned list view. Matches the v7 mock:
// thin colored type-stripe → date badge + title + meta → info strip →
// avatar preview strip. Tap the body → /events/:id detail page. The
// three small RSVP buttons set RSVP inline without navigation.

const MONTHS_SHORT = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
const DOWS_SHORT   = ['SUN','MON','TUE','WED','THU','FRI','SAT'];

type RsvpStatus = 'going' | 'maybe' | 'no';

interface PreviewPerson {
  name: string;
  photoURL?: string;
  isGuest?: boolean;
}

interface Props {
  event: CalendarEvent;
  myRsvp?: RsvpStatus | null;
  onRsvp: (status: RsvpStatus) => void;
  goingCount: number;
  pendingCount: number;
  goingPreview: PreviewPerson[]; // first N going for the avatar strip
  arriveText?: string; // e.g. "Arrive 8:45 · 15 min early"
  arriveLabel?: string; // e.g. "15 MIN EARLY"
  weatherText?: string; // e.g. "81°/67°"
  weatherIcon?: string; // emoji
  eventChatUnread?: number;
}

const Icon: React.FC<{ name: string; className?: string }> = ({ name, className = 'w-3.5 h-3.5' }) => {
  switch (name) {
    case 'check':
      return <svg className={className} fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>;
    case 'q':
      return <svg className={className} fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>;
    case 'x':
      return <svg className={className} fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>;
    case 'clock':
      return <svg className={className} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>;
    case 'pin':
      return <svg className={className} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><path d="M12 22s-8-4.5-8-12a8 8 0 1 1 16 0c0 7.5-8 12-8 12z"/><circle cx="12" cy="10" r="3"/></svg>;
    case 'cloud':
      return <svg className={className} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><circle cx="17" cy="9" r="3"/><path d="M9 18h9a4 4 0 0 0 0-8 6 6 0 0 0-11.79-1.5A4 4 0 1 0 7 18h2z"/></svg>;
    case 'users':
      return <svg className={className} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg>;
    case 'chat':
      return <svg className={className} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>;
  }
  return null;
};

function formatTimeRange(start: Date, end?: Date): string {
  const s = start.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (!end) return s;
  const e = end.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `${s} – ${e}`;
}

const EventListCard: React.FC<Props> = ({
  event,
  myRsvp,
  onRsvp,
  goingCount,
  pendingCount,
  goingPreview,
  arriveText,
  arriveLabel,
  weatherText,
  weatherIcon,
  eventChatUnread = 0,
}) => {
  const date = new Date(event.date);
  const end = event.endDate ? new Date(event.endDate) : undefined;
  const month = MONTHS_SHORT[date.getMonth()];
  const day = date.getDate();
  const dow = DOWS_SHORT[date.getDay()];

  const stripe =
    event.type === 'game' ? 'from-rose-500 to-orange-500'
    : event.type === 'practice' ? 'from-cyan-500 to-blue-600'
    : 'from-purple-500 to-pink-500';

  const chip =
    event.type === 'game' ? 'bg-rose-500/10 text-rose-700 border-rose-500/25'
    : event.type === 'practice' ? 'bg-cyan-500/10 text-cyan-700 border-cyan-500/25'
    : 'bg-purple-500/10 text-purple-700 border-purple-500/25';

  const handleQuickRsvp = (status: RsvpStatus, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onRsvp(status);
  };

  const cancelled = !!(event as any).isCancelled;

  return (
    <Link
      to={`/events/${event.id}`}
      className={`block rounded-xl overflow-hidden bg-white shadow-[0_6px_16px_-4px_rgba(0,0,0,0.25)] hover:shadow-[0_8px_20px_-4px_rgba(0,0,0,0.35)] transition-shadow ${cancelled ? 'opacity-70' : ''}`}
    >
      {/* type stripe — muted when cancelled so the card reads as "not happening". */}
      <div className={`h-[3px] bg-gradient-to-r ${cancelled ? 'from-slate-400 to-slate-300' : stripe}`} />

      <div className="px-3.5 pt-3 pb-3">
        <div className="grid grid-cols-[auto_1fr_auto] gap-3 items-start">
          {/* Date badge */}
          <div className={`w-[54px] h-[54px] rounded-lg flex flex-col items-center justify-center flex-shrink-0 ${cancelled ? 'bg-slate-300 border border-slate-200' : 'bg-slate-950 border border-cyan-400/40'}`}>
            <span className={`text-[9px] font-extrabold tracking-widest ${cancelled ? 'text-slate-500' : 'text-cyan-300'}`}>{month}</span>
            <span className={`text-[22px] font-black leading-none ${cancelled ? 'text-slate-600 line-through decoration-2' : 'text-white'}`}>{day}</span>
            <span className={`text-[8px] font-bold tracking-widest mt-0.5 ${cancelled ? 'text-slate-500' : 'text-slate-400'}`}>{dow}</span>
          </div>

          {/* Title area */}
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[9px] font-extrabold tracking-widest uppercase ${chip}`}>
                {event.type}
              </span>
              {cancelled && (
                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-extrabold tracking-widest uppercase bg-amber-600 text-white">
                  Cancelled
                </span>
              )}
            </div>
            <h3 className={`mt-1 text-[15px] font-extrabold leading-tight tracking-tight ${cancelled ? 'text-slate-500 line-through' : 'text-slate-900'}`}>
              {event.title}
            </h3>
            <div className="mt-1 text-[11px] text-slate-500 flex items-center gap-1.5 flex-wrap">
              <span className="inline-flex items-center gap-1">
                <Icon name="clock" className="w-3 h-3 text-slate-400" />
                {formatTimeRange(date, end)}
              </span>
              {event.location && (<>
                <span className="text-slate-300">·</span>
                <a
                  href={mapsUrl({
                    name: event.location,
                    address: (event as any).locationAddress,
                    lat: (event as any).locationCoords?.lat,
                    lon: (event as any).locationCoords?.lon,
                  })}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => { e.stopPropagation(); }}
                  className="inline-flex items-center gap-1 truncate max-w-[140px] hover:text-cyan-700"
                  title="Open in Maps"
                >
                  <Icon name="pin" className="w-3 h-3 text-slate-400" />
                  <span className="truncate underline decoration-dotted underline-offset-2">{event.location}</span>
                </a>
              </>)}
              {(event as any).fieldNumber && (<>
                <span className="text-slate-300">·</span>
                <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-cyan-50 text-cyan-700 text-[10px] font-extrabold tracking-widest uppercase ring-1 ring-cyan-200">
                  {(event as any).fieldNumber}
                </span>
              </>)}
              {event.type === 'game' && (event as any).homeAway && (<>
                <span className="text-slate-300">·</span>
                <span className="inline-flex items-center gap-1 text-[10px] font-extrabold tracking-widest uppercase">
                  <span
                    className={`inline-block w-2.5 h-2.5 rounded-sm border ${
                      (event as any).homeAway === 'home'
                        ? 'bg-slate-900 border-slate-700'
                        : 'bg-white border-slate-300'
                    }`}
                    aria-hidden
                  />
                  <span className="text-slate-600">{(event as any).homeAway === 'home' ? 'Black' : 'White'}</span>
                </span>
              </>)}
              {weatherText && (<>
                <span className="text-slate-300">·</span>
                <span className="inline-flex items-center gap-1">
                  <span aria-hidden>{weatherIcon}</span>
                  {weatherText}
                </span>
              </>)}
            </div>
          </div>

          {/* Quick RSVP */}
          <div className="flex flex-col gap-1 items-end flex-shrink-0">
            <div className="flex gap-1">
              <button
                onClick={(e) => handleQuickRsvp('going', e)}
                aria-label="RSVP going"
                className={`w-7 h-7 rounded-md border flex items-center justify-center transition-colors ${
                  myRsvp === 'going'
                    ? 'bg-emerald-500/15 text-emerald-700 border-emerald-500/40 ring-1 ring-emerald-500/30'
                    : 'bg-slate-100 text-slate-500 border-slate-200 hover:border-emerald-400'
                }`}
              >
                <Icon name="check" className="w-3 h-3" />
              </button>
              <button
                onClick={(e) => handleQuickRsvp('maybe', e)}
                aria-label="RSVP maybe"
                className={`w-7 h-7 rounded-md border flex items-center justify-center transition-colors ${
                  myRsvp === 'maybe'
                    ? 'bg-amber-500/15 text-amber-700 border-amber-500/40 ring-1 ring-amber-500/30'
                    : 'bg-slate-100 text-slate-500 border-slate-200 hover:border-amber-400'
                }`}
              >
                <Icon name="q" className="w-3 h-3" />
              </button>
              <button
                onClick={(e) => handleQuickRsvp('no', e)}
                aria-label="RSVP can't go"
                className={`w-7 h-7 rounded-md border flex items-center justify-center transition-colors ${
                  myRsvp === 'no'
                    ? 'bg-rose-500/15 text-rose-700 border-rose-500/40 ring-1 ring-rose-500/30'
                    : 'bg-slate-100 text-slate-500 border-slate-200 hover:border-rose-400'
                }`}
              >
                <Icon name="x" className="w-3 h-3" />
              </button>
            </div>
            <div className="text-[10px] font-bold tracking-wider text-slate-500">
              {myRsvp === 'going' ? 'YOU: GOING'
                : myRsvp === 'maybe' ? 'YOU: MAYBE'
                : myRsvp === 'no' ? "YOU: CAN'T"
                : 'TAP TO RSVP'}
            </div>
          </div>
        </div>

        {/* Info strip */}
        <div className="mt-2.5 pt-2.5 border-t border-slate-100 grid grid-cols-3">
          <div className="flex items-center gap-1.5 px-1.5">
            <Icon name="users" className="w-3.5 h-3.5 text-cyan-500" />
            <div>
              <div className="text-[11px] font-bold text-slate-900 leading-none tracking-wide">{goingCount} GOING</div>
              <div className="text-[9px] text-slate-400 mt-0.5 tracking-wide">{pendingCount} PENDING</div>
            </div>
          </div>
          {arriveText ? (
            <div className="flex items-center gap-1.5 px-1.5 border-l border-slate-100">
              <Icon name="clock" className="w-3.5 h-3.5 text-cyan-500" />
              <div>
                <div className="text-[11px] font-bold text-slate-900 leading-none tracking-wide">{arriveText}</div>
                <div className="text-[9px] text-slate-400 mt-0.5 tracking-wide">{arriveLabel || ''}</div>
              </div>
            </div>
          ) : (
            <div className="border-l border-slate-100" />
          )}
          <div className="flex items-center gap-1.5 px-1.5 border-l border-slate-100">
            <Icon name="chat" className="w-3.5 h-3.5 text-cyan-500" />
            <div>
              <div className="text-[11px] font-bold text-slate-900 leading-none tracking-wide">
                {eventChatUnread > 0 ? `${eventChatUnread} NEW` : '0 NEW'}
              </div>
              <div className="text-[9px] text-slate-400 mt-0.5 tracking-wide">EVENT CHAT</div>
            </div>
          </div>
        </div>

        {/* Avatar preview row */}
        {goingPreview.length > 0 && (
          <div className="mt-2.5 flex items-center gap-2">
            <div className="flex">
              {goingPreview.slice(0, 4).map((p, i) => (
                p.photoURL ? (
                  <img
                    key={i}
                    src={p.photoURL}
                    alt=""
                    className={`w-[22px] h-[22px] rounded-full border-2 border-white object-cover ${i > 0 ? '-ml-1.5' : ''}`}
                  />
                ) : (
                  <span
                    key={i}
                    className={`w-[22px] h-[22px] rounded-full border-2 border-white bg-gradient-to-br from-slate-400 to-slate-600 ${i > 0 ? '-ml-1.5' : ''}`}
                  />
                )
              ))}
            </div>
            <span className="text-[11px] font-semibold text-slate-600 truncate">
              {goingPreview.slice(0, 3).map(p => p.name.split(' ')[0]).join(', ')}
              {goingPreview.length > 3 && <span className="text-slate-400"> +{goingPreview.length - 3}</span>}
              <span className="text-cyan-600 font-bold ml-1.5">See all ›</span>
            </span>
          </div>
        )}

        {/* Snacks chip — shown on the card so families don't have to
            tap in to see if they're up. */}
        {(event as any).snackAssignment?.playerName && (
          <div className="mt-2 inline-flex items-center gap-1.5 text-[11px] text-slate-700">
            <span aria-hidden>🍎</span>
            <span>
              <span className="text-slate-500">Snacks: </span>
              <span className="font-bold">{(event as any).snackAssignment.playerName}</span>
            </span>
          </div>
        )}
      </div>
    </Link>
  );
};

export default EventListCard;
