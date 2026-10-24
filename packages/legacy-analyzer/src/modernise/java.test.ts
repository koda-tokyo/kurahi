import { describe, expect, it } from "vitest";
import {
  CONTROLLER_JAVA,
  DAO_JAVA,
  EMPLOYEE_JAVA,
  EMPLOYEE_REPO_JAVA,
  PAY_MATH_JAVA,
  PAY_RESULT_JAVA,
  SERVICE_JAVA,
} from "../test-fixtures/payroll-poly.js";
import { parseJavaFile } from "./java-parser.js";
import { analyseJava } from "./java-resolve.js";

const files = () => [
  parseJavaFile("Employee.java", EMPLOYEE_JAVA),
  parseJavaFile("PayResult.java", PAY_RESULT_JAVA),
  parseJavaFile("EmployeeRepository.java", EMPLOYEE_REPO_JAVA),
  parseJavaFile("PayResultJdbcDao.java", DAO_JAVA),
  parseJavaFile("PayMath.java", PAY_MATH_JAVA),
  parseJavaFile("PayrollService.java", SERVICE_JAVA),
  parseJavaFile("PayrollController.java", CONTROLLER_JAVA),
];

describe("Java declarations", () => {
  it("reads package, imports, types, nested types, records and enums with path:line", () => {
    const f = parseJavaFile("Employee.java", EMPLOYEE_JAVA);
    expect(f.package).toBe("jp.kazanami.payroll.domain");
    expect(f.imports).toEqual([
      {
        file: "Employee.java",
        line: 3,
        name: "jakarta.persistence",
        static: false,
        wildcard: true,
      },
      {
        file: "Employee.java",
        line: 4,
        name: "java.math.BigDecimal",
        static: false,
        wildcard: false,
      },
    ]);
    const [emp, kind] = f.types;
    expect(emp).toMatchObject({
      name: "Employee",
      kind: "class",
      line: 7,
      endLine: 31,
      doc: "Employee master row.",
    });
    expect(emp.annotations.map((a) => [a.name, a.line, a.args])).toEqual([
      ["Entity", 7, {}],
      ["Table", 8, { name: "employee", schema: "payroll" }],
    ]);
    expect(emp.fields.map((x) => [x.name, x.type, x.line])).toEqual([
      ["empId", "String", 12],
      ["dept", "String", 15],
      ["type", "EmpType", 19],
      ["basePay", "BigDecimal", 21],
      ["displayName", "String", 24],
    ]);
    expect(kind).toMatchObject({
      name: "EmpType",
      kind: "enum",
      qualifiedName: "jp.kazanami.payroll.domain.Employee.EmpType",
      outer: "jp.kazanami.payroll.domain.Employee",
    });
    expect(kind.enumConstants.map((c) => c.name)).toEqual(["R", "P", "M"]);

    const ctl = parseJavaFile("C.java", CONTROLLER_JAVA);
    const dto = ctl.types.find((t) => t.kind === "record");
    expect(dto?.recordComponents).toEqual([
      { type: "String", name: "period" },
      { type: "BigDecimal", name: "count" },
    ]);
    expect(dto?.methods[0]).toMatchObject({
      kind: "constructor",
      signature: "PayDto(String, BigDecimal)",
      line: 21,
    });
  });

  it("keeps generics, varargs, throws and annotations in signatures", () => {
    const f = parseJavaFile(
      "G.java",
      [
        "package g;",
        "public abstract class G<K extends Comparable<K>, V> extends Base<Map<K, List<V>>> implements Runnable, java.io.Serializable {",
        "  protected abstract <T extends Number> Map<String, List<T>> group(final List<? super T>[] in, String... keys) throws java.io.IOException, IllegalStateException;",
        "  int[] counts = { 1, 2 }, other;",
        "  @Override public void run() { String s = \"} not a brace {\"; char c = '}'; }",
        "}",
      ].join("\n"),
    );
    const g = f.types[0];
    expect(g.typeParams).toBe("<K extends Comparable<K>, V>");
    expect(g.extends).toEqual(["Base<Map<K, List<V>>>"]);
    expect(g.implements).toEqual(["Runnable", "java.io.Serializable"]);
    const m = g.methods[0];
    expect(m).toMatchObject({
      name: "group",
      abstract: true,
      line: 3,
      signature: "group(List<? super T>[], String...)",
    });
    expect(m.returnType).toBe("<T extends Number> Map<String, List<T>>");
    expect(m.throws).toEqual(["java.io.IOException", "IllegalStateException"]);
    expect(g.fields.map((x) => `${x.type} ${x.name}`)).toEqual(["int[] counts", "int[] other"]);
    expect(g.methods[1]).toMatchObject({ name: "run", line: 5, endLine: 5 });
    expect(f.gaps).toEqual([]);
  });

  it("reports constructs it does not model as gaps with their line", () => {
    const gaps = files().flatMap((f) => f.gaps);
    expect(gaps.map((g) => `${g.file}:${g.line} ${g.construct}`)).toEqual([
      "PayResultJdbcDao.java:33 anonymous class",
      "PayMath.java:9 initializer block",
    ]);
  });
});

