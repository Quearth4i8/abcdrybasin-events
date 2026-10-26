// "Digital twin" overlay: zone markers floating over the 3D farm, zone tabs with camera flights,
// a guided tour, and dashboard panels (weather, gauges, KPIs, sensor bars).
import * as THREE from 'three';

const el = (tag, attrs = {}, ...children) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'style') e.style.cssText = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null) e.append(c);
  return e;
};
const fmt = (v, d = 0) => Number(v || 0).toLocaleString('en-GB', { maximumFractionDigits: d, minimumFractionDigits: 0 });
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

export class Hud {
  constructor({ camera, controls, renderer, overview }) {
    this.camera = camera;
    this.controls = controls;
    this.renderer = renderer;
    this.overview = overview; // { cam: Vector3, target: Vector3 }
    this.zones = [];
    this.dashboard = null;
    this.flight = null;
    this.tour = null;
    this.selected = -1;
    this.onMarkerClick = (i) => this.focusZone(i);

    this.markersEl = el('div', { class: 'hud-markers' });
    this.tabsEl = el('nav', { class: 'hud-tabs' });
    this.leftEl = el('aside', { class: 'hud-panel hud-left' });
    this.rightEl = el('aside', { class: 'hud-panel hud-right' });
    this.sensorsEl = el('aside', { class: 'hud-panel hud-sensors' });
    document.body.append(this.markersEl, this.tabsEl, this.leftEl, this.rightEl, this.sensorsEl);
    controls.addEventListener('start', () => { this.flight = null; this.stopTour(); });
    this.clockTimer = setInterval(() => this.renderClock(), 1000);
  }

  // ------------------------------------------------------------------ zones, markers, tabs
  setZones(zones) {
    this.zones = zones;
    this.selected = Math.min(this.selected, zones.length - 1);
    this.markers = zones.map((z, i) => {
      const m = el('button', { type: 'button', class: 'hud-marker', title: z.name, onclick: () => this.onMarkerClick(i) },
        el('span', { class: 'pin' }, z.icon || '📍'), el('span', { class: 'name' }, z.name), el('i', { class: 'stem' }));
      return m;
    });
    this.markersEl.replaceChildren(...this.markers);
    fill(this.tabsEl,
      el('button', { type: 'button', class: 'tab tour', onclick: () => (this.tour ? this.stopTour() : this.startTour()) },
        this.tour ? '■ Stop tour' : '▶ Guided tour'),
      el('button', { type: 'button', class: 'tab', onclick: () => this.focusOverview() }, 'Overview'),
      zones.map((z, i) => el('button', { type: 'button', class: 'tab', 'data-i': i, onclick: () => this.focusZone(i) }, `${z.icon || ''} ${z.name}`)));
    this.renderLeft();
  }

  viewFor(z) {
    if (z.view) return { cam: new THREE.Vector3(z.view[0], z.view[1], z.view[2]), target: new THREE.Vector3(z.view[3], z.view[4], z.view[5]) };
    const target = new THREE.Vector3(z.x, 1, z.z);
    const dir = this.overview.cam.clone().sub(this.overview.target).normalize();
    const dist = 26 + Math.sqrt(z.area || 600) * 0.6;
    return { cam: target.clone().add(new THREE.Vector3(dir.x, 0.8, dir.z).normalize().multiplyScalar(dist)), target };
  }

  flyTo(view, seconds = 2.2) {
    this.flight = { fromCam: this.camera.position.clone(), fromTarget: this.controls.target.clone(), to: view, t: 0, seconds };
  }

  focusZone(i, keepTour = false) {
    if (!keepTour) this.stopTour();
    this.selected = i;
    this.flyTo(this.viewFor(this.zones[i]));
    this.highlight();
    this.renderLeft();
  }

  focusOverview(keepTour = false) {
    if (!keepTour) this.stopTour();
    this.selected = -1;
    this.flyTo({ cam: this.overview.cam.clone(), target: this.overview.target.clone() });
    this.highlight();
    this.renderLeft();
  }

