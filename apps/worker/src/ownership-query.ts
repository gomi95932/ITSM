export const ownershipCandidatesQuery=`SELECT t.id FROM tickets t
  WHERE t.status NOT IN ('CLOSED','CANCELLED','REJECTED')
  ORDER BY t.ownership_checked_at NULLS FIRST,t.id LIMIT 100`;
