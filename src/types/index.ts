export type UserRole = 'coach' | 'parent' | 'team_manager';
export type ApprovalStatus = 'auto' | 'pending' | 'approved' | 'rejected';

/** Family relationship for users with role 'parent'. Permissions are
 *  identical for all values — this only changes the display label
 *  ("Grandparent of Hunter" vs "Parent of Hunter"). Coaches/team-
 *  managers leave this unset. Existing users without the field are
 *  treated as 'parent'. */
export type FamilyRelationship = 'parent' | 'grandparent' | 'aunt_uncle' | 'guardian' | 'sibling' | 'other';

export const RELATIONSHIP_LABELS: Record<FamilyRelationship, string> = {
  parent: 'Parent',
  grandparent: 'Grandparent',
  aunt_uncle: 'Aunt / Uncle',
  guardian: 'Guardian',
  sibling: 'Sibling',
  other: 'Family',
};

export interface User {
  uid: string;
  id?: string;
  email: string;
  name: string;
  role: UserRole;
  teamId: string;
  teamIds?: string[]; // All teams this user belongs to
  coachLevel?: 'head_coach' | 'assistant_coach'; // For coaches only
  approved?: boolean; // legacy — use approvalStatus going forward
  approvalStatus?: ApprovalStatus;
  approvedAt?: Date;
  approvedBy?: string;
  invitedBy?: string; // uid of staff member who shared the invite link
  invitedVia?: string; // invite doc id
  createdAt: Date;
  updatedAt?: Date;
  isActive: boolean;
  profilePhotoUrl?: string | null;
  phoneNumber?: string | null;
  address?: string;
  emergencyContact?: string | null;
  emergencyPhone?: string;
  children?: string[];
  /** When role === 'parent', describes the family relationship to the
   *  player(s) on parentIds. Permissions don't change — only the UI
   *  label. Missing/undefined falls back to 'parent'. Stamped by
   *  consumeInvite() when the inviting coach selected a relationship. */
  relationship?: FamilyRelationship;
  privacy?: {
    showPhone: boolean;
    showEmail: boolean;
    showAddress: boolean;
  };
  /** USSF Learning Center credentials. Today these are populated manually
   *  via Settings; once we have API creds from connect.ussdlc.com, the
   *  webhook handler writes them with source: 'ussf' and the manual
   *  rows get marked stale. See docs/USSF_API_REQUEST.md for the
   *  outreach we need to send USSF to get those creds. */
  coachCertifications?: CoachCertification[];
}

export interface CoachCertification {
  id: string;
  /** Full credential name as USSF reports it — e.g., "Grassroots E License". */
  name: string;
  /** Coaching license letter, if applicable. Referee credentials leave this null. */
  level?: 'E' | 'D' | 'C' | 'B' | 'A' | 'Pro';
  /** Cert TYPE. Extended in 2026-06-21 to cover the non-license items
   *  the team-activation funnel requires: background_check / concussion /
   *  safesport. Each becomes its own cert row with appropriate dates. */
  kind: CoachCertKind;
  issuedAt?: Date;
  expiresAt?: Date;
  /** 'manual' = coach entered it themself; 'ussf' = synced from the
   *  USSF Learning Center webhook. The 'ussf' value beats 'manual' on
   *  conflict (manual entry is just a placeholder until the API lights up). */
  source: 'manual' | 'ussf';
}

// UserData interface for auth context (matches User but ensures required fields for auth)
export interface UserData {
  uid: string;
  id?: string;
  email: string;
  name: string;
  role: UserRole;
  teamId: string;
  teamIds?: string[]; // All teams this user belongs to
  /** When true, the user can see/manage every team in the club via /club,
   *  on top of their normal coach scope on the teams they personally
   *  belong to. Set manually in Firestore for now — no admin UI yet. */
  isClubAdmin?: boolean;
  coachLevel?: 'head_coach' | 'assistant_coach';
  approved?: boolean; // legacy
  approvalStatus?: ApprovalStatus;
  invitedBy?: string;
  invitedVia?: string;
  createdAt: Date;
  phoneNumber?: string;
  /** Profile photo for the user themself (separate from any linked
   *  player avatars). Shown in Settings, top bar, chat author rows. */
  photoURL?: string;
  address?: string;
  emergencyContact?: string;
  emergencyPhone?: string;
  privacy?: {
    showPhone: boolean;
    showEmail: boolean;
    showAddress: boolean;
  };
  /** Per-category push opt-outs. Independent of emailPreferences so a
   *  parent who mutes the weekly digest email still gets game-day push.
   *  Missing keys default to `true` (opt-out, not opt-in). */
  pushPreferences?: {
    chat?: boolean;
    events?: boolean;
    helpdesk?: boolean;
    broadcast?: boolean;
  };
  fcmTokens?: string[];
  /** UIDs of other users this person has muted in chat. They still see
   *  the messages in-thread but no push notification fires from them.
   *  Personal preference; doesn't affect anyone else's experience. */
  mutedUserIds?: string[];
  /** Thread IDs this user has pinned to the top of their chat list.
   *  Pinning is per-user — replaces the older thread-level isPinned
   *  flag where one coach's pin pushed it up everyone's list. */
  pinnedThreadIds?: string[];
}

export interface SeasonMembership {
  seasonId: string;
  teamId: string;
  jerseyNumber?: number;
  position?: string;
}

// =====================================================================
// CLUB / MEMBERSHIP MODEL — NEW (replaces team-owns-player)
//
// Players belong to a CLUB, not a team. A player is rostered onto one
// or more teams for one or more seasons via PlayerMembership docs.
// Stats live on the membership row (scoped to player × team × season)
// so a player on two teams keeps two clean stat lines.
//
// Solo-team users get a club auto-created behind the scenes named
// after their team, so the "club" concept is invisible unless they
// actually start running multiple teams.
//
// During migration: legacy fields on Player/Team (teamIds, playerIds,
// player.stats, etc.) are kept in sync ("dual-write") so old read
// paths don't break. We cut them after the new paths are everywhere.
// =====================================================================

export interface Club {
  id: string;
  name: string;
  /** Logo for the club shell (separate from a team's logo — Fire FC the
   *  club vs. Fire FC PG the team). */
  logoUrl?: string;
  /** Club brand color as a hex string ("#DC2626"). Used by public
   *  invite landing pages and any other club-public surfaces. We
   *  intentionally don't theme the whole app per-club — that's a
   *  Tailwind config rabbit hole — only the surfaces a new family
   *  sees during onboarding. */
  brandColor?: string;
  ownerUid: string;
  /** Users with full club-admin rights. Always includes ownerUid. */
  adminUids: string[];
  /** Denorm cache of team IDs in this club — kept up to date on team
   *  create/delete so we can list teams without a where() query. */
  teamIds: string[];
  isActive: boolean;
  createdAt: Date;
  archivedAt?: Date;

  /** Stripe Connect Standard — multi-club model. Each club connects
   *  their OWN Stripe account, holds their own funds, and Stripe
   *  payouts go directly to them. Fire FC the platform never touches
   *  the money. We just trigger Checkout Sessions on their behalf via
   *  the Stripe-Account header. */
  stripeAccountId?: string;
  /** True once Stripe has fully verified the account (KYC done, bank
   *  added, can accept charges). Until then, "Accept payment" CTAs are
   *  disabled in the UI even if the connection started. */
  stripeChargesEnabled?: boolean;
  stripePayoutsEnabled?: boolean;
  stripeOnboardedAt?: Date;
  /** Fire FC platform fee, in basis points (100 = 1%). When set, the
   *  worker passes `application_fee_amount` on the Stripe Checkout
   *  Session so Stripe automatically routes that slice to the
   *  platform's Stripe account on every charge. Default 0 = the club
   *  keeps 100% (minus Stripe's flat take).
   *
   *  IMPORTANT: writable ONLY by the platform owner (Patrick) via
   *  /platform/clubs. Club admins must NOT be able to flip this on
   *  their own Club doc — that would defeat the entire revenue model.
   *  See `project_platform_fee` memory + the auth check on the
   *  platform page. */
  platformFeeBps?: number;
}

export interface Invoice {
  id: string;
  clubId: string;
  teamId: string;
  /** Who owes — parent UID. */
  parentUid: string;
  /** Denorm so we can show "for Hunter" on a parent's invoice list
   *  without an extra join. */
  playerId?: string;
  playerName?: string;
  /** What this is for ("Spring 2026 fees", "Tournament entry", etc.). */
  description: string;
  /** Amount in CENTS — Stripe's canonical integer representation, no
   *  floating point math. */
  amountCents: number;
  currency: 'usd';
  status: 'pending' | 'paid' | 'cancelled' | 'refunded';
  /** Stripe artifacts — populated by the worker as the payment flows. */
  stripeCheckoutSessionId?: string;
  stripePaymentIntentId?: string;
  /** Audit trail. */
  createdBy: string;
  createdAt: Date;
  paidAt?: Date;
  cancelledAt?: Date;
  refundedAt?: Date;
}

export interface PlayerMembership {
  id: string;
  clubId: string;     // denorm of team.clubId for query-by-club
  teamId: string;
  seasonId: string;
  playerId: string;
  jerseyNumber?: number;
  position?: string;
  positions?: string[];
  isActive: boolean;
  joinedAt: Date;
  leftAt?: Date;
  /** Stats scoped to THIS membership (this team, this season). The
   *  player's career-across-everything totals are computed by summing
   *  every membership in the UI; we don't cache them. */
  stats?: PlayerStats;
}

export interface StaffMembership {
  id: string;
  clubId: string;
  teamId: string;
  seasonId: string;
  uid: string;
  role: 'head_coach' | 'assistant_coach' | 'team_manager';
  isActive: boolean;
  joinedAt: Date;
  leftAt?: Date;
}

// ---------- Helpdesk ----------
export type TicketStatus = 'open' | 'assigned' | 'in_progress' | 'resolved' | 'closed';
export type TicketPriority = 'low' | 'normal' | 'high';
export type TicketCategory = 'team_logistics' | 'team_issue' | 'general_question' | 'app_bug' | 'feature_request' | 'billing' | 'other';

