import { ref, uploadBytes, getDownloadURL } from 'firebase/storage';
import { storage } from './firebase';

/**
 * Upload a photo file to Firebase Storage
 * @param file - The file to upload
 * @param teamId - The team ID for organizing uploads
 * @returns Promise<string> - The download URL of the uploaded file
 */
export const uploadPhoto = async (file: File, teamId: string): Promise<string> => {
  try {
    // Create a unique filename
    const timestamp = Date.now();
    const randomString = Math.random().toString(36).substring(2, 15);
    const fileExtension = file.name.split('.').pop();
    const fileName = `${timestamp}_${randomString}.${fileExtension}`;
    
    // Create storage reference
    const storageRef = ref(storage, `teams/${teamId}/photos/${fileName}`);
    
    // Upload file
    const snapshot = await uploadBytes(storageRef, file);
    
    // Get download URL
    const downloadURL = await getDownloadURL(snapshot.ref);
    
    return downloadURL;
  } catch (error) {
    console.error('Error uploading photo:', error);
    throw new Error('Failed to upload photo');
  }
};

/**
 * Upload multiple photos to Firebase Storage
 * @param files - Array of files to upload
 * @param teamId - The team ID for organizing uploads
 * @param onProgress - Optional callback for upload progress
 * @returns Promise<string[]> - Array of download URLs
 */
export const uploadMultiplePhotos = async (
  files: File[], 
  teamId: string,
  onProgress?: (progress: number) => void
): Promise<string[]> => {
  try {
    const uploadPromises = files.map(async (file, index) => {
      const url = await uploadPhoto(file, teamId);
      
      // Call progress callback if provided
      if (onProgress) {
        const progress = ((index + 1) / files.length) * 100;
        onProgress(progress);
      }
      
      return url;
    });
    
    return await Promise.all(uploadPromises);
  } catch (error) {
    console.error('Error uploading multiple photos:', error);
    throw new Error('Failed to upload photos');
  }
};

/**
 * Upload a file to Firebase Storage (generic function)
 * @param file - The file to upload
 * @param path - The storage path (e.g., 'teams/teamId/documents/')
 * @returns Promise<string> - The download URL of the uploaded file
 */
export const uploadFile = async (file: File, path: string): Promise<string> => {
  try {
    // Create a unique filename
    const timestamp = Date.now();
    const randomString = Math.random().toString(36).substring(2, 15);
    const fileExtension = file.name.split('.').pop();
    const fileName = `${timestamp}_${randomString}.${fileExtension}`;
    
    // Create storage reference
    const storageRef = ref(storage, `${path}${fileName}`);
    
    // Upload file
    const snapshot = await uploadBytes(storageRef, file);
    
    // Get download URL
    const downloadURL = await getDownloadURL(snapshot.ref);
    
    return downloadURL;
  } catch (error) {
    console.error('Error uploading file:', error);
    throw new Error('Failed to upload file');
  }
};

/**
 * Upload a profile photo
 * @param file - The image file to upload
 * @param userId - The user ID
 * @param userType - The type of user ('player', 'coach', 'parent')
 * @returns Promise<string> - The download URL of the uploaded photo
 */
export const uploadProfilePhoto = async (
  file: File, 
  userId: string, 
  userType: 'player' | 'coach' | 'parent'
): Promise<string> => {
  try {
    // Validate file type
    if (!file.type.startsWith('image/')) {
      throw new Error('Only image files are allowed for profile photos');
    }
    
    // Validate file size (max 5MB)
    const maxSize = 5 * 1024 * 1024; // 5MB
    if (file.size > maxSize) {
      throw new Error('Profile photo must be less than 5MB');
    }
    
    const fileExtension = file.name.split('.').pop();
    const fileName = `profile.${fileExtension}`;
    
    // Create storage reference
    const storageRef = ref(storage, `profiles/${userType}s/${userId}/${fileName}`);
    
    // Upload file
    const snapshot = await uploadBytes(storageRef, file);
    
    // Get download URL
    const downloadURL = await getDownloadURL(snapshot.ref);
    
    return downloadURL;
  } catch (error) {
    console.error('Error uploading profile photo:', error);
    throw error;
  }
};

/**
 * Upload a team logo
 * @param file - The image file to upload
 * @param teamId - The team ID
 * @returns Promise<string> - The download URL of the uploaded logo
 */
export const uploadTeamLogo = async (file: File, teamId: string): Promise<string> => {
  try {
    // Validate file type
    if (!file.type.startsWith('image/')) {
      throw new Error('Only image files are allowed for team logos');
    }
    
    // Validate file size (max 2MB)
    const maxSize = 2 * 1024 * 1024; // 2MB
    if (file.size > maxSize) {
      throw new Error('Team logo must be less than 2MB');
    }
    
    const fileExtension = file.name.split('.').pop();
    const fileName = `logo.${fileExtension}`;
    
    // Create storage reference
    const storageRef = ref(storage, `teams/${teamId}/logo/${fileName}`);
    
    // Upload file
    const snapshot = await uploadBytes(storageRef, file);
    
    // Get download URL
    const downloadURL = await getDownloadURL(snapshot.ref);
    
    return downloadURL;
  } catch (error) {
    console.error('Error uploading team logo:', error);
    throw error;
  }
};

/**
 * Helper function to validate image files
 * @param file - The file to validate
 * @param maxSizeMB - Maximum file size in MB (default: 10)
 * @returns boolean - Whether the file is valid
 */
export const validateImageFile = (file: File, maxSizeMB: number = 10): { isValid: boolean; error?: string } => {
  // Check file type
  if (!file.type.startsWith('image/')) {
    return { isValid: false, error: 'Only image files are allowed' };
  }
  
  // Check file size
  const maxSize = maxSizeMB * 1024 * 1024;
  if (file.size > maxSize) {
    return { isValid: false, error: `File size must be less than ${maxSizeMB}MB` };
  }
  
  // Check for supported formats
  const supportedFormats = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
  if (!supportedFormats.includes(file.type)) {
    return { isValid: false, error: 'Supported formats: JPEG, PNG, GIF, WebP' };
  }
  
  return { isValid: true };
};

/**
 * Helper function to resize image before upload (optional)
 * @param file - The image file to resize
 * @param maxWidth - Maximum width in pixels
 * @param maxHeight - Maximum height in pixels
 * @param quality - Image quality (0-1)
 * @returns Promise<File> - The resized file
 */
export const resizeImage = async (
  file: File, 
  maxWidth: number = 1920, 
  maxHeight: number = 1080, 
  quality: number = 0.8
): Promise<File> => {
  return new Promise((resolve, reject) => {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const img = new Image();
    
    img.onload = () => {
      // Calculate new dimensions
      let { width, height } = img;
      
      if (width > height) {
        if (width > maxWidth) {
          height = (height * maxWidth) / width;
          width = maxWidth;
        }
      } else {
        if (height > maxHeight) {
          width = (width * maxHeight) / height;
          height = maxHeight;
        }
      }
      
      // Set canvas dimensions
      canvas.width = width;
      canvas.height = height;
      
      // Draw and compress image
      ctx?.drawImage(img, 0, 0, width, height);
      
      canvas.toBlob(
        (blob) => {
          if (blob) {
            const resizedFile = new File([blob], file.name, {
              type: file.type,
              lastModified: Date.now()
            });
            resolve(resizedFile);
          } else {
            reject(new Error('Failed to resize image'));
          }
        },
        file.type,
        quality
      );
    };
    
    img.onerror = () => reject(new Error('Failed to load image'));
    img.src = URL.createObjectURL(file);
  });
};