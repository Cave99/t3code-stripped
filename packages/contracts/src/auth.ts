import * as Schema from "effect/Schema";
import { ClientSurface, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const AuthClientPresentationMetadata = Schema.Struct({
  label: Schema.optionalKey(TrimmedNonEmptyString),
  surface: Schema.optionalKey(ClientSurface),
  appVersion: Schema.optionalKey(TrimmedNonEmptyString),
});
export type AuthClientPresentationMetadata = typeof AuthClientPresentationMetadata.Type;
