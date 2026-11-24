import { test,expect } from './fixtures';

for(const viewport of [{width:1440,height:900},{width:390,height:844}]){
  test(`member removal opens a visible focused editor at ${viewport.width}px`,async({page})=>{
    await page.setViewportSize(viewport);
    const group={id:'fixture-support',name:'测试支持组',description:'支持组交互测试',version:1,activeMembers:30,enabled:true};
    let members=Array.from({length:30},(_,index)=>({id:`fixture-${index}`,name:`测试工程师${index}`,active:true,roles:[],privileges:[]}));
    const target=members.at(-1)!;
    let submissions=0;
    const unexpected:string[]=[];
    await page.route('**/api/v1/**',async route=>{
      const path=new URL(route.request().url()).pathname.replace('/api/v1','');
      const fulfill=(body:unknown,status=200)=>route.fulfill({status,json:body});
      if(path==='/auth/config')return fulfill({mode:'enterprise',configured:true});
      if(path==='/auth/me')return fulfill({id:'fixture-admin',name:'测试管理员',groups:[],canManageRoles:true,canManageRouting:true});
      if(path==='/catalog')return fulfill({items:[]});
      if(path==='/tickets')return fulfill({items:[],total:0,counts:{}});
      if(path==='/intake-policy')return fulfill({securityContact:'测试安全联络'});
      if(path==='/admin/support-structure')return fulfill({groups:[group],items:[],groupsHasMore:false,proposalsHasMore:false,canManageGroups:true,canReview:true});
      if(path===`/admin/support-structure/groups/${group.id}/members`)return fulfill({group,items:members,total:members.length,page:1,size:50});
      if(path==='/admin/support-structure/apply'){
        ++submissions;
        expect(route.request().postDataJSON()).toMatchObject({kind:'MEMBER_REMOVE',groupId:group.id,employeeId:target.id});
        if(submissions===1)return fulfill({code:'SUPPORT_REVIEW_CONTINUITY_REQUIRED'},409);
        members=members.filter(member=>member.id!==target.id);group.activeMembers=members.length;++group.version;
        return fulfill({});
      }
      unexpected.push(path);return fulfill({code:'UNEXPECTED_TEST_REQUEST'},500);
    });
    await page.goto('/');
    await page.getByRole('button',{name:'支持组',exact:true}).click();
    const remove=page.getByRole('button',{name:`移除${target.name}`,exact:true});
    await remove.scrollIntoViewIfNeeded();
    expect(await page.evaluate(()=>window.scrollY)).toBeGreaterThan(300);
    await remove.click();
    const editor=page.getByRole('region',{name:'移除成员',exact:true});
    const reason=editor.getByRole('textbox',{name:'变更依据'});
    await expect(editor.getByRole('heading',{name:'移除成员',exact:true})).toBeInViewport();
    await expect(reason).toBeFocused();await expect(reason).toBeInViewport();
    expect(submissions).toBe(0);
    await editor.getByRole('button',{name:'取消编辑',exact:true}).click();
    await expect(editor).toHaveCount(0);await expect(remove).toBeEnabled();
    await remove.click();await expect(reason).toBeFocused();
    await reason.fill('移除测试成员，验证责任交接提示');
    await editor.getByRole('checkbox',{name:'本次内容不含密码、密钥及安全事件证据'}).check();
    await editor.getByRole('button',{name:'保存并生效',exact:true}).click();
    const warning=editor.getByRole('alert');
    await expect(warning).toContainText('请先安排接替的 P1 复核人');
    await expect(warning).toBeInViewport();await expect(remove).toHaveCount(1);
    expect(submissions).toBe(1);
    await page.screenshot({path:`test-results/support-remove-${viewport.width}.png`,fullPage:false});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await editor.getByRole('button',{name:'保存并生效',exact:true}).click();
    await expect(editor).toHaveCount(0);await expect(remove).toHaveCount(0);
    await expect(page.getByRole('status')).toContainText('已保存并生效');
    expect(submissions).toBe(2);expect(unexpected).toEqual([]);
  });
}
