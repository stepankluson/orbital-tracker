import { computeGmst, ecfKmToScene, type SceneVec3 } from './propagator';

/** Mean Earth radius in kilometers used for cylindrical shadow & horizon models. */
export const MEAN_EARTH_RADIUS_KM = 6371.0;

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;
const MS_PER_DAY = 86_400_000;
const UNIX_EPOCH_JD = 2440587.5;
const J2000_JD = 2451545.0;

export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface SubsolarPoint {
  readonly latitudeDeg: number;
  readonly longitudeDeg: number;
  readonly declinationRad: number;
  readonly rightAscensionRad: number;
}

function normalizeDegrees360(deg: number): number {
  const mod = deg % 360;
  return mod < 0 ? mod + 360 : mod;
}

function normalizeRadiansPi(rad: number): number {
  let r = (rad + Math.PI) % (2 * Math.PI);
  if (r < 0) {
    r += 2 * Math.PI;
  }
  return r - Math.PI;
}

/**
 * Computes the real-time subsolar latitude/longitude and equatorial coordinates
 * (Right Ascension, Declination) for a given UTC Date using standard low-precision
 * USNO / Almanac solar ephemeris equations (accurate to ~0.01°).
 */
export function getSubsolarPoint(date: Date): SubsolarPoint {
  const jd = date.getTime() / MS_PER_DAY + UNIX_EPOCH_JD;
  const n = jd - J2000_JD;

  // Mean longitude and mean anomaly of the Sun (degrees)
  const meanLonDeg = normalizeDegrees360(280.46 + 0.9856474 * n);
  const meanAnomRad = normalizeDegrees360(357.528 + 0.9856003 * n) * DEG_TO_RAD;

  // Ecliptic longitude and obliquity of the ecliptic
  const eclipticLonRad =
    (meanLonDeg +
      1.915 * Math.sin(meanAnomRad) +
      0.02 * Math.sin(2 * meanAnomRad)) *
    DEG_TO_RAD;
  const obliquityRad = (23.439 - 0.0000004 * n) * DEG_TO_RAD;

  const sinLambda = Math.sin(eclipticLonRad);
  const cosLambda = Math.cos(eclipticLonRad);

  const rightAscensionRad = Math.atan2(
    Math.cos(obliquityRad) * sinLambda,
    cosLambda,
  );
  const declinationRad = Math.asin(Math.sin(obliquityRad) * sinLambda);

  // Greenwich Mean Sidereal Time aligns ECI Right Ascension to ECF East Longitude:
  // East longitude of subsolar point = RA - GMST
  const gmstRad = computeGmst(date);
  const subsolarLonRad = normalizeRadiansPi(rightAscensionRad - gmstRad);

  return {
    latitudeDeg: declinationRad * RAD_TO_DEG,
    longitudeDeg: subsolarLonRad * RAD_TO_DEG,
    declinationRad,
    rightAscensionRad,
  };
}

/**
 * Computes the unit Sun direction vector in the Earth-Centered Fixed (ECF) frame
 * for the given UTC Date.
 */
export function getSunDirectionEcf(date: Date): Vec3 {
  const { declinationRad, longitudeDeg } = getSubsolarPoint(date);
  const lonRad = longitudeDeg * DEG_TO_RAD;
  const cosLat = Math.cos(declinationRad);

  return {
    x: cosLat * Math.cos(lonRad),
    y: cosLat * Math.sin(lonRad),
    z: Math.sin(declinationRad),
  };
}

/**
 * Computes the unit Sun direction vector in the Three.js scene frame (ECF-aligned)
 * used by Earth, satellites, and orbital paths.
 */
export function getSunDirectionScene(date: Date): SceneVec3 {
  const ecfDir = getSunDirectionEcf(date);
  // ecfKmToScene scales by KM_TO_SCENE, so apply the pure rotation directly
  const rotated = ecfKmToScene(ecfDir);
  const len = Math.hypot(rotated.x, rotated.y, rotated.z) || 1;
  return {
    x: rotated.x / len,
    y: rotated.y / len,
    z: rotated.z / len,
  };
}

/**
 * Determines whether a satellite is sunlit or in Earth's shadow using a
 * cylindrical Earth shadow model (R_E = 6371 km).
 *
 * `satPosKm` and `sunDir` must be in the same 3D coordinate frame (e.g. both ECF or both Scene).
 * A satellite is in shadow iff:
 *   1. It is on the night side: dot(satPosKm, sunDir) < 0
 *   2. Its perpendicular distance to the Sun-Earth axis is < R_E (6371 km).
 */
export function isSatelliteSunlit(satPosKm: Vec3, sunDir: Vec3): boolean {
  const sunLen = Math.hypot(sunDir.x, sunDir.y, sunDir.z);
  if (sunLen === 0) {
    return true;
  }

  const sx = sunDir.x / sunLen;
  const sy = sunDir.y / sunLen;
  const sz = sunDir.z / sunLen;

  const proj = satPosKm.x * sx + satPosKm.y * sy + satPosKm.z * sz;
  if (proj >= 0) {
    return true;
  }

  const px = satPosKm.x - proj * sx;
  const py = satPosKm.y - proj * sy;
  const pz = satPosKm.z - proj * sz;
  const perpDistSq = px * px + py * py + pz * pz;

  return perpDistSq >= MEAN_EARTH_RADIUS_KM * MEAN_EARTH_RADIUS_KM;
}

/**
 * Calculates the geometric horizon visibility half-angle (radians) from a satellite
 * at `altitudeKm` above a spherical Earth of radius R_E = 6371 km:
 *   theta = arccos(R_E / (R_E + h))
 */
export function computeHorizonAngleRad(altitudeKm: number): number {
  const safeAlt = Math.max(0, altitudeKm);
  const ratio = Math.min(1, MEAN_EARTH_RADIUS_KM / (MEAN_EARTH_RADIUS_KM + safeAlt));
  return Math.acos(ratio);
}

/**
 * Computes an orthonormal tangent basis (east/tangent1, north/tangent2)
 * perpendicular to a unit surface normal `n`.
 */
export function computeTangentBasis(n: SceneVec3): {
  readonly t1: SceneVec3;
  readonly t2: SceneVec3;
} {
  // Choose a reference axis not parallel to n
  const refX = Math.abs(n.y) < 0.9 ? 0 : 1;
  const refY = Math.abs(n.y) < 0.9 ? 1 : 0;
  const refZ = 0;

  // t1 = normalize(ref × n)
  const c1x = refY * n.z - refZ * n.y;
  const c1y = refZ * n.x - refX * n.z;
  const c1z = refX * n.y - refY * n.x;
  const len1 = Math.hypot(c1x, c1y, c1z) || 1;
  const t1: SceneVec3 = {
    x: c1x / len1,
    y: c1y / len1,
    z: c1z / len1,
  };

  // t2 = n × t1 (already unit length)
  const t2: SceneVec3 = {
    x: n.y * t1.z - n.z * t1.y,
    y: n.z * t1.x - n.x * t1.z,
    z: n.x * t1.y - n.y * t1.x,
  };

  return { t1, t2 };
}
