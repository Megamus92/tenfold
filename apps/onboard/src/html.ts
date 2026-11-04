/**
 * The onboarding page: one self-contained HTML document (inline CSS and JS, system font, dark background, yellow
 * accent, no frameworks, no external assets). The server renders it once at startup with the defaults and fee
 * terms embedded as JSON; everything else happens in the browser against /api/*.
 */

export interface PageOptions {
  fees: { volumeBps: number; cashoutBps: number; referralBps: number; discountBps: number };
  rules: { dailySellCapPct: number; defenseBudgetSol: number; maxDefenseSpendPerDaySol: number; withdrawalDelayHours: 24 | 48; maxSlippageBps: number };
  strategy: {
    distribution: { pctOfVaultPerDay: number; mode: "strength" | "twap" };
    rebalance: { targetSolShare: number; band: number };
    clip: { minSol: number; maxSol: number };
  };
  proofBaseUrl: string;
  /** False when the server has no keystore password: the page says so up front instead of failing at the end. */
  walletsEnabled: boolean;
}

const CSS = `
:root{--bg:#0b0b0d;--panel:#141418;--panel2:#1b1b21;--line:#2a2a31;--text:#e8e8ea;--muted:#9a9aa3;--accent:#f5c518;--accent-ink:#161200;--bad:#ff6b6b;--good:#5ad38a}
*{box-sizing:border-box}
html,body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;-webkit-text-size-adjust:100%}
main{max-width:720px;margin:0 auto;padding:28px 16px 64px}
a{color:var(--accent)}
h1{font-size:22px;margin:0 0 4px;letter-spacing:.2px}
h2{font-size:18px;margin:0 0 14px}
h3{font-size:14px;margin:22px 0 8px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em}
p{margin:0 0 12px}
.sub{color:var(--muted);margin-bottom:20px}
.brand{display:flex;align-items:center;gap:10px;margin-bottom:18px}
.bolt{width:28px;height:28px;border-radius:7px;background:var(--accent);display:grid;place-items:center;color:var(--accent-ink);font-weight:800}
.steps{display:flex;gap:6px;list-style:none;padding:0;margin:0 0 22px}
.steps li{flex:1;text-align:center;font-size:12px;color:var(--muted);padding:8px 4px;border-top:3px solid var(--line)}
.steps li.on{color:var(--text);border-top-color:var(--accent)}
.steps li.done{border-top-color:#7a6410}
.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:18px}
.step{display:none}.step.on{display:block}
label{display:block;font-size:13px;color:var(--muted);margin:12px 0 4px}
label b{color:var(--text);font-weight:600}
input[type=text],input[type=number],select,textarea{width:100%;font:inherit;font-size:16px;color:var(--text);background:var(--panel2);border:1px solid var(--line);border-radius:8px;padding:10px 12px;outline:none}
input:focus,select:focus,textarea:focus{border-color:var(--accent)}
input:disabled,select:disabled{opacity:.45}
textarea{min-height:64px;resize:vertical}
.hint{font-size:12px;color:var(--muted);margin-top:4px}
.hint.bad{color:var(--bad)}.hint.good{color:var(--good)}
.row{display:grid;grid-template-columns:1fr 1fr;gap:0 14px}
.row3{display:grid;grid-template-columns:1fr 1fr auto;gap:8px;align-items:end;margin-top:8px}
@media (max-width:520px){.row{grid-template-columns:1fr}}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;font:inherit;font-weight:600;font-size:15px;border-radius:9px;padding:11px 16px;cursor:pointer;border:1px solid var(--line);background:var(--panel2);color:var(--text);min-height:44px}
.btn:hover{border-color:#3a3a44}
.btn.primary{background:var(--accent);color:var(--accent-ink);border-color:var(--accent)}
.btn.primary:hover{filter:brightness(1.05)}
.btn.small{min-height:36px;padding:6px 10px;font-size:13px;font-weight:500}
.btn:disabled{opacity:.5;cursor:default}
.nav{display:flex;justify-content:space-between;gap:10px;margin-top:22px}
.check{display:flex;align-items:center;gap:10px;margin:14px 0 6px;font-size:15px;color:var(--text)}
.check input{width:18px;height:18px;accent-color:var(--accent)}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;word-break:break-all}
.pill{display:inline-block;font-size:11px;padding:2px 8px;border-radius:999px;border:1px solid var(--line);color:var(--muted);margin-left:6px;vertical-align:middle}
.pill.good{color:var(--good);border-color:#2b4d38}.pill.warn{color:var(--accent);border-color:#5a4a10}
.list{list-style:none;padding:0;margin:8px 0 0}
.list li{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 0;border-top:1px solid var(--line)}
.list li:first-child{border-top:0}
.err{display:none;background:#2a1414;border:1px solid #5a2323;color:#ffb3b3;border-radius:9px;padding:10px 12px;margin-top:14px;font-size:14px}
.err.on{display:block}
.err ul{margin:6px 0 0 18px;padding:0}
.fees{background:var(--panel2);border:1px solid var(--line);border-radius:9px;padding:12px 14px;font-size:14px}
.fees div{display:flex;justify-content:space-between;gap:10px;padding:4px 0}
.fees .k{color:var(--muted)}
.fees s{color:var(--muted);margin-right:6px}
.qrwrap{display:flex;gap:18px;align-items:flex-start;flex-wrap:wrap;margin:10px 0}
.qr{background:#fff;padding:10px;border-radius:10px;line-height:0}
.qr svg{width:200px;height:200px;display:block}
.addr{flex:1;min-width:220px}
.code{background:var(--panel2);border:1px solid var(--line);border-radius:9px;padding:10px 12px;margin:8px 0}
.copy{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.ol{padding-left:20px;margin:8px 0 0}
.ol li{margin:8px 0}
.toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:var(--accent);color:var(--accent-ink);padding:8px 14px;border-radius:8px;font-size:13px;font-weight:600;opacity:0;pointer-events:none;transition:opacity .2s}
.toast.on{opacity:1}
.warnbox{background:#2a2210;border:1px solid #5a4a10;border-radius:9px;padding:10px 12px;font-size:14px;margin-top:10px}
.spin{display:inline-block;width:14px;height:14px;border:2px solid var(--accent-ink);border-right-color:transparent;border-radius:50%;animation:sp .7s linear infinite}
@keyframes sp{to{transform:rotate(360deg)}}
`;

