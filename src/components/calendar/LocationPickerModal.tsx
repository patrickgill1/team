// @ts-nocheck
import React, { useEffect, useRef, useState } from 'react';
import 'leaflet/dist/leaflet.css';
import { geocodeForward, geocodeReverse, hasMapbox, mapTileConfig, GeocodeHit } from '../../utils/maps';

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

const DEFAULT_CENTER: [number, number] = [38.5, -98.0];
const DEFAULT_ZOOM = 4;
const PICKED_ZOOM = 16;

async function loadLeaflet() {
  const L = await import('leaflet');
  return L.default || L;
}

/**
 * Visual location picker. ONE primary input (search at top, overlaid
 * on the map). Picked venue shows as a card at the bottom; tap the
 * pencil to override the auto-name. The "two text bars, which one?"
 * problem of the previous version is gone — search and name are now
 * one input with a clear primary/secondary hierarchy.
 */
const LocationPickerModal: React.FC<Props> = ({ isOpen, initial, centerHint, onClose, onPick }) => {
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<any>(null);
  const nameInputRef = useRef<HTMLInputElement | null>(null);

  const [name, setName] = useState<string>(initial?.name || '');
  const [address, setAddress] = useState<string>(initial?.address || '');
  const [pickedCoords, setPickedCoords] = useState<{ lat: number; lon: number } | null>(
    initial?.lat != null && initial?.lon != null ? { lat: initial.lat, lon: initial.lon } : null,
  );
  const [reverseLoading, setReverseLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [suggestions, setSuggestions] = useState<GeocodeHit[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [editingName, setEditingName] = useState(false);
  // Once the user pans the map, suppress the auto-fill from reverse
  // geocode overwriting their custom name. The first auto-fill from a
  // tapped suggestion still wins.
  const userTouchedNameRef = useRef(false);

  useEffect(() => {
    if (!isOpen) return;
    setName(initial?.name || '');
    setAddress(initial?.address || '');
    setPickedCoords(
      initial?.lat != null && initial?.lon != null ? { lat: initial.lat, lon: initial.lon } : null,
    );
    setQuery('');
    setSuggestions([]);
    setSearched(false);
    setEditingName(false);
    userTouchedNameRef.current = !!(initial?.name && initial.name.trim());
  }, [isOpen, initial?.lat, initial?.lon]);

  // Initialize Leaflet.
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
      const tile = mapTileConfig();
      L.tileLayer(tile.url, {
        attribution: tile.attribution,
        maxZoom: tile.maxZoom,
        tileSize: tile.tileSize,
        zoomOffset: tile.zoomOffset,
      }).addTo(map);
      L.control.zoom({ position: 'bottomleft' }).addTo(map);
      map.on('moveend', () => {
        const c = map.getCenter();
        setPickedCoords({ lat: c.lat, lon: c.lng });
      });
      mapRef.current = map;
      requestAnimationFrame(() => map.invalidateSize());
    })();
    return () => { cancelled = true; };
  }, [isOpen]);

  useEffect(() => {
    if (isOpen) return;
    if (mapRef.current) {
      mapRef.current.remove();
      mapRef.current = null;
    }
  }, [isOpen]);

  // Reverse-geocode whenever the map stops on new coords.
  useEffect(() => {
    if (!pickedCoords) return;
    let cancelled = false;
    setReverseLoading(true);
    const handle = setTimeout(async () => {
      try {
        const hit = await geocodeReverse(pickedCoords.lat, pickedCoords.lon);
        if (cancelled || !hit) return;
        // Only auto-fill name when the user hasn't typed one. If they
        // tapped a search result, that's the source of truth.
        if (hit.label && !userTouchedNameRef.current) setName(hit.label);
        setAddress(hit.address);
      } finally {
        if (!cancelled) setReverseLoading(false);
      }
    }, 450);
    return () => { cancelled = true; clearTimeout(handle); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickedCoords?.lat, pickedCoords?.lon]);

  // Search input. Debounced; results show below the input.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) { setSuggestions([]); setSearched(false); return; }
    let cancelled = false;
    const handle = setTimeout(async () => {
      setSearchLoading(true);
      try {
        let proximity: { lat: number; lon: number } | undefined;
        let viewport: { west: number; south: number; east: number; north: number } | undefined;
        if (mapRef.current) {
          const c = mapRef.current.getCenter();
          proximity = { lat: c.lat, lon: c.lng };
          const b = mapRef.current.getBounds();
          viewport = { west: b.getWest(), south: b.getSouth(), east: b.getEast(), north: b.getNorth() };
        } else if (pickedCoords || centerHint) {
          const c = pickedCoords || centerHint!;
          proximity = c;
        }
        const hits = await geocodeForward(q, { proximity, viewport });
        if (cancelled) return;
        setSuggestions(hits);
        setSearched(true);
      } finally {
        if (!cancelled) setSearchLoading(false);
      }
    }, 300);
    return () => { cancelled = true; clearTimeout(handle); };
  }, [query]);

  const flyTo = (lat: number, lon: number, zoom: number = PICKED_ZOOM) => {
    if (!mapRef.current) return;
    mapRef.current.setView([lat, lon], zoom, { animate: true });
  };

  const pickSuggestion = (s: GeocodeHit) => {
    userTouchedNameRef.current = false;
    setName(s.label);
    setAddress(s.address);
    setPickedCoords({ lat: s.lat, lon: s.lon });
    setQuery('');
    setSuggestions([]);
    setSearched(false);
    flyTo(s.lat, s.lon);
  };

  const googleMapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query.trim())}`;

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
      <div className="flex-shrink-0 px-4 py-3 flex items-center justify-between gap-2 border-b border-slate-800">
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

      {/* Map fills the body. Search bar floats over the top so it
          doesn't compete with the bottom card for the role of "active
          input." Center-pin is the manual-drop affordance. */}
      <div className="flex-1 relative">
        <div ref={mapContainerRef} className="absolute inset-0 bg-slate-200" />

        {/* Floating search bar — clearly the search affordance because
            it sits on top of the map with a magnifier icon and the
            placeholder explicitly says "Search…". Suggestions float
            below it. */}
        <div className="absolute top-3 left-3 right-3 z-[1]">
          <div className="relative">
            <svg className="absolute inset-y-0 left-0 pl-3 my-auto w-4 h-4 text-slate-500" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
              <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search venue or address…"
              className="w-full pl-9 pr-3 py-2.5 text-sm bg-white text-slate-900 placeholder-slate-400 rounded-xl shadow-lg ring-1 ring-slate-200 focus:outline-none focus:ring-2 focus:ring-cyan-500/60"
              autoComplete="off"
            />
            {/* Provider tag — tiny chip so you can tell at a glance
                whether Mapbox or OSM-fallback is live. Helps debug
                "I added the token but nothing comes up" situations. */}
            <div className="absolute right-3 top-1/2 -translate-y-1/2 text-[9px] font-extrabold tracking-widest uppercase text-slate-400 pointer-events-none">
              {hasMapbox() ? 'Mapbox' : 'OSM'}
            </div>
          </div>

          {(searchLoading || suggestions.length > 0 || (searched && suggestions.length === 0)) && query.trim().length >= 2 && (
            <div className="mt-1 bg-white rounded-xl shadow-xl ring-1 ring-slate-300 overflow-hidden max-h-[40vh] overflow-y-auto">
              {searchLoading && suggestions.length === 0 && (
                <div className="px-3 py-2 text-xs text-slate-500">Searching…</div>
              )}
              {!searchLoading && searched && suggestions.length === 0 && (
                <div className="px-3 py-2.5">
                  <div className="text-xs text-slate-700 mb-1">No matches.</div>
                  <div className="text-[11px] text-slate-500 mb-1.5">
                    Pan the map and drop the pin manually, or:
                  </div>
                  <a
                    href={googleMapsUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[11px] font-extrabold tracking-widest uppercase text-cyan-700 hover:text-cyan-900"
                  >
                    Look it up in Google Maps →
                  </a>
                </div>
              )}
              {suggestions.map((s, idx) => (
                <button
                  key={`${s.address}_${idx}`}
                  type="button"
                  onClick={() => pickSuggestion(s)}
                  className="w-full text-left px-3 py-2.5 hover:bg-cyan-50 border-b border-slate-100 last:border-b-0"
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

        {/* Center pin — fixed at screen center, map slides under it. */}
        <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
          <div className="-translate-y-3">
            <svg className="w-8 h-8 text-rose-600 drop-shadow-lg" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5a2.5 2.5 0 1 1 0-5 2.5 2.5 0 0 1 0 5z"/>
            </svg>
            <div className="w-1.5 h-1.5 rounded-full bg-black/40 mx-auto -mt-1" />
          </div>
        </div>
      </div>

      {/* Bottom: picked-location card. Name is shown as bold text by
          default — tap the pencil to edit inline. This makes search
          the obviously-primary input (top of map) and naming the
          obviously-secondary action (only when you need to override
          the auto-name). */}
      <div className="flex-shrink-0 bg-white border-t border-slate-200 px-4 py-3">
        {pickedCoords ? (
          <div>
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                {editingName ? (
                  <input
                    ref={nameInputRef}
                    value={name}
                    onChange={(e) => { setName(e.target.value); userTouchedNameRef.current = true; }}
                    onBlur={() => setEditingName(false)}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); setEditingName(false); } }}
                    placeholder="e.g. Little Valley SF — Field 3"
                    autoFocus
                    className="w-full px-2 py-1 text-base font-bold text-slate-900 border border-cyan-300 rounded-md focus:outline-none focus:ring-2 focus:ring-cyan-500/40"
                  />
                ) : (
                  <div className="text-base font-bold text-slate-900 leading-tight break-words">
                    {name || <span className="italic text-slate-400">Untitled spot</span>}
                  </div>
                )}
                <div className="mt-0.5 text-[11px] text-slate-500 break-words">
                  {reverseLoading ? 'Looking up address…'
                    : address ? <>📍 {address}</>
                    : <span className="italic">Drag the map to pick a spot.</span>}
                </div>
              </div>
              {!editingName && (
                <button
                  type="button"
                  onClick={() => { setEditingName(true); requestAnimationFrame(() => nameInputRef.current?.select()); }}
                  className="text-[10px] font-extrabold tracking-widest uppercase text-cyan-700 hover:text-cyan-900 flex-shrink-0"
                  aria-label="Edit name"
                >
                  ✎ Edit name
                </button>
              )}
            </div>
          </div>
        ) : (
          <div className="text-sm text-slate-500 text-center py-2">
            Search above or drag the map to drop a pin.
          </div>
        )}
      </div>
    </div>
  );
};

export default LocationPickerModal;
