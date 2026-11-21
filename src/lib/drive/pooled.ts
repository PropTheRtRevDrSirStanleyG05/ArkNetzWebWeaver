// ArkNetzWebWeaver — Pooled Drive (thread turns 45 + 46).
// Unified multi-account view: every linked private vault repo in one
// folder tree, available space per backend, and per-account binding so
// a file or backup never lands in the wrong account's vault. Vaults
// follow the AccountKeyring shape (see types.ts); the accounts phase
// owns the real keyring.

import type { VaultManager } from "./drive.js";
import type { PooledDriveView, PooledEntry, VaultBackend, VaultFile, VaultUsage } from "./types.js";

export interface PooledVault {
  manager: VaultManager;
  backend: VaultBackend;
  /** Keyring account id that owns this vault. */
  accountId: string;
}

export class PooledDrive {
  private readonly vaults: PooledVault[];

  constructor(vaults: PooledVault[]) {
    this.vaults = [...vaults];
  }

  get vaultCount(): number {
    return this.vaults.length;
  }

  /** All vaults, with per-backend usage + pooled totals. */
  async view(): Promise<PooledDriveView> {
    const usages: VaultUsage[] = [];
    for (const vault of this.vaults) usages.push(await vault.manager.usage());
    const totalUsedBytes = usages.reduce((sum, u) => sum + u.usedBytes, 0);
    const totalQuotaBytes = usages.reduce((sum, u) => sum + u.quotaBytes, 0);
    const totalFiles = usages.reduce((sum, u) => sum + u.fileCount, 0);
    const byAccountMap = new Map<string, VaultUsage[]>();
    for (const usage of usages) {
      const accountId = usage.backend.accountId;
      const list = byAccountMap.get(accountId) ?? [];
      list.push(usage);
      byAccountMap.set(accountId, list);
    }
    const byAccount = [...byAccountMap.entries()].map(([accountId, vaultUsages]) => ({
      accountId,
      accountLabel: accountId,
      vaults: vaultUsages,
    }));
    return { vaults: usages, totalUsedBytes, totalQuotaBytes, totalFiles, byAccount };
  }

  /** The vault for one account + backend kind. Throws when the account
   *  has no vault there — the caller must offer to create one, never
   *  silently fall back to another account's vault. */
  vaultForAccount(accountId: string, kind?: VaultBackend["kind"]): PooledVault {
    const found = this.vaults.find(
      (v) => v.accountId === accountId && (kind === undefined || v.backend.kind === kind),
    );
    if (!found) {
      throw new Error(
        `no vault is bound to account "${accountId}"${kind ? ` on ${kind}` : ""} — create one for that account first; files are never stored in another account's vault`,
      );
    }
    return found;
  }

  /** Search every vault by name (decrypted names only, client-side). */
  async searchAll(query: string): Promise<PooledEntry[]> {
    const out: PooledEntry[] = [];
    for (const vault of this.vaults) {
      const files = await vault.manager.search(query);
      for (const file of files) {
        out.push({ file, vault: vault.backend, accountId: vault.accountId });
      }
    }
    return out;
  }

  /** Every vault's root folder, tagged with its home vault + account —
   *  the unified folder tree's top level. */
  async listAllRoots(): Promise<Array<{ vault: VaultBackend; accountId: string; files: VaultFile[] }>> {
    const out: Array<{ vault: VaultBackend; accountId: string; files: VaultFile[] }> = [];
    for (const vault of this.vaults) {
      out.push({ vault: vault.backend, accountId: vault.accountId, files: await vault.manager.listFolder(null) });
    }
    return out;
  }

  /** Upload into a specific account's vault. The account binding is
   *  enforced: the vault must belong to `accountId`, or the upload is
   *  refused — a backup never lands in the wrong account's vault. */
  async uploadToAccount(
    accountId: string,
    name: string,
    data: Uint8Array,
    parentId: string | null = null,
    mime = "application/octet-stream",
  ): Promise<{ file: VaultFile; vault: VaultBackend }> {
    const vault = this.vaultForAccount(accountId);
    const result = await vault.manager.uploadFile(name, data, parentId, mime);
    return { file: result.file, vault: vault.backend };
  }

  /** Free space per backend, for the "where should this file go?"
   *  choice. Vaults already over their soft quota are listed last. */
  async spaceByBackend(): Promise<Array<{ backend: VaultBackend; freeBytes: number; usedRatio: number }>> {
    const rows: Array<{ backend: VaultBackend; freeBytes: number; usedRatio: number }> = [];
    for (const vault of this.vaults) {
      const usage = await vault.manager.usage();
      rows.push({
        backend: vault.backend,
        freeBytes: Math.max(0, usage.quotaBytes - usage.usedBytes),
        usedRatio: usage.usedRatio,
      });
    }
    rows.sort((a, b) => a.usedRatio - b.usedRatio);
    return rows;
  }
}
