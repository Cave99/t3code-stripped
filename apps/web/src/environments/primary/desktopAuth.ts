export function readDesktopPrimaryBearerToken(): Promise<string | null> {
  return Promise.resolve(
    typeof window === "undefined"
      ? null
      : (window.desktopBridge?.getLocalEnvironmentBootstrap()?.bootstrapToken ?? null),
  );
}
