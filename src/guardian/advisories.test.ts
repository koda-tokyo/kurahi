import { describe, expect, it } from "vitest";
import type { KoLoConfig } from "../config/config.js";
import {
  ADVISORY_FEEDS,
  createGuardianAdvisoriesTool,
  fetchAdvisories,
  itemBlocks,
  matchProducts,
  parseAdvisoryFeed,
} from "./advisories.js";

// Shapes of the live feeds (RSS 1.0 / RDF), trimmed.
const JPCERT = `<?xml version="1.0" encoding="UTF-8" ?>

<rdf:RDF
  xmlns="http://purl.org/rss/1.0/"
  xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
  xmlns:dc="http://purl.org/dc/elements/1.1/"
  xmlns:content="http://purl.org/rss/1.0/modules/content/"
  xml:lang="ja">
  <channel rdf:about="https://www.jpcert.or.jp/rss/jpcert.rdf">
    <title>JPCERT/CC RSS Feed</title>
    <link>https://www.jpcert.or.jp/</link>
    <items><rdf:Seq>
      <rdf:li rdf:resource="https://www.jpcert.or.jp/at/2026/at260033.html" />
    </rdf:Seq></items>
  </channel>
  <!-- <item><title>commented out</title></item> -->
  <item rdf:about="https://www.jpcert.or.jp/at/2026/at260033.html">
    <title>注意喚起: PHPにおける複数の脆弱性（CVE-2026-109618）に関する注意喚起  (更新)</title>
    <link>https://www.jpcert.or.jp/at/2026/at260033.html</link>
    <dc:identifier>at260033</dc:identifier>
    <dc:date>2026-10-29T15:43+09:00</dc:date>
  </item>
  <item rdf:about="https://www.jpcert.or.jp/wr/2026/wr261028.html#5">
    <title>Apache Tomcatに複数の脆弱性</title>
    <link>https://www.jpcert.or.jp/wr/2026/wr261028.html#5</link>
    <description>
	<![CDATA[Apache Tomcatに複数の脆弱性<a href="https://www.jpcert.or.jp/wr/2026/wr261028.html#5">続きを読む</a>]]>
    </description>
    <dc:date>2026-10-28T09:00+09:00</dc:date>
  </item>
  <item rdf:about="https://www.jpcert.or.jp/wr/2026/wr260901.html#1">
    <title>PHPMailer &amp; Roundcube&#x3001;old</title>
    <link>javascript:alert(1)</link>
    <dc:date>2026-09-01T09:00+09:00</dc:date>
  </item>
</rdf:RDF>
`;

const IPA = `<?xml version="1.0" encoding="utf-8" ?>
<rdf:RDF xmlns="http://purl.org/rss/1.0/" xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:dc="http://purl.org/dc/elements/1.1/" xml:lang="ja">
 <channel rdf:about="https://www.ipa.go.jp/security/alert-rss.rdf">
  <title>緊急対策情報・注意喚起（重要なセキュリティ情報）RSS</title>
 </channel>
 <item rdf:about="https://www.ipa.go.jp/security/security-alert/2026/1014-ms.html">
  <title>Ｍｉｃｒｏｓｏｆｔ 製品の脆弱性対策について(2026年10月)</title>
  <link>https://www.ipa.go.jp/security/security-alert/2026/1014-ms.html</link>
  <dc:date>2026-10-22T00:00:00+09:00</dc:date>
 </item>
</rdf:RDF>
`;

