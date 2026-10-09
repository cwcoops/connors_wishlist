const SUPABASE_URL = 'https://bjectonbtzkyhwknpkyf.supabase.co';
const SUPABASE_KEY = 'sb_publishable_xnLOTsP5nGdplpzlk687Og_OG4wXjcH';
const PHOTO_BUCKET = 'item-photos';
const RESERVE_MS = 5 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const ROB_NOTICE = "No payments go through this site. Contact Rob (Connor's dad) to send your contribution — he'll tell you whether to send money or get a gift card etc.";

const db = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

const state = { items: [], people: [], contributions: [], buyers: [], loaded: false, adminPw: null, editingId: null };

const $ = (sel) => document.querySelector(sel);
const grid = $('#grid');
const sheet = $('#sheet');

// ---------- helpers ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => {
  const v = Number(n);
  return '£' + (Number.isInteger(v) ? v.toLocaleString('en-GB') : v.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
};
const sum = (list, pick) => Math.round(list.reduce((t, x) => t + Number(pick(x)), 0) * 100) / 100;

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { el.hidden = true; }, 4000);
}

function whereHtml(where) {
  if (!where) return '';
  const text = where.trim();
  if (/^(https?:\/\/|www\.)\S+$/i.test(text)) {
    const href = /^https?:/i.test(text) ? text : 'https://' + text;
    let label = text;
    try { label = new URL(href).hostname.replace(/^www\./, ''); } catch { /* keep raw text */ }
    return `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(label)} ↗</a>`;
  }
  return esc(text);
}

function daysLeft(item) {
  const left = new Date(item.reserved_at).getTime() + RESERVE_MS - Date.now();
  return Math.max(1, Math.ceil(left / DAY_MS));
}
const isExpired = (item) => item.status === 'reserved' && new Date(item.reserved_at).getTime() + RESERVE_MS <= Date.now();

// ---------- data ----------
async function load() {
  const [items, people, contributions, buyers] = await Promise.all([
    db.from('items').select('*').order('created_at'),
    db.from('people').select('id,name').order('name'),
    db.from('contributions').select('*').order('created_at'),
    db.from('item_buyers').select('*').order('created_at'),
  ]);
  const failed = items.error || people.error || contributions.error || buyers.error;
  if (failed) {
    console.error(failed);
    if (!state.loaded) grid.innerHTML = '<p class="empty">Couldn\'t load the list. Check your connection and refresh.</p>';
    return;
  }
  state.items = items.data;
  state.people = people.data;
  state.contributions = contributions.data;
  state.buyers = buyers.data;
  state.loaded = true;
  render();
  checkExpiry();
}

let reloadTimer;
function scheduleLoad() {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(load, 150);
}

// Reservations lapse after 5 days: the server resets them, any open page triggers it.
async function checkExpiry() {
  if (!state.items.some(isExpired)) return;
  const { error } = await db.rpc('expire_reservations');
  if (error) console.error(error);
  else scheduleLoad();
}

async function rpc(name, args) {
  const { data, error } = await db.rpc(name, args);
  if (error) throw new Error(error.message || 'Something went wrong');
  scheduleLoad();
  return data;
}

// ---------- guest view ----------
function render() {
  if (state.adminPw) renderAdmin();
  else renderGuest();
}

function renderGuest() {
  if (!state.loaded) return;
  if (!state.items.length) {
    grid.innerHTML = '<p class="empty">Nothing on the list yet – check back soon! 🎈</p>';
    return;
  }
  const names = new Map(state.people.map((p) => [p.id, p.name]));
  const byItem = new Map();
  for (const c of state.contributions) {
    if (!byItem.has(c.item_id)) byItem.set(c.item_id, []);
    byItem.get(c.item_id).push(c);
  }
  const sorted = [...state.items].sort((a, b) => (a.status === 'bought') - (b.status === 'bought'));
  const gettingOne = (item) => state.buyers.filter((b) => b.item_id === item.id).map((b) => names.get(b.person_id) || 'Someone');
  grid.innerHTML = sorted.map((item) => cardHtml(item, byItem.get(item.id) || [], names, gettingOne(item))).join('');
}

