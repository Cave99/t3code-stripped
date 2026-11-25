/**
 * In-process PortScanner implementation.
 *
 * macOS/Linux: parses `lsof -iTCP -sTCP:LISTEN -P -n -F pcn` (-F output is a
 * stable line-prefixed field format; this is the only `lsof` flag set we rely
 * on).
 *
 * Windows / lsof missing: checks a curated list of common dev ports through
 * the shared Net service.
 *
 * Listening ports are published only after a bounded HTTP(S) probe finds a
 * successful HTML document or a redirect to one.
 * Positive and negative results are cached briefly by candidate URL and listener identity,
 * limiting repeated requests without leaving stale classifications around.
 *
 * Polling is reference-counted via scoped `retain`. A single layer-scoped fiber
 * polls forever, but each tick is a no-op when the retain count is zero.
 *
 * A listener belongs to a thread when a terminal registered its pid, or when its
 * launch environment carries the agent's `T3CODE_THREAD_ID`. Listed servers can be
 * stopped by signaling their process group.
 */
import {
  CONFIGURED_LOCAL_SERVER_URLS_MAX_ITEMS,
  PREVIEW_URL_MAX_LENGTH,
  PreviewStopLocalServerError,
  ThreadId,
  type DiscoveredLocalServer,
  type PreviewStopLocalServerInput,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Net from "@t3tools/shared/Net";
import { isLoopbackHost, LSOF_LOCAL_HOST_TOKENS } from "@t3tools/shared/preview";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";

import { signalProcessGroup } from "../process/processGroup.ts";
import * as ProcessRunner from "../processRunner.ts";

export class PortDiscovery extends Context.Service<
  PortDiscovery,
  {
    readonly scan: (
      configuredUrls?: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyArray<DiscoveredLocalServer>>;
    readonly subscribe: (
      input: {
        readonly configuredUrls: ReadonlyArray<string>;
        readonly initialSnapshot: ReadonlyArray<DiscoveredLocalServer>;
      },
      listener: (servers: ReadonlyArray<DiscoveredLocalServer>) => Effect.Effect<void>,
    ) => Effect.Effect<void, never, Scope.Scope>;
    readonly retain: Effect.Effect<void, never, Scope.Scope>;
    readonly registerTerminalProcesses: (input: {
      readonly threadId: string;
      readonly terminalId: string;
      readonly processIds: ReadonlyArray<number>;
    }) => Effect.Effect<void>;
    readonly unregisterTerminal: (input: {
      readonly threadId: string;
      readonly terminalId: string;
    }) => Effect.Effect<void>;
    /** Stops a listed server's process group, never this server, an agent CLI, or a shell. */
    readonly stopServer: (
      input: PreviewStopLocalServerInput,
    ) => Effect.Effect<void, PreviewStopLocalServerError>;
  }
>()("t3/preview/PortScanner/PortDiscovery") {}

/**
 * Agents launch with this set to their thread, and every job they start inherits it, so a
 * server stays attributed after its launching shell exits or the agent settles.
 */
export const AGENT_THREAD_ENV = "T3CODE_THREAD_ID";

export const COMMON_DEV_PORTS: ReadonlyArray<number> = Object.freeze([
  3000, 3001, 3333, 4173, 4200, 4321, 5000, 5173, 5174, 5175, 5500, 8000, 8080, 8081, 8888, 9000,
]);

const POLL_INTERVAL = Duration.seconds(3);
const LSOF_TIMEOUT_MS = 5_000;
const WINDOWS_LISTENER_TIMEOUT_MS = 5_000;
const WEB_PROBE_TIMEOUT = Duration.seconds(1);
const WEB_PROBE_CACHE_TTL_MS = Duration.toMillis(Duration.seconds(15));
const WEB_PROBE_CONCURRENCY = 16;
const NAVIGATION_REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const PS_TIMEOUT_MS = 5_000;
const PS_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const STOP_GRACE_MS = 3_000;
const STOP_POLL_INTERVAL = Duration.millis(250);

type Listener = (servers: ReadonlyArray<DiscoveredLocalServer>) => Effect.Effect<void>;

interface ListenerSubscription {
  readonly configuredUrls: ReadonlyArray<string>;
  readonly lastSnapshot: ReadonlyArray<DiscoveredLocalServer>;
}

interface ScannerState {
  readonly listeners: ReadonlyMap<Listener, ListenerSubscription>;
  readonly terminalProcesses: ReadonlyMap<
    string,
    {
      readonly owner: TerminalProcessOwner;
      readonly processIds: ReadonlySet<number>;
    }
  >;
  readonly retainCount: number;
}

interface TerminalProcessOwner {
  readonly threadId: ThreadId;
  readonly terminalId: string;
}

type ServerOwner = Pick<DiscoveredLocalServer, "terminal" | "agent">;

const UNOWNED: ServerOwner = { terminal: null, agent: null };

const isOwned = (server: DiscoveredLocalServer): boolean =>
  server.terminal !== null || (server.agent ?? null) !== null;

interface ProcessTableRow {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
}

interface WebProbeCacheEntry {
  readonly pid: number | null;
  readonly isWeb: boolean;
  readonly expiresAtMillis: number;
}

interface WebProbeGroup {
  readonly server: DiscoveredLocalServer;
  readonly urls: ReadonlyArray<string>;
  readonly configuredKey: string | null;
}

interface WebProbeSnapshot {
  readonly discovered: ReadonlyArray<DiscoveredLocalServer>;
  readonly configured: ReadonlyMap<string, DiscoveredLocalServer>;
}

const terminalOwnerKey = (owner: {
  readonly threadId: string;
  readonly terminalId: string;
}): string => `${owner.threadId}\u0000${owner.terminalId}`;

const parseConfiguredUrl = (raw: string): URL | null => {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!isLoopbackHost(url.hostname)) return null;
    return url;
  } catch {
    return null;
  }
};

