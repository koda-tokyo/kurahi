import { describe, expect, it } from "vitest";
import { parseMyBatisMapper } from "./java-mybatis.js";
import { parseJavaFile } from "./java-parser.js";
import { analyseJava } from "./java-resolve.js";
import { detectLanguages } from "./registry.js";

const MAPPER_JAVA = `package jp.kazanami.payroll.mapper;

public interface PayResultMapper {
  java.util.List<Object> findByEmployee(String employeeId);
  int insertResult(Object result);
}
`;

const SERVICE_JAVA = `package jp.kazanami.payroll.service;

import jp.kazanami.payroll.mapper.PayResultMapper;

public class PayHistoryService {
  private final PayResultMapper mapper;

  public PayHistoryService(PayResultMapper mapper) {
    this.mapper = mapper;
  }

  public void history(String id) {
    mapper.findByEmployee(id);
  }
}
`;

const MAPPER_XML = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE mapper PUBLIC "-//mybatis.org//DTD Mapper 3.0//EN" "http://mybatis.org/dtd/mybatis-3-mapper.dtd">
<mapper namespace="jp.kazanami.payroll.mapper.PayResultMapper">
  <sql id="cols">EMP_ID, PERIOD, NET_PAY</sql>
  <!-- old query: <select id="legacy">SELECT * FROM OLD_PAY</select> -->
  <select id="findByEmployee" resultType="map">
    SELECT <include refid="cols"/>
    FROM PAY_RESULT r JOIN EMPLOYEE e ON e.EMP_ID = r.EMP_ID
    <where>
      <if test="employeeId != null">r.EMP_ID = #{employeeId}</if>
      <![CDATA[ AND r.NET_PAY < 1000000 ]]>
    </where>
    ORDER BY \${orderBy}
  </select>
  <insert id="insertResult">
    INSERT INTO PAY_RESULT (<include refid="cols"/>) VALUES (#{empId}, #{period}, #{netPay})
  </insert>
  <delete id="purgeOld">DELETE FROM PAY_AUDIT WHERE PERIOD &lt; #{cutoff}</delete>
</mapper>
`;

describe("MyBatis mapper XML", () => {
  it("reads statements with path:line, expands includes and marks ${} partial", () => {
    const m = parseMyBatisMapper("PayResultMapper.xml", MAPPER_XML);
    expect(m?.namespace).toBe("jp.kazanami.payroll.mapper.PayResultMapper");
    expect(m?.line).toBe(3);
    // The commented-out <select> is not a statement.
    expect(m?.statements.map((s) => [s.kind, s.id, s.line, s.partial ?? false])).toEqual([
      ["select", "findByEmployee", 6, true],
      ["insert", "insertResult", 15, false],
      ["delete", "purgeOld", 18, false],
    ]);
    expect(m?.statements[0].text).toBe(
      "SELECT EMP_ID, PERIOD, NET_PAY FROM PAY_RESULT r JOIN EMPLOYEE e ON e.EMP_ID = r.EMP_ID " +
        "r.EMP_ID = ? AND r.NET_PAY < 1000000 ORDER BY ?",
    );
    expect(m?.statements[2].text).toBe("DELETE FROM PAY_AUDIT WHERE PERIOD < ?");
  });

  it("returns null for XML that is not a mapper", () => {
    expect(parseMyBatisMapper("pom.xml", "<project><artifactId>x</artifactId></project>")).toBe(
      null,
    );
  });

  it("binds statements to the namespace interface; callers inherit the access", () => {
    const a = analyseJava(
      [
        parseJavaFile("PayResultMapper.java", MAPPER_JAVA),
        parseJavaFile("PayHistoryService.java", SERVICE_JAVA),
      ],
      [parseMyBatisMapper("PayResultMapper.xml", MAPPER_XML)!],
    );
    const own = a.tableUses.filter((u) => u.file === "PayResultMapper.xml");
    expect(own.map((u) => [u.line, u.table, u.ops.join(""), u.method ?? "", u.partial ?? false]))
      .toMatchInlineSnapshot(`
        [
          [
            6,
            "EMPLOYEE",
            "R",
            "findByEmployee(String)",
            true,
          ],
          [
            6,
            "PAY_RESULT",
            "R",
            "findByEmployee(String)",
            true,
          ],
          [
            15,
            "PAY_RESULT",
            "C",
            "insertResult(Object)",
            false,
          ],
          [
            18,
            "PAY_AUDIT",
            "D",
            "",
            false,
          ],
        ]
      `);
    expect(own.every((u) => u.type === "jp.kazanami.payroll.mapper.PayResultMapper")).toBe(true);
    // The service reaches PAY_RESULT and EMPLOYEE through the mapper call.
    const svc = a.tableUses.filter(
      (u) => u.type === "jp.kazanami.payroll.service.PayHistoryService",
    );
    expect(svc.map((u) => u.table).toSorted()).toEqual(["EMPLOYEE", "PAY_RESULT"]);
    // purgeOld has no interface method in the sources.
    expect(a.mybatisUnbound).toEqual([
      {
        file: "PayResultMapper.xml",
        line: 18,
        namespace: "jp.kazanami.payroll.mapper.PayResultMapper",
        id: "purgeOld",
      },
    ]);
  });

  it("is detected as Java from its DOCTYPE or <mapper namespace>, other XML is not", () => {
    const file = (path: string, head: string) => ({ path, ext: ".xml", size: head.length, head });
    const { byLanguage } = detectLanguages([
      file("a/PayResultMapper.xml", MAPPER_XML),
      file("b/Bare.xml", '<mapper namespace="x.Y"></mapper>'),
      file("pom.xml", "<project/>"),
    ]);
    expect((byLanguage.get("java") ?? []).map((f) => f.path)).toEqual([
      "a/PayResultMapper.xml",
      "b/Bare.xml",
    ]);
  });
});
