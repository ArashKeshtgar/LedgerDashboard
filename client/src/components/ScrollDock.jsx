import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useLocation, useNavigationType } from "react-router-dom";
import { getScrollPanel } from "../scrollPanel.js";

// A floating control for the one scroll panel the app has:
//   ⤒ / ⤓   jump to the top / bottom of the page
//   ▲ / ▼   click: one screen up / down; press and hold: keep scrolling
//           (it speeds up the longer it is held) until you let go
// plus where you are on the page, as a percentage and a thin bar.
//
// It also makes navigation behave: a new page opens at its top, and going
// Back returns to where you were on the previous one (the list doesn't jump
// to row 1 after looking at an application). PageUp/PageDown/Home/End/Space
// and the arrow keys scroll the page even when nothing on it has focus.

const HOLD_DELAY_MS = 260; // shorter than this is a click, not a hold
const HOLD_START_SPEED = 700; // px per second when a hold begins
const HOLD_MAX_SPEED = 3200;
const HOLD_RAMP_MS = 1400; // time to reach full speed
const PAGE_FRACTION = 0.85; // one "screen" keeps a strip of context in view
const RESTORE_GIVE_UP_MS = 2500; // wait at most this long for data to load

function isTypingTarget(el) {
  if (!el || el === document.body) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}

function TopIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3.5 3h9M4 10l4-4 4 4" />
    </svg>
  );
}
function UpIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 10l4-4 4 4" />
    </svg>
  );
}
function DownIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 6l4 4 4-4" />
    </svg>
  );
}
function BottomIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 6l4 4 4-4M3.5 13h9" />
    </svg>
  );
}

