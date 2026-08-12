import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { discoverAgentsFiles, discoverSystemFile } from "./discovery.js";

describe("discoverAgentsFiles", () => {
  const previousHome = process.env.HOME;
  afterEach(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  });

  it("collects AGENTS.md from cwd to repo root, then global", async () => {
    const root = await mkdtemp(join(tmpdir(), "agents-discover-"));
    const sub = join(root, "pkg", "src");
    await mkdir(sub, { recursive: true });
    await writeFile(join(root, "AGENTS.md"), "root rules");
    await writeFile(join(sub, "AGENTS.md"), "nested rules");

    const files = discoverAgentsFiles(sub);
    expect(files.map((f) => f.content)).toEqual(["root rules", "nested rules"]);
    expect(files[1].path).toBe(join(sub, "AGENTS.md"));
  });

  it("orders global, root, then deepest instructions", async () => {
    const home = await mkdtemp(join(tmpdir(), "agents-home-"));
    const root = await mkdtemp(join(tmpdir(), "agents-order-"));
    const sub = join(root, "pkg");
    process.env.HOME = home;
    await mkdir(join(home, ".reever"), { recursive: true });
    await mkdir(join(root, ".git"));
    await mkdir(sub);
    await writeFile(join(home, ".reever", "AGENTS.md"), "global rules");
    await writeFile(join(root, "AGENTS.md"), "root rules");
    await writeFile(join(sub, "AGENTS.md"), "nested rules");

    expect(discoverAgentsFiles(sub).map((file) => file.content)).toEqual([
      "global rules",
      "root rules",
      "nested rules",
    ]);
    await rm(home, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  });
});

describe("discoverSystemFile", () => {
  it("returns the closest SYSTEM.md walking up from cwd", async () => {
    const root = await mkdtemp(join(tmpdir(), "system-discover-"));
    const sub = join(root, "a", "b");
    await mkdir(sub, { recursive: true });
    await writeFile(join(root, "SYSTEM.md"), "root system");
    await writeFile(join(sub, "SYSTEM.md"), "nested system");

    const file = discoverSystemFile(sub);
    expect(file?.content).toBe("nested system");
  });
});
