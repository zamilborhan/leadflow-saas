#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/42f9acddfcaf92f53a76b8563a5737785e64be9509f056cfbbba4e6a115ec9a0/contract';
import startContract from '../../snapshots/42f9acddfcaf92f53a76b8563a5737785e64be9509f056cfbbba4e6a115ec9a0/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/4c2a9f9d66e1c4aa581e24cf4919abf8df4a937eb09a22fe5749ae0964eafd6a/contract';
import endContract from '../../snapshots/4c2a9f9d66e1c4aa581e24cf4919abf8df4a937eb09a22fe5749ae0964eafd6a/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col, lit } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.addColumn({
        schema: 'public',
        table: 'Business',
        column: col('status', 'text', {
          notNull: true,
          default: lit('ACTIVE'),
          codecRef: { codecId: 'pg/text@1' },
        }),
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
