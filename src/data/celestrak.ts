import type { OMMJsonObject } from 'satellite.js';
import {
  parseOmmToRecord,
  parseTleToRecord,
  type SatelliteGroupId,
  type SatelliteRecord,
  type TleSource,
} from '../physics/propagator';

const CELESTRAK_BASE_URL = 'https://celestrak.org/NORAD/elements/gp.php';
const LOCAL_SNAPSHOT_URLS: Readonly<Partial<Record<SatelliteGroupId, string>>> = {
  starlink: '/data/starlink.json',
};
const IDB_NAME = 'orbital_celestrak_cache_v1';
const IDB_STORE = 'groups';
const IDB_VERSION = 1;
const CACHE_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours
const FETCH_TIMEOUT_MS = 20_000; // Generous timeout for multi-MB Starlink feed

export type DataSourceKind = 'live' | 'cache' | 'snapshot' | 'fallback';

export interface SatelliteGroupConfig {
  readonly id: SatelliteGroupId;
  readonly label: string;
  readonly colorHex: string;
  readonly shadowColorHex: string;
  readonly defaultEnabled: boolean;
}

/**
 * Supported CelesTrak GP JSON constellation layers, ordered by deduplication priority.
 */
export const SATELLITE_GROUPS: readonly SatelliteGroupConfig[] = [
  {
    id: 'stations',
    label: 'Space Stations',
    colorHex: '#10b981',
    shadowColorHex: '#1f4f45',
    defaultEnabled: true,
  },
  {
    id: 'visual',
    label: '100 Brightest',
    colorHex: '#38bdf8',
    shadowColorHex: '#2c4f66',
    defaultEnabled: true,
  },
  {
    id: 'starlink',
    label: 'Starlink',
    colorHex: '#e0f2fe',
    shadowColorHex: '#475569',
    defaultEnabled: false,
  },
  {
    id: 'gnss',
    label: 'GPS / Galileo / GLONASS',
    colorHex: '#f59e0b',
    shadowColorHex: '#6e4c1d',
    defaultEnabled: false,
  },
  {
    id: 'weather',
    label: 'Weather Satellites',
    colorHex: '#a855f7',
    shadowColorHex: '#4c2f6b',
    defaultEnabled: false,
  },
];

export interface GroupLoadResult {
  readonly groupId: SatelliteGroupId;
  readonly satellites: SatelliteRecord[];
  readonly source: DataSourceKind;
  readonly fetchedAt: Date;
  readonly warning?: string;
}

interface CachedGroupEntry {
  readonly groupId: SatelliteGroupId;
  readonly fetchedAtMs: number;
  readonly records: OMMJsonObject[];
}

/**
 * Fallback TLEs used only if CelesTrak is unreachable / rate-limited so the app never crashes.
 */
const FALLBACK_TLES: Readonly<Partial<Record<SatelliteGroupId, readonly TleSource[]>>> = {
  stations: [
    {
      name: 'ISS (ZARYA)',
      noradId: 25544,
      intlDesignator: '1998-067A',
      line1:
        '1 25544U 98067A   25050.51782528  .00016717  00000-0  29932-3 0  9995',
      line2:
        '2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.49815350496782',
      category: 'stations',
    },
    {
      name: 'CSS (TIANHE)',
      noradId: 48274,
      intlDesignator: '2021-035A',
      line1:
        '1 48274U 21035A   25050.48391204  .00021540  00000-0  24810-3 0  9992',
      line2:
        '2 48274  41.4742 182.3412 0005124  92.1840 267.9712 15.60184210218456',
      category: 'stations',
    },
  ],
  visual: [
    {
      name: 'HST (HUBBLE)',
      noradId: 20580,
      intlDesignator: '1990-037B',
      line1:
        '1 20580U 90037B   25050.41205891  .00002145  00000-0  98124-4 0  9998',
      line2:
        '2 20580  28.4694 114.2891 0002641 215.4123 144.6290 15.09281450712491',
      category: 'visual',
    },
    {
      name: 'NOAA 19',
      noradId: 33591,
      intlDesignator: '2009-005A',
      line1:
        '1 33591U 09005A   25050.45123456  .00000112  00000-0  84512-4 0  9991',
      line2:
        '2 33591  99.0412  64.1294 0013842 142.8190 217.3921 14.12489120829104',
      category: 'visual',
    },
    {
      name: 'SENTINEL-2A',
      noradId: 40697,
      intlDesignator: '2015-028A',
      line1:
        '1 40697U 15028A   25050.39104218  .00000084  00000-0  39120-4 0  9994',
      line2:
        '2 40697  98.5681 128.4912 0001245  91.4210 268.7124 14.30818200504128',
      category: 'visual',
    },
  ],
};

