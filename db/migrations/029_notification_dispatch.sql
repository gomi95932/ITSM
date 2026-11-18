ALTER TABLE notification_deliveries ADD COLUMN provider_recipient_hash text;

-- Older sends have no recorded recipient binding or reliable pre-send checkpoint.
UPDATE notification_deliveries
SET state='REVIEW_REQUIRED', last_error='LEGACY_DELIVERY_UNVERIFIED', updated_at=clock_timestamp()
WHERE state IN ('PENDING','SENDING','DEAD')
  AND (provider_task_id IS NOT NULL OR (attempts>0 AND COALESCE(last_error,'') NOT IN
    ('LIVE_DELIVERY_DISABLED','RECIPIENT_NOT_LINKED','TOKEN_FAILED','HTTPS_DEEP_LINK_REQUIRED','DINGTALK_NOT_CONFIGURED')));
