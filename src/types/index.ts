export type UserRole = 'coach' | 'parent' | 'team_manager';
export type ApprovalStatus = 'auto' | 'pending' | 'approved' | 'rejected';

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
  /** USSF Grassroots referee modules separate from coaching licenses. */
  kind: 'coach' | 'referee' | 'goalkeeper';
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
  stats?: PlayerStats; // legacy aggregate, retained during transition
  statsBySeasonId?: Record<string, PlayerStats>;
  statsLifetime?: PlayerStats; // optional cache, sum of statsBySeasonId
  seasonMemberships?: SeasonMembership[];
  createdAt: Date;
  updatedAt?: Date;
  inviteCode?: string;
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
  /** Issued team gear for the current season — sizes + return status.
   *  Single record per player at a time; a coach manually clears it
   *  ("Reset for next season") between seasons. We don't archive
   *  history yet — uncommon ask, can add an `equipmentHistory` array
   *  if it ever comes up. */
  equipment?: PlayerEquipment;
}

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
}

export interface Invite {
  id: string; // also the URL slug — short, unguessable
  type: 'player' | 'coach' | 'team_manager';
  teamId: string;
  playerId?: string;        // type === 'player'
  role?: 'assistant_coach' | 'head_coach' | 'team_manager'; // type !== 'player'
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