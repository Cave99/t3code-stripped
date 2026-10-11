import {
  OtlpHeadersFromString,
  OtlpProtocol,
  type SignalExport,
} from "@t3tools/shared/observability";
import * as OtelEnvironment from "@t3tools/shared/otelEnvironment";
import { parsePersistedServerObservabilitySettings } from "@t3tools/shared/serverSettings";
import { DesktopBackendBootstrap, PortSchema } from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as LogLevel from "effect/LogLevel";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import * as SchemaTransformation from "effect/SchemaTransformation";
import { Argument, Flag } from "effect/unstable/cli";

import { readBootstrapEnvelope } from "../bootstrap.ts";
import * as ServerConfig from "../config.ts";
import { expandHomePath, resolveBaseDir } from "../os-jank.ts";

const portFlag = Flag.Int("port").pipe(
  Flag.withSchema(PortSchema),
  Flag.withDescription("Port for the HTTP/WebSocket server."),
  Flag.optional,
);
export const baseDirFlag = Flag.String("base-dir").pipe(
  Flag.withDescription(
    "Explicit C3 Code data directory; runtime state is stored under userdata (equivalent to T3CODE_HOME).",
  ),
  Flag.optional,
);
const bootstrapFdFlag = Flag.Int("bootstrap-fd").pipe(
  Flag.withSchema(Schema.Int),
  Flag.withDescription("Read one-time bootstrap secrets from the given file descriptor."),
  Flag.optional,
);
const autoBootstrapProjectFromCwdFlag = Flag.Boolean("auto-bootstrap-project-from-cwd").pipe(
  Flag.withDescription(
    "Create a project for the current working directory on startup when missing.",
  ),
  Flag.optional,
);
const logWebSocketEventsFlag = Flag.Boolean("log-websocket-events").pipe(
  Flag.withDescription(
    "Emit server-side logs for outbound WebSocket push traffic (equivalent to T3CODE_LOG_WS_EVENTS).",
  ),
  Flag.withAlias("log-ws-events"),
  Flag.optional,
);

// Trace file location, shared by the server and `t3 trace summary`.
export const traceFileConfig = Config.String("T3CODE_TRACE_FILE").pipe(
  Config.option,
  Config.map(Option.getOrUndefined),
);
export const traceMaxFilesConfig = Config.Int("T3CODE_TRACE_MAX_FILES").pipe(
  Config.withDefault(10),
);

