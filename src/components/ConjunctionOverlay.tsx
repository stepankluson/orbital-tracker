import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Line } from '@react-three/drei';
import * as THREE from 'three';
import type { ConjunctionEvent } from '../physics/conjunctionTypes';
import {
  computeGmst,
  EARTH_RADIUS_KM,
  eciKmToScene,
  propagateToScenePosition,
  sampleOrbitPath,
  type SatelliteRecord,
} from '../physics/propagator';

interface ConjunctionOverlayProps {
  readonly event: ConjunctionEvent | null;
  readonly satA: SatelliteRecord | null;
  readonly satB: SatelliteRecord | null;
  readonly simTimeRef: React.MutableRefObject<number>;
  readonly orbitRefTimeMs: number;
}

const LIVE_CONNECT_MAX_KM = 500;

export function ConjunctionOverlay({
  event,
  satA,
  satB,
  simTimeRef,
  orbitRefTimeMs,
}: ConjunctionOverlayProps) {
  const tcaCoreRef = useRef<THREE.Mesh | null>(null);
  const outerRingRef = useRef<THREE.Mesh | null>(null);
  const innerRingRef = useRef<THREE.Mesh | null>(null);
  const satAMarkerRef = useRef<THREE.Mesh | null>(null);
  const satBMarkerRef = useRef<THREE.Mesh | null>(null);

  const orbitAPoints = useMemo<[number, number, number][]>(() => {
    if (!satA || !event) {
      return [];
    }
    return sampleOrbitPath(satA, new Date(orbitRefTimeMs), 180).map((pt) => [
      pt.x,
      pt.y,
      pt.z,
    ]);
  }, [satA, event, orbitRefTimeMs]);

  const orbitBPoints = useMemo<[number, number, number][]>(() => {
    if (!satB || !event) {
      return [];
    }
    return sampleOrbitPath(satB, new Date(orbitRefTimeMs), 180).map((pt) => [
      pt.x,
      pt.y,
      pt.z,
    ]);
  }, [satB, event, orbitRefTimeMs]);

  const tcaPointScene = useMemo(() => {
    if (!event) {
      return null;
    }
    const pt = eciKmToScene(event.midpointEci, new Date(event.tcaTimeMs));
    return new THREE.Vector3(pt.x, pt.y, pt.z);
  }, [event]);

  // Live glowing red distance line connecting Sat A and Sat B during the encounter
  const distanceLine = useMemo(() => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array(6), 3),
    );
    const material = new THREE.LineBasicMaterial({
      color: '#ef4444',
      transparent: true,
      opacity: 0.95,
      toneMapped: false,
    });
    const line = new THREE.Line(geometry, material);
    line.frustumCulled = false;
    line.visible = false;
    return line;
  }, []);

  useEffect(() => {
    return () => {
      distanceLine.geometry.dispose();
      (distanceLine.material as THREE.Material).dispose();
    };
  }, [distanceLine]);

  useFrame(({ camera, clock }) => {
    if (!event || !satA || !satB || !tcaPointScene) {
      distanceLine.visible = false;
      return;
    }

    const elapsed = clock.getElapsedTime();
    const camPos = camera.position;

    // Distance-scaled billboard pulsing warning marker at exact TCA point
    const tcaDist = camPos.distanceTo(tcaPointScene);
    const coreRadius = THREE.MathUtils.clamp(tcaDist * 0.0045, 0.0005, 0.009);
    const innerRadius = THREE.MathUtils.clamp(tcaDist * 0.014, 0.0016, 0.022);
    const outerRadius = THREE.MathUtils.clamp(tcaDist * 0.023, 0.0026, 0.036);

    if (tcaCoreRef.current) {
      tcaCoreRef.current.scale.setScalar(coreRadius);
    }
    if (innerRingRef.current) {
      innerRingRef.current.lookAt(camPos);
      const pulse = 1 + 0.18 * Math.cos(elapsed * 5.0);
      innerRingRef.current.scale.setScalar(innerRadius * pulse);
    }
    if (outerRingRef.current) {
      outerRingRef.current.lookAt(camPos);
      const pulse = 1 + 0.32 * Math.sin(elapsed * 5.0);
      outerRingRef.current.scale.setScalar(outerRadius * pulse);
    }

    const simDate = new Date(simTimeRef.current);
    const gmst = computeGmst(simDate);
    const posA = propagateToScenePosition(satA.satrec, simDate, gmst);
    const posB = propagateToScenePosition(satB.satrec, simDate, gmst);

    if (!posA || !posB) {
      distanceLine.visible = false;
      if (satAMarkerRef.current) satAMarkerRef.current.visible = false;
      if (satBMarkerRef.current) satBMarkerRef.current.visible = false;
      return;
    }

    // Distance-clamped screen-space scaling (~1.8x background satellites) for both converging spacecraft
    if (satAMarkerRef.current) {
      satAMarkerRef.current.position.set(posA.x, posA.y, posA.z);
      const distA = Math.hypot(
        posA.x - camPos.x,
        posA.y - camPos.y,
        posA.z - camPos.z,
      );
      const scaleA = THREE.MathUtils.clamp(distA * 0.009, 0.0009, 0.022);
      satAMarkerRef.current.scale.setScalar(scaleA);
      satAMarkerRef.current.visible = true;
    }
    if (satBMarkerRef.current) {
      satBMarkerRef.current.position.set(posB.x, posB.y, posB.z);
      const distB = Math.hypot(
        posB.x - camPos.x,
        posB.y - camPos.y,
        posB.z - camPos.z,
      );
      const scaleB = THREE.MathUtils.clamp(distB * 0.009, 0.0009, 0.022);
      satBMarkerRef.current.scale.setScalar(scaleB);
      satBMarkerRef.current.visible = true;
    }

    const distKm =
      Math.hypot(posA.x - posB.x, posA.y - posB.y, posA.z - posB.z) *
      EARTH_RADIUS_KM;

    if (distKm <= LIVE_CONNECT_MAX_KM) {
      const attr = distanceLine.geometry.getAttribute(
        'position',
      ) as THREE.BufferAttribute;
      attr.setXYZ(0, posA.x, posA.y, posA.z);
      attr.setXYZ(1, posB.x, posB.y, posB.z);
      attr.needsUpdate = true;
      distanceLine.visible = true;
    } else {
      distanceLine.visible = false;
    }
  });

  if (!event || !satA || !satB || !tcaPointScene) {
    return null;
  }

  return (
    <group>
      {/* Contrasting full orbital trajectories for Sat A (red) and Sat B (amber) */}
      {orbitAPoints.length >= 2 && (
        <Line
          points={orbitAPoints}
          color="#ef4444"
          lineWidth={1.8}
          transparent
          opacity={0.8}
        />
      )}
      {orbitBPoints.length >= 2 && (
        <Line
          points={orbitBPoints}
          color="#f59e0b"
          lineWidth={1.8}
          transparent
          opacity={0.8}
        />
      )}

      {/* Distance-scaled highlight beacons on the two converging spacecraft */}
      <mesh ref={satAMarkerRef} visible={false}>
        <sphereGeometry args={[1, 14, 14]} />
        <meshBasicMaterial color="#ef4444" toneMapped={false} />
      </mesh>
      <mesh ref={satBMarkerRef} visible={false}>
        <sphereGeometry args={[1, 14, 14]} />
        <meshBasicMaterial color="#f59e0b" toneMapped={false} />
      </mesh>

      {/* Live red distance line between Sat A and Sat B near TCA */}
      <primitive object={distanceLine} />

      {/* Distance-scaled pulsing glowing warning marker at exact TCA encounter point */}
      <group position={tcaPointScene}>
        <mesh ref={tcaCoreRef}>
          <sphereGeometry args={[1, 12, 12]} />
          <meshBasicMaterial color="#ef4444" toneMapped={false} />
        </mesh>
        <mesh ref={innerRingRef}>
          <ringGeometry args={[0.74, 1.0, 32]} />
          <meshBasicMaterial
            color="#ef4444"
            side={THREE.DoubleSide}
            transparent
            opacity={0.95}
            toneMapped={false}
          />
        </mesh>
        <mesh ref={outerRingRef}>
          <ringGeometry args={[0.8, 1.0, 32]} />
          <meshBasicMaterial
            color="#f59e0b"
            side={THREE.DoubleSide}
            transparent
            opacity={0.65}
            toneMapped={false}
          />
        </mesh>
      </group>
    </group>
  );
}