function cardHtml(item, contribs, names, gettingOne) {
  const bought = item.status === 'bought';
  const price = item.price == null ? null : Number(item.price);
  const pledged = sum(contribs, (c) => c.amount);
  let actions = '';

  if (item.allow_multiple) {
    // Multi-buy items never get reserved or crossed off: people just add their name.
    actions += `<span class="pill multi">🎁 More than one person can get this</span>`;
    if (gettingOne.length) actions += `<div class="getting">Getting one: <b>${gettingOne.map(esc).join(', ')}</b></div>`;
    actions += `<label class="tick"><input type="checkbox" data-action="multi" data-id="${item.id}"> I'm getting one</label>`;
    if (gettingOne.length) actions += `<button type="button" class="link-btn" data-action="unmulti" data-id="${item.id}">Remove – I'm not getting one anymore</button>`;
  } else if (!bought && item.status === 'reserved') {
    const d = daysLeft(item);
    actions += `<span class="pill">Reserved by ${esc(item.reserved_by)} – ${d} day${d === 1 ? '' : 's'} left</span>
      <label class="tick"><input type="checkbox" data-action="bought" data-id="${item.id}"> Bought</label>
      <button type="button" class="link-btn" data-action="unreserve" data-id="${item.id}">Remove – I'm not buying it anymore</button>`;
  } else if (!bought) {
    if (price && contribs.length) actions += chipInHtml(price, contribs, names);
    if (!contribs.length) actions += `<label class="tick"><input type="checkbox" data-action="reserve" data-id="${item.id}"> I'm going to buy it</label>`;
    if (price && pledged < price) actions += `<button type="button" class="btn" data-action="help" data-id="${item.id}">Help buy</button>`;
  }

  return `<article class="card${bought ? ' bought' : ''}">
    <div class="photo">${item.photo_url ? `<img src="${esc(item.photo_url)}" alt="" loading="lazy">` : '🎁'}</div>
    <div class="body">
      <div class="title"><h3>${esc(item.name)}</h3>${price ? `<span class="price">${money(price)}</span>` : ''}</div>
      ${item.where_to_buy ? `<div class="where">🛒 ${whereHtml(item.where_to_buy)}</div>` : ''}
      ${item.notes ? `<p class="notes">${esc(item.notes)}</p>` : ''}
      ${actions ? `<div class="actions">${actions}</div>` : ''}
    </div>
    ${bought ? `<div class="bought-mark"><svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><line x1="6" y1="6" x2="94" y2="94"/><line x1="94" y1="6" x2="6" y2="94"/></svg><span class="stamp">BOUGHT</span></div>` : ''}
  </article>`;
}

function chipInHtml(price, contribs, names) {
  const pledged = sum(contribs, (c) => c.amount);
  const confirmed = sum(contribs.filter((c) => c.organised_with_rob), (c) => c.amount);
  const pending = Math.round((pledged - confirmed) * 100) / 100;
  const pct = (n) => Math.min(100, (n / price) * 100).toFixed(2);
  const rows = contribs.map((c) => {
    const who = `<span><b>${esc(names.get(c.person_id) || 'Someone')}</b> · ${money(c.amount)}</span>`;
    const remove = `<button type="button" class="link-btn" data-action="unchip" data-id="${c.id}">Remove</button>`;
    if (c.organised_with_rob) return `<li>${who}<span class="tag ok">Confirmed ✓</span>${remove}</li>`;
    return `<li>${who}<span class="tag wait">Pending</span>
      <label class="tick small"><input type="checkbox" data-action="confirm" data-id="${c.id}"> I've organised this with Rob</label>${remove}</li>`;
  }).join('');
  return `<div class="chip-in">
    <div class="bar" role="img" aria-label="${money(pledged)} of ${money(price)} pledged">
      <div class="confirmed" style="width:${pct(confirmed)}%"></div><div class="pending" style="width:${pct(pending)}%"></div>
    </div>
    <div class="bar-text">${money(pledged)} of ${money(price)} <small>– ${money(confirmed)} confirmed, ${money(pending)} pending</small></div>
    <ul class="contribs">${rows}</ul>
  </div>`;
}

