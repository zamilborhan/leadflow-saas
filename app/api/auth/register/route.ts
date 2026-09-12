import { NextResponse } from "next/server";
import { registerService } from "@/src/lib/auth/service";
import {
  applyServiceResult,
  getClientIp,
  internalError,
  isAllowedRequestOrigin,
  readJsonBody,
} from "@/src/lib/auth/http";
import { env } from "@/src/lib/env";

export async function POST(req: Request) {
  try {
    if (!isAllowedRequestOrigin(req, env.appUrl)) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }
    const result = await registerService(await readJsonBody(req), getClientIp(req.headers));
    return applyServiceResult(result);
  } catch (err) {
    return internalError("register", err);
  }
}
