import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

export async function retireSupportGroup(groupId) {
  if (process.env.GITHUB_ACTIONS !== 'true' || !process.env.ITSM_CI_ENV) throw new Error('DISPOSABLE_GITHUB_CI_ONLY');
  async function request(path, user, body) {
    const response = await fetch(`http://127.0.0.1:8088/api/v1/admin/support-structure${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { 'Content-Type':'application/json', 'X-Dev-User':user, 'Idempotency-Key':randomUUID() },
      body: body ? JSON.stringify({ contentClass:'GENERAL', ...body }) : undefined,
      signal: AbortSignal.timeout(20000)
    });
    const data = await response.json();
    assert.ok(response.ok, JSON.stringify({ status:response.status, data }));
    return data;
  }
  const group = (await request('', 'demo-admin-1')).groups.find(item => item.id === groupId);
  assert.ok(group?.enabled, 'CI fixture group must be enabled before reviewed retirement');
  const proposal = await request('', 'demo-admin-1', { id:randomUUID(), kind:'GROUP_DISABLE', groupId,
    config:{}, expectedGroupVersion:group.version, reason:'Retire dependency-free CI report fixture' });
  await request(`/${proposal.id}/review`, 'demo-admin-2', { expectedVersion:proposal.version,
    decision:'APPROVE', reason:'Independent review of CI fixture retirement' });
}
