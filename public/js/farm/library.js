// Asset library (from assets.glb) and the placed objects, drawn with GPU instancing:
// every asset part is one InstancedMesh, each placed object owns one slot in it.
import * as THREE from 'three';
import { tuneMaterial } from './shaders.js';
import { terrainHeight } from './world.js';

const ROTOR = /_Rotor$/;

export class Library {
  constructor(gltf, renderer) {
    this.renderer = renderer;
    this.assets = new Map();
    this.layers = {};
    this.waterMaterials = new Set();
    for (const node of [...gltf.scene.children]) {
      if (node.name.startsWith('TexLayer_')) {
        this.layers[node.name.slice(9)] = node.material;
        continue;
      }
      const id = node.userData.asset;
      if (!id) continue;
      node.removeFromParent();
      node.position.set(0, 0, 0);
      node.rotation.set(0, 0, 0);
      node.scale.set(1, 1, 1);
      this.register(id, node, {
        label: node.userData.label || id, category: node.userData.category || 'Other', clearGrass: !!node.userData.clearGrass,
      });
    }
    this.builtinLabels = new Map([...this.assets.values()].map((a) => [a.id, a.label]));
  }

  /** Turn a template object (standing at the origin, front = +Z) into an instanceable asset. */
  register(id, node, meta) {
    node.updateMatrixWorld(true);
    const parts = [], rotors = [];
    node.traverse((o) => {
      if (ROTOR.test(o.name)) rotors.push(o);
      if (!o.isMesh) return;
      const role = tuneMaterial(o.material, this.renderer);
      if (role === 'water' && !this.waterMaterials.has(o.material)) {
        this.waterMaterials.add(o.material);
        if (o.material.normalMap) {
          o.material.normalMap.wrapS = o.material.normalMap.wrapT = THREE.RepeatWrapping;
          o.material.normalScale.set(0.25, 0.25);
        }
      }
      let rotor = null;
      for (let p = o; p && p !== node; p = p.parent) if (ROTOR.test(p.name)) rotor = p;
      parts.push({ geometry: o.geometry, material: o.material, node: o, rotor, matrix: o.matrixWorld.clone(),
        castShadow: role !== 'transparent' && role !== 'water' });
    });
    const box = new THREE.Box3().setFromObject(node);
    const asset = { id, template: node, parts, rotors, box, ...meta };
    this.assets.set(id, asset);
    return asset;
  }

  /**
   * Add a model uploaded in the editor (or listed in /farm/models/models.json). The model is
   * centred on the origin, set on the ground and scaled by entry.scale; using the id of a
   * built-in asset replaces it everywhere it is placed.
   */
  addModel(entry, gltf) {
    const inner = gltf.scene;
    inner.updateMatrixWorld(true);
    const b = new THREE.Box3().setFromObject(inner);
    const c = b.getCenter(new THREE.Vector3());
    inner.position.set(-c.x, -b.min.y, -c.z);
    const node = new THREE.Group();
    node.scale.setScalar(entry.scale || 1);
    node.add(inner);
    const wrapper = new THREE.Group();
    wrapper.add(node);
    const prev = this.assets.get(entry.id);
    const asset = this.register(entry.id, wrapper, {
      label: entry.label || prev?.label || entry.id,
      category: entry.category || prev?.category || 'My models',
      clearGrass: entry.clearGrass ?? prev?.clearGrass ?? true,
      custom: true,
    });
    const size = asset.box.getSize(new THREE.Vector3());
    asset.size = size;
    return asset;
  }

  categories() {
    const order = ['My models', 'Buildings', 'Hydroponics', 'Crops', 'Water', 'Energy & water', 'Livestock', 'Trees',
      'Walls & fences', 'Props'];
    const out = new Map(order.map((c) => [c, []]));
    for (const a of this.assets.values()) {
      if (!out.has(a.category)) out.set(a.category, []);
      out.get(a.category).push(a);
    }
    for (const [c, list] of out) if (!list.length) out.delete(c);
    return out;
  }
}

let uid = 1;
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

export class Farm {
  constructor(scene, library) {
    this.scene = scene;
    this.lib = library;
    this.objects = [];
    this.batches = new Map();
    this.pickables = [];
  }

  batch(assetId) {
    let b = this.batches.get(assetId);
    if (b) return b;
    const asset = this.lib.assets.get(assetId);
    b = { asset, slots: [], capacity: 0, meshes: [] };
    this.batches.set(assetId, b);
    this.grow(b, 8);
    return b;
  }

  grow(b, capacity) {
    const old = b.meshes;
    b.meshes = b.asset.parts.map((part, i) => {
      const mesh = new THREE.InstancedMesh(part.geometry, part.material, capacity);
      mesh.castShadow = part.castShadow;
      mesh.receiveShadow = true;
      mesh.userData.batch = b;
      if (old[i]) {
        mesh.instanceMatrix.array.set(old[i].instanceMatrix.array.subarray(0, b.capacity * 16));
        this.scene.remove(old[i]);
        old[i].dispose();
      }
      mesh.count = b.slots.length;
      this.scene.add(mesh);
      return mesh;
    });
    b.capacity = capacity;
    this.pickables = [...this.batches.values()].flatMap((x) => x.meshes);
  }

