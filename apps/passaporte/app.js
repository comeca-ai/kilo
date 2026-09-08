(function () {
  var G = { A: 0.01, B: 0.05, C: 0.12 };
  var NAV = [
    ["home", "·", "Visão geral"],
    ["sim", "1", "Simulador"],
    ["emitir", "2", "Emitir"],
    ["pass", "3", "Passaporte"],
    ["verif", "4", "Verificar"],
    ["cart", "5", "Carteira"]
  ];
  var CRUMB = { home: "VISÃO GERAL", sim: "SIMULADOR", emitir: "EMITIR", pass: "PASSAPORTE", verif: "VERIFICAR", cart: "CARTEIRA" };
  var S = { view: "sim", vn: 2500000, grade: "A", i: 1.5, T: 12, emitStep: 1, verified: false, bolsa: "nao" };
  var BRL = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
  var PCT = new Intl.NumberFormat("pt-BR", { style: "percent", minimumFractionDigits: 1, maximumFractionDigits: 1 });
  function fv() { return S.vn * (1 - G[S.grade]) / Math.pow(1 + S.i / 100, S.T); }
  function pv() { var i = S.i / 100; return i === 0 ? S.vn : (S.vn / 240) * (1 - Math.pow(1 + i, -240)) / i; }
  function go(v, extra) { S.view = v; if (extra) Object.assign(S, extra); render(); }
  document.getElementById("dias").textContent = String(Math.max(0, Math.ceil((Date.parse("2033-01-01") - Date.now()) / 86400000)));

  function nav() {
    document.getElementById("nav").innerHTML = NAV.map(function (it) {
      var on = S.view === it[0] ? " on" : "";
      return '<a href="#' + it[0] + '" class="' + on + '" data-v="' + it[0] + '"><span class="n">' + it[1] + "</span><span>" + it[2] + "</span></a>";
    }).join("");
    document.getElementById("crumb").textContent = CRUMB[S.view];
  }

  function home() {
    return '<div class="col">'
      + '<div class="kicker"><i></i>CRÉDITO DE ICMS ACUMULADO · MVP</div>'
      + '<h1>Seu crédito não vale menos.<br><em>Ele vale sem prova.</em></h1>'
      + '<p class="lead">O passaporte fiscal transforma um dossiê de ICMS acumulado em um objeto assinado e verificável. Homologação continua da SEFAZ.</p>'
      + '<div class="row"><button class="btn btn-pri" data-go="sim">Simular deságio</button><button class="btn btn-sec" data-go="emitir">Emitir passaporte</button></div>'
      + '<div class="cards">'
      + '<div class="card"><div class="n">01</div><h3>Prepara e atesta</h3><p>Checks do ruleset da rota. Homologação é da SEFAZ — nunca da plataforma.</p></div>'
      + '<div class="card"><div class="n">02</div><h3>Assina em Ed25519</h3><p>Payload canônico com hash de input, output e evidências.</p></div>'
      + '<div class="card"><div class="n">03</div><h3>Registra na bolsa</h3><p>Mural público anti-dupla-venda. Registro não é transferência fiscal.</p></div>'
      + "</div></div>";
  }

  function sim() {
    var fair = fv(), p = pv(), g = G[S.grade];
    return '<div class="col"><h2>Simulador de deságio</h2>'
      + '<p class="lead">Ajuste valor, rating, taxa e prazo. Heurística, não parecer.</p>'
      + '<div><label class="lbl" for="vn">Valor nominal (R$)</label><input id="vn" type="text" value="' + S.vn.toLocaleString("pt-BR") + '"></div>'
      + '<div><label class="lbl">Rating estimado</label><div class="grades">'
      + ["A","B","C"].map(function (k) { return '<button data-g="' + k + '" class="' + (S.grade===k?"on":"") + '">' + k + " · " + Math.round(G[k]*100) + "%</button>"; }).join("")
      + "</div></div>"
      + '<div class="fields"><div><label class="lbl" for="i">Taxa mensal i (%)</label><input id="i" type="number" min="0.5" max="4" step="0.1" value="' + S.i + '"></div>'
      + '<div><label class="lbl" for="T">Prazo T (meses)</label><input id="T" type="number" min="3" max="48" value="' + S.T + '"></div></div>'
      + '<div class="out"><div class="muted">Com dossiê atestado · valor justo hoje</div><div class="num">' + BRL.format(fair) + " · " + PCT.format(1-fair/S.vn) + "</div>"
      + '<div class="muted">Sem homologar até 2033 · PV de 240 parcelas</div><div class="num" style="color:var(--clay)">' + BRL.format(p) + " · perda " + PCT.format(1-p/S.vn) + "</div>"
      + '<p class="muted">Glosa ' + BRL.format(S.vn*g) + " · diferença preservável " + BRL.format(Math.max(0, fair-p)) + "</p>"
      + '<div class="muted">Nominal</div><div class="bar"><i style="width:100%;background:#3B4763"></i></div>'
      + '<div class="muted">Com passaporte</div><div class="bar"><i style="width:' + (fair/S.vn*100) + '%;background:var(--amber)"></i></div>'
      + '<div class="muted">Sem homologar</div><div class="bar"><i style="width:' + (p/S.vn*100) + '%;background:var(--clay)"></i></div>'
      + '<div class="row" style="margin-top:8px"><button class="btn btn-pri" data-go="emitir">Emitir com estes números</button></div></div></div>';
  }

  function emitir() {
    var steps = ["Dados do estabelecimento","Documentos exigidos","Checks e rating"];
    var stepHtml = steps.map(function (l, i) {
      var n = i+1;
      return '<button class="step' + (S.emitStep===n ? " on" : "") + '" data-step="' + n + '"><span class="chip">' + (S.emitStep>n?"\u2713":n) + "</span>" + l + "</button>";
    }).join("");
    var body = "";
    if (S.emitStep===1) {
      body = '<div class="fields">' + [["Razão social","Metalúrgica Horizonte S.A."],["CNPJ","12.345.678/0001-90"],["IE (SP)","110.042.490.114"],["Competência","2026-02"],["Valor",BRL.format(S.vn)],["Tipo","ICMS_ACCUMULATED"]].map(function (f) {
        return '<div class="field"><div class="k">' + f[0] + '</div><div class="v">' + f[1] + "</div></div>";
      }).join("") + '</div><div class="row"><button class="btn btn-pri" data-step="2">Continuar para documentos</button></div>';
    } else if (S.emitStep===2) {
      body = '<div class="docs">' + [["EFD ICMS/IPI","competência 2026-08","3.2 MB"],["NF-e XML (3)","layout 4.00","186 KB"],["Livro de apuração","SP-ART84","740 KB"],["Demonstrativo de saldo","saldo até 2026-02","112 KB"]].map(function (d) {
        return '<div class="doc"><strong style="flex:1 1 180px">' + d[0] + '</strong><span class="muted">' + d[1] + '</span><span class="muted">' + d[2] + "</span></div>";
      }).join("") + '</div><div class="row"><button class="btn btn-pri" data-step="3">Rodar checks</button></div>';
    } else {
      body = '<p class="muted">Rating nesta tela é estimativa. O grau definitivo sai do ruleset na assinatura.</p><div class="checks">' + [["DOC-COMPLETE","Documentos exigidos presentes","OK"],["PERIODO-COERENTE","Competência do EFD divergente","ALTA"],["VALOR-POSITIVO","Valor positivo em centavos","OK"],["IE-PRESENTE","IE informada","OK"]].map(function (c) {
        return '<div class="check"><span class="sev ' + (c[2]==="OK"?"ok":"alta") + '">' + c[2] + '</span><strong>' + c[0] + '</strong><span class="muted">' + c[1] + "</span></div>";
      }).join("") + '</div><div class="row"><button class="btn btn-pri" data-go="pass">Assinar e emitir</button></div>';
    }
    return '<div class="col"><h2>Emitir passaporte</h2><div class="steps">' + stepHtml + "</div>" + body + "</div>";
  }

  function pass() {
    var g = G[S.grade];
    var acts = S.bolsa==="nao" ? [["Registrar título na bolsa","registrado",1],["Consultar","nao",0]] : S.bolsa==="registrado" ? [["Listar na vitrine","venda",1],["Retirar registro","nao",0]] : [["Retirar da vitrine","registrado",0]];
    var label = { nao:"Não registrado", registrado:"Registrado", venda:"À venda" }[S.bolsa];
    return '<div class="col"><h2>Passaporte emitido</h2><div class="paper"><div class="row" style="justify-content:space-between"><div><div class="muted" style="color:var(--paper-muted)">PSP_4A783B5E29B0 · RATING ' + S.grade + '</div><h2 style="color:var(--paper-ink);margin-top:8px">Metalúrgica Horizonte S.A.</h2><p class="muted" style="color:var(--paper-muted)">CAT 42/SP · ' + BRL.format(S.vn) + '</p></div><div class="seal">ATESTO<br>NÃO<br>HOMOLOGO</div></div><div class="fields" style="margin-top:22px">' + [["CNPJ","12.345.678/0001-90"],["IE","110.042.490.114"],["Competência","2026-02"],["Glosa",PCT.format(g)],["Claim","DOCUMENTED_FOR_REVIEW"],["Validade","08/10/2026"]].map(function (f) {
      return '<div class="field" style="background:#efe8d6;border-color:#ddd2b8"><div class="k">' + f[0] + '</div><div class="v">' + f[1] + "</div></div>";
    }).join("") + '</div></div><div class="card"><div class="n">BOLSA DE REGISTRO</div><h3>Situação: ' + label + '</h3><p>Registro na bolsa não é transferência fiscal.</p><div class="row" style="margin-top:12px">' + acts.map(function (a) {
      return '<button class="btn ' + (a[2]?"btn-pri":"btn-sec") + '" data-bolsa="' + a[1] + '">' + a[0] + "</button>";
    }).join("") + "</div></div></div>";
  }

  function verif() {
    if (!S.verified) {
      return '<div class="col"><h2>Verificar passaporte</h2><p class="lead">Cole o JSON assinado ou o passport_id.</p><textarea id="payload" placeholder="psp_... ou JSON"></textarea><div class="row"><button class="btn btn-pri" id="doVerif">Verificar</button></div></div>';
    }
    return '<div class="col"><h2>Assinatura válida</h2><div class="card"><div class="n">VERIFY · ED25519</div><h3>psp_4a783b5e29b0</h3><p>Titular Metalúrgica Horizonte S.A. · rating ' + S.grade + ' · ' + BRL.format(S.vn) + '</p><p class="muted">Registro na bolsa não é transferência fiscal.</p></div><div class="row"><button class="btn btn-sec" id="clearVerif">Limpar</button><button class="btn btn-pri" data-go="cart">Ver carteira</button></div></div>';
  }

  function cart() {
    var i = S.i / 100;
    var rows = [
      { g: "A", nome: "Metalúrgica Horizonte S.A.", id: "psp_4a783b5e29b0", vn: 2500000, gl: 0.01 },
      { g: "B", nome: "Têxtil Paraíso Ltda.", id: "psp_9c11e4d7a3f2", vn: 880000, gl: 0.05 },
      { g: "C", nome: "Agroquímica Vale Verde S.A.", id: "psp_1f08b2c6e910", vn: 4120000, gl: 0.12 }
    ].map(function (r) { r.fj = r.vn * (1-r.gl) / Math.pow(1+i, S.T); return r; });
    var tN = rows.reduce(function (a,r){return a+r.vn;},0);
    var tJ = rows.reduce(function (a,r){return a+r.fj;},0);
    return '<div class="col"><h2>Carteira do comprador</h2><p class="lead">fv e d* saem no cliente com i e T do comprador.</p><div class="fields"><div><label class="lbl" for="i2">i % ao mês</label><input id="i2" type="number" min="0.5" max="4" step="0.1" value="' + S.i + '"></div><div><label class="lbl" for="T2">T meses</label><input id="T2" type="number" min="3" max="48" value="' + S.T + '"></div></div><div class="docs">' + rows.map(function (r) {
      return '<div class="doc"><span class="sev ' + (r.g==="C"?"":"ok") + '">' + r.g + '</span><strong style="flex:1 1 180px">' + r.nome + '</strong><span class="muted">' + BRL.format(r.vn) + '</span><span style="color:var(--amber)">' + BRL.format(r.fj) + '</span><span class="muted">d* ' + PCT.format(1-r.fj/r.vn) + "</span></div>";
    }).join("") + '</div><div class="card"><strong>Total · ' + rows.length + " títulos</strong> · " + BRL.format(tN) + " → " + BRL.format(tJ) + " · d* " + PCT.format(1-tJ/tN) + "</div></div>";
  }

  function render() {
    nav();
    var html = { home: home, sim: sim, emitir: emitir, pass: pass, verif: verif, cart: cart }[S.view]();
    document.getElementById("app").innerHTML = html;
    bind();
  }

  function bind() {
    document.querySelectorAll("[data-v]").forEach(function (a) {
      a.onclick = function (e) { e.preventDefault(); go(a.getAttribute("data-v"), a.getAttribute("data-v")==="emitir" ? { emitStep: 1 } : null); };
    });
    document.querySelectorAll("[data-go]").forEach(function (b) {
      b.onclick = function () { go(b.getAttribute("data-go"), b.getAttribute("data-go")==="emitir" ? { emitStep: 1 } : null); };
    });
    document.querySelectorAll("[data-g]").forEach(function (b) {
      b.onclick = function () { S.grade = b.getAttribute("data-g"); render(); };
    });
    document.querySelectorAll("[data-step]").forEach(function (b) {
      b.onclick = function () { S.emitStep = Number(b.getAttribute("data-step")); render(); };
    });
    document.querySelectorAll("[data-bolsa]").forEach(function (b) {
      b.onclick = function () { S.bolsa = b.getAttribute("data-bolsa"); render(); };
    });
    var vn = document.getElementById("vn");
    if (vn) vn.oninput = function () { S.vn = Number(String(vn.value).replace(/\D/g, "")) || 0; };
    if (vn) vn.onchange = function () { render(); };
    ["i","T","i2","T2"].forEach(function (id) {
      var el = document.getElementById(id);
      if (!el) return;
      el.onchange = function () {
        if (id === "i" || id === "i2") S.i = Number(el.value) || S.i;
        else S.T = Number(el.value) || S.T;
        render();
      };
    });
    var dv = document.getElementById("doVerif");
    if (dv) dv.onclick = function () { S.verified = true; render(); };
    var cv = document.getElementById("clearVerif");
    if (cv) cv.onclick = function () { S.verified = false; render(); };
  }

  var hash = (location.hash || "#sim").slice(1);
  if (CRUMB[hash]) S.view = hash;
  render();
})();
