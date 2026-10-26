// 3D farm: loads the asset library (/farm/assets.glb, built by tools/farm/build_farm.py),
// lays it out from the saved layout (/api/farm) or the built-in default, and offers an editor.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { wind } from './shaders.js';
import { createSky, createTerrain, createForest, GroundMask, Grass, terrainHeight } from './world.js';
import { Library, Farm } from './library.js';
import { defaultLayout, defaultZones, defaultDashboard } from './default-layout.js';
import { Hud } from './hud.js';

const params = new URLSearchParams(location.search);
const QUALITY = params.get('quality') || (matchMedia('(pointer: coarse)').matches ? 'low' : 'high');
const HIGH = QUALITY === 'high';
const STILL = params.has('still'); // render a few frames then stop (thumbnails, screenshots)

// ---------------------------------------------------------------- renderer, scene, camera
const renderer = new THREE.WebGLRenderer({ antialias: !HIGH, powerPreference: 'high-performance' });
// ?pr=0.5 lowers the resolution, ?grass=20000 the grass density (weak devices, testing)
const PR = Number(params.get('pr')) || Math.min(devicePixelRatio, HIGH ? 2 : 1.25);
renderer.setPixelRatio(PR);
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.62;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.prepend(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(42, innerWidth / innerHeight, 0.3, 4000);
camera.position.set(78, 68, 112);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0, 4);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI / 2 - 0.03;
controls.minDistance = 3;
controls.maxDistance = 320;
controls.autoRotateSpeed = 0.35;
const vec = (str) => {
  const v = (str || '').split(',').map(Number);
  return v.length === 3 && v.every(Number.isFinite) ? new THREE.Vector3(...v) : null;
};
if (vec(params.get('cam'))) camera.position.copy(vec(params.get('cam')));
if (vec(params.get('target'))) controls.target.copy(vec(params.get('target')));

const env = createSky(scene, renderer, HIGH);

// final colour grade: a touch of contrast and saturation, cool shadows, soft vignette
const GRADE = {
  uniforms: { tDiffuse: { value: null } },
  vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `
    uniform sampler2D tDiffuse; varying vec2 vUv;
    void main() {
      vec3 c = texture2D(tDiffuse, vUv).rgb;
      float l = dot(c, vec3(0.299, 0.587, 0.114));
      c = mix(vec3(l), c, 1.12);                       // saturation
      c = (c - 0.5) * 1.06 + 0.5;                      // contrast
      c += vec3(-0.012, 0.004, 0.016) * (1.0 - l);     // cool shadows
      vec2 q = vUv - 0.5;
      c *= 1.0 - dot(q, q) * 0.55;                     // vignette
      gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
    }`,
};
let composer = null;
if (HIGH) {
  const rt = new THREE.WebGLRenderTarget(innerWidth, innerHeight, { samples: 4, type: THREE.HalfFloatType });
  composer = new EffectComposer(renderer, rt);
  composer.setPixelRatio(Math.min(PR, 1.5));
  composer.addPass(new RenderPass(scene, camera));
  const gtao = new GTAOPass(scene, camera, innerWidth, innerHeight);
  gtao.updateGtaoMaterial({ radius: 0.6, distanceExponent: 1.5, thickness: 1.2, scale: 1.0 });
  gtao.blendIntensity = 0.85;
  composer.addPass(gtao);
  composer.addPass(new UnrealBloomPass(new THREE.Vector2(innerWidth / 2, innerHeight / 2), 0.16, 0.5, 0.92));
  composer.addPass(new OutputPass());
  composer.addPass(new ShaderPass(GRADE));
}

// ---------------------------------------------------------------- load
const loaderBar = document.getElementById('loaderBar');
const loaderText = document.getElementById('loaderText');
const mask = new GroundMask();
let lib = null, farm = null, grass = null, editor = null;

