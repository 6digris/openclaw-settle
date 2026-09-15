#!/usr/bin/env python3
"""Temporary single-job evidence; canonical cache inputs and authority stay unchanged."""

import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time


SOURCE_SHA = "13198711efbe769c7ff090067a2be6d4a954340a"
ACTION_SHA256 = "d3d3dac08e45914f4470e7219c9b64caf0fd822b719cf2962fa6b2df24c6df38"
BUNDLE_SHA256 = "fbcad57b299a699a29f1c750949073d2b9c7ad4b3b742ca3355947f99fcf7e56"
PATTERNS = [
    "pnpm-lock.yaml", "pnpm-workspace.yaml", "**/package.json", "**/tsconfig*.json",
    "vitest.config.*", "test/vitest/**", "src/state/*.sql", "!**/node_modules/**",
]
ROOT = Path(os.environ["RUNNER_TEMP"]) / "transform-fingerprint-probe"
WORKSPACE = Path(os.environ["GITHUB_WORKSPACE"])


def save(name, value):
    ROOT.mkdir(parents=True, exist_ok=True)
    (ROOT / f"{name}.json").write_text(json.dumps(value, indent=2) + "\n")


def read(name):
    path = ROOT / f"{name}.json"
    return json.loads(path.read_text()) if path.is_file() else {}


def head(cwd=WORKSPACE):
    return subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=cwd, text=True).strip()


