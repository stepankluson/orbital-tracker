import {
  degreesLat,
  degreesLong,
  eciToEcf,
  eciToGeodetic,
  gstime,
  json2satrec,
  propagate,
  radiansToDegrees,
  twoline2satrec,
  type EcfVec3,
  type EciVec3,
  type GMSTime,
  type Kilometer,
  type OMMJsonObject,
  type SatRec,
} from 'satellite.js';

/** WGS-84 equatorial Earth radius in kilometers. */
export const EARTH_RADIUS_KM = 6378.137;

/** Conversion factor from kilometers to Three.js scene units (Earth radius = 1). */
export const KM_TO_SCENE = 1 / EARTH_RADIUS_KM;

export interface SceneVec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export type SatelliteGroupId =
  | 'stations'
  | 'visual'
  | 'starlink'
  | 'gnss'
  | 'weather'
  | 'active';

export type SatelliteCategory = SatelliteGroupId | 'fallback';

export interface TleSource {
  readonly name: string;
  readonly noradId: number;
  readonly intlDesignator: string;
  readonly line1: string;
  readonly line2: string;
  readonly category: SatelliteCategory;
}

export interface SatelliteRecord {
  readonly id: number;
  readonly name: string;
  readonly intlDesignator: string;
  readonly category: SatelliteCategory;
  readonly satrec: SatRec;
  readonly periodMinutes: number;
  readonly inclinationDeg: number;
}

export interface SatelliteTelemetry {
  readonly id: number;
  readonly name: string;
  readonly intlDesignator: string;
  readonly category: SatelliteCategory;
  readonly positionScene: SceneVec3;
  readonly positionEciKm: EciVec3<Kilometer>;
  readonly positionEcfKm: EcfVec3<Kilometer>;
  readonly latitudeDeg: number;
  readonly longitudeDeg: number;
  readonly altitudeKm: number;
  readonly velocityKmS: number;
  readonly periodMinutes: number;
  readonly inclinationDeg: number;
}

/**
 * Computes Greenwich Mean Sidereal Time (GMST) in radians for a given UTC Date.
 */
export function computeGmst(date: Date): GMSTime {
  return gstime(date);
}

/**
 * Converts kilometers to Three.js scene units (Earth radius = 1).
 */
export function kmToScene(km: number): number {
  return km * KM_TO_SCENE;
}

/**
 * Converts an Earth-Centered Fixed (ECF) vector in kilometers into Three.js scene coordinates.
 *
 * Mapping (right-handed, aligned with Three.js SphereGeometry equirectangular UV):
 * - Scene +X = ECF +X (0° lat, 0° lon - Prime Meridian)
 * - Scene +Y = ECF +Z (North Pole)
 * - Scene +Z = ECF -Y (0° lat, 90° W)
 */
export function ecfKmToScene(ecf: EcfVec3<Kilometer>): SceneVec3 {
  return {
    x: ecf.x * KM_TO_SCENE,
    y: ecf.z * KM_TO_SCENE,
    z: -ecf.y * KM_TO_SCENE,
  };
}

/**
 * Converts an ECI position vector in kilometers at `date` into Three.js scene coordinates
 * (ECF-aligned, Earth radius = 1).
 */
export function eciKmToScene(
  eci: EciVec3<Kilometer>,
  date: Date,
): SceneVec3 {
  const gmst = gstime(date);
  const ecf = eciToEcf(eci, gmst);
  return ecfKmToScene(ecf);
}

/**
 * Parses a CelesTrak OMM/GP JSON record into an immutable SatelliteRecord.
 * Returns null if SGP4 initialization fails or orbital elements are invalid.
 */
export function parseOmmToRecord(
  omm: OMMJsonObject,
  category: SatelliteCategory,
): SatelliteRecord | null {
  try {
    const satrec = json2satrec(omm);
    if (satrec.error !== 0 || !Number.isFinite(satrec.no) || satrec.no <= 0) {
      return null;
    }

    const noradId = Number(omm.NORAD_CAT_ID);
    if (!Number.isFinite(noradId) || noradId <= 0) {
      return null;
    }

    const periodMinutes = (2 * Math.PI) / satrec.no;
    const inclinationDeg = radiansToDegrees(satrec.inclo);

    return {
      id: noradId,
      name: omm.OBJECT_NAME.trim(),
      intlDesignator: omm.OBJECT_ID ? omm.OBJECT_ID.trim() : '',
      category,
      satrec,
      periodMinutes,
      inclinationDeg,
    };
  } catch {
    return null;
  }
}

