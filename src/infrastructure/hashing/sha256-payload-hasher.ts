import { createHash } from "node:crypto";
import type { PayloadHasher } from "../../application/ports/infrastructure";
import { canonicalJson } from "./canonical-json";

export class Sha256PayloadHasher implements PayloadHasher {
  hash(payload: unknown): string {
    return createHash("sha256").update(canonicalJson(payload), "utf8").digest("hex");
  }
}
