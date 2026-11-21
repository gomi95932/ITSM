import { serviceMinutes, type ServiceCalendar } from './sla.js';
export interface PriorityObligation {id:string;priority:string;startedAt:string;responseTarget:number;resolutionTarget:number}
export interface SlaClock {
  started_at:Date;responded_at:Date|null;completed_at:Date|null;paused_at:Date|null;paused_minutes:number;
  priority:string;response_target:number;resolution_target:number;calendar_snapshot:ServiceCalendar;
  priority_obligations?:PriorityObligation[];pause_history?:{from:string;to:string}[];
}
export function prioritySlaMeasurements(row:SlaClock,clock:Date) {
  const end=row.completed_at??clock,calendar=row.calendar_snapshot;
  const measure=(id:string,priority:string,start:Date,responseTarget:number,resolutionTarget:number,paused:number)=>{
    const responseMinutes=serviceMinutes(start,row.responded_at??end,calendar,priority==='P1');
    const resolutionMinutes=Math.max(0,serviceMinutes(start,end,calendar,priority==='P1')-paused);
    return {id,priority,responseTarget,resolutionTarget,responseMinutes,resolutionMinutes,
      breached:responseMinutes>responseTarget||resolutionMinutes>resolutionTarget};
  };
  const base=measure('original',row.priority,row.started_at,row.response_target,row.resolution_target,Number(row.paused_minutes)
    +(row.paused_at?serviceMinutes(row.paused_at,end,calendar,row.priority==='P1'):0));
  const additional=(row.priority_obligations??[]).map(o=>{
    const start=new Date(o.startedAt),ranges=[...(row.pause_history??[]),...(row.paused_at?[{from:row.paused_at.toISOString(),to:end.toISOString()}]:[])];
    const paused=ranges.reduce((sum,r)=>sum+serviceMinutes(new Date(Math.max(start.getTime(),new Date(r.from).getTime())),
      new Date(Math.min(end.getTime(),new Date(r.to).getTime())),calendar,o.priority==='P1'),0);
    return measure(o.id,o.priority,start,o.responseTarget,o.resolutionTarget,paused);
  });
  return [base,...additional];
}
