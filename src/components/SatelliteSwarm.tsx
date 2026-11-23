import { useEffect, useMemo, useRef, useState } from 'react';
import { useFrame, type ThreeEvent } from '@react-three/fiber';
import * as THREE from 'three';
import { SATELLITE_GROUPS } from '../data/celestrak';
import type { ConjunctionEvent } from '../physics/conjunctionTypes';
import {
  computeGmst,
  EARTH_RADIUS_KM,
  propagateToScenePosition,
  type SatelliteCategory,
  type SatelliteRecord,
  type SceneVec3,
} from '../physics/propagator';
import { isSatelliteSunlit } from '../physics/solar';

interface SatelliteSwarmProps {
  readonly satellites: readonly SatelliteRecord[];
  readonly selectedId: number | null;
  readonly activeConjunction: ConjunctionEvent | null;
  readonly simTimeRef: React.MutableRefObject<number>;
  readonly sunDirRef: React.MutableRefObject<SceneVec3>;
  readonly onSelect: (id: number) => void;
}

const MAX_INSTANCES = 24_000;
const DENSE_THRESHOLD = 500;
const STAGGER_THRESHOLD = 1_000;
const STAGGER_BATCH_SIZE = 1_800;

const COLOR_SELECTED = new THREE.Color('#fbbf24');
const COLOR_HOVERED = new THREE.Color('#ffffff');

interface CategoryColorPair {
  readonly sunlit: THREE.Color;
  readonly shadow: THREE.Color;
}

const DEFAULT_COLOR_PAIR: CategoryColorPair = {
  sunlit: new THREE.Color('#38bdf8'),
  shadow: new THREE.Color('#2c4f66'),
};

const CATEGORY_COLORS: Readonly<Record<SatelliteCategory, CategoryColorPair>> =
  SATELLITE_GROUPS.reduce<Record<SatelliteCategory, CategoryColorPair>>(
    (acc, group) => {
      acc[group.id] = {
        sunlit: new THREE.Color(group.colorHex),
        shadow: new THREE.Color(group.shadowColorHex),
      };
      return acc;
    },
    {
      stations: DEFAULT_COLOR_PAIR,
      visual: DEFAULT_COLOR_PAIR,
      starlink: DEFAULT_COLOR_PAIR,
      gnss: DEFAULT_COLOR_PAIR,
      weather: DEFAULT_COLOR_PAIR,
      active: DEFAULT_COLOR_PAIR,
      fallback: DEFAULT_COLOR_PAIR,
    },
  );

