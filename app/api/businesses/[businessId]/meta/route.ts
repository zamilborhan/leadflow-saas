import { NextResponse } from "next/server";
import { getCurrentUser } from "@/src/lib/auth/dal";
import { resolveBusinessContext } from "@/src/lib/tenancy/context";
import { tenancyErrorResponse } from "@/src/lib/tenancy/guards";
import {
  disconnectMetaConnection,
  getMetaConnectionStatus,
} from "@/src/lib/integrations/meta/service";

async function guard(businessId: string) {
  const user = await getCurrentUser();
  if (!user) return { error: NextResponse.json({ error: "Not authenticated." }, { status: 401 }) };
  const resolved = await resolveBusinessContext(user.id, businessId);
  if (!resolved.ok) {
    return { error: NextResponse.json({ error: "Access denied for this business." }, { status: 403 }) };
  }
  return { user, context: resolved.context };
}

/**
 * Redacted connection status. Contains account identity and expiry only —
 * token ciphertext is never serialized into a response.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ businessId: string }> }
) {
  try {
    const { businessId } = await params;
    const g = await guard(businessId);
    if ("error" in g) return g.error;
    const status = await getMetaConnectionStatus(g.context);
    return NextResponse.json(status, { status: 200 });
  } catch (err) {
    return tenancyErrorResponse(err);
  }
}

/**
 * Disconnect: requires businesses.update (OWNER/ADMIN). Revokes at Meta on
 * a best-effort basis, then deletes stored credentials.
 */
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ businessId: string }> }
) {
  try {
    const { businessId } = await params;
    const g = await guard(businessId);
    if ("error" in g) return g.error;
    const disconnected = await disconnectMetaConnection(g.context);
    if (!disconnected) return NextResponse.json({ error: "Not found." }, { status: 404 });
    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (err) {
    return tenancyErrorResponse(err);
  }
}
