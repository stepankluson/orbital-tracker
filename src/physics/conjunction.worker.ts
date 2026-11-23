/// <reference lib="webworker" />
import { propagate } from 'satellite.js';
import type {
  ConjunctionEvent,
  ConjunctionSatelliteInput,
  ConjunctionWorkerRequest,
  ConjunctionWorkerResponse,
} from './conjunctionTypes';

const COARSE_STEP_MS = 30_000; // 30 seconds
const FINE_STEP_MS = 1_000; // 1 second
const CELL_SIZE_KM = 100;
const INV_CELL_SIZE = 1 / CELL_SIZE_KM;
const CELL_OFFSET = 2048;
const CELL_STRIDE_Y = 4096;
const CELL_STRIDE_X = 4096 * 4096;
const MAX_RESULTS = 10;
const MIN_RELATIVE_VELOCITY_KMS = 0.1;

/**
 * 13 forward half-neighbor offsets in 3D grid space so every pair of adjacent
 * cells in the 26-neighborhood is compared exactly once.
 */
const HALF_NEIGHBOR_OFFSETS: readonly (readonly [number, number, number])[] = [
  [1, -1, -1],
  [1, -1, 0],
  [1, -1, 1],
  [1, 0, -1],
  [1, 0, 0],
  [1, 0, 1],
  [1, 1, -1],
  [1, 1, 0],
  [1, 1, 1],
  [0, 1, -1],
  [0, 1, 0],
  [0, 1, 1],
  [0, 0, 1],
];

function packCellKey(cx: number, cy: number, cz: number): number {
  return (
    (cx + CELL_OFFSET) * CELL_STRIDE_X +
    (cy + CELL_OFFSET) * CELL_STRIDE_Y +
    (cz + CELL_OFFSET)
  );
}

function makePairKey(idA: number, idB: number): string {
  return idA < idB ? `${idA}-${idB}` : `${idB}-${idA}`;
}

function refineConjunction(
  satA: ConjunctionSatelliteInput,
  satB: ConjunctionSatelliteInput,
  centerMs: number,
  windowStartMs: number,
  windowEndMs: number,
  thresholdKm: number,
): ConjunctionEvent | null {
  const startMs = Math.max(windowStartMs, centerMs - COARSE_STEP_MS);
  const endMs = Math.min(windowEndMs, centerMs + COARSE_STEP_MS);

  let bestDistSq = Infinity;
  let bestTimeMs = centerMs;
  let bestRelVel = 0;
  let bestMidX = 0;
  let bestMidY = 0;
  let bestMidZ = 0;

  for (let t = startMs; t <= endMs; t += FINE_STEP_MS) {
    const date = new Date(t);
    const resA = propagate(satA.satrec, date);
    if (!resA || !resA.position || !resA.velocity) {
      continue;
    }
    const resB = propagate(satB.satrec, date);
    if (!resB || !resB.position || !resB.velocity) {
      continue;
    }

    const dx = resA.position.x - resB.position.x;
    const dy = resA.position.y - resB.position.y;
    const dz = resA.position.z - resB.position.z;
    const distSq = dx * dx + dy * dy + dz * dz;

    if (Number.isFinite(distSq) && distSq < bestDistSq) {
      bestDistSq = distSq;
      bestTimeMs = t;
      const dvx = resA.velocity.x - resB.velocity.x;
      const dvy = resA.velocity.y - resB.velocity.y;
      const dvz = resA.velocity.z - resB.velocity.z;
      bestRelVel = Math.hypot(dvx, dvy, dvz);
      bestMidX = 0.5 * (resA.position.x + resB.position.x);
      bestMidY = 0.5 * (resA.position.y + resB.position.y);
      bestMidZ = 0.5 * (resA.position.z + resB.position.z);
    }
  }

  const minDistanceKm = Math.sqrt(bestDistSq);
  if (
    !Number.isFinite(minDistanceKm) ||
    minDistanceKm > thresholdKm ||
    !Number.isFinite(bestRelVel) ||
    bestRelVel < MIN_RELATIVE_VELOCITY_KMS
  ) {
    return null;
  }

  const orderedA = satA.id <= satB.id ? satA : satB;
  const orderedB = satA.id <= satB.id ? satB : satA;

  return {
    id: makePairKey(orderedA.id, orderedB.id),
    satAId: orderedA.id,
    satAName: orderedA.name,
    satBId: orderedB.id,
    satBName: orderedB.name,
    tcaTimeMs: bestTimeMs,
    minDistanceKm,
    relativeVelocityKmS: bestRelVel,
    midpointEci: {
      x: bestMidX,
      y: bestMidY,
      z: bestMidZ,
    },
  };
}

