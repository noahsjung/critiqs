// Every Critiqs deployment trusts tokens from Critiqs's sign-in service, which
// verifies reviewers' email addresses with one-time codes and issues its own short-lived
// tokens (see http.ts and lib/tokens.ts). CRITIQS_AUTH_ISSUER is that service's
// site URL: the hosted deployment names itself, and own deployments name the
// hosted one, so they need no sign-in setup of their own.
const issuer = (process.env.CRITIQS_AUTH_ISSUER ?? "").replace(/\/$/, "");

export default {
  providers: [
    {
      type: "customJwt",
      issuer,
      jwks: `${issuer}/.well-known/jwks.json`,
      algorithm: "ES256",
      applicationID: "critiqs",
    },
  ],
};
