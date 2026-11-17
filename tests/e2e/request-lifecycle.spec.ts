import { randomUUID } from 'node:crypto';
import { test,expect } from './fixtures';
import { createFulfillmentFixture } from '../support/fulfillment.mjs';

for(const viewport of [{name:'desktop',width:1440,height:1000},{name:'mobile',width:390,height:844}]){
  test(`request delivery and requester confirmation on ${viewport.name}`,async({page})=>{
    await page.setViewportSize({width:viewport.width,height:viewport.height});
    const f=await createFulfillmentFixture();
    const accept=await page.request.post(`/api/v1/tickets/${f.ticketId}/actions`,{
      headers:{'X-Dev-User':'agent-1','Idempotency-Key':randomUUID()},
      data:{contentClass:'GENERAL',action:'ACCEPT',expectedVersion:1,comment:'I will complete this delivery'}});
    expect(accept.status()).toBe(200);
    await page.goto('/');
    await page.getByRole('combobox',{name:'开发身份'}).selectOption('agent-1');
    await expect(page.getByRole('heading',{name:'我的工单',exact:true})).toBeVisible();
    await page.goto(`/#/tickets/${f.ticketId}`);
    await expect(page.getByRole('heading',{name:f.subject,exact:true})).toBeVisible();
    await expect(page.getByRole('button',{name:'提交交付完成',exact:true})).toHaveCount(0);
    await expect(page.getByText('交付完成条件未齐备，待核验审批、实际交付及独立复核记录。',{exact:true})).toBeVisible();
    await expect(page.getByRole('button',{name:'分类纠偏',exact:true})).toHaveCount(0);
    await page.screenshot({path:`test-results/request-lifecycle-unreviewed-${viewport.name}.png`,fullPage:true});

    const task=await page.request.get(`/api/v1/fulfillments/${f.id}`,{headers:{'X-Dev-User':'agent-2'}});
    expect(task.status()).toBe(200);
    const reviewed=await page.request.post(`/api/v1/fulfillments/${f.id}/review`,{
      headers:{'X-Dev-User':'agent-2','Idempotency-Key':randomUUID()},
      data:{contentClass:'GENERAL',expectedVersion:(await task.json()).version,reference:`UI-REVIEW-${randomUUID()}`}});
    expect(reviewed.status()).toBe(200);
    await page.reload();
    await expect(page.getByText('交付与独立复核记录齐备',{exact:true})).toBeVisible();
    await page.getByRole('button',{name:'提交交付完成',exact:true}).click();
    const form=page.locator('.action-form');
    await form.getByRole('textbox',{name:'交付说明',exact:true}).fill('Requested account is ready and independently checked');
    await form.getByRole('combobox',{name:'交付分类',exact:true}).selectOption({label:'权限开通'});
    await form.getByRole('textbox',{name:'验证依据',exact:true}).fill('CI delivery verification');
    await form.getByRole('checkbox',{name:'本次内容不含密码、密钥及安全事件证据'}).check();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.screenshot({path:`test-results/request-lifecycle-delivery-${viewport.name}.png`,fullPage:true});
    await form.getByRole('button',{name:'提交交付完成',exact:true}).click();
    await expect(page.getByText('待确认',{exact:true}).first()).toBeVisible();

    await page.getByRole('combobox',{name:'开发身份'}).selectOption('employee-1');
    await expect(page.getByRole('heading',{name:'我的工单',exact:true})).toBeVisible();
    await page.goto(`/#/tickets/${f.ticketId}`);
    await expect(page.getByRole('region',{name:'申请进度'})).toContainText('已交付');
    await expect(page.getByRole('button',{name:'交付仍有问题',exact:true})).toBeVisible();
    await expect(page.getByRole('button',{name:'确认已交付',exact:true})).toBeVisible();
    expect(await page.locator('body').innerText()).not.toContain(f.internalMarker);
    expect(await page.locator('body').innerText()).not.toContain(f.deliveryReference);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.screenshot({path:`test-results/request-lifecycle-confirmation-${viewport.name}.png`,fullPage:true});
    await page.getByRole('button',{name:'确认已交付',exact:true}).click();
    await form.getByRole('checkbox',{name:'本次内容不含密码、密钥及安全事件证据'}).check();
    await form.getByRole('button',{name:'确认已交付',exact:true}).click();
    await expect(page.getByText('已关闭',{exact:true}).first()).toBeVisible();
    await expect(page.getByRole('button',{name:'确认已交付',exact:true})).toHaveCount(0);
    await expect(page.getByRole('button',{name:'交付仍有问题',exact:true})).toHaveCount(0);
    await expect(page.getByRole('region',{name:'申请进度'})).toContainText('已交付');
  });
}
