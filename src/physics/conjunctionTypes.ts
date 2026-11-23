import type { SatRec } from 'satellite.js';

export type ConjunctionThresholdKm = 25 | 50;

export interface ConjunctionSatelliteInput {
  readonly id: number;
  readonly name: string;
  readonly satrec: SatRec;
}

export interface EciPositionKm {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface ConjunctionEvent {
  readonly id: string;
  readonly satAId: number;
  readonly satAName: string;
  readonly satBId: number;
  readonly satBName: string;
  readonly tcaTimeMs: number;
  readonly minDistanceKm: number;
  readonly relativeVelocityKmS: number;
  readonly midpointEci: EciPositionKm;
}

export interface ConjunctionWorkerRequest {
  readonly satellites: readonly ConjunctionSatelliteInput[];
  readonly startTimeMs: number;
  readonly durationMinutes: number;
  readonly thresholdKm: ConjunctionThresholdKm;
}

export type ConjunctionWorkerResponse =
  | {
      readonly type: 'progress';
      readonly percent: number;
    }
  | {
      readonly type: 'result';
      readonly events: ConjunctionEvent[];
      readonly scannedCount: number;
      readonly elapsedMs: number;
    };
