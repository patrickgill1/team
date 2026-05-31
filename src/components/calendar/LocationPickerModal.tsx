// @ts-nocheck
import React, { useEffect, useRef, useState } from 'react';
import 'leaflet/dist/leaflet.css';
import { Capacitor } from '@capacitor/core';
import { osmEmbedUrl } from '../../utils/maps';

export interface PickedLocation {
  name: string;
  address: string;
  lat: number;
  lon: number;
}

interface Props {
  isOpen: boolean;
  initial?: {
    name?: string;
    address?: string;
    lat?: number;
    lon?: number;
  };
  /** Hint for where to center the map when no initial location is set.
   *  Usually the team's first favorite or last-used venue. Falls back
   *  to a continental-US-ish view if nothing is provided. */
  centerHint?: { lat: number; lon: number };
  onClose: () => void;
  onPick: (loc: PickedLocation) => void;
}

interface NominatimSuggestion {
  label: string;
  address: string;
  lat: number;
  lon: number;
}

// US-ish default center (Kansas) so the map opens to something sane
// for a brand-new team with zero history.
const DEFAULT_CENTER: [number, number] = [38.5, -98.0];
const DEFAULT_ZOOM = 4;
const PICKED_ZOOM = 16;

// Lazy-load the leaflet CSS + lib only when the picker actually opens.
// Keeps it out of the initial bundle (Leaflet is ~140KB minified).
async function loadLeaflet() {
  const L = await import('leaflet');
  return L.default || L;
}

