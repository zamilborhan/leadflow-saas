#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/48c7e68b51ed808c58b671713c13b7731306b47b50ea363c4b8fb17b04046747/contract';
import endContract from '../../snapshots/48c7e68b51ed808c58b671713c13b7731306b47b50ea363c4b8fb17b04046747/contract.json' with { type: 'json' };
import type { Contract as Start } from '../../snapshots/698481f0f1b6dc8399f214b098346362ad8fc4727b7fbe8bc488ea849c168aea/contract';
import startContract from '../../snapshots/698481f0f1b6dc8399f214b098346362ad8fc4727b7fbe8bc488ea849c168aea/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col, fn, primaryKey } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.createTable({
        schema: 'public',
        table: 'MetaForm',
        columns: [
          col('businessId', 'character(36)', {
            notNull: true,
            codecRef: { codecId: 'sql/char@1', typeParams: { length: 36 } },
          }),
          col('connectedAt', 'timestamptz', { codecRef: { codecId: 'pg/timestamptz-string@1' } }),
          col('createdAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-string@1' },
          }),
          col('id', 'character(36)', {
            notNull: true,
            codecRef: { codecId: 'sql/char@1', typeParams: { length: 36 } },
          }),
          col('metaFormId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('metaPageId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('name', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('status', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('updatedAt', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-string@1' },
          }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'public',
        table: 'MetaPage',
        columns: [
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
          col('metaPageId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('name', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('pageTokenEncrypted', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('selectedAt', 'timestamptz', { codecRef: { codecId: 'pg/timestamptz-string@1' } }),
          col('tasks', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('updatedAt', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-string@1' },
          }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.addUnique({
        schema: 'public',
        table: 'MetaForm',
        constraint: 'MetaForm_businessId_metaFormId_key',
        columns: ['businessId', 'metaFormId'],
      }),
      this.addUnique({
        schema: 'public',
        table: 'MetaPage',
        constraint: 'MetaPage_businessId_metaPageId_key',
        columns: ['businessId', 'metaPageId'],
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