// ---------- sheets ----------
function openSheet(html) {
  sheet.innerHTML = html;
  if (!sheet.open) sheet.showModal();
}
function closeSheet() {
  if (sheet.open) sheet.close();
}
// Close on a tap that starts on the backdrop (not one that drags out of the sheet).
let pressedBackdrop = false;
sheet.addEventListener('pointerdown', (e) => {
  const r = sheet.getBoundingClientRect();
  pressedBackdrop = e.target === sheet && (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom);
});
sheet.addEventListener('click', (e) => {
  if ((e.target === sheet && pressedBackdrop) || e.target.closest('[data-close]')) closeSheet();
  pressedBackdrop = false;
});
sheet.addEventListener('change', (e) => {
  if (e.target.name === 'person') {
    const custom = sheet.querySelector('[data-new-name]');
    custom.hidden = e.target.value !== '__new';
    if (!custom.hidden) custom.querySelector('input').focus();
  }
});

function namePicker() {
  const last = localStorage.getItem('wishlist-name') || '';
  if (!state.people.length) {
    return `<label>Your name<input name="newName" maxlength="40" required placeholder="Type your name" value="${esc(last)}"></label>`;
  }
  const known = state.people.some((p) => p.name === last);
  return `<label>Your name
      <select name="person" required>
        <option value="" ${known ? '' : 'selected'} disabled>Pick your name…</option>
        ${state.people.map((p) => `<option ${p.name === last ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
        <option value="__new">➕ My name isn't here</option>
      </select>
    </label>
    <label data-new-name hidden>Type your name<input name="newName" maxlength="40" placeholder="e.g. Auntie Sue"></label>`;
}

function readName(form) {
  const picked = form.elements.person ? form.elements.person.value : '__new';
  const name = (picked === '__new' ? form.elements.newName.value : picked).trim().replace(/\s+/g, ' ');
  if (!name) throw new Error('Please pick or type your name');
  return name;
}

// Runs a sheet form's submit with a busy state and inline errors.
function onSheetSubmit(handler) {
  const form = sheet.querySelector('form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('[type=submit]');
    const err = form.querySelector('.error');
    err.textContent = '';
    btn.disabled = true;
    try {
      await handler(form);
    } catch (ex) {
      err.textContent = ex.message;
      btn.disabled = false;
    }
  });
}

const sheetForm = (title, body, submitLabel, submitClass = 'primary') => `
  <form method="dialog">
    <h2>${title}</h2>
    ${body}
    <div class="error" role="alert"></div>
    <div class="row">
      <button type="button" class="btn ghost" data-close>Cancel</button>
      <button type="submit" class="btn ${submitClass}">${submitLabel}</button>
    </div>
  </form>`;

const infoSheet = (title, body) => openSheet(`<div class="stack"><h2>${title}</h2>${body}<button type="button" class="btn primary" data-close>Got it</button></div>`);

function reserveSheet(item) {
  openSheet(sheetForm(`Buying “${esc(item.name)}”?`,
    `<p>Tell us who you are and we'll take it off the list for everyone else.</p>${namePicker()}`,
    "I'm going to buy it"));
  onSheetSubmit(async (form) => {
    const name = readName(form);
    await rpc('reserve_item', { p_item_id: item.id, p_name: name });
    localStorage.setItem('wishlist-name', name);
    infoSheet(`It's yours, ${esc(name)}! 🎉`,
      `<div class="notice">You've got 5 days to buy this, otherwise it goes back on the list. Come back and tick 'Bought' once you've got it!</div>`);
  });
}

function boughtSheet(item) {
  openSheet(sheetForm(`Bought “${esc(item.name)}”?`,
    `<p>Pick your name to confirm. Only the person who reserved it can tick it off.</p>${namePicker()}`,
    "Yes, I've bought it"));
  onSheetSubmit(async (form) => {
    const name = readName(form);
    await rpc('mark_bought', { p_item_id: item.id, p_name: name });
    localStorage.setItem('wishlist-name', name);
    infoSheet('Amazing, thank you! 🎁', '<p>It\'s now marked as bought for everyone.</p>');
  });
}

