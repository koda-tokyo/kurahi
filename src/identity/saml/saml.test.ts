import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { IdentitySamlProviderConfig } from "../../config/types.identity.js";
import {
  assertionXml,
  b64,
  responseXml,
  SAML,
  selfSignedCertPem,
  signSamlElement,
} from "../test-helpers.js";
import { canonicalizeExclusive } from "./c14n.js";
import { SignatureError, verifyEnvelopedSignature } from "./signature.js";
import { importIdpKeys, SamlError, SamlServiceProvider, spMetadataXml } from "./sp.js";
import { childElements, parseXml, XmlError } from "./xml.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const IDP = "https://idp.example.test/saml";
const ACS = "https://gateway.example.test/api/identity/sso/okta/acs";
const SP = "https://gateway.example.test/api/identity/sso/okta/metadata";

const idpKey = generateKeyPairSync("rsa", { modulusLength: 2048 });
const otherKey = generateKeyPairSync("rsa", { modulusLength: 2048 });

const provider = (cert = selfSignedCertPem(idpKey)): IdentitySamlProviderConfig => ({
  id: "okta",
  kind: "saml",
  idpEntityId: IDP,
  idpSsoUrl: "https://idp.example.test/sso",
  idpCertificates: [cert],
});

function setup(now = Date.now()) {
  let t = now;
  const sp = new SamlServiceProvider({ now: () => t, clockSkewSec: 60 });
  const p = provider();
  const begun = sp.begin(p, { spEntityId: SP, acsUrl: ACS, returnTo: "/console" });
  const relay = new URL(begun.url).searchParams.get("RelayState");
  return {
    sp,
    p,
    requestId: begun.requestId,
    relay,
    advance: (ms: number) => {
      t += ms;
    },
    now: () => t,
    complete: (xml: string, relayState: string | null = relay) =>
      sp.complete(
        p,
        { SAMLResponse: b64(xml), RelayState: relayState },
        { spEntityId: SP, acsUrl: ACS },
      ),
  };
}

function signedResponse(
  s: ReturnType<typeof setup>,
  over: Partial<Parameters<typeof assertionXml>[0]> = {},
  key = idpKey.privateKey,
) {
  const id = over.assertionId ?? "_assert1";
  const a = assertionXml({
    requestId: s.requestId,
    acsUrl: ACS,
    audience: SP,
    issuer: IDP,
    now: s.now(),
    assertionId: id,
    ...over,
  });
  const xml = responseXml({ requestId: s.requestId, acsUrl: ACS, issuer: IDP, inner: a });
  return signSamlElement(xml, id, key);
}

const reason = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    if (err instanceof SamlError) {
      return err.reason;
    }
    throw err;
  }
  return "accepted";
};

describe("strict XML parser", () => {
  it("refuses DOCTYPE, entities, comments, CDATA and processing instructions", () => {
    expect(() => parseXml('<!DOCTYPE a [<!ENTITY x "y">]><a>&x;</a>')).toThrow(XmlError);
    expect(() => parseXml("<a>&x;</a>")).toThrow(XmlError);
    expect(() => parseXml("<a><!-- c --></a>")).toThrow(XmlError);
    expect(() => parseXml("<a><![CDATA[x]]></a>")).toThrow(XmlError);
    expect(() => parseXml("<a><?pi x?></a>")).toThrow(XmlError);
    expect(() => parseXml("<a/><b/>")).toThrow(XmlError);
    expect(() => parseXml('<a x="1" x="2"/>')).toThrow(XmlError);
    expect(() => parseXml('<a xmlns:p="u" xmlns:q="u" p:x="1" q:x="2"/>')).toThrow(XmlError);
    expect(() => parseXml("<p:a/>")).toThrow(XmlError);
  });

  it("normalises line ends and attribute whitespace, keeps character references", () => {
    const el = parseXml('<a v="x\ty&#9;z">l1\r\nl2&#13;</a>');
    expect(el.attrs[0].value).toBe("x y\tz");
    expect((el.children[0] as { value: string }).value).toBe("l1\nl2\r");
  });
});

