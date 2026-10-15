import { useEffect, useRef, type RefObject } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";

export type TauriFileDropHandlers = {
  /** ゾーン上にファイルが乗っているとき */
  onHover?: (over: boolean) => void;
  /** 絶対パスの配列（OS ドロップ） */
  onDrop: (paths: string[]) => void;
  enabled?: boolean;
};

type DropTarget = {
  id: number;
  el: HTMLElement;
  onHover?: (over: boolean) => void;
  onDrop: (paths: string[]) => void;
};

let nextId = 1;
const targets = new Map<number, DropTarget>();
let listenerCount = 0;
let unlistenPromise: Promise<() => void> | null = null;
let hoverId: number | null = null;

function setHover(next: DropTarget | null) {
  if (hoverId === (next?.id ?? null)) return;
  if (hoverId != null) {
    targets.get(hoverId)?.onHover?.(false);
  }
  hoverId = next?.id ?? null;
  next?.onHover?.(true);
}

function findTargetAt(clientX: number, clientY: number): DropTarget | null {
  const hit = document.elementFromPoint(clientX, clientY);
  if (!hit) return null;
  let node: Element | null = hit;
  while (node) {
    for (const t of targets.values()) {
      if (t.el === node) return t;
    }
    node = node.parentElement;
  }
  return null;
}

async function toClientPoint(
  position: { x: number; y: number },
): Promise<{ x: number; y: number }> {
  const scale = await getCurrentWindow().scaleFactor();
  return { x: position.x / scale, y: position.y / scale };
}

async function ensureListener() {
  if (unlistenPromise) return;
  unlistenPromise = getCurrentWebview().onDragDropEvent((event) => {
    const payload = event.payload;
    if (payload.type === "leave") {
      setHover(null);
      return;
    }
    void (async () => {
      if (payload.type === "enter" || payload.type === "over") {
        const pt = await toClientPoint(payload.position);
        setHover(findTargetAt(pt.x, pt.y));
        return;
      }
      if (payload.type === "drop") {
        const pt = await toClientPoint(payload.position);
        const target = findTargetAt(pt.x, pt.y);
        setHover(null);
        if (target && payload.paths.length > 0) {
          target.onDrop(payload.paths);
        }
      }
    })();
  });
}

async function releaseListener() {
  if (listenerCount > 0 || !unlistenPromise) return;
  const p = unlistenPromise;
  unlistenPromise = null;
  const unlisten = await p;
  unlisten();
  setHover(null);
}

/**
 * Tauri ネイティブのファイルドロップを要素にバインドする。
 * `dragDropEnabled: true` が必要（HTML5 の File.path は WebView2 では取れない）。
 */
export function useTauriFileDrop(
  ref: RefObject<HTMLElement | null>,
  handlers: TauriFileDropHandlers,
) {
  const onDropRef = useRef(handlers.onDrop);
  const onHoverRef = useRef(handlers.onHover);
  onDropRef.current = handlers.onDrop;
  onHoverRef.current = handlers.onHover;
  const enabled = handlers.enabled !== false;

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    let raf = 0;
    let registeredId: number | null = null;

    const register = (el: HTMLElement) => {
      const id = nextId++;
      registeredId = id;
      targets.set(id, {
        id,
        el,
        onHover: (over) => onHoverRef.current?.(over),
        onDrop: (paths) => onDropRef.current(paths),
      });
      listenerCount += 1;
      void ensureListener();
    };

    const tryRegister = () => {
      if (cancelled) return;
      const el = ref.current;
      if (!el) {
        raf = requestAnimationFrame(tryRegister);
        return;
      }
      register(el);
    };

    tryRegister();

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      if (registeredId == null) return;
      if (hoverId === registeredId) {
        onHoverRef.current?.(false);
        hoverId = null;
      }
      targets.delete(registeredId);
      listenerCount -= 1;
      void releaseListener();
    };
  }, [enabled, ref]);
}
