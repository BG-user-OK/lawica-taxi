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
  const screen = get('direction-screen');
  let endpoint = '';
  let key = '';
  let state;
  let queue = [];
  let busy;
  let failure = '';

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
      failure = '';
    }
    return '';
  }

  function receive(value) {
    if (value && typeof value.revision === 'string' && Array.isArray(value.items) &&
        value.items.every(item => item && typeof item.id === 'string' && typeof item.city === 'string' &&
          typeof item.priority === 'boolean' && Array.isArray(item.airports) && item.airports.every(code => /^[A-Z]{3}$/.test(code)))) {
      state = value;
      return true;
    }
    return false;
  }

  function items() { return directionItems(state?.items ?? [], queue); }

  function paint() {
    if (!screen.open) return;
    const position = list.scrollTop;
    const active = document.activeElement?.dataset.direction;
    const term = normalize(search.value.trim());
    const status = failure || (queue.length ? 'Zmiany zapiszą się po powrocie do tablicy.' :
      state ? key ? 'Zapisano' : 'Wpisz klucz zapisu, aby edytować.' : 'Katalog pojawi się po aktualizacji Apps Script.');
    get('direction-status').textContent = status;
    get('direction-add-button').disabled = !state || !key || queue.length >= 100;
    const matches = items().filter(item => normalize(`${item.city} ${item.aliases || ''} ${item.airports.join(' ')}`).includes(term))
      .sort((a, b) => Number(b.priority) - Number(a.priority) || a.city.localeCompare(b.city, 'pl'));
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
    const previous = queue.at(-1);
    const cancelsLast = !busy && !previous?.attempted && operation.action === 'set' && previous?.action === 'set' &&
      operation.id === previous.id && operation.priority === previous.previous;
    const next = cancelsLast ? queue.slice(0, -1) : [...queue, { ...operation, request: crypto.randomUUID().replaceAll('-', ''), revision: state.revision }];
    if (!persist(next)) return false;
    paint();
    render();
    return true;
  }

  function flush() {
    if (busy || !endpoint || !key || !queue.length || !navigator.onLine || screen.open) return busy;
    const address = endpoint;
    failure = '';
    busy = (async () => {
      while (queue.length && navigator.onLine && endpoint === address && !screen.open) {
        const { attempted, ...operation } = queue[0];
        if (!attempted && !persist([{ ...operation, attempted: true }, ...queue.slice(1)])) return;
        await writeDirection(address, operation, key).catch(() => {});
        const result = await readFeed(address, undefined, operation.request, state?.revision);
        if (endpoint !== address) return;
        const ack = result.ack?.id === operation.request && result.ack.status;
        if (!ack) throw new Error('Brak potwierdzenia zapisu.');
        if (ack === 'forbidden') throw new Error('Klucz zapisu wygasł lub został zmieniony.');
        if (result.directions_error || (result.directions && !receive(result.directions)) || (ack === 'ok' && !result.directions && !alreadyApplied(state?.items, operation))) {
          throw new Error('Brak aktualnej listy kierunków.');
        }
        const rest = queue.slice(1);
        if (!persist(rest)) throw new Error('Brak dostępu do pamięci urządzenia.');
        if (ack !== 'ok') failure = 'Błąd synchronizacji · lista zmieniła się w Arkuszu. Sprawdź ją i ponów zmianę.';
        paint();
        render();
      }
    })().catch(error => {
      failure = `Błąd synchronizacji · ${error.message}`;
    }).finally(() => { busy = undefined; paint(); render(); update(); });
    render();
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

  return { configure, receive, paint, flush, isBusy: () => Boolean(busy), state: () => state,
    status: () => busy ? 'Zapisywanie kierunków…' : failure || (queue.length ? 'Zmiany kierunków czekają na synchronizację.' : ''),
    priorities: () => state && new Set(items().filter(item => item.priority).flatMap(item => item.airports)),
    priorityCities: () => state && new Set(items().filter(item => item.priority && item.airports.length === 0).map(item => idFor(item.city))) };
}

function alreadyApplied(items, operation) {
  const item = items?.find(row => row.id === operation.id);
  if (operation.action === 'remove') return !item;
  if (operation.action === 'add') return item?.city === operation.city;
  return item?.priority === operation.priority;
}

export function cityPriority(city, priorities) { return priorities?.has(idFor(city)); }
