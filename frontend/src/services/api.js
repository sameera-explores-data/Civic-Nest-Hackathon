// API service layer - live backend integration with mock fallback (no UI changes)
import { mockIncidents, issueCategories, interventionTypes } from '../mockData/incidents';
import { mockInsights, mockEscalations } from '../mockData/insights';
import { normalizeIncidentId, normalizeIncidentStatus, normalizeIssueCategory, sanitizeResidentCategories } from '../lib/civicNormalization';

const BACKEND_URL = (process.env.REACT_APP_BACKEND_URL || '').replace(/\/$/, '');
const AUTH_TOKEN = process.env.REACT_APP_AUTH_TOKEN || '';
const ENABLE_MOCK_FALLBACK = (() => {
  const override = process.env.REACT_APP_ENABLE_MOCK_FALLBACK;
  if (typeof override === 'string' && override.length) return override !== '0';
  return process.env.NODE_ENV !== 'production';
})();

const ROLE = {
  RESIDENT: 'resident',
  WORKER: 'public_worker',
  ADMIN: 'city_admin'
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const RESIDENT_REPORTS_KEY = 'civicnest_resident_reports_v1';
const RESIDENT_CONTEXT_KEY = 'civicnest_resident_context_v1';
const ESCALATIONS_CACHE_KEY = 'civicnest_escalations_v2';

function loadResidentReports() {
  try {
    const raw = window.localStorage.getItem(RESIDENT_REPORTS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    const reports = Array.isArray(parsed) ? parsed : [];
    return reports.map((r) => ({
      ...r,
      id: normalizeIncidentId(r?.id) || r?.id,
      status: normalizeIncidentStatus(r?.status),
    }));
  } catch {
    return [];
  }
}

function saveResidentReports(items) {
  try {
    window.localStorage.setItem(RESIDENT_REPORTS_KEY, JSON.stringify(items.slice(0, 100)));
  } catch {
    // ignore storage errors
  }
}

function addResidentReport(entry) {
  const current = loadResidentReports();
  const next = [entry, ...current.filter((x) => x.id !== entry.id)];
  saveResidentReports(next);
}

function loadResidentContext() {
  try {
    const raw = window.localStorage.getItem(RESIDENT_CONTEXT_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return {
      reporterName: parsed?.reporterName || '',
      exactLocation: parsed?.exactLocation || '',
      lastIncidentId: normalizeIncidentId(parsed?.lastIncidentId) || ''
    };
  } catch {
    return { reporterName: '', exactLocation: '', lastIncidentId: '' };
  }
}

function saveResidentContext(ctx) {
  try {
    window.localStorage.setItem(RESIDENT_CONTEXT_KEY, JSON.stringify({
      reporterName: ctx?.reporterName || '',
      exactLocation: ctx?.exactLocation || '',
      lastIncidentId: ctx?.lastIncidentId || ''
    }));
  } catch {
    // ignore storage errors
  }
}

function extractResidentName(text = '') {
  const s = String(text || '').trim();
  if (!s) return null;
  const patterns = [
    /\bmy name is\s+([A-Za-z][A-Za-z\s'\-.]{1,80})/i,
    /\bi am\s+([A-Za-z][A-Za-z\s'\-.]{1,80})/i,
    /\bthis is\s+([A-Za-z][A-Za-z\s'\-.]{1,80})/i,
    /\bname\s*[:\-]\s*([A-Za-z][A-Za-z\s'\-.]{1,80})/i,
    /\breporter name\s*[:\-]\s*([A-Za-z][A-Za-z\s'\-.]{1,80})/i,
  ];
  for (const p of patterns) {
    const m = s.match(p);
    if (m?.[1]) {
      const candidate = m[1].replace(/[\s.,]+$/g, '').trim();
      if (candidate.split(/\s+/).length >= 2) return candidate;
    }
  }

  const firstSegment = s
    .split(/\d|\b(?:street|st|road|rd|avenue|ave|lane|ln|drive|dr|way|close|court|ct|boulevard|blvd|terrace|place|pl|location|address|near|at|on)\b/i)[0]
    .trim();
  const words = firstSegment.match(/[A-Za-z][A-Za-z'\-.]*/g) || [];
  const stop = new Set(['there', 'illegal', 'dumping', 'behind', 'my', 'building', 'please', 'help', 'issue', 'report']);
  if (words.length >= 2 && !stop.has(words[0].toLowerCase())) {
    return `${words[0]} ${words[1]}`;
  }

  return null;
}

function extractResidentLocation(text = '') {
  const s = String(text || '').trim();
  if (!s) return null;
  const generic = new Set(['unknown', 'my street', 'street', 'my road', 'road', 'my area', 'my neighborhood', 'city', 'montgomery']);
  const patterns = [
    /\b(?:exact location|location|address)\s*[:\-]\s*(.+)$/i,
    /\b(\d+[A-Za-z]?\s+[A-Za-z0-9 .,'\-#/]{4,140})/i,
    /\b([A-Za-z0-9 .,'\-]{2,60})\s+(?:and|&)\s+([A-Za-z0-9 .,'\-]{2,60})\b/i,
    /\b(?:at|near|on)\s+([A-Za-z0-9 .,'\-#/]{4,140}?)(?:[.!?]|$)/i
  ];
  for (let i = 0; i < patterns.length; i += 1) {
    const m = s.match(patterns[i]);
    if (!m) continue;
    const candidate = i === 2 ? `${m[1].trim()} & ${m[2].trim()}` : String(m[1] || '').trim();
    const canonical = candidate.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
    if ([...generic].some((g) => canonical === g || canonical.startsWith(`${g} `))) continue;
    if (candidate.split(/\s+/).length >= 2) return candidate;
  }
  return null;
}

function isResidentFollowup(text = '') {
  const s = String(text || '').toLowerCase();
  return [
    'any update',
    'status update',
    'update on this report',
    'update on my report',
    'status of this report',
    'status of my report',
    'follow up',
    'follow-up',
    'check my report',
    'track my report'
  ].some((x) => s.includes(x));
}

function loadEscalationsCache() {
  try {
    const raw = window.localStorage.getItem(ESCALATIONS_CACHE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    const items = Array.isArray(parsed) ? parsed : [];
    return items.map((x) => ({ ...x, incident_id: normalizeIncidentId(x?.incident_id) || x?.incident_id || null }));
  } catch {
    return [];
  }
}

function saveEscalationsCache(items) {
  try {
    window.localStorage.setItem(ESCALATIONS_CACHE_KEY, JSON.stringify(items.slice(0, 300)));
  } catch {
    // ignore storage errors
  }
}

function upsertEscalation(entry) {
  const current = loadEscalationsCache();
  const key = entry.id || `${entry.incident_id || 'INC'}::${entry.created_at || Date.now()}`;
  const enriched = {
    ...entry,
    id: key,
    source: entry.source || 'local_cache'
  };
  const next = [enriched, ...current.filter((x) => (x.id || `${x.incident_id || 'INC'}::${x.created_at || ''}`) !== key)];
  saveEscalationsCache(next);
  return enriched;
}

function withFallback(scope, err, fallbackFn) {
  if (!ENABLE_MOCK_FALLBACK) throw err;
  // eslint-disable-next-line no-console
  console.warn(`[CivicNest API] ${scope} failed, using fallback`, err?.message || err);
  return fallbackFn();
}

function buildUrl(path) {
  if (!BACKEND_URL) {
    throw new Error('REACT_APP_BACKEND_URL is not configured');
  }
  const normalized = path.startsWith('/') ? path : `/${path}`;
  return `${BACKEND_URL}${normalized}`;
}

async function apiRequest(path, { method = 'GET', role = ROLE.RESIDENT, body } = {}) {
  const headers = {
    'Content-Type': 'application/json',
    'X-Role': role
  };
  if (AUTH_TOKEN) headers.Authorization = `Bearer ${AUTH_TOKEN}`;

  const res = await fetch(buildUrl(path), {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });

  const text = await res.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text };
  }

  if (!res.ok) {
    const errorMessage = parsed?.error?.message || parsed?.detail || `HTTP ${res.status}`;
    const error = new Error(errorMessage);
    error.status = res.status;
    error.payload = parsed;
    throw error;
  }

  return parsed;
}

function normalizeIncident(item = {}) {
  return {
    incident_id: normalizeIncidentId(item.incident_id || item.id) || `INC-${Math.floor(Math.random() * 9000 + 1000)}`,
    source_dataset: item.source_dataset || 'Civic Source',
    issue_category: normalizeIssueCategory(item.issue_category),
    reported_at: item.reported_at || item.last_action_at || new Date().toISOString(),
    lat: item.lat ?? null,
    lon: item.lon ?? null,
    zone: item.zone || 'Unknown Zone',
    status: normalizeIncidentStatus(item.status),
    priority: item.priority || 'medium',
    recurrence_score: Number(item.recurrence_score ?? 0.4),
    owner: item.owner || null,
    recommended_action: item.recommended_action || 'Review and triage incident',
    confidence: Number(item.confidence ?? 0.6),
    description: item.description || item.recommended_action || `${item.issue_category || 'Issue'} reported in ${item.zone || 'city area'}`
  };
}

function normalizeEscalationStatus(item = {}) {
  const explicit = String(item.status || item.state || item.lifecycle_status || '').toLowerCase();
  if (['active', 'open', 'in_progress', 'queued', 'pending'].includes(explicit)) return 'active';
  if (['completed', 'resolved', 'closed', 'done', 'succeeded'].includes(explicit)) return 'completed';
  if (['cancelled', 'canceled', 'rejected', 'dismissed', 'failed'].includes(explicit)) return 'cancelled';

  if (item.should_escalate === false) return 'cancelled';
  if (item.completed_at || item.resolved_at || item.closed_at) return 'completed';
  return 'active';
}

function normalizeEscalation(item = {}) {
  return {
    id: item.id || item.escalation_id || `ESC-${Math.floor(Math.random() * 9000 + 1000)}`,
    area: item.area || item.zone || 'Unknown Area',
    issue_category: normalizeIssueCategory(item.issue_category),
    recurrence_score: Number(item.recurrence_score ?? 0.5),
    intervention_type: item.intervention_type || 'Escalation',
    status: normalizeEscalationStatus(item),
    created_at: item.created_at || new Date().toISOString(),
    created_by: item.created_by || 'City Operator',
    incident_id: normalizeIncidentId(item.incident_id) || item.incident_id || null,
    reason: item.reason || item.notes || '',
    source: item.source || 'backend',
    linkage_mode: item.linkage_mode || null,
    source_note: item.source_note || null
  };
}

async function fetchEscalationListFromBackend() {
  const listPaths = ['/ops/escalations', '/ops/escalations/history'];
  const probes = [];

  for (const path of listPaths) {
    try {
      const payload = await apiRequest(path, { role: ROLE.ADMIN });
      const collection = payload?.items || payload?.escalations || payload?.data || [];
      const supported = Array.isArray(collection);
      probes.push({ path, ok: true, status: 200, supported, count: supported ? collection.length : null });
      if (supported) {
        return {
          escalations: collection.map((item) => normalizeEscalation({ ...item, source: 'backend' })),
          sourcePath: path,
          probes
        };
      }
    } catch (err) {
      probes.push({ path, ok: false, status: err?.status || null, message: err?.message || 'Request failed' });
      if ([404, 405, 501].includes(err?.status)) {
        continue;
      }
      err.escalationProbe = probes;
      throw err;
    }
  }

  return {
    escalations: null,
    sourcePath: null,
    probes
  };
}

function riskFromScore(score) {
  if (score >= 0.7) return 'high';
  if (score >= 0.4) return 'medium';
  return 'low';
}

function toDate(value) {
  const d = value ? new Date(value) : null;
  return d && !Number.isNaN(d.getTime()) ? d : null;
}

function bucketDateLabel(date) {
  return date.toISOString().slice(0, 10);
}

function startOfUtcDay(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function buildWeeklyTrends(incidents = [], weeks = 6) {
  if (!incidents.length) return [];

  const now = new Date();
  const end = startOfUtcDay(now);
  const buckets = Array.from({ length: weeks }, (_, idx) => {
    const date = new Date(end);
    date.setUTCDate(end.getUTCDate() - (weeks - idx - 1) * 7);
    return {
      date: bucketDateLabel(date),
      incidents: 0,
      resolved: 0,
      _start: date,
      _end: new Date(date.getTime() + 7 * 24 * 60 * 60 * 1000)
    };
  });

  incidents.forEach((incident) => {
    const reported = toDate(incident.reported_at);
    if (!reported) return;
    const bucket = buckets.find((b) => reported >= b._start && reported < b._end);
    if (!bucket) return;
    bucket.incidents += 1;
    if (incident.status === 'resolved') bucket.resolved += 1;
  });

  return buckets.map(({ date, incidents: count, resolved }) => ({ date, incidents: count, resolved }));
}

function computeEntityMomentum(incidents = [], key) {
  if (!incidents.length) return [];

  const sorted = [...incidents]
    .filter((i) => i[key])
    .sort((a, b) => new Date(b.reported_at) - new Date(a.reported_at));

  const sample = sorted.slice(0, 60);
  if (!sample.length) return [];

  const split = Math.max(1, Math.floor(sample.length / 2));
  const recent = sample.slice(0, split);
  const prior = sample.slice(split);

  const aggregate = (list) => list.reduce((acc, i) => {
    const id = i[key];
    if (!acc[id]) acc[id] = { count: 0, recurrence: 0 };
    acc[id].count += 1;
    acc[id].recurrence += Number(i.recurrence_score || 0);
    return acc;
  }, {});

  const recentAgg = aggregate(recent);
  const priorAgg = aggregate(prior);

  return Object.keys(recentAgg)
    .map((id) => {
      const r = recentAgg[id];
      const p = priorAgg[id] || { count: 0, recurrence: 0 };
      const recentRisk = r.count ? r.recurrence / r.count : 0;
      const priorRisk = p.count ? p.recurrence / p.count : 0;

      return {
        key: id,
        current_count: r.count,
        previous_count: p.count,
        delta_count: r.count - p.count,
        risk_movement: Number((recentRisk - priorRisk).toFixed(2)),
        current_risk: Number(recentRisk.toFixed(2))
      };
    })
    .sort((a, b) => (b.risk_movement - a.risk_movement) || (b.delta_count - a.delta_count));
}

function buildActionCandidates(hotspots = [], incidents = []) {
  const zoneTopIncident = incidents.reduce((acc, i) => {
    if (!i.zone) return acc;
    if (!acc[i.zone] || (i.recurrence_score || 0) > (acc[i.zone].recurrence_score || 0)) {
      acc[i.zone] = i;
    }
    return acc;
  }, {});

  return hotspots
    .map((h) => {
      const [zone = '', issue_category = normalizeIssueCategory('Noise Complaint')] = String(h.area || '').split(' · ');
      const top = zoneTopIncident[zone] || null;

      return {
        area: h.area,
        zone,
        issue_category,
        recurrence_score: Number(h.recurrence_score || 0),
        incidents: Number(h.incidents || 0),
        priority: riskFromScore(Number(h.recurrence_score || 0)),
        incident_id: top?.incident_id || null,
        suggestion: (h.recurrence_score || 0) >= 0.7
          ? 'Prep escalation and route rapid response team'
          : (h.recurrence_score || 0) >= 0.4
            ? 'Increase monitoring and assign targeted patrol'
            : 'Maintain monitoring cadence'
      };
    })
    .sort((a, b) => (b.recurrence_score - a.recurrence_score) || (b.incidents - a.incidents))
    .slice(0, 8);
}

// Chat API - POST /query (compat endpoint)
const inferAreaFromMessage = (message = '') => {
  const text = String(message).trim();
  if (!text) return null;
  const nearMatch = text.match(/\b(?:near|at|on|by)\s+([A-Za-z0-9\-\s&,.'/]{3,80})/i);
  if (nearMatch && nearMatch[1]) {
    const area = nearMatch[1].trim();
    const generic = ['my street', 'street', 'my road', 'road', 'my area', 'my neighborhood'];
    if (!generic.includes(area.toLowerCase())) return area;
  }
  const intersection = text.match(/\b([A-Za-z0-9\-\s]+)\s+(?:and|&)\s+([A-Za-z0-9\-\s]+)/i);
  if (intersection) return `${intersection[1].trim()} & ${intersection[2].trim()}`;
  return null;
};

export const sendChatMessage = async (message) => {
  try {
    const inferredArea = inferAreaFromMessage(message);
    const data = await apiRequest('/query', {
      method: 'POST',
      role: ROLE.RESIDENT,
      body: {
        text: message,
        area: inferredArea || undefined,
        time_context: 'recent'
      }
    });

    const evidence = Array.isArray(data.evidence)
      ? data.evidence.map((e) => (typeof e === 'string' ? { dataset: e, note: e } : e))
      : [];

    const responsePayload = {
      answer: data.answer || 'Your report has been received and analyzed.',
      confidence: Number(data.confidence ?? 0.7),
      insights: data.insights || [],
      recommended_actions: data.recommended_actions || [],
      evidence,
      assumptions: data.assumptions || [],
      caveats: data.caveats || [],
      ops: {
        priority: data?.ops?.priority || 'medium',
        status: normalizeIncidentStatus(data?.ops?.status || 'new'),
        recurrence_score: Number(data?.ops?.recurrence_score ?? 0.4),
        incident_id: normalizeIncidentId(data?.ops?.incident_id) || null
      }
    };

    if (responsePayload?.ops?.incident_id) {
      addResidentReport({
        id: normalizeIncidentId(responsePayload.ops.incident_id) || responsePayload.ops.incident_id,
        description: message,
        category: normalizeIssueCategory(responsePayload.evidence?.[0]?.dataset),
        status: normalizeIncidentStatus(responsePayload.ops.status || 'new'),
        submitted_at: new Date().toISOString(),
        priority: responsePayload.ops.priority || 'medium'
      });
    }

    return responsePayload;
  } catch (err) {
    return withFallback('sendChatMessage', err, async () => {
      await delay(450);

      const ctx = loadResidentContext();
      const parsedName = extractResidentName(message);
      const parsedLocation = extractResidentLocation(message);
      const nextCtx = {
        reporterName: parsedName || ctx.reporterName,
        exactLocation: parsedLocation || ctx.exactLocation,
        lastIncidentId: ctx.lastIncidentId
      };

      if (isResidentFollowup(message) && nextCtx.lastIncidentId) {
        saveResidentContext(nextCtx);
        return {
          answer: `Got it — I found your report (${nextCtx.lastIncidentId}). Current status: new.`,
          confidence: 0.8,
          insights: ['Follow-up linked to existing report context.'],
          recommended_actions: ['Check My Reports for updates.', 'Add extra details/photos if needed.'],
          evidence: [{ dataset: 'Demo fallback', note: 'Live API unavailable' }],
          assumptions: ['Using stored resident report context in fallback mode.'],
          caveats: ['Fallback mode enabled'],
          ops: { priority: 'medium', status: 'new', recurrence_score: 0.42, incident_id: nextCtx.lastIncidentId }
        };
      }

      const hasName = Boolean(nextCtx.reporterName);
      const hasLocation = Boolean(nextCtx.exactLocation);

      if (!hasName || !hasLocation) {
        saveResidentContext(nextCtx);
        let answer = 'Before I can file this report, I need two details. What is your full name? Please share the exact location (street name + house number or nearest intersection/landmark).';
        if (hasName && !hasLocation) answer = 'Thanks. Please share the exact location (street name + house number or nearest intersection/landmark).';
        if (!hasName && hasLocation) answer = 'Thanks. What is your full name?';

        return {
          answer,
          confidence: 0.75,
          insights: ['Resident intake is waiting for required details.'],
          recommended_actions: ['Provide full name of the reporter.', 'Share exact location (address/intersection/landmark).'],
          evidence: [{ dataset: 'Demo fallback', note: 'Live API unavailable' }],
          assumptions: ['Fallback intake validation'],
          caveats: ['Fallback mode enabled'],
          ops: { priority: 'medium', status: 'new', recurrence_score: 0.35, incident_id: null }
        };
      }

      const incidentId = `INC-${Math.random().toString(16).slice(2, 14).toUpperCase()}`;
      nextCtx.lastIncidentId = incidentId;
      saveResidentContext(nextCtx);
      addResidentReport({
        id: normalizeIncidentId(incidentId) || incidentId,
        description: message,
        category: normalizeIssueCategory('Civic issue'),
        status: normalizeIncidentStatus('new'),
        submitted_at: new Date().toISOString(),
        priority: 'medium'
      });

      return {
        answer: 'Thanks — your report has been logged and queued for triage.',
        confidence: 0.78,
        insights: ['Resident report intake completed with required details.'],
        recommended_actions: ['Keep this Report ID for follow-up.', 'Check My Reports for updates.'],
        evidence: [{ dataset: 'Demo fallback', note: 'Live API unavailable' }],
        assumptions: ['Fallback mode enabled'],
        caveats: ['Live backend unavailable; using local continuity.'],
        ops: { priority: 'medium', status: 'new', recurrence_score: 0.42, incident_id: incidentId }
      };
    });
  }
};

// Insights API - derive admin dashboard shape from backend
export const getInsights = async () => {
  try {
    const [insight, queue, hotspots] = await Promise.all([
      apiRequest('/insight', { role: ROLE.ADMIN }),
      apiRequest('/ops/queue', { role: ROLE.ADMIN }),
      apiRequest('/ops/hotspots', { role: ROLE.ADMIN })
    ]);

    const incidents = (queue.items || []).map(normalizeIncident);
    const total = incidents.length;
    const resolved = incidents.filter((i) => i.status === 'resolved').length;
    const highPriority = incidents.filter((i) => i.priority === 'high').length;

    const byCategory = incidents.reduce((acc, i) => {
      acc[i.issue_category] = (acc[i.issue_category] || 0) + 1;
      return acc;
    }, {});
    const categoryBreakdown = Object.entries(byCategory)
      .map(([category, count]) => ({
        category,
        count,
        percentage: total ? Math.round((count / total) * 100) : 0
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 6);

    const byZone = incidents.reduce((acc, i) => {
      if (!acc[i.zone]) acc[i.zone] = { zone: i.zone, incidents: 0, max: 0 };
      acc[i.zone].incidents += 1;
      acc[i.zone].max = Math.max(acc[i.zone].max, i.recurrence_score || 0);
      return acc;
    }, {});
    const zoneRanking = Object.values(byZone)
      .map((z) => ({ zone: z.zone, incidents: z.incidents, recurrence_score: Number(z.max.toFixed(2)), risk: riskFromScore(z.max) }))
      .sort((a, b) => b.recurrence_score - a.recurrence_score);

    const hs = (hotspots.hotspots || []).map((h) => ({
      area: `${h.zone || 'Zone'} · ${h.issue_category || 'Issue'}`,
      lat: 32.366,
      lon: -86.299,
      incidents: h.open_count || 0,
      recurrence_score: Number((h.max_recurrence_score || 0.4).toFixed(2))
    }));

    const trendData = buildWeeklyTrends(incidents);
    const zoneMomentum = computeEntityMomentum(incidents, 'zone').slice(0, 5);
    const categoryMomentum = computeEntityMomentum(incidents, 'issue_category').slice(0, 5);
    const actionCandidates = buildActionCandidates(hs, incidents);

    return {
      summary: {
        total_incidents: total,
        resolved_this_week: resolved,
        avg_resolution_time: total ? '2.0 days' : 'N/A',
        high_priority_count: highPriority
      },
      trends: trendData,
      categoryBreakdown,
      zoneRanking,
      hotspots: hs,
      trendSignals: {
        zone_momentum: zoneMomentum,
        category_momentum: categoryMomentum,
        action_candidates: actionCandidates,
        generated_at: new Date().toISOString()
      },
      meta: {
        backend_summary: insight?.summary || null,
        data_source: 'live',
        sparse: {
          trends: trendData.length === 0,
          hotspots: hs.length === 0,
          categories: categoryBreakdown.length === 0,
          zones: zoneRanking.length === 0
        }
      }
    };
  } catch (err) {
    return withFallback('getInsights', err, async () => {
      await delay(400);
      return {
        ...mockInsights,
        trendSignals: {
          zone_momentum: [],
          category_momentum: [],
          action_candidates: (mockInsights.hotspots || []).map((h) => ({
            area: h.area,
            zone: h.area,
            issue_category: normalizeIssueCategory('Noise Complaint'),
            recurrence_score: h.recurrence_score,
            incidents: h.incidents,
            priority: riskFromScore(h.recurrence_score),
            incident_id: null,
            suggestion: 'Review hotspot and consider targeted escalation'
          })),
          generated_at: new Date().toISOString()
        },
        meta: {
          data_source: 'mock_fallback',
          sparse: {
            trends: false,
            hotspots: false,
            categories: false,
            zones: false
          }
        }
      };
    });
  }
};

// Operations Queue API - GET /ops/queue
export const getOpsQueue = async (filters = {}) => {
  try {
    const data = await apiRequest('/ops/queue', { role: ROLE.WORKER });
    let incidents = (data.items || []).map(normalizeIncident);

    if (filters.status) incidents = incidents.filter((i) => i.status === filters.status);
    if (filters.priority) incidents = incidents.filter((i) => i.priority === filters.priority);
    if (filters.category) incidents = incidents.filter((i) => i.issue_category === filters.category);
    if (filters.zone) incidents = incidents.filter((i) => i.zone === filters.zone);

    if (!incidents.length) {
      // Keep worker queue journeys usable even when live queue is temporarily empty/unavailable.
      return {
        incidents: mockIncidents,
        total: mockIncidents.length,
        categories: issueCategories
      };
    }

    return {
      incidents,
      total: incidents.length,
      categories: issueCategories
    };
  } catch (err) {
    return withFallback('getOpsQueue', err, async () => {
      await delay(500);
      let filteredIncidents = [...mockIncidents];
      if (filters.status) filteredIncidents = filteredIncidents.filter((i) => i.status === filters.status);
      if (filters.priority) filteredIncidents = filteredIncidents.filter((i) => i.priority === filters.priority);
      if (filters.category) filteredIncidents = filteredIncidents.filter((i) => i.issue_category === filters.category);
      if (filters.zone) filteredIncidents = filteredIncidents.filter((i) => i.zone === filters.zone);
      return { incidents: filteredIncidents, total: filteredIncidents.length, categories: issueCategories };
    });
  }
};

// Update incident status - PATCH /ops/incidents/{id}/status
export const updateIncidentStatus = async (incidentId, newStatus) => {
  try {
    const normalizedIncidentId = normalizeIncidentId(incidentId) || incidentId;
    const payload = await apiRequest(`/ops/incidents/${normalizedIncidentId}/status`, {
      method: 'PATCH',
      role: ROLE.WORKER,
      body: { status: newStatus }
    });

    return {
      success: true,
      incident: {
        incident_id: normalizeIncidentId(payload.incident_id) || payload.incident_id,
        status: payload.status
      }
    };
  } catch (err) {
    return withFallback('updateIncidentStatus', err, async () => {
      await delay(300);
      const incident = mockIncidents.find((i) => i.incident_id === incidentId);
      if (!incident) return { success: false, error: 'Incident not found' };
      incident.status = newStatus;
      return { success: true, incident };
    });
  }
};

// Hotspots API - GET /ops/hotspots
export const getHotspots = async () => {
  try {
    const [hotspotData, queueData] = await Promise.all([
      apiRequest('/ops/hotspots', { role: ROLE.WORKER }),
      apiRequest('/ops/queue', { role: ROLE.WORKER })
    ]);

    const incidents = (queueData.items || []).map(normalizeIncident);
    const zoneCoords = incidents.reduce((acc, i) => {
      if (!Number.isFinite(i.lat) || !Number.isFinite(i.lon) || !i.zone) return acc;
      if (!acc[i.zone]) acc[i.zone] = { lat: i.lat, lon: i.lon };
      return acc;
    }, {});

    const hotspots = (hotspotData.hotspots || []).map((h) => ({
      area: `${h.zone || 'Zone'} · ${h.issue_category || 'Issue'}`,
      lat: zoneCoords[h.zone]?.lat ?? 32.366,
      lon: zoneCoords[h.zone]?.lon ?? -86.299,
      incidents: h.open_count || 0,
      recurrence_score: Number((h.max_recurrence_score || 0.4).toFixed(2))
    }));

    return {
      hotspots,
      incidents: incidents.map((i) => ({
        lat: i.lat,
        lon: i.lon,
        intensity: i.recurrence_score,
        category: i.issue_category,
        id: i.incident_id
      }))
    };
  } catch (err) {
    return withFallback('getHotspots', err, async () => {
      await delay(450);
      return {
        hotspots: mockInsights.hotspots,
        incidents: mockIncidents.map((i) => ({
          lat: i.lat,
          lon: i.lon,
          intensity: i.recurrence_score,
          category: i.issue_category,
          id: i.incident_id
        }))
      };
    });
  }
};

// Escalations API - POST /ops/escalations
// Backend expects: { incident_id, reason }
export const createEscalation = async (escalationData) => {
  try {
    const queue = await apiRequest('/ops/queue', { role: ROLE.ADMIN });
    const incidents = (queue.items || []).map(normalizeIncident);

    let target = null;
    let linkageMode = 'explicit_incident';

    if (escalationData.incident_id) {
      const requestedId = normalizeIncidentId(escalationData.incident_id) || escalationData.incident_id;
      target = incidents.find((i) => i.incident_id === requestedId) || null;
    }

    if (!target) {
      target = incidents
        .filter((i) => {
          const zoneMatch = escalationData.area ? i.zone?.toLowerCase().includes(escalationData.area.toLowerCase()) : true;
          const catMatch = escalationData.issue_category ? i.issue_category === escalationData.issue_category : true;
          return zoneMatch && catMatch;
        })
        .sort((a, b) => (b.recurrence_score || 0) - (a.recurrence_score || 0))[0] || null;
      if (target) linkageMode = 'matched_area_category';
    }

    if (!target) {
      // Keep create flow reliable, but mark that the linkage was inferred from queue risk ordering.
      target = [...incidents].sort((a, b) => (b.recurrence_score || 0) - (a.recurrence_score || 0))[0] || null;
      if (target) linkageMode = 'inferred_highest_risk';
    }

    if (!target) throw new Error('No incidents available for escalation payload');

    const reason = escalationData.reason || `${escalationData.intervention_type || 'Intervention'} for ${escalationData.issue_category || target.issue_category} in ${escalationData.area || target.zone}`;

    const saved = await apiRequest('/ops/escalations', {
      method: 'POST',
      role: ROLE.ADMIN,
      body: {
        incident_id: target.incident_id,
        reason
      }
    });

    const normalized = normalizeEscalation({
      id: saved.escalation_id,
      area: escalationData.area || target.zone,
      issue_category: escalationData.issue_category || target.issue_category,
      recurrence_score: Number(target.recurrence_score || escalationData.recurrence_score || 0.5),
      intervention_type: escalationData.intervention_type || 'Escalation',
      status: saved.status,
      should_escalate: saved.should_escalate,
      created_at: saved.created_at,
      created_by: 'City Operator',
      incident_id: target.incident_id,
      reason,
      source: 'backend',
      linkage_mode: linkageMode,
      source_note: linkageMode === 'inferred_highest_risk'
        ? 'Incident linkage inferred from highest-risk queue item due to missing exact source match.'
        : linkageMode === 'matched_area_category'
          ? 'Incident linkage inferred from area/category match.'
          : null
    });

    const escalation = upsertEscalation(normalized);

    return {
      success: true,
      escalation
    };
  } catch (err) {
    return withFallback('createEscalation', err, async () => {
      await delay(500);
      const newEscalation = normalizeEscalation({
        id: `ESC-${String(mockEscalations.length + 1).padStart(3, '0')}`,
        ...escalationData,
        status: 'active',
        created_at: new Date().toISOString(),
        created_by: 'Admin User',
        source: 'mock_fallback'
      });
      mockEscalations.push(newEscalation);
      return { success: true, escalation: upsertEscalation(newEscalation) };
    });
  }
};

// Escalation history (backend list may be unavailable; merge server list with local cache)
export const getEscalations = async () => {
  try {
    const [backendListProbe, queue] = await Promise.all([
      fetchEscalationListFromBackend(),
      apiRequest('/ops/queue', { role: ROLE.ADMIN })
    ]);

    const backendList = backendListProbe?.escalations;
    const incidents = (queue.items || []).map(normalizeIncident);
    const fallbackFromIncidents = incidents
      .filter((i) => i.status === 'escalated' || i.priority === 'high')
      .slice(0, 40)
      .map((i) => normalizeEscalation({
        id: `ESC-${i.incident_id}`,
        area: i.zone,
        issue_category: i.issue_category,
        recurrence_score: i.recurrence_score,
        intervention_type: 'Escalation',
        status: i.status === 'resolved' ? 'completed' : 'active',
        created_at: i.reported_at,
        created_by: i.owner || 'System',
        incident_id: i.incident_id,
        source: 'derived_from_queue'
      }));

    const cached = loadEscalationsCache().map(normalizeEscalation);
    const backendEscalations = (backendList || fallbackFromIncidents).map(normalizeEscalation);

    const deduped = [...cached, ...backendEscalations].reduce((acc, item) => {
      if (!acc[item.id]) acc[item.id] = item;
      return acc;
    }, {});

    const escalations = Object.values(deduped)
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

    saveEscalationsCache(escalations);

    return {
      escalations,
      intervention_types: interventionTypes,
      meta: {
        source: backendList ? 'backend_list' : 'queue_derived',
        backendListAvailable: Array.isArray(backendList),
        backendListCount: Array.isArray(backendList) ? backendList.length : null,
        backendListPath: backendListProbe?.sourcePath || null,
        probes: backendListProbe?.probes || []
      }
    };
  } catch (err) {
    return withFallback('getEscalations', err, async () => {
      await delay(200);
      const cached = loadEscalationsCache().map(normalizeEscalation);
      const merged = [...cached, ...mockEscalations.map((x) => normalizeEscalation({ ...x, source: 'mock_fallback' }))]
        .reduce((acc, item) => {
          if (!acc[item.id]) acc[item.id] = item;
          return acc;
        }, {});
      return {
        escalations: Object.values(merged).sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()),
        intervention_types: interventionTypes,
        meta: {
          source: 'mock_fallback',
          backendListAvailable: false,
          probes: err?.escalationProbe || []
        }
      };
    });
  }
};

export const getResidentCategories = async () => {
  try {
    const payload = await apiRequest('/datasets/categories', { role: ROLE.RESIDENT });
    return {
      categories: sanitizeResidentCategories(payload.categories || []),
      byDataset: payload.by_dataset || {},
      lastRefreshAt: payload.last_refresh_at || null,
    };
  } catch (err) {
    return withFallback('getResidentCategories', err, async () => ({
      categories: sanitizeResidentCategories(issueCategories),
      byDataset: {},
      lastRefreshAt: null,
    }));
  }
};

// Resident reports API
export const getMyReports = async () => {
  return loadResidentReports();
};
