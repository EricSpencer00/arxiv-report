import { ATTRIBUTION } from "./attribution";

function agentPrompt(origin: string): string {
  return `You now have access to the arxiv-report API for fresh research papers.
Base URL: ${origin}
To get papers: GET ${origin}/api/papers?interests=<comma-separated interest phrases>&days=7&max=10
- interests: required. Plain-English phrases, e.g. "formal methods,LLM verification"
- days: 1-30 lookback window (default 7). max: 1-10 results (default 10)
Response is JSON: papers[] with title, authors, abstract, tldr, relevance_blurb, score (0-1), abs_url.
For a ready-made Markdown digest instead: GET ${origin}/api/digest?interests=...
Papers below the relevance threshold are omitted — an empty list means nothing relevant appeared, not an error.
When the user asks for their research digest, call this API with their stated interests and present the results with links.`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function renderPage(origin: string): string {
  const prompt = agentPrompt(origin);
  const curl = `curl "${origin}/api/papers?interests=formal+methods,llm+verification&days=7&max=10"`;
  const js = `const res = await fetch("${origin}/api/papers?interests=formal+methods,llm+verification&days=7&max=10");
const data = await res.json();
for (const paper of data.papers) {
  console.log(paper.score.toFixed(2), paper.title, paper.abs_url);
}`;
  const py = `import requests

r = requests.get(
    "${origin}/api/papers",
    params={"interests": "formal methods,llm verification", "days": 7, "max": 10},
)
for paper in r.json()["papers"]:
    print(f"{paper['score']:.2f}", paper["title"], paper["abs_url"])`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>arxiv-report — interest-matched arXiv papers for your AI agent</title>
<meta name="description" content="Free, cached arXiv paper matching API for AI agents. Honest about relevance.">
<style>
  :root {
    color-scheme: light dark;
    --bg: #faf8f4;
    --ink: #201d18;
    --ink-dim: #5a5448;
    --rule: #ddd5c7;
    --accent: #8a3324;
    --surface: #f1ece1;
    --code-bg: #ece5d6;
    --link: #6b2d1f;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #17140f;
      --ink: #ece6d9;
      --ink-dim: #a99f8c;
      --rule: #3a352b;
      --accent: #e0a06f;
      --surface: #201c15;
      --code-bg: #221e16;
      --link: #e0a06f;
    }
  }

  * { box-sizing: border-box; }

  html { -webkit-text-size-adjust: 100%; }

  body {
    margin: 0;
    background: var(--bg);
    color: var(--ink);
    font-family: ui-serif, Georgia, "Iowan Old Style", "Palatino Linotype", serif;
    font-size: 18px;
    line-height: 1.6;
  }

  main {
    max-width: 760px;
    margin: 0 auto;
    padding: 4rem 1.5rem 6rem;
  }

  header.hero {
    border-bottom: 1px solid var(--rule);
    padding-bottom: 2.5rem;
    margin-bottom: 2.5rem;
  }

  .kicker {
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    font-size: 0.8rem;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--ink-dim);
    margin: 0 0 0.75rem;
  }

  h1 {
    font-size: 2.6rem;
    line-height: 1.1;
    margin: 0 0 0.75rem;
    font-weight: 600;
    letter-spacing: -0.01em;
  }

  .tagline {
    font-size: 1.2rem;
    color: var(--ink-dim);
    margin: 0 0 1.5rem;
    max-width: 46ch;
  }

  nav.toc {
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    font-size: 0.85rem;
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem 1.1rem;
  }

  nav.toc a { color: var(--ink-dim); }
  nav.toc a:hover { color: var(--accent); }

  h2 {
    font-family: ui-serif, Georgia, serif;
    font-size: 1.5rem;
    font-weight: 600;
    margin: 0 0 1.1rem;
    padding-top: 0.25rem;
  }

  h2 .num {
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    color: var(--accent);
    font-size: 1rem;
    margin-right: 0.6rem;
  }

  section {
    margin: 3.5rem 0;
    scroll-margin-top: 1.5rem;
  }

  p { margin: 0 0 1rem; }

  a { color: var(--link); text-decoration-thickness: 1px; text-underline-offset: 2px; }
  a:hover { text-decoration-thickness: 2px; }

  ol.steps {
    margin: 0;
    padding: 0;
    list-style: none;
    counter-reset: step;
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
  }

  ol.steps li {
    counter-increment: step;
    display: flex;
    gap: 1rem;
    align-items: baseline;
  }

  ol.steps li::before {
    content: counter(step);
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    font-size: 0.85rem;
    color: var(--accent);
    border: 1px solid var(--rule);
    border-radius: 50%;
    width: 1.6rem;
    height: 1.6rem;
    flex: none;
    display: flex;
    align-items: center;
    justify-content: center;
    margin-top: 0.15rem;
  }

  .fine-print {
    font-size: 0.92rem;
    color: var(--ink-dim);
    border-left: 2px solid var(--rule);
    padding-left: 1rem;
    margin-top: 1.5rem;
  }

