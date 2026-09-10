#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/948daa5cf90d2aee2d302911fe452de7155e4b08c437e3ff3f2f445a64d732dc/contract';
import startContract from '../../snapshots/948daa5cf90d2aee2d302911fe452de7155e4b08c437e3ff3f2f445a64d732dc/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/efe7ce028d39226b18b072ebbd4f2bc18ef14e4c58cb59429e3a268e7c65dfee/contract';
import endContract from '../../snapshots/efe7ce028d39226b18b072ebbd4f2bc18ef14e4c58cb59429e3a268e7c65dfee/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col, fn, primaryKey } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.createTable({
        schema: 'public',
        table: 'LeadTemplateSelection',
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
          col('leadId', 'character(36)', {
            notNull: true,
            codecRef: { codecId: 'sql/char@1', typeParams: { length: 36 } },
          }),
          col('selectedBy', 'character(36)', {
            notNull: true,
            codecRef: { codecId: 'sql/char@1', typeParams: { length: 36 } },
          }),
          col('templateLanguage', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('templateName', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('updatedAt', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-string@1' },
          }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'public',
        table: 'WhatsAppTemplate',
        columns: [
          col('businessId', 'character(36)', {
            notNull: true,
            codecRef: { codecId: 'sql/char@1', typeParams: { length: 36 } },
          }),
          col('category', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('componentsJson', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('createdAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-string@1' },
          }),
          col('id', 'character(36)', {
            notNull: true,
            codecRef: { codecId: 'sql/char@1', typeParams: { length: 36 } },
          }),
          col('language', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('name', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('status', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('updatedAt', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-string@1' },
          }),
          col('wabaId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.addUnique({
        schema: 'public',
        table: 'LeadTemplateSelection',
        constraint: 'LeadTemplateSelection_businessId_leadId_key',
        columns: ['businessId', 'leadId'],
      }),
      this.addUnique({
        schema: 'public',
        table: 'WhatsAppTemplate',
        constraint: 'WhatsAppTemplate_businessId_name_language_key',
        columns: ['businessId', 'name', 'language'],
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