function rebuildGrass() {
  if (!grass) return;
  const cell = 0.5, half = grass.half, n = Math.ceil((2 * half) / cell);
  const blocked = new Uint8Array(n * n);
  const v = new THREE.Vector3();
  for (const f of farm.footprints()) {
    const b = f.box, r = f.r + 0.5;
    const i0 = Math.max(0, Math.floor((f.x - r + half) / cell)), i1 = Math.min(n - 1, Math.ceil((f.x + r + half) / cell));
    const j0 = Math.max(0, Math.floor((f.z - r + half) / cell)), j1 = Math.min(n - 1, Math.ceil((f.z + r + half) / cell));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const x = -half + (i + 0.5) * cell, z = -half + (j + 0.5) * cell;
        v.set(x, 0, z).applyMatrix4(f.inv);
        if (v.x > b.min.x - 0.2 && v.x < b.max.x + 0.2 && v.z > b.min.z - 0.2 && v.z < b.max.z + 0.2) blocked[j * n + i] = 1;
      }
    }
  }
  grass.rebuild(mask, (x, z) => {
    const i = Math.floor((x + half) / cell), j = Math.floor((z + half) / cell);
    return i >= 0 && j >= 0 && i < n && j < n && blocked[j * n + i] === 1;
  });
}

async function loadLayout() {
  try {
    const res = await fetch('/api/farm', { cache: 'no-store' });
    if (res.status === 200) return await res.json();
  } catch (err) {
    console.warn('layout fetch failed, using the default farm', err);
  }
  return null;
}

// Draco / KTX2 / meshopt so models exported from Blender, Sketchfab, etc. load as-is
const gltfLoader = new GLTFLoader()
  .setMeshoptDecoder(MeshoptDecoder)
  .setDRACOLoader(new DRACOLoader().setDecoderPath('/vendor/three/examples/jsm/libs/draco/gltf/'))
  .setKTX2Loader(new KTX2Loader().setTranscoderPath('/vendor/three/examples/jsm/libs/basis/').detectSupport(renderer));

/** Custom models: committed ones (public/farm/models/models.json) + ones uploaded in the editor. */
async function loadCustomModels() {
  const lists = await Promise.all([
    fetch('/farm/models/models.json').then((r) => (r.ok ? r.json() : [])).then((l) => l.map((m) => ({ ...m, url: `/farm/models/${m.file}` })), () => []),
    fetch('/api/farm/models', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : [])).then((l) => l.map((m) => ({ ...m, url: `/farm-models/${m.file}` })), () => []),
  ]);
  const entries = lists.flat();
  const loaded = await Promise.all(entries.map((m) => gltfLoader.loadAsync(m.url).then((g) => [m, g], (err) => {
    console.warn(`model ${m.label} (${m.url}) failed to load`, err);
    return null;
  })));
  return loaded.filter(Boolean);
}
const [gltf, saved, customModels] = await Promise.all([
  new Promise((resolve, reject) => gltfLoader.load('/farm/assets.glb', resolve, (e) => {
    if (e.total) loaderBar.style.width = `${(e.loaded / e.total) * 100}%`;
  }, reject)).catch((err) => {
    console.error(err);
    loaderText.textContent = 'Could not load the farm model.';
    throw err;
  }),
  loadLayout(),
  loadCustomModels(),
]);

lib = new Library(gltf, renderer);
for (const [entry, g] of customModels) lib.addModel(entry, g);
scene.add(createTerrain(lib.layers, mask));
createForest(scene, HIGH);
// water: share the ripple normal map, make it reflect the sky and clouds
const ripples = [...lib.waterMaterials].find((m) => m.normalMap)?.normalMap;
for (const m of lib.waterMaterials) {
  if (!m.normalMap && ripples) m.normalMap = ripples;
  m.normalScale?.set(0.3, 0.3);
  m.roughness = 0.02;
  m.envMapIntensity = 2.2;
  if (m.name === 'fish_water') { m.color.setRGB(0.05, 0.17, 0.18); m.opacity = 0.9; }
  m.needsUpdate = true;
}
farm = new Farm(scene, lib);
grass = new Grass(scene, HIGH, Number(params.get('grass')) || undefined);
if (saved && Array.isArray(saved.objects)) {
  farm.load(saved.objects);
  if (saved.ground) await mask.decode(saved.ground); else mask.clear();
} else {
  farm.load(defaultLayout(mask));
}
rebuildGrass();
env.setElevation(Number(document.getElementById('sun').value));

