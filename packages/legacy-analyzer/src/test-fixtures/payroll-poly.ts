// Polyglot payroll fixture: a COBOL/DB2 posting program and its JCL, a Spring/JPA + JDBC Java
// service and the DB2 / Oracle DDL of the tables both sides use (EMPLOYEE, PAY_RESULT,
// DEPARTMENT). Names follow the payroll demo pack (EMP-RECORD fields, PAYCALC/PAYRPT jobs), and
// spellings vary on purpose (PAYROLL.EMPLOYEE, "employee", Employee entity) to test the joins.

import { A, B, C, program } from "./helpers.js";

export const PAYPOST = program("PAYPOST", {
  data: [
    A("WORKING-STORAGE SECTION."),
    C(" HOST VARIABLES FOR THE EMPLOYEE AND PAY_RESULT TABLES"),
    A("01  WS-EMP-ID PIC X(6)."),
    A("01  WS-BASE PIC 9(7)."),
    A("01  WS-GROSS PIC 9(9)."),
    A("01  WS-PERIOD PIC X(6) VALUE '202609'."),
  ],
  proc: [
    A("0000-MAIN."),
    B("PERFORM 1000-FETCH"),
    B("PERFORM 2000-POST"),
    B("STOP RUN."),
    A("1000-FETCH."),
    B("EXEC SQL SELECT BASE_PAY INTO :WS-BASE FROM EMPLOYEE"),
    B("    WHERE EMP_ID = :WS-EMP-ID END-EXEC."),
    A("2000-POST."),
    B("COMPUTE WS-GROSS = WS-BASE * 1"),
    B("EXEC SQL INSERT INTO PAY_RESULT (EMP_ID, PERIOD, GROSS)"),
    B("    VALUES (:WS-EMP-ID, :WS-PERIOD, :WS-GROSS) END-EXEC"),
    B("EXEC SQL UPDATE EMPLOYEE SET LAST_PERIOD = :WS-PERIOD"),
    B("    WHERE EMP_ID = :WS-EMP-ID END-EXEC."),
  ],
});

export const PYJOB = ["//PY02POST JOB (A),'PAYROLL POST'", "//S10      EXEC PGM=PAYPOST"].join(
  "\n",
);

export const DB2_DDL = `-- PY01 payroll schema (DB2 for z/OS)
CREATE TABLE PAYROLL.EMPLOYEE (
  EMP_ID       CHAR(6)       NOT NULL,          -- staff number
  EMP_DEPT     CHAR(3)       NOT NULL,
  EMP_NAME     VARCHAR(20),
  EMP_TYPE     CHAR(1)       NOT NULL WITH DEFAULT 'R',
  BASE_PAY     DECIMAL(7, 0) NOT NULL DEFAULT 0,
  LAST_PERIOD  CHAR(6)       FOR SBCS DATA,
  CONSTRAINT PK_EMPLOYEE PRIMARY KEY (EMP_ID),
  CONSTRAINT FK_EMP_DEPT FOREIGN KEY (EMP_DEPT) REFERENCES PAYROLL.DEPARTMENT (DEPT_CODE)
);

CREATE TABLE PAYROLL.DEPARTMENT (
  DEPT_CODE  CHAR(3)      NOT NULL PRIMARY KEY,
  DEPT_NAME  VARCHAR(40)  NOT NULL UNIQUE
);

/* results of the monthly run */
CREATE TABLE PAYROLL.PAY_RESULT (
  EMP_ID   CHAR(6)       NOT NULL REFERENCES PAYROLL.EMPLOYEE (EMP_ID),
  PERIOD   CHAR(6)       NOT NULL,
  GROSS    DECIMAL(9, 0) NOT NULL,
  PAID_AT  TIMESTAMP WITH TIME ZONE,
  PRIMARY KEY (EMP_ID, PERIOD)
);

CREATE UNIQUE INDEX PAYROLL.IX_PAY_PERIOD ON PAYROLL.PAY_RESULT (PERIOD, EMP_ID);

COMMENT ON TABLE PAYROLL.EMPLOYEE IS 'Employee master (one row per staff number)';
COMMENT ON COLUMN PAYROLL.PAY_RESULT.GROSS IS 'Gross pay in yen';
LABEL ON COLUMN PAYROLL.EMPLOYEE.BASE_PAY IS 'Monthly base pay';

CREATE VIEW PAYROLL.V_DEPT_PAY (DEPT_CODE, TOTAL_GROSS) AS
  SELECT E.EMP_DEPT, SUM(R.GROSS)
  FROM PAYROLL.PAY_RESULT R JOIN PAYROLL.EMPLOYEE E ON E.EMP_ID = R.EMP_ID
  GROUP BY E.EMP_DEPT;

GRANT SELECT ON PAYROLL.EMPLOYEE TO PAYRPT;
`;

