import { resetPasswordService } from "@/src/lib/auth/service";
import {
  applyServiceResult,
  getClientIp,
  internalError,
  readJsonBody,
} from "@/src/lib/auth/http";

export async function POST(req: Request) {
  try {
    const result = await resetPasswordService(
      await readJsonBody(req),
      getClientIp(req.headers)
    );
    return applyServiceResult(result);
  } catch (err) {
    return internalError("reset-password", err);
  }
}
