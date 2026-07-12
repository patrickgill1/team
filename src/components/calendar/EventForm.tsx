import React, { useState, useEffect, useRef } from 'react';
import { arrayRemove, arrayUnion, collection, doc, getDoc, getDocs, limit as fsLimit, orderBy, query, updateDoc, where } from 'firebase/firestore';
import { db } from '../../utils/firebase';
import { CalendarEvent } from '../../types';
import { useAuth } from '../../hooks/useAuth';
import { useTeam } from '../../contexts/TeamContext';
import { useFirestore } from '../../hooks/useFirestore';
import { getWeatherForEvent, WeatherSummary } from '../../utils/weather';
import { osmEmbedUrl, geocodeForward, geocodeResolve, hasMapbox, hasNotifyProxy, isGoogleAvailable, GeocodeHit } from '../../utils/maps';
import { normalizeKit } from '../../utils/kitColors';
import { autoPostGameToWall } from '../../utils/autoPostToWall';
import { sendPushToTeam } from '../../utils/notify';
import { debug } from '../../utils/debug';

/** Compact location for the Recent + Favorites quick-pick rows. */
interface PickableLocation {
  name: string;
  address?: string;
  lat?: number;
  lon?: number;
}

interface EventFormProps {
  isOpen: boolean;
  onClose: () => void;
  onEventUpdated: (event: CalendarEvent) => void;
  editingEvent?: CalendarEvent | null;
  selectedDate?: Date;
}

