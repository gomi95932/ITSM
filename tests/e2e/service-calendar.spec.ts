import {test,expect} from './fixtures';
test('service calendar is available to administrators and fits desktop and mobile',async({page})=>{
  await page.goto('/');await page.getByRole('combobox',{name:'开发身份'}).selectOption('demo-admin-1');
  await page.getByRole('button',{name:'分级与时限',exact:true}).click();
  const calendar=page.getByRole('region',{name:'服务日历配置',exact:true});
  await expect(calendar).toBeVisible();
  for(const viewport of [{width:1440,height:1000},{width:390,height:844}]){
    await page.setViewportSize(viewport);
    await calendar.getByRole('textbox',{name:'日历变更原因'}).fill('公司节假日安排核对');
    await calendar.getByLabel('节假日日期',{exact:true}).fill('2026-12-25');
    await calendar.getByRole('button',{name:'添加节假日',exact:true}).click();
    await expect(calendar.getByRole('button',{name:'移除节假日 2026-12-25',exact:true})).toBeVisible();
    await page.screenshot({path:`test-results/calendar-${viewport.width}.png`,fullPage:true});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    const bounds=await calendar.getByLabel('开始时间',{exact:true}).boundingBox();expect(bounds?.width).toBeGreaterThan(80);
    await calendar.getByRole('button',{name:'移除节假日 2026-12-25',exact:true}).click();
  }
  await page.getByRole('combobox',{name:'开发身份'}).selectOption('employee-1');
  await expect(page.getByRole('button',{name:'分级与时限',exact:true})).toBeHidden();
});