export function SatelliteSwarm({
  satellites,
  selectedId,
  activeConjunction,
  simTimeRef,
  sunDirRef,
  onSelect,
}: SatelliteSwarmProps) {
  const meshRef = useRef<THREE.InstancedMesh | null>(null);
  const hitMeshRef = useRef<THREE.InstancedMesh | null>(null);
  const reticleRef = useRef<THREE.Mesh | null>(null);
  const [hoveredId, setHoveredId] = useState<number | null>(null);

  const cursorRef = useRef(0);
  const fullSweepNeededRef = useRef(true);
  const lastSimTimeRef = useRef<number>(simTimeRef.current);
  const lastCamDistRef = useRef<number>(3.1);

  // Reusable scratch objects to keep per-frame GC allocations at zero
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const scratchColor = useMemo(() => new THREE.Color(), []);
  const scratchKm = useMemo(() => ({ x: 0, y: 0, z: 0 }), []);
  const orbitBoundingSphere = useMemo(
    () => new THREE.Sphere(new THREE.Vector3(0, 0, 0), 50),
    [],
  );

  // Pre-build index lookup for selected/hovered satellites so staggered updates keep them at 60 FPS
  const indexById = useMemo(() => {
    const map = new Map<number, number>();
    const count = Math.min(satellites.length, MAX_INSTANCES);
    for (let i = 0; i < count; i++) {
      map.set(satellites[i].id, i);
    }
    return map;
  }, [satellites]);

  // Trigger a full immediate sweep whenever the active satellite list or conjunction mode changes
  useEffect(() => {
    fullSweepNeededRef.current = true;
    cursorRef.current = 0;

    const activeCount = Math.min(satellites.length, MAX_INSTANCES);
    if (meshRef.current) {
      meshRef.current.count = activeCount;
      meshRef.current.boundingSphere = orbitBoundingSphere;
    }
    if (hitMeshRef.current) {
      hitMeshRef.current.count = activeCount;
      hitMeshRef.current.boundingSphere = orbitBoundingSphere;
    }
  }, [satellites, activeConjunction, orbitBoundingSphere]);

  useEffect(() => {
    return () => {
      document.body.style.cursor = 'auto';
    };
  }, []);

  useFrame(({ camera, clock }) => {
    const mesh = meshRef.current;
    const hitMesh = hitMeshRef.current;
    if (!mesh || !hitMesh) {
      return;
    }

    const activeCount = Math.min(satellites.length, MAX_INSTANCES);
    mesh.count = activeCount;
    hitMesh.count = activeCount;

    if (activeCount === 0) {
      if (reticleRef.current) {
        reticleRef.current.visible = false;
      }
      return;
    }

    const nowSimMs = simTimeRef.current;
    // Detect discrete time jumps or large zoom changes and force a full sweep
    const camLen = camera.position.length();
    if (
      Math.abs(nowSimMs - lastSimTimeRef.current) > 120_000 ||
      Math.abs(camLen - lastCamDistRef.current) > 0.35
    ) {
      fullSweepNeededRef.current = true;
    }
    lastSimTimeRef.current = nowSimMs;
    lastCamDistRef.current = camLen;

    const simDate = new Date(nowSimMs);
    const gmst = computeGmst(simDate);
    const sunDir = sunDirRef.current;
    const camX = camera.position.x;
    const camY = camera.position.y;
    const camZ = camera.position.z;

    const isDense = activeCount > DENSE_THRESHOLD;
    const baseMaxRadius = isDense ? 0.0075 : 0.015;
    const screenFactor = isDense ? 0.003 : 0.0052;
    const hitScreenFactor = isDense ? 0.0075 : 0.012;
    const hitMaxRadius = isDense ? 0.02 : 0.034;

    const conjunctionActive = activeConjunction !== null;
    const conjAId = activeConjunction?.satAId ?? -1;
    const conjBId = activeConjunction?.satBId ?? -1;
    const elapsedSec = clock.getElapsedTime();

    const updateInstance = (index: number): boolean => {
      const sat = satellites[index];
      const pos = propagateToScenePosition(sat.satrec, simDate, gmst);

      if (!pos) {
        dummy.position.set(0, 0, 0);
        dummy.scale.setScalar(0);
        dummy.updateMatrix();
        mesh.setMatrixAt(index, dummy.matrix);
        hitMesh.setMatrixAt(index, dummy.matrix);
        return false;
      }

      // When viewing a conjunction close-up, ConjunctionOverlay renders the two involved spacecraft
      if (conjunctionActive && (sat.id === conjAId || sat.id === conjBId)) {
        dummy.position.set(pos.x, pos.y, pos.z);
        dummy.scale.setScalar(0);
        dummy.updateMatrix();
        mesh.setMatrixAt(index, dummy.matrix);
        hitMesh.setMatrixAt(index, dummy.matrix);
        return false;
      }

      const isSelected = sat.id === selectedId;
      const isHovered = sat.id === hoveredId;

      const distToCam = Math.hypot(pos.x - camX, pos.y - camY, pos.z - camZ);
      const baseScreenRadius = THREE.MathUtils.clamp(
        distToCam * screenFactor,
        0.0005,
        baseMaxRadius,
      );

      scratchKm.x = pos.x * EARTH_RADIUS_KM;
      scratchKm.y = pos.y * EARTH_RADIUS_KM;
      scratchKm.z = pos.z * EARTH_RADIUS_KM;
      const sunlit = isSatelliteSunlit(scratchKm, sunDir);

      dummy.position.set(pos.x, pos.y, pos.z);

      if (isSelected && !conjunctionActive) {
        const selectedRadius = THREE.MathUtils.clamp(
          distToCam * 0.0085,
          0.0009,
          0.024,
        );
        dummy.scale.setScalar(selectedRadius);
        scratchColor.copy(COLOR_SELECTED);

        if (reticleRef.current) {
          reticleRef.current.position.set(pos.x, pos.y, pos.z);
          reticleRef.current.visible = true;
          const pulse = 1 + 0.22 * Math.sin(elapsedSec * 4.5);
          const reticleRadius = THREE.MathUtils.clamp(
            distToCam * 0.017,
            0.0022,
            0.045,
          );
          reticleRef.current.scale.setScalar(reticleRadius * pulse);
          reticleRef.current.lookAt(camera.position);
        }
      } else if (isHovered && !conjunctionActive) {
        const hoveredRadius = THREE.MathUtils.clamp(
          distToCam * 0.007,
          0.0008,
          0.02,
        );
        dummy.scale.setScalar(hoveredRadius);
        scratchColor.copy(COLOR_HOVERED);
      } else {
        const pair = CATEGORY_COLORS[sat.category] ?? DEFAULT_COLOR_PAIR;
        const categoryMult = sat.category === 'stations' ? 1.25 : 1.0;
        const lightMult = sunlit ? 1.0 : 0.85;
        const bgMult = conjunctionActive ? 0.2 : 1.0;

        dummy.scale.setScalar(
          Math.max(0.00025, baseScreenRadius * categoryMult * lightMult * bgMult),
        );
        scratchColor.copy(sunlit ? pair.sunlit : pair.shadow);
        if (conjunctionActive) {
          scratchColor.multiplyScalar(0.35);
        }
      }

      mesh.setColorAt(index, scratchColor);
      dummy.updateMatrix();
      mesh.setMatrixAt(index, dummy.matrix);

      const hitRadius = conjunctionActive
        ? 0
        : THREE.MathUtils.clamp(
            distToCam * hitScreenFactor,
            0.0015,
            hitMaxRadius,
          );
      dummy.scale.setScalar(hitRadius);
      dummy.updateMatrix();
      hitMesh.setMatrixAt(index, dummy.matrix);

      return isSelected && !conjunctionActive;
    };

    const doFullSweep =
      fullSweepNeededRef.current || activeCount <= STAGGER_THRESHOLD;

    let selectedUpdated = false;

    if (doFullSweep) {
      for (let i = 0; i < activeCount; i++) {
        if (updateInstance(i)) {
          selectedUpdated = true;
        }
      }
      fullSweepNeededRef.current = false;
    } else {
      // Staggered SGP4 propagation for > 1000 active satellites to preserve 60 FPS
      let cursor = cursorRef.current % activeCount;
      const batch = Math.min(STAGGER_BATCH_SIZE, activeCount);
      for (let step = 0; step < batch; step++) {
        if (updateInstance(cursor)) {
          selectedUpdated = true;
        }
        cursor = (cursor + 1) % activeCount;
      }
      cursorRef.current = cursor;

      // Always keep selected and hovered satellites updated at full 60 FPS
      if (selectedId !== null) {
        const selIdx = indexById.get(selectedId);
        if (selIdx !== undefined) {
          selectedUpdated = updateInstance(selIdx);
        }
      }
      if (hoveredId !== null && hoveredId !== selectedId) {
        const hovIdx = indexById.get(hoveredId);
        if (hovIdx !== undefined) {
          updateInstance(hovIdx);
        }
      }
    }

    mesh.instanceMatrix.needsUpdate = true;
    hitMesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) {
      mesh.instanceColor.needsUpdate = true;
    }

    if (!hitMesh.boundingSphere || hitMesh.boundingSphere.radius < 1) {
      hitMesh.boundingSphere = orbitBoundingSphere;
    }

    if (
      reticleRef.current &&
      (conjunctionActive || selectedId === null || !selectedUpdated)
    ) {
      reticleRef.current.visible = false;
    }
  });

  const handleClick = (event: ThreeEvent<MouseEvent>): void => {
    event.stopPropagation();
    if (event.instanceId === undefined) {
      return;
    }
    const sat = satellites[event.instanceId];
    if (sat) {
      onSelect(sat.id);
    }
  };

  const handlePointerMove = (event: ThreeEvent<PointerEvent>): void => {
    event.stopPropagation();
    if (event.instanceId === undefined) {
      return;
    }
    const sat = satellites[event.instanceId];
    if (sat) {
      document.body.style.cursor = 'pointer';
      if (sat.id !== hoveredId) {
        setHoveredId(sat.id);
      }
    }
  };

  const handlePointerOut = (): void => {
    setHoveredId(null);
    document.body.style.cursor = 'auto';
  };

  return (
    <group>
      {/* Pre-allocated unit-sphere visual satellite dots (screen-space scaled per frame) */}
      <instancedMesh
        ref={meshRef}
        args={[undefined, undefined, MAX_INSTANCES]}
        frustumCulled={false}
      >
        <sphereGeometry args={[1, 8, 8]} />
        <meshBasicMaterial toneMapped={false} />
      </instancedMesh>

      {/* Pre-allocated unit-sphere invisible hit targets */}
      <instancedMesh
        ref={hitMeshRef}
        args={[undefined, undefined, MAX_INSTANCES]}
        frustumCulled={false}
        onClick={handleClick}
        onPointerMove={handlePointerMove}
        onPointerOut={handlePointerOut}
      >
        <sphereGeometry args={[1, 6, 6]} />
        <meshBasicMaterial
          transparent
          opacity={0}
          depthWrite={false}
          colorWrite={false}
        />
      </instancedMesh>

      {/* Screen-space scaled pulsing highlight ring around the selected satellite */}
      <mesh ref={reticleRef} visible={false}>
        <ringGeometry args={[0.74, 1.0, 32]} />
        <meshBasicMaterial
          color="#fbbf24"
          side={THREE.DoubleSide}
          transparent
          opacity={0.9}
          toneMapped={false}
        />
      </mesh>
    </group>
  );
}
