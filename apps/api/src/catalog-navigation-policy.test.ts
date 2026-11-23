import {test} from 'node:test';
import assert from 'node:assert/strict';
import {catalogNavigationInput,initialCatalogPath} from './catalog-navigation-policy.js';
const valid=()=>({expectedVersion:1,reason:'Organize service navigation',contentClass:'GENERAL',
  items:[{serviceCode:'INC-BIZ',path:[' 信息化系统 ',' WMS系统 '],sortOrder:20}]});
test('navigation keeps the canonical service code and trims grouping labels',()=>{
  const result=catalogNavigationInput(valid());
  assert.deepEqual(result.items,[{serviceCode:'INC-BIZ',path:['信息化系统','WMS系统'],sortOrder:20}]);
  assert.deepEqual(initialCatalogPath('NEW-SERVICE'),['其他服务']);
  const path=initialCatalogPath('INC-NET');path[0]='changed';
  assert.deepEqual(initialCatalogPath('INC-NET'),['网络与远程访问']);
});
test('navigation rejects invalid hierarchy, duplicates and unrelated business writes',()=>{
  for(const input of [null,[],{...valid(),published:true},{...valid(),expectedVersion:0},
    {...valid(),items:[valid().items[0],valid().items[0]]},
    ...[[],[''],['a','b','c'],['a','\n']].map(path=>({...valid(),items:[{...valid().items[0],path}]})),
    ...[-1,1.1,100000].map(sortOrder=>({...valid(),items:[{...valid().items[0],sortOrder}]})),
    {...valid(),items:[{...valid().items[0],groupId:'applications'}]}]){
    assert.throws(()=>catalogNavigationInput(input));
  }
});
test('application defaults include new system services and configured custom systems',()=>{
  for(const system of ['ERP','SRM','WMS','OA','AGV','PDM','COST','HUB','TB'])
    assert.deepEqual(initialCatalogPath(`INC-${system}`),['信息化系统',`${system}系统`]);
  assert.deepEqual(initialCatalogPath('INC-CUSTOM',' CRM '),['信息化系统','CRM系统']);
  assert.deepEqual(initialCatalogPath('INC-CUSTOM','客户服务平台'),['信息化系统','客户服务平台']);
  assert.deepEqual(initialCatalogPath('INC-CUSTOM',''),['其他服务']);
  assert.deepEqual(initialCatalogPath('INC-MAIL'),['账号与邮箱']);
  assert.deepEqual(initialCatalogPath('INC-MAIL','企业邮箱'),['信息化系统','企业邮箱']);
});
