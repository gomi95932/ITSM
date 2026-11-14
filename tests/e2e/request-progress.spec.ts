import { test,expect } from './fixtures';
import { createRequestProgressFixture } from '../support/request-progress.mjs';

for(const viewport of [{name:'desktop',width:1440,height:1000},{name:'mobile',width:390,height:844}]){
  test(`requester progress, empty records and role boundaries on ${viewport.name}`,async({page})=>{
    await page.setViewportSize({width:viewport.width,height:viewport.height});
    const scenarios=[
      {state:{},labels:['审批记录尚未生成。','交付记录尚未生成；审批通过不代表权限已开通。']},
      {state:{approvalState:'PENDING'},labels:['审批中','交付记录尚未生成；审批通过不代表权限已开通。']},
      {state:{approvalState:'APPROVED',fulfillmentState:'READY'},labels:['审批已通过','待人工交付']},
      {state:{approvalState:'APPROVED',fulfillmentState:'DELIVERED'},labels:['审批已通过','已交付','交付时间：','权限到期：','交付复核：']},
      {state:{approvalState:'APPROVED',fulfillmentState:'REVOKE_DUE'},labels:['待回收','权限到期：']},
      {state:{approvalState:'APPROVED',fulfillmentState:'REVOKED'},labels:['已回收','回收时间：']},
      {state:{approvalState:'BLOCKED',fulfillmentState:'BLOCKED'},labels:['受阻待处理','交付受阻']},
    ];
    let ticketId='',ticketSubject='';
    for(const scenario of scenarios){
      const fixture=await createRequestProgressFixture(scenario.state);ticketId=fixture.id;ticketSubject=fixture.subject;
      await page.goto(`/#/tickets/${fixture.id}`);
      const progress=page.getByRole('region',{name:'申请进度'});
      await expect(progress).toBeVisible();
      for(const label of scenario.labels)await expect(progress).toContainText(label);
      await expect(page.getByRole('heading',{name:fixture.subject,exact:true})).toBeVisible();
      expect(await page.locator('body').innerText()).not.toContain(fixture.internalMarker);
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
      if(scenario.state.fulfillmentState==='DELIVERED')
        await page.screenshot({path:`test-results/request-progress-${viewport.name}.png`,fullPage:true});
    }
    await page.getByRole('combobox',{name:'开发身份'}).selectOption('agent-1');
    await expect(page.getByRole('heading',{name:'我的工单',exact:true})).toBeVisible();
    await page.goto(`/#/tickets/${ticketId}`);
    await expect(page.getByRole('heading',{name:ticketSubject,exact:true})).toBeVisible();
    await expect(page.getByRole('region',{name:'申请进度'})).toHaveCount(0);
    await expect(page.getByRole('button',{name:'返回工单列表',exact:true})).toBeVisible();
    await page.getByRole('combobox',{name:'开发身份'}).selectOption('employee-2');
    await expect(page.getByRole('heading',{name:'我的工单',exact:true})).toBeVisible();
    await page.goto(`/#/tickets/${ticketId}`);
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.getByRole('region',{name:'申请进度'})).toHaveCount(0);
  });
}
