// Lazy module loading for startup-critical import graphs.
//
// Several registries (the plugin runtime, the CLI send deps) hand out references to channel and
// provider functions whose modules pull in large SDKs (Slack Bolt, discord carbon, grammy, LINE,
// Baileys, Playwright). Importing those statically made every CLI command and every gateway start
// load and compile thousands of files that most installs never use. `lazyModule` defers the import
// to the first call; `lazyAsync` wraps one async export so its signature is unchanged (it already
// returns a promise, so awaiting the import first is not observable to the caller).

type AnyAsyncFn = (...args: never[]) => Promise<unknown>;

export type LazyModule<M> = {
  /** Loads the module once; concurrent and later calls share the same promise. */
  load: () => Promise<M>;
  /** Wraps an async export so calling it loads the module first. */
  fn: <K extends { [P in keyof M]: M[P] extends AnyAsyncFn ? P : never }[keyof M]>(key: K) => M[K];
};

export function lazyModule<M>(importer: () => Promise<M>): LazyModule<M> {
  let pending: Promise<M> | null = null;
  const load = () => {
    if (!pending) {
      pending = importer().catch((err: unknown) => {
        // A failed import (e.g. a missing optional native dependency) must not stick: the next
        // call retries, as a static import would have failed again on the next process start.
        pending = null;
        throw err;
      });
    }
    return pending;
  };
  return {
    load,
    fn: (key) =>
      ((...args: unknown[]) =>
        load().then((mod) =>
          (mod[key] as unknown as (...a: unknown[]) => Promise<unknown>)(...args),
        )) as never,
  };
}
