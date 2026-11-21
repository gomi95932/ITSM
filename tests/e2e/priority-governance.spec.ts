import {randomUUID} from 'node:crypto';
import {test,expect} from './fixtures';

test('dispatcher adjusts priority with evidence; administrator sees configuration on desktop and mobile',async({page,request})=>{
  const result=await request.post('/api/v1/tickets',{headers:{'X-Dev-User':'employee-1','Idempotency-Key':randomUUID()},data:{contentClass:'GENERAL',serviceCode:'INC-BIZ',formVersion:1,
    subject:`Priority UI ${randomUUID()}`,description:'One person needs assistance, work remains possible',impact:'INDIVIDUAL',urgency:'MEDIUM',fields:{}}});
  expect(result.status()).toBe(201);const ticket=await result.json();
  await page.setViewportSize({width:1440,height:1000});await page.goto('/');
  await page.getByRole('combobox',{name:'开发身份'}).selectOption('agent-1');
  await page.goto(`/#/tickets/${ticket.id}`);
  const panel=page.getByRole('region',{name:'工单分级',exact:true});
  await expect(panel).toContainText('初始 P3');
  await panel.getByRole('combobox',{name:'分级处理方式'}).selectOption('APPLY');
  await panel.getByRole('combobox',{name:'目标优先级'}).selectOption('P2');
  await panel.getByRole('textbox',{name:'分级依据'}).fill('已核实工作受阻，需要提高处理顺序');
  await panel.getByRole('checkbox',{name:'本次内容不含密码、密钥及安全事件证据'}).check();
  await panel.getByRole('button',{name:'确认调级'}).click();
  await expect(panel).toContainText('P2 · 高');await expect(panel).toContainText('初始 P3');
  await expect(page.getByText('优先级已调整',{exact:true})).toBeVisible();
  await expect(page.getByText('升级 P2 · 时限保留',{exact:true})).toBeVisible();
  await page.screenshot({path:'test-results/priority-ticket-desktop.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:'test-results/priority-ticket-mobile.png',fullPage:true});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.goto('/');await page.getByRole('combobox',{name:'开发身份'}).selectOption('demo-admin-1');
  await page.getByRole('button',{name:'分级与时限',exact:true}).click();
  await expect(page.getByRole('region',{name:'分级与时限配置'})).toBeVisible();
  await expect(page.getByRole('spinbutton',{name:'P1 响应分钟'})).toHaveValue('15');
  await page.screenshot({path:'test-results/priority-config-mobile.png',fullPage:true});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.setViewportSize({width:1440,height:1000});
  await page.screenshot({path:'test-results/priority-config-desktop.png',fullPage:true});
});
