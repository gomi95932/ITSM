import {test,expect} from './fixtures';
import {fixture,ok,request} from '../support/ticket-continuity.mjs';

test('withdrawn appointment requires independently reviewed continuity or supervisor-confirmed handover',async({page})=>{
  test.setTimeout(180000);
  const f=await fixture();let ticket=await f.create();await f.appoint(false);
  await page.setViewportSize({width:1440,height:1000});
  async function as(user:string){
    await page.goto('/');await page.evaluate(id=>sessionStorage.setItem('itsm-dev-user',id),user);
    await page.goto(`/#/tickets/${ticket.id}`);
    await page.reload();
    await expect(page.getByRole('region',{name:'责任连续性',exact:true})).toBeVisible();
  }
  async function submit(name:string){
    await page.getByRole('checkbox',{name:'本次内容不含密码、密钥及安全事件证据'}).check();
    await page.getByRole('button',{name,exact:true}).last().click();
    await expect(page.locator('.action-form:visible')).toHaveCount(0);
    await expect(page.getByRole('alert')).toHaveCount(0);
  }
  await as(f.owner);
  await expect(page.getByRole('status')).toContainText('当前负责人任职已失效');
  await expect(page.getByRole('button',{name:'提交解决方案',exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:'申请限期处理',exact:true}).click();
  await page.getByRole('textbox',{name:'原因',exact:true}).fill('原工程师在交接窗口内继续完成原单');
  const deadline=new Date(Date.now()+3600000);
  const local=new Date(deadline.getTime()-deadline.getTimezoneOffset()*60000).toISOString().slice(0,16);
  await page.getByLabel('处理授权截止时间').fill(local);
  await submit('申请限期处理');
  await expect(page.getByRole('region',{name:'责任连续性',exact:true})).toContainText('待独立复核');
  await expect(page.getByRole('button',{name:'批准限期处理',exact:true})).toHaveCount(0);
  await page.screenshot({path:'test-results/continuity-pending-desktop.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:'test-results/continuity-pending-mobile.png',fullPage:true});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);

  await as(f.lead);
  await page.getByRole('button',{name:'批准限期处理',exact:true}).click();
  await page.getByRole('textbox',{name:'原因',exact:true}).fill('独立核对人员、工单和截止时间');
  await expect(page.getByRole('combobox',{name:'授权记录',exact:true})).not.toHaveValue('');
  await submit('批准限期处理');
  await expect(page.getByRole('region',{name:'责任连续性',exact:true})).toContainText('已批准');
  await as(f.owner);await expect(page.getByRole('button',{name:'提交解决方案',exact:true})).toBeVisible();

  await as(f.lead);await page.getByRole('button',{name:'立即撤销授权',exact:true}).click();
  await page.getByRole('textbox',{name:'原因',exact:true}).fill('进入正式交接阶段');await submit('立即撤销授权');
  await expect(page.getByRole('region',{name:'责任连续性',exact:true})).toContainText('已撤销');
  await page.getByRole('button',{name:'主管发起交接',exact:true}).click();
  await page.getByRole('textbox',{name:'原因',exact:true}).fill('主管指定接替工程师并等待本人确认');
  await page.getByRole('combobox',{name:'目标支持组',exact:true}).selectOption(f.group);
  await page.getByRole('combobox',{name:'接收人',exact:true}).selectOption(f.peer);
  await submit('主管发起交接');
  await expect(page.locator('.ticket-meta')).toContainText('处理人：连续性工程师');
  await expect(page.locator('.ticket-meta')).toContainText('待交接：接替工程师');
  await page.screenshot({path:'test-results/continuity-handover-mobile.png',fullPage:true});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await as(f.peer);
  await page.getByRole('button',{name:'确认接收',exact:true}).click();
  await page.getByRole('textbox',{name:'回复内容',exact:true}).fill('接替工程师本人核对后确认接收');
  await submit('确认接收');
  await expect(page.locator('.ticket-meta')).toContainText('处理人：接替工程师');
  await expect(page.getByRole('region',{name:'责任连续性',exact:true})).toContainText('历史责任');
  await page.setViewportSize({width:1440,height:1000});
  await page.screenshot({path:'test-results/continuity-handover-desktop.png',fullPage:true});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  ticket=await ok(request(`/tickets/${ticket.id}`,f.peer));expect(ticket.canProcess).toBe(true);
});
