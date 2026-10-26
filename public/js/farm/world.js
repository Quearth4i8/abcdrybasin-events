// Environment: sky + sun + image-based light, terrain with a paintable ground mask, grass.
import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { addWind } from './shaders.js';

export const FLAT = 95; // terrain is flat (y = 0) within this half-size; hills rise beyond
export const MASK_EXTENT = 180; // paintable square (metres) centred on the origin
export const MASK_SIZE = 768; // mask resolution (texels per side)
export const LAYERS = ['grass', 'dirt', 'soil', 'paving', 'gravel']; // grass = no paint

// ---------------------------------------------------------------- terrain height
function hash2(i, j) {
  const s = Math.sin(i * 127.1 + j * 311.7) * 43758.5453;
  return s - Math.floor(s);
}
function vnoise(x, z) {
  const i = Math.floor(x), j = Math.floor(z), fx = x - i, fz = z - j;
  const u = fx * fx * (3 - 2 * fx), v = fz * fz * (3 - 2 * fz);
  const a = hash2(i, j), b = hash2(i + 1, j), c = hash2(i, j + 1), d = hash2(i + 1, j + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
export function terrainHeight(x, z) {
  const d = Math.max(Math.abs(x), Math.abs(z)) - FLAT;
  if (d <= 0) return 0;
  const ramp = THREE.MathUtils.smoothstep(d, 0, 160);
  const n = vnoise(x * 0.012 + 3.1, z * 0.012 - 1.7) * 0.65 + vnoise(x * 0.03, z * 0.03) * 0.35;
  return ramp * (4 + 22 * n) + THREE.MathUtils.smoothstep(d, 0, 25) * 0.6 * vnoise(x * 0.1, z * 0.1);
}

// ---------------------------------------------------------------- sky, sun, environment
export function createSky(scene, renderer, high) {
  const sky = new Sky();
  sky.scale.setScalar(6000);
  scene.add(sky);
  const u = sky.material.uniforms;
  u.turbidity.value = 3.2;
  u.rayleigh.value = 1.1;
  u.mieCoefficient.value = 0.004;
  u.mieDirectionalG.value = 0.82;

  const sun = new THREE.DirectionalLight(0xfff0dc, 4.4);
  sun.castShadow = true;
  sun.shadow.mapSize.setScalar(high ? 4096 : 2048);
  Object.assign(sun.shadow.camera, { left: -95, right: 95, top: 95, bottom: -95, near: 1, far: 500 });
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.06;
  scene.add(sun, sun.target);

  scene.fog = new THREE.FogExp2(0xbac8d4, 0.0015);
  scene.environmentIntensity = 0.45;

  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  const envSky = new THREE.Mesh(sky.geometry, sky.material);
  envSky.scale.setScalar(900);
  envScene.add(envSky);
  let envRT = null;
  const dir = new THREE.Vector3();
  const AZIMUTH = 215;

  function setElevation(elevationDeg) {
    const phi = THREE.MathUtils.degToRad(90 - elevationDeg);
    const theta = THREE.MathUtils.degToRad(AZIMUTH);
    dir.set(Math.sin(theta) * Math.sin(phi), Math.cos(phi), -Math.cos(theta) * Math.sin(phi));
    u.sunPosition.value.copy(dir);
    const low = THREE.MathUtils.smoothstep(elevationDeg, 2, 25);
    sun.color.setRGB(1, 0.72 + 0.25 * low, 0.5 + 0.4 * low);
    sun.intensity = 0.8 + 3.6 * low;
    scene.fog.color.setRGB(0.70 + 0.1 * (1 - low), 0.76 - 0.02 * (1 - low), 0.82 - 0.12 * (1 - low));
    envRT?.dispose();
    envRT = pmrem.fromScene(envScene, 0, 0.1, 5000);
    scene.environment = envRT.texture;
  }
  function follow(target) {
    sun.target.position.set(target.x, 0, target.z);
    sun.position.copy(dir).multiplyScalar(250).add(sun.target.position);
  }
  return { sky, sun, setElevation, follow };
}

// ---------------------------------------------------------------- ground mask (painted layers)
export class GroundMask {
  constructor() {
    this.size = MASK_SIZE;
    this.extent = MASK_EXTENT;
    this.data = new Uint8Array(this.size * this.size * 4); // R dirt, G soil, B paving, A gravel
    this.texture = new THREE.DataTexture(this.data, this.size, this.size, THREE.RGBAFormat);
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.needsUpdate = true;
  }
  clear() { this.data.fill(0); this.texture.needsUpdate = true; }
  toPixel(x, z) {
    return [(x / this.extent + 0.5) * this.size - 0.5, (z / this.extent + 0.5) * this.size - 0.5];
  }
  /** Weights [dirt, soil, paving, gravel] (0..1) at a world point. */
  sample(x, z) {
    const [px, pz] = this.toPixel(x, z);
    const i = Math.round(px), j = Math.round(pz);
    if (i < 0 || j < 0 || i >= this.size || j >= this.size) return [0, 0, 0, 0];
    const k = (j * this.size + i) * 4, d = this.data;
    return [d[k] / 255, d[k + 1] / 255, d[k + 2] / 255, d[k + 3] / 255];
  }
  /** Soft round dab. layer: 0 = grass (erase), 1..4 = dirt/soil/paving/gravel. */
  dab(x, z, radius, layer, strength = 1, hardness = 0.6) {
    const [cx, cz] = this.toPixel(x, z);
    const r = radius / this.extent * this.size;
    const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(this.size - 1, Math.ceil(cx + r));
    const z0 = Math.max(0, Math.floor(cz - r)), z1 = Math.min(this.size - 1, Math.ceil(cz + r));
    const d = this.data;
    for (let j = z0; j <= z1; j++) {
      for (let i = x0; i <= x1; i++) {
        const dist = Math.hypot(i - cx, j - cz) / r;
        if (dist >= 1) continue;
        const w = strength * (dist < hardness ? 1 : 1 - THREE.MathUtils.smoothstep(dist, hardness, 1));
        const k = (j * this.size + i) * 4;
        for (let c = 0; c < 4; c++) {
          const target = c === layer - 1 ? 255 : 0;
          d[k + c] = Math.round(d[k + c] + (target - d[k + c]) * w);
        }
      }
    }
    this.texture.needsUpdate = true;
  }
  /** Paint an axis-aligned rectangle (used by the default layout). */
  rect(layer, xa, za, xb, zb, soft = 0.6) {
    const [i0, j0] = this.toPixel(Math.min(xa, xb), Math.min(za, zb));
    const [i1, j1] = this.toPixel(Math.max(xa, xb), Math.max(za, zb));
    const s = soft / this.extent * this.size;
    const d = this.data;
    for (let j = Math.max(0, Math.floor(j0 - s)); j <= Math.min(this.size - 1, Math.ceil(j1 + s)); j++) {
      for (let i = Math.max(0, Math.floor(i0 - s)); i <= Math.min(this.size - 1, Math.ceil(i1 + s)); i++) {
        const ex = Math.max(i0 - i, 0, i - i1), ez = Math.max(j0 - j, 0, j - j1);
        const w = 1 - THREE.MathUtils.smoothstep(Math.hypot(ex, ez), 0, s + 1e-6);
        if (w <= 0) continue;
        const k = (j * this.size + i) * 4;
        for (let c = 0; c < 4; c++) {
          const target = c === layer - 1 ? 255 : 0;
          d[k + c] = Math.round(d[k + c] + (target - d[k + c]) * w);
        }
      }
    }
    this.texture.needsUpdate = true;
  }
  line(layer, pts, width) {
    for (let p = 0; p < pts.length - 1; p++) {
      const [ax, az] = pts[p], [bx, bz] = pts[p + 1];
      const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / (width * 0.25)));
      for (let s = 0; s <= steps; s++) this.dab(ax + (bx - ax) * s / steps, az + (bz - az) * s / steps, width / 2, layer, 1, 0.75);
    }
  }
  async encode() {
    const stream = new Blob([this.data]).stream().pipeThrough(new CompressionStream('gzip'));
    const buf = new Uint8Array(await new Response(stream).arrayBuffer());
    let bin = '';
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    return { size: this.size, extent: this.extent, data: btoa(bin) };
  }
  async decode(g) {
    const bin = atob(g.data);
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
    const raw = new Uint8Array(await new Response(stream).arrayBuffer());
    if (g.size === this.size && raw.length === this.data.length) this.data.set(raw);
    else this.clear();
    this.texture.needsUpdate = true;
  }
}

