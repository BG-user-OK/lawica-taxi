export const RELEASE = 'vGPT_1.0.0';
export const ZONE = 'Europe/Warsaw';
export const DEFAULT_PRIORITIES = ['FRA', 'BHX', 'AMS', 'WAW', 'LHR', 'STN', 'LTN', 'LGW', 'LCY', 'SEN'];
export const STATUSES = ['scheduled', 'expected', 'delayed', 'landed', 'baggage_belt', 'baggage_delivered', 'cancelled', 'diverted', 'unknown'];
const CONFIRMED = new Set(['landed', 'baggage_belt', 'baggage_delivered']);
const TERMINAL = new Set(['cancelled', 'diverted']);
const dateFormat = new Intl.DateTimeFormat('sv-SE', { timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
const clockFormat = new Intl.DateTimeFormat('pl-PL', { timeZone: ZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const shortDate = new Intl.DateTimeFormat('pl-PL', { timeZone: ZONE, day: 'numeric', month: 'short' });
const fullDate = new Intl.DateTimeFormat('pl-PL', { timeZone: ZONE, day: 'numeric', month: 'long', year: 'numeric' });
const localizedCity = {
  FRA: 'Frankfurt', BHX: 'Birmingham', AMS: 'Amsterdam', WAW: 'Warszawa',
  LHR: 'Londyn', STN: 'Londyn', LTN: 'Londyn', LGW: 'Londyn', LCY: 'Londyn', SEN: 'Londyn',
  CDG: 'Paryż', ORY: 'Paryż', BVA: 'Paryż'
};

export function epoch(value) {
  const pattern = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;
  return typeof value === 'string' && pattern.test(value) && validDate(value.slice(0, 10)) ? Date.parse(value) : NaN;
}

export function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(+date) && date.toISOString().slice(0, 10) === value;
}

export function dateKey(now) { return dateFormat.format(now); }
export function clock(now) { return clockFormat.format(now); }
export function nextDate(key, days = 1) {
  const date = new Date(`${key}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function dateRange(start, end) {
  const first = new Date(`${start}T12:00:00Z`);
  const last = new Date(`${end}T12:00:00Z`);
  return start === end ? fullDate.format(first) : fullDate.formatRange(first, last);
}

export function stamp(value) {
  const time = typeof value === 'number' ? value : epoch(value);
  return Number.isFinite(time) ? `${shortDate.format(time)}, ${clock(time)}` : '—';
}

export function parseSnapshot(data, mode = 'live') {
  if (data?.schema !== 1 || data.kind !== mode || data.validity !== 'valid' ||
      typeof data.version !== 'string' || !data.version || !Number.isFinite(epoch(data.published_at)) ||
      (data.source_updated_at != null && !Number.isFinite(epoch(data.source_updated_at))) ||
      !Array.isArray(data.days) || !Array.isArray(data.flights) || !Array.isArray(data.priority_airports) ||
      data.priority_airports.some(code => typeof code !== 'string' || !/^[A-Z]{3}$/.test(code))) {
    throw new Error('Nieprawidłowy pakiet danych');
  }
  const days = new Map();
  for (const day of data.days) {
    if (!validDate(day?.operating_date) || days.has(day.operating_date) || !['complete', 'partial', 'unavailable'].includes(day.coverage)) {
      throw new Error('Nieprawidłowa doba lotnicza');
    }
    days.set(day.operating_date, { ...day, endDate: day.operating_date, endTime: -Infinity, flights: [] });
  }
  const ids = new Set();
  for (const row of data.flights) {
    const day = days.get(row?.operating_date);
    const scheduled = epoch(row?.scheduled_at);
    if (!day || day.coverage === 'unavailable' || !Number.isFinite(scheduled) || dateKey(scheduled) !== row.arrival_date ||
        row.arrival_date < row.operating_date || !STATUSES.includes(row.status_code) ||
        typeof row.flight_id !== 'string' || !row.flight_id || ids.has(row.flight_id) ||
        typeof row.origin_city !== 'string' || !row.origin_city.trim() || !/^[A-Z]{3}$/.test(row.origin_airport)) {
      throw new Error('Nieprawidłowy rejs');
    }
    const estimated = row.estimated_at == null ? null : epoch(row.estimated_at);
    const actual = row.actual_landed_at == null ? null : epoch(row.actual_landed_at);
    if ((estimated !== null && !Number.isFinite(estimated)) ||
        (actual !== null && (!Number.isFinite(actual) || !CONFIRMED.has(row.status_code)))) {
      throw new Error('Nieprawidłowy czas przylotu');
    }
    ids.add(row.flight_id);
    const terminal = TERMINAL.has(row.status_code);
    const effective = terminal ? scheduled : (actual ?? estimated ?? scheduled);
    day.endDate = [day.endDate, row.arrival_date, dateKey(effective)].sort().at(-1);
    if (!terminal) day.endTime = Math.max(day.endTime, effective);
    day.flights.push({ ...row, scheduled, estimated, actual, effective, terminal });
  }
  for (const day of days.values()) day.flights.sort((a, b) => a.scheduled - b.scheduled || a.flight_id.localeCompare(b.flight_id));
  return { ...data, days, priorities: new Set(data.priority_airports) };
}

export function operatingDate(snapshot, now) {
  const today = dateKey(now);
  const previous = snapshot?.days.get(nextDate(today, -1));
  if (!previous || previous.endDate < today) return today;
  if (previous.endTime >= now) return previous.operating_date;
  const firstToday = snapshot.days.get(today)?.flights.find(row => !row.terminal)?.scheduled;
  const hasUnconfirmedOvernight = previous.flights.some(row => !row.terminal && !CONFIRMED.has(row.status_code) && dateKey(row.effective) >= today);
  if (firstToday && now < firstToday && hasUnconfirmedOvernight) return previous.operating_date;
  return today;
}

function minutesText(minutes) {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours ? `${hours}h${rest ? ` ${rest}m` : ''}` : `${rest}m`;
}

export function presentation(row, priorities, now) {
  const priority = priorities.has(row.origin_airport);
  const city = localizedCity[row.origin_airport] ?? row.origin_city;
  const confirmed = CONFIRMED.has(row.status_code);
  const timeLabel = row.estimated == null ? '' : ` → ${clock(row.estimated)}`;
  const labels = {
    scheduled: 'Rozkładowo', expected: `Oczekiwany${timeLabel}`,
    delayed: row.estimated == null ? 'Opóźn. · brak czasu' : `Opóźn.${timeLabel}`,
    landed: 'Wylądował', baggage_belt: 'Bagaż na taśmie', baggage_delivered: 'Bagaż wydany',
    cancelled: 'ODWOŁANY', diverted: 'PRZEKIEROWANY', unknown: 'Brak statusu'
  };
  const status = labels[row.status_code];
  if (row.terminal) return { city, priority, status, phase: 'old', countdown: '—' };
  if (row.status_code === 'delayed' && row.estimated == null) return { city, priority, status, phase: 'pending', countdown: '?' };
  const elapsed = now - row.effective;
  if (elapsed < 0 && !confirmed) {
    return { city, priority, status, phase: 'pending', countdown: minutesText(Math.ceil(-elapsed / 60000)) };
  }
  if (elapsed < 0) return { city, priority, status, phase: 'pending', countdown: '?' };
  const approximate = row.actual == null;
  return { city, priority, status, phase: elapsed <= 3600000 ? 'recent' : 'old',
    countdown: `${approximate ? '~' : ''}+${minutesText(Math.floor(elapsed / 60000))}` };
}

export function sourceIsStale(snapshot, day, now) {
  const sourceTime = epoch(snapshot?.source_updated_at);
  const active = day?.flights.some(row => !row.terminal &&
    (!CONFIRMED.has(row.status_code) || now - row.effective <= 3600000));
  return Boolean(active && (!Number.isFinite(sourceTime) || now - sourceTime > 1200000));
}

export function publicFeedUrl(input) {
  let url;
  try { url = new URL(input.trim()); } catch { return ''; }
  if (url.origin !== 'https://script.google.com' || url.username || url.password || url.search || url.hash ||
      !/^\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(url.pathname)) return '';
  return url.href;
}