const EnvServerConfig = Config.all({
  logLevel: Config.LogLevel("T3CODE_LOG_LEVEL").pipe(Config.withDefault("Info")),
  traceMinLevel: Config.LogLevel("T3CODE_TRACE_MIN_LEVEL").pipe(Config.withDefault("Info")),
  traceTimingEnabled: Config.Boolean("T3CODE_TRACE_TIMING_ENABLED").pipe(Config.withDefault(true)),
  traceFile: traceFileConfig,
  traceMaxBytes: Config.Int("T3CODE_TRACE_MAX_BYTES").pipe(Config.withDefault(10 * 1024 * 1024)),
  traceMaxFiles: traceMaxFilesConfig,
  traceBatchWindowMs: Config.Int("T3CODE_TRACE_BATCH_WINDOW_MS").pipe(Config.withDefault(1_000)),
  otlpTracesUrl: Config.String("T3CODE_OTLP_TRACES_URL").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  otlpMetricsUrl: Config.String("T3CODE_OTLP_METRICS_URL").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  otlpLogsUrl: Config.String("T3CODE_OTLP_LOGS_URL").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  otlpExportIntervalMs: Config.Int("T3CODE_OTLP_EXPORT_INTERVAL_MS").pipe(
    Config.withDefault(10_000),
  ),
  otlpHeaders: Config.schema(OtlpHeadersFromString, "T3CODE_OTLP_HEADERS").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  otlpProtocol: Config.schema(OtlpProtocol, "T3CODE_OTLP_PROTOCOL").pipe(
    Config.withDefault("http/json"),
  ),
  port: Config.Port("T3CODE_PORT").pipe(Config.option, Config.map(Option.getOrUndefined)),
  t3Home: Config.String("T3CODE_HOME").pipe(Config.option, Config.map(Option.getOrUndefined)),
  devUrl: Config.URL("VITE_DEV_SERVER_URL").pipe(Config.option, Config.map(Option.getOrUndefined)),
  bootstrapFd: Config.Int("T3CODE_BOOTSTRAP_FD").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  autoBootstrapProjectFromCwd: Config.Boolean("T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  logWebSocketEvents: Config.Boolean("T3CODE_LOG_WS_EVENTS").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
});

export interface CliServerFlags {
  readonly port: Option.Option<number>;
  readonly baseDir: Option.Option<string>;
  readonly cwd: Option.Option<string>;
  readonly bootstrapFd: Option.Option<number>;
  readonly autoBootstrapProjectFromCwd: Option.Option<boolean>;
  readonly logWebSocketEvents: Option.Option<boolean>;
}

export const sharedServerCommandFlags = {
  port: portFlag,
  baseDir: baseDirFlag,
  cwd: Argument.String("cwd").pipe(
    Argument.withDescription(
      "Working directory for provider sessions (defaults to the current directory).",
    ),
    Argument.optional,
  ),
  bootstrapFd: bootstrapFdFlag,
  autoBootstrapProjectFromCwd: autoBootstrapProjectFromCwdFlag,
  logWebSocketEvents: logWebSocketEventsFlag,
} as const;

const resolveOptionPrecedence = <Value>(
  ...values: ReadonlyArray<Option.Option<Value>>
): Option.Option<Value> => Option.firstSomeOf(values);

const loadPersistedObservabilitySettings = Effect.fn(function* (settingsPath: string) {
  const fs = yield* FileSystem.FileSystem;
  const exists = yield* fs.exists(settingsPath).pipe(Effect.orElseSucceed(() => false));
  if (!exists) {
    return { otlpTracesUrl: undefined, otlpMetricsUrl: undefined, otlpLogsUrl: undefined };
  }

  const raw = yield* fs.readFileString(settingsPath).pipe(Effect.orElseSucceed(() => ""));
  return parsePersistedServerObservabilitySettings(raw);
});

export const resolveServerConfig = (
  flags: CliServerFlags,
  cliLogLevel: Option.Option<LogLevel.LogLevel>,
  options?: {
    readonly forceAutoBootstrapProjectFromCwd?: boolean;
  },
) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const env = yield* EnvServerConfig;
    const normalizedFlags = {
      port: flags.port ?? Option.none(),
      baseDir: flags.baseDir ?? Option.none(),
      cwd: flags.cwd ?? Option.none(),
      bootstrapFd: flags.bootstrapFd ?? Option.none(),
      autoBootstrapProjectFromCwd: flags.autoBootstrapProjectFromCwd ?? Option.none(),
      logWebSocketEvents: flags.logWebSocketEvents ?? Option.none(),
    } satisfies CliServerFlags;
    const bootstrapFd = Option.getOrUndefined(normalizedFlags.bootstrapFd) ?? env.bootstrapFd;
    const bootstrapEnvelope =
      bootstrapFd !== undefined
        ? yield* readBootstrapEnvelope(DesktopBackendBootstrap, bootstrapFd)
        : Option.none();
    const bootstrap = Option.getOrUndefined(bootstrapEnvelope);

    const port = yield* Option.match(
      resolveOptionPrecedence(
        normalizedFlags.port,
        Option.fromUndefinedOr(env.port),
        Option.fromUndefinedOr(bootstrap?.port),
      ),
      {
        onSome: (value) => Effect.succeed(value),
        onNone: () => Effect.succeed(ServerConfig.DEFAULT_PORT),
      },
    );
    // Set by the desktop dev runner. Selects the dev state dir and the
    // renderer origin the CORS layer allows.
    const devUrl = env.devUrl;
    const explicitBaseDir = resolveOptionPrecedence(
      normalizedFlags.baseDir,
      Option.fromUndefinedOr(env.t3Home),
    ).pipe(Option.filter((value) => value.trim().length > 0));
    const baseDir = yield* resolveBaseDir(
      Option.getOrUndefined(
        resolveOptionPrecedence(explicitBaseDir, Option.fromUndefinedOr(bootstrap?.t3Home)),
      ),
    );
    const rawCwd = Option.getOrElse(normalizedFlags.cwd, () => process.cwd());
    const cwd = path.resolve(yield* expandHomePath(rawCwd.trim()));
    yield* fs.makeDirectory(cwd, { recursive: true });
    const derivedPaths = yield* ServerConfig.deriveServerPaths(baseDir, devUrl, {
      baseDirIsExplicit: Option.isSome(explicitBaseDir),
    });
    yield* ServerConfig.ensureServerDirectories(derivedPaths);
    const persistedObservabilitySettings = yield* loadPersistedObservabilitySettings(
      derivedPaths.settingsPath,
    );
    const serverTracePath = env.traceFile ?? derivedPaths.serverTracePath;
    yield* fs.makeDirectory(path.dirname(serverTracePath), { recursive: true });
    const desktopBootstrapToken = bootstrap?.desktopBootstrapToken;
    const shellEnvironmentPrepared = bootstrap?.shellEnvironmentPrepared;
    const desktopTelemetryFd = bootstrap?.desktopTelemetryFd;
    const desktopTelemetryControlFd = bootstrap?.desktopTelemetryControlFd;
    const resourceMonitorPath = bootstrap?.resourceMonitorPath;
    const autoBootstrapProjectFromCwd = Option.getOrElse(
      resolveOptionPrecedence(
        Option.fromUndefinedOr(options?.forceAutoBootstrapProjectFromCwd),
        normalizedFlags.autoBootstrapProjectFromCwd,
        Option.fromUndefinedOr(env.autoBootstrapProjectFromCwd),
      ),
      () => false,
    );
    const logWebSocketEvents = Option.getOrElse(
      resolveOptionPrecedence(
        normalizedFlags.logWebSocketEvents,
        Option.fromUndefinedOr(env.logWebSocketEvents),
      ),
      () => Boolean(devUrl),
    );
    const host = bootstrap?.host ?? "127.0.0.1";
    const logLevel = Option.getOrElse(cliLogLevel, () => env.logLevel);

    const otel = yield* OtelEnvironment.load;

    // C3 Code's own OTLP variables name no signal, so the one answer they give
    // is the answer for all three.
    const signalExport: SignalExport = {
      protocol: env.otlpProtocol,
      headers: env.otlpHeaders,
      exportIntervalMs: env.otlpExportIntervalMs,
    };
    const traces = OtelEnvironment.resolveSignalEndpoint(
      otel,
      "traces",
      { url: env.otlpTracesUrl, export: signalExport },
      bootstrap?.otlpTracesUrl,
      persistedObservabilitySettings.otlpTracesUrl,
    );
    const metrics = OtelEnvironment.resolveSignalEndpoint(
      otel,
      "metrics",
      { url: env.otlpMetricsUrl, export: signalExport },
      bootstrap?.otlpMetricsUrl,
      persistedObservabilitySettings.otlpMetricsUrl,
    );
    const logs = OtelEnvironment.resolveSignalEndpoint(
      otel,
      "logs",
      { url: env.otlpLogsUrl, export: signalExport },
      bootstrap?.otlpLogsUrl,
      persistedObservabilitySettings.otlpLogsUrl,
    );

    const config: ServerConfig.ServerConfig["Service"] = {
      logLevel,
      traceMinLevel: env.traceMinLevel,
      traceTimingEnabled: env.traceTimingEnabled,
      traceBatchWindowMs: env.traceBatchWindowMs,
      traceMaxBytes: env.traceMaxBytes,
      traceMaxFiles: env.traceMaxFiles,
      otlpTracesUrl: traces?.url,
      otlpMetricsUrl: metrics?.url,
      otlpLogsUrl: logs?.url,
      otlpTracesExport: traces?.export ?? signalExport,
      otlpMetricsExport: metrics?.export ?? signalExport,
      otlpLogsExport: logs?.export ?? signalExport,
      otelEnvironment: otel,
      port,
      cwd,
      baseDir,
      ...derivedPaths,
      serverTracePath,
      host,
      devUrl,
      desktopBootstrapToken,
      ...(shellEnvironmentPrepared === undefined ? {} : { shellEnvironmentPrepared }),
      desktopTelemetryFd,
      desktopTelemetryControlFd,
      resourceMonitorPath,
      autoBootstrapProjectFromCwd,
      logWebSocketEvents,
    };

    return config;
  });

