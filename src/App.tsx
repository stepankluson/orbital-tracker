import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import { ConjunctionOverlay } from './components/ConjunctionOverlay';
import { Earth } from './components/Earth';
import { Hud, type SpeedMultiplier } from './components/Hud';
import { ObserverPin } from './components/ObserverPin';
import { OrbitLine } from './components/OrbitLine';
import { SatelliteFootprint } from './components/SatelliteFootprint';
import { SatelliteSwarm } from './components/SatelliteSwarm';
import {
  loadSatelliteGroup,
  mergeActiveGroups,
  SATELLITE_GROUPS,
  type DataSourceKind,
} from './data/celestrak';
import type {
  ConjunctionEvent,
  ConjunctionThresholdKm,
  ConjunctionWorkerRequest,
  ConjunctionWorkerResponse,
} from './physics/conjunctionTypes';
import {
  computeLookAngles,
  observerToScenePosition,
  predictPasses,
  type ObserverLocation,
} from './physics/passes';
import {
  computeGmst,
  eciKmToScene,
  propagateTelemetry,
  propagateToScenePosition,
  type SatelliteGroupId,
  type SatelliteRecord,
  type SceneVec3,
} from './physics/propagator';
import {
  computeTangentBasis,
  getSunDirectionEcf,
  getSunDirectionScene,
  isSatelliteSunlit,
} from './physics/solar';

type OrbitControlsHandle = React.ComponentRef<typeof OrbitControls>;

const ORIGIN = new THREE.Vector3(0, 0, 0);

interface CameraFlyTo {
  readonly cameraPos: SceneVec3;
  readonly targetPos: SceneVec3;
}

interface SimulationDriverProps {
  readonly simTimeRef: React.MutableRefObject<number>;
  readonly sunDirRef: React.MutableRefObject<SceneVec3>;
  readonly sunLightRef: React.MutableRefObject<THREE.DirectionalLight | null>;
  readonly controlsRef: React.MutableRefObject<OrbitControlsHandle | null>;
  readonly selectedSatellite: SatelliteRecord | null;
  readonly isCameraLocked: boolean;
  readonly hasActiveConjunction: boolean;
  readonly flyToRef: React.MutableRefObject<CameraFlyTo | null>;
  readonly isPlaying: boolean;
  readonly speed: SpeedMultiplier;
  readonly onHudTick: (timeMs: number) => void;
  readonly focusTargetRef: React.MutableRefObject<SceneVec3 | null>;
}

/**
 * Advances the simulation clock inside R3F's render loop, keeps the real-time Sun vector
 * and directional light synchronized in the ECF scene frame, and drives Camera Lock,
 * close-up encounter fly-tos, and one-shot camera focus slews.
 */