export interface HelpdeskTicket {
  id: string;
  clubId: string;
  teamId?: string;
  createdBy: string;
  createdByName: string;
  createdByRole?: 'parent' | 'coach' | 'team_manager' | 'admin';
  subject: string;
  description: string;
  category: TicketCategory;
  status: TicketStatus;
  priority: TicketPriority;
  assignedTo?: string;
  assignedToName?: string;
  createdAt: Date;
  updatedAt?: Date;
  resolvedAt?: Date;
}

export interface HelpdeskComment {
  id: string;
  ticketId: string;
  authorId: string;
  authorName: string;
  authorRole?: string;
  content: string;
  /** Status changes posted by admins are stored as comments with a
   *  `statusChange` field so the thread doubles as a full audit log. */
  statusChange?: { from: TicketStatus; to: TicketStatus };
  createdAt: Date;
}

/** A real-world family unit that may span multiple parent emails.
 *  We can't always infer households from email alone (mom uses
 *  janeswim@gmail.com, dad uses bobs.work@firm.com, kid 1's reg has
 *  mom's email, kid 2's has dad's — same household). Admin manually
 *  links emails into a Household; Player + Registration docs get the
 *  resulting `householdId` so the family timeline rolls everything up.
 *
 *  Created lazily — most families never need an explicit Household
 *  doc because they consistently use the same email. Only families
 *  that need cross-email unification get one. */
export interface Household {
  id: string;
  clubId: string;
  /** Display label. Defaults to "<lastName> household" derived from
   *  the first member; admin can override. */
  name?: string;
  /** Lowercased parent emails that belong to this household. All
   *  registrations / players matching ANY of these emails are
   *  rolled into the unified family timeline. */
  parentEmails: string[];
  /** Linked Player IDs (denorm for fast lookup; players also carry
   *  the householdId pointer). */
  playerIds: string[];
  /** Optional shared address — captured for league reports / mailings. */
  address?: string;
  notes?: string;
  createdAt: Date;
  createdByUid?: string;
  createdByName?: string;
  updatedAt?: Date;
}

/** Structured medical profile for a player. Replaces (but doesn't
 *  delete) the legacy free-text `Player.medicalInfo` field — the
 *  PersonAdmin medical editor surfaces the old string as a "legacy
 *  notes" field the admin can read and then fold into structured
 *  rows. Critical alerts (severe allergies, EpiPen, active EAP,
 *  recent concussion w/o clearance) drive the red banner at the top
 *  of PersonAdmin. */
export interface MedicalProfile {
  /** Each row: substance, severity, EpiPen flag, notes. EpiPen on
   *  ANY row triggers the critical-alerts banner. */
  allergies?: Array<{
    id: string;
    substance: string;
    severity?: 'mild' | 'moderate' | 'severe' | 'life-threatening';
    hasEpiPen?: boolean;
    notes?: string;
  }>;
  /** Each row: condition name + optional severity + EAP text (what
   *  to do in an episode). EAP presence triggers the alert banner. */
  conditions?: Array<{
    id: string;
    name: string;
    severity?: 'mild' | 'moderate' | 'severe';
    /** Emergency action plan — free text the coach reads during an
     *  episode. e.g. "Inhaler in left pocket of backpack. If two
     *  doses don't help, call 911." */
    eap?: string;
    notes?: string;
  }>;
  /** Active medications the kid takes. Captured so coaches know what
   *  to expect (e.g. behavioral changes if a dose is missed). */
  medications?: Array<{
    id: string;
    name: string;
    dosage?: string;
    schedule?: string;
    notes?: string;
  }>;
  /** Concussion log — date, severity, return-to-play clearance.
   *  Soccer-specific high-stakes; tracked here so the alert banner
   *  can warn coaches when a kid hasn't been cleared yet. */
  concussions?: Array<{
    id: string;
    date: Date;
    severity?: 'mild' | 'moderate' | 'severe';
    clearedToReturnAt?: Date;
    notes?: string;
  }>;
  /** Doctor / pediatrician contact. */
  primaryCare?: { name?: string; phone?: string; practice?: string };
  /** Insurance — captured for emergency-room handoff. */
  insurance?: { carrier?: string; policyNumber?: string; groupNumber?: string };
  /** Last sports physical (most leagues require one annually). */
  lastPhysicalAt?: Date;
  /** Optional blood type. Useful in trauma; not collected for most
   *  programs but the field is here if a club wants it. */
  bloodType?: 'A+' | 'A-' | 'B+' | 'B-' | 'AB+' | 'AB-' | 'O+' | 'O-';
  /** Free-form notes that don't fit elsewhere. Where the legacy
   *  `Player.medicalInfo` string lands on first migration. */
  generalNotes?: string;
  /** Audit fields. */
  updatedAt?: Date;
  updatedByUid?: string;
  updatedByName?: string;
}

export interface Player {
  id: string;
  name: string;
  jerseyNumber?: number;
  /** @deprecated kept for backward compatibility with older docs; use positions[] going forward. */
  position?: string;
  /** Multi-position support (e.g. a player who's both a keeper and a striker). */
  positions?: string[];
  dateOfBirth?: Date;
  parentId?: string;
  parentIds?: string[];
  parentEmails?: string[];
  teamId: string;
  teamIds?: string[]; // Player can belong to multiple teams
  isActive: boolean;
  profilePhotoUrl?: string | null;
  emergencyContacts?: EmergencyContact[];
  medicalInfo?: string;
  /** Structured medical profile (allergies, conditions, EAPs,
   *  meds, concussions, primary-care, insurance). Replaces the
   *  legacy `medicalInfo` free-text field but doesn't remove it —
   *  the editor surfaces the legacy string as a migration hint. */
  medical?: MedicalProfile;
  /** Household this player belongs to, if the admin has linked
   *  multi-email families. Optional — most players don't need one. */
  householdId?: string;
  stats?: PlayerStats; // legacy aggregate, retained during transition
  statsBySeasonId?: Record<string, PlayerStats>;
  statsLifetime?: PlayerStats; // optional cache, sum of statsBySeasonId
  seasonMemberships?: SeasonMembership[];
  createdAt: Date;
  updatedAt?: Date;
  inviteCode?: string;
  /** Cached current practice streak in consecutive days. Bumped on
   *  every "I did it today" tap so PlayerCard rows can show a
   *  discrete streak bubble without loading every plan per render.
   *  Recomputed from practice logs on each update — if it goes stale
   *  (player skipped logging for a while), next log corrects it. */
  currentStreakDays?: number;
  currentStreakUpdatedAt?: Date;
  /** Self-reported juggle counter — parents log "Hunter juggled X
   *  times today." We keep a personal best + a short rolling history
   *  for streak/weekly-best math without a separate collection. */
  juggles?: {
    best?: number;
    bestAt?: Date;
    /** Last 30 attempts max — bounded so the doc stays small. Each
     *  entry: count + date + who logged it. */
    history?: Array<{ count: number; date: Date; loggedBy?: string; loggedByName?: string }>;
  };
  /** Optional bio fields surfaced on the parent-facing PlayerProfile.
   *  All editable from the profile's Info card → Edit modal. Cheap
   *  to omit — UI gracefully renders "—" when missing. */
  preferredFoot?: 'Left' | 'Right' | 'Both';
  favoritePosition?: string;
  favoritePlayer?: string;
  /** When this kid first joined the club. Falls back to createdAt
   *  for legacy players. */
  joinedAt?: Date;
  /** Issued team gear for the current season — sizes + return status.
   *  Single record per player at a time; a coach manually clears it
   *  ("Reset for next season") between seasons. We don't archive
   *  history yet — uncommon ask, can add an `equipmentHistory` array
   *  if it ever comes up. */
  equipment?: PlayerEquipment;
  /** Recruitment-funnel progress — one entry per stage from registration
   *  through ready-to-play. Anything not yet complete is simply absent
   *  from the map. Stages auto-complete when the underlying event fires
   *  (Phase 1+ wires the writes); admins can also mark any stage done
   *  manually from PersonAdmin for the external-league row + edge cases.
   *  See FunnelStepper.tsx for the canonical stage list + rendering. */
  funnelProgress?: FunnelProgress;
}

/** One stage of the recruitment funnel. Persists when it was completed
 *  + who (or 'system' for auto-writes) + any stage-specific meta the
 *  upstream phase wants to attach (registration id, offer id, stripe
 *  payment id, etc). Missing key === stage not yet done. */
export interface FunnelStageEntry {
  completedAt: Date;
  by?: string;
  meta?: Record<string, unknown>;
}

export type FunnelStageKey =
  | 'register'
  | 'tryouts'
  | 'offer_sent'
  | 'offer_accept'
  | 'external_league'
  | 'club_dues';

export type FunnelProgress = Partial<Record<FunnelStageKey, FunnelStageEntry>>;

/* ───────────────────────── TEAM ACTIVATION FUNNEL ─────────────────────────
 * Mirrors the player funnel but at the team level. Tracks the sequence
 * that has to be complete before a team is fully activated for a season.
 * Patrick's wedge claim: most team apps don't surface this as a workflow.
 * Sports Affinity does on the club side; nothing puts it in the coach's /
 * admin's hand. Stages:
 *
 *   tryouts            — held + concluded
 *   team_selected      — roster locked, head coach assigned
 *   all_registered     — every player has registration + waivers signed
 *   coaches_certified  — head + assistants have current US Soccer certs on
 *                        file (Grassroots license, background check,
 *                        concussion training, SafeSport). Auto-fill once
 *                        Sports Affinity API is wired; manual stamp for now.
 *   activated          — final go-live gate. Admin stamps after reviewing
 *                        the other four. Team becomes 'live' for the season.
 * ────────────────────────────────────────────────────────────────────── */
export type TeamFunnelStageKey =
  | 'tryouts'
  | 'team_selected'
  | 'all_registered'
  | 'coaches_certified'
  | 'activated';

export type TeamFunnelProgress = Partial<Record<TeamFunnelStageKey, FunnelStageEntry>>;

