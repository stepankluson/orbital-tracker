import {
  degreesToRadians,
  ecfToLookAngles,
  eciToEcf,
  gstime,
  propagate,
  radiansToDegrees,
  type GeodeticLocation,
  type SatRec,
} from 'satellite.js';
import type { SceneVec3 } from './propagator';
import { getSunDirectionEcf, isSatelliteSunlit } from './solar';

export interface ObserverLocation {
  readonly name: string;
  readonly lat: number;
  readonly lon: number;
  readonly altKm: number;
}

export interface ObserverLookAngles {
  readonly elevationDeg: number;
  readonly azimuthDeg: number;
  readonly rangeKm: number;
  readonly isAboveHorizon: boolean;
}

export type PassVisibility = 'VISIBLE' | 'DAYLIGHT' | 'ECLIPSED';

export interface SatellitePass {
  readonly aosTime: Date;
  readonly maxElTime: Date;
  readonly losTime: Date;
  readonly maxElevationDeg: number;
  readonly aosAzimuthDeg: number;
  readonly losAzimuthDeg: number;
  readonly visibility: PassVisibility;
}

export interface SkyTrackPoint {
  readonly elevationDeg: number;
  readonly azimuthDeg: number;
  readonly timeMs: number;
}

const COARSE_STEP_MS = 30_000; // 30 seconds
const FINE_STEP_MS = 5_000; // 5 seconds
const MIN_PASS_ELEVATION_DEG = 10;
const CIVIL_TWILIGHT_DEG = -6;
const MAX_SINGLE_PASS_DURATION_MS = 4 * 60 * 60 * 1000; // Guard against GEO / non-setting orbits

function toGeodeticObserver(observer: ObserverLocation): GeodeticLocation {
  return {
    latitude: degreesToRadians(observer.lat),
    longitude: degreesToRadians(observer.lon),
    height: observer.altKm,
  };
}

/**
 * Converts observer geographic latitude/longitude (degrees) to a 3D unit-sphere
 * position in the ECF-aligned Three.js scene frame.
 */
export function observerToScenePosition(
  latDeg: number,
  lonDeg: number,
  radius = 1.0,
): SceneVec3 {
  const latRad = degreesToRadians(latDeg);
  const lonRad = degreesToRadians(lonDeg);
  const cosLat = Math.cos(latRad);

  return {
    x: radius * cosLat * Math.cos(lonRad),
    y: radius * Math.sin(latRad),
    z: -radius * cosLat * Math.sin(lonRad),
  };
}

/**
 * Computes the local Sun elevation angle (degrees) above the observer's geometric horizon.
 * Values < -6° correspond to civil twilight / nighttime darkness.
 */
export function computeObserverSunElevationDeg(
  observer: ObserverLocation,
  date: Date,
): number {
  const latRad = degreesToRadians(observer.lat);
  const lonRad = degreesToRadians(observer.lon);
  const cosLat = Math.cos(latRad);

  // Observer outward surface normal in ECF
  const nx = cosLat * Math.cos(lonRad);
  const ny = cosLat * Math.sin(lonRad);
  const nz = Math.sin(latRad);

  const sunEcf = getSunDirectionEcf(date);
  const dot = Math.max(-1, Math.min(1, nx * sunEcf.x + ny * sunEcf.y + nz * sunEcf.z));
  return radiansToDegrees(Math.asin(dot));
}

function normalizeAzimuthDeg(rad: number): number {
  const deg = radiansToDegrees(rad) % 360;
  return deg < 0 ? deg + 360 : deg;
}

/**
 * Computes real-time look angles (elevation, azimuth, slant range) from a ground observer
 * to a satellite at `date`.
 */
