import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import {
  computeGmst,
  EARTH_RADIUS_KM,
  propagateToScenePosition,
  type SatelliteRecord,
} from '../physics/propagator';
import {
  computeHorizonAngleRad,
  computeTangentBasis,
} from '../physics/solar';

interface SatelliteFootprintProps {
  readonly satellite: SatelliteRecord | null;
  readonly simTimeRef: React.MutableRefObject<number>;
}

const ANGULAR_SEGMENTS = 72;
const RADIAL_RINGS = 8;
const FOOTPRINT_OUTLINE_RADIUS = 1.0055;
const FOOTPRINT_FILL_RADIUS = 1.005;
const SURFACE_MARKER_RADIUS = 1.006;

export function SatelliteFootprint({
  satellite,
  simTimeRef,
}: SatelliteFootprintProps) {
  const groupRef = useRef<THREE.Group | null>(null);
  const markerRef = useRef<THREE.Mesh | null>(null);

  // Precompute unit circle cosines/sines once
  const circleTrig = useMemo(() => {
    const cosPhi = new Float32Array(ANGULAR_SEGMENTS + 1);
    const sinPhi = new Float32Array(ANGULAR_SEGMENTS + 1);
    for (let i = 0; i <= ANGULAR_SEGMENTS; i++) {
      const phi = (i / ANGULAR_SEGMENTS) * Math.PI * 2;
      cosPhi[i] = Math.cos(phi);
      sinPhi[i] = Math.sin(phi);
    }
    return { cosPhi, sinPhi };
  }, []);

  // Nadir dashed line (2 vertices: satellite -> sub-satellite point)
  const nadirLine = useMemo(() => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array(6), 3),
    );
    const material = new THREE.LineDashedMaterial({
      color: '#38bdf8',
      dashSize: 0.018,
      gapSize: 0.012,
      transparent: true,
      opacity: 0.85,
      toneMapped: false,
    });
    const line = new THREE.Line(geometry, material);
    line.frustumCulled = false;
    return line;
  }, []);

  // Footprint outline loop on curved Earth surface
  const outlineLine = useMemo(() => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(
        new Float32Array((ANGULAR_SEGMENTS + 1) * 3),
        3,
      ),
    );
    const material = new THREE.LineBasicMaterial({
      color: '#38bdf8',
      transparent: true,
      opacity: 0.78,
      toneMapped: false,
    });
    const line = new THREE.Line(geometry, material);
    line.frustumCulled = false;
    return line;
  }, []);

  // Curved spherical-cap fill geometry (1 center + RADIAL_RINGS * ANGULAR_SEGMENTS vertices)
  const fillGeometry = useMemo(() => {
    const vertexCount = 1 + RADIAL_RINGS * ANGULAR_SEGMENTS;
    const positions = new Float32Array(vertexCount * 3);
    const indices: number[] = [];

    // Center fan (ring 0)
    for (let j = 0; j < ANGULAR_SEGMENTS; j++) {
      const nextJ = (j + 1) % ANGULAR_SEGMENTS;
      indices.push(0, 1 + j, 1 + nextJ);
    }

    // Concentric spherical-cap bands
    for (let r = 0; r < RADIAL_RINGS - 1; r++) {
      const ringStart = 1 + r * ANGULAR_SEGMENTS;
      const nextRingStart = 1 + (r + 1) * ANGULAR_SEGMENTS;
      for (let j = 0; j < ANGULAR_SEGMENTS; j++) {
        const nextJ = (j + 1) % ANGULAR_SEGMENTS;
        const a = ringStart + j;
        const b = nextRingStart + j;
        const c = nextRingStart + nextJ;
        const d = ringStart + nextJ;
        indices.push(a, b, c);
        indices.push(a, c, d);
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    return geometry;
  }, []);

  useEffect(() => {
    return () => {
      nadirLine.geometry.dispose();
      (nadirLine.material as THREE.Material).dispose();
      outlineLine.geometry.dispose();
      (outlineLine.material as THREE.Material).dispose();
      fillGeometry.dispose();
    };
  }, [nadirLine, outlineLine, fillGeometry]);

  useFrame(() => {
    const group = groupRef.current;
    if (!group) {
      return;
    }

    if (!satellite) {
      group.visible = false;
      return;
    }

    const simDate = new Date(simTimeRef.current);
    const gmst = computeGmst(simDate);
    const pos = propagateToScenePosition(satellite.satrec, simDate, gmst);

    if (!pos) {
      group.visible = false;
      return;
    }

    const rScene = Math.hypot(pos.x, pos.y, pos.z);
    if (rScene <= 1.0) {
      group.visible = false;
      return;
    }

    group.visible = true;

    // Sub-satellite unit surface normal
    const n = {
      x: pos.x / rScene,
      y: pos.y / rScene,
      z: pos.z / rScene,
    };

    const altitudeKm = Math.max(0, (rScene - 1) * EARTH_RADIUS_KM);
    const horizonTheta = computeHorizonAngleRad(altitudeKm);
    const { t1, t2 } = computeTangentBasis(n);

    // 1. Update nadir line (satellite -> surface point)
    const nadirAttr = nadirLine.geometry.getAttribute(
      'position',
    ) as THREE.BufferAttribute;
    nadirAttr.setXYZ(0, pos.x, pos.y, pos.z);
    nadirAttr.setXYZ(
      1,
      n.x * FOOTPRINT_OUTLINE_RADIUS,
      n.y * FOOTPRINT_OUTLINE_RADIUS,
      n.z * FOOTPRINT_OUTLINE_RADIUS,
    );
    nadirAttr.needsUpdate = true;
    nadirLine.computeLineDistances();

    // 2. Update sub-satellite marker dot
    if (markerRef.current) {
      markerRef.current.position.set(
        n.x * SURFACE_MARKER_RADIUS,
        n.y * SURFACE_MARKER_RADIUS,
        n.z * SURFACE_MARKER_RADIUS,
      );
    }

    // 3. Update curved horizon footprint outline at radius = 1.0055
    const outlineAttr = outlineLine.geometry.getAttribute(
      'position',
    ) as THREE.BufferAttribute;
    const cosTheta = Math.cos(horizonTheta);
    const sinTheta = Math.sin(horizonTheta);
    const { cosPhi, sinPhi } = circleTrig;

    for (let i = 0; i <= ANGULAR_SEGMENTS; i++) {
      const c = cosPhi[i];
      const s = sinPhi[i];
      const vx =
        FOOTPRINT_OUTLINE_RADIUS *
        (cosTheta * n.x + sinTheta * (c * t1.x + s * t2.x));
      const vy =
        FOOTPRINT_OUTLINE_RADIUS *
        (cosTheta * n.y + sinTheta * (c * t1.y + s * t2.y));
      const vz =
        FOOTPRINT_OUTLINE_RADIUS *
        (cosTheta * n.z + sinTheta * (c * t1.z + s * t2.z));
      outlineAttr.setXYZ(i, vx, vy, vz);
    }
    outlineAttr.needsUpdate = true;

    // 4. Update curved spherical-cap fill at radius = 1.005
    const fillAttr = fillGeometry.getAttribute(
      'position',
    ) as THREE.BufferAttribute;
    fillAttr.setXYZ(
      0,
      n.x * FOOTPRINT_FILL_RADIUS,
      n.y * FOOTPRINT_FILL_RADIUS,
      n.z * FOOTPRINT_FILL_RADIUS,
    );

    for (let r = 1; r <= RADIAL_RINGS; r++) {
      const alpha = (r / RADIAL_RINGS) * horizonTheta;
      const cosA = Math.cos(alpha);
      const sinA = Math.sin(alpha);
      const baseIdx = 1 + (r - 1) * ANGULAR_SEGMENTS;

      for (let j = 0; j < ANGULAR_SEGMENTS; j++) {
        const c = cosPhi[j];
        const s = sinPhi[j];
        const vx =
          FOOTPRINT_FILL_RADIUS * (cosA * n.x + sinA * (c * t1.x + s * t2.x));
        const vy =
          FOOTPRINT_FILL_RADIUS * (cosA * n.y + sinA * (c * t1.y + s * t2.y));
        const vz =
          FOOTPRINT_FILL_RADIUS * (cosA * n.z + sinA * (c * t1.z + s * t2.z));
        fillAttr.setXYZ(baseIdx + j, vx, vy, vz);
      }
    }
    fillAttr.needsUpdate = true;
  });

  if (!satellite) {
    return null;
  }

  return (
    <group ref={groupRef} visible={false}>
      {/* Dashed nadir line from satellite down to sub-satellite point */}
      <primitive object={nadirLine} />

      {/* Sub-satellite surface marker dot */}
      <mesh ref={markerRef}>
        <sphereGeometry args={[0.0085, 12, 12]} />
        <meshBasicMaterial color="#fbbf24" toneMapped={false} />
      </mesh>

      {/* Curved horizon visibility footprint outline */}
      <primitive object={outlineLine} />

      {/* Low-opacity curved spherical-cap fill hugging Earth's surface */}
      <mesh geometry={fillGeometry} frustumCulled={false}>
        <meshBasicMaterial
          color="#38bdf8"
          transparent
          opacity={0.11}
          depthWrite={false}
          polygonOffset={true}
          polygonOffsetFactor={-1}
          polygonOffsetUnits={-1}
          side={THREE.DoubleSide}
          toneMapped={false}
        />
      </mesh>
    </group>
  );
}
