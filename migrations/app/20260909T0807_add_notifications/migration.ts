#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/71aba4d38990d240822b3a75b8fcd3e29ab1c321843536a3ab5fd196f973e3ca/contract';
import endContract from '../../snapshots/71aba4d38990d240822b3a75b8fcd3e29ab1c321843536a3ab5fd196f973e3ca/contract.json' with { type: 'json' };
import type { Contract as Start } from '../../snapshots/a4169bd0d38aa5c2711dc630a0df777415249b0bdb0b546eb95fa803b3823e37/contract';
import startContract from '../../snapshots/a4169bd0d38aa5c2711dc630a0df777415249b0bdb0b546eb95fa803b3823e37/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col, fn, primaryKey } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.createTable({
        schema: 'public',
        table: 'Notification',
        columns: [
          col('body', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('businessId', 'character(36)', {
            notNull: true,
            codecRef: { codecId: 'sql/char@1', typeParams: { length: 36 } },
          }),
          col('createdAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-string@1' },
          }),
          col('dedupeKey', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('id', 'character(36)', {
            notNull: true,
            codecRef: { codecId: 'sql/char@1', typeParams: { length: 36 } },
          }),
          col('leadId', 'character(36)', {
            codecRef: { codecId: 'sql/char@1', typeParams: { length: 36 } },
          }),
          col('readAt', 'timestamptz', { codecRef: { codecId: 'pg/timestamptz-string@1' } }),
          col('title', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('type', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('updatedAt', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-string@1' },
          }),
          col('userId', 'character(36)', {
            notNull: true,
            codecRef: { codecId: 'sql/char@1', typeParams: { length: 36 } },
          }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.addUnique({
        schema: 'public',
        table: 'Notification',
        constraint: 'Notification_businessId_userId_dedupeKey_key',
        columns: ['businessId', 'userId', 'dedupeKey'],
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
