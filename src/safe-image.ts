// WhatsApp-a şəkil göndərmək üçün şəkli BİZİM server yükləyir, ona görə SSRF-dən qorunur:
// yalnız http(s), daxili/şəxsi IP-lər qadağandır (DNS cavabı yoxlanır), yönləndirmələr təkrar yoxlanır,
// ölçü və vaxt limiti var, məzmun real şəkil (png/jpeg/webp) olmalıdır.
import { lookup as dnsLookup } from "node:dns/promises";
import net from "node:net";

export const IMAGE_MAX_BYTES = 3 * 1024 * 1024;
type Lookup = (host: string) => Promise<{ address: string }[]>;

export function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith("::ffff:")) return isPrivateIp(v.slice(7));
  return v === "::" || v === "::1" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe8") || v.startsWith("fe9") || v.startsWith("fea") || v.startsWith("feb") || v.startsWith("ff");
}

export function sniffImage(b: Buffer): "image/png" | "image/jpeg" | "image/webp" | null {
  if (b.length > 12 && b[0] === 0x89 && b.subarray(1, 4).toString() === "PNG") return "image/png";
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length > 12 && b.subarray(0, 4).toString() === "RIFF" && b.subarray(8, 12).toString() === "WEBP") return "image/webp";
  return null;
}

async function assertPublic(raw: string, lookup: Lookup): Promise<URL> {
  const u = new URL(raw);
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("protokol");
  if (u.username || u.password) throw new Error("hesab məlumatı");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const addrs = net.isIP(host) ? [{ address: host }] : await lookup(host);
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new Error("daxili ünvan");
  return u;
}

/** Uğurlu olsa şəkil baytlarını, istənilən problemdə null qaytarır (çağıran mətnə keçir). */
export async function fetchImage(raw: string, o: { fetchFn?: typeof fetch; lookup?: Lookup } = {}): Promise<{ data: Buffer; mime: string } | null> {
  const fetchFn = o.fetchFn ?? fetch;
  const lookup: Lookup = o.lookup ?? ((h) => dnsLookup(h, { all: true }));
  try {
    let url = raw;
    for (let hop = 0; hop < 3; hop++) {
      const u = await assertPublic(url, lookup);
      const res = await fetchFn(u, { redirect: "manual", signal: AbortSignal.timeout(8000), headers: { accept: "image/*", "user-agent": "ReplonicBot/1.0" } });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        if (!loc) return null;
        url = new URL(loc, u).toString();
        continue;
      }
      if (!res.ok || !res.body) return null;
      if (Number(res.headers.get("content-length") ?? 0) > IMAGE_MAX_BYTES) return null;
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const c of res.body as unknown as AsyncIterable<Uint8Array>) {
        size += c.length;
        if (size > IMAGE_MAX_BYTES) return null;
        chunks.push(Buffer.from(c));
      }
      const data = Buffer.concat(chunks);
      const mime = sniffImage(data);
      return mime ? { data, mime } : null;
    }
    return null;
  } catch { return null; }
}
