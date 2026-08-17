import type { LookupAddress as DnsLookupAddress } from "node:dns";
import { Resolver } from "node:dns/promises";

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
  cancelResolution?: () => void;
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

function createAddressResolver(): {
  cancel: () => void;
  resolve: ResolveAddresses;
} {
  const resolver = new Resolver();
  return {
    cancel: () => resolver.cancel(),
    resolve: async (hostname) => {
      const [ipv4Result, ipv6Result] = await Promise.allSettled([
        resolver.resolve4(hostname),
        resolver.resolve6(hostname),
      ]);
      const addresses: DnsLookupAddress[] = [];
      if (ipv4Result.status === "fulfilled") {
        addresses.push(
          ...ipv4Result.value.map((address) => ({ address, family: 4 as const })),
        );
      }
      if (ipv6Result.status === "fulfilled") {
        addresses.push(
          ...ipv6Result.value.map((address) => ({ address, family: 6 as const })),
        );
      }
      if (addresses.length === 0) {
        throw new RemoteMailImageUnavailableError();
      }
      return addresses;
    },
  };
}

function resolveAddressesBeforeDeadline(
  hostname: string,
  resolve: ResolveAddresses,
  cancelResolution: () => void,
  signal: AbortSignal,
): Promise<DnsLookupAddress[]> {
  return new Promise((resolvePromise, rejectPromise) => {
    let isSettled = false;
    const handleAbort = (): void => {
      try {
        cancelResolution();
      } finally {
        settle(() => rejectPromise(new RemoteMailImageUnavailableError()));
      }
    };
    const settle = (operation: () => void): void => {
      if (isSettled) return;
      isSettled = true;
      signal.removeEventListener("abort", handleAbort);
      operation();
    };

    signal.addEventListener("abort", handleAbort, { once: true });
    if (signal.aborted) {
      handleAbort();
      return;
    }
    void resolve(hostname, { all: true, verbatim: true }).then(
      (addresses) => settle(() => resolvePromise(addresses)),
      () => settle(() => rejectPromise(new RemoteMailImageUnavailableError())),
    );
  });
}

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

export function isSupportedRemoteMailImageContentType(value: string): boolean {
  return SUPPORTED_IMAGE_TYPES.has(value.trim().toLowerCase());
}

async function resolvePublicAddresses(
  url: URL,
  resolve: ResolveAddresses,
  cancelResolution: () => void,
  signal: AbortSignal,
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
    addresses = await resolveAddressesBeforeDeadline(
      hostname,
      resolve,
      cancelResolution,
      signal,
    );
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

  const addressResolver = dependencies.resolve ? null : createAddressResolver();
  const resolve = dependencies.resolve ?? addressResolver?.resolve;
  if (!resolve) throw new RemoteMailImageUnavailableError();
  const cancelResolution =
    dependencies.cancelResolution ?? addressResolver?.cancel ?? (() => undefined);
  const request =
    dependencies.request ??
    ((url: string, configuration: AxiosRequestConfig) =>
      axios.get<ArrayBuffer>(url, configuration));
  const fetchSignal =
    dependencies.createFetchSignal?.() ??
    AbortSignal.timeout(MAXIMUM_IMAGE_FETCH_DURATION_MILLISECONDS);
  let currentUrl = new URL(normalizedSource);

  for (let redirectCount = 0; redirectCount <= MAXIMUM_REDIRECTS; redirectCount += 1) {
    const addresses = await resolvePublicAddresses(
      currentUrl,
      resolve,
      cancelResolution,
      fetchSignal,
    );
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
    if (!isSupportedRemoteMailImageContentType(contentType)) {
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
