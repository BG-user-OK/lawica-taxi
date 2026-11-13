import { dateKey, DEFAULT_PRIORITIES, nextDate } from './board.js';

export function demoSnapshot(now = Date.now()) {
  const today = dateKey(now);
  const tomorrow = nextDate(today);
  const yesterday = nextDate(today, -1);
  const offsetFormat = new Intl.DateTimeFormat('en', { timeZone: 'Europe/Warsaw', timeZoneName: 'longOffset' });
  const at = (day, hour) => {
    const offset = offsetFormat.formatToParts(new Date(`${day}T12:00:00Z`)).find(part => part.type === 'timeZoneName').value.slice(3);
    return new Date(`${day}T${hour}:00${offset}`).toISOString();
  };
  const examples = [
    ['FRA', 'Frankfurt', 'landed'], ['BHX', 'Birmingham', 'baggage_belt'],
    ['AMS', 'Amsterdam', 'baggage_delivered'], ['WAW', 'Warszawa', 'expected'],
    ['LTN', 'Londyn', 'delayed'], ['BVA', 'Paryż', 'scheduled'],
    ['CPH', 'Kopenhaga', 'cancelled'], ['BGY', 'Mediolan – Bergamo', 'diverted'],
    ['AGP', 'Malaga', 'delayed'], ['PMO', 'Palermo', 'scheduled']
  ];
  const row = (day, time, example, index, overrides = {}) => {
    const [airport, city, status] = example;
    const scheduled = at(day, time);
    return {
      flight_id: `TEST-${day}-${index}`, operating_date: day, arrival_date: dateKey(Date.parse(scheduled)),
      scheduled_at: scheduled, estimated_at: airport === 'LTN' || airport === 'WAW' ? new Date(+new Date(scheduled) + 900000).toISOString() : null,
      actual_landed_at: status === 'landed' ? scheduled : null, origin_city: city, origin_airport: airport,
      status_code: status, status_text: '', source_name: 'TEST DATA', ...overrides
    };
  };
  const flights = [];
  for (const day of [yesterday, today, tomorrow]) {
    for (let i = 0; i < 36; i++) {
      const hour = 6 + Math.floor(i / 2);
      flights.push(row(day, `${String(hour).padStart(2, '0')}:${i % 2 ? '30' : '00'}`, examples[i % examples.length], i));
    }
    const overnightDate = nextDate(day);
    flights.push(row(day, '23:59', examples[5], 36, { arrival_date: overnightDate, scheduled_at: at(overnightDate, '00:20') }));
  }
  return { schema: 1, kind: 'test', validity: 'valid', version: 'TEST', published_at: new Date(now).toISOString(),
    source_updated_at: null, priority_airports: DEFAULT_PRIORITIES,
    days: [yesterday, today, tomorrow].map(operating_date => ({ operating_date, coverage: 'complete' })), flights };
}
