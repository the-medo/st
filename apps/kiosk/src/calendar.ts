export type Entry = {
  id: number | string; kind: string; title: string; starts?: string | null; zone?: string | null;
  done: boolean; body?: string; version?: number | string;
};
export type Panel = {
  view: string; revision: number; theme?: string; spec: {kind:string; widgets?:string[]; asset?:string};
  records: Entry[]; room_reply?: string; views: string[];
  planner_status?: 'ok' | 'unavailable';
};
type AgendaRow = {entry: Entry; time: string; zone: string; order: string};
type AgendaDay = {key: string; label: string; rows: AgendaRow[]};

const dayFormat = new Intl.DateTimeFormat(undefined, {weekday:'short', month:'short', day:'numeric', timeZone:'UTC'});
const dayWithYear = new Intl.DateTimeFormat(undefined, {weekday:'short', year:'numeric', month:'short', day:'numeric', timeZone:'UTC'});
const deviceZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

function schedule(entry: Entry) {
  const raw = entry.starts?.trim() || '';
  const match = /^(\d{4}-\d\d-\d\d)(?:[T ](\d\d):(\d\d)(?::\d\d(?:\.\d+)?)?(Z|[+-]\d\d:?\d\d)?)?$/i.exec(raw);
  if (!match) return {day:'', time:raw || 'Unscheduled', zone:'', order:raw};
  let [,day,hour,minute,offset] = match;
  const calendarDate = new Date(day + 'T12:00:00Z');
  if (!Number.isFinite(+calendarDate) || calendarDate.toISOString().slice(0,10) !== day ||
      (hour && (+hour > 23 || +minute > 59))) return {day:'', time:raw, zone:'', order:raw};

  // Offset-free times are already wall times in the saved event zone. An explicit
  // offset represents an instant and must be converted before grouping by day.
  let zone = entry.zone || '';
  if (offset) {
    const instant = new Date(raw.replace(' ','T'));
    try {
      const parts = new Intl.DateTimeFormat('en-GB', {timeZone:zone || deviceZone, year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(instant);
      const value = Object.fromEntries(parts.map(p => [p.type,p.value]));
      day = [value.year,value.month,value.day].join('-'); hour=value.hour; minute=value.minute;
    } catch { zone = offset; }
  }
  const time = hour ? hour + ':' + minute : 'All day';
  return {day,time,zone:hour && zone && zone !== deviceZone ? (zone.split('/').at(-1) || zone).replaceAll('_',' ') : '',order:hour ? hour + minute : ''};
}

export function agendaDays(records: Entry[]): AgendaDay[] {
  const days = new Map<string, AgendaDay>();
  for (const entry of records) {
    if (entry.kind !== 'event' || entry.done) continue;
    const {day,time,zone,order} = schedule(entry);
    if (!days.has(day)) {
      const date = day ? new Date(day + 'T12:00:00Z') : null;
      const format = date && date.getUTCFullYear() !== new Date().getFullYear() ? dayWithYear : dayFormat;
      days.set(day,{key:day,label:date ? format.format(date) : 'Other events',rows:[]});
    }
    days.get(day)!.rows.push({entry,time,zone,order});
  }
  for (const section of days.values()) section.rows.sort((a,b) => a.order.localeCompare(b.order) || String(a.entry.id).localeCompare(String(b.entry.id)));
  return [...days.values()].sort((a,b) => Number(!a.key)-Number(!b.key) || a.key.localeCompare(b.key));
}
