import { test,expect } from './fixtures';

test('directory status is restricted to platform administrators and fits desktop and mobile',async({page})=>{
  await page.goto('/');
  await expect(page.getByRole('button',{name:'人员同步',exact:true})).toHaveCount(0);
  await page.getByRole('combobox',{name:'开发身份'}).selectOption('demo-admin-1');
  await page.getByRole('button',{name:'人员同步',exact:true}).click();
  await expect(page.getByRole('heading',{name:'人员同步',exact:true})).toBeVisible();
  await expect(page.getByRole('region',{name:'钉钉人员同步'})).toContainText('同步未启用');
  await expect(page.getByRole('region',{name:'钉钉人员同步'})).toContainText('暂无同步记录');
  await page.getByRole('button',{name:'刷新同步状态',exact:true}).click();
  await expect(page.getByRole('button',{name:'刷新同步状态',exact:true})).toBeEnabled();
  for(const [name,width,height] of [['desktop',1440,1000],['mobile',390,844]] as const){
    await page.setViewportSize({width,height});
    await expect(page.getByRole('region',{name:'人员同步概况'})).toBeVisible();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.screenshot({path:`test-results/directory-${name}.png`,fullPage:true});
  }
  await page.getByRole('combobox',{name:'开发身份'}).selectOption('agent-1');
  await expect(page.getByRole('button',{name:'人员同步',exact:true})).toHaveCount(0);
});
