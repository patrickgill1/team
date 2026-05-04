import React, { useState, useEffect } from 'react';
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage';
import { storage } from '../../utils/firebase';
import { Player, PlayerStats } from '../../types';
import { useAuth } from '../../hooks/useAuth';
import { useTeam } from '../../contexts/TeamContext';
import { useFirestore } from '../../hooks/useFirestore';

interface AddPlayerProps {
  isOpen: boolean;
  onClose: () => void;
  onPlayerAdded: (player: Player) => void;
  editingPlayer?: Player | null;
  existingPlayers: Player[];
}

const AddPlayer: React.FC<AddPlayerProps> = ({
  isOpen,
  onClose,
  onPlayerAdded,
  editingPlayer,
  existingPlayers
}) => {
  const { userData } = useAuth();
  const { selectedTeamId, teams } = useTeam();
  const { addPlayer, updatePlayer } = useFirestore();
  const [targetTeamId, setTargetTeamId] = useState(selectedTeamId);

  // Keep targetTeamId in sync when selectedTeamId changes
  useEffect(() => {
    setTargetTeamId(selectedTeamId);
  }, [selectedTeamId]);

  const [formData, setFormData] = useState({
    name: '',
    jerseyNumber: '',
    position: 'Midfielder',
    parentEmails: [''],
    dateOfBirth: '',
    medicalInfo: ''
  });
  const [errors, setErrors] = useState<{ [key: string]: string }>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [uploadLoading, setUploadLoading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [profilePhoto, setProfilePhoto] = useState<File | null>(null);
  const [profilePhotoPreview, setProfilePhotoPreview] = useState<string>('');
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [inviteCopied, setInviteCopied] = useState(false);

  const generateInviteCode = () =>
    Math.random().toString(36).substring(2, 9).toUpperCase() +
    Math.random().toString(36).substring(2, 5).toUpperCase();

  const copyInviteLink = async (link: string) => {
    try {
      await navigator.clipboard.writeText(link);
    } catch {
      const el = document.createElement('input');
      el.value = link;
      document.body.appendChild(el);
      el.select();
      document.execCommand('copy');
      document.body.removeChild(el);
    }
    setInviteCopied(true);
    setTimeout(() => setInviteCopied(false), 3000);
  };

  const positions = ['Goalkeeper', 'Defender', 'Midfielder', 'Forward', 'Striker'];

  // Upload function with proper error handling
  const uploadPlayerPhoto = async (file: File): Promise<string> => {
    try {
      console.log('Starting photo upload...');
      console.log('File details:', {
        name: file.name,
        size: file.size,
        type: file.type
      });
      
      // Validate file
      if (!file) {
        throw new Error('No file provided');
      }

      if (!file.type.startsWith('image/')) {
        throw new Error('Only image files are allowed');
      }

      if (file.size > 5 * 1024 * 1024) { // 5MB limit
        throw new Error('File size must be less than 5MB');
      }
      
      // Create a simple, unique filename
      const timestamp = Date.now();
      const randomId = Math.random().toString(36).substring(7);
      const fileExtension = file.name.split('.').pop() || 'jpg';
      const fileName = `player_${timestamp}_${randomId}.${fileExtension}`;
      
      // Use a simple path
      const storagePath = `player-photos/${fileName}`;
      
      console.log('Upload details:', {
        fileName,
        storagePath,
        fileSize: file.size,
        fileType: file.type
      });
      
      // Create storage reference
      const storageRef = ref(storage, storagePath);
      console.log('Storage ref created for path:', storagePath);
      
      // Add metadata
      const metadata = {
        contentType: file.type,
        customMetadata: {
          uploadedBy: userData?.uid || 'unknown',
          teamId: targetTeamId || selectedTeamId || 'unknown',
          uploadDate: new Date().toISOString()
        }
      };
      
      console.log('Starting upload with metadata:', metadata);
      
      // Upload the file
      const snapshot = await uploadBytes(storageRef, file, metadata);
      console.log('Upload completed. Snapshot details:', {
        bytesTransferred: snapshot.metadata.size,
        fullPath: snapshot.metadata.fullPath,
        name: snapshot.metadata.name
      });
      
      // Get the download URL
      const downloadURL = await getDownloadURL(snapshot.ref);
      console.log('Download URL obtained:', downloadURL);
      
      return downloadURL;
    } catch (error: any) {
      console.error('Upload error details:', {
        message: error.message,
        code: error.code,
        name: error.name,
        stack: error.stack
      });
      
      // Provide more specific error messages
      if (error.code === 'storage/unauthorized') {
        throw new Error('Permission denied. Please check Firebase Storage security rules.');
      } else if (error.code === 'storage/unknown') {
        throw new Error('Unknown storage error. Please try again.');
      } else if (error.code === 'storage/invalid-url') {
        throw new Error('Invalid storage configuration. Please contact support.');
      } else if (error.message?.includes('CORS')) {
        throw new Error('Network error. Please check your internet connection and try again.');
      } else if (error.message?.includes('fetch')) {
        throw new Error('Network request failed. Please check your connection and try again.');
      }
      
      throw new Error(error.message || 'Failed to upload image');
    }
  };

  useEffect(() => {
    if (editingPlayer) {
      setFormData({
        name: editingPlayer.name || '',
        jerseyNumber: editingPlayer.jerseyNumber?.toString() || '',
        position: editingPlayer.position || 'Midfielder',
        parentEmails: editingPlayer.parentEmails && editingPlayer.parentEmails.length > 0 
          ? editingPlayer.parentEmails 
          : [''],
        dateOfBirth: editingPlayer.dateOfBirth 
          ? (editingPlayer.dateOfBirth.toISOString ? editingPlayer.dateOfBirth.toISOString().split('T')[0] : (editingPlayer.dateOfBirth as any).toDate ? (editingPlayer.dateOfBirth as any).toDate().toISOString().split('T')[0] : new Date(editingPlayer.dateOfBirth as any).toISOString().split('T')[0])
          : '',
        medicalInfo: editingPlayer.medicalInfo || ''
      });
      setTargetTeamId(editingPlayer.teamId || selectedTeamId);
      setProfilePhotoPreview(editingPlayer.profilePhotoUrl || '');
    } else {
      setFormData({
        name: '',
        jerseyNumber: '',
        position: 'Midfielder',
        parentEmails: [''],
        dateOfBirth: '',
        medicalInfo: ''
      });
      setProfilePhotoPreview('');
    }
    setErrors({});
    setUploadError(null);
    setProfilePhoto(null);
    setInviteLink(null);
    setInviteCopied(false);
  }, [editingPlayer, isOpen]);

  const validateForm = (): boolean => {
    const newErrors: { [key: string]: string } = {};

    // Name validation
    if (!formData.name.trim()) {
      newErrors.name = 'Player name is required';
    } else if (formData.name.trim().length < 2) {
      newErrors.name = 'Player name must be at least 2 characters';
    }

    // Jersey number validation (optional)
    if (formData.jerseyNumber) {
      const jerseyNum = parseInt(formData.jerseyNumber);
      if (isNaN(jerseyNum)) {
        newErrors.jerseyNumber = 'Jersey number must be a valid number';
      } else if (jerseyNum < 1 || jerseyNum > 99) {
        newErrors.jerseyNumber = 'Jersey number must be between 1 and 99';
      }
    }

    // Parent email validation (optional but if provided, must be valid)
    formData.parentEmails.forEach((email, index) => {
      if (email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
        newErrors[`parentEmail${index}`] = 'Please enter a valid email address';
      }
    });

    // Date of birth validation (optional)
    if (formData.dateOfBirth) {
      const birthDate = new Date(formData.dateOfBirth);
      const today = new Date();
      const minAge = new Date(today.getFullYear() - 30, today.getMonth(), today.getDate());
      const maxAge = new Date(today.getFullYear() - 4, today.getMonth(), today.getDate());
      
      if (birthDate < minAge || birthDate > maxAge) {
        newErrors.dateOfBirth = 'Please enter a realistic date of birth (4-30 years old)';
      }
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleProfilePhotoChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      if (!file.type.startsWith('image/')) {
        setErrors({ ...errors, profilePhoto: 'Please select an image file' });
        return;
      }
      if (file.size > 5 * 1024 * 1024) { // 5MB limit
        setErrors({ ...errors, profilePhoto: 'Image must be less than 5MB' });
        return;
      }
      
      setProfilePhoto(file);
      setUploadError(null);
      
      // Create preview
      const reader = new FileReader();
      reader.onload = (e) => {
        setProfilePhotoPreview(e.target?.result as string);
      };
      reader.readAsDataURL(file);
      
      // Clear any previous error
      const newErrors = { ...errors };
      delete newErrors.profilePhoto;
      setErrors(newErrors);
    }
  };

  const createDefaultStats = (): PlayerStats => ({
    gamesPlayed: 0,
    goals: 0,
    assists: 0,
    yellowCards: 0,
    redCards: 0,
    minutesPlayed: 0,
    saves: 0,
    cleanSheets: 0
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!validateForm() || !userData) return;

    setIsSubmitting(true);
    setUploadError(null);

    try {
      let profilePhotoUrl = editingPlayer?.profilePhotoUrl || null;

      // Upload profile photo if one was selected
      if (profilePhoto) {
        try {
          setUploadLoading(true);
          console.log('Starting photo upload process...');
          profilePhotoUrl = await uploadPlayerPhoto(profilePhoto);
          console.log('Profile photo uploaded successfully:', profilePhotoUrl);
          setUploadLoading(false);
        } catch (uploadErr: any) {
          console.error('Error uploading profile photo:', uploadErr);
          setUploadError(uploadErr.message || 'Failed to upload profile photo. Please try again.');
          setUploadLoading(false);
          setIsSubmitting(false);
          return;
        }
      }

      // Filter out empty parent emails and normalize to lowercase
      const validParentEmails = formData.parentEmails
        .map(email => email.trim().toLowerCase())
        .filter(email => email.length > 0);

      const effectiveTeamId = targetTeamId || selectedTeamId;

      // Build teamIds: when editing, preserve existing shared teams and ensure the target team is included
      let newTeamIds: string[];
      if (editingPlayer) {
        const existing = editingPlayer.teamIds || (editingPlayer.teamId ? [editingPlayer.teamId] : []);
        const oldPrimary = editingPlayer.teamId;
        if (effectiveTeamId !== oldPrimary) {
          // Moving player: replace old primary team with new one, keep other shared teams
          newTeamIds = existing.filter(id => id !== oldPrimary);
          if (!newTeamIds.includes(effectiveTeamId)) {
            newTeamIds.push(effectiveTeamId);
          }
          // Ensure at least the new team is present
          if (newTeamIds.length === 0) newTeamIds = [effectiveTeamId];
        } else {
          // Same team — keep all existing team associations
          newTeamIds = [...existing];
          if (!newTeamIds.includes(effectiveTeamId)) {
            newTeamIds.push(effectiveTeamId);
          }
        }
      } else {
        newTeamIds = [effectiveTeamId];
      }

      const basePlayerData = {
        name: formData.name.trim(),
        jerseyNumber: formData.jerseyNumber ? parseInt(formData.jerseyNumber) : undefined,
        position: formData.position || undefined,
        parentIds: [], // For now, we'll implement parent assignment separately
        parentEmails: validParentEmails.length > 0 ? validParentEmails : undefined,
        dateOfBirth: formData.dateOfBirth ? new Date(formData.dateOfBirth) : undefined,
        medicalInfo: formData.medicalInfo.trim() || undefined,
        teamId: effectiveTeamId,
        teamIds: newTeamIds,
        isActive: true,
        profilePhotoUrl: profilePhotoUrl,
        updatedAt: new Date(),
        stats: editingPlayer?.stats || createDefaultStats(),
        inviteCode: editingPlayer?.inviteCode || generateInviteCode()
      };

      console.log('Attempting to save player:', basePlayerData);

      if (editingPlayer) {
        // Update existing player
        console.log('Updating existing player with ID:', editingPlayer.id);
        await updatePlayer(editingPlayer.id, basePlayerData);
        const updatedPlayer: Player = {
          ...editingPlayer,
          ...basePlayerData
        };
        console.log('Player updated successfully:', updatedPlayer);
        onPlayerAdded(updatedPlayer);
        onClose();
      } else {
        // Add new player
        console.log('Adding new player...');
        const playerId = await addPlayer(basePlayerData);
        console.log('New player created with ID:', playerId);
        
        const newPlayer: Player = {
          ...basePlayerData,
          id: playerId,
          createdAt: new Date()
        };
        console.log('New player object:', newPlayer);
        onPlayerAdded(newPlayer);
        
        // Show invite link instead of closing
        const link = `${window.location.origin}/join?player=${playerId}&code=${basePlayerData.inviteCode}`;
        setInviteLink(link);
      }
    } catch (error) {
      console.error('Error saving player:', error);
      setErrors({ submit: 'Failed to save player. Please try again.' });
    } finally {
      setIsSubmitting(false);
      setUploadLoading(false);
    }
  };

  const addParentEmailField = () => {
    if (formData.parentEmails.length < 3) {
      setFormData({
        ...formData,
        parentEmails: [...formData.parentEmails, '']
      });
    }
  };

  const removeParentEmailField = (index: number) => {
    const newEmails = formData.parentEmails.filter((_, i) => i !== index);
    setFormData({
      ...formData,
      parentEmails: newEmails.length > 0 ? newEmails : ['']
    });
  };

  const updateParentEmail = (index: number, email: string) => {
    const newEmails = [...formData.parentEmails];
    newEmails[index] = email;
    setFormData({
      ...formData,
      parentEmails: newEmails
    });
  };

  if (!isOpen) return null;

  // Show invite link success screen after player is added
  if (inviteLink) {
    return (
      <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
        <div className="bg-white rounded-lg max-w-md w-full p-6">
          <div className="text-center mb-6">
            <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-3">
              <svg className="w-8 h-8 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <h2 className="text-xl font-bold text-gray-900">Player Added! 🎉</h2>
            <p className="text-gray-600 mt-1 text-sm">
              Share this link with the player's parent so they can link their account.
            </p>
          </div>

          <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 mb-4">
            <p className="text-xs text-blue-600 font-medium mb-2 uppercase tracking-wide">Invite Link</p>
            <p className="text-sm text-blue-900 break-all font-mono mb-3">{inviteLink}</p>
            <button
              onClick={() => copyInviteLink(inviteLink)}
              className={`w-full flex items-center justify-center gap-2 py-2.5 px-4 rounded-lg font-medium transition-all duration-200 ${
                inviteCopied
                  ? 'bg-green-600 text-white'
                  : 'bg-blue-600 hover:bg-blue-700 text-white'
              }`}
            >
              {inviteCopied ? (
                <>
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                  Copied!
                </>
              ) : (
                <>
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                  </svg>
                  Copy Link
                </>
              )}
            </button>
          </div>

          <p className="text-xs text-gray-500 text-center mb-4">
            💡 The parent clicks the link, signs in or creates a free account, and they'll be linked to this player's profile. They can then vote in Player of the Match polls.
          </p>

          <button
            onClick={() => { setInviteLink(null); onClose(); }}
            className="w-full border border-gray-300 text-gray-700 hover:bg-gray-50 py-2.5 rounded-lg font-medium transition-colors"
          >
            Done
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg max-w-lg w-full max-h-screen overflow-y-auto">
        <div className="sticky top-0 bg-white border-b border-gray-200 px-6 py-4">
          <div className="flex items-center justify-between">
            <h2 className="text-xl font-semibold text-gray-900">
              {editingPlayer ? 'Edit Player' : 'Add New Player'}
            </h2>
            <button
              onClick={onClose}
              className="text-gray-400 hover:text-gray-600 transition-colors duration-200"
            >
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-6">
          {/* Debug Info */}
          {process.env.NODE_ENV === 'development' && (
            <div className="bg-gray-100 p-3 rounded text-xs">
              <p><strong>Debug Info:</strong></p>
              <p>Storage Bucket: {process.env.REACT_APP_FIREBASE_STORAGE_BUCKET || 'Not loaded'}</p>
              <p>User Team: {selectedTeamId || 'No team'}</p>
            </div>
          )}

          {/* Profile Photo */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Profile Photo (Optional)
            </label>
            <div className="flex items-center space-x-4">
              <div className="w-20 h-20 bg-gray-200 rounded-full overflow-hidden flex items-center justify-center">
                {profilePhotoPreview ? (
                  <img 
                    src={profilePhotoPreview} 
                    alt="Profile preview" 
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <svg className="w-8 h-8 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                  </svg>
                )}
              </div>
              <div className="flex-1">
                <input
                  type="file"
                  accept="image/*"
                  onChange={handleProfilePhotoChange}
                  className="hidden"
                  id="profile-photo-input"
                  disabled={isSubmitting || uploadLoading}
                />
                <label
                  htmlFor="profile-photo-input"
                  className="cursor-pointer inline-flex items-center px-3 py-2 border border-gray-300 rounded-md text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 transition-colors duration-200 disabled:opacity-50"
                >
                  <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                  </svg>
                  {editingPlayer?.profilePhotoUrl ? 'Change Photo' : 'Upload Photo'}
                </label>
                <p className="text-xs text-gray-500 mt-1">PNG, JPG up to 5MB</p>
              </div>
            </div>
            {(errors.profilePhoto || uploadError) && (
              <p className="text-red-500 text-sm mt-1">{errors.profilePhoto || uploadError}</p>
            )}
          </div>

          {/* Team Selector */}
          {teams.length > 1 && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Add to Team *
              </label>
              <select
                value={targetTeamId}
                onChange={(e) => setTargetTeamId(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                disabled={isSubmitting}
              >
                {teams.map(t => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
            </div>
          )}

          {/* Player Name */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Player Name *
            </label>
            <input
              type="text"
              value={formData.name}
              onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              className={`w-full px-3 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                errors.name ? 'border-red-500' : 'border-gray-300'
              }`}
              placeholder="Enter player's full name"
              disabled={isSubmitting}
            />
            {errors.name && <p className="text-red-500 text-sm mt-1">{errors.name}</p>}
          </div>

          {/* Jersey Number and Position */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Jersey Number
              </label>
              <input
                type="number"
                min="1"
                max="99"
                value={formData.jerseyNumber}
                onChange={(e) => setFormData({ ...formData, jerseyNumber: e.target.value })}
                className={`w-full px-3 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                  errors.jerseyNumber ? 'border-red-500' : 'border-gray-300'
                }`}
                placeholder="1-99"
                disabled={isSubmitting}
              />
              {errors.jerseyNumber && <p className="text-red-500 text-sm mt-1">{errors.jerseyNumber}</p>}
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Position
              </label>
              <select
                value={formData.position}
                onChange={(e) => setFormData({ ...formData, position: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                disabled={isSubmitting}
              >
                {positions.map(position => (
                  <option key={position} value={position}>{position}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Date of Birth */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Date of Birth (Optional)
            </label>
            <input
              type="date"
              value={formData.dateOfBirth}
              onChange={(e) => setFormData({ ...formData, dateOfBirth: e.target.value })}
              className={`w-full px-3 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                errors.dateOfBirth ? 'border-red-500' : 'border-gray-300'
              }`}
              disabled={isSubmitting}
            />
            {errors.dateOfBirth && <p className="text-red-500 text-sm mt-1">{errors.dateOfBirth}</p>}
          </div>

          {/* Parent Emails */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Parent Email Addresses (Optional)
            </label>
            <div className="space-y-2">
              {formData.parentEmails.map((email, index) => (
                <div key={index} className="flex space-x-2">
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => updateParentEmail(index, e.target.value)}
                    className={`flex-1 px-3 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                      errors[`parentEmail${index}`] ? 'border-red-500' : 'border-gray-300'
                    }`}
                    placeholder="parent@example.com"
                    disabled={isSubmitting}
                  />
                  {formData.parentEmails.length > 1 && (
                    <button
                      type="button"
                      onClick={() => removeParentEmailField(index)}
                      disabled={isSubmitting}
                      className="px-3 py-2 text-red-600 hover:bg-red-50 rounded-lg transition-colors duration-200 disabled:opacity-50"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
                    </button>
                  )}
                </div>
              ))}
            </div>
            
            {formData.parentEmails.length < 3 && (
              <button
                type="button"
                onClick={addParentEmailField}
                disabled={isSubmitting}
                className="mt-2 text-blue-600 hover:text-blue-700 text-sm font-medium disabled:opacity-50"
              >
                + Add another parent email
              </button>
            )}
            
            {Object.keys(errors).some(key => key.startsWith('parentEmail')) && (
              <p className="text-red-500 text-sm mt-1">Please check parent email addresses</p>
            )}
          </div>

          {/* Medical Information */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Medical Information (Optional)
            </label>
            <textarea
              value={formData.medicalInfo}
              onChange={(e) => setFormData({ ...formData, medicalInfo: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
              rows={3}
              placeholder="Any allergies, medical conditions, or special instructions..."
              disabled={isSubmitting}
            />
          </div>

          {/* Submit Error */}
          {errors.submit && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-3">
              <p className="text-red-600 text-sm">{errors.submit}</p>
            </div>
          )}

          {/* Upload Progress */}
          {uploadLoading && (
            <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
              <div className="flex items-center space-x-2">
                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-blue-600"></div>
                <p className="text-blue-600 text-sm">Uploading profile photo...</p>
              </div>
            </div>
          )}

          {/* Action Buttons */}
          <div className="flex space-x-4 pt-4">
            <button
              type="button"
              onClick={onClose}
              disabled={isSubmitting || uploadLoading}
              className="flex-1 bg-gray-300 hover:bg-gray-400 text-gray-800 font-medium py-2 px-4 rounded-lg transition duration-200 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting || uploadLoading}
              className="flex-1 bg-blue-600 hover:bg-blue-700 text-white font-medium py-2 px-4 rounded-lg transition duration-200 disabled:opacity-50 flex items-center justify-center"
            >
              {(isSubmitting || uploadLoading) ? (
                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
              ) : (
                editingPlayer ? 'Update Player' : 'Add Player'
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default AddPlayer;