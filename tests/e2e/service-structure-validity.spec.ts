import {test,expect} from './fixtures';

for(const [viewport,width,height] of [['desktop',1440,1000],['mobile',390,844]] as const){
  test(`appointment validity supports permanent and multi-year terms on ${viewport}`,async({page})=>{
    const person={id:'fixture-person',name:'测试工程师',groups:['service-desk'],dingLinked:true};
    let config={domains:[{id:'fixture-domain',name:'测试责任域',enabled:true}],systems:[],
      positions:[{id:'fixture-position',name:'Helpdesk',domainId:'fixture-domain',groupId:'service-desk',enabled:true}],
      appointments:[{id:'fixture-appointment',positionId:'fixture-position',employeeId:person.id,duty:'PRIMARY',
        validFrom:'2026-11-21T00:00:00.000Z',validTo:null as string|null,enabled:true}],mappings:[]};
    let version=1,previewError=true,applied=false;
    await page.route('**/api/v1/admin/service-structure',route=>route.fulfill({json:{version,config,
      options:{groups:[{id:'service-desk',name:'IT 服务台'}],services:[],people:[person]},items:[]}}));
    await page.route('**/api/v1/admin/service-structure/catalog',route=>route.fulfill({json:{version,items:[],hasMore:false}}));
    await page.route('**/api/v1/admin/service-structure/preview',route=>{
      expect(route.request().postDataJSON().config.appointments[0].validTo).toContain('2029-11-21');
      if(previewError){previewError=false;return route.fulfill({status:400,json:{code:'SERVICE_STRUCTURE_APPOINTMENT_PERIOD_INVALID',appointmentId:'fixture-appointment'}});}
      return route.fulfill({json:{items:[]}});
    });
    await page.route('**/api/v1/admin/service-structure/apply',route=>{
      config=route.request().postDataJSON().config;version++;applied=true;
      return route.fulfill({json:{status:'APPROVED'}});
    });
    await page.setViewportSize({width,height});await page.goto('/');
    await page.getByRole('combobox',{name:'开发身份'}).selectOption('demo-admin-1');
    await page.getByRole('button',{name:'服务组织',exact:true}).click();
    await page.getByRole('tab',{name:'任职人员',exact:true}).click();
    const row=page.getByRole('row').filter({hasText:person.name});
    await expect(row).toContainText('长期有效');await expect(row).toContainText('2026');
    await page.getByRole('button',{name:'新增任职人员',exact:true}).click();
    const form=page.getByRole('region',{name:'编辑任职人员'});
    await expect(form.getByRole('combobox',{name:'任职期限',exact:true})).toHaveValue('true');
    await expect(form.getByLabel('截止时间',{exact:true})).toHaveCount(0);
    await form.getByRole('button',{name:'取消编辑',exact:true}).click();
    await page.getByRole('button',{name:`编辑${person.name}任职`,exact:true}).click();
    await form.getByRole('combobox',{name:'任职期限',exact:true}).selectOption('false');
    await form.getByLabel('截止时间',{exact:true}).fill('2025-11-21T08:00');
    await form.getByRole('button',{name:'确认修改',exact:true}).click();
    await expect(page.getByRole('alert')).toContainText(`${person.name}：任职截止时间须晚于生效时间`);
    await expect(form).toBeVisible();
    await form.getByLabel('截止时间',{exact:true}).fill('2029-11-21T08:00');
    await form.getByRole('button',{name:'确认修改',exact:true}).click();
    await expect(row).toContainText('2029');
    const publication=page.getByRole('region',{name:'配置发布',exact:true});
    await publication.getByRole('textbox',{name:'变更依据',exact:true}).fill('测试多年任职');
    await publication.getByRole('checkbox',{name:'本次内容不含密码、密钥及安全事件证据'}).check();
    await publication.getByRole('button',{name:'预览分派',exact:true}).click();
    await expect(page.getByRole('alert')).toContainText(`${person.name}（Helpdesk）：任职截止时间必须晚于生效时间`);
    await publication.getByRole('button',{name:'预览分派',exact:true}).click();
    await publication.getByRole('button',{name:'保存并生效',exact:true}).click();
    await expect(page.getByRole('status')).toContainText('配置已保存并生效');expect(applied).toBe(true);
    await page.getByRole('button',{name:`编辑${person.name}任职`,exact:true}).click();
    await expect(form.getByRole('combobox',{name:'任职期限',exact:true})).toHaveValue('false');
    await expect(form.getByLabel('截止时间',{exact:true})).toHaveValue('2029-11-21T08:00');
    await form.getByRole('combobox',{name:'任职期限',exact:true}).selectOption('true');
    await form.getByRole('button',{name:'确认修改',exact:true}).click();
    await expect(row).toContainText('长期有效');
    await publication.getByRole('textbox',{name:'变更依据',exact:true}).fill('测试恢复长期任职');
    await publication.getByRole('checkbox',{name:'本次内容不含密码、密钥及安全事件证据'}).check();
    await page.unroute('**/api/v1/admin/service-structure/preview');
    await page.route('**/api/v1/admin/service-structure/preview',route=>{
      expect(route.request().postDataJSON().config.appointments[0].validTo).toBeNull();return route.fulfill({json:{items:[]}});
    });
    await publication.getByRole('button',{name:'预览分派',exact:true}).click();
    await publication.getByRole('button',{name:'保存并生效',exact:true}).click();
    await expect(page.getByRole('status')).toContainText('配置已保存并生效');expect(config.appointments[0].validTo).toBeNull();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.screenshot({path:`test-results/appointment-validity-${viewport}.png`,fullPage:true});
  });
}
