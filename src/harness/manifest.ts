// Fixture manifest. Every fixture is hash-bound together with the Spiral commit, the blob id of
// each imported model file, and the config files. A run verifies the whole manifest before it
// scores anything and refuses, naming the file, on the first mismatch.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { canonical, gitBlobId, sha256 } from "./json.ts";
import { cmp } from "./order.ts";

export const SPIRAL_URL = "https://github.com/patrickdugan/Spiral";
export const VENDOR_DIR = "vendor/spiral";
/** Reference-model files imported from the vendored checkout. Never modified. */
export const MODEL_FILES = ["model/escrow.ts", "model/ledger.ts", "model/registry.ts", "model/server.ts"] as const;
export const CONFIG_FILES = ["config/placement.json", "config/protocol.json"] as const;

export interface FixtureEntry {
  path: string;
  family: string;
  seed: number;
  generator: string;
  sha256: string;
}

export interface Manifest {
  version: string;
  spiral: { url: string; commit: string; model_blobs: { [path: string]: string } };
  config: { [path: string]: string };
  fixtures: FixtureEntry[];
}

export class ManifestError extends Error {
  readonly file: string;
  constructor(file: string, detail: string) {
    super(`manifest check failed for ${file}: ${detail}`);
    this.name = "ManifestError";
    this.file = file;
  }
}

/** Commit of the vendored checkout, read from .git without invoking git. */
export function vendoredCommit(root: string): string {
  const gitDir = join(root, VENDOR_DIR, ".git");
  const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
  if (!head.startsWith("ref: ")) return head;
  const ref = head.slice(5);
  if (existsSync(join(gitDir, ref))) return readFileSync(join(gitDir, ref), "utf8").trim();
  for (const line of readFileSync(join(gitDir, "packed-refs"), "utf8").split("\n")) {
    const [hash, name] = line.trim().split(" ");
    if (name === ref && hash) return hash;
  }
  throw new ManifestError(VENDOR_DIR, `cannot resolve ${ref}`);
}

export function modelBlobs(root: string): { [path: string]: string } {
  const out: { [path: string]: string } = {};
  for (const file of MODEL_FILES) out[file] = gitBlobId(readFileSync(join(root, VENDOR_DIR, file)));
  return out;
}

export function fileSha256(root: string, path: string): string {
  return sha256(readFileSync(join(root, path)));
}

export function buildManifest(root: string, version: string, commit: string, fixtures: FixtureEntry[]): Manifest {
  const config: { [path: string]: string } = {};
  for (const file of CONFIG_FILES) config[file] = fileSha256(root, file);
  return {
    version,
    spiral: { url: SPIRAL_URL, commit, model_blobs: modelBlobs(root) },
    config,
    fixtures: [...fixtures].sort((a, b) => cmp(a.path, b.path)),
  };
}

export const manifestHash = (manifest: Manifest): string => sha256(canonical(manifest));

export function readManifest(root: string, path = "fixtures/manifest.json"): Manifest {
  return JSON.parse(readFileSync(join(root, path), "utf8")) as Manifest;
}

/** Recompute every bound hash. Throws ManifestError on the first mismatch. */
export function verifyManifest(root: string, manifest: Manifest): void {
  const commit = vendoredCommit(root);
  if (commit !== manifest.spiral.commit) {
    throw new ManifestError(VENDOR_DIR, `checkout is at ${commit}, manifest pins ${manifest.spiral.commit}`);
  }
  const blobs = modelBlobs(root);
  for (const file of Object.keys(manifest.spiral.model_blobs).sort(cmp)) {
    if (blobs[file] !== manifest.spiral.model_blobs[file]) {
      throw new ManifestError(`${VENDOR_DIR}/${file}`, "model file differs from the pinned blob");
    }
  }
  for (const file of Object.keys(manifest.config).sort(cmp)) {
    if (fileSha256(root, file) !== manifest.config[file]) throw new ManifestError(file, "config hash mismatch");
  }
  for (const entry of manifest.fixtures) verifyFixture(root, entry);
}

export function verifyFixture(root: string, entry: FixtureEntry): void {
  const full = join(root, entry.path);
  if (!existsSync(full)) throw new ManifestError(entry.path, "fixture is missing");
  if (sha256(readFileSync(full)) !== entry.sha256) throw new ManifestError(entry.path, "fixture hash mismatch");
}

/** Load a fixture only if it is listed in the manifest and its bytes match. */
export function loadFixture<T>(root: string, manifest: Manifest, path: string): T {
  const entry = manifest.fixtures.find((f) => f.path === path);
  if (!entry) throw new ManifestError(path, "fixture is not listed in the manifest");
  verifyFixture(root, entry);
  return JSON.parse(readFileSync(join(root, path), "utf8")) as T;
}
