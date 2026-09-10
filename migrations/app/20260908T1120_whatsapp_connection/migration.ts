#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/63f6eca5f838d9c38a201fe7f666dd9199488f80256bd7d51624361ee7cce7b4/contract';
import startContract from '../../snapshots/63f6eca5f838d9c38a201fe7f666dd9199488f80256bd7d51624361ee7cce7b4/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/948daa5cf90d2aee2d302911fe452de7155e4b08c437e3ff3f2f445a64d732dc/contract';
import endContract from '../../snapshots/948daa5cf90d2aee2d302911fe452de7155e4b08c437e3ff3f2f445a64d732dc/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col, fn, lit, primaryKey } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.createTable({
        schema: 'public',
        table: 'WhatsAppConnection',
        columns: [
          col('accessTokenEncrypted', 'text', {
            notNull: true,
            codecRef: { codecId: 'pg/text@1' },
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
          col('displayPhoneNumber', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('healthStatus', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('id', 'character(36)', {
            notNull: true,
            codecRef: { codecId: 'sql/char@1', typeParams: { length: 36 } },
          }),
          col('lastCheckedAt', 'timestamptz', { codecRef: { codecId: 'pg/timestamptz-string@1' } }),
          col('phoneNumberId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('status', 'text', {
            notNull: true,
            default: lit('ACTIVE'),
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('updatedAt', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-string@1' },
          }),
          col('verifiedName', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('wabaId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.addUnique({
        schema: 'public',
        table: 'WhatsAppConnection',
        constraint: 'WhatsAppConnection_businessId_key',
        columns: ['businessId'],
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
