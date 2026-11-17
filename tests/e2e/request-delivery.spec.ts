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
  test(`failed registration does not imply no actual grant on ${viewport.name}`,async({page})=>{
    test.skip(process.env.ITSM_DELIVERY_CI_ENABLED!=='true');
    test.setTimeout(60000);
    const fixture=await createFulfillmentFixture({state:'READY',appointed:true});
    await page.setViewportSize({width:viewport.width,height:viewport.height});
    await page.goto('/');
    await page.getByRole('combobox',{name:'开发身份'}).selectOption('agent-1');
    await page.getByRole('button',{name:'交付与回收',exact:true}).click();
    await page.getByRole('button',{name:'准备与首次交付',exact:true}).click();
    const panel=page.getByRole('region',{name:'准备与首次交付',exact:true});
    await panel.getByRole('combobox',{name:'责任组'}).selectOption(fixture.groupId);
    await panel.getByRole('button').filter({hasText:fixture.subject}).click();
    const operation=panel.getByRole('region',{name:'准备与交付操作',exact:true});
    await operation.getByRole('textbox',{name:'外部执行记录编号'}).fill(`CI-FAILED-${fixture.approvalId}`);
    await operation.getByRole('checkbox',{name:'本次内容不含密码、密钥及安全事件证据'}).check();
    await operation.getByRole('checkbox',{name:'已在目标系统实际完成交付，并核对上述记录'}).check();
    await operation.getByRole('button',{name:'提交实际交付记录',exact:true}).click();
    await expect(operation.getByRole('region',{name:'操作请求回执',exact:true})).toContainText('等待后台核验');
    await processDeliveryCommands('FAIL');
    await panel.getByRole('button',{name:'刷新准备与交付',exact:true}).click();
    const receipt=operation.getByRole('region',{name:'操作请求回执',exact:true});
    await expect(receipt).toContainText('登记未通过，需核查实际授权');
    await expect(receipt).not.toContainText('未执行');
    await expect(receipt).not.toContainText('provider-private-error-sentinel');
    await expect(panel.getByRole('row').filter({hasText:fixture.subject})).toContainText('登记未通过，需核查实际授权');
    await page.screenshot({path:`test-results/request-delivery-rejected-${viewport.name}.png`,fullPage:true});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  });
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
    await expect(operation.getByRole('button',{name:'提交实际交付记录',exact:true})).toBeDisabled();
    await page.screenshot({path:`test-results/request-delivery-ready-${viewport.name}.png`,fullPage:true});
    const reference=`CI-DELIVERY-${viewport.name}-${fixture.approvalId}`;
    await operation.getByRole('textbox',{name:'外部执行记录编号'}).fill(reference);
    await operation.getByRole('checkbox',{name:'本次内容不含密码、密钥及安全事件证据'}).check();
    await expect(operation.getByRole('button',{name:'提交实际交付记录',exact:true})).toBeDisabled();
    await operation.getByRole('checkbox',{name:'已在目标系统实际完成交付，并核对上述记录'}).check();
    await operation.getByRole('button',{name:'提交实际交付记录',exact:true}).click();
    await expect(operation.getByRole('region',{name:'操作请求回执',exact:true})).toContainText('等待后台核验');
    await processDeliveryCommands();
    await panel.getByRole('button',{name:'刷新准备与交付',exact:true}).click();
    await expect(operation).toContainText('当前无可执行操作');
    await expect(operation.getByRole('region',{name:'操作请求回执',exact:true})).toContainText('核验通过，操作已记录');
    expect(await panel.innerText()).not.toContain(fixture.internalMarker);
    await page.screenshot({path:`test-results/request-delivery-completed-${viewport.name}.png`,fullPage:true});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await panel.getByRole('button',{name:'返回交付与回收',exact:true}).click();
    const workbench=page.getByRole('region',{name:'交付与回收工作台',exact:true});
    await workbench.getByRole('combobox',{name:'责任组'}).selectOption(fixture.groupId);
    await expect(workbench.getByRole('button').filter({hasText:fixture.subject})).toBeVisible();
  });
}
