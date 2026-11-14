import type { PoolClient } from 'pg';

// Role changes are exclusive; privileged ticket actions hold the shared lock until commit.
export const ROLE_AUTHORIZATION_LOCK = 71820512;
export const ROLE_EFFECTIVE_SQL = `r.status='ACTIVE' AND r.valid_from<=clock_timestamp() AND r.valid_to>clock_timestamp()
  AND EXISTS(SELECT 1 FROM employees e WHERE e.id=r.employee_id AND e.active)
  AND (r.group_id IS NULL OR EXISTS(SELECT 1 FROM group_memberships m WHERE m.employee_id=r.employee_id AND m.group_id=r.group_id))`;

export async function canDispatch(client: Pick<PoolClient,'query'>, employee: string, group: string): Promise<boolean> {
  const result = await client.query(`SELECT 1 FROM role_bindings r WHERE r.employee_id=$1 AND r.group_id=$2
    AND r.role_code IN ('DISPATCHER','GROUP_LEAD') AND ${ROLE_EFFECTIVE_SQL} LIMIT 1`, [employee,group]);
  return !!result.rowCount;
}

export function roleReviewDenial(actor: string, proposer: string, subject: string): string | undefined {
  if (actor===proposer || actor===subject) return 'ROLE_INDEPENDENT_REVIEW_REQUIRED';
  return undefined;
}
