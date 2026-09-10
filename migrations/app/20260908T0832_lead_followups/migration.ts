#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/12839d1f765f5afea80592530e988324fd1ab4b6232db846fd1b3f1e1b0449aa/contract';
import endContract from '../../snapshots/12839d1f765f5afea80592530e988324fd1ab4b6232db846fd1b3f1e1b0449aa/contract.json' with { type: 'json' };
import type { Contract as Start } from '../../snapshots/df6e7d709cd6bbaebdd9c03d0c8f6fe9d5645bc0b7c3ddeefa6ddbb813bcdb04/contract';
import startContract from '../../snapshots/df6e7d709cd6bbaebdd9c03d0c8f6fe9d5645bc0b7c3ddeefa6ddbb813bcdb04/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col, fn, lit, primaryKey } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.createTable({
        schema: 'public',
        table: 'FollowUp',
        columns: [
          col('assignedTo', 'character(36)', {
            codecRef: { codecId: 'sql/char@1', typeParams: { length: 36 } },
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
          col('leadId', 'character(36)', {
            notNull: true,
            codecRef: { codecId: 'sql/char@1', typeParams: { length: 36 } },
          }),
          col('note', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('scheduledAt', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-string@1' },
          }),
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
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
