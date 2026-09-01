// Public landing page for ReturnCheck.
//
// Deliberately self-contained: no third-party scripts, fonts, analytics or form
// processors. The first contact action opens an email draft, so this page does
// not collect personal data or add another database/spam surface to the Worker.

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function absoluteBase(env, url) {
  return (env.PUBLIC_BASE_URL || url.origin).replace(/\/$/, "");
}

function brandMark() {
  return `<svg viewBox="0 0 48 48" aria-hidden="true" focusable="false">
    <path d="M9 15.5 24 7l15 8.5v17L24 41 9 32.5z" fill="#e9f2ff" stroke="#79a9ff" stroke-width="2"/>
    <path d="M9 15.5 24 24l15-8.5M24 24v17" fill="none" stroke="#3478f6" stroke-width="2.4" stroke-linejoin="round"/>
    <path d="M13 11.5 24 17l11-5.5" fill="none" stroke="#8bb5ff" stroke-width="2" stroke-linecap="round"/>
    <circle cx="34" cy="33" r="10" fill="#22b36b" stroke="#08152f" stroke-width="2"/>
    <path d="m29.5 33 3 3 6-7" fill="none" stroke="white" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
}

export function landingPage(env, url) {
  const base = absoluteBase(env, url);
  const contact = env.CONTACT_EMAIL || "returncheckteam@gmail.com";
  const price = Number(env.PRICE_USD || "0.02");
  const priceLabel = Number.isFinite(price) ? price.toFixed(2) : "0.02";
  const x402Live = String(env.X402_ENABLED || "false") === "true" && env.X402_NETWORK === "eip155:8453";
  const emailBody = [
    "Hello ReturnCheck team,",
    "",
    "I'd like a 2-case sample.",
    "",
    "Product URL 1:",
    "Product URL 2:",
    "Buyer country: US",
    "Relevant context (seller, condition, purchase channel, dates):",
  ].join("\n");
  const sampleHref = `mailto:${encodeURIComponent(contact)}?subject=${encodeURIComponent("ReturnCheck — 2-case sample")}&body=${encodeURIComponent(emailBody)}`;
  const canonical = base + "/";

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ReturnCheck — Evidence-backed return decisions for AI agents</title>
  <meta name="description" content="ReturnCheck gives AI shopping agents a verified return-policy verdict with the exact supporting clause—or an honest UNKNOWN.">
  <meta name="theme-color" content="#07142d">
  <meta property="og:type" content="website">
  <meta property="og:title" content="ReturnCheck — Evidence-backed return decisions">
  <meta property="og:description" content="Exact policy clauses. Verifiable outcomes. Honest UNKNOWN.">
  <meta property="og:url" content="${esc(canonical)}">
  <meta name="twitter:card" content="summary">
  <link rel="canonical" href="${esc(canonical)}">
  <link rel="alternate" type="application/json" href="${esc(base)}/discovery.json">
  <style>
    :root {
      color-scheme: dark;
      --ink: #f6f9ff;
      --muted: #aebbd4;
      --faint: #7f8eaa;
      --page: #061127;
      --panel: #0b1a35;
      --panel-2: #0e2041;
      --line: rgba(170, 194, 236, .18);
      --blue: #5b9cff;
      --blue-2: #8ec0ff;
      --green: #35d285;
      --amber: #ffc96b;
      --red: #ff7d78;
      --radius: 22px;
      --shadow: 0 24px 70px rgba(0, 0, 0, .28);
    }
    * { box-sizing: border-box; }
    html { scroll-behavior: smooth; }
    body {
      margin: 0;
      color: var(--ink);
      background:
        radial-gradient(900px 520px at 82% -10%, rgba(52, 120, 246, .27), transparent 66%),
        radial-gradient(700px 440px at -10% 38%, rgba(28, 177, 126, .10), transparent 70%),
        var(--page);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      line-height: 1.55;
      -webkit-font-smoothing: antialiased;
    }
    a { color: inherit; }
    .skip {
      position: fixed; left: 14px; top: 12px; z-index: 30; padding: 10px 14px;
      color: #07142d; background: white; border-radius: 10px; transform: translateY(-180%);
    }
    .skip:focus { transform: none; }
    .wrap { width: min(1160px, calc(100% - 40px)); margin-inline: auto; }
    nav {
      height: 82px; display: flex; align-items: center; justify-content: space-between;
      border-bottom: 1px solid var(--line);
    }
    .brand { display: inline-flex; align-items: center; gap: 11px; text-decoration: none; font-weight: 760; letter-spacing: -.02em; }
    .brand svg { width: 39px; height: 39px; }
    .navlinks { display: flex; align-items: center; gap: 26px; }
    .navlinks a { color: var(--muted); text-decoration: none; font-size: .94rem; font-weight: 620; }
    .navlinks a:hover, .navlinks a:focus-visible { color: white; }
    .nav-cta { border: 1px solid var(--line); border-radius: 999px; padding: 9px 15px; }
    .hero { display: grid; grid-template-columns: 1.08fr .92fr; gap: 70px; align-items: center; padding: 98px 0 84px; }
    .eyebrow { display: inline-flex; align-items: center; gap: 8px; color: var(--blue-2); font-size: .78rem; font-weight: 800; letter-spacing: .13em; text-transform: uppercase; }
    .eyebrow::before { content: ""; width: 8px; height: 8px; border-radius: 50%; background: var(--green); box-shadow: 0 0 0 5px rgba(53, 210, 133, .12); }
    h1 { margin: 20px 0 23px; max-width: 760px; font-size: clamp(2.7rem, 5.1vw, 5rem); line-height: .99; letter-spacing: -.055em; }
    .lead { margin: 0; max-width: 680px; color: var(--muted); font-size: clamp(1.05rem, 1.8vw, 1.24rem); }
    .lead strong { color: white; }
    .actions { display: flex; flex-wrap: wrap; gap: 13px; margin-top: 34px; }
    .button { display: inline-flex; min-height: 50px; align-items: center; justify-content: center; gap: 8px; padding: 0 20px; border: 1px solid transparent; border-radius: 13px; text-decoration: none; font-weight: 760; }
    .button.primary { color: #061127; background: linear-gradient(135deg, #91c4ff, #5b9cff); box-shadow: 0 12px 34px rgba(53, 120, 246, .25); }
    .button.secondary { color: white; background: rgba(255, 255, 255, .035); border-color: var(--line); }
    .button:hover { transform: translateY(-1px); }
    .micro { margin-top: 18px; color: var(--faint); font-size: .86rem; }
    .decision-card { position: relative; padding: 26px; overflow: hidden; background: linear-gradient(150deg, rgba(17, 42, 82, .96), rgba(7, 22, 48, .96)); border: 1px solid rgba(134, 176, 245, .22); border-radius: 27px; box-shadow: var(--shadow); }
    .decision-card::after { content: ""; position: absolute; width: 180px; height: 180px; top: -90px; right: -60px; border-radius: 50%; background: rgba(80, 148, 255, .15); filter: blur(3px); }
    .terminal-head { display: flex; justify-content: space-between; gap: 20px; padding-bottom: 18px; border-bottom: 1px solid var(--line); color: var(--faint); font: 700 .76rem/1.2 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .04em; }
    .live { color: var(--green); }
    .contract { display: grid; gap: 12px; margin: 20px 0; }
    .row { display: grid; grid-template-columns: 116px 1fr; gap: 16px; align-items: start; }
    .key { color: var(--faint); font: 650 .74rem/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; text-transform: uppercase; }
    .value { color: #eaf1ff; font: 650 .88rem/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
    .verdicts { display: flex; flex-wrap: wrap; gap: 7px; }
    .pill { padding: 5px 8px; border-radius: 8px; border: 1px solid var(--line); font: 750 .68rem/1 ui-monospace, SFMono-Regular, Menlo, monospace; }
    .pill.yes { color: #83ecb7; background: rgba(53, 210, 133, .08); }
    .pill.cond { color: #ffe0a6; background: rgba(255, 201, 107, .08); }
    .pill.no { color: #ffaaa6; background: rgba(255, 125, 120, .08); }
    .unknown { margin-top: 3px; padding: 14px; background: rgba(255,255,255,.035); border: 1px solid var(--line); border-radius: 13px; color: var(--muted); font-size: .86rem; }
    .unknown b { color: white; }
    .stats { display: grid; grid-template-columns: repeat(3, 1fr); border-block: 1px solid var(--line); }
    .stat { padding: 25px 18px; text-align: center; border-right: 1px solid var(--line); }
    .stat:last-child { border-right: 0; }
    .stat b { display: block; font-size: 1.38rem; letter-spacing: -.03em; }
    .stat span { color: var(--faint); font-size: .81rem; }
    section { padding: 92px 0; }
    .section-head { max-width: 720px; margin-bottom: 42px; }
    .section-head h2 { margin: 10px 0 13px; font-size: clamp(2rem, 3.4vw, 3.25rem); line-height: 1.08; letter-spacing: -.045em; }
    .section-head p { margin: 0; color: var(--muted); font-size: 1.04rem; }
    .kicker { color: var(--blue-2); font-weight: 800; font-size: .78rem; letter-spacing: .12em; text-transform: uppercase; }
    .steps { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; }
    .step, .trust-card { padding: 27px; background: rgba(12, 29, 59, .75); border: 1px solid var(--line); border-radius: var(--radius); }
    .step-num { display: grid; width: 34px; height: 34px; place-items: center; color: #07142d; background: var(--blue-2); border-radius: 10px; font-weight: 850; }
    .step h3, .trust-card h3 { margin: 23px 0 9px; font-size: 1.1rem; }
    .step p, .trust-card p { margin: 0; color: var(--muted); font-size: .94rem; }
    .evidence { display: grid; grid-template-columns: .92fr 1.08fr; gap: 50px; align-items: center; }
    .quote { padding: 30px; background: #f5f8ff; border-radius: var(--radius); color: #0a1731; box-shadow: var(--shadow); transform: rotate(-1deg); }
    .quote-label { color: #5170a7; font: 800 .72rem/1 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .09em; text-transform: uppercase; }
    .quote blockquote { margin: 18px 0; font-size: 1.18rem; font-weight: 690; line-height: 1.5; }
    .quote-meta { padding-top: 17px; border-top: 1px solid #dbe3f2; color: #5f6f8b; font-size: .82rem; }
    .evidence-copy h2 { margin: 10px 0 18px; font-size: clamp(2rem, 3.4vw, 3.2rem); line-height: 1.08; letter-spacing: -.045em; }
    .evidence-copy > p { color: var(--muted); }
    .checklist { display: grid; gap: 12px; margin-top: 24px; }
    .checkitem { display: flex; gap: 11px; color: #dce6f8; }
    .checkitem::before { content: "✓"; flex: 0 0 auto; color: var(--green); font-weight: 900; }
    .interfaces { background: rgba(6, 18, 40, .72); border-block: 1px solid var(--line); }
    .interface-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 17px; }
    .code-card { overflow: hidden; background: #081630; border: 1px solid var(--line); border-radius: var(--radius); }
    .code-title { display: flex; align-items: center; justify-content: space-between; padding: 17px 20px; border-bottom: 1px solid var(--line); font-weight: 750; }
    .code-title span { color: var(--green); font-size: .73rem; text-transform: uppercase; letter-spacing: .08em; }
    pre { margin: 0; padding: 22px; overflow-x: auto; color: #c8dcff; font: 500 .83rem/1.65 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
    .code-links { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 20px; }
    .text-link { color: var(--blue-2); font-weight: 700; text-underline-offset: 4px; }
    .trust-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; }
    .trust-card .icon { color: var(--blue-2); font-size: 1.3rem; }
    .trust-card h3 { margin-top: 16px; }
    .measure { margin-top: 17px; padding: 20px 22px; color: var(--muted); background: rgba(91, 156, 255, .07); border: 1px solid rgba(91, 156, 255, .2); border-radius: 16px; font-size: .91rem; }
    .measure strong { color: white; }
    .final { padding-top: 48px; }
    .cta { display: grid; grid-template-columns: 1fr auto; gap: 30px; align-items: center; padding: 42px; background: linear-gradient(135deg, #142f5f, #0b2043); border: 1px solid rgba(130, 177, 255, .28); border-radius: 28px; }
    .cta h2 { margin: 0 0 8px; font-size: clamp(1.7rem, 3vw, 2.6rem); letter-spacing: -.04em; }
    .cta p { margin: 0; color: var(--muted); }
    footer { display: flex; justify-content: space-between; gap: 30px; padding: 54px 0 45px; color: var(--faint); font-size: .84rem; }
    .footer-links { display: flex; flex-wrap: wrap; gap: 18px; }
    .footer-links a { color: var(--muted); text-underline-offset: 3px; }
    :focus-visible { outline: 3px solid var(--amber); outline-offset: 3px; }
    @media (max-width: 900px) {
      .hero { grid-template-columns: 1fr; gap: 48px; padding-top: 68px; }
      .decision-card { max-width: 650px; }
      .steps, .trust-grid { grid-template-columns: 1fr; }
      .evidence { grid-template-columns: 1fr; }
      .quote { max-width: 650px; transform: none; }
    }
    @media (max-width: 680px) {
      .wrap { width: min(100% - 28px, 1160px); }
      nav { height: 72px; }
      .navlinks a:not(.nav-cta) { display: none; }
      .hero { padding: 58px 0 62px; }
      h1 { font-size: clamp(2.55rem, 13vw, 4rem); }
      .actions, .actions .button { width: 100%; }
      .stats { grid-template-columns: 1fr; }
      .stat { border-right: 0; border-bottom: 1px solid var(--line); }
      .stat:last-child { border-bottom: 0; }
      section { padding: 68px 0; }
      .interface-grid { grid-template-columns: 1fr; }
      .row { grid-template-columns: 1fr; gap: 3px; }
      .cta { grid-template-columns: 1fr; padding: 30px 24px; }
      .cta .button { width: 100%; }
      footer { flex-direction: column; }
    }
    @media (prefers-reduced-motion: reduce) {
      html { scroll-behavior: auto; }
      *, *::before, *::after { transition: none !important; animation: none !important; }
    }
  </style>
</head>
<body>
  <a class="skip" href="#main">Skip to content</a>
  <header class="wrap">
    <nav aria-label="Primary navigation">
      <a class="brand" href="/" aria-label="ReturnCheck home">${brandMark()}<span>ReturnCheck</span></a>
      <div class="navlinks">
        <a href="#how">How it works</a>
        <a href="#developers">Developers</a>
        <a href="#trust">Trust</a>
        <a class="nav-cta" href="${esc(base)}/cards">Evidence cards</a>
      </div>
    </nav>
  </header>

  <main id="main">
    <div class="wrap hero">
      <div>
        <div class="eyebrow">Live beta · US-first</div>
        <h1>Return decisions your agent can verify.</h1>
        <p class="lead">ReturnCheck answers one purchase-critical question: <strong>can this specific product actually be returned?</strong> Every determinate verdict carries the exact supporting clause. If the evidence does not resolve the case, the answer is UNKNOWN.</p>
        <div class="actions">
          <a class="button primary" href="${esc(sampleHref)}">Request a 2-case sample <span aria-hidden="true">→</span></a>
          <a class="button secondary" href="${esc(base)}/openapi.json">View developer docs</a>
        </div>
        <p class="micro">No sales call required. Send two product URLs and the purchase context.</p>
      </div>

      <aside class="decision-card" aria-label="ReturnCheck decision contract">
        <div class="terminal-head"><span>check_return · decision contract</span><span class="live">● LIVE</span></div>
        <div class="contract">
          <div class="row"><div class="key">required</div><div class="value">product_url · buyer_country</div></div>
          <div class="row"><div class="key">context</div><div class="value">seller · condition · channel · dates</div></div>
          <div class="row"><div class="key">evidence</div><div class="value">exact_clause · source_url · verified_on</div></div>
          <div class="row"><div class="key">outcomes</div><div class="verdicts"><span class="pill yes">YES</span><span class="pill cond">YES_WITH_CONDITIONS</span><span class="pill no">NO</span></div></div>
        </div>
        <div class="unknown"><b>Evidence gate:</b> no verifiable clause → <b>UNKNOWN</b>. No confident guess, and no charge.</div>
      </aside>
    </div>

    <div class="stats" aria-label="Service facts">
      <div class="stat"><b>$${esc(priceLabel)}</b><span>per verified answer</span></div>
      <div class="stat"><b>$0.00</b><span>for UNKNOWN</span></div>
      <div class="stat"><b>HTTP + MCP</b><span>${x402Live ? "x402 live on Base" : "agent-native interfaces"}</span></div>
    </div>

    <section id="how" class="wrap">
      <div class="section-head">
        <span class="kicker">How it works</span>
        <h2>From purchase context to auditable answer.</h2>
        <p>A return policy is rarely one number. Seller, category, item condition, channel, membership and timing can all change the outcome.</p>
      </div>
      <div class="steps">
        <article class="step"><div class="step-num">1</div><h3>Send the exact case</h3><p>Provide the product URL, country and the facts that can change eligibility. Supplying the rendered page text gives the best coverage.</p></article>
        <article class="step"><div class="step-num">2</div><h3>Verify the policy</h3><p>ReturnCheck finds the relevant policy language and checks that the quoted clause exists in the supplied or retrieved page.</p></article>
        <article class="step"><div class="step-num">3</div><h3>Act on the verdict</h3><p>Your agent receives a structured outcome, return window, confidence, source URL and dated evidence—or a safe UNKNOWN.</p></article>
      </div>
    </section>

    <section class="wrap evidence" aria-labelledby="evidence-title">
      <div class="quote" aria-label="Illustration of an evidence-backed answer">
        <div class="quote-label">What travels with a determinate verdict</div>
        <blockquote>“The exact policy clause is quoted here—not paraphrased into certainty.”</blockquote>
        <div class="quote-meta">source_url · exact_clause · verified_on<br>Illustrative format, not a merchant policy quotation.</div>
      </div>
      <div class="evidence-copy">
        <span class="kicker">Evidence, not assertion</span>
        <h2 id="evidence-title">The answer includes the reason to trust it.</h2>
        <p>A verdict without its source is hard for an autonomous buyer to audit, explain or revisit when a policy changes.</p>
        <div class="checklist">
          <div class="checkitem">Literal supporting clause for each determinate answer</div>
          <div class="checkitem">Source URL and verification date</div>
          <div class="checkitem">UNKNOWN when the evidence is insufficient</div>
          <div class="checkitem">Free, hand-reviewed Evidence Cards for public examples</div>
        </div>
        <div class="code-links"><a class="text-link" href="${esc(base)}/cards">Browse Evidence Cards</a><a class="text-link" href="${esc(base)}/cards.json">Read them as JSON</a></div>
      </div>
    </section>

    <section id="developers" class="interfaces">
      <div class="wrap">
        <div class="section-head">
          <span class="kicker">Built for agents</span>
          <h2>One decision service, two native interfaces.</h2>
          <p>Use the remote MCP tool from an agent runtime, or call the HTTP contract directly.</p>
        </div>
        <div class="interface-grid">
          <article class="code-card">
            <div class="code-title">MCP <span>Streamable HTTP</span></div>
            <pre><code>endpoint: ${esc(base)}/mcp
tool: check_return</code></pre>
          </article>
          <article class="code-card">
            <div class="code-title">HTTP <span>POST</span></div>
            <pre><code>curl -X POST ${esc(base)}/v1/check \\
  -H "content-type: application/json" \\
  -d '{"product_url":"…","buyer_country":"US"}'</code></pre>
          </article>
        </div>
        <div class="code-links">
          <a class="text-link" href="${esc(base)}/openapi.json">OpenAPI</a>
          <a class="text-link" href="${esc(base)}/agents.json">Agents manifest</a>
          <a class="text-link" href="${esc(base)}/llms.txt">llms.txt</a>
          ${x402Live ? `<a class="text-link" href="${esc(base)}/.well-known/x402">x402 terms</a>` : ""}
          <a class="text-link" href="https://github.com/mangelmartinezfer-hue/returncheck">GitHub</a>
        </div>
      </div>
    </section>

    <section id="trust" class="wrap">
      <div class="section-head">
        <span class="kicker">Trust model</span>
        <h2>Designed to fail safely.</h2>
        <p>The useful boundary is not “always answer.” It is knowing when the published evidence supports an answer and when it does not.</p>
      </div>
      <div class="trust-grid">
        <article class="trust-card"><div class="icon" aria-hidden="true">⌁</div><h3>Clause before confidence</h3><p>A determinate verdict must carry policy text that can be checked against its source.</p></article>
        <article class="trust-card"><div class="icon" aria-hidden="true">?</div><h3>UNKNOWN is a result</h3><p>Missing seller, conflicting policy or insufficient evidence stays unresolved instead of becoming a fabricated yes or no.</p></article>
        <article class="trust-card"><div class="icon" aria-hidden="true">↻</div><h3>Dated evidence</h3><p>Policy language is recorded with its source and verification date so the answer can be audited later.</p></article>
      </div>
      <div class="measure"><strong>Measured, not estimated.</strong> In a frozen sample of 50 US retailers on August 28, 2026, server-side retrieval reached the policy for 17 of 50. Passing <code>page_text</code> or <code>page_html</code> lets ReturnCheck verify the page your agent already rendered instead of depending on that retrieval step.</div>
    </section>

    <section class="wrap final">
      <div class="cta">
        <div><h2>Test it on two real cases.</h2><p>Send the product URLs and context. We will return the verdict and its supporting evidence.</p></div>
        <a class="button primary" href="${esc(sampleHref)}">Request the sample <span aria-hidden="true">→</span></a>
      </div>
    </section>
  </main>

  <footer class="wrap">
    <span>© 2026 ReturnCheck · Live beta</span>
    <div class="footer-links">
      <a href="https://x.com/ReturnCheckAI">X</a>
      <a href="https://github.com/mangelmartinezfer-hue/returncheck">GitHub</a>
      <a href="${esc(base)}/data-policy">Data &amp; sources</a>
      <a href="mailto:${esc(contact)}">Contact</a>
      <a href="${esc(base)}/discovery.json">Discovery JSON</a>
    </div>
  </footer>
</body>
</html>`;

  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=300",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=()",
      "referrer-policy": "strict-origin-when-cross-origin",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
    },
  });
}
