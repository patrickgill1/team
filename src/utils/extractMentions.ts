// Extract structured @-mentions from message content at send time.
//
// The composer's mention picker inserts plain text like "@John Doe"
// — there's no inline link or marker. This util scans the content,
// matches each @name against the known team-members list (longest
// match wins so "@John Doe Smith" beats "@John"), and returns the
// uids of recognized people plus a `@everyone` flag.
//
// Stored on the message doc as `mentions: string[]` (uids) and
// `mentionsEveryone: boolean`. Inbox queries use array-contains on
// mentions; @everyone surfaces as a special channel ping.

export interface MentionableMember {
  uid: string;
  name: string;
}

export interface MentionResult {
  uids: string[];
  everyone: boolean;
}

const EVERYONE_TOKENS = new Set(['everyone', 'team', 'channel', 'all']);

export function extractMentions(content: string, members: MentionableMember[]): MentionResult {
  if (!content || content.indexOf('@') === -1) {
    return { uids: [], everyone: false };
  }
  // Lowercase the content once for case-insensitive matching, but
  // keep working off the original positions when slicing.
  const lc = content.toLowerCase();
  const uids = new Set<string>();
  let everyone = false;

  // Sort members so longer names match first (otherwise "@John" would
  // win over "@John Doe" when both exist on a team).
  const sortedMembers = [...members]
    .filter(m => m.uid && m.name)
    .sort((a, b) => b.name.length - a.name.length);

  // Walk every @ position in the content.
  let pos = 0;
  while (pos < content.length) {
    const at = lc.indexOf('@', pos);
    if (at === -1) break;
    // Bail if the @ is mid-word (e.g. an email address).
    const prev = at > 0 ? content[at - 1] : ' ';
    if (/\S/.test(prev) && prev !== '\n') {
      pos = at + 1;
      continue;
    }
    const after = lc.slice(at + 1);
    // @everyone / @team / @channel / @all
    let matched = false;
    for (const tok of Array.from(EVERYONE_TOKENS)) {
      if (after.startsWith(tok)) {
        const nextCh = after[tok.length];
        if (!nextCh || /[\s.,;:!?]/.test(nextCh)) {
          everyone = true;
          pos = at + 1 + tok.length;
          matched = true;
          break;
        }
      }
    }
    if (matched) continue;

    // Try each member, longest first.
    let memberMatched = false;
    for (const m of sortedMembers) {
      const ln = m.name.toLowerCase();
      if (after.startsWith(ln)) {
        const nextCh = after[ln.length];
        if (!nextCh || /[\s.,;:!?]/.test(nextCh)) {
          uids.add(m.uid);
          pos = at + 1 + ln.length;
          memberMatched = true;
          break;
        }
      }
    }
    if (!memberMatched) {
      pos = at + 1;
    }
  }

  return { uids: Array.from(uids), everyone };
}
