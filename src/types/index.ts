export interface User {
  uid: string;
  id?: string;
  email: string;
  name: string;
  role: 'coach' | 'parent';
  teamId: string;
  teamIds?: string[]; // All teams this user belongs to
  coachLevel?: 'head_coach' | 'assistant_coach'; // For coaches only
  approved?: boolean;
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
  role: 'coach' | 'parent';
  teamId: string;
  teamIds?: string[]; // All teams this user belongs to
  coachLevel?: 'head_coach' | 'assistant_coach';
  approved?: boolean;
  createdAt: Date;
  phoneNumber?: string;
  address?: string;
  emergencyContact?: string;
  emergencyPhone?: string;
  privacy?: {
    showPhone: boolean;
    showEmail: boolean;
    showAddress: boolean;
  };
}

export interface Player {
  id: string;
  name: string;
  jerseyNumber?: number;
  position?: string;
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
  stats?: PlayerStats;
  createdAt: Date;
  updatedAt?: Date;
  inviteCode?: string;
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
  createdAt: Date;
  updatedAt?: Date;
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
  isRead?: boolean;
  createdAt: Date;
  updatedAt?: Date;
}

export interface ChatThread {
  id: string;
  title: string;
  description?: string;
  teamId: string;
  createdBy: string;
  createdByName: string;
  createdAt: Date;
  lastActivity: Date;
  isPinned: boolean;
  isPrivate: boolean; // For coach-only threads
  isArchived?: boolean;
  messageCount: number;
  participants: string[]; // User IDs
  tags?: string[];
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
  description?: string;
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
  likes?: string[];       // array of user UIDs who liked
  likeCount?: number;
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
  source?: 'youtube' | 'r2';  // discriminator; defaults inferred from fields
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