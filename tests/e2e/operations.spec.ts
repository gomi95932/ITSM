import {test,expect} from './fixtures';

for(const [viewport,width,height] of [['desktop',1440,1000],['mobile',390,844]] as const){
  test(`operations and appointment management fit ${viewport}`,async({page})=>{
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
    await expect(page.getByRole('button',{name:'提交独立复核',exact:true})).toBeDisabled();
    await page.screenshot({path:`test-results/appointments-${viewport}.png`,fullPage:true});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.getByRole('button',{name:'取消',exact:true}).click();
    await page.getByRole('button',{name:'维护',exact:true}).first().click();
    await expect(page.getByLabel('开始时间',{exact:true})).not.toHaveValue('');
    await expect(page.getByRole('button',{name:'提交独立复核',exact:true})).toBeDisabled();
  });
}
