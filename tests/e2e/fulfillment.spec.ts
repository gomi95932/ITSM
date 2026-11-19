import { test,expect } from './fixtures';
import { createFulfillmentFixture } from '../support/fulfillment.mjs';

for(const viewport of [{name:'desktop',width:1440,height:1000},{name:'mobile',width:390,height:844}]){
  test(`fulfillment independent review, actual revocation and role boundaries on ${viewport.name}`,async({page})=>{
    const fixture=await createFulfillmentFixture();
    await page.setViewportSize({width:viewport.width,height:viewport.height});
    await page.goto('/');
    await page.getByRole('combobox',{name:'开发身份'}).selectOption('agent-2');
    await page.goto('/#/fulfillments');
    const panel=page.getByRole('region',{name:'交付与回收工作台',exact:true});
    await expect(panel.getByRole('combobox',{name:'责任组'})).toBeVisible();
    await panel.getByRole('combobox',{name:'责任组'}).selectOption(fixture.groupId);
    await panel.getByRole('button').filter({hasText:fixture.subject}).click();
    const detail=page.getByRole('region',{name:'交付任务详情',exact:true});
    await expect(detail).toContainText(fixture.subject);
    expect(await panel.innerText()).not.toContain(fixture.internalMarker);
    await expect(detail.getByRole('button',{name:'确认独立复核',exact:true})).toBeDisabled();
    const reviewReference=`CI-REVIEW-${viewport.name}-${fixture.id}`;
    await detail.getByRole('textbox',{name:'外部执行记录编号'}).fill(reviewReference);
    await detail.getByRole('checkbox',{name:'本次内容不含密码、密钥及安全事件证据'}).check();
    await detail.getByRole('button',{name:'确认独立复核',exact:true}).click();
    await expect(panel.getByRole('status')).toHaveText('独立复核已记录。');
    await expect(page.getByRole('region',{name:'交付处理记录'})).toContainText(reviewReference);
    await expect(detail).toContainText('应用支持工程师');
    await page.screenshot({path:`test-results/fulfillment-reviewed-${viewport.name}.png`,fullPage:true});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await panel.getByRole('button',{name:'刷新交付任务',exact:true}).click();
    await expect(detail).toContainText('登记实际回收');
    const revokeReference=`CI-REVOKE-${viewport.name}-${fixture.id}`;
    await detail.getByRole('textbox',{name:'外部执行记录编号'}).fill(revokeReference);
    await detail.getByRole('checkbox',{name:'本次内容不含密码、密钥及安全事件证据'}).check();
    await expect(detail.getByRole('button',{name:'登记实际回收',exact:true})).toBeDisabled();
    await detail.getByRole('checkbox',{name:'已在目标系统实际完成撤权，并核对上述记录'}).check();
    await detail.getByRole('button',{name:'登记实际回收',exact:true}).click();
    await expect(panel.getByRole('status')).toHaveText('实际回收结果已登记。');
    await expect(detail).toContainText('已登记回收');
    await expect(detail).toContainText('当前无可执行操作');
    await expect(page.getByRole('region',{name:'交付处理记录'})).toContainText(revokeReference);
    await page.screenshot({path:`test-results/fulfillment-revoked-${viewport.name}.png`,fullPage:true});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await panel.getByRole('button',{name:'返回列表',exact:true}).click();
    await expect(panel).toContainText('当前队列暂无任务');
    await panel.getByRole('tab',{name:/^全部/}).click();
    await expect(panel.getByRole('button').filter({hasText:fixture.subject})).toBeVisible();

    await page.getByRole('combobox',{name:'开发身份'}).selectOption('employee-2');
    await page.goto('/#/fulfillments');
    await expect(page.getByRole('heading',{name:'我的工单',exact:true})).toBeVisible();
    await expect(page.getByRole('region',{name:'交付与回收工作台',exact:true})).toHaveCount(0);
    await expect(page.getByRole('button',{name:'交付与回收',exact:true})).toHaveCount(0);
    const denied=await page.request.get(`/api/v1/fulfillments/${fixture.id}`,{headers:{'X-Dev-User':'employee-2'}});
    expect(denied.status()).toBe(404);
  });
}

