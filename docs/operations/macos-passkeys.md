# Build macOS browser passkey support

Passkeys require a signed build. Run the desktop artifact build with `--signed` (or
`T3CODE_DESKTOP_SIGNED=true`), configure the usual electron-builder Developer ID signing
identity, and set:

- `T3CODE_APPLE_TEAM_ID`: your ten-character Apple developer team ID.
- `T3CODE_MACOS_PROVISIONING_PROFILE`: the provisioning profile for `com.t3tools.t3code`.
  Relative paths resolve from the repository root.

For the system passkey sheet (iCloud Keychain, password managers, phones, and security keys),
request Apple's managed `com.apple.developer.web-browser.public-key-credential` entitlement
and regenerate the profile with that grant. Apple requires the Account Holder of an
organization's developer account to [request macOS browser passkeys access](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.web-browser.public-key-credential).

For Electron's separate, Mac-local Touch ID authenticator, the profile must authorize
`<TEAM_ID>.com.t3tools.t3code.webauthn` in `keychain-access-groups` (a matching wildcard also
works). The build embeds the profile and emits only the passkey entitlements it grants;
its log reports which paths are enabled. No Clerk configuration or associated domain is
needed for this fork's browser.

Unsigned artifacts, unpackaged development builds, and signed builds without a profile
do not enable either macOS passkey path. Pages retain Chromium's native WebAuthn behavior;
the added system-sheet bridge and Touch ID configuration are absent. Use a suitably signed
artifact to verify passkey ceremonies; unsigned development cannot verify them.
