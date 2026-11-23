import { useMemo } from 'react';
import {
  samplePassSkyTrack,
  type ObserverLocation,
  type ObserverLookAngles,
  type SatellitePass,
} from '../physics/passes';
import type { SatelliteRecord } from '../physics/propagator';

interface SkyPlotProps {
  readonly satellite: SatelliteRecord;
  readonly observer: ObserverLocation;
  readonly lookAngles: ObserverLookAngles | null;
  readonly nextPass: SatellitePass | null;
}

const SIZE = 180;
const CENTER = SIZE / 2;
const RADIUS = 70;

/**
 * Projects (elevationDeg, azimuthDeg) onto a standard sky-view polar plot
 * looking UP from the observer: N top (0°), E left (90°), S bottom (180°), W right (270°).
 */
function projectSkyPoint(
  elevationDeg: number,
  azimuthDeg: number,
): { x: number; y: number } {
  const clampedEl = Math.max(0, Math.min(90, elevationDeg));
  const r = RADIUS * (1 - clampedEl / 90);
  const azRad = (azimuthDeg * Math.PI) / 180;
  return {
    x: CENTER - r * Math.sin(azRad),
    y: CENTER - r * Math.cos(azRad),
  };
}

export function SkyPlot({
  satellite,
  observer,
  lookAngles,
  nextPass,
}: SkyPlotProps) {
  const passTrack = useMemo(() => {
    if (!nextPass) {
      return { pathD: '', startPt: null, endPt: null, peakPt: null, peakEl: 0 };
    }
    const { points, peak } = samplePassSkyTrack(
      satellite.satrec,
      observer,
      nextPass,
      56,
    );
    if (points.length < 2) {
      return { pathD: '', startPt: null, endPt: null, peakPt: null, peakEl: 0 };
    }

    const projected = points.map((pt) =>
      projectSkyPoint(pt.elevationDeg, pt.azimuthDeg),
    );
    const pathD = projected
      .map(
        (p, idx) =>
          `${idx === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`,
      )
      .join(' ');

    const peakPt = peak
      ? projectSkyPoint(peak.elevationDeg, peak.azimuthDeg)
      : null;

    return {
      pathD,
      startPt: projected[0],
      endPt: projected[projected.length - 1],
      peakPt,
      peakEl: peak ? peak.elevationDeg : nextPass.maxElevationDeg,
    };
  }, [satellite, observer, nextPass]);

  const livePt =
    lookAngles && lookAngles.isAboveHorizon
      ? projectSkyPoint(lookAngles.elevationDeg, lookAngles.azimuthDeg)
      : null;

  const ring30 = RADIUS * (1 - 30 / 90);
  const ring60 = RADIUS * (1 - 60 / 90);

  return (
    <div className="flex flex-col items-center rounded-lg border border-white/5 bg-slate-900/60 p-2">
      <div className="mb-1 flex w-full items-center justify-between text-[10px]">
        <span className="font-semibold uppercase tracking-wider text-slate-400">
          Polar Sky Plot
        </span>
        <span className="text-slate-500">
          {livePt ? 'Live in sky' : nextPass ? 'Next pass arc' : 'Horizon view'}
        </span>
      </div>

      <svg
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        className="h-40 w-40 select-none overflow-visible"
        role="img"
        aria-label="Observer polar sky plot"
      >
        {/* Subtle sky dome backdrop */}
        <circle
          cx={CENTER}
          cy={CENTER}
          r={RADIUS}
          fill="rgba(15, 23, 42, 0.85)"
          stroke="rgba(148, 163, 184, 0.35)"
          strokeWidth={1}
        />

        {/* Elevation rings: 30° and 60° */}
        <circle
          cx={CENTER}
          cy={CENTER}
          r={ring30}
          fill="none"
          stroke="rgba(148, 163, 184, 0.18)"
          strokeDasharray="2 3"
          strokeWidth={0.9}
        />
        <circle
          cx={CENTER}
          cy={CENTER}
          r={ring60}
          fill="none"
          stroke="rgba(148, 163, 184, 0.18)"
          strokeDasharray="2 3"
          strokeWidth={0.9}
        />

        {/* N-S and E-W crosshairs */}
        <line
          x1={CENTER}
          y1={CENTER - RADIUS}
          x2={CENTER}
          y2={CENTER + RADIUS}
          stroke="rgba(148, 163, 184, 0.16)"
          strokeWidth={0.8}
        />
        <line
          x1={CENTER - RADIUS}
          y1={CENTER}
          x2={CENTER + RADIUS}
          y2={CENTER}
          stroke="rgba(148, 163, 184, 0.16)"
          strokeWidth={0.8}
        />

        {/* Zenith crosshair dot (90°) */}
        <circle cx={CENTER} cy={CENTER} r={1.4} fill="rgba(148, 163, 184, 0.5)" />

        {/* Elevation ring labels */}
        <text
          x={CENTER + 3}
          y={CENTER - ring30 + 9}
          fill="rgba(148, 163, 184, 0.55)"
          fontSize="7.5"
          fontFamily="ui-monospace, monospace"
        >
          30°
        </text>
        <text
          x={CENTER + 3}
          y={CENTER - ring60 + 9}
          fill="rgba(148, 163, 184, 0.55)"
          fontSize="7.5"
          fontFamily="ui-monospace, monospace"
        >
          60°
        </text>

        {/* Cardinal directions (Sky view looking UP: N top, E left, S bottom, W right) */}
        <text
          x={CENTER}
          y={CENTER - RADIUS - 5}
          textAnchor="middle"
          fill="#f43f5e"
          fontSize="9.5"
          fontWeight="700"
        >
          N
        </text>
        <text
          x={CENTER}
          y={CENTER + RADIUS + 12}
          textAnchor="middle"
          fill="rgba(203, 213, 225, 0.75)"
          fontSize="9"
          fontWeight="600"
        >
          S
        </text>
        <text
          x={CENTER - RADIUS - 9}
          y={CENTER + 3}
          textAnchor="middle"
          fill="rgba(203, 213, 225, 0.75)"
          fontSize="9"
          fontWeight="600"
        >
          E
        </text>
        <text
          x={CENTER + RADIUS + 10}
          y={CENTER + 3}
          textAnchor="middle"
          fill="rgba(203, 213, 225, 0.75)"
          fontSize="9"
          fontWeight="600"
        >
          W
        </text>

        {/* Next upcoming pass curved trajectory */}
        {passTrack.pathD && (
          <>
            <path
              d={passTrack.pathD}
              fill="none"
              stroke="#38bdf8"
              strokeWidth={1.75}
              strokeLinecap="round"
              strokeOpacity={0.85}
            />
            {/* AOS rise marker */}
            {passTrack.startPt && (
              <circle
                cx={passTrack.startPt.x}
                cy={passTrack.startPt.y}
                r={2.5}
                fill="#34d399"
              />
            )}
            {/* LOS set marker */}
            {passTrack.endPt && (
              <circle
                cx={passTrack.endPt.x}
                cy={passTrack.endPt.y}
                r={2.2}
                fill="#94a3b8"
              />
            )}
            {/* Peak elevation marker */}
            {passTrack.peakPt && (
              <g>
                <circle
                  cx={passTrack.peakPt.x}
                  cy={passTrack.peakPt.y}
                  r={3.2}
                  fill="#fbbf24"
                  stroke="#0f172a"
                  strokeWidth={1}
                />
                <text
                  x={passTrack.peakPt.x + 5}
                  y={passTrack.peakPt.y - 4}
                  fill="#fde68a"
                  fontSize="8"
                  fontWeight="600"
                  fontFamily="ui-monospace, monospace"
                >
                  {Math.round(passTrack.peakEl)}°
                </text>
              </g>
            )}
          </>
        )}

        {/* Live current satellite position (when above horizon) */}
        {livePt && (
          <g>
            <circle
              cx={livePt.x}
              cy={livePt.y}
              r={6}
              fill="rgba(52, 211, 153, 0.25)"
            />
            <circle
              cx={livePt.x}
              cy={livePt.y}
              r={3.4}
              fill="#34d399"
              stroke="#ffffff"
              strokeWidth={1}
            />
          </g>
        )}
      </svg>
    </div>
  );
}
