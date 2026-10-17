/**
 * InputTracker CLI entry point.
 *
 * Scaffold only: commands are added in later tasks.
 */

export function usage(): string {
  return [
    "inputtracker — personal input tracking",
    "",
    "Usage: it <command> [options]",
    "",
    "Commands will be added in later tasks.",
  ].join("\n");
}

if (import.meta.main) {
  console.log(usage());
  process.exit(0);
}
