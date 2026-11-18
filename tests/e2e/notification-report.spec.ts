import { test, expect } from './fixtures';
import { createNotificationReportFixture } from '../support/notification-report.mjs';

for (const viewport of [{ name:'desktop', width:1440, height:900 }, { name:'mobile', width:390, height:844 }]) {
  test(`notification report scopes real records and recovers from errors on ${viewport.name}`, async ({ page }) => {
    const fixture = await createNotificationReportFixture();
    await page.setViewportSize({ width:viewport.width, height:viewport.height });
    await page.goto('/');
    await page.getByRole('combobox', { name:'开发身份' }).selectOption('agent-1');
    await page.getByRole('button', { name:'服务报表', exact:true }).click();
    const currentTab = page.getByRole('tab', { name:'当前责任', exact:true });
    const notificationTab = page.getByRole('tab', { name:'通知健康', exact:true });
    await currentTab.focus();
    await currentTab.press('End');
    await expect(notificationTab).toBeFocused();
    await expect(notificationTab).toHaveAttribute('aria-selected', 'true');
    const panel = page.getByRole('tabpanel', { name:'通知健康', exact:true });
    const group = panel.getByRole('combobox', { name:'支持组' });
    await expect(group).toBeEnabled();
    await expect(group.locator(`option[value="${fixture.groupId}"]`)).toHaveCount(1);
    await group.selectOption(fixture.groupId);
    await panel.getByLabel('事件开始日期').fill(fixture.day);
    await panel.getByLabel('事件结束日期').fill(fixture.day);
    const type = panel.getByRole('combobox', { name:'工单类型' });
    const state = panel.getByRole('combobox', { name:'投递状态' });
    const query = panel.getByRole('button', { name:'查询', exact:true });
    await type.selectOption('REQ');
    await query.click();
    const detail = panel.getByRole('table', { name:'通知投递统计明细' });
    const overview = panel.getByRole('region', { name:'全部投递概况' });
    await expect(detail.getByRole('row')).toHaveCount(12);
    for (const [label, count] of [['投递记录','11'], ['平台确认发送成功','1'], ['需要关注','5'],
      ['失败待处理','1'], ['发送结果待核查','1'], ['开发模拟','1']]) {
      await expect(overview.locator('div').filter({ has:page.getByText(label, { exact:true }) }).locator('strong')).toHaveText(count);
    }
    await expect(panel.getByText(/通知事件 2 条 · 尚未展开 0 条 · 已展开但无投递记录 1 条/)).toBeVisible();
    await expect(detail.getByRole('cell', { name:'平台受理，待确认', exact:true })).toHaveCount(2);
    await expect(detail.getByRole('cell', { name:'已跳过', exact:true })).toHaveCount(1);
    await expect(detail.getByRole('cell', { name:'未知状态', exact:true })).toHaveCount(1);
    await expect(detail.getByRole('cell', { name:'其他原因，需受控核查', exact:true })).toHaveCount(1);
    await expect(panel.getByText(fixture.marker, { exact:false })).toHaveCount(0);
    await expect(panel.getByRole('button', { name:'重试发送', exact:true })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path:`test-results/reports-notifications-${viewport.name}.png`, fullPage:true });

    await state.selectOption('ATTENTION');
    await expect(detail).toHaveCount(0);
    await expect(overview).toHaveCount(0);
    await query.click();
    await expect(detail.getByRole('row')).toHaveCount(6);
    await expect(panel.getByText('当前筛选：5 条投递，涉及 1 张工单。', { exact:false })).toBeVisible();
    await expect(overview.locator('div').filter({ has:page.getByText('投递记录', { exact:true }) }).locator('strong')).toHaveText('11');
    await state.selectOption('DEAD');
    await expect(detail).toHaveCount(0);
    await query.click();
    await expect(detail.getByRole('row')).toHaveCount(2);
    await expect(detail.getByRole('cell', { name:'应用令牌获取失败', exact:true })).toBeVisible();

    await type.selectOption('INC');
    await expect(detail).toHaveCount(0);
    await query.click();
    await expect(panel.getByText('当前筛选条件下暂无投递记录', { exact:true })).toBeVisible();
    await expect(detail.getByRole('button')).toHaveCount(0);
    await page.route('**/reports/notifications?**', route => route.fulfill({ status:503,
      contentType:'application/json', body:JSON.stringify({ code:'REPORT_NOTIFICATION_WINDOW_TOO_LARGE' }) }));
    await query.click();
    await expect(panel.getByRole('alert')).toHaveText('通知投递记录超过 5000 条，请缩小日期范围后重试。');
    await expect(detail).toHaveCount(0);
    await expect(overview).toHaveCount(0);
    await page.unroute('**/reports/notifications?**');
    await type.selectOption('REQ');
    await query.click();
    await expect(panel.getByRole('alert')).toHaveCount(0);
    await expect(detail.getByRole('row')).toHaveCount(2);
    await notificationTab.press('Home');
    await expect(currentTab).toBeFocused();
    await expect(currentTab).toHaveAttribute('aria-selected', 'true');
    await currentTab.press('ArrowLeft');
    await expect(notificationTab).toBeFocused();
    await expect(notificationTab).toHaveAttribute('aria-selected', 'true');
  });
}
