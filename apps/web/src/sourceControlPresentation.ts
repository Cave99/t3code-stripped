import type { ElementType } from "react";
import type { SourceControlProviderInfo, SourceControlProviderKind } from "@t3tools/contracts";
export {
  DEFAULT_CHANGE_REQUEST_TERMINOLOGY,
  getChangeRequestTerminology,
  resolveChangeRequestPresentation,
  type ChangeRequestTerminology,
} from "@t3tools/shared/sourceControl";
import {
  getChangeRequestTerminology,
  resolveChangeRequestPresentation,
  type ChangeRequestTerminology,
} from "@t3tools/shared/sourceControl";
import { GitHubIcon } from "./components/Icons";
import { PullRequestGlyph } from "~/components/pullRequest/pullRequestIcons";

export interface SourceControlPresentation {
  readonly providerName: string;
  readonly terminology: ChangeRequestTerminology;
  readonly Icon: ElementType<{ className?: string }>;
}

export function getSourceControlPresentation(
  provider: SourceControlProviderInfo | null | undefined,
): SourceControlPresentation {
  const presentation = resolveChangeRequestPresentation(provider);
  return {
    providerName: provider?.name || presentation.providerName,
    terminology: getChangeRequestTerminology(provider),
    Icon: presentation.icon === "github" ? GitHubIcon : PullRequestGlyph.pullRequest,
  };
}

/** For surfaces that know only the host kind, such as a change request row or filter. */
export function getSourceControlPresentationForKind(
  kind: SourceControlProviderKind,
): SourceControlPresentation {
  return getSourceControlPresentation({ kind, name: "", baseUrl: "" });
}