const DurationShorthandPattern = /^(?<value>\d+)(?<unit>ms|s|m|h|d|w)$/i;

const parseDurationInput = (value: string): Duration.Duration | null => {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;

  const shorthand = DurationShorthandPattern.exec(trimmed);
  const normalizedInput = shorthand?.groups
    ? (() => {
        const amountText = shorthand.groups.value;
        const unitText = shorthand.groups.unit;
        if (typeof amountText !== "string" || typeof unitText !== "string") {
          return null;
        }

        const amount = Number.parseInt(amountText, 10);
        if (!Number.isFinite(amount)) return null;

        switch (unitText.toLowerCase()) {
          case "ms":
            return `${amount} millis`;
          case "s":
            return `${amount} seconds`;
          case "m":
            return `${amount} minutes`;
          case "h":
            return `${amount} hours`;
          case "d":
            return `${amount} days`;
          case "w":
            return `${amount} weeks`;
          default:
            return null;
        }
      })()
    : (trimmed as Duration.Input);

  if (normalizedInput === null) return null;

  const decoded = Duration.fromInput(normalizedInput as Duration.Input);
  return Option.isSome(decoded) ? decoded.value : null;
};

export const DurationFromString = Schema.String.pipe(
  Schema.decodeTo(
    Schema.Duration,
    SchemaTransformation.transformEffect({
      decode: (value) => {
        const duration = parseDurationInput(value);
        if (duration !== null) {
          return Effect.succeed(duration);
        }
        return Effect.fail(
          new SchemaIssue.InvalidValue({
            message: "Invalid duration. Use values like 5m, 1h, 30d, or 15 minutes.",
          }),
        );
      },
      encode: (duration) => Effect.succeed(Duration.format(duration)),
    }),
  ),
);
