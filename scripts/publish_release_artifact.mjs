#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { copyFile, lstat, mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

function required(env, name, pattern) {
  const value = env[name];
  if (typeof value !== "string" || !value || (pattern && !pattern.test(value))) {
    throw new Error(`${name} is missing or invalid`);
  }
  return value;
}

export function releaseCoordinates({ repository, sourceCommit, artifactSha256 }) {
  if (!/^[^/]+\/[^/]+$/.test(repository)) {
    throw new Error("GitHub repository must use owner/name format");
  }
  if (!/^[0-9a-f]{40}$/.test(sourceCommit)) {
    throw new Error("source commit must be a lowercase 40-character SHA");
  }
  if (!/^[0-9a-f]{64}$/.test(artifactSha256)) {
    throw new Error("artifact digest must be a lowercase SHA-256");
  }

  const tag = `delivery-${sourceCommit}-${artifactSha256}`;
  const asset = `MangaOrganizer-${artifactSha256}.exe`;
  return {
    tag,
    asset,
    artifactRef: `github-release://${repository}/${tag}/${asset}`,
  };
}

function runGh(args, { allowFailure = false } = {}) {
  const result = spawnSync("gh", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (!allowFailure && result.status !== 0) {
    throw new Error(
      String(result.stderr || result.stdout || `gh exited ${result.status}`).trim(),
    );
  }
  return {
    status: result.status,
    stdout: String(result.stdout || ""),
    stderr: String(result.stderr || ""),
  };
}

function verifyPublishedRelease({
  executeGh,
  repository,
  coordinates,
  sourceCommit,
  artifactSha256,
  artifactSize,
}) {
  const publishedResult = executeGh([
    "api",
    `repos/${repository}/releases/tags/${coordinates.tag}`,
    "-H",
    "X-GitHub-Api-Version: 2026-03-10",
  ]);
  const release = JSON.parse(publishedResult.stdout);
  if (release.tag_name !== coordinates.tag) {
    throw new Error(`unexpected delivery tag: ${release.tag_name}`);
  }
  if (release.target_commitish !== sourceCommit) {
    throw new Error("delivery release target commit does not match");
  }
  if (release.draft || !release.prerelease) {
    throw new Error("delivery release must be an immutable prerelease");
  }
  const asset = (release.assets || []).find((item) => item.name === coordinates.asset);
  if (!asset) throw new Error(`delivery asset is missing: ${coordinates.asset}`);
  if (asset.state !== "uploaded") throw new Error("delivery asset is not uploaded");
  if (Number(asset.size) !== Number(artifactSize)) {
    throw new Error("delivery asset size does not match local evidence");
  }
  const digest = String(asset.digest || "").toLowerCase();
  if (digest && digest !== `sha256:${artifactSha256}`) {
    throw new Error("delivery asset digest does not match local evidence");
  }
  return release;
}

async function sha256File(path) {
  const handle = await open(path, constants.O_RDONLY);
  try {
    const hash = createHash("sha256");
    for await (const chunk of handle.createReadStream()) hash.update(chunk);
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

async function main(env = process.env) {
  const artifactPath = required(env, "ENGINEERING_DELIVERY_ARTIFACT_PATH");
  const artifactSha256 = required(
    env,
    "ENGINEERING_DELIVERY_ARTIFACT_SHA256",
    /^[0-9a-f]{64}$/,
  );
  const artifactSize = Number(
    required(env, "ENGINEERING_DELIVERY_ARTIFACT_SIZE", /^[0-9]+$/),
  );
  const sourceCommit = required(
    env,
    "ENGINEERING_DELIVERY_SOURCE_COMMIT",
    /^[0-9a-f]{40}$/,
  );
  required(env, "ENGINEERING_DELIVERY_SOURCE_TREE", /^[0-9a-f]{40}$/);

  const stat = await lstat(artifactPath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("delivery artifact must be a regular file");
  }
  if (stat.size !== artifactSize) {
    throw new Error("delivery artifact size does not match measured evidence");
  }
  const digest = await sha256File(artifactPath);
  if (digest !== artifactSha256) {
    throw new Error("delivery artifact does not match measured evidence");
  }

  const repository = JSON.parse(
    runGh(["repo", "view", "--json", "nameWithOwner"]).stdout,
  ).nameWithOwner;
  const coordinates = releaseCoordinates({
    repository,
    sourceCommit,
    artifactSha256,
  });

  const existing = runGh(
    [
      "api",
      `repos/${repository}/releases/tags/${coordinates.tag}`,
      "-H",
      "X-GitHub-Api-Version: 2026-03-10",
    ],
    { allowFailure: true },
  );
  if (existing.status === 0) {
    verifyPublishedRelease({
      executeGh: runGh,
      repository,
      coordinates,
      sourceCommit,
      artifactSha256,
      artifactSize,
    });
    process.stdout.write(`${JSON.stringify({ artifactRef: coordinates.artifactRef })}\n`);
    return;
  }

  const tagCheck = runGh(
    ["api", `repos/${repository}/git/ref/tags/${coordinates.tag}`],
    { allowFailure: true },
  );
  if (tagCheck.status === 0) {
    throw new Error(`delivery tag already exists: ${coordinates.tag}`);
  }

  const uploadDirectory = await mkdtemp(join(tmpdir(), "manga-organizer-delivery-"));
  const uploadPath = join(uploadDirectory, coordinates.asset);
  try {
    await copyFile(artifactPath, uploadPath);
    runGh([
      "release",
      "create",
      coordinates.tag,
      uploadPath,
      "--repo",
      repository,
      "--target",
      sourceCommit,
      "--prerelease",
      "--title",
      coordinates.tag,
      "--notes",
      `Immutable delivery artifact for ${sourceCommit}`,
    ]);
  } finally {
    await rm(uploadDirectory, { recursive: true, force: true });
  }

  verifyPublishedRelease({
    executeGh: runGh,
    repository,
    coordinates,
    sourceCommit,
    artifactSha256,
    artifactSize,
  });
  process.stdout.write(`${JSON.stringify({ artifactRef: coordinates.artifactRef })}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => {
    console.error(`publish_release_artifact: ${error.message}`);
    process.exitCode = 1;
  });
}
