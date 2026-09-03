(() => {
  const $ = (id) => document.getElementById(id);
  const state = {
    ediRows: [],
    hhtRows: [],
    scanIndex: new Map(),
    dmpIndex: new Map(),
    results: [],
    filtered: [],
    page: 1,
    pageSize: 100,
  };

  const CATEGORY_INFO = {
    "1-SCAN":       { label: "Flag 1 + Scan",        tone: "ok",   suggest: "Valid. Tidak ada aksi." },
    "1-NOSCAN":     { label: "Flag 1 + Tidak scan",  tone: "info", suggest: "Cek ketersediaan barcode di toko." },
    "0-SCAN":       { label: "Flag 0 + Scan",        tone: "warn", suggest: "Titik validasi salah / fiktif barcode. Cocokan LongLat & alamat." },
    "0-NOSCAN":     { label: "Flag 0 + Tidak scan",  tone: "warn", suggest: "Mungkin tidak dikunjungi. Validasi ulang." },
    "BLANK-SCAN":   { label: "Blank + Scan",         tone: "info", suggest: "Scan barcode untuk memvalidasi." },
    "BLANK-NOSCAN": { label: "Blank + Tidak scan",   tone: "bad",  suggest: "Cek ulang keberadaan toko." },
  };

  const CONSISTENCY_INFO = {
    "SINGLE":  { label: "1 kunjungan",       hint: "Outlet hanya dikunjungi sekali di periode ini — konsistensi tidak dapat dinilai." },
    "VALID":   { label: "Konsisten Valid",   hint: "Semua kunjungan outlet ini IN RADIUS." },
    "PROBLEM": { label: "Konsisten Bermasalah", hint: "Semua kunjungan outlet ini OUT RADIUS atau belum validasi." },
    "MIXED":   { label: "⚠ Inkonsisten",     hint: "Kadang IN, kadang OUT/BLANK. Prioritas investigasi — cek koordinat, atau kunjungan salah." },
  };

  // Header aliases per column (uppercase compare, trimmed).
  const EDI_MAP = {
    kodeCabang:  ["KODE CABANG"],
    namaCabang:  ["NAMA CABANG"],
    slsno:       ["SLSNO", "NO SALESMAN"],
    slsname:     ["SLSNAME", "NAMA SALESMAN"],
    team:        ["TEAM", "RAYON"],
    salesforce:  ["SALESFORCE"],
    visitDate:   ["VISIT DATE", "TANGGAL"],
    week:        ["WEEK", "MINGGU"],
    periode:     ["PERIODE"],
    custno:      ["CUSTNO", "KODE OUTLET", "NO OUTLET"],
    jamin:       ["JAMIN", "JAM MASUK"],
    jamout:      ["JAMOUT", "JAM KELUAR"],
    docid:       ["DOCID"],
    flagRadius:  ["FLAG RADIUS", "FLAG"],
    distance:    ["DISTANCE"],
    latVisit:    ["LAT VISIT"],
    longVisit:   ["LONG VISIT"],
    latVal:      ["LAT VAL"],
    longVal:     ["LONG VAL"],
    alorReason:  ["ALOR REASON", "ALASAN"],
    namaToko:    ["NAMA TOKO", "NAMA OUTLET"],
    alamatToko:  ["ALAMAT TOKO", "ALAMAT OUTLET", "ALAMAT"],
    cycle:       ["CYCLE"],
  };

  function normalizeHeader(s) {
    return String(s || "").trim().toUpperCase().replace(/\s+/g, " ");
  }

  function findHeaderRow(aoa, keys) {
    // find row whose cells (as normalized strings) contain at least 2 of the keys
    const targets = keys.map(normalizeHeader);
    for (let r = 0; r < Math.min(aoa.length, 30); r++) {
      const row = aoa[r] || [];
      const cells = row.map(normalizeHeader);
      let hits = 0;
      for (const t of targets) if (cells.includes(t)) hits++;
      if (hits >= 2) return r;
    }
    return -1;
  }

  function buildColIndex(headerRow, colMap) {
    const idx = {};
    const norm = headerRow.map(normalizeHeader);
    for (const [key, aliases] of Object.entries(colMap)) {
      idx[key] = -1;
      for (const alias of aliases) {
        const a = normalizeHeader(alias);
        const at = norm.indexOf(a);
        if (at >= 0) { idx[key] = at; break; }
      }
    }
    return idx;
  }

  function parseEdi(aoa) {
    const headerAt = findHeaderRow(aoa, ["CUSTNO", "FLAG RADIUS", "SLSNO", "SLSNAME"]);
    if (headerAt < 0) throw new Error("Header EDI tidak dikenali (butuh CUSTNO, FLAG RADIUS, ...).");
    const header = aoa[headerAt];
    const idx = buildColIndex(header, EDI_MAP);
    const rows = [];
    for (let r = headerAt + 1; r < aoa.length; r++) {
      const row = aoa[r] || [];
      const custno = row[idx.custno];
      if (custno === undefined || custno === null || custno === "") continue;
      rows.push({
        kodeCabang: row[idx.kodeCabang],
        namaCabang: row[idx.namaCabang],
        slsno: row[idx.slsno],
        slsname: row[idx.slsname],
        team: row[idx.team],
        salesforce: row[idx.salesforce],
        visitDate: row[idx.visitDate],
        week: row[idx.week],
        periode: row[idx.periode],
        custno: String(custno).trim(),
        jamin: fmtTime(row[idx.jamin]),
        jamout: fmtTime(row[idx.jamout]),
        docid: row[idx.docid],
        flagRadius: normalizeFlag(row[idx.flagRadius]),
        distance: row[idx.distance],
        latVisit: row[idx.latVisit],
        longVisit: row[idx.longVisit],
        latVal: row[idx.latVal],
        longVal: row[idx.longVal],
        alorReason: row[idx.alorReason],
        namaToko: row[idx.namaToko],
        alamatToko: row[idx.alamatToko],
        cycle: row[idx.cycle],
      });
    }
    return rows;
  }

  function fmtTime(v) {
    if (v === null || v === undefined || v === "") return "";
    if (v instanceof Date) {
      return v.toISOString().slice(11, 19);
    }
    if (typeof v === "number") {
      // Excel time fraction of day
      const total = Math.round(v * 86400);
      const h = String(Math.floor(total / 3600)).padStart(2, "0");
      const m = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
      const s = String(total % 60).padStart(2, "0");
      return `${h}:${m}:${s}`;
    }
    return String(v);
  }

  function normalizeFlag(v) {
    if (v === null || v === undefined || v === "") return "";
    const s = String(v).trim();
    if (s === "" || s === "-") return ""; // BLANK
    const n = Number(s);
    if (!Number.isNaN(n)) return String(Math.trunc(n));
    return s;
  }

  function parseHht(aoa) {
    let headerAt = -1;
    for (let r = 0; r < Math.min(aoa.length, 30); r++) {
      const norm = (aoa[r] || []).map(normalizeHeader);
      if (norm.includes("NO OUTLET") && norm.includes("NAMA OUTLET") && norm.includes("HHT")) {
        headerAt = r; break;
      }
    }
    if (headerAt < 0) return { rows: [], warn: "Header HHT tidak dikenali. Kolom HHT diabaikan." };
    const header = aoa[headerAt].map(normalizeHeader);
    const iOutlet = header.indexOf("NO OUTLET");
    const iName = header.indexOf("NAMA OUTLET");
    const iHht = header.indexOf("HHT");
    const iTipe = header.indexOf("TIPE SCAN");
    const iCall = header.indexOf("CALL");
    const iAlasan = header.indexOf("ALASAN");
    const iJamIn = header.indexOf("JAM MASUK");
    const iJamOut = header.indexOf("JAM KELUAR");
    const iSls = header.indexOf("SALESMAN");
    const iSalesforce = header.indexOf("SALESFORCE");
    const iTanggal = header.indexOf("TANGGAL");
    // Forward-fill kolom yang di-merge di Excel (Salesman, Salesforce, Tanggal
    // hanya muncul di baris pertama per grup).
    let lastSls = "", lastSalesforce = "", lastTanggal = "";
    const rows = [];
    for (let r = headerAt + 1; r < aoa.length; r++) {
      const row = aoa[r] || [];
      if (iSls >= 0 && row[iSls]) lastSls = String(row[iSls]).trim();
      if (iSalesforce >= 0 && row[iSalesforce]) lastSalesforce = String(row[iSalesforce]).trim();
      if (iTanggal >= 0 && row[iTanggal]) lastTanggal = String(row[iTanggal]).trim();
      const outlet = row[iOutlet];
      if (outlet === undefined || outlet === null || outlet === "") continue;
      rows.push({
        custno: String(outlet).trim(),
        namaToko: row[iName],
        hht: row[iHht],
        tipeScan: row[iTipe],
        call: row[iCall],
        alasan: row[iAlasan],
        jamin: row[iJamIn],
        jamout: row[iJamOut],
        salesman: lastSls,
        salesforce: lastSalesforce,
        tanggal: lastTanggal,
      });
    }
    return { rows };
  }

  // Alasan dari HHT detail (mis. "B4-Order By Phone", "B6-Tertutup Barang").
  // Nilai " -" / "-" berarti tidak ada alasan tercatat.
  function alasanHht(r) {
    if (!r.hht) return "";
    const a = String(r.hht.alasan || "").trim();
    if (!a || a === "-" || a === "—") return "";
    return a;
  }

  function isScanned(hht) {
    // "TP SCAN" per kriteria = barcode benar-benar discan.
    // HHT Tipe Scan: "S" = Scan barcode, "M" = Manual input, blank/"-" = tidak.
    if (!hht) return false;
    const t = String(hht.tipeScan || "").trim().toUpperCase();
    if (t === "S") return true;
    // Fallback jika kolom Tipe Scan tidak ada: HHT=Y anggap discan.
    if (!t) {
      const v = String(hht.hht || "").trim().toUpperCase();
      return v === "Y" || v === "YES" || v === "1" || v === "TRUE";
    }
    return false;
  }

  function categorize(row, hht) {
    const scanned = isScanned(hht);
    const flag = row.flagRadius;
    let key;
    if (flag === "1") key = scanned ? "1-SCAN" : "1-NOSCAN";
    else if (flag === "0") key = scanned ? "0-SCAN" : "0-NOSCAN";
    else key = scanned ? "BLANK-SCAN" : "BLANK-NOSCAN";
    return key;
  }

  // Split text as delimited (auto-detect: pipe > tab > semicolon > comma) into AoA.
  function parseDelimitedText(text) {
    if (!text) return [];
    const firstNl = text.indexOf("\n");
    const firstLine = (firstNl < 0 ? text : text.slice(0, firstNl)).replace(/\r$/, "");
    let delim = "|";
    if (firstLine.includes("|")) delim = "|";
    else if (firstLine.includes("\t")) delim = "\t";
    else if (firstLine.includes(";")) delim = ";";
    else if (firstLine.includes(",")) delim = ",";
    const rows = [];
    let at = 0;
    while (at < text.length) {
      let end = text.indexOf("\n", at);
      if (end < 0) end = text.length;
      const line = text.slice(at, end).replace(/\r$/, "");
      at = end + 1;
      if (!line) continue;
      rows.push(line.split(delim));
    }
    return rows;
  }

  // ---- Deteksi format dari ISI file, bukan dari nama ----
  // Penting untuk HP: Google Drive / file manager Android sering mengembalikan
  // nama tanpa ekstensi ("dmp", "lbp"), jadi menebak dari nama tidak bisa diandalkan.
  const SIG = {
    "7z":  [0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1C],
    gz:    [0x1F, 0x8B],
    ole2:  [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1], // .xls lama
    zip:   [0x50, 0x4B],                                     // .zip dan .xlsx
  };

  async function sniff(src) {
    const head = src instanceof Uint8Array
      ? src.subarray(0, 8)
      : new Uint8Array(await src.slice(0, 8).arrayBuffer());
    const is = (sig) => sig.every((b, i) => head[i] === b);
    if (is(SIG["7z"])) return "7z";
    if (is(SIG.gz)) return "gz";
    if (is(SIG.ole2)) return "xls";
    if (is(SIG.zip)) return "zip";   // bisa .xlsx atau archive biasa
    return "text";
  }

  const bytesOf = async (src) =>
    src instanceof Uint8Array ? src : new Uint8Array(await src.arrayBuffer());

  // ZIP bisa berupa .xlsx (punya [Content_Types].xml) atau archive biasa.
  async function zipIsXlsx(zip) {
    return !!(zip.file("[Content_Types].xml") || zip.file("xl/workbook.xml"));
  }

  // Extract archive → { bytes, name } file data terbesar di dalamnya.
  async function extractCompressed(src, kind) {
    if (kind === "7z") {
      if (typeof SevenZip === "undefined") throw new Error("Modul 7z gagal dimuat.");
      setStatus("Membuka arsip 7z...");
      const sz = await SevenZip({
        locateFile: (p) => p.endsWith(".wasm") ? "vendor/7zz.wasm" : p,
        print: () => {}, printErr: () => {},
      });
      const workDir = "/work";
      try { sz.FS.mkdir(workDir); } catch {}
      sz.FS.chdir(workDir);
      sz.FS.writeFile("archive.7z", await bytesOf(src));
      const rc = sz.callMain(["e", "-y", "archive.7z"]);
      if (rc !== 0) throw new Error("Gagal membuka arsip 7z (mungkin rusak atau berpassword).");
      const entries = sz.FS.readdir(workDir).filter((f) => f !== "." && f !== ".." && f !== "archive.7z");
      let best = null, bestSize = -1;
      for (const f of entries) {
        const st = sz.FS.stat(workDir + "/" + f);
        if (st.size > bestSize) { best = f; bestSize = st.size; }
      }
      if (!best) throw new Error("Arsip 7z kosong.");
      return { bytes: sz.FS.readFile(workDir + "/" + best), name: best };
    }
    if (kind === "zip") {
      if (typeof JSZip === "undefined") throw new Error("Modul ZIP gagal dimuat.");
      const zip = await JSZip.loadAsync(await bytesOf(src));
      const cands = [];
      zip.forEach((path, entry) => {
        if (entry.dir) return;
        if (/(^|\/)[._]/.test(path)) return;              // lewati __MACOSX, .DS_Store
        cands.push({ path, entry, size: entry._data ? entry._data.uncompressedSize : 0 });
      });
      if (!cands.length) throw new Error("Arsip ZIP kosong.");
      cands.sort((a, b) => b.size - a.size);
      return { bytes: await cands[0].entry.async("uint8array"), name: cands[0].path };
    }
    if (kind === "gz") {
      if (typeof DecompressionStream === "undefined") throw new Error("Browser tidak mendukung gzip.");
      const bytes = await bytesOf(src);
      const ds = new DecompressionStream("gzip");
      const stream = new Blob([bytes]).stream().pipeThrough(ds);
      return { bytes: new Uint8Array(await new Response(stream).arrayBuffer()), name: "data" };
    }
    throw new Error("Format arsip tidak dikenali.");
  }

  // Untuk file teks besar (mis. LBP 400rb+ baris): kembalikan raw text supaya
  // pemanggil bisa iterasi per baris tanpa materialisasi AoA penuh di memori.
  // Return null kalau isinya Excel (harus lewat readAsAoA).
  async function readRawText(src) {
    let kind = await sniff(src);
    if (kind === "zip") {
      const zip = await JSZip.loadAsync(await bytesOf(src));
      if (await zipIsXlsx(zip)) return null;
    }
    if (kind === "7z" || kind === "gz" || kind === "zip") {
      const { bytes } = await extractCompressed(src, kind);
      return (await sniff(bytes)) === "text" ? new TextDecoder("utf-8").decode(bytes) : null;
    }
    if (kind === "xls") return null;
    return typeof src.text === "function"
      ? await src.text()
      : new TextDecoder("utf-8").decode(src);
  }

  // Deteksi delimiter dari baris header.
  function detectDelim(firstLine) {
    if (firstLine.includes("|")) return "|";
    if (firstLine.includes("\t")) return "\t";
    if (firstLine.includes(";")) return ";";
    if (firstLine.includes(",")) return ",";
    return "|";
  }

  // Universal reader: return array-of-arrays (AoA) dari sumber apa pun.
  // Format ditentukan dari isi file, bukan nama, supaya tetap jalan di HP.
  async function readAsAoA(src, depth = 0) {
    if (depth > 3) throw new Error("Arsip bersarang terlalu dalam.");
    const kind = await sniff(src);

    if (kind === "zip") {
      const zip = await JSZip.loadAsync(await bytesOf(src));
      if (await zipIsXlsx(zip)) return excelToAoA(await bytesOf(src));
      const { bytes } = await extractCompressed(src, "zip");
      return await readAsAoA(bytes, depth + 1);
    }
    if (kind === "7z" || kind === "gz") {
      const { bytes } = await extractCompressed(src, kind);
      return await readAsAoA(bytes, depth + 1);
    }
    if (kind === "xls") return excelToAoA(await bytesOf(src));

    const text = typeof src.text === "function"
      ? await src.text()
      : new TextDecoder("utf-8").decode(src);
    return parseDelimitedText(text);
  }

  function excelToAoA(buf) {
    const wb = XLSX.read(buf, { type: "array", cellDates: true });
    for (const n of wb.SheetNames) {
      const ws = wb.Sheets[n];
      const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true });
      if (aoa.length > 1) return aoa;
    }
    throw new Error("Sheet kosong.");
  }

  async function parseDmp(file) {
    // Universal: menerima .txt/.csv/.xlsx/.xls (dan compressed-nya).
    // Kolom yang kita butuh: KODEOUTLET, NAMAOUTLET, ALAMAT, SLSNO, RAYON,
    // SALESMAN, KODESALESFORCE, NAMASALESFORCE, CYCLE.
    const rows = await readAsAoA(file);
    if (!rows.length) throw new Error("DMP kosong.");
    const cols = rows[0].map((s) => String(s == null ? "" : s).trim().toUpperCase());
    const iKO = cols.indexOf("KODEOUTLET");
    const iNO = cols.indexOf("NAMAOUTLET");
    if (iKO < 0 || iNO < 0) throw new Error("Header DMP tidak dikenali (butuh KODEOUTLET, NAMAOUTLET).");
    const iAlamat = cols.indexOf("ALAMAT");
    const iSls = cols.indexOf("SALESMAN");
    const iRayon = cols.indexOf("RAYON");
    const iCycle = cols.indexOf("CYCLE");
    const cell = (row, i) => i >= 0 && row[i] != null ? String(row[i]).trim() : "";
    const idx = new Map();
    let count = 0;
    for (let r = 1; r < rows.length; r++) {
      const row = rows[r] || [];
      const ko = cell(row, iKO);
      if (!ko || idx.has(ko)) continue;
      // Hanya simpan kolom yang benar-benar dipakai — DMP bisa 150rb baris,
      // menyimpan kolom yang tidak terpakai memboroskan memori (berat di HP).
      idx.set(ko, {
        namaOutlet: cell(row, iNO),
        alamat: cell(row, iAlamat),
        salesman: cell(row, iSls),
        rayon: cell(row, iRayon),
        cycle: cell(row, iCycle),
      });
      count++;
    }
    return { index: idx, count };
  }

  // Legacy alias, sekarang unified ke readAsAoA.
  const readWorkbook = readAsAoA;

  function setStatus(msg, cls = "") {
    const el = $("status");
    el.textContent = msg || "";
    el.className = "status " + cls;
    if (cls !== "err") clearError();
  }

  function clearError() {
    const b = $("errBox");
    if (b) { b.classList.add("hidden"); b.innerHTML = ""; }
  }

  // Tampilkan error di halaman, bukan cuma di console — di HP console tak terjangkau.
  function showError(err) {
    const b = $("errBox");
    if (!b) return;
    const msg = String((err && err.message) || err);
    let hint = "";
    if (/memor|allocat|Array buffer|out of/i.test(msg)) {
      hint = "File terlalu besar untuk memori HP. Coba buka di laptop, atau proses satu file dulu (LBP saja, lalu EDI saja).";
    } else if (/Header .* tidak dikenali/i.test(msg)) {
      hint = "Kolom di file tidak sesuai. Pastikan file tidak tertukar antar slot.";
    } else if (/kosong|rusak|arsip/i.test(msg)) {
      hint = "Kalau file diambil dari Google Drive, download dulu ke HP, baru pilih dari Files/Downloads.";
    } else {
      hint = "Kalau file dari Google Drive, download dulu ke HP lalu pilih dari Files. File yang belum terunduh sering gagal dibaca.";
    }
    b.innerHTML = `<b>Gagal memproses</b>${escapeHtml(msg)}<span class="hint">${escapeHtml(hint)}</span>`;
    b.classList.remove("hidden");
  }

  function toggleProcess() {
    // Bisa proses kalau ada EDI (Dashboard 1) atau LBP (Dashboard 2).
    $("processBtn").disabled = !state.ediFile && !state.lbpFile;
  }

  // Satu handler untuk keempat slot file: simpan, tandai baris, update tombol.
  const fmtSize = (b) =>
    b >= 1048576 ? (b / 1048576).toFixed(1).replace(".", ",") + " MB"
                 : Math.max(1, Math.round(b / 1024)) + " KB";

  function wireFile(inputId, stateKey, nameId, rowId) {
    $(inputId).addEventListener("change", (e) => {
      const f = e.target.files[0];
      state[stateKey] = f;
      const row = $(rowId);
      if (!f) {
        $(nameId).textContent = "Belum dipilih";
        row.classList.remove("has");
      } else if (f.size === 0) {
        // Umum di Android: file Google Drive yang belum diunduh terbaca 0 byte.
        state[stateKey] = null;
        $(nameId).textContent = `${f.name} — kosong (0 byte), download dulu ke HP`;
        row.classList.remove("has");
        showError(new Error(`"${f.name}" terbaca 0 byte.`));
      } else {
        $(nameId).textContent = `${f.name} · ${fmtSize(f.size)}`;
        row.classList.add("has");
        clearError();
      }
      toggleProcess();
    });
  }
  wireFile("ediFile", "ediFile", "ediName", "rowEdi");
  wireFile("hhtFile", "hhtFile", "hhtName", "rowHht");
  wireFile("dmpFile", "dmpFile", "dmpName", "rowDmp");
  wireFile("lbpFile", "lbpFile", "lbpName", "rowLbp");

  $("resetBtn").addEventListener("click", () => {
    state.ediFile = null; state.hhtFile = null; state.dmpFile = null; state.lbpFile = null;
    state.ediRows = []; state.hhtRows = []; state.dmpIndex = new Map(); state.results = []; state.filtered = [];
    $("ediFile").value = ""; $("hhtFile").value = ""; $("dmpFile").value = ""; $("lbpFile").value = "";
    $("ediName").textContent = "Belum dipilih"; $("hhtName").textContent = "Belum dipilih";
    $("dmpName").textContent = "Belum dipilih"; $("lbpName").textContent = "Belum dipilih";
    ["rowEdi", "rowHht", "rowDmp", "rowLbp"].forEach((id) => $(id).classList.remove("has"));
    if (window.M3D2) window.M3D2.reset();
    $("resultSection").classList.add("hidden");
    $("uploadCard").classList.remove("hidden");
    $("loadedBar").classList.add("hidden");
    $("tabs").classList.add("hidden");
    document.querySelectorAll(".filterCategoryItem").forEach((c) => (c.checked = false));
    document.querySelectorAll(".filterSalesmanItem").forEach((c) => (c.checked = false));
    const catAll = $("filterCategoryAll"); if (catAll) catAll.checked = true;
    const catLabel = $("filterCategoryLabel"); if (catLabel) catLabel.textContent = "Semua kategori";
    const smAll = $("filterSalesmanAll"); if (smAll) smAll.checked = true;
    const smLabel = $("filterSalesmanLabel"); if (smLabel) smLabel.textContent = "Semua salesman";
    const sSearch = $("filterSalesmanSearch"); if (sSearch) sSearch.value = "";
    $("search").value = "";
    const inkon = $("filterInkonsisten"); if (inkon) inkon.checked = false;
    setStatus("");
    toggleProcess();
  });

  $("processBtn").addEventListener("click", async () => {
    if (!state.ediFile && !state.lbpFile) return;
    $("processBtn").disabled = true;
    try {
      // DMP dulu — dipakai Dashboard 1 maupun Dashboard 2.
      state.dmpIndex = new Map();
      let dmpCount = 0;
      if (state.dmpFile) {
        setStatus("Membaca DMP...");
        const dmp = await parseDmp(state.dmpFile);
        state.dmpIndex = dmp.index;
        dmpCount = dmp.count;
      }

      // Dashboard 2 (LBP) — jalan kalau file LBP diupload.
      let d2Msg = "";
      if (state.lbpFile && window.M3D2) {
        d2Msg = await window.M3D2.process(state.lbpFile, state.dmpIndex);
      }

      // Dashboard 1 (EDI) — butuh EDI.
      if (!state.ediFile) {
        const parts = [];
        if (dmpCount) parts.push(`DMP: ${dmpCount.toLocaleString("id-ID")} outlet`);
        if (d2Msg) parts.push(d2Msg);
        parts.push("EDI tidak dipilih — Validasi Kunjungan dilewati");
        setStatus(parts.join(" · "), "ok");
        collapseUpload();
        $("tab1").disabled = true;
        showDash(2);
        return;
      }
      $("tab1").disabled = false;

      setStatus("Membaca EDI...");
      const ediAoa = await readWorkbook(state.ediFile);
      state.ediRows = parseEdi(ediAoa);
      if (!state.ediRows.length) throw new Error("EDI tidak berisi baris data.");

      state.scanIndex = new Map();
      let hhtWarn = "";
      if (state.hhtFile) {
        setStatus("Membaca HHT...");
        const hhtAoa = await readWorkbook(state.hhtFile);
        const parsed = parseHht(hhtAoa);
        state.hhtRows = parsed.rows;
        hhtWarn = parsed.warn || "";
        for (const h of state.hhtRows) {
          const k = String(h.custno);
          if (!state.scanIndex.has(k) || isScanned(h)) state.scanIndex.set(k, h);
        }
      }

      setStatus("Kategorisasi...");
      const results = state.ediRows.map((r) => {
        const hht = state.scanIndex.get(r.custno);
        const dmp = state.dmpIndex.get(r.custno);
        const cat = categorize(r, hht);
        // Sumber: DMP (paling akurat) > HHT > EDI. Fallback kalau kosong.
        const namaTokoEff = (dmp && dmp.namaOutlet) || (hht && hht.namaToko && String(hht.namaToko).trim()) || r.namaToko || "";
        const salesmanEff = (dmp && dmp.salesman) || (hht && hht.salesman && String(hht.salesman).trim()) || r.slsname || "";
        const alamatEff = (dmp && dmp.alamat) || r.alamatToko || "";
        const rayonEff = (dmp && dmp.rayon) || r.team || "";
        const cycleEff = (dmp && dmp.cycle) || r.cycle || "";
        return { ...r, hht, dmp, category: cat, namaTokoEff, salesmanEff, alamatEff, rayonEff, cycleEff };
      });

      // Consistency per outlet: bandingkan semua kunjungan outlet yang sama.
      const byOutlet = new Map();
      for (const r of results) {
        if (!byOutlet.has(r.custno)) byOutlet.set(r.custno, []);
        byOutlet.get(r.custno).push(r);
      }
      for (const [custno, visits] of byOutlet) {
        let key;
        if (visits.length === 1) key = "SINGLE";
        else {
          const flags = new Set(visits.map((v) => v.flagRadius || ""));
          const has1 = flags.has("1");
          const hasBad = flags.has("0") || flags.has("");
          if (has1 && hasBad) key = "MIXED";
          else if (has1) key = "VALID";
          else key = "PROBLEM";
        }
        for (const v of visits) { v.consistency = key; v.visitCount = visits.length; }
      }
      state.results = results;

      const salesmen = [...new Set(results.map((r) => r.salesmanEff).filter(Boolean))].sort();
      populateSalesmen(salesmen);
      applyFilters();
      $("resultSection").classList.remove("hidden");
      const msg = [`${results.length.toLocaleString("id-ID")} kunjungan`];
      if (dmpCount) msg.push(`${dmpCount.toLocaleString("id-ID")} outlet DMP`);
      if (d2Msg) msg.push(d2Msg);
      if (state.hhtFile) {
        const matched = results.filter((r) => r.hht).length;
        msg.push(`${matched.toLocaleString("id-ID")} cocok HHT`);
      } else {
        msg.push("tanpa HHT — scan dianggap tidak ada");
      }
      if (hhtWarn) msg.push(hhtWarn);
      setStatus(msg.join(" · "), "ok");
      collapseUpload();
      showDash(1);
    } catch (err) {
      console.error(err);
      setStatus("Gagal diproses.", "err");
      showError(err);
    } finally {
      toggleProcess();
    }
  });

  function renderSummary(rows) {
    rows = rows || state.results;
    const counts = {};
    for (const k of Object.keys(CATEGORY_INFO)) counts[k] = 0;
    for (const r of rows) counts[r.category]++;
    const total = rows.length;

    // 6 kartu kategori saja — totalnya sudah tampil di sebelah judul "Detail".
    $("summary").innerHTML = Object.keys(CATEGORY_INFO).map((k) => {
      const info = CATEGORY_INFO[k];
      const pct = total ? ((counts[k] / total) * 100).toFixed(1) : "0.0";
      return statCard(info.label, counts[k].toLocaleString("id-ID"), info.tone, `${pct}%`);
    }).join("");
  }

  function statCard(label, value, tone, sub) {
    const s = sub ? ` <small>${sub}</small>` : "";
    return `<div class="stat ${tone || ""}"><b>${value}${s}</b><span>${escapeHtml(label)}</span></div>`;
  }

  function getSelectedCategories() {
    return new Set([...document.querySelectorAll(".filterCategoryItem")]
      .filter((c) => c.checked).map((c) => c.value));
  }
  function getSelectedSalesmen() {
    return new Set([...document.querySelectorAll(".filterSalesmanItem")]
      .filter((c) => c.checked).map((c) => c.value));
  }

  // Base set for the summary: salesman + search + inkonsisten toggle, but NOT category.
  // (Summary is the category breakdown itself.)
  function getBaseFiltered() {
    const q = $("search").value.trim().toLowerCase();
    const sms = getSelectedSalesmen();
    const onlyMixed = $("filterInkonsisten") && $("filterInkonsisten").checked;
    return state.results.filter((r) => {
      if (onlyMixed && r.consistency !== "MIXED") return false;
      if (sms.size > 0 && !sms.has(r.salesmanEff)) return false;
      if (q) {
        const hay = [r.custno, r.namaTokoEff, r.salesmanEff, r.rayonEff, r.alamatEff, r.alorReason, alasanHht(r)]
          .map((x) => String(x || "").toLowerCase()).join(" ");
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }

  function applyFilters() {
    const base = getBaseFiltered();
    renderSummary(base);
    const cats = getSelectedCategories();
    state.filtered = cats.size === 0 ? base : base.filter((r) => cats.has(r.category));
    // Urutkan supaya baris outlet yang sama berkumpul (visual "merged cell").
    state.filtered.sort((a, b) => {
      const c = String(a.custno).localeCompare(String(b.custno));
      if (c) return c;
      return String(a.visitDate || "").localeCompare(String(b.visitDate || ""));
    });
    state.page = 1;
    renderTable();
  }

  function renderTable() {
    const total = state.filtered.length;
    const pages = Math.max(1, Math.ceil(total / state.pageSize));
    if (state.page > pages) state.page = pages;
    const start = (state.page - 1) * state.pageSize;
    const slice = state.filtered.slice(start, start + state.pageSize);

    const tbody = document.querySelector("#resultTable tbody");
    let prevCust = null;
    tbody.innerHTML = slice.map((r) => {
      const info = CATEGORY_INFO[r.category];
      const cons = CONSISTENCY_INFO[r.consistency] || CONSISTENCY_INFO.SINGLE;
      const consLabel = r.visitCount > 1 ? `${cons.label} (${r.visitCount}×)` : cons.label;
      const hhtCell = r.hht ? `${escapeHtml(String(r.hht.hht || ""))}${r.hht.tipeScan ? " / " + escapeHtml(String(r.hht.tipeScan)) : ""}` : "—";
      // Kalau baris ini outlet yang sama dengan baris sebelumnya (di halaman ini),
      // kosongkan kolom identitas outlet supaya visual seperti merged cell.
      const dup = r.custno === prevCust;
      prevCust = r.custno;
      const nomor = dup ? "" : escapeHtml(r.custno);
      const nama = dup ? "" : escapeHtml(r.namaTokoEff);
      const sls = dup ? "" : escapeHtml(r.salesmanEff);
      const rayon = dup ? "" : escapeHtml(r.rayonEff);
      const cycle = dup ? "" : escapeHtml(r.cycleEff);
      const consTag = dup ? "" : `<span class="tag-cons cons-${r.consistency}" title="${escapeHtml(cons.hint)}">${escapeHtml(consLabel)}</span>`;
      const dist = r.distance !== null && r.distance !== undefined ? Number(r.distance).toFixed(1) : "";
      return `<tr class="${dup ? "row-dup" : ""}">
        <td><span class="tag tag-${r.category}">${escapeHtml(info.label)}</span></td>
        <td class="col-x">${consTag}</td>
        <td class="mono">${nomor}</td>
        <td>${nama}</td>
        <td>${sls}</td>
        <td class="col-x mono">${rayon}</td>
        <td class="col-x">${cycle}</td>
        <td class="mono">${escapeHtml(r.visitDate || "")}</td>
        <td class="col-x mono">${escapeHtml(r.jamin || "")}</td>
        <td class="col-x mono">${escapeHtml(r.jamout || "")}</td>
        <td class="mono">${escapeHtml(r.flagRadius || "BLANK")}</td>
        <td class="col-x mono">${dist}</td>
        <td class="mono">${hhtCell}</td>
        <td>${escapeHtml(alasanHht(r))}</td>
        <td class="col-x">${escapeHtml(r.alorReason || "")}</td>
        <td>${escapeHtml(info.suggest)}</td>
      </tr>`;
    }).join("");

    if (!slice.length) {
      tbody.innerHTML = `<tr><td colspan="16" class="empty">Tidak ada baris yang cocok dengan filter ini.</td></tr>`;
    }

    $("countInfo").textContent = `${total.toLocaleString("id-ID")} baris`;
    $("pageInfo").textContent = `Halaman ${state.page} / ${pages}`;
    $("prevPage").disabled = state.page <= 1;
    $("nextPage").disabled = state.page >= pages;
  }

  function escapeHtml(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
  }

  $("search").addEventListener("input", debounce(applyFilters, 200));
  $("filterInkonsisten").addEventListener("change", applyFilters);

  // Generic multi-select wiring (used by category + salesman)
  function wireMulti(wrapId, btnId, menuId, allId, itemClass, labelId, noun) {
    const wrap = $(wrapId), btn = $(btnId), menu = $(menuId), all = $(allId), label = $(labelId);
    const items = () => document.querySelectorAll("." + itemClass);
    function updateLabel() {
      const list = [...items()];
      const on = list.filter((c) => c.checked);
      if (on.length === 0 || on.length === list.length) {
        label.textContent = "Semua " + noun;
        all.checked = true;
      } else if (on.length === 1) {
        label.textContent = on[0].parentElement.textContent.trim();
        all.checked = false;
      } else {
        label.textContent = `${on.length} ${noun} dipilih`;
        all.checked = false;
      }
    }
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const willOpen = menu.hidden;
      document.querySelectorAll(".multi.open").forEach((el) => {
        if (el !== wrap) {
          el.classList.remove("open");
          const m = el.querySelector(".multi-menu");
          if (m) m.hidden = true;
        }
      });
      menu.hidden = !willOpen;
      wrap.classList.toggle("open", willOpen);
    });
    document.addEventListener("click", (e) => {
      if (!wrap.contains(e.target)) { menu.hidden = true; wrap.classList.remove("open"); }
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { menu.hidden = true; wrap.classList.remove("open"); }
    });
    all.addEventListener("click", (e) => {
      // "Semua" bertindak sebagai tombol reset — selalu berakhir tercentang.
      // Klik selalu: kosongkan pilihan individual, biarkan Semua checked.
      // Setelah toggle default: all.checked == true berarti tadinya unchecked,
      // biarkan; all.checked == false berarti tadinya checked, cegah unchecking.
      if (!all.checked) e.preventDefault();
      items().forEach((c) => (c.checked = false));
      updateLabel();
      applyFilters();
    });
    return { updateLabel, items };
  }

  const catCtrl = wireMulti("filterCategory", "filterCategoryBtn", "filterCategoryMenu",
    "filterCategoryAll", "filterCategoryItem", "filterCategoryLabel", "kategori");
  catCtrl.items().forEach((c) => c.addEventListener("change", () => {
    catCtrl.updateLabel(); applyFilters();
  }));

  const smCtrl = wireMulti("filterSalesman", "filterSalesmanBtn", "filterSalesmanMenu",
    "filterSalesmanAll", "filterSalesmanItem", "filterSalesmanLabel", "salesman");

  function populateSalesmen(names) {
    const list = $("filterSalesmanList");
    list.innerHTML = names.map((n) => {
      const safe = escapeHtml(n);
      return `<label class="multi-opt" data-name="${safe.toLowerCase()}"><input type="checkbox" value="${safe}" class="filterSalesmanItem" /> ${safe}</label>`;
    }).join("");
    list.querySelectorAll(".filterSalesmanItem").forEach((c) => {
      c.addEventListener("change", () => { smCtrl.updateLabel(); applyFilters(); });
    });
    smCtrl.updateLabel();
  }

  // in-menu search for salesman
  $("filterSalesmanSearch").addEventListener("input", (e) => {
    const q = e.target.value.trim().toLowerCase();
    $("filterSalesmanList").querySelectorAll(".multi-opt").forEach((el) => {
      el.style.display = !q || el.getAttribute("data-name").includes(q) ? "" : "none";
    });
  });
  $("prevPage").addEventListener("click", () => { if (state.page > 1) { state.page--; renderTable(); } });
  $("nextPage").addEventListener("click", () => { state.page++; renderTable(); });

  $("exportBtn").addEventListener("click", () => {
    if (!state.filtered.length) return;
    const rows = state.filtered.map((r) => {
      const info = CATEGORY_INFO[r.category];
      const cons = CONSISTENCY_INFO[r.consistency] || CONSISTENCY_INFO.SINGLE;
      return {
        Kategori: info.label,
        Konsistensi: cons.label,
        "Jumlah Kunjungan Outlet": r.visitCount,
        "Kode Outlet": r.custno,
        "Nama Toko": r.namaTokoEff,
        Salesman: r.salesmanEff,
        "Rayon (Team)": r.rayonEff,
        Cycle: r.cycleEff,
        "Alamat Toko": r.alamatEff,
        "Visit Date": r.visitDate || "",
        "Jam Masuk": r.jamin || "",
        "Jam Keluar": r.jamout || "",
        "Flag Radius": r.flagRadius || "BLANK",
        Distance: r.distance ?? "",
        "Lat Visit": r.latVisit ?? "",
        "Long Visit": r.longVisit ?? "",
        "Lat Val": r.latVal ?? "",
        "Long Val": r.longVal ?? "",
        HHT: r.hht ? (r.hht.hht || "") : "",
        "Tipe Scan": r.hht ? (r.hht.tipeScan || "") : "",
        "Alasan HHT": alasanHht(r),
        "Alor Reason": r.alorReason || "",
        Saran: info.suggest,
      };
    });
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Hasil");
    const fname = `hasil-validasi-${new Date().toISOString().slice(0, 10)}.xlsx`;
    XLSX.writeFile(wb, fname);
  });

  function debounce(fn, ms) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  }

  // ---- Tab switching (Dashboard 1 / Dashboard 2) ----
  function showDash(n) {
    const one = String(n) === "1";
    $("dash1").hidden = !one;
    $("dash2").hidden = one;
    $("tab1").classList.toggle("active", one);
    $("tab2").classList.toggle("active", !one);
    $("tab1").setAttribute("aria-selected", one);
    $("tab2").setAttribute("aria-selected", !one);
  }
  $("tab1").addEventListener("click", () => showDash(1));
  $("tab2").addEventListener("click", () => showDash(2));

  // "Detail lengkap" — tampilkan kolom sekunder.
  $("toggleFullCols").addEventListener("change", (e) => {
    document.body.classList.toggle("full-cols", e.target.checked);
  });

  // Tombol bantuan membuka blok penjelasan yang tersembunyi.
  const openHelp = (btnId, detId) => {
    const b = $(btnId), d = $(detId);
    if (!b || !d) return;
    b.addEventListener("click", () => {
      d.open = !d.open;
      if (d.open) d.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
  };
  openHelp("helpD1Btn", "helpD1");
  openHelp("helpD2Btn", "helpD2");

  // Setelah diproses, panel upload mengkerut jadi strip ringkas.
  $("changeFilesBtn").addEventListener("click", () => {
    $("uploadCard").classList.remove("hidden");
    $("loadedBar").classList.add("hidden");
    $("uploadCard").scrollIntoView({ block: "start", behavior: "smooth" });
  });

  function collapseUpload() {
    const picked = [
      state.ediFile && "EDI",
      state.hhtFile && "HHT",
      state.dmpFile && "DMP",
      state.lbpFile && "LBP",
    ].filter(Boolean);
    $("lbFiles").innerHTML = picked.map((p) => `<span>${p}</span>`).join("");
    $("lbStatus").textContent = $("status").textContent;
    $("uploadCard").classList.add("hidden");
    $("loadedBar").classList.remove("hidden");
    $("tabs").classList.remove("hidden");
  }

  // ---- Shared surface for dash2.js ----
  // dash2 reuses the same universal file readers and the DMP outlet index.
  window.M3 = {
    readAsAoA,
    readRawText,
    detectDelim,
    parseDelimitedText,
    escapeHtml,
    debounce,
    setStatus,
    getDmpIndex: () => state.dmpIndex,
    getFiles: () => ({ lbp: state.lbpFile }),
    onLbpFile: (f) => { state.lbpFile = f; },
    showDash,
  };
})();