function helpSheet(item) {
  const pledged = sum(state.contributions.filter((c) => c.item_id === item.id), (c) => c.amount);
  const remaining = Math.round((Number(item.price) - pledged) * 100) / 100;
  openSheet(sheetForm(`Help buy “${esc(item.name)}”`,
    `<p>${money(remaining)} of ${money(item.price)} still needed. Chip in whatever you like.</p>
     ${namePicker()}
     <label>Amount (£)<input name="amount" type="number" inputmode="decimal" min="0.01" max="${remaining}" step="0.01" required placeholder="e.g. 20"></label>
     <div class="notice">${esc(ROB_NOTICE)}</div>`,
    'Chip in'));
  onSheetSubmit(async (form) => {
    const name = readName(form);
    const amount = Number(form.elements.amount.value);
    if (!(amount > 0)) throw new Error('Enter an amount more than £0');
    await rpc('add_contribution', { p_item_id: item.id, p_name: name, p_amount: amount });
    localStorage.setItem('wishlist-name', name);
    infoSheet(`Thanks, ${esc(name)}! 🙌`,
      `<p>Your ${money(amount)} is on the list as <b>pending</b>.</p>
       <div class="notice">${esc(ROB_NOTICE)}</div>
       <div class="notice info">Once that's sorted, come back and tick “I've organised this with Rob” next to your name.</div>`);
  });
}

function multiSheet(item) {
  openSheet(sheetForm(`Getting “${esc(item.name)}”?`,
    `<p>More than one person can get this, so it stays on the list. Add your name so everyone can see who's getting one.</p>${namePicker()}`,
    "I'm getting one"));
  onSheetSubmit(async (form) => {
    const name = readName(form);
    await rpc('add_buyer', { p_item_id: item.id, p_name: name });
    localStorage.setItem('wishlist-name', name);
    closeSheet();
    toast(`Thanks, ${name}! You're down for one`);
  });
}

function unmultiSheet(item) {
  openSheet(sheetForm(`Not getting “${esc(item.name)}” anymore?`,
    `<p>Pick your name and we'll take it off this one.</p>${namePicker()}`,
    'Remove my name', 'danger'));
  onSheetSubmit(async (form) => {
    await rpc('remove_buyer', { p_item_id: item.id, p_name: readName(form) });
    closeSheet();
    toast('Removed');
  });
}

function unreserveSheet(item) {
  openSheet(sheetForm(`Not buying “${esc(item.name)}” anymore?`,
    `<p>No problem. Pick your name and it goes back on the list for someone else. Only the person who reserved it can remove it.</p>${namePicker()}`,
    'Remove my reservation', 'danger'));
  onSheetSubmit(async (form) => {
    await rpc('cancel_reservation', { p_item_id: item.id, p_name: readName(form) });
    closeSheet();
    toast('Removed – it\'s back on the list');
  });
}

function unchipSheet(contribution) {
  openSheet(sheetForm(`Remove this ${money(contribution.amount)}?`,
    `<p>Pick your name to take your contribution off. Only the person who chipped in can remove it.</p>
     ${contribution.organised_with_rob ? '<div class="notice">You\'ve already organised this with Rob – let him know you\'ve changed your mind.</div>' : ''}
     ${namePicker()}`,
    'Remove my contribution', 'danger'));
  onSheetSubmit(async (form) => {
    await rpc('remove_contribution', { p_contribution_id: contribution.id, p_name: readName(form) });
    closeSheet();
    toast('Contribution removed');
  });
}

function confirmSheet(contribution) {
  const person = state.people.find((p) => p.id === contribution.person_id);
  openSheet(sheetForm('All sorted with Rob?',
    `<p>Only tick this if you're <b>${esc(person ? person.name : 'the person who chipped in')}</b> and you've organised your ${money(contribution.amount)} with Rob.</p>`,
    "Yes, it's organised"));
  onSheetSubmit(async () => {
    await rpc('confirm_contribution', { p_contribution_id: contribution.id });
    closeSheet();
    toast('Confirmed – thank you!');
  });
}

