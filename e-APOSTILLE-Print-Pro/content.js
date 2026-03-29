(async function () {

  if (document.getElementById("ultimate-panel")) return;

  let compressionMode = "normal";
  let isRunning = false;

  const compressionSettings = {
    normal:    { scale: 0.9,  quality: 0.82 },
    small:     { scale: 0.75, quality: 0.68 },
    verysmall: { scale: 0.6,  quality: 0.55 }
  };

  /* ────────────────────────────────────────────
     HELPERS
  ──────────────────────────────────────────── */

  async function waitForImages() {
    const imgs = Array.from(document.querySelectorAll("img"));
    await Promise.all(imgs.map(img => {
      if (img.complete) return Promise.resolve();
      return new Promise(res => { img.onload = res; img.onerror = res; });
    }));
  }

  function updateProgress(text) {
    const el = document.getElementById("progressText");
    if (el) el.innerText = text;
  }

  function setButtonState(running) {
    const btn = document.getElementById("run");
    if (!btn) return;
    btn.disabled = running;
    btn.innerText = running ? "Processing…" : "Generate PDF";
  }

  function compressImage(src) {
    return new Promise(resolve => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        const { scale, quality } = compressionSettings[compressionMode];
        const c = document.createElement("canvas");
        c.width  = Math.max(1, Math.round(img.width  * scale));
        c.height = Math.max(1, Math.round(img.height * scale));
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL("image/jpeg", quality));
      };
      img.onerror = () => resolve(src);
      img.src = src;
    });
  }

  /* ────────────────────────────────────────────
     CERTIFICATE
     The canvas sometimes exists but is blank (tainted / not yet rendered).
     We validate it's non-blank by checking a centre pixel has non-zero alpha.
  ──────────────────────────────────────────── */

  function extractCertificate() {
    const canvas = document.querySelector("canvas");
    if (!canvas) return null;
    try {
      // Check canvas actually has content (not blank/tainted)
      const ctx = canvas.getContext("2d");
      if (ctx) {
        const px = ctx.getImageData(
          Math.floor(canvas.width / 2),
          Math.floor(canvas.height / 2),
          1, 1
        ).data;
        // If centre pixel is fully transparent or pure white → treat as blank
        const isBlank = (px[3] === 0) || (px[0] === 255 && px[1] === 255 && px[2] === 255 && px[3] === 255);
        if (isBlank) return null;
      }
      return canvas.toDataURL("image/jpeg", 0.85);
    } catch {
      return null;
    }
  }

  /* ────────────────────────────────────────────
     FLAT LEAF COLLECTOR
     Emits ordered: { type: "h1"|"img"|"text", value }
     Skips the main document preview image (id^="prevImg").
  ──────────────────────────────────────────── */

  function collectLeaves(root) {
    const leaves = [];

    function walk(node) {
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const tag = node.tagName.toUpperCase();

      if (tag === "IMG" && node.id && node.id.startsWith("prevImg")) return;

      if (tag === "H1") {
        const t = node.innerText.trim();
        if (t) leaves.push({ type: "h1", value: t });
        return;
      }

      if (tag === "IMG") {
        if (node.src) leaves.push({ type: "img", value: node.src });
        return;
      }

      if (node.children.length === 0) {
        const t = node.innerText?.trim();
        if (t) leaves.push({ type: "text", value: t });
        return;
      }

      Array.from(node.children).forEach(walk);
    }

    walk(root);
    return leaves;
  }

  /* ────────────────────────────────────────────
     SIGNATORY PARSER
     Exact DOM order per block:
       H1   "Attested"
       IMG  <signature>
       P    "09 Feb 2026"
       P    "Name"
       P    "Title"
       P    "Organisation"
       H1   "Attested"   ← next block
  ──────────────────────────────────────────── */

  function parseSignatories(leaves) {
    const out = [];
    let cur = null;

    for (let i = 0; i < leaves.length; i++) {
      const leaf = leaves[i];

      if (leaf.type === "h1") {
        cur = {
          attestedLabel: leaf.value,
          sigImg:        null,
          date:          "",
          name:          "",
          titleLines:    []
        };
        out.push(cur);

        // Immediately consume the signature image right after H1
        if (i + 1 < leaves.length && leaves[i + 1].type === "img") {
          cur.sigImg = leaves[i + 1].value;
          i++;
        }
        continue;
      }

      if (!cur) continue;

      if (leaf.type === "img") {
        if (!cur.sigImg) cur.sigImg = leaf.value;
        continue;
      }

      if (leaf.type === "text") {
        if      (!cur.date) cur.date = leaf.value;
        else if (!cur.name) cur.name = leaf.value;
        else                cur.titleLines.push(leaf.value);
      }
    }

    return out;
  }

  /* ────────────────────────────────────────────
     EXTRACT ALL DOCUMENT BLOCKS
  ──────────────────────────────────────────── */

  async function extractBlocks() {
    const containers = document.querySelectorAll("div[id^='prevImgDiv']");
    const results    = [];
    let   n          = 0;

    for (const div of containers) {
      const docImg = div.querySelector("img[id^='prevImg']");
      // FIX: skip containers with no actual document image → no empty pages
      if (!docImg || !docImg.src || docImg.src === window.location.href) continue;

      n++;
      updateProgress(`Processing document ${n} / ${containers.length}…`);

      const leaves      = collectLeaves(div);
      const signatories = parseSignatories(leaves);
      const compressed  = await compressImage(docImg.src);

      results.push({ img: compressed, signatories });
    }

    return results;
  }

  /* ────────────────────────────────────────────
     FILE NAME
  ──────────────────────────────────────────── */

  function getFileName() {
    const text = document.body.innerText;
    const specific = text.match(/(?:Apostille|Certificate)\s+No\.?\s*([0-9]+)/i);
    if (specific) return `Apostille_${specific[1]}.pdf`;
    const fallback = text.match(/N[oº°]\.?\s*([0-9]+)/);
    if (fallback) return `Apostille_${fallback[1]}.pdf`;
    return "Apostille.pdf";
  }

  /* ────────────────────────────────────────────
     HTML BUILDER
  ──────────────────────────────────────────── */

  function buildHTMLDocument(filename, cert, blocks) {
    const doc = document.implementation.createHTMLDocument(filename);

    doc.head.innerHTML = `
<meta charset="utf-8">
<title></title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Dancing+Script:wght@600&family=Noto+Serif:ital,wght@0,400;0,700;1,400&display=swap">
<style>
  /* ── print setup ── */
  @page { size: A4 portrait; margin: 12mm 10mm; }
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    font-family: "Noto Serif", "Times New Roman", serif;
    background: #fff;
    color: #4b0082;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }

  /* ── page wrapper ──
     KEY FIX: use break-after instead of page-break-after,
     and only apply it between pages, not after the last one.
     We also use display:block so height is determined by content
     — no empty space that causes a phantom blank page.
  ── */
  .page {
    width: 100%;
    display: block;
    break-after: page;
    padding-bottom: 6mm;
  }
  .page:last-child {
    break-after: avoid;
  }

  /* ── certificate page ── */
  .cert-page {
    width: 100%;
    text-align: center;
  }
  .cert-page img {
    max-width: 100%;
    max-height: 260mm;
    object-fit: contain;
  }

  /* ── document image ── */
  .doc-img-wrap {
    width: 100%;
    text-align: center;
    margin-bottom: 7mm;
  }
  .doc-img-wrap img {
    max-width: 100%;
    max-height: 168mm;
    object-fit: contain;
  }

  /* ── signatory grid: exactly 3 columns, wraps to next row ── */
  .sig-row {
    width: 100%;
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 7mm 3mm;
    align-items: start;
  }

  /* ── one signatory — no box, clean centred ── */
  .sig-block {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
  }

  /* "Attested" / "Verified and found correct" cursive */
  .attested-label {
    font-family: "Dancing Script", "Brush Script MT", cursive;
    font-size: 20pt;
    font-weight: 600;
    color: #4b0082;
    line-height: 1.15;
    margin-bottom: 1.5mm;
  }

  /* signature image */
  .sig-img {
    height: 44px;
    max-width: 100%;
    object-fit: contain;
    margin-bottom: 2.5mm;
  }

  /* date */
  .sig-date {
    font-family: "Noto Serif", "Times New Roman", serif;
    font-size: 12.5pt;
    font-weight: 700;
    color: #4b0082;
    margin-bottom: 1mm;
  }

  /* name */
  .sig-name {
    font-family: "Noto Serif", "Times New Roman", serif;
    font-size: 11pt;
    font-weight: 700;
    color: #4b0082;
    margin-bottom: 0.5mm;
  }

  /* title / org lines */
  .sig-title-line {
    font-family: "Noto Serif", "Times New Roman", serif;
    font-size: 9.5pt;
    font-weight: 400;
    color: #4b0082;
    line-height: 1.4;
  }

  /* ── footer credit ── */
  .footer-credit {
    width: 100%;
    text-align: center;
    margin-top: 10mm;
    padding-top: 3mm;
    border-top: 1px solid #d0b8f0;
    font-family: "Noto Serif", "Times New Roman", serif;
    font-size: 7.5pt;
    color: #9370bb;
    letter-spacing: 0.3px;
  }
  .footer-credit a {
    color: #7b3fa8;
    text-decoration: none;
  }
</style>`;

    doc.title = filename;

    function el(tag, cls, text) {
      const e = doc.createElement(tag);
      if (cls)  e.className = cls;
      if (text !== undefined) e.textContent = text;
      return e;
    }

    /* ── signatory block ── */
    function makeSigBlock(s) {
      const block = el("div", "sig-block");

      // 1. Attested label (H1 in DOM)
      block.appendChild(el("div", "attested-label", s.attestedLabel || "Attested"));

      // 2. Signature image (IMG right after H1)
      if (s.sigImg) {
        const img = doc.createElement("img");
        img.src = s.sigImg;
        img.alt = "signature";
        img.className = "sig-img";
        block.appendChild(img);
      }

      // 3. Date (first P)
      if (s.date) block.appendChild(el("div", "sig-date", s.date));

      // 4. Name (second P)
      if (s.name) block.appendChild(el("div", "sig-name", s.name));

      // 5. Title / org lines (remaining P)
      s.titleLines.forEach(t => block.appendChild(el("div", "sig-title-line", t)));

      return block;
    }

    /* ── certificate page — only added if cert data is valid ── */
    if (cert) {
      const certPage = el("div", "page");
      const certWrap = el("div", "cert-page");
      const certImg  = doc.createElement("img");
      certImg.src = cert;
      certImg.alt = "e-Apostille Certificate";
      certWrap.appendChild(certImg);
      certPage.appendChild(certWrap);
      doc.body.appendChild(certPage);
    }

    /* ── document pages ── */
    blocks.forEach((b, idx) => {
      const page = el("div", "page");

      // Document image
      const wrap = el("div", "doc-img-wrap");
      const img  = doc.createElement("img");
      img.src = b.img;
      img.alt = "document";
      wrap.appendChild(img);
      page.appendChild(wrap);

      // Signatories grid
      if (b.signatories && b.signatories.length > 0) {
        const row = el("div", "sig-row");
        b.signatories.forEach(s => row.appendChild(makeSigBlock(s)));
        page.appendChild(row);
      }
      
      doc.body.appendChild(page);
    });

    return doc;
  }

  /* ────────────────────────────────────────────
     BUILD PREVIEW + PRINT
  ──────────────────────────────────────────── */

  async function buildPreview() {
    const w = window.open("", "_blank");
    if (!w) {
      updateProgress("⚠ Popup blocked — allow popups and retry");
      setButtonState(false);
      isRunning = false;
      return;
    }

    updateProgress("Extracting certificate…");
    const cert = extractCertificate();

    updateProgress("Processing documents…");
    const blocks = await extractBlocks();

    if (!cert && blocks.length === 0) {
      updateProgress("⚠ Nothing found to export");
      w.close();
      setButtonState(false);
      isRunning = false;
      return;
    }

    updateProgress("Building PDF…");
    const filename = getFileName();

    const builtDoc   = buildHTMLDocument(filename, cert, blocks);
    const serializer = new XMLSerializer();
    const html       = serializer.serializeToString(builtDoc);

    w.document.open();
    w.document.write(html);
    w.document.close();
    w.focus();

    updateProgress("Ready — opening print dialog…");

    w.onload = () => {
      setTimeout(() => {
        w.print();
        updateProgress("Done ✓");
        setButtonState(false);
        isRunning = false;
      }, 600);
    };

    // Fallback if onload already fired (about:blank)
    setTimeout(() => {
      if (!isRunning) return;
      w.print();
      updateProgress("Done ✓");
      setButtonState(false);
      isRunning = false;
    }, 2500);
  }

  /* ────────────────────────────────────────────
     PANEL UI
  ──────────────────────────────────────────── */

  function addUI() {
    const panel = document.createElement("div");
    panel.id = "ultimate-panel";
    panel.innerHTML = `
      <div class="ap-logo">📄</div>
      <div class="ap-title">e-Apostille</div>
      <div class="ap-sub">PDF Generator</div>
      <div class="ap-divider"></div>
      <label class="ap-label">Quality</label>
      <select id="ap-mode">
        <option value="normal">Normal (recommended)</option>
        <option value="small">Small file</option>
        <option value="verysmall">Very small file</option>
      </select>
      <button id="run">Generate PDF</button>
      <div id="progressText" class="ap-progress">Idle</div>
      <div class="ap-credit">by <a href="https://github.com/0mehedihasan" target="_blank">github/0mehedihasan</a></div>
    `;
    document.body.appendChild(panel);

    document.getElementById("ap-mode").onchange = e => {
      compressionMode = e.target.value;
    };

    document.getElementById("run").onclick = async () => {
      if (isRunning) return;
      isRunning = true;
      setButtonState(true);
      updateProgress("Waiting for images…");
      try {
        await waitForImages();
        await buildPreview();
      } catch (err) {
        console.error("[e-Apostille]", err);
        updateProgress("⚠ Error — see console");
        setButtonState(false);
        isRunning = false;
      }
    };
  }

  addUI();

})();