function runConjunctionScan(request: ConjunctionWorkerRequest): void {
  const perfStart = performance.now();
  const { satellites, startTimeMs, durationMinutes, thresholdKm } = request;
  const count = satellites.length;

  if (count < 2) {
    const emptyMsg: ConjunctionWorkerResponse = {
      type: 'result',
      events: [],
      scannedCount: count,
      elapsedMs: 0,
    };
    self.postMessage(emptyMsg);
    return;
  }

  const endTimeMs = startTimeMs + durationMinutes * 60 * 1000;
  const totalSteps = Math.floor((endTimeMs - startTimeMs) / COARSE_STEP_MS) + 1;

  // Coarse candidate distance accounts for relative motion during a 30s step
  const coarseThresholdKm = Math.max(thresholdKm * 2.5, 100);
  const coarseThresholdSq = coarseThresholdKm * coarseThresholdKm;

  const px = new Float64Array(count);
  const py = new Float64Array(count);
  const pz = new Float64Array(count);

  const bestByPair = new Map<string, ConjunctionEvent>();
  let lastReportedPercent = -1;

  for (let step = 0; step < totalSteps; step++) {
    const stepTimeMs = startTimeMs + step * COARSE_STEP_MS;
    const stepDate = new Date(stepTimeMs);

    const grid = new Map<number, number[]>();
    const cellCoords = new Map<number, readonly [number, number, number]>();

    // 1. Propagate all active satellites into ECI km and insert into 100km spatial hash grid
    for (let i = 0; i < count; i++) {
      const res = propagate(satellites[i].satrec, stepDate);
      if (
        !res ||
        !res.position ||
        !Number.isFinite(res.position.x) ||
        !Number.isFinite(res.position.y) ||
        !Number.isFinite(res.position.z)
      ) {
        continue;
      }

      const x = res.position.x;
      const y = res.position.y;
      const z = res.position.z;

      px[i] = x;
      py[i] = y;
      pz[i] = z;

      const cx = Math.floor(x * INV_CELL_SIZE);
      const cy = Math.floor(y * INV_CELL_SIZE);
      const cz = Math.floor(z * INV_CELL_SIZE);

      // Guard against extreme / corrupted deep-space coordinates outside grid bounds
      if (
        cx <= -CELL_OFFSET + 1 ||
        cx >= CELL_OFFSET - 1 ||
        cy <= -CELL_OFFSET + 1 ||
        cy >= CELL_OFFSET - 1 ||
        cz <= -CELL_OFFSET + 1 ||
        cz >= CELL_OFFSET - 1
      ) {
        continue;
      }

      const key = packCellKey(cx, cy, cz);
      let bucket = grid.get(key);
      if (!bucket) {
        bucket = [];
        grid.set(key, bucket);
        cellCoords.set(key, [cx, cy, cz]);
      }
      bucket.push(i);
    }

    // 2. Compare satellites within the same cell and adjacent 26-neighborhood cells
    const evaluatePair = (idxA: number, idxB: number): void => {
      const dx = px[idxA] - px[idxB];
      const dy = py[idxA] - py[idxB];
      const dz = pz[idxA] - pz[idxB];
      const distSq = dx * dx + dy * dy + dz * dz;

      if (distSq > coarseThresholdSq) {
        return;
      }

      const refined = refineConjunction(
        satellites[idxA],
        satellites[idxB],
        stepTimeMs,
        startTimeMs,
        endTimeMs,
        thresholdKm,
      );
      if (!refined) {
        return;
      }

      const existing = bestByPair.get(refined.id);
      if (!existing || refined.minDistanceKm < existing.minDistanceKm) {
        bestByPair.set(refined.id, refined);
      }
    };

    for (const [key, bucket] of grid) {
      const len = bucket.length;

      // Same-cell pairs
      for (let a = 0; a < len; a++) {
        const idxA = bucket[a];
        for (let b = a + 1; b < len; b++) {
          evaluatePair(idxA, bucket[b]);
        }
      }

      // 13 forward half-neighbor cells (covers all 26 neighbors without duplicate checks)
      const coords = cellCoords.get(key);
      if (!coords) {
        continue;
      }
      const [cx, cy, cz] = coords;

      for (let n = 0; n < HALF_NEIGHBOR_OFFSETS.length; n++) {
        const [ox, oy, oz] = HALF_NEIGHBOR_OFFSETS[n];
        const neighborBucket = grid.get(packCellKey(cx + ox, cy + oy, cz + oz));
        if (!neighborBucket) {
          continue;
        }
        const nLen = neighborBucket.length;
        for (let a = 0; a < len; a++) {
          const idxA = bucket[a];
          for (let b = 0; b < nLen; b++) {
            evaluatePair(idxA, neighborBucket[b]);
          }
        }
      }
    }

    const percent = Math.round(((step + 1) / totalSteps) * 100);
    if (percent !== lastReportedPercent && (step % 3 === 0 || step === totalSteps - 1)) {
      lastReportedPercent = percent;
      const progressMsg: ConjunctionWorkerResponse = {
        type: 'progress',
        percent,
      };
      self.postMessage(progressMsg);
    }
  }

  const topEvents = Array.from(bestByPair.values())
    .sort((a, b) => a.minDistanceKm - b.minDistanceKm)
    .slice(0, MAX_RESULTS);

  const resultMsg: ConjunctionWorkerResponse = {
    type: 'result',
    events: topEvents,
    scannedCount: count,
    elapsedMs: Math.round(performance.now() - perfStart),
  };
  self.postMessage(resultMsg);
}

self.onmessage = (event: MessageEvent<ConjunctionWorkerRequest>): void => {
  runConjunctionScan(event.data);
};
