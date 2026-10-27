// Animated characters (rigged .glb with Idle / Walk / Run / Work clips): they wander around the
// spot where they were placed, avoid buildings and water, and can be controlled by the visitor.
import * as THREE from 'three';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { terrainHeight, FLAT } from './world.js';

const WALK_SPEED = 1.25; // m/s matching the Walk clip's stride
const RUN_SPEED = 3.6;

export class Characters {
  constructor(scene, lib) {
    this.scene = scene;
    this.lib = lib;
    this.list = new Map(); // object uid -> character state
    this.blocked = () => false;
    this.paused = false; // editor: everyone stands at their spawn point
    this.player = null; // character under keyboard / touch control
    this.keys = new Set();
    this.touch = { x: 0, z: 0 };
  }

  // ------------------------------------------------------------------ lifecycle (called by Farm)
  attach(o) {
    const asset = this.lib.assets.get(o.asset);
    const node = SkeletonUtils.clone(asset.template);
    node.traverse((m) => {
      if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; m.frustumCulled = false; m.userData.charUid = o.uid; }
    });
    const mixer = new THREE.AnimationMixer(node);
    const actions = {};
    for (const clip of asset.animations) actions[clip.name.toLowerCase()] = mixer.clipAction(clip);
    const c = {
      o, asset, node, mixer, actions, current: null, pos: new THREE.Vector3(o.x, 0, o.z), heading: THREE.MathUtils.degToRad(o.ry),
      state: 'idle', timer: 1 + Math.random() * 3, target: null, rnd: mulberry32(o.uid * 7919),
    };
    this.list.set(o.uid, c);
    this.scene.add(node);
    this.play(c, 'idle', 0);
    c.mixer.update(Math.random() * 4); // desynchronise
    this.place(c);
  }

  update(o) {
    const c = this.list.get(o.uid);
    if (!c) return;
    c.pos.set(o.x, 0, o.z);
    c.heading = THREE.MathUtils.degToRad(o.ry);
    c.state = 'idle';
    c.timer = 2;
    this.place(c);
  }

  detach(o) {
    const c = this.list.get(o.uid);
    if (!c) return;
    if (this.player === c) this.release();
    c.mixer.stopAllAction();
    this.scene.remove(c.node);
    this.list.delete(o.uid);
  }

  clear() {
    for (const c of [...this.list.values()]) this.detach(c.o);
  }

  /** Swap the model of every character of this asset (e.g. a new upload). */
  refresh(id) {
    for (const c of [...this.list.values()]) {
      if (c.o.asset !== id) continue;
      this.detach(c.o);
      this.attach(c.o);
    }
  }

  pickHit(raycaster) {
    let best = null;
    for (const c of this.list.values()) {
      const hit = raycaster.intersectObject(c.node, true)[0];
      if (hit && (!best || hit.distance < best.distance)) best = { o: c.o, distance: hit.distance };
    }
    return best;
  }

  setPaused(p) {
    this.paused = p;
    if (p) {
      this.release();
      for (const c of this.list.values()) {
        c.pos.set(c.o.x, 0, c.o.z);
        c.heading = THREE.MathUtils.degToRad(c.o.ry);
        c.state = 'idle';
        this.play(c, 'idle');
        this.place(c);
      }
    }
  }

  // ------------------------------------------------------------------ animation helpers
  play(c, name, fade = 0.35) {
    const a = c.actions[name] || c.actions.idle || Object.values(c.actions)[0];
    if (!a || c.current === a) return;
    a.reset().setEffectiveWeight(1).fadeIn(fade).play();
    if (c.current) c.current.fadeOut(fade);
    c.current = a;
  }

  place(c) {
    const o = c.o;
    c.node.position.set(c.pos.x, terrainHeight(c.pos.x, c.pos.z), c.pos.z);
    c.node.rotation.set(0, c.heading, 0);
    c.node.scale.set(o.sx, o.sy, o.sz);
  }

  free(x, z, c) {
    if (Math.max(Math.abs(x), Math.abs(z)) > FLAT - 2) return false;
    // allow walking out of an obstacle if the character starts inside one
    return !this.blocked(x, z) || this.blocked(c.pos.x, c.pos.z);
  }

  pathClear(c, x, z) {
    const dx = x - c.pos.x, dz = z - c.pos.z, L = Math.hypot(dx, dz);
    for (let d = 0.5; d < L; d += 0.4) {
      if (!this.free(c.pos.x + (dx * d) / L, c.pos.z + (dz * d) / L, c)) return false;
    }
    return this.free(x, z, c);
  }

  // ------------------------------------------------------------------ behaviour
  think(c, dt) {
    const radius = c.asset.wander ?? 10;
    if (c.state === 'walk') {
      const dx = c.target.x - c.pos.x, dz = c.target.z - c.pos.z, L = Math.hypot(dx, dz);
      if (L < 0.15) {
        const r = c.rnd();
        c.state = r < 0.35 && c.actions.work ? 'work' : 'idle';
        c.timer = c.state === 'work' ? 5 + c.rnd() * 5 : 2 + c.rnd() * 4;
        this.play(c, c.state);
        return;
      }
      this.turnTowards(c, Math.atan2(dx, dz), dt);
      const step = Math.min(L, WALK_SPEED * dt);
      const nx = c.pos.x + (dx / L) * step, nz = c.pos.z + (dz / L) * step;
      if (!this.free(nx, nz, c)) { c.state = 'idle'; c.timer = 1; this.play(c, 'idle'); return; }
      c.pos.set(nx, 0, nz);
      return;
    }
    c.timer -= dt;
    if (c.timer > 0) return;
    for (let tries = 0; tries < 12; tries++) {
      const a = c.rnd() * Math.PI * 2, r = 2 + c.rnd() * radius;
      const x = c.o.x + Math.cos(a) * r, z = c.o.z + Math.sin(a) * r;
      if (this.pathClear(c, x, z)) {
        c.target = new THREE.Vector3(x, 0, z);
        c.state = 'walk';
        this.play(c, 'walk');
        if (c.current) c.current.timeScale = 1;
        return;
      }
    }
    c.timer = 2; // nowhere to go right now
  }

  turnTowards(c, want, dt, rate = 5) {
    let d = want - c.heading;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    c.heading += THREE.MathUtils.clamp(d, -rate * dt, rate * dt);
  }

  // ------------------------------------------------------------------ player control
  take(o) {
    const c = this.list.get(o.uid);
    if (!c) return null;
    this.player = c;
    c.state = 'player';
    return c;
  }

  release() {
    if (!this.player) return;
    const c = this.player;
    this.player = null;
    c.state = 'idle';
    c.timer = 3;
    this.play(c, 'idle');
  }

  drive(c, dt, camera) {
    const k = this.keys;
    let f = (k.has('w') || k.has('arrowup') ? 1 : 0) - (k.has('s') || k.has('arrowdown') ? 1 : 0) + this.touch.z;
    let s = (k.has('d') || k.has('arrowright') ? 1 : 0) - (k.has('a') || k.has('arrowleft') ? 1 : 0) + this.touch.x;
    const len = Math.hypot(f, s);
    if (len < 0.1) { this.play(c, 'idle', 0.2); return; }
    f /= Math.max(1, len); s /= Math.max(1, len);
    const fwd = new THREE.Vector3();
    camera.getWorldDirection(fwd);
    fwd.y = 0;
    fwd.normalize();
    const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
    const dir = fwd.multiplyScalar(f).add(right.multiplyScalar(s));
    const run = k.has('shift') || len > 1.4;
    const speed = (run ? RUN_SPEED : WALK_SPEED) * Math.min(1, dir.length());
    this.play(c, run && c.actions.run ? 'run' : 'walk', 0.2);
    this.turnTowards(c, Math.atan2(dir.x, dir.z), dt, 9);
    dir.normalize().multiplyScalar(speed * dt);
    // slide along obstacles
    if (this.free(c.pos.x + dir.x, c.pos.z + dir.z, c)) c.pos.add(dir);
    else if (this.free(c.pos.x + dir.x, c.pos.z, c)) c.pos.x += dir.x;
    else if (this.free(c.pos.x, c.pos.z + dir.z, c)) c.pos.z += dir.z;
  }

  tick(dt, camera) {
    for (const c of this.list.values()) {
      if (!this.paused) {
        if (c === this.player) this.drive(c, dt, camera);
        else this.think(c, dt);
      }
      this.place(c);
      c.mixer.update(dt);
    }
  }
}

function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
