(() => {
  const $ = (id) => document.getElementById(id);
  const state = {
    ediRows: [],
    hhtRows: [],
    scanIndex: new Map(),
    results: [],
    filtered: [],
    page: 1,
    pageSize: 100,
  };

  const CATEGORY_INFO = {
    "1-SCAN":       { label: "FLAG 1 (IN RADIUS), TP SCAN",       tone: "ok",   suggest: "Paling valid. Tidak ada aksi." },
    "1-NOSCAN":     { label: "FLAG 1 (IN RADIUS), TDK SCAN",      tone: "info", suggest: "Kemungkinan barcode belum discan. Cek ketersediaan barcode di toko." },
    "0-SCAN":       { label: "FLAG 0 (OUT RADIUS), TP SCAN",      tone: "warn", suggest: "Kunjungi tapi validasi salah, atau fiktif barcode. Cocokan LongLat & alamat." },
    "0-NOSCAN":     { label: "FLAG 0 (OUT RADIUS), TDK SCAN",     tone: "warn", suggest: "Kemungkinan tidak dikunjungi atau validasi salah. Validasi ulang." },
    "BLANK-SCAN":   { label: "FLAG BLANK, TP SCAN",               tone: "info", suggest: "Belum ada validasi, barcode sudah ada. SOLUSI: scan barcode = validasi." },
    "BLANK-NOSCAN": { label: "FLAG BLANK, TDK SCAN",              tone: "bad",  suggest: "Toko tidak ada / tidak ketemu. Cek ulang keberadaan toko." },
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
    // The HHT file has a merged/sparse header. Find the row that has "No Outlet" & "Nama Outlet" & "HHT" etc.
    let headerAt = -1;
    for (let r = 0; r < Math.min(aoa.length, 30); r++) {
      const norm = (aoa[r] || []).map(normalizeHeader);
      const hasOutlet = norm.includes("NO OUTLET");
      const hasName = norm.includes("NAMA OUTLET");
      const hasHht = norm.includes("HHT");
      if (hasOutlet && hasName && hasHht) { headerAt = r; break; }
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
    const rows = [];
    for (let r = headerAt + 1; r < aoa.length; r++) {
      const row = aoa[r] || [];
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
      });
    }
    return { rows };
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

  async function readWorkbook(file) {
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: "array", cellDates: true });
    // Use first non-empty sheet
    for (const name of wb.SheetNames) {
      const ws = wb.Sheets[name];
      const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true });
      if (aoa.length > 1) return aoa;
    }
    throw new Error("Sheet kosong.");
  }

  function setStatus(msg, cls = "") {
    const el = $("status");
    el.textContent = msg || "";
    el.className = "status " + cls;
  }

  function toggleProcess() {
    $("processBtn").disabled = !state.ediFile;
  }

  $("ediFile").addEventListener("change", (e) => {
    state.ediFile = e.target.files[0];
    $("ediName").textContent = state.ediFile ? state.ediFile.name : "Belum ada file";
    toggleProcess();
  });
  $("hhtFile").addEventListener("change", (e) => {
    state.hhtFile = e.target.files[0];
    $("hhtName").textContent = state.hhtFile ? state.hhtFile.name : "Belum ada file";
    toggleProcess();
  });

  $("resetBtn").addEventListener("click", () => {
    state.ediFile = null; state.hhtFile = null;
    state.ediRows = []; state.hhtRows = []; state.results = []; state.filtered = [];
    $("ediFile").value = ""; $("hhtFile").value = "";
    $("ediName").textContent = "Belum ada file"; $("hhtName").textContent = "Belum ada file";
    $("resultSection").classList.add("hidden");
    document.querySelectorAll(".filterCategoryItem").forEach((c) => (c.checked = false));
    document.querySelectorAll(".filterSalesmanItem").forEach((c) => (c.checked = false));
    const catAll = $("filterCategoryAll"); if (catAll) catAll.checked = true;
    const catLabel = $("filterCategoryLabel"); if (catLabel) catLabel.textContent = "Semua kategori";
    const smAll = $("filterSalesmanAll"); if (smAll) smAll.checked = true;
    const smLabel = $("filterSalesmanLabel"); if (smLabel) smLabel.textContent = "Semua salesman";
    const sSearch = $("filterSalesmanSearch"); if (sSearch) sSearch.value = "";
    $("search").value = "";
    setStatus("");
    toggleProcess();
  });

  $("processBtn").addEventListener("click", async () => {
    if (!state.ediFile) return;
    $("processBtn").disabled = true;
    setStatus("Membaca EDI...");
    try {
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
        const cat = categorize(r, hht);
        return { ...r, hht, category: cat };
      });
      state.results = results;

      const salesmen = [...new Set(results.map((r) => r.slsname).filter(Boolean))].sort();
      populateSalesmen(salesmen);
      applyFilters();
      $("resultSection").classList.remove("hidden");
      setStatus(`Selesai: ${results.length} baris diproses${hhtWarn ? " — " + hhtWarn : ""}.`, "ok");
    } catch (err) {
      console.error(err);
      setStatus("Gagal: " + err.message, "err");
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

    const html = [
      statCard("Total baris", total, "info"),
      ...Object.keys(CATEGORY_INFO).map((k) => {
        const info = CATEGORY_INFO[k];
        const pct = total ? ((counts[k] / total) * 100).toFixed(1) : "0.0";
        return statCard(info.label, `${counts[k]} <small style="font-size:12px;color:#6b7280;font-weight:400">(${pct}%)</small>`, info.tone);
      }),
    ].join("");
    $("summary").innerHTML = html;
  }

  function statCard(label, value, tone) {
    return `<div class="stat ${tone || ""}"><b>${value}</b><span>${escapeHtml(label)}</span></div>`;
  }

  function getSelectedCategories() {
    return new Set([...document.querySelectorAll(".filterCategoryItem")]
      .filter((c) => c.checked).map((c) => c.value));
  }
  function getSelectedSalesmen() {
    return new Set([...document.querySelectorAll(".filterSalesmanItem")]
      .filter((c) => c.checked).map((c) => c.value));
  }

  // Base set for the summary: salesman + search, but NOT category.
  // (Summary is the category breakdown itself.)
  function getBaseFiltered() {
    const q = $("search").value.trim().toLowerCase();
    const sms = getSelectedSalesmen();
    return state.results.filter((r) => {
      if (sms.size > 0 && !sms.has(r.slsname)) return false;
      if (q) {
        const hay = [r.custno, r.namaToko, r.slsname, r.team, r.alamatToko, r.alorReason]
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
    tbody.innerHTML = slice.map((r) => {
      const info = CATEGORY_INFO[r.category];
      const hhtCell = r.hht ? `${escapeHtml(String(r.hht.hht || ""))}${r.hht.tipeScan ? " / " + escapeHtml(String(r.hht.tipeScan)) : ""}` : "—";
      return `<tr>
        <td><span class="tag tag-${r.category}">${escapeHtml(info.label)}</span></td>
        <td>${escapeHtml(r.custno)}</td>
        <td>${escapeHtml(r.namaToko || (r.hht && r.hht.namaToko) || "")}</td>
        <td>${escapeHtml(r.slsname || "")}</td>
        <td>${escapeHtml(r.team || "")}</td>
        <td>${escapeHtml(r.cycle || "")}</td>
        <td>${escapeHtml(r.visitDate || "")}</td>
        <td>${escapeHtml(r.jamin || "")}</td>
        <td>${escapeHtml(r.jamout || "")}</td>
        <td>${escapeHtml(r.flagRadius || "BLANK")}</td>
        <td>${escapeHtml(r.distance !== null && r.distance !== undefined ? String(r.distance) : "")}</td>
        <td>${hhtCell}</td>
        <td>${escapeHtml(r.alorReason || "")}</td>
        <td>${escapeHtml(info.suggest)}</td>
      </tr>`;
    }).join("");

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
      const open = !menu.hidden;
      menu.hidden = open;
      wrap.classList.toggle("open", !open);
    });
    document.addEventListener("click", (e) => {
      if (!wrap.contains(e.target)) { menu.hidden = true; wrap.classList.remove("open"); }
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { menu.hidden = true; wrap.classList.remove("open"); }
    });
    all.addEventListener("change", () => {
      items().forEach((c) => (c.checked = false));
      all.checked = true;
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
      return {
        Kategori: info.label,
        "Kode Outlet": r.custno,
        "Nama Toko": r.namaToko || (r.hht && r.hht.namaToko) || "",
        Salesman: r.slsname || "",
        "Rayon (Team)": r.team || "",
        Cycle: r.cycle || "",
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
})();
