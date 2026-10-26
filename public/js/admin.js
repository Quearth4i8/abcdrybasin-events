(() => {
  'use strict';

  /* ================================================================ helpers */

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  function h(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k.startsWith('on')) node.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k === 'html') node.innerHTML = v; // only used with static icon markup
      else if (k in node && typeof v !== 'string') node[k] = v;
      else node.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) if (c != null && c !== false) node.append(c);
    return node;
  }

  const ICONS = {
    plus: '<path d="M12 5v14M5 12h14"/>',
    edit: '<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
    trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6"/>',
    copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>',
    grip: '<circle cx="9" cy="6" r="1.2"/><circle cx="15" cy="6" r="1.2"/><circle cx="9" cy="12" r="1.2"/><circle cx="15" cy="12" r="1.2"/><circle cx="9" cy="18" r="1.2"/><circle cx="15" cy="18" r="1.2"/>',
    up: '<path d="m18 15-6-6-6 6"/>',
    down: '<path d="m6 9 6 6 6-6"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    alert: '<path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>',
    upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/>',
    clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
    cal: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
    users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM23 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/>',
    star: '<path d="m12 2 3 7 7 .6-5.3 4.7L18.2 21 12 17.3 5.8 21l1.5-6.7L2 9.6 9 9z"/>',
    coffee: '<path d="M17 8h1a4 4 0 1 1 0 8h-1M3 8h14v9a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4zM6 2v2M10 2v2M14 2v2"/>'
  };
  const icon = (name) => h('span', { class: 'ico-wrap', html: `<svg viewBox="0 0 24 24">${ICONS[name]}</svg>` }).firstChild;
  const iconBtn = (name, title, onClick, extra = '') =>
    h('button', { class: `icon-btn ${extra}`, type: 'button', title, 'aria-label': title, onclick: onClick }, icon(name));

  /* ================================================================ api */

  let pending = 0;
  function setSaving(on) {
    pending += on ? 1 : -1;
    const s = $('#saveState');
    s.classList.toggle('saving', pending > 0);
    s.lastChild.textContent = pending > 0 ? 'Saving…' : 'All changes saved';
  }

  async function api(method, url, body) {
    const write = method !== 'GET';
    if (write) setSaving(true);
    try {
      const res = await fetch(url, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
        credentials: 'same-origin'
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401 && !url.startsWith('/api/auth/login')) {
        showLogin();
        throw new Error('Your session expired. Please sign in again.');
      }
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      return data;
    } finally {
      if (write) setSaving(false);
    }
  }

  // Wrap an async action: shows a toast on success/failure and refreshes the content.
  async function act(fn, success) {
    try {
      const out = await fn();
      if (success) toast(success);
      await reload();
      return out;
    } catch (e) {
      toast(e.message, 'error');
      throw e;
    }
  }

  /* ================================================================ ui primitives */

  function toast(message, type = 'ok') {
    const t = h('div', { class: `toast ${type}` }, icon(type === 'error' ? 'alert' : 'check'), h('span', { text: message }));
    $('#toasts').append(t);
    setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, type === 'error' ? 4500 : 2600);
  }

  let modalResolve = null;
  function openModal({ title, body, actions = [] }) {
    const modal = $('#modal');
    $('#modalTitle').textContent = title;
    $('#modalBody').replaceChildren(body);
    $('#modalFoot').replaceChildren(...actions);
    modal.hidden = false;
    modal.classList.remove('closing');
    setTimeout(() => $('input:not([type=hidden]):not([type=radio]), textarea, select', $('#modalBody'))?.focus(), 60);
    return new Promise((resolve) => { modalResolve = resolve; });
  }
  function closeModal(value) {
    const modal = $('#modal');
    if (modal.hidden) return;
    modal.classList.add('closing');
    setTimeout(() => { modal.hidden = true; }, 180);
    modalResolve?.(value);
    modalResolve = null;
  }
  $('#modal').addEventListener('click', (e) => { if (e.target.closest('[data-close]')) closeModal(null); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(null); });

  function confirmDialog(message, { okText = 'Delete', danger = true } = {}) {
    return openModal({
      title: 'Are you sure?',
      body: h('p', { class: 'muted', text: message }),
      actions: [
        h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => closeModal(false) }, 'Cancel'),
        h('button', { class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`, type: 'button', onclick: () => closeModal(true) }, okText)
      ]
    });
  }

  // A form inside the modal. `build(form)` returns the fields; resolves with FormData-like object or null.
  function formModal({ title, fields, submitText = 'Save', onSubmit }) {
    const form = h('form', { class: 'stack', id: 'modalForm' }, fields);
    const err = h('p', { class: 'form-error' });
    form.append(err);
    const submit = h('button', { class: 'btn btn-primary', type: 'submit', form: 'modalForm' }, submitText);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      submit.disabled = true;
      err.textContent = '';
      try {
        await onSubmit(readForm(form));
        closeModal(true);
      } catch (ex) {
        err.textContent = ex.message;
      } finally {
        submit.disabled = false;
      }
    });
    return openModal({
      title,
      body: form,
      actions: [h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => closeModal(null) }, 'Cancel'), submit]
    });
  }

  function readForm(form) {
    const out = {};
    for (const elm of form.elements) {
      if (!elm.name) continue;
      if (elm.type === 'checkbox') out[elm.name] = elm.checked;
      else if (elm.type === 'radio') { if (elm.checked) out[elm.name] = elm.value; }
      else out[elm.name] = elm.value;
    }
    return out;
  }

  const field = (label, input, hint) => h('label', { class: 'field' }, h('span', { text: label }), input, hint ? h('small', { text: hint }) : null);
  const input = (name, value = '', attrs = {}) => h('input', { name, value: value ?? '', ...attrs });
  const toggle = (name, label, checked, onChange) =>
    h('label', { class: 'switch' }, h('input', { type: 'checkbox', name, checked: !!checked, onchange: onChange }), h('span', { text: label }));

  function readFileAsDataURL(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(new Error('Could not read file'));
      r.readAsDataURL(file);
    });
  }

  async function uploadImage(file) {
    if (!/^image\/(png|jpe?g|webp|gif)$/.test(file.type)) throw new Error('Please choose a PNG, JPG, WEBP or GIF image');
    if (file.size > 8 * 1024 * 1024) throw new Error('Image too large (max 8 MB)');
    const { url } = await api('POST', '/api/admin/upload', { data: await readFileAsDataURL(file) });
    return url;
  }

  // Image field: preview + URL input + upload button + drag & drop.
  function imagePicker(name, value) {
    const hidden = input(name, value, { placeholder: '/assets/… or https://…' });
    const img = h('img', { src: value || '', alt: '' });
    const thumb = h('div', { class: 'thumb' }, img);
    const fileInput = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', hidden: true });
    const btn = h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => fileInput.click() }, icon('upload'), 'Upload');
    const wrap = h('div', { class: 'image-pick' }, thumb, h('div', { class: 'controls' }, hidden, h('div', { class: 'btns' }, btn, h('small', { class: 'muted', text: 'or drop an image here' }))), fileInput);
    const handle = async (file) => {
      if (!file) return;
      btn.disabled = true;
      btn.lastChild.textContent = 'Uploading…';
      try {
        const url = await uploadImage(file);
        hidden.value = url;
        img.src = url;
        hidden.dispatchEvent(new Event('input', { bubbles: true }));
      } catch (e) { toast(e.message, 'error'); }
      btn.disabled = false;
      btn.lastChild.textContent = 'Upload';
    };
    fileInput.addEventListener('change', () => handle(fileInput.files[0]));
    hidden.addEventListener('input', () => { img.src = hidden.value; });
    wrap.addEventListener('dragover', (e) => { e.preventDefault(); wrap.classList.add('drop-hint'); });
    wrap.addEventListener('dragleave', () => wrap.classList.remove('drop-hint'));
    wrap.addEventListener('drop', (e) => { e.preventDefault(); wrap.classList.remove('drop-hint'); handle(e.dataTransfer.files[0]); });
    return wrap;
  }

  // Pointer-based sortable list (works with mouse and touch). Items need data-id and a .handle.
  function sortable(container, itemSelector, onReorder) {
    container.addEventListener('pointerdown', (e) => {
      const handle = e.target.closest('.handle');
      if (!handle || !container.contains(handle)) return;
      const item = handle.closest(itemSelector);
      if (!item || item.parentElement !== container) return;
      e.preventDefault();
      const before = $$(`:scope > ${itemSelector}`, container).map((n) => n.dataset.id).join();
      item.classList.add('dragging');
      const move = (ev) => {
        const siblings = $$(`:scope > ${itemSelector}:not(.dragging)`, container);
        const target = siblings.find((s) => {
          const r = s.getBoundingClientRect();
          const horizontal = getComputedStyle(container).display === 'grid' && r.width < container.clientWidth / 1.5;
          return horizontal
            ? ev.clientY < r.bottom && (ev.clientY < r.top || ev.clientX < r.left + r.width / 2)
            : ev.clientY < r.top + r.height / 2;
        });
        if (target) container.insertBefore(item, target);
        else container.append(item);
      };
      const up = () => {
        item.classList.remove('dragging');
        removeEventListener('pointermove', move);
        removeEventListener('pointerup', up);
        removeEventListener('pointercancel', up);
        const ids = $$(`:scope > ${itemSelector}`, container).map((n) => n.dataset.id);
        if (ids.join() !== before) onReorder(ids);
      };
      // Listen on window: moving the item in the DOM would drop pointer capture on the handle.
      addEventListener('pointermove', move);
      addEventListener('pointerup', up);
      addEventListener('pointercancel', up);
    });
  }
  const gripHandle = () => h('span', { class: 'handle', title: 'Drag to reorder', style: 'touch-action:none' }, icon('grip'));

  /* ================================================================ state & routing */

  let content = null;
  let me = null;

  async function reload() {
    content = await api('GET', '/api/content');
    render();
  }

  const VIEWS = {
    dashboard: { title: 'Dashboard', sub: 'Overview of your event website', render: viewDashboard },
    event: { title: 'Event details', sub: 'Headline, dates, location, registration and images', render: viewEvent },
    program: { title: 'Program', sub: 'Days, sessions and breaks — drag rows to reorder', render: viewProgram },
    highlights: { title: 'Highlights', sub: 'The four statements on the poster page', render: viewHighlights },
    partners: { title: 'Partners & logos', sub: 'Logos shown on the program header and the poster footer', render: viewPartners },
    settings: { title: 'Account & backup', sub: 'Credentials, export, import and reset', render: viewSettings }
  };
  const currentView = () => (VIEWS[location.hash.slice(1)] ? location.hash.slice(1) : 'dashboard');

  function render() {
    if (!content) return;
    const name = currentView();
    const view = VIEWS[name];
    $('#viewTitle').textContent = view.title;
    $('#viewSub').textContent = view.sub;
    $$('#sideNav a').forEach((a) => a.classList.toggle('active', a.dataset.view === name));
    const root = $('#view');
    const scroll = scrollY;
    const sameView = root.dataset.view === name;
    root.dataset.view = name;
    root.replaceChildren(...[view.render()].flat());
    if (!sameView) { root.style.animation = 'none'; void root.offsetWidth; root.style.animation = ''; scrollTo(0, 0); }
    else scrollTo(0, scroll);
  }

  addEventListener('hashchange', () => { $('#app').classList.remove('nav-open'); render(); });

  /* ================================================================ views */

  function viewDashboard() {
    const ev = content.event;
    const sessions = content.days.reduce((n, d) => n + d.sessions.filter((s) => s.type !== 'break').length, 0);
    const stat = (ico, value, label, hash) => h('a', { class: 'stat', href: `#${hash}` }, h('div', { class: 'ico' }, icon(ico)), h('div', {}, h('strong', { text: String(value) }), h('span', { text: label })));
    return [
      h('div', { class: 'card hero-card' },
        h('div', {},
          h('p', { text: ev.seminarTitle, style: 'margin:0;letter-spacing:1px;font-size:12px' }),
          h('h2', { text: ev.title }),
          h('p', { text: `${ev.dateLabel} ${ev.dateSub} · ${ev.timeLabel} · ${ev.location}` }),
          h('div', { class: 'btn-row' },
            h('a', { class: 'btn btn-ghost', href: '#event' }, icon('edit'), 'Edit event'),
            h('a', { class: 'btn btn-ghost', href: '/', target: '_blank', rel: 'noopener' }, 'Open website ↗'))),
        h('img', { src: ev.heroImage, alt: '' })),
      h('div', { class: 'stats' },
        stat('cal', content.days.length, 'Program days', 'program'),
        stat('clock', sessions, 'Sessions', 'program'),
        stat('users', content.partners.length, 'Partners', 'partners'),
        stat('star', content.features.length, 'Highlights', 'highlights')),
      h('div', { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', { text: 'Quick actions' })),
        h('div', { class: 'quick' },
          h('button', { type: 'button', onclick: () => content.days[0] ? editSession(null, content.days[0].id) : addDay() }, 'Add a session', h('small', { text: 'Talk, pitch or workshop' })),
          h('button', { type: 'button', onclick: () => addDay() }, 'Add a program day', h('small', { text: 'New day heading' })),
          h('button', { type: 'button', onclick: () => editPartner(null) }, 'Add a partner logo', h('small', { text: 'Upload & place a logo' }))))
    ];
  }

  function viewEvent() {
    const ev = content.event;
    const form = h('form', { class: 'stack' },
      h('div', { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', { text: 'Headline' })),
        h('div', { class: 'stack' },
          h('div', { class: 'grid-2' },
            field('Small heading', input('seminarTitle', ev.seminarTitle)),
            field('Event title', input('title', ev.title))),
          field('Program page title', input('programTitle', ev.programTitle)))),
      h('div', { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', { text: 'When & where' })),
        h('div', { class: 'grid-2' },
          field('Dates (line 1)', input('dateLabel', ev.dateLabel, { placeholder: '14 & 15' })),
          field('Dates (line 2)', input('dateSub', ev.dateSub, { placeholder: 'DEC, 2026' })),
          field('Time', input('timeLabel', ev.timeLabel, { placeholder: '08 AM - 16 PM' })),
          field('Location', input('location', ev.location)))),
      h('div', { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', { text: 'Registration & contact' })),
        h('div', { class: 'stack' },
          h('div', { class: 'grid-2' },
            field('Label', input('registerLabel', ev.registerLabel)),
            field('Contact email', input('email', ev.email, { type: 'email' }))),
          field('Registration link', input('registerUrl', ev.registerUrl, { type: 'url', placeholder: 'https://…' }), 'The QR code on the poster is generated from this link automatically.'),
          field('Link text', input('registerText', ev.registerText ?? 'Register now', { placeholder: 'Register now' }), 'Shown on the poster as a button instead of the long link. Leave empty to show the link itself.'),
          toggle('showQr', 'Show QR code on the poster', ev.showQr))),
      h('div', { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', { text: 'Images' })),
        h('div', { class: 'grid-2' },
          field('Event logo', imagePicker('logo', ev.logo)),
          field('Poster photo', imagePicker('heroImage', ev.heroImage)))),
      h('div', { class: 'form-actions' },
        h('button', { class: 'btn btn-ghost', type: 'reset', onclick: () => setTimeout(render) }, 'Discard changes'),
        h('button', { class: 'btn btn-primary', type: 'submit' }, 'Save changes')));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      act(() => api('PUT', '/api/admin/event', readForm(form)), 'Event details saved').catch(() => {});
    });
    return form;
  }

  function viewProgram() {
    const daysWrap = h('div', { class: 'stack' }, content.days.map((day, di) => {
      const list = h('ul', { class: 'rows' },
        day.sessions.length ? day.sessions.map((s) => h('li', { class: `row ${s.type === 'break' ? 'break' : ''}`, 'data-id': s.id },
          gripHandle(),
          h('span', { class: 'time', text: [s.start, s.end].filter(Boolean).join('-') || '—' }),
          h('div', { class: 'ttl' }, s.title || h('em', { class: 'muted', text: 'Untitled' }), s.type === 'break' ? h('span', { class: 'tag', text: 'break' }) : null,
            s.speaker ? h('span', { class: 'spk', text: s.speaker }) : null),
          h('div', { class: 'row-actions' },
            iconBtn('edit', 'Edit', () => editSession(s, day.id)),
            iconBtn('copy', 'Duplicate', () => act(() => api('POST', `/api/admin/sessions/${s.id}/duplicate`), 'Session duplicated').catch(() => {})),
            iconBtn('trash', 'Delete', async () => {
              if (await confirmDialog(`Delete “${s.title}”?`)) act(() => api('DELETE', `/api/admin/sessions/${s.id}`), 'Session deleted').catch(() => {});
            }, 'danger'))))
          : h('li', { class: 'empty-row', text: 'No sessions yet — add the first one below.' }));
      sortable(list, '.row', (ids) => act(() => api('POST', `/api/admin/days/${day.id}/sessions-order`, { ids }), 'Order updated').catch(() => {}));

      return h('section', { class: 'card day-card' },
        h('header', {},
          h('h3', { text: day.title }),
          h('span', { class: 'count', text: `${day.sessions.length} item${day.sessions.length === 1 ? '' : 's'}` }),
          h('div', { class: 'actions' },
            di > 0 ? iconBtn('up', 'Move day up', () => moveDay(di, -1)) : null,
            di < content.days.length - 1 ? iconBtn('down', 'Move day down', () => moveDay(di, 1)) : null,
            iconBtn('edit', 'Rename day', () => addDay(day)),
            iconBtn('copy', 'Duplicate day', () => act(() => api('POST', `/api/admin/days/${day.id}/duplicate`), 'Day duplicated').catch(() => {})),
            iconBtn('trash', 'Delete day', async () => {
              if (await confirmDialog(`Delete “${day.title}” and its ${day.sessions.length} item(s)?`)) act(() => api('DELETE', `/api/admin/days/${day.id}`), 'Day deleted').catch(() => {});
            }, 'danger'))),
        list,
        h('footer', {},
          h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => editSession(null, day.id) }, icon('plus'), 'Add session'),
          h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => editSession({ type: 'break', title: 'COFFEE BREAK & NETWORKING' }, day.id, true) }, icon('coffee'), 'Add break')));
    }));

    return [
      h('div', { class: 'card-head', style: 'margin:0' },
        h('p', { class: 'muted', text: 'Changes are saved instantly and appear on the website right away.' }),
        h('div', { class: 'actions' }, h('button', { class: 'btn btn-primary', type: 'button', onclick: () => addDay() }, icon('plus'), 'Add day'))),
      content.days.length ? daysWrap : h('div', { class: 'card empty-row', text: 'No program days yet.' })
    ];
  }

  function moveDay(index, dir) {
    const ids = content.days.map((d) => d.id);
    [ids[index], ids[index + dir]] = [ids[index + dir], ids[index]];
    act(() => api('POST', '/api/admin/days-order', { ids }), 'Day moved').catch(() => {});
  }

  function addDay(day) {
    return formModal({
      title: day ? 'Rename day' : 'Add day',
      submitText: day ? 'Save' : 'Add day',
      fields: [field('Day heading', input('title', day?.title || `Day ${content.days.length + 1}: `, { required: true, placeholder: 'Day 1: Monday 14 December 2026' }))],
      onSubmit: (data) => act(() => (day ? api('PUT', `/api/admin/days/${day.id}`, data) : api('POST', '/api/admin/days', data)), day ? 'Day updated' : 'Day added')
    });
  }

  function editSession(s, dayId, isNew = !s?.id) {
    s = s || { type: 'session' };
    const day = content.days.find((d) => d.id === dayId);
    const last = day?.sessions[day.sessions.length - 1];
    const typeSeg = h('div', { class: 'segmented' },
      ['session', 'break'].map((t) => h('label', {}, h('input', { type: 'radio', name: 'type', value: t, checked: (s.type || 'session') === t }), h('span', { text: t === 'session' ? 'Session' : 'Break' }))));
    const speakerField = field('Speaker / organisation', input('speaker', s.speaker, { placeholder: 'e.g. Micha Werner, IHE' }), 'Optional — shown in small blue text under the title.');
    const syncType = () => { speakerField.hidden = readForm(typeSeg.closest('form') || h('form', {}, typeSeg)).type === 'break'; };
    typeSeg.addEventListener('change', syncType);
    const fields = [
      field('Type', typeSeg),
      h('div', { class: 'grid-2' },
        field('Start', input('start', s.start ?? (isNew ? last?.end || '' : ''), { type: 'time', required: true })),
        field('End', input('end', s.end, { type: 'time' }))),
      field('Title', h('textarea', { name: 'title', required: true, rows: 2, text: s.title || '' })),
      speakerField,
      content.days.length > 1 && !isNew
        ? field('Day', h('select', { name: 'dayId' }, content.days.map((d) => h('option', { value: d.id, selected: d.id === dayId, text: d.title }))))
        : null
    ];
    setTimeout(syncType);
    return formModal({
      title: isNew ? (s.type === 'break' ? 'Add break' : 'Add session') : 'Edit session',
      submitText: isNew ? 'Add' : 'Save',
      fields,
      onSubmit: (data) => {
        if (data.type === 'break') data.speaker = '';
        return act(() => (isNew ? api('POST', `/api/admin/days/${dayId}/sessions`, data) : api('PUT', `/api/admin/sessions/${s.id}`, data)), isNew ? 'Session added' : 'Session saved');
      }
    });
  }

  function viewHighlights() {
    const list = h('ul', { class: 'list' }, content.features.map((f) => h('li', { class: 'list-item', 'data-id': f.id },
      gripHandle(),
      h('div', {}, h('h4', { text: f.title }), h('p', { text: f.subtitle })),
      h('div', { class: 'row-actions' },
        iconBtn('edit', 'Edit', () => editFeature(f)),
        iconBtn('trash', 'Delete', async () => {
          if (await confirmDialog(`Delete “${f.title}”?`)) act(() => api('DELETE', `/api/admin/features/${f.id}`), 'Highlight deleted').catch(() => {});
        }, 'danger')))));
    sortable(list, '.list-item', (ids) => act(() => api('POST', '/api/admin/features-order', { ids }), 'Order updated').catch(() => {}));
    return h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', { text: 'Poster highlights' }), h('p', { class: 'muted', text: 'Big bold lines on the left of the poster.' }),
        h('div', { class: 'actions' }, h('button', { class: 'btn btn-primary', type: 'button', onclick: () => editFeature(null) }, icon('plus'), 'Add highlight'))),
      content.features.length ? list : h('p', { class: 'empty-row', text: 'No highlights yet.' }));
  }

  function editFeature(f) {
    return formModal({
      title: f ? 'Edit highlight' : 'Add highlight',
      fields: [field('Title', input('title', f?.title, { required: true, placeholder: 'Smart Solutions' })),
        field('Subtitle', input('subtitle', f?.subtitle, { placeholder: 'Innovative Climate Adaptation' }))],
      onSubmit: (data) => act(() => (f ? api('PUT', `/api/admin/features/${f.id}`, data) : api('POST', '/api/admin/features', data)), f ? 'Highlight saved' : 'Highlight added')
    });
  }

  function viewPartners() {
    const grid = h('div', { class: 'partners-grid' }, content.partners.map((p) => h('article', { class: 'partner', 'data-id': p.id },
      gripHandle(),
      h('div', { class: 'p-actions' },
        iconBtn('edit', 'Edit', () => editPartner(p)),
        iconBtn('trash', 'Delete', async () => {
          if (await confirmDialog(`Remove “${p.name}”?`)) act(() => api('DELETE', `/api/admin/partners/${p.id}`), 'Partner removed').catch(() => {});
        }, 'danger')),
      h('div', { class: 'logo' }, p.logo ? h('img', { src: p.logo, alt: p.name }) : h('span', { class: 'muted', text: 'No logo' })),
      h('h4', { text: p.name || 'Unnamed' }),
      h('div', { class: 'flags' },
        toggle('header', 'Program header', p.header, (e) => act(() => api('PUT', `/api/admin/partners/${p.id}`, { header: e.target.checked }), 'Updated').catch(() => {})),
        toggle('footer', 'Poster footer', p.footer, (e) => act(() => api('PUT', `/api/admin/partners/${p.id}`, { footer: e.target.checked }), 'Updated').catch(() => {}))))));
    sortable(grid, '.partner', (ids) => act(() => api('POST', '/api/admin/partners-order', { ids }), 'Order updated').catch(() => {}));
    return [logoSizes(), h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', { text: 'Partner logos' }), h('p', { class: 'muted', text: 'Drag cards to change the order logos appear in.' }),
        h('div', { class: 'actions' }, h('button', { class: 'btn btn-primary', type: 'button', onclick: () => editPartner(null) }, icon('plus'), 'Add partner'))),
      content.partners.length ? grid : h('p', { class: 'empty-row', text: 'No partners yet.' }))];
  }

  // Mirrors the public site's logo rows (widths, gaps, default sizes, phone scaling) so the preview is faithful.
  const LOGO_ROWS = {
    header: { label: 'Program header', key: 'headerSize', flag: 'header', def: 100, maxW: 240, desktop: 860, phone: 322, phoneScale: 0.62 },
    footer: { label: 'Poster footer', key: 'footerSize', flag: 'footer', def: 64, maxW: 200, desktop: 924, phone: 326, phoneScale: 0.8 }
  };
  let logoTab = 'header';
  let logoDevice = 'desktop';

  function logoSizes() {
    const row = LOGO_ROWS[logoTab];
    const items = content.partners.filter((p) => p[row.flag] && p.logo);
    const phone = logoDevice === 'phone';
    const scale = phone ? row.phoneScale : 1;

    const previewImg = (p) => {
      const img = h('img', { src: p.logo, alt: p.name, title: p.name });
      const apply = (size) => {
        img.style.height = `${(size || row.def) * scale}px`;
        img.style.maxWidth = size ? '100%' : `${row.maxW}px`;
      };
      apply(p[row.key]);
      img.applySize = apply;
      return img;
    };
    const imgs = new Map(items.map((p) => [p.id, previewImg(p)]));
    const stage = h('div', { class: `pv-stage pv-${logoTab} ${phone ? 'pv-phone' : ''}`, style: `width:${phone ? row.phone : row.desktop}px` }, [...imgs.values()]);
    const frame = h('div', { class: 'pv-frame' }, stage);
    // Scale the stage down when the admin column is narrower than the real site row
    const fit = () => {
      const k = Math.min(1, (frame.clientWidth - 2) / stage.offsetWidth);
      stage.style.transform = `scale(${k})`;
      frame.style.height = `${stage.offsetHeight * k + 2}px`;
    };
    new ResizeObserver(fit).observe(frame);
    stage.addEventListener('load', fit, true);

    const save = async (p, value) => {
      try {
        const saved = await api('PUT', `/api/admin/partners/${p.id}`, { [row.key]: value });
        p[row.key] = saved[row.key];
      } catch (e) { toast(e.message, 'error'); }
    };

    const controls = items.map((p) => {
      const current = p[row.key] || row.def;
      const range = h('input', { type: 'range', min: 16, max: 240, value: current, 'aria-label': `${p.name} size` });
      const num = h('input', { type: 'number', min: 16, max: 300, value: current, class: 'size-num' });
      const auto = h('button', { class: 'btn btn-ghost btn-sm', type: 'button', title: 'Back to the default size' }, 'Auto');
      const badge = h('span', { class: 'size-auto', text: 'auto', hidden: !!p[row.key] });
      const preview = (v) => { imgs.get(p.id).applySize(v); range.value = v || row.def; num.value = v || row.def; badge.hidden = !!v; fit(); };
      range.addEventListener('input', () => preview(+range.value));
      range.addEventListener('change', () => save(p, +range.value));
      num.addEventListener('input', () => { if (num.value >= 16) preview(+num.value); });
      num.addEventListener('change', () => { const v = Math.min(300, Math.max(16, +num.value || row.def)); preview(v); save(p, v); });
      auto.addEventListener('click', () => { preview(null); save(p, null); });
      return h('div', { class: 'size-row' },
        h('div', { class: 'size-thumb' }, h('img', { src: p.logo, alt: '' })),
        h('div', { class: 'size-name' }, h('strong', { text: p.name }), badge),
        range, h('div', { class: 'size-val' }, num, h('span', { text: 'px' })), auto);
    });

    const seg = (name, options, value, onPick) => h('div', { class: 'segmented' }, options.map(([v, label]) =>
      h('label', {}, h('input', { type: 'radio', name, value: v, checked: v === value, onchange: () => { onPick(v); render(); } }), h('span', { text: label }))));

    return h('div', { class: 'card' },
      h('div', { class: 'card-head' },
        h('h2', { text: 'Logo sizes' }),
        h('p', { class: 'muted', text: 'Drag a slider — the preview updates live and saves when you let go.' }),
        h('div', { class: 'actions' },
          seg('logoTab', [['header', 'Program header'], ['footer', 'Poster footer']], logoTab, (v) => { logoTab = v; }),
          seg('logoDevice', [['desktop', 'Desktop'], ['phone', 'Phone']], logoDevice, (v) => { logoDevice = v; }))),
      items.length
        ? [frame, h('div', { class: 'size-list' }, controls),
          h('div', { class: 'form-actions' }, h('a', { class: 'btn btn-ghost btn-sm', href: logoTab === 'header' ? '/#program' : '/#partners', target: '_blank', rel: 'noopener' }, 'See it on the live site ↗'))]
        : h('p', { class: 'empty-row', text: `No logos in the ${row.label.toLowerCase()} yet — switch one on below.` }));
  }

  function editPartner(p) {
    return formModal({
      title: p ? 'Edit partner' : 'Add partner',
      fields: [
        field('Name', input('name', p?.name, { required: true })),
        field('Logo', imagePicker('logo', p?.logo || '')),
        field('Website (optional)', input('url', p?.url, { type: 'url', placeholder: 'https://…' }), 'Clicking the logo will open this link.'),
        h('div', { class: 'flags', style: 'display:flex;gap:18px;flex-wrap:wrap' },
          toggle('header', 'Show in program header', p ? p.header : false),
          toggle('footer', 'Show in poster footer', p ? p.footer : true))
      ],
      onSubmit: (data) => act(() => (p ? api('PUT', `/api/admin/partners/${p.id}`, data) : api('POST', '/api/admin/partners', data)), p ? 'Partner saved' : 'Partner added')
    });
  }

  function viewSettings() {
    const account = h('form', { class: 'stack' },
      h('div', { class: 'grid-2' },
        field('Username', input('newUsername', me.username, { required: true, autocomplete: 'username' })),
        field('Current password', input('currentPassword', '', { type: 'password', required: true, autocomplete: 'current-password' }))),
      field('New password', input('newPassword', '', { type: 'password', minlength: 8, autocomplete: 'new-password', placeholder: 'Leave empty to keep the current one' }), 'At least 8 characters.'),
      h('div', { class: 'form-actions' }, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Update account')));
    account.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const out = await api('POST', '/api/admin/account', readForm(account));
        me = await api('GET', '/api/auth/me');
        updateUser();
        toast(`Account updated for ${out.username}`);
        account.reset();
        render();
      } catch (ex) { toast(ex.message, 'error'); }
    });

    const importInput = h('input', { type: 'file', accept: 'application/json,.json', hidden: true });
    importInput.addEventListener('change', async () => {
      const file = importInput.files[0];
      importInput.value = '';
      if (!file) return;
      let data;
      try { data = JSON.parse(await file.text()); } catch { return toast('That file is not valid JSON', 'error'); }
      if (await confirmDialog('Importing replaces all current content (event, program, highlights and partners).', { okText: 'Import' })) {
        act(() => api('POST', '/api/admin/import', data), 'Backup imported').catch(() => {});
      }
    });

    return [
      h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', { text: 'Admin account' })), account),
      h('div', { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', { text: 'Backup & restore' }), h('p', { class: 'muted', text: 'Download all content as a file, or restore from one.' })),
        h('div', { style: 'display:flex;gap:10px;flex-wrap:wrap' },
          h('a', { class: 'btn btn-ghost', href: '/api/admin/export', download: 'abcdrybasin-backup.json' }, 'Download backup'),
          h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => importInput.click() }, icon('upload'), 'Import backup'),
          h('button', {
            class: 'btn btn-danger-ghost', type: 'button', onclick: async () => {
              if (await confirmDialog('Reset all content back to the original seminar program? Your edits will be lost.', { okText: 'Reset content' })) {
                act(() => api('POST', '/api/admin/reset'), 'Content reset to the original program').catch(() => {});
              }
            }
          }, 'Reset to original'),
          importInput))
    ];
  }

  /* ================================================================ auth & boot */

  function updateUser() {
    $('#userChip').replaceChildren(h('b', { text: (me.username || '?')[0] }), me.username);
    $('#defaultBanner').hidden = !me.isDefault;
  }

  function showLogin() {
    $('#app').hidden = true;
    $('#login').hidden = false;
    closeModal(null);
  }

  async function showApp() {
    $('#login').hidden = true;
    $('#app').hidden = false;
    updateUser();
    await reload();
  }

  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const btn = $('button[type=submit]', form);
    btn.disabled = true;
    $('#loginError').textContent = '';
    try {
      const data = readForm(form);
      const res = await api('POST', '/api/auth/login', data);
      me = { username: res.username, isDefault: res.isDefault };
      form.reset();
      await showApp();
      toast(`Welcome, ${me.username}`);
    } catch (ex) {
      $('#loginError').textContent = ex.message;
      form.classList.remove('shake'); void form.offsetWidth; form.classList.add('shake');
    } finally {
      btn.disabled = false;
    }
  });

  $('.pw-toggle').addEventListener('click', (e) => {
    const inp = e.target.previousElementSibling;
    inp.type = inp.type === 'password' ? 'text' : 'password';
    e.target.textContent = inp.type === 'password' ? 'Show' : 'Hide';
  });

  $('#logoutBtn').addEventListener('click', async () => {
    await api('POST', '/api/auth/logout').catch(() => {});
    me = null;
    content = null;
    showLogin();
  });

  $('#menuBtn').addEventListener('click', () => $('#app').classList.toggle('nav-open'));
  $('#scrim').addEventListener('click', () => $('#app').classList.remove('nav-open'));

  (async () => {
    try {
      me = await api('GET', '/api/auth/me');
      await showApp();
    } catch {
      showLogin();
    }
  })();
})();
