// SAML 2.0 service provider: SP-initiated Web Browser SSO (HTTP-Redirect AuthnRequest,
// HTTP-POST Response), metadata, and the assertion checks.
//
// Refusals, in order: not valid UTF-8 / not the strict XML subset (xml.ts); root is not
// samlp:Response; any EncryptedAssertion; not exactly one saml:Assertion in the whole document
// and as a direct child of the Response; duplicate ID attributes anywhere; Status not Success;
// Destination other than our ACS; InResponseTo not a pending request of this provider (spent on
// first use: IdP-initiated and replayed responses fail here); the assertion is not signed by a
// configured IdP certificate (a signed Response alone is not enough; when the Response is also
// signed, that signature must verify too); Issuer other than the IdP entity id; Conditions
// NotBefore / NotOnOrAfter outside the clock skew; no AudienceRestriction naming our entity id;
// no bearer SubjectConfirmation whose Data names our ACS as Recipient, this request as
// InResponseTo and a NotOnOrAfter in the future; IssueInstant in the future or older than the
// request; an assertion ID seen before (replay cache until the assertion's NotOnOrAfter).
// Every value is read from the verified assertion element itself, never by searching the
// document again, so a wrapped copy elsewhere cannot supply the identity.
import { createPublicKey, randomBytes, type KeyObject, X509Certificate } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import type { IdentitySamlProviderConfig } from "../../config/types.identity.js";
import type { SignInClaims } from "../types.js";
import { emailDomain, MAX_PENDING_PER_SOURCE, PendingQuota, sameSecret } from "../oidc.js";
import { SignatureError, signaturesOf, verifyEnvelopedSignature } from "./signature.js";
import {
  attr,
  childElements,
  decodeUtf8Strict,
  descendants,
  onlyChild,
  parseXml,
  textOf,
  XmlError,
  type XmlElement,
} from "./xml.js";

export const SAMLP_NS = "urn:oasis:names:tc:SAML:2.0:protocol";
export const SAML_NS = "urn:oasis:names:tc:SAML:2.0:assertion";
const MD_NS = "urn:oasis:names:tc:SAML:2.0:metadata";
const STATUS_SUCCESS = "urn:oasis:names:tc:SAML:2.0:status:Success";
const BEARER = "urn:oasis:names:tc:SAML:2.0:cm:bearer";

// Attribute names Entra ID and Okta send by default (overridable per provider).
const DEFAULT_ATTRS = {
  email: [
    "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress",
    "email",
    "mail",
    "urn:oid:0.9.2342.19200300.100.1.3",
  ],
  displayName: [
    "http://schemas.microsoft.com/identity/claims/displayname",
    "displayName",
    "name",
    "urn:oid:2.16.840.1.113730.3.1.241",
  ],
  groups: ["http://schemas.microsoft.com/ws/2008/06/identity/claims/groups", "groups", "memberOf"],
  givenName: [
    "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname",
    "firstName",
    "givenName",
  ],
  familyName: ["http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname", "lastName", "sn"],
};

export type SamlFailure =
  | "malformed"
  | "not_a_response"
  | "encrypted_assertion_unsupported"
  | "assertion_count"
  | "duplicate_id"
  | "status_not_success"
  | "wrong_destination"
  | "request_unknown"
  | "browser_mismatch"
  | "unsigned"
  | "bad_signature"
  | "wrong_issuer"
  | "not_yet_valid"
  | "expired"
  | "wrong_audience"
  | "no_bearer_confirmation"
  | "replayed"
  | "domain_not_allowed"
  | "no_authn_statement"
  | "unsupported_condition"
  | "too_many_pending"
  | "nameid_format"
  | "not_fresh";

/** NameID formats a provider accepts unless it names others (`nameIdFormats`). */
export const DEFAULT_NAMEID_FORMATS = [
  "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent",
  "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
] as const;

export class SamlError extends Error {
  constructor(readonly reason: SamlFailure) {
    super(`sign-in refused: ${reason}`);
    this.name = "SamlError";
  }
}

type PendingRequest = {
  providerId: string;
  source: string;
  returnTo: string;
  createdAt: number;
  relayState: string;
  binding: string | null;
  /** A step-up re-authentication for this live session (ForceAuthn), not a sign-in. */
  stepUp: { sessionId: string; personId: string } | null;
};

