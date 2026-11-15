import { test,expect } from './fixtures';

test('administrators maintain group membership with independent review on desktop and mobile',async({page})=>{
  test.setTimeout(90000);
  const code=`e2e-group-${Date.now()}`;
  await page.setViewportSize({width:1440,height:1000});await page.goto('/');
  await expect(page.getByRole('button',{name:'支持组管理',exact:true})).toHaveCount(0);
  async function identity(user:string){
    await page.getByRole('combobox',{name:'开发身份'}).selectOption(user);
    await page.getByRole('button',{name:'支持组管理',exact:true}).click();
    await page.getByRole('combobox',{name:'支持组',exact:true}).selectOption(code);
    await expect(page.getByRole('heading',{name:'E2E 专业支持组',exact:true})).toBeVisible();
  }
  await page.getByRole('combobox',{name:'开发身份'}).selectOption('demo-admin-1');
  await page.getByRole('button',{name:'支持组管理',exact:true}).click();
  await page.getByRole('button',{name:'新建支持组',exact:true}).click();
  const dialog=page.getByRole('dialog');
  async function submit(reason:string,label='确认提交'){
    await dialog.getByRole('textbox',{name:'处理依据'}).fill(reason);
    await dialog.getByRole('checkbox',{name:'本次内容不含密码、密钥及安全事件证据'}).check();
    await dialog.getByRole('button',{name:label,exact:true}).click();
    await expect(dialog).toHaveCount(0);
  }
  await dialog.getByRole('textbox',{name:'组编码',exact:true}).fill(code);
  await dialog.getByRole('textbox',{name:'组名称',exact:true}).fill('E2E 专业支持组');
  await submit('试点专业支持组');
  async function proposeMember(user:string){
    await page.getByRole('button',{name:'添加成员',exact:true}).click();
    await dialog.getByRole('textbox',{name:'查找工程师'}).fill(user);
    await dialog.getByRole('button',{name:'搜索工程师'}).click();
    await dialog.getByRole('combobox',{name:'工程师',exact:true}).selectOption(user);
    await submit('试点成员提案','提交独立复核');
  }
  await proposeMember('employee-2');
  let row=page.getByRole('listitem',{name:'演示员工二 加入',exact:true});
  await expect(row).toContainText('待独立复核');
  await expect(row.getByRole('button',{name:'批准成员变更'})).toHaveCount(0);
  await page.screenshot({path:'test-results/groups-proposal-desktop.png',fullPage:true});
  await identity('demo-admin-2');
  await row.getByRole('button',{name:'批准成员变更'}).click();await submit('独立核对岗位安排');
  await expect(page.getByRole('listitem',{name:'成员 演示员工二',exact:true})).toBeVisible();
  await proposeMember('agent-3');await identity('demo-admin-1');
  row=page.getByRole('listitem',{name:'服务台协作工程师 加入',exact:true});
  await row.getByRole('button',{name:'批准成员变更'}).click();await submit('复核替补人员入组');
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:'test-results/groups-members-mobile.png',fullPage:true});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.getByRole('listitem',{name:'成员 演示员工二',exact:true}).getByRole('button',{name:'移除成员提案'}).click();
  await submit('试点结束，移除临时成员','提交独立复核');
  await identity('demo-admin-2');
  row=page.getByRole('listitem',{name:'演示员工二 移除',exact:true});
  await row.getByRole('button',{name:'批准成员变更'}).click();await submit('核对责任已收尾');
  await expect(page.getByRole('listitem',{name:'成员 演示员工二',exact:true})).toHaveCount(0);
  await expect(row).toContainText('已批准');
  await page.getByRole('button',{name:'支持组审计',exact:true}).click();
  await expect(dialog.getByText('创建支持组',{exact:true})).toBeVisible();
  await expect(dialog.getByText('批准成员变更',{exact:true})).toHaveCount(3);
  await page.screenshot({path:'test-results/groups-audit-mobile.png',fullPage:true});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
