import { NextResponse } from "next/server";
import { readJsonBody } from "@/src/lib/auth/http";
import { createBusiness, listUserBusinesses } from "@/src/lib/tenancy/businesses";
import { requireUser, tenancyErrorResponse } from "@/src/lib/tenancy/guards";
import { ensureRoleSeeds } from "@/src/lib/tenancy/seeds";
import { validateBusinessName } from "@/src/lib/tenancy/validation";

export async function GET() {
  try {
    const authed = await requireUser();
    if ("response" in authed) return authed.response;
    const businesses = await listUserBusinesses(authed.user.id);
    return NextResponse.json({ businesses }, { status: 200 });
  } catch (err) {
    return tenancyErrorResponse(err);
  }
}

export async function POST(req: Request) {
  try {
    const authed = await requireUser();
    if ("response" in authed) return authed.response;
    const parsed = validateBusinessName(await readJsonBody(req));
    if (!parsed.ok || !parsed.value) {
      return NextResponse.json({ errors: parsed.errors }, { status: 422 });
    }
    await ensureRoleSeeds();
    const business = await createBusiness(authed.user.id, parsed.value.name);
    return NextResponse.json({ business }, { status: 201 });
  } catch (err) {
    return tenancyErrorResponse(err);
  }
}
