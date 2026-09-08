(function () {
  var G = { A: 0.01, B: 0.05, C: 0.12 };
  var NEED = [
    { kind: "efd_icms_ipi", label: "EFD ICMS/IPI" },
    { kind: "nfe_xml", label: "NF-e XML" },
    { kind: "apuracao", label: "Apuracao / balanco / planilha" },
    { kind: "livro_registro", label: "Livro de registro" }
  ];
  var NAV = [
    ["mesa", "1", "Dossie"],
    ["sim", "2", "Simulador"],
    ["emitir", "3", "Emitir"],
    ["pass", "4", "Passaporte"],
    ["verif", "5", "Verificar"],
    ["cart", "6", "Carteira"]
  ];
  var CRUMB = { mesa: "DOSSIE", sim: "SIMULADOR", emitir: "EMITIR", pass: "PASSAPORTE", verif: "VERIFICAR", cart: "CARTEIRA" };
  var S = { view: "mesa", vn: 0, grade: "C", i: 1.5, T: 12, emitStep: 1, verified: false, bolsa: "nao", razao: "", cnpj: "", ie: "", periodo: "2026-02", files: [], dossier: null, scanErr: "", scanning: false, open: 0 };
  var BRL = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
  var PCT = new Intl.NumberFormat("pt-BR", { style: "percent", minimumFractionDigits: 1, maximumFractionDigits: 1 });
  function fv() { if (!S.vn) return 0; return S.vn * (1 - G[S.grade]) / Math.pow(1 + S.i / 100, S.T); }
  function pv() { if (!S.vn) return 0; var i = S.i / 100; return i === 0 ? S.vn : (S.vn / 240) * (1 - Math.pow(1 + i, -240)) / i; }
  function go(v, extra) { S.view = v; if (extra) Object.assign(S, extra); render(); }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]; }); }
  function digits(s) { return String(s || "").replace(/\D/g, ""); }
  function uniq(arr) { var o = [], s = {}; arr.forEach(function (x) { if (x && !s[x]) { s[x] = 1; o.push(x); } }); return o; }
  function tag(xml, name) { var m = String(xml || "").match(new RegExp("<" + name + "[^>]*>([^<]+)</" + name + ">", "i")); return m ? m[1].trim() : ""; }
  function hasKind(k) { return S.files.some(function (f) { return f.kind === k; }); }
  function missing() { return NEED.filter(function (d) { return !hasKind(d.kind); }); }
  function hex(buf) { return Array.from(new Uint8Array(buf)).map(function (b) { return b.toString(16).padStart(2, "0"); }).join(""); }
  function fmtCnpj(d) { d = digits(d); if (d.length !== 14) return d; return d.slice(0, 2) + "." + d.slice(2, 5) + "." + d.slice(5, 8) + "/" + d.slice(8, 12) + "-" + d.slice(12); }
  function ymFromSped(d) { if (!d || d.length !== 8) return ""; return d.slice(4, 8) + "-" + d.slice(2, 4); }
  function brlNum(s) { if (s == null || s === "") return 0; var t = String(s).trim(); if (t.indexOf(",") >= 0) t = t.replace(/\./g, "").replace(",", "."); var n = Number(t); return isFinite(n) ? n : 0; }
  document.getElementById("dias").textContent = String(Math.max(0, Math.ceil((Date.parse("2033-01-01") - Date.now()) / 86400000)));
  function guessKind(name, text) {
    var n = (name || "").toLowerCase(); var t = text || "";
    if (n.endsWith(".xml") || /<(nfeProc|NFe|infNFe)\b/i.test(t)) return "nfe_xml";
    if (/\|0000\|/.test(t) || n.indexOf("efd") >= 0 || n.indexOf("sped") >= 0) return "efd_icms_ipi";
    if (n.indexOf("livro") >= 0 || n.indexOf("registro") >= 0) return "livro_registro";
    if (n.endsWith(".txt") && /\|C100\|/.test(t)) return "efd_icms_ipi";
    return "apuracao";
  }
  function readable(buf) {
    var u = new Uint8Array(buf); var out = [], cur = [];
    function flush() { if (cur.length >= 6) { try { out.push(String.fromCharCode.apply(null, cur)); } catch (e) {} } cur = []; }
    for (var i = 0; i < u.length; i++) { var c = u[i]; if (c >= 32 && c <= 126) cur.push(c); else flush(); }
    flush(); return out.join("\n");
  }
  function harvestGeneric(text, facts) {
    if (!text) return; var m, re;
    re = /\b(\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2})\b/g; while ((m = re.exec(text))) { var d = digits(m[1]); if (d.length === 14) facts.cnpjs.push(d); }
    re = /\b(20[2-3]\d[-/](0[1-9]|1[0-2]))\b/g; while ((m = re.exec(text))) facts.periodos.push(m[1].replace("/", "-"));
    re = /\b(\d{44})\b/g; while ((m = re.exec(text))) facts.chaves.push(m[1]);
  }
  function extractNfe(text, facts) {
    var emit = text.match(/<emit>[\s\S]*?<\/emit>/i); var block = emit ? emit[0] : text;
    var nome = tag(block, "xNome"); if (nome) facts.razoes.push(nome);
    var cnpj = digits(tag(block, "CNPJ")); if (cnpj.length === 14) facts.cnpjs.push(cnpj);
    var ie = digits(tag(block, "IE")); if (ie.length >= 8) facts.ies.push(ie);
    var dh = tag(text, "dhEmi") || tag(text, "dEmi"); if (dh) facts.periodos.push(dh.slice(0, 7));
    var ch = digits(tag(text, "chNFe"));
    if (ch.length !== 44) { var id = text.match(/Id=["']NFe(\d{44})["']/i); if (id) ch = id[1]; }
    if (ch.length === 44) facts.chaves.push(ch);
    var vnf = tag(text, "vNF"); if (vnf) facts.valores.push(brlNum(vnf));
    facts.source = "xml";
  }
  function extractEfd(text, facts) {
    text.split(/\r?\n/).forEach(function (line) {
      if (line.charAt(0) !== "|") return;
      var p = line.split("|"); var rec = p[1];
      if (rec === "0000") {
        if (p[6]) facts.razoes.push(p[6]);
        var cnpj = digits(p[7] || ""); if (cnpj.length === 14) facts.cnpjs.push(cnpj);
        var ie = digits(p[10] || ""); if (ie.length >= 8) facts.ies.push(ie);
        var ym = ymFromSped(p[4] || ""); if (ym) facts.periodos.push(ym);
      }
      if (rec === "C100") {
        p.forEach(function (x) { if (/^\d{44}$/.test(x)) facts.chaves.push(x); });
        var val = brlNum(p[p.length - 2] || p[p.length - 1]); if (val > 0) facts.valores.push(val);
        facts.c100 = (facts.c100 || 0) + 1;
      }
      if (rec === "E110") { var nums = p.map(brlNum).filter(function (n) { return n > 0; }); if (nums.length) facts.e110 = nums[nums.length - 1]; }
    });
    facts.source = "efd";
  }
  function extractFacts(kind, name, text) {
    var facts = { cnpjs: [], ies: [], razoes: [], periodos: [], chaves: [], valores: [], source: "hash", c100: 0 };
    if (!text) return facts;
    if (kind === "nfe_xml" || /<(nfeProc|NFe|infNFe)\b/i.test(text)) extractNfe(text, facts);
    else if (kind === "efd_icms_ipi" || /\|0000\|/.test(text)) extractEfd(text, facts);
    else { harvestGeneric(text, facts); facts.source = /\.csv$/i.test(name) ? "csv" : "texto"; }
    facts.cnpjs = uniq(facts.cnpjs); facts.ies = uniq(facts.ies); facts.razoes = uniq(facts.razoes); facts.periodos = uniq(facts.periodos); facts.chaves = uniq(facts.chaves);
    return facts;
  }
  function pool() {
    var p = { cnpjs: [], ies: [], razoes: [], periodos: [], chavesNfe: [], chavesEfd: [], vNfe: 0, c100: 0, e110: 0 };
    S.files.forEach(function (f) {
      var x = f.facts || extractFacts(f.kind, f.name, f.text); f.facts = x;
      p.cnpjs = p.cnpjs.concat(x.cnpjs); p.ies = p.ies.concat(x.ies); p.razoes = p.razoes.concat(x.razoes); p.periodos = p.periodos.concat(x.periodos);
      if (f.kind === "nfe_xml") { p.chavesNfe = p.chavesNfe.concat(x.chaves); x.valores.forEach(function (v) { p.vNfe += v; }); }
      if (f.kind === "efd_icms_ipi") { p.chavesEfd = p.chavesEfd.concat(x.chaves); p.c100 += x.c100 || 0; if (x.e110) p.e110 = x.e110; }
    });
    p.cnpjs = uniq(p.cnpjs); p.ies = uniq(p.ies); p.razoes = uniq(p.razoes); p.periodos = uniq(p.periodos); p.chavesNfe = uniq(p.chavesNfe); p.chavesEfd = uniq(p.chavesEfd);
    return p;
  }
  function applyIdentity(p) {
    if (!S.razao && p.razoes[0]) S.razao = p.razoes[0];
    if (!digits(S.cnpj) && p.cnpjs[0]) S.cnpj = fmtCnpj(p.cnpjs[0]);
    if (!digits(S.ie) && p.ies[0]) S.ie = p.ies[0];
    if (p.periodos[0] && (!S.periodo || S.periodo === "2026-02")) S.periodo = p.periodos[0];
    if (!S.vn && p.vNfe) S.vn = Math.round(p.vNfe);
  }
  function matches() {
    var p = pool(); var rows = []; var miss = missing();
    rows.push({ ok: miss.length === 0, label: "Pacote CAT 42", detail: miss.length ? "Falta " + miss.map(function (m) { return m.label; }).join(", ") : "EFD, NF-e, apuracao e livro na mesa" });
    var declC = digits(S.cnpj); var cnpjOk = (p.cnpjs.length === 1 && (!declC || p.cnpjs[0] === declC));
    rows.push({ ok: cnpjOk, label: "CNPJ bate", detail: p.cnpjs.length ? p.cnpjs.map(fmtCnpj).join(" · ") : (declC ? "so na ficha" : "nenhum CNPJ lido") });
    var declIe = digits(S.ie); var ieOk = (!!declIe || p.ies.length > 0) && p.ies.length <= 1 && (!declIe || !p.ies.length || p.ies.indexOf(declIe) >= 0);
    rows.push({ ok: ieOk, label: "IE (SP)", detail: p.ies.length ? p.ies.join(" · ") : (declIe || "ausente") });
    var perOk = !!(S.periodo || p.periodos[0]) && (p.periodos.length === 0 || p.periodos.indexOf(S.periodo) >= 0);
    rows.push({ ok: perOk, label: "Competencia", detail: (p.periodos.join(" · ") || "sem data") + (S.periodo ? " · ficha " + S.periodo : "") });
    var missingKeys = p.chavesNfe.filter(function (c) { return p.chavesEfd.indexOf(c) < 0; });
    var chaveOk = p.chavesNfe.length > 0 && p.chavesEfd.length > 0 && missingKeys.length === 0;
    rows.push({ ok: chaveOk, label: "Chaves NF-e x C100", detail: p.chavesNfe.length + " NF-e · " + p.chavesEfd.length + " C100" + (missingKeys.length ? " · " + missingKeys.length + " XML fora da EFD" : "") });
    var valorOk = !!(S.vn || p.vNfe) && (!S.vn || !p.vNfe || Math.abs(S.vn - p.vNfe) / Math.max(S.vn, p.vNfe) <= 0.05);
    rows.push({ ok: valorOk, label: "Valor", detail: (p.vNfe ? "NF-e " + BRL.format(p.vNfe) : "sem soma NF-e") + (S.vn ? " · ficha " + BRL.format(S.vn) : "") });
    return { rows: rows, pool: p, okCount: rows.filter(function (r) { return r.ok; }).length };
  }
  function nav() {
    document.getElementById("nav").innerHTML = NAV.map(function (it) { var on = S.view === it[0] ? " on" : ""; return '<a href="#' + it[0] + '" class="' + on + '" data-v="' + it[0] + '"><span class="n">' + it[1] + "</span><span>" + it[2] + "</span></a>"; }).join("");
    document.getElementById("crumb").textContent = CRUMB[S.view] || "";
  }
  function mesa() {
    var m = matches(); applyIdentity(m.pool); var miss = missing();
    var canScan = S.files.some(function (f) { return (f.kind === "nfe_xml" || f.kind === "efd_icms_ipi") && f.text; });
    var files = S.files.length ? S.files.map(function (f, i) { var src = (f.facts && f.facts.source) || (f.text ? "texto" : "hash"); return '<button class="doc-line' + (S.open === i ? " on" : "") + '" data-open="' + i + '"><span class="sev ' + (src === "hash" ? "alta" : "ok") + '">' + src.toUpperCase() + "</span><strong>" + esc(f.name) + '</strong><span class="muted">' + (f.size / 1024).toFixed(1) + " KB</span></button>"; }).join("") : '<p class="muted">Nada na mesa.</p>';
    var ficha;
    if (S.files[S.open]) {
      var f = S.files[S.open]; var x = f.facts || {};
      ficha = '<div class="ficha"><div class="n">FICHA DO ARQUIVO</div><h3>' + esc(f.name) + '</h3><div class="fields"><div class="field"><div class="k">Tipo</div><div class="v"><select data-kind="' + S.open + '">' + NEED.map(function (d) { return '<option value="' + d.kind + '"' + (f.kind === d.kind ? " selected" : "") + ">" + d.label + "</option>"; }).join("") + '</select></div></div><div class="field"><div class="k">CNPJ lido</div><div class="v">' + esc((x.cnpjs || []).map(fmtCnpj).join(" · ") || "-") + '</div></div><div class="field"><div class="k">Razao</div><div class="v">' + esc((x.razoes || []).join(" · ") || "-") + '</div></div><div class="field"><div class="k">IE</div><div class="v">' + esc((x.ies || []).join(" · ") || "-") + '</div></div><div class="field"><div class="k">Competencia</div><div class="v">' + esc((x.periodos || []).join(" · ") || "-") + '</div></div><div class="field"><div class="k">Chaves</div><div class="v">' + ((x.chaves && x.chaves.length) ? String(x.chaves.length) : "-") + '</div></div></div><p class="muted">' + (f.text ? "Texto extraido no cliente. PDF compactado so rende string em claro." : "Sem texto — entra pelo tipo e pelo hash.") + '</p><div class="row"><button class="btn btn-sec" data-del="' + S.open + '">Tirar da mesa</button></div></div>';
    } else ficha = '<div class="ficha"><div class="n">FICHA</div><p class="muted">Solte um arquivo. A ficha mostra o que deu para ler.</p></div>';
    var checks = m.rows.map(function (r) { return '<div class="check"><span class="sev ' + (r.ok ? "ok" : "alta") + '">' + (r.ok ? "BATE" : "DIVERGE") + "</span><div><strong>" + r.label + '</strong><div class="muted">' + esc(r.detail) + "</div></div></div>"; }).join("");
    var res = "";
    if (S.scanErr) res = '<div class="card"><p class="muted">' + esc(S.scanErr) + "</p></div>";
    if (S.dossier) {
      var d = S.dossier;
      var findings = (d.findings || []).map(function (ff) { var alta = ff.severity === "alta" || ff.severity === "critica"; return '<div class="check"><span class="sev ' + (alta ? "alta" : "ok") + '">' + esc((ff.severity || "").toUpperCase()) + "</span><strong>" + esc(ff.check) + "</strong></div>"; }).join("") || '<p class="muted">Nenhum achado no motor.</p>';
      res = '<div class="out"><div class="muted">Motor · SCAN_ONLY_NOT_A_PASSPORT</div><div class="num">Rating ' + esc((d.rating && d.rating.grade) || "-") + " · completude " + PCT.format(d.completude || 0) + '</div><div class="checks">' + findings + "</div></div>";
    }
    return '<div class="col"><div class="kicker"><i></i>PRIMEIRO O DOSSIE</div><h2>Organize e bata os dados do cliente</h2><p class="lead">XML e EFD o cliente le de verdade. CSV tambem. PDF e planilha binaria entram pelo tipo e pelo que aparecer em claro.</p><div class="fields"><div><label class="lbl" for="razao">Razao social</label><input id="razao" type="text" value="' + esc(S.razao) + '"></div><div><label class="lbl" for="cnpj">CNPJ</label><input id="cnpj" type="text" value="' + esc(S.cnpj) + '"></div><div><label class="lbl" for="ie">IE (SP)</label><input id="ie" type="text" value="' + esc(S.ie) + '"></div><div><label class="lbl" for="periodo">Competencia</label><input id="periodo" type="text" value="' + esc(S.periodo) + '"></div><div><label class="lbl" for="vn0">Valor do credito (R$)</label><input id="vn0" type="text" value="' + (S.vn ? S.vn.toLocaleString("pt-BR") : "") + '"></div></div><label class="drop" id="drop">Soltar EFD, XML, PDF, planilha ou CSV · <u>escolher</u><input id="pick" type="file" multiple accept=".xml,.txt,.pdf,.xlsx,.xls,.csv"></label><div class="mesa-grid"><div class="lista"><div class="n">ARQUIVOS</div>' + files + "</div>" + ficha + '</div><div class="card"><div class="n">BATE-VOLTA · ' + m.okCount + "/" + m.rows.length + '</div><div class="checks" style="margin-top:12px">' + checks + "</div></div>" + res + '<div class="row"><button class="btn btn-pri" id="doScan"' + (S.scanning || !canScan ? " disabled" : "") + ">" + (S.scanning ? "Batendo..." : "Bater com o motor") + '</button><button class="btn btn-sec" data-go="sim"' + (S.dossier ? "" : " disabled") + ">Ir ao simulador</button></div>" + (canScan ? "" : '<p class="muted">O motor so aceita scan com XML ou EFD em texto.</p>') + "</div>";
  }
  function sim() {
    if (!S.dossier) return '<div class="col"><div class="kicker"><i></i>CALCULADORA</div><h2>Simulador</h2><p class="lead">Primeiro bata o dossie.</p><div class="row"><button class="btn btn-pri" data-go="mesa">Abrir a mesa</button></div></div>';
    var fair = fv(), p = pv(), g = G[S.grade], d = S.vn ? 1 - fair / S.vn : 0, perda = S.vn ? 1 - p / S.vn : 0;
    var bars = [{ label: "Nominal", w: "100%", c: "#3B4763", pct: "100%" }, { label: "Com passaporte", w: Math.max(8, Math.round((1 - d) * 100)) + "%", c: "#E8B44A", pct: PCT.format(1 - d) }, { label: "LC 214", w: Math.max(8, Math.round((1 - perda) * 100)) + "%", c: "#E8735A", pct: PCT.format(1 - perda) }];
    return '<div class="col"><div class="kicker"><i></i>CALCULADORA DE VALOR DO CREDITO</div><h2>Quanto vale seu credito <em>hoje</em> — e em 2033?</h2><p class="lead">Valor e rating sairam do dossie. i e T sao do comprador.</p><div class="sim-grid"><div class="card sim-in"><label class="lbl">Valor nominal</label><div class="num" style="font-size:28px">' + BRL.format(S.vn) + '</div><label class="lbl">Rating do scan</label><div class="grades">' + ["A", "B", "C"].map(function (k) { return '<button class="' + (S.grade === k ? "on" : "") + '" disabled>' + k + " · " + PCT.format(G[k]) + "</button>"; }).join("") + '</div><p class="muted">Travado no motor.</p><div class="slider"><div class="row" style="justify-content:space-between"><label class="lbl" for="i">Custo de capital</label><span class="muted">' + String(S.i).replace(".", ",") + '% a.m.</span></div><input id="i" type="range" min="0.5" max="4" step="0.1" value="' + S.i + '"></div><div class="slider"><div class="row" style="justify-content:space-between"><label class="lbl" for="T">Tempo ate absorcao</label><span class="muted">' + S.T + ' meses</span></div><input id="T" type="range" min="3" max="48" step="1" value="' + S.T + '"></div></div><div class="sim-out"><div class="paper-out"><div class="muted" style="color:var(--paper-muted)">VALOR JUSTO HOJE</div><div class="num" style="color:var(--paper-ink);font-size:clamp(36px,6vw,56px)">' + BRL.format(fair) + '</div><div class="row"><span class="sev ok">d* = ' + PCT.format(d) + "</span></div></div><div class="card"><div class="n" style="color:var(--clay)">SE NAO HOMOLOGAR</div><div class="num" style="color:var(--clay)">' + BRL.format(p) + "</div>" + bars.map(function (b) { return '<div class="bar-row"><span>' + b.label + '</span><span class="bar"><i style="width:' + b.w + ";background:" + b.c + '"></i></span><span>' + b.pct + "</span></div>"; }).join("") + '<div class="row" style="margin-top:16px"><button class="btn btn-pri" data-go="emitir">Emitir passaporte</button></div></div></div></div></div>';
  }
  function emitir() {
    if (!S.dossier) return '<div class="col"><h2>Emitir</h2><p class="lead">Sem scan nao tem o que assinar.</p><div class="row"><button class="btn btn-pri" data-go="mesa">Voltar ao dossie</button></div></div>';
    var steps = ["Dados", "Documentos", "Checks"];
    var stepHtml = steps.map(function (l, i) { var n = i + 1; return '<button class="step' + (S.emitStep === n ? " on" : "") + '" data-step="' + n + '"><span class="chip">' + n + "</span>" + l + "</button>"; }).join("");
    var body = "";
    if (S.emitStep === 1) body = '<div class="fields">' + [["Razao", S.razao || "-"], ["CNPJ", S.cnpj || "-"], ["IE", S.ie || "-"], ["Competencia", S.periodo], ["Valor", S.vn ? BRL.format(S.vn) : "-"]].map(function (f) { return '<div class="field"><div class="k">' + esc(f[0]) + '</div><div class="v">' + esc(f[1]) + "</div></div>"; }).join("") + '</div><div class="row"><button class="btn btn-pri" data-step="2">Ver documentos</button></div>';
    else if (S.emitStep === 2) body = '<div class="docs">' + S.files.map(function (f) { return '<div class="doc"><strong>' + esc(f.name) + '</strong><span class="muted">' + esc(f.kind) + "</span></div>"; }).join("") + '</div><div class="row"><button class="btn btn-pri" data-step="3">Ver checks</button></div>';
    else { var findings = S.dossier.findings || []; body = '<div class="checks">' + (findings.length ? findings.map(function (c) { var alta = c.severity === "alta" || c.severity === "critica"; return '<div class="check"><span class="sev ' + (alta ? "alta" : "ok") + '">' + esc((c.severity || "").toUpperCase()) + "</span><strong>" + esc(c.check) + "</strong></div>"; }).join("") : '<div class="check"><span class="sev ok">OK</span><strong>Sem achados</strong></div>') + '</div><div class="row"><button class="btn btn-pri" data-go="pass">Assinar e emitir</button></div>'; }
    return '<div class="col"><h2>Emitir passaporte</h2><div class="steps">' + stepHtml + "</div>" + body + "</div>";
  }
  function pass() {
    var acts = S.bolsa === "nao" ? [["Registrar titulo na bolsa", "registrado", 1]] : S.bolsa === "registrado" ? [["Listar na vitrine", "venda", 1], ["Retirar registro", "nao", 0]] : [["Retirar da vitrine", "registrado", 0]];
    var label = { nao: "Nao registrado", registrado: "Registrado", venda: "A venda" }[S.bolsa];
    return '<div class="col"><h2>Passaporte emitido</h2><div class="paper"><div class="row" style="justify-content:space-between"><div><div class="muted" style="color:var(--paper-muted)">RATING ' + S.grade + '</div><h2 style="color:var(--paper-ink);margin-top:8px">' + esc(S.razao || "Titular") + '</h2><p class="muted" style="color:var(--paper-muted)">CAT 42/SP · ' + (S.vn ? BRL.format(S.vn) : "-") + '</p></div><div class="seal">ATESTO<br>NAO<br>HOMOLOGO</div></div></div><div class="card"><div class="n">BOLSA</div><h3>' + label + '</h3><div class="row">' + acts.map(function (a) { return '<button class="btn ' + (a[2] ? "btn-pri" : "btn-sec") + '" data-bolsa="' + a[1] + '">' + a[0] + "</button>"; }).join("") + "</div></div></div>";
  }
  function verif() {
    if (!S.verified) return '<div class="col"><h2>Verificar passaporte</h2><textarea id="payload" placeholder="psp_... ou JSON"></textarea><div class="row"><button class="btn btn-pri" id="doVerif">Verificar</button></div></div>';
    return '<div class="col"><h2>Assinatura valida</h2><div class="card"><h3>' + esc(S.razao || "Titulo") + "</h3><p>Rating " + S.grade + " · " + (S.vn ? BRL.format(S.vn) : "-") + '</p></div><div class="row"><button class="btn btn-sec" id="clearVerif">Limpar</button><button class="btn btn-pri" data-go="cart">Ver carteira</button></div></div>';
  }
  function cart() {
    if (!S.dossier) return '<div class="col"><h2>Carteira</h2><p class="lead">Vazia ate existir dossie.</p><div class="row"><button class="btn btn-pri" data-go="mesa">Abrir a mesa</button></div></div>';
    return '<div class="col"><h2>Carteira do comprador</h2><div class="doc"><span class="sev ok">' + S.grade + '</span><strong>' + esc(S.razao || "Dossie") + '</strong><span class="muted">' + BRL.format(S.vn) + '</span><span style="color:var(--amber)">' + BRL.format(fv()) + "</span></div></div>";
  }
  function render() { nav(); document.getElementById("app").innerHTML = { mesa: mesa, sim: sim, emitir: emitir, pass: pass, verif: verif, cart: cart }[S.view](); bind(); }
  function addFiles(list) {
    Array.from(list).forEach(function (file) {
      var rec = { name: file.name, size: file.size, kind: guessKind(file.name, ""), text: "", sha256: "", bytes: file.size, facts: null };
      var reader = new FileReader();
      reader.onload = function () {
        crypto.subtle.digest("SHA-256", reader.result).then(function (h) {
          rec.sha256 = hex(h);
          var isText = /\.(xml|txt|csv)$/i.test(file.name);
          var decoded = isText ? new TextDecoder("utf-8").decode(reader.result) : readable(reader.result);
          rec.kind = guessKind(file.name, decoded);
          rec.text = decoded && decoded.length > 20 ? decoded : (isText ? decoded : "");
          rec.facts = extractFacts(rec.kind, file.name, rec.text);
          S.files.push(rec); S.open = S.files.length - 1; S.dossier = null; applyIdentity(pool()); render();
        });
      };
      reader.readAsArrayBuffer(file);
    });
  }
  async function doScan() {
    S.scanErr = ""; S.scanning = true; render();
    var nfe = S.files.filter(function (f) { return f.kind === "nfe_xml" && f.text; }).map(function (f) { return f.text; });
    var efd = S.files.filter(function (f) { return f.kind === "efd_icms_ipi" && f.text; });
    var supporting = S.files.filter(function (f) { return f.kind !== "nfe_xml" && f.kind !== "efd_icms_ipi"; }).map(function (f) { var o = { kind: f.kind, name: f.name, sha256: f.sha256, bytes: f.bytes }; if (f.text && f.text.length < 200000) o.text = f.text; return o; });
    var body = { nfe_xml: nfe, params: { reference_period: { from: S.periodo + "-01", to: S.periodo + "-28" }, amount_cents: Math.round(S.vn * 100), state_registration: S.ie } };
    if (efd[0]) body.efd_text = efd[0].text; if (supporting.length) body.supporting_docs = supporting;
    try {
      var res = await fetch("/api/scan", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      var data = await res.json();
      if (!res.ok) { S.scanErr = (data.error && data.error.message) || "Scan recusado."; S.scanning = false; render(); return; }
      S.dossier = data.dossier; if (S.dossier && S.dossier.rating && S.dossier.rating.grade) S.grade = S.dossier.rating.grade; S.scanning = false; render();
    } catch (err) { S.scanErr = "Worker fora ou corpo grande demais (limite 2 MB)." ; S.scanning = false; render(); }
  }
  function bind() {
    document.querySelectorAll("[data-v]").forEach(function (a) { a.onclick = function (e) { e.preventDefault(); go(a.getAttribute("data-v"), a.getAttribute("data-v") === "emitir" ? { emitStep: 1 } : null); }; });
    document.querySelectorAll("[data-go]").forEach(function (b) { b.onclick = function () { if (b.disabled) return; go(b.getAttribute("data-go"), b.getAttribute("data-go") === "emitir" ? { emitStep: 1 } : null); }; });
    document.querySelectorAll("[data-step]").forEach(function (b) { b.onclick = function () { S.emitStep = Number(b.getAttribute("data-step")); render(); }; });
    document.querySelectorAll("[data-bolsa]").forEach(function (b) { b.onclick = function () { S.bolsa = b.getAttribute("data-bolsa"); render(); }; });
    document.querySelectorAll("[data-del]").forEach(function (b) { b.onclick = function () { S.files.splice(Number(b.getAttribute("data-del")), 1); S.open = Math.max(0, S.files.length - 1); S.dossier = null; render(); }; });
    document.querySelectorAll("[data-open]").forEach(function (b) { b.onclick = function () { S.open = Number(b.getAttribute("data-open")); render(); }; });
    document.querySelectorAll("[data-kind]").forEach(function (sel) { sel.onchange = function () { var i = Number(sel.getAttribute("data-kind")); S.files[i].kind = sel.value; S.files[i].facts = extractFacts(sel.value, S.files[i].name, S.files[i].text); S.dossier = null; render(); }; });
    ["razao", "cnpj", "ie", "periodo"].forEach(function (id) { var el = document.getElementById(id); if (el) el.onchange = function () { S[id] = el.value; render(); }; });
    var vn0 = document.getElementById("vn0"); if (vn0) vn0.onchange = function () { S.vn = Number(String(vn0.value).replace(/\D/g, "")) || 0; render(); };
    ["i", "T"].forEach(function (id) { var el = document.getElementById(id); if (!el) return; el.oninput = function () { S[id] = Number(el.value) || S[id]; render(); }; });
    var pick = document.getElementById("pick"); var drop = document.getElementById("drop");
    if (pick) pick.onchange = function () { addFiles(pick.files); };
    if (drop) { drop.ondragover = function (e) { e.preventDefault(); drop.classList.add("hot"); }; drop.ondragleave = function () { drop.classList.remove("hot"); }; drop.ondrop = function (e) { e.preventDefault(); drop.classList.remove("hot"); addFiles(e.dataTransfer.files); }; }
    var sc = document.getElementById("doScan"); if (sc) sc.onclick = function () { if (!sc.disabled) doScan(); };
    var dv = document.getElementById("doVerif"); if (dv) dv.onclick = function () { S.verified = true; render(); };
    var cv = document.getElementById("clearVerif"); if (cv) cv.onclick = function () { S.verified = false; render(); };
  }
  var hash = (location.hash || "#mesa").slice(1); if (CRUMB[hash]) S.view = hash; render();
})();