// ---------------------------------------------------------------- digital-twin overlay
const hud = new Hud({ camera, controls, renderer, overview: { cam: camera.position.clone(), target: controls.target.clone() } });
hud.setZones(saved && Array.isArray(saved.zones) ? saved.zones : defaultZones());
async function loadDashboard() {
  try {
    const res = await fetch('/api/farm/dashboard', { cache: 'no-store' });
    if (res.status === 200) return await res.json();
  } catch { /* offline: keep what we have */ }
  return null;
}
hud.setDashboard((await loadDashboard()) || defaultDashboard());
// live figures (e.g. pushed by sensors through PATCH /api/farm/dashboard)
setInterval(async () => {
  if (editor?.active) return;
  const d = await loadDashboard();
  if (d && d.updatedAt !== hud.dashboard?.updatedAt) hud.setDashboard(d);
}, 30000);
const hudBtn = document.getElementById('hudToggle');
let hudOn = !matchMedia('(max-width: 640px)').matches && params.get('hud') !== '0';
const applyHud = () => { hud.setVisible(hudOn); hudBtn.textContent = hudOn ? 'Hide dashboard' : 'Show dashboard'; };
hudBtn.addEventListener('click', () => { hudOn = !hudOn; applyHud(); });
applyHud();

const loader = document.getElementById('loader');
if (STILL) loader.remove(); else loader.classList.add('done');
window.__farmReady = true;

// ---------------------------------------------------------------- editor (admins, or ?edit to try it)
const editBtn = document.getElementById('edit');
async function canEdit() {
  if (params.has('edit')) return true;
  try {
    return (await fetch('/api/auth/me', { credentials: 'same-origin' })).ok;
  } catch {
    return false;
  }
}
if (await canEdit()) {
  editBtn.hidden = false;
  editBtn.addEventListener('click', async () => {
    if (!editor) {
      const { Editor } = await import('./editor.js');
      editor = new Editor({ scene, camera, renderer, controls, farm, lib, mask, rebuildGrass, gltfLoader, hud });
    }
    editor.setActive(!editor.active);
    editBtn.textContent = editor.active ? 'Exit editor' : 'Edit farm';
  });
  if (params.get('edit') === 'open') editBtn.click();
}

// ---------------------------------------------------------------- UI + loop
document.getElementById('sun').addEventListener('input', (e) => env.setElevation(Number(e.target.value)));
const spinBtn = document.getElementById('spin');
spinBtn.addEventListener('click', () => {
  controls.autoRotate = !controls.autoRotate;
  spinBtn.textContent = controls.autoRotate ? 'Stop rotating' : 'Auto-rotate';
});

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  composer?.setSize(innerWidth, innerHeight);
});

const clock = new THREE.Clock();
let framesAfterLoad = 0;
renderer.setAnimationLoop(() => {
  if (STILL && ++framesAfterLoad > 3) {
    renderer.setAnimationLoop(null);
    window.__farmStill = true;
    return;
  }
  const dt = Math.min(clock.getDelta(), 0.1);
  wind.uTime.value += dt;
  farm.animate(dt);
  for (const m of lib.waterMaterials) m.normalMap?.offset.set(wind.uTime.value * 0.004, wind.uTime.value * 0.006);
  hud.update(dt);
  controls.update();
  const minY = terrainHeight(camera.position.x, camera.position.z) + 1.2;
  if (camera.position.y < minY) camera.position.y = minY;
  env.follow(controls.target);
  env.update(dt, camera);
  if (composer) composer.render(); else renderer.render(scene, camera);
});