export const ORACLE_DDL = `CREATE TABLE pay_audit (
  audit_id   NUMBER(10)     NOT NULL,
  emp_id     VARCHAR2(6 CHAR) NOT NULL,
  action     VARCHAR2(10)   DEFAULT 'POST',
  noted      VARCHAR2(200)  COMMENT 'free text',
  CONSTRAINT pk_pay_audit PRIMARY KEY (audit_id)
)
/
ALTER TABLE pay_audit ADD CONSTRAINT fk_audit_emp FOREIGN KEY (emp_id) REFERENCES employee (emp_id)
/
CREATE SEQUENCE pay_audit_seq START WITH 1
/
`;

const PKG = "src/main/java/jp/kazanami/payroll";

export const EMPLOYEE_JAVA = `package jp.kazanami.payroll.domain;

import jakarta.persistence.*;
import java.math.BigDecimal;

/** Employee master row. One per staff number. */
@Entity
@Table(name = "employee", schema = "payroll")
public class Employee {
    @Id
    @Column(name = "EMP_ID", length = 6)
    private String empId;

    @Column(name = "EMP_DEPT")
    private String dept;

    @Enumerated(EnumType.STRING)
    @Column(name = "EMP_TYPE")
    private EmpType type;

    private BigDecimal basePay;

    @Transient
    private String displayName;

    public enum EmpType { R, P, M }

    public String getEmpId() { return empId; }
    public BigDecimal getBasePay() { return basePay; }
    public EmpType getType() { return type; }
}
`;

export const PAY_RESULT_JAVA = `package jp.kazanami.payroll.domain;

import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import java.math.BigDecimal;

@Entity
public class PayResult {
    @Id private String empId;
    private String period;
    private BigDecimal gross;

    protected PayResult() {}

    public PayResult(String empId, String period, BigDecimal gross) {
        this.empId = empId;
        this.period = period;
        this.gross = gross;
    }
}
`;

export const EMPLOYEE_REPO_JAVA = `package jp.kazanami.payroll.repo;

import java.util.List;
import jp.kazanami.payroll.domain.Employee;
import org.springframework.data.jpa.repository.*;
import org.springframework.stereotype.Repository;

@Repository
public interface EmployeeRepository extends JpaRepository<Employee, String> {
    List<Employee> findByDept(String dept);

    @Query("SELECT e FROM Employee e WHERE e.type = :t")
    List<Employee> ofType(@Param("t") Employee.EmpType t);

    @Modifying
    @Query(value = "DELETE FROM PAY_RESULT WHERE PERIOD = ?1", nativeQuery = true)
    int purgePeriod(String period);
}
`;

export const DAO_JAVA = `package jp.kazanami.payroll.jdbc;

import java.math.BigDecimal;
import java.sql.ResultSet;
import java.util.List;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Repository;

@Repository
public class PayResultJdbcDao {
    private static final String INSERT_SQL =
        "INSERT INTO PAY_RESULT (EMP_ID, PERIOD, GROSS) " + "VALUES (?, ?, ?)";
    private static final String UNUSED_SQL = "SELECT COUNT(*) FROM PAY_AUDIT";

    private final JdbcTemplate jdbc;

    public PayResultJdbcDao(JdbcTemplate jdbc) { this.jdbc = jdbc; }

    public void insert(String empId, String period, BigDecimal gross) {
        jdbc.update(INSERT_SQL, empId, period, gross); // "not SQL { in a comment"
    }

    public List<String> deptTotals(String period) {
        String sql = """
            SELECT d.DEPT_NAME, SUM(r.GROSS)
              FROM PAY_RESULT r
              JOIN EMPLOYEE e ON e.EMP_ID = r.EMP_ID
              JOIN DEPARTMENT d ON d.DEPT_CODE = e.EMP_DEPT
             WHERE r.PERIOD = ?
             GROUP BY d.DEPT_NAME
            """;
        return jdbc.query(sql, new RowMapper<String>() {
            public String mapRow(ResultSet rs, int n) { return rs.getString(1); }
        }, period);
    }

    public int countRows(String table) {
        return jdbc.queryForObject("SELECT COUNT(*) FROM " + table + " WHERE 1 = 1", Integer.class);
    }
}
`;

