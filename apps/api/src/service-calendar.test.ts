import assert from 'node:assert/strict';
import {test} from 'node:test';
import {DEFAULT_CALENDAR,serviceMinutes,validServiceCalendar} from '@itsm/contracts';

test('service calendars reject malformed dates, ambiguous days and invalid hours',()=>{
  assert.equal(validServiceCalendar(DEFAULT_CALENDAR),true);
  const invalid=[{endHour:9},{startHour:-1},{endHour:25},{startHour:9.5},{timeZone:'UTC'},
    {holidays:['2026-02-30']},{workdays:['2026-11-31']},{holidays:['2026-2-01']},
    {holidays:['2026-01-01','2026-01-01']},{holidays:['2026-01-01'],workdays:['2026-01-01']},
    {holidays:Array(731).fill('2026-01-01')},{extra:true}];
  for(const patch of invalid)assert.equal(validServiceCalendar({...DEFAULT_CALENDAR,...patch}),false,JSON.stringify(patch));
  assert.equal(validServiceCalendar({...DEFAULT_CALENDAR,holidays:['2028-02-29']}),true);
  assert.equal(validServiceCalendar({...DEFAULT_CALENDAR,holidays:['2027-02-29']}),false);
});

test('holidays, makeup days and 24x7 critical incidents use distinct clock rules',()=>{
  const calendar={...DEFAULT_CALENDAR,holidays:['2026-11-23'],workdays:['2026-11-22']};
  const start=new Date('2026-11-22T00:00:00Z'),end=new Date('2026-11-24T16:00:00Z');
  assert.equal(serviceMinutes(start,end,calendar),1080);
  assert.equal(serviceMinutes(start,end,calendar,true),3840);
});