// The script avoids template literals and "${" on purpose: it is embedded in a TypeScript template string.
const JS = `
(function () {
  "use strict";
  var CFG = JSON.parse(document.getElementById("cfg").textContent);
  var $ = function (id) { return document.getElementById(id); };
  var state = { token: null, wallet: null, team: [], idTouched: false, provider: null };
  var B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  var PUBKEY = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

  function b58(bytes) {
    var digits = [0], i, j, carry;
    for (i = 0; i < bytes.length; i++) {
      carry = bytes[i];
      for (j = 0; j < digits.length; j++) { carry += digits[j] << 8; digits[j] = carry % 58; carry = (carry / 58) | 0; }
      while (carry > 0) { digits.push(carry % 58); carry = (carry / 58) | 0; }
    }
    var out = "";
    for (i = 0; i < bytes.length && bytes[i] === 0; i++) out += "1";
    for (i = digits.length - 1; i >= 0; i--) out += B58[digits[i]];
    return out;
  }
  function short(s) { return s.length > 12 ? s.slice(0, 4) + "\\u2026" + s.slice(-4) : s; }
  function toast(msg) { var t = $("toast"); t.textContent = msg; t.classList.add("on"); setTimeout(function () { t.classList.remove("on"); }, 1800); }
  function copyText(text) {
    var done = function () { toast("Copied"); };
    if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(text).then(done, function () { fallback(); }); } else { fallback(); }
    function fallback() {
      var ta = document.createElement("textarea"); ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); done(); } catch (e) { toast("Copy failed"); }
      document.body.removeChild(ta);
    }
  }
  function showErr(id, msg, details) {
    var el = $(id);
    if (!msg) { el.classList.remove("on"); el.innerHTML = ""; return; }
    el.classList.add("on");
    el.textContent = msg;
    if (details && details.length) {
      var ul = document.createElement("ul");
      details.forEach(function (d) { var li = document.createElement("li"); li.textContent = d; ul.appendChild(li); });
      el.appendChild(ul);
    }
  }
  function api(method, path, body, auth) {
    var h = { "Content-Type": "application/json" };
    if (auth && state.token) h["Authorization"] = "Bearer " + state.token;
    return fetch(path, { method: method, headers: h, body: body ? JSON.stringify(body) : undefined }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) { var e = new Error(j.error || ("HTTP " + r.status)); e.details = j.details; throw e; } return j; });
    });
  }
  function num(id) { var v = $(id).value.trim(); return v === "" ? undefined : Number(v); }

  // ---- steps ----
  var STEPS = ["s1", "s2", "s3", "s4"];
  function show(n) {
    STEPS.forEach(function (id, i) {
      $(id).classList.toggle("on", i === n);
      var li = $("st" + (i + 1));
      li.classList.toggle("on", i === n); li.classList.toggle("done", i < n);
    });
    $("done").classList.remove("on");
    window.scrollTo(0, 0);
  }
  document.querySelectorAll("[data-go]").forEach(function (b) {
    b.addEventListener("click", function () {
      var n = Number(b.getAttribute("data-go"));
      if (n === 2 && !validateProject()) return;
      if (n === 3 && !validateRules()) return;
      show(n);
    });
  });

  // ---- step 1: wallet ----
  function getProvider() {
    var p = (window.phantom && window.phantom.solana) || window.solana;
    return p && typeof p.connect === "function" && typeof p.signMessage === "function" ? p : null;
  }
  function phantomLink() {
    return "https://phantom.app/ul/browse/" + encodeURIComponent(location.href) + "?ref=" + encodeURIComponent(location.origin);
  }
  function detect() {
    state.provider = getProvider();
    if (!state.provider) {
      $("nowallet").style.display = "block";
      $("phantomlink").href = phantomLink();
      $("connect").disabled = true;
    } else {
      $("nowallet").style.display = "none";
      $("connect").disabled = false;
    }
  }
  function signChallenge(provider) {
    return api("GET", "/api/challenge").then(function (c) {
      var bytes = new TextEncoder().encode(c.message);
      return provider.signMessage(bytes, "utf8").then(function (res) {
        var sig = res && res.signature ? res.signature : res;
        var pk = res && res.publicKey ? res.publicKey.toString() : provider.publicKey.toString();
        return { wallet: pk, challenge: c.challenge, signature: b58(sig instanceof Uint8Array ? sig : new Uint8Array(sig)) };
      });
    });
  }
  function signedIn(wallet) {
    state.wallet = wallet;
    $("whoami").textContent = short(wallet);
    $("founderwallet").textContent = wallet;
    renderTeam();
  }
  $("connect").addEventListener("click", function () {
    var btn = $("connect");
    showErr("err1", null);
    var provider = getProvider();
    if (!provider) { detect(); return; }
    btn.disabled = true; btn.innerHTML = '<span class="spin"></span> Waiting for your wallet';
    provider.connect().then(function () { return signChallenge(provider); })
      .then(function (s) { return api("POST", "/api/session", s); })
      .then(function (r) {
        state.token = r.token;
        try { sessionStorage.setItem("tenfold.onboard.token", r.token); } catch (e) {}
        signedIn(r.wallet);
        show(1);
      })
      .catch(function (e) { showErr("err1", e.message || "Wallet connection failed"); })
      .then(function () { btn.disabled = false; btn.textContent = "Connect wallet and sign"; });
  });

  // ---- step 2: project ----
  function slug(s) { return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40); }
  var idTimer = null;
  function checkId() {
    var id = $("pid").value.trim();
    var h = $("idhint");
    if (!/^[a-z0-9-]{2,40}$/.test(id)) { h.textContent = "2 to 40 lowercase letters, digits or dashes."; h.className = "hint bad"; return; }
    h.textContent = "Checking\\u2026"; h.className = "hint";
    clearTimeout(idTimer);
    idTimer = setTimeout(function () {
      api("GET", "/api/projects/" + encodeURIComponent(id) + "/available").then(function (r) {
        if ($("pid").value.trim() !== id) return;
        if (r.available) { h.textContent = "Available. Your proof page will be " + CFG.proofBaseUrl + "/p/" + id; h.className = "hint good"; }
        else { h.textContent = r.reason || "Taken: pick another id."; h.className = "hint bad"; }
      }).catch(function () { h.textContent = ""; });
    }, 250);
  }
  $("pname").addEventListener("input", function () { if (!state.idTouched) { $("pid").value = slug($("pname").value); checkId(); } });
  $("pid").addEventListener("input", function () { state.idTouched = $("pid").value !== ""; $("pid").value = $("pid").value.toLowerCase(); checkId(); });
  $("pmode").addEventListener("change", function () { $("livewarn").style.display = $("pmode").value === "live" ? "block" : "none"; });
  $("referral").addEventListener("input", renderFees);
  function validateProject() {
    var errs = [];
    if (!$("pname").value.trim()) errs.push("Project name is required.");
    if (!/^[a-z0-9-]{2,40}$/.test($("pid").value.trim())) errs.push("Project id: 2 to 40 lowercase letters, digits or dashes.");
    if (!PUBKEY.test($("mint").value.trim())) errs.push("Token mint must be a base58 address.");
    var d = num("decimals");
    if (!(d >= 0 && d <= 12 && d === Math.floor(d))) errs.push("Decimals: whole number between 0 and 12.");
    showErr("err2", errs.length ? "Please fix:" : null, errs);
    return errs.length === 0;
  }

  // ---- step 3: rules and strategy ----
  function addLevel(price, sol) {
    var row = document.createElement("div"); row.className = "row3";
    var p = document.createElement("input"); p.type = "number"; p.step = "any"; p.min = "0"; p.placeholder = "price, SOL per token"; p.className = "lvl-price"; if (price !== undefined) p.value = price;
    var s = document.createElement("input"); s.type = "number"; s.step = "any"; s.min = "0"; s.placeholder = "SOL budget"; s.className = "lvl-sol"; if (sol !== undefined) s.value = sol;
    var x = document.createElement("button"); x.type = "button"; x.className = "btn small"; x.textContent = "Remove";
    x.addEventListener("click", function () { row.remove(); });
    row.appendChild(p); row.appendChild(s); row.appendChild(x);
    $("levels").appendChild(row);
  }
  $("addlevel").addEventListener("click", function () { addLevel(); });
  function levels() {
    var out = [];
    document.querySelectorAll("#levels .row3").forEach(function (r) {
      var p = r.querySelector(".lvl-price").value.trim(), s = r.querySelector(".lvl-sol").value.trim();
      if (p === "" && s === "") return;
      out.push({ price: Number(p), budgetSol: Number(s) });
    });
    return out;
  }
  function syncToggles() {
    var d = $("dist").checked;
    ["distpct", "distmode", "minprice", "boost"].forEach(function (id) { $(id).disabled = !d; });
    var r = $("reb").checked;
    ["rebtarget", "rebband"].forEach(function (id) { $(id).disabled = !r; });
  }
  $("dist").addEventListener("change", syncToggles);
  $("reb").addEventListener("change", syncToggles);
  function validateRules() {
    var errs = [];
    var cap = num("cap");
    if (!(cap >= 0 && cap <= 100)) errs.push("Daily sell cap must be between 0 and 100 %.");
    var budget = num("budget"), day = num("budgetday");
    if (!(budget >= 0)) errs.push("Defense budget must be 0 or more.");
    if (day !== undefined && day > budget) errs.push("Defense per day cannot exceed the total defense budget.");
    var sl = num("slippage");
    if (!(sl >= 1 && sl <= 5000 && sl === Math.floor(sl))) errs.push("Slippage must be a whole number of bps between 1 and 5000.");
    levels().forEach(function (l, i) {
      if (!(l.price > 0)) errs.push("Level " + (i + 1) + ": price must be above 0.");
      if (!(l.budgetSol >= 0)) errs.push("Level " + (i + 1) + ": SOL budget must be 0 or more.");
    });
    if (levels().length && budget === 0) errs.push("Levels need a defense budget above 0 to be bought.");
    if ($("dist").checked) {
      var pct = num("distpct");
      if (!(pct >= 0 && pct <= 100)) errs.push("Distribution % per day must be between 0 and 100.");
      if (pct > cap) errs.push("Distribution % per day is above the daily sell cap; it will be clamped to the cap.");
      var b = num("boost");
      if (b !== undefined && !(b >= 1 && b <= 10)) errs.push("Strength boost must be between 1 and 10.");
      var mp = num("minprice");
      if (mp !== undefined && !(mp > 0)) errs.push("Min price must be above 0 (or empty).");
    }
    if ($("reb").checked) {
      var t = num("rebtarget"), band = num("rebband");
      if (!(t >= 0 && t <= 1)) errs.push("Rebalance target SOL share must be between 0 and 1.");
      if (!(band > 0 && band <= 0.5)) errs.push("Rebalance band must be above 0 and at most 0.5.");
    }
    var cmin = num("clipmin"), cmax = num("clipmax");
    if (!(cmin > 0) || !(cmax > 0) || cmin > cmax) errs.push("Clip: min and max must be above 0 and min <= max.");
    // The distribution clamp is a warning only; everything else blocks.
    var blocking = errs.filter(function (e) { return e.indexOf("clamped") < 0; });
    showErr("err3", errs.length ? (blocking.length ? "Please fix:" : "Note:") : null, errs);
    return blocking.length === 0;
  }

  // ---- step 4: team, marketing, fees ----
  function renderTeam() {
    var ul = $("team"); ul.innerHTML = "";
    var li = document.createElement("li");
    li.innerHTML = '<span class="mono">' + (state.wallet || "") + '</span><span><span class="pill good">founder, signed</span></span>';
    ul.appendChild(li);
    state.team.forEach(function (t, i) {
      var row = document.createElement("li");
      var left = document.createElement("span"); left.className = "mono"; left.textContent = t.wallet;
      var right = document.createElement("span");
      var pill = document.createElement("span"); pill.className = "pill " + (t.signature ? "good" : "warn"); pill.textContent = t.signature ? "signed" : "declared, unsigned";
      var rm = document.createElement("button"); rm.type = "button"; rm.className = "btn small"; rm.textContent = "Remove"; rm.style.marginLeft = "8px";
      rm.addEventListener("click", function () { state.team.splice(i, 1); renderTeam(); });
      right.appendChild(pill); right.appendChild(rm);
      row.appendChild(left); row.appendChild(right);
      ul.appendChild(row);
    });
  }
  function addTeam(entry) {
    if (entry.wallet === state.wallet) { showErr("err4", "That is the founder wallet, already declared."); return; }
    for (var i = 0; i < state.team.length; i++) {
      if (state.team[i].wallet === entry.wallet) { if (entry.signature) state.team[i] = entry; renderTeam(); return; }
    }
    if (state.team.length >= 49) { showErr("err4", "At most 49 team wallets."); return; }
    state.team.push(entry); renderTeam();
  }
  $("addwallet").addEventListener("click", function () {
    showErr("err4", null);
    var w = $("teamaddr").value.trim();
    if (!PUBKEY.test(w)) { showErr("err4", "That is not a base58 wallet address."); return; }
    addTeam({ wallet: w, label: "team" });
    $("teamaddr").value = "";
  });
  $("signwallet").addEventListener("click", function () {
    showErr("err4", null);
    var provider = getProvider();
    if (!provider) { showErr("err4", "No wallet extension found in this browser."); return; }
    var btn = $("signwallet"); btn.disabled = true;
    var current = provider.publicKey ? provider.publicKey.toString() : null;
    var p = current ? Promise.resolve() : provider.connect();
    p.then(function () {
      var addr = provider.publicKey.toString();
      if (addr === state.wallet) { throw new Error("Phantom is still on the founder account. Switch to the team wallet in Phantom, then tap again."); }
      return signChallenge(provider);
    }).then(function (s) {
      addTeam({ wallet: s.wallet, label: "team", challenge: s.challenge, signature: s.signature });
      toast("Signed " + short(s.wallet));
    }).catch(function (e) { showErr("err4", e.message || "Signing failed"); }).then(function () { btn.disabled = false; });
  });
  function renderFees() {
    var f = CFG.fees, ref = $("referral").value.trim() !== "";
    var disc = ref ? f.discountBps / 10000 : 0;
    var vol = Math.round(f.volumeBps * (1 - disc)), cash = Math.round(f.cashoutBps * (1 - disc));
    var pct = function (bps) { return (bps / 100).toFixed(2).replace(/\\.?0+$/, "") + "%"; };
    var row = function (k, v) { return '<div><span class="k">' + k + '</span><span>' + v + '</span></div>'; };
    $("fees").innerHTML =
      row("Volume fee, on the SOL leg of every trade", (ref ? "<s>" + f.volumeBps + " bps</s>" : "") + vol + " bps (" + pct(vol) + ")") +
      row("Cash-out fee, on withdrawals", (ref ? "<s>" + f.cashoutBps + " bps</s>" : "") + cash + " bps (" + pct(cash) + ")") +
      row("Referral", (f.referralBps / 100) + "% of the fee goes to the referrer" + (ref ? "; your " + (f.discountBps / 100) + "% referral discount is applied" : "; a referral code gives you a " + (f.discountBps / 100) + "% discount"));
  }

  // ---- submit ----
  function payload() {
    var marketing = { mode: $("mkmode").value };
    if ($("xhandle").value.trim()) marketing.xHandle = $("xhandle").value.trim();
    if ($("tgchannel").value.trim()) marketing.telegramChannelId = $("tgchannel").value.trim();
    if ($("tone").value.trim()) marketing.tone = $("tone").value.trim();
    var dist = { enabled: $("dist").checked, pctOfVaultPerDay: num("distpct"), mode: $("distmode").value };
    if (num("minprice") !== undefined) dist.minPrice = num("minprice");
    if (num("boost") !== undefined) dist.strengthBoost = num("boost");
    var body = {
      name: $("pname").value.trim(), id: $("pid").value.trim(), mint: $("mint").value.trim(), decimals: num("decimals"), mode: $("pmode").value,
      rules: { dailySellCapPct: num("cap"), defenseBudgetSol: num("budget"), maxDefenseSpendPerDaySol: num("budgetday"), withdrawalDelayHours: Number($("delay").value), maxSlippageBps: num("slippage") },
      strategy: { levels: levels(), distribution: dist, rebalance: { enabled: $("reb").checked, targetSolShare: num("rebtarget"), band: num("rebband") }, clip: { minSol: num("clipmin"), maxSol: num("clipmax") } },
      teamWallets: state.team, marketing: marketing
    };
    if ($("referral").value.trim()) body.referral = $("referral").value.trim();
    return body;
  }
  $("submit").addEventListener("click", function () {
    showErr("err4", null);
    if (!validateProject()) { show(1); return; }
    if (!validateRules()) { show(2); return; }
    var btn = $("submit"); btn.disabled = true; btn.innerHTML = '<span class="spin"></span> Creating wallet and project';
    api("POST", "/api/projects", payload(), true).then(renderDone)
      .catch(function (e) {
        if (/session/i.test(e.message || "")) { state.token = null; show(0); showErr("err1", "Your session expired. Connect again."); return; }
        showErr("err4", e.message || "Creation failed", e.details);
      })
      .then(function () { btn.disabled = false; btn.textContent = "Create project"; });
  });
  function renderDone(r) {
    STEPS.forEach(function (id, i) { $(id).classList.remove("on"); $("st" + (i + 1)).classList.add("done"); $("st" + (i + 1)).classList.remove("on"); });
    $("done").classList.add("on");
    $("donename").textContent = $("pname").value.trim();
    $("qr").innerHTML = r.qrSvg;
    $("depaddr").textContent = r.walletPubkey;
    $("copyaddr").onclick = function () { copyText(r.walletPubkey); };
    var cmd = "/start " + r.id + " " + r.bindCode;
    $("bindcmd").textContent = cmd;
    $("copybind").onclick = function () { copyText(cmd); };
    $("prooflink").textContent = r.proofUrl; $("prooflink").href = r.proofUrl;
    var ol = $("steps"); ol.innerHTML = "";
    r.nextSteps.forEach(function (s) { var li = document.createElement("li"); li.textContent = s; ol.appendChild(li); });
    var ul = $("declared"); ul.innerHTML = "";
    (r.declaredWallets || []).forEach(function (d) {
      var li = document.createElement("li");
      var a = document.createElement("span"); a.className = "mono"; a.textContent = d.wallet;
      var b = document.createElement("span"); b.className = "pill " + (d.signed ? "good" : "warn"); b.textContent = d.label + (d.signed ? ", signed" : ", unsigned");
      li.appendChild(a); li.appendChild(b); ul.appendChild(li);
    });
    try { sessionStorage.removeItem("tenfold.onboard.token"); } catch (e) {}
    window.scrollTo(0, 0);
  }

  // ---- init ----
  function init() {
    $("cap").value = CFG.rules.dailySellCapPct;
    $("budget").value = CFG.rules.defenseBudgetSol;
    $("budgetday").value = CFG.rules.maxDefenseSpendPerDaySol;
    $("delay").value = String(CFG.rules.withdrawalDelayHours);
    $("slippage").value = CFG.rules.maxSlippageBps;
    $("distpct").value = CFG.strategy.distribution.pctOfVaultPerDay;
    $("distmode").value = CFG.strategy.distribution.mode;
    $("boost").value = 1;
    $("rebtarget").value = CFG.strategy.rebalance.targetSolShare;
    $("rebband").value = CFG.strategy.rebalance.band;
    $("clipmin").value = CFG.strategy.clip.minSol;
    $("clipmax").value = CFG.strategy.clip.maxSol;
    syncToggles(); renderFees(); renderTeam();
    if (!CFG.walletsEnabled) $("nokeystore").style.display = "block";
    detect();
    // Wallet extensions can inject after DOMContentLoaded.
    var tries = 0; var iv = setInterval(function () { detect(); if (getProvider() || ++tries > 20) clearInterval(iv); }, 250);
    var saved = null;
    try { saved = sessionStorage.getItem("tenfold.onboard.token"); } catch (e) {}
    if (saved) {
      state.token = saved;
      api("GET", "/api/session", null, true).then(function (r) { signedIn(r.wallet); show(1); }).catch(function () { state.token = null; });
    }
  }
  init();
})();
`;

