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
      setStatus('idle', 'Connected · Gemini');
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

  /* ---------- Overview page: one real status card per specialist ---------- */
  const agentGrid = document.getElementById('agentGrid');
  const agentCardEls = {};
  const agentRunState = {}; // specialistId -> { status, completedRuns }
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

  SPECIALISTS.forEach((sp) => {
    const card = document.createElement('div');
    card.className = 'agent-card';
    card.innerHTML =
      '<div class="agent-card-head">' +
      '<div><div class="agent-name">' + escapeHtml(sp.name) + '</div><div class="agent-desc">' + escapeHtml(sp.desc) + '</div></div>' +
      '<span class="agent-status idle" data-role="status">Not run yet</span>' +
      '</div>' +
      '<div class="agent-summary empty" data-role="summary">No result yet this session.</div>' +
      '<div data-role="chart"></div>' +
      '<div class="agent-card-foot">' +
      '<button class="agent-run-btn" data-role="run" type="button">Run now</button>' +
      '<a class="agent-open-link" data-role="open">Open in Run a Specialist →</a>' +
      '</div>';

    const runButton = card.querySelector('[data-role="run"]');
    const statusBadge = card.querySelector('[data-role="status"]');
    const summaryEl = card.querySelector('[data-role="summary"]');
    const chartEl = card.querySelector('[data-role="chart"]');
    const openLink = card.querySelector('[data-role="open"]');

    openLink.addEventListener('click', () => {
      selectPage('specialists');
      const targetCard = Array.from(document.querySelectorAll('.specialist-card')).find(
        (c, i) => SPECIALISTS[i].id === sp.id
      );
      if (targetCard) targetCard.click();
    });

    runButton.addEventListener('click', async () => {
      runButton.disabled = true;
      runButton.textContent = 'Running…';
      statusBadge.className = 'agent-status running';
      statusBadge.textContent = 'Running';
      summaryEl.className = 'agent-summary';
      summaryEl.textContent = 'Calling your real Shopify/Gemini connection…';
      chartEl.innerHTML = '';

      try {
        const { ok, data } = await runSpecialist(sp.id, sp.objective);
        const label = !ok ? 'error' : data && data.status === 'partial' ? 'partial' : 'success';
        statusBadge.className = 'agent-status ' + label;
        statusBadge.textContent = label;
        summaryEl.className = 'agent-summary';
        summaryEl.textContent = agentSummaryLine(label, data);

        chartEl.innerHTML = '';
        const chartData = extractChartPoints(data && data.outputs ? data.outputs : null);
        if (chartData) renderMetricChart(chartEl, chartData, 'Real data from this run');

        markAgentRun(sp.id, label, data);
        noteActivity('Ran ' + sp.name + ' just now');
      } catch (err) {
        statusBadge.className = 'agent-status error';
        statusBadge.textContent = 'error';
        summaryEl.className = 'agent-summary';
        summaryEl.textContent = 'Could not reach the server. Check that it is running.';
      } finally {
        runButton.disabled = false;
        runButton.textContent = 'Run again';
      }
    });

    agentCardEls[sp.id] = card;
    agentGrid.appendChild(card);
  });

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
      const res = await apiFetch('/orchestrate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ objective: goal }),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        chiefResultArea.innerHTML =
          '<div class="result-card"><div class="result-header"><span class="result-title">Chief Orchestrator</span>' +
          '<span class="result-status error">error</span></div><pre class="result-body">' +
          escapeHtml(data.error || 'Something went wrong.') + '</pre></div>';
        return;
      }

      currentRunId = data.run_id || null;
      renderChiefPlan(data, currentRunId);
      noteActivity('Asked the Chief just now');
    } catch (err) {
      chiefResultArea.innerHTML = '<p class="empty-result">Could not reach the server. Check that it is running.</p>';
    } finally {
      chiefRunBtn.disabled = false;
      chiefRunBtn.textContent = 'Ask the Chief';
    }
  });

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

      row.innerHTML =
        '<div class="approval-row-head">' +
        '<div><div class="approval-row-title">' + escapeHtml(entry.title || 'Approval') + '</div>' +
        '<div class="approval-row-meta">' + escapeHtml(entry.classification) + ' · run ' + escapeHtml(entry.runId || '') + '</div></div>' +
        '<span class="approval-row-status ' + entry.status + '">' + entry.status + '</span>' +
        '</div>' +
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

      runs.forEach((entry) => {
        const row = document.createElement('div');
        row.className = 'approval-row';
        row.style.cursor = 'pointer';
        row.tabIndex = 0;
        row.setAttribute('role', 'button');

        const kindLabel = entry.kind === 'orchestrate' ? 'Chief Orchestrator' : 'Specialist: ' + (entry.specialist_name || entry.specialist_id || '');
        const when = entry.created_at ? new Date(entry.created_at).toLocaleString() : '';

        row.innerHTML =
          '<div class="approval-row-head">' +
          '<div><div class="approval-row-title">' + escapeHtml(entry.objective || '(no objective recorded)') + '</div>' +
          '<div class="approval-row-meta">' + escapeHtml(kindLabel) + ' · ' + escapeHtml(when) + '</div></div>' +
          '<span class="approval-row-status ' + historyStatusClass(entry.status) + '">' + escapeHtml(entry.status || 'unknown') + '</span>' +
          '</div>';

        const open = () => loadHistoryDetail(entry.run_id);
        row.addEventListener('click', open);
        row.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
        });

        listArea.appendChild(row);
      });
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

    const shopify = (channels || []).find((c) => c.id === 'shopify');
    const chip = document.getElementById('ovChannelChip');
    const chipText = document.getElementById('ovChannelChipText');
    const connected = Boolean(shopify && shopify.configured);
    chip.classList.toggle('warn', !connected);
    chipText.textContent = connected ? 'Shopify — Connected' : 'Shopify — Not connected';
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
    const VB_W = 720;
    const VB_H = 240;
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

  // Replaces a specialist card's status/summary with its real, persisted last-run
  // state from GET /overview - but ONLY for a specialist this browser session has
  // not itself already run (agentRunState). A run the user just triggered in this
  // tab is always fresher than what was true when the page loaded, so it must
  // never be overwritten by a stale server snapshot.
  function hydrateAgentCards(specialists) {
    SPECIALISTS.forEach((sp) => {
      if (agentRunState[sp.id]) return;
      const card = agentCardEls[sp.id];
      if (!card) return;
      const statusBadge = card.querySelector('[data-role="status"]');
      const summaryEl = card.querySelector('[data-role="summary"]');
      const entry = specialists && specialists[sp.id];

      if (!entry) {
        statusBadge.className = 'agent-status idle';
        statusBadge.textContent = 'Not run yet';
        summaryEl.className = 'agent-summary empty';
        summaryEl.textContent = 'No result yet.';
        return;
      }

      const label =
        entry.last_status === 'success' || entry.last_status === 'error' || entry.last_status === 'partial'
          ? entry.last_status
          : 'partial';
      statusBadge.className = 'agent-status ' + label;
      statusBadge.textContent = label;
      summaryEl.className = 'agent-summary';
      const metaParts = [];
      if (typeof entry.last_result_count === 'number') metaParts.push(entry.last_result_count + ' record(s) retrieved');
      if (entry.last_run_at) metaParts.push('Last run ' + formatWhen(entry.last_run_at));
      summaryEl.textContent = (entry.last_summary || 'Completed.') + (metaParts.length ? ' — ' + metaParts.join(' · ') : '');
    });
  }

  // RELAY ONLY - renders exactly the opportunity items GET /overview already
  // extracted from real saved results (agent/core/crossAgentContext.js's
  // growth_opportunity_drafts + each specialist's own recommendations). No
  // ranking or scoring happens here; items are shown in the order the server
  // returned them.
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

    addTile(
      'Specialists run (all-time)',
      growth && growth.specialists_total ? growth.specialists_run + ' / ' + growth.specialists_total : null
    );
    addTile('Opportunities found', growth ? growth.opportunities_found : null);
    addTile('Tasks completed', growth ? growth.runs_completed : null);
    addTile('Approvals pending', approvalLog.filter((a) => a.status === 'pending').length, {
      accent: true,
      id: 'statPendingApprovals',
    });
    addTile('Runs this session', runsCompletedCount + ' / ' + SPECIALISTS.length, { id: 'statRunsCount' });
    addTile('Last activity (all-time)', growth && growth.last_run_at ? formatWhen(growth.last_run_at) : null, {
      small: true,
    });
  }

  function statusChip(status) {
    const chip = document.createElement('span');
    chip.className = 'status-chip ' + historyStatusClass(status);
    chip.textContent = status || 'unknown';
    return chip;
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
    meta.textContent = kindLabel + ' · ' + formatWhen(entry.created_at);
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
  function renderApprovalsOverview(growth) {
    const area = document.getElementById('approvalsOverviewArea');
    area.innerHTML = '';

    const sessionPending = approvalLog.filter((a) => a.status === 'pending');

    const summary = document.createElement('div');
    summary.className = 'panel-empty';
    const parts = [sessionPending.length + ' approval(s) waiting for you this session'];
    if (growth && typeof growth.approvals_recorded === 'number') {
      parts.push(
        growth.approvals_recorded +
          ' approval(s) recorded in saved run history (' +
          (growth.approvals_pending || 0) +
          ' still pending there)'
      );
    }
    summary.textContent = parts.join(' · ');
    area.appendChild(summary);

    sessionPending.slice(0, 3).forEach((entry) => {
      const row = document.createElement('div');
      row.className = 'activity-row';
      const main = document.createElement('div');
      main.className = 'activity-row-main';
      const title = document.createElement('div');
      title.className = 'activity-row-title';
      title.textContent = entry.title || 'Approval';
      main.appendChild(title);
      const meta = document.createElement('div');
      meta.className = 'activity-row-meta';
      meta.textContent = entry.classification || '';
      main.appendChild(meta);
      row.appendChild(main);

      const link = document.createElement('button');
      link.type = 'button';
      link.className = 'activity-row-link';
      link.textContent = 'Review →';
      link.addEventListener('click', () => selectPage('approvals'));
      row.appendChild(link);

      area.appendChild(row);
    });
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

      if (!stage.available && stage.reason) {
        const why = document.createElement('div');
        why.className = 'funnel-stage-reason';
        why.textContent = stage.reason;
        row.appendChild(why);
      }
      area.appendChild(row);

      if (i < funnel.stages.length - 1) {
        const arrow = document.createElement('div');
        arrow.className = 'funnel-arrow';
        arrow.textContent = '↓';
        arrow.setAttribute('aria-hidden', 'true');
        area.appendChild(arrow);
      }
    });

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
  function renderAiImpact(metrics) {
    const row = document.getElementById('aiImpactRow');
    row.innerHTML = '';
    if (!Array.isArray(metrics) || metrics.length === 0) {
      row.innerHTML = '<div class="panel-empty">No data available.</div>';
      return;
    }
    metrics.forEach((metric) => {
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
  function renderNextActions(actions) {
    const area = document.getElementById('nextActionsArea');
    area.innerHTML = '';
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
    area.innerHTML = '';
    if (!orchestrator) {
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

    const rows = [
      ['Total tokens', usage.tokens_total],
      ['Input tokens', usage.tokens_input],
      ['Output tokens', usage.tokens_output],
      ['Model calls', usage.model_calls],
      ['Tool calls', usage.tool_calls],
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
    note.textContent =
      'Covers ' + usage.runs_with_usage + ' saved run(s) that recorded usage. ' + (usage.cost_reason || '');
    area.appendChild(note);
  }

  async function loadOverviewState() {
    try {
      const res = await apiFetch('/overview');
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        document.getElementById('ovBusinessName').textContent = 'Could not load store overview';
        return;
      }
      renderOverviewBusiness(data.business, data.channels);
      renderChannels(data.channels);
      renderGrowthStatus(data.growth || {});
      renderOpportunities(data.opportunities || []);
      hydrateAgentCards(data.specialists || {});
      renderActivityList(
        'recentActivityArea',
        data.activity || [],
        'No AI activity recorded yet — run a specialist or ask the Chief something, and it will appear here.'
      );
      renderActivityList('recentRunsArea', (data.activity || []).slice(0, 4), 'No saved runs yet.');
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
    } catch (err) {
      renderStoreMetrics(null);
      renderPerformance(null);
      renderFunnel(null);
      renderTopProducts(null);
    }
  }

  // The Overview page's one entry point - called on initial page load (below) and
  // every time the user navigates back to Overview (see selectPage above). The
  // local, zero-network state loads first so the page is never blank while the
  // live Shopify pull (server-cached, see server.js's METRICS_TTL_MS) is in flight.
  async function loadOverview() {
    await loadOverviewState();
    await loadStoreMetrics();
  }

  const viewAllHistoryBtn = document.getElementById('viewAllHistoryBtn');
  if (viewAllHistoryBtn) viewAllHistoryBtn.addEventListener('click', () => selectPage('history'));

  // Initial load: Overview starts as the active page (see index.html's
  // `pageOverview` carrying the `active` class by default), so it must hydrate
  // itself once here rather than waiting for a nav click that may never come.
  loadOverview();
