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
  ──────────────────────────────────────────── */

  function extractCertificate() {
    const canvas = document.querySelector("canvas");
    if (!canvas) return null;
    try { return canvas.toDataURL("image/jpeg", 0.85); } catch { return null; }
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
     Exact DOM order:
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
      if (!docImg) continue;

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
     DOM-BASED HTML BUILDER
     Matches real apostille.mygov.bd page exactly:
       • No boxes or borders
       • Signatories displayed in a clean row
       • Each block: "Attested" (cursive) → sig image → date → name → titles
       • All text purple #4b0082
       • Fonts: "Noto Serif" for date/name/title (close to real page),
                "Dancing Script" for "Attested" cursive
         Both fall back to "Times New Roman" if fonts don't load.
  ──────────────────────────────────────────── */

  function buildHTMLDocument(filename, cert, blocks) {
    const doc = document.implementation.createHTMLDocument(filename);

    doc.head.innerHTML = `
<meta charset="utf-8">
<title></title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Dancing+Script:wght@600&family=Noto+Serif:wght@400;700&display=swap">
<style>
  @page { size: A4 portrait; margin: 10mm; }
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    font-family: "Noto Serif", "Times New Roman", serif;
    background: #fff;
    color: #4b0082;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }

  /* ── page wrapper ── */
  .page {
    width: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 4mm 0 6mm;
    page-break-after: always;
  }
  .page:last-child { page-break-after: avoid; }

  /* ── document image ── */
  .doc-img-wrap {
    width: 100%;
    text-align: center;
    margin-bottom: 8mm;
  }
  .doc-img-wrap img {
    max-width: 100%;
    max-height: 172mm;
    object-fit: contain;
  }
  .cert-img-wrap img {
    max-height: 272mm;
  }

  /* ── signatory grid: exactly 3 per row, wraps to next row automatically ── */
  .sig-row {
    width: 100%;
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 8mm 4mm;
    align-items: start;
  }

  /* ── one signatory block — no box, clean centered ── */
  .sig-block {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
  }

  /* "Attested" — cursive, exactly as on the real page */
  .attested-label {
    font-family: "Dancing Script", "Brush Script MT", "Times New Roman", cursive;
    font-size: 22pt;
    font-weight: 600;
    color: #4b0082;
    line-height: 1.2;
    margin-bottom: 2mm;
  }

  /* signature image */
  .sig-img {
    height: 45px;
    max-width: 100%;
    object-fit: contain;
    margin-bottom: 3mm;
  }

  /* date — bold, larger, matches the page heading style */
  .sig-date {
    font-family: "Noto Serif", "Times New Roman", serif;
    font-size: 13pt;
    font-weight: 700;
    color: #4b0082;
    margin-bottom: 1mm;
  }

  /* name — bold */
  .sig-name {
    font-family: "Noto Serif", "Times New Roman", serif;
    font-size: 11.5pt;
    font-weight: 700;
    color: #4b0082;
    margin-bottom: 0.5mm;
  }

  /* title / org lines — normal weight */
  .sig-title-line {
    font-family: "Noto Serif", "Times New Roman", serif;
    font-size: 10pt;
    font-weight: 400;
    color: #4b0082;
    line-height: 1.45;
  }
</style>`;

    doc.title = filename;

    // ── element helper ──
    function el(tag, cls, text) {
      const e = doc.createElement(tag);
      if (cls)  e.className   = cls;
      if (text !== undefined) e.textContent = text;
      return e;
    }

    // ── one signatory block ──
    // Exact order matches DOM: Attested → sig → date → name → title lines
    function makeSigBlock(s) {
      const block = el("div", "sig-block");

      // 1. "Attested" cursive  (H1 in real DOM)
      block.appendChild(el("div", "attested-label", s.attestedLabel || "Attested"));

      // 2. Signature image  (IMG immediately after H1)
      if (s.sigImg) {
        const img = doc.createElement("img");
        img.src       = s.sigImg;
        img.alt       = "signature";
        img.className = "sig-img";
        block.appendChild(img);
      }

      // 3. Date  (first P)
      if (s.date) block.appendChild(el("div", "sig-date", s.date));

      // 4. Name  (second P)
      if (s.name) block.appendChild(el("div", "sig-name", s.name));

      // 5. Title / org lines  (remaining P elements)
      s.titleLines.forEach(t => block.appendChild(el("div", "sig-title-line", t)));

      return block;
    }

    // ── one full page ──
    function makePage(imgSrc, signatories, isCert) {
      const page = el("div", "page");

      // document image
      const wrap = el("div", isCert ? "doc-img-wrap cert-img-wrap" : "doc-img-wrap");
      const img  = doc.createElement("img");
      img.src = imgSrc;
      img.alt = isCert ? "e-Apostille Certificate" : "document";
      wrap.appendChild(img);
      page.appendChild(wrap);

      // signatories row (cert page has none)
      if (!isCert && signatories && signatories.length > 0) {
        const row = el("div", "sig-row");
        signatories.forEach(s => row.appendChild(makeSigBlock(s)));
        page.appendChild(row);
      }

      return page;
    }

    // ── assemble ──
    if (cert) doc.body.appendChild(makePage(cert, [], true));
    blocks.forEach(b => doc.body.appendChild(makePage(b.img, b.signatories, false)));

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

    updateProgress("Ready — print dialog opening…");

    w.onload = () => {
      setTimeout(() => {
        w.print();
        updateProgress("Done ✓");
        setButtonState(false);
        isRunning = false;
      }, 400);
    };

    // Fallback if onload already fired
    setTimeout(() => {
      if (!isRunning) return;
      w.print();
      updateProgress("Done ✓");
      setButtonState(false);
      isRunning = false;
    }, 2200);
  }

  /* ────────────────────────────────────────────
     PANEL UI
  ──────────────────────────────────────────── */

  function addUI() {
    const panel = document.createElement("div");
    panel.id = "ultimate-panel";
    panel.innerHTML = `
      <div class="title">e-Apostille</div>
      <select id="ap-mode">
        <option value="normal">Normal quality</option>
        <option value="small">Small file</option>
        <option value="verysmall">Very small file</option>
      </select>
      <button id="run">Generate PDF</button>
      <div id="progressText">Idle</div>
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
