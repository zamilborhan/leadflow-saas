import { confirmVerificationService } from "@/src/lib/auth/service";
import {
  applyServiceResult,
  getClientIp,
  internalError,
  readJsonBody,
} from "@/src/lib/auth/http";

async function confirm(req: Request): Promise<Response> {
  try {
    let input: unknown;
    if (req.method === "GET") {
      const token = new URL(req.url).searchParams.get("token");
      input = { token };
    } else {
      input = await readJsonBody(req);
    }
    const result = await confirmVerificationService(input, getClientIp(req.headers));
    return applyServiceResult(result);
  } catch (err) {
    return internalError("verify-email-confirm", err);
  }
}

export async function POST(req: Request) {
  return confirm(req);
}

export async function GET(req: Request) {
  return confirm(req);
}
