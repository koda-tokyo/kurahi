import { z } from "zod";

// plugins.entries.ibm-data.config. Both halves are inert until an administrator configures them:
// watsonxData needs an engine URL and at least one catalog; db2 needs at least one service.

const NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const SQL_NAME = /^[A-Za-z_][A-Za-z0-9_$]{0,127}$/;
/** Db2 object and version names; never "." or ".." (they become URL path segments). */
const DB2_NAME = /^(?!\.{1,2}$)[A-Za-z0-9_#@$.-]{1,128}$/;

const httpsUrl = z
  .string()
  .trim()
  .url()
  .refine((raw) => {
    const u = new URL(raw);
    return u.protocol === "https:" && !u.username && !u.password && !u.search && !u.hash;
  }, "must be an https URL without credentials, query or fragment");

const limits = {
  maxRows: z.number().int().min(1).max(5000).default(200),
  maxBytes: z.number().int().min(4096).max(4_194_304).default(262_144),
  timeoutMs: z.number().int().min(1000).max(600_000).default(60_000),
};

export const WatsonxDataSchema = z
  .object({
    /** Presto (Java or C++) or Trino coordinator, e.g. https://<host>:<port>. */
    url: httpsUrl,
    /** Header family of the HTTP client protocol: X-Presto-* or X-Trino-*. */
    dialect: z.enum(["presto", "trino"]).default("presto"),
    /** "basic": user + password (SaaS: user ibmlhapikey or ibmlhapikey_<email>, password = API key). */
    auth: z.enum(["basic", "bearer"]).default("basic"),
    user: z.string().trim().min(1).max(256).default("ibmlhapikey"),
    /** API key, password or bearer token. Use a `{ "$secret": "<name>" }` reference. */
    password: z.string().trim().min(1),
    /** The only catalogs and schemas a query may name. The first entry is the default. */
    catalogs: z
      .array(
        z
          .object({
            name: z.string().regex(SQL_NAME),
            schemas: z.array(z.string().regex(SQL_NAME)).min(1).max(100),
          })
          .strict(),
      )
      .min(1)
      .max(50),
    ...limits,
  })
  .strict();

export const Db2ConnectionSchema = z
  .object({
    id: z.string().regex(NAME),
    /** "zos": Db2 for z/OS native REST services. "luw": the Db2 (LUW) REST server. */
    kind: z.enum(["zos", "luw"]),
    /** z/OS: https://<host>:<port> of the Db2 subsystem. LUW: the REST server's base URL. */
    url: httpsUrl,
    user: z.string().trim().min(1).max(256),
    /** Use a `{ "$secret": "<name>" }` reference. */
    password: z.string().trim().min(1),
    /** LUW only: the database the REST server connects to (dbParms of /v1/auth). */
    database: z
      .object({
        host: z.string().trim().min(1).max(253),
        name: z.string().trim().min(1).max(128),
        port: z.number().int().min(1).max(65_535),
        ssl: z.boolean().default(true),
      })
      .strict()
      .optional(),
  })
  .strict();

export const Db2ServiceSchema = z
  .object({
    /** Name the model uses in db2_service_call. */
    name: z.string().regex(NAME),
    connection: z.string().regex(NAME),
    /** z/OS: the collection id (e.g. SYSIBMSERVICE). Not used for LUW. */
    collection: z.string().regex(DB2_NAME).optional(),
    service: z.string().regex(DB2_NAME),
    version: z.string().regex(DB2_NAME).optional(),
    description: z.string().trim().min(1).max(500),
    /** Parameter names the model may pass; anything else is refused. */
    parameters: z.array(z.string().regex(DB2_NAME)).max(50).default([]),
  })
  .strict();

export const Db2Schema = z
  .object({
    connections: z.array(Db2ConnectionSchema).max(20).default([]),
    /** Only services whose SQL reads data belong here: the tool cannot see a service's SQL. */
    services: z.array(Db2ServiceSchema).max(100).default([]),
    ...limits,
  })
  .strict();

export const IbmDataConfigSchema = z
  .object({
    watsonxData: WatsonxDataSchema.optional(),
    db2: Db2Schema.optional(),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    const db2 = cfg.db2;
    if (!db2) {
      return;
    }
    const conns = new Map(db2.connections.map((c) => [c.id, c]));
    if (conns.size !== db2.connections.length) {
      ctx.addIssue({
        code: "custom",
        path: ["db2", "connections"],
        message: "duplicate connection id",
      });
    }
    db2.connections.forEach((c, i) => {
      if (c.kind === "luw" && !c.database) {
        ctx.addIssue({
          code: "custom",
          path: ["db2", "connections", i, "database"],
          message: "LUW connections need database { host, name, port }",
        });
      }
    });
    const names = new Set<string>();
    db2.services.forEach((s, i) => {
      const conn = conns.get(s.connection);
      if (!conn) {
        ctx.addIssue({
          code: "custom",
          path: ["db2", "services", i, "connection"],
          message: `unknown connection "${s.connection}"`,
        });
      } else if (conn.kind === "zos" && !s.collection) {
        ctx.addIssue({
          code: "custom",
          path: ["db2", "services", i, "collection"],
          message: "z/OS services need a collection id",
        });
      } else if (conn.kind === "luw" && !s.version) {
        ctx.addIssue({
          code: "custom",
          path: ["db2", "services", i, "version"],
          message: "LUW services need a version",
        });
      }
      if (names.has(s.name)) {
        ctx.addIssue({
          code: "custom",
          path: ["db2", "services", i, "name"],
          message: "duplicate name",
        });
      }
      names.add(s.name);
    });
  });

export type IbmDataConfig = z.infer<typeof IbmDataConfigSchema>;
export type WatsonxDataConfig = z.infer<typeof WatsonxDataSchema>;
export type Db2Config = z.infer<typeof Db2Schema>;
export type Db2Connection = z.infer<typeof Db2ConnectionSchema>;
export type Db2Service = z.infer<typeof Db2ServiceSchema>;

export function parseIbmDataConfig(value: unknown): IbmDataConfig {
  const result = IbmDataConfigSchema.safeParse(value ?? {});
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("; ");
    throw new Error(`invalid ibm-data config: ${issues}`);
  }
  return result.data;
}

export const ibmDataPluginConfigSchema = {
  safeParse(value: unknown) {
    const result = IbmDataConfigSchema.safeParse(value ?? {});
    if (result.success) {
      return { success: true, data: result.data };
    }
    return {
      success: false,
      error: {
        issues: result.error.issues.map((issue) => ({
          path: issue.path.filter((p): p is string | number => typeof p !== "symbol"),
          message: issue.message,
        })),
      },
    };
  },
  uiHints: {
    "watsonxData.password": { label: "watsonx.data API key or password", sensitive: true },
    "db2.connections": { label: "Db2 REST connections" },
    "db2.services": { label: "Db2 REST services the model may call" },
  },
};
