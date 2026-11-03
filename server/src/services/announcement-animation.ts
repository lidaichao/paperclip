import createDOMPurify from "dompurify";
import { JSDOM } from "jsdom";
import { ANNOUNCEMENT_ANIMATION_MAX_BYTES } from "@paperclipai/shared";

// A visual HTML/CSS document, never an application. JSDOM does not execute
// scripts or load resources. DOMPurify handles HTML parsing/normalization;
// CSP on delivery also blocks all network requests, including CSS URLs.
export function validateAnnouncementAnimation(bytes: Uint8Array): string {
  if (!bytes.length || bytes.byteLength > ANNOUNCEMENT_ANIMATION_MAX_BYTES) {
    throw new Error("公告动画无效或文件过大");
  }
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const dom = new JSDOM("");
  try {
    const purifier = createDOMPurify(dom.window as unknown as Parameters<typeof createDOMPurify>[0]);
    const html = purifier.sanitize(source, {
      WHOLE_DOCUMENT: true,
      ALLOWED_TAGS: ["html", "head", "body", "style", "div", "span", "p", "br", "strong", "em", "b", "i",
        "svg", "g", "path", "circle", "ellipse", "rect", "line", "polyline", "polygon", "text", "tspan", "title", "desc"],
      ALLOWED_ATTR: ["class", "id", "style", "viewBox", "xmlns", "width", "height", "x", "y", "x1", "x2", "y1", "y2",
        "cx", "cy", "r", "rx", "ry", "d", "points", "fill", "stroke", "stroke-width", "stroke-linecap",
        "stroke-linejoin", "stroke-dasharray", "stroke-dashoffset", "opacity", "transform", "text-anchor"],
      ALLOW_DATA_ATTR: false,
      ALLOW_ARIA_ATTR: false,
    });
    if (purifier.removed.length) {
      throw new Error("动画只能包含视觉 HTML/CSS 或内联 SVG；不支持脚本、导航、外部资源和交互元素");
    }
    return html;
  } finally {
    dom.window.close();
  }
}
