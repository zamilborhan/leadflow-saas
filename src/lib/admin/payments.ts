/**
 * Platform payment + invoice history (super-admin only).
 *
 * Reads bypass workspace membership — authorization comes from
 * `requireSuperAdmin`. Secrets never appear here: the gateway tables
 * store only ids, amounts, and statuses (tokens live encrypted on the
 * connection rows, which this module never selects).
 */
import { BusinessTable, InvoiceTable, PaymentTable } from "../../prisma/tables";
import { toBusinessId, toDbId } from "../tenancy/businesses";

export interface AdminPaymentRow {
  id: string;
  businessId: string;
  businessName: string | null;
  planCode: string;
  amountMinor: number;
  currency: string;
  tranId: string;
  status: string;
  riskLevel: number;
  invoiceNumber: string | null;
  invoiceStatus: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AdminPaymentPage {
  payments: AdminPaymentRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

const PAYMENT_FIELDS = [
  "id",
  "businessId",
  "planCode",
  "amountMinor",
  "currency",
  "tranId",
  "status",
  "riskLevel",
  "createdAt",
  "updatedAt",
] as const;

async function businessNameOf(businessId: string): Promise<string | null> {
  try {
    const row = await BusinessTable.where({ id: toDbId(businessId) })
      .select("id", "name")
      .first();
    return row && row.id === businessId ? row.name : null;
  } catch {
    return null;
  }
}

/** Platform payment history, newest first, optionally scoped to one workspace. */
export async function listPaymentsAdmin(query?: {
  businessId?: string;
  page?: number;
  pageSize?: number;
}): Promise<AdminPaymentPage> {
  const page = Number.isFinite(query?.page) && (query?.page as number) >= 1 ? Math.floor(query?.page as number) : 1;
  const pageSize =
    Number.isFinite(query?.pageSize) && (query?.pageSize as number) >= 1
      ? Math.min(100, Math.floor(query?.pageSize as number))
      : 20;

  let scopedBusiness: string | null = null;
  if (query?.businessId) {
    try {
      scopedBusiness = toBusinessId(query.businessId);
    } catch {
      return { payments: [], total: 0, page: 1, pageSize, totalPages: 1 };
    }
  }

  const [payments, invoices] = await Promise.all([
    PaymentTable.select(...PAYMENT_FIELDS).all(),
    InvoiceTable.select("paymentId", "invoiceNumber", "status").all(),
  ]);
  const invoiceByPayment = new Map(
    invoices.map((i) => [i.paymentId as string, { invoiceNumber: i.invoiceNumber as string, status: i.status as string }])
  );
  const matched = payments
    .filter((p) => !scopedBusiness || p.businessId === query?.businessId)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

  const total = matched.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, totalPages);
  const rows: AdminPaymentRow[] = [];
  for (const p of matched.slice((safePage - 1) * pageSize, safePage * pageSize)) {
    const inv = invoiceByPayment.get(p.id);
    rows.push({
      id: p.id,
      businessId: p.businessId,
      businessName: await businessNameOf(p.businessId),
      planCode: p.planCode,
      amountMinor: p.amountMinor,
      currency: p.currency,
      tranId: p.tranId,
      status: p.status,
      riskLevel: p.riskLevel,
      invoiceNumber: inv?.invoiceNumber ?? null,
      invoiceStatus: inv?.status ?? null,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    });
  }
  return { payments: rows, total, page: safePage, pageSize, totalPages };
}
