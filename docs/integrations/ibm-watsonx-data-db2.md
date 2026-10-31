---
summary: "Read-only IBM data tools: one SQL statement on a watsonx.data Presto or Trino engine over the HTTP client protocol (catalog and schema allowlist, SELECT-only guard, row and byte limits), and allowlisted Db2 REST services (Db2 for z/OS native REST, Db2 LUW REST server) without a native driver"
read_when:
  - Agents need to read from watsonx.data or Db2 next to an existing IBM stack
  - You are reviewing what the data tools can and cannot reach
title: "watsonx.data and Db2"
---

# watsonx.data and Db2 (read-only)

Also available in [Japanese](/ja/integrations/ibm-watsonx-data-db2).

The `ibm-data` plugin (bundled, off by default) adds two optional tools. Both read only, return
their results as untrusted content, and audit ids and counts only (a hash of the SQL, row counts,
parameter names, outcome; never SQL text, parameter values or rows). Neither is in the autopilot's
read-tool catalogue, so a routine cannot use them to gather until that is decided separately.

**Status: Available.** Built on the Presto/Trino client protocol and IBM's Db2 REST
documentation; see [References](#references).

## watsonx_data_query

One statement per call on a watsonx.data Presto (Java or C++) or Trino engine, over the engines'
HTTP client protocol: `POST /v1/statement`, then `GET` each `nextUri` until the last page. No JDBC
or driver is involved.

```json5
{
  plugins: {
    entries: {
      "ibm-data": {
        enabled: true,
        config: {
          watsonxData: {
            url: "https://<engine-host>:<port>",
            // dialect: "trino",          // X-Trino-* headers instead of X-Presto-*
            user: "ibmlhapikey", // SaaS: ibmlhapikey or ibmlhapikey_<email>; software: a user
            password: { $secret: "watsonx-data-api-key" }, // API key or password
            catalogs: [{ name: "iceberg_data", schemas: ["sales", "ops"] }],
            maxRows: 200,
            maxBytes: 262144,
            timeoutMs: 60000,
          },
        },
      },
    },
  },
  agents: { list: [{ id: "analyst", tools: { allow: ["watsonx_data_query"] } }] },
}
```

Guards, in order:

1. **Catalog and schema allowlist.** The session catalog and schema must be listed; every table
   reference after `FROM`, `JOIN` or a comma in a `FROM` list must resolve inside the list
   (`table`, `schema.table`, `catalog.schema.table`). `SHOW CATALOGS` is refused; `SHOW SCHEMAS`
   and `SHOW TABLES` only name listed catalogs and schemas.
2. **Read-only statement.** One statement only; it must start with `SELECT`, `WITH`, `SHOW` or
   `DESCRIBE`; statement keywords that write or change the session (`INSERT`, `UPDATE`, `DELETE`,
   `MERGE`, `CREATE`, `DROP`, `ALTER`, `CALL`, `EXECUTE`, `SET`, `USE`, `EXPLAIN` and others) are
   refused anywhere outside string literals and quoted identifiers; table functions
   (`TABLE(...)`, which can pass SQL to a connector's own database) are refused.
3. **Limits.** At most `maxRows` rows and about `maxBytes` bytes are read; then the query is
   cancelled (`DELETE` on its `nextUri`) and the result is marked truncated. The whole query has
   `timeoutMs`.
4. **No credential leak.** Every `nextUri` must stay on the configured origin; redirects are
   refused.

The guard is a second line of defence. Configure the engine user as read-only and limited to the
listed catalogs in watsonx.data's access control. A column whose name is a refused keyword
(`comment`, `set`) must be written as a quoted identifier (`"comment"`). Some valid reads are
refused by the guard (for example `EXTRACT(YEAR FROM t.col)` with a qualified column); rewrite
them with an alias.

## db2_service_call

A Db2 REST service is a package with one static SQL statement, created by a Db2 administrator.
The tool calls only the services you list, with `POST`, and returns at most `maxRows` rows. It
cannot see a service's SQL: list read-only services only.

```json5
{
  plugins: {
    entries: {
      "ibm-data": {
        enabled: true,
        config: {
          db2: {
            connections: [
              // Db2 for z/OS native REST services (HTTP Basic, the RACF user of the service)
              {
                id: "zos-prod",
                kind: "zos",
                url: "https://db2z.example.com:4711",
                user: "RESTUSR",
                password: { $secret: "db2z-rest" },
              },
              // Db2 LUW REST server (token from /v1/auth)
              {
                id: "luw-dwh",
                kind: "luw",
                url: "https://db2rest.example.com:50050",
                user: "reporter",
                password: { $secret: "db2-luw-rest" },
                database: { host: "db2.example.com", name: "DWH", port: 50001, ssl: true },
              },
            ],
            services: [
              {
                name: "employees",
                connection: "zos-prod",
                collection: "SYSIBMSERVICE",
                service: "getEmployees",
                version: "V1",
                description: "Employees of one department",
                parameters: ["whichDept"],
              },
              {
                name: "open-orders",
                connection: "luw-dwh",
                service: "getOpenOrders",
                version: "1.0",
                description: "Open orders since a date",
                parameters: ["since"],
              },
            ],
            maxRows: 200,
          },
        },
      },
    },
  },
}
```

| Kind  | Request                                                                                                                                            | Answer read                                                                               |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `zos` | `POST <url>/services/<collection>/<service>[/<version>]`, Basic auth, JSON parameters                                                              | `ResultSet Output` rows; other `ResultSet <n> Output` counted; output parameters returned |
| `luw` | `POST <url>/v1/auth` (`dbParms`), then `POST <url>/v1/services/<service>/<version>` with `authorization: <token>` and `{ parameters, sync: true }` | `resultSet` rows                                                                          |

Parameters are limited to the names you list, and values to strings (at most 4000 characters),
numbers, booleans and null. The LUW token is cached per connection for 50 minutes and requested
again after a 401. No native Db2 driver (`ibm_db`) is used; for LUW workloads that need ad hoc SQL
rather than services, a driver-based tool is a separate decision.

## References

| Item                                                                                      | Source                                                                                                                                                                                                                                                                                                            |
| ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Presto/Trino HTTP client protocol (`/v1/statement`, `nextUri`, `X-*-User/Catalog/Schema`) | Presto and Trino client protocol documentation                                                                                                                                                                                                                                                                    |
| SaaS credentials `ibmlhapikey_<email>` + API key                                          | [watsonx.data connection](https://www.ibm.com/docs/en/DSXDOC/wsj/manage-data/conn-watsonxd.html)                                                                                                                                                                                                                  |
| Db2 for z/OS service URL and `ResultSet Output` shape                                     | [Db2 13 REST services](https://www.ibm.com/docs/SSEPEK_13.0.0/restserv/src/tpc/db2z_restservices.html), [testing the sample services](https://www.ibm.com/support/knowledgecenter/zh-CN/SS4SVW_3.0.0/tutorials/testing_db2_native_rest_services.html), [APAR PH07557](https://ibm.com/support/pages/apar/PH07557) |
| Db2 LUW `/v1/auth` with `dbParms` and `token`                                             | [Authenticating REST commands](https://www.ibm.com/docs/en/SSQNUZ_4.8.x/svc-db2/db2-rest-authenticate.html) (Cloud Pak for Data page)                                                                                                                                                                             |

Setup notes: on SaaS, sign in to the engine with the `ibmlhapikey` user (or `ibmlhapikey_<email>`)
and an API key, as in the example above. Db2 LUW REST services use the request shape in the table
above: the `authorization` header, a `{ parameters, sync: true }` body and `resultSet` rows.

Overview of the pack: [IBM watsonx](/integrations/ibm-watsonx).