/**
 * Parses a Two-Line Element (TLE) set into an immutable SatelliteRecord.
 * Returns null if SGP4 initialization fails.
 */
export function parseTleToRecord(source: TleSource): SatelliteRecord | null {
  try {
    const satrec = twoline2satrec(source.line1, source.line2);
    if (satrec.error !== 0 || !Number.isFinite(satrec.no) || satrec.no <= 0) {
      return null;
    }

    const periodMinutes = (2 * Math.PI) / satrec.no;
    const inclinationDeg = radiansToDegrees(satrec.inclo);

    return {
      id: source.noradId,
      name: source.name.trim(),
      intlDesignator: source.intlDesignator.trim(),
      category: source.category,
      satrec,
      periodMinutes,
      inclinationDeg,
    };
  } catch {
    return null;
  }
}

function isFiniteVec3(vec: EciVec3<number>): boolean {
  return (
    Number.isFinite(vec.x) &&
    Number.isFinite(vec.y) &&
    Number.isFinite(vec.z)
  );
}

/**
 * Fast-path propagation returning only the Three.js scene position for a satellite at `date`.
 * Accepts a precomputed GMST to avoid redundant sidereal time calculations across a swarm.
 */
export function propagateToScenePosition(
  satrec: SatRec,
  date: Date,
  gmst: GMSTime,
): SceneVec3 | null {
  const result = propagate(satrec, date);
  if (!result || !result.position || !isFiniteVec3(result.position)) {
    return null;
  }

  const ecf = eciToEcf(result.position, gmst);
  if (!isFiniteVec3(ecf)) {
    return null;
  }

  return ecfKmToScene(ecf);
}

/**
 * Computes full orbital telemetry (ECI, ECF, geodetic lat/lon/alt, speed, and scene position)
 * for a single satellite at the given UTC Date.
 */
export function propagateTelemetry(
  record: SatelliteRecord,
  date: Date,
): SatelliteTelemetry | null {
  const result = propagate(record.satrec, date);
  if (
    !result ||
    !result.position ||
    !result.velocity ||
    !isFiniteVec3(result.position) ||
    !isFiniteVec3(result.velocity)
  ) {
    return null;
  }

  const gmst = gstime(date);
  const positionEciKm = result.position;
  const positionEcfKm = eciToEcf(positionEciKm, gmst);
  const geodetic = eciToGeodetic(positionEciKm, gmst);

  if (
    !isFiniteVec3(positionEcfKm) ||
    !Number.isFinite(geodetic.latitude) ||
    !Number.isFinite(geodetic.longitude) ||
    !Number.isFinite(geodetic.height)
  ) {
    return null;
  }

  const { x: vx, y: vy, z: vz } = result.velocity;
  const velocityKmS = Math.sqrt(vx * vx + vy * vy + vz * vz);

  return {
    id: record.id,
    name: record.name,
    intlDesignator: record.intlDesignator,
    category: record.category,
    positionScene: ecfKmToScene(positionEcfKm),
    positionEciKm,
    positionEcfKm,
    latitudeDeg: degreesLat(geodetic.latitude),
    longitudeDeg: degreesLong(geodetic.longitude),
    altitudeKm: geodetic.height,
    velocityKmS,
    periodMinutes: record.periodMinutes,
    inclinationDeg: record.inclinationDeg,
  };
}

/**
 * Samples a full orbital trajectory (one orbital period) around `referenceDate`.
 *
 * Each ECI sample is rotated into the Earth-fixed scene frame using `gmst(referenceDate)`
 * so the rendered path represents the satellite's instantaneous 3D orbital ellipse passing
 * directly through its current position.
 */
export function sampleOrbitPath(
  record: SatelliteRecord,
  referenceDate: Date,
  segments = 180,
): SceneVec3[] {
  const points: SceneVec3[] = [];
  const periodMs = Math.min(Math.max(record.periodMinutes, 60), 1500) * 60 * 1000;
  const halfPeriodMs = periodMs / 2;
  const centerTimeMs = referenceDate.getTime();
  const gmstAtRef = gstime(referenceDate);

  for (let i = 0; i <= segments; i++) {
    const fraction = i / segments;
    const sampleDate = new Date(centerTimeMs - halfPeriodMs + fraction * periodMs);
    const result = propagate(record.satrec, sampleDate);

    if (result && result.position && isFiniteVec3(result.position)) {
      const ecfInRefFrame = eciToEcf(result.position, gmstAtRef);
      if (isFiniteVec3(ecfInRefFrame)) {
        points.push(ecfKmToScene(ecfInRefFrame));
      }
    }
  }

  return points;
}
