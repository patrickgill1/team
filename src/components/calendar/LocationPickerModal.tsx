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

// US-ish default center (Kansas) so the map opens to something sane
// for a brand-new team with zero history.
const DEFAULT_CENTER: [number, number] = [38.5, -98.0];
const DEFAULT_ZOOM = 4;
const PICKED_ZOOM = 16;

// Lazy-load the leaflet lib only when the picker actually opens.
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
  const [suggestions, setSuggestions] = useState<GeocodeHit[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searched, setSearched] = useState(false);

  // Reset internal state every time the modal opens.
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
  }, [isOpen, initial?.lat, initial?.lon]);

  // Initialize Leaflet on first render after the modal opens.
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

      // When the map stops moving, treat the new center as the picked
      // coordinate. Debounced reverse geocode follows in the next effect.
      map.on('moveend', () => {
        const c = map.getCenter();
        setPickedCoords({ lat: c.lat, lon: c.lng });
      });

      mapRef.current = map;
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

  // Reverse-geocode whenever the picked coords change (debounced).
  // Auto-fills address; only auto-fills name if it's still empty so
  // we don't clobber user-typed names ("Field 3", etc).
  useEffect(() => {
    if (!pickedCoords) return;
    let cancelled = false;
    setReverseLoading(true);
    const handle = setTimeout(async () => {
      try {
        const hit = await geocodeReverse(pickedCoords.lat, pickedCoords.lon);
        if (cancelled || !hit) return;
        if (hit.label && !name.trim()) setName(hit.label);
        setAddress(hit.address);
      } finally {
        if (!cancelled) setReverseLoading(false);
      }
    }, 450);
    return () => { cancelled = true; clearTimeout(handle); };
    // Intentionally not depending on `name`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickedCoords?.lat, pickedCoords?.lon]);

  // Forward search — debounced typeahead. Mapbox if token present,
  // Nominatim otherwise. Proximity bias picks up the current map
  // viewport so results favor where the user is looking.
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
    setName(s.label);
    setAddress(s.address);
    setPickedCoords({ lat: s.lat, lon: s.lon });
    setQuery('');
    setSuggestions([]);
    setSearched(false);
    flyTo(s.lat, s.lon);
  };

  // Last-resort "leave the app" escape hatch for users who searched
  // and got zero results from our geocoder. Opens Google Maps with the
  // query so they can find the venue, switch back, and drop the pin
  // manually. Only shown when our results are empty — not pushed in
  // the primary flow.
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
            placeholder={hasMapbox() ? 'Search venue or address…' : 'Search venue or address (OSM)…'}
            className="w-full pl-9 pr-3 py-2 text-sm bg-slate-800 border border-slate-700 text-white placeholder-slate-400 rounded-lg focus:outline-none focus:ring-2 focus:ring-cyan-500/50"
            autoComplete="off"
          />
        </div>
        {(searchLoading || suggestions.length > 0 || (searched && suggestions.length === 0)) && query.trim().length >= 2 && (
          <div className="absolute z-10 left-3 right-3 top-full mt-1 bg-white rounded-xl shadow-xl ring-1 ring-slate-300 overflow-hidden max-h-72 overflow-y-auto">
            {searchLoading && suggestions.length === 0 && (
              <div className="px-3 py-2 text-xs text-slate-500">Searching…</div>
            )}
            {!searchLoading && searched && suggestions.length === 0 && (
              <div className="px-3 py-2.5">
                <div className="text-xs text-slate-700 mb-1">No matches found.</div>
                <div className="text-[11px] text-slate-500 mb-1.5">Try panning the map and dropping the pin manually, or:</div>
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

      {/* Map area — center-pin pattern (Uber/Google Maps): the pin is
          an overlay fixed at screen center, the MAP moves underneath.
          Universally understood, works with any tile source. */}
      <div className="flex-1 relative">
        <div ref={mapContainerRef} className="absolute inset-0 bg-slate-200" />

        <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
          <div className="-translate-y-3">
            <svg className="w-8 h-8 text-rose-600 drop-shadow-lg" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5a2.5 2.5 0 1 1 0-5 2.5 2.5 0 0 1 0 5z"/>
            </svg>
            <div className="w-1.5 h-1.5 rounded-full bg-black/40 mx-auto -mt-1" />
          </div>
        </div>
      </div>

      {/* Bottom name/address card. */}
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
