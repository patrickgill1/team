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
}

export interface SeasonMembership {
  seasonId: string;
  teamId: string;
  jerseyNumber?: number;
  position?: string;
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

export interface News {
  id: string;
  title: string;
  content: string;
  summary?: string;
  authorId: string;
  authorName: string;
  teamId: string;
  imageUrl?: string;
  tags?: string[];
  isPinned: boolean;
  isPublished: boolean;
  publishedAt?: Date;
  createdAt: Date;
  updatedAt?: Date;
}

export interface CalendarEvent {
  id: string;
  title: string;
  description?: string;
  date: Date;
  location: string;
  type: 'game' | 'practice' | 'event';
  teamId: string;
  createdBy: string;
  createdByName?: string;
  opponent?: string;
  homeAway?: 'home' | 'away';
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