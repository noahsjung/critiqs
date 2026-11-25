// Critiqs's own sign-in tokens. Once a reviewer proves they control their email
// address with a one-time code, Critiqs issues a short-lived ES256 token that names the reviewer, their verified
// email, and the site they allowed. Every Critiqs deployment trusts this issuer
// (see auth.config.ts), so own deployments need no sign-in setup of their own.

/** Audience every Critiqs token carries; deployments reject tokens without it. */
export const TOKEN_AUDIENCE = "critiqs";
export const ACCESS_TOKEN_SECONDS = 15 * 60;
export const SESSION_DAYS = 30;
/** A session ends this long after sign-in, however often it is used. */
export const SESSION_MAX_DAYS = 90;

export interface ReviewerProfile {
  /** The reviewer's permanent Critiqs ID, independent of how they signed in. */
  subject: string;
  name: string;
  email: string;
  pictureUrl: string | null;
  /** Increases with each display name change, so deployments ignore names from older tokens. */
  profileVersion?: number;
}

interface SigningKey {
  key: CryptoKey;
  publicJwk: JsonWebKey & { kid: string };
}

let cachedKey: { source: string; signing: Promise<SigningKey> } | null = null;

/** Reads the private signing key (a P-256 JWK) from `CRITIQS_AUTH_PRIVATE_KEY`. */
export function signingKey(): Promise<SigningKey> {
  const source = process.env.CRITIQS_AUTH_PRIVATE_KEY;
  if (source === undefined || source === "") throw new Error("CRITIQS_AUTH_PRIVATE_KEY is not set.");
  if (cachedKey?.source !== source) cachedKey = { source, signing: importSigningKey(source) };
  return cachedKey.signing;
}

async function importSigningKey(source: string): Promise<SigningKey> {
  const jwk = JSON.parse(source) as JsonWebKey & { kid?: string };
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const { kty, crv, x, y } = jwk;
  const kid = jwk.kid ?? (await thumbprint({ crv, kty, x, y }));
  return { key, publicJwk: { kty, crv, x, y, kid, alg: "ES256", use: "sig" } };
}

/** RFC 7638 key thumbprint, used as the key ID when none is configured. */
async function thumbprint(members: Record<string, unknown>): Promise<string> {
  const canonical = JSON.stringify(members, Object.keys(members).sort());
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical))));
}

/**
 * Issues an access token for one reviewer and one allowed site. It never
 * outlives `notAfter`, the end of the session it comes from.
 */
export async function issueAccessToken(
  issuer: string,
  profile: ReviewerProfile,
  origin: string,
  now = Date.now(),
  notAfter = Number.POSITIVE_INFINITY,
) {
  const { key, publicJwk } = await signingKey();
  const issuedAt = Math.floor(now / 1000);
  const expiresAt = Math.min(issuedAt + ACCESS_TOKEN_SECONDS, Math.floor(notAfter / 1000));
  const header = { alg: "ES256", typ: "JWT", kid: publicJwk.kid };
  const claims = {
    iss: issuer,
    aud: TOKEN_AUDIENCE,
    sub: profile.subject,
    iat: issuedAt,
    exp: expiresAt,
    name: profile.name,
    email: profile.email,
    email_verified: true,
    picture: profile.pictureUrl ?? undefined,
    profile_version: profile.profileVersion,
    origin,
  };
  const encoder = new TextEncoder();
  const input = `${base64url(encoder.encode(JSON.stringify(header)))}.${base64url(encoder.encode(JSON.stringify(claims)))}`;
  // WebCrypto's ECDSA signature is the raw r||s form that JWS ES256 uses.
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, encoder.encode(input));
  return { accessToken: `${input}.${base64url(new Uint8Array(signature))}`, expiresAt: expiresAt * 1000 };
}

/** A random opaque secret, such as a refresh token. */
export function randomSecret(bytes = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** Refresh tokens are stored only as hashes. */
export async function hashSecret(secret: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret))));
}

export function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
