#!/usr/bin/env python3
"""Apply one source mutation, run the suite, report whether it reddened.

Card 6bf13a5c's scoring rule, which is the whole point of the sweep:

    A. delete the mechanism the test names           -> often RED, looks pinned
    B. delete it AND make an earlier producer fire   -> GREEN is the defect

A mutation is a (file, old_text, new_text) triple. The runner refuses if
old_text is absent or appears more than once, so a mutation that silently
applied nowhere cannot be scored as "the tests caught it".

It also restores the file in a finally block, because a mutation left in the
tree is the next run's phantom failure.
"""

import json
import subprocess
import sys
from pathlib import Path

# The repository this scorer belongs to, found from the scorer's own location.
# NOT an absolute path to wherever it was first written: a scorer pinned to a
# path outside its own checkout dies in `subprocess` the moment that directory
# goes away, and then exits non-zero for a reason that has nothing to do with
# the code it claims to be scoring.
ROOT = Path(__file__).resolve().parent.parent
PLAN_DIRECTORY = ROOT / "scripts" / "failure-value-plans"


def run_suite(test_files):
    command = ["npx", "vitest", "run", "--reporter=dot", *test_files]
    finished = subprocess.run(
        command, cwd=ROOT, capture_output=True, text=True, timeout=600
    )
    return finished.returncode, finished.stdout + finished.stderr


def apply_mutation(mutation):
    """Returns a restore callable. Raises if the mutation does not apply cleanly."""
    edits = mutation["edits"]
    originals = {}
    for edit in edits:
        path = ROOT / edit["file"]
        text = path.read_text()
        originals.setdefault(str(path), text)
    try:
        for edit in edits:
            path = ROOT / edit["file"]
            text = path.read_text()
            occurrences = text.count(edit["old"])
            if occurrences != 1:
                raise RuntimeError(
                    f"{edit['file']}: pattern occurs {occurrences} times, need exactly 1:\n"
                    f"  {edit['old'][:120]!r}"
                )
            path.write_text(text.replace(edit["old"], edit["new"]))
    except Exception:
        for filename, text in originals.items():
            Path(filename).write_text(text)
        raise

    def restore():
        for filename, text in originals.items():
            Path(filename).write_text(text)

    return restore


def score(mutation):
    restore = apply_mutation(mutation)
    try:
        code, output = run_suite(mutation["tests"])
    finally:
        restore()
    caught = code != 0
    failing = [
        line.strip()
        for line in output.splitlines()
        if line.strip().startswith(("×", "FAIL", "AssertionError"))
    ]
    return {
        "id": mutation["id"],
        "kind": mutation["kind"],
        "describes": mutation["describes"],
        "plan": mutation["plan"],
        "caught": caught,
        "exit": code,
        "failing": failing[:14],
    }


def load_plans(arguments):
    """Every mutation named on the command line, or the whole plan directory."""
    paths = [Path(a) for a in arguments] if arguments else sorted(PLAN_DIRECTORY.glob("*.json"))
    if not paths:
        raise SystemExit(f"no plans: {PLAN_DIRECTORY} is empty and none were named")
    plan = []
    for path in paths:
        if not path.is_absolute():
            path = (ROOT / path) if not path.exists() else path
        for mutation in json.loads(path.read_text()):
            mutation["plan"] = path.stem
            mutation["id"] = f"{path.stem}/{mutation['id']}"
            plan.append(mutation)
    return plan


