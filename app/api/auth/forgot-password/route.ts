import { forgotPasswordService } from "@/src/lib/auth/service";
import {
  applyServiceResult,
  getClientIp,
  internalError,
  readJsonBody,
} from "@/src/lib/auth/http";

export async function POST(req: Request) {
  try {
    const result = await forgotPasswordService(
      await readJsonBody(req),
      getClientIp(req.headers)
    );
    return applyServiceResult(result);
  } catch (err) {
    return internalError("forgot-password", err);
  }
}