  static matrixOf(o, target = new THREE.Matrix4()) {
    _p.set(o.x, terrainHeight(o.x, o.z), o.z);
    _q.setFromAxisAngle(_up, THREE.MathUtils.degToRad(o.ry));
    _s.set(o.sx, o.sy, o.sz);
    return target.compose(_p, _q, _s);
  }

  write(b, slot) {
    const o = b.slots[slot];
    Farm.matrixOf(o, o.matrix);
    b.asset.parts.forEach((part, i) => {
      b.meshes[i].setMatrixAt(slot, _m.multiplyMatrices(o.matrix, part.matrix));
    });
    this.dirty(b);
  }

  dirty(b) {
    for (const mesh of b.meshes) {
      mesh.count = b.slots.length;
      mesh.instanceMatrix.needsUpdate = true;
      mesh.boundingSphere = null;
      mesh.boundingBox = null;
    }
  }

  /** Re-create the instanced meshes of an asset whose model was replaced, keeping its objects. */
  refreshAsset(id) {
    const b = this.batches.get(id);
    if (!b) return;
    for (const m of b.meshes) { this.scene.remove(m); m.dispose(); }
    this.batches.delete(id);
    for (const o of b.slots) this.attach(o);
    this.pickables = [...this.batches.values()].flatMap((x) => x.meshes);
  }

  attach(o) {
    const b = this.batch(o.asset);
    if (b.slots.length >= b.capacity) this.grow(b, b.capacity * 2);
    o.slot = b.slots.length;
    b.slots.push(o);
    this.write(b, o.slot);
  }

  add(rec) {
    if (!this.lib.assets.has(rec.asset)) return null;
    const o = {
      uid: uid++, asset: rec.asset, x: +rec.x || 0, z: +rec.z || 0, ry: +rec.ry || 0,
      sx: rec.sx ?? 1, sy: rec.sy ?? 1, sz: rec.sz ?? 1, matrix: new THREE.Matrix4(),
    };
    this.attach(o);
    this.objects.push(o);
    return o;
  }

  update(o) {
    this.write(this.batches.get(o.asset), o.slot);
  }

  remove(o) {
    const b = this.batches.get(o.asset);
    const last = b.slots.pop();
    if (last !== o) {
      last.slot = o.slot;
      b.slots[o.slot] = last;
      this.write(b, last.slot);
    }
    this.dirty(b);
    this.objects.splice(this.objects.indexOf(o), 1);
  }

  clear() {
    for (const b of this.batches.values()) {
      b.slots.length = 0;
      this.dirty(b);
    }
    this.objects.length = 0;
  }

  load(records) {
    this.clear();
    for (const r of records) this.add(r);
  }

  toJSON() {
    const r = (v) => Math.round(v * 1000) / 1000;
    return this.objects.map((o) => ({ asset: o.asset, x: r(o.x), z: r(o.z), ry: r(o.ry), sx: r(o.sx), sy: r(o.sy), sz: r(o.sz) }));
  }

  pick(raycaster) {
    const hits = raycaster.intersectObjects(this.pickables, false);
    for (const h of hits) {
      const b = h.object.userData.batch;
      if (b && h.instanceId !== undefined && b.slots[h.instanceId]) return b.slots[h.instanceId];
    }
    return null;
  }

  /** World-space oriented footprint test for grass clearing. */
  footprints() {
    const out = [];
    for (const o of this.objects) {
      const a = this.lib.assets.get(o.asset);
      if (!a.clearGrass) continue;
      const inv = new THREE.Matrix4().copy(o.matrix).invert();
      out.push({ inv, box: a.box, r: Math.hypot(a.box.max.x - a.box.min.x, a.box.max.z - a.box.min.z) * 0.5 * Math.max(o.sx, o.sz), x: o.x, z: o.z });
    }
    return out;
  }

  /** Spin rotors (windmill, wind turbine, pond aerators) on every placed copy. */
  animate(dt) {
    for (const b of this.batches.values()) {
      if (!b.asset.rotors.length || !b.slots.length) continue;
      for (const r of b.asset.rotors) r.rotateY(dt * (r.userData.spin ?? 2.2));
      b.asset.template.updateMatrixWorld(true);
      b.asset.parts.forEach((part, i) => {
        if (!part.rotor) return;
        part.matrix.copy(part.node.matrixWorld);
        const mesh = b.meshes[i];
        b.slots.forEach((o, slot) => mesh.setMatrixAt(slot, _m.multiplyMatrices(o.matrix, part.matrix)));
        mesh.instanceMatrix.needsUpdate = true;
      });
    }
  }
}
