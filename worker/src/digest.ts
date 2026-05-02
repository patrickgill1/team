/**
 * Weekly digest builder. Runs from a scheduled cron in worker/src/index.ts.
 *
 * For each team:
 *   - Upcoming events in the next 7 days
 *   - News posted in the last 7 days
 *   - Recently completed dev plan goals (coachVerified in last 7 days)
 *   - Recent player media (added in last 7 days)
 * Then emails one digest per parent of the team.
 */

import { runQuery, listDocuments, FirestoreDoc } from './firestore';
import type { ServiceAccount } from './fcm';

interface DigestEnv {
  RESEND_API_KEY: string;
  FROM_EMAIL: string;
  FROM_NAME: string;
  APP_ORIGIN: string;
  FCM_SERVICE_ACCOUNT?: string;
}

const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function fmtDate(d: Date | undefined | null): string {
  if (!d) return '';
  return new Date(d).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

interface DigestData {
  upcomingEvents: FirestoreDoc[];
  recentNews: FirestoreDoc[];
  recentDevGoals: { planTitle: string; goalTitle: string; playerName: string; verifiedAt: Date }[];
  recentMedia: FirestoreDoc[];
}

async function buildTeamDigest(projectId: string, sa: ServiceAccount, teamId: string): Promise<DigestData> {
  const now = new Date();
  const weekAgo = new Date(now.getTime() - ONE_WEEK_MS);
  const weekAhead = new Date(now.getTime() + ONE_WEEK_MS);

  // Upcoming events (next 7 days)
  const upcomingEvents = await runQuery(projectId, 'events', [
    { field: 'teamId', op: 'EQUAL', value: teamId },
    { field: 'date', op: 'GREATER_THAN_OR_EQUAL', value: now },
    { field: 'date', op: 'LESS_THAN_OR_EQUAL', value: weekAhead },
  ], sa, 50).catch(() => []);

  // Recent news (last 7 days)
  const recentNews = await runQuery(projectId, 'news', [
    { field: 'teamId', op: 'EQUAL', value: teamId },
    { field: 'createdAt', op: 'GREATER_THAN_OR_EQUAL', value: weekAgo },
  ], sa, 20).catch(() => []);

  // Recently completed dev goals — fetch active+completed plans, then filter goals locally.
  const planDocs = await runQuery(projectId, 'developmentPlans', [
    { field: 'teamId', op: 'EQUAL', value: teamId },
  ], sa, 200).catch(() => []);
  const recentDevGoals: DigestData['recentDevGoals'] = [];
  for (const p of planDocs) {
    const goals: any[] = Array.isArray(p.data.goals) ? p.data.goals : [];
    for (const g of goals) {
      const v = g.coachVerifiedAt;
      if (!v || !g.coachVerified) continue;
      const t = new Date(v);
      if (t >= weekAgo && t <= now) {
        recentDevGoals.push({
          planTitle: String(p.data.title || 'Plan'),
          goalTitle: String(g.title || 'Goal'),
          playerName: String(p.data.playerName || ''),
          verifiedAt: t,
        });
      }
    }
  }

  // Recent player media (last 7 days)
  const recentMedia = await runQuery(projectId, 'playerMedia', [
    { field: 'teamId', op: 'EQUAL', value: teamId },
    { field: 'createdAt', op: 'GREATER_THAN_OR_EQUAL', value: weekAgo },
  ], sa, 30).catch(() => []);

  return { upcomingEvents, recentNews, recentDevGoals, recentMedia };
}

function renderDigestHtml(teamName: string, parentName: string, appOrigin: string, d: DigestData): { subject: string; html: string } | null {
  const totalItems = d.upcomingEvents.length + d.recentNews.length + d.recentDevGoals.length + d.recentMedia.length;
  if (totalItems === 0) return null;

  const eventsRows = d.upcomingEvents
    .sort((a, b) => new Date(a.data.date).getTime() - new Date(b.data.date).getTime())
    .map(e => `<li><b>${escapeHtml(e.data.title || 'Event')}</b> — ${escapeHtml(fmtDate(new Date(e.data.date)))}${e.data.location ? ` at ${escapeHtml(e.data.location)}` : ''}</li>`)
    .join('');

  const newsRows = d.recentNews
    .sort((a, b) => new Date(b.data.createdAt).getTime() - new Date(a.data.createdAt).getTime())
    .slice(0, 5)
    .map(n => `<li><a href="${appOrigin}/news" style="color:#1e3a5f;text-decoration:none"><b>${escapeHtml(n.data.title || 'Update')}</b></a> — ${escapeHtml(String(n.data.content || '').slice(0, 120))}…</li>`)
    .join('');

  const devRows = d.recentDevGoals
    .sort((a, b) => b.verifiedAt.getTime() - a.verifiedAt.getTime())
    .slice(0, 8)
    .map(g => `<li>🎯 <b>${escapeHtml(g.playerName)}</b> completed <i>${escapeHtml(g.goalTitle)}</i> in “${escapeHtml(g.planTitle)}”</li>`)
    .join('');

  const mediaRows = d.recentMedia
    .sort((a, b) => new Date(b.data.createdAt).getTime() - new Date(a.data.createdAt).getTime())
    .slice(0, 5)
    .map(m => `<li>${m.data.type === 'video' ? '🎥' : '📸'} ${escapeHtml(m.data.playerName || 'A player')}${m.data.caption ? ` — ${escapeHtml(String(m.data.caption).slice(0, 80))}` : ''}</li>`)
    .join('');

  const sections: string[] = [];
  if (eventsRows) sections.push(`<h3 style="color:#1e3a5f;margin:18px 0 8px">📅 Upcoming this week</h3><ul style="margin:0;padding-left:18px;line-height:1.6">${eventsRows}</ul>`);
  if (newsRows)   sections.push(`<h3 style="color:#1e3a5f;margin:18px 0 8px">📰 Latest team news</h3><ul style="margin:0;padding-left:18px;line-height:1.6">${newsRows}</ul>`);
  if (devRows)    sections.push(`<h3 style="color:#1e3a5f;margin:18px 0 8px">🎯 Goals completed</h3><ul style="margin:0;padding-left:18px;line-height:1.6">${devRows}</ul>`);
  if (mediaRows)  sections.push(`<h3 style="color:#1e3a5f;margin:18px 0 8px">✨ New highlights</h3><ul style="margin:0;padding-left:18px;line-height:1.6">${mediaRows}</ul><p style="margin-top:8px"><a href="${appOrigin}/highlights" style="color:#1e3a5f;font-weight:bold">▶ Watch the highlight reel</a></p>`);

  const subject = `${teamName} weekly digest — ${d.upcomingEvents.length} upcoming, ${d.recentDevGoals.length} goals, ${d.recentMedia.length} clips`;

  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#0f172a">
      <h1 style="color:#1e3a5f;margin:0 0 4px">Hi ${escapeHtml(parentName.split(' ')[0] || 'there')},</h1>
      <p style="color:#475569;margin:0 0 16px">Here's what happened with <b>${escapeHtml(teamName)}</b> this week.</p>
      ${sections.join('')}
      <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0"/>
      <p style="font-size:12px;color:#94a3b8;margin:0">You can change your email preferences any time in your profile.</p>
    </div>
  `;
  return { subject, html };
}

async function sendDigestEmail(env: DigestEnv, to: string, subject: string, html: string): Promise<boolean> {
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${env.RESEND_API_KEY}` },
      body: JSON.stringify({
        from: `${env.FROM_NAME} <${env.FROM_EMAIL}>`,
        to: [to],
        subject,
        html,
      }),
    });
    return r.status >= 200 && r.status < 300;
  } catch {
    return false;
  }
}