const EventForm: React.FC<EventFormProps> = ({
  isOpen,
  onClose,
  onEventUpdated,
  editingEvent,
  selectedDate
}) => {
  const { userData } = useAuth();
  const { selectedTeamId, selectedTeam } = useTeam();
  const { addDocument, updateDocument } = useFirestore();

  const [formData, setFormData] = useState({
    title: '',
    description: '',
    date: '',
    time: '',
    location: '',
    fieldNumber: '',
    homeAway: '' as '' | 'home' | 'away',
    type: 'practice' as 'game' | 'practice' | 'event',
    createAttendance: true, // New field for creating attendance
    createVolunteerOpps: false, // New field for creating volunteer opportunities
    volunteerTypes: [] as string[], // Types of volunteers needed
    recurrence: 'none' as 'none' | 'daily' | 'weekly' | 'biweekly' | 'monthly',
    recurrenceUntil: '' as string,
    arriveOffsetMinutes: 0,
    rsvpCap: '',
    feeDollars: '',
    developmentFocus: '',
    endTime: '' as string, // HH:mm, optional
    // Default ON for new events (you usually want to tell people about
    // a new game/practice). Default OFF for edits — the watcher in the
    // hydration effect below flips it for editing mode so an admin
    // fixing a typo doesn't accidentally re-push the whole roster.
    notifyTeam: true,
    // Game-only. Default ON for new games; coaches uncheck for a
    // scrimmage/tournament that shouldn't skew season aggregates.
    countsToStats: true,
    // Game-only. When true, the daily worker cron creates a match_voting
    // + posts the "Vote for Player of the Match" wall CTA after the
    // game's date passes. Turn off for a practice game where you don't
    // want family voting.
    autoCreatePotm: true,
  });
  const [errors, setErrors] = useState<{ [key: string]: string }>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [weather, setWeather] = useState<WeatherSummary | null>(null);
  // Tracks whether the latest location change came from the user typing
  // (vs being filled in by tapping a suggestion). Stops the typeahead
  // from re-querying its own selection.
  const lastSelectedAddressRef = useRef<string>('');
  // Coords for the currently picked location. Cleared whenever the user
  // edits the location string by hand (so we don't persist stale coords
  // attached to a different address).
  const [pickedCoords, setPickedCoords] = useState<{ lat: number; lon: number } | null>(null);
  const [pickedAddress, setPickedAddress] = useState<string>('');
  // Team-scoped quick-pick rows.
  const [recentLocations, setRecentLocations] = useState<PickableLocation[]>([]);
  const [favoriteLocations, setFavoriteLocations] = useState<PickableLocation[]>([]);
  const [savingFavorite, setSavingFavorite] = useState(false);
  // Form ref — lets the sticky-footer Save button submit the form
  // that lives in the scrollable body without using querySelector.
  const formRef = useRef<HTMLFormElement | null>(null);
  // Inline autocomplete state — typing into the location input fires
  // a debounced search via geocodeForward (Mapbox if token, OSM fallback).
  const [searchQuery, setSearchQuery] = useState('');
  const [searchHits, setSearchHits] = useState<GeocodeHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);

  useEffect(() => {
    if (editingEvent) {
      const eventDate = editingEvent.date instanceof Date ? editingEvent.date : (editingEvent.date as any).toDate();
      const untilRaw: any = (editingEvent as any).recurrenceUntil;
      const untilDate = untilRaw ? (untilRaw?.toDate ? untilRaw.toDate() : new Date(untilRaw)) : null;
      // Hydrate coords + address from the existing doc so editing
      // doesn't blow away the stored lat/lon.
      const ec = (editingEvent as any).locationCoords;
      setPickedCoords(ec && typeof ec.lat === 'number' ? { lat: ec.lat, lon: ec.lon } : null);
      setPickedAddress((editingEvent as any).locationAddress || '');
      setFormData({
        title: editingEvent.title,
        description: editingEvent.description,
        date: eventDate.toISOString().split('T')[0],
        time: eventDate.toTimeString().slice(0, 5),
        location: editingEvent.location,
        fieldNumber: (editingEvent as any).fieldNumber || '',
        homeAway: ((editingEvent as any).homeAway as 'home' | 'away' | undefined) || '',
        type: editingEvent.type,
        createAttendance: false, // Don't auto-create for existing events
        createVolunteerOpps: false,
        volunteerTypes: [],
        recurrence: (editingEvent as any).recurrence || 'none',
        recurrenceUntil: untilDate ? untilDate.toISOString().split('T')[0] : '',
        arriveOffsetMinutes: (editingEvent as any).arriveOffsetMinutes || 0,
        rsvpCap: typeof (editingEvent as any).rsvpCap === 'number' && (editingEvent as any).rsvpCap > 0
          ? String((editingEvent as any).rsvpCap) : '',
        feeDollars: typeof (editingEvent as any).feeCents === 'number' && (editingEvent as any).feeCents > 0
          ? ((editingEvent as any).feeCents / 100).toFixed(2) : '',
        developmentFocus: (editingEvent as any).developmentFocus || '',
        endTime: (() => {
          const e = (editingEvent as any).endDate;
          if (!e) return '';
          const d = e?.toDate ? e.toDate() : new Date(e);
          return d.toTimeString().slice(0, 5);
        })(),
        // Edits default OFF — most edits are typo fixes that don't
        // warrant a re-push. Admin opts back in when changing date /
        // time / location.
        notifyTeam: false,
        countsToStats: (editingEvent as any).countsToStats !== false,
        autoCreatePotm: (editingEvent as any).autoCreatePotm !== false,
      });
    } else {
      const defaultDate = selectedDate || new Date();
      setPickedCoords(null);
      setPickedAddress('');
      setFormData({
        title: '',
        description: '',
        date: defaultDate.toISOString().split('T')[0],
        time: '10:00',
        location: '',
        fieldNumber: '',
        homeAway: '',
        type: 'practice',
        createAttendance: true,
        createVolunteerOpps: false,
        volunteerTypes: [],
        recurrence: 'none',
        recurrenceUntil: '',
        arriveOffsetMinutes: 0,
    rsvpCap: '',
    feeDollars: '',
        developmentFocus: '',
        endTime: '',
        notifyTeam: true,
        countsToStats: true,
        autoCreatePotm: true,
      });
    }
    setErrors({});
  }, [editingEvent, selectedDate, isOpen]);

  const validateForm = (): boolean => {
    const newErrors: { [key: string]: string } = {};

    if (!formData.title.trim()) {
      newErrors.title = 'Event title is required';
    } else if (formData.title.trim().length < 3) {
      newErrors.title = 'Title must be at least 3 characters long';
    }

    if (!formData.date) {
      newErrors.date = 'Date is required';
    } else {
      const selectedDateTime = new Date(`${formData.date}T${formData.time}`);
      const now = new Date();
      if (selectedDateTime < new Date(now.getFullYear(), now.getMonth(), now.getDate())) {
        newErrors.date = 'Event date cannot be in the past';
      }
    }

    if (!formData.time) {
      newErrors.time = 'Time is required';
    }

    if (!formData.location.trim()) {
      newErrors.location = 'Location is required';
    }

    if (!editingEvent && formData.recurrence !== 'none') {
      if (!formData.recurrenceUntil) {
        newErrors.recurrenceUntil = 'Choose an end date for the repeating series';
      } else if (formData.date && new Date(formData.recurrenceUntil) <= new Date(formData.date)) {
        newErrors.recurrenceUntil = 'End date must be after the start date';
      }
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  // Generate the date list for a recurring series.
  const generateSeriesDates = (start: Date, until: Date, recurrence: typeof formData.recurrence): Date[] => {
    const out: Date[] = [];
    if (recurrence === 'none') return [start];
    const cap = 200; // safety
    let cursor = new Date(start);
    const endMs = until.getTime() + 86400_000 - 1; // include the until date
    while (cursor.getTime() <= endMs && out.length < cap) {
      out.push(new Date(cursor));
      switch (recurrence) {
        case 'daily':    cursor.setDate(cursor.getDate() + 1); break;
        case 'weekly':   cursor.setDate(cursor.getDate() + 7); break;
        case 'biweekly': cursor.setDate(cursor.getDate() + 14); break;
        case 'monthly':  cursor.setMonth(cursor.getMonth() + 1); break;
      }
    }
    return out;
  };

  // Quick-pick rows: pull the team's saved favorites + the locations
  // from the last ~50 events so coaches don't retype the same address
  // every week. Runs once when the form opens and a team is selected.
  useEffect(() => {
    if (!isOpen || !selectedTeamId) return;
    let cancelled = false;
    (async () => {
      try {
        // Team favorites first — coach explicitly starred these.
        const teamSnap = await getDoc(doc(db, 'teams', selectedTeamId));
        if (cancelled) return;
        const favs: any[] = teamSnap.exists() ? ((teamSnap.data() as any).favoriteLocations || []) : [];
        setFavoriteLocations(favs.map((f: any) => ({
          name: f.name,
          address: f.address,
          lat: f.lat,
          lon: f.lon,
        })));
      } catch (err) {
        console.warn('favorite locations load failed', err);
      }
      try {
        // Recent — dedupe by name, keep only entries with coords (older
        // free-text events don't help; they'd send users to the same
        // unreliable autocomplete situation).
        const snap = await getDocs(query(
          collection(db, 'events'),
          where('teamId', '==', selectedTeamId),
          orderBy('date', 'desc'),
          fsLimit(50),
        ));
        if (cancelled) return;
        const seen = new Set<string>();
        const rows: PickableLocation[] = [];
        snap.forEach(d => {
          const data: any = d.data();
          const name = (data.location || '').trim();
          if (!name) return;
          const lc = data.locationCoords;
          if (!lc || typeof lc.lat !== 'number') return;
          const key = name.toLowerCase();
          if (seen.has(key)) return;
          seen.add(key);
          rows.push({ name, address: data.locationAddress, lat: lc.lat, lon: lc.lon });
        });
        setRecentLocations(rows.slice(0, 6));
      } catch (err) {
        console.warn('recent locations load failed', err);
      }
    })();
    return () => { cancelled = true; };
  }, [isOpen, selectedTeamId]);

  const pickLocation = (loc: PickableLocation) => {
    lastSelectedAddressRef.current = loc.address || loc.name;
    setFormData(prev => ({ ...prev, location: loc.name }));
    setPickedCoords(typeof loc.lat === 'number' && typeof loc.lon === 'number' ? { lat: loc.lat, lon: loc.lon } : null);
    setPickedAddress(loc.address || '');
  };

  const saveCurrentAsFavorite = async () => {
    if (!selectedTeamId || !pickedCoords || !formData.location.trim()) return;
    const next: PickableLocation = {
      name: formData.location.trim(),
      address: pickedAddress || undefined,
      lat: pickedCoords.lat,
      lon: pickedCoords.lon,
    };
    // No-op if already saved.
    if (favoriteLocations.some(f => f.name.toLowerCase() === next.name.toLowerCase())) return;
    setSavingFavorite(true);
    try {
      const entry = {
        name: next.name,
        address: next.address || null,
        lat: next.lat ?? null,
        lon: next.lon ?? null,
      };
      await updateDoc(doc(db, 'teams', selectedTeamId), {
        favoriteLocations: arrayUnion(entry),
      });
      setFavoriteLocations([...favoriteLocations, next]);
    } catch (err) {
      console.error('save favorite failed', err);
      alert("Couldn't save that location — try again.");
    } finally {
      setSavingFavorite(false);
    }
  };

  const removeFavorite = async (name: string) => {
    if (!selectedTeamId) return;
    setSavingFavorite(true);
    try {
      const target = favoriteLocations.find(f => f.name === name);
      if (!target) return;
      const entry = {
        name: target.name,
        address: target.address || null,
        lat: target.lat ?? null,
        lon: target.lon ?? null,
      };
      await updateDoc(doc(db, 'teams', selectedTeamId), {
        favoriteLocations: arrayRemove(entry),
      });
      setFavoriteLocations(favoriteLocations.filter(f => f.name !== name));
    } catch (err) {
      console.warn('remove favorite failed', err);
    } finally {
      setSavingFavorite(false);
    }
  };

  // Inline autocomplete — debounced search against geocodeForward.
  // Mapbox when REACT_APP_MAPBOX_TOKEN is set, OSM/Nominatim otherwise.
  // Proximity bias prefers locations near a previously-used venue.
  useEffect(() => {
    const q = searchQuery.trim();
    if (q.length < 2) { setSearchHits([]); setSearched(false); return; }
    let cancelled = false;
    const handle = setTimeout(async () => {
      setSearching(true);
      try {
        const proxCenter = pickedCoords
          || (favoriteLocations.find(f => typeof f.lat === 'number') as any)
          || (recentLocations.find(r => typeof r.lat === 'number') as any);
        const proximity = proxCenter && typeof proxCenter.lat === 'number'
          ? { lat: proxCenter.lat, lon: proxCenter.lon }
          : undefined;
        const hits = await geocodeForward(q, { proximity });
        if (cancelled) return;
        setSearchHits(hits);
        setSearched(true);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 300);
    return () => { cancelled = true; clearTimeout(handle); };
  }, [searchQuery]);

  // Look up weather forecast for the chosen date/location (debounced via effect deps).
  useEffect(() => {
    let cancelled = false;
    setWeather(null);
    if (!formData.date || !formData.time || !formData.location.trim()) return;
    const dt = new Date(`${formData.date}T${formData.time}`);
    if (Number.isNaN(dt.getTime())) return;
    const handle = setTimeout(async () => {
      // Prefer the coords picked from the location autocomplete so we
      // hit the real venue's forecast, not a fallback / mis-geocode.
      const w = await getWeatherForEvent(formData.location.trim(), dt, pickedCoords);
      if (!cancelled) setWeather(w);
    }, 400);
    return () => { cancelled = true; clearTimeout(handle); };
  }, [formData.date, formData.time, formData.location, pickedCoords]);

  // Function to create related attendance event
  const createAttendanceEvent = async (calendarEvent: any) => {
    try {
      const attendanceEvent = {
        title: calendarEvent.title,
        date: calendarEvent.date,
        type: calendarEvent.type,
        location: calendarEvent.location,
        teamId: calendarEvent.teamId,
        createdBy: calendarEvent.createdBy,
        createdByName: calendarEvent.createdByName,
        createdAt: new Date(),
        calendarEventId: calendarEvent.id // Link to calendar event
      };

      const attendanceEventId = await addDocument('attendance_events', attendanceEvent);
      debug('Created attendance event:', attendanceEventId);
      return attendanceEventId;
    } catch (error) {
      console.error('Error creating attendance event:', error);
      // Don't fail the main event creation if attendance creation fails
      return null;
    }
  };

  // Function to create volunteer opportunities
  const createVolunteerOpportunities = async (calendarEvent: any) => {
    const volunteerOpps = [];

    if (formData.volunteerTypes.includes('snacks')) {
      volunteerOpps.push({
        title: `Snacks for ${calendarEvent.title}`,
        description: 'Provide snacks and drinks for the team',
        date: calendarEvent.date,
        location: calendarEvent.location,
        type: 'snacks',
        slotsNeeded: 2,
        slotsBooked: [],
        teamId: calendarEvent.teamId,
        createdBy: calendarEvent.createdBy,
        createdByName: calendarEvent.createdByName,
        createdAt: new Date(),
        calendarEventId: calendarEvent.id
      });
    }

    if (formData.volunteerTypes.includes('setup')) {
      volunteerOpps.push({
        title: `Setup for ${calendarEvent.title}`,
        description: 'Help set up equipment and field preparation',
        date: new Date(calendarEvent.date.getTime() - 30 * 60 * 1000), // 30 minutes before
        location: calendarEvent.location,
        type: 'setup',
        slotsNeeded: 3,
        slotsBooked: [],
        teamId: calendarEvent.teamId,
        createdBy: calendarEvent.createdBy,
        createdByName: calendarEvent.createdByName,
        createdAt: new Date(),
        calendarEventId: calendarEvent.id
      });
    }

    if (formData.volunteerTypes.includes('cleanup')) {
      volunteerOpps.push({
        title: `Cleanup after ${calendarEvent.title}`,
        description: 'Help clean up equipment and field after the event',
        date: new Date(calendarEvent.date.getTime() + 2 * 60 * 60 * 1000), // 2 hours after
        location: calendarEvent.location,
        type: 'cleanup',
        slotsNeeded: 2,
        slotsBooked: [],
        teamId: calendarEvent.teamId,
        createdBy: calendarEvent.createdBy,
        createdByName: calendarEvent.createdByName,
        createdAt: new Date(),
        calendarEventId: calendarEvent.id
      });
    }

    // Create all volunteer opportunities
    const createdOpps = [];
    for (const opp of volunteerOpps) {
      try {
        const oppId = await addDocument('volunteer_opportunities', opp);
        createdOpps.push(oppId);
        debug('Created volunteer opportunity:', oppId);
      } catch (error) {
        console.error('Error creating volunteer opportunity:', error);
      }
    }

    return createdOpps;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!validateForm() || !userData) return;

    setIsSubmitting(true);
    try {
      const eventDateTime = new Date(`${formData.date}T${formData.time}`);
      // Optional end time: store as a real Date so cards / detail can
      // render a range. If the user picks an end time before the start
      // assume they meant the next day (a 11pm → 1am midnight event).
      let endDateTime: Date | null = null;
      if (formData.endTime) {
        endDateTime = new Date(`${formData.date}T${formData.endTime}`);
        if (endDateTime.getTime() <= eventDateTime.getTime()) {
          endDateTime.setDate(endDateTime.getDate() + 1);
        }
      }

      const eventData: any = {
        title: formData.title.trim(),
        description: formData.description.trim(),
        date: eventDateTime,
        endDate: endDateTime,
        location: formData.location.trim(),
        // Coords + full address only when the user picked a suggestion.
        // Freeform-typed text saves null so we don't carry stale coords
        // from a previous selection into a new address.
        locationCoords: pickedCoords || null,
        locationAddress: pickedAddress || null,
        fieldNumber: formData.fieldNumber.trim() || null,
        homeAway: formData.type === 'game' && formData.homeAway ? formData.homeAway : null,
        // Game-only opt-outs. Reads treat undefined/null as true, so
        // we only write an explicit false when the coach opted out.
        // Non-game events get null (no meaning outside games).
        countsToStats: formData.type === 'game' && formData.countsToStats === false ? false : null,
        autoCreatePotm: formData.type === 'game' && formData.autoCreatePotm === false ? false : null,
        type: formData.type,
        teamId: selectedTeamId,
        createdBy: userData.uid,
        createdByName: userData.name,
        arriveOffsetMinutes: formData.arriveOffsetMinutes > 0 ? formData.arriveOffsetMinutes : null,
        rsvpCap: (() => {
          const raw = String(formData.rsvpCap || '').trim();
          if (!raw) return null;
          const n = Number(raw);
          return Number.isFinite(n) && n > 0 ? Math.min(1000, Math.floor(n)) : null;
        })(),
        feeCents: (() => {
          const raw = String(formData.feeDollars || '').trim();
          if (!raw) return null;
          const dollars = Number(raw);
          if (!Number.isFinite(dollars) || dollars <= 0) return null;
          return Math.round(dollars * 100);
        })(),
        developmentFocus: formData.developmentFocus.trim() || null,
        // Signal to the onEventCreate Cloud Function whether to fan
        // out push notifications. Set ONLY on create — edits do not
        // re-notify. The client-side sendPushToTeam call below still
        // fires as a safety net for the first week while we compare
        // /push_attempts to ensure parity.
        notifyOnCreate: !editingEvent ? !!formData.notifyTeam : undefined,
        createdAt: new Date()
      };

      debug('Saving event data:', eventData);

      let calendarEvent;
      if (editingEvent) {
        debug('Updating event:', editingEvent.id);
        await updateDocument('events', editingEvent.id, eventData);
        calendarEvent = {
          ...editingEvent,
          ...eventData
        };
        // Push the team on edit too, if the admin opted in (default
        // OFF — they have to check the box). Worded as 'Updated' so
        // people know it's not a duplicate of the original notice.
        if (formData.notifyTeam && selectedTeamId) {
          const when = new Date(`${formData.date}T${formData.time}`);
          const whenStr = when.toLocaleString(undefined, {
            weekday: 'short', month: 'short', day: 'numeric',
            hour: 'numeric', minute: '2-digit',
          });
          void sendPushToTeam(selectedTeamId, {
            title: `Updated: ${formData.title}`,
            body: `${whenStr}${formData.location ? ` · ${formData.location}` : ''}`,
            url: `/events/${editingEvent.id}`,
          }, { excludeUid: userData?.uid });
        }
      } else {
        // Build the list of dates (one for non-recurring, many for series)
        const isSeries = formData.recurrence !== 'none';
        const seriesId = isSeries ? `series_${Date.now()}_${Math.random().toString(36).slice(2, 8)}` : undefined;
        const dates = isSeries && formData.recurrenceUntil
          ? generateSeriesDates(eventDateTime, new Date(`${formData.recurrenceUntil}T${formData.time}`), formData.recurrence)
          : [eventDateTime];

        let firstId = '';
        for (let i = 0; i < dates.length; i++) {
          const dt = dates[i];
          const docData: any = {
            ...eventData,
            date: dt,
          };
          if (isSeries) {
            docData.seriesId = seriesId;
            docData.recurrence = formData.recurrence;
            docData.recurrenceUntil = new Date(`${formData.recurrenceUntil}T${formData.time}`);
          }
          const { withSeasonId } = await import('../../utils/seasons');
          const stamped = await withSeasonId(docData);
          const eventId = await addDocument('events', stamped);
          if (i === 0) firstId = eventId;

          // Only attach attendance/volunteer items to the first occurrence to avoid spamming.
          if (i === 0) {
            calendarEvent = { id: eventId, ...docData };
            if (formData.createAttendance && (formData.type === 'practice' || formData.type === 'game')) {
              await createAttendanceEvent(calendarEvent);
            }
            if (formData.createVolunteerOpps && formData.volunteerTypes.length > 0) {
              await createVolunteerOpportunities(calendarEvent);
            }
            // Auto-post the new game to the team wall. Practices +
            // generic events skip silently inside the helper. Fire-and-
            // forget so the event create flow doesn't wait on the
            // chat-thread lookup.
            if (formData.type === 'game' && userData?.uid) {
              void autoPostGameToWall(calendarEvent, {
                uid: userData.uid,
                name: userData.name || 'Coach',
                role: 'coach',
              });
            }
            // Push the team if the admin opted in. Default on for new
            // events / off for edits — see formData init above.
            if (formData.notifyTeam && selectedTeamId) {
              const when = new Date(`${formData.date}T${formData.time}`);
              const whenStr = when.toLocaleString(undefined, {
                weekday: 'short', month: 'short', day: 'numeric',
                hour: 'numeric', minute: '2-digit',
              });
              const typeLabel = formData.type === 'game' ? 'New game' : formData.type === 'practice' ? 'New practice' : 'New event';
              void sendPushToTeam(selectedTeamId, {
                title: `${typeLabel}: ${formData.title}`,
                body: `${whenStr}${formData.location ? ` · ${formData.location}` : ''}`,
                url: `/events/${eventId}`,
              }, { excludeUid: userData?.uid });
            }
          }
        }
        debug(`Created ${dates.length} event(s), first id ${firstId}`);
      }

      onEventUpdated(calendarEvent);

      // Reset form and close
      setFormData({
        title: '',
        description: '',
        date: '',
        time: '',
        location: '',
        fieldNumber: '',
        homeAway: '',
        type: 'practice',
        createAttendance: true,
        createVolunteerOpps: false,
        volunteerTypes: [],
        recurrence: 'none',
        recurrenceUntil: '',
        arriveOffsetMinutes: 0,
    rsvpCap: '',
    feeDollars: '',
        developmentFocus: '',
        endTime: '',
        notifyTeam: true,
        countsToStats: true,
        autoCreatePotm: true,
      });
      onClose();
    } catch (error) {
      console.error('Error saving event:', error);
      setErrors({ submit: 'Failed to save event. Please try again.' });
    } finally {
      setIsSubmitting(false);
    }
  };

  // Monoline SVG icon for a given event type. Replaces the previous
  // emoji-returning helper — emojis felt cheap (Patrick: "crapy emojis
  // at the bottom") and clashed with the page's design system.
  const EventTypeIcon: React.FC<{ type: string; className?: string }> = ({ type, className = 'w-5 h-5' }) => {
    const stroke = { fill: 'none' as const, stroke: 'currentColor' as const, strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
    if (type === 'game') {
      return (
        <svg className={className} viewBox="0 0 24 24" {...stroke}>
          <path d="M6 9a3 3 0 0 1-3-3V4h4" />
          <path d="M18 9a3 3 0 0 0 3-3V4h-4" />
          <path d="M7 4h10v5a5 5 0 0 1-10 0V4z" />
          <path d="M9 17h6" />
          <path d="M12 14v3" />
        </svg>
      );
    }
    if (type === 'practice') {
      return (
        <svg className={className} viewBox="0 0 24 24" {...stroke}>
          <circle cx="12" cy="13" r="8" />
          <path d="M12 9v4l2 2" />
          <line x1="9" y1="2" x2="15" y2="2" />
        </svg>
      );
    }
    return (
      <svg className={className} viewBox="0 0 24 24" {...stroke}>
        <path d="M12 2l1.6 5.4L19 9l-5.4 1.6L12 16l-1.6-5.4L5 9l5.4-1.6z" />
      </svg>
    );
  };

  const getEventTypeColor = (type: string) => {
    // Dark-theme legible: light tinted text on translucent fill so the
    // chip stays readable on a charcoal preview background. Previous
    // values used dark text (rose-700 / charcoal-800 / emerald-700) on
    // a 10%-opacity tinted fill, which read as 'dark on dark' on the
    // charcoal preview card — Patrick caught this on the practice chip.
    switch (type) {
      case 'game':     return 'border-rose-500 bg-rose-500/15 text-rose-300 ring-2 ring-rose-500/30';
      case 'practice': return 'border-brand-primary bg-brand-primary/15 text-brand-primary-soft ring-2 ring-brand-primary/30';
      case 'event':    return 'border-emerald-500 bg-emerald-500/15 text-emerald-300 ring-2 ring-emerald-500/30';
      default:         return 'border-line-default/15 bg-surface-base text-ink-primary';
    }
  };

  const handleVolunteerTypeChange = (type: string, checked: boolean) => {
    if (checked) {
      setFormData({
        ...formData,
        volunteerTypes: [...formData.volunteerTypes, type]
      });
    } else {
      setFormData({
        ...formData,
        volunteerTypes: formData.volunteerTypes.filter(t => t !== type)
      });
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-end sm:items-center justify-center z-50 sm:p-4" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-surface-elevated rounded-t-2xl sm:rounded-2xl sm:max-w-lg w-full max-h-[92vh] sm:max-h-[88vh] flex flex-col shadow-2xl overflow-hidden"
      >
        {/* Header — same chrome as LocationPickerModal / UserProfileModal /
            ChatActionSheet so the modal family reads as one system. */}
        <div className="bg-gradient-to-b from-surface-base to-surface-elevated px-4 py-3 flex items-center justify-between flex-shrink-0">
          <button
            type="button"
            onClick={onClose}
            className="text-[11px] font-extrabold tracking-widest uppercase text-ink-primary/50 hover:text-white px-1"
          >
            Cancel
          </button>
          <div className="text-xs font-extrabold tracking-widest uppercase text-brand-primary-soft">
            {editingEvent ? 'Edit event' : 'New event'}
          </div>
          <span className="w-12" aria-hidden />
        </div>

        <form ref={formRef} onSubmit={handleSubmit} className="flex-1 overflow-y-auto overflow-x-hidden p-4 sm:p-5 space-y-4">
          {/* Event Type — segmented control with monoline SVG icons. */}
          <div>

          <div>
            <label className="block text-[10px] font-extrabold tracking-widest uppercase text-ink-primary/60 mb-1.5">
              Development focus
            </label>
            <select
              value={formData.developmentFocus}
              onChange={(e) => setFormData({ ...formData, developmentFocus: e.target.value })}
              className="w-full px-3 py-2 bg-surface-base text-ink-primary [color-scheme:dark] border border-line-default/15 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-primary/50"
            >
              <option value="">No event focus</option>
              <option value="First touch">First touch</option>
              <option value="Passing">Passing</option>
              <option value="Defending">Defending</option>
              <option value="Finishing">Finishing</option>
              <option value="Keeper training">Keeper training</option>
              <option value="Confidence">Confidence</option>
              <option value="Communication">Communication</option>
              <option value="Effort">Effort</option>
              <option value="Fitness">Fitness</option>
              <option value="Decision making">Decision making</option>
            </select>
            <p className="text-xs text-ink-primary/55 mt-1">
              Shows before the event and frames the post-event player pulse.
            </p>
          </div>
            <label className="block text-[10px] font-extrabold tracking-widest uppercase text-ink-primary/60 mb-2">
              Type
            </label>
            <div className="grid grid-cols-3 gap-2">
              {[
                {
                  value: 'practice', label: 'Practice',
                  // Stopwatch — matches the practice/training metaphor.
                  icon: (<svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2 2"/><line x1="9" y1="2" x2="15" y2="2"/></svg>),
                  activeClass: 'bg-brand-primary/20 text-brand-primary-soft border-brand-primary-soft',
                },
                {
                  value: 'game', label: 'Game',
                  // Trophy.
                  icon: (<svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><path d="M6 9a3 3 0 0 1-3-3V4h4"/><path d="M18 9a3 3 0 0 0 3-3V4h-4"/><path d="M7 4h10v5a5 5 0 0 1-10 0V4z"/><path d="M9 17h6"/><path d="M12 14v3"/></svg>),
                  activeClass: 'bg-rose-500/20 text-rose-200 border-rose-400',
                },
                {
                  value: 'event', label: 'Event',
                  // Sparkle / star — generic celebration.
                  icon: (<svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><path d="M12 2l1.6 5.4L19 9l-5.4 1.6L12 16l-1.6-5.4L5 9l5.4-1.6z"/></svg>),
                  activeClass: 'bg-violet-500/20 text-violet-200 border-violet-400',
                },
              ].map(({ value, label, icon, activeClass }) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setFormData({ ...formData, type: value as any })}
                  className={`flex flex-col items-center gap-1 py-3 border-2 rounded-xl transition-all ${
                    formData.type === value
                      ? activeClass
                      : 'border-line-default/10 bg-surface-elevated text-ink-primary/60 hover:border-line-default/15 hover:text-ink-primary'
                  }`}
                >
                  {icon}
                  <div className="text-[11px] font-extrabold tracking-widest uppercase">{label}</div>
                </button>
              ))}
            </div>
          </div>

          {/* Event Title */}
          <div>
            <label className="block text-[10px] font-extrabold tracking-widest uppercase text-ink-primary/60 mb-1.5">
              Event Title *
            </label>
            <input
              type="text"
              value={formData.title}
              onChange={(e) => setFormData({ ...formData, title: e.target.value })}
              className={`w-full px-3 py-2 bg-surface-elevated text-ink-primary placeholder:text-ink-primary/30 border rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-primary/50 ${
                errors.title ? 'border-rose-300' : 'border-line-default/10'
              }`}
              placeholder={`Enter ${formData.type} title...`}
            />
            {errors.title && <p className="text-rose-600 text-xs mt-1">{errors.title}</p>}
          </div>

          {/* Date / start time / end time. A two-column row with a vertical
              divider between date and start time so the eye can tell where
              one field ends and the next begins (Patrick: "Its also hard
              to make out where the date stops and time starts"). End time
              is its own row underneath so an optional field never reads as
              a third item in the date+time pair. */}
          <div>
            <div className="grid grid-cols-[1fr_auto_1fr] gap-2 items-end">
              <div>
                <label className="block text-[10px] font-extrabold tracking-widest uppercase text-ink-primary/60 mb-1.5">
                  Date *
                </label>
                <input
                  type="date"
                  value={formData.date}
                  onChange={(e) => setFormData({ ...formData, date: e.target.value })}
                  className={`w-full px-3 py-2 bg-surface-base text-ink-primary [color-scheme:dark] border rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-primary/50 ${
                    errors.date ? 'border-rose-300' : 'border-line-default/15'
                  }`}
                />
              </div>
              <div className="w-px h-9 bg-line-default/15 self-center" aria-hidden />
              <div>
                <label className="block text-[10px] font-extrabold tracking-widest uppercase text-ink-primary/60 mb-1.5">
                  Start time *
                </label>
                <input
                  type="time"
                  value={formData.time}
                  onChange={(e) => setFormData({ ...formData, time: e.target.value })}
                  className={`w-full px-3 py-2 bg-surface-base text-ink-primary [color-scheme:dark] border rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-primary/50 ${
                    errors.time ? 'border-rose-300' : 'border-line-default/15'
                  }`}
                />
              </div>
            </div>
            {(errors.date || errors.time) && (
              <div className="grid grid-cols-2 gap-4 mt-1">
                <p className="text-rose-400 text-xs">{errors.date || ' '}</p>
                <p className="text-rose-400 text-xs">{errors.time || ' '}</p>
              </div>
            )}
          </div>

          {/* End time — optional. Lets us display a "9:00 AM – 10:30 AM"
              range on the event card / detail page so parents know when
              to actually leave. Skip and it just shows the start time. */}
          <div>
            <label className="block text-[10px] font-extrabold tracking-widest uppercase text-ink-primary/60 mb-1.5">
              End time <span className="text-ink-primary/40 font-normal">(optional)</span>
            </label>
            <input
              type="time"
              value={formData.endTime}
              onChange={(e) => setFormData({ ...formData, endTime: e.target.value })}
              className="w-full px-3 py-2 bg-surface-base text-ink-primary [color-scheme:dark] border border-line-default/15 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-primary/50"
            />
          </div>

          {/* Location: favorites + recents as quick picks, then a single
              "Pick on map" CTA that opens a full-screen visual picker.
              The map picker is the truth — typing/searching is just one
              input path inside it. This handles the OSM coverage gaps
              (e.g. local soccer fields not in OSM) since the user can
              always pan + drop the pin manually. */}
          <div>
            <label className="block text-[10px] font-extrabold tracking-widest uppercase text-ink-primary/60 mb-1.5">
              Location *
            </label>

            {favoriteLocations.length > 0 && (
              <div className="mb-2">
                <div className="text-[10px] font-extrabold tracking-widest uppercase text-ink-primary/60 mb-1">Favorites</div>
                <div className="flex gap-1.5 flex-wrap">
                  {favoriteLocations.map((f) => {
                    const active = f.name === formData.location;
                    return (
                      <button
                        key={`fav-${f.name}`}
                        type="button"
                        onClick={() => pickLocation(f)}
                        className={`text-xs font-bold px-2.5 py-1.5 rounded-md border ${
                          active
                            ? 'bg-brand-primary-soft text-brand-primary-dim border-brand-primary-soft'
                            : 'bg-surface-elevated text-ink-primary border-line-default/10 hover:border-brand-primary-soft'
                        }`}
                      >
                        {f.name}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {recentLocations.length > 0 && (
              <div className="mb-2">
                <div className="text-[10px] font-extrabold tracking-widest uppercase text-ink-primary/60 mb-1">Recent</div>
                <div className="flex gap-1.5 flex-wrap">
                  {recentLocations
                    .filter(r => !favoriteLocations.some(f => f.name.toLowerCase() === r.name.toLowerCase()))
                    .slice(0, 5)
                    .map((r) => {
                      const active = r.name === formData.location;
                      return (
                        <button
                          key={`rec-${r.name}`}
                          type="button"
                          onClick={() => pickLocation(r)}
                          className={`text-xs px-2.5 py-1.5 rounded-md border ${
                            active
                              ? 'bg-brand-primary-soft text-brand-primary-dim border-brand-primary-soft font-bold'
                              : 'bg-surface-base text-ink-primary/75 border-line-default/10 hover:bg-surface-elevated hover:border-brand-primary-soft'
                          }`}
                        >
                          {r.name}
                        </button>
                      );
                    })}
                </div>
              </div>
            )}

            {/* Inline autocomplete — type, get a dropdown of matches,
                tap to pick. No map. Mapbox-backed when REACT_APP_
                MAPBOX_TOKEN is set, OSM/Nominatim fallback otherwise.
                Picked-location card with a small (non-interactive)
                map thumbnail shows after a choice is made. */}
            {pickedCoords ? (
              <div className="rounded-xl overflow-hidden border border-line-default/10 shadow-sm">
                <iframe
                  title="Picked location"
                  src={osmEmbedUrl(pickedCoords.lat, pickedCoords.lon, 16)}
                  className="w-full h-32 block bg-surface-base pointer-events-none"
                  loading="lazy"
                />
                <div className="px-3 py-2.5 bg-surface-base border-t border-line-default/10">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-bold text-ink-primary break-words">{formData.location}</div>
                      {pickedAddress && (
                        <div className="text-[11px] text-ink-primary/60 break-words mt-0.5">{pickedAddress}</div>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setPickedCoords(null);
                        setPickedAddress('');
                        setFormData(prev => ({ ...prev, location: '' }));
                        setSearchQuery('');
                        setSearchHits([]);
                        setSearched(false);
                        setSearchOpen(true);
                      }}
                      className="text-[10px] font-extrabold tracking-widest uppercase text-brand-primary hover:text-brand-primary-dim flex-shrink-0"
                    >
                      Change ›
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <div className="relative">
                <div className="relative">
                  <svg className="absolute inset-y-0 left-0 pl-3 my-auto w-4 h-4 text-ink-primary/50" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                    <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
                  </svg>
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => { setSearchQuery(e.target.value); setSearchOpen(true); }}
                    onFocus={() => setSearchOpen(true)}
                    onBlur={() => setTimeout(() => setSearchOpen(false), 200)}
                    placeholder="Search venue or address…"
                    autoComplete="off"
                    className={`w-full pl-9 pr-16 py-2.5 text-sm bg-surface-base text-ink-primary placeholder:text-ink-primary/40 border rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-primary/50 ${
                      errors.location ? 'border-rose-300' : 'border-line-default/15'
                    }`}
                  />
                  {/* Provider tag — Google when the worker confirms its
                      Places key is configured; otherwise the static
                      provider hierarchy. Updates after the first
                      autocomplete call resolves the worker's status. */}
                  <div className="absolute right-3 top-1/2 -translate-y-1/2 text-[9px] font-extrabold tracking-widest uppercase text-ink-primary/50 pointer-events-none">
                    {isGoogleAvailable() === true ? 'Google'
                      : isGoogleAvailable() === false && hasMapbox() ? 'Mapbox'
                      : isGoogleAvailable() === false ? 'OSM'
                      : hasNotifyProxy() ? '…'
                      : hasMapbox() ? 'Mapbox' : 'OSM'}
                  </div>
                </div>
                {searchOpen && searchQuery.trim().length >= 2 && (searching || searchHits.length > 0 || searched) && (
                  <div className="absolute z-20 left-0 right-0 top-full mt-1 bg-surface-elevated rounded-xl shadow-xl ring-1 ring-slate-200 overflow-hidden max-h-80 overflow-y-auto">
                    {searching && searchHits.length === 0 && (
                      <div className="px-3 py-2 text-xs text-ink-primary/60">Searching…</div>
                    )}
                    {!searching && searched && searchHits.length === 0 && (
                      <div className="px-3 py-2.5">
                        <div className="text-xs text-ink-primary mb-1">No matches.</div>
                        <a
                          href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(searchQuery.trim())}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[11px] font-extrabold tracking-widest uppercase text-brand-primary hover:text-brand-primary-dim"
                        >
                          Look it up in Google Maps →
                        </a>
                      </div>
                    )}
                    {searchHits.map((h, i) => (
                      <button
                        key={`${h.address}_${i}`}
                        type="button"
                        onMouseDown={async (e) => {
                          e.preventDefault();
                          // Google predictions don't carry coords. Resolve
                          // via Place Details before saving so the event
                          // ends up with a real lat/lon. Cheap (~200ms)
                          // and bundled into the same billing session.
                          let resolved = h;
                          if (h.placeId || Number.isNaN(h.lat)) {
                            const r = await geocodeResolve(h);
                            if (!r) { alert("Couldn't pin down that place — try another."); return; }
                            resolved = r;
                          }
                          lastSelectedAddressRef.current = resolved.address;
                          setFormData(prev => ({ ...prev, location: resolved.label }));
                          setPickedCoords({ lat: resolved.lat, lon: resolved.lon });
                          setPickedAddress(resolved.address);
                          setSearchQuery('');
                          setSearchHits([]);
                          setSearched(false);
                          setSearchOpen(false);
                        }}
                        className="w-full text-left px-3 py-2.5 hover:bg-brand-primary/15 border-b border-line-default/5 last:border-b-0"
                      >
                        <div className="text-sm font-semibold text-ink-primary break-words">{h.label}</div>
                        {h.label !== h.address && (
                          <div className="text-[11px] text-ink-primary/60 break-words">{h.address}</div>
                        )}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {pickedCoords && (
              <div className="mt-2 flex justify-end">
                {favoriteLocations.some(f => f.name.toLowerCase() === formData.location.trim().toLowerCase()) ? (
                  <button
                    type="button"
                    onClick={() => removeFavorite(formData.location.trim())}
                    disabled={savingFavorite}
                    className="text-[10px] font-extrabold tracking-widest uppercase text-ink-primary/60 hover:text-rose-600 disabled:opacity-50"
                  >
                    Saved — Remove
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={saveCurrentAsFavorite}
                    disabled={savingFavorite}
                    className="text-[10px] font-extrabold tracking-widest uppercase text-brand-primary hover:text-brand-primary-dim disabled:opacity-50"
                  >
                    Save to team
                  </button>
                )}
              </div>
            )}

            {errors.location && <p className="text-rose-600 text-xs mt-1">{errors.location}</p>}
          </div>

          {/* Optional field/court sub-location. Hidden in display when
              empty so it doesn't add noise to events at single-field
              venues. Useful at complexes like "Little Valley Soccer
              Fields → Field 7". */}
          <div>
            <label className="block text-[10px] font-extrabold tracking-widest uppercase text-ink-primary/60 mb-1.5">
              Field <span className="text-xs text-ink-primary/50 font-normal">(optional)</span>
            </label>
            <input
              type="text"
              value={formData.fieldNumber}
              onChange={(e) => setFormData({ ...formData, fieldNumber: e.target.value })}
              placeholder="e.g. Field 7"
              className="w-full px-3 py-2 bg-surface-base text-ink-primary placeholder:text-ink-primary/40 border border-line-default/15 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-primary/50"
            />
          </div>

          {/* Home / Away — game-only. Kit labels come from the team doc
              (selectedTeam.homeKitColor / awayKitColor) so each team's
              cards reflect its own kit, not a hardcoded "Black / White".
              When the team hasn't set kits yet the label is omitted
              entirely — better silent than wrong. */}
          {formData.type === 'game' && (
            <div>
              <label className="block text-[10px] font-extrabold tracking-widest uppercase text-ink-primary/60 mb-1.5">
                Home or away
              </label>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setFormData({ ...formData, homeAway: formData.homeAway === 'home' ? '' : 'home' })}
                  className={`flex items-center justify-center gap-2.5 px-3 py-2.5 rounded-lg border-2 text-sm font-bold transition ${
                    formData.homeAway === 'home'
                      ? 'bg-surface-base text-white border-brand-primary/40 ring-2 ring-brand-primary/30'
                      : 'bg-surface-elevated text-ink-primary border-line-default/10 hover:border-line-default/20'
                  }`}
                >
                  <span
                    className="inline-block w-4 h-4 rounded-sm ring-1 ring-line-default/25"
                    style={{ backgroundColor: normalizeKit(selectedTeam?.homeKitColor) || 'transparent' }}
                    aria-hidden
                  />
                  Home
                </button>
                <button
                  type="button"
                  onClick={() => setFormData({ ...formData, homeAway: formData.homeAway === 'away' ? '' : 'away' })}
                  className={`flex items-center justify-center gap-2.5 px-3 py-2.5 rounded-lg border-2 text-sm font-bold transition ${
                    formData.homeAway === 'away'
                      ? 'bg-surface-elevated text-ink-primary border-line-default/15 ring-2 ring-brand-primary/30 shadow-inner'
                      : 'bg-surface-elevated text-ink-primary border-line-default/10 hover:border-line-default/20'
                  }`}
                >
                  <span
                    className="inline-block w-4 h-4 rounded-sm ring-1 ring-line-default/25"
                    style={{ backgroundColor: normalizeKit(selectedTeam?.awayKitColor) || 'transparent' }}
                    aria-hidden
                  />
                  Away
                </button>
              </div>
              {!selectedTeam?.homeKitColor && !selectedTeam?.awayKitColor && (
                <p className="mt-1.5 text-[11px] text-ink-primary/50">
                  Set your kit colors in Team Settings so parents know what to pack.
                </p>
              )}

              {/* Game-only meta: opt out of season stats + skip the
                  after-game POTM auto-post. Both default ON. */}
              <div className="mt-4 space-y-3 rounded-lg border border-line-default/10 bg-surface-elevated p-3">
                <label className="flex items-start gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={formData.countsToStats}
                    onChange={(e) => setFormData({ ...formData, countsToStats: e.target.checked })}
                    className="mt-0.5 w-4 h-4 accent-cyan-600"
                  />
                  <span>
                    <span className="text-sm font-semibold text-ink-primary block">Count in season stats</span>
                    <span className="text-[11px] text-ink-primary/60 block leading-snug mt-0.5">
                      Uncheck for a scrimmage or tournament game you don't want in season aggregates or leaderboards.
                    </span>
                  </span>
                </label>
                <label className="flex items-start gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={formData.autoCreatePotm}
                    onChange={(e) => setFormData({ ...formData, autoCreatePotm: e.target.checked })}
                    className="mt-0.5 w-4 h-4 accent-cyan-600"
                  />
                  <span>
                    <span className="text-sm font-semibold text-ink-primary block">Auto-open Player of the Match voting</span>
                    <span className="text-[11px] text-ink-primary/60 block leading-snug mt-0.5">
                      After this game's date, post a "Vote for POTM" prompt to the team wall automatically. Turn off for a practice game.
                    </span>
                  </span>
                </label>
              </div>
            </div>
          )}

          {/* RSVP cap — for pickup / limited-field-size events. When
              set, additional "Going" taps beyond the cap land on the
              waitlist and get auto-promoted as slots free up. */}
          <div>
            <label className="block text-[10px] font-extrabold tracking-widest uppercase text-ink-primary/60 mb-1.5">
              Cap the "Going" list (optional)
            </label>
            <input
              type="number"
              min={0}
              max={1000}
              value={formData.rsvpCap}
              onChange={(e) => setFormData({ ...formData, rsvpCap: e.target.value })}
              placeholder="e.g. 20 (blank = no cap)"
              className="w-full px-3 py-2 bg-surface-base text-ink-primary border border-line-default/15 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-primary/50"
            />
            {String(formData.rsvpCap || '').trim() && (
              <p className="text-[11px] text-ink-primary/60 mt-1 leading-snug">
                First {formData.rsvpCap} to tap Going are confirmed. Everyone else joins a waitlist and gets promoted automatically if someone drops out.
              </p>
            )}
          </div>

          {/* Drop-in fee — for pickup / field-rental use case. Needs the
              club's Stripe Connect to be set up; hidden fee prompt shows
              on EventDetail when set. */}
          <div>
            <label className="block text-[10px] font-extrabold tracking-widest uppercase text-ink-primary/60 mb-1.5">
              Drop-in fee (optional)
            </label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-primary/50 text-sm font-bold">$</span>
              <input
                type="number"
                min={0}
                step="0.50"
                value={formData.feeDollars}
                onChange={(e) => setFormData({ ...formData, feeDollars: e.target.value })}
                placeholder="e.g. 10.00"
                className="w-full pl-7 pr-3 py-2 bg-surface-base text-ink-primary border border-line-default/15 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-primary/50"
              />
            </div>
            {String(formData.feeDollars || '').trim() && (
              <p className="text-[11px] text-ink-primary/60 mt-1 leading-snug">
                Players pay this amount at RSVP time via Stripe Checkout. Requires your club's Stripe Connect to be active.
              </p>
            )}
          </div>

          {/* Arrive early — recommended for games (warmups), useful for
              practices too. Offsets are stored so they auto-shift if the
              event itself is rescheduled. */}
          <div>
            <label className="block text-[10px] font-extrabold tracking-widest uppercase text-ink-primary/60 mb-1.5">
              Arrive early
            </label>
            <select
              value={formData.arriveOffsetMinutes}
              onChange={(e) => setFormData({ ...formData, arriveOffsetMinutes: Number(e.target.value) })}
              className="w-full px-3 py-2 bg-surface-base text-ink-primary [color-scheme:dark] border border-line-default/15 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-primary/50"
            >
              <option value={0}>No arrive-early time</option>
              <option value={5}>5 minutes early</option>
              <option value={10}>10 minutes early</option>
              <option value={15}>15 minutes early</option>
              <option value={20}>20 minutes early</option>
              <option value={25}>25 minutes early</option>
              <option value={30}>30 minutes early</option>
              <option value={40}>40 minutes early</option>
              <option value={45}>45 minutes early</option>
              <option value={60}>1 hour early</option>
              <option value={75}>1 hr 15 min early</option>
              <option value={90}>1 hr 30 min early</option>
            </select>
            {formData.arriveOffsetMinutes > 0 && formData.date && formData.time && (() => {
              const start = new Date(`${formData.date}T${formData.time}`);
              const arrive = new Date(start.getTime() - formData.arriveOffsetMinutes * 60_000);
              const fmt = (d: Date) => d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
              return <p className="text-xs text-ink-primary/60 mt-1">Players should arrive by <b>{fmt(arrive)}</b> (event starts {fmt(start)}).</p>;
            })()}
          </div>

          {/* Description */}
          <div>
            <label className="block text-[10px] font-extrabold tracking-widest uppercase text-ink-primary/60 mb-1.5">
              Description (Optional)
            </label>
            <textarea
              value={formData.description}
              onChange={(e) => setFormData({ ...formData, description: e.target.value })}
              className="w-full px-3 py-2 bg-surface-base text-ink-primary placeholder:text-ink-primary/40 border border-line-default/15 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-primary/50 resize-none"
              rows={3}
              placeholder="Anything else parents should know..."
            />
          </div>

          {/* Repeat (new events only) */}
          {!editingEvent && (
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-[10px] font-extrabold tracking-widest uppercase text-ink-primary/60 mb-1.5">
                  Repeat
                </label>
                <select
                  value={formData.recurrence}
                  onChange={(e) => setFormData({ ...formData, recurrence: e.target.value as any })}
                  className="w-full px-3 py-2 bg-surface-base text-ink-primary [color-scheme:dark] border border-line-default/15 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-primary/50"
                >
                  <option value="none">Does not repeat</option>
                  <option value="daily">Every day</option>
                  <option value="weekly">Every week</option>
                  <option value="biweekly">Every 2 weeks</option>
                  <option value="monthly">Every month</option>
                </select>
              </div>
              {formData.recurrence !== 'none' && (
                <div>
                  <label className="block text-[10px] font-extrabold tracking-widest uppercase text-ink-primary/60 mb-1.5">
                    Until *
                  </label>
                  <input
                    type="date"
                    value={formData.recurrenceUntil}
                    onChange={(e) => setFormData({ ...formData, recurrenceUntil: e.target.value })}
                    min={formData.date}
                    className={`w-full px-3 py-2 bg-surface-base text-ink-primary [color-scheme:dark] border rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-primary/50 ${
                      errors.recurrenceUntil ? 'border-rose-300' : 'border-line-default/15'
                    }`}
                  />
                  {errors.recurrenceUntil && <p className="text-red-500 text-xs mt-1">{errors.recurrenceUntil}</p>}
                </div>
              )}
            </div>
          )}
          {!editingEvent && formData.recurrence !== 'none' && formData.date && formData.recurrenceUntil && (() => {
            try {
              const dt = new Date(`${formData.date}T${formData.time || '10:00'}`);
              const until = new Date(`${formData.recurrenceUntil}T${formData.time || '10:00'}`);
              const count = generateSeriesDates(dt, until, formData.recurrence).length;
              return (
                <p className="-mt-2 text-xs font-semibold text-charcoal-700 bg-brand-primary-soft border border-brand-primary-soft rounded-lg px-3 py-2">
                  Will create <b>{count}</b> events ({formData.recurrence}). Each can be edited or deleted individually.
                </p>
              );
            } catch { return null; }
          })()}

          {/* Add-ons for a new event — notification, attendance, volunteers.
              Modernized to match the top of the form: slate palette, the
              same extra-bold tracking-widest section label pattern, and
              proper toggle-row styling. */}
          {!editingEvent && (
            <div className="border-t border-line-default/10 pt-5">
              <p className="text-[10px] font-extrabold tracking-widest uppercase text-ink-primary/60 mb-3">
                Also create
              </p>
              <div className="space-y-2.5">
                {/* Notify team */}
                <label className="flex items-start gap-3 p-3 rounded-xl border border-line-default/10 hover:bg-surface-base cursor-pointer transition-colors">
                  <input
                    type="checkbox"
                    checked={formData.notifyTeam}
                    onChange={(e) => setFormData({ ...formData, notifyTeam: e.target.checked })}
                    className="mt-0.5 h-4 w-4 text-brand-primary focus:ring-brand-primary/50 border-line-default/15 rounded"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-ink-primary">
                      {editingEvent ? 'Notify team of this change' : 'Notify team'}
                    </p>
                    <p className="text-xs text-ink-primary/60 mt-0.5">
                      {editingEvent
                        ? 'Sends an "Event updated" push to everyone on the team. Use sparingly — typo fixes don\'t need a re-push.'
                        : 'Sends a push notification to everyone on the team when this event is saved.'}
                    </p>
                  </div>
                </label>

                {/* Attendance tracking */}
                {(formData.type === 'practice' || formData.type === 'game') && (
                  <label className="flex items-start gap-3 p-3 rounded-xl border border-line-default/10 hover:bg-surface-base cursor-pointer transition-colors">
                    <input
                      type="checkbox"
                      checked={formData.createAttendance}
                      onChange={(e) => setFormData({ ...formData, createAttendance: e.target.checked })}
                      className="mt-0.5 h-4 w-4 text-brand-primary focus:ring-brand-primary/50 border-line-default/15 rounded"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold text-ink-primary">Attendance tracking</p>
                      <p className="text-xs text-ink-primary/60 mt-0.5">
                        Automatically create an attendance event so you can mark who shows up.
                      </p>
                    </div>
                  </label>
                )}

                {/* Volunteer opportunities */}
                <div className="rounded-xl border border-line-default/10">
                  <label className="flex items-start gap-3 p-3 hover:bg-surface-base cursor-pointer transition-colors">
                    <input
                      type="checkbox"
                      checked={formData.createVolunteerOpps}
                      onChange={(e) => setFormData({ ...formData, createVolunteerOpps: e.target.checked })}
                      className="mt-0.5 h-4 w-4 text-brand-primary focus:ring-brand-primary/50 border-line-default/15 rounded"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold text-ink-primary">Volunteer opportunities</p>
                      <p className="text-xs text-ink-primary/60 mt-0.5">
                        Lets parents sign up to help with the event.
                      </p>
                    </div>
                  </label>
                  {formData.createVolunteerOpps && (
                    <div className="border-t border-line-default/10 p-3 space-y-2">
                      <p className="text-[10px] font-extrabold tracking-widest uppercase text-ink-primary/60">
                        Types needed
                      </p>
                      {[
                        { value: 'snacks', label: 'Snacks & drinks', desc: 'Provide refreshments' },
                        { value: 'setup', label: 'Setup help', desc: 'Equipment and field preparation' },
                        { value: 'cleanup', label: 'Cleanup', desc: 'Post-event cleanup' },
                      ].map(({ value, label, desc }) => (
                        <label key={value} className="flex items-start gap-3 p-2 rounded-lg hover:bg-surface-elevated cursor-pointer transition-colors">
                          <input
                            type="checkbox"
                            checked={formData.volunteerTypes.includes(value)}
                            onChange={(e) => handleVolunteerTypeChange(value, e.target.checked)}
                            className="mt-0.5 h-4 w-4 text-brand-primary focus:ring-brand-primary/50 border-line-default/15 rounded"
                          />
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-medium text-ink-primary">{label}</p>
                            <p className="text-xs text-ink-primary/60">{desc}</p>
                          </div>
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Event preview — modernized to slate palette and the same
              monoline SVG icon system used for the type segmented
              control above. */}
          {formData.title && formData.date && formData.time && formData.location && (
            <div className="border-t border-line-default/10 pt-5">
              <p className="text-[10px] font-extrabold tracking-widest uppercase text-ink-primary/60 mb-2">Preview</p>
              <div className="bg-surface-base rounded-xl p-4 ring-1 ring-slate-200">
                <div className="flex items-start gap-3">
                  <div className="flex-shrink-0 w-10 h-10 rounded-lg bg-surface-elevated ring-1 ring-slate-200 flex items-center justify-center text-ink-primary">
                    <EventTypeIcon type={formData.type} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <h4 className="font-semibold text-ink-primary truncate">{formData.title}</h4>
                    <div className="text-sm text-ink-primary/75 space-y-1 mt-1">
                      <div className="flex items-center gap-1.5">
                        <svg className="w-4 h-4 flex-shrink-0 text-ink-primary/50" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                          <rect x="3" y="5" width="18" height="16" rx="2" />
                          <line x1="8" y1="3" x2="8" y2="7" />
                          <line x1="16" y1="3" x2="16" y2="7" />
                          <line x1="3" y1="11" x2="21" y2="11" />
                        </svg>
                        <span>{new Date(`${formData.date}T${formData.time}`).toLocaleDateString()} at {formData.time}</span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <svg className="w-4 h-4 flex-shrink-0 text-ink-primary/50" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                          <path d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
                          <circle cx="12" cy="11" r="3" />
                        </svg>
                        <span className="truncate">{formData.location}</span>
                      </div>
                    </div>
                    {formData.description && (
                      <p className="text-sm text-ink-primary/75 mt-2">{formData.description}</p>
                    )}
                    {weather && (
                      <div className="mt-2 inline-flex items-center gap-2 px-2.5 py-1 rounded-full bg-brand-primary/15 ring-1 ring-brand-primary/30 text-brand-primary-soft text-xs font-semibold">
                        <span className="text-base leading-none">{weather.icon}</span>
                        <span>{weather.label} · {weather.tempMaxF}°/{weather.tempMinF}°F</span>
                        {weather.precipChance > 0 && <span>· {weather.precipChance}% rain</span>}
                      </div>
                    )}

                    {!editingEvent && (formData.createAttendance || formData.createVolunteerOpps) && (
                      <div className="mt-3 pt-2 border-t border-line-default/10">
                        <p className="text-[10px] font-extrabold tracking-widest uppercase text-ink-primary/60 mb-1">Will also create</p>
                        <ul className="text-xs text-ink-primary/75 space-y-1">
                          {formData.createAttendance && <li>• Attendance tracking event</li>}
                          {formData.createVolunteerOpps && formData.volunteerTypes.map((type) => (
                            <li key={type}>• {type.charAt(0).toUpperCase() + type.slice(1)} volunteer opportunity</li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                  <span className={`flex-shrink-0 px-2 py-1 text-[10px] font-extrabold tracking-widest uppercase rounded-full ${getEventTypeColor(formData.type)}`}>
                    {formData.type}
                  </span>
                </div>
              </div>
            </div>
          )}

          {/* Submit error — inline, near the action buttons. */}
          {errors.submit && (
            <div className="bg-rose-50 border border-rose-200 rounded-lg p-3">
              <p className="text-rose-700 text-sm">{errors.submit}</p>
            </div>
          )}
        </form>

        {/* Sticky footer — primary CTA always reachable without scroll.
            Cancel is in the header (mobile bottom-sheet pattern). */}
        <div className="flex-shrink-0 border-t border-line-default/10 px-4 py-3 bg-surface-elevated">
          <button
            type="button"
            onClick={() => formRef.current?.requestSubmit()}
            disabled={isSubmitting}
            className="w-full bg-gradient-to-br from-brand-primary to-surface-tint hover:from-brand-primary-soft hover:to-brand-primary text-white text-xs font-extrabold tracking-widest uppercase py-3 px-4 rounded-xl shadow-md shadow-brand-primary/30 transition disabled:opacity-50 flex items-center justify-center"
          >
            {isSubmitting ? (
              <span className="inline-flex items-center gap-2">
                <span className="inline-block animate-spin rounded-full h-4 w-4 border-2 border-line-default/30 border-t-white" aria-hidden="true" />
                <span>{editingEvent ? 'Saving…' : 'Creating…'}</span>
              </span>
            ) : (
              editingEvent ? 'Save changes' : 'Create event'
            )}
          </button>
        </div>
      </div>
    </div>
  );
};

export default EventForm;