#try-it-form {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
    align-items: end;
    background: var(--surface);
    border: 1px solid var(--rule);
    padding: 1.25rem;
    border-radius: 6px;
  }

  #try-it-form .field {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    min-width: 0;
  }

  #try-it-form .field.grow { flex: 1 1 260px; min-width: 200px; }

  #try-it-form label {
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--ink-dim);
  }

  #try-it-form input, #try-it-form select {
    font: inherit;
    font-size: 0.95rem;
    padding: 0.5rem 0.6rem;
    border: 1px solid var(--rule);
    border-radius: 4px;
    background: var(--bg);
    color: var(--ink);
    width: 100%;
    height: 2.4rem;
  }

  button {
    font: inherit;
    font-size: 0.95rem;
    padding: 0.55rem 1.1rem;
    background: var(--accent);
    color: var(--bg);
    border: none;
    border-radius: 4px;
    cursor: pointer;
  }
  button:hover { filter: brightness(1.08); }
  button:disabled { opacity: 0.6; cursor: default; }

  #results { margin-top: 1.5rem; }

  .status-line {
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    font-size: 0.85rem;
    color: var(--ink-dim);
  }

  .paper {
    border-bottom: 1px solid var(--rule);
    padding: 1.1rem 0;
  }
  .paper:last-child { border-bottom: none; }

  .paper-title-row {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
    align-items: baseline;
  }

  .paper-title { font-weight: 600; font-size: 1.05rem; }

  .score-badge {
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    font-size: 0.78rem;
    color: var(--accent);
    border: 1px solid var(--rule);
    border-radius: 3px;
    padding: 0.1rem 0.4rem;
    white-space: nowrap;
  }

  .paper-blurb { font-style: italic; color: var(--ink-dim); margin: 0.35rem 0; }
  .paper-abstract { color: var(--ink-dim); font-size: 0.95rem; margin: 0.35rem 0 0; }

  pre {
    background: var(--code-bg);
    border: 1px solid var(--rule);
    border-radius: 6px;
    padding: 2.6rem 1.1rem 1rem;
    overflow-x: auto;
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    font-size: 0.85rem;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .pre-wrap { position: relative; margin: 0 0 1.5rem; }

  .copy-btn {
    position: absolute;
    top: 0.6rem;
    right: 0.6rem;
    font-size: 0.72rem;
    padding: 0.3rem 0.6rem;
  }

  .snippet-label {
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    font-size: 0.78rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--ink-dim);
    margin: 0 0 0.4rem;
  }

  dl.faq { margin: 0; }
  dl.faq dt { font-weight: 600; margin-top: 1.25rem; }
  dl.faq dt:first-child { margin-top: 0; }
  dl.faq dd { margin: 0.25rem 0 0; color: var(--ink-dim); }

  footer {
    margin-top: 4rem;
    padding-top: 1.5rem;
    border-top: 1px solid var(--rule);
    font-size: 0.9rem;
    color: var(--ink-dim);
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  }

  footer p { margin: 0.35rem 0; }