/* ───────────────────────── COACH CERTIFICATION HELPERS ────────────────
 * User.coachCertifications[] already exists for tracking US Soccer
 * licenses (Grassroots E/D/C/B/A/Pro). The team funnel's
 * `coaches_certified` stage requires FOUR distinct things — only one of
 * which is a license — so we need to extend the model to cover the
 * non-license items as well.
 *
 * Required items per US Soccer / SafeSport for any youth coach in good
 * standing:
 *   - Grassroots license   (kind: 'coach', level: 'E' minimum)
 *   - Annual background check
 *   - Concussion training (CDC HEADS UP, via learning.ussoccer.com)
 *   - SafeSport training (via learning.ussoccer.com)
 *
 * Once the Sports Affinity API is wired (per reference_sports_affinity
 * memory), all four come in as 'ussf'-sourced stamps. Until then admins
 * stamp manually in the team funnel UI after checking the coach's
 * learning.ussoccer.com transcript.
 * ────────────────────────────────────────────────────────────────────── */
export const REQUIRED_COACH_CERT_KINDS = [
  'coach',             // Grassroots+ license
  'background_check',
  'concussion',
  'safesport',
] as const;
export type CoachCertKind = typeof REQUIRED_COACH_CERT_KINDS[number] | 'referee' | 'goalkeeper';

export interface PlayerEquipment {
  jerseyHomeSize?: string;
  jerseyAwaySize?: string;
  shortsSize?: string;
  socksSize?: string;
  trainingTopSize?: string;
  /** True once the gear has been turned back in at season end. The
   *  /equipment coach view filters by this to show what's outstanding. */
  returned?: boolean;
  /** Free-form notes — e.g., "ordered larger shorts mid-season". */
  notes?: string;
  issuedAt?: Date;
  returnedAt?: Date;
}

/** Where a season is in its yearly lifecycle. Drives what UIs surface
 *  what (registration form open? tryout pool visible? roster locked?).
 *  Transitions are a directed-acyclic state machine; see
 *  `validSeasonTransitions` in src/utils/seasonLifecycle.ts.
 *
 *    draft → registration_open → tryouts → roster_locked → in_season → ended → archived
 *
 *  `registrationOpen` (legacy boolean) is kept in sync — true when
 *  lifecycle === 'registration_open' — so old read paths don't break. */
export type SeasonLifecycle =
  | 'draft'
  | 'coach_commit'      // wizard step 2: coaches assigned + commitment cycle
  | 'tryout_prep'       // wizard step 3-5: tryouts scheduled, forms attached, marketing queued
  | 'registration_open'
  | 'tryouts'
  | 'roster_locked'
  | 'in_season'
  | 'ended'
  | 'archived';

export interface SeasonLifecycleEvent {
  fromState?: SeasonLifecycle;
  toState: SeasonLifecycle;
  at: Date;
  by?: string;
  byName?: string;
  note?: string;
}

export interface Season {
  id: string;
  teamId: string;
  clubId?: string; // future Club Portal hook
  name: string;
  startDate: Date;
  endDate: Date;
  isActive: boolean;
  archivedAt?: Date;
  createdAt: Date;
  /** State-machine field — see `SeasonLifecycle`. Default 'draft' for
   *  legacy seasons that predate this field. */
  lifecycle?: SeasonLifecycle;
  /** Append-only audit log of every transition. Drives the "history"
   *  view in the season manager. */
  lifecycleHistory?: SeasonLifecycleEvent[];
  /** Club-wide registration window for this season. When `registrationOpen`
   *  is true, the public /register form accepts submissions. Kept in sync
   *  with lifecycle === 'registration_open'. */
  registrationOpen?: boolean;
  registrationOpenedAt?: Date;
  registrationCloseDate?: Date;
  /** Base registration fee per player in CENTS. Stripe canonical. */
  registrationFeeCents?: number;
  /** Optional early-bird discount that applies through this date. */
  earlyBirdDeadline?: Date;
  earlyBirdDiscountCents?: number;

  /* ───────────────────────── SEASON WIZARD STATE ─────────────────────
   * Added 2026-06-21 alongside the Season Wizard build. Patrick:
   * 'should all work in a step by step process... like a timeline.'
   * Each field below corresponds to one wizard step's output. The
   * wizard is just a guided editor over this object; downstream
   * pages (Tryouts, Registrations, etc.) read these fields to know
   * what the admin set up for this season.
   * ─────────────────────────────────────────────────────────────── */

  /** Age groups this season is running (e.g. ['U8', 'U10', 'U12']).
   *  Drives the per-age-group breakdown for coach assignments,
   *  tryout dates, and downstream team creation. Wizard step 1. */
  ageGroups?: string[];

  /** Per-age-group tryout schedule. Wizard step 3. */
  tryoutDates?: SeasonTryoutDate[];

  /** Forms / waivers required for this season. IDs reference the
   *  `forms` collection. Attached at wizard step 4. */
  formsRequiredIds?: string[];

  /** Broadcasts already sent for this season (tryout email to
   *  current families, social posts, Mailchimp campaign, etc.).
   *  Append-only log so the wizard knows which marketing steps
   *  have been completed. Step 5. */
  broadcastsSent?: SeasonBroadcastRecord[];
}

/** One tryout date entry. A season can have multiple tryouts per
 *  age group (e.g., evaluations on Saturday + a callback on Sunday). */
export interface SeasonTryoutDate {
  id: string;
  ageGroup: string;
  date: Date;
  durationMinutes?: number;
  location?: string;
  notes?: string;
}

/** Audit record of a marketing broadcast — email, social post,
 *  Mailchimp campaign, etc. — sent for a season. */
export interface SeasonBroadcastRecord {
  id: string;
  kind: 'family_email' | 'social_post' | 'mailchimp' | 'other';
  sentAt: Date;
  sentBy: string;
  /** Optional reference to the underlying artifact — e.g., the
   *  campaign ID in Mailchimp, the social post URL, the email
   *  template id. Lets us link out to the source of truth. */
  externalRef?: string;
  /** Recipient count if known. */
  recipientCount?: number;
  /** Short admin-readable summary, e.g. "Tryout dates email · 142 families". */
  summary?: string;
}

/* ───────────────────────── COACH COMMITMENT CYCLE ──────────────────────
 * One doc per coach × season. The admin sends a commitment request
 * (typically before tryouts open); the coach taps Yes / No / Let's
 * talk in the app and the doc updates. The 'lets_talk' status opens a
 * coach-to-admin chat thread automatically. Patrick 2026-06-21:
 * 'current club was a mess to understand which coaches were staying,
 * which were leaving... what makes coaches leave is how they perceive
 * how the club is run.'
 * ───────────────────────────────────────────────────────────────── */
export type CoachCommitmentStatus =
  | 'invited'      // admin sent the ask; coach hasn't responded
  | 'committed'    // coach said yes
  | 'declined'     // coach said no
  | 'lets_talk'    // coach wants to discuss before committing
  | 'cancelled';   // admin rescinded the invitation

export interface CoachCommitment {
  id: string;
  seasonId: string;
  /** uid of the coach being asked. */
  coachUid: string;
  coachName: string;
  /** Age group the admin proposed they coach. Coach can counter with
   *  notes if they want a different group. */
  proposedAgeGroup?: string;
  /** Optional: the team id if a specific team has been pre-assigned.
   *  When undefined, only the age group is committed and team gets
   *  assigned later. */
  proposedTeamId?: string;
  status: CoachCommitmentStatus;
  /** When the invitation was sent. */
  invitedAt: Date;
  /** Who sent it (admin uid). */
  invitedBy: string;
  /** When the coach responded. */
  respondedAt?: Date;
  /** Free-text note from the coach when responding (especially for
   *  'lets_talk' and 'declined'). */
  coachNote?: string;
  /** If 'lets_talk' triggered a chat thread, the threadId is stamped
   *  here so the admin can return to it from the season wizard. */
  conversationThreadId?: string;
}

/** Public registration submission — a parent fills out the /register form
 *  for one of their kids. We create one Registration per kid (so a multi-
 *  kid family fills it out twice OR uses the "add another child" path
 *  that submits N registrations). The Registration is the source of
 *  truth until the player is promoted to a real Player doc post-offer-
 *  acceptance. Until then, status walks through the funnel:
 *
 *    pending_payment → paid → tryout_invited → offer_sent
 *      → accepted (becomes a Player on a team)
 *      OR declined (parent rejected the offer)
 *      OR withdrawn (parent pulled out)
 *
 *  For returning players, `playerId` is set on submit so we can fast-
 *  path the eventual roster move without manual matching. */
