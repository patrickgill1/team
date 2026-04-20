import { useState, useCallback } from 'react';
import {
  ref,
  uploadBytes,
  getDownloadURL,
  deleteObject,
  uploadBytesResumable,
  UploadTaskSnapshot
} from 'firebase/storage';
import { storage } from '../utils/firebase';
import { v4 as uuidv4 } from 'uuid';

interface UploadProgress {
  progress: number;
  bytesTransferred: number;
  totalBytes: number;
}

export const useStorage = () => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState<UploadProgress | null>(null);

  const handleError = (err: any) => {
    console.error('Storage error:', err);
    let errorMessage = 'An error occurred during file operation';
    
    // Handle specific Firebase Storage errors
    if (err.code) {
      switch (err.code) {
        case 'storage/unauthorized':
          errorMessage = 'You do not have permission to upload files';
          break;
        case 'storage/canceled':
          errorMessage = 'Upload was canceled';
          break;
        case 'storage/unknown':
          errorMessage = 'Unknown error occurred during upload';
          break;
        case 'storage/object-not-found':
          errorMessage = 'File not found';
          break;
        case 'storage/bucket-not-found':
          errorMessage = 'Storage bucket not found';
          break;
        case 'storage/quota-exceeded':
          errorMessage = 'Storage quota exceeded';
          break;
        case 'storage/unauthenticated':
          errorMessage = 'User is not authenticated';
          break;
        case 'storage/retry-limit-exceeded':
          errorMessage = 'Upload retry limit exceeded';
          break;
        default:
          errorMessage = err.message || errorMessage;
      }
    } else {
      errorMessage = err.message || errorMessage;
    }
    
    setError(errorMessage);
    setLoading(false);
    return errorMessage;
  };

  // Upload file with progress tracking
  const uploadFile = useCallback(async (
    file: File,
    path: string,
    onProgress?: (progress: UploadProgress) => void
  ): Promise<string> => {
    setLoading(true);
    setError(null);
    setUploadProgress(null);

    try {
      // Validate file
      if (!file) {
        throw new Error('No file provided');
      }

      // Generate unique filename
      const fileExtension = file.name.split('.').pop() || 'jpg';
      const fileName = `${uuidv4()}.${fileExtension}`;
      
      // Ensure path format is correct (no leading slash, trailing slash)
      const cleanPath = path.replace(/^\//, '').replace(/\/$/, '');
      const fullPath = `${cleanPath}/${fileName}`;
      
      console.log('Uploading file to path:', fullPath);
      
      const storageRef = ref(storage, fullPath);
      const uploadTask = uploadBytesResumable(storageRef, file, {
        contentType: file.type,
      });

      return new Promise((resolve, reject) => {
        uploadTask.on(
          'state_changed',
          (snapshot: UploadTaskSnapshot) => {
            const progress = {
              progress: (snapshot.bytesTransferred / snapshot.totalBytes) * 100,
              bytesTransferred: snapshot.bytesTransferred,
              totalBytes: snapshot.totalBytes
            };
            setUploadProgress(progress);
            if (onProgress) {
              onProgress(progress);
            }
            console.log(`Upload is ${progress.progress}% done`);
          },
          (error) => {
            const errorMessage = handleError(error);
            reject(new Error(errorMessage));
          },
          async () => {
            try {
              const downloadURL = await getDownloadURL(uploadTask.snapshot.ref);
              console.log('File uploaded successfully. Download URL:', downloadURL);
              setLoading(false);
              setUploadProgress(null);
              setError(null);
              resolve(downloadURL);
            } catch (error) {
              const errorMessage = handleError(error);
              reject(new Error(errorMessage));
            }
          }
        );
      });
    } catch (err) {
      const errorMessage = handleError(err);
      throw new Error(errorMessage);
    }
  }, []);

  // Simple upload without progress tracking
  const uploadFileSimple = useCallback(async (file: File, path: string): Promise<string> => {
    setLoading(true);
    setError(null);

    try {
      if (!file) {
        throw new Error('No file provided');
      }

      const fileExtension = file.name.split('.').pop() || 'jpg';
      const fileName = `${uuidv4()}.${fileExtension}`;
      const cleanPath = path.replace(/^\//, '').replace(/\/$/, '');
      const fullPath = `${cleanPath}/${fileName}`;
      
      console.log('Uploading file to path:', fullPath);
      
      const storageRef = ref(storage, fullPath);
      const snapshot = await uploadBytes(storageRef, file, {
        contentType: file.type,
      });
      const downloadURL = await getDownloadURL(snapshot.ref);
      
      console.log('File uploaded successfully. Download URL:', downloadURL);
      setLoading(false);
      setError(null);
      return downloadURL;
    } catch (err) {
      const errorMessage = handleError(err);
      throw new Error(errorMessage);
    }
  }, []);

  // Delete file
  const deleteFile = useCallback(async (url: string): Promise<void> => {
    setLoading(true);
    setError(null);

    try {
      // Extract path from download URL if needed
      let filePath: string;
      
      if (url.includes('firebasestorage.googleapis.com')) {
        // It's a download URL, extract the path
        const urlParts = url.split('/o/');
        if (urlParts.length > 1) {
          const pathWithParams = urlParts[1];
          filePath = decodeURIComponent(pathWithParams.split('?')[0]);
        } else {
          throw new Error('Invalid Firebase Storage URL format');
        }
      } else {
        // It's already a path
        filePath = url;
      }

      console.log('Deleting file at path:', filePath);
      const fileRef = ref(storage, filePath);
      await deleteObject(fileRef);
      console.log('File deleted successfully');
      setLoading(false);
      setError(null);
    } catch (err) {
      const errorMessage = handleError(err);
      throw new Error(errorMessage);
    }
  }, []);

  // Upload multiple files
  const uploadMultipleFiles = useCallback(async (
    files: File[],
    path: string,
    onProgress?: (fileIndex: number, progress: UploadProgress) => void
  ): Promise<string[]> => {
    setLoading(true);
    setError(null);

    try {
      const uploadPromises = files.map((file, index) =>
        uploadFile(file, path, onProgress ? (progress) => onProgress(index, progress) : undefined)
      );

      const downloadURLs = await Promise.all(uploadPromises);
      setLoading(false);
      setError(null);
      return downloadURLs;
    } catch (err) {
      const errorMessage = handleError(err);
      throw new Error(errorMessage);
    }
  }, [uploadFile]);

  // Upload image with validation
  const uploadImage = useCallback(async (
    file: File,
    path: string,
    maxSizeMB: number = 5,
    onProgress?: (progress: UploadProgress) => void
  ): Promise<string> => {
    setError(null);

    // Validate file type
    const validTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
    if (!validTypes.includes(file.type)) {
      const error = 'Invalid file type. Please upload a JPEG, PNG, GIF, or WebP image.';
      setError(error);
      throw new Error(error);
    }

    // Validate file size
    const maxSizeBytes = maxSizeMB * 1024 * 1024;
    if (file.size > maxSizeBytes) {
      const error = `File size too large. Please upload an image smaller than ${maxSizeMB}MB.`;
      setError(error);
      throw new Error(error);
    }

    return uploadFile(file, path, onProgress);
  }, [uploadFile]);

  // Get file metadata
  const getFileInfo = useCallback(async (url: string) => {
    try {
      // Extract path from URL
      let filePath: string;
      
      if (url.includes('firebasestorage.googleapis.com')) {
        const urlParts = url.split('/o/');
        if (urlParts.length > 1) {
          const pathWithParams = urlParts[1];
          filePath = decodeURIComponent(pathWithParams.split('?')[0]);
        } else {
          throw new Error('Invalid Firebase Storage URL format');
        }
      } else {
        filePath = url;
      }
      
      const fileRef = ref(storage, filePath);
      return { url, ref: fileRef, path: filePath };
    } catch (err) {
      const errorMessage = handleError(err);
      throw new Error(errorMessage);
    }
  }, []);

  // Helper function to extract path from download URL
  const getPathFromUrl = useCallback((url: string): string => {
    try {
      if (url.includes('firebasestorage.googleapis.com')) {
        const urlParts = url.split('/o/');
        if (urlParts.length > 1) {
          const pathWithParams = urlParts[1];
          return decodeURIComponent(pathWithParams.split('?')[0]);
        }
      }
      return url; // Already a path
    } catch (err) {
      console.error('Error extracting path from URL:', err);
      return '';
    }
  }, []);

  // Clear error state
  const clearError = useCallback(() => {
    setError(null);
  }, []);

  return {
    loading,
    error,
    uploadProgress,
    uploadFile,
    uploadFileSimple,
    uploadMultipleFiles,
    uploadImage,
    deleteFile,
    getFileInfo,
    getPathFromUrl,
    clearError
  };
};

// Specific hook for gallery photo uploads
export const usePhotoUpload = () => {
  const { uploadImage, loading, error, uploadProgress } = useStorage();

  const uploadGalleryPhoto = useCallback(async (
    file: File,
    teamId: string,
    onProgress?: (progress: UploadProgress) => void
  ): Promise<string> => {
    const path = `gallery/${teamId}`;
    return uploadImage(file, path, 5, onProgress);
  }, [uploadImage]);

  const uploadPlayerPhoto = useCallback(async (
    file: File,
    teamId: string,
    onProgress?: (progress: UploadProgress) => void
  ): Promise<string> => {
    const path = `players/${teamId}`;
    return uploadImage(file, path, 5, onProgress);
  }, [uploadImage]);

  return {
    uploadGalleryPhoto,
    uploadPlayerPhoto,
    loading,
    error,
    uploadProgress
  };
};