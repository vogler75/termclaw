// One xterm.js instance per terminal session. Its element is moved between views (single, tiles, overview)
// so the terminal, its scrollback and its connection stay alive while hidden.
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { ClipboardAddon } from '@xterm/addon-clipboard';
import '@xterm/xterm/css/xterm.css';
import { schemeById, READABLE_CONTRAST } from './schemes.js';
import { contextMenu } from './ui.js';
import { stripGutter, pasteLines } from './seltext.js';

// The clipboard is written in the main process: navigator.clipboard refuses while the window has no
// focus, and a program in a background window may still copy (OSC 52).
const copyText = (text) => window.termclaw.call('copy', text);

// Programs copy with OSC 52 (Copilot, Claude Code, tmux, vim, ... over SSH too). Reading the clipboard
// that way is refused: a remote program must not see what the user copied elsewhere.
const COPY_ONLY = {
  readText: () => '',
  // Any selection (c, p, s0…, or empty as tmux sends it) goes to the system clipboard; there is no other.
  writeText: (selection, text) => (text ? copyText(text) : undefined),
};

// Files of a drop or paste: those with a local path, and image data without one (screenshot, copied picture).
function splitFiles(list) {
  const paths = [];
  const images = [];
  for (const f of [...(list || [])]) {
    const p = window.termclaw.pathForFile(f);
    if (p) paths.push(p);
    else if (/^image\//.test(f.type)) images.push(f);
  }
  return { paths, images };
}

export const FONT_MIN = 6;
export const FONT_MAX = 40;
const clampFont = (n) => Math.max(FONT_MIN, Math.min(FONT_MAX, Math.round(n)));

export class TermView {
  // onPasteFiles(id, {paths, images}): copied files (local paths) or image data without a file.
  // copyOnSelect(): setting, read when a selection changes. confirmPaste(lines): asked before a paste of
  // several lines into a program that takes them line by line; resolves false to cancel.
  constructor(id, { fontSize = 13, zoom = 0, scheme = 'default', contrast = false, onZoom, onKey, onDropFiles, onPasteFiles, copyOnSelect, confirmPaste, isMac, optionIsMeta = false }) {
    this.id = id;
    this.baseFontSize = fontSize;
    // Per-session font zoom in px on top of the size the current view asks for (single, tiles, overview).
    this.zoom = zoom;
    this.onZoom = onZoom;
    this.el = document.createElement('div');
    this.el.className = 'termwrap';
    this.el.dataset.sid = id;
    // Ctrl+wheel (Cmd+wheel on macOS) changes the font size instead of scrolling.
    this.el.addEventListener('wheel', (e) => {
      if (!(isMac ? e.metaKey : e.ctrlKey) || !e.deltaY) return;
      e.preventDefault();
      e.stopPropagation();
      this.zoomBy(e.deltaY < 0 ? 1 : -1);
    }, { capture: true, passive: false });
    // Files dropped from the Explorer / Finder: handed over as local paths.
    const isFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
    this.el.addEventListener('dragover', (e) => { if (!isFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; this.el.classList.add('drop-files'); });
    this.el.addEventListener('dragleave', (e) => { if (!this.el.contains(e.relatedTarget)) this.el.classList.remove('drop-files'); });
    this.el.addEventListener('drop', (e) => {
      this.el.classList.remove('drop-files');
      if (!isFiles(e)) return;
      e.preventDefault();
      const { paths, images } = splitFiles(e.dataTransfer.files);
      if (paths.length) { if (onDropFiles) onDropFiles(id, paths); }
      // A picture dragged out of a browser or a chat has no file: handled like a pasted image.
      else if (images.length && onPasteFiles) onPasteFiles(id, { paths: [], images });
    });
    this.term = new Terminal({
      fontSize: clampFont(fontSize + zoom),
      fontFamily: '"Cascadia Mono", "SF Mono", Menlo, Consolas, monospace',
      theme: schemeById(scheme).theme,
      scrollback: 10000,
      allowProposedApi: true,
      cursorBlink: true,
      // macOS: Option types characters (~ with Option+N, @, [ ] | on many layouts) like in Terminal.app, unless
      // the user chose Option as Meta (Settings). As Meta, Option+N sent ESC n to the shell before the ~ arrived.
      macOptionIsMeta: !!optionIsMeta,
    });
    this.fit = new FitAddon();
    this.term.loadAddon(this.fit);
    this.term.loadAddon(new WebLinksAddon((e, uri) => window.termclaw.call('openExternal', uri)));
    this.term.loadAddon(new ClipboardAddon(undefined, COPY_ONLY));
    this.opened = false;
    this.setScheme(scheme, contrast);
    this.lastSize = null;

    this.term.onData((d) => window.termclaw.call('write', id, d));
    this.term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      const mod = isMac ? e.metaKey : e.ctrlKey;
      // Copy: Ctrl/⌘+Shift+C, ⌘+C, Ctrl+Insert; Ctrl+C only with a selection (else it interrupts).
      if ((mod && e.shiftKey && e.code === 'KeyC') || (isMac && e.metaKey && e.code === 'KeyC') || (!isMac && e.ctrlKey && !e.shiftKey && e.code === 'Insert')) {
        e.preventDefault();
        this.copySelection();
        return false;
      }
      if (!isMac && e.ctrlKey && !e.shiftKey && !e.altKey && e.code === 'KeyC' && this.term.hasSelection()) {
        e.preventDefault();
        this.copySelection(true);
        return false;
      }
      // Paste: Ctrl/⌘+V, Ctrl/⌘+Shift+V, Shift+Insert. The key is left to the browser, whose paste
      // event (handled below) carries text, copied files and images alike.
      if ((mod && !e.altKey && e.code === 'KeyV') || (!isMac && e.shiftKey && !e.ctrlKey && !e.altKey && e.code === 'Insert')) return false;
      // Shift+PageUp/Down on the alternate screen (tmux, full-screen TUIs) has no scrollback in xterm:
      // when the program tracks the mouse, send wheel events instead, so tmux scrolls its history.
      if (e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && (e.code === 'PageUp' || e.code === 'PageDown')
        && this.term.buffer.active.type === 'alternate' && this.term.modes.mouseTrackingMode !== 'none') {
        const wheel = `\x1b[<${e.code === 'PageUp' ? 64 : 65};1;1M`;
        window.termclaw.call('write', id, wheel.repeat(Math.max(1, Math.round((this.term.rows - 2) / 5))));
        return false;
      }
      // App shortcuts are handled globally.
      if (onKey && onKey(e)) return false;
      return true;
    });

    // Every paste (shortcut, Edit menu, context menu) arrives here, before xterm's own handler.
    // Copied files win over the text that only names them; text wins over a picture of it (Excel, Word).
    this.confirmPaste = confirmPaste;
    this.el.addEventListener('paste', (e) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      const cd = e.clipboardData;
      if (!cd) return;
      const { paths, images } = splitFiles(cd.files);
      const text = cd.getData('text/plain');
      if (paths.length) { if (onPasteFiles) onPasteFiles(id, { paths, images: [] }); }
      else if (text) this.pasteText(text);
      else if (images.length && onPasteFiles) onPasteFiles(id, { paths: [], images });
    }, true);

    // Right click: menu. A program that tracks the mouse (tmux, full-screen TUIs) does not get the
    // click as well; Ctrl+right-click still goes to the program.
    const tracksMouse = () => this.term.modes.mouseTrackingMode !== 'none';
    this.el.addEventListener('mousedown', (e) => {
      if (e.button !== 2 || e.ctrlKey || !tracksMouse()) return;
      e.stopPropagation();
      this.focus();
    }, true);
    this.el.addEventListener('contextmenu', (e) => {
      if (e.ctrlKey && tracksMouse()) return;
      e.preventDefault();
      e.stopPropagation();
      const back = (fn) => () => { fn(); this.focus(); };
      contextMenu(e.clientX, e.clientY, [
        this.term.hasSelection() ? { label: 'Copy', action: back(() => this.copySelection()) } : null,
        // The main process pastes into the focused terminal, which fires the paste event above.
        { label: 'Paste', action: () => { this.focus(); window.termclaw.call('paste'); } },
        '-',
        { label: 'Select all', action: back(() => this.term.selectAll()) },
        { label: 'Clear scrollback', action: back(() => this.term.clear()) },
      ].filter(Boolean));
    }, true);

    // Copy on select (setting): once the selection has settled, not on every cell of a drag.
    this.term.onSelectionChange(() => {
      clearTimeout(this._selTimer);
      if (!copyOnSelect || !copyOnSelect()) return;
      this._selTimer = setTimeout(() => this.copySelection(), 250);
    });

    this.ro = new ResizeObserver(() => this.scheduleFit());
    this.ro.observe(this.el);
  }

  // Selection to the clipboard; false without a selection.
  copySelection(clear = false) {
    const sel = stripGutter(this.term.getSelection());
    if (!sel) return false;
    copyText(sel);
    if (clear) this.term.clearSelection();
    return true;
  }

  // Text into the program. xterm frames it as one block when the program asked for that (bracketed paste:
  // agents, modern shells); otherwise every line break acts as Enter, so several lines are confirmed first.
  async pasteText(text) {
    if (!text) return;
    const lines = pasteLines(text);
    if (lines > 1 && !this.term.modes.bracketedPasteMode && this.confirmPaste && !(await this.confirmPaste(lines, text))) { this.focus(); return; }
    this.term.paste(text);
    this.focus();
  }

  // Move into a container; opens the terminal on first attach.
  attach(container) {
    if (this.el.parentElement !== container) container.appendChild(this.el);
    if (!this.opened) {
      this.term.open(this.el);
      this.opened = true;
    }
    this.scheduleFit();
  }

  detach() {
    if (this.el.parentElement) this.el.parentElement.removeChild(this.el);
  }

  // Color scheme (see schemes.js); contrast = "Increase contrast" setting.
  setScheme(id, contrast = false) {
    const s = schemeById(id);
    const ratio = Math.max(s.contrast || 1, contrast ? READABLE_CONTRAST : 1);
    if (this.schemeId === s.id && this.term.options.minimumContrastRatio === ratio) return;
    this.schemeId = s.id;
    this.term.options.theme = s.theme;
    this.term.options.minimumContrastRatio = ratio;
    this.el.style.background = s.theme.background;
  }

  // Base size of the view the terminal is shown in; the session's zoom is added on top.
  setFontSize(size) {
    this.baseFontSize = size;
    this.applyFont();
  }

  applyFont() {
    const size = clampFont(this.baseFontSize + this.zoom);
    if (this.term.options.fontSize !== size) {
      this.term.options.fontSize = size;
      this.scheduleFit();
    }
    return size;
  }

  // delta in px; 0 resets to the view's size.
  zoomBy(delta) {
    const before = this.zoom;
    if (delta === 0) this.zoom = 0;
    else this.zoom = clampFont(this.baseFontSize + this.zoom + delta) - this.baseFontSize;
    const size = this.applyFont();
    if (this.zoom !== before && this.onZoom) this.onZoom(this.id, this.zoom);
    this.showBadge(size);
  }

  // Short "15 px" hint in the corner while zooming.
  showBadge(size) {
    if (!this.badge) {
      this.badge = document.createElement('div');
      this.badge.className = 'term-zoom';
    }
    this.badge.textContent = size + ' px' + (this.zoom ? ` (${this.zoom > 0 ? '+' : ''}${this.zoom})` : '');
    this.el.appendChild(this.badge);
    clearTimeout(this._badgeTimer);
    this._badgeTimer = setTimeout(() => this.badge.remove(), 1200);
  }

  scheduleFit() {
    cancelAnimationFrame(this._raf);
    this._raf = requestAnimationFrame(() => this.doFit());
  }

  doFit() {
    if (!this.opened || !this.el.isConnected || this.el.offsetWidth < 20 || this.el.offsetHeight < 20) return;
    try { this.fit.fit(); } catch { return; }
    const { cols, rows } = this.term;
    const key = cols + 'x' + rows;
    if (key !== this.lastSize) {
      this.lastSize = key;
      // The remote program gets the new size and may re-wrap.
      window.termclaw.call('resize', this.id, cols, rows);
    }
  }

  write(data) { this.term.write(data); }
  focus() { this.term.focus(); }

  dispose() {
    clearTimeout(this._selTimer);
    this.ro.disconnect();
    this.term.dispose();
    this.detach();
  }
}