export interface Registration {
  id: string;
  clubId: string;
  seasonId: string;
  /** Set ONLY for returning players whose parent registered via a pre-
   *  filled link (?return=PLAYER_ID). null for cold registrations. */
  playerId?: string | null;
  // Player snapshot at registration time. Captures the parent's input,
  // not necessarily authoritative — admin may correct before promotion.
  player: {
    firstName: string;
    lastName: string;
    dateOfBirth: string; // ISO yyyy-mm-dd
    gender: 'male' | 'female' | 'other';
    /** Coach-assignable preferred position. Optional — many kids don't
     *  know at registration time. */
    preferredPosition?: string;
    /** "Has played with Fire FC before" — flags returning players for
     *  the coach pool view. */
    playedBefore: boolean;
    /** Age group the parent selected for this child. We don't auto-
     *  compute from DOB — leagues have wonky cutoff rules and the
     *  admin can correct if needed. */
    ageGroup: string;
    medicalNotes?: string;
    jerseySizeRequested?: string;
  };
  parents: Array<{
    firstName: string;
    lastName: string;
    email: string;
    phone?: string;
    relationship?: 'mother' | 'father' | 'guardian' | 'other';
  }>;
  status: 'pending_payment' | 'paid' | 'tryout_invited' | 'offer_sent' | 'accepted' | 'declined' | 'withdrawn';
  /** Product the parent registered against — the source of truth for
   *  pricing tiers and coupons at checkout time. */
  productId?: string;
  productName?: string;
  /** Pricing snapshot — captured at submit time so a later edit to the
   *  Product doesn't change what this family was quoted. */
  pricingTierId?: string;
  pricingTierLabel?: string;
  registrationFeeCents: number;
  /** Coupon applied at checkout, if any. */
  couponCode?: string;
  couponDiscountCents?: number;
  /** Effective fee actually charged (after coupon + tier resolution). */
  amountPaidCents?: number;
  /** Stripe surcharge (in cents) added on top of amountPaidCents — kept
   *  separate so the club's revenue report doesn't conflate the two. */
  stripeSurchargeCents?: number;
  earlyBirdApplied?: boolean;
  /** Household pointer. Set when admin links this registration's
   *  parent email into a multi-email family. */
  householdId?: string;
  /** Payment plan installments. When set, the registration is paid in
   *  pieces — each installment generates its own Stripe Checkout link
   *  and the Registration as a whole flips to 'paid' only when every
   *  installment is paid or waived. When empty / undefined, the
   *  registration is single-charge (the existing default). */
  installments?: Installment[];
  /** Refunds issued against this registration. Supports partial +
   *  full + multiple refunds (rare but real — partial today, finish
   *  it next week). Each entry mirrors a Stripe Refund object. */
  refunds?: RegistrationRefund[];
  stripeCheckoutSessionId?: string;
  stripePaymentIntentId?: string;
  paidAt?: Date;
  /** When this registration was promoted to a real Player on a team. */
  promotedToPlayerId?: string;
  promotedToTeamId?: string;
  promotedAt?: Date;
  /** Per-coach state — favorites, holds, ratings, notes. Keyed by
   *  coach uid so we don't fan out into a sub-collection. Visibility:
   *  all coaches in the club can see all states — Patrick's call from
   *  the original conversation ("transparency prevents coaches from
   *  poaching candidates blind"). */
  coachStates?: Record<string, RegistrationCoachState>;
  /** Soft "Hold" lock — set on the Registration root, not a coach state.
   *  When set, the candidate is reserved for `heldByUid` for `heldUntil`
   *  days; other coaches see the hold + the holder's name and are
   *  blocked from sending an offer. Holder can release any time. */
  heldByUid?: string;
  heldByName?: string;
  heldUntil?: Date;
  /** Answers to admin-defined custom questions, keyed by question id.
   *  See `RegistrationFormConfig`. Snapshotted question labels live on
   *  `customAnswerLabels` so the admin view doesn't break if the form
   *  config is edited or deleted later. */
  customAnswers?: Record<string, string | number | boolean>;
  customAnswerLabels?: Record<string, string>;
  /** Optional referral / signup source tracking. */
  source?: 'cold' | 'returning' | 'invite' | 'email_blast';
  /** Notes the admin / coach has captured during the tryout / offer
   *  process. Distinct from the activity log — those are auto-events,
   *  these are typed observations. */
  notes?: string;
  createdAt: Date;
  updatedAt?: Date;
}

/** Lightweight task / todo for club admin work. Distinct from
 *  HelpdeskTicket (which is a support/triage ticket from a parent or
 *  coach) — Tasks are admin-side action items: "call this parent,"
 *  "follow up on Photo Consent," "order trophy for U10 banquet."
 *  Optional relatedPlayerId / relatedTeamId lets tasks surface on
 *  player/team views. */
export interface Task {
  id: string;
  clubId: string;
  title: string;
  description?: string;
  status: 'open' | 'in_progress' | 'done';
  priority: 'low' | 'normal' | 'high';
  /** Whom this is about. Surfaces the task on the PersonAdmin /
   *  TeamManagement views. */
  relatedPlayerId?: string;
  relatedPlayerName?: string;
  relatedTeamId?: string;
  /** Whom this is assigned to. Null = unassigned. */
  assigneeUid?: string | null;
  assigneeName?: string;
  /** Optional deadline. UI sorts overdue tasks to the top. */
  dueDate?: Date | null;
  createdBy: string;
  createdByName?: string;
  createdAt: Date;
  updatedAt?: Date;
  completedAt?: Date;
  completedBy?: string;
}

/** Admin-defined waiver / release / consent form. One doc per template
 *  (Player Waiver, Medical Release, Photo Consent, Uniform Order…).
 *  Per-player signed state lives in a separate `form_signatures`
 *  collection keyed by (playerId × formDefinitionId) so we can query
 *  "all unsigned forms for player X" without scanning every form.
 *
 *  Scope optional: leave seasonId/ageGroups empty for forms that apply
 *  club-wide (Photo Consent), set them to restrict (a uniform order
 *  form might be Fall 2026 + U10 only). */
export interface FormDefinition {
  id: string;
  clubId: string;
  name: string;
  /** Short subtitle shown under the name in the checklist. */
  description?: string;
  /** Full terms / body text. Plain text for now — render in a sign
   *  modal so the parent (or admin signing on their behalf) can read
   *  before agreeing. Can grow to a richer doc later. */
  body?: string;
  /** When true, a player can't be marked roster-eligible without it.
   *  We surface required-but-unsigned in red on the checklist. */
  required: boolean;
  isActive: boolean;
  /** Optional scope — empty means applies to every player in the club. */
  seasonId?: string;
  ageGroups?: string[];
  /** Display order in the checklist. Lower = top. */
  order?: number;
  /** Questionnaire mode — when present and non-empty, the parent-facing
   *  fill UI renders these inputs and the submission writes a
   *  form_submissions doc with the answer map. Coexists with `body`:
   *  a form can be questions-only, signature-only, or both. Same
   *  shape as RegistrationQuestion so the existing input renderer +
   *  validation reuses without translation. */
  questions?: RegistrationQuestion[];
  /** When set, every form_submissions doc for this form gets stamped
   *  with linkedEventId so the event detail page can list its signups
   *  in one indexed query. Use case: "Spring Tournament 2026" form
   *  allocates every submitter to the matching event roster. Empty =
   *  the form just collects answers without joining a roster. */
  allocateToEventId?: string;
  createdBy: string;
  createdByName?: string;
  createdAt: Date;
  updatedAt?: Date;
}

/** A parent's answers to a FormDefinition's questionnaire. Doc id is
 *  composed `${playerId}_${formDefinitionId}` so the existing checklist
 *  read pattern reuses (alongside form_signatures for the signature
 *  side). A form can have BOTH — the submission lives here, the
 *  signature lives there, both keyed off the same player+form pair. */
export interface FormSubmission {
  id: string;
  clubId: string;
  playerId: string;
  formDefinitionId: string;
  /** Snapshot of the form's name at submit time. */
  formName: string;
  /** Question id → answer. Numbers stay numbers; yes_no stays the
   *  literal "Yes"/"No" string the question renderer emits. */
  answers: Record<string, string | number | boolean>;
  /** Snapshot of question labels at submit time so a later rename of
   *  the form's questions doesn't muddy the audit. */
  answerLabels: Record<string, string>;
  submittedByName?: string;
  submittedAt: Date;
  /** Where the submission came from. 'family_forms' is the parent
   *  inbox path; 'event_signup' is reserved for the tournament/camp
   *  variant. */
  source?: 'family_forms' | 'event_signup';
  /** Snapshot of the FormDefinition.allocateToEventId at submit time.
   *  Stored on the submission (not derived) so a later edit to the
   *  form's allocation target doesn't retroactively move past
   *  submitters off / onto a different event. Event-detail signup
   *  lists query by this field. */
  linkedEventId?: string;
}

/** Per-player signed state for one FormDefinition. Doc id is composed
 *  `${playerId}_${formDefinitionId}` so we can read a specific form's
 *  state in one getDoc instead of querying. */
export interface FormSignature {
  id: string;
  clubId: string;
  playerId: string;
  formDefinitionId: string;
  /** Snapshot of the form's name at sign time so a later rename
   *  doesn't muddy the audit trail. */
  formName: string;
  /** Who signed. For now any club admin can mark a form signed on
   *  behalf of a parent (typed name captured). When we ship the
   *  parent-facing sign flow, signedByUid is set to the parent's uid
   *  and signedByName is pulled from their user doc. */
  signedByUid?: string;
  signedByName: string;
  /** 'admin' = admin marked it signed on someone's behalf,
   *  'parent' = parent signed via the future parent-facing flow,
   *  'imported' = bulk-uploaded historical signatures. */
  signedBy: 'admin' | 'parent' | 'imported';
  /** Free-form note ("paper waiver on file in office binder"). */
  note?: string;
  signedAt: Date;
}

/** Reusable offer letter template. Coaches pick one in the SendOffer
 *  modal to skip retyping the same message body for every candidate.
 *  Optional teamId + position scope so a Forward template doesn't show
 *  up for a Keeper, and a U10 template doesn't show up for U17. */
export interface OfferTemplate {
  id: string;
  clubId: string;
  name: string;
  /** When set, the template only surfaces for offers from this team. */
  teamId?: string;
  /** When set, only surfaces when the candidate's preferred position
   *  matches. Free-form string match — empty position = always shows. */
  position?: string;
  message: string;
  /** Form definitions (waivers, releases, consents) the family must
   *  sign on the way through accepting an offer that uses this
   *  template. Ids resolve against /form_definitions. Stored on the
   *  template AND snapshotted onto the outgoing OfferLetter so a later
   *  edit to the template doesn't retroactively change what a family
   *  already saw. Empty / missing = no bundled waivers (legacy behavior). */
  requiredWaiverIds?: string[];
  isActive: boolean;
  createdBy: string;
  createdByName?: string;
  createdAt: Date;
  updatedAt?: Date;
}

/** Roster offer a coach extends to a tryout candidate. Each offer is
 *  scoped to ONE team — a candidate offered by two teams gets two
 *  separate Offer docs. The parent receives a unique /offer/<id> link
 *  and accepts or declines from there. Acceptance promotes the
 *  Registration to a real Player on the team. */
export interface OfferLetter {
  id: string;
  clubId: string;
  registrationId: string;
  /** Snapshot so the offer page renders standalone even if the
   *  Registration is later edited. */
  playerName: string;
  parentEmail: string;
  teamId: string;
  teamName: string;
  /** Offering coach. */
  coachUid: string;
  coachName: string;
  /** Composed message body. Plain text (rendered as paragraphs in the
   *  public page). Coach can use a template or freeform. */
  message: string;
  /** What's actually being offered. */
  offerPosition?: string;
  offerJerseyNumber?: number;
  /** Fee owed alongside acceptance, if any. Snapshotted at send time. */
  feeCents?: number;
  /** Optional response deadline. After this, the public page shows
   *  "expired" and rejects accept/decline writes. */
  expiresAt?: Date;
  /** Optional coach welcome video — Cloudflare Stream uid. Rendered
   *  at the top of the public /offer/:id page so the family hears
   *  directly from their would-be coach before deciding. Also
   *  surfaced as a link in the welcome email after acceptance. */
  videoStreamUid?: string;
  videoStreamReady?: boolean;
  /** Snapshot of the offer template's required waivers at send time.
   *  Each is a form definition id whose signature is required before
   *  the family can accept. The offer page renders the signature step
   *  inline AFTER the accept tap, and only flips status → 'accepted'
   *  once every required form has a signature. Empty / missing = no
   *  bundled waivers (legacy offers without this flow). */
  requiredWaiverIds?: string[];
  status: 'sent' | 'accepted' | 'declined' | 'expired' | 'rescinded';
  /** Parent's response. */
  respondedAt?: Date;
  declineReason?: string;
  /** Set when accept flow promoted Registration → Player. */
  promotedToPlayerId?: string;
  promotedAt?: Date;
  createdAt: Date;
  updatedAt?: Date;
}

