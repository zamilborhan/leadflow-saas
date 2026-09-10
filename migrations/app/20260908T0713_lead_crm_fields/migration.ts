#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/a368ac600dbcf312e92dc4f678860f49dde9723a0d22216eba06faf57d5630fd/contract';
import startContract from '../../snapshots/a368ac600dbcf312e92dc4f678860f49dde9723a0d22216eba06faf57d5630fd/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/b70aeee76e8a4ac8b50d99cfc05219cb931484bcd466704c984c316f8d672d52/contract';
import endContract from '../../snapshots/b70aeee76e8a4ac8b50d99cfc05219cb931484bcd466704c984c316f8d672d52/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.addColumn({
        schema: 'public',
        table: 'Lead',
        column: col('adName', 'text', { codecRef: { codecId: 'pg/text@1' } }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'Lead',
        column: col('adSetName', 'text', { codecRef: { codecId: 'pg/text@1' } }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'Lead',
        column: col('archivedAt', 'timestamptz', {
          codecRef: { codecId: 'pg/timestamptz-string@1' },
        }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'Lead',
        column: col('campaignName', 'text', { codecRef: { codecId: 'pg/text@1' } }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'Lead',
        column: col('facebookLeadId', 'text', { codecRef: { codecId: 'pg/text@1' } }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'Lead',
        column: col('lastContactedAt', 'timestamptz', {
          codecRef: { codecId: 'pg/timestamptz-string@1' },
        }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'Lead',
        column: col('nextFollowUpAt', 'timestamptz', {
          codecRef: { codecId: 'pg/timestamptz-string@1' },
        }),
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