grid.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  // Tickboxes only become ticked once the action has really gone through.
  if (el.type === 'checkbox') el.checked = false;
  const id = el.dataset.id;
  if (el.dataset.action === 'confirm' || el.dataset.action === 'unchip') {
    const c = state.contributions.find((x) => x.id === id);
    if (c) (el.dataset.action === 'confirm' ? confirmSheet : unchipSheet)(c);
    return;
  }
  const item = state.items.find((x) => x.id === id);
  if (!item) return;
  if (el.dataset.action === 'reserve') reserveSheet(item);
  if (el.dataset.action === 'bought') boughtSheet(item);
  if (el.dataset.action === 'unreserve') unreserveSheet(item);
  if (el.dataset.action === 'multi') multiSheet(item);
  if (el.dataset.action === 'unmulti') unmultiSheet(item);
  if (el.dataset.action === 'help') helpSheet(item);
});

// ---------- admin ----------
// Deliberately shows only what was entered: no status, names or contributions.
function passwordSheet() {
  openSheet(sheetForm('Password',
    '<label>Enter password<input name="pw" type="password" inputmode="numeric" autocomplete="off" required></label>',
    'Unlock'));
  sheet.querySelector('input').focus();
  onSheetSubmit(async (form) => {
    const pw = form.elements.pw.value;
    const { error } = await db.rpc('admin_login', { p_password: pw });
    if (error) throw new Error('Wrong password');
    state.adminPw = pw;
    closeSheet();
    showAdmin(true);
  });
}

function showAdmin(on) {
  $('#admin').hidden = !on;
  $('#guest').hidden = on;
  if (!on) {
    state.adminPw = null;
    history.replaceState(null, '', location.pathname);
  }
  resetItemForm();
  render();
  window.scrollTo(0, 0);
}

function renderAdmin() {
  const list = $('#admin-list');
  if (!state.items.length) {
    list.innerHTML = '<p class="empty">No items yet – add your first one above.</p>';
    return;
  }
  list.innerHTML = state.items.map((item) => `
    <article class="admin-item">
      <div class="thumb">${item.photo_url ? `<img src="${esc(item.photo_url)}" alt="">` : '🎁'}</div>
      <div>
        <h3>${esc(item.name)}${item.price != null ? ` · ${money(item.price)}` : ''}</h3>
        ${item.where_to_buy ? `<div class="meta">🛒 ${whereHtml(item.where_to_buy)}</div>` : ''}
        ${item.notes ? `<div class="meta">${esc(item.notes)}</div>` : ''}
        ${item.allow_multiple ? '<div class="meta">✓ Multiple purchase allowed</div>' : ''}
      </div>
      <div class="row">
        <button type="button" class="btn small" data-action="admin-edit" data-id="${item.id}">Edit</button>
        <button type="button" class="btn small ghost" data-action="admin-delete" data-id="${item.id}">Delete</button>
      </div>
    </article>`).join('');
}

const itemForm = $('#item-form');

function resetItemForm(item = null) {
  itemForm.reset();
  state.editingId = item ? item.id : null;
  $('#form-title').textContent = item ? 'Edit item' : 'Add an item';
  $('#form-submit').textContent = item ? 'Save changes' : 'Add item';
  $('#form-cancel').hidden = !item;
  state.photo = item && item.photo_url ? { url: item.photo_url } : null;
  renderPhoto();
  if (item) {
    itemForm.elements.name.value = item.name;
    itemForm.elements.price.value = item.price ?? '';
    itemForm.elements.where.value = item.where_to_buy ?? '';
    itemForm.elements.notes.value = item.notes ?? '';
    itemForm.elements.multi.checked = item.allow_multiple;
  }
}