/** A single coach's read on a tryout candidate. Stored as a map value
 *  on `Registration.coachStates` keyed by uid. Other coaches in the
 *  club can see this — it's a shared scouting sheet, not a private
 *  notebook. */
export interface RegistrationCoachState {
  uid: string;
  coachName: string;
  /** "I want them on my team." Surfaces the candidate in a Favorites
   *  filter for this coach + as a small heart on the row for everyone. */
  favorite?: boolean;
  favoritedAt?: Date;
  /** 1-5 stars. Free-form notes go in `note`. */
  rating?: number;
  /** Short scouting note shown to all coaches. */
  note?: string;
  noteUpdatedAt?: Date;
}

/** Admin-defined extra questions to tack onto the public /register form.
 *  One doc per club per season (id = `${clubId}_${seasonId}`), with an
 *  optional `${clubId}_default` fallback used when no season-specific
 *  doc exists. Answers land on `Registration.customAnswers` keyed by
 *  question id, so renaming a question label later doesn't break old
 *  answers. */
export interface RegistrationFormConfig {
  id: string;
  clubId: string;
  /** When set, this config applies only to the named season. Omit to
   *  treat as the club default (applies whenever no season-specific
   *  config exists). */
  seasonId?: string;
  questions: RegistrationQuestion[];
  updatedAt?: Date;
  updatedBy?: string;
}

export interface RegistrationQuestion {
  id: string;
  /** Parent-facing label. Rename freely — answers reference `id`, not
   *  this string. */
  label: string;
  /** Optional helper text shown under the input. */
  help?: string;
  type: 'text' | 'textarea' | 'select' | 'yes_no' | 'number';
  /** For type === 'select'. */
  options?: string[];
  required?: boolean;
  /** Display order in the form. Lower = higher up. */
  order: number;
  /** If true, the question only renders for returning-player registrations
   *  (parent came in via ?return=). Lets the club ask returning families
   *  different things from cold signups. */
  returningOnly?: boolean;
}

/** Anything chargeable in the club lives as a Product. Registration is
 *  the first one, but the same shape works for tournament entry,
 *  uniform packs, late-payment fees, merch, etc. A product owns its own
 *  tiered pricing schedule (early bird → regular → late) and its own
 *  coupon codes, so a coach can run promo pricing on a tournament
 *  without touching the season-fee product.
 *
 *  Pricing resolution: walk pricingTiers[] in order and pick the first
 *  whose [startsAt, endsAt] window contains "now". If no tier matches,
 *  fall back to the tier marked isDefault — or the first tier overall.
 *  See selectActivePricingTier() in src/utils/pricing.ts. */
export interface Product {
  id: string;
  clubId: string;
  /** Category of charge. Most code only cares about 'registration' for
   *  the public form; the others light up in the admin invoicing UI
   *  (Module 3). */
  type: 'registration' | 'tournament' | 'fee' | 'merch' | 'other';
  name: string;
  description?: string;
  /** Tiered pricing schedule. Order matters — first matching window wins. */
  pricingTiers: PricingTier[];
  /** Coupon codes scoped to this product. Codes are NOT globally unique;
   *  the same "EARLYBIRD" string can exist on multiple products and
   *  each behaves independently. */
  coupons?: Coupon[];
  /** Optional Stripe processing surcharge passed through to the parent
   *  at checkout, in basis points (1.5% = 150). Defaults to 0 (club
   *  absorbs Stripe fees) when unset. Shown as a separate line on the
   *  checkout summary so it doesn't look like opaque price bumping. */
  stripeSurchargeBps?: number;
  /** Free-form metadata. For registration products we set:
   *    seasonId: the Season this enrolls into
   *    ageGroups: ['U10','U11'] — restricts the form to these
   *    teamId: optional, if the product is tied to a single team
   *  Other product types use their own keys. */
  metadata?: Record<string, any>;
  isActive: boolean;
  createdBy: string;
  createdByName?: string;
  createdAt: Date;
  updatedAt?: Date;
  archivedAt?: Date;
}

export interface PricingTier {
  id: string;
  /** Coach-facing label — "Early Bird", "Regular", "Late". Surfaces on
   *  the checkout summary so parents see why they're paying what they
   *  are. */
  label: string;
  priceCents: number;
  /** When this tier becomes active. null = no lower bound (always
   *  active until the next tier's start date or until endsAt). */
  startsAt?: Date | null;
  /** When this tier stops being active. null = no upper bound. */
  endsAt?: Date | null;
  /** Fallback tier used when no date-bounded tier matches "now". Useful
   *  for a permanent "Standard" price with optional promo windows
   *  layered on top. Exactly one tier per product should be default;
   *  selector picks the first if multiple. */
  isDefault?: boolean;
}

export interface Coupon {
  id: string;
  /** Case-insensitive code parents type at checkout. Stored in upper-
   *  case in Firestore — applyCoupon() upper-cases user input before
   *  comparing. */
  code: string;
  /** Either flat amount OR percent off. Percent is integer 0–100. */
  discountCents?: number;
  discountPercent?: number;
  /** Optional cap so a parent of 4 kids can't use the same code 4 times.
   *  null = unlimited. */
  maxUses?: number | null;
  usesCount?: number;
  /** Optional expiry. Coupon is rejected once now > expiresAt. */
  expiresAt?: Date | null;
  /** If false, coupon stops applying without losing the historical
   *  usesCount. Cleaner than deleting. */
  isActive: boolean;
  /** Free-form admin note ("Promo for tournament returning families"). */
  note?: string;
  createdAt?: Date;
  createdBy?: string;
}

/** One installment of a payment plan tied to a Registration. Admins
 *  split a registration's total into N installments (e.g. $300 →
 *  $100 + $100 + $100 with monthly due dates) and each installment
 *  generates its own Stripe Checkout link. The Registration as a
 *  whole flips to 'paid' only when EVERY installment is paid or
 *  waived. */
export interface Installment {
  id: string;
  /** Cents owed on this installment (does NOT include surcharge,
   *  which is computed per-installment at checkout time). */
  amountCents: number;
  /** Coach-facing label — "Deposit", "Spring half", "Final", etc. */
  label: string;
  /** Optional due date. UI sorts unpaid installments by this so the
   *  most urgent floats up. */
  dueDate?: Date;
  status: 'pending' | 'paid' | 'waived';
  paidAt?: Date;
  /** Stripe artifacts written by the worker when this installment's
   *  Checkout Session is created / completes. */
  stripeCheckoutSessionId?: string;
  stripePaymentIntentId?: string;
  /** Admin who waived it + why (when status === 'waived'). */
  waivedBy?: string;
  waivedByName?: string;
  waivedReason?: string;
  waivedAt?: Date;
}

/** One Stripe Refund tied to a Registration. Partial refunds reduce
 *  the effective amount paid; the registration itself doesn't flip
 *  status unless it's a full refund (admin still decides whether the
 *  kid stays on the team). */
export interface RegistrationRefund {
  id: string;
  amountCents: number;
  reason?: string;
  refundedAt: Date;
  refundedByUid?: string;
  refundedByName?: string;
  stripeRefundId: string;
  /** Status reported by Stripe — typically 'succeeded' but a refund
   *  can be 'pending' for bank-transfer payment methods or 'failed'
   *  if the source can't take the credit back. */
  status: 'pending' | 'succeeded' | 'failed' | 'canceled';
}

/** CRM-style activity log entry. Every meaningful system event lands in
 *  the `activities` collection so the admin portal can show a unified
 *  per-family / per-player timeline. Cheap to write (small docs) and
 *  cheap to query (we index by family / player / type). */
export interface Activity {
  id: string;
  clubId: string;
  /** What happened. Add types as the system grows. */
  kind:
    | 'registration_submitted'
    | 'registration_paid'
    | 'tryout_invited'
    | 'offer_sent'
    | 'offer_accepted'
    | 'offer_declined'
    | 'player_promoted'
    | 'email_sent'
    | 'fee_charged'
    | 'coupon_redeemed'
    | 'note_added'
    | 'coach_favorited'
    | 'coach_unfavorited'
    | 'coach_rated'
    | 'coach_noted'
    | 'coach_held'
    | 'coach_released'
    | 'coach_attended'
    | 'coach_unattended'
    | 'form_signed'
    | 'form_unsigned'
    | 'task_created'
    | 'task_assigned'
    | 'task_completed'
    | 'task_reopened'
    | 'registration_refunded'
    | 'installments_split'
    | 'installment_paid'
    | 'installment_waived'
    | 'medical_updated'
    | 'household_linked'
    | 'household_unlinked';
  /** Who/what this is about. Multiple identifiers so we can query from
   *  either side — playerId-centric for player history, parentUid-
   *  centric for family timeline, etc. */
  playerId?: string;
  registrationId?: string;
  parentUid?: string;
  parentEmail?: string;
  teamId?: string;
  seasonId?: string;
  /** Free-form payload (amount, subject line, error text, whatever the
   *  kind needs). Kept loose intentionally — the CRM timeline renders
   *  per-kind so each kind formats its own payload. */
  payload?: Record<string, any>;
  /** Who triggered the action. 'system' for automated events,
   *  uid for human-initiated ones. */
  actorUid?: string;
  actorName?: string;
  createdAt: Date;
}