export function computeLookAngles(
  satrec: SatRec,
  observer: ObserverLocation,
  date: Date,
): ObserverLookAngles | null {
  const result = propagate(satrec, date);
  if (
    !result ||
    !result.position ||
    !Number.isFinite(result.position.x) ||
    !Number.isFinite(result.position.y) ||
    !Number.isFinite(result.position.z)
  ) {
    return null;
  }

  const gmst = gstime(date);
  const satEcf = eciToEcf(result.position, gmst);
  const look = ecfToLookAngles(toGeodeticObserver(observer), satEcf);

  if (
    !Number.isFinite(look.elevation) ||
    !Number.isFinite(look.azimuth) ||
    !Number.isFinite(look.rangeSat)
  ) {
    return null;
  }

  const elevationDeg = radiansToDegrees(look.elevation);
  return {
    elevationDeg,
    azimuthDeg: normalizeAzimuthDeg(look.azimuth),
    rangeKm: look.rangeSat,
    isAboveHorizon: elevationDeg > 0,
  };
}

function sampleElevationAndAzimuth(
  satrec: SatRec,
  observerGd: GeodeticLocation,
  timeMs: number,
): { elevationDeg: number; azimuthDeg: number } | null {
  const date = new Date(timeMs);
  const result = propagate(satrec, date);
  if (
    !result ||
    !result.position ||
    !Number.isFinite(result.position.x) ||
    !Number.isFinite(result.position.y) ||
    !Number.isFinite(result.position.z)
  ) {
    return null;
  }

  const gmst = gstime(date);
  const satEcf = eciToEcf(result.position, gmst);
  const look = ecfToLookAngles(observerGd, satEcf);
  if (!Number.isFinite(look.elevation) || !Number.isFinite(look.azimuth)) {
    return null;
  }

  return {
    elevationDeg: radiansToDegrees(look.elevation),
    azimuthDeg: normalizeAzimuthDeg(look.azimuth),
  };
}

function classifyPassVisibility(
  satrec: SatRec,
  observer: ObserverLocation,
  maxElDate: Date,
): PassVisibility {
  const sunElDeg = computeObserverSunElevationDeg(observer, maxElDate);
  if (sunElDeg >= CIVIL_TWILIGHT_DEG) {
    return 'DAYLIGHT';
  }

  const result = propagate(satrec, maxElDate);
  if (!result || !result.position) {
    return 'ECLIPSED';
  }

  const gmst = gstime(maxElDate);
  const satEcf = eciToEcf(result.position, gmst);
  const sunEcf = getSunDirectionEcf(maxElDate);

  return isSatelliteSunlit(satEcf, sunEcf) ? 'VISIBLE' : 'ECLIPSED';
}

/**
 * Predicts upcoming satellite passes above 10° elevation for a ground observer.
 *
 * Scans forward in 30-second steps up to `hoursAhead` (default 48h), then refines
 * AOS (rise above 10°), TCA (max elevation), and LOS (set below 10°) to 5-second precision.
 * Returns up to `maxPasses` (default 5) passes with visual visibility classification.
 */