export const PAY_MATH_JAVA = `package jp.kazanami.payroll.util;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.util.List;

public final class PayMath {
    static final int SCALE;
    static { SCALE = 0; }

    private PayMath() {}

    /** Round half up to whole yen. */
    public static BigDecimal round(BigDecimal v) {
        return v.setScale(SCALE, RoundingMode.HALF_UP);
    }

    public static <T extends Comparable<T>> T max(List<T> xs) {
        T best = null;
        for (T x : xs) { if (best == null || x.compareTo(best) > 0) best = x; }
        return best;
    }
}
`;

export const SERVICE_JAVA = `package jp.kazanami.payroll.service;

import static jp.kazanami.payroll.util.PayMath.round;

import java.math.BigDecimal;
import java.util.Map;
import java.util.List;
import jp.kazanami.payroll.domain.*;
import jp.kazanami.payroll.jdbc.PayResultJdbcDao;
import jp.kazanami.payroll.repo.EmployeeRepository;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/** Monthly payroll calculation (Java port of PAYCALC). */
@Service
public class PayrollService {
    private final EmployeeRepository employees;
    private final PayResultJdbcDao dao;
    private final Map<String, List<Long>> cache = new java.util.HashMap<>();

    public PayrollService(EmployeeRepository employees, PayResultJdbcDao dao) {
        this.employees = employees;
        this.dao = dao;
    }

    @Transactional
    public int calculate(String period) {
        int n = 0;
        for (Employee e : employees.findAll()) {
            BigDecimal gross = round(grossOf(e));
            dao.insert(e.getEmpId(), period, gross);
            new PayResult(e.getEmpId(), period, gross);
            n++;
        }
        employees.purgePeriod("000000");
        return n;
    }

    BigDecimal grossOf(Employee e) {
        return e.getBasePay().multiply(BigDecimal.ONE);
    }

    public void close(String period) {
        this.employees.save(null);
        jp.kazanami.payroll.util.PayMath.round(BigDecimal.ZERO);
        Runnable r = () -> helper();
        employees.findByDept("ASM").forEach(System.out::println);
    }

    private void helper() {}
}
`;

export const CONTROLLER_JAVA = `package jp.kazanami.payroll.web;

import java.math.BigDecimal;
import jp.kazanami.payroll.service.PayrollService;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/payroll")
public class PayrollController {
    private final PayrollService service;

    public PayrollController(PayrollService service) { this.service = service; }

    @PostMapping("/{period}/run")
    public PayDto run(@PathVariable String period) {
        int n = service.calculate(period);
        return new PayDto(period, BigDecimal.valueOf(n));
    }

    public record PayDto(String period, BigDecimal count) {
        public PayDto {
            if (period == null) throw new IllegalArgumentException("period");
        }
    }
}
`;

export const POLY_FILES: Record<string, string> = {
  "cobol/PAYPOST.cbl": PAYPOST,
  "jcl/PY02POST.jcl": PYJOB,
  "db/db2/payroll.sql": DB2_DDL,
  "db/oracle/audit.ddl": ORACLE_DDL,
  [`${PKG}/domain/Employee.java`]: EMPLOYEE_JAVA,
  [`${PKG}/domain/PayResult.java`]: PAY_RESULT_JAVA,
  [`${PKG}/repo/EmployeeRepository.java`]: EMPLOYEE_REPO_JAVA,
  [`${PKG}/jdbc/PayResultJdbcDao.java`]: DAO_JAVA,
  [`${PKG}/util/PayMath.java`]: PAY_MATH_JAVA,
  [`${PKG}/service/PayrollService.java`]: SERVICE_JAVA,
  [`${PKG}/web/PayrollController.java`]: CONTROLLER_JAVA,
  "legacy/fortran/RATES.f90": "program rates\n  print *, 'rates'\nend program rates",
  "plc/line1/Conveyor.st":
    "FUNCTION_BLOCK Conveyor\nVAR_INPUT start : BOOL; END_VAR\nEND_FUNCTION_BLOCK",
  "notes/README.txt": "not a source file",
};

export const JAVA_PKG = PKG;
