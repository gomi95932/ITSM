import { test,expect } from './fixtures';

for(const viewport of [{name:'desktop',width:1440,height:1000},{name:'mobile',width:390,height:844}]){
  test(`notification retry command follows live API capability on ${viewport.name}`,async({page})=>{
    await page.setViewportSize({width:viewport.width,height:viewport.height});
    let permitted=true;
    // Presentation fixture only; real scoped authorization is covered by the API integration suite.
    await page.route('**/api/v1/notifications',async route=>{
      const base={attempts:5,lastError:null,updatedAt:'2026-11-15T08:00:00.000Z'};
      await route.fulfill({json:{mode:'disabled',items:[
        {...base,id:'00000000-0000-4000-8000-000000000001',number:'NOTICE-DENIED',state:'DEAD',canRetry:false},
        {...base,id:'00000000-0000-4000-8000-000000000002',number:'NOTICE-PENDING',state:'PENDING',canRetry:true},
        {...base,id:'00000000-0000-4000-8000-000000000003',number:'NOTICE-ALLOWED',state:'DEAD',canRetry:permitted},
        {...base,id:'00000000-0000-4000-8000-000000000004',number:'NOTICE-LEGACY',state:'DEAD'},
        {...base,id:'00000000-0000-4000-8000-000000000005',number:'NOTICE-UNCERTAIN',state:'REVIEW_REQUIRED',canRetry:true},
      ]}});
    });
    await page.goto('/');
    await page.getByRole('combobox',{name:'开发身份'}).selectOption('agent-3');
    await page.getByRole('button',{name:'消息通知',exact:true}).click();
    const allowed=page.getByRole('row').filter({hasText:'NOTICE-ALLOWED'});
    await expect(allowed.getByRole('button',{name:'重试发送',exact:true})).toBeVisible();
    await expect(page.getByRole('button',{name:'重试发送',exact:true})).toHaveCount(1);
    await expect(page.getByText('发送结果待核查',{exact:true})).toBeVisible();
    for(const number of ['NOTICE-DENIED','NOTICE-PENDING','NOTICE-LEGACY','NOTICE-UNCERTAIN']){
      const row=page.getByRole('row').filter({hasText:number});
      await expect(row).toBeVisible();
      await expect(row.getByRole('button',{name:'重试发送',exact:true})).toHaveCount(0);
    }
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.screenshot({path:`test-results/notifications-permitted-${viewport.name}.png`,fullPage:true});

    permitted=false;
    await page.getByRole('button',{name:'消息通知',exact:true}).click();
    await expect(page.getByRole('button',{name:'重试发送',exact:true})).toHaveCount(0);
    await expect(allowed).toBeVisible();
    await page.screenshot({path:`test-results/notifications-revoked-${viewport.name}.png`,fullPage:true});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.getByRole('combobox',{name:'开发身份'}).selectOption('employee-1');
    await expect(page.getByRole('button',{name:'消息通知',exact:true})).toHaveCount(0);
    await expect(page.getByRole('heading',{name:'我提交的工单',exact:true})).toBeVisible();
  });
}