export function predictPasses(
  satrec: SatRec,
  observer: ObserverLocation,
  startDate: Date,
  hoursAhead = 48,
  maxPasses = 5,
): SatellitePass[] {
  const passes: SatellitePass[] = [];
  const observerGd = toGeodeticObserver(observer);
  const startMs = startDate.getTime();
  const endMs = startMs + hoursAhead * 60 * 60 * 1000;

  let inPass = false;
  let coarseAosMs = startMs;
  let coarseMaxMs = startMs;
  let coarseMaxEl = -90;

  for (let t = startMs; t <= endMs; t += COARSE_STEP_MS) {
    const sample = sampleElevationAndAzimuth(satrec, observerGd, t);
    if (!sample) {
      if (inPass) {
        inPass = false;
      }
      continue;
    }

    if (!inPass) {
      if (sample.elevationDeg >= MIN_PASS_ELEVATION_DEG) {
        inPass = true;
        coarseAosMs = t;
        coarseMaxMs = t;
        coarseMaxEl = sample.elevationDeg;
      }
    } else {
      if (sample.elevationDeg > coarseMaxEl) {
        coarseMaxEl = sample.elevationDeg;
        coarseMaxMs = t;
      }

      // Guard against geostationary / non-setting satellites
      if (t - coarseAosMs > MAX_SINGLE_PASS_DURATION_MS) {
        break;
      }

      if (sample.elevationDeg < MIN_PASS_ELEVATION_DEG) {
        // Refine AOS in [coarseAosMs - 30s, coarseAosMs] at 5s precision
        let refinedAosMs = coarseAosMs;
        let aosAzimuthDeg = sample.azimuthDeg;
        const aosSearchStart = Math.max(startMs, coarseAosMs - COARSE_STEP_MS);
        for (let ft = aosSearchStart; ft <= coarseAosMs; ft += FINE_STEP_MS) {
          const fs = sampleElevationAndAzimuth(satrec, observerGd, ft);
          if (fs && fs.elevationDeg >= MIN_PASS_ELEVATION_DEG) {
            refinedAosMs = ft;
            aosAzimuthDeg = fs.azimuthDeg;
            break;
          }
        }

        // Refine TCA (max elevation) in [coarseMaxMs - 30s, coarseMaxMs + 30s] at 5s precision
        let refinedMaxMs = coarseMaxMs;
        let refinedMaxEl = coarseMaxEl;
        const maxSearchStart = Math.max(startMs, coarseMaxMs - COARSE_STEP_MS);
        const maxSearchEnd = Math.min(endMs, coarseMaxMs + COARSE_STEP_MS);
        for (let ft = maxSearchStart; ft <= maxSearchEnd; ft += FINE_STEP_MS) {
          const fs = sampleElevationAndAzimuth(satrec, observerGd, ft);
          if (fs && fs.elevationDeg > refinedMaxEl) {
            refinedMaxEl = fs.elevationDeg;
            refinedMaxMs = ft;
          }
        }

        // Refine LOS in [t - 30s, t] at 5s precision
        let refinedLosMs = t;
        let losAzimuthDeg = sample.azimuthDeg;
        const losSearchStart = Math.max(refinedAosMs, t - COARSE_STEP_MS);
        for (let ft = losSearchStart; ft <= t; ft += FINE_STEP_MS) {
          const fs = sampleElevationAndAzimuth(satrec, observerGd, ft);
          if (fs) {
            refinedLosMs = ft;
            losAzimuthDeg = fs.azimuthDeg;
            if (fs.elevationDeg < MIN_PASS_ELEVATION_DEG) {
              break;
            }
          }
        }

        const maxElDate = new Date(refinedMaxMs);
        const visibility = classifyPassVisibility(satrec, observer, maxElDate);

        passes.push({
          aosTime: new Date(refinedAosMs),
          maxElTime: maxElDate,
          losTime: new Date(refinedLosMs),
          maxElevationDeg: refinedMaxEl,
          aosAzimuthDeg,
          losAzimuthDeg,
          visibility,
        });

        inPass = false;
        coarseMaxEl = -90;

        if (passes.length >= maxPasses) {
          break;
        }
      }
    }
  }

  return passes;
}

/**
 * Samples the sky-dome trajectory (elevation & azimuth) of an upcoming pass
 * from horizon rise through peak elevation to horizon set for plotting on a polar sky radar.
 */
export function samplePassSkyTrack(
  satrec: SatRec,
  observer: ObserverLocation,
  pass: SatellitePass,
  samples = 48,
): {
  readonly points: SkyTrackPoint[];
  readonly peak: SkyTrackPoint | null;
} {
  const observerGd = toGeodeticObserver(observer);
  // Pad ±2.5 minutes around the 10° AOS/LOS window to capture the full 0° horizon arc
  const padMs = 150_000;
  const startMs = pass.aosTime.getTime() - padMs;
  const endMs = pass.losTime.getTime() + padMs;
  const spanMs = Math.max(1, endMs - startMs);

  const points: SkyTrackPoint[] = [];
  let peak: SkyTrackPoint | null = null;

  for (let i = 0; i <= samples; i++) {
    const timeMs = startMs + (i / samples) * spanMs;
    const sample = sampleElevationAndAzimuth(satrec, observerGd, timeMs);
    if (sample && sample.elevationDeg >= 0) {
      const pt: SkyTrackPoint = {
        elevationDeg: sample.elevationDeg,
        azimuthDeg: sample.azimuthDeg,
        timeMs,
      };
      points.push(pt);
      if (!peak || pt.elevationDeg > peak.elevationDeg) {
        peak = pt;
      }
    }
  }

  return { points, peak };
}
