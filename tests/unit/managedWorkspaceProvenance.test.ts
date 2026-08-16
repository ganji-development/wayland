/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  loadManagedWorkspaceProvenance,
  managedWorkspaceProvenanceLedgerPath,
  recordManagedWorkspaceProvenance,
  type ManagedWorkspaceProvenanceCodec,
} from '@/process/services/managedWorkspaceProvenance';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const INSTALLATION_ID = 'installation-a';
const codec: ManagedWorkspaceProvenanceCodec = {
  encrypt: (plaintext) => Buffer.from([...plaintext].toReversed().join(''), 'utf8').toString('base64'),
  decrypt: (ciphertext) => [...Buffer.from(ciphertext, 'base64').toString('utf8')].toReversed().join(''),
};

describe('managed workspace provenance', () => {
  let root: string;
  let authorityRoot: string;
  let workRoot: string;
  let workspace: string;

  async function creationIdentity() {
    // bigint + decimal strings: NTFS routinely issues file IDs above
    // Number.MAX_SAFE_INTEGER, which a number-typed identity cannot round-trip.
    const stat = await fs.lstat(workspace, { bigint: true });
    return {
      canonicalRoot: await fs.realpath(workRoot),
      canonicalPath: await fs.realpath(workspace),
      device: stat.dev.toString(),
      inode: stat.ino.toString(),
    };
  }

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'wayland-provenance-'));
    authorityRoot = path.join(root, 'authority');
    workRoot = path.join(root, 'work');
    workspace = path.join(workRoot, 'claude-temp-1736900000000');
    await fs.mkdir(workspace, { recursive: true });
  });

  /**
   * Replace `workspace` with a directory that is genuinely a different object.
   *
   * `rm` then `mkdir` at the same path is NOT enough. Linux hands the freed
   * inode straight back, so the replacement is indistinguishable from the
   * original and the identity checks under test never trip; macOS APFS never
   * reuses an inode. Measured 3/3 reused on ubuntu and 3/3 fresh on APFS, which
   * is exactly why these two cases passed locally and failed only on ubuntu.
   *
   * Creating the successor while the original still exists guarantees a distinct
   * inode, and a rename preserves the inode it was created with, so this holds
   * on every filesystem.
   */
  async function replaceWorkspaceWithDistinctDirectory(): Promise<void> {
    const successor = `${workspace}.successor`;
    await fs.mkdir(successor);
    await fs.rm(workspace, { recursive: true });
    await fs.rename(successor, workspace);
  }

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('records and reloads an encrypted installation-bound filesystem identity', async () => {
    const recorded = await recordManagedWorkspaceProvenance(
      {
        authorityRoot,
        workRoot,
        workspace,
        installationId: INSTALLATION_ID,
        creationIdentity: await creationIdentity(),
        createdAtMs: 123,
      },
      codec
    );
    const loaded = await loadManagedWorkspaceProvenance(authorityRoot, INSTALLATION_ID, codec);

    expect(loaded).toEqual({ state: 'complete', records: [recorded], errors: [] });
    expect(recorded).toMatchObject({
      installationId: INSTALLATION_ID,
      canonicalRoot: await fs.realpath(workRoot),
      canonicalPath: await fs.realpath(workspace),
      createdAtMs: 123,
    });
    const ciphertext = await fs.readFile(managedWorkspaceProvenanceLedgerPath(authorityRoot), 'utf8');
    expect(ciphertext).not.toContain(INSTALLATION_ID);
    expect(ciphertext).not.toContain(workspace);
  });

  it('rejects a copied ledger from another installation', async () => {
    await recordManagedWorkspaceProvenance(
      {
        authorityRoot,
        workRoot,
        workspace,
        installationId: INSTALLATION_ID,
        creationIdentity: await creationIdentity(),
      },
      codec
    );
    await expect(loadManagedWorkspaceProvenance(authorityRoot, 'installation-b', codec)).resolves.toMatchObject({
      state: 'error',
      records: [],
    });
  });

  it('rejects path reuse when the directory identity changes', async () => {
    const originalIdentity = await creationIdentity();
    await recordManagedWorkspaceProvenance(
      { authorityRoot, workRoot, workspace, installationId: INSTALLATION_ID, creationIdentity: originalIdentity },
      codec
    );
    await replaceWorkspaceWithDistinctDirectory();
    // Prove the premise instead of trusting the filesystem to provide it.
    expect((await fs.lstat(workspace, { bigint: true })).ino.toString()).not.toBe(originalIdentity.inode);

    await expect(
      recordManagedWorkspaceProvenance(
        { authorityRoot, workRoot, workspace, installationId: INSTALLATION_ID, creationIdentity: originalIdentity },
        codec
      )
    ).rejects.toThrow('MANAGED_WORKSPACE_PROVENANCE_UNSAFE_TARGET');
  });

  it('rejects a successor identity even when it reuses the created pathname', async () => {
    const recorded = await recordManagedWorkspaceProvenance(
      {
        authorityRoot,
        workRoot,
        workspace,
        installationId: INSTALLATION_ID,
        creationIdentity: await creationIdentity(),
      },
      codec
    );
    await replaceWorkspaceWithDistinctDirectory();
    // Must be the same SHAPE on both sides: a number vs a decimal string is
    // never equal, so this would pass even when the inode had not changed.
    expect((await fs.lstat(workspace, { bigint: true })).ino.toString()).not.toBe(recorded.inode);

    await expect(
      recordManagedWorkspaceProvenance(
        {
          authorityRoot,
          workRoot,
          workspace,
          installationId: INSTALLATION_ID,
          creationIdentity: await creationIdentity(),
        },
        codec
      )
    ).rejects.toThrow('MANAGED_WORKSPACE_PROVENANCE_PATH_REUSED');
  });

  it('round-trips a filesystem identifier beyond Number.MAX_SAFE_INTEGER', async () => {
    // The defect this guards: NTFS issues file IDs above 2^53-1 (observed
    // 10414574139085076 against a 9007199254740991 ceiling). Stored as JSON
    // numbers such a record was WRITTEN and then rejected by its own parser on
    // load - MANAGED_WORKSPACE_PROVENANCE_INVALID_RECORD for a record that was
    // never invalid. Asserted at the serialization boundary rather than by hoping
    // the test filesystem hands out a large enough inode.
    const hugeInode = '10414574139085076';
    expect(Number.isSafeInteger(Number(hugeInode))).toBe(false);

    const identity = await creationIdentity();
    const recorded = await recordManagedWorkspaceProvenance(
      {
        authorityRoot,
        workRoot,
        workspace,
        installationId: INSTALLATION_ID,
        creationIdentity: identity,
        createdAtMs: 456,
      },
      codec
    );

    // Rewrite the sealed ledger with an oversize identifier and prove it reloads
    // byte-exactly instead of being rejected.
    const ledgerPath = managedWorkspaceProvenanceLedgerPath(authorityRoot);
    const ledger = JSON.parse(codec.decrypt(await fs.readFile(ledgerPath, 'utf8'))) as {
      records: Array<{ inode: string; device: string }>;
    };
    ledger.records[0].inode = hugeInode;
    await fs.writeFile(ledgerPath, codec.encrypt(JSON.stringify(ledger)));

    const loaded = await loadManagedWorkspaceProvenance(authorityRoot, INSTALLATION_ID, codec);
    expect(loaded.state).toBe('complete');
    expect(loaded.records[0]?.inode).toBe(hugeInode);
    expect(loaded.records[0]?.workspaceId).toBe(recorded.workspaceId);
  });

  it('rejects a filesystem identifier that is not canonical decimal', async () => {
    await recordManagedWorkspaceProvenance(
      { authorityRoot, workRoot, workspace, installationId: INSTALLATION_ID, creationIdentity: await creationIdentity() },
      codec
    );
    const ledgerPath = managedWorkspaceProvenanceLedgerPath(authorityRoot);
    const ledger = JSON.parse(codec.decrypt(await fs.readFile(ledgerPath, 'utf8'))) as {
      records: Array<{ inode: unknown }>;
    };
    // Leading zeros, signs, floats and non-numerics are all non-canonical: two
    // spellings of one identity would defeat the exact comparison this exists for.
    ledger.records[0].inode = '007';
    await fs.writeFile(ledgerPath, codec.encrypt(JSON.stringify(ledger)));

    await expect(loadManagedWorkspaceProvenance(authorityRoot, INSTALLATION_ID, codec)).resolves.toMatchObject({
      state: 'error',
      records: [],
      errors: ['MANAGED_WORKSPACE_PROVENANCE_INVALID_RECORD'],
    });
  });

  it('still reads a legacy record that stored identifiers as safe integers', async () => {
    // Ledgers written before the string migration hold JSON numbers. A safe
    // integer round-trips exactly, so it is normalized rather than rejected;
    // anything larger already lost precision on write and is refused above.
    await recordManagedWorkspaceProvenance(
      { authorityRoot, workRoot, workspace, installationId: INSTALLATION_ID, creationIdentity: await creationIdentity() },
      codec
    );
    const ledgerPath = managedWorkspaceProvenanceLedgerPath(authorityRoot);
    const ledger = JSON.parse(codec.decrypt(await fs.readFile(ledgerPath, 'utf8'))) as {
      records: Array<{ inode: unknown; device: unknown }>;
    };
    ledger.records[0].device = 66306;
    ledger.records[0].inode = 4325377;
    await fs.writeFile(ledgerPath, codec.encrypt(JSON.stringify(ledger)));

    const loaded = await loadManagedWorkspaceProvenance(authorityRoot, INSTALLATION_ID, codec);
    expect(loaded.state).toBe('complete');
    expect(loaded.records[0]?.device).toBe('66306');
    expect(loaded.records[0]?.inode).toBe('4325377');
  });

  it('fails closed for malformed ciphertext without returning partial records', async () => {
    await fs.mkdir(authorityRoot, { recursive: true });
    await fs.writeFile(managedWorkspaceProvenanceLedgerPath(authorityRoot), 'not-a-ledger');

    await expect(loadManagedWorkspaceProvenance(authorityRoot, INSTALLATION_ID, codec)).resolves.toMatchObject({
      state: 'error',
      records: [],
    });
  });
});
