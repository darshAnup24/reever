/**
 * Hard cap on bytes captured from a single shell command. Beyond this the
 * workspace stops forwarding output and terminates the child (see
 * WorkspaceExecOptions.maxBuffer), bounding both memory and the context growth
 * that was exhausting explore subagents (#146, #183).
 */
export const MAX_COMMAND_OUTPUT_BYTES = 256 * 1024;

/**
 * Read-only discovery output is usually followed by a targeted read, so it has
 * a tighter ceiling than arbitrary build/test commands. 64 KiB is still
 * thousands of matches while avoiding a ~70K-token accidental repository dump.
 */
export const MAX_DISCOVERY_OUTPUT_BYTES = 64 * 1024;

/** Marker appended to command output that was cut short by the byte cap. */
export function truncationNote(bytes: number): string {
  return (
    `\n\n[output truncated at ${bytes} bytes — the command produced more. `
    + "Narrow it (add filters, a path, or pipe through head) to see the rest.]"
  );
}

/** Bound an already captured discovery result without splitting UTF-8 badly. */
export function truncateDiscoveryOutput(output: string): string {
  if (Buffer.byteLength(output, "utf8") <= MAX_DISCOVERY_OUTPUT_BYTES) return output;
  const clipped = Buffer.from(output, "utf8")
    .subarray(0, MAX_DISCOVERY_OUTPUT_BYTES)
    .toString("utf8")
    .replace(/\uFFFD$/, "");
  return clipped + truncationNote(MAX_DISCOVERY_OUTPUT_BYTES);
}
