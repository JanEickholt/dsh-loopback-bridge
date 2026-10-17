/**
 * Dormant element inspector for relayed pages (sidebar Browser "Inspect").
 *
 * Injected into every relayed text/html response before `</body>`, after
 * the nav helper. Dormant until the GUI frame posts `{ __dshInspect: 'arm' }`
 * — only messages with `event.source === window.parent` act. Armed: hover
 * highlight (outline + tint via an injected style), a fixed-top hint bar
 * ("Click an element to reference it · Esc cancels", `pointer-events: none`
 * so it can never be picked itself), and one capture-phase click —
 * captured at `window`, the earliest point of the dispatch chain, so page
 * handlers registered after arming never see it — posts the selection
 * payload to the parent and disarms. Escape posts
 * `{ __dshInspectCancelled: true }` and disarms. 'disarm' and every
 * pick/cancel remove all armed listeners plus the injected style and hint;
 * only the arm/disarm message listener stays for the document's life so a
 * disarmed frame can be re-armed without a reload. Installs once per
 * document: apps that re-execute body scripts on client navigation (Turbo,
 * htmx) would otherwise stack listeners and post every pick twice.
 *
 * Payload: `{ __dshInspectSelected: true, selector, xpath, tagName, role,
 * name, text, rect {x,y,width,height}, url, title, viewport {w,h} }`.
 * `selector` prefers a unique `#id` (CSS.escape'd) and falls back to a
 * structural `tag:nth-of-type(n)` path trimmed of html/body; `xpath` is the
 * positional builder (`/html/body/div[2]/button[1]`). `name` resolves
 * aria-label → aria-labelledby text → alt → innerText; name and text are
 * whitespace-collapsed (the composer insert is one line) and bounded to
 * 120 chars. `url` is the TARGET form — relay prefix stripped from
 * `location.pathname` — falling back to `location.href` when the frame is
 * not on a host-form relay route (legacy hostless tail). The hint-dot is
 * emitted as `\u00b7` so non-UTF-8 upstream pages cannot mojibake it.
 *
 * Ceilings (v1): no shadow-DOM piercing (hover targets retarget to the
 * shadow host); injection rides only relayed text/html responses, and the
 * client lane re-routes native loopback frames through the relay before
 * arming.
 */
