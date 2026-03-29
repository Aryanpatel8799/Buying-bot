import { NextResponse } from "next/server";

interface TokenBucket {
  tokens: number;
  lastRefill: number;
}

const buckets = new Map<string, TokenBucket>();

// Clean up old buckets every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (now - bucket.lastRefill > 600_000) {
      buckets.delete(key);
    }
  }
}, 300_000);

/**
 * Token bucket rate limiter.
 * @param key - Unique identifier (e.g., IP + route)
 * @param maxTokens - Maximum tokens (burst capacity)
 * @param refillRate - Tokens added per second
 * @returns true if request is allowed, false if rate limited
 */
export function checkRateLimit(
  key: string,
  maxTokens: number,
  refillRate: number
): boolean {
  const now = Date.now();
  let bucket = buckets.get(key);

  if (!bucket) {
    bucket = { tokens: maxTokens - 1, lastRefill: now };
    buckets.set(key, bucket);
    return true;
  }

  // Refill tokens based on elapsed time
  const elapsed = (now - bucket.lastRefill) / 1000;
  bucket.tokens = Math.min(maxTokens, bucket.tokens + elapsed * refillRate);
  bucket.lastRefill = now;

  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return true;
  }

  return false;
}

/**
 * Helper to create a rate-limited response.
 */
export function rateLimitResponse() {
  return NextResponse.json(
    { error: "Too many requests. Please try again later." },
    { status: 429 }
  );
}
