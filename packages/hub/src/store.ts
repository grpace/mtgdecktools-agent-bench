/**
 * Bundle store: immutable, content-addressed (sha256) blobs. A directory today; the interface is small so
 * an S3/R2 implementation can replace it (put is idempotent, get by digest, no overwrite, no delete except
 * an explicit takedown purge).
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface BundleStore {
  /** Store bytes; returns their sha256. Storing the same bytes twice is a no-op. */
  put(data: Buffer): Promise<string>;
  get(sha256: string): Promise<Buffer>;
  has(sha256: string): Promise<boolean>;
  /** Where the blob lives (for logs and the README); opaque. */
  locate(sha256: string): string;
  /** Takedown only: remove the blob for good. */
  purge(sha256: string): Promise<void>;
}

export const sha256 = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');
const DIGEST = /^[0-9a-f]{64}$/;

export class FsBundleStore implements BundleStore {
  constructor(readonly root: string) {
    mkdirSync(root, { recursive: true });
  }

  locate(digest: string): string {
    if (!DIGEST.test(digest)) throw new Error(`not a sha256: ${digest}`);
    return join(this.root, digest.slice(0, 2), `${digest}.blob`);
  }

  async put(data: Buffer): Promise<string> {
    const digest = sha256(data);
    const path = this.locate(digest);
    if (existsSync(path) && statSync(path).size === data.length) return digest;
    mkdirSync(join(this.root, digest.slice(0, 2)), { recursive: true });
    const tmp = `${path}.tmp-${randomBytes(4).toString('hex')}`;
    writeFileSync(tmp, data, { mode: 0o444 });
    renameSync(tmp, path);
    return digest;
  }

  async get(digest: string): Promise<Buffer> {
    const data = readFileSync(this.locate(digest));
    if (sha256(data) !== digest) throw new Error(`bundle store corruption: ${digest} does not match its content`);
    return data;
  }

  async has(digest: string): Promise<boolean> {
    return existsSync(this.locate(digest));
  }

  async purge(digest: string): Promise<void> {
    rmSync(this.locate(digest), { force: true });
  }
}
