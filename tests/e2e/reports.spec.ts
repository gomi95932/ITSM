import { test, expect } from './fixtures';
import { createFulfillmentFixture, fulfillmentSql, literal } from '../support/fulfillment.mjs';

for (const viewport of [{ name:'desktop', width:1440, height:900 }, { name:'mobile', width:390, height:844 }]) {
  test(`historical report retains accepted ownership and clears stale filters on ${viewport.name}`, async ({ page }) => {
    const owned = await createFulfillmentFixture({ state:null });
    const offered = await createFulfillmentFixture({ groupId:owned.groupId, state:null });
    const destination = await createFulfillmentFixture({ state:null });
    const engineer = `history-ui-${owned.ticketId}`;
    await fulfillmentSql(`INSERT INTO employees(id,display_name) VALUES(${literal(engineer)},'原岗位工程师');
      INSERT INTO group_memberships(employee_id,group_id) VALUES(${literal(engineer)},${literal(owned.groupId)});
      UPDATE tickets SET created_at='2025-05-21 10:00:00+08',assignee_id=${literal(engineer)}
        WHERE id=${literal(owned.ticketId)};
      UPDATE tickets SET created_at='2025-05-21 11:00:00+08',pending_group_id=owner_group_id,pending_assignee_id='agent-2',
        assignment_kind='OFFER',assignment_state='PENDING',assignment_offered_at=now()
        WHERE id=${literal(offered.ticketId)};
      UPDATE tickets SET status='WAITING_USER' WHERE id=${literal(owned.ticketId)};
      UPDATE employees SET display_name='更名后工程师' WHERE id=${literal(engineer)};
      UPDATE support_groups SET name='历史责任组' WHERE id=${literal(owned.groupId)};
      UPDATE tickets SET status='WAITING_VENDOR' WHERE id=${literal(owned.ticketId)};
      UPDATE tickets SET owner_group_id=${literal(destination.groupId)},assignee_id='agent-2',status='IN_PROGRESS'
        WHERE id=${literal(owned.ticketId)};
      UPDATE employees SET active=false WHERE id=${literal(engineer)}`);
    const range = JSON.parse(await fulfillmentSql(`SELECT json_build_object(
      'from',to_char(min(observed_at) AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD'),
      'to',to_char(clock_timestamp() AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD'))
      FROM ticket_responsibility_history WHERE owner_group_id=${literal(owned.groupId)}`));
    await page.setViewportSize({ width:viewport.width, height:viewport.height });
    await page.goto('/');
    await page.getByRole('combobox',{ name:'开发身份' }).selectOption('agent-1');
    await page.getByRole('button',{ name:'服务报表', exact:true }).click();
    const currentTab = page.getByRole('tab',{ name:'当前责任', exact:true });
    const historyTab = page.getByRole('tab',{ name:'历史责任', exact:true });
    await currentTab.focus();
    await currentTab.press('ArrowRight');
    await expect(historyTab).toBeFocused();
    await expect(historyTab).toHaveAttribute('aria-selected','true');
    const panel = page.getByRole('tabpanel',{ name:'历史责任', exact:true });
    const group = panel.getByRole('combobox',{ name:'支持组' });
    await expect(group).toBeEnabled();
    await group.selectOption(owned.groupId);
    await panel.getByLabel('开始日期').fill(range.from);
    await panel.getByLabel('结束日期').fill(range.to);
    await panel.getByRole('combobox',{ name:'工单类型' }).selectOption('REQ');
    await panel.getByRole('button',{ name:'查询', exact:true }).click();
    const detail = panel.getByRole('table',{ name:'历史责任区间' });
    const ownedRows = detail.getByRole('row').filter({ hasText:`REQ-${owned.ticketId}` });
    const offeredRows = detail.getByRole('row').filter({ hasText:`REQ-${offered.ticketId}` });
    await expect(ownedRows.first()).toBeVisible();
    await expect(offeredRows.first()).toBeVisible();
    await expect(detail.getByText('存在待接收安排',{ exact:true })).toBeVisible();
    await expect(detail.getByRole('cell',{ name:'历史责任组', exact:true }).first()).toBeVisible();
    await expect(detail.getByRole('button')).toHaveCount(0);
    await expect(detail.getByRole('link')).toHaveCount(0);
    const distribution = panel.getByRole('region',{ name:'历史责任分布' });
    await expect(distribution.getByText(/记录名称：/)).toContainText('原岗位工程师');
    await expect(distribution.getByText(/记录名称：/)).toContainText('更名后工程师');
    const owner = panel.getByRole('combobox',{ name:'历史负责人' });
    await expect(owner.locator('option[value="PERSON:agent-2"]')).toHaveCount(0);
    await expect(owner.locator(`option[value="PERSON:${engineer}"]`)).toHaveText('更名后工程师');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path:`test-results/reports-history-${viewport.name}.png`, fullPage:true });

    await owner.selectOption(`PERSON:${engineer}`);
    await expect(detail).toHaveCount(0);
    await panel.getByRole('button',{ name:'查询', exact:true }).click();
    await expect(ownedRows.first()).toBeVisible();
    await expect(offeredRows).toHaveCount(0);
    await owner.selectOption('UNASSIGNED');
    await expect(detail).toHaveCount(0);
    await panel.getByRole('button',{ name:'查询', exact:true }).click();
    await expect(offeredRows.first()).toBeVisible();
    await expect(owner.locator(`option[value="PERSON:${engineer}"]`)).toHaveCount(1);

    await panel.getByRole('combobox',{ name:'工单类型' }).selectOption('INC');
    await expect(owner).toHaveValue('ALL');
    await expect(detail).toHaveCount(0);
    await panel.getByRole('button',{ name:'查询', exact:true }).click();
    await expect(panel.getByText('当前筛选条件下暂无已记录的责任区间',{ exact:true })).toBeVisible();
    await page.route('**/reports/responsibility-history?**', route => route.fulfill({ status:503,
      contentType:'application/json', body:JSON.stringify({ code:'REPORT_HISTORY_WINDOW_TOO_LARGE' }) }));
    await panel.getByRole('button',{ name:'查询', exact:true }).click();
    await expect(panel.getByRole('alert')).toHaveText('历史责任区间超过 5000 条，请缩小日期范围后重试。');
    await expect(detail).toHaveCount(0);
    await page.unroute('**/reports/responsibility-history?**');
    await panel.getByRole('button',{ name:'查询', exact:true }).click();
    await expect(panel.getByRole('alert')).toHaveCount(0);
    await expect(panel.getByText('当前筛选条件下暂无已记录的责任区间',{ exact:true })).toBeVisible();
    await historyTab.press('Home');
    await expect(currentTab).toBeFocused();
    await expect(currentTab).toHaveAttribute('aria-selected','true');
    await expect(page.getByRole('tabpanel',{ name:'当前责任', exact:true })).toBeVisible();
  });

  test(`report shows current personal responsibility without claiming offered candidates on ${viewport.name}`, async ({ page }) => {
    const day = viewport.name === 'desktop' ? '2025-05-19' : '2025-05-20';
    const owned = await createFulfillmentFixture();
    const offered = await createFulfillmentFixture({ groupId:owned.groupId });
    await fulfillmentSql(`UPDATE tickets SET created_at=${literal(`${day} 10:00:00+08`)},assignee_id='agent-1'
      WHERE id=${literal(owned.ticketId)};
      UPDATE tickets SET created_at=${literal(`${day} 11:00:00+08`)},pending_group_id=owner_group_id,pending_assignee_id='agent-2',
        assignment_kind='OFFER',assignment_state='PENDING',assignment_offered_at=now()
      WHERE id=${literal(offered.ticketId)}`);
    await page.setViewportSize({ width:viewport.width, height:viewport.height });
    await page.goto('/');
    await page.getByRole('combobox',{ name:'开发身份' }).selectOption('agent-1');
    await page.getByRole('button',{ name:'服务报表', exact:true }).click();
    const group = page.getByRole('combobox',{ name:'支持组' });
    await expect(group).toBeEnabled();
    await group.selectOption(owned.groupId);
    await page.getByLabel('开始日期').fill(day);
    await page.getByLabel('结束日期').fill(day);
    await page.getByRole('combobox',{ name:'工单类型' }).selectOption('REQ');
    await page.getByRole('button',{ name:'查询', exact:true }).click();
    const owner = page.getByRole('combobox',{ name:'当前负责人' });
    const detail = page.getByRole('table',{ name:'工单指标明细' });
    await expect(page.getByRole('region',{ name:'当前责任分布' })).toBeVisible();
    await expect(detail.getByRole('button',{ name:`REQ-${owned.ticketId}`, exact:true })).toBeVisible();
    await expect(detail.getByRole('button',{ name:`REQ-${offered.ticketId}`, exact:true })).toBeVisible();
    await expect(owner.locator('option[value="PERSON:agent-1"]')).toHaveCount(1);
    await expect(owner.locator('option[value="PERSON:agent-2"]')).toHaveCount(0);
    await owner.selectOption('UNASSIGNED');
    await expect(detail).toHaveCount(0);
    await page.getByRole('button',{ name:'查询', exact:true }).click();
    await expect(detail.getByRole('button',{ name:`REQ-${owned.ticketId}`, exact:true })).toHaveCount(0);
    await expect(detail.getByRole('button',{ name:`REQ-${offered.ticketId}`, exact:true })).toBeVisible();
    await expect(detail.getByText(/派单待接收/)).toBeVisible();
    await owner.selectOption('PERSON:agent-1');
    await expect(detail).toHaveCount(0);
    await page.getByRole('button',{ name:'查询', exact:true }).click();
    await expect(detail.getByRole('button',{ name:`REQ-${owned.ticketId}`, exact:true })).toBeVisible();
    await expect(detail.getByRole('button',{ name:`REQ-${offered.ticketId}`, exact:true })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path:`test-results/reports-personal-${viewport.name}.png`, fullPage:true });
    await page.getByRole('combobox',{ name:'工单类型' }).selectOption('INC');
    await expect(owner).toHaveValue('ALL');
    await expect(detail).toHaveCount(0);
    await page.getByRole('button',{ name:'查询', exact:true }).click();
    await expect(page.getByText('新增故障',{ exact:true })).toBeVisible();
    await expect(detail.getByRole('button',{ name:`REQ-${owned.ticketId}`, exact:true })).toHaveCount(0);
  });

  test(`report separates incidents and requests on ${viewport.name}`, async ({ page }) => {
    const day = viewport.name === 'desktop' ? '2025-05-17' : '2025-05-18';
    const request = await createFulfillmentFixture();
    await fulfillmentSql(`UPDATE tickets SET status='CLOSED',created_at=${literal(`${day} 10:00:00+08`)}
      WHERE id=${literal(request.ticketId)};
      INSERT INTO ticket_feedback(ticket_id,requester_id,rating) VALUES(${literal(request.ticketId)},'employee-1',4)`);
    await page.setViewportSize({ width:viewport.width, height:viewport.height });
    await page.goto('/');
    await page.getByRole('combobox',{ name:'开发身份' }).selectOption('agent-1');
    await page.getByRole('button',{ name:'服务报表', exact:true }).click();
    const group = page.getByRole('combobox',{ name:'支持组' });
    await expect(page.getByText('新增故障',{ exact:true })).toBeVisible();
    await expect(group).toBeEnabled();
    await group.selectOption(request.groupId);
    await page.getByLabel('开始日期').fill(day);
    await page.getByLabel('结束日期').fill(day);
    const type = page.getByRole('combobox',{ name:'工单类型' });
    await type.selectOption('REQ');
    await page.getByRole('button',{ name:'查询', exact:true }).click();
    await expect(page.getByText('新增请求',{ exact:true })).toBeVisible();
    await expect(page.getByText('4 / 5',{ exact:true })).toBeVisible();
    const ticket = page.getByRole('button',{ name:`REQ-${request.ticketId}`, exact:true });
    await expect(ticket).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path:`test-results/reports-requests-${viewport.name}.png`, fullPage:true });
    await type.selectOption('INC');
    await page.getByRole('button',{ name:'查询', exact:true }).click();
    await expect(page.getByText('新增故障',{ exact:true })).toBeVisible();
    await expect(ticket).toHaveCount(0);
  });
}
