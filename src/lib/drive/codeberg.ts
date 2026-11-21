// ArkNetzWebWeaver — Codeberg vault client (cb:).
// Codeberg runs Forgejo, whose Contents API is GitHub-compatible, so
// this client is the shared GitContentsClient pointed at Codeberg's API
// base. 750 MiB Git storage per free account — the smallest vault, best
// as a mirror (thread turn 46). No network call without injected fetch.

import { GitContentsClient } from "./github.js";
import type { GitContentsClientOptions } from "./github.js";

export class CodebergVaultClient extends GitContentsClient {
  override readonly kind = "cb" as const;

  constructor(opts: Omit<GitContentsClientOptions, "apiBase">) {
    super({ ...opts, apiBase: "https://codeberg.org/api/v1" });
  }
}
