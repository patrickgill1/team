import React, { useState, useEffect } from 'react';
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage';
import { storage } from '../../utils/firebase';
import { Player, PlayerStats } from '../../types';
import { useAuth } from '../../hooks/useAuth';
import { useTeam } from '../../contexts/TeamContext';
import { useFirestore } from '../../hooks/useFirestore';
import { getShareOrigin } from '../../utils/origin';
import { parseDobInput, formatDobInput } from '../../utils/dobDate';
import { useTeamAudience } from '../../hooks/useTeamAudience';
import { debug } from '../../utils/debug';

interface AddPlayerProps {
  isOpen: boolean;
  onClose: () => void;
  onPlayerAdded: (player: Player) => void;
  editingPlayer?: Player | null;
  existingPlayers: Player[];
}

// DOB helpers moved to src/utils/dobDate.ts so ProfileHero,
// PlayerCard, and any other future consumer share the same UTC-noon
// storage convention. Alias to keep the existing local variable
// names in this file readable.
const parseDateInput = parseDobInput;
const formatDateInput = formatDobInput;

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

  // Adult vs youth flavor of the form. Team-level audience beats the
  // per-player "adult" toggle: an adult team's roster is always
  // adult, no toggle needed. isYouth = show parent-email row + the
  // "my kid" shortcut. isAdultTeam = show position/foot/past clubs
  // and swap the email row to a player-email single field.
  const [targetTeamId, setTargetTeamId] = useState(selectedTeamId);
  // ALL teams the user is allowed to see for the share/move picker.
  // Defaults to the user's teams (from TeamContext), but when the
  // modal opens we also pull every team in the same club so a coach
  // can share or move a player to a sister team they're not directly
  // a member of. Firestore rules already allow any authed user to
  // read the teams collection.
  const [pickerTeams, setPickerTeams] = useState<Array<{ id: string; name: string }>>([]);
  // Team picker is collapsed by default when editing — most coach
  // edits don't touch the team, and the dropdown lives behind a
  // disclosure so the form stays tight.
  const [teamPickerOpen, setTeamPickerOpen] = useState(false);

  // Keep targetTeamId in sync when selectedTeamId changes
  useEffect(() => {
    setTargetTeamId(selectedTeamId);
  }, [selectedTeamId]);

  // Load club-wide teams for the picker. Falls back to the user's
  // teams if we can't query the wider list (offline, denied, etc.).
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    (async () => {
      try {
        const { collection, getDocs, query, where } = await import('firebase/firestore');
        const { db } = await import('../../utils/firebase');
        const userClubId = (userData as any)?.clubId;
        const myTeam = teams.find(t => t.id === selectedTeamId) as any;
        const clubIdToQuery = userClubId || myTeam?.clubId;
        let docs: Array<{ id: string; name: string; clubId?: string }> = [];
        if (clubIdToQuery) {
          const snap = await getDocs(query(
            collection(db, 'teams'),
            where('clubId', '==', clubIdToQuery),
          ));
          snap.forEach(d => {
            const data: any = d.data();
            if (data.isActive !== false) {
              docs.push({ id: d.id, name: data.name || 'Team', clubId: data.clubId });
            }
          });
        }
        // Union with the user's known teams so even teams without a
        // clubId set still surface.
        for (const t of teams) {
          if (!docs.some(d => d.id === t.id)) {
            docs.push({ id: t.id, name: t.name });
          }
        }
        docs.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
        if (!cancelled) setPickerTeams(docs);
      } catch (err) {
        console.warn('AddPlayer: club-wide team load failed, falling back to user teams', err);
        if (!cancelled) setPickerTeams(teams.map(t => ({ id: t.id, name: t.name })));
      }
    })();
    return () => { cancelled = true; };
  }, [isOpen, userData, teams, selectedTeamId]);

  // Look up the audience of the *target* team, not the currently
  // selected team, so a coach who's in the create-modal for a
  // different team gets the right form flavor.
  const targetTeam = teams.find(t => t.id === (targetTeamId || selectedTeamId));
  const { isAdult: isAdultTeam } = useTeamAudience(targetTeam);

  const [formData, setFormData] = useState({
    name: '',
    jerseyNumber: '',
    // Multi-position support: stored as an array. Saved both as `positions`
    // (new field) and `position` (legacy single string = first selected) so
    // older parts of the app that still read `position` keep working.
    positions: ['Midfielder'] as string[],
    parentEmails: [''],
    dateOfBirth: '',
    medicalInfo: '',
    // Adult roster fields — only shown when the target team is adult.
    secondaryPosition: '',
    preferredFoot: '' as '' | 'Left' | 'Right' | 'Both',
    pastClubs: [] as string[],
    // Team-split signals (adult only). See utils/snakeDraft.ts.
    highestLevelPlayed: '' as '' | 'recreational' | 'select' | 'high_school' | 'college_d3' | 'college_d2' | 'college_d1' | 'semi_pro' | 'pro',
    skillLevel: 0 as 0 | 1 | 2 | 3 | 4 | 5,  // 0 = not set
  });
  // Adult-team mode: the player IS the user (no parent layer).
  // Drives `isAdultPlayer` on the player doc + flips the invite to
  // a self-signup link. Seeds true when the *team* is adult so a
  // brand-new player on an adult team never gets wrongly saved as
  // youth. Team-audience always wins; the manual toggle is only
  // visible on youth teams (edge case for mixed rosters).
  const [isAdultPlayer, setIsAdultPlayer] = useState<boolean>(
    !!(editingPlayer as any)?.isAdultPlayer || isAdultTeam,
  );
  useEffect(() => {
    if (isAdultTeam) setIsAdultPlayer(true);
  }, [isAdultTeam]);
  // "This player is my kid" — coach-only shortcut that links the
  // coach as a parent alongside their coaching role, so they get
  // parent-side surfaces (dev plan, media notifs, chat replies) on
  // their own kid. State reflects whether the coach is already in
  // parentIds; toggle it and we call /players/toggle-self-parent
  // after the base save. Initialized in the useEffect below alongside
  // the rest of the form state so it re-syncs when the modal reopens
  // for a different player.
  const [isMyKid, setIsMyKid] = useState<boolean>(false);
  const [initialIsMyKid, setInitialIsMyKid] = useState<boolean>(false);
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
      debug('Starting photo upload...');
      debug('File details:', {
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
      
      debug('Upload details:', {
        fileName,
        storagePath,
        fileSize: file.size,
        fileType: file.type
      });
      
      // Create storage reference
      const storageRef = ref(storage, storagePath);
      debug('Storage ref created for path:', storagePath);
      
      // Add metadata
      const metadata = {
        contentType: file.type,
        customMetadata: {
          uploadedBy: userData?.uid || 'unknown',
          teamId: targetTeamId || selectedTeamId || 'unknown',
          uploadDate: new Date().toISOString()
        }
      };
      
      debug('Starting upload with metadata:', metadata);
      
      // Upload the file
      const snapshot = await uploadBytes(storageRef, file, metadata);
      debug('Upload completed. Snapshot details:', {
        bytesTransferred: snapshot.metadata.size,
        fullPath: snapshot.metadata.fullPath,
        name: snapshot.metadata.name
      });
      
      // Get the download URL
      const downloadURL = await getDownloadURL(snapshot.ref);
      debug('Download URL obtained:', downloadURL);
      
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
      const existingPositions =
        Array.isArray((editingPlayer as any).positions) && (editingPlayer as any).positions.length > 0
          ? (editingPlayer as any).positions
          : (editingPlayer.position ? [editingPlayer.position] : ['Midfielder']);
      setFormData({
        name: editingPlayer.name || '',
        jerseyNumber: editingPlayer.jerseyNumber?.toString() || '',
        positions: existingPositions,
        parentEmails: editingPlayer.parentEmails && editingPlayer.parentEmails.length > 0
          ? editingPlayer.parentEmails
          : [''],
        // Format the existing DOB back into a YYYY-MM-DD string for
        // the native <input type="date"/> field. MUST use LOCAL
        // calendar getters (getFullYear/Month/Date), not
        // toISOString(): the ISO variant emits UTC, so a Denver
        // parent editing an Aug 16 birthday could see Aug 15 in the
        // input, save, and shift the stored date by another day.
        dateOfBirth: editingPlayer.dateOfBirth
          ? formatDateInput(
              (editingPlayer.dateOfBirth as any).toDate
                ? (editingPlayer.dateOfBirth as any).toDate()
                : editingPlayer.dateOfBirth instanceof Date
                  ? editingPlayer.dateOfBirth
                  : new Date(editingPlayer.dateOfBirth as any)
            )
          : '',
        medicalInfo: editingPlayer.medicalInfo || '',
        secondaryPosition: (editingPlayer as any).secondaryPosition || '',
        preferredFoot: ((editingPlayer as any).preferredFoot as any) || '',
        pastClubs: Array.isArray((editingPlayer as any).pastClubs) ? (editingPlayer as any).pastClubs : [],
        highestLevelPlayed: ((editingPlayer as any).highestLevelPlayed as any) || '',
        skillLevel: typeof (editingPlayer as any).skillLevel === 'number' ? (editingPlayer as any).skillLevel : 0,
      });
      setTargetTeamId(editingPlayer.teamId || selectedTeamId);
      setProfilePhotoPreview(editingPlayer.profilePhotoUrl || '');
      const alreadyMyKid = !!(userData?.uid && Array.isArray(editingPlayer.parentIds) && editingPlayer.parentIds.includes(userData.uid));
      setIsMyKid(alreadyMyKid);
      setInitialIsMyKid(alreadyMyKid);
    } else {
      setFormData({
        name: '',
        jerseyNumber: '',
        positions: ['Midfielder'],
        parentEmails: [''],
        dateOfBirth: '',
        medicalInfo: '',
        secondaryPosition: '',
        preferredFoot: '',
        pastClubs: [],
        highestLevelPlayed: '',
        skillLevel: 0,
      });
      setProfilePhotoPreview('');
      setIsMyKid(false);
      setInitialIsMyKid(false);
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
      const birthDate = parseDateInput(formData.dateOfBirth);
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
          debug('Starting photo upload process...');
          profilePhotoUrl = await uploadPlayerPhoto(profilePhoto);
          debug('Profile photo uploaded successfully:', profilePhotoUrl);
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

      const cleanPositions = (formData.positions || []).filter(p => !!p);
      const basePlayerData = {
        name: formData.name.trim(),
        jerseyNumber: formData.jerseyNumber ? parseInt(formData.jerseyNumber) : undefined,
        // Save both: `positions` array (canonical) + legacy `position` string
        // (first selected) so older readers keep working without a migration.
        positions: cleanPositions.length > 0 ? cleanPositions : undefined,
        position: cleanPositions[0] || undefined,
        // parentIds is DELIBERATELY absent from this payload — the
        // Firestore rule blocks client updates that touch parentIds,
        // and parent link mutations go through the worker (/players
        // /toggle-self-parent, /players/link-parent). Earlier code
        // shipped parentIds: [] and clobbered every linked parent
        // on any roster form save; the rule + this omission make it
        // impossible for that class of bug to re-emerge.
        parentEmails: validParentEmails.length > 0 ? validParentEmails : undefined,
        // Parse the YYYY-MM-DD string as LOCAL midnight, not UTC.
        // `new Date("YYYY-MM-DD")` is spec'd as UTC — a Denver parent
        // entering Aug 16 would end up with Aug 15 stored + rendered
        // everywhere else. parseDateInput uses the local Date
        // constructor for a stable calendar day.
        dateOfBirth: formData.dateOfBirth ? parseDateInput(formData.dateOfBirth) : undefined,
        medicalInfo: formData.medicalInfo.trim() || undefined,
        teamId: effectiveTeamId,
        teamIds: newTeamIds,
        isActive: true,
        isAdultPlayer: isAdultPlayer || undefined,
        // Adult-only roster fields. Trimmed/coerced here so an adult
        // team that captures them writes clean data, and a youth team
        // (where these inputs never render) never puts them on the
        // player doc.
        secondaryPosition: isAdultTeam && formData.secondaryPosition.trim() ? formData.secondaryPosition.trim() : undefined,
        preferredFoot: isAdultTeam && formData.preferredFoot ? formData.preferredFoot : undefined,
        pastClubs: isAdultTeam && formData.pastClubs.length > 0 ? formData.pastClubs.filter(c => !!c.trim()).map(c => c.trim()).slice(0, 4) : undefined,
        // Team-split signals — see utils/snakeDraft.ts. Empty
        // string / 0 both mean "not filled out"; leave the field
        // undefined so the balancer knows to use its default.
        highestLevelPlayed: isAdultTeam && formData.highestLevelPlayed ? formData.highestLevelPlayed : undefined,
        skillLevel: isAdultTeam && formData.skillLevel > 0 ? formData.skillLevel : undefined,
        profilePhotoUrl: profilePhotoUrl,
        updatedAt: new Date(),
        stats: editingPlayer?.stats || createDefaultStats(),
        inviteCode: editingPlayer?.inviteCode || generateInviteCode()
      };

      debug('Attempting to save player:', basePlayerData);

      // Persist the base player doc first. Then, if the coach flipped
      // the "This player is my kid" toggle, fire /players/toggle-self-
      // parent — that endpoint owns the atomic parentIds + parentEmails
      // + user.teamIds sync so we don't try to reproduce it here.
      //
      // ADULT SELF-ADD FAST PATH: when creating a NEW player on an
      // adult team with the "This is me" checkbox checked, route
      // through /players/create with linkSelfAsParent+isAdultPlayer.
      // This mirrors the People-banner "Add me" flow so a coach who
      // spun up an adult team and forgot to check "I am a player" in
      // the team-create modal can still self-onboard in one submit.
      let savedPlayerId: string;
      let savedPlayer: Player;
      if (editingPlayer) {
        debug('Updating existing player with ID:', editingPlayer.id);
        await updatePlayer(editingPlayer.id, basePlayerData as any);
        savedPlayerId = editingPlayer.id;
        savedPlayer = { ...editingPlayer, ...basePlayerData } as Player;
        debug('Player updated successfully:', savedPlayer);
      } else if ((isAdultTeam || isAdultPlayer) && isMyKid && userData?.uid) {
        debug('Adult self-add: routing through worker /players/create');
        const { workerFetch } = await import('../../utils/workerFetch');
        const coachEmail = (userData.email || '').trim().toLowerCase();
        const res = await workerFetch('/players/create', {
          method: 'POST',
          body: JSON.stringify({
            teamId: effectiveTeamId,
            name: (basePlayerData as any).name,
            jerseyNumber: (basePlayerData as any).jerseyNumber,
            positions: (basePlayerData as any).positions,
            parentEmails: validParentEmails.length > 0
              ? validParentEmails
              : (coachEmail ? [coachEmail] : undefined),
            linkSelfAsParent: true,
            isAdultPlayer: true,
          }),
        });
        const data: any = await res.json().catch(() => ({}));
        if (!res.ok || !data?.ok) {
          throw new Error(data?.error || `create-${res.status}`);
        }
        savedPlayerId = String(data.playerId);
        savedPlayer = { ...basePlayerData, id: savedPlayerId, createdAt: new Date() } as Player;
        // Follow-up: apply the optional client-side fields the worker
        // create endpoint doesn't take (DOB, medical, photo, kit-side
        // metadata). Non-security-critical and gated by the same
        // team-membership the worker just granted us via the create.
        const clientPatch: any = {};
        if ((basePlayerData as any).dateOfBirth) clientPatch.dateOfBirth = (basePlayerData as any).dateOfBirth;
        if ((basePlayerData as any).medicalInfo) clientPatch.medicalInfo = (basePlayerData as any).medicalInfo;
        if ((basePlayerData as any).profilePhotoUrl) clientPatch.profilePhotoUrl = (basePlayerData as any).profilePhotoUrl;
        if ((basePlayerData as any).secondaryPosition) clientPatch.secondaryPosition = (basePlayerData as any).secondaryPosition;
        if ((basePlayerData as any).preferredFoot) clientPatch.preferredFoot = (basePlayerData as any).preferredFoot;
        if ((basePlayerData as any).pastClubs) clientPatch.pastClubs = (basePlayerData as any).pastClubs;
        if ((basePlayerData as any).highestLevelPlayed) clientPatch.highestLevelPlayed = (basePlayerData as any).highestLevelPlayed;
        if ((basePlayerData as any).skillLevel) clientPatch.skillLevel = (basePlayerData as any).skillLevel;
        if (Object.keys(clientPatch).length > 0) {
          try {
            await updatePlayer(savedPlayerId, clientPatch);
            savedPlayer = { ...savedPlayer, ...clientPatch } as Player;
          } catch (err) {
            console.warn('[adult self-add] client-side patch failed, non-fatal', err);
          }
        }
        debug('Adult self-add succeeded, playerId:', savedPlayerId);
      } else {
        debug('Adding new player...');
        savedPlayerId = await addPlayer(basePlayerData as any);
        savedPlayer = { ...basePlayerData, id: savedPlayerId, createdAt: new Date() } as Player;
        debug('New player created with ID:', savedPlayerId);
      }

      // "This is my kid" toggle. Fire whenever the desired state
      // doesn't match what's actually persisted on parentIds — using
      // the persisted array as source of truth, NOT the hydrated
      // initialIsMyKid. Prior version gated on `isMyKid !==
      // initialIsMyKid`; if the modal opened with a stale hydration
      // (e.g. parent list still loading when the effect ran), the
      // gate would be true=true and the worker call would silently
      // skip. Patrick 2026-07-10 report.
      if (userData?.uid) {
        // Read the player doc BACK from Firestore (post-update) so we
        // decide against fresh persisted state, not the modal's
        // hydrated snapshot. Prior version pulled parentIds from
        // savedPlayer which was spread from the stale editingPlayer;
        // if that snapshot missed a recent link, we'd incorrectly
        // decide "no change needed" and skip the toggle. Fetch cost
        // is one doc read on a flow that already saved a player, so
        // trivial. Audit 2026-07-10.
        let currentParentIds: string[] = Array.isArray(savedPlayer.parentIds) ? savedPlayer.parentIds : [];
        try {
          const { getDoc, doc: fsDoc } = await import('firebase/firestore');
          const { db: fsDb } = await import('../../utils/firebase');
          const freshSnap = await getDoc(fsDoc(fsDb, 'players', savedPlayerId));
          if (freshSnap.exists()) {
            const freshParents = (freshSnap.data() as any)?.parentIds;
            if (Array.isArray(freshParents)) currentParentIds = freshParents;
          }
        } catch (err) {
          console.warn('[isMyKid] fresh read failed, falling back to snapshot', err);
        }
        const alreadyParent = currentParentIds.includes(userData.uid);
        const shouldBeParent = isMyKid;
        debug('[isMyKid] toggle check', {
          alreadyParent, shouldBeParent, initialIsMyKid, isMyKid,
          userUid: userData.uid, playerId: savedPlayerId,
        });
        if (shouldBeParent !== alreadyParent) {
          try {
            const { workerFetch } = await import('../../utils/workerFetch');
            const res = await workerFetch('/players/toggle-self-parent', {
              method: 'POST',
              body: JSON.stringify({ playerId: savedPlayerId, on: shouldBeParent }),
            });
            const data: any = await res.json().catch(() => ({}));
            if (!res.ok || !data?.ok) {
              const err = String(data?.error || `status ${res.status}`);
              console.warn('[isMyKid] toggle-self-parent failed', { status: res.status, data });
              // Surface the failure in the modal so it doesn't silently
              // save "everything else" and lose the parent link. Coach
              // sees the toast + can retry with a fresh attempt.
              setUploadError(
                shouldBeParent
                  ? `Saved the player, but couldn't link you as parent (${err}). Try again from the profile.`
                  : `Saved the player, but couldn't unlink you as parent (${err}).`
              );
            } else {
              debug('[isMyKid] toggle-self-parent ok');
              const nextParentIds = new Set<string>(currentParentIds);
              if (shouldBeParent) nextParentIds.add(userData.uid);
              else nextParentIds.delete(userData.uid);
              savedPlayer = { ...savedPlayer, parentIds: Array.from(nextParentIds) };
            }
          } catch (err: any) {
            console.warn('[isMyKid] toggle-self-parent threw', err);
            setUploadError(
              `Saved the player, but the "this is my kid" link didn't go through (${err?.message || 'network error'}).`
            );
          }
        }
      }

      onPlayerAdded(savedPlayer);

      if (editingPlayer) {
        onClose();
      } else {
        // Show invite link instead of closing
        const link = `${getShareOrigin()}/join?player=${savedPlayerId}&code=${basePlayerData.inviteCode}`;
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

  // Modal wrapper: safe-area padding so the modal never sits behind the
  // iOS Dynamic Island / status bar. Also overflow-x-hidden so iOS
  // rubber-band-scroll doesn't reveal a horizontal gutter on devices
  // where 100vw and the visual viewport disagree.
  const overlayClass = "fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-[100] animate-fade-in overflow-x-hidden";
  const overlayStyle: React.CSSProperties = {
    paddingTop: 'calc(1rem + env(safe-area-inset-top))',
    paddingBottom: 'calc(1rem + env(safe-area-inset-bottom))',
    paddingLeft: '1rem',
    paddingRight: '1rem',
  };

  // Show invite link success screen after player is added
  if (inviteLink) {
    return (
      <div className={overlayClass} style={overlayStyle}>
        <div className="bg-surface-elevated ring-1 ring-line-default/10 rounded-2xl max-w-md w-full p-6 animate-pop-in">
          <div className="text-center mb-6">
            <div className="w-16 h-16 bg-emerald-500/15 ring-1 ring-emerald-400/30 rounded-full flex items-center justify-center mx-auto mb-3">
              <svg className="w-8 h-8 text-emerald-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <h2 className="text-xl font-black text-ink-primary">Player Added</h2>
            <p className="text-ink-primary/60 mt-1 text-sm">
              {(isAdultPlayer || isAdultTeam)
                ? 'Share this link with the player so they can create their account.'
                : "Share this link with the player's parent so they can link their account."}
            </p>
          </div>

          <div className="bg-brand-primary/10 ring-1 ring-brand-primary-soft/30 rounded-xl p-4 mb-4">
            <p className="text-xs text-ink-primary/60 font-medium mb-2 uppercase tracking-wide">Invite Link</p>
            <p className="text-sm text-ink-primary break-all font-mono mb-3">{inviteLink}</p>
            <button
              onClick={() => copyInviteLink(inviteLink)}
              className={`w-full flex items-center justify-center gap-2 py-2.5 px-4 rounded-lg font-medium transition-all duration-200 ${
                inviteCopied
                  ? 'bg-emerald-600 text-white'
                  : 'bg-brand-primary hover:bg-brand-primary text-white'
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

          <p className="text-xs text-ink-primary/50 text-center mb-4">
            {(isAdultPlayer || isAdultTeam)
              ? 'The player clicks the link, signs in or creates a free account, and they\'ll be linked to their own profile. They can then RSVP to events and vote in MVP polls.'
              : "The parent clicks the link, signs in or creates a free account, and they'll be linked to this player's profile. They can then vote in Player of the Match polls."}
          </p>

          <button
            onClick={() => { setInviteLink(null); onClose(); }}
            className="w-full border border-line-default/10 text-ink-primary/80 hover:bg-line-default/5 py-2.5 rounded-lg font-medium transition-colors"
          >
            Done
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={overlayClass} style={overlayStyle}>
      <div className="bg-surface-elevated ring-1 ring-line-default/10 rounded-2xl max-w-lg w-full max-h-full overflow-y-auto overflow-x-hidden animate-pop-in">
        <div className="sticky top-0 bg-surface-elevated border-b border-line-default/5 px-6 py-4 z-10">
          <div className="flex items-center justify-between">
            <h2 className="text-xl font-black text-ink-primary">
              {editingPlayer ? 'Edit Player Card' : 'Add to Squad'}
            </h2>
            <button
              onClick={onClose}
              className="text-ink-primary/50 hover:text-ink-primary transition-colors duration-200 -mr-2 p-2"
            >
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-6">
          {/* Profile Photo */}
          <div>
            <label className="block text-sm font-medium text-ink-primary/80 mb-2">
              Profile Photo (Optional)
            </label>
            <div className="flex items-center space-x-4">
              <div className="w-20 h-20 bg-surface-base ring-1 ring-line-default/10 rounded-full overflow-hidden flex items-center justify-center">
                {profilePhotoPreview ? (
                  <img
                    src={profilePhotoPreview}
                    alt="Profile preview"
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <svg className="w-8 h-8 text-ink-primary/40" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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
                  className="cursor-pointer inline-flex items-center px-3 py-2 border border-line-default/10 rounded-md text-sm font-medium text-ink-primary bg-surface-base hover:bg-line-default/5 transition-colors duration-200 disabled:opacity-50"
                >
                  <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                  </svg>
                  {editingPlayer?.profilePhotoUrl ? 'Change Photo' : 'Upload Photo'}
                </label>
                <p className="text-xs text-ink-primary/50 mt-1">PNG, JPG up to 5MB</p>
              </div>
            </div>
            {(errors.profilePhoto || uploadError) && (
              <p className="text-rose-300 text-sm mt-1">{errors.profilePhoto || uploadError}</p>
            )}
          </div>

          {/* Team Selector */}
          {editingPlayer ? (
            <div className="rounded-lg ring-1 ring-line-default/10 overflow-hidden">
              <button
                type="button"
                onClick={() => setTeamPickerOpen(o => !o)}
                className="w-full flex items-center justify-between px-3 py-2.5 bg-surface-base hover:bg-line-default/5 text-left"
              >
                <div className="min-w-0">
                  <div className="text-[10px] font-extrabold uppercase tracking-widest text-ink-primary/50">Primary team</div>
                  <div className="text-sm font-semibold text-ink-primary truncate">
                    {(pickerTeams.find(t => t.id === targetTeamId)?.name) || 'No team selected'}
                  </div>
                </div>
                <div className="flex items-center gap-2 text-ink-primary/50">
                  <span className="text-[11px] font-bold">{teamPickerOpen ? 'Done' : 'Change'}</span>
                  <svg className={`w-4 h-4 transition-transform ${teamPickerOpen ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><polyline points="6 9 12 15 18 9" /></svg>
                </div>
              </button>
              {teamPickerOpen && (
                <div className="px-3 py-3 border-t border-line-default/5 bg-surface-elevated">
                  <select
                    value={targetTeamId}
                    onChange={(e) => setTargetTeamId(e.target.value)}
                    className="w-full px-3 py-2 bg-surface-base text-ink-primary border border-line-default/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-primary-soft/40"
                    disabled={isSubmitting}
                  >
                    {pickerTeams.length === 0 && (
                      <option value="">No teams available</option>
                    )}
                    {pickerTeams.map(t => (
                      <option key={t.id} value={t.id}>{t.name}</option>
                    ))}
                  </select>
                  <p className="mt-1.5 text-[11px] text-ink-primary/50">
                    Changing this moves the player. Other teams they're shared with stay intact.
                  </p>
                </div>
              )}
            </div>
          ) : pickerTeams.length > 1 ? (
            <div>
              <label className="block text-sm font-medium text-ink-primary/80 mb-1">
                Add to team *
              </label>
              <select
                value={targetTeamId}
                onChange={(e) => setTargetTeamId(e.target.value)}
                className="w-full px-3 py-2 bg-surface-base text-ink-primary border border-line-default/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-primary-soft/40"
                disabled={isSubmitting}
              >
                {pickerTeams.map(t => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
            </div>
          ) : null}

          {/* Player Name */}
          <div>
            <label className="block text-sm font-medium text-ink-primary/80 mb-1">
              Player Name *
            </label>
            <input
              type="text"
              value={formData.name}
              onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              className={`w-full px-3 py-2 bg-surface-base text-ink-primary placeholder-bone/40 border rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-primary-soft/40 ${
                errors.name ? 'border-rose-500' : 'border-line-default/10'
              }`}
              placeholder="Enter player's full name"
              disabled={isSubmitting}
            />
            {errors.name && <p className="text-rose-300 text-sm mt-1">{errors.name}</p>}
          </div>

          {/* Jersey Number and Position */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-ink-primary/80 mb-1">
                Jersey Number
              </label>
              <input
                type="number"
                min="1"
                max="99"
                value={formData.jerseyNumber}
                onChange={(e) => setFormData({ ...formData, jerseyNumber: e.target.value })}
                className={`w-full px-3 py-2 bg-surface-base text-ink-primary placeholder-bone/40 border rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-primary-soft/40 ${
                  errors.jerseyNumber ? 'border-rose-500' : 'border-line-default/10'
                }`}
                placeholder="1-99"
                disabled={isSubmitting}
              />
              {errors.jerseyNumber && <p className="text-rose-300 text-sm mt-1">{errors.jerseyNumber}</p>}
            </div>

            <div>
              <label className="block text-sm font-medium text-ink-primary/80 mb-1">
                Position{formData.positions.length > 1 ? 's' : ''}
              </label>
              <div className="flex flex-wrap gap-2">
                {positions.map((p) => {
                  const active = formData.positions.includes(p);
                  return (
                    <button
                      type="button"
                      key={p}
                      onClick={() => {
                        setFormData((prev) => {
                          const has = prev.positions.includes(p);
                          const next = has
                            ? prev.positions.filter((x) => x !== p)
                            : [...prev.positions, p];
                          return { ...prev, positions: next.length > 0 ? next : prev.positions };
                        });
                      }}
                      disabled={isSubmitting}
                      className={`px-3 py-1.5 rounded-full text-sm font-semibold ring-1 transition ${
                        active
                          ? 'bg-brand-primary text-white ring-brand-primary shadow-sm'
                          : 'bg-surface-base text-ink-primary/80 ring-line-default/15 hover:bg-line-default/5'
                      }`}
                    >
                      {p}
                    </button>
                  );
                })}
              </div>
              <p className="text-xs text-ink-primary/50 mt-1">Tap to select. Pick more than one if the player covers multiple positions (e.g. keeper + striker).</p>
            </div>
          </div>

          {/* Date of Birth */}
          <div>
            <label className="block text-sm font-medium text-ink-primary/80 mb-1">
              Date of Birth (Optional)
            </label>
            <input
              type="date"
              value={formData.dateOfBirth}
              onChange={(e) => setFormData({ ...formData, dateOfBirth: e.target.value })}
              className={`w-full px-3 py-2 bg-surface-base text-ink-primary border rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-primary-soft/40 ${
                errors.dateOfBirth ? 'border-rose-500' : 'border-line-default/10'
              }`}
              disabled={isSubmitting}
            />
            {errors.dateOfBirth && <p className="text-rose-300 text-sm mt-1">{errors.dateOfBirth}</p>}
          </div>

          {/* Adult-team roster fields — only shown when the target
              team's audienceType is 'adult'. Semi-pro, over-35, and
              any other adult club expects these instead of parent
              details. */}
          {isAdultTeam && (
            <div className="rounded-xl bg-surface-input ring-1 ring-line-default/10 p-3 space-y-3">
              <p className="text-[10px] font-black tracking-widest uppercase text-brand-primary-soft">Adult roster details</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-ink-primary/75 mb-1">Secondary position</label>
                  <input
                    type="text"
                    value={formData.secondaryPosition}
                    onChange={(e) => setFormData({ ...formData, secondaryPosition: e.target.value })}
                    className="w-full px-3 py-2 bg-surface-base text-ink-primary border border-line-default/10 rounded-lg text-sm"
                    placeholder="e.g. LB, CDM"
                    disabled={isSubmitting}
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-ink-primary/75 mb-1">Dominant foot</label>
                  <div className="inline-flex items-center bg-surface-base ring-1 ring-line-default/10 rounded-full p-0.5">
                    {(['Left', 'Right', 'Both'] as const).map(f => (
                      <button
                        type="button"
                        key={f}
                        onClick={() => setFormData({ ...formData, preferredFoot: formData.preferredFoot === f ? '' : f })}
                        className={`px-3 py-1 text-xs font-bold uppercase tracking-wider rounded-full transition ${
                          formData.preferredFoot === f ? 'bg-brand-primary text-white' : 'text-ink-primary/65'
                        }`}
                        disabled={isSubmitting}
                      >
                        {f}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="sm:col-span-2">
                  <label className="block text-xs font-bold text-ink-primary/75 mb-1">Past clubs (up to 4)</label>
                  <textarea
                    value={formData.pastClubs.join('\n')}
                    onChange={(e) => setFormData({ ...formData, pastClubs: e.target.value.split('\n').slice(0, 4) })}
                    className="w-full px-3 py-2 bg-surface-base text-ink-primary border border-line-default/10 rounded-lg text-sm resize-none"
                    rows={3}
                    placeholder={'One per line, e.g.\nReal Salt Lake U23\nUtah United'}
                    disabled={isSubmitting}
                  />
                </div>
                {/* Auto-team-split signals. Fed into utils/snakeDraft
                    on the event page. Optional — missing values default
                    to middle-of-the-pack in the balancer. */}
                <div>
                  <label className="block text-xs font-bold text-ink-primary/75 mb-1">Highest level played</label>
                  <select
                    value={formData.highestLevelPlayed}
                    onChange={(e) => setFormData({ ...formData, highestLevelPlayed: e.target.value as typeof formData.highestLevelPlayed })}
                    className="w-full px-3 py-2 bg-surface-base text-ink-primary border border-line-default/10 rounded-lg text-sm"
                    disabled={isSubmitting}
                  >
                    <option value="">— pick one —</option>
                    <option value="recreational">Recreational</option>
                    <option value="select">Select / Club</option>
                    <option value="high_school">High school</option>
                    <option value="college_d3">College D3</option>
                    <option value="college_d2">College D2</option>
                    <option value="college_d1">College D1</option>
                    <option value="semi_pro">Semi-pro</option>
                    <option value="pro">Pro</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-bold text-ink-primary/75 mb-1">How competitive today? (1 chill · 5 tryhard)</label>
                  <div className="inline-flex items-center bg-surface-base ring-1 ring-line-default/10 rounded-full p-0.5">
                    {([1,2,3,4,5] as const).map(n => (
                      <button
                        type="button"
                        key={n}
                        onClick={() => setFormData({ ...formData, skillLevel: formData.skillLevel === n ? 0 : n })}
                        className={`px-3 py-1 text-xs font-black rounded-full transition ${
                          formData.skillLevel === n ? 'bg-brand-primary text-white' : 'text-ink-primary/65'
                        }`}
                        disabled={isSubmitting}
                      >
                        {n}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Manual "adult player" toggle — only useful on a youth
              team hosting an occasional adult (rare). Hidden when the
              whole team is already adult since the toggle is
              effectively always-on there. */}
          {!isAdultTeam && (
            <label className="flex items-start gap-2 p-3 rounded-lg ring-1 ring-line-default/10 bg-surface-base cursor-pointer">
              <input
                type="checkbox"
                checked={isAdultPlayer}
                onChange={(e) => setIsAdultPlayer(e.target.checked)}
                disabled={isSubmitting}
                className="mt-0.5 accent-brand-primary"
              />
              <div className="flex-1">
                <div className="text-sm font-bold text-ink-primary">Adult player (no parent)</div>
                <div className="text-[11px] text-ink-primary/55 mt-0.5">
                  Pickup leagues, over-35s, adult rec teams. The invite goes to the player themself; they sign up and manage their own profile.
                </div>
              </div>
            </label>
          )}

          {/* Self-link toggle. Two flavors:
                youth teams → "This player is my kid" (coach adding
                their own kid to the roster).
                adult teams → "This is me" (coach adding themself as
                a player on the adult roster).
              Both drive the same self-parent link; adult flow routes
              new creates through the worker /players/create with
              linkSelfAsParent+isAdultPlayer, youth flow saves the
              base doc then fires /players/toggle-self-parent. */}
          {!isAdultPlayer && userData && (
            <div className="rounded-xl bg-surface-input ring-1 ring-line-default/10 p-3">
              <label className="flex items-start gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={isMyKid}
                  onChange={(e) => setIsMyKid(e.target.checked)}
                  className="mt-0.5 w-4 h-4 accent-brand-primary flex-shrink-0"
                  disabled={isSubmitting}
                />
                <span className="flex-1">
                  <span className="block text-sm font-semibold text-ink-primary">
                    {isAdultTeam ? 'This is me' : 'This player is my kid'}
                  </span>
                  <span className="block text-[11px] text-ink-primary/55 mt-0.5 leading-snug">
                    {isAdultTeam
                      ? 'Adds you to the roster so you show up in RSVPs, tagged clips, and Split Teams. Your email is added automatically.'
                      : 'Links you as a parent on this player alongside your coaching role, so you get parent-side updates (dev plan, media, chat). Your email is added to the parent list automatically.'}
                  </span>
                </span>
              </label>
            </div>
          )}

          {/* Parent / player Emails */}
          <div>
            <label className="block text-sm font-medium text-ink-primary/80 mb-1">
              {(isAdultPlayer || isAdultTeam) ? 'Player Email (Optional)' : 'Parent Email Addresses (Optional)'}
            </label>
            <div className="space-y-2">
              {formData.parentEmails.map((email, index) => (
                <div key={index} className="flex space-x-2">
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => updateParentEmail(index, e.target.value)}
                    className={`flex-1 min-w-0 px-3 py-2 bg-surface-base text-ink-primary placeholder-bone/40 border rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-primary-soft/40 ${
                      errors[`parentEmail${index}`] ? 'border-rose-500' : 'border-line-default/10'
                    }`}
                    placeholder={(isAdultPlayer || isAdultTeam) ? 'player@example.com' : 'parent@example.com'}
                    disabled={isSubmitting}
                  />
                  {formData.parentEmails.length > 1 && (
                    <button
                      type="button"
                      onClick={() => removeParentEmailField(index)}
                      disabled={isSubmitting}
                      className="px-3 py-2 text-rose-300 hover:bg-rose-500/10 rounded-lg transition-colors duration-200 disabled:opacity-50 flex-shrink-0"
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
                className="mt-2 text-brand-primary-soft hover:text-brand-primary-soft text-sm font-medium disabled:opacity-50"
              >
                + Add another {(isAdultPlayer || isAdultTeam) ? 'email' : 'parent email'}
              </button>
            )}

            {Object.keys(errors).some(key => key.startsWith('parentEmail')) && (
              <p className="text-rose-300 text-sm mt-1">Please check parent email addresses</p>
            )}
          </div>

          {/* Medical Information */}
          <div>
            <label className="block text-sm font-medium text-ink-primary/80 mb-1">
              Medical Information (Optional)
            </label>
            <textarea
              value={formData.medicalInfo}
              onChange={(e) => setFormData({ ...formData, medicalInfo: e.target.value })}
              className="w-full px-3 py-2 bg-surface-base text-ink-primary placeholder-bone/40 border border-line-default/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-primary-soft/40 resize-none"
              rows={3}
              placeholder="Any allergies, medical conditions, or special instructions..."
              disabled={isSubmitting}
            />
          </div>

          {/* Submit Error */}
          {errors.submit && (
            <div className="bg-rose-500/10 ring-1 ring-rose-400/30 rounded-lg p-3">
              <p className="text-rose-200 text-sm">{errors.submit}</p>
            </div>
          )}

          {/* Upload Progress */}
          {uploadLoading && (
            <div className="bg-brand-primary/10 ring-1 ring-brand-primary-soft/30 rounded-lg p-3">
              <div className="flex items-center space-x-2">
                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-brand-primary-soft"></div>
                <p className="text-brand-primary-soft text-sm">Uploading profile photo...</p>
              </div>
            </div>
          )}

          {/* Action Buttons */}
          <div className="flex space-x-4 pt-4">
            <button
              type="button"
              onClick={onClose}
              disabled={isSubmitting || uploadLoading}
              className="flex-1 bg-line-default/5 hover:bg-line-default/10 text-ink-primary/80 ring-1 ring-line-default/10 font-medium py-2 px-4 rounded-lg transition duration-200 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting || uploadLoading}
              className="flex-1 bg-brand-primary hover:bg-brand-primary text-white font-medium py-2 px-4 rounded-lg transition duration-200 disabled:opacity-50 flex items-center justify-center"
            >
              {(isSubmitting || uploadLoading) ? (
                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
              ) : (
                editingPlayer ? 'Save Player Card' : 'Add to Squad'
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default AddPlayer;