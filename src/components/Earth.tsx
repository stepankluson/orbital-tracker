import { useEffect, useMemo, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import { Stars } from '@react-three/drei';
import * as THREE from 'three';
import type { SceneVec3 } from '../physics/propagator';

const EARTH_DAY_URL =
  'https://cdn.jsdelivr.net/gh/mrdoob/three.js@r170/examples/textures/planets/earth_atmos_2048.jpg';
const EARTH_SPECULAR_URL =
  'https://cdn.jsdelivr.net/gh/mrdoob/three.js@r170/examples/textures/planets/earth_specular_2048.jpg';
const EARTH_NIGHT_URL =
  'https://cdn.jsdelivr.net/npm/three-globe/example/img/earth-night.jpg';

interface EarthProps {
  readonly sunDirRef: React.MutableRefObject<SceneVec3>;
}

/**
 * Generates a clean procedural equirectangular Earth texture on an offscreen canvas
 * so the globe looks sharp immediately and never breaks if external CDNs are unreachable.
 */
function createProceduralEarthTexture(): THREE.CanvasTexture {
  const width = 1024;
  const height = 512;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');

  if (ctx) {
    const oceanGrad = ctx.createLinearGradient(0, 0, 0, height);
    oceanGrad.addColorStop(0, '#0c2340');
    oceanGrad.addColorStop(0.18, '#0b2d52');
    oceanGrad.addColorStop(0.5, '#0a3560');
    oceanGrad.addColorStop(0.82, '#0b2d52');
    oceanGrad.addColorStop(1, '#0c2340');
    ctx.fillStyle = oceanGrad;
    ctx.fillRect(0, 0, width, height);

    const imageData = ctx.getImageData(0, 0, width, height);
    const data = imageData.data;

    const hash = (x: number, y: number): number => {
      const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123;
      return s - Math.floor(s);
    };

    const smoothNoise = (x: number, y: number): number => {
      const ix = Math.floor(x);
      const iy = Math.floor(y);
      const fx = x - ix;
      const fy = y - iy;
      const ux = fx * fx * (3 - 2 * fx);
      const uy = fy * fy * (3 - 2 * fy);

      const a = hash(ix, iy);
      const b = hash(ix + 1, iy);
      const c = hash(ix, iy + 1);
      const d = hash(ix + 1, iy + 1);

      return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
    };

    const fbm = (x: number, y: number): number => {
      let value = 0;
      let amp = 0.5;
      let freq = 1;
      for (let i = 0; i < 4; i++) {
        value += amp * smoothNoise(x * freq, y * freq);
        freq *= 2.05;
        amp *= 0.5;
      }
      return value;
    };

    for (let py = 0; py < height; py++) {
      const latNorm = Math.abs((py / height) * 2 - 1);
      const phi = (py / height) * Math.PI;
      const sinPhi = Math.sin(phi);

      for (let px = 0; px < width; px++) {
        const theta = (px / width) * Math.PI * 2;
        const nx = Math.cos(theta) * sinPhi * 2.2 + 4.1;
        const ny = Math.sin(theta) * sinPhi * 2.2 + 2.7;
        const nz = Math.cos(phi) * 2.2 + 1.3;

        const n = fbm(nx + nz * 0.6, ny - nz * 0.4);
        const idx = (py * width + px) * 4;

        if (latNorm > 0.87 + (n - 0.5) * 0.08) {
          data[idx] = 205;
          data[idx + 1] = 220;
          data[idx + 2] = 235;
        } else if (n > 0.56) {
          const elev = Math.min(1, (n - 0.56) / 0.25);
          data[idx] = Math.round(28 + elev * 42);
          data[idx + 1] = Math.round(62 + elev * 52);
          data[idx + 2] = Math.round(52 + elev * 24);
        }
      }
    }
    ctx.putImageData(imageData, 0, 0);

    ctx.strokeStyle = 'rgba(125, 211, 252, 0.09)';
    ctx.lineWidth = 1;
    for (let lon = 0; lon <= 12; lon++) {
      const x = (lon / 12) * width;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }
    for (let lat = 1; lat < 6; lat++) {
      const y = (lat / 6) * height;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

/** 1x1 dark fallback texture bound when optional night/specular maps haven't loaded. */
function createFallbackBlackTexture(): THREE.DataTexture {
  const data = new Uint8Array([0, 0, 0, 255]);
  const tex = new THREE.DataTexture(data, 1, 1, THREE.RGBAFormat);
  tex.needsUpdate = true;
  return tex;
}

const EARTH_VERTEX_SHADER = `
  varying vec2 vUv;
  varying vec3 vWorldNormal;
  varying vec3 vWorldPosition;

  void main() {
    vUv = uv;
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vWorldPosition = worldPos.xyz;
    vWorldNormal = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * worldPos;
  }
`;

const EARTH_FRAGMENT_SHADER = `
  uniform sampler2D uDayMap;
  uniform sampler2D uNightMap;
  uniform sampler2D uSpecularMap;
  uniform vec3 uSunDirection;
  uniform float uHasNightMap;
  uniform float uHasSpecularMap;

  varying vec2 vUv;
  varying vec3 vWorldNormal;
  varying vec3 vWorldPosition;

  void main() {
    vec3 N = normalize(vWorldNormal);
    vec3 L = normalize(uSunDirection);
    vec3 V = normalize(cameraPosition - vWorldPosition);

    float ndotl = dot(N, L);
    float diffuse = max(ndotl, 0.0);

    vec3 dayTex = texture2D(uDayMap, vUv).rgb;

    // Ocean specular glint on sunlit side
    vec3 H = normalize(L + V);
    float specMask = uHasSpecularMap > 0.5 ? texture2D(uSpecularMap, vUv).r : 0.25;
    float spec = pow(max(dot(N, H), 0.0), 28.0) * specMask * 0.35 * smoothstep(0.0, 0.25, ndotl);

    vec3 dayColor = dayTex * (0.14 + 0.96 * diffuse) + vec3(0.45, 0.68, 0.95) * spec;

    // Night side: real city-lights texture or safe darkened procedural night tint fallback
    vec3 nightColor;
    if (uHasNightMap > 0.5) {
      vec3 cityLights = texture2D(uNightMap, vUv).rgb;
      nightColor = dayTex * vec3(0.025, 0.04, 0.075) + cityLights * 1.35;
    } else {
      nightColor = dayTex * vec3(0.05, 0.08, 0.15);
    }

    // Smooth blend across the solar terminator with a subtle warm twilight band
    float dayFactor = smoothstep(-0.14, 0.16, ndotl);
    float twilightBand = exp(-pow((ndotl + 0.015) / 0.085, 2.0));
    vec3 twilightTint = vec3(0.88, 0.42, 0.18) * twilightBand * 0.18;

    // Subtle Rayleigh rim scattering strongest on the sunlit limb
    float rim = pow(1.0 - max(dot(N, V), 0.0), 3.0);
    vec3 rimScatter = vec3(0.18, 0.48, 0.95) * rim * (0.08 + 0.28 * dayFactor);

    vec3 finalColor = mix(nightColor, dayColor, dayFactor) + twilightTint + rimScatter;
    gl_FragColor = vec4(finalColor, 1.0);
  }
`;

const ATMOSPHERE_VERTEX_SHADER = `
  varying vec3 vWorldNormal;
  varying vec3 vWorldPosition;

  void main() {
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vWorldPosition = worldPos.xyz;
    vWorldNormal = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * worldPos;
  }
`;

const ATMOSPHERE_FRAGMENT_SHADER = `
  uniform vec3 uSunDirection;

  varying vec3 vWorldNormal;
  varying vec3 vWorldPosition;

  void main() {
    vec3 N = normalize(vWorldNormal);
    vec3 V = normalize(cameraPosition - vWorldPosition);
    vec3 L = normalize(uSunDirection);

    float rim = 1.0 - max(dot(N, V), 0.0);
    float sunFactor = smoothstep(-0.28, 0.42, dot(N, L));
    float intensity = pow(rim, 3.4) * (0.14 + 0.78 * sunFactor);

    vec3 dayGlow = vec3(0.24, 0.64, 1.0);
    vec3 nightGlow = vec3(0.08, 0.20, 0.45);
    vec3 glowColor = mix(nightGlow, dayGlow, sunFactor);

    gl_FragColor = vec4(glowColor, intensity);
  }
`;

interface LoadedEarthMaps {
  readonly dayMap: THREE.Texture | null;
  readonly nightMap: THREE.Texture | null;
  readonly specularMap: THREE.Texture | null;
}

export function Earth({ sunDirRef }: EarthProps) {
  const proceduralTexture = useMemo(() => createProceduralEarthTexture(), []);
  const fallbackBlackTexture = useMemo(() => createFallbackBlackTexture(), []);

  const [maps, setMaps] = useState<LoadedEarthMaps>({
    dayMap: null,
    nightMap: null,
    specularMap: null,
  });

  useEffect(() => {
    return () => {
      proceduralTexture.dispose();
      fallbackBlackTexture.dispose();
    };
  }, [proceduralTexture, fallbackBlackTexture]);

  useEffect(() => {
    let active = true;
    const loader = new THREE.TextureLoader();
    loader.setCrossOrigin('anonymous');

    const loadOptional = (url: string): Promise<THREE.Texture | null> =>
      new Promise((resolve) => {
        loader.load(
          url,
          (tex) => {
            tex.anisotropy = 4;
            resolve(tex);
          },
          undefined,
          () => resolve(null),
        );
      });

    void Promise.all([
      loadOptional(EARTH_DAY_URL),
      loadOptional(EARTH_NIGHT_URL),
      loadOptional(EARTH_SPECULAR_URL),
    ]).then(([dayMap, nightMap, specularMap]) => {
      if (!active) {
        dayMap?.dispose();
        nightMap?.dispose();
        specularMap?.dispose();
        return;
      }
      setMaps({ dayMap, nightMap, specularMap });
    });

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    return () => {
      maps.dayMap?.dispose();
      maps.nightMap?.dispose();
      maps.specularMap?.dispose();
    };
  }, [maps]);

  const earthMaterial = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms: {
          uDayMap: { value: proceduralTexture },
          uNightMap: { value: fallbackBlackTexture },
          uSpecularMap: { value: fallbackBlackTexture },
          uSunDirection: { value: new THREE.Vector3(1, 0, 0) },
          uHasNightMap: { value: 0.0 },
          uHasSpecularMap: { value: 0.0 },
        },
        vertexShader: EARTH_VERTEX_SHADER,
        fragmentShader: EARTH_FRAGMENT_SHADER,
      }),
    [proceduralTexture, fallbackBlackTexture],
  );

  const atmosphereMaterial = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms: {
          uSunDirection: { value: new THREE.Vector3(1, 0, 0) },
        },
        vertexShader: ATMOSPHERE_VERTEX_SHADER,
        fragmentShader: ATMOSPHERE_FRAGMENT_SHADER,
        blending: THREE.AdditiveBlending,
        side: THREE.FrontSide,
        transparent: true,
        depthWrite: false,
      }),
    [],
  );

  useEffect(() => {
    earthMaterial.uniforms['uDayMap'].value = maps.dayMap ?? proceduralTexture;
    earthMaterial.uniforms['uNightMap'].value =
      maps.nightMap ?? fallbackBlackTexture;
    earthMaterial.uniforms['uSpecularMap'].value =
      maps.specularMap ?? fallbackBlackTexture;
    earthMaterial.uniforms['uHasNightMap'].value = maps.nightMap ? 1.0 : 0.0;
    earthMaterial.uniforms['uHasSpecularMap'].value = maps.specularMap
      ? 1.0
      : 0.0;
  }, [maps, earthMaterial, proceduralTexture, fallbackBlackTexture]);

  useEffect(() => {
    return () => {
      earthMaterial.dispose();
      atmosphereMaterial.dispose();
    };
  }, [earthMaterial, atmosphereMaterial]);

  useFrame(() => {
    const sun = sunDirRef.current;
    (earthMaterial.uniforms['uSunDirection'].value as THREE.Vector3).set(
      sun.x,
      sun.y,
      sun.z,
    );
    (atmosphereMaterial.uniforms['uSunDirection'].value as THREE.Vector3).set(
      sun.x,
      sun.y,
      sun.z,
    );
  });

  return (
    <group>
      {/* Deep space starfield */}
      <Stars
        radius={85}
        depth={55}
        count={4200}
        factor={3.2}
        saturation={0.15}
        fade
        speed={0.35}
      />

      {/* Earth globe (radius = 1 scene unit = 6378.137 km) with real-time solar terminator */}
      <mesh name="earth-globe" material={earthMaterial}>
        <sphereGeometry args={[1, 64, 64]} />
      </mesh>

      {/* Sun-aligned atmospheric Fresnel limb glow */}
      <mesh name="earth-atmosphere" material={atmosphereMaterial}>
        <sphereGeometry args={[1.032, 64, 64]} />
      </mesh>
    </group>
  );
}