export async function runWeeklyDigest(env: DigestEnv): Promise<{ ok: boolean; teams: number; emails: number; errors: string[] }> {
  const errors: string[] = [];
  if (!env.FCM_SERVICE_ACCOUNT) return { ok: false, teams: 0, emails: 0, errors: ['no-service-account'] };
  let sa: ServiceAccount;
  try { sa = JSON.parse(env.FCM_SERVICE_ACCOUNT); } catch { return { ok: false, teams: 0, emails: 0, errors: ['invalid-service-account'] }; }
  const projectId = sa.project_id;

  // Load teams + all users (we'll filter parents per team).
  const [teams, users] = await Promise.all([
    listDocuments(projectId, 'teams', sa, 100).catch(e => { errors.push(`teams: ${e.message}`); return []; }),
    listDocuments(projectId, 'users', sa, 1000).catch(e => { errors.push(`users: ${e.message}`); return []; }),
  ]);

  let totalEmails = 0;
  for (const team of teams) {
    const teamId = team.id;
    const teamName = String(team.data.name || 'Your team');
    let digest: DigestData;
    try {
      digest = await buildTeamDigest(projectId, sa, teamId);
    } catch (e: any) {
      errors.push(`team ${teamId}: ${e?.message || e}`);
      continue;
    }

    // Find parents for this team that opted in to weekly digest.
    const parents = users.filter(u => {
      const role = u.data.role;
      if (role !== 'parent') return false;
      const teamIds: any[] = Array.isArray(u.data.teamIds) ? u.data.teamIds : [];
      if (!teamIds.includes(teamId) && u.data.teamId !== teamId) return false;
      // Honor optional weeklyDigest preference (default true if missing).
      const prefs = u.data.emailPreferences || {};
      if (prefs.weeklyDigest === false) return false;
      return !!u.data.email;
    });

    if (parents.length === 0) continue;

    for (const p of parents) {
      const rendered = renderDigestHtml(teamName, String(p.data.name || ''), env.APP_ORIGIN, digest);
      if (!rendered) break; // nothing to send for this team
      const ok = await sendDigestEmail(env, String(p.data.email), rendered.subject, rendered.html);
      if (ok) totalEmails++;
      else errors.push(`send to ${p.data.email} failed`);
    }
  }

  return { ok: errors.length === 0, teams: teams.length, emails: totalEmails, errors };
}