function SimulationDriver({
  simTimeRef,
  sunDirRef,
  sunLightRef,
  controlsRef,
  selectedSatellite,
  isCameraLocked,
  hasActiveConjunction,
  flyToRef,
  isPlaying,
  speed,
  onHudTick,
  focusTargetRef,
}: SimulationDriverProps) {
  const { camera } = useThree();
  const accumulatorRef = useRef(0);
  const prevLockedIdRef = useRef<number | null>(null);
  const prevLockedPosRef = useRef<THREE.Vector3 | null>(null);
  const desiredPos = useMemo(() => new THREE.Vector3(), []);
  const targetVec = useMemo(() => new THREE.Vector3(), []);
  const prevDir = useMemo(() => new THREE.Vector3(), []);
  const currDir = useMemo(() => new THREE.Vector3(), []);
  const offsetVec = useMemo(() => new THREE.Vector3(), []);
  const radialQuat = useMemo(() => new THREE.Quaternion(), []);

  useFrame((_, delta) => {
    const clampedDelta = Math.min(delta, 0.1);

    if (isPlaying) {
      simTimeRef.current += clampedDelta * 1000 * speed;
    }

    const simDate = new Date(simTimeRef.current);

    // Update real-time Sun direction in ECF scene frame every frame
    const sunDir = getSunDirectionScene(simDate);
    sunDirRef.current = sunDir;
    if (sunLightRef.current) {
      sunLightRef.current.position.set(
        sunDir.x * 12,
        sunDir.y * 12,
        sunDir.z * 12,
      );
    }

    // Throttle HUD clock & telemetry updates to ~10 Hz to avoid React re-renders every frame
    accumulatorRef.current += clampedDelta;
    if (accumulatorRef.current >= 0.1) {
      accumulatorRef.current = 0;
      onHudTick(simTimeRef.current);
    }

    const controls = controlsRef.current;

    // Camera Lock: orbit with the selected satellite in its local radial frame
    if (isCameraLocked && selectedSatellite && controls) {
      const gmst = computeGmst(simDate);
      const satPos = propagateToScenePosition(
        selectedSatellite.satrec,
        simDate,
        gmst,
      );

      if (satPos) {
        targetVec.set(satPos.x, satPos.y, satPos.z);

        if (
          prevLockedPosRef.current === null ||
          prevLockedIdRef.current !== selectedSatellite.id
        ) {
          // Place camera outside the satellite along its radial vector with a slight tangential offset
          // so Earth sits cleanly in the background and never occludes the spacecraft
          const r = targetVec.length() || 1;
          const n: SceneVec3 = {
            x: targetVec.x / r,
            y: targetVec.y / r,
            z: targetVec.z / r,
          };
          const { t1 } = computeTangentBasis(n);
          camera.position.set(
            targetVec.x + n.x * 0.42 + t1.x * 0.22,
            targetVec.y + n.y * 0.42 + t1.y * 0.22,
            targetVec.z + n.z * 0.42 + t1.z * 0.22,
          );
          controls.target.copy(targetVec);
          prevLockedPosRef.current = targetVec.clone();
          prevLockedIdRef.current = selectedSatellite.id;
        } else {
          // Rotate the camera's offset vector by the satellite's radial rotation quaternion
          prevDir.copy(prevLockedPosRef.current).normalize();
          currDir.copy(targetVec).normalize();
          radialQuat.setFromUnitVectors(prevDir, currDir);

          offsetVec.subVectors(camera.position, prevLockedPosRef.current);
          offsetVec.applyQuaternion(radialQuat);

          camera.position.copy(targetVec).add(offsetVec);
          controls.target.copy(targetVec);
          prevLockedPosRef.current.copy(targetVec);
        }

        controls.update();
      }
      focusTargetRef.current = null;
      return;
    }

    // Reset lock tracking when unlocked
    prevLockedPosRef.current = null;
    prevLockedIdRef.current = null;

    // Close-up camera fly-to for a selected conjunction encounter
    const flyTo = flyToRef.current;
    if (flyTo && controls) {
      const lerpAlpha = 1 - Math.exp(-5.5 * clampedDelta);
      desiredPos.set(flyTo.cameraPos.x, flyTo.cameraPos.y, flyTo.cameraPos.z);
      targetVec.set(flyTo.targetPos.x, flyTo.targetPos.y, flyTo.targetPos.z);
      camera.position.lerp(desiredPos, lerpAlpha);
      controls.target.lerp(targetVec, lerpAlpha);
      controls.update();

      if (
        camera.position.distanceTo(desiredPos) < 0.008 &&
        controls.target.distanceTo(targetVec) < 0.008
      ) {
        flyToRef.current = null;
      }
      return;
    }

    // Smoothly return OrbitControls target back to Earth's center (0, 0, 0) when not viewing an encounter
    if (!hasActiveConjunction && controls && controls.target.lengthSq() > 1e-6) {
      const lerpAlpha = 1 - Math.exp(-7 * clampedDelta);
      controls.target.lerp(ORIGIN, lerpAlpha);
      if (controls.target.length() < 0.002) {
        controls.target.set(0, 0, 0);
      }
      controls.update();
    }

    // Smooth one-shot camera slew when focusing a satellite or observer pin
    const target = focusTargetRef.current;
    if (target) {
      const currentDist = Math.max(camera.position.length(), 2.4);
      desiredPos
        .set(target.x, target.y, target.z)
        .normalize()
        .multiplyScalar(currentDist);
      camera.position.lerp(desiredPos, 1 - Math.exp(-6 * clampedDelta));
      camera.lookAt(0, 0, 0);

      if (camera.position.distanceTo(desiredPos) < 0.03) {
        focusTargetRef.current = null;
      }
    }
  });

  return null;
}

const DEFAULT_ENABLED_GROUPS: readonly SatelliteGroupId[] = SATELLITE_GROUPS.filter(
  (g) => g.defaultEnabled,
).map((g) => g.id);