export function renderOnboardPage(opts: PageOptions): string {
  const cfgJson = JSON.stringify({
    fees: opts.fees,
    rules: opts.rules,
    strategy: opts.strategy,
    proofBaseUrl: opts.proofBaseUrl.replace(/\/+$/, ""),
    walletsEnabled: opts.walletsEnabled,
  }).replace(/</g, "\\u003c");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>Tenfold onboarding</title>
<style>${CSS}</style>
</head>
<body>
<main>
<div class="brand"><div class="bolt">Z</div><div><h1>Set up your market maker</h1><div class="sub" style="margin:0">Four steps. Your wallet signs in, Tenfold creates a vault wallet, you deposit, you control it from Telegram.</div></div></div>

<ol class="steps">
<li id="st1" class="on">1 Wallet</li><li id="st2">2 Project</li><li id="st3">3 Rules</li><li id="st4">4 Team</li>
</ol>

<section id="s1" class="step card on">
<h2>Connect the founder wallet</h2>
<p class="sub">You sign one message (no transaction, no fee). That proves you own the wallet that gets declared as the founder on the public proof page.</p>
<div id="nokeystore" class="warnbox" style="display:none">This server has no keystore password set, so it cannot create execution wallets yet. You can fill the form, but the last step will fail until the operator sets TENFOLD_KEYSTORE_PASSWORD.</div>
<div id="nowallet" class="warnbox" style="display:none">No Solana wallet found in this browser. Install Phantom, or on a phone <a id="phantomlink" href="#">open this page inside the Phantom app</a>.</div>
<div class="nav" style="justify-content:flex-start"><button id="connect" class="btn primary" type="button">Connect wallet and sign</button></div>
<div id="err1" class="err"></div>
</section>

<section id="s2" class="step card">
<h2>Project <span class="pill">as <span id="whoami"></span></span></h2>
<label>Project name</label>
<input id="pname" type="text" maxlength="80" placeholder="My Token" autocomplete="off">
<label>Project id <span class="hint" style="display:inline">(used in the proof URL and on Telegram)</span></label>
<input id="pid" type="text" maxlength="40" placeholder="my-token" autocomplete="off" autocapitalize="none" spellcheck="false">
<div id="idhint" class="hint"></div>
<label>Token mint</label>
<input id="mint" type="text" maxlength="44" placeholder="base58 mint address" autocomplete="off" autocapitalize="none" spellcheck="false" class="mono">
<div class="row">
<div><label>Decimals</label><input id="decimals" type="number" min="0" max="12" step="1" value="6"><div class="hint">6 for pump.fun tokens. Check the mint on Solscan if unsure.</div></div>
<div><label>Mode</label><select id="pmode"><option value="paper">paper: real prices, simulated fills</option><option value="live">live: real trades</option></select></div>
</div>
<div id="livewarn" class="warnbox" style="display:none">Live mode trades real funds from day one. Most founders run paper for a day first, then flip the mode from Telegram.</div>
<label>Referral code <span class="hint" style="display:inline">(optional: the referrer's wallet address or the code they gave you)</span></label>
<input id="referral" type="text" maxlength="64" placeholder="none" autocomplete="off">
<div id="err2" class="err"></div>
<div class="nav"><button class="btn" type="button" data-go="0">Back</button><button class="btn primary" type="button" data-go="2">Next: rules</button></div>
</section>

<section id="s3" class="step card">
<h2>Rules and strategy</h2>
<p class="sub">Rules are public and enforced by the risk engine on every order. Strategy is private: levels and sizes never appear on the proof page.</p>
<h3>Rules</h3>
<label><b>Daily sell cap</b>, % of vault tokens per 24 h</label>
<input id="cap" type="number" min="0" max="100" step="any">
<div class="hint">The public ceiling on how much supply can leave the vault in a day. It is what makes the badge mean something: lower is more credible.</div>
<div class="row">
<div><label>Defense budget, SOL (lifetime)</label><input id="budget" type="number" min="0" step="any"><div class="hint">SOL the engine may spend buying at your levels. Replenishable.</div></div>
<div><label>Defense max per day, SOL</label><input id="budgetday" type="number" min="0" step="any"></div>
</div>
<div class="row">
<div><label>Withdrawal delay</label><select id="delay"><option value="24">24 hours</option><option value="48">48 hours</option></select><div class="hint">Shown publicly; enforced on-chain once the vault program ships.</div></div>
<div><label>Max slippage, bps</label><input id="slippage" type="number" min="1" max="5000" step="1"><div class="hint">Per order. 150 = 1.5%.</div></div>
</div>

<h3>Defense levels</h3>
<div class="hint">Tenfold buys when the price reaches a level, up to that level's SOL budget (bounded by the defense budget above). Empty = no defense.</div>
<div id="levels"></div>
<div style="margin-top:10px"><button id="addlevel" class="btn small" type="button">Add level</button></div>

<h3>Distribution</h3>
<label class="check"><input id="dist" type="checkbox"> Sell a share of the vault each day, within the cap</label>
<div class="row">
<div><label>% of vault per day</label><input id="distpct" type="number" min="0" max="100" step="any"><div class="hint">Never above the daily sell cap.</div></div>
<div><label>Mode</label><select id="distmode"><option value="strength">strength: only when buyers dominate</option><option value="twap">twap: spread evenly over the day</option></select></div>
</div>
<div class="row">
<div><label>Min price, SOL per token (optional)</label><input id="minprice" type="number" min="0" step="any" placeholder="never sell below"></div>
<div><label>Strength boost, 1 to 10</label><input id="boost" type="number" min="1" max="10" step="any"><div class="hint">Sells harder into strong real up-moves, within the cap. 1 = flat clips.</div></div>
</div>

<h3>Rebalance</h3>
<label class="check"><input id="reb" type="checkbox"> Keep the token/SOL ratio inside a band</label>
<div class="row">
<div><label>Target SOL share, 0 to 1</label><input id="rebtarget" type="number" min="0" max="1" step="any"></div>
<div><label>Band (half-width), 0 to 0.5</label><input id="rebband" type="number" min="0" max="0.5" step="any"></div>
</div>

<h3>Clip size</h3>
<div class="row">
<div><label>Min SOL per order</label><input id="clipmin" type="number" min="0" step="any"></div>
<div><label>Max SOL per order</label><input id="clipmax" type="number" min="0" step="any"></div>
</div>
<div class="hint">Sizes and timing are randomized around these so watchers cannot front-run the bot.</div>
<div id="err3" class="err"></div>
<div class="nav"><button class="btn" type="button" data-go="1">Back</button><button class="btn primary" type="button" data-go="3">Next: team</button></div>
</section>

<section id="s4" class="step card">
<h2>Team wallets, marketing, fees</h2>
<h3>Declared wallets</h3>
<p class="hint">Insider wallets you declare are tracked on the proof page. Declaring them (and ideally signing from them) is what earns the badge; a signed wallet proves the team controls it.</p>
<ul id="team" class="list"></ul>
<label>Add a wallet by address</label>
<div class="copy"><input id="teamaddr" type="text" maxlength="44" placeholder="base58 address" class="mono" autocomplete="off" autocapitalize="none" spellcheck="false" style="flex:1;min-width:200px"><button id="addwallet" class="btn" type="button">Add unsigned</button></div>
<div class="hint" style="margin-top:10px">Or switch to the team wallet in your wallet app and <button id="signwallet" class="btn small" type="button">sign from this wallet</button>. The founder wallet is <span id="founderwallet" class="mono"></span>.</div>

<h3>Marketing</h3>
<label>Mode</label>
<select id="mkmode"><option value="off">off: never draft posts</option><option value="approve">approve: draft and ask me first</option><option value="auto">auto: post without asking</option></select>
<div class="row">
<div><label>X handle</label><input id="xhandle" type="text" maxlength="32" placeholder="@mytoken" autocomplete="off"></div>
<div><label>Telegram channel id</label><input id="tgchannel" type="text" maxlength="64" placeholder="-100123456789 or @channel" autocomplete="off"></div>
</div>
<label>Tone</label>
<textarea id="tone" maxlength="200" placeholder="short, factual, no hype"></textarea>

<h3>Fee terms (fixed at onboarding)</h3>
<div id="fees" class="fees"></div>
<div id="err4" class="err"></div>
<div class="nav"><button class="btn" type="button" data-go="2">Back</button><button id="submit" class="btn primary" type="button">Create project</button></div>
</section>

<section id="done" class="step card">
<h2><span id="donename"></span> is set up</h2>
<h3>1. Deposit</h3>
<p class="hint">This is the execution wallet Tenfold created for your project. Its key is encrypted on the server and only the engine can sign with it. Send the tokens and SOL you want managed here.</p>
<div class="qrwrap"><div id="qr" class="qr"></div><div class="addr"><div class="code mono" id="depaddr"></div><button id="copyaddr" class="btn small" type="button">Copy address</button></div></div>
<h3>2. Bind Telegram</h3>
<p class="hint">In a private chat with the Tenfold bot, send this exact command. The bind code is shown once and never again.</p>
<div class="copy"><div class="code mono" id="bindcmd" style="flex:1"></div><button id="copybind" class="btn small" type="button">Copy</button></div>
<h3>3. Proof page</h3>
<p><a id="prooflink" href="#" target="_blank" rel="noopener"></a></p>
<h3>Declared wallets</h3>
<ul id="declared" class="list"></ul>
<h3>Next steps</h3>
<ol id="steps" class="ol"></ol>
</section>

<div id="toast" class="toast"></div>
</main>
<script type="application/json" id="cfg">${cfgJson}</script>
<script>${JS}</script>
</body>
</html>`;
}
