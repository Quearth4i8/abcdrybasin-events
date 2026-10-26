(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const get = (obj, path) => path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);

  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else node.setAttribute(k, v);
    }
    for (const c of children) if (c != null) node.append(c);
    return node;
  }

  const safeUrl = (url) => (/^(https?:|mailto:|\/)/i.test(url || '') ? url : '#');

  function render(data) {
    const { event } = data;

    $$('[data-bind]').forEach((n) => { n.textContent = get(data, n.dataset.bind) ?? ''; });
    $$('[data-bind-src]').forEach((n) => { n.src = get(data, n.dataset.bindSrc) || ''; });

    document.title = `${event.title} · ABCDryBASIN`;

    // Registration
    const reg = safeUrl(event.registerUrl);
    $('#registerUrl').textContent = event.registerUrl || '';
    $('#registerUrl').href = reg;
    $('#navRegister').href = reg;
    $('#navRegister').hidden = !event.registerUrl;
    $('#registerMail').href = `mailto:${event.email || ''}`;
    $('#registerMail').hidden = !event.email;
    const qr = $('#qr');
    qr.hidden = !event.showQr || !event.registerUrl;
    qr.src = `/api/qr.svg?v=${encodeURIComponent(event.registerUrl || '')}`;

    // Highlights
    $('#features').replaceChildren(...data.features.map((f) =>
      el('li', { class: 'feature reveal' }, el('h3', { text: f.title }), el('p', { text: f.subtitle }))));

    // Logos
    const logo = (p) => {
      const img = el('img', { src: p.logo, alt: p.name, title: p.name, loading: 'lazy' });
      return p.url ? el('a', { href: safeUrl(p.url), target: '_blank', rel: 'noopener' }, img) : el('span', {}, img);
    };
    $('#partners').replaceChildren(...data.partners.filter((p) => p.footer && p.logo).map(logo));
    $('#headerLogos').replaceChildren(...data.partners.filter((p) => p.header && p.logo).map(logo));

    // Program
    $('#dayChips').replaceChildren(...data.days.map((d) =>
      el('a', { href: `#${d.id}`, 'data-day': d.id, text: (d.title.split(':')[0] || d.title).trim() })));
    $('#dayChips').hidden = data.days.length < 2;

    $('#days').replaceChildren(...data.days.map((day) => el('article', { class: 'day reveal', id: day.id },
      el('h3', { class: 'day-title', text: day.title }),
      day.sessions.length
        ? el('ul', { class: 'slots' }, ...day.sessions.map((s) => el('li', { class: `slot ${s.type === 'break' ? 'break' : ''}` },
          el('span', { class: 'slot-time', text: [s.start, s.end].filter(Boolean).join('-') }),
          el('div', { class: 'slot-title' }, s.title, s.speaker ? el('span', { class: 'slot-speaker', text: s.speaker }) : null))))
        : el('p', { class: 'empty', text: 'Program to be announced.' }))));

    observeReveals();
    observeSections();
  }

  /* ---- motion & navigation ---- */
  let revealObserver;
  function observeReveals() {
    revealObserver?.disconnect();
    revealObserver = new IntersectionObserver((entries) => {
      entries.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('in'); revealObserver.unobserve(e.target); } });
    }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });
    $$('.reveal:not(.in)').forEach((n, i) => {
      n.style.transitionDelay = n.classList.contains('feature') ? `${(i % 6) * 70}ms` : '';
      revealObserver.observe(n);
    });
  }

  let sectionObserver;
  function observeSections() {
    sectionObserver?.disconnect();
    sectionObserver = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (!e.isIntersecting) return;
        const id = e.target.id;
        if (e.target.classList.contains('day')) {
          $$('#dayChips a').forEach((a) => a.classList.toggle('active', a.dataset.day === id));
        } else {
          $$('#navLinks a').forEach((a) => a.classList.toggle('active', a.dataset.section === id));
        }
      });
    }, { rootMargin: '-45% 0px -50% 0px' });
    ['#overview', '#partners', '#program', ...$$('.day').map((d) => `#${d.id}`)]
      .forEach((s) => { const n = $(s); if (n) sectionObserver.observe(n); });
  }

  const nav = $('#nav');
  addEventListener('scroll', () => nav.classList.toggle('scrolled', scrollY > 8), { passive: true });
  $('#navToggle').addEventListener('click', () => nav.classList.toggle('open'));
  $$('#navLinks a').forEach((a) => a.addEventListener('click', () => nav.classList.remove('open')));
  $('#year').textContent = new Date().getFullYear();

  fetch('/api/content')
    .then((r) => r.json())
    .then(render)
    .catch(() => { $('#days').textContent = 'Unable to load the program right now.'; });
})();
