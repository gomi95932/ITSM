import { serviceMinutes, type ServiceCalendar } from './sla.js';

// Find the first whole minute at which the approved calendar consumes the budget.
export function assignmentDeadline(start: Date, minutes: number, calendar: ServiceCalendar, always = false): Date {
  if (!Number.isFinite(minutes) || minutes < 0) throw new Error('INVALID_ASSIGNMENT_BUDGET');
  const origin = start.getTime();
  if (minutes === 0) return new Date(origin);
  const limit = 366 * 24 * 60;
  if (serviceMinutes(start,new Date(origin+limit*60000),calendar,always) < minutes)
    throw new Error('ASSIGNMENT_CALENDAR_EXHAUSTED');
  let low=0,high=limit;
  while (low<high) {
    const mid=Math.floor((low+high)/2);
    if (serviceMinutes(start,new Date(origin+mid*60000),calendar,always)>=minutes) high=mid;
    else low=mid+1;
  }
  return new Date(origin+low*60000);
}
