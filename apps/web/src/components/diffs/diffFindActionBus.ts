// Keep the last focused viewer available while the command palette owns focus.
const viewers = new Map<HTMLElement, () => void>();
let activeViewer: HTMLElement | null = null;

export function registerDiffFind(element: HTMLElement, open: () => void): () => void {
  viewers.set(element, open);
  const activate = () => {
    activeViewer = element;
  };
  element.addEventListener("focusin", activate);
  element.addEventListener("pointerdown", activate);
  return () => {
    viewers.delete(element);
    element.removeEventListener("focusin", activate);
    element.removeEventListener("pointerdown", activate);
    if (activeViewer === element) activeViewer = null;
  };
}

const visible = (element: HTMLElement) =>
  element.isConnected && element.getClientRects().length > 0;

export function hasDiffFindViewer(): boolean {
  return [...viewers.keys()].some(visible);
}

export function requestDiffFindOpen(): void {
  const target =
    activeViewer && visible(activeViewer) ? activeViewer : [...viewers.keys()].find(visible);
  if (target) viewers.get(target)?.();
}
