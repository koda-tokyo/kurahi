// Test-only helpers: a local fake OIDC provider (discovery, JWKS, token endpoint with PKCE
// check) served through a fetch stub, ID token signing, and a SAML assertion signer. Nothing
// here is imported by production code.
import {
  createHash,
  generateKeyPairSync,
  type KeyObject,
  sign as cryptoSign,
  constants as cryptoConstants,
} from "node:crypto";
import type { IdentityOidcProviderConfig } from "../config/types.identity.js";
import type { FetchLike } from "../connectors/business/http.js";
import { canonicalizeExclusive } from "./saml/c14n.js";
import { parseXml, type XmlElement } from "./saml/xml.js";

export type TestKey = {
  kid: string;
  alg: "RS256" | "ES256" | "PS256";
  privateKey: KeyObject;
  publicKey: KeyObject;
};

export function rsaKey(kid = "k1", alg: "RS256" | "PS256" = "RS256"): TestKey {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return { kid, alg, privateKey, publicKey };
}

export function ecKey(kid = "e1"): TestKey {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return { kid, alg: "ES256", privateKey, publicKey };
}

const b64u = (v: Buffer | string) => Buffer.from(v).toString("base64url");

export function signJwt(
  key: TestKey,
  payload: Record<string, unknown>,
  header: Record<string, unknown> = {},
): string {
  const h = b64u(JSON.stringify({ alg: key.alg, kid: key.kid, typ: "JWT", ...header }));
  const p = b64u(JSON.stringify(payload));
  const input = Buffer.from(`${h}.${p}`);
  const sig =
    key.alg === "ES256"
      ? cryptoSign("sha256", input, { key: key.privateKey, dsaEncoding: "ieee-p1363" })
      : key.alg === "PS256"
        ? cryptoSign("sha256", input, {
            key: key.privateKey,
            padding: cryptoConstants.RSA_PKCS1_PSS_PADDING,
            saltLength: 32,
          })
        : cryptoSign("sha256", input, key.privateKey);
  return `${h}.${p}.${b64u(sig)}`;
}

export const ISSUER = "https://idp.example.test/tenant";
export const CLIENT_ID = "kurahi-console";

export type FakeIdp = {
  fetch: FetchLike;
  keys: TestKey[];
  /** Claims the next token exchange puts in the ID token (nonce comes from the request). */
  nextClaims: Record<string, unknown>;
  /** Override the next ID token completely (replay tests). */
  nextIdToken: string | null;
  lastIdToken: string | null;
  /** code → {challenge, nonce, redirectUri} recorded from the authorization step. */
  authorize(url: string): { code: string; state: string };
  tokenRequests: URLSearchParams[];
};

export function fakeIdp(opts: { now?: () => number; issuer?: string } = {}): FakeIdp {
  const now = opts.now ?? Date.now;
  const issuer = opts.issuer ?? ISSUER;
  const codes = new Map<string, { challenge: string; nonce: string; redirectUri: string }>();
  let n = 0;
  const idp: FakeIdp = {
    keys: [rsaKey("k1")],
    nextClaims: {},
    nextIdToken: null,
    lastIdToken: null,
    tokenRequests: [],
    authorize(url: string) {
      const u = new URL(url);
      const code = `code-${++n}`;
      codes.set(code, {
        challenge: u.searchParams.get("code_challenge") ?? "",
        nonce: u.searchParams.get("nonce") ?? "",
        redirectUri: u.searchParams.get("redirect_uri") ?? "",
      });
      return { code, state: u.searchParams.get("state") ?? "" };
    },
    fetch: async (input, init) => {
      const url = String(input);
      const json = (status: number, body: unknown) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        });
      if (url === `${issuer}/.well-known/openid-configuration`) {
        return json(200, {
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
          end_session_endpoint: `${issuer}/logout`,
        });
      }
      if (url === `${issuer}/jwks`) {
        return json(200, {
          keys: idp.keys.map((k) => ({
            ...(k.publicKey.export({ format: "jwk" }) as object),
            kid: k.kid,
            use: "sig",
            alg: k.alg,
          })),
        });
      }
      if (url === `${issuer}/token` && init?.method === "POST") {
        const form = new URLSearchParams(typeof init.body === "string" ? init.body : "");
        idp.tokenRequests.push(form);
        const entry = codes.get(form.get("code") ?? "");
        codes.delete(form.get("code") ?? "");
        const verifier = form.get("code_verifier") ?? "";
        const challenge = createHash("sha256").update(verifier).digest("base64url");
        if (
          !entry ||
          entry.challenge !== challenge ||
          entry.redirectUri !== form.get("redirect_uri")
        ) {
          return json(400, { error: "invalid_grant" });
        }
        const t = Math.floor(now() / 1000);
        const idToken =
          idp.nextIdToken ??
          signJwt(idp.keys[0], {
            iss: issuer,
            aud: CLIENT_ID,
            sub: "user-1",
            email: "alice@example.com",
            email_verified: true,
            name: "Alice Example",
            groups: ["g-finance"],
            iat: t,
            exp: t + 300,
            nonce: entry.nonce,
            ...idp.nextClaims,
          });
        idp.lastIdToken = idToken;
        return json(200, { access_token: "at", token_type: "Bearer", id_token: idToken });
      }
      return json(404, { error: "not_found" });
    },
  };
  return idp;
}