  highlight() {
    for (const b of this.tabsEl.querySelectorAll('.tab')) {
      const i = b.dataset.i === undefined ? -1 : Number(b.dataset.i);
      b.classList.toggle('on', !b.classList.contains('tour') && i === this.selected);
    }
    this.markers?.forEach((m, i) => m.classList.toggle('on', i === this.selected));
  }

  // ------------------------------------------------------------------ guided tour
  startTour() {
    if (!this.zones.length) return;
    this.tour = { stop: -1, wait: 0 };
    this.nextStop();
    this.setZones(this.zones);
    this.highlight();
  }

  stopTour() {
    if (!this.tour) return;
    this.tour = null;
    this.controls.autoRotate = false;
    this.setZones(this.zones);
    this.highlight();
  }

  nextStop() {
    const t = this.tour;
    t.stop = (t.stop + 1) % (this.zones.length + 1);
    this.controls.autoRotate = false;
    if (t.stop === this.zones.length) this.focusOverview(true); else this.focusZone(t.stop, true);
    t.wait = 7.5;
  }

  // ------------------------------------------------------------------ dashboard
  setDashboard(d) {
    this.dashboard = d;
    this.renderLeft();
    this.renderRight();
    this.renderSensors();
  }

  renderLeft() {
    const d = this.dashboard;
    if (!d) return;
    const gauges = (d.gauges || []).map((g) => {
      const r = 24, c = 2 * Math.PI * r, v = Math.max(0, Math.min(100, g.value));
      return el('div', { class: 'gauge' },
        el('div', { class: 'ring' }, svg(`<svg viewBox="0 0 60 60"><circle cx="30" cy="30" r="${r}" class="track"/>` +
          `<circle cx="30" cy="30" r="${r}" class="val" stroke-dasharray="${(c * v) / 100} ${c}" transform="rotate(-90 30 30)"/></svg>`),
        el('b', {}, `${fmt(v)}%`)), el('span', {}, g.label));
    });
    const total = this.zones.reduce((a, z) => a + (z.area || 0), 0);
    const sel = this.zones[this.selected];
    fill(this.leftEl,
      el('h2', {}, d.title || 'Farm overview'), d.subtitle ? el('p', { class: 'sub' }, d.subtitle) : null,
      gauges.length ? el('div', { class: 'gauges' }, gauges) : null,
      el('h3', {}, 'Zones', el('small', {}, `${fmt(total)} m²`)),
      el('ul', { class: 'zones' }, this.zones.map((z, i) => el('li', { class: i === this.selected ? 'on' : '' },
        el('button', { type: 'button', onclick: () => this.focusZone(i) }, el('span', {}, `${z.icon || '•'} ${z.name}`),
          el('em', {}, z.area ? `${fmt(z.area)} m²` : ''))))),
      sel?.notes ? el('div', { class: 'zone-card' }, el('b', {}, `${sel.icon || ''} ${sel.name}`), el('p', {}, sel.notes)) : null);
  }

  renderRight() {
    const d = this.dashboard;
    if (!d) return;
    const w = d.weather || {};
    this.clockEl = el('div', { class: 'clock' });
    fill(this.rightEl,
      el('div', { class: 'weather' }, this.clockEl,
        el('div', { class: 'temp' }, el('b', {}, `${fmt(w.temp, 1)}°C`), el('span', {}, w.condition || '')),
        el('div', { class: 'wx' },
          el('span', {}, el('small', {}, 'Humidity'), `${fmt(w.humidity)}%`),
          el('span', {}, el('small', {}, 'Light'), `${fmt(w.light)} lx`),
          el('span', {}, el('small', {}, 'Wind'), `${fmt(w.wind)} km/h`))),
      el('h3', {}, 'Resources & output'),
      el('div', { class: 'kpis' }, (d.kpis || []).map((k) => el('div', { class: 'kpi' },
        el('div', { class: 'row' }, el('span', {}, k.label), el('b', {}, `${fmt(k.value, 1)} `, el('small', {}, k.unit || ''))),
        k.target ? el('div', { class: 'bar' }, el('i', { style: `width:${Math.min(100, (k.value / k.target) * 100)}%` })) : null))));
    this.renderClock();
  }

