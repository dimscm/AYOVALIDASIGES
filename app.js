(() => {
  const $ = (id) => document.getElementById(id);
  const state = {
    ediRows: [],
    hhtRows: [],
    scanIndex: new Map(),
    dmpIndex: new Map(),
    results: [],
    filtered: [],
    titikByOutlet: new Map(),
    barcodeByOutlet: new Map(),
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

  // Kolom "Masalah Outlet": menjawab satu pertanyaan yang selama ini harus
  // dirangkai sendiri dari dua kolom — masalahnya di radius, di barcode, atau
  // dua-duanya, dan apakah selalu begitu atau kadang-kadang saja.
  //   "Inkonsisten"         = kadang benar kadang salah -> paling layak ditanya
  //                           ke salesman, karena buktinya ada di dua sisi.
  //   "Konsisten bermasalah" = tidak pernah benar sekali pun di periode ini.
  // Outlet yang kedua sisinya aman sengaja dibiarkan kosong, supaya yang perlu
  // dikerjakan langsung menonjol.
  const MASALAH_INFO = {
    MIX_R:    { label: "Inkonsisten radius", tone: "mix",
                hint: "Kunjungan ke outlet ini kadang IN RADIUS kadang tidak. Barcodenya aman." },
    MIX_B:    { label: "Inkonsisten barcode", tone: "mix",
                hint: "Barcode outlet ini kadang berhasil discan kadang tidak. Radiusnya aman." },
    MIX_RB:   { label: "Inkonsisten keduanya", tone: "mix",
                hint: "Radius maupun barcode sama-sama kadang benar kadang tidak." },
    TETAP_R:  { label: "Konsisten bermasalah radius", tone: "tetap",
                hint: "Tidak ada satu pun kunjungan yang IN RADIUS. Barcodenya aman." },
    TETAP_B:  { label: "Konsisten bermasalah barcode", tone: "tetap",
                hint: "Barcodenya tidak pernah sekali pun berhasil discan. Radiusnya aman." },
    TETAP_RB: { label: "Konsisten bermasalah keduanya", tone: "tetap",
                hint: "Tidak pernah IN RADIUS, dan barcodenya tidak pernah berhasil discan." },
    CAMPUR_R: { label: "Konsisten bermasalah radius + inkonsisten barcode", tone: "tetap",
                hint: "Radius tidak pernah lolos; barcodenya kadang berhasil kadang tidak." },
    CAMPUR_B: { label: "Konsisten bermasalah barcode + inkonsisten radius", tone: "tetap",
                hint: "Barcode tidak pernah berhasil; radiusnya kadang lolos kadang tidak." },
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
    // Penulisan kolom flag berbeda-beda antar area. "FLAG" ditaruh paling
    // belakang karena paling mudah tertukar dengan kolom lain yang berawalan
    // sama (FLAG GROUPPAYER).
    flagRadius:  ["FLAG RADIUS", "FLAGRADIUS", "FLAG_RADIUS", "RADIUS FLAG",
                  "STATUS RADIUS", "IN RADIUS", "FLAG IN RADIUS", "FLAG VALIDASI",
                  "VALIDASI RADIUS", "FLAG"],
    distance:    ["DISTANCE"],
    setting:     ["SETTING", "RADIUS"],
    latVisit:    ["LAT VISIT", "LATITUDE VISIT", "LAT KUNJUNGAN", "LAT ABSEN", "LATVISIT"],
    longVisit:   ["LONG VISIT", "LONGITUDE VISIT", "LNG VISIT", "LONG KUNJUNGAN",
                  "LONG ABSEN", "LONGVISIT"],
    latVal:      ["LAT VAL", "LATITUDE VAL", "LAT VALIDASI", "LAT OUTLET", "LAT MASTER"],
    longVal:     ["LONG VAL", "LONGITUDE VAL", "LNG VAL", "LONG VALIDASI",
                  "LONG OUTLET", "LONG MASTER"],
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

  // Judul kolom dibandingkan dua kali: apa adanya, lalu setelah semua tanda
  // baca dan spasi dibuang. Tanpa langkah kedua, "FLAG_RADIUS", "FLAG-RADIUS",
  // dan "FlagRadius" dianggap kolom yang sama sekali berbeda dari "FLAG RADIUS"
  // — kolomnya tidak ketemu, isinya terbaca kosong, dan seluruh kunjungan jatuh
  // ke BLANK tanpa satu pun pesan. Yang dibuang cuma pemisah, bukan hurufnya,
  // jadi kolom yang memang berbeda tetap tidak akan salah dipasangkan.
  const kunciKolom = (s) => normalizeHeader(s).replace(/[^A-Z0-9]/g, "");

  function buildColIndex(headerRow, colMap) {
    const idx = {};
    const norm = headerRow.map(normalizeHeader);
    const rapat = headerRow.map(kunciKolom);
    for (const [key, aliases] of Object.entries(colMap)) {
      idx[key] = -1;
      for (const alias of aliases) {
        const at = norm.indexOf(normalizeHeader(alias));
        if (at >= 0) { idx[key] = at; break; }
      }
      if (idx[key] >= 0) continue;
      for (const alias of aliases) {
        const at = rapat.indexOf(kunciKolom(alias));
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
    // Kolom yang tidak ketemu dicatat beserta judul kolom yang BENAR-BENAR ada
    // di file. Tanpa ini, kolom yang namanya berbeda cuma terbaca kosong dan
    // tidak ada cara tahu file itu menyebutnya apa — satu-satunya jalan
    // mengirim filenya ke orang lain untuk dilihat.
    state.ediHeader = header.map((h) => String(h == null ? "" : h).trim()).filter(Boolean);
    state.ediKolomTakKetemu = ["flagRadius", "visitDate", "latVisit", "longVisit",
                               "latVal", "longVal", "setting", "distance"]
      .filter((k) => idx[k] < 0);
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
        setting: row[idx.setting],
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

  // Nilai flag tidak selalu 0/1. Sebagian area menulisnya sebagai kata
  // ("IN RADIUS" / "OUT RADIUS", "Y" / "N"). Kalau kata-kata itu dibiarkan apa
  // adanya, nilainya bukan "1" dan bukan "0", jadi seluruh kunjungan dihitung
  // BLANK — terbaca seperti tidak ada validasi sama sekali.
  const FLAG_KATA = {
    IN: "1", INRADIUS: "1", Y: "1", YA: "1", YES: "1", TRUE: "1", VALID: "1", OK: "1",
    OUT: "0", OUTRADIUS: "0", N: "0", NO: "0", TIDAK: "0", FALSE: "0",
    INVALID: "0", TIDAKVALID: "0",
  };

  function normalizeFlag(v) {
    if (v === null || v === undefined || v === "") return "";
    const s = String(v).trim();
    if (s === "" || s === "-") return ""; // BLANK
    const n = Number(s);
    if (!Number.isNaN(n)) return String(Math.trunc(n));
    const kata = s.toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (FLAG_KATA[kata]) return FLAG_KATA[kata];
    return s;
  }

  // Judul kolom dicari dengan longgar: cocok persis dulu, baru awalan, baru
  // "mengandung". Perlu karena penulisannya berbeda-beda antar sumber ("No
  // Outlet", "No. Outlet", "Kode Outlet"), apalagi kalau berasal dari PDF yang
  // judulnya hasil susun ulang.
  function cariKolom(header, alias) {
    for (const a of alias) { const i = header.indexOf(a); if (i >= 0) return i; }
    for (const a of alias) {
      const i = header.findIndex((h) => h && h.startsWith(a));
      if (i >= 0) return i;
    }
    for (const a of alias) {
      const i = header.findIndex((h) => h && h.includes(a));
      if (i >= 0) return i;
    }
    return -1;
  }

  function parseHht(aoa) {
    const ALIAS = {
      outlet: ["NO OUTLET", "NO. OUTLET", "NOOUTLET", "KODE OUTLET", "CUSTNO", "OUTLET"],
      nama:   ["NAMA OUTLET", "NAMA TOKO", "NAMAOUTLET", "NAMA"],
      hht:    ["HHT"],
      tipe:   ["TIPE SCAN", "TIPESCAN", "JENIS SCAN", "TYPE SCAN"],
      call:   ["CALL"],
      alasan: ["ALASAN", "KETERANGAN", "REASON"],
      jamIn:  ["JAM MASUK", "JAM IN", "JAMMASUK"],
      jamOut: ["JAM KELUAR", "JAM OUT", "JAMKELUAR"],
      sls:    ["SALESMAN", "NAMA SALESMAN"],
      sf:     ["SALESFORCE", "KODE SALESFORCE"],
      tgl:    ["TANGGAL", "TGL", "DATE"],
    };
    // Judul kolom di PDF sering terbelah 2-3 baris karena kolomnya sempit
    // ("No" di atas, "Outlet" di bawahnya). Jadi selain baris tunggal, gabungan
    // beberapa baris berurutan juga dicoba.
    const gabungBaris = (mulai, banyak) => {
      const out = [];
      for (let k = 0; k < banyak; k++) {
        const row = aoa[mulai + k] || [];
        for (let i = 0; i < row.length; i++) {
          const v = String(row[i] == null ? "" : row[i]).trim();
          if (!v) continue;
          out[i] = out[i] ? out[i] + " " + v : v;
        }
      }
      return out.map(normalizeHeader);
    };
    const cocokHeader = (norm) =>
      norm.some((h) => h && h.includes("OUTLET")) &&
      norm.some((h) => h && (h === "HHT" || h.includes("SCAN")));

    // Jangan ambil kandidat PERTAMA yang lolos. Baris preamble laporan memuat
    // teks seperti "Tipe Scan : ALL" dan "Pilihan Data", sehingga ikut lolos
    // pemeriksaan dasar dan pencarian berhenti terlalu awal. Yang dipilih adalah
    // kandidat yang paling banyak menghasilkan kolom BERBEDA — baris judul yang
    // asli mengenali hampir semua kolom, sedangkan preamble hanya sedikit.
    let headerAt = -1, header = null, skorTerbaik = 0;
    const kunciAlias = Object.keys(ALIAS);
    for (let r = 0; r < Math.min(aoa.length, 300); r++) {
      for (let n = 1; n <= 3 && r + n <= aoa.length; n++) {
        const norm = gabungBaris(r, n);
        if (!cocokHeader(norm)) continue;
        const dipakai = new Set();
        for (const k of kunciAlias) {
          const i = cariKolom(norm, ALIAS[k]);
          if (i >= 0) dipakai.add(i);
        }
        if (dipakai.size > skorTerbaik) {
          skorTerbaik = dipakai.size; headerAt = r + n - 1; header = norm;
        }
      }
    }
    if (headerAt < 0) {
      // Sebutkan apa yang benar-benar terbaca. Pesan "tidak dikenali" saja bikin
      // pengguna mengira filenya tidak terbaca, padahal isinya terbaca tapi
      // judul kolomnya tidak ketemu.
      const potong = (t, n) => (t.length > n ? t.slice(0, n - 1) + "…" : t);
      const contoh = aoa.slice(0, 3)
        .map((r) => potong((r || []).filter((c) => String(c).trim()).slice(0, 8).join(" | "), 90))
        .filter(Boolean);
      return { rows: [], warn: "Judul kolom HHT tidak ketemu — butuh kolom yang memuat "
        + "\"Outlet\" dan \"HHT\"/\"Scan\". Yang terbaca di awal file: "
        + (contoh.length ? contoh.map((c) => `[${c}]`).join(" ") : "(kosong)") };
    }
    const iOutlet = cariKolom(header, ALIAS.outlet);
    const iName = cariKolom(header, ALIAS.nama);
    const iHht = cariKolom(header, ALIAS.hht);
    const iTipe = cariKolom(header, ALIAS.tipe);
    const iCall = cariKolom(header, ALIAS.call);
    const iAlasan = cariKolom(header, ALIAS.alasan);
    const iJamIn = cariKolom(header, ALIAS.jamIn);
    const iJamOut = cariKolom(header, ALIAS.jamOut);
    const iSls = cariKolom(header, ALIAS.sls);
    const iSalesforce = cariKolom(header, ALIAS.sf);
    const iTanggal = cariKolom(header, ALIAS.tgl);
    // Forward-fill kolom yang di-merge di Excel (Salesman, Salesforce, Tanggal
    // hanya muncul di baris pertama per grup).
    let lastSls = "", lastSalesforce = "", lastTanggal = "";
    const rows = [];
    // Laporan berhalaman biasanya mengulang baris judul kolom di tiap halaman.
    // Kalau ikut dibaca sebagai data, teks "Tanggal" akan menimpa tanggal yang
    // sedang di-forward-fill, dan seluruh baris sesudahnya kehilangan tanggal.
    const isBarisHeader = (row) => {
      const v = normalizeHeader(row[iOutlet]);
      return v === "NO OUTLET" || v === "NOOUTLET";
    };
    for (let r = headerAt + 1; r < aoa.length; r++) {
      const row = aoa[r] || [];
      if (isBarisHeader(row)) continue;
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
    // Kode cabang dari baris judul laporan ("... (DETAIL) 103686 - PT.CIPTA
    // NIAGA SEMESTA ..."). Dipakai untuk memberi tahu kalau file HHT dan EDI
    // ternyata dari cabang yang berbeda — tanpa angka ini, pesannya cuma bisa
    // menduga, dan yang membaca tidak punya cara memeriksanya.
    let cabang = "";
    for (let r = 0; r < Math.min(headerAt, 10); r++) {
      const teks = (aoa[r] || []).map((c) => String(c == null ? "" : c)).join(" ");
      const m = teks.match(/\b(\d{5,6})\s*-\s*\S/);
      if (m) { cabang = m[1]; break; }
    }
    return { rows, cabang };
  }

  // Tanggal EDI ("24/08/2026", serial Excel, Date) dan HHT ("29 JUL") ditulis
  // dengan bentuk berbeda, dan HHT sering tidak menulis tahun. Supaya bisa
  // dijodohkan, keduanya diringkas jadi kunci "dd-mm".
  const BULAN = {
    JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, MEI: 5, JUN: 6, JUL: 7,
    AUG: 8, AGT: 8, AGU: 8, SEP: 9, OCT: 10, OKT: 10, NOV: 11, DEC: 12, DES: 12,
  };
  const pad2 = (n) => String(n).padStart(2, "0");

  function tglKunci(v) {
    if (v === null || v === undefined || v === "") return "";
    if (v instanceof Date) return pad2(v.getDate()) + "-" + pad2(v.getMonth() + 1);
    if (typeof v === "number") {
      // Serial Excel: hari sejak 30 Des 1899.
      const d = new Date(Date.UTC(1899, 11, 30) + v * 86400000);
      return pad2(d.getUTCDate()) + "-" + pad2(d.getUTCMonth() + 1);
    }
    const s = String(v).trim().toUpperCase();
    let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);          // 2026-08-24
    if (m) return pad2(+m[3]) + "-" + pad2(+m[2]);
    m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})/);                 // 24/08/2026
    if (m) return pad2(+m[1]) + "-" + pad2(+m[2]);
    m = s.match(/^(\d{1,2})[\s-]+([A-Z]{3})/);                 // 29 JUL
    if (m && BULAN[m[2]]) return pad2(+m[1]) + "-" + pad2(BULAN[m[2]]);
    return "";
  }

  // Alasan dari HHT detail (mis. "B4-Order By Phone", "B6-Tertutup Barang").
  // Nilai " -" / "-" berarti tidak ada alasan tercatat.
  // tglKunci() hanya menghasilkan "dd-mm" — cukup untuk mencocokkan HHT dalam
  // satu tahun, tapi tidak bisa diurutkan lintas tahun. Untuk menyaring rentang
  // tanggal dan mengurutkan riwayat titik, dibutuhkan tanggal utuh.
  function tglIso(v) {
    if (v === null || v === undefined || v === "") return "";
    if (v instanceof Date)
      return v.getFullYear() + "-" + pad2(v.getMonth() + 1) + "-" + pad2(v.getDate());
    if (typeof v === "number") {
      const d = new Date(Date.UTC(1899, 11, 30) + v * 86400000);
      return d.getUTCFullYear() + "-" + pad2(d.getUTCMonth() + 1) + "-" + pad2(d.getUTCDate());
    }
    const s = String(v).trim().toUpperCase();
    let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);            // 2026-08-24
    if (m) return m[1] + "-" + pad2(+m[2]) + "-" + pad2(+m[3]);
    m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/); // 24/08/2026
    if (m) {
      const th = m[3].length === 2 ? "20" + m[3] : m[3];
      return th + "-" + pad2(+m[2]) + "-" + pad2(+m[1]);
    }
    m = s.match(/^(\d{1,2})[\s-]+([A-Z]{3})[\s-]*(\d{4})?/);    // 29 JUL 2026
    if (m && BULAN[m[2]])
      return (m[3] || new Date().getFullYear()) + "-" + pad2(BULAN[m[2]]) + "-" + pad2(+m[1]);
    return "";
  }

  function alasanHht(r) {
    if (!r.hht) return "";
    const a = String(r.hht.alasan || "").trim();
    if (!a || a === "-" || a === "—") return "";
    return a;
  }

  // Kolom alasan yang kosong itu membingungkan: pengguna tidak tahu apakah
  // datanya memang tidak ada, atau webnya yang gagal. Jadi sebabnya ditulis.
  function alasanSel(r) {
    if (!state.hhtFile) return '<span class="nil">HHT tidak diupload</span>';
    const a = alasanHht(r);
    if (a) return escapeHtml(a);
    if (r.hht) return '<span class="nil">tidak dicatat di HHT</span>';
    // Tidak ada baris HHT di tanggal kunjungan ini, tapi outlet yang sama punya
    // alasan di tanggal lain. Ditampilkan sebagai petunjuk, dengan tanggal
    // asalnya, supaya tidak dikira bukti hari itu.
    if (r.alasanLuar) {
      const t = r.alasanLuar.tgl;
      return escapeHtml(r.alasanLuar.alasan)
        + ` <span class="pinjam" title="Dari catatan HHT outlet ini di tanggal lain, bukan tanggal kunjungan ini">`
        + `${t ? escapeHtml(t) : "tanggal lain"}</span>`;
    }
    if (r.hhtNote === "beda-tanggal") return '<span class="nil">tanggal ini tidak ada di HHT</span>';
    return '<span class="nil">outlet tidak ada di HHT</span>';
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
  // Memecah satu baris teks jadi kolom, mengikuti aturan CSV: tanda kutip
  // membungkus isi kolom, dan dua kutip berturut-turut di dalamnya berarti satu
  // kutip harfiah. Baris tanpa tanda kutip sama sekali dipecah dengan split
  // biasa — jalur cepat yang penting untuk file EDI ratusan ribu baris.
  function pecahBaris(line, delim) {
    if (line.indexOf('"') < 0) return line.split(delim);
    const out = [];
    let i = 0;
    while (i <= line.length) {
      // Tanda kutip hanya dianggap pembungkus kalau ada TEPAT di awal kolom.
      // Kutip yang muncul di tengah isi — nama toko seperti TOKO 5" atau
      // alamat yang memuat inci — adalah huruf biasa. Kalau setiap kutip
      // dianggap pembungkus, satu kutip nyasar menelan pemisah sesudahnya dan
      // menggeser SELURUH kolom di baris itu tanpa jejak: rayon terbaca "113",
      // outlet pindah salesman, dan tidak ada yang kelihatan rusak.
      if (line[i] === '"') {
        let isi = "";
        i++;
        while (i < line.length) {
          if (line[i] === '"') {
            if (line[i + 1] === '"') { isi += '"'; i += 2; continue; }
            i++; break;
          }
          isi += line[i++];
        }
        // Sisa sampai pemisah berikutnya diabaikan (spasi, atau isi cacat).
        while (i < line.length && line[i] !== delim) i++;
        out.push(isi);
      } else {
        let j = line.indexOf(delim, i);
        if (j < 0) j = line.length;
        out.push(line.slice(i, j));
        i = j;
      }
      if (i >= line.length) break;
      i++;   // lewati pemisah
      if (i === line.length) { out.push(""); break; }
    }
    return out;
  }

  // Pemisah kolom ditebak dari yang PALING SERING muncul di baris judul, bukan
  // dari yang kebetulan ada duluan. Baris judul isinya nama kolom, jadi aman
  // dihitung apa adanya: nama kolom tidak memuat pemisah.
  function tebakPemisah(firstLine) {
    let terbaik = "|", skor = 0;
    for (const d of ["|", "\t", ";", ","]) {
      let n = 0;
      for (let i = 0; i < firstLine.length; i++) if (firstLine[i] === d) n++;
      if (n > skor) { skor = n; terbaik = d; }
    }
    return terbaik;
  }

  function parseDelimitedText(text) {
    if (!text) return [];
    const firstNl = text.indexOf("\n");
    const firstLine = (firstNl < 0 ? text : text.slice(0, firstNl)).replace(/\r$/, "");
    const delim = tebakPemisah(firstLine);
    const rows = [];
    let at = 0;
    while (at < text.length) {
      let end = text.indexOf("\n", at);
      if (end < 0) end = text.length;
      const line = text.slice(at, end).replace(/\r$/, "");
      at = end + 1;
      if (!line) continue;
      rows.push(pecahBaris(line, delim));
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
    pdf:   [0x25, 0x50, 0x44, 0x46],                         // "%PDF"
  };

  async function sniff(src) {
    const head = src instanceof Uint8Array
      ? src.subarray(0, 8)
      : new Uint8Array(await src.slice(0, 8).arrayBuffer());
    const is = (sig) => sig.every((b, i) => head[i] === b);
    if (is(SIG["7z"])) return "7z";
    if (is(SIG.gz)) return "gz";
    if (is(SIG.ole2)) return "xls";
    if (is(SIG.pdf)) return "pdf";
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
  const detectDelim = tebakPemisah;

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
    if (kind === "pdf") return await pdfToAoA(await bytesOf(src));

    const text = typeof src.text === "function"
      ? await src.text()
      : new TextDecoder("utf-8").decode(src);
    return parseDelimitedText(text);
  }

  // ---------- PDF ----------
  // PDF tidak menyimpan tabel, hanya potongan teks beserta koordinatnya. Jadi
  // barisnya disusun ulang dari posisi Y, dan kolomnya dari posisi X: semua
  // posisi X di seluruh halaman dikumpulkan lalu dikelompokkan jadi "titik
  // kolom", baru tiap potongan teks ditaruh di kolom terdekat. Cara ini bekerja
  // untuk laporan yang tercetak rapi berkolom seperti HHT.
  // pdf.js berukuran ~380 KB dan hanya dipakai kalau memang ada file PDF, jadi
  // baru diunduh saat dibutuhkan supaya halaman tetap ringan dibuka di HP.
  let pdfSiap = null;
  function muatPdfJs() {
    if (pdfSiap) return pdfSiap;
    pdfSiap = new Promise((resolve, reject) => {
      if (typeof pdfjsLib !== "undefined") return resolve();
      const el = document.createElement("script");
      el.src = "vendor/pdf.min.js";
      el.onload = () => (typeof pdfjsLib === "undefined"
        ? reject(new Error("Modul PDF gagal dimuat."))
        : resolve());
      el.onerror = () => reject(new Error("Modul PDF gagal dimuat."));
      document.head.appendChild(el);
    }).catch((e) => { pdfSiap = null; throw e; });
    return pdfSiap;
  }

  async function pdfToAoA(buf) {
    try {
      await muatPdfJs();
    } catch (e) {
      throw new Error("Modul PDF gagal dimuat. Pakai versi Excel/CSV dari HHT.");
    }
    pdfjsLib.GlobalWorkerOptions.workerSrc = "vendor/pdf.worker.min.js";
    const pdf = await pdfjsLib.getDocument({ data: buf, isEvalSupported: false }).promise;

    const pages = [];
    const tinggi = [];
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n);
      const tc = await page.getTextContent();
      const items = [];
      for (const it of tc.items) {
        const teks = String(it.str == null ? "" : it.str);
        if (!teks.trim()) continue;
        const x = it.transform[4], y = it.transform[5];
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        items.push({ teks, x, y, lebar: Number(it.width) || 0 });
        if (it.height) tinggi.push(it.height);
      }
      if (items.length) pages.push(items);
      page.cleanup();
    }
    if (!pages.length) {
      throw new Error("PDF ini tidak punya teks yang bisa dibaca — kemungkinan hasil scan/foto. "
        + "Perlu versi Excel/CSV-nya, atau PDF yang sudah di-OCR.");
    }

    const tengah = (a) => { const v = a.slice().sort((x, y) => x - y); return v[Math.floor(v.length / 2)]; };
    const tinggiBaris = tinggi.length ? tengah(tinggi) : 10;
    const tolBaris = Math.max(2, tinggiBaris * 0.6);
    // Jarak mendatar yang dianggap pindah sel. Spasi antar kata di dalam satu sel
    // lebih rapat daripada jarak antar kolom (kolom punya padding + garis).
    const tolSel = Math.max(2, tinggiBaris * 0.6);

    // 1) Susun baris memakai Y (Y di PDF dihitung dari bawah).
    const semuaBaris = [];
    for (const items of pages) {
      items.sort((a, b) => (b.y - a.y) || (a.x - b.x));
      let kini = null;
      for (const it of items) {
        if (kini && Math.abs(kini.y - it.y) <= tolBaris) kini.items.push(it);
        else { kini = { y: it.y, items: [it] }; semuaBaris.push(kini); }
      }
    }

    // 2) Di tiap baris, gabungkan potongan yang berdempetan jadi satu sel.
    //    pdf.js kerap memecah satu sel jadi beberapa potongan; kalau posisi X
    //    pecahan itu ikut dianggap awal kolom, kolom-kolom akan saling menempel.
    for (const b of semuaBaris) {
      b.items.sort((a, c) => a.x - c.x);
      const sel = [];
      for (const it of b.items) {
        const akhir = sel[sel.length - 1];
        if (akhir && it.x - (akhir.x + akhir.lebar) <= tolSel) {
          const perlu = !/\s$/.test(akhir.teks) && !/^\s/.test(it.teks)
            && it.x - (akhir.x + akhir.lebar) > tinggiBaris * 0.12;
          akhir.teks += (perlu ? " " : "") + it.teks;
          akhir.lebar = (it.x + it.lebar) - akhir.x;
        } else {
          sel.push({ x: it.x, lebar: it.lebar, teks: it.teks });
        }
      }
      b.sel = sel;
    }

    // 3) Titik kolom dikumpulkan dari awal SEL (bukan awal potongan), lalu yang
    //    berdekatan digabung. Kolom yang isinya jarang — misalnya Salesman yang
    //    hanya ditulis di baris pertama tiap grup — tetap ikut terdaftar.
    const tolKolom = Math.max(3, tinggiBaris * 0.9);
    const awalSel = [];
    semuaBaris.forEach((b, bi) => b.sel.forEach((c) => awalSel.push({ x: c.x, bi })));
    awalSel.sort((a, b) => a.x - b.x);
    const klaster = [];
    for (const t of awalSel) {
      const k = klaster[klaster.length - 1];
      if (!k || t.x - k.akhir > tolKolom) klaster.push({ awal: t.x, akhir: t.x, baris: new Set([t.bi]) });
      else { k.akhir = t.x; k.baris.add(t.bi); }
    }
    // Judul laporan dan baris preamble ("Halaman : 1 of 114", daftar salesman)
    // meletakkan teks di posisi X sembarang. Kalau posisi itu ikut dianggap awal
    // kolom, jumlah kolom membengkak dan nama toko jadi terpecah-pecah. Awal
    // kolom yang asli dipakai berulang oleh BANYAK baris, preamble tidak — jadi
    // yang dipakai hanya klaster yang didukung cukup banyak baris.
    const minBaris = Math.max(3, Math.floor(semuaBaris.length * 0.03));
    // Penyaringan jumlah pendukung SENGAJA ditunda sampai setelah penggabungan.
    // Kolom yang isinya rata tengah punya beberapa posisi awal yang masing-masing
    // hanya didukung sedikit baris — misalnya alasan panjang "B4-Order By Phone"
    // yang mulai lebih ke kiri daripada "-". Kalau disaring lebih dulu, posisi itu
    // hilang dan separuh teks alasan jatuh ke kolom sebelahnya.
    let kandidat = klaster;

    // Penyaring kedua, yang menentukan: batas kolom sejati TIDAK PERNAH dilintasi
    // teks — antar kolom tidak saling tumpang tindih. Sebaliknya, posisi yang
    // kebetulan sering jadi awal kata di TENGAH sel (misalnya kata kedua nama
    // toko) akan banyak dilewati teks baris lain. Jadi titik yang sering
    // dilintasi dibuang, dan nama toko tidak lagi terpotong jadi beberapa kolom.
    for (const k of kandidat) {
      let lintas = 0;
      for (const b of semuaBaris) {
        for (const c of b.sel) {
          if (c.x < k.awal - 1 && c.x + c.lebar > k.awal + 1) { lintas++; break; }
        }
      }
      k.lintas = lintas;
    }
    // Ambangnya diukur terhadap SELURUH baris, bukan terhadap jumlah baris
    // pendukung titik itu. Kalau tidak, kolom yang jarang terisi — Salesman dan
    // Tanggal hanya ditulis di baris pertama tiap grup — ikut terbuang gara-gara
    // dilintasi baris preamble yang membentang selebar halaman. Padahal kolom
    // Tanggal itu yang dipakai menjodohkan dengan EDI.
    const maxLintas = Math.max(2, Math.floor(semuaBaris.length * 0.15));
    let lolos = kandidat.filter((k) => k.lintas <= maxLintas);
    if (lolos.length < 3) lolos = kandidat.length ? kandidat : klaster;

    // Satu kolom bisa punya dua posisi awal: judulnya rata tengah sementara
    // isinya rata kiri, atau nilai pendek ("-") diletakkan berbeda dari nilai
    // panjang. Yang membedakan "dua posisi untuk satu kolom" dari "dua kolom
    // yang memang bersebelahan" bukan jaraknya, melainkan apakah keduanya pernah
    // muncul BERSAMAAN di satu baris. "No." dan "No Outlet" selalu bersama di
    // tiap baris data, jadi tetap terpisah. Judul "Alasan" dan isinya tidak
    // pernah sebaris, jadi digabung.
    const titik = [];
    const grupSemua = [];
    let grup = null;
    for (const k of lolos) {
      if (grup) {
        let bareng = 0;
        for (const bi of k.baris) if (grup.baris.has(bi)) bareng++;
        const kecil = Math.min(grup.baris.size, k.baris.size);
        if (bareng <= Math.max(1, kecil * 0.05)) {
          for (const bi of k.baris) grup.baris.add(bi);
          continue;                      // posisi lain untuk kolom yang sama
        }
      }
      grup = { awal: k.awal, baris: new Set(k.baris) };
      grupSemua.push(grup);
    }
    // Baru sekarang buang kolom yang benar-benar jarang dipakai (sisa preamble).
    let titikGrup = grupSemua.filter((g) => g.baris.size >= minBaris);
    if (titikGrup.length < 3) titikGrup = grupSemua;
    for (const g of titikGrup) titik.push(g.awal);

    // Pemetaan akhir memakai potongan ASLI, bukan sel hasil langkah 2. Sebabnya
    // baris header dicetak tebal sehingga hampir memenuhi selnya — jaraknya jadi
    // terlalu rapat dan aturan jarak menyatukannya. Titik kolom sendiri sudah
    // tepercaya karena diambil dari ratusan baris data. Tiap potongan diberikan
    // ke titik kolom terdekat DI SEBELAH KIRI, supaya pecahan di tengah sel
    // tetap kembali ke kolomnya.
    // Tiap potongan diberikan ke titik kolom terdekat DI SEBELAH KIRI. Nilai yang
    // rata kanan (misalnya Faktur "-") tetap jatuh di kolomnya sendiri, tidak
    // melompat ke kolom berikutnya.
    const kolomDari = (x) => {
      let i = 0;
      while (i + 1 < titik.length && titik[i + 1] <= x + tolKolom) i++;
      return i;
    };

    // Sebagian PDF mencetak beberapa sel sekaligus sebagai satu potongan teks
    // (baris judul kolom sering begitu). Posisinya cuma satu, jadi tidak bisa
    // dipisah dari koordinat potongan. Tapi lebar potongan diketahui, sehingga
    // posisi tiap KATA bisa ditaksir dari letak hurufnya — cukup akurat untuk
    // mengembalikan tiap kata ke kolomnya.
    function pecahLintasKolom(it) {
      if (!(it.lebar > 0)) return [it];
      const adaDiDalam = titik.some(
        (t) => t > it.x + tolKolom * 0.5 && t < it.x + it.lebar - tolKolom * 0.2);
      if (!adaDiDalam) return [it];
      const total = it.teks.length || 1;
      const out = [];
      const re = /\S+/g;
      let m;
      while ((m = re.exec(it.teks)) !== null) {
        out.push({
          teks: m[0],
          x: it.x + it.lebar * (m.index / total),
          lebar: it.lebar * (m[0].length / total),
        });
      }
      return out.length ? out : [it];
    }

    const aoa = [];
    for (const b of semuaBaris) {
      const kolom = [];
      for (const raw of b.items) {
        for (const c of pecahLintasKolom(raw)) {
          const i = kolomDari(c.x);
          kolom[i] = kolom[i] == null ? c.teks : kolom[i] + " " + c.teks;
        }
      }
      for (let i = 0; i < kolom.length; i++) {
        kolom[i] = kolom[i] == null ? "" : String(kolom[i]).replace(/\s+/g, " ").trim();
      }
      if (kolom.some((v) => v !== "")) aoa.push(kolom);
    }
    if (aoa.length < 2) throw new Error("Isi PDF tidak terbaca sebagai tabel.");
    return aoa;
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

  // Menerima indeks yang sudah ada supaya beberapa file DMP (satu per cabang)
  // bisa dituang ke wadah yang sama. Statistiknya ikut dijumlahkan.
  async function parseDmp(file, idxLama, byLama) {
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
    const iStatus = cols.indexOf("STATUS");
    // Nama kolomnya KODEBRANCH, bukan BRANCH. Dicari dua-duanya supaya file
    // dari sumber lain tetap terbaca.
    const iBranch = ["KODEBRANCH", "BRANCH", "KODE BRANCH"]
      .map((n) => cols.indexOf(n)).find((i) => i >= 0);
    const iSubdist = ["NAMASUBDIST", "SUBDIST", "NAMA SUBDIST"]
      .map((n) => cols.indexOf(n)).find((i) => i >= 0);
    // Tanggal outlet dibuat. Menjawab pertanyaan yang tidak bisa dijawab data
    // kunjungan: outlet yang belum pernah transaksi itu memang terlewat, atau
    // memang baru dibuat minggu lalu dan belum sempat didatangi siapa pun.
    const iDibuat = ["CREATIONDATE", "CREATION DATE", "TGLDIBUAT", "TANGGALDIBUAT"]
      .map((n) => cols.indexOf(n)).find((i) => i >= 0);
    const iStatusReg = cols.indexOf("STATUSREGISTER");
    const cell = (row, i) => i >= 0 && row[i] != null ? String(row[i]).trim() : "";
    const idx = idxLama instanceof Map ? idxLama : new Map();
    const bySalesman = byLama instanceof Map ? byLama : new Map();
    // Yang menentukan penjumlahan bukan "ada indeks yang dioper", tapi "indeks
    // itu sudah berisi". Waktu Proses ditekan dua kali, indeksnya memang dibuat
    // baru tapi state.dmpStats masih menyimpan angka proses sebelumnya — kalau
    // itu ikut dijumlahkan, jumlah outletnya berlipat tiap kali ditekan.
    const stLama = (idx.size && state.dmpStats) || null;
    // Nama cabang dikumpulkan sendiri, di luar indeks outlet. DMP tidak punya
    // kolom NAMABRANCH — yang ada NAMASUBDIST, dan itu memang nama yang dipakai
    // sehari-hari ("CNS JAKUTPUS"), sementara KODEBRANCH cuma "B120". Satu kode
    // bisa saja bertemu lebih dari satu nama kalau cabangnya mengirim file
    // dengan penamaan berbeda, jadi yang disimpan kumpulan, bukan satu nilai.
    if (!idx.size || !(state.branchNama instanceof Map)) state.branchNama = new Map();
    const namaCabang = state.branchNama;
    let count = 0, aktif = 0, ganda = 0;
    for (let r = 1; r < rows.length; r++) {
      const row = rows[r] || [];
      const ko = cell(row, iKO);
      if (!ko) continue;

      // Satu outlet bisa muncul di beberapa baris DMP dengan salesman & rayon
      // BERBEDA (di file contoh ada 864 outlet seperti ini, 806 di antaranya
      // rayonnya juga beda). Dulu baris ke-2 dst langsung dibuang, akibatnya
      // outlet itu cuma diakui milik salesman yang kebetulan barisnya duluan —
      // salesman lain kehilangan outletnya dan jumlahnya jadi kurang dari DMP.
      // Sekarang tiap penugasan direkam.
      const slsRow = cell(row, iSls);
      const ryRow = cell(row, iRayon);
      const prev = idx.get(ko);
      if (prev) {
        if (slsRow && !(prev.salesman === slsRow && prev.rayon === ryRow)
            && !(prev.alt || []).some((a) => a.s === slsRow && a.r === ryRow)) {
          (prev.alt || (prev.alt = [])).push({ s: slsRow, r: ryRow });
          let lst2 = bySalesman.get(slsRow);
          if (!lst2) { lst2 = []; bySalesman.set(slsRow, lst2); }
          lst2.push(ko);
          ganda++;
        }
        continue;
      }
      // Hanya simpan kolom yang benar-benar dipakai — DMP bisa 150rb baris,
      // menyimpan kolom yang tidak terpakai memboroskan memori (berat di HP).
      const sls = slsRow;
      // STATUS N / STATUSREGISTER "Non Active" = outlet mati. Di file contoh ada
      // 102.574 outlet seperti ini: tanpa salesman, tanpa rayon. Outlet mati tidak
      // pantas jadi penyebut coverage, tapi tetap disimpan supaya kalau ternyata
      // ada transaksinya bisa ketahuan.
      const br = iBranch === undefined ? "" : cell(row, iBranch);
      const sub = iSubdist === undefined ? "" : cell(row, iSubdist);
      if (br && sub) {
        let set = namaCabang.get(br);
        if (!set) { set = new Set(); namaCabang.set(br, set); }
        set.add(sub);
      }
      const stat = cell(row, iStatus).toUpperCase();
      const statReg = cell(row, iStatusReg).toUpperCase();
      const isAktif = iStatus < 0 && iStatusReg < 0
        ? true
        : stat !== "N" && !statReg.startsWith("NON ACTIVE");
      idx.set(ko, {
        namaOutlet: cell(row, iNO),
        alamat: cell(row, iAlamat),
        salesman: sls,
        rayon: ryRow,
        cycle: cell(row, iCycle),
        branch: br,
        subdist: sub,
        // Disimpan sebagai yyyy-mm-dd supaya bisa diurutkan dan dikurangkan;
        // bentuk tampilnya diurus waktu ditulis ke Excel.
        dibuat: iDibuat === undefined ? "" : tglIso(cell(row, iDibuat)),
        // Status hidup/mati disimpan per outlet, bukan cuma dihitung: daftar
        // "semua outlet" tidak boleh memuat 100rb outlet mati.
        aktif: isAktif,
        alt: null,          // penugasan tambahan: [{ s: salesman, r: rayon }]
      });
      if (sls) {
        let lst = bySalesman.get(sls);
        if (!lst) { lst = []; bySalesman.set(sls, lst); }
        lst.push(ko);
      }
      count++;
      if (isAktif) aktif++;
    }
    state.dmpBySalesman = bySalesman;
    // Angka dari file sebelumnya ikut dijumlahkan, jadi statusnya menggambarkan
    // seluruh cabang yang diupload, bukan cuma file terakhir.
    const total = (stLama ? stLama.total : 0) + count;
    const hidup = (stLama ? stLama.aktif : 0) + aktif;
    state.dmpStats = { total, aktif: hidup, mati: total - hidup,
                       salesman: bySalesman.size, ganda: (stLama ? stLama.ganda : 0) + ganda,
                       file: (stLama ? (stLama.file || 1) : 0) + 1 };
    return { index: idx, count, aktif };
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

  // Satu slot bisa menampung beberapa file sekaligus — satu per cabang. Isinya
  // digabung apa adanya; yang membedakan cabang tetap kode outletnya, jadi tidak
  // ada yang bisa tertukar. state[kunci] tetap berisi file PERTAMA supaya
  // seluruh pemeriksaan "ada file atau tidak" yang sudah ada tetap berlaku,
  // sedangkan daftar lengkapnya di state[kunci + "s"].
  function wireFile(inputId, stateKey, nameId, rowId, clearId) {
    const row = () => $(rowId);

    // Menggambar ulang keterangan satu slot dari daftar yang tersimpan.
    function segarkan(kosong) {
      const pakai = state[stateKey + "s"] || [];
      state[stateKey] = pakai[0] || null;
      const el = $(nameId), r = row();
      if ($(clearId)) $(clearId).classList.toggle("hidden", !pakai.length);
      if (!pakai.length) {
        el.textContent = "Belum dipilih";
        r.classList.remove("has");
      } else {
        const total = pakai.reduce((a, f) => a + f.size, 0);
        el.textContent = pakai.length === 1
          ? `${pakai[0].name} · ${fmtSize(total)}`
          : `${pakai.length} file · ${fmtSize(total)} — ${pakai.map((f) => f.name).join(", ")}`;
        r.classList.add("has");
      }
      if (kosong && kosong.length) {
        showError(new Error(`${kosong.length} file terbaca 0 byte dan dilewati: `
          + `${kosong.map((f) => f.name).join(", ")}. Download dulu ke perangkat ini.`));
      } else if (pakai.length) {
        clearError();
      }
      toggleProcess();
    }

    $(inputId).addEventListener("change", (e) => {
      const semua = [...e.target.files];
      const kosong = semua.filter((f) => f.size === 0);
      const pakai = semua.filter((f) => f.size > 0);
      if (!semua.length) return;          // dialog ditutup tanpa memilih apa pun
      if (!pakai.length) {
        // Umum di Android: file Google Drive yang belum diunduh terbaca 0 byte.
        $(nameId).textContent = `${semua[0].name} — kosong (0 byte), download dulu ke HP`;
        row().classList.remove("has");
        showError(new Error(`"${semua[0].name}" terbaca 0 byte.`));
        return;
      }
      // DITAMBAHKAN, bukan menimpa. Banyak file picker di HP cuma memperbolehkan
      // satu file per kali, jadi cara wajar menaruh empat cabang adalah menekan
      // "Pilih" empat kali — dan kalau tiap penekanan menimpa yang sebelumnya,
      // yang terjadi diam-diam: tiga cabang hilang, tanpa pesan apa pun, dan
      // angkanya cuma terlihat lebih kecil daripada seharusnya.
      const ada = state[stateKey + "s"] || [];
      const kunci = (f) => `${f.name}|${f.size}|${f.lastModified}`;
      const punya = new Set(ada.map(kunci));
      state[stateKey + "s"] = ada.concat(pakai.filter((f) => !punya.has(kunci(f))));
      segarkan(kosong);
    });

    // Tanpa ini salah pilih tidak bisa dibatalkan — satu-satunya jalan keluar
    // Reset, yang ikut membuang tiga slot lainnya.
    if ($(clearId)) {
      $(clearId).addEventListener("click", (e) => {
        // Tombolnya di dalam <label>, jadi kliknya akan membuka dialog file
        // kalau tidak dihentikan di sini.
        e.preventDefault();
        e.stopPropagation();
        state[stateKey + "s"] = [];
        $(inputId).value = "";
        clearError();
        segarkan();
      });
    }
  }

  const daftarFile = (kunci) => state[kunci + "s"] || (state[kunci] ? [state[kunci]] : []);

  // Tiap file DIPARSE SENDIRI, baru hasilnya digabung. Menggabungkan isi
  // mentahnya lebih sederhana tapi salah: tiap file punya baris pembuka dan
  // baris judul sendiri, dan parser hanya mencari judul sekali di awal — judul
  // file kedua akan terbaca sebagai data.
  async function parseGabung(kunci, parser) {
    const files = daftarFile(kunci);
    const keluar = [];
    for (const f of files) keluar.push(parser(await readWorkbook(f), f));
    return keluar;
  }
  wireFile("ediFile", "ediFile", "ediName", "rowEdi", "ediClear");
  wireFile("hhtFile", "hhtFile", "hhtName", "rowHht", "hhtClear");
  wireFile("dmpFile", "dmpFile", "dmpName", "rowDmp", "dmpClear");
  wireFile("lbpFile", "lbpFile", "lbpName", "rowLbp", "lbpClear");

  $("resetBtn").addEventListener("click", () => {
    state.ediFile = null; state.hhtFile = null; state.dmpFile = null; state.lbpFile = null;
    state.ediFiles = []; state.hhtFiles = []; state.dmpFiles = []; state.lbpFiles = [];
    state.dmpStats = null;
    state.ediRows = []; state.hhtRows = []; state.dmpIndex = new Map(); state.results = []; state.filtered = [];
    $("ediFile").value = ""; $("hhtFile").value = ""; $("dmpFile").value = ""; $("lbpFile").value = "";
    $("ediName").textContent = "Belum dipilih"; $("hhtName").textContent = "Belum dipilih";
    $("dmpName").textContent = "Belum dipilih"; $("lbpName").textContent = "Belum dipilih";
    ["ediClear", "hhtClear", "dmpClear", "lbpClear"]
      .forEach((id) => { if ($(id)) $(id).classList.add("hidden"); });
    ["rowEdi", "rowHht", "rowDmp", "rowLbp"].forEach((id) => $(id).classList.remove("has"));
    if (window.M3D2) window.M3D2.reset();
    state.titikByOutlet = new Map();
    state.titikStats = null;
    if ($("filterTitik")) { $("filterTitik").value = ""; labelTitikFilter(); }
    state.barcodeByOutlet = new Map();
    state.barcodeStats = null;
    if ($("filterBarcode")) { $("filterBarcode").value = ""; labelBarcodeFilter(); }
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
    const sSearch = $("filterSalesmanSearch");
    if (sSearch) { sSearch.value = ""; sSearch.dispatchEvent(new Event("input")); }
    document.querySelectorAll(".filterPeriodeItem").forEach((c) => (c.checked = false));
    const pdAll = $("filterPeriodeAll"); if (pdAll) pdAll.checked = true;
    const pdLabel = $("filterPeriodeLabel"); if (pdLabel) pdLabel.textContent = "Semua periode";
    if ($("rowPeriodeHht")) $("rowPeriodeHht").classList.add("hidden");
    if ($("rowTanggal")) {
      $("rowTanggal").classList.add("hidden");
      $("tglDari").value = ""; $("tglSampai").value = "";
    }
    if ($("exportHint")) { $("exportHint").textContent = ""; $("exportHint").classList.add("hidden"); }
    if ($("filterInfo")) { $("filterInfo").innerHTML = ""; $("filterInfo").classList.add("hidden"); }
    document.querySelectorAll(".filterRayonItem").forEach((c) => (c.checked = false));
    const ryAll = $("filterRayonAll"); if (ryAll) ryAll.checked = true;
    const ryLabel = $("filterRayonLabel"); if (ryLabel) ryLabel.textContent = "Semua rayon";
    // Branch dan cycle ikut dikosongkan dan disembunyikan lagi — isinya datang
    // dari file yang baru saja dibuang.
    for (const [wadah, daftar, kelas, semua, label, kata] of [
      ["filterBranch", "filterBranchList", "filterBranchItem", "filterBranchAll", "filterBranchLabel", "branch"],
      ["filterCycle", "filterCycleList", "filterCycleItem", "filterCycleAll", "filterCycleLabel", "cycle"],
    ]) {
      document.querySelectorAll("." + kelas).forEach((c) => (c.checked = false));
      if ($(daftar)) $(daftar).innerHTML = "";
      if ($(semua)) $(semua).checked = true;
      if ($(label)) $(label).textContent = "Semua " + kata;
      if ($(wadah)) $(wadah).classList.add("hidden");
    }
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
      state.dmpBySalesman = new Map();
      let dmpCount = 0;
      if (state.dmpFile) {
        setStatus("Membaca DMP...");
        for (const f of daftarFile("dmpFile")) {
          const dmp = await parseDmp(f, state.dmpIndex, state.dmpBySalesman);
          state.dmpIndex = dmp.index;
          dmpCount += dmp.count;
        }
      }

      // Dashboard 2 (LBP) — jalan kalau file LBP diupload.
      let d2Msg = "";
      if (state.lbpFile && window.M3D2) {
        d2Msg = await window.M3D2.process(daftarFile("lbpFile"), state.dmpIndex, state.dmpBySalesman);
      }

      // Dashboard 1 (EDI) — butuh EDI.
      if (!state.ediFile) {
        const parts = [];
        if (dmpCount) {
          const st = state.dmpStats;
          parts.push(st && st.mati
            ? `DMP: ${st.aktif.toLocaleString("id-ID")} outlet aktif (dari ${st.total.toLocaleString("id-ID")})`
            : `DMP: ${dmpCount.toLocaleString("id-ID")} outlet`);
        }
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
      const ediBagian = await parseGabung("ediFile", (aoa) => parseEdi(aoa));
      state.ediRows = ediBagian.length === 1 ? ediBagian[0] : [].concat(...ediBagian);
      if (!state.ediRows.length) throw new Error("EDI tidak berisi baris data.");

      state.scanIndex = new Map();
      state.hhtOutletSet = new Set();
      let hhtWarn = "";
      let hhtTglTerbaca = 0;
      const hhtTanggalSet = new Set();
      state.scanByOutlet = new Map();
      state.alasanByOutlet = new Map();
      if (state.hhtFile) {
        setStatus("Membaca HHT...");
        const hhtBagian = await parseGabung("hhtFile", (aoa) => parseHht(aoa));
        state.hhtRows = hhtBagian.length === 1
          ? hhtBagian[0].rows : [].concat(...hhtBagian.map((x) => x.rows));
        state.hhtCabang = [...new Set(hhtBagian.map((x) => x.cabang).filter(Boolean))].join(", ");
        state.hhtOutletSet = new Set(state.hhtRows.map((h) => String(h.custno || "").trim()));
        hhtWarn = [...new Set(hhtBagian.map((x) => x.warn).filter(Boolean))].join(" ");
        // Dijodohkan per outlet DAN per tanggal. Kalau hanya per outlet, kunjungan
        // tanggal 24 Agustus bisa mengambil alasan & status scan dari kunjungan
        // tanggal 5 Agustus — kategorinya jadi salah, bukan cuma alasannya.
        for (const h of state.hhtRows) {
          const k = String(h.custno);
          const t = tglKunci(h.tanggal);
          if (t) {
            hhtTglTerbaca++;
            const kk = k + "|" + t;
            if (!state.scanIndex.has(kk) || isScanned(h)) state.scanIndex.set(kk, h);
            hhtTanggalSet.add(t);
          }
          if (!state.scanByOutlet.has(k) || isScanned(h)) state.scanByOutlet.set(k, h);
          // Indeks terpisah untuk kolom Alasan: yang dicari baris yang PUNYA
          // alasan nyata, bukan yang discan. Dipakai kalau tanggalnya tidak
          // ketemu — alasan boleh dipinjam antar hari, status scan tidak.
          const al = String(h.alasan || "").trim();
          if (al && al !== "-" && al !== "—" && !state.alasanByOutlet.has(k)) {
            state.alasanByOutlet.set(k, { alasan: al, tgl: String(h.tanggal || "").trim() });
          }
        }
      }
      // Kalau kolom TANGGAL di HHT tidak terbaca sama sekali, jangan bikin semua
      // jadi tidak cocok — kembali ke pencocokan per outlet saja.
      const pakaiTanggal = hhtTglTerbaca > 0;

      setStatus("Kategorisasi...");
      const results = state.ediRows.map((r) => {
        const tgl = tglKunci(r.visitDate);
        let hht = null, hhtNote = "";
        if (state.hhtFile) {
          if (pakaiTanggal && tgl) {
            hht = state.scanIndex.get(r.custno + "|" + tgl) || null;
            if (!hht) hhtNote = state.scanByOutlet.has(r.custno) ? "beda-tanggal" : "tidak-ada";
          } else {
            hht = state.scanByOutlet.get(r.custno) || null;
            if (!hht) hhtNote = "tidak-ada";
          }
        }
        const dmp = state.dmpIndex.get(r.custno);
        const cat = categorize(r, hht);
        // Sumber: DMP (paling akurat) > HHT > EDI. Fallback kalau kosong.
        const namaTokoEff = (dmp && dmp.namaOutlet) || (hht && hht.namaToko && String(hht.namaToko).trim()) || r.namaToko || "";
        // Siapa yang berkunjung, bukan siapa pemilik outletnya. Dulu nama ini
        // diambil dari DMP lebih dulu — akibatnya kunjungan nyata bisa
        // diatasnamakan rayon kosong ("VACANT") atau salesman lain yang
        // kebetulan memegang outlet itu di master. Di data uji, 8,3% kunjungan
        // salah orang karena itu. Untuk dashboard validasi kunjungan, yang
        // benar SLSNAME di EDI: dialah yang datang dan yang dinilai radiusnya.
        const salesmanEff = String(r.slsname || "").trim()
          || (hht && hht.salesman && String(hht.salesman).trim())
          || (dmp && dmp.salesman) || "";
        // Pemegang outlet menurut DMP tetap disimpan, ditampilkan di kolom
        // terpisah — berguna justru untuk melihat ketidakcocokannya.
        const salesmanDmp = (dmp && dmp.salesman) || "";
        const alamatEff = (dmp && dmp.alamat) || r.alamatToko || "";
        // Rayon diambil dari DMP. Kalau outletnya tidak ada di DMP, yang tersedia
        // hanya kolom TEAM di EDI — isinya nama tim ("288 - COF+HF+IF+HC"), bukan
        // rayon. Ditandai supaya tidak disangka rayon saat difilter.
        const rayonEff = (dmp && dmp.rayon) || (r.team ? `${String(r.team).trim()} (TEAM)` : "");
        const cycleEff = (dmp && dmp.cycle) || r.cycle || "";
        // Cabang diambil dari DMP (KODEBRANCH). Dipakai menyaring waktu
        // beberapa cabang diupload sekaligus.
        const branchEff = (dmp && dmp.branch) || "";
        // Alasan boleh dipinjam dari tanggal lain (ditandai di tabel). Status scan
        // dan kategori TIDAK — itu bukti kunjungan hari itu, tidak boleh dipinjam.
        const alasanLuar = hht ? null : (state.alasanByOutlet.get(r.custno) || null);
        // Kunjungan yang tidak punya catatan di HHT bukan "tidak scan" —
        // statusnya TIDAK DIKETAHUI. Ada dua sebab, dan dua-duanya harus
        // ditangkap:
        //
        //   a. tanggalnya tidak ada di HHT (file beda periode);
        //   b. outletnya sama sekali tidak ada di HHT (file beda cakupan —
        //      misalnya HHT satu cabang, EDI seluruh area).
        //
        // Dulu hanya (a) yang diperiksa. Akibatnya HHT satu cabang dengan
        // tanggal yang sama lolos tanpa peringatan, dan 27.541 kunjungan yang
        // memang tidak tercakup ikut terhitung "Tidak scan" — angka temuan
        // yang sebenarnya cuma cerminan file yang tidak sepadan.
        const takAdaHht = !!(state.hhtFile && !state.hhtOutletSet.has(r.custno));
        const diLuarTgl = !!(state.hhtFile && pakaiTanggal && tgl && !hhtTanggalSet.has(tgl));
        const diLuarHht = takAdaHht || diLuarTgl;
        // Periode dipakai untuk filter. Kalau kolomnya kosong, bulan dari
        // tanggal kunjungan jadi penggantinya.
        const periodeEff = String(r.periode ?? "").trim() || (tgl ? "Bulan " + tgl.split("-")[1] : "");
        return { ...r, hht, hhtNote, alasanLuar, dmp, category: cat, namaTokoEff, salesmanEff,
                 salesmanDmp, alamatEff, rayonEff, cycleEff, branchEff,
                 diLuarHht, takAdaHht, diLuarTgl, periodeEff,
                 tglIso: tglIso(r.visitDate) };
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
      state.tglDataMulai = undefined;
      hitungGlobal();
      hitungFrekuensi();
      hitungFrekuensiSls();
      hitungBarcode();
      hitungTitik();

      // Daftar isian filter memuat pengunjung DAN pemilik outlet menurut DMP.
      // Tanpa pemiliknya, salesman yang outletnya selalu diabsen orang lain
      // tidak akan pernah muncul di daftar — padahal justru dia yang perlu
      // ditanya, dan lembar cetak memang dikelompokkan atas namanya.
      const salesmen = [...new Set(results.flatMap((r) => [r.salesmanEff, r.salesmanDmp])
        .filter(Boolean))].sort();
      populateSalesmen(salesmen);
      // Rayon asli dari DMP didahulukan; nilai cadangan dari TEAM ditaruh
      // paling bawah supaya tidak mengaburkan daftar rayon yang sebenarnya.
      const rayons = [...new Set(results.map((r) => r.rayonEff).filter(Boolean))]
        .sort((a, b) => {
          const ta = a.endsWith("(TEAM)") ? 1 : 0, tb = b.endsWith("(TEAM)") ? 1 : 0;
          return ta - tb || a.localeCompare(b, "id", { numeric: true });
        });
      populateRayon(rayons);
      // Branch dan Cycle ikut jadi penyaring. Branch baru berguna kalau beberapa
      // cabang diupload sekaligus, jadi penyaringnya disembunyikan kalau cuma
      // ada satu — daripada memajang dropdown yang isinya satu pilihan.
      // Diurutkan menurut nama yang terbaca, bukan kodenya — itu yang dicari
      // mata waktu dropdown-nya dibuka.
      const branches = [...new Set(results.map((r) => r.branchEff).filter(Boolean))]
        .sort((a, b) => labelBranch(a).localeCompare(labelBranch(b), "id", { numeric: true }));
      // Barisnya cuma dibuat kalau memang ada yang tanpa branch, dan ditaruh
      // paling bawah — itu sisa, bukan cabang.
      if (branches.length && results.some((r) => !r.branchEff)) branches.push("");
      populateBranch(branches);
      const cycles = [...new Set(results.map((r) => r.cycleEff).filter(Boolean))]
        .sort((a, b) => a.localeCompare(b, "id", { numeric: true }));
      populateCycle(cycles);
      // Kotak tanggal diisi rentang penuh datanya. Dibiarkan kosong berarti
      // "semua tanggal", jadi tidak ada yang tersaring diam-diam.
      const semuaTgl = results.map((r) => r.tglIso).filter(Boolean).sort();
      const kotakTgl = $("rowTanggal");
      if (kotakTgl) {
        const ada = semuaTgl.length > 0;
        kotakTgl.classList.toggle("hidden", !ada);
        if (ada) {
          const min = semuaTgl[0], max = semuaTgl[semuaTgl.length - 1];
          for (const id of ["tglDari", "tglSampai"]) {
            $(id).min = min; $(id).max = max; $(id).value = "";
          }
          $("tglInfo").textContent = `data: ${tglTampil(min)} s/d ${tglTampil(max)}`;
        }
      }
      const periodes = [...new Set(results.map((r) => r.periodeEff).filter(Boolean))]
        .sort((a, b) => a.localeCompare(b, "id", { numeric: true }));
      populatePeriode(periodes);

      // Kalau EDI mencakup tanggal yang tidak ada di HHT, kunjungan itu
      // dikeluarkan lebih dulu dari ringkasan — bukan disembunyikan diam-diam,
      // tapi dengan tombol yang terlihat dan keterangan berapa yang dikeluarkan.
      const diLuar = results.filter((r) => r.diLuarHht).length;
      // Kalau SEMUA kunjungan di luar periode HHT (dua file yang benar-benar
      // beda periode), tombol ini justru akan mengosongkan seluruh tabel.
      // Untuk kasus itu sudah ada peringatan tersendiri, jadi tombolnya tidak
      // ditawarkan sama sekali.
      const bisaDisaring = diLuar > 0 && diLuar < results.length;
      const kotakHht = $("rowPeriodeHht");
      if (kotakHht) {
        kotakHht.classList.toggle("hidden", !bisaDisaring);
        $("filterPeriodeHht").checked = bisaDisaring;
      }
      // Kolom yang diam-diam kosong lebih berbahaya daripada file yang gagal
      // dibaca: hasilnya tetap keluar, cuma separuh isinya hilang tanpa sebab
      // yang kelihatan. Koordinat absen yang kosong menghilangkan QR, tautan
      // peta, dan seluruh usulan titik sekaligus — dan tidak satu pun dari itu
      // meninggalkan pesan. Jadi diperiksa di sini, sekali, dengan angka.
      state.kolomHilang = [];
      // Kolom yang judulnya tidak dikenali sama sekali: itu sebab paling pokok,
      // dan gejalanya sama persis dengan kolom yang isinya memang kosong.
      const NAMA_KOLOM = {
        flagRadius: "FLAG RADIUS", visitDate: "VISIT DATE", latVisit: "LAT VISIT",
        longVisit: "LONG VISIT", latVal: "LAT VAL", longVal: "LONG VAL",
        setting: "SETTING", distance: "DISTANCE",
      };
      const takKenal = (state.ediKolomTakKetemu || []).map((k) => NAMA_KOLOM[k] || k);
      if (takKenal.length) {
        state.kolomHilang.push({ judulTakKenal: takKenal, header: state.ediHeader || [] });
      }
      if (results.length) {
        const tanpaKoord = results.filter((r) =>
          titikKosong(angka(r.latVisit), angka(r.longVisit))).length;
        const tanpaTgl = results.filter((r) => !r.tglIso).length;
        if (tanpaKoord / results.length > 0.5) {
          state.kolomHilang.push({ apa: "koordinat absen (LAT VISIT / LONG VISIT)",
            n: tanpaKoord, akibat: "QR, tautan peta, dan usulan titik toko tidak bisa dibuat" });
        }
        if (tanpaTgl / results.length > 0.5) {
          state.kolomHilang.push({ apa: "tanggal kunjungan (VISIT DATE)",
            n: tanpaTgl, akibat: "penjodohan dengan HHT, saringan tanggal, dan urutan kunjungan tidak jalan" });
        }
      }
      applyFilters();
      $("resultSection").classList.remove("hidden");
      const msg = [`${results.length.toLocaleString("id-ID")} kunjungan`];
      if (dmpCount) {
        const st = state.dmpStats;
        // Sebut yang aktif saja. Angka total DMP menyertakan outlet Non Active
        // (tanpa salesman, tanpa rayon) sehingga menyesatkan kalau dipakai
        // sebagai "jumlah outlet".
        msg.push(st && st.mati
          ? `${st.aktif.toLocaleString("id-ID")} outlet DMP aktif (dari ${st.total.toLocaleString("id-ID")})`
          : `${dmpCount.toLocaleString("id-ID")} outlet DMP`);
      }
      if (d2Msg) msg.push(d2Msg);
      if (state.hhtFile) {
        const matched = results.filter((r) => r.hht).length;
        msg.push(`${matched.toLocaleString("id-ID")} cocok HHT`);
        // Kalau tidak ada satu pun tanggal yang beririsan, semua kunjungan akan
        // tampil "Tidak scan" tanpa alasan. Itu bukan temuan lapangan, itu file
        // yang tidak sepasang — harus dibilang, bukan dibiarkan diam.
        const ediTgl = new Set(results.map((r) => tglKunci(r.visitDate)).filter(Boolean));
        const irisan = [...ediTgl].filter((d) => hhtTanggalSet.has(d));
        if (pakaiTanggal && ediTgl.size && hhtTanggalSet.size && !irisan.length) {
          const rapi = (set) => [...set].sort((a, b) => {
            const [da, ma] = a.split("-"), [db, mb] = b.split("-");
            return (ma + da).localeCompare(mb + db);
          });
          const rentang = (set) => {
            const v = rapi(set);
            return v.length === 1 ? v[0] : `${v[0]} s/d ${v[v.length - 1]}`;
          };
          const dipinjam = results.filter((r) => r.alasanLuar).length;
          // Dipecah dua: satu kalimat yang langsung terlihat, sisanya disembunyikan
          // di balik "Kenapa?". Versi panjangnya memakan 13 baris di layar HP dan
          // mendorong ringkasan jauh ke bawah.
          state.periodeWarn = {
            ringkas: `Tanggal di EDI (${rentang(ediTgl)}) dan di HHT (${rentang(hhtTanggalSet)}) `
              + `tidak ada yang sama. Upload HHT periode yang sama supaya kategorinya benar.`,
            detail: `Kolom Scan dan kategori sengaja tetap kosong: status scan adalah bukti `
              + `kunjungan pada hari itu, tidak boleh diambil dari hari lain. `
              + (dipinjam
                  ? `Kolom Alasan tetap diisi dari catatan HHT outlet yang sama di tanggal lain `
                    + `(${dipinjam.toLocaleString("id-ID")} baris, ditandai tanggal asalnya) sebagai petunjuk.`
                  : ""),
          };
        } else if (state.hhtOutletSet && state.hhtOutletSet.size && !matched
                   && diLuar === results.length) {
          // Tidak satu pun outlet di HHT ada di EDI. Ini hampir selalu berarti
          // dua file dari CABANG yang berbeda — dan kalau dibiarkan diam,
          // ringkasan memajang "Flag 1 + Tidak scan" puluhan ribu seolah-olah
          // temuan lapangan yang mengerikan, padahal status scan-nya memang
          // tidak diketahui. Dulu keadaan ini lolos tanpa peringatan sama
          // sekali: peringatan tanggal tidak kena (tanggalnya kebetulan sama),
          // dan peringatan cakupan sebagian juga tidak, karena yang tidak
          // tercakup bukan sebagian tapi semuanya.
          const cabEdi = [...new Set(results.map((r) => String(r.kodeCabang || "").trim())
            .filter(Boolean))];
          const sebut = state.hhtCabang || cabEdi.length
            ? ` (HHT cabang ${state.hhtCabang || "?"}, EDI cabang ${cabEdi.join(", ") || "?"})`
            : "";
          state.periodeWarn = {
            judul: "File HHT dan EDI berasal dari cabang/area yang berbeda.",
            ringkas: `Tidak ada satu pun outlet yang sama${sebut}: HHT memuat `
              + `${state.hhtOutletSet.size.toLocaleString("id-ID")} outlet, EDI `
              + `${new Set(results.map((r) => r.custno)).size.toLocaleString("id-ID")} outlet, `
              + `nol beririsan. Upload HHT dari cabang yang sama dengan EDI-nya.`,
            detail: `Format filenya sendiri sudah benar dan terbaca — yang tidak cocok isinya. `
              + `Selama belum sepasang, seluruh kolom Scan kosong dan angka "Tidak scan" di `
              + `Ringkasan bukan temuan lapangan: status scan outlet-outlet ini memang tidak `
              + `diketahui, bukan berarti tidak discan. Kolom Titik Toko, Flag Radius, dan usulan `
              + `koordinat tetap sah karena tidak membutuhkan HHT.`,
          };
        } else if (bisaDisaring) {
          // Irisannya ada, tapi tidak semua. Ini yang bikin angka "Tidak scan"
          // membengkak tanpa sebab lapangan: kunjungan di bulan yang HHT-nya
          // tidak diupload ikut terhitung tidak scan.
          const rapi = (set) => [...set].sort((a, b) => {
            const [da, ma] = a.split("-"), [db, mb] = b.split("-");
            return (ma + da).localeCompare(mb + db);
          });
          const rentang = (set) => {
            const v = rapi(set);
            return v.length === 1 ? v[0] : `${v[0]} s/d ${v[v.length - 1]}`;
          };
          // Dua sebab dipisah, karena tindakan perbaikannya berbeda: yang satu
          // upload HHT periode lain, yang satu upload HHT cabang lain.
          const nTgl = results.filter((r) => r.diLuarTgl && !r.takAdaHht).length;
          const nOutlet = results.filter((r) => r.takAdaHht).length;
          const sebab = [];
          if (nOutlet) sebab.push(`${nOutlet.toLocaleString("id-ID")} kunjungan outletnya tidak ada `
            + `di file HHT sama sekali`);
          if (nTgl) sebab.push(`${nTgl.toLocaleString("id-ID")} kunjungan tanggalnya di luar `
            + `${rentang(hhtTanggalSet)}`);
          state.periodeWarn = {
            info: true,
            judul: "File HHT tidak mencakup semua kunjungan.",
            ringkas: `${sebab.join(", dan ")}. Totalnya `
              + `${diLuar.toLocaleString("id-ID")} dari ${results.length.toLocaleString("id-ID")} `
              + `kunjungan tidak bisa dinilai scan-nya, jadi tidak ikut dihitung.`,
            detail: `Kunjungan tanpa catatan HHT bukan berarti barcodenya tidak discan — `
              + `statusnya tidak diketahui. Kalau ikut dihitung, angka "Tidak scan" jadi besar `
              + `bukan karena temuan lapangan, tapi karena filenya tidak sepadan. `
              + `Hilangkan centang "Hanya yang ada di HHT" di bawah kalau ingin melihat semua `
              + `kunjungan, atau upload HHT yang cakupannya sama dengan EDI.`,
          };
        } else {
          state.periodeWarn = "";
        }
      } else {
        msg.push("tanpa HHT — scan dianggap tidak ada");
        state.periodeWarn = null;
      }
      const wb = $("d1Warn");
      if (wb) {
        const w = state.periodeWarn;
        const kh = state.kolomHilang || [];
        // Kolom yang kosong didahulukan dan memakai nada peringatan penuh: ini
        // bukan soal file yang kurang sepadan, tapi data yang memang tidak ada.
        const takKenalItem = kh.find((k) => k.judulTakKenal);
        const teksKolom = kh.length
          ? `<b>Ada kolom EDI yang tidak terbaca, jadi sebagian isi halaman ini tidak bisa `
            + `dibuat.</b> `
            + (takKenalItem
                ? `Judul kolom <b>${escapeHtml(takKenalItem.judulTakKenal.join(", "))}</b> `
                  + `tidak ada di file ini. Judul kolom yang terbaca: `
                  + `<i>${escapeHtml(takKenalItem.header.join(" | "))}</i>. `
                : "")
            + kh.filter((k) => k.apa).map((k) => `${escapeHtml(k.apa)} kosong di `
                + `${k.n.toLocaleString("id-ID")} dari ${results.length.toLocaleString("id-ID")} `
                + `kunjungan &mdash; ${escapeHtml(k.akibat)}`).join(". ")
            + (kh.some((k) => k.apa) ? `. ` : "")
            + `<details class="warn-more"><summary>Kenapa?</summary><p>`
            + `Kolomnya dicari dengan beberapa nama yang lazim `
            + `(LAT VISIT / LONG VISIT, VISIT DATE atau TANGGAL). Kalau file dari area lain `
            + `memakai judul kolom yang berbeda, isinya terbaca kosong walaupun filenya sendiri `
            + `terbuka dengan baik. Kirimkan contoh filenya supaya nama kolomnya bisa ditambahkan. `
            + `Kolom Flag Radius dan riwayat scan tidak terpengaruh.</p></details>`
          : "";
        const teksPeriode = w
          ? `<b>${escapeHtml(w.judul || "Periode EDI dan HHT tidak bertemu.")}</b> `
            + `${escapeHtml(w.ringkas)}`
            + (w.detail ? `<details class="warn-more"><summary>Kenapa?</summary>`
                          + `<p>${escapeHtml(w.detail)}</p></details>` : "")
          : "";
        wb.classList.toggle("info", !kh.length && !!(w && w.info));
        wb.innerHTML = [teksKolom, teksPeriode].filter(Boolean)
          .join(`<hr class="warn-sela">`);
        wb.classList.toggle("hidden", !teksKolom && !teksPeriode);
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
    // Kartu bernilai nol diredupkan supaya mata langsung tertuju ke kategori
    // yang benar-benar ada isinya dan perlu ditindaklanjuti.
    const nol = String(value).replace(/[^\d]/g, "") === "0" ? " zero" : "";
    return `<div class="stat${nol} ${tone || ""}"><b>${value}${s}</b><span>${escapeHtml(label)}</span></div>`;
  }

  function getSelectedCategories() {
    return new Set([...document.querySelectorAll(".filterCategoryItem")]
      .filter((c) => c.checked).map((c) => c.value));
  }
  function getSelectedSalesmen() {
    return new Set([...document.querySelectorAll(".filterSalesmanItem")]
      .filter((c) => c.checked).map((c) => c.value));
  }

  function getSelectedPeriode() {
    return new Set([...document.querySelectorAll(".filterPeriodeItem")]
      .filter((c) => c.checked).map((c) => c.value));
  }

  function getSelectedRayon() {
    return new Set([...document.querySelectorAll(".filterRayonItem")]
      .filter((c) => c.checked).map((c) => c.value));
  }

  function getSelectedBranch() {
    return new Set([...document.querySelectorAll(".filterBranchItem")]
      .filter((c) => c.checked).map((c) => c.value));
  }

  function getSelectedCycle() {
    return new Set([...document.querySelectorAll(".filterCycleItem")]
      .filter((c) => c.checked).map((c) => c.value));
  }

  // Base set for the summary: salesman + search + inkonsisten toggle, but NOT category.
  // (Summary is the category breakdown itself.)
  // opsi.abaikanHht — pakai semua kunjungan tanpa memandang cakupan HHT.
  // Dipakai daftar kerja yang sumbernya EDI saja (usulan titik, radius di
  // lembar cetak): kunjungan yang scan-nya tidak bisa dinilai tetap punya
  // koordinat dan flag radius yang sah, jadi tidak boleh ikut terpotong.
  function getBaseFiltered(opsi) {
    const q = $("search").value.trim().toLowerCase();
    const sms = getSelectedSalesmen();
    const rys = getSelectedRayon();
    const brs = getSelectedBranch();
    const cys = getSelectedCycle();
    const onlyMixed = $("filterInkonsisten") && $("filterInkonsisten").checked;
    const kel = $("filterTitik") ? $("filterTitik").value : "";
    const hanyaHht = $("filterPeriodeHht") && $("filterPeriodeHht").checked;
    const pers = getSelectedPeriode();
    const rg = rentangTanggal();
    return state.results.filter((r) => {
      if (!dalamRentang(r, rg)) return false;
      if (hanyaHht && r.diLuarHht && !(opsi && opsi.abaikanHht)) return false;
      if (pers.size > 0 && !pers.has(r.periodeEff)) return false;
      if (onlyMixed && r.consistency !== "MIXED") return false;
      const bc = (opsi && opsi.abaikanBarcode) ? "" : ($("filterBarcode") ? $("filterBarcode").value : "");
      if (bc) {
        const u = state.barcodeByOutlet && state.barcodeByOutlet.get(r.custno);
        if (!u || u.bucket !== bc) return false;
      }
      if (kel && !(opsi && opsi.abaikanTitik)) {
        // Kelompok ini soal kunjungan yang bermasalah. Kunjungan flag 1 di
        // outlet yang sama tidak ada urusannya, jadi tidak ikut ditampilkan.
        if (r.flagRadius === "1") return false;
        const u = state.titikByOutlet && state.titikByOutlet.get(r.custno);
        if (!u || u.bucket !== kel) return false;
      }
      // Saringan salesman memilih OUTLET, bukan kunjungan: yang diuji pemilik
      // outlet menurut DMP (jatuh ke pengunjung kalau outletnya tidak punya
      // pemilik). Dengan begitu tabel, Excel, dan lembar cetak berbicara tentang
      // kumpulan toko yang sama persis. Waktu yang diuji masih pengunjung,
      // ketiganya berbeda-beda isinya: outlet milik salesman terpilih yang
      // diabsen orang lain hilang dari daftarnya, sementara outlet milik orang
      // lain yang kebetulan diabsen salesman terpilih malah ikut.
      // Kunjungan oleh salesman lain ke outlet ini tetap ditampilkan — kolom
      // Salesman memang berisi yang berkunjung, dan bedanya itu justru temuan.
      // Untuk mencari "apa saja yang dikerjakan si A hari ini", pakai kotak
      // pencarian: namanya ikut dicari di kolom pengunjung.
      if (sms.size > 0 && !sms.has(r.salesmanDmp || r.salesmanEff)) return false;
      if (rys.size > 0 && !rys.has(r.rayonEff)) return false;
      // Branch dan cycle menempel pada OUTLET menurut DMP, sama seperti rayon.
      if (brs.size > 0 && !brs.has(r.branchEff)) return false;
      if (cys.size > 0 && !cys.has(r.cycleEff)) return false;
      if (q) {
        const hay = [r.custno, r.namaTokoEff, r.salesmanEff, r.salesmanDmp, r.rayonEff, r.alamatEff, r.alorReason,
                     alasanHht(r), r.alasanLuar && r.alasanLuar.alasan]
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
    renderRangking();
    labelTitikFilter();
    labelBarcodeFilter();
    renderFilterInfo();
  }

  // ---- Rangking di layar ----
  // Isinya sama dengan sheet "Rangking Salesman" di Excel, dan ikut saringan
  // yang sedang dipilih. Di layar cuma sepuluh teratas yang ditampilkan:
  // daftar penuh bisa seratus lebih orang, dan yang dicari waktu melihat layar
  // biasanya "siapa yang paling perlu ditemani" — bukan seluruh daftar. Sisanya
  // sejauh satu tombol.
  const RANK_PENDEK = 10;

  function renderRangking() {
    const wadah = $("rankSection");
    if (!wadah) return;
    const semua = daftarRangking();
    const berangka = semua.filter((x) => x.peringkat !== "");
    wadah.classList.toggle("hidden", !semua.length);
    if (!semua.length) return;

    const panjang = state.rankSemua || semua.length <= RANK_PENDEK;
    const tampil = panjang ? semua : berangka.slice(0, RANK_PENDEK);
    const belum = semua.length - berangka.length;
    $("rankInfo").textContent = berangka.length
      ? `${berangka.length.toLocaleString("id-ID")} salesman dirangking`
        + (belum ? ` · ${belum.toLocaleString("id-ID")} belum cukup kunjungan` : "")
      : `${semua.length.toLocaleString("id-ID")} salesman — semuanya belum cukup kunjungan`;

    $("rankList").innerHTML = tampil.map((x) => {
      // Lebar batangnya = nilainya. Warnanya mengikuti tiga tingkat yang sama
      // dengan coverage di Dashboard 2, supaya dibaca dengan cara yang sama.
      const kelas = x.nilai >= 75 ? "hi" : x.nilai >= 50 ? "mid" : "lo";
      const nilai = x.nilai.toLocaleString("id-ID", { minimumFractionDigits: 1,
                                                     maximumFractionDigits: 1 });
      const sub = x.catatan
        ? escapeHtml(x.catatan)
        : `${x.n.toLocaleString("id-ID")} kunjungan &middot; `
          + `${x.outlet.toLocaleString("id-ID")} outlet`
          + (x.branch ? ` &middot; ${escapeHtml(x.branch)}` : "")
          + (x.rayon ? ` &middot; ${escapeHtml(x.rayon)}` : "");
      return `<li class="rank-baris${x.catatan ? " rank-belum" : ""}">`
        + `<span class="rank-no">${x.peringkat || "&ndash;"}</span>`
        + `<span class="rank-isi">`
        +   `<span class="rank-nama">${escapeHtml(x.nama)}</span>`
        +   `<span class="rank-sub">${sub}</span>`
        + `</span>`
        + `<span class="rank-nilai">`
        +   `<b class="cov cov-${kelas}">${nilai}</b>`
        +   `<span class="covbar"><i style="width:${Math.max(2, x.nilai)}%"></i></span>`
        + `</span>`
        + `</li>`;
    }).join("");

    const tombol = $("rankMore");
    if (tombol) {
      tombol.classList.toggle("hidden", semua.length <= RANK_PENDEK);
      tombol.textContent = state.rankSemua
        ? `Tampilkan ${RANK_PENDEK} teratas saja`
        : `Lihat semua ${semua.length.toLocaleString("id-ID")} salesman`;
    }
  }

  // Berapa kunjungan yang sedang disembunyikan, dan oleh penyaring yang mana.
  // Tanpa ini, filter yang menyala diam-diam (terutama "Hanya periode HHT"
  // yang tercentang sendiri) membuat data terlihat seperti kurang tertarik
  // dari sumbernya — padahal cuma sedang disaring.
  function renderFilterInfo() {
    const el = $("filterInfo");
    if (!el) return;
    const total = state.results.length;
    const tampil = state.filtered.length;

    const aktif = [];
    const q = $("search").value.trim();
    if (q) aktif.push(`pencarian "${q}"`);
    const nCat = getSelectedCategories().size;
    if (nCat) aktif.push(`${nCat} kategori`);
    const nSls = getSelectedSalesmen().size;
    if (nSls) aktif.push(`${nSls} salesman`);
    const nRay = getSelectedRayon().size;
    if (nRay) aktif.push(`${nRay} rayon`);
    const nPer = getSelectedPeriode().size;
    if (nPer) aktif.push(`${nPer} periode`);
    const nBr = getSelectedBranch().size;
    if (nBr) aktif.push(`${nBr} branch`);
    const nCy = getSelectedCycle().size;
    if (nCy) aktif.push(`${nCy} cycle`);
    const rg = rentangTanggal();
    if (rg.dari || rg.sampai) {
      aktif.push(`tanggal ${rg.dari ? tglTampil(rg.dari) : "awal"} s/d `
        + `${rg.sampai ? tglTampil(rg.sampai) : "akhir"}`);
    }
    if ($("filterPeriodeHht") && $("filterPeriodeHht").checked
        && !$("rowPeriodeHht").classList.contains("hidden")) {
      const luar = state.results.filter((r) => r.diLuarHht).length;
      aktif.push(`hanya yang ada di HHT (menyembunyikan ${luar.toLocaleString("id-ID")} kunjungan `
        + `yang tidak bisa dinilai scan-nya)`);
    }
    if ($("filterInkonsisten") && $("filterInkonsisten").checked) aktif.push("hanya inkonsisten");
    const bcv = $("filterBarcode") ? $("filterBarcode").value : "";
    if (bcv) {
      const nama = $("filterBarcode").selectedOptions[0].textContent.replace(/\s*\(.*\)$/, "");
      aktif.push(`barcode "${nama.trim()}"`);
    }
    const kel = $("filterTitik") ? $("filterTitik").value : "";
    if (kel) {
      const nama = $("filterTitik").selectedOptions[0].textContent.replace(/\s*\(.*\)$/, "");
      aktif.push(`kelompok titik "${nama.trim()}" — hanya kunjungan bermasalah, `
        + `kunjungan flag 1 tidak ikut tampil`);
    }

    if (!aktif.length || tampil === total) {
      el.classList.add("hidden");
      el.innerHTML = "";
      return;
    }
    el.innerHTML = `Menampilkan <b>${tampil.toLocaleString("id-ID")}</b> dari `
      + `<b>${total.toLocaleString("id-ID")}</b> kunjungan yang diupload. `
      + `Disaring oleh: ${aktif.map((x) => escapeHtml(x)).join(" &middot; ")}. `
      + `<button type="button" class="ghost sm" id="hapusFilter">Tampilkan semua</button>`;
    el.classList.remove("hidden");
    $("hapusFilter").addEventListener("click", hapusSemuaFilter);
  }

  // Mengosongkan penyaring saja — file yang sudah diproses tetap dipakai.
  function hapusSemuaFilter() {
    $("search").value = "";
    document.querySelectorAll(".filterCategoryItem, .filterSalesmanItem, .filterRayonItem, "
      + ".filterPeriodeItem, .filterBranchItem, .filterCycleItem")
      .forEach((c) => (c.checked = false));
    ["filterCategoryAll", "filterSalesmanAll", "filterRayonAll", "filterPeriodeAll",
     "filterBranchAll", "filterCycleAll"]
      .forEach((id) => { if ($(id)) $(id).checked = true; });
    const cariSls = $("filterSalesmanSearch");
    if (cariSls) { cariSls.value = ""; cariSls.dispatchEvent(new Event("input")); }
    if (catCtrl) catCtrl.updateLabel();
    if (smCtrl) smCtrl.updateLabel();
    if (ryCtrl) ryCtrl.updateLabel();
    if (pdCtrl) pdCtrl.updateLabel();
    if (brCtrl) brCtrl.updateLabel();
    if (cyCtrl) cyCtrl.updateLabel();
    if ($("filterPeriodeHht")) $("filterPeriodeHht").checked = false;
    if ($("filterInkonsisten")) $("filterInkonsisten").checked = false;
    if ($("filterTitik")) $("filterTitik").value = "";
    if ($("filterBarcode")) $("filterBarcode").value = "";
    if ($("tglDari")) $("tglDari").value = "";
    if ($("tglSampai")) $("tglSampai").value = "";
    hitungTitik();
    applyFilters();
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
      // Kunjungan berulang di outlet yang sama: identitasnya tetap ditulis, tapi
      // di desktop disamarkan supaya terlihat seperti sel yang digabung. Di HP
      // tiap baris berdiri sendiri sebagai kartu, jadi identitasnya dimunculkan
      // lagi — kalau dikosongkan, kartunya jadi tidak jelas milik outlet mana.
      const dup = r.custno === prevCust;
      prevCust = r.custno;
      const nomor = escapeHtml(r.custno);
      const nama = escapeHtml(r.namaTokoEff);
      const sls = escapeHtml(r.salesmanEff);
      // Ditandai kalau pemegang outlet di DMP bukan orang yang berkunjung —
      // itu sendiri temuan: rayon kosong, atau outlet sudah pindah tangan.
      const beda = r.salesmanDmp && r.salesmanDmp !== r.salesmanEff;
      const slsDmp = r.salesmanDmp
        ? `<span class="${beda ? "sls-beda" : ""}"${beda ? ' title="Pemegang outlet di DMP berbeda dengan yang berkunjung"' : ""}>${escapeHtml(r.salesmanDmp)}</span>`
        : "";
      const rayon = escapeHtml(r.rayonEff);
      const cycle = escapeHtml(r.cycleEff);
      const consTag = `<span class="tag-cons cons-${r.consistency}" title="${escapeHtml(cons.hint)}">${escapeHtml(consLabel)}</span>`;
      const dist = r.distance !== null && r.distance !== undefined ? Number(r.distance).toFixed(1) : "";
      return `<tr class="${dup ? "row-dup" : ""}">
        <td><span class="tag tag-${r.category}">${escapeHtml(info.label)}</span></td>
        <td class="col-x${dup ? " dupcell" : ""}">${consTag}</td>
        <td class="masalah">${dup ? "" : masalahSel(r)}</td>
        <td class="mono${dup ? " dupcell" : ""}">${nomor}</td>
        <td class="${dup ? "dupcell" : ""}">${nama}</td>
        <td class="${dup ? "dupcell" : ""}">${sls}</td>
        <td class="col-x${dup ? " dupcell" : ""}">${slsDmp}</td>
        <td class="col-x mono${dup ? " dupcell" : ""}">${rayon}</td>
        <td class="col-x${dup ? " dupcell" : ""}">${cycle}</td>
        <td class="mono">${escapeHtml(r.visitDate || "")}</td>
        <td class="col-x mono">${escapeHtml(r.jamin || "")}</td>
        <td class="col-x mono">${escapeHtml(r.jamout || "")}</td>
        <td class="mono">${escapeHtml(r.flagRadius || "BLANK")}</td>
        <td class="col-x mono">${dist}</td>
        <td class="titik">${dup ? "" : titikSel(r)}</td>
        <td class="mono">${hhtCell}</td>
        <td class="barcode">${dup ? "" : barcodeSel(r)}</td>
        <td>${alasanSel(r)}</td>
        <td class="col-x">${escapeHtml(r.alorReason || "")}</td>
        <td>${escapeHtml(info.suggest)}</td>
      </tr>`;
    }).join("");

    if (!slice.length) {
      tbody.innerHTML = `<tr><td colspan="20" class="empty">Tidak ada baris yang cocok dengan filter ini.</td></tr>`;
    }

    stampLabels(document.getElementById("resultTable"));
    $("countInfo").textContent = `${total.toLocaleString("id-ID")} baris`;
    $("pageInfo").textContent = `Halaman ${state.page} / ${pages}`;
    $("prevPage").disabled = state.page <= 1;
    $("nextPage").disabled = state.page >= pages;
  }

  // Di layar HP, tabel diubah jadi kartu bertumpuk lewat CSS. Supaya tiap nilai
  // tetap punya keterangan, judul kolomnya disalin ke atribut data-label di
  // setiap sel — CSS menampilkannya lewat ::before. Dikerjakan di sini, sekali
  // per render, supaya template barisnya tidak perlu mengulang nama kolom.
  function stampLabels(table) {
    if (!table) return;
    const th = [...table.querySelectorAll("thead th")].map((h) => h.textContent.trim());
    if (!th.length) return;
    for (const tr of table.querySelectorAll("tbody tr")) {
      const tds = tr.children;
      for (let i = 0; i < tds.length; i++) {
        if (th[i]) tds[i].setAttribute("data-label", th[i]);
      }
    }
  }

  function escapeHtml(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
  }

  $("search").addEventListener("input", debounce(applyFilters, 200));
  $("filterInkonsisten").addEventListener("change", applyFilters);

  // Tempatkan menu dropdown supaya selalu kelihatan: balik ke atas kalau ruang
  // di bawah tombol tidak cukup, dan batasi tingginya ke ruang yang tersedia.
  function placeMenu(wrap, menu) {
    menu.classList.remove("up");
    menu.style.maxHeight = "";
    const r = wrap.getBoundingClientRect();
    const below = window.innerHeight - r.bottom - 8;
    const above = r.top - 8;
    const need = menu.offsetHeight;
    if (need > below && above > below) {
      menu.classList.add("up");
      if (need > above) menu.style.maxHeight = Math.max(140, above) + "px";
    } else if (need > below) {
      menu.style.maxHeight = Math.max(140, below) + "px";
    }
  }

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
      if (willOpen) placeMenu(wrap, menu);
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

  const ryCtrl = wireMulti("filterRayon", "filterRayonBtn", "filterRayonMenu",
    "filterRayonAll", "filterRayonItem", "filterRayonLabel", "rayon");

  const pdCtrl = wireMulti("filterPeriode", "filterPeriodeBtn", "filterPeriodeMenu",
    "filterPeriodeAll", "filterPeriodeItem", "filterPeriodeLabel", "periode");

  const brCtrl = wireMulti("filterBranch", "filterBranchBtn", "filterBranchMenu",
    "filterBranchAll", "filterBranchItem", "filterBranchLabel", "branch");

  const cyCtrl = wireMulti("filterCycle", "filterCycleBtn", "filterCycleMenu",
    "filterCycleAll", "filterCycleItem", "filterCycleLabel", "cycle");

  // Isi daftar centang sebuah penyaring. Bentuknya sama untuk branch dan cycle,
  // jadi ditulis sekali: daftar nilai -> daftar <label>, lalu dipasangi pemicu.
  // Penyaring yang isinya kurang dari dua pilihan disembunyikan — dropdown
  // berisi satu pilihan cuma memenuhi layar tanpa bisa menyaring apa pun.
  // names boleh berupa daftar teks biasa, atau daftar { nilai, label } kalau
  // yang disimpan berbeda dengan yang dibaca orang — seperti branch, yang
  // disaring pakai kodenya tapi ditampilkan pakai namanya.
  function isiFilter(listId, kelas, ctrl, wadahId, names) {
    const list = $(listId);
    if (!list) return;
    list.innerHTML = names.map((n) => {
      const nilai = escapeHtml(typeof n === "string" ? n : n.nilai);
      const teks = escapeHtml(typeof n === "string" ? n : n.label);
      return `<label class="multi-opt"><input type="checkbox" value="${nilai}" class="${kelas}" /> ${teks}</label>`;
    }).join("");
    list.querySelectorAll("." + kelas).forEach((c) => {
      c.addEventListener("change", () => { ctrl.updateLabel(); applyFilters(); });
    });
    ctrl.updateLabel();
    if ($(wadahId)) $(wadahId).classList.toggle("hidden", names.length < 2);
  }

  const populateBranch = (kodes) =>
    isiFilter("filterBranchList", "filterBranchItem", brCtrl, "filterBranch",
      kodes.map((k) => ({ nilai: k, label: labelBranch(k) })));
  const populateCycle = (names) =>
    isiFilter("filterCycleList", "filterCycleItem", cyCtrl, "filterCycle", names);

  function populatePeriode(names) {
    const list = $("filterPeriodeList");
    if (!list) return;
    list.innerHTML = names.map((n) => {
      const safe = escapeHtml(n);
      return `<label class="multi-opt"><input type="checkbox" value="${safe}" class="filterPeriodeItem" /> ${safe}</label>`;
    }).join("");
    list.querySelectorAll(".filterPeriodeItem").forEach((c) => {
      c.addEventListener("change", () => { pdCtrl.updateLabel(); applyFilters(); });
    });
    pdCtrl.updateLabel();
    // Kalau datanya cuma satu periode, filternya tidak ada gunanya — disembunyikan.
    $("filterPeriode").classList.toggle("hidden", names.length < 2);
  }

  function populateRayon(names) {
    const list = $("filterRayonList");
    list.innerHTML = names.map((n) => {
      const safe = escapeHtml(n);
      return `<label class="multi-opt"><input type="checkbox" value="${safe}" class="filterRayonItem" /> ${safe}</label>`;
    }).join("");
    list.querySelectorAll(".filterRayonItem").forEach((c) => {
      c.addEventListener("change", () => { ryCtrl.updateLabel(); applyFilters(); });
    });
    ryCtrl.updateLabel();
  }

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
    if (segarkanAksiSalesman) segarkanAksiSalesman();
  }

  // in-menu search for salesman
  // Kotak cari di dalam dropdown salesman. Selain menyaring daftarnya, ia bisa
  // MEMILIH sekaligus semua yang cocok: mengetik "M3" lalu Enter mencentang
  // seluruh salesman M3. Tanpa itu, memilih satu tim berarti mencentang puluhan
  // baris satu per satu — di file empat cabang daftarnya 368 orang, dan yang
  // terjadi bukan kerja teliti, tapi kerja yang dilewati.
  //
  // Mengetik SENDIRI tidak langsung memilih. Kotak yang sama dipakai untuk
  // mencari satu orang lalu mencentang dia saja, dan kalau tiap huruf mengubah
  // pilihan, kebiasaan itu hilang — mengetik "m" akan mencentang ratusan orang
  // sebelum huruf kedua sempat diketik. Jadi memilihnya satu tekan: Enter, atau
  // tombol yang muncul tepat di bawah kotaknya, lengkap dengan jumlahnya.
  function wirePencarianSalesman(searchId, listId, itemClass, aksiId, pilihId, hapusId,
                                 ctrl, onChange) {
    const cari = $(searchId);
    if (!cari) return;
    const kotak = () => [...$(listId).querySelectorAll(".multi-opt")];
    const cocok = () => {
      const q = cari.value.trim().toLowerCase();
      if (!q) return [];
      return kotak().filter((el) => (el.getAttribute("data-name") || "").includes(q));
    };

    function segarkanAksi() {
      const ada = cocok();
      const c = ada.map((el) => el.querySelector("." + itemClass)).filter(Boolean);
      const belum = c.filter((x) => !x.checked).length;
      const sudah = c.length - belum;
      const aksi = $(aksiId), pilih = $(pilihId), hapus = $(hapusId);
      if (!aksi) return;
      aksi.classList.toggle("hidden", !c.length);
      if (!c.length) return;
      pilih.classList.toggle("hidden", !belum);
      pilih.textContent = `✓ Pilih ${belum.toLocaleString("id-ID")} yang cocok`;
      hapus.classList.toggle("hidden", !sudah);
      hapus.textContent = `Hapus ${sudah.toLocaleString("id-ID")} pilihan`;
    }

    function ubah(jadi) {
      const c = cocok().map((el) => el.querySelector("." + itemClass)).filter(Boolean);
      if (!c.length) return;
      c.forEach((x) => { x.checked = jadi; });
      ctrl().updateLabel();
      segarkanAksi();
      onChange();
    }

    cari.addEventListener("input", () => {
      const q = cari.value.trim().toLowerCase();
      kotak().forEach((el) => {
        el.style.display = !q || (el.getAttribute("data-name") || "").includes(q) ? "" : "none";
      });
      segarkanAksi();
    });
    cari.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      // Kotak ini di dalam <form>? Bukan — tapi Enter di input type=search juga
      // memicu "cari" bawaan browser yang mengosongkan kotaknya di sebagian HP.
      e.preventDefault();
      ubah(true);
    });
    // Tombolnya di dalam menu dropdown; kliknya tidak boleh ikut menutup menu.
    for (const [id, jadi] of [[pilihId, true], [hapusId, false]]) {
      if (!$(id)) continue;
      $(id).addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); ubah(jadi); });
    }
    // Dipanggil lagi dari luar waktu daftarnya baru diisi ulang.
    return segarkanAksi;
  }

  const segarkanAksiSalesman = wirePencarianSalesman(
    "filterSalesmanSearch", "filterSalesmanList", "filterSalesmanItem",
    "filterSalesmanAksi", "filterSalesmanPilih", "filterSalesmanHapus",
    () => smCtrl, applyFilters);
  if ($("filterTitik")) $("filterTitik").addEventListener("change", applyFilters);
  if ($("filterBarcode")) $("filterBarcode").addEventListener("change", applyFilters);
  if ($("filterPeriodeHht")) $("filterPeriodeHht").addEventListener("change", applyFilters);
  // Rentang tanggal juga menentukan penilaian titik: kunjungan lama sering
  // bermasalah karena titik masternya memang belum diperbaiki waktu itu.
  // Jadi analisanya dihitung ulang, bukan cuma barisnya yang disaring.
  for (const id of ["tglDari", "tglSampai"]) {
    if ($(id)) $(id).addEventListener("change", () => { hitungTitik(); applyFilters(); });
  }
  if ($("tglReset")) $("tglReset").addEventListener("click", () => {
    $("tglDari").value = ""; $("tglSampai").value = "";
    hitungTitik(); applyFilters();
  });
  if ($("rankMore")) $("rankMore").addEventListener("click", () => {
    state.rankSemua = !state.rankSemua;
    renderRangking();
  });
  $("prevPage").addEventListener("click", () => { if (state.page > 1) { state.page--; renderTable(); } });
  $("nextPage").addEventListener("click", () => { state.page++; renderTable(); });

  // Menulis file di browser itu mahal. Diukur pada 190.000 baris x 26 kolom
  // di Chromium: jalur Excel butuh 37 detik dan puncak memori 1,7 GB (versi
  // lamanya, yang menyusun satu objek per baris, malah menggantung lebih dari
  // 4 menit); CSV cukup 1,4 detik dan 0,9 GB. Di HP jalur Excel sebesar itu
  // pasti gagal. Jadi di atas ambang ini filenya ditulis sebagai CSV — tetap
  // langsung terbuka di Excel.
  const BATAS_XLSX = 30000;

  const KEPALA_HASIL = ["Kategori", "Konsistensi", "Masalah Outlet", "Jumlah Kunjungan Outlet", "Kode Outlet",
    "Nama Toko", "Salesman", "Salesman DMP", "Rayon (DMP)", "Cycle", "Alamat Toko", "Visit Date",
    "Jam Masuk", "Jam Keluar", "Flag Radius", "Distance", "Lat Visit", "Long Visit",
    "Lat Val", "Long Val", "HHT", "Tipe Scan", "Alasan HHT", "Alasan Dari Tanggal",
    "Alor Reason", "Saran", "Barcode", "Kunjungan Discan", "Alasan Terakhir",
    "Titik Toko", "Lat Usulan", "Long Usulan", "Keyakinan Usulan", "Catatan Usulan",
    "Total Kunjungan Outlet", "Total Di Luar Radius", "Salesman Pernah Berkunjung",
    "Branch", "Kode Branch",
    "Kunjungan Tiap (hari)", "Cycle Seharusnya (hari)", "Selisih Cycle (hari)",
    "Salesman Sebelumnya", "Kunjungan Tiap (hari) — Sekarang",
    "Kunjungan Tiap (hari) — Sebelumnya", "Kunjungan Terakhir Sebelumnya"];

  const TITIK_TEKS = {
    USUL: "Perlu diperbaiki",
    KEMBALI: "Kembalikan titik lama",
    TANYA: "Kunjungan berpencar — tanya salesman",
    PAS: "Sudah benar",
    SATU: "Baru 1 kunjungan bermasalah",
  };

  // Koordinat ditulis sebagai teks bertitik, bukan angka. Excel berbahasa
  // Indonesia menampilkan angka desimal dengan koma (-6,183851), dan angka
  // seperti itu salah begitu ditempel ke sistem yang menunggu titik. Kolom
  // LAT VAL di EDI sendiri juga berupa teks bertitik, jadi ini sekalian
  // menyamakan bentuknya.
  const koordTeks = (v) => (v === null || v === undefined ? "" : Number(v).toFixed(6));

  // Baris ditulis sebagai array, bukan objek. Satu objek berisi 26 nama kolom
  // dikali ratusan ribu baris menghabiskan memori sendiri sebelum filenya
  // sempat dibuat.
  function barisHasil(r) {
    const info = CATEGORY_INFO[r.category];
    const cons = CONSISTENCY_INFO[r.consistency] || CONSISTENCY_INFO.SINGLE;
    const u = state.titikByOutlet && state.titikByOutlet.get(r.custno);
    const bc = state.barcodeByOutlet && state.barcodeByOutlet.get(r.custno);
    // Keterangannya di satu kolom, koordinatnya di kolom sendiri-sendiri —
    // supaya angkanya tinggal disalin ke master, tidak perlu dipotong dulu
    // dari tengah kalimat.
    const titik = !u ? ""
      : u.bucket === "PAS" && u.sebab === "beres" ? "Sudah beres — kunjungan terakhir in radius"
      : u.bucket === "PAS" && u.sebab === "diperbaiki" ? "Sudah diperbaiki setelah tanggal ini"
      : TITIK_TEKS[u.bucket] || "";
    const g = globalOutlet(r.custno);
    const fr = frekOutlet(r.custno);
    const tgtCycle = cycleHari(r.cycleEff);
    const adaUsulan = u && (u.bucket === "USUL" || u.bucket === "KEMBALI");
    const masalah = sisiMasalah(r);
    return [
      info.label, cons.label, masalah ? MASALAH_INFO[masalah].label : "", r.visitCount, r.custno, r.namaTokoEff, r.salesmanEff, r.salesmanDmp,
      r.rayonEff, r.cycleEff, r.alamatEff, r.visitDate || "", r.jamin || "", r.jamout || "",
      r.flagRadius || "BLANK", r.distance ?? "", r.latVisit ?? "", r.longVisit ?? "",
      r.latVal ?? "", r.longVal ?? "",
      r.hht ? (r.hht.hht || "") : "", r.hht ? (r.hht.tipeScan || "") : "",
      alasanHht(r) || (r.alasanLuar ? r.alasanLuar.alasan : ""),
      alasanHht(r) ? "" : (r.alasanLuar ? (r.alasanLuar.tgl || "tanggal lain") : ""),
      r.alorReason || "", info.suggest,
      bc ? BARCODE_INFO[bc.bucket].label : "",
      bc ? `${bc.scan} dari ${bc.n}` : "", bc ? bc.alasan : "",
      titik,
      adaUsulan ? koordTeks(u.mLat) : "", adaUsulan ? koordTeks(u.mLon) : "",
      adaUsulan ? u.yakin : "", u ? catatanUsulan(u) : "",
      g.n, g.luar, [...g.sls].join("; "),
      r.branchEff ? namaBranch(r.branchEff) : "", r.branchEff || "",
      fr.hari ?? "", tgtCycle ?? "",
      (fr.hari !== null && fr.hari !== undefined && tgtCycle) ? fr.hari - tgtCycle : "",
      ...Object.values(kolomCycleSls(r.custno)),
    ];
  }

  // "sep=;" di baris pertama membuat Excel memisah kolomnya sendiri tanpa
  // wizard import, apa pun setelan pemisah daftar di komputernya.
  function keCsv(aoa) {
    const bag = ["sep=;"];
    for (const baris of aoa) {
      const b = [];
      for (const v of baris) {
        const t = v === null || v === undefined ? "" : String(v);
        b.push(/[";\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t);
      }
      bag.push(b.join(";"));
    }
    return bag.join("\r\n");
  }

  // Pesan hasil export ditaruh tepat di bawah tombolnya. Tidak bisa memakai
  // baris status di atas: setelah panel upload mengkerut, tulisannya tidak
  // ikut diperbarui lagi, jadi pesannya tidak akan pernah terbaca.
  function pesanExport(teks) {
    const el = $("exportHint");
    if (!el) return;
    el.innerHTML = String(teks).replace(/&middot;/g, "&middot;");
    el.classList.toggle("hidden", !teks);
  }

  // Dua lingkungan, dua cara menyerahkan file. Di GitHub Pages halaman boleh
  // mengunduh sendiri lewat tautan biasa. Di dalam artifact claude.ai tautan
  // seperti itu tidak melakukan apa-apa sama sekali — filenya harus diserahkan
  // lewat izin download milik penampilnya, dan penampil boleh menolak.
  async function unduh(nama, isi, tipe) {
    const blob = new Blob(isi, { type: tipe });
    if (window.claude && typeof window.claude.use === "function") {
      let dl = null;
      try { dl = await window.claude.use("downloads"); } catch (e) { dl = null; }
      if (dl) {
        try {
          await dl.save({ filename: nama, data: blob });
        } catch (e) {
          if (e && e.code === "declined") return;   // penampil membatalkan
          throw new Error("Penyimpanan file ditolak penampil"
            + (e && e.code ? ` (${e.code})` : "") + ". Coba buka versi GitHub Pages.");
        }
        return;
      }
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = nama;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  // Daftar usulan titik: satu baris per outlet, bukan per kunjungan.
  function daftarUsulan() {
    const sudah = new Set(), usulan = [];
    for (const r of barisKerja()) {
      const u = state.titikByOutlet && state.titikByOutlet.get(r.custno);
      if (!u || (u.bucket !== "USUL" && u.bucket !== "KEMBALI") || sudah.has(r.custno)) continue;
      sudah.add(r.custno);
      usulan.push(titikBarisExcel(r.custno, u, r));
    }
    // Yang paling pasti didahulukan: mengembalikan koordinat yang dulu terbukti
    // lolos jauh lebih meyakinkan daripada menebak dari sebaran kunjungan.
    const urutan = { Tinggi: 0, Sedang: 1, Rendah: 2 };
    usulan.sort((x, y) =>
      (x.Tindakan < y.Tindakan ? -1 : x.Tindakan > y.Tindakan ? 1 : 0)
      || urutan[x.Keyakinan] - urutan[y.Keyakinan]
      || (y["Kunjungan Jadi IN RADIUS"] || 0) - (x["Kunjungan Jadi IN RADIUS"] || 0));
    return usulan;
  }

  // ================= Rangking salesman =================
  // Satu angka yang bisa diurutkan, disusun dari dua hal yang selama ini
  // dinilai terpisah: radius dan scan barcode. Kunjungan yang lolos dua-duanya
  // bernilai penuh; yang lolos salah satu bernilai separuh; yang tidak
  // memberi bukti apa pun bernilai nol.
  //
  // Yang dipakai RATA-RATA per kunjungan, bukan total. Total selalu dimenangkan
  // salesman berwilayah besar — itu mengukur luas rayon, bukan mutu kerjanya.
  // Supaya sampel kecil tidak menipu, jumlah kunjungannya ikut ditampilkan.
  const POIN = {
    "1-SCAN": 3,        // masuk radius dan barcodenya discan — bukti terkuat
    "1-NOSCAN": 2,      // radius benar, barcode belum
    "0-SCAN": 2,        // barcode discan, tapi absennya di luar radius
    "BLANK-SCAN": 1,    // discan tapi radiusnya belum tervalidasi sama sekali
    "0-NOSCAN": 0,      // tidak ada bukti radius maupun scan
    "BLANK-NOSCAN": 0,  // outlet tidak ketemu
  };
  const POIN_MAX = 3;

  // Batas kunjungan supaya ikut dirangking. Rata-rata poin itu pecahan: satu
  // kunjungan yang kebetulan flag 1 + scan menghasilkan nilai 100 dan langsung
  // duduk di peringkat 1, mengalahkan orang yang mengerjakan dua ratus
  // kunjungan dengan mutu nyata. Yang di bawah batas tetap ditulis lengkap di
  // bagian bawah sheet, hanya tanpa nomor peringkat.
  const MIN_KUNJUNGAN = 10;

  function daftarRangking() {
    const per = new Map();
    for (const r of kunjunganTerpilih()) {
      // Dinilai salesman yang BERKUNJUNG: yang dirangking mutu kerjanya di
      // lapangan, bukan siapa yang memegang outletnya di master.
      const nama = r.salesmanEff || "(tanpa nama salesman)";
      let v = per.get(nama);
      if (!v) {
        v = { nama, n: 0, poin: 0, outlet: new Set(), rayon: new Set(), branch: new Set(), kat: {} };
        for (const k of Object.keys(CATEGORY_INFO)) v.kat[k] = 0;
        per.set(nama, v);
      }
      v.n++;
      v.poin += POIN[r.category] || 0;
      v.kat[r.category]++;
      v.outlet.add(r.custno);
      if (r.rayonEff) v.rayon.add(r.rayonEff);
      if (r.branchEff) v.branch.add(r.branchEff);
    }
    const baris = [...per.values()].map((v) => {
      const rata = v.n ? v.poin / v.n : 0;
      return {
        nama: v.nama, n: v.n, poin: v.poin, rata,
        nilai: Math.round((rata / POIN_MAX) * 1000) / 10,   // 0-100
        outlet: v.outlet.size,
        rayon: [...v.rayon].sort().join(", "),
        branch: [...v.branch].map(namaBranch).sort().join(", "),
        kodeBranch: [...v.branch].sort().join(", "),
        kat: v.kat,
      };
    });
    // Rata-rata dulu, lalu jumlah kunjungan: dua salesman dengan mutu sama,
    // yang mengerjakan lebih banyak kunjungan pantas di atas.
    const urut = (a, b) => b.rata - a.rata || b.n - a.n
      || String(a.nama).localeCompare(String(b.nama));
    const cukup = baris.filter((x) => x.n >= MIN_KUNJUNGAN).sort(urut);
    const sedikit = baris.filter((x) => x.n < MIN_KUNJUNGAN).sort(urut);
    cukup.forEach((x, i) => { x.peringkat = i + 1; });
    sedikit.forEach((x) => {
      x.peringkat = "";
      x.catatan = `Baru ${x.n} kunjungan — belum cukup untuk dirangking `
        + `(minimal ${MIN_KUNJUNGAN})`;
    });
    return [...cukup, ...sedikit];
  }

  function sheetRangking(baris) {
    return baris.map((x) => ({
      Peringkat: x.peringkat,
      Salesman: x.nama,
      Catatan: x.catatan || "",
      Branch: x.branch,
      "Kode Branch": x.kodeBranch,
      Rayon: x.rayon,
      "Nilai (0-100)": x.nilai,
      "Rata-rata Poin": Math.round(x.rata * 100) / 100,
      "Total Poin": x.poin,
      "Jumlah Kunjungan": x.n,
      "Jumlah Outlet": x.outlet,
      "Flag 1 + Scan": x.kat["1-SCAN"],
      "Flag 1 + Tidak scan": x.kat["1-NOSCAN"],
      "Flag 0 + Scan": x.kat["0-SCAN"],
      "Flag 0 + Tidak scan": x.kat["0-NOSCAN"],
      "Blank + Scan": x.kat["BLANK-SCAN"],
      "Blank + Tidak scan": x.kat["BLANK-NOSCAN"],
    }));
  }

  // ================= Semua outlet DMP pada saringan yang dipilih =================
  // Sheet "Hasil" berisi satu baris per KUNJUNGAN, jadi outlet yang tidak
  // pernah dikunjungi sama sekali tidak muncul di situ — padahal justru itu
  // yang sering perlu dikejar. Sheet ini berangkat dari sisi sebaliknya: mulai
  // dari daftar outlet di DMP, lalu ditempeli apa yang terjadi pada outlet itu.
  // Outlet tanpa kunjungan tetap dapat barisnya, ditandai.
  //
  // Hanya outlet AKTIF yang diambil. Di file contoh, 102.574 dari 148.802
  // outlet berstatus mati (tanpa salesman, tanpa rayon) — kalau ikut, sheetnya
  // jadi tumpukan baris kosong yang menutupi yang benar-benar perlu dilihat.
  function daftarSemuaOutlet() {
    if (!state.dmpIndex || !state.dmpIndex.size) return [];
    const sms = getSelectedSalesmen();
    const rys = getSelectedRayon();
    // Tanpa saringan sama sekali, ini berarti seluruh outlet aktif di DMP
    // (46 ribu di file contoh) — bukan yang dimaksud siapa pun yang menekan
    // Export, dan cukup besar untuk menggagalkan pembuatan filenya.
    if (!sms.size && !rys.size) return [];

    // Kunjungan yang dipakai: seluruh yang lolos saringan tanggal/periode/
    // pencarian, tanpa memandang jenis masalahnya — sheet ini memang harus
    // memuat yang bermasalah maupun yang tidak.
    const perOutlet = new Map();
    for (const r of kunjunganTerpilih()) {
      let v = perOutlet.get(r.custno);
      if (!v) { v = []; perOutlet.set(r.custno, v); }
      v.push(r);
    }

    const baris = [];
    for (const [kode, d] of state.dmpIndex) {
      if (!d.aktif) continue;
      // Penugasan ganda ikut diperiksa: outlet yang dipegang dua salesman harus
      // muncul kalau salah satunya yang dipilih.
      const pasangan = [{ s: d.salesman, r: d.rayon }, ...(d.alt || [])];
      const cocok = pasangan.some((x) =>
        (!sms.size || sms.has(x.s)) && (!rys.size || rys.has(x.r)));
      if (!cocok) continue;

      const vs = perOutlet.get(kode) || [];
      const luar = vs.filter((x) => x.flagRadius !== "1").length;
      const akhir = vs.length
        ? vs.reduce((a, x) => (String(x.tglIso || "") > String(a.tglIso || "") ? x : a), vs[0])
        : null;
      const u = state.titikByOutlet && state.titikByOutlet.get(kode);
      const bc = state.barcodeByOutlet && state.barcodeByOutlet.get(kode);
      const masalah = vs.length ? sisiMasalah(vs[0]) : "";
      const pengunjung = [...new Set(vs.map((x) => x.salesmanEff).filter(Boolean))];
      const g = globalOutlet(kode);
      const fr = frekOutlet(kode);
      const tgtCycle = cycleHari(d.cycle);
      baris.push({
        "Kode Outlet": kode,
        "Nama Toko": d.namaOutlet || "",
        "Salesman (DMP)": d.salesman || "",
        "Rayon (DMP)": d.rayon || "",
        Branch: d.branch ? namaBranch(d.branch) : "",
        "Kode Branch": d.branch || "",
        Cycle: d.cycle || "",
        "Kunjungan Tiap (hari)": fr.hari ?? "",
        "Cycle Seharusnya (hari)": tgtCycle ?? "",
        "Selisih Cycle (hari)":
          (fr.hari !== null && fr.hari !== undefined && tgtCycle) ? fr.hari - tgtCycle : "",
        ...kolomCycleSls(kode),
        "Alamat (DMP)": d.alamat || "",
        "Penugasan Lain": (d.alt || []).map((a) => `${a.s}${a.r ? ` (${a.r})` : ""}`).join("; "),
        // Ditaruh tepat sebelum Status: kalau statusnya "belum pernah
        // dikunjungi", yang pertama perlu dilihat memang umurnya.
        "Tanggal Dibuat": d.dibuat ? tglTampil(d.dibuat) : "",
        "Umur Outlet (hari)": umurHari(d.dibuat),
        "Dibuat Setelah Data Mulai": !d.dibuat || !tglDataMulai() ? ""
          : d.dibuat > tglDataMulai() ? "Ya" : "Tidak",
        Status: vs.length ? "Ada kunjungan" : "Belum pernah dikunjungi",
        "Jumlah Kunjungan": vs.length,
        "Kunjungan In Radius": vs.length - luar,
        "Kunjungan Di Luar Radius": luar,
        "Kunjungan Terakhir": akhir ? (akhir.visitDate || "") : "",
        "Dikunjungi Oleh": pengunjung.join("; "),
        // Empat kolom di atas mengikuti saringan tanggal/periode yang dipilih.
        // Yang di bawah ini riwayat utuh outletnya, tanpa penyaring apa pun —
        // termasuk kunjungan oleh salesman yang dulu memegangnya.
        "Status Radius Terakhir": akhir ? (akhir.flagRadius === "1" ? "In radius" : "Di luar radius") : "",
        "Total Kunjungan (semua periode)": g.n,
        "Total In Radius (semua periode)": g.dalam,
        "Total Di Luar Radius (semua periode)": g.luar,
        "Salesman Pernah Berkunjung": [...g.sls].join("; "),
        "Masalah Outlet": masalah ? MASALAH_INFO[masalah].label : "",
        "Titik Toko": !u ? ""
          : u.bucket === "PAS" && u.sebab === "beres" ? "Sudah beres — kunjungan terakhir in radius"
          : u.bucket === "PAS" && u.sebab === "diperbaiki" ? "Sudah diperbaiki setelah tanggal ini"
          : TITIK_TEKS[u.bucket] || "",
        Barcode: bc ? BARCODE_INFO[bc.bucket].label : "",
        "Perlu Ditindaklanjuti": (masalah
          || (u && (u.bucket === "USUL" || u.bucket === "KEMBALI"))
          || (bc && (bc.bucket === "BARU" || bc.bucket === "BELUM"))) ? "Ya" : "Tidak",
      });
    }
    // Yang belum pernah dikunjungi ditaruh paling atas: itu yang paling mudah
    // terlewat justru karena tidak meninggalkan jejak apa pun di data kunjungan.
    const urut = { "Belum pernah dikunjungi": 0, "Ada kunjungan": 1 };
    baris.sort((a, b) => urut[a.Status] - urut[b.Status]
      || String(a["Salesman (DMP)"]).localeCompare(String(b["Salesman (DMP)"]))
      || String(a["Kode Outlet"]).localeCompare(String(b["Kode Outlet"])));
    return baris;
  }

  // Sel hyperlink di xlsx: teksnya yang terbaca, alamatnya di properti "l".
  // Alamat lengkap tidak ditulis sebagai isi sel supaya kolomnya tidak melebar
  // dan yang dibaca orang tetap "Buka peta" / "Lihat toko".
  function sheetUsulan(usulan) {
    const bersih = usulan.map((u) => {
      const { _pin, _pano, ...sisa } = u;
      return sisa;
    });
    const ws = XLSX.utils.json_to_sheet(bersih);
    const kepala = XLSX.utils.sheet_to_json(ws, { header: 1 })[0] || [];
    const kolPin = kepala.indexOf("Buka Peta"), kolPano = kepala.indexOf("Lihat Toko");
    for (let i = 0; i < usulan.length; i++) {
      const pasang = (kol, url, judul) => {
        if (kol < 0 || !url) return;
        const sel = ws[XLSX.utils.encode_cell({ r: i + 1, c: kol })];
        if (sel) sel.l = { Target: url, Tooltip: judul };
      };
      pasang(kolPin, usulan[i]._pin, "Buka titik usulan di Google Maps");
      pasang(kolPano, usulan[i]._pano, "Street View — lihat muka tokonya");
    }
    return ws;
  }

  // Baris untuk daftar kerja: penyaring yang dipilih pengguna tetap dihormati
  // (salesman, rayon, tanggal, kategori), kecuali cakupan HHT. Kategori tetap
  // ikut karena itu pilihan sadar pengguna.
  // Seluruh kunjungan ke outlet yang sedang dipilih — apa pun keadaannya.
  // Saringan salesman, rayon, tanggal, periode, dan pencarian tetap berlaku;
  // yang sengaja diabaikan cuma penyaring "jenis masalah" (centang HHT, dropdown
  // titik, dropdown barcode) dan kategori. Penyaring itu untuk membaca layar,
  // bukan untuk menentukan isi file — sekali dipakai memotong isi Excel, outlet
  // yang keadaannya baik lenyap dan isinya jadi tidak sejalan dengan lembar
  // cetak maupun sheet Semua Outlet.
  function kunjunganTerpilih() {
    return getBaseFiltered({ abaikanHht: true, abaikanTitik: true, abaikanBarcode: true });
  }

  function barisKerja() {
    const base = getBaseFiltered({ abaikanHht: true });
    const cats = getSelectedCategories();
    return cats.size === 0 ? base : base.filter((r) => cats.has(r.category));
  }

  // Daftar kerja barcode: satu baris per outlet, hanya yang perlu ditindaklanjuti.
  // Yang sudah beres sendiri sengaja tidak ikut — itu justru inti gunanya.
  function daftarBarcode() {
    if (!state.barcodeByOutlet || !state.barcodeByOutlet.size) return [];
    const sudah = new Set(), keluar = [];
    for (const r of barisKerja()) {
      const u = state.barcodeByOutlet.get(r.custno);
      if (!u || (u.bucket !== "BARU" && u.bucket !== "BELUM") || sudah.has(r.custno)) continue;
      sudah.add(r.custno);
      const g = globalOutlet(r.custno);
      keluar.push({
        Keadaan: BARCODE_INFO[u.bucket].label,
        "Kode Outlet": r.custno,
        "Nama Toko": r.namaTokoEff,
        "Salesman (DMP)": r.salesmanDmp || "",
        "Dikunjungi Oleh": r.salesmanEff,
        "Rayon (DMP)": r.rayonEff,
        Cycle: r.cycleEff || "",
        ...kolomCycleSls(r.custno),
        "Alamat (DMP)": r.alamatEff || "",
        "Kunjungan Discan": `${u.scan} dari ${u.n}`,
        "Jumlah Kunjungan": u.n,
        "Kunjungan Terakhir": u.tglAkhir,
        // Dua kolom ini yang menjawab "sejak kapan": tanggal kunjungan berhasil
        // yang terakhir, dan tanggal gagal pertama sesudahnya.
        "Terakhir Berhasil Discan": u.terakhirBerhasil || "",
        "Mulai Bermasalah": u.mulaiGagal || "",
        "Alasan Terakhir": u.alasan || "",
        // Alasan sering tidak dicatat di kunjungan terakhir, padahal ada di
        // kunjungan gagal sebelumnya. Ditulis beserta tanggalnya supaya tidak
        // disangka alasan hari terakhir.
        "Alasan Tercatat": u.alasanTercatat ? `${u.alasanTercatat} (${u.alasanTgl})` : "",
        // Riwayat kunjungan utuh dari EDI, tanpa penyaring apa pun — berguna
        // untuk menilai apakah barcode yang gagal itu sudah lama begitu atau
        // baru sejak outletnya berpindah salesman.
        "Total Kunjungan Outlet": g.n,
        "Salesman Pernah Berkunjung": [...g.sls].join("; "),
      });
    }
    // Yang belum pernah discan didahulukan, lalu yang paling sering dikunjungi
    // — makin sering didatangi, makin sering pula kegagalannya terulang.
    const urut = { "Belum pernah discan": 0, "Baru bermasalah": 1 };
    keluar.sort((a, b) => urut[a.Keadaan] - urut[b.Keadaan]
      || b["Jumlah Kunjungan"] - a["Jumlah Kunjungan"]);
    return keluar;
  }

  // ================= Lembar cetak per salesman =================
  // Dipakai pagi hari: cetak masalah satu rayon, bawa ke lapangan, tanyakan ke
  // salesmannya. Karena itu isinya dipilih dari sudut pandang orang yang
  // ditanya — apa yang terjadi di outletnya, dan apa yang perlu dipastikan —
  // bukan istilah teknis dashboard.
  // Sesekali meleset bukan pola. Outlet yang sepuluh dari sebelas kunjungannya
  // IN RADIUS tidak ada yang perlu ditanyakan — titik tokonya jelas benar, dan
  // mencetaknya cuma menghabiskan kertas serta melebarkan daftar yang harusnya
  // bisa dikerjakan pagi itu juga. Yang ikut tercetak hanya outlet yang minimal
  // sepertiga kunjungannya di luar radius. Angka sepertiga ini sama dengan yang
  // dipakai menilai kerapatan kunjungan pada usulan titik, supaya satu web
  // tidak memakai dua ukuran "cukup sering" yang berbeda.
  // Catatan: ini aturan lembar cetak saja. Tabel dan Excel tetap memuat semua
  // kunjungan apa adanya — yang disaring di sini daftar kerjanya, bukan datanya.
  const AMBANG_LUAR = 1 / 3;

  // Dipakai dua tempat: menyusun isi baris, dan menghitung chip "N outlet
  // radius" di kop. Kalau dihitung terpisah, angkanya bisa berbeda dengan isinya.
  function radiusLayakTanya(rows) {
    const luar = rows.filter((x) => x.flagRadius !== "1");
    if (!luar.length) return null;
    // Yang menentukan KUNJUNGAN TERAKHIR. Kalau kunjungan paling akhir sudah
    // IN RADIUS, masalahnya sudah selesai — entah titiknya sudah dibetulkan
    // atau salesmannya sudah absen di tempat yang benar. Mencetaknya lagi
    // membuat orang bertanya-tanya apakah temuan ini masih berlaku atau sisa
    // masa lalu, dan itu justru menghabiskan waktu di lapangan.
    // Riwayat lamanya tidak hilang: tetap ada di tabel, di sheet Hasil, dan di
    // kolom riwayat outlet.
    const urutTgl = rows.slice().sort((a, b) =>
      String(a.tglIso || "").localeCompare(String(b.tglIso || "")));
    if (urutTgl[urutTgl.length - 1].flagRadius === "1") return null;
    if (luar.length / rows.length < AMBANG_LUAR) return null;
    // WAJIB diurutkan menurut tanggal. Urutan aslinya urutan baris di file EDI,
    // dan file itu lazim dikelompokkan per salesman dulu — jadi baris paling
    // bawah untuk satu outlet belum tentu kunjungan paling akhir. Outlet yang
    // dikunjungi dua salesman bisa menampilkan "absen terakhir" dari kunjungan
    // lama milik salesman lain, belasan kilometer dari posisi yang sebenarnya
    // terakhir. Koordinat yang salah begitu tidak kelihatan salah di kertas.
    return luar.slice().sort((a, b) =>
      String(a.tglIso || "").localeCompare(String(b.tglIso || "")));
  }

  function masalahOutlet(rows) {
    const r = rows[0];
    const u = state.titikByOutlet && state.titikByOutlet.get(r.custno);
    const bc = state.barcodeByOutlet && state.barcodeByOutlet.get(r.custno);
    const masalah = [], tanya = [], jawab = [];

    // Titik yang diusulkan web ini, kalau ada. USUL berarti dihitung dari
    // sebaran kunjungan; KEMBALI berarti koordinat lama yang dulu sudah
    // terbukti menghasilkan flag 1. Keduanya menyimpan angkanya di mLat/mLon.
    const usul = u && (u.bucket === "USUL" || u.bucket === "KEMBALI") ? u : null;

    const luar = radiusLayakTanya(rows);
    if (luar) {
      // Tanggalnya dipotong 3 terakhir supaya barisnya tidak memanjang. Kalau
      // dipotong, itu dikatakan — daftar 3 tanggal di sebelah angka "8 dari 10"
      // tanpa keterangan terbaca seperti datanya yang tidak cocok.
      const tgl = luar.slice(-3).map((x) => String(x.visitDate || "").slice(0, 5)).filter(Boolean);
      const awalan = luar.length > tgl.length && tgl.length ? "3 terakhir: " : "";
      // Posisi absen TERAKHIR: itu yang paling bisa dijawab salesmannya hari ini
      // ("waktu itu kamu di mana?"). Diambil dari kunjungan bermasalah paling
      // akhir yang koordinatnya terekam.
      let pos = null;
      for (let i = luar.length - 1; i >= 0 && !pos; i--) {
        const la = angka(luar[i].latVisit), lo = angka(luar[i].longVisit);
        if (!titikKosong(la, lo)) pos = { la, lo, tgl: String(luar[i].visitDate || "").slice(0, 5) };
      }
      // "8 dari 10 kunjungan", bukan "8x". Angka sendirian tidak bisa ditanyakan:
      // 8 kali di luar radius dari 8 kunjungan itu cerita yang berbeda jauh
      // dengan 8 dari 30. Kalau sebagian kunjungan pernah IN RADIUS, itu
      // disebut juga — artinya titik tokonya terbukti masih bisa kena, jadi
      // pertanyaannya ke salesman pun berbeda.
      const dalam = rows.length - luar.length;
      // Rasio di atas menghitung kunjungan pada saringan yang dipilih. Riwayat
      // utuh outletnya disebut terpisah kalau memang berbeda — outlet yang baru
      // dioper sering punya riwayat panjang dari salesman sebelumnya, dan itu
      // yang menentukan apakah masalahnya lama atau baru.
      const g = globalOutlet(r.custno);
      const beda = g.n && (g.n !== rows.length || g.sls.size > 1);
      masalah.push(`<b class="berat">Di luar radius</b> `
        + `<span class="rasio">${luar.length} dari ${rows.length} kunjungan</span>`
        + (tgl.length || dalam
            ? `<span class="kecil">${awalan}${escapeHtml(tgl.join(", "))}`
              + (tgl.length && dalam ? " &middot; " : "")
              + (dalam ? `${dalam} kunjungan lain in radius` : "") + `</span>`
            : "")
        // Satu QR saja per outlet, dan yang dipasang adalah yang paling
        // berguna untuk ditanyakan pagi itu. Kalau web ini punya usulan titik
        // toko, itu yang dipasang: salesmannya tinggal scan dan menjawab
        // "benar" atau "salah", dan jawabannya itulah yang menentukan angka
        // mana yang masuk master. Kalau tidak ada usulan, yang dipasang posisi
        // absen terakhir — pertanyaannya jadi "waktu itu kamu di mana".
        // Dua QR berdampingan sengaja tidak dipakai: menghabiskan kertas, dan
        // di kertas tidak ada cara membedakan mana yang barusan discan.
        + (usul
            ? qrSvg(petaPendek(usul.mLat, usul.mLon), "Scan: titik toko yang diusulkan")
              + `<span class="qr-cap">titik usulan</span>`
            : pos
              ? qrSvg(petaPendek(pos.la, pos.lo), "Scan: posisi absen terakhir di peta")
                + `<span class="qr-cap">posisi absen</span>`
              : "")
        + (pos
            ? `<span class="kecil">absen terakhir ${escapeHtml(pos.tgl)}: `
              + `<a href="${petaPin(pos.la, pos.lo)}">${pos.la.toFixed(5)}, ${pos.lo.toFixed(5)}</a>`
              + `</span>`
            // Tanpa koordinat absen tidak ada yang bisa dipetakan, jadi QR pun
            // tidak dibuat. Kalau dibiarkan kosong begitu saja, yang membaca
            // mengira QR-nya rusak — padahal datanya yang tidak ada.
            : `<span class="kecil">koordinat absen tidak ada di file EDI &mdash; `
              + `tidak ada QR/peta untuk outlet ini</span>`)
        // Angka usulannya ditulis juga, bukan cuma QR-nya: kalau salesmannya
        // bilang benar, angka inilah yang disalin ke master.
        + (usul
            ? `<span class="kecil berat">${usul.bucket === "KEMBALI" ? "kembalikan ke" : "usulan titik toko"}: `
              + `<a href="${petaPin(usul.mLat, usul.mLon)}">`
              + `${usul.mLat.toFixed(5)}, ${usul.mLon.toFixed(5)}</a></span>`
            : "")
        + (beda
            ? `<span class="kecil">riwayat outlet: ${g.n} kunjungan`
              + (g.luar ? `, ${g.luar} di luar radius` : "")
              + (g.sls.size > 1 ? ` &middot; ${g.sls.size} salesman` : "") + `</span>`
            : ""));
      if (u && u.bucket === "TANYA")
        tanya.push("Absen tercatat berpencar &mdash; posisi toko sebenarnya di mana?");
      else if (usul) {
        tanya.push(usul.bucket === "KEMBALI"
          ? `<b class="berat">Scan QR</b> &mdash; titik ini dulu benar (terakhir lolos `
            + `${escapeHtml(String(usul.tglLolos || "-"))}). Masih pas letaknya?`
          : `<b class="berat">Scan QR</b> &mdash; titik ini benar letak tokonya?`);
        jawab.push(`<span class="pilihan">&#9744; Benar &nbsp; &#9744; Salah</span>`);
      }
      else if (u && u.bucket === "PAS")
        tanya.push("Titik toko sudah benar &mdash; kenapa absen jauh dari toko?");
      else tanya.push("Kenapa absen jauh dari toko?");
    }

    if (bc && (bc.bucket === "BARU" || bc.bucket === "BELUM")) {
      masalah.push(`<b class="berat">${BARCODE_INFO[bc.bucket].label}</b>`
        + `<span class="kecil">${bc.scan} dari ${bc.n} kunjungan discan`
        + (bc.tglAkhir ? `, terakhir ${escapeHtml(bc.tglAkhir)}` : "")
        + (bc.alasan ? ` &middot; ${escapeHtml(bc.alasan)}`
            : bc.alasanTercatat
              ? ` &middot; ${escapeHtml(bc.alasanTercatat)} (${escapeHtml(bc.alasanTgl)})`
              : ` &middot; tanpa alasan tercatat`)
        + `</span>`
        // Pertanyaan pertama yang selalu muncul waktu menanyakan barcode:
        // sejak kapan. Tanpa tanggalnya, salesman tidak punya pegangan untuk
        // mengingat apa yang terjadi.
        + (bc.mulaiGagal
            ? `<span class="kecil berat">bermasalah sejak ${escapeHtml(bc.mulaiGagal)}`
              + (bc.terakhirBerhasil ? `, terakhir berhasil ${escapeHtml(bc.terakhirBerhasil)}` : "")
              + `</span>`
            : ""));
      // Pertanyaannya HARUS mengikuti keadaannya. Dulu kalimatnya cuma dua:
      // ada alasan atau tidak — sehingga outlet "Baru bermasalah" yang alasannya
      // tidak tercatat ikut ditanya "barcode tidak pernah berhasil discan",
      // padahal di baris sebelahnya tertulis "2 dari 3 kunjungan discan".
      // Dua kalimat yang saling membantah di satu baris membuat seluruh
      // lembarnya tidak bisa dipercaya.
      const sebabBc = bc.alasan || bc.alasanTercatat;
      const sejakBc = bc.mulaiGagal ? ` sejak ${escapeHtml(bc.mulaiGagal)}` : "";
      if (bc.bucket === "BELUM") {
        tanya.push(`Barcode belum pernah berhasil discan${sejakBc}`
          + (sebabBc ? ` &mdash; tercatat ${escapeHtml(sebabBc)}. Sudah dilaporkan?`
                     : ` dan tidak ada alasan tercatat &mdash; kondisinya bagaimana?`));
      } else {
        tanya.push(`Barcode dulu bisa discan, gagal${sejakBc}`
          + (bc.terakhirBerhasil ? ` (terakhir berhasil ${escapeHtml(bc.terakhirBerhasil)})` : "")
          + (sebabBc ? ` &mdash; tercatat ${escapeHtml(sebabBc)}. Sudah dilaporkan?`
                     : ` tanpa alasan tercatat &mdash; kondisinya bagaimana?`));
      }
    }
    return { masalah, tanya, jawab };
  }

  function susunCetak() {
    const wadah = $("cetak");
    if (!wadah) return 0;
    // Dikelompokkan per salesman yang BERKUNJUNG — dialah yang akan ditanya.
    const perSls = new Map();
    const outletRows = new Map();
    for (const r of barisKerja()) {
      let arr = outletRows.get(r.custno);
      if (!arr) { arr = []; outletRows.set(r.custno, arr); }
      arr.push(r);
    }
    for (const [custno, rows] of outletRows) {
      const { masalah, tanya, jawab } = masalahOutlet(rows);
      if (!masalah.length) continue;
      // Lembar ini dikelompokkan menurut PEMILIK OUTLET DI DMP, bukan menurut
      // siapa yang kebetulan berkunjung. Yang dipanggil pagi hari itu salesman
      // yang memegang rayonnya; outlet yang bukan miliknya tidak bisa dia
      // jawab, dan di data uji 270 dari 1.668 outlet tercetak di orang yang
      // salah karena dulu dikelompokkan menurut pengunjung.
      // (Di tabel Detail, kolom Salesman tetap menampilkan yang BERKUNJUNG —
      // di sana pertanyaannya memang "siapa yang absen di sini".)
      const d = state.dmpIndex.get(custno);
      const pemilik = (d && d.salesman) || "";
      const sls = pemilik || rows[0].salesmanEff || "(tanpa nama salesman)";
      // Pengunjung yang bukan pemegang halaman ini — itu sendiri temuan yang
      // pantas ditanyakan, jadi ditulis di barisnya. Yang dikecualikan nama
      // halamannya, bukan nama pemiliknya: tanpa DMP, pemiliknya kosong dan
      // halaman ini dibuat atas nama pengunjung pertama — kalau yang dipakai
      // nama pemilik, orang itu tertulis "dikunjungi" di halamannya sendiri.
      const pengunjung = [...new Set(rows.map((x) => x.salesmanEff).filter(Boolean))]
        .filter((n) => n !== sls);
      // Satu outlet bisa terdaftar di lebih dari satu salesman di DMP. Yang
      // mencetak hanya pemilik utamanya, tapi penugasan lainnya disebut supaya
      // tidak terlihat seperti outlet ini cuma milik satu orang.
      const lain = d && d.alt ? d.alt.map((a) => `${a.s}${a.r ? ` (${a.r})` : ""}`) : [];
      let g = perSls.get(sls);
      if (!g) { g = { rayon: new Set(), baris: [] }; perSls.set(sls, g); }
      const rayon = (d && d.rayon) || rows[0].rayonEff || "";
      if (rayon) g.rayon.add(rayon);
      const adaRadius = !!radiusLayakTanya(rows);
      const bc = state.barcodeByOutlet && state.barcodeByOutlet.get(custno);
      const adaBarcode = !!(bc && (bc.bucket === "BARU" || bc.bucket === "BELUM"));
      if (adaRadius) g.radius = (g.radius || 0) + 1;
      if (adaBarcode) g.barcode = (g.barcode || 0) + 1;
      // Kepemilikan TIDAK ditanyakan lagi. DMP yang diupload adalah master hari
      // ini, jadi "masih milik Anda?" bukan pertanyaan — jawabannya sudah ada di
      // file yang baru saja dibaca, dan pertanyaan yang jawabannya sudah kita
      // punya cuma memakan baris dan membuat lembarnya terasa tidak serius.
      // Yang benar-benar tidak kita punya: cerita di balik outletnya. Itu ada
      // pada orang yang dulu memegangnya.
      const riwayat = riwayatPemilik(custno);
      if (riwayat.sebelum) {
        tanya.push(`Kalau ada kendala di outlet ini, tanya `
          + `<b class="berat">${escapeHtml(riwayat.sebelum.sls)}</b> &mdash; dia yang memegang `
          + `sebelumnya`
          + (punyaCycle(riwayat.sebelum) ? ` (tiap ${riwayat.sebelum.hari} hari)` : "")
          + `, sampai ${escapeHtml(tglTampil(riwayat.sebelum.akhir))}.`);
      }
      // Cycle: yang tertulis di master vs yang benar-benar terjadi. Selisihnya
      // sendiri temuan — bisa salesmannya yang jarang datang, bisa cycle di
      // master yang memang sudah tidak cocok dengan tokonya.
      const tgtCycle = cycleHari(d && d.cycle);
      const cycleTeks = [
        (d && d.cycle) ? `Cycle DMP: ${escapeHtml(d.cycle)}${tgtCycle ? ` (${tgtCycle} hari)` : ""}` : "",
        riwayat.sekarang ? `Anda: ${teksFrek(riwayat.sekarang)}` : "",
      ].filter(Boolean).join(" &middot; ");
      g.baris.push({ custno, nama: rows[0].namaTokoEff, alamat: rows[0].alamatEff,
                     masalah, tanya, jawab, pengunjung, lain, tanpaPemilik: !pemilik,
                     cycleTeks,
                     sebelumTeks: riwayat.sebelum
                       ? `sebelumnya ${escapeHtml(riwayat.sebelum.sls)} &mdash; `
                         + `${teksFrek(riwayat.sebelum)}, s/d `
                         + `${escapeHtml(tglTampil(riwayat.sebelum.akhir))}`
                       : "",
                     // Salesman lain yang mengabsen pada periode yang sama bukan
                     // pertanyaan — pemiliknya sudah jelas di DMP, dan biasanya
                     // itu memang saling cover. Ditulis sebagai keterangan saja;
                     // kalau dijadikan pertanyaan, 288 dari 1.637 baris berisi
                     // pertanyaan yang tidak perlu dijawab siapa pun.
                     bersamaTeks: riwayat.bersama.length
                       ? `juga diabsen `
                         + escapeHtml(riwayat.bersama.map((x) => x.sls).join(", "))
                       : "" });
    }

    const hariIni = new Date().toLocaleDateString("id-ID",
      { weekday: "long", day: "2-digit", month: "long", year: "numeric" });
    const nama = [...perSls.keys()].sort();
    let html = "";
    for (const sls of nama) {
      const g = perSls.get(sls);
      g.baris.sort((a, b) => String(a.custno).localeCompare(String(b.custno)));
      const chip = [];
      if (g.radius) chip.push(`<span class="chip">${g.radius} outlet radius</span>`);
      if (g.barcode) chip.push(`<span class="chip">${g.barcode} outlet barcode</span>`);
      html += `<section class="cetak-sls">`
        + `<header class="cetak-kop">`
        + `<div class="kop-atas"><span class="kop-merek">M3 &mdash; Beverage Mayora</span>`
        + `<span class="kop-tgl">${escapeHtml(hariIni)}</span></div>`
        + `<h2>${escapeHtml(sls)}</h2>`
        + `<div class="kop-bawah"><span class="kop-rayon">Rayon `
        + `${escapeHtml([...g.rayon].join(", ") || "-")}</span>`
        + `<span class="kop-chip">${chip.join("")}`
        + `<span class="chip kuat">${g.baris.length} outlet</span></span></div>`
        + `</header>`
        + `<table><thead><tr><th class="no">#</th><th class="kode">Kode</th>`
        + `<th>Nama Toko</th><th class="kejadian">Yang Terjadi</th><th>Yang Perlu Ditanyakan</th>`
        + `<th class="isian">Jawaban / Tindakan</th><th class="cek">Selesai</th></tr></thead><tbody>`;
      g.baris.forEach((b, i) => {
        html += `<tr><td class="no">${i + 1}</td><td class="kode">${escapeHtml(b.custno)}</td>`
          + `<td><b>${escapeHtml(b.nama || "")}</b>`
          + (b.alamat ? `<span class="kecil">${escapeHtml(b.alamat)}</span>` : "")
          + (b.tanpaPemilik ? `<span class="kecil tanda">tidak ada pemiliknya di DMP</span>` : "")
          + (b.cycleTeks ? `<span class="kecil">${b.cycleTeks}</span>` : "")
          + (b.sebelumTeks ? `<span class="kecil tanda">${b.sebelumTeks}</span>` : "")
          + (b.bersamaTeks ? `<span class="kecil">${b.bersamaTeks}</span>` : "")
          + (b.lain && b.lain.length
              ? `<span class="kecil">juga terdaftar di ${escapeHtml(b.lain.join(", "))}</span>` : "")
          + `</td>`
          + `<td class="kejadian">${b.masalah.join("<br>")}</td>`
          + `<td>${b.tanya.join("<br>")}</td>`
          + `<td class="isian">${b.jawab.join("")}</td>`
          + `<td class="cek">&#9744;</td></tr>`;
      });
      html += `</tbody></table>`
        + `<div class="cetak-ttd">`
        + `<div><div class="garis">Salesman &mdash; ${escapeHtml(sls)}</div></div>`
        + `<div><div class="garis">Diperiksa oleh</div></div>`
        + `<div><div class="garis">Tanggal selesai</div></div></div>`
        + `<p class="cetak-kaki"><b>Scan QR</b> untuk membuka titiknya di Google Maps &mdash; jalan `
        + `juga dari lembar yang dicetak di kertas. Baca dulu keterangan di bawah QR-nya: `
        + `<b>"titik usulan"</b> berarti itu letak toko yang disarankan sistem, dan yang perlu `
        + `dijawab salesman benar atau salah; <b>"posisi absen"</b> berarti itu tempat salesman `
        + `absen waktu itu. Kalau salesmannya bilang titik usulan sudah benar, angka yang tertulis `
        + `di atas QR itulah yang disalin ke master. Koordinatnya juga bisa diklik kalau lembar ini `
        + `dibuka sebagai PDF di komputer. Outlet yang absennya di luar radius `
        + `<b>kurang dari sepertiga kunjungan</b> tidak ikut tercetak &mdash; sesekali meleset `
        + `bukan pola, dan datanya tetap ada di tabel maupun di Excel. `
        + `Daftar outlet di lembar ini diambil dari <b>pemilik outlet menurut DMP</b>, bukan dari `
        + `siapa yang kebetulan berkunjung &mdash; kalau ada outlet yang absennya dilakukan orang `
        + `lain, itu ditulis di bawah nama tokonya.</p>`
        + `</section>`;
    }
    if (!nama.length)
      html = `<p class="cetak-kosong">Tidak ada outlet bermasalah pada penyaring yang dipilih.</p>`;
    wadah.innerHTML = html;
    return nama.length;
  }

  if ($("cetakBtn")) {
    $("cetakBtn").addEventListener("click", () => {
      // Jangan berpatokan pada jumlah baris tabel. Tabel menghitung KUNJUNGAN
      // (siapa yang absen), lembar cetak menghitung OUTLET menurut pemiliknya
      // di DMP — jadi tabel bisa kosong sementara lembar cetaknya ada isinya,
      // misalnya waktu menyaring salesman yang outletnya selalu diabsen orang
      // lain. Dulu tombolnya diam saja di keadaan itu, dan yang lebih buruk,
      // lembar cetak yang lama masih tertinggal di halaman — sekali cetak,
      // yang keluar daftar penyaring sebelumnya.
      const jml = susunCetak();
      const outlet = $("cetak").querySelectorAll("tbody tr").length;
      // Jumlahnya bisa berbeda dengan tabel di atas, dan itu bukan kebetulan:
      // tabel menampilkan KUNJUNGAN (siapa yang absen), lembar cetak
      // menampilkan OUTLET menurut pemiliknya di DMP. Dikatakan supaya
      // selisihnya tidak terbaca sebagai data yang hilang.
      pesanExport(jml
        ? `Lembar cetak disiapkan: <b>${jml} salesman, ${outlet.toLocaleString("id-ID")} outlet</b> `
          + `— satu halaman per salesman. Isinya outlet <b>milik</b> salesman itu menurut DMP, `
          + `jadi jumlahnya bisa berbeda dengan tabel di atas yang menghitung kunjungan. `
          + `Di jendela cetak pilih "Simpan sebagai PDF" kalau ingin filenya, atau langsung cetak.`
        : "Tidak ada outlet bermasalah pada penyaring yang dipilih, jadi tidak ada yang dicetak.");
      // Tanpa saringan, satu area bisa jadi ratusan halaman. Ditanya dulu
      // daripada jendela cetak terbuka dengan tumpukan kertas yang tidak
      // disengaja — apalagi web ini dipakai bergantian banyak orang.
      if (!jml) return;
      const BATAS_HALAMAN = 25;
      if (jml > BATAS_HALAMAN
          && !window.confirm(`Lembar ini akan jadi ${jml} halaman (${outlet.toLocaleString("id-ID")} `
            + `outlet). Saring dulu rayon atau salesmannya kalau tidak sengaja mencetak sebanyak `
            + `itu.\n\nLanjutkan mencetak?`)) {
        pesanExport(`Dibatalkan. Saring dulu rayon atau salesman di atas, lalu tekan `
          + `"Cetak per Salesman" lagi.`);
        return;
      }
      setTimeout(() => window.print(), 60);
    });
  }

  $("exportBtn").addEventListener("click", async () => {
    const btn = $("exportBtn");
    const semula = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Menyiapkan...";
    clearError();
    pesanExport("");
    // Menulis file mengunci layar. Diberi jeda sebentar supaya tulisan
    // "Menyiapkan..." sempat tampil — kalau tidak, tombolnya terlihat seperti
    // tidak bereaksi sama sekali.
    await new Promise((r) => setTimeout(r, 40));
    const tgl = new Date().toISOString().slice(0, 10);
    try {
      // Sheet Hasil memuat SELURUH kunjungan ke outlet yang sedang dipilih,
      // bukan cuma yang lolos penyaring jenis masalah di layar. Outlet yang
      // keadaannya baik harus ikut: tanpa itu, isi Excel tidak bisa
      // dipertemukan dengan lembar cetak maupun sheet Semua Outlet, dan
      // pemakainya tidak punya cara tahu bagian mana yang terpotong.
      // Kategori tetap ada sebagai kolom, jadi penyaringannya dilakukan di
      // Excel — di situ memang tempatnya.
      const rowsHasil = kunjunganTerpilih().slice().sort((a, b) => {
        const c = String(a.custno).localeCompare(String(b.custno));
        if (c) return c;
        return String(a.visitDate || "").localeCompare(String(b.visitDate || ""));
      });
      if (!rowsHasil.length) {
        pesanExport("Tidak ada kunjungan pada saringan yang dipilih, jadi tidak ada yang diexport.");
        return;
      }
      const aoa = [KEPALA_HASIL];
      for (const r of rowsHasil) aoa.push(barisHasil(r));

      if (rowsHasil.length > BATAS_XLSX) {
        // ﻿ (BOM) supaya huruf beraksen dan tanda "—" tidak berantakan di Excel.
        await unduh(`hasil-validasi-${tgl}.csv`, ["﻿", keCsv(aoa)], "text/csv;charset=utf-8");
        const us = state.titikByOutlet ? [...state.titikByOutlet.values()]
          .filter((u) => u.bucket === "USUL").length : 0;
        pesanExport(`${rowsHasil.length.toLocaleString("id-ID")} baris terlalu banyak untuk `
          + `satu file Excel, jadi disimpan sebagai CSV — tinggal dibuka dengan Excel seperti biasa.`
          + (us ? ` Untuk daftar usulan titik, pilih dulu "Titik toko perlu diperbaiki" `
                  + `di filter sebelah, lalu Export lagi.` : ""));
      } else {
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), "Hasil");
        const usulan = daftarUsulan();
        if (usulan.length)
          XLSX.utils.book_append_sheet(wb, sheetUsulan(usulan), "Usulan Titik");
        const barcode = daftarBarcode();
        if (barcode.length)
          XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(barcode), "Barcode Perlu Dicek");
        const semua = daftarSemuaOutlet();
        if (semua.length)
          XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(semua), "Semua Outlet (DMP)");
        const rangking = daftarRangking();
        if (rangking.length)
          XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(sheetRangking(rangking)),
            "Rangking Salesman");
        // Lewat unduh(), bukan XLSX.writeFile: writeFile membuat tautan
        // unduhannya sendiri, dan tautan itu mati di dalam artifact.
        const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" });
        await unduh(`hasil-validasi-${tgl}.xlsx`, [buf],
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        const isi = [`Hasil ${rowsHasil.length.toLocaleString("id-ID")} baris`];
        if (usulan.length) isi.push(`Usulan Titik ${usulan.length.toLocaleString("id-ID")} outlet`);
        if (barcode.length) isi.push(`Barcode Perlu Dicek ${barcode.length.toLocaleString("id-ID")} outlet`);
        if (semua.length) isi.push(`Semua Outlet (DMP) ${semua.length.toLocaleString("id-ID")} outlet`);
        if (rangking.length) isi.push(`Rangking Salesman ${rangking.length.toLocaleString("id-ID")} orang`);
        const belum = semua.filter((x) => x.Status === "Belum pernah dikunjungi").length;
        pesanExport(`File berisi: ${isi.join(" &middot; ")}. Semua sheet memakai kumpulan toko `
          + `yang sama — outlet milik salesman/rayon yang dipilih menurut DMP. Sheet <b>Hasil</b> `
          + `memuat <b>seluruh kunjungan</b> ke outlet itu, yang bermasalah maupun yang benar, `
          + `jadi angkanya bisa lebih banyak daripada baris tabel di layar: dropdown jenis masalah `
          + `dan centang "Hanya yang ada di HHT" sengaja tidak ikut memotong isi file. Saring di `
          + `Excel lewat kolom Kategori atau Masalah Outlet.`
          + (semua.length
              ? ` Sheet <b>"Semua Outlet (DMP)"</b> berisi seluruh outlet aktif milik salesman/rayon `
                + `yang dipilih — bermasalah maupun tidak, termasuk `
                + `<b>${belum.toLocaleString("id-ID")} outlet yang belum pernah dikunjungi</b> `
                + `dan karena itu tidak muncul di sheet Hasil.`
              : ` Sheet "Semua Outlet (DMP)" hanya dibuat kalau salesman atau rayonnya disaring `
                + `dulu — tanpa saringan, isinya seluruh outlet aktif di DMP.`));
      }
    } catch (err) {
      console.error(err);
      // Tanpa ini, kegagalan export tidak meninggalkan jejak apa pun di layar —
      // dari sisi pengguna tombolnya "tidak bisa" tanpa sebab.
      showError(new Error(`File gagal dibuat: ${(err && err.message) || err}. `
        + `Saring dulu datanya — per salesman, per `
        + `rayon, atau per periode — lalu export lagi.`));
    } finally {
      btn.disabled = false;
      btn.textContent = semula;
    }
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

  // ================= Usulan Perbaikan Titik Outlet =================
  // Flag 0 artinya kunjungan di luar radius. Penyebabnya ada dua: salesman
  // memang tidak di toko, ATAU titik validasi toko di master yang salah.
  // Kalau kunjungan berkali-kali jatuh di tempat yang sama tapi jauh dari titik
  // master, yang patut dicurigai adalah titik masternya. Bagian ini menyusun
  // usulan titik pengganti dari sebaran kunjungan itu sendiri.
  //
  // Batas yang tidak boleh dilupakan: kunjungan yang mengumpul rapat
  // membuktikan KONSISTENSI, bukan KEBENARAN. Salesman yang selalu absen dari
  // warung yang sama akan terlihat persis sama seperti ini. Karena itu hasilnya
  // usulan untuk diperiksa orang, bukan koreksi otomatis.

  const RADIUS_DEFAULT = 50;

  // Berapa bagian kunjungan bermasalah yang harus mengumpul sebelum titiknya
  // layak diusulkan. Dulu 60% (mayoritas). Diturunkan supaya outlet yang
  // sebagian kunjungannya konsisten di satu tempat tetap dapat usulan —
  // keyakinannya yang dibedakan, bukan usulannya yang dibuang.
  const AMBANG_RAPAT = 0.33;

  const TITIK_YAKIN = {
    Tinggi: "Semua kunjungan jatuh di titik usulan, dan dikuatkan banyak hari atau lebih dari satu salesman. Paling layak langsung diperbaiki.",
    Sedang: "Semua kunjungan jatuh di titik usulan, tapi buktinya masih sedikit. Cek dulu alamatnya.",
    Rendah: "Sebagian besar kunjungan jatuh di titik usulan, sebagian menyimpang. Periksa lebih teliti.",
  };

  function angka(v) {
    const n = Number(String(v ?? "").trim().replace(",", "."));
    return Number.isFinite(n) ? n : null;
  }

  // Titik (0,0) di data berarti outlet belum di-tag, bukan lokasi di laut Afrika.
  const titikKosong = (la, lo) =>
    la === null || lo === null || (Math.abs(la) < 0.001 && Math.abs(lo) < 0.001);

  // Jarak dua titik di bumi, dalam meter.
  function meter(lat1, lon1, lat2, lon2) {
    const R = 6371000, rad = Math.PI / 180;
    const dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
    const h = Math.sin(dLat / 2) ** 2
      + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  // Titik usulan pakai MEDIAN, bukan rata-rata. Tiga kunjungan rapat ditambah
  // satu kunjungan nyasar 5 km: rata-ratanya meleset jauh, mediannya tidak.
  function median(arr) {
    const v = arr.slice().sort((a, b) => a - b);
    const m = v.length >> 1;
    return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
  }

  // Jarak dalam meter jadi sulit dibaca begitu lewat seribu ("5.767 m" mudah
  // disangka 5,7 m). Di atas 1 km ditulis kilometer.
  // Tanggal ditulis seperti kebiasaan setempat: 24/08/2026, bukan 2026-08-24.
  // Ditulis sebagai deklarasi fungsi supaya bisa dipakai di mana saja, tidak
  // tergantung urutan baris di berkas ini.
  function tglTampil(iso) {
    const m = String(iso || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return m ? `${m[3]}/${m[2]}/${m[1]}` : String(iso || "");
  }

  function jarakTeks(m) {
    if (m === null || m === undefined) return "—";
    return m >= 1000
      ? `${(m / 1000).toFixed(1).replace(".", ",")} km`
      : `${Math.round(m).toLocaleString("id-ID")} m`;
  }

  // Dua cara melihat satu titik. Pin peta selalu ada; Street View menampilkan
  // muka tokonya, tapi hanya kalau jalannya pernah difoto — kalau tidak,
  // Google jatuh kembali ke peta biasa.
  const petaPin = (la, lo) =>
    `https://www.google.com/maps/search/?api=1&query=${la.toFixed(6)},${lo.toFixed(6)}`;
  const petaToko = (la, lo) =>
    `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${la.toFixed(6)},${lo.toFixed(6)}`;

  // Versi pendek khusus QR. Isi QR yang lebih pendek berarti kotaknya lebih
  // sedikit, dan tiap kotak jadi lebih besar di kertas — itu yang menentukan
  // masih kebaca atau tidak oleh kamera HP. Tujuannya sama persis dengan
  // petaPin, cuma bentuk alamatnya yang lebih ringkas.
  const petaPendek = (la, lo) =>
    `https://maps.google.com/?q=${la.toFixed(5)},${lo.toFixed(5)}`;

  // QR berisi tautan posisi absen, untuk lembar yang benar-benar dicetak.
  // Di kertas tautan jelas tidak bisa diklik, dan PDF yang dibuat dari HP
  // biasanya membuang tautannya — QR tetap jalan di keduanya.
  // Tingkat koreksi dipasang "L" (7%), bukan "M" (15%). Dengan isi sepanjang ini
  // "M" menuntut 33 x 33 kotak sedangkan "L" cukup 29 x 29 — pada kotak QR yang
  // sama besarnya di kertas, tiap kotaknya jadi 12% lebih besar. Untuk lembar
  // yang dicetak bersih dari printer kantor, ukuran kotak itulah penentu masih
  // terbaca atau tidak oleh kamera HP, jauh lebih menentukan daripada cadangan
  // koreksi yang sebenarnya untuk QR yang sobek atau kotor.
  // Ukuran versinya dibiarkan menyesuaikan isi (argumen 0). Ruang putih di
  // sekelilingnya diatur lewat CSS, bukan margin di dalam SVG, supaya kotaknya
  // sendiri tetap sebesar mungkin di ruang yang ada.
  function qrSvg(url, judul) {
    if (typeof qrcode !== "function") return "";
    try {
      const q = qrcode(0, "L");
      q.addData(url);
      q.make();
      return `<span class="qr"${judul ? ` title="${escapeHtml(judul)}"` : ""}>`
        + q.createSvgTag({ cellSize: 1, margin: 0, scalable: true }) + `</span>`;
    } catch (e) {
      return "";
    }
  }

  // Koordinatnya sendiri jadi tautan ke peta, ditambah satu tautan Street View
  // di sebelahnya. Tidak perlu tulisan "buka peta" lagi — koordinat bergaris
  // bawah sudah cukup jelas, dan barisnya jadi lebih pendek.
  function petaLink(la, lo, teks) {
    return `<a class="maplink" href="${petaPin(la, lo)}" target="_blank" rel="noopener"`
      + ` title="Buka titik ini di Google Maps">${teks}</a>`
      + ` &middot; <a class="maplink" href="${petaToko(la, lo)}" target="_blank" rel="noopener"`
      + ` title="Street View — lihat muka tokonya, kalau jalannya pernah difoto">lihat toko</a>`;
  }

  // Membuka peta tidak diserahkan begitu saja ke browser.
  // Versi claude.ai berjalan di dalam iframe ber-sandbox. Kalau izin
  // "allow-popups" tidak diberikan di situ, tautan target="_blank" MATI TANPA
  // PESAN APA PUN — tidak ada tab baru, tidak ada error, tidak ada apa-apa.
  // Dari sisi pemakai persis seperti koordinatnya tidak bisa diklik.
  // Jadi kliknya ditangani sendiri: dicoba dibuka, dan kalau browser menolak,
  // alamatnya disalin ke papan klip supaya masih bisa ditempel sendiri —
  // lengkap dengan pemberitahuan, supaya kegagalannya tidak diam-diam.
  function pesanTautan(teks, nada) {
    let el = $("tautanPesan");
    if (!el) {
      el = document.createElement("div");
      el.id = "tautanPesan";
      el.className = "toast";
      document.body.appendChild(el);
    }
    el.className = "toast" + (nada ? " " + nada : "");
    el.textContent = teks;
    el.classList.add("tampil");
    clearTimeout(pesanTautan._t);
    pesanTautan._t = setTimeout(() => el.classList.remove("tampil"), 6000);
  }

  function salinTeks(teks) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(teks).then(() => true, () => salinKuno(teks));
    }
    return Promise.resolve(salinKuno(teks));
  }

  // Cara lama, untuk browser atau konteks yang menolak navigator.clipboard.
  function salinKuno(teks) {
    try {
      const t = document.createElement("textarea");
      t.value = teks;
      t.setAttribute("readonly", "");
      t.style.cssText = "position:fixed;top:-1000px;opacity:0";
      document.body.appendChild(t);
      t.select();
      const ok = document.execCommand("copy");
      t.remove();
      return ok;
    } catch (e) {
      return false;
    }
  }

  function bukaPeta(url) {
    let w = null;
    try {
      // "noopener" JANGAN ditaruh di argumen ketiga: menurut spesifikasi,
      // window.open dengan noopener selalu mengembalikan null — jadi tab-nya
      // terbuka tapi kodenya menyangka gagal, lalu memunculkan pemberitahuan
      // yang keliru. Hubungan ke halaman asal diputus setelahnya saja.
      w = window.open(url, "_blank");
      if (w) { try { w.opener = null; } catch (e2) { /* lintas-asal, biarkan */ } }
    } catch (e) {
      w = null;
    }
    if (w) return;
    // Ditolak. Jangan diam — beri tahu, dan berikan alamatnya.
    salinTeks(url).then((ok) => {
      pesanTautan(ok
        ? "Browser menolak membuka tab baru. Alamat petanya sudah disalin — tinggal tempel (Ctrl+V) di tab browser."
        : `Browser menolak membuka tab baru. Salin alamat ini: ${url}`, "warn");
    });
  }

  document.addEventListener("click", (e) => {
    const a = e.target && e.target.closest && e.target.closest("a.maplink");
    if (!a || !a.href) return;
    e.preventDefault();
    bukaPeta(a.href);
  });

  // Rentang tanggal yang sedang dipakai menilai titik. Kunjungan lama sering
  // bermasalah karena titik masternya memang belum diperbaiki waktu itu —
  // kalau ikut dihitung, outlet yang sekarang sudah benar tetap terlihat
  // bermasalah.
  function rentangTanggal() {
    const d = $("tglDari"), sm = $("tglSampai");
    return { dari: d && d.value ? d.value : "", sampai: sm && sm.value ? sm.value : "" };
  }

  function dalamRentang(r, rg) {
    if (!rg.dari && !rg.sampai) return true;
    if (!r.tglIso) return true;          // tanggal tidak terbaca: jangan dibuang
    if (rg.dari && r.tglIso < rg.dari) return false;
    if (rg.sampai && r.tglIso > rg.sampai) return false;
    return true;
  }

  // Mencari koordinat master yang DULU terbukti benar tapi sudah diganti.
  // Bukti terkuat yang ada di data: koordinat yang waktu itu menghasilkan
  // FLAG 1 — bukan tebakan dari sebaran kunjungan, tapi angka yang sistem
  // sendiri sudah nyatakan lolos.
  // Koordinat master yang TERAKHIR dipakai di outlet ini. Diambil menurut
  // tanggal, bukan urutan baris — baris pertama di file belum tentu yang
  // paling awal.
  function titikAkhir(semua) {
    const urut = semua.slice().sort((a, b) =>
      String(a.r.tglIso || "").localeCompare(String(b.r.tglIso || "")));
    for (let i = urut.length - 1; i >= 0; i--) {
      const a = angka(urut[i].r.latVal), b = angka(urut[i].r.longVal);
      if (!titikKosong(a, b)) return { la: a, lo: b, tgl: urut[i].r.tglIso || "" };
    }
    return null;
  }

  function titikTerbukti(semua, set) {
    // Kunjungan diurutkan menurut tanggal supaya "titik sekarang" benar-benar
    // yang terakhir dipakai, bukan yang kebetulan ada di baris pertama.
    const urut = semua.slice().sort((a, b) =>
      String(a.r.tglIso || "").localeCompare(String(b.r.tglIso || "")));
    const kini = titikAkhir(semua);
    if (!kini) return null;
    const curLa = kini.la, curLo = kini.lo;

    // Koordinat terakhir yang pernah menghasilkan flag 1.
    let la = null, lo = null, tgl = "";
    for (let i = urut.length - 1; i >= 0; i--) {
      const v = urut[i];
      if (v.r.flagRadius !== "1") continue;
      const a = angka(v.r.latVal), b = angka(v.r.longVal);
      if (titikKosong(a, b)) continue;
      la = a; lo = b; tgl = v.r.tglIso || "";
      break;
    }
    if (la === null) return null;

    const geser = Math.round(meter(la, lo, curLa, curLo));
    // Kalau titiknya praktis tidak berubah, tidak ada yang perlu dikembalikan.
    if (geser <= set) return null;

    // Berapa kunjungan bermasalah yang akan lolos kalau titik lama dipakai lagi.
    let bisaLolos = 0;
    for (const v of urut)
      if (v.r.flagRadius !== "1" && meter(v.la, v.lo, la, lo) <= set) bisaLolos++;
    if (!bisaLolos) return null;   // mengembalikan titik lama tidak menolong apa-apa

    return { la, lo, curLa, curLo, geser, tgl, bisaLolos };
  }

  // Kelompok kunjungan yang paling padat: titik yang punya tetangga terbanyak
  // di dalam radius, beserta tetangganya.
  //
  // Ini menggantikan "median dari semua kunjungan". Median semua kunjungan
  // aman selama mayoritasnya mengumpul, tapi begitu ambangnya diturunkan ke
  // sepertiga, mediannya bisa jatuh persis di antara dua kelompok — di tempat
  // yang tidak pernah dikunjungi siapa pun. Pada data uji ada 32 outlet yang
  // mediannya nyasar seperti itu; dengan cara ini, nol.
  function kelompokTerpadat(vs, radius) {
    let terbaik = null, isiTerbaik = -1;
    for (const p of vs) {
      const isi = vs.filter((q) => meter(p.la, p.lo, q.la, q.lo) <= radius);
      if (isi.length > isiTerbaik) { isiTerbaik = isi.length; terbaik = isi; }
    }
    return terbaik && terbaik.length ? terbaik : vs;
  }

  // ================= Riwayat scan barcode per outlet =================
  // Satu baris di tabel adalah satu kunjungan, tapi pertanyaan "barcodenya
  // bermasalah atau tidak" hanya bisa dijawab dengan melihat seluruh riwayat
  // outlet itu. Salesman datang seminggu atau dua minggu sekali: minggu lalu
  // bisa saja gagal karena barcode belum aktif, minggu ini sudah berhasil.
  // Yang menentukan adalah KUNJUNGAN TERAKHIR — sisanya cerita latar.
  const BARCODE_INFO = {
    LANCAR: { label: "Barcode lancar", tone: "ok",
      hint: "Kunjungan terakhir barcodenya berhasil discan. Tidak ada yang perlu dikerjakan." },
    BERES: { label: "Sudah beres", tone: "info",
      hint: "Dulu pernah gagal discan, tapi kunjungan terakhir sudah berhasil — barcodenya sudah aktif atau sudah diganti. Tidak perlu ditindaklanjuti lagi." },
    BARU: { label: "Baru bermasalah", tone: "warn",
      hint: "Dulu barcodenya bisa discan, tapi kunjungan terakhir gagal. Kemungkinan barcodenya baru rusak, hilang, atau tertutup barang." },
    BELUM: { label: "Belum pernah discan", tone: "bad",
      hint: "Tidak sekali pun berhasil discan sejak periode ini. Barcodenya perlu dipasang, diganti, atau diaktifkan." },
  };

  // ================= Riwayat global per outlet =================
  // Semua angka "dasar" — dasar usulan titik dan riwayat scan barcode —
  // dihitung dari SELURUH kunjungan ke outlet itu, tanpa memandang siapa yang
  // mengerjakannya. Outlet berpindah tangan: kunjungan yang dicover salesman
  // sebelumnya sama sahnya sebagai bukti dengan kunjungan salesman sekarang,
  // dan membuangnya berarti membuang separuh riwayat outlet yang baru saja
  // dioper. Karena itu peta ini sengaja tidak mengenal satu pun penyaring di
  // layar, termasuk rentang tanggal.
  function hitungGlobal() {
    const per = new Map();
    for (const r of state.results || []) {
      let v = per.get(r.custno);
      if (!v) {
        v = { n: 0, luar: 0, dalam: 0, sls: new Set(), tglAwal: "", tglAkhir: "" };
        per.set(r.custno, v);
      }
      v.n++;
      if (r.flagRadius === "1") v.dalam++; else v.luar++;
      if (r.salesmanEff) v.sls.add(r.salesmanEff);
      const t = r.tglIso || "";
      if (t) {
        if (!v.tglAwal || t < v.tglAwal) v.tglAwal = t;
        if (!v.tglAkhir || t > v.tglAkhir) v.tglAkhir = t;
      }
    }
    // Nama salesman di HHT sengaja TIDAK dicampur ke sini. Bentuk penulisannya
    // berbeda dengan EDI — di data uji tidak ada satu pun dari 151 nama yang
    // sama persis — jadi mencampurnya membuat satu orang terhitung dua kali.
    // Yang dijawab kolom ini "siapa saja yang pernah absen di outlet ini",
    // dan itu pertanyaan tentang EDI.
    state.globalByOutlet = per;
  }

  // Berapa hari sekali outlet ini benar-benar dikunjungi, dihitung dari jarak
  // rata-rata antar tanggal kunjungan. Butuh minimal dua tanggal berbeda —
  // satu kunjungan tidak punya jarak.
  // Dibandingkan dengan cycle di master: "Weekly" 7 hari, "Be Weekly" 14 hari,
  // "Monthly" 30 hari. Yang dilaporkan selisihnya, bukan vonis: cycle di master
  // pun bisa salah, dan itu sendiri temuan.
  const CYCLE_HARI = { WEEKLY: 7, BEWEEKLY: 14, MONTHLY: 30 };

  function cycleHari(teks) {
    const k = String(teks || "").toUpperCase().replace(/[^A-Z]/g, "");
    for (const [nama, hari] of Object.entries(CYCLE_HARI)) if (k.startsWith(nama)) return hari;
    return null;
  }

  function hitungFrekuensi() {
    const per = new Map();
    for (const r of state.results || []) {
      const t = r.tglIso;
      if (!t) continue;
      let v = per.get(r.custno);
      if (!v) { v = new Set(); per.set(r.custno, v); }
      v.add(t);
    }
    const info = new Map();
    for (const [custno, set] of per) {
      const tgl = [...set].sort();
      if (tgl.length < 2) { info.set(custno, { hari: null, n: tgl.length }); continue; }
      const awal = Date.parse(tgl[0]), akhir = Date.parse(tgl[tgl.length - 1]);
      const rentang = Math.round((akhir - awal) / 86400000);
      info.set(custno, { hari: Math.round(rentang / (tgl.length - 1)), n: tgl.length,
                         awal: tgl[0], akhir: tgl[tgl.length - 1] });
    }
    state.frekByOutlet = info;
  }

  const frekOutlet = (custno) =>
    (state.frekByOutlet && state.frekByOutlet.get(custno)) || { hari: null, n: 0 };

  // Frekuensi yang sama, tapi DIPECAH PER SALESMAN. Outlet berpindah tangan,
  // dan angka gabungan menyembunyikan justru yang perlu dilihat: outlet yang
  // dulu didatangi tiap minggu lalu jadi tiap tiga minggu sejak dioper terbaca
  // "tiap 12 hari" kalau dua riwayatnya dirata-rata jadi satu.
  function hitungFrekuensiSls() {
    const per = new Map();               // custno -> Map(salesman -> Set(tanggal))
    for (const r of state.results || []) {
      const t = r.tglIso;
      const sls = r.salesmanEff;
      if (!t || !sls) continue;
      let m = per.get(r.custno);
      if (!m) { m = new Map(); per.set(r.custno, m); }
      let set = m.get(sls);
      if (!set) { set = new Set(); m.set(sls, set); }
      set.add(t);
    }
    const info = new Map();
    for (const [custno, m] of per) {
      const daftar = [];
      for (const [sls, set] of m) {
        const tgl = [...set].sort();
        const akhir = tgl[tgl.length - 1];
        daftar.push({
          sls, n: tgl.length, awal: tgl[0], akhir,
          hari: tgl.length >= 2
            ? Math.round((Date.parse(akhir) - Date.parse(tgl[0])) / 86400000 / (tgl.length - 1))
            : null,
        });
      }
      daftar.sort((a, b) => String(a.akhir).localeCompare(String(b.akhir)));
      info.set(custno, daftar);
    }
    state.frekSlsByOutlet = info;
  }

  // Siapa yang memegang outlet ini sekarang, siapa sebelumnya, dan siapa yang
  // mengerjakannya bersamaan. Yang menentukan "sekarang" tetap DMP — itu master
  // yang diupload hari ini, jadi kepemilikannya tidak perlu ditanya lagi. Yang
  // masih berguna ditanyakan: kalau ada kendala di outlet ini, siapa yang tahu
  // ceritanya.
  function riwayatPemilik(custno) {
    const daftar = (state.frekSlsByOutlet && state.frekSlsByOutlet.get(custno)) || [];
    const d = state.dmpIndex && state.dmpIndex.get(custno);
    let pemilik = (d && d.salesman) || "";
    let sekarang = pemilik ? daftar.find((x) => x.sls === pemilik) || null : null;
    // Tanpa pemilik di DMP, yang paling akhir berkunjung dianggap yang sekarang
    // — itu satu-satunya keterangan yang tersedia, dan lebih baik daripada
    // menyebut semua orang "sebelumnya".
    if (!pemilik && daftar.length) { sekarang = daftar[daftar.length - 1]; pemilik = sekarang.sls; }
    const lain = daftar.filter((x) => x.sls !== pemilik);
    // "Sebelumnya" ditentukan tanggal, bukan tebakan: kunjungan terakhirnya
    // berhenti sebelum pemilik sekarang mulai. Yang masih beririsan waktunya
    // bukan salesman lama — itu dua orang yang mengerjakan outlet yang sama.
    const batas = sekarang ? sekarang.awal : "";
    const sebelum = lain.filter((x) => batas && x.akhir < batas);
    const bersama = lain.filter((x) => !batas || x.akhir >= batas);
    return { pemilik, sekarang, sebelum: sebelum.length ? sebelum[sebelum.length - 1] : null,
             semuaSebelum: sebelum, bersama };
  }

  // Umur outlet dalam hari, dihitung sampai hari ini. Dipakai untuk memisahkan
  // "outlet ini terlewat" dari "outlet ini memang baru dibuat".
  function umurHari(iso) {
    if (!iso) return "";
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return "";
    return Math.max(0, Math.round((Date.now() - t) / 86400000));
  }

  // Tanggal kunjungan paling awal yang ada di data. Outlet yang dibuat setelah
  // tanggal ini belum ada sepanjang periode yang sedang dilihat, jadi wajar
  // kalau riwayatnya kosong — dan itu beda jauh artinya dengan outlet lama yang
  // tidak pernah didatangi.
  function tglDataMulai() {
    if (state.tglDataMulai !== undefined) return state.tglDataMulai;
    const semua = (state.results || []).map((r) => r.tglIso).filter(Boolean).sort();
    state.tglDataMulai = semua[0] || "";
    return state.tglDataMulai;
  }

  // Tiga kolom yang menjawab "cycle-nya berubah tidak sejak dioper": berapa
  // hari sekali outlet ini didatangi pemiliknya sekarang, berapa hari sekali
  // dulu, dan siapa yang dulu itu. Bentuknya disamakan supaya ketiga sheet dan
  // lembar cetak menyebut hal yang sama dengan kata yang sama.
  function kolomCycleSls(custno) {
    const r = riwayatPemilik(custno);
    return {
      "Salesman Sebelumnya": r.sebelum ? r.sebelum.sls : "",
      "Kunjungan Tiap (hari) — Sekarang": r.sekarang && r.sekarang.hari !== null
        ? r.sekarang.hari : "",
      "Kunjungan Tiap (hari) — Sebelumnya": r.sebelum && r.sebelum.hari !== null
        ? r.sebelum.hari : "",
      "Kunjungan Terakhir Sebelumnya": r.sebelum ? tglTampil(r.sebelum.akhir) : "",
    };
  }

  // "tiap 7 hari (5 kunjungan)" — dipakai di lembar cetak maupun di layar.
  // Satu kunjungan tidak punya jarak, jadi cycle-nya memang belum ada. Ditulis
  // apa adanya, bukan "tiap 0 hari": angka yang dikarang lebih berbahaya
  // daripada keterangan bahwa datanya belum cukup.
  const punyaCycle = (x) => !!x && x.hari !== null && x.hari !== undefined;
  const teksFrek = (x) => !x ? ""
    : punyaCycle(x) ? `tiap ${x.hari} hari (${x.n} kunjungan)`
    : `${x.n} kunjungan, cycle belum terhitung`;

  // ---- Nama cabang ----
  // Yang dipakai sebagai identitas tetap KODEBRANCH: itu yang menempel di tiap
  // outlet dan tidak berubah. Yang ditampilkan namanya, karena "CNS JAKUTPUS"
  // bisa dibaca orang sedangkan "B120" harus dihafal dulu. Kalau kodenya tidak
  // punya nama di DMP, kodenya sendiri yang dipakai — lebih baik daripada sel
  // kosong.
  function namaBranch(kode) {
    const set = state.branchNama && state.branchNama.get(kode);
    return set && set.size ? [...set].sort().join(" / ") : String(kode || "");
  }


  // Untuk dropdown: namanya saja. Kodenya tidak ikut ditulis — yang dicari mata
  // waktu memilih cabang memang namanya, dan "(B120)" di belakangnya cuma
  // mengembalikan hal yang tadi mau dihindari.
  //
  // Satu perkecualian: kalau dua KODEBRANCH ternyata bernama sama, namanya saja
  // tidak cukup untuk membedakan — dua baris yang bunyinya persis sama di
  // dropdown tidak bisa dipilih dengan yakin. Hanya pada kasus itu kodenya
  // ditempelkan. Di data satu cabang hal ini tidak pernah terjadi.
  function branchKembar(nama) {
    if (!(state.branchNama instanceof Map)) return false;
    let n = 0;
    for (const kode of state.branchNama.keys()) if (namaBranch(kode) === nama) n++;
    return n > 1;
  }

  // Outlet yang tidak ada di DMP tidak punya branch. Kalau dibiarkan tanpa
  // pilihan sendiri, ia hilang begitu branch mana pun dipilih — dan memilih
  // semua branch satu per satu tidak pernah menjumlah kembali ke totalnya.
  // Hilang diam-diam itu yang paling susah dilacak, jadi diberi barisnya sendiri.
  const TANPA_BRANCH = "(tanpa branch di DMP)";

  function labelBranch(kode) {
    if (!kode) return TANPA_BRANCH;
    const nama = namaBranch(kode);
    if (nama === String(kode)) return nama;
    return branchKembar(nama) ? `${nama} (${kode})` : nama;
  }

  // Dipakai di beberapa tempat, jadi bentuknya disamakan sekali di sini.
  const globalOutlet = (custno) =>
    (state.globalByOutlet && state.globalByOutlet.get(custno))
    || { n: 0, luar: 0, dalam: 0, sls: new Set(), tglAwal: "", tglAkhir: "" };

  function hitungBarcode() {
    const per = new Map();
    for (const h of state.hhtRows || []) {
      const c = String(h.custno || "").trim();
      if (!c) continue;
      let v = per.get(c);
      if (!v) { v = []; per.set(c, v); }
      v.push({
        iso: tglIso(h.tanggal) || "",
        tgl: String(h.tanggal || "").trim(),
        scan: isScanned(h),
        alasan: String(h.alasan || "").trim(),
      });
    }

    const info = new Map();
    const jml = { LANCAR: 0, BERES: 0, BARU: 0, BELUM: 0 };
    for (const [custno, vs] of per) {
      vs.sort((a, b) => String(a.iso).localeCompare(String(b.iso)));
      // Kunjungan terakhir dinilai PER HARI, bukan per baris. Satu outlet bisa
      // punya beberapa baris di tanggal yang sama — dua salesman, atau satu
      // salesman yang mengulang. Kalau yang dipakai cuma baris paling bawah,
      // barcode yang sebenarnya berhasil discan hari itu bisa terbaca gagal
      // hanya karena baris yang gagal kebetulan tercatat belakangan. Berhasil
      // sekali pada hari itu berarti barcodenya bisa discan.
      // Diringkas per HARI dulu. Satu tanggal bisa punya beberapa baris (dua
      // salesman, atau satu salesman yang mengulang); yang menentukan apakah
      // hari itu barcodenya berhasil discan, bukan baris mana yang tercatat
      // belakangan.
      const hari = [];
      for (const v of vs) {
        const t = hari.length ? hari[hari.length - 1] : null;
        if (t && t.iso === v.iso) {
          t.scan = t.scan || v.scan;
          if (!t.alasan && !v.scan && v.alasan && v.alasan !== "-") t.alasan = v.alasan;
        } else {
          hari.push({ iso: v.iso, tgl: v.tgl, scan: v.scan,
                      alasan: !v.scan && v.alasan && v.alasan !== "-" ? v.alasan : "" });
        }
      }
      const akhir = hari[hari.length - 1];
      const scanAkhir = akhir.scan;
      const pernahScan = hari.some((v) => v.scan);
      const pernahGagal = hari.some((v) => !v.scan);
      let bucket;
      if (scanAkhir) bucket = pernahGagal ? "BERES" : "LANCAR";
      else bucket = pernahScan ? "BARU" : "BELUM";

      // "Baru bermasalah" tidak bisa ditindaklanjuti tanpa tahu SEJAK KAPAN.
      // Yang dicari hari pertama gagal pada rentetan gagal yang sekarang —
      // yaitu tepat sesudah kunjungan berhasil yang terakhir.
      let mulaiGagal = "", terakhirBerhasil = "", alasanTercatat = "", alasanTgl = "";
      if (!scanAkhir) {
        let i = hari.length - 1;
        while (i >= 0 && !hari[i].scan) i--;
        terakhirBerhasil = i >= 0 ? hari[i].tgl : "";
        mulaiGagal = hari[i + 1] ? hari[i + 1].tgl : "";
        // Alasan paling akhir yang benar-benar tercatat di rentetan gagal ini.
        // Kolom "Alasan Terakhir" sering kosong karena kunjungan terakhirnya
        // memang tidak mencatat alasan — bukan berarti tidak ada alasan sama
        // sekali. Tanggalnya ikut ditulis supaya tidak disangka alasan hari itu.
        for (let j = hari.length - 1; j > i; j--) {
          if (hari[j].alasan) { alasanTercatat = hari[j].alasan; alasanTgl = hari[j].tgl; break; }
        }
      }

      info.set(custno, {
        bucket, n: vs.length,
        scan: vs.filter((v) => v.scan).length,
        hari: hari.length,
        tglAkhir: akhir.tgl,
        mulaiGagal, terakhirBerhasil, alasanTercatat, alasanTgl,
        alasan: scanAkhir ? "" : (akhir.alasan || ""),
      });
      jml[bucket]++;
    }
    state.barcodeByOutlet = info;
    state.barcodeStats = jml;
    labelBarcodeFilter();
  }

  // Menghitung outlet per kelompok DI DALAM pilihan yang sedang aktif —
  // salesman, rayon, periode, kategori, tanggal, pencarian, semuanya ikut.
  // Angka di dropdown harus menjawab "kalau saya pilih ini, dapat berapa" —
  // bukan jumlah di seluruh file. Hanya saringan kelompok itu sendiri yang
  // diabaikan, supaya angkanya tidak menyusut jadi cuma pilihan yang sedang
  // dipakai.
  function hitungKelompok(peta, opsi) {
    const jml = {};
    if (!peta || !peta.size) return jml;
    const sudah = new Set();
    const cats = getSelectedCategories();
    for (const r of getBaseFiltered(opsi)) {
      if (cats.size > 0 && !cats.has(r.category)) continue;
      // Saringan titik menyembunyikan kunjungan flag 1 (lihat getBaseFiltered),
      // jadi angkanya pun tidak boleh menghitung outlet yang di pilihan ini
      // cuma menyisakan kunjungan flag 1 — nanti dipilih, tabelnya kosong.
      if (opsi && opsi.tanpaFlag1 && r.flagRadius === "1") continue;
      if (sudah.has(r.custno)) continue;
      sudah.add(r.custno);
      const u = peta.get(r.custno);
      if (u) jml[u.bucket] = (jml[u.bucket] || 0) + 1;
    }
    return jml;
  }

  function labelBarcodeFilter() {
    const sel = $("filterBarcode");
    if (!sel) return;
    const j = state.results && state.results.length
      ? hitungKelompok(state.barcodeByOutlet, { abaikanBarcode: true })
      : (state.barcodeStats || {});
    const n = (x) => (x || 0).toLocaleString("id-ID");
    const teks = {
      "": "Semua barcode",
      BARU: `Baru bermasalah (${n(j.BARU)})`,
      BELUM: `Belum pernah discan (${n(j.BELUM)})`,
      BERES: `Sudah beres (${n(j.BERES)})`,
      LANCAR: `Barcode lancar (${n(j.LANCAR)})`,
    };
    for (const o of sel.options) if (teks[o.value] !== undefined) o.textContent = teks[o.value];
    // Tanpa file HHT tidak ada riwayat scan sama sekali, jadi penyaringnya
    // disembunyikan daripada memajang pilihan yang semuanya nol.
    sel.classList.toggle("hidden", !state.hhtFile);
  }

  function barcodeSel(r) {
    const u = state.barcodeByOutlet ? state.barcodeByOutlet.get(r.custno) : null;
    if (!u) return "";
    const info = BARCODE_INFO[u.bucket];
    const sebab = u.alasan
      ? ` &middot; ${escapeHtml(u.alasan)}`
      : u.alasanTercatat
        ? ` &middot; ${escapeHtml(u.alasanTercatat)} (dicatat ${escapeHtml(u.alasanTgl)})`
        : ` &middot; tidak ada alasan tercatat`;
    const sejak = u.mulaiGagal
      ? `<br>bermasalah sejak ${escapeHtml(u.mulaiGagal)}`
        + (u.terakhirBerhasil ? `, terakhir berhasil ${escapeHtml(u.terakhirBerhasil)}` : "")
      : "";
    const rinci = u.bucket === "LANCAR"
      ? `${u.n} kunjungan, semuanya discan`
      : u.bucket === "BERES"
        ? `${u.scan} dari ${u.n} kunjungan discan, terakhir ${escapeHtml(u.tglAkhir)} berhasil`
        : `${u.scan} dari ${u.n} kunjungan discan, terakhir ${escapeHtml(u.tglAkhir)} gagal`
          + sebab + sejak;
    return `<span class="tag tag-bc-${u.bucket}" title="${escapeHtml(info.hint)}">${info.label}</span>`
      + `<span class="titik-sub">${rinci}</span>`
      + riwayatSub(r.custno, u.n);
  }

  // Menggabungkan dua penilaian yang sudah ada — konsistensi radius (dari EDI)
  // dan riwayat scan barcode (dari HHT) — jadi satu jawaban.
  // Radius: MIXED = kadang, PROBLEM = selalu. Kunjungan tunggal (SINGLE) tidak
  // dinilai; satu kali OUT RADIUS belum tentu pola.
  // Barcode: BELUM = tidak pernah berhasil, BARU/BERES = kadang berhasil kadang
  // tidak. Tanpa file HHT, atau outletnya tidak tercakup file itu, sisi barcode
  // memang tidak bisa dinilai — jadi yang disebut hanya sisi radius.
  function sisiMasalah(r) {
    const rad = r.consistency === "MIXED" ? "kadang"
      : r.consistency === "PROBLEM" ? "selalu" : "";
    const bc = state.barcodeByOutlet ? state.barcodeByOutlet.get(r.custno) : null;
    const bar = !bc ? ""
      : bc.bucket === "BELUM" ? "selalu"
      : (bc.bucket === "BARU" || bc.bucket === "BERES") ? "kadang" : "";
    if (!rad && !bar) return "";
    if (rad && !bar) return rad === "kadang" ? "MIX_R" : "TETAP_R";
    if (!rad && bar) return bar === "kadang" ? "MIX_B" : "TETAP_B";
    if (rad === bar) return rad === "kadang" ? "MIX_RB" : "TETAP_RB";
    return rad === "selalu" ? "CAMPUR_R" : "CAMPUR_B";
  }

  function masalahSel(r) {
    const k = sisiMasalah(r);
    if (!k) return "";
    const info = MASALAH_INFO[k];
    return `<span class="tag masalah-${info.tone}" title="${escapeHtml(info.hint)}">`
      + `${escapeHtml(info.label)}</span>`;
  }

  function hitungTitik() {
    const rg = rentangTanggal();
    // Rentang tanggal menentukan kunjungan mana yang DINILAI, bukan bukti mana
    // yang boleh dipakai. Justru kunjungan lama yang dulu lolos itulah acuan
    // koordinat yang benar — kalau ikut dibuang, buktinya hilang.
    const perOutlet = new Map();
    for (const r of state.results) {
      const la = angka(r.latVisit), lo = angka(r.longVisit);
      if (titikKosong(la, lo)) continue;
      let v = perOutlet.get(r.custno);
      if (!v) { v = []; perOutlet.set(r.custno, v); }
      v.push({ la, lo, r });
    }

    // Kunjungan PALING AKHIR tiap outlet di dalam rentang yang dinilai —
    // dihitung dari seluruh kunjungan, termasuk yang koordinatnya tidak
    // terekam, karena yang ditanya cuma "terakhir kali masuk radius atau tidak".
    const akhirPer = new Map();
    for (const r of state.results) {
      if (!dalamRentang(r, rg)) continue;
      const t = String(r.tglIso || "");
      const p = akhirPer.get(r.custno);
      if (!p || t > p.t) akhirPer.set(r.custno, { t, flag: r.flagRadius });
    }

    const info = new Map();
    const jml = { kembali: 0, usul: 0, tanya: 0, pas: 0, satu: 0, dampak: 0 };
    for (const [custno, semua] of perOutlet) {
      // Yang DINILAI: kunjungan bermasalah (flag 0 dan blank) di dalam rentang
      // tanggal yang dipilih. Kunjungan flag 1 sudah masuk radius — tidak ada
      // yang perlu diusulkan untuknya, dan kalau ikut dihitung malah menggeser
      // titik usulan.
      const vs = semua.filter((v) => v.r.flagRadius !== "1" && dalamRentang(v.r, rg));
      if (!vs.length) continue;   // di rentang ini outlet tidak bermasalah
      // Sudah beres kalau kunjungan terakhirnya masuk radius. Ditandai, bukan
      // dibuang, supaya di tabel tetap terbaca "sudah beres" dan bukan hilang
      // begitu saja — tapi tidak ikut daftar kerja mana pun.
      const akhir = akhirPer.get(custno);
      if (akhir && akhir.flag === "1") {
        info.set(custno, { bucket: "PAS", sebab: "beres", n: semua.length,
                           masalah: vs.length, tglBeres: akhir.t });
        jml.pas++;
        continue;
      }
      const ref = vs[0].r;
      const set = angka(ref.setting) || RADIUS_DEFAULT;
      const pernahLolos = semua.some((v) => v.r.flagRadius === "1");

      // Pernah ada kunjungan yang lolos radius di outlet ini — kapan pun, tidak
      // harus di dalam rentang. Dua kemungkinan yang harus dibedakan:
      //  a. titiknya masih sama seperti waktu lolos  -> titiknya benar,
      //     yang menyimpang kunjungannya;
      //  b. titiknya sudah DIUBAH sejak itu           -> perubahannya yang
      //     merusak. Koordinat lama sudah terbukti benar oleh sistem sendiri,
      //     jadi acuannya bukan tebakan dari sebaran kunjungan, melainkan
      //     angka yang dulu dipakai.
      if (pernahLolos) {
        const lama = titikTerbukti(semua, set);
        if (lama) {
          info.set(custno, { bucket: "KEMBALI", n: semua.length, masalah: vs.length,
                             mLat: lama.la, mLon: lama.lo, curLa: lama.curLa, curLo: lama.curLo,
                             geser: lama.geser, tglLolos: lama.tgl, belumTag: false,
                             salesmanBeda: new Set(semua.map((v) => v.r.salesmanEff).filter(Boolean)).size,
                             bisaLolos: lama.bisaLolos, yakin: "Tinggi" });
          jml.kembali++;
          jml.dampak += lama.bisaLolos;
        } else {
          // Titik yang dipakai waktu kunjungan bermasalah itu ternyata sudah
          // diganti. Artinya masalahnya sudah selesai dengan sendirinya — ini
          // yang membedakan "masih salah" dari "dulu salah, sekarang beres".
          const kini = titikAkhir(semua);
          const sudahDiperbaiki = !!kini && vs.some((v) => {
            const a = angka(v.r.latVal), b = angka(v.r.longVal);
            return !titikKosong(a, b) && meter(a, b, kini.la, kini.lo) > set;
          });
          info.set(custno, { bucket: "PAS", sebab: sudahDiperbaiki ? "diperbaiki" : "lolos",
                             n: semua.length, masalah: vs.length,
                             tglBaru: sudahDiperbaiki ? kini.tgl : "" });
          jml.pas++;
        }
        continue;
      }

      // Satu kunjungan tidak bisa membuktikan apa-apa: tidak ada pembanding.
      if (vs.length < 2) { info.set(custno, { bucket: "SATU", n: 1 }); jml.satu++; continue; }

      // Titik usulan diambil dari kelompok terpadat, bukan dari semua kunjungan.
      const inti = kelompokTerpadat(vs, set);
      const mLat = median(inti.map((v) => v.la));
      const mLon = median(inti.map((v) => v.lo));
      const jarak = vs.map((v) => meter(v.la, v.lo, mLat, mLon));
      // "Rapat" = kunjungan yang akan masuk radius izin kalau titik usulan
      // dipakai. Ukurannya memakai SETTING milik sistem, bukan angka sendiri.
      const dekat = jarak.filter((d) => d <= set);
      const rapat = dekat.length;
      const sebar = Math.round(rapat ? Math.max(...dekat) : Math.max(...jarak));

      // Titik master diambil dari baris pertama yang benar-benar punya titik.
      let curLa = null, curLo = null;
      for (const v of vs) {
        const a = angka(v.r.latVal), b = angka(v.r.longVal);
        if (!titikKosong(a, b)) { curLa = a; curLo = b; break; }
      }
      const belumTag = curLa === null;
      const geser = belumTag ? null : Math.round(meter(mLat, mLon, curLa, curLo));
      const salesmanBeda = new Set(vs.map((v) => v.r.salesmanEff).filter(Boolean)).size;
      const hariBeda = new Set(vs.map((v) => tglKunci(v.r.visitDate)).filter(Boolean)).size;

      const mayoritas = rapat >= Math.max(2, Math.ceil(vs.length * AMBANG_RAPAT));
      const bagian = vs.length ? rapat / vs.length : 0;
      // Hanya diusulkan kalau titik yang sekarang memang bermasalah: belum
      // di-tag, atau letaknya di luar radius dari tempat kunjungan berkumpul.
      const salahSekarang = belumTag || geser > set;

      if (!mayoritas) {
        // Kunjungannya tidak berkumpul, jadi jarak ke median tidak menggambarkan
        // apa-apa. Yang dilaporkan jarak antar kunjungan yang paling berjauhan.
        let jauh = 0;
        for (let i = 0; i < vs.length; i++)
          for (let j = i + 1; j < vs.length; j++)
            jauh = Math.max(jauh, meter(vs[i].la, vs[i].lo, vs[j].la, vs[j].lo));
        info.set(custno, { bucket: "TANYA", n: vs.length, sebar: Math.round(jauh),
                           curLa, curLo, belumTag, salesmanBeda });
        jml.tanya++;
      } else if (!salahSekarang) {
        // Kunjungan mengumpul tepat di titik master: titiknya sudah benar,
        // yang di luar radius itu kunjungan yang memang menyimpang.
        info.set(custno, { bucket: "PAS", sebab: "pas", n: vs.length, geser, curLa, curLo });
        jml.pas++;
      } else {
        const bisaLolos = jarak.filter((d) => d <= set).length;
        jml.dampak += bisaLolos;
        // Keyakinan mengikuti seberapa besar bagian kunjungan yang mengumpul.
        // Usulan dengan bagian kecil tetap ditampilkan — tapi jangan sampai
        // terbaca sekuat yang seluruh kunjungannya sepakat.
        let yakin = "Rendah";
        if (rapat === vs.length && (vs.length >= 3 || salesmanBeda > 1)) yakin = "Tinggi";
        else if (bagian >= 0.6) yakin = "Sedang";
        info.set(custno, { bucket: "USUL", n: vs.length, rapat, sebar, mLat, mLon,
                           curLa, curLo, belumTag, geser, set, salesmanBeda, hariBeda,
                           bisaLolos, yakin, bagian });
        jml.usul++;
      }
    }

    state.titikByOutlet = info;
    state.titikStats = jml;
    labelTitikFilter();
  }

  // Jumlah tiap kelompok ditulis di pilihan filternya sendiri, jadi angkanya
  // tetap terbaca tanpa perlu deretan kartu tersendiri.
  function labelTitikFilter() {
    const sel = $("filterTitik");
    if (!sel) return;
    const k = state.results && state.results.length
      ? hitungKelompok(state.titikByOutlet, { abaikanTitik: true, tanpaFlag1: true })
      : {};
    const j = { kembali: k.KEMBALI || 0, usul: k.USUL || 0, tanya: k.TANYA || 0,
                pas: k.PAS || 0, satu: k.SATU || 0 };
    const n = (x) => x.toLocaleString("id-ID");
    const teks = {
      "": "Semua outlet",
      KEMBALI: `Titik toko diubah — kembalikan yang lama (${n(j.kembali)})`,
      USUL: `Titik toko perlu diperbaiki (${n(j.usul)})`,
      TANYA: `Kunjungan berpencar — tanya salesman (${n(j.tanya)})`,
      PAS: `Titik toko sudah benar (${n(j.pas)})`,
      SATU: `Baru 1 kunjungan bermasalah (${n(j.satu)})`,
    };
    for (const o of sel.options) if (teks[o.value] !== undefined) o.textContent = teks[o.value];
  }

  // Isi kolom "Usulan Titik" pada baris kunjungan. Outlet yang semua
  // kunjungannya sudah IN RADIUS tidak punya isi — kolomnya sengaja dibiarkan
  // kosong supaya yang perlu ditindaklanjuti langsung menonjol.
  // Catatan dibuat pendek dan berpola tetap — hanya empat kemungkinan isi.
  // Kalimat panjang membuat kolomnya melebar dan, yang lebih merepotkan,
  // membuat daftar filter di Excel berisi ratusan kalimat berbeda sehingga
  // tidak bisa dipakai memantau. Angkanya sendiri sudah ada di kolom "Dasar
  // Usulan" dan "Salesman Berbeda", jadi tidak perlu diulang di sini.
  function catatanUsulan(u) {
    if (!u) return "";
    if (u.bucket === "KEMBALI") return "Kembalikan titik lama";
    if (u.bucket !== "USUL") return "";
    if (u.yakin === "Tinggi") return "Langsung perbaiki";
    if (u.yakin === "Sedang") return "Cek alamat dulu";
    return "Cek peta & alamat dulu";
  }

  // Satu baris kecil berisi riwayat utuh outlet. Ditulis hanya kalau memang
  // menambah keterangan — kalau angka dasarnya sudah sama dengan riwayat
  // utuhnya, mengulanginya cuma bikin ramai.
  function riwayatSub(custno, dasar) {
    const g = globalOutlet(custno);
    if (!g.n) return "";
    const banyakSls = g.sls.size > 1;
    if (g.n === dasar && !banyakSls) return "";
    const bag = [`riwayat outlet: ${g.n} kunjungan`];
    if (g.luar) bag.push(`${g.luar} di luar radius`);
    if (banyakSls) bag.push(`${g.sls.size} salesman`);
    return `<span class="titik-sub" title="Seluruh kunjungan ke outlet ini, `
      + `siapa pun yang mengerjakan dan kapan pun — termasuk oleh salesman yang `
      + `dulu memegangnya.">${bag.join(" &middot; ")}</span>`;
  }

  function titikSel(r) {
    // Kunjungan yang sudah IN RADIUS tidak perlu usulan apa-apa.
    if (r.flagRadius === "1") return "";
    const u = state.titikByOutlet ? state.titikByOutlet.get(r.custno) : null;
    if (!u) return "";
    if (u.bucket === "SATU")
      return `<span class="nil">Baru 1 kunjungan bermasalah — belum bisa dinilai</span>`;
    if (u.bucket === "PAS")
      return u.sebab === "beres"
        ? `<span class="nil">Sudah beres — kunjungan terakhir${u.tglBeres ? ` (${tglTampil(u.tglBeres)})` : ""} sudah masuk radius</span>`
        : u.sebab === "diperbaiki"
          ? `<span class="nil">Titik toko sudah diperbaiki setelah tanggal ini — tidak perlu tindakan</span>`
          : `<span class="nil">Titik toko sudah benar — kunjungan lain di outlet ini masuk radius</span>`;
    if (u.bucket === "TANYA")
      return `<span class="nil">Kunjungan berpencar ${jarakTeks(u.sebar)} — tanyakan ke salesman</span>`;
    const kuat = u.salesmanBeda > 1
      ? ` <span class="kuat" title="Dikunjungi lebih dari satu salesman yang berbeda — bukti lebih kuat">2+ SLS</span>` : "";
    // Mengembalikan koordinat yang dulu terbukti lolos berbeda sifatnya dari
    // menebak titik baru dari sebaran kunjungan, jadi kalimatnya pun berbeda.
    if (u.bucket === "KEMBALI") {
      const kapan = u.tglLolos ? ` (terakhir lolos ${tglTampil(u.tglLolos)})` : "";
      return `<b class="titik-aksi kembali">Titik toko diubah — kembalikan yang lama</b>`
        + ` <span class="tag-cons yakin-Tinggi" title="Koordinat ini dulu menghasilkan FLAG 1 di outlet yang sama. Bukan tebakan dari sebaran kunjungan — sistem sendiri yang sudah menyatakannya lolos.">Tinggi</span>${kuat}`
        + `<span class="titik-sub">titik dipindah ${jarakTeks(u.geser)} dari titik lama${kapan}`
        + ` &middot; ${u.bisaLolos} kunjungan akan lolos lagi<br>`
        + `titik lama: ` + petaLink(u.mLat, u.mLon, `${u.mLat.toFixed(6)}, ${u.mLon.toFixed(6)}`)
        + `</span>`;
    }
    // Kalimatnya dulu, angkanya belakangan. Yang membaca tabel ini bukan orang
    // yang hafal arti koordinat — yang perlu langsung terbaca adalah "harus
    // diapakan", bukan "berapa derajat".
    return `<b class="titik-aksi">Titik toko perlu diperbaiki</b>`
      + ` <span class="tag-cons yakin-${u.yakin}" title="${escapeHtml(TITIK_YAKIN[u.yakin])}">${u.yakin}</span>${kuat}`
      + `<span class="titik-sub">`
      + (u.belumTag ? "titik toko belum diisi" : `meleset ${jarakTeks(u.geser)}`)
      + ` &middot; ${u.rapat} dari ${u.n} kunjungan (${Math.round((u.bagian || 0) * 100)}%)`
      + ` mengumpul di titik ini<br>`
      + petaLink(u.mLat, u.mLon, `${u.mLat.toFixed(6)}, ${u.mLon.toFixed(6)}`)
      + `</span>`
      + riwayatSub(r.custno, u.n);
  }

  // Baris untuk sheet "Usulan Titik": satu baris per outlet, bukan per
  // kunjungan — yang dipakai orang gudang/master untuk memperbaiki datanya.
  function titikBarisExcel(custno, u, r) {
    const kembali = u.bucket === "KEMBALI";
    const g = globalOutlet(custno);
    return {
      Tindakan: kembali ? "Kembalikan ke titik lama yang dulu lolos" : "Ganti ke titik usulan",
      "Kode Outlet": custno,
      "Nama Toko": r.namaTokoEff,
      // Pemilik menurut DMP ditaruh di depan: daftar kerja dibagikan menurut
      // siapa yang memegang outletnya, bukan siapa yang kebetulan berkunjung.
      // Pengunjungnya tetap ditulis di kolom sebelahnya — kalau keduanya
      // berbeda, itu sendiri yang perlu ditindaklanjuti.
      "Salesman (DMP)": r.salesmanDmp || "",
      "Dikunjungi Oleh": r.salesmanEff,
      "Rayon (DMP)": r.rayonEff,
      Cycle: r.cycleEff || "",
      ...kolomCycleSls(custno),
      "Alamat (DMP)": r.alamatEff || "",
      Keyakinan: u.yakin,
      Catatan: catatanUsulan(u),
      "Dasar Usulan": kembali
        ? `FLAG 1 pada ${tglTampil(u.tglLolos)}`
        : `${u.rapat} dari ${u.n} (${Math.round((u.bagian || 0) * 100)}%)`,
      // Angka di "Dasar Usulan" hanya menghitung kunjungan BERMASALAH yang
      // dipakai menghitung titiknya. Riwayat utuh outlet ditaruh di kolom
      // sendiri supaya tidak tertukar: ini seluruh kunjungan ke outlet itu,
      // siapa pun yang mengerjakan dan kapan pun, termasuk oleh salesman yang
      // dulu memegangnya sebelum outletnya dioper.
      "Total Kunjungan Outlet": g.n,
      "Total In Radius": g.dalam,
      "Total Di Luar Radius": g.luar,
      "Salesman Pernah Berkunjung": [...g.sls].join("; "),
      "Sebaran (m)": u.sebar === undefined ? "" : u.sebar,
      "Lat Sekarang": u.belumTag ? "" : koordTeks(u.curLa),
      "Long Sekarang": u.belumTag ? "" : koordTeks(u.curLo),
      "Status Titik Sekarang": u.belumTag ? "Belum di-tag" : "Ada",
      "Lat Usulan": koordTeks(u.mLat),
      "Long Usulan": koordTeks(u.mLon),
      "Geser (m)": u.geser === null || u.geser === undefined ? "" : u.geser,
      "Salesman Berbeda": u.salesmanBeda,
      "Kunjungan Jadi IN RADIUS": u.bisaLolos === undefined ? "" : u.bisaLolos,
      "Buka Peta": "Buka peta",
      "Lihat Toko": "Lihat toko",
      _pin: petaPin(u.mLat, u.mLon),
      _pano: petaToko(u.mLat, u.mLon),
    };
  }

  // ---- Shared surface for dash2.js ----
  // dash2 reuses the same universal file readers and the DMP outlet index.
  window.M3 = {
    unduh,
    readAsAoA,
    readRawText,
    detectDelim,
    pecahBaris,
    parseDelimitedText,
    escapeHtml,
    debounce,
    setStatus,
    placeMenu,
    stampLabels,
    getDmpIndex: () => state.dmpIndex,
    getDmpBySalesman: () => state.dmpBySalesman || new Map(),
    getDmpStats: () => state.dmpStats || null,
    // Dipakai Dashboard 2 supaya kedua dashboard menyebut cabang dengan
    // sebutan yang sama persis.
    namaBranch,
    labelBranch,
    umurHari,
    tglTampil,
    // Kotak cari yang bisa memilih sekaligus semua yang cocok. Dipakai dua
    // dashboard supaya cara kerjanya sama di dua-duanya.
    wirePencarianSalesman,
    // Dipakai untuk memeriksa hasil hitungan dari luar (uji otomatis dan
    // console) — bukan bagian dari tampilan, jadi tidak ada yang berubah
    // kalau isinya dibaca.
    getState: () => state,
    getFiles: () => ({ lbp: state.lbpFile }),
    onLbpFile: (f) => { state.lbpFile = f; state.lbpFiles = f ? [f] : []; },
    showDash,
  };
})();