// In-memory session cache so re-toggling a layer is instantaneous
const memoryCache = new Map<SatelliteGroupId, GroupLoadResult>();

function isOmmObject(value: unknown): value is OMMJsonObject {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record['OBJECT_NAME'] === 'string' &&
    (typeof record['NORAD_CAT_ID'] === 'number' ||
      typeof record['NORAD_CAT_ID'] === 'string') &&
    typeof record['EPOCH'] === 'string' &&
    (typeof record['MEAN_MOTION'] === 'number' ||
      typeof record['MEAN_MOTION'] === 'string')
  );
}

/**
 * Strips non-essential fields from raw CelesTrak GP JSON objects before persisting
 * to IndexedDB, keeping multi-thousand-object constellations (like Starlink) compact.
 */
function compactOmm(omm: OMMJsonObject): OMMJsonObject {
  return {
    OBJECT_NAME: omm.OBJECT_NAME,
    OBJECT_ID: omm.OBJECT_ID,
    EPOCH: omm.EPOCH,
    MEAN_MOTION: omm.MEAN_MOTION,
    ECCENTRICITY: omm.ECCENTRICITY,
    INCLINATION: omm.INCLINATION,
    RA_OF_ASC_NODE: omm.RA_OF_ASC_NODE,
    ARG_OF_PERICENTER: omm.ARG_OF_PERICENTER,
    MEAN_ANOMALY: omm.MEAN_ANOMALY,
    EPHEMERIS_TYPE: omm.EPHEMERIS_TYPE,
    CLASSIFICATION_TYPE: omm.CLASSIFICATION_TYPE,
    NORAD_CAT_ID: omm.NORAD_CAT_ID,
    ELEMENT_SET_NO: omm.ELEMENT_SET_NO,
    REV_AT_EPOCH: omm.REV_AT_EPOCH,
    BSTAR: omm.BSTAR,
    MEAN_MOTION_DOT: omm.MEAN_MOTION_DOT,
    MEAN_MOTION_DDOT: omm.MEAN_MOTION_DDOT,
  };
}

function openCacheDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    try {
      const request = indexedDB.open(IDB_NAME, IDB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) {
          db.createObjectStore(IDB_STORE, { keyPath: 'groupId' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function readGroupFromIdb(
  groupId: SatelliteGroupId,
): Promise<CachedGroupEntry | null> {
  const db = await openCacheDb();
  if (!db) {
    return null;
  }
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const store = tx.objectStore(IDB_STORE);
      const req = store.get(groupId);
      req.onsuccess = () => {
        const value: unknown = req.result;
        if (
          typeof value === 'object' &&
          value !== null &&
          'fetchedAtMs' in value &&
          'records' in value &&
          typeof (value as CachedGroupEntry).fetchedAtMs === 'number' &&
          Array.isArray((value as CachedGroupEntry).records)
        ) {
          const entry = value as CachedGroupEntry;
          const ageMs = Date.now() - entry.fetchedAtMs;
          if (ageMs >= 0 && ageMs <= CACHE_TTL_MS) {
            resolve(entry);
            return;
          }
        }
        resolve(null);
      };
      req.onerror = () => resolve(null);
      tx.oncomplete = () => db.close();
      tx.onerror = () => db.close();
    } catch {
      db.close();
      resolve(null);
    }
  });
}

async function writeGroupToIdb(entry: CachedGroupEntry): Promise<void> {
  const db = await openCacheDb();
  if (!db) {
    return;
  }
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(entry);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        resolve();
      };
      tx.onabort = () => {
        db.close();
        resolve();
      };
    } catch {
      db.close();
      resolve();
    }
  });
}

async function fetchLocalSnapshotJson(url: string): Promise<OMMJsonObject[]> {
  const response = await fetch(url, {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} loading local snapshot ${url}`);
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('text/html')) {
    throw new Error(`Local snapshot ${url} not found`);
  }

  const data: unknown = await response.json();
  if (!Array.isArray(data)) {
    throw new Error(`Invalid snapshot format in ${url}`);
  }

  const compacted: OMMJsonObject[] = [];
  for (let i = 0; i < data.length; i++) {
    const item = data[i];
    if (isOmmObject(item)) {
      compacted.push(compactOmm(item));
    }
  }
  return compacted;
}

async function fetchGroupJson(groupId: SatelliteGroupId): Promise<OMMJsonObject[]> {
  const url = `${CELESTRAK_BASE_URL}?GROUP=${encodeURIComponent(groupId)}&FORMAT=json`;
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} fetching ${groupId}`);
    }

    const data: unknown = await response.json();
    if (!Array.isArray(data)) {
      throw new Error(`Unexpected response format for ${groupId}`);
    }

    const compacted: OMMJsonObject[] = [];
    for (let i = 0; i < data.length; i++) {
      const item = data[i];
      if (isOmmObject(item)) {
        compacted.push(compactOmm(item));
      }
    }
    return compacted;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