// state.photo is null, { url } for the saved photo, or { canvas, crop } for a new/cropped one.
function drawTo(source, crop, maxSide) {
  const c = crop || { x: 0, y: 0, w: source.width, h: source.height };
  const scale = Math.min(1, maxSide / Math.max(c.w, c.h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(c.w * scale));
  canvas.height = Math.max(1, Math.round(c.h * scale));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(source, c.x, c.y, c.w, c.h, 0, 0, canvas.width, canvas.height);
  return canvas;
}

// Phone photos are huge: work on a sensibly sized copy.
async function loadPhoto(blob) {
  if (!blob || !blob.type.startsWith('image/')) return toast('That file isn\'t a photo');
  try {
    const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
    state.photo = { canvas: drawTo(bitmap, null, 2000), crop: null };
    renderPhoto();
  } catch {
    toast('Could not read that photo');
  }
}

function renderPhoto() {
  const box = $('#photo-current');
  box.hidden = !state.photo;
  box.innerHTML = '';
  if (!state.photo) return;
  const thumb = state.photo.url
    ? Object.assign(new Image(), { src: state.photo.url, alt: '' })
    : drawTo(state.photo.canvas, state.photo.crop, 400);
  box.append(thumb);
  box.insertAdjacentHTML('beforeend', `
    <button type="button" class="btn small" data-action="photo-crop">Crop</button>
    <button type="button" class="btn small ghost" data-action="photo-remove">Remove</button>`);
}

async function startCrop() {
  if (state.photo.url) {
    // Pull the saved photo back down so it can be re-cropped.
    try {
      const res = await fetch(state.photo.url);
      if (!res.ok) throw new Error();
      await loadPhoto(await res.blob());
    } catch {
      return toast('Could not load that photo to crop');
    }
  }
  if (state.photo && state.photo.canvas) openCropper();
}

// Fixed 4:3 frame (the shape of the cards): drag to move, slider or scroll to zoom.
function openCropper() {
  const src = state.photo.canvas;
  openSheet(`<div class="stack">
    <h2>Crop photo</h2>
    <p>Drag to move, slide to zoom. The frame is what shows on the list.</p>
    <div class="crop-frame"></div>
    <label>Zoom<input type="range" min="1" max="5" step="0.01" value="1"></label>
    <div class="row">
      <button type="button" class="btn ghost" data-close>Cancel</button>
      <button type="button" class="btn ghost" data-crop="none">No crop</button>
      <button type="button" class="btn primary" data-crop="apply">Crop</button>
    </div>
  </div>`);
  const frame = sheet.querySelector('.crop-frame');
  const slider = sheet.querySelector('input[type=range]');
  const view = drawTo(src, null, Infinity);
  frame.append(view);

  const fw = frame.clientWidth, fh = frame.clientHeight;
  const base = Math.max(fw / src.width, fh / src.height);
  let scale = base, x = (fw - src.width * base) / 2, y = (fh - src.height * base) / 2;
  if (state.photo.crop) {
    scale = Math.min(base * 5, Math.max(base, fw / state.photo.crop.w));
    x = -state.photo.crop.x * scale;
    y = -state.photo.crop.y * scale;
    slider.value = scale / base;
  }
  const paint = () => {
    x = Math.min(0, Math.max(fw - src.width * scale, x));
    y = Math.min(0, Math.max(fh - src.height * scale, y));
    view.style.width = `${src.width * scale}px`;
    view.style.transform = `translate(${x}px, ${y}px)`;
  };
  const zoomTo = (next) => {
    const cx = (fw / 2 - x) / scale, cy = (fh / 2 - y) / scale;
    scale = next;
    x = fw / 2 - cx * scale;
    y = fh / 2 - cy * scale;
    paint();
  };
  paint();

  slider.addEventListener('input', () => zoomTo(base * Number(slider.value)));
  frame.addEventListener('wheel', (e) => {
    e.preventDefault();
    slider.value = Math.min(5, Math.max(1, Number(slider.value) * (e.deltaY < 0 ? 1.08 : 1 / 1.08)));
    zoomTo(base * Number(slider.value));
  }, { passive: false });
  let last = null;
  frame.addEventListener('pointerdown', (e) => { frame.setPointerCapture(e.pointerId); last = [e.clientX, e.clientY]; });
  frame.addEventListener('pointermove', (e) => {
    if (!last) return;
    x += e.clientX - last[0];
    y += e.clientY - last[1];
    last = [e.clientX, e.clientY];
    paint();
  });
  const stop = () => { last = null; };
  frame.addEventListener('pointerup', stop);
  frame.addEventListener('pointercancel', stop);

  sheet.querySelector('[data-crop=apply]').addEventListener('click', () => {
    state.photo.crop = { x: -x / scale, y: -y / scale, w: fw / scale, h: fh / scale };
    renderPhoto();
    closeSheet();
  });
  sheet.querySelector('[data-crop=none]').addEventListener('click', () => {
    state.photo.crop = null;
    renderPhoto();
    closeSheet();
  });
}

async function uploadPhoto(photo) {
  const out = drawTo(photo.canvas, photo.crop, 1400);
  const blob = await new Promise((resolve, reject) => out.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not read that photo'))), 'image/jpeg', 0.85));
  const path = `${crypto.randomUUID()}.jpg`;
  const { error } = await db.storage.from(PHOTO_BUCKET).upload(path, blob, { contentType: 'image/jpeg', cacheControl: '31536000' });
  if (error) throw new Error('Photo upload failed: ' + error.message);
  return db.storage.from(PHOTO_BUCKET).getPublicUrl(path).data.publicUrl;
}

itemForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#form-submit');
  btn.disabled = true;
  try {
    const f = itemForm.elements;
    let photoUrl = null;
    if (state.photo) photoUrl = state.photo.url || await uploadPhoto(state.photo);
    await rpc('admin_save_item', {
      p_password: state.adminPw,
      p_id: state.editingId,
      p_name: f.name.value,
      p_photo_url: photoUrl,
      p_price: f.price.value === '' ? null : Number(f.price.value),
      p_where_to_buy: f.where.value,
      p_notes: f.notes.value,
      p_allow_multiple: f.multi.checked,
    });
    toast(state.editingId ? 'Saved' : 'Added to the wishlist');
    resetItemForm();
  } catch (ex) {
    toast(ex.message);
  } finally {
    btn.disabled = false;
  }
});

