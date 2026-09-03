// Dashboard 2 — Outlet Aktif per Produk (DMP + LBP)
(() => {
  const $ = (id) => document.getElementById(id);

  // ---------- Parsing helpers ----------

  // isi = angka mulai karakter ke-5 dari Kemasan.
  // "CAR/24  ,BOT/1  ,BOT" -> 24 ; "GLN/1   ,GLN/1  ,GLN" -> 1
  function parseIsi(kemasan) {
    if (!kemasan) return 0;
    const m = String(kemasan).slice(4).match(/^\s*(\d+)/);
    return m ? parseInt(m[1], 10) : 0;
  }

  // Kata-kata promo / channel / packaging yang tidak mengubah identitas produk.
  const NOISE = new Set([
    "GT", "MT", "LJ", "KV",
    "NEW", "COSMO",
    "PROMO", "GOSOK", "PESTA", "BOLA",
    "SHRINK", "WRAP", "MULTIPACK", "PACK",
    "ORI", "ORIGINAL", "REG", "REGULER",
  ]);

  // Gabungkan kode barang yang produknya sama.
  // "LE MINERALE GT REGULER 24BTLX600ML" & "LEMINERALE GT REG PESTA BOLA 24X600ML"
  //   -> keduanya "LE MINERALE 600ML"
  function normalizeProduct(nama) {
    if (!nama) return "";
    let s = String(nama).toUpperCase().trim();
    s = s.replace(/\bLEMINERALE\b/g, "LE MINERALE");
    s = s.replace(/\bCAPUCINO\b/g, "CAPPUCINO");
    // Ukuran = kemunculan <angka><ML|L> terakhir
    let size = "";
    const sizeRe = /(\d+)\s*(ML|L)\b/g;
    let m, last = null;
    while ((m = sizeRe.exec(s)) !== null) last = m;
    if (last) size = last[1] + last[2];
    // Buang token kemasan yang membawa ukuran (24BTLX350ML, 4BOX6CANX189ML, ...)
    s = s.replace(/\b[\dA-Z]*\d+\s*(ML|L)\b/g, " ");
    const words = s.split(/[\s,]+/).filter(Boolean);
    const kept = [];
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      if (w === "LS") { kept.push("LESS", "SUGAR"); continue; }
      if (w === "LESS" && words[i + 1] === "SUGAR") { kept.push("LESS", "SUGAR"); i++; continue; }
      if (NOISE.has(w)) continue;
      if (/^\d+$/.test(w)) continue;
      kept.push(w);
    }
    const base = kept.join(" ").replace(/\s+/g, " ").trim();
    return size ? `${base} ${size}` : base;
  }

  const num = (v) => {
    const n = parseFloat(String(v == null ? "" : v).replace(/,/g, ""));
    return Number.isFinite(n) ? n : 0;
  };

  // ---------- LBP parsing ----------

  function colIndexes(cols) {
    const at = (...names) => {
      for (const n of names) { const i = cols.indexOf(n); if (i >= 0) return i; }
      return -1;
    };
    const ix = {
      outlet: at("NO OUTLET", "NOOUTLET", "KODEOUTLET", "KODE OUTLET"),
      nama: at("NAMA OUTLET", "NAMAOUTLET"),
      pcode: at("PCODE", "KODE BARANG"),
      produk: at("NAMA PRODUK", "NAMAPRODUK"),
      kemasan: at("KEMASAN"),
      qty: at("QTYPCS", "QTY PCS"),
      amount: at("TOTAL", "AMOUNT"),
      periode: at("PERIODE"),
      sls: at("SALESMAN"),
      type: at("TRANSTYPE", "TRANS TYPE"),
    };
    if (ix.outlet < 0 || ix.produk < 0 || ix.qty < 0) {
      throw new Error("Header LBP tidak dikenali (butuh No Outlet, Nama Produk, QTYPCS).");
    }
    return ix;
  }

  // Cache normalizeProduct per nama produk — hanya ~56 nama unik untuk 400rb+ baris.
  const groupCache = new Map();
  function groupOf(nama) {
    let g = groupCache.get(nama);
    if (g === undefined) { g = normalizeProduct(nama); groupCache.set(nama, g); }
    return g;
  }

  function pushLine(out, periodes, ix, get) {
    const outlet = get(ix.outlet);
    if (!outlet) return;
    const isi = parseIsi(get(ix.kemasan));
    const qtypcs = num(get(ix.qty));
    const periode = get(ix.periode);
    if (periode) periodes.add(periode);
    out.push({
      outlet,
      namaOutlet: get(ix.nama),
      pcode: get(ix.pcode),
      group: groupOf(get(ix.produk)),
      isi, qtypcs,
      karton: isi > 0 ? qtypcs / isi : 0,   // kolom turunan: karton = QTYPCS / isi
      amount: num(get(ix.amount)),
      periode,
      salesman: get(ix.sls),
      retur: get(ix.type).toUpperCase() === "R",
    });
  }

  async function parseLbp(file) {
    const lines = [];
    const periodes = new Set();

    // Jalur cepat: sumber teks → iterasi per baris, tanpa materialisasi AoA penuh.
    const text = await window.M3.readRawText(file);
    if (text !== null) {
      const firstNl = text.indexOf("\n");
      if (firstNl < 0) throw new Error("LBP kosong.");
      const delim = window.M3.detectDelim(text.slice(0, firstNl).replace(/\r$/, ""));
      const cols = text.slice(0, firstNl).replace(/\r$/, "").split(delim).map((s) => s.trim().toUpperCase());
      const ix = colIndexes(cols);
      let at = firstNl + 1;
      while (at < text.length) {
        let end = text.indexOf("\n", at);
        if (end < 0) end = text.length;
        const line = text.slice(at, end);
        at = end + 1;
        if (!line) continue;
        const p = line.split(delim);
        pushLine(lines, periodes, ix, (i) => (i >= 0 && p[i] != null ? p[i].trim() : ""));
      }
    } else {
      // Sumber Excel → lewat AoA biasa.
      const rows = await window.M3.readAsAoA(file);
      if (!rows.length) throw new Error("LBP kosong.");
      const cols = rows[0].map((s) => String(s == null ? "" : s).trim().toUpperCase());
      const ix = colIndexes(cols);
      for (let r = 1; r < rows.length; r++) {
        const row = rows[r];
        if (!row) continue;
        pushLine(lines, periodes, ix, (i) => (i >= 0 && row[i] != null ? String(row[i]).trim() : ""));
      }
    }
    return { lines, periodes: [...periodes].sort((a, b) => num(a) - num(b)) };
  }

  // ---------- Aggregation ----------

  function aggregate() {
    const inclRetur = $("d2InclRetur").checked;
    const sms = new Set([...document.querySelectorAll(".d2SalesmanItem")].filter((c) => c.checked).map((c) => c.value));
    const pds = new Set([...document.querySelectorAll(".d2PeriodeItem")].filter((c) => c.checked).map((c) => c.value));

    // outlet -> { id, nama, salesman, rayon, groups:Set, karton, amount }
    const outlets = new Map();
    // group -> { group, pcodes:Set, outlets:Set, karton, pcs, amount }
    const groups = new Map();

    for (const l of S.lines) {
      if (!inclRetur && l.retur) continue;
      if (pds.size && !pds.has(l.periode)) continue;

      const dmp = S.dmpIndex.get(l.outlet);
      const salesman = (dmp && dmp.salesman) || l.salesman || "";
      if (sms.size && !sms.has(salesman)) continue;

      let o = outlets.get(l.outlet);
      if (!o) {
        o = {
          id: l.outlet,
          nama: (dmp && dmp.namaOutlet) || l.namaOutlet || "",
          salesman,
          rayon: (dmp && dmp.rayon) || "",
          groups: new Set(), karton: 0, amount: 0,
        };
        outlets.set(l.outlet, o);
      }
      o.groups.add(l.group);
      o.karton += l.karton;
      o.amount += l.amount;

      let g = groups.get(l.group);
      if (!g) {
        g = { group: l.group, pcodes: new Set(), outlets: new Set(), karton: 0, pcs: 0, amount: 0 };
        groups.set(l.group, g);
      }
      if (l.pcode) g.pcodes.add(l.pcode);
      g.outlets.add(l.outlet);
      g.karton += l.karton;
      g.pcs += l.qtypcs;
      g.amount += l.amount;
    }

    S.outlets = outlets;
    S.groups = groups;
    S.totalOutlet = outlets.size;
  }

  // ---------- Rendering ----------

  const fmtInt = (n) => Math.round(n).toLocaleString("id-ID");
  const fmtKar = (n) => n.toLocaleString("id-ID", { maximumFractionDigits: 1 });
  // Angka besar di kartu ringkasan dipadatkan supaya tetap satu baris.
  function fmtShort(n) {
    const a = Math.abs(n);
    if (a >= 1e12) return (n / 1e12).toLocaleString("id-ID", { maximumFractionDigits: 1 }) + " T";
    if (a >= 1e9)  return (n / 1e9).toLocaleString("id-ID",  { maximumFractionDigits: 1 }) + " M";
    if (a >= 1e6)  return (n / 1e6).toLocaleString("id-ID",  { maximumFractionDigits: 1 }) + " jt";
    if (a >= 1e4)  return (n / 1e3).toLocaleString("id-ID",  { maximumFractionDigits: 1 }) + " rb";
    return fmtInt(n);
  }

  function renderSummary() {
    const total = S.totalOutlet;
    const nGroups = S.groups.size;
    let totKar = 0, totAmt = 0, sumGroupsPerOutlet = 0;
    for (const o of S.outlets.values()) { totKar += o.karton; totAmt += o.amount; sumGroupsPerOutlet += o.groups.size; }
    const avg = total ? sumGroupsPerOutlet / total : 0;
    const card = (num, label, tone, sub) =>
      `<div class="stat ${tone || ""}"><b>${num}${sub ? ` <small>${sub}</small>` : ""}</b><span>${label}</span></div>`;
    $("d2Summary").innerHTML = [
      card(fmtInt(total), "Outlet transaksi", "info"),
      card(fmtInt(nGroups), "Grup produk", "ok"),
      card(fmtKar(avg), "Rata-rata produk / outlet", "warn"),
      card(fmtShort(totKar), "Total karton", "total", "karton"),
      card("Rp " + fmtShort(totAmt), "Total nilai", "total"),
    ].join("");
    $("d2Summary").lastElementChild.title = "Rp " + fmtInt(totAmt);
  }

  function renderCoverage() {
    const total = S.totalOutlet;
    const rows = [...S.groups.values()].sort((a, b) => b.outlets.size - a.outlets.size);
    S.coverageRows = rows;
    const tb = document.querySelector("#d2CoverageTable tbody");
    if (!rows.length) {
      tb.innerHTML = `<tr><td colspan="8" class="empty">Tidak ada data untuk filter ini.</td></tr>`;
    } else {
      tb.innerHTML = rows.map((g) => {
        const beli = g.outlets.size;
        const belum = total - beli;
        const pct = total ? (beli / total * 100) : 0;
        const tone = pct >= 60 ? "cov-hi" : pct >= 25 ? "cov-mid" : "cov-lo";
        return `<tr>
          <td><b>${window.M3.escapeHtml(g.group)}</b></td>
          <td class="mono" title="${window.M3.escapeHtml([...g.pcodes].join(", "))}">${g.pcodes.size}</td>
          <td class="mono">${fmtInt(beli)}</td>
          <td class="mono">${fmtInt(belum)}</td>
          <td><span class="cov ${tone}">${pct.toFixed(1)}%</span>
              <span class="covbar"><i style="width:${pct.toFixed(1)}%"></i></span></td>
          <td class="mono">${fmtKar(g.karton)}</td>
          <td class="mono">${fmtInt(g.pcs)}</td>
          <td class="mono">${fmtInt(g.amount)}</td>
        </tr>`;
      }).join("");
    }
    $("d2CoverageCount").textContent = `${rows.length} grup · ${fmtInt(total)} outlet`;
  }

  function selectedProducts() {
    return new Set([...document.querySelectorAll(".d2ProdukItem")].filter((c) => c.checked).map((c) => c.value));
  }

  function computeGap() {
    const picked = selectedProducts();
    const mode = $("d2GapMode").value;
    const q = $("d2Search").value.trim().toLowerCase();
    // Kalau belum pilih produk, pakai semua grup.
    const target = picked.size ? picked : new Set(S.groups.keys());

    const out = [];
    for (const o of S.outlets.values()) {
      const missing = [...target].filter((g) => !o.groups.has(g));
      let keep;
      if (mode === "ALL") keep = missing.length === target.size;        // belum beli semuanya
      else if (mode === "BOUGHT") keep = missing.length === 0;          // sudah beli semua terpilih
      else keep = missing.length > 0;                                   // ANY: belum beli salah satu
      if (!keep) continue;
      if (q) {
        const hay = [o.id, o.nama, o.salesman, o.rayon].map((x) => String(x || "").toLowerCase()).join(" ");
        if (!hay.includes(q)) continue;
      }
      out.push({ ...o, missing });
    }
    out.sort((a, b) => b.missing.length - a.missing.length || String(a.id).localeCompare(String(b.id)));
    S.gapRows = out;
    S.gapPage = 1;
  }

  function renderGap() {
    const rows = S.gapRows;
    const pageSize = 100;
    const pages = Math.max(1, Math.ceil(rows.length / pageSize));
    if (S.gapPage > pages) S.gapPage = pages;
    const slice = rows.slice((S.gapPage - 1) * pageSize, S.gapPage * pageSize);
    const tb = document.querySelector("#d2GapTable tbody");
    if (!slice.length) {
      tb.innerHTML = `<tr><td colspan="8" class="empty">Tidak ada outlet yang cocok dengan filter ini.</td></tr>`;
    } else {
      tb.innerHTML = slice.map((o) => {
        const miss = o.missing.length > 4
          ? o.missing.slice(0, 4).map((m) => `<span class="pgap">${window.M3.escapeHtml(m)}</span>`).join(" ") +
            ` <span class="pmore">+${o.missing.length - 4} lagi</span>`
          : o.missing.map((m) => `<span class="pgap">${window.M3.escapeHtml(m)}</span>`).join(" ") || "<span class='pnone'>— sudah beli semua —</span>";
        return `<tr>
          <td class="mono">${window.M3.escapeHtml(o.id)}</td>
          <td>${window.M3.escapeHtml(o.nama)}</td>
          <td>${window.M3.escapeHtml(o.salesman)}</td>
          <td class="mono">${window.M3.escapeHtml(o.rayon)}</td>
          <td>${miss}</td>
          <td class="mono">${o.groups.size}</td>
          <td class="mono">${fmtKar(o.karton)}</td>
          <td class="mono">${fmtInt(o.amount)}</td>
        </tr>`;
      }).join("");
    }
    $("d2GapCount").textContent = `${fmtInt(rows.length)} outlet`;
    $("d2PageInfo").textContent = `Halaman ${S.gapPage} / ${pages}`;
    $("d2PrevPage").disabled = S.gapPage <= 1;
    $("d2NextPage").disabled = S.gapPage >= pages;
  }

  function refresh() {
    aggregate();
    renderSummary();
    renderCoverage();
    computeGap();
    renderGap();
  }

  // ---------- Multi-select plumbing (mirrors Dashboard 1) ----------

  function wireMulti(wrapId, btnId, menuId, allId, itemClass, labelId, noun, onChange) {
    const wrap = $(wrapId), btn = $(btnId), menu = $(menuId), all = $(allId), label = $(labelId);
    const items = () => document.querySelectorAll("." + itemClass);
    function updateLabel() {
      const list = [...items()];
      const on = list.filter((c) => c.checked);
      if (on.length === 0 || on.length === list.length) { label.textContent = "Semua " + noun; all.checked = true; }
      else if (on.length === 1) { label.textContent = on[0].parentElement.textContent.trim(); all.checked = false; }
      else { label.textContent = `${on.length} ${noun} dipilih`; all.checked = false; }
    }
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const willOpen = menu.hidden;
      document.querySelectorAll(".multi.open").forEach((el) => {
        if (el !== wrap) { el.classList.remove("open"); const m = el.querySelector(".multi-menu"); if (m) m.hidden = true; }
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
      if (!all.checked) e.preventDefault();
      items().forEach((c) => (c.checked = false));
      updateLabel();
      onChange();
    });
    return { updateLabel, items };
  }

  function fillList(listId, values, itemClass, ctrl, onChange) {
    $(listId).innerHTML = values.map((v) => {
      const safe = window.M3.escapeHtml(v);
      return `<label class="multi-opt" data-name="${safe.toLowerCase()}"><input type="checkbox" value="${safe}" class="${itemClass}" /> ${safe}</label>`;
    }).join("");
    $(listId).querySelectorAll("." + itemClass).forEach((c) =>
      c.addEventListener("change", () => { ctrl.updateLabel(); onChange(); })
    );
    ctrl.updateLabel();
  }

  // ---------- Public API used by app.js ----------

  const S = {
    lines: [], dmpIndex: new Map(),
    outlets: new Map(), groups: new Map(),
    coverageRows: [], gapRows: [], gapPage: 1, totalOutlet: 0,
  };

  let wired = false;
  function wireOnce() {
    if (wired) return;
    wired = true;

    const smCtrl = wireMulti("d2FilterSalesman", "d2FilterSalesmanBtn", "d2FilterSalesmanMenu",
      "d2FilterSalesmanAll", "d2SalesmanItem", "d2FilterSalesmanLabel", "salesman", refresh);
    const pdCtrl = wireMulti("d2FilterPeriode", "d2FilterPeriodeBtn", "d2FilterPeriodeMenu",
      "d2FilterPeriodeAll", "d2PeriodeItem", "d2FilterPeriodeLabel", "periode", refresh);
    const prCtrl = wireMulti("d2FilterProduk", "d2FilterProdukBtn", "d2FilterProdukMenu",
      "d2FilterProdukAll", "d2ProdukItem", "d2FilterProdukLabel", "produk",
      () => { computeGap(); renderGap(); });
    S.ctrls = { smCtrl, pdCtrl, prCtrl };

    $("d2FilterSalesmanSearch").addEventListener("input", (e) => {
      const q = e.target.value.trim().toLowerCase();
      $("d2FilterSalesmanList").querySelectorAll(".multi-opt").forEach((el) => {
        el.style.display = !q || el.getAttribute("data-name").includes(q) ? "" : "none";
      });
    });
    $("d2FilterProdukSearch").addEventListener("input", (e) => {
      const q = e.target.value.trim().toLowerCase();
      $("d2FilterProdukList").querySelectorAll(".multi-opt").forEach((el) => {
        el.style.display = !q || el.getAttribute("data-name").includes(q) ? "" : "none";
      });
    });

    $("d2InclRetur").addEventListener("change", refresh);
    $("d2GapMode").addEventListener("change", () => { computeGap(); renderGap(); });
    $("d2Search").addEventListener("input", window.M3.debounce(() => { computeGap(); renderGap(); }, 200));
    $("d2PrevPage").addEventListener("click", () => { if (S.gapPage > 1) { S.gapPage--; renderGap(); } });
    $("d2NextPage").addEventListener("click", () => { S.gapPage++; renderGap(); });

    $("d2ExportCoverage").addEventListener("click", () => {
      if (!S.coverageRows.length) return;
      const total = S.totalOutlet;
      const rows = S.coverageRows.map((g) => ({
        "Grup Produk": g.group,
        "Jumlah Kode Barang": g.pcodes.size,
        "Kode Barang": [...g.pcodes].join(", "),
        "Outlet Beli": g.outlets.size,
        "Outlet Belum Beli": total - g.outlets.size,
        "Coverage %": total ? +(g.outlets.size / total * 100).toFixed(2) : 0,
        "Total Karton": +g.karton.toFixed(2),
        "Total Pcs": g.pcs,
        "Total Nilai": g.amount,
      }));
      const ws = XLSX.utils.json_to_sheet(rows);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Coverage");
      XLSX.writeFile(wb, `coverage-produk-${new Date().toISOString().slice(0, 10)}.xlsx`);
    });

    $("d2ExportGap").addEventListener("click", () => {
      if (!S.gapRows.length) return;
      const rows = S.gapRows.map((o) => ({
        "Kode Outlet": o.id,
        "Nama Outlet": o.nama,
        Salesman: o.salesman,
        Rayon: o.rayon,
        "Jumlah Produk Belum Dibeli": o.missing.length,
        "Produk Belum Dibeli": o.missing.join(", "),
        "Jumlah Grup Dibeli": o.groups.size,
        "Total Karton": +o.karton.toFixed(2),
        "Total Nilai": o.amount,
      }));
      const ws = XLSX.utils.json_to_sheet(rows);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Outlet Belum Transaksi");
      XLSX.writeFile(wb, `outlet-belum-transaksi-${new Date().toISOString().slice(0, 10)}.xlsx`);
    });
  }

  window.M3D2 = {
    async process(file, dmpIndex) {
      window.M3.setStatus("Membaca LBP...");
      const { lines, periodes } = await parseLbp(file);
      S.lines = lines;
      S.dmpIndex = dmpIndex || new Map();
      wireOnce();

      // Populate filters from data
      aggregate();
      const salesmen = [...new Set([...S.outlets.values()].map((o) => o.salesman).filter(Boolean))].sort();
      fillList("d2FilterSalesmanList", salesmen, "d2SalesmanItem", S.ctrls.smCtrl, refresh);
      fillList("d2FilterPeriodeList", periodes, "d2PeriodeItem", S.ctrls.pdCtrl, refresh);
      const groupNames = [...S.groups.keys()].sort();
      fillList("d2FilterProdukList", groupNames, "d2ProdukItem", S.ctrls.prCtrl, () => { computeGap(); renderGap(); });

      refresh();
      $("d2ResultSection").classList.remove("hidden");
      return `LBP ${fmtInt(lines.length)} baris → ${fmtInt(S.groups.size)} produk, ${fmtInt(S.outlets.size)} outlet`;
    },
    reset() {
      S.lines = []; S.outlets = new Map(); S.groups = new Map();
      S.coverageRows = []; S.gapRows = []; S.gapPage = 1; S.totalOutlet = 0;
      const rs = $("d2ResultSection");
      if (rs) rs.classList.add("hidden");
    },
    // exposed for tests
    _normalizeProduct: normalizeProduct,
    _parseIsi: parseIsi,
  };
})();
