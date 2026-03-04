/**
 * Patterns that identify sensitive files which must never be read or
 * forwarded to an LLM.
 *
 * Each pattern is tested against the **basename** of the file, except for
 * directory-based patterns (`.ssh/*`) which are tested against the full path.
 */
const SENSITIVE_BASENAME_PATTERNS: RegExp[] = [
  /^\.env($|\.)/, // .env, .env.local, .env.production, etc.
  /\.pem$/, // *.pem
  /\.key$/, // *.key
  /^id_rsa/, // id_rsa, id_rsa.pub
  /^\.npmrc$/, // .npmrc
  /^secrets\./, // secrets.yaml, secrets.json, etc.
];

const SENSITIVE_PATH_PATTERNS: RegExp[] = [
  /[/\\]\.ssh[/\\]/, // any path containing .ssh/
];

/**
 * Returns `true` when `filePath` matches a known sensitive-file pattern.
 */
export function isSensitivePath(filePath: string): boolean {
  // Normalise to forward slashes for cross-platform matching
  const normalised = filePath.replace(/\\/g, '/');
  const basename = normalised.split('/').pop() ?? '';

  if (SENSITIVE_BASENAME_PATTERNS.some((re) => re.test(basename))) {
    return true;
  }

  if (SENSITIVE_PATH_PATTERNS.some((re) => re.test(normalised))) {
    return true;
  }

  return false;
}
