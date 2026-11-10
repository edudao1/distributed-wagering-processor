import type { z } from "zod";
import { RequestValidationError } from "../../application/errors";

export function parseOrThrow<S extends z.ZodTypeAny>(
  schema: S,
  input: unknown,
  code = "INVALID_PAYLOAD",
): z.infer<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    }));
    throw new RequestValidationError("request validation failed", issues, code);
  }
  return result.data;
}