const LocationPickerModal: React.FC<Props> = ({ isOpen, initial, centerHint, onClose, onPick }) => {
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<any>(null);
  const [name, setName] = useState<string>(initial?.name || '');
  const [address, setAddress] = useState<string>(initial?.address || '');
  const [pickedCoords, setPickedCoords] = useState<{ lat: number; lon: number } | null>(
    initial?.lat != null && initial?.lon != null ? { lat: initial.lat, lon: initial.lon } : null,
  );
  const [reverseLoading, setReverseLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [suggestions, setSuggestions] = useState<NominatimSuggestion[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [locating, setLocating] = useState(false);
  const [showLocationHelp, setShowLocationHelp] = useState(false);

  // Reset internal state every time the modal opens — avoids the form
  // carrying stale picked coords between two different events.
  useEffect(() => {
    if (!isOpen) return;
    setName(initial?.name || '');
    setAddress(initial?.address || '');
    setPickedCoords(
      initial?.lat != null && initial?.lon != null ? { lat: initial.lat, lon: initial.lon } : null,
    );
    setQuery('');
    setSuggestions([]);
  }, [isOpen, initial?.lat, initial?.lon]);

  // Initialize Leaflet map on first render after the modal opens.
  useEffect(() => {
    if (!isOpen || !mapContainerRef.current || mapRef.current) return;
    let cancelled = false;
    (async () => {
      const L = await loadLeaflet();
      if (cancelled || !mapContainerRef.current) return;
      const startCenter: [number, number] = pickedCoords
        ? [pickedCoords.lat, pickedCoords.lon]
        : centerHint
        ? [centerHint.lat, centerHint.lon]
        : DEFAULT_CENTER;
      const startZoom = pickedCoords ? PICKED_ZOOM : (centerHint ? 13 : DEFAULT_ZOOM);
      const map = L.map(mapContainerRef.current, {
        center: startCenter,
        zoom: startZoom,
        zoomControl: false,
      });
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap',
        maxZoom: 19,
      }).addTo(map);
      // Add zoom buttons to the BOTTOM-LEFT so they don't collide with
      // the search bar at the top or the "Use my location" FAB at the
      // bottom-right.
      L.control.zoom({ position: 'bottomleft' }).addTo(map);

      // When the map stops moving, treat the new center as the picked
      // coordinate. Debounced reverse geocode follows in the next effect.
      map.on('moveend', () => {
        const c = map.getCenter();
        setPickedCoords({ lat: c.lat, lon: c.lng });
      });

      mapRef.current = map;
      // Force a layout recalc — Leaflet sometimes initializes before the
      // container has its final size (modal animation), leaving gray
      // tiles. invalidateSize() after a frame fixes it.
      requestAnimationFrame(() => map.invalidateSize());
    })();
    return () => { cancelled = true; };
  }, [isOpen]);

  // Tear down the map when the modal closes so re-opens start clean.
  useEffect(() => {
    if (isOpen) return;
    if (mapRef.current) {
      mapRef.current.remove();
      mapRef.current = null;
    }
  }, [isOpen]);

  // Reverse-geocode whenever pickedCoords changes (debounced). Nominatim
  // reverse endpoint returns a display_name + address pieces; we use
  // those to auto-populate the address field. The user can always edit
  // the name freely (some venues — local soccer fields — aren't in OSM
  // at all, so they have to type the name).
  useEffect(() => {
    if (!pickedCoords) return;
    let cancelled = false;
    setReverseLoading(true);
    const handle = setTimeout(async () => {
      try {
        const url = `https://nominatim.openstreetmap.org/reverse?lat=${pickedCoords.lat}&lon=${pickedCoords.lon}&format=json&addressdetails=1`;
        const res = await fetch(url, { headers: { 'Accept-Language': 'en' } });
        if (!res.ok) return;
        const data: any = await res.json();
        if (cancelled) return;
        const a = data.address || {};
        const venue = a.amenity || a.leisure || a.sports_centre || a.tourism || a.building;
        // Only auto-fill the name if the user hasn't typed one yet —
        // never clobber their input.
        if (venue && !name.trim()) setName(venue);
        setAddress(data.display_name || '');
      } catch (err) {
        console.warn('reverse geocode failed', err);
      } finally {
        if (!cancelled) setReverseLoading(false);
      }
    }, 450);
    return () => { cancelled = true; clearTimeout(handle); };
    // Intentionally NOT depending on `name` here — we only want a re-
    // geocode on coord change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickedCoords?.lat, pickedCoords?.lon]);

  // Forward search (search box → suggestions). Same Nominatim source
  // as the inline form but with viewbox bias around current map view.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 3) { setSuggestions([]); return; }
    let cancelled = false;
    const handle = setTimeout(async () => {
      setSearchLoading(true);
      try {
        let viewboxParam = '';
        // Bias search by current map viewport — wherever the user is
        // looking is the most relevant area.
        if (mapRef.current) {
          const b = mapRef.current.getBounds();
          viewboxParam = `&viewbox=${b.getWest()},${b.getNorth()},${b.getEast()},${b.getSouth()}`;
        } else if (pickedCoords || centerHint) {
          const c = pickedCoords || centerHint!;
          const span = 0.75;
          viewboxParam = `&viewbox=${c.lon - span},${c.lat + span},${c.lon + span},${c.lat - span}`;
        }
        const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&addressdetails=1&limit=8&countrycodes=us,ca${viewboxParam}`;
        const res = await fetch(url, { headers: { 'Accept-Language': 'en' } });
        if (!res.ok) return;
        const data: any[] = await res.json();
        if (cancelled) return;
        setSuggestions(data.map((d: any) => {
          const a = d.address || {};
          const parts = [
            a.amenity || a.leisure || a.shop || a.tourism || a.building,
            [a.house_number, a.road].filter(Boolean).join(' '),
            a.city || a.town || a.village || a.hamlet || a.suburb,
            a.state_code || a.state,
          ].filter(Boolean);
          return {
            label: parts.length > 0 ? parts.join(', ') : d.display_name,
            address: d.display_name,
            lat: parseFloat(d.lat),
            lon: parseFloat(d.lon),
          };
        }));
      } catch (err) {
        console.warn('search failed', err);
      } finally {
        if (!cancelled) setSearchLoading(false);
      }
    }, 350);
    return () => { cancelled = true; clearTimeout(handle); };
  }, [query]);

  const flyTo = (lat: number, lon: number, zoom: number = PICKED_ZOOM) => {
    if (!mapRef.current) return;
    mapRef.current.setView([lat, lon], zoom, { animate: true });
  };

  const pickSuggestion = (s: NominatimSuggestion) => {
    setName(s.label);
    setAddress(s.address);
    setPickedCoords({ lat: s.lat, lon: s.lon });
    setQuery('');
    setSuggestions([]);
    flyTo(s.lat, s.lon);
  };

  // "Use my location" — Capacitor Geolocation on native, browser geo
  // API on web. Permission prompt happens automatically; failures are
  // silent (we just don't move the map) so the user can fall back to
  // search or manual drag.
  const useMyLocation = async () => {
    setLocating(true);
    try {
      if (Capacitor.isNativePlatform()) {
        const { Geolocation } = await import('@capacitor/geolocation');
        const perm = await Geolocation.checkPermissions();
        if (perm.location !== 'granted') {
          const req = await Geolocation.requestPermissions();
          if (req.location !== 'granted') {
            alert('Location permission is off. Enable it in Settings → Fire FC → Location.');
            return;
          }
        }
        const pos = await Geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: 8000 });
        flyTo(pos.coords.latitude, pos.coords.longitude);
      } else if (navigator.geolocation) {
        await new Promise<void>((resolve) => {
          navigator.geolocation.getCurrentPosition(
            (pos) => { flyTo(pos.coords.latitude, pos.coords.longitude); resolve(); },
            (err) => { console.warn('geolocation failed', err); resolve(); },
            { enableHighAccuracy: true, timeout: 8000 },
          );
        });
      }
    } catch (err) {
      console.warn('useMyLocation failed', err);
    } finally {
      setLocating(false);
    }
  };

  const confirm = () => {
    if (!pickedCoords || !name.trim()) return;
    onPick({
      name: name.trim(),
      address: address.trim(),
      lat: pickedCoords.lat,
      lon: pickedCoords.lon,
    });
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[60] bg-slate-950 flex flex-col">
      {/* Header */}
      <div className="flex-shrink-0 px-4 py-3 flex items-center justify-between gap-2 border-b border-slate-800 bg-slate-950">
        <button
          type="button"
          onClick={onClose}
          className="text-[11px] font-extrabold tracking-widest uppercase text-slate-400 hover:text-white px-2 py-1.5"
        >
          Cancel
        </button>
        <div className="text-xs font-extrabold tracking-widest uppercase text-white">Pick location</div>
        <button
          type="button"
          onClick={confirm}
          disabled={!pickedCoords || !name.trim()}
          className="text-[11px] font-extrabold tracking-widest uppercase px-3 py-1.5 rounded-md bg-cyan-500 text-white hover:bg-cyan-400 disabled:opacity-40"
        >
          Use this
        </button>
      </div>

      {/* Search bar with suggestions */}
      <div className="flex-shrink-0 px-3 pt-2 pb-1.5 relative bg-slate-950">
        <div className="relative">
          <svg className="absolute inset-y-0 left-0 pl-3 my-auto w-4 h-4 text-slate-400" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
            <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search venue or address…"
            className="w-full pl-9 pr-3 py-2 text-sm bg-slate-800 border border-slate-700 text-white placeholder-slate-400 rounded-lg focus:outline-none focus:ring-2 focus:ring-cyan-500/50"
            autoComplete="off"
          />
        </div>
        {(searchLoading || suggestions.length > 0) && query.trim().length >= 3 && (
          <div className="absolute z-10 left-3 right-3 top-full mt-1 bg-white rounded-xl shadow-xl ring-1 ring-slate-300 overflow-hidden max-h-72 overflow-y-auto">
            {searchLoading && suggestions.length === 0 && (
              <div className="px-3 py-2 text-xs text-slate-500">Searching…</div>
            )}
            {!searchLoading && suggestions.length === 0 && (
              <div className="px-3 py-2 text-xs text-slate-500">
                No matches. Pan the map and drop the pin manually.
              </div>
            )}
            {suggestions.map((s, idx) => (
              <button
                key={`${s.address}_${idx}`}
                type="button"
                onClick={() => pickSuggestion(s)}
                className="w-full text-left px-3 py-2 hover:bg-cyan-50 border-b border-slate-100 last:border-b-0"
              >
                <div className="text-sm font-semibold text-slate-900 truncate">{s.label}</div>
                {s.label !== s.address && (
                  <div className="text-[11px] text-slate-500 truncate">{s.address}</div>
                )}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Map area — flex-1 fills remaining space. Center-pin pattern:
          the pin is an overlay fixed at screen center, the MAP moves
          underneath. Same affordance as Uber/Lyft/Apple Maps "drop
          a pin" — universally understood. */}
      <div className="flex-1 relative">
        <div ref={mapContainerRef} className="absolute inset-0 bg-slate-200" />

        {/* Fixed center pin — pure CSS, no Leaflet marker (which would
            move with the map). Slight upward translate so the pin tip
            actually touches the centered point. */}
        <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
          <div className="-translate-y-3">
            <svg className="w-8 h-8 text-rose-600 drop-shadow-lg" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5a2.5 2.5 0 1 1 0-5 2.5 2.5 0 0 1 0 5z"/>
            </svg>
            {/* Tiny shadow dot at the actual tip — helps users see the
                exact pixel the pin is reading. */}
            <div className="w-1.5 h-1.5 rounded-full bg-black/40 mx-auto -mt-1" />
          </div>
        </div>

        {/* "Use my location" FAB + a one-tap "Why?" affordance.
            Transparent up front: device location is read for this map
            only, never stored or sent anywhere. Users with privacy
            anxieties can tap (?) to see exactly what we do with it
            before they grant the permission. */}
        <div className="absolute bottom-4 right-3 flex items-center gap-2">
          {showLocationHelp && (
            <div className="bg-white rounded-xl shadow-xl ring-1 ring-slate-200 px-3 py-2 max-w-[240px] text-[11px] text-slate-700 leading-snug">
              <div className="font-bold text-slate-900 mb-1">Location stays on your device.</div>
              We use it only to center this map on where you are. We never store it, send it anywhere, or share it.
            </div>
          )}
          <button
            type="button"
            onClick={() => setShowLocationHelp(s => !s)}
            aria-label="Why is location needed?"
            className="w-7 h-7 rounded-full bg-white/90 shadow-md ring-1 ring-slate-200 flex items-center justify-center text-slate-600 hover:bg-white text-xs font-bold"
          >
            ?
          </button>
          <button
            type="button"
            onClick={useMyLocation}
            disabled={locating}
            aria-label="Use my location"
            className="w-12 h-12 rounded-full bg-white shadow-lg ring-1 ring-slate-200 flex items-center justify-center hover:bg-slate-50 disabled:opacity-50"
          >
            <svg className={`w-5 h-5 text-cyan-700 ${locating ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
              {locating ? (
                <circle cx="12" cy="12" r="9" strokeDasharray="40 60" />
              ) : (
                <>
                  <circle cx="12" cy="12" r="3" />
                  <circle cx="12" cy="12" r="9" />
                  <line x1="12" y1="2" x2="12" y2="4" />
                  <line x1="12" y1="20" x2="12" y2="22" />
                  <line x1="2" y1="12" x2="4" y2="12" />
                  <line x1="20" y1="12" x2="22" y2="12" />
                </>
              )}
            </svg>
          </button>
        </div>
      </div>

      {/* Bottom name/address card. Slides up from the bottom edge; gives
          the coach control over the name (since OSM venues may be wrong
          or missing) while showing the reverse-geocoded street address. */}
      <div className="flex-shrink-0 bg-white border-t border-slate-200 px-4 py-3 space-y-2">
        <div>
          <label className="block text-[10px] font-extrabold tracking-widest uppercase text-slate-500 mb-1">
            Name
          </label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Little Valley Soccer Fields — Field 3"
            className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-cyan-500/40"
          />
        </div>
        <div className="text-[11px] text-slate-500 min-h-[1.25rem]">
          {reverseLoading ? 'Looking up address…'
            : address ? <>📍 {address}</>
            : 'Drag the map to drop the pin where you want it.'}
        </div>
      </div>
    </div>
  );
};

export default LocationPickerModal;