const localServerKey = (host: string, port: number): string =>
  `${isLoopbackHost(host) ? "loopback" : host.toLowerCase()}:${port}`;

const urlPort = (url: URL): number =>
  url.port.length > 0 ? Number.parseInt(url.port, 10) : url.protocol === "http:" ? 80 : 443;

const webProbeCacheKey = (raw: string): string => {
  const url = new URL(raw);
  url.hash = "";
  return url.href;
};

const normalizeConfiguredUrls = (urls: ReadonlyArray<string>): ReadonlyArray<string> => [
  ...new Set(
    urls
      .slice(0, CONFIGURED_LOCAL_SERVER_URLS_MAX_ITEMS)
      .filter((raw) => raw.length <= PREVIEW_URL_MAX_LENGTH)
      .map(parseConfiguredUrl)
      .filter((url): url is URL => url !== null && url.href.length <= PREVIEW_URL_MAX_LENGTH)
      .map((url) => {
        if (url.hostname === "0.0.0.0") url.hostname = "localhost";
        return url.href;
      })
      .filter((url) => url.length <= PREVIEW_URL_MAX_LENGTH),
  ),
];

const projectWebProbeSnapshot = (
  snapshot: WebProbeSnapshot,
  configuredUrls: ReadonlyArray<string>,
): ReadonlyArray<DiscoveredLocalServer> => {
  const visibleByServer = new Map<string, DiscoveredLocalServer>();
  for (const raw of normalizeConfiguredUrls(configuredUrls)) {
    const url = new URL(raw);
    const port = urlPort(url);
    const serverKey = localServerKey(url.hostname, port);
    if (visibleByServer.has(serverKey)) continue;
    const configured = snapshot.configured.get(webProbeCacheKey(raw));
    if (configured) visibleByServer.set(serverKey, { ...configured, url: raw });
  }
  for (const server of snapshot.discovered) {
    const key = localServerKey(server.host, server.port);
    if (!visibleByServer.has(key)) visibleByServer.set(key, server);
  }
  return [...visibleByServer.values()].toSorted((left, right) => left.port - right.port);
};

const parseLsofOutput = (
  raw: string,
  owners: ReadonlyMap<number, ServerOwner> = new Map(),
): ReadonlyArray<DiscoveredLocalServer> => {
  const seen = new Map<string, DiscoveredLocalServer>();
  let pid: number | null = null;
  let processName: string | null = null;

  for (const line of raw.split("\n")) {
    if (line.length === 0) continue;
    const tag = line.charAt(0);
    const value = line.slice(1);
    if (tag === "p") {
      const parsed = Number.parseInt(value, 10);
      pid = Number.isFinite(parsed) && parsed > 0 ? parsed : null;
      processName = null;
      continue;
    }
    if (tag === "c") {
      processName = value.trim() || null;
      continue;
    }
    if (tag === "n") {
      const portMatch = parsePortFromLsofName(value);
      if (portMatch == null) continue;
      const url = `http://localhost:${portMatch}`;
      const key = `localhost:${portMatch}`;
      if (seen.has(key)) continue;
      seen.set(key, {
        host: "localhost",
        port: portMatch,
        url,
        processName,
        pid,
        ...((pid === null ? undefined : owners.get(pid)) ?? UNOWNED),
      });
    }
  }

  return Array.from(seen.values()).toSorted((a, b) => a.port - b.port);
};

