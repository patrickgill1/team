import React, { useState, useEffect, useRef } from 'react';
import { collection, doc, getDoc, getDocs, limit as fsLimit, orderBy, query, updateDoc, where } from 'firebase/firestore';
import { db } from '../../utils/firebase';
import { CalendarEvent } from '../../types';
import { useAuth } from '../../hooks/useAuth';
import { useTeam } from '../../contexts/TeamContext';
import { useFirestore } from '../../hooks/useFirestore';
import { getWeatherForEvent, WeatherSummary } from '../../utils/weather';
import { osmEmbedUrl, geocodeForward, geocodeResolve, hasMapbox, hasNotifyProxy, isGoogleAvailable, GeocodeHit } from '../../utils/maps';

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
  const { selectedTeamId } = useTeam();
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
    endTime: '' as string, // HH:mm, optional
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
        endTime: (() => {
          const e = (editingEvent as any).endDate;
          if (!e) return '';
          const d = e?.toDate ? e.toDate() : new Date(e);
          return d.toTimeString().slice(0, 5);
        })(),
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
        endTime: '',
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
      const updated = [...favoriteLocations, next];
      await updateDoc(doc(db, 'teams', selectedTeamId), {
        favoriteLocations: updated.map(f => ({
          name: f.name,
          address: f.address || null,
          lat: f.lat ?? null,
          lon: f.lon ?? null,
          savedAt: new Date(),
        })),
      });
      setFavoriteLocations(updated);
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
      const updated = favoriteLocations.filter(f => f.name !== name);
      await updateDoc(doc(db, 'teams', selectedTeamId), {
        favoriteLocations: updated.map(f => ({
          name: f.name,
          address: f.address || null,
          lat: f.lat ?? null,
          lon: f.lon ?? null,
        })),
      });
      setFavoriteLocations(updated);
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
      const w = await getWeatherForEvent(formData.location.trim(), dt);
      if (!cancelled) setWeather(w);
    }, 400);
    return () => { cancelled = true; clearTimeout(handle); };
  }, [formData.date, formData.time, formData.location]);

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
      console.log('Created attendance event:', attendanceEventId);
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
        console.log('Created volunteer opportunity:', oppId);
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
        type: formData.type,
        teamId: selectedTeamId,
        createdBy: userData.uid,
        createdByName: userData.name,
        arriveOffsetMinutes: formData.arriveOffsetMinutes > 0 ? formData.arriveOffsetMinutes : null,
        createdAt: new Date()
      };

      console.log('Saving event data:', eventData);

      let calendarEvent;
      if (editingEvent) {
        console.log('Updating event:', editingEvent.id);
        await updateDocument('events', editingEvent.id, eventData);
        calendarEvent = {
          ...editingEvent,
          ...eventData
        };
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
          }
        }
        console.log(`Created ${dates.length} event(s), first id ${firstId}`);
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
        endTime: '',
      });
      onClose();
    } catch (error) {
      console.error('Error saving event:', error);
      setErrors({ submit: 'Failed to save event. Please try again.' });
    } finally {
      setIsSubmitting(false);
    }
  };

  const getEventTypeIcon = (type: string) => {
    switch (type) {
      case 'game': return '⚽';
      case 'practice': return '🏃';
      case 'event': return '📅';
      default: return '📅';
    }
  };

  const getEventTypeColor = (type: string) => {
    switch (type) {
      case 'game': return 'border-rose-500 bg-rose-500/10 text-rose-700 ring-2 ring-rose-500/30';
      case 'practice': return 'border-fire-500 bg-fire-500/10 text-fire-800 ring-2 ring-fire-500/30';
      case 'event': return 'border-emerald-500 bg-emerald-500/10 text-emerald-700 ring-2 ring-emerald-500/30';
      default: return 'border-slate-300 bg-slate-100 text-slate-700';
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
    <div className="fixed inset-0 bg-navy-950/60 backdrop-blur-sm flex items-end sm:items-center justify-center z-50 sm:p-4">
      <div className="bg-white rounded-t-2xl sm:rounded-2xl sm:max-w-lg w-full max-h-[92vh] sm:max-h-[88vh] overflow-y-auto shadow-2xl ring-1 ring-slate-200">
        <div className="sticky top-0 bg-gradient-to-r from-navy-700 via-navy-600 to-fire-700 px-5 sm:px-6 py-4 z-10">
          <div className="flex items-center justify-between">
            <h2 className="text-lg sm:text-xl font-bold text-white tracking-tight">
              {editingEvent ? 'Edit Event' : 'Create New Event'}
            </h2>
            <button
              onClick={onClose}
              className="text-white/70 hover:text-white hover:bg-white/15 rounded-lg p-1 transition"
              aria-label="Close"
            >
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="p-5 sm:p-6 space-y-5">
          {/* Event Type */}
          <div>
            <label className="block text-xs font-bold uppercase tracking-wider text-slate-500 mb-2">
              Event Type *
            </label>
            <div className="grid grid-cols-3 gap-2.5">
              {[
                { value: 'practice', label: 'Practice', icon: '🏃' },
                { value: 'game', label: 'Game', icon: '⚽' },
                { value: 'event', label: 'Event', icon: '📅' }
              ].map(({ value, label, icon }) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setFormData({ ...formData, type: value as any })}
                  className={`p-3 border rounded-xl transition-all ${
                    formData.type === value
                      ? getEventTypeColor(value)
                      : 'border-slate-200 bg-white hover:border-fire-300 hover:bg-fire-50/40'
                  }`}
                >
                  <div className="text-2xl mb-1">{icon}</div>
                  <div className="text-xs font-bold">{label}</div>
                </button>
              ))}
            </div>
          </div>

          {/* Event Title */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Event Title *
            </label>
            <input
              type="text"
              value={formData.title}
              onChange={(e) => setFormData({ ...formData, title: e.target.value })}
              className={`w-full px-3 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                errors.title ? 'border-red-500' : 'border-gray-300'
              }`}
              placeholder={`Enter ${formData.type} title...`}
            />
            {errors.title && <p className="text-red-500 text-sm mt-1">{errors.title}</p>}
          </div>

          {/* Date and Time */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Date *
              </label>
              <input
                type="date"
                value={formData.date}
                onChange={(e) => setFormData({ ...formData, date: e.target.value })}
                className={`w-full px-3 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                  errors.date ? 'border-red-500' : 'border-gray-300'
                }`}
              />
              {errors.date && <p className="text-red-500 text-sm mt-1">{errors.date}</p>}
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Start time *
              </label>
              <input
                type="time"
                value={formData.time}
                onChange={(e) => setFormData({ ...formData, time: e.target.value })}
                className={`w-full px-3 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                  errors.time ? 'border-red-500' : 'border-gray-300'
                }`}
              />
              {errors.time && <p className="text-red-500 text-sm mt-1">{errors.time}</p>}
            </div>
          </div>

          {/* End time — optional. Lets us display a "9:00 AM – 10:30 AM"
              range on the event card / detail page so parents know when
              to actually leave. Skip and it just shows the start time. */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              End time <span className="text-gray-400 font-normal">(optional)</span>
            </label>
            <input
              type="time"
              value={formData.endTime}
              onChange={(e) => setFormData({ ...formData, endTime: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          {/* Location: favorites + recents as quick picks, then a single
              "Pick on map" CTA that opens a full-screen visual picker.
              The map picker is the truth — typing/searching is just one
              input path inside it. This handles the OSM coverage gaps
              (e.g. local soccer fields not in OSM) since the user can
              always pan + drop the pin manually. */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Location *
            </label>

            {favoriteLocations.length > 0 && (
              <div className="mb-2">
                <div className="text-[10px] font-extrabold tracking-widest uppercase text-slate-500 mb-1">⭐ Favorites</div>
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
                            ? 'bg-cyan-50 text-cyan-800 border-cyan-300'
                            : 'bg-white text-slate-700 border-slate-200 hover:border-cyan-300'
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
                <div className="text-[10px] font-extrabold tracking-widest uppercase text-slate-500 mb-1">Recent</div>
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
                              ? 'bg-cyan-50 text-cyan-800 border-cyan-300 font-bold'
                              : 'bg-slate-50 text-slate-600 border-slate-200 hover:bg-white hover:border-cyan-300'
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
              <div className="rounded-xl overflow-hidden border border-slate-200 shadow-sm">
                <iframe
                  title="Picked location"
                  src={osmEmbedUrl(pickedCoords.lat, pickedCoords.lon, 16)}
                  className="w-full h-32 block bg-slate-100 pointer-events-none"
                  loading="lazy"
                />
                <div className="px-3 py-2.5 bg-slate-50 border-t border-slate-200">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-bold text-slate-900 break-words">{formData.location}</div>
                      {pickedAddress && (
                        <div className="text-[11px] text-slate-500 break-words mt-0.5">{pickedAddress}</div>
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
                      className="text-[10px] font-extrabold tracking-widest uppercase text-cyan-700 hover:text-cyan-900 flex-shrink-0"
                    >
                      Change ›
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <div className="relative">
                <div className="relative">
                  <svg className="absolute inset-y-0 left-0 pl-3 my-auto w-4 h-4 text-slate-400" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
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
                    className={`w-full pl-9 pr-16 py-2.5 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-cyan-500/50 ${
                      errors.location ? 'border-rose-300' : 'border-slate-300'
                    }`}
                  />
                  {/* Provider tag — Google when the worker confirms its
                      Places key is configured; otherwise the static
                      provider hierarchy. Updates after the first
                      autocomplete call resolves the worker's status. */}
                  <div className="absolute right-3 top-1/2 -translate-y-1/2 text-[9px] font-extrabold tracking-widest uppercase text-slate-400 pointer-events-none">
                    {isGoogleAvailable() === true ? 'Google'
                      : isGoogleAvailable() === false && hasMapbox() ? 'Mapbox'
                      : isGoogleAvailable() === false ? 'OSM'
                      : hasNotifyProxy() ? '…'
                      : hasMapbox() ? 'Mapbox' : 'OSM'}
                  </div>
                </div>
                {searchOpen && searchQuery.trim().length >= 2 && (searching || searchHits.length > 0 || searched) && (
                  <div className="absolute z-20 left-0 right-0 top-full mt-1 bg-white rounded-xl shadow-xl ring-1 ring-slate-200 overflow-hidden max-h-80 overflow-y-auto">
                    {searching && searchHits.length === 0 && (
                      <div className="px-3 py-2 text-xs text-slate-500">Searching…</div>
                    )}
                    {!searching && searched && searchHits.length === 0 && (
                      <div className="px-3 py-2.5">
                        <div className="text-xs text-slate-700 mb-1">No matches.</div>
                        <a
                          href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(searchQuery.trim())}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[11px] font-extrabold tracking-widest uppercase text-cyan-700 hover:text-cyan-900"
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
                        className="w-full text-left px-3 py-2.5 hover:bg-cyan-50 border-b border-slate-100 last:border-b-0"
                      >
                        <div className="text-sm font-semibold text-slate-900 break-words">{h.label}</div>
                        {h.label !== h.address && (
                          <div className="text-[11px] text-slate-500 break-words">{h.address}</div>
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
                    className="text-[10px] font-extrabold tracking-widest uppercase text-slate-500 hover:text-rose-600 disabled:opacity-50"
                  >
                    ⭐ Saved · Remove
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={saveCurrentAsFavorite}
                    disabled={savingFavorite}
                    className="text-[10px] font-extrabold tracking-widest uppercase text-cyan-700 hover:text-cyan-900 disabled:opacity-50"
                  >
                    ⭐ Save to team
                  </button>
                )}
              </div>
            )}

            {errors.location && <p className="text-red-500 text-sm mt-1">{errors.location}</p>}
          </div>

          {/* Optional field/court sub-location. Hidden in display when
              empty so it doesn't add noise to events at single-field
              venues. Useful at complexes like "Little Valley Soccer
              Fields → Field 7". */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Field <span className="text-xs text-slate-400 font-normal">(optional)</span>
            </label>
            <input
              type="text"
              value={formData.fieldNumber}
              onChange={(e) => setFormData({ ...formData, fieldNumber: e.target.value })}
              placeholder="e.g. Field 7"
              className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-cyan-500/50"
            />
          </div>

          {/* Home / Away — game-only. Drives the jersey-color hint on
              event cards so parents know which kit to pack (home =
              black, away = white per Fire FC's rules). */}
          {formData.type === 'game' && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Home or away
              </label>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setFormData({ ...formData, homeAway: formData.homeAway === 'home' ? '' : 'home' })}
                  className={`flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg border-2 text-sm font-bold transition ${
                    formData.homeAway === 'home'
                      ? 'bg-slate-950 text-white border-slate-950 ring-2 ring-slate-300'
                      : 'bg-white text-slate-700 border-slate-200 hover:border-slate-400'
                  }`}
                >
                  🏠 Home
                  <span className={`text-[10px] font-extrabold tracking-widest uppercase ${formData.homeAway === 'home' ? 'text-slate-300' : 'text-slate-400'}`}>
                    Black
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => setFormData({ ...formData, homeAway: formData.homeAway === 'away' ? '' : 'away' })}
                  className={`flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg border-2 text-sm font-bold transition ${
                    formData.homeAway === 'away'
                      ? 'bg-white text-slate-900 border-slate-900 ring-2 ring-slate-300 shadow-inner'
                      : 'bg-white text-slate-700 border-slate-200 hover:border-slate-400'
                  }`}
                >
                  ✈ Away
                  <span className={`text-[10px] font-extrabold tracking-widest uppercase ${formData.homeAway === 'away' ? 'text-slate-500' : 'text-slate-400'}`}>
                    White
                  </span>
                </button>
              </div>
            </div>
          )}

          {/* Arrive early — recommended for games (warmups), useful for
              practices too. Offsets are stored so they auto-shift if the
              event itself is rescheduled. */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Arrive early
            </label>
            <select
              value={formData.arriveOffsetMinutes}
              onChange={(e) => setFormData({ ...formData, arriveOffsetMinutes: Number(e.target.value) })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
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
              return <p className="text-xs text-gray-500 mt-1">Players should arrive by <b>{fmt(arrive)}</b> (event starts {fmt(start)}).</p>;
            })()}
          </div>

          {/* Description */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Description (Optional)
            </label>
            <textarea
              value={formData.description}
              onChange={(e) => setFormData({ ...formData, description: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
              rows={3}
              placeholder="Add any additional details about the event..."
            />
          </div>

          {/* Repeat (new events only) */}
          {!editingEvent && (
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  🔁 Repeat
                </label>
                <select
                  value={formData.recurrence}
                  onChange={(e) => setFormData({ ...formData, recurrence: e.target.value as any })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
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
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Until *
                  </label>
                  <input
                    type="date"
                    value={formData.recurrenceUntil}
                    onChange={(e) => setFormData({ ...formData, recurrenceUntil: e.target.value })}
                    min={formData.date}
                    className={`w-full px-3 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                      errors.recurrenceUntil ? 'border-red-500' : 'border-gray-300'
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
                <p className="-mt-2 text-xs font-semibold text-navy-700 bg-fire-50 border border-fire-200 rounded-lg px-3 py-2">
                  Will create <b>{count}</b> events ({formData.recurrence}). Each can be edited or deleted individually.
                </p>
              );
            } catch { return null; }
          })()}

          {/* Integration Options (for new events only) */}
          {!editingEvent && (
            <div className="border-t pt-4">
              <h3 className="text-sm font-medium text-gray-700 mb-3">🔗 Create Related Items</h3>
              
              {/* Attendance Tracking */}
              {(formData.type === 'practice' || formData.type === 'game') && (
                <div className="mb-4">
                  <label className="flex items-center space-x-2">
                    <input
                      type="checkbox"
                      checked={formData.createAttendance}
                      onChange={(e) => setFormData({ ...formData, createAttendance: e.target.checked })}
                      className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                    />
                    <span className="text-sm font-medium text-gray-700">
                      📋 Create attendance tracking
                    </span>
                  </label>
                  <p className="text-xs text-gray-500 ml-6">
                    Automatically create an attendance event for tracking who attends
                  </p>
                </div>
              )}

              {/* Volunteer Opportunities */}
              <div>
                <label className="flex items-center space-x-2 mb-2">
                  <input
                    type="checkbox"
                    checked={formData.createVolunteerOpps}
                    onChange={(e) => setFormData({ ...formData, createVolunteerOpps: e.target.checked })}
                    className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                  />
                  <span className="text-sm font-medium text-gray-700">
                    🤝 Create volunteer opportunities
                  </span>
                </label>
                
                {formData.createVolunteerOpps && (
                  <div className="ml-6 space-y-2">
                    <p className="text-xs text-gray-500 mb-2">Select types of volunteers needed:</p>
                    {[
                      { value: 'snacks', label: '🍎 Snacks & Drinks', desc: 'Provide refreshments' },
                      { value: 'setup', label: '⚙️ Setup Help', desc: 'Equipment and field preparation' },
                      { value: 'cleanup', label: '🧹 Cleanup', desc: 'Post-event cleanup' }
                    ].map(({ value, label, desc }) => (
                      <label key={value} className="flex items-start space-x-2">
                        <input
                          type="checkbox"
                          checked={formData.volunteerTypes.includes(value)}
                          onChange={(e) => handleVolunteerTypeChange(value, e.target.checked)}
                          className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded mt-0.5"
                        />
                        <div>
                          <span className="text-sm text-gray-700">{label}</span>
                          <p className="text-xs text-gray-500">{desc}</p>
                        </div>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Event Preview */}
          {formData.title && formData.date && formData.time && formData.location && (
            <div className="border-t pt-4">
              <h3 className="text-sm font-medium text-gray-700 mb-2">Preview</h3>
              <div className="bg-gray-50 rounded-lg p-4 border border-gray-200">
                <div className="flex items-start space-x-3">
                  <div className="text-2xl">{getEventTypeIcon(formData.type)}</div>
                  <div className="flex-1">
                    <h4 className="font-semibold text-gray-900">{formData.title}</h4>
                    <div className="text-sm text-gray-600 space-y-1 mt-1">
                      <div className="flex items-center space-x-1">
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                        </svg>
                        <span>{new Date(`${formData.date}T${formData.time}`).toLocaleDateString()} at {formData.time}</span>
                      </div>
                      <div className="flex items-center space-x-1">
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
                        </svg>
                        <span>{formData.location}</span>
                      </div>
                    </div>
                    {formData.description && (
                      <p className="text-sm text-gray-600 mt-2">{formData.description}</p>
                    )}
                    {weather && (
                      <div className="mt-2 inline-flex items-center gap-2 px-2.5 py-1 rounded-full bg-fire-50 border border-fire-200 text-navy-700 text-xs font-semibold">
                        <span className="text-base leading-none">{weather.icon}</span>
                        <span>{weather.label} · {weather.tempMaxF}°/{weather.tempMinF}°F</span>
                        {weather.precipChance > 0 && <span className="text-fire-700">· {weather.precipChance}% rain</span>}
                      </div>
                    )}
                    
                    {/* Show what will be created */}
                    {!editingEvent && (formData.createAttendance || formData.createVolunteerOpps) && (
                      <div className="mt-3 pt-2 border-t border-gray-300">
                        <p className="text-xs font-medium text-gray-700 mb-1">Will also create:</p>
                        <ul className="text-xs text-gray-600 space-y-1">
                          {formData.createAttendance && (
                            <li>• Attendance tracking event</li>
                          )}
                          {formData.createVolunteerOpps && formData.volunteerTypes.map(type => (
                            <li key={type}>• {type.charAt(0).toUpperCase() + type.slice(1)} volunteer opportunity</li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                  <span className={`px-2 py-1 text-xs font-medium rounded-full border ${getEventTypeColor(formData.type)}`}>
                    {formData.type.charAt(0).toUpperCase() + formData.type.slice(1)}
                  </span>
                </div>
              </div>
            </div>
          )}

          {/* Submit Error */}
          {errors.submit && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-3">
              <p className="text-red-600 text-sm">{errors.submit}</p>
            </div>
          )}

          {/* Action Buttons */}
          <div className="flex gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              disabled={isSubmitting}
              className="flex-1 bg-slate-100 hover:bg-slate-200 text-slate-700 font-semibold py-3 px-4 rounded-xl transition disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="flex-1 bg-gradient-to-r from-fire-600 to-navy-600 hover:from-fire-500 hover:to-navy-500 text-white font-semibold py-3 px-4 rounded-xl shadow-sm hover:shadow transition disabled:opacity-50 flex items-center justify-center"
            >
              {isSubmitting ? (
                <div className="animate-spin rounded-full h-5 w-5 border-2 border-white/40 border-t-white"></div>
              ) : (
                editingEvent ? 'Update Event' : 'Create Event'
              )}
            </button>
          </div>
        </form>
      </div>

    </div>
  );
};

export default EventForm;