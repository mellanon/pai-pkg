/**
 * arc#373 defect B — a failed postinstall must not leave an orphaned,
 * un-removable clone.
 *
 * The DB row is the LAST step of a single-package install (it commits only after
 * postinstall succeeds), and completeInstallTransaction's rollback unwinds
 * symlinks/hooks/launchd but NOT the cloned repo. So before this fix, a failing
 * postinstall left the clone on disk with no DB row: `arc remove <pkg>` reported
 * "not installed" and the tester had to `rm` the clone by hand.
 *
 * The fix rolls the clone back on the transaction-failure exit, matching every
 * other failure path in installPackage. Driven end-to-end through the real
 * install() with a postinstall script that exits non-zero.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync } from "fs";
import { join } from "path";
import {
  createTestEnv,
  createMockSkillRepo,
  type TestEnv,
} from "../helpers/test-env.js";
import { install } from "../../src/commands/install.js";
import { remove } from "../../src/commands/remove.js";
import { getSkill } from "../../src/lib/db.js";

let env: TestEnv;

beforeEach(async () => {
  env = await createTestEnv();
});

afterEach(async () => {
  await env.cleanup();
});

const FAILING_POSTINSTALL = "#!/usr/bin/env bash\necho 'postinstall boom' >&2\nexit 1\n";

describe("install rollback on postinstall failure (arc#373 defect B)", () => {
  test("a failing postinstall leaves NO orphaned clone and NO DB row", async () => {
    const repo = await createMockSkillRepo(env.root, {
      name: "PostinstallFail",
      scripts: {
        postinstall: { path: "scripts/postinstall.sh", content: FAILING_POSTINSTALL },
      },
    });

    const result = await install({
      arc: env.arc,
      host: env.host,
      db: env.db,
      repoUrl: repo.url,
      yes: true,
    });

    // Install fails, surfacing the postinstall failure.
    expect(result.success).toBe(false);
    expect(result.error ?? "").toContain("Postinstall");

    // The clone is rolled back — no orphan under repos/ (the field-test symptom).
    expect(existsSync(join(env.arc.reposDir, "mock-PostinstallFail"))).toBe(false);

    // The skill symlink is unwound and no DB row was committed.
    expect(existsSync(join(env.host.paths.skillsDir, "PostinstallFail"))).toBe(false);
    expect(getSkill(env.db, "PostinstallFail")).toBeNull();
  });

  test("no manual `rm` needed: the failed install left removable/rolled-back state", async () => {
    const repo = await createMockSkillRepo(env.root, {
      name: "PostinstallFail2",
      scripts: {
        postinstall: { path: "scripts/postinstall.sh", content: FAILING_POSTINSTALL },
      },
    });

    const installResult = await install({
      arc: env.arc,
      host: env.host,
      db: env.db,
      repoUrl: repo.url,
      yes: true,
    });
    expect(installResult.success).toBe(false);

    // Acceptance: after a failed postinstall the state is clean. There is nothing
    // for `arc remove` to find (rolled back), which is the removable outcome the
    // issue asks for — the alternative to a hand `rm`. remove() reports the
    // package as not installed BECAUSE the clone + row are already gone, not
    // because an orphan is stranded on disk.
    const removeResult = await remove(env.db, env.arc, env.host, "PostinstallFail2", { yes: true });
    expect(removeResult.success).toBe(false);
    expect(existsSync(join(env.arc.reposDir, "mock-PostinstallFail2"))).toBe(false);
  });

  test("control: the same package installs cleanly with a passing postinstall", async () => {
    const repo = await createMockSkillRepo(env.root, {
      name: "PostinstallOk",
      scripts: {
        postinstall: { path: "scripts/postinstall.sh", content: "#!/usr/bin/env bash\nexit 0\n" },
      },
    });

    const result = await install({
      arc: env.arc,
      host: env.host,
      db: env.db,
      repoUrl: repo.url,
      yes: true,
    });

    expect(result.success).toBe(true);
    expect(existsSync(join(env.arc.reposDir, "mock-PostinstallOk"))).toBe(true);
    expect(getSkill(env.db, "PostinstallOk")).not.toBeNull();
  });
});
