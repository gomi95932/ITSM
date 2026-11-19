import { test,expect } from './fixtures';

test('custom domains can be added, reviewed, renamed and disabled without a release',async({page})=>{
  test.setTimeout(60000);
  const name=`研发实验责任域 ${Date.now()}`;
  const renamed=`${name} 已调整`;
  await page.setViewportSize({width:1440,height:1000});
  await page.goto('/');
  await expect(page.getByRole('button',{name:'服务组织',exact:true})).toHaveCount(0);
  await page.getByRole('combobox',{name:'开发身份'}).selectOption('demo-admin-1');
  await page.getByRole('button',{name:'服务组织',exact:true}).click();
  await page.getByRole('button',{name:'新增责任域',exact:true}).click();
  const form=page.getByRole('region',{name:'编辑责任域'});
  await form.getByRole('textbox',{name:'名称',exact:true}).fill(name);
  await form.getByRole('button',{name:'确认修改',exact:true}).click();
  await expect(page.getByRole('row').filter({hasText:name})).toContainText('启用');

  async function propose(reason:string){
    const publish=page.getByRole('region',{name:'配置发布'});
    await publish.getByRole('textbox',{name:'变更依据'}).fill(reason);
    await publish.getByRole('checkbox',{name:'本次内容不含密码、密钥及安全事件证据'}).check();
    await publish.getByRole('button',{name:'预览分派',exact:true}).click();
    await expect(publish.getByRole('button',{name:'提交复核',exact:true})).toBeEnabled();
    await publish.getByRole('button',{name:'提交复核',exact:true}).click();
    await expect(page.getByRole('status')).toContainText('尚未生效');
    const row=page.getByRole('row').filter({hasText:reason});
    await row.getByRole('button',{name:'查看完整配置',exact:true}).click();
    await expect(page.getByRole('button',{name:'批准发布',exact:true})).toHaveCount(0);
    await page.getByRole('button',{name:'返回编辑配置',exact:true}).click();
    await page.getByRole('combobox',{name:'开发身份'}).selectOption('demo-admin-2');
    await page.getByRole('button',{name:'服务组织',exact:true}).click();
    await page.getByRole('tab',{name:'变更复核',exact:true}).click();
    await page.getByRole('row').filter({hasText:reason}).getByRole('button',{name:'查看完整配置',exact:true}).click();
    const review=page.getByRole('region',{name:'配置复核'});
    await review.getByRole('textbox',{name:'复核依据'}).fill('独立核对本次配置变更及责任记录');
    await review.getByRole('checkbox',{name:'本次内容不含密码、密钥及安全事件证据'}).check();
    await review.getByRole('button',{name:'批准发布',exact:true}).click();
    await expect(page.getByRole('status')).toContainText('配置已发布');
    await page.getByRole('tab',{name:'责任域',exact:true}).click();
  }
  await propose(`新增 ${name}`);
  await expect(page.getByRole('row').filter({hasText:name})).toContainText('启用');
  await page.screenshot({path:'test-results/service-structure-desktop.png',fullPage:true});

  await page.getByRole('combobox',{name:'开发身份'}).selectOption('demo-admin-1');
  await page.getByRole('button',{name:'服务组织',exact:true}).click();
  await page.getByRole('button',{name:`编辑${name}`,exact:true}).click();
  await form.getByRole('textbox',{name:'名称',exact:true}).fill(renamed);
  await form.getByRole('checkbox',{name:'启用',exact:true}).uncheck();
  await form.getByRole('button',{name:'确认修改',exact:true}).click();
  await propose(`停用 ${name}`);
  await expect(page.getByRole('row').filter({hasText:renamed})).toContainText('停用');
  await page.getByRole('combobox',{name:'开发身份'}).selectOption('demo-admin-1');
  await page.getByRole('button',{name:'服务组织',exact:true}).click();
  await page.getByRole('button',{name:`编辑${renamed}`,exact:true}).click();
  await form.getByRole('checkbox',{name:'启用',exact:true}).check();
  await form.getByRole('button',{name:'确认修改',exact:true}).click();
  await propose(`重新启用 ${name}`);
  await expect(page.getByRole('row').filter({hasText:renamed})).toContainText('启用');
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:'test-results/service-structure-mobile.png',fullPage:true});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
