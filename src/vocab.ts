/**
 * GoalKickr vocabulary — Patrick's swagger lexicon.
 *
 * Every customer-facing string in the app should source its label
 * from here, so a future term shift is one diff instead of a 300-
 * file sweep. Backed by the feedback_vocab_swagger memory; keep the
 * two in sync.
 *
 * USE THIS:        <h1>{VOCAB.dashboard}</h1>
 * NEVER THIS:      <h1>Dashboard</h1>
 *
 * Add new keys as you encounter them in a migration sweep. When a
 * term isn't yet codified, default to the soccer-native swagger
 * version (Squad over Roster, Match Center over Game Details), then
 * add it here so it's reusable.
 *
 * Voice rules baked in:
 *   - No "branded", no "the system", no "the platform"
 *   - Imperative verbs ("Drop in players", not "You can add players")
 *   - No em dashes, no emojis
 *   - Soccer-native nouns (Squad, kit, fixture, kickoff)
 */

export const VOCAB = {
  // ── Surfaces (page titles, nav labels) ───────────────────────
  dashboard:        'Team HQ',
  teamHq:           'Team HQ',
  wall:             'Team Wall',
  trainingGround:   'Training Ground',
  matchCenter:      'Match Center',
  playerCard:       'Player Card',
  playerCards:      'Player Cards',
  extraReps:        'Solo',
  playerPathway:    'Player Pathway',
  coachClipboard:   "Coach's Clipboard",
  squadBuilder:     'Squad Builder',
  teamPulse:        'Team Pulse',
  formCheck:        'Form Check',
  readyList:        'Ready List',
  sidelineChat:     'Sideline Chat',
  trophyCase:       'Trophy Case',
  streaks:          'Streaks',
  spotlight:        'Spotlight',

  // ── Roster / players ──────────────────────────────────────────
  squad:            'Squad',
  buildSquad:       'Build Your Squad',
  addToSquad:       'Add to Squad',
  squadList:        'Squad List',
  manageSquad:      'Manage the Squad',
  bringPlayersIn:   'Bring Players In',
  dropFromSquad:    'Drop from Squad',
  removeFromSquad:  'Remove from Squad',
  playerSnapshot:   'Player Snapshot',
  theSquad:         'The Squad',
  playerCircle:     'Player Circle',  // guardians / parents linked to a player

  // ── Team setup ────────────────────────────────────────────────
  startATeam:       'Start a Team',
  buildClubhouse:   'Build Your Clubhouse',
  nameSquad:        'Name Your Squad',
  addToCoachStaff:  'Add to Coaching Staff',
  commandCenter:    'Command Center',
  launchSeason:     'Launch the Season',
  retireSeason:     'Retire the Season',

  // ── Training / development ────────────────────────────────────
  buildSession:     'Build a Session',
  trainingSession:  'Training Session',
  addDrill:         'Add a Drill',
  playerDev:        'Player Development',
  setChallenge:     'Set a Challenge',
  markItDone:       'Mark It Done',
  growthPlan:       'Growth Plan',
  whoShowedUp:      'Who Showed Up',

  // ── Games / matches ──────────────────────────────────────────
  matchSchedule:    'Match Schedule',
  addMatch:         'Add Match',
  nextMatch:        'Next Match',
  startingXI:       'Starting XI',
  impactPlayers:    'Impact Players',
  rotations:        'Rotations',
  matchNotes:       'Match Notes',
  matchResult:      'Match Result',

  // ── Comms ────────────────────────────────────────────────────
  sendTeamUpdate:   'Send Team Update',
  teamDrop:         'Team Drop',
  postToWall:       'Post to Team Wall',
  teamReactions:    'Team Reactions',
  teamVote:         'Team Vote',
  familyUpdate:     'Family Update',
  coachNote:        "Coach's Note",

  // ── Attendance / availability ────────────────────────────────
  checkIn:          'Check-In',
  takeRoll:         'Take Roll',
  readyToPlay:      'Ready to Play',
  out:              'Out',
  gameTimeDecision: 'Game-Time Decision',
  availabilityCheck:'Availability Check',
  whosIn:           "Who's In?",
  notAvailable:     'Not Available',

  // ── Registration / payments ──────────────────────────────────
  playerRegistration: 'Player Registration',
  getPlayerSetUp:     'Get Player Set Up',
  balanceDue:         'Balance Due',
  teamFees:           'Team Fees',
  paymentRequest:     'Payment Request',
  playerForms:        'Player Forms',
  needsAttention:     'Needs Attention',
} as const;

export type VocabKey = keyof typeof VOCAB;
