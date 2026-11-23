import { test,expect } from './fixtures';

test('administrators directly maintain support groups and members with continuity checks and mobile audit',async({page})=>{
  test.setTimeout(180000);
  const id=`e2e-support-${Date.now()}`,name='研发现场支持组',renamed='研发现场支持组（调整）';
  await page.setViewportSize({width:1440,height:1000});await page.goto('/');
  await expect(page.getByRole('button',{name:'支持组',exact:true})).toHaveCount(0);

  async function as(user:string){
    await page.getByRole('combobox',{name:'开发身份'}).selectOption(user);
    await page.getByRole('button',{name:'支持组',exact:true}).click();
    await expect(page.getByRole('combobox',{name:'当前支持组'})).toBeVisible();
  }
  async function submit(reason:string,kind:string){
    const form=page.getByRole('region',{name:kind,exact:true});
    await form.getByRole('textbox',{name:'变更依据'}).fill(reason);
    await form.getByRole('checkbox',{name:'本次内容不含密码、密钥及安全事件证据'}).check();
    await form.getByRole('button',{name:'保存并生效'}).click();
    await expect(page.getByRole('status')).toContainText('已保存并生效');
    await page.getByRole('tab',{name:'成员及组变更',exact:true}).click();
    const row=page.getByRole('listitem',{name:`${kind} ${reason}`,exact:true});
    await expect(row).toContainText('已批准');
    await expect(row.getByRole('button',{name:'批准变更'})).toHaveCount(0);
  }
  async function recorded(kind:string,reason:string){
    await page.getByRole('tab',{name:'成员及组变更',exact:true}).click();
    const row=page.getByRole('listitem',{name:`${kind} ${reason}`,exact:true});
    await expect(row.getByRole('button',{name:'批准变更',exact:true})).toHaveCount(0);
    return row;
  }
  async function selectGroup(){
    await page.getByRole('tab',{name:'支持组与成员',exact:true}).click();
    await page.getByRole('combobox',{name:'当前支持组'}).selectOption(id);
    await expect(page.getByRole('region',{name:'组内成员'}).getByRole('heading',{level:2})).toContainText('研发现场支持组');
    await expect(page.getByRole('button',{name:'增加成员',exact:true})).toBeEnabled();
  }
  await as('demo-admin-1');
  await page.getByRole('button',{name:'新增支持组',exact:true}).click();
  const create=page.getByRole('region',{name:'新增支持组',exact:true});
  await create.getByRole('textbox',{name:'支持组编码'}).fill(id);
  await create.getByRole('textbox',{name:'支持组名称'}).fill(name);
  await create.getByRole('textbox',{name:'职责说明'}).fill('研发现场设备与应用协同处理');
  await submit(`创建 ${id}`,'新增支持组');
  await page.getByRole('tab',{name:'支持组与成员',exact:true}).click();
  await expect(page.getByRole('combobox',{name:'当前支持组'}).locator(`option[value="${id}"]`)).toHaveCount(1);
  await as('demo-admin-2');
  await expect(await recorded('新增支持组',`创建 ${id}`)).toContainText('已批准');
  await selectGroup();await expect(page.getByText('此组暂无成员',{exact:true})).toBeVisible();

  await as('demo-admin-1');await selectGroup();
  await page.getByRole('button',{name:'修改支持组',exact:true}).click();
  const edit=page.getByRole('region',{name:'修改支持组',exact:true});
  await expect(edit.getByRole('textbox',{name:'支持组编码'})).toHaveAttribute('readonly','');
  await edit.getByRole('textbox',{name:'支持组名称'}).fill(renamed);
  await submit(`调整 ${id}`,'修改支持组');
  await as('demo-admin-2');await expect(await recorded('修改支持组',`调整 ${id}`)).toContainText('已批准');

  for(const employee of ['agent-1','agent-2']){
    await as('demo-admin-1');await selectGroup();
    await page.getByRole('button',{name:'增加成员',exact:true}).click();
    const add=page.getByRole('region',{name:'增加成员',exact:true});
    await add.getByRole('textbox',{name:'员工搜索'}).fill(employee);
    await add.getByRole('button',{name:'搜索员工',exact:true}).click();
    await add.getByRole('combobox',{name:'任职员工'}).selectOption(employee);
    await submit(`加入 ${id} ${employee}`,'增加成员');
    await as('demo-admin-2');await expect(await recorded('增加成员',`加入 ${id} ${employee}`)).toContainText('已批准');
  }
  await selectGroup();
  const members=page.getByRole('region',{name:'组内成员'});
  await expect(members.getByRole('listitem')).toHaveCount(2);
  await members.getByRole('textbox',{name:'成员搜索'}).fill('agent-2');
  await members.getByRole('button',{name:'搜索成员'}).click();
  await expect(members.getByRole('listitem')).toHaveCount(1);
  await expect(members.getByRole('listitem')).toContainText('应用支持工程师');
  await members.getByRole('textbox',{name:'成员搜索'}).fill('');
  await members.getByRole('button',{name:'搜索成员'}).click();
  await expect(members.getByRole('listitem')).toHaveCount(2);
  await page.screenshot({path:'test-results/support-structure-desktop.png',fullPage:true});

  await as('demo-admin-1');await selectGroup();
  await members.getByRole('button',{name:'移除服务台工程师',exact:true}).click();
  await submit(`移出 ${id} agent-1`,'移除成员');
  await as('demo-admin-2');await expect(await recorded('移除成员',`移出 ${id} agent-1`)).toContainText('已批准');
  await selectGroup();await expect(members.getByRole('listitem')).toHaveCount(1);

  await as('demo-admin-1');await selectGroup();
  await members.getByRole('button',{name:'移除应用支持工程师',exact:true}).click();
  const blocked=`最后成员 ${id}`;
  const removing=page.getByRole('region',{name:'移除成员',exact:true});
  await removing.getByRole('textbox',{name:'变更依据'}).fill(blocked);
  await removing.getByRole('checkbox',{name:'本次内容不含密码、密钥及安全事件证据'}).check();
  await removing.getByRole('button',{name:'保存并生效'}).click();
  await expect(page.getByRole('alert')).toContainText('至少保留一名有效成员');
  await page.getByRole('button',{name:'取消编辑',exact:true}).click();
  const row=await recorded('移除成员',`移出 ${id} agent-1`);
  await expect(page.getByRole('listitem',{name:`移除成员 ${blocked}`,exact:true})).toHaveCount(0);
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:'test-results/support-structure-mobile.png',fullPage:true});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await row.getByRole('button',{name:'变更审计'}).click();
  const dialog=page.getByRole('dialog');
  await expect(dialog.getByText('提交提案',{exact:true})).toBeVisible();
  await expect(dialog.getByText('批准',{exact:true})).toBeVisible();
  await page.screenshot({path:'test-results/support-audit-mobile.png',fullPage:true});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await dialog.getByRole('button',{name:'关闭审计'}).click();
  await selectGroup();await expect(members.getByRole('listitem')).toHaveCount(1);

  await page.setViewportSize({width:1440,height:1000});
  await as('demo-admin-1');await selectGroup();
  await page.getByRole('button',{name:'停用支持组',exact:true}).click();
  const retiring=page.getByRole('region',{name:'停用支持组',exact:true});
  await expect(retiring.getByText('无阻塞依赖',{exact:true})).toBeVisible();
  await page.screenshot({path:'test-results/support-lifecycle-desktop.png',fullPage:true});
  await submit(`停用 ${id}`,'停用支持组');
  await as('demo-admin-2');await expect(await recorded('停用支持组',`停用 ${id}`)).toContainText('已批准');
  await page.getByRole('tab',{name:'支持组与成员',exact:true}).click();
  await page.getByRole('combobox',{name:'当前支持组'}).selectOption(id);
  await expect(page.getByRole('button',{name:'增加成员',exact:true})).toBeDisabled();
  await expect(members.getByText('此组暂无成员',{exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'恢复支持组',exact:true})).toBeEnabled();
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:'test-results/support-lifecycle-mobile.png',fullPage:true});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);

  await as('demo-admin-1');
  await page.getByRole('combobox',{name:'当前支持组'}).selectOption(id);
  await page.getByRole('button',{name:'恢复支持组',exact:true}).click();
  await submit(`恢复 ${id}`,'恢复支持组');
  await as('demo-admin-2');await expect(await recorded('恢复支持组',`恢复 ${id}`)).toContainText('已批准');
  await selectGroup();await expect(members.getByText('此组暂无成员',{exact:true})).toBeVisible();

  await as('demo-admin-1');
  await page.getByRole('combobox',{name:'当前支持组'}).selectOption('service-desk');
  await page.getByRole('button',{name:'停用支持组',exact:true}).click();
  await expect(retiring.getByText(/项阻塞依赖/)).toBeVisible();
  await retiring.getByRole('textbox',{name:'变更依据'}).fill('责任未完成时不得停用');
  await retiring.getByRole('checkbox',{name:'本次内容不含密码、密钥及安全事件证据'}).check();
  await expect(retiring.getByRole('button',{name:'保存并生效'})).toBeDisabled();
  await page.screenshot({path:'test-results/support-lifecycle-dependencies-mobile.png',fullPage:true});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.getByRole('button',{name:'取消编辑',exact:true}).click();
});