test('fulfillment loading, failed refresh and retry retain a usable workspace',async({page})=>{
  const fixture=await createFulfillmentFixture();
  await page.goto('/');
  await page.getByRole('combobox',{name:'开发身份'}).selectOption('agent-2');
  let release:()=>void=()=>{};
  const hold=new Promise<void>(resolve=>{release=resolve;});
  await page.route('**/api/v1/fulfillments?*',async route=>{await hold;await route.continue();},{times:1});
  await page.getByRole('button',{name:'交付与回收',exact:true}).click();
  const panel=page.getByRole('region',{name:'交付与回收工作台',exact:true});
  await expect(panel.getByRole('status')).toHaveText('正在加载任务');
  await expect(panel.getByRole('button',{name:'刷新交付任务'})).toBeDisabled();
  release();
  await expect(panel.getByRole('combobox',{name:'责任组'})).toBeVisible();
  await panel.getByRole('combobox',{name:'责任组'}).selectOption(fixture.groupId);
  await expect(panel.getByRole('button').filter({hasText:fixture.subject})).toBeVisible();
  await page.route('**/api/v1/fulfillments?*',route=>route.fulfill({status:503,contentType:'application/json',body:'{"code":"TEST_UNAVAILABLE"}'}),{times:1});
  await panel.getByRole('button',{name:'刷新交付任务',exact:true}).click();
  await expect(panel.getByRole('alert')).toBeVisible();
  await expect(panel).not.toContainText('当前队列暂无任务');
  await panel.getByRole('button',{name:'刷新交付任务',exact:true}).click();
  await expect(panel.getByRole('alert')).toHaveCount(0);
  await expect(panel.getByRole('button').filter({hasText:fixture.subject})).toBeVisible();

  const delivery=await createFulfillmentFixture();
  await page.getByRole('combobox',{name:'开发身份'}).selectOption('agent-1');
  await page.getByRole('button',{name:'交付与回收',exact:true}).click();
  await panel.getByRole('combobox',{name:'责任组'}).selectOption(delivery.groupId);
  await panel.getByRole('button').filter({hasText:delivery.subject}).click();
  const detail=page.getByRole('region',{name:'交付任务详情',exact:true});
  await expect(detail.getByRole('button',{name:'确认独立复核',exact:true})).toHaveCount(0);
  await expect(detail.getByRole('button',{name:'登记实际回收',exact:true})).toBeVisible();
});

test('fulfillment retries a lost successful response with the same command key',async({page})=>{
  const fixture=await createFulfillmentFixture();
  await page.goto('/');
  await page.getByRole('combobox',{name:'开发身份'}).selectOption('agent-2');
  await page.getByRole('button',{name:'交付与回收',exact:true}).click();
  const panel=page.getByRole('region',{name:'交付与回收工作台',exact:true});
  await panel.getByRole('combobox',{name:'责任组'}).selectOption(fixture.groupId);
  await panel.getByRole('button').filter({hasText:fixture.subject}).click();
  const detail=page.getByRole('region',{name:'交付任务详情',exact:true}),keys:string[]=[];
  await page.route(`**/api/v1/fulfillments/${fixture.id}/review`,async route=>{
    keys.push(route.request().headers()['idempotency-key']);
    if(keys.length===1){
      const response=await route.fetch();
      expect(response.status()).toBe(200);
      await route.abort('failed');
    }else await route.continue();
  });
  const reference=`RETRY-${fixture.id}`;
  await detail.getByRole('textbox',{name:'外部执行记录编号'}).fill(reference);
  await detail.getByRole('checkbox',{name:'本次内容不含密码、密钥及安全事件证据'}).check();
  await detail.getByRole('button',{name:'确认独立复核',exact:true}).click();
  await expect(panel.getByRole('alert')).toBeVisible();
  await expect(detail.getByRole('textbox',{name:'外部执行记录编号'})).toHaveValue(reference);
  await detail.getByRole('button',{name:'确认独立复核',exact:true}).click();
  await expect(panel.getByRole('status')).toHaveText('独立复核已记录。');
  expect(keys).toHaveLength(2);expect(keys[0]).toBeTruthy();expect(keys[1]).toBe(keys[0]);
  const response=await page.request.get(`/api/v1/fulfillments/${fixture.id}`,{headers:{'X-Dev-User':'agent-2'}});
  expect(response.status()).toBe(200);
  const result=await response.json();
  expect(result.events.filter((event:{action:string})=>event.action==='DELIVERY_REVIEWED')).toHaveLength(1);
});
