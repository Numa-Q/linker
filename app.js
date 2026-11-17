'use strict';
(() => {
  const APP_VERSION = '1.2.0';
  const DB_NAME = 'portail-liens';
  const DB_VERSION = 1;
  const LIMITS = { title: 200, url: 2048, note: 1000, tag: 40, tags: 12, collection: 60,
                   file: 5 * 1024 * 1024, importBatch: 5000, total: 20000, logs: 200 };
  const NONE = '\u0000none';
  const PAGE = 50;
  const VIEWS = ['cards', 'lines', 'compact', 'grouped'];
  const ROOT_FOLDERS = /^(barre de favoris|bookmarks (bar|toolbar|menu)|favorites bar|favoris|autres favoris|other bookmarks|menu des favoris)$/i;

  const $ = (s, r = document) => r.querySelector(s);

  /* ---------- Construction DOM sûre (jamais d'innerHTML) ---------- */
  function el(tag, props = {}, ...kids) {
    const n = document.createElement(tag);
    if (props.className) n.className = props.className;
    if (props.attrs) for (const [k, v] of Object.entries(props.attrs)) n.setAttribute(k, v);
    if (props.on) for (const [k, v] of Object.entries(props.on)) n.addEventListener(k, v);
    for (const k of kids) if (k != null) n.append(k);
    return n;
  }
  const SVGNS = 'http://www.w3.org/2000/svg';
  const ICONS = {
    pin: 'M7 4h10v16l-5-4-5 4z',
    edit: 'M4 20h4L19 9l-4-4L4 16z M13.5 6.5l4 4',
    trash: 'M5 7h14 M10 11v6 M14 11v6 M6 7l1 13h10l1-13 M9 7V4h6v3',
    sun: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z M12 2v2 M12 20v2 M2 12h2 M20 12h2 M4.9 4.9l1.4 1.4 M17.7 17.7l1.4 1.4 M4.9 19.1l1.4-1.4 M17.7 6.3l1.4-1.4',
    moon: 'M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z'
  };
  function icon(name) {
    const s = document.createElementNS(SVGNS, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('aria-hidden', 'true');
    s.setAttribute('focusable', 'false');
    const p = document.createElementNS(SVGNS, 'path');
    p.setAttribute('d', ICONS[name]);
    s.append(p);
    return s;
  }

  /* ---------- Nettoyage et validation des entrées ---------- */
  const norm = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const clean = (s, max) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  const finiteTs = (x) => (Number.isFinite(x) && x > 0 && x <= Date.now() + 86400000 ? Math.floor(x) : undefined);

  function parseUrl(raw) {
    const s = String(raw ?? '').trim();
    if (!s || s.length > LIMITS.url) return null;
    let candidate;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) candidate = s;
    else if (/^(javascript|data|vbscript|file|blob|mailto|tel|about):/i.test(s)) return null;
    else candidate = 'https://' + s;
    let u;
    try { u = new URL(candidate); } catch { return null; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (u.username || u.password) return null;
    if (!u.hostname) return null;
    return u;
  }
  function urlKey(u) {
    const c = new URL(u.href);
    c.hash = '';
    let k = c.href;
    if (c.pathname === '/' && !c.search) k = k.replace(/\/$/, '');
    return k;
  }
  function cleanTags(input) {
    const arr = Array.isArray(input) ? input : String(input ?? '').split(',');
    const out = [];
    for (const t of arr) {
      const v = clean(t, LIMITS.tag).toLowerCase();
      if (v && !out.includes(v)) out.push(v);
      if (out.length >= LIMITS.tags) break;
    }
    return out;
  }
  function uid() {
    const b = new Uint8Array(16);
    crypto.getRandomValues(b);
    return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  }
  function buildLink(src) {
    const u = parseUrl(src.url);
    if (!u) return null;
    const now = Date.now();
    return {
      id: uid(),
      title: clean(src.title, LIMITS.title) || u.hostname,
      url: u.href,
      urlKey: urlKey(u),
      collection: clean(src.collection, LIMITS.collection),
      tags: cleanTags(src.tags),
      note: String(src.note ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, LIMITS.note),
      pinned: src.pinned === true,
      visits: Number.isInteger(src.visits) && src.visits > 0 ? Math.min(src.visits, 1e6) : 0,
      createdAt: finiteTs(src.createdAt) ?? now,
      updatedAt: now
    };
  }
  function coerceStored(r) {
    if (!r || typeof r !== 'object' || typeof r.id !== 'string') return null;
    return {
      id: r.id,
      title: clean(r.title, LIMITS.title) || '(sans titre)',
      url: typeof r.url === 'string' ? r.url.slice(0, LIMITS.url) : '',
      urlKey: typeof r.urlKey === 'string' ? r.urlKey : '',
      collection: clean(r.collection, LIMITS.collection),
      tags: cleanTags(r.tags),
      note: typeof r.note === 'string' ? r.note.slice(0, LIMITS.note) : '',
      pinned: r.pinned === true,
      visits: Number.isInteger(r.visits) && r.visits > 0 ? r.visits : 0,
      createdAt: finiteTs(r.createdAt) ?? 0,
      updatedAt: finiteTs(r.updatedAt) ?? 0
    };
  }

  /* ---------- IndexedDB (schéma versionné) ---------- */
  let db;
  function migrate(d, oldVersion) {
    // Chaque montée de version s'ajoute ici, sans jamais supprimer de store existant.
    if (oldVersion < 1) {
      d.createObjectStore('links', { keyPath: 'id' });
      d.createObjectStore('logs', { keyPath: 'id', autoIncrement: true });
      d.createObjectStore('meta', { keyPath: 'key' });
    }
  }
  function openDb() {
    return new Promise((resolve, reject) => {
      const rq = indexedDB.open(DB_NAME, DB_VERSION);
      rq.onupgradeneeded = (e) => migrate(rq.result, e.oldVersion);
      rq.onblocked = () => toast('Fermez les autres onglets de cette application puis rechargez la page.', true);
      rq.onerror = () => reject(rq.error);
      rq.onsuccess = () => {
        rq.result.onversionchange = () => {
          rq.result.close();
          toast('Une autre version de l’application est ouverte. Rechargez la page.', true);
        };
        resolve(rq.result);
      };
    });
  }
  const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  function run(stores, mode, fn) {
    return new Promise((resolve, reject) => {
      const t = db.transaction(stores, mode);
      let out;
      t.oncomplete = () => resolve(out);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('abort'));
      out = fn(t);
    });
  }
  const putLinks = (arr, quiet = false) => run('links', 'readwrite', (t) => { const s = t.objectStore('links'); arr.forEach((l) => s.put(l)); })
    .then(() => { if (!quiet) broadcast(); });
  async function log(event, detail = '') {
    try {
      await run('logs', 'readwrite', (t) => {
        const s = t.objectStore('logs');
        s.add({ ts: Date.now(), event: clean(event, 40), detail: clean(detail, 200) });
        s.getAllKeys().onsuccess = (e) => {
          const keys = e.target.result;
          keys.slice(0, Math.max(0, keys.length - LIMITS.logs)).forEach((k) => s.delete(k));
        };
      });
    } catch { /* le journal ne doit jamais bloquer l'application */ }
  }
  function fail(err, ctx) {
    log('erreur', ctx + ' : ' + (err && err.name ? err.name : 'inconnue'));
    toast('Une erreur est survenue. Rechargez la page ; si elle persiste, consultez le journal.', true);
  }

  /* ---------- État ---------- */
  let links = [];
  const hay = new Map();
  const state = { q: '', collection: null, tags: new Set(), sort: 'title', allTags: false, view: 'lines', collapsed: new Set(),
                  limit: PAGE, groupLimits: new Map(), selecting: false, selected: new Set() };
  const combos = {};
  let editingId = null;
  let pendingFiles = [];
  let lastExport = null;
  let undoEntry = null, chan = null, syncTimer = null, syncPending = false;
  let currentRest = [], currentIds = new Set(), renameFrom = null, mergeFrom = null, backToMgr = false;
  const resetPaging = () => { state.limit = PAGE; state.groupLimits.clear(); };
  const viewVariant = () => (state.view === 'cards' ? 'cardfull' : state.view === 'compact' ? 'compact' : 'row');

  const reindex = (l) => hay.set(l.id, norm([l.title, l.url, l.tags.join(' '), l.note, l.collection].join(' ')));
  const hostOf = (l) => { const u = parseUrl(l.url); return u ? u.hostname : '(adresse invalide)'; };

  /* ---------- Collections : canonisation et quasi-doublons ---------- */
  const collKey = (s) => norm(s).replace(/[^a-z0-9]/g, '');
  function collectionCounts() {
    const m = new Map();
    links.forEach((l) => { if (l.collection) m.set(l.collection, (m.get(l.collection) || 0) + 1); });
    return m;
  }
  // Retourne une fonction qui ramène un nom saisi à l'orthographe d'une collection existante (casse, accents, espaces).
  function makeCanon(except) {
    const byKey = new Map();
    for (const n of collectionCounts().keys()) {
      const k = collKey(n);
      if (n !== except && k && !byKey.has(k)) byKey.set(k, n);
    }
    return (raw) => {
      const name = clean(raw, LIMITS.collection);
      const k = collKey(name);
      if (!k) return name;
      if (!byKey.has(k)) byKey.set(k, name);
      return byKey.get(k);
    };
  }
  function withinOne(a, b) {
    if (Math.abs(a.length - b.length) > 1) return false;
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1);
    return a.length > b.length ? a.slice(i + 1) === b.slice(i) : b.slice(i + 1) === a.slice(i);
  }
  function similarCollection(name) {
    const k = collKey(name);
    if (k.length < 4) return null;
    for (const n of collectionCounts().keys()) {
      const k2 = collKey(n);
      if (k2.length >= 4 && k2 !== k && withinOne(k, k2)) return n;
    }
    return null;
  }

  /* ---------- Liste déroulante accessible (combobox ARIA 1.2) ---------- */
  function attachCombobox(input, list, hintEl) {
    let active = -1;
    const close = () => { list.hidden = true; input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant'); active = -1; };
    function setActive(i) {
      active = i;
      [...list.children].forEach((li, j) => { li.setAttribute('aria-selected', String(j === i)); li.classList.toggle('active', j === i); });
      if (i >= 0) { input.setAttribute('aria-activedescendant', list.children[i].id); list.children[i].scrollIntoView({ block: 'nearest' }); }
      else input.removeAttribute('aria-activedescendant');
    }
    function updateHint() {
      hintEl.replaceChildren();
      const v = clean(input.value, LIMITS.collection);
      if (!collKey(v)) return;
      const canonical = makeCanon()(v);
      if (canonical !== v) { hintEl.append(`La collection existante « ${canonical} » sera utilisée.`); return; }
      if (collectionCounts().has(v)) return;
      const sim = similarCollection(v);
      if (sim) {
        hintEl.append(`Une collection proche existe : « ${sim} ». `,
          el('button', { className: 'linklike', attrs: { type: 'button' }, on: { click: () => { choose(sim); input.focus(); } } }, `Utiliser « ${sim} »`));
      }
    }
    function choose(name) { input.value = name; close(); updateHint(); }
    function refresh(showAll) {
      const q = clean(input.value, LIMITS.collection);
      const qk = collKey(q);
      if (!qk && !showAll) { close(); return; }
      const counts = collectionCounts();
      let names = [...counts.keys()];
      const exact = names.some((n) => collKey(n) === qk);
      if (qk) names = names.filter((n) => collKey(n).includes(qk));
      names.sort((a, b) => (collKey(b).startsWith(qk) - collKey(a).startsWith(qk)) || counts.get(b) - counts.get(a) || a.localeCompare(b, 'fr'));
      names = names.slice(0, 8);
      const nq = norm(q);
      const items = names.map((n, i) => {
        const label = el('span', {});
        if (qk && norm(n).length === n.length && norm(n).startsWith(nq)) label.append(el('b', {}, n.slice(0, q.length)), n.slice(q.length));
        else label.append(n);
        const li = el('li', { className: 'opt', attrs: { role: 'option', id: `${list.id}-o${i}`, 'aria-selected': 'false' } },
          label, el('span', { className: 'c' }, `${plural(counts.get(n), 'lien', 'liens')} · existante`));
        li.addEventListener('mousedown', (e) => e.preventDefault());
        li.addEventListener('click', () => choose(n));
        return li;
      });
      if (qk && !exact) {
        const li = el('li', { className: 'opt', attrs: { role: 'option', id: `${list.id}-o${items.length}`, 'aria-selected': 'false' } },
          el('span', {}, `Créer une nouvelle collection « ${q} »`));
        li.addEventListener('mousedown', (e) => e.preventDefault());
        li.addEventListener('click', () => choose(q));
        items.push(li);
      }
      if (!items.length) { close(); return; }
      list.replaceChildren(...items);
      list.hidden = false;
      input.setAttribute('aria-expanded', 'true');
      setActive(-1);
    }
    input.addEventListener('input', () => { refresh(false); updateHint(); });
    input.addEventListener('keydown', (e) => {
      const open = !list.hidden;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (!open) { refresh(true); if (!list.hidden) setActive(0); } else setActive((active + 1) % list.children.length);
      } else if (e.key === 'ArrowUp' && open) {
        e.preventDefault(); setActive((active - 1 + list.children.length) % list.children.length);
      } else if (e.key === 'Enter' && open && active >= 0) {
        e.preventDefault(); list.children[active].click();
      } else if (e.key === 'Escape' && open) {
        e.preventDefault(); e.stopPropagation(); close();
      }
    });
    input.addEventListener('blur', close);
    return { update: updateHint, close };
  }

  /* ---------- Retours utilisateur ---------- */
  let toastTimer;
  function toast(msg, isErr = false) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'toast show' + (isErr ? ' err' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.className = 'toast'; t.textContent = ''; }, 5000);
  }
  let liveTimer;
  function announce(msg) {
    clearTimeout(liveTimer);
    liveTimer = setTimeout(() => { $('#live').textContent = msg; }, 450);
  }
  const plural = (n, one, many) => `${n} ${n > 1 ? many : one}`;

  /* ---------- Rendu ---------- */
  function toneOf(host) {
    let h = 0;
    for (const c of host) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return h % 8;
  }
  function actionBtn(l, action, label, ic, pressed) {
    const attrs = { type: 'button', 'aria-label': label, title: label, 'data-id': l.id, 'data-action': action };
    if (pressed !== undefined) attrs['aria-pressed'] = String(pressed);
    return el('button', { className: 'icon-btn', attrs, on: { click: () => onAction(l.id, action) } }, icon(ic));
  }
  function linkNode(l, variant) {
    const u = parseUrl(l.url);
    const host = hostOf(l);
    const titleNode = u
      ? el('a', { className: 'title', attrs: { href: u.href, target: '_blank', rel: 'noopener noreferrer', 'data-id': l.id } }, l.title)
      : el('span', { className: 'title' }, l.title);
    const badge = el('span', { className: 'badge tone-' + toneOf(host), attrs: { 'aria-hidden': 'true' } }, (l.title[0] || '?'));
    const tools = el('div', { className: 'tools' },
      actionBtn(l, 'pin', l.pinned ? `Désépingler ${l.title}` : `Épingler ${l.title}`, 'pin', l.pinned),
      actionBtn(l, 'edit', `Modifier ${l.title}`, 'edit'),
      actionBtn(l, 'del', `Supprimer ${l.title}`, 'trash'));
    let sel = null;
    if (state.selecting) {
      sel = el('input', { className: 'sel', attrs: { type: 'checkbox', 'aria-label': `Sélectionner ${l.title}`, 'data-id': l.id } });
      sel.checked = state.selected.has(l.id);
      sel.addEventListener('change', () => { if (sel.checked) state.selected.add(l.id); else state.selected.delete(l.id); updateBatchBar(); });
    }
    if (variant === 'compact') {
      return el('li', { className: 'row' }, sel, badge, el('div', { className: 'body' }, titleNode, el('span', { className: 'host-r' }, host)), tools);
    }
    const meta = el('div', { className: 'meta' }, el('span', { className: 'host' }, host));
    if (variant === 'row' || variant === 'cardfull') {
      if (l.collection) meta.append(el('span', { className: 'pill' }, l.collection));
      l.tags.forEach((t) => meta.append(el('span', { className: 'pill' }, '#' + t)));
    }
    const body = el('div', { className: 'body' }, titleNode, meta);
    if (variant === 'row' && l.note) body.append(el('p', { className: 'note' }, l.note));
    if (variant === 'cardfull') return el('li', { className: 'card card-full' }, el('div', { className: 'head' }, el('div', { className: 'lead' }, sel, badge), tools), body);
    return el('li', { className: variant === 'card' ? 'card' : 'row' }, sel, badge, body, tools);
  }

  function visible(l, terms) {
    if (state.collection === NONE) { if (l.collection) return false; }
    else if (state.collection !== null && l.collection !== state.collection) return false;
    for (const t of state.tags) if (!l.tags.includes(t)) return false;
    if (terms.length) { const h = hay.get(l.id) || ''; return terms.every((t) => h.includes(t)); }
    return true;
  }
  function comparator() {
    const byTitle = (a, b) => a.title.localeCompare(b.title, 'fr', { sensitivity: 'base' });
    if (state.sort === 'recent') return (a, b) => b.createdAt - a.createdAt || byTitle(a, b);
    if (state.sort === 'used') return (a, b) => b.visits - a.visits || byTitle(a, b);
    return byTitle;
  }

  function renderFilters() {
    const counts = new Map();
    let none = 0;
    links.forEach((l) => { if (l.collection) counts.set(l.collection, (counts.get(l.collection) || 0) + 1); else none++; });
    const names = [...counts.keys()].sort((a, b) => a.localeCompare(b, 'fr', { sensitivity: 'base' }));
    const chip = (label, n, value) => {
      const pressed = state.collection === value;
      const b = el('button', { className: 'chip', attrs: { type: 'button', 'aria-pressed': String(pressed) } },
        label, el('span', { className: 'n' }, String(n)), el('span', { className: 'sr-only' }, n > 1 ? ' liens' : ' lien'));
      b.addEventListener('click', () => { state.collection = value; resetPaging(); render({ announce: true, keepFocus: '#collections .chip[aria-pressed="true"]' }); });
      return el('li', {}, b);
    };
    const items = [chip('Tout', links.length, null), ...names.map((n) => chip(n, counts.get(n), n))];
    if (none && names.length) items.push(chip('Sans collection', none, NONE));
    $('#collections').replaceChildren(...items);
    $('#btn-rename').hidden = !(state.collection && state.collection !== NONE);

    const tc = new Map();
    links.forEach((l) => {
      if (state.collection === NONE ? l.collection : (state.collection !== null && l.collection !== state.collection)) return;
      l.tags.forEach((t) => tc.set(t, (tc.get(t) || 0) + 1));
    });
    const sorted = [...tc.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'fr'));
    let shown = state.allTags ? sorted : sorted.slice(0, 10);
    if (!state.allTags) state.tags.forEach((t) => { if (!shown.some((x) => x[0] === t)) shown.push([t, tc.get(t) || 0]); });
    const btns = shown.map(([t, n]) => {
      const b = el('button', { className: 'tagbtn', attrs: { type: 'button', 'aria-pressed': String(state.tags.has(t)) } }, '#' + t, ` (${n})`);
      b.addEventListener('click', () => {
        state.tags.has(t) ? state.tags.delete(t) : state.tags.add(t);
        resetPaging();
        render({ announce: true, keepFocus: `.tagbtn[aria-pressed]` });
      });
      return b;
    });
    if (sorted.length > 10) {
      const more = el('button', { className: 'tagbtn more', attrs: { type: 'button', 'aria-expanded': String(state.allTags) } },
        state.allTags ? 'Moins de tags' : `Tous les tags (${sorted.length})`);
      more.addEventListener('click', () => { state.allTags = !state.allTags; render({ keepFocus: '.tagbtn.more' }); });
      btns.push(more);
    }
    $('#tagbar').replaceChildren(...btns);
    $('#tagbar').hidden = btns.length === 0;
  }

  function render(opts = {}) {
    const terms = norm(state.q).split(/\s+/).filter(Boolean);
    const filtered = links.filter((l) => visible(l, terms)).sort(comparator());
    const defaultView = !terms.length && state.collection === null && state.tags.size === 0;
    const pinned = defaultView ? filtered.filter((l) => l.pinned) : [];
    const rest = defaultView ? filtered.filter((l) => !l.pinned) : filtered;
    currentRest = rest; currentIds = new Set(filtered.map((l) => l.id));

    $('#total-count').textContent = links.length ? plural(links.length, 'lien enregistré', 'liens enregistrés') : 'Aucun lien pour l’instant';
    $('#pinned-section').hidden = pinned.length === 0;
    $('#pinned').replaceChildren(...pinned.map((l) => linkNode(l, 'card')));
    const list = $('#liste'), groups = $('#groups');
    list.className = state.view === 'cards' ? 'cards main' : state.view === 'compact' ? 'rows compact' : 'rows';
    if (state.view === 'grouped') {
      list.hidden = true; list.replaceChildren();
      groups.hidden = false; renderGroups(rest, defaultView);
    } else {
      groups.hidden = true; groups.replaceChildren();
      list.hidden = false;
      const v = viewVariant();
      list.replaceChildren(...rest.slice(0, state.limit).map((l) => linkNode(l, v)));
    }
    renderMore(rest.length, Math.min(state.limit, rest.length));
    paintViews();
    updateBatchBar();

    let heading = 'Tous les liens';
    if (terms.length) heading = 'Résultats';
    else if (state.collection === NONE) heading = 'Sans collection';
    else if (state.collection) heading = state.collection;
    else if (pinned.length) heading = 'Autres liens';
    $('#h-list').textContent = heading;

    renderFilters();
    renderEmpty(filtered.length);
    renderBackupInfo();

    if (opts.focus) {
      const sel = `[data-id="${CSS.escape(opts.focus.id)}"][data-action="${opts.focus.action}"]`;
      const t = $(sel);
      if (t) t.focus(); else { const h = $('#h-list'); h.setAttribute('tabindex', '-1'); h.focus(); }
    } else if (opts.keepFocus) {
      const t = $(opts.keepFocus); if (t) t.focus();
    }
    if (opts.announce) announce(opts.announceText || (filtered.length ? plural(filtered.length, 'lien affiché', 'liens affichés') : 'Aucun lien ne correspond'));
  }

  const VIEW_LABELS = { cards: 'cartes', lines: 'lignes', compact: 'compact', grouped: 'groupé par collection' };
  function paintViews() {
    document.querySelectorAll('#views [data-view]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === state.view)));
    const fold = $('#btn-fold');
    fold.hidden = state.view !== 'grouped';
    const anyOpen = [...document.querySelectorAll('.gtoggle')].some((b) => b.getAttribute('aria-expanded') === 'true');
    fold.textContent = anyOpen ? 'Tout replier' : 'Tout déplier';
  }
  function setView(v) {
    if (!VIEWS.includes(v)) return;
    state.view = v;
    resetPaging();
    try { localStorage.setItem('pl-view', v); } catch { /* préférence non conservée */ }
    render({ announce: true, announceText: `Affichage : ${VIEW_LABELS[v]}` });
  }
  function renderGroups(items, allowCollapse) {
    const by = new Map();
    items.forEach((l) => { const k = l.collection || ''; if (!by.has(k)) by.set(k, []); by.get(k).push(l); });
    const keys = [...by.keys()].sort((a, b) => (a === '') - (b === '') || a.localeCompare(b, 'fr', { sensitivity: 'base' }));
    const nodes = keys.map((k, i) => {
      const id = 'grp-' + i;
      const collapsed = allowCollapse && state.collapsed.has(k);
      const arr = by.get(k);
      const limit = state.groupLimits.get(k) || PAGE;
      const ul = el('ul', { className: 'rows compact', attrs: { id } }, ...arr.slice(0, limit).map((l) => linkNode(l, 'compact')));
      ul.hidden = collapsed;
      const moreBtn = el('button', { className: 'btn btn-quiet more-grp', attrs: { type: 'button' } });
      const paintMore = () => {
        const shown = ul.children.length;
        moreBtn.hidden = shown >= arr.length || ul.hidden;
        moreBtn.textContent = `Afficher ${Math.min(PAGE, arr.length - shown)} liens de plus (${shown} sur ${arr.length})`;
      };
      moreBtn.addEventListener('click', () => {
        const from = ul.children.length, next = Math.min(arr.length, from + PAGE);
        const nodes = arr.slice(from, next).map((l) => linkNode(l, 'compact'));
        ul.append(...nodes);
        state.groupLimits.set(k, next);
        paintMore();
        const f = nodes[0] && nodes[0].querySelector('a.title, button');
        if (f) f.focus();
        announce(`${plural(nodes.length, 'lien supplémentaire affiché', 'liens supplémentaires affichés')} : ${next} sur ${arr.length}`);
      });
      const btn = el('button', { className: 'gtoggle', attrs: { type: 'button', 'aria-expanded': String(!collapsed), 'aria-controls': id } },
        el('span', { className: 'caret', attrs: { 'aria-hidden': 'true' } }, collapsed ? '\u25B8' : '\u25BE'),
        el('span', { className: 'gname' }, k || 'Sans collection'),
        el('span', { className: 'n' }, `(${arr.length})`));
      btn.addEventListener('click', () => {
        const open = btn.getAttribute('aria-expanded') === 'true';
        if (open) state.collapsed.add(k); else state.collapsed.delete(k);
        btn.setAttribute('aria-expanded', String(!open));
        btn.firstChild.textContent = open ? '\u25B8' : '\u25BE';
        ul.hidden = open;
        paintMore();
        paintViews();
      });
      paintMore();
      return el('section', { className: 'group' }, el('h3', { className: 'ghead' }, btn), ul, moreBtn);
    });
    $('#groups').replaceChildren(...nodes);
  }
  function toggleAllGroups() {
    const toggles = [...document.querySelectorAll('.gtoggle')];
    const anyOpen = toggles.some((b) => b.getAttribute('aria-expanded') === 'true');
    toggles.forEach((b) => { if ((b.getAttribute('aria-expanded') === 'true') === anyOpen) b.click(); });
  }

  function renderEmpty(n) {
    const box = $('#empty');
    if (links.length === 0) {
      box.replaceChildren(
        el('h3', {}, 'Commencez par vos favoris'),
        el('p', {}, 'Importez l’export de votre navigateur ou vos raccourcis du bureau, ou ajoutez un premier lien.'),
        el('button', { className: 'btn btn-primary', attrs: { type: 'button' }, on: { click: openImport } }, 'Importer des liens'),
        el('button', { className: 'btn', attrs: { type: 'button' }, on: { click: () => openLinkDialog() } }, 'Ajouter un lien'));
      box.hidden = false;
    } else if (n === 0) {
      box.replaceChildren(
        el('h3', {}, 'Aucun résultat'),
        el('p', {}, 'Essayez d’autres mots ou retirez un filtre.'),
        el('button', { className: 'btn', attrs: { type: 'button' }, on: { click: resetFilters } }, 'Réinitialiser les filtres'));
      box.hidden = false;
    } else box.hidden = true;
  }
  function resetFilters() {
    state.q = ''; state.collection = null; state.tags.clear(); resetPaging();
    $('#q').value = '';
    render({ announce: true, keepFocus: '#q' });
  }
  function renderBackupInfo() {
    const n = $('#backup-info');
    if (!links.length) { n.textContent = ''; return; }
    if (!lastExport) { n.textContent = 'Aucune sauvegarde exportée. Pensez à exporter régulièrement vos liens.'; return; }
    const days = Math.floor((Date.now() - lastExport) / 86400000);
    const d = new Date(lastExport).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
    n.textContent = `Dernière sauvegarde : ${d}.` + (days > 30 ? ' Elle date de plus de 30 jours : pensez à exporter à nouveau.' : '');
  }

  /* ---------- Actions sur un lien ---------- */
  async function onAction(id, action) {
    const l = links.find((x) => x.id === id);
    if (!l) return;
    try {
      if (action === 'pin') {
        l.pinned = !l.pinned; l.updatedAt = Date.now();
        await putLinks([l]);
        render({ focus: { id, action: 'pin' } });
        toast(l.pinned ? 'Lien épinglé' : 'Lien désépinglé');
      } else if (action === 'edit') {
        openLinkDialog(l);
      } else if (action === 'del') {
        await applyChanges('suppression d\u2019un lien', [], [id], 'suppression : 1 lien');
        render();
        const h = $('#h-list'); h.setAttribute('tabindex', '-1'); h.focus();
        toast('Lien supprimé. Vous pouvez annuler.');
      }
    } catch (e) { fail(e, 'action-' + action); }
  }

  function confirmDialog(title, text) {
    return new Promise((resolve) => {
      const dlg = $('#dlg-confirm'), form = $('#form-confirm');
      $('#dlg-confirm-title').textContent = title;
      $('#confirm-text').textContent = text;
      let ok = false;
      const onSubmit = (e) => { e.preventDefault(); ok = true; dlg.close(); };
      form.addEventListener('submit', onSubmit, { once: true });
      dlg.addEventListener('close', () => { form.removeEventListener('submit', onSubmit); resolve(ok); }, { once: true });
      dlg.showModal();
    });
  }

  /* ---------- Formulaire d'ajout / modification ---------- */
  function setUrlError(msg) {
    const i = $('#f-url');
    $('#err-url').textContent = msg || '';
    if (msg) i.setAttribute('aria-invalid', 'true'); else i.removeAttribute('aria-invalid');
  }
  function openLinkDialog(l) {
    editingId = l ? l.id : null;
    $('#dlg-link-title').textContent = l ? 'Modifier le lien' : 'Ajouter un lien';
    $('#f-url').value = l ? l.url : '';
    $('#f-title').value = l ? l.title : '';
    $('#f-collection').value = l ? l.collection : (state.collection && state.collection !== NONE ? state.collection : '');
    $('#f-tags').value = l ? l.tags.join(', ') : '';
    $('#f-note').value = l ? l.note : '';
    $('#f-pinned').checked = l ? l.pinned : false;
    setUrlError('');
    combos.link.close(); combos.link.update();
    $('#dlg-link').showModal();
    $('#f-url').focus();
  }
  async function saveLink(e) {
    e.preventDefault();
    const raw = $('#f-url').value;
    const u = parseUrl(raw);
    if (!u) {
      setUrlError(raw.trim() ? 'Adresse non valide. Utilisez une adresse http ou https, sans identifiant ni mot de passe.' : 'Saisissez une adresse.');
      $('#f-url').focus();
      return;
    }
    const key = urlKey(u);
    const dup = links.find((x) => x.urlKey === key && x.id !== editingId);
    if (dup) { setUrlError(`Cette adresse existe déjà : « ${dup.title} ».`); $('#f-url').focus(); return; }
    if (!editingId && links.length >= LIMITS.total) { setUrlError('Limite de liens atteinte.'); return; }
    const old = editingId ? links.find((x) => x.id === editingId) : null;
    const nl = buildLink({
      url: u.href, title: $('#f-title').value, collection: makeCanon()($('#f-collection').value), tags: $('#f-tags').value,
      note: $('#f-note').value, pinned: $('#f-pinned').checked,
      createdAt: old ? old.createdAt : undefined, visits: old ? old.visits : 0
    });
    if (old) nl.id = old.id;
    try {
      await putLinks([nl]);
      if (old) links[links.indexOf(old)] = nl; else links.push(nl);
      reindex(nl);
      log(old ? 'modification' : 'ajout', '1 lien');
      $('#dlg-link').close();
      render({ focus: { id: nl.id, action: 'edit' } });
      toast(old ? 'Lien modifié' : 'Lien ajouté');
    } catch (err) { fail(err, 'enregistrement'); }
  }

  /* ---------- Import ---------- */
  function folderPath(a) {
    const names = [];
    let dl = a.closest('dl');
    while (dl) {
      let h = dl.previousElementSibling;
      if (!(h && h.tagName === 'H3')) {
        const p = dl.parentElement;
        h = p && p.tagName === 'DT' ? [...p.children].find((c) => c.tagName === 'H3') : null;
      }
      if (h) names.unshift(h.textContent.trim());
      dl = dl.parentElement ? dl.parentElement.closest('dl') : null;
    }
    return names.filter((n) => n && !ROOT_FOLDERS.test(n)).slice(-2).join(' / ');
  }
  function parseBookmarks(text) {
    const doc = new DOMParser().parseFromString(text, 'text/html'); // document inerte : aucun script exécuté
    const out = [];
    doc.querySelectorAll('a[href]').forEach((a) => {
      out.push({ title: a.textContent, url: a.getAttribute('href'), collection: folderPath(a),
                 createdAt: Number(a.getAttribute('add_date')) * 1000 });
    });
    return out;
  }
  function parseUrlFile(text, name) {
    const m = /^\s*URL\s*=\s*(.+?)\s*$/im.exec(text);
    return m ? [{ title: name.replace(/\.url$/i, ''), url: m[1], collection: '' }] : [];
  }
  function parseWebloc(text, name) {
    const doc = new DOMParser().parseFromString(text, 'text/xml');
    if (doc.querySelector('parsererror')) return [];
    const key = [...doc.querySelectorAll('key')].find((k) => k.textContent === 'URL');
    const val = key && key.nextElementSibling;
    return val && val.tagName === 'string' ? [{ title: name.replace(/\.webloc$/i, ''), url: val.textContent, collection: '' }] : [];
  }
  function parsePaste(text) {
    const out = [];
    for (const line of text.split(/\r?\n/)) {
      const m = /https?:\/\/[^\s<>"']+/i.exec(line);
      if (!m) continue;
      const before = line.slice(0, m.index).replace(/[\s|\-–—:>]+$/, '').trim();
      out.push({ title: before, url: m[0], collection: '' });
    }
    return out;
  }
  function parseBackup(text) {
    let data;
    try { data = JSON.parse(text); } catch { return null; }
    if (!data || data.app !== 'portail-liens' || !Array.isArray(data.links)) return null;
    return data.links.slice(0, LIMITS.importBatch).map((x) => ({ ...(x && typeof x === 'object' ? x : {}), keepCollection: true }));
  }

  function openImport() {
    pendingFiles = [];
    $('#f-files').value = '';
    $('#f-paste').value = '';
    $('#f-default-coll').value = '';
    combos.imp.close(); combos.imp.update();
    $('#files-info').textContent = 'ou glissez-les ici';
    $('#import-result').textContent = '';
    $('#dlg-import').showModal();
  }
  function setFiles(list) {
    pendingFiles = [...list];
    $('#files-info').textContent = pendingFiles.length ? plural(pendingFiles.length, 'fichier sélectionné', 'fichiers sélectionnés') : 'ou glissez-les ici';
  }
  async function doImport(e) {
    e.preventDefault();
    const res = $('#import-result');
    res.textContent = 'Import en cours…';
    const stats = { added: 0, dup: 0, invalid: 0, badFiles: 0 };
    try {
      const cands = [];
      for (const f of pendingFiles) {
        const name = f.name.toLowerCase();
        if (f.size > LIMITS.file) { stats.badFiles++; continue; }
        const text = await f.text();
        let r = null;
        if (name.endsWith('.html') || name.endsWith('.htm')) r = parseBookmarks(text);
        else if (name.endsWith('.url')) r = parseUrlFile(text, f.name);
        else if (name.endsWith('.webloc')) r = parseWebloc(text, f.name);
        else if (name.endsWith('.json')) r = parseBackup(text);
        if (r === null) stats.badFiles++; else cands.push(...r);
      }
      const pasted = $('#f-paste').value;
      if (pasted.trim()) cands.push(...parsePaste(pasted));
      if (!cands.length) {
        res.textContent = stats.badFiles ? 'Aucun lien exploitable dans ces fichiers (format non pris en charge, trop volumineux ou illisible).'
                                         : 'Rien à importer : choisissez un fichier ou collez des adresses.';
        return;
      }
      if (cands.length > LIMITS.importBatch) { res.textContent = `Trop de liens d’un coup (maximum ${LIMITS.importBatch}). Importez en plusieurs fois.`; return; }
      const canon = makeCanon();
      const defColl = canon($('#f-default-coll').value || 'À trier');
      const seen = new Set(links.map((l) => l.urlKey));
      const fresh = [];
      for (const c of cands) {
        const src = (c.keepCollection || c.collection) ? { ...c, collection: canon(c.collection) } : { ...c, collection: defColl };
        const l = buildLink(src);
        if (!l) { stats.invalid++; continue; }
        if (seen.has(l.urlKey)) { stats.dup++; continue; }
        if (links.length + fresh.length >= LIMITS.total) { stats.invalid++; continue; }
        seen.add(l.urlKey); fresh.push(l);
      }
      if (fresh.length) await putLinks(fresh);
      fresh.forEach((l) => { links.push(l); reindex(l); });
      stats.added = fresh.length;
      log('import', `${stats.added} ajoutés, ${stats.dup} doublons, ${stats.invalid} invalides, ${stats.badFiles} fichiers refusés`);
      res.textContent = `${plural(stats.added, 'lien ajouté', 'liens ajoutés')}, ${plural(stats.dup, 'doublon ignoré', 'doublons ignorés')}, ${plural(stats.invalid, 'adresse invalide ignorée', 'adresses invalides ignorées')}`
        + (stats.badFiles ? `, ${plural(stats.badFiles, 'fichier refusé', 'fichiers refusés')}` : '') + '.';
      pendingFiles = []; $('#f-files').value = ''; $('#f-paste').value = ''; $('#files-info').textContent = 'ou glissez-les ici';
      render();
    } catch (err) { fail(err, 'import'); res.textContent = 'L’import a échoué. Aucun lien partiel n’a été enregistré par cette étape.'; }
  }

  /* ---------- Export ---------- */

  /* ---------- Modifications annulables, synchronisation entre onglets ---------- */
  function broadcast(kind = 'changed') {
    try { if (chan) chan.postMessage({ app: 'portail-liens', kind }); } catch { /* sans incidence */ }
  }
  async function applyChanges(label, updates, deletions, logDetail) {
    const byId = new Map(links.map((l) => [l.id, l]));
    const before = [];
    updates.forEach((n) => { const o = byId.get(n.id); if (o) before.push(o); });
    deletions.forEach((id) => { const o = byId.get(id); if (o) before.push(o); });
    await run('links', 'readwrite', (t) => {
      const st = t.objectStore('links');
      updates.forEach((n) => st.put(n));
      deletions.forEach((id) => st.delete(id));
    });
    updates.forEach((n) => { byId.set(n.id, n); reindex(n); });
    deletions.forEach((id) => { byId.delete(id); hay.delete(id); state.selected.delete(id); });
    links = [...byId.values()];
    undoEntry = { label, restore: before };
    paintUndo();
    broadcast();
    log('lot', logDetail || label);
  }
  function paintUndo() {
    const b = $('#btn-undo');
    b.hidden = !undoEntry;
    if (undoEntry) b.textContent = `Annuler : ${undoEntry.label}`;
  }
  async function doUndo() {
    if (!undoEntry) return;
    const e = undoEntry;
    try {
      await run('links', 'readwrite', (t) => { const st = t.objectStore('links'); e.restore.forEach((r) => st.put(r)); });
      const byId = new Map(links.map((l) => [l.id, l]));
      e.restore.forEach((r) => { byId.set(r.id, r); reindex(r); });
      links = [...byId.values()];
      undoEntry = null;
      paintUndo();
      broadcast();
      log('annulation', e.label.split(' ')[0]);
      render();
      toast(`Annulé : ${e.label}`);
    } catch (err) { fail(err, 'annulation'); }
  }
  const signature = (arr) => `${arr.length}:${arr.reduce((m, l) => Math.max(m, l.updatedAt), 0)}:${arr.reduce((s, l) => s + l.updatedAt, 0)}`;
  function scheduleSync() { clearTimeout(syncTimer); syncTimer = setTimeout(syncFromDb, 250); }
  async function syncFromDb() {
    if (!db) return;
    if (document.querySelector('dialog[open]')) { syncPending = true; return; }
    try {
      const rows = await run('links', 'readonly', (t) => reqP(t.objectStore('links').getAll()));
      const fresh = rows.map(coerceStored).filter(Boolean);
      if (signature(fresh) === signature(links)) return;
      links = fresh;
      hay.clear(); links.forEach(reindex);
      const ids = new Set(links.map((l) => l.id));
      [...state.selected].forEach((id) => { if (!ids.has(id)) state.selected.delete(id); });
      undoEntry = null; paintUndo();
      render();
      announce('La liste a été mise à jour depuis un autre onglet.');
    } catch { /* la synchronisation est facultative */ }
  }

  /* ---------- Chargement progressif ---------- */
  function renderMore(total, shown) {
    const box = $('#more');
    if (state.view === 'grouped' || shown >= total) { box.hidden = true; return; }
    $('#btn-more').textContent = `Afficher ${Math.min(PAGE, total - shown)} liens de plus (${shown} sur ${total})`;
    $('#btn-all').textContent = `Tout afficher (${total})`;
    box.hidden = false;
  }
  function loadMore(all) {
    const list = $('#liste');
    const from = list.children.length;
    const next = all ? currentRest.length : Math.min(currentRest.length, from + PAGE);
    if (next <= from) return;
    const v = viewVariant();
    const nodes = currentRest.slice(from, next).map((l) => linkNode(l, v));
    list.append(...nodes);
    state.limit = next;
    renderMore(currentRest.length, next);
    const f = nodes[0].querySelector('a.title, button');
    if (f) f.focus();
    announce(`${plural(nodes.length, 'lien supplémentaire affiché', 'liens supplémentaires affichés')} : ${next} sur ${currentRest.length}`);
  }

  /* ---------- Mode sélection et actions en lot ---------- */
  function updateBatchBar() {
    $('#batchbar').hidden = !state.selecting;
    if (!state.selecting) return;
    const n = state.selected.size;
    const hidden = [...state.selected].filter((id) => !currentIds.has(id)).length;
    $('#bb-count').textContent = (n ? plural(n, 'lien sélectionné', 'liens sélectionnés') : 'Aucun lien sélectionné')
      + (hidden ? ` (dont ${hidden} masqué${hidden > 1 ? 's' : ''} par les filtres)` : '');
    const all = currentIds.size > 0 && [...currentIds].every((id) => state.selected.has(id));
    $('#bb-all').textContent = all ? 'Tout désélectionner' : 'Tout sélectionner';
  }
  function syncChecks() {
    document.querySelectorAll('input.sel').forEach((c) => { c.checked = state.selected.has(c.getAttribute('data-id')); });
  }
  function setSelecting(on) {
    state.selecting = on;
    if (!on) state.selected.clear();
    document.body.classList.toggle('selecting', on);
    document.documentElement.classList.toggle('selecting', on);
    const b = $('#btn-select');
    b.setAttribute('aria-pressed', String(on));
    b.textContent = on ? 'Terminer la sélection' : 'Sélectionner';
    render({ keepFocus: '#btn-select' });
    announce(on ? 'Mode sélection activé' : 'Mode sélection terminé');
  }
  function requireSelection() {
    if (state.selected.size) return true;
    toast('Sélectionnez d’abord au moins un lien.', true);
    return false;
  }
  const selectedLinks = () => { const byId = new Map(links.map((l) => [l.id, l])); return [...state.selected].map((id) => byId.get(id)).filter(Boolean); };
  function openMove() {
    if (!requireSelection()) return;
    $('#move-info').textContent = plural(state.selected.size, 'lien sélectionné', 'liens sélectionnés') + '.';
    $('#f-move').value = '';
    combos.move.close(); combos.move.update();
    $('#dlg-move').showModal();
    $('#f-move').focus();
  }
  async function doMove(e) {
    e.preventDefault();
    const to = makeCanon()($('#f-move').value);
    const now = Date.now();
    const upd = selectedLinks().filter((l) => l.collection !== to).map((l) => ({ ...l, collection: to, updatedAt: now }));
    $('#dlg-move').close();
    if (!upd.length) { toast('Aucun changement : les liens sont déjà dans cette collection.'); return; }
    try {
      await applyChanges(`déplacement de ${plural(upd.length, 'lien', 'liens')}`, upd, [], `déplacement : ${plural(upd.length, 'lien', 'liens')}`);
      render({ announce: true, announceText: `${plural(upd.length, 'lien déplacé', 'liens déplacés')}` });
      toast(`${plural(upd.length, 'lien déplacé', 'liens déplacés')}. Vous pouvez annuler.`);
    } catch (err) { fail(err, 'déplacement'); }
  }
  function openTags() {
    if (!requireSelection()) return;
    $('#tags-info').textContent = plural(state.selected.size, 'lien sélectionné', 'liens sélectionnés') + '.';
    $('#f-btags').value = '';
    $('#f-btags').removeAttribute('aria-invalid'); $('#err-btags').textContent = '';
    $('#t-add').checked = true;
    $('#dlg-tags').showModal();
    $('#f-btags').focus();
  }
  async function doTags(e) {
    e.preventDefault();
    const tags = cleanTags($('#f-btags').value);
    if (!tags.length) {
      $('#err-btags').textContent = 'Saisissez au moins un tag.';
      $('#f-btags').setAttribute('aria-invalid', 'true'); $('#f-btags').focus();
      return;
    }
    const add = $('#t-add').checked;
    const now = Date.now();
    const upd = [];
    selectedLinks().forEach((l) => {
      const nt = add ? cleanTags([...l.tags, ...tags]) : l.tags.filter((t) => !tags.includes(t));
      if (nt.join('\u0000') !== l.tags.join('\u0000')) upd.push({ ...l, tags: nt, updatedAt: now });
    });
    $('#dlg-tags').close();
    if (!upd.length) { toast('Aucun changement.'); return; }
    try {
      const lab = `${add ? 'ajout' : 'retrait'} de tags sur ${plural(upd.length, 'lien', 'liens')}`;
      await applyChanges(lab, upd, [], lab);
      render({ announce: true, announceText: `${plural(upd.length, 'lien modifié', 'liens modifiés')}` });
      toast(`${plural(upd.length, 'lien modifié', 'liens modifiés')}. Vous pouvez annuler.`);
    } catch (err) { fail(err, 'tags'); }
  }
  async function batchDelete() {
    if (!requireSelection()) return;
    const ids = [...state.selected];
    try {
      await applyChanges(`suppression de ${plural(ids.length, 'lien', 'liens')}`, [], ids, `suppression : ${plural(ids.length, 'lien', 'liens')}`);
      render({ keepFocus: '#bb-all' });
      toast(`${plural(ids.length, 'lien supprimé', 'liens supprimés')}. Vous pouvez annuler.`);
    } catch (err) { fail(err, 'suppression-lot'); }
  }

  /* ---------- Gestion des collections ---------- */
  function backToManager() { if (backToMgr) { backToMgr = false; openCollections(); } }
  function openCollections() {
    const counts = collectionCounts();
    const names = [...counts.keys()].sort((a, b) => a.localeCompare(b, 'fr', { sensitivity: 'base' }));
    $('#coll-empty').hidden = names.length > 0;
    const rowBtn = (label, text, fn) => el('button', { className: 'btn', attrs: { type: 'button', 'aria-label': label }, on: { click: fn } }, text);
    $('#coll-list').replaceChildren(...names.map((n) => el('li', {},
      el('span', { className: 'cname' }, n),
      el('span', { className: 'n' }, plural(counts.get(n), 'lien', 'liens')),
      rowBtn(`Renommer la collection ${n}`, 'Renommer', () => openRename(n, true)),
      names.length > 1 ? rowBtn(`Fusionner la collection ${n} dans une autre`, 'Fusionner', () => openMerge(n)) : null,
      rowBtn(`Supprimer la collection ${n}`, 'Supprimer', () => deleteCollection(n)))));
    const dlg = $('#dlg-colls');
    if (!dlg.open) dlg.showModal();
  }
  function openRename(from, back) {
    renameFrom = from; backToMgr = back;
    if (back) $('#dlg-colls').close();
    $('#f-rename').value = from;
    $('#dlg-rename').showModal();
    $('#f-rename').focus();
  }
  function openMerge(from) {
    mergeFrom = from; backToMgr = true;
    $('#dlg-colls').close();
    const others = [...collectionCounts().keys()].filter((n) => n !== from).sort((a, b) => a.localeCompare(b, 'fr', { sensitivity: 'base' }));
    $('#f-merge').replaceChildren(...others.map((n) => el('option', { attrs: { value: n } }, n)));
    $('#merge-label').textContent = `Fusionner « ${from} » dans`;
    $('#dlg-merge').showModal();
    $('#f-merge').focus();
  }
  async function changeCollection(from, to, label, logKind) {
    const target = to ? makeCanon(from)(to) : '';
    if (target === from) return 0;
    const now = Date.now();
    const upd = links.filter((l) => l.collection === from).map((l) => ({ ...l, collection: target, updatedAt: now }));
    if (!upd.length) return 0;
    await applyChanges(label, upd, [], `${logKind} : ${plural(upd.length, 'lien', 'liens')}`);
    if (state.collection === from) state.collection = target || null;
    state.collapsed.delete(from);
    resetPaging();
    render({ announce: true });
    return upd.length;
  }
  async function renameCollection(e) {
    e.preventDefault();
    const from = renameFrom;
    if (!from) return;
    const to = clean($('#f-rename').value, LIMITS.collection);
    const back = backToMgr; backToMgr = false;   // le gestionnaire ne se rouvre qu'une fois la liste à jour
    $('#dlg-rename').close();
    try {
      const n = await changeCollection(from, to, `${to ? 'renommage' : 'retrait'} de la collection « ${from} »`, 'renommage');
      if (n) toast('Collection mise à jour. Vous pouvez annuler.');
    } catch (err) { fail(err, 'renommage'); }
    if (back) openCollections();
  }
  async function doMerge(e) {
    e.preventDefault();
    const from = mergeFrom, to = $('#f-merge').value;
    const back = backToMgr; backToMgr = false;
    $('#dlg-merge').close();
    if (!from || !to) { if (back) openCollections(); return; }
    try {
      const n = await changeCollection(from, to, `fusion de « ${from} » dans « ${to} »`, 'fusion');
      if (n) toast('Collections fusionnées. Vous pouvez annuler.');
    } catch (err) { fail(err, 'fusion'); }
    if (back) openCollections();
  }
  async function deleteCollection(name) {
    $('#dlg-colls').close();
    const n = collectionCounts().get(name) || 0;
    const ok = await confirmDialog(`Supprimer la collection « ${name} » ?`,
      `Ses ${plural(n, 'lien', 'liens')} ${n > 1 ? 'sont conservés' : 'est conservé'} et passent dans « Sans collection ».`);
    try {
      if (ok) {
        await changeCollection(name, '', `suppression de la collection « ${name} »`, 'suppression de collection');
        toast('Collection supprimée. Vous pouvez annuler.');
      }
    } catch (err) { fail(err, 'suppression-collection'); }
    openCollections();
  }

  /* ---------- Export (JSON complet, favoris HTML) ---------- */
  function download(blob, name) {
    const href = URL.createObjectURL(blob);
    const a = el('a', { attrs: { href, download: name } });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(href), 2000);
  }
  const today = () => new Date().toISOString().slice(0, 10);
  async function exportJson() {
    try {
      const data = { app: 'portail-liens', schema: 1, version: APP_VERSION, exportedAt: new Date().toISOString(),
                     links: links.map(({ id, title, url, collection, tags, note, pinned, visits, createdAt }) => ({ id, title, url, collection, tags, note, pinned, visits, createdAt })) };
      download(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), `portail-liens-${today()}.json`);
      lastExport = Date.now();
      await run('meta', 'readwrite', (t) => { t.objectStore('meta').put({ key: 'lastExport', value: lastExport }); });
      log('export', `json, ${plural(links.length, 'lien', 'liens')}`);
      renderBackupInfo();
      toast('Sauvegarde exportée');
    } catch (e) { fail(e, 'export'); }
  }
  const escHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  function bookmarksHtml() {
    const byTitle = (a, b) => a[0].title.localeCompare(b[0].title, 'fr', { sensitivity: 'base' });
    const by = new Map();
    links.forEach((l) => {
      const u = parseUrl(l.url);
      if (!u) return;
      const k = l.collection || '';
      if (!by.has(k)) by.set(k, []);
      by.get(k).push([l, u]);
    });
    const item = ([l, u]) => `<DT><A HREF="${escHtml(u.href)}" ADD_DATE="${Math.floor(l.createdAt / 1000)}"${l.tags.length ? ` TAGS="${escHtml(l.tags.join(','))}"` : ''}>${escHtml(l.title)}</A>`;
    const out = ['<!DOCTYPE NETSCAPE-Bookmark-file-1>', '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">', '<TITLE>Bookmarks</TITLE>', '<H1>Bookmarks</H1>', '<DL><p>'];
    [...by.keys()].filter(Boolean).sort((a, b) => a.localeCompare(b, 'fr', { sensitivity: 'base' })).forEach((n) => {
      out.push(`<DT><H3>${escHtml(n)}</H3>`, '<DL><p>', ...by.get(n).sort(byTitle).map(item), '</DL><p>');
    });
    (by.get('') || []).sort(byTitle).forEach((x) => out.push(item(x)));
    out.push('</DL><p>');
    return out.join('\n');
  }
  function exportHtml() {
    try {
      download(new Blob([bookmarksHtml()], { type: 'text/html' }), `portail-liens-favoris-${today()}.html`);
      log('export', 'html');
      toast('Favoris HTML exportés');
    } catch (e) { fail(e, 'export-html'); }
  }

  /* ---------- Stockage persistant (sur demande) ---------- */
  async function paintPersist() {
    const info = $('#persist-info'), btn = $('#btn-persist');
    if (!(navigator.storage && navigator.storage.persisted)) { info.textContent = ''; btn.hidden = true; return; }
    try {
      const p = await navigator.storage.persisted();
      info.textContent = p ? 'Stockage protégé contre l’effacement automatique.' : 'Stockage non protégé : le navigateur peut l’effacer s’il manque d’espace.';
      btn.hidden = p || !navigator.storage.persist;
    } catch { info.textContent = ''; btn.hidden = true; }
  }
  async function askPersist() {
    try {
      const ok = await navigator.storage.persist();
      log('stockage', ok ? 'protégé' : 'refusé');
      toast(ok ? 'Stockage protégé.' : 'Le navigateur n’a pas accordé la protection. Exportez régulièrement vos liens.', !ok);
      paintPersist();
    } catch (e) { fail(e, 'persistance'); }
  }

  /* ---------- Effacement complet (double vérification) ---------- */
  function paintEraseBackup() {
    $('#erase-backup').textContent = lastExport
      ? `Dernière sauvegarde : ${new Date(lastExport).toLocaleString('fr-FR')}.`
      : 'Aucune sauvegarde exportée depuis l’installation.';
  }
  function openErase() {
    $('#f-erase-word').value = ''; $('#f-erase-ok').checked = false;
    ['#f-erase-word', '#f-erase-ok'].forEach((s) => $(s).removeAttribute('aria-invalid'));
    $('#err-erase-word').textContent = ''; $('#err-erase-ok').textContent = '';
    paintEraseBackup();
    $('#dlg-erase').showModal();
  }
  async function doErase(e) {
    e.preventDefault();
    const word = $('#f-erase-word'), ok = $('#f-erase-ok');
    $('#err-erase-word').textContent = ''; $('#err-erase-ok').textContent = '';
    word.removeAttribute('aria-invalid'); ok.removeAttribute('aria-invalid');
    let bad = null;
    if (word.value.trim() !== 'SUPPRIMER') { $('#err-erase-word').textContent = 'Tapez exactement SUPPRIMER, en majuscules.'; word.setAttribute('aria-invalid', 'true'); bad = word; }
    if (!ok.checked) { $('#err-erase-ok').textContent = 'Cochez la case pour confirmer.'; ok.setAttribute('aria-invalid', 'true'); bad = bad || ok; }
    if (bad) { bad.focus(); return; }
    try {
      await run(['links', 'logs', 'meta'], 'readwrite', (t) => { ['links', 'logs', 'meta'].forEach((n) => t.objectStore(n).clear()); });
      try { localStorage.removeItem('pl-theme'); localStorage.removeItem('pl-view'); } catch { /* ignoré */ }
      document.documentElement.removeAttribute('data-theme');
      links = []; hay.clear(); undoEntry = null; lastExport = null;
      state.selected.clear(); state.collection = null; state.tags.clear(); state.q = ''; state.view = 'lines'; state.collapsed.clear();
      $('#q').value = '';
      resetPaging();
      $('#dlg-erase').close();
      await log('effacement', 'toutes les données');
      broadcast('erased');
      paintThemeBtn(); paintUndo();
      if (state.selecting) setSelecting(false); else render();
      toast('Toutes les données ont été effacées.');
    } catch (err) { fail(err, 'effacement'); }
  }

  /* ---------- Journal ---------- */
  async function openLog() {
    try {
      const rows = await run('logs', 'readonly', (t) => reqP(t.objectStore('logs').getAll()));
      const items = rows.slice(-100).reverse().map((r) => el('li', {},
        `${new Date(r.ts).toLocaleString('fr-FR')} · ${r.event}${r.detail ? ' · ' + r.detail : ''}`));
      $('#log-list').replaceChildren(...(items.length ? items : [el('li', {}, 'Journal vide.')]));
      $('#dlg-log').showModal();
    } catch (e) { fail(e, 'journal'); }
  }

  /* ---------- Thème ---------- */
  function effectiveTheme() {
    return document.documentElement.getAttribute('data-theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  }
  function paintThemeBtn() {
    const dark = effectiveTheme() === 'dark';
    const b = $('#btn-theme');
    b.replaceChildren(icon(dark ? 'sun' : 'moon'));
    const label = dark ? 'Passer au thème clair' : 'Passer au thème sombre';
    b.setAttribute('aria-label', label); b.title = label;
  }

  /* ---------- Initialisation ---------- */
  function bind() {
    $('#btn-add').addEventListener('click', () => openLinkDialog());
    $('#btn-import').addEventListener('click', openImport);
    $('#btn-export').addEventListener('click', () => $('#dlg-export').showModal());
    $('#btn-export-json').addEventListener('click', () => { $('#dlg-export').close(); exportJson(); });
    $('#btn-export-html').addEventListener('click', () => { $('#dlg-export').close(); exportHtml(); });
    $('#btn-log').addEventListener('click', openLog);
    $('#btn-log-clear').addEventListener('click', async () => {
      try { await run('logs', 'readwrite', (t) => { t.objectStore('logs').clear(); }); $('#log-list').replaceChildren(el('li', {}, 'Journal vide.')); } catch (e) { fail(e, 'journal-vidage'); }
    });
    combos.link = attachCombobox($('#f-collection'), $('#lb-collection'), $('#hint-collection'));
    combos.imp = attachCombobox($('#f-default-coll'), $('#lb-default-coll'), $('#hint-default-coll'));
    document.querySelectorAll('#views [data-view]').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
    $('#btn-fold').addEventListener('click', toggleAllGroups);
    combos.move = attachCombobox($('#f-move'), $('#lb-move'), $('#hint-move'));
    $('#btn-rename').addEventListener('click', () => openRename(state.collection, false));
    $('#btn-select').addEventListener('click', () => setSelecting(!state.selecting));
    $('#btn-colls').addEventListener('click', openCollections);
    $('#btn-undo').addEventListener('click', doUndo);
    $('#btn-more').addEventListener('click', () => loadMore(false));
    $('#btn-all').addEventListener('click', () => loadMore(true));
    $('#bb-all').addEventListener('click', () => {
      const all = currentIds.size > 0 && [...currentIds].every((id) => state.selected.has(id));
      currentIds.forEach((id) => { if (all) state.selected.delete(id); else state.selected.add(id); });
      syncChecks(); updateBatchBar();
    });
    $('#bb-move').addEventListener('click', openMove);
    $('#bb-tags').addEventListener('click', openTags);
    $('#bb-del').addEventListener('click', batchDelete);
    $('#bb-done').addEventListener('click', () => setSelecting(false));
    $('#f-btags').addEventListener('input', () => { $('#err-btags').textContent = ''; $('#f-btags').removeAttribute('aria-invalid'); });
    $('#form-move').addEventListener('submit', doMove);
    $('#form-tags').addEventListener('submit', doTags);
    $('#form-merge').addEventListener('submit', doMerge);
    $('#form-erase').addEventListener('submit', doErase);
    $('#btn-erase').addEventListener('click', openErase);
    $('#btn-erase-export').addEventListener('click', async () => { await exportJson(); paintEraseBackup(); });
    $('#btn-persist').addEventListener('click', askPersist);
    $('#dlg-rename').addEventListener('close', backToManager);
    $('#dlg-merge').addEventListener('close', backToManager);
    document.addEventListener('close', () => {
      if (syncPending && !document.querySelector('dialog[open]')) { syncPending = false; syncFromDb(); }
    }, true);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') scheduleSync(); });
    document.addEventListener('keydown', (e) => {
      const t = e.target;
      const inField = t.closest && t.closest('input, textarea, select');
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'z' && !inField && !document.querySelector('dialog[open]')) {
        if (undoEntry) { e.preventDefault(); doUndo(); }
      } else if (e.key === 'Escape' && state.selecting && !inField && !document.querySelector('dialog[open]')) {
        setSelecting(false);
      }
    });
    $('#btn-theme').addEventListener('click', () => {
      const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      try { localStorage.setItem('pl-theme', next); } catch { /* préférence non conservée */ }
      paintThemeBtn();
    });
    document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));
    $('#form-link').addEventListener('submit', saveLink);
    $('#form-import').addEventListener('submit', doImport);
    $('#form-rename').addEventListener('submit', renameCollection);
    $('#f-url').addEventListener('input', () => setUrlError(''));
    $('#sort').addEventListener('change', (e) => { state.sort = e.target.value; resetPaging(); render({ announce: true }); });
    $('#q').addEventListener('input', (e) => { state.q = e.target.value.slice(0, 200); resetPaging(); render({ announce: true }); });
    $('#q').addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const terms = norm(state.q).split(/\s+/).filter(Boolean);
      const first = links.filter((l) => visible(l, terms)).sort(comparator())[0];
      const u = first && parseUrl(first.url);
      if (u) { window.open(u.href, '_blank', 'noopener,noreferrer'); trackVisit(first.id); }
    });
    $('#f-files').addEventListener('change', (e) => setFiles(e.target.files));

    const drop = $('#drop');
    ['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); }));
    ['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, () => drop.classList.remove('over')));
    drop.addEventListener('drop', (e) => { e.preventDefault(); if (e.dataTransfer && e.dataTransfer.files.length) setFiles(e.dataTransfer.files); });
    const isFileDrag = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
    window.addEventListener('dragover', (e) => { if (isFileDrag(e)) e.preventDefault(); });
    window.addEventListener('drop', (e) => { if (isFileDrag(e)) e.preventDefault(); });

    document.addEventListener('keydown', (e) => {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target;
      if (t.closest && t.closest('input, textarea, select, dialog')) return;
      if (document.querySelector('dialog[open]')) return;
      e.preventDefault(); $('#q').focus();
    });
    const track = (e) => {
      const a = e.target.closest && e.target.closest('a.title[data-id]');
      if (a && (e.type === 'click' || e.button === 1)) trackVisit(a.getAttribute('data-id'));
    };
    document.addEventListener('click', track);
    document.addEventListener('auxclick', track);
  }
  async function trackVisit(id) {
    const l = links.find((x) => x.id === id);
    if (!l) return;
    l.visits = Math.min(l.visits + 1, 1e6);
    try { await putLinks([l], true); } catch { /* sans incidence pour l'utilisateur */ }
  }

  function fatal(msg) {
    $('#empty').replaceChildren(el('h3', {}, 'Stockage indisponible'), el('p', {}, msg));
    $('#empty').hidden = false;
    document.querySelectorAll('.actions .btn:not(#btn-theme), .filters').forEach((n) => { n.hidden = true; });
  }
  async function init() {
    $('#app-version').textContent = APP_VERSION;
    try { const v = localStorage.getItem('pl-view'); if (VIEWS.includes(v)) state.view = v; } catch { /* vue par défaut */ }
    paintThemeBtn();
    bind();
    if (!('indexedDB' in window) || !window.crypto || !crypto.getRandomValues) {
      fatal('Ce navigateur ne permet pas de conserver vos données ici. Essayez une fenêtre normale (hors navigation privée).');
      return;
    }
    try {
      db = await openDb();
      const [rows, meta] = await run(['links', 'meta'], 'readonly', (t) =>
        Promise.all([reqP(t.objectStore('links').getAll()), reqP(t.objectStore('meta').get('lastExport'))]));
      links = rows.map(coerceStored).filter(Boolean);
      links.forEach(reindex);
      lastExport = meta && Number.isFinite(meta.value) ? meta.value : null;
      await log('démarrage', `v${APP_VERSION}, schéma ${DB_VERSION}`);
      if ('BroadcastChannel' in window) {
        chan = new BroadcastChannel('portail-liens');
        chan.onmessage = (ev) => { if (ev.data && ev.data.app === 'portail-liens') scheduleSync(); };
      }
      paintPersist(); paintUndo();
      render();
    } catch (e) {
      fatal('Impossible d’ouvrir le stockage local. Rechargez la page ; si le problème persiste, vérifiez l’espace disque et les réglages du navigateur.');
      try { log('erreur', 'ouverture : ' + (e && e.name)); } catch { /* ignoré */ }
    }
  }
  init();
})();
