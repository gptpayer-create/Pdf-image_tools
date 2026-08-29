/* gptpayer — all processing happens locally in the browser. No file is uploaded anywhere. */
(function () {
  "use strict";

  // pdf.js worker
  if (window.pdfjsLib) {
    pdfjsLib.GlobalWorkerOptions.workerSrc =
      "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  }

  /* ---------------- helpers ---------------- */

  const $ = (sel, root = document) => root.querySelector(sel);

  function fileSizeLabel(bytes) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(2) + " MB";
  }

  function download(name, blob) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  function canvasToBlob(canvas, type, quality) {
    return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
  }

  async function loadImageBitmap(file) {
    return await createImageBitmap(file);
  }

  function extFor(mime) {
    if (mime === "image/jpeg") return "jpg";
    if (mime === "image/png") return "png";
    if (mime === "image/webp") return "webp";
    return "png";
  }

  // Runs `transform` over every file, reporting progress, and zips the
  // results together when there's more than one — used by every image tool
  // so they all support batch processing for free.
  async function batchImageOutputs(files, onProgress, zipBaseName, transform) {
    const outputs = [];
    for (let i = 0; i < files.length; i++) {
      if (onProgress) onProgress(i, files.length, `Processing ${files[i].name}…`);
      outputs.push(await transform(files[i]));
    }
    if (onProgress) onProgress(files.length, files.length, "Finishing…");
    if (outputs.length === 1) return outputs;
    const zip = new JSZip();
    const used = new Set();
    outputs.forEach((o) => {
      let name = o.name;
      let n = 1;
      while (used.has(name)) { name = o.name.replace(/(\.[^.]+)?$/, `-${++n}$1`); }
      used.add(name);
      zip.file(name, o.blob);
    });
    const zipBlob = await zip.generateAsync({ type: "blob" });
    return [{ name: `${zipBaseName}.zip`, blob: zipBlob }];
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  function hexToRgb01(hex) {
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || "");
    if (!m) return { r: 0, g: 0, b: 0 };
    return { r: parseInt(m[1], 16) / 255, g: parseInt(m[2], 16) / 255, b: parseInt(m[3], 16) / 255 };
  }

  function median(arr) {
    const s = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }

  // Groups a pdf.js text-content's items into visual lines using y-coordinate
  // clustering, since pdf.js gives individual runs of text, not lines.
  async function extractPdfLines(bytes) {
    const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
    const pages = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      const rows = [];
      let currentY = null;
      let currentSize = 0;
      let buf = [];
      const flush = () => {
        const text = buf.join("").trim();
        if (text) rows.push({ text, size: currentSize });
        buf = [];
      };
      content.items.forEach((item) => {
        const y = Math.round(item.transform[5]);
        const size = Math.hypot(item.transform[2], item.transform[3]) || item.height || 10;
        if (currentY !== null && Math.abs(y - currentY) > 3) flush();
        buf.push(item.str);
        currentY = y;
        currentSize = Math.max(currentSize, size);
      });
      flush();
      pages.push(rows);
    }
    return pages;
  }

  // Classic LCS-based line diff: returns [{type:'same'|'add'|'del', text}]
  function diffLines(a, b) {
    const n = a.length, m = b.length;
    const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    const out = [];
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) { out.push({ type: "same", text: a[i] }); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ type: "del", text: a[i] }); i++; }
      else { out.push({ type: "add", text: b[j] }); j++; }
    }
    while (i < n) { out.push({ type: "del", text: a[i] }); i++; }
    while (j < m) { out.push({ type: "add", text: b[j] }); j++; }
    return out;
  }

  /* ---------------- PDF tool functions ---------------- */

  async function pdfMerge(files, opts, onProgress) {
    const { PDFDocument } = PDFLib;
    const out = await PDFDocument.create();
    for (let i = 0; i < files.length; i++) {
      if (onProgress) onProgress(i, files.length, `Adding ${files[i].name}…`);
      const bytes = await files[i].arrayBuffer();
      const src = await PDFDocument.load(bytes);
      const pages = await out.copyPages(src, src.getPageIndices());
      pages.forEach((p) => out.addPage(p));
    }
    if (onProgress) onProgress(files.length, files.length, "Finishing…");
    const bytes = await out.save();
    return [{ name: "merged.pdf", blob: new Blob([bytes], { type: "application/pdf" }) }];
  }

  async function pdfSplit(files, opts) {
    const { PDFDocument } = PDFLib;
    const file = files[0];
    const bytes = await file.arrayBuffer();
    const src = await PDFDocument.load(bytes);
    const total = src.getPageCount();
    let start = parseInt(opts.start, 10);
    let end = parseInt(opts.end, 10);
    if (!start || start < 1) start = 1;
    if (!end || end > total) end = total;
    if (end < start) throw new Error("End page must be after the start page.");
    const out = await PDFDocument.create();
    const indices = [];
    for (let i = start - 1; i <= end - 1; i++) indices.push(i);
    const pages = await out.copyPages(src, indices);
    pages.forEach((p) => out.addPage(p));
    const outBytes = await out.save();
    return [{ name: `split_p${start}-${end}.pdf`, blob: new Blob([outBytes], { type: "application/pdf" }) }];
  }

  // Same idea as batchImageOutputs but for whole-PDF outputs.
  async function batchPdfOutputs(files, onProgress, zipBaseName, transform) {
    const outputs = [];
    for (let i = 0; i < files.length; i++) {
      if (onProgress) onProgress(i, files.length, `Processing ${files[i].name}…`);
      outputs.push(await transform(files[i]));
    }
    if (onProgress) onProgress(files.length, files.length, "Finishing…");
    if (outputs.length === 1) return outputs;
    const zip = new JSZip();
    outputs.forEach((o) => zip.file(o.name, o.blob));
    const zipBlob = await zip.generateAsync({ type: "blob" });
    return [{ name: `${zipBaseName}.zip`, blob: zipBlob }];
  }

  async function pdfCompress(files, opts, onProgress) {
    const { PDFDocument } = PDFLib;
    return batchPdfOutputs(files, onProgress, "compressed-pdfs", async (file) => {
      const bytes = await file.arrayBuffer();
      const src = await PDFDocument.load(bytes);
      const outBytes = await src.save({ useObjectStreams: true });
      return { name: file.name.replace(/\.pdf$/i, "") + "-compressed.pdf", blob: new Blob([outBytes], { type: "application/pdf" }) };
    });
  }

  async function pdfRotate(files, opts, onProgress) {
    const { PDFDocument, degrees } = PDFLib;
    const add = parseInt(opts.angle, 10) || 90;
    return batchPdfOutputs(files, onProgress, "rotated-pdfs", async (file) => {
      const bytes = await file.arrayBuffer();
      const doc = await PDFDocument.load(bytes);
      doc.getPages().forEach((page) => {
        const current = page.getRotation().angle || 0;
        page.setRotation(degrees((current + add) % 360));
      });
      const outBytes = await doc.save();
      return { name: file.name.replace(/\.pdf$/i, "") + "-rotated.pdf", blob: new Blob([outBytes], { type: "application/pdf" }) };
    });
  }

  async function pdfToJpg(files, opts, onProgress) {
    const file = files[0];
    const quality = (parseInt(opts.quality, 10) || 85) / 100;
    const bytes = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
    const outputs = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      if (onProgress) onProgress(i - 1, pdf.numPages, `Rendering page ${i} of ${pdf.numPages}…`);
      const page = await pdf.getPage(i);
      const viewport = page.getViewport({ scale: 2 });
      const canvas = document.createElement("canvas");
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const ctx = canvas.getContext("2d");
      await page.render({ canvasContext: ctx, viewport }).promise;
      const blob = await canvasToBlob(canvas, "image/jpeg", quality);
      outputs.push({ name: `page-${String(i).padStart(2, "0")}.jpg`, blob });
    }
    if (onProgress) onProgress(pdf.numPages, pdf.numPages, "Finishing…");
    if (outputs.length === 1) return outputs;
    const zip = new JSZip();
    outputs.forEach((o) => zip.file(o.name, o.blob));
    const zipBlob = await zip.generateAsync({ type: "blob" });
    return [{ name: file.name.replace(/\.pdf$/i, "") + "-pages.zip", blob: zipBlob }];
  }

  function parsePageList(str, total) {
    // "1,3,5-7" -> zero-indexed, sorted, unique, clamped to [1, total]
    const parts = String(str || "").split(",").map((s) => s.trim()).filter(Boolean);
    const set = new Set();
    for (const part of parts) {
      if (part.includes("-")) {
        const [a, b] = part.split("-").map((n) => parseInt(n, 10));
        if (!isNaN(a) && !isNaN(b)) {
          for (let i = Math.min(a, b); i <= Math.max(a, b); i++) {
            if (i >= 1 && i <= total) set.add(i - 1);
          }
        }
      } else {
        const n = parseInt(part, 10);
        if (n >= 1 && n <= total) set.add(n - 1);
      }
    }
    return Array.from(set).sort((a, b) => a - b);
  }

  async function pdfRemovePages(files, opts) {
    const { PDFDocument } = PDFLib;
    const file = files[0];
    const bytes = await file.arrayBuffer();
    const doc = await PDFDocument.load(bytes);
    const total = doc.getPageCount();
    const toRemove = parsePageList(opts.pages, total);
    if (toRemove.length === 0) throw new Error("Enter at least one valid page number.");
    if (toRemove.length >= total) throw new Error("Can't remove every page.");
    toRemove.sort((a, b) => b - a).forEach((i) => doc.removePage(i));
    const outBytes = await doc.save();
    return [{ name: file.name.replace(/\.pdf$/i, "") + "-pages-removed.pdf", blob: new Blob([outBytes], { type: "application/pdf" }) }];
  }

  async function pdfExtractPages(files, opts) {
    const { PDFDocument } = PDFLib;
    const file = files[0];
    const bytes = await file.arrayBuffer();
    const src = await PDFDocument.load(bytes);
    const total = src.getPageCount();
    const indices = parsePageList(opts.pages, total);
    if (indices.length === 0) throw new Error(`Enter valid page numbers between 1 and ${total}.`);
    const out = await PDFDocument.create();
    const pages = await out.copyPages(src, indices);
    pages.forEach((p) => out.addPage(p));
    const outBytes = await out.save();
    return [{ name: file.name.replace(/\.pdf$/i, "") + "-extracted.pdf", blob: new Blob([outBytes], { type: "application/pdf" }) }];
  }

  async function pdfAddPageNumbers(files, opts, onProgress) {
    const { PDFDocument, rgb, StandardFonts } = PDFLib;
    return batchPdfOutputs(files, onProgress, "numbered-pdfs", async (file) => {
      const bytes = await file.arrayBuffer();
      const doc = await PDFDocument.load(bytes);
      const font = await doc.embedFont(StandardFonts.Helvetica);
      const pages = doc.getPages();
      const total = pages.length;
      pages.forEach((page, i) => {
        const { width } = page.getSize();
        const text = `${i + 1} / ${total}`;
        const size = 10;
        const textWidth = font.widthOfTextAtSize(text, size);
        page.drawText(text, { x: width / 2 - textWidth / 2, y: 22, size, font, color: rgb(0.25, 0.25, 0.28) });
      });
      const outBytes = await doc.save();
      return { name: file.name.replace(/\.pdf$/i, "") + "-numbered.pdf", blob: new Blob([outBytes], { type: "application/pdf" }) };
    });
  }

  async function pdfWatermark(files, opts, onProgress) {
    const { PDFDocument, rgb, degrees, StandardFonts } = PDFLib;
    const opacity = (parseInt(opts.opacity, 10) || 30) / 100;
    const text = opts.text || "gptpayer";
    return batchPdfOutputs(files, onProgress, "watermarked-pdfs", async (file) => {
      const bytes = await file.arrayBuffer();
      const doc = await PDFDocument.load(bytes);
      const font = await doc.embedFont(StandardFonts.HelveticaBold);
      doc.getPages().forEach((page) => {
        const { width, height } = page.getSize();
        const size = Math.min(width, height) / 7;
        const textWidth = font.widthOfTextAtSize(text, size);
        page.drawText(text, {
          x: width / 2 - textWidth / 2,
          y: height / 2 - size / 3,
          size, font, opacity,
          color: rgb(0.6, 0.13, 0.09),
          rotate: degrees(45),
        });
      });
      const outBytes = await doc.save();
      return { name: file.name.replace(/\.pdf$/i, "") + "-watermarked.pdf", blob: new Blob([outBytes], { type: "application/pdf" }) };
    });
  }

  async function pdfCrop(files, opts, onProgress) {
    const { PDFDocument } = PDFLib;
    const top = parseFloat(opts.top) || 0, right = parseFloat(opts.right) || 0;
    const bottom = parseFloat(opts.bottom) || 0, left = parseFloat(opts.left) || 0;
    return batchPdfOutputs(files, onProgress, "cropped-pdfs", async (file) => {
      const bytes = await file.arrayBuffer();
      const doc = await PDFDocument.load(bytes);
      doc.getPages().forEach((page) => {
        const { width, height } = page.getSize();
        const w = Math.max(10, width - left - right);
        const h = Math.max(10, height - top - bottom);
        page.setCropBox(left, bottom, w, h);
      });
      const outBytes = await doc.save();
      return { name: file.name.replace(/\.pdf$/i, "") + "-cropped.pdf", blob: new Blob([outBytes], { type: "application/pdf" }) };
    });
  }

  async function pdfSign(files, opts) {
    const { PDFDocument, rgb, StandardFonts } = PDFLib;
    const file = files[0];
    const bytes = await file.arrayBuffer();
    const doc = await PDFDocument.load(bytes);
    const font = await doc.embedFont(StandardFonts.HelveticaOblique);
    const pages = doc.getPages();
    const total = pages.length;
    let pageNum = parseInt(opts.page, 10);
    if (!pageNum || pageNum < 1 || pageNum > total) pageNum = total;
    const page = pages[pageNum - 1];
    const { width } = page.getSize();
    const text = opts.text || "Signed";
    const size = 22;
    const textWidth = font.widthOfTextAtSize(text, size);
    page.drawText(text, { x: width - textWidth - 60, y: 60, size, font, color: rgb(0.08, 0.08, 0.35) });
    const outBytes = await doc.save();
    return [{ name: file.name.replace(/\.pdf$/i, "") + "-signed.pdf", blob: new Blob([outBytes], { type: "application/pdf" }) }];
  }

  async function pdfRedact(files, opts) {
    const { PDFDocument, rgb } = PDFLib;
    const file = files[0];
    const bytes = await file.arrayBuffer();
    const doc = await PDFDocument.load(bytes);
    const pages = doc.getPages();
    const total = pages.length;
    const pageNum = parseInt(opts.page, 10);
    if (!pageNum || pageNum < 1 || pageNum > total) throw new Error(`Enter a valid page number (1-${total}).`);
    const page = pages[pageNum - 1];
    const x = parseFloat(opts.x) || 0, y = parseFloat(opts.y) || 0;
    const w = parseFloat(opts.w) || 100, h = parseFloat(opts.h) || 30;
    page.drawRectangle({ x, y, width: w, height: h, color: rgb(0, 0, 0) });
    const outBytes = await doc.save();
    return [{ name: file.name.replace(/\.pdf$/i, "") + "-redacted.pdf", blob: new Blob([outBytes], { type: "application/pdf" }) }];
  }

  /* ---------------- Organize PDF (drag-free reorder via thumbnails) ---------------- */

  let organizeState = null;

  async function buildOrganizeUI(files, container) {
    if (!files.length) { container.innerHTML = ""; organizeState = null; return; }
    container.innerHTML = '<p class="dyn-hint">Loading pages…</p>';
    try {
      const file = files[0];
      const bytes = await file.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
      const entries = [];
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const viewport = page.getViewport({ scale: 0.28 });
        const canvas = document.createElement("canvas");
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
        entries.push({ page: i - 1, rotation: 0, removed: false, thumb: canvas.toDataURL("image/jpeg", 0.7) });
      }
      organizeState = { entries };
      renderOrganizeGrid(container);
    } catch (e) {
      container.innerHTML = '<p class="dyn-hint">Couldn\'t read this PDF\'s pages.</p>';
      organizeState = null;
    }
  }

  function renderOrganizeGrid(container) {
    const state = organizeState;
    container.innerHTML =
      '<p class="dyn-hint">Use the arrows to reorder, ⟳ to rotate a page, ✕ to drop it — then tap Run.</p><div class="page-grid" id="page-grid"></div>';
    const grid = container.querySelector("#page-grid");
    state.entries.forEach((entry, idx) => {
      if (entry.removed) return;
      const card = document.createElement("div");
      card.className = "page-thumb";
      card.innerHTML = `
        <img src="${entry.thumb}" style="transform:rotate(${entry.rotation}deg)" alt="Page ${entry.page + 1}">
        <span class="page-thumb-num">Page ${entry.page + 1}</span>
        <div class="page-thumb-actions">
          <button type="button" data-act="up" title="Move earlier" aria-label="Move page earlier">↑</button>
          <button type="button" data-act="down" title="Move later" aria-label="Move page later">↓</button>
          <button type="button" data-act="rotate" title="Rotate" aria-label="Rotate page">⟳</button>
          <button type="button" data-act="del" title="Remove" aria-label="Remove page">✕</button>
        </div>`;
      card.querySelector('[data-act="up"]').addEventListener("click", () => { moveOrganizeEntry(idx, -1); renderOrganizeGrid(container); });
      card.querySelector('[data-act="down"]').addEventListener("click", () => { moveOrganizeEntry(idx, 1); renderOrganizeGrid(container); });
      card.querySelector('[data-act="rotate"]').addEventListener("click", () => { entry.rotation = (entry.rotation + 90) % 360; renderOrganizeGrid(container); });
      card.querySelector('[data-act="del"]').addEventListener("click", () => { entry.removed = true; renderOrganizeGrid(container); });
      grid.appendChild(card);
    });
    if (!grid.children.length) {
      grid.innerHTML = '<p class="dyn-hint">All pages removed — at least one page must remain.</p>';
    }
  }

  function moveOrganizeEntry(index, direction) {
    const arr = organizeState.entries;
    let j = index + direction;
    while (j >= 0 && j < arr.length && arr[j].removed) j += direction;
    if (j < 0 || j >= arr.length) return;
    [arr[index], arr[j]] = [arr[j], arr[index]];
  }

  async function pdfOrganize(files) {
    if (!organizeState || !organizeState.entries.length) throw new Error("Add a PDF first.");
    const visible = organizeState.entries.filter((e) => !e.removed);
    if (!visible.length) throw new Error("At least one page must remain.");
    const { PDFDocument, degrees } = PDFLib;
    const file = files[0];
    const bytes = await file.arrayBuffer();
    const src = await PDFDocument.load(bytes);
    const out = await PDFDocument.create();
    const pages = await out.copyPages(src, visible.map((e) => e.page));
    pages.forEach((p, i) => {
      const rot = visible[i].rotation;
      if (rot) p.setRotation(degrees((p.getRotation().angle + rot) % 360));
      out.addPage(p);
    });
    const outBytes = await out.save();
    return [{ name: file.name.replace(/\.pdf$/i, "") + "-organized.pdf", blob: new Blob([outBytes], { type: "application/pdf" }) }];
  }

  /* ---------------- Visual drag-to-select box picker ----------------
     Reusable helper: draws a raster preview (image or rendered PDF page)
     into a small canvas, and lets the user drag out a rectangle on it.
     The drag live-updates the linked numeric <input> fields (by id) —
     those inputs stay the source of truth, so typing still works too.
     opts.flipY: true for PDF-point coordinates (origin bottom-left);
     false for image-pixel coordinates (origin top-left). */
  function wireRectPicker(container, rawCanvas, srcW, srcH, ids, opts, hintText) {
    opts = opts || {};
    const wrapEl = document.createElement("div");
    wrapEl.innerHTML =
      `<p class="dyn-hint">${hintText || "Drag on the preview to set the box — or type numbers below."}</p>` +
      '<div class="rect-picker-wrap"><canvas class="rect-picker-canvas"></canvas><div class="rect-picker-box" hidden></div></div>';
    container.innerHTML = "";
    container.appendChild(wrapEl);

    const wrap = container.querySelector(".rect-picker-wrap");
    const canvas = container.querySelector(".rect-picker-canvas");
    const box = container.querySelector(".rect-picker-box");
    const ctx = canvas.getContext("2d");

    const available = (container.clientWidth || 480);
    const maxW = Math.max(160, Math.min(520, available));
    const scale = srcW > maxW ? maxW / srcW : 1;
    canvas.width = Math.max(1, Math.round(srcW * scale));
    canvas.height = Math.max(1, Math.round(srcH * scale));
    ctx.drawImage(rawCanvas, 0, 0, canvas.width, canvas.height);

    function fieldsFromInputs() {
      const xEl = ids.x && $("#" + ids.x), yEl = ids.y && $("#" + ids.y);
      const wEl = ids.w && $("#" + ids.w), hEl = ids.h && $("#" + ids.h);
      return { xEl, yEl, wEl, hEl };
    }

    // Draw an initial box on screen if the fields already have values
    // (e.g. re-opening the dynamic UI after switching pages).
    (function initFromInputs() {
      const { xEl, yEl, wEl, hEl } = fieldsFromInputs();
      if (!xEl || !yEl) return;
      const x = parseFloat(xEl.value), y = parseFloat(yEl.value);
      const w = wEl ? parseFloat(wEl.value) : NaN, h = hEl ? parseFloat(hEl.value) : NaN;
      if ([x, y, w, h].some((n) => isNaN(n)) || w <= 0 || h <= 0) return;
      const py = opts.flipY ? (srcH - y - h) : y;
      const left = x * scale, top = py * scale, bw = w * scale, bh = h * scale;
      box.hidden = false;
      box.style.left = left + "px"; box.style.top = top + "px";
      box.style.width = bw + "px"; box.style.height = bh + "px";
    })();

    function ptFromEvent(e) {
      const rect = canvas.getBoundingClientRect();
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      const clientY = e.touches ? e.touches[0].clientY : e.clientY;
      return {
        px: Math.min(Math.max(0, clientX - rect.left), canvas.width),
        py: Math.min(Math.max(0, clientY - rect.top), canvas.height),
      };
    }

    function paintBox(px1, py1, px2, py2) {
      const left = Math.min(px1, px2), top = Math.min(py1, py2);
      box.hidden = false;
      box.style.left = left + "px"; box.style.top = top + "px";
      box.style.width = Math.abs(px2 - px1) + "px"; box.style.height = Math.abs(py2 - py1) + "px";
    }

    function setVal(el, val) {
      if (!el) return;
      el.value = String(val);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }

    function commit(px1, py1, px2, py2) {
      const { xEl, yEl, wEl, hEl } = fieldsFromInputs();
      const ux1 = px1 / scale, ux2 = px2 / scale;
      const uy1 = py1 / scale, uy2 = py2 / scale;
      const x = Math.round(Math.min(ux1, ux2));
      const w = Math.max(1, Math.round(Math.abs(ux2 - ux1)));
      const h = Math.max(1, Math.round(Math.abs(uy2 - uy1)));
      const topPy = Math.min(uy1, uy2);
      const y = Math.round(opts.flipY ? (srcH - topPy - h) : topPy);
      setVal(xEl, x); setVal(yEl, y);
      if (wEl) setVal(wEl, w);
      if (hEl) setVal(hEl, h);
    }

    let dragging = false, start = null;
    const onDown = (e) => { dragging = true; start = ptFromEvent(e); paintBox(start.px, start.py, start.px, start.py); e.preventDefault(); };
    const onMove = (e) => { if (!dragging) return; const cur = ptFromEvent(e); paintBox(start.px, start.py, cur.px, cur.py); };
    const onUp = (e) => {
      if (!dragging) return;
      dragging = false;
      const cur = ptFromEvent(e);
      paintBox(start.px, start.py, cur.px, cur.py);
      commit(start.px, start.py, cur.px, cur.py);
    };
    canvas.addEventListener("pointerdown", onDown);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    // Clean up window listeners when this picker's DOM is discarded.
    const observer = new MutationObserver(() => {
      if (!document.body.contains(canvas)) {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        observer.disconnect();
      }
    });
    observer.observe(container.parentElement || container, { childList: true, subtree: true });
  }

  // Renders a PDF page to a raster canvas (1 canvas px == 1 PDF point) and
  // wires the rect picker to it. Re-renders automatically if a page-number
  // field is linked, so the preview follows the "Page number" input.
  async function wirePdfPagePicker(file, container, ids, pageFieldId, hintText) {
    container.innerHTML = '<p class="dyn-hint">Loading preview…</p>';
    let pdf;
    try {
      const bytes = await file.arrayBuffer();
      pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
    } catch (e) {
      container.innerHTML = '<p class="dyn-hint">Couldn\'t load a preview for this PDF — the numeric fields below still work.</p>';
      return;
    }
    let lastPage = -1;
    const draw = async () => {
      const pageEl = pageFieldId && $("#" + pageFieldId);
      let pageNum = pageEl ? parseInt(pageEl.value, 10) : 1;
      if (!pageNum || pageNum < 1 || pageNum > pdf.numPages) pageNum = 1;
      if (pageNum === lastPage) return;
      lastPage = pageNum;
      try {
        const page = await pdf.getPage(pageNum);
        const viewport = page.getViewport({ scale: 1 });
        const raw = document.createElement("canvas");
        raw.width = Math.max(1, Math.round(viewport.width));
        raw.height = Math.max(1, Math.round(viewport.height));
        await page.render({ canvasContext: raw.getContext("2d"), viewport }).promise;
        wireRectPicker(container, raw, viewport.width, viewport.height, ids, { flipY: true },
          (hintText || "Drag on the preview to set the box.") + ` (page ${pageNum} of ${pdf.numPages})`);
      } catch (e) {
        container.innerHTML = '<p class="dyn-hint">Couldn\'t render that page — the numeric fields below still work.</p>';
      }
    };
    await draw();
    const pageEl = pageFieldId && $("#" + pageFieldId);
    if (pageEl) pageEl.addEventListener("change", draw);
  }

  async function buildRedactUI(files, container) {
    if (!files.length) { container.innerHTML = ""; return; }
    await wirePdfPagePicker(files[0], container, { x: "opt-x", y: "opt-y", w: "opt-w", h: "opt-h" }, "opt-page",
      "Drag over the area you want blacked out.");
  }

  async function buildCropImageUI(files, container) {
    if (!files.length) { container.innerHTML = ""; return; }
    try {
      const bitmap = await loadImageBitmap(files[0]);
      const raw = document.createElement("canvas");
      raw.width = bitmap.width; raw.height = bitmap.height;
      raw.getContext("2d").drawImage(bitmap, 0, 0);
      wireRectPicker(container, raw, bitmap.width, bitmap.height,
        { x: "opt-x", y: "opt-y", w: "opt-w", h: "opt-h" }, { flipY: false },
        "Drag out the region to keep. Applies to the first image; every image you added uses the same box.");
    } catch (e) {
      container.innerHTML = '<p class="dyn-hint">Couldn\'t load a preview for this image — the numeric fields below still work.</p>';
    }
  }

  async function buildBlurAreaUI(files, container) {
    if (!files.length) { container.innerHTML = ""; return; }
    try {
      const bitmap = await loadImageBitmap(files[0]);
      const raw = document.createElement("canvas");
      raw.width = bitmap.width; raw.height = bitmap.height;
      raw.getContext("2d").drawImage(bitmap, 0, 0);
      wireRectPicker(container, raw, bitmap.width, bitmap.height,
        { x: "opt-x", y: "opt-y", w: "opt-w", h: "opt-h" }, { flipY: false },
        "Drag over the face or area to blur. Applies to the first image; every image you added uses the same box.");
    } catch (e) {
      container.innerHTML = '<p class="dyn-hint">Couldn\'t load a preview for this image — the numeric fields below still work.</p>';
    }
  }

  /* ---------------- OCR PDF (on-device, via Tesseract.js) ---------------- */

  async function pdfOcr(files, opts, onProgress) {
    let Tesseract;
    try {
      if (onProgress) onProgress(0, 1, "Loading on-device OCR engine…");
      const mod = await import("https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.esm.min.js");
      Tesseract = mod.default || mod;
    } catch (e) {
      throw new Error("Couldn't load the on-device OCR engine — check your internet connection and try again.");
    }
    const file = files[0];
    const bytes = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
    const lang = opts.lang || "eng";
    const worker = await Tesseract.createWorker(lang, 1, {
      logger: (m) => {
        if (onProgress && m.status === "recognizing text") {
          onProgress(Math.round(m.progress * 100), 100, `Reading text… ${Math.round(m.progress * 100)}%`);
        }
      },
    });
    try {
      const pages = [];
      for (let i = 1; i <= pdf.numPages; i++) {
        if (onProgress) onProgress(i - 1, pdf.numPages, `Scanning page ${i} of ${pdf.numPages}…`);
        const page = await pdf.getPage(i);
        const viewport = page.getViewport({ scale: 2 });
        const canvas = document.createElement("canvas");
        canvas.width = viewport.width; canvas.height = viewport.height;
        await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
        const dataUrl = canvas.toDataURL("image/png");
        const { data } = await worker.recognize(dataUrl);
        pages.push(`## Page ${i}\n\n${(data.text || "").trim() || "*(no text detected)*"}`);
      }
      if (onProgress) onProgress(pdf.numPages, pdf.numPages, "Finishing…");
      const md = `# ${file.name.replace(/\.pdf$/i, "")} — OCR text\n\n` + pages.join("\n\n---\n\n") + "\n";
      return [{ name: file.name.replace(/\.pdf$/i, "") + "-ocr.md", blob: new Blob([md], { type: "text/markdown" }) }];
    } finally {
      await worker.terminate();
    }
  }

  /* ---------------- Scan to PDF ---------------- */

  async function pdfScanToPdf(files, opts, onProgress) {
    const { PDFDocument } = PDFLib;
    const mode = opts.mode || "color";
    const out = await PDFDocument.create();
    for (let i = 0; i < files.length; i++) {
      if (onProgress) onProgress(i, files.length, `Processing ${files[i].name}…`);
      const bitmap = await loadImageBitmap(files[i]);
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext("2d");
      if (mode === "grayscale") ctx.filter = "grayscale(1) contrast(1.15) brightness(1.05)";
      else if (mode === "bw") ctx.filter = "grayscale(1) contrast(1.3) brightness(1.1)";
      else ctx.filter = "contrast(1.08) saturate(1.05)";
      ctx.drawImage(bitmap, 0, 0);
      if (mode === "bw") {
        const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const d = imgData.data;
        for (let j = 0; j < d.length; j += 4) {
          const v = d[j] > 150 ? 255 : 0;
          d[j] = d[j + 1] = d[j + 2] = v;
        }
        ctx.putImageData(imgData, 0, 0);
      }
      const jpgBlob = await canvasToBlob(canvas, "image/jpeg", 0.9);
      const jpgBytes = new Uint8Array(await jpgBlob.arrayBuffer());
      const embedded = await out.embedJpg(jpgBytes);
      const page = out.addPage([embedded.width, embedded.height]);
      page.drawImage(embedded, { x: 0, y: 0, width: embedded.width, height: embedded.height });
    }
    if (onProgress) onProgress(files.length, files.length, "Finishing…");
    const outBytes = await out.save();
    return [{ name: "scanned.pdf", blob: new Blob([outBytes], { type: "application/pdf" }) }];
  }

  /* ---------------- Repair PDF ---------------- */

  async function pdfRepair(files, opts, onProgress) {
    const { PDFDocument } = PDFLib;
    const file = files[0];
    const bytes = await file.arrayBuffer();
    try {
      if (onProgress) onProgress(0, 1, "Re-packaging the file…");
      const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, throwOnInvalidObject: false, updateMetadata: false });
      const outBytes = await doc.save();
      if (onProgress) onProgress(1, 1, "Finishing…");
      return [{ name: file.name.replace(/\.pdf$/i, "") + "-repaired.pdf", blob: new Blob([outBytes], { type: "application/pdf" }) }];
    } catch (e) {
      let pdf;
      try {
        pdf = await pdfjsLib.getDocument({ data: bytes, stopAtErrors: false }).promise;
      } catch (e2) {
        throw new Error("This file is too damaged to recover automatically.");
      }
      const out = await PDFDocument.create();
      let recovered = 0;
      for (let i = 1; i <= pdf.numPages; i++) {
        if (onProgress) onProgress(i - 1, pdf.numPages, `Rebuilding page ${i} of ${pdf.numPages}…`);
        try {
          const page = await pdf.getPage(i);
          const viewport = page.getViewport({ scale: 2 });
          const canvas = document.createElement("canvas");
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
          const jpgBlob = await canvasToBlob(canvas, "image/jpeg", 0.92);
          const jpgBytes = new Uint8Array(await jpgBlob.arrayBuffer());
          const embedded = await out.embedJpg(jpgBytes);
          const p = out.addPage([embedded.width, embedded.height]);
          p.drawImage(embedded, { x: 0, y: 0, width: embedded.width, height: embedded.height });
          recovered++;
        } catch (pageErr) { /* skip unreadable page */ }
      }
      if (!recovered) throw new Error("No pages could be recovered from this file.");
      if (onProgress) onProgress(pdf.numPages, pdf.numPages, "Finishing…");
      const outBytes = await out.save();
      return [{ name: file.name.replace(/\.pdf$/i, "") + "-repaired.pdf", blob: new Blob([outBytes], { type: "application/pdf" }) }];
    }
  }

  /* ---------------- Unlock PDF (requires the known password) ---------------- */

  async function pdfUnlock(files, opts, onProgress) {
    const file = files[0];
    const bytes = await file.arrayBuffer();
    const password = opts.password || "";
    let pdf;
    try {
      pdf = await pdfjsLib.getDocument({ data: bytes, password }).promise;
    } catch (e) {
      if (e && e.name === "PasswordException") {
        throw new Error(password ? "That password didn't work." : "This PDF needs a password — enter it above.");
      }
      throw e;
    }
    const { PDFDocument } = PDFLib;
    const out = await PDFDocument.create();
    for (let i = 1; i <= pdf.numPages; i++) {
      if (onProgress) onProgress(i - 1, pdf.numPages, `Rendering page ${i} of ${pdf.numPages}…`);
      const page = await pdf.getPage(i);
      const viewport = page.getViewport({ scale: 2 });
      const canvas = document.createElement("canvas");
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
      const jpgBlob = await canvasToBlob(canvas, "image/jpeg", 0.93);
      const jpgBytes = new Uint8Array(await jpgBlob.arrayBuffer());
      const embedded = await out.embedJpg(jpgBytes);
      const p = out.addPage([embedded.width, embedded.height]);
      p.drawImage(embedded, { x: 0, y: 0, width: embedded.width, height: embedded.height });
    }
    if (onProgress) onProgress(pdf.numPages, pdf.numPages, "Finishing…");
    const outBytes = await out.save();
    return [{ name: file.name.replace(/\.pdf$/i, "") + "-unlocked.pdf", blob: new Blob([outBytes], { type: "application/pdf" }) }];
  }

  /* ---------------- Compare PDF ---------------- */

  async function pdfCompare(files) {
    if (files.length < 2) throw new Error("Add two PDF files to compare.");
    const [bufA, bufB] = await Promise.all([files[0].arrayBuffer(), files[1].arrayBuffer()]);
    const [pagesA, pagesB] = await Promise.all([extractPdfLines(bufA), extractPdfLines(bufB)]);
    const maxPages = Math.max(pagesA.length, pagesB.length);
    let html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>PDF comparison</title>
<style>
body{font-family:'Work Sans',Arial,sans-serif;max-width:900px;margin:40px auto;padding:0 20px;color:#1c1f26;line-height:1.5;}
h1{font-size:19px;} h2{font-size:14px;margin-top:34px;border-bottom:1px solid #ddd;padding-bottom:6px;color:#444;}
.del{background:#ffe1e1;color:#9c1c1c;text-decoration:line-through;display:block;padding:2px 8px;border-radius:3px;margin:1px 0;}
.add{background:#dcf7e3;color:#0e6b32;display:block;padding:2px 8px;border-radius:3px;margin:1px 0;}
.same{color:#666;display:block;padding:2px 8px;margin:1px 0;}
.legend span{display:inline-block;padding:3px 12px;border-radius:3px;margin-right:10px;font-size:13px;}
</style></head><body>
<h1>Comparing “${escapeHtml(files[0].name)}” vs “${escapeHtml(files[1].name)}”</h1>
<p class="legend"><span class="del">Removed</span><span class="add">Added</span></p>`;
    for (let p = 0; p < maxPages; p++) {
      const a = (pagesA[p] || []).map((r) => r.text);
      const b = (pagesB[p] || []).map((r) => r.text);
      const diff = diffLines(a, b);
      const hasChange = diff.some((d) => d.type !== "same");
      let tag = hasChange ? "" : " — no changes";
      if (p >= pagesA.length) tag = " (only in second file)";
      else if (p >= pagesB.length) tag = " (only in first file)";
      html += `<h2>Page ${p + 1}${tag}</h2>`;
      diff.forEach((d) => { html += `<span class="${d.type}">${escapeHtml(d.text) || "&nbsp;"}</span>`; });
    }
    html += `</body></html>`;
    return [{ name: "comparison.html", blob: new Blob([html], { type: "text/html" }) }];
  }

  /* ---------------- PDF to Markdown (heuristic heading detection) ---------------- */

  async function pdfToMarkdown(files) {
    const file = files[0];
    const bytes = await file.arrayBuffer();
    const pages = await extractPdfLines(bytes);
    let md = "";
    pages.forEach((rows, pageIdx) => {
      const sizes = rows.map((r) => r.size).filter(Boolean);
      const bodySize = sizes.length ? median(sizes) : 10;
      const lines = rows.map((r) => {
        const t = r.text.trim();
        if (!t) return "";
        if (r.size >= bodySize * 1.6) return `# ${t}`;
        if (r.size >= bodySize * 1.25) return `## ${t}`;
        return t;
      }).filter(Boolean);
      md += lines.join("\n\n");
      if (pageIdx < pages.length - 1) md += "\n\n---\n\n";
    });
    return [{ name: file.name.replace(/\.pdf$/i, "") + ".md", blob: new Blob([md], { type: "text/markdown" }) }];
  }

  /* ---------------- HTML to PDF / HTML to Image ---------------- */

  async function renderHtmlFileToCanvas(file, widthPx) {
    const text = await file.text();
    const container = document.createElement("div");
    container.style.position = "fixed";
    container.style.left = "-99999px";
    container.style.top = "0";
    container.style.width = widthPx + "px";
    container.style.background = "#ffffff";
    container.innerHTML = text;
    document.body.appendChild(container);
    try {
      await new Promise((r) => setTimeout(r, 60));
      return await html2canvas(container, { backgroundColor: "#ffffff", useCORS: true, scale: 2, windowWidth: widthPx });
    } finally {
      container.remove();
    }
  }

  async function htmlToImage(files) {
    const file = files[0];
    const canvas = await renderHtmlFileToCanvas(file, 900);
    const blob = await canvasToBlob(canvas, "image/png", 1);
    return [{ name: file.name.replace(/\.html?$/i, "") + ".png", blob }];
  }

  async function htmlToPdf(files) {
    const file = files[0];
    const canvas = await renderHtmlFileToCanvas(file, 794);
    const { PDFDocument } = PDFLib;
    const out = await PDFDocument.create();
    const pageWidthPt = 595.28;
    const pageHeightPt = 841.89;
    const scaleFactor = pageWidthPt / canvas.width;
    const pageHeightPx = Math.max(1, Math.floor(pageHeightPt / scaleFactor));
    let y = 0;
    while (y < canvas.height) {
      const sliceHeight = Math.min(pageHeightPx, canvas.height - y);
      const sliceCanvas = document.createElement("canvas");
      sliceCanvas.width = canvas.width;
      sliceCanvas.height = sliceHeight;
      sliceCanvas.getContext("2d").drawImage(canvas, 0, y, canvas.width, sliceHeight, 0, 0, canvas.width, sliceHeight);
      const jpgBlob = await canvasToBlob(sliceCanvas, "image/jpeg", 0.92);
      const jpgBytes = new Uint8Array(await jpgBlob.arrayBuffer());
      const embedded = await out.embedJpg(jpgBytes);
      const page = out.addPage([pageWidthPt, sliceHeight * scaleFactor]);
      page.drawImage(embedded, { x: 0, y: 0, width: pageWidthPt, height: sliceHeight * scaleFactor });
      y += sliceHeight;
    }
    const outBytes = await out.save();
    return [{ name: file.name.replace(/\.html?$/i, "") + ".pdf", blob: new Blob([outBytes], { type: "application/pdf" }) }];
  }

  /* ---------------- Edit PDF (text / rectangle / line stamp) ---------------- */

  async function pdfEdit(files, opts) {
    const { PDFDocument, rgb, StandardFonts } = PDFLib;
    const file = files[0];
    const bytes = await file.arrayBuffer();
    const doc = await PDFDocument.load(bytes);
    const pages = doc.getPages();
    const total = pages.length;
    let pageNum = parseInt(opts.page, 10);
    if (!pageNum || pageNum < 1 || pageNum > total) pageNum = 1;
    const page = pages[pageNum - 1];
    const x = parseFloat(opts.x) || 0;
    const y = parseFloat(opts.y) || 0;
    const c = hexToRgb01(opts.color || "#e63946");
    const color = rgb(c.r, c.g, c.b);
    if (opts.type === "rectangle") {
      const w = parseFloat(opts.w) || 100, h = parseFloat(opts.h) || 40;
      page.drawRectangle({ x, y, width: w, height: h, borderColor: color, borderWidth: 2 });
    } else if (opts.type === "line") {
      const x2 = opts.w !== "" ? parseFloat(opts.w) : x + 100;
      const y2 = opts.h !== "" ? parseFloat(opts.h) : y;
      page.drawLine({ start: { x, y }, end: { x: x2, y: y2 }, thickness: 2, color });
    } else {
      const font = await doc.embedFont(StandardFonts.Helvetica);
      const size = parseFloat(opts.size) || 18;
      page.drawText(opts.text || "Text", { x, y, size, font, color });
    }
    const outBytes = await doc.save();
    return [{ name: file.name.replace(/\.pdf$/i, "") + "-edited.pdf", blob: new Blob([outBytes], { type: "application/pdf" }) }];
  }

  /* ---------------- PDF Forms (detect + fill AcroForm fields) ---------------- */

  let formsState = null;

  async function buildFormsUI(files, container) {
    if (!files.length) { container.innerHTML = ""; formsState = null; return; }
    container.innerHTML = '<p class="dyn-hint">Reading form fields…</p>';
    try {
      const { PDFDocument } = PDFLib;
      const bytes = await files[0].arrayBuffer();
      const doc = await PDFDocument.load(bytes);
      const form = doc.getForm();
      const fields = form.getFields();
      if (!fields.length) {
        container.innerHTML = '<p class="dyn-hint">No fillable fields were found in this PDF.</p>';
        formsState = { fields: [] };
        return;
      }
      formsState = { fields: fields.map((f) => ({ name: f.getName(), type: f.constructor.name })) };
      container.innerHTML =
        '<p class="dyn-hint">Fill in the fields below, then tap Run.</p><div class="form-fields" id="form-fields"></div>' +
        '<label class="opt-check"><input type="checkbox" id="opt-flatten" checked> Flatten (make read-only) after filling</label>';
      const wrap = container.querySelector("#form-fields");
      formsState.fields.forEach((f, idx) => {
        const row = document.createElement("label");
        row.className = "opt-label";
        if (f.type === "PDFCheckBox") {
          row.innerHTML = `<input type="checkbox" data-field="${idx}" class="form-field-input"> ${escapeHtml(f.name)}`;
        } else {
          row.innerHTML = `${escapeHtml(f.name)} <input type="text" data-field="${idx}" class="opt-input form-field-input" placeholder="${f.type === "PDFRadioGroup" || f.type === "PDFDropdown" || f.type === "PDFOptionList" ? "option value" : "value"}">`;
        }
        wrap.appendChild(row);
      });
    } catch (e) {
      container.innerHTML = "<p class=\"dyn-hint\">Couldn't read form fields: " + escapeHtml(e.message || String(e)) + "</p>";
      formsState = { fields: [] };
    }
  }

  async function pdfFillForms(files, opts) {
    if (!formsState || !formsState.fields.length) throw new Error("No fillable fields were found in this PDF.");
    const { PDFDocument } = PDFLib;
    const file = files[0];
    const bytes = await file.arrayBuffer();
    const doc = await PDFDocument.load(bytes);
    const form = doc.getForm();
    document.querySelectorAll(".form-field-input").forEach((el) => {
      const idx = parseInt(el.dataset.field, 10);
      const meta = formsState.fields[idx];
      if (!meta) return;
      try {
        const field = form.getField(meta.name);
        if (meta.type === "PDFCheckBox") {
          if (el.checked) field.check(); else field.uncheck();
        } else if (meta.type === "PDFTextField") {
          field.setText(el.value || "");
        } else if (field.select && el.value) {
          field.select(el.value);
        }
      } catch (e) { /* leave field untouched if the value doesn't fit it */ }
    });
    if (opts.flatten) form.flatten();
    const outBytes = await doc.save();
    return [{ name: file.name.replace(/\.pdf$/i, "") + "-filled.pdf", blob: new Blob([outBytes], { type: "application/pdf" }) }];
  }

  /* ---------------- Image tool functions ---------------- */

  async function imageCompress(files, opts, onProgress) {
    const quality = (parseInt(opts.quality, 10) || 75) / 100;
    return batchImageOutputs(files, onProgress, "compressed-images", async (file) => {
      const bitmap = await loadImageBitmap(file);
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      canvas.getContext("2d").drawImage(bitmap, 0, 0);
      const blob = await canvasToBlob(canvas, "image/jpeg", quality);
      return { name: file.name.replace(/\.[^.]+$/, "") + "-compressed.jpg", blob };
    });
  }

  async function imageResize(files, opts, onProgress) {
    return batchImageOutputs(files, onProgress, "resized-images", async (file) => {
      const bitmap = await loadImageBitmap(file);
      let w = parseInt(opts.width, 10) || bitmap.width;
      let h = parseInt(opts.height, 10) || bitmap.height;
      if (opts.lock === "on") {
        const ratio = bitmap.width / bitmap.height;
        if (opts.changed === "width") h = Math.round(w / ratio);
        else w = Math.round(h * ratio);
      }
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      canvas.getContext("2d").drawImage(bitmap, 0, 0, w, h);
      const mime = file.type && file.type.startsWith("image/") ? file.type : "image/png";
      const blob = await canvasToBlob(canvas, mime, 0.92);
      return { name: file.name.replace(/\.[^.]+$/, "") + `-${w}x${h}.${extFor(mime)}`, blob };
    });
  }

  async function imageConvert(files, opts, onProgress) {
    const targetMime = opts.format || "image/png";
    return batchImageOutputs(files, onProgress, "converted-images", async (file) => {
      const bitmap = await loadImageBitmap(file);
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      canvas.getContext("2d").drawImage(bitmap, 0, 0);
      const blob = await canvasToBlob(canvas, targetMime, 0.92);
      return { name: file.name.replace(/\.[^.]+$/, "") + "." + extFor(targetMime), blob };
    });
  }

  async function imageCrop(files, opts, onProgress) {
    return batchImageOutputs(files, onProgress, "cropped-images", async (file) => {
      const bitmap = await loadImageBitmap(file);
      const x = Math.max(0, parseInt(opts.x, 10) || 0);
      const y = Math.max(0, parseInt(opts.y, 10) || 0);
      const w = Math.min(bitmap.width - x, parseInt(opts.w, 10) || bitmap.width);
      const h = Math.min(bitmap.height - y, parseInt(opts.h, 10) || bitmap.height);
      if (w <= 0 || h <= 0) throw new Error(`Crop area is outside the bounds of ${file.name}.`);
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      canvas.getContext("2d").drawImage(bitmap, x, y, w, h, 0, 0, w, h);
      const mime = file.type && file.type.startsWith("image/") ? file.type : "image/png";
      const blob = await canvasToBlob(canvas, mime, 0.92);
      return { name: file.name.replace(/\.[^.]+$/, "") + "-cropped." + extFor(mime), blob };
    });
  }

  async function imageRotate(files, opts, onProgress) {
    const angle = parseInt(opts.angle, 10) || 90;
    return batchImageOutputs(files, onProgress, "rotated-images", async (file) => {
      const bitmap = await loadImageBitmap(file);
      const swap = angle === 90 || angle === 270;
      const canvas = document.createElement("canvas");
      canvas.width = swap ? bitmap.height : bitmap.width;
      canvas.height = swap ? bitmap.width : bitmap.height;
      const ctx = canvas.getContext("2d");
      ctx.translate(canvas.width / 2, canvas.height / 2);
      ctx.rotate((angle * Math.PI) / 180);
      ctx.drawImage(bitmap, -bitmap.width / 2, -bitmap.height / 2);
      const mime = file.type && file.type.startsWith("image/") ? file.type : "image/png";
      const blob = await canvasToBlob(canvas, mime, 0.92);
      return { name: file.name.replace(/\.[^.]+$/, "") + "-rotated." + extFor(mime), blob };
    });
  }

  async function imageWatermark(files, opts, onProgress) {
    const text = opts.text || "gptpayer";
    const opacity = (parseInt(opts.opacity, 10) || 50) / 100;
    const position = opts.position || "bottom-right";
    return batchImageOutputs(files, onProgress, "watermarked-images", async (file) => {
      const bitmap = await loadImageBitmap(file);
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(bitmap, 0, 0);
      const fontSize = Math.max(18, Math.round(bitmap.width / 22));
      ctx.font = `600 ${fontSize}px sans-serif`;
      ctx.fillStyle = `rgba(255,255,255,${opacity})`;
      ctx.strokeStyle = `rgba(0,0,0,${opacity * 0.6})`;
      ctx.lineWidth = Math.max(1, fontSize / 12);
      const metrics = ctx.measureText(text);
      const pad = fontSize;
      let tx = pad, ty = bitmap.height - pad;
      if (position === "center") { tx = (bitmap.width - metrics.width) / 2; ty = bitmap.height / 2; }
      if (position === "top-left") { tx = pad; ty = pad + fontSize; }
      if (position === "bottom-right") { tx = bitmap.width - metrics.width - pad; ty = bitmap.height - pad; }
      ctx.strokeText(text, tx, ty);
      ctx.fillText(text, tx, ty);
      const mime = file.type && file.type.startsWith("image/") ? file.type : "image/png";
      const blob = await canvasToBlob(canvas, mime, 0.92);
      return { name: file.name.replace(/\.[^.]+$/, "") + "-watermarked." + extFor(mime), blob };
    });
  }

  // Unsharp mask: blur a copy, then push the original away from the blur
  // along each channel. Run after the resize so the extra edge contrast
  // survives the upscale instead of being smoothed away by it.
  function unsharpMask(ctx, w, h, amount) {
    const src = ctx.getImageData(0, 0, w, h);
    const blurCanvas = document.createElement("canvas");
    blurCanvas.width = w; blurCanvas.height = h;
    const bctx = blurCanvas.getContext("2d");
    bctx.filter = "blur(1.2px)";
    bctx.drawImage(ctx.canvas, 0, 0);
    const blurred = bctx.getImageData(0, 0, w, h);
    const s = src.data, b = blurred.data;
    for (let i = 0; i < s.length; i += 4) {
      for (let c = 0; c < 3; c++) {
        const v = s[i + c] + (s[i + c] - b[i + c]) * amount;
        s[i + c] = v < 0 ? 0 : v > 255 ? 255 : v;
      }
    }
    ctx.putImageData(src, 0, 0);
  }

  async function imageUpscale(files, opts, onProgress) {
    const factor = parseInt(opts.factor, 10) || 2;
    return batchImageOutputs(files, onProgress, "upscaled-images", async (file) => {
      const bitmap = await loadImageBitmap(file);
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width * factor;
      canvas.height = bitmap.height * factor;
      const ctx = canvas.getContext("2d");
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      // A plain resize looks soft — a light sharpening pass afterward
      // brings back perceived detail without introducing new artifacts.
      unsharpMask(ctx, canvas.width, canvas.height, 0.35);
      const mime = file.type && file.type.startsWith("image/") ? file.type : "image/png";
      const blob = await canvasToBlob(canvas, mime, 0.92);
      return { name: file.name.replace(/\.[^.]+$/, "") + `-${factor}x.` + extFor(mime), blob };
    });
  }

  async function imageMeme(files, opts, onProgress) {
    return batchImageOutputs(files, onProgress, "memes", async (file) => {
      const bitmap = await loadImageBitmap(file);
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(bitmap, 0, 0);
      const fontSize = Math.max(24, Math.round(bitmap.width / 11));
      ctx.font = `900 ${fontSize}px Impact, "Arial Black", sans-serif`;
      ctx.textAlign = "center";
      ctx.fillStyle = "#fff";
      ctx.strokeStyle = "#000";
      ctx.lineWidth = Math.max(2, fontSize / 10);
      ctx.lineJoin = "round";
      const drawLine = (text, y) => {
        const t = text.toUpperCase();
        ctx.strokeText(t, canvas.width / 2, y);
        ctx.fillText(t, canvas.width / 2, y);
      };
      if (opts.top) drawLine(opts.top, fontSize + 12);
      if (opts.bottom) drawLine(opts.bottom, canvas.height - 20);
      const mime = file.type && file.type.startsWith("image/") ? file.type : "image/png";
      const blob = await canvasToBlob(canvas, mime, 0.92);
      return { name: file.name.replace(/\.[^.]+$/, "") + "-meme." + extFor(mime), blob };
    });
  }

  async function imagePhotoEditor(files, opts, onProgress) {
    const brightness = opts.brightness || 100;
    const contrast = opts.contrast || 100;
    const saturate = opts.saturate || 100;
    return batchImageOutputs(files, onProgress, "edited-images", async (file) => {
      const bitmap = await loadImageBitmap(file);
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext("2d");
      ctx.filter = `brightness(${brightness}%) contrast(${contrast}%) saturate(${saturate}%)`;
      ctx.drawImage(bitmap, 0, 0);
      const mime = file.type && file.type.startsWith("image/") ? file.type : "image/png";
      const blob = await canvasToBlob(canvas, mime, 0.92);
      return { name: file.name.replace(/\.[^.]+$/, "") + "-edited." + extFor(mime), blob };
    });
  }

  async function imageBlurArea(files, opts, onProgress) {
    const blurPx = parseInt(opts.strength, 10) || 16;
    return batchImageOutputs(files, onProgress, "blurred-images", async (file) => {
      const bitmap = await loadImageBitmap(file);
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(bitmap, 0, 0);

      const temp = document.createElement("canvas");
      temp.width = bitmap.width;
      temp.height = bitmap.height;
      const tctx = temp.getContext("2d");
      tctx.filter = `blur(${blurPx}px)`;
      tctx.drawImage(bitmap, 0, 0);

      const x = Math.max(0, parseInt(opts.x, 10) || 0);
      const y = Math.max(0, parseInt(opts.y, 10) || 0);
      const w = Math.min(bitmap.width - x, parseInt(opts.w, 10) || 100);
      const h = Math.min(bitmap.height - y, parseInt(opts.h, 10) || 100);
      if (w <= 0 || h <= 0) throw new Error(`Blur area is outside the bounds of ${file.name}.`);
      ctx.drawImage(temp, x, y, w, h, x, y, w, h);

      const mime = file.type && file.type.startsWith("image/") ? file.type : "image/png";
      const blob = await canvasToBlob(canvas, mime, 0.92);
      return { name: file.name.replace(/\.[^.]+$/, "") + "-blurred." + extFor(mime), blob };
    });
  }

  async function imageRemoveBg(files, opts, onProgress) {
    let mod;
    try {
      if (onProgress) onProgress(0, files.length, "Loading on-device AI model…");
      mod = await import("https://cdn.jsdelivr.net/npm/@imgly/background-removal@latest/dist/browser.mjs");
    } catch (e) {
      throw new Error("Couldn't load the on-device AI model — check your internet connection and try again.");
    }
    return batchImageOutputs(files, onProgress, "no-background-images", async (file) => {
      const resultBlob = await mod.removeBackground(file);
      return { name: file.name.replace(/\.[^.]+$/, "") + "-nobg.png", blob: resultBlob };
    });
  }

  async function imageToPdf(files, opts, onProgress) {
    const { PDFDocument } = PDFLib;
    const out = await PDFDocument.create();
    for (let i = 0; i < files.length; i++) {
      if (onProgress) onProgress(i, files.length, `Adding ${files[i].name}…`);
      const bitmap = await loadImageBitmap(files[i]);
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      canvas.getContext("2d").drawImage(bitmap, 0, 0);
      const jpgBlob = await canvasToBlob(canvas, "image/jpeg", 0.92);
      const jpgBytes = new Uint8Array(await jpgBlob.arrayBuffer());
      const embedded = await out.embedJpg(jpgBytes);
      const page = out.addPage([embedded.width, embedded.height]);
      page.drawImage(embedded, { x: 0, y: 0, width: embedded.width, height: embedded.height });
    }
    if (onProgress) onProgress(files.length, files.length, "Finishing…");
    const bytes = await out.save();
    return [{ name: "images.pdf", blob: new Blob([bytes], { type: "application/pdf" }) }];
  }

  /* ---------------- tool registry ---------------- */

  const TOOLS = {
    "merge-pdf": {
      title: "Merge PDF", sub: "Add two or more PDFs, drag to reorder, then merge.",
      accept: "application/pdf", multiple: true, minFiles: 2,
      run: pdfMerge,
    },
    "split-pdf": {
      title: "Split PDF", sub: "Pull a page range out into its own file.",
      accept: "application/pdf", multiple: false, minFiles: 1,
      options: () => `
        <label class="opt-label">Start page <input type="number" min="1" value="1" id="opt-start" class="opt-input"></label>
        <label class="opt-label">End page <input type="number" min="1" value="1" id="opt-end" class="opt-input"></label>`,
      readOpts: () => ({ start: $("#opt-start").value, end: $("#opt-end").value }),
      run: pdfSplit,
    },
    "compress-pdf": {
      title: "Compress PDF", sub: "Re-package the file to reduce size. Best on text-heavy PDFs. Add several PDFs to batch-compress them into one zip.",
      accept: "application/pdf", multiple: true, minFiles: 1,
      run: pdfCompress,
    },
    "pdf-to-jpg": {
      title: "PDF to JPG", sub: "Export every page as a JPG image.",
      accept: "application/pdf", multiple: false, minFiles: 1,
      options: () => `<label class="opt-label">Quality <input type="range" min="30" max="100" value="85" id="opt-quality" class="opt-range"></label>`,
      readOpts: () => ({ quality: $("#opt-quality").value }),
      run: pdfToJpg,
    },
    "rotate-pdf": {
      title: "Rotate PDF", sub: "Rotate every page by a fixed angle. Add several PDFs to rotate them all at once.",
      accept: "application/pdf", multiple: true, minFiles: 1,
      options: () => `
        <label class="opt-label">Angle
          <select id="opt-angle" class="opt-input">
            <option value="90">90°</option><option value="180">180°</option><option value="270">270°</option>
          </select>
        </label>`,
      readOpts: () => ({ angle: $("#opt-angle").value }),
      run: pdfRotate,
    },
    "compress-image": {
      title: "Compress Image", sub: "Lower the quality slider for a smaller JPG. Add several images to batch-compress them into one zip.",
      accept: "image/*", multiple: true, minFiles: 1,
      options: () => `<label class="opt-label">Quality <input type="range" min="10" max="95" value="75" id="opt-quality" class="opt-range"></label>`,
      readOpts: () => ({ quality: $("#opt-quality").value }),
      run: imageCompress,
    },
    "resize-image": {
      title: "Resize Image", sub: "Set exact pixel dimensions. Add several images to resize them all at once.",
      accept: "image/*", multiple: true, minFiles: 1,
      options: () => `
        <label class="opt-label">Width (px) <input type="number" min="1" id="opt-width" class="opt-input" placeholder="e.g. 1200"></label>
        <label class="opt-label">Height (px) <input type="number" min="1" id="opt-height" class="opt-input" placeholder="e.g. 800"></label>
        <label class="opt-check"><input type="checkbox" id="opt-lock" checked> Keep aspect ratio</label>`,
      readOpts: () => ({ width: $("#opt-width").value, height: $("#opt-height").value, lock: $("#opt-lock").checked ? "on" : "off", changed: $("#opt-width").value ? "width" : "height" }),
      run: imageResize,
    },
    "convert-image": {
      title: "Convert Image", sub: "Switch the file format. Add several images to convert them all at once.",
      accept: "image/*", multiple: true, minFiles: 1,
      options: () => `
        <label class="opt-label">Convert to
          <select id="opt-format" class="opt-input">
            <option value="image/jpeg">JPG</option>
            <option value="image/png">PNG</option>
            <option value="image/webp">WEBP</option>
          </select>
        </label>`,
      readOpts: () => ({ format: $("#opt-format").value }),
      run: imageConvert,
    },
    "crop-image": {
      title: "Crop Image", sub: "Drag the box on the preview, or type exact pixels. The same box applies to every image you add.",
      accept: "image/*", multiple: true, minFiles: 1,
      options: () => `
        <label class="opt-label">X <input type="number" min="0" value="0" id="opt-x" class="opt-input"></label>
        <label class="opt-label">Y <input type="number" min="0" value="0" id="opt-y" class="opt-input"></label>
        <label class="opt-label">Width <input type="number" min="1" id="opt-w" class="opt-input" placeholder="px"></label>
        <label class="opt-label">Height <input type="number" min="1" id="opt-h" class="opt-input" placeholder="px"></label>`,
      readOpts: () => ({ x: $("#opt-x").value, y: $("#opt-y").value, w: $("#opt-w").value, h: $("#opt-h").value }),
      buildDynamicUI: buildCropImageUI,
      run: imageCrop,
    },
    "image-to-pdf": {
      title: "Image to PDF", sub: "Add one or more images, drag to reorder, then build the PDF.",
      accept: "image/*", multiple: true, minFiles: 1,
      run: imageToPdf,
    },
    "rotate-image": {
      title: "Rotate Image", sub: "Rotate by a fixed angle. Add several images to rotate them all at once.",
      accept: "image/*", multiple: true, minFiles: 1,
      options: () => `
        <label class="opt-label">Angle
          <select id="opt-angle" class="opt-input">
            <option value="90">90°</option><option value="180">180°</option><option value="270">270°</option>
          </select>
        </label>`,
      readOpts: () => ({ angle: $("#opt-angle").value }),
      run: imageRotate,
    },
    "watermark-image": {
      title: "Watermark Image", sub: "Stamp text across your image. Add several to watermark them all at once.",
      accept: "image/*", multiple: true, minFiles: 1,
      options: () => `
        <label class="opt-label">Text <input type="text" id="opt-text" class="opt-input" value="gptpayer" maxlength="40"></label>
        <label class="opt-label">Opacity <input type="range" min="10" max="100" value="55" id="opt-opacity" class="opt-range"></label>
        <label class="opt-label">Position
          <select id="opt-position" class="opt-input">
            <option value="bottom-right">Bottom right</option>
            <option value="top-left">Top left</option>
            <option value="center">Center</option>
          </select>
        </label>`,
      readOpts: () => ({ text: $("#opt-text").value, opacity: $("#opt-opacity").value, position: $("#opt-position").value }),
      run: imageWatermark,
    },
    "remove-pages": {
      title: "Remove Pages", sub: "Delete specific pages, e.g. 2, 5-7.",
      accept: "application/pdf", multiple: false, minFiles: 1,
      options: () => `<label class="opt-label">Pages to remove <input type="text" id="opt-pages" class="opt-input" placeholder="e.g. 2, 5-7"></label>`,
      readOpts: () => ({ pages: $("#opt-pages").value }),
      run: pdfRemovePages,
    },
    "extract-pages": {
      title: "Extract Pages", sub: "Pull specific pages into a new file.",
      accept: "application/pdf", multiple: false, minFiles: 1,
      options: () => `<label class="opt-label">Pages to keep <input type="text" id="opt-pages" class="opt-input" placeholder="e.g. 1, 3, 5-6"></label>`,
      readOpts: () => ({ pages: $("#opt-pages").value }),
      run: pdfExtractPages,
    },
    "pdf-page-numbers": {
      title: "Add Page Numbers", sub: "Stamps \"page / total\" at the bottom of every page. Add several PDFs to number them all at once.",
      accept: "application/pdf", multiple: true, minFiles: 1,
      run: pdfAddPageNumbers,
    },
    "pdf-watermark": {
      title: "Add Watermark", sub: "Diagonal text watermark across every page. Add several PDFs to watermark them all at once.",
      accept: "application/pdf", multiple: true, minFiles: 1,
      options: () => `
        <label class="opt-label">Text <input type="text" id="opt-text" class="opt-input" value="gptpayer" maxlength="40"></label>
        <label class="opt-label">Opacity <input type="range" min="10" max="80" value="30" id="opt-opacity" class="opt-range"></label>`,
      readOpts: () => ({ text: $("#opt-text").value, opacity: $("#opt-opacity").value }),
      run: pdfWatermark,
    },
    "crop-pdf": {
      title: "Crop PDF", sub: "Trim a fixed margin (in points) off every page. Add several PDFs to crop them all with the same margins.",
      accept: "application/pdf", multiple: true, minFiles: 1,
      options: () => `
        <label class="opt-label">Top <input type="number" min="0" value="0" id="opt-top" class="opt-input"></label>
        <label class="opt-label">Right <input type="number" min="0" value="0" id="opt-right" class="opt-input"></label>
        <label class="opt-label">Bottom <input type="number" min="0" value="0" id="opt-bottom" class="opt-input"></label>
        <label class="opt-label">Left <input type="number" min="0" value="0" id="opt-left" class="opt-input"></label>`,
      readOpts: () => ({ top: $("#opt-top").value, right: $("#opt-right").value, bottom: $("#opt-bottom").value, left: $("#opt-left").value }),
      run: pdfCrop,
    },
    "sign-pdf": {
      title: "Sign PDF", sub: "Stamp a typed signature onto a chosen page.",
      accept: "application/pdf", multiple: false, minFiles: 1,
      options: () => `
        <label class="opt-label">Signature text <input type="text" id="opt-text" class="opt-input" placeholder="Your name" value="Signed"></label>
        <label class="opt-label">Page number <input type="number" min="1" id="opt-page" class="opt-input" placeholder="last page"></label>`,
      readOpts: () => ({ text: $("#opt-text").value, page: $("#opt-page").value }),
      run: pdfSign,
    },
    "redact-pdf": {
      title: "Redact PDF", sub: "Drag over the area to black out, or type exact coordinates — permanent, one page at a time.",
      accept: "application/pdf", multiple: false, minFiles: 1,
      options: () => `
        <label class="opt-label">Page number <input type="number" min="1" value="1" id="opt-page" class="opt-input"></label>
        <label class="opt-label">X (pt from left) <input type="number" min="0" value="50" id="opt-x" class="opt-input"></label>
        <label class="opt-label">Y (pt from bottom) <input type="number" min="0" value="700" id="opt-y" class="opt-input"></label>
        <label class="opt-label">Width (pt) <input type="number" min="1" value="150" id="opt-w" class="opt-input"></label>
        <label class="opt-label">Height (pt) <input type="number" min="1" value="30" id="opt-h" class="opt-input"></label>`,
      readOpts: () => ({ page: $("#opt-page").value, x: $("#opt-x").value, y: $("#opt-y").value, w: $("#opt-w").value, h: $("#opt-h").value }),
      buildDynamicUI: buildRedactUI,
      run: pdfRedact,
    },
    "upscale-image": {
      title: "Upscale", sub: "Simple pixel upscale (2× or 4×) — not an AI upscaler, so very low-res sources will still look soft. Batch-friendly.",
      accept: "image/*", multiple: true, minFiles: 1,
      options: () => `
        <label class="opt-label">Scale factor
          <select id="opt-factor" class="opt-input">
            <option value="2">2×</option><option value="4">4×</option>
          </select>
        </label>`,
      readOpts: () => ({ factor: $("#opt-factor").value }),
      run: imageUpscale,
    },
    "meme-generator": {
      title: "Meme Generator", sub: "Classic top and bottom caption text. The same captions apply to every image you add.",
      accept: "image/*", multiple: true, minFiles: 1,
      options: () => `
        <label class="opt-label">Top text <input type="text" id="opt-top" class="opt-input" maxlength="60"></label>
        <label class="opt-label">Bottom text <input type="text" id="opt-bottom" class="opt-input" maxlength="60"></label>`,
      readOpts: () => ({ top: $("#opt-top").value, bottom: $("#opt-bottom").value }),
      run: imageMeme,
    },
    "photo-editor": {
      title: "Photo Editor", sub: "Adjust brightness, contrast and saturation. Add several images to edit them all at once.",
      accept: "image/*", multiple: true, minFiles: 1,
      options: () => `
        <label class="opt-label">Brightness <input type="range" min="40" max="160" value="100" id="opt-brightness" class="opt-range"></label>
        <label class="opt-label">Contrast <input type="range" min="40" max="160" value="100" id="opt-contrast" class="opt-range"></label>
        <label class="opt-label">Saturation <input type="range" min="0" max="200" value="100" id="opt-saturate" class="opt-range"></label>`,
      readOpts: () => ({ brightness: $("#opt-brightness").value, contrast: $("#opt-contrast").value, saturate: $("#opt-saturate").value }),
      run: imagePhotoEditor,
    },
    "blur-area": {
      title: "Blur Area", sub: "Drag over a face or any region to blur it (no automatic face detection). The same box applies to every image you add.",
      accept: "image/*", multiple: true, minFiles: 1,
      options: () => `
        <label class="opt-label">X (px) <input type="number" min="0" value="0" id="opt-x" class="opt-input"></label>
        <label class="opt-label">Y (px) <input type="number" min="0" value="0" id="opt-y" class="opt-input"></label>
        <label class="opt-label">Width (px) <input type="number" min="1" value="150" id="opt-w" class="opt-input"></label>
        <label class="opt-label">Height (px) <input type="number" min="1" value="150" id="opt-h" class="opt-input"></label>
        <label class="opt-label">Strength <input type="range" min="4" max="40" value="16" id="opt-strength" class="opt-range"></label>`,
      readOpts: () => ({ x: $("#opt-x").value, y: $("#opt-y").value, w: $("#opt-w").value, h: $("#opt-h").value, strength: $("#opt-strength").value }),
      buildDynamicUI: buildBlurAreaUI,
      run: imageBlurArea,
    },

    "organize-pdf": {
      title: "Organize PDF", sub: "Reorder, rotate or drop pages using page thumbnails.",
      accept: "application/pdf", multiple: false, minFiles: 1,
      buildDynamicUI: buildOrganizeUI,
      run: pdfOrganize,
    },
    "scan-to-pdf": {
      title: "Scan to PDF", sub: "Turn one or more photos of paper documents into a clean PDF.",
      accept: "image/*", multiple: true, minFiles: 1, capture: "environment",
      options: () => `
        <label class="opt-label">Look
          <select id="opt-mode" class="opt-input">
            <option value="color">Color</option>
            <option value="grayscale">Grayscale</option>
            <option value="bw">Black &amp; white</option>
          </select>
        </label>`,
      readOpts: () => ({ mode: $("#opt-mode").value }),
      run: pdfScanToPdf,
    },
    "repair-pdf": {
      title: "Repair PDF", sub: "Re-packages a broken PDF; if that fails, rebuilds it page-by-page from whatever can still be rendered.",
      accept: "application/pdf", multiple: false, minFiles: 1,
      run: pdfRepair,
    },
    "unlock-pdf": {
      title: "Unlock PDF", sub: "Removes a password you already know — enter it below.",
      accept: "application/pdf", multiple: false, minFiles: 1,
      options: () => `<label class="opt-label">Password <input type="password" id="opt-password" class="opt-input" placeholder="PDF password"></label>`,
      readOpts: () => ({ password: $("#opt-password").value }),
      run: pdfUnlock,
    },
    "compare-pdf": {
      title: "Compare PDF", sub: "Add exactly two PDFs — the first two are compared line by line, page by page.",
      accept: "application/pdf", multiple: true, minFiles: 2,
      run: pdfCompare,
    },
    "pdf-to-markdown": {
      title: "PDF to Markdown", sub: "Extracts text and guesses headings from font size. Best on simple, text-based documents.",
      accept: "application/pdf", multiple: false, minFiles: 1,
      run: pdfToMarkdown,
    },
    "html-to-pdf": {
      title: "HTML to PDF", sub: "Upload an .html file — it's rendered and paginated into a PDF. External images/fonts need CORS to show up.",
      accept: ".html,.htm,text/html", multiple: false, minFiles: 1,
      run: htmlToPdf,
    },
    "html-to-image": {
      title: "HTML to Image", sub: "Upload an .html file — it's rendered to a single PNG screenshot.",
      accept: ".html,.htm,text/html", multiple: false, minFiles: 1,
      run: htmlToImage,
    },
    "edit-pdf": {
      title: "Edit PDF", sub: "Stamp text, a rectangle outline, or a line onto one page. Run again to add more.",
      accept: "application/pdf", multiple: false, minFiles: 1,
      options: () => `
        <label class="opt-label">Add
          <select id="opt-type" class="opt-input">
            <option value="text">Text</option>
            <option value="rectangle">Rectangle outline</option>
            <option value="line">Line</option>
          </select>
        </label>
        <label class="opt-label">Page number <input type="number" min="1" value="1" id="opt-page" class="opt-input"></label>
        <label class="opt-label">Text (if adding text) <input type="text" id="opt-text" class="opt-input" placeholder="Your text" maxlength="80"></label>
        <label class="opt-label">Font size <input type="number" min="4" value="18" id="opt-size" class="opt-input"></label>
        <label class="opt-label">X — pt from left <input type="number" value="50" id="opt-x" class="opt-input"></label>
        <label class="opt-label">Y — pt from bottom <input type="number" value="700" id="opt-y" class="opt-input"></label>
        <label class="opt-label">Width / line end X <input type="number" value="150" id="opt-w" class="opt-input"></label>
        <label class="opt-label">Height / line end Y <input type="number" value="40" id="opt-h" class="opt-input"></label>
        <label class="opt-label">Color <input type="color" id="opt-color" class="opt-input" value="#e63946"></label>`,
      readOpts: () => ({
        type: $("#opt-type").value, page: $("#opt-page").value, text: $("#opt-text").value, size: $("#opt-size").value,
        x: $("#opt-x").value, y: $("#opt-y").value, w: $("#opt-w").value, h: $("#opt-h").value, color: $("#opt-color").value,
      }),
      run: pdfEdit,
    },
    "pdf-forms": {
      title: "PDF Forms", sub: "Detects fillable AcroForm fields in a PDF and lets you fill them in.",
      accept: "application/pdf", multiple: false, minFiles: 1,
      buildDynamicUI: buildFormsUI,
      readOpts: () => ({ flatten: !!($("#opt-flatten") && $("#opt-flatten").checked) }),
      run: pdfFillForms,
    },
    "remove-bg": {
      title: "Remove Background", sub: "Cuts the subject out onto a transparent PNG using an on-device AI model (downloads once, then stays local). Batch-friendly.",
      accept: "image/*", multiple: true, minFiles: 1,
      run: imageRemoveBg,
    },

    "pdf-to-word": { title: "PDF to Word", sub: "This needs a document-conversion engine we don't run in the browser yet.", comingSoon: true },
    "protect-pdf": { title: "Protect PDF", sub: "Real, reader-compatible password encryption needs a crypto engine we haven't finished testing yet — we'd rather ship it right than ship a password that doesn't actually hold.", comingSoon: true },
    "ocr-pdf": {
      title: "OCR PDF", sub: "Recognizes text on scanned pages using an on-device AI model (downloads once, then stays local) and exports it as Markdown.",
      accept: "application/pdf", multiple: false, minFiles: 1,
      options: () => `
        <label class="opt-label">Language
          <select id="opt-lang" class="opt-input">
            <option value="eng">English</option>
            <option value="spa">Spanish</option>
            <option value="fra">French</option>
            <option value="deu">German</option>
            <option value="por">Portuguese</option>
            <option value="hin">Hindi</option>
            <option value="ara">Arabic</option>
            <option value="chi_sim">Chinese (Simplified)</option>
          </select>
        </label>`,
      readOpts: () => ({ lang: $("#opt-lang").value }),
      run: pdfOcr,
    },
    "word-to-pdf": { title: "Word to PDF", sub: "Rendering .docx layout accurately needs a conversion engine we don't run in the browser yet.", comingSoon: true },
    "ppt-to-pdf": { title: "PowerPoint to PDF", sub: "Same story as Word to PDF — needs a real conversion engine.", comingSoon: true },
    "pdf-to-ppt": { title: "PDF to PowerPoint", sub: "Rebuilding editable slides from a PDF needs a real conversion engine.", comingSoon: true },
    "excel-to-pdf": { title: "Excel to PDF", sub: "Needs a spreadsheet-rendering engine we haven't wired in yet.", comingSoon: true },
    "pdf-to-excel": { title: "PDF to Excel", sub: "Reliable table extraction is on the roadmap.", comingSoon: true },
    "pdf-to-pdfa": { title: "PDF to PDF/A", sub: "True archival-format conformance (embedded ICC profiles, XMP metadata) is on the roadmap.", comingSoon: true },
    "ai-summarizer": { title: "AI Summarizer", sub: "This needs a connected AI model — not something we run fully offline in your browser.", comingSoon: true },
    "translate-pdf": { title: "Translate PDF", sub: "Needs a connected translation model.", comingSoon: true },
  };

  /* ---------------- mobile nav (works on every page, wired FIRST and
     unconditionally so a bug anywhere in the tool-modal code below can
     never prevent the hamburger menu from working) ---------------- */
  const hamburger = $("#hamburger");
  const mobileNav = $("#mobile-nav");
  const siteHeader = $(".site-header");

  function syncHeaderHeight() {
    if (siteHeader) {
      document.documentElement.style.setProperty("--header-h", siteHeader.offsetHeight + "px");
    }
  }
  syncHeaderHeight();
  window.addEventListener("resize", syncHeaderHeight);
  if (window.ResizeObserver && siteHeader) {
    new ResizeObserver(syncHeaderHeight).observe(siteHeader);
  }

  function openMobileNav() {
    syncHeaderHeight();
    closeSearchBar();
    closeNavDropdowns();
    mobileNav.hidden = false;
    hamburger.setAttribute("aria-expanded", "true");
    document.body.style.overflow = "hidden";
  }
  function closeMobileNav() {
    mobileNav.hidden = true;
    hamburger.setAttribute("aria-expanded", "false");
    document.body.style.overflow = "";
  }
  if (hamburger && mobileNav) {
    hamburger.addEventListener("click", () => {
      if (mobileNav.hidden) openMobileNav();
      else closeMobileNav();
    });
    mobileNav.querySelectorAll("a").forEach((a) => a.addEventListener("click", closeMobileNav));
    window.addEventListener("resize", () => {
      if (window.innerWidth > 900 && !mobileNav.hidden) closeMobileNav();
    });
  }

  /* ---------------- header search toggle (icon opens/closes the search bar,
     collapsed by default; closes whenever the hamburger menu opens) --------- */
  const searchToggle = $("#tool-search-toggle");
  const searchBar = $("#tool-search-bar");
  const searchInput = $("#tool-search");

  function openSearchBar() {
    if (!searchBar) return;
    if (mobileNav && !mobileNav.hidden) closeMobileNav();
    closeNavDropdowns();
    searchBar.hidden = false;
    if (searchToggle) searchToggle.setAttribute("aria-expanded", "true");
    if (searchInput) searchInput.focus();
  }
  function closeSearchBar() {
    if (!searchBar) return;
    searchBar.hidden = true;
    if (searchToggle) searchToggle.setAttribute("aria-expanded", "false");
  }
  if (searchToggle && searchBar) {
    searchToggle.addEventListener("click", () => {
      if (searchBar.hidden) openSearchBar();
      else closeSearchBar();
    });
    document.addEventListener("click", (e) => {
      if (searchBar.hidden) return;
      if (searchBar.contains(e.target) || searchToggle.contains(e.target)) return;
      closeSearchBar();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !searchBar.hidden) closeSearchBar();
    });
  }

  /* ---------------- desktop nav dropdowns (PDF tools / Image tools show
     a short-form tool menu on click, alongside the normal anchor scroll) --- */
  const navItems = document.querySelectorAll(".nav-item");
  function closeNavDropdowns() {
    navItems.forEach((item) => {
      const trigger = item.querySelector(".nav-dropdown-trigger");
      const dropdown = item.querySelector(".nav-dropdown");
      if (dropdown) dropdown.hidden = true;
      if (trigger) trigger.setAttribute("aria-expanded", "false");
    });
  }
  navItems.forEach((item) => {
    const trigger = item.querySelector(".nav-dropdown-trigger");
    const dropdown = item.querySelector(".nav-dropdown");
    if (!trigger || !dropdown) return;
    trigger.addEventListener("click", (e) => {
      const isOpen = !dropdown.hidden;
      closeNavDropdowns();
      if (!isOpen) {
        closeSearchBar();
        dropdown.hidden = false;
        trigger.setAttribute("aria-expanded", "true");
        e.stopPropagation();
      }
      // No preventDefault: the page still scrolls to the section as before.
    });
  });
  if (navItems.length) {
    document.addEventListener("click", (e) => {
      const insideAnyDropdown = Array.from(navItems).some((item) => item.contains(e.target));
      if (!insideAnyDropdown) closeNavDropdowns();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeNavDropdowns();
    });
    window.addEventListener("resize", () => {
      if (window.innerWidth <= 900) closeNavDropdowns();
    });
  }

  /* ---------------- modal state & wiring ---------------- */
  /* Guarded: privacy.html / terms.html / 404.html include app.js for the
     hamburger menu but don't have the tool-modal markup on the page.
     Wrapped in try/catch so a bug here can never take down the hamburger
     menu wired above. */
  try {

  const overlay = $("#modal-overlay");

  if (overlay) {
    const modalTitle = $("#modal-title");
    const modalSub = $("#modal-sub");
    const dropzone = $("#dropzone");
    const fileInput = $("#file-input");
    const fileListEl = $("#file-list");
    const optionsEl = $("#tool-options");
    const dynamicEl = $("#tool-dynamic");
    const runBtn = $("#modal-run");
    const statusEl = $("#modal-status");
    const resultEl = $("#modal-result");
    const closeBtn = $("#modal-close");

    let currentToolId = null;
    let currentFiles = [];

    // Remembers non-sensitive option choices (quality sliders, formats,
    // angles, etc.) per tool across visits. Deliberately skips text/password
    // inputs so nothing like a signature, watermark text, or PDF password
    // ever touches localStorage.
    const SETTINGS_PREFIX = "gptpayer:opt:";
    function restoreToolSettings(toolId, root) {
      root.querySelectorAll("input, select").forEach((el) => {
        if (!el.id || el.type === "text" || el.type === "password") return;
        try {
          const saved = localStorage.getItem(SETTINGS_PREFIX + toolId + ":" + el.id);
          if (saved === null) return;
          if (el.type === "checkbox") el.checked = saved === "1";
          else el.value = saved;
        } catch (e) { /* localStorage unavailable (private mode etc.) */ }
      });
    }
    optionsEl.addEventListener("change", (e) => {
      const el = e.target;
      if (!currentToolId || !el.id || el.type === "text" || el.type === "password") return;
      try {
        const val = el.type === "checkbox" ? (el.checked ? "1" : "0") : el.value;
        localStorage.setItem(SETTINGS_PREFIX + currentToolId + ":" + el.id, val);
      } catch (e) { /* ignore */ }
    });

    function openModal(toolId) {
      const tool = TOOLS[toolId];
      if (!tool) return;
      currentToolId = toolId;
      currentFiles = [];
      modalTitle.textContent = tool.title;
      modalSub.textContent = tool.sub;
      fileListEl.innerHTML = "";
      optionsEl.innerHTML = tool.comingSoon ? "" : (tool.options ? tool.options() : "");
      restoreToolSettings(toolId, optionsEl);
      if (dynamicEl) dynamicEl.innerHTML = "";
      organizeState = null;
      formsState = null;
      resultEl.innerHTML = "";
      statusEl.textContent = "";
      fileInput.value = "";
      fileInput.multiple = !!tool.multiple;
      fileInput.accept = tool.accept || "";
      if (tool.capture) fileInput.setAttribute("capture", tool.capture);
      else fileInput.removeAttribute("capture");
      dropzone.hidden = !!tool.comingSoon;
      if (tool.comingSoon) {
        runBtn.hidden = true;
        statusEl.textContent = "🚧 " + tool.sub;
      } else {
        runBtn.hidden = false;
        runBtn.disabled = true;
        runBtn.textContent = "Choose a file first";
      }
      overlay.hidden = false;
      if (!document.body.classList.contains("tool-page")) {
        document.body.style.overflow = "hidden";
      }
    }

    function closeModal() {
      overlay.hidden = true;
      document.body.style.overflow = "";
      currentToolId = null;
      currentFiles = [];
    }

    closeBtn.addEventListener("click", closeModal);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) closeModal(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !overlay.hidden) closeModal(); });

    document.querySelectorAll(".tool-card").forEach((card) => {
      card.addEventListener("click", () => openModal(card.dataset.tool));
    });

    const thumbCache = new WeakMap();

    function extLabel(name) {
      const m = /\.([a-z0-9]+)$/i.exec(name || "");
      return m ? m[1].toUpperCase() : "FILE";
    }

    function getThumbFor(file) {
      if (thumbCache.has(file)) return thumbCache.get(file);
      let promise;
      if (file.type && file.type.startsWith("image/")) {
        promise = Promise.resolve(URL.createObjectURL(file));
      } else if (file.type === "application/pdf" || /\.pdf$/i.test(file.name)) {
        promise = (async () => {
          try {
            const bytes = await file.arrayBuffer();
            const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
            const page = await pdf.getPage(1);
            const viewport = page.getViewport({ scale: 0.18 });
            const canvas = document.createElement("canvas");
            canvas.width = Math.max(1, Math.round(viewport.width));
            canvas.height = Math.max(1, Math.round(viewport.height));
            await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
            return canvas.toDataURL("image/jpeg", 0.6);
          } catch (e) { return null; }
        })();
      } else {
        promise = Promise.resolve(null);
      }
      thumbCache.set(file, promise);
      return promise;
    }

    // Peeks at the first bytes of a file to check it really looks like a PDF
    // before we hand it to a PDF-only tool — gives a much friendlier error
    // than a cryptic parser exception further down the line.
    async function looksLikePdf(file) {
      try {
        const head = await file.slice(0, 5).text();
        return head.startsWith("%PDF-");
      } catch (e) { return true; } // don't block on read errors, let the tool try
    }

    function renderFileList() {
      const tool = TOOLS[currentToolId];
      fileListEl.innerHTML = "";
      currentFiles.forEach((file, i) => {
        const row = document.createElement("div");
        row.className = "file-row";
        row.draggable = !!tool.multiple;

        const thumb = document.createElement("span");
        thumb.className = "file-row-thumb file-row-thumb--icon";
        thumb.textContent = extLabel(file.name);
        row.appendChild(thumb);
        getThumbFor(file).then((src) => {
          if (!src || !fileListEl.contains(row)) return;
          const img = document.createElement("img");
          img.className = "file-row-thumb";
          img.src = src;
          img.alt = "";
          row.replaceChild(img, thumb);
        });

        if (tool.multiple) {
          const grip = document.createElement("span");
          grip.className = "file-row-grip";
          grip.textContent = "⠿";
          grip.title = "Drag to reorder";
          row.appendChild(grip);
        }

        const nameEl = document.createElement("span");
        nameEl.className = "file-row-name";
        nameEl.textContent = file.name;
        row.appendChild(nameEl);

        const sizeEl = document.createElement("span");
        sizeEl.className = "file-row-size";
        sizeEl.textContent = fileSizeLabel(file.size);
        row.appendChild(sizeEl);

        if (tool.multiple) {
          const upBtn = document.createElement("button");
          upBtn.type = "button";
          upBtn.className = "file-row-btn";
          upBtn.title = "Move up";
          upBtn.setAttribute("aria-label", "Move " + file.name + " earlier in the list");
          upBtn.textContent = "↑";
          upBtn.addEventListener("click", () => {
            if (i === 0) return;
            [currentFiles[i - 1], currentFiles[i]] = [currentFiles[i], currentFiles[i - 1]];
            renderFileList();
          });
          row.appendChild(upBtn);

          const downBtn = document.createElement("button");
          downBtn.type = "button";
          downBtn.className = "file-row-btn";
          downBtn.title = "Move down";
          downBtn.setAttribute("aria-label", "Move " + file.name + " later in the list");
          downBtn.textContent = "↓";
          downBtn.addEventListener("click", () => {
            if (i === currentFiles.length - 1) return;
            [currentFiles[i + 1], currentFiles[i]] = [currentFiles[i], currentFiles[i + 1]];
            renderFileList();
          });
          row.appendChild(downBtn);
        }

        const removeBtn = document.createElement("button");
        removeBtn.type = "button";
        removeBtn.className = "file-row-btn file-row-remove";
        removeBtn.title = "Remove";
        removeBtn.setAttribute("aria-label", "Remove " + file.name);
        removeBtn.textContent = "✕";
        removeBtn.addEventListener("click", () => {
          currentFiles.splice(i, 1);
          renderFileList();
          updateRunState();
          statusEl.textContent = sizeWarningFor(currentFiles, currentToolId) || "";
        });
        row.appendChild(removeBtn);

        if (tool.multiple) {
          row.addEventListener("dragstart", (e) => {
            row.classList.add("dragging");
            e.dataTransfer.effectAllowed = "move";
            e.dataTransfer.setData("text/plain", String(i));
          });
          row.addEventListener("dragend", () => row.classList.remove("dragging"));
          row.addEventListener("dragover", (e) => { e.preventDefault(); row.classList.add("drag-over"); });
          row.addEventListener("dragleave", () => row.classList.remove("drag-over"));
          row.addEventListener("drop", (e) => {
            e.preventDefault();
            row.classList.remove("drag-over");
            const from = parseInt(e.dataTransfer.getData("text/plain"), 10);
            if (isNaN(from) || from === i) return;
            const [moved] = currentFiles.splice(from, 1);
            currentFiles.splice(i, 0, moved);
            renderFileList();
          });
        }

        fileListEl.appendChild(row);
      });
    }

    function updateRunState() {
      const tool = TOOLS[currentToolId];
      const ok = currentFiles.length >= (tool.minFiles || 1);
      runBtn.disabled = !ok;
      runBtn.textContent = ok ? "Run" : `Add at least ${tool.minFiles || 1} file${(tool.minFiles || 1) > 1 ? "s" : ""}`;
    }

    const SIZE_WARN_MB = 40;
    const HEAVY_TOOLS = new Set(["pdf-to-jpg", "upscale-image", "image-to-pdf", "merge-pdf", "compress-pdf", "remove-bg", "scan-to-pdf"]);

    function sizeWarningFor(files, toolId) {
      const totalMB = files.reduce((sum, f) => sum + f.size, 0) / (1024 * 1024);
      const biggestMB = Math.max(0, ...files.map((f) => f.size / (1024 * 1024)));
      if (totalMB < SIZE_WARN_MB && biggestMB < SIZE_WARN_MB) return null;
      const heavy = HEAVY_TOOLS.has(toolId);
      return `⚠️ ${totalMB.toFixed(0)} MB total.${heavy ? " This tool uses extra memory — a file this size may be slow or freeze the tab on lower-end devices." : " Large files can take a bit longer to process in the browser."} Everything still stays on your device.`;
    }

    function addFiles(fileList) {
      const tool = TOOLS[currentToolId];
      const incoming = Array.from(fileList);
      if (!tool.multiple) currentFiles = [];
      currentFiles = currentFiles.concat(incoming);
      renderFileList();
      updateRunState();
      const warning = sizeWarningFor(currentFiles, currentToolId);
      statusEl.textContent = warning || "";
      if (tool.buildDynamicUI && dynamicEl) {
        Promise.resolve(tool.buildDynamicUI(currentFiles, dynamicEl)).catch((e) => {
          console.error(e);
          dynamicEl.innerHTML = '<p class="dyn-hint">Couldn\'t load a preview for this file.</p>';
        });
      }
    }

    dropzone.addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", () => addFiles(fileInput.files));

    ["dragenter", "dragover"].forEach((evt) =>
      dropzone.addEventListener(evt, (e) => { e.preventDefault(); dropzone.classList.add("dropzone--active"); })
    );
    ["dragleave", "drop"].forEach((evt) =>
      dropzone.addEventListener(evt, (e) => { e.preventDefault(); dropzone.classList.remove("dropzone--active"); })
    );
    dropzone.addEventListener("drop", (e) => {
      if (e.dataTransfer.files && e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
    });

    function showProgress(current, total, label) {
      let wrap = statusEl.querySelector(".progress-wrap");
      if (!wrap) {
        statusEl.innerHTML =
          '<div class="progress-wrap"><div class="progress-label"><span class="progress-text"></span><span class="progress-pct"></span></div>' +
          '<div class="progress-track"><div class="progress-fill"></div></div></div>';
        wrap = statusEl.querySelector(".progress-wrap");
      }
      const pct = total ? Math.min(100, Math.round((current / total) * 100)) : 0;
      wrap.querySelector(".progress-text").textContent = label || (total > 1 ? `Processing ${current} of ${total}…` : "Working…");
      wrap.querySelector(".progress-pct").textContent = total > 1 ? `${pct}%` : "";
      wrap.querySelector(".progress-fill").style.width = pct + "%";
    }

    function renderResults(results, tool) {
      resultEl.innerHTML = "";
      if (results.length > 1) {
        const summary = document.createElement("p");
        summary.className = "result-summary";
        summary.textContent = `${results.length} files ready.`;
        resultEl.appendChild(summary);
      }
      results.forEach((r) => {
        const row = document.createElement("div");
        row.className = "result-row";
        const isText = r.blob.type === "text/markdown" || r.blob.type === "text/html" || r.blob.type === "text/plain";
        row.innerHTML = `<span>${r.name}</span>${isText ? '<button type="button" class="result-btn-copy">Copy</button>' : ""}<button type="button" class="btn btn-teal result-btn">Download</button>`;
        row.querySelector(".result-btn").addEventListener("click", () => download(r.name, r.blob));
        const copyBtn = row.querySelector(".result-btn-copy");
        if (copyBtn) {
          copyBtn.addEventListener("click", async () => {
            try {
              const text = await r.blob.text();
              await navigator.clipboard.writeText(text);
              copyBtn.textContent = "Copied!";
              setTimeout(() => { copyBtn.textContent = "Copy"; }, 1500);
            } catch (e) { copyBtn.textContent = "Couldn't copy"; }
          });
        }
        resultEl.appendChild(row);
      });
      const overBtn = document.createElement("button");
      overBtn.type = "button";
      overBtn.className = "start-over-btn";
      overBtn.textContent = "Start over";
      overBtn.addEventListener("click", () => {
        currentFiles = [];
        organizeState = null;
        formsState = null;
        renderFileList();
        updateRunState();
        resultEl.innerHTML = "";
        statusEl.textContent = "";
        fileInput.value = "";
        if (dynamicEl) dynamicEl.innerHTML = "";
      });
      resultEl.appendChild(overBtn);
    }

    runBtn.addEventListener("click", async () => {
      const tool = TOOLS[currentToolId];
      if (!tool || currentFiles.length < (tool.minFiles || 1)) return;

      if (tool.accept === "application/pdf") {
        for (const f of currentFiles) {
          if (!(await looksLikePdf(f))) {
            statusEl.textContent = `"${f.name}" doesn't look like a valid PDF file.`;
            return;
          }
        }
      }

      runBtn.disabled = true;
      resultEl.innerHTML = "";
      showProgress(0, currentFiles.length || 1, "Starting…");
      try {
        const opts = tool.readOpts ? tool.readOpts() : {};
        const onProgress = (current, total, label) => showProgress(current, total, label);
        const results = await tool.run(currentFiles, opts, onProgress);
        statusEl.textContent = "Done.";
        renderResults(results, tool);
      } catch (err) {
        console.error(err);
        statusEl.textContent = "Something went wrong: " + (err && err.message ? err.message : "please check the file and try again.");
      } finally {
        updateRunState();
      }
    });

    // Standalone tool page (e.g. merge-pdf.html): embed this tool's widget
    // directly in the page instead of as a popup overlay.
    const standaloneTool = document.body.dataset.tool;
    if (standaloneTool && TOOLS[standaloneTool]) {
      openModal(standaloneTool);
    }
  }

  } catch (err) {
    console.error("Tool widget failed to initialize:", err);
  }

})();
