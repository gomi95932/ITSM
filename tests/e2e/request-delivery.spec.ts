import { test,expect } from './fixtures';
import { createFulfillmentFixture } from '../support/fulfillment.mjs';
import { processDeliveryCommands } from '../support/request-delivery.mjs';

test('first delivery stays visibly closed by default',async({page})=>{
  test.skip(process.env.ITSM_DELIVERY_CI_ENABLED==='true');
  await page.goto('/');
  await page.getByRole('combobox',{name:'开发身份'}).selectOption('agent-1');
  await page.getByRole('button',{name:'交付与回收',exact:true}).click();
  await page.getByRole('button',{name:'准备与首次交付',exact:true}).click();
  const panel=page.getByRole('region',{name:'准备与首次交付',exact:true});
  await expect(panel.getByRole('status')).toHaveText('首次交付暂未开放');
  await expect(panel.getByRole('button',{name:'领取准备任务',exact:true})).toHaveCount(0);
});

for(const viewport of [{name:'desktop',width:1440,height:1000},{name:'mobile',width:390,height:844}]){
  for(const action of ['PREPARE','DELIVER'] as const){
  test(`failed ${action} receipt updates notice on ${viewport.name}`,async({page})=>{
    test.skip(process.env.ITSM_DELIVERY_CI_ENABLED!=='true');
    test.setTimeout(90000);
    const fixture=await createFulfillmentFixture({state:action==='DELIVER'?'READY':null,appointed:true});
    await page.setViewportSize({width:viewport.width,height:viewport.height});
    await page.goto('/');
    await page.getByRole('combobox',{name:'开发身份'}).selectOption('agent-1');
    await page.getByRole('button',{name:'交付与回收',exact:true}).click();
    await page.getByRole('button',{name:'准备与首次交付',exact:true}).click();
    const panel=page.getByRole('region',{name:'准备与首次交付',exact:true});
    await panel.getByRole('combobox',{name:'责任组'}).selectOption(fixture.groupId);
    await panel.getByRole('button').filter({hasText:fixture.subject}).click();
    const operation=panel.getByRole('region',{name:'准备与交付操作',exact:true});
    if(action==='DELIVER'){
      await operation.getByRole('textbox',{name:'外部执行记录编号'}).fill(`CI-FAILED-${fixture.approvalId}`);
      await operation.getByRole('checkbox',{name:'已在目标系统实际完成交付，并核对上述记录'}).check();
    }
    await operation.getByRole('checkbox',{name:'本次内容不含密码、密钥及安全事件证据'}).check();
    await operation.getByRole('button',{name:action==='DELIVER'?'提交实际交付记录':'领取准备任务',exact:true}).click();
    await expect(panel.getByRole('status')).toHaveText('操作请求已提交，等待后台核验。');
    await expect(operation.getByRole('region',{name:'操作请求回执',exact:true})).toContainText('等待后台核验');
    await processDeliveryCommands('FAIL');
    // Let the normal polling path observe the terminal receipt without a manual refresh.
    const receipt=operation.getByRole('region',{name:'操作请求回执',exact:true});
    const outcome=action==='DELIVER'?'登记未通过，需核查实际授权':'未执行，核验未通过';
    await expect(receipt).toContainText(outcome,{timeout:15000});
    await expect(panel.getByRole('status')).toHaveText(`${outcome}。`);
    if(action==='DELIVER')await expect(receipt).not.toContainText('未执行');
    await expect(receipt).not.toContainText('provider-private-error-sentinel');
    await expect(panel.getByRole('row').filter({hasText:fixture.subject})).toContainText(outcome);
    await page.screenshot({path:`test-results/request-${action.toLowerCase()}-rejected-${viewport.name}.png`,fullPage:true});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await panel.getByRole('button').filter({hasText:fixture.subject}).click();
    await expect(panel.getByRole('status')).toHaveCount(0);
    await expect(operation.getByRole('region',{name:'操作请求回执',exact:true})).toContainText(outcome);
    if(action==='DELIVER'){
      await expect(operation.getByRole('button',{name:'提交实际交付记录',exact:true})).toHaveCount(0);
      await panel.getByRole('button',{name:'返回交付与回收',exact:true}).click();
      await page.getByRole('button',{name:'登记失败核查',exact:true}).click();
      const failures=page.getByRole('region',{name:'交付登记失败核查',exact:true});
      await failures.getByRole('combobox',{name:'责任组'}).selectOption(fixture.groupId);
      await failures.getByRole('button').filter({hasText:fixture.subject}).click();
      await expect(failures.getByRole('button',{name:'登记独立核查结果',exact:true})).toHaveCount(0);
      await page.getByRole('combobox',{name:'开发身份'}).selectOption('agent-2');
      await page.getByRole('button',{name:'交付与回收',exact:true}).click();
      await page.getByRole('button',{name:'登记失败核查',exact:true}).click();
      await failures.getByRole('combobox',{name:'责任组'}).selectOption(fixture.groupId);
      await failures.getByRole('button').filter({hasText:fixture.subject}).click();
      const verification=failures.getByRole('region',{name:'交付失败核查操作',exact:true});
      const submit=verification.getByRole('button',{name:'登记独立核查结果',exact:true});
      await expect(submit).toBeDisabled();
      const verificationReference=`CI-VERIFY-${viewport.name}-${fixture.approvalId}`;
      const result=viewport.name==='mobile'?'REVOKED':'NOT_GRANTED';
      await verification.getByRole('combobox',{name:'核查结果'}).selectOption(result);
      await verification.getByRole('textbox',{name:'外部核查记录编号'}).fill(verificationReference);
      await verification.getByRole('checkbox',{name:'本次内容不含密码、密钥及安全事件证据'}).check();
      await expect(submit).toBeDisabled();
      await verification.getByRole('checkbox',{name:'已在目标系统独立核查，确认本次未留存有效授权'}).check();
      await page.screenshot({path:`test-results/delivery-failure-investigation-${viewport.name}.png`,fullPage:true});
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
      const keys:string[]=[];
      await page.route('**/api/v1/fulfillments/delivery-failures/*/resolve',async route=>{
        keys.push(route.request().headers()['idempotency-key']);
        if(keys.length===1){const response=await route.fetch();expect(response.status()).toBe(200);await route.abort('failed');}
        else await route.continue();
      });
      await submit.click();await expect(failures.getByRole('alert')).toBeVisible();
      await expect(verification.getByRole('textbox',{name:'外部核查记录编号'})).toHaveValue(verificationReference);
      await submit.click();
      await expect(failures.getByRole('status')).toHaveText('独立核查结果已记录。');
      expect(keys).toHaveLength(2);expect(keys[0]).toBeTruthy();expect(keys[1]).toBe(keys[0]);
      await expect(failures.getByRole('button').filter({hasText:fixture.subject})).toHaveCount(0);
      await failures.getByRole('tab',{name:'已核查',exact:true}).click();
      await failures.getByRole('button').filter({hasText:fixture.subject}).click();
      await expect(verification).toContainText(verificationReference);
      await expect(verification).toContainText('应用支持工程师');
      await expect(verification).toContainText(result==='REVOKED'?'已核实实际撤权':'已核实未产生授权');
      await expect(verification.getByRole('button',{name:'登记独立核查结果',exact:true})).toHaveCount(0);
      expect(await failures.innerText()).not.toContain(fixture.internalMarker);
      await page.screenshot({path:`test-results/delivery-failure-resolved-${viewport.name}.png`,fullPage:true});
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    }
  });
  }
  test(`prepare and register actual first delivery on ${viewport.name}`,async({page})=>{
    test.skip(process.env.ITSM_DELIVERY_CI_ENABLED!=='true');
    test.setTimeout(90000);
    const fixture=await createFulfillmentFixture({state:null,appointed:true});
    await page.setViewportSize({width:viewport.width,height:viewport.height});
    await page.goto('/');
    await page.getByRole('combobox',{name:'开发身份'}).selectOption('agent-1');
    await page.getByRole('button',{name:'交付与回收',exact:true}).click();
    await page.getByRole('button',{name:'准备与首次交付',exact:true}).click();
    const panel=page.getByRole('region',{name:'准备与首次交付',exact:true});
    await panel.getByRole('combobox',{name:'责任组'}).selectOption(fixture.groupId);
    await panel.getByRole('button').filter({hasText:fixture.subject}).click();
    const operation=panel.getByRole('region',{name:'准备与交付操作',exact:true});
    await expect(operation.getByRole('button',{name:'领取准备任务',exact:true})).toBeDisabled();
    const keys:string[]=[];
    await page.route(`**/api/v1/fulfillments/intake/${fixture.approvalId}/prepare`,async route=>{
      keys.push(route.request().headers()['idempotency-key']);
      if(keys.length===1){const response=await route.fetch();expect(response.status()).toBe(202);await route.abort('failed');}
      else await route.continue();
    });
    await operation.getByRole('checkbox',{name:'本次内容不含密码、密钥及安全事件证据'}).check();
    await operation.getByRole('button',{name:'领取准备任务',exact:true}).click();
    await expect(panel.getByRole('alert')).toBeVisible();
    await operation.getByRole('button',{name:'领取准备任务',exact:true}).click();
    await expect(panel.getByRole('status')).toHaveText('操作请求已提交，等待后台核验。');
    await expect(operation.getByRole('region',{name:'操作请求回执',exact:true})).toContainText('等待后台核验');
    expect(keys).toHaveLength(2);expect(keys[0]).toBeTruthy();expect(keys[1]).toBe(keys[0]);
    await expect(operation.getByRole('button',{name:'提交实际交付记录',exact:true})).toHaveCount(0);
    await processDeliveryCommands('CONCURRENT');
    await panel.getByRole('button',{name:'刷新准备与交付',exact:true}).click();
    await expect(operation.getByRole('region',{name:'操作请求回执',exact:true})).toContainText('核验通过，操作已记录');
    await expect(panel.getByRole('status')).toHaveText('核验通过，操作已记录。');
    await expect(operation.getByRole('button',{name:'提交实际交付记录',exact:true})).toBeDisabled();
    await page.screenshot({path:`test-results/request-delivery-ready-${viewport.name}.png`,fullPage:true});
    const reference=`CI-DELIVERY-${viewport.name}-${fixture.approvalId}`;
    await operation.getByRole('textbox',{name:'外部执行记录编号'}).fill(reference);
    await operation.getByRole('checkbox',{name:'本次内容不含密码、密钥及安全事件证据'}).check();
    await expect(operation.getByRole('button',{name:'提交实际交付记录',exact:true})).toBeDisabled();
    await operation.getByRole('checkbox',{name:'已在目标系统实际完成交付，并核对上述记录'}).check();
    await operation.getByRole('button',{name:'提交实际交付记录',exact:true}).click();
    await expect(panel.getByRole('status')).toHaveText('操作请求已提交，等待后台核验。');
    await expect(operation.getByRole('region',{name:'操作请求回执',exact:true})).toContainText('等待后台核验');
    await processDeliveryCommands();
    await panel.getByRole('button',{name:'刷新准备与交付',exact:true}).click();
    await expect(operation).toContainText('当前无可执行操作');
    await expect(operation.getByRole('region',{name:'操作请求回执',exact:true})).toContainText('核验通过，操作已记录');
    await expect(panel.getByRole('status')).toHaveText('核验通过，操作已记录。');
    expect(await panel.innerText()).not.toContain(fixture.internalMarker);
    await page.screenshot({path:`test-results/request-delivery-completed-${viewport.name}.png`,fullPage:true});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await panel.getByRole('button',{name:'返回交付与回收',exact:true}).click();
    const workbench=page.getByRole('region',{name:'交付与回收工作台',exact:true});
    await workbench.getByRole('combobox',{name:'责任组'}).selectOption(fixture.groupId);
    await expect(workbench.getByRole('button').filter({hasText:fixture.subject})).toBeVisible();
  });
}
