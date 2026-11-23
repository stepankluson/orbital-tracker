import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import {
  computeLookAngles,
  observerToScenePosition,
  type ObserverLocation,
} from '../physics/passes';
import {
  computeGmst,
  propagateToScenePosition,
  type SatelliteRecord,
} from '../physics/propagator';

interface ObserverPinProps {
  readonly observer: ObserverLocation | null;
  readonly selectedSatellite: SatelliteRecord | null;
  readonly simTimeRef: React.MutableRefObject<number>;
}

const UP_AXIS = new THREE.Vector3(0, 1, 0);
const SURFACE_RADIUS = 1.002;
const PIN_HEIGHT = 0.032;

export function ObserverPin({
  observer,
  selectedSatellite,
  simTimeRef,
}: ObserverPinProps) {
  const pulseRingRef = useRef<THREE.Mesh | null>(null);

  const placement = useMemo(() => {
    if (!observer) {
      return null;
    }
    const surface = observerToScenePosition(
      observer.lat,
      observer.lon,
      SURFACE_RADIUS,
    );
    const position = new THREE.Vector3(surface.x, surface.y, surface.z);
    const normal = position.clone().normalize();
    const quaternion = new THREE.Quaternion().setFromUnitVectors(
      UP_AXIS,
      normal,
    );
    const tipPosition = normal
      .clone()
      .multiplyScalar(SURFACE_RADIUS + PIN_HEIGHT);
    return { position, quaternion, tipPosition };
  }, [observer]);

  // Glowing Line-of-Sight (LOS) beam from observer pin to selected satellite when above horizon
  const losLine = useMemo(() => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array(6), 3),
    );
    const material = new THREE.LineBasicMaterial({
      color: '#34d399',
      transparent: true,
      opacity: 0.9,
      toneMapped: false,
    });
    const line = new THREE.Line(geometry, material);
    line.frustumCulled = false;
    line.visible = false;
    return line;
  }, []);

  useEffect(() => {
    return () => {
      losLine.geometry.dispose();
      (losLine.material as THREE.Material).dispose();
    };
  }, [losLine]);

  useFrame(({ clock }) => {
    if (!observer || !placement) {
      losLine.visible = false;
      return;
    }

    // Subtle surface pulse on the observer marker
    if (pulseRingRef.current) {
      const pulse = 1 + 0.35 * Math.sin(clock.getElapsedTime() * 3.2);
      pulseRingRef.current.scale.setScalar(pulse);
    }

    if (!selectedSatellite) {
      losLine.visible = false;
      return;
    }

    const simDate = new Date(simTimeRef.current);
    const look = computeLookAngles(selectedSatellite.satrec, observer, simDate);
    if (!look || !look.isAboveHorizon) {
      losLine.visible = false;
      return;
    }

    const gmst = computeGmst(simDate);
    const satPos = propagateToScenePosition(
      selectedSatellite.satrec,
      simDate,
      gmst,
    );
    if (!satPos) {
      losLine.visible = false;
      return;
    }

    const posAttr = losLine.geometry.getAttribute(
      'position',
    ) as THREE.BufferAttribute;
    posAttr.setXYZ(
      0,
      placement.tipPosition.x,
      placement.tipPosition.y,
      placement.tipPosition.z,
    );
    posAttr.setXYZ(1, satPos.x, satPos.y, satPos.z);
    posAttr.needsUpdate = true;
    losLine.visible = true;
  });

  if (!observer || !placement) {
    return null;
  }

  return (
    <group>
      {/* Surface observer pin oriented along the local outward normal */}
      <group position={placement.position} quaternion={placement.quaternion}>
        {/* Ground contact ring */}
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.001, 0]}>
          <ringGeometry args={[0.008, 0.013, 24]} />
          <meshBasicMaterial
            color="#f43f5e"
            side={THREE.DoubleSide}
            transparent
            opacity={0.9}
            toneMapped={false}
          />
        </mesh>

        {/* Subtle pulsing outer ring */}
        <mesh
          ref={pulseRingRef}
          rotation={[-Math.PI / 2, 0, 0]}
          position={[0, 0.0012, 0]}
        >
          <ringGeometry args={[0.015, 0.019, 24]} />
          <meshBasicMaterial
            color="#fb7185"
            side={THREE.DoubleSide}
            transparent
            opacity={0.45}
            toneMapped={false}
          />
        </mesh>

        {/* Pin stem */}
        <mesh position={[0, PIN_HEIGHT / 2, 0]}>
          <cylinderGeometry args={[0.0018, 0.0018, PIN_HEIGHT, 8]} />
          <meshBasicMaterial color="#fda4af" toneMapped={false} />
        </mesh>

        {/* Glowing beacon head */}
        <mesh position={[0, PIN_HEIGHT, 0]}>
          <sphereGeometry args={[0.0075, 12, 12]} />
          <meshBasicMaterial color="#f43f5e" toneMapped={false} />
        </mesh>
      </group>

      {/* Live Line-of-Sight beam when selected satellite is above horizon */}
      <primitive object={losLine} />
    </group>
  );
}