describe("Java facts across files", () => {
  const a = analyseJava(files());
  it("resolves calls only where the target is statically known", () => {
    const c = a.calls.map(
      (x) =>
        `${x.from.split(".").pop()} -> ${x.to.map((t) => t.split(".").pop()).join(",")} [${x.resolution}]`,
    );
    expect(c).toContain(
      "PayrollService#calculate(String) -> PayMath#round(BigDecimal) [static import]",
    );
    expect(c).toContain(
      "PayrollService#calculate(String) -> PayrollService#grossOf(Employee) [same class]",
    );
    expect(c).toContain(
      "PayrollService#calculate(String) -> PayResultJdbcDao#insert(String, String, BigDecimal) [field type]",
    );
    expect(c).toContain(
      "PayrollService#close(String) -> PayMath#round(BigDecimal) [qualified name]",
    );
    expect(c).toContain(
      "PayrollController#run(String) -> PayrollService#calculate(String) [field type]",
    );
    expect(c).toContain(
      "PayrollController#run(String) -> PayDto#PayDto(String, BigDecimal) [constructor]",
    );
    const un = a.unresolved.map((u) => `${u.qualifier ?? ""}.${u.name}`);
    expect(un).toContain("e.getEmpId"); // local variable: not resolved, listed
    expect(un).toContain("employees.findAll"); // inherited from a type outside the sources
    expect(a.unresolved.find((u) => u.name === "findAll")?.reason).toMatch(/outside the sources/);
  });

  it("finds JPA mappings, repository and JDBC table access with CRUD operations", () => {
    const rows = a.tableUses.map(
      (u) => `${u.file}:${u.line} ${u.type.split(".").pop()} ${u.table} ${u.ops.join("")} ${u.via}`,
    );
    expect(rows).toEqual([
      "Employee.java:8 Employee EMPLOYEE  @Table",
      "EmployeeRepository.java:8 EmployeeRepository EMPLOYEE  Spring Data repository of Employee",
      "EmployeeRepository.java:10 EmployeeRepository EMPLOYEE R derived query findByDept",
      "EmployeeRepository.java:12 EmployeeRepository EMPLOYEE R @Query SELECT",
      "EmployeeRepository.java:16 EmployeeRepository PAY_RESULT D @Query native DELETE",
      "PayResult.java:7 PayResult PAY_RESULT  @Entity (default name)",
      "PayResultJdbcDao.java:14 PayResultJdbcDao PAY_AUDIT R SQL constant UNUSED_SQL (no method reference found)",
      "PayResultJdbcDao.java:21 PayResultJdbcDao PAY_RESULT C JDBC INSERT (constant INSERT_SQL)",
      "PayResultJdbcDao.java:25 PayResultJdbcDao DEPARTMENT R JDBC SELECT",
      "PayResultJdbcDao.java:25 PayResultJdbcDao EMPLOYEE R JDBC SELECT",
      "PayResultJdbcDao.java:25 PayResultJdbcDao PAY_RESULT R JDBC SELECT",
      "PayrollService.java:29 PayrollService EMPLOYEE R EmployeeRepository.findAll (inherited)",
      "PayrollService.java:35 PayrollService PAY_RESULT D EmployeeRepository.purgePeriod",
      "PayrollService.java:44 PayrollService EMPLOYEE CU EmployeeRepository.save (inherited)",
      "PayrollService.java:47 PayrollService EMPLOYEE R EmployeeRepository.findByDept",
    ]);
    const ins = a.tableUses.find((u) => u.via.includes("INSERT_SQL"));
    expect(ins?.declaredAt).toEqual({ file: "PayResultJdbcDao.java", line: 12 });
    expect(ins?.text).toBe("INSERT INTO PAY_RESULT (EMP_ID, PERIOD, GROSS) VALUES (?, ?, ?)");
    expect(
      a.columns
        .filter((c) => c.table === "EMPLOYEE")
        .map((c) => `${c.field}=${c.column}${c.implicit ? "*" : ""}`),
    ).toEqual(["empId=EMP_ID", "dept=EMP_DEPT", "type=EMP_TYPE", "basePay=BASE_PAY*"]);
    expect(a.stereotypes["jp.kazanami.payroll.repo.EmployeeRepository"]).toEqual([
      "Repository",
      "Spring Data repository",
    ]);
  });

  it("marks SQL built from non-literal parts as partial", () => {
    const f = parseJavaFile("Dao.java", DAO_JAVA);
    const sql = f.types[0].methods.find((m) => m.name === "countRows")?.sql ?? [];
    expect(sql).toHaveLength(1);
    expect(sql[0]).toMatchObject({ op: "SELECT", partial: true, tables: [] });
  });

  it("handles sealed interfaces, switch expressions, lambdas, inner classes and enum bodies", () => {
    const f = parseJavaFile(
      "Shape.java",
      [
        "package t;",
        '@SuppressWarnings({"unchecked", "rawtypes"})',
        "public sealed interface Shape permits Circle, Square {",
        "  int SIDES = 0;",
        '  default double area() { return switch (kind()) { case "c" -> 1.0; default -> { yield 2.0; } }; }',
        "  String kind();",
        '  @interface Marker { String value() default "x"; int[] ids() default {1, 2}; }',
        "}",
        "final class Circle implements Shape {",
        "  private final java.util.function.Function<String, Integer> f = s -> { return s.length(); };",
        "  private static final char OPEN = '{';",
        '  public String kind() { return "c"; }',
        "  private void helper() { Inner i = this.new Inner(); Runnable r = Circle::stat; }",
        "  static void stat() {}",
        "  class Inner { void run() { helper(); } }",
        "}",
        "enum Square implements Shape {",
        '  A("a") { public String kind() { return "a"; } }, B("b");',
        "  private final String code;",
        "  Square(String code) { this.code = code; }",
        "  public String kind() { return code; }",
        "}",
      ].join("\n"),
    );
    expect(f.types.map((t) => `${t.kind} ${t.qualifiedName} ${t.line}-${t.endLine}`)).toEqual([
      "interface t.Shape 2-8",
      "annotation t.Shape.Marker 7-7",
      "class t.Circle 9-16",
      "class t.Circle.Inner 15-15",
      "enum t.Square 17-22",
    ]);
    expect(f.types[0].annotations[0].args.value).toBe('{ "unchecked", "rawtypes" }');
    expect(f.types[2].fields.map((x) => x.name)).toEqual(["f", "OPEN"]);
    expect(f.gaps.map((g) => `${g.line} ${g.construct}`)).toEqual(["18 enum constant body"]);
    const calls = analyseJava([f]).calls.map(
      (c) => `${c.from} -> ${c.to.join(",")} [${c.resolution}]`,
    );
    expect(calls).toEqual([
      "t.Shape#area() -> t.Shape#kind() [same class]",
      "t.Circle#helper() -> t.Circle.Inner [default constructor]",
      "t.Circle#helper() -> t.Circle#stat() [type name]",
      "t.Circle.Inner#run() -> t.Circle#helper() [enclosing type]",
    ]);
  });

  it("never throws on truncated sources", () => {
    for (const src of [DAO_JAVA, SERVICE_JAVA, CONTROLLER_JAVA]) {
      for (let i = 0; i < src.length; i += 5) {
        expect(() =>
          analyseJava([
            parseJavaFile("a.java", src.slice(0, i)),
            parseJavaFile("b.java", src.slice(i)),
          ]),
        ).not.toThrow();
      }
    }
  });

  it("maps JPQL entity names to tables and marks path joins as partial", () => {
    const repo = [
      "package jp.kazanami.payroll.repo;",
      "import jp.kazanami.payroll.domain.Employee;",
      "public interface DeptQueries extends org.springframework.data.repository.Repository<Employee, String> {",
      '  @Query("SELECT e FROM Employee e JOIN e.dept d WHERE d.code = :c")',
      "  java.util.List<Employee> inDept(String c);",
      "}",
    ].join("\n");
    const a = analyseJava([
      parseJavaFile("Employee.java", EMPLOYEE_JAVA),
      parseJavaFile("DeptQueries.java", repo),
    ]);
    const q = a.tableUses.filter((u) => u.via.startsWith("@Query"));
    expect(
      q.map((u) => `${u.table} ${u.ops.join("")} ${u.partial ?? false} ${u.file}:${u.line}`),
    ).toEqual(["EMPLOYEE R true DeptQueries.java:4"]);
  });
});
