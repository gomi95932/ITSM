import assert from 'node:assert/strict';
import test from 'node:test';
import {DEFAULT_PRIORITY_POLICY} from './priority.js';
import {EMPTY_OPERATIONS,validOperationsConfig} from './operations.js';
const fixture=()=>({...structuredClone(EMPTY_OPERATIONS),siteEnforced:true,sites:[{id:'site-a',name:'Site A',enabled:true}],
  employeeSites:[{employeeId:'employee-1',homeSiteId:'site-a',siteIds:['site-a']}],groupSites:[{groupId:'desk',siteIds:['site-a']}],
  positionSites:[{positionId:'position-a',siteIds:['site-a']}],serviceSites:[{serviceCode:'INC-PC',siteIds:['site-a']}],
  siteRoutes:[{serviceCode:'INC-PC',siteId:'site-a',positionId:'position-a'}],
  slaTemplates:[{id:'standard',name:'Standard',enabled:true,targets:structuredClone(DEFAULT_PRIORITY_POLICY.targets)}],
  serviceSlas:[{serviceCode:'INC-PC',templateId:'standard'}]});
test('operations configurations reject unknown keys, untrusted sites and ambiguous routes',()=>{
  assert.ok(validOperationsConfig(EMPTY_OPERATIONS));assert.ok(validOperationsConfig(fixture()));
  for(const mutate of [
    c=>{c.sites[0].enabled=false;},c=>{c.employeeSites[0].homeSiteId='site-b';},
    c=>{c.employeeSites[0].siteIds.push('site-a');},c=>{c.siteRoutes.push({...c.siteRoutes[0]});},
    c=>{c.positionSites=[];},c=>{c.serviceSites=[];},c=>{c.serviceSlas[0].templateId='missing';},
    c=>{c.slaTemplates[0].enabled=false;},c=>{c.slaTemplates[0].targets.P1.response=0;},
  ] as ((c:ReturnType<typeof fixture>)=>void)[]){const c=fixture();mutate(c);assert.equal(validOperationsConfig(c),false);}
  assert.equal(validOperationsConfig({...fixture(),clientSiteId:'site-a'}),false);
  assert.equal(validOperationsConfig({...fixture(),siteEnforced:'true'}),false);
});