export interface Invite {
  id: string; // also the URL slug — short, unguessable
  type: 'player' | 'coach' | 'team_manager';
  teamId: string;
  playerId?: string;        // type === 'player'
  role?: 'assistant_coach' | 'head_coach' | 'team_manager'; // type !== 'player'
  /** type === 'player' only: family relationship the inviting coach
   *  picked (Parent / Grandparent / Aunt / Uncle / Guardian / etc).
   *  Stamped onto the joining user's user doc on consume so the
   *  directory can label them correctly. Defaults to 'parent' when
   *  absent for legacy invites. */
  relationship?: FamilyRelationship;
  createdBy: string;
  createdAt: Date;
  expiresAt: Date;
  maxUses: number | null;   // null = unlimited
  usedCount: number;
  usedBy?: string[];        // uids that consumed it
  revokedAt?: Date;
  note?: string;            // optional human label, e.g. "Tournament parents"
}

export interface EmergencyContact {
  name: string;
  relationship: string;
  phoneNumber: string;
  isPrimary: boolean;
}

export interface PlayerStats {
  gamesPlayed: number;
  goals: number;
  assists: number;
  yellowCards: number;
  redCards: number;
  minutesPlayed: number;
  saves?: number;
  cleanSheets?: number;
}

export interface GameStat {
  id: string;
  playerId: string;
  playerName: string;
  gameId: string;
  gameDate: Date;
  opponent: string;
  minutesPlayed: number;
  goals: number;
  assists: number;
  yellowCards: number;
  redCards: number;
  saves?: number;
  keyPlays?: string[];
  recordedBy?: string;
  recordedByName?: string;
  teamId: string;
  createdAt: Date;
  updatedAt?: Date;
}

export interface CalendarEvent {
  id: string;
  title: string;
  description?: string;
  date: Date;
  location: string;
  /** Lat/lon captured at form time from the Nominatim geocoder. When
   *  present, maps deep-links use these directly so Apple/Google Maps
   *  land on the right pin without re-parsing the free-text name. */
  locationCoords?: { lat: number; lon: number };
  /** Full formatted address from the geocoder. `location` stays as the
   *  short user-facing label (e.g. "Little Valley Park") — this is the
   *  full street form (e.g. "2150 S 2350 E, St. George, UT"). */
  locationAddress?: string;
  type: 'game' | 'practice' | 'event';
  /** Optional end time. Older events created before this field don't
   *  have one; treat undefined as "no defined end" in the UI. */
  endDate?: Date;
  teamId: string;
  createdBy: string;
  createdByName?: string;
  opponent?: string;
  homeAway?: 'home' | 'away';
  /** Optional sub-location at the venue — e.g. "Field 7" at a complex
   *  with many fields. Hidden in display when not filled. */
  fieldNumber?: string;
  result?: string;
  // RSVPs: { uid: { status, name, respondedAt, forPlayerId? } }
  rsvps?: Record<string, { status: 'going' | 'maybe' | 'no'; name: string; respondedAt: any; forPlayerName?: string }>;
  // Per-player RSVPs keyed by playerId. A parent (or coach) RSVPs once
  // per kid through this map, in addition to their own personal RSVP
  // in `rsvps`. Coaches need attendance counts that reflect *players*
  // not *adults*, so this is what shows up in the "Going" count for
  // games and practices.
  playerRsvps?: Record<string, {
    status: 'going' | 'maybe' | 'no';
    playerName: string;
    byUid: string;
    byName?: string;
    respondedAt: any;
  }>;
  // Guest RSVPs from the public share link, keyed by a per-browser token. Kept
  // separate from `rsvps` so authenticated team-member RSVPs aren't overwritten.
  publicRsvps?: Record<string, { status: 'going' | 'maybe' | 'no'; name: string; respondedAt: any; isCoach?: boolean }>;
  /** Arrive-by offset in minutes before the event start. e.g. 30 means
   *  "arrive 30 min early". Stored as an offset (not absolute) so it
   *  automatically shifts if the event itself is rescheduled. Useful
   *  for games (warmups) and tournaments (check-in). */
  arriveOffsetMinutes?: number;
  /** Coach-defined packing checklist. Each parent gets their own
   *  per-user checkmark state via packingCheckedBy keyed by uid. */
  packingList?: Array<{
    id: string;
    label: string;
  }>;
  /** Per-parent checkmark state for the packing list. Keyed by uid
   *  → set of item ids the parent has ticked off. */
  packingCheckedBy?: Record<string, string[]>;
  // Carpool board: parents post offers ("driving 2 seats from west") or requests ("need ride from south")
  carpoolPosts?: Array<{
    id: string;
    uid: string;
    name: string;
    type: 'offer' | 'request';
    seats?: number;
    location?: string;
    note?: string;
    createdAt: any;
  }>;
  createdAt: Date;
  updatedAt?: Date;
  // Cancellation. Soft-delete pattern: cancelled events stay on the
  // calendar with a CANCELLED badge so attendees see why nothing's
  // happening, instead of the event silently disappearing. Coaches
  // can restore by flipping the flag.
  isCancelled?: boolean;
  cancelledAt?: Date;
  cancelledBy?: string;
  cancelReason?: string;
  // Snack rotation — one player's family brings snacks for the team.
  // assignedByName is denorm'd so the UI doesn't have to fan out
  // user lookups just to render the assignment line.
  snackAssignment?: {
    playerId: string;
    playerName: string;
    notes?: string;
    assignedAt: any;
    assignedBy: string;
    assignedByName?: string;
  };
  // Recurring series — when set, this event is part of a generated series.
  seriesId?: string;
  recurrence?: 'none' | 'daily' | 'weekly' | 'biweekly' | 'monthly';
  recurrenceUntil?: Date;
}

export interface GalleryPhoto {
  id: string;
  url: string;
  title?: string;
  description?: string;
  caption?: string;
  uploadedBy: string;
  uploadedByName: string;
  teamId: string;
  tags?: string[];
  eventId?: string;
  fileSize: number;
  fileName: string;
  contentType: string;
  createdAt: Date;
  updatedAt?: Date;
}

export interface Photo {
  id: string;
  url: string;
  title?: string;
  description?: string;
  caption?: string;
  uploadedBy: string;
  uploadedByName: string;
  teamId: string;
  tags?: string[];
  createdAt: Date;
}

export type GameFormat = '7v7' | '9v9' | '11v11';

export interface Team {
  id: string;
  name: string;
  description?: string;
  logoUrl?: string;
  coachIds: string[];
  headCoachId?: string;
  assistantCoachIds?: string[];
  playerIds: string[];
  parentIds: string[];
  season: string;
  ageGroup: string;
  league?: string;
  homeField?: string;
  /** Standard match format — used to size the field + decide how many
   *  players auto-place into the lineup. Defaults to '7v7' if unset. */
  format?: GameFormat;
  /** Soft-archive flag. When false, the team is hidden from active
   *  team selectors but all data (events, clips, stats, threads, etc.)
   *  remains queryable for parents/players to view past content. */
  isActive?: boolean;
  archivedAt?: Date;
  /** Team-activation funnel — five stages tracking the path from
   *  tryouts to season-ready. Same shape as Player.funnelProgress, with
   *  Team-specific stage keys. Some stages auto-fill from existing data
   *  (team_selected once headCoachId + playerIds, all_registered when
   *  every player has registration + waivers, coaches_certified once
   *  each coach has all four required cert kinds). The bookend stages
   *  (tryouts and activated) are manual admin stamps. See
   *  TeamFunnelStepper.tsx for the canonical stage list + UI. */
  funnelProgress?: TeamFunnelProgress;
  /** Parent UIDs the coach has granted media-upload access to. Staff
   *  (coach / team manager) can always upload; this opens the door for
   *  specific parents (e.g. tracking-cam operators) without making
   *  uploads free-for-all. */
  mediaUploaders?: string[];
  /** Saved locations the team uses repeatedly — home field, away venues,
   *  practice site. Shown on top of the event-location picker so coaches
   *  don't retype the same address every week. */
  favoriteLocations?: Array<{
    name: string;
    address?: string;
    lat?: number;
    lon?: number;
    savedAt?: Date;
  }>;
  createdAt: Date;
  updatedAt?: Date;
}

export interface Game {
  id: string;
  teamId: string;
  opponent: string;
  date: Date;
  location: string;
  homeAway: 'home' | 'away';
  result?: {
    teamScore: number;
    opponentScore: number;
    status: 'scheduled' | 'in_progress' | 'completed' | 'cancelled';
  };
  stats?: GameStat[];
  createdAt: Date;
  updatedAt?: Date;
}

// ================================
// WALL POSTS — separate collection from chat. The Wall is its own
// surface (formatted markdown, headings, pinned posts, likes) so it
// does not piggyback on chat anymore. Old pinned chat messages are
// no longer surfaced on the wall; only docs in `wall_posts` are.
// ================================

export interface WallPost {
  id: string;
  teamId: string;
  /** Markdown source. Rendered by the Wall's RichContent component. */
  content: string;
  senderId: string;
  senderName: string;
  /** Avatar snapshotted at post / edit time (matches the chat
   *  pattern). Falls back to senderName initial if absent. */
  senderPhotoUrl?: string | null;
  senderRole?: 'coach' | 'parent' | 'admin';
  timestamp: Date;
  /** Set when a post is edited — surface as "(edited)" beside the
   *  timestamp so parents know the author updated it. */
  editedAt?: number | null;
  attachments?: Array<{ url: string; name?: string; type?: string }>;
  reactions?: Array<{ emoji: string; userId: string; userName?: string }>;
  /** Number stored when pinned to top (Date.now() at pin time). Null
   *  or absent = not pinned. Most-recently-pinned sorts first. */
  wallPinnedTop?: number | null;
  /** Provenance — was this a manual coach post, or auto-posted from a
   *  game schedule / video upload / milestone? Drives small UI tags
   *  on the post. */
  postedFrom?: 'wall' | 'game' | 'video' | 'potm' | 'devplan' | 'juggle';
  /** When true, the post is readable at /wall/p/{id} without auth so
   *  the coach can share it as a mini-site link. Default false. */
  isPublic?: boolean;
  /** Optional category tag — drives the wall's pill filter. New posts
   *  default to 'announcement' if not set. Older posts predate the
   *  field and fall through to 'announcement' on read. */
  category?: 'announcement' | 'result' | 'spotlight' | 'practice' | 'system';
  /** Optional inline poll. Parents tap an option to vote; coaches /
   *  admins can open a per-option voter list. Single-choice by default
   *  (multi: false) — voting on a different option moves your vote.
   *  voters[] stores uids, so coaches can see exactly who picked what. */
  poll?: {
    question: string;
    options: Array<{ id: string; text: string; voters: string[] }>;
    multi?: boolean;
  };
}

