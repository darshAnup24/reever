import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe("custom commands", () => {
  let root: string;
  let home: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "reever-command-project-"));
    home = mkdtempSync(join(tmpdir(), "reever-command-home-"));
    previousHome = process.env.HOME;
    process.env.HOME = home;
    mkdirSync(join(root, ".git"));
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it("discovers namespaced Markdown prompts", async () => {
    const dir = join(root, ".reever", "commands", "git");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "review.md"), "---\ndescription: Review changes\n---\nReview {{args}}");
    const { discoverCustomCommands } = await import("./custom-commands.js");
    expect(discoverCustomCommands(root)).toEqual([
      expect.objectContaining({ name: "git:review", description: "Review changes", scope: "project" }),
    ]);
  });

  it("lets project commands override global commands", async () => {
    const globalDir = join(home, ".reever", "commands");
    const localDir = join(root, ".reever", "commands");
    mkdirSync(globalDir, { recursive: true });
    mkdirSync(localDir, { recursive: true });
    writeFileSync(join(globalDir, "test.md"), "global");
    writeFileSync(join(localDir, "test.md"), "project");
    const { discoverCustomCommands } = await import("./custom-commands.js");
    expect(discoverCustomCommands(root)[0]).toMatchObject({ prompt: "project", scope: "project" });
  });

  it("expands arguments safely as prompt text", async () => {
    const { expandCustomCommand } = await import("./custom-commands.js");
    const command = { name: "fix", description: "", prompt: "Fix: {{args}}", path: "x", scope: "project" as const };
    expect(expandCustomCommand(command, "the parser")).toBe("Fix: the parser");
  });
});
