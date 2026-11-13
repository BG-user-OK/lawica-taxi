import { readFeed, writeDirection } from './feed.js';

const normalize = value => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/ł/g, 'l');
const idFor = city => normalize(city).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const keyPattern = /^[a-f0-9]{64}$/;
const londonCodes = ['LCY', 'LGW', 'LHR', 'LTN', 'SEN', 'STN'];

export function directionItems(items, operations) {
  const map = new Map(items.map(item => [item.id, item]));
  for (const operation of operations) {
    if (operation.action === 'remove') map.delete(operation.id);
    if (operation.action === 'add') map.set(operation.id, { id: operation.id, city: operation.city,
      airports: operation.airports.split(' ').filter(Boolean), aliases: '', priority: true, origin: 'manual' });
    if (operation.action === 'set' && map.has(operation.id)) map.set(operation.id, { ...map.get(operation.id), priority: operation.priority });
  }
  return [...map.values()];
}

export function directionSettings({ get, read, save, render, update }) {
  const list = get('directions');
  const search = get('direction-search');
  let endpoint = '';
  let key = '';
  let state;
  let queue = [];
  let busy;
  let failure = '';
  let retryAfter = 0;

  function persist(next) {
    if (!save('localStorage', 'directions-queue', JSON.stringify({ endpoint, operations: next }))) {
      failure = 'Błąd synchronizacji · przeglądarka blokuje zapis.';
      paint();
      return false;
    }
    queue = next;
    return true;
  }

  function configure(url, nextKey = '') {
    if (endpoint !== url) {
      endpoint = url;
      state = undefined;
      failure = '';
      retryAfter = 0;
      queue = [];
      key = '';
      try {
        const saved = JSON.parse(read('localStorage', 'directions-queue'));
        if (saved?.endpoint === endpoint && Array.isArray(saved.operations)) queue = saved.operations;
        const credential = JSON.parse(read('localStorage', 'directions-key'));
        if (credential?.endpoint === endpoint && keyPattern.test(credential.key)) key = credential.key;
      } catch { /* Storage may be unavailable. */ }
    }
    if (nextKey) {
      if (!keyPattern.test(nextKey)) return 'Wklej pełny klucz wygenerowany w Arkuszu.';
      if (!save('localStorage', 'directions-key', JSON.stringify({ endpoint, key: nextKey }))) return 'Przeglądarka blokuje zapis klucza.';
      key = nextKey;
      retryAfter = 0;
      failure = '';
    }
    return '';
  }

  function receive(value) {
    if (value && typeof value.revision === 'string' && Array.isArray(value.items) &&
        value.items.every(item => typeof item.id === 'string' && typeof item.city === 'string' && Array.isArray(item.airports))) state = value;
  }

  function items() { return directionItems(state?.items ?? [], queue); }

  function paint() {
    if (!get('settings').open) return;
    const position = list.scrollTop;
    const active = document.activeElement?.dataset.direction;
    const term = normalize(search.value.trim());
    const status = failure || (queue.length ? navigator.onLine ? 'Synchronizowanie' : 'Synchronizowanie · czeka na internet' :
      state ? key ? 'Zapisano' : 'Wpisz klucz zapisu, aby edytować.' : 'Katalog pojawi się po aktualizacji Apps Script.');
    get('direction-status').textContent = status;
    get('direction-add-button').disabled = !state || !key || queue.length >= 100;
    const matches = items().filter(item => normalize(`${item.city} ${item.aliases || ''} ${item.airports.join(' ')}`).includes(term))
      .sort((a, b) => a.city.localeCompare(b.city, 'pl'));
    const rows = matches.map(item => {
      const row = document.createElement('div');
      row.className = 'direction-item';
      const label = document.createElement('label');
      label.className = 'direction-choice';
      const check = document.createElement('input');
      check.type = 'checkbox';
      check.checked = item.priority;
      check.dataset.direction = item.id;
      check.disabled = !key || queue.length >= 100;
      check.addEventListener('change', () => enqueue({ action: 'set', id: item.id, priority: check.checked, previous: item.priority }));
      const name = document.createElement('span');
      name.textContent = item.city;
      const codes = document.createElement('small');
      codes.textContent = item.airports.join(' · ');
      name.append(codes);
      label.append(check, name);
      row.append(label);
      if (item.origin === 'manual') {
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'action';
        remove.textContent = 'Usuń';
        remove.setAttribute('aria-label', `Usuń ${item.city}`);
        remove.disabled = !key || queue.length >= 100;
        remove.addEventListener('click', () => enqueue({ action: 'remove', id: item.id,
          fingerprint: JSON.stringify([item.city, item.airports, item.aliases, item.priority, item.origin]) }));
        row.append(remove);
      }
      return row;
    });
    list.replaceChildren(...rows);
    list.scrollTop = position;
    if (active) [...list.querySelectorAll('input')].find(input => input.dataset.direction === active)?.focus({ preventScroll: true });
  }

  function enqueue(operation) {
    if (!key || !state || queue.length >= 100) return false;
    failure = '';
    retryAfter = 0;
    if (!persist([...queue, { ...operation, request: crypto.randomUUID().replaceAll('-', ''), revision: state.revision }])) return false;
    paint();
    render();
    flush();
    return true;
  }

  function flush() {
    if (busy || !endpoint || !key || !queue.length || !navigator.onLine || Date.now() < retryAfter) return busy;
    const address = endpoint;
    busy = (async () => {
      while (queue.length && navigator.onLine && endpoint === address) {
        const first = queue[0];
        const operation = first;
        await writeDirection(address, operation, key).catch(() => {});
        const result = await readFeed(address, undefined, operation.request);
        if (endpoint !== address) return;
        const ack = result.ack?.id === operation.request && result.ack.status;
        if (!ack) throw new Error('Brak potwierdzenia zapisu.');
        receive(result.directions);
        if (ack === 'forbidden') throw new Error('Klucz zapisu wygasł lub został zmieniony.');
        const rest = queue.slice(1);
        if (!persist(rest)) throw new Error('Brak dostępu do pamięci urządzenia.');
        if (ack !== 'ok') failure = 'Błąd synchronizacji · lista zmieniła się w Arkuszu. Sprawdź ją i ponów zmianę.';
        paint();
        render();
      }
    })().catch(error => {
      retryAfter = Date.now() + 55000;
      failure = `Błąd synchronizacji · ${error.message}`;
    }).finally(() => { busy = undefined; paint(); render(); update(); });
    return busy;
  }

  search.addEventListener('input', paint);
  get('direction-add').addEventListener('submit', event => {
    event.preventDefault();
    const city = get('direction-city').value.trim();
    const id = idFor(city);
    const airports = [...new Set(get('direction-airports').value.trim().toUpperCase().split(/[\s,;]+/).filter(Boolean))].sort();
    const candidates = id === 'london' || id === 'londyn' ? [...new Set([...airports, ...londonCodes])] : airports;
    if (!id || candidates.some(code => !/^[A-Z]{3}$/.test(code)) || /^[=+@-]/.test(city)) {
      failure = 'Błąd synchronizacji · wpisz nazwę miasta i poprawne kody IATA.';
    } else if (items().some(item => idFor(item.city) === id || item.aliases?.split(/[;,]+/).some(alias => idFor(alias) === id) || candidates.some(code => item.airports.includes(code)))) {
      failure = 'Kierunek już jest na liście.';
    } else if (enqueue({ action: 'add', id, city, airports: candidates.join(' ') })) event.target.reset();
    paint();
  });

  return { configure, receive, paint, flush, isBusy: () => Boolean(busy), priorities: () => state && new Set(items().filter(item => item.priority).flatMap(item => item.airports)),
    priorityCities: () => state && new Set(items().filter(item => item.priority && item.airports.length === 0).map(item => idFor(item.city))) };
}

export function cityPriority(city, priorities) { return priorities?.has(idFor(city)); }
