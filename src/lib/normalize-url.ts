const SCHEME_RE = /^https?:\/\//i;
const HOST_LIKE_RE = /^[\w.-]+\.[a-z]{2,}/i;

/** Pick and normalize a single frontend origin from env input. */
export function normalizeBaseUrl(raw: string | undefined, fallback: string): string {
  const value = (raw ?? '').trim();
  if (!value) return fallback;

  const segments = value
    .split(',')
    .map((segment) => segment.trim())
    .filter(Boolean);

  const withScheme = segments.find((segment) => SCHEME_RE.test(segment));
  const hostLike = segments.find((segment) => HOST_LIKE_RE.test(segment));
  let candidate = withScheme ?? hostLike ?? segments[0] ?? fallback;

  candidate = candidate.replace(/^httpss:\/\//i, 'https://');
  if (!SCHEME_RE.test(candidate)) {
    candidate = `https://${candidate.replace(/^\/+/, '')}`;
  }

  try {
    const parsed = new URL(candidate);
    if (!['http:', 'https:'].includes(parsed.protocol)) return fallback;
    return parsed.origin;
  } catch {
    return fallback;
  }
}

/** Build an absolute frontend URL from a normalized base and path. */
export function buildFrontendUrl(
  baseUrl: string,
  path: string,
  params?: Record<string, string>
): string {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const url = new URL(normalizedPath, baseUrl);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
  }
  return url.toString();
}
