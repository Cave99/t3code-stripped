import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as WorkspaceFolders from "./WorkspaceFolders.ts";

/** A project with no tracked folders: every thread works in its own folder alone. */
export const layerNoFolders = Layer.mock(WorkspaceFolders.WorkspaceFolders)({
  forThread: () => Effect.succeed({ folders: [], extraRoots: [] }),
});

/** `layerNoFolders` with the platform services checkpointing reads folders through. */
export const layerNoFoldersWithPlatform = Layer.merge(layerNoFolders, NodeServices.layer);
