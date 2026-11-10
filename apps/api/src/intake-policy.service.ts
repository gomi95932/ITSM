import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { Database } from './database.service.js';

type IntakeChannel = 'ticket-create' | 'ticket-action' | 'voice-interpret' | 'priority-review' | 'classification' | 'request-catalog';
type Denial = 'CONTENT_DECLARATION_REQUIRED' | 'SECURITY_CHANNEL_REQUIRED';

const sensitivePatterns = [
  /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/i,
  /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})\b/,
  /\bBearer\s+[A-Za-z0-9._~+/-]{12,}/i,
  /["']?(?:password|passwd|api[_ -]?key|access[_ -]?token|client[_ -]?secret|密码|密钥|令牌)["']?\s*[:=：]\s*["']?[^\s"'，,;；}{]{4,}/iu,
  /数据泄露|信息泄露|账号泄露|账户泄露|凭据泄露|勒索软件|勒索攻击|疑似入侵|确认入侵|恶意软件|木马感染/,
];

export function intakeDenial(contentClass: unknown, content: unknown): Denial | undefined {
  if (contentClass === 'SECURITY_SENSITIVE') return 'SECURITY_CHANNEL_REQUIRED';
  if (contentClass !== 'GENERAL') return 'CONTENT_DECLARATION_REQUIRED';
  const text = (JSON.stringify(content) ?? '').normalize('NFKC').replace(/\\[nrt]/g, ' ');
  return sensitivePatterns.some(pattern => pattern.test(text)) ? 'SECURITY_CHANNEL_REQUIRED' : undefined;
}

@Injectable()
export class IntakePolicyService {
  constructor(private readonly db: Database) {}

  config() {
    const contact = process.env.ITSM_SECURITY_CONTACT?.trim();
    return { securityIntakeEnabled: false, recordingEnabled: false, contactConfigured: !!contact,
      securityContact: contact?.slice(0, 300) || '请通过公司现有安全应急电话或线下联系信息安全负责人；请勿在普通工单或语音草稿中提交证据。' };
  }

  async requireGeneral(actorId: string, body: Record<string, unknown>, channel: IntakeChannel): Promise<void> {
    const denial = intakeDenial(body.contentClass, body);
    if (!denial) return;
    // Rejection auditing deliberately excludes payloads, excerpts, hashes and ticket identifiers.
    await this.db.pool.query('INSERT INTO operational_audits(actor_id,action,target_id) VALUES ($1,$2,$3)',
      [actorId, denial, channel]);
    if (denial === 'CONTENT_DECLARATION_REQUIRED') throw new BadRequestException({ code: denial });
    throw new ForbiddenException({ code: denial });
  }
}
