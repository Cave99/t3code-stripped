import type { EnvironmentId } from "@t3tools/contracts";

/** Editors open on this machine, so the picker only applies to the primary environment. */
export function shouldShowOpenInPicker(input: {
  readonly activeProjectName: string | undefined;
  readonly activeThreadEnvironmentId: EnvironmentId;
  readonly primaryEnvironmentId: EnvironmentId | null;
}): boolean {
  return (
    input.activeProjectName !== undefined &&
    input.activeProjectName.length > 0 &&
    input.activeThreadEnvironmentId === input.primaryEnvironmentId
  );
}
