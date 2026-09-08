(function () {
  var G = { A: 0.01, B: 0.05, C: 0.12 };
  var NEED = [
    { kind: "efd_icms_ipi", label: "EFD ICMS/IPI" },
    { kind: "nfe_xml", label: "NF-e XML" },
    { kind: "apuracao", label: "Apuração / balanço / planilha" },
    { kind: "livro_registro", label: "Livro de registro" }
  ];
  var NAV = [
    ["mesa", "1", "Dossiê"],
    ["sim", "2", "Simulador"],
    ["emitir", "3", "Emitir"],
    ["pass", "4", "Passaporte"],
    ["verif", "5", "Verificar"],
    ["cart", "6", "Carteira"]
  ];
  var CRUMB = { mesa: "DOSSIÊ", sim: "SIMULADOR", emitir: "EMITIR", pass: "PASSAPORTE", verif: "VERIFICAR", cart: "CARTEIRA" };
  var S = { view: "mesa", vn: 0, grade: "C", i: 1.5, T: 12, emitStep: 1, verified: false, bolsa: "nao", razao: "", cnpj: "", ie: "", periodo: "2026-02", files: [], dossier: null, scanErr: "", scanning: false };
  var BRL = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
  var PCT = new Intl.NumberFormat("pt-BR", { style: "percent", minimumFractionDigits: 1, maximumFractionDigits: 1 });
  function fv() { if (!S.vn) return 0; return S.vn * (1 - G[S.grade]) / Math.pow(1 + S.i / 100, S.T); }
  function pv() { if (!S.vn) return 0; var i = S.i / 100; return i === 0 ? S.vn : (S.vn / 240) * (1 - Math.pow(1 + i, -240)) / i; }
  function go(v, extra) { S.view = v; if (extra) Object.assign(S, extra); render(); }
  document.getElementById("dias").textContent = String(Math.max(0, Math.ceil((Date.parse("2033-01-01") - Date.now()) / 86400000)));
  function guessKind(name) {
    var n = name.toLowerCase();
    if (n.endsWith(".xml")) return "nfe_xml";
    if (n.endsWith(".txt") || n.indexOf("efd") >= 0 || n.indexOf("sped") >= 0) return "efd_icms_ipi";
    if (n.indexOf("livro") >= 0 || n.indexOf("registro") >= 0) return "livro_registro";
    return "apuracao";
  }
  function hex(buf) { return Array.from(new Uint8Array(buf)).map(function (b) { return b.toString(16).padStart(2, "0"); }).join(""); }
  function hasKind(k) { return S.files.some(function (f) { return f.kind === k; }); }
  function missing() { return NEED.filter(function (d) { return !hasKind(d.kind); }); }
  function nav() {
    document.getElementById("nav").innerHTML = NAV.map(function (it) {
      var on = S.view === it[0] ? " on" : "";
      return '<a href="#' + it[0] + '" class="' + on + '" data-v="' + it[0] + '"><span class="n">' + it[1] + "</span><span>" + it[2] + "</span></a>";
    }).join("");
    document.getElementById("crumb").textContent = CRUMB[S.view] || "";
  }
  function mesa() {
    var miss = missing();
    var files = S.files.length
      ? '<div class="docs">' + S.files.map(function (f, i) {
          return '<div class="doc"><strong style="flex:1 1 160px">' + f.name + "</strong>"
            + '<select data-kind="' + i + '">' + NEED.map(function (d) {
              return '<option value="' + d.kind + '"' + (f.kind === d.kind ? " selected" : "") + ">" + d.label + "</option>";
            }).join("") + "</select>"
            + '<span class="muted">' + (f.size / 1024).toFixed(1) + " KB</span>"
            + '<span class="muted">' + (f.parseable ? "parseia" : "só hash") + "</span>"
            + '<button class="btn btn-sec" data-del="' + i + '">Tirar</button></div>';
        }).join("") + "</div>"
      : '<p class="muted">Nada na mesa. Solte EFD (.txt), NF-e (.xml), balanço/planilha (.pdf .xlsx .csv) e livro de registro.</p>';
    var checks = NEED.map(function (d) {
      var ok = hasKind(d.kind);
      return '<div class="check"><span class="sev ' + (ok ? "ok" : "alta") + '">' + (ok ? "OK" : "FALTA") + "</span><strong>" + d.label + "</strong></div>";
    }).join("");
    var res = "";
    if (S.scanErr) res = '<div class="card"><p class="muted">' + S.scanErr + "</p></div>";
    if (S.dossier) {
      var d = S.dossier;
      var findings = (d.findings || []).map(function (f) {
        var alta = f.severity === "alta" || f.severity === "critica";
        return '<div class="check"><span class="sev ' + (alta ? "alta" : "ok") + '">' + (f.severity || "").toUpperCase() + "</span><strong>" + f.check + "</strong></div>";
      }).join("") || '<p class="muted">Nenhum achado.</p>';
      res = '<div class="out"><div class="muted">Motor · SCAN_ONLY_NOT_A_PASSPORT</div>'
        + '<div class="num">Rating ' + (d.rating && d.rating.grade || "—") + " · completude " + PCT.format(d.completude || 0) + "</div>"
        + '<p class="muted">NF-e ' + ((d.parsed_resumo && d.parsed_resumo.qtd_nfe) || 0) + " · C100 " + ((d.parsed_resumo && d.parsed_resumo.qtd_c100) || 0)
        + (d.parsed_resumo && d.parsed_resumo.periodo_efd ? " · EFD " + d.parsed_resumo.periodo_efd.dt_ini + " → " + d.parsed_resumo.periodo_efd.dt_fin : "")
        + '</p><div class="checks">' + findings + "</div>"
        + '<p class="muted">PDF e planilha não são parseados — entram na completude pelo tipo.</p></div>';
    }
    return '<div class="col"><div class="kicker"><i></i>PRIMEIRO O DOSSIÊ</div><h2>Organize e bata os dados do cliente</h2>'
      + '<p class="lead">Planilha, PDF, balanço, EFD e XML na mesma mesa. Homologação continua da SEFAZ.</p>'
      + '<div class="fields">'
      + '<div><label class="lbl" for="razao">Razão social</label><input id="razao" type="text" value="' + S.razao + '"></div>'
      + '<div><label class="lbl" for="cnpj">CNPJ</label><input id="cnpj" type="text" value="' + S.cnpj + '"></div>'
      + '<div><label class="lbl" for="ie">IE (SP)</label><input id="ie" type="text" value="' + S.ie + '"></div>'
      + '<div><label class="lbl" for="periodo">Competência</label><input id="periodo" type="text" value="' + S.periodo + '"></div>'
      + '<div><label class="lbl" for="vn0">Valor do crédito (R$)</label><input id="vn0" type="text" value="' + (S.vn ? S.vn.toLocaleString("pt-BR") : "") + '"></div></div>'
      + '<label class="drop" id="drop">Soltar arquivos aqui ou <u>escolher</u><input id="pick" type="file" multiple accept=".xml,.txt,.pdf,.xlsx,.xls,.csv"></label>'
      + files
      + '<div class="card"><div class="n">O QUE O RULESET PEDE</div><div class="checks" style="margin-top:10px">' + checks + "</div>"
      + (miss.length ? '<p class="muted" style="margin-top:10px">Falta: ' + miss.map(function (m) { return m.label; }).join(", ") + "</p>" : '<p class="muted" style="margin-top:10px">Pacote mínimo na mesa.</p>')
      + "</div>" + res
      + '<div class="row"><button class="btn btn-pri" id="doScan">' + (S.scanning ? "Batendo…" : "Bater com o motor") + "</button>"
      + '<button class="btn btn-sec" data-go="sim">Ir ao simulador</button></div></div>';
  }
  function sim() {
    if (!S.dossier) {
      return '<div class="col"><h2>Simulador</h2><p class="lead">Primeiro bata o dossiê. Sem documento o número é chute.</p><div class="row"><button class="btn btn-pri" data-go="mesa">Abrir a mesa</button></div></div>';
    }
    var fair = fv(), p = pv(), g = G[S.grade];
    return '<div class="col"><h2>Simulador de deságio</h2><p class="lead">Valor e rating vêm do dossiê. i e T são do comprador.</p>'
      + '<div class="fields"><div><label class="lbl">Valor nominal</label><div class="num" style="font-size:28px">' + BRL.format(S.vn) + '</div></div><div><label class="lbl">Rating do scan</label><div class="num" style="font-size:28px">' + S.grade + " · g " + PCT.format(g) + '</div></div></div>'
      + '<div class="fields"><div><label class="lbl" for="i">Taxa mensal i (%)</label><input id="i" type="number" min="0.5" max="4" step="0.1" value="' + S.i + '"></div>'
      + '<div><label class="lbl" for="T">Prazo T (meses)</label><input id="T" type="number" min="3" max="48" value="' + S.T + '"></div></div>'
      + '<div class="out"><div class="muted">Com dossiê atestado · valor justo hoje</div><div class="num">' + BRL.format(fair) + " · " + PCT.format(S.vn ? 1 - fair / S.vn : 0) + '</div>'
      + '<div class="muted">Sem homologar até 2033 · PV de 240 parcelas</div><div class="num" style="color:var(--clay)">' + BRL.format(p) + '</div>'
      + '<p class="muted">Heurística. Não é homologação.</p><div class="row"><button class="btn btn-pri" data-go="emitir">Emitir</button></div></div></div>';
  }
  function emitir() {
    if (!S.dossier) {
      return '<div class="col"><h2>Emitir</h2><p class="lead">Sem scan não tem o que assinar.</p><div class="row"><button class="btn btn-pri" data-go="mesa">Voltar ao dossiê</button></div></div>';
    }
    var steps = ["Dados do estabelecimento", "Documentos da mesa", "Checks do motor"];
    var stepHtml = steps.map(function (l, i) {
      var n = i + 1;
      return '<button class="step' + (S.emitStep === n ? " on" : "") + '" data-step="' + n + '"><span class="chip">' + (S.emitStep > n ? "\u2713" : n) + "</span>" + l + "</button>";
    }).join("");
    var body = "";
    if (S.emitStep === 1) {
      body = '<div class="fields">' + [["Razão social", S.razao || "\u2014"], ["CNPJ", S.cnpj || "\u2014"], ["IE (SP)", S.ie || "\u2014"], ["Competência", S.periodo], ["Valor", S.vn ? BRL.format(S.vn) : "\u2014"]].map(function (f) {
        return '<div class="field"><div class="k">' + f[0] + '</div><div class="v">' + f[1] + "</div></div>";
      }).join("") + '</div><div class="row"><button class="btn btn-pri" data-step="2">Ver documentos</button></div>';
    } else if (S.emitStep === 2) {
      body = '<div class="docs">' + S.files.map(function (f) {
        return '<div class="doc"><strong style="flex:1 1 180px">' + f.name + '</strong><span class="muted">' + f.kind + "</span></div>";
      }).join("") + '</div><div class="row"><button class="btn btn-pri" data-step="3">Ver checks</button></div>';
    } else {
      var findings = S.dossier.findings || [];
      body = '<p class="muted">Rating ' + S.grade + " saiu do scan. Alta gravidade aparece antes da assinatura.</p>"
        + '<div class="checks">' + (findings.length ? findings.map(function (c) {
          var alta = c.severity === "alta" || c.severity === "critica";
          return '<div class="check"><span class="sev ' + (alta ? "alta" : "ok") + '">' + (c.severity || "").toUpperCase() + '</span><strong>' + c.check + "</strong></div>";
        }).join("") : '<div class="check"><span class="sev ok">OK</span><strong>Sem achados no scan</strong></div>') + "</div>"
        + '<div class="row"><button class="btn btn-pri" data-go="pass">Assinar e emitir</button></div>';
    }
    return '<div class="col"><h2>Emitir passaporte</h2><div class="steps">' + stepHtml + "</div>" + body + "</div>";
  }
  function pass() {
    var acts = S.bolsa === "nao" ? [["Registrar título na bolsa", "registrado", 1]] : S.bolsa === "registrado" ? [["Listar na vitrine", "venda", 1], ["Retirar registro", "nao", 0]] : [["Retirar da vitrine", "registrado", 0]];
    var label = { nao: "Não registrado", registrado: "Registrado", venda: "À venda" }[S.bolsa];
    return '<div class="col"><h2>Passaporte emitido</h2><div class="paper"><div class="row" style="justify-content:space-between"><div><div class="muted" style="color:var(--paper-muted)">RATING ' + S.grade + '</div><h2 style="color:var(--paper-ink);margin-top:8px">' + (S.razao || "Titular do dossiê") + '</h2><p class="muted" style="color:var(--paper-muted)">CAT 42/SP · ' + (S.vn ? BRL.format(S.vn) : "sem valor") + '</p></div><div class="seal">ATESTO<br>NÃO<br>HOMOLOGO</div></div></div>'
      + '<div class="card"><div class="n">BOLSA DE REGISTRO</div><h3>Situação: ' + label + '</h3><p>Registro na bolsa não é transferência fiscal.</p><div class="row" style="margin-top:12px">' + acts.map(function (a) {
        return '<button class="btn ' + (a[2] ? "btn-pri" : "btn-sec") + '" data-bolsa="' + a[1] + '">' + a[0] + "</button>";
      }).join("") + "</div></div></div>";
  }
  function verif() {
    if (!S.verified) {
      return '<div class="col"><h2>Verificar passaporte</h2><p class="lead">Cole o JSON assinado ou o passport_id.</p><textarea id="payload" placeholder="psp_ ou JSON"></textarea><div class="row"><button class="btn btn-pri" id="doVerif">Verificar</button></div></div>';
    }
    return '<div class="col"><h2>Assinatura válida</h2><div class="card"><div class="n">VERIFY</div><h3>' + (S.razao || "Título") + '</h3><p>Rating ' + S.grade + " · " + (S.vn ? BRL.format(S.vn) : "—") + '</p></div><div class="row"><button class="btn btn-sec" id="clearVerif">Limpar</button><button class="btn btn-pri" data-go="cart">Ver carteira</button></div></div>';
  }
  function cart() {
    if (!S.dossier) {
      return '<div class="col"><h2>Carteira</h2><p class="lead">Vazia até existir dossiê.</p><div class="row"><button class="btn btn-pri" data-go="mesa">Abrir a mesa</button></div></div>';
    }
    var fj = S.vn * (1 - G[S.grade]) / Math.pow(1 + S.i / 100, S.T);
    return '<div class="col"><h2>Carteira do comprador</h2><div class="doc"><span class="sev ok">' + S.grade + '</span><strong style="flex:1 1 180px">' + (S.razao || "Dossiê atual") + '</strong><span class="muted">' + BRL.format(S.vn) + '</span><span style="color:var(--amber)">' + BRL.format(fj) + "</span></div></div>";
  }
  function render() {
    nav();
    var html = { mesa: mesa, sim: sim, emitir: emitir, pass: pass, verif: verif, cart: cart }[S.view]();
    document.getElementById("app").innerHTML = html;
    bind();
  }
  function addFiles(list) {
    Array.from(list).forEach(function (file) {
      var rec = { name: file.name, size: file.size, kind: guessKind(file.name), parseable: false, text: "", sha256: "", bytes: file.size };
      var reader = new FileReader();
      var isText = /\.(xml|txt|csv)$/i.test(file.name);
      rec.parseable = isText && (rec.kind === "nfe_xml" || rec.kind === "efd_icms_ipi");
      reader.onload = function () {
        crypto.subtle.digest("SHA-256", reader.result).then(function (h) {
          rec.sha256 = hex(h);
          if (isText) rec.text = new TextDecoder("utf-8").decode(reader.result);
          S.files.push(rec);
          S.dossier = null;
          render();
        });
      };
      reader.readAsArrayBuffer(file);
    });
  }
  async function doScan() {
    S.scanErr = "";
    S.scanning = true;
    render();
    var nfe = S.files.filter(function (f) { return f.kind === "nfe_xml" && f.text; }).map(function (f) { return f.text; });
    var efd = S.files.filter(function (f) { return f.kind === "efd_icms_ipi" && f.text; });
    var supporting = S.files.filter(function (f) { return f.kind !== "nfe_xml" && f.kind !== "efd_icms_ipi"; }).map(function (f) {
      var o = { kind: f.kind, name: f.name, sha256: f.sha256, bytes: f.bytes };
      if (f.text) o.text = f.text;
      return o;
    });
    var body = { nfe_xml: nfe, params: { reference_period: { from: S.periodo + "-01", to: S.periodo + "-28" }, amount_cents: Math.round(S.vn * 100), state_registration: S.ie } };
    if (efd[0]) body.efd_text = efd[0].text;
    if (supporting.length) body.supporting_docs = supporting;
    try {
      var res = await fetch("/api/scan", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      var data = await res.json();
      if (!res.ok) { S.scanErr = (data.error && data.error.message) || "Scan recusado."; S.scanning = false; render(); return; }
      S.dossier = data.dossier;
      if (S.dossier && S.dossier.rating && S.dossier.rating.grade) S.grade = S.dossier.rating.grade;
      S.scanning = false;
      render();
    } catch (err) {
      S.scanErr = "Worker fora ou corpo grande demais (limite 2 MB no /api/scan).";
      S.scanning = false;
      render();
    }
  }
  function bind() {
    document.querySelectorAll("[data-v]").forEach(function (a) {
      a.onclick = function (e) { e.preventDefault(); go(a.getAttribute("data-v"), a.getAttribute("data-v") === "emitir" ? { emitStep: 1 } : null); };
    });
    document.querySelectorAll("[data-go]").forEach(function (b) {
      b.onclick = function () { go(b.getAttribute("data-go"), b.getAttribute("data-go") === "emitir" ? { emitStep: 1 } : null); };
    });
    document.querySelectorAll("[data-step]").forEach(function (b) {
      b.onclick = function () { S.emitStep = Number(b.getAttribute("data-step")); render(); };
    });
    document.querySelectorAll("[data-bolsa]").forEach(function (b) {
      b.onclick = function () { S.bolsa = b.getAttribute("data-bolsa"); render(); };
    });
    document.querySelectorAll("[data-del]").forEach(function (b) {
      b.onclick = function () { S.files.splice(Number(b.getAttribute("data-del")), 1); S.dossier = null; render(); };
    });
    document.querySelectorAll("[data-kind]").forEach(function (sel) {
      sel.onchange = function () {
        var i = Number(sel.getAttribute("data-kind"));
        S.files[i].kind = sel.value;
        S.files[i].parseable = (sel.value === "nfe_xml" || sel.value === "efd_icms_ipi") && !!S.files[i].text;
        S.dossier = null;
        render();
      };
    });
    ["razao", "cnpj", "ie", "periodo"].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.onchange = function () { S[id] = el.value; };
    });
    var vn0 = document.getElementById("vn0");
    if (vn0) vn0.onchange = function () { S.vn = Number(String(vn0.value).replace(/\D/g, "")) || 0; render(); };
    ["i", "T"].forEach(function (id) {
      var el = document.getElementById(id);
      if (!el) return;
      el.onchange = function () { S[id] = Number(el.value) || S[id]; render(); };
    });
    var pick = document.getElementById("pick");
    var drop = document.getElementById("drop");
    if (pick) pick.onchange = function () { addFiles(pick.files); };
    if (drop) {
      drop.ondragover = function (e) { e.preventDefault(); };
      drop.ondrop = function (e) { e.preventDefault(); addFiles(e.dataTransfer.files); };
    }
    var sc = document.getElementById("doScan");
    if (sc) sc.onclick = function () { doScan(); };
    var dv = document.getElementById("doVerif");
    if (dv) dv.onclick = function () { S.verified = true; render(); };
    var cv = document.getElementById("clearVerif");
    if (cv) cv.onclick = function () { S.verified = false; render(); };
  }
  var hash = (location.hash || "#mesa").slice(1);
  if (CRUMB[hash]) S.view = hash;
  render();
})();
