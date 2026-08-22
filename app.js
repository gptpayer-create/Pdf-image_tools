/* gptpayer — all processing happens locally in the browser. No file is uploaded anywhere. */
(function () {
  "use strict";

  // pdf.js worker
  if (window.pdfjsLib) {
    pdfjsLib.GlobalWorkerOptions.workerSrc =
      "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
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

  /* ---------------- PDF tool functions ---------------- */

  async function pdfMerge(files) {
    const { PDFDocument } = PDFLib;
    const out = await PDFDocument.create();
    for (const file of files) {
      const bytes = await file.arrayBuffer();
      const src = await PDFDocument.load(bytes);
      const pages = await out.copyPages(src, src.getPageIndices());
      pages.forEach((p) => out.addPage(p));
    }
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

  async function pdfCompress(files) {
    const { PDFDocument } = PDFLib;
    const file = files[0];
    const bytes = await file.arrayBuffer();
    const src = await PDFDocument.load(bytes);
    const outBytes = await src.save({ useObjectStreams: true });
    return [{ name: file.name.replace(/\.pdf$/i, "") + "-compressed.pdf", blob: new Blob([outBytes], { type: "application/pdf" }) }];
  }

  async function pdfRotate(files, opts) {
    const { PDFDocument, degrees } = PDFLib;
    const file = files[0];
    const bytes = await file.arrayBuffer();
    const doc = await PDFDocument.load(bytes);
    const add = parseInt(opts.angle, 10) || 90;
    doc.getPages().forEach((page) => {
      const current = page.getRotation().angle || 0;
      page.setRotation(degrees((current + add) % 360));
    });
    const outBytes = await doc.save();
    return [{ name: file.name.replace(/\.pdf$/i, "") + "-rotated.pdf", blob: new Blob([outBytes], { type: "application/pdf" }) }];
  }

  async function pdfToJpg(files, opts) {
    const file = files[0];
    const quality = (parseInt(opts.quality, 10) || 85) / 100;
    const bytes = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
    const outputs = [];
    for (let i = 1; i <= pdf.numPages; i++) {
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

  async function pdfAddPageNumbers(files) {
    const { PDFDocument, rgb, StandardFonts } = PDFLib;
    const file = files[0];
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
    return [{ name: file.name.replace(/\.pdf$/i, "") + "-numbered.pdf", blob: new Blob([outBytes], { type: "application/pdf" }) }];
  }

  async function pdfWatermark(files, opts) {
    const { PDFDocument, rgb, degrees, StandardFonts } = PDFLib;
    const file = files[0];
    const bytes = await file.arrayBuffer();
    const doc = await PDFDocument.load(bytes);
    const font = await doc.embedFont(StandardFonts.HelveticaBold);
    const opacity = (parseInt(opts.opacity, 10) || 30) / 100;
    const text = opts.text || "gptpayer";
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
    return [{ name: file.name.replace(/\.pdf$/i, "") + "-watermarked.pdf", blob: new Blob([outBytes], { type: "application/pdf" }) }];
  }

  async function pdfCrop(files, opts) {
    const { PDFDocument } = PDFLib;
    const file = files[0];
    const bytes = await file.arrayBuffer();
    const doc = await PDFDocument.load(bytes);
    const top = parseFloat(opts.top) || 0, right = parseFloat(opts.right) || 0;
    const bottom = parseFloat(opts.bottom) || 0, left = parseFloat(opts.left) || 0;
    doc.getPages().forEach((page) => {
      const { width, height } = page.getSize();
      const w = Math.max(10, width - left - right);
      const h = Math.max(10, height - top - bottom);
      page.setCropBox(left, bottom, w, h);
    });
    const outBytes = await doc.save();
    return [{ name: file.name.replace(/\.pdf$/i, "") + "-cropped.pdf", blob: new Blob([outBytes], { type: "application/pdf" }) }];
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

  /* ---------------- Image tool functions ---------------- */

  async function imageCompress(files, opts) {
    const file = files[0];
    const quality = (parseInt(opts.quality, 10) || 75) / 100;
    const bitmap = await loadImageBitmap(file);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext("2d").drawImage(bitmap, 0, 0);
    const blob = await canvasToBlob(canvas, "image/jpeg", quality);
    return [{ name: file.name.replace(/\.[^.]+$/, "") + "-compressed.jpg", blob }];
  }

  async function imageResize(files, opts) {
    const file = files[0];
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
    return [{ name: file.name.replace(/\.[^.]+$/, "") + `-${w}x${h}.${extFor(mime)}`, blob }];
  }

  async function imageConvert(files, opts) {
    const file = files[0];
    const targetMime = opts.format || "image/png";
    const bitmap = await loadImageBitmap(file);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext("2d").drawImage(bitmap, 0, 0);
    const blob = await canvasToBlob(canvas, targetMime, 0.92);
    return [{ name: file.name.replace(/\.[^.]+$/, "") + "." + extFor(targetMime), blob }];
  }

  async function imageCrop(files, opts) {
    const file = files[0];
    const bitmap = await loadImageBitmap(file);
    const x = Math.max(0, parseInt(opts.x, 10) || 0);
    const y = Math.max(0, parseInt(opts.y, 10) || 0);
    const w = Math.min(bitmap.width - x, parseInt(opts.w, 10) || bitmap.width);
    const h = Math.min(bitmap.height - y, parseInt(opts.h, 10) || bitmap.height);
    if (w <= 0 || h <= 0) throw new Error("Crop area is outside the image bounds.");
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    canvas.getContext("2d").drawImage(bitmap, x, y, w, h, 0, 0, w, h);
    const mime = file.type && file.type.startsWith("image/") ? file.type : "image/png";
    const blob = await canvasToBlob(canvas, mime, 0.92);
    return [{ name: file.name.replace(/\.[^.]+$/, "") + "-cropped." + extFor(mime), blob }];
  }

  async function imageRotate(files, opts) {
    const file = files[0];
    const angle = parseInt(opts.angle, 10) || 90;
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
    return [{ name: file.name.replace(/\.[^.]+$/, "") + "-rotated." + extFor(mime), blob }];
  }

  async function imageWatermark(files, opts) {
    const file = files[0];
    const text = opts.text || "gptpayer";
    const opacity = (parseInt(opts.opacity, 10) || 50) / 100;
    const position = opts.position || "bottom-right";
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
    return [{ name: file.name.replace(/\.[^.]+$/, "") + "-watermarked." + extFor(mime), blob }];
  }

  async function imageUpscale(files, opts) {
    const file = files[0];
    const factor = parseInt(opts.factor, 10) || 2;
    const bitmap = await loadImageBitmap(file);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width * factor;
    canvas.height = bitmap.height * factor;
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const mime = file.type && file.type.startsWith("image/") ? file.type : "image/png";
    const blob = await canvasToBlob(canvas, mime, 0.92);
    return [{ name: file.name.replace(/\.[^.]+$/, "") + `-${factor}x.` + extFor(mime), blob }];
  }

  async function imageMeme(files, opts) {
    const file = files[0];
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
    return [{ name: file.name.replace(/\.[^.]+$/, "") + "-meme." + extFor(mime), blob }];
  }

  async function imagePhotoEditor(files, opts) {
    const file = files[0];
    const bitmap = await loadImageBitmap(file);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d");
    const brightness = opts.brightness || 100;
    const contrast = opts.contrast || 100;
    const saturate = opts.saturate || 100;
    ctx.filter = `brightness(${brightness}%) contrast(${contrast}%) saturate(${saturate}%)`;
    ctx.drawImage(bitmap, 0, 0);
    const mime = file.type && file.type.startsWith("image/") ? file.type : "image/png";
    const blob = await canvasToBlob(canvas, mime, 0.92);
    return [{ name: file.name.replace(/\.[^.]+$/, "") + "-edited." + extFor(mime), blob }];
  }

  async function imageBlurArea(files, opts) {
    const file = files[0];
    const bitmap = await loadImageBitmap(file);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0);

    const blurPx = parseInt(opts.strength, 10) || 16;
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
    if (w <= 0 || h <= 0) throw new Error("Blur area is outside the image bounds.");
    ctx.drawImage(temp, x, y, w, h, x, y, w, h);

    const mime = file.type && file.type.startsWith("image/") ? file.type : "image/png";
    const blob = await canvasToBlob(canvas, mime, 0.92);
    return [{ name: file.name.replace(/\.[^.]+$/, "") + "-blurred." + extFor(mime), blob }];
  }

  async function imageToPdf(files) {
    const { PDFDocument } = PDFLib;
    const out = await PDFDocument.create();
    for (const file of files) {
      const bitmap = await loadImageBitmap(file);
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
      title: "Compress PDF", sub: "Re-package the file to reduce size. Best on text-heavy PDFs.",
      accept: "application/pdf", multiple: false, minFiles: 1,
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
      title: "Rotate PDF", sub: "Rotate every page by a fixed angle.",
      accept: "application/pdf", multiple: false, minFiles: 1,
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
      title: "Compress Image", sub: "Lower the quality slider for a smaller JPG.",
      accept: "image/*", multiple: false, minFiles: 1,
      options: () => `<label class="opt-label">Quality <input type="range" min="10" max="95" value="75" id="opt-quality" class="opt-range"></label>`,
      readOpts: () => ({ quality: $("#opt-quality").value }),
      run: imageCompress,
    },
    "resize-image": {
      title: "Resize Image", sub: "Set exact pixel dimensions.",
      accept: "image/*", multiple: false, minFiles: 1,
      options: () => `
        <label class="opt-label">Width (px) <input type="number" min="1" id="opt-width" class="opt-input" placeholder="e.g. 1200"></label>
        <label class="opt-label">Height (px) <input type="number" min="1" id="opt-height" class="opt-input" placeholder="e.g. 800"></label>
        <label class="opt-check"><input type="checkbox" id="opt-lock" checked> Keep aspect ratio</label>`,
      readOpts: () => ({ width: $("#opt-width").value, height: $("#opt-height").value, lock: $("#opt-lock").checked ? "on" : "off", changed: $("#opt-width").value ? "width" : "height" }),
      run: imageResize,
    },
    "convert-image": {
      title: "Convert Image", sub: "Switch the file format.",
      accept: "image/*", multiple: false, minFiles: 1,
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
      title: "Crop Image", sub: "Enter the crop box in pixels (top-left origin).",
      accept: "image/*", multiple: false, minFiles: 1,
      options: () => `
        <label class="opt-label">X <input type="number" min="0" value="0" id="opt-x" class="opt-input"></label>
        <label class="opt-label">Y <input type="number" min="0" value="0" id="opt-y" class="opt-input"></label>
        <label class="opt-label">Width <input type="number" min="1" id="opt-w" class="opt-input" placeholder="px"></label>
        <label class="opt-label">Height <input type="number" min="1" id="opt-h" class="opt-input" placeholder="px"></label>`,
      readOpts: () => ({ x: $("#opt-x").value, y: $("#opt-y").value, w: $("#opt-w").value, h: $("#opt-h").value }),
      run: imageCrop,
    },
    "image-to-pdf": {
      title: "Image to PDF", sub: "Add one or more images, drag to reorder, then build the PDF.",
      accept: "image/*", multiple: true, minFiles: 1,
      run: imageToPdf,
    },
    "rotate-image": {
      title: "Rotate Image", sub: "Rotate by a fixed angle.",
      accept: "image/*", multiple: false, minFiles: 1,
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
      title: "Watermark Image", sub: "Stamp text across your image.",
      accept: "image/*", multiple: false, minFiles: 1,
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
      title: "Add Page Numbers", sub: "Stamps \"page / total\" at the bottom of every page.",
      accept: "application/pdf", multiple: false, minFiles: 1,
      run: pdfAddPageNumbers,
    },
    "pdf-watermark": {
      title: "Add Watermark", sub: "Diagonal text watermark across every page.",
      accept: "application/pdf", multiple: false, minFiles: 1,
      options: () => `
        <label class="opt-label">Text <input type="text" id="opt-text" class="opt-input" value="gptpayer" maxlength="40"></label>
        <label class="opt-label">Opacity <input type="range" min="10" max="80" value="30" id="opt-opacity" class="opt-range"></label>`,
      readOpts: () => ({ text: $("#opt-text").value, opacity: $("#opt-opacity").value }),
      run: pdfWatermark,
    },
    "crop-pdf": {
      title: "Crop PDF", sub: "Trim a fixed margin (in points) off every page.",
      accept: "application/pdf", multiple: false, minFiles: 1,
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
      title: "Redact PDF", sub: "Black out a rectangular region on one page, permanently.",
      accept: "application/pdf", multiple: false, minFiles: 1,
      options: () => `
        <label class="opt-label">Page number <input type="number" min="1" value="1" id="opt-page" class="opt-input"></label>
        <label class="opt-label">X (pt from left) <input type="number" min="0" value="50" id="opt-x" class="opt-input"></label>
        <label class="opt-label">Y (pt from bottom) <input type="number" min="0" value="700" id="opt-y" class="opt-input"></label>
        <label class="opt-label">Width (pt) <input type="number" min="1" value="150" id="opt-w" class="opt-input"></label>
        <label class="opt-label">Height (pt) <input type="number" min="1" value="30" id="opt-h" class="opt-input"></label>`,
      readOpts: () => ({ page: $("#opt-page").value, x: $("#opt-x").value, y: $("#opt-y").value, w: $("#opt-w").value, h: $("#opt-h").value }),
      run: pdfRedact,
    },
    "upscale-image": {
      title: "Upscale", sub: "Simple pixel upscale (2× or 4×) — not an AI upscaler, so very low-res sources will still look soft.",
      accept: "image/*", multiple: false, minFiles: 1,
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
      title: "Meme Generator", sub: "Classic top and bottom caption text.",
      accept: "image/*", multiple: false, minFiles: 1,
      options: () => `
        <label class="opt-label">Top text <input type="text" id="opt-top" class="opt-input" maxlength="60"></label>
        <label class="opt-label">Bottom text <input type="text" id="opt-bottom" class="opt-input" maxlength="60"></label>`,
      readOpts: () => ({ top: $("#opt-top").value, bottom: $("#opt-bottom").value }),
      run: imageMeme,
    },
    "photo-editor": {
      title: "Photo Editor", sub: "Adjust brightness, contrast and saturation.",
      accept: "image/*", multiple: false, minFiles: 1,
      options: () => `
        <label class="opt-label">Brightness <input type="range" min="40" max="160" value="100" id="opt-brightness" class="opt-range"></label>
        <label class="opt-label">Contrast <input type="range" min="40" max="160" value="100" id="opt-contrast" class="opt-range"></label>
        <label class="opt-label">Saturation <input type="range" min="0" max="200" value="100" id="opt-saturate" class="opt-range"></label>`,
      readOpts: () => ({ brightness: $("#opt-brightness").value, contrast: $("#opt-contrast").value, saturate: $("#opt-saturate").value }),
      run: imagePhotoEditor,
    },
    "blur-area": {
      title: "Blur Area", sub: "Blur a face or any region — enter the box manually (no automatic face detection).",
      accept: "image/*", multiple: false, minFiles: 1,
      options: () => `
        <label class="opt-label">X (px) <input type="number" min="0" value="0" id="opt-x" class="opt-input"></label>
        <label class="opt-label">Y (px) <input type="number" min="0" value="0" id="opt-y" class="opt-input"></label>
        <label class="opt-label">Width (px) <input type="number" min="1" value="150" id="opt-w" class="opt-input"></label>
        <label class="opt-label">Height (px) <input type="number" min="1" value="150" id="opt-h" class="opt-input"></label>
        <label class="opt-label">Strength <input type="range" min="4" max="40" value="16" id="opt-strength" class="opt-range"></label>`,
      readOpts: () => ({ x: $("#opt-x").value, y: $("#opt-y").value, w: $("#opt-w").value, h: $("#opt-h").value, strength: $("#opt-strength").value }),
      run: imageBlurArea,
    },

    "pdf-to-word": { title: "PDF to Word", sub: "This needs a document-conversion engine we don't run in the browser yet.", comingSoon: true },
    "protect-pdf": { title: "Protect PDF", sub: "Real password encryption needs a crypto library we haven't wired in yet.", comingSoon: true },
    "edit-pdf": { title: "Edit PDF", sub: "A full page editor is on the roadmap.", comingSoon: true },
    "remove-bg": { title: "Remove Background", sub: "This needs an on-device AI model we haven't wired in yet.", comingSoon: true },
    "organize-pdf": { title: "Organize PDF", sub: "A drag-to-reorder page view is on the roadmap.", comingSoon: true },
    "scan-to-pdf": { title: "Scan to PDF", sub: "Camera capture and auto edge-detection isn't wired in yet.", comingSoon: true },
    "repair-pdf": { title: "Repair PDF", sub: "Fixing corrupted PDF structure needs a heavier repair engine.", comingSoon: true },
    "ocr-pdf": { title: "OCR PDF", sub: "Text recognition on scanned pages is on the roadmap.", comingSoon: true },
    "word-to-pdf": { title: "Word to PDF", sub: "Rendering .docx layout accurately needs a conversion engine we don't run in the browser yet.", comingSoon: true },
    "ppt-to-pdf": { title: "PowerPoint to PDF", sub: "Same story as Word to PDF — needs a real conversion engine.", comingSoon: true },
    "pdf-to-ppt": { title: "PDF to PowerPoint", sub: "Rebuilding editable slides from a PDF needs a real conversion engine.", comingSoon: true },
    "excel-to-pdf": { title: "Excel to PDF", sub: "Needs a spreadsheet-rendering engine we haven't wired in yet.", comingSoon: true },
    "pdf-to-excel": { title: "PDF to Excel", sub: "Reliable table extraction is on the roadmap.", comingSoon: true },
    "html-to-pdf": { title: "HTML to PDF", sub: "Rendering arbitrary pages needs a headless browser we don't run client-side.", comingSoon: true },
    "pdf-to-pdfa": { title: "PDF to PDF/A", sub: "Archival-format conversion is on the roadmap.", comingSoon: true },
    "pdf-forms": { title: "PDF Forms", sub: "Detecting and filling form fields is on the roadmap.", comingSoon: true },
    "unlock-pdf": { title: "Unlock PDF", sub: "Removing PDF encryption needs a crypto library we haven't wired in yet.", comingSoon: true },
    "compare-pdf": { title: "Compare PDF", sub: "Side-by-side diffing is on the roadmap.", comingSoon: true },
    "ai-summarizer": { title: "AI Summarizer", sub: "This needs a connected AI model — not something we run fully offline in your browser.", comingSoon: true },
    "translate-pdf": { title: "Translate PDF", sub: "Needs a connected translation model.", comingSoon: true },
    "pdf-to-markdown": { title: "PDF to Markdown", sub: "Clean structure extraction is on the roadmap.", comingSoon: true },
    "html-to-image": { title: "HTML to Image", sub: "Rendering arbitrary pages needs a headless browser we don't run client-side.", comingSoon: true },
  };

  /* ---------------- modal state & wiring ---------------- */
  /* Guarded: privacy.html / terms.html / 404.html include app.js for the
     hamburger menu but don't have the tool-modal markup on the page. */

  const overlay = $("#modal-overlay");

  if (overlay) {
    const modalTitle = $("#modal-title");
    const modalSub = $("#modal-sub");
    const dropzone = $("#dropzone");
    const fileInput = $("#file-input");
    const fileListEl = $("#file-list");
    const optionsEl = $("#tool-options");
    const runBtn = $("#modal-run");
    const statusEl = $("#modal-status");
    const resultEl = $("#modal-result");
    const closeBtn = $("#modal-close");

    let currentToolId = null;
    let currentFiles = [];

    function openModal(toolId) {
      const tool = TOOLS[toolId];
      if (!tool) return;
      currentToolId = toolId;
      currentFiles = [];
      modalTitle.textContent = tool.title;
      modalSub.textContent = tool.sub;
      fileListEl.innerHTML = "";
      optionsEl.innerHTML = tool.comingSoon ? "" : (tool.options ? tool.options() : "");
      resultEl.innerHTML = "";
      statusEl.textContent = "";
      fileInput.value = "";
      fileInput.multiple = !!tool.multiple;
      fileInput.accept = tool.accept || "";
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
      document.body.style.overflow = "hidden";
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

    function renderFileList() {
      const tool = TOOLS[currentToolId];
      fileListEl.innerHTML = "";
      currentFiles.forEach((file, i) => {
        const row = document.createElement("div");
        row.className = "file-row";
        row.innerHTML = `
          <span class="file-row-name">${file.name}</span>
          <span class="file-row-size">${fileSizeLabel(file.size)}</span>
          ${tool.multiple ? `
            <button type="button" class="file-row-btn" data-act="up" title="Move up">↑</button>
            <button type="button" class="file-row-btn" data-act="down" title="Move down">↓</button>` : ""}
          <button type="button" class="file-row-btn file-row-remove" data-act="remove" title="Remove">✕</button>`;
        row.querySelector('[data-act="remove"]').addEventListener("click", () => {
          currentFiles.splice(i, 1);
          renderFileList();
          updateRunState();
          statusEl.textContent = sizeWarningFor(currentFiles, currentToolId) || "";
        });
        if (tool.multiple) {
          row.querySelector('[data-act="up"]').addEventListener("click", () => {
            if (i === 0) return;
            [currentFiles[i - 1], currentFiles[i]] = [currentFiles[i], currentFiles[i - 1]];
            renderFileList();
          });
          row.querySelector('[data-act="down"]').addEventListener("click", () => {
            if (i === currentFiles.length - 1) return;
            [currentFiles[i + 1], currentFiles[i]] = [currentFiles[i], currentFiles[i + 1]];
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
    const HEAVY_TOOLS = new Set(["pdf-to-jpg", "upscale-image", "image-to-pdf", "merge-pdf", "compress-pdf"]);

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

    runBtn.addEventListener("click", async () => {
      const tool = TOOLS[currentToolId];
      if (!tool || currentFiles.length < (tool.minFiles || 1)) return;
      runBtn.disabled = true;
      statusEl.textContent = "Working…";
      resultEl.innerHTML = "";
      try {
        const opts = tool.readOpts ? tool.readOpts() : {};
        const results = await tool.run(currentFiles, opts);
        statusEl.textContent = "Done.";
        results.forEach((r) => {
          const row = document.createElement("div");
          row.className = "result-row";
          row.innerHTML = `<span>${r.name}</span><button type="button" class="btn btn-teal result-btn">Download</button>`;
          row.querySelector(".result-btn").addEventListener("click", () => download(r.name, r.blob));
          resultEl.appendChild(row);
        });
      } catch (err) {
        console.error(err);
        statusEl.textContent = "Something went wrong: " + (err && err.message ? err.message : "please check the file and try again.");
      } finally {
        updateRunState();
      }
    });
  }

  /* ---------------- mobile nav (works on every page) ---------------- */
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
})();
