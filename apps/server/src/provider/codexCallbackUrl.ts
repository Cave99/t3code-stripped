export function codexCallbackUrl(value: string, redirectUri: string, state: string) {
  const callback = new URL(value);
  const expected = new URL(redirectUri);
  const states = callback.searchParams.getAll("state");
  const codes = callback.searchParams.getAll("code");
  const errors = callback.searchParams.getAll("error");
  const clients = callback.searchParams.getAll("client_id");
  if (
    value.length > 16_384 ||
    callback.origin !== expected.origin ||
    callback.pathname !== expected.pathname ||
    callback.username ||
    callback.password ||
    callback.hash ||
    states.length !== 1 ||
    states[0] !== state ||
    clients.length > 1 ||
    (clients.length === 1 && !/^oaiapp_[\w-]+$/u.test(clients[0]!)) ||
    !(
      (codes.length === 1 && Boolean(codes[0]) && errors.length === 0) ||
      (errors.length === 1 && Boolean(errors[0]) && codes.length === 0)
    )
  )
    throw new Error("This redirect URL does not belong to the current sign-in.");
  return callback;
}
