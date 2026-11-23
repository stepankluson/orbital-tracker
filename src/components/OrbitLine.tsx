import { useMemo } from 'react';
import { Line } from '@react-three/drei';
import {
  sampleOrbitPath,
  type SatelliteRecord,
} from '../physics/propagator';

interface OrbitLineProps {
  readonly satellite: SatelliteRecord | null;
  /** Quantized simulation timestamp (ms) so the orbit ring stays aligned without per-frame rebuilds. */
  readonly referenceTimeMs: number;
}

export function OrbitLine({ satellite, referenceTimeMs }: OrbitLineProps) {
  const points = useMemo<[number, number, number][]>(() => {
    if (!satellite) {
      return [];
    }
    const sampled = sampleOrbitPath(satellite, new Date(referenceTimeMs), 180);
    return sampled.map((pt) => [pt.x, pt.y, pt.z]);
  }, [satellite, referenceTimeMs]);

  if (!satellite || points.length < 2) {
    return null;
  }

  return (
    <Line
      points={points}
      color="#fbbf24"
      lineWidth={1.6}
      transparent
      opacity={0.75}
    />
  );
}
