import { test,expect } from './fixtures';

test('appointment search supports typing, Enter, retries and out-of-order responses without submitting',async({page})=>{
  const person={id:'fixture-person',name:'测试工程师',groups:[],dingLinked:true};
  const config={domains:[{id:'fixture-domain',name:'测试责任域',enabled:true}],systems:[],
    positions:[{id:'fixture-position',name:'Helpdesk',domainId:'fixture-domain',groupId:'service-desk',enabled:true}],appointments:[],mappings:[]};
  await page.route('**/api/v1/admin/service-structure',route=>route.fulfill({json:{version:1,config,
    options:{groups:[{id:'service-desk',name:'IT 服务台'}],services:[],people:[]},items:[]}}));
  await page.route('**/api/v1/admin/service-structure/catalog',route=>route.fulfill({json:{version:1,items:[],hasMore:false}}));
  let releaseOld!:()=>void;
  const oldResponse=new Promise<void>(resolve=>{releaseOld=resolve;});
  let oldStarted!:()=>void;
  const oldRequest=new Promise<void>(resolve=>{oldStarted=resolve;});
  await page.route('**/api/v1/admin/service-structure/people?*',async route=>{
    const q=new URL(route.request().url()).searchParams.get('q');
    if(q==='旧查询'){oldStarted();await oldResponse;return route.fulfill({json:{items:[{...person,id:'old',name:'过期结果'}],hasMore:false}});}
    if(q==='查询失败')return route.fulfill({status:503,json:{code:'TEST_UNAVAILABLE'}});
    return route.fulfill({json:{items:q==='测试工程师'?[person]:[],hasMore:false}});
  });
  await page.goto('/');
  await page.getByRole('combobox',{name:'开发身份'}).selectOption('demo-admin-1');
  await page.getByRole('button',{name:'服务组织',exact:true}).click();
  await page.getByRole('tab',{name:'任职人员',exact:true}).click();
  await page.getByRole('button',{name:'新增任职人员',exact:true}).click();
  const form=page.getByRole('region',{name:'编辑任职人员'});
  await form.getByRole('combobox',{name:'岗位',exact:true}).selectOption('fixture-position');
  const query=form.getByRole('textbox',{name:'查找任职人员'});
  const select=form.getByRole('combobox',{name:'任职人员',exact:true});
  await query.fill('测试工程师');
  await expect(select.getByRole('option',{name:/测试工程师/})).toHaveCount(1);
  await expect(form.getByRole('status')).toHaveText('找到 1 位人员');
  await select.selectOption(person.id);
  await query.press('Enter');
  await expect(form).toBeVisible();
  await expect(form.getByRole('status')).toHaveText('找到 1 位人员');
  await expect(page.getByRole('row').filter({hasText:person.name})).toHaveCount(0);
  await page.screenshot({path:'test-results/service-structure-people-desktop.png',fullPage:true});

  await query.fill('不存在');await query.press('Enter');
  await expect(form.getByRole('status')).toContainText('未找到匹配的在职人员');
  await expect(select).toHaveValue('');
  await expect(form.getByRole('button',{name:'确认修改',exact:true})).toBeDisabled();
  await query.fill('查询失败');await query.press('Enter');
  await expect(form.getByRole('alert')).toContainText('操作未完成');
  await query.fill('旧查询');await query.press('Enter');await oldRequest;
  await expect(form.getByRole('status')).toHaveText('正在查找人员…');
  await query.fill('测试工程师');await query.press('Enter');
  await expect(form.getByRole('status')).toHaveText('找到 1 位人员');
  const oldFinished=page.waitForResponse(response=>response.url().includes(encodeURIComponent('旧查询')));
  releaseOld();await oldFinished;
  await expect(select.getByRole('option',{name:/过期结果/})).toHaveCount(0);
  await expect(select.getByRole('option',{name:/测试工程师/})).toHaveCount(1);
  await select.selectOption(person.id);
  await page.setViewportSize({width:390,height:844});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:'test-results/service-structure-people-mobile.png',fullPage:true});
  await form.getByRole('button',{name:'确认修改',exact:true}).click();
  await expect(form).toHaveCount(0);
  await expect(page.getByRole('row').filter({hasText:person.name})).toContainText('Helpdesk');
});