export function oidcProvider(
  over: Partial<IdentityOidcProviderConfig> = {},
): IdentityOidcProviderConfig {
  return {
    id: "corp",
    kind: "oidc",
    issuer: ISSUER,
    clientId: CLIENT_ID,
    clientSecret: "s3cret",
    ...over,
  };
}

// ── SAML ──────────────────────────────────────────────────────────────────────────────────

export const SAMLP = "urn:oasis:names:tc:SAML:2.0:protocol";
export const SAML = "urn:oasis:names:tc:SAML:2.0:assertion";
export const DS = "http://www.w3.org/2000/09/xmldsig#";

export function selfSignedCertPem(key: { privateKey: KeyObject; publicKey: KeyObject }): string {
  // node:crypto cannot mint X.509; tests pass the public key PEM (importIdpKeys accepts it).
  return key.publicKey.export({ format: "pem", type: "spki" });
}

export type AssertionOptions = {
  requestId: string;
  acsUrl: string;
  audience: string;
  issuer: string;
  nameId?: string;
  nameIdFormat?: string;
  assertionId?: string;
  now: number;
  notOnOrAfterMs?: number;
  attributes?: Record<string, string[]>;
  omitAuthnStatement?: boolean;
  /** Leave AuthnInstant out of the AuthnStatement (it is required; step-up refuses without). */
  omitAuthnInstant?: boolean;
  /** Extra elements inside saml:Conditions (after the AudienceRestriction). */
  extraConditions?: string;
};

const iso = (ms: number) => new Date(ms).toISOString();

export function assertionXml(o: AssertionOptions): string {
  const id = o.assertionId ?? `_a${createHash("sha1").update(String(Math.random())).digest("hex")}`;
  const until = o.notOnOrAfterMs ?? o.now + 5 * 60_000;
  const attrs = Object.entries(
    o.attributes ?? { email: ["alice@example.com"], groups: ["g-finance"] },
  )
    .map(
      ([name, values]) =>
        `<saml:Attribute Name="${name}">${values.map((v) => `<saml:AttributeValue>${v}</saml:AttributeValue>`).join("")}</saml:Attribute>`,
    )
    .join("");
  return (
    `<saml:Assertion xmlns:saml="${SAML}" ID="${id}" Version="2.0" IssueInstant="${iso(o.now)}">` +
    `<saml:Issuer>${o.issuer}</saml:Issuer>` +
    `<saml:Subject><saml:NameID Format="${o.nameIdFormat ?? "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress"}">${o.nameId ?? "alice@example.com"}</saml:NameID>` +
    `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">` +
    `<saml:SubjectConfirmationData InResponseTo="${o.requestId}" Recipient="${o.acsUrl}" NotOnOrAfter="${iso(until)}"/>` +
    `</saml:SubjectConfirmation></saml:Subject>` +
    `<saml:Conditions NotBefore="${iso(o.now - 1000)}" NotOnOrAfter="${iso(until)}">` +
    `<saml:AudienceRestriction><saml:Audience>${o.audience}</saml:Audience></saml:AudienceRestriction>${o.extraConditions ?? ""}</saml:Conditions>` +
    (o.omitAuthnStatement
      ? ""
      : `<saml:AuthnStatement${o.omitAuthnInstant ? "" : ` AuthnInstant="${iso(o.now)}"`} SessionNotOnOrAfter="${iso(o.now + 3600_000)}"/>`) +
    `<saml:AttributeStatement>${attrs}</saml:AttributeStatement>` +
    `</saml:Assertion>`
  );
}