$('#admin').addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const item = state.items.find((x) => x.id === el.dataset.id);
  switch (el.dataset.action) {
    case 'admin-exit': showAdmin(false); break;
    case 'admin-cancel-edit': resetItemForm(); break;
    case 'photo-crop': startCrop(); break;
    case 'photo-remove': state.photo = null; renderPhoto(); break;
    case 'admin-edit':
      if (item) { resetItemForm(item); itemForm.scrollIntoView({ behavior: 'smooth' }); }
      break;
    case 'admin-delete':
      if (!item) break;
      openSheet(sheetForm(`Delete “${esc(item.name)}”?`, '<p>This removes it from the wishlist for everyone. It can\'t be undone.</p>', 'Delete', 'danger'));
      onSheetSubmit(async () => {
        await rpc('admin_delete_item', { p_password: state.adminPw, p_id: item.id });
        if (state.editingId === item.id) resetItemForm();
        closeSheet();
      });
      break;
  }
});

itemForm.elements.photo.addEventListener('change', (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (file) loadPhoto(file);
});

// Dropping a photo anywhere on the admin page adds it (and never navigates away).
let dragTimer;
window.addEventListener('dragover', (e) => {
  e.preventDefault();
  if (!state.adminPw) return;
  $('#dropzone').classList.add('over');
  clearTimeout(dragTimer);
  dragTimer = setTimeout(() => $('#dropzone').classList.remove('over'), 150);
});
window.addEventListener('drop', (e) => {
  e.preventDefault();
  const file = e.dataTransfer && e.dataTransfer.files[0];
  if (state.adminPw && !sheet.open && file) loadPhoto(file);
});

$('#sponsor').addEventListener('click', () => {
  if (!state.adminPw) passwordSheet();
});

// ---------- start ----------
db.channel('wishlist')
  .on('postgres_changes', { event: '*', schema: 'public' }, scheduleLoad)
  .subscribe((status) => { if (status === 'SUBSCRIBED') scheduleLoad(); });

// Phones drop the socket when the tab sleeps, so catch up on return.
document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
setInterval(() => { if (!state.adminPw) renderGuest(); checkExpiry(); }, 30000);

// Opening the page at #admin goes straight to the password box with the list hidden.
if (location.hash === '#admin') {
  $('#guest').hidden = true;
  passwordSheet();
  sheet.addEventListener('close', () => { if (!state.adminPw) showAdmin(false); }, { once: true });
}

load();
