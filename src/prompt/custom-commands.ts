import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join, relative } from "node:path";
import { findRepoRoot } from "./repo-root.js";

export interface CustomCommand {
  name: string;
  description: string;
  prompt: string;
  path: string;
  scope: "global" | "project";
}

function parseCommandFile(path: string, name: string, scope: CustomCommand["scope"]): CustomCommand {
  const raw = readFileSync(path, "utf8").trim();
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  let description = "Reusable prompt";
  let prompt = raw;
  if (match) {
    const line = match[1].split(/\r?\n/).find((entry) => /^description\s*:/i.test(entry));
    description = line?.replace(/^description\s*:\s*/i, "").replace(/^['"]|['"]$/g, "")
      || description;
    prompt = match[2].trim();
  }
  return { name, description, prompt, path, scope };
}

function scanCommands(dir: string, scope: CustomCommand["scope"]): CustomCommand[] {
  if (!existsSync(dir)) return [];
  const result: CustomCommand[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (entry.isFile() && extname(entry.name).toLowerCase() === ".md") {
        const rel = relative(dir, path).replace(/\\/g, "/").replace(/\.md$/i, "");
        result.push(parseCommandFile(path, rel.split("/").join(":"), scope));
      }
    }
  };
  walk(dir);
  return result;
}

/** Project commands override same-named global commands. */
export function discoverCustomCommands(cwd: string): CustomCommand[] {
  const root = findRepoRoot(cwd) ?? cwd;
  const byName = new Map<string, CustomCommand>();
  for (const command of scanCommands(join(homedir(), ".reever", "commands"), "global")) {
    byName.set(command.name, command);
  }
  for (const command of scanCommands(join(root, ".reever", "commands"), "project")) {
    byName.set(command.name, command);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function expandCustomCommand(command: CustomCommand, args: string): string {
  if (command.prompt.includes("{{args}}")) {
    return command.prompt.replaceAll("{{args}}", args);
  }
  return args ? `${command.prompt}\n\n${args}` : command.prompt;
}
