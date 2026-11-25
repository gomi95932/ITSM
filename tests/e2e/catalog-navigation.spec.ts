import {test,expect} from './fixtures';

test('catalog grouping preserves service selection and the existing incident submission flow',async({page})=>{
  const suffix=String(Date.now()),category=`网络服务 ${suffix}`,subcategory='办公网络支持';
  await page.setViewportSize({width:1440,height:1000});await page.goto('/');
  await page.getByRole('combobox',{name:'开发身份'}).selectOption('demo-admin-1');
  await page.getByRole('button',{name:'服务组织',exact:true}).click();
  await page.getByRole('tab',{name:'目录展示',exact:true}).click();
  const panel=page.getByRole('region',{name:'目录展示配置'});
  const tree=panel.getByRole('navigation',{name:'服务目录树'});
  await expect(panel.getByRole('alert')).toHaveCount(0);
  await tree.getByRole('button',{name:'网络与远程访问',exact:true}).click();
  await panel.getByRole('textbox',{name:'目录名称'}).fill(category);
  await expect(tree.getByRole('button',{name:category,exact:true})).toBeVisible();
  await panel.getByRole('button',{name:'新增二级分类'}).click();
  await panel.getByRole('textbox',{name:'目录名称'}).fill(subcategory);
  await expect(tree.getByRole('button',{name:new RegExp(`^${subcategory}`)})).toBeVisible();
  await panel.getByRole('checkbox',{name:'启用此目录'}).check();
  await tree.getByRole('button',{name:/INC-NET/}).click();
  await panel.getByRole('combobox',{name:'上级目录'}).selectOption({label:subcategory});
  await panel.getByRole('spinbutton',{name:'目录排序'}).fill('0');
  await expect(page.getByRole('tab',{name:'岗位',exact:true})).toBeDisabled();
  await panel.getByRole('textbox',{name:'目录展示变更原因'}).fill('按既有网络服务整理展示分类');
  await panel.getByRole('checkbox',{name:'本次内容不含密码、密钥及安全事件证据'}).check();
  if(await panel.getByRole('button',{name:'检查目录与承接'}).isDisabled()){
    const state=await panel.evaluate(element=>({
      busy:element.getAttribute('aria-busy'),
      reason:(element.querySelector<HTMLTextAreaElement>('textarea[aria-label="目录展示变更原因"]')?.value.length??0),
      selected:(element.querySelector<HTMLInputElement>('input[aria-label="目录名称"]')?.value??''),
      pending:(element.querySelectorAll('button:disabled').length),
      validation:[...element.querySelectorAll('[role="alert"]')].map(item=>item.textContent?.trim()),
    }));
    throw new Error(`Catalog preview unexpectedly disabled: ${JSON.stringify(state)}`);
  }
  const previewResponse=page.waitForResponse(response=>response.url().endsWith('/admin/catalog-navigation/tree/preview')&&response.request().method()==='POST',{timeout:60_000});
  await panel.getByRole('button',{name:'检查目录与承接'}).click();
  const response=await previewResponse;
  expect(response.ok(),`Catalog preview failed: ${response.status()} ${await response.text()}`).toBe(true);
  await expect(panel.getByRole('table')).toContainText('INC-NET');
  await panel.getByRole('button',{name:'保存并生效',exact:true}).click();
  await expect(panel.getByRole('status')).toHaveText('服务目录已保存并生效');
  await expect(page.getByRole('tab',{name:'岗位',exact:true})).toBeEnabled();
  await page.screenshot({path:'test-results/catalog-navigation-admin-desktop.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:'test-results/catalog-navigation-admin-mobile.png',fullPage:true});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.setViewportSize({width:1440,height:1000});
  await tree.getByRole('button',{name:category,exact:true}).click();
  await panel.getByRole('textbox',{name:'目录名称'}).fill('未保存分类');
  await panel.getByRole('button',{name:'放弃目录展示修改',exact:true}).click();
  await expect(panel.getByRole('textbox',{name:'目录名称'})).toHaveValue(category);
  await page.getByRole('button',{name:'服务目录',exact:true}).click();
  await expect(page.getByRole('navigation',{name:'服务分类'}).getByRole('button',{name:new RegExp(category)})).toBeVisible();
  await page.getByRole('combobox',{name:'开发身份'}).selectOption('employee-1');
  await page.getByRole('button',{name:'服务目录',exact:true}).click();
  await page.getByRole('navigation',{name:'服务分类'}).getByRole('button',{name:new RegExp(category)}).click();
  await page.getByRole('combobox',{name:'业务系统或子分类'}).selectOption({label:subcategory});
  const network=page.getByRole('button',{name:/网络与 VPN/});
  await expect(network).toHaveCount(1);
  await page.getByRole('searchbox',{name:'搜索服务',exact:true}).fill('不存在的服务项');
  await expect(page.getByText('未找到匹配的服务', {exact:true})).toBeVisible();
  await page.getByRole('button',{name:'清除筛选',exact:true}).click();
  await expect(network).toBeVisible();
  const unopened=page.getByRole('region',{name:'暂未开放服务'});
  await expect(unopened).toBeVisible();await expect(unopened.getByRole('button')).toHaveCount(0);
  await page.screenshot({path:'test-results/catalog-navigation-desktop.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:'test-results/catalog-navigation-mobile.png',fullPage:true});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await network.click();
  await expect(page.getByRole('combobox',{name:'服务类型',exact:true})).toHaveValue('INC-NET');
  await page.getByRole('textbox',{name:'问题标题'}).fill(`目录分组回归 ${suffix}`);
  await page.getByRole('textbox',{name:'详细情况'}).fill('办公室网络连接不稳定，请检查网络。');
  await page.getByRole('combobox',{name:'影响范围'}).selectOption('INDIVIDUAL');
  await page.getByRole('combobox',{name:'紧急程度'}).selectOption('LOW');
  await page.getByRole('textbox',{name:'所在地点'}).fill('测试办公室');
  await page.getByRole('checkbox',{name:'本次内容不含密码、密钥及安全事件证据'}).check();
  await page.getByRole('button',{name:'核对信息',exact:true}).click();
  await page.getByRole('button',{name:'确认提交',exact:true}).click();
  await expect(page.getByRole('heading',{name:`目录分组回归 ${suffix}`,exact:true})).toBeVisible();
  await page.getByRole('button',{name:'我的工单',exact:true}).click();
  await page.getByRole('button',{name:'提交报障',exact:true}).first().click();
  await expect(page.getByRole('textbox',{name:'问题标题'})).toBeVisible();
});
