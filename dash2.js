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

  // Kolom LBP disimpan sebagai typed array + kamus string (interning).
  // 400rb baris sebagai objek makan ~200 MB dan bikin HP kehabisan memori;
  // versi ini sekitar 15 MB karena kode outlet/produk/salesman sangat berulang.
  function makeStore() {
    const dict = { outlet: new Map(), pcode: new Map(), group: new Map(), sls: new Map(), pd: new Map() };
    const list = { outlet: [], pcode: [], group: [], sls: [], pd: [] };
    // Nama & salesman dari LBP per outlet — dipakai kalau outlet tidak ada di DMP.
    const outletNama = [];
    const lbpSalesmanOf = [];
    const intern = (k, v) => {
      let i = dict[k].get(v);
      if (i === undefined) { i = list[k].length; list[k].push(v); dict[k].set(v, i); }
      return i;
    };
    return { dict, list, outletNama, lbpSalesmanOf, intern };
  }

  function growAll(c, cap) {
    const grow = (arr, T) => { const n = new T(cap); n.set(arr); return n; };
    c.outlet = grow(c.outlet, Int32Array);
    c.pcode  = grow(c.pcode,  Int32Array);
    c.group  = grow(c.group,  Int32Array);
    c.sls    = grow(c.sls,    Int32Array);
    c.pd     = grow(c.pd,     Int32Array);
    c.qty    = grow(c.qty,    Float64Array);
    c.karton = grow(c.karton, Float64Array);
    c.amount = grow(c.amount, Float64Array);
    c.retur  = grow(c.retur,  Uint8Array);
    c.cap = cap;
  }

  function newCols(cap) {
    return {
      n: 0, cap,
      outlet: new Int32Array(cap), pcode: new Int32Array(cap), group: new Int32Array(cap),
      sls: new Int32Array(cap), pd: new Int32Array(cap),
      qty: new Float64Array(cap), karton: new Float64Array(cap), amount: new Float64Array(cap),
      retur: new Uint8Array(cap),
    };
  }

  function pushLine(store, c, ix, get) {
    const outlet = get(ix.outlet);
    if (!outlet) return;
    if (c.n === c.cap) growAll(c, Math.ceil(c.cap * 1.6));
    const isi = parseIsi(get(ix.kemasan));
    const qtypcs = num(get(ix.qty));
    const oi = store.intern("outlet", outlet);
    const sls = get(ix.sls);
    if (store.outletNama[oi] === undefined) {
      store.outletNama[oi] = get(ix.nama);
      store.lbpSalesmanOf[oi] = sls;
    }
    const i = c.n++;
    c.outlet[i] = oi;
    c.pcode[i]  = store.intern("pcode", get(ix.pcode));
    c.group[i]  = store.intern("group", groupOf(get(ix.produk)));
    c.sls[i]    = store.intern("sls", sls);
    c.pd[i]     = store.intern("pd", get(ix.periode));
    c.qty[i]    = qtypcs;
    c.karton[i] = isi > 0 ? qtypcs / isi : 0;   // kolom turunan: karton = QTYPCS / isi
    c.amount[i] = num(get(ix.amount));
    c.retur[i]  = get(ix.type).toUpperCase() === "R" ? 1 : 0;
  }

  async function parseLbp(file) {
    const store = makeStore();
    let c = newCols(1 << 16);

    // Jalur cepat: sumber teks → iterasi per baris, tanpa materialisasi AoA penuh.
    let text = await window.M3.readRawText(file);
    if (text !== null) {
      const firstNl = text.indexOf("\n");
      if (firstNl < 0) throw new Error("File LBP kosong.");
      const headLine = text.slice(0, firstNl).replace(/\r$/, "");
      const delim = window.M3.detectDelim(headLine);
      const ix = colIndexes(headLine.split(delim).map((s) => s.trim().toUpperCase()));
      let at = firstNl + 1;
      while (at < text.length) {
        let end = text.indexOf("\n", at);
        if (end < 0) end = text.length;
        const line = text.slice(at, end);
        at = end + 1;
        if (!line) continue;
        const p = line.split(delim);
        pushLine(store, c, ix, (i) => (i >= 0 && p[i] != null ? p[i].trim() : ""));
      }
      text = null;   // lepas string besar supaya bisa dibersihkan GC
    } else {
      // Sumber Excel → lewat AoA biasa.
      const rows = await window.M3.readAsAoA(file);
      if (!rows.length) throw new Error("File LBP kosong.");
      const ix = colIndexes(rows[0].map((s) => String(s == null ? "" : s).trim().toUpperCase()));
      for (let r = 1; r < rows.length; r++) {
        const row = rows[r];
        if (!row) continue;
        pushLine(store, c, ix, (i) => (i >= 0 && row[i] != null ? String(row[i]).trim() : ""));
      }
    }
    if (!c.n) throw new Error("File LBP tidak berisi baris data.");
    const periodes = store.list.pd.filter(Boolean).slice().sort((a, b) => num(a) - num(b));
    return { store, cols: c, periodes };
  }

  // ---------- Aggregation ----------

  function aggregate() {
    const inclRetur = $("d2InclRetur").checked;
    const sms = new Set([...document.querySelectorAll(".d2SalesmanItem")].filter((c) => c.checked).map((c) => c.value));
    const pds = new Set([...document.querySelectorAll(".d2PeriodeItem")].filter((c) => c.checked).map((c) => c.value));

    const c = S.cols, st = S.store;
    if (!c) { S.outlets = new Map(); S.groups = new Map(); S.totalOutlet = 0; return; }
    const L = st.list;

    // Identitas outlet (nama/salesman/rayon) dihitung sekali per outlet, bukan
    // per baris — DMP dipakai kalau ada, kalau tidak jatuh ke nilai dari LBP.
    if (!S.outletInfo) {
      S.outletInfo = L.outlet.map((id, oi) => {
        const d = S.dmpIndex.get(id);
        return {
          id,
          nama: (d && d.namaOutlet) || st.outletNama[oi] || "",
          salesman: (d && d.salesman) || st.lbpSalesmanOf[oi] || "",
          rayon: (d && d.rayon) || "",
        };
      });
    }
    const info = S.outletInfo;

    // Filter diterjemahkan jadi lookup indeks sekali di depan, supaya loop
    // per baris hanya membandingkan angka.
    const okOutlet = sms.size ? new Uint8Array(info.length) : null;
    if (okOutlet) for (let i = 0; i < info.length; i++) okOutlet[i] = sms.has(info[i].salesman) ? 1 : 0;
    const okPd = pds.size ? new Uint8Array(L.pd.length) : null;
    if (okPd) L.pd.forEach((v, i) => { okPd[i] = pds.has(v) ? 1 : 0; });

    const outlets = new Map();   // outletId -> { id, nama, salesman, rayon, groups:Set, karton, amount }
    const groups = new Map();    // grup -> { group, pcodes:Set, outlets:Set, karton, pcs, amount }

    for (let i = 0; i < c.n; i++) {
      if (!inclRetur && c.retur[i]) continue;
      if (okPd && !okPd[c.pd[i]]) continue;
      const oi = c.outlet[i];
      if (okOutlet && !okOutlet[oi]) continue;

      const meta = info[oi];
      let o = outlets.get(meta.id);
      if (!o) {
        o = { ...meta, groups: new Set(), karton: 0, amount: 0 };
        outlets.set(meta.id, o);
      }
      const gName = L.group[c.group[i]];
      o.groups.add(gName);
      o.karton += c.karton[i];
      o.amount += c.amount[i];

      let g = groups.get(gName);
      if (!g) {
        g = { group: gName, pcodes: new Set(), outlets: new Set(), karton: 0, pcs: 0, amount: 0 };
        groups.set(gName, g);
      }
      const pc = L.pcode[c.pcode[i]];
      if (pc) g.pcodes.add(pc);
      g.outlets.add(meta.id);
      g.karton += c.karton[i];
      g.pcs += c.qty[i];
      g.amount += c.amount[i];
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
    store: null, cols: null, outletInfo: null, dmpIndex: new Map(),
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
      const { store, cols, periodes } = await parseLbp(file);
      S.store = store;
      S.cols = cols;
      S.outletInfo = null;
      S.dmpIndex = dmpIndex || new Map();
      wireOnce();

      // Populate filters from data
      aggregate();
      const salesmen = [...new Set(S.outletInfo.map((o) => o.salesman).filter(Boolean))].sort();
      fillList("d2FilterSalesmanList", salesmen, "d2SalesmanItem", S.ctrls.smCtrl, refresh);
      fillList("d2FilterPeriodeList", periodes, "d2PeriodeItem", S.ctrls.pdCtrl, refresh);
      const groupNames = [...S.groups.keys()].sort();
      fillList("d2FilterProdukList", groupNames, "d2ProdukItem", S.ctrls.prCtrl, () => { computeGap(); renderGap(); });

      refresh();
      $("d2ResultSection").classList.remove("hidden");
      return `LBP ${fmtInt(cols.n)} baris → ${fmtInt(S.groups.size)} produk, ${fmtInt(S.outlets.size)} outlet`;
    },
    reset() {
      S.store = null; S.cols = null; S.outletInfo = null;
      S.outlets = new Map(); S.groups = new Map();
      S.coverageRows = []; S.gapRows = []; S.gapPage = 1; S.totalOutlet = 0;
      const rs = $("d2ResultSection");
      if (rs) rs.classList.add("hidden");
    },
    // exposed for tests
    _normalizeProduct: normalizeProduct,
    _parseIsi: parseIsi,
  };
})();