describe("exclusive canonicalisation", () => {
  it("matches the independent lxml / libxml2 signature fixture", () => {
    const fx = JSON.parse(
      fs.readFileSync(path.join(here, "fixtures/lxml-signed-response.json"), "utf8"),
    ) as {
      cert: string;
      response: string;
    };
    const root = parseXml(fx.response);
    const assertion = childElements(root, SAML, "Assertion")[0];
    // Real X.509 certificate path, InclusiveNamespaces PrefixList, entities, CR, non-ASCII text.
    expect(() => verifyEnvelopedSignature(assertion, importIdpKeys([fx.cert]))).not.toThrow();
    const tampered = parseXml(fx.response.replace("g-finance", "g-admins"));
    expect(() =>
      verifyEnvelopedSignature(
        childElements(tampered, SAML, "Assertion")[0],
        importIdpKeys([fx.cert]),
      ),
    ).toThrow(SignatureError);
  });

  it("renders only visibly used namespaces, sorted, with xmlns='' when needed", () => {
    const el = parseXml(
      '<r:a xmlns:r="urn:r" xmlns="urn:d" xmlns:u="urn:u"><b z="1" a="2"><r:c/><c xmlns=""/></b></r:a>',
    );
    expect(canonicalizeExclusive(el)).toBe(
      '<r:a xmlns:r="urn:r"><b xmlns="urn:d" a="2" z="1"><r:c></r:c><c xmlns=""></c></b></r:a>',
    );
  });
});

