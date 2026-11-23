import { test,expect } from './fixtures';

test('initial company template is an optional administrator draft and preserves later changes',async({page})=>{
  test.setTimeout(120000);
  await page.setViewportSize({width:1440,height:1000});await page.goto('/');
  await page.getByRole('combobox',{name:'开发身份'}).selectOption('demo-admin-1');
  await page.getByRole('button',{name:'服务组织',exact:true}).click();
  await page.getByRole('button',{name:'初始组织模板',exact:true}).click();
  let template=page.getByRole('region',{name:'初始组织模板',exact:true});
  await expect(template.getByRole('button',{name:'加入配置草稿',exact:true})).toBeDisabled();
  await template.getByRole('combobox',{name:'支持组 · IT 基础设施运维',exact:true}).selectOption('service-desk');
  await template.getByRole('combobox',{name:'支持组 · 信息系统运维',exact:true}).selectOption('service-desk');
  await expect(template).toContainText('待新增 28 项');
  await page.screenshot({path:'test-results/service-structure-template-desktop.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:'test-results/service-structure-template-mobile.png',fullPage:true});
  await template.getByRole('button',{name:'取消',exact:true}).click();
  await expect(page.getByRole('button',{name:'编辑IT 基础设施运维',exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:'初始组织模板',exact:true}).click();
  template=page.getByRole('region',{name:'初始组织模板',exact:true});
  await template.getByRole('combobox',{name:'支持组 · IT 基础设施运维',exact:true}).selectOption('service-desk');
  await template.getByRole('combobox',{name:'支持组 · 信息系统运维',exact:true}).selectOption('service-desk');
  await template.getByRole('button',{name:'加入配置草稿',exact:true}).click();
  await expect(page.getByRole('row').filter({hasText:'tpl-it-infrastructure'})).toContainText('停用');

  const suffix=String(Date.now());
  async function publish(reason:string){
    const publishing=page.getByRole('region',{name:'配置发布'});
    await publishing.getByRole('textbox',{name:'变更依据'}).fill(reason);
    await publishing.getByRole('checkbox',{name:'本次内容不含密码、密钥及安全事件证据'}).check();
    await publishing.getByRole('button',{name:'预览分派',exact:true}).click();
    await publishing.getByRole('button',{name:'保存并生效',exact:true}).click();
    await expect(page.getByRole('status')).toContainText('配置已保存并生效');
  }
  await publish(`正式初始组织模板 ${suffix}`);
  await page.getByRole('combobox',{name:'开发身份'}).selectOption('demo-admin-1');
  await page.getByRole('button',{name:'服务组织',exact:true}).click();
  await page.getByRole('button',{name:'编辑IT 基础设施运维',exact:true}).click();
  const editing=page.getByRole('region',{name:'编辑责任域'});
  await editing.getByRole('textbox',{name:'名称',exact:true}).fill(`基础平台服务 ${suffix}`);
  await editing.getByRole('button',{name:'确认修改',exact:true}).click();
  await publish(`自定义模板责任域名称 ${suffix}`);
  await page.getByRole('combobox',{name:'开发身份'}).selectOption('demo-admin-1');
  await page.getByRole('button',{name:'服务组织',exact:true}).click();
  await page.getByRole('button',{name:'初始组织模板',exact:true}).click();
  template=page.getByRole('region',{name:'初始组织模板',exact:true});
  await template.getByRole('combobox',{name:'支持组 · IT 基础设施运维',exact:true}).selectOption('service-desk');
  await template.getByRole('combobox',{name:'支持组 · 信息系统运维',exact:true}).selectOption('service-desk');
  await expect(template).toContainText('待新增 0 项 · 保留已有 28 项');
  await expect(template.getByRole('button',{name:'加入配置草稿',exact:true})).toBeDisabled();
  await template.getByRole('button',{name:'取消',exact:true}).click();
  await expect(page.getByRole('button',{name:`编辑基础平台服务 ${suffix}`,exact:true})).toBeVisible();
});
