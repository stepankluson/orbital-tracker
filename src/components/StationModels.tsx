import { useMemo, useRef } from 'react';
import { useFrame, type ThreeEvent } from '@react-three/fiber';
import * as THREE from 'three';
import {
  computeGmst,
  propagateToScenePosAndVel,
  type SatelliteRecord,
} from '../physics/propagator';

export const ISS_NORAD_ID = 25544;
export const TIANGONG_NORAD_ID = 48274;

interface StationModelsProps {
  readonly satellites: readonly SatelliteRecord[];
  readonly selectedId: number | null;
  readonly simTimeRef: React.MutableRefObject<number>;
  readonly onSelect: (id: number) => void;
}

interface OrientedStationProps {
  readonly satellite: SatelliteRecord;
  readonly isSelected: boolean;
  readonly simTimeRef: React.MutableRefObject<number>;
  readonly onSelect: (id: number) => void;
  readonly children: React.ReactNode;
}

/**
 * Positions, dynamically scales, and orients a 3D spacecraft model in LVLH attitude:
 * - Local +Z faces prograde (orbital velocity direction)
 * - Local -Y faces nadir (Earth's center)
 * - Local +X / -X spans starboard / port (perpendicular to flight path)
 */
function OrientedStation({
  satellite,
  isSelected,
  simTimeRef,
  onSelect,
  children,
}: OrientedStationProps) {
  const groupRef = useRef<THREE.Group | null>(null);

  const scratch = useMemo(
    () => ({
      pos: new THREE.Vector3(),
      vel: new THREE.Vector3(),
      up: new THREE.Vector3(),
      fwd: new THREE.Vector3(),
      right: new THREE.Vector3(),
      basis: new THREE.Matrix4(),
      quat: new THREE.Quaternion(),
    }),
    [],
  );

  useFrame(({ camera }) => {
    const group = groupRef.current;
    if (!group) {
      return;
    }

    const simDate = new Date(simTimeRef.current);
    const gmst = computeGmst(simDate);
    const state = propagateToScenePosAndVel(satellite.satrec, simDate, gmst);

    if (!state) {
      group.visible = false;
      return;
    }

    group.visible = true;
    const { pos, vel, up, fwd, right, basis, quat } = scratch;
    pos.set(state.pos.x, state.pos.y, state.pos.z);
    vel.set(state.vel.x, state.vel.y, state.vel.z);

    // Local +Y = zenith (outward radial normal), so local -Y points nadir toward Earth's center
    up.copy(pos).normalize();

    // Local +Z = prograde velocity projected onto the local horizontal plane
    fwd.copy(vel).addScaledVector(up, -vel.dot(up));
    if (fwd.lengthSq() > 1e-8) {
      fwd.normalize();
      // Right-handed basis: right = up × fwd -> right × up = fwd (+Z)
      right.crossVectors(up, fwd).normalize();
      basis.makeBasis(right, up, fwd);
      quat.setFromRotationMatrix(basis);
      group.quaternion.copy(quat);
    }

    group.position.copy(pos);

    // Dynamic camera-distance scaling: crisp miniature spacecraft up close, never a giant blob zoomed out
    const distToCam = camera.position.distanceTo(pos);
    const baseScale = THREE.MathUtils.clamp(
      distToCam * (isSelected ? 0.017 : 0.014),
      0.0024,
      isSelected ? 0.024 : 0.019,
    );
    group.scale.setScalar(baseScale);
  });

  const handleClick = (event: ThreeEvent<MouseEvent>): void => {
    event.stopPropagation();
    onSelect(satellite.id);
  };

  return (
    <group
      ref={groupRef}
      visible={false}
      onClick={handleClick}
      onPointerOver={(e) => {
        e.stopPropagation();
        document.body.style.cursor = 'pointer';
      }}
      onPointerOut={() => {
        document.body.style.cursor = 'auto';
      }}
    >
      {children}
    </group>
  );
}

/**
 * Procedural 3D model of the International Space Station (ISS):
 * Central pressurized spine along +Z (prograde), long integrated truss along ±X,
 * thermal radiators aft, and 4 pairs (8 wings) of large golden/copper solar arrays.
 */
