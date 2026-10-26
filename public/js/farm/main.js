// 3D farm: loads the asset library (/farm/assets.glb, built by tools/farm/build_farm.py),
// lays it out from the saved layout (/api/farm) or the built-in default, and offers an editor.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { wind } from './shaders.js';
import { createSky, createTerrain, GroundMask, Grass, terrainHeight } from './world.js';
import { Library, Farm } from './library.js';
import { defaultLayout } from './default-layout.js';

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
  composer.addPass(new OutputPass());
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

const gltfLoader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
const [gltf, saved] = await Promise.all([
  new Promise((resolve, reject) => gltfLoader.load('/farm/assets.glb', resolve, (e) => {
    if (e.total) loaderBar.style.width = `${(e.loaded / e.total) * 100}%`;
  }, reject)).catch((err) => {
    console.error(err);
    loaderText.textContent = 'Could not load the farm model.';
    throw err;
  }),
  loadLayout(),
]);

lib = new Library(gltf, renderer);
scene.add(createTerrain(lib.layers, mask));
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
      editor = new Editor({ scene, camera, renderer, controls, farm, lib, mask, rebuildGrass });
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
  controls.update();
  const minY = terrainHeight(camera.position.x, camera.position.z) + 1.2;
  if (camera.position.y < minY) camera.position.y = minY;
  env.follow(controls.target);
  if (composer) composer.render(); else renderer.render(scene, camera);
});