function parseGroupRecords(
  records: readonly OMMJsonObject[],
  groupId: SatelliteGroupId,
): SatelliteRecord[] {
  const parsed: SatelliteRecord[] = [];
  for (let i = 0; i < records.length; i++) {
    const sat = parseOmmToRecord(records[i], groupId);
    if (sat) {
      parsed.push(sat);
    }
  }
  return parsed;
}

function buildFallbackGroup(groupId: SatelliteGroupId): SatelliteRecord[] {
  const sources = FALLBACK_TLES[groupId];
  if (!sources) {
    return [];
  }
  const records: SatelliteRecord[] = [];
  for (const tle of sources) {
    const parsed = parseTleToRecord(tle);
    if (parsed) {
      records.push(parsed);
    }
  }
  return records;
}

/**
 * Loads a single CelesTrak constellation group with in-memory + IndexedDB caching (2-hour TTL).
 * For groups with a bundled local snapshot (e.g. `starlink`), loads `/data/starlink.json` first
 * for instant, rate-limit-free access, falling back to CelesTrak live fetch if unavailable.
 */
export async function loadSatelliteGroup(
  groupId: SatelliteGroupId,
): Promise<GroupLoadResult> {
  const inMemory = memoryCache.get(groupId);
  if (inMemory && Date.now() - inMemory.fetchedAt.getTime() <= CACHE_TTL_MS) {
    return inMemory;
  }

  // Prefer bundled local snapshot first when configured (e.g. Starlink)
  const snapshotUrl = LOCAL_SNAPSHOT_URLS[groupId];
  if (snapshotUrl) {
    try {
      const snapshotRecords = await fetchLocalSnapshotJson(snapshotUrl);
      const satellites = parseGroupRecords(snapshotRecords, groupId);
      if (satellites.length > 0) {
        const result: GroupLoadResult = {
          groupId,
          satellites,
          source: 'snapshot',
          fetchedAt: new Date(),
        };
        memoryCache.set(groupId, result);
        return result;
      }
    } catch {
      // Fall through cleanly to IndexedDB cache / live CelesTrak fetch
    }
  }

  const cached = await readGroupFromIdb(groupId);
  if (cached && cached.records.length > 0) {
    const satellites = parseGroupRecords(cached.records, groupId);
    if (satellites.length > 0) {
      const result: GroupLoadResult = {
        groupId,
        satellites,
        source: 'cache',
        fetchedAt: new Date(cached.fetchedAtMs),
      };
      memoryCache.set(groupId, result);
      return result;
    }
  }

  try {
    const rawRecords = await fetchGroupJson(groupId);
    const satellites = parseGroupRecords(rawRecords, groupId);
    if (satellites.length === 0) {
      throw new Error(`No parseable orbital elements returned for ${groupId}`);
    }

    const fetchedAtMs = Date.now();
    await writeGroupToIdb({
      groupId,
      fetchedAtMs,
      records: rawRecords,
    });

    const result: GroupLoadResult = {
      groupId,
      satellites,
      source: 'live',
      fetchedAt: new Date(fetchedAtMs),
    };
    memoryCache.set(groupId, result);
    return result;
  } catch (err) {
    const reason =
      err instanceof Error ? err.message : `Unable to load ${groupId}`;
    const fallbackSatellites = buildFallbackGroup(groupId);
    return {
      groupId,
      satellites: fallbackSatellites,
      source: 'fallback',
      fetchedAt: new Date(),
      warning: `Offline fallback for ${groupId} (${reason})`,
    };
  }
}

/**
 * Merges and deduplicates active satellite groups by NORAD ID, preserving priority order
 * (stations > visual > starlink > gnss > weather).
 */
export function mergeActiveGroups(
  enabledGroups: ReadonlySet<SatelliteGroupId>,
  loadedByGroup: Readonly<Partial<Record<SatelliteGroupId, readonly SatelliteRecord[]>>>,
): SatelliteRecord[] {
  const byId = new Map<number, SatelliteRecord>();

  for (const config of SATELLITE_GROUPS) {
    if (!enabledGroups.has(config.id)) {
      continue;
    }
    const items = loadedByGroup[config.id];
    if (!items) {
      continue;
    }
    for (let i = 0; i < items.length; i++) {
      const sat = items[i];
      if (!byId.has(sat.id)) {
        byId.set(sat.id, sat);
      }
    }
  }

  return Array.from(byId.values());
}
