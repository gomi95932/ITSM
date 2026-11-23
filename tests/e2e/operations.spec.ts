import {test,expect} from './fixtures';
import {randomUUID} from 'node:crypto';

for(const [viewport,width,height] of [['desktop',1440,1000],['mobile',390,844]] as const){
  test(`operations and appointment management fit ${viewport}`,async({page,request})=>{
    const headers={'x-dev-user':'demo-admin-1'};
    const current=await request.get('/api/v1/admin/service-structure',{headers});
    expect(current.ok()).toBe(true);
    const {version,config}=await current.json(),suffix=randomUUID();
    config.domains.push({id:`domain-${suffix}`,name:`Operations ${viewport}`,enabled:true});
    config.positions.push({id:`position-${suffix}`,name:`Engineer ${viewport}`,domainId:`domain-${suffix}`,groupId:'service-desk',enabled:true});
    config.appointments.push({id:randomUUID(),positionId:`position-${suffix}`,employeeId:'agent-1',duty:'PRIMARY',
      validFrom:new Date(Date.now()-60000).toISOString(),validTo:new Date(Date.now()+86400000).toISOString(),enabled:true});
    const saved=await request.post('/api/v1/admin/service-structure/apply',{headers,data:{id:randomUUID(),expectedVersion:version,config,
      reason:`Isolated operations fixture ${viewport}`,contentClass:'GENERAL'}});
    expect(saved.ok()).toBe(true);
    await page.setViewportSize({width,height});await page.goto('/');
    await page.getByRole('combobox',{name:'开发身份'}).selectOption('demo-admin-1');
    await page.getByRole('button',{name:'厂区与服务时限',exact:true}).click();
    await expect(page.getByRole('heading',{name:'厂区与服务时限',exact:true})).toBeVisible();
    await page.getByRole('button',{name:'SLA 模板',exact:true}).click();
    await page.getByRole('button',{name:'新增',exact:true}).click();
    await expect(page.getByRole('spinbutton',{name:'响应分钟'})).toHaveCount(4);
    await page.getByRole('textbox',{name:'名称',exact:true}).fill('Standard service SLA');
    await page.getByRole('spinbutton',{name:'响应分钟'}).nth(2).fill('90');
    await page.screenshot({path:`test-results/operations-${viewport}.png`,fullPage:true});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.getByRole('button',{name:'岗位任职',exact:true}).click();
    await expect(page.getByRole('heading',{name:'岗位任职',exact:true})).toBeVisible();
    await page.getByRole('button',{name:'新增任职',exact:true}).click();
    await expect(page.getByRole('combobox',{name:'岗位',exact:true})).toBeVisible();
    await expect(page.getByRole('combobox',{name:'人员',exact:true})).toBeVisible();
    await expect(page.getByRole('combobox',{name:'任职期限',exact:true})).toHaveValue('true');
    await expect(page.getByLabel('结束时间',{exact:true})).toHaveCount(0);
    await expect(page.getByRole('button',{name:'保存并生效',exact:true})).toBeDisabled();
    await page.getByRole('combobox',{name:'岗位',exact:true}).selectOption(`position-${suffix}`);
    await page.getByRole('combobox',{name:'人员',exact:true}).selectOption('demo-admin-1');
    await page.getByRole('textbox',{name:'变更或撤销原因'}).fill(`Admin self appointment ${viewport}`);
    await page.getByRole('checkbox',{name:'本次内容不含密码、密钥及安全事件证据'}).check();
    await page.screenshot({path:`test-results/appointments-${viewport}.png`,fullPage:true});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.getByRole('button',{name:'保存并生效',exact:true}).click();
    await expect(page.getByRole('textbox',{name:'变更或撤销原因'})).toHaveCount(0);
    await expect(page.getByRole('row').filter({hasText:`Engineer ${viewport}`}).filter({hasText:'演示配置管理员一'})).toHaveCount(1);
    await expect(page.getByRole('row').filter({hasText:`Engineer ${viewport}`}).filter({hasText:'演示配置管理员一'})).toContainText('长期有效');
    await page.getByRole('button',{name:'维护',exact:true}).first().click();
    await expect(page.getByLabel('开始时间',{exact:true})).not.toHaveValue('');
    await expect(page.getByRole('button',{name:'保存并生效',exact:true})).toBeDisabled();
  });
}
