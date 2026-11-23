import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Clock,
  Crosshair,
  Eye,
  FastForward,
  Layers,
  Loader2,
  Lock,
  MapPin,
  Moon,
  Navigation,
  Pause,
  Play,
  Radar,
  Radio,
  RotateCcw,
  Satellite,
  Search,
  Sun,
  Unlock,
  X,
} from 'lucide-react';
import {
  SATELLITE_GROUPS,
  type DataSourceKind,
} from '../data/celestrak';
import type {
  ConjunctionEvent,
  ConjunctionThresholdKm,
} from '../physics/conjunctionTypes';
import type {
  ObserverLocation,
  ObserverLookAngles,
  PassVisibility,
  SatellitePass,
} from '../physics/passes';
import type {
  SatelliteCategory,
  SatelliteGroupId,
  SatelliteRecord,
  SatelliteTelemetry,
} from '../physics/propagator';

export const SPEED_MULTIPLIERS = [1, 10, 100, 500] as const;
export type SpeedMultiplier = (typeof SPEED_MULTIPLIERS)[number];

const CITY_PRESETS: readonly ObserverLocation[] = [
  { name: 'Brno', lat: 49.1951, lon: 16.6068, altKm: 0.24 },
  { name: 'Prague', lat: 50.0755, lon: 14.4378, altKm: 0.23 },
  { name: 'London', lat: 51.5074, lon: -0.1278, altKm: 0.01 },
  { name: 'New York', lat: 40.7128, lon: -74.006, altKm: 0.01 },
  { name: 'Tokyo', lat: 35.6762, lon: 139.6503, altKm: 0.04 },
];

const CATEGORY_COLOR_HEX: Readonly<Record<SatelliteCategory, string>> =
  SATELLITE_GROUPS.reduce<Record<SatelliteCategory, string>>(
    (acc, group) => {
      acc[group.id] = group.colorHex;
      return acc;
    },
    {
      stations: '#10b981',
      visual: '#38bdf8',
      starlink: '#e0f2fe',
      gnss: '#f59e0b',
      weather: '#a855f7',
      fallback: '#38bdf8',
    },
  );

interface HudProps {
  readonly satellites: readonly SatelliteRecord[];
  readonly enabledGroups: ReadonlySet<SatelliteGroupId>;
  readonly loadingGroups: ReadonlySet<SatelliteGroupId>;
  readonly groupCounts: Readonly<Partial<Record<SatelliteGroupId, number>>>;
  readonly onToggleGroup: (groupId: SatelliteGroupId) => void;
  readonly conjunctionEvents: readonly ConjunctionEvent[];
  readonly activeConjunction: ConjunctionEvent | null;
  readonly conjunctionScanning: boolean;
  readonly conjunctionProgress: number;
  readonly conjunctionThresholdKm: ConjunctionThresholdKm;
  readonly conjunctionScannedOnce: boolean;
  readonly onConjunctionThresholdChange: (km: ConjunctionThresholdKm) => void;
  readonly onScanConjunctions: () => void;
  readonly onSelectConjunction: (event: ConjunctionEvent) => void;
  readonly onClearConjunction: () => void;
  readonly selectedTelemetry: SatelliteTelemetry | null;
  readonly selectedSunlit: boolean | null;
  readonly isCameraLocked: boolean;
  readonly onToggleCameraLock: () => void;
  readonly observer: ObserverLocation | null;
  readonly onObserverChange: (observer: ObserverLocation | null) => void;
  readonly lookAngles: ObserverLookAngles | null;
  readonly passes: readonly SatellitePass[];
  readonly onJumpToPass: (aosTime: Date) => void;
  readonly isLoading: boolean;
  readonly dataSource: DataSourceKind | null;
  readonly warning?: string;
  readonly simTimeMs: number;
  readonly isPlaying: boolean;
  readonly speed: SpeedMultiplier;
  readonly onTogglePlay: () => void;
  readonly onResetLive: () => void;
  readonly onSpeedChange: (speed: SpeedMultiplier) => void;
  readonly onSelectSatellite: (id: number, focusCamera?: boolean) => void;
  readonly onClearSelection: () => void;
}

function formatUtcClock(timeMs: number): { dateStr: string; timeStr: string } {
  const iso = new Date(timeMs).toISOString();
  return {
    dateStr: iso.slice(0, 10),
    timeStr: iso.slice(11, 19),
  };
}

function formatLatitude(deg: number): string {
  const hemi = deg >= 0 ? 'N' : 'S';
  return `${Math.abs(deg).toFixed(2)}° ${hemi}`;
}

function formatLongitude(deg: number): string {
  const hemi = deg >= 0 ? 'E' : 'W';
  return `${Math.abs(deg).toFixed(2)}° ${hemi}`;
}

