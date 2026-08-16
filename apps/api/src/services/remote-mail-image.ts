import type { LookupAddress as DnsLookupAddress } from "node:dns";
import { lookup } from "node:dns/promises";

import axios, {
  type AddressFamily,
  type AxiosRequestConfig,
  type AxiosResponse,
  type LookupAddress,
} from "axios";
import ipaddr from "ipaddr.js";

const MAXIMUM_IMAGE_BYTES = 10 * 1024 * 1024;
const MAXIMUM_IMAGE_FETCH_DURATION_MILLISECONDS = 10_000;
const MAXIMUM_REDIRECTS = 3;
const SUPPORTED_IMAGE_TYPES = new Set([
  "image/apng",
  "image/avif",
  "image/bmp",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/x-icon",
]);

export interface RemoteMailImage {
  bytes: Buffer;
  contentType: string;
}

export class UnsafeRemoteMailImageUrlError extends Error {}
export class RemoteMailImageUnavailableError extends Error {}

interface RemoteMailImageDependencies {
  createFetchSignal?: () => AbortSignal;
  resolve?: ResolveAddresses;
  request?: (
    url: string,
    configuration: AxiosRequestConfig,
  ) => Promise<AxiosResponse<ArrayBuffer>>;
}

type ResolveAddresses = (
  hostname: string,
  options: { all: true; verbatim: true },
) => Promise<DnsLookupAddress[]>;

export function normalizeRemoteMailImageUrl(value: string): string | null {
  try {
    const trimmed = value.trim();
    const url = new URL(trimmed.startsWith("//") ? `https:${trimmed}` : trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    const defaultPort = url.protocol === "https:" ? "443" : "80";
    if (url.port && url.port !== defaultPort) return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

export function isPublicNetworkAddress(value: string): boolean {
  if (!ipaddr.isValid(value)) return false;
  return ipaddr.process(value).range() === "unicast";
}

async function resolvePublicAddresses(
  url: URL,
  resolve: ResolveAddresses,
): Promise<Array<{ address: string; family: 4 | 6 }>> {
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (ipaddr.isValid(hostname)) {
    if (!isPublicNetworkAddress(hostname)) {
      throw new UnsafeRemoteMailImageUrlError();
    }
    return [
      {
        address: hostname,
        family: ipaddr.parse(hostname).kind() === "ipv6" ? 6 : 4,
      },
    ];
  }

  let addresses: DnsLookupAddress[];
  try {
    addresses = await resolve(hostname, { all: true, verbatim: true });
  } catch {
    throw new RemoteMailImageUnavailableError();
  }
  if (!Array.isArray(addresses) || addresses.length === 0) {
    throw new RemoteMailImageUnavailableError();
  }
  if (
    addresses.some(
      (entry) =>
        (entry.family !== 4 && entry.family !== 6) ||
        !isPublicNetworkAddress(entry.address),
    )
  ) {
    throw new UnsafeRemoteMailImageUrlError();
  }
  return addresses.flatMap((entry) =>
    entry.family === 4 || entry.family === 6
      ? [{ address: entry.address, family: entry.family }]
      : [],
  );
}

function createPinnedLookup(
  addresses: Array<{ address: string; family: 4 | 6 }>,
) {
  return (
    _hostname: string,
    options: object,
    callback: (
      error: Error | null,
      address: LookupAddress | LookupAddress[],
      family?: AddressFamily,
    ) => void,
  ): void => {
    if ("all" in options && options.all === true) {
      callback(null, addresses);
      return;
    }
    const [address] = addresses;
    callback(null, address.address, address.family);
  };
}

function redirectLocation(response: AxiosResponse<ArrayBuffer>): string | null {
  if (response.status < 300 || response.status >= 400) return null;
  const location = response.headers.location;
  return typeof location === "string" && location.trim() ? location : null;
}

export async function fetchRemoteMailImage(
  source: string,
  dependencies: RemoteMailImageDependencies = {},
): Promise<RemoteMailImage> {
  const normalizedSource = normalizeRemoteMailImageUrl(source);
  if (!normalizedSource) throw new UnsafeRemoteMailImageUrlError();

  const resolve: ResolveAddresses =
    dependencies.resolve ??
    ((hostname, options) => lookup(hostname, options));
  const request =
    dependencies.request ??
    ((url: string, configuration: AxiosRequestConfig) =>
      axios.get<ArrayBuffer>(url, configuration));
  const fetchSignal =
    dependencies.createFetchSignal?.() ??
    AbortSignal.timeout(MAXIMUM_IMAGE_FETCH_DURATION_MILLISECONDS);
  let currentUrl = new URL(normalizedSource);

  for (let redirectCount = 0; redirectCount <= MAXIMUM_REDIRECTS; redirectCount += 1) {
    const addresses = await resolvePublicAddresses(currentUrl, resolve);
    let response: AxiosResponse<ArrayBuffer>;
    try {
      response = await request(currentUrl.toString(), {
        headers: {
          accept: [...SUPPORTED_IMAGE_TYPES].join(", "),
          "user-agent": "Invook-Mail-Image-Proxy/1.0",
        },
        lookup: createPinnedLookup(addresses),
        maxBodyLength: MAXIMUM_IMAGE_BYTES,
        maxContentLength: MAXIMUM_IMAGE_BYTES,
        maxRedirects: 0,
        responseType: "arraybuffer",
        signal: fetchSignal,
        validateStatus: () => true,
      });
    } catch {
      throw new RemoteMailImageUnavailableError();
    }

    const location = redirectLocation(response);
    if (location) {
      if (redirectCount === MAXIMUM_REDIRECTS) {
        throw new RemoteMailImageUnavailableError();
      }
      const redirectedSource = normalizeRemoteMailImageUrl(
        new URL(location, currentUrl).toString(),
      );
      if (!redirectedSource) throw new UnsafeRemoteMailImageUrlError();
      currentUrl = new URL(redirectedSource);
      continue;
    }

    if (response.status < 200 || response.status >= 300) {
      throw new RemoteMailImageUnavailableError();
    }
    const contentType = String(response.headers["content-type"] ?? "")
      .split(";", 1)[0]
      .trim()
      .toLowerCase();
    if (!SUPPORTED_IMAGE_TYPES.has(contentType)) {
      throw new RemoteMailImageUnavailableError();
    }
    const bytes = Buffer.from(response.data);
    if (bytes.byteLength === 0 || bytes.byteLength > MAXIMUM_IMAGE_BYTES) {
      throw new RemoteMailImageUnavailableError();
    }
    return { bytes, contentType };
  }

  throw new RemoteMailImageUnavailableError();
}
