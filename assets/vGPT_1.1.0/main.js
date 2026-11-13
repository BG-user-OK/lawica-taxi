import { RELEASE, clock, dateRange, epoch, nextDate, operatingDate, parseSnapshot,
  presentation, publicFeedUrl, sourceIsStale, stamp } from './board.js';
import { readFeed } from './feed.js';
import { demoSnapshot } from './demo.js';
import { cityPriority, directionSettings } from './directions.js';

const get = id => document.getElementById(id);
const settings = get('settings');
const refresh = get('refresh');
const prefix = 'bg-user-ok/lawica-taxi:';
const workerAtStart = navigator.serviceWorker?.controller;
const demo = new URLSearchParams(location.search).get('demo') === '1';
const noRows = [];
let endpoint = publicFeedUrl(read('localStorage', 'endpoint') || '');
let snapshot;
let synced;
let failed = false;
let pending;
let reloadPending = false;
let workerCheck;
let registration;
let dayOffset = read('sessionStorage', 'day') === '1' ? 1 : 0;
let rowKey;
let renderedRows = [];
const directions = directionSettings({ get, read, save, render, update: applyUpdate });
directions.configure(endpoint);

function read(storage, key) {
  try { return window[storage].getItem(prefix + key); } catch { return null; }
}

function save(storage, key, value) {
  try { window[storage].setItem(prefix + key, value); return true; } catch { return false; }
}

function loadCache() {
  snapshot = undefined;
  synced = undefined;
  if (demo) {
    snapshot = parseSnapshot(demoSnapshot(), 'test');
    return;
  }
  try {
    const cached = JSON.parse(read('localStorage', 'snapshot'));
    if (endpoint && cached?.endpoint === endpoint) {
      snapshot = parseSnapshot(cached.data);
      directions.receive(snapshot.directions);
      synced = cached.synced;
    }
  } catch { /* A malformed local snapshot can be replaced by a valid sync. */ }
}

function show(id, message) {
  const element = get(id);
  if (element.textContent !== message) element.textContent = message;
  element.hidden = !message;
}

function render() {
  const now = Date.now();
  const operating = operatingDate(snapshot, now);
  const selected = nextDate(operating, dayOffset);
  const day = snapshot?.days.get(selected);
  const rows = day?.flights ?? noRows;
  get('today').setAttribute('aria-pressed', dayOffset === 0);
  get('tomorrow').setAttribute('aria-pressed', dayOffset === 1);
  get('day-label').textContent = `Doba lotnicza · ${dayOffset ? 'jutro' : 'dziś'}`;
  get('range').textContent = dateRange(selected, day?.endDate ?? selected);
  const phoneClock = get('clock');
  const phoneTime = new Date(now);
  phoneClock.textContent = phoneTime.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });
  phoneClock.dateTime = phoneTime.toISOString();
  get('airport-time').textContent = stamp(snapshot?.source_updated_at);
  get('source-mode').textContent = snapshot?.source_mode === 'auto' ? 'AUTO' : 'RĘCZNY';
  get('published-time').textContent = demo ? '—' : stamp(snapshot?.published_at);
  get('synced-time').textContent = stamp(synced);
  get('demo-banner').hidden = !demo;
  get('open-settings').hidden = demo;
  refresh.hidden = demo;
  refresh.disabled = !endpoint || Boolean(pending) || !navigator.onLine;

  const notices = [];
  if (!demo && !navigator.onLine) notices.push(snapshot ? `Offline – dane z ${stamp(snapshot.published_at)}` : 'Offline – brak zapisanych danych.');
  if (!demo && navigator.onLine && failed) notices.push(snapshot ? 'Błąd synchronizacji. Wyświetlam zapisane dane.' : 'Błąd synchronizacji z arkuszem.');
  if (!demo && sourceIsStale(snapshot, snapshot?.days.get(operating), now)) notices.push('Dane lotniska mogą być nieaktualne.');
  if (day?.coverage === 'partial') notices.push('Doba lotnicza · niepełne dane.');
  show('notice', notices.join(' '));
  show('empty', rows.length ? '' : emptyMessage(day));
  get('flights').closest('table').hidden = !rows.length;

  if (rowKey !== rows) {
    rowKey = rows;
    renderedRows = rows.map(flight => {
      const row = document.createElement('tr');
      const plan = row.insertCell();
      plan.textContent = clock(flight.scheduled);
      if (flight.arrival_date !== flight.operating_date) plan.title = stamp(flight.scheduled);
      return { row, countdown: row.insertCell(), city: row.insertCell(), status: row.insertCell(), flight };
    });
    get('flights').replaceChildren(...renderedRows.map(item => item.row));
  }
  let approximate = false;
  const airports = directions.priorities() ?? snapshot?.priorities;
  const cities = directions.priorityCities();
  for (const item of renderedRows) {
    const effective = cityPriority(item.flight.origin_city, cities) ? new Set([item.flight.origin_airport]) : airports;
    const view = presentation(item.flight, effective, now);
    item.row.className = `${view.phase}${view.priority ? ' priority' : ''}`;
    item.countdown.textContent = view.countdown;
    item.city.textContent = view.city;
    item.status.textContent = view.status;
    item.status.classList.toggle('terminal', item.flight.terminal);
    if (view.countdown.startsWith('~')) approximate = true;
  }
  get('legend').hidden = !approximate;
}

