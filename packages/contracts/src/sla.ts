export interface ServiceCalendar {
  timeZone: 'Asia/Shanghai'; startHour: number; endHour: number;
  holidays: string[]; workdays: string[];
}
export const DEFAULT_CALENDAR: ServiceCalendar = { timeZone: 'Asia/Shanghai', startHour: 9, endHour: 18, holidays: [], workdays: [] };
export function validServiceCalendar(value: unknown): value is ServiceCalendar {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const c = value as Record<string, unknown>;
  if (Object.keys(c).sort().join(',') !== 'endHour,holidays,startHour,timeZone,workdays'
    || c.timeZone !== 'Asia/Shanghai' || !Number.isInteger(c.startHour) || !Number.isInteger(c.endHour)
    || Number(c.startHour) < 0 || Number(c.endHour) > 24 || Number(c.startHour) >= Number(c.endHour)) return false;
  const dates = (v: unknown): v is string[] => Array.isArray(v) && v.length <= 730 && new Set(v).size === v.length
    && v.every(d => typeof d === 'string' && /^20\d{2}-\d{2}-\d{2}$/.test(d)
      && Number.isFinite(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d);
  return dates(c.holidays) && dates(c.workdays) && !c.workdays.some(d => (c.holidays as string[]).includes(d));
}
export const SLA_TARGETS: Record<string, { response: number; resolution: number }> = {
  P1: { response: 15, resolution: 240 }, P2: { response: 30, resolution: 480 },
  P3: { response: 240, resolution: 1080 }, P4: { response: 540, resolution: 2700 },
};
const day = 86400000, offset = 8 * 3600000;

export function serviceMinutes(start: Date, end: Date, calendar: ServiceCalendar, always = false): number {
  if (end <= start) return 0;
  if (always) return (end.getTime() - start.getTime()) / 60000;
  if (calendar.timeZone !== 'Asia/Shanghai' || calendar.startHour < 0 || calendar.endHour > 24 || calendar.startHour >= calendar.endHour)
    throw new Error('INVALID_SERVICE_CALENDAR');
  let total = 0;
  for (let midnight = Math.floor((start.getTime() + offset) / day) * day - offset; midnight < end.getTime(); midnight += day) {
    const local = new Date(midnight + offset), date = local.toISOString().slice(0,10), weekday = local.getUTCDay();
    const working = calendar.workdays.includes(date) || (weekday > 0 && weekday < 6 && !calendar.holidays.includes(date));
    if (working) total += Math.max(0, Math.min(end.getTime(), midnight + calendar.endHour * 3600000) - Math.max(start.getTime(), midnight + calendar.startHour * 3600000)) / 60000;
  }
  return total;
}