export type SamlCompletion = {
  claims: SignInClaims;
  returnTo: string;
  sessionNotOnOrAfter: number | null;
  stepUp: { sessionId: string; personId: string; startedAt: number } | null;
};

const REQUEST_TTL_MS = 10 * 60_000;
const MAX_PENDING = 2_000;
const MAX_REPLAY = 20_000;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;

/** RFC 8176 `amr` values implied by a SAML AuthnContextClassRef (empty when it says nothing). */
export function samlMethods(classRef: string | null): string[] {
  const c = classRef ?? "";
  if (/multipleauthn|MultiFactor|:mfa\b/i.test(c)) {
    return ["mfa"];
  }
  if (/X509|Smartcard|TLSClient/i.test(c)) {
    return ["hwk"];
  }
  if (/Password/i.test(c)) {
    return ["pwd"];
  }
  return [];
}

function time(el: XmlElement, name: string): number | null {
  const v = attr(el, name);
  if (v === null) {
    return null;
  }
  if (!ISO_UTC.test(v)) {
    throw new SamlError("malformed");
  }
  const ms = Date.parse(v);
  if (!Number.isFinite(ms)) {
    throw new SamlError("malformed");
  }
  return ms;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Public keys from PEM certificates (or bare base64 DER as IdP metadata shows them). */
export function importIdpKeys(certs: string[]): KeyObject[] {
  const keys: KeyObject[] = [];
  for (const raw of certs) {
    const pem = raw.includes("BEGIN CERTIFICATE")
      ? raw
      : `-----BEGIN CERTIFICATE-----\n${raw.replace(/\s+/g, "").replace(/(.{64})/g, "$1\n")}\n-----END CERTIFICATE-----\n`;
    try {
      keys.push(new X509Certificate(pem).publicKey);
    } catch {
      try {
        keys.push(createPublicKey(raw));
      } catch {
        // an unusable certificate is reported by the config check, not here
      }
    }
  }
  return keys;
}

export type SamlSpOptions = { now?: () => number; clockSkewSec?: number };

export class SamlServiceProvider {
  private readonly now: () => number;
  private readonly skewMs: number;
  private byRelay = new Map<string, string>();
  private pending: PendingQuota<PendingRequest>;
  private seenAssertions = new Map<string, number>();

  constructor(opts: SamlSpOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.skewMs = (opts.clockSkewSec ?? 120) * 1000;
    this.pending = new PendingQuota(
      MAX_PENDING,
      MAX_PENDING_PER_SOURCE,
      REQUEST_TTL_MS,
      this.now,
      (_id, p) => this.byRelay.delete(p.relayState),
    );
  }

  private prune(): void {
    const now = this.now();
    this.pending.prune();
    for (const [id, until] of this.seenAssertions) {
      if (until < now) {
        this.seenAssertions.delete(id);
      }
    }
  }

  /** HTTP-Redirect binding URL for a new AuthnRequest. */
  begin(
    p: IdentitySamlProviderConfig,
    opts: {
      spEntityId: string;
      acsUrl: string;
      returnTo: string;
      binding?: string | null;
      source?: string | null;
      /** Step-up for a live session: `ForceAuthn="true"`; complete() hands the flow back. */
      stepUp?: { sessionId: string; personId: string } | null;
    },
  ): { url: string; requestId: string } {
    this.prune();
    const requestId = `_${randomBytes(20).toString("hex")}`;
    const relayState = randomBytes(24).toString("base64url");
    const added = this.pending.add(requestId, {
      providerId: p.id,
      source: opts.source ?? "local",
      returnTo: opts.returnTo,
      createdAt: this.now(),
      relayState,
      binding: opts.binding ?? null,
      stepUp: opts.stepUp ?? null,
    });
    if (!added) {
      throw new SamlError("too_many_pending");
    }
    this.byRelay.set(relayState, requestId);
    const xml =
      `<samlp:AuthnRequest xmlns:samlp="${SAMLP_NS}" xmlns:saml="${SAML_NS}" ` +
      `ID="${requestId}" Version="2.0" IssueInstant="${new Date(this.now()).toISOString()}" ` +
      `Destination="${escapeXml(p.idpSsoUrl)}" AssertionConsumerServiceURL="${escapeXml(opts.acsUrl)}" ` +
      `ProtocolBinding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"` +
      `${opts.stepUp ? ' ForceAuthn="true"' : ""}>` +
      `<saml:Issuer>${escapeXml(opts.spEntityId)}</saml:Issuer>` +
      `<samlp:NameIDPolicy AllowCreate="true"/>` +
      `</samlp:AuthnRequest>`;
    const url = new URL(p.idpSsoUrl);
    url.searchParams.set(
      "SAMLRequest",
      deflateRawSync(Buffer.from(xml, "utf8")).toString("base64"),
    );
    url.searchParams.set("RelayState", relayState);
    return { url: url.toString(), requestId };
  }

  /** Validate a posted SAMLResponse (base64) for provider `p`. */
  complete(
    p: IdentitySamlProviderConfig,
    form: { SAMLResponse?: string | null; RelayState?: string | null },
    opts: { spEntityId: string; acsUrl: string; binding?: string | null },
  ): SamlCompletion {
    const b64 = (form.SAMLResponse ?? "").replace(/\s+/g, "");
    if (!b64 || b64.length > 700_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) {
      throw new SamlError("malformed");
    }
    let root: XmlElement;
    try {
      root = parseXml(decodeUtf8Strict(Buffer.from(b64, "base64")));
    } catch (err) {
      if (err instanceof XmlError) {
        throw new SamlError("malformed");
      }
      throw err;
    }
    try {
      return this.validate(p, root, form.RelayState ?? null, opts);
    } catch (err) {
      if (err instanceof XmlError) {
        throw new SamlError("malformed");
      }
      throw err;
    }
  }

  private validate(
    p: IdentitySamlProviderConfig,
    root: XmlElement,
    relayState: string | null,
    opts: { spEntityId: string; acsUrl: string; binding?: string | null },
  ): SamlCompletion {
    if (root.ns !== SAMLP_NS || root.local !== "Response" || attr(root, "Version") !== "2.0") {
      throw new SamlError("not_a_response");
    }
    if (descendants(root, SAML_NS, "EncryptedAssertion").length > 0) {
      throw new SamlError("encrypted_assertion_unsupported");
    }
    // Exactly one assertion anywhere, and it is a direct child of the Response.
    const all = descendants(root, SAML_NS, "Assertion");
    const direct = childElements(root, SAML_NS, "Assertion");
    if (all.length !== 1 || direct.length !== 1 || all[0] !== direct[0]) {
      throw new SamlError("assertion_count");
    }
    const assertion = direct[0];
    this.refuseDuplicateIds(root);

    const status = onlyChild(root, SAMLP_NS, "Status");
    const code = status ? onlyChild(status, SAMLP_NS, "StatusCode") : null;
    if (!code || attr(code, "Value") !== STATUS_SUCCESS) {
      throw new SamlError("status_not_success");
    }
    const destination = attr(root, "Destination");
    if (destination !== null && destination !== opts.acsUrl) {
      throw new SamlError("wrong_destination");
    }

    // The request this answers: spent now, whatever happens next.
    const inResponseTo = attr(root, "InResponseTo");
    const pending = inResponseTo ? this.pending.take(inResponseTo) : undefined;
    if (pending) {
      this.byRelay.delete(pending.relayState);
    }
    if (
      !inResponseTo ||
      !pending ||
      pending.providerId !== p.id ||
      this.now() - pending.createdAt > REQUEST_TTL_MS ||
      (relayState !== null && relayState !== pending.relayState)
    ) {
      throw new SamlError("request_unknown");
    }
    // Login CSRF: the response must reach the browser that started the sign-in.
    if (pending.binding !== null && !sameSecret(pending.binding, opts.binding ?? "")) {
      throw new SamlError("browser_mismatch");
    }

    const keys = importIdpKeys(p.idpCertificates);
    const verify = (el: XmlElement) => {
      try {
        verifyEnvelopedSignature(el, keys);
      } catch (err) {
        if (err instanceof SignatureError) {
          throw new SamlError(err.reason === "unsigned" ? "unsigned" : "bad_signature");
        }
        throw err;
      }
    };
    if (signaturesOf(root).length > 0) {
      verify(root);
    }
    verify(assertion);

    // From here on, only `assertion` (the verified element) supplies values.
    const responseIssuer = onlyChild(root, SAML_NS, "Issuer");
    if (responseIssuer && textOf(responseIssuer).trim() !== p.idpEntityId) {
      throw new SamlError("wrong_issuer");
    }
    const issuer = onlyChild(assertion, SAML_NS, "Issuer");
    if (!issuer || textOf(issuer).trim() !== p.idpEntityId) {
      throw new SamlError("wrong_issuer");
    }
    const now = this.now();
    const issueInstant = time(assertion, "IssueInstant");
    if (issueInstant === null || issueInstant - this.skewMs > now) {
      throw new SamlError("not_yet_valid");
    }
    if (issueInstant + this.skewMs < pending.createdAt) {
      throw new SamlError("expired");
    }

    const conditions = onlyChild(assertion, SAML_NS, "Conditions");
    if (!conditions) {
      throw new SamlError("wrong_audience");
    }
    const notBefore = time(conditions, "NotBefore");
    const notOnOrAfter = time(conditions, "NotOnOrAfter");
    if (notBefore !== null && notBefore - this.skewMs > now) {
      throw new SamlError("not_yet_valid");
    }
    if (notOnOrAfter === null || notOnOrAfter + this.skewMs <= now) {
      throw new SamlError("expired");
    }
    // Conditions we do not understand must not be ignored (SAML core 2.5.1: an assertion with a
    // condition the relying party cannot evaluate is Indeterminate). OneTimeUse is satisfied by
    // the replay cache; ProxyRestriction only limits further assertions the SP never issues.
    for (const c of childElements(conditions)) {
      if (
        c.ns !== SAML_NS ||
        !["AudienceRestriction", "OneTimeUse", "ProxyRestriction"].includes(c.local)
      ) {
        throw new SamlError("unsupported_condition");
      }
    }
    const restrictions = childElements(conditions, SAML_NS, "AudienceRestriction");
    // Every AudienceRestriction must include us (SAML core 2.5.1.4: each one must be satisfied).
    if (
      restrictions.length === 0 ||
      !restrictions.every((r) =>
        childElements(r, SAML_NS, "Audience").some((a) => textOf(a).trim() === opts.spEntityId),
      )
    ) {
      throw new SamlError("wrong_audience");
    }

    const subject = onlyChild(assertion, SAML_NS, "Subject");
    const nameId = subject ? onlyChild(subject, SAML_NS, "NameID") : null;
    const nameIdValue = nameId ? textOf(nameId).trim() : "";
    if (!subject || !nameIdValue) {
      throw new SamlError("malformed");
    }
    // The NameID is the subject a person is linked by: only a stable format may be one. A missing
    // Format means "unspecified", which is refused like transient.
    const nameIdFormat = attr(nameId as NonNullable<typeof nameId>, "Format");
    const formats: readonly string[] = p.nameIdFormats?.length
      ? p.nameIdFormats
      : DEFAULT_NAMEID_FORMATS;
    if (!nameIdFormat || !formats.includes(nameIdFormat)) {
      throw new SamlError("nameid_format");
    }
    const bearerOk = childElements(subject, SAML_NS, "SubjectConfirmation").some((sc) => {
      if (attr(sc, "Method") !== BEARER) {
        return false;
      }
      const data = onlyChild(sc, SAML_NS, "SubjectConfirmationData");
      if (!data) {
        return false;
      }
      const until = time(data, "NotOnOrAfter");
      const from = time(data, "NotBefore");
      return (
        attr(data, "Recipient") === opts.acsUrl &&
        attr(data, "InResponseTo") === inResponseTo &&
        until !== null &&
        until + this.skewMs > now &&
        // A bearer confirmation with NotBefore is not allowed by the SAML profile.
        from === null
      );
    });
    if (!bearerOk) {
      throw new SamlError("no_bearer_confirmation");
    }

    const assertionId = attr(assertion, "ID") ?? "";
    const replayKey = `${p.id}:${assertionId}`;
    if (this.seenAssertions.has(replayKey)) {
      throw new SamlError("replayed");
    }
    if (this.seenAssertions.size >= MAX_REPLAY) {
      this.prune();
    }
    this.seenAssertions.set(replayKey, notOnOrAfter + this.skewMs);

    const attributes = new Map<string, string[]>();
    for (const statement of childElements(assertion, SAML_NS, "AttributeStatement")) {
      for (const a of childElements(statement, SAML_NS, "Attribute")) {
        const name = attr(a, "Name");
        if (!name) {
          continue;
        }
        const values = childElements(a, SAML_NS, "AttributeValue")
          .map((v) => textOf(v).trim())
          .filter((v) => v.length > 0 && v.length <= 256);
        attributes.set(name, [...(attributes.get(name) ?? []), ...values]);
      }
    }
    const pick = (configured: string | undefined, defaults: string[]) => {
      for (const n of configured ? [configured] : defaults) {
        const v = attributes.get(n);
        if (v?.length) {
          return v;
        }
      }
      return [];
    };
    const a = p.attributes ?? {};
    const format = nameId ? attr(nameId, "Format") : null;
    // The NameID is an e-mail only when its Format says so; an opaque or persistent NameID that
    // happens to contain "@" is not.
    const emailRaw =
      pick(a.email, DEFAULT_ATTRS.email)[0] ??
      (format?.endsWith(":emailAddress") ? nameIdValue : null);
    const email = emailRaw && emailDomain(emailRaw) ? emailRaw.toLowerCase() : null;
    if (p.allowedDomains?.length) {
      const domain = emailDomain(email) ?? "";
      if (!p.allowedDomains.map((d) => d.toLowerCase()).includes(domain)) {
        throw new SamlError("domain_not_allowed");
      }
    }
    // Web Browser SSO profile: the assertion must say the IdP authenticated the person.
    const authn = childElements(assertion, SAML_NS, "AuthnStatement")[0];
    if (!authn) {
      throw new SamlError("no_authn_statement");
    }
    const sessionNotOnOrAfter = time(authn, "SessionNotOnOrAfter");
    const authnInstant = time(authn, "AuthnInstant");
    // Step-up: the IdP must say when it authenticated; never assume "now".
    if (pending.stepUp && authnInstant === null) {
      throw new SamlError("not_fresh");
    }
    const ctx = childElements(authn, SAML_NS, "AuthnContext")[0];
    const classRef = ctx ? childElements(ctx, SAML_NS, "AuthnContextClassRef")[0] : undefined;
    const context = classRef ? textOf(classRef).trim().slice(0, 256) || null : null;
    return {
      claims: {
        providerId: p.id,
        protocol: "saml",
        issuer: p.idpEntityId,
        subject: nameIdValue,
        email,
        emailVerified: email !== null,
        displayName: pick(a.displayName, DEFAULT_ATTRS.displayName)[0] ?? null,
        givenName: pick(a.givenName, DEFAULT_ATTRS.givenName)[0] ?? null,
        familyName: pick(a.familyName, DEFAULT_ATTRS.familyName)[0] ?? null,
        groups: pick(a.groups, DEFAULT_ATTRS.groups).slice(0, 500),
        idTokenHint: null,
        auth: {
          at: new Date(authnInstant ?? this.now()).toISOString(),
          methods: samlMethods(context),
          context,
        },
      },
      returnTo: pending.returnTo,
      sessionNotOnOrAfter,
      stepUp: pending.stepUp ? { ...pending.stepUp, startedAt: pending.createdAt } : null,
    };
  }

  /** ID-type attributes (ID, Id, id, AssertionID) must be unique across the whole message. */
  private refuseDuplicateIds(root: XmlElement): void {
    const seen = new Set<string>();
    const walk = (el: XmlElement) => {
      for (const a of el.attrs) {
        if (
          a.ns === null &&
          (a.local === "ID" || a.local === "Id" || a.local === "id" || a.local === "AssertionID")
        ) {
          if (seen.has(a.value)) {
            throw new SamlError("duplicate_id");
          }
          seen.add(a.value);
        }
      }
      for (const c of el.children) {
        if (c.type === "element") {
          walk(c);
        }
      }
    };
    walk(root);
  }
}

/** SP metadata for the IdP administrator (signed assertions required, HTTP-POST ACS). */
export function spMetadataXml(opts: { spEntityId: string; acsUrl: string }): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<md:EntityDescriptor xmlns:md="${MD_NS}" entityID="${escapeXml(opts.spEntityId)}">` +
    `<md:SPSSODescriptor AuthnRequestsSigned="false" WantAssertionsSigned="true" ` +
    `protocolSupportEnumeration="${SAMLP_NS}">` +
    `<md:NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress</md:NameIDFormat>` +
    `<md:NameIDFormat>urn:oasis:names:tc:SAML:2.0:nameid-format:persistent</md:NameIDFormat>` +
    `<md:AssertionConsumerService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" ` +
    `Location="${escapeXml(opts.acsUrl)}" index="0" isDefault="true"/>` +
    `</md:SPSSODescriptor></md:EntityDescriptor>\n`
  );
}