const parsePortFromLsofName = (name: string): number | null => {
  // Examples: "*:5173", "127.0.0.1:5173", "[::1]:5173", "localhost:5173",
  //           "192.168.1.10:5173 (LISTEN)" — we only care if the host part is local.
  const trimmed = name.split(" ", 1)[0]?.trim() ?? "";
  if (trimmed.length === 0) return null;
  const lastColon = trimmed.lastIndexOf(":");
  if (lastColon < 0) return null;
  const hostPart = trimmed.slice(0, lastColon);
  const portPart = trimmed.slice(lastColon + 1);
  if (!LSOF_LOCAL_HOST_TOKENS.has(hostPart)) return null;
  const port = Number.parseInt(portPart, 10);
  if (!Number.isFinite(port) || port <= 0 || port >= 65536) return null;
  return port;
};

const parseWindowsListenerOutput = (
  raw: string,
  owners: ReadonlyMap<number, ServerOwner> = new Map(),
): ReadonlyArray<DiscoveredLocalServer> => {
  const seen = new Map<number, DiscoveredLocalServer>();
  for (const line of raw.split(/\r?\n/g)) {
    const [hostRaw, portRaw, pidRaw, processNameRaw] = line.trim().split("|", 4);
    const host = hostRaw?.trim() ?? "";
    if (!LSOF_LOCAL_HOST_TOKENS.has(host) && host !== "::") continue;
    const port = Number(portRaw);
    const pid = Number(pidRaw);
    if (!Number.isInteger(port) || port <= 0 || port >= 65536) continue;
    const normalizedPid = Number.isInteger(pid) && pid > 0 ? pid : null;
    if (seen.has(port)) continue;
    seen.set(port, {
      host: "localhost",
      port,
      url: `http://localhost:${port}`,
      processName: processNameRaw?.trim() || null,
      pid: normalizedPid,
      ...((normalizedPid === null ? undefined : owners.get(normalizedPid)) ?? UNOWNED),
    });
  }
  return [...seen.values()].toSorted((left, right) => left.port - right.port);
};

/** Processes holding a loopback or wildcard listener in `lsof -F pcn` output. */
const lsofProcessIds = (raw: string): ReadonlyArray<number> => {
  const pids = new Set<number>();
  let pid: number | null = null;
  for (const line of raw.split("\n")) {
    if (line.startsWith("p")) {
      const parsed = Number.parseInt(line.slice(1), 10);
      pid = Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    } else if (
      line.startsWith("n") &&
      pid !== null &&
      parsePortFromLsofName(line.slice(1)) !== null
    ) {
      pids.add(pid);
    }
  }
  return [...pids];
};

const AGENT_THREAD_ASSIGNMENT = new RegExp(`(?:^|\\s)${AGENT_THREAD_ENV}=(\\S+)`);

/**
 * Reads `ps` output whose command column is followed by the process's launch environment
 * (`ps -E` on macOS, `ps e` on Linux). Arguments and environment are both space-separated, so an
 * argument that spells the assignment out also matches.
 */
export const parsePsEnvironmentThreads = (raw: string): ReadonlyMap<number, ThreadId | null> => {
  const threads = new Map<number, ThreadId | null>();
  for (const line of raw.split("\n")) {
    const match = /^\s*(\d+)\s(.*)$/.exec(line);
    if (!match) continue;
    const value = AGENT_THREAD_ASSIGNMENT.exec(match[2]!)?.[1];
    threads.set(Number(match[1]), value ? ThreadId.make(value) : null);
  }
  return threads;
};

const parseProcessTable = (raw: string): ReadonlyMap<number, ProcessTableRow> => {
  const rows = new Map<number, ProcessTableRow>();
  for (const line of raw.split("\n")) {
    const [pid, ppid, pgid] = line.trim().split(/\s+/).map(Number);
    if (Number.isInteger(pid) && Number.isInteger(ppid) && Number.isInteger(pgid)) {
      rows.set(pid!, { pid: pid!, ppid: ppid!, pgid: pgid! });
    }
  }
  return rows;
};