export interface WallComment {
  id: string;
  postId: string;
  teamId: string;
  content: string;
  senderId: string;
  senderName: string;
  senderPhotoUrl?: string | null;
  timestamp: Date;
}

// ================================
// CHAT SYSTEM INTERFACES
// ================================

export interface ChatMessage {
  id: string;
  threadId: string;
  content: string;
  senderId: string;
  senderName: string;
  /** Snapshot of the sender's avatar at send time. Snapshotting (rather
   *  than looking up live) keeps the chat fast — no per-message user
   *  fetch — and means avatars don't retroactively change if someone
   *  swaps their photo later. */
  senderPhotoUrl?: string;
  senderRole: 'coach' | 'parent';
  timestamp: Date;
  teamId: string;
  edited?: boolean;
  editedAt?: Date;
  replyTo?: string; // ID of message being replied to
  attachments?: {
    type: 'image' | 'file';
    url: string;
    name: string;
    size: number;
  }[];
  reactions?: {
    emoji: string;
    userId: string;
    userName: string;
  }[];
  /** Optional inline poll — when set, the message renders as a poll card
   *  instead of (or alongside) a text bubble. Each option carries the
   *  list of user IDs who voted for it. */
  poll?: {
    question: string;
    options: { id: string; text: string; voters: string[] }[];
    /** If true, voters can pick more than one option. */
    multi?: boolean;
    closedAt?: Date | null;
  };
  /** When true, the message renders as an important announcement and
   *  requires recipients to actively tap "I see this" to acknowledge.
   *  Coaches see a roster of who has / hasn't acknowledged. */
  requireAck?: boolean;
  /** User IDs who have explicitly acknowledged the message. */
  acknowledgedBy?: string[];
  /** Read receipts. Map of uid → epoch-ms when the message first
   *  appeared in their conversation view. Older messages predate this
   *  field; absence ≠ unread. */
  readBy?: Record<string, number>;
  isRead?: boolean;
  createdAt: Date;
  updatedAt?: Date;
}

export type ChatScope = 'team' | 'club' | 'coaches' | 'admins';

export interface ChatThread {
  id: string;
  title: string;
  description?: string;
  teamId: string;
  /** Visibility scope:
   *   - 'team' (default): only members of teamId can see + post.
   *   - 'club': everyone in the club. teamId is irrelevant.
   *   - 'coaches': coaches + team_managers across the entire club.
   *   - 'admins': club admins only.
   *  Created by club admins for the non-team scopes. */
  scope?: ChatScope;
  createdBy: string;
  createdByName: string;
  createdAt: Date;
  lastActivity: Date;
  isPinned: boolean;
  isPrivate: boolean; // For coach-only threads
  isDM?: boolean; // Direct message between two users
  dmParticipantNames?: { [uid: string]: string }; // For displaying the "other" person in DMs
  isArchived?: boolean;
  messageCount: number;
  participants: string[]; // User IDs
  tags?: string[];
  /** IDs of pinned messages within this thread — shown in a strip at
   *  the top of the chat view. Order is preserved (most-recently
   *  pinned first). */
  pinnedMessageIds?: string[];
  color?: string; // For thread color coding
  lastMessage?: {
    content: string;
    senderName: string;
    /** Sender uid — added in 2.0. Lets the unread-thread check
     *  short-circuit when the current user is the sender (you can't
     *  be unread on your own message). Optional for backwards
     *  compatibility with older threads written before this field. */
    senderId?: string;
    timestamp: Date;
  };
  unreadCount?: { [userId: string]: number }; // Unread count per user
  updatedAt?: Date;
}

export interface ChatNotification {
  id: string;
  userId: string;
  threadId: string;
  messageId: string;
  type: 'new_message' | 'thread_mention' | 'direct_reply';
  isRead: boolean;
  createdAt: Date;
  teamId: string;
}

// ================================
// INDIVIDUAL DEVELOPMENT PLAN (IDP)
// ================================

export interface DevelopmentPlan {
  id: string;
  playerId: string;
  playerName: string;
  teamId: string;
  title: string;
  description?: string;
  category: 'technical' | 'tactical' | 'physical' | 'mental';
  goals: DevelopmentGoal[];
  status: 'active' | 'completed' | 'archived';
  createdBy: string;
  createdByName: string;
  createdAt: Date;
  updatedAt?: Date;
  completedAt?: Date;
  /** Parent ↔ coach conversation about the plan. Questions, status
   *  updates, "we tried this and Hayden hated it," coach replies, etc.
   *  Different from per-goal practiceLog (which is just dated check-
   *  ins). Each comment fires a push to the OTHER party. */
  comments?: PlanComment[];
}

export interface PlanComment {
  id: string;
  authorUid: string;
  authorName: string;
  authorRole?: 'coach' | 'parent' | 'team_manager' | 'player';
  text: string;
  createdAt: Date;
}

export interface VideoLink {
  id: string;
  url: string;          // original URL (YouTube watch / share / shorts / etc.)
  youtubeId?: string;   // extracted ID if YouTube
  title?: string;       // optional coach label
  addedBy?: string;
  addedByName?: string;
  addedAt?: Date;
}

// Reusable drill template. Lives in the `drills` collection. When a
// coach assigns a drill to a player's plan, the drill's content is
// COPIED into a DevelopmentGoal on that plan (so edits to the template
// later don't disturb in-flight plans, and per-player notes/practice
// logs accumulate on the goal, not the drill).
export interface Drill {
  id: string;
  /** Which club / team library this drill belongs to. clubId is set if
   *  the drill is shared across the whole club; teamId is set if it's
   *  scoped to a single team's coaches. One of the two is required. */
  clubId?: string;
  teamId?: string;
  title: string;
  /** Coach-friendly topic — drives library filters + the AI generator's
   *  category hint. */
  topic: 'dribbling' | 'passing' | 'shooting' | 'first-touch' | 'defending' | 'goalkeeping' | 'fitness' | 'agility' | 'tactical' | 'other';
  category: 'technical' | 'tactical' | 'physical' | 'mental';
  description?: string;
  setup?: string;
  instructions?: string;
  focus?: string;
  /** Suggested practice minutes per session. */
  durationMinutes?: number;
  /** Age-band the drill is appropriate for. Used so a U10 coach doesn't
   *  see drills meant for U17. */
  ageBand?: 'U6-U8' | 'U9-U10' | 'U11-U12' | 'U13-U14' | 'U15-U17' | 'all';
  videoLinks?: VideoLink[];
  /** Cloudflare Stream uid for coach-uploaded reference video (e.g.,
   *  TikTok downloaded + re-uploaded). Distinct from videoLinks which
   *  are external (YouTube). */
  streamUid?: string;
  streamReady?: boolean;
  /** How the drill landed in the library — 'manual' (typed), 'ai'
   *  (Claude generated, then reviewed), 'imported' (future: shared
   *  drill catalogs across clubs). */
  source: 'manual' | 'ai' | 'imported';
  /** Optional copy of the prompt used when the drill was AI-generated.
   *  Lets coaches re-run with tweaks ("same drill but for U13"). */
  aiPrompt?: string;
  createdBy: string;
  createdByName: string;
  createdAt: Date;
  updatedAt?: Date;
  /** Usage counter — bumps every time the drill is assigned to a plan.
   *  Surfaces "most-used" in the library so the workhorse drills bubble
   *  up. */
  assignmentCount?: number;
  isActive: boolean;
}

export interface DevelopmentGoal {
  id: string;
  title: string;
  description?: string; // Legacy / general note
  duration?: string; // e.g. "10–15 min"
  setup?: string; // What to set up before drilling
  instructions?: string; // Step-by-step what to do
  focus?: string; // Key coaching point
  targetMinutes?: number; // Optional practice-minutes target for this goal
  videoLinks?: VideoLink[]; // YouTube tutorials / reference clips
  /** Cloudflare Stream uid for a coach-uploaded reference video
   *  (typically copied in from a drill template at import time —
   *  the original TikTok-style upload). Plays via iframe in the
   *  goal detail. */
  streamUid?: string;
  streamReady?: boolean;
  playerCompleted: boolean; // Player/parent checks this off
  playerCompletedAt?: Date;
  readyForReview: boolean; // Player signals coach to check at training
  readyForReviewAt?: Date;
  coachVerified: boolean; // Coach officially passes them
  coachVerifiedAt?: Date;
  coachVerifiedBy?: string;
  coachVerifiedByName?: string;
  notes?: string; // Coach feedback
  practiceLog?: PracticeLogEntry[]; // Home practice tracking
  order: number;
}

export interface PracticeLogEntry {
  id: string;
  date: Date;
  note: string;
  minutes?: number;
  loggedBy: string;
  loggedByName: string;
}

// ================================
// PLAYER MEDIA (Per-Player Gallery)
// ================================

export interface PlayerMedia {
  id: string;
  playerId: string;
  playerName: string;
  teamId: string;
  url: string;
  /** Source of the media — null/'upload' for things we hosted on R2 /
   *  Cloudflare Stream, 'youtube' / 'trace' for externally-hosted links
   *  that we render via an iframe embed. */
  source?: 'upload' | 'youtube' | 'trace' | 'other';
  /** Canonical embed URL — for YouTube that's youtube.com/embed/<id>,
   *  for Trace it's the original share URL (Trace iframes its own
   *  player). null for native uploads. */
  embedUrl?: string;
  thumbnailUrl?: string;
  // When set, this clip is hosted on Cloudflare Stream (adaptive bitrate HLS).
  // The legacy `url` may still point at the original R2 MP4 for backwards
  // compatibility; players prefer Stream when present.
  streamUid?: string;
  streamReady?: boolean;
  // Override Stream's default thumbnail timestamp (Stream defaults to t=0
  // which often lands on a fade-in/transition frame). Stored in seconds.
  posterTimeSeconds?: number;
  type: 'photo' | 'video';
  caption?: string;
  uploadedBy: string;
  uploadedByName: string;
  fileSize: number;
  fileName: string;
  contentType: string;
  tags?: string[];
  taggedPlayerIds?: string[];
  // Stats credits (only meaningful when tags includes 'Goal')
  goalScorerId?: string;       // who scored the goal
  assistByIds?: string[];      // who assisted (max 2 typical)
  statsCredited?: boolean;     // true if this clip has bumped player stats
  // Marks the clip as documenting an opponent own goal: team scored, but no
  // player on our roster gets the goal credit. Assists may still be awarded
  // (e.g. the kicker who forced the deflection).
  isOwnGoal?: boolean;
  // Optional link to a calendar event / live_games doc. When set, credits on
  // this clip are deduped against the live game timeline so coach-tap +
  // clip-credit don't double-count season stats.
  gameId?: string;
  likes?: string[];       // array of user UIDs who liked
  likeCount?: number;
  views?: string[];       // array of unique user UIDs who have viewed
  viewCount?: number;
  downloads?: string[];   // array of user UIDs who downloaded
  downloadCount?: number; // total download taps (counts repeats)
  shares?: string[];      // array of user UIDs who shared
  shareCount?: number;    // total share taps (counts repeats)
  createdAt: Date;
  updatedAt?: Date;
}