function IssGeometry() {
  const wingPositionsX = [-1.45, -1.05, 1.05, 1.45] as const;

  return (
    <group>
      {/* Main integrated truss spanning port (-X) to starboard (+X) */}
      <mesh position={[0, 0.06, 0]}>
        <boxGeometry args={[3.4, 0.1, 0.12]} />
        <meshStandardMaterial color="#94a3b8" metalness={0.65} roughness={0.4} />
      </mesh>

      {/* Central pressurized module spine along prograde (+Z) */}
      <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, 0, 0.05]}>
        <cylinderGeometry args={[0.14, 0.14, 1.45, 12]} />
        <meshStandardMaterial color="#e2e8f0" metalness={0.35} roughness={0.35} />
      </mesh>

      {/* Forward Harmony node + docked crew capsule nose */}
      <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, 0, 0.85]}>
        <cylinderGeometry args={[0.07, 0.12, 0.24, 10]} />
        <meshStandardMaterial color="#f8fafc" metalness={0.25} roughness={0.4} />
      </mesh>

      {/* Aft Zvezda service module */}
      <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, 0, -0.78]}>
        <cylinderGeometry args={[0.11, 0.13, 0.34, 10]} />
        <meshStandardMaterial color="#cbd5e1" metalness={0.4} roughness={0.45} />
      </mesh>

      {/* Columbus (+X) and Kibo (-X) laboratory modules */}
      <mesh rotation={[0, 0, Math.PI / 2]} position={[0.36, -0.02, 0.32]}>
        <cylinderGeometry args={[0.11, 0.11, 0.52, 10]} />
        <meshStandardMaterial color="#e2e8f0" metalness={0.35} roughness={0.35} />
      </mesh>
      <mesh rotation={[0, 0, Math.PI / 2]} position={[-0.4, -0.02, 0.32]}>
        <cylinderGeometry args={[0.115, 0.115, 0.6, 10]} />
        <meshStandardMaterial color="#f1f5f9" metalness={0.3} roughness={0.35} />
      </mesh>

      {/* Nadir-facing Cupola observation dome (-Y points toward Earth) */}
      <mesh position={[0, -0.16, 0.08]}>
        <sphereGeometry args={[0.075, 10, 8]} />
        <meshStandardMaterial
          color="#38bdf8"
          emissive="#0284c7"
          emissiveIntensity={0.4}
          metalness={0.6}
          roughness={0.2}
        />
      </mesh>

      {/* White thermal radiator panels extending aft (-Z) */}
      <mesh position={[-0.45, 0.04, -0.42]}>
        <boxGeometry args={[0.22, 0.015, 0.58]} />
        <meshStandardMaterial color="#f8fafc" roughness={0.5} />
      </mesh>
      <mesh position={[0.45, 0.04, -0.42]}>
        <boxGeometry args={[0.22, 0.015, 0.58]} />
        <meshStandardMaterial color="#f8fafc" roughness={0.5} />
      </mesh>

      {/* 4 pairs (8 wings) of large golden/copper solar arrays */}
      {wingPositionsX.map((xPos) => (
        <group key={xPos} position={[xPos, 0.06, 0]}>
          {/* Forward wing (+Z) */}
          <mesh position={[0, 0, 0.68]}>
            <boxGeometry args={[0.26, 0.014, 1.12]} />
            <meshStandardMaterial
              color="#d97706"
              emissive="#92400e"
              emissiveIntensity={0.32}
              metalness={0.55}
              roughness={0.28}
            />
          </mesh>
          {/* Aft wing (-Z) */}
          <mesh position={[0, 0, -0.68]}>
            <boxGeometry args={[0.26, 0.014, 1.12]} />
            <meshStandardMaterial
              color="#d97706"
              emissive="#92400e"
              emissiveIntensity={0.32}
              metalness={0.55}
              roughness={0.28}
            />
          </mesh>
        </group>
      ))}
    </group>
  );
}

/**
 * Procedural 3D model of the Tiangong / Chinese Space Station (CSS):
 * Iconic T-shaped 3-module structure (Tianhe core + Wentian & Mengtian side labs)
 * with large blue-tinted solar arrays.
 */
