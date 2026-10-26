// In-browser farm editor: place / move / rotate / scale / duplicate / delete assets,
// paint the ground (dirt, soil, paving, gravel, grass), undo/redo, save (admin), import/export.
import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { terrainHeight, LAYERS } from './world.js';
import { defaultLayout } from './default-layout.js';

const LAYER_LABELS = { grass: 'Grass', dirt: 'Dirt / mulch', soil: 'Plowed soil', paving: 'Road (asphalt)', gravel: 'Gravel' };
const LAYER_SWATCH = { grass: '#5d7d2c', dirt: '#7a6247', soil: '#4a3526', paving: '#3a3b3d', gravel: '#a39a8a' };

const el = (tag, attrs = {}, ...children) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null) e.append(c);
  return e;
};

export class Editor {
  constructor(ctx) {
    Object.assign(this, ctx); // { scene, camera, renderer, controls, farm, lib, mask, rebuildGrass, canSave }
    this.active = false;
    this.tool = 'select';
    this.selection = new Set();
    this.undoStack = [];
    this.redoStack = [];
    this.snap = true;
    this.dirtyFlag = false;
    this.brush = { layer: 'paving', size: 3, strength: 0.8, hardness: 0.6 };
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.maskSnapshot = this.mask.data.slice();

    this.pivot = new THREE.Object3D();
    this.scene.add(this.pivot);
    this.gizmo = new TransformControls(this.camera, this.renderer.domElement);
    this.gizmo.attach(this.pivot);
    this.gizmo.enabled = false;
    this.gizmoHelper = this.gizmo.getHelper();
    this.gizmoHelper.visible = false;
    this.scene.add(this.gizmoHelper);
    this.gizmo.addEventListener('dragging-changed', (e) => { this.controls.enabled = !e.value; });
    this.gizmo.addEventListener('mouseDown', () => this.beginTransform());
    this.gizmo.addEventListener('objectChange', () => this.applyTransform());
    this.gizmo.addEventListener('mouseUp', () => this.rebuildGrassSoon());
    this.setTransformMode('translate');

    this.boxes = new THREE.Group();
    this.scene.add(this.boxes);
    this.boxGeo = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));
    this.boxMat = new THREE.LineBasicMaterial({ color: 0xffc23d, depthTest: false, transparent: true });

    const ring = new THREE.Mesh(new THREE.RingGeometry(0.94, 1, 64), new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true, opacity: 0.85 }));
    ring.rotation.x = -Math.PI / 2;
    ring.renderOrder = 10;
    this.brushRing = new THREE.Group();
    this.brushRing.add(ring);
    this.brushRing.visible = false;
    this.scene.add(this.brushRing);

    this.buildUI();
    this.bindInput();
  }

  // ------------------------------------------------------------------ UI
  buildUI() {
    const tb = (label, title, onclick, cls = '') => el('button', { type: 'button', class: `tb ${cls}`, title, onclick }, label);
    this.ui = {};
    this.ui.tools = {
      select: tb('Select', 'Select & move objects (V)', () => this.setTool('select')),
      paint: tb('Paint ground', 'Paint roads, soil, gravel… (B)', () => this.setTool('paint')),
    };
    this.ui.modes = {
      translate: tb('Move', 'Move (W)', () => this.setTransformMode('translate')),
      rotate: tb('Rotate', 'Rotate (E)', () => this.setTransformMode('rotate')),
      scale: tb('Scale', 'Scale (R)', () => this.setTransformMode('scale')),
    };
    this.ui.snap = el('label', { class: 'tb-check', title: 'Snap to 0.5 m / 15°' },
      el('input', { type: 'checkbox', checked: true, onchange: (e) => this.setSnap(e.target.checked) }), 'Snap');
    this.ui.undo = tb('↶', 'Undo (Ctrl+Z)', () => this.undo());
    this.ui.redo = tb('↷', 'Redo (Ctrl+Shift+Z)', () => this.redo());
    this.ui.save = tb('Save', 'Save the layout for everyone (admin)', () => this.save(), 'primary');
    this.ui.menu = el('details', { class: 'tb-menu' },
      el('summary', { class: 'tb' }, 'More ▾'),
      el('div', { class: 'menu' },
        el('button', { type: 'button', onclick: () => this.exportJSON() }, 'Export layout (.json)'),
        el('button', { type: 'button', onclick: () => this.importInput.click() }, 'Import layout…'),
        el('button', { type: 'button', onclick: () => this.resetDefault() }, 'Reset to the default farm'),
        el('button', { type: 'button', onclick: () => this.clearAll() }, 'Clear everything'),
        el('button', { type: 'button', onclick: () => this.setActive(false) }, 'Exit editor')));
    this.importInput = el('input', { type: 'file', accept: '.json,application/json', hidden: true, onchange: (e) => this.importJSON(e.target.files[0]) });

    this.ui.toolbar = el('div', { class: 'editor-toolbar' },
      el('div', { class: 'group' }, Object.values(this.ui.tools)),
      el('div', { class: 'group' }, Object.values(this.ui.modes), this.ui.snap),
      el('div', { class: 'group' }, this.ui.undo, this.ui.redo),
      el('div', { class: 'group' }, this.ui.save, this.ui.menu), this.importInput);

    // palette
    const search = el('input', { type: 'search', placeholder: 'Search objects…', class: 'search', oninput: (e) => this.filterPalette(e.target.value) });
    const cats = [];
    for (const [cat, assets] of this.lib.categories()) {
      cats.push(el('details', { class: 'cat', open: true },
        el('summary', {}, cat),
        el('div', { class: 'items' }, assets.map((a) => el('button', { type: 'button', class: 'item', 'data-label': a.label.toLowerCase(),
          title: `Place: ${a.label}`, onclick: () => this.startPlacing(a.id) }, a.label)))));
    }
    this.ui.palette = el('aside', { class: 'editor-panel palette' }, el('h3', {}, 'Add to the farm'), search, el('div', { class: 'cats' }, cats),
      el('p', { class: 'help' }, 'Click an item, then click the ground to place it. R rotates, Shift+click keeps placing, Esc cancels.'));

    this.ui.props = el('aside', { class: 'editor-panel props' });
    this.ui.status = el('div', { class: 'editor-status' });
    document.body.append(this.ui.toolbar, this.ui.palette, this.ui.props, this.ui.status);
    this.refreshPanels();
  }

  filterPalette(q) {
    q = q.trim().toLowerCase();
    for (const b of this.ui.palette.querySelectorAll('.item')) b.hidden = q && !b.dataset.label.includes(q);
    for (const d of this.ui.palette.querySelectorAll('.cat')) {
      d.hidden = [...d.querySelectorAll('.item')].every((b) => b.hidden);
      if (q) d.open = true;
    }
  }

  setActive(on) {
    this.active = on;
    document.body.classList.toggle('editing', on);
    if (!on) {
      this.cancelPlacing();
      this.clearSelection();
      this.setTool('select');
    }
    this.refreshPanels();
  }

  status(msg, kind = '') {
    this.ui.status.textContent = msg;
    this.ui.status.className = `editor-status show ${kind}`;
    clearTimeout(this.statusTimer);
    this.statusTimer = setTimeout(() => this.ui.status.classList.remove('show'), kind === 'error' ? 8000 : 3000);
  }

  setTool(tool) {
    if (tool !== 'place') this.cancelPlacing();
    this.tool = tool;
    for (const [k, b] of Object.entries(this.ui.tools)) b.classList.toggle('on', k === tool);
    this.brushRing.visible = false;
    this.controls.mouseButtons.LEFT = tool === 'paint' ? null : THREE.MOUSE.ROTATE;
    this.controls.mouseButtons.RIGHT = tool === 'paint' ? THREE.MOUSE.ROTATE : THREE.MOUSE.PAN;
    if (tool === 'paint') this.clearSelection();
    this.refreshPanels();
  }

  setTransformMode(mode) {
    this.gizmo.setMode(mode);
    this.gizmo.setSpace(mode === 'scale' ? 'local' : 'world');
    this.gizmo.showX = mode !== 'rotate';
    this.gizmo.showZ = mode !== 'rotate';
    this.gizmo.showY = mode !== 'translate';
    for (const [k, b] of Object.entries(this.ui?.modes || {})) b.classList.toggle('on', k === mode);
    this.setSnap(this.snap);
    this.updatePivot();
  }

  setSnap(on) {
    this.snap = on;
    this.gizmo.setTranslationSnap(on ? 0.5 : null);
    this.gizmo.setRotationSnap(on ? THREE.MathUtils.degToRad(15) : null);
    this.gizmo.setScaleSnap(on ? 0.05 : null);
  }

  refreshPanels() {
    const p = this.ui.props;
    p.replaceChildren();
    this.ui.undo.disabled = !this.undoStack.length;
    this.ui.redo.disabled = !this.redoStack.length;
    if (this.tool === 'paint') {
      p.append(el('h3', {}, 'Paint the ground'),
        el('div', { class: 'swatches' }, LAYERS.map((l) => el('button', { type: 'button', class: `swatch ${this.brush.layer === l ? 'on' : ''}`,
          onclick: () => { this.brush.layer = l; this.refreshPanels(); } }, el('i', { style: `background:${LAYER_SWATCH[l]}` }), LAYER_LABELS[l]))),
        this.slider('Brush size (m)', 'size', 0.5, 15, 0.5),
        this.slider('Strength', 'strength', 0.05, 1, 0.05),
        this.slider('Hardness', 'hardness', 0, 0.95, 0.05),
        el('p', { class: 'help' }, 'Left-drag paints. Right-drag orbits, wheel zooms. Paint "Grass" to erase.'));
      return;
    }
    const sel = [...this.selection];
    if (!sel.length) {
      p.append(el('h3', {}, 'Selection'), el('p', { class: 'help' },
        'Click an object to select it, Shift+click to add more. Drag the arrows to move. ',
        'Keys: W move · E rotate · R scale · Ctrl+D duplicate · Del delete · Ctrl+Z undo.'),
        el('p', { class: 'help' }, `${this.farm.objects.length} objects on the farm.`));
      return;
    }
    const first = sel[0];
    const label = this.lib.assets.get(first.asset).label;
    p.append(el('h3', {}, sel.length === 1 ? label : `${sel.length} objects selected`));
    if (sel.length === 1) {
      const field = (name, key, step, fmt = (v) => v) => el('label', { class: 'field' }, name,
        el('input', { type: 'number', step, value: fmt(first[key]).toFixed(2), onchange: (e) => {
          this.checkpoint();
          const v = parseFloat(e.target.value);
          if (!Number.isFinite(v)) return;
          if (key === 'scale') { first.sx = first.sy = first.sz = Math.max(0.05, v); } else first[key] = v;
          this.farm.update(first);
          this.afterChange();
        } }));
      p.append(el('div', { class: 'fields' },
        field('X (m)', 'x', 0.5), field('Z (m)', 'z', 0.5), field('Rotation (°)', 'ry', 15),
        field('Scale', 'scale', 0.05, () => first.sx)));
    }
    const arrayCount = el('input', { type: 'number', min: 1, max: 50, value: 4 });
    const arraySpacing = el('input', { type: 'number', step: 0.5, value: this.suggestSpacing(first) });
    p.append(el('div', { class: 'actions' },
      el('button', { type: 'button', onclick: () => this.duplicate() }, 'Duplicate'),
      el('button', { type: 'button', class: 'danger', onclick: () => this.deleteSelection() }, 'Delete'),
      el('button', { type: 'button', onclick: () => this.selectSameType() }, `Select all “${label}”`)),
    el('div', { class: 'array' }, el('h4', {}, 'Repeat in a row'),
      el('label', { class: 'field' }, 'Copies', arrayCount),
      el('label', { class: 'field' }, 'Spacing (m)', arraySpacing),
      el('div', { class: 'actions' },
        el('button', { type: 'button', onclick: () => this.repeat(+arrayCount.value, +arraySpacing.value, 'x') }, 'Along width →'),
        el('button', { type: 'button', onclick: () => this.repeat(+arrayCount.value, +arraySpacing.value, 'z') }, 'Along depth ↓'))));
  }

  slider(label, key, min, max, step) {
    const out = el('output', {}, String(this.brush[key]));
    return el('label', { class: 'field slider' }, label, el('input', { type: 'range', min, max, step, value: this.brush[key],
      oninput: (e) => { this.brush[key] = +e.target.value; out.textContent = e.target.value; } }), out);
  }

  suggestSpacing(o) {
    const b = this.lib.assets.get(o.asset).box;
    return Math.round((Math.max(b.max.x - b.min.x, 0.5) * o.sx + 0.5) * 2) / 2;
  }

  // ------------------------------------------------------------------ history
  state() {
    return { objects: JSON.stringify(this.farm.toJSON()), mask: this.maskSnapshot };
  }

  checkpoint() {
    this.undoStack.push(this.state());
    if (this.undoStack.length > 60) this.undoStack.shift();
    this.redoStack.length = 0;
    this.markDirty();
  }

  restore(s) {
    this.clearSelection();
    this.farm.load(JSON.parse(s.objects));
    if (s.mask !== this.maskSnapshot) {
      this.mask.data.set(s.mask);
      this.mask.texture.needsUpdate = true;
      this.maskSnapshot = s.mask;
    }
    this.markDirty();
    this.rebuildGrassSoon();
  }

  undo() {
    if (!this.undoStack.length) return;
    this.redoStack.push(this.state());
    this.restore(this.undoStack.pop());
  }

  redo() {
    if (!this.redoStack.length) return;
    this.undoStack.push(this.state());
    this.restore(this.redoStack.pop());
  }

  markDirty() {
    this.dirtyFlag = true;
    this.ui.save.classList.add('pending');
    this.refreshPanels();
  }

  afterChange() {
    this.updateBoxes();
    this.updatePivot();
    this.rebuildGrassSoon();
    this.refreshPanels();
  }

  rebuildGrassSoon() {
    clearTimeout(this.grassTimer);
    this.grassTimer = setTimeout(() => this.rebuildGrass(), 250);
  }

  // ------------------------------------------------------------------ selection
  select(o, additive = false) {
    if (!additive) this.selection.clear();
    if (o) {
      if (additive && this.selection.has(o)) this.selection.delete(o);
      else this.selection.add(o);
    }
    this.afterSelect();
  }

  clearSelection() {
    this.selection.clear();
    this.afterSelect();
  }

  afterSelect() {
    const any = this.selection.size > 0 && this.tool === 'select';
    this.gizmo.enabled = any;
    this.gizmoHelper.visible = any;
    this.updateBoxes();
    this.updatePivot();
    this.refreshPanels();
  }

  selectSameType() {
    const first = [...this.selection][0];
    if (!first) return;
    this.selection = new Set(this.farm.objects.filter((o) => o.asset === first.asset));
    this.afterSelect();
  }

  updateBoxes() {
    this.boxes.clear();
    for (const o of this.selection) {
      const b = this.lib.assets.get(o.asset).box;
      const size = b.getSize(new THREE.Vector3()), center = b.getCenter(new THREE.Vector3());
      const line = new THREE.LineSegments(this.boxGeo, this.boxMat);
      line.matrixAutoUpdate = false;
      line.matrix.copy(o.matrix).multiply(new THREE.Matrix4().compose(center, new THREE.Quaternion(), size.addScalar(0.1)));
      line.renderOrder = 9;
      this.boxes.add(line);
    }
  }

  updatePivot() {
    const sel = [...this.selection];
    if (!sel.length) return;
    let x = 0, z = 0;
    for (const o of sel) { x += o.x; z += o.z; }
    x /= sel.length; z /= sel.length;
    this.pivot.position.set(x, terrainHeight(x, z), z);
    this.pivot.rotation.set(0, sel.length === 1 && this.gizmo.getMode() === 'scale' ? THREE.MathUtils.degToRad(sel[0].ry) : 0, 0);
    this.pivot.scale.set(1, 1, 1);
    this.pivot.updateMatrixWorld();
  }

  beginTransform() {
    this.checkpoint();
    this.dragStart = {
      pos: this.pivot.position.clone(), rot: this.pivot.rotation.y,
      objs: [...this.selection].map((o) => ({ o, x: o.x, z: o.z, ry: o.ry, sx: o.sx, sy: o.sy, sz: o.sz })),
    };
  }

  applyTransform() {
    const s = this.dragStart;
    if (!s) return;
    const mode = this.gizmo.getMode();
    const p = this.pivot;
    if (mode === 'translate') {
      p.position.y = s.pos.y;
      const dx = p.position.x - s.pos.x, dz = p.position.z - s.pos.z;
      for (const r of s.objs) { r.o.x = r.x + dx; r.o.z = r.z + dz; }
    } else if (mode === 'rotate') {
      const e = new THREE.Euler().setFromQuaternion(p.quaternion, 'YXZ');
      const d = e.y - s.rot;
      const c = Math.cos(d), sn = Math.sin(d);
      for (const r of s.objs) {
        const lx = r.x - s.pos.x, lz = r.z - s.pos.z;
        r.o.x = s.pos.x + lx * c + lz * sn;
        r.o.z = s.pos.z - lx * sn + lz * c;
        r.o.ry = r.ry + THREE.MathUtils.radToDeg(d);
      }
    } else {
      const k = p.scale;
      const uniform = s.objs.length > 1;
      for (const r of s.objs) {
        if (uniform) {
          const f = Math.max(k.x, k.y, k.z) !== 1 ? Math.max(k.x, k.y, k.z) : Math.min(k.x, k.y, k.z);
          r.o.sx = r.sx * f; r.o.sy = r.sy * f; r.o.sz = r.sz * f;
          r.o.x = s.pos.x + (r.x - s.pos.x) * f;
          r.o.z = s.pos.z + (r.z - s.pos.z) * f;
        } else {
          r.o.sx = Math.max(0.05, r.sx * k.x); r.o.sy = Math.max(0.05, r.sy * k.y); r.o.sz = Math.max(0.05, r.sz * k.z);
        }
      }
    }
    for (const r of s.objs) this.farm.update(r.o);
    this.updateBoxes();
    this.refreshPanelsSoon();
  }

  refreshPanelsSoon() {
    if (this.panelRaf) return;
    this.panelRaf = requestAnimationFrame(() => { this.panelRaf = 0; this.refreshPanels(); });
  }

  duplicate() {
    const sel = [...this.selection];
    if (!sel.length) return;
    this.checkpoint();
    const off = this.snap ? 2 : 1.5;
    const copies = sel.map((o) => this.farm.add({ ...o, x: o.x + off, z: o.z + off }));
    this.selection = new Set(copies.filter(Boolean));
    this.afterSelect();
    this.rebuildGrassSoon();
  }

  repeat(count, spacing, axis) {
    const sel = [...this.selection];
    if (!sel.length || !(count >= 1) || !Number.isFinite(spacing)) return;
    this.checkpoint();
    const added = [];
    for (const o of sel) {
      const a = THREE.MathUtils.degToRad(o.ry);
      const dir = axis === 'x' ? [Math.cos(a), -Math.sin(a)] : [Math.sin(a), Math.cos(a)];
      for (let i = 1; i <= Math.min(count, 50); i++) {
        added.push(this.farm.add({ ...o, x: o.x + dir[0] * spacing * i, z: o.z + dir[1] * spacing * i }));
      }
    }
    this.status(`Added ${added.length} copies`);
    this.selection = new Set([...sel, ...added.filter(Boolean)]);
    this.afterSelect();
    this.rebuildGrassSoon();
  }

  deleteSelection() {
    if (!this.selection.size) return;
    this.checkpoint();
    for (const o of this.selection) this.farm.remove(o);
    this.clearSelection();
    this.rebuildGrassSoon();
  }

  // ------------------------------------------------------------------ placing
  startPlacing(assetId) {
    this.cancelPlacing();
    this.setTool('place');
    const a = this.lib.assets.get(assetId);
    this.ghost = { asset: assetId, ry: 0, obj: a.template.clone(true) };
    this.ghost.obj.traverse((m) => { if (m.isMesh) { m.castShadow = true; } });
    this.ghost.obj.visible = false;
    this.scene.add(this.ghost.obj);
    this.clearSelection();
    this.status(`Placing “${a.label}”: click the ground (R = rotate, Shift = keep placing, Esc = cancel)`);
  }

  cancelPlacing() {
    if (!this.ghost) return;
    this.scene.remove(this.ghost.obj);
    this.ghost = null;
    if (this.tool === 'place') this.tool = 'select';
  }

  moveGhost(pt) {
    if (!this.ghost || !pt) return;
    const g = this.ghost;
    const x = this.snap ? Math.round(pt.x * 2) / 2 : pt.x, z = this.snap ? Math.round(pt.z * 2) / 2 : pt.z;
    g.x = x; g.z = z;
    g.obj.position.set(x, terrainHeight(x, z), z);
    g.obj.rotation.set(0, THREE.MathUtils.degToRad(g.ry), 0);
    g.obj.visible = true;
  }

  placeGhost(keep) {
    const g = this.ghost;
    if (!g || g.x === undefined) return;
    this.checkpoint();
    const o = this.farm.add({ asset: g.asset, x: g.x, z: g.z, ry: g.ry });
    this.rebuildGrassSoon();
    if (!keep) {
      this.cancelPlacing();
      this.setTool('select');
      this.select(o);
    }
  }

  // ------------------------------------------------------------------ painting
  paintAt(pt) {
    const b = this.brush;
    this.mask.dab(pt.x, pt.z, b.size, LAYERS.indexOf(b.layer), b.strength * 0.5, b.hardness);
  }

  strokeTo(pt) {
    const last = this.lastDab;
    const step = Math.max(0.2, this.brush.size * 0.3);
    if (!last) { this.paintAt(pt); this.lastDab = pt.clone(); return; }
    const d = last.distanceTo(pt);
    if (d < step) return;
    const n = Math.floor(d / step);
    for (let i = 1; i <= n; i++) this.paintAt(last.clone().lerp(pt, i / n));
    this.lastDab = pt.clone();
  }

  // ------------------------------------------------------------------ input
  groundPoint(event) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const ray = this.raycaster.ray;
    let y = 0;
    const pt = new THREE.Vector3();
    for (let i = 0; i < 4; i++) { // refine against the (mostly flat) terrain height
      if (!ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -y), pt)) return null;
      y = terrainHeight(pt.x, pt.z);
    }
    return pt;
  }

  bindInput() {
    const dom = this.renderer.domElement;
    let down = null;
    dom.addEventListener('pointerdown', (e) => {
      if (!this.active) return;
      down = { x: e.clientX, y: e.clientY, button: e.button };
      if (this.tool === 'paint' && e.button === 0) {
        const pt = this.groundPoint(e);
        if (!pt) return;
        this.checkpoint();
        this.painting = true;
        this.lastDab = null;
        this.strokeTo(pt);
        dom.setPointerCapture(e.pointerId);
      }
    });
    dom.addEventListener('pointermove', (e) => {
      if (!this.active) return;
      if (this.tool === 'paint') {
        const pt = this.groundPoint(e);
        if (!pt) return;
        this.brushRing.visible = true;
        this.brushRing.position.set(pt.x, pt.y + 0.05, pt.z);
        this.brushRing.scale.setScalar(this.brush.size);
        if (this.painting) this.strokeTo(pt);
      } else if (this.tool === 'place') {
        this.moveGhost(this.groundPoint(e));
      }
    });
    dom.addEventListener('pointerleave', () => { this.brushRing.visible = false; });
    dom.addEventListener('pointerup', (e) => {
      if (!this.active) return;
      if (this.painting) {
        this.painting = false;
        this.maskSnapshot = this.mask.data.slice();
        this.rebuildGrassSoon();
        return;
      }
      if (!down || e.button !== 0 || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return;
      if (this.gizmo.dragging || this.gizmo.axis) return;
      if (this.tool === 'place') { this.moveGhost(this.groundPoint(e)); this.placeGhost(e.shiftKey); return; }
      if (this.tool !== 'select') return;
      this.groundPoint(e);
      const o = this.farm.pick(this.raycaster);
      if (o) this.select(o, e.shiftKey || e.ctrlKey || e.metaKey);
      else if (!e.shiftKey) this.clearSelection();
    });

    addEventListener('keydown', (e) => {
      if (!this.active || e.target.closest?.('input, textarea, select')) return;
      const k = e.key.toLowerCase();
      const mod = e.ctrlKey || e.metaKey;
      if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? this.redo() : this.undo(); }
      else if (mod && k === 'y') { e.preventDefault(); this.redo(); }
      else if (mod && k === 'd') { e.preventDefault(); this.duplicate(); }
      else if (mod && k === 's') { e.preventDefault(); this.save(); }
      else if (mod && k === 'a') { e.preventDefault(); this.selection = new Set(this.farm.objects); this.afterSelect(); }
      else if (k === 'delete' || k === 'backspace') { e.preventDefault(); this.deleteSelection(); }
      else if (k === 'escape') { this.cancelPlacing(); this.setTool('select'); this.clearSelection(); }
      else if (this.tool === 'place' && k === 'r') { this.ghost.ry = (this.ghost.ry + (e.shiftKey ? 90 : 15)) % 360; this.ghost.obj.rotation.y = THREE.MathUtils.degToRad(this.ghost.ry); }
      else if (k === 'w') this.setTransformMode('translate');
      else if (k === 'e') this.setTransformMode('rotate');
      else if (k === 'r') this.setTransformMode('scale');
      else if (k === 'b') this.setTool('paint');
      else if (k === 'v') this.setTool('select');
    });
    addEventListener('beforeunload', (e) => {
      if (this.dirtyFlag) { e.preventDefault(); e.returnValue = ''; }
    });
  }

  // ------------------------------------------------------------------ persistence
  async payload() {
    return { version: 1, objects: this.farm.toJSON(), ground: await this.mask.encode() };
  }

  async save() {
    this.ui.save.disabled = true;
    try {
      const res = await fetch('/api/admin/farm', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
        body: JSON.stringify(await this.payload()),
      });
      if (res.status === 401) {
        this.status('Log in as admin to save: open /admin in another tab, log in, then press Save again.', 'error');
        window.open('/admin', '_blank', 'noopener');
        return;
      }
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
      this.dirtyFlag = false;
      this.ui.save.classList.remove('pending');
      this.status('Saved. Everyone now sees this layout.', 'ok');
    } catch (err) {
      this.status(`Save failed: ${err.message}`, 'error');
    } finally {
      this.ui.save.disabled = false;
    }
  }

  async exportJSON() {
    const blob = new Blob([JSON.stringify(await this.payload())], { type: 'application/json' });
    const a = el('a', { href: URL.createObjectURL(blob), download: 'farm-layout.json' });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  async importJSON(file) {
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!Array.isArray(data.objects)) throw new Error('not a farm layout');
      this.checkpoint();
      this.farm.load(data.objects);
      if (data.ground) await this.mask.decode(data.ground);
      this.maskSnapshot = this.mask.data.slice();
      this.clearSelection();
      this.rebuildGrassSoon();
      this.status(`Imported ${this.farm.objects.length} objects`, 'ok');
    } catch (err) {
      this.status(`Import failed: ${err.message}`, 'error');
    }
    this.importInput.value = '';
  }

  resetDefault() {
    if (!confirm('Replace the current layout with the default farm? (You can undo.)')) return;
    this.checkpoint();
    this.farm.load(defaultLayout(this.mask));
    this.maskSnapshot = this.mask.data.slice();
    this.clearSelection();
    this.rebuildGrassSoon();
  }

  clearAll() {
    if (!confirm('Remove every object and all ground paint? (You can undo.)')) return;
    this.checkpoint();
    this.farm.clear();
    this.mask.clear();
    this.maskSnapshot = this.mask.data.slice();
    this.clearSelection();
    this.rebuildGrassSoon();
  }
}