function formatPassTimeUtc(date: Date): string {
  const month = date.toLocaleString('en-US', {
    month: 'short',
    timeZone: 'UTC',
  });
  const day = String(date.getUTCDate()).padStart(2, '0');
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const mm = String(date.getUTCMinutes()).padStart(2, '0');
  return `${month} ${day}, ${hh}:${mm} UTC`;
}

function getVisibilityStyle(visibility: PassVisibility): string {
  switch (visibility) {
    case 'VISIBLE':
      return 'border-emerald-400/35 bg-emerald-500/15 text-emerald-300';
    case 'DAYLIGHT':
      return 'border-amber-400/35 bg-amber-500/15 text-amber-300';
    case 'ECLIPSED':
      return 'border-slate-400/25 bg-slate-500/20 text-slate-300';
  }
}

function getDistanceBadgeStyle(distanceKm: number): string {
  if (distanceKm < 5) {
    return 'border-red-500/40 bg-red-500/20 text-red-300';
  }
  if (distanceKm < 15) {
    return 'border-amber-400/35 bg-amber-500/15 text-amber-300';
  }
  return 'border-cyan-400/30 bg-cyan-500/15 text-cyan-300';
}

function formatTcaTimeUtc(timeMs: number): string {
  return `${new Date(timeMs).toISOString().slice(11, 19)} UTC`;
}