def attest_tooling():
    revision = head(Path.cwd())
    if revision != os.environ["PROBE_WORKFLOW_SHA"]:
        raise RuntimeError("tooling checkout does not match the dispatched workflow SHA")
    save("tooling", {"sha": revision, "ref": os.environ["GITHUB_REF"],
                     "helperSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest()})


def prepare():
    if head() != SOURCE_SHA:
        raise RuntimeError("source checkout does not match the reviewed main snapshot")
    action = WORKSPACE / ".github/actions/setup-node-env/action.yml"
    source = action.read_text()
    if hashlib.sha256(action.read_bytes()).hexdigest() != ACTION_SHA256:
        raise RuntimeError("canonical setup action differs from the reviewed owner")
    harness = WORKSPACE / ".ci-harness"
    if (WORKSPACE / ".probe-tooling").exists():
        raise RuntimeError("source checkout retained the separate tooling checkout")
    if harness.exists():
        raise RuntimeError("expected a clean source checkout without a retained harness")
    shutil.copytree(WORKSPACE / ".github/actions", harness / ".github/actions", symlinks=True)
    for relative in ["scripts/ios-screenshot-evidence.mjs", "scripts/lib/direct-run.mjs",
                     "scripts/lib/release-upgrade-baseline.mjs", "scripts/lib/release-version.mjs"]:
        target = harness / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(WORKSPACE / relative, target)
    exclude = Path(subprocess.check_output(
        ["git", "rev-parse", "--git-path", "info/exclude"], cwd=WORKSPACE, text=True).strip())
    if not exclude.is_absolute():
        exclude = WORKSPACE / exclude
    with exclude.open("a") as output:
        output.write("\n/.ci-harness/\n")

    # Only the disposable action copy gains observations; the late expression still owns its output.
    early_anchor = "    - name: Restore exact dependency cache\n"
    late_anchor = "    - name: Restore Vitest transform cache\n"
    for anchor in [early_anchor, late_anchor]:
        if source.count(anchor) != 1:
            raise RuntimeError("setup observation boundary is not unique")
    early = '''    - name: Observe fingerprint before dependency restore
      shell: bash
      run: python3 "$RUNNER_TEMP/transform-fingerprint-probe/helper.py" sample before

'''
    late = '''    - name: Observe fingerprint after restore and compare authority
      shell: bash
      env:
        PROBE_GENERATION: ${{ steps.vitest-cache-generation.outputs.value }}
        PROBE_DEPENDENCY_HIT: ${{ steps.dependency-cache.outputs.cache-hit }}
        PROBE_DEPENDENCY_KEY: ${{ steps.dependency-cache-key.outputs.key }}
        PROBE_DEPENDENCY_MATCHED_KEY: ${{ steps.dependency-cache.outputs.cache-matched-key }}
      run: python3 "$RUNNER_TEMP/transform-fingerprint-probe/helper.py" sample after

'''
    observed = source.replace(early_anchor, early + early_anchor).replace(late_anchor, late + late_anchor)
    (harness / ".github/actions/setup-node-env/action.yml").write_text(observed)
    save("source", {"sha": SOURCE_SHA, "actionSha256": ACTION_SHA256,
                    "observedActionSha256": hashlib.sha256(observed.encode()).hexdigest(),
                    "patterns": PATTERNS, "harness": "same-source sparse action/evidence/upgrade export"})


def installed_bundle():
    # Inspect this diagnostic's own ancestor chain; never search or attach to unrelated processes.
    pid = os.getpid()
    for _ in range(64):
        executable = Path(os.readlink(f"/proc/{pid}/exe"))
        if executable.name == "Runner.Worker":
            bundle = executable.parent / "hashFiles"
            if bundle.is_dir():
                bundle = bundle / "index.js"
            if hashlib.sha256(bundle.read_bytes()).hexdigest() != BUNDLE_SHA256:
                raise RuntimeError("installed runner hashFiles bundle identity is unrecognized")
            return bundle
        status = Path(f"/proc/{pid}/status").read_text()
        pid = int(re.search(r"^PPid:\s+(\d+)$", status, re.MULTILINE).group(1))
        if pid <= 1:
            break
    raise RuntimeError("cannot bind hashFiles to this job's Runner.Worker ancestor")


def sample(phase):
    row = {"status": "inconclusive", "phase": phase, "sourceSha": head(),
           "dependencyHit": os.environ.get("PROBE_DEPENDENCY_HIT"),
           "dependencyKey": os.environ.get("PROBE_DEPENDENCY_KEY"),
           "dependencyMatchedKey": os.environ.get("PROBE_DEPENDENCY_MATCHED_KEY"),
           "authoritativeGeneration": os.environ.get("PROBE_GENERATION"),
           "layout": {name: (WORKSPACE / name).is_dir() for name in
                      ["node_modules", ".cache/openclaw-pnpm-store", ".ci-harness"]}}
    try:
        if row["sourceSha"] != SOURCE_SHA:
            raise RuntimeError("source identity changed")
        bundle = installed_bundle()
        node = subprocess.check_output(["node", "-p", "process.execPath"], text=True).strip()
        row.update({"bundle": str(bundle), "bundleSha256": BUNDLE_SHA256,
                    "node": node, "nodeVersion": subprocess.check_output([node, "--version"], text=True).strip()})
        # Both diagnostic arms use setup's same resolved Node. The original expression may use
        # another runner-internal Node; its late digest remains the independent authority check.
        started = time.monotonic()
        result = subprocess.run([node, str(bundle)], cwd=WORKSPACE,
                                env={"PATH": os.environ["PATH"], "patterns": "\n".join(PATTERNS)},
                                text=True, capture_output=True, timeout=120)
        row["elapsedSeconds"] = time.monotonic() - started
        row["exitCode"] = result.returncode
        (ROOT / f"{phase}.stdout").write_text(result.stdout)
        (ROOT / f"{phase}.stderr").write_text(result.stderr)
        digest = re.findall(r"__OUTPUT__([a-f0-9]{64})__OUTPUT__", result.stderr)
        count = re.findall(r"Found (\d+) files to hash\.", result.stdout)
        files = [line[len(str(WORKSPACE)) + 1:] for line in result.stdout.splitlines()
                 if line.startswith(str(WORKSPACE) + os.sep) and Path(line).is_file()]
        if result.returncode or len(digest) != 1 or len(count) != 1 or int(count[0]) != len(files):
            raise RuntimeError("official bundle did not produce one complete ordered inventory and digest")
        row.update({"status": "observed", "digest": digest[0], "files": files})
    except Exception as error:
        row["reason"] = str(error)
    save(phase, row)
    print(f"Fingerprint {phase}: {row['status']}")


def finish():
    before, after = read("before"), read("after")
    reasons = []
    if before.get("status") != "observed" or after.get("status") != "observed":
        reasons.append("both complete official-bundle observations are required")
    else:
        for field in ["sourceSha", "bundleSha256", "node", "nodeVersion", "files", "digest"]:
            if before[field] != after[field]:
                reasons.append(f"before/after {field} differs")
        if after["digest"] != after["authoritativeGeneration"]:
            reasons.append("late diagnostic digest differs from original hashFiles authority")
        if before["layout"]["node_modules"] or before["layout"][".cache/openclaw-pnpm-store"]:
            reasons.append("early observation did not follow empty dependency cleanup")
        if not all(after["layout"].values()):
            reasons.append("expected restored dependency/store/harness layout is missing")
        if after["dependencyHit"] != "true" or not after["dependencyKey"] or after["dependencyKey"] != after["dependencyMatchedKey"]:
            reasons.append("the actual exact dependency archive did not restore successfully")
    if os.environ.get("PROBE_SETUP_OUTCOME") != "success":
        reasons.append("normal complete setup did not succeed")
    value = {"status": "inconclusive" if reasons else "parity-observed", "reasons": reasons,
             "sourceSha": SOURCE_SHA, "tooling": read("tooling"),
             "setupOutcome": os.environ.get("PROBE_SETUP_OUTCOME"),
             "beforeSeconds": before.get("elapsedSeconds"), "afterSeconds": after.get("elapsedSeconds"),
             "cacheWrites": False,
             "limits": ["A single native pair, not an aggregate speedup or whole-setup A/B.",
                        "Late diagnostic follows original hash evaluation and may benefit from warm filesystem caches.",
                        "Per-file diagnostics do not alter the authoritative cache key or restore policy."]}
    save("verdict", value)
    with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as summary:
        summary.write("## Transform fingerprint probe\n\n```json\n" + json.dumps(value, indent=2) + "\n```\n")
    print(json.dumps(value, indent=2))


if __name__ == "__main__":
    command = sys.argv[1]
    if command == "tooling":
        attest_tooling()
    elif command == "prepare":
        prepare()
    elif command == "sample" and sys.argv[2] in ["before", "after"]:
        sample(sys.argv[2])
    elif command == "finish":
        finish()
    else:
        raise SystemExit("expected tooling, prepare, sample before/after, or finish")
