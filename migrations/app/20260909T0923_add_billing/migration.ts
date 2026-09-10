#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/241d389ad36664624eac0878674e14d8a5f770daa82166c4138c358753c14efa/contract';
import endContract from '../../snapshots/241d389ad36664624eac0878674e14d8a5f770daa82166c4138c358753c14efa/contract.json' with { type: 'json' };
import type { Contract as Start } from '../../snapshots/71aba4d38990d240822b3a75b8fcd3e29ab1c321843536a3ab5fd196f973e3ca/contract';
import startContract from '../../snapshots/71aba4d38990d240822b3a75b8fcd3e29ab1c321843536a3ab5fd196f973e3ca/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col, fn, lit, primaryKey } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.createTable({
        schema: 'public',
        table: 'Plan',
        columns: [
          col('code', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('createdAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-string@1' },
          }),
          col('id', 'character(36)', {
            notNull: true,
            codecRef: { codecId: 'sql/char@1', typeParams: { length: 36 } },
          }),
          col('leadsPerMonth', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('maxBusinesses', 'int4', { codecRef: { codecId: 'pg/int4@1' } }),
          col('maxUsers', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('name', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('updatedAt', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-string@1' },
          }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'public',
        table: 'Subscription',
        columns: [
          col('billingCycle', 'text', {
            notNull: true,
            default: lit('MONTHLY'),
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
          col('currentPeriodEnd', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-string@1' },
          }),
          col('currentPeriodStart', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-string@1' },
          }),
          col('id', 'character(36)', {
            notNull: true,
            codecRef: { codecId: 'sql/char@1', typeParams: { length: 36 } },
          }),
          col('planCode', 'text', {
            notNull: true,
            default: lit('FREE'),
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('status', 'text', {
            notNull: true,
            default: lit('ACTIVE'),
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
        table: 'Plan',
        constraint: 'Plan_code_key',
        columns: ['code'],
      }),
      this.addUnique({
        schema: 'public',
        table: 'Subscription',
        constraint: 'Subscription_businessId_key',
        columns: ['businessId'],
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