export function Hud({
  satellites,
  enabledGroups,
  loadingGroups,
  groupCounts,
  onToggleGroup,
  conjunctionEvents,
  activeConjunction,
  conjunctionScanning,
  conjunctionProgress,
  conjunctionThresholdKm,
  conjunctionScannedOnce,
  onConjunctionThresholdChange,
  onScanConjunctions,
  onSelectConjunction,
  onClearConjunction,
  selectedTelemetry,
  selectedSunlit,
  isCameraLocked,
  onToggleCameraLock,
  observer,
  onObserverChange,
  lookAngles,
  passes,
  onJumpToPass,
  isLoading,
  dataSource,
  warning,
  simTimeMs,
  isPlaying,
  speed,
  onTogglePlay,
  onResetLive,
  onSpeedChange,
  onSelectSatellite,
  onClearSelection,
}: HudProps) {
  const [query, setQuery] = useState('');
  const [searchFocused, setSearchFocused] = useState(false);

  // Collapsible Layers, Radar & Observer panel states
  const [layersOpen, setLayersOpen] = useState(false);
  const [radarOpen, setRadarOpen] = useState(false);
  const [observerOpen, setObserverOpen] = useState(false);
  const [latInput, setLatInput] = useState(
    observer ? observer.lat.toFixed(4) : '49.1951',
  );
  const [lonInput, setLonInput] = useState(
    observer ? observer.lon.toFixed(4) : '16.6068',
  );
  const [geoError, setGeoError] = useState<string | null>(null);
  const [geoLoading, setGeoLoading] = useState(false);

  useEffect(() => {
    if (observer) {
      setLatInput(observer.lat.toFixed(4));
      setLonInput(observer.lon.toFixed(4));
    }
  }, [observer]);

  const filteredSatellites = useMemo(() => {
    const trimmed = query.trim().toLowerCase();
    if (!trimmed) {
      return satellites.slice(0, 8);
    }
    return satellites
      .filter(
        (sat) =>
          sat.name.toLowerCase().includes(trimmed) ||
          String(sat.id).includes(trimmed),
      )
      .slice(0, 10);
  }, [query, satellites]);

  const { dateStr, timeStr } = formatUtcClock(simTimeMs);

  const handleSearchSelect = (sat: SatelliteRecord): void => {
    onSelectSatellite(sat.id, true);
    setQuery('');
    setSearchFocused(false);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter' && filteredSatellites.length > 0) {
      handleSearchSelect(filteredSatellites[0]);
    } else if (event.key === 'Escape') {
      setSearchFocused(false);
    }
  };

  const handleApplyManualCoords = (event: React.FormEvent): void => {
    event.preventDefault();
    const lat = Number.parseFloat(latInput);
    const lon = Number.parseFloat(lonInput);
    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lon) ||
      lat < -90 ||
      lat > 90 ||
      lon < -180 ||
      lon > 180
    ) {
      setGeoError('Enter valid Lat (-90..90) and Lon (-180..180).');
      return;
    }
    setGeoError(null);
    onObserverChange({
      name: 'Custom',
      lat,
      lon,
      altKm: 0.1,
    });
  };

  const handleUseMyLocation = (): void => {
    if (!('geolocation' in navigator)) {
      setGeoError('Geolocation is not supported in this browser.');
      return;
    }
    setGeoError(null);
    setGeoLoading(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setGeoLoading(false);
        onObserverChange({
          name: 'My Location',
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          altKm: (pos.coords.altitude ?? 0) / 1000,
        });
      },
      (err) => {
        setGeoLoading(false);
        setGeoError(err.message || 'Location permission denied.');
      },
      { enableHighAccuracy: false, timeout: 8000 },
    );
  };

  const sourceBadge =
    dataSource === 'live'
      ? { label: 'LIVE', dot: 'bg-emerald-400' }
      : dataSource === 'snapshot'
        ? { label: 'LOCAL SNAPSHOT', dot: 'bg-cyan-400' }
        : dataSource === 'cache'
          ? { label: 'CACHED', dot: 'bg-sky-400' }
          : dataSource === 'fallback'
            ? { label: 'FALLBACK', dot: 'bg-amber-400' }
            : { label: 'SYNCING', dot: 'bg-slate-400' };

  return (
    <div className="pointer-events-none fixed inset-0 z-10 flex flex-col justify-between p-4 sm:p-5">
      {/* Floating Camera Lock Indicator Pill (Top-Center) */}
      {isCameraLocked && selectedTelemetry && (
        <div className="pointer-events-auto fixed top-4 left-1/2 z-20 -translate-x-1/2">
          <div className="flex items-center gap-2 rounded-full border border-amber-400/40 bg-slate-950/85 px-3.5 py-1.5 text-xs shadow-2xl backdrop-blur-md">
            <span className="h-2 w-2 animate-pulse rounded-full bg-amber-400" />
            <Lock className="h-3 w-3 text-amber-400" />
            <span className="max-w-[180px] truncate font-semibold tracking-wide text-amber-200">
              LOCKED: {selectedTelemetry.name}
            </span>
            <button
              type="button"
              onClick={onToggleCameraLock}
              className="ml-1 inline-flex items-center gap-1 rounded-full border border-white/15 bg-white/10 px-2 py-0.5 text-[10px] font-medium text-slate-200 transition hover:bg-white/20"
            >
              <Unlock className="h-2.5 w-2.5" />
              Unlock
              <span className="text-slate-400">(Esc)</span>
            </button>
          </div>
        </div>
      )}

      {/* Floating Active Conjunction Encounter Pill (Top-Center) */}
      {!isCameraLocked && activeConjunction && (
        <div className="pointer-events-auto fixed top-4 left-1/2 z-20 -translate-x-1/2">
          <div className="flex items-center gap-2 rounded-full border border-red-500/40 bg-slate-950/90 px-3.5 py-1.5 text-xs shadow-2xl backdrop-blur-md">
            <AlertTriangle className="h-3.5 w-3.5 animate-pulse text-red-400" />
            <span className="max-w-[240px] truncate font-semibold text-red-200">
              {activeConjunction.satAName} × {activeConjunction.satBName}
            </span>
            <span className="font-mono text-[11px] font-semibold text-amber-300">
              {activeConjunction.minDistanceKm.toFixed(1)} km
            </span>
            <button
              type="button"
              onClick={onClearConjunction}
              className="ml-1 inline-flex items-center gap-1 rounded-full border border-white/15 bg-white/10 px-2 py-0.5 text-[10px] font-medium text-slate-200 transition hover:bg-white/20"
            >
              <X className="h-2.5 w-2.5" />
              Exit
            </button>
          </div>
        </div>
      )}

      {/* Top Row: Brand + Quick Search & Collapsible Observer Panel */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        {/* Top-Left Title, Status & Collapsible Layers Switcher */}
        <div className="pointer-events-auto flex w-full flex-col gap-2 sm:w-72">
          <div className="flex items-center gap-3 rounded-xl border border-white/10 bg-slate-950/70 px-3.5 py-2.5 shadow-lg backdrop-blur-md">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-sky-500/15 text-sky-400 ring-1 ring-sky-400/25">
              <Satellite className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h1 className="text-sm font-semibold tracking-wide text-slate-100">
                  ORBITAL TRACKER
                </h1>
                <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] font-medium tracking-wider text-slate-300">
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${sourceBadge.dot}`}
                  />
                  {sourceBadge.label}
                </span>
              </div>
              <p className="text-[11px] text-slate-400">
                {isLoading
                  ? 'Loading CelesTrak orbital elements…'
                  : `${satellites.length.toLocaleString()} tracked objects · SGP4 real-time`}
              </p>
            </div>
          </div>

          {/* Collapsible Layers / Constellations Switcher */}
          <div className="rounded-xl border border-white/10 bg-slate-950/75 shadow-xl backdrop-blur-md">
            <button
              type="button"
              onClick={() => setLayersOpen((prev) => !prev)}
              className="flex w-full items-center justify-between px-3 py-2 text-left text-xs transition hover:bg-white/5"
            >
              <div className="flex items-center gap-2">
                <Layers className="h-3.5 w-3.5 text-sky-400" />
                <span className="font-semibold tracking-wide text-slate-100">
                  Layers
                </span>
                <span className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 font-mono text-[10px] text-slate-300">
                  {enabledGroups.size}/{SATELLITE_GROUPS.length}
                </span>
                {loadingGroups.size > 0 && (
                  <Loader2 className="h-3 w-3 animate-spin text-sky-400" />
                )}
              </div>
              {layersOpen ? (
                <ChevronUp className="h-3.5 w-3.5 text-slate-400" />
              ) : (
                <ChevronDown className="h-3.5 w-3.5 text-slate-400" />
              )}
            </button>

            {layersOpen && (
              <div className="space-y-1 border-t border-white/10 p-2 text-xs">
                {SATELLITE_GROUPS.map((group) => {
                  const enabled = enabledGroups.has(group.id);
                  const loading = loadingGroups.has(group.id);
                  const count = groupCounts[group.id];

                  return (
                    <button
                      key={group.id}
                      type="button"
                      role="switch"
                      aria-checked={enabled}
                      onClick={() => onToggleGroup(group.id)}
                      className="flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left transition hover:bg-white/5"
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        <span
                          className="h-2.5 w-2.5 shrink-0 rounded-full"
                          style={{ backgroundColor: group.colorHex }}
                        />
                        <span
                          className={`truncate text-xs ${
                            enabled
                              ? 'font-medium text-slate-100'
                              : 'text-slate-400'
                          }`}
                        >
                          {group.label}
                        </span>
                      </div>

                      <div className="flex shrink-0 items-center gap-2">
                        {loading ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin text-sky-400" />
                        ) : count !== undefined ? (
                          <span className="font-mono text-[10px] text-slate-400">
                            {count.toLocaleString()}
                          </span>
                        ) : null}

                        <span
                          className={`relative inline-flex h-4 w-7 items-center rounded-full transition-colors ${
                            enabled ? 'bg-sky-500/80' : 'bg-white/15'
                          }`}
                        >
                          <span
                            className={`inline-block h-3 w-3 transform rounded-full bg-white shadow transition-transform ${
                              enabled ? 'translate-x-3.5' : 'translate-x-0.5'
                            }`}
                          />
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Collapsible Conjunction Radar Panel */}
          <div className="rounded-xl border border-white/10 bg-slate-950/75 shadow-xl backdrop-blur-md">
            <button
              type="button"
              onClick={() => setRadarOpen((prev) => !prev)}
              className="flex w-full items-center justify-between px-3 py-2 text-left text-xs transition hover:bg-white/5"
            >
              <div className="flex items-center gap-2">
                <Radar
                  className={`h-3.5 w-3.5 ${
                    activeConjunction
                      ? 'text-red-400'
                      : conjunctionScanning
                        ? 'animate-spin text-amber-400'
                        : 'text-amber-400'
                  }`}
                />
                <span className="font-semibold tracking-wide text-slate-100">
                  Conjunction Radar
                </span>
                {conjunctionEvents.length > 0 && (
                  <span className="rounded-full border border-red-500/35 bg-red-500/15 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-red-300">
                    {conjunctionEvents.length}
                  </span>
                )}
              </div>
              {radarOpen ? (
                <ChevronUp className="h-3.5 w-3.5 text-slate-400" />
              ) : (
                <ChevronDown className="h-3.5 w-3.5 text-slate-400" />
              )}
            </button>

            {radarOpen && (
              <div className="space-y-2.5 border-t border-white/10 p-2.5 text-xs">
                {/* Threshold toggle + Scan button */}
                <div className="flex items-center justify-between gap-1.5">
                  <div className="flex items-center rounded-lg border border-white/10 bg-white/5 p-0.5">
                    {([25, 50] as const).map((km) => (
                      <button
                        key={km}
                        type="button"
                        disabled={conjunctionScanning}
                        onClick={() => onConjunctionThresholdChange(km)}
                        className={`rounded-md px-2 py-1 font-mono text-[10px] font-medium transition ${
                          conjunctionThresholdKm === km
                            ? 'bg-amber-500/25 text-amber-200 ring-1 ring-amber-400/40'
                            : 'text-slate-400 hover:text-slate-200'
                        }`}
                      >
                        &lt; {km} km
                      </button>
                    ))}
                  </div>

                  <button
                    type="button"
                    disabled={conjunctionScanning || satellites.length < 2}
                    onClick={onScanConjunctions}
                    className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-amber-400/35 bg-amber-500/15 px-2.5 py-1.5 text-[11px] font-semibold text-amber-200 transition hover:bg-amber-500/25 disabled:opacity-50"
                  >
                    {conjunctionScanning ? (
                      <>
                        <Loader2 className="h-3 w-3 animate-spin" />
                        Scanning…
                      </>
                    ) : (
                      <>
                        <Radar className="h-3 w-3" />
                        Scan Next 60m
                      </>
                    )}
                  </button>
                </div>

                {/* Progress bar */}
                {conjunctionScanning && (
                  <div className="space-y-1">
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
                      <div
                        className="h-full rounded-full bg-gradient-to-r from-amber-400 to-red-500 transition-all duration-150"
                        style={{ width: `${conjunctionProgress}%` }}
                      />
                    </div>
                    <div className="flex justify-between font-mono text-[10px] text-slate-400">
                      <span>Spatial hash scan</span>
                      <span>{conjunctionProgress}%</span>
                    </div>
                  </div>
                )}

                {/* Results list */}
                {!conjunctionScanning && conjunctionEvents.length > 0 && (
                  <div className="max-h-56 space-y-1.5 overflow-y-auto pr-0.5">
                    {conjunctionEvents.map((ev) => {
                      const isActive = activeConjunction?.id === ev.id;
                      return (
                        <button
                          key={ev.id}
                          type="button"
                          onClick={() => onSelectConjunction(ev)}
                          className={`w-full rounded-lg border px-2.5 py-2 text-left transition ${
                            isActive
                              ? 'border-red-500/50 bg-red-950/35'
                              : 'border-white/5 bg-white/[0.03] hover:border-white/15 hover:bg-white/[0.07]'
                          }`}
                        >
                          <div className="truncate text-[11px] font-semibold text-slate-100">
                            {ev.satAName}{' '}
                            <span className="text-slate-500">×</span>{' '}
                            {ev.satBName}
                          </div>
                          <div className="mt-1 flex items-center justify-between gap-1.5">
                            <span
                              className={`rounded-full border px-1.5 py-px font-mono text-[10px] font-semibold ${getDistanceBadgeStyle(ev.minDistanceKm)}`}
                            >
                              {ev.minDistanceKm.toFixed(1)} km
                            </span>
                            <span className="font-mono text-[10px] text-slate-300">
                              {ev.relativeVelocityKmS.toFixed(1)} km/s
                            </span>
                            <span className="font-mono text-[10px] text-slate-400">
                              {formatTcaTimeUtc(ev.tcaTimeMs)}
                            </span>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}

                {!conjunctionScanning &&
                  conjunctionScannedOnce &&
                  conjunctionEvents.length === 0 && (
                    <div className="rounded-lg border border-white/5 bg-white/[0.02] px-2.5 py-2 text-center text-[11px] text-slate-400">
                      No close approaches &lt; {conjunctionThresholdKm} km in
                      next 60m. Try enabling Starlink!
                    </div>
                  )}
              </div>
            )}
          </div>

          {warning && (
            <div className="rounded-lg border border-amber-400/25 bg-amber-950/60 px-3 py-1.5 text-[11px] text-amber-200 backdrop-blur-md">
              {warning}
            </div>
          )}
        </div>

        {/* Top-Right Stack: Quick Search + Collapsible Ground Observer Panel */}
        <div className="pointer-events-auto flex w-full flex-col gap-2 sm:w-80">
          {/* Quick Search */}
          <div className="relative">
            <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-slate-950/75 px-3 py-2 shadow-lg backdrop-blur-md focus-within:border-sky-400/50">
              <Search className="h-4 w-4 shrink-0 text-slate-400" />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onFocus={() => setSearchFocused(true)}
                onBlur={() =>
                  window.setTimeout(() => setSearchFocused(false), 150)
                }
                onKeyDown={handleKeyDown}
                placeholder="Search satellite or NORAD ID (e.g. ISS)…"
                className="w-full bg-transparent text-xs text-slate-100 placeholder-slate-500 outline-none"
                aria-label="Search satellites"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery('')}
                  className="text-slate-400 transition hover:text-slate-200"
                  aria-label="Clear search"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>

            {searchFocused && (
              <div className="absolute right-0 left-0 z-30 mt-1.5 max-h-64 overflow-y-auto rounded-xl border border-white/10 bg-slate-950/95 p-1 shadow-2xl backdrop-blur-md">
                {filteredSatellites.length === 0 ? (
                  <div className="px-3 py-2.5 text-center text-xs text-slate-500">
                    No matching satellites
                  </div>
                ) : (
                  filteredSatellites.map((sat) => (
                    <button
                      key={sat.id}
                      type="button"
                      onMouseDown={() => handleSearchSelect(sat)}
                      className="flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left text-xs transition hover:bg-white/10"
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        <span
                          className="h-2 w-2 shrink-0 rounded-full"
                          style={{
                            backgroundColor:
                              CATEGORY_COLOR_HEX[sat.category] ?? '#38bdf8',
                          }}
                        />
                        <span className="truncate font-medium text-slate-100">
                          {sat.name}
                        </span>
                      </div>
                      <span className="ml-2 shrink-0 font-mono text-[10px] text-slate-400">
                        #{sat.id}
                      </span>
                    </button>
                  ))
                )}
              </div>
            )}
          </div>

          {/* Collapsible Ground Observer & Pass Predictor Panel */}
          <div className="rounded-xl border border-white/10 bg-slate-950/75 shadow-xl backdrop-blur-md">
            <button
              type="button"
              onClick={() => setObserverOpen((prev) => !prev)}
              className="flex w-full items-center justify-between px-3 py-2 text-left text-xs transition hover:bg-white/5"
            >
              <div className="flex items-center gap-2">
                <MapPin
                  className={`h-3.5 w-3.5 ${
                    observer ? 'text-rose-400' : 'text-slate-400'
                  }`}
                />
                <span className="font-semibold tracking-wide text-slate-100">
                  Observer
                </span>
                {observer && (
                  <span className="rounded-full border border-rose-400/30 bg-rose-500/15 px-2 py-0.5 text-[10px] font-medium text-rose-200">
                    {observer.name}
                  </span>
                )}
              </div>
              {observerOpen ? (
                <ChevronUp className="h-3.5 w-3.5 text-slate-400" />
              ) : (
                <ChevronDown className="h-3.5 w-3.5 text-slate-400" />
              )}
            </button>

            {observerOpen && (
              <div className="space-y-3 border-t border-white/10 px-3 py-3 text-xs">
                {/* City Presets */}
                <div className="flex flex-wrap gap-1.5">
                  {CITY_PRESETS.map((city) => {
                    const isActive = observer?.name === city.name;
                    return (
                      <button
                        key={city.name}
                        type="button"
                        onClick={() => {
                          setGeoError(null);
                          onObserverChange(city);
                        }}
                        className={`rounded-md border px-2 py-1 text-[11px] font-medium transition ${
                          isActive
                            ? 'border-rose-400/50 bg-rose-500/20 text-rose-200'
                            : 'border-white/10 bg-white/5 text-slate-300 hover:bg-white/10'
                        }`}
                      >
                        {city.name}
                      </button>
                    );
                  })}
                </div>

                {/* Manual Lat/Lon + Geolocation */}
                <form
                  onSubmit={handleApplyManualCoords}
                  className="grid grid-cols-[1fr_1fr_auto] gap-1.5"
                >
                  <input
                    type="text"
                    value={latInput}
                    onChange={(e) => setLatInput(e.target.value)}
                    placeholder="Lat"
                    aria-label="Observer latitude"
                    className="w-full rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 font-mono text-[11px] text-slate-100 outline-none focus:border-rose-400/50"
                  />
                  <input
                    type="text"
                    value={lonInput}
                    onChange={(e) => setLonInput(e.target.value)}
                    placeholder="Lon"
                    aria-label="Observer longitude"
                    className="w-full rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 font-mono text-[11px] text-slate-100 outline-none focus:border-rose-400/50"
                  />
                  <button
                    type="submit"
                    className="rounded-lg border border-white/10 bg-white/10 px-2.5 py-1.5 text-[11px] font-medium text-slate-100 transition hover:bg-white/20"
                  >
                    Set
                  </button>
                </form>

                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={handleUseMyLocation}
                    disabled={geoLoading}
                    className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-[11px] font-medium text-slate-200 transition hover:bg-white/10 disabled:opacity-50"
                  >
                    <Navigation className="h-3 w-3 text-rose-400" />
                    {geoLoading ? 'Locating…' : 'Use My Location'}
                  </button>
                  {observer && (
                    <button
                      type="button"
                      onClick={() => onObserverChange(null)}
                      className="rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-[11px] text-slate-400 transition hover:bg-white/10 hover:text-slate-200"
                    >
                      Clear
                    </button>
                  )}
                </div>

                {geoError && (
                  <p className="text-[11px] text-amber-300">{geoError}</p>
                )}

                {/* Live Look Angles & Pass Predictor */}
                {observer && selectedTelemetry ? (
                  <div className="space-y-2.5 border-t border-white/10 pt-2.5">
                    {lookAngles && (
                      <div>
                        <div className="mb-1.5 flex items-center justify-between">
                          <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                            Live Look Angles
                          </span>
                          <span
                            className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[9px] font-semibold tracking-wider ${
                              lookAngles.isAboveHorizon
                                ? 'bg-emerald-500/20 text-emerald-300'
                                : 'bg-white/5 text-slate-400'
                            }`}
                          >
                            <Eye className="h-2.5 w-2.5" />
                            {lookAngles.isAboveHorizon
                              ? 'ABOVE HORIZON'
                              : 'BELOW HORIZON'}
                          </span>
                        </div>

                        <div
                          className={`grid grid-cols-3 gap-1.5 rounded-lg border p-2 ${
                            lookAngles.isAboveHorizon
                              ? 'border-emerald-400/30 bg-emerald-950/25'
                              : 'border-white/5 bg-white/[0.03]'
                          }`}
                        >
                          <div>
                            <div className="text-[9px] uppercase text-slate-400">
                              Elev
                            </div>
                            <div
                              className={`font-mono text-xs font-semibold ${
                                lookAngles.isAboveHorizon
                                  ? 'text-emerald-300'
                                  : 'text-slate-200'
                              }`}
                            >
                              {lookAngles.elevationDeg.toFixed(1)}°
                            </div>
                          </div>
                          <div>
                            <div className="text-[9px] uppercase text-slate-400">
                              Azim
                            </div>
                            <div className="font-mono text-xs font-semibold text-slate-200">
                              {lookAngles.azimuthDeg.toFixed(1)}°
                            </div>
                          </div>
                          <div>
                            <div className="text-[9px] uppercase text-slate-400">
                              Range
                            </div>
                            <div className="font-mono text-xs font-semibold text-slate-200">
                              {Math.round(lookAngles.rangeKm)}{' '}
                              <span className="text-[9px] font-normal text-slate-400">
                                km
                              </span>
                            </div>
                          </div>
                        </div>
                      </div>
                    )}

                    {/* Next 5 Passes */}
                    <div>
                      <div className="mb-1.5 flex items-center justify-between">
                        <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                          Next Passes (48h, &gt;10°)
                        </span>
                        <span className="text-[10px] text-slate-500">
                          {passes.length} found
                        </span>
                      </div>

                      {passes.length === 0 ? (
                        <div className="rounded-lg border border-white/5 bg-white/[0.02] px-2.5 py-2 text-center text-[11px] text-slate-500">
                          No passes above 10° in next 48 hours
                        </div>
                      ) : (
                        <div className="max-h-44 space-y-1.5 overflow-y-auto pr-0.5">
                          {passes.map((pass) => (
                            <div
                              key={pass.aosTime.getTime()}
                              className="flex items-center justify-between gap-2 rounded-lg border border-white/5 bg-white/[0.03] px-2 py-1.5"
                            >
                              <div className="min-w-0">
                                <div className="truncate font-mono text-[10px] text-slate-200">
                                  {formatPassTimeUtc(pass.aosTime)}
                                </div>
                                <div className="mt-0.5 flex items-center gap-1.5">
                                  <span className="font-mono text-[10px] font-semibold text-sky-300">
                                    Max {Math.round(pass.maxElevationDeg)}°
                                  </span>
                                  <span
                                    className={`rounded-full border px-1.5 py-px text-[9px] font-semibold tracking-wider ${getVisibilityStyle(pass.visibility)}`}
                                  >
                                    {pass.visibility}
                                  </span>
                                </div>
                              </div>

                              <button
                                type="button"
                                onClick={() => onJumpToPass(pass.aosTime)}
                                title="Jump to pass AOS at 10x speed"
                                className="inline-flex shrink-0 items-center gap-1 rounded-md border border-sky-400/30 bg-sky-500/15 px-2 py-1 text-[10px] font-semibold text-sky-300 transition hover:bg-sky-500/25"
                              >
                                <FastForward className="h-2.5 w-2.5" />
                                Jump
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                ) : (
                  <p className="border-t border-white/10 pt-2 text-[11px] text-slate-400">
                    {!observer
                      ? 'Pick a city or set coordinates to place your ground observer.'
                      : 'Select any satellite to view live look angles and upcoming passes.'}
                  </p>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Bottom Row: Telemetry Card + Time Warp Controls */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        {/* Compact Selected Satellite Telemetry Card */}
        <div className="pointer-events-auto">
          {selectedTelemetry ? (
            <div className="w-full rounded-xl border border-amber-400/25 bg-slate-950/75 p-3.5 shadow-2xl backdrop-blur-md sm:w-80">
              <div className="mb-3 flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <Radio className="h-3.5 w-3.5 shrink-0 text-amber-400" />
                    <h2 className="truncate text-sm font-semibold text-slate-100">
                      {selectedTelemetry.name}
                    </h2>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-slate-400">
                    <span className="font-mono">
                      NORAD {selectedTelemetry.id}
                    </span>
                    <span className="text-slate-600">•</span>
                    <span className="uppercase tracking-wider text-amber-300/90">
                      {selectedTelemetry.category}
                    </span>
                    {selectedSunlit !== null && (
                      <span
                        className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[9px] font-semibold tracking-wider ${
                          selectedSunlit
                            ? 'border-amber-400/35 bg-amber-500/15 text-amber-300'
                            : 'border-slate-400/25 bg-slate-500/20 text-slate-300'
                        }`}
                      >
                        {selectedSunlit ? (
                          <>
                            <Sun className="h-2.5 w-2.5" />
                            SUNLIT
                          </>
                        ) : (
                          <>
                            <Moon className="h-2.5 w-2.5" />
                            IN SHADOW
                          </>
                        )}
                      </span>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={onToggleCameraLock}
                    title={
                      isCameraLocked
                        ? 'Unlock camera (Esc)'
                        : 'Lock camera to follow satellite'
                    }
                    className={`rounded-lg p-1.5 transition ${
                      isCameraLocked
                        ? 'bg-amber-500/25 text-amber-300 ring-1 ring-amber-400/40 hover:bg-amber-500/35'
                        : 'text-slate-400 hover:bg-white/10 hover:text-slate-100'
                    }`}
                  >
                    <Crosshair className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={onClearSelection}
                    title="Close telemetry"
                    className="rounded-lg p-1.5 text-slate-400 transition hover:bg-white/10 hover:text-slate-100"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div className="rounded-lg border border-white/5 bg-white/[0.03] px-2.5 py-2">
                  <div className="text-[10px] uppercase tracking-wider text-slate-400">
                    Altitude
                  </div>
                  <div className="mt-0.5 font-mono text-sm font-medium text-slate-100">
                    {selectedTelemetry.altitudeKm.toFixed(1)}{' '}
                    <span className="text-[11px] text-slate-400">km</span>
                  </div>
                </div>

                <div className="rounded-lg border border-white/5 bg-white/[0.03] px-2.5 py-2">
                  <div className="text-[10px] uppercase tracking-wider text-slate-400">
                    Velocity
                  </div>
                  <div className="mt-0.5 font-mono text-sm font-medium text-slate-100">
                    {selectedTelemetry.velocityKmS.toFixed(2)}{' '}
                    <span className="text-[11px] text-slate-400">km/s</span>
                  </div>
                </div>

                <div className="rounded-lg border border-white/5 bg-white/[0.03] px-2.5 py-2">
                  <div className="text-[10px] uppercase tracking-wider text-slate-400">
                    Latitude
                  </div>
                  <div className="mt-0.5 font-mono text-sm font-medium text-slate-100">
                    {formatLatitude(selectedTelemetry.latitudeDeg)}
                  </div>
                </div>

                <div className="rounded-lg border border-white/5 bg-white/[0.03] px-2.5 py-2">
                  <div className="text-[10px] uppercase tracking-wider text-slate-400">
                    Longitude
                  </div>
                  <div className="mt-0.5 font-mono text-sm font-medium text-slate-100">
                    {formatLongitude(selectedTelemetry.longitudeDeg)}
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="hidden items-center gap-3 rounded-xl border border-white/10 bg-slate-950/60 px-3 py-2 text-[11px] text-slate-400 backdrop-blur-md sm:flex">
              <span className="flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full bg-emerald-400" />
                Stations
              </span>
              <span className="flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full bg-cyan-200" />
                Sunlit
              </span>
              <span className="flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full bg-slate-500" />
                In Shadow
              </span>
              <span className="text-slate-600">|</span>
              <span>Click any satellite to inspect orbit</span>
            </div>
          )}
        </div>

        {/* Time Warp Controls & Live UTC Clock */}
        <div className="pointer-events-auto flex flex-wrap items-center justify-between gap-2.5 rounded-xl border border-white/10 bg-slate-950/75 px-3.5 py-2.5 shadow-2xl backdrop-blur-md sm:flex-nowrap">
          {/* UTC Clock */}
          <div className="flex items-center gap-2 pr-1">
            <Clock className="h-3.5 w-3.5 text-sky-400" />
            <div className="font-mono leading-tight">
              <div className="text-xs font-semibold text-slate-100">
                {timeStr} <span className="text-[10px] text-sky-400">UTC</span>
              </div>
              <div className="text-[10px] text-slate-400">{dateStr}</div>
            </div>
          </div>

          <div className="hidden h-6 w-px bg-white/10 sm:block" />

          {/* Play/Pause & Live Reset */}
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={onTogglePlay}
              className="flex h-8 w-8 items-center justify-center rounded-lg border border-white/10 bg-white/5 text-slate-100 transition hover:bg-white/15"
              title={isPlaying ? 'Pause simulation' : 'Play simulation'}
              aria-label={isPlaying ? 'Pause simulation' : 'Play simulation'}
            >
              {isPlaying ? (
                <Pause className="h-3.5 w-3.5" />
              ) : (
                <Play className="h-3.5 w-3.5" />
              )}
            </button>

            <button
              type="button"
              onClick={onResetLive}
              className="flex h-8 items-center gap-1 rounded-lg border border-white/10 bg-white/5 px-2.5 text-[11px] font-medium text-slate-200 transition hover:bg-white/15"
              title="Reset to current live UTC time"
            >
              <RotateCcw className="h-3 w-3" />
              Live
            </button>
          </div>

          <div className="hidden h-6 w-px bg-white/10 sm:block" />

          {/* Speed Multipliers */}
          <div className="flex items-center gap-1">
            {SPEED_MULTIPLIERS.map((mult) => {
              const active = speed === mult;
              return (
                <button
                  key={mult}
                  type="button"
                  onClick={() => onSpeedChange(mult)}
                  className={`h-7 rounded-md px-2 font-mono text-[11px] font-medium transition ${
                    active
                      ? 'bg-sky-500/25 text-sky-300 ring-1 ring-sky-400/40'
                      : 'text-slate-400 hover:bg-white/10 hover:text-slate-200'
                  }`}
                >
                  {mult}x
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