  renderClock() {
    if (!this.clockEl) return;
    const now = new Date();
    this.clockEl.textContent = `${now.toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short' })} · ${now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
  }

  renderSensors() {
    const s = this.dashboard?.sensors;
    if (!s?.bars?.length) { this.sensorsEl.replaceChildren(); this.sensorsEl.hidden = true; return; }
    this.sensorsEl.hidden = false;
    fill(this.sensorsEl, el('h3', {}, s.title || 'Sensors'),
      el('div', { class: 'bars' }, s.bars.map((b) => el('div', { class: 'col', title: `${b.label}: ${fmt(b.value, 1)}${s.unit || ''}` },
        el('b', {}, `${fmt(b.value)}${s.unit || ''}`),
        el('div', { class: 'track' }, el('i', { style: `height:${Math.max(2, Math.min(100, (b.value / (b.max || 100)) * 100))}%` })),
        el('span', {}, b.label)))));
  }

  // ------------------------------------------------------------------ per frame
  update(dt) {
    const f = this.flight;
    if (f) {
      f.t = Math.min(1, f.t + dt / f.seconds);
      const k = ease(f.t);
      this.camera.position.lerpVectors(f.fromCam, f.to.cam, k);
      this.camera.position.y += Math.sin(Math.PI * k) * f.fromCam.distanceTo(f.to.cam) * 0.12; // gentle arc
      this.controls.target.lerpVectors(f.fromTarget, f.to.target, k);
      if (f.t >= 1) {
        this.flight = null;
        if (this.tour) { this.controls.autoRotate = true; this.controls.autoRotateSpeed = 0.6; }
      }
    } else if (this.tour) {
      this.tour.wait -= dt;
      if (this.tour.wait <= 0) this.nextStop();
    }
    this.placeMarkers();
  }

  placeMarkers() {
    if (!this.markers) return;
    const w = innerWidth, h = innerHeight;
    const p = new THREE.Vector3(), g = new THREE.Vector3();
    this.zones.forEach((z, i) => {
      const m = this.markers[i];
      p.set(z.x, z.h ?? 9, z.z).project(this.camera);
      g.set(z.x, 0, z.z).project(this.camera);
      const dist = this.camera.position.distanceTo(new THREE.Vector3(z.x, 0, z.z));
      if (p.z > 1 || Math.abs(p.x) > 1.2 || Math.abs(p.y) > 1.2 || dist > 420) { m.style.display = 'none'; return; }
      const x = (p.x * 0.5 + 0.5) * w, y = (-p.y * 0.5 + 0.5) * h;
      const gy = (-g.y * 0.5 + 0.5) * h;
      const s = THREE.MathUtils.clamp(70 / dist, 0.7, 1.15);
      m.style.display = '';
      m.style.transform = `translate(${x}px, ${y}px) translate(-50%, -100%) scale(${s})`;
      m.style.zIndex = String(1000 - Math.round(dist));
      m.querySelector('.stem').style.height = `${Math.max(0, (gy - y) / s)}px`;
      m.style.opacity = dist > 300 ? String(Math.max(0, (420 - dist) / 120)) : '1';
    });
  }

  setVisible(v) {
    document.body.classList.toggle('hud-off', !v);
  }
}

/** replaceChildren that accepts nested arrays and skips null/undefined */
function fill(parent, ...children) {
  parent.replaceChildren(...children.flat(2).filter((c) => c != null));
}

function svg(markup) {
  const t = document.createElement('template');
  t.innerHTML = markup;
  return t.content.firstChild;
}
