import {test,expect} from './fixtures';

for(const viewport of [{width:1440,height:900},{width:390,height:844}]){
  test(`sidebar groups follow employee, engineer and administrator access at ${viewport.width}px`,async({page})=>{
    await page.setViewportSize(viewport);
    await page.goto('/');
    const nav=page.getByRole('navigation',{name:'主要导航'});
    const employee=nav.getByRole('region',{name:'员工服务'});
    const work=nav.getByRole('region',{name:'工单处理'});
    const admin=nav.getByRole('region',{name:'系统管理'});
    await expect(employee.getByRole('button',{name:'我的工单'})).toBeVisible();
    await expect(work).toHaveCount(0);
    await expect(admin).toHaveCount(0);

    await page.getByRole('combobox',{name:'开发身份'}).selectOption('agent-1');
    await expect(work.getByRole('button',{name:'IT 工作台'})).toBeVisible();
    await expect(work.getByRole('button',{name:'交付与回收'})).toBeVisible();
    await expect(admin).toHaveCount(0);
    await work.getByRole('button',{name:'IT 工作台'}).click();
    await expect(page.getByRole('heading',{name:'IT 工作台'})).toBeVisible();

    await page.getByRole('combobox',{name:'开发身份'}).selectOption('agent-2');
    await expect(work.getByRole('button',{name:'IT 工作台'})).toBeVisible();
    await expect(work.getByRole('button',{name:'路由告警'})).toHaveCount(0);
    await expect(admin).toHaveCount(0);

    await page.getByRole('combobox',{name:'开发身份'}).selectOption('demo-admin-1');
    await expect(employee).toBeVisible();
    await expect(work.getByRole('button',{name:'IT 工作台'})).toBeVisible();
    await expect(work.getByRole('button',{name:'服务报表'})).toBeVisible();
    await expect(work.getByRole('button',{name:'消息通知'})).toBeVisible();
    await expect(work.getByRole('button',{name:'交付与回收'})).toBeVisible();
    await expect(work.getByRole('button',{name:'路由告警'})).toBeVisible();
    await expect(admin.getByRole('button',{name:'角色授权'})).toBeVisible();
    await expect(admin.getByRole('button',{name:'服务组织'})).toBeVisible();
    await admin.getByRole('button',{name:'服务组织'}).click();
    await expect(page.getByRole('heading',{name:'服务组织'})).toBeVisible();
    await work.getByRole('button',{name:'服务报表'}).click();
    await expect(page.getByRole('heading',{name:'服务报表'})).toBeVisible();
    await expect(page.getByRole('combobox',{name:'支持组'})).not.toHaveValue('');
    await work.getByRole('button',{name:'交付与回收'}).click();
    await expect(page.getByRole('heading',{name:'交付与回收'})).toBeVisible();
    await expect(page.getByRole('region',{name:'交付与回收工作台'})).toBeVisible();
    await work.getByRole('button',{name:'消息通知'}).click();
    await expect(page.getByRole('heading',{name:'消息通知'})).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  });
}
