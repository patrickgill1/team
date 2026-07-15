import React, { useState, useCallback } from 'react';
import { GalleryPhoto } from '../../types';
import { useAuth } from '../../contexts/AuthContext';
import { useTeam } from '../../contexts/TeamContext';
import { useFirestore } from '../../hooks/useFirestore';
import { useStorage } from '../../hooks/useStorage';
import { debug } from '../../utils/debug';

interface PhotoUploadProps {
  onPhotosUploaded: (photos: GalleryPhoto[]) => void;
  onClose: () => void;
  isOpen: boolean;
}

const PhotoUpload: React.FC<PhotoUploadProps> = ({
  onPhotosUploaded,
  onClose,
  isOpen
}) => {
  const { userData } = useAuth();
  const { selectedTeamId } = useTeam();
  const { addPhoto } = useFirestore();
  const { uploadFile, loading: uploadLoading, error: uploadError, uploadProgress } = useStorage();
  
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [previews, setPreviews] = useState<string[]>([]);
  const [captions, setCaptions] = useState<{ [key: string]: string }>({});
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const availableTags = [
    'game', 'practice', 'team', 'celebration', 'training', 'tournament', 'awards'
  ];

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    const imageFiles = files.filter(file => file.type.startsWith('image/'));
    
    if (imageFiles.length !== files.length) {
      setError('Only image files are allowed');
      return;
    }

    if (imageFiles.length > 10) {
      setError('Maximum 10 files can be uploaded at once');
      return;
    }

    setSelectedFiles(imageFiles);
    setError(null);

    // Create previews
    const newPreviews: string[] = [];
    imageFiles.forEach(file => {
      const reader = new FileReader();
      reader.onload = (e) => {
        newPreviews.push(e.target?.result as string);
        if (newPreviews.length === imageFiles.length) {
          setPreviews(newPreviews);
        }
      };
      reader.readAsDataURL(file);
    });

    // Initialize captions
    const newCaptions: { [key: string]: string } = {};
    imageFiles.forEach(file => {
      newCaptions[file.name] = '';
    });
    setCaptions(newCaptions);
  }, []);

  const handleCaptionChange = (fileName: string, caption: string) => {
    setCaptions(prev => ({
      ...prev,
      [fileName]: caption
    }));
  };

  const handleTagToggle = (tag: string) => {
    setSelectedTags(prev => 
      prev.includes(tag) 
        ? prev.filter(t => t !== tag)
        : [...prev, tag]
    );
  };

  const handleUpload = async () => {
    if (!selectedFiles.length || !userData) return;

    setIsUploading(true);
    setError(null);
    
    try {
      const uploadedPhotos: GalleryPhoto[] = [];
      
      for (let i = 0; i < selectedFiles.length; i++) {
        const file = selectedFiles[i];
        
        // Upload to storage using your useStorage hook
        const photoUrl = await uploadFile(
          file,
          `teams/${selectedTeamId}/photos/`,
          (progress) => {
            // Optional: Update progress for individual files
            debug(`File ${i + 1} progress:`, progress.progress);
          }
        );
        
        // Create gallery photo record
        const photoData: Omit<GalleryPhoto, 'id' | 'createdAt'> = {
          url: photoUrl,
          caption: captions[file.name] || '',
          uploadedBy: userData.uid,
          uploadedByName: userData.name,
          teamId: selectedTeamId,
          tags: selectedTags,
          fileSize: file.size,
          fileName: file.name,
          contentType: file.type,
          updatedAt: new Date()
        };
        
        const photoId = await addPhoto(photoData);
        
        uploadedPhotos.push({
          id: photoId,
          ...photoData,
          createdAt: new Date()
        });
      }
      
      onPhotosUploaded(uploadedPhotos);
      onClose();
      
    } catch (error) {
      console.error('Upload error:', error);
      setError(uploadError || 'Failed to upload photos. Please try again.');
    } finally {
      setIsUploading(false);
    }
  };

  const removeFile = (index: number) => {
    const newFiles = selectedFiles.filter((_, i) => i !== index);
    const newPreviews = previews.filter((_, i) => i !== index);
    
    setSelectedFiles(newFiles);
    setPreviews(newPreviews);
    
    // Remove caption for removed file
    const removedFile = selectedFiles[index];
    if (removedFile) {
      const newCaptions = { ...captions };
      delete newCaptions[removedFile.name];
      setCaptions(newCaptions);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg max-w-4xl w-full max-h-screen overflow-y-auto">
        {/* Header */}
        <div className="sticky top-0 bg-white border-b border-gray-200 px-6 py-4">
          <div className="flex items-center justify-between">
            <h2 className="text-xl font-semibold text-gray-900">Upload Photos</h2>
            <button
              onClick={onClose}
              disabled={isUploading || uploadLoading}
              className="text-gray-400 hover:text-gray-600 transition-colors duration-200 disabled:opacity-50"
            >
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        <div className="p-6">
          {/* File Upload */}
          {!selectedFiles.length && (
            <div className="border-2 border-dashed border-gray-300 rounded-lg p-8 text-center">
              <input
                type="file"
                multiple
                accept="image/*"
                onChange={handleFileSelect}
                className="hidden"
                id="photo-upload"
                disabled={isUploading || uploadLoading}
              />
              <label
                htmlFor="photo-upload"
                className="cursor-pointer flex flex-col items-center"
              >
                <svg className="w-12 h-12 text-gray-400 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                </svg>
                <span className="text-lg font-medium text-gray-900 mb-2">Select Photos</span>
                <span className="text-sm text-gray-500">Choose up to 10 images (JPG, PNG, GIF)</span>
              </label>
            </div>
          )}

          {/* Selected Files Preview */}
          {selectedFiles.length > 0 && (
            <div className="space-y-6">
              {/* File Grid */}
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
                {previews.map((preview, index) => {
                  const file = selectedFiles[index];
                  return (
                    <div key={index} className="relative bg-gray-100 rounded-lg overflow-hidden">
                      <div className="aspect-square">
                        <img 
                          src={preview} 
                          alt={file?.name || `Preview ${index}`}
                          className="w-full h-full object-cover"
                        />
                      </div>
                      <button
                        onClick={() => removeFile(index)}
                        disabled={isUploading || uploadLoading}
                        className="absolute top-2 right-2 bg-red-500 text-white rounded-full w-6 h-6 flex items-center justify-center hover:bg-red-600 transition-colors duration-200 disabled:opacity-50"
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </button>
                    </div>
                  );
                })}
              </div>

              {/* Captions */}
              <div className="space-y-4">
                <h3 className="text-lg font-medium text-gray-900">Add Captions</h3>
                {selectedFiles.map((file, index) => (
                  <div key={file.name}>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      {file.name}
                    </label>
                    <input
                      type="text"
                      value={captions[file.name] || ''}
                      onChange={(e) => handleCaptionChange(file.name, e.target.value)}
                      placeholder="Add a caption for this photo..."
                      disabled={isUploading || uploadLoading}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-primary disabled:opacity-50"
                    />
                  </div>
                ))}
              </div>

              {/* Tags */}
              <div className="space-y-3">
                <h3 className="text-lg font-medium text-gray-900">Add Tags</h3>
                <div className="flex flex-wrap gap-2">
                  {availableTags.map(tag => (
                    <button
                      key={tag}
                      onClick={() => handleTagToggle(tag)}
                      disabled={isUploading || uploadLoading}
                      className={`px-3 py-1 rounded-full text-sm font-medium transition-colors duration-200 disabled:opacity-50 ${
                        selectedTags.includes(tag)
                          ? 'bg-brand-primary-soft text-charcoal-800 border border-brand-primary-soft'
                          : 'bg-gray-100 text-gray-700 border border-gray-300 hover:bg-gray-200'
                      }`}
                    >
                      {tag}
                    </button>
                  ))}
                </div>
              </div>

              {/* Add More Files Button */}
              {selectedFiles.length < 10 && (
                <div>
                  <input
                    type="file"
                    multiple
                    accept="image/*"
                    onChange={(e) => {
                      const newFiles = Array.from(e.target.files || []);
                      const imageFiles = newFiles.filter(file => file.type.startsWith('image/'));
                      const totalFiles = selectedFiles.length + imageFiles.length;
                      
                      if (totalFiles > 10) {
                        setError(`Can only upload ${10 - selectedFiles.length} more files`);
                        return;
                      }
                      
                      setSelectedFiles([...selectedFiles, ...imageFiles]);
                      
                      // Add previews for new files
                      imageFiles.forEach(file => {
                        const reader = new FileReader();
                        reader.onload = (e) => {
                          setPreviews(prev => [...prev, e.target?.result as string]);
                        };
                        reader.readAsDataURL(file);
                      });
                      
                      // Initialize captions for new files
                      const newCaptions = { ...captions };
                      imageFiles.forEach(file => {
                        newCaptions[file.name] = '';
                      });
                      setCaptions(newCaptions);
                    }}
                    className="hidden"
                    id="add-more-photos"
                    disabled={isUploading || uploadLoading}
                  />
                  <label
                    htmlFor="add-more-photos"
                    className="inline-flex items-center px-4 py-2 border border-gray-300 rounded-lg text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 transition-colors duration-200 cursor-pointer"
                  >
                    <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                    </svg>
                    Add More Photos
                  </label>
                </div>
              )}
            </div>
          )}

          {/* Error Message */}
          {(error || uploadError) && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-3 mt-4">
              <p className="text-red-600 text-sm">{error || uploadError}</p>
            </div>
          )}

          {/* Upload Progress */}
          {(isUploading || uploadLoading) && uploadProgress && (
            <div className="mt-6">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium text-gray-700">Uploading...</span>
                <span className="text-sm text-gray-500">{Math.round(uploadProgress.progress)}%</span>
              </div>
              <div className="w-full bg-gray-200 rounded-full h-2">
                <div 
                  className="bg-surface-tint h-2 rounded-full transition-all duration-300"
                  style={{ width: `${uploadProgress.progress}%` }}
                ></div>
              </div>
            </div>
          )}

          {/* Action Buttons */}
          {selectedFiles.length > 0 && (
            <div className="flex space-x-4 pt-6 border-t border-gray-200 mt-6">
              <button
                type="button"
                onClick={onClose}
                disabled={isUploading || uploadLoading}
                className="flex-1 bg-gray-300 hover:bg-gray-400 text-gray-800 font-medium py-2 px-4 rounded-lg transition duration-200 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={handleUpload}
                disabled={isUploading || uploadLoading || selectedFiles.length === 0}
                className="flex-1 bg-surface-tint hover:bg-surface-raised text-white font-medium py-2 px-4 rounded-lg transition duration-200 disabled:opacity-50 flex items-center justify-center"
              >
                {(isUploading || uploadLoading) ? (
                  <>
                    <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2"></div>
                    Uploading...
                  </>
                ) : (
                  `Upload ${selectedFiles.length} Photo${selectedFiles.length !== 1 ? 's' : ''}`
                )}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default PhotoUpload;