def self_test():
    """Check the two properties the run's honesty rests on, in both directions.

    Neither needs vitest, and both are the parts that fail silently: a mutation
    that quietly applied nowhere would be scored as "the tests caught it", and a
    mutation left behind in the tree would redden the next run for no reason.
    """
    failures = []

    def check(description, actual, expected):
        if actual != expected:
            failures.append(f"{description}: expected {expected!r}, got {actual!r}")

    scratch = ROOT / "scripts" / ".self-test-scratch.txt"
    scratch.write_text("alpha\nbeta\nalpha\n")
    try:
        # Applies exactly once -> accepted, and restores afterwards.
        restore = apply_mutation({"edits": [{"file": str(scratch.relative_to(ROOT)), "old": "beta", "new": "GAMMA"}]})
        check("a unique pattern is applied", "GAMMA" in scratch.read_text(), True)
        restore()
        check("restore puts the file back", scratch.read_text(), "alpha\nbeta\nalpha\n")

        # Two occurrences -> refused, because which one was meant is unknown.
        for pattern, occurrences in (("alpha", 2), ("nowhere", 0)):
            try:
                apply_mutation({"edits": [{"file": str(scratch.relative_to(ROOT)), "old": pattern, "new": "X"}]})
                failures.append(f"a pattern occurring {occurrences} times was accepted")
            except RuntimeError:
                pass
            check(f"the tree is untouched after refusing {pattern!r}", scratch.read_text(), "alpha\nbeta\nalpha\n")

        # A multi-file mutation whose SECOND edit does not apply must roll the
        # first one back, or the run strands a half-applied mutation.
        other = ROOT / "scripts" / ".self-test-scratch-2.txt"
        other.write_text("delta\n")
        try:
            apply_mutation({"edits": [
                {"file": str(scratch.relative_to(ROOT)), "old": "beta", "new": "GAMMA"},
                {"file": str(other.relative_to(ROOT)), "old": "nowhere", "new": "X"},
            ]})
            failures.append("a half-applicable multi-file mutation was accepted")
        except RuntimeError:
            pass
        check("the first edit was rolled back", scratch.read_text(), "alpha\nbeta\nalpha\n")
        other.unlink()
    finally:
        scratch.unlink(missing_ok=True)

    for line in failures:
        print(f"SELF-TEST FAILED: {line}")
    if failures:
        return 1
    print("self-test passed: 7 checks, both directions")
    return 0


def main():
    if "--self-test" in sys.argv:
        return self_test()
    plan = load_plans(sys.argv[1:])
    results = []
    for mutation in plan:
        try:
            result = score(mutation)
        except RuntimeError as error:
            result = {
                "id": mutation["id"],
                "plan": mutation["plan"],
                "kind": mutation["kind"],
                "describes": mutation["describes"],
                "caught": None,
                "error": str(error),
            }
        results.append(result)
        mark = {True: "CAUGHT   ", False: "UNNOTICED", None: "DID-NOT-APPLY"}[
            result["caught"]
        ]
        print(f"{mark}  [{result['kind']}] {result['id']}: {result['describes']}")
        if result["caught"] is None:
            print(f"            {result['error'].splitlines()[0]}")
        sys.stdout.flush()

    Path(ROOT / "mutation-results.json").write_text(json.dumps(results, indent=2))

    # A control is not a hole, and counting it as one is how a scorer ends up
    # reporting a defect on every clean run. CONTROL-NEGATIVE is SUPPOSED to go
    # unnoticed; CONTROL-POSITIVE is supposed to be caught. Both are statements
    # about whether the run measured anything, so they are judged, not tallied.
    real = [r for r in results if r["kind"] != "control"]

    unnoticed = [r for r in real if r["caught"] is False]
    broken = [r for r in results if r["caught"] is None]
    print(
        f"\n{len(real)} real mutations: "
        f"{sum(1 for r in real if r['caught'] is True)} caught, "
        f"{len(unnoticed)} UNNOTICED, {len(broken)} did not apply"
    )

    # Controls are judged per plan, not pooled. Each plan carries its own pair,
    # and a plan whose controls misbehaved has measured nothing -- pooling them
    # would let one plan's healthy pair vouch for another plan's broken run.
    misbehaved = []
    plans = sorted({r["plan"] for r in results})
    for plan_name in plans:
        controls = {
            r["id"].split("/", 1)[1]: r
            for r in results
            if r["plan"] == plan_name and r["kind"] == "control"
        }
        if not controls:
            misbehaved.append(f"{plan_name}: no controls, so the run vouches for nothing")
            continue
        positive = controls.get("CONTROL-POSITIVE")
        if positive is None or positive["caught"] is not True:
            misbehaved.append(f"{plan_name}: CONTROL-POSITIVE was not caught -- the suite never ran")
        negative = controls.get("CONTROL-NEGATIVE")
        if negative is None or negative["caught"] is not False:
            misbehaved.append(
                f"{plan_name}: CONTROL-NEGATIVE was caught -- the suite is red for a reason "
                "unrelated to any mutation"
            )
    for line in misbehaved:
        print(f"CONTROL FAILED: {line}")
    if not misbehaved:
        print(f"controls behaved in all {len(plans)} plans")

    # Exit status answers "did this run measure a hole", not "did it like what it
    # found". A mutation that never applied, and a control that misbehaved, both
    # mean the run did not measure -- which is not the same as finding nothing,
    # but is equally not a pass.
    return 1 if (unnoticed or broken or misbehaved) else 0


if __name__ == "__main__":
    sys.exit(main())
