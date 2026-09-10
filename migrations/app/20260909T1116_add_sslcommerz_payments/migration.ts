#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/241d389ad36664624eac0878674e14d8a5f770daa82166c4138c358753c14efa/contract';
import startContract from '../../snapshots/241d389ad36664624eac0878674e14d8a5f770daa82166c4138c358753c14efa/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/42f9acddfcaf92f53a76b8563a5737785e64be9509f056cfbbba4e6a115ec9a0/contract';
import endContract from '../../snapshots/42f9acddfcaf92f53a76b8563a5737785e64be9509f056cfbbba4e6a115ec9a0/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col, fn, lit, primaryKey } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.createTable({
        schema: 'public',
        table: 'Invoice',
        columns: [
          col('amountMinor', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('businessId', 'character(36)', {
            notNull: true,
            codecRef: { codecId: 'sql/char@1', typeParams: { length: 36 } },
          }),
          col('createdAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-string@1' },
          }),
          col('currency', 'text', {
            notNull: true,
            default: lit('BDT'),
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('id', 'character(36)', {
            notNull: true,
            codecRef: { codecId: 'sql/char@1', typeParams: { length: 36 } },
          }),
          col('invoiceNumber', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('paymentId', 'character(36)', {
            notNull: true,
            codecRef: { codecId: 'sql/char@1', typeParams: { length: 36 } },
          }),
          col('periodEnd', 'timestamptz', { codecRef: { codecId: 'pg/timestamptz-string@1' } }),
          col('periodStart', 'timestamptz', { codecRef: { codecId: 'pg/timestamptz-string@1' } }),
          col('planCode', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('status', 'text', {
            notNull: true,
            default: lit('DRAFT'),
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('updatedAt', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-string@1' },
          }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'public',
        table: 'Payment',
        columns: [
          col('activatedAt', 'timestamptz', { codecRef: { codecId: 'pg/timestamptz-string@1' } }),
          col('amountMinor', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('businessId', 'character(36)', {
            notNull: true,
            codecRef: { codecId: 'sql/char@1', typeParams: { length: 36 } },
          }),
          col('createdAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-string@1' },
          }),
          col('currency', 'text', {
            notNull: true,
            default: lit('BDT'),
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('gatewaySessionKey', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('id', 'character(36)', {
            notNull: true,
            codecRef: { codecId: 'sql/char@1', typeParams: { length: 36 } },
          }),
          col('lastError', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('planCode', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('riskLevel', 'int4', {
            notNull: true,
            default: lit(0),
            codecRef: { codecId: 'pg/int4@1' },
          }),
          col('status', 'text', {
            notNull: true,
            default: lit('INITIATED'),
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('tranId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('updatedAt', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-string@1' },
          }),
          col('userId', 'character(36)', {
            notNull: true,
            codecRef: { codecId: 'sql/char@1', typeParams: { length: 36 } },
          }),
          col('valId', 'text', { codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.addUnique({
        schema: 'public',
        table: 'Invoice',
        constraint: 'Invoice_paymentId_key',
        columns: ['paymentId'],
      }),
      this.addUnique({
        schema: 'public',
        table: 'Invoice',
        constraint: 'Invoice_invoiceNumber_key',
        columns: ['invoiceNumber'],
      }),
      this.addUnique({
        schema: 'public',
        table: 'Payment',
        constraint: 'Payment_tranId_key',
        columns: ['tranId'],
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