// ---------------------------------------------------------------- terrain mesh + splat shader
export function createTerrain(layers, mask) {
  const size = 900, seg = 225;
  const geo = new THREE.PlaneGeometry(size, size, seg, seg);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  const uv = geo.attributes.uv;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    pos.setY(i, terrainHeight(x, z));
    uv.setXY(i, x / 3, -z / 3);
  }
  geo.computeVertexNormals();

  const g = layers.grass;
  const mat = new THREE.MeshStandardMaterial({ map: g.map, normalMap: g.normalMap, roughnessMap: g.roughnessMap, roughness: 1, metalness: 0 });
  const u = {
    groundMask: { value: mask.texture }, maskExtent: { value: mask.extent },
    dirtMap: { value: layers.dirt.map }, dirtNormal: { value: layers.dirt.normalMap },
    soilMap: { value: layers.soil.map }, soilNormal: { value: layers.soil.normalMap },
    pavingMap: { value: layers.paving.map }, pavingNormal: { value: layers.paving.normalMap },
    gravelMap: { value: layers.gravel.map }, gravelNormal: { value: layers.gravel.normalMap },
  };
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vGroundXZ;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvGroundXZ = (modelMatrix * vec4(transformed, 1.0)).xz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec2 vGroundXZ;
        uniform sampler2D groundMask, dirtMap, dirtNormal, soilMap, soilNormal, pavingMap, pavingNormal, gravelMap, gravelNormal;
        uniform float maskExtent;`)
      .replace('#include <map_fragment>', `
        vec2 mUv = vGroundXZ / maskExtent + 0.5;
        vec4 m = (mUv.x > 0.0 && mUv.y > 0.0 && mUv.x < 1.0 && mUv.y < 1.0) ? texture2D(groundMask, mUv) : vec4(0.0);
        float breakup = texture2D(map, vMapUv * 0.37 + 0.13).g;
        float macro = texture2D(map, vMapUv * 0.061).g + texture2D(dirtMap, vMapUv * 0.023).r;
        vec4 w = smoothstep(vec4(0.3), vec4(0.7), m + (breakup - 0.25) * vec4(0.8, 0.4, 0.15, 0.4));
        vec2 uvS = vMapUv * (3.0 / 3.2), uvP = vMapUv * 0.75, uvG = vMapUv * 1.5;
        vec3 albedo = texture2D(map, vMapUv).rgb * mix(0.78, 1.18, clamp(macro * 2.0, 0.0, 1.0));
        albedo = mix(albedo, texture2D(dirtMap, vMapUv).rgb, w.r);
        albedo = mix(albedo, texture2D(soilMap, uvS).rgb, w.g);
        albedo = mix(albedo, texture2D(gravelMap, uvG).rgb, w.a);
        albedo = mix(albedo, texture2D(pavingMap, uvP).rgb * mix(0.9, 1.08, breakup), w.b);
        diffuseColor.rgb *= albedo;`)
      .replace('roughnessFactor *= texelRoughness.g;', `roughnessFactor *= texelRoughness.g;
        roughnessFactor = mix(roughnessFactor, 0.95, max(w.r, w.g));
        roughnessFactor = mix(roughnessFactor, 0.85, max(w.b, w.a));`)
      .replace('vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;', `
        vec3 nC = texture2D(normalMap, vNormalMapUv).xyz;
        nC = mix(nC, texture2D(dirtNormal, vNormalMapUv).xyz, w.r);
        nC = mix(nC, texture2D(soilNormal, vNormalMapUv * (3.0 / 3.2)).xyz, w.g);
        nC = mix(nC, texture2D(gravelNormal, vNormalMapUv * 1.5).xyz, w.a);
        nC = mix(nC, texture2D(pavingNormal, vNormalMapUv * 0.75).xyz, w.b);
        vec3 mapN = nC * 2.0 - 1.0;`);
  };
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.name = 'Terrain';
  return mesh;
}

// ---------------------------------------------------------------- instanced grass
function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function bladeGeometry() {
  const BLADES = 7, SEGS = 4;
  const pos = [], nrm = [], col = [], idx = [];
  const rnd = mulberry32(42);
  for (let b = 0; b < BLADES; b++) {
    const a = rnd() * Math.PI * 2, ox = (rnd() - 0.5) * 0.35, oz = (rnd() - 0.5) * 0.35;
    const H = 0.28 + rnd() * 0.42, W = 0.035 + rnd() * 0.02, bend = 0.12 + rnd() * 0.25;
    const ca = Math.cos(a), sa = Math.sin(a);
    const base = pos.length / 3;
    for (let s = 0; s <= SEGS; s++) {
      const t = s / SEGS, w = W * (1 - t * 0.92), y = H * t, f = bend * t * t;
      for (const side of [-1, 1]) {
        pos.push(ox + ca * side * w - sa * f, y, oz + sa * side * w + ca * f);
        nrm.push(0, 1, 0);
        const c = 0.45 + 0.55 * t;
        col.push(0.16 * c + 0.1 * t, 0.26 * c + 0.06 * t, 0.07 * c);
      }
    }
    for (let s = 0; s < SEGS; s++) {
      const q = base + s * 2;
      idx.push(q, q + 1, q + 3, q, q + 3, q + 2);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  return geo;
}

export class Grass {
  constructor(scene, high, count) {
    this.count = count ?? (high ? 150000 : 40000);
    this.half = high ? 88 : 70;
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, side: THREE.DoubleSide });
    addWind(mat, 0.35, 2.0, true);
    this.mesh = new THREE.InstancedMesh(bladeGeometry(), mat, this.count);
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    scene.add(this.mesh);
  }
  /** blocked(x, z) -> true where something stands that clears grass. */
  rebuild(mask, blocked) {
    const rnd = mulberry32(7);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0), tint = new THREE.Color();
    const H = this.half;
    let n = 0;
    for (let tries = 0; n < this.count && tries < this.count * 3; tries++) {
      const x = (rnd() * 2 - 1) * H, z = (rnd() * 2 - 1) * H;
      const [dirt, soil, paving, gravel] = mask.sample(x, z);
      const bare = Math.max(dirt * 0.8, soil, paving, gravel);
      if (bare > 0.15 + rnd() * 0.3 || blocked(x, z)) continue;
      const edge = Math.max(Math.abs(x), Math.abs(z)) / H;
      if (edge > 0.8 && rnd() < (edge - 0.8) * 5) continue;
      p.set(x, terrainHeight(x, z) - 0.02, z);
      q.setFromAxisAngle(up, rnd() * Math.PI * 2);
      const sc = (0.7 + rnd() * 0.7) * (1 - bare);
      s.set(sc, sc * (0.8 + rnd() * 0.5), sc);
      this.mesh.setMatrixAt(n, m4.compose(p, q, s));
      const dry = Math.max(0, rnd() - 0.75) * 2.2;
      tint.setRGB(0.85 + 0.35 * dry + rnd() * 0.15, 0.9 + 0.2 * dry + rnd() * 0.15, 0.7 + rnd() * 0.25);
      this.mesh.setColorAt(n, tint);
      n++;
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}
