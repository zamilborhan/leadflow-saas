#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/48c7e68b51ed808c58b671713c13b7731306b47b50ea363c4b8fb17b04046747/contract';
import startContract from '../../snapshots/48c7e68b51ed808c58b671713c13b7731306b47b50ea363c4b8fb17b04046747/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/63f6eca5f838d9c38a201fe7f666dd9199488f80256bd7d51624361ee7cce7b4/contract';
import endContract from '../../snapshots/63f6eca5f838d9c38a201fe7f666dd9199488f80256bd7d51624361ee7cce7b4/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col, fn, lit, primaryKey } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.createTable({
        schema: 'public',
        table: 'MetaLeadEvent',
        columns: [
          col('adId', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('adgroupId', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('attempts', 'int4', {
            notNull: true,
            default: lit(0),
            codecRef: { codecId: 'pg/int4@1' },
          }),
          col('businessId', 'character(36)', {
            notNull: true,
            codecRef: { codecId: 'sql/char@1', typeParams: { length: 36 } },
          }),
          col('createdAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-string@1' },
          }),
          col('id', 'character(36)', {
            notNull: true,
            codecRef: { codecId: 'sql/char@1', typeParams: { length: 36 } },
          }),
          col('lastError', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('leadId', 'character(36)', {
            codecRef: { codecId: 'sql/char@1', typeParams: { length: 36 } },
          }),
          col('leadgenId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('metaFormId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('metaPageId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('nextRetryAt', 'timestamptz', { codecRef: { codecId: 'pg/timestamptz-string@1' } }),
          col('status', 'text', {
            notNull: true,
            default: lit('PENDING'),
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('updatedAt', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-string@1' },
          }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.addUnique({
        schema: 'public',
        table: 'Lead',
        constraint: 'Lead_businessId_facebookLeadId_key',
        columns: ['businessId', 'facebookLeadId'],
      }),
      this.addUnique({
        schema: 'public',
        table: 'MetaLeadEvent',
        constraint: 'MetaLeadEvent_businessId_leadgenId_key',
        columns: ['businessId', 'leadgenId'],
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