const ATOM = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
<entry><title type="text">FortiOS advisory</title>
<link rel="self" href="https://example.invalid/self"/><link rel="alternate" href="https://example.invalid/a"/>
<updated>2026-10-20T00:00:00Z</updated></entry></feed>`;

describe("parseAdvisoryFeed", () => {
  it("reads RSS 1.0 items: title, link, date; skips comments, unwraps CDATA, decodes references", () => {
    const items = parseAdvisoryFeed(JPCERT, "jpcert");
    expect(items.map((i) => i.title)).toEqual([
      "注意喚起: PHPにおける複数の脆弱性（CVE-2026-109618）に関する注意喚起 (更新)",
      "Apache Tomcatに複数の脆弱性",
      "PHPMailer & Roundcube、old",
    ]);
    expect(items[0]).toMatchObject({
      link: "https://www.jpcert.or.jp/at/2026/at260033.html",
      published: "2026-10-29T06:43:00.000Z",
      source: "jpcert",
    });
    // a non-http link is dropped, never passed on
    expect(items[2].link).toBe("");
  });

  it("reads Atom entries with the alternate link", () => {
    expect(parseAdvisoryFeed(ATOM, "ipa")).toEqual([
      {
        title: "FortiOS advisory",
        link: "https://example.invalid/a",
        published: "2026-10-20T00:00:00.000Z",
        source: "ipa",
        matches: [],
      },
    ]);
  });

  it("refuses DTDs, entity declarations and documents that are no feed", () => {
    expect(() =>
      parseAdvisoryFeed(`<?xml version="1.0"?><!DOCTYPE r [<!ENTITY x "y">]><rss/>`, "ipa"),
    ).toThrow(/DTD/);
    expect(() => parseAdvisoryFeed("<html><body>404</body></html>", "ipa")).toThrow(/not an RSS/);
  });
});

describe("matchProducts", () => {
  it("matches case-insensitively, folds full-width letters, respects word edges", () => {
    expect(matchProducts("Apache Tomcatに複数の脆弱性", ["tomcat", "PHP"])).toEqual(["tomcat"]);
    expect(matchProducts("PHPMailerの脆弱性", ["PHP"])).toEqual([]);
    expect(matchProducts("PHPにおける脆弱性", ["php"])).toEqual(["php"]);
    expect(matchProducts("Ｍｉｃｒｏｓｏｆｔ 製品", ["Microsoft"])).toEqual(["Microsoft"]);
    expect(matchProducts("Cisco IOS XE", ["ios xe", "  "])).toEqual(["ios xe"]);
  });
});

describe("item extraction", () => {
  it("splits items and entries, skips self-closing ones, stops at an unclosed one", () => {
    const xml =
      "<rss><items/><item/><item><title>a</title></item><entry x='1'><title>b</title></entry>" +
      "<item><title>c</title>";
    expect(itemBlocks(xml, 10)).toEqual(["<title>a</title>", "<title>b</title>"]);
    expect(itemBlocks(xml, 1)).toEqual(["<title>a</title>"]);
  });

  it("reads RSS 2.0 pubDate and stays linear on hostile input", () => {
    const rss2 =
      "<rss><channel><item><title>Fortinet FortiOS</title><link>https://a.example/x</link>" +
      "<pubDate>Wed, 28 Oct 2026 01:00:00 GMT</pubDate></item></channel></rss>";
    expect(parseAdvisoryFeed(rss2, "ipa")[0].published).toBe("2026-10-28T01:00:00.000Z");

    const n = 200_000;
    const hostile = [
      `<rss>${"<item>".repeat(n)}`,
      `<rss><item>${"<title>".repeat(n)}</item>`,
      `<rss><item><title>${"<".repeat(n)}</title></item>`,
      `<rss>${"<!--".repeat(n)}`,
      `<rss><item><title/>${"<title/>".repeat(n)}</item>`,
    ];
    const started = Date.now();
    for (const xml of hostile) {
      parseAdvisoryFeed(xml, "jpcert");
    }
    // Quadratic scans over 200k tags take minutes; linear ones milliseconds.
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe("fetchAdvisories", () => {
  it("fetches only allow-listed URLs and reports a failing feed as unavailable", async () => {
    const urls: string[] = [];
    const results = await fetchAdvisories({
      feeds: ["jpcert", "ipa", "jpcert"],
      products: ["Tomcat"],
      fetchText: async (url) => {
        urls.push(url);
        if (url === ADVISORY_FEEDS.ipa.url) {
          throw new Error("HTTP 503");
        }
        return JPCERT;
      },
    });
    expect(urls.toSorted()).toEqual([
      "https://www.ipa.go.jp/security/alert-rss.rdf",
      "https://www.jpcert.or.jp/rss/jpcert.rdf",
    ]);
    expect(results[0]).toMatchObject({ source: "jpcert", ok: true });
    expect(results[0].ok && results[0].items[1].matches).toEqual(["Tomcat"]);
    expect(results[1]).toEqual({ source: "ipa", ok: false, error: "HTTP 503" });
  });
});

describe("guardian_advisories tool", () => {
  const config = {
    guardian: { advisories: { products: ["Tomcat", "Microsoft"] } },
  } as KoLoConfig;
  const now = () => Date.parse("2026-10-30T00:00:00Z");
  const feeds: Record<string, string> = {
    [ADVISORY_FEEDS.jpcert.url]: JPCERT,
    [ADVISORY_FEEDS.ipa.url]: IPA,
  };
  const fetchText = async (url: string) => feeds[url];

  it("is offered only when guardian.advisories is configured", () => {
    expect(createGuardianAdvisoriesTool({ config: {} as KoLoConfig })).toBeNull();
    expect(
      createGuardianAdvisoriesTool({
        config: { guardian: { enabled: false, advisories: {} } } as KoLoConfig,
      }),
    ).toBeNull();
  });

  it("lists recent advisories newest first and flags configured products", async () => {
    const tool = createGuardianAdvisoriesTool({ config, fetchText, now })!;
    const res = (await tool.execute("c1", {})) as {
      content: Array<{ text: string }>;
      details: { count: number; matches: number; items: Array<{ title: string }> };
    };
    // The September item is outside the 14-day default window.
    expect(res.details.count).toBe(3);
    expect(res.details.matches).toBe(2);
    expect(res.details.items.map((i) => i.title)[0]).toContain("PHP");
    const text = res.content[0].text;
    expect(text).toContain("feed JPCERT/CC: ok (3 items)");
    expect(text).toContain("[MATCH: Tomcat]");
    expect(text).toContain("[MATCH: Microsoft]");
  });

  it("filters to matches and to one feed", async () => {
    const tool = createGuardianAdvisoriesTool({ config, fetchText, now })!;
    const res = (await tool.execute("c1", { feeds: ["ipa"], matchesOnly: true })) as {
      details: { items: Array<{ source: string }> };
    };
    expect(res.details.items.map((i) => i.source)).toEqual(["ipa"]);
  });

  it("names an unavailable feed and fails when no feed answers", async () => {
    const half = createGuardianAdvisoriesTool({
      config,
      now,
      fetchText: async (url) => {
        if (url === ADVISORY_FEEDS.ipa.url) {
          throw new Error("timeout");
        }
        return JPCERT;
      },
    })!;
    const res = (await half.execute("c1", {})) as { content: Array<{ text: string }> };
    expect(res.content[0].text).toContain("feed IPA: UNAVAILABLE (timeout)");

    const none = createGuardianAdvisoriesTool({
      config,
      now,
      fetchText: async () => {
        throw new Error("offline");
      },
    })!;
    await expect(none.execute("c1", {})).rejects.toThrow(/advisory feeds unavailable/);
  });
});