function emptyMessage(day) {
  if (!demo && !endpoint) return 'Połącz opublikowane dane z Arkuszy Google w ustawieniach (⚙).';
  if (day?.coverage === 'complete') return 'Brak przylotów w tej dobie.';
  if (pending && !snapshot) return 'Pobieranie danych…';
  return dayOffset ? 'Brak danych na jutro.' : 'Brak danych na dziś.';
}

function synchronize() {
  if (demo || !endpoint || !navigator.onLine || pending) return pending;
  const requested = endpoint;
  pending = readFeed(requested, snapshot?.version).then(data => {
    if (endpoint !== requested) return;
    const cached = data?.unchanged === true && data.version === snapshot?.version;
    if (!cached) {
      const next = parseSnapshot(data);
      if (snapshot && epoch(next.published_at) < epoch(snapshot.published_at)) throw new Error('Starsza publikacja');
      snapshot = next;
    }
    if (data.directions) {
      snapshot.directions = data.directions;
      directions.receive(data.directions);
    }
    synced = Date.now();
    failed = false;
    const payload = { ...snapshot, days: Array.from(snapshot.days.values(), ({ operating_date, coverage }) => ({ operating_date, coverage })) };
    delete payload.priorities;
    save('localStorage', 'snapshot', JSON.stringify({ endpoint, synced, data: payload }));
  }).catch(() => {
    if (endpoint === requested) failed = true;
  }).finally(() => {
    pending = undefined;
    if (endpoint !== requested) synchronize();
    render();
    directions.paint();
    applyUpdate();
  });
  render();
  return pending;
}

function applyUpdate() {
  if (reloadPending && !pending && !directions.isBusy() && !settings.open && !document.hidden) {
    reloadPending = false;
    location.reload();
  }
}

function checkWorker() {
  if (!registration || workerCheck || !navigator.onLine || document.hidden) return;
  workerCheck = registration.update().catch(() => {}).finally(() => { workerCheck = undefined; });
}

function foreground() {
  if (document.hidden) return;
  render();
  applyUpdate();
  checkWorker();
  synchronize();
  directions.flush();
}

if ('serviceWorker' in navigator) {
  let controlled = Boolean(workerAtStart);
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    reloadPending = controlled;
    controlled = Boolean(navigator.serviceWorker.controller);
    applyUpdate();
  });
  const base = new URL('../../', import.meta.url);
  navigator.serviceWorker.register(new URL('sw.js', base), { scope: base.pathname, updateViaCache: 'none' })
    .then(result => { registration = result; checkWorker(); })
    .catch(error => console.warn('Tryb offline niedostępny', error));
}

for (const [id, offset] of [['today', 0], ['tomorrow', 1]]) {
  get(id).addEventListener('click', () => {
    dayOffset = offset;
    save('sessionStorage', 'day', String(offset));
    render();
  });
}
refresh.addEventListener('click', synchronize);
get('open-settings').addEventListener('click', () => {
  get('endpoint').value = endpoint;
  get('direction-key').value = '';
  show('feed-error', '');
  settings.showModal();
  directions.paint();
});
get('close-settings').addEventListener('click', () => settings.close());
settings.addEventListener('close', applyUpdate);
get('feed-form').addEventListener('submit', event => {
  event.preventDefault();
  const input = get('endpoint').value.trim();
  const url = publicFeedUrl(input);
  const key = get('direction-key').value.trim().toLowerCase();
  if (input && !url) return show('feed-error', 'Wprowadź publiczny adres wdrożenia Apps Script zakończony /exec.');
  if (key && (!url || !/^[a-f0-9]{64}$/.test(key))) return show('feed-error', 'Wpisz adres Apps Script i pełny klucz zapisu z Arkusza.');
  if (url !== endpoint) {
    if (directions.isBusy()) return show('feed-error', 'Poczekaj na zakończenie zapisu kierunków.');
    if (!save('localStorage', 'endpoint', url)) return show('feed-error', 'Przeglądarka blokuje zapis ustawień.');
    endpoint = url;
    directions.configure(url);
    failed = false;
    loadCache();
  }
  const keyError = directions.configure(url, key);
  if (keyError) return show('feed-error', keyError);
  get('direction-key').value = '';
  settings.close();
  render();
  synchronize();
  directions.flush();
});
get('release').textContent = RELEASE;
loadCache();
foreground();
document.addEventListener('visibilitychange', foreground);
window.addEventListener('pageshow', foreground);
window.addEventListener('online', foreground);
window.addEventListener('offline', () => { render(); directions.paint(); });
setInterval(() => { if (!document.hidden) render(); }, 15000);
setInterval(() => { if (!document.hidden) { checkWorker(); synchronize(); directions.flush(); } }, 60000);
