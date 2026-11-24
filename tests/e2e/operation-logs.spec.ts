import {test,expect} from './fixtures';

for(const width of [1440,390]){
  test(`central log search, detail and configuration links at ${width}px`,async({page})=>{
    await page.setViewportSize({width,height:900});
    const queries:URLSearchParams[]=[];
    const group={id:'fixture-group',name:'测试支持组',description:'',version:1,activeMembers:0,enabled:true};
    const change={id:'pending-fixture',kind:'GROUP_UPDATE',groupId:group.id,config:{name:'待审批支持组'},status:'PENDING',
      proposedBy:'other',employeeId:null,version:1,reason:'待办依据',createdAt:'2026-11-24T00:00:00Z'};
    const entry={id:'support:fixture',module:'support',actorId:'fixture-admin',actorName:'测试管理员',objectId:group.id,
      objectName:'测试支持组',action:'GROUP_UPDATE_APPLIED',result:'APPLIED',reason:'修改名称',createdAt:'2026-11-24T00:00:00Z'};
    await page.route('**/api/v1/**',route=>{
      const url=new URL(route.request().url()),path=url.pathname.replace('/api/v1','');
      const ok=(body:unknown)=>route.fulfill({json:body});
      if(path==='/auth/config')return ok({mode:'enterprise',configured:true});
      if(path==='/auth/me')return ok({id:'fixture-admin',name:'测试管理员',groups:[],canManageRoles:true,canManageRouting:true});
      if(path==='/catalog')return ok({items:[]});
      if(path==='/tickets')return ok({items:[],total:0,counts:{}});
      if(path==='/intake-policy')return ok({securityContact:'测试联络人'});
      if(path==='/admin/support-structure')return ok({groups:[group],items:[change,{...change,id:'old',status:'APPROVED',config:{name:'已完成旧记录'}}],canManageGroups:true,canReview:true});
      if(path.endsWith('/members'))return ok({group,items:[],total:0,page:1,size:50});
      if(path==='/admin/operation-logs'){
        queries.push(new URLSearchParams(url.searchParams));
        return ok({items:[{...entry,id:`support:fixture-${url.searchParams.get('page')}`}],total:21,page:Number(url.searchParams.get('page')),size:20});
      }
      if(path.startsWith('/admin/operation-logs/'))return ok({...entry,sourceTable:'support_structure_audits',sourceId:'fixture',requestId:null,
        executionPrincipal:null,beforeValue:{name:'旧名称'},afterValue:{name:'新名称'},valueMeaning:'RECORDED',
        changes:[{field:'name',before:'旧名称',after:'新名称'}],changesTruncated:false});
      return route.fulfill({status:500,json:{code:'UNEXPECTED_REQUEST'}});
    });
    await page.goto('/');
    await page.getByRole('button',{name:'支持组',exact:true}).click();
    await page.getByRole('tab',{name:'待处理审批',exact:true}).click();
    await expect(page.getByText('待审批支持组',{exact:true})).toBeVisible();
    await expect(page.getByText('已完成旧记录',{exact:true})).toHaveCount(0);
    await page.getByRole('button',{name:'查看相关日志',exact:true}).click();
    await expect(page.getByRole('heading',{name:'操作日志',exact:true})).toBeVisible();
    await expect(page.getByRole('combobox',{name:'模块',exact:true})).toHaveValue('support');
    await expect(page.getByLabel('操作对象 ID')).toHaveValue(group.id);
    await expect(page.getByText('共 21 条',{exact:true})).toBeVisible();
    await page.getByLabel('关键词',{exact:true}).fill('测试');
    await page.getByLabel('操作人',{exact:true}).fill('测试管理员');
    await page.getByRole('button',{name:'查询',exact:true}).click();
    await expect.poll(()=>queries.at(-1)?.get('q')).toBe('测试');
    expect(queries.at(-1)?.get('actor')).toBe('测试管理员');
    await page.getByRole('button',{name:'日志下一页'}).click();
    await expect.poll(()=>queries.at(-1)?.get('page')).toBe('2');
    const detailButton=page.getByRole('button',{name:'查看日志 support:fixture-2',exact:true});
    await detailButton.click();
    const dialog=page.getByRole('dialog',{name:'操作日志详情'});
    await expect(dialog.getByText('旧名称',{exact:true})).toBeVisible();
    await expect(dialog.getByText('新名称',{exact:true})).toBeVisible();
    await expect(dialog.getByRole('button',{name:'关闭日志详情'})).toBeFocused();
    await page.screenshot({path:`test-results/operation-logs-${width}.png`});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.keyboard.press('Escape');await expect(dialog).toHaveCount(0);await expect(detailButton).toBeFocused();
    await page.getByRole('button',{name:'操作日志',exact:true}).click();
    await expect(page.getByRole('combobox',{name:'模块',exact:true})).toHaveValue('');
    await expect(page.getByLabel('操作对象 ID')).toHaveValue('');
  });
}
test('ordinary employee cannot see global operation logs',async({page})=>{
  await page.route('**/api/v1/**',route=>{
    const path=new URL(route.request().url()).pathname.replace('/api/v1','');
    const body=path==='/auth/config'?{mode:'enterprise',configured:true}:path==='/auth/me'?{id:'fixture-employee',name:'测试员工',groups:[],canManageRoles:false,canManageRouting:false}:path==='/tickets'?{items:[],total:0,counts:{}}:{items:[]};
    return route.fulfill({json:body});
  });
  await page.goto('/');await expect(page.getByRole('heading',{name:'我的工单',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'操作日志',exact:true})).toHaveCount(0);
});
