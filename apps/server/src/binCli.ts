import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Command } from "effect/unstable/cli";

import * as NetService from "@t3tools/shared/Net";
import packageJson from "../package.json" with { type: "json" };
import { sharedServerCommandFlags } from "./cli/config.ts";
import { runServerCommand } from "./cli/server.ts";
import { claudeHistoryCommand } from "./cli/claudeHistory.ts";
import { traceCommand } from "./cli/trace.ts";

const CliRuntimeLayer = Layer.mergeAll(NodeServices.layer, NetService.layer);

const makeCli = () =>
  Command.make("t3", { ...sharedServerCommandFlags }).pipe(
    Command.withDescription("Run the C3 Code server."),
    Command.withHandler((flags) => runServerCommand(flags)),
    Command.withSubcommands([claudeHistoryCommand, traceCommand]),
  );

const cli = makeCli();

export function runCli() {
  Command.run(cli, { version: packageJson.version }).pipe(
    Effect.scoped,
    Effect.provide(CliRuntimeLayer),
    NodeRuntime.runMain,
  );
}
