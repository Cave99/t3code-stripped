import { createFileRoute, useLocation, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";

import { NoProjectsHero } from "../components/NoProjectsHero";
import { WelcomeWizard } from "../components/onboarding/WelcomeWizard";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";

const decodeEnvironmentId = Schema.decodeOption(EnvironmentId);

/** Onboarding overlays the workspace. Visiting /welcome reopens setup. */
export const Route = createFileRoute("/welcome")({
  component: WelcomeRouteView,
});

function WelcomeRouteView() {
  const { localEnvironmentEnabled } = Route.useRouteContext();
  const navigate = useNavigate();
  const hash = useLocation({ select: (location) => location.hash });
  const resumeEnvironmentId = hash.startsWith("agents:")
    ? Option.getOrUndefined(decodeEnvironmentId(hash.slice("agents:".length)))
    : undefined;
  // The root shell can remount this pending outlet after the location changes.
  // Never reopen setup while the destination route is still loading.
  const isWelcomeRoute = useLocation({ select: (location) => location.pathname === "/welcome" });
  const [dismissed, setDismissed] = useState(false);
  const openNewThread = useNewThreadHandler();
  return (
    <>
      <NoProjectsHero />
      {isWelcomeRoute && !dismissed ? (
        <WelcomeWizard
          localAvailable={localEnvironmentEnabled}
          resumeEnvironmentId={resumeEnvironmentId}
          onDone={async (projectRef) => {
            setDismissed(true);
            if (projectRef !== undefined) {
              await openNewThread(projectRef, { replace: true }).catch(() =>
                navigate({ to: "/", replace: true }),
              );
              return;
            }
            await navigate({ to: "/", replace: true });
          }}
        />
      ) : null}
    </>
  );
}