function findById(root: XmlElement, id: string): XmlElement | null {
  if (root.attrs.some((a) => a.local === "ID" && a.value === id)) {
    return root;
  }
  for (const c of root.children) {
    if (c.type === "element") {
      const f = findById(c, id);
      if (f) {
        return f;
      }
    }
  }
  return null;
}

/**
 * Sign the element with ID `id` inside `xml` (enveloped, exc-c14n, rsa-sha256 by default) and
 * return the document with the ds:Signature inserted after that element's Issuer.
 */
export function signSamlElement(
  xml: string,
  id: string,
  key: KeyObject,
  opts: { digest?: "sha256" | "sha1"; ec?: boolean } = {},
): string {
  const el = findById(parseXml(xml), id);
  if (!el) {
    throw new Error(`no element ${id}`);
  }
  const digestAlg = opts.digest ?? "sha256";
  const digest = createHash(digestAlg).update(canonicalizeExclusive(el), "utf8").digest("base64");
  const sigMethod = opts.ec
    ? "http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha256"
    : "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256";
  const digestMethod =
    digestAlg === "sha1"
      ? "http://www.w3.org/2000/09/xmldsig#sha1"
      : "http://www.w3.org/2001/04/xmlenc#sha256";
  const signedInfoBody =
    `<ds:CanonicalizationMethod Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"/>` +
    `<ds:SignatureMethod Algorithm="${sigMethod}"/>` +
    `<ds:Reference URI="#${id}"><ds:Transforms>` +
    `<ds:Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"/>` +
    `<ds:Transform Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"/>` +
    `</ds:Transforms><ds:DigestMethod Algorithm="${digestMethod}"/>` +
    `<ds:DigestValue>${digest}</ds:DigestValue></ds:Reference>`;
  const signedInfo = parseXml(`<ds:SignedInfo xmlns:ds="${DS}">${signedInfoBody}</ds:SignedInfo>`);
  const input = Buffer.from(canonicalizeExclusive(signedInfo), "utf8");
  const value = (
    opts.ec
      ? cryptoSign("sha256", input, { key, dsaEncoding: "ieee-p1363" })
      : cryptoSign("sha256", input, key)
  ).toString("base64");
  const signature =
    `<ds:Signature xmlns:ds="${DS}"><ds:SignedInfo>${signedInfoBody}</ds:SignedInfo>` +
    `<ds:SignatureValue>${value}</ds:SignatureValue></ds:Signature>`;
  // Insert right after the Issuer of the element that carries ID="id".
  const idx = xml.indexOf(`ID="${id}"`);
  const issuerEnd = xml.indexOf("</saml:Issuer>", idx) + "</saml:Issuer>".length;
  return xml.slice(0, issuerEnd) + signature + xml.slice(issuerEnd);
}

export function responseXml(o: {
  requestId: string;
  acsUrl: string;
  issuer: string;
  inner: string;
  responseId?: string;
}): string {
  return (
    `<samlp:Response xmlns:samlp="${SAMLP}" xmlns:saml="${SAML}" ID="${o.responseId ?? "_resp1"}" Version="2.0" ` +
    `IssueInstant="${new Date().toISOString()}" Destination="${o.acsUrl}" InResponseTo="${o.requestId}">` +
    `<saml:Issuer>${o.issuer}</saml:Issuer>` +
    `<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>` +
    o.inner +
    `</samlp:Response>`
  );
}

export const b64 = (xml: string) => Buffer.from(xml, "utf8").toString("base64");
