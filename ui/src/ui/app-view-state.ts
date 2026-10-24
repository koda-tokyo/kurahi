import type { LitElement } from "lit";
import type { KoLoApp } from "./app";

/** Public application state consumed by renderers, derived from the implementation. */
export type AppViewState = Omit<KoLoApp, keyof LitElement>;
