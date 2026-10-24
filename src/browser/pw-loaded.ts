// Set when the Playwright session module is evaluated. Shutdown paths check it so they do not load
// Playwright (hundreds of files) only to learn that no browser connection was ever opened.
let loaded = false;

export function markPlaywrightSessionLoaded(): void {
  loaded = true;
}

export function isPlaywrightSessionLoaded(): boolean {
  return loaded;
}