export default function ScrollDock() {
  const location = useLocation();
  const navType = useNavigationType();
  const [state, setState] = useState({ scrollable: false, atTop: true, atBottom: true, progress: 0 });
  const hold = useRef(null); // { dir, startedAt, last, raf, timer, moved }
  const saved = useRef(new Map()); // location.key -> scrollTop
  // The page the scroll position belongs to. Set at commit, before the
  // scroll events the page change itself causes (content shrinking, the
  // jump to the top) arrive, so those never overwrite the old page's spot.
  const currentKey = useRef(location.key);
  const restoring = useRef(null);

  const measure = useCallback(() => {
    const el = getScrollPanel();
    if (!el) return;
    const max = el.scrollHeight - el.clientHeight;
    const top = el.scrollTop;
    const next = {
      scrollable: max > 40,
      atTop: top <= 2,
      atBottom: top >= max - 2,
      progress: max > 0 ? Math.round((top / max) * 100) : 0,
    };
    setState((s) =>
      s.scrollable === next.scrollable &&
      s.atTop === next.atTop &&
      s.atBottom === next.atBottom &&
      s.progress === next.progress
        ? s
        : next
    );
  }, []);

  const cancelRestore = useCallback(() => {
    if (restoring.current) cancelAnimationFrame(restoring.current);
    restoring.current = null;
  }, []);

  // Keep the readout current: on scroll, and when the page's content grows or
  // shrinks (data arriving, a section expanding).
  useEffect(() => {
    const el = getScrollPanel();
    if (!el) return undefined;
    let frame = 0;
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; measure(); });
      saved.current.set(currentKey.current, el.scrollTop);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    // A wheel, touch or key from the user wins over a pending Back-restore.
    const stopRestore = () => cancelRestore();
    el.addEventListener("wheel", stopRestore, { passive: true });
    el.addEventListener("touchstart", stopRestore, { passive: true });
    measure();
    return () => {
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("wheel", stopRestore);
      el.removeEventListener("touchstart", stopRestore);
      ro.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [measure, cancelRestore]);

  // New page → top. Back/forward → the position it was left at, once the
  // page has loaded enough content to scroll that far.
  useLayoutEffect(() => {
    const el = getScrollPanel();
    if (!el) return undefined;
    currentKey.current = location.key;
    cancelRestore();
    const target = navType === "POP" ? saved.current.get(location.key) : undefined;
    if (!target) {
      el.scrollTop = 0;
      return undefined;
    }
    const startedAt = performance.now();
    const tick = () => {
      if (el.scrollHeight - el.clientHeight >= target - 1) {
        el.scrollTop = target;
        restoring.current = null;
        return;
      }
      if (performance.now() - startedAt > RESTORE_GIVE_UP_MS) {
        el.scrollTop = target; // as far as it goes
        restoring.current = null;
        return;
      }
      restoring.current = requestAnimationFrame(tick);
    };
    tick();
    return cancelRestore;
  }, [location.key, navType, cancelRestore]);

  const scrollByPage = useCallback((dir) => {
    const el = getScrollPanel();
    if (!el) return;
    cancelRestore();
    el.scrollBy({ top: dir * el.clientHeight * PAGE_FRACTION, behavior: "smooth" });
  }, [cancelRestore]);

  const scrollToEnd = useCallback((dir) => {
    const el = getScrollPanel();
    if (!el) return;
    cancelRestore();
    el.scrollTo({ top: dir < 0 ? 0 : el.scrollHeight, behavior: "smooth" });
  }, [cancelRestore]);

  const stopHold = useCallback(() => {
    const h = hold.current;
    if (!h) return;
    clearTimeout(h.timer);
    if (h.raf) cancelAnimationFrame(h.raf);
    hold.current = null;
  }, []);

  function startHold(dir, e) {
    if (e.button !== undefined && e.button !== 0) return;
    stopHold();
    cancelRestore();
    const h = { dir, moved: false, raf: 0, timer: 0, startedAt: 0, last: 0 };
    hold.current = h;
    h.timer = setTimeout(() => {
      const el = getScrollPanel();
      if (!el || hold.current !== h) return;
      h.moved = true;
      h.startedAt = h.last = performance.now();
      const step = (now) => {
        if (hold.current !== h) return;
        const t = Math.min(1, (now - h.startedAt) / HOLD_RAMP_MS);
        const speed = HOLD_START_SPEED + (HOLD_MAX_SPEED - HOLD_START_SPEED) * t * t;
        el.scrollTop += h.dir * speed * ((now - h.last) / 1000);
        h.last = now;
        const max = el.scrollHeight - el.clientHeight;
        if ((h.dir < 0 && el.scrollTop <= 0) || (h.dir > 0 && el.scrollTop >= max - 1)) return;
        h.raf = requestAnimationFrame(step);
      };
      h.raf = requestAnimationFrame(step);
    }, HOLD_DELAY_MS);
  }

  function endHold(dir) {
    const h = hold.current;
    const wasHold = h?.moved;
    stopHold();
    if (h && !wasHold) scrollByPage(dir);
  }

  useEffect(() => stopHold, [stopHold]);

  // Keyboard scrolling when focus is on the page itself (nothing focused):
  // with the body fixed in place the browser would otherwise do nothing.
  useEffect(() => {
    function onKey(e) {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
      const active = document.activeElement;
      if (isTypingTarget(active)) return;
      if (active && active !== document.body && active.closest(".app-scroll-panel")) return; // browser handles it
      if (active && active !== document.body && (e.key === " " || e.key.startsWith("Arrow"))) return;
      const el = getScrollPanel();
      if (!el) return;
      const line = 60;
      switch (e.key) {
        case "PageDown": scrollByPage(1); break;
        case "PageUp": scrollByPage(-1); break;
        case " ": scrollByPage(e.shiftKey ? -1 : 1); break;
        case "Home": scrollToEnd(-1); break;
        case "End": scrollToEnd(1); break;
        case "ArrowDown": el.scrollBy({ top: line }); break;
        case "ArrowUp": el.scrollBy({ top: -line }); break;
        default: return;
      }
      e.preventDefault();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [scrollByPage, scrollToEnd]);

  if (!state.scrollable) return null;

  const holdProps = (dir) => ({
    onPointerDown: (e) => startHold(dir, e),
    onPointerUp: () => endHold(dir),
    onPointerLeave: stopHold,
    onPointerCancel: stopHold,
    onContextMenu: (e) => e.preventDefault(),
    onKeyDown: (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        e.stopPropagation();
        scrollByPage(dir);
      }
    },
  });

  return (
    <div className="scroll-dock" role="toolbar" aria-label="Page scrolling">
      <button
        type="button"
        className="scroll-dock-btn"
        title="Top of page (Home)"
        aria-label="Top of page"
        disabled={state.atTop}
        onClick={() => scrollToEnd(-1)}
      >
        <TopIcon />
      </button>
      <button
        type="button"
        className="scroll-dock-btn"
        title="Up one screen — hold to keep scrolling (PageUp)"
        aria-label="Up one screen"
        disabled={state.atTop}
        {...holdProps(-1)}
      >
        <UpIcon />
      </button>
      <div className="scroll-dock-pos" aria-live="off" title="Position on this page">
        <div className="scroll-dock-bar">
          <div className="scroll-dock-bar-fill" style={{ height: `${state.progress}%` }} />
        </div>
        <span>{state.progress}%</span>
      </div>
      <button
        type="button"
        className="scroll-dock-btn"
        title="Down one screen — hold to keep scrolling (PageDown)"
        aria-label="Down one screen"
        disabled={state.atBottom}
        {...holdProps(1)}
      >
        <DownIcon />
      </button>
      <button
        type="button"
        className="scroll-dock-btn"
        title="Bottom of page (End)"
        aria-label="Bottom of page"
        disabled={state.atBottom}
        onClick={() => scrollToEnd(1)}
      >
        <BottomIcon />
      </button>
    </div>
  );
}