export function App() {
  const [enabledGroups, setEnabledGroups] = useState<Set<SatelliteGroupId>>(
    () => new Set(DEFAULT_ENABLED_GROUPS),
  );
  const [loadedByGroup, setLoadedByGroup] = useState<
    Partial<Record<SatelliteGroupId, SatelliteRecord[]>>
  >({});
  const [loadingGroups, setLoadingGroups] = useState<Set<SatelliteGroupId>>(
    () => new Set(DEFAULT_ENABLED_GROUPS),
  );
  const [isLoading, setIsLoading] = useState(true);
  const [dataSource, setDataSource] = useState<DataSourceKind | null>(null);
  const [warning, setWarning] = useState<string | undefined>(undefined);

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [isCameraLocked, setIsCameraLocked] = useState(false);
  const [observer, setObserver] = useState<ObserverLocation | null>(null);
  const [isPlaying, setIsPlaying] = useState(true);
  const [speed, setSpeed] = useState<SpeedMultiplier>(1);

  // Conjunction Radar state
  const [conjunctionEvents, setConjunctionEvents] = useState<
    ConjunctionEvent[]
  >([]);
  const [activeConjunction, setActiveConjunction] =
    useState<ConjunctionEvent | null>(null);
  const [conjunctionScanning, setConjunctionScanning] = useState(false);
  const [conjunctionProgress, setConjunctionProgress] = useState(0);
  const [conjunctionThresholdKm, setConjunctionThresholdKm] =
    useState<ConjunctionThresholdKm>(50);
  const [conjunctionScannedOnce, setConjunctionScannedOnce] = useState(false);

  const initialNow = useMemo(() => Date.now(), []);
  const simTimeRef = useRef<number>(initialNow);
  const sunDirRef = useRef<SceneVec3>(
    getSunDirectionScene(new Date(initialNow)),
  );
  const sunLightRef = useRef<THREE.DirectionalLight | null>(null);
  const controlsRef = useRef<OrbitControlsHandle | null>(null);
  const focusTargetRef = useRef<SceneVec3 | null>(null);
  const flyToRef = useRef<CameraFlyTo | null>(null);
  const workerRef = useRef<Worker | null>(null);

  const [hudTimeMs, setHudTimeMs] = useState<number>(initialNow);
  const [orbitRefTimeMs, setOrbitRefTimeMs] = useState<number>(initialNow);
  const [passesAnchorMs, setPassesAnchorMs] = useState<number>(initialNow);

  const fetchAndStoreGroup = useCallback(async (groupId: SatelliteGroupId) => {
    setLoadingGroups((prev) => {
      const next = new Set(prev);
      next.add(groupId);
      return next;
    });

    const result = await loadSatelliteGroup(groupId);

    setLoadedByGroup((prev) => ({
      ...prev,
      [groupId]: result.satellites,
    }));
    setLoadingGroups((prev) => {
      const next = new Set(prev);
      next.delete(groupId);
      return next;
    });
    setDataSource((prev) => {
      if (result.source === 'snapshot') {
        return 'snapshot';
      }
      if (result.source === 'live') {
        return 'live';
      }
      if (result.source === 'cache' && prev !== 'live' && prev !== 'snapshot') {
        return 'cache';
      }
      return prev ?? result.source;
    });
    if (result.warning) {
      setWarning(result.warning);
    } else if (result.source !== 'fallback') {
      setWarning(undefined);
    }
  }, []);

  // Load default-enabled groups on initial mount
  useEffect(() => {
    let active = true;
    void Promise.all(
      DEFAULT_ENABLED_GROUPS.map((groupId) => fetchAndStoreGroup(groupId)),
    ).then(() => {
      if (active) {
        setIsLoading(false);
      }
    });
    return () => {
      active = false;
    };
  }, [fetchAndStoreGroup]);

  const satellites = useMemo(
    () => mergeActiveGroups(enabledGroups, loadedByGroup),
    [enabledGroups, loadedByGroup],
  );

  const groupCounts = useMemo(() => {
    const counts: Partial<Record<SatelliteGroupId, number>> = {};
    const dedicatedIds = new Set<number>();

    for (const group of SATELLITE_GROUPS) {
      const list = loadedByGroup[group.id];
      if (!list) {
        continue;
      }
      if (group.id !== 'active') {
        counts[group.id] = list.length;
        for (let i = 0; i < list.length; i++) {
          dedicatedIds.add(list[i].id);
        }
      } else {
        // Count only satellites not already present in dedicated layers (stations/visual/starlink/gnss/weather)
        let uniqueCount = 0;
        for (let i = 0; i < list.length; i++) {
          if (!dedicatedIds.has(list[i].id)) {
            uniqueCount++;
          }
        }
        counts.active = uniqueCount;
      }
    }
    return counts;
  }, [loadedByGroup]);

  const handleToggleGroup = useCallback(
    (groupId: SatelliteGroupId) => {
      setEnabledGroups((prev) => {
        const next = new Set(prev);
        if (next.has(groupId)) {
          next.delete(groupId);
        } else {
          next.add(groupId);
          if (!loadedByGroup[groupId] && !loadingGroups.has(groupId)) {
            void fetchAndStoreGroup(groupId);
          }
        }
        return next;
      });
    },
    [loadedByGroup, loadingGroups, fetchAndStoreGroup],
  );

  // Clear selection/lock if the selected satellite's layer was turned off
  useEffect(() => {
    if (
      selectedId !== null &&
      !satellites.some((sat) => sat.id === selectedId)
    ) {
      setSelectedId(null);
      setIsCameraLocked(false);
    }
  }, [satellites, selectedId]);

  // Terminate conjunction worker on unmount
  useEffect(() => {
    return () => {
      workerRef.current?.terminate();
      workerRef.current = null;
    };
  }, []);

  // Unlock camera or exit conjunction encounter when pressing Escape
  useEffect(() => {
    if (!isCameraLocked && !activeConjunction) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setIsCameraLocked(false);
        setActiveConjunction(null);
        flyToRef.current = null;
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isCameraLocked, activeConjunction]);

  const handleScanConjunctions = useCallback(() => {
    if (satellites.length < 2) {
      return;
    }
    workerRef.current?.terminate();

    const worker = new Worker(
      new URL('./physics/conjunction.worker.ts', import.meta.url),
      { type: 'module' },
    );
    workerRef.current = worker;

    setConjunctionScanning(true);
    setConjunctionProgress(0);

    worker.onmessage = (event: MessageEvent<ConjunctionWorkerResponse>) => {
      const msg = event.data;
      if (msg.type === 'progress') {
        setConjunctionProgress(msg.percent);
      } else if (msg.type === 'result') {
        setConjunctionEvents(msg.events);
        setConjunctionScanning(false);
        setConjunctionProgress(100);
        setConjunctionScannedOnce(true);
        worker.terminate();
        if (workerRef.current === worker) {
          workerRef.current = null;
        }
      }
    };

    worker.onerror = () => {
      setConjunctionScanning(false);
      worker.terminate();
      if (workerRef.current === worker) {
        workerRef.current = null;
      }
    };

    const payload: ConjunctionWorkerRequest = {
      satellites: satellites.map((s) => ({
        id: s.id,
        name: s.name,
        satrec: s.satrec,
      })),
      startTimeMs: simTimeRef.current,
      durationMinutes: 60,
      thresholdKm: conjunctionThresholdKm,
    };
    worker.postMessage(payload);
  }, [satellites, conjunctionThresholdKm]);

  const handleSelectConjunction = useCallback((event: ConjunctionEvent) => {
    setIsCameraLocked(false);
    setActiveConjunction(event);

    // Jump clock to 15 seconds before TCA at 1x speed to watch the flyby live
    const preTcaMs = event.tcaTimeMs - 15_000;
    const preTcaDate = new Date(preTcaMs);
    simTimeRef.current = preTcaMs;
    sunDirRef.current = getSunDirectionScene(preTcaDate);
    setHudTimeMs(preTcaMs);
    setOrbitRefTimeMs(event.tcaTimeMs);
    setSpeed(1);
    setIsPlaying(true);

    // Compute dramatic close-up vantage point looking at the exact TCA encounter point
    const tcaScene = eciKmToScene(
      event.midpointEci,
      new Date(event.tcaTimeMs),
    );
    const r = Math.hypot(tcaScene.x, tcaScene.y, tcaScene.z) || 1;
    const n: SceneVec3 = {
      x: tcaScene.x / r,
      y: tcaScene.y / r,
      z: tcaScene.z / r,
    };
    const { t1 } = computeTangentBasis(n);
    const cameraPos: SceneVec3 = {
      x: tcaScene.x + n.x * 0.14 + t1.x * 0.14,
      y: tcaScene.y + n.y * 0.14 + t1.y * 0.14,
      z: tcaScene.z + n.z * 0.14 + t1.z * 0.14,
    };

    focusTargetRef.current = null;
    flyToRef.current = { cameraPos, targetPos: tcaScene };
  }, []);

  const handleClearConjunction = useCallback(() => {
    setActiveConjunction(null);
    flyToRef.current = null;
  }, []);

  const conjunctionSatA = useMemo(
    () =>
      activeConjunction
        ? (satellites.find((s) => s.id === activeConjunction.satAId) ?? null)
        : null,
    [satellites, activeConjunction],
  );

  const conjunctionSatB = useMemo(
    () =>
      activeConjunction
        ? (satellites.find((s) => s.id === activeConjunction.satBId) ?? null)
        : null,
    [satellites, activeConjunction],
  );

  const selectedSatellite = useMemo(
    () => satellites.find((sat) => sat.id === selectedId) ?? null,
    [satellites, selectedId],
  );

  const selectedTelemetry = useMemo(() => {
    if (!selectedSatellite) {
      return null;
    }
    return propagateTelemetry(selectedSatellite, new Date(hudTimeMs));
  }, [selectedSatellite, hudTimeMs]);

  const selectedSunlit = useMemo(() => {
    if (!selectedTelemetry) {
      return null;
    }
    const sunEcf = getSunDirectionEcf(new Date(hudTimeMs));
    return isSatelliteSunlit(selectedTelemetry.positionEcfKm, sunEcf);
  }, [selectedTelemetry, hudTimeMs]);

  const lookAngles = useMemo(() => {
    if (!selectedSatellite || !observer) {
      return null;
    }
    return computeLookAngles(
      selectedSatellite.satrec,
      observer,
      new Date(hudTimeMs),
    );
  }, [selectedSatellite, observer, hudTimeMs]);

  // Memoize 48h pass prediction per satellite + observer + anchor time
  const passes = useMemo(() => {
    if (!selectedSatellite || !observer) {
      return [];
    }
    return predictPasses(
      selectedSatellite.satrec,
      observer,
      new Date(passesAnchorMs),
      48,
      5,
    );
  }, [selectedSatellite, observer, passesAnchorMs]);

  const handleHudTick = useCallback((timeMs: number) => {
    setHudTimeMs(timeMs);
    setOrbitRefTimeMs((prev) =>
      Math.abs(timeMs - prev) >= 30_000 ? timeMs : prev,
    );
  }, []);

  const handleSelectSatellite = useCallback(
    (id: number, focusCamera = false) => {
      setSelectedId(id);
      setOrbitRefTimeMs(simTimeRef.current);
      setPassesAnchorMs(simTimeRef.current);

      if (focusCamera) {
        const sat = satellites.find((s) => s.id === id);
        if (sat) {
          const telemetry = propagateTelemetry(
            sat,
            new Date(simTimeRef.current),
          );
          if (telemetry) {
            focusTargetRef.current = telemetry.positionScene;
          }
        }
      }
    },
    [satellites],
  );

  const handleClearSelection = useCallback(() => {
    setSelectedId(null);
    setIsCameraLocked(false);
  }, []);

  const handleToggleCameraLock = useCallback(() => {
    setIsCameraLocked((prev) => !prev);
  }, []);

  const handleObserverChange = useCallback(
    (nextObserver: ObserverLocation | null) => {
      setObserver(nextObserver);
      setPassesAnchorMs(simTimeRef.current);
      if (nextObserver && !isCameraLocked) {
        focusTargetRef.current = observerToScenePosition(
          nextObserver.lat,
          nextObserver.lon,
          1.0,
        );
      }
    },
    [isCameraLocked],
  );

  const handleJumpToPass = useCallback(
    (aosTime: Date) => {
      const targetMs = aosTime.getTime();
      simTimeRef.current = targetMs;
      sunDirRef.current = getSunDirectionScene(aosTime);
      setHudTimeMs(targetMs);
      setOrbitRefTimeMs(targetMs);
      setSpeed(10);
      setIsPlaying(true);

      if (observer && !isCameraLocked) {
        focusTargetRef.current = observerToScenePosition(
          observer.lat,
          observer.lon,
          1.0,
        );
      }
    },
    [observer, isCameraLocked],
  );

  const handleResetLive = useCallback(() => {
    const now = Date.now();
    simTimeRef.current = now;
    sunDirRef.current = getSunDirectionScene(new Date(now));
    setHudTimeMs(now);
    setOrbitRefTimeMs(now);
    setPassesAnchorMs(now);
    setSpeed(1);
    setIsPlaying(true);
  }, []);

  const handleCancelFocus = useCallback(() => {
    focusTargetRef.current = null;
    flyToRef.current = null;
  }, []);

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-slate-950">
      <Canvas
        camera={{ position: [0, 1.1, 3.1], fov: 42, near: 0.02, far: 1000 }}
        dpr={[1, 2]}
        gl={{ antialias: true, powerPreference: 'high-performance' }}
      >
        <color attach="background" args={['#020617']} />

        {/* Real-time Sun-aligned directional light + subtle ambient fill */}
        <ambientLight intensity={0.28} color="#94b8e6" />
        <directionalLight
          ref={sunLightRef}
          position={[
            sunDirRef.current.x * 12,
            sunDirRef.current.y * 12,
            sunDirRef.current.z * 12,
          ]}
          intensity={2.2}
          color="#fff7ed"
        />

        <SimulationDriver
          simTimeRef={simTimeRef}
          sunDirRef={sunDirRef}
          sunLightRef={sunLightRef}
          controlsRef={controlsRef}
          selectedSatellite={selectedSatellite}
          isCameraLocked={isCameraLocked}
          hasActiveConjunction={activeConjunction !== null}
          flyToRef={flyToRef}
          isPlaying={isPlaying}
          speed={speed}
          onHudTick={handleHudTick}
          focusTargetRef={focusTargetRef}
        />

        <Earth sunDirRef={sunDirRef} />

        <SatelliteSwarm
          satellites={satellites}
          selectedId={selectedId}
          activeConjunction={activeConjunction}
          simTimeRef={simTimeRef}
          sunDirRef={sunDirRef}
          onSelect={(id) => handleSelectSatellite(id, false)}
        />

        <OrbitLine
          satellite={selectedSatellite}
          referenceTimeMs={orbitRefTimeMs}
        />

        <SatelliteFootprint
          satellite={selectedSatellite}
          simTimeRef={simTimeRef}
        />

        <ConjunctionOverlay
          event={activeConjunction}
          satA={conjunctionSatA}
          satB={conjunctionSatB}
          simTimeRef={simTimeRef}
          orbitRefTimeMs={orbitRefTimeMs}
        />

        <ObserverPin
          observer={observer}
          selectedSatellite={selectedSatellite}
          simTimeRef={simTimeRef}
        />

        <OrbitControls
          ref={controlsRef}
          enablePan={false}
          enableDamping
          dampingFactor={0.07}
          minDistance={isCameraLocked || activeConjunction ? 0.06 : 1.35}
          maxDistance={36}
          rotateSpeed={0.55}
          zoomSpeed={0.8}
          onStart={handleCancelFocus}
        />
      </Canvas>

      <Hud
        satellites={satellites}
        enabledGroups={enabledGroups}
        loadingGroups={loadingGroups}
        groupCounts={groupCounts}
        onToggleGroup={handleToggleGroup}
        conjunctionEvents={conjunctionEvents}
        activeConjunction={activeConjunction}
        conjunctionScanning={conjunctionScanning}
        conjunctionProgress={conjunctionProgress}
        conjunctionThresholdKm={conjunctionThresholdKm}
        conjunctionScannedOnce={conjunctionScannedOnce}
        onConjunctionThresholdChange={setConjunctionThresholdKm}
        onScanConjunctions={handleScanConjunctions}
        onSelectConjunction={handleSelectConjunction}
        onClearConjunction={handleClearConjunction}
        selectedTelemetry={selectedTelemetry}
        selectedSunlit={selectedSunlit}
        isCameraLocked={isCameraLocked}
        onToggleCameraLock={handleToggleCameraLock}
        observer={observer}
        onObserverChange={handleObserverChange}
        lookAngles={lookAngles}
        passes={passes}
        onJumpToPass={handleJumpToPass}
        isLoading={isLoading}
        dataSource={dataSource}
        warning={warning}
        simTimeMs={hudTimeMs}
        isPlaying={isPlaying}
        speed={speed}
        onTogglePlay={() => setIsPlaying((prev) => !prev)}
        onResetLive={handleResetLive}
        onSpeedChange={setSpeed}
        onSelectSatellite={handleSelectSatellite}
        onClearSelection={handleClearSelection}
      />
    </div>
  );
}

export default App;
