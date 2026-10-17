// The app scrolls in exactly one place: the <main> panel under the navbar
// (see .app-scroll-panel in index.css). Pages that need the scroll position
// read it from here instead of keeping a scroll box of their own — nested
// scroll boxes are what made the wheel stop halfway down a page.
export const SCROLL_PANEL_ID = "app-scroll";

export function getScrollPanel() {
  return document.getElementById(SCROLL_PANEL_ID);
}
