-- Isolated CI diagnostics: retain timing and blockers without query text or data.
SELECT json_build_object(
  'at', clock_timestamp(),
  'sessions', COALESCE(json_agg(json_build_object(
    'pid', pid, 'state', state, 'waitType', wait_event_type, 'wait', wait_event,
    'querySeconds', EXTRACT(epoch FROM clock_timestamp() - query_start),
    'transactionSeconds', EXTRACT(epoch FROM clock_timestamp() - xact_start),
    'blockers', pg_blocking_pids(pid),
    'operation', CASE
      WHEN query LIKE '%pg_advisory_xact_lock%' THEN 'authorization-lock'
      WHEN query LIKE '%ticket_routing_alerts%service_position_eligible%' THEN 'ownership-scan'
      WHEN query LIKE '%support_structure_proposals%' THEN 'support-proposal'
      WHEN query LIKE '%support_groups%FOR UPDATE%' THEN 'support-group-lock'
      ELSE 'other'
    END
  )), '[]'::json)
)
FROM pg_stat_activity
WHERE datname = current_database() AND pid <> pg_backend_pid()
  AND state IS DISTINCT FROM 'idle';