</style>
</head>
<body>
<main>
  <header class="hero">
    <p class="kicker">arxiv-report</p>
    <h1>arxiv-report</h1>
    <p class="tagline">Interest-matched arXiv papers for your AI agent. Free, cached, honest about relevance.</p>
    <nav class="toc">
      <a href="#how-it-works">how it works</a>
      <a href="#try-it">try it</a>
      <a href="#for-your-agent">for your agent</a>
      <a href="#snippets">snippets</a>
      <a href="#faq">faq</a>
    </nav>
  </header>

  <section id="how-it-works">
    <h2><span class="num">01</span>How it works</h2>
    <ol class="steps">
      <li>Every day, we ingest all new arXiv submissions via the official arXiv API.</li>
      <li>Each paper is matched against your stated interests using 384-dimensional semantic embeddings, with a similarity threshold below which papers are dropped.</li>
      <li>If AI quota is exhausted, a deterministic keyword fallback takes over — so the API never breaks.</li>
    </ol>
    <p class="fine-print">
      Responses return at most 10 papers, looking back up to 30 days. Papers below the relevance
      threshold are dropped, not padded — an empty list means nothing relevant appeared, not an error.
    </p>
  </section>

  <section id="try-it">
    <h2><span class="num">02</span>Try it</h2>
    <form id="try-it-form" onsubmit="return false;">
      <div class="field grow">
        <label for="interests">interests</label>
        <input type="text" id="interests" placeholder="formal methods, LLM verification">
      </div>
      <div class="field">
        <label for="days">days</label>
        <select id="days">
          <option value="1">1</option>
          <option value="3">3</option>
          <option value="7" selected>7</option>
          <option value="14">14</option>
          <option value="30">30</option>
        </select>
      </div>
      <div class="field">
        <label for="max">max</label>
        <select id="max">
          <option value="1">1</option>
          <option value="5">5</option>
          <option value="10" selected>10</option>
        </select>
      </div>
      <button type="button" id="fetch-btn">Fetch papers</button>
    </form>
    <div id="results"></div>
  </section>

  <section id="for-your-agent">
    <h2><span class="num">03</span>For your agent</h2>
    <p>Paste this into your agent's context (a system prompt, tool description, or chat message) and it will know how to call this API on your behalf.</p>
    <div class="pre-wrap">
      <button class="copy-btn" data-copy-target="agent-prompt">Copy</button>
      <pre id="agent-prompt">${escapeHtml(prompt)}</pre>
    </div>
  </section>

  <section id="snippets">
    <h2><span class="num">04</span>Snippets</h2>
    <p class="snippet-label">curl</p>
    <div class="pre-wrap">
      <button class="copy-btn" data-copy-target="snippet-curl">Copy</button>
      <pre id="snippet-curl">${escapeHtml(curl)}</pre>
    </div>
    <p class="snippet-label">javascript (fetch)</p>
    <div class="pre-wrap">
      <button class="copy-btn" data-copy-target="snippet-js">Copy</button>
      <pre id="snippet-js">${escapeHtml(js)}</pre>
    </div>
    <p class="snippet-label">python (requests)</p>
    <div class="pre-wrap">
      <button class="copy-btn" data-copy-target="snippet-py">Copy</button>
      <pre id="snippet-py">${escapeHtml(py)}</pre>
    </div>
  </section>

  <section id="faq">
    <h2><span class="num">05</span>FAQ &amp; fair use</h2>
    <dl class="faq">
      <dt>Is this free?</dt>
      <dd>Yes. No API keys, no signup.</dd>
      <dt>How is it cached?</dt>
      <dd>Aggressively — identical queries are cached until the next daily ingest, so repeat requests cost us nothing. Please don't cache-bust with junk query variations.</dd>
      <dt>Where does the data come from?</dt>
      <dd>The official arXiv API. We serve metadata and abstracts only — no paywalled or full-text content.</dd>
      <dt>Where do links go?</dt>
      <dd>Every paper link points back to arxiv.org.</dd>
      <dt>Any rate limits?</dt>
      <dd>None enforced yet, but be reasonable with request rates.</dd>
    </dl>
  </section>

  <footer>
    <p>${escapeHtml(ATTRIBUTION)}</p>
    <p><a href="/api/openapi.json">/api/openapi.json</a> &middot; <a href="https://github.com/EricSpencer00/arxiv-report">source</a></p>
  </footer>
</main>

