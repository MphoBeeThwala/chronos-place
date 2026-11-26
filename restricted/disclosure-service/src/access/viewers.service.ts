import { DomainError } from '@chronos/service-kit';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';
import type { AccessLog } from '../vault/access-log.js';
import type { SubjectDirectory } from '../vault/subjects.js';

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;
export const INVALID_PAGE_TOKEN = 'Invalid request.';

export interface HealthViewer {
  viewerAccountId: string;
  lastViewedAt: Date;
  viewCount: number;
  hasActiveGrant: boolean;
}

/** Opaque keyset cursor: the last row's view time (microseconds) and viewer id. */
const cursorSchema = z.object({ t: z.string().regex(/^\d{1,20}$/), v: z.uuid() });
type Cursor = z.infer<typeof cursorSchema>;

const encode = (cursor: Cursor): string =>
  Buffer.from(JSON.stringify(cursor)).toString('base64url');
function decode(token: string): Cursor {
  try {
    return cursorSchema.parse(JSON.parse(Buffer.from(token, 'base64url').toString('utf8')));
  } catch {
    throw new DomainError('invalid_argument', INVALID_PAGE_TOKEN);
  }
}

/**
 * ListHealthViewers: who has seen the member's health information (M2.4). Built from the access
 * log: successful views by other members only (approved), newest first. The member's own views and
 * moderator views (M5 decides how those appear) are not listed. Reading the list is itself recorded.
 */
export class ViewersService {
  readonly #db: NodePgDatabase;
  readonly #subjects: SubjectDirectory;
  readonly #accessLog: AccessLog;

  constructor(db: NodePgDatabase, subjects: SubjectDirectory, accessLog: AccessLog) {
    this.#db = db;
    this.#subjects = subjects;
    this.#accessLog = accessLog;
  }

  async list(
    subjectId: string,
    pageSize: number,
    pageToken: string,
  ): Promise<{ viewers: HealthViewer[]; nextPageToken: string }> {
    const size = pageSize <= 0 ? DEFAULT_PAGE_SIZE : Math.min(pageSize, MAX_PAGE_SIZE);
    const after = pageToken === '' ? undefined : decode(pageToken);
    const vaultId = await this.#subjects.find(subjectId);
    if (vaultId === undefined) return { viewers: [], nextPageToken: '' };

    await this.#accessLog.record({
      vaultId,
      accessor: `account:${subjectId}`,
      purpose: 'profile_view',
      decision: 'allow',
      reason: 'self_viewers',
    });
    const self = `account:${subjectId}`;
    const { rows } = await this.#db.execute<{
      viewer: string;
      last_at: Date;
      last_us: string;
      views: number;
      active: boolean;
    }>(sql`
      select substr(l.accessor, 9)::uuid as viewer,
             max(l.at) as last_at,
             (extract(epoch from max(l.at)) * 1000000)::bigint::text as last_us,
             count(*)::int as views,
             exists (
               select 1 from vault.disclosure_grants g
                where g.vault_id = l.vault_id and g.revoked_at is null
                  and g.viewer_account_id = substr(l.accessor, 9)::uuid
             ) as active
        from vault.health_access_log l
       where l.vault_id = ${vaultId}
         and l.decision = 'allow'
         and l.accessor like 'account:%'
         and l.accessor <> ${self}
         -- Profile views only: appearing in someone's filtered list is not a view (M2.6 decision).
         and l.purpose in ('profile_view', 'chat_card')
       group by l.vault_id, l.accessor
      ${
        after === undefined
          ? sql``
          : sql`having ((extract(epoch from max(l.at)) * 1000000)::bigint, substr(l.accessor, 9)::uuid)
                 < (${after.t}::bigint, ${after.v}::uuid)`
      }
       order by max(l.at) desc, substr(l.accessor, 9)::uuid desc
       limit ${size + 1}`);

    const page = rows.slice(0, size);
    const last = page.at(-1);
    return {
      viewers: page.map((r) => ({
        viewerAccountId: r.viewer,
        lastViewedAt: new Date(r.last_at),
        viewCount: r.views,
        hasActiveGrant: r.active,
      })),
      nextPageToken:
        rows.length > size && last !== undefined ? encode({ t: last.last_us, v: last.viewer }) : '',
    };
  }
}