describe("SAML service provider", () => {
  it("accepts a valid signed assertion and maps attributes", () => {
    const s = setup();
    const done = s.complete(signedResponse(s));
    expect(done.claims).toMatchObject({
      providerId: "okta",
      protocol: "saml",
      issuer: IDP,
      subject: "alice@example.com",
      email: "alice@example.com",
      groups: ["g-finance"],
    });
    expect(done.returnTo).toBe("/console");
    expect(done.sessionNotOnOrAfter).toBeGreaterThan(s.now());
  });

  it("takes the NameID as an e-mail only when its Format is emailAddress", () => {
    const s = setup();
    const done = s.complete(
      signedResponse(s, {
        nameId: "victim@example.com",
        nameIdFormat: "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent",
        attributes: { groups: ["g-finance"] },
      }),
    );
    expect(done.claims).toMatchObject({ email: null, emailVerified: false });
    const s2 = setup();
    const done2 = s2.complete(signedResponse(s2, { attributes: { groups: ["g"] } }));
    expect(done2.claims).toMatchObject({ email: "alice@example.com", emailVerified: true });
  });

  it("accepts only persistent or emailAddress NameIDs unless the provider lists others", () => {
    for (const nameIdFormat of [
      "urn:oasis:names:tc:SAML:2.0:nameid-format:transient",
      "urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified",
      "",
    ]) {
      const s = setup();
      expect(
        reason(() => s.complete(signedResponse(s, { nameIdFormat }))),
        nameIdFormat,
      ).toBe("nameid_format");
    }
    // A provider may name its own stable format explicitly.
    const s = setup();
    s.p.nameIdFormats = ["urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified"];
    const done = s.complete(
      signedResponse(s, {
        nameIdFormat: "urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified",
        nameId: "u-1234",
      }),
    );
    expect(done.claims.subject).toBe("u-1234");
  });

  it("requires an AuthnStatement and refuses conditions it does not understand", () => {
    const s = setup();
    expect(reason(() => s.complete(signedResponse(s, { omitAuthnStatement: true })))).toBe(
      "no_authn_statement",
    );
    const s2 = setup();
    expect(
      reason(() =>
        s2.complete(
          signedResponse(s2, {
            extraConditions: `<saml:Condition xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="x:Custom"/>`,
          }),
        ),
      ),
    ).toBe("unsupported_condition");
    const s3 = setup();
    expect(
      reason(() => s3.complete(signedResponse(s3, { extraConditions: "<saml:OneTimeUse/>" }))),
    ).toBe("accepted");
  });

  it("checks the domain after the only @ (no smuggled second @)", () => {
    const s = setup();
    s.p.allowedDomains = ["example.com"];
    expect(
      reason(() =>
        s.complete(
          signedResponse(s, { attributes: { email: ["attacker@example.com@evil.test"] } }),
        ),
      ),
    ).toBe("domain_not_allowed");
  });

  it("publishes SP metadata that requires signed assertions", () => {
    const xml = spMetadataXml({ spEntityId: SP, acsUrl: ACS });
    expect(xml).toContain('WantAssertionsSigned="true"');
    expect(xml).toContain(`Location="${ACS}"`);
  });

  it("refuses an unsigned assertion, and a signed response around an unsigned assertion", () => {
    const s = setup();
    const a = assertionXml({
      requestId: s.requestId,
      acsUrl: ACS,
      audience: SP,
      issuer: IDP,
      now: s.now(),
      assertionId: "_a",
    });
    const unsigned = responseXml({ requestId: s.requestId, acsUrl: ACS, issuer: IDP, inner: a });
    expect(reason(() => s.complete(unsigned))).toBe("unsigned");
    const s2 = setup();
    const a2 = assertionXml({
      requestId: s2.requestId,
      acsUrl: ACS,
      audience: SP,
      issuer: IDP,
      now: s2.now(),
      assertionId: "_a",
    });
    const responseOnly = signSamlElement(
      responseXml({ requestId: s2.requestId, acsUrl: ACS, issuer: IDP, inner: a2 }),
      "_resp1",
      idpKey.privateKey,
    );
    expect(reason(() => s2.complete(responseOnly))).toBe("unsigned");
  });

  it("refuses a signature by another key", () => {
    const s = setup();
    expect(reason(() => s.complete(signedResponse(s, {}, otherKey.privateKey)))).toBe(
      "bad_signature",
    );
  });

  it("refuses content changed after signing", () => {
    const s = setup();
    const xml = signedResponse(s).replace(
      ">alice@example.com</saml:NameID>",
      ">mallory@example.com</saml:NameID>",
    );
    expect(reason(() => s.complete(xml))).toBe("bad_signature");
  });

  it("refuses SHA-1 digests", () => {
    const s = setup();
    const a = assertionXml({
      requestId: s.requestId,
      acsUrl: ACS,
      audience: SP,
      issuer: IDP,
      now: s.now(),
      assertionId: "_a",
    });
    const xml = signSamlElement(
      responseXml({ requestId: s.requestId, acsUrl: ACS, issuer: IDP, inner: a }),
      "_a",
      idpKey.privateKey,
      {
        digest: "sha1",
      },
    );
    expect(reason(() => s.complete(xml))).toBe("bad_signature");
  });

  describe("signature wrapping (XSW)", () => {
    const evil = (s: ReturnType<typeof setup>, id: string) =>
      assertionXml({
        requestId: s.requestId,
        acsUrl: ACS,
        audience: SP,
        issuer: IDP,
        now: s.now(),
        assertionId: id,
        nameId: "mallory@example.com",
        attributes: { email: ["mallory@example.com"], groups: ["g-admins"] },
      });
    const signedAssertion = (s: ReturnType<typeof setup>) => {
      const signed = signedResponse(s);
      const start = signed.indexOf("<saml:Assertion");
      const end = signed.indexOf("</saml:Assertion>") + "</saml:Assertion>".length;
      return signed.slice(start, end);
    };

    it("XSW1/2: signed assertion moved into an extension, forged assertion in its place", () => {
      const s = setup();
      const original = signedAssertion(s);
      const xml = responseXml({
        requestId: s.requestId,
        acsUrl: ACS,
        issuer: IDP,
        inner: `<samlp:Extensions>${original}</samlp:Extensions>${evil(s, "_evil")}`,
      });
      expect(reason(() => s.complete(xml))).toBe("assertion_count");
    });

    it("XSW3: forged assertion before the signed one", () => {
      const s = setup();
      const xml = responseXml({
        requestId: s.requestId,
        acsUrl: ACS,
        issuer: IDP,
        inner: evil(s, "_evil") + signedAssertion(s),
      });
      expect(reason(() => s.complete(xml))).toBe("assertion_count");
    });

    it("XSW4: forged assertion wrapping the signed one", () => {
      const s = setup();
      const original = signedAssertion(s);
      const wrapper = evil(s, "_evil").replace("</saml:Assertion>", `${original}</saml:Assertion>`);
      const xml = responseXml({ requestId: s.requestId, acsUrl: ACS, issuer: IDP, inner: wrapper });
      expect(reason(() => s.complete(xml))).toBe("assertion_count");
    });

    it("XSW5-8: forged assertion reusing the signed ID, signed copy hidden in the signature", () => {
      const s = setup();
      const original = signedAssertion(s);
      const forged = evil(s, "_assert1");
      // The genuine signed assertion is tucked inside a ds:Object of the forged one.
      const sigStart = original.indexOf("<ds:Signature");
      const sigEnd = original.indexOf("</ds:Signature>") + "</ds:Signature>".length;
      const sig = original
        .slice(sigStart, sigEnd)
        .replace("</ds:Signature>", `<ds:Object>${original}</ds:Object></ds:Signature>`);
      const wrapped = forged.replace("</saml:Issuer>", `</saml:Issuer>${sig}`);
      const xml = responseXml({ requestId: s.requestId, acsUrl: ACS, issuer: IDP, inner: wrapped });
      expect(["assertion_count", "duplicate_id"]).toContain(reason(() => s.complete(xml)));
    });

    it("duplicate IDs anywhere are refused", () => {
      const s = setup();
      const signed = signedResponse(s).replace(
        "<samlp:Status>",
        '<samlp:Extensions><x:Decoy xmlns:x="urn:x" ID="_assert1"/></samlp:Extensions><samlp:Status>',
      );
      expect(reason(() => s.complete(signed))).toBe("duplicate_id");
    });

    it("comment-truncated NameID is refused at parse time", () => {
      const s = setup();
      const signed = signedResponse(s).replace(
        ">alice@example.com</saml:NameID>",
        ">alice@example.com<!---->.evil</saml:NameID>",
      );
      expect(reason(() => s.complete(signed))).toBe("malformed");
    });
  });

  it("refuses expired, not-yet-valid, wrong audience and wrong recipient", () => {
    let s = setup();
    let xml = signedResponse(s, { notOnOrAfterMs: s.now() + 1000 });
    s.advance(5 * 60_000);
    expect(reason(() => s.complete(xml))).toBe("expired");

    s = setup();
    xml = signedResponse(s, { audience: "https://other.example.test/sp" });
    expect(reason(() => s.complete(xml))).toBe("wrong_audience");

    s = setup();
    xml = signedResponse(s, { acsUrl: "https://attacker.example.test/acs" });
    expect(reason(() => s.complete(xml))).toBe("no_bearer_confirmation");

    s = setup();
    xml = signedResponse(s, { issuer: "https://evil-idp.example.test" });
    expect(reason(() => s.complete(xml))).toBe("wrong_issuer");

    s = setup();
    xml = signedResponse(s, { now: s.now() + 10 * 60_000 });
    expect(reason(() => s.complete(xml))).toBe("not_yet_valid");
  });

  it("refuses a replayed response and an unsolicited (IdP-initiated) one", () => {
    const s = setup();
    const xml = signedResponse(s);
    expect(reason(() => s.complete(xml))).toBe("accepted");
    expect(reason(() => s.complete(xml))).toBe("request_unknown");

    const s2 = setup();
    const a = assertionXml({
      requestId: "_unsolicited",
      acsUrl: ACS,
      audience: SP,
      issuer: IDP,
      now: s2.now(),
      assertionId: "_u",
    });
    const unsolicited = signSamlElement(
      responseXml({ requestId: "_unsolicited", acsUrl: ACS, issuer: IDP, inner: a }),
      "_u",
      idpKey.privateKey,
    );
    expect(reason(() => s2.complete(unsolicited))).toBe("request_unknown");
  });

  it("refuses the same assertion ID answering a second request (assertion replay cache)", () => {
    const s = setup();
    expect(reason(() => s.complete(signedResponse(s, { assertionId: "_same" })))).toBe("accepted");
    const again = s.sp.begin(s.p, { spEntityId: SP, acsUrl: ACS, returnTo: "/" });
    const relay = new URL(again.url).searchParams.get("RelayState");
    const a = assertionXml({
      requestId: again.requestId,
      acsUrl: ACS,
      audience: SP,
      issuer: IDP,
      now: s.now(),
      assertionId: "_same",
    });
    const xml = signSamlElement(
      responseXml({ requestId: again.requestId, acsUrl: ACS, issuer: IDP, inner: a }),
      "_same",
      idpKey.privateKey,
    );
    expect(reason(() => s.complete(xml, relay))).toBe("replayed");
  });

  it("refuses a response delivered to another browser (binding cookie)", () => {
    const sp = new SamlServiceProvider({ clockSkewSec: 60 });
    const p = provider();
    const begun = sp.begin(p, {
      spEntityId: SP,
      acsUrl: ACS,
      returnTo: "/",
      binding: "b".repeat(32),
    });
    const a = assertionXml({
      requestId: begun.requestId,
      acsUrl: ACS,
      audience: SP,
      issuer: IDP,
      now: Date.now(),
      assertionId: "_b",
    });
    const xml = signSamlElement(
      responseXml({ requestId: begun.requestId, acsUrl: ACS, issuer: IDP, inner: a }),
      "_b",
      idpKey.privateKey,
    );
    expect(
      reason(() =>
        sp.complete(
          p,
          { SAMLResponse: b64(xml), RelayState: null },
          { spEntityId: SP, acsUrl: ACS, binding: "c".repeat(32) },
        ),
      ),
    ).toBe("browser_mismatch");
  });

  it("refuses a RelayState that does not belong to the request", () => {
    const s = setup();
    expect(reason(() => s.complete(signedResponse(s), "other-relay"))).toBe("request_unknown");
  });

  it("refuses encrypted assertions (not supported) and non-Response roots", () => {
    const s = setup();
    const xml = responseXml({
      requestId: s.requestId,
      acsUrl: ACS,
      issuer: IDP,
      inner: `<saml:EncryptedAssertion/>`,
    });
    expect(reason(() => s.complete(xml))).toBe("encrypted_assertion_unsupported");
    expect(reason(() => s.complete(`<saml:Assertion xmlns:saml="${SAML}"/>`))).toBe(
      "not_a_response",
    );
  });
});
