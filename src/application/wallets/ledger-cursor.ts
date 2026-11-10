import { Buffer } from "node:buffer";
import { InvalidCursorError } from "../errors";

const CURSOR_VERSION = 1;
const SEQUENCE_PATTERN = /^\d{1,19}$/;

export function encodeLedgerCursor(sequence: string): string {
  return Buffer.from(JSON.stringify({ v: CURSOR_VERSION, seq: sequence }), "utf8").toString("base64url");
}

export function decodeLedgerCursor(cursor: string): string {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "v" in parsed &&
      "seq" in parsed &&
      parsed.v === CURSOR_VERSION &&
      typeof parsed.seq === "string" &&
      SEQUENCE_PATTERN.test(parsed.seq)
    ) {
      return parsed.seq;
    }
  } catch {
    throw new InvalidCursorError();
  }
  throw new InvalidCursorError();
}