<script>
(function () {
  var origin = ${JSON.stringify(origin)};

  document.querySelectorAll(".copy-btn").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var targetId = btn.getAttribute("data-copy-target");
      var el = document.getElementById(targetId);
      if (!el) return;
      var text = el.textContent || "";
      var done = function () {
        var original = btn.textContent;
        btn.textContent = "Copied";
        setTimeout(function () { btn.textContent = original; }, 1500);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, done);
      } else {
        done();
      }
    });
  });

  var fetchBtn = document.getElementById("fetch-btn");
  var resultsEl = document.getElementById("results");
  var interestsEl = document.getElementById("interests");
  var daysEl = document.getElementById("days");
  var maxEl = document.getElementById("max");

  function clearResults() {
    while (resultsEl.firstChild) resultsEl.removeChild(resultsEl.firstChild);
  }

  function statusLine(text) {
    clearResults();
    var p = document.createElement("p");
    p.className = "status-line";
    p.textContent = text;
    resultsEl.appendChild(p);
  }

  function renderPapers(data, cacheStatus) {
    clearResults();

    var status = document.createElement("p");
    status.className = "status-line";
    var count = Array.isArray(data.papers) ? data.papers.length : 0;
    status.textContent = "ranking: " + data.ranking + "  |  " + count + " paper(s)" +
      (cacheStatus ? "  |  X-Cache: " + cacheStatus : "") +
      (data.note ? "  |  note: " + data.note : "");
    resultsEl.appendChild(status);

    if (!count) {
      var empty = document.createElement("p");
      empty.className = "status-line";
      empty.textContent = "No papers cleared the relevance threshold for this query.";
      resultsEl.appendChild(empty);
      return;
    }

    data.papers.forEach(function (paper) {
      var wrap = document.createElement("div");
      wrap.className = "paper";

      var titleRow = document.createElement("div");
      titleRow.className = "paper-title-row";

      var titleLink = document.createElement("a");
      titleLink.className = "paper-title";
      titleLink.href = paper.abs_url;
      titleLink.target = "_blank";
      titleLink.rel = "noopener noreferrer";
      titleLink.textContent = paper.title;
      titleRow.appendChild(titleLink);

      var badge = document.createElement("span");
      badge.className = "score-badge";
      badge.textContent = (typeof paper.score === "number" ? paper.score.toFixed(2) : "?");
      titleRow.appendChild(badge);

      wrap.appendChild(titleRow);

      if (paper.relevance_blurb) {
        var blurb = document.createElement("p");
        blurb.className = "paper-blurb";
        blurb.textContent = paper.relevance_blurb;
        wrap.appendChild(blurb);
      }

      var summaryText = paper.tldr || (paper.abstract ? paper.abstract.slice(0, 280) + (paper.abstract.length > 280 ? "…" : "") : "");
      if (summaryText) {
        var summary = document.createElement("p");
        summary.className = "paper-abstract";
        summary.textContent = summaryText;
        wrap.appendChild(summary);
      }

      resultsEl.appendChild(wrap);
    });
  }

  function runSearch() {
    var interests = interestsEl.value.trim();
    if (!interests) {
      statusLine("Enter at least one interest to search.");
      interestsEl.focus();
      return;
    }

    var days = daysEl.value;
    var max = maxEl.value;
    var url = origin + "/api/papers?interests=" + encodeURIComponent(interests) +
      "&days=" + encodeURIComponent(days) + "&max=" + encodeURIComponent(max);

    fetchBtn.disabled = true;
    statusLine("Loading…");

    fetch(url)
      .then(function (res) {
        var cacheStatus = res.headers.get("X-Cache");
        return res.json().then(function (data) {
          return { ok: res.ok, data: data, cacheStatus: cacheStatus };
        });
      })
      .then(function (result) {
        if (!result.ok) {
          statusLine("Error: " + (result.data && result.data.error ? result.data.error : "request failed"));
          return;
        }
        renderPapers(result.data, result.cacheStatus);
      })
      .catch(function (err) {
        statusLine("Error: " + (err && err.message ? err.message : "request failed"));
      })
      .then(function () {
        fetchBtn.disabled = false;
      });
  }

  fetchBtn.addEventListener("click", runSearch);
  interestsEl.addEventListener("keydown", function (e) {
    if (e.key === "Enter") {
      e.preventDefault();
      runSearch();
    }
  });
})();
</script>
</body>
</html>`;
}
