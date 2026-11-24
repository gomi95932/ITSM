import { test,expect } from './fixtures';

test('directory status is restricted to platform administrators and fits desktop and mobile',async({page})=>{
  await page.goto('/');
  await expect(page.getByRole('button',{name:'人员同步',exact:true})).toHaveCount(0);
  await page.getByRole('combobox',{name:'开发身份'}).selectOption('demo-admin-1');
  await page.getByRole('button',{name:'人员同步',exact:true}).click();
  await expect(page.getByRole('heading',{name:'人员同步',exact:true})).toBeVisible();
  await expect(page.getByRole('region',{name:'钉钉人员同步'})).toContainText('同步未启用');
  await expect(page.getByRole('region',{name:'钉钉人员同步'})).toContainText('暂无同步记录');
  await expect(page.getByRole('region',{name:'钉钉人员同步'})).toContainText('试点人员范围');
  await expect(page.getByRole('button',{name:'立即同步',exact:true})).toBeDisabled();
  await page.getByRole('button',{name:'刷新同步状态',exact:true}).click();
  await expect(page.getByRole('button',{name:'刷新同步状态',exact:true})).toBeEnabled();
  for(const [name,width,height] of [['desktop',1440,1000],['mobile',390,844]] as const){
    await page.setViewportSize({width,height});
    await expect(page.getByRole('region',{name:'人员同步概况'})).toBeVisible();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.screenshot({path:`test-results/directory-${name}.png`,fullPage:true});
  }
  await page.getByRole('combobox',{name:'开发身份'}).selectOption('agent-1');
  await expect(page.getByRole('button',{name:'人员同步',exact:true})).toHaveCount(0);
});

test('administrator can request manual sync and sees queued, completed and failed daily runs',async({page})=>{
  let active=false,finished=false,posts=0,deny=false;
  const runId='11111111-1111-4111-8111-111111111111';
  await page.route('**/api/v1/admin/directory/status',route=>route.fulfill({json:{enabled:true,configured:true,retireMissing:false,
    scopeMode:'authorized',automaticIntervalHours:24,lastSuccessAt:'2026-01-01T01:00:00Z',nextAutomaticAt:'2026-01-02T01:00:00Z',stale:false,
    activeRun:active?{id:runId,state:'QUEUED'}:null,counts:{people:100,active:100,missing:0,disabled:0},
    runs:[{id:runId,state:active?'QUEUED':finished?'SUCCEEDED':'FAILED',triggerSource:finished||active?'MANUAL':'AUTOMATIC',
      peopleCount:100,createdCount:0,updatedCount:100,disabledCount:0,missingCount:0,startedAt:'2026-01-01T01:00:00Z',completedAt:null,
      errorCode:!active&&!finished?'DIRECTORY_PROVIDER_INVALID':null,errorDetails:!active&&!finished?{stage:'MEMBER_API',vendorCode:88,vendorSubcode:'60011'}:null}]}}));
  await page.route('**/api/v1/admin/directory/sync',async route=>{
    posts++;expect(route.request().method()).toBe('POST');
    expect(route.request().headers()['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
    if(deny){await route.fulfill({status:409,json:{code:'DIRECTORY_SYNC_BUSY'}});return;}
    active=true;await route.fulfill({status:202,json:{id:runId,state:'QUEUED',reused:false}});
  });
  await page.goto('/');
  await page.getByRole('combobox',{name:'开发身份'}).selectOption('demo-admin-1');
  await page.getByRole('button',{name:'人员同步',exact:true}).click();
  await expect(page.getByRole('region',{name:'钉钉人员同步'})).toContainText('每天一次');
  await expect(page.getByRole('region',{name:'钉钉人员同步'})).toContainText('MEMBER_API / 88 / 60011');
  await page.getByRole('button',{name:'立即同步',exact:true}).click();
  await expect(page.getByRole('status')).toContainText('同步任务已提交');
  await expect(page.getByRole('button',{name:'等待同步',exact:true})).toBeDisabled();
  expect(posts).toBe(1);
  active=false;finished=true;
  await page.getByRole('button',{name:'刷新同步状态',exact:true}).click();
  await expect(page.getByRole('button',{name:'立即同步',exact:true})).toBeEnabled();
  await expect(page.getByRole('region',{name:'钉钉人员同步'})).toContainText('管理员手工');
  deny=true;await page.getByRole('button',{name:'立即同步',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('同步');
  await expect(page.getByRole('button',{name:'立即同步',exact:true})).toBeEnabled();
  for(const [name,width,height] of [['desktop',1440,1000],['mobile',390,844]] as const){
    await page.setViewportSize({width,height});
    await expect(page.getByRole('button',{name:'立即同步',exact:true})).toBeVisible();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.screenshot({path:`test-results/directory-manual-${name}.png`,fullPage:true});
  }
});
