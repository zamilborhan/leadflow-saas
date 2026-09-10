#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/626fe536e6ece6f6684e8759b1368994ffc788791f2ff173244174cb87deca47/contract';
import endContract from '../../snapshots/626fe536e6ece6f6684e8759b1368994ffc788791f2ff173244174cb87deca47/contract.json' with { type: 'json' };
import type { Contract as Start } from '../../snapshots/efe7ce028d39226b18b072ebbd4f2bc18ef14e4c58cb59429e3a268e7c65dfee/contract';
import startContract from '../../snapshots/efe7ce028d39226b18b072ebbd4f2bc18ef14e4c58cb59429e3a268e7c65dfee/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col, fn, lit, primaryKey } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.createTable({
        schema: 'public',
        table: 'WhatsAppMessage',
        columns: [
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
          col('direction', 'text', {
            notNull: true,
            default: lit('outbound'),
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('id', 'character(36)', {
            notNull: true,
            codecRef: { codecId: 'sql/char@1', typeParams: { length: 36 } },
          }),
          col('lastError', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('leadId', 'character(36)', {
            notNull: true,
            codecRef: { codecId: 'sql/char@1', typeParams: { length: 36 } },
          }),
          col('messageId', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('nextRetryAt', 'timestamptz', { codecRef: { codecId: 'pg/timestamptz-string@1' } }),
          col('status', 'text', {
            notNull: true,
            default: lit('QUEUED'),
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('templateLanguage', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('templateName', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('toPhone', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('type', 'text', {
            notNull: true,
            default: lit('template'),
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('updatedAt', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-string@1' },
          }),
          col('variablesJson', 'text', { codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