// ================================
// FULL GAME (YouTube Links)
// ================================

export interface FullGame {
  id: string;
  teamId: string;
  title: string;
  opponent?: string;
  gameDate: Date;
  // Either a YouTube link OR a self-hosted video on R2.
  youtubeUrl?: string;
  youtubeId?: string;
  videoUrl?: string;          // direct R2 URL for self-hosted MP4
  videoKey?: string;          // R2 object key
  videoFileName?: string;
  videoSize?: number;
  videoContentType?: string;
  source?: 'youtube' | 'r2' | 'stream';  // discriminator; defaults inferred from fields
  // Cloudflare Stream UID — preferred over videoUrl for new uploads.
  streamUid?: string;
  streamReady?: boolean;
  // Override Stream's default thumbnail timestamp (defaults to t=0). Seconds.
  posterTimeSeconds?: number;
  result?: string;          // e.g. "W 3-1", "L 2-4", "T 1-1"
  notes?: string;
  addedBy: string;
  addedByName: string;
  createdAt: Date;
  updatedAt?: Date;
}

// ================================
// SURVEY SYSTEM
// ================================

export type SurveyQuestionType = 'rating' | 'text' | 'multiple_choice' | 'yes_no';

export interface SurveyQuestion {
  id: string;
  type: SurveyQuestionType;
  text: string;
  required: boolean;
  options?: string[]; // For multiple_choice
  maxRating?: number; // For rating (default 5)
  order: number;
}

export interface Survey {
  id: string;
  title: string;
  description?: string;
  teamId: string;
  questions: SurveyQuestion[];
  isActive: boolean;
  isAnonymous: boolean;
  resultsPublic: boolean;
  createdBy: string;
  createdByName: string;
  responseCount: number;
  createdAt: Date;
  updatedAt?: Date;
  closedAt?: Date;
}

export interface SurveyResponse {
  id: string;
  surveyId: string;
  respondentName?: string; // Only if not anonymous
  respondentToken: string; // For duplicate prevention
  answers: SurveyAnswer[];
  submittedAt: Date;
}

export interface SurveyAnswer {
  questionId: string;
  value: string | number; // text/choice → string, rating/yes_no → number
}

// ================================
// COACH INVITE
// ================================

export interface CoachInvite {
  id: string;
  teamId: string;
  teamName: string;
  email?: string;
  inviteCode?: string;
  coachLevel: 'head_coach' | 'assistant_coach';
  invitedBy: string;
  invitedByName: string;
  status: 'pending' | 'accepted' | 'declined';
  createdAt: Date;
  acceptedAt?: Date;
}

// ================================
// UTILITY TYPES FOR FORM HANDLING
// ================================

export type CreatePlayerData = Omit<Player, 'id' | 'createdAt' | 'updatedAt'> & {
  isActive: boolean;
  updatedAt?: Date;
};

export type UpdatePlayerData = Partial<Omit<Player, 'id' | 'createdAt'>> & {
  updatedAt?: Date;
};

export type CreateUserData = Omit<User, 'uid' | 'createdAt' | 'updatedAt'> & {
  createdAt: Date;
  updatedAt?: Date;
};

// Chat utility types
export type CreateChatThreadData = Omit<ChatThread, 'id' | 'createdAt' | 'updatedAt' | 'lastActivity' | 'messageCount'> & {
  participants?: string[];
};

export type CreateChatMessageData = Omit<ChatMessage, 'id' | 'createdAt' | 'updatedAt'> & {
  timestamp?: Date;
};

export type UpdateChatThreadData = Partial<Omit<ChatThread, 'id' | 'createdAt' | 'teamId' | 'createdBy'>> & {
  updatedAt?: Date;
};

// ================================
// FIRESTORE COLLECTION REFERENCES
// ================================

// Use these constants for consistent collection naming
export const COLLECTIONS = {
  USERS: 'users',
  PLAYERS: 'players',
  TEAMS: 'teams',
  GAMES: 'games',
  GAME_STATS: 'stats',
  NEWS: 'news',
  CALENDAR_EVENTS: 'events',
  GALLERY_PHOTOS: 'gallery',
  CHAT_THREADS: 'chat_threads',
  CHAT_MESSAGES: 'chat_messages',
  CHAT_NOTIFICATIONS: 'chat_notifications',
  ATTENDANCE_EVENTS: 'attendance_events',
  VOLUNTEER_OPPORTUNITIES: 'volunteer_opportunities',
  MATCH_VOTINGS: 'match_votings',
  DEVELOPMENT_PLANS: 'development_plans',
  PLAYER_MEDIA: 'player_media',
  COACH_INVITES: 'coach_invites'
} as const;

// ================================
// FIRESTORE SECURITY RULES REFERENCE
// ================================

/*
Complete Firestore Security Rules:

rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    
    // Helper function to get user data
    function getUserData() {
      return get(/databases/$(database)/documents/users/$(request.auth.uid)).data;
    }
    
    // Helper function to check if user is on the team
    function isTeamMember(teamId) {
      return request.auth != null && getUserData().teamId == teamId;
    }
    
    // Helper function to check if user is a coach
    function isCoach() {
      return request.auth != null && getUserData().role == 'coach';
    }
    
    // Users collection
    match /users/{userId} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }
    
    // Players collection
    match /players/{playerId} {
      allow read, write: if isTeamMember(resource.data.teamId);
    }
    
    // Teams collection
    match /teams/{teamId} {
      allow read: if isTeamMember(teamId);
      allow write: if isTeamMember(teamId) && isCoach();
    }
    
    // News collection
    match /news/{newsId} {
      allow read: if isTeamMember(resource.data.teamId);
      allow write: if isTeamMember(resource.data.teamId) && isCoach();
    }
    
    // Calendar events
    match /events/{eventId} {
      allow read: if isTeamMember(resource.data.teamId);
      allow write: if isTeamMember(resource.data.teamId) && isCoach();
    }
    
    // Gallery photos
    match /gallery/{photoId} {
      allow read: if isTeamMember(resource.data.teamId);
      allow write: if isTeamMember(resource.data.teamId);
    }
    
    // Chat Threads
    match /chat_threads/{threadId} {
      allow read: if isTeamMember(resource.data.teamId) 
        && (resource.data.isPrivate == false || isCoach());
      
      allow create: if isTeamMember(request.resource.data.teamId)
        && request.auth.uid == request.resource.data.createdBy;
      
      allow update: if isTeamMember(resource.data.teamId)
        && (
          // Anyone can update lastActivity, messageCount, participants
          request.resource.data.diff(resource.data).affectedKeys().hasOnly(['lastActivity', 'messageCount', 'participants', 'lastMessage', 'unreadCount', 'updatedAt'])
          // Only coaches can pin/unpin or change privacy
          || (isCoach() && request.resource.data.diff(resource.data).affectedKeys().hasOnly(['isPinned', 'isPrivate', 'updatedAt']))
        );
      
      allow delete: if isTeamMember(resource.data.teamId) && isCoach();
    }
    
    // Chat Messages
    match /chat_messages/{messageId} {
      allow read: if isTeamMember(resource.data.teamId);
      
      allow create: if isTeamMember(request.resource.data.teamId)
        && request.auth.uid == request.resource.data.senderId;
      
      allow update: if isTeamMember(resource.data.teamId)
        && request.auth.uid == resource.data.senderId
        && request.resource.data.diff(resource.data).affectedKeys().hasOnly(['content', 'edited', 'editedAt', 'updatedAt']);
      
      allow delete: if isTeamMember(resource.data.teamId) 
        && (request.auth.uid == resource.data.senderId || isCoach());
    }
    
    // Chat Notifications
    match /chat_notifications/{notificationId} {
      allow read, write: if request.auth != null 
        && resource.data.userId == request.auth.uid
        && isTeamMember(resource.data.teamId);
    }
    
    // Game stats
    match /stats/{statId} {
      allow read: if isTeamMember(resource.data.teamId);
      allow write: if isTeamMember(resource.data.teamId) && isCoach();
    }
    
    // Attendance events
    match /attendance_events/{eventId} {
      allow read, write: if isTeamMember(resource.data.teamId);
    }
    
    // Volunteer opportunities
    match /volunteer_opportunities/{opportunityId} {
      allow read, write: if isTeamMember(resource.data.teamId);
    }
    
    // Match votings (Player of the Match)
    match /match_votings/{votingId} {
      allow read, write: if isTeamMember(resource.data.teamId);
    }
  }
}
*/

// ================================
// FIRESTORE INDEXES NEEDED
// ================================

/*
Required Composite Indexes:

1. Collection: chat_threads
   Fields: teamId (Ascending), isPinned (Descending), lastActivity (Descending)

2. Collection: chat_messages  
   Fields: threadId (Ascending), timestamp (Ascending)

3. Collection: chat_notifications
   Fields: userId (Ascending), isRead (Ascending), createdAt (Descending)

4. Collection: players
   Fields: teamId (Ascending), isActive (Ascending), jerseyNumber (Ascending)

5. Collection: news
   Fields: teamId (Ascending), isPublished (Ascending), createdAt (Descending)

6. Collection: events
   Fields: teamId (Ascending), date (Ascending)

7. Collection: gallery
   Fields: teamId (Ascending), createdAt (Descending)

8. Collection: stats
   Fields: teamId (Ascending), createdAt (Descending)
*/