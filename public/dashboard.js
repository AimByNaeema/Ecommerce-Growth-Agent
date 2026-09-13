  /* ==========================================================================
     Navigation: one sidebar item = one page. Purely a display-state switch -
     no page here has its own URL/route, matching the previous tab-based
     dashboard's approach (this file is served as one static page by
     server.js's express.static, so client-side page switching is the right
     fit, not a new backend concern).
     ========================================================================== */
  const PAGE_MAP = {
    overview: { nav: 'navOverview', page: 'pageOverview', title: 'Overview', subtitle: 'Everything below reflects a real run against your connected Shopify store — nothing here is sample data.' },
    ask: { nav: 'navAsk', page: 'pageAsk', title: 'Ask', subtitle: 'A direct conversation with your assistant, grounded in your business configuration.' },
    specialists: { nav: 'navSpecialists', page: 'pageSpecialists', title: 'Run a Specialist', subtitle: 'Run one specialist directly against a specific objective you write.' },
    orchestrator: { nav: 'navOrchestrator', page: 'pageOrchestrator', title: 'Chief Orchestrator', subtitle: 'Give the Chief a goal — it decides which specialist(s) to use.' },
    approvals: { nav: 'navApprovals', page: 'pageApprovals', title: 'Approval Center', subtitle: 'Every human sign-off the Chief has requested this session.' },
    autonomy: { nav: 'navAutonomy', page: 'pageAutonomy', title: 'Autonomy', subtitle: 'Read-only: whether autonomy is on, what is scheduled, recent cycles, and what is waiting for your approval.' },
    workflow: { nav: 'navWorkflow', page: 'pageWorkflow', title: 'How AVENLY AI works', subtitle: 'Your AI sales team, and where you stay in control.' },
    history: { nav: 'navHistory', page: 'pageHistory', title: 'History', subtitle: 'Saved results from past runs, stored on the server - these survive a refresh.' },
  };

  const pageTitleEl = document.getElementById('pageTitle');
  const pageSubtitleEl = document.getElementById('pageSubtitle');

  function selectPage(name) {
    const entry = PAGE_MAP[name];
    if (!entry) return;
    Object.entries(PAGE_MAP).forEach(([key, cfg]) => {
      const active = key === name;
      document.getElementById(cfg.nav).setAttribute('aria-current', active ? 'page' : 'false');
      document.getElementById(cfg.page).classList.toggle('active', active);
    });
    pageTitleEl.textContent = entry.title;
    pageSubtitleEl.textContent = entry.subtitle;
    if (name === 'approvals') renderApprovalList();
    if (name === 'workflow') loadWorkflow();
    if (name === 'autonomy') loadAutonomy();
    if (name === 'history') renderHistoryList();
    // loadOverview() is declared further down this file (function declarations are
    // hoisted), and is also called once at the bottom for the initial page load,
    // since Overview is the page that starts active.
    if (name === 'overview') loadOverview();
  }

  Object.keys(PAGE_MAP).forEach((key) => {
    document.getElementById(PAGE_MAP[key].nav).addEventListener('click', () => selectPage(key));
  });

  /* ---------- API access key (see security/serverAccessControl.js) ----------
     Every server endpoint this page calls requires an "Authorization: Bearer <key>"
     header. The key is NOT baked into this page - that would put it in the hands of
     anyone who can load the page, which is exactly the boundary the server added. It
     is asked for once and kept in sessionStorage, so it lives only in this browser
     tab's session and is gone when the tab closes.

     apiFetch is the single place that header is attached; every call below goes
     through it rather than calling fetch directly. A 401 clears the stored key and
     asks again on the next call, so a wrong or rotated key self-corrects instead of
     failing silently forever. */
  const API_KEY_STORAGE_KEY = 'agentApiKey';

  function readStoredApiKey() {
    try {
      return sessionStorage.getItem(API_KEY_STORAGE_KEY) || '';
    } catch (err) {
      // Private-browsing / blocked storage: fall back to asking every time rather
      // than breaking the page outright.
      return '';
    }
  }

  function storeApiKey(key) {
    try {
      sessionStorage.setItem(API_KEY_STORAGE_KEY, key);
    } catch (err) {
      /* Not fatal - the key is still used for this call, just not remembered. */
    }
  }

  function clearStoredApiKey() {
    try {
      sessionStorage.removeItem(API_KEY_STORAGE_KEY);
    } catch (err) {
      /* Nothing to clear. */
    }
  }

  function ensureApiKey() {
    let key = readStoredApiKey();
    if (!key) {
      key = (window.prompt('Enter the API key for this agent server (AGENT_API_KEY):') || '').trim();
      if (key) storeApiKey(key);
    }
    return key;
  }

  async function apiFetch(url, options) {
    const opts = options || {};
    const key = ensureApiKey();
    const headers = Object.assign({}, opts.headers || {});
    if (key) headers.Authorization = 'Bearer ' + key;

    const res = await fetch(url, Object.assign({}, opts, { headers }));
    if (res.status === 401) clearStoredApiKey();
    return res;
  }

  /* ---------- Shared helpers (escaping, JSON highlighting) ---------- */
  function escapeHtml(str) {
    return String(str).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  }

  function highlightJson(obj) {
    const json = escapeHtml(JSON.stringify(obj, null, 2));
    return json
      .replace(/(&quot;[^&]*?&quot;)(:)/g, '<span class="jk">$1</span><span class="jp">$2</span>')
      .replace(/: (&quot;[^&]*?&quot;)/g, ': <span class="js">$1</span>');
  }

  /* ==========================================================================
     Real-data chart renderer. Draws a horizontal bar chart from whatever
     numeric array a tool actually returned - never fabricates a value, and
     renders nothing at all when no real chartable array is found. The fields
     it looks for (value / available / amountSpent / ordersCount) come
     straight from tools/analyticsDataTool.js's own actual_metrics shapes
     (orderToActualMetric, inventoryItemToActualMetric, customerToActualMetric)
     - so a real Shopify sales/inventory/customers pull draws a real chart of
     its own real numbers, and a specialist with no such data simply shows no
     chart, honestly.
     ========================================================================== */
  const CHART_VALUE_FIELDS = ['value', 'available', 'amountSpent', 'ordersCount'];
  const CHART_LABEL_FIELDS = ['name', 'orderId', 'sku', 'id'];

  function looksChartable(item) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
    return CHART_VALUE_FIELDS.some((f) => typeof item[f] === 'number' && Number.isFinite(item[f]));
  }

  // Bounded recursive search (depth <= 5, nodes <= 3000) for the first array whose
  // items are real actual_metrics-shaped records with a numeric value. Bounded so a
  // large or unusual real response can never make this scan expensive or infinite.
  function findChartableArray(node, depth, budget) {
    if (!node || typeof node !== 'object' || depth > 5 || budget.count > 3000) return null;
    budget.count += 1;

    if (Array.isArray(node)) {
      if (node.length > 0 && node.filter(looksChartable).length >= Math.ceil(node.length * 0.6)) {
        return node.filter(looksChartable);
      }
      for (const item of node) {
        const found = findChartableArray(item, depth + 1, budget);
        if (found) return found;
      }
      return null;
    }

    for (const key of Object.keys(node)) {
      const found = findChartableArray(node[key], depth + 1, budget);
      if (found) return found;
    }
    return null;
  }

  function extractChartPoints(root) {
    const found = findChartableArray(root, 0, { count: 0 });
    if (!found || found.length === 0) return null;

    const valueField = CHART_VALUE_FIELDS.find((f) => typeof found[0][f] === 'number');
    if (!valueField) return null;

    const total = found.length;
    const points = found.slice(0, 12).map((item, i) => {
      const labelField = CHART_LABEL_FIELDS.find((f) => item[f] !== undefined && item[f] !== null);
      return {
        label: labelField ? String(item[labelField]) : 'Item ' + (i + 1),
        value: item[valueField],
        unit: item.unit || '',
      };
    });
    return { points, truncated: total > 12, total, field: valueField };
  }

  // Renders a minimal horizontal-bar SVG chart into `container` from real
  // {label, value, unit} points - no charting library, so this file stays fully
  // self-contained and dependency-free like the rest of the dashboard.
  function renderMetricChart(container, chartData, captionPrefix) {
    if (!chartData) return;
    const { points, truncated, total, field } = chartData;
    const maxValue = Math.max(...points.map((p) => Math.abs(p.value)), 1);
    const rowHeight = 22;
    const chartWidth = 560;
    const labelWidth = 108;
    const barAreaWidth = chartWidth - labelWidth - 60;
    const height = points.length * rowHeight + 8;

    const bars = points.map((p, i) => {
      const y = i * rowHeight;
      const barWidth = Math.max((Math.abs(p.value) / maxValue) * barAreaWidth, 2);
      const valueLabel = (Number.isInteger(p.value) ? p.value : p.value.toFixed(2)) + (p.unit ? ' ' + p.unit : '');
      return (
        '<text class="metric-bar-label" x="0" y="' + (y + rowHeight / 2 + 3) + '">' +
        escapeHtml(p.label.length > 14 ? p.label.slice(0, 13) + '…' : p.label) + '</text>' +
        '<rect class="metric-bar-track" x="' + labelWidth + '" y="' + (y + 3) + '" width="' + barAreaWidth + '" height="' + (rowHeight - 8) + '" rx="3"></rect>' +
        '<rect class="metric-bar" x="' + labelWidth + '" y="' + (y + 3) + '" width="' + barWidth + '" height="' + (rowHeight - 8) + '" rx="3"></rect>' +
        '<text class="metric-bar-value" x="' + (labelWidth + barAreaWidth + 8) + '" y="' + (y + rowHeight / 2 + 3) + '">' + escapeHtml(valueLabel) + '</text>'
      );
    }).join('');

    const caption = (captionPrefix || 'Real values from this run') + ' (field: ' + field + (truncated ? ', showing 12 of ' + total : '') + ')';

    const wrap = document.createElement('div');
    wrap.className = 'metric-chart';
    wrap.innerHTML =
      '<div class="metric-chart-caption">' + escapeHtml(caption) + '</div>' +
      '<svg viewBox="0 0 ' + chartWidth + ' ' + height + '" role="img" aria-label="Chart of real values from this run">' + bars + '</svg>';
    container.appendChild(wrap);
  }

  /* ---------- Ask page (direct AI chat) ---------- */
  const form = document.getElementById('composer');
  const input = document.getElementById('question');
  const sendBtn = document.getElementById('sendBtn');
  const conversation = document.getElementById('conversation');
  const intro = document.getElementById('intro');
  const statusPill = document.getElementById('statusPill');
  const statusText = document.getElementById('statusText');

  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 140) + 'px';
  });

  document.querySelectorAll('#pageAsk .suggestion').forEach((btn) => {
    btn.addEventListener('click', () => {
      input.value = btn.textContent;
      input.dispatchEvent(new Event('input'));
      input.focus();
    });
  });

  function setStatus(state, text) {
    statusPill.dataset.state = state;
    statusText.textContent = text;
  }

  function noteActivity(text) {
    const el = document.getElementById('statLastActivity');
    if (el) el.textContent = text;
  }

  function addMessage(role, text) {
    if (intro.parentNode) intro.remove();
    const wrap = document.createElement('div');
    wrap.className = 'msg ' + role;
    const label = document.createElement('div');
    label.className = 'msg-label';
    label.textContent = role === 'user' ? 'You' : 'Assistant';
    const bubble = document.createElement('div');
    bubble.className = 'msg-bubble';
    bubble.textContent = text;
    wrap.appendChild(label);
    wrap.appendChild(bubble);
    conversation.appendChild(wrap);
    conversation.scrollTop = conversation.scrollHeight;
    return bubble;
  }

  function addThinking() {
    const wrap = document.createElement('div');
    wrap.className = 'msg assistant';
    wrap.id = 'thinkingMsg';
    const label = document.createElement('div');
    label.className = 'msg-label';
    label.textContent = 'Assistant';
    const bubble = document.createElement('div');
    bubble.className = 'msg-bubble';
    bubble.innerHTML = '<span class="thinking-dots"><span></span><span></span><span></span></span>';
    wrap.appendChild(label);
    wrap.appendChild(bubble);
    conversation.appendChild(wrap);
    conversation.scrollTop = conversation.scrollHeight;
  }

  function removeThinking() {
    const el = document.getElementById('thinkingMsg');
    if (el) el.remove();
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const question = input.value.trim();
    if (!question) return;

    addMessage('user', question);
    input.value = '';
    input.style.height = 'auto';
    sendBtn.disabled = true;
    setStatus('thinking', 'Thinking…');
    addThinking();

    try {
      const res = await apiFetch('/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: question }),
      });
      const data = await res.json().catch(() => ({}));
      removeThinking();

      if (!res.ok) {
        addMessage('assistant', data.error || 'Something went wrong reaching the assistant.').classList.add('error');
        setStatus('error', 'Connection issue');
        return;
      }
      addMessage('assistant', data.reply || 'No reply received.');
      // Back to the provider state the server reported - not a hard-coded claim.
      setStatus(aiProviderPill.state, aiProviderPill.text);
      noteActivity('Asked a question just now');
    } catch (err) {
      removeThinking();
      addMessage('assistant', 'Could not reach the server. Check that it is running.').classList.add('error');
      setStatus('error', 'Offline');
    } finally {
      sendBtn.disabled = false;
      input.focus();
    }
  });

  /* ---------- Specialists page + Overview page (both call the real /run endpoint) ---------- */
  const SPECIALISTS = [
    { id: 'research', name: 'Research', desc: 'Market, competitor & customer research', objective: 'Summarize what real research evidence exists on file about our target customers and competitors.' },
    { id: 'product', name: 'Product', desc: 'Catalog analysis & opportunity research', objective: 'Pull our real product catalog from Shopify and flag any opportunity signals.' },
    { id: 'seo', name: 'SEO', desc: 'Search visibility & keyword research', objective: 'Review our current listings for SEO gaps based on real product/listing data.' },
    { id: 'listing', name: 'Listing', desc: 'Listing content & optimization', objective: 'Suggest structural improvements to our real product listings.' },
    { id: 'marketing', name: 'Marketing', desc: 'Campaign ideas, copy & strategy', objective: 'Propose a marketing angle grounded in our real business configuration.' },
    { id: 'social_advertising', name: 'Social & Advertising', desc: 'Social content & paid ads', objective: 'Suggest a social content idea grounded in our real product catalog.' },
    { id: 'analytics', name: 'Analytics & Optimization', desc: 'Store performance & growth metrics', objective: 'Pull a real sales, product, and inventory snapshot from Shopify.' },
  ];

  const grid = document.getElementById('specialistGrid');
  const objective = document.getElementById('objective');
  const runBtn = document.getElementById('runBtn');
  const runHint = document.getElementById('runHint');
  const resultArea = document.getElementById('resultArea');
  let activeSpecialist = null;

  SPECIALISTS.forEach((sp) => {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'specialist-card';
    card.setAttribute('aria-pressed', 'false');
    card.innerHTML = '<div class="specialist-name">' + sp.name + '</div><div class="specialist-desc">' + sp.desc + '</div>';
    card.addEventListener('click', () => {
      document.querySelectorAll('.specialist-card').forEach((c) => c.setAttribute('aria-pressed', 'false'));
      card.setAttribute('aria-pressed', 'true');
      activeSpecialist = sp;
      objective.value = sp.objective;
      runBtn.disabled = false;
      runBtn.textContent = 'Run ' + sp.name;
      runHint.textContent = '';
    });
    grid.appendChild(card);
  });

  function renderResult(statusLabel, payload, titleOverride) {
    const card = document.createElement('div');
    card.className = 'result-card';

    const header = document.createElement('div');
    header.className = 'result-header';
    header.innerHTML =
      '<span class="result-title">' + escapeHtml(titleOverride || (activeSpecialist ? activeSpecialist.name : 'Result')) + '</span>' +
      '<span class="result-status ' + statusLabel + '">' + statusLabel + '</span>';
    card.appendChild(header);

    // The plain-language answer (server-computed, see agent/core/resultSummary.js) is
    // the primary thing shown - the raw internal JSON is demoted to a collapsed
    // "Technical details" block below it, never the final answer on its own.
    const summaryLine = document.createElement('p');
    summaryLine.className = 'result-summary';
    summaryLine.textContent =
      (payload && typeof payload.summary === 'string' && payload.summary) || agentSummaryLine(statusLabel, payload);
    card.appendChild(summaryLine);

    const details = document.createElement('details');
    details.className = 'result-details';
    const detailsLabel = document.createElement('summary');
    detailsLabel.textContent = 'Technical details';
    details.appendChild(detailsLabel);

    const body = document.createElement('pre');
    body.className = 'result-body';
    body.innerHTML = highlightJson(payload);
    details.appendChild(body);

    card.appendChild(details);

    const chartData = extractChartPoints(payload && payload.outputs ? payload.outputs : payload);
    if (chartData) {
      const chartWrap = document.createElement('div');
      chartWrap.className = 'result-chart-wrap';
      renderMetricChart(chartWrap, chartData, 'Real data from this run');
      card.appendChild(chartWrap);
    }

    resultArea.innerHTML = '';
    resultArea.appendChild(card);
  }

  // Runs one specialist for real via POST /run - shared by both the Specialists
  // page's Run button and each Overview agent card's own Run button, so there is
  // exactly one code path that ever calls this endpoint.
  async function runSpecialist(specialistId, objectiveText) {
    const res = await apiFetch('/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ specialist: specialistId, objective: objectiveText }),
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, data };
  }

  runBtn.addEventListener('click', async () => {
    if (!activeSpecialist) return;
    runBtn.disabled = true;
    runBtn.textContent = 'Running…';
    runHint.textContent = '';
    resultArea.innerHTML = '<p class="empty-result">Running ' + activeSpecialist.name + '…</p>';

    try {
      const { ok, data } = await runSpecialist(activeSpecialist.id, objective.value.trim());
      if (!ok) {
        renderResult('error', data);
      } else {
        const label = data && data.status === 'partial' ? 'partial' : 'success';
        renderResult(label, data);
        noteActivity('Ran ' + activeSpecialist.name + ' just now');
        markAgentRun(activeSpecialist.id, label, data);
      }
    } catch (err) {
      renderResult('error', { error: 'Could not reach the server. Check that it is running.' });
    } finally {
      runBtn.disabled = false;
      runBtn.textContent = 'Run ' + activeSpecialist.name;
    }
  });

  /* ---------- Overview page: compact specialist summary ---------- */
  const agentRunState = {}; // specialistId -> { status, data } for THIS browser session
  let runsCompletedCount = 0;

  function agentSummaryLine(status, data) {
    if (data && typeof data.summary === 'string' && data.summary) return data.summary;
    if (status === 'error') return data && data.error ? data.error : 'The run failed.';
    const outputs = data && data.outputs;
    if (!outputs) return 'Completed, but returned no output data.';
    if (typeof outputs.summary === 'string' && outputs.summary) return outputs.summary;
    if (outputs.result && typeof outputs.result === 'object') {
      const recordCount = typeof outputs.recordCount === 'number' ? outputs.recordCount : null;
      if (recordCount !== null) return recordCount + ' real record(s) retrieved from Shopify.';
    }
    return 'Completed — see full result on the Run a Specialist page.';
  }

  // Opens the existing Run a Specialist page with one specialist selected, by clicking
  // that page's OWN card - so the objective prefill, the enabled Run button and the
  // selection state all come from the existing code path, never a parallel one. Nothing
  // is executed here; the owner still presses Run.
  function openSpecialistOnRunPage(specialistId) {
    selectPage('specialists');
    const index = SPECIALISTS.findIndex((sp) => sp.id === specialistId);
    const cards = document.querySelectorAll('.specialist-card');
    if (index >= 0 && cards[index]) cards[index].click();
  }

  function markAgentRun(specialistId, status, data) {
    if (!agentRunState[specialistId]) runsCompletedCount += 1;
    agentRunState[specialistId] = { status, data };
    const runsEl = document.getElementById('statRunsCount');
    if (runsEl) runsEl.textContent = runsCompletedCount + ' / ' + SPECIALISTS.length;
  }

  /* ---------- Chief Orchestrator page ----------
     The human never picks a specialist here - a free-text goal goes to POST /orchestrate,
     which hands it straight to the real orchestratorExecutionContract.runOrchestratorContract
     (see server.js). Any step the Chief cannot run on its own (approval_required /
     externally_executable, per CLAUDE.md rule 7) comes back with a pending approval instead of
     a result - this page renders an inline Approve/Reject control for exactly that step, posts
     the decision to POST /orchestrate/approve (the only path that can actually run it), and
     also logs the approval into approvalLog below so the Approval Center page shows the same
     real record. Nothing here executes anything itself. */
  const chiefObjective = document.getElementById('chiefObjective');
  const chiefRunBtn = document.getElementById('chiefRunBtn');
  const chiefRunHint = document.getElementById('chiefRunHint');
  const chiefResultArea = document.getElementById('chiefResultArea');
  let currentRunId = null;

  function stepStatusLabel(step) {
    if (!step) return 'error';
    if (step.completion_state === 'complete') return 'success';
    if (step.completion_state === 'blocked' || step.completion_state === 'failed') return 'error';
    return 'partial';
  }

  function pendingApprovalsForStep(step) {
    if (!step || !Array.isArray(step.approvals)) return [];
    return step.approvals.filter((a) => a && a.status === 'required' && a.approval_request_id);
  }

  function planStepTitle(step, index) {
    const sel = step && step.selected_specialist;
    if (sel && typeof sel === 'object') return sel.title || sel.id || 'Step ' + (index + 1);
    if (typeof sel === 'string' && sel) return sel;
    return 'Step ' + (index + 1);
  }

  /* ---------- Approval log: the single real source of truth for the Approval
     Center page, populated only from actual /orchestrate and /orchestrate/approve
     responses - never seeded with placeholder rows. Session-only, exactly like
     orchestratorRuns on the server (see server.js) - a reload clears it, and the
     UI says so (see #approvalSessionNote). ---------- */
  const approvalLog = []; // { runId, approvalId, classification, title, reason, status, decidedBy, decidedAt, notes }

  // What each gated classification means for the owner, from approvals/approvalArchitecture.js's
  // four classes (CLAUDE.md rule 7): both gated classes wait for an explicit human decision.
  const APPROVAL_CLASS_MEANING = {
    approval_required: 'A consequential step - it does not run until you approve it.',
    externally_executable: 'Would act on an external platform - it does not run until you approve it.',
  };

  function upsertApprovalLog(entry) {
    const existing = approvalLog.find((a) => a.approvalId === entry.approvalId);
    if (existing) Object.assign(existing, entry);
    else approvalLog.push(entry);
    refreshApprovalBadges();
  }

  function refreshApprovalBadges() {
    const pendingCount = approvalLog.filter((a) => a.status === 'pending').length;
    const badge = document.getElementById('approvalNavBadge');
    badge.hidden = pendingCount === 0;
    badge.textContent = String(pendingCount);
    const statEl = document.getElementById('statPendingApprovals');
    if (statEl) statEl.textContent = String(pendingCount);
    const note = document.getElementById('approvalSessionNote');
    if (note) {
      note.textContent = approvalLog.length === 0
        ? 'No approvals yet this session — they will appear here the moment the Chief asks for one.'
        : approvalLog.length + ' approval(s) recorded this session (' + pendingCount + ' still pending).';
    }
  }


  // ---------------------------------------------------------------------------------
  // SIGNED HUMAN APPROVAL
  // ---------------------------------------------------------------------------------
  //
  // The server will not accept a decision without an Ed25519 signature produced with a key
  // it does not hold. This walks the person through it: ask the server for the exact
  // payload to sign, show it, take back the base64 signature they produced offline.
  //
  // NO PRIVATE KEY IS EVER ENTERED HERE, held here, or sent anywhere. The signing happens
  // entirely on the approver's own machine; this page only ever sees the public payload and
  // the resulting signature.
  async function collectSignedApproval({ approvalId, decision, decidedBy }) {
    const params =
      'approvalId=' + encodeURIComponent(approvalId) +
      '&decision=' + encodeURIComponent(decision) +
      '&decidedBy=' + encodeURIComponent(decidedBy);

    let challenge;
    try {
      const res = await apiFetch('/approval-challenge?' + params);
      challenge = await res.json().catch(function () { return {}; });
      if (!res.ok) return { ok: false, error: challenge.error || 'Could not obtain an approval challenge.' };
    } catch (err) {
      return { ok: false, error: 'Could not reach the server for an approval challenge.' };
    }

    var instructions = (challenge.signing_instructions || []).join('\n\n');
    var signature = window.prompt(
      'SIGN THIS APPROVAL\n\n' +
        'On the machine holding your approval private key, sign this EXACT payload and paste the base64 signature below.\n\n' +
        '--- payload ---\n' + challenge.payload + '\n--- end payload ---\n\n' +
        instructions + '\n\nBase64 signature:'
    );
    if (!signature || !signature.trim()) return { ok: false, error: 'Approval cancelled - no signature was provided.' };
    return { ok: true, nonce: challenge.nonce, signature: signature.trim() };
  }

  function attachApprovalPanel(card, header, body, approval, runId, stepTitle) {
    const panel = document.createElement('div');
    panel.className = 'approval-panel';
    panel.dataset.approvalId = approval.approval_request_id;
    panel.innerHTML =
      '<span class="approval-label">Waiting for your approval</span>' +
      '<p class="approval-reason">This step is classified <strong>' +
      escapeHtml(String(approval.classification || 'approval_required')) +
      '</strong> and will not run until you approve it here.</p>' +
      '<textarea class="approval-notes" placeholder="Optional note (why you approved or rejected this)"></textarea>' +
      '<div class="approval-actions">' +
      '<button class="approve-btn" type="button">Approve</button>' +
      '<button class="reject-btn" type="button">Reject</button>' +
      '</div>';

    upsertApprovalLog({
      runId,
      approvalId: approval.approval_request_id,
      classification: approval.classification || 'approval_required',
      title: stepTitle,
      reason: 'This step is classified ' + (approval.classification || 'approval_required') + ' and needs your sign-off before it runs.',
      status: 'pending',
      decidedBy: null,
      decidedAt: null,
      notes: null,
    });

    const approveBtn = panel.querySelector('.approve-btn');
    const rejectBtn = panel.querySelector('.reject-btn');
    const notesField = panel.querySelector('.approval-notes');

    async function decide(decision) {
      approveBtn.disabled = true;
      rejectBtn.disabled = true;
      const signed = await collectSignedApproval({
        approvalId: approval.approval_request_id,
        decision,
        decidedBy: 'naeema',
      });
      if (!signed.ok) {
        approveBtn.disabled = false;
        rejectBtn.disabled = false;
        panel.querySelector('.approval-reason').textContent = signed.error;
        return;
      }
      try {
        const res = await apiFetch('/orchestrate/approve', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            runId,
            approvalId: approval.approval_request_id,
            decision,
            decidedBy: 'naeema',
            notes: notesField.value.trim() || undefined,
            nonce: signed.nonce,
            signature: signed.signature,
          }),
        });
        const data = await res.json().catch(() => ({}));

        if (!res.ok) {
          panel.innerHTML = '<p class="approval-decided rejected">' + escapeHtml(data.error || 'Could not record that decision.') + '</p>';
          return;
        }

        panel.classList.add(decision === 'approved' ? 'decided-approved' : 'decided-rejected');
        panel.innerHTML =
          '<p class="approval-decided ' + (decision === 'approved' ? 'approved' : 'rejected') + '">' +
          (decision === 'approved' ? 'Approved' : 'Rejected') +
          (data.task_status ? ' — plan status: ' + escapeHtml(String(data.task_status)) : '') +
          '</p>';

        upsertApprovalLog({
          runId,
          approvalId: approval.approval_request_id,
          classification: approval.classification || 'approval_required',
          title: stepTitle,
          reason: 'Decided from the Chief Orchestrator page.',
          status: decision,
          decidedBy: 'naeema',
          decidedAt: new Date().toISOString(),
          notes: notesField.value.trim() || null,
        });

        if (data.step) {
          const newBody = document.createElement('pre');
          newBody.className = 'result-body';
          newBody.innerHTML = highlightJson(data.step);
          body.replaceWith(newBody);
          const newLabel = stepStatusLabel(data.step);
          const statusEl = header.querySelector('.result-status');
          statusEl.className = 'result-status ' + newLabel;
          statusEl.textContent = newLabel;
        }

        noteActivity('Decided an approval (' + decision + ') just now');
      } catch (err) {
        panel.innerHTML = '<p class="approval-decided rejected">Could not reach the server. Check that it is running.</p>';
      }
    }

    approveBtn.addEventListener('click', () => decide('approved'));
    rejectBtn.addEventListener('click', () => decide('rejected'));
    card.appendChild(panel);
  }

  function renderPlanStep(step, index, runId) {
    const card = document.createElement('div');
    card.className = 'result-card plan-step-card';

    const title = planStepTitle(step, index);
    const label = stepStatusLabel(step);

    const header = document.createElement('div');
    header.className = 'result-header';
    header.innerHTML =
      '<span class="result-title">' + escapeHtml(title) + '</span>' +
      '<span class="result-status ' + label + '">' + label + '</span>';
    card.appendChild(header);

    const summaryLine = document.createElement('p');
    summaryLine.className = 'result-summary';
    summaryLine.textContent = (step && typeof step.summary === 'string' && step.summary) || agentSummaryLine(label, step);
    card.appendChild(summaryLine);

    const details = document.createElement('details');
    details.className = 'result-details';
    const detailsLabel = document.createElement('summary');
    detailsLabel.textContent = 'Technical details';
    details.appendChild(detailsLabel);

    const body = document.createElement('pre');
    body.className = 'result-body';
    body.innerHTML = highlightJson(step);
    details.appendChild(body);
    card.appendChild(details);

    const chartData = extractChartPoints(step && step.outputs ? step.outputs : null);
    if (chartData) {
      const chartWrap = document.createElement('div');
      chartWrap.className = 'result-chart-wrap';
      renderMetricChart(chartWrap, chartData, 'Real data from this step');
      card.appendChild(chartWrap);
    }

    pendingApprovalsForStep(step).forEach((approval) => attachApprovalPanel(card, header, body, approval, runId, title));

    return card;
  }

  function renderClarification(routing) {
    const card = document.createElement('div');
    card.className = 'result-card';

    let bodyHtml = '<p class="approval-reason" style="padding:16px 16px 0;margin:0;">' +
      escapeHtml(routing.reason || 'The Chief needs more detail before it can route this goal.') + '</p>';

    if (routing.unmatched_segment) {
      bodyHtml += '<p class="approval-reason" style="padding:8px 16px 0;margin:0;color:var(--ink-soft);">' +
        'The part it could not place: “' + escapeHtml(String(routing.unmatched_segment)) + '”</p>';
    }

    if (Array.isArray(routing.candidates) && routing.candidates.length) {
      bodyHtml += '<pre class="result-body">' + highlightJson(routing.candidates) + '</pre>';
    } else {
      bodyHtml += '<div style="height:16px;"></div>';
    }

    card.innerHTML =
      '<div class="result-header"><span class="result-title">Needs clarification</span>' +
      '<span class="result-status partial">' + escapeHtml(String(routing.clarification_type || 'clarification_required')) + '</span></div>' +
      bodyHtml;
    chiefResultArea.appendChild(card);

    const tip = document.createElement('p');
    tip.className = 'empty-result';
    tip.textContent = 'Tip: give the Chief one clear task per sentence, aimed at what to do (e.g. "Suggest one SEO fix" or "Draft a marketing angle for our bestseller") — instructions about not taking actions without approval aren’t needed, the Chief already asks before anything consequential.';
    chiefResultArea.appendChild(tip);
  }

  function renderChiefPlan(result, runId) {
    chiefResultArea.innerHTML = '';
    const routing = result.routing || {};
    const plan = Array.isArray(routing.plan) ? routing.plan : [];

    if (routing.status) {
      const statusNote = document.createElement('p');
      statusNote.className = 'run-hint';
      statusNote.style.margin = '0 0 14px';
      statusNote.textContent = 'Routing status: ' + routing.status;
      chiefResultArea.appendChild(statusNote);
    }

    if (routing.status === 'clarification_required') {
      renderClarification(routing);
      return;
    }

    if (!plan.length) {
      const empty = document.createElement('p');
      empty.className = 'empty-result';
      empty.textContent = 'The Chief did not produce a plan for this goal — try rephrasing it more specifically.';
      chiefResultArea.appendChild(empty);
      return;
    }

    plan.forEach((step, index) => chiefResultArea.appendChild(renderPlanStep(step, index, runId)));
  }

  /* ---------- Command Center session ----------
     Turns this page from a one-shot question into a conversation the user can continue.
     The Chief itself is unchanged: a turn posts to /session/:id/message, which resolves
     any reference to an earlier result and then calls the SAME orchestrator /orchestrate
     already uses. This file adds no routing of its own.

     A session is created on the first goal. Everything a turn produces - the plan, the
     numbered results, what it is waiting on - comes back on the session object and is
     rendered from it, so a refresh or a resume shows exactly the same state. */
  let currentSession = null;

  function renderSessionState() {
    const bar = document.getElementById('sessionBar');
    const goalCard = document.getElementById('sessionGoalCard');
    const statusTag = document.getElementById('sessionStatusTag');
    const conversation = document.getElementById('sessionConversation');
    const nextActions = document.getElementById('sessionNextActions');

    if (!currentSession) {
      goalCard.hidden = true;
      conversation.hidden = true;
      nextActions.hidden = true;
      statusTag.hidden = true;
      return;
    }

    goalCard.hidden = false;
    document.getElementById('sessionGoal').textContent = currentSession.original_goal || '';
    const results = (currentSession.specialist_results || []).length;
    document.getElementById('sessionMeta').textContent =
      (currentSession.channel ? 'Channel: ' + currentSession.channel + ' · ' : '') +
      (currentSession.run_refs || []).length + ' run(s) · ' +
      results + ' numbered result(s)' +
      (results > 0 ? ' — refer to one by number, e.g. "deep research #1"' : '');

    statusTag.hidden = false;
    statusTag.textContent = String(currentSession.status || '').replace(/_/g, ' ');

    // The conversation, rendered from the stored messages so a resumed session looks
    // identical to a live one.
    conversation.hidden = false;
    conversation.innerHTML = '';
    (currentSession.messages || []).forEach((message) => {
      const row = document.createElement('div');
      row.className = 'session-message ' + (message.role === 'user' ? 'from-user' : 'from-chief');
      const who = document.createElement('div');
      who.className = 'session-message-role';
      who.textContent = message.role === 'user' ? 'You' : 'Chief';
      const text = document.createElement('div');
      text.className = 'session-message-text';
      text.textContent = message.text;
      row.appendChild(who);
      row.appendChild(text);
      conversation.appendChild(row);
    });

    // Numbered results - what "#3" refers to. Shown so the reference is discoverable
    // rather than something the user has to remember.
    if (results > 0) {
      const list = document.createElement('div');
      list.className = 'panel-card';
      const label = document.createElement('div');
      label.className = 'panel-note';
      label.textContent = 'Numbered results in this session:';
      list.appendChild(label);
      currentSession.specialist_results.forEach((result) => {
        const row = document.createElement('div');
        row.className = 'session-result-row';
        const name = document.createElement('span');
        name.className = 'session-result-name';
        name.textContent = '#' + result.ref + '  ' + result.label;
        row.appendChild(name);
        if (result.channel) {
          const tag = document.createElement('span');
          tag.className = 'section-channel-tag';
          tag.textContent = result.channel;
          row.appendChild(tag);
        }
        list.appendChild(row);
      });
      conversation.appendChild(list);
    }

    // Pending items and next actions, each stating its own basis.
    const pending = currentSession.pending_items || [];
    const actions = currentSession.next_actions || [];
    if (pending.length > 0 || actions.length > 0) {
      nextActions.hidden = false;
      nextActions.innerHTML = '';
      const card = document.createElement('div');
      card.className = 'panel-card';
      pending.forEach((item) => {
        const row = document.createElement('div');
        row.className = 'panel-note';
        row.textContent = 'Waiting on you (' + item.kind + '): ' + item.detail;
        card.appendChild(row);
      });
      actions.forEach((action) => {
        const row = document.createElement('div');
        row.className = 'panel-note';
        row.textContent = action.title + ' — ' + action.basis;
        card.appendChild(row);
      });
      nextActions.appendChild(card);
    } else {
      nextActions.hidden = true;
    }

    renderOpportunityWorkflows();
  }

  /* Opportunity preparation progress, rendered ONLY from session.opportunity_workflows.
     Every step below shows the real recorded outcome; a stage that did not run shows
     "not run", never a tick. There is no Publish control here and there is no code path
     to one: the workflow ends at a pending human approval (see
     agent/core/opportunityPreparationWorkflow.js, which has no PUBLISH_AUTHORIZED state). */
  // Maps one recorded workflow entry onto the six display steps. Returns the REAL value for
  // each - never a derived "must have passed because a later step ran".
  function workflowStepValues(entry) {
    var stages = entry.stages || {};
    return [
      { label: 'Opportunity', value: '#' + entry.ref, state: 'done' },
      { label: 'Validation', value: stages.validation || 'not run', state: stages.validation || 'none' },
      { label: 'Compliance', value: entry.compliance_status || 'not run', state: entry.compliance_status || 'none' },
      { label: 'SEO', value: stages.seo || 'not run', state: stages.seo || 'none' },
      { label: 'Listing draft', value: stages.listing || 'not run', state: stages.listing || 'none' },
      {
        label: 'Approval',
        value: entry.approval_id ? entry.approval_status || 'pending' : 'not requested',
        state: entry.approval_id ? entry.approval_status || 'pending' : 'none',
      },
    ];
  }

  function renderOpportunityWorkflows() {
    var area = document.getElementById('opportunityWorkflowArea');
    if (!area) return;
    var workflows = (currentSession && currentSession.opportunity_workflows) || [];
    if (workflows.length === 0) {
      area.hidden = true;
      area.innerHTML = '';
      return;
    }

    area.hidden = false;
    area.innerHTML = '';
    workflows.forEach(function (entry) {
      var card = document.createElement('div');
      card.className = 'panel-card workflow-card';

      var head = document.createElement('div');
      head.className = 'workflow-head';
      var title = document.createElement('span');
      title.className = 'workflow-title';
      title.textContent = '#' + entry.ref + '  ' + (entry.product || 'Opportunity');
      head.appendChild(title);
      var state = document.createElement('span');
      state.className = 'status-chip ' + workflowStateClass(entry.state);
      state.textContent = String(entry.state || '').replace(/_/g, ' ');
      head.appendChild(state);
      // The channel is shown only when the record STATED one - never inferred, and never
      // defaulted to Shopify.
      if (entry.channel) {
        var chan = document.createElement('span');
        chan.className = 'section-channel-tag';
        chan.textContent = entry.channel;
        head.appendChild(chan);
      }
      card.appendChild(head);

      var steps = document.createElement('div');
      steps.className = 'workflow-steps';
      workflowStepValues(entry).forEach(function (step, index) {
        if (index > 0) {
          var arrow = document.createElement('span');
          arrow.className = 'workflow-arrow';
          arrow.textContent = '→';
          steps.appendChild(arrow);
        }
        var cell = document.createElement('span');
        cell.className = 'workflow-step';
        var name = document.createElement('span');
        name.className = 'workflow-step-name';
        name.textContent = step.label;
        var val = document.createElement('span');
        val.className = 'workflow-step-value ' + workflowStateClass(step.state);
        val.textContent = step.value;
        cell.appendChild(name);
        cell.appendChild(val);
        steps.appendChild(cell);
      });
      card.appendChild(steps);

      // Etsy is read-only in this project. Said plainly, on the card, so nobody waits for a
      // Publish control that does not and will not exist here.
      if (entry.channel === 'etsy') {
        var note = document.createElement('div');
        note.className = 'panel-note workflow-readonly';
        note.textContent = 'Read-only — publishing unavailable. This draft can be reviewed and approved, but it cannot be published to Etsy from this project.';
        card.appendChild(note);
      }

      // What the research did not establish, named rather than filled in.
      var missing = entry.missing_information || [];
      if (missing.length > 0) {
        var miss = document.createElement('div');
        miss.className = 'panel-note';
        miss.textContent =
          missing.length + ' product fact(s) not established by the research, reported rather than guessed: ' + missing.join(', ') + '.';
        card.appendChild(miss);
      }

      area.appendChild(card);
    });
  }

  // Reuses the dashboard's existing status-chip vocabulary. An unrecognised value gets the
  // neutral class rather than being coerced into "ok".
  function workflowStateClass(value) {
    var v = String(value || '').toLowerCase();
    if (v === 'complete' || v === 'pass' || v === 'done' || v === 'approved') return 'ok';
    if (v === 'block' || v === 'compliance_blocked' || v === 'failed' || v === 'rejected') return 'error';
    if (v === 'review' || v === 'blocked' || v === 'needs_information' || v === 'awaiting_approval' || v === 'pending') return 'warn';
    return 'idle';
  }

  async function loadSessionList() {
    try {
      const res = await apiFetch('/sessions');
      if (!res.ok) return;
      const data = await res.json().catch(() => ({}));
      const sessions = (data.sessions || []).filter((s) => s.session_id);
      const select = document.getElementById('sessionSelect');
      if (sessions.length === 0) {
        select.hidden = true;
        return;
      }
      select.hidden = false;
      select.innerHTML = '<option value="">Resume a session…</option>';
      sessions.forEach((s) => {
        const option = document.createElement('option');
        option.value = s.session_id;
        option.textContent = (s.original_goal || s.session_id).slice(0, 60) + '  (' + s.result_count + ' result(s))';
        select.appendChild(option);
      });
    } catch (err) {
      // A failed listing must never block starting a new session.
    }
  }

  document.getElementById('sessionSelect').addEventListener('change', async (event) => {
    const id = event.target.value;
    if (!id) return;
    try {
      const res = await apiFetch('/session/' + encodeURIComponent(id));
      if (!res.ok) return;
      currentSession = await res.json();
      renderSessionState();
      chiefResultArea.innerHTML = '';
      chiefRunHint.textContent = 'Resumed. Continue where you left off.';
    } catch (err) {
      chiefRunHint.textContent = 'Could not reach the server.';
    }
  });

  document.getElementById('newSessionBtn').addEventListener('click', () => {
    currentSession = null;
    renderSessionState();
    chiefResultArea.innerHTML = '';
    chiefObjective.value = '';
    chiefRunHint.textContent = 'Started a new session. Type your goal.';
    document.getElementById('sessionSelect').value = '';
  });

  chiefRunBtn.addEventListener('click', async () => {
    const goal = chiefObjective.value.trim();
    if (!goal) {
      chiefRunHint.textContent = 'Type a goal first.';
      return;
    }

    chiefRunBtn.disabled = true;
    chiefRunBtn.textContent = 'Thinking…';
    chiefRunHint.textContent = '';
    chiefResultArea.innerHTML = '<p class="empty-result">The Chief is deciding how to route this…</p>';

    try {
      // First goal in a session creates it; every later goal continues the same one, which
      // is what lets a follow-up say "deep research #3".
      if (!currentSession) {
        const created = await apiFetch('/session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ goal: goal }),
        });
        if (!created.ok) {
          const err = await created.json().catch(() => ({}));
          chiefResultArea.innerHTML = '<p class="empty-result">' + escapeHtml(err.error || 'Could not start a session.') + '</p>';
          return;
        }
        currentSession = await created.json();
      }

      const res = await apiFetch('/session/' + encodeURIComponent(currentSession.session_id) + '/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: goal }),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        chiefResultArea.innerHTML =
          '<div class="result-card"><div class="result-header"><span class="result-title">Chief Orchestrator</span>' +
          '<span class="result-status error">error</span></div><pre class="result-body">' +
          escapeHtml(data.error || 'Something went wrong.') + '</pre></div>';
        return;
      }

      currentSession = data.session || currentSession;
      renderSessionState();
      chiefObjective.value = '';
      currentRunId = data.run_id || null;

      // The full plan detail still renders exactly as it did before - the session adds
      // the conversation around it, it does not replace it.
      if (data.run_id) {
        const runRes = await apiFetch('/history/' + encodeURIComponent(data.run_id));
        if (runRes.ok) {
          const record = await runRes.json().catch(() => ({}));
          if (record && record.result) renderChiefPlan(record.result, data.run_id);
          else chiefResultArea.innerHTML = '';
        }
      } else {
        chiefResultArea.innerHTML = '';
      }

      loadSessionList();
      noteActivity('Asked the Chief just now');
    } catch (err) {
      chiefResultArea.innerHTML = '<p class="empty-result">Could not reach the server. Check that it is running.</p>';
    } finally {
      chiefRunBtn.disabled = false;
      chiefRunBtn.textContent = currentSession ? 'Continue this session' : 'Ask the Chief';
    }
  });

  loadSessionList();

  /* ---------- Approval Center page ---------- */
  let approvalFilter = 'all';

  document.querySelectorAll('#approvalFilterRow .filter-pill').forEach((pill) => {
    pill.addEventListener('click', () => {
      document.querySelectorAll('#approvalFilterRow .filter-pill').forEach((p) => p.setAttribute('aria-pressed', 'false'));
      pill.setAttribute('aria-pressed', 'true');
      approvalFilter = pill.dataset.filter;
      renderApprovalList();
    });
  });

  async function decideFromApprovalCenter(entry, decision, row) {
    const notesField = row.querySelector('.approval-notes');
    const approveBtn = row.querySelector('.approve-btn');
    const rejectBtn = row.querySelector('.reject-btn');
    approveBtn.disabled = true;
    rejectBtn.disabled = true;

    // Same signed-approval handshake as the run panel - the server accepts no decision
    // without it, so the Approval Center cannot be a quieter way to approve.
    const signed = await collectSignedApproval({
      approvalId: entry.approvalId,
      decision,
      decidedBy: 'naeema',
    });
    if (!signed.ok) {
      approveBtn.disabled = false;
      rejectBtn.disabled = false;
      window.alert(signed.error);
      return;
    }

    try {
      const res = await apiFetch('/orchestrate/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          runId: entry.runId,
          approvalId: entry.approvalId,
          decision,
          decidedBy: 'naeema',
          notes: (notesField && notesField.value.trim()) || undefined,
          nonce: signed.nonce,
          signature: signed.signature,
        }),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        row.querySelector('[data-role="row-error"]').textContent = data.error || 'Could not record that decision.';
        approveBtn.disabled = false;
        rejectBtn.disabled = false;
        return;
      }

      upsertApprovalLog({
        runId: entry.runId,
        approvalId: entry.approvalId,
        classification: entry.classification,
        title: entry.title,
        reason: 'Decided from the Approval Center.',
        status: decision,
        decidedBy: 'naeema',
        decidedAt: new Date().toISOString(),
        notes: (notesField && notesField.value.trim()) || null,
      });
      noteActivity('Decided an approval (' + decision + ') just now');
      renderApprovalList();

      // Keep the Chief Orchestrator page's own panel for this same approval in sync,
      // in case it is still open there too - same approval_request_id, one real record.
      const livePanel = document.querySelector('.approval-panel[data-approval-id="' + entry.approvalId + '"]');
      if (livePanel && !livePanel.classList.contains('decided-approved') && !livePanel.classList.contains('decided-rejected')) {
        livePanel.classList.add(decision === 'approved' ? 'decided-approved' : 'decided-rejected');
        livePanel.innerHTML = '<p class="approval-decided ' + (decision === 'approved' ? 'approved' : 'rejected') + '">' +
          (decision === 'approved' ? 'Approved' : 'Rejected') + ' (from Approval Center)</p>';
      }
    } catch (err) {
      row.querySelector('[data-role="row-error"]').textContent = 'Could not reach the server. Check that it is running.';
      approveBtn.disabled = false;
      rejectBtn.disabled = false;
    }
  }

  function renderApprovalList() {
    const area = document.getElementById('approvalListArea');
    area.innerHTML = '';
    refreshApprovalBadges();

    const visible = approvalLog.filter((a) => approvalFilter === 'all' || a.status === approvalFilter);
    if (visible.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'empty-result';
      empty.textContent = approvalLog.length === 0
        ? 'Nothing to show yet — ask the Chief something on the Chief Orchestrator page that needs your sign-off.'
        : 'No approvals match this filter.';
      area.appendChild(empty);
      return;
    }

    visible.slice().reverse().forEach((entry) => {
      const row = document.createElement('div');
      row.className = 'approval-row';
      row.dataset.approvalId = entry.approvalId;

      // Only the fields this approval record really carries. A platform, an action type or
      // a compliance verdict is not part of an approval request, so none is shown here
      // rather than one being guessed - compliance is a separate check (see the explainer
      // above the list).
      const statusText = escapeHtml(String(entry.status || 'pending'));
      const decision = entry.status === 'pending'
        ? 'Waiting for your decision.'
        : escapeHtml(entry.status === 'approved' ? 'Approved' : 'Rejected') +
          ' by ' + escapeHtml(entry.decidedBy || '—') +
          (entry.decidedAt ? ' · ' + escapeHtml(formatWhen(entry.decidedAt)) : '') +
          (entry.notes ? ' — “' + escapeHtml(entry.notes) + '”' : '');

      row.innerHTML =
        '<div class="approval-row-head">' +
        '<div><div class="approval-row-title">' + escapeHtml(entry.title || 'Approval') + '</div>' +
        '<div class="approval-row-meta">Human approval request</div></div>' +
        '<span class="approval-row-status ' + statusText + '">' + statusText + '</span>' +
        '</div>' +
        '<dl class="approval-fields">' +
        '<dt>Classification</dt><dd><code>' + escapeHtml(entry.classification || 'approval_required') + '</code> — ' +
        escapeHtml(APPROVAL_CLASS_MEANING[entry.classification] || 'Does not run until you approve it.') + '</dd>' +
        '<dt>Run</dt><dd><code>' + escapeHtml(entry.runId || 'not recorded') + '</code></dd>' +
        '<dt>Decision</dt><dd>' + decision + '</dd>' +
        '</dl>' +
        '<p class="approval-row-reason">' + escapeHtml(entry.reason || '') + '</p>' +
        (entry.status === 'pending'
          ? '<textarea class="approval-notes" placeholder="Optional note (why you approved or rejected this)"></textarea>' +
            '<div class="approval-actions">' +
            '<button class="approve-btn" type="button">Approve</button>' +
            '<button class="reject-btn" type="button">Reject</button>' +
            '</div>' +
            '<p class="approval-row-meta" data-role="row-error" style="color:var(--danger);margin-top:8px;"></p>'
          : '<div class="approval-row-meta">Decided by ' + escapeHtml(entry.decidedBy || '—') +
            (entry.notes ? ' — “' + escapeHtml(entry.notes) + '”' : '') + '</div>');

      if (entry.status === 'pending') {
        row.querySelector('.approve-btn').addEventListener('click', () => decideFromApprovalCenter(entry, 'approved', row));
        row.querySelector('.reject-btn').addEventListener('click', () => decideFromApprovalCenter(entry, 'rejected', row));
      }

      area.appendChild(row);
    });
  }

  refreshApprovalBadges();

  /* ---------- History page (past runs saved server-side - see server.js's
     GET /history and GET /history/:runId, backed by agent/core/runHistoryStore.js) ---------- */

  // Same three-way vocabulary as .result-status's own CSS (success/partial/error) -
  // a saved run's real status may also be "needs_clarification" or "failed" (see
  // server.js's status computations), mapped down to whichever of those three colors
  // is closest so History reuses the existing style instead of inventing a new one.
  function historyStatusClass(status) {
    if (status === 'success') return 'success';
    if (status === 'error' || status === 'failed') return 'error';
    return 'partial';
  }

  async function renderHistoryList() {
    const listArea = document.getElementById('historyListArea');
    const detailArea = document.getElementById('historyDetailArea');
    listArea.innerHTML = '<p class="empty-result">Loading saved runs…</p>';
    detailArea.innerHTML = '';

    try {
      const res = await apiFetch('/history');
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        listArea.innerHTML = '<p class="empty-result">' + escapeHtml(data.error || 'Could not load saved runs.') + '</p>';
        return;
      }

      const runs = Array.isArray(data.runs) ? data.runs : [];
      listArea.innerHTML = '';

      if (runs.length === 0) {
        listArea.innerHTML = '<p class="empty-result">No saved runs yet - run a specialist or ask the Chief something, and it will appear here automatically.</p>';
        return;
      }

      // A scannable log: when, what ran (and on which channel, when the record states one),
      // and its real saved status. Built from DOM nodes rather than an HTML string, so no
      // saved text can ever reach an attribute unescaped.
      const list = document.createElement('div');
      list.className = 'history-list';
      const head = document.createElement('div');
      head.className = 'history-head';
      head.setAttribute('aria-hidden', 'true');
      ['When', 'Run', 'Status'].forEach((text) => {
        const cell = document.createElement('span');
        cell.textContent = text;
        head.appendChild(cell);
      });
      list.appendChild(head);

      runs.forEach((entry) => {
        const row = document.createElement('div');
        row.className = 'history-row';
        row.tabIndex = 0;
        row.setAttribute('role', 'button');

        const kindLabel = entry.kind === 'orchestrate' ? 'Chief Orchestrator' : 'Specialist: ' + (entry.specialist_name || entry.specialist_id || '');
        const created = entry.created_at ? new Date(entry.created_at) : null;
        const hasTime = created && !Number.isNaN(created.getTime());

        const when = document.createElement('div');
        when.className = 'history-when';
        const whenDate = document.createElement('span');
        whenDate.textContent = hasTime ? created.toLocaleDateString() : 'Unknown time';
        when.appendChild(whenDate);
        if (hasTime) {
          const whenTime = document.createElement('span');
          whenTime.textContent = created.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
          when.appendChild(whenTime);
        }
        row.appendChild(when);

        const main = document.createElement('div');
        main.className = 'history-main';
        const objectiveEl = document.createElement('div');
        objectiveEl.className = 'history-objective';
        objectiveEl.textContent = entry.objective || '(no objective recorded)';
        objectiveEl.title = entry.objective || '';
        main.appendChild(objectiveEl);
        const meta = document.createElement('div');
        meta.className = 'history-meta';
        // Same explicit-only rule as the Overview activity rows: a channel shows because
        // the record states one, never because a title looked like it belonged to a
        // marketplace. The listing id is included so a run traces to the exact listing.
        const channel = channelLabel(entry);
        if (channel) {
          const tag = document.createElement('span');
          tag.className = 'section-channel-tag';
          tag.textContent = channel + (entry.channel_reference ? ' #' + entry.channel_reference : '');
          meta.appendChild(tag);
        }
        const kind = document.createElement('span');
        kind.textContent = kindLabel;
        meta.appendChild(kind);
        main.appendChild(meta);
        row.appendChild(main);

        const status = document.createElement('span');
        status.className = 'status-chip ' + historyStatusClass(entry.status);
        status.textContent = String(entry.status || 'unknown').replace(/_/g, ' ');
        row.appendChild(status);

        const open = () => {
          list.querySelectorAll('.history-row[aria-current]').forEach((other) => other.removeAttribute('aria-current'));
          row.setAttribute('aria-current', 'true');
          loadHistoryDetail(entry.run_id);
        };
        row.addEventListener('click', open);
        row.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
        });

        list.appendChild(row);
      });
      listArea.appendChild(list);
    } catch (err) {
      listArea.innerHTML = '<p class="empty-result">Could not reach the server. Check that it is running.</p>';
    }
  }

  async function loadHistoryDetail(runId) {
    const detailArea = document.getElementById('historyDetailArea');
    detailArea.innerHTML = '<p class="empty-result">Loading…</p>';

    try {
      const res = await apiFetch('/history/' + encodeURIComponent(runId));
      const record = await res.json().catch(() => ({}));
      if (!res.ok) {
        detailArea.innerHTML = '<p class="empty-result">' + escapeHtml(record.error || 'Could not load this saved run.') + '</p>';
        return;
      }
      renderStoredRecordDetail(record, detailArea);
      // The detail renders beneath the run list, so bring it into view rather than leaving
      // a click on a lower row with no visible effect.
      detailArea.scrollIntoView({ block: 'start' });
    } catch (err) {
      detailArea.innerHTML = '<p class="empty-result">Could not reach the server. Check that it is running.</p>';
    }
  }

  // Read-only detail view for one saved run record. Deliberately simpler than
  // renderPlanStep/renderChiefPlan above (no approval panels are attached here) - an
  // approval saved from a past, possibly server-restarted run has no live
  // approvals/approvalWorkflow.js request behind it anymore to act on, so offering
  // Approve/Reject buttons here would be misleading. The full technical detail (every
  // step, every field) is still fully visible via the same "Technical details"
  // pattern used everywhere else in this dashboard - nothing is hidden, only the
  // (no-longer-actionable) approval controls are omitted.
  function renderStoredRecordDetail(record, container) {
    container.innerHTML = '';

    const card = document.createElement('div');
    card.className = 'result-card';

    const title = record.kind === 'orchestrate' ? 'Chief Orchestrator' : (record.specialist_name || record.specialist_id || 'Specialist');
    const statusClass = historyStatusClass(record.status);

    const header = document.createElement('div');
    header.className = 'result-header';
    header.innerHTML =
      '<span class="result-title">' + escapeHtml(title) + '</span>' +
      '<span class="result-status ' + statusClass + '">' + escapeHtml(record.status || 'unknown') + '</span>';
    card.appendChild(header);

    const summaryLine = document.createElement('p');
    summaryLine.className = 'result-summary';
    summaryLine.textContent = record.summary || 'No summary was saved for this run.';
    card.appendChild(summaryLine);

    const meta = document.createElement('p');
    meta.className = 'approval-row-meta';
    meta.style.padding = '0 16px 12px';
    const when = record.created_at ? new Date(record.created_at).toLocaleString() : 'unknown time';
    meta.textContent = 'Objective: "' + (record.objective || '') + '" · Saved ' + when;
    card.appendChild(meta);

    const details = document.createElement('details');
    details.className = 'result-details';
    const detailsLabel = document.createElement('summary');
    detailsLabel.textContent = 'Technical details';
    details.appendChild(detailsLabel);
    const body = document.createElement('pre');
    body.className = 'result-body';
    body.innerHTML = highlightJson(record.result);
    details.appendChild(body);
    card.appendChild(details);

    const chartData = extractChartPoints(record.result);
    if (chartData) {
      const chartWrap = document.createElement('div');
      chartWrap.className = 'result-chart-wrap';
      renderMetricChart(chartWrap, chartData, 'Real data from this saved run');
      card.appendChild(chartWrap);
    }

    container.appendChild(card);

    // A saved catalogue-expansion run gets its FULL opportunity list rendered here, in the
    // EXISTING History detail area, beneath the run card. This is the "up to 10" surface:
    // it shows exactly as many as the research supported and is never padded. Any other
    // kind of run is unaffected - the helper returns false and adds nothing.
    renderFullMarketOpportunities(record, container);
  }

  /* ==========================================================================
     Overview control-center loading: GET /overview (business identity, channel
     connection state, specialist rollup, activity, growth counts, opportunity
     relay, health checks - all read from state this server already holds, zero
     external calls) and GET /store/metrics (live, server-cached Shopify reads via
     the existing analytics_data_retrieval tool). Both are new, read-only
     endpoints added to server.js for exactly this page. Neither call runs a
     specialist or spends AI budget - see server.js's own header comments on both
     routes for the "why".

     EVERYTHING here is a straight relay of what the server already returned: no
     value is computed, estimated, or invented in this file. A field the payload
     doesn't carry renders as "No data"/"Not available"/"Not connected", never a
     placeholder number - the same discipline the rest of this dashboard already
     follows (see agentSummaryLine, renderResult above).
     ========================================================================== */

  const CHANNEL_DISPLAY_ORDER = ['shopify', 'etsy', 'ebay', 'amazon', 'woocommerce'];

  function formatWhen(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleString();
  }

  function renderOverviewBusiness(business, channels) {
    document.getElementById('ovBusinessName').textContent = (business && business.name) || 'Your store';

    const urlEl = document.getElementById('ovBusinessUrl');
    urlEl.innerHTML = '';
    if (business && business.store_url) {
      const a = document.createElement('a');
      a.href = business.store_url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = business.store_url;
      urlEl.appendChild(a);
    }

    // The header chip summarises every channel with a real adapter, naming each one and
    // its own state. It stays a summary - the full list is the Connected Channels section
    // below - but it must not keep reporting Shopify alone now that a second channel can
    // genuinely be connected.
    const withAdapters = (channels || []).filter((c) => c.adapter_exists);
    const chip = document.getElementById('ovChannelChip');
    const chipText = document.getElementById('ovChannelChipText');
    const anyConnected = withAdapters.some((c) => c.configured);
    chip.classList.toggle('warn', !anyConnected);
    chipText.textContent =
      withAdapters.length > 0
        ? withAdapters
            .map((c) => {
              if (!c.configured) return c.name + ' — Not connected';
              return c.access === 'read_only' ? c.name + ' — Read only' : c.name + ' — Connected';
            })
            .join('  ·  ')
        : 'No channel connected';
  }

  // One metric tile. `formattedValue` is a ready-to-show string, or null when the
  // server did not supply this metric - in which case `unavailableText` (the
  // server's own reason, e.g. "not connected", "no data") is shown in its place
  // instead of a blank or a zero.
  // `detail` is an OPTIONAL extra annotation shown only alongside a real value (e.g.
  // "46 active" under a products count) - never the unavailability reason, which the
  // caller must only pass when `formattedValue` is itself null. Conflating the two
  // previously made every successful metric show its capability's "No data" default
  // as a spurious extra line - fixed by keeping them as two distinct call sites below.
  function metricTile(label, formattedValue, detail) {
    const tile = document.createElement('div');
    tile.className = 'metric-tile';

    const labelEl = document.createElement('div');
    labelEl.className = 'metric-tile-label';
    labelEl.textContent = label;
    tile.appendChild(labelEl);

    const valueEl = document.createElement('div');
    if (formattedValue === null || formattedValue === undefined) {
      valueEl.className = 'metric-tile-value unavailable';
      valueEl.textContent = detail || 'Not available';
      tile.appendChild(valueEl);
    } else {
      valueEl.className = 'metric-tile-value';
      valueEl.textContent = formattedValue;
      tile.appendChild(valueEl);
      if (detail) {
        const detailEl = document.createElement('div');
        detailEl.className = 'metric-tile-detail';
        detailEl.textContent = detail;
        tile.appendChild(detailEl);
      }
    }
    return tile;
  }

  // Reads one entry from a specialized_records[0].<domainKey>.calculated_metrics
  // array (the exact shape agent/core/analyticsMetricsCalculator.js produces,
  // relayed verbatim by GET /store/metrics) by its label. Returns null - never a
  // guessed 0 - when that metric was not computed for this pull.
  function pickMetric(domain, label) {
    if (!domain || !Array.isArray(domain.calculated_metrics)) return null;
    return domain.calculated_metrics.find((m) => m && m.label === label) || null;
  }

  function capabilityDomain(capabilityOutcome, domainKey) {
    const records = capabilityOutcome && capabilityOutcome.result && capabilityOutcome.result.specialized_records;
    return Array.isArray(records) && records[0] ? records[0][domainKey] : null;
  }

  // The one honest reason a capability has no number to show: not configured,
  // a scope/permission denial, or simply zero records - each in the capability's
  // own words (tools/analyticsDataTool.js's real status/error), never invented here.
  function capabilityUnavailableReason(capabilityOutcome) {
    if (!capabilityOutcome) return 'Not available';
    if (capabilityOutcome.status === 'failed') return capabilityOutcome.error || 'Not connected';
    if (capabilityOutcome.status === 'empty') return 'No data yet';
    if (capabilityOutcome.status === 'partial') return 'Partially available';
    return null;
  }

  function renderStoreMetrics(metricsPayload) {
    const grid = document.getElementById('storeMetricGrid');
    grid.innerHTML = '';

    const caps = (metricsPayload && metricsPayload.capabilities) || {};
    const sales = caps.sales;
    const products = caps.products;
    const customers = caps.customers;

    const salesDomain = capabilityDomain(sales, 'sales');
    const productsDomain = capabilityDomain(products, 'product_performance');
    const customersDomain = capabilityDomain(customers, 'customer_behavior');

    const salesReason = capabilityUnavailableReason(sales) || 'No data';
    const productsReason = capabilityUnavailableReason(products) || 'No data';
    const customersReason = capabilityUnavailableReason(customers) || 'No data';

    const ordersMetric = pickMetric(salesDomain, 'orders_count');
    const revenueMetric = pickMetric(salesDomain, 'total_revenue');
    const aovMetric = pickMetric(salesDomain, 'average_order_value');
    const productsMetric = pickMetric(productsDomain, 'products_count');
    const activeMetric = pickMetric(productsDomain, 'active_products_count');
    const oosMetric = pickMetric(productsDomain, 'out_of_stock_variants_count');
    const customersCount =
      customersDomain && Array.isArray(customersDomain.actual_metrics) ? customersDomain.actual_metrics.length : null;

    // Each tile's third argument is EITHER a genuine extra annotation on a real value
    // (e.g. "46 active") OR the capability's own unavailability reason - and only the
    // latter when there is no value to show at all. A present value never carries the
    // "No data"/"Not connected" text as a spurious detail line.
    grid.appendChild(metricTile('Orders', ordersMetric ? String(ordersMetric.value) : null, ordersMetric ? null : salesReason));
    grid.appendChild(
      metricTile(
        'Revenue',
        revenueMetric ? revenueMetric.value + ' ' + revenueMetric.unit : null,
        revenueMetric ? null : salesReason
      )
    );
    grid.appendChild(
      metricTile(
        'Avg order value',
        aovMetric ? aovMetric.value + ' ' + aovMetric.unit : null,
        aovMetric ? null : salesReason
      )
    );
    grid.appendChild(
      metricTile(
        'Products',
        productsMetric ? String(productsMetric.value) : null,
        productsMetric ? (activeMetric ? activeMetric.value + ' active' : null) : productsReason
      )
    );
    grid.appendChild(
      metricTile('Out of stock variants', oosMetric ? String(oosMetric.value) : null, oosMetric ? null : productsReason)
    );
    grid.appendChild(
      metricTile(
        'Customers',
        customersCount !== null ? String(customersCount) : null,
        customersCount !== null ? null : customersReason
      )
    );
    grid.appendChild(
      metricTile('Sessions / traffic', null, "Shopify's read-only Admin API does not expose this.")
    );
    grid.appendChild(metricTile('Conversion rate', null, "Shopify's read-only Admin API does not expose this."));
  }

  /* ---------- Etsy catalog ----------
     RELAY ONLY, exactly like renderStoreMetrics above. Every number drawn here is a field
     GET /store/metrics's `etsy` block already carried, and every "not available" line is
     the SERVER'S own stated reason - this file never decides why something is missing and
     never substitutes a zero for it.

     SEPARATE BY CONSTRUCTION. Nothing in this function reads Shopify data, and nothing in
     renderStoreMetrics reads Etsy data. The two sections cannot produce a combined figure
     because neither ever sees the other's numbers. */
  const OVERVIEW_ETSY_LISTING_LIMIT = 5;

  function etsyListingRow(listing) {
    const row = document.createElement('div');
    row.className = 'etsy-listing-row';

    const main = document.createElement('div');
    main.className = 'etsy-listing-main';

    const title = document.createElement('div');
    title.className = 'etsy-listing-title';
    title.textContent = listing.title || '(untitled listing)';
    main.appendChild(title);

    // The meta line names the channel explicitly on every row. Under the "All" filter this
    // is what keeps an Etsy listing from reading as just another product.
    const bits = ['Etsy'];
    if (listing.listing_id !== null && listing.listing_id !== undefined) bits.push('#' + listing.listing_id);
    if (listing.state) bits.push(listing.state);
    if (listing.is_digital_product === true) bits.push('digital');
    else if (listing.is_digital_product === false) bits.push('physical');
    if (Array.isArray(listing.tags)) bits.push(listing.tags.length + ' tags');
    if (listing.taxonomy_id !== null && listing.taxonomy_id !== undefined) bits.push('taxonomy ' + listing.taxonomy_id);
    if (typeof listing.num_favorers === 'number') bits.push(listing.num_favorers + ' favourites');
    if (typeof listing.views === 'number') bits.push(listing.views + ' views');

    const meta = document.createElement('div');
    meta.className = 'etsy-listing-meta';
    meta.textContent = bits.join(' · ');
    main.appendChild(meta);
    row.appendChild(main);

    // The compliance verdict the retrieval tool attached, shown with the listing rather
    // than separately - the content is never presented without its verdict.
    if (listing.compliance_status) {
      const chip = document.createElement('span');
      chip.className = 'status-chip ' + (listing.compliance_status === 'PASS' ? 'connected' : 'not-connected');
      const missing = listing.missing_fact_count;
      chip.textContent =
        typeof missing === 'number' && missing > 0
          ? listing.compliance_status + ' · ' + missing + ' unknown'
          : listing.compliance_status;
      row.appendChild(chip);
    }

    // The two read-only analysis triggers. Reuses the existing .activity-row-link button
    // style rather than introducing a control of its own, and both run ANALYSIS ONLY -
    // neither can change the Etsy listing, and the server has no Etsy write path to
    // reach even if one were requested.
    const actions = document.createElement('span');
    actions.className = 'etsy-listing-actions';
    [
      { id: 'seo', label: 'SEO' },
      { id: 'listing', label: 'Listing' },
    ].forEach((action) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'activity-row-link';
      btn.textContent = action.label + ' →';
      btn.title = `Run a read-only ${action.label} analysis of this Etsy listing. Nothing is written to Etsy.`;
      btn.addEventListener('click', () => runEtsyAnalysis(listing.listing_id, action.id, btn));
      actions.appendChild(btn);
    });
    row.appendChild(actions);

    return row;
  }

  // Triggers one read-only Etsy analysis and hands the result to the EXISTING History
  // detail view (the same loadHistoryDetail an activity row's "View" already opens), so
  // no second result viewer is built. The record is saved server-side with its channel,
  // which is what makes it appear as an Etsy run in Activity and History.
  async function runEtsyAnalysis(listingId, analysis, button) {
    const original = button.textContent;
    button.disabled = true;
    button.textContent = 'Running…';
    try {
      const res = await apiFetch('/etsy/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ listing_id: listingId, analysis }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.run_id) {
        // The server's own reason, verbatim - this page never guesses why a run failed.
        button.textContent = 'Failed';
        button.title = data.error || 'The analysis could not complete.';
        return;
      }
      button.textContent = original;
      // Reuses the existing History page and its existing detail loader.
      selectPage('history');
      loadHistoryDetail(data.run_id);
    } catch (err) {
      button.textContent = 'Failed';
      button.title = 'Could not reach the server. Check that it is running.';
    } finally {
      button.disabled = false;
    }
  }

  function renderEtsyCatalog(etsy) {
    const header = document.getElementById('etsyCatalogHeader');
    const area = document.getElementById('etsyCatalogArea');
    const shopEl = document.getElementById('etsyCatalogShop');
    if (!header || !area) return;

    // Not connected -> the section is not shown at all. An empty Etsy panel on a store
    // that has no Etsy connection would imply an integration that is not there.
    if (!etsy || !etsy.connected) {
      header.dataset.etsyReady = 'false';
      area.dataset.etsyReady = 'false';
      header.hidden = true;
      area.hidden = true;
      return;
    }
    // Marks these sections as having real data, which is what lets applyChannelFilter
    // show them. Without it the filter could un-hide an empty Etsy panel.
    header.dataset.etsyReady = 'true';
    area.dataset.etsyReady = 'true';
    header.hidden = false;
    area.hidden = false;
    area.innerHTML = '';

    // Shop identity. shop_id is not a secret - it appears in the public shop URL.
    shopEl.textContent = etsy.shop
      ? etsy.shop.shop_name
        ? etsy.shop.shop_name + ' · #' + etsy.shop.shop_id
        : '#' + etsy.shop.shop_id
      : '';

    const grid = document.createElement('div');
    grid.className = 'metric-grid';
    (etsy.metrics || []).forEach((metric) => {
      // The SAME metricTile the Shopify grid uses: a null value renders the server's own
      // reason text, so an unavailable Etsy metric can never appear as 0.
      grid.appendChild(
        metricTile(
          metric.label,
          metric.available && metric.value !== null && metric.value !== undefined ? String(metric.value) : null,
          metric.available ? null : metric.reason
        )
      );
    });
    area.appendChild(grid);

    const catalog = etsy.catalog || {};
    const listings = Array.isArray(catalog.listings) ? catalog.listings : [];

    if (listings.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'panel-empty';
      empty.textContent = catalog.error
        ? 'Etsy listings could not be read: ' + catalog.error
        : 'No Etsy listings were returned for this request.';
      area.appendChild(empty);
    } else {
      const listLabel = document.createElement('div');
      listLabel.className = 'panel-note';
      listLabel.textContent =
        'Showing ' +
        Math.min(listings.length, OVERVIEW_ETSY_LISTING_LIMIT) +
        ' of ' +
        listings.length +
        ' listing(s) read this request' +
        (catalog.aggregate_compliance_status ? ' · worst compliance verdict: ' + catalog.aggregate_compliance_status : '') +
        '.';
      area.appendChild(listLabel);
      listings.slice(0, OVERVIEW_ETSY_LISTING_LIMIT).forEach((listing) => area.appendChild(etsyListingRow(listing)));
    }

    // Re-apply the current filter now that these sections carry data.
    applyChannelFilter();

    // The server's own reasons for what this read deliberately does not include, shown
    // rather than left as an unexplained absence.
    [catalog.inventory_reason, catalog.images_reason, etsy.publishing_note].forEach((text) => {
      if (!text) return;
      const note = document.createElement('div');
      note.className = 'panel-note';
      note.textContent = text;
      area.appendChild(note);
    });
  }

  /* ---------- Channel filter ----------
     NARROWING ONLY. Choosing a channel hides the other channel's sections; it never
     combines, joins, or re-labels data. "All" shows both, each under its own heading with
     its own channel tag, so a figure is never ambiguous about which store it describes.

     A pill is rendered only for a channel that is genuinely connected, so this control
     cannot imply an integration that does not exist. With fewer than two connected
     channels there is nothing to choose between and the row stays hidden entirely. */
  let activeChannel = 'all';

  function applyChannelFilter() {
    document.querySelectorAll('[data-channel-section]').forEach((el) => {
      const section = el.getAttribute('data-channel-section');
      // The Etsy sections have their own connected/not-connected visibility, decided by
      // renderEtsyCatalog. The filter must never un-hide a section that has no data.
      if (section === 'etsy' && el.dataset.etsyReady !== 'true') return;
      el.hidden = !(activeChannel === 'all' || activeChannel === section);
    });
  }

  function renderChannelFilter(channels) {
    const row = document.getElementById('channelFilterRow');
    if (!row) return;
    const connected = (channels || []).filter((c) => c.adapter_exists && c.configured);

    if (connected.length < 2) {
      row.hidden = true;
      row.innerHTML = '';
      activeChannel = 'all';
      applyChannelFilter();
      return;
    }

    row.hidden = false;
    row.innerHTML = '';
    const options = [{ id: 'all', name: 'All' }].concat(connected.map((c) => ({ id: c.id, name: c.name })));
    options.forEach((option) => {
      const pill = document.createElement('button');
      pill.className = 'filter-pill';
      pill.type = 'button';
      pill.dataset.filter = option.id;
      pill.setAttribute('aria-pressed', option.id === activeChannel ? 'true' : 'false');
      pill.textContent = option.name;
      pill.addEventListener('click', () => {
        row.querySelectorAll('.filter-pill').forEach((p) => p.setAttribute('aria-pressed', 'false'));
        pill.setAttribute('aria-pressed', 'true');
        activeChannel = option.id;
        applyChannelFilter();
      });
      row.appendChild(pill);
    });
    applyChannelFilter();
  }

  /* ---------- Performance charts ----------
     RELAY ONLY. Every point drawn here comes from GET /store/metrics's `trends` block,
     which agent/core/analyticsMetricsCalculator.js's calculateSalesTrend() built from
     the orders tools/analyticsDataTool.js already pulled. This file computes no metric
     of its own - it only formats and draws what the server sent.

     A metric the server marked available:false (sessions, conversion rate - neither is
     exposed by Shopify's read-only Admin API) renders the server's own stated reason,
     never an empty axis or a zero line that would read as "we measured zero".

     CHANNEL-READY: a metric carries a `channels` array and this renderer draws one line
     per channel, with a legend once there is more than one. Today only Shopify can
     populate it, so no legend appears - but a future connected channel needs no change
     here. */
  let activePerfMetric = 'revenue';
  let lastTrends = null;

  function formatBucketLabel(iso, granularity) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    if (granularity === 'month') return d.toLocaleDateString(undefined, { month: 'short', year: '2-digit', timeZone: 'UTC' });
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
  }

  function formatAxisValue(value, unit) {
    const abs = Math.abs(value);
    const num = abs >= 1000 ? (value / 1000).toFixed(1) + 'k' : Number.isInteger(value) ? String(value) : value.toFixed(2);
    return unit ? num + ' ' + unit : num;
  }

  // A responsive line+area chart in a fixed viewBox coordinate space. The SVG scales to
  // its container width (CSS sets width:100%, height:auto), so it stays readable on a
  // phone without a charting library or a resize listener.
  function buildTrendSvg(metric, granularity) {
    // Aspect only: a 4:1 box keeps the chart prominent without it towering over the
    // page at desktop width. The plotted values are untouched.
    const VB_W = 1000;
    const VB_H = 250;
    const PAD_L = 54;
    const PAD_R = 14;
    const PAD_T = 14;
    const PAD_B = 34;
    const plotW = VB_W - PAD_L - PAD_R;
    const plotH = VB_H - PAD_T - PAD_B;

    const channels = metric.channels.filter((c) => c.points && c.points.length > 0);
    if (channels.length === 0) return null;

    const allValues = channels.flatMap((c) => c.points.map((p) => p.value));
    const rawMax = Math.max.apply(null, allValues.concat([0]));
    // A flat all-zero series is a real result (e.g. a week of free-product orders), so
    // it must still draw a baseline rather than divide by zero.
    const maxValue = rawMax > 0 ? rawMax : 1;
    const count = channels[0].points.length;
    const xAt = (i) => (count <= 1 ? PAD_L + plotW / 2 : PAD_L + (i / (count - 1)) * plotW);
    const yAt = (v) => PAD_T + plotH - (v / maxValue) * plotH;

    // Horizontal gridlines + y-axis ticks at 0 / 50% / 100% of the real maximum.
    let grid = '';
    [0, 0.5, 1].forEach((frac) => {
      const v = maxValue * frac;
      const y = yAt(v);
      grid +=
        '<line class="perf-grid" x1="' + PAD_L + '" y1="' + y + '" x2="' + (VB_W - PAD_R) + '" y2="' + y + '"></line>' +
        '<text class="perf-axis-y" x="' + (PAD_L - 8) + '" y="' + (y + 3.5) + '">' +
        escapeHtml(formatAxisValue(rawMax > 0 ? v : 0, '')) + '</text>';
    });

    // X labels: at most 6, evenly sampled, so a long daily series never overlaps itself.
    const step = Math.max(1, Math.ceil(count / 6));
    let xLabels = '';
    channels[0].points.forEach((p, i) => {
      if (i % step !== 0 && i !== count - 1) return;
      xLabels +=
        '<text class="perf-axis-x" x="' + xAt(i) + '" y="' + (VB_H - 12) + '">' +
        escapeHtml(formatBucketLabel(p.t, granularity)) + '</text>';
    });

    const series = channels
      .map((channel, ci) => {
        const pts = channel.points.map((p, i) => xAt(i) + ',' + yAt(p.value));
        const line = '<polyline class="perf-line perf-series-' + ci + '" points="' + pts.join(' ') + '"></polyline>';
        const area =
          count > 1
            ? '<polygon class="perf-area perf-series-' + ci + '" points="' +
              PAD_L + ',' + (PAD_T + plotH) + ' ' + pts.join(' ') + ' ' + (PAD_L + plotW) + ',' + (PAD_T + plotH) +
              '"></polygon>'
            : '';
        const dots = channel.points
          .map(
            (p, i) =>
              '<circle class="perf-dot perf-series-' + ci + '" cx="' + xAt(i) + '" cy="' + yAt(p.value) + '" r="3">' +
              '<title>' +
              escapeHtml(formatBucketLabel(p.t, granularity) + ': ' + formatAxisValue(p.value, metric.unit || '')) +
              '</title></circle>'
          )
          .join('');
        return area + line + dots;
      })
      .join('');

    const label = metric.label + ' by ' + granularity;
    return (
      '<svg class="perf-svg" viewBox="0 0 ' + VB_W + ' ' + VB_H + '" role="img" aria-label="' + escapeHtml(label) + '">' +
      grid + xLabels + series + '</svg>'
    );
  }

  function renderPerfChart() {
    const area = document.getElementById('perfChartArea');
    const note = document.getElementById('perfNote');
    area.innerHTML = '';
    note.textContent = '';
    if (!lastTrends) {
      area.innerHTML = '<div class="panel-empty">No data available.</div>';
      return;
    }

    const metric = (lastTrends.metrics || []).find((m) => m.id === activePerfMetric);
    if (!metric) {
      area.innerHTML = '<div class="panel-empty">No data available.</div>';
      return;
    }

    if (!metric.available) {
      // The server's own reason, verbatim - this dashboard never guesses why a metric is
      // missing, and never substitutes a zero series for an absent one.
      const empty = document.createElement('div');
      empty.className = 'perf-unavailable';
      const head = document.createElement('div');
      head.className = 'perf-unavailable-title';
      head.textContent = 'No data available';
      const why = document.createElement('div');
      why.className = 'perf-unavailable-reason';
      why.textContent = metric.reason || '';
      empty.appendChild(head);
      empty.appendChild(why);
      area.appendChild(empty);
      return;
    }

    const svg = buildTrendSvg(metric, lastTrends.granularity || 'day');
    if (!svg) {
      area.innerHTML = '<div class="panel-empty">No data available.</div>';
      return;
    }
    area.innerHTML = svg;

    if (metric.channels.length > 1) {
      const legend = document.createElement('div');
      legend.className = 'perf-legend';
      metric.channels.forEach((c, i) => {
        const item = document.createElement('span');
        item.className = 'perf-legend-item perf-series-' + i;
        item.textContent = c.name;
        legend.appendChild(item);
      });
      area.appendChild(legend);
    }

    const noteParts = [];
    if (typeof lastTrends.order_count === 'number') noteParts.push(lastTrends.order_count + ' order(s) in this range');
    if (metric.unit) noteParts.push('values in ' + metric.unit);
    if (lastTrends.ignored_currencies && lastTrends.ignored_currencies.length > 0) {
      noteParts.push(
        'excludes ' + lastTrends.ignored_currencies.join(', ') + ' orders (one trend line cannot mix currencies)'
      );
    }
    // The capped-read caveat straight from tools/analyticsDataTool.js, so a trend over a
    // partial pull is never presented as the store's complete history.
    const cap = (lastTrends.limitations || []).find((l) => typeof l === 'string' && l.indexOf('capped read') !== -1);
    if (cap) noteParts.push(cap);
    note.textContent = noteParts.join(' · ');
  }

  function renderPerformance(trends) {
    lastTrends = trends || null;
    const tabs = document.getElementById('perfTabs');
    const range = document.getElementById('perfRange');
    tabs.innerHTML = '';
    range.textContent = '';

    const metrics = (trends && trends.metrics) || [];
    if (metrics.length === 0) {
      document.getElementById('perfChartArea').innerHTML = '<div class="panel-empty">No data available.</div>';
      return;
    }

    // The real date range the drawn data actually covers - never a calendar period this
    // dashboard assumes on the store's behalf.
    if (trends.available && trends.range) {
      const fmt = (d) => d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
      range.textContent =
        fmt(new Date(trends.range.from)) + ' → ' + fmt(new Date(trends.range.to)) + ' · by ' + trends.granularity;
    } else {
      range.textContent = 'No date range available';
    }

    if (!metrics.some((m) => m.id === activePerfMetric)) activePerfMetric = metrics[0].id;

    metrics.forEach((m) => {
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'perf-tab';
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', m.id === activePerfMetric ? 'true' : 'false');
      tab.textContent = m.label;
      // A metric with no data stays selectable on purpose: choosing it shows the honest
      // reason it is unavailable, which is more useful than a disabled, unexplained tab.
      if (!m.available) tab.classList.add('perf-tab-unavailable');
      tab.addEventListener('click', () => {
        activePerfMetric = m.id;
        Array.prototype.forEach.call(tabs.children, (c) => c.setAttribute('aria-selected', 'false'));
        tab.setAttribute('aria-selected', 'true');
        renderPerfChart();
      });
      tabs.appendChild(tab);
    });

    renderPerfChart();
  }

  // The Overview's compact specialist summary: one row per specialist, showing the real
  // persisted state GET /overview reported. This replaced seven large cards - the detailed
  // per-specialist view, the objective box and the Run control all live on the existing
  // Run a Specialist page, which each row opens with that specialist already selected.
  //
  // A run performed in THIS browser session takes precedence over the server snapshot,
  // because the snapshot was taken before that run happened.
  function renderSpecialistSummary(specialists) {
    const area = document.getElementById('specialistSummaryArea');
    if (!area) return;
    area.innerHTML = '';

    SPECIALISTS.forEach((sp) => {
      const session = agentRunState[sp.id];
      const entry = specialists && specialists[sp.id];

      let status;
      let detail;
      if (session) {
        status = session.status;
        detail = 'Run just now, this session';
      } else if (entry) {
        status =
          entry.last_status === 'success' || entry.last_status === 'error' || entry.last_status === 'partial'
            ? entry.last_status
            : 'partial';
        const parts = [];
        if (entry.last_run_at) parts.push(formatWhen(entry.last_run_at));
        if (typeof entry.last_result_count === 'number') parts.push(entry.last_result_count + ' record(s)');
        detail = parts.join(' · ');
      } else {
        status = 'idle';
        detail = 'Never run';
      }

      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'spec-row';
      row.setAttribute('aria-label', 'Open ' + sp.name + ' in Run a Specialist');

      const main = document.createElement('span');
      main.className = 'spec-row-main';
      const name = document.createElement('span');
      name.className = 'spec-row-name';
      name.textContent = sp.name;
      main.appendChild(name);
      if (detail) {
        const meta = document.createElement('span');
        meta.className = 'spec-row-meta';
        meta.textContent = detail;
        main.appendChild(meta);
      }
      row.appendChild(main);

      const chip = document.createElement('span');
      chip.className = 'status-chip ' + (status === 'idle' ? 'idle' : status);
      chip.textContent = status === 'idle' ? 'Not run' : status;
      row.appendChild(chip);

      row.addEventListener('click', () => openSpecialistOnRunPage(sp.id));
      area.appendChild(row);
    });
  }

  // RELAY ONLY - renders exactly the opportunity items GET /overview already
  // extracted from real saved results (agent/core/crossAgentContext.js's
  // growth_opportunity_drafts + each specialist's own recommendations). No
  // ranking or scoring happens here; items are shown in the order the server
  // returned them.

  /* ---------- Top market opportunities ----------
     RELAY ONLY. Every value drawn here comes from GET /overview's `market_research`
     block, which server.js read straight out of a SAVED run record. This file computes no
     score, re-ranks nothing, derives no trend, and calculates no customer fit - all of
     that already happened in the research pipeline and is displayed as it was recorded.

     OPENING THE DASHBOARD NEVER RUNS RESEARCH. There is no fetch here beyond the
     /overview call the page already made; if no research has been saved, the section says
     so rather than starting one.

     NULL IS NOT ZERO. A metric the research reported as null renders "Unavailable" with
     the reason the backend gave. A real measured 0 renders as 0. */
  const OVERVIEW_MARKET_OPPORTUNITY_LIMIT = 3;
  let latestMarketResearch = null;

  // A signal block ({metric, value, unit, grade, assessment, ...}) as one readable line.
  // A number survives only when the research kept one; otherwise its own assessment is
  // shown, and failing that an explicit "Unavailable".
  function marketSignalText(signal) {
    if (!signal || typeof signal !== 'object') return 'Unavailable';
    if (signal.value !== null && signal.value !== undefined) {
      return String(signal.value) + (signal.unit ? ' ' + signal.unit : '');
    }
    if (signal.assessment) return signal.assessment;
    return 'Unavailable';
  }

  // The grade the research assigned (measured / estimated / derived / inferred / unknown),
  // shown alongside a value so a characterisation can never read as a measurement.
  function marketGradeText(signal) {
    return signal && signal.grade ? signal.grade : null;
  }

  function marketComplianceChip(compliance) {
    const status = compliance && compliance.status ? compliance.status : null;
    const chip = document.createElement('span');
    // PASS reads as connected/green; REVIEW and BLOCK deliberately do NOT - a REVIEW is
    // never presented as cleared, and a BLOCK never as recommended.
    chip.className = 'status-chip ' + (status === 'PASS' ? 'connected' : status === 'BLOCK' ? 'error' : 'not-connected');
    chip.textContent = status ? (status === 'REVIEW' ? 'REVIEW — needs a human' : status) : 'No verdict';
    return chip;
  }

  // One opportunity. `compact` drops the evidence/why-this-fits detail so Overview stays
  // an executive summary; the History detail view renders the full form.
  function marketOpportunityCard(opportunity, compact) {
    const card = document.createElement('div');
    card.className = 'panel-card market-opportunity';

    const head = document.createElement('div');
    head.className = 'market-opportunity-head';
    const name = document.createElement('div');
    name.className = 'market-opportunity-title';
    name.textContent = '#' + opportunity.rank + '  ' + (opportunity.product || '(unnamed opportunity)');
    head.appendChild(name);
    head.appendChild(marketComplianceChip(opportunity.compliance));
    card.appendChild(head);

    if (opportunity.market) {
      const market = document.createElement('div');
      market.className = 'market-opportunity-market';
      market.textContent = opportunity.market;
      card.appendChild(market);
    }

    if (opportunity.customer_fit_reason) {
      const fit = document.createElement('div');
      fit.className = 'market-opportunity-fit';
      fit.textContent = opportunity.customer_fit_reason;
      card.appendChild(fit);
    }

    // The four assessments, each with the research's own grade. Nothing is inferred here -
    // an unavailable metric says so.
    const grid = document.createElement('div');
    grid.className = 'market-signal-grid';
    [
      ['Demand', opportunity.demand],
      ['Competition', opportunity.competition],
      ['Trend', opportunity.trend],
      ['Commercial', opportunity.commercial],
    ].forEach(function (pair) {
      const label = pair[0];
      const signal = pair[1];
      const cell = document.createElement('div');
      cell.className = 'market-signal';
      const lab = document.createElement('div');
      lab.className = 'market-signal-label';
      lab.textContent = label;
      const val = document.createElement('div');
      val.className = 'market-signal-value';
      // Trend carries its own classification vocabulary, used verbatim - "seasonal" is
      // never shown as "growing", and "unknown" is never shown as "stable".
      val.textContent = label === 'Trend'
        ? (signal && signal.classification ? signal.classification : 'unknown')
        : marketSignalText(signal);
      if (val.textContent === 'Unavailable') val.classList.add('unavailable');
      cell.appendChild(lab);
      cell.appendChild(val);
      const grade = marketGradeText(signal);
      if (grade) {
        const g = document.createElement('div');
        g.className = 'market-signal-grade';
        g.textContent = grade;
        cell.appendChild(g);
      }
      grid.appendChild(cell);
    });
    card.appendChild(grid);

    const scores = opportunity.scores || {};
    const scoreLine = document.createElement('div');
    scoreLine.className = 'market-opportunity-scores';
    const bits = [];
    if (typeof scores.rank_score === 'number') bits.push('Rank score ' + scores.rank_score);
    if (typeof scores.customer_fit === 'number') bits.push('Customer fit ' + scores.customer_fit);
    if (typeof scores.evidence_coverage === 'number') bits.push('Evidence coverage ' + scores.evidence_coverage);
    if (opportunity.confidence) bits.push('Confidence: ' + opportunity.confidence);
    scoreLine.textContent = bits.join(' · ');
    card.appendChild(scoreLine);

    // The research's own statement of what its ranking means, verbatim - so the number
    // above can never be read as a sales or profit prediction.
    if (scores.rank_basis) {
      const basis = document.createElement('div');
      basis.className = 'panel-note';
      basis.textContent = scores.rank_basis;
      card.appendChild(basis);
    }

    if (compact) return card;

    // --- full form only: why this fits, and the sources ---
    const matched = scores.matched_terms || {};
    const reasons = [];
    (matched.primary_market || []).forEach(function (t) { reasons.push('In this business’s primary market: ' + t); });
    (matched.related_market || []).forEach(function (t) { reasons.push('Overlaps a category it already sells: ' + t); });
    (matched.buyer_intent || []).forEach(function (t) { reasons.push('Shares a recurring catalogue term: ' + t); });
    if (reasons.length > 0) {
      const why = document.createElement('details');
      why.className = 'result-details';
      const whyLabel = document.createElement('summary');
      whyLabel.textContent = 'Why this fits (' + reasons.length + ')';
      why.appendChild(whyLabel);
      reasons.forEach(function (reason) {
        const row = document.createElement('div');
        row.className = 'market-evidence-row';
        row.textContent = reason;
        why.appendChild(row);
      });
      card.appendChild(why);
    }

    // Sources: only URLs the research actually recorded. None are constructed here.
    const evidence = Array.isArray(opportunity.evidence) ? opportunity.evidence : [];
    const urls = [];
    evidence.forEach(function (item) {
      if (item && item.source_url && urls.indexOf(item.source_url) === -1) urls.push(item.source_url);
    });
    if (urls.length > 0) {
      const sources = document.createElement('details');
      sources.className = 'result-details';
      const sourcesLabel = document.createElement('summary');
      sourcesLabel.textContent = 'Sources (' + urls.length + ')';
      sources.appendChild(sourcesLabel);
      evidence.forEach(function (item) {
        if (!item || !item.source_url) return;
        const row = document.createElement('div');
        row.className = 'market-evidence-row';
        const link = document.createElement('a');
        link.href = item.source_url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = item.source_url;
        const meta = document.createElement('span');
        meta.className = 'market-evidence-meta';
        const metaBits = [];
        if (item.metric) metaBits.push(item.metric);
        if (item.grade) metaBits.push(item.grade);
        if (item.retrieved_at) metaBits.push(new Date(item.retrieved_at).toLocaleString());
        meta.textContent = metaBits.length > 0 ? '  ' + metaBits.join(' · ') : '';
        row.appendChild(link);
        row.appendChild(meta);
        sources.appendChild(row);
      });
      card.appendChild(sources);
    } else {
      const none = document.createElement('div');
      none.className = 'panel-note';
      none.textContent = 'No source URL was recorded for this opportunity.';
      card.appendChild(none);
    }

    return card;
  }

  // The research funnel and provenance, as real counts. A count the result did not carry
  // renders "Unavailable" - never 0, because a measured zero and a missing figure are
  // different facts.
  function marketResearchSummaryCard(research) {
    const card = document.createElement('div');
    card.className = 'panel-card';

    const counts = research.candidate_count || null;
    const summary = research.research_summary || null;
    const scope = research.market_scope || null;
    const evidenced = (research.opportunities || []).filter(function (o) {
      return Array.isArray(o.evidence) && o.evidence.length > 0;
    }).length;

    const grid = document.createElement('div');
    grid.className = 'market-signal-grid';
    [
      ['Candidates discovered', counts ? counts.discovered : undefined],
      ['Unique candidates', counts ? counts.after_deduplication : undefined],
      ['Eligible after compliance', counts ? counts.compliance_eligible : undefined],
      ['Ranked', counts ? counts.ranked : undefined],
      ['Results returned', (research.opportunities || []).length],
      ['Evidence-backed', evidenced],
      ['Verified sources', summary ? summary.verified_source_count : undefined],
    ].forEach(function (pair) {
      const cell = document.createElement('div');
      cell.className = 'market-signal';
      const lab = document.createElement('div');
      lab.className = 'market-signal-label';
      lab.textContent = pair[0];
      const val = document.createElement('div');
      val.className = 'market-signal-value';
      // typeof check, NOT truthiness - a genuine 0 must display as 0.
      if (typeof pair[1] === 'number') {
        val.textContent = String(pair[1]);
      } else {
        val.textContent = 'Unavailable';
        val.classList.add('unavailable');
      }
      cell.appendChild(lab);
      cell.appendChild(val);
      grid.appendChild(cell);
    });
    card.appendChild(grid);

    const meta = document.createElement('div');
    meta.className = 'panel-note';
    const metaBits = [];
    if (scope && scope.primary_market) metaBits.push('Market scope: ' + scope.primary_market);
    if (scope && Array.isArray(scope.channels) && scope.channels.length > 0) {
      // The channels the customer CONTEXT came from, exactly as the research recorded
      // them. Never a claim that an opportunity belongs to a channel.
      metaBits.push('Catalogue context: ' + scope.channels.join(' + '));
    }
    const when = (summary && summary.generated_at) || research.created_at;
    metaBits.push(when ? 'Last research: ' + new Date(when).toLocaleString() : 'Last research: Unavailable');
    meta.textContent = metaBits.join('  ·  ');
    card.appendChild(meta);

    (research.limitations || []).forEach(function (limitation) {
      const row = document.createElement('div');
      row.className = 'panel-note';
      row.textContent = limitation;
      card.appendChild(row);
    });

    return card;
  }

  function renderMarketOpportunities(research) {
    const area = document.getElementById('marketOpportunityArea');
    const link = document.getElementById('viewAllMarketOpportunitiesLink');
    const scopeTag = document.getElementById('marketOpportunityScopeTag');
    if (!area) return;
    area.innerHTML = '';
    latestMarketResearch = research && research.available ? research : null;

    if (!research || !research.available) {
      const empty = document.createElement('div');
      empty.className = 'panel-card panel-empty';
      // The backend's own reason, verbatim.
      empty.textContent = (research && research.reason) || 'No market research run yet.';
      area.appendChild(empty);
      if (link) link.hidden = true;
      if (scopeTag) scopeTag.hidden = true;
      return;
    }

    const opportunities = Array.isArray(research.opportunities) ? research.opportunities : [];

    if (scopeTag && research.market_scope && research.market_scope.primary_market) {
      scopeTag.hidden = false;
      scopeTag.textContent = research.market_scope.primary_market;
    } else if (scopeTag) {
      scopeTag.hidden = true;
    }

    const status = document.createElement('div');
    status.className = 'panel-note';
    status.textContent = opportunities.length === 0
      ? 'Research ' + (research.research_status || 'completed') + ' — no qualifying opportunities were supported by the available evidence.'
      : 'Research ' + (research.research_status || 'completed') + ' — ' + opportunities.length + ' opportunit' + (opportunities.length === 1 ? 'y' : 'ies') + ' identified.';
    area.appendChild(status);

    if (opportunities.length === 0) {
      area.appendChild(marketResearchSummaryCard(research));
      if (link) link.hidden = true;
      return;
    }

    opportunities.slice(0, OVERVIEW_MARKET_OPPORTUNITY_LIMIT).forEach(function (opportunity) {
      area.appendChild(marketOpportunityCard(opportunity, true));
    });
    area.appendChild(marketResearchSummaryCard(research));

    // "View all" opens the EXISTING History detail view for this run - no new page, and
    // no second fetch of the research itself.
    if (link) {
      link.hidden = opportunities.length <= OVERVIEW_MARKET_OPPORTUNITY_LIMIT || !research.run_id;
      link.textContent = 'View all ' + opportunities.length + ' →';
    }
  }

  // The full list, rendered into the EXISTING History detail area (see
  // renderStoredRecordDetail). Up to 10 - or however many the research actually
  // supported. Never padded.
  function renderFullMarketOpportunities(record, container) {
    const plan = record && record.result && record.result.routing && Array.isArray(record.result.routing.plan)
      ? record.result.routing.plan
      : [];
    let result = null;
    plan.forEach(function (step) {
      const outputs = (step && step.outputs) || {};
      const candidate = outputs.result || outputs;
      if (!result && candidate && Array.isArray(candidate.top_opportunities)) result = candidate;
    });
    if (!result) return false;

    const heading = document.createElement('div');
    heading.className = 'section-label';
    heading.textContent = 'Market opportunities (' + result.top_opportunities.length + ')';
    container.appendChild(heading);

    result.top_opportunities.forEach(function (opportunity) {
      container.appendChild(marketOpportunityCard(opportunity, false));
    });

    container.appendChild(
      marketResearchSummaryCard({
        available: true,
        opportunities: result.top_opportunities,
        candidate_count: result.candidate_count || null,
        market_scope: result.market_scope || null,
        research_summary: result.research_summary || null,
        limitations: result.limitations || [],
        created_at: record.created_at,
      })
    );
    return true;
  }
  function renderOpportunities(list) {
    const area = document.getElementById('opportunityListArea');
    area.innerHTML = '';

    if (!list || list.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'panel-card panel-empty';
      empty.textContent =
        'No growth opportunities recorded yet — they will appear here once Research, Product, SEO, Listing, or Analytics & Optimization produces one.';
      area.appendChild(empty);
      return;
    }

    const wrap = document.createElement('div');
    wrap.className = 'opportunity-list';
    list.forEach((opp) => {
      const card = document.createElement('div');
      card.className = 'opportunity-card';

      const title = document.createElement('div');
      title.className = 'opportunity-title';
      title.textContent = opp.title;
      card.appendChild(title);

      if (opp.reason) {
        const reason = document.createElement('div');
        reason.className = 'opportunity-reason';
        reason.textContent = opp.reason;
        card.appendChild(reason);
      }

      const meta = document.createElement('div');
      meta.className = 'opportunity-meta';
      if (opp.specialist_name) {
        const tag = document.createElement('span');
        tag.className = 'opportunity-tag';
        tag.textContent = opp.specialist_name;
        meta.appendChild(tag);
      }
      if (opp.verification_status === 'verified') {
        const verified = document.createElement('span');
        verified.className = 'opportunity-tag verified';
        verified.textContent = 'Verified';
        meta.appendChild(verified);
      }
      if (opp.created_at) {
        const when = document.createElement('span');
        when.textContent = formatWhen(opp.created_at);
        meta.appendChild(when);
      }
      if (opp.run_id) {
        const link = document.createElement('button');
        link.type = 'button';
        link.className = 'opportunity-link';
        link.textContent = 'View result →';
        link.addEventListener('click', () => {
          selectPage('history');
          loadHistoryDetail(opp.run_id);
        });
        meta.appendChild(link);
      }
      card.appendChild(meta);
      wrap.appendChild(card);
    });
    area.appendChild(wrap);
  }

  // AI growth status: a mix of persisted, all-time counts from GET /overview and
  // this dashboard's existing SESSION-only tracking (agentRunState/approvalLog) -
  // the exact two real counters the original stat row already showed, now placed
  // alongside the server's own history-backed counts rather than replacing them.
  // #statRunsCount and #statPendingApprovals keep their original ids, so
  // markAgentRun() and refreshApprovalBadges() (defined above/below, unchanged)
  // keep updating them live with no further wiring needed here.
  function renderGrowthStatus(growth) {
    const row = document.getElementById('growthStatusRow');
    row.innerHTML = '';

    function addTile(label, value, opts) {
      const options = opts || {};
      const tile = document.createElement('div');
      tile.className = 'stat-tile';
      const labelEl = document.createElement('div');
      labelEl.className = 'stat-label';
      labelEl.textContent = label;
      const valueEl = document.createElement('div');
      valueEl.className = 'stat-value' + (options.accent ? ' accent' : '');
      if (options.small) valueEl.style.fontSize = '14px';
      if (options.id) valueEl.id = options.id;
      valueEl.textContent = value === null || value === undefined || value === '' ? 'No data' : String(value);
      tile.appendChild(labelEl);
      tile.appendChild(valueEl);
      row.appendChild(tile);
    }

    // Trimmed to three for the executive view. #statPendingApprovals and #statRunsCount
    // keep their original ids, so refreshApprovalBadges() and markAgentRun() (unchanged)
    // still update them live with no extra wiring.
    addTile(
      'Specialists run',
      growth && growth.specialists_total ? growth.specialists_run + ' / ' + growth.specialists_total : null
    );
    addTile('Approvals pending', approvalLog.filter((a) => a.status === 'pending').length, {
      accent: true,
      id: 'statPendingApprovals',
    });
    addTile('Runs this session', runsCompletedCount + ' / ' + SPECIALISTS.length, { id: 'statRunsCount' });
  }

  function statusChip(status) {
    const chip = document.createElement('span');
    chip.className = 'status-chip ' + historyStatusClass(status);
    chip.textContent = status || 'unknown';
    return chip;
  }

  // The channel a run was explicitly about, for the meta line of an activity/run/history
  // row. Returns null when the record carries no channel - which is every run saved
  // before this field existed and every run whose trigger is not channel-scoped - so
  // those rows render exactly as they always have. Never guessed from an objective's
  // wording or a product title: a wrong channel label would attribute one store's work
  // to another.
  //
  // Shopify runs read null today for that reason, and labelling them is a deferred,
  // separately-scoped task - see agent/core/runHistoryStore.js's `channel` field for the
  // full rationale. This function already handles 'shopify' the day such a run exists, so
  // that task needs no change here.
  function channelLabel(entry) {
    if (!entry || !entry.channel) return null;
    return entry.channel === 'etsy' ? 'Etsy' : entry.channel === 'shopify' ? 'Shopify' : entry.channel;
  }

  // One activity/run row - shared by the Recent AI Activity and Recent Runs
  // panels below, both fed from the same GET /overview.activity list (a relay of
  // agent/core/runHistoryStore.js's own saved summaries). "View" reuses the
  // existing History page's own detail loader (loadHistoryDetail, defined
  // further down) rather than building a second result viewer.
  function activityRow(entry) {
    const row = document.createElement('div');
    row.className = 'activity-row';

    const main = document.createElement('div');
    main.className = 'activity-row-main';
    const kindLabel =
      entry.kind === 'orchestrate'
        ? 'Chief Orchestrator'
        : entry.kind === 'growth_workflow'
          ? 'Growth workflow'
          : entry.kind === 'optimization_cycle'
            ? 'Optimization cycle'
            : entry.specialist_name || entry.specialist_id || 'Specialist';
    const title = document.createElement('div');
    title.className = 'activity-row-title';
    title.textContent = entry.objective || kindLabel;
    main.appendChild(title);
    const meta = document.createElement('div');
    meta.className = 'activity-row-meta';
    // "Etsy · SEO · 3 minutes ago" when the run stated its channel; unchanged otherwise.
    const channel = channelLabel(entry);
    meta.textContent = (channel ? channel + ' · ' : '') + kindLabel + ' · ' + formatWhen(entry.created_at);
    main.appendChild(meta);
    row.appendChild(main);

    row.appendChild(statusChip(entry.status));

    const link = document.createElement('button');
    link.type = 'button';
    link.className = 'activity-row-link';
    link.textContent = 'View →';
    link.addEventListener('click', () => {
      selectPage('history');
      loadHistoryDetail(entry.run_id);
    });
    row.appendChild(link);

    return row;
  }

  function renderActivityList(containerId, entries, emptyText) {
    const area = document.getElementById(containerId);
    area.innerHTML = '';
    if (!entries || entries.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'panel-empty';
      empty.textContent = emptyText;
      area.appendChild(empty);
      return;
    }
    entries.forEach((entry) => area.appendChild(activityRow(entry)));
  }

  // Connected Channels: renders every channel GET /overview reported, in a fixed
  // order. A channel with no real adapter in this repo (adapter_exists: false)
  // is shown as unavailable with no connect control - this dashboard never
  // implies an integration that does not exist yet (CLAUDE.md scope discipline).
  function renderChannels(channels) {
    const area = document.getElementById('channelListArea');
    area.innerHTML = '';
    const byId = {};
    (channels || []).forEach((c) => {
      byId[c.id] = c;
    });

    CHANNEL_DISPLAY_ORDER.forEach((id) => {
      const c = byId[id];
      if (!c) return;
      const row = document.createElement('div');
      row.className = 'channel-row';
      const name = document.createElement('div');
      name.textContent = c.name;
      row.appendChild(name);

      const chip = document.createElement('span');
      if (!c.adapter_exists) {
        chip.className = 'status-chip unavailable';
        chip.textContent = 'Not available';
      } else if (c.configured && c.access === 'read_only') {
        // A connection the server proved is READ-only says so on the chip. Labelling it
        // plain "Connected" would let an owner reasonably assume the agent can publish
        // there, which it deliberately cannot.
        chip.className = 'status-chip read-only';
        chip.textContent = 'Connected — Read only';
      } else if (c.configured) {
        chip.className = 'status-chip connected';
        chip.textContent = 'Connected';
      } else {
        chip.className = 'status-chip not-connected';
        chip.textContent = 'Not connected';
      }
      row.appendChild(chip);
      area.appendChild(row);
    });
  }

  // Approvals: this session's own live approval log (approvalLog, defined above -
  // the same real data the Approval Center page reads) plus the persisted,
  // all-time counts GET /overview derived from saved run records. No second
  // approval mechanism is built here - "Review" always hands off to the real
  // Approval Center page.
  // Compact approval summary. The list of individual approvals and the Approve/Reject
  // controls stay on the existing Approval Center page - this is a count and a route to
  // it, never a second approval surface.
  function renderApprovalsOverview(growth) {
    const area = document.getElementById('approvalsOverviewArea');
    area.innerHTML = '';

    const sessionPending = approvalLog.filter((a) => a.status === 'pending').length;
    const savedPending = growth && typeof growth.approvals_pending === 'number' ? growth.approvals_pending : 0;
    const totalPending = sessionPending + savedPending;

    const headline = document.createElement('div');
    headline.className = totalPending > 0 ? 'approval-headline approval-headline-pending' : 'approval-headline';
    headline.textContent =
      totalPending > 0 ? totalPending + ' approval(s) waiting for you' : 'No approvals pending';
    area.appendChild(headline);

    if (growth && typeof growth.approvals_recorded === 'number') {
      const meta = document.createElement('div');
      meta.className = 'panel-note';
      meta.textContent = growth.approvals_recorded + ' approval(s) recorded across saved runs.';
      area.appendChild(meta);
    }

    // The link is revealed only when there is genuinely something to review.
    const link = document.getElementById('reviewApprovalsLink');
    if (link) link.hidden = totalPending === 0;
  }

  // Store Health: renders exactly the checks GET /overview computed from facts
  // this server can already verify (Shopify configured, run history readable,
  // any failed/partial saved runs, outstanding approvals). No check is added or
  // removed on the client - a healthy system reports "ok", never a manufactured
  // warning.
  function renderStoreHealth(health) {
    const area = document.getElementById('storeHealthArea');
    area.innerHTML = '';
    if (!health || health.length === 0) {
      area.innerHTML = '<div class="panel-empty">No health checks available.</div>';
      return;
    }
    health.forEach((check) => {
      const row = document.createElement('div');
      row.className = 'health-row';
      const label = document.createElement('div');
      label.textContent = check.label;
      row.appendChild(label);
      const chip = document.createElement('span');
      chip.className = 'status-chip ' + (check.status === 'ok' ? 'ok' : check.status === 'error' ? 'error' : 'warn');
      chip.textContent = check.status;
      row.appendChild(chip);
      area.appendChild(row);
    });
  }

  /* ---------- Sales funnel ----------
     RELAY ONLY. Stage values and unavailability reasons both come from
     GET /store/metrics's `funnel` block. A stage the server marked unavailable shows the
     server's own reason - never a 0, a dash, or a bar of arbitrary width, any of which
     would read as a measurement. Bar widths are drawn ONLY for stages that have a real
     number, scaled against the largest real number present. */
  function renderFunnel(funnel) {
    const area = document.getElementById('funnelArea');
    area.innerHTML = '';
    if (!funnel || !Array.isArray(funnel.stages) || funnel.stages.length === 0) {
      area.innerHTML = '<div class="panel-empty">No data available.</div>';
      return;
    }

    const known = funnel.stages.filter((s) => s.available && typeof s.value === 'number');
    const maxValue = known.length > 0 ? Math.max.apply(null, known.map((s) => s.value)) : 0;

    funnel.stages.forEach((stage, i) => {
      const row = document.createElement('div');
      row.className = 'funnel-stage' + (stage.available ? '' : ' funnel-stage-unavailable');

      const head = document.createElement('div');
      head.className = 'funnel-stage-head';
      const label = document.createElement('span');
      label.className = 'funnel-stage-label';
      label.textContent = stage.label;
      const value = document.createElement('span');
      value.className = 'funnel-stage-value';
      value.textContent = stage.available && typeof stage.value === 'number' ? String(stage.value) : 'Not available';
      head.appendChild(label);
      head.appendChild(value);
      row.appendChild(head);

      const track = document.createElement('div');
      track.className = 'funnel-bar-track';
      if (stage.available && typeof stage.value === 'number' && maxValue > 0) {
        const bar = document.createElement('div');
        bar.className = 'funnel-bar';
        bar.style.width = Math.max((stage.value / maxValue) * 100, 2) + '%';
        track.appendChild(bar);
      }
      row.appendChild(track);

      area.appendChild(row);

      if (i < funnel.stages.length - 1) {
        const arrow = document.createElement('div');
        arrow.className = 'funnel-arrow';
        arrow.textContent = '↓';
        arrow.setAttribute('aria-hidden', 'true');
        area.appendChild(arrow);
      }
    });

    // The unavailable stages all share one reason, so it is stated ONCE and names exactly
    // which stages it covers - repeating the identical sentence under four stages made the
    // section tall without making it any more honest.
    const unavailable = funnel.stages.filter((s) => !s.available);
    const reasons = [...new Set(unavailable.map((s) => s.reason).filter(Boolean))];
    if (unavailable.length > 0 && reasons.length > 0) {
      const note = document.createElement('div');
      note.className = 'panel-note';
      const names = unavailable.map((s) => s.label).join(', ');
      note.textContent =
        reasons.length === 1 ? names + ': ' + reasons[0] : unavailable.map((s) => s.label + ': ' + s.reason).join(' ');
      area.appendChild(note);
    }

    // Said plainly, because a funnel whose drop-off cannot be computed must not leave the
    // owner guessing that the gaps are conversion losses.
    if (funnel.drop_off_available === false && funnel.drop_off_reason) {
      const note = document.createElement('div');
      note.className = 'panel-note';
      note.textContent = funnel.drop_off_reason;
      area.appendChild(note);
    }
  }

  /* ---------- Top products ----------
     Rows come from GET /store/metrics's `top_products`, ranked by
     agent/core/analyticsMetricsCalculator.js's calculateTopProductsBySales() over real
     order line items. Revenue and views columns are deliberately absent - the server
     states why, and that reason is shown rather than an empty or apportioned column. */
  function renderTopProducts(topProducts) {
    const area = document.getElementById('topProductsArea');
    area.innerHTML = '';
    if (!topProducts || !topProducts.available || !topProducts.products || topProducts.products.length === 0) {
      area.innerHTML = '<div class="panel-empty">No data available — no real (non-test) order line items have been retrieved yet.</div>';
      return;
    }

    const table = document.createElement('div');
    table.className = 'product-table';
    const header = document.createElement('div');
    header.className = 'product-row product-row-head';
    header.innerHTML =
      '<span>Product</span><span class="product-num">Units</span><span class="product-num">Orders</span>';
    table.appendChild(header);

    topProducts.products.forEach((product) => {
      const row = document.createElement('div');
      row.className = 'product-row';
      const name = document.createElement('span');
      name.className = 'product-name';
      name.textContent = product.title;
      name.title = product.title;
      const units = document.createElement('span');
      units.className = 'product-num';
      units.textContent = String(product.units);
      const orders = document.createElement('span');
      orders.className = 'product-num';
      orders.textContent = String(product.orders);
      row.appendChild(name);
      row.appendChild(units);
      row.appendChild(orders);
      table.appendChild(row);
    });
    area.appendChild(table);

    const notes = [];
    if (topProducts.revenue_available === false && topProducts.revenue_reason) notes.push(topProducts.revenue_reason);
    if (topProducts.views_available === false && topProducts.views_reason) notes.push(topProducts.views_reason);
    if (notes.length > 0) {
      const note = document.createElement('div');
      note.className = 'panel-note';
      note.textContent = notes.join(' ');
      area.appendChild(note);
    }
  }

  /* ---------- AI impact ----------
     Distinct from AI growth status above: that answers "how much has run?", this answers
     "what did it actually produce?". Every tile is a count the server derived from saved
     records; a null value renders "No data" rather than 0. */
  // Overview shows only the four headline impact figures - the rest of what the server
  // computed stays in the payload and is reachable through "View AI activity", so this
  // section answers the question at a glance instead of becoming a metric wall.
  const OVERVIEW_IMPACT_METRICS = ['products_analyzed', 'opportunities_identified', 'tasks_completed', 'actions_gated'];

  function renderAiImpact(metrics) {
    const row = document.getElementById('aiImpactRow');
    row.innerHTML = '';
    if (!Array.isArray(metrics) || metrics.length === 0) {
      row.innerHTML = '<div class="panel-empty">No data available.</div>';
      return;
    }
    const shown = metrics.filter((m) => OVERVIEW_IMPACT_METRICS.includes(m.id));
    (shown.length > 0 ? shown : metrics.slice(0, 4)).forEach((metric) => {
      const tile = document.createElement('div');
      tile.className = 'stat-tile';
      const label = document.createElement('div');
      label.className = 'stat-label';
      label.textContent = metric.label;
      const value = document.createElement('div');
      value.className = 'stat-value';
      const hasValue = metric.value !== null && metric.value !== undefined;
      value.textContent = hasValue ? Number(metric.value).toLocaleString() : 'No data';
      if (!hasValue) value.classList.add('stat-value-empty');
      tile.appendChild(label);
      tile.appendChild(value);
      if (metric.detail) {
        const detail = document.createElement('div');
        detail.className = 'stat-detail';
        detail.textContent = metric.detail;
        tile.appendChild(detail);
      }
      row.appendChild(tile);
    });
  }

  /* ---------- Next best actions ----------
     Every card is routed by the server from work that already exists (a pending approval,
     a relayed opportunity, a run that stopped for missing input, an unused specialist).
     `basis` states the fact that produced the card, so ordering is never an opaque score.
     Each button navigates to REAL existing functionality - and for a specialist action it
     reuses the Run a Specialist page's own selection, never a parallel run path. */
  function renderNextActions(allActions) {
    const area = document.getElementById('nextActionsArea');
    area.innerHTML = '';
    // Top 3 only. There is no existing page that lists every derived action, so no
    // "view all" link is offered here rather than pointing one at an unrelated page.
    const actions = Array.isArray(allActions) ? allActions.slice(0, OVERVIEW_ACTION_LIMIT) : allActions;
    if (!Array.isArray(actions) || actions.length === 0) {
      area.innerHTML =
        '<div class="panel-card panel-empty">Nothing is waiting on you right now — no approvals are pending and no saved run has produced an outstanding recommendation.</div>';
      return;
    }

    const list = document.createElement('div');
    list.className = 'action-list';
    actions.forEach((action, index) => {
      const card = document.createElement('div');
      card.className = 'action-card' + (action.emphasis === 'high' ? ' action-card-high' : '');

      const num = document.createElement('div');
      num.className = 'action-num';
      num.textContent = String(index + 1);
      card.appendChild(num);

      const body = document.createElement('div');
      body.className = 'action-body';
      const title = document.createElement('div');
      title.className = 'action-title';
      title.textContent = action.title;
      body.appendChild(title);
      if (action.basis) {
        const basis = document.createElement('div');
        basis.className = 'action-basis';
        basis.textContent = action.basis;
        body.appendChild(basis);
      }
      if (action.emphasis === 'high') {
        const tag = document.createElement('span');
        tag.className = 'action-tag';
        tag.textContent = 'High impact';
        body.appendChild(tag);
      }
      card.appendChild(body);

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'action-btn';
      btn.textContent = action.cta || 'Open';
      btn.addEventListener('click', () => {
        if (action.page === 'history' && action.run_id) {
          selectPage('history');
          loadHistoryDetail(action.run_id);
          return;
        }
        if (action.page === 'specialists' && action.specialist_id) {
          selectPage('specialists');
          // Reuses the existing specialist card's own click handler, so the objective is
          // prefilled exactly as it would be if the owner clicked it themselves. Nothing
          // is executed here - the owner still presses Run.
          const index = SPECIALISTS.findIndex((sp) => sp.id === action.specialist_id);
          const cards = document.querySelectorAll('.specialist-card');
          if (index >= 0 && cards[index]) cards[index].click();
          return;
        }
        selectPage(action.page || 'overview');
      });
      card.appendChild(btn);

      list.appendChild(card);
    });
    area.appendChild(list);
  }

  /* ---------- Chief Orchestrator status ----------
     Reads GET /overview's `orchestrator` block, which the server derived from saved
     orchestration records plus the live count of runs this server process is holding for
     a human decision. Nothing here starts, resumes, or polls a run. */
  const ORCHESTRATOR_STATE_LABELS = {
    ready: 'Ready',
    running: 'Running',
    completed: 'Completed',
    waiting_for_approval: 'Waiting for approval',
    incomplete: 'Incomplete',
    error: 'Error',
  };

  function renderOrchestrator(orchestrator) {
    const area = document.getElementById('orchestratorArea');
    // The status band's indicator dot follows the SAME tone as the state chip below, so the
    // dot can never say something the chip does not.
    const card = area.closest('.status-card');
    area.innerHTML = '';
    if (!orchestrator) {
      if (card) delete card.dataset.tone;
      area.innerHTML = '<div class="panel-empty">No data available.</div>';
      return;
    }

    const head = document.createElement('div');
    head.className = 'orch-head';
    const state = document.createElement('span');
    const cls =
      orchestrator.state === 'completed' || orchestrator.state === 'ready'
        ? 'ok'
        : orchestrator.state === 'error'
          ? 'error'
          : 'warn';
    if (card) card.dataset.tone = cls;
    state.className = 'status-chip ' + cls;
    state.textContent = ORCHESTRATOR_STATE_LABELS[orchestrator.state] || orchestrator.state;
    head.appendChild(state);
    if (orchestrator.paused_awaiting_approval > 0) {
      const paused = document.createElement('span');
      paused.className = 'orch-paused';
      paused.textContent = orchestrator.paused_awaiting_approval + ' run(s) paused for your decision';
      head.appendChild(paused);
    }
    area.appendChild(head);

    if (orchestrator.last_run) {
      const run = orchestrator.last_run;
      const meta = document.createElement('div');
      meta.className = 'orch-meta';
      meta.textContent =
        (run.objective || run.kind || 'Last run') + ' · ' + (run.created_at ? formatWhen(run.created_at) : 'unknown time');
      area.appendChild(meta);
      if (run.summary) {
        const summary = document.createElement('div');
        summary.className = 'orch-summary';
        summary.textContent = run.summary;
        area.appendChild(summary);
      }
      const link = document.createElement('button');
      link.type = 'button';
      link.className = 'link-btn';
      link.textContent = 'View run →';
      link.addEventListener('click', () => {
        selectPage('history');
        loadHistoryDetail(run.run_id);
      });
      area.appendChild(link);
    } else {
      const empty = document.createElement('div');
      empty.className = 'panel-empty';
      empty.textContent = orchestrator.detail || 'No orchestrated run has been saved yet.';
      area.appendChild(empty);
    }
  }

  /* ---------- AI usage ----------
     Real token/call counts summed by the server from the usage ledgers saved runs already
     carry. COST IS NOT SHOWN: this project has no model price table, so a currency figure
     would be invented - the server says so and that reason is displayed instead. */
  function renderAiUsage(usage) {
    const area = document.getElementById('aiUsageArea');
    area.innerHTML = '';
    if (!usage || !usage.available) {
      area.innerHTML =
        '<div class="panel-empty">No usage recorded yet — a run records token usage only when it goes through the Chief Orchestrator or a workflow.</div>';
      return;
    }

    // Three lines on the executive view; the input/output split and per-run detail remain
    // in the saved runs themselves, reachable through "View history".
    const rows = [
      ['Total tokens', usage.tokens_total],
      ['Model calls', usage.model_calls],
      ['Runs covered', usage.runs_with_usage],
    ];
    rows.forEach(([label, value]) => {
      if (value === null || value === undefined) return;
      const row = document.createElement('div');
      row.className = 'usage-row';
      const name = document.createElement('span');
      name.textContent = label;
      const val = document.createElement('span');
      val.className = 'usage-value';
      val.textContent = Number(value).toLocaleString();
      row.appendChild(name);
      row.appendChild(val);
      area.appendChild(row);
    });

    const note = document.createElement('div');
    note.className = 'panel-note';
    note.textContent = usage.cost_reason || '';
    area.appendChild(note);
  }

  /* ---------- AI provider status ----------
     The header pill and the Ask page's provider tag state what the SERVER reports in
     GET /overview's ai_provider: the provider AI_PROVIDER selects and whether its key is
     configured. It says "configured", never "connected" - a key being set is not proof a
     model call will succeed, and a failed call is reported by that call itself. */
  const AI_PROVIDER_NAMES = { gemini: 'Gemini', claude: 'Claude' };
  let aiProviderPill = { state: 'neutral', text: 'AI provider unknown' };

  function renderAiProvider(ai) {
    const providerTag = document.getElementById('providerTag');
    // A server that does not report ai_provider at all (an older deployment) is UNKNOWN,
    // not "not configured" - claiming either state would be a guess.
    if (ai === null || ai === undefined) {
      aiProviderPill = { state: 'neutral', text: 'AI provider status unavailable' };
      setStatus(aiProviderPill.state, aiProviderPill.text);
      if (providerTag) providerTag.textContent = 'provider: status unavailable';
      return;
    }
    if (ai && ai.provider && ai.configured) {
      aiProviderPill = { state: 'idle', text: (AI_PROVIDER_NAMES[ai.provider] || ai.provider) + ' · configured' };
    } else if (ai && ai.provider) {
      aiProviderPill = { state: 'warn', text: (AI_PROVIDER_NAMES[ai.provider] || ai.provider) + ' · key not configured' };
    } else {
      aiProviderPill = { state: 'warn', text: 'AI provider not configured' };
    }
    if (ai && ai.detail) statusPill.title = ai.detail;
    setStatus(aiProviderPill.state, aiProviderPill.text);
    if (providerTag) providerTag.textContent = 'provider: ' + (ai && ai.provider ? ai.provider : 'not configured');
  }

  async function loadOverviewState() {
    try {
      const res = await apiFetch('/overview');
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        document.getElementById('ovBusinessName').textContent = 'Could not load store overview';
        return;
      }
      renderAiProvider(data.ai_provider || null);
      renderOverviewBusiness(data.business, data.channels);
      renderChannels(data.channels);
      // The filter is built from the SAME channel states the section above renders, so a
      // pill can never exist for a channel the server did not report as connected.
      renderChannelFilter(data.channels);
      renderGrowthStatus(data.growth || {});

      // Overview is a summary, so each list is capped here and the full record stays on
      // its existing detailed page. The server already returned more than this - nothing
      // is re-fetched to show the rest, the "view all" links just navigate there.
      const allOpportunities = data.opportunities || [];
      renderOpportunities(allOpportunities.slice(0, OVERVIEW_OPPORTUNITY_LIMIT));
      const viewAllOpps = document.getElementById('viewAllOpportunitiesLink');
      if (viewAllOpps) viewAllOpps.hidden = allOpportunities.length <= OVERVIEW_OPPORTUNITY_LIMIT;

      // The newest SAVED market research, relayed from the same /overview response.
      // No extra fetch, and nothing here starts a research run.
      renderMarketOpportunities(data.market_research || null);

      renderSpecialistSummary(data.specialists || {});
      const activity = data.activity || [];
      renderActivityList(
        'recentActivityArea',
        activity.slice(0, OVERVIEW_ACTIVITY_LIMIT),
        'No AI activity recorded yet — run a specialist or ask the Chief something, and it will appear here.'
      );
      renderActivityList('recentRunsArea', activity.slice(0, OVERVIEW_RUNS_LIMIT), 'No saved runs yet.');
      renderStoreHealth(data.health || []);
      renderApprovalsOverview(data.growth || {});
      renderAiImpact(data.ai_impact || []);
      renderNextActions(data.next_actions || []);
      renderOrchestrator(data.orchestrator || null);
      renderAiUsage(data.ai_usage || null);
    } catch (err) {
      document.getElementById('ovBusinessName').textContent = 'Could not reach the server';
    }
  }

  async function loadStoreMetrics() {
    try {
      const res = await apiFetch('/store/metrics');
      const data = await res.json().catch(() => ({}));
      renderStoreMetrics(res.ok ? data : null);
      renderPerformance(res.ok ? data.trends : null);
      renderFunnel(res.ok ? data.funnel : null);
      renderTopProducts(res.ok ? data.top_products : null);
      renderEtsyCatalog(res.ok ? data.etsy : null);
    } catch (err) {
      renderStoreMetrics(null);
      renderPerformance(null);
      renderFunnel(null);
      renderTopProducts(null);
      renderEtsyCatalog(null);
    }
  }

  // The Overview page's one entry point - called on initial page load (below) and
  // every time the user navigates back to Overview (see selectPage above). The
  // local, zero-network state loads first so the page is never blank while the
  // live Shopify pull (server-cached, see server.js's METRICS_TTL_MS) is in flight.
  async function loadOverview() {
    await loadOverviewState();
    // Zero-network like /overview: the stage definitions for the How it works summary.
    // Not awaited, so the live Shopify pull below is never held up by it.
    loadWorkflowPreview();
    await loadStoreMetrics();
  }

  /* ---------- Overview summary limits + "view all" routing ----------
     Overview is an executive summary: each list is capped, and every link below goes to
     an EXISTING page (History, Run a Specialist, Approval Center). No new page, no new
     endpoint, and no destination is invented - a link is only rendered where a real
     destination exists. */
  const OVERVIEW_OPPORTUNITY_LIMIT = 3;
  const OVERVIEW_ACTION_LIMIT = 3;
  const OVERVIEW_ACTIVITY_LIMIT = 4;
  const OVERVIEW_RUNS_LIMIT = 3;

  function wireOverviewLink(id, handler) {
    const el = document.getElementById(id);
    if (el) el.addEventListener('click', handler);
  }

  wireOverviewLink('openWorkflowLink', () => selectPage('workflow'));
  wireOverviewLink('viewAllHistoryBtn', () => selectPage('history'));
  wireOverviewLink('viewAllActivityLink', () => selectPage('history'));
  wireOverviewLink('viewAiActivityLink', () => selectPage('history'));
  wireOverviewLink('viewAllOpportunitiesLink', () => selectPage('history'));
  // Opens the existing History detail view for the research run itself - no new page,
  // and no second request for the research.
  wireOverviewLink('viewAllMarketOpportunitiesLink', () => {
    if (latestMarketResearch && latestMarketResearch.run_id) {
      selectPage('history');
      loadHistoryDetail(latestMarketResearch.run_id);
    }
  });
  wireOverviewLink('viewUsageHistoryLink', () => selectPage('history'));
  wireOverviewLink('reviewApprovalsLink', () => selectPage('approvals'));
  wireOverviewLink('openSpecialistsLink', () => selectPage('specialists'));
  // Performance detail = the Analytics & Optimization specialist, which is what actually
  // produces a deeper store-performance result in this system.
  wireOverviewLink('perfDetailsLink', () => openSpecialistOnRunPage('analytics'));

  /* ==========================================================================
     Autonomy page: a READ-ONLY view of GET /autonomy/state. Nothing here turns
     autonomy on, creates or enables a schedule, starts a cycle, or approves
     anything - those remain deliberate owner actions on the server.
     ========================================================================== */
  async function loadAutonomy() {
    const area = document.getElementById('autonomyArea');
    if (!area) return;
    area.innerHTML = '<p class="empty-result">Loading autonomy state…</p>';
    let data;
    try {
      const res = await apiFetch('/autonomy/state');
      data = await res.json();
      if (!res.ok) throw new Error((data && data.error) || 'Could not load the autonomy state.');
    } catch (err) {
      area.innerHTML = '<p class="empty-result">' + escapeHtml(err.message || 'Could not load the autonomy state.') + '</p>';
      return;
    }

    const fact = (title, text) =>
      '<div class="gate-explainer-item"><div class="gate-explainer-title">' + escapeHtml(title) +
      '</div><div class="gate-explainer-text">' + escapeHtml(text) + '</div></div>';
    const list = (items, render, empty) =>
      Array.isArray(items) && items.length
        ? '<ul>' + items.map((item) => '<li>' + escapeHtml(render(item)) + '</li>').join('') + '</ul>'
        : '<div class="session-note">' + escapeHtml(empty) + '</div>';

    const autonomy = data.business_autonomy || {};
    const killSwitch = data.kill_switch === 'on' ? 'On' : data.kill_switch === 'malformed' ? 'Malformed — treated as off' : 'Off';
    const businessAutonomy = autonomy.readable === false
      ? 'Configuration unreadable (' + (autonomy.reason_code || 'unknown') + ')'
      : autonomy.enabled ? 'Enabled in this business’s configuration' : 'Not enabled in this business’s configuration';
    const storage = data.storage && data.storage.durable ? 'Durable — cycles may run here' : 'Not durable — cycles are refused here';

    area.innerHTML =
      '<div class="gate-explainer">' +
      fact('Kill switch', killSwitch) +
      fact('Business autonomy', businessAutonomy) +
      fact('Storage', storage) +
      fact('Enabled platforms', (data.enabled_platforms || []).join(', ') || 'None') +
      '</div>' +
      '<h3>Schedules</h3>' +
      list(data.schedules, (job) => job.job_id + ' — ' + (job.enabled ? 'enabled' : 'disabled') + ' — ' + ((job.task && job.task.tool_id) || '') + (job.last_status ? ' — last: ' + job.last_status : ''), 'No schedules have been created for this business.') +
      '<h3>Waiting for your approval</h3>' +
      list(data.pending_approvals, (item) => item.approval_id + ' — ' + item.tool_id + (item.compliance_status ? ' — compliance ' + item.compliance_status : '') + (item.expires_at ? ' — expires ' + item.expires_at : '') + (item.reason ? ' — ' + item.reason : ''), 'Nothing from the autonomous cycle is waiting for your approval.') +
      // What the latest cycle actually did, step by step, as the server recorded it. Read-only:
      // nothing here can re-run, decide or change a step.
      '<h3>Latest cycle</h3>' +
      (data.latest_cycle
        ? '<div class="session-note">' + escapeHtml((data.latest_cycle.created_at ? data.latest_cycle.created_at + ' — ' : '') + 'status ' + (data.latest_cycle.status || 'unknown')) + '</div>' +
          list(data.latest_cycle.steps, (step) => (step.parent_job_id ? step.parent_job_id + ' → ' : '') + step.job_id + ' — ' + (step.outcome || '') + (step.reason_code ? ' — why: ' + step.reason_code : '') + (step.verification_status ? ' — verification: ' + step.verification_status : '') + (step.approval_request_id ? ' — approval ' + step.approval_request_id : ''), 'The latest cycle had no due jobs.')
        : '<div class="session-note">No autonomous cycle has run for this business yet.</div>') +
      '<h3>Recent autonomous runs</h3>' +
      list(data.recent_runs, (run) => (run.created_at ? run.created_at + ' — ' : '') + (run.kind || '') + ' — ' + (run.status || '') + (run.summary ? ' — ' + run.summary : ''), 'No autonomous cycle has run for this business yet.');
  }

  // Initial load: Overview starts as the active page (see index.html's
  // `pageOverview` carrying the `active` class by default), so it must hydrate
  // itself once here rather than waiting for a nav click that may never come.
  loadOverview();


  /* ==========================================================================
     HOW AVENLY AI WORKS - the customer-facing workflow map.

     PRESENTATION ONLY. Every status here comes from GET /workflow/state, which
     projects the REAL saved run. Nothing on this page executes anything, and no
     node is ever coloured "completed" by this file's own choice - it renders the
     state the server derived. With no run, every node reads "Not run".

     The stage copy (purpose, inputs, outputs) also comes from the server, out of
     agent/core/workflowNarrative.js - the same definitions the PDF is built from,
     so the page and the document cannot drift apart.
     ========================================================================== */
  let workflowData = null;

  // The customer-facing state -> the dashboard's existing chip vocabulary. An
  // unrecognised state gets the neutral chip rather than being flattered into "ok".
  function workflowToneClass(tone) {
    if (tone === 'ok') return 'ok';
    if (tone === 'active') return 'warn';
    if (tone === 'warn') return 'warn';
    if (tone === 'error') return 'error';
    return 'idle';
  }

  // PRESENTATION ONLY. The map's shape comes from each stage's own `kind`: the specialist
  // stage is the run of consecutive `agent` stages between the Chief and the gates. These
  // labels only caption stages the definitions already contain; a stage with no entry here is
  // captioned by its own title, so a new stage never renders uncaptioned or invented.
  const WORKFLOW_STAGE_LABELS = {
    goal: 'Input',
    chief: 'Orchestration',
    compliance: 'Compliance gate',
    approval: 'Human decision',
    platform_action: 'Platform boundary',
  };
  // A run of at least this many consecutive specialist stages is drawn as one grouped stage.
  // The run's LAST stage stays on the main line: it is the one that hands the prepared work
  // on to the gates (Listing's draft is what Compliance checks).
  const WORKFLOW_GROUP_MIN_AGENTS = 3;

  function workflowNode(stageKey, definition, state) {
    const node = document.createElement('button');
    node.type = 'button';
    node.className = 'workflow-node';
    node.dataset.stage = stageKey;
    node.dataset.kind = definition.kind;
    node.dataset.state = state.state;
    node.setAttribute('aria-label', definition.title + ' - ' + state.state_label);

    const head = document.createElement('span');
    head.className = 'workflow-node-head';
    const title = document.createElement('span');
    title.className = 'workflow-node-title';
    title.textContent = definition.title;
    head.appendChild(title);
    const chip = document.createElement('span');
    chip.className = 'status-chip ' + workflowToneClass(state.state_tone);
    chip.textContent = state.state_label;
    head.appendChild(chip);
    node.appendChild(head);

    const role = document.createElement('span');
    role.className = 'workflow-node-role';
    role.textContent = definition.kind === 'agent' ? 'Specialist agent' : definition.kind === 'gate' ? 'Gate' : definition.kind === 'boundary' ? 'Boundary' : definition.kind === 'orchestrator' ? 'Coordinator' : 'Your input';
    node.appendChild(role);

    const purpose = document.createElement('span');
    purpose.className = 'workflow-node-purpose';
    purpose.textContent = definition.purpose;
    node.appendChild(purpose);

    node.addEventListener('click', () => openWorkflowDrawer(stageKey));
    return node;
  }

  // A drawn connector - a CSS line and arrowhead, never a text glyph. `into` names what it
  // leads to: a link into a gate carries the existing "must pass this gate" note, the link
  // into the platform boundary is drawn crossing a boundary line, and the link into the
  // specialist stage ends on that stage's junction. Decorative: the order is the DOM order.
  function workflowLink(into) {
    const link = document.createElement('div');
    link.className = 'flow-link';
    link.setAttribute('aria-hidden', 'true');
    if (into) link.dataset.into = into;
    if (into === 'gate') {
      const text = document.createElement('span');
      text.className = 'flow-link-label';
      text.textContent = 'must pass this gate';
      link.appendChild(text);
    }
    if (into === 'boundary') {
      const rule = document.createElement('span');
      rule.className = 'flow-link-boundary';
      link.appendChild(rule);
    }
    return link;
  }

  // One step on a line: an optional stage caption above the stage's node.
  function workflowStep(key, definitions, caption) {
    const step = document.createElement('div');
    step.className = 'flow-step';
    if (caption) {
      const label = document.createElement('div');
      label.className = 'flow-stage-label';
      label.textContent = caption;
      step.appendChild(label);
    }
    step.appendChild(workflowNode(key, definitions[key], workflowData.stages[key]));
    return step;
  }

  // The specialist stage. The Chief dispatches into it (the branch), the specialists sit in
  // the order the definitions give - each stage's nextStep is the one to its right - with a
  // handoff arrow between neighbours, and their work converges (the merge) before the main
  // line continues. Nothing here implies they run in parallel, or that any of them ran: each
  // node's chip is the real run's state.
  function workflowGroup(keys, definitions) {
    const group = document.createElement('div');
    group.className = 'flow-group';
    group.style.setProperty('--flow-count', String(keys.length));

    const legend = document.createElement('div');
    legend.className = 'flow-group-legend';
    legend.textContent = 'Specialist agents';
    group.appendChild(legend);

    const branch = document.createElement('div');
    branch.className = 'flow-branch';
    branch.setAttribute('aria-hidden', 'true');
    const row = document.createElement('div');
    row.className = 'flow-group-row';
    const merge = document.createElement('div');
    merge.className = 'flow-merge';
    merge.setAttribute('aria-hidden', 'true');

    keys.forEach((key) => {
      const drop = document.createElement('span');
      drop.className = 'flow-drop';
      branch.appendChild(drop);
      const cell = document.createElement('div');
      cell.className = 'flow-group-cell';
      cell.appendChild(workflowNode(key, definitions[key], workflowData.stages[key]));
      row.appendChild(cell);
      const rise = document.createElement('span');
      rise.className = 'flow-rise';
      merge.appendChild(rise);
    });

    group.appendChild(branch);
    group.appendChild(row);
    group.appendChild(merge);
    return group;
  }

  // The main line as the map draws it, in primary_flow order: a run of consecutive specialist
  // stages becomes one grouped stage plus its last member on the line; everything else is a
  // single step. Shared by the workflow map and the Overview's summary of it, so the two can
  // never group the same stages differently.
  function workflowMainLineItems(flow, definitions) {
    const items = [];
    for (let i = 0; i < flow.length;) {
      if (definitions[flow[i]].kind !== 'agent') {
        items.push({ key: flow[i] });
        i += 1;
        continue;
      }
      let end = i;
      while (end < flow.length && definitions[flow[end]].kind === 'agent') end += 1;
      const run = flow.slice(i, end);
      if (run.length >= WORKFLOW_GROUP_MIN_AGENTS) {
        items.push({ group: run.slice(0, -1) });
        items.push({ key: run[run.length - 1] });
      } else {
        run.forEach((key) => items.push({ key }));
      }
      i = end;
    }
    return items;
  }

  /* ---------- Overview: How it works, in brief ----------
     The same stage definitions GET /workflow/state serves the full map, drawn as one line and
     one loop. Titles and kinds only - no statuses, which the map itself carries - so this
     summary can never disagree with a run. The return step is drawn only when the last loop
     stage's own definition says it feeds back to the first. */
  function renderWorkflowPreview(state) {
    const area = document.getElementById('workflowPreviewArea');
    if (!area) return;
    area.innerHTML = '';
    if (!state || !Array.isArray(state.stage_definitions)) {
      area.innerHTML = '<div class="panel-empty">The workflow definition could not be loaded.</div>';
      return;
    }
    const definitions = {};
    state.stage_definitions.forEach((d) => { definitions[d.key] = d; });
    const known = (key) => Boolean(definitions[key]);

    const addRow = (label, fill) => {
      const row = document.createElement('div');
      row.className = 'flow-preview-row';
      const heading = document.createElement('div');
      heading.className = 'flow-preview-label';
      heading.textContent = label;
      row.appendChild(heading);
      const list = document.createElement('ol');
      list.className = 'flow-preview-steps';
      fill(list);
      row.appendChild(list);
      area.appendChild(row);
    };
    const addStep = (list, kind, title, sub) => {
      const item = document.createElement('li');
      item.className = 'flow-preview-step';
      item.dataset.kind = kind;
      item.textContent = title;
      if (sub) {
        const subEl = document.createElement('span');
        subEl.className = 'flow-preview-sub';
        subEl.textContent = sub;
        item.appendChild(subEl);
      }
      list.appendChild(item);
    };

    addRow('Main line', (list) => {
      workflowMainLineItems((state.primary_flow || []).filter(known), definitions).forEach((item) => {
        if (item.group) addStep(list, 'agent', 'Specialist agents', item.group.map((key) => definitions[key].title).join(' · '));
        else addStep(list, definitions[item.key].kind, definitions[item.key].title);
      });
    });

    const loopKeys = (state.growth_loop || []).filter(known);
    if (loopKeys.length > 0) {
      addRow('Growth loop', (list) => {
        loopKeys.forEach((key) => addStep(list, definitions[key].kind, definitions[key].title));
        const last = definitions[loopKeys[loopKeys.length - 1]];
        if (loopKeys.length > 1 && last.feedsBackTo === loopKeys[0]) {
          addStep(list, 'return', 'Back to ' + definitions[loopKeys[0]].title);
        }
      });
    }
  }

  async function loadWorkflowPreview() {
    try {
      const res = await apiFetch('/workflow/state');
      renderWorkflowPreview(res.ok ? await res.json() : null);
    } catch (err) {
      renderWorkflowPreview(null);
    }
  }

  function renderWorkflowGraph() {
    const graph = document.getElementById('workflowGraph');
    const loop = document.getElementById('workflowLoop');
    if (!graph || !workflowData) return;
    const definitions = {};
    (workflowData.stage_definitions || []).forEach((d) => { definitions[d.key] = d; });
    const renderable = (key) => Boolean(definitions[key] && workflowData.stages[key]);

    const items = workflowMainLineItems((workflowData.primary_flow || []).filter(renderable), definitions);

    graph.innerHTML = '';
    items.forEach((item, index) => {
      if (index > 0) {
        const kind = item.group ? 'group' : definitions[item.key].kind;
        graph.appendChild(workflowLink(['group', 'gate', 'boundary'].includes(kind) ? kind : ''));
      }
      if (item.group) {
        graph.appendChild(workflowGroup(item.group, definitions));
      } else {
        graph.appendChild(workflowStep(item.key, definitions, WORKFLOW_STAGE_LABELS[item.key] || definitions[item.key].title));
      }
    });

    // The growth loop, drawn as a loop: its stages in order, then a return path from the last
    // stage into the first - drawn only when the last stage's own definition says it feeds
    // back there (feedsBackTo), never assumed. The existing sentence stays as supporting text.
    loop.innerHTML = '';
    const loopKeys = (workflowData.growth_loop || []).filter(renderable);
    const column = document.createElement('div');
    column.className = 'flow-loop';
    loopKeys.forEach((key, index) => {
      if (index > 0) column.appendChild(workflowLink(''));
      column.appendChild(workflowStep(key, definitions, ''));
    });
    const lastKey = loopKeys[loopKeys.length - 1];
    const returnsTo = lastKey ? definitions[lastKey].feedsBackTo : null;
    if (loopKeys.length > 1 && returnsTo === loopKeys[0]) {
      const back = document.createElement('div');
      back.className = 'flow-return';
      back.setAttribute('aria-hidden', 'true');
      const label = document.createElement('span');
      label.className = 'flow-return-label';
      label.textContent = 'Back to ' + definitions[returnsTo].title;
      back.appendChild(label);
      column.appendChild(back);
    }
    loop.appendChild(column);
    const note = document.createElement('p');
    note.className = 'flow-loop-note';
    note.textContent = 'Recommendations feed back into Marketing strategy, so the next cycle starts from what actually happened.';
    loop.appendChild(note);
  }

  function drawerRow(label, value, { muted = false } = {}) {
    const row = document.createElement('div');
    row.className = 'workflow-drawer-row';
    const key = document.createElement('div');
    key.className = 'workflow-drawer-label';
    key.textContent = label;
    const val = document.createElement('div');
    val.className = 'workflow-drawer-value' + (muted ? ' unavailable' : '');
    val.textContent = value;
    row.appendChild(key);
    row.appendChild(val);
    return row;
  }

  function drawerList(label, items) {
    const row = document.createElement('div');
    row.className = 'workflow-drawer-row';
    const key = document.createElement('div');
    key.className = 'workflow-drawer-label';
    key.textContent = label;
    row.appendChild(key);
    const list = document.createElement('ul');
    list.className = 'workflow-drawer-list';
    (items || []).forEach((item) => {
      const li = document.createElement('li');
      li.textContent = item;
      list.appendChild(li);
    });
    row.appendChild(list);
    return row;
  }

  function openWorkflowDrawer(stageKey) {
    if (!workflowData) return;
    const definition = (workflowData.stage_definitions || []).find((d) => d.key === stageKey);
    const state = workflowData.stages[stageKey];
    if (!definition || !state) return;

    document.getElementById('workflowDrawerTitle').textContent = definition.title;
    document.getElementById('workflowDrawerKind').textContent =
      (definition.kind === 'agent' ? 'Specialist agent' : definition.kind === 'gate' ? 'Gate' : definition.kind === 'boundary' ? 'Boundary' : definition.kind === 'orchestrator' ? 'Coordinator' : 'Your input');

    const body = document.getElementById('workflowDrawerBody');
    body.innerHTML = '';

    // Current status first - it is the thing a customer is actually asking about.
    const statusRow = document.createElement('div');
    statusRow.className = 'workflow-drawer-status';
    const chip = document.createElement('span');
    chip.className = 'status-chip ' + workflowToneClass(state.state_tone);
    chip.textContent = state.state_label;
    statusRow.appendChild(chip);
    const meaning = document.createElement('span');
    meaning.className = 'workflow-drawer-meaning';
    meaning.textContent = (workflowData.node_states[state.state] || {}).meaning || '';
    statusRow.appendChild(meaning);
    body.appendChild(statusRow);

    body.appendChild(drawerRow('Purpose', definition.purpose));
    body.appendChild(drawerRow('What it does', definition.does));
    body.appendChild(drawerList('Inputs', definition.inputs));
    body.appendChild(drawerList('Outputs', definition.outputs));
    body.appendChild(drawerRow('Next step', definition.next_step || definition.nextStep));

    // Only what this run actually recorded. Never invented, and explicitly marked when
    // there is nothing to show.
    const hasDetail = state.detail && !/^Unavailable for this run/i.test(state.detail);
    body.appendChild(drawerRow('In this run', hasDetail ? state.detail : 'Unavailable for this run.', { muted: !hasDetail }));

    if ((state.evidence || []).length > 0) {
      const row = document.createElement('div');
      row.className = 'workflow-drawer-row';
      const key = document.createElement('div');
      key.className = 'workflow-drawer-label';
      key.textContent = 'Evidence';
      row.appendChild(key);
      const list = document.createElement('ul');
      list.className = 'workflow-drawer-list';
      state.evidence.slice(0, 8).forEach((url) => {
        const li = document.createElement('li');
        const link = document.createElement('a');
        link.href = url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = url;
        li.appendChild(link);
        list.appendChild(li);
      });
      row.appendChild(list);
      body.appendChild(row);
    } else {
      body.appendChild(drawerRow('Evidence', 'Unavailable for this run.', { muted: true }));
    }

    if (Array.isArray(definition.verdicts)) {
      const row = document.createElement('div');
      row.className = 'workflow-drawer-row';
      const key = document.createElement('div');
      key.className = 'workflow-drawer-label';
      key.textContent = 'Possible outcomes';
      row.appendChild(key);
      definition.verdicts.forEach((verdict) => {
        const item = document.createElement('div');
        item.className = 'workflow-verdict';
        const badge = document.createElement('span');
        badge.className = 'status-chip ' + (/BLOCK|rejected/i.test(verdict.id) ? 'error' : /REVIEW|pending/i.test(verdict.id) ? 'warn' : 'ok');
        badge.textContent = verdict.label;
        const text = document.createElement('span');
        text.textContent = verdict.meaning;
        item.appendChild(badge);
        item.appendChild(text);
        row.appendChild(item);
      });
      body.appendChild(row);
    }

    const drawer = document.getElementById('workflowDrawer');
    drawer.hidden = false;
    document.getElementById('workflowDrawerClose').focus();
  }

  function closeWorkflowDrawer() {
    const drawer = document.getElementById('workflowDrawer');
    if (drawer) drawer.hidden = true;
  }

  /* The evidence chain behind one persisted opportunity. Every value is relayed from
     the saved run; a figure no source stated is shown with the server's own
     "not available" sentence, never as 0. */
  function renderEvidenceChain(payload) {
    const area = document.getElementById('workflowEvidenceArea');
    area.innerHTML = '';
    if (!payload || !payload.available || !payload.chain) {
      const empty = document.createElement('div');
      empty.className = 'panel-card panel-empty';
      empty.textContent = (payload && payload.error) || 'No saved product opportunity to explain yet. Ask the Chief to research the market first.';
      area.appendChild(empty);
      return;
    }
    const chain = payload.chain;
    const unavailable = payload.unavailable_text || 'Not available from the connected research sources.';

    const card = document.createElement('div');
    card.className = 'panel-card';
    const title = document.createElement('div');
    title.className = 'workflow-node-title';
    title.textContent = '#' + chain.rank + '  ' + (chain.product || 'Opportunity');
    card.appendChild(title);

    function step(heading, render) {
      const block = document.createElement('div');
      block.className = 'workflow-chain-step';
      const label = document.createElement('div');
      label.className = 'workflow-drawer-label';
      label.textContent = heading;
      block.appendChild(label);
      render(block);
      card.appendChild(block);
    }

    step('Research evidence', (block) => {
      const sources = (chain.research_evidence && chain.research_evidence.sources) || [];
      if (sources.length === 0) {
        const p = document.createElement('div');
        p.className = 'workflow-drawer-value unavailable';
        p.textContent = unavailable;
        block.appendChild(p);
        return;
      }
      const list = document.createElement('ul');
      list.className = 'workflow-drawer-list';
      sources.forEach((url) => {
        const li = document.createElement('li');
        const a = document.createElement('a');
        a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.textContent = url;
        li.appendChild(a);
        list.appendChild(li);
      });
      block.appendChild(list);
    });

    step('Fit with your catalogue', (block) => {
      const p = document.createElement('div');
      const reason = chain.customer_fit && chain.customer_fit.reason;
      p.className = 'workflow-drawer-value' + (reason ? '' : ' unavailable');
      p.textContent = reason || unavailable;
      block.appendChild(p);
    });

    step('Opportunity evaluation', (block) => {
      const evaluation = chain.opportunity_evaluation || {};
      const grid = document.createElement('div');
      grid.className = 'market-signal-grid';
      [['Demand', 'demand'], ['Competition', 'competition'], ['Trend', 'trend'], ['Commercial', 'commercial']].forEach((pair) => {
        const signal = evaluation[pair[1]] || {};
        const cell = document.createElement('div');
        cell.className = 'market-signal';
        const lab = document.createElement('div');
        lab.className = 'market-signal-label';
        lab.textContent = pair[0];
        const val = document.createElement('div');
        // A real value only when one exists; otherwise the assessment; otherwise the
        // shared unavailable sentence. Never a zero standing in for "unknown".
        let text;
        if (signal.value !== null && signal.value !== undefined) text = String(signal.value) + (signal.unit ? ' ' + signal.unit : '');
        else if (signal.classification && signal.classification !== 'unknown') text = signal.classification;
        else if (signal.assessment) text = signal.assessment;
        else text = unavailable;
        val.className = 'market-signal-value' + (text === unavailable ? ' unavailable' : '');
        val.textContent = text;
        cell.appendChild(lab);
        cell.appendChild(val);
        if (signal.grade) {
          const grade = document.createElement('div');
          grade.className = 'market-signal-grade';
          grade.textContent = signal.grade;
          cell.appendChild(grade);
        }
        grid.appendChild(cell);
      });
      block.appendChild(grid);
      if (evaluation.rank_basis) {
        const basis = document.createElement('div');
        basis.className = 'panel-note';
        basis.textContent = evaluation.rank_basis;
        block.appendChild(basis);
      }
    });

    step('Compliance', (block) => {
      const status = chain.compliance && chain.compliance.status;
      const chip = document.createElement('span');
      chip.className = 'status-chip ' + (status === 'PASS' ? 'ok' : status === 'BLOCK' ? 'error' : status ? 'warn' : 'idle');
      chip.textContent = status ? (status === 'REVIEW' ? 'REVIEW - needs a human' : status) : 'No verdict recorded';
      block.appendChild(chip);
      const note = document.createElement('div');
      note.className = 'panel-note';
      note.textContent = 'A compliance PASS is not approval. Approval is a separate decision, and it is yours.';
      block.appendChild(note);
    });

    step('SEO and listing preparation', (block) => {
      const preparation = chain.preparation || {};
      const p = document.createElement('div');
      p.className = 'workflow-drawer-value' + (preparation.state ? '' : ' unavailable');
      p.textContent = preparation.state ? 'Prepared to ' + String(preparation.state).replace(/_/g, ' ') + '.' : 'Not prepared for listing yet.';
      block.appendChild(p);
      if ((preparation.missing_information || []).length > 0) {
        const missing = document.createElement('div');
        missing.className = 'panel-note';
        missing.textContent = preparation.missing_information.length + ' product fact(s) are not established by the research and are reported rather than guessed: ' + preparation.missing_information.join(', ') + '.';
        block.appendChild(missing);
      }
    });

    area.appendChild(card);
  }

  async function loadWorkflowEvidence(rank) {
    try {
      const res = await apiFetch('/workflow/evidence/' + encodeURIComponent(rank));
      const data = await res.json().catch(() => ({}));
      renderEvidenceChain(res.ok ? data : { available: false, error: data.error });
    } catch (err) {
      renderEvidenceChain({ available: false, error: 'Could not reach the server.' });
    }
  }

  async function loadWorkflow() {
    const note = document.getElementById('workflowRunNote');
    const tag = document.getElementById('workflowRunTag');
    try {
      const res = await apiFetch('/workflow/state');
      if (!res.ok) {
        note.textContent = 'Could not load the workflow view.';
        return;
      }
      workflowData = await res.json();
      renderWorkflowGraph();

      if (workflowData.has_run) {
        tag.hidden = false;
        tag.textContent = 'Live run';
        note.textContent = workflowData.objective
          ? 'Showing your most recent run: "' + workflowData.objective + '"'
          : 'Showing your most recent run.';
      } else {
        tag.hidden = true;
        note.textContent = 'Ready. Nothing has run yet, so every step below shows as not run.';
      }

      // The evidence chain for the top persisted opportunity, when one exists.
      loadWorkflowEvidence(1);
    } catch (err) {
      note.textContent = 'Could not reach the server.';
    }
  }

  (function wireWorkflowControls() {
    const close = document.getElementById('workflowDrawerClose');
    const scrim = document.getElementById('workflowDrawerScrim');
    if (close) close.addEventListener('click', closeWorkflowDrawer);
    if (scrim) scrim.addEventListener('click', closeWorkflowDrawer);
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') closeWorkflowDrawer();
    });
    const link = document.getElementById('workflowPdfLink');
    if (link) {
      // The endpoint is protected, so the PDF is fetched with the session's key and handed
      // to the browser as a blob - the key is never placed in a URL.
      link.addEventListener('click', async (event) => {
        event.preventDefault();
        link.textContent = 'Preparing PDF…';
        try {
          const res = await apiFetch('/workflow/document.pdf');
          if (!res.ok) { link.textContent = 'Download PDF ↓'; return; }
          const blob = await res.blob();
          const url = URL.createObjectURL(blob);
          const anchor = document.createElement('a');
          anchor.href = url;
          anchor.download = 'AVENLY-AI-How-Your-AI-Sales-Operating-System-Works.pdf';
          document.body.appendChild(anchor);
          anchor.click();
          document.body.removeChild(anchor);
          URL.revokeObjectURL(url);
        } catch (err) {
          /* Leave the control usable; the note below already explains connectivity. */
        }
        link.textContent = 'Download PDF ↓';
      });
    }
  })();
