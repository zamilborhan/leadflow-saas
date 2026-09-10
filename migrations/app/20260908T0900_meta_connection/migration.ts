#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/12839d1f765f5afea80592530e988324fd1ab4b6232db846fd1b3f1e1b0449aa/contract';
import startContract from '../../snapshots/12839d1f765f5afea80592530e988324fd1ab4b6232db846fd1b3f1e1b0449aa/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/698481f0f1b6dc8399f214b098346362ad8fc4727b7fbe8bc488ea849c168aea/contract';
import endContract from '../../snapshots/698481f0f1b6dc8399f214b098346362ad8fc4727b7fbe8bc488ea849c168aea/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col, fn, lit, primaryKey } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.createTable({
        schema: 'public',
        table: 'MetaConnection',
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
          col('id', 'character(36)', {
            notNull: true,
            codecRef: { codecId: 'sql/char@1', typeParams: { length: 36 } },
          }),
          col('metaUserId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('metaUserName', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('scopes', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('status', 'text', {
            notNull: true,
            default: lit('ACTIVE'),
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('tokenExpiresAt', 'timestamptz', {
            codecRef: { codecId: 'pg/timestamptz-string@1' },
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
        table: 'MetaConnection',
        constraint: 'MetaConnection_businessId_key',
        columns: ['businessId'],
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