export const INSPECTOR_JS = String.raw`(function () {
'use strict';
if (window.__dshInspectorReady === true) return;
var HOVER_ATTR = 'data-dsh-inspect-hover';
var STYLE_ID = 'dsh-inspect-style';
var HINT_ID = 'dsh-inspect-hint';
var armed = false;
var styleEl = null;
var hintEl = null;
var hovered = null;
function squash(value) {
  return (value || '').replace(/\s+/g, ' ').trim();
}
function setHover(el) {
  if (hovered === el) return;
  if (hovered !== null) hovered.removeAttribute(HOVER_ATTR);
  hovered = el;
  if (el !== null) el.setAttribute(HOVER_ATTR, '');
}
function indexOfType(node) {
  var n = 0;
  for (var sib = node; sib !== null; sib = sib.previousElementSibling) {
    if (sib.tagName === node.tagName) n++;
  }
  return n;
}
function selectorFor(el) {
  var id = el.id;
  if (id !== '' && typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    var hashSel = '#' + CSS.escape(id);
    if (document.querySelectorAll(hashSel).length === 1) return hashSel;
  }
  var parts = [];
  for (var node = el; node !== null && node !== document.body && node !== document.documentElement; node = node.parentElement) {
    parts.unshift(node.tagName.toLowerCase() + ':nth-of-type(' + indexOfType(node) + ')');
  }
  // body and html themselves have no structural path below the trim.
  return parts.length > 0 ? parts.join(' > ') : el.tagName.toLowerCase();
}
function xpathFor(el) {
  var parts = [];
  for (var node = el; node !== null && node.nodeType === 1 && node !== document.documentElement; node = node.parentElement) {
    if (node === document.body) parts.unshift('body');
    else parts.unshift(node.tagName.toLowerCase() + '[' + indexOfType(node) + ']');
  }
  return parts.length > 0 ? '/html/' + parts.join('/') : '/html';
}
function nameOf(el) {
  var label = squash(el.getAttribute('aria-label'));
  if (label !== '') return label.slice(0, 120);
  var labelledby = el.getAttribute('aria-labelledby');
  if (labelledby !== null) {
    var names = [];
    var ids = labelledby.split(/\s+/);
    for (var i = 0; i < ids.length; i++) {
      if (ids[i] === '') continue;
      var ref = document.getElementById(ids[i]);
      if (ref !== null) names.push(squash(ref.textContent));
    }
    var joined = squash(names.join(' '));
    if (joined !== '') return joined.slice(0, 120);
  }
  var alt = squash(el.getAttribute('alt'));
  if (alt !== '') return alt.slice(0, 120);
  return squash(el.innerText).slice(0, 120);
}
function targetUrl() {
  var m = /^\/dsh-loopback\/(https?)\/([^/]+)\/(\d{1,5})(\/.*)?$/u.exec(location.pathname);
  if (m === null) return location.href;
  var port = m[3] === (m[1] === 'https' ? '443' : '80') ? '' : ':' + m[3];
  return m[1] + '://' + m[2] + port + (m[4] || '') + location.search + location.hash;
}
function buildPayload(el) {
  var rect = el.getBoundingClientRect();
  var role = el.getAttribute('role');
  return {
    __dshInspectSelected: true,
    selector: selectorFor(el),
    xpath: xpathFor(el),
    tagName: el.tagName.toLowerCase(),
    role: role === null ? '' : squash(role),
    name: nameOf(el),
    text: squash(el.innerText).slice(0, 120),
    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    url: targetUrl(),
    title: document.title,
    viewport: { w: window.innerWidth, h: window.innerHeight },
  };
}
function disarm() {
  armed = false;
  setHover(null);
  window.removeEventListener('mouseover', onMouseOver, true);
  window.removeEventListener('mouseout', onMouseOut, true);
  window.removeEventListener('click', onClick, true);
  window.removeEventListener('keydown', onKeyDown, true);
  if (styleEl !== null && styleEl.parentNode !== null) styleEl.parentNode.removeChild(styleEl);
  if (hintEl !== null && hintEl.parentNode !== null) hintEl.parentNode.removeChild(hintEl);
  styleEl = null;
  hintEl = null;
}
function arm() {
  if (armed) return;
  armed = true;
  styleEl = document.createElement('style');
  styleEl.id = STYLE_ID;
  styleEl.textContent =
    '[' + HOVER_ATTR + ']{outline:2px solid #4f46e5 !important;outline-offset:-1px !important;background-color:rgba(79,70,229,0.12) !important}' +
    '#' + HINT_ID + '{position:fixed;top:0;left:0;right:0;z-index:2147483647;pointer-events:none;box-sizing:border-box;padding:8px 12px;text-align:center;font:500 13px/1.4 system-ui,sans-serif;color:#f9fafb;background:#111827;border-bottom:2px solid #4f46e5}';
  (document.head || document.documentElement).appendChild(styleEl);
  hintEl = document.createElement('div');
  hintEl.id = HINT_ID;
  hintEl.textContent = 'Click an element to reference it \u00b7 Esc cancels';
  (document.body || document.documentElement).appendChild(hintEl);
  window.addEventListener('mouseover', onMouseOver, true);
  window.addEventListener('mouseout', onMouseOut, true);
  window.addEventListener('click', onClick, true);
  window.addEventListener('keydown', onKeyDown, true);
}
function onMouseOver(ev) {
  var t = ev.target;
  if (t !== null && t.nodeType === 1 && t !== hintEl) setHover(t);
}
function onMouseOut(ev) {
  if (hovered === ev.target) {
    var to = ev.relatedTarget;
    if (to === null || !hovered.contains(to)) setHover(null);
  }
}
function onClick(ev) {
  var t = ev.target;
  if (t === null || t.nodeType !== 1) return;
  ev.preventDefault();
  ev.stopPropagation();
  window.parent.postMessage(buildPayload(t), location.origin);
  disarm();
}
function onKeyDown(ev) {
  if (ev.key !== 'Escape') return;
  window.parent.postMessage({ __dshInspectCancelled: true }, location.origin);
  disarm();
}
window.addEventListener('message', function (ev) {
  if (ev.source !== window.parent) return;
  var data = ev.data;
  if (data === null || typeof data !== 'object') return;
  if (data.__dshInspect === 'arm') {
    arm();
    window.parent.postMessage({ __dshInspectAck: true }, location.origin);
  }
  else if (data.__dshInspect === 'disarm') disarm();
});
// Install marker: lets the GUI arm a document the moment this listener exists
// (DOMContentLoaded), instead of proxying readiness via readyState.
window.__dshInspectorReady = true;
// Script-exec-time readiness announcement: unlocks the GUI toolbar and arms
// pending picks long before the full load event, which media preloading can hold for seconds.
try { window.parent.postMessage({ __dshInspectReady: true }, location.origin); } catch (e) {}
})()`

/**
 * Insert the inspector before the last `</body>` (after the nav helper,
 * which lands in `<head>`); appended at the end when the document has no
 * body close. The last one, because an earlier `</body>` can sit inside an
 * inline script's string data, where the injected tag would cut the script.
 */
export function injectInspector(html: string): string {
  const tag = `<script>${INSPECTOR_JS}</script>`
  const bodyClose = /<\/body\s*>/giu
  let at = -1
  for (let match = bodyClose.exec(html); match !== null; match = bodyClose.exec(html)) at = match.index
  if (at === -1) return `${html}${tag}`
  return `${html.slice(0, at)}${tag}${html.slice(at)}`
}
