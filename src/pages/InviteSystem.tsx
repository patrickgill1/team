import React, { useState } from 'react';
import { useAuth } from '../hooks/useAuth';
import { useTeam } from '../contexts/TeamContext';
import { isCoach } from '../utils/helpers';

interface InviteSystemProps {
  isOpen: boolean;
  onClose: () => void;
}

const InviteSystem: React.FC<InviteSystemProps> = ({ isOpen, onClose }) => {
  const { userData } = useAuth();
  const { selectedTeamId } = useTeam();
  const [email, setEmail] = useState('');
  const [relationship, setRelationship] = useState('parent');
  const [isSending, setIsSending] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const isUserCoach = userData ? isCoach(userData.role) : false;

  const generateInviteLink = () => {
    const baseUrl = window.location.origin;
    const inviteCode = selectedTeamId || userData?.teamId || 'invalid';
    return `${baseUrl}/auth?invite=${inviteCode}`;
  };

  const handleSendInvite = async () => {
    if (!email.trim()) {
      setError('Please enter an email address');
      return;
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setError('Please enter a valid email address');
      return;
    }

    setIsSending(true);
    setError('');

    try {
      const inviteLink = generateInviteLink();
      const subject = isUserCoach 
        ? `Join our team "${userData?.name || 'team'}" on Team Manager`
        : `Join our ${userData?.name || 'team'}'s Team on Team Manager`;
      
      const body = isUserCoach 
        ? `Hi there!

Coach ${userData?.name || 'Someone'} has invited you to join their team on Team Manager.

Click this link to create your account and join the team:
${inviteLink}

As a team parent, you'll be able to:
- View team roster and player information
- Get updates on games and practice schedules
- See team photos and news
- Track your child's progress and stats
- Connect with other team families
- Access team directory and contact information

Your team ID is: ${selectedTeamId || userData?.teamId}

If you have any questions, just reply to this email.

Best regards,
Team Manager`
        : `Hi there!

${userData?.name || 'Someone'} has invited you to join their team on Team Manager.

Click this link to create your account and join the team:
${inviteLink}

You'll be able to:
- View team roster and player stats
- Get updates on games and events
- See team photos and news
- Track your child's progress
- Connect with other team families

If you have any questions, just reply to this email.

Best regards,
The Team Manager Team`;

      // Create mailto link
      const mailtoLink = `mailto:${email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
      
      // Open email client
      window.open(mailtoLink, '_blank');
      
      setMessage(`Invite email opened! Send the email to ${email} and they can join your team.`);
      setEmail('');
      
      // Auto-close after a few seconds
      setTimeout(() => {
        onClose();
        setMessage('');
      }, 3000);
      
    } catch (error) {
      console.error('Error creating invite:', error);
      setError('Failed to create invite. Please try again.');
    } finally {
      setIsSending(false);
    }
  };

  const copyInviteLink = async () => {
    try {
      const link = generateInviteLink();
      await navigator.clipboard.writeText(link);
      setMessage('Invite link copied to clipboard!');
      setTimeout(() => setMessage(''), 2000);
    } catch (err) {
      setError('Failed to copy link. Please try again.');
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !isSending) {
      handleSendInvite();
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-gray-900/80 rounded-lg max-w-md w-full p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-semibold text-white">
            {isUserCoach ? 'Invite Parents to Team' : 'Invite Family Member'}
          </h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-300 transition-colors duration-200"
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <p className="text-sm text-gray-300 mb-6">
          {isUserCoach 
            ? 'Invite parents to join your team so they can see players, events, and communicate with other families.'
            : 'Invite your spouse, partner, or other family members to join the team and stay updated.'
          }
        </p>

        {/* Team ID Display for Coaches */}
        {isUserCoach && (
          <div className="mb-4 p-3 bg-blue-50 border border-blue-200 rounded-lg">
            <p className="text-sm font-medium text-blue-900 mb-1">Your Team ID:</p>
            <p className="text-xs font-mono text-blue-700 bg-white px-2 py-1 rounded border">
              {selectedTeamId || userData?.teamId}
            </p>
            <p className="text-xs text-blue-600 mt-1">
              Parents who join will automatically be added to this team
            </p>
          </div>
        )}

        {message && (
          <div className="bg-green-50 border border-green-200 rounded-lg p-3 mb-4">
            <div className="flex items-center">
              <svg className="w-5 h-5 text-green-600 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <p className="text-green-600 text-sm">{message}</p>
            </div>
          </div>
        )}

        {error && (
          <div className="bg-rose-500/10 border border-rose-500/20 rounded-lg p-3 mb-4">
            <div className="flex items-center">
              <svg className="w-5 h-5 text-rose-300 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <p className="text-rose-300 text-sm">{error}</p>
            </div>
          </div>
        )}

        <div className="space-y-4">
          {/* Email Input */}
          <div>
            <label htmlFor="email" className="block text-sm font-medium text-gray-200 mb-1">
              Email Address
            </label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                setError('');
              }}
              onKeyPress={handleKeyPress}
              className="w-full px-3 py-2 border border-white/15 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="Enter their email address"
              disabled={isSending}
              autoComplete="email"
            />
          </div>

          {/* Relationship */}
          <div>
            <label htmlFor="relationship" className="block text-sm font-medium text-gray-200 mb-1">
              {isUserCoach ? 'They are a...' : 'Relationship'}
            </label>
            <select
              id="relationship"
              value={relationship}
              onChange={(e) => setRelationship(e.target.value)}
              className="w-full px-3 py-2 border border-white/15 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              disabled={isSending}
            >
              {isUserCoach ? (
                <>
                  <option value="parent">Parent/Guardian</option>
                  <option value="head_coach">Head Coach — Full admin access</option>
                  <option value="assistant_coach">Assistant Coach</option>
                  <option value="team_manager">Team Manager</option>
                  <option value="volunteer">Volunteer</option>
                </>
              ) : (
                <>
                  <option value="spouse">Spouse/Partner</option>
                  <option value="parent">Parent</option>
                  <option value="sibling">Sibling</option>
                  <option value="grandparent">Grandparent</option>
                  <option value="other">Other Family Member</option>
                </>
              )}
            </select>
          </div>

          {/* Action Buttons */}
          <div className="flex space-x-3 pt-4">
            <button
              onClick={handleSendInvite}
              disabled={isSending || !email.trim()}
              className="flex-1 bg-blue-600 hover:bg-blue-700 text-white font-medium py-2 px-4 rounded-lg transition duration-200 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center"
            >
              {isSending ? (
                <>
                  <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2"></div>
                  Sending...
                </>
              ) : (
                <>
                  <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 4.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                  </svg>
                  Send Email Invite
                </>
              )}
            </button>

            <button
              onClick={copyInviteLink}
              disabled={isSending}
              className="bg-gray-100 hover:bg-gray-200 text-gray-200 font-medium py-2 px-4 rounded-lg transition duration-200 disabled:opacity-50 flex items-center"
              title="Copy invite link"
            >
              <svg className="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
              <span className="hidden sm:inline">Copy Link</span>
            </button>
          </div>

          {/* Manual Instructions */}
          <div className="mt-6 pt-4 border-t border-white/10">
            <h4 className="text-sm font-medium text-white mb-2">Share Invite Link Manually</h4>
            <p className="text-xs text-gray-300 mb-2">
              You can also share this link directly via text, social media, or any other method:
            </p>
            <div className="bg-gray-50 p-2 rounded text-xs text-gray-200 break-all font-mono">
              {generateInviteLink()}
            </div>
          </div>

          {/* Instructions */}
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
            <div className="flex items-start">
              <svg className="w-5 h-5 text-blue-600 mt-0.5 mr-2 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <div>
                <p className="text-blue-800 text-sm font-medium mb-1">How it works:</p>
                <ol className="text-blue-700 text-xs space-y-1">
                  <li>1. They'll receive an email with the invite link</li>
                  <li>2. Clicking the link takes them to the registration page</li>
                  <li>3. They create their account and automatically join your team (ID: {selectedTeamId || userData?.teamId})</li>
                  <li>4. They'll have access to all team information</li>
                  {isUserCoach && (
                    <li>5. You can then link their account to specific players</li>
                  )}
                </ol>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default InviteSystem;