/**
 * The process group stopping `pid` signals. Shells with job control and agent tool shells give
 * every job its own group, so the group is the job. Null when the group also holds this server,
 * a direct child of it (agent CLIs and terminal shells), or one of its ancestors.
 */
export const stoppableProcessGroup = (
  table: ReadonlyMap<number, ProcessTableRow>,
  pid: number,
  serverPid: number,
): number | null => {
  const group = table.get(pid)?.pgid;
  if (group === undefined || group <= 1) return null;
  const guarded = new Set([serverPid]);
  for (
    let parent = table.get(serverPid)?.ppid;
    parent !== undefined && parent > 1 && !guarded.has(parent);
    parent = table.get(parent)?.ppid
  ) {
    guarded.add(parent);
  }
  for (const row of table.values()) {
    if (row.pgid === group && (guarded.has(row.pid) || row.ppid === serverPid)) return null;
  }
  return group;
};

const isNoSuchProcess = (cause: unknown): boolean =>
  typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ESRCH";

const serversEqual = (
  left: ReadonlyArray<DiscoveredLocalServer>,
  right: ReadonlyArray<DiscoveredLocalServer>,
): boolean => {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    const a = left[i];
    const b = right[i];
    if (!a || !b) return false;
    if (
      a.host !== b.host ||
      a.port !== b.port ||
      a.url !== b.url ||
      a.processName !== b.processName ||
      a.pid !== b.pid ||
      a.terminal?.threadId !== b.terminal?.threadId ||
      a.terminal?.terminalId !== b.terminal?.terminalId ||
      a.agent?.threadId !== b.agent?.threadId
    ) {
      return false;
    }
  }
  return true;
};

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* PortDiscoveryMake() {
  const net = yield* Net.NetService;
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const hostPlatform = yield* HostProcessPlatform;
  const httpClient = (yield* HttpClient.HttpClient).pipe(HttpClient.withScope);
  const stateRef = yield* Ref.make<ScannerState>({
    listeners: new Map(),
    terminalProcesses: new Map(),
    retainCount: 0,
  });
  const webProbeCacheRef = yield* Ref.make<ReadonlyMap<string, WebProbeCacheEntry>>(new Map());
  const scanSemaphore = yield* Semaphore.make(1);
  // Each current listener pid's agent thread, or null without one. A process keeps its launch
  // environment, so a pid is read once while it listens. Cleared while no client retains the
  // scanner, since unscanned pids can be reused.
  const agentThreadsRef = yield* Ref.make<ReadonlyMap<number, ThreadId | null>>(new Map());

  const readAgentThreads = Effect.fn("PortDiscovery.readAgentThreads")(function* (
    pids: ReadonlyArray<number>,
  ) {
    const cached = yield* Ref.get(agentThreadsRef);
    const unread = pids.filter((pid) => !cached.has(pid));
    const read =
      unread.length === 0
        ? new Map<number, ThreadId | null>()
        : yield* processRunner
            .run({
              command: "ps",
              args: [
                ...(hostPlatform === "darwin" ? ["-E", "-ww"] : ["eww"]),
                "-o",
                "pid=,command=",
                "-p",
                unread.join(","),
              ],
              timeout: Duration.millis(PS_TIMEOUT_MS),
              maxOutputBytes: PS_MAX_OUTPUT_BYTES,
              outputMode: "truncate",
            })
            .pipe(
              Effect.map((result) => parsePsEnvironmentThreads(result.stdout)),
              // Unread pids stay out of the cache, so the next scan retries them.
              Effect.orElseSucceed(() => new Map<number, ThreadId | null>()),
            );
    const next = new Map<number, ThreadId | null>();
    for (const pid of pids) {
      const threadId = cached.has(pid) ? cached.get(pid) : read.get(pid);
      if (threadId !== undefined) next.set(pid, threadId);
    }
    yield* Ref.set(agentThreadsRef, next);
    return next;
  });

  const withAgentOwners = Effect.fn("PortDiscovery.withAgentOwners")(function* (
    terminalOwners: ReadonlyMap<number, ServerOwner>,
    pids: ReadonlyArray<number>,
  ) {
    const threads = yield* readAgentThreads(pids.filter((pid) => !terminalOwners.has(pid)));
    const owners = new Map(terminalOwners);
    for (const [pid, threadId] of threads) {
      if (threadId !== null) owners.set(pid, { terminal: null, agent: { threadId } });
    }
    return owners;
  });

  const probeCommonPorts = Effect.fn("PortDiscovery.probeCommonPorts")(function* () {
    const results = yield* Effect.forEach(
      COMMON_DEV_PORTS,
      (port) =>
        net.isPortAvailableOnLoopback(port).pipe(
          Effect.map((available) => ({
            port,
            listening: !available,
          })),
        ),
      { concurrency: "unbounded" },
    );
    return results
      .filter((result) => result.listening)
      .map<DiscoveredLocalServer>((result) => ({
        host: "localhost",
        port: result.port,
        url: `http://localhost:${result.port}`,
        processName: null,
        pid: null,
        terminal: null,
      }));
  });

  const probeWebUrl = Effect.fn("PortDiscovery.probeWebUrl")((url: string) =>
    httpClient.get(url).pipe(
      Effect.map((response) => {
        const location = response.headers.location?.trim();
        if (NAVIGATION_REDIRECT_STATUSES.has(response.status) && location) return url;
        if (response.status < 200 || response.status >= 300) return null;
        if (response.status === 204 || response.status === 205) return null;
        const contentType = response.headers["content-type"]
          ?.split(";", 1)[0]
          ?.trim()
          .toLowerCase();
        return contentType === "text/html" || contentType === "application/xhtml+xml" ? url : null;
      }),
      Effect.scoped,
      Effect.timeoutOption(WEB_PROBE_TIMEOUT),
      Effect.map(Option.getOrNull),
      Effect.orElseSucceed(() => null),
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
    ),
  );

  const makeWebProbeGroups = (
    servers: ReadonlyArray<DiscoveredLocalServer>,
    configuredUrls: ReadonlyArray<string>,
  ): ReadonlyArray<WebProbeGroup> => {
    const serversByKey = new Map(
      servers.map((server) => [localServerKey(server.host, server.port), server] as const),
    );
    const groups: WebProbeGroup[] = [];
    const configuredResources = new Set<string>();

    for (const raw of configuredUrls) {
      const url = new URL(raw);
      const port = urlPort(url);
      const key = localServerKey(url.hostname, port);
      const resourceKey = webProbeCacheKey(raw);
      if (configuredResources.has(resourceKey)) continue;
      configuredResources.add(resourceKey);
      groups.push({
        server: serversByKey.get(key) ?? {
          host: url.hostname,
          port,
          url: raw,
          processName: null,
          pid: null,
          terminal: null,
        },
        urls: [raw],
        configuredKey: resourceKey,
      });
    }

    for (const server of servers) {
      groups.push({
        server,
        urls: [`http://${server.host}:${server.port}`, `https://${server.host}:${server.port}`],
        configuredKey: null,
      });
    }

    return groups;
  };

  const probeWebServers = Effect.fn("PortDiscovery.probeWebServers")(function* (
    servers: ReadonlyArray<DiscoveredLocalServer>,
    configuredUrls: ReadonlyArray<string>,
  ) {
    const nowMillis = yield* Clock.currentTimeMillis;
    const cached = yield* Ref.get(webProbeCacheRef);
    const groups = makeWebProbeGroups(servers, configuredUrls);
    const batchProbes = new Map<
      string,
      Effect.Effect<{ readonly probe: WebProbeCacheEntry; readonly fresh: boolean }>
    >();
    const batchProbeSemaphore = yield* Semaphore.make(1);
    const getProbe = (url: string, pid: number | null) => {
      const key = webProbeCacheKey(url);
      const identity = `${key}\u0000${pid ?? ""}`;
      return batchProbeSemaphore
        .withPermits(1)(
          Effect.gen(function* () {
            const existing = batchProbes.get(identity);
            if (existing) return [existing] as const;
            const cachedProbe = cached.get(key);
            const cachedIsCurrent =
              cachedProbe?.pid === pid && cachedProbe.expiresAtMillis > nowMillis;
            const memoized = yield* Effect.cached(
              cachedIsCurrent
                ? Effect.succeed({ probe: cachedProbe, fresh: false })
                : probeWebUrl(url).pipe(
                    Effect.map((result) => ({
                      probe: { pid, isWeb: result !== null, expiresAtMillis: 0 },
                      fresh: true,
                    })),
                  ),
            );
            batchProbes.set(identity, memoized);
            return [memoized] as const;
          }),
        )
        .pipe(Effect.flatMap(([probe]) => probe));
    };
    const probed = yield* Effect.forEach(
      groups,
      (group) =>
        Effect.gen(function* () {
          const probes: Array<readonly [string, WebProbeCacheEntry, boolean]> = [];
          let visibleUrl: string | null = null;
          for (const url of group.urls) {
            const key = webProbeCacheKey(url);
            const { probe, fresh } = yield* getProbe(url, group.server.pid);
            probes.push([key, probe, fresh]);
            if (probe.isWeb) {
              visibleUrl = url;
              break;
            }
          }
          return { group, probes, visibleUrl };
        }),
      { concurrency: WEB_PROBE_CONCURRENCY },
    );
    const completedAtMillis = yield* Clock.currentTimeMillis;
    const nextCache = new Map(
      [...cached].filter(([, probe]) => probe.expiresAtMillis > completedAtMillis),
    );
    const discovered: DiscoveredLocalServer[] = [];
    const configured = new Map<string, DiscoveredLocalServer>();
    for (const { group, probes, visibleUrl } of probed) {
      for (const [key, probe, fresh] of probes) {
        nextCache.set(
          key,
          fresh ? { ...probe, expiresAtMillis: completedAtMillis + WEB_PROBE_CACHE_TTL_MS } : probe,
        );
      }
      if (visibleUrl === null) continue;
      const server = { ...group.server, url: visibleUrl };
      if (group.configuredKey === null) discovered.push(server);
      else configured.set(group.configuredKey, server);
    }
    yield* Ref.set(webProbeCacheRef, nextCache);
    return { discovered, configured } satisfies WebProbeSnapshot;
  });

  const recoverProcessProbeFailure =
    (probe: "lsof" | "windows-listeners") => (error: ProcessRunner.ProcessRunError) =>
      Effect.logDebug("preview port process probe failed; falling back to common-port probes", {
        cause: error,
        probe,
        platform: hostPlatform,
      }).pipe(Effect.as(null));

  const scanUnlocked = Effect.fn("PortDiscovery.scanUnlocked")(function* (
    configuredUrls: ReadonlyArray<string>,
  ) {
    const state = yield* Ref.get(stateRef);
    const terminalOwners = new Map<number, ServerOwner>();
    for (const registration of state.terminalProcesses.values()) {
      for (const processId of registration.processIds) {
        terminalOwners.set(processId, { terminal: registration.owner, agent: null });
      }
    }
    if (hostPlatform === "win32") {
      const recoverWindowsProbeFailure = recoverProcessProbeFailure("windows-listeners");
      const command =
        'Get-NetTCPConnection -State Listen -ErrorAction Stop | ForEach-Object { $processName = (Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue).ProcessName; Write-Output "$($_.LocalAddress)|$($_.LocalPort)|$($_.OwningProcess)|$processName" }';
      const listeners = yield* processRunner
        .run({
          command: "powershell.exe",
          args: ["-NoProfile", "-NonInteractive", "-Command", command],
          timeout: Duration.millis(WINDOWS_LISTENER_TIMEOUT_MS),
          maxOutputBytes: 1024 * 1024,
          outputMode: "truncate",
        })
        .pipe(
          Effect.map((result) => parseWindowsListenerOutput(result.stdout, terminalOwners)),
          Effect.catchTags({
            ProcessSpawnError: recoverWindowsProbeFailure,
            ProcessStdinError: recoverWindowsProbeFailure,
            ProcessOutputLimitError: recoverWindowsProbeFailure,
            ProcessReadError: recoverWindowsProbeFailure,
            ProcessTimeoutError: recoverWindowsProbeFailure,
          }),
        );
      if (listeners !== null) return yield* probeWebServers(listeners, configuredUrls);
      return yield* probeWebServers(yield* probeCommonPorts(), configuredUrls);
    }
    const recoverLsofProbeFailure = recoverProcessProbeFailure("lsof");
    const lsofResult = yield* processRunner
      .run({
        command: "lsof",
        args: ["-iTCP", "-sTCP:LISTEN", "-P", "-n", "-F", "pcn"],
        timeout: Duration.millis(LSOF_TIMEOUT_MS),
        maxOutputBytes: 1024 * 1024,
        outputMode: "truncate",
      })
      .pipe(
        Effect.flatMap((result) =>
          withAgentOwners(terminalOwners, lsofProcessIds(result.stdout)).pipe(
            Effect.map((owners) => parseLsofOutput(result.stdout, owners)),
          ),
        ),
        Effect.catchTags({
          ProcessSpawnError: recoverLsofProbeFailure,
          ProcessStdinError: recoverLsofProbeFailure,
          ProcessOutputLimitError: recoverLsofProbeFailure,
          ProcessReadError: recoverLsofProbeFailure,
          ProcessTimeoutError: recoverLsofProbeFailure,
        }),
      );
    if (lsofResult !== null) return yield* probeWebServers(lsofResult, configuredUrls);
    return yield* probeWebServers(yield* probeCommonPorts(), configuredUrls);
  });

  const scanSnapshot = Effect.fn("PortDiscovery.scanSnapshot")(
    (configuredUrls: ReadonlyArray<string>) =>
      scanSemaphore.withPermits(1)(scanUnlocked(configuredUrls)),
  );

  const scanOnce: PortDiscovery["Service"]["scan"] = (configuredUrls = []) => {
    const normalized = normalizeConfiguredUrls(configuredUrls);
    return scanSnapshot(normalized).pipe(
      Effect.map((snapshot) => projectWebProbeSnapshot(snapshot, normalized)),
    );
  };

  const pollTick = Effect.fn("PortDiscovery.pollTick")(
    function* () {
      const configuredUrls = [
        ...new Set(
          [...(yield* Ref.get(stateRef)).listeners.values()].flatMap(
            (subscription) => subscription.configuredUrls,
          ),
        ),
      ];
      const snapshot = yield* scanSnapshot(configuredUrls);
      const notifications = yield* Ref.modify(stateRef, (state) => {
        const listeners = new Map(state.listeners);
        const changed: Array<readonly [Listener, ReadonlyArray<DiscoveredLocalServer>]> = [];
        for (const [listener, subscription] of listeners) {
          const next = projectWebProbeSnapshot(snapshot, subscription.configuredUrls);
          if (serversEqual(subscription.lastSnapshot, next)) continue;
          listeners.set(listener, { ...subscription, lastSnapshot: next });
          changed.push([listener, next]);
        }
        return [changed, { ...state, listeners }];
      });
      yield* Effect.forEach(notifications, ([listener, servers]) => listener(servers), {
        discard: true,
      });
    },
    Effect.catchCause((cause: Cause.Cause<never>) =>
      Effect.logWarning("preview port scan failed", Cause.pretty(cause)),
    ),
  );

  // Single layer-scoped polling fiber. Ticks skip the scan and its span when no
  // client is currently retained, so the cost is one Ref.get every POLL_INTERVAL.
  const pollIfRetained = Ref.get(stateRef).pipe(
    Effect.flatMap((state) => (state.retainCount > 0 ? pollTick() : Effect.void)),
  );
  yield* Effect.forkScoped(pollIfRetained.pipe(Effect.repeat(Schedule.spaced(POLL_INTERVAL))));

  const acquireRetention = Effect.fn("PortDiscovery.retain")(function* () {
    const wasIdle = yield* Ref.modify(stateRef, (state) => [
      state.retainCount === 0,
      { ...state, retainCount: state.retainCount + 1 },
    ]);
    if (wasIdle) {
      // Run an immediate scan + broadcast so the new retainer doesn't have
      // to wait up to POLL_INTERVAL for the first emission.
      yield* pollTick();
    }
  });

  const releaseRetention = Effect.gen(function* () {
    const idle = yield* Ref.modify(stateRef, (state) => {
      const retainCount = Math.max(0, state.retainCount - 1);
      return [retainCount === 0, { ...state, retainCount }];
    });
    if (idle) yield* Ref.set(agentThreadsRef, new Map());
  });

  const retain: PortDiscovery["Service"]["retain"] = Effect.acquireRelease(
    acquireRetention(),
    () => releaseRetention,
  );

  const subscribe: PortDiscovery["Service"]["subscribe"] = Effect.fn("PortDiscovery.subscribe")(
    (input, listener) =>
      Effect.acquireRelease(
        Ref.update(stateRef, (state) => {
          const listeners = new Map(state.listeners);
          listeners.set(listener, {
            configuredUrls: normalizeConfiguredUrls(input.configuredUrls),
            lastSnapshot: input.initialSnapshot,
          });
          return { ...state, listeners };
        }),
        () =>
          Ref.update(stateRef, (state) => {
            const listeners = new Map(state.listeners);
            listeners.delete(listener);
            return { ...state, listeners };
          }),
      ),
  );

  const registerTerminalProcesses: PortDiscovery["Service"]["registerTerminalProcesses"] =
    Effect.fn("PortDiscovery.registerTerminalProcesses")(function* (input) {
      const owner = {
        threadId: ThreadId.make(input.threadId),
        terminalId: input.terminalId,
      };
      const processIds = new Set(
        input.processIds.filter((processId) => Number.isInteger(processId) && processId > 0),
      );
      yield* Ref.update(stateRef, (state) => {
        const terminalProcesses = new Map(state.terminalProcesses);
        const key = terminalOwnerKey(owner);
        if (processIds.size === 0) {
          terminalProcesses.delete(key);
        } else {
          terminalProcesses.set(key, { owner, processIds });
        }
        return { ...state, terminalProcesses };
      });
    });

  const unregisterTerminal: PortDiscovery["Service"]["unregisterTerminal"] = Effect.fn(
    "PortDiscovery.unregisterTerminal",
  )(function* (input) {
    yield* Ref.update(stateRef, (state) => {
      const terminalProcesses = new Map(state.terminalProcesses);
      terminalProcesses.delete(terminalOwnerKey(input));
      return { ...state, terminalProcesses };
    });
  });

  // Fails when `ps` does, so an empty table never reads as every process having exited.
  const readProcessTable = Effect.suspend(() =>
    processRunner.run({
      command: "ps",
      args: ["-A", "-o", "pid=,ppid=,pgid="],
      timeout: Duration.millis(PS_TIMEOUT_MS),
      maxOutputBytes: PS_MAX_OUTPUT_BYTES,
    }),
  ).pipe(
    Effect.mapError((cause) => new PreviewStopLocalServerError({ reason: "signal-failed", cause })),
    Effect.filterOrFail(
      (result) => result.code === 0,
      () => new PreviewStopLocalServerError({ reason: "signal-failed" }),
    ),
    Effect.map((result) => parseProcessTable(result.stdout)),
  );

  const signalUntilStopped = Effect.fn("PortDiscovery.signalUntilStopped")(function* (
    input: PreviewStopLocalServerInput,
  ) {
    if (hostPlatform === "win32") {
      return yield* new PreviewStopLocalServerError({ reason: "unsupported" });
    }
    // The pid comes from a client, so only a server this scan attributes to a thread is signaled,
    // from its environment as read now.
    yield* Ref.update(agentThreadsRef, (threads) => {
      const next = new Map(threads);
      next.delete(input.pid);
      return next;
    });
    const listed = (yield* scanOnce()).some(
      (server) => server.pid === input.pid && server.port === input.port && isOwned(server),
    );
    if (!listed) return yield* new PreviewStopLocalServerError({ reason: "not-found" });
    const table = yield* readProcessTable;
    // It exited after the scan, so there is nothing left to stop.
    if (!table.has(input.pid)) return;
    const group = stoppableProcessGroup(table, input.pid, process.pid);
    if (group === null) return yield* new PreviewStopLocalServerError({ reason: "shared-group" });
    // False when the whole group already exited.
    const signalGroup = (signal: "SIGTERM" | "SIGKILL") =>
      Effect.suspend(() => {
        try {
          signalProcessGroup(group, signal);
          return Effect.succeed(true);
        } catch (cause) {
          return isNoSuchProcess(cause)
            ? Effect.succeed(false)
            : Effect.fail(new PreviewStopLocalServerError({ reason: "signal-failed", cause }));
        }
      });
    if (!(yield* signalGroup("SIGTERM"))) return;
    // While one of the group's original members is still in it, the group has not been reused,
    // so SIGKILL goes only to the job that ignored SIGTERM.
    const members = [...table.values()].filter((row) => row.pgid === group).map((row) => row.pid);
    const jobRunning = readProcessTable.pipe(
      Effect.map((current) => members.some((pid) => current.get(pid)?.pgid === group)),
      Effect.orElseSucceed(() => false),
    );
    const deadline = (yield* Clock.currentTimeMillis) + STOP_GRACE_MS;
    while ((yield* Clock.currentTimeMillis) < deadline) {
      yield* Effect.sleep(STOP_POLL_INTERVAL);
      if (!(yield* jobRunning)) return;
    }
    yield* signalGroup("SIGKILL");
  });

  const stopServer: PortDiscovery["Service"]["stopServer"] = (input) =>
    // Subscribers see the server leave now rather than on the next poll.
    signalUntilStopped(input).pipe(Effect.andThen(pollIfRetained));

  return PortDiscovery.of({
    scan: scanOnce,
    subscribe,
    retain,
    registerTerminalProcesses,
    unregisterTerminal,
    stopServer,
  });
}).pipe(Effect.withSpan("PortDiscovery.make"));

export const layer = Layer.effect(PortDiscovery, make);