function TiangongGeometry() {
  return (
    <group>
      {/* Tianhe core module along prograde (+Z) */}
      <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, 0, -0.15]}>
        <cylinderGeometry args={[0.135, 0.135, 1.2, 12]} />
        <meshStandardMaterial color="#f1f5f9" metalness={0.3} roughness={0.35} />
      </mesh>

      {/* Forward spherical docking hub */}
      <mesh position={[0, 0, 0.52]}>
        <sphereGeometry args={[0.16, 12, 12]} />
        <meshStandardMaterial color="#e2e8f0" metalness={0.35} roughness={0.35} />
      </mesh>

      {/* Docked Shenzhou crew spacecraft on nadir/forward port */}
      <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, 0, 0.78]}>
        <cylinderGeometry args={[0.07, 0.1, 0.28, 10]} />
        <meshStandardMaterial color="#cbd5e1" metalness={0.4} roughness={0.4} />
      </mesh>

      {/* Wentian (+X) and Mengtian (-X) lab modules forming the iconic T-shape */}
      <mesh rotation={[0, 0, Math.PI / 2]} position={[0.62, 0, 0.52]}>
        <cylinderGeometry args={[0.125, 0.125, 1.0, 12]} />
        <meshStandardMaterial color="#f8fafc" metalness={0.3} roughness={0.35} />
      </mesh>
      <mesh rotation={[0, 0, Math.PI / 2]} position={[-0.62, 0, 0.52]}>
        <cylinderGeometry args={[0.125, 0.125, 1.0, 12]} />
        <meshStandardMaterial color="#f8fafc" metalness={0.3} roughness={0.35} />
      </mesh>

      {/* Large blue-tinted flexible solar wings at tips of Wentian & Mengtian */}
      {([-1.18, 1.18] as const).map((xPos) => (
        <group key={xPos} position={[xPos, 0, 0.52]}>
          <mesh position={[0, 0, 0.62]}>
            <boxGeometry args={[0.3, 0.014, 1.05]} />
            <meshStandardMaterial
              color="#2563eb"
              emissive="#1d4ed8"
              emissiveIntensity={0.38}
              metalness={0.5}
              roughness={0.25}
            />
          </mesh>
          <mesh position={[0, 0, -0.62]}>
            <boxGeometry args={[0.3, 0.014, 1.05]} />
            <meshStandardMaterial
              color="#2563eb"
              emissive="#1d4ed8"
              emissiveIntensity={0.38}
              metalness={0.5}
              roughness={0.25}
            />
          </mesh>
        </group>
      ))}

      {/* Smaller blue solar panels on aft Tianhe core */}
      <mesh position={[-0.44, 0, -0.45]}>
        <boxGeometry args={[0.62, 0.012, 0.22]} />
        <meshStandardMaterial
          color="#3b82f6"
          emissive="#1e40af"
          emissiveIntensity={0.35}
          metalness={0.5}
          roughness={0.25}
        />
      </mesh>
      <mesh position={[0.44, 0, -0.45]}>
        <boxGeometry args={[0.62, 0.012, 0.22]} />
        <meshStandardMaterial
          color="#3b82f6"
          emissive="#1e40af"
          emissiveIntensity={0.35}
          metalness={0.5}
          roughness={0.25}
        />
      </mesh>
    </group>
  );
}

export function StationModels({
  satellites,
  selectedId,
  simTimeRef,
  onSelect,
}: StationModelsProps) {
  const iss = useMemo(
    () => satellites.find((sat) => sat.id === ISS_NORAD_ID) ?? null,
    [satellites],
  );
  const tiangong = useMemo(
    () => satellites.find((sat) => sat.id === TIANGONG_NORAD_ID) ?? null,
    [satellites],
  );

  return (
    <group name="station-3d-models">
      {iss && (
        <OrientedStation
          satellite={iss}
          isSelected={selectedId === ISS_NORAD_ID}
          simTimeRef={simTimeRef}
          onSelect={onSelect}
        >
          <IssGeometry />
        </OrientedStation>
      )}
      {tiangong && (
        <OrientedStation
          satellite={tiangong}
          isSelected={selectedId === TIANGONG_NORAD_ID}
          simTimeRef={simTimeRef}
          onSelect={onSelect}
        >
          <TiangongGeometry />
        </OrientedStation>
      )}
    </group>
  );
}
