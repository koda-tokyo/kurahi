// Shared scan data contracts; safe for browser consumers.
export type ScannedFile = { path: string; ext: string; size: number; head: string };

export type Scan = { root: string; base: string; files: ScannedFile[]; partial: boolean };
