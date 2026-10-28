/**
 * Client identity for per-IP bounds (rate limit, self-serve free keys).
 */
import { isIPv6 } from "node:net";

/**
 * Express "trust proxy" value used when TRUST_PROXY is set: exactly one hop.
 * `true` would take the leftmost X-Forwarded-For entry, which the client
 * writes itself; one hop takes the address the proxy (Fly, Caddy) appended.
 */
export const TRUST_PROXY_SETTING: boolean | number = 1;

/**
 * The part of a client IP that identifies one requester. An IPv6 client
 * routinely holds a whole /64, so per-address bounds would give it 2^64 tries.
 */
export function ipBucket(ip: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return mapped[1];
  const bare = ip.split("%")[0];
  if (!isIPv6(bare)) return ip;
  const [head, tail] = bare.split("::");
  const headGroups = head ? head.split(":") : [];
  const tailGroups = tail ? tail.split(":") : [];
  const groups =
    tail === undefined
      ? headGroups
      : [...headGroups, ...Array<string>(8 - headGroups.length - tailGroups.length).fill("0"), ...tailGroups];
  return `${groups.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(":")}::/64`;
}
