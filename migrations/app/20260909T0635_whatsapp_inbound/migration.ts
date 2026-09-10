#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/1bf6fa99775891fe2f62beaa0f8bd2a726a06cf40c2377231233b2104d7f6a1a/contract';
import endContract from '../../snapshots/1bf6fa99775891fe2f62beaa0f8bd2a726a06cf40c2377231233b2104d7f6a1a/contract.json' with { type: 'json' };
import type { Contract as Start } from '../../snapshots/626fe536e6ece6f6684e8759b1368994ffc788791f2ff173244174cb87deca47/contract';
import startContract from '../../snapshots/626fe536e6ece6f6684e8759b1368994ffc788791f2ff173244174cb87deca47/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.addColumn({
        schema: 'public',
        table: 'WhatsAppMessage',
        column: col('body', 'text', { codecRef: { codecId: 'pg/text@1' } }),
      }),
      this.addColumn({
        schema: 'public',
        table: 'WhatsAppMessage',
        column: col('fromPhone', 'text', { codecRef: { codecId: 'pg/text@1' } }),
      }),
      this.dropNotNull({ schema: 'public', table: 'WhatsAppMessage', column: 'leadId' }),
      this.addUnique({
        schema: 'public',
        table: 'WhatsAppMessage',
        constraint: 'WhatsAppMessage_businessId_messageId_key',
        columns: ['businessId', 'messageId'],
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
