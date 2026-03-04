/**
 * Whitelisted commands that are always allowed (exact match after trim).
 */
const ALLOWED_COMMANDS: string[] = [
  'npm test',
  'npm run build',
  'pnpm test',
  'pnpm build',
  'pytest',
  'go test ./...',
];

/**
 * Blacklisted command patterns -- if any pattern matches the command string,
 * the command is unconditionally blocked.
 */
const BLOCKED_PATTERNS: RegExp[] = [
  /\brm\s+-rf\s+\/(?:\s|$)/, // rm -rf /
  /\bsudo\s+rm\b/, // sudo rm ...
  /\bdd\b/, // dd
  /\bmkfs\b/, // mkfs
  /\bchmod\s+-R\s+777\s+\/(?:\s|$)/, // chmod -R 777 /
  /\bchown\s+-R\s+.*\/(?:\s|$)/, // chown -R /
  /\bcurl\b.*\|\s*sh\b/, // curl ... | sh
  /\bcurl\b.*\|\s*bash\b/, // curl ... | bash
  /\bwget\b.*\|\s*bash\b/, // wget ... | bash
  /\bwget\b.*\|\s*sh\b/, // wget ... | sh
];

/**
 * Returns `true` if the command is on the explicit whitelist.
 */
export function isCommandAllowed(command: string): boolean {
  const trimmed = command.trim();
  return ALLOWED_COMMANDS.includes(trimmed);
}

/**
 * Returns `true` if the command matches any blacklisted pattern.
 */
export function isCommandBlocked(command: string): boolean {
  return BLOCKED_PATTERNS.some((re) => re.test(command));
}
